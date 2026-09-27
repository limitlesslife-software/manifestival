// Päivän keskeytykset puheesta (src/domain/interruptions.js).
//
// Tunnistus ei muuta mitään: se kertoo vain, mitä käyttäjä sanoi.
// Tuhoava lause ei ole koskaan keskeytys, ja epämääräinen määrä jättää
// minuutit tuntemattomiksi (null), ei nollaksi.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readCode, importsOf } from './helpers/sources.mjs';
import {
  parseInterruption, mentionsDestructiveAction, INTERRUPTION_KIND, INTERRUPTION_KINDS, MAX_INTERRUPTION_TEXT_LENGTH
} from '../src/domain/interruptions.js';

const SAT = '2026-09-26';
const parse = (text, todayIso = SAT) => parseInterruption(text, { todayIso });
const plain = value => (value === null ? null : { ...value });

// ============================================================ esimerkit

test('tehtävänannon esimerkit', () => {
  assert.deepEqual(plain(parse('Olen myöhässä')),
    { kind: 'running_late', minutes: null, targetText: null, toDate: null, onDate: null });
  assert.deepEqual(plain(parse('Olen 10 min myöhässä')),
    { kind: 'running_late', minutes: 10, targetText: null, toDate: null, onDate: null });
  assert.deepEqual(plain(parse('Tämä työ kestää vielä 30 min')),
    { kind: 'extend_current', minutes: 30, targetText: 'työ', toDate: null, onDate: null });
  assert.deepEqual(plain(parse('En ehdi lenkille nyt')),
    { kind: 'skip_item', minutes: null, targetText: 'lenkille', toDate: null, onDate: null });
  assert.deepEqual(plain(parse('Siirrä loput')),
    { kind: 'defer_remaining', minutes: null, targetText: null, toDate: null, onDate: null });
  assert.deepEqual(plain(parse('Siirrä loput huomiselle')),
    { kind: 'defer_remaining', minutes: null, targetText: 'huomiselle', toDate: '2026-09-27', onDate: null });
});

test('lajit ovat jäädytetty luettelo', () => {
  assert.deepEqual([...INTERRUPTION_KINDS].sort(), ['defer_remaining', 'extend_current', 'running_late', 'skip_item']);
  assert.ok(Object.isFrozen(INTERRUPTION_KIND));
  assert.ok(Object.isFrozen(INTERRUPTION_KINDS));
});

// ============================================================ myöhästyminen

test('myöhästyminen: muunnelmat ja minuutit', () => {
  for (const [text, minutes] of [
    ['Myöhästyn vartin', 15], ['myöhästyn 5 minuuttia', 5], ['Olen puoli tuntia myöhässä', 30],
    ['Olen puoli tuntia jäljessä aikataulusta', 30], ['Oon kymmenen minuuttia myöhässä!', 10], ['Bussi on myöhässä 20 min', 20],
    ['olen tunnin myöhässä', 60], ['Olen 1,5 tuntia myöhässä', 90]
  ]) {
    const result = parse(text);
    assert.equal(result.kind, INTERRUPTION_KIND.RUNNING_LATE, text);
    assert.equal(result.minutes, minutes, text);
  }
});

test('myöhästyminen ilman selvää määrää: minuutit tuntemattomia, ei nolla', () => {
  for (const text of ['Olen myöhässä', 'Olen vähän myöhässä', 'Olen pari minuuttia myöhässä', 'Myöhästyn hieman',
    'En ehdi ajoissa', 'Olen jäljessä aikataulusta', 'olen muutaman minuutin myöhässä']) {
    const result = parse(text);
    assert.equal(result.kind, INTERRUPTION_KIND.RUNNING_LATE, text);
    assert.equal(result.minutes, null, text);
  }
});

test('myöhästyminen: mistä myöhässä kerrotaan kohteena', () => {
  assert.equal(parse('Olen myöhässä palaverista').targetText, 'palaverista');
  assert.equal(parse('Olen 10 min myöhässä hammaslääkäriltä').targetText, 'hammaslääkäriltä');
  assert.equal(parse('Olen 10 min jäljessä aikataulusta').targetText, null);
});

// ============================================================ venyminen

test('venyminen: muunnelmat, minuutit ja kohde', () => {
  for (const [text, minutes, target] of [
    ['Palaveri venyy 15 min', 15, 'palaveri'], ['Tarvitsen vielä 20 minuuttia', 20, null], ['Vielä vartti', 15, null],
    ['Tähän menee vielä tunti', 60, null], ['Tämä kestää vielä puoli tuntia', 30, null], ['Kokous kestää vielä 10 min', 10, 'kokous'],
    ['Tarvitsen lisää aikaa, tämä kestää vielä puoli tuntia', 30, null], ['Tämä kestää pidempään', null, null],
    ['Siivous vie vielä tunnin', 60, 'siivous']
  ]) {
    const result = parse(text);
    assert.equal(result.kind, INTERRUPTION_KIND.EXTEND_CURRENT, text);
    assert.equal(result.minutes, minutes, text);
    assert.equal(result.targetText, target, text);
  }
});

// ============================================================ ohitus

test('ohitus: kohde ja täytesanat pois', () => {
  for (const [text, target] of [
    ['En ehdi lenkille nyt', 'lenkille'], ['Jätän lenkin väliin', 'lenkin'], ['Jätän lenkin väliin tänään', 'lenkin'],
    ['Lenkki jää väliin', 'lenkki'], ['Tänään lenkki jää väliin', 'lenkki'], ['Ohita aamulenkki', 'aamulenkki'],
    ['En jaksa mennä salille tänään', 'salille'], ['En ehdi', null], ['En ehdi nyt', null], ['Skippaa iltapala', 'iltapala']
  ]) {
    const result = parse(text);
    assert.equal(result.kind, INTERRUPTION_KIND.SKIP_ITEM, text);
    assert.equal(result.targetText, target, text);
    assert.equal(result.minutes, null, text);
    assert.equal(result.onDate, null, text);
  }
});

test('ohitus toisena päivänä kertoo päivän (onDate), tänään ei', () => {
  const tomorrow = parse('En ehdi huomenna salille');
  assert.equal(tomorrow.kind, INTERRUPTION_KIND.SKIP_ITEM);
  assert.equal(tomorrow.targetText, 'salille');
  assert.equal(tomorrow.onDate, '2026-09-27');
  assert.equal(parse('En ehdi tänään salille').onDate, null);
  // Ilman tätä päivää kohde siivotaan silti, mutta päivää ei väitetä.
  const noToday = parseInterruption('En ehdi huomenna salille');
  assert.equal(noToday.targetText, 'salille');
  assert.equal(noToday.onDate, null);
});

// ============================================================ loppujen siirto

test('loppujen siirto: kohdepäivä vain kun se on tämän päivän jälkeen', () => {
  for (const [text, toDate, target] of [
    ['Siirrä loput huomiselle', '2026-09-27', 'huomiselle'], ['Siirrä loput tehtävät huomiseen', '2026-09-27', 'huomiseen'],
    ['Siirrä loput ensi maanantaille', '2026-09-28', 'ensi maanantaille'], ['Loput huomenna', '2026-09-27', 'huomenna'],
    ['siirrä kaikki loput ylihuomiselle', '2026-09-28', 'ylihuomiselle'], ['Voisitko siirtää loput huomiselle', '2026-09-27', 'huomiselle'],
    ['Siirrä jäljellä olevat huomiselle', '2026-09-27', 'huomiselle'], ['Siirrä loput tänään', null, null]
  ]) {
    const result = parse(text);
    assert.equal(result.kind, INTERRUPTION_KIND.DEFER_REMAINING, text);
    assert.equal(result.toDate, toDate, text);
    assert.equal(result.targetText, target, text);
  }
  assert.equal(parseInterruption('Siirrä loput huomiselle').toDate, null, 'ilman tätä päivää ei arvata päivää');
});

test('loppujen siirto: kuukauden, vuoden ja kesäajan vaihde', () => {
  assert.equal(parse('Siirrä loput huomiselle', '2026-12-31').toDate, '2027-01-01');
  assert.equal(parse('Siirrä loput huomiselle', '2026-09-30').toDate, '2026-10-01');
  assert.equal(parse('Siirrä loput huomiselle', '2026-03-28').toDate, '2026-03-29');
  assert.equal(parse('Siirrä loput huomiselle', '2026-10-24').toDate, '2026-10-25');
  assert.equal(parse('Siirrä loput huomiselle', '2028-02-28').toDate, '2028-02-29');
});

// ============================================================ ei keskeytys

test('KRIITTINEN: tuhoava lause ei ole koskaan keskeytys', () => {
  for (const text of ['Poista loput', 'Poista loput tehtävät', 'Peru lenkki', 'Peruuta palaveri, olen myöhässä',
    'Tyhjennä päivä', 'Poista kaikki', 'Delete all', 'Kumoa loput', 'Poistetaan lenkki, en ehdi', 'Siirrä loput ja poista lenkki']) {
    assert.equal(parse(text), null, text);
    assert.equal(mentionsDestructiveAction(text), true, text);
  }
  for (const text of ['Olen myöhässä', 'Lisää perunat', 'Peruna-kurssi', 'Siirrä loput']) {
    assert.equal(mentionsDestructiveAction(text), false, text);
  }
});

test('muut komennot ja tavallinen puhe eivät ole keskeytyksiä', () => {
  for (const text of ['Siirrä palaveri huomiselle', 'Siirrä kaikki', 'Siirrä myöhässä olevat huomiselle', 'Lisää lenkki huomenna',
    'Muistuta jos olen myöhässä', 'Teatteri lauantaina seitsemältä', 'hei', 'loput', 'Näytä huominen', 'Syön loput',
    'Lisää parturi ensi tiistaille klo 16', 'Hammaslääkäri huomenna 9.30 kestää tunnin', 'Mitä huomenna on?']) {
    assert.equal(parse(text), null, text);
  }
});

// ============================================================ laatu

test('tulos on jäädytetty ja deterministinen', () => {
  for (const text of ['Olen 10 min myöhässä', 'Siirrä loput huomiselle', 'En ehdi lenkille', 'Vielä vartti']) {
    const result = parse(text);
    assert.ok(Object.isFrozen(result), text);
    const first = JSON.stringify(result);
    for (let i = 0; i < 50; i += 1) assert.equal(JSON.stringify(parse(text)), first, text);
  }
});

test('roskasyöte ei koskaan kaada eikä tuota keskeytystä', () => {
  for (const value of [null, undefined, 0, NaN, true, {}, [], () => 1, Symbol('s'), '', '   ', '???', '🎉', '\u0000']) {
    assert.doesNotThrow(() => parseInterruption(value));
    assert.equal(parseInterruption(value), null);
  }
  for (const options of [null, undefined, 5, 'x', [], { todayIso: 5 }, { todayIso: '2026-02-30' }]) {
    assert.doesNotThrow(() => parseInterruption('Siirrä loput huomiselle', options));
    assert.equal(parseInterruption('Siirrä loput huomiselle', options).toDate, null);
  }
  assert.doesNotThrow(() => mentionsDestructiveAction(null));
  assert.equal(mentionsDestructiveAction(42), false);
});

test('liian pitkä teksti ei ole keskeytyslause, ja pitkäkin syöte on nopea', () => {
  assert.equal(MAX_INTERRUPTION_TEXT_LENGTH, 300);
  assert.equal(parse('Olen myöhässä ' + 'x'.repeat(400)), null);
  const started = performance.now();
  for (const text of ['myöhässä '.repeat(5000), 'en ehdi '.repeat(5000), 'siirrä loput '.repeat(4000), 'ä'.repeat(40000)]) {
    assert.equal(parse(text), null);
  }
  for (let i = 0; i < 2000; i += 1) parse('Tämä työ kestää vielä 30 min');
  assert.ok(performance.now() - started < 2000, 'liian hidas');
});

test('PUHTAUS: ei kelloa, arpaa, DOMia, verkkoa eikä lokia; tuo vain domainia', () => {
  const code = readCode('src/domain/interruptions.js');
  for (const token of ['Date.now(', 'Math.random', 'crypto.randomUUID', 'performance.now', 'document.', 'window.',
    'localStorage', 'sessionStorage', 'fetch(', 'console.']) {
    assert.equal(code.includes(token), false, token);
  }
  assert.equal(/new Date\(\s*\)/.test(code), false);
  for (const dependency of importsOf('src/domain/interruptions.js')) {
    assert.ok(dependency.startsWith('src/domain/'), dependency);
  }
});
