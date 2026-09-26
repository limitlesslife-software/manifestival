// CORS AI-päätepisteille (api/_cors.js).
//
// Android-kuori lataa sivun originista https://localhost ja kutsuu
// tuotannon /api/*-päätepisteitä. Authorization-otsake pakottaa
// esikyselyyn (OPTIONS). Ilman CORS-vastausta WebView estää kutsun ja
// jokainen AI-toiminto epäonnistuu puhelimessa hiljaa.
//
// Toisaalta sallittuja originien on oltava TÄSMÄLLEEN kuoren omat:
// tuntematon sivu ei saa lukea vastauksia.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { applyCors, isAllowedOrigin, ALLOWED_ORIGINS } = require('../api/_cors.js');
const { resetRateLimit } = require('../api/_ratelimit.js');

const API_DIR = path.join(__dirname, '..', 'api');
const ROUTES = fs.readdirSync(API_DIR).filter(name => name.endsWith('.js') && !name.startsWith('_')).sort();

function fakeRes() {
  const res = { statusCode: 200, headers: {}, body: null, ended: false };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.status = code => { res.statusCode = code; return res; };
  res.json = body => { res.body = body; return res; };
  res.end = () => { res.ended = true; return res; };
  return res;
}

const preflight = origin => ({
  method: 'OPTIONS',
  headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type' }
});

let savedFetch;
let fetchCalls;
let savedAuthSwitch;
beforeEach(() => {
  savedFetch = globalThis.fetch;
  fetchCalls = 0;
  globalThis.fetch = async () => { fetchCalls++; throw new Error('verkkoa ei saa kutsua'); };
  savedAuthSwitch = process.env.PARSE_REQUIRE_AUTH;
  delete process.env.PARSE_REQUIRE_AUTH;
  resetRateLimit();
});
afterEach(() => {
  globalThis.fetch = savedFetch;
  if (savedAuthSwitch === undefined) delete process.env.PARSE_REQUIRE_AUTH;
  else process.env.PARSE_REQUIRE_AUTH = savedAuthSwitch;
});

// ------------------------------------------------------------ apumoduuli

test('sallitut originit: täsmälleen Android- ja iOS-kuori', () => {
  assert.deepEqual([...ALLOWED_ORIGINS], ['https://localhost', 'capacitor://localhost']);
  for (const origin of ['https://localhost', 'capacitor://localhost']) assert.equal(isAllowedOrigin(origin), true, origin);
  for (const origin of ['http://localhost', 'https://localhost:8080', 'https://localhost.evil.example',
    'https://evil.example', 'null', '*', '', undefined, null, ['https://localhost']]) {
    assert.equal(isAllowedOrigin(origin), false, String(origin));
  }
});

test('esikysely sallitusta originista: 204 ja sallintaotsakkeet', () => {
  const res = fakeRes();
  assert.equal(applyCors(preflight('https://localhost'), res), true);
  assert.equal(res.statusCode, 204);
  assert.equal(res.ended, true);
  assert.equal(res.headers['Access-Control-Allow-Origin'], 'https://localhost');
  assert.equal(res.headers['Access-Control-Allow-Methods'], 'POST');
  assert.equal(res.headers['Access-Control-Allow-Headers'], 'authorization, content-type');
  assert.equal(res.headers['Access-Control-Max-Age'], '600');
  assert.equal(res.headers.Vary, 'Origin');
});

test('TURVA: tuntematon origin ei saa sallintaa, ei jokerimerkkiä', () => {
  const res = fakeRes();
  assert.equal(applyCors(preflight('https://evil.example'), res), true);
  assert.equal(res.statusCode, 204);
  assert.equal(res.headers['Access-Control-Allow-Origin'], undefined);
  assert.equal(res.headers['Access-Control-Allow-Headers'], undefined);
  assert.equal(res.headers.Vary, 'Origin');
  const source = fs.readFileSync(path.join(API_DIR, '_cors.js'), 'utf8');
  assert.equal(/Allow-Origin['"],\s*['"]\*/.test(source), false, 'jokerimerkki');
});

test('POST: sallittu origin saa sallinnan, käsittelijä jatkaa', () => {
  const res = fakeRes();
  assert.equal(applyCors({ method: 'POST', headers: { origin: 'capacitor://localhost' } }, res), false);
  assert.equal(res.headers['Access-Control-Allow-Origin'], 'capacitor://localhost');
  assert.equal(res.ended, false);
  const same = fakeRes();
  assert.equal(applyCors({ method: 'POST', headers: {} }, same), false, 'saman originin kutsu ilman Originia');
  assert.equal(same.headers['Access-Control-Allow-Origin'], undefined);
});

// ------------------------------------------------------------ jokainen päätepiste

test('jokainen päätepiste vastaa esikyselyyn 204 ilman verkkokutsua', async () => {
  for (const route of ROUTES) {
    const handler = require(path.join(API_DIR, route));
    const res = fakeRes();
    await handler(preflight('https://localhost'), res);
    assert.equal(res.statusCode, 204, route + ': OPTIONS ei saa olla 405');
    assert.equal(res.headers['Access-Control-Allow-Origin'], 'https://localhost', route);
    assert.equal(res.headers.Allow, undefined, route + ': esikysely ei ole metodivirhe');

    const denied = fakeRes();
    await handler(preflight('https://evil.example'), denied);
    assert.equal(denied.headers['Access-Control-Allow-Origin'], undefined, route + ': tuntematon origin sai sallinnan');
  }
  assert.equal(fetchCalls, 0, 'esikysely ei todenna eikä kutsu mallia');
});

test('jokainen päätepiste: virhevastauskin on luettavissa kuoressa (401 ilman tokenia)', async () => {
  // Explain vastaa 503 katkaisimen ollessa pois; muut 401. Kummassakin
  // tapauksessa kuori saa lukea vastauksen ja näyttää varapolun.
  const savedSwitch = process.env.EXPLAIN_ENABLED;
  delete process.env.EXPLAIN_ENABLED;
  try {
    for (const route of ROUTES) {
      const handler = require(path.join(API_DIR, route));
      const res = fakeRes();
      await handler({ method: 'POST', headers: { origin: 'https://localhost' }, body: {} }, res);
      assert.ok([401, 503].includes(res.statusCode), `${route}: ${res.statusCode}`);
      assert.equal(res.headers['Access-Control-Allow-Origin'], 'https://localhost', route);
    }
  } finally {
    if (savedSwitch === undefined) delete process.env.EXPLAIN_ENABLED;
    else process.env.EXPLAIN_ENABLED = savedSwitch;
  }
  assert.equal(fetchCalls, 0);
});

test('GET saa yhä 405:n ja Allow: POST', async () => {
  for (const route of ROUTES) {
    const handler = require(path.join(API_DIR, route));
    const res = fakeRes();
    await handler({ method: 'GET', headers: { origin: 'https://localhost' } }, res);
    assert.equal(res.statusCode, 405, route);
    assert.equal(res.headers.Allow, 'POST', route);
  }
});

test('Android-kuoren origin vastaa Capacitor-asetusta', () => {
  // androidScheme 'https' -> origin https://localhost. Jos skeema
  // vaihtuu, sallittu origin on päivitettävä samalla.
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'capacitor.config.json'), 'utf8'));
  const scheme = (config.server && config.server.androidScheme) || 'https';
  const hostname = (config.server && config.server.hostname) || 'localhost';
  assert.ok(ALLOWED_ORIGINS.includes(`${scheme}://${hostname}`));
});
