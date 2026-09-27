// Todellisuus / ajautuminen v2: suunnitelma verrattuna siihen, mitä
// arjessa oikeasti tapahtui (aalto L, docs/MENTAL-LOAD-CORE.md).
//
// Puhdas moduuli: ei DOM:ia, ei verkkoa, ei kelloa, EI TEKOÄLYÄ.
//
// =====================================================================
// MITÄ TÄMÄ LISÄÄ
// =====================================================================
//
// Suunnan viisi havaintoa (OVERLOAD, NEGLECT, MISALIGNMENT, TARGET_TENSION,
// ENERGY_OVERLOAD; src/domain/alignment.js) säilyvät ennallaan. Tämä moduuli
// lisää kuusi determinististä havaintoa, joiden kynnykset ovat
// politiikkamoduulissa (alignmentPolicy.DRIFT_RULES):
//
//   BACKLOG_GROWTH      tallessa olevien avointen määrä kasvaa
//   CAPACITY_BIAS       suljettujen viikkojen suunnitelma on toistuvasti toteumaa suurempi
//   OWN_TIME_EROSION    suojattuun omaan aikaan on sijoittunut muuta
//   FREE_TIME_EROSION   vapaa-ajan vähimmäismäärä ei toteudu tai velvoitteita vapaa-aikaan
//   VACATION_INTRUSION  joustavia asioita päivätty lomalle
//   PLAN_CHURN          samaa asiaa siirretään yhä uudelleen
//
// =====================================================================
// EI SYYLLISTÄ, VAAN SÄÄTÄÄ SEURAAVAA SUUNNITELMAA
// =====================================================================
//
// Jokainen havainto kantaa `adjustment`-kentän: konkreettinen muutos
// SEURAAVAAN suunnitelmaan (arkistoi tai siirrä "Ei vielä", pienempi
// kapasiteetti, siirrä joustava asia pois suojatusta ajasta, suojaa ilta,
// siirrä loman jälkeen, päätä kerran). Kieli on toteavaa: suunnitelma oli
// liian suuri, ei käyttäjä. Testit vartioivat, ettei tekstissä ole
// syyllistäviä sanoja.
//
// KIINTEÄ MENO EI OLE TUNKEUTUJA LOMALLA. Loma estää vain automaattisen
// sijoittamisen (omistajan päätös 5): kiinteät menot pysyvät näkyvissä.
//
// TUNTEMATON ON TUNTEMATON. Viikko, jolta ei ole toteumaa lainkaan (ei
// kirjauksia eikä valmiita arvioituja tehtäviä), ei ole "0 minuuttia" vaan
// ei vertailukelpoinen.

import { durationOf, isIsoDate, toMinutes } from './task.js';
import { isFixedTimed } from './lifeLoad.js';
import { deriveNature, NATURE, isEssentialNature } from './itemNature.js';
import { categoryOwnerArea, formatMinutes, countOf } from './lifeArea.js';
import { weekStartOf, weekDates, nextWeekStart } from './weeklyCapacity.js';
import { addDaysIso } from './fiTemporal.js';
import {
  periodBlocks, vacationOn, weeklyFreeTimeTargetMinutes, PROTECTED_KIND, PERIOD_STRENGTH
} from './protectedTime.js';
import { BLOCK_KIND } from './scheduler.js';
import { DRIFT_RULES } from './alignmentPolicy.js';

export const DRIFT_SIGNAL = Object.freeze({
  BACKLOG_GROWTH: 'backlog_growth',
  CAPACITY_BIAS: 'capacity_bias',
  OWN_TIME_EROSION: 'own_time_erosion',
  FREE_TIME_EROSION: 'free_time_erosion',
  VACATION_INTRUSION: 'vacation_intrusion',
  PLAN_CHURN: 'plan_churn'
});
export const DRIFT_SIGNALS = Object.freeze(Object.values(DRIFT_SIGNAL));

export const DRIFT_SEVERITY = Object.freeze({ INFO: 'info', ATTENTION: 'attention' });

/**
 * Säädön lajit. Näkymä kytkee ne olemassa oleviin toimintoihin:
 *
 *   review_backlog       tehtävä: Ei vielä (setTaskHorizon) / Arkistoi (archiveTask) / Avaa
 *   set_capacity         ensi viikon kapasiteetti (saveWeeklyCapacity vahvistuksen kautta)
 *   move_items           avaa tehtävä siirrettäväksi (joustavat; kiinteät jäävät)
 *   protect_evening      Profiili → Suojattu aika (ei kirjoita mitään)
 *   move_after_vacation  tehtävä: Myöhemmin (setTaskHorizon LATER) / Avaa
 *   decide_once          tehtävä: Ei vielä / Myöhemmin / Arkistoi / Avaa (pilkkominen)
 *   keep_block           ei kirjoita mitään: vinkki seuraavaan suunnitelmaan
 */
export const DRIFT_ADJUSTMENT = Object.freeze({
  REVIEW_BACKLOG: 'review_backlog',
  SET_CAPACITY: 'set_capacity',
  MOVE_ITEMS: 'move_items',
  PROTECT_EVENING: 'protect_evening',
  MOVE_AFTER_VACATION: 'move_after_vacation',
  DECIDE_ONCE: 'decide_once',
  KEEP_BLOCK: 'keep_block'
});

export const DRIFT_TITLES = Object.freeze({
  [DRIFT_SIGNAL.BACKLOG_GROWTH]: 'Tallessa olevien asioiden määrä kasvaa',
  [DRIFT_SIGNAL.CAPACITY_BIAS]: 'Suunnitelmat ovat olleet toteumaa suurempia',
  [DRIFT_SIGNAL.OWN_TIME_EROSION]: 'Omaan aikaan on sijoittunut muuta',
  [DRIFT_SIGNAL.FREE_TIME_EROSION]: 'Vapaa-aikaa jää suunniteltua vähemmän',
  [DRIFT_SIGNAL.VACATION_INTRUSION]: 'Lomalle on päivätty joustavia asioita',
  [DRIFT_SIGNAL.PLAN_CHURN]: 'Samoja asioita siirretään uudelleen'
});

const SEVERITY_RANK = Object.freeze({ attention: 2, info: 1 });
const KIND_RANK = Object.freeze({
  capacity_bias: 6, free_time_erosion: 5, own_time_erosion: 4, vacation_intrusion: 3, plan_churn: 2, backlog_growth: 1
});

/** Luonteet, jotka sopivat omaan ja vapaa-aikaan (eivät ole tunkeutumista). */
const RESTFUL_NATURES = new Set([NATURE.WELLBEING, NATURE.ENJOYMENT, NATURE.FREE_TIME]);

const EMPTY = Object.freeze([]);
const DEFAULT_TIMED_MINUTES = 30;
const ISO_PREFIX = /^(\d{4}-\d{2}-\d{2})/;

function listOf(value) {
  return Array.isArray(value) ? value.filter(Boolean) : EMPTY;
}

/** Oletus: aikaleiman ISO-päivä sellaisenaan (sovellus antaa paikallisen päivän). */
function defaultDateOf(timestamp) {
  if (typeof timestamp !== 'string') return null;
  const match = ISO_PREFIX.exec(timestamp);
  return match && isIsoDate(match[1]) ? match[1] : null;
}

function safeDateOf(dateOf) {
  const fn = typeof dateOf === 'function' ? dateOf : defaultDateOf;
  return value => {
    try {
      const result = fn(value);
      return isIsoDate(result) ? result : null;
    } catch {
      return null;
    }
  };
}

function isOpen(task) {
  return Boolean(task) && !task.completed && !task.isWake && !task.archivedAt;
}

function shortDate(iso) {
  if (!isIsoDate(iso)) return '';
  const [, month, day] = iso.split('-').map(Number);
  return `${day}.${month}.`;
}

function roundTo(value, step) {
  return Math.round(value / step) * step;
}

function titleOf(item) {
  const text = item && typeof item.title === 'string' ? item.title.trim() : '';
  return text || 'Nimetön';
}

function freezeSignal(signal) {
  return Object.freeze({
    ...signal,
    metrics: Object.freeze({ ...signal.metrics }),
    items: Object.freeze((signal.items || EMPTY).map(item => Object.freeze({ ...item }))),
    adjustment: Object.freeze({ ...signal.adjustment, payload: Object.freeze({ ...(signal.adjustment.payload || {}) }) })
  });
}

function build(kind, { severity, rule, reason, why, metrics, items = EMPTY, adjustment }) {
  return freezeSignal({ kind, severity, rule, title: DRIFT_TITLES[kind], reason, why, metrics, items, adjustment });
}

// ------------------------------------------------------------ luonne

function natureContext({ goals = EMPTY, projects = EMPTY, lifeAreas = EMPTY } = {}) {
  const areas = listOf(lifeAreas);
  return {
    areas,
    areasById: new Map(areas.filter(area => area.id).map(area => [area.id, area])),
    goalsById: new Map(listOf(goals).filter(goal => goal.id).map(goal => [goal.id, goal])),
    projectsById: new Map(listOf(projects).filter(project => project.id).map(project => [project.id, project]))
  };
}

function areaOf(item, context) {
  let goal = item.goalId ? context.goalsById.get(item.goalId) : null;
  if (!goal && item.projectId) {
    const project = context.projectsById.get(item.projectId);
    goal = project && project.goalId ? context.goalsById.get(project.goalId) : null;
  }
  if (goal && goal.lifeAreaId && context.areasById.has(goal.lifeAreaId)) return context.areasById.get(goal.lifeAreaId);
  try {
    return categoryOwnerArea(context.areas, item.category);
  } catch {
    return null;
  }
}

function natureOf(item, context) {
  return deriveNature(item, { kind: 'task', area: areaOf(item, context) }).nature;
}

// ------------------------------------------------------ BACKLOG_GROWTH

/**
 * Tallessa olevien avointen määrä kasvaa: jakson uudet miinus ratkenneet
 * (valmis: updatedAt, arkistoitu: archivedAt) >= kynnys JA avoimia on
 * vähintään kynnyksen verran.
 */
export function backlogGrowthSignal({ tasks = EMPTY, todayIso, dateOf = null } = {}) {
  if (!isIsoDate(todayIso)) return null;
  const day = safeDateOf(dateOf);
  const from = addDaysIso(todayIso, -(DRIFT_RULES.BACKLOG_WINDOW_DAYS - 1));
  const inWindow = iso => iso !== null && iso >= from && iso <= todayIso;
  let created = 0;
  let resolved = 0;
  const open = [];
  for (const task of listOf(tasks)) {
    if (task.isWake) continue;
    if (inWindow(day(task.createdAt))) created += 1;
    if (task.archivedAt ? inWindow(day(task.archivedAt)) : (task.completed && inWindow(day(task.updatedAt)))) resolved += 1;
    if (isOpen(task)) open.push(task);
  }
  const net = created - resolved;
  if (net < DRIFT_RULES.BACKLOG_MIN_NET_GROWTH || open.length < DRIFT_RULES.BACKLOG_MIN_OPEN) return null;

  // Läpikäytävät: vanhimmat joustavat avoimet ilman määräaikaa ja odotusta.
  const candidates = open
    .filter(task => !isFixedTimed(task) && !task.deadline && task.horizon !== 'WAITING' && task.horizon !== 'NOT_YET')
    .sort((a, b) => String(day(a.createdAt) || '9999').localeCompare(String(day(b.createdAt) || '9999'))
      || String(a.id).localeCompare(String(b.id)))
    .slice(0, DRIFT_RULES.BACKLOG_REVIEW_CANDIDATES);
  return build(DRIFT_SIGNAL.BACKLOG_GROWTH, {
    severity: net >= DRIFT_RULES.BACKLOG_ATTENTION_NET_GROWTH ? DRIFT_SEVERITY.ATTENTION : DRIFT_SEVERITY.INFO,
    rule: 'drift.backlog_net_growth',
    reason: `Viimeisen ${DRIFT_RULES.BACKLOG_WINDOW_DAYS} päivän aikana on tullut ${countOf(created, 'uusi asia', 'uutta asiaa')} `
      + `ja ratkennut ${resolved}. Tallessa on nyt ${countOf(open.length, 'avoin asia', 'avointa asiaa')}. `
      + 'Kaikki on tallessa; muutaman vanhan asian voi siirtää kohtaan Ei vielä tai arkistoida.',
    why: `Uusia on vähintään ${DRIFT_RULES.BACKLOG_MIN_NET_GROWTH} enemmän kuin ratkenneita, ja avoimia on vähintään `
      + `${DRIFT_RULES.BACKLOG_MIN_OPEN}. Ratkennut = valmis tai arkistoitu jakson aikana.`,
    metrics: { windowDays: DRIFT_RULES.BACKLOG_WINDOW_DAYS, created, resolved, netGrowth: net, openCount: open.length },
    items: candidates.map(task => ({ id: task.id, title: titleOf(task) })),
    adjustment: {
      type: DRIFT_ADJUSTMENT.REVIEW_BACKLOG,
      label: 'Käy läpi muutama vanha asia: Ei vielä tai arkistoi',
      detail: 'Voit myös keventää ensi viikon suunnitelmaa. Arkistoitu on palautettavissa.',
      payload: { taskIds: candidates.map(task => task.id) }
    }
  });
}

// ------------------------------------------------------- CAPACITY_BIAS

function completedTaskMinutes(tasks, from, to) {
  let minutes = 0;
  for (const task of listOf(tasks)) {
    if (!task.completed || task.isWake || !isIsoDate(task.date) || task.date < from || task.date > to) continue;
    const known = durationOf(task);
    if (Number.isFinite(known) && known > 0) minutes += known;
  }
  return minutes;
}

function loggedMinutes(entries, from, to) {
  let minutes = 0;
  for (const entry of listOf(entries)) {
    if (!Number.isInteger(entry.minutes) || entry.minutes <= 0 || !isIsoDate(entry.entryDate)) continue;
    if (entry.entryDate >= from && entry.entryDate <= to) minutes += entry.minutes;
  }
  return minutes;
}

/**
 * Suljettujen viikkojen suunnitelma (weekly_plans.plannedMinutes
 * sulkemishetkellä) verrattuna toteumaan: kirjattu aika TAI valmiiksi
 * merkittyjen arvioitujen tehtävien kesto, kumpi on suurempi (varovainen:
 * osittain kirjaava käyttäjä ei saa "harhaa"). Viikko ilman toteumaa ei ole
 * vertailukelpoinen.
 */
export function capacityBiasSignal({ weeklyPlans = EMPTY, timeEntries = EMPTY, tasks = EMPTY, todayIso, weekStart = null } = {}) {
  if (!isIsoDate(todayIso)) return null;
  const closed = listOf(weeklyPlans)
    .filter(plan => plan.closedAt && isIsoDate(plan.weekStart) && Number.isInteger(plan.plannedMinutes)
      && plan.plannedMinutes > 0 && addDaysIso(plan.weekStart, 6) < todayIso)
    .sort((a, b) => (a.weekStart < b.weekStart ? 1 : a.weekStart > b.weekStart ? -1 : 0));
  const weeks = [];
  const seen = new Set();
  for (const plan of closed) {
    if (seen.has(plan.weekStart)) continue;
    seen.add(plan.weekStart);
    const to = addDaysIso(plan.weekStart, 6);
    const actual = Math.max(loggedMinutes(timeEntries, plan.weekStart, to), completedTaskMinutes(tasks, plan.weekStart, to));
    if (actual <= 0) continue;
    weeks.push({ weekStart: plan.weekStart, plannedMinutes: plan.plannedMinutes, actualMinutes: actual });
    if (weeks.length >= DRIFT_RULES.CAPACITY_BIAS_MAX_WEEKS) break;
  }
  if (weeks.length < DRIFT_RULES.CAPACITY_BIAS_MIN_WEEKS) return null;
  const planned = weeks.reduce((sum, week) => sum + week.plannedMinutes, 0);
  const actual = weeks.reduce((sum, week) => sum + week.actualMinutes, 0);
  const overWeeks = weeks.filter(week => week.plannedMinutes >= week.actualMinutes * DRIFT_RULES.CAPACITY_BIAS_RATIO).length;
  const ratio = planned / actual;
  const gapPerWeek = (planned - actual) / weeks.length;
  if (overWeeks < DRIFT_RULES.CAPACITY_BIAS_MIN_OVER_WEEKS || ratio < DRIFT_RULES.CAPACITY_BIAS_RATIO
    || gapPerWeek < DRIFT_RULES.CAPACITY_BIAS_MIN_GAP_MINUTES) return null;

  const percent = Math.max(5, roundTo((ratio - 1) * 100, 5));
  const averageActual = actual / weeks.length;
  const suggested = Math.max(DRIFT_RULES.CAPACITY_BIAS_MIN_SUGGESTION_MINUTES,
    roundTo(averageActual, DRIFT_RULES.CAPACITY_BIAS_ROUND_MINUTES));
  const monday = weekStartOf(weekStart || todayIso);
  const next = monday ? nextWeekStart(monday) : null;
  return build(DRIFT_SIGNAL.CAPACITY_BIAS, {
    severity: ratio >= DRIFT_RULES.CAPACITY_BIAS_ATTENTION_RATIO ? DRIFT_SEVERITY.ATTENTION : DRIFT_SEVERITY.INFO,
    rule: 'drift.capacity_plan_exceeds_actual',
    reason: `Suunnitelmat ovat olleet noin ${percent} % suurempia kuin toteuma `
      + `(${countOf(weeks.length, 'viimeisin suljettu viikko', 'viimeisintä suljettua viikkoa')}). `
      + 'Ensi viikon kapasiteettia voi pienentää.',
    why: `Viikon suunnitelma sulkemishetkellä oli vähintään ${Math.round((DRIFT_RULES.CAPACITY_BIAS_RATIO - 1) * 100)} % `
      + `toteumaa suurempi vähintään ${DRIFT_RULES.CAPACITY_BIAS_MIN_OVER_WEEKS} viikolla. Toteuma on kirjattu aika tai `
      + 'valmiiksi merkittyjen arvioitujen tehtävien kesto (suurempi). Viikot ilman toteumaa eivät ole mukana.',
    metrics: {
      weeks: weeks.length, overWeeks, plannedMinutes: planned, actualMinutes: actual,
      percentOver: percent, averageActualMinutes: Math.round(averageActual), suggestedMinutes: suggested
    },
    items: weeks.map(week => ({ id: week.weekStart, title: `Viikko ${shortDate(week.weekStart)}` })),
    adjustment: {
      type: DRIFT_ADJUSTMENT.SET_CAPACITY,
      label: `Pienennetäänkö ensi viikon kapasiteetiksi noin ${formatMinutes(suggested)}?`,
      detail: `Toteuma on ollut keskimäärin ${formatMinutes(averageActual)} viikossa. Voit pitää nykyisen arviosi — valitse itse.`,
      payload: { weekStart: next, availableMinutes: suggested }
    }
  });
}

// ----------------------------------------------- suojatun ajan lohkot

function weekBlocks({ blocks = null, periods = EMPTY, dates }) {
  const source = Array.isArray(blocks) ? blocks : periodBlocks({ periods, from: dates[0], to: dates[6] });
  const days = new Set(dates);
  return listOf(source).filter(block => days.has(block.date)
    && Number.isInteger(block.startMinute) && Number.isInteger(block.endMinute) && block.endMinute > block.startMinute);
}

/** Viikon ajastetut asiat: avoimet ajastetut tehtävät ja ajastetut menot. */
function timedItems({ tasks = EMPTY, events = EMPTY, dates, context }) {
  const days = new Set(dates);
  const items = [];
  for (const task of listOf(tasks)) {
    if (!isOpen(task) || !task.time || !days.has(task.date)) continue;
    const start = toMinutes(task.time);
    if (!Number.isFinite(start)) continue;
    const known = durationOf(task);
    const minutes = Number.isFinite(known) && known > 0 ? known : DEFAULT_TIMED_MINUTES;
    items.push({
      id: task.id, title: titleOf(task), date: task.date, start, end: start + minutes,
      kind: 'task', auto: task.schedulingState === 'auto', nature: natureOf(task, context)
    });
  }
  for (const event of listOf(events)) {
    if (event.allDay || !days.has(event.date) || !Number.isFinite(event.startMinute) || !Number.isFinite(event.endMinute)) continue;
    items.push({
      id: event.id, title: titleOf(event), date: event.date, start: event.startMinute, end: event.endMinute,
      kind: 'event', auto: false, nature: natureOf(event, context)
    });
  }
  return items;
}

function overlapMinutes(item, block) {
  if (item.date !== block.date) return 0;
  return Math.max(0, Math.min(item.end, block.endMinute) - Math.max(item.start, block.startMinute));
}

/**
 * Suojattuun lohkoon sijoittuneet asiat. Lepoon sopiva luonne (hyvinvointi,
 * ilo, vapaa-aika) ei ole tunkeutumista. "Pääosin vapaa" (soft) sallii oman
 * valinnan: siihen lasketaan vain automaatin sijoittamat tehtävät.
 */
function intrusions(items, blocks) {
  const byItem = new Map();
  let minutes = 0;
  for (const block of blocks) {
    const soft = block.strength === PERIOD_STRENGTH.SOFT;
    for (const item of items) {
      if (RESTFUL_NATURES.has(item.nature)) continue;
      if (soft && !(item.kind === 'task' && item.auto)) continue;
      const overlap = overlapMinutes(item, block);
      if (overlap <= 0) continue;
      minutes += overlap;
      const current = byItem.get(item.id);
      if (current) current.minutes += overlap;
      else byItem.set(item.id, { ...item, minutes: overlap });
    }
  }
  const list = [...byItem.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)
    || a.start - b.start || String(a.id).localeCompare(String(b.id)));
  return { minutes, list };
}

function blockMinutes(blocks) {
  return blocks.reduce((sum, block) => sum + (block.endMinute - block.startMinute), 0);
}

function movableTaskIds(list, todayIso) {
  return list.filter(item => item.kind === 'task' && (!todayIso || item.date >= todayIso)).map(item => item.id);
}

// ---------------------------------------------------- OWN_TIME_EROSION

export function ownTimeErosionSignal({
  weekStart, todayIso = null, tasks = EMPTY, events = EMPTY, blocks = null, periods = EMPTY,
  goals = EMPTY, projects = EMPTY, lifeAreas = EMPTY
} = {}) {
  const monday = weekStartOf(weekStart);
  if (!monday) return null;
  const dates = weekDates(monday);
  const own = weekBlocks({ blocks, periods, dates }).filter(block => block.blockKind === BLOCK_KIND.OWN_TIME);
  if (own.length === 0) return null;
  const context = natureContext({ goals, projects, lifeAreas });
  const { minutes, list } = intrusions(timedItems({ tasks, events, dates, context }), own);
  if (minutes < DRIFT_RULES.OWN_TIME_MIN_INTRUSION_MINUTES) return null;
  const total = blockMinutes(own);
  const share = total > 0 ? minutes / total : 1;
  const movable = movableTaskIds(list, todayIso);
  return build(DRIFT_SIGNAL.OWN_TIME_EROSION, {
    severity: share >= DRIFT_RULES.OWN_TIME_ATTENTION_SHARE ? DRIFT_SEVERITY.ATTENTION : DRIFT_SEVERITY.INFO,
    rule: 'drift.own_time_overlapped',
    reason: `Suojattuun omaan aikaan on tällä viikolla sijoittunut ${countOf(list.length, 'asia', 'asiaa')}, `
      + `yhteensä ${formatMinutes(minutes)} (${Math.round(share * 100)} % viikon omasta ajasta). `
      + (movable.length > 0 ? 'Joustavat asiat voi siirtää muualle, jolloin oma aika pysyy omana.'
        : 'Ensi viikon suunnitelmassa oman ajan voi pitää vapaana.'),
    why: `Oma aika on suojattu lohko. Siihen osuneet tehtävät ja menot (ei hyvinvointi, ilo tai vapaa-aika) lasketaan, `
      + `kun päällekkäisyyttä on vähintään ${DRIFT_RULES.OWN_TIME_MIN_INTRUSION_MINUTES} min. `
      + 'Pääosin vapaaseen lohkoon lasketaan vain automaattisesti sijoitetut tehtävät.',
    metrics: {
      ownMinutes: total, intrudedMinutes: minutes, sharePercent: Math.round(share * 100),
      intruderCount: list.length, movableCount: movable.length
    },
    items: list.map(item => ({ id: item.id, title: item.title, date: item.date, kind: item.kind, minutes: item.minutes })),
    adjustment: movable.length > 0
      ? {
        type: DRIFT_ADJUSTMENT.MOVE_ITEMS,
        label: 'Siirrä joustavat asiat pois omasta ajasta',
        detail: 'Kiinteät menot jäävät ennalleen. Oma aika pysyy suojattuna.',
        payload: { taskIds: movable }
      }
      : {
        type: DRIFT_ADJUSTMENT.KEEP_BLOCK,
        label: 'Pidä oma aika vapaana ensi viikon suunnitelmassa',
        detail: 'Mitään ei muuteta nyt.',
        payload: {}
      }
  });
}

// --------------------------------------------------- FREE_TIME_EROSION

/**
 * Vapaa-aika jää suunniteltua vähemmäksi:
 *   (a) velvoitteita on sijoittunut suojattuihin vapaa-ajan lohkoihin
 *       (suojattu ilta, sunnuntai, "ei velvoitteita klo X jälkeen"), tai
 *   (b) viikon vähimmäisvapaa-aika (weekly_target) ei toteudu:
 *       suojatut lohkot − niihin osuneet + varaus − (joustava työ, joka ei
 *       mahdu kapasiteettiin ja vie siksi varauksen) < tavoite.
 */
export function freeTimeErosionSignal({
  weekStart, todayIso = null, tasks = EMPTY, events = EMPTY, blocks = null, periods = EMPTY,
  goals = EMPTY, projects = EMPTY, lifeAreas = EMPTY, overflowMinutes = 0
} = {}) {
  const monday = weekStartOf(weekStart);
  if (!monday) return null;
  const dates = weekDates(monday);
  const all = weekBlocks({ blocks, periods, dates });
  const free = all.filter(block => block.blockKind === BLOCK_KIND.FREE_TIME);
  const restful = all.filter(block => block.blockKind === BLOCK_KIND.FREE_TIME
    || block.blockKind === BLOCK_KIND.OWN_TIME || block.blockKind === BLOCK_KIND.VACATION);
  const target = weeklyFreeTimeTargetMinutes(periods);
  if (free.length === 0 && target === null) return null;

  const context = natureContext({ goals, projects, lifeAreas });
  const items = timedItems({ tasks, events, dates, context });
  const inFree = intrusions(items, free);
  const inRestful = intrusions(items, restful);
  const covered = blockMinutes(restful);
  const reserve = target === null ? 0 : Math.max(0, target - covered);
  const overflow = Number.isFinite(overflowMinutes) && overflowMinutes > 0 ? Math.round(overflowMinutes) : 0;
  const achieved = Math.max(0, covered - inRestful.minutes) + Math.max(0, reserve - overflow);
  const shortfall = target === null ? 0 : Math.max(0, target - achieved);
  const targetMissed = target !== null && shortfall >= DRIFT_RULES.FREE_TIME_MIN_SHORTFALL_MINUTES;
  const obligations = inFree.minutes >= DRIFT_RULES.FREE_TIME_MIN_INTRUSION_MINUTES;
  if (!targetMissed && !obligations) return null;

  const freeTotal = blockMinutes(free);
  const share = freeTotal > 0 ? inFree.minutes / freeTotal : 0;
  const movable = movableTaskIds(inFree.list, todayIso);
  const parts = [];
  if (targetMissed) {
    parts.push(`Viikon vapaa-ajan vähimmäismääräksi olet valinnut ${formatMinutes(target)}; suunnitelman mukaan sitä `
      + `jää noin ${formatMinutes(achieved)}.`);
  }
  if (obligations) {
    parts.push(`Suojattuun vapaa-aikaan on sijoittunut ${countOf(inFree.list.length, 'velvoite', 'velvoitetta')}, `
      + `yhteensä ${formatMinutes(inFree.minutes)}.`);
  }
  parts.push(targetMissed ? 'Ensi viikolle voi suojata yhden illan etukäteen.' : 'Velvoitteet voi siirtää aiemmaksi päivällä.');
  return build(DRIFT_SIGNAL.FREE_TIME_EROSION, {
    severity: targetMissed || share >= DRIFT_RULES.FREE_TIME_ATTENTION_SHARE ? DRIFT_SEVERITY.ATTENTION : DRIFT_SEVERITY.INFO,
    rule: targetMissed ? 'drift.free_time_target_not_met' : 'drift.free_time_obligations_in_block',
    reason: parts.join(' '),
    why: 'Vapaa-aika lasketaan suojatuista lohkoista (vapaa-aika, oma aika, loma), joista vähennetään niihin osuneet '
      + 'velvoitteet, sekä viikon varauksesta, jota kapasiteettiin mahtumaton joustava työ pienentää. '
      + `Velvoitteista kerrotaan, kun niitä on vapaa-ajalla vähintään ${DRIFT_RULES.FREE_TIME_MIN_INTRUSION_MINUTES} min.`,
    metrics: {
      targetMinutes: target, achievedMinutes: target === null ? null : achieved, shortfallMinutes: shortfall,
      protectedMinutes: covered, freeBlockMinutes: freeTotal, obligationMinutes: inFree.minutes,
      obligationCount: inFree.list.length, overflowMinutes: overflow
    },
    items: inFree.list.map(item => ({ id: item.id, title: item.title, date: item.date, kind: item.kind, minutes: item.minutes })),
    adjustment: !targetMissed && movable.length > 0
      ? {
        type: DRIFT_ADJUSTMENT.MOVE_ITEMS,
        label: 'Siirrä velvoitteet aiemmaksi, ennen vapaa-aikaa',
        detail: 'Kiinteät menot jäävät ennalleen.',
        payload: { taskIds: movable }
      }
      : {
        type: DRIFT_ADJUSTMENT.PROTECT_EVENING,
        label: 'Suojataanko ensi viikolla yksi ilta vapaaksi?',
        detail: 'Suojatun illan voi lisätä kohdassa Profiili → Suojattu aika. Mitään ei muuteta puolestasi.',
        payload: { taskIds: movable }
      }
  });
}

// -------------------------------------------------- VACATION_INTRUSION

/**
 * Joustavat, ei-välttämättömät tehtävät, jotka on päivätty lomalle
 * (tästä päivästä eteenpäin). Kiinteästi ajastettu meno tai tehtävä ei ole
 * tunkeutumista, eikä välttämätön velvoite (luonne OBLIGATION).
 */
export function vacationIntrusionSignal({
  weekStart, todayIso, tasks = EMPTY, periods = EMPTY, goals = EMPTY, projects = EMPTY, lifeAreas = EMPTY
} = {}) {
  const monday = weekStartOf(weekStart || todayIso);
  if (!monday || !isIsoDate(todayIso)) return null;
  const from = monday > todayIso ? monday : todayIso;
  const to = addDaysIso(monday, DRIFT_RULES.VACATION_LOOKAHEAD_DAYS - 1);
  if (to < from) return null;
  const vacations = listOf(periods).filter(period => period.kind === PROTECTED_KIND.VACATION && period.active !== false);
  if (vacations.length === 0) return null;
  const context = natureContext({ goals, projects, lifeAreas });
  const found = [];
  for (const task of listOf(tasks)) {
    if (!isOpen(task) || !isIsoDate(task.date) || task.date < from || task.date > to) continue;
    if (isFixedTimed(task)) continue;
    if (task.horizon === 'WAITING' || task.horizon === 'NOT_YET') continue;
    const vacation = vacationOn(vacations, task.date);
    if (!vacation) continue;
    if (isEssentialNature(natureOf(task, context))) continue;
    const end = vacation.endDate || vacation.startDate;
    found.push({ id: task.id, title: titleOf(task), date: task.date, afterDate: addDaysIso(end, 1), vacationEnd: end });
  }
  if (found.length < DRIFT_RULES.VACATION_MIN_ITEMS) return null;
  found.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) || String(a.id).localeCompare(String(b.id)));
  const first = found[0];
  return build(DRIFT_SIGNAL.VACATION_INTRUSION, {
    severity: found.length >= DRIFT_RULES.VACATION_ATTENTION_ITEMS ? DRIFT_SEVERITY.ATTENTION : DRIFT_SEVERITY.INFO,
    rule: 'drift.flexible_on_vacation',
    reason: `Lomalle on päivätty ${countOf(found.length, 'joustava asia', 'joustavaa asiaa')}. Kiinteät menot pysyvät `
      + `näkyvissä; nämä voi siirtää loman jälkeen (${shortDate(first.afterDate)} alkaen) tai kohtaan Myöhemmin.`,
    why: 'Loma estää joustavan työn automaattisen sijoittamisen. Kiinteästi ajastetut menot ja välttämättömät velvoitteet '
      + `eivät ole mukana. Tarkastelu kattaa ${DRIFT_RULES.VACATION_LOOKAHEAD_DAYS} päivää viikon alusta, tästä päivästä eteenpäin.`,
    metrics: { itemCount: found.length, firstDate: first.date, afterDate: first.afterDate },
    items: found,
    adjustment: {
      type: DRIFT_ADJUSTMENT.MOVE_AFTER_VACATION,
      label: 'Siirrä loman jälkeen tai kohtaan Myöhemmin',
      detail: 'Kiinteät menot jäävät ennalleen.',
      payload: { taskIds: found.map(item => item.id), afterDate: first.afterDate }
    }
  });
}

// ----------------------------------------------------------- PLAN_CHURN

export function planChurnSignal({ weekStart, tasks = EMPTY, dateOf = null } = {}) {
  const monday = weekStartOf(weekStart);
  if (!monday) return null;
  const sunday = addDaysIso(monday, 6);
  const day = safeDateOf(dateOf);
  const open = listOf(tasks).filter(isOpen);
  const repeated = open
    .filter(task => Number.isInteger(task.rescheduleCount) && task.rescheduleCount >= DRIFT_RULES.PLAN_CHURN_MIN_RESCHEDULES)
    .sort((a, b) => b.rescheduleCount - a.rescheduleCount || String(a.id).localeCompare(String(b.id)));
  const movedThisWeek = open.filter(task => Number.isInteger(task.rescheduleCount) && task.rescheduleCount >= 1
    && (() => { const iso = day(task.updatedAt); return iso !== null && iso >= monday && iso <= sunday; })());
  const manyMoves = movedThisWeek.length >= DRIFT_RULES.PLAN_CHURN_WEEK_MOVES;
  if (repeated.length === 0 && !manyMoves) return null;

  const max = repeated.length > 0 ? repeated[0].rescheduleCount : 0;
  const chosen = (repeated.length > 0 ? repeated : [...movedThisWeek]
    .sort((a, b) => b.rescheduleCount - a.rescheduleCount || String(a.id).localeCompare(String(b.id))))
    .slice(0, DRIFT_RULES.PLAN_CHURN_MAX_ITEMS);
  const attention = max >= DRIFT_RULES.PLAN_CHURN_ATTENTION_RESCHEDULES
    || repeated.length >= DRIFT_RULES.PLAN_CHURN_ATTENTION_ITEMS;
  const reason = repeated.length > 0
    ? `${countOf(repeated.length, 'asia', 'asiaa')} on siirretty vähintään ${DRIFT_RULES.PLAN_CHURN_MIN_RESCHEDULES} kertaa `
      + `(enimmillään ${max} kertaa). Toistuva siirto kertoo, että asia kaipaa yhtä päätöstä: pilko se pienemmäksi, `
      + 'siirrä kohtaan Ei vielä tai Myöhemmin, tai arkistoi.'
    : `Tällä viikolla on siirretty ${countOf(movedThisWeek.length, 'asia', 'asiaa')}. Kun asiasta päättää kerran, `
      + 'sitä ei tarvitse siirtää uudelleen.';
  return build(DRIFT_SIGNAL.PLAN_CHURN, {
    severity: attention ? DRIFT_SEVERITY.ATTENTION : DRIFT_SEVERITY.INFO,
    rule: repeated.length > 0 ? 'drift.repeated_reschedule' : 'drift.many_moves_this_week',
    reason,
    why: `Siirrot lasketaan tehtävän päivän muutoksista (keskeneräinen tehtävä). Toistuvaksi lasketaan vähintään `
      + `${DRIFT_RULES.PLAN_CHURN_MIN_RESCHEDULES} siirtoa, viikon siirroista kerrotaan, kun niitä on vähintään `
      + `${DRIFT_RULES.PLAN_CHURN_WEEK_MOVES}.`,
    metrics: { repeatedCount: repeated.length, maxReschedules: max, movedThisWeek: movedThisWeek.length },
    items: chosen.map(task => ({ id: task.id, title: titleOf(task), rescheduleCount: task.rescheduleCount })),
    adjustment: {
      type: DRIFT_ADJUSTMENT.DECIDE_ONCE,
      label: 'Päätä kerran: pilko, Ei vielä, Myöhemmin tai arkistoi',
      detail: 'Arkistoitu on palautettavissa. Pilkkominen tehdään tehtävän muokkauksessa.',
      payload: { taskIds: chosen.map(task => task.id) }
    }
  });
}

// -------------------------------------------------------------- kaikki

export function compareDriftSignals(a, b) {
  const severity = (SEVERITY_RANK[b.severity] || 0) - (SEVERITY_RANK[a.severity] || 0);
  if (severity !== 0) return severity;
  return (KIND_RANK[b.kind] || 0) - (KIND_RANK[a.kind] || 0);
}

/**
 * Kaikki ajautumisen havainnot yhdellä kutsulla.
 *
 * @param {object} input
 * @param {string} input.weekStart         mikä tahansa viikon päivä
 * @param {string} input.todayIso
 * @param {Array}  [input.tasks]
 * @param {Array}  [input.timeEntries]
 * @param {Array}  [input.weeklyPlans]
 * @param {Array}  [input.periods]         protected_periods
 * @param {Array}  [input.blocks]          viikon kalenterilohkot (brakeInputs); muuten periodBlocks
 * @param {Array}  [input.events]          viikon menoesiintymät (startMinute/endMinute)
 * @param {Array}  [input.goals], [input.projects], [input.lifeAreas]  luonteen päättelyyn
 * @param {number} [input.overflowMinutes] joustava työ, joka ei mahdu viikon kapasiteettiin
 * @param {Function} [input.dateOf]        aikaleima -> paikallinen ISO-päivä
 * @returns {ReadonlyArray<object>} havainnot vahvimmasta alkaen
 */
export function driftSignals(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const runners = [
    () => backlogGrowthSignal(source),
    () => capacityBiasSignal(source),
    () => ownTimeErosionSignal(source),
    () => freeTimeErosionSignal(source),
    () => vacationIntrusionSignal(source),
    () => planChurnSignal(source)
  ];
  const signals = [];
  for (const run of runners) {
    try {
      const signal = run();
      if (signal) signals.push(signal);
    } catch {
      // Yhden havainnon laskentavirhe ei vie muita.
    }
  }
  return Object.freeze(signals.sort(compareDriftSignals));
}

/** Havainnon selitys näkymälle: sama muoto kuin alignmentReview.explainSignal. */
export function explainDriftSignal(signal) {
  if (!signal || !DRIFT_SIGNALS.includes(signal.kind)) return { title: 'Havainto', text: '', why: '' };
  return { title: signal.title, text: signal.reason, why: signal.why };
}
