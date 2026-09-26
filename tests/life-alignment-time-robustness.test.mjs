// Suunta 2: viikon rajat ja suorituskyky.
//
// AIKAVYÖHYKE ON TARKOITUKSELLA ÄÄRIMMÄINEN: Pacific/Kiritimati (UTC+14).
// Viikkolaskenta käyttää vain ISO-päiviä (merkkijonoja), joten tulosten
// on oltava samat kuin Helsingissä. Jos jokin kohta alkaisi käyttää
// Date-olion paikallista päivää huomaamatta, tämä tiedosto kaatuu.

process.env.TZ = 'Pacific/Kiritimati';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { analyzeWeek, weekProgress } from '../src/domain/alignment.js';
import { weekStartOf, weekDates, nextWeekStart, capacityForWeek, normalizeWeeklyCapacity } from '../src/domain/weeklyCapacity.js';
import { dailyObservations } from '../src/domain/dailyAlignment.js';
import { proposeAdjustments, explainSignal } from '../src/domain/alignmentReview.js';
import { previewAdjustments } from '../src/domain/rebalance.js';
import { validatePlanAlignment } from '../src/domain/planAlignment.js';
import { normalizeLifeArea } from '../src/domain/lifeArea.js';
import { normalizeTask } from '../src/domain/task.js';
import { normalizeGoal } from '../src/domain/goal.js';
import { normalizeRoutine } from '../src/domain/routine.js';
import { normalizeTimeEntry } from '../src/domain/timeEntry.js';
import { normalizeItemSettings } from '../src/domain/alignmentItemSettings.js';
import { addDaysIso } from '../src/domain/fiTemporal.js';

const area = normalizeLifeArea({ id: 'a', name: 'A', importance: 4, targetMinutesPerWeek: 600, categoryKey: 'tyo' });
const entry = (id, date, minutes) => normalizeTimeEntry({ id, entryDate: date, minutes, lifeAreaId: 'a' });

test('aikavyöhyke on äärimmäinen (+14) tässä tiedostossa', () => {
  assert.equal(new Date(Date.UTC(2026, 0, 1, 12)).getTimezoneOffset(), -14 * 60);
});

test('viikko alkaa maanantaina ja päättyy sunnuntaina; raja on tarkka', () => {
  assert.equal(weekStartOf('2026-09-20'), '2026-09-14', 'sunnuntai kuuluu edelliseen maanantaihin');
  assert.equal(weekStartOf('2026-09-21'), '2026-09-21');
  const analysis = analyzeWeek({
    weekStart: '2026-09-16', todayIso: '2026-09-25', areas: [area],
    timeEntries: [entry('sun', '2026-09-20', 60), entry('mon', '2026-09-21', 90), entry('prevsun', '2026-09-13', 30)]
  });
  assert.equal(analysis.weekStart, '2026-09-14');
  assert.equal(analysis.weekEnd, '2026-09-20');
  assert.equal(analysis.actual.minutes, 60, 'vain oman viikon sunnuntai lasketaan');
});

test('vuoden vaihde ja ISO-viikko: 1.1.2027 kuuluu viikkoon, joka alkaa 28.12.2026', () => {
  assert.deepEqual(weekDates('2027-01-01'), ['2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02', '2027-01-03']);
  assert.equal(nextWeekStart('2026-12-31'), '2027-01-04');
  const capacity = normalizeWeeklyCapacity({ id: 'c', weekStart: '2026-12-31', availableMinutes: 600 });
  assert.equal(capacity.weekStart, '2026-12-28', 'kapasiteetti tallentuu aina maanantaille');
  assert.equal(capacityForWeek([capacity], '2027-01-03'), capacity);
  const analysis = analyzeWeek({
    weekStart: '2027-01-02', todayIso: '2027-01-05', areas: [area], capacity,
    timeEntries: [entry('y1', '2026-12-31', 60), entry('y2', '2027-01-02', 60), entry('next', '2027-01-04', 60)]
  });
  assert.equal(analysis.actual.minutes, 120);
  assert.equal(analysis.capacity.declared, true);
});

test('karkausvuosi: 29.2.2028 on viikolla ja viikossa on seitsemän päivää', () => {
  assert.deepEqual(weekDates('2028-02-29').slice(0, 3), ['2028-02-28', '2028-02-29', '2028-03-01']);
  assert.equal(addDaysIso('2028-02-28', 1), '2028-02-29');
});

test('kesäajan viikot: seitsemän päivää, eteneminen päivinä (ei millisekunteina)', () => {
  for (const day of ['2026-03-29', '2026-10-25']) {
    const monday = weekStartOf(day);
    assert.equal(weekDates(monday).length, 7);
    const progress = weekProgress(monday, day, 12 * 60);
    assert.equal(progress.state, 'during');
    assert.equal(progress.elapsedDays, 6.5);
  }
});

test('edellisen viikon katsaus: eteneminen on "after" ja toteumaa verrataan koko viikkoon', () => {
  // Muutettu sääntöversiossa 3: yksi kirjaus keskiviikkona ei enää riitä
  // vertailuun (kirjaamattomat päivät ovat tuntemattomia), eikä vahva
  // huomiotta jääminen synny jaksosta, joka alkoi vasta keskiviikkona.
  // Kirjaaja kirjaa nyt maanantaista alkaen neljänä päivänä (yht. 120 min).
  // Muutettu: kirjattu aika suhteutetaan käyttäjän omaan viitteeseen.
  // Ilman kapasiteettia viite olisi alueen tavoite 600 min, jolloin
  // 120 min ei riitä vakiintuneeksi; käyttäjä on nyt ilmoittanut 200 min.
  const analysis = analyzeWeek({
    weekStart: '2026-09-14', todayIso: '2026-09-22', areas: [area],
    capacity: normalizeWeeklyCapacity({ id: 'c', weekStart: '2026-09-14', availableMinutes: 200 }),
    timeEntries: ['2026-09-14', '2026-09-15', '2026-09-17', '2026-09-19'].map((date, i) => entry(`e${i}`, date, 30))
  });
  assert.equal(analysis.tracking.level, 'established');
  assert.equal(analysis.tracking.windowStart, '2026-09-14');
  assert.equal(analysis.progress.state, 'after');
  const neglect = analysis.signals.find(s => s.kind === 'neglect');
  assert.equal(neglect.metrics.expectedByNowMinutes, 600);
  assert.equal(neglect.severity, 'strong', 'viikko päättynyt ja alle neljännes');
});

// ================================================================ SUORITUSKYKY

function largeFixture(scale = 1) {
  const areas = Array.from({ length: 12 }, (_, i) => normalizeLifeArea({
    id: `a${i}`, name: `Alue ${i}`, importance: 1 + (i % 5), targetMinutesPerWeek: 120 + i * 30,
    categoryKey: ['tyo', 'perhe', 'hyvinvointi', 'harrastus', 'koti', 'kehitys', 'talous', 'muu'][i] || null
  }));
  const goals = Array.from({ length: 500 * scale }, (_, i) => normalizeGoal({
    id: `g${i}`, title: `T${i}`, lifeAreaId: i % 3 === 0 ? `a${i % 12}` : null,
    parentGoalId: i > 10 && i % 3 !== 0 ? `g${i - 1}` : null
  }));
  const categories = ['tyo', 'perhe', 'koti', 'muu'];
  const tasks = Array.from({ length: 10000 * scale }, (_, i) => normalizeTask({
    id: `t${i}`, title: `T${i}`, date: `2026-09-${String(8 + (i % 20)).padStart(2, '0')}`,
    durationMinutes: i % 7 === 0 ? null : 15 + (i % 90), goalId: i % 4 === 0 ? `g${i % (500 * scale)}` : null,
    category: categories[i % 4]
  }));
  const routines = Array.from({ length: 60 }, (_, i) => normalizeRoutine({
    id: `r${i}`, title: `R${i}`, durationMinutes: 20, recurrence: { type: 'daily', weekdays: [] },
    goalId: `g${i}`, active: true, startDate: '2026-01-01'
  }));
  const timeEntries = Array.from({ length: 5000 * scale }, (_, i) => normalizeTimeEntry({
    id: `e${i}`, entryDate: `2026-09-${String(8 + (i % 20)).padStart(2, '0')}`, minutes: 5 + (i % 60),
    lifeAreaId: i % 5 === 0 ? `a${i % 12}` : null, taskId: i % 5 === 1 ? `t${i}` : null,
    routineId: i % 5 === 2 ? `r${i % 60}` : null, source: i % 2 ? 'timer' : 'manual'
  }));
  const itemSettings = Array.from({ length: 3000 * scale }, (_, i) => normalizeItemSettings({
    id: `s${i}`, itemKind: 'task', itemId: `t${i * 3}`, energyDemand: 1 + (i % 5), alignmentOptOut: i % 11 === 0
  }));
  return {
    weekStart: '2026-09-14', todayIso: '2026-09-17', areas, goals, tasks, routines, timeEntries, itemSettings,
    capacity: normalizeWeeklyCapacity({ id: 'c', weekStart: '2026-09-14', availableMinutes: 2400, energyBudgetMinutes: 600 })
  };
}

function timed(fn, runs = 5) {
  const samples = [];
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    fn();
    samples.push(performance.now() - start);
  }
  return samples.sort((a, b) => a - b)[Math.floor(runs / 2)];
}

test('suorituskyky: 10 000 tehtävää + 5 000 kirjausta + 3 000 asetusta', (t) => {
  const input = largeFixture(1);
  analyzeWeek(input); // lämmitys
  const ms = timed(() => analyzeWeek(input));
  t.diagnostic(`analyzeWeek 10k tehtävää / 5k kirjausta: ${ms.toFixed(1)} ms (mediaani)`);
  assert.ok(ms < 400, `analyysi kesti ${ms.toFixed(1)} ms`);
  const analysis = analyzeWeek(input);
  const dailyMs = timed(() => dailyObservations(analysis, { todayIso: input.todayIso, areas: input.areas,
    explain: signal => explainSignal(signal, input.areas) }));
  t.diagnostic(`päivän havainnot: ${dailyMs.toFixed(2)} ms`);
  assert.ok(dailyMs < 50);
  const nextInputs = { ...input, weekStart: '2026-09-21' };
  const next = analyzeWeek(nextInputs);
  const proposalMs = timed(() => proposeAdjustments(analysis, {
    areas: input.areas, goals: input.goals, tasks: input.tasks, nextWeekAnalysis: next, recentAnalyses: [analysis, analysis]
  }), 3);
  t.diagnostic(`ehdotukset: ${proposalMs.toFixed(1)} ms`);
  assert.ok(proposalMs < 400);
  const proposals = proposeAdjustments(analysis, { areas: input.areas, goals: input.goals, tasks: input.tasks, nextWeekAnalysis: next });
  const previewMs = timed(() => previewAdjustments({ inputs: nextInputs, proposals }), 3);
  t.diagnostic(`esikatselu: ${previewMs.toFixed(1)} ms`);
  assert.ok(previewMs < 800);
  const planMs = timed(() => validatePlanAlignment({
    planTasks: Array.from({ length: 30 }, (_, i) => ({ ref: `p${i}`, title: 'x', date: '2026-09-18', durationMinutes: 30 })),
    base: { ...input, capacities: [input.capacity] }
  }), 3);
  t.diagnostic(`suunnitelman tarkistus: ${planMs.toFixed(1)} ms`);
  assert.ok(planMs < 800);
});

test('suorituskyky: kasvu on lineaarista (2x aineisto < 4x aika)', () => {
  const small = largeFixture(1);
  const big = largeFixture(2);
  analyzeWeek(small); analyzeWeek(big);
  const a = timed(() => analyzeWeek(small), 5);
  const b = timed(() => analyzeWeek(big), 5);
  assert.ok(b < Math.max(a * 4, a + 25), `1x ${a.toFixed(1)} ms, 2x ${b.toFixed(1)} ms`);
});
