// Tekoälyselityksen (/api/explain) julkaisuvalmius: katkaisimet,
// aikarajat ja dokumentit.
//
// Aalto J vie päätepisteen tuotantoon ensimmäistä kertaa. Avain
// (ANTHROPIC_API_KEY) on jo Vercelissä, joten ilman katkaisinta selitys
// olisi mennyt päälle deployn hetkellä — vastoin Day 1 -dokumenttia
// ("ei ole käytössä", OPTIONAL DAY-1). Nämä testit pitävät molemmat
// kytkimet pois ja päätöksen dokumentoituna.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

import { ROOT, read } from './helpers/sources.mjs';
import { AI_EXPLAIN_ENABLED, EXPLAIN_TIMEOUT_MS } from '../src/ai/alignmentExplainClient.js';

const require = createRequire(import.meta.url);
const explain = require('../api/explain.js');
const { VERIFY_TIMEOUT_MS } = require('../api/_auth.js');

// ================================================================ KATKAISIMET

test('KATKAISIMET: selaimen lippu ja palvelimen ympäristömuuttuja ovat oletuksena pois', () => {
  assert.equal(AI_EXPLAIN_ENABLED, false, 'AI_EXPLAIN_ENABLED käännetty ilman kirjattua päätöstä?');
  const saved = process.env.EXPLAIN_ENABLED;
  delete process.env.EXPLAIN_ENABLED;
  try {
    assert.equal(explain.explainEnabled(), false, 'asettamaton EXPLAIN_ENABLED = pois');
  } finally {
    if (saved !== undefined) process.env.EXPLAIN_ENABLED = saved;
  }
  // Muuttuja asetetaan vain Vercelin hallintapaneelista, ei repossa.
  assert.equal(read('vercel.json').includes('EXPLAIN_ENABLED'), false);
});

test('katkaisin on ennen todennusta: suljettuna ei yhtään verkkokutsua', () => {
  const source = read('api/explain.js').replace(/^\s*\/\/.*$/gm, '');
  const handler = source.slice(source.indexOf('module.exports = async'));
  const gate = handler.indexOf('!explainEnabled()');
  assert.ok(gate > -1, 'katkaisin puuttuu');
  assert.ok(gate < handler.indexOf('await authenticate('), 'katkaisin ennen todennusta');
  assert.ok(gate > handler.indexOf("req.method !== 'POST'"), 'metodivirhe (405) ennen katkaisinta');
});

// ================================================================ AIKARAJAT

test('aikarajat: palvelin luovuttaa ennen asiakasta', () => {
  // Muuten asiakas näyttää jo varapolun, kun palvelin vielä maksaa
  // ylävirran kutsusta.
  const serverWorstCase = VERIFY_TIMEOUT_MS + explain.UPSTREAM_TIMEOUT_MS;
  assert.ok(EXPLAIN_TIMEOUT_MS > serverWorstCase,
    `asiakas ${EXPLAIN_TIMEOUT_MS} ms, palvelin enintään ${serverWorstCase} ms`);
  assert.ok(explain.UPSTREAM_TIMEOUT_MS <= 10000, 'lyhyt selitys ei tarvitse yli 10 s');
});

test('vercel.json antaa selitysfunktiolle riittävän enimmäiskeston', () => {
  const config = JSON.parse(read('vercel.json'));
  const fn = config.functions && config.functions['api/explain.js'];
  assert.ok(fn, 'functions["api/explain.js"] puuttuu');
  assert.ok(Number.isInteger(fn.maxDuration), 'maxDuration puuttuu');
  assert.ok(fn.maxDuration * 1000 >= VERIFY_TIMEOUT_MS + explain.UPSTREAM_TIMEOUT_MS,
    'funktio katkeaisi ennen omaa aikakatkaisuaan');
  assert.ok(fn.maxDuration <= 60, 'kaikkien Vercel-tasojen rajoissa');
  for (const key of Object.keys(config.functions)) {
    assert.ok(fs.existsSync(path.join(ROOT, key)), 'functions-avain osoittaa olemattomaan tiedostoon: ' + key);
  }
});

// ================================================================ DOKUMENTIT

test('dokumentit: käyttöönotto on omistajan päätös ja J:n hyväksyntä tarkistaa suljetun tilan', () => {
  const goNoGo = read('docs/SUUNTA-ACTIVATION-GO-NOGO.md');
  for (const needle of ['OPTIONAL_DAY1', 'EXTERNAL_PROVIDER_REQUIRED', 'EXPLAIN_ENABLED', 'AI_EXPLAIN_ENABLED']) {
    assert.ok(goNoGo.includes(needle), 'GO/NO-GO ei mainitse: ' + needle);
  }
  const waveJ = read('docs/acceptance/WAVE-J.md');
  assert.match(waveJ, /`GET \/api\/explain` \| \*\*405\*\*/);
  assert.match(waveJ, /`POST \/api\/explain` ilman tokenia \| \*\*503\*\*/);
  assert.ok(waveJ.includes('Palvelu ei ole käytössä'));
  assert.ok(read('docs/DEPLOYMENT.md').includes('`EXPLAIN_ENABLED`'));
  assert.match(read('docs/LIFE-ALIGNMENT.md'), /Tekoälyselitys \+ varapolku \| OPTIONAL_DAY1/);
});

test('SECURITY.md nimeää jokaisen ANTHROPIC_API_KEY:tä lukevan päätepisteen', () => {
  const row = read('docs/SECURITY.md').split(/\r?\n/).find(line => line.startsWith('| `ANTHROPIC_API_KEY`'));
  assert.ok(row, 'salaisuustaulukon rivi puuttuu');
  const readers = fs.readdirSync(path.join(ROOT, 'api'))
    .filter(file => file.endsWith('.js') && read('api/' + file).includes('process.env.ANTHROPIC_API_KEY'));
  assert.ok(readers.includes('explain.js'));
  for (const file of readers) {
    assert.ok(row.includes('`api/' + file + '`'), 'SECURITY.md ei mainitse: api/' + file);
  }
});

test('kommentit vastaavat koodia: kutsupolku on olemassa, Android-origin on https://localhost', () => {
  assert.equal(/tarkoituksella\s+rakentamatta/.test(read('src/ai/alignmentContext.js')), false);
  assert.equal(/\(capacitor:\/\/localhost\), jolloin/.test(read('src/platform/index.js')), false);
  assert.ok(read('src/platform/index.js').includes('https://localhost'));
});
