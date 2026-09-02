// HTTP-turvaotsakkeet.
//
// vercel.json on staattista konfiguraatiota, jota ei ole otettu käyttöön.
// Näitä ei siis voi todentaa lukemalla oikeaa vastausta. Sen sijaan
// tarkistetaan se, mikä ON tarkistettavissa: että politiikka vastaa
// sovelluksen todellisia riippuvuuksia eikä päästä läpi enempää kuin
// koodi tarvitsee.
//
// Ks. docs/audits/OVERNIGHT-HTTP-HEADERS.md

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { ROOT, read } from './helpers/sources.mjs';

const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));

/** Otsakkeet polulle, jota `source` vastaa. */
function headersFor(source) {
  const rule = config.headers.find(entry => entry.source === source);
  assert.ok(rule, 'sääntöä ei löytynyt polulle ' + source);
  return Object.fromEntries(rule.headers.map(h => [h.key, h.value]));
}

const site = headersFor('/(.*)');
const api = headersFor('/api/(.*)');

/** CSP-direktiivit nimen mukaan. */
function directives(policy) {
  return Object.fromEntries(policy.split(';')
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => {
      const [name, ...values] = part.split(/\s+/);
      return [name, values];
    }));
}

const csp = directives(site['Content-Security-Policy-Report-Only']);

// ------------------------------------------------- perusotsakkeet

test('perusturvaotsakkeet ovat paikallaan', () => {
  assert.equal(site['X-Content-Type-Options'], 'nosniff');
  assert.equal(site['Referrer-Policy'], 'strict-origin-when-cross-origin');
  assert.equal(site['X-Frame-Options'], 'DENY');
  assert.ok(site['Permissions-Policy'], 'Permissions-Policy puuttuu');
});

test('AI-välipalvelimen vastauksia ei tallenneta välimuistiin', () => {
  // Vastaus sisältää käyttäjän oman tekstin tulkinnan. Se ei kuulu
  // välimuistiin missään välissä.
  assert.equal(api['Cache-Control'], 'no-store');
});

test('käyttämättömät laiterajapinnat on suljettu, mikrofoni ei', () => {
  const policy = site['Permissions-Policy'];

  for (const feature of ['geolocation', 'camera', 'payment', 'usb']) {
    assert.match(policy, new RegExp(feature + '=\\(\\)'),
      feature + ' pitää olla suljettu — sille ei ole toteutusta');
  }

  // Puhekomennot tarvitsevat mikrofonin. Sen sulkeminen rikkoisi
  // ominaisuuden hiljaisesti.
  assert.equal(policy.includes('microphone=()'), false,
    'mikrofonin sulkeminen rikkoisi puhekomennot');
});

// ------------------------------------------------------------ CSP

test('CSP on raportoiva eikä pakottava', () => {
  // Pakottavaa politiikkaa ei aseteta ilman selaintodennusta oikeaa
  // käyttöönottoa vasten. Raportoiva ei voi rikkoa sovellusta.
  assert.ok(site['Content-Security-Policy-Report-Only'],
    'raportoiva CSP puuttuu');
  assert.equal(site['Content-Security-Policy'], undefined,
    'pakottavaa CSP:tä ei saa ottaa käyttöön ennen selaintodennusta');
});

test('KRIITTINEN: Anthropic ei ole selaimen sallituissa yhteyksissä', () => {
  // Selain ei kutsu Anthropicia — kutsun tekee /api/parse palvelimella,
  // jotta avain ei päädy laitteelle. Jos tämä osoite ilmestyy
  // politiikkaan, se on merkki siitä että avain on vuotamassa selaimeen.
  const policy = site['Content-Security-Policy-Report-Only'];
  assert.equal(policy.includes('anthropic'), false,
    'Anthropic sallittu selaimesta — avain on vuotamassa');
});

test('CSP sallii täsmälleen ne lähteet, joita koodi käyttää', () => {
  const html = read('index.html');

  // Skriptit: vain oma koodi ja Supabasen paketti.
  assert.deepEqual(csp['script-src'], ["'self'", 'https://cdn.jsdelivr.net']);
  assert.ok(html.includes('cdn.jsdelivr.net'), 'jsdelivr ei ole enää käytössä — poista se politiikasta');

  // Fontit.
  assert.ok(csp['font-src'].includes('https://fonts.gstatic.com'));
  assert.ok(csp['style-src'].includes('https://fonts.googleapis.com'));

  // Yhteydet: oma alkuperä ja Supabase.
  const connect = csp['connect-src'].join(' ');
  assert.ok(connect.includes("'self'"));
  assert.ok(/https:\/\/[a-z0-9]+\.supabase\.co/.test(connect), 'Supabase puuttuu connect-src:stä');
});

test('CSP:n Supabase-osoite on sama kuin sovelluksen konfiguraatiossa', () => {
  // Jos nämä ajautuvat erilleen, politiikka estäisi juuri sen palvelun,
  // jota sovellus käyttää — ja vasta pakottavaksi vaihdettaessa.
  const configured = /https:\/\/([a-z0-9]+)\.supabase\.co/.exec(read('src/data/config.js'));
  assert.ok(configured, 'Supabase-osoitetta ei löytynyt konfiguraatiosta');

  const policy = site['Content-Security-Policy-Report-Only'];
  assert.ok(policy.includes(configured[0]),
    'CSP:n Supabase-osoite eroaa konfiguraatiosta: ' + configured[0]);
});

test('KRIITTINEN: skriptit eivät salli inline-suoritusta', () => {
  // Sivulla ei ole yhtään inline-skriptiä eikä onclick-käsittelijää, joten
  // unsafe-inline ei ole tarpeen. Sen lisääminen mitätöisi CSP:n
  // tärkeimmän hyödyn juuri XSS:ää vastaan.
  const scripts = csp['script-src'].join(' ');
  assert.equal(scripts.includes("'unsafe-inline'"), false,
    "script-src sisältää 'unsafe-inline' — CSP ei enää suojaa XSS:ltä");
  assert.equal(scripts.includes("'unsafe-eval'"), false);

  const html = read('index.html');
  const inlineScripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>/g)];
  assert.deepEqual(inlineScripts.map(m => m[0]), [],
    'sivulle lisättiin inline-skripti — CSP estäisi sen pakottavana');

  assert.equal(/\son(click|error|load|change|submit)=/.test(html), false,
    'sivulle lisättiin inline-käsittelijä — CSP estäisi sen pakottavana');
});

test('kehysten upotus on estetty kahdella tavalla', () => {
  assert.equal(site['X-Frame-Options'], 'DENY');
  assert.deepEqual(csp['frame-ancestors'], ["'none'"]);
});

test('vaaralliset direktiivit ovat kiinni', () => {
  assert.deepEqual(csp['object-src'], ["'none'"]);
  assert.deepEqual(csp['base-uri'], ["'self'"]);
  assert.deepEqual(csp['form-action'], ["'self'"]);
  assert.deepEqual(csp['default-src'], ["'self'"]);
});

test('HSTS on jätetty tietoisesti pois', () => {
  // Pitkä max-age on käytännössä peruuttamaton: selain muistaa sen
  // kuukausia. Vercel asettaa sen omilla verkkotunnuksillaan valmiiksi.
  // Ks. docs/audits/OVERNIGHT-HTTP-HEADERS.md.
  assert.equal(site['Strict-Transport-Security'], undefined);

  const doc = read('docs/audits/OVERNIGHT-HTTP-HEADERS.md');
  assert.ok(doc.includes('HSTS'), 'poisjättöä ei ole perusteltu dokumentissa');
});
