// Päästä päähän -skenaariot: puhe/teksti -> luokittelu -> tarkistus ->
// vahvistus -> muutos -> ilmoitusten täsmäytys, sekä lähtö -> ilmoitus.
//
// Oikeat moduulit (voice.js:n runVoiceCommand, commandBar, aiCommands,
// actions, notifications.planUpcoming, departure-moottori). Mallin
// vastaus injektoidaan (fetchImpl): itse luokittelua ei kutsuta.
// Ei DOM:ia; vahvistusdialogit injektoidaan.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { setUser, clearUser } from '../src/data/session.js';
import { setClient } from '../src/data/client.js';
import { fakeClient } from './helpers/gates.mjs';
import {
  resetState, getState, setTasks, setNotificationPreferences, setTravelPlans
} from '../src/app/state.js';
import { clearLocalUserData, createBill } from '../src/app/actions.js';
import { normalizeTask } from '../src/domain/task.js';
import { normalizePreferences } from '../src/domain/notification.js';
import { normalizeTravelPlan, TRAVEL_SOURCE } from '../src/domain/travel.js';
import { resetExecutionLedger } from '../src/app/aiCommands.js';
import { fmtISO, todayMidnight, addDays } from '../src/lib/datetime.js';

import { runVoiceCommand } from '../src/app/voice.js';
import { runTypedCommand } from '../src/app/commandBar.js';
import { planUpcoming } from '../src/app/notifications.js';
import { collectCandidates, CANDIDATE_KIND } from '../src/domain/assistant.js';
import { departureState, DEPARTURE_STATE } from '../src/domain/travel.js';

const USER = { id: 'aaaaaaaa-3333-4333-8333-000000000003', email: 's@example.com' };
const TODAY = fmtISO(todayMidnight());
const TOMORROW = fmtISO(addDays(todayMidnight(), 1));
const DAY_AFTER = fmtISO(addDays(todayMidnight(), 2));

const modelSays = json => async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: json }] }) });

beforeEach(() => {
  clearUser();
  clearLocalUserData();
  resetState();
  resetExecutionLedger();
  setUser(USER);
  setClient(fakeClient({ data: [], error: null }));
  setNotificationPreferences(normalizePreferences({
    enabled: true, maxPerDay: 50, dailyPlanEnabled: false, eveningReviewEnabled: false, deadlineWarningsEnabled: false
  }));
});

const intentsOfType = type => planUpcoming().intents.filter(intent => intent.type === type);

// ------------------------------------------------------------- Skenaario A

test('SKENAARIO A: puhe "muistuta huomenna klo 8 soittamaan" -> LUONTI -> vahvistus -> tehtävä -> ilmoitus', async () => {
  assert.equal(intentsOfType('task_reminder').length, 0);

  let shownPreview = null;
  const result = await runVoiceCommand('Muistuta minua huomenna klo 8 soittamaan asiakkaalle', {
    fetchImpl: modelSays(JSON.stringify({ intent: 'create_task', title: 'Soita asiakkaalle', date: TOMORROW, time: '08:00' })),
    confirmFn: async proposal => { shownPreview = proposal.preview; return true; },
    chooseFn: async () => null
  });

  assert.equal(result.ok, true);
  assert.ok(shownPreview, 'käyttäjä näki ehdotuksen ennen luontia');
  assert.equal(shownPreview.action, 'Luo tehtävä');
  assert.equal(shownPreview.destructive, false);

  const [created] = getState().tasks;
  assert.deepEqual([created.title, created.date, created.time], ['Soita asiakkaalle', TOMORROW, '08:00']);

  // Ilmoitusten täsmäytys: suunnitelmaan ilmestyi muistutus 10 min ennen.
  const [reminder] = intentsOfType('task_reminder');
  assert.equal(reminder.targetId, created.id);
  assert.deepEqual([reminder.date, reminder.time], [TOMORROW, '07:50']);
});

test('SKENAARIO A: peruttu vahvistus ei luo tehtävää eikä ilmoitusta', async () => {
  const result = await runVoiceCommand('Muistuta minua huomenna klo 8 soittamaan asiakkaalle', {
    fetchImpl: modelSays(JSON.stringify({ intent: 'create_task', title: 'Soita asiakkaalle', date: TOMORROW, time: '08:00' })),
    confirmFn: async () => false,
    chooseFn: async () => null
  });
  assert.equal(result.status, 'cancelled');
  assert.equal(getState().tasks.length, 0);
  assert.equal(intentsOfType('task_reminder').length, 0);
});

// ------------------------------------------------------------- Skenaario B

test('SKENAARIO B: puhe "siirrä huomisen soitto ylihuomiselle" -> KOMENTO -> kohde -> vahvistus -> muutos -> ilmoitus siirtyy', async () => {
  setTasks([normalizeTask({ id: 'call1', title: 'Soitto asiakkaalle', date: TOMORROW, time: '08:00' })]);
  const before = intentsOfType('task_reminder');
  assert.deepEqual(before.map(i => [i.date, i.time]), [[TOMORROW, '07:50']]);

  let preview = null;
  const result = await runVoiceCommand('Siirrä huomisen asiakkaalle soitto ylihuomiselle', {
    fetchImpl: modelSays(JSON.stringify({ intent: 'reschedule_task', targetName: 'Soitto asiakkaalle', date: DAY_AFTER })),
    confirmFn: async proposal => { preview = proposal.preview; return true; },
    chooseFn: async () => null
  });

  assert.equal(result.ok, true);
  assert.equal(preview.targetLabel, 'Soitto asiakkaalle', 'ratkaistu kohde näytetään');
  assert.ok(preview.changes.some(row => row.field === 'date' && row.before === TOMORROW && row.after === DAY_AFTER),
    'nykyinen -> uusi näytetään');

  assert.equal(getState().tasks[0].date, DAY_AFTER);
  const after = intentsOfType('task_reminder');
  assert.deepEqual(after.map(i => [i.date, i.time]), [[DAY_AFTER, '07:50']], 'vanha muistutus poistui, uusi tuli, ei kahta');
  assert.equal(after[0].id === before[0].id, false, 'päivä on osa tunnistetta -> uudelleenajastus korvaa');
});

test('SKENAARIO B: kaksi samannimistä -> valitsin, valinta ohjaa muutoksen, toinen koskematon', async () => {
  setTasks([
    normalizeTask({ id: 'a', title: 'Soitto asiakkaalle', date: TOMORROW, time: '08:00' }),
    normalizeTask({ id: 'b', title: 'Soitto asiakkaalle', date: TODAY, time: '09:00' })
  ]);
  let candidates = null;
  const result = await runVoiceCommand('Siirrä asiakkaalle soitto ylihuomiselle', {
    fetchImpl: modelSays(JSON.stringify({ intent: 'reschedule_task', targetName: 'Soitto asiakkaalle', date: DAY_AFTER })),
    confirmFn: async () => true,
    chooseFn: async list => { candidates = list; return list.find(entry => entry.id === 'a'); }
  });
  assert.equal(result.ok, true);
  assert.equal(candidates.length, 2);
  assert.equal(getState().tasks.find(t => t.id === 'a').date, DAY_AFTER);
  assert.equal(getState().tasks.find(t => t.id === 'b').date, TODAY);
});

// ------------------------------------------------------------- Skenaario C

test('SKENAARIO C: kirjoitettu "merkitse sähkölasku maksetuksi" -> lasku -> vahvistus -> maksettu -> toisto ei tuplaa', async () => {
  await createBill({ name: 'Sähkölasku', amountMinor: 8990, dueDate: TOMORROW, currency: 'EUR' });
  assert.equal(getState().bills[0].status, 'open');

  const confirmations = [];
  const run = () => runTypedCommand('Merkitse sähkölasku maksetuksi', {
    fetchImpl: modelSays(JSON.stringify({ intent: 'mark_bill_paid', targetName: 'Sähkölasku' })),
    confirmFn: async proposal => { confirmations.push(proposal); return true; },
    chooseFn: async () => null
  });

  const first = await run();
  assert.equal(first.ok, true);
  assert.equal(confirmations.length, 1, 'vahvistus vaadittiin');
  assert.equal(confirmations[0].requiresConfirmation, true);
  assert.equal(confirmations[0].preview.targetLabel, 'Sähkölasku');
  assert.equal(confirmations[0].command.risk, 'medium', 'maksun merkintä on keskitason, ei tuhoava (HIGH varattu poistolle)');
  assert.equal(getState().bills[0].status, 'paid');

  // Toinen sama komento: maksettua ei voi merkitä uudelleen -> kohdetta ei löydy, mitään ei tehdä.
  const second = await run();
  assert.equal(second.ok, false);
  assert.equal(confirmations.length, 1, 'ei uutta vahvistusta maksetulle laskulle');
  assert.equal(getState().bills[0].status, 'paid');
  assert.equal(getState().bills.length, 1);
});

test('SKENAARIO C: peruttu vahvistus jättää laskun avoimeksi', async () => {
  await createBill({ name: 'Sähkölasku', amountMinor: 8990, dueDate: TOMORROW, currency: 'EUR' });
  const result = await runTypedCommand('Merkitse sähkölasku maksetuksi', {
    fetchImpl: modelSays(JSON.stringify({ intent: 'mark_bill_paid', targetName: 'Sähkölasku' })),
    confirmFn: async () => false,
    chooseFn: async () => null
  });
  assert.equal(result.status, 'cancelled');
  assert.equal(getState().bills[0].status, 'open');
});

// ------------------------------------------------------------- Skenaario D

test('SKENAARIO D: matka tiedossa olevalla kestolla -> lähtöehdotus -> NOW/NEXT -> ilmoitus', () => {
  // Saapuminen huomenna 18:00, itse arvioitu 40 min matka, 5 min pysäköinti -> lähtö 17:15.
  const plan = normalizeTravelPlan({
    id: 'trip1', title: 'Asiakastapaaminen', destination: 'Kuopio', arrivalDate: TOMORROW, arrivalTime: '18:00',
    travelMinutes: 40, travelSource: TRAVEL_SOURCE.MANUAL, preparationMinutes: 0, arrivalBufferMinutes: 5
  });
  setTravelPlans([plan]);

  // 1. Ehdotus.
  const state = departureState(plan, { todayIso: TOMORROW, nowMinutes: 17 * 60 + 5 });
  assert.equal(state.state, DEPARTURE_STATE.LEAVE_SOON);
  assert.match(state.message, /Lähde noin 17:15 \(10 min kuluttua\), jotta ehdit klo 18:00\./);

  // 2. NOW/NEXT: lähtö on ehdokas, ja se ohittaa muun.
  const candidates = collectCandidates({
    tasks: [normalizeTask({ id: 't', title: 'Muu', date: TOMORROW, time: '17:10', durationMinutes: 30 })],
    travelPlans: [plan], todayIso: TOMORROW, nowMinutes: 17 * 60 + 5
  });
  assert.equal(candidates[0].kind, CANDIDATE_KIND.DEPARTURE);
  assert.match(candidates[0].reason, /Lähde noin 17:15/);

  // 3. Ilmoitus: 10 min ennen lähtöä, deterministinen tunniste.
  const [intent] = intentsOfType('departure_reminder');
  assert.deepEqual([intent.date, intent.time], [TOMORROW, '17:05']);
  assert.equal(intent.id, `departure_reminder:trip1:${TOMORROW}`);

  // 4. Kestoa muutetaan (käyttäjä korjaa arvion): sama tunniste, uusi aika.
  setTravelPlans([{ ...plan, travelMinutes: 60 }]);
  const [moved] = intentsOfType('departure_reminder');
  assert.equal(moved.id, intent.id);
  assert.equal(moved.time, '16:45');
  assert.equal(intentsOfType('departure_reminder').length, 1, 'ei kahdennu');
});

test('SKENAARIO D: tuntematon kesto ei tuota ehdotusta, NOW/NEXT-ehdokasta eikä ilmoitusta', () => {
  const plan = normalizeTravelPlan({
    id: 'trip2', title: 'Tuntematon matka', destination: 'Oulu', arrivalDate: TOMORROW, arrivalTime: '18:00', travelMinutes: null
  });
  setTravelPlans([plan]);
  assert.equal(departureState(plan, { todayIso: TOMORROW, nowMinutes: 17 * 60 }).state, DEPARTURE_STATE.UNKNOWN);
  assert.equal(collectCandidates({ travelPlans: [plan], todayIso: TOMORROW, nowMinutes: 17 * 60 }).length, 0);
  assert.equal(intentsOfType('departure_reminder').length, 0);
});
