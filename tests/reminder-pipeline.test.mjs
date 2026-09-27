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

// ------------------------------------------------------------ päiväraja: arvo ennen aikaa

/** Täysi arkipäivä: vesi tunnin välein, kolme ateriaa, lisäravinne, kaksi lähtöä, uni. */
function seedFullDay({ preferences = {}, settings = {} } = {}) {
  seed({
    preferences: { maxPerDay: 12, ...preferences },
    settings: {
      arrivalBufferMinutes: 10,
      mealRhythm: {
        meals: [
          { id: 'aamu', name: 'Aamupala', time: '07:00', prepMinutes: 25 },
          { id: 'lounas', name: 'Lounas', time: '11:30', prepMinutes: 20 },
          { id: 'paiv', name: 'Päivällinen', time: '17:30', prepMinutes: 30 }
        ],
        waterEveryMinutes: 60, waterFrom: '08:00', waterTo: '20:00',
        supplements: [{ id: 'dvit', name: 'D-vitamiini', time: '07:00' }]
      },
      ...settings
    }
  });
  setSavedPlaces([
    { id: 'tyo', name: 'Työ', address: 'Työkatu 1', travelMode: 'driving', usualTravelMinutes: 30, preparationMinutes: 15 },
    { id: 'hl', name: 'Hammaslääkäri', address: 'Hammaskatu 2', travelMode: 'driving', usualTravelMinutes: 30, preparationMinutes: 15 }
  ]);
  setCalendarEvents([
    { id: 'aamu', title: 'Työ', date: TOMORROW, startTime: '08:00', durationMinutes: 480, placeId: 'tyo' },
    { id: 'ilta', title: 'Hammaslääkäri', date: TOMORROW, startTime: '16:00', durationMinutes: 45, placeId: 'hl' }
  ]);
}

test('päiväraja (oletus 12) säilyttää lähtöketjut, iltarauhoittumisen ja nukkumaanmenon; vesitauot karsitaan ensin', () => {
  signIn();
  seedFullDay();
  const tomorrow = dailyLifeReminderPlan({ now: NOON }).intents.filter(intent => intent.date === TOMORROW);
  const types = tomorrow.map(intent => intent.type);
  assert.ok(types.includes('wind_down'), 'iltarauhoittuminen säilyy');
  assert.ok(types.includes('bedtime'), 'nukkumaanmeno säilyy');
  const prepares = tomorrow.filter(intent => intent.type === 'departure_prepare').map(intent => intent.departureId);
  assert.ok(prepares.includes(`event:ilta:${TOMORROW}`), 'iltapäivän lähdön valmistautuminen säilyy');
  assert.ok(prepares.includes(`event:aamu:${TOMORROW}`));
  const nonCritical = tomorrow.filter(intent => intent.level !== 4);
  assert.ok(nonCritical.length <= 12, `${nonCritical.length} ei-kriittistä`);
  const water = tomorrow.filter(intent => intent.mealKind === 'water');
  assert.ok(water.length < 13, 'vesitaukoja karsittiin ensin');
  // Vesitauko ei säily, jos jokin arvokkaampi karsittiin.
  const kept = new Set(tomorrow.map(intent => intent.id));
  if (water.length > 0) {
    for (const meal of ['aamu', 'lounas', 'paiv']) assert.ok(kept.has(`meal:${meal}:${TOMORROW}`), meal);
  }
});

test('valittu puhuttu nukkumaanmeno kuuluu, vaikka oletusrauhoitusaika (22.00) alkaa ennen sitä', () => {
  signIn();
  seedFullDay({ settings: { speechEnabled: true, delivery: { bedtime: DELIVERY.SPEECH } } });
  const { entries } = desiredNativeEntries({ now: NOON, nativeSupported: true });
  const night = entries.filter(entry => /^(bedtime|wind_down):/.test(entry.id));
  assert.ok(night.length >= 2, 'iltarauhoittuminen ja nukkumaanmeno laitteelle');
  for (const entry of night) {
    assert.equal(entry.kind, 'spoken', entry.id);
    assert.equal(entry.mode, 'speech', entry.id);
    assert.ok(entry.speech, entry.id);
  }
  assert.ok(night.some(entry => entry.time >= '22:00'), 'rauhoitusajan sisällä');
});

// ------------------------------------------------------------ illan ennakko

/** Huomenna aikainen meno: herätys aiemmin kuin tavallisesti (06.30). */
function seedEarlyTomorrow(settings = {}) {
  seed({ settings: { arrivalBufferMinutes: 10, windDownMinutes: 30, ...settings } });
  setProfile({ sleepTargetHours: 8, defaultWakeTime: '06:30', routineMinutes: 45 }, true);
  setSavedPlaces([{ id: 'kk', name: 'Lentokenttä', address: 'Lentoasemantie 1', travelMode: 'driving',
    usualTravelMinutes: 40, preparationMinutes: 10 }]);
  setCalendarEvents([{ id: 'lento', title: 'Lento', date: TOMORROW, startTime: '07:00', durationMinutes: 60, placeId: 'kk' }]);
}

test('illan ennakko ajastetaan muistutukseksi, kun huominen vaatii aiemman herätyksen', async () => {
  signIn();
  seedEarlyTomorrow();
  const { eveningBeforeAdvice, eveningBeforeNotice } = await import('../src/app/dailyLifeNotices.js');
  const { eveningBeforeTime } = await import('../src/app/alarmSync.js');
  const advice = eveningBeforeAdvice(TOMORROW, { now: NOON });
  assert.ok(advice && advice.message, 'huominen vaatii aiemman herätyksen');

  const { entries, localIntents } = desiredNativeEntries({ now: NOON, nativeSupported: true });
  const evening = localIntents.find(intent => intent.type === 'evening_before');
  assert.ok(evening, 'illan ennakko on ajastettu muistutus');
  assert.equal(evening.date, TODAY);
  assert.equal(evening.time, eveningBeforeTime(TODAY, TODAY, advice.windDownStart));
  assert.ok(evening.time <= '18:00' && evening.time < advice.windDownStart, 'ennen iltarauhoittumista');
  assert.equal(evening.title, 'Huominen alkaa aiemmin');
  assert.ok(evening.body.startsWith(advice.message), 'sama neuvo kuin ilmoituskeskuksessa');
  const leave = /Ensimmäinen lähtö klo (\d{2}:\d{2})\./.exec(evening.body);
  assert.ok(leave && leave[1] < '07:00', 'huomisen ensimmäinen lähtö kerrotaan');
  assert.equal(evening.delivery, DELIVERY.VIBRATE, 'oletus värisee (ei hiljainen)');
  assert.equal(entries.some(entry => entry.id.startsWith('evening_before')), false, 'ei puhu oletuksena');
  // Sovelluksessa sama neuvo illalla (ilmoituskeskus): yksi laskenta.
  const notice = eveningBeforeNotice({ now: at(2026, 9, 29, 19, 0) });
  assert.equal(notice.reason, advice.message);
});

test('illan ennakko puhuu, kun Aamurutiini = Puhe; tavallisena iltana ennakkoa ei tule', () => {
  signIn();
  seedEarlyTomorrow({ speechEnabled: true, delivery: { morning: DELIVERY.SPEECH } });
  const { entries } = desiredNativeEntries({ now: NOON, nativeSupported: true });
  const spoken = entries.find(entry => entry.id.startsWith(`evening_before:huominen:${TODAY}`));
  assert.ok(spoken, 'puhuttu illan ennakko laitteelle');
  assert.match(spoken.speech, /Iltarutiini kannattaa aloittaa kello \d{1,2}\.\d{2}\./);
  assert.equal(/Lento|Lentokenttä/.test(spoken.speech), false, 'ei menon nimeä ääneen');

  setCalendarEvents([]);
  const plain = dailyLifeReminderPlan({ now: NOON }).intents;
  assert.equal(plain.some(intent => intent.type === 'evening_before'), false, 'ei aiempaa herätystä -> ei ennakkoa');
});

test('illan ennakon hetki: rauhoittuminen − 60 min, viimeistään 18.00, aikaisintaan 12.00', async () => {
  const { eveningBeforeTime } = await import('../src/app/alarmSync.js');
  assert.equal(eveningBeforeTime(TODAY, TODAY, '21:40'), '18:00');
  assert.equal(eveningBeforeTime(TODAY, TODAY, '18:30'), '17:30');
  assert.equal(eveningBeforeTime(TODAY, TODAY, '12:30'), '12:00');
  assert.equal(eveningBeforeTime(TODAY, TOMORROW, '00:15'), '18:00', 'keskiyön jälkeen alkava rauhoittuminen');
  assert.equal(eveningBeforeTime(TODAY, '2026-09-28', '23:00'), null);
});

test('päivärajan arvo: suojatut ennen tavallisia, vähäiset (vesi, suunnitelma, Tieto) viimeisenä', async () => {
  const { capValue, capPerDay, CAP_VALUE } = await import('../src/domain/notificationPolicy.js');
  const { createIntent } = await import('../src/domain/notification.js');
  const make = (type, time, extra = {}, level = 2) => createIntent({
    type, level, date: TOMORROW, time, title: type, targetId: `${type}-${time}`, extra
  });
  assert.equal(capValue(make('bedtime', '22:30')), CAP_VALUE.PROTECTED);
  assert.equal(capValue(make('wind_down', '22:00')), CAP_VALUE.PROTECTED);
  assert.equal(capValue(make('departure_prepare', '15:05')), CAP_VALUE.PROTECTED);
  assert.equal(capValue(make('deadline_warning', '07:30')), CAP_VALUE.PROTECTED);
  assert.equal(capValue(make('meal', '11:10')), CAP_VALUE.NORMAL);
  assert.equal(capValue(make('meal', '09:00', { mealKind: 'water' })), CAP_VALUE.LOW);
  assert.equal(capValue(make('daily_plan', '07:30', {}, 1)), CAP_VALUE.LOW);
  const list = [
    make('meal', '08:00', { mealKind: 'water' }), make('meal', '09:00', { mealKind: 'water' }),
    make('task_reminder', '10:00'), make('wind_down', '22:00'), make('bedtime', '22:30')
  ];
  const kept = capPerDay(list, 3).map(intent => intent.type);
  assert.deepEqual(kept, ['task_reminder', 'wind_down', 'bedtime'], 'aamun vesitauot eivät vie illan paikkoja');
});

// ------------------------------------------------------------ menon alku ilman lähtöketjua

test('meno ilman paikkaa saa muistutuksen alkuun (alku − 10 min), ei lähtöketjua eikä lähtösanoja', () => {
  signIn();
  seed();
  setCalendarEvents([{ id: 'hl', title: 'Hammaslääkäri keskustassa', date: TOMORROW, startTime: '16:00', durationMinutes: 45 }]);
  const intents = dailyLifeReminderPlan({ now: NOON }).intents;
  const starts = intents.filter(intent => intent.type === 'event_start');
  assert.equal(starts.length, 1, 'yksi muistutus menon alkuun');
  const [start] = starts;
  assert.deepEqual([start.date, start.time], [TOMORROW, '15:50'], 'oletusennakko 10 min (Tehtävä tai meno)');
  assert.equal(start.title, 'Hammaslääkäri keskustassa');
  assert.equal(start.body, 'Alkaa klo 16:00.');
  assert.equal(start.topic, 'preparation', 'toimitustapa Valmistautuminen-valinnasta');
  assert.equal(start.delivery, DELIVERY.SOUND);
  assert.equal(start.occurrenceId, `event:hl:${TOMORROW}`);
  assert.doesNotMatch(start.title + start.body + start.reason, /[Ll]ähtö|[Ll]ähde/);
  assert.equal(intents.some(intent => /^departure_/.test(intent.type)), false, 'lähtöä ei arvata');
  // Tavallisena ilmoituksena (ei puhu oletuksena): ei laitteen herätysliitännäiselle.
  const { entries, localIntents } = desiredNativeEntries({ now: NOON, nativeSupported: true });
  assert.equal(entries.some(entry => entry.id.startsWith('event_start:')), false);
  assert.ok(localIntents.some(intent => intent.id === start.id));
});

test('menon alku: paikka ilman matka-aikaa kertoo, ettei lähtöä laskettu; tunnettu matka tuottaa lähtöketjun', () => {
  signIn();
  seed();
  setSavedPlaces([{ id: 'p1', name: 'Asiakas', address: 'Kauppakatu 1', travelMode: 'driving', usualTravelMinutes: 20 }]);
  setCalendarEvents([
    { id: 'tuntematon', title: 'Kokous', date: TOMORROW, startTime: '10:00', durationMinutes: 60, locationText: 'Kaupungintalo' },
    { id: 'tunnettu', title: 'Asiakas', date: TOMORROW, startTime: '14:00', durationMinutes: 60, placeId: 'p1' }
  ]);
  const intents = dailyLifeReminderPlan({ now: NOON }).intents;
  const unknown = intents.find(intent => intent.type === 'event_start');
  assert.ok(unknown, 'tuntematon matka-aika: muistutus alkuun');
  assert.equal(unknown.occurrenceId, `event:tuntematon:${TOMORROW}`);
  assert.equal(unknown.time, '09:50');
  assert.match(unknown.body, /^Alkaa klo 10:00\. Matka-aikaa ei ole tiedossa, joten lähtöaikaa ei laskettu\.$/);
  assert.equal(intents.filter(intent => intent.type === 'event_start').length, 1, 'tunnetulle matkalle ei alun muistutusta');
  assert.ok(intents.some(intent => intent.type === 'departure_leave_now' && intent.departureId === `event:tunnettu:${TOMORROW}`));
});

test('menon alun ennakko: oma asetus ja ohjaustyyli; puheena laitteelle ilman menon nimeä', () => {
  signIn();
  seed({ preferences: { taskLeadMinutes: 30 } });
  setCalendarEvents([{ id: 'soitto', title: 'Puhelu lääkärille', date: TOMORROW, startTime: '09:00', durationMinutes: 15 }]);
  assert.equal(dailyLifeReminderPlan({ now: NOON }).intents.find(intent => intent.type === 'event_start').time, '08:30');

  seed({ settings: { guidanceStyle: 'aktiivinen' } });
  assert.equal(dailyLifeReminderPlan({ now: NOON }).intents.find(intent => intent.type === 'event_start').time, '08:45',
    'aktiivinen tyyli pidentää ennakkoa kuten tehtävillä (10 -> 15 min)');

  seed({ settings: { speechEnabled: true, delivery: { preparation: DELIVERY.SPEECH } } });
  const { entries, localIntents } = desiredNativeEntries({ now: NOON, nativeSupported: true });
  const spoken = entries.find(entry => entry.id.startsWith('event_start:'));
  assert.ok(spoken, 'puhuva menon alku laitteelle');
  assert.equal(spoken.speech, 'Seuraava meno alkaa kello 9.00.');
  assert.equal(/lääkäri/i.test(spoken.speech), false, 'menon nimi ei kuulu ääneen');
  assert.equal(spoken.routeDestination, null, 'ei reittiä ilman paikkaa');
  assert.equal(localIntents.some(intent => intent.type === 'event_start'), false, 'ei kahdesti');
});

test('menon alku: ei muistutusta, kun muistutukset ovat pois, meno on koko päivän tai alku on jo mennyt', () => {
  signIn();
  seed({ preferences: { enabled: false } });
  setCalendarEvents([{ id: 'a', title: 'Meno', date: TOMORROW, startTime: '09:00', durationMinutes: 15 }]);
  assert.deepEqual([...dailyLifeReminderPlan({ now: NOON }).intents], []);

  seed();
  setCalendarEvents([
    { id: 'koko', title: 'Loma', date: TOMORROW, allDay: true },
    { id: 'mennyt', title: 'Aamupalaveri', date: TODAY, startTime: '09:00', durationMinutes: 30 },
    { id: 'pian', title: 'Pian', date: TODAY, startTime: '12:05', durationMinutes: 30 }
  ]);
  const starts = dailyLifeReminderPlan({ now: NOON }).intents.filter(intent => intent.type === 'event_start');
  assert.deepEqual(starts.map(intent => intent.occurrenceId), [],
    'koko päivän menolle ei alkua; mennyt ja jo ennakon sisällä oleva eivät tule enää');
});

test('herätyksen aamun katsaus ei kutsu paikattoman menon alkua lähtötavoitteeksi', async () => {
  const { plannedWakeAlarms } = await import('../src/app/alarmSync.js');
  signIn();
  seed({ settings: { alarm: { enabled: true, followPlan: true }, morningBriefEnabled: true } });
  setCalendarEvents([{ id: 'hl', title: 'Hammaslääkäri keskustassa', date: TOMORROW, startTime: '16:00', durationMinutes: 45 }]);
  const wake = plannedWakeAlarms({ now: NOON }).find(alarm => alarm.forDate === TOMORROW);
  assert.ok(wake && typeof wake.briefText === 'string', 'katsaus on käytössä');
  assert.doesNotMatch(wake.briefText, /[Ll]ähtötavoite/);
  assert.match(wake.briefText, /Ensimmäinen meno on Hammaslääkäri keskustassa kello 16\.00\./);
});
