// Verkon palautumisen ohjain: milloin ja kuinka monta kertaa rinnakkain
// data päivitetään uudelleen.
//
// KAIKKI AJASTUS ON INJEKTOITU. Ei odoteta oikeita millisekunteja --
// setTimeout/clearTimeout korvataan käsin ohjattavalla vale-ajastimella,
// jotta testit ovat deterministisiä ja nopeita (ks. mission-ohje: älä
// käytä oikeaa nukkumista testeissä).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readCode } from './helpers/sources.mjs';
import {
  createReconnectController, REFRESH_REASON, MIN_REFRESH_INTERVAL_MS
} from '../src/app/reconnect.js';
import { bindLifecycle, resetLifecycleBinding, RESUME_DEDUP_MS } from '../src/platform/lifecycle.js';

/** Käsin ohjattava ajastin: yksi odottava kutsu, joka laukaistaan tick():llä. */
function fakeTimers() {
  const pending = new Map();
  let nextId = 1;
  return {
    setTimeoutFn(fn, ms) {
      const id = nextId++;
      pending.set(id, fn);
      return id;
    },
    clearTimeoutFn(id) {
      pending.delete(id);
    },
    tick() {
      const fns = [...pending.values()];
      pending.clear();
      for (const fn of fns) fn();
    },
    pendingCount() { return pending.size; }
  };
}

function flush() {
  // Antaa mikrotehtäville (then-ketjuille) tilaisuuden edetä.
  return new Promise(resolve => setImmediate(resolve));
}

test('online-siirtymä ajastaa täsmälleen yhden päivityksen', async () => {
  const timers = fakeTimers();
  let calls = 0;
  const controller = createReconnectController({
    onRefresh: async () => { calls += 1; },
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn
  });

  controller.notifyOffline();
  controller.notifyOnline();
  assert.equal(timers.pendingCount(), 1, 'offline->online ajastaa päivityksen');

  timers.tick();
  await flush();
  assert.equal(calls, 1);
});

test('toistuva online-tapahtuma samassa tilassa ei ajasta uutta kierrosta', async () => {
  const timers = fakeTimers();
  let calls = 0;
  const controller = createReconnectController({
    onRefresh: async () => { calls += 1; },
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn
  });

  controller.notifyOffline();
  controller.notifyOnline();
  controller.notifyOnline(); // sama tila, ei uutta siirtymää
  controller.notifyOnline();
  assert.equal(timers.pendingCount(), 1, 'peräkkäiset online-kutsut eivät saa kasata useita ajastimia');

  timers.tick();
  await flush();
  assert.equal(calls, 1);
});

test('nopea flappaus (online/offline/online) ajastaa vain yhden päivityksen', async () => {
  const timers = fakeTimers();
  let calls = 0;
  const controller = createReconnectController({
    onRefresh: async () => { calls += 1; },
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn
  });

  controller.notifyOffline();
  controller.notifyOnline();
  controller.notifyOffline(); // peruu odottavan ajastimen
  controller.notifyOnline();  // ajastaa uuden
  assert.equal(timers.pendingCount(), 1);

  timers.tick();
  await flush();
  assert.equal(calls, 1, 'flappaus ei saa käynnistää useaa päivitystä');
});

test('päällekkäinen pyyntö kesken päivityksen ei käynnistä rinnakkaista hakua eikä turhaa perään', async () => {
  const timers = fakeTimers();
  let running = 0;
  let maxConcurrent = 0;
  let calls = 0;
  const resolvers = [];

  const controller = createReconnectController({
    onRefresh: async () => {
      calls += 1;
      running += 1;
      maxConcurrent = Math.max(maxConcurrent, running);
      await new Promise(resolve => resolvers.push(resolve));
      running -= 1;
    },
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn
  });

  controller.notifyOffline();
  controller.notifyOnline();
  timers.tick(); // käynnistää ensimmäisen päivityksen, joka jää roikkumaan
  await flush();
  assert.equal(controller.isRefreshing(), true);

  // Sovellus palaa etualalle kesken ensimmäisen päivityksen: käynnissä
  // oleva päivitys alkoi verkon palattua, joten se kattaa paluun (CRIT-02).
  assert.equal(controller.refreshNow({ reason: REFRESH_REASON.RESUME }), 'skipped');
  assert.equal(controller.refreshNow(), 'skipped', 'nimenomainen pyyntö ei myöskään jonoudu kesken olevan perään');
  await flush();
  assert.equal(maxConcurrent, 1, 'toinen pyyntö ei saa käynnistää rinnakkaista Promise.all-vyöryä');
  assert.equal(calls, 1, 'toinen pyyntö ei käynnisty');

  resolvers.shift()(); // ensimmäinen valmistuu
  await flush();
  await flush();
  assert.equal(calls, 1, 'ei toista täyttä latausta perään');
  assert.equal(controller.isRefreshing(), false);
  assert.equal(maxConcurrent, 1);
});

// ============================================================ CRIT-02 päivitysryöppy

/** Käsin ohjattava kello ja ajastin: now() ja tick() ilman oikeaa odotusta. */
function fakeClock(start = 1_000_000) {
  let now = start;
  const timers = fakeTimers();
  return {
    ...timers,
    now: () => now,
    advance(ms) { now += ms; }
  };
}

/** Ohjain, jonka päivitykset jäävät roikkumaan kunnes release() kutsutaan. */
function controlledController(clock, options = {}) {
  const pending = [];
  let calls = 0;
  const controller = createReconnectController({
    onRefresh: () => {
      calls += 1;
      return new Promise(resolve => pending.push(resolve));
    },
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    ...options
  });
  return {
    controller,
    calls: () => calls,
    async release() {
      await flush(); // onRefresh kutsutaan mikrotehtävässä
      const resolve = pending.shift();
      if (resolve) resolve();
      await flush();
      await flush();
    }
  };
}

test('CRIT-02 (a): kaksi paluuta 10 ms:n välein = täsmälleen yksi päivitys', async () => {
  const clock = fakeClock();
  const c = controlledController(clock);
  assert.equal(c.controller.refreshNow({ reason: REFRESH_REASON.RESUME }), 'started');
  clock.advance(10);
  assert.equal(c.controller.refreshNow({ reason: REFRESH_REASON.RESUME }), 'skipped');
  await flush();
  assert.equal(c.calls(), 1);
  await c.release();
  assert.equal(c.calls(), 1, 'toinen paluu ei jonoutunut perään');
  assert.equal(c.controller.isRefreshing(), false);
});

test('CRIT-02 (b): paluu 5 s valmistuneen päivityksen jälkeen ei päivitä; 31 s jälkeen päivittää', async () => {
  const clock = fakeClock();
  const c = controlledController(clock);
  c.controller.refreshNow({ reason: REFRESH_REASON.RESUME });
  await c.release();
  assert.equal(c.calls(), 1);

  clock.advance(5000);
  assert.equal(c.controller.refreshNow({ reason: REFRESH_REASON.RESUME }), 'skipped');
  await flush();
  assert.equal(c.calls(), 1, 'nopea sovellusten vaihto ei lataa kaikkea uudelleen');

  clock.advance(26_000); // 31 s ensimmäisen päivityksen ALUSTA
  assert.ok(MIN_REFRESH_INTERVAL_MS <= 31_000);
  assert.equal(c.controller.refreshNow({ reason: REFRESH_REASON.RESUME }), 'started');
  await c.release();
  assert.equal(c.calls(), 2);
});

test('CRIT-02 (b): väli mitataan päivityksen ALUSTA, ei lopusta', async () => {
  const clock = fakeClock();
  const c = controlledController(clock);
  c.controller.refreshNow({ reason: REFRESH_REASON.RESUME });
  clock.advance(29_000); // hidas lataus
  await c.release();
  clock.advance(2000); // 31 s alusta, 2 s lopusta
  assert.equal(c.controller.refreshNow({ reason: REFRESH_REASON.RESUME }), 'started');
});

test('CRIT-02 (c): verkon palautuminen kesken paluun päivityksen = täsmälleen yksi perään ajettava', async () => {
  const clock = fakeClock();
  const c = controlledController(clock);
  c.controller.refreshNow({ reason: REFRESH_REASON.RESUME }); // alkaa (ehkä ilman verkkoa)
  await flush();
  c.controller.notifyOffline();
  c.controller.notifyOnline();
  c.controller.notifyOffline(); // flappaus
  c.controller.notifyOnline();
  clock.tick(); // debounce laukeaa kesken päivityksen
  await flush();
  assert.equal(c.calls(), 1, 'ei rinnakkaista päivitystä');

  await c.release(); // ensimmäinen valmistuu -> yksi perään
  assert.equal(c.calls(), 2, 'palautumisen jälkeen haetaan kerran uudelleen');
  // Toinen paluu kesken perään ajettavan ei lisää kolmatta.
  c.controller.refreshNow({ reason: REFRESH_REASON.RESUME });
  await c.release();
  assert.equal(c.calls(), 2);
  assert.equal(c.controller.isRefreshing(), false);
});

test('CRIT-02: verkon palautuminen ei päivitä toista kertaa, jos päivitys alkoi palautumisen jälkeen', async () => {
  const clock = fakeClock();
  const c = controlledController(clock, { initialOnline: false });
  c.controller.notifyOnline(); // debounce odottaa
  c.controller.refreshNow({ reason: REFRESH_REASON.RESUME }); // paluu samaan aikaan
  await c.release();
  clock.tick(); // debounce laukeaa päivityksen JÄLKEEN
  await flush();
  assert.equal(c.calls(), 1, 'resume + online = yksi täysi päivitys');
});

test('CRIT-02: ensimmäinen online-siirtymä offline-käynnistyksen jälkeen päivittää aina', async () => {
  const clock = fakeClock();
  const c = controlledController(clock, { initialOnline: false });
  c.controller.noteRefreshStarted(); // kirjautumisen lataus offline-tilassa
  clock.advance(1000);
  c.controller.notifyOnline();
  clock.tick();
  await flush();
  assert.equal(c.calls(), 1, 'verkotta alkanut lataus ei kata palautumista');
});

test('CRIT-02: käyttäjän pyyntö, skeeman palautuminen ja uusinta eivät odota vähimmäisväliä', async () => {
  const clock = fakeClock();
  const c = controlledController(clock);
  c.controller.refreshNow({ reason: REFRESH_REASON.RESUME });
  await c.release();
  clock.advance(1000);
  assert.equal(c.controller.refreshNow({ reason: REFRESH_REASON.MANUAL }), 'started');
  await c.release();
  clock.advance(1000);
  assert.equal(c.controller.refreshNow({ reason: REFRESH_REASON.SCHEMA }), 'started');
  await c.release();
  clock.advance(1000);
  c.controller.refreshLater(10_000);
  clock.tick();
  await c.release();
  assert.equal(c.calls(), 4);
});

test('CRIT-02: skeeman palautuminen kesken päivityksen ajetaan perään (vanhat kyvykkyydet)', async () => {
  const clock = fakeClock();
  const c = controlledController(clock);
  c.controller.refreshNow({ reason: REFRESH_REASON.RESUME });
  assert.equal(c.controller.refreshNow({ reason: REFRESH_REASON.SCHEMA }), 'queued');
  await c.release();
  assert.equal(c.calls(), 2);
  await c.release();
  assert.equal(c.controller.isRefreshing(), false);
});

test('CRIT-02: kirjautumisen lataus (noteRefreshStarted) kattaa heti perään tulevan paluun', async () => {
  const clock = fakeClock();
  const c = controlledController(clock);
  c.controller.noteRefreshStarted();
  clock.advance(5000);
  assert.equal(c.controller.refreshNow({ reason: REFRESH_REASON.RESUME }), 'skipped');
  assert.equal(c.calls(), 0);
});

test('CRIT-02: main.js kertoo paluun ja skeeman syyn sekä kirjaa jokaisen täyden latauksen ohjaimelle', () => {
  const main = readCode('src/app/main.js');
  assert.match(main, /reconnect\.refreshNow\(\{ reason: REFRESH_REASON\.RESUME \}\)/);
  // Palautuskoukku herättää ensin odottavat osat ja päivittää sitten syyllä SCHEMA.
  assert.match(main, /initSchemaStatus\(\{\s*onRecovered: \(\) => \{?[\s\S]{0,240}?reconnect\.refreshNow\(\{ reason: REFRESH_REASON\.SCHEMA \}\)/);
  const loadFresh = main.slice(main.indexOf('async function loadFresh'), main.indexOf('\n}', main.indexOf('async function loadFresh')));
  assert.ok(loadFresh.indexOf('reconnect.noteRefreshStarted()') > -1
    && loadFresh.indexOf('reconnect.noteRefreshStarted()') < loadFresh.indexOf('await loadUserData()'));
  assert.equal((main.match(/reconnect\.refreshNow\(\)/g) || []).length, 0, 'jokaisella kutsulla on syy');
});

test('CRIT-02: kirjautumisen lähetys ei käynnistä toista täyttä latausta (sendPending-vahti)', () => {
  // Synkronoinnin jälkeinen lataus (setSyncedHandler) ohitetaan, kun
  // lähetys on kesken: kirjautuminen lataa kerran lähetyksen jälkeen.
  const main = readCode('src/app/main.js');
  const signedIn = main.slice(main.indexOf('async function onSignedIn'), main.indexOf('function onSignedOut'));
  assert.match(signedIn, /await sendPending\(\);/);
  assert.ok(signedIn.indexOf('await sendPending()') < signedIn.indexOf('await loadFresh()'));
  assert.equal(/offline\.replay\(/.test(signedIn), false, 'toisto vain sendPendingin kautta');
  const send = main.slice(main.indexOf('async function sendPending'), main.indexOf('\n}', main.indexOf('async function sendPending')));
  assert.ok(send.indexOf('sendingPending += 1') < send.indexOf('offline.replay('));
  assert.match(send, /finally \{\s*sendingPending -= 1;/);
  const synced = main.slice(main.indexOf('setSyncedHandler('));
  assert.match(synced, /if \(!signedIn \|\| sendingPending > 0\) return;/);
});

// ============================================================ elinkaari: yksi paluu

const ORIGINAL_CAPACITOR = globalThis.Capacitor;
const ORIGINAL_DOCUMENT = globalThis.document;

/** Natiivikuori ja document, joiden tapahtumat laukaistaan käsin. */
function installLifecycleShell() {
  const appListeners = {};
  const docListeners = {};
  globalThis.Capacitor = {
    isNativePlatform: () => true,
    Plugins: { App: { addListener: (event, fn) => { (appListeners[event] ||= []).push(fn); } } }
  };
  globalThis.document = {
    hidden: false,
    addEventListener: (event, fn) => { (docListeners[event] ||= []).push(fn); }
  };
  return {
    app: event => (appListeners[event] || []).forEach(fn => fn()),
    visibility: hidden => {
      globalThis.document.hidden = hidden;
      (docListeners.visibilitychange || []).forEach(fn => fn());
    }
  };
}

function restoreLifecycleShell() {
  if (ORIGINAL_CAPACITOR === undefined) delete globalThis.Capacitor;
  else globalThis.Capacitor = ORIGINAL_CAPACITOR;
  if (ORIGINAL_DOCUMENT === undefined) delete globalThis.document;
  else globalThis.document = ORIGINAL_DOCUMENT;
  resetLifecycleBinding();
}

test('CRIT-02 elinkaari: App resume + visibilitychange 50 ms:n sisällä = yksi onResume', () => {
  resetLifecycleBinding();
  const shell = installLifecycleShell();
  let now = 5_000;
  let resumed = 0;
  let paused = 0;
  try {
    bindLifecycle({ onResume: () => { resumed += 1; }, onPause: () => { paused += 1; }, now: () => now });
    shell.app('resume');
    now += 50;
    shell.visibility(false);
    assert.equal(resumed, 1, 'yksi paluu kahdesta lähteestä');

    now += RESUME_DEDUP_MS; // seuraava oikea paluu
    shell.visibility(false);
    assert.equal(resumed, 2);
    shell.visibility(true);
    shell.app('pause');
    assert.equal(paused, 2, 'pause-käsittely ennallaan');
  } finally {
    restoreLifecycleShell();
  }
});

test('CRIT-02 elinkaari + ohjain: yksi paluu natiivissa = yksi täysi päivitys (oli 2)', async () => {
  resetLifecycleBinding();
  const shell = installLifecycleShell();
  const clock = fakeClock();
  const c = controlledController(clock);
  try {
    bindLifecycle({ onResume: () => c.controller.refreshNow({ reason: REFRESH_REASON.RESUME }), now: clock.now });
    shell.app('resume');
    clock.advance(40);
    shell.visibility(false);
    await c.release();
    assert.equal(c.calls(), 1);
  } finally {
    restoreLifecycleShell();
  }
});

test('cancelPending peruuttaa odottavan ajastuksen uloskirjautuessa', async () => {
  const timers = fakeTimers();
  let calls = 0;
  const controller = createReconnectController({
    onRefresh: async () => { calls += 1; },
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn
  });

  controller.notifyOffline();
  controller.notifyOnline();
  assert.equal(timers.pendingCount(), 1);

  controller.cancelPending();
  assert.equal(timers.pendingCount(), 0, 'uloskirjautuminen ei saa jättää päivitystä roikkumaan');
});

test('epäonnistunut päivitys ei kaada kutsujaa eikä estä seuraavaa kierrosta', async () => {
  const timers = fakeTimers();
  let attempt = 0;
  const controller = createReconnectController({
    onRefresh: async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('verkko poikki');
    },
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn
  });

  controller.notifyOffline();
  controller.notifyOnline();
  timers.tick();
  await flush();
  await flush();
  assert.equal(attempt, 1);
  assert.equal(controller.isRefreshing(), false, 'epäonnistuminen ei saa jättää ohjainta jumiin');

  controller.notifyOffline();
  controller.notifyOnline();
  timers.tick();
  await flush();
  assert.equal(attempt, 2, 'seuraava yritys onnistuu normaalisti');
});
