// GOAL_MAINTENANCE_MODE on oikea portti eikä pelkkä kommentti.
//
// VIKA: porttia ei lukenut kukaan. Lomake piilotti ylläpitotilan, mutta
// tekoälyn "muuta tavoitetta" -komento hyväksyi sen, ja goalsRepo lähetti
// arvon sellaisenaan. Ennen migraatiota 0010 goals_status_check hylkää sen
// (23514) -- vasta vahvistuksen jälkeen.
//
// NYT: domain kertoo mitä kanta hyväksyy (isStorableGoalStatus), tekoälyn
// skeema hylkää kentän portin ollessa kiinni, lomake tarjoaa tilan vain
// portin ollessa auki, ja repositorio torjuu arvon ennen verkkoa.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isStorableGoalStatus, GOAL_STATUSES, GOAL_STATUS } from '../src/domain/goal.js';
import { resolveCommand } from '../src/ai/intentSchema.js';
import { goalStatusOptions } from '../src/app/views/goals.js';
import { GOAL_MAINTENANCE_MODE } from '../src/data/schema.js';
import { read } from './helpers/sources.mjs';
import { createSchemaServer, memoryStorage, migrationsThrough } from './helpers/schemaServer.mjs';
import { importAtWave, WAVE_GRAPH_SUPPORTED } from './helpers/waveGraph.mjs';

const graphTest = WAVE_GRAPH_SUPPORTED ? test : test.skip;

test('isStorableGoalStatus: ylläpito vain luvalla, muut tunnetut tilat aina', () => {
  for (const status of GOAL_STATUSES) {
    const expected = status !== GOAL_STATUS.MAINTENANCE;
    assert.equal(isStorableGoalStatus(status), expected, status);
    assert.equal(isStorableGoalStatus(status, { maintenanceAllowed: true }), true, status);
  }
  assert.equal(isStorableGoalStatus('tuntematon', { maintenanceAllowed: true }), false);
});

test('tekoälyn "muuta tavoitetta": ylläpito hylätään, ellei sovellus kerro portin olevan auki', () => {
  const raw = { intent: 'update_goal', goalId: 'g1', status: 'maintenance', newTitle: 'Pidä paino' };
  const closed = resolveCommand(raw, { today: '2026-09-26' });
  assert.equal(closed.ok, true);
  assert.ok(closed.command.rejectedFields.includes('status'));
  assert.equal('status' in closed.command.payload.changes, false);

  const open = resolveCommand(raw, { today: '2026-09-26', goalMaintenance: true });
  assert.equal(open.command.payload.changes.status, 'maintenance');
  assert.deepEqual(open.command.rejectedFields, []);

  // Muut tilat eivät riipu portista.
  const paused = resolveCommand({ intent: 'update_goal', goalId: 'g1', status: 'paused' });
  assert.equal(paused.command.payload.changes.status, 'paused');
});

test('sovelluskerros välittää portin tekoälyn skeemalle (ajonaikainen accessor)', () => {
  const source = read('src/app/aiCommands.js');
  assert.match(source, /goalMaintenance: columnGateOpen\('GOAL_MAINTENANCE_MODE'\)/);
});

test('lomake: ylläpito tarjotaan vain portin ollessa auki; nykyinen tila säilyy aina', () => {
  assert.equal(goalStatusOptions().includes(GOAL_STATUS.MAINTENANCE), GOAL_MAINTENANCE_MODE);
  // Ylläpidossa oleva tavoite ei muutu hiljaa aktiiviseksi lomakkeen kautta.
  assert.ok(goalStatusOptions(GOAL_STATUS.MAINTENANCE).includes(GOAL_STATUS.MAINTENANCE));
  assert.ok(goalStatusOptions(GOAL_STATUS.ABANDONED).includes(GOAL_STATUS.ABANDONED));
  assert.deepEqual(goalStatusOptions('tuntematon'), goalStatusOptions());
});

graphTest('aalto G: portti auki -> tallentuu; kanta ilman 0010:tä -> torjutaan ennen verkkoa', async () => {
  const [runtime, probe, client, session, collections, goalsView] = await Promise.all([
    importAtWave('G', 'data/schemaRuntime.js'), importAtWave('G', 'data/schemaProbe.js'),
    importAtWave('G', 'data/client.js'), importAtWave('G', 'data/session.js'),
    importAtWave('G', 'data/collectionsRepo.js'), importAtWave('G', 'app/views/goals.js')
  ]);
  session.setUser({ id: 'u-g', email: 'g@example.com' });

  // Kanta 0010:n jälkeen: tila hyväksytään ja lomake tarjoaa sen.
  runtime.resetSchemaRuntimeForTests();
  probe.resetSchemaProbeForTests();
  const ready = createSchemaServer({ applied: migrationsThrough('0010'), currentUserId: () => 'u-g' });
  client.setClient(ready);
  await probe.ensureSchemaCompatibility({ client: ready, isOnline: () => true, storage: memoryStorage() });
  assert.ok(goalsView.goalStatusOptions().includes('maintenance'));
  assert.equal((await collections.goalsRepo.insert({ id: 'g1', title: 'Paino', status: 'maintenance' })).ok, true);

  // Kanta jäljessä (0008): portti laskee ajon aikana.
  runtime.resetSchemaRuntimeForTests();
  probe.resetSchemaProbeForTests();
  const behind = createSchemaServer({ applied: migrationsThrough('0008'), currentUserId: () => 'u-g' });
  client.setClient(behind);
  await probe.ensureSchemaCompatibility({ client: behind, isOnline: () => true, storage: memoryStorage() });
  assert.equal(goalsView.goalStatusOptions().includes('maintenance'), false);
  const before = behind.calls.length;
  const refused = await collections.goalsRepo.insert({ id: 'g2', title: 'Paino', status: 'maintenance' });
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, 'validation_error');
  assert.equal(behind.calls.length, before, 'arvoa ei lähetetty kantaan');
  assert.equal((await collections.goalsRepo.insert({ id: 'g3', title: 'Paino', status: 'active' })).ok, true);
});
