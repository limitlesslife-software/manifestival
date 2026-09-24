// Suunta: elääkö käyttäjä sen elämän mukaan, jonka hän itse määritteli?
//
// Puhdas moduuli: ei DOM:ia, ei verkkoa, ei kelloa, EI TEKOÄLYÄ.
//
// =====================================================================
// HAVAINNOT OVAT DETERMINISTISIÄ JA SELITETTÄVIÄ
// =====================================================================
//
// Kolme havaintoa, jokainen yhdellä kirjoitetulla säännöllä:
//
//   OVERLOAD      suunniteltu työ > käyttäjän oma viikkokapasiteetti
//   NEGLECT       tärkeä alue saa selvästi vähemmän aikaa kuin käyttäjä halusi
//   MISALIGNMENT  ajan JAKAUMA poikkeaa käyttäjän toivomasta jakaumasta
//
// Lisäksi TARGET_TENSION: alueiden aikatavoitteiden summa ylittää
// kapasiteetin. Se ei ole virhe vaan jännite, jonka käyttäjä ratkaisee.
//
// Yhtään pisteytystä ei ole. Jokainen havainto kantaa säännön tunnisteen,
// kynnykset ja mitatut luvut (`metrics`), joten "miksi tämä näkyy?" on
// aina vastattavissa ilman arvailua. Kynnykset ovat vientejä, joita
// testit ja käyttöliittymä lukevat.
//
// Tekoäly EI päätä havainnon olemassaolosta. Se saa enintään selittää
// valmiin havainnon (src/ai/alignmentContext.js). Arkkitehtuuritesti
// vartioi, ettei tämä moduuli tuo mitään ai-kerroksesta.
//
// =====================================================================
// TUNTEMATON ON TUNTEMATON
// =====================================================================
//
// Tehtävä ilman kestoarviota EI ole 0 minuuttia eikä 60 minuuttia. Se on
// arvioimaton, ja se raportoidaan erikseen (`unknownCount`). Kuormitus
// arvioidaan tunnetusta työstä, ja arvioimaton työ mainitaan aina.
//
// Toteuma on vain käyttäjän kirjaamaa aikaa (time_entries). Valmiiksi
// merkitty tehtävä ei ole toteutunutta aikaa.
//
// =====================================================================
// ALUEEN PÄÄTTELY: YKSI ALUE, YKSI SÄÄNTÖ
// =====================================================================
//
// Jokainen työ lasketaan TASAN yhteen alueeseen (tai ei mihinkään), joten
// kaksoislaskentaa ei voi syntyä. Järjestys, ensimmäinen osuma voittaa:
//
//   tehtävä     1. tavoite (goal_id -> tavoitteen alue, ylätavoitteen kautta)
//               2. projektin tavoite (project_id -> goal_id -> alue)
//               3. kategoria (tehtävän kategoria -> alue jolla category_key)
//   rutiini     1. tavoite  2. kategoria
//   kirjaus     1. suora alue (life_area_id)  2. tehtävä  3. tavoite
//
// Tavoite on ensin, koska se on käyttäjän nimenomainen valinta; kategoria
// on karkea ja usein oletusarvo.

import { durationOf } from './task.js';
import { expandRoutines } from './routine.js';
import { desiredShares } from './lifeArea.js';
import { weekDates, weekStartOf, nextWeekStart } from './weeklyCapacity.js';
import { entriesInRange } from './timeEntry.js';

export const SIGNAL = Object.freeze({
  OVERLOAD: 'overload',
  NEGLECT: 'neglect',
  MISALIGNMENT: 'misalignment',
  TARGET_TENSION: 'target_tension'
});

export const SEVERITY = Object.freeze({ INFO: 'info', ATTENTION: 'attention', STRONG: 'strong' });
const SEVERITY_RANK = Object.freeze({ strong: 3, attention: 2, info: 1 });
const KIND_RANK = Object.freeze({ overload: 4, neglect: 3, misalignment: 2, target_tension: 1 });

export const SEVERITY_LABELS = Object.freeze({
  info: 'Tiedoksi',
  attention: 'Huomio',
  strong: 'Vahva'
});

export const ATTRIBUTION = Object.freeze({
  GOAL: 'goal',
  PROJECT_GOAL: 'project_goal',
  CATEGORY: 'category',
  DIRECT: 'direct',
  TASK: 'task',
  NONE: 'none'
});

/** Kynnykset. Kaikki säännöt lukevat nämä; käyttöliittymä näyttää ne. */
export const RULES = Object.freeze({
  /** Kuormitus on vahva, kun suunniteltu >= 120 % kapasiteetista. */
  OVERLOAD_STRONG_RATIO: 1.2,
  /** Mahdollinen kuormitus: tunnettu >= 90 % ja arvioimatonta työtä on. */
  OVERLOAD_POSSIBLE_RATIO: 0.9,

  /** Huomiotta jäämistä arvioidaan vain alueille, joiden tärkeys on >= 4. */
  NEGLECT_MIN_IMPORTANCE: 4,
  /** Alle 30 min viikkotavoitetta ei ole mielekäs mittari. */
  NEGLECT_MIN_TARGET_MINUTES: 30,
  /** Alle puolet odotetusta = huomiotta jäämässä. */
  NEGLECT_RATIO: 0.5,
  /** Viikko päättynyt ja alle neljännes = vahva. */
  NEGLECT_STRONG_RATIO: 0.25,
  /** Toteumaa verrataan vasta kun viikosta on kulunut 3/7 (torstaista). */
  NEGLECT_MIN_PROGRESS: 3 / 7,

  /** Jakauman poikkeama prosenttiyksikköinä. */
  MISALIGNMENT_POINTS: 15,
  MISALIGNMENT_STRONG_POINTS: 25,
  /** Jakaumaa ei arvioida alle kahden tunnin aineistosta. */
  MISALIGNMENT_MIN_MINUTES: 120,
  /** Jos alle 60 % ajasta on liitetty alueeseen, johtopäätös on vain tiedoksi. */
  MIN_ASSIGNED_COVERAGE: 0.6,
  /** Arvioitua kestoa alle puolella työstä = heikko aineisto. */
  MIN_ESTIMATE_COVERAGE: 0.5
});

const NONE_KEY = '__none__';

// ------------------------------------------------------------ päättely

/**
 * Hakemistot alueen päättelyyn. Rakennetaan kerran; jokainen haku on O(1)
 * (tavoiteketju enintään MAX_GOAL_DEPTH askelta).
 */
export function buildAttributionIndex({ areas = [], goals = [], projects = [] } = {}) {
  const areaById = new Map();
  const categoryArea = new Map();
  for (const area of areas || []) {
    if (!area || !area.id) continue;
    areaById.set(area.id, area);
    if (area.categoryKey && !categoryArea.has(area.categoryKey)) {
      categoryArea.set(area.categoryKey, area.id);
    }
  }

  const goalById = new Map((goals || []).filter(g => g && g.id).map(g => [g.id, g]));
  const projectById = new Map((projects || []).filter(p => p && p.id).map(p => [p.id, p]));
  const goalAreaCache = new Map();

  function goalArea(goalId) {
    if (!goalId) return null;
    if (goalAreaCache.has(goalId)) return goalAreaCache.get(goalId);
    // Ylätavoiteketju: alatavoite ilman omaa aluetta perii ylätavoitteen
    // alueen. Sykli ja liian syvä ketju pysähtyvät (ei ikuista silmukkaa).
    const seen = new Set();
    let current = goalById.get(goalId);
    let result = null;
    while (current && !seen.has(current.id) && seen.size < MAX_GOAL_DEPTH) {
      seen.add(current.id);
      if (current.lifeAreaId && areaById.has(current.lifeAreaId)) {
        result = current.lifeAreaId;
        break;
      }
      current = current.parentGoalId ? goalById.get(current.parentGoalId) : null;
    }
    goalAreaCache.set(goalId, result);
    return result;
  }

  function projectArea(projectId) {
    const project = projectId ? projectById.get(projectId) : null;
    return project ? goalArea(project.goalId) : null;
  }

  return { areaById, categoryArea, goalById, projectById, goalArea, projectArea };
}

const MAX_GOAL_DEPTH = 20;

const unattributed = Object.freeze({ areaId: null, via: ATTRIBUTION.NONE });

export function areaForTask(task, index) {
  if (!task) return unattributed;
  const byGoal = index.goalArea(task.goalId);
  if (byGoal) return { areaId: byGoal, via: ATTRIBUTION.GOAL };
  const byProject = index.projectArea(task.projectId);
  if (byProject) return { areaId: byProject, via: ATTRIBUTION.PROJECT_GOAL };
  const byCategory = task.category ? index.categoryArea.get(task.category) : null;
  if (byCategory) return { areaId: byCategory, via: ATTRIBUTION.CATEGORY };
  return unattributed;
}

export function areaForRoutine(routine, index) {
  if (!routine) return unattributed;
  const byGoal = index.goalArea(routine.goalId);
  if (byGoal) return { areaId: byGoal, via: ATTRIBUTION.GOAL };
  const byCategory = routine.category ? index.categoryArea.get(routine.category) : null;
  if (byCategory) return { areaId: byCategory, via: ATTRIBUTION.CATEGORY };
  return unattributed;
}

export function areaForTimeEntry(entry, index, tasksById = new Map()) {
  if (!entry) return unattributed;
  if (entry.lifeAreaId && index.areaById.has(entry.lifeAreaId)) {
    return { areaId: entry.lifeAreaId, via: ATTRIBUTION.DIRECT };
  }
  const task = entry.taskId ? tasksById.get(entry.taskId) : null;
  if (task) {
    const byTask = areaForTask(task, index);
    if (byTask.areaId) return { areaId: byTask.areaId, via: ATTRIBUTION.TASK };
  }
  const byGoal = index.goalArea(entry.goalId);
  if (byGoal) return { areaId: byGoal, via: ATTRIBUTION.GOAL };
  return unattributed;
}

// --------------------------------------------------------------- viikko

/**
 * Kuinka suuri osa viikosta on kulunut.
 *
 * Päivätasolla: maanantaina 0/7 (yhtään päivää ei ole takana), sunnuntaina
 * 6/7, viikon jälkeen 7/7. Valinnainen `nowMinutes` lisää kuluvan päivän
 * osuuden. Kesäaika ei vaikuta: laskenta on päivinä, ei millisekunteina.
 */
export function weekProgress(weekStart, todayIso, nowMinutes = 0) {
  const dates = weekDates(weekStart);
  if (dates.length === 0 || !todayIso) return { state: 'unknown', elapsedDays: 0, fraction: 0 };
  if (todayIso < dates[0]) return { state: 'before', elapsedDays: 0, fraction: 0 };
  if (todayIso > dates[6]) return { state: 'after', elapsedDays: 7, fraction: 1 };
  const index = dates.indexOf(todayIso);
  const partial = Number.isFinite(nowMinutes) ? Math.min(Math.max(nowMinutes, 0), 1440) / 1440 : 0;
  const elapsedDays = index + partial;
  return { state: 'during', elapsedDays, fraction: elapsedDays / 7 };
}

// ------------------------------------------------------ suunniteltu työ

/**
 * Viikon suunniteltu työ: päivätyt tehtävät ja rutiinien esiintymät.
 *
 * Jokainen kohde on mukana kerran (tunniste on avain). Herätyskohde
 * (`isWake`) ei ole työtä. Valmiiksi merkitty tehtävä on YHÄ suunniteltua
 * työtä — suunnitelma ei muutu jälkikäteen.
 */
export function plannedItems({ weekStart, tasks = [], routines = [], exceptions = [], index }) {
  const dates = weekDates(weekStart);
  if (dates.length === 0) return [];
  const inWeek = new Set(dates);
  const items = new Map();

  for (const task of tasks || []) {
    if (!task || !task.id || !inWeek.has(task.date) || task.isWake) continue;
    const minutes = durationOf(task);
    const { areaId, via } = areaForTask(task, index);
    items.set('task:' + task.id, {
      key: 'task:' + task.id, kind: 'task', id: task.id, date: task.date,
      minutes: Number.isFinite(minutes) && minutes > 0 ? minutes : null,
      completed: Boolean(task.completed), priority: task.priority || null,
      goalId: task.goalId || null, areaId, via
    });
  }

  const routineById = new Map((routines || []).filter(r => r && r.id).map(r => [r.id, r]));
  for (const occurrence of expandRoutines({ routines, from: dates[0], to: dates[6], exceptions })) {
    const routine = routineById.get(occurrence.routineId);
    const { areaId, via } = areaForRoutine(routine, index);
    const minutes = occurrence.durationMinutes;
    items.set('routine:' + occurrence.id, {
      key: 'routine:' + occurrence.id, kind: 'routine', id: occurrence.id,
      routineId: occurrence.routineId, date: occurrence.date,
      minutes: Number.isFinite(minutes) && minutes > 0 ? minutes : null,
      completed: false, priority: occurrence.priority || null,
      goalId: routine ? routine.goalId || null : null, areaId, via
    });
  }

  return [...items.values()];
}

function emptyBucket() {
  return { knownMinutes: 0, unknownCount: 0, itemCount: 0 };
}

export function summarizePlanned(items = []) {
  const total = emptyBucket();
  const byArea = new Map();
  for (const item of items) {
    const key = item.areaId || NONE_KEY;
    if (!byArea.has(key)) byArea.set(key, emptyBucket());
    for (const bucket of [total, byArea.get(key)]) {
      bucket.itemCount += 1;
      if (item.minutes === null) bucket.unknownCount += 1;
      else bucket.knownMinutes += item.minutes;
    }
  }
  return { ...total, estimatedCount: total.itemCount - total.unknownCount, byArea };
}

// ----------------------------------------------------------- toteuma

export function summarizeActual({ weekStart, timeEntries = [], tasks = [], index }) {
  const dates = weekDates(weekStart);
  const entries = dates.length ? entriesInRange(timeEntries, dates[0], dates[6]) : [];
  const tasksById = new Map((tasks || []).filter(t => t && t.id).map(t => [t.id, t]));
  const byArea = new Map();
  const days = new Set();
  let minutes = 0;
  let entryCount = 0;
  for (const entry of entries) {
    if (!Number.isInteger(entry.minutes) || entry.minutes <= 0) continue;
    const { areaId } = areaForTimeEntry(entry, index, tasksById);
    const key = areaId || NONE_KEY;
    byArea.set(key, (byArea.get(key) || 0) + entry.minutes);
    minutes += entry.minutes;
    entryCount += 1;
    days.add(entry.entryDate);
  }
  return { minutes, entryCount, daysWithEntries: days.size, byArea };
}

// ----------------------------------------------------------- havainnot

function ratio(part, whole) {
  return whole > 0 ? part / whole : null;
}

function percent(value) {
  return value === null ? null : Math.round(value * 100);
}

function overloadSignals({ capacity, planned }) {
  if (!capacity || !Number.isInteger(capacity.availableMinutes)) return [];
  const available = capacity.availableMinutes;
  const known = planned.knownMinutes;
  const metrics = {
    plannedMinutes: known,
    availableMinutes: available,
    overageMinutes: Math.max(0, known - available),
    percentOfCapacity: available > 0 ? Math.round((known / available) * 100) : null,
    unknownCount: planned.unknownCount
  };

  if (known > available) {
    const strong = available === 0 || known >= available * RULES.OVERLOAD_STRONG_RATIO;
    return [{
      kind: SIGNAL.OVERLOAD, severity: strong ? SEVERITY.STRONG : SEVERITY.ATTENTION,
      areaId: null, basis: 'planned', rule: 'overload.known_exceeds_capacity', metrics
    }];
  }

  // Tunnettu työ ei ylitä, mutta arvioimaton voi. Ei piiloteta.
  if (planned.unknownCount > 0 && available > 0
      && known >= available * RULES.OVERLOAD_POSSIBLE_RATIO) {
    return [{
      kind: SIGNAL.OVERLOAD, severity: SEVERITY.INFO, areaId: null, basis: 'planned',
      rule: 'overload.possible_with_unestimated', metrics
    }];
  }
  return [];
}

function neglectSignals({ areas, planned, actual, progress }) {
  const signals = [];
  const actualTracked = actual.entryCount > 0;
  const actualEligible = actualTracked && progress.fraction >= RULES.NEGLECT_MIN_PROGRESS;

  for (const area of areas) {
    if (!area.active || area.importance < RULES.NEGLECT_MIN_IMPORTANCE) continue;
    const target = area.targetMinutesPerWeek;
    if (!Number.isInteger(target) || target < RULES.NEGLECT_MIN_TARGET_MINUTES) continue;

    const plannedBucket = planned.byArea.get(area.id) || emptyBucket();

    if (actualEligible) {
      const expected = target * progress.fraction;
      const got = actual.byArea.get(area.id) || 0;
      const share = ratio(got, expected);
      if (share !== null && share < RULES.NEGLECT_RATIO) {
        const strong = progress.fraction >= 1 && share < RULES.NEGLECT_STRONG_RATIO;
        signals.push({
          kind: SIGNAL.NEGLECT, severity: strong ? SEVERITY.STRONG : SEVERITY.ATTENTION,
          areaId: area.id, basis: 'actual', rule: 'neglect.actual_below_expected',
          metrics: {
            targetMinutes: target, expectedByNowMinutes: Math.round(expected),
            actualMinutes: got, percentOfExpected: percent(share),
            weekProgressPercent: percent(progress.fraction),
            plannedMinutes: plannedBucket.knownMinutes, unknownCount: plannedBucket.unknownCount
          }
        });
      }
      continue;
    }

    // Suunnitelmaan perustuva: ennakoiva, siksi vain tiedoksi.
    const plannedShare = ratio(plannedBucket.knownMinutes, target);
    if (plannedShare !== null && plannedShare < RULES.NEGLECT_RATIO) {
      signals.push({
        kind: SIGNAL.NEGLECT, severity: SEVERITY.INFO,
        areaId: area.id, basis: 'planned', rule: 'neglect.plan_below_target',
        metrics: {
          targetMinutes: target, plannedMinutes: plannedBucket.knownMinutes,
          percentOfTarget: percent(plannedShare), unknownCount: plannedBucket.unknownCount,
          actualTracked
        }
      });
    }
  }
  return signals;
}

function distributionBasis({ planned, actual }) {
  const assignedActual = actual.minutes - (actual.byArea.get(NONE_KEY) || 0);
  if (assignedActual >= RULES.MISALIGNMENT_MIN_MINUTES) {
    return {
      basis: 'actual', assigned: assignedActual, total: actual.minutes,
      minutesFor: id => actual.byArea.get(id) || 0
    };
  }
  const noneBucket = planned.byArea.get(NONE_KEY);
  const assignedPlanned = planned.knownMinutes - (noneBucket ? noneBucket.knownMinutes : 0);
  if (assignedPlanned >= RULES.MISALIGNMENT_MIN_MINUTES) {
    return {
      basis: 'planned', assigned: assignedPlanned, total: planned.knownMinutes,
      minutesFor: id => (planned.byArea.get(id) || emptyBucket()).knownMinutes
    };
  }
  return null;
}

function misalignmentSignals({ areas, planned, actual, neglected }) {
  const desired = desiredShares(areas);
  if (desired.totalMinutes <= 0) return [];
  const source = distributionBasis({ planned, actual });
  if (!source) return [];

  const coverage = ratio(source.assigned, source.total);
  const weak = coverage === null || coverage < RULES.MIN_ASSIGNED_COVERAGE;
  const signals = [];

  for (const area of areas) {
    const want = desired.shares.get(area.id) ?? 0;
    const got = source.minutesFor(area.id) / source.assigned;
    // Alue, jolle ei toivottu osuutta eikä käytetty aikaa, ei ole poikkeama.
    if (want === 0 && got === 0) continue;
    // Aktiivinen alue ilman ASETETTUA tavoitetta (null): käyttäjä ei ole
    // kertonut mitä haluaa, joten osuutta ei tulkita poikkeamaksi.
    // Tavoite 0 on eri asia: se on päätös, ja siihen kulunut aika on
    // poikkeama.
    if (area.active && area.targetMinutesPerWeek == null) continue;

    const points = Math.round((got - want) * 100);
    if (Math.abs(points) < RULES.MISALIGNMENT_POINTS) continue;
    const direction = points > 0 ? 'over' : 'under';
    // Sama asia kahdesti on melua: huomiotta jääminen kertoo jo vajeesta.
    if (direction === 'under' && neglected.has(area.id)) continue;

    let severity = Math.abs(points) >= RULES.MISALIGNMENT_STRONG_POINTS ? SEVERITY.STRONG : SEVERITY.ATTENTION;
    if (source.basis === 'planned' && severity === SEVERITY.STRONG) severity = SEVERITY.ATTENTION;
    if (weak) severity = SEVERITY.INFO;

    signals.push({
      kind: SIGNAL.MISALIGNMENT, severity, areaId: area.id, basis: source.basis,
      rule: 'misalignment.share_deviation',
      metrics: {
        direction, desiredPercent: Math.round(want * 100), actualPercent: Math.round(got * 100),
        deviationPoints: points, basisMinutes: source.minutesFor(area.id),
        assignedMinutes: source.assigned, coveragePercent: percent(coverage), incomplete: weak
      }
    });
  }
  return signals;
}

function tensionSignals({ areas, capacity }) {
  if (!capacity || !Number.isInteger(capacity.availableMinutes)) return [];
  const desired = desiredShares(areas);
  if (desired.totalMinutes <= capacity.availableMinutes) return [];
  return [{
    kind: SIGNAL.TARGET_TENSION, severity: SEVERITY.INFO, areaId: null, basis: 'targets',
    rule: 'tension.targets_exceed_capacity',
    metrics: {
      targetsMinutes: desired.totalMinutes, availableMinutes: capacity.availableMinutes,
      differenceMinutes: desired.totalMinutes - capacity.availableMinutes
    }
  }];
}

export function compareSignals(a, b) {
  const severity = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
  if (severity !== 0) return severity;
  const kind = KIND_RANK[b.kind] - KIND_RANK[a.kind];
  if (kind !== 0) return kind;
  return String(a.areaId || '').localeCompare(String(b.areaId || ''));
}

// ----------------------------------------------------------- aineiston laatu

export const QUALITY = Object.freeze({ GOOD: 'good', PARTIAL: 'partial', WEAK: 'weak', NONE: 'none' });

export function dataQuality({ areas, capacity, planned, actual }) {
  const reasons = [];
  const activeAreas = areas.filter(area => area.active);
  if (activeAreas.length === 0) reasons.push('no_areas');
  else if (!activeAreas.some(area => area.targetMinutesPerWeek > 0)) reasons.push('no_targets');
  if (!capacity || !Number.isInteger(capacity.availableMinutes)) reasons.push('no_capacity');

  const estimateCoverage = ratio(planned.estimatedCount, planned.itemCount);
  if (planned.unknownCount > 0) reasons.push('unestimated_work');

  const plannedNone = planned.byArea.get(NONE_KEY) || emptyBucket();
  const plannedAssignedCoverage = ratio(planned.knownMinutes - plannedNone.knownMinutes, planned.knownMinutes);
  if (plannedNone.itemCount > 0) reasons.push('unassigned_work');

  const actualNone = actual.byArea.get(NONE_KEY) || 0;
  const actualAssignedCoverage = ratio(actual.minutes - actualNone, actual.minutes);
  if (actual.entryCount === 0) reasons.push('no_actual');
  else if (actualNone > 0) reasons.push('unassigned_actual');

  let level;
  if (activeAreas.length === 0) level = QUALITY.NONE;
  else if ((estimateCoverage !== null && estimateCoverage < RULES.MIN_ESTIMATE_COVERAGE)
      || (planned.itemCount === 0 && actual.entryCount === 0)) level = QUALITY.WEAK;
  else if (reasons.length > 0) level = QUALITY.PARTIAL;
  else level = QUALITY.GOOD;

  return {
    level, reasons,
    estimateCoveragePercent: percent(estimateCoverage),
    plannedAssignedPercent: percent(plannedAssignedCoverage),
    actualAssignedPercent: percent(actualAssignedCoverage),
    unestimatedCount: planned.unknownCount,
    unassignedPlannedCount: plannedNone.itemCount,
    unassignedActualMinutes: actualNone,
    actualTracked: actual.entryCount > 0
  };
}

// -------------------------------------------------------------- analyysi

/**
 * Viikon analyysi. Yksi kutsu, yksi normalisoitu aineisto: näkymät lukevat
 * tämän tuloksen eivätkä laske omiaan.
 *
 * @param {object} input
 * @param {string} input.weekStart   mikä tahansa viikon päivä (maanantai johdetaan)
 * @param {string} input.todayIso    tämä päivä (annettu, ei luettu kellosta)
 * @param {number} [input.nowMinutes]
 */
export function analyzeWeek({
  weekStart, todayIso, nowMinutes = 0,
  areas = [], goals = [], projects = [], tasks = [], routines = [], exceptions = [],
  timeEntries = [], capacity = null
} = {}) {
  const monday = weekStartOf(weekStart);
  const dates = weekDates(monday);
  const index = buildAttributionIndex({ areas, goals, projects });
  const items = plannedItems({ weekStart: monday, tasks, routines, exceptions, index });
  const planned = summarizePlanned(items);
  const actual = summarizeActual({ weekStart: monday, timeEntries, tasks, index });
  const progress = weekProgress(monday, todayIso, nowMinutes);
  const cleanAreas = (areas || []).filter(area => area && area.id);
  const weekCapacity = capacity && capacity.weekStart === monday ? capacity : null;

  const desired = desiredShares(cleanAreas);
  const neglect = neglectSignals({ areas: cleanAreas, planned, actual, progress });
  const neglected = new Set(neglect.map(signal => signal.areaId));
  const signals = [
    ...overloadSignals({ capacity: weekCapacity, planned }),
    ...neglect,
    ...misalignmentSignals({ areas: cleanAreas, planned, actual, neglected }),
    ...tensionSignals({ areas: cleanAreas, capacity: weekCapacity })
  ].sort(compareSignals);

  const assignedPlanned = planned.knownMinutes - ((planned.byArea.get(NONE_KEY) || emptyBucket()).knownMinutes);
  const assignedActual = actual.minutes - (actual.byArea.get(NONE_KEY) || 0);

  const areaRows = cleanAreas.map(area => {
    const bucket = planned.byArea.get(area.id) || emptyBucket();
    const got = actual.byArea.get(area.id) || 0;
    return {
      id: area.id, name: area.name, importance: area.importance, active: area.active,
      targetMinutes: area.targetMinutesPerWeek,
      desiredPercent: desired.shares.has(area.id) ? Math.round(desired.shares.get(area.id) * 100) : null,
      plannedMinutes: bucket.knownMinutes, plannedUnknown: bucket.unknownCount, plannedItems: bucket.itemCount,
      plannedPercent: assignedPlanned > 0 ? Math.round((bucket.knownMinutes / assignedPlanned) * 100) : null,
      actualMinutes: got,
      actualPercent: assignedActual > 0 ? Math.round((got / assignedActual) * 100) : null
    };
  });

  const none = planned.byArea.get(NONE_KEY) || emptyBucket();
  return {
    weekStart: monday,
    weekEnd: dates[6] || null,
    nextWeekStart: nextWeekStart(monday),
    progress,
    capacity: {
      declared: Boolean(weekCapacity),
      availableMinutes: weekCapacity ? weekCapacity.availableMinutes : null,
      energyLevel: weekCapacity ? weekCapacity.energyLevel : null,
      remainingMinutes: weekCapacity ? weekCapacity.availableMinutes - planned.knownMinutes : null
    },
    planned: {
      knownMinutes: planned.knownMinutes, unknownCount: planned.unknownCount,
      itemCount: planned.itemCount, estimatedCount: planned.estimatedCount
    },
    actual: { minutes: actual.minutes, entryCount: actual.entryCount, daysWithEntries: actual.daysWithEntries },
    areas: areaRows,
    unassigned: {
      plannedMinutes: none.knownMinutes, plannedUnknown: none.unknownCount, plannedItems: none.itemCount,
      actualMinutes: actual.byArea.get(NONE_KEY) || 0
    },
    items,
    dataQuality: dataQuality({ areas: cleanAreas, capacity: weekCapacity, planned, actual }),
    signals
  };
}

/** Päivänäkymän yksi havainto: vahvin, tai null. */
export function primarySignal(analysis) {
  return analysis && analysis.signals.length ? analysis.signals[0] : null;
}
