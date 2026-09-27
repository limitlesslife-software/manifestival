// Suomenkielisten kestojen jäsennin (src/domain/fiDuration.js).
//
// Pääperiaate: kesto on joko selvä minuuttimäärä tai se jätetään auki.
// Epämääräinen ("pari tuntia"), liian pitkä tai kaksi eri kestoa on
// epäselvä: minutes = null. Tuntematon ei ole koskaan nolla.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readCode, importsOf } from './helpers/sources.mjs';
import {
  parseFinnishDuration, findFinnishDurations, MAX_DURATION_MINUTES, DURATION_REASON
} from '../src/domain/fiDuration.js';

const minutesOf = text => parseFinnishDuration(text).minutes;

function assertDeepFrozen(value, path = 'tulos') {
  if (value && typeof value === 'object') {
    assert.ok(Object.isFrozen(value), `${path} ei ole jäädytetty`);
    for (const key of Object.keys(value)) assertDeepFrozen(value[key], `${path}.${key}`);
  }
}

// ============================================================ perusmuodot

test('tehtävänannon esimerkit', () => {
  for (const [text, expected] of [
    ['30 min', 30], ['30 minuuttia', 30], ['puoli tuntia', 30], ['vartti', 15], ['tunnin', 60], ['tunti', 60],
    ['kaksi tuntia', 120], ['1,5 tuntia', 90], ['puolitoista tuntia', 90]
  ]) {
    const result = parseFinnishDuration(text);
    assert.equal(result.minutes, expected, text);
    assert.equal(result.ambiguous, false, text);
    assert.equal(result.expr, text, text);
  }
});

test('numerot, lyhenteet ja välilyönnittömät muodot', () => {
  for (const [text, expected] of [
    ['30min', 30], ['2h', 120], ['2 h', 120], ['1.5 h', 90], ['0,5 h', 30], ['45 min.', 45], ['90 minuuttia', 90],
    ['kesto 10 minuuttia', 10], ['1440 min', 1440], ['24 tuntia', 1440], ['2,25 tuntia', 135], ['1 minuutti', 1]
  ]) assert.equal(minutesOf(text), expected, text);
});

test('taivutetut muodot: genetiivi, translatiivi, inessiivi', () => {
  for (const [text, expected] of [
    ['kahden tunnin palaveri', 120], ['kahdeksi tunniksi', 120], ['puolen tunnin päästä', 30], ['puolentoista tunnin', 90],
    ['vartiksi', 15], ['vartissa', 15], ['tunnissa', 60], ['kestää minuutin', 1], ['kolmeksi tunniksi', 180],
    ['viiden minuutin', 5], ['kymmenen minuutin tauko', 10]
  ]) assert.equal(minutesOf(text), expected, text);
});

test('lukusanat 1-90 perusmuodossa, genetiivissä ja puhekielessä', () => {
  for (const [text, expected] of [
    ['viisi minuuttia', 5], ['viis minuuttia', 5], ['kaks tuntia', 120], ['viisitoista minuuttia', 15],
    ['viidentoista minuutin', 15], ['kaksikymmentä minuuttia', 20], ['kaksikymmentäviisi minuuttia', 25],
    ['kahdenkymmenenviiden minuutin', 25], ['neljäkymmentäviisi minuuttia', 45], ['yhdeksänkymmentä minuuttia', 90],
    ['kolme varttia', 45], ['seitsemän tuntia', 420], ['kaheksan tuntia', 480]
  ]) assert.equal(minutesOf(text), expected, text);
});

test('yhdistetyt kestot: tunti ja minuutit ovat yksi kesto', () => {
  for (const [text, expected] of [
    ['tunti ja vartti', 75], ['1 h 30 min', 90], ['kaksi tuntia ja 15 minuuttia', 135], ['tunnin ja kymmenen minuuttia', 70],
    ['2h 5min', 125], ['tunti 20 minuuttia', 80]
  ]) {
    const result = parseFinnishDuration(text);
    assert.equal(result.minutes, expected, text);
    assert.equal(result.ambiguous, false, text);
  }
});

test('isot kirjaimet ja hajotettu Unicode', () => {
  assert.equal(minutesOf('PUOLI TUNTIA'), 30);
  assert.equal(minutesOf('Kestää Tunnin'), 60);
  const decomposed = 'neljä minuuttia'.normalize('NFD');
  assert.notEqual(decomposed, 'neljä minuuttia');
  assert.equal(minutesOf(decomposed), 4);
});

// ============================================================ ei kestoa

test('kellonaika ei ole kesto: vartin yli, varttia vaille, puoli yhdeksältä, klo 8', () => {
  for (const text of ['vartin yli kahdeksan', 'varttia vaille yhdeksän', 'puoli yhdeksältä', 'klo 8', 'klo 8.30', 'kello 16',
    'kolme varttia vaille', 'puoli kolme']) {
    const result = parseFinnishDuration(text);
    assert.equal(result.minutes, null, text);
    assert.equal(result.ambiguous, false, text);
    assert.equal(result.expr, null, text);
  }
});

test('tekstit ilman kestoa: tyhjä tulos, ei epäselvyyttä', () => {
  for (const text of ['Osta maitoa', 'huomenna klo 8', 'tunne', 'minä tulen', 'tunnen olevani', 'h', '5', 'min']) {
    assert.deepEqual({ ...parseFinnishDuration(text) }, { minutes: null, ambiguous: false, expr: null, reason: '' }, text);
  }
});

// ============================================================ epäselvät

test('epämääräinen määrä ei ole luku: pari tuntia, muutama minuutti', () => {
  for (const text of ['pari tuntia', 'muutama minuutti', 'muutaman minuutin', 'monta tuntia', 'parin tunnin']) {
    const result = parseFinnishDuration(text);
    assert.equal(result.minutes, null, text);
    assert.equal(result.ambiguous, true, text);
    assert.equal(result.reason, DURATION_REASON.VAGUE, text);
  }
});

test('raja: 24 tuntia on suurin, sitä pidempi on epäselvä eikä katkaistu', () => {
  assert.equal(MAX_DURATION_MINUTES, 1440);
  assert.equal(minutesOf('1440 minuuttia'), 1440);
  for (const text of ['1441 minuuttia', '25 tuntia', '30 tuntia', '99999999999999999999 min']) {
    const result = parseFinnishDuration(text);
    assert.equal(result.minutes, null, text);
    assert.equal(result.ambiguous, true, text);
    assert.equal(result.reason, DURATION_REASON.TOO_LONG, text);
  }
});

test('nolla ei ole kesto: epäselvä, ei 0', () => {
  for (const text of ['0 min', '0 tuntia', '0,2 min']) {
    const result = parseFinnishDuration(text);
    assert.equal(result.minutes, null, text);
    assert.equal(result.ambiguous, true, text);
    assert.equal(result.reason, DURATION_REASON.INVALID, text);
  }
});

test('kaksi eri kestoa on epäselvä, sama kesto kahdesti on yksi', () => {
  const two = parseFinnishDuration('30 min tai tunti');
  assert.equal(two.minutes, null);
  assert.equal(two.ambiguous, true);
  assert.equal(two.reason, DURATION_REASON.MULTIPLE);
  assert.equal(minutesOf('tunnin, siis 60 min'), 60);
});

// ============================================================ kohdat ja naapurit

test('findFinnishDurations kertoo kohdan sekä edeltävän ja seuraavan sanan', () => {
  const text = 'Palaveri tunnin päästä ja kestää puoli tuntia';
  const lower = text.toLocaleLowerCase('fi');
  const found = findFinnishDurations(text);
  assert.equal(found.length, 2);
  assert.equal(found[0].minutes, 60);
  assert.equal(found[0].followedBy, 'päästä');
  assert.equal(found[0].precededBy, 'palaveri');
  assert.equal(lower.slice(found[0].start, found[0].end), 'tunnin');
  assert.equal(found[1].minutes, 30);
  assert.equal(found[1].precededBy, 'kestää');
  assert.equal(found[1].followedBy, null);
  assert.equal(lower.slice(found[1].start, found[1].end), 'puoli tuntia');
});

test('findFinnishDurations: tyhjä ja kelvoton syöte antaa tyhjän jäädytetyn listan', () => {
  for (const bad of [null, undefined, 5, {}, [], '', true]) {
    const found = findFinnishDurations(bad);
    assert.deepEqual([...found], []);
    assert.ok(Object.isFrozen(found));
  }
});

// ============================================================ laatu

test('tulos on jäädytetty ja deterministinen', () => {
  const text = 'Hammaslääkäri kestää tunnin ja vartin';
  const first = JSON.stringify(parseFinnishDuration(text));
  for (let i = 0; i < 200; i += 1) assert.equal(JSON.stringify(parseFinnishDuration(text)), first);
  assertDeepFrozen(parseFinnishDuration(text));
  assertDeepFrozen(findFinnishDurations(text));
});

test('roskasyöte ei koskaan kaada', () => {
  const junk = [null, undefined, 0, -1, NaN, Infinity, true, {}, [], () => 1, Symbol('s'), new String('30 min'),
    '\u0000\u0001', '🎉🎉 30 min 🎉', 'min min min', '1,,5 tuntia', '..,,', '-5 min', '٣٠ min', 'x'.repeat(5000)];
  for (const value of junk) {
    assert.doesNotThrow(() => parseFinnishDuration(value));
    assert.doesNotThrow(() => findFinnishDurations(value));
  }
  assert.equal(minutesOf('🎉🎉 30 min 🎉'), 30);
  assert.equal(minutesOf('-5 min'), 5, 'miinusmerkki on erotin, ei negatiivinen kesto');
});

test('suorituskyky: 40 000 merkkiä ja vihamielinen toisto pysyvät lineaarisina', () => {
  const noise = 'ä'.repeat(20000) + ' 30 min ' + '9'.repeat(20000);
  let started = performance.now();
  assert.equal(minutesOf(noise), 30);
  assert.ok(performance.now() - started < 1500, 'kohinateksti liian hidas');

  for (const unit of ['1 h ja ', 'tunti ja ', 'puoli ', 'kaksi tuntia ', 'vartin yli ', '1,5,5,5 ']) {
    const text = unit.repeat(Math.ceil(40000 / unit.length));
    started = performance.now();
    assert.doesNotThrow(() => parseFinnishDuration(text));
    assert.ok(performance.now() - started < 1500, `toisto "${unit}" liian hidas`);
  }

  // Kaksinkertainen syöte ei saa viedä moninkertaista aikaa.
  const small = 'kestää puoli tuntia ja '.repeat(2000);
  const large = small.repeat(4);
  const time = text => {
    const start = performance.now();
    for (let i = 0; i < 3; i += 1) findFinnishDurations(text);
    return performance.now() - start;
  };
  time(small);
  const ratio = time(large) / Math.max(1, time(small));
  assert.ok(ratio < 16, `kasvu ei ole lineaarista: ${ratio.toFixed(1)}x`);
});

test('PUHTAUS: ei kelloa, arpaa, DOMia, verkkoa eikä lokia; tuo vain domainia', () => {
  const code = readCode('src/domain/fiDuration.js');
  for (const token of ['Date.now(', 'Math.random', 'crypto.randomUUID', 'performance.now', 'document.', 'window.',
    'localStorage', 'sessionStorage', 'fetch(', 'console.']) {
    assert.equal(code.includes(token), false, token);
  }
  assert.equal(/new Date\(\s*\)/.test(code), false);
  for (const dependency of importsOf('src/domain/fiDuration.js')) {
    assert.ok(dependency.startsWith('src/domain/'), dependency);
  }
});
