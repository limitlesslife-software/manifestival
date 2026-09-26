// Palvelinpuolen turvallisuustestit: todennus ja pyyntörajoitin.
//
// Auditoinnin avoin riski oli, että /api/parse on täysin avoin ja kuka
// tahansa voi kuluttaa maksullista Anthropic-kiintiötä. Nämä testit lukitsevat
// korjauksen paikalleen.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { authenticate, bearerToken, authRequired } = require('../api/_auth.js');
const { checkRateLimit, resetRateLimit, MAX_REQUESTS_PER_WINDOW } = require('../api/_ratelimit.js');

const reqWith = headers => ({ method: 'POST', headers });

/** Väärennetty fetch, joka jäljittelee Supabasen /auth/v1/user -vastausta. */
function fakeFetch({ status = 200, body = { id: 'user-123' } } = {}) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body
    };
  };
  impl.calls = calls;
  return impl;
}

// ------------------------------------------------------------ tokenin poiminta

test('bearerToken poimii tokenin Authorization-otsakkeesta', () => {
  assert.equal(bearerToken(reqWith({ authorization: 'Bearer abc.def.ghi' })), 'abc.def.ghi');
  assert.equal(bearerToken(reqWith({ Authorization: 'bearer abc' })), 'abc', 'ei saa olla kirjainkokoherkkä');
});

test('bearerToken palauttaa null puuttuvasta tai väärästä otsakkeesta', () => {
  assert.equal(bearerToken(reqWith({})), null);
  assert.equal(bearerToken(reqWith({ authorization: 'Basic abc' })), null);
  assert.equal(bearerToken(reqWith({ authorization: 'abc' })), null);
  assert.equal(bearerToken({}), null);
});

// ------------------------------------------------------------------ todennus

test('TURVA: tokeniton pyyntö hylätään koodilla 401', async () => {
  const result = await authenticate(reqWith({}), { fetchImpl: fakeFetch() });
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
});

test('kelvollinen token hyväksytään ja käyttäjä tunnistetaan', async () => {
  const impl = fakeFetch({ status: 200, body: { id: 'user-123', email: 'a@b.fi' } });
  const result = await authenticate(reqWith({ authorization: 'Bearer hyva.token' }), { fetchImpl: impl });
  assert.equal(result.ok, true);
  assert.equal(result.userId, 'user-123');
});

test('todennus tehdään Supabasen omalla päätepisteellä', async () => {
  const impl = fakeFetch();
  await authenticate(reqWith({ authorization: 'Bearer t' }), { fetchImpl: impl });
  assert.equal(impl.calls.length, 1);
  assert.match(impl.calls[0].url, /\/auth\/v1\/user$/);
  assert.equal(impl.calls[0].options.headers.Authorization, 'Bearer t');
  assert.ok(impl.calls[0].options.headers.apikey, 'anon-avain tarvitaan otsakkeeseen');
});

test('TURVA: vanhentunut token hylätään', async () => {
  const result = await authenticate(reqWith({ authorization: 'Bearer vanha' }),
    { fetchImpl: fakeFetch({ status: 401, body: {} }) });
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
});

test('TURVA: vastaus ilman käyttäjätunnistetta hylätään', async () => {
  const result = await authenticate(reqWith({ authorization: 'Bearer t' }),
    { fetchImpl: fakeFetch({ status: 200, body: {} }) });
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
});

test('TURVA: todennuspalvelun virhe EI avaa päätepistettä', async () => {
  const failing = async () => { throw new Error('verkko alhaalla'); };
  const result = await authenticate(reqWith({ authorization: 'Bearer t' }), { fetchImpl: failing });
  assert.equal(result.ok, false, 'virheen ei saa johtaa läpipäästöön');
  assert.equal(result.status, 503);
});

test('todennus on oletuksena päällä', () => {
  const previous = process.env.PARSE_REQUIRE_AUTH;
  delete process.env.PARSE_REQUIRE_AUTH;
  try {
    assert.equal(authRequired(), true, 'turvallinen oletus on vaatia kirjautuminen');
  } finally {
    if (previous !== undefined) process.env.PARSE_REQUIRE_AUTH = previous;
  }
});

test('todennuksen voi kytkeä pois vain nimenomaisella ympäristömuuttujalla', async () => {
  const previous = process.env.PARSE_REQUIRE_AUTH;
  process.env.PARSE_REQUIRE_AUTH = 'false';
  try {
    const result = await authenticate(reqWith({}), { fetchImpl: fakeFetch() });
    assert.equal(result.ok, true);
    assert.equal(result.anonymous, true);
  } finally {
    if (previous === undefined) delete process.env.PARSE_REQUIRE_AUTH;
    else process.env.PARSE_REQUIRE_AUTH = previous;
  }
});

test('mikä tahansa muu arvo kuin "false" pitää todennuksen päällä', () => {
  const previous = process.env.PARSE_REQUIRE_AUTH;
  for (const value of ['true', '0', 'ei', '']) {
    process.env.PARSE_REQUIRE_AUTH = value;
    assert.equal(authRequired(), true, 'arvo ' + JSON.stringify(value) + ' ei saa avata päätepistettä');
  }
  if (previous === undefined) delete process.env.PARSE_REQUIRE_AUTH;
  else process.env.PARSE_REQUIRE_AUTH = previous;
});

// ------------------------------------------------------------ pyyntörajoitin

test('ensimmäiset pyynnöt sallitaan', () => {
  resetRateLimit();
  const now = 1_000_000;
  for (let i = 0; i < MAX_REQUESTS_PER_WINDOW; i++) {
    assert.equal(checkRateLimit('user-a', { now }).allowed, true, 'pyyntö ' + (i + 1) + ' hylättiin');
  }
});

test('rajan ylittävä pyyntö hylätään', () => {
  resetRateLimit();
  const now = 1_000_000;
  for (let i = 0; i < MAX_REQUESTS_PER_WINDOW; i++) checkRateLimit('user-b', { now });
  const blocked = checkRateLimit('user-b', { now });
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterSeconds > 0, 'pitää kertoa milloin voi yrittää uudelleen');
});

test('rajoitin on käyttäjäkohtainen', () => {
  resetRateLimit();
  const now = 1_000_000;
  for (let i = 0; i < MAX_REQUESTS_PER_WINDOW; i++) checkRateLimit('user-c', { now });
  assert.equal(checkRateLimit('user-c', { now }).allowed, false);
  assert.equal(checkRateLimit('user-d', { now }).allowed, true,
    'toisen käyttäjän kiintiö ei saa kulua');
});

test('ikkunan umpeuduttua pyynnöt sallitaan taas', () => {
  resetRateLimit();
  const start = 1_000_000;
  for (let i = 0; i < MAX_REQUESTS_PER_WINDOW; i++) checkRateLimit('user-e', { now: start });
  assert.equal(checkRateLimit('user-e', { now: start }).allowed, false);
  assert.equal(checkRateLimit('user-e', { now: start + 60_001 }).allowed, true);
});

test('rajoitin laskee liukuvaa ikkunaa', () => {
  resetRateLimit();
  const start = 1_000_000;
  // Puolet kiintiöstä nyt, puolet 30 s myöhemmin -> raja täyttyy.
  for (let i = 0; i < MAX_REQUESTS_PER_WINDOW / 2; i++) checkRateLimit('user-f', { now: start });
  for (let i = 0; i < MAX_REQUESTS_PER_WINDOW / 2; i++) checkRateLimit('user-f', { now: start + 30_000 });
  assert.equal(checkRateLimit('user-f', { now: start + 30_000 }).allowed, false);
  // 61 s alusta: ensimmäinen puolikas on vanhentunut, tilaa vapautuu.
  assert.equal(checkRateLimit('user-f', { now: start + 61_000 }).allowed, true);
});

test('remaining vähenee pyyntöjen myötä', () => {
  resetRateLimit();
  const now = 2_000_000;
  const first = checkRateLimit('user-g', { now });
  const second = checkRateLimit('user-g', { now });
  assert.equal(first.remaining, MAX_REQUESTS_PER_WINDOW - 1);
  assert.equal(second.remaining, MAX_REQUESTS_PER_WINDOW - 2);
});

// -------------------------------------------------- päätepisteen rakenne

// Tarkistukset käyvät läpi JOKAISEN api/-tiedoston. Kiinteä lista jäi
// aiemmin jälkeen: explain, capture ja command lisättiin, mutta vain
// parse.js oli testattu.

const API_DIR = path.join(__dirname, '..', 'api');
const API_FILES = fs.readdirSync(API_DIR).filter(name => name.endsWith('.js')).sort();
const ROUTE_FILES = API_FILES.filter(name => !name.startsWith('_'));
const readApi = file => fs.readFileSync(path.join(API_DIR, file), 'utf8');
/** Käsittelijän runko ilman kokonaisia kommenttirivejä. */
function handlerBody(file) {
  const source = readApi(file).replace(/^\s*\/\/.*$/gm, '');
  const start = source.indexOf('module.exports = async');
  assert.ok(start > -1, file + ': käsittelijää ei löytynyt');
  return source.slice(start);
}

test('api/-hakemistossa ovat odotetut julkiset päätepisteet', () => {
  for (const route of ['parse.js', 'extract.js', 'plan.js', 'capture.js', 'command.js', 'explain.js']) {
    assert.ok(ROUTE_FILES.includes(route), 'päätepiste puuttuu: ' + route);
  }
});

test('jokainen päätepiste: CORS, POST, todennus ja rajoitin ennen Anthropicia', () => {
  for (const file of ROUTE_FILES) {
    const body = handlerBody(file);
    const corsIndex = body.indexOf('applyCors(req, res)');
    const methodIndex = body.indexOf("req.method !== 'POST'");
    const authIndex = body.indexOf('await authenticate(');
    const rateIndex = body.indexOf('checkRateLimit(');
    const anthropicIndex = body.indexOf('api.anthropic.com');

    assert.ok(corsIndex > -1, file + ': CORS puuttuu');
    assert.ok(methodIndex > -1, file + ': metoditarkistus puuttuu');
    assert.ok(authIndex > -1, file + ': todennus puuttuu');
    assert.ok(rateIndex > -1, file + ': rajoitin puuttuu');
    assert.ok(anthropicIndex > -1, file + ': Anthropic-kutsua ei löytynyt');
    assert.ok(corsIndex < methodIndex, file + ': esikysely pitää käsitellä ennen POST-tarkistusta');
    assert.ok(methodIndex < authIndex, file + ': metodi ennen todennusta');
    assert.ok(authIndex < anthropicIndex, file + ': todennuksen pitää tapahtua ennen maksullista kutsua');
    assert.ok(rateIndex < anthropicIndex, file + ': rajoituksen pitää tapahtua ennen maksullista kutsua');
    assert.ok(readApi(file).includes("require('./_cors.js')"), file + ': _cors.js puuttuu');
  }
});

test('TURVA: palvelinkoodissa ei ole kovakoodattua Anthropic-avainta', () => {
  for (const file of API_FILES) {
    const source = readApi(file);
    assert.equal(/sk-ant-[A-Za-z0-9_-]{10}/.test(source), false, 'avain tiedostossa ' + file);
    assert.equal(source.includes('service_role'), false, 'service_role tiedostossa ' + file);
  }
});

test('apufunktiotiedostot eivät ole julkisia reittejä', () => {
  // Vercelissä api/-hakemiston alaviivalla alkavat tiedostot eivät muutu
  // HTTP-päätepisteiksi. Jokainen tiedosto, joka ei vie käsittelijää,
  // on apumoduuli ja sen nimen pitää alkaa alaviivalla.
  for (const file of API_FILES) {
    const exported = require(path.join(API_DIR, file));
    if (typeof exported !== 'function') {
      assert.ok(file.startsWith('_'), 'apumoduulin nimen pitää alkaa alaviivalla: ' + file);
    } else {
      assert.equal(file.startsWith('_'), false, 'käsittelijä alaviivatiedostossa ei ole reitti: ' + file);
    }
  }
});
