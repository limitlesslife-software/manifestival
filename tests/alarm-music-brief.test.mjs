// Oma herätysmusiikki ja aamukatsaus sammutuksen jälkeen (JS-puoli).
//
// AUKOT
//   trace-alarm-music-mode-fake / claims-alarm-music-mode: "Oma musiikki"
//     soitti saman herätysäänen kuin "Herätysääni", eikä musiikkia voinut
//     valita. Nyt pickAlarmMusic avaa järjestelmän tiedostovalitsimen
//     (ACTION_OPEN_DOCUMENT audio/*, pysyvä lukuoikeus, EI tallennustilan
//     lupaa), ja AlarmService soittaa valitun musiikin tavoilla "music" ja
//     "combination" (natiivi puoli: tests/android-alarm.test.mjs ja
//     AlarmMathTest.java).
//   claims-morning-brief-silent: "Aamukatsaus puheena" oli oletustavalla
//     (herätysääni) hiljainen, ja puhetavalla katsaus korvasi herätyksen
//     puheen. Nyt herätyksen merkintä kertoo laitteelle, että katsaus
//     luetaan KERRAN Sammuta-painalluksen jälkeen (briefOnDismiss) tavasta
//     riippumatta, ja katsauksen loppuosa (brief) kulkee omassa kentässään.
//     Tervehdyksen ja kellonajan laite lisää puhehetkellä: torkun jälkeen
//     "Kello on" ei ole vanhentunut.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { setUser, clearUser } from '../src/data/session.js';
import { resetState, setProfile, setLifeSettings, setNotificationPreferences } from '../src/app/state.js';
import { clearAllCollections } from '../src/data/collectionsRepo.js';
import { resetAckStoreForTests } from '../src/data/alarmAckStore.js';
import * as capabilities from '../src/platform/capabilities.js';
import * as alarms from '../src/platform/alarms.js';
import * as index from '../src/platform/index.js';
import { desiredAlarms, morningBrief } from '../src/domain/alarmPlan.js';
import { activateAlarmSync, resetAlarmSync, desiredNativeEntries, settledForTests } from '../src/app/alarmSync.js';
import { activateAlarmEvents, resetAlarmEvents } from '../src/app/alarmEvents.js';
import { readCode } from './helpers/sources.mjs';

const USER = { id: 'aaaaaaaa-0000-4000-8000-00000000000a', email: 'a@example.com' };
const at = (y, m, d, hh, mm) => new Date(y, m - 1, d, hh, mm);
const NOON = at(2026, 9, 29, 12, 0);
const ORIGINAL_CAPACITOR = globalThis.Capacitor;

function fakePlugin({ music = { ok: true, picked: true, title: 'Aamulaulu.mp3' }, status = {} } = {}) {
  const calls = { pickAlarmMusic: 0, pickAlarmSound: 0 };
  return {
    calls,
    async status() {
      return { ok: true, exact: true, fullScreen: true, notifications: true, tts: 'available', soundPicked: false, scheduled: 0, ...status };
    },
    async schedule(options) { return { ok: true, scheduled: options.alarms.length, exact: true, inexact: [], dropped: [], rejected: [] }; },
    async pickAlarmMusic() { calls.pickAlarmMusic += 1; return music; },
    async pickAlarmSound() { calls.pickAlarmSound += 1; return { ok: true, picked: true, title: 'Aamu' }; }
  };
}

function installShell(plugin) {
  globalThis.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { ManifestivalAlarm: plugin } };
}

function wake(overrides = {}) {
  return {
    id: 'wake:2026-09-30', kind: 'wake', date: '2026-09-30', time: '06:30', title: 'Herätys', body: null, speech: null,
    mode: 'alarm_sound', escalation: [], snoozeMinutes: 9, maxSnoozes: 3, routeDestination: null, routeMode: null,
    ...overrides
  };
}

beforeEach(() => {
  delete globalThis.Capacitor;
  clearAllCollections();
  resetState();
  clearUser();
  alarms.resetAlarmsForTests();
  resetAckStoreForTests();
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

// ------------------------------------------------------------ musiikki

test('musiikin valinta: järjestelmän valitsin vain kutsusta; selaimessa rehellinen ei', async () => {
  const web = await alarms.pickAlarmMusic();
  assert.equal(web.ok, false);
  assert.equal(web.supported, false);

  const plugin = fakePlugin();
  installShell(plugin);
  await alarms.alarmStatus();
  assert.equal(plugin.calls.pickAlarmMusic, 0, 'tilan luku ei avaa valitsinta');
  assert.deepEqual({ ...(await index.alarms.pickAlarmMusic()) },
    { ok: true, supported: true, picked: true, title: 'Aamulaulu.mp3', code: null });
  assert.equal(plugin.calls.pickAlarmMusic, 1);
  assert.equal(plugin.calls.pickAlarmSound, 0, 'musiikki ei ole herätysäänen valitsin');
});

test('musiikin valinta peruttiin tai oikeutta ei saatu pysyväksi: ei valintaa, syy kerrotaan', async () => {
  installShell(fakePlugin({ music: { ok: false, code: 'cancelled' } }));
  assert.deepEqual({ ...(await alarms.pickAlarmMusic()) }, { ok: false, supported: true, picked: false, title: null, code: 'cancelled' });
  installShell(fakePlugin({ music: { ok: false, code: 'not-persistable' } }));
  assert.equal((await alarms.pickAlarmMusic()).code, 'not-persistable');
  installShell({ async schedule() { return { ok: true }; }, async pickAlarmMusic() { throw new Error('laite'); } });
  assert.equal((await alarms.pickAlarmMusic()).ok, false, 'ei heitä');
});

test('tila kertoo valitun musiikin (nimi vain tekstinä, siistittynä)', async () => {
  installShell(fakePlugin({ status: { musicPicked: true, musicName: '  Aamu\u0000laulu.mp3 ' } }));
  const status = await alarms.alarmStatus();
  assert.equal(status.musicPicked, true);
  assert.equal(status.musicName, 'Aamulaulu.mp3');
  installShell(fakePlugin());
  const none = await alarms.alarmStatus();
  assert.equal(none.musicPicked, false);
  assert.equal(none.musicName, null);
  const web = (delete globalThis.Capacitor, await alarms.alarmStatus());
  assert.equal(web.musicPicked, false);
});

// ------------------------------------------------------------ aamukatsaus: sopimus

test('merkinnän katsauskentät: brief (teksti) ja briefOnDismiss (vain tosi boolean), oletuksena pois', () => {
  const plain = alarms.validateAlarmEntry(wake());
  assert.equal(plain.valid, true);
  assert.equal(plain.entry.brief, null);
  assert.equal(plain.entry.briefOnDismiss, false);

  const withBrief = alarms.validateAlarmEntry(wake({ brief: ' Lähtötavoite on 7.05.\n', briefOnDismiss: true }));
  assert.equal(withBrief.valid, true);
  assert.equal(withBrief.entry.brief, 'Lähtötavoite on 7.05.');
  assert.equal(withBrief.entry.briefOnDismiss, true);

  assert.equal(alarms.validateAlarmEntry(wake({ briefOnDismiss: 'true' })).valid, false, 'vain tosi boolean');
  assert.equal(alarms.validateAlarmEntry(wake({ brief: 42 })).valid, false);
  assert.equal(alarms.validateAlarmEntry(wake({ brief: 'x'.repeat(501) })).valid, false);
  // Katsaus kuuluu herätykseen: muistutus ei lue katsausta sammutuksen jälkeen.
  assert.equal(alarms.validateAlarmEntry(wake({ kind: 'spoken', briefOnDismiss: true })).valid, false);
});

test('domain: katsauksen loppuosa ilman tervehdystä ja suunniteltua kellonaikaa (laite lisää ne puhehetkellä)', () => {
  const settings = { alarm: { enabled: true }, morningBriefEnabled: true };
  const profile = { sleepTargetHours: 8, defaultWakeTime: '06:30', commuteMinutes: 30 };
  const [alarm] = desiredAlarms({
    fromIso: '2026-09-30', profile, settings,
    commitmentsByDate: { '2026-09-30': { title: 'Palaveri', startTime: '09:00', category: 'tyo' } }
  });
  assert.match(alarm.briefText, /^Hyvää huomenta\. Kello on/);
  assert.equal(alarm.briefDetail, morningBrief({
    now: { date: alarm.date, time: alarm.time }, wakeTime: alarm.time, leaveTime: alarm.leaveTime,
    commitments: [{ title: 'Palaveri', startTime: '09:00', category: 'tyo' }], settings
  }).lines.slice(1).join(' '));
  assert.doesNotMatch(alarm.briefDetail, /Hyvää|Kello on/);
  assert.match(alarm.briefDetail, /Palaveri/);
  const [off] = desiredAlarms({ fromIso: '2026-09-30', profile, settings: { alarm: { enabled: true } } });
  assert.equal(off.briefDetail, null);
});

// ------------------------------------------------------------ aamukatsaus: ajastus laitteelle

function seed(settings) {
  setProfile({ sleepTargetHours: 8, defaultWakeTime: '06:30', commuteMinutes: 30, routineMinutes: 45 }, true);
  setLifeSettings([{ id: 's1', alarm: { enabled: true }, ...settings }]);
  setNotificationPreferences({ enabled: false });
  setUser(USER);
  activateAlarmSync(USER.id);
  activateAlarmEvents(USER.id);
}

test('REGRESSIO: aamukatsaus oletustavalla (herätysääni, ei puhevaihetta) luetaan sammutuksen jälkeen', () => {
  seed({ morningBriefEnabled: true });
  const { entries } = desiredNativeEntries({ now: NOON, nativeSupported: true });
  const wakes = entries.filter(entry => entry.kind === 'wake');
  assert.ok(wakes.length >= 2);
  for (const entry of wakes) {
    assert.equal(entry.mode, 'alarm_sound', 'oletustapa');
    assert.equal(entry.escalation.some(step => /speech/.test(step.step)), false, 'ei puhevaihetta');
    assert.equal(entry.briefOnDismiss, true, 'katsaus ei jää hiljaiseksi oletustavalla');
    assert.match(entry.brief, /\S/);
    assert.doesNotMatch(entry.brief, /Kello on/, 'laite sanoo kellonajan sammutushetkellä, ei suunniteltua');
    assert.equal(entry.speech, null, 'katsaus ei korvaa herätyksen puhetta');
    assert.equal(alarms.validateAlarmEntry(entry).valid, true);
  }
});

test('puhetavalla herätyksen puhe on herätys, katsaus tulee sammutuksen jälkeen (ei korvaa soittoa)', () => {
  seed({ morningBriefEnabled: true, alarm: { enabled: true, mode: 'speech' } });
  const wakeEntry = desiredNativeEntries({ now: NOON, nativeSupported: true }).entries.find(entry => entry.kind === 'wake');
  assert.equal(wakeEntry.mode, 'speech');
  assert.equal(wakeEntry.speech, null, 'laite puhuu herätyksenä tervehdyksen ja kellonajan');
  assert.equal(wakeEntry.briefOnDismiss, true);
});

test('katsaus pois: ei katsausta sammutuksen jälkeen eikä katsauksen tekstiä laitteelle', () => {
  seed({ morningBriefEnabled: false, alarm: { enabled: true, mode: 'combination' } });
  const wakeEntry = desiredNativeEntries({ now: NOON, nativeSupported: true }).entries.find(entry => entry.kind === 'wake');
  assert.equal(wakeEntry.briefOnDismiss, false);
  assert.equal(wakeEntry.brief, null);
});

test('facade: pickAlarmMusic on kytketty; näkymä avaa valitsimen vain napautuksesta', () => {
  assert.equal(typeof index.alarms.pickAlarmMusic, 'function');
  assert.equal(index.alarms.pickAlarmMusic, alarms.pickAlarmMusic);
  const view = readCode('src/app/views/dailySettings.js');
  assert.equal([...view.matchAll(/'pickAlarmMusic'/g)].length, 1, 'vain napautuksen käsittelijässä');
});
