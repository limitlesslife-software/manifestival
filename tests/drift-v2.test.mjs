// Todellisuus / ajautuminen v2 (aalto L): src/domain/driftSignals.js ja
// sovelluskerroksen currentDriftSignals / currentCapacityBias.
//
// Jokainen havainto testataan positiivisena, negatiivisena ja kynnyksen
// reunalla. Lisäksi: sävy (ei syyllistäviä sanoja), säätö on aina mukana,
// vanhat viisi havaintoa säilyvät ennallaan ja CAPACITY_BIAS syöttää
// kapasiteettiehdotuksen rikkomatta vanhaa käytöstä.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  driftSignals, backlogGrowthSignal, capacityBiasSignal, ownTimeErosionSignal, freeTimeErosionSignal,
  vacationIntrusionSignal, planChurnSignal, explainDriftSignal, compareDriftSignals,
  DRIFT_SIGNAL, DRIFT_SIGNALS, DRIFT_SEVERITY, DRIFT_ADJUSTMENT
} from '../src/domain/driftSignals.js';
import { DRIFT_RULES, ALIGNMENT_POLICY, POLICY_VERSION } from '../src/domain/alignmentPolicy.js';
import { SIGNAL, analyzeWeek } from '../src/domain/alignment.js';
import { proposeAdjustments, ADJUSTMENT } from '../src/domain/alignmentReview.js';
import {
  resetState, setTasks, setProtectedPeriods, setWeeklyPlans, setTimeEntries, setDomainLoadStatus
} from '../src/app/state.js';
import { currentDriftSignals, currentCapacityBias, resetDriftCacheForTests } from '../src/app/alignment.js';

const MONDAY = '2026-09-28';
const TODAY = '2026-09-30'; // keskiviikko
const NEXT_MONDAY = '2026-10-05';

/** Syyllistävät sanat ja ilmaukset, joita mikään teksti ei saa sisältää. */
const SHAMING = ['epäonnistu', 'laiminl', 'huono', 'et saanut', 'et ehtinyt', 'pitäisi', 'syyllist', 'laiska', 'liian vähän', 'häpe'];

function assertCalm(signal) {
  const texts = [signal.title, signal.reason, signal.why, signal.adjustment.label, signal.adjustment.detail];
  for (const text of texts) {
    assert.equal(typeof text, 'string');
    assert.ok(text.length > 0, `tyhjä teksti: ${signal.kind}`);
    const lower = text.toLocaleLowerCase('fi');
    for (const word of SHAMING) assert.equal(lower.includes(word), false, `${signal.kind}: "${word}" tekstissä: ${text}`);
  }
}

function assertAdjustment(signal) {
  assert.ok(signal.adjustment, 'säätö puuttuu');
  assert.ok(Object.values(DRIFT_ADJUSTMENT).includes(signal.adjustment.type), signal.adjustment.type);
  assert.ok(signal.adjustment.label.length > 0);
  assert.ok(signal.adjustment.payload && typeof signal.adjustment.payload === 'object');
}

function openTasks(count, over = {}) {
  return Array.from({ length: count }, (_, index) => ({
    id: `o${index}`, title: `Asia ${index}`, completed: false, createdAt: '2026-08-01T09:00:00Z', ...over
  }));
}

function createdInWindow(count, prefix = 'n') {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}${index}`, title: `Uusi ${index}`, completed: false, createdAt: `${TODAY}T08:00:00Z`
  }));
}

// =====================================================================
// BACKLOG_GROWTH
// =====================================================================

test('BACKLOG_GROWTH: uusia 6, ratkenneita 0, avoimia 15 -> tiedoksi, luvut mukana', () => {
  const tasks = [...openTasks(9), ...createdInWindow(6)];
  const signal = backlogGrowthSignal({ tasks, todayIso: TODAY });
  assert.equal(signal.kind, DRIFT_SIGNAL.BACKLOG_GROWTH);
  assert.equal(signal.severity, DRIFT_SEVERITY.INFO);
  assert.equal(signal.metrics.created, 6);
  assert.equal(signal.metrics.resolved, 0);
  assert.equal(signal.metrics.openCount, 15);
  assertAdjustment(signal);
  assertCalm(signal);
});

test('BACKLOG_GROWTH: kasvu vähintään 10 -> huomio', () => {
  const signal = backlogGrowthSignal({ tasks: [...openTasks(5), ...createdInWindow(10)], todayIso: TODAY });
  assert.equal(signal.severity, DRIFT_SEVERITY.ATTENTION);
});

test('BACKLOG_GROWTH: kynnykset — kasvu tasan 5 riittää, 4 ei; avoimia 14 ei riitä', () => {
  assert.ok(backlogGrowthSignal({ tasks: [...openTasks(10), ...createdInWindow(5)], todayIso: TODAY }));
  assert.equal(backlogGrowthSignal({ tasks: [...openTasks(11), ...createdInWindow(4)], todayIso: TODAY }), null);
  assert.equal(backlogGrowthSignal({ tasks: [...openTasks(8), ...createdInWindow(6)], todayIso: TODAY }), null, 'avoimia 14');
});

test('BACKLOG_GROWTH: valmis (updatedAt) ja arkistoitu (archivedAt) jaksolla ovat ratkenneita', () => {
  const resolved = [
    { id: 'r1', title: 'Valmis', completed: true, createdAt: '2026-08-01T09:00:00Z', updatedAt: `${TODAY}T10:00:00Z` },
    { id: 'r2', title: 'Arkistoitu', completed: false, archivedAt: `${TODAY}T11:00:00Z`, createdAt: '2026-08-01T09:00:00Z' }
  ];
  const signal = backlogGrowthSignal({ tasks: [...openTasks(10), ...createdInWindow(6), ...resolved], todayIso: TODAY });
  assert.equal(signal, null, 'kasvu 6 - 2 = 4 jää alle kynnyksen');
  // Jakson ulkopuolella ratkennut ei vähennä.
  const old = resolved.map(task => ({ ...task, updatedAt: '2026-09-01T10:00:00Z', archivedAt: task.archivedAt ? '2026-09-01T10:00:00Z' : null }));
  assert.ok(backlogGrowthSignal({ tasks: [...openTasks(10), ...createdInWindow(6), ...old], todayIso: TODAY }));
});

test('BACKLOG_GROWTH: läpikäytävät ovat vanhimmat joustavat, ilman määräaikaa ja odotusta, enintään 5', () => {
  const tasks = [
    ...openTasks(12).map((task, index) => ({ ...task, createdAt: `2026-0${index < 6 ? 7 : 8}-1${index % 10}T09:00:00Z` })),
    { id: 'dl', title: 'Määräaika', completed: false, deadline: '2026-10-10', createdAt: '2026-01-01T09:00:00Z' },
    { id: 'wt', title: 'Odottaa', completed: false, horizon: 'WAITING', createdAt: '2026-01-01T09:00:00Z' },
    { id: 'fx', title: 'Kiinteä', completed: false, date: TODAY, time: '10:00', createdAt: '2026-01-01T09:00:00Z' },
    ...createdInWindow(6)
  ];
  const signal = backlogGrowthSignal({ tasks, todayIso: TODAY });
  const ids = signal.adjustment.payload.taskIds;
  assert.equal(ids.length, DRIFT_RULES.BACKLOG_REVIEW_CANDIDATES);
  for (const excluded of ['dl', 'wt', 'fx']) assert.equal(ids.includes(excluded), false, excluded);
  assert.equal(ids[0], 'o0', 'vanhin ensin');
});

test('BACKLOG_GROWTH: paikallinen päivä tulee dateOf-funktiosta', () => {
  const tasks = [...openTasks(10), ...createdInWindow(5).map(task => ({ ...task, createdAt: 'LOCAL' }))];
  assert.equal(backlogGrowthSignal({ tasks, todayIso: TODAY }), null, 'tuntematon aikaleima ei ole jaksolla');
  assert.ok(backlogGrowthSignal({ tasks, todayIso: TODAY, dateOf: value => (value === 'LOCAL' ? TODAY : null) }));
});

// =====================================================================
// CAPACITY_BIAS
// =====================================================================

function closedWeeks(weeks, planned) {
  return weeks.map(week => ({ weekStart: week, closedAt: `${week}T20:00:00Z`, plannedMinutes: planned }));
}

function entries(weeks, minutes) {
  return weeks.map(week => ({ entryDate: week, minutes }));
}

const PAST = ['2026-09-07', '2026-09-14', '2026-09-21'];

test('CAPACITY_BIAS: 3 suljettua viikkoa, suunnitelma 25 h vs. toteuma 15 h -> kysymys pienemmästä kapasiteetista', () => {
  const signal = capacityBiasSignal({
    weeklyPlans: closedWeeks(PAST, 1500), timeEntries: entries(PAST, 900), todayIso: TODAY, weekStart: MONDAY
  });
  assert.equal(signal.kind, DRIFT_SIGNAL.CAPACITY_BIAS);
  assert.equal(signal.metrics.weeks, 3);
  assert.equal(signal.metrics.percentOver, 65);
  assert.equal(signal.metrics.suggestedMinutes, 900);
  assert.equal(signal.adjustment.type, DRIFT_ADJUSTMENT.SET_CAPACITY);
  assert.deepEqual({ ...signal.adjustment.payload }, { weekStart: NEXT_MONDAY, availableMinutes: 900 });
  assert.match(signal.adjustment.label, /\?$/, 'ehdotus on kysymys');
  assert.match(signal.reason, /noin 65 % suurempia kuin toteuma/);
  assert.match(signal.reason, /Ensi viikon kapasiteettia voi pienentää/);
  assertCalm(signal);
});

test('CAPACITY_BIAS: kaksi viikkoa ei riitä', () => {
  const weeks = PAST.slice(1);
  assert.equal(capacityBiasSignal({ weeklyPlans: closedWeeks(weeks, 1500), timeEntries: entries(weeks, 900), todayIso: TODAY }), null);
});

test('CAPACITY_BIAS: suhteen kynnys — tasan 1,25 riittää, 1,2 ei', () => {
  assert.ok(capacityBiasSignal({ weeklyPlans: closedWeeks(PAST, 1250), timeEntries: entries(PAST, 1000), todayIso: TODAY }));
  assert.equal(capacityBiasSignal({ weeklyPlans: closedWeeks(PAST, 1200), timeEntries: entries(PAST, 1000), todayIso: TODAY }), null);
});

test('CAPACITY_BIAS: viikko ilman toteumaa ei ole vertailukelpoinen (tuntematon ei ole nolla)', () => {
  const signal = capacityBiasSignal({
    weeklyPlans: closedWeeks(PAST, 1500), timeEntries: entries(PAST.slice(1), 900), todayIso: TODAY
  });
  assert.equal(signal, null);
});

test('CAPACITY_BIAS: sulkematon suunnitelma ja kesken oleva viikko eivät ole mukana', () => {
  const plans = [
    ...closedWeeks(PAST.slice(1), 1500),
    { weekStart: PAST[0], closedAt: null, plannedMinutes: 1500 },
    { weekStart: MONDAY, closedAt: `${MONDAY}T08:00:00Z`, plannedMinutes: 3000 }
  ];
  const all = [...PAST, MONDAY];
  assert.equal(capacityBiasSignal({ weeklyPlans: plans, timeEntries: entries(all, 900), todayIso: TODAY }), null);
});

test('CAPACITY_BIAS: valmiiden arvioitujen tehtävien kesto on toteumaa, kun se on kirjattua suurempi', () => {
  const tasks = PAST.map((week, index) => ({ id: `d${index}`, title: 'Tehty', completed: true, date: week, durationMinutes: 1400 }));
  // Kirjattu 900, valmiit 1400: suhde 1500/1400 < 1,25 -> ei harhaa.
  assert.equal(capacityBiasSignal({ weeklyPlans: closedWeeks(PAST, 1500), timeEntries: entries(PAST, 900), tasks, todayIso: TODAY }), null);
});

test('CAPACITY_BIAS: pienet luvut eivät riitä (ero alle 2 h viikossa)', () => {
  assert.equal(capacityBiasSignal({ weeklyPlans: closedWeeks(PAST, 250), timeEntries: entries(PAST, 150), todayIso: TODAY }), null);
});

test('CAPACITY_BIAS: huomio, kun suunnitelma vähintään 1,5-kertainen; muuten tiedoksi', () => {
  const strong = capacityBiasSignal({ weeklyPlans: closedWeeks(PAST, 1500), timeEntries: entries(PAST, 1000), todayIso: TODAY });
  const mild = capacityBiasSignal({ weeklyPlans: closedWeeks(PAST, 1300), timeEntries: entries(PAST, 1000), todayIso: TODAY });
  assert.equal(strong.severity, DRIFT_SEVERITY.ATTENTION);
  assert.equal(mild.severity, DRIFT_SEVERITY.INFO);
});

// =====================================================================
// OWN_TIME_EROSION
// =====================================================================

const OWN_TUESDAY_EVENING = Object.freeze({
  id: 'own', kind: 'OWN_TIME', recurrence: 'weekly', weekdays: [2], startTime: '17:00', endTime: '20:00',
  active: true, strength: 'firm'
});

test('OWN_TIME_EROSION: työtehtävä omassa ajassa (60/180 min) -> huomio, siirrettävä tehtävä mukana', () => {
  const tasks = [{ id: 'w', title: 'Raportti', date: '2026-10-01', time: '18:00', durationMinutes: 60, category: 'tyo' }];
  const periods = [{ ...OWN_TUESDAY_EVENING, weekdays: [4] }];
  const signal = ownTimeErosionSignal({ weekStart: MONDAY, todayIso: TODAY, tasks, periods });
  assert.equal(signal.kind, DRIFT_SIGNAL.OWN_TIME_EROSION);
  assert.equal(signal.metrics.intrudedMinutes, 60);
  assert.equal(signal.metrics.ownMinutes, 180);
  assert.equal(signal.severity, DRIFT_SEVERITY.ATTENTION);
  assert.equal(signal.adjustment.type, DRIFT_ADJUSTMENT.MOVE_ITEMS);
  assert.deepEqual([...signal.adjustment.payload.taskIds], ['w']);
  assertCalm(signal);
});

test('OWN_TIME_EROSION: hyvinvointi tai ilo omassa ajassa ei ole tunkeutumista', () => {
  const tasks = [{ id: 'g', title: 'Sali', date: '2026-09-29', time: '17:00', durationMinutes: 120, category: 'hyvinvointi' }];
  assert.equal(ownTimeErosionSignal({ weekStart: MONDAY, todayIso: TODAY, tasks, periods: [OWN_TUESDAY_EVENING] }), null);
});

test('OWN_TIME_EROSION: kynnys — 29 min ei, 30 min tiedoksi (alle 25 %)', () => {
  const task = minutes => [{ id: 't', title: 'Työ', date: '2026-09-29', time: '19:00', durationMinutes: minutes, category: 'tyo' }];
  assert.equal(ownTimeErosionSignal({ weekStart: MONDAY, todayIso: TODAY, tasks: task(29), periods: [OWN_TUESDAY_EVENING] }), null);
  const signal = ownTimeErosionSignal({ weekStart: MONDAY, todayIso: TODAY, tasks: task(30), periods: [OWN_TUESDAY_EVENING] });
  assert.equal(signal.severity, DRIFT_SEVERITY.INFO);
});

test('OWN_TIME_EROSION: pääosin vapaa (soft) sallii oman valinnan; vain automaatin sijoittama lasketaan', () => {
  const periods = [{ ...OWN_TUESDAY_EVENING, strength: 'soft' }];
  const manual = [{ id: 'm', title: 'Työ', date: '2026-09-29', time: '17:00', durationMinutes: 60, category: 'tyo' }];
  const auto = [{ ...manual[0], id: 'a', schedulingState: 'auto' }];
  assert.equal(ownTimeErosionSignal({ weekStart: MONDAY, todayIso: '2026-09-28', tasks: manual, periods }), null);
  assert.ok(ownTimeErosionSignal({ weekStart: MONDAY, todayIso: '2026-09-28', tasks: auto, periods }));
});

test('OWN_TIME_EROSION: meno omassa ajassa lasketaan, mutta sitä ei ehdoteta siirrettäväksi', () => {
  const events = [{ id: 'event:k:2026-09-29', title: 'Kokous', date: '2026-09-29', startMinute: 17 * 60, endMinute: 18 * 60, category: 'tyo' }];
  const signal = ownTimeErosionSignal({ weekStart: MONDAY, todayIso: TODAY, events, periods: [OWN_TUESDAY_EVENING] });
  assert.equal(signal.metrics.intruderCount, 1);
  assert.equal(signal.adjustment.type, DRIFT_ADJUSTMENT.KEEP_BLOCK);
});

// =====================================================================
// FREE_TIME_EROSION
// =====================================================================

const CUTOFF_20 = Object.freeze({
  id: 'cut', kind: 'FREE_TIME', recurrence: 'weekly', weekdays: [1, 2, 3, 4, 5, 6, 7], startTime: '20:00',
  endTime: '23:00', active: true, strength: 'firm'
});

test('FREE_TIME_EROSION: velvoite klo 20 jälkeen (vapaa-ajan lohkossa) -> siirrä aiemmaksi', () => {
  const tasks = [{ id: 'late', title: 'Laskut', date: '2026-10-02', time: '20:30', durationMinutes: 60, category: 'talous' }];
  const signal = freeTimeErosionSignal({ weekStart: MONDAY, todayIso: TODAY, tasks, periods: [CUTOFF_20] });
  assert.equal(signal.kind, DRIFT_SIGNAL.FREE_TIME_EROSION);
  assert.equal(signal.rule, 'drift.free_time_obligations_in_block');
  assert.equal(signal.metrics.obligationMinutes, 60);
  assert.equal(signal.adjustment.type, DRIFT_ADJUSTMENT.MOVE_ITEMS);
  assertCalm(signal);
});

test('FREE_TIME_EROSION: viikon vähimmäisvapaa-aika ei toteudu, kun mahtumaton työ vie varauksen', () => {
  const periods = [{ id: 'min', kind: 'FREE_TIME', recurrence: 'weekly_target', targetMinutes: 600, active: true }];
  const signal = freeTimeErosionSignal({ weekStart: MONDAY, todayIso: TODAY, periods, overflowMinutes: 400 });
  assert.equal(signal.rule, 'drift.free_time_target_not_met');
  assert.equal(signal.metrics.achievedMinutes, 200);
  assert.equal(signal.metrics.shortfallMinutes, 400);
  assert.equal(signal.severity, DRIFT_SEVERITY.ATTENTION);
  assert.equal(signal.adjustment.type, DRIFT_ADJUSTMENT.PROTECT_EVENING);
  assert.match(signal.adjustment.label, /\?$/);
});

test('FREE_TIME_EROSION: tavoite toteutuu ilman ylivuotoa; alle 30 min vaje ei ole havainto', () => {
  const periods = [{ id: 'min', kind: 'FREE_TIME', recurrence: 'weekly_target', targetMinutes: 600, active: true }];
  assert.equal(freeTimeErosionSignal({ weekStart: MONDAY, todayIso: TODAY, periods }), null);
  assert.equal(freeTimeErosionSignal({ weekStart: MONDAY, todayIso: TODAY, periods, overflowMinutes: 29 }), null);
  assert.ok(freeTimeErosionSignal({ weekStart: MONDAY, todayIso: TODAY, periods, overflowMinutes: 30 }));
});

test('FREE_TIME_EROSION: ei vapaa-ajan sääntöjä -> ei havaintoa; vapaa-aikaan sopiva luonne ei ole velvoite', () => {
  assert.equal(freeTimeErosionSignal({ weekStart: MONDAY, todayIso: TODAY, tasks: [], periods: [] }), null);
  const tasks = [{ id: 'hobby', title: 'Kitara', date: '2026-10-02', time: '20:30', durationMinutes: 90, category: 'harrastus' }];
  assert.equal(freeTimeErosionSignal({ weekStart: MONDAY, todayIso: TODAY, tasks, periods: [CUTOFF_20] }), null);
});

// =====================================================================
// VACATION_INTRUSION
// =====================================================================

const VACATION = Object.freeze({
  id: 'vac', kind: 'VACATION', recurrence: 'once', startDate: '2026-10-05', endDate: '2026-10-09', active: true
});

test('VACATION_INTRUSION: joustava tehtävä lomalla -> siirrä loman jälkeen (päivä mukana)', () => {
  const tasks = [{ id: 'clean', title: 'Siivoa varasto', date: '2026-10-06', category: 'koti' }];
  const signal = vacationIntrusionSignal({ weekStart: MONDAY, todayIso: TODAY, tasks, periods: [VACATION] });
  assert.equal(signal.kind, DRIFT_SIGNAL.VACATION_INTRUSION);
  assert.equal(signal.severity, DRIFT_SEVERITY.INFO);
  assert.equal(signal.adjustment.type, DRIFT_ADJUSTMENT.MOVE_AFTER_VACATION);
  assert.equal(signal.adjustment.payload.afterDate, '2026-10-10');
  assert.match(signal.reason, /Kiinteät menot pysyvät/);
  assertCalm(signal);
});

test('VACATION_INTRUSION: kiinteä meno (käyttäjän kellonaika) lomalla EI ole tunkeutumista', () => {
  const tasks = [{ id: 'dentist', title: 'Hammaslääkäri', date: '2026-10-06', time: '10:00', category: 'koti' }];
  assert.equal(vacationIntrusionSignal({ weekStart: MONDAY, todayIso: TODAY, tasks, periods: [VACATION] }), null);
  // Automaatin sijoittama ajastettu tehtävä on joustava.
  const auto = [{ ...tasks[0], id: 'auto', schedulingState: 'auto' }];
  assert.ok(vacationIntrusionSignal({ weekStart: MONDAY, todayIso: TODAY, tasks: auto, periods: [VACATION] }));
});

test('VACATION_INTRUSION: välttämätön velvoite (määräaika) ei ole tunkeutumista; ei lomaa -> ei havaintoa', () => {
  const tasks = [{ id: 'tax', title: 'Veroilmoitus', date: '2026-10-06', deadline: '2026-10-07' }];
  assert.equal(vacationIntrusionSignal({ weekStart: MONDAY, todayIso: TODAY, tasks, periods: [VACATION] }), null);
  assert.equal(vacationIntrusionSignal({
    weekStart: MONDAY, todayIso: TODAY, tasks: [{ id: 'x', title: 'X', date: '2026-10-06' }], periods: []
  }), null);
});

test('VACATION_INTRUSION: vähintään 3 -> huomio; mennyt lomapäivä ja NOT_YET eivät ole mukana', () => {
  const periods = [{ ...VACATION, startDate: '2026-09-28' }];
  const tasks = [
    { id: 'a', title: 'A', date: '2026-10-01' }, { id: 'b', title: 'B', date: '2026-10-02' },
    { id: 'c', title: 'C', date: '2026-10-03' },
    { id: 'past', title: 'Mennyt', date: '2026-09-29' },
    { id: 'ny', title: 'Ei vielä', date: '2026-10-02', horizon: 'NOT_YET' }
  ];
  const signal = vacationIntrusionSignal({ weekStart: MONDAY, todayIso: TODAY, tasks, periods });
  assert.equal(signal.metrics.itemCount, 3);
  assert.equal(signal.severity, DRIFT_SEVERITY.ATTENTION);
});

// =====================================================================
// PLAN_CHURN
// =====================================================================

test('PLAN_CHURN: 3 siirtoa -> tiedoksi, 5 -> huomio; säätö: päätä kerran', () => {
  const three = planChurnSignal({ weekStart: MONDAY, tasks: [{ id: 'p', title: 'Pesukone', rescheduleCount: 3 }] });
  assert.equal(three.kind, DRIFT_SIGNAL.PLAN_CHURN);
  assert.equal(three.severity, DRIFT_SEVERITY.INFO);
  assert.equal(three.adjustment.type, DRIFT_ADJUSTMENT.DECIDE_ONCE);
  assertCalm(three);
  const five = planChurnSignal({ weekStart: MONDAY, tasks: [{ id: 'p', title: 'Pesukone', rescheduleCount: 5 }] });
  assert.equal(five.severity, DRIFT_SEVERITY.ATTENTION);
});

test('PLAN_CHURN: 2 siirtoa ei riitä; valmis ja arkistoitu eivät ole mukana', () => {
  assert.equal(planChurnSignal({ weekStart: MONDAY, tasks: [{ id: 'p', title: 'P', rescheduleCount: 2 }] }), null);
  assert.equal(planChurnSignal({ weekStart: MONDAY, tasks: [
    { id: 'd', title: 'Valmis', rescheduleCount: 9, completed: true },
    { id: 'a', title: 'Arkisto', rescheduleCount: 9, archivedAt: '2026-09-01T10:00:00Z' }
  ] }), null);
});

test('PLAN_CHURN: tällä viikolla 5 siirrettyä -> viikon siirrot; 4 ei riitä', () => {
  const moved = count => Array.from({ length: count }, (_, index) => ({
    id: `m${index}`, title: `M${index}`, rescheduleCount: 1, updatedAt: `${TODAY}T09:00:00Z`
  }));
  const signal = planChurnSignal({ weekStart: MONDAY, tasks: moved(5) });
  assert.equal(signal.rule, 'drift.many_moves_this_week');
  assert.equal(signal.metrics.movedThisWeek, 5);
  assert.equal(planChurnSignal({ weekStart: MONDAY, tasks: moved(4) }), null);
});

test('PLAN_CHURN: päätettävät järjestyksessä eniten siirretty ensin, enintään 5', () => {
  const tasks = Array.from({ length: 7 }, (_, index) => ({ id: `c${index}`, title: `C${index}`, rescheduleCount: 3 + index }));
  const signal = planChurnSignal({ weekStart: MONDAY, tasks });
  assert.equal(signal.adjustment.payload.taskIds.length, DRIFT_RULES.PLAN_CHURN_MAX_ITEMS);
  assert.equal(signal.adjustment.payload.taskIds[0], 'c6');
  assert.equal(signal.metrics.maxReschedules, 9);
});

// =====================================================================
// KOKONAISUUS
// =====================================================================

function fullScenario() {
  return {
    weekStart: MONDAY,
    todayIso: TODAY,
    tasks: [
      ...openTasks(12), ...createdInWindow(6),
      { id: 'own', title: 'Raportti', date: '2026-10-01', time: '18:00', durationMinutes: 90, category: 'tyo' },
      { id: 'late', title: 'Laskut', date: '2026-10-02', time: '21:00', durationMinutes: 60, category: 'talous' },
      { id: 'vac', title: 'Siivoa', date: '2026-10-06', category: 'koti' },
      { id: 'churn', title: 'Pesukone', rescheduleCount: 6 }
    ],
    periods: [{ ...OWN_TUESDAY_EVENING, weekdays: [4] }, CUTOFF_20, VACATION],
    weeklyPlans: closedWeeks(PAST, 1500),
    timeEntries: entries(PAST, 900)
  };
}

test('kaikki kuusi havaintoa syntyvät; jokaisella on säätö eikä yhdessäkään syyllistävää sanaa', () => {
  const signals = driftSignals(fullScenario());
  assert.deepEqual(new Set(signals.map(signal => signal.kind)), new Set(DRIFT_SIGNALS));
  for (const signal of signals) {
    assertAdjustment(signal);
    assertCalm(signal);
    assert.ok(Object.values(DRIFT_SEVERITY).includes(signal.severity));
    assert.ok(signal.metrics && typeof signal.metrics === 'object');
  }
});

test('järjestys: huomio ennen tiedoksi; tulos on jäädytetty ja deterministinen', () => {
  const input = fullScenario();
  const first = driftSignals(input);
  const second = driftSignals({ ...input, tasks: [...input.tasks].reverse() });
  assert.deepEqual(first.map(signal => signal.kind), second.map(signal => signal.kind));
  for (let index = 1; index < first.length; index++) assert.ok(compareDriftSignals(first[index - 1], first[index]) <= 0);
  assert.ok(Object.isFrozen(first) && Object.isFrozen(first[0]) && Object.isFrozen(first[0].adjustment));
});

test('tyhjä tai kelvoton syöte ei kaada eikä keksi havaintoja', () => {
  assert.deepEqual([...driftSignals({})], []);
  assert.deepEqual([...driftSignals(null)], []);
  assert.deepEqual([...driftSignals({ weekStart: 'huono', todayIso: 'x', tasks: 'ei lista' })], []);
});

test('explainDriftSignal: sama muoto kuin explainSignal (otsikko, teksti, miksi)', () => {
  const [signal] = driftSignals(fullScenario());
  const text = explainDriftSignal(signal);
  assert.equal(text.title, signal.title);
  assert.equal(text.text, signal.reason);
  assert.equal(text.why, signal.why);
  assert.deepEqual(explainDriftSignal({ kind: 'overload' }), { title: 'Havainto', text: '', why: '' });
});

test('vanhat viisi havaintoa säilyvät: SIGNAL ennallaan, analyzeWeek ei tuota ajautumisen lajeja', () => {
  assert.deepEqual(Object.values(SIGNAL).sort(),
    ['energy_overload', 'misalignment', 'neglect', 'overload', 'target_tension']);
  const analysis = analyzeWeek({ ...fullScenario(), capacity: { weekStart: MONDAY, availableMinutes: 60 } });
  assert.ok(analysis.signals.some(signal => signal.kind === SIGNAL.OVERLOAD));
  assert.equal(analysis.signals.some(signal => DRIFT_SIGNALS.includes(signal.kind)), false);
});

test('politiikka: DRIFT_RULES jäädytetty ja osa ALIGNMENT_POLICYa; sääntöversio ennallaan (3)', () => {
  assert.ok(Object.isFrozen(DRIFT_RULES));
  assert.equal(ALIGNMENT_POLICY.drift, DRIFT_RULES);
  assert.equal(POLICY_VERSION, 3);
});

// =====================================================================
// EHDOTUKSET: CAPACITY_BIAS -> SET_CAPACITY
// =====================================================================

function reviewAnalysis(available = 1800) {
  return analyzeWeek({ weekStart: MONDAY, todayIso: TODAY, capacity: { weekStart: MONDAY, availableMinutes: available } });
}

test('ehdotukset: CAPACITY_BIAS syöttää ensi viikon kapasiteettiehdotuksen (kysymys, perusteluna harha)', () => {
  const bias = capacityBiasSignal({ weeklyPlans: closedWeeks(PAST, 1500), timeEntries: entries(PAST, 900), todayIso: TODAY, weekStart: MONDAY });
  const proposal = proposeAdjustments(reviewAnalysis(), { capacityBias: bias })
    .find(entry => entry.type === ADJUSTMENT.SET_CAPACITY);
  assert.equal(proposal.payload.availableMinutes, 900);
  assert.equal(proposal.payload.weekStart, NEXT_MONDAY);
  assert.deepEqual(proposal.reason, { kind: 'capacity_bias' });
  assert.match(proposal.label, /\?$/);
});

test('ehdotukset: ilman harhaa tai kun harha ei pienennä, kapasiteettiehdotus on ennallaan', () => {
  const plain = proposeAdjustments(reviewAnalysis()).find(entry => entry.type === ADJUSTMENT.SET_CAPACITY);
  assert.equal(plain.payload.availableMinutes, 1800);
  assert.equal(plain.reason, null);
  const bias = capacityBiasSignal({ weeklyPlans: closedWeeks(PAST, 1500), timeEntries: entries(PAST, 900), todayIso: TODAY });
  const bigger = proposeAdjustments(reviewAnalysis(600), { capacityBias: bias }).find(entry => entry.type === ADJUSTMENT.SET_CAPACITY);
  assert.equal(bigger.payload.availableMinutes, 600, 'harha ei nosta kapasiteettia');
  assert.equal(bigger.reason, null);
});

// =====================================================================
// SOVELLUSKERROS
// =====================================================================

beforeEach(() => {
  resetState();
  resetDriftCacheForTests();
});

test('sovellus: currentDriftSignals rakentaa syötteet tilasta (suojatut lohkot jarrun polusta)', () => {
  setProtectedPeriods([{ ...OWN_TUESDAY_EVENING, weekdays: [4] }, VACATION]);
  setTasks([
    { id: 'own', title: 'Raportti', date: '2026-10-01', time: '18:00', endTime: '19:30', category: 'tyo' },
    { id: 'vac', title: 'Siivoa', date: '2026-10-06', category: 'koti' }
  ]);
  const clock = { todayIso: TODAY, nowMinutes: 9 * 60 };
  const kinds = currentDriftSignals(MONDAY, clock).map(signal => signal.kind);
  assert.ok(kinds.includes(DRIFT_SIGNAL.OWN_TIME_EROSION), kinds.join());
  assert.ok(kinds.includes(DRIFT_SIGNAL.VACATION_INTRUSION), kinds.join());
  // Sama tila -> välimuisti palauttaa saman olion.
  assert.equal(currentDriftSignals(MONDAY, clock), currentDriftSignals(MONDAY, clock));
});

test('sovellus: epäonnistunut lataus -> ei ajautumista vajaista luvuista', () => {
  setTasks([{ id: 'churn', title: 'Pesukone', rescheduleCount: 6 }]);
  const clock = { todayIso: TODAY, nowMinutes: 9 * 60 };
  assert.equal(currentDriftSignals(MONDAY, clock).length, 1);
  resetDriftCacheForTests();
  setDomainLoadStatus('tasks', false, new Error('verkko'));
  assert.equal(currentDriftSignals(MONDAY, clock).length, 0);
});

test('sovellus: currentCapacityBias lukee suljetut viikkosuunnitelmat ja kirjaukset tilasta', () => {
  setWeeklyPlans(closedWeeks(PAST, 1500).map((plan, index) => ({ ...plan, id: `wp${index}` })));
  setTimeEntries(entries(PAST, 900).map((entry, index) => ({ ...entry, id: `te${index}`, source: 'manual' })));
  const bias = currentCapacityBias(MONDAY, { todayIso: TODAY, nowMinutes: 0 });
  assert.equal(bias.kind, DRIFT_SIGNAL.CAPACITY_BIAS);
  assert.equal(bias.adjustment.payload.availableMinutes, 900);
});
