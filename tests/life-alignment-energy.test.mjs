// Suunta 2: kuormittavuus ja ENERGY_OVERLOAD.
//
// Aika ja energia ovat eri asioita: viikko voi mahtua aikaan ja silti
// olla liian raskas. Nämä testit lukitsevat tarkan säännön
// (src/domain/energyLoad.js) ja sen, ettei kahta havaintoa yhdistetä.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { analyzeWeek, SIGNAL, SEVERITY } from '../src/domain/alignment.js';
import { summarizeEnergy, energySignals, actualHeavyMinutes } from '../src/domain/energyLoad.js';
import {
  normalizeItemSettings, validateItemSettings, energyDemandFor, indexItemSettings, isEmptySettings,
  energyDemandLabel, ENERGY_DEMAND_LEVELS
} from '../src/domain/alignmentItemSettings.js';
import { ENERGY_RULES } from '../src/domain/alignmentPolicy.js';
import { explainSignal } from '../src/domain/alignmentReview.js';
import { normalizeLifeArea } from '../src/domain/lifeArea.js';
import { normalizeTask } from '../src/domain/task.js';
import { normalizeRoutine } from '../src/domain/routine.js';
import { normalizeProject } from '../src/domain/project.js';
import { normalizeWeeklyCapacity, validateWeeklyCapacity } from '../src/domain/weeklyCapacity.js';
import { readCode } from './helpers/sources.mjs';

const WEEK = '2026-09-14';
const TUE = '2026-09-15';

const area = (id, importance = 3, target = 600, extra = {}) =>
  normalizeLifeArea({ id, name: id, importance, targetMinutesPerWeek: target, ...extra });
const task = (id, minutes, extra = {}) =>
  normalizeTask({ id, title: id, date: TUE, durationMinutes: minutes, category: 'tyo', ...extra });
const setting = (itemId, energyDemand, kind = 'task', extra = {}) =>
  normalizeItemSettings({ id: `s-${itemId}`, itemKind: kind, itemId, energyDemand, ...extra });
const cap = (availableMinutes, extra = {}) =>
  normalizeWeeklyCapacity({ id: 'c', weekStart: WEEK, availableMinutes, ...extra });

function analyze({ tasks = [], settings = [], capacity = cap(2400), routines = [], projects = [] } = {}) {
  return analyzeWeek({
    weekStart: WEEK, todayIso: TUE, areas: [area('work', 3, 600, { categoryKey: 'tyo' })],
    tasks, itemSettings: settings, capacity, routines, projects
  });
}

// ================================================================ MALLI

test('asteikko 1–5 on nimetty; tuntematon on "Ei arvioitu"', () => {
  assert.deepEqual(ENERGY_DEMAND_LEVELS.map(l => l.label),
    ['Kevyt', 'Melko kevyt', 'Keskitaso', 'Kuormittava', 'Erittäin kuormittava']);
  assert.equal(energyDemandLabel(null), 'Ei arvioitu');
});

test('kelvoton kuormittavuus ei muutu arvaukseksi', () => {
  for (const bad of [0, 6, 2.5, '4x', true]) {
    assert.equal(normalizeItemSettings({ itemKind: 'task', itemId: 't', energyDemand: bad }).energyDemand, null, String(bad));
  }
  assert.equal(normalizeItemSettings({ itemKind: 'task', itemId: 't', energyDemand: '4' }).energyDemand, 4);
  assert.equal(validateItemSettings(normalizeItemSettings({ itemKind: 'x', itemId: 't' })).valid, false);
  assert.equal(isEmptySettings(normalizeItemSettings({ itemKind: 'task', itemId: 't' })), true);
});

test('tuntematon pysyy tuntemattomana: otsikosta ei päätellä mitään', () => {
  const heavyTitle = task('Raskas muutto ja siivous', 120);
  const analysis = analyze({ tasks: [heavyTitle] });
  assert.equal(analysis.items[0].energyDemand, null);
  assert.equal(analysis.energy.heavyMinutes, 0);
  assert.equal(analysis.energy.unratedCount, 1);
  const source = readCode('src/domain/energyLoad.js') + readCode('src/domain/alignmentItemSettings.js');
  assert.equal(/title|\.name\b|category/.test(source.replace(/\/\/.*$/gm, '')), false,
    'kuormittavuus ei saa riippua otsikosta, nimestä eikä kategoriasta');
});

test('tehtävä perii projektin kuormittavuuden vain jos omaa ei ole', () => {
  const index = indexItemSettings([setting('p1', 5, 'project'), setting('t2', 2)]);
  assert.equal(energyDemandFor({ kind: 'task', id: 't1' }, index, { projectIdOf: () => 'p1' }), 5);
  assert.equal(energyDemandFor({ kind: 'task', id: 't2' }, index, { projectIdOf: () => 'p1' }), 2);
  assert.equal(energyDemandFor({ kind: 'task', id: 't3' }, index, { projectIdOf: () => null }), null);
});

test('rutiinin kuormittavuus koskee jokaista esiintymää', () => {
  const routine = normalizeRoutine({
    id: 'r1', title: 'Treeni', recurrence: { type: 'daily' }, durationMinutes: 60, active: true, startDate: '2026-01-01'
  });
  const analysis = analyze({ routines: [routine], settings: [setting('r1', 4, 'routine')] });
  assert.equal(analysis.energy.heavyMinutes, 7 * 60);
});

// ================================================================ LASKENTA

test('kuormittava aika = kesto niistä, joiden kuormittavuus >= 4 (ei painoja)', () => {
  const items = [
    { minutes: 60, energyDemand: 5 }, { minutes: 90, energyDemand: 4 },
    { minutes: 120, energyDemand: 3 }, { minutes: 30, energyDemand: null }, { minutes: null, energyDemand: 5 }
  ];
  const energy = summarizeEnergy(items);
  assert.equal(energy.heavyMinutes, 150);
  assert.equal(energy.veryHeavyMinutes, 60);
  assert.equal(energy.unratedMinutes, 30);
  assert.equal(energy.knownMinutes, 300, 'kestoton kohde ei ole kuormittavaa aikaa');
  assert.equal(energy.heavySharePercent, 50);
  assert.equal(ENERGY_RULES.HEAVY_MIN_DEMAND, 4);
});

test('lineaarinen: kuorma lasketaan yhdellä kierroksella', () => {
  const items = Array.from({ length: 50000 }, (_, i) => ({ minutes: 30, energyDemand: (i % 5) + 1 }));
  const started = performance.now();
  const energy = summarizeEnergy(items);
  assert.ok(performance.now() - started < 200);
  assert.equal(energy.heavyMinutes, 20000 * 30);
});

// ================================================================ HAVAINTO

test('ENERGY_OVERLOAD: aikaa riittää mutta kuormittavaa on yli rajan (erillinen havainto)', () => {
  const analysis = analyze({
    tasks: [task('a', 300), task('b', 240), task('c', 60)],
    settings: [setting('a', 5), setting('b', 4), setting('c', 1)],
    capacity: cap(2400, { energyBudgetMinutes: 360 })
  });
  const energy = analysis.signals.filter(s => s.kind === SIGNAL.ENERGY_OVERLOAD);
  const time = analysis.signals.filter(s => s.kind === SIGNAL.OVERLOAD);
  assert.equal(time.length, 0, 'aikakuormitusta ei ole');
  assert.equal(energy.length, 1);
  assert.equal(energy[0].severity, SEVERITY.STRONG, '540 >= 1.2 x 360');
  assert.equal(energy[0].metrics.overageMinutes, 180);
  assert.equal(energy[0].metrics.timeOverloaded, false);
  const text = explainSignal(energy[0], []);
  assert.match(text.text, /Aikaa näyttäisi olevan riittävästi, mutta suunniteltu viikko on energiakuormaltaan raskas\./);
  assert.match(text.why, /eri havainto kuin aikakuormitus/);
});

test('ENERGY_OVERLOAD huomio-taso ja raja-arvot', () => {
  const at = heavy => analyze({
    tasks: [task('a', heavy)], settings: [setting('a', 4)], capacity: cap(2400, { energyBudgetMinutes: 600 })
  }).signals.filter(s => s.kind === SIGNAL.ENERGY_OVERLOAD);
  assert.equal(at(600).length, 0, 'tasan raja ei ylity');
  assert.equal(at(601)[0].severity, SEVERITY.ATTENTION);
  assert.equal(at(719)[0].severity, SEVERITY.ATTENTION);
  assert.equal(at(720)[0].severity, SEVERITY.STRONG);
});

test('raja 0 = mikä tahansa kuormittava on vahva ylitys', () => {
  const signals = analyze({
    tasks: [task('a', 15)], settings: [setting('a', 4)], capacity: cap(2400, { energyBudgetMinutes: 0 })
  }).signals.filter(s => s.kind === SIGNAL.ENERGY_OVERLOAD);
  assert.equal(signals[0].severity, SEVERITY.STRONG);
});

test('mahdollinen ylitys: >= 90 % rajasta ja arvioimatonta työtä', () => {
  const signals = analyze({
    tasks: [task('a', 550), task('b', 60)], settings: [setting('a', 4)],
    capacity: cap(2400, { energyBudgetMinutes: 600 })
  }).signals.filter(s => s.kind === SIGNAL.ENERGY_OVERLOAD);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].severity, SEVERITY.INFO);
  assert.equal(signals[0].rule, 'energy.possible_with_unrated');
});

test('ilman rajaa: matala oma energia-arvio + raskas suunnitelma = tiedoksi; muuten ei mitään', () => {
  const base = { tasks: [task('a', 240), task('b', 120)], settings: [setting('a', 5)] };
  const low = analyze({ ...base, capacity: cap(2400, { energyLevel: 2 }) }).signals
    .filter(s => s.kind === SIGNAL.ENERGY_OVERLOAD);
  assert.equal(low.length, 1);
  assert.equal(low[0].severity, SEVERITY.INFO);
  assert.equal(low[0].rule, 'energy.low_energy_heavy_share');
  const normal = analyze({ ...base, capacity: cap(2400, { energyLevel: 4 }) }).signals
    .filter(s => s.kind === SIGNAL.ENERGY_OVERLOAD);
  assert.equal(normal.length, 0);
  const none = analyze({ ...base, capacity: cap(2400) }).signals.filter(s => s.kind === SIGNAL.ENERGY_OVERLOAD);
  assert.equal(none.length, 0, 'ilman rajaa ja arviota ei päätellä mitään');
});

test('aika JA energia ylittyvät: kaksi erillistä havaintoa, ei yhteispistettä', () => {
  const analysis = analyze({
    tasks: [task('a', 700)], settings: [setting('a', 5)],
    capacity: cap(600, { energyBudgetMinutes: 300 })
  });
  const kinds = analysis.signals.map(s => s.kind);
  assert.ok(kinds.includes(SIGNAL.OVERLOAD));
  assert.ok(kinds.includes(SIGNAL.ENERGY_OVERLOAD));
  assert.equal(analysis.signals.find(s => s.kind === SIGNAL.ENERGY_OVERLOAD).metrics.timeOverloaded, true);
  assert.ok(!('score' in analysis) && !('energyScore' in analysis), 'ei yhdistettyä pistettä');
  assert.match(explainSignal(analysis.signals.find(s => s.kind === SIGNAL.ENERGY_OVERLOAD), []).text,
    /Myös aikakapasiteetti ylittyy/);
});

test('ilman kapasiteettiriviä ei energiahavaintoa', () => {
  assert.deepEqual(energySignals({ energy: summarizeEnergy([{ minutes: 999, energyDemand: 5 }]), capacity: null }), []);
});

test('toteutunut kuormittava aika on vain kuvaus (ei havaintoa)', () => {
  const result = actualHeavyMinutes([{ minutes: 60 }, { minutes: 30 }, { minutes: 0 }], entry => (entry.minutes === 60 ? 5 : 2));
  assert.deepEqual(result, { heavyMinutes: 60, ratedMinutes: 90 });
});

test('energiaraja validoidaan kuten aika (0–168 h), puuttuva on sallittu', () => {
  assert.equal(validateWeeklyCapacity(cap(600, { energyBudgetMinutes: -1 })).valid, false);
  assert.equal(validateWeeklyCapacity(cap(600, { energyBudgetMinutes: 10081 })).valid, false);
  assert.equal(validateWeeklyCapacity(cap(600)).valid, true);
  assert.equal(cap(600).energyBudgetMinutes, null);
});

test('analyysi kertoo energian erikseen: raja, jäljellä, arvioimaton', () => {
  const analysis = analyze({
    tasks: [task('a', 120), task('b', 60)], settings: [setting('a', 4)],
    capacity: cap(1200, { energyBudgetMinutes: 300 })
  });
  assert.equal(analysis.energy.budgetMinutes, 300);
  assert.equal(analysis.energy.remainingMinutes, 180);
  assert.equal(analysis.energy.unratedMinutes, 60);
  assert.equal(analysis.capacity.energyBudgetMinutes, 300);
  assert.equal(analysis.capacity.remainingMinutes, 1200 - 180, 'aikakapasiteetti ei muutu energiasta');
});

test('projektin kuormittavuus näkyy analyysissa projektin tehtäville', () => {
  const project = normalizeProject({ id: 'p1', name: 'Remontti', status: 'active' });
  const analysis = analyze({
    tasks: [task('a', 120, { projectId: 'p1' })], projects: [project], settings: [setting('p1', 5, 'project')]
  });
  assert.equal(analysis.items[0].energyDemand, 5);
});
