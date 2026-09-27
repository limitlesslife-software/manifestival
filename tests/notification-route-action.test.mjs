// "Avaa reitti" tavallisesta lähtöilmoituksesta (paketin §14 ja §36).
//
// Oletusasetuksilla "Lähde nyt" tulee äänimerkkinä tavallisena
// ilmoituksena (Capacitor Local Notifications), ei herätysliitännäisen
// kautta. Aiemmin siinä ei ollut reittipainiketta lainkaan. Nyt ilmoitus
// kantaa kohteen TEKSTIN, liitännäiselle rekisteröidään toimintotyyppi
// "Avaa reitti", ja painalluksesta sovellus kokoaa reitin uudelleen
// navigationLink.js:llä ja avaa sen alustan reittitoiminnolla. Linkkiä ei
// koskaan oteta ilmoituksen tiedoista.
//
// Liitännäiset ovat muistissa eläviä kaksoiskappaleita; laitetta ei käytetä.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { setUser, clearUser } from '../src/data/session.js';
import {
  resetState, setProfile, setSavedPlaces, setCalendarEvents, setLifeSettings, setNotificationPreferences
} from '../src/app/state.js';
import { clearAllCollections } from '../src/data/collectionsRepo.js';
import { resetAckStoreForTests } from '../src/data/alarmAckStore.js';
import * as capabilities from '../src/platform/capabilities.js';
import * as native from '../src/platform/nativeNotifications.js';
import { notifications as platformNotifications } from '../src/platform/index.js';
import { resetAlarmsForTests } from '../src/platform/alarms.js';
import { activateAlarmSync, resetAlarmSync, settledForTests, dailyLifeLocalIntents } from '../src/app/alarmSync.js';
import { activateAlarmEvents, resetAlarmEvents, ackTypesFor } from '../src/app/alarmEvents.js';
import {
  openRouteFromNotification, startNotificationActions, stopNotificationActions
} from '../src/app/notifications.js';
import { readCode } from './helpers/sources.mjs';

const USER = { id: 'aaaaaaaa-0000-4000-8000-0000000000d1', email: 'r@example.com' };
const TODAY = '2026-09-29';
const NOON = new Date(2026, 8, 29, 12, 0);
const LEAVE_NOW_ID = `departure_leave_now:event:e1:${TODAY}:${TODAY}`;
const ORIGINAL_CAPACITOR = globalThis.Capacitor;

/** Local Notifications -liitännäinen toimintotyyppeineen ja kuuntelijoineen. */
function fakeLocalNotifications() {
  const calls = { schedule: [], registerActionTypes: [] };
  const listeners = [];
  return {
    calls,
    listeners,
    fire(name, event) { for (const entry of [...listeners]) if (entry.name === name) entry.fn(event); },
    async checkPermissions() { return { display: 'granted' }; },
    async requestPermissions() { return { display: 'granted' }; },
    async createChannel() {},
    async registerActionTypes(options) { calls.registerActionTypes.push(options); },
    async schedule(options) { calls.schedule.push(options.notifications); return { notifications: [] }; },
    async getPending() { return { notifications: [] }; },
    async cancel() {},
    async removeAllDeliveredNotifications() {},
    async addListener(name, fn) {
      const entry = { name, fn };
      listeners.push(entry);
      return { remove: async () => { const index = listeners.indexOf(entry); if (index >= 0) listeners.splice(index, 1); } };
    }
  };
}

/** ManifestivalAlarm: vain reitin avaus kiinnostaa tässä. */
function fakeAlarmPlugin({ opened = true } = {}) {
  const calls = { openNavigation: [] };
  return {
    calls,
    async schedule() { return { ok: true, scheduled: 0, exact: true, inexact: [], dropped: [], rejected: [] }; },
    async status() { return { ok: true, exact: true, fullScreen: true, notifications: true, tts: 'available', scheduled: 0 }; },
    async cancelAll() { return { ok: true, removed: 0 }; },
    async consumeEvents() { return { ok: true, events: [] }; },
    async openNavigation(options) {
      calls.openNavigation.push(options);
      return opened ? { ok: true, target: 'google_maps' } : { ok: false, code: 'no_app' };
    },
    async addListener() { return { remove: async () => {} }; }
  };
}

function installShell({ local = null, alarm = null } = {}) {
  const plugins = {};
  if (local) plugins.LocalNotifications = local;
  if (alarm) plugins.ManifestivalAlarm = alarm;
  globalThis.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: plugins };
}

const leaveNow = (extra = {}) => ({
  id: LEAVE_NOW_ID, ackKey: LEAVE_NOW_ID, type: 'departure_leave_now', level: 4,
  date: TODAY, time: '17:10', title: 'Nyt on lähdön aika', body: 'Hammaslääkäri: lähde nyt.', ...extra
});

const routeTap = (extra, actionId = native.ROUTE_ACTION_ID) => ({ actionId, notification: { id: 1, extra } });

beforeEach(() => {
  delete globalThis.Capacitor;
  clearAllCollections();
  resetState();
  clearUser();
  resetAlarmsForTests();
  resetAckStoreForTests();
  native.resetActionTypesForTests();
  capabilities.resetNativePermission();
  capabilities.resetAlarmAccessState();
});

afterEach(async () => {
  stopNotificationActions();
  await resetAlarmSync();
  resetAlarmEvents();
  await settledForTests();
  if (ORIGINAL_CAPACITOR === undefined) delete globalThis.Capacitor;
  else globalThis.Capacitor = ORIGINAL_CAPACITOR;
  clearUser();
  resetState();
});

// ------------------------------------------------------------ alusta

test('lähtöilmoitus saa toimintotyypin "Avaa reitti"; kohde kulkee tekstinä, ei linkkinä', async () => {
  const plugin = fakeLocalNotifications();
  installShell({ local: plugin });
  await native.refreshPermission();
  const result = await native.schedule([
    leaveNow({ routeDestination: '  Mannerheimintie 1\n\tHelsinki ', routeMode: 'transit' }),
    { id: 'meal:m1:' + TODAY, type: 'meal', level: 2, date: TODAY, time: '17:30', title: 'Ateria', body: '' }
  ], NOON);
  assert.equal(result.ok, true);
  assert.deepEqual(plugin.calls.registerActionTypes, [{
    types: [{ id: native.ROUTE_ACTION_TYPE_ID, actions: [{ id: native.ROUTE_ACTION_ID, title: 'Avaa reitti', foreground: true }] }]
  }]);
  const [departure, meal] = plugin.calls.schedule[0];
  assert.equal(departure.actionTypeId, native.ROUTE_ACTION_TYPE_ID);
  assert.equal(departure.extra.routeDestination, 'Mannerheimintie 1 Helsinki', 'ohjausmerkit pois');
  assert.equal(departure.extra.routeMode, 'transit');
  assert.equal(Object.values(departure.extra).some(value => /:\/\//.test(String(value))), false, 'ei linkkiä');
  assert.equal(meal.actionTypeId, undefined, 'ilman kohdetta ei painiketta');
  assert.deepEqual(Object.keys(meal.extra).sort(), ['intentId', 'type']);

  await native.schedule([leaveNow({ routeDestination: 'Koti' })], NOON);
  assert.equal(plugin.calls.registerActionTypes.length, 1, 'toimintotyypit rekisteröidään kerran');
});

test('kelvoton kulkutapa ja ylipitkä kohde rajataan; tyhjä kohde ei tuota painiketta', async () => {
  const plugin = fakeLocalNotifications();
  installShell({ local: plugin });
  await native.refreshPermission();
  await native.schedule([
    leaveNow({ routeDestination: 'x'.repeat(500), routeMode: 'constructor()' }),
    leaveNow({ id: 'toinen', routeDestination: ' \n\u0000 ' })
  ], NOON);
  const [long, empty] = plugin.calls.schedule[0];
  assert.equal(long.extra.routeDestination.length, 200);
  assert.equal(long.extra.routeMode, undefined);
  assert.equal(empty.actionTypeId, undefined);
  assert.equal(empty.extra.routeDestination, undefined);
});

test('painalluksen tiedot: vain "Avaa reitti" ja kelvollinen kohde; napautus ei avaa reittiä', () => {
  const payload = native.routeActionPayload(routeTap({
    intentId: LEAVE_NOW_ID, type: 'departure_leave_now', ackKey: LEAVE_NOW_ID,
    routeDestination: 'Mannerheimintie 1', routeMode: 'walking'
  }));
  assert.deepEqual({ ...payload }, {
    destination: 'Mannerheimintie 1', mode: 'walking', intentId: LEAVE_NOW_ID,
    type: 'departure_leave_now', ackKey: LEAVE_NOW_ID
  });
  assert.equal(native.routeActionPayload(routeTap({ routeDestination: 'Koti' }, 'tap')), null);
  assert.equal(native.routeActionPayload(routeTap({ intentId: 'x' })), null);
  for (const bad of [null, 5, 'x', {}, { actionId: native.ROUTE_ACTION_ID }, routeTap(null)]) {
    assert.equal(native.routeActionPayload(bad), null);
  }
});

test('kuuntelija: painallus välittyy, lopetus poistaa kuuntelijan; selaimessa ei tee mitään', async () => {
  const plugin = fakeLocalNotifications();
  installShell({ local: plugin });
  const received = [];
  const stop = platformNotifications.onRouteAction(payload => received.push(payload));
  await Promise.resolve();
  assert.equal(plugin.listeners.length, 1);
  assert.equal(plugin.listeners[0].name, native.ACTION_PERFORMED_EVENT);
  plugin.fire(native.ACTION_PERFORMED_EVENT, routeTap({ routeDestination: 'Koti', intentId: 'a' }));
  plugin.fire(native.ACTION_PERFORMED_EVENT, routeTap({ routeDestination: 'Koti' }, 'tap'));
  assert.deepEqual(received.map(item => item.destination), ['Koti']);
  stop();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(plugin.listeners.length, 0);

  delete globalThis.Capacitor;
  const noop = platformNotifications.onRouteAction(() => assert.fail('selaimessa ei painalluksia'));
  assert.equal(typeof noop, 'function');
  assert.doesNotThrow(() => noop());
});

// ------------------------------------------------------------ sovellus

function seedDeparture() {
  setProfile({ sleepTargetHours: 8, defaultWakeTime: '06:30' }, true);
  setSavedPlaces([{
    id: 'p1', name: 'Hammaslääkäri', address: 'Mannerheimintie 1', travelMode: 'transit',
    usualTravelMinutes: 40, overheadMinutes: 0, preparationMinutes: 15
  }]);
  // Oletustoimitus: Lähtö = Ääni, puhe pois -> tavallinen ilmoitus.
  setLifeSettings([{ id: 's1', arrivalBufferMinutes: 10 }]);
  setNotificationPreferences({ enabled: true, maxPerDay: 20 });
  setCalendarEvents([{ id: 'e1', title: 'Hammaslääkäri', date: TODAY, startTime: '18:00', durationMinutes: 45, placeId: 'p1' }]);
}

test('oletusasetuksilla "Lähde nyt" on tavallinen ilmoitus, jossa on "Avaa reitti"', async () => {
  const local = fakeLocalNotifications();
  installShell({ local, alarm: fakeAlarmPlugin() });
  setUser(USER);
  activateAlarmSync(USER.id);
  seedDeparture();
  const intents = dailyLifeLocalIntents({ now: NOON });
  const now = intents.find(intent => intent.id === LEAVE_NOW_ID);
  assert.ok(now, 'lähde nyt jää tavalliseksi ilmoitukseksi (ääni)');
  assert.equal(now.delivery, 'sound');
  assert.equal(now.routeDestination, 'Mannerheimintie 1');
  assert.equal(now.routeMode, 'transit');
  assert.ok(intents.filter(intent => !/^departure_/.test(intent.type)).every(intent => intent.routeDestination === undefined),
    'reitti vain lähtöketjun ilmoituksiin');

  await native.refreshPermission();
  await native.schedule(intents, NOON);
  const sent = local.calls.schedule[0].find(notification => notification.extra.intentId === LEAVE_NOW_ID);
  assert.equal(sent.actionTypeId, native.ROUTE_ACTION_TYPE_ID);
  assert.equal(sent.extra.routeDestination, 'Mannerheimintie 1');
});

test('painallus avaa reitin navigationLinkin kokoamasta kohteesta ja kuittaa "Lähde nyt" -muistutuksen', async () => {
  const local = fakeLocalNotifications();
  const alarm = fakeAlarmPlugin();
  installShell({ local, alarm });
  setUser(USER);
  activateAlarmEvents(USER.id);
  startNotificationActions();
  startNotificationActions(); // toinen kutsu ei kytke toista kuuntelijaa
  await Promise.resolve();
  assert.equal(local.listeners.length, 1);

  local.fire(native.ACTION_PERFORMED_EVENT, routeTap({
    intentId: LEAVE_NOW_ID, type: 'departure_leave_now', ackKey: LEAVE_NOW_ID,
    routeDestination: 'Mannerheimintie 1', routeMode: 'transit'
  }));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(alarm.calls.openNavigation, [{ destination: 'Mannerheimintie 1', mode: 'transit' }]);
  assert.equal(ackTypesFor(LEAVE_NOW_ID)?.acknowledged, true, 'painallus kuittaa: toistoa ei tule');
});

test('TIETOTURVA: ilmoituksen tiedoista ei avata linkkiä; skeemat ja osoitteet siivotaan pois', async () => {
  const alarm = fakeAlarmPlugin();
  installShell({ local: fakeLocalNotifications(), alarm });
  const url = await openRouteFromNotification({ destination: 'https://evil.example/phish', mode: 'driving' });
  assert.deepEqual(url, { ok: false, opened: false, code: 'invalid' }, 'pelkkä linkki ei ole kohde');
  const script = await openRouteFromNotification({ destination: 'javascript:alert(1) Kauppakatu 2', mode: 'walking' });
  assert.equal(script.opened, true);
  assert.equal(alarm.calls.openNavigation.length, 1, 'hylättyä kohdetta ei välitetä laitteelle');
  const [sent] = alarm.calls.openNavigation;
  assert.doesNotMatch(sent.destination, /javascript|:\/\//i);
  assert.match(sent.destination, /Kauppakatu 2/);
  assert.equal(sent.mode, 'walking');
  const unknownMode = await openRouteFromNotification({ destination: 'Koti', mode: 'rocket' });
  assert.equal(unknownMode.opened, true);
  assert.equal(alarm.calls.openNavigation[1].mode, 'driving', 'tuntematon kulkutapa: autolla');
  assert.deepEqual(await openRouteFromNotification(null), { ok: false, opened: false, code: 'invalid' });
});

test('reitin avaus epäonnistuu rehellisesti (ei karttasovellusta)', async () => {
  const alarm = fakeAlarmPlugin({ opened: false });
  installShell({ local: fakeLocalNotifications(), alarm });
  const result = await openRouteFromNotification({ destination: 'Koti' });
  assert.equal(result.ok, false);
  assert.equal(result.opened, false);
});

test('rakenne: alusta ei tuo domainia; sovellus kokoaa reitin navigationLinkillä; kuuntelija ennen istuntoa', () => {
  const platform = readCode('src/platform/nativeNotifications.js');
  assert.equal(/from '\.\.\/domain\//.test(platform), false, 'alusta ei tuo domainia');
  const app = readCode('src/app/notifications.js');
  const handler = app.slice(app.indexOf('export async function openRouteFromNotification'));
  assert.match(handler.slice(0, 1500), /buildNavigationTarget\(/);
  const main = readCode('src/app/main.js');
  const start = main.slice(main.indexOf('async function start'));
  assert.ok(start.indexOf('startNotificationActions()') > 0, 'kuuntelija kytketään käynnistyksessä');
  assert.ok(start.indexOf('startNotificationActions()') < start.indexOf('initAuth('), 'ennen istunnon palautusta');
});
