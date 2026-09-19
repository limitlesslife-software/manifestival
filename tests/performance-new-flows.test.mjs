// Suorituskyky- ja vuotoinvariantit uusille virroille.
//
// Etsitään: päällekkäiset uudelleenyhteydet, kaksoissuoritus, toistuvat
// sijaintipyynnöt, toistoryöpyt, kuuntelijavuodot ja loputtomat ajastimet.
// Aikaa ohjataan keinokellolla; yhtään oikeaa odotusta ei tehdä.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { read, readCode } from './helpers/sources.mjs';
import { createReconnectController, RECONNECT_DEBOUNCE_MS } from '../src/app/reconnect.js';
import { getCurrentLocation, resetGeolocationForTests } from '../src/platform/geolocation.js';
import { singleFlight } from '../src/ui/dom.js';

/** Keinokello: setTimeout/clearTimeout ilman oikeaa odotusta. */
function fakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    setTimeoutFn: (fn, ms) => { const id = nextId++; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimeoutFn: id => timers.delete(id),
    async advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) { timers.delete(id); timer.fn(); }
      }
      // Anna promise-ketjujen edetä.
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
    },
    pending: () => timers.size
  };
}

const NEW_MODULES = [
  'src/app/offline.js', 'src/app/offlineSync.js', 'src/app/offlineStatus.js', 'src/domain/offlineQueue.js',
  'src/data/offlineQueueStore.js', 'src/platform/geolocation.js', 'src/app/accountDeletion.js',
  'src/data/accountDeletionClient.js', 'src/domain/accountDeletionFlow.js', 'src/app/voice.js',
  'src/domain/travel.js'
];

// ----------------------------------------------------- ajastimet ja vuodot

test('KRIITTINEN: yksikään uusi moduuli ei käytä setInterval:ia (ei loputtomia ajastimia)', () => {
  for (const file of NEW_MODULES) {
    assert.equal(/setInterval\s*\(/.test(readCode(file)), false, file);
  }
});

test('jokainen uusi setTimeout puretaan: kutsuja kutsuu clearTimeoutin finally-haarassa', () => {
  const client = readCode('src/data/accountDeletionClient.js');
  assert.match(client, /setTimeout\(/);
  assert.match(client, /finally \{\s*if \(timer\) clearTimeout\(timer\);/);
  // Ajastin luodaan vain tässä tiedostossa uusista moduuleista; offline-jono ja sijainti eivät ajasta.
  for (const file of ['src/app/offlineSync.js', 'src/domain/offlineQueue.js', 'src/platform/geolocation.js']) {
    assert.equal(/setTimeout\(/.test(readCode(file)), false, file);
  }
});

test('puhe: kuuntelijat kytketään vain initVoice()-funktiossa, ei avattaessa, kuunneltaessa tai lähetettäessä', () => {
  const source = readCode('src/app/voice.js');
  const init = source.slice(source.indexOf('export function initVoice'), source.indexOf('export function speechSupported'));
  const outside = source.replace(init, '');
  assert.equal(/addEventListener\(/.test(outside), false, 'kuuntelija initVoice():n ulkopuolella kasautuisi joka avauksella');
  assert.ok((init.match(/addEventListener\(/g) || []).length >= 10);
});

test('tilin poisto: kuuntelijat kytketään render-kierroksella tuoreisiin solmuihin (ei kasaudu vanhoihin)', () => {
  const source = readCode('src/app/accountDeletion.js');
  // innerHTML korvaa solmut, joten wire() kutsutaan vain render():n jälkeen.
  assert.equal((source.match(/\bwire\(\)/g) || []).length, 2, 'määrittely + yksi kutsu render():ssä');
  assert.match(source, /host\.innerHTML = [^;]+;\s*wire\(\);/);
  // Dokumenttitason kuuntelijoita ei lisätä.
  assert.equal(/document\.addEventListener|window\.addEventListener/.test(source), false);
});

test('offline-tila: tilakuuntelija ja verkkokuuntelijat kytketään kerran käynnistyksessä', () => {
  const main = readCode('src/app/main.js');
  assert.equal((main.match(/initOfflineStatus\(\)/g) || []).length, 1);
  const status = readCode('src/app/offlineStatus.js');
  assert.equal((status.match(/addEventListener\(/g) || []).length, 1);
  assert.equal(/window\.addEventListener/.test(status), false);
});

// --------------------------------------------- päällekkäisyys ja ryöpyt

test('KRIITTINEN: verkon "flapping" (50 online/offline-vaihtoa) tuottaa yhden lähetys+lataus-kierroksen oikeassa järjestyksessä', async () => {
  const clock = fakeClock();
  const order = [];
  const controller = createReconnectController({
    // Sama kokoonpano kuin main.js refreshAfterReconnect: lähetä ensin, lataa sitten.
    onRefresh: async () => { order.push('replay'); await Promise.resolve(); order.push('load'); },
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn
  });

  controller.notifyOffline();
  for (let i = 0; i < 50; i += 1) {
    controller.notifyOnline();
    controller.notifyOffline();
  }
  controller.notifyOnline();
  assert.equal(clock.pending(), 1, 'yksi debounce-ajastin, ei viisikymmentä');

  await clock.advance(RECONNECT_DEBOUNCE_MS + 1);
  assert.deepEqual(order, ['replay', 'load']);
  assert.equal(clock.pending(), 0, 'ei jäänyt ajastimia');
});

test('resume + online samaan aikaan: toinen pyyntö odottaa ja ajetaan kerran perään, ei rinnakkain', async () => {
  const clock = fakeClock();
  let running = 0;
  let peak = 0;
  let runs = 0;
  const controller = createReconnectController({
    onRefresh: async () => {
      running += 1; peak = Math.max(peak, running); runs += 1;
      await new Promise(resolve => setImmediate(resolve));
      running -= 1;
    },
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn
  });
  controller.notifyOffline();
  controller.notifyOnline();
  controller.refreshNow(); controller.refreshNow(); controller.refreshNow();
  await clock.advance(RECONNECT_DEBOUNCE_MS + 1);
  // Odota kunnes ketju on valmis (ei kiinteää viivettä: kuormitettu kone hidastaa).
  for (let i = 0; i < 200 && (running > 0 || runs < 2); i += 1) await new Promise(resolve => setTimeout(resolve, 5));
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(peak, 1, 'ei koskaan kahta rinnakkaista päivitystä');
  assert.ok(runs <= 3 && runs >= 2, 'ajokertoja ' + runs);
});

test('sijainti: 50 rinnakkaista pyyntöä = yksi laitekutsu; peräkkäinen tuore välimuisti ei kutsu laitetta', async () => {
  resetGeolocationForTests();
  let calls = 0;
  const adapter = {
    name: 'fake',
    checkPermission: async () => 'granted',
    requestPermission: async () => 'granted',
    getPosition: async () => { calls += 1; await new Promise(resolve => setTimeout(resolve, 5)); return { latitude: 60, longitude: 25, accuracy: 10 }; }
  };
  const now = () => 1_000;
  await Promise.all(Array.from({ length: 50 }, () => getCurrentLocation({ adapter, now })));
  assert.equal(calls, 1);

  for (let i = 0; i < 20; i += 1) await getCurrentLocation({ adapter, now, maxAgeMs: 60_000 });
  assert.equal(calls, 1, 'tuore välimuisti palvelee ilman laitekutsua');
  resetGeolocationForTests();
});

test('singleFlight (puheen ja poiston lähetys): 20 nopeaa kutsua = yksi suoritus', async () => {
  let runs = 0;
  const guarded = singleFlight(async () => { runs += 1; await new Promise(resolve => setTimeout(resolve, 5)); });
  await Promise.all(Array.from({ length: 20 }, () => guarded()));
  assert.equal(runs, 1);
  await guarded();
  assert.equal(runs, 2, 'vapautuu suorituksen jälkeen');
});

test('puheen ja poiston lähetys on suojattu singleFlightillä', () => {
  assert.match(readCode('src/app/voice.js'), /const submitTranscript = singleFlight\(/);
  assert.match(readCode('src/app/accountDeletion.js'), /const submitDeletion = singleFlight\(/);
  assert.match(readCode('src/app/accountDeletion.js'), /const openPreview = singleFlight\(/);
});

test('luokittelua ei toisteta: yksi komento = yksi /api/command-kutsu (ei automaattista uudelleenyritystä)', () => {
  const client = readCode('src/ai/commandClient.js');
  assert.equal((client.match(/doFetch\(/g) || []).length, 1);
  assert.equal(/retry|Retry|for \(let attempt/.test(client), false);
});

test('ilmoitusten resynkronointi on debouncattu ja jonon toisto ei laukaise sitä itse', () => {
  const notifications = readCode('src/app/notifications.js');
  assert.match(notifications, /RESYNC_DEBOUNCE_MS = 2000/);
  assert.match(notifications, /if \(resyncTimer\) clearTimeout\(resyncTimer\)/);
  assert.equal(/syncNotifications|scheduleNotificationResync/.test(readCode('src/app/offlineSync.js')), false,
    'jono ei saa käynnistää ilmoitusten uudelleenajastusta (ryöpyn lähde)');
});

test('offline-toisto ei pollaa: kutsujia on vain kirjautuminen, palautuminen ja käyttäjän tarkistus', () => {
  const callers = [];
  for (const file of ['src/app/main.js', 'src/app/offlineStatus.js', 'src/app/actions.js', 'src/app/auth.js', 'src/app/accountDeletion.js']) {
    if (/offline\.replay\(/.test(readCode(file))) callers.push(file);
  }
  assert.deepEqual(callers.sort(), ['src/app/main.js', 'src/app/offlineStatus.js']);
  const main = readCode('src/app/main.js');
  assert.equal((main.match(/offline\.replay\(/g) || []).length, 2, 'kirjautuminen + reconnect');
});

test('lähtöilmoituksen laskenta on puhdas: sama syöte, sama tulos, ei tilaa', async () => {
  const { departureState } = await import('../src/domain/travel.js');
  const plan = { arrivalDate: '2026-09-20', arrivalTime: '18:00', travelMinutes: 40, arrivalBufferMinutes: 5, preparationMinutes: 0, travelSource: 'manual', destination: 'X' };
  const args = { todayIso: '2026-09-20', nowMinutes: 1000 };
  const first = departureState(plan, args);
  for (let i = 0; i < 1000; i += 1) assert.deepEqual(departureState(plan, args), first);
});

test('suuri jono: 200 operaatiota käsitellään ilman kohtuutonta kustannusta (järjestely ja tilat)', async () => {
  const q = await import('../src/domain/offlineQueue.js');
  let queue = q.emptyQueue('u1');
  for (let i = 0; i < q.MAX_OPERATIONS; i += 1) {
    const created = q.createOperation({ id: 'o' + i, domain: 'tasks', operation: 'create', entityId: 'e' + i, payload: { title: 'T' + i }, now: 1 });
    queue = q.enqueue(queue, created.op).queue;
  }
  const started = Date.now();
  for (let i = 0; i < 200; i += 1) {
    assert.ok(q.nextRunnable(queue, 1));
    q.queueStats(queue);
    q.overlayPending([], queue);
  }
  assert.ok(Date.now() - started < 2000, 'liian hidas: ' + (Date.now() - started) + ' ms');
});
