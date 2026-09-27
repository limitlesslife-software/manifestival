// Herätysten ja puhuttujen muistutusten ajastus laitteelle (src/app/alarmSync.js)
// ja laitteen tapahtumien käsittely (src/app/alarmEvents.js).
//
// ManifestivalAlarm-liitännäinen korvataan muistissa elävällä
// kaksoiskappaleella (sama malli kuin platform-alarms.test.mjs). Kello
// annetaan aina parametrina; laitteen aikavyöhyke on ajokoneen oma, joten
// odotusarvot lasketaan samalla deviceOffsetMinutes-funktiolla.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { setUser, clearUser } from '../src/data/session.js';
import {
  resetState, getState, setProfile, setSavedPlaces, setCalendarEvents, setLifeSettings,
  setNotificationPreferences, setHabitPlans, setHabitEvents, setCommuteObservations
} from '../src/app/state.js';
import { clearAllCollections } from '../src/data/collectionsRepo.js';
import { resetAckStoreForTests, loadAckState, ackStoreKey } from '../src/data/alarmAckStore.js';
import * as capabilities from '../src/platform/capabilities.js';
import { ALARM_LIMITS, isAlarmId, resetAlarmsForTests, ALARMS_WEB_REASON } from '../src/platform/alarms.js';
import {
  activateAlarmSync, resetAlarmSync, syncAlarms, desiredNativeEntries, dailyLifeReminderPlan,
  dailyLifeLocalIntents, partitionReminders, nativeIdFor, intentMoment, alarmDayRolled,
  alarmRelevantChanged, NATIVE_ALARM_LIMIT, settledForTests, horizonDates
} from '../src/app/alarmSync.js';
import {
  activateAlarmEvents, resetAlarmEvents, consumeAlarmEvents, handleAlarmEvents, currentAckLog, ackTypesFor,
  targetFor, acknowledgeRecordedDepartures
} from '../src/app/alarmEvents.js';
import { isHandled } from '../src/domain/notificationAck.js';
import { deviceOffsetMinutes } from '../src/app/deviceTime.js';
import { epochToWallClock } from '../src/domain/wallClock.js';
import { helsinkiOffset } from './helpers/helsinkiOffset.mjs';
import { readCode } from './helpers/sources.mjs';

const USER_A = { id: 'aaaaaaaa-0000-4000-8000-00000000000a', email: 'a@example.com' };
const USER_B = { id: 'bbbbbbbb-0000-4000-8000-00000000000b', email: 'b@example.com' };
const TODAY = '2026-09-29'; // tiistai, ei kesäaikasiirtoa lähellä
const at = (y, m, d, hh, mm) => new Date(y, m - 1, d, hh, mm);
const NOON = at(2026, 9, 29, 12, 0);
const LEAVE_NOW_ID = `departure_leave_now:event:e1:${TODAY}:${TODAY}`;
const LEAVE_SOON_ID = `departure_leave_in_5:event:e1:${TODAY}:${TODAY}`;
const PREPARE_ID = `departure_prepare:event:e1:${TODAY}:${TODAY}`;

const ORIGINAL_CAPACITOR = globalThis.Capacitor;

/** Muistissa elävä ManifestivalAlarm (ja halutessa LocalNotifications). */
function fakeAlarmPlugin({ exact = true, hangSchedule = false, events = [] } = {}) {
  const calls = { schedule: [], cancelAll: 0, status: 0, consumeEvents: 0, order: [], openExactAlarmSettings: 0 };
  const listeners = [];
  let queue = [...events];
  let release = null;
  return {
    calls,
    listeners,
    push(event) { for (const entry of listeners) entry.fn(event); },
    enqueue(event) { queue.push(event); },
    release(result) { if (release) release(result); },
    async status() {
      calls.status++;
      return { ok: true, exact, fullScreen: true, notifications: true, tts: 'available', scheduled: 0, ringing: false, sdk: 35 };
    },
    async schedule(options) {
      calls.schedule.push(options.alarms);
      calls.order.push('schedule');
      if (hangSchedule) return new Promise(resolve => { release = resolve; });
      return { ok: true, scheduled: options.alarms.length, exact: true, inexact: [], dropped: [], rejected: [] };
    },
    async cancelAll() { calls.cancelAll++; calls.order.push('cancelAll'); return { ok: true, removed: 1 }; },
    async cancel() { return { ok: true, removed: 0 }; },
    async list() { return { ok: true, alarms: [] }; },
    async consumeEvents() {
      calls.consumeEvents++;
      const out = queue;
      queue = [];
      return { ok: true, events: out };
    },
    async openExactAlarmSettings() { calls.openExactAlarmSettings++; return { ok: true }; },
    async addListener(name, fn) {
      const entry = { name, fn };
      listeners.push(entry);
      return { remove: async () => { listeners.splice(listeners.indexOf(entry), 1); } };
    }
  };
}

function fakeLocalNotifications() {
  const calls = { schedule: [] };
  return {
    calls,
    async checkPermissions() { return { display: 'granted' }; },
    async requestPermissions() { return { display: 'granted' }; },
    async createChannel() {},
    async schedule(options) { calls.schedule.push(options.notifications); },
    async getPending() { return { notifications: [] }; },
    async cancel() {},
    async removeAllDeliveredNotifications() {}
  };
}

function installShell({ alarm = null, local = null } = {}) {
  const plugins = {};
  if (alarm) plugins.ManifestivalAlarm = alarm;
  if (local) plugins.LocalNotifications = local;
  globalThis.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: plugins };
}

/** Tavallinen päivä: hammaslääkäri klo 18, matka 40 min, valmistautuminen 15 min. */
function seedDay({ settings = {}, preferences = { enabled: true, maxPerDay: 20 } } = {}) {
  setProfile({ sleepTargetHours: 8, defaultWakeTime: '06:30', commuteMinutes: 30, routineMinutes: 45 }, true);
  setSavedPlaces([{
    id: 'p1', name: 'Hammaslääkäri', address: 'Mannerheimintie 1', travelMode: 'transit',
    usualTravelMinutes: 40, overheadMinutes: 0, preparationMinutes: 15
  }]);
  setLifeSettings([{
    id: 's1', arrivalBufferMinutes: 10, speechEnabled: true, delivery: { departure: 'speech' },
    alarm: { enabled: true }, ...settings
  }]);
  setNotificationPreferences(preferences);
  setCalendarEvents([{ id: 'e1', title: 'Hammaslääkäri', date: TODAY, startTime: '18:00', durationMinutes: 45, placeId: 'p1' }]);
}

function signIn(user = USER_A) {
  setUser(user);
  activateAlarmSync(user.id);
  activateAlarmEvents(user.id);
}

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

// ------------------------------------------------------------ laskenta

test('herätys ja puhuva lähtö laitteelle, muut tavallisiksi ilmoituksiksi; sama muistutus ei kahdesti', () => {
  signIn();
  seedDay();
  const { entries, targets, localIntents } = desiredNativeEntries({ now: NOON, nativeSupported: true });
  const ids = entries.map(entry => entry.id);

  assert.ok(ids.includes('wake:2026-09-30') && ids.includes('wake:2026-10-01'), 'huomisen ja ylihuomisen herätys');
  assert.equal(ids.includes('wake:2026-09-29'), false, 'tämän aamun herätys on mennyt');
  assert.deepEqual(ids.filter(id => id.startsWith('departure')).sort(), [LEAVE_SOON_ID, LEAVE_NOW_ID].sort());

  const leaveNow = entries.find(entry => entry.id === LEAVE_NOW_ID);
  assert.equal(leaveNow.kind, 'spoken');
  assert.equal(leaveNow.mode, 'speech');
  assert.equal(leaveNow.time, '17:10', 'lähtö 18.00 - etuaika 10 - matka 40');
  assert.match(leaveNow.speech, /\S/);
  assert.equal(leaveNow.routeDestination, 'Mannerheimintie 1');
  assert.equal(leaveNow.routeMode, 'transit');

  const localIds = localIntents.map(intent => intent.id);
  assert.ok(localIds.includes(PREPARE_ID), 'valmistautuminen (ääni) jää tavalliseksi ilmoitukseksi');
  assert.equal(localIds.some(id => ids.includes(id)), false, 'jako on yksiselitteinen');
  const target = targets.find(item => item.id === LEAVE_NOW_ID);
  assert.deepEqual([target.eventId, target.placeId, target.leaveTime, target.departureId],
    ['e1', 'p1', '17:10', `event:e1:${TODAY}`]);
});

test('voimistuva hälytys on laitteelle kriittinen; ilman puhelupaa se ei puhu', () => {
  signIn();
  seedDay({ settings: { speechEnabled: false, delivery: { departure: 'critical_escalation' } } });
  const { entries } = desiredNativeEntries({ now: NOON, nativeSupported: true });
  const leaveNow = entries.find(entry => entry.id === LEAVE_NOW_ID);
  assert.equal(leaveNow.kind, 'critical');
  assert.equal(leaveNow.speech, null);
  assert.equal(leaveNow.mode, 'alarm_sound');
  assert.ok(leaveNow.escalation.length > 0 && leaveNow.escalation.every(step => !/speech/.test(step.step)));
  // "Lähtö 5 min päästä" on toimintataso: voimistuva hälytys rajataan, joten se jää tavalliseksi ilmoitukseksi.
  assert.equal(entries.some(entry => entry.id === LEAVE_SOON_ID), false);
});

test('muistutukset pois päältä: vain herätys (oma valintansa) menee laitteelle', () => {
  signIn();
  seedDay({ preferences: { enabled: false } });
  const { entries, localIntents } = desiredNativeEntries({ now: NOON, nativeSupported: true });
  assert.ok(entries.length > 0);
  assert.ok(entries.every(entry => entry.kind === 'wake'));
  assert.deepEqual(localIntents, []);
  assert.deepEqual(dailyLifeReminderPlan({ now: NOON }).intents, []);
});

test('KRIITTINEN: herätykset ajastetaan viikoksi eteenpäin — perjantai-iltana maanantain herätys on laitteella', () => {
  // Bugi (uusintakatselmointi): horisontti oli 3 päivää, eikä laite ajasta
  // mitään itse. Viikonloppuna avaamaton sovellus jätti maanantain
  // herätyksen soimatta.
  signIn();
  seedDay({ preferences: { enabled: false } });
  const fridayEvening = at(2026, 10, 2, 20, 0); // pe 2.10.2026
  const { entries } = desiredNativeEntries({ now: fridayEvening, nativeSupported: true });
  const wakeDates = entries.filter(entry => entry.kind === 'wake').map(entry => entry.date).sort();
  assert.ok(wakeDates.includes('2026-10-05'), 'maanantai mukana: ' + wakeDates.join(', '));
  assert.ok(wakeDates.includes('2026-10-09'), 'seuraava perjantai mukana (tänään + 7)');
  assert.ok(wakeDates.length <= 8 && wakeDates.length >= 7, String(wakeDates.length));
  // Muistutukset pysyvät lyhyellä horisontilla (3 päivää).
  assert.ok(entries.filter(entry => entry.kind !== 'wake').every(entry => entry.date <= '2026-10-04'));
});

test('herätys pois (oletus): laitteelle ei herätystä', () => {
  signIn();
  seedDay({ settings: { alarm: { enabled: false } } });
  const { entries } = desiredNativeEntries({ now: NOON, nativeSupported: true });
  assert.equal(entries.some(entry => entry.kind === 'wake'), false);
});

test('nukkumaanmenosta muistutetaan vain, kun käyttäjä on kertonut rytminsä (arjen asetukset tai oma herätysaika)', () => {
  signIn();
  seedDay();
  const types = () => dailyLifeReminderPlan({ now: NOON }).intents.map(intent => intent.type);
  assert.ok(types().includes('bedtime') && types().includes('wind_down'));
  // Profiiliin itse asetettu herätysaika riittää (onboarding kysyy sen).
  setLifeSettings([]);
  assert.ok(types().includes('bedtime'), 'oma herätysaika profiilissa kertoo rytmin');
  // Ei profiilia eikä asetuksia: pelkillä oletuksilla ei iltamuistutuksia.
  setProfile({}, false);
  assert.equal(types().includes('bedtime'), false, 'pelkillä oletuksilla ei iltamuistutuksia');
  assert.equal(types().includes('wind_down'), false);
});

test('ateriarytmin lisäravinne, vesitauko ja iltaraja omina muistutuksinaan oikealla sanamuodolla', () => {
  signIn();
  seedDay({ settings: { mealRhythm: {
    meals: [],
    supplements: [{ id: 'dvit', name: 'D-vitamiini', time: '14:00' }],
    waterEveryMinutes: 120, waterFrom: '13:00', waterTo: '17:00',
    lateEatingCutoff: '20:00'
  } } });
  const intents = dailyLifeReminderPlan({ now: NOON }).intents
    .filter(intent => intent.type === 'meal' && intent.date === TODAY);
  const byKind = kind => intents.filter(intent => intent.mealKind === kind);
  assert.equal(byKind('supplement').length, 1);
  assert.equal(byKind('supplement')[0].title, 'Lisäravinne');
  assert.equal(/D-vitamiini/.test(JSON.stringify(byKind('supplement')[0])), false, 'nimi ei näy lukitusnäytöllä');
  assert.ok(byKind('water').length >= 1 && byKind('water').every(intent => intent.title === 'Vesitauko'));
  assert.equal(byKind('late_cutoff')[0].time, '20:00');
  assert.equal(intents.some(intent => /Ruoka-aika/.test(intent.body)), false, 'ei väärää sanaa');
});

test('ateriat ja tapojen seuraava suunniteltu aika tulevat mukaan; tavan otsikko on neutraali', () => {
  signIn();
  seedDay({ settings: { mealRhythm: { meals: [{ id: 'lounas', name: 'Lounas', time: '13:30', prepMinutes: 20 }] } } });
  setHabitPlans([{ id: 'h1', kind: 'nicotine', name: 'Nuuska', minIntervalMinutes: 120, active: true, reminderDelivery: 'vibrate' }]);
  setHabitEvents([{ id: 'x1', planId: 'h1', action: 'use', occurredAt: at(2026, 9, 29, 11, 0).toISOString() }]);
  const intents = dailyLifeReminderPlan({ now: NOON }).intents;
  const meal = intents.find(intent => intent.id === `meal:lounas:${TODAY}`);
  assert.equal(meal.time, '13:10', 'valmistus 20 min ennen ateriaa');
  const habit = intents.find(intent => intent.type === 'habit');
  assert.equal(habit.time, '13:00');
  assert.equal(habit.title, 'Tapojen muutos');
  assert.equal(/Nuuska/.test(JSON.stringify(habit)), false, 'tavan nimi ei näy lukitusnäytöllä');
  assert.equal(habit.delivery, 'vibrate', 'suunnitelman oma muistutustapa, kun asetuksissa ei ole valintaa');
});

test('menneet muistutukset eivät vie päivärajaa illan muistutuksilta', () => {
  signIn();
  seedDay({ preferences: { enabled: true, maxPerDay: 2 } });
  const evening = at(2026, 9, 29, 16, 0);
  const ids = dailyLifeReminderPlan({ now: evening }).intents.map(intent => intent.id);
  assert.ok(ids.includes(LEAVE_NOW_ID), 'kriittinen "lähde nyt" säilyy aina');
});

test('laskenta on deterministinen eikä muuta tilaa', () => {
  signIn();
  seedDay();
  const before = JSON.stringify(getState().calendarEvents);
  const first = desiredNativeEntries({ now: NOON, nativeSupported: true });
  const second = desiredNativeEntries({ now: NOON, nativeSupported: true });
  assert.deepEqual(second, first);
  assert.equal(JSON.stringify(getState().calendarEvents), before);
});

test('jako: laitteen raja täyttyy -> loput tavallisiksi ilmoituksiksi (ei katoa)', () => {
  const intents = Array.from({ length: 5 }, (_, index) => ({
    id: `x${index}`, level: 4, date: TODAY, time: `1${index}:00`, delivery: 'speech'
  }));
  const { native, local } = partitionReminders(intents, { nativeSupported: true, capacity: 3 });
  assert.equal(native.length, 3);
  assert.equal(local.length, 2);
  const web = partitionReminders(intents, { nativeSupported: false });
  assert.deepEqual([web.native.length, web.local.length], [0, 5], 'ilman liitännäistä kaikki tavallisina');
  assert.equal(NATIVE_ALARM_LIMIT, ALARM_LIMITS.maxAlarms);
});

test('laitteen tunniste: kelvollinen säilyy, muu tiivistetään vakaasti kelvolliseksi', () => {
  assert.equal(nativeIdFor(LEAVE_NOW_ID), LEAVE_NOW_ID);
  const weird = nativeIdFor('meal:aamupala ä:2026-09-29');
  assert.ok(isAlarmId(weird));
  assert.equal(nativeIdFor('meal:aamupala ä:2026-09-29'), weird);
  assert.ok(isAlarmId(nativeIdFor('x'.repeat(300))));
});

test('KESÄAIKA: ankkurillinen muistutus lasketaan todellisina minuutteina', () => {
  // Kevään yö: klo 03.00 ei ole olemassa. Lähtö 04.30, muistutus 90 todellista minuuttia ennen.
  const moment = intentMoment({ date: '2026-03-29', time: '03:00', anchor: { date: '2026-03-29', time: '04:30', offsetMinutes: -90 } }, helsinkiOffset);
  assert.deepEqual([moment.date, moment.time], ['2026-03-29', '02:00']);
  const plain = intentMoment({ date: '2026-09-29', time: '17:10' }, helsinkiOffset);
  assert.equal(plain.time, '17:10');
});

test('päivän vaihto: horisontti siirtyy ja ajastus pyydetään kerran', () => {
  activateAlarmSync(USER_A.id);
  assert.equal(alarmDayRolled(at(2026, 9, 29, 23, 59)), false, 'ensimmäinen tikki vain muistaa päivän');
  assert.equal(alarmDayRolled(at(2026, 9, 29, 23, 59)), false);
  assert.equal(alarmDayRolled(at(2026, 9, 30, 0, 0)), true, 'keskiyön jälkeen uusi päivä');
  assert.equal(alarmDayRolled(at(2026, 9, 30, 0, 1)), false, 'ei toistu');
  assert.deepEqual(horizonDates('2026-09-30'), ['2026-09-30', '2026-10-01', '2026-10-02']);

  signIn();
  seedDay();
  const later = desiredNativeEntries({ now: at(2026, 9, 30, 0, 5), nativeSupported: true }).entries.map(e => e.id);
  assert.ok(later.includes('wake:2026-10-02'), 'uusi päivä tuli ikkunaan');
});

test('tilamuutoksen vahti: vain herätyksiin vaikuttavat kokoelmat laukaisevat', () => {
  signIn();
  seedDay();
  alarmRelevantChanged(getState());
  assert.equal(alarmRelevantChanged(getState()), false);
  setCalendarEvents([]);
  assert.equal(alarmRelevantChanged(getState()), true);
  assert.equal(alarmRelevantChanged(getState()), false);
});

// ------------------------------------------------------------ ajastus

test('selain: ei ajasteta mitään eikä teeskennellä, syy kerrotaan', async () => {
  signIn();
  seedDay();
  const result = await syncAlarms({ now: NOON });
  assert.equal(result.supported, false);
  assert.equal(result.scheduled, 0);
  assert.equal(result.reason, ALARMS_WEB_REASON);
  // Puhuva lähtömuistutus tulee silti tavallisena ilmoituksena, jos alusta pystyy.
  assert.ok(dailyLifeLocalIntents({ now: NOON }).some(intent => intent.id === LEAVE_NOW_ID));
});

test('Android: koko joukko laitteelle, laite hyväksyy tarkistetut merkinnät', async () => {
  const plugin = fakeAlarmPlugin();
  installShell({ alarm: plugin });
  signIn();
  seedDay();
  const result = await syncAlarms({ now: NOON });
  assert.equal(result.ok, true);
  assert.equal(plugin.calls.schedule.length, 1);
  const sent = plugin.calls.schedule[0];
  assert.ok(sent.some(entry => entry.id === LEAVE_NOW_ID));
  assert.ok(sent.some(entry => entry.kind === 'wake'));
  assert.equal(plugin.calls.openExactAlarmSettings, 0, 'asetusnäkymää ei avata ajastuksesta');
  // Ajastetut kohteet muistetaan laitteella tapahtumien tulkintaa varten.
  const stored = loadAckState(USER_A.id);
  assert.ok(stored.targets.some(target => target.id === LEAVE_NOW_ID && target.placeId === 'p1'));
  assert.equal(/Hammaslääkäri|Mannerheimintie/.test(globalThis.localStorage?.getItem?.(ackStoreKey(USER_A.id)) || ''), false);
});

test('KILPAILU: kaksoispaluu (kaksi pyyntöä yhtä aikaa) = yksi ajastus', async () => {
  const plugin = fakeAlarmPlugin();
  installShell({ alarm: plugin });
  signIn();
  seedDay();
  const [first, second] = await Promise.all([syncAlarms({ now: NOON }), syncAlarms({ now: NOON })]);
  assert.equal(plugin.calls.schedule.length, 1);
  assert.deepEqual(second, first);
});

test('KILPAILU: uloskirjautuminen kesken ajastuksen -> peruutus tulee ajastuksen PERÄÄN', async () => {
  const plugin = fakeAlarmPlugin({ hangSchedule: true });
  installShell({ alarm: plugin });
  signIn();
  seedDay();
  const pending = syncAlarms({ now: NOON });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(plugin.calls.schedule.length, 1, 'ajastus on laitteella kesken');

  clearUser();
  const cancelled = resetAlarmSync();
  resetAlarmEvents();
  resetState();
  assert.equal(plugin.calls.cancelAll, 0, 'peruutus odottaa vuoroaan eikä ohita ajastusta');

  plugin.release({ ok: true, scheduled: 5 });
  const result = await pending;
  await cancelled;
  assert.equal(result.ok, false, 'istunto päättyi: ei raportoida onnistumista');
  assert.deepEqual(plugin.calls.order, ['schedule', 'cancelAll'], 'laitteelle ei jää uloskirjautuneen joukkoa');
});

test('KILPAILU: istunto vaihtuu jonossa odottavan ajastuksen aikana -> edellisen käyttäjän joukkoa ei lähetetä', async () => {
  const plugin = fakeAlarmPlugin({ hangSchedule: true });
  installShell({ alarm: plugin });
  signIn(USER_A);
  seedDay();
  const first = syncAlarms({ now: NOON });
  await new Promise(resolve => setImmediate(resolve));
  // Toinen pyyntö jonoon ennen vaihtoa.
  const queued = syncAlarms({ now: NOON });

  clearUser();
  resetAlarmSync();
  resetState();
  signIn(USER_B);
  setCalendarEvents([{ id: 'b1', title: 'B:n meno', date: TODAY, startTime: '19:00' }]);

  plugin.release({ ok: true, scheduled: 1 });
  await first;
  const skipped = await queued;
  assert.equal(skipped.reason, 'Istunto päättyi');
  assert.equal(plugin.calls.schedule.length, 1, 'A:n jonottanut ajastus ei lähtenyt B:n istunnossa');
});

test('tilin poisto ja uloskirjautuminen: laitteen herätykset perutaan (cancelDeviceNotifications)', async () => {
  const plugin = fakeAlarmPlugin();
  installShell({ alarm: plugin });
  signIn();
  const { cancelDeviceNotifications } = await import('../src/app/notifications.js');
  const result = await cancelDeviceNotifications({ timeoutMs: 1000 });
  assert.equal(result.timedOut, false);
  assert.equal(plugin.calls.cancelAll, 1);
  // Peruutuksen jälkeen ajastus ei enää käynnisty tälle istunnolle.
  const after = await syncAlarms({ now: NOON });
  assert.equal(after.ok, false);
  assert.equal(plugin.calls.schedule.length, 0);
});

test('tavalliset ilmoitukset: tarkka hälytys vain, kun laite on sen jo sallinut (ei asetusnäkymää)', async () => {
  for (const exact of [true, false]) {
    const alarm = fakeAlarmPlugin({ exact });
    const local = fakeLocalNotifications();
    installShell({ alarm, local });
    signIn();
    seedDay();
    const { refreshNotificationPermission, syncNotifications } = await import('../src/app/notifications.js');
    await refreshNotificationPermission();
    const result = await syncNotifications();
    assert.equal(result.ok, true);
    const sent = local.calls.schedule.flat();
    assert.ok(sent.length > 0);
    assert.ok(sent.every(item => item.isExactNotification === exact), `exact=${exact}`);
    // Puhuva lähtö meni herätysliitännäiselle, ei tavallisiksi ilmoituksiksi.
    assert.equal(sent.some(item => item.extra && item.extra.intentId === LEAVE_NOW_ID), false);
    assert.ok(sent.some(item => item.extra && item.extra.intentId === PREPARE_ID));
    assert.equal(alarm.calls.openExactAlarmSettings, 0);
    await resetAlarmSync();
    resetAlarmEvents();
    clearUser();
    resetState();
  }
});

// ------------------------------------------------------------ laitteen tapahtumat

const event = (seq, type, id, atMs, extra = {}) => ({ seq, type, id, kind: 'spoken', atMs, ...extra });

test('kuitattu lähtömuistutus ei palaa seuraavassa ajastuksessa', async () => {
  const plugin = fakeAlarmPlugin();
  installShell({ alarm: plugin });
  signIn();
  seedDay();
  await syncAlarms({ now: NOON });
  plugin.enqueue(event(1, 'acknowledged', LEAVE_SOON_ID, at(2026, 9, 29, 17, 5).getTime()));
  const consumed = await consumeAlarmEvents();
  assert.equal(consumed.recorded, 1);
  assert.equal(isHandled(currentAckLog(), LEAVE_SOON_ID), true);
  const ids = desiredNativeEntries({ now: at(2026, 9, 29, 17, 5), nativeSupported: true }).entries.map(e => e.id);
  assert.equal(ids.includes(LEAVE_SOON_ID), false);
  assert.ok(ids.includes(LEAVE_NOW_ID), 'kuittaus koskee vain sitä muistutusta');
});

test('"Lähdin": koko lähtöketju kuitataan ja matka kirjataan kerran (kaksoispaluu ei tuplaa)', async () => {
  const plugin = fakeAlarmPlugin();
  installShell({ alarm: plugin });
  signIn();
  seedDay();
  await syncAlarms({ now: NOON });
  const departedAt = at(2026, 9, 29, 17, 7).getTime();
  const departed = event(7, 'departed', LEAVE_SOON_ID, departedAt);
  plugin.enqueue(departed);
  await Promise.all([consumeAlarmEvents(), consumeAlarmEvents()]);
  // Sama tapahtuma elävänä ja jonosta: alusta suodattaa (seq), ja kirjaus on idempotentti.
  plugin.push(departed);
  await handleAlarmEvents([departed]);

  for (const key of [PREPARE_ID, LEAVE_SOON_ID, LEAVE_NOW_ID]) assert.equal(isHandled(currentAckLog(), key), true, key);
  const observations = getState().commuteObservations;
  assert.equal(observations.length, 1, 'yksi matkahavainto');
  assert.equal(observations[0].source, 'departure_ack');
  assert.equal(observations[0].placeId, 'p1');
  assert.equal(observations[0].eventId, 'e1');
  assert.equal(observations[0].plannedDeparture, '17:10');
  assert.equal(observations[0].actualDeparture, '17:07');
  const ids = desiredNativeEntries({ now: at(2026, 9, 29, 17, 8), nativeSupported: true }).entries.map(e => e.id);
  assert.equal(ids.some(id => id.startsWith('departure')), false, 'lähtenyt ei saa "lähde nyt" -muistutusta');
});

test('sovelluksessa kirjattu lähtö ("Lähdin nyt") kuittaa laitteen lähtöketjun; vanha havainto ei', async () => {
  installShell({ alarm: fakeAlarmPlugin() });
  signIn();
  seedDay();
  const nowMs = at(2026, 9, 29, 17, 2).getTime();
  setCommuteObservations([
    { id: 'o-old', placeId: 'p1', eventId: 'e1', observedOn: '2026-09-22', actualDeparture: '17:10', source: 'user_confirmed' },
    { id: 'o-now', placeId: 'p1', eventId: 'e1', observedOn: TODAY, actualDeparture: '17:02', source: 'user_confirmed' }
  ]);
  const count = acknowledgeRecordedDepartures(getState().commuteObservations, { nowMs });
  assert.equal(count, 3, 'valmistaudu, 5 min ja nyt');
  assert.equal(acknowledgeRecordedDepartures(getState().commuteObservations, { nowMs }), 0, 'toinen kerta ei kirjaa uudelleen');
  assert.equal(isHandled(currentAckLog(), 'departure_leave_now:event:e1:2026-09-22:2026-09-22'), false);
  const ids = desiredNativeEntries({ now: new Date(nowMs), nativeSupported: true }).entries.map(e => e.id);
  assert.equal(ids.includes(LEAVE_NOW_ID), false);
  assert.equal(ids.includes(LEAVE_SOON_ID), false);
});

test('"Lähdin" ilman tallennettua paikkaa: ketju kuitataan, havaintoa ei keksitä', async () => {
  installShell({ alarm: fakeAlarmPlugin() });
  signIn();
  seedDay();
  setCalendarEvents([{ id: 'e1', title: 'Palaveri', date: TODAY, startTime: '18:00', locationText: 'Kamppi', travelMinutes: 20 }]);
  await handleAlarmEvents([event(3, 'departed', LEAVE_NOW_ID, at(2026, 9, 29, 17, 30).getTime())]);
  assert.equal(isHandled(currentAckLog(), LEAVE_NOW_ID), true);
  assert.deepEqual(getState().commuteObservations, []);
});

test('torkku: torkun lopussa yksi korvaava muistutus, alkuperäinen pois', async () => {
  installShell({ alarm: fakeAlarmPlugin() });
  signIn();
  seedDay();
  const snoozedAt = at(2026, 9, 29, 17, 5).getTime();
  const untilMs = snoozedAt + 5 * 60000 + 20000; // 17.10.20 -> pyöristetään ylöspäin 17.11
  await handleAlarmEvents([event(4, 'snoozed', LEAVE_SOON_ID, snoozedAt, { untilMs })]);
  const state = ackTypesFor(LEAVE_SOON_ID);
  const expected = epochToWallClock(Math.ceil(untilMs / 60000) * 60000, deviceOffsetMinutes);
  assert.deepEqual(state.snoozedUntilLocal, { date: expected.date, time: expected.time });

  const entries = desiredNativeEntries({ now: at(2026, 9, 29, 17, 6), nativeSupported: true }).entries;
  const ids = entries.map(e => e.id);
  assert.equal(ids.includes(LEAVE_SOON_ID), false);
  const replacement = entries.find(e => e.id === `${LEAVE_SOON_ID}:torkku`);
  assert.ok(replacement, 'korvaava muistutus');
  assert.equal(replacement.time, expected.time);
  // Korvaajan tapahtuma löytää saman kuittausavaimen.
  assert.equal(targetFor(`${LEAVE_SOON_ID}:torkku`).ackKey, LEAVE_SOON_ID);
});

test('herätyksen kuittaus: kuitattu herätys ei palaa, hylätty ei myöskään', async () => {
  installShell({ alarm: fakeAlarmPlugin() });
  signIn();
  seedDay();
  await handleAlarmEvents([{ seq: 9, type: 'dismissed', id: 'wake:2026-09-30', kind: 'wake', atMs: NOON.getTime() }]);
  const ids = desiredNativeEntries({ now: NOON, nativeSupported: true }).entries.map(e => e.id);
  assert.equal(ids.includes('wake:2026-09-30'), false);
  assert.ok(ids.includes('wake:2026-10-01'));
});

test('KILPAILU: laitteen jonon luku ja käyttäjän vaihto -> tapahtumia ei kirjata uudelle käyttäjälle', async () => {
  const plugin = fakeAlarmPlugin();
  let releaseConsume;
  plugin.consumeEvents = () => new Promise(resolve => { releaseConsume = resolve; });
  installShell({ alarm: plugin });
  signIn(USER_A);
  seedDay();
  const pending = consumeAlarmEvents();
  await new Promise(resolve => setImmediate(resolve));
  clearUser();
  resetAlarmEvents();
  resetState();
  signIn(USER_B);
  releaseConsume({ ok: true, events: [event(11, 'acknowledged', LEAVE_NOW_ID, NOON.getTime())] });
  const result = await pending;
  assert.equal(result.recorded, 0);
  assert.equal(isHandled(currentAckLog(), LEAVE_NOW_ID), false, 'A:n kuittaus ei päätynyt B:n lokiin');
});

test('uloskirjautuminen tyhjentää kuittausmuistin laitteelta; tilin poisto poistaa vain poistetun käyttäjän avaimen', async () => {
  const data = new Map();
  globalThis.localStorage = {
    getItem: key => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => { data.set(key, String(value)); },
    removeItem: key => { data.delete(key); },
    key: index => [...data.keys()][index] ?? null,
    get length() { return data.size; }
  };
  try {
    installShell({ alarm: fakeAlarmPlugin() });
    signIn();
    seedDay();
    await handleAlarmEvents([event(12, 'acknowledged', LEAVE_NOW_ID, NOON.getTime())]);
    assert.ok(data.has(ackStoreKey(USER_A.id)));
    data.set(ackStoreKey(USER_B.id), '{"v":1,"log":{"entries":[]},"targets":[]}');

    const { purgeDeviceDataForUser } = await import('../src/data/deviceData.js');
    purgeDeviceDataForUser(USER_A.id);
    assert.equal(data.has(ackStoreKey(USER_A.id)), false);
    assert.equal(data.has(ackStoreKey(USER_B.id)), true);

    resetAlarmEvents();
    assert.equal(data.has(ackStoreKey(USER_B.id)), false, 'uloskirjautuminen tyhjentää kaikki kuittausmuistit');
  } finally {
    delete globalThis.localStorage;
  }
});

test('main.js: kytkennät ovat paikallaan ja uloskirjautuminen perii laitteen herätykset', () => {
  const main = readCode('src/app/main.js');
  const signedIn = main.slice(main.indexOf('async function onSignedIn'), main.indexOf('function onSignedOut'));
  assert.match(signedIn, /startDailyLifeDevice\(/);
  assert.match(signedIn, /refreshDailyLifeDevice\(\)\.catch\(/);
  const signedOut = main.slice(main.indexOf('function onSignedOut'), main.indexOf('async function start'));
  assert.match(signedOut, /stopDailyLifeDevice\(\)/);
  const helper = main.slice(main.indexOf('function stopDailyLifeDevice'));
  assert.match(helper.slice(0, 400), /resetAlarmSync\(\)/);
  assert.match(main, /subscribe\(watchDailyLifeChanges\)/);
  assert.match(main, /if \(alarmDayRolled\(\)\) requestDailyLifeResync\(\)/);
  const refresh = main.slice(main.indexOf('async function refreshDailyLifeDevice'));
  assert.ok(refresh.indexOf('consumeAlarmEvents') < refresh.indexOf('syncAlarms'), 'kuittaukset ennen ajastusta');
  // JS-ajastin ei ole herätyksen lähde: ei setIntervalia eikä hetkeen ajastettua setTimeoutia.
  const sync = readCode('src/app/alarmSync.js');
  assert.equal(/setInterval/.test(sync), false);
  assert.equal((sync.match(/setTimeout\(/g) || []).length, 1, 'vain 2 s viive, joka kokoaa tilamuutokset');
});
