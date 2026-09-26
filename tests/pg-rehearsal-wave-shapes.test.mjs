// Taukopisteiden rivimuodot (tools/pg-rehearsal/waves.mjs) ILMAN palvelinta.
//
// prodshape:pause kirjoittaa kantaan sovelluksen OMILLA rivimuunnoksilla,
// jotka ladataan kunkin aallon sarakeporteilla (app-gate-hooks.mjs). Nämä
// testit todentavat, että lataus todella vaihtaa portit: jos koukku
// lakkaisi toimimasta, jokainen aalto lähettäisi HEADin muodon ja
// harjoittelu todistaisi väärää asiaa.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { read } from './helpers/sources.mjs';
import { PAUSES, trainWaves, shapeKeys, waveWrites } from '../tools/pg-rehearsal/waves.mjs';
import { patchSchemaSource, KNOWN_GATES } from '../tools/pg-rehearsal/app-gate-hooks.mjs';

const train = trainWaves();

/** src/data/collectionsRepo.js: jokaisen `...(GATE ? { ... } : {})` -lohkon avaimet tauluittain. */
function gateBlocks() {
  const src = read('src/data/collectionsRepo.js').replace(/\r\n/g, '\n');
  const out = [];
  for (const repo of src.split(/\nexport const \w+ = createRepository\(\{/).slice(1)) {
    const table = /table: '(\w+)'/.exec(repo)?.[1];
    const toRow = repo.slice(repo.indexOf('toRow:'), repo.indexOf('fromRow:'));
    for (const m of toRow.matchAll(/\.\.\.\((\w+)\s*\?\s*\{([\s\S]*?)\}\s*:\s*\{\}\)/g)) {
      const keys = [...m[2].matchAll(/(\w+):/g)].map(k => k[1]);
      out.push({ table, gate: m[1], keys });
    }
  }
  return out;
}

test('KRIITTINEN: jokainen sarakeportti lähtee rivimuotoon täsmälleen portin ollessa auki', async () => {
  const blocks = gateBlocks().filter(b => KNOWN_GATES.includes(b.gate));
  assert.ok(blocks.length >= 6, `porttilohkoja löytyi vain ${blocks.length}`);
  for (const wave of ['E', 'F', 'G', 'H', 'I', 'J']) {
    const keys = await shapeKeys(wave, train);
    for (const b of blocks) {
      if (!keys[b.table]) continue; // taulu ei ole auki tässä aallossa
      const on = train[wave].gates.includes(b.gate);
      for (const k of b.keys) {
        assert.equal(keys[b.table].includes(k), on,
          `aalto ${wave}, ${b.table}.${k}: portti ${b.gate} ${on ? 'auki' : 'kiinni'}`);
      }
    }
  }
});

test('aaltojen rivimuodot: laskun maksutiedot F:stä, suunnittelukentät G:stä, alue I:stä, 0013-sarakkeet J:stä', async () => {
  const E = await shapeKeys('E', train);
  const F = await shapeKeys('F', train);
  const G = await shapeKeys('G', train);
  const I = await shapeKeys('I', train);
  const J = await shapeKeys('J', train);
  assert.equal(E.bills.includes('iban'), false);
  assert.ok(F.bills.includes('iban') && F.bills.includes('payee') && F.bills.includes('reference'));
  assert.equal(F.goals.includes('metric'), false);
  assert.equal(F.tasks.includes('depends_on'), false, 'tehtävä lähettäisi depends_on ennen 0010:tä');
  assert.ok(G.goals.includes('metric') && G.tasks.includes('depends_on') && G.tasks.includes('milestone_id'));
  assert.ok(G.projects.includes('milestone_id'));
  assert.equal(G.goals.includes('life_area_id'), false);
  assert.ok(I.goals.includes('life_area_id'));
  assert.equal(I.time_entries.includes('operation_id'), false);
  assert.ok(J.time_entries.includes('operation_id') && J.time_entries.includes('started_at'));
  assert.ok(J.running_timers && J.alignment_item_settings);
  assert.equal(E.milestones, undefined, 'välitavoitteet eivät ole auki aallossa E');
  // Ylläpitotila vain portin ollessa auki (G+).
  const g = await waveWrites('G', { prefix: 't', train });
  assert.ok(g.some(o => o.table === 'goals' && o.payload?.status === 'maintenance'));
  const f = await waveWrites('F', { prefix: 't', train });
  assert.equal(f.some(o => o.payload?.status === 'maintenance'), false);
  // Ennen 0013:a ajastinkirjaus lähtee manual-lähteellä (0012 sallii vain sen).
  const i = await waveWrites('I', { prefix: 't', train });
  assert.equal(i.find(o => o.table === 'time_entries' && o.method === 'insert').payload.source, 'manual');
});

test('rivimuodoissa ei ole palvelimen omistamia kenttiä eikä undefined-arvoja', async () => {
  for (const wave of ['E', 'G', 'J']) {
    for (const op of await waveWrites(wave, { prefix: 't', train })) {
      if (!op.payload) continue;
      for (const k of ['user_id', 'created_at', 'updated_at']) assert.equal(k in op.payload, false, `${op.label}: ${k}`);
      assert.equal(Object.values(op.payload).includes(undefined), false, op.label);
      if (op.method === 'update' || op.method === 'delete') assert.ok(op.match && Object.keys(op.match).length, op.label);
    }
  }
});

test('taukopisteet vastaavat junaa: tauon jälkeen deployataan juuri sen migraation aalto', () => {
  assert.deepEqual(PAUSES.map(p => p.after), ['0008', '0009', '0010', '0011', '0012', '0013']);
  for (const p of PAUSES) {
    assert.ok(train[p.live], `elävä aalto ${p.live}`);
    if (!p.next) continue;
    assert.ok(String(train[p.next].migration).startsWith(p.after), `${p.after}: aallon ${p.next} migraatio on ${train[p.next].migration}`);
  }
  for (let i = 1; i < PAUSES.length; i++) {
    if (PAUSES[i - 1].next) assert.equal(PAUSES[i].live, PAUSES[i - 1].next, `${PAUSES[i].after}: elävä aalto`);
  }
});

test('schema.js-korvaus: tuntematon tai puuttuva portti kaataa latauksen', () => {
  const src = read('src/data/schema.js');
  const patched = patchSchemaSource(src, ['GOAL_PLANNING_FIELDS']);
  assert.match(patched, /export const GOAL_PLANNING_FIELDS = true;/);
  assert.match(patched, /export const BILL_PAYMENT_FIELDS = false;/);
  assert.throws(() => patchSchemaSource(src.replace('export const GOAL_LIFE_AREA_FIELD', 'export const X'), []), /GOAL_LIFE_AREA_FIELD/);
});
