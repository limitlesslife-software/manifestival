// Suunta (Life Alignment): puhtaan domainin testit.
//
// Kaikki päivät ovat kiinteitä ISO-merkkijonoja. Yksikään testi ei lue
// oikeaa kelloa; viikon kulku annetaan parametrina (todayIso, nowMinutes).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readCode } from './helpers/sources.mjs';
import {
  normalizeLifeArea, validateLifeArea, desiredShares, importanceLabel, IMPORTANCE_LEVELS,
  SUGGESTED_AREAS, formatMinutes, areaNameKey, compareLifeAreas
} from '../src/domain/lifeArea.js';
import {
  weekStartOf, weekDates, nextWeekStart, normalizeWeeklyCapacity, validateWeeklyCapacity,
  capacityWarnings, capacityForWeek, REALISTIC_WEEK_MINUTES
} from '../src/domain/weeklyCapacity.js';
import { normalizeTimeEntry, validateTimeEntry, entriesInRange } from '../src/domain/timeEntry.js';
import {
  analyzeWeek, buildAttributionIndex, areaForTask, areaForRoutine, areaForTimeEntry,
  weekProgress, plannedItems, summarizePlanned, SIGNAL, SEVERITY, RULES, ATTRIBUTION,
  QUALITY, primarySignal, compareSignals
} from '../src/domain/alignment.js';
import {
  explainSignal, buildReviewSnapshot, proposeAdjustments, planningFeedback, ADJUSTMENT,
  SNAPSHOT_VERSION, normalizeAlignmentReview, validateAlignmentReview, REVIEW_QUESTIONS
} from '../src/domain/alignmentReview.js';
import { normalizeTask } from '../src/domain/task.js';
import { normalizeGoal } from '../src/domain/goal.js';
import { normalizeRoutine } from '../src/domain/routine.js';
import { buildPlanningContext } from '../src/ai/planSchema.js';

// Viikko ma 2026-09-14 ... su 2026-09-20.
const WEEK = '2026-09-14';
const MON = '2026-09-14';
const THU = '2026-09-17';
const SUN = '2026-09-20';
const AFTER = '2026-09-21';

const area = (id, name, importance, target, extra = {}) =>
  normalizeLifeArea({ id, name, importance, targetMinutesPerWeek: target, ...extra });
const task = (id, date, minutes, extra = {}) =>
  normalizeTask({ id, title: 'T' + id, date, durationMinutes: minutes, ...extra });
const entry = (id, date, minutes, extra = {}) =>
  normalizeTimeEntry({ id, entryDate: date, minutes, ...extra });
const cap = (minutes, extra = {}) =>
  normalizeWeeklyCapacity({ id: 'c1', weekStart: WEEK, availableMinutes: minutes, ...extra });
const signalsOf = (analysis, kind) => analysis.signals.filter(s => s.kind === kind);

// ================================================================ ELÄMÄNALUEET

test('elämänalue: normalisointi ei keksi arvoja; null ja 0 ovat eri asioita', () => {
  const blank = normalizeLifeArea({ name: '  Perhe  ' });
  assert.equal(blank.name, 'Perhe');
  assert.equal(blank.importance, 3, 'puuttuva tärkeys saa oletuksen 3');
  assert.equal(blank.targetMinutesPerWeek, null, 'tavoite puuttuu = null, ei 0');
  assert.equal(blank.active, true);
  assert.equal(blank.categoryKey, null);

  assert.equal(normalizeLifeArea({ name: 'X', targetMinutesPerWeek: 0 }).targetMinutesPerWeek, 0);
  assert.equal(normalizeLifeArea({ name: 'X', targetMinutesPerWeek: '' }).targetMinutesPerWeek, null);
  assert.equal(normalizeLifeArea({ name: 'X', targetMinutesPerWeek: true }).targetMinutesPerWeek, null);
  assert.equal(normalizeLifeArea({ name: 'X', categoryKey: 'keksitty' }).categoryKey, null);
  assert.equal(normalizeLifeArea({ name: 'X', sortOrder: 5000 }).sortOrder, 999);
  assert.equal(normalizeLifeArea({ name: 'x'.repeat(80) }).name.length, 60);
});

test('elämänalue: validointi — nimi, tärkeys 1–5, tavoitteen raja', () => {
  assert.equal(validateLifeArea(normalizeLifeArea({ name: '' })).errors.name !== undefined, true);
  for (const bad of [0, 6, 2.5, -1]) {
    const result = validateLifeArea({ ...normalizeLifeArea({ name: 'X' }), importance: bad });
    assert.equal(result.valid, false, String(bad));
    assert.ok(result.errors.importance);
  }
  assert.equal(validateLifeArea(area('a', 'X', 3, 10081)).valid, false);
  assert.equal(validateLifeArea(area('a', 'X', 3, -5)).valid, false);
  assert.equal(validateLifeArea(area('a', 'X', 3, 10080)).valid, true);
  assert.equal(validateLifeArea(area('a', 'X', 3, null)).valid, true);
  assert.equal(validateLifeArea(area('a', 'X', 3, 0)).valid, true);
});

test('elämänalue: nimi ja kategoria ovat yksikäsitteisiä käyttäjän alueissa (kirjainkoko ei eroa)', () => {
  const others = [area('a', 'Perhe', 5, 600, { categoryKey: 'perhe' })];
  assert.ok(validateLifeArea(area('b', 'PERHE ', 3, null), others).errors.name);
  assert.ok(validateLifeArea(area('b', 'Koti', 3, null, { categoryKey: 'perhe' }), others).errors.categoryKey);
  assert.equal(validateLifeArea(area('a', 'Perhe', 4, 300, { categoryKey: 'perhe' }), others).valid, true,
    'sama alue itse ei ole kaksoiskappale');
  assert.equal(areaNameKey(' Työ '), areaNameKey('työ'));
});

test('tärkeysasteikolla on selkeät nimet; ehdotukset eivät ole oletuksia', () => {
  assert.equal(IMPORTANCE_LEVELS.length, 5);
  assert.equal(importanceLabel(5), 'Erittäin tärkeä');
  assert.equal(importanceLabel(1), 'Vähän tärkeä');
  assert.equal(importanceLabel(9), '');
  assert.ok(SUGGESTED_AREAS.length >= 9);
  assert.ok(Object.isFrozen(SUGGESTED_AREAS));
});

test('toivottu jakauma lasketaan vain aktiivisista alueista, joilla on tavoite > 0', () => {
  const { totalMinutes, shares } = desiredShares([
    area('w', 'Työ', 4, 1200), area('f', 'Perhe', 5, 600), area('o', 'Oma', 3, 0),
    area('n', 'Ei tavoitetta', 5, null), area('x', 'Pois', 5, 900, { active: false })
  ]);
  assert.equal(totalMinutes, 1800);
  assert.equal(shares.size, 2);
  assert.ok(Math.abs(shares.get('w') - 2 / 3) < 1e-9);
  assert.ok(Math.abs(shares.get('f') - 1 / 3) < 1e-9);
});

test('järjestys: aktiiviset ensin, sitten järjestysnumero ja nimi', () => {
  const list = [area('b', 'B', 3, null, { sortOrder: 2 }), area('a', 'A', 3, null, { sortOrder: 2 }),
    area('z', 'Z', 3, null, { sortOrder: 0, active: false }), area('c', 'C', 3, null, { sortOrder: 1 })];
  assert.deepEqual(list.sort(compareLifeAreas).map(a => a.id), ['c', 'a', 'b', 'z']);
});

test('minuuttien muotoilu', () => {
  assert.equal(formatMinutes(0), '0 min');
  assert.equal(formatMinutes(45), '45 min');
  assert.equal(formatMinutes(120), '2 h');
  assert.equal(formatMinutes(150), '2 h 30 min');
  assert.equal(formatMinutes(NaN), '–');
});

// ================================================================ VIIKKO JA KAPASITEETTI

test('viikon raja: maanantai johdetaan mistä tahansa päivästä, myös vuoden ja kesäajan vaihteessa', () => {
  assert.equal(weekStartOf('2026-09-20'), '2026-09-14');
  assert.equal(weekStartOf('2026-09-14'), '2026-09-14');
  assert.equal(weekStartOf('2027-01-01'), '2026-12-28', 'vuoden vaihde');
  assert.equal(weekStartOf('2026-03-29'), '2026-03-23', 'kesäajan alku (su)');
  assert.equal(weekStartOf('2026-10-25'), '2026-10-19', 'kesäajan loppu (su)');
  assert.equal(weekStartOf('2028-02-29'), '2028-02-28', 'karkauspäivä');
  assert.equal(weekStartOf('ei päivä'), null);
  assert.deepEqual(weekDates('2026-03-25'), ['2026-03-23', '2026-03-24', '2026-03-25', '2026-03-26',
    '2026-03-27', '2026-03-28', '2026-03-29'], 'kesäajan viikossa on 7 päivää');
  assert.equal(nextWeekStart('2026-12-30'), '2027-01-04');
});

test('kapasiteetti: tallennetaan maanantaille, validoidaan, energia 1–5', () => {
  const c = normalizeWeeklyCapacity({ weekStart: '2026-09-17', availableMinutes: '1500.4', energyLevel: 9 });
  assert.equal(c.weekStart, WEEK);
  assert.equal(c.availableMinutes, 1500);
  assert.equal(c.energyLevel, null, 'kelvoton energia ei muutu rajaksi');
  assert.equal(validateWeeklyCapacity(c).valid, true);
  assert.equal(validateWeeklyCapacity({ ...c, availableMinutes: null }).valid, false);
  assert.equal(validateWeeklyCapacity({ ...c, availableMinutes: 10081 }).valid, false);
  assert.equal(validateWeeklyCapacity({ ...c, availableMinutes: 0 }).valid, true, '0 on sallittu (lomaviikko)');
  assert.equal(capacityForWeek([c], '2026-09-19'), c);
  assert.equal(capacityForWeek([c], '2026-09-21'), null);
});

test('fantasiasuunnittelun varoitus: yli 60 h tai yli kaksinkertainen edellisen viikon toteumaan', () => {
  assert.deepEqual(capacityWarnings(cap(REALISTIC_WEEK_MINUTES)), []);
  assert.deepEqual(capacityWarnings(cap(REALISTIC_WEEK_MINUTES + 1)), ['unrealistic']);
  assert.deepEqual(capacityWarnings(cap(1500), { previousActualMinutes: 600 }), ['above_previous_actual']);
  assert.deepEqual(capacityWarnings(cap(1500), { previousActualMinutes: 0 }), [],
    'kirjaamaton edellinen viikko ei ole peruste varoitukselle');
});

test('viikon kulku: maanantai 0, torstai 3/7, sunnuntai 6/7, jälkeen 1; kuluvan päivän osuus', () => {
  assert.equal(weekProgress(WEEK, MON).fraction, 0);
  assert.equal(weekProgress(WEEK, THU).fraction, 3 / 7);
  assert.equal(weekProgress(WEEK, SUN).elapsedDays, 6);
  assert.equal(weekProgress(WEEK, AFTER).fraction, 1);
  assert.equal(weekProgress(WEEK, '2026-09-01').state, 'before');
  assert.equal(weekProgress(WEEK, MON, 720).elapsedDays, 0.5);
  assert.equal(weekProgress(WEEK, MON, 99999).elapsedDays, 1, 'minuutit rajataan');
});

test('kirjaus: toteuma vaatii päivän ja positiiviset minuutit; lähde on aina manual', () => {
  const e = normalizeTimeEntry({ entryDate: MON, minutes: '45', source: 'calendar' });
  assert.equal(e.minutes, 45);
  assert.equal(e.source, 'manual', 'tuntematon lähde ei pääse läpi');
  assert.equal(validateTimeEntry(e).valid, true);
  assert.equal(validateTimeEntry({ ...e, minutes: 0 }).valid, false);
  assert.equal(validateTimeEntry({ ...e, minutes: 1441 }).valid, false);
  assert.equal(validateTimeEntry({ ...e, entryDate: null }).valid, false);
  assert.equal(normalizeTimeEntry({ entryDate: MON, minutes: true }).minutes, null);
  assert.equal(entriesInRange([e, entry('x', AFTER, 30)], MON, SUN).length, 1);
});

// ================================================================ ALUEEN PÄÄTTELY

function fixtureIndex() {
  const areas = [
    area('work', 'Työ', 4, 1200, { categoryKey: 'tyo' }),
    area('fam', 'Perhe', 5, 600, { categoryKey: 'perhe' }),
    area('health', 'Terveys', 4, 300)
  ];
  const goals = [
    normalizeGoal({ id: 'g-root', title: 'Kunto', lifeAreaId: 'health' }),
    normalizeGoal({ id: 'g-child', title: 'Juoksu', parentGoalId: 'g-root' }),
    normalizeGoal({ id: 'g-work', title: 'Julkaisu', lifeAreaId: 'work' }),
    normalizeGoal({ id: 'g-none', title: 'Ilman aluetta' }),
    normalizeGoal({ id: 'g-cyc1', title: 'Sykli 1', parentGoalId: 'g-cyc2' }),
    normalizeGoal({ id: 'g-cyc2', title: 'Sykli 2', parentGoalId: 'g-cyc1' }),
    normalizeGoal({ id: 'g-gone', title: 'Poistettu alue', lifeAreaId: 'deleted-area' })
  ];
  const projects = [{ id: 'p1', goalId: 'g-work' }, { id: 'p2', goalId: 'g-none' }];
  return { areas, goals, projects, index: buildAttributionIndex({ areas, goals, projects }) };
}

test('tehtävä perii alueen tavoitteelta ja ylätavoitteelta', () => {
  const { index } = fixtureIndex();
  assert.deepEqual(areaForTask(task('1', MON, 30, { goalId: 'g-work' }), index),
    { areaId: 'work', via: ATTRIBUTION.GOAL });
  assert.deepEqual(areaForTask(task('2', MON, 30, { goalId: 'g-child' }), index),
    { areaId: 'health', via: ATTRIBUTION.GOAL }, 'alatavoite perii ylätavoitteen alueen');
});

test('tehtävä perii alueen projektin tavoitteelta; tavoite voittaa kategorian', () => {
  const { index } = fixtureIndex();
  assert.deepEqual(areaForTask(task('1', MON, 30, { projectId: 'p1', category: 'perhe' }), index),
    { areaId: 'work', via: ATTRIBUTION.PROJECT_GOAL });
  assert.deepEqual(areaForTask(task('2', MON, 30, { goalId: 'g-work', category: 'perhe' }), index),
    { areaId: 'work', via: ATTRIBUTION.GOAL }, 'nimenomainen tavoite voittaa kategorian');
});

test('liittämätön tehtävä saa alueen kategoriasta; muuten ei aluetta', () => {
  const { index } = fixtureIndex();
  assert.deepEqual(areaForTask(task('1', MON, 30, { category: 'perhe' }), index),
    { areaId: 'fam', via: ATTRIBUTION.CATEGORY });
  assert.deepEqual(areaForTask(task('2', MON, 30, { goalId: 'g-none', category: 'koti' }), index),
    { areaId: null, via: ATTRIBUTION.NONE });
  assert.deepEqual(areaForTask(task('3', MON, 30, { projectId: 'p2', category: 'perhe' }), index),
    { areaId: 'fam', via: ATTRIBUTION.CATEGORY }, 'projektin tavoite ilman aluetta -> kategoria');
});

test('sykli tai poistettu alue ei kaada eikä keksi aluetta', () => {
  const { index } = fixtureIndex();
  assert.equal(areaForTask(task('1', MON, 30, { goalId: 'g-cyc1', category: 'koti' }), index).areaId, null);
  assert.equal(areaForTask(task('2', MON, 30, { goalId: 'g-gone', category: 'koti' }), index).areaId, null,
    'viittaus alueeseen, jota ei ole, ei ole alue');
});

test('rutiini: tavoite ennen kategoriaa', () => {
  const { index } = fixtureIndex();
  assert.equal(areaForRoutine(normalizeRoutine({ id: 'r', title: 'R', goalId: 'g-root', category: 'tyo' }), index).areaId, 'health');
  assert.equal(areaForRoutine(normalizeRoutine({ id: 'r2', title: 'R', category: 'tyo' }), index).areaId, 'work');
});

test('kirjaus: suora alue > tehtävä > tavoite', () => {
  const { index } = fixtureIndex();
  const tasks = new Map([['t', task('t', MON, 30, { goalId: 'g-work' })]]);
  assert.equal(areaForTimeEntry(entry('1', MON, 30, { lifeAreaId: 'fam', taskId: 't' }), index, tasks).via, ATTRIBUTION.DIRECT);
  assert.deepEqual(areaForTimeEntry(entry('2', MON, 30, { taskId: 't', goalId: 'g-root' }), index, tasks),
    { areaId: 'work', via: ATTRIBUTION.TASK });
  assert.deepEqual(areaForTimeEntry(entry('3', MON, 30, { goalId: 'g-root' }), index, tasks),
    { areaId: 'health', via: ATTRIBUTION.GOAL });
  assert.equal(areaForTimeEntry(entry('4', MON, 30, { lifeAreaId: 'deleted' }), index, tasks).areaId, null);
});

// ================================================================ SUUNNITELTU JA TOTEUTUNUT

test('suunniteltu työ: viikon rajat, tunnettu vs. arvioimaton, herätys ei ole työtä', () => {
  const { index } = fixtureIndex();
  const items = plannedItems({
    weekStart: WEEK, index,
    tasks: [
      task('in-mon', MON, 60), task('in-sun', SUN, 30), task('prev-sun', '2026-09-13', 45),
      task('next-mon', AFTER, 45), task('no-estimate', THU, null), task('undated', null, 60),
      task('wake', MON, 0, { isWake: true, time: '07:00' }),
      task('done', THU, 90, { completed: true })
    ]
  });
  const ids = items.map(item => item.id).sort();
  assert.deepEqual(ids, ['done', 'in-mon', 'in-sun', 'no-estimate']);
  const summary = summarizePlanned(items);
  assert.equal(summary.knownMinutes, 180, 'valmis tehtävä on yhä suunniteltua työtä');
  assert.equal(summary.unknownCount, 1);
  assert.equal(summary.estimatedCount, 3);
});

test('KRIITTINEN: arvioimaton tehtävä ei ole 0 eikä 60 minuuttia', () => {
  const analysis = analyzeWeek({ weekStart: WEEK, todayIso: THU, tasks: [task('a', MON, null), task('b', MON, null)] });
  assert.equal(analysis.planned.knownMinutes, 0);
  assert.equal(analysis.planned.unknownCount, 2);
  assert.ok(analysis.dataQuality.reasons.includes('unestimated_work'));
});

test('kesto johdetaan alku- ja loppuajasta, jos ne on annettu', () => {
  const analysis = analyzeWeek({
    weekStart: WEEK, todayIso: THU,
    tasks: [normalizeTask({ id: 'x', title: 'X', date: MON, time: '09:00', endTime: '10:30' })]
  });
  assert.equal(analysis.planned.knownMinutes, 90);
});

test('rutiinin esiintymät: ohitettu päivä pois, poikkeuksen kesto käytetään', () => {
  const { index } = fixtureIndex();
  const routine = normalizeRoutine({
    id: 'r1', title: 'Lenkki', durationMinutes: 30, recurrence: { type: 'daily', weekdays: [] },
    goalId: 'g-root', active: true
  });
  const exceptions = [
    { id: 'x1', routineId: 'r1', date: '2026-09-15', type: 'skip' },
    { id: 'x2', routineId: 'r1', date: '2026-09-16', type: 'override', durationMinutes: 60 }
  ];
  const items = plannedItems({ weekStart: WEEK, routines: [routine], exceptions, index });
  assert.equal(items.length, 6, '7 päivää - 1 ohitettu');
  assert.equal(summarizePlanned(items).knownMinutes, 5 * 30 + 60);
  assert.ok(items.every(item => item.areaId === 'health'));
});

test('KRIITTINEN: ei kaksoislaskentaa — sama tehtävä kahdesti syötteessä lasketaan kerran', () => {
  const t = task('dup', MON, 60, { goalId: 'g-work', category: 'perhe' });
  const { areas, goals, projects } = fixtureIndex();
  const analysis = analyzeWeek({ weekStart: WEEK, todayIso: THU, areas, goals, projects, tasks: [t, t] });
  assert.equal(analysis.planned.knownMinutes, 60);
  const work = analysis.areas.find(a => a.id === 'work');
  const fam = analysis.areas.find(a => a.id === 'fam');
  assert.equal(work.plannedMinutes, 60);
  assert.equal(fam.plannedMinutes, 0, 'kategoria ei laske samaa tehtävää toiseen alueeseen');
});

test('toteuma: vain viikon kirjaukset, alueittain, liittämätön erikseen', () => {
  const { areas, goals, projects } = fixtureIndex();
  const analysis = analyzeWeek({
    weekStart: WEEK, todayIso: THU, areas, goals, projects,
    timeEntries: [entry('1', MON, 60, { lifeAreaId: 'fam' }), entry('2', THU, 30),
      entry('3', AFTER, 999, { lifeAreaId: 'fam' }), entry('4', '2026-09-13', 999, { lifeAreaId: 'fam' })]
  });
  assert.equal(analysis.actual.minutes, 90);
  assert.equal(analysis.actual.daysWithEntries, 2);
  assert.equal(analysis.areas.find(a => a.id === 'fam').actualMinutes, 60);
  assert.equal(analysis.unassigned.actualMinutes, 30);
});

test('liittämätön työ näkyy erikseen eikä katoa', () => {
  const analysis = analyzeWeek({
    weekStart: WEEK, todayIso: THU, areas: [area('fam', 'Perhe', 5, 600, { categoryKey: 'perhe' })],
    tasks: [task('a', MON, 60, { category: 'perhe' }), task('b', MON, 45, { category: 'koti' }), task('c', MON, null, { category: 'koti' })]
  });
  assert.deepEqual(
    { minutes: analysis.unassigned.plannedMinutes, unknown: analysis.unassigned.plannedUnknown, items: analysis.unassigned.plannedItems },
    { minutes: 45, unknown: 1, items: 2 });
  assert.ok(analysis.dataQuality.reasons.includes('unassigned_work'));
});

// ================================================================ KUORMITUS

test('OVERLOAD: tunnettu suunniteltu > kapasiteetti; luvut mukana', () => {
  const analysis = analyzeWeek({
    weekStart: WEEK, todayIso: MON, capacity: cap(600),
    tasks: [task('a', MON, 400), task('b', THU, 300), task('c', THU, null)]
  });
  const [overload] = signalsOf(analysis, SIGNAL.OVERLOAD);
  assert.equal(overload.severity, SEVERITY.ATTENTION, '700/600 = 117 % < 120 %');
  assert.deepEqual(overload.metrics, {
    plannedMinutes: 700, availableMinutes: 600, overageMinutes: 100, percentOfCapacity: 117, unknownCount: 1
  });
  assert.equal(overload.rule, 'overload.known_exceeds_capacity');
});

test('OVERLOAD: vahva kun >= 120 %, tai kapasiteetti 0 ja työtä on', () => {
  const strong = analyzeWeek({ weekStart: WEEK, todayIso: MON, capacity: cap(500), tasks: [task('a', MON, 600)] });
  assert.equal(signalsOf(strong, SIGNAL.OVERLOAD)[0].severity, SEVERITY.STRONG);
  const zero = analyzeWeek({ weekStart: WEEK, todayIso: MON, capacity: cap(0), tasks: [task('a', MON, 15)] });
  const signal = signalsOf(zero, SIGNAL.OVERLOAD)[0];
  assert.equal(signal.severity, SEVERITY.STRONG);
  assert.equal(signal.metrics.percentOfCapacity, null, 'nollalla ei jaeta');
});

test('OVERLOAD: tasan kapasiteetti ei ole ylitys; arvioimaton työ lähellä rajaa on "mahdollinen"', () => {
  const exact = analyzeWeek({ weekStart: WEEK, todayIso: MON, capacity: cap(600), tasks: [task('a', MON, 600)] });
  assert.equal(signalsOf(exact, SIGNAL.OVERLOAD).length, 0);
  const possible = analyzeWeek({
    weekStart: WEEK, todayIso: MON, capacity: cap(600), tasks: [task('a', MON, 560), task('b', MON, null)]
  });
  const [signal] = signalsOf(possible, SIGNAL.OVERLOAD);
  assert.equal(signal.severity, SEVERITY.INFO);
  assert.equal(signal.rule, 'overload.possible_with_unestimated');
  const far = analyzeWeek({
    weekStart: WEEK, todayIso: MON, capacity: cap(600), tasks: [task('a', MON, 100), task('b', MON, null)]
  });
  assert.equal(signalsOf(far, SIGNAL.OVERLOAD).length, 0, 'kaukana rajasta ei arvailla');
});

test('OVERLOAD: ilman kapasiteettia ei arvioida — aineiston laatu kertoo sen', () => {
  const analysis = analyzeWeek({ weekStart: WEEK, todayIso: MON, tasks: [task('a', MON, 5000)] });
  assert.equal(signalsOf(analysis, SIGNAL.OVERLOAD).length, 0);
  assert.ok(analysis.dataQuality.reasons.includes('no_capacity'));
  assert.equal(analysis.capacity.declared, false);
});

test('OVERLOAD: toisen viikon kapasiteettia ei käytetä', () => {
  const analysis = analyzeWeek({
    weekStart: WEEK, todayIso: MON, tasks: [task('a', MON, 5000)],
    capacity: normalizeWeeklyCapacity({ id: 'c', weekStart: AFTER, availableMinutes: 60 })
  });
  assert.equal(signalsOf(analysis, SIGNAL.OVERLOAD).length, 0);
});

// ================================================================ HUOMIOTTA JÄÄMINEN

// Viikon päivät ma..to: sääntöversio 3 vertaa toteumaa vasta, kun
// kirjauksia on vähintään kahdelta päivältä ja puolelta seurantajakson
// päivistä. Tämä kirjaaja kirjaa neljänä päivänä (ma–to).
const LOG_DAYS = [MON, '2026-09-15', '2026-09-16', THU];

/** Minuutit tasan neljälle päivälle (jakojäännös ensimmäiselle); summa pysyy samana. */
function spread(id, minutes, extra = {}) {
  const base = Math.floor(minutes / LOG_DAYS.length);
  const rest = minutes - base * LOG_DAYS.length;
  return LOG_DAYS.map((date, i) => entry(`${id}${i}`, date, base + (i === 0 ? rest : 0), extra))
    .filter(e => e.minutes > 0);
}

// Muutettu sääntöversiossa 3: työtä kirjataan ma–to (ennen: vain
// maanantaina 300 min). Yhden päivän kirjaus ei enää riitä toteuman
// vertailuun, joten kiinteä kirjaaja kirjaa neljänä päivänä; luvut
// (odotettu 300 torstaina, 700 viikon jälkeen) ovat ennallaan.
function neglectCase({ todayIso, actualFamily = 0, importance = 5, target = 700, extraEntries = true, active = true }) {
  const areas = [area('fam', 'Perhe', importance, target, { active }), area('work', 'Työ', 3, 1200)];
  const timeEntries = [];
  if (actualFamily > 0) timeEntries.push(entry('f', MON, actualFamily, { lifeAreaId: 'fam' }));
  if (extraEntries) timeEntries.push(...spread('w', 300, { lifeAreaId: 'work' }));
  return analyzeWeek({ weekStart: WEEK, todayIso, areas, timeEntries });
}

test('NEGLECT: maanantaina toteumaa ei verrata (viikko ei ole kulunut)', () => {
  const analysis = neglectCase({ todayIso: MON });
  const signals = signalsOf(analysis, SIGNAL.NEGLECT);
  assert.ok(signals.every(s => s.basis === 'planned' && s.severity === SEVERITY.INFO),
    'maanantaina vain suunnitelmaan perustuva tiedoksi-havainto');
});

test('NEGLECT: keskiviikkona (2/7) ei vielä toteumavertailua, torstaista (3/7) alkaen kyllä', () => {
  const wed = neglectCase({ todayIso: '2026-09-16' });
  assert.ok(signalsOf(wed, SIGNAL.NEGLECT).every(s => s.basis === 'planned'));
  const thu = neglectCase({ todayIso: THU });
  const [signal] = signalsOf(thu, SIGNAL.NEGLECT);
  assert.equal(signal.basis, 'actual');
  assert.equal(signal.severity, SEVERITY.ATTENTION);
  assert.equal(signal.metrics.expectedByNowMinutes, 300, '700 * 3/7');
  assert.equal(signal.metrics.actualMinutes, 0);
});

test('NEGLECT: kynnys on puolet odotetusta', () => {
  // Torstai: odotettu 300. 150 = täsmälleen puolet -> ei havaintoa. 149 -> havainto.
  assert.equal(signalsOf(neglectCase({ todayIso: THU, actualFamily: 150 }), SIGNAL.NEGLECT).length, 0);
  assert.equal(signalsOf(neglectCase({ todayIso: THU, actualFamily: 149 }), SIGNAL.NEGLECT).length, 1);
});

test('NEGLECT: viikon jälkeen alle neljännes = vahva', () => {
  const strong = neglectCase({ todayIso: AFTER, actualFamily: 100 });
  assert.equal(signalsOf(strong, SIGNAL.NEGLECT)[0].severity, SEVERITY.STRONG, '100/700 < 25 %');
  const attention = neglectCase({ todayIso: AFTER, actualFamily: 200 });
  assert.equal(signalsOf(attention, SIGNAL.NEGLECT)[0].severity, SEVERITY.ATTENTION, '200/700 = 29 %');
});

test('NEGLECT: vähemmän tärkeä alue, nolla- tai puuttuva tavoite ja pois käytöstä oleva alue eivät ole huomiotta jääviä', () => {
  assert.equal(signalsOf(neglectCase({ todayIso: AFTER, importance: 3 }), SIGNAL.NEGLECT).length, 0);
  assert.equal(signalsOf(neglectCase({ todayIso: AFTER, target: 0 }), SIGNAL.NEGLECT).length, 0);
  assert.equal(signalsOf(neglectCase({ todayIso: AFTER, target: null }), SIGNAL.NEGLECT).length, 0);
  assert.equal(signalsOf(neglectCase({ todayIso: AFTER, target: 20 }), SIGNAL.NEGLECT).length, 0,
    'alle 30 min tavoite ei ole mielekäs mittari');
  assert.equal(signalsOf(neglectCase({ todayIso: AFTER, active: false }), SIGNAL.NEGLECT).length, 0);
});

test('NEGLECT: jos toteumaa ei kirjata lainkaan, arvio tehdään suunnitelmasta eikä toteumaa väitetä nollaksi', () => {
  const analysis = neglectCase({ todayIso: AFTER, extraEntries: false });
  const [signal] = signalsOf(analysis, SIGNAL.NEGLECT);
  assert.equal(signal.basis, 'planned');
  assert.equal(signal.severity, SEVERITY.INFO);
  assert.equal(signal.metrics.actualTracked, false);
});

// ================================================================ POIKKEAMA TAVOITTEISTA

// Muutettu sääntöversiossa 3: kirjaukset jaetaan ma–to (ennen kaikki
// maanantaina). Toteuman jakaumaa verrataan vain vakiintuneesta
// kirjaamisesta; alueiden summat ja siten prosentit ovat ennallaan.
function misalignmentCase(workMinutes, familyMinutes, { unassigned = 0, targets = [1200, 750, 1050] } = {}) {
  const areas = [area('work', 'Työ', 3, targets[0]), area('fam', 'Perhe', 3, targets[1]), area('oma', 'Oma aika', 3, targets[2])];
  const timeEntries = [
    ...spread('w', workMinutes, { lifeAreaId: 'work' }),
    ...spread('f', familyMinutes, { lifeAreaId: 'fam' }),
    ...spread('o', 1000 - workMinutes - familyMinutes, { lifeAreaId: 'oma' })
  ];
  if (unassigned > 0) timeEntries.push(...spread('u', unassigned));
  return analyzeWeek({ weekStart: WEEK, todayIso: AFTER, areas, timeEntries });
}

test('MISALIGNMENT: "Työ sai 62 % kirjatusta ajastasi, vaikka tavoite oli 40 %"', () => {
  const analysis = misalignmentCase(620, 120);
  const work = signalsOf(analysis, SIGNAL.MISALIGNMENT).find(s => s.areaId === 'work');
  assert.equal(work.metrics.actualPercent, 62);
  assert.equal(work.metrics.desiredPercent, 40);
  assert.equal(work.metrics.direction, 'over');
  assert.equal(work.severity, SEVERITY.ATTENTION, '22 prosenttiyksikköä');
  const text = explainSignal(work, [area('work', 'Työ', 3, 1200)]).text;
  // Versio 3: osuus on KIRJATUSTA ajasta (ennen "ajastasi"), ei eletystä ajasta.
  assert.match(text, /Työ sai 62 % kirjatusta ajastasi, vaikka tavoite oli 40 %/);

  // Perhe 12 % vs 25 % = -13 pp: alle kynnyksen, ei havaintoa -- mutta luvut näkyvät alueriviltä.
  assert.equal(signalsOf(analysis, SIGNAL.MISALIGNMENT).some(s => s.areaId === 'fam'), false);
  const famRow = analysis.areas.find(a => a.id === 'fam');
  assert.deepEqual([famRow.actualPercent, famRow.desiredPercent], [12, 25]);
});

test('MISALIGNMENT: "Perhe sai 10 %, tavoite oli 25 %" (vaje -15 pp)', () => {
  const analysis = misalignmentCase(620, 100);
  const family = signalsOf(analysis, SIGNAL.MISALIGNMENT).find(s => s.areaId === 'fam');
  assert.equal(family.metrics.direction, 'under');
  // Versio 3: "kirjatusta ajastasi" (ennen "ajastasi").
  assert.match(explainSignal(family, [area('fam', 'Perhe', 3, 750)]).text, /Perhe sai 10 % kirjatusta ajastasi, vaikka tavoite oli 25 %/);
});

test('MISALIGNMENT: kynnys 15 pp, vahva 25 pp', () => {
  const workSignal = minutes => signalsOf(misalignmentCase(minutes, 250), SIGNAL.MISALIGNMENT)
    .find(s => s.areaId === 'work');
  assert.equal(workSignal(540), undefined, '54 % vs 40 % = +14 pp');
  assert.equal(workSignal(550).severity, SEVERITY.ATTENTION, '+15 pp');
  assert.equal(workSignal(640).severity, SEVERITY.ATTENTION, '+24 pp');
  assert.equal(workSignal(650).severity, SEVERITY.STRONG, '+25 pp');
});

test('MISALIGNMENT: vajaa aineisto (alle 60 % liitetty) laskee vakavuuden tiedoksi', () => {
  const analysis = misalignmentCase(700, 100, { unassigned: 1000 });
  const work = signalsOf(analysis, SIGNAL.MISALIGNMENT).find(s => s.areaId === 'work');
  assert.equal(work.severity, SEVERITY.INFO);
  assert.equal(work.metrics.incomplete, true);
  assert.equal(work.metrics.coveragePercent, 50);
  assert.match(explainSignal(work, []).text, /suuntaa-antava/);
});

test('MISALIGNMENT: alle 2 h aineistosta ei tehdä johtopäätöstä', () => {
  const areas = [area('work', 'Työ', 3, 600), area('fam', 'Perhe', 3, 600)];
  const analysis = analyzeWeek({
    weekStart: WEEK, todayIso: AFTER, areas, timeEntries: [entry('w', MON, 100, { lifeAreaId: 'work' })]
  });
  assert.equal(signalsOf(analysis, SIGNAL.MISALIGNMENT).length, 0);
});

test('MISALIGNMENT: ilman toteumaa arvioidaan suunnitelma, ja se on enintään "huomio"', () => {
  const areas = [area('work', 'Työ', 3, 600, { categoryKey: 'tyo' }), area('fam', 'Perhe', 3, 600, { categoryKey: 'perhe' })];
  const analysis = analyzeWeek({
    weekStart: WEEK, todayIso: MON, areas,
    tasks: [task('a', MON, 900, { category: 'tyo' }), task('b', MON, 100, { category: 'perhe' })]
  });
  const work = signalsOf(analysis, SIGNAL.MISALIGNMENT).find(s => s.areaId === 'work');
  assert.equal(work.basis, 'planned');
  assert.equal(work.severity, SEVERITY.ATTENTION, '+40 pp olisi vahva, mutta suunnitelma on muutettavissa');
  assert.match(explainSignal(work, areas).text, /suunnitellusta ajastasi/);
});

test('MISALIGNMENT: tavoite 0 on päätös (aika siihen on poikkeama); puuttuva tavoite ei ole', () => {
  const areas = [area('work', 'Työ', 3, 600), area('games', 'Pelit', 2, 0), area('free', 'Vapaa', 3, null)];
  // Versio 3: kirjaukset ma–to (ennen vain maanantaina), summat ennallaan.
  const analysis = analyzeWeek({
    weekStart: WEEK, todayIso: AFTER, areas,
    timeEntries: [...spread('w', 300, { lifeAreaId: 'work' }), ...spread('g', 200, { lifeAreaId: 'games' }),
      ...spread('f', 200, { lifeAreaId: 'free' })]
  });
  const ids = signalsOf(analysis, SIGNAL.MISALIGNMENT).map(s => s.areaId);
  assert.ok(ids.includes('games'), 'tavoite 0 ja 29 % ajasta');
  assert.equal(ids.includes('free'), false, 'tavoitetta ei asetettu: ei tulkita');
});

test('MISALIGNMENT: vajetta ei raportoida kahdesti, jos alue on jo huomiotta jäämässä', () => {
  const areas = [area('work', 'Työ', 3, 600), area('fam', 'Perhe', 5, 600)];
  // Versio 3: työ kirjataan ma–to (ennen vain maanantaina), summat ennallaan.
  const analysis = analyzeWeek({
    weekStart: WEEK, todayIso: AFTER, areas,
    timeEntries: [...spread('w', 900, { lifeAreaId: 'work' }), entry('f', MON, 60, { lifeAreaId: 'fam' })]
  });
  assert.equal(signalsOf(analysis, SIGNAL.NEGLECT).filter(s => s.areaId === 'fam').length, 1);
  assert.equal(signalsOf(analysis, SIGNAL.MISALIGNMENT).filter(s => s.areaId === 'fam').length, 0);
  assert.equal(signalsOf(analysis, SIGNAL.MISALIGNMENT).filter(s => s.areaId === 'work').length, 1);
});

// ================================================================ TÄRKEYS VS. KAPASITEETTI

test('KRIITTINEN: tärkeys ei muuta tavoitetta eikä kapasiteettia; jännite näytetään', () => {
  const areas = [area('fam', 'Perhe', 5, 1500), area('work', 'Työ', 4, 1500)];
  const capacity = cap(1800);
  const analysis = analyzeWeek({ weekStart: WEEK, todayIso: MON, areas, capacity });
  assert.equal(areas[0].targetMinutesPerWeek, 1500);
  assert.equal(capacity.availableMinutes, 1800);
  const [tension] = signalsOf(analysis, SIGNAL.TARGET_TENSION);
  assert.equal(tension.severity, SEVERITY.INFO);
  assert.deepEqual(tension.metrics, { targetsMinutes: 3000, availableMinutes: 1800, differenceMinutes: 1200 });
  assert.match(explainSignal(tension, areas).why, /Tärkeys ja kapasiteetti ovat eri asioita/);

  // Tärkeyden nosto ei muuta mitään laskettua lukua.
  const raised = analyzeWeek({ weekStart: WEEK, todayIso: MON, capacity,
    areas: [{ ...areas[0], importance: 1 }, areas[1]] });
  assert.deepEqual(signalsOf(raised, SIGNAL.TARGET_TENSION)[0].metrics, tension.metrics);
});

// ================================================================ LAATU, JÄRJESTYS

test('aineiston laatu: ei alueita -> none; arvioimaton enemmistö -> weak; puutteet -> partial; muuten good', () => {
  assert.equal(analyzeWeek({ weekStart: WEEK, todayIso: MON }).dataQuality.level, QUALITY.NONE);
  const areas = [area('work', 'Työ', 3, 600, { categoryKey: 'tyo' })];
  assert.equal(analyzeWeek({ weekStart: WEEK, todayIso: MON, areas,
    tasks: [task('a', MON, null, { category: 'tyo' }), task('b', MON, null, { category: 'tyo' }), task('c', MON, 30, { category: 'tyo' })]
  }).dataQuality.level, QUALITY.WEAK);
  assert.equal(analyzeWeek({ weekStart: WEEK, todayIso: MON, areas, capacity: cap(600),
    tasks: [task('a', MON, 30, { category: 'tyo' })] }).dataQuality.level, QUALITY.PARTIAL, 'ei toteumaa');
  // Versio 3: "kattava" vaatii vakiintuneen kirjaamisen — kirjauksia
  // kahdelta päivältä ja vähintään neljännes kapasiteetista kuluneelta
  // osalta viikkoa (ennen: yksi 30 min kirjaus maanantaina riitti).
  const good = analyzeWeek({ weekStart: WEEK, todayIso: THU, areas, capacity: cap(600),
    tasks: [task('a', MON, 30, { category: 'tyo' })],
    timeEntries: [entry('e', MON, 60, { lifeAreaId: 'work' }), entry('e2', '2026-09-15', 60, { lifeAreaId: 'work' })] });
  assert.equal(good.dataQuality.level, QUALITY.GOOD);
  assert.deepEqual(good.dataQuality.reasons, []);
  const oneDay = analyzeWeek({ weekStart: WEEK, todayIso: THU, areas, capacity: cap(600),
    tasks: [task('a', MON, 30, { category: 'tyo' })], timeEntries: [entry('e', MON, 30, { lifeAreaId: 'work' })] });
  assert.equal(oneDay.dataQuality.level, QUALITY.PARTIAL, 'yhden päivän kirjaus on osittainen');
  assert.deepEqual(oneDay.dataQuality.reasons, ['partial_actual']);
});

test('havainnot järjestetään vakavuuden ja lajin mukaan; ensimmäinen on päivän havainto', () => {
  const sorted = [
    { kind: SIGNAL.TARGET_TENSION, severity: SEVERITY.INFO, areaId: null },
    { kind: SIGNAL.NEGLECT, severity: SEVERITY.ATTENTION, areaId: 'b' },
    { kind: SIGNAL.OVERLOAD, severity: SEVERITY.ATTENTION, areaId: null },
    { kind: SIGNAL.MISALIGNMENT, severity: SEVERITY.STRONG, areaId: 'a' }
  ].sort(compareSignals).map(s => s.kind);
  assert.deepEqual(sorted, [SIGNAL.MISALIGNMENT, SIGNAL.OVERLOAD, SIGNAL.NEGLECT, SIGNAL.TARGET_TENSION]);
  assert.equal(primarySignal({ signals: [] }), null);
});

test('analyysi on deterministinen ja ei muuta syötettä', () => {
  const { areas, goals, projects } = fixtureIndex();
  const tasks = [task('a', MON, 60, { goalId: 'g-work' }), task('b', THU, null, { category: 'perhe' })];
  const input = { weekStart: THU, todayIso: SUN, areas, goals, projects, tasks, capacity: cap(30) };
  const frozen = JSON.stringify(input);
  const first = JSON.stringify(analyzeWeek(input));
  for (let i = 0; i < 20; i += 1) assert.equal(JSON.stringify(analyzeWeek(input)), first);
  assert.equal(JSON.stringify(input), frozen);
  assert.equal(analyzeWeek(input).weekStart, WEEK, 'mikä tahansa viikon päivä kelpaa');
});

test('kesäajan viikko: seitsemän päivää, rutiini joka päivä, ei tuplaa eikä puutetta', () => {
  const routine = normalizeRoutine({ id: 'r', title: 'R', durationMinutes: 20, recurrence: { type: 'daily', weekdays: [] }, active: true });
  for (const week of ['2026-03-23', '2026-10-19']) {
    const analysis = analyzeWeek({ weekStart: week, todayIso: week, routines: [routine] });
    assert.equal(analysis.planned.itemCount, 7, week);
    assert.equal(analysis.planned.knownMinutes, 140, week);
  }
});

// ================================================================ SELITYKSET

test('jokaisella havainnolla on otsikko, teksti ja "miksi" -- ilman moralisointia', () => {
  const areas = [area('fam', 'Perhe', 5, 700), area('work', 'Työ', 3, 1200)];
  const analysis = analyzeWeek({
    weekStart: WEEK, todayIso: AFTER, areas, capacity: cap(300),
    tasks: [task('a', MON, 400)],
    timeEntries: [entry('w', MON, 900, { lifeAreaId: 'work' })]
  });
  assert.ok(analysis.signals.length >= 3);
  for (const signal of analysis.signals) {
    const text = explainSignal(signal, areas);
    assert.ok(text.title && text.text && text.why, signal.kind);
    assert.equal(/epäonnist|laiska|huono|pitäisi hävetä|suoritus/i.test(text.title + text.text + text.why), false,
      'sävy on toteava');
  }
});

// ================================================================ KATSAUS JA EHDOTUKSET

test('tilannekuva on versioitu ja tiivis: ei tehtävien otsikoita eikä muistiinpanoja', () => {
  const areas = [area('fam', 'Perhe', 5, 700)];
  const analysis = analyzeWeek({
    weekStart: WEEK, todayIso: AFTER, areas, capacity: cap(600),
    tasks: [task('salainen', MON, 60, { title: 'SALAINEN OTSIKKO', note: 'MUISTIINPANO' })],
    timeEntries: [entry('e', MON, 30, { lifeAreaId: 'fam', note: 'KIRJAUKSEN MUISTIINPANO' })]
  });
  const snapshot = buildReviewSnapshot(analysis);
  const json = JSON.stringify(snapshot);
  assert.equal(snapshot.version, SNAPSHOT_VERSION);
  assert.equal(json.includes('SALAINEN'), false);
  assert.equal(json.includes('MUISTIINPANO'), false);
  assert.equal(json.includes('items'), false, 'suunnitelman kohteita ei kopioida');
  assert.ok(json.length < 65536 / 4, 'mahtuu kannan 64 kt rajaan reilusti');
  assert.ok(Array.isArray(snapshot.signals));
  assert.equal(snapshot.areas[0].name, 'Perhe');
});

test('katsauksen normalisointi ja validointi', () => {
  const review = normalizeAlignmentReview({ weekStart: WEEK, snapshot: { version: 1 }, reflection: '  mietin  ', adjustments: 'x' });
  assert.equal(review.reflection, 'mietin');
  assert.deepEqual(review.adjustments, []);
  assert.equal(validateAlignmentReview(review).valid, true);
  assert.equal(validateAlignmentReview(normalizeAlignmentReview({ weekStart: WEEK })).valid, false);
  assert.equal(normalizeAlignmentReview({ snapshot: [] }).snapshot.version, undefined);
  assert.equal(REVIEW_QUESTIONS.length, 7);
});

function proposalFixture() {
  const areas = [
    area('fam', 'Perhe', 5, 600, { categoryKey: 'perhe' }),
    area('hobby', 'Harrastus', 2, 120, { categoryKey: 'harrastus' }),
    area('work', 'Työ', 4, 1200, { categoryKey: 'tyo' })
  ];
  const goals = [
    normalizeGoal({ id: 'g-fam', title: 'Enemmän aikaa lapsille', lifeAreaId: 'fam', priority: 'korkea' }),
    normalizeGoal({ id: 'g-fam2', title: 'Sukujuhlat', lifeAreaId: 'fam', priority: 'matala' }),
    normalizeGoal({ id: 'g-hobby', title: 'Kitara', lifeAreaId: 'hobby' }),
    normalizeGoal({ id: 'g-work', title: 'Julkaisu', lifeAreaId: 'work' })
  ];
  const next = '2026-09-21';
  const tasks = [
    task('this1', MON, 900, { category: 'tyo' }),
    task('n-work', next, 500, { category: 'tyo', priority: 'korkea' }),
    task('n-hobby', '2026-09-22', 200, { goalId: 'g-hobby', priority: 'normaali' }),
    task('n-none', '2026-09-23', 150, { category: 'koti', priority: 'normaali' }),
    task('n-low', '2026-09-24', 100, { category: 'tyo', priority: 'matala' }),
    task('n-done', '2026-09-24', 10, { category: 'koti', completed: true })
  ];
  // Muutettu sääntöversiossa 3: toteuma kirjataan viitenä päivänä (ennen
  // yksi 800 min kirjaus maanantaina). Tavoitteen muutos ja kapasiteetti-
  // ehdotus perustuvat vain vakiintuneeseen, lähes koko viikon kattavaan
  // kirjaamiseen. Summa on yhä 800 min; Perhe saa 60 min (ennen 0 min),
  // koska 0 ei enää kelpaa ehdotetuksi tavoitteeksi (0 = "ei nyt").
  const analysis = analyzeWeek({ weekStart: WEEK, todayIso: AFTER, areas, goals, tasks, capacity: cap(600),
    timeEntries: [
      entry('w1', MON, 200, { lifeAreaId: 'work' }), entry('w2', '2026-09-15', 200, { lifeAreaId: 'work' }),
      entry('w3', '2026-09-16', 200, { lifeAreaId: 'work' }), entry('w4', THU, 140, { lifeAreaId: 'work' }),
      entry('f1', '2026-09-18', 60, { lifeAreaId: 'fam' })
    ] });
  const nextAnalysis = analyzeWeek({ weekStart: next, todayIso: AFTER, areas, goals, tasks });
  return { areas, goals, tasks, analysis, nextAnalysis };
}

test('ehdotukset: kuvaus, ei muutosta; deterministiset tunnisteet', () => {
  const { areas, goals, tasks, analysis, nextAnalysis } = proposalFixture();
  const before = JSON.stringify({ areas, goals, tasks });
  const proposals = proposeAdjustments(analysis, { areas, goals, tasks, nextWeekAnalysis: nextAnalysis });
  assert.equal(JSON.stringify({ areas, goals, tasks }), before, 'ehdotus ei muuttanut mitään');
  assert.deepEqual(proposeAdjustments(analysis, { areas, goals, tasks, nextWeekAnalysis: nextAnalysis }).map(p => p.id),
    proposals.map(p => p.id));
  assert.equal(new Set(proposals.map(p => p.id)).size, proposals.length, 'ei kaksoiskappaleita');
  for (const proposal of proposals) {
    assert.ok(Object.values(ADJUSTMENT).includes(proposal.type));
    assert.ok(proposal.label);
  }
});

test('ehdotus: ensi viikon keventäminen siirtää eteenpäin liittämättömän ja vähiten tärkeän ensin', () => {
  const { areas, goals, tasks, analysis, nextAnalysis } = proposalFixture();
  const proposals = proposeAdjustments(analysis, { areas, goals, tasks, nextWeekAnalysis: nextAnalysis });
  const unschedule = proposals.find(p => p.type === ADJUSTMENT.POSTPONE_TASKS);
  // Ensi viikolla tunnettu 960 min (valmiskin on suunniteltua työtä), kapasiteetti 600:
  // ylitys 360 -> n-none 150 + n-hobby 200 + n-low 100 = 450 riittää.
  assert.ok(unschedule, 'ylitys ensi viikolla -> ehdotus');
  assert.equal(unschedule.payload.taskIds[0], 'n-none', 'liittämätön ensin');
  assert.equal(unschedule.payload.taskIds[1], 'n-hobby', 'sitten vähiten tärkeä alue');
  assert.equal(unschedule.payload.taskIds[2], 'n-low', 'saman alueen sisällä matalin prioriteetti');
  assert.equal(unschedule.payload.freedMinutes, 450);
  assert.equal(unschedule.payload.days, 7);
  assert.equal(unschedule.payload.taskIds.includes('n-done'), false, 'valmista ei siirretä');
  assert.equal(unschedule.payload.taskIds.includes('n-work'), false, 'riittävä määrä vapautuu ennen tärkeintä');
});

test('ehdotus: kuormituksessa vähiten tärkeän alueen tavoite ehdotetaan keskeytettäväksi, ei tärkeän', () => {
  const { areas, goals, tasks, analysis, nextAnalysis } = proposalFixture();
  const pauses = proposeAdjustments(analysis, { areas, goals, tasks, nextWeekAnalysis: nextAnalysis })
    .filter(p => p.type === ADJUSTMENT.PAUSE_GOAL).map(p => p.payload.goalId);
  assert.deepEqual(pauses, ['g-hobby']);
});

test('ehdotus: huomiotta jäävälle alueelle varaus tärkeimpään tavoitteeseen TAI tavoitteen muutos', () => {
  const { areas, goals, tasks, analysis, nextAnalysis } = proposalFixture();
  const proposals = proposeAdjustments(analysis, { areas, goals, tasks, nextWeekAnalysis: nextAnalysis });
  const create = proposals.find(p => p.type === ADJUSTMENT.CREATE_TASK && p.payload.areaId === 'fam');
  assert.ok(create);
  assert.equal(create.payload.goalId, 'g-fam', 'korkean prioriteetin tavoite');
  assert.equal(create.payload.date, '2026-09-21');
  assert.equal(create.payload.durationMinutes, 60);
  const change = proposals.find(p => p.type === ADJUSTMENT.CHANGE_TARGET && p.payload.areaId === 'fam');
  assert.ok(change, 'käyttäjä voi myös todeta tavoitteen epärealistiseksi');
  assert.equal(change.payload.from, 600);
  assert.equal(change.payload.to, 60, 'kirjatun viikon tahti (60 min), ei koskaan alle mielekkään tavoitteen');
});

test('ehdotus: kapasiteetti ensi viikolle vain jos sitä ei ole asetettu', () => {
  const { areas, goals, tasks, analysis } = proposalFixture();
  const without = proposeAdjustments(analysis, { areas, goals, tasks });
  // Suunta 2: viikko on päättynyt ja kirjattu toteuma (800 min) poikkesi
  // arviosta (600 min) selvästi, joten ehdotus perustuu toteumaan
  // (lähimpään puoleen tuntiin) ja on KYSYMYS, ei korjaus. Arvo on
  // käyttäjän muokattavissa ennen vahvistusta.
  const capacity = without.find(p => p.type === ADJUSTMENT.SET_CAPACITY);
  assert.equal(capacity.payload.availableMinutes, 810);
  assert.equal(capacity.reason.kind, 'capacity_deviation');
  assert.match(capacity.label, /\?$/);
  assert.match(capacity.detail, /Arvioit ehtiväsi 10 h, ja kirjasit 13 h 20 min/);
  const withCapacity = proposeAdjustments(analysis, {
    areas, goals, tasks, nextCapacity: normalizeWeeklyCapacity({ weekStart: '2026-09-21', availableMinutes: 500 })
  });
  assert.equal(withCapacity.some(p => p.type === ADJUSTMENT.SET_CAPACITY), false);
});

test('ehdotukset eivät tule tyhjästä: ei havaintoja, ei muita ehdotuksia kuin kapasiteetti', () => {
  const areas = [area('a', 'A', 3, 60)];
  const analysis = analyzeWeek({ weekStart: WEEK, todayIso: AFTER, areas, capacity: cap(600) });
  const proposals = proposeAdjustments(analysis, { areas });
  assert.deepEqual(proposals.map(p => p.type), [ADJUSTMENT.SET_CAPACITY]);
});

// ================================================================ PALAUTE SUUNNITTELULLE

test('suunnittelun palaute: kuormitus, rajattu kapasiteetti, painotettavat alueet', () => {
  const { analysis } = proposalFixture();
  const feedback = planningFeedback(analysis);
  assert.equal(feedback.overloaded, true);
  assert.equal(feedback.capHours, 10);
  assert.equal(feedback.reduceByMinutes, 300);
  assert.ok(feedback.prioritizeAreaIds.includes('fam'));
  assert.deepEqual(planningFeedback(analysis, { nextCapacity: { availableMinutes: 1500 } }).capHours, 25);
  assert.equal(planningFeedback(null), null);
});

test('KRIITTINEN: suunnittelukontekstin raja vain laskee vapaata aikaa, ei koskaan nosta', () => {
  const capacity = { dayCount: 7, totalUsableMinutes: 7 * 300 };
  assert.equal(buildPlanningContext({ capacity }).weeklyFreeHours, 35);
  assert.equal(buildPlanningContext({ capacity, alignmentCapHours: 20 }).weeklyFreeHours, 20);
  assert.equal(buildPlanningContext({ capacity, alignmentCapHours: 50 }).weeklyFreeHours, 35);
  assert.equal(buildPlanningContext({ capacity, alignmentCapHours: null }).weeklyFreeHours, 35);
  assert.equal(buildPlanningContext({ capacity, alignmentCapHours: -1 }).weeklyFreeHours, 35);
  assert.equal(buildPlanningContext({ alignmentCapHours: 12 }).weeklyFreeHours, 12);
});

// ================================================================ ARKKITEHTUURI

test('KRIITTINEN: havaintojen luokittelu ei käytä tekoälyä eikä verkkoa', () => {
  for (const file of ['src/domain/alignment.js', 'src/domain/alignmentReview.js', 'src/domain/lifeArea.js',
    'src/domain/weeklyCapacity.js', 'src/domain/timeEntry.js']) {
    const source = readCode(file);
    assert.equal(/from '\.\.\/ai\//.test(source), false, `${file} tuo ai-kerroksesta`);
    for (const forbidden of ['fetch(', 'anthropic', 'claude', '/api/', 'Math.random', 'Date.now(']) {
      assert.equal(source.toLowerCase().includes(forbidden.toLowerCase()), false, `${file}: ${forbidden}`);
    }
  }
});

test('KRIITTINEN: havaintoja ei tallenneta — mikään repositorio ei kirjoita havaintoja', () => {
  const repo = readCode('src/data/collectionsRepo.js');
  assert.equal(/signals_|table: 'signals'|alignment_signals/.test(repo), false);
  const migration = readCode('supabase/migrations/0012_life_alignment.sql');
  assert.equal(/create table public\.\w*signal/.test(migration), false);
});

test('suomen lukumäärä: "1 asia", "2 asiaa"; kuormituksen lause on luettava', async () => {
  const { countOf } = await import('../src/domain/lifeArea.js');
  assert.equal(countOf(1, 'asia', 'asiaa'), '1 asia');
  assert.equal(countOf(0, 'asia', 'asiaa'), '0 asiaa');
  assert.equal(countOf(3, 'tehtävä', 'tehtävää'), '3 tehtävää');
  const analysis = analyzeWeek({ weekStart: WEEK, todayIso: MON, capacity: cap(600),
    tasks: [task('a', MON, 700), task('b', MON, null)] });
  const text = explainSignal(analysis.signals.find(s => s.kind === SIGNAL.OVERLOAD), []).text;
  assert.equal(text, 'Suunniteltu työ 11 h 40 min on 1 h 40 min yli viikon kapasiteetin 10 h (117 % kapasiteetista). '
    + 'Lisäksi 1 asia on arvioimatta.');
});
