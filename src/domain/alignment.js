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
// Päivä ilman kirjauksia EI ole nolla minuuttia: se on kirjaamaton.
// Siksi toteumaa verrataan tavoitteisiin vasta, kun kirjaaminen on
// vakiintunut (trackingMaturity, sääntöversio 3: riittävästi päiviä ja
// vähintään puolet käyttäjän itse ilmoittamasta viitteestä), ja vertailu alkaa
// myöhäisimmästä näistä: viikon maanantai, ensimmäinen koskaan kirjattu
// päivä, alueen luontipäivä. Samoin suunnitelman jakaumaa ei tulkita,
// jos vain pieni osa työstä on arvioitu.
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
import { TIME_RULES, POLICY_VERSION } from './alignmentPolicy.js';
import { indexItemSettings, energyDemandFor, isOptedOut } from './alignmentItemSettings.js';
import { summarizeEnergy, energySignals, ENERGY_SIGNAL } from './energyLoad.js';

/**
 * Havaintolajit. OVERLOAD on AIKAkuormitus (TIME_OVERLOAD);
 * ENERGY_OVERLOAD on erillinen havainto eikä sitä yhdistetä aikaan.
 */
export const SIGNAL = Object.freeze({
  OVERLOAD: 'overload',
  NEGLECT: 'neglect',
  MISALIGNMENT: 'misalignment',
  ENERGY_OVERLOAD: ENERGY_SIGNAL,
  TARGET_TENSION: 'target_tension'
});

export const SEVERITY = Object.freeze({ INFO: 'info', ATTENTION: 'attention', STRONG: 'strong' });
const SEVERITY_RANK = Object.freeze({ strong: 3, attention: 2, info: 1 });
const KIND_RANK = Object.freeze({
  overload: 5, neglect: 4, misalignment: 3, energy_overload: 2, target_tension: 1
});

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
  ROUTINE: 'routine',
  NONE: 'none'
});

/**
 * Kynnykset. Kaikki säännöt lukevat nämä; käyttöliittymä näyttää ne.
 * Arvot asuvat politiikkamoduulissa (alignmentPolicy.js); tämä nimi
 * säilyy, koska katsaus, näkymät ja testit lukevat sitä.
 */
export const RULES = TIME_RULES;

const NONE_KEY = '__none__';

// ------------------------------------------------------------ päättely

/**
 * Hakemistot alueen päättelyyn. Rakennetaan kerran; jokainen haku on O(1)
 * (tavoiteketju enintään MAX_GOAL_DEPTH askelta).
 */
export function buildAttributionIndex({ areas = [], goals = [], projects = [], routines = [] } = {}) {
  const areaById = new Map();
  const categoryArea = new Map();
  // Migraation 0015 jälkeen useampi alue voi jakaa kategorian. Perivä alue
  // valitaan deterministisesti (lifeArea.categoryOwnerArea): aktiivinen,
  // pienin järjestysnumero, nimi, tunniste. Ennen 0015:tä kategoria on
  // uniikki, joten järjestys ei muuta mitään.
  const ordered = (areas || []).filter(area => area && area.id).sort((a, b) =>
    Number(a.active === false) - Number(b.active === false)
    || (Number(a.sortOrder) || 0) - (Number(b.sortOrder) || 0)
    || String(a.name ?? '').localeCompare(String(b.name ?? ''), 'fi')
    || String(a.id).localeCompare(String(b.id)));
  for (const area of ordered) {
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

  const routineById = new Map((routines || []).filter(r => r && r.id).map(r => [r.id, r]));

  return { areaById, categoryArea, goalById, projectById, routineById, goalArea, projectArea };
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

/**
 * Kirjauksen alue. Järjestys: suora alue > tehtävä > rutiini > projekti >
 * tavoite. Kirjauksella on tyypillisesti yksi kohde; jos useampi, ensimmäinen
 * osuma voittaa, joten sama minuutti ei koskaan päädy kahteen alueeseen.
 */
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
  const routine = entry.routineId && index.routineById ? index.routineById.get(entry.routineId) : null;
  if (routine) {
    const byRoutine = areaForRoutine(routine, index);
    if (byRoutine.areaId) return { areaId: byRoutine.areaId, via: ATTRIBUTION.ROUTINE };
  }
  const byProject = index.projectArea(entry.projectId);
  if (byProject) return { areaId: byProject, via: ATTRIBUTION.PROJECT_GOAL };
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
export function plannedItems({
  weekStart, tasks = [], routines = [], exceptions = [], index, settings = new Map()
}) {
  const dates = weekDates(weekStart);
  if (dates.length === 0) return [];
  const inWeek = new Set(dates);
  const items = new Map();

  for (const task of tasks || []) {
    if (!task || !task.id || !inWeek.has(task.date) || task.isWake) continue;
    const minutes = durationOf(task);
    const { areaId, via } = areaForTask(task, index);
    const item = {
      key: 'task:' + task.id, kind: 'task', id: task.id, date: task.date,
      minutes: Number.isFinite(minutes) && minutes > 0 ? minutes : null,
      completed: Boolean(task.completed), priority: task.priority || null,
      goalId: task.goalId || null, projectId: task.projectId || null, areaId, via
    };
    item.energyDemand = energyDemandFor(item, settings, { projectIdOf: () => task.projectId || null });
    item.optedOut = !areaId && isOptedOut(item, settings);
    items.set(item.key, item);
  }

  const routineById = new Map((routines || []).filter(r => r && r.id).map(r => [r.id, r]));
  for (const occurrence of expandRoutines({ routines, from: dates[0], to: dates[6], exceptions })) {
    const routine = routineById.get(occurrence.routineId);
    const { areaId, via } = areaForRoutine(routine, index);
    const minutes = occurrence.durationMinutes;
    const item = {
      key: 'routine:' + occurrence.id, kind: 'routine', id: occurrence.id,
      routineId: occurrence.routineId, date: occurrence.date,
      minutes: Number.isFinite(minutes) && minutes > 0 ? minutes : null,
      completed: false, priority: occurrence.priority || null,
      goalId: routine ? routine.goalId || null : null, areaId, via
    };
    item.energyDemand = energyDemandFor(item, settings);
    item.optedOut = !areaId && isOptedOut(item, settings);
    items.set(item.key, item);
  }

  return [...items.values()];
}

function emptyBucket() {
  return { knownMinutes: 0, unknownCount: 0, openUnknownCount: 0, itemCount: 0 };
}

/**
 * Suunnitellun työn yhteenveto. `unknownCount` = kaikki kohteet ilman
 * kestoa; `openUnknownCount` = niistä ne, joita ei ole merkitty valmiiksi
 * (vain niitä voi vielä arvioida — arviointityönkulku ei kysy valmiita).
 */
export function summarizePlanned(items = []) {
  const total = emptyBucket();
  const byArea = new Map();
  let optedOutCount = 0;
  for (const item of items) {
    const key = item.areaId || NONE_KEY;
    if (!byArea.has(key)) byArea.set(key, emptyBucket());
    if (!item.areaId && item.optedOut) optedOutCount += 1;
    for (const bucket of [total, byArea.get(key)]) {
      bucket.itemCount += 1;
      if (item.minutes === null) {
        bucket.unknownCount += 1;
        if (!item.completed) bucket.openUnknownCount += 1;
      } else {
        bucket.knownMinutes += item.minutes;
      }
    }
  }
  return { ...total, estimatedCount: total.itemCount - total.unknownCount, byArea, optedOutCount };
}

// ----------------------------------------------------------- toteuma

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function countable(entry) {
  return Boolean(entry) && Number.isInteger(entry.minutes) && entry.minutes > 0
    && typeof entry.entryDate === 'string' && ISO_DATE.test(entry.entryDate);
}

/**
 * Viikon toteuma. Lisäksi `entryDates` (viikon kirjauspäivät),
 * `minutesByDate` ja `firstEverEntryDate`: ensimmäinen päivä, jolle
 * käyttäjä on KOSKAAN kirjannut aikaa (kaikista annetuista kirjauksista).
 * Sitä edeltävät päivät ovat kirjaamattomia, eivät nollaa.
 */
export function summarizeActual({ weekStart, timeEntries = [], tasks = [], index }) {
  const dates = weekDates(weekStart);
  const entries = dates.length ? entriesInRange(timeEntries, dates[0], dates[6]) : [];
  const tasksById = new Map((tasks || []).filter(t => t && t.id).map(t => [t.id, t]));
  const byArea = new Map();
  const bySource = {};
  const minutesByDate = new Map();
  const goalIds = new Set();
  let minutes = 0;
  let entryCount = 0;
  let firstEverEntryDate = null;
  for (const entry of timeEntries || []) {
    if (countable(entry) && (!firstEverEntryDate || entry.entryDate < firstEverEntryDate)) {
      firstEverEntryDate = entry.entryDate;
    }
  }
  for (const entry of entries) {
    if (!Number.isInteger(entry.minutes) || entry.minutes <= 0) continue;
    const task = entry.taskId ? tasksById.get(entry.taskId) : null;
    const project = index.projectById.get(entry.projectId || task?.projectId);
    const routine = index.routineById ? index.routineById.get(entry.routineId) : null;
    for (const goalId of [entry.goalId, task?.goalId, project?.goalId, routine?.goalId]) {
      if (goalId) goalIds.add(goalId);
    }
    const { areaId } = areaForTimeEntry(entry, index, tasksById);
    const key = areaId || NONE_KEY;
    byArea.set(key, (byArea.get(key) || 0) + entry.minutes);
    const source = entry.source || 'manual';
    bySource[source] = (bySource[source] || 0) + entry.minutes;
    minutes += entry.minutes;
    entryCount += 1;
    minutesByDate.set(entry.entryDate, (minutesByDate.get(entry.entryDate) || 0) + entry.minutes);
  }
  const entryDates = [...minutesByDate.keys()].sort();
  return {
    minutes, entryCount, daysWithEntries: entryDates.length, byArea, bySource, goalIds,
    entryDates, minutesByDate, firstEverEntryDate
  };
}

/** Tavoitteet, joilla oli viikolla suunniteltua tai kirjattua tekemistä. */
function activeGoals(items, actual, index) {
  const ids = new Set(actual.goalIds || []);
  for (const item of items) {
    if (item.goalId) ids.add(item.goalId);
    const project = item.projectId ? index.projectById.get(item.projectId) : null;
    if (project && project.goalId) ids.add(project.goalId);
  }
  return [...ids].sort();
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

// ------------------------------------------------------ seurannan kypsyys

/** Seurannan tasot (sääntöversio 3). Vain `established` sallii toteuman vertailun. */
export const TRACKING = Object.freeze({
  NONE: 'none', EARLY: 'early', PARTIAL: 'partial', ESTABLISHED: 'established'
});

function isIsoDate(value) {
  return typeof value === 'string' && ISO_DATE.test(value);
}

/** Montako viikon päivää on ennen päivää `iso` (0–7). */
function dayOffset(dates, iso) {
  if (!iso || iso <= dates[0]) return 0;
  if (iso > dates[6]) return 7;
  return dates.indexOf(iso);
}

/**
 * Miksi seuranta ei (vielä) ole vakiintunut. Katsaus ja aineiston laatu
 * sanoittavat syyn: "vain N päivänä" ei ole sama asia kuin "vasta X %".
 */
export const TRACKING_REASON = Object.freeze({
  /** Jaksosta on kulunut alle NEGLECT_MIN_PROGRESS. */
  WINDOW: 'window',
  /** Kirjauspäiviä on liian vähän (alle 2 tai alle puolet jakson päivistä). */
  DAYS: 'days',
  /** Kirjattua aikaa on alle ACTUAL_MIN_LOGGED_SHARE viitteestä. */
  SHARE: 'share',
  /** Käyttäjä ei ole ilmoittanut kapasiteettia, tavoitteita eikä arvioitua suunnitelmaa. */
  NO_REFERENCE: 'no_reference'
});

/** Kirjatun ajan viitteen lähde (ensimmäinen olemassa oleva). */
export const REFERENCE_BASIS = Object.freeze({ CAPACITY: 'capacity', TARGETS: 'targets', PLANNED: 'planned' });

/**
 * Viite, johon kirjattua aikaa suhteutetaan: käyttäjän ITSE ilmoittama.
 * Kapasiteetti ja tavoitteet ovat viikkolukuja (x jakson osuus);
 * suunnitelma on jo päivätty, joten siitä lasketaan jakson päivät
 * tähän päivään asti. Nolla ei ole viite (jakolasku ja "ei mitään").
 */
function loggedReference({ capacityMinutes, targetsMinutes, plannedMinutesByDate, windowStart, lastDay, windowFraction }) {
  if (capacityMinutes > 0) return { basis: REFERENCE_BASIS.CAPACITY, minutes: capacityMinutes * windowFraction };
  if (targetsMinutes > 0) return { basis: REFERENCE_BASIS.TARGETS, minutes: targetsMinutes * windowFraction };
  let planned = 0;
  for (const [date, minutes] of plannedMinutesByDate || []) {
    if (date >= windowStart && date <= lastDay && Number.isFinite(minutes)) planned += minutes;
  }
  if (planned > 0) return { basis: REFERENCE_BASIS.PLANNED, minutes: planned };
  return { basis: null, minutes: null };
}

/** Yhden hetken arvio: kriteerit annetulla jakson pituudella ja kirjauksilla. */
function evaluateTracking({ elapsed, trackedDays, trackedMinutes, reference }) {
  const windowFraction = elapsed / 7;
  const requiredDays = Math.max(RULES.ACTUAL_MIN_TRACKED_DAYS,
    Math.ceil(Math.floor(elapsed) * RULES.ACTUAL_MIN_DAY_COVERAGE));
  const loggedShare = reference.minutes > 0 ? trackedMinutes / reference.minutes : null;
  const daysCovered = trackedDays >= requiredDays;
  let level = TRACKING.ESTABLISHED;
  let reason = null;
  if (windowFraction < RULES.NEGLECT_MIN_PROGRESS) { level = TRACKING.EARLY; reason = TRACKING_REASON.WINDOW; }
  else if (trackedDays < RULES.ACTUAL_MIN_TRACKED_DAYS) { level = TRACKING.EARLY; reason = TRACKING_REASON.DAYS; }
  else if (!daysCovered) { level = TRACKING.PARTIAL; reason = TRACKING_REASON.DAYS; }
  else if (loggedShare === null) { level = TRACKING.PARTIAL; reason = TRACKING_REASON.NO_REFERENCE; }
  else if (loggedShare < RULES.ACTUAL_MIN_LOGGED_SHARE) { level = TRACKING.PARTIAL; reason = TRACKING_REASON.SHARE; }
  return { level, reason, windowFraction, loggedShare, daysCovered };
}

/**
 * Seurannan kypsyys: voiko kirjattua aikaa verrata tavoitteisiin?
 *
 * Seurantajakso alkaa myöhäisimmästä: viikon maanantai, ensimmäinen
 * koskaan kirjattu päivä, `startIso` (alueen luontipäivä; sovelluskerros
 * antaa sen paikallisena päivänä). Päivät ennen jaksoa ovat tuntemattomia.
 *
 *   none         viikolle ei ole kirjauksia
 *   early        jaksosta alle 3/7 viikkoa tai kirjauksia alle 2 päivältä
 *   partial      kirjauksia alle puolelta jakson kuluneista päivistä, tai
 *                kirjattu aika alle ACTUAL_MIN_LOGGED_SHARE viitteestä, tai
 *                viitettä ei ole (ks. alignmentPolicy.js TIME_RULES)
 *   established  muuten, tai (hystereesi) saavutettu jonain aiempana
 *                jakson päivänä ja päiväkattavuus täyttyy yhä
 *
 * Aiemmat päivät arvioidaan kunkin päivän lopussa (jakso ja kirjaukset
 * siihen päivään asti). Ajastimella ja käsin kirjatut päivät ovat
 * samanarvoisia todisteita seurannasta; minuutteja ei painoteta lähteen
 * mukaan.
 *
 * @param {object} args
 * @param {number|null} [args.targetsMinutes]  aktiivisten alueiden tavoitteiden summa
 * @param {Map<string, number>|null} [args.plannedMinutesByDate]  arvioitu suunniteltu päivittäin
 * @returns {{level: string, reason: string|null, windowStart: string|null, windowFraction: number,
 *   trackedDays: number, windowDays: number, loggedSharePercent: number|null,
 *   referenceBasis: string|null, referenceMinutes: number|null,
 *   establishedSince: string|null, held: boolean, firstEntryDate: string|null}}
 */
export function trackingMaturity({
  dates, progress, actual, capacity = null, todayIso = null, startIso = null,
  targetsMinutes = null, plannedMinutesByDate = null
}) {
  const firstEntryDate = actual.firstEverEntryDate || null;
  if (!dates || dates.length === 0) {
    return { level: TRACKING.NONE, reason: null, windowStart: null, windowFraction: 0, trackedDays: 0, windowDays: 0,
      loggedSharePercent: null, referenceBasis: null, referenceMinutes: null, establishedSince: null, held: false,
      firstEntryDate };
  }
  const windowStart = [dates[0], firstEntryDate, isIsoDate(startIso) ? startIso : null]
    .filter(Boolean).sort().pop();
  const offset = dayOffset(dates, windowStart);
  // Jakson kalenteripäivät tähän päivään asti (tämä päivä mukaan lukien).
  const lastDay = isIsoDate(todayIso) && todayIso < dates[6] ? todayIso : dates[6];
  const windowDays = lastDay < windowStart ? 0 : dates.filter(date => date >= windowStart && date <= lastDay).length;
  const entryDates = (actual.entryDates || []).filter(date => date >= windowStart);
  const capacityMinutes = capacity && Number.isInteger(capacity.availableMinutes) ? capacity.availableMinutes : null;

  /** Kriteerit hetkellä, jolloin jaksosta on kulunut `elapsed` päivää ja kirjaukset päivään `upTo` asti. */
  const at = (elapsed, upTo) => {
    const tracked = entryDates.filter(date => date <= upTo);
    const trackedMinutes = tracked.reduce((sum, date) =>
      sum + ((actual.minutesByDate && actual.minutesByDate.get(date)) || 0), 0);
    const reference = loggedReference({
      capacityMinutes, targetsMinutes, plannedMinutesByDate, windowStart, lastDay: upTo, windowFraction: elapsed / 7
    });
    return { ...evaluateTracking({ elapsed, trackedDays: tracked.length, trackedMinutes, reference }), reference,
      trackedDays: tracked.length };
  };

  const now = at(Math.max(0, (progress.elapsedDays || 0) - offset), lastDay);

  // Hystereesi: jakson kuluneet päivät ennen tätä päivää, kunkin lopussa.
  let establishedSince = null;
  if (actual.entryCount > 0 && isIsoDate(todayIso)) {
    for (const date of dates) {
      if (date < windowStart || date >= todayIso || date > lastDay) continue;
      if (at(dates.indexOf(date) + 1 - offset, date).level === TRACKING.ESTABLISHED) {
        establishedSince = date;
        break;
      }
    }
  }

  let level = now.level;
  let reason = now.reason;
  let held = false;
  if (actual.entryCount === 0) {
    level = TRACKING.NONE;
    reason = null;
  } else if (level !== TRACKING.ESTABLISHED && establishedSince && now.daysCovered) {
    level = TRACKING.ESTABLISHED;
    reason = null;
    held = true;
  }
  if (level === TRACKING.ESTABLISHED && !establishedSince) establishedSince = lastDay;
  if (level !== TRACKING.ESTABLISHED) establishedSince = null;

  return {
    level, reason, windowStart, windowFraction: now.windowFraction, trackedDays: now.trackedDays, windowDays,
    loggedSharePercent: percent(now.loggedShare),
    referenceBasis: now.reference.basis,
    referenceMinutes: now.reference.minutes === null ? null : Math.round(now.reference.minutes),
    establishedSince, held, firstEntryDate
  };
}

/**
 * Suunnan alkamispäivä: aikaisin alueen luontipäivä. Jos yhdenkin alueen
 * alkua ei tiedetä, alkua ei tiedetä (null = ei rajausta).
 */
export function alignmentStartOf(areas = []) {
  const list = (areas || []).filter(area => area && area.id);
  if (list.length === 0 || list.some(area => !isIsoDate(area.startDate))) return null;
  return list.map(area => area.startDate).sort()[0];
}

/** Arvioitu suunniteltu aika päivittäin (seurannan viite, kun kapasiteettia ja tavoitteita ei ole). */
function plannedMinutesByDate(items) {
  const byDate = new Map();
  for (const item of items) {
    if (item.minutes !== null && item.date) byDate.set(item.date, (byDate.get(item.date) || 0) + item.minutes);
  }
  return byDate;
}

function neglectSignals({ areas, planned, actual, progress, dates, reference, todayIso }) {
  const signals = [];
  const actualTracked = actual.entryCount > 0;

  for (const area of areas) {
    if (!area.active || area.importance < RULES.NEGLECT_MIN_IMPORTANCE) continue;
    const target = area.targetMinutesPerWeek;
    if (!Number.isInteger(target) || target < RULES.NEGLECT_MIN_TARGET_MINUTES) continue;

    const plannedBucket = planned.byArea.get(area.id) || emptyBucket();
    // Alueen oma seurantajakso: alue ei voi jäädä huomiotta ajalta,
    // jolloin sitä ei vielä ollut, eikä päiviltä ennen ensimmäistä kirjausta.
    const tracking = trackingMaturity({ dates, progress, actual, todayIso, startIso: area.startDate || null, ...reference });

    if (tracking.level === TRACKING.ESTABLISHED) {
      const expected = target * tracking.windowFraction;
      const got = actual.byArea.get(area.id) || 0;
      const share = ratio(got, expected);
      if (share !== null && share < RULES.NEGLECT_RATIO) {
        const strong = progress.fraction >= 1 && tracking.windowFraction >= RULES.STRONG_MIN_TRACKED_FRACTION
          && share < RULES.NEGLECT_STRONG_RATIO;
        signals.push({
          kind: SIGNAL.NEGLECT, severity: strong ? SEVERITY.STRONG : SEVERITY.ATTENTION,
          areaId: area.id, basis: 'actual', rule: 'neglect.actual_below_expected',
          metrics: {
            targetMinutes: target, expectedByNowMinutes: Math.round(expected),
            actualMinutes: got, percentOfExpected: percent(share),
            weekProgressPercent: percent(progress.fraction),
            trackedPercent: percent(tracking.windowFraction), trackedFrom: tracking.windowStart,
            trackedDays: tracking.trackedDays,
            plannedMinutes: plannedBucket.knownMinutes, unknownCount: plannedBucket.unknownCount
          }
        });
      }
      continue;
    }

    // Suunnitelmaan perustuva: ennakoiva, siksi vain tiedoksi. Jos osalta
    // alueen AVOIMESTA työstä puuttuu kesto, vajetta ei väitetä:
    // tuntematon ei ole nolla (`neglect.plan_unknown`, ei kuormaa eikä
    // suojattua aikaa). Valmiiksi merkitty ilman kestoa ei laukaise sitä
    // (arviointi ei kysy valmiita); se kerrotaan tekstissä tietona.
    const plannedShare = ratio(plannedBucket.knownMinutes, target);
    if (plannedShare !== null && plannedShare < RULES.NEGLECT_RATIO) {
      signals.push({
        kind: SIGNAL.NEGLECT, severity: SEVERITY.INFO,
        areaId: area.id, basis: 'planned',
        rule: plannedBucket.openUnknownCount > 0 ? NEGLECT_PLAN_UNKNOWN : 'neglect.plan_below_target',
        metrics: {
          targetMinutes: target, plannedMinutes: plannedBucket.knownMinutes,
          percentOfTarget: percent(plannedShare), unknownCount: plannedBucket.unknownCount,
          openUnknownCount: plannedBucket.openUnknownCount,
          actualTracked, trackingLevel: tracking.level
        }
      });
    }
  }
  return signals;
}

/**
 * Suunnitelman huomiotta jääminen, jossa osa kestoista puuttuu. Ei ole
 * vaje: sitä ei käytetä suojattuun aikaan, painotukseen eikä ehdotuksiin.
 */
export const NEGLECT_PLAN_UNKNOWN = 'neglect.plan_unknown';

/** Onko havainto todettu vaje (ei `plan_unknown`)? Muut moduulit käyttävät tätä. */
export function isNeglectShortfall(signal) {
  return Boolean(signal) && signal.kind === SIGNAL.NEGLECT && signal.rule !== NEGLECT_PLAN_UNKNOWN;
}

/**
 * Alueet, jotka luotiin kirjatun ajan vertailujakson alun JÄLKEEN. Niiden
 * aiemmat päivät ovat tuntemattomia, joten toteuman jakaumassa ne eivät
 * ole mukana kumpaankaan suuntaan: ei "saa vähemmän" -väitettä, eikä
 * niiden tavoite vääristä muiden alueiden toivottua osuutta.
 */
function areasStartedAfter(areas, windowStart) {
  if (!isIsoDate(windowStart)) return new Set();
  return new Set(areas.filter(area => isIsoDate(area.startDate) && area.startDate > windowStart).map(area => area.id));
}

function distributionBasis({ areas, planned, actual, tracking }) {
  const assignedActual = actual.minutes - (actual.byArea.get(NONE_KEY) || 0);
  if (tracking.level === TRACKING.ESTABLISHED) {
    const excluded = areasStartedAfter(areas, tracking.windowStart);
    let excludedMinutes = 0;
    for (const id of excluded) excludedMinutes += actual.byArea.get(id) || 0;
    const compared = assignedActual - excludedMinutes;
    if (compared >= RULES.MISALIGNMENT_MIN_MINUTES) {
      return {
        basis: 'actual', assigned: compared, coverageAssigned: assignedActual, total: actual.minutes,
        minutesFor: id => actual.byArea.get(id) || 0, excluded
      };
    }
  }
  // Suunnitelman jakauma vain, kun riittävä osa asioista on arvioitu:
  // kahden arvioidun tehtävän jakauma ei kerro viikosta.
  const estimateCoverage = ratio(planned.estimatedCount, planned.itemCount);
  if (estimateCoverage !== null && estimateCoverage < RULES.PLAN_MIN_ESTIMATE_COVERAGE) return null;
  const noneBucket = planned.byArea.get(NONE_KEY);
  const assignedPlanned = planned.knownMinutes - (noneBucket ? noneBucket.knownMinutes : 0);
  if (assignedPlanned >= RULES.MISALIGNMENT_MIN_MINUTES) {
    return {
      basis: 'planned', assigned: assignedPlanned, total: planned.knownMinutes,
      minutesFor: id => (planned.byArea.get(id) || emptyBucket()).knownMinutes,
      estimateLimited: estimateCoverage !== null && estimateCoverage < RULES.PLAN_FULL_ESTIMATE_COVERAGE,
      estimateCoveragePercent: percent(estimateCoverage)
    };
  }
  return null;
}

function misalignmentSignals({ areas, planned, actual, neglected, tracking, progress }) {
  if (desiredShares(areas).totalMinutes <= 0) return [];
  const source = distributionBasis({ areas, planned, actual, tracking });
  if (!source) return [];
  // Toteuman jakauma vain alueista, jotka olivat olemassa koko
  // vertailujakson: toivottu osuus lasketaan niiden tavoitteista.
  const excluded = source.excluded || new Set();
  const compared = excluded.size > 0 ? areas.filter(area => !excluded.has(area.id)) : areas;
  const desired = desiredShares(compared);
  if (desired.totalMinutes <= 0) return [];

  const coverage = ratio(source.coverageAssigned ?? source.assigned, source.total);
  const weak = coverage === null || coverage < RULES.MIN_ASSIGNED_COVERAGE;
  const incomplete = weak || Boolean(source.estimateLimited);
  const signals = [];

  for (const area of compared) {
    // Suunnitelman jakauma: alue, jonka avoimelta työltä puuttuu kesto,
    // ei saa osuusväitettä — tuntematon ei ole nolla. Se näkyy
    // arvioimattomana (laatu, `neglect.plan_unknown`, katsauksen
    // "Ei tiedossa"), ei poikkeamana.
    if (source.basis === 'planned' && (planned.byArea.get(area.id) || emptyBucket()).openUnknownCount > 0) continue;
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
    // Versio 3: myös "vie enemmän" ohitetaan samalle alueelle — alue ei
    // voi samaan aikaan jäädä huomiotta ja viedä liikaa (ristiriita).
    if (neglected.has(area.id)) continue;

    let severity = Math.abs(points) >= RULES.MISALIGNMENT_STRONG_POINTS ? SEVERITY.STRONG : SEVERITY.ATTENTION;
    if (source.basis === 'planned' && severity === SEVERITY.STRONG) severity = SEVERITY.ATTENTION;
    // Kesken viikon toteuma on vasta osa viikkoa: vahva vasta viikon jälkeen.
    if (source.basis === 'actual' && progress.fraction < 1 && severity === SEVERITY.STRONG) severity = SEVERITY.ATTENTION;
    if (incomplete) severity = SEVERITY.INFO;

    const metrics = {
      direction, desiredPercent: Math.round(want * 100), actualPercent: Math.round(got * 100),
      deviationPoints: points, basisMinutes: source.minutesFor(area.id),
      assignedMinutes: source.assigned, coveragePercent: percent(coverage), incomplete
    };
    if (source.basis === 'planned') metrics.estimateCoveragePercent = source.estimateCoveragePercent;
    if (excluded.size > 0) {
      metrics.excludedAreaCount = excluded.size;
      metrics.comparedTargetsMinutes = desired.totalMinutes;
    }
    signals.push({
      kind: SIGNAL.MISALIGNMENT, severity, areaId: area.id, basis: source.basis,
      rule: 'misalignment.share_deviation', metrics
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

export function dataQuality({ areas, capacity, planned, actual, tracking = null }) {
  const reasons = [];
  const activeAreas = areas.filter(area => area.active);
  if (activeAreas.length === 0) reasons.push('no_areas');
  else if (!activeAreas.some(area => area.targetMinutesPerWeek > 0)) reasons.push('no_targets');
  if (!capacity || !Number.isInteger(capacity.availableMinutes)) reasons.push('no_capacity');

  const estimateCoverage = ratio(planned.estimatedCount, planned.itemCount);
  // Arvioitavissa oleva puute: avoimet asiat ilman kestoa. Valmiiksi
  // merkityt ilman kestoa kerrotaan erikseen tietona (arviointityönkulku
  // ei kysy niitä, joten "arvioi" olisi umpikuja).
  const openUnknown = planned.openUnknownCount ?? planned.unknownCount;
  const completedUnknown = Math.max(0, planned.unknownCount - openUnknown);
  if (openUnknown > 0) reasons.push('unestimated_work');
  if (completedUnknown > 0) reasons.push('unestimated_completed');

  const plannedNone = planned.byArea.get(NONE_KEY) || emptyBucket();
  const plannedAssignedCoverage = ratio(planned.knownMinutes - plannedNone.knownMinutes, planned.knownMinutes);
  // Tarkoituksella ilman aluetta jätetty ei ole aineiston puute: käyttäjä
  // päätti sen, eikä siitä muistuteta uudelleen.
  const optedOut = planned.optedOutCount || 0;
  const openUnassigned = Math.max(0, plannedNone.itemCount - optedOut);
  if (openUnassigned > 0) reasons.push('unassigned_work');

  const actualNone = actual.byArea.get(NONE_KEY) || 0;
  const actualAssignedCoverage = ratio(actual.minutes - actualNone, actual.minutes);
  if (actual.entryCount === 0) reasons.push('no_actual');
  else if (actualNone > 0) reasons.push('unassigned_actual');
  // Versio 3: kirjauksia on, mutta vasta osalta viikosta. Kirjaamattomat
  // päivät ovat tuntemattomia, joten toteumaa ei vielä verrata.
  if (tracking && (tracking.level === TRACKING.EARLY || tracking.level === TRACKING.PARTIAL)) {
    reasons.push('partial_actual');
  }

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
    openUnestimatedCount: openUnknown,
    completedUnestimatedCount: completedUnknown,
    unassignedPlannedCount: openUnassigned,
    intentionallyUnassignedCount: optedOut,
    unassignedActualMinutes: actualNone,
    actualTracked: actual.entryCount > 0,
    trackingLevel: tracking ? tracking.level : null,
    // Miksi ei vakiintunut: laatu sanoittaa "vain N päivänä" tai "vasta X %".
    trackingReason: tracking ? tracking.reason ?? null : null,
    trackedDays: tracking ? tracking.trackedDays : null,
    trackingWindowDays: tracking ? tracking.windowDays : null,
    loggedSharePercent: tracking ? tracking.loggedSharePercent : null,
    loggedShareBasis: tracking ? tracking.referenceBasis ?? null : null
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
 * @param {Array}  [input.areas]     alueet; valinnainen `startDate` (paikallinen
 *                                   luontipäivä) rajaa alueen seurantajakson
 */
export function analyzeWeek({
  weekStart, todayIso, nowMinutes = 0,
  areas = [], goals = [], projects = [], tasks = [], routines = [], exceptions = [],
  timeEntries = [], capacity = null, itemSettings = []
} = {}) {
  const monday = weekStartOf(weekStart);
  const dates = weekDates(monday);
  const index = buildAttributionIndex({ areas, goals, projects, routines });
  const settings = itemSettings instanceof Map ? itemSettings : indexItemSettings(itemSettings);
  const items = plannedItems({ weekStart: monday, tasks, routines, exceptions, index, settings });
  const planned = summarizePlanned(items);
  const actual = summarizeActual({ weekStart: monday, timeEntries, tasks, index });
  const progress = weekProgress(monday, todayIso, nowMinutes);
  const cleanAreas = (areas || []).filter(area => area && area.id);
  const weekCapacity = capacity && capacity.weekStart === monday ? capacity : null;
  const energy = summarizeEnergy(items);

  const desired = desiredShares(cleanAreas);
  // Kirjatun ajan viite (sääntöversio 3): kapasiteetti, tavoitteiden
  // summa tai jakson päiville päivätty arvioitu työ — käyttäjän omat luvut.
  const reference = {
    capacity: weekCapacity, targetsMinutes: desired.totalMinutes,
    plannedMinutesByDate: plannedMinutesByDate(items)
  };
  // Koko viikon seuranta alkaa aikaisintaan Suunnan käyttöönotosta
  // (aikaisin alueen luontipäivä); alueen oma jakso voi alkaa myöhemmin.
  const tracking = trackingMaturity({
    dates, progress, actual, todayIso, startIso: alignmentStartOf(cleanAreas), ...reference
  });
  const neglect = neglectSignals({ areas: cleanAreas, planned, actual, progress, dates, reference, todayIso });
  const neglected = new Set(neglect.filter(isNeglectShortfall).map(signal => signal.areaId));
  const timeOverload = overloadSignals({ capacity: weekCapacity, planned });
  const signals = [
    ...timeOverload,
    ...neglect,
    ...misalignmentSignals({ areas: cleanAreas, planned, actual, neglected, tracking, progress }),
    ...energySignals({
      energy, capacity: weekCapacity,
      timeOverloaded: timeOverload.some(signal => signal.severity !== SEVERITY.INFO)
    }),
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
  const budget = weekCapacity && Number.isInteger(weekCapacity.energyBudgetMinutes)
    ? weekCapacity.energyBudgetMinutes : null;
  return {
    policyVersion: POLICY_VERSION,
    weekStart: monday,
    weekEnd: dates[6] || null,
    nextWeekStart: nextWeekStart(monday),
    progress,
    capacity: {
      declared: Boolean(weekCapacity),
      availableMinutes: weekCapacity ? weekCapacity.availableMinutes : null,
      energyLevel: weekCapacity ? weekCapacity.energyLevel : null,
      energyBudgetMinutes: budget,
      remainingMinutes: weekCapacity ? weekCapacity.availableMinutes - planned.knownMinutes : null
    },
    energy: {
      ...energy,
      budgetMinutes: budget,
      remainingMinutes: budget === null ? null : budget - energy.heavyMinutes
    },
    planned: {
      knownMinutes: planned.knownMinutes, unknownCount: planned.unknownCount,
      openUnknownCount: planned.openUnknownCount,
      itemCount: planned.itemCount, estimatedCount: planned.estimatedCount
    },
    actual: {
      minutes: actual.minutes, entryCount: actual.entryCount, daysWithEntries: actual.daysWithEntries,
      bySource: { ...actual.bySource }, entryDates: [...actual.entryDates]
    },
    tracking,
    areas: areaRows,
    unassigned: {
      plannedMinutes: none.knownMinutes, plannedUnknown: none.unknownCount, plannedItems: none.itemCount,
      intentionalItems: planned.optedOutCount,
      actualMinutes: actual.byArea.get(NONE_KEY) || 0
    },
    items,
    activeGoalIds: activeGoals(items, actual, index),
    dataQuality: dataQuality({ areas: cleanAreas, capacity: weekCapacity, planned, actual, tracking }),
    signals
  };
}

/** Päivänäkymän yksi havainto: vahvin, tai null. */
export function primarySignal(analysis) {
  return analysis && analysis.signals.length ? analysis.signals[0] : null;
}
