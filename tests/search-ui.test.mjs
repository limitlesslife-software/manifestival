// Haun käyttöliittymäliiman testit.
//
// src/app/search.js on ohut DOM-liima src/domain/search.js:n ja
// näkymien välissä. Tämä projekti ei renderöi DOMia testeissä (ks.
// tests/ui-reachability.test.mjs:n kommentti) -- samasta syystä tässäkin
// testataan vain se, mikä on todella puhdasta: korostuksen
// XSS-turvallisuus ja se, että jokainen hakutyyppi johtaa jonnekin.
//
// Interaktiivista silmukkaa (avaa paneeli, kirjoita, klikkaa tulos) EI
// ole verifioitu oikeassa selaimessa: sovelluksen kirjautuminen käyttää
// oikeaa Supabase-projektia (avaimet on kovakoodattu index.html:ään),
// eikä tähän ole oikeuksia luoda tekaistua tiliä sitä vasten.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { highlightLabel, RESULT_ROUTES } from '../src/app/search.js';
import { SEARCH_TYPES } from '../src/domain/search.js';
import { readCode } from './helpers/sources.mjs';

test('korostus escapettaa ennen merkintää — ei XSS-reittiä otsikon kautta', () => {
  const marked = highlightLabel('<img src=x onerror=alert(1)>', 0, 4);
  assert.equal(marked.includes('<img'), false);
  assert.match(marked, /^<mark>&lt;img<\/mark>/);
});

test('tavallinen osuma korostuu odotetusti', () => {
  assert.equal(highlightLabel('Osta maitoa', 5, 5), 'Osta <mark>maito</mark>a');
});

test('puuttuva osuma (-1) palauttaa pelkän escapetetun tekstin', () => {
  assert.equal(highlightLabel('Osta & juo', -1, 0), 'Osta &amp; juo');
});

test('rajat ylittävä indeksi ei kaada eikä korosta väärin', () => {
  assert.equal(highlightLabel('lyhyt', 3, 100), 'lyhyt');
});

test('KRIITTINEN: jokainen hakutyyppi johtaa johonkin näkymään ja avausfunktioon', () => {
  for (const type of SEARCH_TYPES) {
    const route = RESULT_ROUTES[type];
    assert.ok(route, `tulostyypille ${type} ei ole reittiä`);
    assert.equal(typeof route.screen, 'string');
    assert.equal(typeof route.segment, 'function');
    assert.equal(typeof route.open, 'function');
  }
});

test('hakupaneelin DOM-koukut ovat olemassa index.html:ssä', () => {
  const html = readCode('index.html');
  for (const id of [
    'searchFabBtn', 'searchOverlay', 'searchCloseX', 'searchInput', 'searchResults',
    'searchCommandBtn'
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `#${id} puuttuu index.html:stä`);
  }
  assert.match(html, /id="i-search"/, 'hakukuvake puuttuu SVG-symboleista');
});

test('haku kytketään käynnistyksessä ja siivotaan uloskirjautuessa', () => {
  const main = readCode('src/app/main.js');
  assert.match(main, /initSearch\(\)/);
  assert.match(main, /closeSearch\(\)/);
});

// ------------------------------------ AI-komentotila haun sisällä
//
// updateCommandAffordance/runCommandFromSearch koskevat DOM:iin
// (maybe('searchCommandBtn') ym.) samalla tavalla kuin muu tämän
// tiedoston koodi, eikä niitä siksi voida ajaa Node-testissä (ks.
// tiedoston yläreunan kommentti). Sama rajaus, sama todistustapa:
// lähdekoodin tarkistus sen sijaan että koodia suoritetaan.

test('KRIITTINEN: AI-komentotila kutsuu commandBar.js:n runTypedCommand():ia, ei omaa logiikkaa', () => {
  const source = readCode('src/app/search.js');
  assert.match(source, /import\s*\{\s*runTypedCommand\s*\}\s*from\s*['"]\.\/commandBar\.js['"]/,
    'search.js ei tuo komentoputkea commandBar.js:stä');
  assert.match(source, /runTypedCommand\(text,\s*\{\s*source:\s*'text'\s*\}\)/,
    'runCommandFromSearch ei kutsu runTypedCommand():ia oikealla lähteellä');
});

test('KRIITTINEN: tyhjä hakuteksti ei näytä komentopainiketta eikä laukaise luokittelua', () => {
  const source = readCode('src/app/search.js');
  const start = source.indexOf('function updateCommandAffordance');
  const body = source.slice(start, source.indexOf('\n}', start));
  assert.match(body, /trim\(\)/, 'affordanssi ei siisti syötettä ennen tyhjyystarkistusta');
  assert.match(body, /if\s*\(!trimmed\)/, 'tyhjä syöte ei ohjaudu erilliseen haaraan');

  const runStart = source.indexOf('async function runCommandFromSearch');
  const runBody = source.slice(runStart, source.indexOf('\n}', runStart));
  assert.match(runBody, /if\s*\(!text\.trim\(\)/,
    'runCommandFromSearch ei estä tyhjän tekstin luokittelua');
});

test('haun tulokset eivät laukea automaattista tekoälyluokittelua', () => {
  // runSearch() ajetaan JOKA näppäimellä (input-tapahtuma). Sen sisällä
  // saa kutsua vain UI:n päivitystä (updateCommandAffordance), ei
  // itse luokittelua (runCommandFromSearch/runTypedCommand) — muuten
  // jokainen kirjoitettu kirjain kuluttaisi Anthropic-kiintiötä.
  const source = readCode('src/app/search.js');
  const start = source.indexOf('function runSearch()');
  const body = source.slice(start, source.indexOf('\n}', start));
  assert.equal(body.includes('runTypedCommand'), false,
    'runSearch() kutsuu suoraan tekoälyluokittelua joka näppäimellä');
  assert.equal(body.includes('runCommandFromSearch'), false);
});
