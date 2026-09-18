// Verkon palautumisen ohjain: milloin ja kuinka monta kertaa rinnakkain
// data päivitetään uudelleen.
//
// KAIKKI AJASTUS ON INJEKTOITU. Ei odoteta oikeita millisekunteja --
// setTimeout/clearTimeout korvataan käsin ohjattavalla vale-ajastimella,
// jotta testit ovat deterministisiä ja nopeita (ks. mission-ohje: älä
// käytä oikeaa nukkumista testeissä).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createReconnectController } from '../src/app/reconnect.js';

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

test('päällekkäinen pyyntö kesken päivityksen ei käynnistä rinnakkaista hakua', async () => {
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

  // Sovellus palaa etualalle kesken ensimmäisen päivityksen.
  controller.refreshNow();
  await flush();
  assert.equal(maxConcurrent, 1, 'toinen pyyntö ei saa käynnistää rinnakkaista Promise.all-vyöryä');
  assert.equal(calls, 1, 'toinen pyyntö odottaa, ei käynnisty vielä');

  resolvers.shift()(); // ensimmäinen valmistuu
  await flush();
  await flush();
  assert.equal(calls, 2, 'jälkikäteen pyydetty päivitys ajetaan kun ensimmäinen valmistuu');
  assert.equal(controller.isRefreshing(), true, 'toinen kierros on nyt käynnissä');

  resolvers.shift()(); // toinen valmistuu
  await flush();
  await flush();
  assert.equal(controller.isRefreshing(), false);
  assert.equal(maxConcurrent, 1, 'kumpikaan kierros ei ollut koskaan päällekkäin');
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
