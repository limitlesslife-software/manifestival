// Muistutusten kuittausloki.
//
// Loki on muisti, joka estää toiston: kuitattu "Lähde nyt" ei saa tulla
// uudelleen seuraavassa synkronoinnissa. Testit vartioivat, että loki on
// järjestyksestä riippumaton, rajattu, JSON-kelpoinen ja kestää roskaa.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ACK_EVENT, ACK_EVENTS, MAX_ACK_ENTRIES, MAX_ACK_KEY_LENGTH, MAX_SNOOZE_SPAN_MS,
  emptyAckLog, normalizeAckEvent, normalizeAckLog, recordAck, buildAckLog, ackIndex,
  isHandled, snoozedUntil, snoozedUntilLocal, ackStatus, entryHandled, eventsForIntent
} from '../src/domain/notificationAck.js';
import { readCode } from './helpers/sources.mjs';

const T0 = Date.UTC(2026, 8, 27, 5, 0); // su 27.9.2026 klo 8.00 Helsinki
const MIN = 60000;
const ev = (type, key, atMs, extra = {}) => ({ type, key, atMs, ...extra });

/** Deterministinen sekoitus (ei Math.randomia). */
function shuffled(list, seed) {
  const out = [...list];
  let state = seed >>> 0;
  for (let i = out.length - 1; i > 0; i--) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const j = state % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// ------------------------------------------------------------ perusasiat

test('tapahtumat ovat kiinteä joukko', () => {
  assert.deepEqual([...ACK_EVENTS], ['delivered', 'opened', 'acknowledged', 'snoozed', 'dismissed']);
  assert.ok(Object.isFrozen(ACK_EVENT) && Object.isFrozen(ACK_EVENTS));
});

test('tyhjä loki: mikään ei ole käsitelty eikä torkussa', () => {
  const log = emptyAckLog();
  assert.equal(isHandled(log, 'a'), false);
  assert.equal(snoozedUntil(log, 'a'), null);
  assert.equal(ackStatus(log, 'a'), null);
  assert.deepEqual(log.entries, []);
  assert.ok(Object.isFrozen(log) && Object.isFrozen(log.entries));
});

test('kuittaus ja hylkäys ovat pysyviä käsittelyjä; näyttö ja avaus eivät', () => {
  let log = emptyAckLog();
  log = recordAck(log, ev('delivered', 'd', T0));
  log = recordAck(log, ev('opened', 'o', T0));
  log = recordAck(log, ev('acknowledged', 'k', T0));
  log = recordAck(log, ev('dismissed', 'h', T0));
  assert.equal(isHandled(log, 'd'), false, 'näytetty voi vielä tarvita toimintaa');
  assert.equal(isHandled(log, 'o'), false);
  assert.equal(isHandled(log, 'k'), true);
  assert.equal(isHandled(log, 'h'), true);
  assert.equal(ackStatus(log, 'd'), 'delivered');
  assert.equal(ackStatus(log, 'o'), 'opened');
  assert.equal(ackStatus(log, 'k'), 'acknowledged');
  assert.equal(ackStatus(log, 'h'), 'dismissed');
});

test('kuittaus on lopullinen: myöhempi näyttö tai torkku ei palauta sitä', () => {
  let log = recordAck(emptyAckLog(), ev('acknowledged', 'k', T0));
  log = recordAck(log, ev('delivered', 'k', T0 + MIN));
  log = recordAck(log, ev('snoozed', 'k', T0 + 2 * MIN, { untilMs: T0 + 12 * MIN }));
  assert.equal(isHandled(log, 'k'), true);
  assert.equal(snoozedUntil(log, 'k'), null, 'käsitelty ei ole torkussa');
  assert.equal(ackStatus(log, 'k'), 'acknowledged');
});

test('torkku: päättymishetki ja paikallinen aika; pisin torkku voittaa', () => {
  let log = recordAck(emptyAckLog(), ev('snoozed', 's', T0,
    { untilMs: T0 + 10 * MIN, untilLocal: { date: '2026-09-27', time: '08:10' } }));
  assert.equal(snoozedUntil(log, 's'), T0 + 10 * MIN);
  assert.deepEqual(snoozedUntilLocal(log, 's'), { date: '2026-09-27', time: '08:10' });
  assert.equal(ackStatus(log, 's'), 'snoozed');

  log = recordAck(log, ev('snoozed', 's', T0 + 11 * MIN,
    { untilMs: T0 + 20 * MIN, untilLocal: { date: '2026-09-27', time: '08:20' } }));
  assert.equal(snoozedUntil(log, 's'), T0 + 20 * MIN);
  assert.deepEqual(snoozedUntilLocal(log, 's'), { date: '2026-09-27', time: '08:20' });
  assert.equal(log.entries[0].snoozeCount, 2);

  // Myöhässä saapuva vanha torkku ei lyhennä torkkua.
  log = recordAck(log, ev('snoozed', 's', T0, { untilMs: T0 + 10 * MIN,
    untilLocal: { date: '2026-09-27', time: '08:10' } }));
  assert.equal(snoozedUntil(log, 's'), T0 + 20 * MIN);
  assert.deepEqual(snoozedUntilLocal(log, 's'), { date: '2026-09-27', time: '08:20' });
});

test('torkku vaatii järkevän päättymishetken', () => {
  for (const untilMs of [undefined, null, T0, T0 - MIN, T0 + MAX_SNOOZE_SPAN_MS + 1, NaN, Infinity, '600000']) {
    assert.equal(normalizeAckEvent(ev('snoozed', 's', T0, { untilMs })), null, String(untilMs));
  }
  assert.ok(normalizeAckEvent(ev('snoozed', 's', T0, { untilMs: T0 + MAX_SNOOZE_SPAN_MS })));
  const withBadLocal = normalizeAckEvent(ev('snoozed', 's', T0, { untilMs: T0 + MIN,
    untilLocal: { date: '2026-02-30', time: '08:00' } }));
  assert.equal(withBadLocal.untilLocal, null, 'mahdoton päivä ei kelpaa paikalliseksi ajaksi');
});

// ------------------------------------------------------------ järjestys

test('KRIITTINEN: sama tapahtumajoukko tuottaa saman lokin missä järjestyksessä tahansa', () => {
  const events = [];
  for (let i = 0; i < 40; i++) {
    const key = 'k' + (i % 7);
    events.push(ev(ACK_EVENTS[i % 5], key, T0 + i * MIN,
      i % 5 === 3 ? { untilMs: T0 + (i + 5) * MIN, untilLocal: { date: '2026-09-27', time: '09:' + String(10 + i).padStart(2, '0') } } : {}));
  }
  const expected = JSON.stringify(buildAckLog(events));
  for (let seed = 1; seed <= 20; seed++) {
    assert.equal(JSON.stringify(buildAckLog(shuffled(events, seed))), expected, 'siemen ' + seed);
  }
});

test('yksittäinen kirjaus ja koko listan rakennus päätyvät samaan käsittelytilaan', () => {
  const events = [
    ev('delivered', 'a', T0), ev('acknowledged', 'a', T0 + MIN),
    ev('delivered', 'b', T0), ev('snoozed', 'b', T0 + MIN, { untilMs: T0 + 9 * MIN }),
    ev('dismissed', 'c', T0 + 3 * MIN)
  ];
  const stepwise = events.reduce(recordAck, emptyAckLog());
  const batch = buildAckLog(events);
  assert.deepEqual(stepwise, batch);
});

// ------------------------------------------------------------ rajat

test('loki on rajattu: vanhin avain poistuu ensin', () => {
  const events = [];
  for (let i = 0; i < MAX_ACK_ENTRIES + 25; i++) events.push(ev('delivered', 'k' + i, T0 + i * MIN));
  const log = buildAckLog(events);
  assert.equal(log.entries.length, MAX_ACK_ENTRIES);
  assert.equal(ackStatus(log, 'k0'), null, 'vanhin poistui');
  assert.equal(ackStatus(log, 'k24'), null);
  assert.equal(ackStatus(log, 'k25'), 'delivered');
  assert.equal(ackStatus(log, 'k' + (MAX_ACK_ENTRIES + 24)), 'delivered');

  // Uusi tapahtuma vanhalle avaimelle pitää sen hengissä.
  let touched = recordAck(log, ev('acknowledged', 'k25', T0 + 10_000 * MIN));
  touched = recordAck(touched, ev('delivered', 'uusi', T0 + 10_001 * MIN));
  assert.equal(touched.entries.length, MAX_ACK_ENTRIES);
  assert.equal(isHandled(touched, 'k25'), true, 'juuri käsitelty ei poistu');
  assert.equal(ackStatus(touched, 'k26'), null, 'seuraavaksi vanhin poistui');
});

test('avaimen pituus on rajattu', () => {
  assert.ok(normalizeAckEvent(ev('delivered', 'x'.repeat(MAX_ACK_KEY_LENGTH), T0)));
  assert.equal(normalizeAckEvent(ev('delivered', 'x'.repeat(MAX_ACK_KEY_LENGTH + 1), T0)), null);
  assert.equal(normalizeAckEvent(ev('delivered', '', T0)), null);
});

// ------------------------------------------------------------ JSON

test('JSON-kelpoinen: tallennus ja luku tuottavat saman lokin', () => {
  const log = buildAckLog([
    ev('delivered', 'departure_leave_now:e1:2026-09-27', T0),
    ev('snoozed', 'meal:m1:2026-09-27', T0, { untilMs: T0 + 15 * MIN, untilLocal: { date: '2026-09-27', time: '08:15' } }),
    ev('acknowledged', 'digest:2026-09-27:abc', T0 + MIN)
  ]);
  const roundTrip = normalizeAckLog(JSON.parse(JSON.stringify(log)));
  assert.deepEqual(roundTrip, log);
  assert.equal(JSON.stringify(roundTrip), JSON.stringify(log));
});

test('tallennettu loki voi sisältää saman avaimen kahdesti: yhdistetään, ei kahdenneta', () => {
  const raw = { version: 1, entries: [
    { key: 'a', deliveredAt: T0 + MIN, acknowledgedAt: null },
    { key: 'a', deliveredAt: T0, acknowledgedAt: T0 + 5 * MIN }
  ] };
  const log = normalizeAckLog(raw);
  assert.equal(log.entries.length, 1);
  assert.equal(log.entries[0].deliveredAt, T0, 'ensimmäinen näyttö');
  assert.equal(isHandled(log, 'a'), true);
});

// ------------------------------------------------------------ roskasyöte

test('roskasyöte ei koskaan heitä ja tuottaa tyhjän tai siivotun lokin', () => {
  const hostile = {};
  Object.defineProperty(hostile, 'entries', { get() { throw new Error('getteri'); } });
  const hostileEvent = {};
  Object.defineProperty(hostileEvent, 'type', { get() { throw new Error('getteri'); } });

  for (const raw of [undefined, null, 0, 'loki', [], {}, { entries: 'x' }, { entries: [null, 1, 'a', {}] },
    { entries: [{ key: 5 }, { key: '' }, { key: 'ok', deliveredAt: 'eilen' }] }, hostile,
    { entries: [{ key: '__proto__', acknowledgedAt: T0 }] }]) {
    assert.doesNotThrow(() => normalizeAckLog(raw));
    const log = normalizeAckLog(raw);
    assert.ok(Array.isArray(log.entries));
  }
  const proto = normalizeAckLog({ entries: [{ key: '__proto__', acknowledgedAt: T0 }] });
  assert.equal(isHandled(proto, '__proto__'), true, '__proto__ on vain avain, ei prototyyppi');
  assert.equal({}.acknowledgedAt, undefined, 'prototyyppi ei saastunut');

  for (const event of [undefined, null, 'x', {}, ev('tuntematon', 'a', T0), ev('delivered', null, T0),
    ev('delivered', 'a', -1), ev('delivered', 'a', NaN), ev('delivered', 'a', '123'), hostileEvent]) {
    assert.doesNotThrow(() => recordAck(emptyAckLog(), event));
    assert.equal(recordAck(emptyAckLog(), event).entries.length, 0);
  }
  assert.doesNotThrow(() => buildAckLog('ei lista'));
  assert.doesNotThrow(() => isHandled(null, 'a'));
  assert.doesNotThrow(() => snoozedUntil(undefined, 5));
  assert.equal(isHandled(null, 'a'), false);
});

test('syötettä ei muuteta', () => {
  const events = [ev('delivered', 'a', T0), ev('snoozed', 'b', T0, { untilMs: T0 + MIN, untilLocal: { date: '2026-09-27', time: '08:01' } })];
  const snapshot = JSON.stringify(events);
  const log = buildAckLog(events);
  const logSnapshot = JSON.stringify(log);
  recordAck(log, ev('acknowledged', 'a', T0 + MIN));
  assert.equal(JSON.stringify(events), snapshot);
  assert.equal(JSON.stringify(log), logSnapshot, 'kirjaus palauttaa uuden lokin');
  assert.ok(log.entries.every(Object.isFrozen));
});

// ------------------------------------------------------------ aikomukset

test('koosteen kuittaus kuittaa myös sen sisältämät muistutukset; torkku vain koosteen', () => {
  const digest = { id: 'digest:kooste:2026-09-27', ackKey: 'digest:2026-09-27:abc',
    mergedAckKeys: ['deadline_warning:t1:2026-09-27', 'daily_plan:2026-09-27:2026-09-27'] };
  const acks = eventsForIntent(digest, 'acknowledged', { atMs: T0 });
  assert.deepEqual(acks.map(e => e.key), ['digest:2026-09-27:abc', ...digest.mergedAckKeys]);
  const snoozes = eventsForIntent(digest, 'snoozed', { atMs: T0, untilMs: T0 + 10 * MIN });
  assert.deepEqual(snoozes.map(e => e.key), ['digest:2026-09-27:abc']);
  assert.deepEqual([...eventsForIntent({ id: 'x' }, 'delivered', { atMs: T0 })].map(e => e.key), ['x'],
    'ilman ackKeytä käytetään tunnistetta');
  assert.deepEqual([...eventsForIntent(null, 'delivered', { atMs: T0 })], []);
  assert.deepEqual([...eventsForIntent({ id: 'x' }, 'delivered', null)], [], 'ilman aikaleimaa ei tapahtumaa');
});

test('hakemisto nopeaan hakuun ja entryHandled', () => {
  const log = buildAckLog([ev('acknowledged', 'a', T0), ev('delivered', 'b', T0)]);
  const index = ackIndex(log);
  assert.ok(index instanceof Map);
  assert.equal(isHandled(index, 'a'), true);
  assert.equal(isHandled(index, 'b'), false);
  assert.equal(entryHandled(index.get('a')), true);
  assert.equal(entryHandled(null), false);
});

test('SUORITUSKYKY: kymmenientuhansien tapahtumien loki rakentuu nopeasti', () => {
  const events = [];
  for (let i = 0; i < 50_000; i++) {
    events.push(ev(ACK_EVENTS[i % 5], 'k' + (i % 900), T0 + i * 1000,
      i % 5 === 3 ? { untilMs: T0 + i * 1000 + 5 * MIN } : {}));
  }
  const started = performance.now();
  const log = buildAckLog(events);
  const elapsed = performance.now() - started;
  assert.equal(log.entries.length, MAX_ACK_ENTRIES);
  assert.ok(elapsed < 2000, `kesti ${Math.round(elapsed)} ms`);
});

test('PUHTAUS: ei kelloa, ei tallennusta', () => {
  const source = readCode('src/domain/notificationAck.js');
  for (const forbidden of ['Date.now(', 'new Date(', 'localStorage', 'Math.random', 'console.']) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});
