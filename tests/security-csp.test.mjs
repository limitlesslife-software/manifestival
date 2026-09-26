// Pakottava Content-Security-Policy (CRIT-09).
//
// APK:ssa ei ollut CSP:tä lainkaan: Capacitorin paikallinen palvelin ei
// lähetä otsakkeita, ja vercel.json:n otsake oli vain raportoiva. Nyt
// index.html kantaa pakottavan <meta http-equiv>-politiikan, joka kulkee
// APK:hon bittiverrannollisena kopiona (scripts/build-web.mjs).
//
// Nämä testit sitovat politiikan siihen, mitä sovellus oikeasti lataa:
// liian tiukka politiikka rikkoisi sovelluksen hiljaa (kuitin kuva,
// natiivikuoren /api-kutsut), liian löysä ei suojaisi mitään.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { ROOT, read, readCode, browserModules } from './helpers/sources.mjs';
import { SUPABASE_URL } from '../src/data/config.js';

const html = read('index.html');
const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));

/** CSP-direktiivit nimen mukaan: { 'script-src': ["'self'"], … }. */
function directives(policy) {
  return Object.fromEntries(policy.split(';')
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => {
      const [name, ...values] = part.split(/\s+/);
      return [name.toLowerCase(), values];
    }));
}

/** Kaikki CSP-meta-elementit sijainteineen. */
function cspMetas(source) {
  return [...source.matchAll(/<meta\s+http-equiv="([^"]+)"\s+content="([^"]*)"\s*>/gi)]
    .filter(match => /content-security-policy/i.test(match[1]))
    .map(match => ({ httpEquiv: match[1], content: match[2], index: match.index }));
}

const metas = cspMetas(html);
const meta = metas[0];
const csp = meta ? directives(meta.content) : {};

/** Natiivikuoren tuotanto-origin lähdekoodista (ei importoida alustakerrosta). */
const PRODUCTION_ORIGIN = /export const PRODUCTION_ORIGIN = '([^']+)'/.exec(read('src/platform/index.js'))[1];

// ------------------------------------------------------------ meta

test('KRIITTINEN: index.html kantaa täsmälleen yhden PAKOTTAVAN CSP:n', () => {
  assert.equal(metas.length, 1, `CSP-meta-elementtejä ${metas.length}`);
  assert.equal(meta.httpEquiv, 'Content-Security-Policy',
    'Report-Only ei suojaa mitään — APK:ssa tämä on ainoa politiikka');
});

test('KRIITTINEN: CSP on ennen yhtäkään resurssia, jonka se rajaa', () => {
  // Meta-politiikka koskee vain sen jälkeen jäsennettyä sisältöä. Sen on
  // oltava ennen jokaista skriptiä ja tyylitiedostoa.
  const head = html.slice(0, html.indexOf('</head>'));
  const firstResource = head.search(/<script\b|<link\b[^>]*rel="stylesheet"|<link\b[^>]*href="https?:|<style\b/i);
  assert.ok(firstResource > 0);
  assert.ok(meta.index < firstResource, 'CSP-meta on resurssien jälkeen');
  // Merkistö ensin: se on luettava ensimmäisen 1024 tavun sisällä.
  assert.ok(html.indexOf('<meta charset="UTF-8">') < meta.index);
  // Capacitor lisää siltaskriptinsä <head>-tagin perään, siis tämän
  // politiikan EDELLE (JSInjector) — siksi <head> on kirjoitettava juuri näin.
  assert.ok(html.includes('<head>\r\n') || html.includes('<head>\n'));
});

test('KRIITTINEN: skriptit vain omasta originista, ei inline-suoritusta eikä evalia', () => {
  assert.deepEqual(csp['script-src'], ["'self'"]);
  assert.deepEqual(csp['default-src'], ["'self'"]);
  assert.deepEqual(csp['object-src'], ["'none'"]);
  assert.deepEqual(csp['base-uri'], ["'self'"]);
  assert.deepEqual(csp['form-action'], ["'self'"]);
  const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>/g)].map(match => match[0]);
  assert.deepEqual(inline, [], 'inline-skripti estyisi pakottavalla CSP:llä');
  assert.equal(/\son[a-z]+=/i.test(html.replace(/<!--[\s\S]*?-->/g, '')), false,
    'inline-tapahtumankäsittelijä estyisi pakottavalla CSP:llä');
});

test('KRIITTINEN: jokainen <script src> on samasta originista', () => {
  const sources = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map(match => match[1]);
  assert.ok(sources.length >= 2, 'skriptejä ei löytynyt');
  for (const src of sources) {
    assert.equal(/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(src), false, `vieraan originin skripti: ${src}`);
    const local = path.join(ROOT, src.replace(/^\.?\//, ''));
    assert.ok(fs.existsSync(local), `skriptiä ei ole repossa: ${src}`);
  }
  // supabase-js on vendoroitu ja versio kiinnitetty nimeen.
  assert.ok(sources.some(src => /^\.\/vendor\/supabase-js-\d+\.\d+\.\d+\.min\.js$/.test(src)));
});

test('KRIITTINEN: connect-src on täsmälleen oma origin, Supabase ja natiivikuoren /api-origin', () => {
  // Natiivikuoressa sivu on https://localhost, ja /api-kutsut menevät
  // tuotanto-originiin (src/platform/index.js apiUrl). Ilman sitä
  // jokainen AI-toiminto estyisi APK:ssa.
  assert.deepEqual([...csp['connect-src']].sort(), ["'self'", PRODUCTION_ORIGIN, SUPABASE_URL].sort());
  assert.match(PRODUCTION_ORIGIN, /^https:\/\/[a-z0-9.-]+$/);
  assert.match(SUPABASE_URL, /^https:\/\/[a-z0-9]+\.supabase\.co$/);
  for (const value of csp['connect-src']) {
    assert.equal(value.includes('*'), false, `jokerimerkki connect-src:ssä: ${value}`);
    assert.equal(/anthropic/i.test(value), false, 'Anthropic ei kuulu selaimen yhteyksiin');
  }
});

test('KRIITTINEN: selaimen koodin jokainen absoluuttinen osoite on connect-src:ssä', () => {
  // Uusi ulkoinen kutsu ilman politiikan päivitystä estyisi APK:ssa
  // hiljaa. Kommentit ohitetaan (readCode).
  const allowed = new Set(csp['connect-src']);
  for (const file of browserModules()) {
    for (const match of readCode(file).matchAll(/['"`](https?:\/\/[^'"`/\s]+)/g)) {
      assert.ok(allowed.has(match[1]), `${file}: ${match[1]} puuttuu connect-src:stä`);
    }
  }
});

test('KRIITTINEN: img-src sallii kuitin esikäsittelyn (blob:) mutta ei vieraita kuvia', () => {
  // receiptCapture.prepareImage lataa valitun kuvan object-URL:n kautta.
  // Ilman blob:-lähdettä kuitin luku estyisi pakottavalla politiikalla.
  const receipt = readCode('src/app/receiptCapture.js');
  assert.ok(receipt.includes('URL.createObjectURL') && receipt.includes('new Image()'));
  assert.deepEqual([...csp['img-src']].sort(), ["'self'", 'blob:', 'data:'].sort());
});

test('tyylit ja fontit: vain se mitä index.html oikeasti lataa', () => {
  const googleFonts = /<link\b[^>]*href="https:\/\/fonts\.googleapis\.com\/[^"]*"[^>]*rel="stylesheet"/.test(html);
  // Merkinnässä on style-attribuutteja: ilman 'unsafe-inline'-tyyliä
  // näkymät hajoaisivat pakottavalla politiikalla.
  assert.ok(/\sstyle="/.test(html));
  assert.ok(csp['style-src'].includes("'unsafe-inline'"));
  assert.ok(csp['style-src'].includes("'self'"));
  assert.equal(csp['style-src'].includes('https://fonts.googleapis.com'), googleFonts);
  assert.equal((csp['font-src'] || []).includes('https://fonts.gstatic.com'), googleFonts);
  // Jokainen ulkoinen tyylitiedosto on sallittu style-src:ssä.
  for (const match of html.matchAll(/<link\b[^>]*href="(https:\/\/[^/"]+)[^"]*"[^>]*rel="stylesheet"/g)) {
    assert.ok(csp['style-src'].includes(match[1]), `${match[1]} puuttuu style-src:stä`);
  }
});

test('meta ei sisällä direktiivejä, joita selain ei meta-elementissä noudata', () => {
  // frame-ancestors, report-uri ja sandbox ohitetaan metassa: niiden
  // läsnäolo antaisi väärän kuvan suojasta. Kehystyksen esto on
  // vercel.json:n otsakkeissa (X-Frame-Options, frame-ancestors).
  for (const directive of ['frame-ancestors', 'report-uri', 'report-to', 'sandbox']) {
    assert.equal(directive in csp, false, directive);
  }
});

// ------------------------------------------------------- vercel.json

test('KRIITTINEN: vercel.json:n raportoiva otsake on sama politiikka + frame-ancestors', () => {
  const site = vercel.headers.find(entry => entry.source === '/(.*)');
  const headers = Object.fromEntries(site.headers.map(header => [header.key, header.value]));
  const reportOnly = directives(headers['Content-Security-Policy-Report-Only']);
  const { 'frame-ancestors': frameAncestors, ...rest } = reportOnly;
  assert.deepEqual(frameAncestors, ["'none'"]);
  const normalize = policy => Object.fromEntries(Object.entries(policy)
    .map(([name, values]) => [name, [...values].sort()])
    .sort(([x], [y]) => x.localeCompare(y)));
  assert.deepEqual(normalize(rest), normalize(csp),
    'webin raportoiva otsake ja APK:n pakottava meta ovat erkaantuneet');
});

// -------------------------------------------------------------- APK

test('KRIITTINEN: APK saa saman index.html:n muuttamattomana', () => {
  // build-web kopioi index.html:n bittiverrannollisena dist/-hakemistoon,
  // josta Capacitor vie sen APK:n assetteihin. Muunnos (esim. metan
  // poisto) jättäisi APK:n ilman CSP:tä.
  const build = read('scripts/build-web.mjs');
  assert.match(build, /const FILES = \[\s*'index\.html'/);
  assert.match(build, /fs\.copyFileSync\(source, target\)/);
  assert.equal(/index\.html[^\n]*replace\(/.test(build), false);
  const capacitor = JSON.parse(read('capacitor.config.json'));
  assert.equal(capacitor.webDir, 'dist');
  assert.equal(capacitor.server.androidScheme, 'https', 'natiivikuoren origin on https://localhost');
});
