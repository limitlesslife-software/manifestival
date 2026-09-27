// Yksi muistutusputki (src/app/alarmSync.js dailyLifeReminderPlan):
// perinteiset muistutukset (tehtävä, rutiini, määräaika, päivän suunnitelma,
// illan katsaus) kulkevat SAMAN toimituspolitiikan läpi kuin arjen
// muistutukset. Aiemmin ne menivät suoraan tavallisiksi ilmoituksiksi:
// "Määräajat"- ja "Rutiinit"-valinnat eivät tehneet mitään, määräaika ei
// koskaan puhunut, kooste ei yhdistänyt mitään ja päivärajoja oli kaksi.
//
// Kello annetaan aina parametrina; laitteen vyöhyke on ajokoneen oma.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { setUser, clearUser } from '../src/data/session.js';
import {
  resetState, setProfile, setLifeSettings, setNotificationPreferences, setTasks, setRoutines,
  setCalendarEvents, setSavedPlaces
} from '../src/app/state.js';
import { clearAllCollections } from '../src/data/collectionsRepo.js';
import { resetAckStoreForTests } from '../src/data/alarmAckStore.js';
import * as capabilities from '../src/platform/capabilities.js';
import { resetAlarmsForTests } from '../src/platform/alarms.js';
import {
  activateAlarmSync, resetAlarmSync, desiredNativeEntries, dailyLifeReminderPlan, settledForTests
} from '../src/app/alarmSync.js';
import { activateAlarmEvents, resetAlarmEvents } from '../src/app/alarmEvents.js';
import { normalizeTask } from '../src/domain/task.js';
import { normalizeRoutine, RECURRENCE } from '../src/domain/routine.js';
import { DELIVERY } from '../src/domain/dailyLife.js';
import { readCode } from './helpers/sources.mjs';

const USER = { id: 'aaaaaaaa-0000-4000-8000-0000000000c1', email: 'p@example.com' };
const TODAY = '2026-09-29'; // tiistai
const TOMORROW = '2026-09-30';
const at = (y, m, d, hh, mm) => new Date(y, m - 1, d, hh, mm);
const NOON = at(2026, 9, 29, 12, 0);
const ORIGINAL_CAPACITOR = globalThis.Capacitor;

function signIn() {
  setUser(USER);
  activateAlarmSync(USER.id);
  activateAlarmEvents(USER.id);
}

function seed({ settings = {}, preferences = {} } = {}) {
  setProfile({ sleepTargetHours: 8, defaultWakeTime: '06:30' }, true);
  setLifeSettings([{ id: 's1', ...settings }]);
  setNotificationPreferences({ enabled: true, maxPerDay: 30, ...preferences });
}

const deadlineTask = () => normalizeTask({
  id: 'vero', title: 'Veroilmoitus', date: TODAY, deadline: TOMORROW, completed: false
});

beforeEach(() => {
  delete globalThis.Capacitor;
  clearAllCollections();
  resetState();
  clearUser();
  resetAlarmsForTests();
  resetAckStoreForTests();
  capabilities.resetNativePermission();
  capabilities.resetAlarmAccessState();
});

afterEach(async () => {
  await resetAlarmSync();
  resetAlarmEvents();
  await settledForTests();
  if (ORIGINAL_CAPACITOR === undefined) delete globalThis.Capacitor;
  else globalThis.Capacitor = ORIGINAL_CAPACITOR;
  clearUser();
  resetState();
});

// ------------------------------------------------------------ toimitustapa aiheittain

test('Määräajat = Puhe: määräaikavaroitus puhuu laitteella (herätysliitännäinen), ei tavallisena ilmoituksena', () => {
  signIn();
  seed({ settings: { speechEnabled: true, delivery: { deadline: DELIVERY.SPEECH } } });
  setTasks([deadlineTask()]);
  const { entries, localIntents } = desiredNativeEntries({ now: NOON, nativeSupported: true });
  const spoken = entries.filter(entry => entry.id.startsWith('deadline_warning:vero:'));
  assert.ok(spoken.length >= 1, 'määräaika laitteelle');
  assert.ok(spoken.every(entry => entry.kind === 'spoken' && entry.mode === 'speech'));
  assert.ok(spoken.every(entry => typeof entry.speech === 'string' && /määräaika/i.test(entry.speech)));
  assert.equal(/Veroilmoitus/.test(spoken[0].speech), false, 'puhe ei lue tehtävän nimeä ääneen');
  assert.equal(localIntents.some(intent => intent.type === 'deadline_warning'), false, 'ei kahdesti');
});

test('Määräajat ilman puhelupaa: tulee äänimerkkinä tavallisena ilmoituksena, ei puhu', () => {
  signIn();
  seed({ settings: { speechEnabled: false, delivery: { deadline: DELIVERY.SPEECH } } });
  setTasks([deadlineTask()]);
  const { entries, localIntents } = desiredNativeEntries({ now: NOON, nativeSupported: true });
  assert.equal(entries.some(entry => entry.id.startsWith('deadline_warning:')), false);
  const local = localIntents.filter(intent => intent.type === 'deadline_warning');
  assert.ok(local.length >= 1);
  assert.ok(local.every(intent => intent.delivery === DELIVERY.SOUND && intent.speech === null && intent.topic === 'deadline'));
});

test('Rutiinit-valinta koskee rutiinimuistutuksia (hiljainen / puhe)', () => {
  signIn();
  const routine = normalizeRoutine({
    id: 'r1', title: 'Iltalääkkeet', active: true, recurrence: { type: RECURRENCE.DAILY, weekdays: [] },
    preferredTime: '19:00', durationMinutes: 10
  });
  seed({ settings: { delivery: { routine: DELIVERY.SILENT } } });
  setRoutines([routine]);
  const silent = dailyLifeReminderPlan({ now: NOON }).intents.filter(intent => intent.type === 'routine_reminder');
  assert.ok(silent.length >= 1);
  assert.ok(silent.every(intent => intent.delivery === DELIVERY.SILENT && intent.topic === 'routine'));

  seed({ settings: { speechEnabled: true, delivery: { routine: DELIVERY.SPEECH } } });
  const { entries } = desiredNativeEntries({ now: NOON, nativeSupported: true });
  const spoken = entries.filter(entry => entry.id.startsWith('routine_reminder:'));
  assert.ok(spoken.length >= 1, 'puhuva rutiini laitteelle');
  assert.equal(spoken[0].time, '18:55', 'rutiinin ennakko 5 min');
});

test('ohjaustyyli koskee myös tehtävän ennakkoa: aktiivinen 10 -> 15 min', () => {
  signIn();
  seed();
  setTasks([normalizeTask({ id: 't1', title: 'Palaveri', date: TODAY, time: '18:00', durationMinutes: 30 })]);
  const calm = dailyLifeReminderPlan({ now: NOON }).intents.find(intent => intent.type === 'task_reminder');
  assert.equal(calm.time, '17:50');
  seed({ settings: { guidanceStyle: 'aktiivinen' } });
  const active = dailyLifeReminderPlan({ now: NOON }).intents.find(intent => intent.type === 'task_reminder');
  assert.equal(active.time, '17:45');
});

// ------------------------------------------------------------ kooste

test('kooste toimii ajastuspolulla: vähäiset (päivän suunnitelma, katsaus, huomisen määräaika) yhdeksi', () => {
  signIn();
  seed({ settings: { digestEnabled: true, digestTime: '18:00' } });
  setTasks([deadlineTask()]);
  const intents = dailyLifeReminderPlan({ now: NOON }).intents;
  const tomorrow = intents.filter(intent => intent.date === TOMORROW);
  const digests = tomorrow.filter(intent => intent.type === 'digest');
  assert.equal(digests.length, 1, 'yksi kooste päivässä');
  assert.equal(digests[0].time, '18:00');
  assert.ok(digests[0].mergedCount >= 3, 'suunnitelma, katsaus ja määräaika yhdessä');
  for (const type of ['daily_plan', 'evening_review', 'deadline_warning']) {
    assert.equal(tomorrow.some(intent => intent.type === type), false, `${type} meni koosteeseen`);
  }

  seed({ settings: { digestEnabled: false } });
  const plain = dailyLifeReminderPlan({ now: NOON }).intents;
  assert.equal(plain.some(intent => intent.type === 'digest'), false);
  assert.ok(plain.some(intent => intent.type === 'daily_plan' && intent.date === TOMORROW));
});

// ------------------------------------------------------------ yksi päiväraja

test('yksi päiväraja kaikille: laitteelle ja tavallisiksi ilmoituksiksi yhteensä enintään maxPerDay (+ kriittiset)', () => {
  signIn();
  seed({
    settings: { speechEnabled: true, delivery: { deadline: DELIVERY.SPEECH, departure: DELIVERY.SPEECH } },
    preferences: { maxPerDay: 4 }
  });
  setSavedPlaces([{ id: 'p1', name: 'Asiakas', address: 'Kauppakatu 1', travelMode: 'driving', usualTravelMinutes: 20 }]);
  setCalendarEvents([{ id: 'e1', title: 'Asiakas', date: TOMORROW, startTime: '15:00', durationMinutes: 60, placeId: 'p1' }]);
  const tasks = [deadlineTask()];
  for (let hour = 8; hour < 21; hour++) {
    tasks.push(normalizeTask({ id: `t${hour}`, title: `Asia ${hour}`, date: TOMORROW, time: `${String(hour).padStart(2, '0')}:30` }));
  }
  setTasks(tasks);
  const { entries, localIntents } = desiredNativeEntries({ now: NOON, nativeSupported: true });
  const plan = dailyLifeReminderPlan({ now: NOON }).intents;
  const nonCritical = plan.filter(intent => intent.date === TOMORROW && intent.level !== 4);
  assert.ok(nonCritical.length <= 4, `huomenna ${nonCritical.length} ei-kriittistä`);
  const delivered = [
    ...entries.filter(entry => entry.kind !== 'wake').map(entry => entry.id),
    ...localIntents.map(intent => intent.id)
  ];
  assert.equal(new Set(delivered).size, delivered.length, 'sama muistutus ei tule kahdesti');
  const tomorrowIds = new Set(plan.filter(intent => intent.date === TOMORROW).map(intent => intent.id));
  assert.equal(delivered.filter(id => tomorrowIds.has(id)).length, tomorrowIds.size, 'jako kattaa koko suunnitelman');
});

test('notifications.js ei enää kattoa eikä ohita politiikkaa: tavalliset ilmoitukset tulevat samasta suunnitelmasta', () => {
  const source = readCode('src/app/notifications.js');
  assert.equal(/capPerDay\(/.test(source), false, 'toinen päiväraja kaksinkertaistaisi hälyn');
  assert.equal(/planRange\(/.test(source), false, 'perinteiset muistutukset eivät ohita politiikkaa');
  const sync = source.slice(source.indexOf('export async function syncNotifications'));
  assert.match(sync.slice(0, 4000), /safeReminderIntents\(\)/);
});

test('esikatselu (planUpcoming) näyttää saman suunnitelman: toimitustapa ja aihe päätetty', async () => {
  signIn();
  seed();
  const { planUpcoming } = await import('../src/app/notifications.js');
  const { intents } = planUpcoming();
  assert.ok(intents.some(intent => intent.type === 'daily_plan'), 'päivän suunnitelma mukana');
  for (const intent of intents) {
    assert.ok(typeof intent.delivery === 'string', `${intent.type}: toimitustapa päätetty`);
  }
});
