// Offline-käynnistys, verkon palautuminen ja lähetysjärjestys
// (audit: offline-timer F6, F7, F10, F11, F14, F16; races RACE-14).
//
// Ajastus on injektoitu tai valekello: ei oikeaa odottamista.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { readCode } from './helpers/sources.mjs';
import { fakeClient, isGateOpen } from './helpers/gates.mjs';
import { createReconnectController } from '../src/app/reconnect.js';
import { createOfflineSync } from '../src/app/offlineSync.js';
import { fetchWithTimeout, setClient } from '../src/data/client.js';
import { classifyError, ERROR_CLASS } from '../src/domain/offlineQueue.js';
import { signOutWarning } from '../src/app/auth.js';
import { setUser, clearUser } from '../src/data/session.js';
import { resetState, getState } from '../src/app/state.js';
import { clearLocalUserData, loadUserData } from '../src/app/actions.js';
import { offline } from '../src/app/offline.js';
import { saveOutbox, resetTimerStoreForTests } from '../src/data/timerStore.js';
import { resetQueueStoreForTests } from '../src/data/offlineQueueStore.js';
import { normalizeTask } from '../src/domain/task.js';
import { normalizeTimeEntry } from '../src/domain/timeEntry.js';

const USER = { id: 'aaaaaaaa-7171-4171-8171-000000000071', email: 'boot@example.com' };

function fakeTimers() {
  const pending = new Map();
  let nextId = 1;
  return {
    setTimeoutFn(fn, ms) { const id = nextId++; pending.set(id, { fn, ms }); return id; },
    clearTimeoutFn(id) { pending.delete(id); },
    tick() { const due = [...pending.values()]; pending.clear(); for (const { fn } of due) fn(); },
    delays: () => [...pending.values()].map(entry => entry.ms),
    pendingCount: () => pending.size
  };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

function installStorage() {
  const data = new Map();
  globalThis.localStorage = {
    getItem: key => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => { data.set(key, String(value)); },
    removeItem: key => { data.delete(key); },
    key: index => [...data.keys()][index] ?? null,
    get length() { return data.size; }
  };
}

beforeEach(() => {
  clearUser();
  clearLocalUserData();
  resetState();
  resetTimerStoreForTests();
  resetQueueStoreForTests();
  installStorage();
  setClient(fakeClient({ data: [], error: null }));
});

afterEach(() => {
  offline.deactivate();
  delete globalThis.localStorage;
});

// ============================================================ F7 käynnistys offline

test('F7 KRIITTINEN: offline-tilassa käynnistynyt ohjain reagoi ensimmäiseen "online"-tapahtumaan', async () => {
  const timers = fakeTimers();
  let refreshes = 0;
  const controller = createReconnectController({
    onRefresh: async () => { refreshes += 1; }, initialOnline: false,
    setTimeoutFn: timers.setTimeoutFn, clearTimeoutFn: timers.clearTimeoutFn
  });
  assert.equal(controller.isOnline(), false);
  controller.notifyOnline();
  assert.equal(timers.pendingCount(), 1, 'ensimmäinen online ei ajastanut lähetystä ja latausta');
  timers.tick();
  await settle();
  assert.equal(refreshes, 1);
});

test('F7: oletus on ennallaan (verkossa käynnistynyt ohjain ei ajasta turhaa kierrosta)', () => {
  const timers = fakeTimers();
  const controller = createReconnectController({
    onRefresh: async () => {}, setTimeoutFn: timers.setTimeoutFn, clearTimeoutFn: timers.clearTimeoutFn
  });
  controller.notifyOnline();
  assert.equal(timers.pendingCount(), 0);
});

test('F7: epäonnistunut ensimmäinen lataus verkossa -> yksi viivästetty uusi yritys, joka ei kasaudu', async () => {
  const timers = fakeTimers();
  let refreshes = 0;
  const controller = createReconnectController({
    onRefresh: async () => { refreshes += 1; },
    setTimeoutFn: timers.setTimeoutFn, clearTimeoutFn: timers.clearTimeoutFn
  });
  controller.refreshLater(10000);
  controller.refreshLater(10000);
  assert.deepEqual(timers.delays(), [10000], 'uusintoja kasautui');
  controller.notifyOffline();
  assert.equal(timers.pendingCount(), 0, 'offline peruu odottavan uusinnan');
  controller.refreshLater(10000);
  assert.equal(timers.pendingCount(), 0, 'offline-tilassa ei ajasteta: seuraava online hoitaa');
  controller.notifyOnline();
  timers.tick();
  await settle();
  assert.equal(refreshes, 1);
  controller.refreshLater(5000);
  controller.cancelPending();
  assert.equal(timers.pendingCount(), 0, 'uloskirjautuminen peruu');
});

test('F7: main.js kertoo ohjaimelle verkon tilan käynnistyksessä ja yrittää epäonnistunutta latausta kerran uudelleen', () => {
  const main = readCode('src/app/main.js');
  assert.match(main, /createReconnectController\(\{[^}]*initialOnline: isOnlineNow\(\)/);
  const listeners = main.slice(main.indexOf("window.addEventListener('offline'"));
  assert.match(listeners, /if \(isOnlineNow\(\)\) reconnect\.notifyOnline\(\);\s*else reconnect\.notifyOffline\(\);/,
    'käynnistyksen aikana muuttunut verkon tila jää ohjaimelta huomaamatta');
  const signedIn = main.slice(main.indexOf('async function onSignedIn'), main.indexOf('function onSignedOut'));
  assert.ok(signedIn.indexOf('reconnect.refreshLater(FIRST_LOAD_RETRY_MS)') > signedIn.indexOf('await loadFresh()'));
  assert.match(signedIn, /if \(isOnlineNow\(\) && hasLoadFailures\(\)\) reconnect\.refreshLater/);
});

// ============================================================ F11 toisto odottaa

test('F11: replay({ waitForCurrent }) odottaa käynnissä olevan toiston loppuun; tavallinen kutsu palaa heti', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const stored = new Map();
  let inserted = 0;
  const sync = createOfflineSync({
    repo: {
      insertTask: async () => { await gate; inserted += 1; return { ok: true }; },
      getTask: async () => ({ ok: true, value: null }),
      patchTask: async () => ({ ok: true, value: { applied: true } })
    },
    store: {
      load: id => stored.get(id) ?? null,
      save: (id, text) => { stored.set(id, text); return { ok: true, persistent: true }; },
      purge: id => stored.delete(id)
    },
    session: { userId: () => 'u-1', snapshot: () => 1, isSame: () => true },
    now: () => 1_800_000_000_000, isOnline: () => true, newId: (() => { let n = 0; return () => 'op-' + (++n); })()
  });
  sync.activate('u-1');
  assert.equal(sync.enqueueTaskCreate(normalizeTask({ id: 't-1', title: 'Offline-tehtävä', date: '2026-09-20' })).ok, true);

  const running = sync.replay();
  const busy = await sync.replay();
  assert.equal(busy.reason, 'busy');
  let waitedDone = false;
  const waited = sync.replay({ waitForCurrent: true }).then(result => { waitedDone = true; return result; });
  await settle();
  assert.equal(waitedDone, false, 'lataus olisi alkanut ennen kuin lähetys valmistui');
  release();
  const [first, second] = await Promise.all([running, waited]);
  assert.equal(inserted, 1, 'odottava kutsu ei saa aloittaa toista ajoa');
  assert.equal(first.synced, 1);
  assert.equal(second.synced, 1, 'odottaja saa käynnissä olleen ajon tuloksen');
});

// ============================================================ F10 aikaraja

test('F10: Supabase-pyynnöllä on aikaraja, ja aikakatkaisu luokitellaan verkkovirheeksi (jonoon, ei hylkäys)', async () => {
  const timers = fakeTimers();
  let seenSignal = null;
  const hanging = (url, init) => new Promise((resolve, reject) => {
    seenSignal = init.signal;
    init.signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
  });
  const timedFetch = fetchWithTimeout(hanging, 15000, timers);
  const request = timedFetch('/rest/v1/time_entries', { method: 'POST' });
  await settle();
  assert.deepEqual(timers.delays(), [15000]);
  timers.tick();
  const error = await request.then(() => null, caught => caught);
  assert.ok(error instanceof TypeError, 'aikakatkaisu ei näy verkkovirheenä');
  assert.match(error.message, /Failed to fetch/);
  assert.equal(seenSignal.aborted, true, 'jumittunutta pyyntöä ei keskeytetty');
  // PostgREST muotoilee fetch-virheen näin (nimi: viesti, koodi tyhjä).
  const postgrest = { cause: { message: `${error.name}: ${error.message}`, code: '' } };
  assert.equal(classifyError(postgrest), ERROR_CLASS.NETWORK);
});

test('F10: nopea vastaus menee läpi, ajastin puretaan ja kutsujan oma keskeytys välittyy', async () => {
  const timers = fakeTimers();
  const timedFetch = fetchWithTimeout(async (url, init) => ({ ok: true, url, aborted: init.signal.aborted }), 15000, timers);
  const response = await timedFetch('/rest/v1/x');
  assert.equal(response.ok, true);
  assert.equal(timers.pendingCount(), 0, 'ajastin jäi elämään');

  const outer = new AbortController();
  outer.abort();
  let received = null;
  await fetchWithTimeout(async (url, init) => { received = init.signal.aborted; return {}; }, 15000, timers)('x', { signal: outer.signal });
  assert.equal(received, true);
});

test('F10: client.js antaa aikarajallisen fetchin supabase-js:lle', () => {
  const client = readCode('src/data/client.js');
  assert.match(client, /global: \{ fetch: fetchWithTimeout\(/);
  assert.match(client, /REQUEST_TIMEOUT_MS = 15000/);
});

// ============================================================ F14 uloskirjautuminen

test('F14: uloskirjautumisen varoitus kertoo myös aikakirjauksista ja käynnissä olevasta ajastimesta', () => {
  assert.equal(signOutWarning({}), null, 'ei varoitusta, kun mitään ei odota');
  assert.match(signOutWarning({ timeEntries: 1 }), /1 aikakirjaus/);
  assert.match(signOutWarning({ timeEntries: 3 }), /3 aikakirjausta/);
  assert.match(signOutWarning({ tasks: 2, timeEntries: 1 }), /2 muutosta ja 1 aikakirjaus/);
  assert.match(signOutWarning({ timerRunning: true }), /Ajastin on käynnissä/);
  assert.match(signOutWarning({ tasks: 1 }), /Kirjaudutaanko ulos\?$/);
});

test('F14: signOut laskee lähtökorin ja laitteen ajastimen ennen vahvistusta', () => {
  const auth = readCode('src/app/auth.js');
  const start = auth.indexOf('const signOut = singleFlight');
  const body = auth.slice(start, auth.indexOf('\n});', start));
  assert.ok(body.indexOf('loadOutbox(') > -1 && body.indexOf('loadOutbox(') < body.indexOf('confirmAction('));
  assert.ok(body.indexOf('loadTimer(') > -1 && body.indexOf('loadTimer(') < body.indexOf('confirmAction('));
  assert.match(body, /signOutWarning\(/);
});

// ============================================================ F16 ja RACE-14 kytkennät

test('F16: NYT-kierros uusii lähettämättömät aikakirjaukset verkossa ollessa (porrastettuna)', () => {
  const main = readCode('src/app/main.js');
  const interval = main.slice(main.indexOf('setInterval('), main.indexOf('NOW_REFRESH_MS);', main.indexOf('setInterval(')));
  assert.match(interval, /if \(isOnlineNow\(\)\) \{\s*retryTimeOutbox\(\)/);
});

test('RACE-14: uloskirjautuminen sulkee vahvistusdialogit ja nollaa lähetysmuistin', () => {
  const main = readCode('src/app/main.js');
  const signOut = main.slice(main.indexOf('function onSignedOut'), main.indexOf('async function start'));
  assert.match(signOut, /closeConfirmDialogs\(\);/);
  assert.match(signOut, /resetAlignmentSession\(\);/);
  assert.ok(signOut.indexOf('closeConfirmDialogs()') < signOut.indexOf('resetState()'));
});

// ============================================================ F6 epäonnistunut lataus

test('F6 KRIITTINEN: epäonnistunut ensimmäinen lataus näyttää silti jonossa odottavat tehtävät', async () => {
  setUser(USER);
  offline.activate(USER.id);
  const queued = offline.enqueueTaskCreate(normalizeTask({ id: 'q-task', title: 'Offline lisätty', date: '2026-09-21' }));
  assert.equal(queued.ok, true);
  setClient(fakeClient({ data: null, error: { message: 'Failed to fetch' } }));
  const first = await loadUserData();
  assert.equal(first.tasksOk, false);
  assert.deepEqual(getState().tasks.map(task => task.id), ['q-task'], 'jonossa oleva tehtävä ei näkynyt');
  await loadUserData();
  assert.deepEqual(getState().tasks.map(task => task.id), ['q-task'], 'toinen epäonnistunut lataus monisti tehtävän');
  offline.purge(USER.id);
});

test('F6: epäonnistunut aikakirjausten haku näyttää lähtökorin (portti auki) eikä monista', async () => {
  setUser(USER);
  saveOutbox(USER.id, [normalizeTimeEntry({ id: 'q-entry', entryDate: '2026-09-21', minutes: 30, operationId: 'log:q-entry' })]);
  setClient(fakeClient({ data: null, error: { message: 'Failed to fetch' } }));
  await loadUserData();
  await loadUserData();
  if (isGateOpen('timeEntries')) {
    assert.deepEqual(getState().timeEntries.map(entry => entry.id), ['q-entry']);
  } else {
    // Portti kiinni: kirjaukset ovat muistivarastossa eikä lähtökoria
    // käytetä (withPendingTimeEntries ei yhdistä). Haku onnistuu tyhjänä.
    assert.deepEqual(getState().timeEntries, []);
  }
  const actions = readCode('src/app/actions.js');
  assert.match(actions, /if \(!entriesResult\.ok\) \{[\s\S]*?withPendingTimeEntries\(current\)/,
    'epäonnistunut haku ei yhdistä lähtökoria');
});
