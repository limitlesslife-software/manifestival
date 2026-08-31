// Arkkitehtuurin regressiotestit.
//
// Modularisointi on arvoton, jos rajat rapautuvat ensimmäisen kiireen alla.
// Nämä testit valvovat kerrosjärjestystä pysyvästi: ne kaatuvat heti, jos
// domain alkaa koskea DOM:iin tai jos moduulien väliin syntyy sykli.
//
// Kerrossääntö (docs/MODULARIZATION.md):
//   app -> ui, ai, data, domain, lib
//   ui  -> lib
//   ai  -> domain, lib
//   data-> domain, lib
//   domain -> lib
//   lib -> (ei mitään)

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  browserModules, serverModules, importsOf, importGraph, findCycle,
  layerOf, read, readCode, readIndexHtml
} from './helpers/sources.mjs';

/** Mitä kukin kerros saa importoida. Saman kerroksen sisäiset importit ovat sallittuja. */
const ALLOWED_DEPENDENCIES = {
  lib: ['lib'],
  domain: ['lib', 'domain'],
  data: ['lib', 'domain', 'data'],
  ai: ['lib', 'domain', 'data', 'ai'],
  ui: ['lib', 'ui'],
  app: ['lib', 'domain', 'data', 'ai', 'ui', 'app']
};

test('kerrosjärjestys pitää: riippuvuudet osoittavat vain alaspäin', () => {
  const violations = [];

  for (const file of browserModules()) {
    const layer = layerOf(file);
    const allowed = ALLOWED_DEPENDENCIES[layer];
    if (!allowed) continue;

    for (const dependency of importsOf(file)) {
      const targetLayer = layerOf(dependency);
      if (targetLayer === 'root') continue;
      if (!allowed.includes(targetLayer)) {
        violations.push(`${file} (${layer}) -> ${dependency} (${targetLayer})`);
      }
    }
  }

  assert.deepEqual(violations, [], 'kerrosrikkomukset:\n' + violations.join('\n'));
});

test('moduulien välillä ei ole syklisiä riippuvuuksia', () => {
  const cycle = findCycle(importGraph(browserModules()));
  assert.equal(cycle, null, cycle ? 'sykli: ' + cycle.join(' -> ') : '');
});

test('palvelinmoduulien välillä ei ole syklisiä riippuvuuksia', () => {
  const cycle = findCycle(importGraph(serverModules()));
  assert.equal(cycle, null, cycle ? 'sykli: ' + cycle.join(' -> ') : '');
});

test('jokainen importoitu moduuli on olemassa', () => {
  const known = new Set([...browserModules(), ...serverModules()]);
  const missing = [];

  for (const file of [...browserModules(), ...serverModules()]) {
    for (const dependency of importsOf(file)) {
      if (!known.has(dependency)) missing.push(`${file} -> ${dependency}`);
    }
  }

  assert.deepEqual(missing, [], 'puuttuvat moduulit:\n' + missing.join('\n'));
});

// ------------------------------------------------------ kerrosten puhtaus

test('PUHTAUS: domain-kerros ei koske DOM:iin eikä verkkoon', () => {
  const forbidden = ['document.', 'window.', 'localStorage', 'fetch(', 'getClient', 'supabase'];
  for (const file of browserModules().filter(f => layerOf(f) === 'domain')) {
    const source = readCode(file);
    for (const pattern of forbidden) {
      assert.equal(source.includes(pattern), false,
        `${file} sisältää kielletyn viittauksen "${pattern}" — domainin pitää pysyä puhtaana`);
    }
  }
});

test('PUHTAUS: lib-kerros ei koske DOM:iin eikä verkkoon', () => {
  // Poikkeus: preferences-tyyppinen laitetallennus kuuluu data-kerrokseen,
  // joten lib saa käyttää vain kieltä itseään.
  const forbidden = ['document.', 'fetch(', 'supabase'];
  for (const file of browserModules().filter(f => layerOf(f) === 'lib')) {
    const source = readCode(file);
    for (const pattern of forbidden) {
      assert.equal(source.includes(pattern), false,
        `${file} sisältää kielletyn viittauksen "${pattern}"`);
    }
  }
});

test('PUHTAUS: data-kerros ei renderöi eikä koske DOM:iin', () => {
  const forbidden = ['document.', 'innerHTML', 'renderToday', 'renderAll'];
  for (const file of browserModules().filter(f => layerOf(f) === 'data')) {
    const source = readCode(file);
    for (const pattern of forbidden) {
      assert.equal(source.includes(pattern), false,
        `${file} sisältää kielletyn viittauksen "${pattern}" — datakerros ei saa renderöidä`);
    }
  }
});

test('PUHTAUS: ui-kerros ei tunne domainia eikä dataa', () => {
  for (const file of browserModules().filter(f => layerOf(f) === 'ui')) {
    for (const dependency of importsOf(file)) {
      const target = layerOf(dependency);
      assert.ok(['lib', 'ui'].includes(target),
        `${file} importoi ${dependency} — ui-kerros saa käyttää vain lib- ja ui-moduuleja`);
    }
  }
});

test('aikataulumoottori on puhdas: ei kelloa eikä satunnaisuutta', () => {
  const source = readCode('src/domain/scheduler.js');
  // Determinismi on moottorin lupaus. Date.now() tai Math.random() rikkoisi sen.
  assert.equal(/Date\.now\(/.test(source), false, 'scheduler ei saa lukea kelloa');
  assert.equal(/Math\.random\(/.test(source), false, 'scheduler ei saa arpoa');
  assert.equal(/new Date\(\)/.test(source), false, 'nykyhetki annetaan parametrina');
});

// -------------------------------------------------------- index.html on runko

test('index.html on runko, ei sovelluslogiikkaa', () => {
  const html = readIndexHtml();
  assert.equal(/\bfunction\s+\w+\s*\(/.test(html), false, 'index.html ei saa sisältää funktioita');
  assert.equal(html.includes('addEventListener'), false, 'tapahtumakytkennät kuuluvat moduuleihin');
  assert.equal(html.includes('createClient'), false, 'Supabase-clientin luonti kuuluu data-kerrokseen');
  assert.equal(html.includes('<style>'), false, 'tyylit kuuluvat tiedostoon src/styles.css');
});

test('index.html lataa sovelluksen yhtenä moduulina', () => {
  const html = readIndexHtml();
  assert.ok(html.includes('<script type="module" src="./src/app/main.js">'),
    'entrypointin pitää olla src/app/main.js');
  assert.ok(html.includes('<link rel="stylesheet" href="./src/styles.css">'),
    'tyylitiedoston linkki puuttuu');

  const inlineScripts = html.match(/<script(?![^>]*\ssrc=)[^>]*>/g) || [];
  assert.deepEqual(inlineScripts, [], 'index.html:ssä ei saa olla inline-skriptejä');
});

test('index.html sisältää täsmälleen yhden sovellusrungon ja yhden kirjautumisportin', () => {
  const html = readIndexHtml();
  assert.equal((html.match(/id="app"/g) || []).length, 1);
  assert.equal((html.match(/id="authGate"/g) || []).length, 1);
  assert.ok(/<div id="app" class="app-hidden">/.test(html),
    'sovelluksen pitää olla piilotettu kunnes istunto on todennettu');
});

// ------------------------------------------- DOM-viittaukset ovat olemassa

test('jokainen koodin viittaama DOM-tunniste on olemassa index.html:ssä', () => {
  const html = readIndexHtml();
  const definedIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));

  // Nämä luodaan ajon aikana, joten ne eivät ole merkinnässä.
  const runtimeIds = new Set(['toastHost', 'confirmDialog', 'proposeBtn', 'proposalContainer']);

  const missing = [];
  for (const file of browserModules()) {
    const source = readCode(file);
    // Negatiivinen lookbehind erottaa importoidun toggle()-apufunktion
    // metodikutsusta classList.toggle(), joka ottaa luokkanimen eikä id:tä.
    const referenced = [
      ...source.matchAll(/(?<![.\w])el\(\s*'([^']+)'\s*\)/g),
      ...source.matchAll(/(?<![.\w])maybe\(\s*'([^']+)'\s*\)/g),
      ...source.matchAll(/getElementById\(\s*'([^']+)'\s*\)/g),
      ...source.matchAll(/(?<![.\w])on\(\s*'([^']+)'\s*,/g),
      ...source.matchAll(/(?<![.\w])(?:toggle|setText|show|hide|focus)\(\s*'([^']+)'\s*[,)]/g)
    ].map(m => m[1]);

    for (const id of new Set(referenced)) {
      if (!definedIds.has(id) && !runtimeIds.has(id)) missing.push(`${file}: #${id}`);
    }
  }

  assert.deepEqual(missing, [], 'koodi viittaa olemattomiin elementteihin:\n' + missing.join('\n'));
});

test('index.html:ssä ei ole kaksoiskappaleina esiintyviä tunnisteita', () => {
  const ids = [...readIndexHtml().matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
  const duplicates = [...new Set(ids.filter((v, i) => ids.indexOf(v) !== i))];
  assert.deepEqual(duplicates, [], 'kaksoiskappaleet: ' + duplicates.join(', '));
});

test('jokainen SVG-symboliviittaus osoittaa olemassa olevaan symboliin', () => {
  const html = readIndexHtml();
  const defined = new Set([...html.matchAll(/<symbol id="([^"]+)"/g)].map(m => m[1]));

  const referenced = new Set();
  for (const source of [html, ...browserModules().map(read)]) {
    for (const match of source.matchAll(/href="#(i-[^"]+)"/g)) referenced.add(match[1]);
  }

  const missing = [...referenced].filter(symbol => !defined.has(symbol));
  assert.deepEqual(missing, [], 'puuttuvat symbolit: ' + missing.join(', '));
});

// ---------------------------------------------- tapahtumakytkentöjen kertaluonteisuus

test('tapahtumakytkennät tehdään kerran käynnistyksessä, ei renderöinnissä', () => {
  const main = read('src/app/main.js');
  // Kaikki init*-kutsut ovat start()-funktiossa, jota kutsutaan kerran.
  for (const initCall of ['initNavigation()', 'initTodayNavigation()', 'initWeekNavigation()',
                          'initTaskForm()', 'initProfileForm()', 'initVoice()', 'initOnboarding()']) {
    assert.equal((main.match(new RegExp(initCall.replace('(', '\\(').replace(')', '\\)'), 'g')) || []).length, 1,
      initCall + ' pitää esiintyä täsmälleen kerran');
  }
  assert.equal((main.match(/start\(\)/g) || []).length, 2, 'start määritellään ja kutsutaan kerran');
});

test('näkymien renderöinti ei lisää kuuntelijoita ikkunaan tai dokumenttiin', () => {
  // Renderöinti korvaa innerHTML:n ja liittää kuuntelijat uusiin elementteihin.
  // Jos näkymä lisäisi kuuntelijan documentiin, ne kasaantuisivat joka kerta.
  for (const file of browserModules().filter(f => f.startsWith('src/app/views/'))) {
    const source = read(file);
    assert.equal(/document\.addEventListener/.test(source), false,
      `${file} lisää kuuntelijan documentiin — se kasaantuisi joka renderöinnillä`);
    assert.equal(/window\.addEventListener/.test(source), false,
      `${file} lisää kuuntelijan ikkunaan — se kasaantuisi joka renderöinnillä`);
  }
});
