// Suunta, sääntöversio 3: harvat arviot, ensimmäinen viikko ja
// ensimmäinen katsaus (auditointi suunta-signals-firstweek F1–F13,
// suunta-day1-flow F5, error-ux ERR-04 ja ERR-12).
//
// Omistajan todellinen lähtötilanne: 36 tehtävää ilman kestoa, yksi
// tavoite, yksi projekti, ei rutiineja eikä alueita. Suunta on uusi.
// Näiden testien lupaus:
//
//   - yksi kirjaus tai muutama kirjauspäivä ei tee alueesta "huomiotta
//     jäävää"; päivät ennen ensimmäistä kirjausta ja ennen alueen
//     luontia ovat tuntemattomia, eivät nollaa
//   - kahden arvioidun tehtävän jakaumasta ei tehdä huomio-tason havaintoa
//   - harva arvioaineisto sanotaan ENSIMMÄISENÄ, ja sovellus on silti käytettävä
//   - säännöllinen kirjaaja saa yhä "Huomio" torstaina ja "Vahva" viikon jälkeen
//
// Domain-osat ovat puhtaita funktioita (kello parametrina). Näkymäosat
// renderöidään index.html:n tunnisteita vastaavaan DOM-tynkään (sama
// kuvio kuin life-alignment-ui-v2.test.mjs), ja kello jäädytetään.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { read } from './helpers/sources.mjs';
import { freezeLocalDate } from './helpers/clock.mjs';
import { setUser, clearUser } from '../src/data/session.js';
import { setClient } from '../src/data/client.js';
import { fakeClient } from './helpers/gates.mjs';
import { resetState, getState, setTasks, setDomainLoadStatus } from '../src/app/state.js';
import { clearLocalUserData } from '../src/app/actions.js';
import {
  createLifeArea, saveWeeklyCapacity, saveWeeklyReview, resetAppliedAdjustments, logTime,
  analyzeCurrentWeek, compareWithPreviousWeek, applyAdjustment, applySelectedAdjustments,
  analysisLoadProblems, currentProposals
} from '../src/app/alignment.js';
import { alignmentReviewsRepo } from '../src/data/collectionsRepo.js';
import { renderDirection, renderTodayDirection, initDirection, resetDirectionView } from '../src/app/views/direction.js';
import { analyzeWeek, SIGNAL, SEVERITY, TRACKING, trackingMaturity, weekProgress } from '../src/domain/alignment.js';
import {
  explainSignal, proposeAdjustments, planningFeedback, ADJUSTMENT, NON_WRITING_ADJUSTMENTS, BASIS_LABELS,
  timeSourceSplit
} from '../src/domain/alignmentReview.js';
import {
  qualityIssues, estimateConfidence, SPARSE_ESTIMATES_NOTICE, ESTIMATE_CONFIDENCE
} from '../src/domain/alignmentQuality.js';
import { dailyObservations, DAILY_RANK } from '../src/domain/dailyAlignment.js';
import { weekSummary, compareWeeks, alignmentTrends, FIRST_WEEK_NOTE } from '../src/domain/reviewComparison.js';
import { buildPlanningConstraints } from '../src/domain/planAlignment.js';
import { previewAdjustments } from '../src/domain/rebalance.js';
import { TIME_RULES, POLICY_VERSION } from '../src/domain/alignmentPolicy.js';
import { normalizeLifeArea } from '../src/domain/lifeArea.js';
import { normalizeTask } from '../src/domain/task.js';
import { normalizeTimeEntry } from '../src/domain/timeEntry.js';
import { normalizeWeeklyCapacity } from '../src/domain/weeklyCapacity.js';
import { addDaysIso } from '../src/domain/fiTemporal.js';

// Viikko ma 2026-09-28 ... su 2026-10-04; katsaus seuraavana maanantaina.
const WEEK = '2026-09-28';
const day = i => addDaysIso(WEEK, i);
const AFTER = addDaysIso(WEEK, 7);
const DAY_NAMES = ['ma', 'ti', 'ke', 'to', 'pe', 'la', 'su'];

const area = (id, name, importance, target, categoryKey, startDate = null) =>
  ({ ...normalizeLifeArea({ id, name, importance, targetMinutesPerWeek: target, categoryKey }), startDate });
const task = (id, date, minutes, extra = {}) =>
  normalizeTask({ id, title: 'T' + id, date, durationMinutes: minutes, ...extra });
const entry = (id, date, minutes, extra = {}) => normalizeTimeEntry({ id, entryDate: date, minutes, ...extra });
const capacity = (minutes, weekStart = WEEK) =>
  normalizeWeeklyCapacity({ id: 'c-' + weekStart, weekStart, availableMinutes: minutes });
const signalsOf = (analysis, kind) => analysis.signals.filter(signal => signal.kind === kind);
const loud = signal => signal.severity === SEVERITY.ATTENTION || signal.severity === SEVERITY.STRONG;

/** Alueet, jotka käyttäjä luo päivänä `startDate` (sovelluskerros antaa luontipäivän). */
function areasCreated(startDate) {
  return [
    area('work', 'Työ', 4, 1200, 'tyo', startDate),
    area('fam', 'Perhe', 5, 600, 'perhe', startDate),
    area('health', 'Hyvinvointi', 4, 180, 'hyvinvointi', startDate),
    area('hobby', 'Harrastus', 2, 120, 'harrastus', startDate)
  ];
}

// Omistajan tilanne: 12 tämän viikon tehtävää, kaikki ilman kestoa.
const CATEGORIES = ['tyo', 'tyo', 'perhe', 'koti', 'tyo', 'muu', 'perhe', 'tyo', 'hyvinvointi', 'koti', 'tyo', 'perhe'];
function ownerTasks(estimates = {}) {
  return CATEGORIES.map((category, i) => task('p' + i, day(i % 7), estimates['p' + i] ?? null, { category }));
}

// ================================================================ S1: harva viikko, päivä päivältä

/**
 * S1: alueet ja kapasiteetti luodaan keskiviikkona, kaksi tehtävää
 * arvioidaan samana päivänä, kirjaaminen alkaa torstaina (45 min),
 * perjantaina 90 + 30 min ja sunnuntaina 60 min.
 */
function s1(todayIso, nowMinutes = 20 * 60) {
  const created = day(2);
  const started = todayIso >= created;
  const all = [
    entry('e1', day(3), 45, { taskId: 'p0' }),
    entry('e2', day(4), 90, { lifeAreaId: 'work' }),
    entry('e3', day(4), 30, { lifeAreaId: 'fam' }),
    entry('e4', day(6), 60, { lifeAreaId: 'fam' })
  ];
  return analyzeWeek({
    weekStart: WEEK, todayIso, nowMinutes,
    areas: started ? areasCreated(created) : [],
    tasks: ownerTasks(started ? { p0: 60, p1: 90 } : {}),
    timeEntries: all.filter(e => e.entryDate <= todayIso),
    capacity: started ? capacity(1800) : null
  });
}

test('S1 päivätaulukko ma→su ja katsaus: ei yhtään huomio- tai vahvaa huomiotta jäämistä ensimmäisellä viikolla', () => {
  // Päivä: odotettu seurannan taso. Ennen versiota 3 torstain yksi 45 min
  // kirjaus teki kolmesta alueesta "Huomio: jäämässä huomiotta" ja
  // katsauksesta "Vahva".
  const table = [
    [day(0), TRACKING.NONE], [day(1), TRACKING.NONE], [day(2), TRACKING.NONE],
    [day(3), TRACKING.EARLY], [day(4), TRACKING.EARLY], [day(5), TRACKING.EARLY],
    [day(6), TRACKING.PARTIAL], [AFTER, TRACKING.PARTIAL]
  ];
  for (const [todayIso, level] of table) {
    const label = todayIso === AFTER ? 'katsaus' : DAY_NAMES[table.findIndex(row => row[0] === todayIso)];
    const analysis = s1(todayIso, todayIso === AFTER ? 0 : 20 * 60);
    assert.equal(analysis.tracking.level, level, `${label}: seurannan taso`);
    const neglect = signalsOf(analysis, SIGNAL.NEGLECT);
    assert.equal(neglect.filter(loud).length, 0, `${label}: huomiotta jääminen oli ${neglect.map(s => s.severity).join(',')}`);
    assert.ok(neglect.every(s => s.basis === 'planned'), `${label}: toteumaan perustuvaa ei ole`);
    // Kahden arvioidun tehtävän jakaumasta ei tehdä havaintoa.
    assert.equal(signalsOf(analysis, SIGNAL.MISALIGNMENT).length, 0, `${label}: poikkeama harvasta aineistosta`);
  }
});

test('S1 torstai: yksi kirjaus -> seuranta "early", huomiotta jääminen suunnitelmasta ja ilman vajeen väitettä', () => {
  const thu = s1(day(3));
  assert.equal(thu.tracking.level, TRACKING.EARLY);
  assert.equal(thu.tracking.windowStart, day(3), 'vertailu alkaisi ensimmäisestä kirjauksesta');
  assert.equal(thu.tracking.firstEntryDate, day(3));
  assert.ok(thu.dataQuality.reasons.includes('partial_actual'));
  // Alueilla on arvioimattomia asioita: "kesto ei vielä tiedossa", ei "vähän aikaa".
  const fam = signalsOf(thu, SIGNAL.NEGLECT).find(s => s.areaId === 'fam');
  assert.equal(fam.rule, 'neglect.plan_unknown');
  const text = explainSignal(fam, areasCreated(day(2)));
  assert.match(text.title + text.text, /ei vielä tiedossa/);
  assert.doesNotMatch(text.title + text.text, /vähän aikaa/);
});

// ================================================================ S3: alue luotu torstaina

test('S3: alueet torstaina + yksi kirjaus -> ei toteumavertailua millään päivällä eikä katsauksessa', () => {
  for (const todayIso of [day(3), day(4), day(5), day(6), AFTER]) {
    const analysis = analyzeWeek({
      weekStart: WEEK, todayIso, nowMinutes: todayIso === AFTER ? 0 : 20 * 60,
      areas: areasCreated(day(3)), tasks: ownerTasks(),
      timeEntries: [entry('a', day(3), 30, { lifeAreaId: 'work' })], capacity: capacity(1800)
    });
    assert.equal(signalsOf(analysis, SIGNAL.NEGLECT).filter(loud).length, 0, todayIso);
    assert.equal(analysis.tracking.level, TRACKING.EARLY, todayIso);
  }
});

test('S3b: torstaina luotu alue ja säännöllinen kirjaus: odotettu lasketaan torstaista, ei koskaan "Vahva" samalla viikolla', () => {
  const areas = areasCreated(day(3));
  const timeEntries = [3, 4, 5, 6].map(i => entry('w' + i, day(i), 100, { lifeAreaId: 'work' }));
  const input = { weekStart: WEEK, areas, tasks: [], timeEntries, capacity: capacity(1800) };
  // Lauantaina jakso (to–pe) on alle 3/7 viikkoa: ei vielä vertailua.
  assert.equal(analyzeWeek({ ...input, todayIso: day(5), timeEntries: timeEntries.slice(0, 3) }).tracking.level, TRACKING.EARLY);

  const review = analyzeWeek({ ...input, todayIso: AFTER });
  assert.equal(review.tracking.level, TRACKING.ESTABLISHED);
  assert.equal(review.tracking.windowStart, day(3));
  assert.equal(review.tracking.windowDays, 4);
  const fam = signalsOf(review, SIGNAL.NEGLECT).find(s => s.areaId === 'fam');
  assert.equal(fam.basis, 'actual');
  assert.equal(fam.metrics.expectedByNowMinutes, Math.round(600 * 4 / 7), 'odotettu to–su, ei koko viikolta');
  assert.equal(fam.severity, SEVERITY.ATTENTION, 'jakso 4/7 < 6/7: ei vahvaa');
  assert.match(explainSignal(fam, areas).text, /Perhe: kirjattu 0 min, .*verrattuna 1\.10\. alkaen/);
  assert.match(explainSignal(fam, areas).why, /sitä edeltävät päivät ovat tuntemattomia, eivät nollaa/);
});

// ================================================================ S5 ja S6

test('S5: 130 min kahtena päivänä tiistaina -> ei toteumaan perustuvaa poikkeamaa; laatu kertoo osittaisesta kirjauksesta', () => {
  const areas = areasCreated(day(0));
  const analysis = analyzeWeek({
    weekStart: WEEK, todayIso: day(1), nowMinutes: 20 * 60, areas, capacity: capacity(1800),
    tasks: [task('w1', day(0), 600, { category: 'tyo' }), task('f1', day(5), 400, { category: 'perhe' }),
      task('h1', day(2), 120, { category: 'hyvinvointi' })],
    timeEntries: [entry('a', day(0), 60, { lifeAreaId: 'work' }), entry('b', day(1), 70, { lifeAreaId: 'work' })]
  });
  assert.equal(signalsOf(analysis, SIGNAL.MISALIGNMENT).some(s => s.basis === 'actual'), false);
  assert.ok([TRACKING.EARLY, TRACKING.PARTIAL].includes(analysis.tracking.level));
  assert.ok(analysis.dataQuality.reasons.includes('partial_actual'));
  assert.notEqual(analysis.dataQuality.level, 'good', 'ennen versiota 3 "kattava"');
  const issue = qualityIssues(analysis).find(i => i.code === 'partial_actual');
  assert.match(issue.text, /tuntemattomia, eivät nollaa/);
  assert.equal(/pitäisi|muista|laiminlyö|huono/i.test(issue.text), false, 'ei moralisointia');
});

/** S6: säännöllinen kirjaaja: työ 240 min ja hyvinvointi 40 min joka arkipäivä, perhe ei mitään. */
function s6(todayIso, nowMinutes = 20 * 60) {
  const areas = areasCreated(day(0)).filter(a => a.id !== 'hobby');
  const timeEntries = [];
  for (let i = 0; i < 5; i++) {
    timeEntries.push(entry('w' + i, day(i), 240, { lifeAreaId: 'work', source: i % 2 ? 'timer' : 'manual' }));
    timeEntries.push(entry('h' + i, day(i), 40, { lifeAreaId: 'health' }));
  }
  return analyzeWeek({
    weekStart: WEEK, todayIso, nowMinutes, areas, capacity: capacity(1800),
    timeEntries: timeEntries.filter(e => e.entryDate <= todayIso)
  });
}

test('S6 REGRESSIO: säännöllinen kirjaaja saa yhä "Huomio" torstaina ja "Vahva" viikon jälkeen', () => {
  const tue = s6(day(1));
  assert.equal(signalsOf(tue, SIGNAL.NEGLECT).filter(loud).length, 0, 'tiistaina (alle 3/7) ei vielä');
  const thu = s6(day(3));
  assert.equal(thu.tracking.level, TRACKING.ESTABLISHED);
  assert.equal(thu.dataQuality.level, 'good');
  const famThu = signalsOf(thu, SIGNAL.NEGLECT).find(s => s.areaId === 'fam');
  assert.equal(famThu.basis, 'actual');
  assert.equal(famThu.severity, SEVERITY.ATTENTION);
  const work = signalsOf(thu, SIGNAL.MISALIGNMENT).find(s => s.areaId === 'work');
  assert.equal(work.basis, 'actual');
  assert.equal(work.severity, SEVERITY.ATTENTION, 'kesken viikon enintään Huomio');
  assert.match(explainSignal(work, areasCreated(day(0))).text, /kirjatusta ajastasi/);

  const after = s6(AFTER, 0);
  const famAfter = signalsOf(after, SIGNAL.NEGLECT).find(s => s.areaId === 'fam');
  assert.equal(famAfter.severity, SEVERITY.STRONG, 'viikon jälkeen vahva');
  assert.equal(signalsOf(after, SIGNAL.MISALIGNMENT).find(s => s.areaId === 'work').severity, SEVERITY.STRONG);
});

test('alue ei voi samaan aikaan jäädä huomiotta ja viedä liikaa (ei "yli"-poikkeamaa huomiotta jäävälle)', () => {
  // Kirjataan vähän, mutta kaikki Perheelle: osuus 100 % (yli toiveen)
  // ja silti alle puolet tavoitteesta (huomiotta). Näytetään vain vaje.
  const areas = [area('fam', 'Perhe', 5, 600, 'perhe'), area('work', 'Työ', 3, 600, 'tyo')];
  const analysis = analyzeWeek({
    weekStart: WEEK, todayIso: AFTER, areas,
    timeEntries: [0, 1, 2, 3].map(i => entry('f' + i, day(i), 40, { lifeAreaId: 'fam' }))
  });
  assert.ok(signalsOf(analysis, SIGNAL.NEGLECT).some(s => s.areaId === 'fam' && s.basis === 'actual'));
  assert.equal(signalsOf(analysis, SIGNAL.MISALIGNMENT).some(s => s.areaId === 'fam'), false);
});

// ================================================================ ARVIOIDEN KATTAVUUS (F3, F4)

/** Sama 12 tehtävän viikko, arvioituna `count` kappaletta (ensin työ, sitten perhe). */
function ladder(count) {
  const order = ['t0', 't1', 't8', 't2', 't3', 't4', 't9', 't5', 't6', 't10', 't7', 't11'];
  const estimated = new Set(order.slice(0, count));
  const tasks = Array.from({ length: 12 }, (_, i) => {
    const id = 't' + i;
    const category = i < 8 ? 'tyo' : 'perhe';
    const minutes = estimated.has(id) ? (category === 'tyo' ? 120 : 120) : null;
    return task(id, day(i % 5), minutes, { category });
  });
  const areas = [area('work', 'Työ', 3, 600, 'tyo'), area('fam', 'Perhe', 3, 600, 'perhe')];
  return { areas, analysis: analyzeWeek({ weekStart: WEEK, todayIso: day(1), areas, tasks, capacity: capacity(2400) }) };
}

test('suunnitelman jakauma kattavuuden mukaan: 17 % ei havaintoa, 50 % ja 67 % tiedoksi, 83 % huomio', () => {
  const rows = [
    // [arvioituja, kattavuus %, odotettu vakavuus (null = ei havaintoa), vajaa?]
    [2, 17, null, null],
    [6, 50, SEVERITY.INFO, true],
    [8, 67, SEVERITY.INFO, true],
    [10, 83, SEVERITY.ATTENTION, false]
  ];
  for (const [count, coverage, severity, incomplete] of rows) {
    const { areas, analysis } = ladder(count);
    assert.equal(analysis.dataQuality.estimateCoveragePercent, coverage);
    const work = signalsOf(analysis, SIGNAL.MISALIGNMENT).find(s => s.areaId === 'work');
    if (severity === null) {
      assert.equal(work, undefined, `${coverage} %: ei jakaumaa harvasta aineistosta`);
    } else {
      assert.ok(work, `${coverage} %: havainto`);
      assert.equal(work.basis, 'planned');
      assert.equal(work.severity, severity, `${coverage} %`);
      assert.equal(work.metrics.incomplete, incomplete, `${coverage} %`);
      assert.equal(work.metrics.estimateCoveragePercent, coverage);
      const text = explainSignal(work, areas);
      assert.match(text.title, /Työ vie suunnitelmassa enemmän kuin halusit/);
      if (incomplete) assert.match(text.text, new RegExp(`Vain ${coverage} % suunnitelluista asioista on arvioitu`));
    }
    const feedback = planningFeedback(analysis);
    for (const id of feedback.prioritizeAreaIds) {
      assert.equal(feedback.deprioritizeAreaIds.includes(id), false, `${coverage} %: ${id} molemmissa listoissa`);
    }
  }
});

test('harva arvioaineisto: ilmoitus on laadun ENSIMMÄINEN asia ja katoaa, kun arvioita on vähintään 80 %', () => {
  assert.equal(SPARSE_ESTIMATES_NOTICE, 'Suunnan arvio tarkentuu, kun lisäät aika-arvioita.');
  const sparse = ladder(2).analysis;
  assert.equal(estimateConfidence(sparse), ESTIMATE_CONFIDENCE.SPARSE);
  assert.equal(qualityIssues(sparse)[0].text, SPARSE_ESTIMATES_NOTICE);
  assert.equal(qualityIssues(sparse)[0].action, 'estimate');
  assert.equal(estimateConfidence(ladder(8).analysis), ESTIMATE_CONFIDENCE.PARTIAL);
  assert.equal(qualityIssues(ladder(8).analysis)[0].code, 'sparse_estimates');
  const full = ladder(10).analysis;
  assert.equal(estimateConfidence(full), ESTIMATE_CONFIDENCE.OK);
  assert.equal(qualityIssues(full).some(i => i.code === 'sparse_estimates'), false);
});

test('päivän havainnot harvalla aineistolla: arvioimaton työ ennen suunnitelman havaintoja, kapasiteetti ehdollisena', () => {
  const analysis = s1(day(2));
  const areas = areasCreated(day(2));
  const daily = dailyObservations(analysis, { todayIso: day(2), areas, explain: s => explainSignal(s, areas) });
  assert.equal(daily.notice, SPARSE_ESTIMATES_NOTICE);
  assert.equal(daily.noticeAction, 'open_estimate');
  assert.equal(daily.observations[0].code, 'unestimated');
  assert.equal(daily.observations[0].rank, DAILY_RANK.SPARSE_ESTIMATES);
  assert.match(daily.observations[0].why, /suurimmalta osalta viikon asioista puuttuu kesto/);
  assert.match(daily.status.join(' '), /Viikon kapasiteettia jäljellä 27 h 30 min arvioidun työn jälkeen; 10 asiaa ilman kestoarviota ei ole mukana\./);
  assert.equal(dailyObservations(ladder(10).analysis, { todayIso: day(1) }).notice, null);
});

// ================================================================ plan_unknown ja suunnittelun rajat (F6)

test('plan_unknown: arvioimaton alue ei ole vaje — ei suojattua aikaa, painotusta eikä varausehdotusta', () => {
  const areas = [area('fam', 'Perhe', 5, 600, 'perhe'), area('work', 'Työ', 3, 600, 'tyo')];
  const analysis = analyzeWeek({
    weekStart: WEEK, todayIso: day(0), areas, capacity: capacity(1200),
    tasks: [task('f1', day(1), null, { category: 'perhe' }), task('f2', day(2), null, { category: 'perhe' }),
      task('f3', day(3), null, { category: 'perhe' }), task('w1', day(1), 300, { category: 'tyo' })]
  });
  const fam = signalsOf(analysis, SIGNAL.NEGLECT).find(s => s.areaId === 'fam');
  assert.equal(fam.rule, 'neglect.plan_unknown');
  assert.equal(fam.severity, SEVERITY.INFO);
  const constraints = buildPlanningConstraints(analysis);
  assert.equal(constraints.protectedHours, 0);
  assert.equal(constraints.neglectedImportantAreaCount, 0);
  assert.deepEqual(planningFeedback(analysis).prioritizeAreaIds, []);
  const proposals = proposeAdjustments(analysis, { areas });
  assert.equal(proposals.some(p => p.type === ADJUSTMENT.CREATE_TASK || p.type === ADJUSTMENT.CHANGE_TARGET), false);
});

test('suojattu aika ei koskaan ylitä jäljellä olevaa kapasiteettia (satunnaiset aineistot, kiinteä siemen)', () => {
  let seed = 20260928;
  const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const pick = list => list[Math.floor(random() * list.length)];
  for (let round = 0; round < 200; round++) {
    const areas = ['tyo', 'perhe', 'hyvinvointi', 'harrastus'].slice(0, 1 + Math.floor(random() * 4))
      .map((key, i) => area('a' + i, 'Alue ' + i, 1 + Math.floor(random() * 5), pick([null, 0, 60, 300, 600, 1200, 2400]), key));
    const tasks = Array.from({ length: Math.floor(random() * 15) }, (_, i) =>
      task('t' + i, day(Math.floor(random() * 7)), pick([null, null, 15, 60, 180, 600]), { category: pick(['tyo', 'perhe', 'koti', 'hyvinvointi']) }));
    const analysis = analyzeWeek({
      weekStart: WEEK, todayIso: day(Math.floor(random() * 8)), areas, tasks, capacity: capacity(pick([0, 60, 600, 1800, 3000]))
    });
    const constraints = buildPlanningConstraints(analysis);
    assert.ok(constraints.protectedHours <= constraints.remainingHours,
      `kierros ${round}: suojattu ${constraints.protectedHours} > jäljellä ${constraints.remainingHours}`);
  }
});

// ================================================================ KATSAUKSEN EHDOTUKSET (F5)

test('ensimmäisen viikon katsaus: kapasiteettia ei pienennetä osittaisesta kirjauksesta, tavoitetta ei esitäytetä nollaan', () => {
  for (const [label, analysis, areas] of [
    ['S1', s1(AFTER, 0), areasCreated(day(2))],
    ['S3', analyzeWeek({ weekStart: WEEK, todayIso: AFTER, areas: areasCreated(day(3)), tasks: ownerTasks(),
      timeEntries: [entry('a', day(3), 30, { lifeAreaId: 'work' })], capacity: capacity(1800) }), areasCreated(day(3))]
  ]) {
    const proposals = proposeAdjustments(analysis, { areas, goals: [], tasks: ownerTasks() });
    const setCapacity = proposals.find(p => p.type === ADJUSTMENT.SET_CAPACITY);
    assert.equal(setCapacity.reason, null, `${label}: ei "kirjasit vähemmän" -kysymystä`);
    assert.equal(setCapacity.payload.availableMinutes, 1800, `${label}: oma arvio säilyy lähtökohtana`);
    for (const change of proposals.filter(p => p.type === ADJUSTMENT.CHANGE_TARGET)) {
      assert.ok(change.payload.to >= TIME_RULES.NEGLECT_MIN_TARGET_MINUTES, `${label}: tavoite ${change.payload.to}`);
    }
    const start = proposals.find(p => p.type === ADJUSTMENT.START_TRACKING);
    assert.ok(start, `${label}: kirjaamisen ehdotus`);
    assert.ok(NON_WRITING_ADJUSTMENTS.includes(ADJUSTMENT.START_TRACKING));
    assert.match(start.label, /Kirjaa aikaa koko ensi viikon/);
    const preview = previewAdjustments({
      inputs: { weekStart: AFTER, todayIso: AFTER, areas, tasks: [], capacity: null }, proposals: [start]
    });
    assert.equal(preview.writes, 0, `${label}: ohjaava ehdotus ei kirjoita`);
  }
});

test('vakiintunut kirjaus koko viikolta: kapasiteettikysymys syntyy yhä todellisesta poikkeamasta', () => {
  const areas = areasCreated(day(0));
  const analysis = analyzeWeek({
    weekStart: WEEK, todayIso: AFTER, areas, capacity: capacity(1800),
    timeEntries: [0, 1, 2, 3, 4, 5, 6].map(i => entry('w' + i, day(i), 100, { lifeAreaId: 'work' }))
  });
  assert.equal(analysis.tracking.level, TRACKING.ESTABLISHED);
  const setCapacity = proposeAdjustments(analysis, { areas }).find(p => p.type === ADJUSTMENT.SET_CAPACITY);
  assert.equal(setCapacity.reason.kind, 'capacity_deviation');
  assert.equal(setCapacity.payload.availableMinutes, 690);
  assert.equal(proposeAdjustments(analysis, { areas }).some(p => p.type === ADJUSTMENT.START_TRACKING), false);
});

// ================================================================ VERTAILU JA KEHITYS (F9, F10)

test('kehitys: arvioiden kattavuuden kasvu ei ole "suunniteltu aika kasvoi"', () => {
  const areas = areasCreated(addDaysIso(WEEK, -21));
  const summaries = [0, 3, 6, 9].map((estimated, index) => {
    const weekStart = addDaysIso(WEEK, -7 * (3 - index));
    const tasks = Array.from({ length: 10 }, (_, k) =>
      task(`w${index}k${k}`, addDaysIso(weekStart, k % 7), k < estimated ? 60 : null, { category: 'tyo' }));
    return weekSummary(analyzeWeek({ weekStart, todayIso: AFTER, areas, tasks }));
  });
  assert.deepEqual(summaries.map(s => s.estimateCoveragePercent), [0, 30, 60, 90]);
  const trends = alignmentTrends(summaries);
  assert.equal(trends.statements.some(s => /Suunniteltu aika kasvoi/.test(s)), false);
  assert.ok(trends.statements.some(s => /Suunnitellun ajan kehitystä ei sanoiteta/.test(s)));

  // Täysi kattavuus: sama kasvu sanoitetaan tosiasiana.
  const full = [300, 420, 540, 660].map((minutes, index) => {
    const weekStart = addDaysIso(WEEK, -7 * (3 - index));
    return weekSummary(analyzeWeek({ weekStart, todayIso: AFTER, areas,
      tasks: [task('x' + index, addDaysIso(weekStart, 1), minutes, { category: 'tyo' })] }));
  });
  assert.ok(alignmentTrends(full).statements.some(s => /Suunniteltu aika kasvoi/.test(s)));
});

test('vertailu: arvioimattomien määrä kulkee suunnitellun rivin mukana; harvaa viikkoa ei verrata', () => {
  const areas = areasCreated(addDaysIso(WEEK, -7));
  const previous = weekSummary(analyzeWeek({ weekStart: addDaysIso(WEEK, -7), todayIso: AFTER, areas,
    tasks: [task('a', addDaysIso(WEEK, -6), 120, { category: 'tyo' }), task('b', addDaysIso(WEEK, -5), 60, { category: 'tyo' }),
      task('c', addDaysIso(WEEK, -5), null, { category: 'tyo' })] }));
  const current = weekSummary(analyzeWeek({ weekStart: WEEK, todayIso: AFTER, areas,
    tasks: [task('d', day(1), 300, { category: 'tyo' }), task('e', day(2), 60, { category: 'tyo' })] }));
  const planned = compareWeeks(current, previous).lines.find(line => line.label === 'Suunniteltu');
  assert.equal(planned.text, 'Suunniteltu: 3 h → 6 h (+3 h) (arvioimattomia 1 → 0)');

  const sparse = weekSummary(s1(AFTER, 0));
  const comparison = compareWeeks(sparse, previous);
  assert.equal(comparison.lines.some(line => line.label === 'Suunniteltu'), false);
  assert.ok(comparison.notes.some(note => /Suunniteltua aikaa ei verrata/.test(note)));
  assert.deepEqual(compareWeeks(current, null, { unavailableNote: FIRST_WEEK_NOTE }).notes, [FIRST_WEEK_NOTE]);
});

test('seurannan kypsyys: kynnykset ja rajat (kapasiteetti vain kun asetettu)', () => {
  const dates = Array.from({ length: 7 }, (_, i) => day(i));
  const actualOf = (days, minutes) => {
    const minutesByDate = new Map(days.map(d => [d, minutes]));
    return { entryCount: days.length, entryDates: days, minutesByDate, firstEverEntryDate: days[0] || null };
  };
  const thursday = weekProgress(WEEK, day(3));
  const two = trackingMaturity({ dates, progress: thursday, actual: actualOf([day(0), day(1)], 60), todayIso: day(3) });
  assert.equal(two.level, TRACKING.ESTABLISHED, 'kaksi päivää kolmesta ilman kapasiteettia');
  const one = trackingMaturity({ dates, progress: thursday, actual: actualOf([day(0)], 600), todayIso: day(3) });
  assert.equal(one.level, TRACKING.EARLY, 'yksi päivä ei riitä minuuteista riippumatta');
  const low = trackingMaturity({ dates, progress: thursday, actual: actualOf([day(0), day(1)], 60),
    capacity: capacity(3000), todayIso: day(3) });
  assert.equal(low.level, TRACKING.PARTIAL, '120 min < 25 % x 50 h x 3/7');
  assert.equal(low.loggedSharePercent, 9);
  const after = weekProgress(WEEK, AFTER);
  const sparseDays = trackingMaturity({ dates, progress: after, actual: actualOf([day(0), day(2), day(4)], 300), todayIso: AFTER });
  assert.equal(sparseDays.level, TRACKING.PARTIAL, '3 päivää 7:stä < puolet');
  assert.equal(POLICY_VERSION, 3);
});

test('F13: kirjattu aika lähteittäin näyttöä varten; ajastin ja käsin ovat seurannassa samanarvoisia', () => {
  assert.deepEqual(timeSourceSplit({ timer: 90, manual: 30, calendar: 10 }), [
    { source: 'manual', label: 'käsin', minutes: 30 }, { source: 'timer', label: 'ajastimella', minutes: 90 }
  ]);
  const byTimer = s6(day(3));
  assert.equal(byTimer.tracking.trackedDays, 4, 'ajastinpäivät lasketaan kirjauspäiviksi kuten käsin kirjatut');
});

// ================================================================ NÄKYMÄ: DOM-tynkä

const USER = { id: 'dddddddd-4444-4444-8444-00000000000d', email: 'sparse@example.com' };
const HTML = read('index.html');
const HTML_IDS = new Set([...HTML.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));

function stubElement(id = null) {
  const listeners = {};
  const attributes = {};
  return {
    id, innerHTML: '', textContent: '', value: '', checked: false, disabled: false, hidden: false,
    style: {}, dataset: {},
    classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
    setAttribute: (k, v) => { attributes[k] = String(v); },
    getAttribute: k => attributes[k] ?? null,
    removeAttribute: k => { delete attributes[k]; },
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
    removeEventListener: () => {},
    dispatch: (type, event = {}) => (listeners[type] || []).map(fn => fn(event)),
    focus() { globalThis.document.activeElement = this; },
    scrollIntoView() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    appendChild: () => {},
    remove: () => {},
    closest: () => null
  };
}

function installDom() {
  const elements = new Map();
  globalThis.document = {
    activeElement: null,
    getElementById(id) {
      if (!HTML_IDS.has(id)) return null;
      if (!elements.has(id)) elements.set(id, stubElement(id));
      return elements.get(id);
    },
    createElement: () => stubElement(),
    querySelectorAll: () => [],
    body: { appendChild: () => {} }
  };
  globalThis.CSS = { escape: value => String(value) };
}

const html = id => globalThis.document.getElementById(id).innerHTML;
const node = id => globalThis.document.getElementById(id);
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };
function clickOn(selector, dataset) {
  const target = { dataset, disabled: false, textContent: '' };
  return { target: { closest: sel => (sel === selector ? target : null), dataset } };
}
/** Siirrä jäädytettyä kelloa: paikallinen päivä ja kellonaika. */
function moveClock(t, isoDate, time = '12:00') {
  const [year, month, dayOfMonth] = isoDate.split('-').map(Number);
  const [hours, minutes] = time.split(':').map(Number);
  t.mock.timers.setTime(new Date(year, month - 1, dayOfMonth, hours, minutes).getTime());
}
/** Näkyvä teksti ilman "Miksi?"-osioita (details). */
const outsideDetails = markup => markup.replace(/<details[\s\S]*?<\/details>/g, '');

beforeEach(() => {
  clearUser();
  clearLocalUserData();
  resetState();
  resetAppliedAdjustments();
  resetDirectionView();
  setUser(USER);
  setClient(fakeClient({ data: [], error: null }));
  installDom();
});

afterEach(() => {
  delete globalThis.document;
  delete globalThis.CSS;
});

/** Omistajan ensimmäinen viikko sovelluksessa: S1 oikeilla toiminnoilla. */
async function ownerFirstWeek(t) {
  freezeLocalDate(t, day(2));
  const work = await createLifeArea({ name: 'Työ', importance: 4, targetMinutesPerWeek: 1200, categoryKey: 'tyo' });
  const fam = await createLifeArea({ name: 'Perhe', importance: 5, targetMinutesPerWeek: 600, categoryKey: 'perhe' });
  await createLifeArea({ name: 'Hyvinvointi', importance: 4, targetMinutesPerWeek: 180, categoryKey: 'hyvinvointi' });
  await saveWeeklyCapacity({ weekStart: WEEK, availableMinutes: 1800 });
  setTasks(ownerTasks({ p0: 60, p1: 90 }));
  moveClock(t, day(3));
  await logTime({ entryDate: day(3), minutes: 45, lifeAreaId: work.area.id });
  moveClock(t, day(4));
  await logTime({ entryDate: day(4), minutes: 90, lifeAreaId: work.area.id });
  await logTime({ entryDate: day(4), minutes: 30, lifeAreaId: fam.area.id, source: 'timer' });
  moveClock(t, day(6), '20:00');
  await logTime({ entryDate: day(6), minutes: 60, lifeAreaId: fam.area.id });
  return { work, fam };
}

test('näkymä: harva viikko -> ilmoitus ENSIMMÄISENÄ havainnoissa (role=status, "Arvioi tehtäviä") ja päivän kortissa', async (t) => {
  await ownerFirstWeek(t);
  initDirection();
  renderDirection();
  const signals = html('dirSignals');
  assert.match(signals.trimStart(), /^<div class="dir-quality-row dir-sparse" role="status">/);
  assert.match(signals, /Suunnan arvio tarkentuu, kun lisäät aika-arvioita\./);
  assert.match(signals, /data-quality-action="estimate">Arvioi tehtäviä<\/button>/);
  assert.doesNotMatch(signals, /jäämässä huomiotta/, 'ei toteumaan perustuvaa huomiotta jäämistä ensimmäisellä viikolla');
  assert.doesNotMatch(html('dirQuality'), /Suunnan arvio tarkentuu/, 'ilmoitus ei toistu laatulistassa');
  // Ilmoituksen toimenpide avaa arvioinnin.
  node('dirSignals').dispatch('click', clickOn('[data-quality-action]', { qualityAction: 'estimate' }));
  assert.equal(node('dirEstimateSection').hidden, false);

  renderTodayDirection();
  const card = html('todayDirection');
  const notice = card.indexOf('Suunnan arvio tarkentuu');
  assert.ok(notice > -1 && notice < card.indexOf('Viikon kapasiteettia jäljellä'), 'ensimmäinen rivi');
  assert.match(card, /data-today-action="open_estimate">Arvioi tehtäviä<\/button>/);
  assert.equal((card.match(/data-today-action="open_estimate"/g) || []).length, 1, 'sama toimenpide ei toistu');
  assert.match(card, /ilman kestoarviota ei ole mukana/);

  // Kaikki arvioitu: ilmoitus katoaa.
  setTasks(ownerTasks(Object.fromEntries(CATEGORIES.map((_, i) => ['p' + i, 30]))));
  renderDirection();
  renderTodayDirection();
  assert.doesNotMatch(html('dirSignals'), /Suunnan arvio tarkentuu/);
  assert.doesNotMatch(html('todayDirection'), /Suunnan arvio tarkentuu/);
});

test('näkymä: ensimmäinen katsaus erottaa tiedetyn, tuntemattoman ja kirjaamattoman', async (t) => {
  await ownerFirstWeek(t);
  renderDirection();
  const review = html('dirReview');
  const known = review.indexOf('<dt>Tiedossa</dt>');
  assert.ok(known > -1 && known < review.indexOf('<h3'), '"Tiedossa"-rivi katsauksen alussa');
  assert.match(review, /<dt>Ei tiedossa<\/dt><dd>10 asiaa ilman kestoarviota, joten kokonaiskuormaa ei tiedetä\.<\/dd>/);
  assert.match(review, /<dt>Ei kirjattu<\/dt><dd>4 päivää ilman kirjauksia — tuntemattomia, eivät nollaa\.<\/dd>/);
  assert.match(review, /kirjattu 3 h 45 min 3 päivänä \(käsin 3 h 15 min, ajastimella 30 min\)/);
  assert.match(review, /Kirjattu 3 h 45 min 3 päivänä \(kirjaukset alkoivat 1\.10\.\)\. Päivät ilman kirjauksia ovat tuntemattomia, eivät nollaa\./);
  assert.doesNotMatch(review, /Suunnitelma mahtui kapasiteettiin\./);
  assert.match(review, /Arvioitu työ \(2 h 30 min\) mahtui kapasiteettiin \(30 h\); 10 asiaa ilman arviota, joten kokonaiskuormaa ei tiedetä\./);

  // Ensimmäistä Suunta-viikkoa ei verrata Suuntaa edeltäneeseen viikkoon.
  assert.match(html('dirReviewCompare'), /Ensimmäinen Suunta-viikko — vertailu alkaa ensi viikolla\./);
  const comparison = compareWithPreviousWeek(WEEK);
  assert.equal(comparison.available, false);

  // Tallennettu katsaus kertoo historiassa, että toteuma oli osittainen.
  const saved = await saveWeeklyReview({ weekStart: WEEK, reflection: 'Ensimmäinen viikko.' });
  assert.equal(saved.ok, true);
  assert.equal(saved.review.snapshot.dataQuality.trackingLevel, TRACKING.PARTIAL);
  assert.equal(saved.review.policyVersion, 3);
  renderDirection();
  assert.match(html('dirReviewHistory'), /kirjauksia vain 3 päivänä/);

  // Toisella viikolla vertailu toimii.
  moveClock(t, addDaysIso(WEEK, 9));
  assert.equal(compareWithPreviousWeek(addDaysIso(WEEK, 7)).available, true);
});

test('näkymä: perusta näkyy havainnon vieressä, luvut suomeksi "Tekniset luvut" -osiossa', async (t) => {
  freezeLocalDate(t, day(0));
  await createLifeArea({ name: 'Työ', importance: 3, targetMinutesPerWeek: 600, categoryKey: 'tyo' });
  await createLifeArea({ name: 'Perhe', importance: 3, targetMinutesPerWeek: 600, categoryKey: 'perhe' });
  setTasks([task('w', day(1), 900, { category: 'tyo' }), task('f', day(2), 100, { category: 'perhe' })]);
  renderDirection();
  const signals = html('dirSignals');
  assert.match(signals, /Työ vie suunnitelmassa enemmän kuin halusit/);
  assert.match(outsideDetails(signals), new RegExp(`<span class="assist-tag dir-basis">${BASIS_LABELS.planned}</span>`));
  assert.match(signals, /<summary>Tekniset luvut<\/summary>/);
  assert.match(signals, /Toivottu osuus \(%\): 50/);
  assert.match(signals, /perusta: suunnitelman perusteella/);
  assert.doesNotMatch(signals, /desiredPercent:|perusta: planned/, 'ei englanninkielisiä avaimia');
  renderTodayDirection();
  assert.match(outsideDetails(html('todayDirection')), /suunnitelman perusteella/);
});

test('näkymä: valmiiksi merkityt ilman kestoa ovat tieto, eivät "Arvioi"-kehotus (suunta-day1-flow F5)', async (t) => {
  freezeLocalDate(t, day(3));
  await createLifeArea({ name: 'Työ', importance: 3, targetMinutesPerWeek: 600, categoryKey: 'tyo' });
  await saveWeeklyCapacity({ weekStart: WEEK, availableMinutes: 1200 });
  setTasks([
    task('d1', day(0), null, { category: 'tyo', completed: true }), task('d2', day(1), null, { category: 'tyo', completed: true }),
    task('d3', day(2), null, { category: 'tyo', completed: true }), task('o1', day(3), 60, { category: 'tyo' })
  ]);
  const analysis = analyzeCurrentWeek(WEEK);
  assert.equal(analysis.planned.unknownCount, 3);
  assert.equal(analysis.planned.openUnknownCount, 0);
  assert.equal(analysis.dataQuality.reasons.includes('unestimated_work'), false);
  const issues = qualityIssues(analysis);
  assert.equal(issues.some(i => i.action === 'estimate'), false);
  assert.match(issues.find(i => i.code === 'unestimated_completed').text, /^3 valmiiksi merkittyä ilman arviota \(ei lasketa kuormaan\)\.$/);
  renderDirection();
  renderTodayDirection();
  assert.doesNotMatch(html('dirQuality') + html('dirSignals'), /Arvioi tehtäviä/);
  assert.doesNotMatch(html('todayDirection'), /open_estimate/);
  assert.match(html('dirWeekSummary'), /3 valmiiksi merkittyä ilman arviota/);
  assert.doesNotMatch(html('dirWeekSummary'), /asiaa ilman kestoarviota — niitä ei ole laskettu/);
});

// ================================================================ ERR-04: vajaa lataus

test('ERR-04: katsausta ei tallenneta vajaista luvuista; pohdinta säilyy ja syy kerrotaan', async (t) => {
  freezeLocalDate(t, day(6));
  await createLifeArea({ name: 'Perhe', importance: 5, targetMinutesPerWeek: 600 });
  setDomainLoadStatus('timeEntries', false, new Error('verkko'));
  assert.deepEqual(analysisLoadProblems(), ['timeEntries']);
  const insert = alignmentReviewsRepo.insert;
  let writes = 0;
  alignmentReviewsRepo.insert = async (...args) => { writes += 1; return insert(...args); };
  try {
    const result = await saveWeeklyReview({ weekStart: WEEK, reflection: 'Kesken' });
    assert.deepEqual({ ok: result.ok, code: result.code }, { ok: false, code: 'incomplete_data' });
    assert.equal(getState().alignmentReviews.length, 0);
    assert.equal(writes, 0, 'mitään ei kirjoitettu');

    initDirection();
    node('dirReflection').value = 'Pohdintani';
    node('dirReviewSave').dispatch('click');
    await flush();
    assert.equal(node('dirReviewStatus').textContent,
      'Kaikkia tietoja ei saatu ladattua, joten katsausta ei tallennettu vajailla luvuilla. '
      + 'Pohdintasi on yhä kentässä – päivitä, kun yhteys toimii.');
    assert.equal(node('dirReflection').value, 'Pohdintani');
    assert.equal(writes, 0);
  } finally {
    alignmentReviewsRepo.insert = insert;
  }
});

test('ERR-04: havainnot ja ehdotukset korvataan ilmoituksella, kun jokin analyysin syöte puuttuu', async (t) => {
  freezeLocalDate(t, day(3));
  await createLifeArea({ name: 'Perhe', importance: 5, targetMinutesPerWeek: 600 });
  for (const domain of ['timeEntries', 'tasks']) {
    setDomainLoadStatus('timeEntries', true);
    setDomainLoadStatus('tasks', true);
    setDomainLoadStatus(domain, false, new Error('verkko'));
    renderDirection();
    assert.match(html('dirSignals'), /Kaikkia tietoja ei saatu ladattua/, domain);
    assert.doesNotMatch(html('dirSignals'), /suunnitelmassa vähän aikaa|jäämässä huomiotta/, domain);
    assert.match(html('dirProposals'), /Kaikkia tietoja ei saatu ladattua/, domain);
    assert.equal(html('dirQuality'), '', domain);
    renderTodayDirection();
    assert.match(html('todayDirection'), /havaintoja ei näytetä vajailla luvuilla/, domain);
    assert.doesNotMatch(html('todayDirection'), /Tänään kannattaa huomata/, domain);
  }
  setDomainLoadStatus('tasks', true);
  renderDirection();
  assert.doesNotMatch(html('dirSignals'), /Kaikkia tietoja ei saatu ladattua/, 'lataus onnistui: havainnot palaavat');
});

// ================================================================ ERR-12: muutosehdotuksen virheet

/** Viikko, jonka lopulla Perheen tavoitteen muutos ehdotetaan (vakiintunut kirjaus). */
async function changeTargetWeek(t) {
  freezeLocalDate(t, day(0));
  const fam = await createLifeArea({ name: 'Perhe', importance: 5, targetMinutesPerWeek: 600 });
  const work = await createLifeArea({ name: 'Työ', importance: 3, targetMinutesPerWeek: 1200 });
  for (const i of [0, 1, 2, 3]) await logTime({ entryDate: day(i), minutes: 200, lifeAreaId: work.area.id });
  await logTime({ entryDate: day(0), minutes: 60, lifeAreaId: fam.area.id });
  moveClock(t, day(6), '20:00');
  return fam.area;
}

test('ERR-12: arvoalueen ylitys näkyy kentän vieressä, eikä mitään kysytä tai muuteta', async (t) => {
  const fam = await changeTargetWeek(t);
  initDirection();
  renderDirection();
  const change = currentProposals(analyzeCurrentWeek(WEEK)).find(p => p.type === ADJUSTMENT.CHANGE_TARGET && p.payload.areaId === fam.id);
  assert.ok(change, 'tavoitteen muutosehdotus');
  let typed = '200';
  node('dirProposals').querySelector = selector => (selector.includes('data-adjust-value') ? { value: typed } : null);

  node('dirProposals').dispatch('click', clickOn('[data-adjust]', { adjust: change.id }));
  await flush();
  const markup = html('dirProposals');
  assert.match(markup, /role="alert"[^>]*>Viikon aikatavoite on 0–168 tuntia\.<\/p>/);
  assert.match(markup, /aria-invalid="true" aria-describedby="dirAdjErr-/);
  assert.match(markup, /value="200"/, 'kirjoitettu arvo säilyy');
  assert.equal(getState().lifeAreas.find(a => a.id === fam.id).targetMinutesPerWeek, 600, 'tavoite ennallaan');

  typed = '';
  node('dirProposals').dispatch('click', clickOn('[data-adjust]', { adjust: change.id }));
  await flush();
  assert.match(html('dirProposals'), /Anna tunnit, esim\. 5 tai 2,5\./);
  assert.equal(getState().lifeAreas.find(a => a.id === fam.id).targetMinutesPerWeek, 600);
});

test('ERR-12: sovelluskerros palauttaa validointivirheet; ryhmä pysähtyy ennen vahvistusta ja nimeää virheen', async (t) => {
  const fam = await changeTargetWeek(t);
  const change = { id: 'change_target:x', type: ADJUSTMENT.CHANGE_TARGET, label: 'Perhe: muuta tavoitetta',
    payload: { areaId: fam.id, from: 600, to: 300 } };
  const never = async () => { throw new Error('ei saa kysyä kelvottomasta arvosta'); };
  const single = await applyAdjustment(change, { confirmFn: never, overrides: { to: 200 * 60 } });
  assert.equal(single.ok, false);
  assert.match(single.errors.targetMinutesPerWeek, /0–168/);
  const capacityChange = { id: 'set_capacity:x', type: ADJUSTMENT.SET_CAPACITY, label: 'Kapasiteetti',
    payload: { weekStart: AFTER, availableMinutes: 1800 } };
  const group = await applySelectedAdjustments([change, capacityChange], {
    confirmFn: never, overrides: { [capacityChange.id]: { availableMinutes: 999 * 60 } }
  });
  assert.equal(group.ok, false);
  assert.deepEqual(group.invalid.map(entry => entry.label), ['Kapasiteetti']);
  assert.match(group.invalid[0].errors.availableMinutes, /0–168/);
  assert.equal(getState().weeklyCapacities.length, 0, 'mitään ei tehty');
});
