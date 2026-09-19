// Komennon suorituksen idempotenssi.
//
// Sama vahvistettu ehdotus suoritetaan enintään kerran, vaikka
// suoritusta kutsuttaisiin kahdesti (tuplaklikkaus, verkkouudelleenyritys,
// käyttöliittymän kilpa-ajo, resume-tapahtuma). Uusi ehdotus samasta
// lauseesta on eri ehdotus ja suoritetaan normaalisti.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { setUser, clearUser } from '../src/data/session.js';
import { clearLocalUserData, createBill } from '../src/app/actions.js';
import { resetState, getState, setTasks } from '../src/app/state.js';
import { setClient } from '../src/data/client.js';
import { fakeClient } from './helpers/gates.mjs';
import { normalizeTask } from '../src/domain/task.js';

import {
  buildProposal, executeProposal, runAiCommand, resetExecutionLedger, PROPOSAL_STATUS
} from '../src/app/aiCommands.js';
import { handlers as realHandlers } from '../src/app/aiCommandHandlers.js';

const USER = { id: 'aaaaaaaa-4444-0000-0000-000000000004', email: 'i@example.com' };

beforeEach(() => {
  clearUser();
  clearLocalUserData();
  resetState();
  resetExecutionLedger();
  setUser(USER);
  setClient(fakeClient({ data: [], error: null }));
});

/** Kartta, jossa jokainen intentti vain laskee kutsunsa. */
function countingHandlers() {
  const calls = {};
  const map = {};
  for (const intent of Object.keys(realHandlers)) {
    map[intent] = async () => { calls[intent] = (calls[intent] || 0) + 1; return { ok: true }; };
  }
  return { calls, map };
}

test('KRIITTINEN: sama ehdotus kahdesti peräkkäin suorittaa vain kerran', async () => {
  const proposal = buildProposal({ intent: 'create_task', title: 'Kerran', date: '2026-09-20' });
  assert.equal(proposal.status, PROPOSAL_STATUS.READY);

  const first = await executeProposal(proposal, realHandlers);
  const second = await executeProposal(proposal, realHandlers);

  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(second.duplicate, true);
  assert.equal(getState().tasks.length, 1, 'tehtävä luotiin tasan kerran');
});

test('KRIITTINEN: sama ehdotus KAHDESTI SAMAAN AIKAAN suorittaa vain kerran', async () => {
  const proposal = buildProposal({ intent: 'create_task', title: 'Kilpa-ajo', date: '2026-09-20' });

  const [a, b] = await Promise.all([
    executeProposal(proposal, realHandlers),
    executeProposal(proposal, realHandlers)
  ]);

  assert.equal([a, b].filter(r => r.ok).length, 1, 'täsmälleen yksi onnistuu');
  assert.equal([a, b].filter(r => r.duplicate).length, 1);
  assert.equal(getState().tasks.length, 1);
});

test('kolme rinnakkaista kutsua: yksi suoritus', async () => {
  const proposal = buildProposal({ intent: 'create_task', title: 'Kolme', date: '2026-09-20' });
  const results = await Promise.all([1, 2, 3].map(() => executeProposal(proposal, realHandlers)));
  assert.equal(results.filter(r => r.ok).length, 1);
  assert.equal(getState().tasks.length, 1);
});

test('uusi ehdotus samasta sisällöstä on eri ehdotus ja suoritetaan normaalisti', async () => {
  const raw = { intent: 'create_task', title: 'Toistuva', date: '2026-09-20' };
  const one = buildProposal(raw);
  const two = buildProposal(raw);
  assert.notEqual(one.audit.id, two.audit.id);

  assert.equal((await executeProposal(one, realHandlers)).ok, true);
  assert.equal((await executeProposal(two, realHandlers)).ok, true);
  assert.equal(getState().tasks.length, 2, 'käyttäjän tietoinen toisto ei ole tuplasuoritus');
});

// Jokainen suojattava komentotyyppi: poisto, luonti, siirto, valmistuminen, maksu.
const PROTECTED = [
  { intent: 'delete_task', raw: { intent: 'delete_task', targetName: 'Kohde' } },
  { intent: 'create_task', raw: { intent: 'create_task', title: 'Uusi', date: '2026-09-20' } },
  { intent: 'reschedule_task', raw: { intent: 'reschedule_task', targetName: 'Kohde', date: '2026-09-25' } },
  { intent: 'complete_task', raw: { intent: 'complete_task', targetName: 'Kohde' } },
  { intent: 'mark_bill_paid', raw: { intent: 'mark_bill_paid', targetName: 'Sähkö' } }
];

for (const { intent, raw } of PROTECTED) {
  test(`KRIITTINEN: ${intent} ei suoritu kahdesti samalla ehdotuksella`, async () => {
    setTasks([normalizeTask({ id: 't1', title: 'Kohde', date: '2026-09-20', time: '10:00' })]);
    await createBill({ name: 'Sähkö', amountMinor: 1000, dueDate: '2026-09-30', currency: 'EUR' });

    const proposal = buildProposal(raw);
    assert.equal(proposal.status, PROPOSAL_STATUS.READY, intent);

    const { calls, map } = countingHandlers();
    const first = await executeProposal(proposal, map);
    const second = await executeProposal(proposal, map);
    const third = await executeProposal(proposal, map);

    assert.equal(first.ok, true);
    assert.equal(second.duplicate, true);
    assert.equal(third.duplicate, true);
    assert.equal(calls[intent], 1, `${intent}-käsittelijää kutsuttiin ${calls[intent]} kertaa`);
  });
}

test('selvästi epäonnistunut suoritus vapauttaa tunnisteen -- käyttäjä saa yrittää uudelleen', async () => {
  const proposal = buildProposal({ intent: 'create_task', title: 'Uusinta', date: '2026-09-20' });
  let attempts = 0;
  const flaky = { create_task: async () => { attempts += 1; return attempts === 1 ? { ok: false, reason: 'verkko' } : { ok: true }; } };

  assert.equal((await executeProposal(proposal, flaky)).ok, false);
  assert.equal((await executeProposal(proposal, flaky)).ok, true, 'uudelleenyritys sallitaan epäonnistumisen jälkeen');
  assert.equal(attempts, 2);
  assert.equal((await executeProposal(proposal, flaky)).duplicate, true, 'onnistuneen jälkeen estetty');
});

test('poikkeus jättää tunnisteen kirjatuksi -- epäselvää tilaa ei uudelleenyritetä automaattisesti', async () => {
  const proposal = buildProposal({ intent: 'create_task', title: 'Poikkeus', date: '2026-09-20' });
  let attempts = 0;
  const throwing = { create_task: async () => { attempts += 1; throw new Error('kesken'); } };

  const first = await executeProposal(proposal, throwing);
  const second = await executeProposal(proposal, throwing);

  assert.equal(first.ok, false);
  assert.equal(second.duplicate, true);
  assert.equal(attempts, 1);
});

test('hylätty ja kytkemätön ehdotus eivät kuluta tunnistetta', async () => {
  const proposal = buildProposal({ intent: 'create_task', title: 'Kytkemätön', date: '2026-09-20' });
  const missing = await executeProposal(proposal, {});
  assert.equal(missing.ok, false);
  assert.notEqual(missing.duplicate, true);
  assert.equal((await executeProposal(proposal, realHandlers)).ok, true, 'oikeilla käsittelijöillä onnistuu');
});

test('vanhentunut kohde ei kuluta tunnistetta', async () => {
  setTasks([normalizeTask({ id: 't1', title: 'Katoava', date: '2026-09-20' })]);
  const proposal = buildProposal({ intent: 'complete_task', targetName: 'Katoava' });
  setTasks([]);
  const stale = await executeProposal(proposal, realHandlers);
  assert.equal(stale.ok, false);
  assert.notEqual(stale.duplicate, true);
});

test('suoritusmuisti on rajattu: tuhannen ehdotuksen jälkeen tuoreimmat ovat yhä suojattuja', async () => {
  const { map } = countingHandlers();
  let last = null;
  for (let i = 0; i < 1000; i += 1) {
    last = buildProposal({ intent: 'create_task', title: 'T' + i, date: '2026-09-20' });
    await executeProposal(last, map);
  }
  assert.equal((await executeProposal(last, map)).duplicate, true);
});

test('runAiCommand: sama komentoketju kahdesti tuottaa kaksi erillistä ehdotusta, ei tuplasuoritusta yhdelle', async () => {
  const raw = { intent: 'create_task', title: 'Ketju', date: '2026-09-20' };
  const run = () => runAiCommand(raw, { confirm: async () => true, handlers: realHandlers });
  const [a, b] = await Promise.all([run(), run()]);
  // Kaksi erillistä käyttäjän tekemää komentoa -> kaksi riviä (kumpikin oma ehdotuksensa).
  assert.equal(a.ok && b.ok, true);
  assert.equal(getState().tasks.length, 2);
});

test('resetExecutionLedger vapauttaa tunnisteet', async () => {
  const proposal = buildProposal({ intent: 'create_task', title: 'Nollaus', date: '2026-09-20' });
  await executeProposal(proposal, realHandlers);
  resetExecutionLedger();
  assert.equal((await executeProposal(proposal, realHandlers)).duplicate, undefined);
});
