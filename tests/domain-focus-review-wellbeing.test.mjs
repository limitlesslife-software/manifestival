// Fokuksen, katsausten ja hyvinvoinnin testit.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { todayFocus, scoreTask, describeFocus, FOCUS_SCORE, DEFAULT_FOCUS_LIMIT } from '../src/domain/focus.js';
import { buildEveningReview, buildWeeklyReview, summarizeReview, MAX_SUGGESTIONS } from '../src/domain/review.js';
import {
  LOAD_STATE, METRIC, SCALE_MIN, SCALE_MAX,
  normalizeWellbeingEntry, validateWellbeingEntry, entryForDate, averages,
  assessLoadState, planningLoadSuggestion, loadStateLabel, metricLabel
} from '../src/domain/wellbeing.js';
import { normalizeTask } from '../src/domain/task.js';
import { normalizeGoal, GOAL_STATUS } from '../src/domain/goal.js';

const TODAY = '2026-09-01'; // tiistai
const MONDAY = '2026-08-31';

const task = (over = {}) => normalizeTask({
  id: 't', title: 'Tehtävä', date: TODAY, priority: 'normaali', ...over
});

// ================================================================ FOKUS

test('myöhässä oleva nousee korkeimmalle', () => {
  const { score, reasons } = scoreTask(task({ deadline: '2026-08-01' }), { dateIso: TODAY, todayIso: TODAY });
  assert.ok(score >= FOCUS_SCORE.OVERDUE);
  assert.ok(reasons.includes('Myöhässä'));
});

test('pisteytys kasautuu useasta signaalista', () => {
  const plain = scoreTask(task({ id: 'a' }), { dateIso: TODAY, todayIso: TODAY });
  const loaded = scoreTask(
    task({ id: 'b', priority: 'korkea', deadline: TODAY, time: '10:00', goalId: 'g1' }),
    { dateIso: TODAY, todayIso: TODAY }
  );
  assert.ok(loaded.score > plain.score);
  assert.ok(loaded.reasons.length >= 3, 'jokaisella signaalilla on perustelu');
});

test('matala prioriteetti laskee pisteitä', () => {
  const normal = scoreTask(task({ id: 'a', time: '10:00' }), { dateIso: TODAY, todayIso: TODAY });
  const low = scoreTask(task({ id: 'b', time: '10:00', priority: 'matala' }), { dateIso: TODAY, todayIso: TODAY });
  assert.ok(low.score < normal.score);
});

test('valmis tehtävä saa nolla pistettä', () => {
  const { score, reasons } = scoreTask(task({ completed: true, deadline: '2026-01-01' }), { dateIso: TODAY, todayIso: TODAY });
  assert.equal(score, 0);
  assert.deepEqual(reasons, []);
});

test('todayFocus nostaa enintään rajatun määrän', () => {
  const tasks = Array.from({ length: 10 }, (_, i) =>
    task({ id: 't' + i, title: 'T' + i, priority: 'korkea', time: '1' + (i % 10) + ':00' }));
  assert.equal(todayFocus({ tasks, dateIso: TODAY, todayIso: TODAY }).length, DEFAULT_FOCUS_LIMIT);
  assert.equal(todayFocus({ tasks, dateIso: TODAY, todayIso: TODAY, limit: 5 }).length, 5);
});

test('todayFocus ei nosta valmiita', () => {
  const tasks = [
    task({ id: 'tehty', priority: 'korkea', deadline: '2026-01-01', completed: true }),
    task({ id: 'kesken', priority: 'korkea', time: '10:00' })
  ];
  const focus = todayFocus({ tasks, dateIso: TODAY, todayIso: TODAY });
  assert.deepEqual(focus.map(e => e.task.id), ['kesken']);
});

test('todayFocus huomioi myös toisen päivän myöhässä olevat', () => {
  const tasks = [task({ id: 'vanha', date: '2026-07-01', deadline: '2026-07-01' })];
  const focus = todayFocus({ tasks, dateIso: TODAY, todayIso: TODAY });
  assert.equal(focus.length, 1, 'rästin pitää nousta vaikka se on toiselle päivälle merkitty');
});

test('todayFocus ei nosta kaukaisen tulevaisuuden tehtäviä', () => {
  const tasks = [task({ id: 'kaukana', date: '2026-12-01', priority: 'korkea' })];
  assert.deepEqual(todayFocus({ tasks, dateIso: TODAY, todayIso: TODAY }), []);
});

test('TAKUU: fokus on deterministinen', () => {
  const tasks = [
    task({ id: 'a', title: 'Alfa', priority: 'korkea' }),
    task({ id: 'b', title: 'Beeta', priority: 'korkea' }),
    task({ id: 'c', title: 'Gamma', deadline: TODAY })
  ];
  const first = todayFocus({ tasks, dateIso: TODAY, todayIso: TODAY }).map(e => e.task.id);
  const second = todayFocus({ tasks: [...tasks].reverse(), dateIso: TODAY, todayIso: TODAY }).map(e => e.task.id);
  assert.deepEqual(first, second);
});

test('jokaisella nostetulla on perustelu', () => {
  const tasks = [
    task({ id: 'a', priority: 'korkea' }),
    task({ id: 'b', deadline: TODAY }),
    task({ id: 'c', time: '09:00' })
  ];
  for (const entry of todayFocus({ tasks, dateIso: TODAY, todayIso: TODAY })) {
    assert.ok(entry.reasons.length > 0, 'nosto ilman perustelua on mielivaltainen');
  }
});

test('describeFocus kertoo myös tyhjästä tuloksesta', () => {
  assert.equal(describeFocus([]).count, 0);
  assert.match(describeFocus([]).text, /ei erityisen kiireellistä/i);
  assert.match(describeFocus([{}, {}]).text, /2 asiaa/);
});

// ========================================================= ILLAN KATSAUS

test('illan katsaus erottelee valmiit ja kesken jääneet', () => {
  const tasks = [
    task({ id: 'a', completed: true }),
    task({ id: 'b', completed: true }),
    task({ id: 'c' })
  ];
  const review = buildEveningReview({ tasks, dateIso: TODAY, todayIso: TODAY });
  assert.equal(review.completed.length, 2);
  assert.equal(review.remaining.length, 1);
  assert.equal(review.stats.completionRate, 67);
});

test('siirtoehdotuksiin ei oteta määräaikaan sidottuja', () => {
  const tasks = [
    task({ id: 'siirrettava' }),
    task({ id: 'eraantyy', deadline: TODAY }),
    task({ id: 'myohassa', deadline: '2026-08-01' })
  ];
  const review = buildEveningReview({ tasks, dateIso: TODAY, todayIso: TODAY });
  assert.deepEqual(review.moveCandidates.map(t => t.id), ['siirrettava']);
  assert.deepEqual(review.stuck.map(t => t.id).sort(), ['eraantyy', 'myohassa']);
});

test('siirtoehdotusten määrä on rajattu', () => {
  const tasks = Array.from({ length: 12 }, (_, i) => task({ id: 't' + i, title: 'T' + i }));
  const review = buildEveningReview({ tasks, dateIso: TODAY, todayIso: TODAY });
  assert.ok(review.moveCandidates.length <= MAX_SUGGESTIONS);
});

test('illan katsaus nostaa huomisen tärkeimmät', () => {
  const tasks = [
    task({ id: 'tanaan' }),
    task({ id: 'huomenna', date: '2026-09-02', priority: 'korkea', time: '09:00' })
  ];
  const review = buildEveningReview({ tasks, dateIso: TODAY, todayIso: TODAY });
  assert.equal(review.tomorrowIso, '2026-09-02');
  assert.ok(review.tomorrowTop.some(e => e.task.id === 'huomenna'));
});

test('tyhjä päivä ei tuota jakolaskuvirhettä', () => {
  const review = buildEveningReview({ tasks: [], dateIso: TODAY, todayIso: TODAY });
  assert.equal(review.stats.planned, 0);
  assert.equal(review.stats.completionRate, null, 'nollalla ei jaeta');
});

test('rutiiniesiintymät lasketaan katsaukseen', () => {
  const review = buildEveningReview({
    tasks: [], dateIso: TODAY, todayIso: TODAY,
    routineOccurrences: [{ date: TODAY }, { date: TODAY }, { date: '2026-09-02' }]
  });
  assert.equal(review.stats.routines, 2);
});

// ======================================================= VIIKKOKATSAUS

test('viikkokatsaus kokoaa viikon tehtävät', () => {
  const tasks = [
    task({ id: 'a', date: MONDAY, completed: true }),
    task({ id: 'b', date: TODAY }),
    task({ id: 'c', date: '2026-09-06' }),
    task({ id: 'd', date: '2026-09-20' })
  ];
  const review = buildWeeklyReview({ tasks, weekStartIso: MONDAY, todayIso: TODAY });
  assert.equal(review.stats.planned, 3, 'seuraavan viikon tehtävä ei kuulu tähän');
  assert.equal(review.stats.completed, 1);
  assert.equal(review.weekStartIso, MONDAY);
  assert.equal(review.weekEndIso, '2026-09-06');
});

test('viikkokatsaus näyttää päiväkohtaisen jakauman', () => {
  const tasks = [
    task({ id: 'a', date: MONDAY }),
    task({ id: 'b', date: MONDAY }),
    task({ id: 'c', date: TODAY })
  ];
  const review = buildWeeklyReview({ tasks, weekStartIso: MONDAY, todayIso: TODAY });
  assert.equal(review.days.length, 7);
  assert.equal(review.days[0].total, 2);
  assert.equal(review.days[1].total, 1);
  assert.equal(review.stats.busiestDay, MONDAY);
});

test('viikkokatsaus laskee myöhässä olevat koko joukosta', () => {
  const tasks = [
    task({ id: 'vanha', date: '2026-07-01', deadline: '2026-07-01' }),
    task({ id: 'tama', date: TODAY })
  ];
  const review = buildWeeklyReview({ tasks, weekStartIso: MONDAY, todayIso: TODAY });
  assert.equal(review.stats.overdue, 1, 'vanha rästi pitää näkyä');
});

test('viikkokatsaus näyttää tavoitteiden edistymisen', () => {
  const goals = [
    normalizeGoal({ id: 'g1', title: 'Aktiivinen' }),
    normalizeGoal({ id: 'g2', title: 'Valmis', status: GOAL_STATUS.COMPLETED })
  ];
  const tasks = [
    task({ id: 'a', date: MONDAY, goalId: 'g1', completed: true }),
    task({ id: 'b', date: TODAY, goalId: 'g1' })
  ];
  const review = buildWeeklyReview({ tasks, goals, weekStartIso: MONDAY, todayIso: TODAY });
  assert.equal(review.goalProgress.length, 1, 'vain avoimet tavoitteet');
  assert.equal(review.goalProgress[0].progress.percent, 50);
  assert.equal(review.stats.activeGoals, 1);
});

test('myöhässä oleva tavoite nostetaan ensin', () => {
  const goals = [
    normalizeGoal({ id: 'g1', title: 'Normaali' }),
    normalizeGoal({ id: 'g2', title: 'Myöhässä', targetDate: '2026-08-01' })
  ];
  const review = buildWeeklyReview({ tasks: [], goals, weekStartIso: MONDAY, todayIso: TODAY });
  assert.equal(review.goalProgress[0].goal.id, 'g2');
});

test('viikkokatsaus ehdottaa seuraavan viikon tärkeimmät', () => {
  const tasks = [
    task({ id: 'ensiviikko', date: '2026-09-08', priority: 'korkea', time: '09:00' })
  ];
  const review = buildWeeklyReview({ tasks, weekStartIso: MONDAY, todayIso: TODAY });
  assert.equal(review.nextWeekStart, '2026-09-07');
  assert.ok(review.nextWeekTop.length >= 1);
});

test('tyhjä viikko ei kaadu', () => {
  const review = buildWeeklyReview({ tasks: [], goals: [], weekStartIso: MONDAY, todayIso: TODAY });
  assert.equal(review.stats.planned, 0);
  assert.equal(review.stats.completionRate, null);
  assert.equal(review.stats.busiestDay, null);
});

test('summarizeReview on toteava eikä syyllistävä', () => {
  assert.match(summarizeReview({ planned: 0 }), /tyhjä päivä on myös valinta/i);
  assert.match(summarizeReview({ planned: 3, completed: 3 }), /kaikki 3/i);
  assert.match(summarizeReview({ planned: 3, completed: 0 }), /siirretäänkö/i);
  assert.match(summarizeReview({ planned: 4, completed: 2 }), /2\/4/);
  assert.match(summarizeReview(null), /tyhjä/i);
});

// ========================================================= HYVINVOINTI

test('merkintä normalisoituu asteikolle 1–5', () => {
  const entry = normalizeWellbeingEntry({ date: TODAY, energy: 9, mood: -3, stress: 3.4 });
  assert.equal(entry.energy, SCALE_MAX);
  assert.equal(entry.mood, SCALE_MIN);
  assert.equal(entry.stress, 3);
});

test('puuttuvat arvot pysyvät tyhjinä eivätkä nollina', () => {
  const entry = normalizeWellbeingEntry({ date: TODAY });
  assert.equal(entry.energy, null);
  assert.equal(entry.sleepHours, null, 'tyhjä ei ole sama kuin nolla tuntia unta');
});

test('unituntien tarkkuus on yksi desimaali', () => {
  assert.equal(normalizeWellbeingEntry({ date: TODAY, sleepHours: 7.26 }).sleepHours, 7.3);
  assert.equal(normalizeWellbeingEntry({ date: TODAY, sleepHours: 99 }).sleepHours, 24);
  assert.equal(normalizeWellbeingEntry({ date: TODAY, sleepHours: -1 }).sleepHours, null);
});

test('validointi vaatii päivän ja edes yhden arvon', () => {
  assert.ok(validateWellbeingEntry(normalizeWellbeingEntry({ energy: 3 })).errors.date);
  assert.ok(validateWellbeingEntry(normalizeWellbeingEntry({ date: TODAY })).errors.entry);
  assert.equal(validateWellbeingEntry(normalizeWellbeingEntry({ date: TODAY, energy: 3 })).valid, true);
  assert.equal(validateWellbeingEntry(normalizeWellbeingEntry({ date: TODAY, note: 'ok' })).valid, true);
});

test('entryForDate löytää päivän merkinnän', () => {
  const entries = [
    normalizeWellbeingEntry({ date: MONDAY, energy: 3 }),
    normalizeWellbeingEntry({ date: TODAY, energy: 5 })
  ];
  assert.equal(entryForDate(entries, TODAY).energy, 5);
  assert.equal(entryForDate(entries, '2026-09-05'), null);
  assert.equal(entryForDate(null, TODAY), null);
});

test('keskiarvot ohittavat puuttuvat arvot', () => {
  const entries = [
    normalizeWellbeingEntry({ date: MONDAY, energy: 4, mood: 4 }),
    normalizeWellbeingEntry({ date: TODAY, energy: 2 })
  ];
  const avg = averages(entries);
  assert.equal(avg.energy, 3);
  assert.equal(avg.mood, 4, 'yksi puuttuva ei saa vetää keskiarvoa alas');
  assert.equal(avg.stress, null);
  assert.equal(avg.days, 2);
});

test('keskiarvot voidaan rajata aikavälille', () => {
  const entries = [
    normalizeWellbeingEntry({ date: '2026-08-01', energy: 1 }),
    normalizeWellbeingEntry({ date: TODAY, energy: 5 })
  ];
  assert.equal(averages(entries, { fromIso: MONDAY }).energy, 5);
});

test('kuormitustila arvioidaan signaaleista', () => {
  assert.equal(assessLoadState(normalizeWellbeingEntry({ date: TODAY, energy: 5, mood: 5, stress: 1, sleepHours: 8 })), LOAD_STATE.GOOD);
  assert.equal(assessLoadState(normalizeWellbeingEntry({ date: TODAY, energy: 1, mood: 1, stress: 5, sleepHours: 4 })), LOAD_STATE.STRAINED);
  assert.equal(assessLoadState(normalizeWellbeingEntry({ date: TODAY, energy: 2, mood: 3, stress: 3 })), LOAD_STATE.CAUTION);
});

test('ilman tietoa kuormitustila on tuntematon, ei arvaus', () => {
  assert.equal(assessLoadState(null), LOAD_STATE.UNKNOWN);
  assert.equal(assessLoadState(normalizeWellbeingEntry({ date: TODAY })), LOAD_STATE.UNKNOWN);
  assert.equal(loadStateLabel(LOAD_STATE.UNKNOWN), 'Ei tietoa');
});

test('⚠️ TAKUU: hyvinvointi EI muuta suunnitelmaa', () => {
  const plan = { load: { count: 10 } };
  const before = JSON.stringify(plan);
  const entry = normalizeWellbeingEntry({ date: TODAY, energy: 1, mood: 1, stress: 5 });

  const suggestion = planningLoadSuggestion({ entry, plan });

  assert.equal(JSON.stringify(plan), before, 'suunnitelmaa ei saa mutatoida');
  assert.equal(typeof suggestion.suggestion, 'string');
  assert.equal(suggestion.state, LOAD_STATE.STRAINED);
  // Palautus on EHDOTUS: luku ja teksti, ei toimenpide.
  assert.ok(Number.isInteger(suggestion.suggestedReduction));
});

test('kuormittunut päivä saa kevennysehdotuksen vain jos karsittavaa on', () => {
  const entry = normalizeWellbeingEntry({ date: TODAY, energy: 1, mood: 1, stress: 5, sleepHours: 4 });

  const busy = planningLoadSuggestion({ entry, plan: { load: { count: 10 } } });
  assert.ok(busy.suggestedReduction > 0);
  assert.equal(busy.actionable, true);
  assert.match(busy.suggestion, /siirtää/i);

  const light = planningLoadSuggestion({ entry, plan: { load: { count: 2 } } });
  assert.equal(light.suggestedReduction, 0);
  assert.equal(light.actionable, false);
  assert.match(light.suggestion, /tauot/i);
});

test('hyvä vire ja tyhjä päivä rohkaisee isompaan', () => {
  const entry = normalizeWellbeingEntry({ date: TODAY, energy: 5, mood: 5, stress: 1, sleepHours: 8 });
  const suggestion = planningLoadSuggestion({ entry, plan: { load: { count: 0 } } });
  assert.equal(suggestion.state, LOAD_STATE.GOOD);
  assert.match(suggestion.suggestion, /tilaa isommalle/i);
});

test('ilman merkintää ei anneta ehdotusta', () => {
  const suggestion = planningLoadSuggestion({ entry: null, plan: { load: { count: 5 } } });
  assert.equal(suggestion.state, LOAD_STATE.UNKNOWN);
  assert.equal(suggestion.suggestion, null);
  assert.equal(suggestion.actionable, false);
});

test('planningLoadSuggestion kestää puuttuvan suunnitelman', () => {
  const entry = normalizeWellbeingEntry({ date: TODAY, energy: 1, stress: 5 });
  assert.doesNotThrow(() => planningLoadSuggestion({ entry }));
  assert.doesNotThrow(() => planningLoadSuggestion({}));
});

test('mittareilla on suomenkieliset nimet', () => {
  assert.equal(metricLabel(METRIC.ENERGY), 'Energia');
  assert.equal(metricLabel(METRIC.STRESS), 'Kuormitus');
  assert.equal(metricLabel('tuntematon'), 'tuntematon');
});
