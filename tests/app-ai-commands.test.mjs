// AI-komentojen orkestroinnin testit.
//
// Skeema on testattu erikseen ja resolver erikseen. Tässä testataan se,
// mitä kumpikaan ei yksin näe: KETJU raakavastauksesta suoritukseen.
//
// Juuri ketjussa syntyvät ne viat, joita käyttäjä ei koskaan huomaa
// ajoissa — väärä kohde, ohitettu vahvistus, puuttuva kirjaus.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  PROPOSAL_STATUS, buildProposal, buildChangeRows, applyShift,
  executeProposal, runAiCommand, recordProposal, completeAudit, targetLabel
} from '../src/app/aiCommands.js';
import { INTENT, RISK } from '../src/ai/intentSchema.js';
import { AUDIT_RESULT } from '../src/domain/audit.js';
import {
  resetState, setTasks, setRoutines, setGoals, setProjects, setBills, getState
} from '../src/app/state.js';
import { normalizeTask } from '../src/domain/task.js';
import { normalizeRoutine, RECURRENCE } from '../src/domain/routine.js';
import { normalizeGoal } from '../src/domain/goal.js';
import { normalizeProject } from '../src/domain/project.js';
import { normalizeBill } from '../src/domain/finance.js';

const TODAY = new Date(2026, 8, 2); // 2.9.2026 paikallista aikaa

beforeEach(() => {
  resetState();
  setTasks([
    normalizeTask({ id: 't1', title: 'Hammaslääkäri', date: '2026-09-03', time: '14:00' }),
    normalizeTask({ id: 't2', title: 'Osta maitoa', date: '2026-09-02' }),
    normalizeTask({ id: 't3', title: 'Valmis juttu', date: '2026-09-01', completed: true })
  ]);
  setRoutines([normalizeRoutine({
    id: 'r1', title: 'Aamulääkkeet', active: true,
    recurrence: { type: RECURRENCE.DAILY, weekdays: [] }
  })]);
  setGoals([normalizeGoal({ id: 'g1', title: 'Julkaise Manifestival' })]);
  setProjects([normalizeProject({ id: 'p1', name: 'Autotallin remontti' })]);
  setBills([normalizeBill({
    id: 'b1', name: 'Sähkölasku', amountMinor: 8450, dueDate: '2026-09-15'
  })]);
});

// ------------------------------------------------------------- ehdotus

test('kelvollinen komento tuottaa valmiin ehdotuksen', () => {
  const proposal = buildProposal({
    intent: INTENT.CREATE_TASK, title: 'Soita Matille', date: '2026-09-03'
  }, { inputText: 'Muistuta soittamaan Matille', now: TODAY });

  assert.equal(proposal.status, PROPOSAL_STATUS.READY);
  assert.equal(proposal.requiresConfirmation, true);
  assert.match(proposal.preview.description, /Soita Matille/);
  assert.equal(proposal.preview.destructive, false);
});

test('tuntematon komento hylätään ja kirjataan', () => {
  const proposal = buildProposal({ intent: 'delete_everything' },
    { inputText: 'poista kaikki', now: TODAY });

  assert.equal(proposal.status, PROPOSAL_STATUS.REJECTED);
  assert.equal(proposal.audit.result, AUDIT_RESULT.REJECTED);
});

test('kohde tunnistetaan olemassa olevasta datasta', () => {
  const proposal = buildProposal({
    intent: INTENT.UPDATE_TASK, targetTitle: 'Hammaslääkäri', time: '16:00'
  }, { now: TODAY });

  assert.equal(proposal.status, PROPOSAL_STATUS.READY);
  assert.equal(proposal.target.id, 't1');
  assert.equal(proposal.audit.targetId, 't1');
});

test('KRIITTINEN: epäselvä kohde ei koskaan etene', () => {
  setTasks([
    normalizeTask({ id: 'a', title: 'Lääkäriaika', date: '2026-09-03' }),
    normalizeTask({ id: 'b', title: 'Lääkäriaika', date: '2026-09-10' })
  ]);

  const proposal = buildProposal({
    intent: INTENT.UPDATE_TASK, targetTitle: 'Lääkäriaika', time: '16:00'
  }, { now: TODAY });

  assert.equal(proposal.status, PROPOSAL_STATUS.NEEDS_CHOICE);
  assert.equal(proposal.candidates.length, 2);
  assert.equal(proposal.target, undefined, 'kohdetta ei saa valita puolesta');
  assert.equal(proposal.audit.result, AUDIT_RESULT.AMBIGUOUS);
});

test('tuntematon kohde ei etene', () => {
  const proposal = buildProposal({
    intent: INTENT.UPDATE_TASK, targetTitle: 'Olematon tehtävä', time: '16:00'
  }, { now: TODAY });

  assert.equal(proposal.status, PROPOSAL_STATUS.NEEDS_CHOICE);
  assert.match(proposal.reason, /Olematon/);
});

test('valmis tehtävä ei ole muutoskomennon kohde', () => {
  const proposal = buildProposal({
    intent: INTENT.UPDATE_TASK, targetTitle: 'Valmis juttu', time: '16:00'
  }, { now: TODAY });

  assert.equal(proposal.status, PROPOSAL_STATUS.NEEDS_CHOICE);
});

test('uncomplete kohdistuu nimenomaan valmiiseen tehtävään', () => {
  // Avoimiin rajaaminen tekisi tästä komennosta käyttökelvottoman.
  const proposal = buildProposal({
    intent: INTENT.UNCOMPLETE_TASK, targetTitle: 'Valmis juttu'
  }, { now: TODAY });

  assert.equal(proposal.status, PROPOSAL_STATUS.READY);
  assert.equal(proposal.target.id, 't3');
});

test('maksettu lasku ei ole maksukomennon kohde', () => {
  setBills([normalizeBill({
    id: 'b1', name: 'Sähkölasku', amountMinor: 8450,
    dueDate: '2026-09-15', status: 'paid', paidDate: '2026-09-01'
  })]);

  const proposal = buildProposal({
    intent: INTENT.MARK_BILL_PAID, targetName: 'Sähkölasku'
  }, { now: TODAY });

  assert.equal(proposal.status, PROPOSAL_STATUS.NEEDS_CHOICE);
});

test('kohteeton komento ei tarvitse kohdetta', () => {
  const proposal = buildProposal({ intent: INTENT.SHOW_DAY_PLAN }, { now: TODAY });
  assert.equal(proposal.status, PROPOSAL_STATUS.READY);
  assert.equal(proposal.target, null);
  assert.equal(proposal.requiresConfirmation, false, 'lukeva komento ei kysy');
});

test('jokainen kohdetyyppi löytää oman kokoelmansa', () => {
  const cases = [
    [{ intent: INTENT.UPDATE_TASK, targetTitle: 'Hammaslääkäri', time: '16:00' }, 't1'],
    [{ intent: INTENT.UPDATE_ROUTINE, targetTitle: 'Aamulääkkeet', time: '08:00' }, 'r1'],
    [{ intent: INTENT.UPDATE_GOAL, targetTitle: 'Julkaise Manifestival', status: 'paused' }, 'g1'],
    [{ intent: INTENT.UPDATE_PROJECT, targetName: 'Autotallin remontti', deadline: '2026-12-01' }, 'p1'],
    [{ intent: INTENT.MARK_BILL_PAID, targetName: 'Sähkölasku' }, 'b1']
  ];

  for (const [raw, expectedId] of cases) {
    const proposal = buildProposal(raw, { now: TODAY });
    assert.equal(proposal.status, PROPOSAL_STATUS.READY, raw.intent);
    assert.equal(proposal.target.id, expectedId, raw.intent);
  }
});

// ------------------------------------------------------------ esikatselu

test('esikatselu näyttää nykyisen ja uuden arvon', () => {
  // Pelkkä "Muuta tehtävää: Hammaslääkäri" ei riitä päätöksen pohjaksi.
  const proposal = buildProposal({
    intent: INTENT.UPDATE_TASK, targetTitle: 'Hammaslääkäri', time: '16:00'
  }, { now: TODAY });

  const row = proposal.preview.changes.find(entry => entry.field === 'time');
  assert.ok(row, 'aikamuutosta ei näytetä');
  assert.equal(row.before, '14:00');
  assert.equal(row.after, '16:00');
  assert.equal(row.label, 'Kellonaika');
});

test('rahasumma muotoillaan esikatselussa luettavaksi', () => {
  const proposal = buildProposal({
    intent: INTENT.UPDATE_BILL, targetName: 'Sähkölasku', amount: 99.9
  }, { now: TODAY });

  const row = proposal.preview.changes.find(entry => entry.field === 'amountMinor');
  assert.ok(row);
  assert.match(row.before, /84/, 'nykyinen summa euroina');
  assert.match(row.after, /99/, 'uusi summa euroina');
  assert.equal(row.after.includes('9990'), false, 'sentit eivät näy raakoina');
});

test('puuttuva arvo näkyy viivana eikä tyhjänä', () => {
  const rows = buildChangeRows(
    { payload: { changes: { deadline: '2026-12-01' } } },
    { deadline: null });
  assert.equal(rows[0].before, '—');
});

test('esikatselu ilman muutoksia on tyhjä lista', () => {
  assert.deepEqual(buildChangeRows({ payload: {} }, {}), []);
  assert.deepEqual(buildChangeRows({}, null), []);
});

test('poistokomento merkitään esikatselussa vaaralliseksi', () => {
  const proposal = buildProposal({
    intent: INTENT.DELETE_TASK, targetTitle: 'Osta maitoa'
  }, { now: TODAY });

  assert.equal(proposal.status, PROPOSAL_STATUS.READY);
  assert.equal(proposal.preview.destructive, true);
  assert.equal(proposal.command.risk, RISK.HIGH);
  assert.equal(proposal.requiresConfirmation, true);
});

test('kohdetyypeillä on luettavat nimet', () => {
  assert.equal(targetLabel('task'), 'Tehtävä');
  assert.equal(targetLabel('bill'), 'Lasku');
  assert.equal(targetLabel('tuntematon'), 'tuntematon');
});

// ---------------------------------------------------------- suhteellinen siirto

test('siirto laskee tehtävän omasta ajasta', () => {
  const shifted = applyShift({ time: '14:00', date: '2026-09-03' }, 120);
  assert.equal(shifted.time, '16:00');
  assert.equal(shifted.date, '2026-09-03');
});

test('taaksepäin siirto toimii', () => {
  const shifted = applyShift({ time: '14:00', date: '2026-09-03' }, -90);
  assert.equal(shifted.time, '12:30');
});

test('KRIITTINEN: keskiyön ylittävä siirto vaihtaa päivää', () => {
  // Ilman päivän vaihtoa "siirrä kaksi tuntia" klo 23:00 asettaisi ajaksi
  // 01:00 SAMANA päivänä eli menneisyyteen.
  const forward = applyShift({ time: '23:00', date: '2026-09-03' }, 120);
  assert.equal(forward.time, '01:00');
  assert.equal(forward.date, '2026-09-04');

  const backward = applyShift({ time: '01:00', date: '2026-09-03' }, -120);
  assert.equal(backward.time, '23:00');
  assert.equal(backward.date, '2026-09-02');
});

test('aikatauluttamatonta tehtävää ei voi siirtää suhteellisesti', () => {
  // Siirto ilman lähtöaikaa olisi arvaus.
  assert.equal(applyShift({ date: '2026-09-03' }, 120), null);
  assert.equal(applyShift(null, 120), null);
});

// ------------------------------------------------------------ suoritus

test('suoritus kutsuu oikeaa käsittelijää', async () => {
  const proposal = buildProposal({
    intent: INTENT.CREATE_TASK, title: 'Uusi', date: '2026-09-03'
  }, { now: TODAY });

  let called = null;
  const result = await executeProposal(proposal, {
    [INTENT.CREATE_TASK]: async args => { called = args; return { ok: true }; }
  });

  assert.equal(result.ok, true);
  assert.equal(called.payload.title, 'Uusi');
});

test('kytkemätön komento epäonnistuu rehellisesti', () => {
  // Rehellinen epäonnistuminen on parempi kuin hiljainen ei-mitään.
  const proposal = buildProposal({
    intent: INTENT.CREATE_TASK, title: 'Uusi'
  }, { now: TODAY });

  return executeProposal(proposal, {}).then(result => {
    assert.equal(result.ok, false);
    assert.match(result.reason, /ei ole vielä kytketty/i);
  });
});

test('käsittelijän poikkeus ei vuoda kutsujalle', async () => {
  const proposal = buildProposal({
    intent: INTENT.CREATE_TASK, title: 'Uusi'
  }, { now: TODAY });

  const result = await executeProposal(proposal, {
    [INTENT.CREATE_TASK]: async () => { throw new Error('kanta kaatui'); }
  });

  assert.equal(result.ok, false);
  assert.ok(result.reason);
});

test('keskeneräistä ehdotusta ei voi suorittaa', async () => {
  const rejected = buildProposal({ intent: 'olematon' }, { now: TODAY });
  const result = await executeProposal(rejected, {});
  assert.equal(result.ok, false);
});

// -------------------------------------------------------- koko putki

test('KRIITTINEN: vahvistamaton komento ei suoritu', async () => {
  let executed = false;

  const result = await runAiCommand(
    { intent: INTENT.CREATE_TASK, title: 'Ei saa syntyä' },
    {
      confirm: async () => false,
      handlers: { [INTENT.CREATE_TASK]: async () => { executed = true; return { ok: true }; } },
      now: TODAY
    });

  assert.equal(executed, false, 'komento suoritettiin ilman vahvistusta');
  assert.equal(result.ok, false);
  assert.equal(result.status, 'cancelled');
});

test('vahvistettu komento suoritetaan ja kirjataan', async () => {
  const result = await runAiCommand(
    { intent: INTENT.CREATE_TASK, title: 'Syntyy', date: '2026-09-03' },
    {
      inputText: 'lisää tehtävä',
      confirm: async () => true,
      handlers: { [INTENT.CREATE_TASK]: async () => ({ ok: true }) },
      now: TODAY
    });

  assert.equal(result.ok, true);

  const [entry] = getState().aiAudit;
  assert.equal(entry.confirmed, true);
  assert.equal(entry.executed, true);
  assert.equal(entry.result, AUDIT_RESULT.EXECUTED);
});

test('peruttu komento kirjataan perutuksi eikä suoritetuksi', async () => {
  await runAiCommand(
    { intent: INTENT.CREATE_TASK, title: 'Peruttu' },
    { confirm: async () => false, handlers: {}, now: TODAY });

  const [entry] = getState().aiAudit;
  assert.equal(entry.result, AUDIT_RESULT.CANCELLED);
  assert.equal(entry.executed, false);
  assert.equal(entry.confirmed, false);
});

test('KRIITTINEN: vain lukeva komento ei kysy vahvistusta', async () => {
  let asked = false;

  const result = await runAiCommand(
    { intent: INTENT.SHOW_DAY_PLAN },
    {
      confirm: async () => { asked = true; return true; },
      handlers: { [INTENT.SHOW_DAY_PLAN]: async () => ({ ok: true }) },
      now: TODAY
    });

  assert.equal(asked, false, 'lukeva komento kysyi turhaan vahvistusta');
  assert.equal(result.ok, true);
});

test('KRIITTINEN: epäselvä kohde pysäyttää putken ennen vahvistusta', async () => {
  setTasks([
    normalizeTask({ id: 'a', title: 'Sama nimi', date: '2026-09-03' }),
    normalizeTask({ id: 'b', title: 'Sama nimi', date: '2026-09-04' })
  ]);

  let asked = false;
  let executed = false;

  const result = await runAiCommand(
    { intent: INTENT.DELETE_TASK, targetTitle: 'Sama nimi' },
    {
      confirm: async () => { asked = true; return true; },
      handlers: { [INTENT.DELETE_TASK]: async () => { executed = true; return { ok: true }; } },
      now: TODAY
    });

  assert.equal(result.status, PROPOSAL_STATUS.NEEDS_CHOICE);
  assert.equal(asked, false, 'vahvistusta ei saa kysyä epäselvästä kohteesta');
  assert.equal(executed, false);
  assert.equal(result.candidates.length, 2);
});

test('epäonnistunut suoritus kirjataan epäonnistuneeksi', async () => {
  await runAiCommand(
    { intent: INTENT.CREATE_TASK, title: 'Kaatuu' },
    {
      confirm: async () => true,
      handlers: { [INTENT.CREATE_TASK]: async () => ({ ok: false, reason: 'kanta' }) },
      now: TODAY
    });

  const [entry] = getState().aiAudit;
  assert.equal(entry.result, AUDIT_RESULT.FAILED);
  assert.equal(entry.executed, false);
});

test('kirjaus ei sisällä raakaa syötettä sellaisenaan', () => {
  const pitkä = 'Soita Matille numeroon 040 1234567 ja kysy koetuloksista '
    + 'sekä kerro että lääkäri soitti eilen ja pyysi soittamaan takaisin '
    + 'mahdollisimman pian koska asia on kiireellinen';

  const proposal = buildProposal(
    { intent: INTENT.CREATE_TASK, title: 'Soita' },
    { inputText: pitkä, now: TODAY });

  assert.ok(proposal.audit.inputSummary.length < pitkä.length);
  assert.ok(proposal.audit.inputSummary.length <= 121);
});

test('kirjaus täydentyy eikä luo toista riviä', () => {
  const proposal = buildProposal({ intent: INTENT.CREATE_TASK, title: 'X' }, { now: TODAY });
  const auditId = recordProposal(proposal);

  assert.equal(getState().aiAudit.length, 1);

  completeAudit(auditId, { confirmed: true, executed: true, result: AUDIT_RESULT.EXECUTED });

  assert.equal(getState().aiAudit.length, 1, 'kirjaus kahdentui');
  assert.equal(getState().aiAudit[0].result, AUDIT_RESULT.EXECUTED);
});
