// Suunnan aloitus: missä vaiheessa käyttäjä on, ja mitä hänellä jo on.
//
// Puhdas moduuli: ei DOM:ia, ei verkkoa, ei kelloa (tämä päivä annetaan).
//
// =====================================================================
// VAIHE ON VALMIS TOSIASIOIDEN PERUSTEELLA, EI LIPUSTA
// =====================================================================
//
// Kertakäyttöinen "aloitus nähty" -lippu olisi väärässä heti, kun käyttäjä
// on luonut alueet jo aiemmin (aalto I) tai toisella laitteella. Siksi
// jokainen vaihe päätellään tallennetuista tiedoista:
//
//   areas       vähintään yksi käytössä oleva elämänalue
//   importance  jokaisella käytössä olevalla alueella on tärkeys 1–5
//   targets     jollakin alueella on viikkotavoite (0 = "ei nyt" on tavoite)
//   capacity    viikon kapasiteetti on asetettu ainakin kerran
//   goals       yhtään avointa tavoitetta ei ole ilman aluetta
//   estimates   tämän viikon avoimilla asioilla on kestoarvio
//   logging     aikaa on kirjattu (tai ajastin on käynnissä)
//
// Ainoa tallennettu asia on käyttäjän oma päätös ohittaa vaihe. Aluetta
// ei voi ohittaa: ilman sitä Suunnalla ei ole mitään, mihin verrata.
//
// =====================================================================
// VANHAA DATAA EI JÄRJESTETÄ PUOLESTA
// =====================================================================
//
// legacySummary() kertoo, mitä käyttäjällä jo on (tehtävät, tavoitteet,
// projektit). Se EI ehdota alueita eikä liitä mitään: liittäminen on
// aina käyttäjän oma teko. categoryImpact() kertoo etukäteen, montako
// tehtävää kategorian kytkentä toisi alueeseen — ei yllätyksiä jälkikäteen.

import { isImportance } from './lifeArea.js';
import { buildAttributionIndex } from './alignment.js';
import { weekDates, weekStartOf } from './weeklyCapacity.js';
import { isOpenProject } from './project.js';

export const SETUP_STEPS = Object.freeze([
  'areas', 'importance', 'targets', 'capacity', 'goals', 'estimates', 'logging'
]);

/** Vaiheet, joita ei voi ohittaa: ilman alueita ei ole Suuntaa. */
export const REQUIRED_SETUP_STEPS = Object.freeze(['areas', 'importance']);

export const SETUP_STEP_LABELS = Object.freeze({
  areas: 'Elämänalueet',
  importance: 'Tärkeys',
  targets: 'Viikkotavoitteet',
  capacity: 'Kapasiteetti',
  goals: 'Tavoitteet',
  estimates: 'Kestoarviot',
  logging: 'Ajan kirjaus'
});

const OPEN_GOAL_STATUSES = new Set(['active', 'paused', 'maintenance']);

export function isOpenGoal(goal) {
  return Boolean(goal) && OPEN_GOAL_STATUSES.has(goal.status);
}

/**
 * Aloituksen eteneminen.
 *
 * @param {object} facts
 * @param {Array} [facts.areas]
 * @param {Array} [facts.goals]
 * @param {object|null} [facts.capacity]   jonkin viikon kapasiteetti (tai null)
 * @param {Array} [facts.capacities]       vaihtoehtoisesti kaikki viikot
 * @param {Array} [facts.timeEntries]
 * @param {boolean} [facts.timerRunning]
 * @param {number} [facts.openUnknownCount] tämän viikon arvioimattomat avoimet asiat
 * @param {Array<string>} [facts.skipped]  käyttäjän ohittamat vaiheet
 * @returns {{steps: Array<{key: string, index: number, done: boolean, skipped: boolean, required: boolean}>,
 *   currentIndex: number, currentKey: string|null, complete: boolean}}
 */
export function setupProgress({
  areas = [], goals = [], capacity = null, capacities = [], timeEntries = [],
  timerRunning = false, openUnknownCount = 0, skipped = []
} = {}) {
  const active = (areas || []).filter(area => area && area.active);
  const areaIds = new Set(active.map(area => area.id));
  const skippedSet = new Set((skipped || []).filter(key => !REQUIRED_SETUP_STEPS.includes(key)));

  const done = {
    areas: active.length > 0,
    importance: active.length > 0 && active.every(area => isImportance(area.importance)),
    targets: active.some(area => Number.isInteger(area.targetMinutesPerWeek)),
    capacity: Boolean(capacity) || (capacities || []).length > 0,
    goals: (goals || []).filter(isOpenGoal).every(goal => goal.lifeAreaId && areaIds.has(goal.lifeAreaId)),
    estimates: !(Number(openUnknownCount) > 0),
    logging: (timeEntries || []).length > 0 || Boolean(timerRunning)
  };

  const steps = SETUP_STEPS.map((key, index) => ({
    key, index, done: Boolean(done[key]),
    skipped: !done[key] && skippedSet.has(key),
    required: REQUIRED_SETUP_STEPS.includes(key)
  }));
  const current = steps.find(step => !step.done && !step.skipped) || null;
  return {
    steps,
    currentIndex: current ? current.index : -1,
    currentKey: current ? current.key : null,
    complete: current === null
  };
}

/**
 * Mitä käyttäjällä jo on. Luvut, ei ehdotuksia.
 *
 * @param {object} input
 * @param {string} input.todayIso
 * @param {string} [input.weekStart] tarkasteltava viikko (oletus: tämän päivän viikko)
 * @returns {{openTasks: number, thisWeekOpen: number, overdueOpen: number,
 *   unestimatedThisWeek: number, goals: number, goalsWithoutArea: number,
 *   projects: number, byCategory: Object<string, {open: number, thisWeek: number}>}}
 */
export function legacySummary({
  tasks = [], goals = [], projects = [], routines = [], areas = [], weekStart = null, todayIso = null
} = {}) {
  const monday = weekStartOf(weekStart || todayIso);
  const week = new Set(monday ? weekDates(monday) : []);
  const areaIds = new Set((areas || []).filter(area => area && area.active).map(area => area.id));
  const summary = {
    openTasks: 0, thisWeekOpen: 0, overdueOpen: 0, unestimatedThisWeek: 0,
    goals: 0, goalsWithoutArea: 0, projects: 0, routines: 0, byCategory: {}
  };
  for (const task of tasks || []) {
    if (!task || task.completed || task.isWake) continue;
    summary.openTasks += 1;
    const inWeek = week.has(task.date);
    if (inWeek) {
      summary.thisWeekOpen += 1;
      const minutes = Number(task.durationMinutes);
      const ranged = Boolean(task.time && task.endTime && task.time !== task.endTime);
      if (!ranged && !(Number.isFinite(minutes) && minutes > 0)) summary.unestimatedThisWeek += 1;
    }
    // Rästi: avoin ja päivätty ennen tätä viikkoa, joten se ei ole viikon suunnitelmassa.
    if (task.date && monday && task.date < monday) summary.overdueOpen += 1;
    const category = task.category || 'muu';
    summary.byCategory[category] ||= { open: 0, thisWeek: 0 };
    summary.byCategory[category].open += 1;
    if (inWeek) summary.byCategory[category].thisWeek += 1;
  }
  for (const goal of goals || []) {
    if (!isOpenGoal(goal)) continue;
    summary.goals += 1;
    if (!goal.lifeAreaId || !areaIds.has(goal.lifeAreaId)) summary.goalsWithoutArea += 1;
  }
  summary.projects = (projects || []).filter(isOpenProject).length;
  summary.routines = (routines || []).filter(routine => routine && routine.active !== false).length;
  return summary;
}

/** Onko käyttäjällä aiempaa tekemistä, josta kannattaa kertoa? */
export function hasLegacyData(summary) {
  return Boolean(summary) && (summary.openTasks + summary.goals + summary.projects) > 0;
}

/**
 * Montako avointa tehtävää ja rutiinia kategorian kytkentä toisi alueeseen.
 *
 * Mukana vain ne, joiden alue ratkeaisi KATEGORIAN kautta: tehtävä, jonka
 * tavoite (tai projektin tavoite) on jo alueessa, kuuluu tavoitteensa
 * alueeseen (src/domain/alignment.js, sama järjestys).
 *
 * @param {Array} tasks
 * @param {Array} routines
 * @param {string} categoryKey
 * @param {object} [context] { goals, projects, areas, weekStart, todayIso }
 * @returns {{tasks: number, thisWeek: number, routines: number}}
 */
export function categoryImpact(tasks = [], routines = [], categoryKey = null, {
  goals = [], projects = [], areas = [], weekStart = null, todayIso = null
} = {}) {
  const result = { tasks: 0, thisWeek: 0, routines: 0 };
  if (!categoryKey) return result;
  const index = buildAttributionIndex({ areas, goals, projects, routines });
  const monday = weekStart || todayIso ? weekStartOf(weekStart || todayIso) : null;
  const week = new Set(monday ? weekDates(monday) : []);
  for (const task of tasks || []) {
    if (!task || task.completed || task.isWake || task.category !== categoryKey) continue;
    if (index.goalArea(task.goalId) || index.projectArea(task.projectId)) continue;
    result.tasks += 1;
    if (week.has(task.date)) result.thisWeek += 1;
  }
  for (const routine of routines || []) {
    if (!routine || routine.active === false || routine.category !== categoryKey) continue;
    if (index.goalArea(routine.goalId)) continue;
    result.routines += 1;
  }
  return result;
}
