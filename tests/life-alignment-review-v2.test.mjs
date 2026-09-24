// Suunta 2: päivän havainnot, aineiston laatu v2, katsaus v2, vertailu,
// kehitys, tasapainotuksen esikatselu, suunnitelman tarkistus, rajat
// suunnittelulle ja sääntöversio.
//
// Kaikki puhtaita funktioita; kello annetaan parametrina.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { analyzeWeek, SIGNAL, SEVERITY } from '../src/domain/alignment.js';
import { dailyObservations, DAILY_RANK, todayConnection } from '../src/domain/dailyAlignment.js';
import { qualityIssues, QUALITY_ACTION } from '../src/domain/alignmentQuality.js';
import { weekSummary, compareWeeks, alignmentTrends } from '../src/domain/reviewComparison.js';
import { previewAdjustments } from '../src/domain/rebalance.js';
import { buildPlanningConstraints, validatePlanAlignment } from '../src/domain/planAlignment.js';
import {
  proposeAdjustments, buildReviewSnapshot, normalizeAlignmentReview, explainSignal, ADJUSTMENT,
  REFLECTION_PROMPTS, normalizeReflectionAnswers, SNAPSHOT_VERSION, NON_WRITING_ADJUSTMENTS
} from '../src/domain/alignmentReview.js';
import {
  POLICY_VERSION, ALIGNMENT_POLICY, TIME_RULES, DAILY_RULES, TREND_RULES, policyVersionOf
} from '../src/domain/alignmentPolicy.js';
import { RULES } from '../src/domain/alignment.js';
import { normalizeLifeArea } from '../src/domain/lifeArea.js';
import { normalizeTask } from '../src/domain/task.js';
import { normalizeGoal } from '../src/domain/goal.js';
import { normalizeTimeEntry } from '../src/domain/timeEntry.js';
import { normalizeWeeklyCapacity } from '../src/domain/weeklyCapacity.js';
import { normalizeItemSettings } from '../src/domain/alignmentItemSettings.js';
import { readCode } from './helpers/sources.mjs';
import { addDaysIso } from '../src/domain/fiTemporal.js';

const WEEK = '2026-09-14';
const THU = '2026-09-17';
const AFTER = '2026-09-21';
const NEXT = '2026-09-21';

const area = (id, name, importance, target, extra = {}) =>
  normalizeLifeArea({ id, name, importance, targetMinutesPerWeek: target, ...extra });
const task = (id, date, minutes, extra = {}) =>
  normalizeTask({ id, title: `T ${id}`, date, durationMinutes: minutes, ...extra });
const entry = (id, date, minutes, extra = {}) => normalizeTimeEntry({ id, entryDate: date, minutes, ...extra });
const cap = (weekStart, availableMinutes, extra = {}) =>
  normalizeWeeklyCapacity({ id: `c-${weekStart}`, weekStart, availableMinutes, ...extra });
const explain = areas => signal => explainSignal(signal, areas);

// ================================================================ POLITIIKKA

test('politiikka: oletukset ovat ensimmäisen version arvot (käytös ei muuttunut)', () => {
  assert.equal(RULES, TIME_RULES, 'alignment.js lukee samat kynnykset');
  assert.equal(TIME_RULES.MISALIGNMENT_POINTS, 15);
  assert.equal(TIME_RULES.MISALIGNMENT_STRONG_POINTS, 25);
  assert.equal(TIME_RULES.NEGLECT_RATIO, 0.5);
  assert.equal(TIME_RULES.NEGLECT_MIN_PROGRESS, 3 / 7);
  assert.equal(TIME_RULES.MISALIGNMENT_MIN_MINUTES, 120);
  assert.equal(POLICY_VERSION, 2);
  assert.ok(Object.isFrozen(ALIGNMENT_POLICY) && Object.isFrozen(TIME_RULES));
});

test('politiikka: yksikään alignment-moduuli ei piilota omia kynnysarvojaan', () => {
  // Maagiset luvut kuuluvat politiikkaan. Sallittuja ovat 0, 1, 2, 7, 15,
  // 30, 60, 100 ja pyöristykset — ei yhtään kynnysarvoa kuten 0.5 tai 120.
  for (const file of ['src/domain/alignment.js', 'src/domain/alignmentReview.js', 'src/domain/energyLoad.js',
    'src/domain/dailyAlignment.js', 'src/domain/reviewComparison.js']) {
    const code = readCode(file).replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const threshold of ['0.5', '0.25', '0.9', '1.2', '0.6', '3 / 7']) {
      assert.equal(code.includes(threshold), false, `${file}: kynnys ${threshold} kuuluu politiikkaan`);
    }
  }
});

test('sääntöversio tallentuu tilannekuvaan; vanha katsaus pysyy versiona 1', () => {
  const analysis = analyzeWeek({ weekStart: WEEK, todayIso: THU, areas: [area('a', 'A', 3, 60)] });
  const snapshot = buildReviewSnapshot(analysis);
  assert.equal(snapshot.version, SNAPSHOT_VERSION);
  assert.equal(snapshot.policyVersion, POLICY_VERSION);
  const old = normalizeAlignmentReview({ weekStart: WEEK, snapshot: { version: 1, signals: [] } });
  assert.equal(old.policyVersion, 1, 'versiota ei päivitetä takautuvasti');
  assert.equal(policyVersionOf({ version: 1 }), 1);
  assert.equal(policyVersionOf(snapshot), POLICY_VERSION);
});

// ================================================================ PÄIVÄN HAVAINNOT

function busyWeek() {
  const areas = [
    area('fam', 'Perhe', 5, 600, { categoryKey: 'perhe' }),
    area('work', 'Työ', 3, 600, { categoryKey: 'tyo' })
  ];
  const tasks = [
    task('w1', THU, 900, { category: 'tyo' }), task('w2', THU, null, { category: 'tyo' }),
    task('u1', THU, 30, { category: 'koti' }), task('u2', THU, 30, { category: 'koti' }),
    task('u3', THU, 30, { category: 'koti' }), task('u4', THU, null, { category: 'koti' }),
    task('u5', THU, null, { category: 'koti' })
  ];
  return analyzeWeek({ weekStart: WEEK, todayIso: THU, areas, tasks, capacity: cap(WEEK, 600) });
}

test('päivän havainnot: enintään kolme, järjestys deterministinen, vahva kuormitus ensin', () => {
  const analysis = busyWeek();
  const areas = [area('fam', 'Perhe', 5, 600), area('work', 'Työ', 3, 600)];
  const a = dailyObservations(analysis, { todayIso: THU, areas, explain: explain(areas) });
  const b = dailyObservations(analysis, { todayIso: THU, areas, explain: explain(areas) });
  assert.ok(a.observations.length <= DAILY_RULES.MAX_OBSERVATIONS);
  assert.deepEqual(a.observations.map(o => o.code), b.observations.map(o => o.code), 'deterministinen');
  assert.equal(a.observations[0].rank, DAILY_RANK.STRONG_OVERLOAD);
  assert.equal(a.observations[0].primary, true);
  assert.ok(a.observations.every(o => typeof o.why === 'string' && o.why.length > 10), 'jokaisella on syy');
  const ranks = a.observations.map(o => o.rank);
  assert.deepEqual(ranks, [...ranks].sort((x, y) => x - y));
  assert.ok(a.hiddenCount >= 1, 'loput kerrotaan määränä, ei listana');
});

test('päivän havainnot: kapasiteetti jäljellä ja tämän päivän yhteys tärkeisiin alueisiin', () => {
  const areas = [area('fam', 'Perhe', 5, 600, { categoryKey: 'perhe' })];
  const analysis = analyzeWeek({
    weekStart: WEEK, todayIso: THU, areas, capacity: cap(WEEK, 1200),
    tasks: [task('f', THU, 90, { category: 'perhe' }), task('x', THU, 30, { category: 'koti' })]
  });
  const daily = dailyObservations(analysis, { todayIso: THU, areas, explain: explain(areas) });
  assert.match(daily.status.join(' '), /Viikon kapasiteettia jäljellä 18 h/);
  assert.match(daily.status.join(' '), /Tänään suunnitellusta ajasta \(2 h\) 1 h 30 min liittyy sinulle hyvin tärkeisiin alueisiin/);
  assert.deepEqual(todayConnection(analysis, THU, areas), {
    itemCount: 2, knownMinutes: 120, importantMinutes: 90, importantCount: 1, unknownCount: 0
  });
});

test('päivän havainnot: luokittelematon työ vasta kynnyksen ylittyessä, tarkoituksellinen ei lasketa', () => {
  const areas = [area('work', 'Työ', 3, 600, { categoryKey: 'tyo' })];
  const tasks = ['a', 'b', 'c'].map(id => task(id, THU, 30, { category: 'koti' }));
  const without = analyzeWeek({ weekStart: WEEK, todayIso: THU, areas, tasks, capacity: cap(WEEK, 1200) });
  assert.ok(dailyObservations(without, { todayIso: THU, areas }).observations.some(o => o.code === 'unassigned'));
  const optedOut = analyzeWeek({
    weekStart: WEEK, todayIso: THU, areas, tasks, capacity: cap(WEEK, 1200),
    itemSettings: [normalizeItemSettings({ id: 's', itemKind: 'task', itemId: 'a', alignmentOptOut: true })]
  });
  assert.equal(optedOut.dataQuality.unassignedPlannedCount, 2);
  assert.equal(optedOut.dataQuality.intentionallyUnassignedCount, 1);
  assert.equal(dailyObservations(optedOut, { todayIso: THU, areas }).observations.some(o => o.code === 'unassigned'), false,
    'tarkoituksella jätetystä ei nalkuteta');
});

test('päivän havainnot eivät ole ilmoituksia eivätkä kaavioita', () => {
  const code = readCode('src/domain/dailyAlignment.js');
  assert.equal(/notification|scheduleNotification|chart|canvas/i.test(code.replace(/\/\/.*$/gm, '')), false);
});

// ================================================================ AINEISTON LAATU v2

test('laatu v2: prosentit ja toimenpiteet, ei moralisointia', () => {
  const areas = [area('work', 'Työ', 3, 600, { categoryKey: 'tyo' })];
  const analysis = analyzeWeek({
    weekStart: WEEK, todayIso: THU, areas, capacity: cap(WEEK, 1200),
    tasks: [task('a', THU, 60, { category: 'tyo' }), task('b', THU, null, { category: 'tyo' }),
      task('c', THU, null, { category: 'tyo' }), task('d', THU, 30, { category: 'koti' })],
    timeEntries: [entry('e1', THU, 100), entry('e2', THU, 60, { lifeAreaId: 'work' })]
  });
  const issues = qualityIssues(analysis);
  const byCode = Object.fromEntries(issues.map(i => [i.code, i]));
  assert.match(byCode.unestimated_work.text, /^50 % tämän viikon suunnitelluista asioista ei sisällä aika-arviota/);
  assert.equal(byCode.unestimated_work.action, QUALITY_ACTION.ESTIMATE);
  assert.match(byCode.unassigned_actual.text, /^Vain 38 % kirjatusta ajasta on yhdistetty elämänalueisiin\./);
  assert.equal(byCode.unassigned_work.action, QUALITY_ACTION.ASSIGN);
  for (const issue of issues) {
    assert.equal(/pitäisi|muista|laiminlyö|huono/i.test(issue.text), false, `moralisoiva sävy: ${issue.text}`);
  }
});

test('laatu v2: ei toteumaa -> "Et ole vielä kirjannut toteutunutta aikaa"', () => {
  const analysis = analyzeWeek({ weekStart: WEEK, todayIso: THU, areas: [area('a', 'A', 3, 60)], capacity: cap(WEEK, 600) });
  const issue = qualityIssues(analysis).find(i => i.code === 'no_actual');
  assert.match(issue.text, /^Et ole vielä kirjannut toteutunutta aikaa/);
  assert.equal(issue.action, QUALITY_ACTION.LOG_TIME);
  assert.deepEqual(qualityIssues(analyzeWeek({ weekStart: WEEK, todayIso: THU })).map(i => i.code), ['no_areas']);
});

// ================================================================ KATSAUS v2

test('pohdintakysymykset: viisi, valinnaisia, tuntemattomat pois, pituus rajattu', () => {
  assert.equal(REFLECTION_PROMPTS.length, 5);
  assert.deepEqual(REFLECTION_PROMPTS.map(p => p.text), [
    'Mikä vei enemmän aikaa kuin odotit?', 'Mikä jäi liian vähälle?',
    'Mikä tuntui tärkeältä mutta ei näkynyt suunnitelmassa?', 'Mikä kuormitti eniten?',
    'Kannattaako jotain jättää ensi viikolla tekemättä?'
  ]);
  const answers = normalizeReflectionAnswers({ took_longer: '  Muutto  ', hacker: 'x', too_little: '', most_draining: 'y'.repeat(5000) });
  assert.deepEqual(Object.keys(answers).sort(), ['most_draining', 'took_longer']);
  assert.equal(answers.took_longer, 'Muutto');
  assert.equal(answers.most_draining.length, 1000);
  assert.deepEqual(normalizeReflectionAnswers(['x']), {});
});

test('vertailu: vain erot, ei suuntaa yhdestä viikosta', () => {
  const areas = [area('work', 'Työ', 3, 600, { categoryKey: 'tyo' })];
  const prev = weekSummary(analyzeWeek({
    weekStart: '2026-09-07', todayIso: AFTER, areas, capacity: cap('2026-09-07', 1200),
    tasks: [task('a', '2026-09-08', 600, { category: 'tyo' })],
    timeEntries: [entry('e', '2026-09-08', 720, { lifeAreaId: 'work' })]
  }));
  const current = weekSummary(analyzeWeek({
    weekStart: WEEK, todayIso: AFTER, areas, capacity: cap(WEEK, 1200),
    tasks: [task('b', THU, 900, { category: 'tyo' })],
    timeEntries: [entry('f', THU, 900, { lifeAreaId: 'work' })]
  }));
  const comparison = compareWeeks(current, prev);
  assert.equal(comparison.available, true);
  assert.deepEqual(comparison.lines.map(l => l.text), [
    'Kapasiteetti: 20 h → 20 h (±0 min)',
    'Suunniteltu: 10 h → 15 h (+5 h)',
    'Kirjattu toteuma: 12 h → 15 h (+3 h)',
    'Kuormittavaa: 0 min → 0 min (±0 min)'
  ]);
  assert.equal(comparison.basis, 'actual');
  const all = [...comparison.lines.map(l => l.text), ...comparison.notes].join(' ');
  assert.equal(/kasvoi|väheni|suunta|parani|huononi/i.test(all.replace('Yksi viikko ei ole suunta', '')), false,
    'kahdesta viikosta ei tehdä trendiä');
  assert.equal(compareWeeks(current, null).available, false);
});

test('vertailu: toteumaa ei verrata, jos toisella viikolla ei ole kirjauksia', () => {
  const a = weekSummary(analyzeWeek({ weekStart: WEEK, todayIso: AFTER, areas: [area('a', 'A', 3, 60)] }));
  const b = weekSummary(analyzeWeek({
    weekStart: '2026-09-07', todayIso: AFTER, areas: [area('a', 'A', 3, 60)],
    timeEntries: [entry('e', '2026-09-08', 60, { lifeAreaId: 'a' })]
  }));
  const comparison = compareWeeks(a, b);
  assert.equal(comparison.lines.some(l => l.label === 'Kirjattu toteuma'), false);
  assert.ok(comparison.notes.some(n => /Toteumaa ei verrata/.test(n)));
});

test('vertailu: eri sääntöversiot kerrotaan', () => {
  const analysis = analyzeWeek({ weekStart: WEEK, todayIso: AFTER, areas: [area('a', 'A', 3, 60)] });
  const old = weekSummary({ ...buildReviewSnapshot(analysis), policyVersion: undefined, weekStart: '2026-09-07' }, { origin: 'snapshot' });
  assert.equal(old.policyVersion, 1);
  const comparison = compareWeeks(weekSummary(analysis), old);
  assert.ok(comparison.notes.some(n => /eri sääntöversioilla/.test(n)));
});

// ================================================================ KEHITYS

function weekWithActual(weekStart, workMinutes, { capacity = 1200, planned = 600 } = {}) {
  const areas = [area('work', 'Työ', 3, 600, { categoryKey: 'tyo' })];
  const tuesday = addDaysIso(weekStart, 1);
  return weekSummary(analyzeWeek({
    weekStart, todayIso: '2026-12-31', areas, capacity: cap(weekStart, capacity),
    tasks: [task(`t-${weekStart}`, tuesday, planned, { category: 'tyo' })],
    timeEntries: [entry(`e-${weekStart}`, tuesday, workMinutes, { lifeAreaId: 'work' })]
  }));
}

test('kehitys: ei johtopäätöksiä ennen kolmea viikkoa', () => {
  const trends = alignmentTrends([weekWithActual('2026-09-07', 300), weekWithActual('2026-09-14', 600)]);
  assert.equal(trends.enough, false);
  assert.deepEqual(trends.statements, [`Kehityksestä kerrotaan, kun aineistoa on vähintään ${TREND_RULES.MIN_WEEKS} viikolta.`]);
});

test('kehitys: samansuuntainen muutos kolmella viikolla sanoitetaan tosiasiana', () => {
  const trends = alignmentTrends([
    weekWithActual('2026-08-31', 300), weekWithActual('2026-09-07', 420), weekWithActual('2026-09-14', 540)
  ]);
  assert.equal(trends.enough, true);
  assert.ok(trends.statements.includes('Työ: kirjattu aika kasvoi kolmen viikon aikana (5 h → 9 h).'));
  for (const statement of trends.statements) {
    assert.equal(/elämäsi|väärään suuntaan|pitäisi|pisteet|score/i.test(statement), false, statement);
  }
});

test('kehitys: sahaava muutos ei ole trendi; pieni muutos ei ylitä kynnystä', () => {
  const zigzag = alignmentTrends([
    weekWithActual('2026-08-31', 300), weekWithActual('2026-09-07', 600), weekWithActual('2026-09-14', 420)
  ]);
  assert.equal(zigzag.statements.some(s => /kirjattu aika (kasvoi|väheni)/.test(s)), false);
  const small = alignmentTrends([
    weekWithActual('2026-08-31', 300), weekWithActual('2026-09-07', 310), weekWithActual('2026-09-14', 320)
  ]);
  assert.equal(small.statements.some(s => /Työ: kirjattu aika/.test(s)), false);
});

test('kehitys: kuormituksen toistuvuus kerrotaan lukuna', () => {
  const trends = alignmentTrends([
    weekWithActual('2026-08-31', 300, { capacity: 500 }), weekWithActual('2026-09-07', 300, { capacity: 1200 }),
    weekWithActual('2026-09-14', 300, { capacity: 500 })
  ]);
  assert.ok(trends.statements.includes('Suunnitelma ylitti kapasiteetin 2 viikolla 3:stä.'));
});

// ================================================================ TASAPAINOTUS

function rebalanceFixture() {
  const areas = [
    area('fam', 'Perhe', 5, 600, { categoryKey: 'perhe' }),
    area('hobby', 'Harrastus', 2, 120, { categoryKey: 'harrastus' }),
    area('work', 'Työ', 4, 1200, { categoryKey: 'tyo' })
  ];
  const goals = [
    normalizeGoal({ id: 'g-fam', title: 'Lapset', lifeAreaId: 'fam', priority: 'korkea' }),
    normalizeGoal({ id: 'g-hobby', title: 'Kitara', lifeAreaId: 'hobby' })
  ];
  const tasks = [
    task('this1', WEEK, 900, { category: 'tyo' }),
    task('n-work', NEXT, 1200, { category: 'tyo', priority: 'korkea' }),
    task('n-none', '2026-09-23', 300, { category: 'koti' }),
    task('n-low', '2026-09-24', 360, { category: 'tyo', priority: 'matala' }),
    task('n-open', '2026-09-24', null, { category: 'tyo' })
  ];
  const analysis = analyzeWeek({ weekStart: WEEK, todayIso: AFTER, areas, goals, tasks, capacity: cap(WEEK, 1440) });
  const nextInputs = {
    weekStart: NEXT, todayIso: AFTER, areas, goals, tasks, capacity: cap(NEXT, 1440)
  };
  const nextAnalysis = analyzeWeek(nextInputs);
  return { areas, goals, tasks, analysis, nextAnalysis, nextInputs };
}

test('ehdotukset v2: tavoitteesta kysytään, ei väitetä sitä vääräksi', () => {
  const { areas, goals, tasks, analysis, nextAnalysis } = rebalanceFixture();
  const proposals = proposeAdjustments(analysis, { areas, goals, tasks, nextWeekAnalysis: nextAnalysis, nextCapacity: cap(NEXT, 1440) });
  const change = proposals.filter(p => p.type === ADJUSTMENT.CHANGE_TARGET);
  assert.ok(change.length > 0);
  for (const proposal of change) {
    assert.match(proposal.label, /pidetäänkö tavoite vai muutetaanko suunnitelmaa\?/);
    assert.equal(/väärä|virheellinen|epärealistinen/i.test(proposal.label + proposal.detail), false);
  }
});

test('ehdotukset v2: arvioimaton työ ohjaa arviointiin eikä kirjoita mitään', () => {
  const { areas, goals, tasks, analysis, nextAnalysis } = rebalanceFixture();
  const proposals = proposeAdjustments(analysis, { areas, goals, tasks, nextWeekAnalysis: nextAnalysis, nextCapacity: cap(NEXT, 1440) });
  const request = proposals.find(p => p.type === ADJUSTMENT.REQUEST_ESTIMATES);
  assert.ok(request);
  assert.equal(request.payload.count, 1);
  assert.ok(NON_WRITING_ADJUSTMENTS.includes(ADJUSTMENT.REQUEST_ESTIMATES));
});

test('ehdotukset v2: hiljainen tavoite (ei tekemistä kolmeen viikkoon) ehdotetaan keskeytettäväksi', () => {
  const areas = [area('hobby', 'Harrastus', 2, 120), area('fam', 'Perhe', 5, 600)];
  const goals = [
    normalizeGoal({ id: 'quiet', title: 'Kitara', lifeAreaId: 'hobby' }),
    normalizeGoal({ id: 'busy', title: 'Retki', lifeAreaId: 'hobby' }),
    normalizeGoal({ id: 'important', title: 'Lapset', lifeAreaId: 'fam' })
  ];
  const weeks = ['2026-09-14', '2026-09-07', '2026-08-31'].map(week => analyzeWeek({
    weekStart: week, todayIso: AFTER, areas, goals,
    tasks: [task(`b-${week}`, week, 30, { goalId: 'busy' })]
  }));
  const proposals = proposeAdjustments(weeks[0], { areas, goals, recentAnalyses: weeks.slice(1) });
  const pauses = proposals.filter(p => p.type === ADJUSTMENT.PAUSE_GOAL).map(p => p.payload.goalId);
  assert.deepEqual(pauses, ['quiet'], 'vain hiljainen, vähemmän tärkeän alueen tavoite');
  assert.equal(proposeAdjustments(weeks[0], { areas, goals, recentAnalyses: [] })
    .some(p => p.type === ADJUSTMENT.PAUSE_GOAL), false, 'ilman historiaa ei päätellä hiljaisuutta');
});

test('esikatselu: ennen/jälkeen ilman kirjoituksia', () => {
  const { areas, goals, tasks, analysis, nextAnalysis, nextInputs } = rebalanceFixture();
  const proposals = proposeAdjustments(analysis, { areas, goals, tasks, nextWeekAnalysis: nextAnalysis, nextCapacity: cap(NEXT, 1440) });
  const postpone = proposals.find(p => p.type === ADJUSTMENT.POSTPONE_TASKS);
  assert.ok(postpone, 'ensi viikko ylittyy: siirtoehdotus');
  const frozenTasks = JSON.stringify(tasks);
  const preview = previewAdjustments({ inputs: nextInputs, proposals: [postpone] });
  assert.equal(preview.before.plannedMinutes, 1860);
  assert.ok(preview.after.plannedMinutes <= 1440, `jälkeen ${preview.after.plannedMinutes}`);
  assert.equal(preview.before.capacityMinutes, 1440);
  assert.equal(preview.after.capacityMinutes, 1440);
  assert.equal(JSON.stringify(tasks), frozenTasks, 'esikatselu ei muuta syötettä');
  assert.ok(preview.before.areas.length === preview.after.areas.length);
  assert.ok(preview.effects[0].text.includes('siirtyy viikolla eteenpäin'));
});

test('esikatselu: kapasiteetti, tavoite, varaus ja keskeytys kerrotaan rehellisesti', () => {
  const { nextInputs } = rebalanceFixture();
  const preview = previewAdjustments({
    inputs: nextInputs,
    proposals: [
      { id: 'c', type: ADJUSTMENT.SET_CAPACITY, payload: { availableMinutes: 1500 } },
      { id: 't', type: ADJUSTMENT.CHANGE_TARGET, payload: { areaId: 'fam', from: 600, to: 300 } },
      { id: 'n', type: ADJUSTMENT.CREATE_TASK, payload: { title: 'Aikaa', date: NEXT, durationMinutes: 60, category: 'perhe' } },
      { id: 'p', type: ADJUSTMENT.PAUSE_GOAL, payload: { goalId: 'g-hobby' } },
      { id: 'r', type: ADJUSTMENT.REQUEST_ESTIMATES, payload: {} }
    ],
    overrides: { c: { availableMinutes: 1560 } }
  });
  assert.equal(preview.after.capacityMinutes, 1560, 'käyttäjän muokkaama arvo');
  assert.equal(preview.after.plannedMinutes, preview.before.plannedMinutes + 60);
  assert.equal(preview.after.areas.find(a => a.id === 'fam').targetMinutes, 300);
  assert.ok(preview.effects.some(e => /päivätyt tehtävät pysyvät suunnitelmassa/.test(e.text)));
  assert.equal(preview.writes, 4, 'ohjaava ehdotus ei ole kirjoitus');
});

// ================================================================ SUUNNITTELU

test('rajat suunnittelulle: vain lukuja, ei nimiä eikä tunnisteita', () => {
  const areas = [area('fam', 'Perhe salainen', 5, 600, { categoryKey: 'perhe' }), area('work', 'Työ', 3, 600, { categoryKey: 'tyo' })];
  const analysis = analyzeWeek({
    weekStart: WEEK, todayIso: '2026-09-14', areas, capacity: cap(WEEK, 1200, { energyBudgetMinutes: 300 }),
    tasks: [task('w', WEEK, 600, { category: 'tyo', title: 'Salainen projekti' }), task('x', WEEK, null, { category: 'tyo' })],
    itemSettings: [normalizeItemSettings({ id: 's', itemKind: 'task', itemId: 'w', energyDemand: 4 })]
  });
  const constraints = buildPlanningConstraints(analysis);
  assert.deepEqual(constraints, {
    capacityHours: 20, committedHours: 10, remainingHours: 10, unestimatedCount: 1,
    heavyBudgetHours: 5, heavyRemainingHours: 0, neglectedImportantAreaCount: 1, protectedHours: 10
  });
  for (const value of Object.values(constraints)) {
    assert.ok(value === null || typeof value === 'number', 'vain lukuja');
  }
  assert.equal(JSON.stringify(constraints).includes('Perhe'), false);
});

test('suunnitelman tarkistus: mahtuu', () => {
  const base = {
    todayIso: '2026-09-14', areas: [], goals: [], tasks: [], routines: [], exceptions: [], timeEntries: [],
    capacities: [cap(WEEK, 1200)], itemSettings: []
  };
  const result = validatePlanAlignment({ planTasks: [{ ref: 't1', title: 'X', date: THU, durationMinutes: 120 }], base });
  assert.deepEqual(result.messages.map(m => m.text), ['Suunnitelma mahtuu kapasiteettiin.']);
  assert.equal(result.weeks[0].addedMinutes, 120);
});

test('suunnitelman tarkistus: ylittää kapasiteetin ja jättää tärkeän alueen ilman aikaa', () => {
  const areas = [area('fam', 'Perhe', 5, 600, { categoryKey: 'perhe' }), area('work', 'Työ', 3, 600, { categoryKey: 'tyo' })];
  const base = {
    todayIso: '2026-09-14', areas, goals: [], tasks: [task('w', WEEK, 600, { category: 'tyo' })],
    routines: [], exceptions: [], timeEntries: [], capacities: [cap(WEEK, 900)], itemSettings: []
  };
  const result = validatePlanAlignment({
    planTasks: [{ ref: 't1', title: 'Uusi', date: THU, durationMinutes: 480, category: 'tyo' },
      { ref: 't2', title: 'Ei päivää', date: null, durationMinutes: 60 }],
    areaId: 'work', base
  });
  const texts = result.messages.map(m => m.text);
  assert.ok(texts.includes('Suunnitelma ylittää kapasiteetin 3 h (viikko 14.9.–20.9.).'), texts.join(' | '));
  assert.ok(texts.some(t => /ei mahdu tärkeän alueen Perhe tavoitetta \(puuttuu 10 h\)/.test(t)), texts.join(' | '));
  assert.ok(texts.some(t => /1 tehtävää \(1 h\) on ilman päivää/.test(t)));
  assert.equal(result.weeks[0].fits, false);
});

test('suunnitelman tarkistus: ilman kapasiteettia sanotaan ettei voi arvioida', () => {
  const base = { todayIso: '2026-09-14', areas: [], goals: [], tasks: [], routines: [], exceptions: [], timeEntries: [], capacities: [] };
  const result = validatePlanAlignment({ planTasks: [{ ref: 't', title: 'X', date: THU, durationMinutes: 60 }], base });
  assert.match(result.messages[0].text, /ei ole kapasiteettia, joten mahtumista ei voi arvioida/);
});

test('suunnitelman tarkistus: rutiini lasketaan viikolle', () => {
  const base = {
    todayIso: '2026-09-14', areas: [], goals: [], tasks: [], routines: [], exceptions: [], timeEntries: [],
    capacities: [cap(WEEK, 60)]
  };
  const result = validatePlanAlignment({
    planTasks: [], planRoutines: [{ ref: 'r', title: 'Juoksu', recurrenceType: 'daily', durationMinutes: 30 }], base
  });
  assert.equal(result.weeks[0].addedMinutes, 7 * 30);
  assert.equal(result.weeks[0].fits, false);
});

test('suunnittelun tarkistus ja rajat eivät tuo tekoälyä', () => {
  for (const file of ['src/domain/planAlignment.js', 'src/domain/rebalance.js', 'src/domain/dailyAlignment.js',
    'src/domain/alignmentQuality.js', 'src/domain/reviewComparison.js', 'src/domain/energyLoad.js',
    'src/domain/timer.js', 'src/domain/alignmentPolicy.js', 'src/domain/realitySources.js']) {
    const imports = [...readCode(file).matchAll(/from '([^']+)'/g)].map(m => m[1]);
    assert.equal(imports.some(path => path.includes('/ai/') || path.includes('../app/') || path.includes('../data/')), false,
      `${file} tuo sivuvaikutuksellisen kerroksen`);
  }
});

test('päivän havaintojen selitys käyttää samaa deterministista selitystä', () => {
  const analysis = busyWeek();
  const areas = [area('fam', 'Perhe', 5, 600), area('work', 'Työ', 3, 600)];
  const signal = analysis.signals.find(s => s.kind === SIGNAL.OVERLOAD);
  const daily = dailyObservations(analysis, { todayIso: THU, areas, explain: explain(areas) });
  assert.equal(daily.observations[0].title, explainSignal(signal, areas).title);
  assert.equal(signal.severity, SEVERITY.STRONG);
});
