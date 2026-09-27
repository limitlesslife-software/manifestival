// Herätyksen sammutus kirjaa toteutuneen heräämisen unikirjaukseen.
//
// AUKKO (trace-sleep-no-alarm-derived-wake, journey-wake-dismiss-not-recorded):
// laitteen "Sammuta" herätykselle päätyi vain kuittauslokiin. Unikirjaus
// syntyi ainoastaan käsin (Hyvinvointi → Uni), joten viikonlopun rytmin
// siirtymä ja maanantain valmius jäivät hiljaisiksi, ellei käyttäjä
// kirjannut jokaista aamua itse (§46 "alarm-derived actual wake").
//
// Nyt herätyksen kuittaus tai hylkäys kirjaa heräämispäivän rivin
// (lähde 'alarm', 0014 sallii sen) tai täydentää saman päivän rivin
// heräämisajan. Käyttäjän oma heräämisaika voittaa aina. Sama tapahtuma
// kahdesti = yksi kirjoitus. Istunnon vaihtuessa ei kirjata toiselle.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { setUser, clearUser } from '../src/data/session.js';
import {
  resetState, getState, setProfile, setLifeSettings, setNotificationPreferences, setSleepLogs,
  setDomainLoadStatus
} from '../src/app/state.js';
import { clearAllCollections, sleepLogsRepo } from '../src/data/collectionsRepo.js';
import { resetAckStoreForTests, loadAckState, normalizeAckTarget } from '../src/data/alarmAckStore.js';
import * as capabilities from '../src/platform/capabilities.js';
import { resetAlarmsForTests } from '../src/platform/alarms.js';
import { activateAlarmSync, resetAlarmSync, syncAlarms, settledForTests } from '../src/app/alarmSync.js';
import {
  activateAlarmEvents, resetAlarmEvents, consumeAlarmEvents, handleAlarmEvents, pendingWakeRecordsForTests
} from '../src/app/alarmEvents.js';
import { alarmWakeLogInput } from '../src/domain/sleepLog.js';
import { driftReport } from '../src/domain/sleepRhythm.js';
import { deviceOffsetMinutes } from '../src/app/deviceTime.js';
import { resetTestStore, storedRows } from './helpers/gateAwareStore.mjs';

const USER_A = { id: 'aaaaaaaa-0000-4000-8000-00000000000a', email: 'a@example.com' };
const USER_B = { id: 'bbbbbbbb-0000-4000-8000-00000000000b', email: 'b@example.com' };
const at = (y, m, d, hh, mm) => new Date(y, m - 1, d, hh, mm);
const NOON = at(2026, 9, 29, 12, 0);
const WAKE_ID = 'wake:2026-09-30';
const ORIGINAL_CAPACITOR = globalThis.Capacitor;

function fakeAlarmPlugin({ events = [] } = {}) {
  let queue = [...events];
  const listeners = [];
  return {
    listeners,
    push(event) { for (const entry of listeners) entry.fn(event); },
    enqueue(event) { queue.push(event); },
    async status() { return { ok: true, exact: true, fullScreen: true, notifications: true, tts: 'available', scheduled: 0 }; },
    async schedule(options) { return { ok: true, scheduled: options.alarms.length, exact: true, inexact: [], dropped: [], rejected: [] }; },
    async cancelAll() { return { ok: true, removed: 0 }; },
    async cancel() { return { ok: true, removed: 0 }; },
    async consumeEvents() { const out = queue; queue = []; return { ok: true, events: out }; },
    async ackEvents() { return { ok: true, removed: 1 }; },
    async addListener(name, fn) {
      const entry = { name, fn };
      listeners.push(entry);
      return { remove: async () => { listeners.splice(listeners.indexOf(entry), 1); } };
    }
  };
}

function installShell(plugin) {
  globalThis.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { ManifestivalAlarm: plugin } };
}

function seed() {
  setProfile({ sleepTargetHours: 8, defaultWakeTime: '06:30', commuteMinutes: 30, routineMinutes: 45 }, true);
  setLifeSettings([{ id: 's1', alarm: { enabled: true } }]);
  setNotificationPreferences({ enabled: false });
}

/** Unikirjaukset on ladattu (kuten loadUserData): vasta silloin tiedetään, onko päivällä jo rivi. */
function markSleepLogsLoaded() {
  setDomainLoadStatus('sleepLogs', true);
}

/** Käyttäjän aiemmat unikirjaukset kannassa ja ladattuina tilaan. */
async function loadedSleepLogs(rows) {
  for (const row of rows) await sleepLogsRepo.insert(row);
  setSleepLogs(rows);
}

function signIn(user = USER_A) {
  setUser(user);
  activateAlarmSync(user.id);
  activateAlarmEvents(user.id);
}

const wakeEvent = (seq, type, atMs, id = WAKE_ID) => ({ seq, type, id, kind: 'wake', atMs });

beforeEach(() => {
  delete globalThis.Capacitor;
  clearAllCollections();
  // Portin ollessa auki unikirjaus kulkee kantaa jäljittelevälle palvelimelle.
  resetTestStore();
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

// ------------------------------------------------------------ domain: mitä kirjataan

test('domain: herätyksen herääminen ei koskaan korvaa jo kirjattua heräämistä', () => {
  const record = { wakeDate: '2026-09-30', actualWake: '06:41', plannedWake: '06:30' };
  assert.deepEqual(alarmWakeLogInput(null, record),
    { wakeDate: '2026-09-30', actualWake: '06:41', plannedWake: '06:30', source: 'alarm', kind: 'opportunity' });
  // Käyttäjän rivi ilman heräämistä: vain heräämisaika (ja suunniteltu, jos puuttui) täydentyy.
  assert.deepEqual(alarmWakeLogInput({ wakeDate: '2026-09-30', actualBedtime: '23:10', source: 'user' }, record),
    { wakeDate: '2026-09-30', actualWake: '06:41', plannedWake: '06:30' });
  assert.deepEqual(alarmWakeLogInput({ wakeDate: '2026-09-30', plannedWake: '06:00', source: 'user' }, record),
    { wakeDate: '2026-09-30', actualWake: '06:41' });
  // Jo kirjattu herääminen (käyttäjän tai aiemman herätyksen): ei mitään.
  assert.equal(alarmWakeLogInput({ wakeDate: '2026-09-30', actualWake: '06:10', source: 'user' }, record), null);
  assert.equal(alarmWakeLogInput({ wakeDate: '2026-09-30', actualWake: '06:41', source: 'alarm' }, record), null);
  // Roska ei tuota kirjausta.
  assert.equal(alarmWakeLogInput(null, { wakeDate: 'x', actualWake: '06:41' }), null);
  assert.equal(alarmWakeLogInput(null, { wakeDate: '2026-09-30', actualWake: '25:00' }), null);
  assert.equal(alarmWakeLogInput(null, { wakeDate: '2026-09-30', actualWake: '06:41', plannedWake: 'x' }).plannedWake, null);
});

test('herätyksen kohde muistaa suunnitellun kellonajan (kuittauksen tulkintaa varten)', () => {
  const target = normalizeAckTarget({ id: WAKE_ID, ackKey: WAKE_ID, kind: 'wake', type: 'wake', date: '2026-09-30', time: '06:30' });
  assert.equal(target.time, '06:30');
  assert.equal(normalizeAckTarget({ id: WAKE_ID, ackKey: WAKE_ID, time: '6:30' }).time, null);
});

// ------------------------------------------------------------ sovellus: laitteen tapahtuma -> unikirjaus

test('Sammuta herätyksestä kirjaa heräämisen: lähde alarm, suunniteltu ja toteutunut aika', async () => {
  const plugin = fakeAlarmPlugin();
  installShell(plugin);
  signIn();
  seed();
  markSleepLogsLoaded();
  await syncAlarms({ now: NOON });
  const planned = loadAckState(USER_A.id).targets.find(target => target.id === WAKE_ID);
  assert.ok(planned && planned.time, 'ajastettu herätys muistaa kellonaikansa');

  plugin.enqueue(wakeEvent(1, 'acknowledged', at(2026, 9, 30, 6, 41).getTime()));
  const result = await consumeAlarmEvents();
  assert.equal(result.wakes, 1);

  const logs = getState().sleepLogs;
  assert.equal(logs.length, 1);
  assert.equal(logs[0].wakeDate, '2026-09-30');
  assert.equal(logs[0].actualWake, '06:41');
  assert.equal(logs[0].plannedWake, planned.time);
  assert.equal(logs[0].source, 'alarm');
  assert.equal(logs[0].kind, 'opportunity', 'vuoteessa oloaika, ei mitattua unta');
  assert.equal((await sleepLogsRepo.list()).value.length, 1, 'tallentui repositorioon');
  const [stored] = await storedRows(sleepLogsRepo);
  assert.deepEqual([stored.wakeDate, stored.actualWake, stored.source], ['2026-09-30', '06:41', 'alarm']);
});

test('IDEMPOTENTTI: sama sammutus elävänä ja jonosta, ja toinen kuittaus myöhemmin = yksi kirjoitus, ensimmäinen aika', async () => {
  const plugin = fakeAlarmPlugin();
  installShell(plugin);
  signIn();
  seed();
  markSleepLogsLoaded();
  let inserts = 0;
  const original = sleepLogsRepo.insert;
  sleepLogsRepo.insert = async row => { inserts += 1; return original(row); };
  let updates = 0;
  const originalUpdate = sleepLogsRepo.update;
  sleepLogsRepo.update = async row => { updates += 1; return originalUpdate(row); };
  try {
    const first = wakeEvent(3, 'acknowledged', at(2026, 9, 30, 6, 41).getTime());
    await Promise.all([handleAlarmEvents([first]), handleAlarmEvents([first])]);
    await handleAlarmEvents([wakeEvent(4, 'dismissed', at(2026, 9, 30, 6, 55).getTime())]);
    plugin.enqueue(first);
    await consumeAlarmEvents();
  } finally {
    sleepLogsRepo.insert = original;
    sleepLogsRepo.update = originalUpdate;
  }
  assert.equal(inserts, 1, 'yksi rivi');
  assert.equal(updates, 0, 'ei päällekirjoitusta');
  assert.equal(getState().sleepLogs.length, 1);
  assert.equal(getState().sleepLogs[0].actualWake, '06:41');
});

test('käyttäjän oma heräämisaika voittaa; pelkkä nukkumaanmeno täydentyy heräämisellä', async () => {
  installShell(fakeAlarmPlugin());
  signIn();
  seed();
  await loadedSleepLogs([
    { id: 'l1', wakeDate: '2026-09-30', actualBedtime: '23:10', actualWake: '06:05', source: 'user' },
    { id: 'l2', wakeDate: '2026-10-01', actualBedtime: '23:40', source: 'user' }
  ]);
  markSleepLogsLoaded();
  await handleAlarmEvents([
    wakeEvent(5, 'acknowledged', at(2026, 9, 30, 6, 41).getTime()),
    wakeEvent(6, 'acknowledged', at(2026, 10, 1, 7, 2).getTime(), 'wake:2026-10-01')
  ]);
  const byDate = new Map(getState().sleepLogs.map(log => [log.wakeDate, log]));
  assert.equal(byDate.get('2026-09-30').actualWake, '06:05', 'käyttäjän kirjaus ennallaan');
  assert.equal(byDate.get('2026-10-01').actualWake, '07:02', 'heräämisaika täydentyi');
  assert.equal(byDate.get('2026-10-01').actualBedtime, '23:40', 'nukkumaanmeno säilyi');
  assert.equal(byDate.get('2026-10-01').source, 'user', 'käyttäjän rivi pysyy käyttäjän rivinä');
  assert.equal(getState().sleepLogs.length, 2, 'ei toista riviä samalle päivälle');
});

test('torkku, väliin jäänyt herätys ja muistutuksen kuittaus eivät ole heräämisiä', async () => {
  installShell(fakeAlarmPlugin());
  signIn();
  seed();
  markSleepLogsLoaded();
  const ms = at(2026, 9, 30, 6, 30).getTime();
  await handleAlarmEvents([
    { ...wakeEvent(7, 'snoozed', ms), untilMs: ms + 9 * 60000 },
    wakeEvent(8, 'missed', ms, 'wake:2026-10-01'),
    { seq: 9, type: 'acknowledged', id: 'departure_leave_now:event:e1:2026-09-30:2026-09-30', kind: 'spoken', atMs: ms }
  ]);
  assert.deepEqual(getState().sleepLogs, []);
});

test('toisen päivän herätys (tunniste ja kellonaika eri päivää) ei kirjaudu väärälle aamulle', async () => {
  installShell(fakeAlarmPlugin());
  signIn();
  seed();
  markSleepLogsLoaded();
  // Herätys 30.9. hylättiin jo 29.9. keskipäivällä (esim. peruttu etukäteen): ei heräämistä.
  await handleAlarmEvents([wakeEvent(10, 'dismissed', NOON.getTime())]);
  assert.deepEqual(getState().sleepLogs, []);
});

test('unikirjauksia ei ole vielä ladattu: kirjaus odottaa latausta eikä luo toista riviä', async () => {
  const plugin = fakeAlarmPlugin();
  installShell(plugin);
  signIn();
  seed();
  // Elävä tapahtuma ennen latausta (kirjautuminen kesken).
  await handleAlarmEvents([wakeEvent(11, 'acknowledged', at(2026, 9, 30, 6, 41).getTime())]);
  assert.deepEqual(getState().sleepLogs, [], 'ei kirjoitusta ennen latausta');
  assert.equal(pendingWakeRecordsForTests().length, 1, 'odottaa laitteella');
  assert.equal(loadAckState(USER_A.id).wakes.pending.length, 1, 'säilyy sovelluksen uudelleenkäynnistyksen yli');

  // Lataus toi saman päivän käyttäjän rivin: sitä ei ohiteta eikä monisteta.
  await loadedSleepLogs([{ id: 'l9', wakeDate: '2026-09-30', actualBedtime: '22:50', source: 'user' }]);
  markSleepLogsLoaded();
  const result = await consumeAlarmEvents();
  assert.equal(result.wakes, 1, 'tyhjä jono: odottanut kirjaus tehdään silti');
  assert.equal(getState().sleepLogs.length, 1);
  assert.equal(getState().sleepLogs[0].actualWake, '06:41');
  assert.equal(pendingWakeRecordsForTests().length, 0);
});

test('verkko poikki tai tallennus epäonnistuu: kirjaus odottaa ja tehdään myöhemmin kerran', async () => {
  installShell(fakeAlarmPlugin());
  signIn();
  seed();
  markSleepLogsLoaded();
  const original = sleepLogsRepo.insert;
  sleepLogsRepo.insert = async () => ({ ok: false, error: { message: 'verkko', userMessage: 'Yhteys katkesi.' } });
  try {
    await handleAlarmEvents([wakeEvent(12, 'acknowledged', at(2026, 9, 30, 6, 41).getTime())]);
  } finally {
    sleepLogsRepo.insert = original;
  }
  assert.deepEqual(getState().sleepLogs, [], 'epäonnistunut tallennus peruttiin tilasta');
  assert.equal(pendingWakeRecordsForTests().length, 1, 'ei kadonnut');

  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: false }, configurable: true, writable: true });
  try {
    const offline = await consumeAlarmEvents();
    assert.equal(offline.wakes, 0, 'tunnetusti offline: ei yritetä (ei virheilmoitusta joka paluulla)');
  } finally {
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
    else delete globalThis.navigator;
  }
  const online = await consumeAlarmEvents();
  assert.equal(online.wakes, 1);
  assert.equal(getState().sleepLogs.length, 1);
  assert.equal((await consumeAlarmEvents()).wakes, 0, 'ei toista kertaa');
});

test('KILPAILU: käyttäjä vaihtuu -> edellisen herätyksen heräämistä ei kirjata uudelle käyttäjälle', async () => {
  const plugin = fakeAlarmPlugin();
  let releaseConsume;
  plugin.consumeEvents = () => new Promise(resolve => { releaseConsume = resolve; });
  installShell(plugin);
  signIn(USER_A);
  seed();
  markSleepLogsLoaded();
  const pending = consumeAlarmEvents();
  await new Promise(resolve => setImmediate(resolve));
  clearUser();
  resetAlarmEvents();
  resetState();
  signIn(USER_B);
  seed();
  markSleepLogsLoaded();
  releaseConsume({ ok: true, events: [wakeEvent(13, 'acknowledged', at(2026, 9, 30, 6, 41).getTime())] });
  await pending;
  assert.deepEqual(getState().sleepLogs, [], 'A:n herääminen ei päätynyt B:n unikirjauksiin');
  assert.equal(pendingWakeRecordsForTests().length, 0);
});

test('herätyksestä kirjatut aamut antavat viikonlopun rytmille dataa ilman käsin kirjausta', async () => {
  installShell(fakeAlarmPlugin());
  signIn();
  seed();
  markSleepLogsLoaded();
  // Arkiaamut 6.30-herätyksellä, viikonloppuna 9.10 ja 9.20 (la 3.10., su 4.10.).
  const days = [['2026-09-28', 6, 32], ['2026-09-29', 6, 35], ['2026-09-30', 6, 31], ['2026-10-01', 6, 40],
    ['2026-10-02', 6, 33], ['2026-10-03', 9, 10], ['2026-10-04', 9, 20]];
  let seq = 20;
  for (const [date, hh, mm] of days) {
    const [y, m, d] = date.split('-').map(Number);
    await handleAlarmEvents([wakeEvent(seq++, 'acknowledged', at(y, m, d, hh, mm).getTime(), `wake:${date}`)]);
  }
  assert.equal(getState().sleepLogs.length, 7);
  const report = driftReport({
    logs: getState().sleepLogs, profile: getState().profile, settings: {}, todayIso: '2026-10-04',
    offsetMinutesFn: deviceOffsetMinutes
  });
  assert.ok(report && report.weekends.length === 1, 'viikonloppu näkyy rytmiraportissa');
  assert.ok(report.weekends[0].wakeShiftMinutes > 120, 'heräämisen siirtymä lasketaan herätyksen ajoista');
  assert.equal(report.reference.wakeBasis, 'observed', 'arkiaamujen vertailukohta tulee herätyksistä');
});
