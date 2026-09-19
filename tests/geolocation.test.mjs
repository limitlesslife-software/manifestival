// Etualan sijainti: lupatilat, kertahaku ja yksityisyysinvariantit.
//
// Kaikki testit käyttävät valesovitinta -- yhtään oikeaa sijaintia ei
// haeta. Yksityisyysväitteet (ei tallennusta, ei lokia, ei vientiä, ei
// tekoälylle) ovat invariantteja, ei toiveita.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { ROOT, read, readCode } from './helpers/sources.mjs';
import {
  LOCATION_PERMISSION, LOCATION_ERROR, MAX_CACHE_MS,
  checkLocationPermission, requestLocationPermission, getCurrentLocation,
  getCachedLocation, clearLocationCache, describeLocationState,
  locationPermissionState, selectAdapter, resetGeolocationForTests
} from '../src/platform/geolocation.js';
import { capability, PERMISSION, CAPABILITY } from '../src/platform/capabilities.js';
import { buildUserDataExport } from '../src/domain/dataExport.js';
import { redactForLog, REDACTED } from '../src/lib/logger.js';

const HELSINKI = { latitude: 60.1699, longitude: 24.9384, accuracy: 18.4, timestamp: 1000 };

/** Valesovitin, joka kirjaa jokaisen kutsun. */
function fakeAdapter({ check = 'prompt', request = 'granted', position = HELSINKI, positionError = null, delayMs = 0 } = {}) {
  const calls = { check: 0, request: 0, position: 0 };
  return {
    calls,
    name: 'fake',
    async checkPermission() { calls.check += 1; return typeof check === 'function' ? check() : check; },
    async requestPermission() { calls.request += 1; return typeof request === 'function' ? request() : request; },
    async getPosition() {
      calls.position += 1;
      if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
      if (positionError) throw positionError;
      return typeof position === 'function' ? position() : position;
    }
  };
}

beforeEach(() => resetGeolocationForTests());

// ---------------------------------------------------------- lupatilat

test('alkutila on "ei pyydetty", ei koskaan "myönnetty"', () => {
  assert.equal(locationPermissionState(), LOCATION_PERMISSION.NOT_REQUESTED);
});

test('tuen puute: ei sovitinta -> unsupported', async () => {
  const result = await checkLocationPermission({ adapter: null });
  assert.equal(result.state, LOCATION_PERMISSION.UNSUPPORTED);
  assert.match(result.reason, /ei tue/i);
});

test('lupatilan luku EI koskaan pyydä lupaa', async () => {
  for (const check of ['prompt', 'granted', 'denied']) {
    const adapter = fakeAdapter({ check });
    await checkLocationPermission({ adapter });
    assert.equal(adapter.calls.request, 0, check);
    assert.equal(adapter.calls.position, 0, check);
  }
});

test('check: granted / prompt / denied / virhe kääntyvät tiloiksi', async () => {
  assert.equal((await checkLocationPermission({ adapter: fakeAdapter({ check: 'granted' }) })).state, LOCATION_PERMISSION.GRANTED);
  assert.equal((await checkLocationPermission({ adapter: fakeAdapter({ check: 'prompt' }) })).state, LOCATION_PERMISSION.PROMPT);
  assert.equal((await checkLocationPermission({ adapter: fakeAdapter({ check: 'prompt-with-rationale' }) })).state, LOCATION_PERMISSION.PROMPT);
  assert.equal((await checkLocationPermission({ adapter: fakeAdapter({ check: 'denied' }) })).state, LOCATION_PERMISSION.DENIED);
  assert.equal((await checkLocationPermission({ adapter: fakeAdapter({ check: 'jotain-outoa' }) })).state, LOCATION_PERMISSION.PROMPT);
  const broken = fakeAdapter({ check: () => { throw new Error('boom'); } });
  assert.equal((await checkLocationPermission({ adapter: broken })).state, LOCATION_PERMISSION.ERROR);
});

test('request: prompt -> granted', async () => {
  const adapter = fakeAdapter({ check: 'prompt', request: 'granted' });
  const result = await requestLocationPermission({ adapter });
  assert.equal(result.state, LOCATION_PERMISSION.GRANTED);
  assert.equal(adapter.calls.request, 1);
});

test('request: jo myönnetty -> ei uutta pyyntöä', async () => {
  const adapter = fakeAdapter({ check: 'granted' });
  assert.equal((await requestLocationPermission({ adapter })).state, LOCATION_PERMISSION.GRANTED);
  assert.equal(adapter.calls.request, 0);
});

test('request: käyttäjä kieltäytyy ensimmäistä kertaa -> denied (ei blocked)', async () => {
  const adapter = fakeAdapter({ check: 'prompt', request: 'denied' });
  assert.equal((await requestLocationPermission({ adapter })).state, LOCATION_PERMISSION.DENIED);
});

test('request: kielto jo ennen pyyntöä ja yhä kielletty -> blocked', async () => {
  const adapter = fakeAdapter({ check: 'denied', request: 'denied' });
  const result = await requestLocationPermission({ adapter });
  assert.equal(result.state, LOCATION_PERMISSION.BLOCKED);
  assert.match(result.reason, /asetuksista/i);
});

test('blocked säilyy blockedina kun tilaa luetaan uudelleen samalla laitteella', async () => {
  await requestLocationPermission({ adapter: fakeAdapter({ check: 'denied', request: 'denied' }) });
  assert.equal((await checkLocationPermission({ adapter: fakeAdapter({ check: 'denied' }) })).state, LOCATION_PERMISSION.BLOCKED);
});

test('request: virhe -> error, ei heitä', async () => {
  const adapter = fakeAdapter({ request: () => { throw new Error('x'); } });
  assert.equal((await requestLocationPermission({ adapter })).state, LOCATION_PERMISSION.ERROR);
  assert.equal((await requestLocationPermission({ adapter: null })).state, LOCATION_PERMISSION.UNSUPPORTED);
});

test('jokaisella tilalla on käyttäjälle näytettävä selitys, myös tuntemattomalla', () => {
  for (const state of Object.values(LOCATION_PERMISSION)) assert.match(describeLocationState(state), /\S/);
  assert.equal(describeLocationState('constructor'), describeLocationState(LOCATION_PERMISSION.ERROR));
});

test('kyvykkyysrekisteri seuraa lupatilaa (ja pysyy rehellisenä)', async () => {
  const before = capability(CAPABILITY.LOCATION);
  assert.notEqual(before.permission, PERMISSION.GRANTED);
  assert.equal(before.available, false);

  await requestLocationPermission({ adapter: fakeAdapter({ check: 'prompt', request: 'denied' }) });
  assert.equal(capability(CAPABILITY.LOCATION).permission, before.supported ? PERMISSION.DENIED : PERMISSION.UNSUPPORTED);
});

// ------------------------------------------------------- kertahaku

test('KRIITTINEN: haku ei avaa lupadialogia ilman allowPrompt-lippua', async () => {
  const adapter = fakeAdapter({ check: 'prompt' });
  const result = await getCurrentLocation({ adapter });
  assert.equal(result.ok, false);
  assert.equal(result.code, LOCATION_ERROR.PERMISSION_REQUIRED);
  assert.equal(adapter.calls.request, 0, 'lupaa ei saa pyytää itsestään');
  assert.equal(adapter.calls.position, 0, 'selain avaisi dialogin paikannuskutsusta');
});

test('allowPrompt: lupa pyydetään kerran ja sijainti haetaan', async () => {
  const adapter = fakeAdapter({ check: 'prompt', request: 'granted' });
  const result = await getCurrentLocation({ adapter, allowPrompt: true });
  assert.equal(result.ok, true);
  assert.equal(adapter.calls.request, 1);
  assert.equal(adapter.calls.position, 1);
});

test('allowPrompt + käyttäjä kieltäytyy -> permission_denied, sijaintia ei haeta', async () => {
  const adapter = fakeAdapter({ check: 'prompt', request: 'denied' });
  const result = await getCurrentLocation({ adapter, allowPrompt: true });
  assert.equal(result.code, LOCATION_ERROR.PERMISSION_DENIED);
  assert.equal(adapter.calls.position, 0);
});

test('KRIITTINEN: estetty lupa ei koskaan yritä uutta pyyntöä eikä hae sijaintia, allowPrompt-lipusta huolimatta', async () => {
  const adapter = fakeAdapter({ check: 'denied' });
  const result = await getCurrentLocation({ adapter, allowPrompt: true });
  assert.equal(result.code, LOCATION_ERROR.PERMISSION_DENIED);
  assert.equal(adapter.calls.request, 0);
  assert.equal(adapter.calls.position, 0);
});

test('ei sovitinta -> unsupported, ei heitä', async () => {
  const result = await getCurrentLocation({ adapter: null });
  assert.deepEqual([result.ok, result.code], [false, LOCATION_ERROR.UNSUPPORTED]);
  assert.ok(result.reason);
});

test('myönnetty lupa: sijainti haetaan kerran ja palautetaan', async () => {
  const adapter = fakeAdapter({ check: 'granted' });
  const result = await getCurrentLocation({ adapter });
  assert.equal(result.ok, true);
  assert.equal(result.position.latitude, HELSINKI.latitude);
  assert.equal(result.position.longitude, HELSINKI.longitude);
  assert.equal(result.position.accuracyMeters, 18);
  assert.equal(adapter.calls.position, 1);
});

test('KRIITTINEN: virheelliset koordinaatit hylätään (NaN, Infinity, alueen ulkopuolella, väärä tyyppi)', async () => {
  for (const bad of [
    { latitude: NaN, longitude: 24 }, { latitude: 60, longitude: Infinity }, { latitude: 91, longitude: 0 },
    { latitude: -91, longitude: 0 }, { latitude: 0, longitude: 181 }, { latitude: '60.1', longitude: '24.9' },
    { latitude: null, longitude: null }, {}, null, undefined, 'sijainti',
    { latitude: 60, longitude: 24, accuracy: -5 }, { latitude: 60, longitude: 24, accuracy: NaN }
  ]) {
    resetGeolocationForTests();
    // Funktiona: `position: undefined` korvautuisi oletusarvolla.
    const result = await getCurrentLocation({ adapter: fakeAdapter({ check: 'granted', position: () => bad }) });
    assert.equal(result.ok, false, JSON.stringify(bad));
    assert.equal(result.code, LOCATION_ERROR.INVALID_POSITION);
    assert.equal(getCachedLocation(), null, 'virheellistä sijaintia ei välimuistiteta');
  }
});

test('laitevirheet kääntyvät koodeiksi eivätkä väitä onnistumista', async () => {
  for (const code of [LOCATION_ERROR.TIMEOUT, LOCATION_ERROR.POSITION_UNAVAILABLE]) {
    resetGeolocationForTests();
    const result = await getCurrentLocation({ adapter: fakeAdapter({ check: 'granted', positionError: { code } }) });
    assert.equal(result.code, code);
  }
  resetGeolocationForTests();
  const unknown = await getCurrentLocation({ adapter: fakeAdapter({ check: 'granted', positionError: new Error('sisäinen SECRET') }) });
  assert.equal(unknown.code, LOCATION_ERROR.UNKNOWN);
  assert.equal(JSON.stringify(unknown).includes('SECRET'), false, 'laitteen virheviestiä ei välitetä');
});

test('permission_denied kesken haun päivittää lupatilan', async () => {
  const adapter = fakeAdapter({ check: 'granted', positionError: { code: LOCATION_ERROR.PERMISSION_DENIED } });
  const result = await getCurrentLocation({ adapter });
  assert.equal(result.code, LOCATION_ERROR.PERMISSION_DENIED);
  assert.equal(locationPermissionState(), LOCATION_PERMISSION.DENIED);
});

test('KRIITTINEN: rinnakkaiset haut jakavat yhden laitekutsun', async () => {
  const adapter = fakeAdapter({ check: 'granted', delayMs: 20 });
  const results = await Promise.all([1, 2, 3, 4, 5].map(() => getCurrentLocation({ adapter })));
  assert.equal(adapter.calls.position, 1, 'laitetta kutsuttiin ' + adapter.calls.position + ' kertaa');
  assert.equal(results.every(result => result.ok), true);
});

test('haun jälkeen seuraava haku on uusi laitekutsu (maxAge 0 = aina tuore)', async () => {
  const adapter = fakeAdapter({ check: 'granted' });
  await getCurrentLocation({ adapter });
  await getCurrentLocation({ adapter });
  assert.equal(adapter.calls.position, 2);
});

test('välimuisti: maxAge sallii tuoreen käytön ilman laitekutsua, ja vanhenee', async () => {
  let clock = 1_000_000;
  const adapter = fakeAdapter({ check: 'granted' });
  await getCurrentLocation({ adapter, now: () => clock });

  clock += 30_000;
  const cachedHit = await getCurrentLocation({ adapter, maxAgeMs: 60_000, now: () => clock });
  assert.equal(cachedHit.ok, true);
  assert.equal(adapter.calls.position, 1, 'tuore välimuisti ei kutsu laitetta');

  clock += 40_000;
  await getCurrentLocation({ adapter, maxAgeMs: 60_000, now: () => clock });
  assert.equal(adapter.calls.position, 2, 'yli maxAge -> uusi kutsu');
});

test('välimuistin yläraja on kova: maxAge ei voi ylittää MAX_CACHE_MS', async () => {
  let clock = 5_000_000;
  const adapter = fakeAdapter({ check: 'granted' });
  await getCurrentLocation({ adapter, now: () => clock });
  clock += MAX_CACHE_MS + 1000;
  assert.equal(getCachedLocation(10 * 60 * 60 * 1000, clock), null);
});

test('clearLocationCache unohtaa sijainnin', async () => {
  await getCurrentLocation({ adapter: fakeAdapter({ check: 'granted' }) });
  assert.ok(getCachedLocation());
  clearLocationCache();
  assert.equal(getCachedLocation(), null);
});

// ------------------------------------------- yksityisyys: ei vuotoja

test('KRIITTINEN: positio ei vuoda JSON.stringifyllä, spreadillä eikä avainlistalla', async () => {
  const { position } = await getCurrentLocation({ adapter: fakeAdapter({ check: 'granted' }) });

  const json = JSON.stringify(position);
  assert.equal(json.includes('60.1699'), false);
  assert.equal(json.includes('24.9384'), false);
  assert.equal(/lat|lng|lon/i.test(json), false);
  assert.equal(JSON.stringify({ nested: { position } }).includes('60.16'), false);

  assert.deepEqual(Object.keys(position).sort(), ['accuracyMeters', 'obtainedAt']);
  assert.equal('latitude' in { ...position }, false);
  assert.equal(String(JSON.stringify([position])).includes('24.93'), false);
  assert.ok(Object.isFrozen(position));
});

test('KRIITTINEN: sijainti ei kirjoita localStorageen, sessionStorageen, IndexedDB:hen eikä konsoliin', async () => {
  const writes = [];
  const trap = name => ({ setItem: (...args) => writes.push([name, args]), getItem: () => null, removeItem: () => {}, clear: () => {} });
  const saved = {
    localStorage: Object.getOwnPropertyDescriptor(globalThis, 'localStorage'),
    sessionStorage: Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage'),
    indexedDB: Object.getOwnPropertyDescriptor(globalThis, 'indexedDB')
  };
  Object.defineProperty(globalThis, 'localStorage', { value: trap('local'), configurable: true });
  Object.defineProperty(globalThis, 'sessionStorage', { value: trap('session'), configurable: true });
  Object.defineProperty(globalThis, 'indexedDB', { value: { open: () => { writes.push(['idb']); } }, configurable: true });

  const consoleCalls = [];
  const originals = {};
  for (const method of ['log', 'info', 'warn', 'error', 'debug']) {
    originals[method] = console[method];
    console[method] = (...args) => consoleCalls.push([method, args]);
  }

  try {
    await requestLocationPermission({ adapter: fakeAdapter({ check: 'prompt', request: 'granted' }) });
    await getCurrentLocation({ adapter: fakeAdapter({ check: 'granted' }) });
    await getCurrentLocation({ adapter: fakeAdapter({ check: 'granted', position: { latitude: 999, longitude: 0 } }) });
  } finally {
    for (const [name, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
    Object.assign(console, originals);
  }

  assert.deepEqual(writes, [], 'sijainti ei saa koskea pysyvään tallennukseen');
  assert.deepEqual(consoleCalls, [], 'sijainti ei saa päätyä konsoliin');
});

test('KRIITTINEN: sovitinmoduuli ei sisällä tallennusta, verkkoa, seurantaa eikä lokitusta', () => {
  const source = readCode('src/platform/geolocation.js');
  for (const forbidden of [
    'localStorage', 'sessionStorage', 'indexedDB', 'document.cookie', 'fetch(', 'XMLHttpRequest',
    'sendBeacon', 'WebSocket', 'watchPosition', 'clearWatch', 'console.', 'logWarn', 'logError',
    'MediaRecorder', 'geofence', 'BackgroundGeolocation'
  ]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});

test('KRIITTINEN: koordinaatit eivät päädy tietovientiin edes eksyneinä kenttinä', () => {
  const exported = buildUserDataExport({
    tasks: [{ id: 't', title: 'Tapaaminen', latitude: 60.1, longitude: 24.9, coords: { lat: 1, lng: 2 }, position: { latitude: 3 } }],
    travelPlans: [{ id: 'p', destination: 'Kuopio', geolocation: { lat: 62.9 }, lat: 62.9, lng: 27.6, lon: 27.6, coordinates: [62.9, 27.6] }]
  });
  const text = JSON.stringify(exported);
  for (const value of ['60.1', '24.9', '62.9', '27.6']) assert.equal(text.includes(value), false, value);
  assert.equal(/"(latitude|longitude|lat|lng|lon|coords|coordinates|position|geolocation)"/.test(text), false);
  assert.match(text, /Tapaaminen/, 'muu data säilyy');
  assert.match(text, /Kuopio/);
});

test('KRIITTINEN: koordinaatit korvataan lokissa', () => {
  const redacted = redactForLog({ latitude: 60.1699, longitude: 24.9384, accuracy: 5, nested: { coords: { lat: 1 } }, ok: 'näkyy' });
  const text = JSON.stringify(redacted);
  assert.equal(text.includes('60.1699'), false);
  assert.equal(text.includes('24.9384'), false);
  assert.equal(redacted.latitude, REDACTED);
  assert.equal(redacted.ok, 'näkyy');
});

test('KRIITTINEN: tekoäly ei näe sijaintia -- AI-koodi ei tunne sijaintimoduulia eikä koordinaatteja', () => {
  const dirs = ['src/ai', 'api'];
  for (const dir of dirs) {
    for (const file of fs.readdirSync(path.join(ROOT, dir)).filter(name => name.endsWith('.js'))) {
      const source = readCode(`${dir}/${file}`);
      assert.equal(/geolocation|getCurrentLocation|latitude|longitude|coords\b/.test(source), false, `${dir}/${file}`);
    }
  }
  // AI-komentopalvelun pyyntökenttiä ei ole sijainnille.
  const client = readCode('src/ai/commandClient.js');
  assert.equal(/body: JSON\.stringify\(\{[^}]*(lat|lng|location|position)/i.test(client), false);
});

test('KRIITTINEN: kannassa ja migraatioissa ei ole koordinaattisarakkeita eikä sijaintihistoriaa', () => {
  const dir = path.join(ROOT, 'supabase', 'migrations');
  for (const file of fs.readdirSync(dir).filter(name => name.endsWith('.sql'))) {
    const sql = fs.readFileSync(path.join(dir, file), 'utf8')
      .split('\n').filter(line => !line.trim().startsWith('--')).join('\n');
    assert.equal(/\b(latitude|longitude|lat|lng|geography|geometry|postgis|location_history|gps)\b/i.test(sql), false, file);
  }
  const rows = read('src/lib/rows.js');
  assert.equal(/latitude|longitude/i.test(rows), false);
});

test('KRIITTINEN: sijaintia ei pyydetä käynnistyksessä eikä millään kutsupolulla ilman käyttäjän elettä', () => {
  // Kukaan ei saa kutsua haku- tai lupafunktiota moduulitasolla tai
  // käynnistyksessä. Sallitut kutsupaikat luetellaan nimenomaisesti.
  const allowed = new Set(['src/platform/geolocation.js', 'src/platform/index.js']);
  const callers = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (entry.name.endsWith('.js') && /getCurrentLocation|requestLocationPermission|location\.(current|requestPermission)\(/i.test(readCode(rel))) {
        if (!allowed.has(rel)) callers.push(rel);
      }
    }
  };
  walk('src');
  for (const file of callers) {
    assert.match(file, /^src\/app\/(views\/)?[a-zA-Z]+\.js$/, file);
    assert.notEqual(file, 'src/app/main.js', 'käynnistys ei saa pyytää sijaintia');
  }
  const main = readCode('src/app/main.js');
  assert.equal(/location\.(current|requestPermission)\(/i.test(main), false);
});

// ------------------------------------------------------- alustasovittimet

test('web-sovitin: selaimen geolocation ja permissions.query', async () => {
  const savedNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  let permissionState = 'prompt';
  const fakeNavigator = {
    permissions: { query: async () => ({ state: permissionState }) },
    geolocation: {
      getCurrentPosition(success) {
        permissionState = 'granted';
        success({ coords: { latitude: 61, longitude: 25, accuracy: 30 }, timestamp: 5 });
      }
    }
  };
  Object.defineProperty(globalThis, 'navigator', { value: fakeNavigator, configurable: true });
  try {
    const adapter = selectAdapter();
    assert.equal(adapter.name, 'web');
    assert.equal(await adapter.checkPermission(), 'prompt');
    assert.equal(await adapter.requestPermission(), 'granted');
    const position = await adapter.getPosition({ highAccuracy: false, timeoutMs: 1000, maximumAgeMs: 0 });
    assert.equal(position.latitude, 61);
  } finally {
    if (savedNavigator) Object.defineProperty(globalThis, 'navigator', savedNavigator);
    else delete globalThis.navigator;
  }
});

test('web-sovitin: selaimen virhekoodit kääntyvät', async () => {
  const savedNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  for (const [code, expected] of [[1, LOCATION_ERROR.PERMISSION_DENIED], [2, LOCATION_ERROR.POSITION_UNAVAILABLE], [3, LOCATION_ERROR.TIMEOUT], [9, LOCATION_ERROR.UNKNOWN]]) {
    Object.defineProperty(globalThis, 'navigator', {
      value: { geolocation: { getCurrentPosition: (ok, fail) => fail({ code }) } }, configurable: true
    });
    try {
      const adapter = selectAdapter();
      await assert.rejects(adapter.getPosition({ highAccuracy: false, timeoutMs: 1, maximumAgeMs: 0 }), error => error.code === expected);
    } finally {
      if (savedNavigator) Object.defineProperty(globalThis, 'navigator', savedNavigator);
      else delete globalThis.navigator;
    }
  }
});

test('natiivisovitin: Capacitor Geolocation-liitännäinen ja karkea sijainti', async () => {
  const saved = globalThis.Capacitor;
  const plugin = {
    checkPermissions: async () => ({ location: 'denied', coarseLocation: 'granted' }),
    requestPermissions: async () => ({ location: 'granted', coarseLocation: 'granted' }),
    getCurrentPosition: async () => ({ coords: { latitude: 60, longitude: 25, accuracy: 900 }, timestamp: 7 })
  };
  globalThis.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { Geolocation: plugin } };
  try {
    const adapter = selectAdapter();
    assert.equal(adapter.name, 'native');
    assert.equal(await adapter.checkPermission(), 'granted', 'karkea sijainti riittää');
    const result = await getCurrentLocation({ adapter });
    assert.equal(result.ok, true);
    assert.equal(result.position.accuracyMeters, 900, 'karkeus näkyy tarkkuutena');
  } finally {
    if (saved === undefined) delete globalThis.Capacitor; else globalThis.Capacitor = saved;
  }
});

test('natiivisovitin: liitännäisen virheet kääntyvät koodeiksi', async () => {
  const saved = globalThis.Capacitor;
  for (const [message, expected] of [
    ['Location permission was denied', LOCATION_ERROR.PERMISSION_DENIED],
    ['Timeout expired', LOCATION_ERROR.TIMEOUT],
    ['Location services are disabled', LOCATION_ERROR.POSITION_UNAVAILABLE],
    ['jotain outoa', LOCATION_ERROR.UNKNOWN]
  ]) {
    globalThis.Capacitor = {
      isNativePlatform: () => true,
      Plugins: { Geolocation: { getCurrentPosition: async () => { throw new Error(message); } } }
    };
    try {
      await assert.rejects(selectAdapter().getPosition({ highAccuracy: false, timeoutMs: 1, maximumAgeMs: 0 }), error => error.code === expected);
    } finally {
      if (saved === undefined) delete globalThis.Capacitor; else globalThis.Capacitor = saved;
    }
  }
});

test('natiivikuori ilman rekisteröityä liitännäistä: ei sovitinta, rehellinen "ei toteutettu"', () => {
  const saved = globalThis.Capacitor;
  globalThis.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: {} };
  try {
    assert.equal(selectAdapter(), null);
    const state = capability(CAPABILITY.LOCATION);
    assert.equal(state.supported, true);
    assert.equal(state.implemented, false);
    assert.equal(state.available, false);
  } finally {
    if (saved === undefined) delete globalThis.Capacitor; else globalThis.Capacitor = saved;
  }
});

test('Android-projektissa sijaintiliitännäinen on mukana ja tarkka sijainti ei ole taustassa', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.ok(pkg.dependencies['@capacitor/geolocation'], 'virallinen liitännäinen puuttuu package.json:sta');
  assert.match(pkg.dependencies['@capacitor/geolocation'], /\^8\./, 'versio ei sovi Capacitor 8:aan');
  const manifest = read('android/app/src/main/AndroidManifest.xml');
  assert.equal(/ACCESS_BACKGROUND_LOCATION/.test(manifest), false, 'taustasijaintilupaa ei saa olla');
  assert.equal(/FOREGROUND_SERVICE_LOCATION/.test(manifest), false);
});
