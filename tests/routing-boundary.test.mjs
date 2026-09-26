// Reittitiedon raja (src/domain/routing.js).
//
// PERIAATE: ilman reittipalvelua jokainen kysymys on UNKNOWN -- ei koskaan
// keksittyä kestoa. Palvelun vastaus tarkistetaan suljetusti: puute on
// ERROR, vanhentunut on STALE ilman kestoa.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createTestRouteProvider } from './helpers/routeProvider.mjs';
import {
  ROUTING_STATUS, ROUTING_STATUSES, ROUTING_STATUS_TEXT, routingStatusText, ROUTE_REQUEST_FIELDS, ROUTE_RESULT_FIELDS,
  normalizeRouteRequest, normalizeRouteResponse, routeResultMinutes, isRouteResultFresh, createRoutingRegistry
} from '../src/domain/routing.js';
import {
  ROUTE_STATUS, TRAVEL_PROVIDER_CONTRACT, hasTravelProvider, normalizeRouteResult
} from '../src/domain/travel.js';

const NOW = Date.parse('2026-09-28T13:00:00Z');

const ok = (overrides = {}) => ({
  status: 'OK', durationSeconds: 1830, distanceMeters: 21500.4, trafficAware: true, provider: 'liikenne-x',
  calculatedAt: '2026-09-28T12:58:00Z', validUntil: '2026-09-28T13:20:00Z', confidence: 'high', ...overrides
});

// ------------------------------------------------------------ vakiot

test('tilat ovat samat kuin travel.js:n ROUTE_STATUS, ja jokaisella on suomenkielinen selite', () => {
  assert.equal(ROUTING_STATUS, ROUTE_STATUS);
  assert.deepEqual([...ROUTING_STATUSES], ['OK', 'UNKNOWN', 'STALE', 'ERROR']);
  assert.equal(ROUTING_STATUS_TEXT.UNKNOWN, 'Liikennetietoa ei ole käytössä');
  for (const status of ROUTING_STATUSES) assert.ok(ROUTING_STATUS_TEXT[status]);
  assert.equal(routingStatusText('mitä'), 'Liikennetietoa ei ole käytössä');
  assert.equal(Object.isFrozen(ROUTING_STATUS_TEXT), true);
  assert.deepEqual([...ROUTE_REQUEST_FIELDS], ['origin', 'destination', 'departureTime', 'travelMode']);
  for (const field of ['status', 'durationSeconds', 'distanceMeters', 'trafficAware', 'provider', 'calculatedAt', 'validUntil', 'confidence']) {
    assert.ok(ROUTE_RESULT_FIELDS.includes(field), field);
  }
  for (const text of Object.values(ROUTING_STATUS_TEXT)) assert.equal(/provider|API|status/i.test(text), false, text);
});

test('travel.js:n sopimus pysyy: reittipalvelua ei ole valittu', () => {
  assert.equal(hasTravelProvider(), false);
  assert.equal(typeof TRAVEL_PROVIDER_CONTRACT.estimate, 'undefined');
});

// ------------------------------------------------------------ pyyntö

test('pyyntö: kohde pakollinen, paikka on tekstiä, koordinaatit pudotetaan', () => {
  const request = normalizeRouteRequest({
    origin: '  Koti\n', destination: 'Parturi   Kallio', departureTime: '2026-09-28T14:05:00+03:00', travelMode: 'transit'
  });
  assert.deepEqual({ ...request }, {
    origin: 'Koti', destination: 'Parturi Kallio', departureTime: '2026-09-28T11:05:00.000Z', travelMode: 'transit'
  });
  assert.equal(Object.isFrozen(request), true);
  assert.equal(normalizeRouteRequest({ destination: 'X', origin: { lat: 60.1, lng: 24.9 } }).origin, null);
  assert.equal(normalizeRouteRequest({ destination: 'X', travelMode: 'teleport' }).travelMode, 'driving');
  assert.equal(normalizeRouteRequest({ destination: 'X', departureTime: 'huomenna' }).departureTime, null);
  assert.equal(normalizeRouteRequest({ destination: 'x'.repeat(500) }).destination.length, 300);
  for (const bad of [null, undefined, 'x', 5, [], {}, { destination: '   ' }, { destination: 42 }, { destination: '\u{0}\u{7}' }]) {
    assert.equal(normalizeRouteRequest(bad), null, JSON.stringify(bad));
  }
});

// ------------------------------------------------------------ vastaus

test('kelvollinen vastaus: kaikki kentät, pyöristys ja liikennetieto vain nimenomaisesti', () => {
  const result = normalizeRouteResponse(ok(), { nowMs: NOW });
  assert.deepEqual({ ...result }, {
    status: 'OK', durationSeconds: 1830, distanceMeters: 21500, trafficAware: true, provider: 'liikenne-x',
    calculatedAt: '2026-09-28T12:58:00.000Z', validUntil: '2026-09-28T13:20:00.000Z', confidence: 'high', reason: ''
  });
  assert.equal(Object.isFrozen(result), true);
  for (const trafficAware of [undefined, 'true', 1, null]) {
    assert.equal(normalizeRouteResponse(ok({ trafficAware }), { nowMs: NOW }).trafficAware, false, String(trafficAware));
  }
  assert.equal(normalizeRouteResponse(ok({ distanceMeters: -5 }), { nowMs: NOW }).distanceMeters, null);
  // Vanha kenttänimi freshUntil hyväksytään yhä.
  const legacy = ok({ validUntil: undefined, freshUntil: '2026-09-28T13:20:00Z' });
  assert.equal(normalizeRouteResponse(legacy, { nowMs: NOW }).status, 'OK');
});

test('KRIITTINEN: suljettu epäonnistuminen -- kestoa ei koskaan keksitä', () => {
  const cases = [
    [ok(), undefined, 'ERROR'],
    [ok(), NaN, 'ERROR'],
    [null, NOW, 'ERROR'],
    ['OK', NOW, 'ERROR'],
    [[ok()], NOW, 'ERROR'],
    [{ status: 'UNKNOWN' }, NOW, 'UNKNOWN'],
    [ok({ status: 'ok' }), NOW, 'ERROR'],
    [ok({ status: 'ERROR' }), NOW, 'ERROR'],
    [ok({ durationSeconds: 0 }), NOW, 'ERROR'],
    [ok({ durationSeconds: 0.5 }), NOW, 'ERROR'],
    [ok({ durationSeconds: -10 }), NOW, 'ERROR'],
    [ok({ durationSeconds: '1830' }), NOW, 'ERROR'],
    [ok({ durationSeconds: Infinity }), NOW, 'ERROR'],
    [ok({ durationSeconds: 86401 }), NOW, 'ERROR'],
    [ok({ provider: '' }), NOW, 'ERROR'],
    [ok({ provider: '\u{0}\u{1}' }), NOW, 'ERROR'],
    [ok({ provider: 7 }), NOW, 'ERROR'],
    [ok({ calculatedAt: 'eilen' }), NOW, 'ERROR'],
    [ok({ validUntil: null }), NOW, 'ERROR'],
    [ok({ validUntil: '2026-09-28T12:58:00Z' }), NOW, 'ERROR'],
    [ok({ calculatedAt: '2026-09-28T13:30:00Z', validUntil: '2026-09-28T14:00:00Z' }), NOW, 'ERROR'],
    [ok({ confidence: 'certain' }), NOW, 'ERROR'],
    [ok({ validUntil: '2026-09-28T13:00:00Z' }), NOW, 'STALE'],
    [ok({ validUntil: '2026-09-28T12:59:59Z' }), NOW, 'STALE']
  ];
  for (const [raw, nowMs, status] of cases) {
    const result = normalizeRouteResponse(raw, { nowMs });
    assert.equal(result.status, status, JSON.stringify(raw));
    if (status !== 'OK') {
      assert.equal(result.durationSeconds, null);
      assert.equal(result.trafficAware, false);
      assert.equal(routeResultMinutes(result), null);
      assert.ok(result.reason.length > 0);
    }
  }
  // Kellojen pieni ero sallitaan (laskenta-aika enintään 5 min "tulevaisuudessa").
  assert.equal(normalizeRouteResponse(ok({ calculatedAt: '2026-09-28T13:04:00Z' }), { nowMs: NOW }).status, 'OK');
});

test('vihamielinen vastaus ei kaada: heittävä getteri, välityspalvelin, peruttu välityspalvelin', () => {
  const throwing = { get status() { throw new Error('bumm'); } };
  const proxy = new Proxy({}, { get() { throw new Error('ansa'); } });
  const { proxy: revoked, revoke } = Proxy.revocable({}, {});
  revoke();
  for (const raw of [throwing, proxy, revoked]) {
    assert.doesNotThrow(() => normalizeRouteResponse(raw, { nowMs: NOW }));
    assert.equal(normalizeRouteResponse(raw, { nowMs: NOW }).status, 'ERROR');
    assert.doesNotThrow(() => normalizeRouteRequest(raw));
  }
  assert.doesNotThrow(() => normalizeRouteResponse(ok(), null));
  assert.doesNotThrow(() => normalizeRouteResponse(ok(), 5));
});

test('minuutit pyöristetään ylöspäin; tuoreus tarkistetaan uudelleen joka kerta', () => {
  assert.equal(routeResultMinutes(normalizeRouteResponse(ok({ durationSeconds: 1801 }), { nowMs: NOW })), 31);
  assert.equal(routeResultMinutes(normalizeRouteResponse(ok({ durationSeconds: 60 }), { nowMs: NOW })), 1);
  assert.equal(routeResultMinutes(normalizeRouteResponse(ok({ durationSeconds: 1 }), { nowMs: NOW })), 1);
  assert.equal(routeResultMinutes(null), null);
  assert.equal(routeResultMinutes({ status: 'OK', durationSeconds: 0 }), null);
  const fresh = normalizeRouteResponse(ok(), { nowMs: NOW });
  assert.equal(isRouteResultFresh(fresh, NOW), true);
  assert.equal(isRouteResultFresh(fresh, Date.parse('2026-09-28T13:20:00Z')), false);
  assert.equal(isRouteResultFresh(fresh), false);
});

test('sama tulos kuin travel.js:n normalizeRouteResult samasta syötteestä', () => {
  const legacy = ok({ validUntil: undefined, freshUntil: '2026-09-28T13:20:00Z' });
  const a = normalizeRouteResult(legacy, { nowMs: NOW });
  const b = normalizeRouteResponse(legacy, { nowMs: NOW });
  for (const key of ['status', 'durationSeconds', 'distanceMeters', 'provider', 'calculatedAt', 'confidence']) {
    assert.equal(b[key], a[key], key);
  }
  assert.equal(b.validUntil, a.freshUntil);
});

// ------------------------------------------------------------ rekisteri

test('KRIITTINEN: rekisteri ilman palvelua vastaa aina UNKNOWN -- ei koskaan lukua', async () => {
  for (const registry of [createRoutingRegistry(), createRoutingRegistry({}), createRoutingRegistry(null),
    createRoutingRegistry({ provider: {} }), createRoutingRegistry({ provider: { estimate: 'ei funktio' } })]) {
    assert.equal(registry.hasProvider(), false);
    assert.equal(registry.providerName, null);
    for (const request of [{ destination: 'Parturi Kallio' }, null, 'x', { destination: '' }]) {
      const result = await registry.route(request, { nowMs: NOW });
      assert.equal(result.status, ROUTING_STATUS.UNKNOWN);
      assert.equal(result.durationSeconds, null);
      assert.equal(result.reason, 'Liikennetietoa ei ole käytössä.');
      assert.equal(Object.isFrozen(result), true);
    }
  }
  assert.equal(Object.isFrozen(createRoutingRegistry()), true);
});

test('rekisteri palvelun kanssa: pyyntö normalisoidaan ja vastaus tarkistetaan', async () => {
  const provider = createTestRouteProvider({ table: { 'Koti>Parturi Kallio': 1500 }, now: () => NOW });
  const registry = createRoutingRegistry({ provider: { ...provider, name: 'testi' } });
  assert.equal(registry.hasProvider(), true);
  assert.equal(registry.providerName, 'testi');
  const result = await registry.route({ origin: 'Koti', destination: ' Parturi  Kallio ', travelMode: 'driving' }, { nowMs: NOW });
  assert.equal(result.status, 'OK');
  assert.equal(routeResultMinutes(result), 25);
  assert.deepEqual(provider.calls, [{ origin: 'Koti', destination: 'Parturi Kallio', departureTime: null, travelMode: 'driving' }]);
  // Tuntematon reitti ja kelvoton pyyntö.
  assert.equal((await registry.route({ origin: 'Koti', destination: 'Tuntematon' }, { nowMs: NOW })).status, 'UNKNOWN');
  assert.equal((await registry.route({ origin: 'Koti' }, { nowMs: NOW })).status, 'ERROR');
  assert.equal(provider.calls.length, 2, 'kelvoton pyyntö ei mene palvelulle');
  // Ilman nykyhetkeä tuoreutta ei voi todentaa.
  assert.equal((await registry.route({ origin: 'Koti', destination: 'Parturi Kallio' })).status, 'ERROR');
});

test('rekisteri: palvelun poikkeus, roska, nolla ja vanhentunut eivät tuota kestoa', async () => {
  for (const mode of ['throw', 'garbage', 'zero', 'stale', 'error', 'unknown']) {
    const provider = createTestRouteProvider({ table: { 'Koti>X': 900 }, mode, now: () => NOW });
    const result = await createRoutingRegistry({ provider }).route({ origin: 'Koti', destination: 'X' }, { nowMs: NOW });
    assert.notEqual(result.status, 'OK', mode);
    assert.equal(result.durationSeconds, null, mode);
  }
  const rejecting = { estimate: () => Promise.reject(new Error('verkko')) };
  assert.equal((await createRoutingRegistry({ provider: rejecting }).route({ destination: 'X' }, { nowMs: NOW })).status, 'ERROR');
  const syncThrow = { estimate() { throw new Error('heti'); } };
  assert.equal((await createRoutingRegistry({ provider: syncThrow }).route({ destination: 'X' }, { nowMs: NOW })).status, 'ERROR');
});

test('reittimoduuli ei ota yhteyttä mihinkään eikä tunne koordinaatteja', async () => {
  const { readCode } = await import('./helpers/sources.mjs');
  const code = readCode('src/domain/routing.js');
  assert.equal(/fetch\(|XMLHttpRequest|https?:\/\//.test(code), false);
  assert.equal(/\b(latitude|longitude|lat|lng|coords)\b/.test(code), false);
});
