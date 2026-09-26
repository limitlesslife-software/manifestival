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

// ================================================================ S2: vähän kirjattua joka päivä

/**
 * S2 (auditointi): alueet ja kapasiteetti 30 h maanantaina; käyttäjä
 * kirjaa joka päivä 70 min työlle eikä mitään muuta. Viikossa 8 h 10 min
 * eli noin 27 % kapasiteetista: kirjaamaton aika on tuntematon, joten
 * muista alueista ei väitetä mitään. Sääntöversio 3:n ensimmäinen muoto
 * (kirjattu osuus 25 %) teki torstaista alkaen Perheestä ja
 * Hyvinvoinnista "jäämässä huomiotta".
 */
function s2(todayIso, nowMinutes = 20 * 60) {
  const all = [0, 1, 2, 3, 4, 5, 6].map(i => entry('s2-' + i, day(i), 70, { lifeAreaId: 'work' }));
  return analyzeWeek({
    weekStart: WEEK, todayIso, nowMinutes, areas: areasCreated(day(0)), capacity: capacity(1800),
    timeEntries: all.filter(e => e.entryDate <= todayIso)
  });
}

test('S2 päivätaulukko: 70 min päivässä 30 h kapasiteetilla -> ei yhtään huomiotta jäämisen väitettä millään päivällä', () => {
  for (let i = 0; i <= 7; i++) {
    const todayIso = i === 7 ? AFTER : day(i);
    const label = i === 7 ? 'katsaus' : DAY_NAMES[i];
    const analysis = s2(todayIso, i === 7 ? 0 : 20 * 60);
    assert.notEqual(analysis.tracking.level, TRACKING.ESTABLISHED, `${label}: seuranta`);
    const neglect = signalsOf(analysis, SIGNAL.NEGLECT);
    assert.equal(neglect.filter(loud).length, 0, `${label}: ${neglect.map(s => s.severity).join(',')}`);
    assert.ok(neglect.every(s => s.basis === 'planned'), `${label}: ei toteumaan perustuvaa huomiotta jäämistä`);
    assert.equal(signalsOf(analysis, SIGNAL.MISALIGNMENT).some(s => s.basis === 'actual'), false, label);
  }
  const thu = s2(day(3));
  assert.deepEqual([thu.tracking.reason, thu.tracking.referenceBasis, thu.tracking.loggedSharePercent], ['share', 'capacity', 28]);
  assert.equal(qualityIssues(thu).find(i => i.code === 'partial_actual').text,
    'Kirjattu aika kattaa vasta noin 28 % arvioimastasi ajasta, joten toteumaa ei vielä verrata tavoitteisiin. '
    + 'Kirjaamaton aika on tuntematon, ei nolla.');
  const proposals = proposeAdjustments(s2(AFTER, 0), { areas: areasCreated(day(0)) });
  assert.equal(proposals.some(p => p.type === ADJUSTMENT.CHANGE_TARGET), false);
  assert.equal(proposals.find(p => p.type === ADJUSTMENT.SET_CAPACITY).reason, null, 'kapasiteettia ei kyseenalaisteta');
});

test('ilman kapasiteettia: 2 x 10 min ei ole vakiintunut; 4 x 10 min katsauksessa ei "Vahva" eikä tavoitteen muutosta', () => {
  const areas = areasCreated(day(0));
  const two = analyzeWeek({ weekStart: WEEK, todayIso: day(3), nowMinutes: 20 * 60, areas,
    timeEntries: [entry('a', day(0), 10, { lifeAreaId: 'work' }), entry('b', day(1), 10, { lifeAreaId: 'work' })] });
  assert.notEqual(two.tracking.level, TRACKING.ESTABLISHED);
  assert.equal(two.tracking.referenceBasis, 'targets', 'viite on tavoitteiden summa');
  assert.equal(signalsOf(two, SIGNAL.NEGLECT).filter(loud).length, 0);

  const review = analyzeWeek({ weekStart: WEEK, todayIso: AFTER, areas,
    timeEntries: [0, 1, 2, 3].map(i => entry('w' + i, day(i), 10, { lifeAreaId: 'work' })) });
  assert.notEqual(review.tracking.level, TRACKING.ESTABLISHED);
  assert.equal(review.signals.some(s => s.severity === SEVERITY.STRONG), false, 'ei "Vahva"');
  assert.equal(proposeAdjustments(review, { areas }).some(p => p.type === ADJUSTMENT.CHANGE_TARGET), false);

  // Ei kapasiteettia, tavoitteita eikä arvioitua suunnitelmaa: kirjattua aikaa ei voi suhteuttaa mihinkään.
  const bareAreas = [area('free', 'Vapaa', 3, null, null, day(0))];
  const bare = analyzeWeek({ weekStart: WEEK, todayIso: day(3), nowMinutes: 20 * 60, areas: bareAreas,
    timeEntries: [entry('a', day(0), 300, { lifeAreaId: 'free' }), entry('b', day(1), 300, { lifeAreaId: 'free' })] });
  assert.deepEqual([bare.tracking.level, bare.tracking.reason], [TRACKING.PARTIAL, 'no_reference']);
  const issue = qualityIssues(bare).find(i => i.code === 'partial_actual');
  assert.match(issue.text, /^Kirjattua aikaa ei voi vielä suhteuttaa mihinkään/);
  assert.equal(issue.action, null, 'lisäkirjaus ei auta ilman viitettä');
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
  // Muutettu: 150 min päivässä (ennen 100). Kirjattu osuus on puolet
  // kapasiteetista x jakson osuus: 4 x 100 = 400 < 50 % x 30 h x 4/7.
  const timeEntries = [3, 4, 5, 6].map(i => entry('w' + i, day(i), 150, { lifeAreaId: 'work' }));
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
  assert.match(explainSignal(fam, areas).text, /Perhe: kirjattu 0 min, .*\(viikon tavoite 10 h, vertailu 1\.10\. alkaen\)\./);
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
  // Muutettu: käyttäjän kapasiteetti 5 h on kirjatun ajan viite (ilman sitä
  // viite olisi tavoitteiden summa, eikä 160 min riittäisi vakiintuneeksi).
  const areas = [area('fam', 'Perhe', 5, 600, 'perhe'), area('work', 'Työ', 3, 600, 'tyo')];
  const analysis = analyzeWeek({
    weekStart: WEEK, todayIso: AFTER, areas, capacity: capacity(300),
    timeEntries: [0, 1, 2, 3].map(i => entry('f' + i, day(i), 40, { lifeAreaId: 'fam' }))
  });
  assert.equal(analysis.tracking.level, TRACKING.ESTABLISHED);
  assert.ok(signalsOf(analysis, SIGNAL.NEGLECT).some(s => s.areaId === 'fam' && s.basis === 'actual'));
  assert.equal(signalsOf(analysis, SIGNAL.MISALIGNMENT).some(s => s.areaId === 'fam'), false);
});

// ================================================================ ARVIOIDEN KATTAVUUS (F3, F4)

/**
 * Sama 12 tehtävän viikko, arvioituna `count` kappaletta (ensin työ, sitten perhe).
 *
 * `unknownInAreas`: arvioimattomat kuuluvat työlle ja perheelle (omistajan
 * tilanne). Oletuksena ne ovat liittämättömiä ('muu'): alue, jonka avoimelta
 * työltä puuttuu kesto, ei saa osuusväitettä lainkaan (tuntematon ei ole
 * nolla), joten kattavuuskynnykset testataan alueilla, joiden työ on arvioitu.
 * Arvioitujen minuutit ja siten osuudet ovat samat kummassakin muodossa.
 */
function ladder(count, { unknownInAreas = false } = {}) {
  const order = ['t0', 't1', 't8', 't2', 't3', 't4', 't9', 't5', 't6', 't10', 't7', 't11'];
  const estimated = new Set(order.slice(0, count));
  const tasks = Array.from({ length: 12 }, (_, i) => {
    const id = 't' + i;
    const areaCategory = i < 8 ? 'tyo' : 'perhe';
    const known = estimated.has(id);
    const category = known || unknownInAreas ? areaCategory : 'muu';
    return task(id, day(i % 5), known ? 120 : null, { category });
  });
  const areas = [area('work', 'Työ', 3, 600, 'tyo'), area('fam', 'Perhe', 3, 600, 'perhe')];
  return { areas, analysis: analyzeWeek({ weekStart: WEEK, todayIso: day(1), areas, tasks, capacity: capacity(2400) }) };
}

test('suunnitelman jakauma: alue, jonka avoimelta työltä puuttuu kesto, ei saa osuusväitettä millään kattavuudella', () => {
  for (const count of [2, 6, 8, 10]) {
    const { areas, analysis } = ladder(count, { unknownInAreas: true });
    assert.equal(signalsOf(analysis, SIGNAL.MISALIGNMENT).length, 0, `${count}/12 arvioitu`);
    const proposals = proposeAdjustments(analysis, { areas });
    assert.equal(proposals.some(p => p.type === ADJUSTMENT.CHANGE_TARGET), false, `${count}/12: ei tavoitteen muutosta`);
  }
});

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
  // Muutettu: 150 min päivässä (ennen 100). Alle puolet kapasiteetista
  // kirjannut viikko ei ole vakiintunut: se kertoo kirjaamisesta, ei
  // kapasiteetista, joten kapasiteettikysymystä ei siitä synny.
  const analysis = analyzeWeek({
    weekStart: WEEK, todayIso: AFTER, areas, capacity: capacity(1800),
    timeEntries: [0, 1, 2, 3, 4, 5, 6].map(i => entry('w' + i, day(i), 150, { lifeAreaId: 'work' }))
  });
  assert.equal(analysis.tracking.level, TRACKING.ESTABLISHED);
  const setCapacity = proposeAdjustments(analysis, { areas }).find(p => p.type === ADJUSTMENT.SET_CAPACITY);
  assert.equal(setCapacity.reason.kind, 'capacity_deviation');
  assert.equal(setCapacity.payload.availableMinutes, 1050);
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

test('seurannan kypsyys: kynnykset ja rajat (viite on käyttäjän oma luku)', () => {
  const dates = Array.from({ length: 7 }, (_, i) => day(i));
  const actualOf = (days, minutes) => {
    const minutesByDate = new Map(days.map(d => [d, minutes]));
    return { entryCount: days.length, entryDates: days, minutesByDate, firstEverEntryDate: days[0] || null };
  };
  const thursday = weekProgress(WEEK, day(3));
  // Muutettu (lukitsi vanhan käytöksen): ennen "established", koska ilman
  // kapasiteettia kirjattua osuutta ei tarkistettu lainkaan — kaksi
  // kirjausta riitti. Nyt ilman mitään viitettä (ei kapasiteettia,
  // tavoitteita eikä arvioitua suunnitelmaa) taso on enintään "partial".
  const two = trackingMaturity({ dates, progress: thursday, actual: actualOf([day(0), day(1)], 60), todayIso: day(3) });
  assert.equal(two.level, TRACKING.PARTIAL, 'kaksi päivää kolmesta, ei viitettä');
  assert.equal(two.reason, 'no_reference');
  assert.equal(two.referenceBasis, null);
  // Tavoitteiden summa on viite, kun kapasiteettia ei ole: 120 / (600 x 3/7) = 47 % < 50 %.
  const targetsLow = trackingMaturity({ dates, progress: thursday, actual: actualOf([day(0), day(1)], 60),
    todayIso: day(3), targetsMinutes: 600 });
  assert.deepEqual([targetsLow.level, targetsLow.reason, targetsLow.referenceBasis, targetsLow.loggedSharePercent],
    [TRACKING.PARTIAL, 'share', 'targets', 47]);
  const targetsOk = trackingMaturity({ dates, progress: thursday, actual: actualOf([day(0), day(1)], 60),
    todayIso: day(3), targetsMinutes: 420 });
  assert.equal(targetsOk.level, TRACKING.ESTABLISHED, '120 / (420 x 3/7) = 67 %');
  // Ilman kapasiteettia ja tavoitteita: jakson päiville päivätty arvioitu työ tähän päivään asti.
  const plannedRef = trackingMaturity({ dates, progress: thursday, actual: actualOf([day(0), day(1)], 60),
    todayIso: day(3), plannedMinutesByDate: new Map([[day(0), 120], [day(2), 60], [day(5), 600]]) });
  assert.deepEqual([plannedRef.level, plannedRef.referenceBasis, plannedRef.referenceMinutes],
    [TRACKING.ESTABLISHED, 'planned', 180], 'lauantain 600 min ei ole vielä viitettä');
  const one = trackingMaturity({ dates, progress: thursday, actual: actualOf([day(0)], 600), todayIso: day(3) });
  assert.equal(one.level, TRACKING.EARLY, 'yksi päivä ei riitä minuuteista riippumatta');
  const low = trackingMaturity({ dates, progress: thursday, actual: actualOf([day(0), day(1)], 60),
    capacity: capacity(3000), targetsMinutes: 420, todayIso: day(3) });
  assert.equal(low.level, TRACKING.PARTIAL, '120 min < 50 % x 50 h x 3/7 (kapasiteetti ennen tavoitteita)');
  assert.equal(low.referenceBasis, 'capacity');
  assert.equal(low.loggedSharePercent, 9);
  const after = weekProgress(WEEK, AFTER);
  const sparseDays = trackingMaturity({ dates, progress: after, actual: actualOf([day(0), day(2), day(4)], 300),
    targetsMinutes: 600, todayIso: AFTER });
  assert.equal(sparseDays.level, TRACKING.PARTIAL, '3 päivää 7:stä < puolet');
  assert.equal(sparseDays.reason, 'days');
  assert.equal(POLICY_VERSION, 3);
});

test('seurannan kypsyys: hystereesi — kerran vakiintunut pysyy viikon, ellei päiväkattavuus petä', () => {
  const dates = Array.from({ length: 7 }, (_, i) => day(i));
  const actualOf = entries => {
    const minutesByDate = new Map(entries);
    const days = entries.map(([d]) => d);
    return { entryCount: days.length, entryDates: days, minutesByDate, firstEverEntryDate: days[0] || null };
  };
  // Kapasiteetti 40 h, kirjaukset ma–ke 200 min: keskiviikon lopussa
  // 600 / (2400 x 3/7) = 58 % -> vakiintunut. Torstaina ei kirjata.
  const logged = [[day(0), 200], [day(1), 200], [day(2), 200]];
  const fridayMorning = weekProgress(WEEK, day(4), 8 * 60);
  const held = trackingMaturity({ dates, progress: fridayMorning, actual: actualOf(logged), capacity: capacity(2400), todayIso: day(4) });
  // Perjantaiaamuna ilman hystereesiä 600 / (2400 x 4,33/7) = 40 % < 50 % -> taso putoaisi.
  assert.equal(held.level, TRACKING.ESTABLISHED);
  assert.equal(held.held, true);
  assert.equal(held.establishedSince, day(2));
  assert.equal(held.loggedSharePercent, 40, 'nykyinen osuus näkyy yhä rehellisesti');
  // Päiväkattavuus pettää viikon jälkeen: 3 kirjauspäivää 7:stä < puolet.
  const after = trackingMaturity({ dates, progress: weekProgress(WEEK, AFTER), actual: actualOf(logged), capacity: capacity(2400), todayIso: AFTER });
  assert.equal(after.level, TRACKING.PARTIAL);
  assert.equal(after.reason, 'days');
  assert.equal(after.held, false);
  // Ei aiempaa vakiintumista (180 / 600 = 30 % keskiviikon lopussa): ei hystereesiä.
  const never = trackingMaturity({ dates, progress: fridayMorning, actual: actualOf([[day(0), 60], [day(1), 60], [day(2), 60]]),
    capacity: capacity(1400), todayIso: day(4) });
  assert.equal(never.level, TRACKING.PARTIAL);
  assert.equal(never.establishedSince, null);
});

test('F13: kirjattu aika lähteittäin näyttöä varten; ajastin ja käsin ovat seurannassa samanarvoisia', () => {
  assert.deepEqual(timeSourceSplit({ timer: 90, manual: 30, calendar: 10 }), [
    { source: 'manual', label: 'käsin', minutes: 30 }, { source: 'timer', label: 'ajastimella', minutes: 90 }
  ]);
  const byTimer = s6(day(3));
  assert.equal(byTimer.tracking.trackedDays, 4, 'ajastinpäivät lasketaan kirjauspäiviksi kuten käsin kirjatut');
});

test('osittaisen kirjauksen syy sanotaan: "vain N päivänä ikkunan M päivästä" ei ole sama kuin "vasta X %"', () => {
  const areas = areasCreated(day(0));
  // Kolme isoa kirjauspäivää seitsemästä: minuutteja riittää, päiviä ei.
  const fewDays = analyzeWeek({ weekStart: WEEK, todayIso: AFTER, areas, capacity: capacity(1800),
    timeEntries: [0, 2, 4].map(i => entry('d' + i, day(i), 400, { lifeAreaId: 'work' })) });
  assert.deepEqual([fewDays.tracking.level, fewDays.tracking.reason], [TRACKING.PARTIAL, 'days']);
  assert.equal(qualityIssues(fewDays).find(i => i.code === 'partial_actual').text,
    'Aikaa on kirjattu vain 3 päivänä ikkunan 7 päivästä, joten toteumaa ei vielä verrata tavoitteisiin. '
    + 'Kirjaamattomat päivät ovat tuntemattomia, eivät nollaa.');
  // S1: päiviä riittää (3/4), minuutteja ei suhteessa kapasiteettiin.
  const fewHours = s1(AFTER, 0);
  assert.equal(fewHours.tracking.reason, 'share');
  assert.match(qualityIssues(fewHours).find(i => i.code === 'partial_actual').text,
    /^Kirjattu aika kattaa vasta noin 22 % arvioimastasi ajasta, joten toteumaa ei vielä verrata tavoitteisiin\./);
  // Kirjaukset ennen alueiden luontia eivät kuulu ikkunaan: ei "vain 0 päivänä".
  const beforeAreas = analyzeWeek({ weekStart: WEEK, todayIso: day(6), nowMinutes: 20 * 60, areas: areasCreated(day(2)),
    capacity: capacity(1800), timeEntries: [entry('m', day(0), 300), entry('t', day(1), 300)] });
  assert.equal(qualityIssues(beforeAreas).find(i => i.code === 'partial_actual').text,
    'Ikkunan 5 päivältä ei ole vielä kirjauksia, joten toteumaa ei vielä verrata tavoitteisiin.');
});

// ================================================================ ALUEEN ALKU, TAVOITTEEN ALARAJA, ARVIOIMATON ALUE

test('toteuman jakauma: lauantaina luotu alue ei ole vertailussa eikä vääristä muiden toivottua osuutta', () => {
  const areas = [area('work', 'Työ', 3, 1200, 'tyo', day(0)), area('fam', 'Perhe', 3, 600, 'perhe', day(0)),
    area('hobby', 'Harrastus', 3, 600, 'harrastus', day(5))];
  const logged = (work, fam) => [0, 1, 2, 3, 4].flatMap(i => [
    entry('w' + i, day(i), work, { lifeAreaId: 'work' }), entry('f' + i, day(i), fam, { lifeAreaId: 'fam' })]);
  // Työ ja perhe 2:1 kuten tavoitteissa. Ennen: harrastuksen tavoite oli
  // mukana toiveessa -> "Harrastus saa vähemmän" (Vahva) ja "Työ vie enemmän".
  const even = analyzeWeek({ weekStart: WEEK, todayIso: AFTER, areas, capacity: capacity(1800), timeEntries: logged(160, 80) });
  assert.equal(even.tracking.level, TRACKING.ESTABLISHED);
  assert.equal(even.tracking.windowStart, day(0));
  assert.deepEqual(signalsOf(even, SIGNAL.MISALIGNMENT), []);
  // Todellinen poikkeama vertailluissa alueissa näkyy yhä, ja luvut kertovat rajauksen.
  const skewed = analyzeWeek({ weekStart: WEEK, todayIso: AFTER, areas, capacity: capacity(1800), timeEntries: logged(200, 40) });
  const work = signalsOf(skewed, SIGNAL.MISALIGNMENT).find(s => s.areaId === 'work');
  assert.deepEqual([work.metrics.desiredPercent, work.metrics.actualPercent, work.metrics.excludedAreaCount], [67, 83, 1]);
  assert.equal(signalsOf(skewed, SIGNAL.MISALIGNMENT).some(s => s.areaId === 'hobby'), false);
  assert.match(explainSignal(work, areas).why,
    /Vertailusta puuttuu 1 kesken jakson luotu alue: sen aiemmat päivät ovat tuntemattomia/);
  const change = proposeAdjustments(skewed, { areas })
    .find(p => p.type === ADJUSTMENT.CHANGE_TARGET && p.payload.areaId === 'work');
  assert.equal(change.payload.to, 1500, '83 % vertailtujen alueiden tavoitteista (30 h), ei kaikkien (40 h)');
});

test('tavoitteen muutosta ei esitäytetä alle 30 minuutin (poikkeaman haara)', () => {
  const areas = [area('work', 'Työ', 3, 600, 'tyo', day(0)), area('side', 'Sivu', 3, 600, null, day(0))];
  const analysis = analyzeWeek({ weekStart: WEEK, todayIso: AFTER, areas,
    timeEntries: [...[0, 1, 2, 3, 4].map(i => entry('w' + i, day(i), 150, { lifeAreaId: 'work' })),
      entry('s', day(0), 5, { lifeAreaId: 'side' })] });
  const side = signalsOf(analysis, SIGNAL.MISALIGNMENT).find(s => s.areaId === 'side');
  assert.equal(side.metrics.direction, 'under');
  assert.equal(side.severity, SEVERITY.STRONG);
  const changes = proposeAdjustments(analysis, { areas }).filter(p => p.type === ADJUSTMENT.CHANGE_TARGET);
  assert.equal(changes.some(p => p.payload.areaId === 'side'), false, 'ennen: tavoitteeksi 15 min');
  assert.ok(changes.some(p => p.payload.areaId === 'work'), 'yli-poikkeamasta ehdotetaan yhä');
});

test('yksikään tavoitteen muutosehdotus ei esitäytä alle 30 min (satunnaiset viikot, kiinteä siemen)', () => {
  let seed = 20261004;
  const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const pick = list => list[Math.floor(random() * list.length)];
  let changes = 0;
  for (let round = 0; round < 300; round++) {
    const areas = ['tyo', 'perhe', 'hyvinvointi', 'harrastus'].slice(0, 2 + Math.floor(random() * 3))
      .map((key, i) => area('a' + i, 'Alue ' + i, 1 + Math.floor(random() * 5),
        pick([null, 0, 30, 60, 300, 600, 1200]), key, pick([null, day(0), day(3), day(5)])));
    const todayIso = pick([day(3), day(5), AFTER, AFTER]);
    const timeEntries = [];
    for (let d = 0; d < 7; d++) {
      for (const a of areas) {
        if (random() < 0.6) timeEntries.push(entry(`e${d}${a.id}`, day(d), pick([5, 10, 30, 90, 240]), { lifeAreaId: a.id }));
      }
    }
    const tasks = Array.from({ length: Math.floor(random() * 8) }, (_, i) =>
      task('t' + i, day(Math.floor(random() * 7)), pick([null, 15, 60, 180]), { category: pick(['tyo', 'perhe', 'hyvinvointi', 'harrastus']) }));
    const analysis = analyzeWeek({ weekStart: WEEK, todayIso, areas, tasks,
      timeEntries: timeEntries.filter(e => e.entryDate <= todayIso), capacity: pick([null, capacity(600), capacity(1800)]) });
    for (const proposal of proposeAdjustments(analysis, { areas }).filter(p => p.type === ADJUSTMENT.CHANGE_TARGET)) {
      changes += 1;
      assert.ok(proposal.payload.to >= TIME_RULES.NEGLECT_MIN_TARGET_MINUTES, `kierros ${round}: ${proposal.id} -> ${proposal.payload.to}`);
    }
  }
  assert.ok(changes > 20, `aineisto tuottaa tavoitteen muutoksia (${changes})`);
});

test('suunnitelman jakauma: korkea kattavuus, mutta tärkeän alueen avoimelta asialta puuttuu kesto -> ei osuusväitettä eikä tavoitteen muutosta', () => {
  const areas = [area('work', 'Työ', 3, 600, 'tyo'), area('fam', 'Perhe', 5, 600, 'perhe')];
  const tasks = [...Array.from({ length: 9 }, (_, i) => task('w' + i, day(i % 5), 60, { category: 'tyo' })),
    task('f1', day(3), null, { category: 'perhe' })];
  const analysis = analyzeWeek({ weekStart: WEEK, todayIso: day(1), areas, tasks, capacity: capacity(2400) });
  assert.equal(analysis.dataQuality.estimateCoveragePercent, 90);
  assert.equal(signalsOf(analysis, SIGNAL.MISALIGNMENT).some(s => s.areaId === 'fam'), false, 'ennen: "Perhe saa vähemmän" (Huomio)');
  assert.equal(signalsOf(analysis, SIGNAL.NEGLECT).find(s => s.areaId === 'fam').rule, 'neglect.plan_unknown');
  const proposals = proposeAdjustments(analysis, { areas });
  assert.equal(proposals.some(p => p.type === ADJUSTMENT.CHANGE_TARGET && p.payload.areaId === 'fam'), false);
  // Työn osuus on arvioidusta työstä, ja se näkyy yhä.
  assert.equal(signalsOf(analysis, SIGNAL.MISALIGNMENT).find(s => s.areaId === 'work').metrics.direction, 'over');
});

test('plan_unknown perustuu avoimiin asioihin: valmiiksi merkitty ilman kestoa on tieto', () => {
  const areas = [area('fam', 'Perhe', 5, 600, 'perhe')];
  const completed = analyzeWeek({ weekStart: WEEK, todayIso: day(3), areas,
    tasks: [task('f1', day(0), null, { category: 'perhe', completed: true }), task('f2', day(1), 60, { category: 'perhe' })] });
  const fam = signalsOf(completed, SIGNAL.NEGLECT).find(s => s.areaId === 'fam');
  assert.equal(fam.rule, 'neglect.plan_below_target', 'ennen: plan_unknown valmiista asiasta');
  assert.deepEqual([fam.metrics.unknownCount, fam.metrics.openUnknownCount], [1, 0]);
  assert.equal(explainSignal(fam, areas).text,
    'Tämän viikon suunnitelmassa Perhe saa 1 h, tavoitteesi on 10 h. Tiedoksi: 1 valmiiksi merkitty ilman kestoa ei ole mukana.');
  const open = analyzeWeek({ weekStart: WEEK, todayIso: day(3), areas,
    tasks: [task('f1', day(0), null, { category: 'perhe' }), task('f2', day(1), 60, { category: 'perhe' })] });
  const openSignal = signalsOf(open, SIGNAL.NEGLECT).find(s => s.areaId === 'fam');
  assert.equal(openSignal.rule, 'neglect.plan_unknown');
  assert.match(explainSignal(openSignal, areas).text, /Riittääkö aika, selviää, kun asiat on arvioitu\.$/);
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
  // Muutettu: alueet, joiden suunnitelmasta puuttuu kesto (plan_unknown),
  // ovat "Ei tiedossa" -rivillä — eivät "Mikä jäi huomiotta?" -vastauksessa.
  assert.match(review, /<dt>Ei tiedossa<\/dt><dd>10 asiaa ilman kestoarviota, joten kokonaiskuormaa ei tiedetä\. 3 alueen suunnitelmasta puuttuu kesto \(Perhe, Työ, Hyvinvointi\)\.<\/dd>/);
  assert.match(review, /<dt>Mikä jäi huomiotta\?<\/dt><dd>Yksikään tärkeä alue ei jäänyt selvästi vajaaksi sen perusteella, mitä on tiedossa\.<\/dd>/);
  assert.doesNotMatch(review, /suunnitelman aika ei ole vielä tiedossa/, 'plan_unknown ei ole huomiotta jäänyt alue');
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
  // Muutettu: syy sanotaan. Päiviä oli jaksoon nähden riittävästi (3/4),
  // kirjattua aikaa ei (22 % kapasiteetista); ennen "(kirjauksia vain 3 päivänä)".
  assert.equal(saved.review.snapshot.dataQuality.trackingReason, 'share');
  assert.match(html('dirReviewHistory'), /\(toteumaa ei verrattu: vähän kirjattua aikaa\)/);

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

test('näkymä: "Mikä jäi huomiotta?" vain todetuista vajeista; kesto puuttuu -> "Ei tiedossa"; luvut "Arvioitu"', async (t) => {
  await changeTargetWeek(t);
  // Sunnuntaina luotu alue, jonka ainoalta asialta puuttuu kesto: plan_unknown.
  await createLifeArea({ name: 'Hyvinvointi', importance: 4, targetMinutesPerWeek: 180, categoryKey: 'hyvinvointi' });
  setTasks([task('h1', day(6), null, { category: 'hyvinvointi' })]);
  renderDirection();
  const review = html('dirReview');
  const missed = review.match(/<dt>Mikä jäi huomiotta\?<\/dt><dd>([^<]*)<\/dd>/)[1];
  assert.match(missed, /^Perhe: kirjattu 1 h, /, 'todettu vaje');
  assert.doesNotMatch(missed, /Hyvinvointi|ei vielä tiedossa/, 'arvioimaton ei ole huomiotta jäänyt');
  assert.match(review, /<dt>Ei tiedossa<\/dt><dd>1 asia ilman kestoarviota, joten kokonaiskuormaa ei tiedetä\. 1 alueen suunnitelmasta puuttuu kesto \(Hyvinvointi\)\.<\/dd>/);
  const signals = html('dirSignals');
  assert.match(signals, /Arvioitu suunniteltu \(min\): 0/);
  assert.match(signals, /Arvioitu tavoitteesta \(%\): 0/);
  assert.doesNotMatch(signals, /Suunniteltu tavoitteesta|Suunniteltu \(min\)/);
});

test('näkymä: yksi kirjaamaton päivä sanotaan yksikössä', async (t) => {
  freezeLocalDate(t, day(0));
  const work = await createLifeArea({ name: 'Työ', importance: 3, targetMinutesPerWeek: 600, categoryKey: 'tyo' });
  for (const i of [0, 1, 2, 3, 4, 5]) {
    moveClock(t, day(i));
    await logTime({ entryDate: day(i), minutes: 60, lifeAreaId: work.area.id });
  }
  moveClock(t, day(6), '20:00');
  renderDirection();
  assert.match(html('dirReview'), /<dt>Ei kirjattu<\/dt><dd>1 päivä ilman kirjauksia — tuntematon, ei nolla\.<\/dd>/);
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
