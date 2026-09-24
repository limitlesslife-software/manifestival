// Testit src/app/aiCommandHandlers.js:lle: intentti -> oikea funktio,
// oikealla kohteella, oikealla muutoksella.
//
// EI DYNAAMISTA KUTSUA MISSÄÄN VAIHEESSA. Näiden testien on todistettava,
// että kartta kutsuu OLEMASSA OLEVAA, muualla validoitua toimintoa
// muuttamattomana — ei omaa tallennuslogiikkaa.
//
// POISTOT (delete_*) EIVÄT SUORITU TÄSSÄ: ne kutsuvat ui/confirm.js:n
// confirmAction/confirmDelete-funktioita, jotka vaativat oikean DOM:in.
// Sama rajaus koskee koko koodikantaa (ks. tests/security-invariants.test.mjs,
// joka todistaa deleteTaskin vahvistuksen LÄHDETEKSTISTÄ). Tässä
// tiedostossa poisto-wiritys todistetaan samalla tavalla.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { setUser, clearUser } from '../src/data/session.js';
import { clearLocalUserData } from '../src/app/actions.js';
import { resetState, getState } from '../src/app/state.js';
import { setClient } from '../src/data/client.js';
import { fakeClient } from './helpers/gates.mjs';
import { read } from './helpers/sources.mjs';

import { handlers } from '../src/app/aiCommandHandlers.js';
import { INTENT } from '../src/ai/intentSchema.js';
import { applyShift } from '../src/app/aiCommands.js';

const USER = { id: 'aaaaaaaa-9999-0000-0000-000000000009', email: 'h@example.com' };

beforeEach(() => {
  clearUser();
  clearLocalUserData();
  resetState();
  setUser(USER);
  // tasks/profile ovat aina auki olevia perustauluja: käyttö vaatii
  // valeasiakkaan riippumatta aallon tilasta.
  setClient(fakeClient({ data: [], error: null }));
});

function target(entity, type) {
  return { id: entity.id, type, label: entity.title || entity.name, entity };
}

// =====================================================================
// TEHTÄVÄT
// =====================================================================

test('create_task kutsuu createTask():ia payloadilla', async () => {
  const result = await handlers[INTENT.CREATE_TASK]({
    payload: { title: 'Testitehtävä', date: '2026-09-20' }
  });
  assert.equal(result.ok, true);
  assert.equal(getState().tasks.length, 1);
  assert.equal(getState().tasks[0].title, 'Testitehtävä');
});

test('update_task muuttaa TÄSMÄLLEEN resolveTargetin löytämän rivin', async () => {
  const created = await handlers[INTENT.CREATE_TASK]({
    payload: { title: 'Alkuperäinen', date: '2026-09-20' }
  });
  const task = created.task;

  const result = await handlers[INTENT.UPDATE_TASK]({
    payload: { changes: { title: 'Muutettu' } },
    target: target(task, 'task')
  });
  assert.equal(result.ok, true);
  assert.equal(getState().tasks[0].title, 'Muutettu');
});

test('complete_task asettaa completed=true idempotentisti (ei togglaa)', async () => {
  const created = await handlers[INTENT.CREATE_TASK]({
    payload: { title: 'Tehtävä', date: '2026-09-20' }
  });
  const t = target(created.task, 'task');

  await handlers[INTENT.COMPLETE_TASK]({ target: t });
  assert.equal(getState().tasks[0].completed, true);

  // Kutsuttu KAHDESTI: idempotentti setter ei saa palata epätodeksi.
  await handlers[INTENT.COMPLETE_TASK]({ target: t });
  assert.equal(getState().tasks[0].completed, true,
    'complete_task ei saa togglata jo valmiiksi merkittyä tehtävää');
});

test('uncomplete_task asettaa completed=false idempotentisti', async () => {
  const created = await handlers[INTENT.CREATE_TASK]({
    payload: { title: 'Tehtävä', date: '2026-09-20' }
  });
  const t = target(created.task, 'task');

  await handlers[INTENT.COMPLETE_TASK]({ target: t });
  await handlers[INTENT.UNCOMPLETE_TASK]({ target: t });
  assert.equal(getState().tasks[0].completed, false);

  await handlers[INTENT.UNCOMPLETE_TASK]({ target: t });
  assert.equal(getState().tasks[0].completed, false);
});

test('schedule_task kirjoittaa vain annetut ajankohtakentät', async () => {
  const created = await handlers[INTENT.CREATE_TASK]({
    payload: { title: 'Tehtävä', date: '2026-09-20' }
  });
  const t = target(created.task, 'task');

  const result = await handlers[INTENT.SCHEDULE_TASK]({
    payload: { changes: { time: '14:00' } },
    target: t
  });
  assert.equal(result.ok, true);
  assert.equal(getState().tasks[0].time, '14:00');
  assert.equal(getState().tasks[0].date, '2026-09-20', 'päivä säilyy koskemattomana');
});

test('reschedule_task suhteellisella siirrolla käyttää applyShift():ia', async () => {
  const created = await handlers[INTENT.CREATE_TASK]({
    payload: { title: 'Tehtävä', date: '2026-09-20', time: '10:00' }
  });
  const t = target(created.task, 'task');

  const result = await handlers[INTENT.RESCHEDULE_TASK]({
    payload: { shiftMinutes: 120 },
    target: t,
    entity: created.task
  });
  assert.equal(result.ok, true);
  const expected = applyShift(created.task, 120);
  assert.equal(getState().tasks[0].time, expected.time);
  assert.equal(getState().tasks[0].date, expected.date);
});

test('reschedule_task ilman kellonaikaa palauttaa rehellisen epäonnistumisen', async () => {
  const created = await handlers[INTENT.CREATE_TASK]({
    payload: { title: 'Tehtävä', date: '2026-09-20' } // ei time-kenttää
  });
  const t = target(created.task, 'task');

  const result = await handlers[INTENT.RESCHEDULE_TASK]({
    payload: { shiftMinutes: 120 },
    target: t,
    entity: created.task
  });
  assert.equal(result.ok, false, 'ei kellonaikaa -> ei arvausta, rehellinen epäonnistuminen');
});

test('reschedule_task absoluuttisella päivällä kirjoittaa vain sen', async () => {
  const created = await handlers[INTENT.CREATE_TASK]({
    payload: { title: 'Tehtävä', date: '2026-09-20', time: '10:00' }
  });
  const t = target(created.task, 'task');

  const result = await handlers[INTENT.RESCHEDULE_TASK]({
    payload: { date: '2026-09-25' },
    target: t,
    entity: created.task
  });
  assert.equal(result.ok, true);
  assert.equal(getState().tasks[0].date, '2026-09-25');
  assert.equal(getState().tasks[0].time, '10:00', 'kellonaika säilyy koskemattomana');
});

// =====================================================================
// RUTIINIT, TAVOITTEET, PROJEKTIT
// =====================================================================

test('create_routine ja update_routine kohdistuvat oikeaan riviin', async () => {
  const created = await handlers[INTENT.CREATE_ROUTINE]({
    payload: { title: 'Aamulenkki', recurrence: 'daily', weekdays: [] }
  });
  assert.equal(created.ok, true);
  const routine = created.routine;

  const result = await handlers[INTENT.UPDATE_ROUTINE]({
    payload: { changes: { active: false } },
    target: target(routine, 'routine')
  });
  assert.equal(result.ok, true);
  assert.equal(getState().routines[0].active, false);
});

test('create_goal ja update_goal kohdistuvat oikeaan riviin', async () => {
  const created = await handlers[INTENT.CREATE_GOAL]({ payload: { title: 'Tavoite' } });
  assert.equal(created.ok, true);

  const result = await handlers[INTENT.UPDATE_GOAL]({
    payload: { changes: { status: 'paused' } },
    target: target(created.goal, 'goal')
  });
  assert.equal(result.ok, true);
  assert.equal(getState().goals[0].status, 'paused');
});

test('create_project ja update_project kohdistuvat oikeaan riviin', async () => {
  const created = await handlers[INTENT.CREATE_PROJECT]({ payload: { name: 'Projekti' } });
  assert.equal(created.ok, true);

  const result = await handlers[INTENT.UPDATE_PROJECT]({
    payload: { changes: { name: 'Uusi nimi' } },
    target: target(created.project, 'project')
  });
  assert.equal(result.ok, true);
  assert.equal(getState().projects[0].name, 'Uusi nimi');
});

// =====================================================================
// TALOUS
// =====================================================================

test('create_bill, update_bill ja mark_bill_paid kohdistuvat oikeaan riviin', async () => {
  const created = await handlers[INTENT.CREATE_BILL]({
    payload: { name: 'Sähkölasku', amountMinor: 5000, currency: 'EUR', dueDate: '2026-10-01' }
  });
  assert.equal(created.ok, true);
  const bill = created.bill;

  const edited = await handlers[INTENT.UPDATE_BILL]({
    payload: { changes: { amountMinor: 6000 } },
    target: target(bill, 'bill')
  });
  assert.equal(edited.ok, true);
  assert.equal(getState().bills[0].amountMinor, 6000);

  const paid = await handlers[INTENT.MARK_BILL_PAID]({
    payload: { paidDate: '2026-09-18' },
    target: target(bill, 'bill')
  });
  assert.equal(paid.ok, true);
  assert.equal(getState().bills[0].status, 'paid');
  assert.equal(getState().bills[0].paidDate, '2026-09-18');
});

test('mark_bill_paid on idempotentti: toistuva kutsu ei kaadu eikä muuta lopputulosta', async () => {
  const created = await handlers[INTENT.CREATE_BILL]({
    payload: { name: 'Sähkölasku', amountMinor: 5000, currency: 'EUR', dueDate: '2026-10-01' }
  });
  const t = target(created.bill, 'bill');

  await handlers[INTENT.MARK_BILL_PAID]({ payload: { paidDate: '2026-09-18' }, target: t });
  const second = await handlers[INTENT.MARK_BILL_PAID]({ payload: { paidDate: '2026-09-18' }, target: t });
  assert.equal(second.ok, true);
  assert.equal(getState().bills[0].status, 'paid');
});

// =====================================================================
// ASETUKSET JA VAIN-LUKU-NÄKYMÄT
// =====================================================================

test('set_notification_preference kutsuu updatePreferences():ia', async () => {
  const result = await handlers[INTENT.SET_NOTIFICATION_PREFERENCE]({
    payload: { changes: { enabled: true, maxPerDay: 5 } }
  });
  assert.equal(result.ok, true);
  assert.equal(getState().notificationPreferences.enabled, true);
  assert.equal(getState().notificationPreferences.maxPerDay, 5);
});

test('show_day_plan asettaa viewDaten ja vaihtaa näkymän', async () => {
  const result = await handlers[INTENT.SHOW_DAY_PLAN]({ payload: { date: '2026-09-25' } });
  assert.equal(result.ok, true);
  assert.equal(getState().viewDate.getFullYear(), 2026);
  assert.equal(getState().viewDate.getMonth(), 8); // syyskuu, 0-indeksoitu
  assert.equal(getState().viewDate.getDate(), 25);
  assert.equal(getState().screen, 'screen-today');
});

test('show_week_plan asettaa weekStartin viikon maanantaihin ja vaihtaa näkymän', async () => {
  // 2026-09-25 on perjantai; viikon pitää alkaa maanantaista 2026-09-21.
  const result = await handlers[INTENT.SHOW_WEEK_PLAN]({ payload: { date: '2026-09-25' } });
  assert.equal(result.ok, true);
  assert.equal(getState().weekStart.getDate(), 21);
  assert.equal(getState().screen, 'screen-week');
});

// =====================================================================
// POISTOT: WIRITYS TODISTETAAN LÄHDETEKSTISTÄ
// =====================================================================
//
// deleteTask/deleteRoutine/deleteGoal/deleteProject kutsuvat
// ui/confirm.js:n confirmAction/confirmDelete-funktioita, jotka vaativat
// document-oliota eivätkä ole suoritettavissa Node-yksikkötestissä —
// sama rajoitus kuin muualla koodikannassa (ks. security-invariants.test.mjs).

test('KRIITTINEN: poisto-intentit on kytketty oikeisiin poistofunktioihin', () => {
  const source = read('src/app/aiCommandHandlers.js');

  const expectations = [
    ['INTENT.DELETE_TASK]', 'deleteTask('],
    ['INTENT.DELETE_ROUTINE]', 'deleteRoutine('],
    ['INTENT.DELETE_GOAL]', 'deleteGoal('],
    ['INTENT.DELETE_PROJECT]', 'deleteProject(']
  ];

  for (const [marker, expectedCall] of expectations) {
    const markerIndex = source.indexOf(marker);
    assert.ok(markerIndex > -1, `${marker} puuttuu kartasta`);
    const blockEnd = source.indexOf('\n\n', markerIndex);
    const block = source.slice(markerIndex, blockEnd === -1 ? undefined : blockEnd);
    assert.ok(block.includes(expectedCall),
      `${marker} ei kutsu ${expectedCall} — poisto ei kulje testatun vahvistuspolun läpi`);
  }
});

test('kartassa ei ole dynaamista kutsua eikä evalia', () => {
  const source = read('src/app/aiCommandHandlers.js');
  for (const forbidden of ['eval(', 'new Function(', '[intent]', '[command.intent]', '[payload.']) {
    assert.equal(source.includes(forbidden), false,
      `aiCommandHandlers.js sisältää mahdollisen dynaamisen kutsun: ${forbidden}`);
  }
});

test('kartassa on käsittelijä jokaiselle sallitulle intentille', async () => {
  const { INTENTS } = await import('../src/ai/intentSchema.js');
  for (const intent of INTENTS) {
    assert.equal(typeof handlers[intent], 'function', `käsittelijä puuttuu: ${intent}`);
  }
  assert.equal(Object.keys(handlers).length, INTENTS.length,
    'kartassa on ylimääräisiä avaimia jotka eivät ole sallittuja intentteja');
});
