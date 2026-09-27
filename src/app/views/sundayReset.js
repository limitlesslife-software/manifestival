// Sunnuntain nollaus: viikon sulkeminen (aalto L, docs/MENTAL-LOAD-CORE.md).
//
// Seitsemän lyhyttä vaihetta, yksi kerrallaan, samaan tapaan kuin Suunnan
// aloitus (directionSetup.js):
//
//   A Kirjaa mielestä   monirivinen kirjaus saapuviin (captureBrainDump), ei päätöksiä
//   B Saapuvat          montako odottaa + enintään viisi; järjestäminen on Saapuvat-näkymän asia
//   C Kapasiteetti      kapasiteettijarrun luku kohdeviikolle (brakedHorizonCapacity) erittelyineen
//   D Prioriteetit      enintään kolme todellista viikon prioriteettia (saveWeeklyPlan)
//   E Sijoittelu        välttämätön kohdeviikon päiville (planHorizon + jarru), vain mikä mahtuu
//   F Oma aika          suojattu oma aika, vapaa-aika ja loma kiinteiden menojen rinnalla
//   G Sulje viikko      closeWeek(weekStart, { priorities, plannedMinutes })
//
// Loppuviesti on lukittu (omistajan päätös):
//
//   "Ensi viikko on suunniteltu.
//    Sinun ei tarvitse miettiä sitä enää tänään."
//
// NOLLAUS EI OLE TYÖSESSIO. Jokainen vaihe on lyhyt ja ohitettavissa, eikä
// yksikään vaihe listaa koko jonoa: listat on rajattu ja loput kerrotaan
// yhtenä lukuna ("N muuta tallessa").
//
// KOHDEVIIKKO (sundayResetTargetWeek): seuraava ISO-viikko (ma–su)
// nollauspäivästä. Poikkeus: maanantaina ennen klo 12 suunnitellaan
// kuluva viikko (se alkoi vasta, eikä sitä ole vielä suljettu).
//
// Tämä moduuli EI importoi direction.js:ää (sykli): Suunta kutsuu
// openSundayReset()-funktiota, ja Tänään-kortin paikan päättää kutsuja
// (renderSundayResetEntry).

import { maybe, setHtml } from '../../ui/dom.js';
import { escapeHtml } from '../../lib/format.js';
import { getState, setTasksSegment, findTask } from '../state.js';
import { switchTab } from '../navigation.js';
import { clockNow, saveWeeklyCapacity } from '../alignment.js';
import { brakedHorizonCapacity, brakeInputs } from '../capacityBrake.js';
import { captureBrainDump } from '../capture.js';
import { editTask } from '../actions.js';
import { saveWeeklyPlan, closeWeek, saveFreeTimeRules, saveProtectedPeriod } from '../mentalLoadActions.js';
import { weeklyPlansRepo, protectedPeriodsRepo } from '../../data/collectionsRepo.js';
import { planHorizon, isMovable, PLACEMENT } from '../../domain/planScheduler.js';
import {
  computeLifeLoad, isSchedulable, schedulingContext, isFixedTimed
} from '../../domain/lifeLoad.js';
import {
  describePeriod, freeTimeRules, weeklyFreeTimeReserve, protectedKindLabel, PROTECTED_KIND, PERIOD_RECURRENCE
} from '../../domain/protectedTime.js';
import { weeklyPlanFor, isWeekClosed, WEEKLY_PRIORITY_LIMIT, MAX_PRIORITY_TITLE_LENGTH } from '../../domain/weeklyPlan.js';
import { weekStartOf, weekDates, capacityForWeek } from '../../domain/weeklyCapacity.js';
import { openItems } from '../../domain/inbox.js';
import { isOpenGoal } from '../../domain/alignmentSetup.js';
import { categoryOwnerArea, compareLifeAreas, formatMinutes, countOf } from '../../domain/lifeArea.js';
import { addDaysIso, weekdayOfIso } from '../../domain/fiTemporal.js';
import { isIsoDate, durationOf, isTimeOfDay, toMinutes, fromMinutes, TASK_HORIZON } from '../../domain/task.js';

// ------------------------------------------------------------ vakiot

export const SUNDAY_RESET_STEPS = Object.freeze(['dump', 'sort', 'capacity', 'priorities', 'place', 'protect', 'close']);

export const SUNDAY_RESET_STEP_LABELS = Object.freeze({
  dump: 'Kirjaa mielestä',
  sort: 'Saapuvat',
  capacity: 'Kapasiteetti',
  priorities: 'Prioriteetit',
  place: 'Sijoittelu',
  protect: 'Oma aika',
  close: 'Sulje viikko'
});

/** Lukittu loppuviesti (omistajan päätös): kaksi riviä täsmälleen näin. */
export const SUNDAY_RESET_FINAL_TITLE = 'Ensi viikko on suunniteltu.';
export const SUNDAY_RESET_FINAL_TEXT = 'Sinun ei tarvitse miettiä sitä enää tänään.';
export const SUNDAY_RESET_FINAL_COPY = `${SUNDAY_RESET_FINAL_TITLE}\n${SUNDAY_RESET_FINAL_TEXT}`;

/** Rauhallinen raja prioriteeteille (validateWeeklyPlan sanoo saman pidemmin). */
export const PRIORITY_LIMIT_MESSAGE = 'Valitse enintään kolme. Loput ovat tallessa.';
export const NOT_FITTING_MESSAGE = 'Ei mahdu — jää tallessa, sinun ei tarvitse päättää nyt.';

/** Maanantaina ennen tätä (minuutteja keskiyöstä) suunnitellaan kuluva viikko. */
export const MONDAY_MORNING_UNTIL = 12 * 60;

/** Rajat: yksikään vaihe ei listaa koko jonoa. */
export const INBOX_PREVIEW_LIMIT = 5;
export const PRIORITY_GROUP_LIMIT = 3;
export const PLACEMENT_PREVIEW_LIMIT = 6;
export const NOT_FITTING_PREVIEW_LIMIT = 5;
export const ESSENTIALS_PREVIEW_LIMIT = 5;

/** Lisättävän oman ajan kesto (yksi rauhallinen tunti). */
export const OWN_TIME_SLOT_MINUTES = 60;
export const DEFAULT_EVENING_FROM = '17:00';
export const DEFAULT_OWN_TIME_START = '18:00';

const DEFAULT_TASK_MINUTES = 30;
const WEEKDAY_NAMES = Object.freeze(['', 'maanantai', 'tiistai', 'keskiviikko', 'torstai', 'perjantai', 'lauantai', 'sunnuntai']);
const WEEKDAY_SHORT = Object.freeze(['', 'ma', 'ti', 'ke', 'to', 'pe', 'la', 'su']);
const EMPTY = Object.freeze([]);

function listOf(value) {
  return Array.isArray(value) ? value.filter(Boolean) : EMPTY;
}

function dayLabel(iso) {
  if (!isIsoDate(iso)) return '';
  const [, m, d] = iso.split('-').map(Number);
  return `${WEEKDAY_SHORT[weekdayOfIso(iso)]} ${d}.${m}.`;
}

function shortDate(iso) {
  if (!isIsoDate(iso)) return '';
  const [, m, d] = iso.split('-').map(Number);
  return `${d}.${m}.`;
}

function taskMinutes(task) {
  const explicit = durationOf(task);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const stored = Number(task && task.durationMinutes);
  return Number.isFinite(stored) && stored > 0 ? stored : DEFAULT_TASK_MINUTES;
}

function hoursText(minutes) {
  return formatMinutes(minutes);
}

// ------------------------------------------------------------ kohdeviikko

/**
 * Minkä viikon nollaus suunnittelee?
 *
 * Seuraava ISO-viikko (ma–su) nollauspäivästä. Maanantaina ennen klo 12
 * suunnitellaan kuluva viikko: se alkoi juuri, ja sunnuntain nollaus on
 * voinut jäädä väliin.
 *
 * @returns {{weekStart:string, weekEnd:string, current:boolean}|null}
 */
export function sundayResetTargetWeek(todayIso, nowMinutes = null) {
  if (!isIsoDate(todayIso)) return null;
  const monday = weekStartOf(todayIso);
  const current = weekdayOfIso(todayIso) === 1 && Number.isFinite(nowMinutes) && nowMinutes < MONDAY_MORNING_UNTIL;
  const weekStart = current ? monday : addDaysIso(monday, 7);
  return { weekStart, weekEnd: addDaysIso(weekStart, 6), current };
}

/**
 * Näytetäänkö "Sulje viikko" -kortti?
 *
 * Kyllä, kun kohdeviikkoa ei ole vielä suljettu JA on lauantai tai
 * sunnuntai, tai maanantaiaamu (kuluva viikko). Muina päivinä ei: kortti ei
 * saa olla pysyvä muistutus, joka lisää mielen kuormaa.
 */
export function shouldShowSundayResetEntry(state, { todayIso, nowMinutes = null } = {}) {
  const target = sundayResetTargetWeek(todayIso, nowMinutes);
  if (!target) return false;
  const weekday = weekdayOfIso(todayIso);
  const inWindow = weekday === 6 || weekday === 7 || target.current;
  if (!inWindow) return false;
  const plan = weeklyPlanFor(state && state.weeklyPlans, target.weekStart);
  return !isWeekClosed(plan);
}

// ------------------------------------------------------------ B: saapuvat

/** Saapuvien tila: luku ja enintään viisi riviä. Ei toista käsittelynäkymää. */
export function inboxStepModel(state, { limit = INBOX_PREVIEW_LIMIT } = {}) {
  const open = openItems(listOf(state && state.inboxItems));
  const shown = open.slice(0, Math.max(0, limit)).map(item => ({ id: item.id, text: item.text || '' }));
  return { count: open.length, shown, more: Math.max(0, open.length - shown.length) };
}

// ------------------------------------------------------------ C: kapasiteetti

/**
 * Suunnittelijan ehdokkaat samalla säännöllä kuin planHorizon: keskeneräinen,
 * siirrettävä ja sijoitettava (lifeLoad.isSchedulable) kohdeviikon alusta
 * katsottuna. Kaikki muu (kiinteä) on maastoa, joka varaa kapasiteettia.
 */
function planningContext(state, weekStart) {
  const ctx = schedulingContext({ goals: listOf(state.goals), projects: listOf(state.projects), todayIso: weekStart });
  const isCandidate = task => Boolean(task) && !task.completed && isMovable(task) && isSchedulable(task, ctx);
  const tasks = listOf(state.tasks);
  return { ctx, isCandidate, tasks, fixed: tasks.filter(task => !isCandidate(task)) };
}

/**
 * Realistinen kapasiteetti kohdeviikolle: kapasiteettijarru (uni, kiinteät
 * menot ja tehtävät, matkat, suojattu oma aika ja vapaa-aika, loma, puskuri,
 * unen vaje, viikon vähimmäisvapaa-aika). Sama luku, jonka sijoittelu (E)
 * käyttää: ehdokkaat eivät kuluta sitä etukäteen.
 *
 * Erittely laskee yhteen: valveilla − varattu − puskuri − unen vaje −
 * vähimmäisvapaa-aika − liian lyhyet välit = joustava aika.
 */
export function capacityStepModel(state, { weekStart, todayIso, nowMinutes = null } = {}) {
  const monday = weekStartOf(weekStart);
  const weekEnd = addDaysIso(monday, 6);
  const { fixed } = planningContext(state, monday);
  const { capacity, inputs } = brakedHorizonCapacity(state, {
    from: monday, to: weekEnd, todayIso: todayIso || monday, nowMinutes, tasks: fixed
  });
  const breakdown = {
    awakeMinutes: 0, calendarMinutes: 0, protectedMinutes: 0, bufferMinutes: 0,
    sleepAdjustMinutes: 0, reservedFreeMinutes: 0, shortGapMinutes: 0, vacationDays: 0
  };
  for (const day of capacity.days) {
    const awake = Math.max(0, day.awakeMinutes || 0);
    const committed = Math.min(awake, Math.max(0, day.committedMinutes || 0));
    const protectedMinutes = Math.min(committed, Math.max(0, day.protectedTimeMinutes || 0));
    breakdown.awakeMinutes += awake;
    breakdown.protectedMinutes += protectedMinutes;
    breakdown.calendarMinutes += committed - protectedMinutes;
    breakdown.bufferMinutes += day.bufferMinutes || 0;
    breakdown.sleepAdjustMinutes += day.sleepAdjustMinutes || 0;
    breakdown.reservedFreeMinutes += day.reservedFreeMinutes || 0;
    breakdown.shortGapMinutes += Math.max(0, awake - committed - (day.bufferMinutes || 0) - (day.sleepAdjustMinutes || 0)
      - (day.reservedFreeMinutes || 0) - (day.usableMinutes || 0));
    if (day.vacation) breakdown.vacationDays += 1;
  }
  return {
    weekStart: monday,
    weekEnd,
    totalMinutes: capacity.totalUsableMinutes,
    days: capacity.days.map(day => ({ dateIso: day.dateIso, usableMinutes: day.usableMinutes, vacation: Boolean(day.vacation) })),
    breakdown,
    bufferRatio: inputs.bufferRatio,
    declared: capacityForWeek(listOf(state.weeklyCapacities), monday)
  };
}

// ------------------------------------------------------------ D: prioriteetit

function priorityKey(entry) {
  if (!entry) return '';
  return entry.ref && entry.ref !== 'text' ? entry.ref : `text:${String(entry.title || '').toLocaleLowerCase('fi')}`;
}

/**
 * Rajatut prioriteettiehdokkaat: kohdeviikolla erääntyvät tai sille
 * päivätyt asiat (lifeLoad), aktiiviset tavoitteet ja elämänalueet.
 * Kustakin ryhmästä enintään kolme; loput yhtenä lukuna.
 *
 * @returns {{groups:Array<{key,label,items:Array<{ref,title,reason}>}>, more:number, total:number}}
 */
export function priorityCandidates(state, { weekStart, todayIso, groupLimit = PRIORITY_GROUP_LIMIT } = {}) {
  const monday = weekStartOf(weekStart);
  const weekEnd = addDaysIso(monday, 6);
  const inWeek = iso => isIsoDate(iso) && iso >= monday && iso <= weekEnd;
  const load = computeLifeLoad({
    tasks: listOf(state.tasks), goals: listOf(state.goals), projects: listOf(state.projects),
    lifeAreas: listOf(state.lifeAreas), todayIso: todayIso || monday
  });
  const seen = new Set();
  const due = [];
  for (const entry of [...load.now, ...load.thisWeek, ...load.later]) {
    if (entry.kind !== 'task' || seen.has(entry.id)) continue;
    if (!inWeek(entry.deadline) && !inWeek(entry.date)) continue;
    seen.add(entry.id);
    due.push({
      ref: `task:${entry.id}`, title: entry.title,
      reason: inWeek(entry.deadline) ? `Määräaika ${dayLabel(entry.deadline)}` : dayLabel(entry.date),
      sortKey: entry.deadline && inWeek(entry.deadline) ? entry.deadline : entry.date
    });
  }
  due.sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : a.title.localeCompare(b.title, 'fi')));
  const goals = listOf(state.goals).filter(goal => isOpenGoal(goal) && goal.status !== 'paused' && goal.title)
    .sort((a, b) => String(a.title).localeCompare(String(b.title), 'fi'))
    .map(goal => ({ ref: `goal:${goal.id}`, title: goal.title, reason: 'Tavoite' }));
  const areas = listOf(state.lifeAreas).filter(area => area.active && area.name)
    .sort((a, b) => (b.importance || 0) - (a.importance || 0) || compareLifeAreas(a, b))
    .map(area => ({ ref: `area:${area.id}`, title: area.name, reason: 'Elämänalue' }));
  const all = [
    { key: 'due', label: 'Määräaika tai päivä ensi viikolla', list: due },
    { key: 'goals', label: 'Tavoitteet', list: goals },
    { key: 'areas', label: 'Elämänalueet', list: areas }
  ];
  let shown = 0;
  let total = 0;
  const groups = [];
  for (const group of all) {
    total += group.list.length;
    const items = group.list.slice(0, Math.max(0, groupLimit)).map(({ ref, title, reason }) => ({ ref, title, reason }));
    shown += items.length;
    if (items.length > 0) groups.push({ key: group.key, label: group.label, items });
  }
  return { groups, more: Math.max(0, total - shown), total };
}

/**
 * Valitse tai poista prioriteetti. Neljättä ei lisätä: rauhallinen viesti
 * kertoo rajan, eikä mitään valittua pudoteta hiljaa.
 *
 * @returns {{selected:Array<{ref,title}>, limited:boolean, message:string}}
 */
export function togglePriority(selected = [], entry, { limit = WEEKLY_PRIORITY_LIMIT } = {}) {
  const list = listOf(selected).map(item => ({ ref: item.ref || 'text', title: item.title }));
  if (!entry || !entry.title) return { selected: list, limited: false, message: '' };
  const key = priorityKey(entry);
  const at = list.findIndex(item => priorityKey(item) === key);
  if (at >= 0) {
    list.splice(at, 1);
    return { selected: list, limited: false, message: '' };
  }
  if (list.length >= limit) return { selected: list, limited: true, message: PRIORITY_LIMIT_MESSAGE };
  list.push({ ref: entry.ref || 'text', title: String(entry.title).slice(0, MAX_PRIORITY_TITLE_LENGTH) });
  return { selected: list, limited: false, message: '' };
}

// ------------------------------------------------------------ E: sijoittelu

function goalIdOf(task, projectsById) {
  if (task.goalId) return task.goalId;
  const project = task.projectId ? projectsById.get(task.projectId) : null;
  return project && project.goalId ? project.goalId : null;
}

/** Liittyykö tehtävä valittuun prioriteettiin (tehtävä, tavoite, projekti tai alue)? */
export function linkedToPriorities(task, priorities = [], state = getState()) {
  const refs = new Set(listOf(priorities).map(entry => entry.ref).filter(ref => ref && ref !== 'text'));
  if (!task || refs.size === 0) return false;
  if (refs.has(`task:${task.id}`)) return true;
  if (task.projectId && refs.has(`project:${task.projectId}`)) return true;
  const projectsById = new Map(listOf(state.projects).map(project => [project.id, project]));
  const goalId = goalIdOf(task, projectsById);
  if (goalId && refs.has(`goal:${goalId}`)) return true;
  const goal = goalId ? listOf(state.goals).find(entry => entry.id === goalId) : null;
  const areaId = goal && goal.lifeAreaId ? goal.lifeAreaId : (categoryOwnerArea(listOf(state.lifeAreas), task.category) || {}).id;
  return Boolean(areaId && refs.has(`area:${areaId}`));
}

function mergeReserves(base, extra) {
  const merged = new Map(base instanceof Map ? base : []);
  for (const [date, minutes] of extra) {
    if (minutes > 0) merged.set(date, (merged.get(date) || 0) + minutes);
  }
  return merged;
}

/**
 * Sijoita välttämätön kohdeviikolle. EI kirjoita mitään.
 *
 * Ehdokkaat (vain nämä, ei koko jonoa):
 *   - kohdeviikolle jo päivätyt sijoitettavat tehtävät
 *   - päivättömät "tällä viikolla" -tehtävät
 *   - valittuihin prioriteetteihin liittyvät päivättömät tehtävät
 *   - päivättömät tehtävät, joiden määräaika on viimeistään viikon lopussa
 *
 * Järjestys:
 *   0. jo päivätty pysyy omalla päivällään, jos päivässä on tilaa
 *   1. prioriteetteihin liittyvät ja määräaikaiset (planHorizon)
 *   2. loput (planHorizon, jäljelle jääneellä kapasiteetilla)
 *
 * Kapasiteetti on kapasiteettijarrun luku (sama kuin vaihe C): suojattu
 * aika ja loma on varattu ennen sijoitusta, joten niihin ei sijoiteta.
 * Mikä ei mahdu, ei sijoitu — sitä ei työnnetä täydelle päivälle.
 * `budgetMinutes` (käyttäjän pienentämä viikon aika) rajaa uudet sijoitukset.
 *
 * @returns {{weekStart, weekEnd, placements:Array, notFitting:Array, changes:Array,
 *   days:Array<{dateIso, usableMinutes, usedMinutes, vacation}>, placedMinutes:number, capacityMinutes:number}}
 */
export function placementPlan(state, {
  weekStart, todayIso, nowMinutes = null, priorities = [], budgetMinutes = null
} = {}) {
  const monday = weekStartOf(weekStart);
  const weekEnd = addDaysIso(monday, 6);
  const inWeek = iso => isIsoDate(iso) && iso >= monday && iso <= weekEnd;
  const { isCandidate, tasks, fixed } = planningContext(state, monday);
  const { capacity, inputs } = brakedHorizonCapacity(state, {
    from: monday, to: weekEnd, todayIso: todayIso || monday, nowMinutes, tasks: fixed
  });
  const usable = new Map(capacity.days.map(day => [day.dateIso, day.usableMinutes]));
  const vacation = new Set(capacity.days.filter(day => day.vacation).map(day => day.dateIso));

  const dated = [];
  const focus = [];
  const rest = [];
  for (const task of tasks) {
    if (!isCandidate(task)) continue;
    const linked = linkedToPriorities(task, priorities, state);
    const deadlineSoon = isIsoDate(task.deadline) && task.deadline <= weekEnd;
    if (task.date) {
      if (inWeek(task.date)) dated.push({ task, focus: linked || deadlineSoon });
      continue;
    }
    if (task.horizon === TASK_HORIZON.THIS_WEEK || linked || deadlineSoon) {
      (linked || deadlineSoon ? focus : rest).push(task);
    }
  }

  // 0. Jo päivätty pysyy päivällään, kun päivässä on tilaa. Prioriteetti ensin.
  dated.sort((a, b) => Number(b.focus) - Number(a.focus) || (a.task.date < b.task.date ? -1 : a.task.date > b.task.date ? 1 : 0)
    || String(a.task.title || '').localeCompare(String(b.task.title || ''), 'fi'));
  const remaining = new Map(usable);
  const keptUse = new Map();
  const placements = [];
  for (const { task, focus: isFocus } of dated) {
    const minutes = taskMinutes(task);
    const room = remaining.get(task.date) || 0;
    if (room >= minutes && !vacation.has(task.date)) {
      remaining.set(task.date, room - minutes);
      keptUse.set(task.date, (keptUse.get(task.date) || 0) + minutes);
      placements.push({
        taskId: task.id, title: task.title || '', fromDateIso: task.date, toDateIso: task.date, minutes,
        result: PLACEMENT.KEPT, focus: isFocus
      });
    } else {
      (isFocus ? focus : rest).push(task);
    }
  }

  // 1. ja 2. planHorizon kahdessa erässä: jälkimmäinen saa vain jäännöksen.
  const common = {
    goals: listOf(state.goals), projects: listOf(state.projects), profile: state.profile,
    fromIso: monday, toIso: weekEnd, routines: listOf(state.routines), exceptions: listOf(state.routineExceptions),
    bufferRatio: inputs.bufferRatio, events: inputs.events, blocks: inputs.blocks, sleepShortfalls: inputs.sleepShortfalls
  };
  const notFitting = [];
  let reserves = mergeReserves(inputs.reserves, keptUse);
  for (const [batch, isFocus] of [[focus, true], [rest, false]]) {
    if (batch.length === 0) continue;
    const result = planHorizon({ ...common, tasks: [...fixed, ...batch], reserves });
    const used = new Map(result.days.map(day => [day.dateIso, Math.max(0, day.usableMinutes - day.remainingMinutes)]));
    reserves = mergeReserves(reserves, used);
    for (const placement of result.placements) {
      const task = batch.find(entry => entry.id === placement.taskId);
      const deadline = task && isIsoDate(task.deadline) && task.deadline >= monday ? task.deadline : null;
      if ((deadline && placement.toDateIso > deadline) || vacation.has(placement.toDateIso)) {
        notFitting.push({ taskId: placement.taskId, title: placement.title || '', minutes: placement.minutes, reason: NOT_FITTING_MESSAGE });
        continue;
      }
      placements.push({
        taskId: placement.taskId, title: placement.title || '', fromDateIso: placement.fromDateIso,
        toDateIso: placement.toDateIso, minutes: placement.minutes, result: placement.result, focus: isFocus
      });
    }
    for (const entry of result.unplaced) {
      notFitting.push({ taskId: entry.task.id, title: entry.task.title || '', minutes: taskMinutes(entry.task), reason: NOT_FITTING_MESSAGE });
    }
  }

  // Käyttäjän pienentämä viikon aika: pysyvät ensin, uudet sijoitukset rajaan asti.
  const budget = Number.isFinite(budgetMinutes) && budgetMinutes >= 0 ? budgetMinutes : Infinity;
  let spent = placements.filter(p => p.result === PLACEMENT.KEPT).reduce((sum, p) => sum + p.minutes, 0);
  const accepted = [];
  for (const placement of placements) {
    if (placement.result === PLACEMENT.KEPT) { accepted.push(placement); continue; }
    if (spent + placement.minutes <= budget) {
      spent += placement.minutes;
      accepted.push(placement);
    } else {
      notFitting.push({ taskId: placement.taskId, title: placement.title, minutes: placement.minutes, reason: NOT_FITTING_MESSAGE });
    }
  }
  accepted.sort((a, b) => (a.toDateIso < b.toDateIso ? -1 : a.toDateIso > b.toDateIso ? 1 : 0)
    || Number(b.focus) - Number(a.focus) || a.title.localeCompare(b.title, 'fi'));

  const usedByDay = new Map();
  for (const placement of accepted) usedByDay.set(placement.toDateIso, (usedByDay.get(placement.toDateIso) || 0) + placement.minutes);
  return {
    weekStart: monday,
    weekEnd,
    placements: accepted,
    notFitting,
    changes: accepted.filter(p => p.result === PLACEMENT.PLACED && p.toDateIso !== p.fromDateIso)
      .map(p => ({ taskId: p.taskId, fromDateIso: p.fromDateIso, date: p.toDateIso })),
    days: capacity.days.map(day => ({
      dateIso: day.dateIso, usableMinutes: day.usableMinutes, usedMinutes: usedByDay.get(day.dateIso) || 0, vacation: Boolean(day.vacation)
    })),
    placedMinutes: accepted.reduce((sum, p) => sum + p.minutes, 0),
    capacityMinutes: capacity.totalUsableMinutes
  };
}

/**
 * Hyväksy sijoittelu: vain päivä muuttuu (editTask). Siirtojen seuranta
 * (reschedule_count, original_date) tulee editTaskista automaattisesti.
 * Tehtävä, jonka päivä muuttui välissä muualla, jätetään rauhaan.
 */
export async function applyPlacementPlan(plan, { editTaskFn = editTask } = {}) {
  let applied = 0;
  let failed = 0;
  let skipped = 0;
  for (const change of listOf(plan && plan.changes)) {
    const task = findTask(change.taskId);
    if (!task || task.completed || (task.date || null) !== (change.fromDateIso || null)) { skipped += 1; continue; }
    const result = await editTaskFn(change.taskId, { date: change.date });
    if (result && result.ok) applied += 1;
    else failed += 1;
  }
  return { ok: failed === 0, applied, failed, skipped };
}

/**
 * Suunnitelman kesto kohdeviikolla (weekly_plans.planned_minutes,
 * CAPACITY_BIAS): keskeneräisten, näkyvien tehtävien kestot viikon päivinä.
 */
export function plannedMinutesForWeek(state, weekStart) {
  const monday = weekStartOf(weekStart);
  if (!monday) return 0;
  const weekEnd = addDaysIso(monday, 6);
  return listOf(state && state.tasks)
    .filter(task => !task.completed && !task.isWake && !task.archivedAt && isIsoDate(task.date)
      && task.date >= monday && task.date <= weekEnd)
    .reduce((sum, task) => sum + taskMinutes(task), 0);
}

// ------------------------------------------------------------ F: oma aika

/**
 * Kohdeviikon suojattu aika kiinteiden menojen rinnalla: jaksot minuutteineen
 * (describePeriod), lomapäivät, viikon vähimmäisvapaa-ajan tila ja rajattu
 * lista kiinteistä menoista.
 */
export function protectStepModel(state, { weekStart, todayIso, nowMinutes = null, limit = ESSENTIALS_PREVIEW_LIMIT } = {}) {
  const monday = weekStartOf(weekStart);
  const weekEnd = addDaysIso(monday, 6);
  const inWeek = iso => isIsoDate(iso) && iso >= monday && iso <= weekEnd;
  const inputs = brakeInputs(state, { from: monday, to: weekEnd, todayIso: todayIso || monday, nowMinutes });
  const periods = listOf(state.protectedPeriods);
  const byId = new Map(periods.filter(p => p.id).map(period => [period.id, period]));
  const minutesById = new Map();
  const vacationDates = new Set();
  for (const block of listOf(inputs.blocks)) {
    if (!block.periodId || !inWeek(block.date)) continue;
    if (block.periodKind === PROTECTED_KIND.VACATION) vacationDates.add(block.date);
    minutesById.set(block.periodId, (minutesById.get(block.periodId) || 0) + Math.max(0, Number(block.durationMinutes) || 0));
  }
  const protectedList = [...minutesById].map(([id, minutes]) => {
    const period = byId.get(id);
    return period ? { id, kind: period.kind, label: protectedKindLabel(period.kind), text: describePeriod(period), minutes } : null;
  }).filter(Boolean).sort((a, b) => a.kind.localeCompare(b.kind) || a.text.localeCompare(b.text, 'fi'));

  const freeTime = weeklyFreeTimeReserve({ periods, blocks: inputs.blocks, weekDates: weekDates(monday) });

  const essentials = [];
  for (const event of listOf(inputs.events)) {
    if (!inWeek(event.date)) continue;
    essentials.push({ date: event.date, time: event.allDay ? null : event.time || null, title: event.title || 'Meno' });
  }
  for (const task of listOf(state.tasks)) {
    if (task.completed || !inWeek(task.date) || !isFixedTimed(task)) continue;
    essentials.push({ date: task.date, time: task.time, title: task.title || 'Tehtävä' });
  }
  essentials.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) || String(a.time || '').localeCompare(String(b.time || '')));

  const rules = freeTimeRules(periods);
  const eveningDays = [1, 2, 3, 4, 5, 6, 7].filter(day => !rules.eveningWeekdays.includes(day));
  return {
    weekStart: monday,
    weekEnd,
    protected: protectedList,
    vacationDays: vacationDates.size,
    freeTime,
    essentials: essentials.slice(0, Math.max(0, limit)),
    essentialsMore: Math.max(0, essentials.length - limit),
    rules,
    eveningDays
  };
}

/** Lisää yksi suojattu vapaa ilta: olemassa olevat säännöt säilyvät (saveFreeTimeRules). */
export function addFreeEvening(weekday, { from = null } = {}) {
  const day = Number(weekday);
  if (!Number.isInteger(day) || day < 1 || day > 7) return Promise.resolve({ ok: false, errors: { weekdays: 'Valitse viikonpäivä.' } });
  const rules = freeTimeRules(getState().protectedPeriods);
  const eveningWeekdays = [...new Set([...rules.eveningWeekdays, day])].sort((a, b) => a - b);
  const eveningFrom = rules.eveningFrom || (isTimeOfDay(from) ? from : DEFAULT_EVENING_FROM);
  return saveFreeTimeRules({ ...rules, eveningWeekdays, eveningFrom });
}

/** Lisää yksi viikoittainen oman ajan tunti kohdeviikosta alkaen (OWN_TIME weekly). */
export function addOwnTimeSlot(weekday, { startTime = DEFAULT_OWN_TIME_START, weekStart = null, minutes = OWN_TIME_SLOT_MINUTES } = {}) {
  const day = Number(weekday);
  if (!Number.isInteger(day) || day < 1 || day > 7) return Promise.resolve({ ok: false, errors: { weekdays: 'Valitse viikonpäivä.' } });
  if (!isTimeOfDay(startTime)) return Promise.resolve({ ok: false, errors: { startTime: 'Anna alkuaika.' } });
  const start = toMinutes(startTime);
  const end = Math.min(23 * 60 + 59, start + minutes);
  if (!(end > start)) return Promise.resolve({ ok: false, errors: { endTime: 'Valitse aikaisempi alkuaika.' } });
  return saveProtectedPeriod({
    kind: PROTECTED_KIND.OWN_TIME, recurrence: PERIOD_RECURRENCE.WEEKLY, title: 'Oma aika',
    weekdays: [day], startTime, endTime: fromMinutes(end), startDate: isIsoDate(weekStart) ? weekStart : null
  });
}

// ------------------------------------------------------------ istunto

/**
 * Nollauksen eteneminen muistissa. Escape ja sulkeminen säilyttävät sen;
 * "Valmis" ja uloskirjautuminen nollaavat.
 */
let session = null;
let bound = false;
let dialogOpen = false;
/** Istuntomuistin vihje näytetään kerran (warnIfVolatile-kaava). */
let volatileHintShown = false;

function newSession(target, clock) {
  const state = getState();
  const plan = weeklyPlanFor(state.weeklyPlans, target.weekStart);
  return {
    ...target,
    todayIso: clock.todayIso,
    nowMinutes: clock.nowMinutes,
    stepIndex: 0,
    finished: false,
    busy: false,
    error: '',
    focusTitle: true,
    dumpDraft: '',
    dumpResult: null,
    capacityDraft: null,
    capacitySaved: null,
    selected: plan ? plan.priorities.map(entry => ({ ...entry })) : [],
    prioritiesSaved: false,
    priorityText: '',
    priorityMessage: '',
    candidateMap: new Map(),
    plan: null,
    planKey: '',
    planResult: null,
    protectMessage: '',
    eveningDay: null,
    ownDay: null,
    ownTime: DEFAULT_OWN_TIME_START,
    volatileHint: false,
    status: ''
  };
}

function currentStepKey() {
  if (!session) return null;
  return session.finished ? 'done' : SUNDAY_RESET_STEPS[session.stepIndex];
}

function sessionClock() {
  return { todayIso: session.todayIso, nowMinutes: session.nowMinutes };
}

function capacityModel() {
  return capacityStepModel(getState(), { weekStart: session.weekStart, ...sessionClock() });
}

function draftHours(model) {
  if (session.capacityDraft !== null) return session.capacityDraft;
  const minutes = model.declared && Number.isInteger(model.declared.availableMinutes)
    ? model.declared.availableMinutes : model.totalMinutes;
  return String(Math.round((minutes / 60) * 2) / 2).replace('.', ',');
}

function parseHours(text) {
  const clean = String(text ?? '').replace(',', '.').trim();
  if (clean === '') return null;
  const hours = Number(clean);
  return Number.isFinite(hours) && hours >= 0 && hours <= 168 ? Math.round(hours * 60) : NaN;
}

/** Viikon aika, jonka käyttäjä vahvisti tai asetti (null = ei rajaa). */
function budgetMinutes() {
  if (Number.isInteger(session.capacitySaved)) return session.capacitySaved;
  const declared = capacityForWeek(getState().weeklyCapacities, session.weekStart);
  return declared && Number.isInteger(declared.availableMinutes) ? declared.availableMinutes : null;
}

function ensurePlan() {
  const key = JSON.stringify([session.selected.map(priorityKey), budgetMinutes()]);
  if (!session.plan || session.planKey !== key) {
    session.plan = placementPlan(getState(), {
      weekStart: session.weekStart, ...sessionClock(), priorities: session.selected, budgetMinutes: budgetMinutes()
    });
    session.planKey = key;
  }
  return session.plan;
}

function volatileTables() {
  return !weeklyPlansRepo.isPersistent() || !protectedPeriodsRepo.isPersistent();
}

// ------------------------------------------------------------ piirto

function weekLabel() {
  return `${shortDate(session.weekStart)}–${shortDate(session.weekEnd)}`;
}

function whichWeek() {
  return session.current ? 'tällä viikolla' : 'ensi viikolla';
}

function moreLine(count, text = 'muuta tallessa') {
  return count > 0 ? `<p class="dir-line">${escapeHtml(`ja ${count} ${text}.`)}</p>` : '';
}

function dumpStep() {
  const hasText = String(session.dumpDraft || '').trim() !== '';
  return {
    title: 'Mitä sinulla on mielessä?',
    hint: 'Kirjoita kaikki mieleen tuleva, yksi asia riville. Mitään ei tarvitse päättää nyt: rivit menevät saapuviin talteen.',
    controls: `
      <label class="visually-hidden" for="sundayResetDump">Mitä sinulla on mielessä? Yksi asia riville.</label>
      <textarea id="sundayResetDump" class="sunday-reset-dump" rows="6" maxlength="8000" data-focus="dump"
        placeholder="esim. Soita neuvolaan&#10;Auton katsastus&#10;Lahja Annille">${escapeHtml(session.dumpDraft || '')}</textarea>`,
    primary: hasText ? { label: 'Kirjaa saapuviin', action: 'capture' } : { label: 'Seuraava', action: 'next' }
  };
}

function sortStep(state) {
  const model = inboxStepModel(state);
  const captured = session.dumpResult && session.dumpResult.count > 0
    ? `<p class="dir-line" role="status">${escapeHtml(`Kirjattu ${countOf(session.dumpResult.count, 'asia', 'asiaa')} saapuviin. Ne ovat tallessa.`)}</p>`
    : '';
  if (model.count === 0) {
    return {
      title: 'Saapuvat on tyhjä',
      hint: 'Mitään ei odota järjestämistä.',
      controls: captured,
      primary: { label: 'Seuraava', action: 'next' }
    };
  }
  return {
    title: `Saapuvissa odottaa ${countOf(model.count, 'asia', 'asiaa')}`,
    hint: 'Ne ovat tallessa. Voit järjestää ne nyt tai myöhemmin — kumpikin on hyvä.',
    controls: `${captured}
      <ul class="dir-setup-list sunday-reset-list">${model.shown.map(item => `<li>${escapeHtml(item.text)}</li>`).join('')}</ul>
      ${moreLine(model.more)}
      <div class="assist-actions">
        <button type="button" class="assist-btn" data-reset="open-inbox" data-focus="open-inbox">Järjestä saapuvat</button>
      </div>`,
    primary: { label: 'Jätä myöhemmäksi — ne ovat tallessa', action: 'next' }
  };
}

function capacityStep(state) {
  const model = capacityModel();
  const b = model.breakdown;
  const rows = [
    ['Valveilla unen jälkeen', b.awakeMinutes, ''],
    ['Kalenteri, kiinteät tehtävät, rutiinit ja matkat', b.calendarMinutes, '−'],
    [`Suojattu oma aika, vapaa-aika ja loma${b.vacationDays > 0 ? ` (${countOf(b.vacationDays, 'lomapäivä', 'lomapäivää')})` : ''}`, b.protectedMinutes, '−'],
    [`Puskuri yllätyksille (${Math.round(model.bufferRatio * 100)} %)`, b.bufferMinutes, '−'],
    ['Unen vaje', b.sleepAdjustMinutes, '−'],
    ['Viikon vähimmäisvapaa-aika', b.reservedFreeMinutes, '−'],
    ['Liian lyhyet välit', b.shortGapMinutes, '−']
  ].filter(([, minutes, sign], index) => index === 0 || index === 1 || index === 3 || (sign && minutes > 0));
  const hours = draftHours(model);
  const typed = parseHours(hours);
  const above = Number.isInteger(typed) && typed > model.totalMinutes;
  return {
    title: `Paljonko ${whichWeek()} on oikeasti aikaa?`,
    hint: 'Luku on laskettu kalenterista, suojatusta ajasta ja puskurista. Voit muuttaa sitä.',
    controls: `
      <p class="sunday-reset-number" id="sundayResetCapacityTotal">Joustavaa aikaa noin <strong>${escapeHtml(hoursText(model.totalMinutes))}</strong></p>
      <p class="dir-setup-step" id="sundayResetBreakdownTitle">Mistä luku tulee</p>
      <ul class="dir-setup-list sunday-reset-breakdown" aria-labelledby="sundayResetBreakdownTitle">
        ${rows.map(([label, minutes, sign]) => `<li>${escapeHtml(label)}: ${escapeHtml(`${sign}${hoursText(minutes)}`)}</li>`).join('')}
        <li><strong>${escapeHtml(`Joustavaa aikaa: ${hoursText(model.totalMinutes)}`)}</strong></li>
      </ul>
      ${model.declared ? `<p class="dir-line">${escapeHtml(`Tälle viikolle on jo asetettu ${hoursText(model.declared.availableMinutes)}.`)}</p>` : ''}
      <label class="field-label" for="sundayResetCapacity">Tunteja suunniteltuun tekemiseen</label>
      <div class="dir-setup-inline">
        <button type="button" class="assist-btn" data-reset="capacity-down" data-focus="capacity-down" aria-label="Vähennä tunti">−1 h</button>
        <input type="number" id="sundayResetCapacity" min="0" max="168" step="0.5" inputmode="decimal" data-focus="capacity"
          value="${escapeHtml(String(hours).replace(',', '.'))}">
        <button type="button" class="assist-btn" data-reset="capacity-up" data-focus="capacity-up" aria-label="Lisää tunti">+1 h</button>
      </div>
      ${above ? '<p class="dir-line">Sijoittelu käyttää silti enintään laskettua aikaa, jotta päivät eivät täyty.</p>' : ''}`,
    primary: { label: 'Tallenna ja jatka', action: 'save-capacity' }
  };
}

function priorityButton(entry, pressed) {
  const key = priorityKey(entry);
  session.candidateMap.set(key, { ref: entry.ref || 'text', title: entry.title });
  return `<button type="button" class="assist-btn dir-setup-chip" data-reset-priority="${escapeHtml(key)}"
    data-focus="priority:${escapeHtml(key)}" aria-pressed="${pressed ? 'true' : 'false'}">${pressed ? '✓ ' : '+ '}${escapeHtml(entry.title)}${
    entry.reason ? ` <span class="sunday-reset-reason">(${escapeHtml(entry.reason)})</span>` : ''}</button>`;
}

function prioritiesStep(state) {
  const candidates = priorityCandidates(state, { weekStart: session.weekStart, todayIso: session.todayIso });
  session.candidateMap = new Map();
  const chosen = new Set(session.selected.map(priorityKey));
  const shownKeys = new Set();
  const groups = candidates.groups.map(group => `
    <p class="dir-setup-step">${escapeHtml(group.label)}</p>
    <div class="assist-actions dir-chips">${group.items.map(item => {
      shownKeys.add(priorityKey(item));
      return priorityButton(item, chosen.has(priorityKey(item)));
    }).join('')}</div>`).join('');
  const own = session.selected.filter(entry => !shownKeys.has(priorityKey(entry)));
  const selectedText = session.selected.length === 0
    ? 'Et ole valinnut vielä mitään. Sekin on hyvä vastaus.'
    : `Valittu ${session.selected.length}/${WEEKLY_PRIORITY_LIMIT}: ${session.selected.map(entry => entry.title).join(', ')}.`;
  return {
    title: `Mitkä ovat ${session.current ? 'tämän' : 'ensi'} viikon tärkeimmät asiat?`,
    hint: PRIORITY_LIMIT_MESSAGE,
    controls: `
      ${groups || '<p class="dir-line">Ehdotuksia ei ole. Voit kirjoittaa oman.</p>'}
      ${moreLine(candidates.more)}
      ${own.length > 0 ? `<p class="dir-setup-step">Omat</p>
        <div class="assist-actions dir-chips">${own.map(entry => priorityButton(entry, true)).join('')}</div>` : ''}
      <label class="field-label" for="sundayResetPriorityText">Oma prioriteetti</label>
      <div class="dir-setup-inline">
        <input type="text" id="sundayResetPriorityText" maxlength="${MAX_PRIORITY_TITLE_LENGTH}" autocomplete="off"
          data-focus="priority-text" value="${escapeHtml(session.priorityText || '')}" placeholder="esim. Levätä enemmän">
        <button type="button" class="assist-btn" data-reset="add-priority" data-focus="add-priority">Lisää</button>
      </div>
      <p class="dir-line">${escapeHtml(selectedText)}</p>
      ${session.priorityMessage ? `<p class="dir-line sunday-reset-limit" id="sundayResetLimit">${escapeHtml(session.priorityMessage)}</p>` : ''}`,
    status: session.priorityMessage || selectedText,
    primary: { label: 'Tallenna ja jatka', action: 'save-priorities' }
  };
}

function placementLine(placement) {
  const when = dayLabel(placement.toDateIso);
  let how = 'uusi päivä';
  if (placement.result === PLACEMENT.KEPT) how = 'pysyy päivällään';
  else if (placement.fromDateIso) how = `siirto ${dayLabel(placement.fromDateIso)} → ${when}`;
  return `<li>${escapeHtml(`${placement.title} — ${when} (${how}, ${hoursText(placement.minutes)})`)}${
    placement.focus ? ' <span class="sunday-reset-reason">(prioriteetti tai määräaika)</span>' : ''}</li>`;
}

function placeStep() {
  const plan = ensurePlan();
  const shown = plan.placements.slice(0, PLACEMENT_PREVIEW_LIMIT);
  const notShown = plan.notFitting.slice(0, NOT_FITTING_PREVIEW_LIMIT);
  const changes = plan.changes.length;
  const summary = `Käytössä ${hoursText(plan.placedMinutes)} / ${hoursText(plan.capacityMinutes)} joustavasta ajasta.`;
  const empty = plan.placements.length === 0 && plan.notFitting.length === 0;
  return {
    title: 'Sijoitetaan välttämätön',
    hint: 'Vain se, mikä mahtuu. Suojattuun aikaan ja lomalle ei sijoiteta mitään.',
    controls: empty
      ? `<p class="dir-line">${escapeHtml(`Sijoitettavaa ei ole ${whichWeek()}. Kaikki on tallessa.`)}</p>`
      : `
      <p class="dir-line">${escapeHtml(summary)}</p>
      ${plan.placements.length > 0 ? `<p class="dir-setup-step" id="sundayResetFitsTitle">${escapeHtml(`Mahtuu (${plan.placements.length})`)}</p>
      <ul class="dir-setup-list sunday-reset-list" aria-labelledby="sundayResetFitsTitle">${shown.map(placementLine).join('')}</ul>
      ${moreLine(plan.placements.length - shown.length, 'muuta mahtuu')}` : ''}
      ${plan.notFitting.length > 0 ? `<p class="dir-setup-step" id="sundayResetNoFitTitle">${escapeHtml(`Ei mahdu (${plan.notFitting.length})`)}</p>
      <p class="dir-line">${escapeHtml(NOT_FITTING_MESSAGE)}</p>
      <ul class="dir-setup-list sunday-reset-list" aria-labelledby="sundayResetNoFitTitle">${notShown.map(entry =>
        `<li>${escapeHtml(entry.title)}</li>`).join('')}</ul>
      ${moreLine(plan.notFitting.length - notShown.length)}` : ''}
      ${session.planResult && session.planResult.failed > 0
        ? `<p class="dir-line">${escapeHtml(`${countOf(session.planResult.failed, 'siirto', 'siirtoa')} ei tallentunut. Muut ovat paikallaan.`)}</p>` : ''}`,
    primary: changes > 0
      ? { label: `Hyväksy (${countOf(changes, 'muutos', 'muutosta')})`, action: 'apply-plan' }
      : { label: 'Seuraava', action: 'next' }
  };
}

function weekdayOptions(days, selected) {
  return days.map(day => `<option value="${day}"${day === selected ? ' selected' : ''}>${escapeHtml(WEEKDAY_NAMES[day])}</option>`).join('');
}

function protectStep(state) {
  const model = protectStepModel(state, { weekStart: session.weekStart, ...sessionClock() });
  const ft = model.freeTime;
  let freeLine = 'Viikon vähimmäisvapaa-aikaa ei ole asetettu.';
  if (ft.targetMinutes !== null) {
    freeLine = `Vapaa-aikaa vähintään ${hoursText(ft.targetMinutes)}: suojattuna ${hoursText(ft.coveredMinutes)}`
      + (ft.reserveMinutes > 0 ? `, loput ${hoursText(ft.reserveMinutes)} pidetään vapaana viikon joustavasta ajasta.` : '. Tavoite täyttyy.');
  }
  const eveningDays = model.eveningDays;
  const eveningDay = eveningDays.includes(session.eveningDay) ? session.eveningDay
    : (eveningDays.find(day => day <= 5) || eveningDays[0] || null);
  session.eveningDay = eveningDay;
  const ownDay = Number.isInteger(session.ownDay) ? session.ownDay : 3;
  session.ownDay = ownDay;
  return {
    title: 'Suojaa omaa aikaa',
    hint: 'Kiinteät menot pysyvät näkyvissä. Oma aika ja vapaa-aika ovat yhtä lailla sovittuja.',
    controls: `
      <p class="dir-setup-step" id="sundayResetEssentialsTitle">Kiinteät menot</p>
      ${model.essentials.length === 0
        ? `<p class="dir-line">${escapeHtml(`Ei kiinteitä menoja ${whichWeek()}.`)}</p>`
        : `<ul class="dir-setup-list sunday-reset-list" aria-labelledby="sundayResetEssentialsTitle">${model.essentials.map(item =>
          `<li>${escapeHtml(`${dayLabel(item.date)}${item.time ? ` klo ${item.time.replace(':', '.')}` : ''} — ${item.title}`)}</li>`).join('')}</ul>
        ${moreLine(model.essentialsMore, 'muuta menoa')}`}
      <p class="dir-setup-step" id="sundayResetProtectedTitle">Suojattu aika</p>
      ${model.protected.length === 0
        ? '<p class="dir-line">Suojattua omaa aikaa tai vapaa-aikaa ei ole vielä.</p>'
        : `<ul class="dir-setup-list sunday-reset-list" aria-labelledby="sundayResetProtectedTitle">${model.protected.map(item =>
          `<li>${escapeHtml(`${item.text} — ${hoursText(item.minutes)}`)}</li>`).join('')}</ul>`}
      ${model.vacationDays > 0 ? `<p class="dir-line">${escapeHtml(`Lomaa ${countOf(model.vacationDays, 'päivä', 'päivää')}: joustavaa työtä ei sijoiteta lomalle.`)}</p>` : ''}
      <p class="dir-line" id="sundayResetFreeTime">${escapeHtml(freeLine)}</p>
      ${eveningDay ? `
      <label class="field-label" for="sundayResetEveningDay">Suojattu vapaa ilta</label>
      <div class="dir-setup-inline">
        <select id="sundayResetEveningDay" data-focus="evening-day">${weekdayOptions(eveningDays, eveningDay)}</select>
        <button type="button" class="assist-btn" data-reset="add-evening" data-focus="add-evening">Lisää vapaa ilta</button>
      </div>` : ''}
      <label class="field-label" for="sundayResetOwnDay">Oma aika (1 h viikoittain)</label>
      <div class="dir-setup-inline">
        <select id="sundayResetOwnDay" data-focus="own-day">${weekdayOptions([1, 2, 3, 4, 5, 6, 7], ownDay)}</select>
        <label class="visually-hidden" for="sundayResetOwnTime">Oman ajan alkuaika</label>
        <input type="time" id="sundayResetOwnTime" data-focus="own-time" value="${escapeHtml(session.ownTime || DEFAULT_OWN_TIME_START)}">
        <button type="button" class="assist-btn" data-reset="add-own-time" data-focus="add-own-time">Lisää oma aika</button>
      </div>
      ${session.protectMessage ? `<p class="dir-line">${escapeHtml(session.protectMessage)}</p>` : ''}`,
    status: session.protectMessage,
    primary: { label: 'Seuraava', action: 'next' }
  };
}

function closeStep(state) {
  const planned = plannedMinutesForWeek(state, session.weekStart);
  const priorities = session.selected;
  return {
    title: 'Sulje viikko',
    hint: 'Suunnitelma tallentuu. Voit muuttaa sitä milloin tahansa.',
    controls: `
      <p class="dir-setup-step" id="sundayResetSummaryTitle">Viikon prioriteetit</p>
      ${priorities.length === 0
        ? '<p class="dir-line">Ei valittuja prioriteetteja — sekin on hyvä.</p>'
        : `<ul class="dir-setup-list sunday-reset-list" aria-labelledby="sundayResetSummaryTitle">${priorities.map(entry =>
          `<li>${escapeHtml(entry.title)}</li>`).join('')}</ul>`}
      <p class="dir-line">${escapeHtml(`Suunniteltua tekemistä ${whichWeek()}: ${hoursText(planned)}.`)}</p>`,
    primary: { label: 'Sulje viikko', action: 'close-week' },
    noSkip: true
  };
}

function stepContent(key, state) {
  switch (key) {
    case 'dump': return dumpStep();
    case 'sort': return sortStep(state);
    case 'capacity': return capacityStep(state);
    case 'priorities': return prioritiesStep(state);
    case 'place': return placeStep();
    case 'protect': return protectStep(state);
    default: return closeStep(state);
  }
}

function finalHtml() {
  return `
    <h2 class="dir-setup-title sunday-reset-final-title" id="sundayResetTitle" tabindex="-1">${escapeHtml(SUNDAY_RESET_FINAL_TITLE)}</h2>
    <p class="sunday-reset-final" id="sundayResetFinalText">${escapeHtml(SUNDAY_RESET_FINAL_TEXT)}</p>
    <div class="dir-setup-nav">
      <button type="button" class="assist-btn primary" data-reset="finish" data-focus="finish">Valmis</button>
    </div>`;
}

function cardHtml(content) {
  const first = session.stepIndex === 0;
  const busy = session.busy;
  const volatile = session.volatileHint
    ? '<p class="hint sunday-reset-volatile">Huom: viikkosuunnitelma ja suojatut ajat säilyvät toistaiseksi vain tämän istunnon ajan.</p>'
    : '';
  return `
    <h2 class="dir-setup-title" id="sundayResetTitle" tabindex="-1">${escapeHtml(content.title)}</h2>
    ${content.hint ? `<p class="hint">${escapeHtml(content.hint)}</p>` : ''}
    ${volatile}
    <div class="dir-setup-body" role="group" aria-labelledby="sundayResetTitle">${content.controls}</div>
    ${session.error ? `<p class="field-error dir-setup-error" id="sundayResetError" role="alert">${escapeHtml(session.error)}</p>` : ''}
    <div class="dir-setup-nav">
      <button type="button" class="assist-btn" data-reset="back" data-focus="back"${first || busy ? ' disabled' : ''}>Takaisin</button>
      ${content.noSkip ? '' : `<button type="button" class="assist-btn" data-reset="skip" data-focus="skip"${busy ? ' disabled' : ''}>Ohita tämä vaihe</button>`}
      <button type="button" class="assist-btn primary" data-reset="${content.primary.action}" data-focus="primary"${busy ? ' disabled' : ''}>${escapeHtml(content.primary.label)}</button>
    </div>`;
}

function activeFocusKey(container) {
  if (typeof document === 'undefined') return null;
  const active = document.activeElement;
  if (!active || !active.dataset || !active.dataset.focus) return null;
  if (typeof container.contains === 'function' && !container.contains(active)) return null;
  return active.dataset.focus;
}

function restoreFocusKey(container, key) {
  if (!key || typeof container.querySelector !== 'function') return false;
  const target = container.querySelector(`[data-focus="${key.replace(/"/g, '\\"')}"]`);
  if (!target || typeof target.focus !== 'function' || target.disabled) return false;
  target.focus();
  return true;
}

/** Piirrä nollauksen nykyinen vaihe dialogiin. Palauttaa vaiheen avaimen. */
export function renderSundayReset() {
  const card = maybe('sundayResetCard');
  if (!card || !session) return null;
  const state = getState();
  const key = currentStepKey();
  let html;
  let status = '';
  let label;
  if (key === 'done') {
    html = finalHtml();
    label = `Viikko ${weekLabel()} suljettu`;
    status = SUNDAY_RESET_FINAL_COPY.replace('\n', ' ');
  } else {
    const content = stepContent(key, state);
    html = cardHtml(content);
    label = `Vaihe ${session.stepIndex + 1}/${SUNDAY_RESET_STEPS.length} · ${SUNDAY_RESET_STEP_LABELS[key]} · viikko ${weekLabel()}`;
    status = content.status || '';
  }
  const stepLabel = maybe('sundayResetStepLabel');
  if (stepLabel && stepLabel.textContent !== label) stepLabel.textContent = label;
  const previous = activeFocusKey(card);
  const changed = setHtml(card, html);
  const live = maybe('sundayResetStatus');
  if (live && live.textContent !== status) live.textContent = status;
  if (session.focusTitle) {
    session.focusTitle = false;
    const title = maybe('sundayResetTitle');
    if (title && typeof title.focus === 'function') title.focus();
  } else if (changed && previous && !restoreFocusKey(card, previous)) {
    const title = maybe('sundayResetTitle');
    if (title && typeof title.focus === 'function') title.focus();
  }
  return key;
}

// ------------------------------------------------------------ dialogi

function dialogNode() {
  return maybe('sundayResetDialog');
}

function showDialog() {
  const dialog = dialogNode();
  if (!dialog) return;
  if (!dialog.open) {
    if (typeof dialog.showModal === 'function') {
      try { dialog.showModal(); } catch { dialog.open = true; }
    } else {
      dialog.open = true;
      if (typeof dialog.setAttribute === 'function') dialog.setAttribute('open', '');
    }
  }
  dialogOpen = true;
}

function hideDialog() {
  const dialog = dialogNode();
  dialogOpen = false;
  if (!dialog) return;
  if (dialog.open && typeof dialog.close === 'function') dialog.close();
  else {
    dialog.open = false;
    if (typeof dialog.removeAttribute === 'function') dialog.removeAttribute('open');
  }
}

function showResume(visible) {
  const resume = maybe('sundayResetResume');
  if (resume) resume.hidden = !visible;
}

/** Onko nollausdialogi auki? */
export function isSundayResetOpen() {
  return dialogOpen;
}

/** Nollauksen tila testeille ja kutsujille (vain luku). */
export function sundayResetSession() {
  if (!session) return null;
  return {
    weekStart: session.weekStart, weekEnd: session.weekEnd, current: session.current,
    step: currentStepKey(), selected: session.selected.map(entry => ({ ...entry })),
    finished: session.finished, busy: session.busy, error: session.error,
    priorityMessage: session.priorityMessage, plan: session.plan, dumpResult: session.dumpResult
  };
}

/**
 * Avaa sunnuntain nollaus. Kesken jäänyt nollaus samalle viikolle jatkuu
 * siitä, mihin jäi (Escape säilyttää etenemisen).
 *
 * @param {object} [options]
 * @param {Date}   [options.now]       hetki (oletus: nyt)
 * @param {string} [options.weekStart] kohdeviikko (oletus: sundayResetTargetWeek)
 * @param {string} [options.step]      avattava vaihe (esim. 'sort' saapuvista palatessa)
 * @param {boolean} [options.fresh]    aloita alusta
 * @returns {{weekStart:string, step:string}|null}
 */
export function openSundayReset(options = {}) {
  ensureBound();
  const clock = clockNow(options.now instanceof Date ? options.now : new Date());
  let target = sundayResetTargetWeek(clock.todayIso, clock.nowMinutes);
  if (isIsoDate(options.weekStart)) {
    const monday = weekStartOf(options.weekStart);
    target = { weekStart: monday, weekEnd: addDaysIso(monday, 6), current: monday <= clock.todayIso };
  }
  if (!target) return null;
  if (!session || session.finished || options.fresh || session.weekStart !== target.weekStart) {
    session = newSession(target, clock);
  } else {
    session.todayIso = clock.todayIso;
    session.nowMinutes = clock.nowMinutes;
  }
  if (typeof options.step === 'string' && SUNDAY_RESET_STEPS.includes(options.step)) {
    session.stepIndex = SUNDAY_RESET_STEPS.indexOf(options.step);
  }
  if (!volatileHintShown && volatileTables()) {
    volatileHintShown = true;
    session.volatileHint = true;
  }
  session.error = '';
  session.focusTitle = true;
  showResume(false);
  showDialog();
  renderSundayReset();
  return { weekStart: session.weekStart, step: currentStepKey() };
}

/** Sulje dialogi. Eteneminen säilyy muistissa (paitsi valmiin nollauksen jälkeen). */
export function closeSundayReset() {
  hideDialog();
  if (session && session.finished) session = null;
}

/** Uloskirjautuminen: nollauksen eteneminen ja vihjeet pois. */
export function resetSundayReset() {
  const hasDom = typeof document !== 'undefined';
  if (dialogOpen && hasDom) hideDialog();
  session = null;
  dialogOpen = false;
  volatileHintShown = false;
  if (hasDom) showResume(false);
}

// ------------------------------------------------------------ toiminnot

function go(index) {
  session.stepIndex = Math.max(0, Math.min(SUNDAY_RESET_STEPS.length - 1, index));
  session.error = '';
  session.priorityMessage = '';
  session.protectMessage = '';
  session.focusTitle = true;
  renderSundayReset();
}

function next() {
  go(session.stepIndex + 1);
}

async function withBusy(fn) {
  if (session.busy) return undefined;
  session.busy = true;
  session.error = '';
  renderSundayReset();
  try {
    return await fn();
  } finally {
    if (session) session.busy = false;
  }
}

async function capture() {
  const text = String(session.dumpDraft || '');
  if (!text.trim()) { next(); return; }
  const result = await withBusy(() => captureBrainDump(text));
  if (!session || !result) return;
  if (!result.ok) {
    session.error = (result.errors && result.errors.text) || 'Kirjaus ei onnistunut. Teksti on yhä kentässä.';
    renderSundayReset();
    return;
  }
  session.dumpDraft = '';
  session.dumpResult = { count: result.items.length, failed: result.failed, skipped: result.skipped };
  next();
}

function openInbox() {
  // Ei toista käsittelynäkymää: Tekeminen → Saapuvat, ja paluu napista.
  session.stepIndex = SUNDAY_RESET_STEPS.indexOf('sort');
  hideDialog();
  setTasksSegment('inbox');
  switchTab('screen-tasks');
  showResume(true);
}

function adjustCapacity(deltaHours) {
  const model = capacityModel();
  const current = parseHours(draftHours(model));
  const base = Number.isInteger(current) ? current : model.totalMinutes;
  const minutes = Math.max(0, Math.min(168 * 60, base + deltaHours * 60));
  session.capacityDraft = String(Math.round((minutes / 60) * 2) / 2).replace('.', ',');
  renderSundayReset();
}

async function saveCapacity() {
  const model = capacityModel();
  const minutes = parseHours(draftHours(model));
  if (!Number.isInteger(minutes)) {
    session.error = 'Anna tunnit väliltä 0–168, esim. 20 tai 12,5.';
    renderSundayReset();
    return;
  }
  const result = await withBusy(() => saveWeeklyCapacity({ weekStart: session.weekStart, availableMinutes: minutes }));
  if (!session) return;
  if (!result || !result.ok) {
    session.error = (result && result.errors && result.errors.availableMinutes) || 'Kapasiteettia ei saatu tallennettua.';
    renderSundayReset();
    return;
  }
  session.capacitySaved = minutes;
  session.plan = null;
  next();
}

function togglePriorityKey(key) {
  const entry = session.candidateMap.get(key) || session.selected.find(item => priorityKey(item) === key);
  if (!entry) return;
  const result = togglePriority(session.selected, entry);
  session.selected = result.selected;
  session.priorityMessage = result.message;
  renderSundayReset();
}

function addOwnPriority() {
  const title = String(session.priorityText || '').normalize('NFC').trim().slice(0, MAX_PRIORITY_TITLE_LENGTH);
  if (!title) {
    session.priorityMessage = 'Kirjoita prioriteetti ensin.';
    renderSundayReset();
    return;
  }
  const exists = session.selected.some(item => priorityKey(item) === priorityKey({ ref: 'text', title }));
  const result = exists ? { selected: session.selected, message: '' } : togglePriority(session.selected, { ref: 'text', title });
  session.selected = result.selected;
  session.priorityMessage = result.message;
  if (!result.message) {
    session.priorityText = '';
    const input = maybe('sundayResetPriorityText');
    if (input) input.value = '';
  }
  renderSundayReset();
}

async function savePriorities() {
  const existing = weeklyPlanFor(getState().weeklyPlans, session.weekStart);
  if (session.selected.length === 0 && !existing) { next(); return; }
  const result = await withBusy(() => saveWeeklyPlan({ weekStart: session.weekStart, priorities: session.selected }));
  if (!session) return;
  if (!result || !result.ok) {
    session.error = (result && result.errors && result.errors.priorities) || 'Prioriteetteja ei saatu tallennettua.';
    renderSundayReset();
    return;
  }
  session.prioritiesSaved = true;
  session.plan = null;
  next();
}

async function applyPlan() {
  const plan = ensurePlan();
  const result = await withBusy(() => applyPlacementPlan(plan));
  if (!session) return;
  session.planResult = result;
  session.plan = null;
  if (result && result.failed > 0) {
    renderSundayReset();
    return;
  }
  next();
}

async function addEvening() {
  const day = Number(session.eveningDay);
  const result = await withBusy(() => addFreeEvening(day));
  if (!session) return;
  session.protectMessage = result && result.ok
    ? `Lisätty: vapaa ilta, ${WEEKDAY_NAMES[day]}.` : 'Vapaata iltaa ei saatu tallennettua.';
  session.plan = null;
  renderSundayReset();
}

async function addOwnTime() {
  const day = Number(session.ownDay);
  const start = session.ownTime || DEFAULT_OWN_TIME_START;
  const result = await withBusy(() => addOwnTimeSlot(day, { startTime: start, weekStart: session.weekStart }));
  if (!session) return;
  session.protectMessage = result && result.ok
    ? `Lisätty: oma aika, ${WEEKDAY_NAMES[day]} klo ${start.replace(':', '.')}.`
    : ((result && result.errors && Object.values(result.errors)[0]) || 'Omaa aikaa ei saatu tallennettua.');
  session.plan = null;
  renderSundayReset();
}

async function closeTheWeek() {
  const plannedMinutes = plannedMinutesForWeek(getState(), session.weekStart);
  const result = await withBusy(() => closeWeek(session.weekStart, { priorities: session.selected, plannedMinutes }));
  if (!session) return;
  if (!result || !result.ok) {
    session.error = (result && result.errors && (result.errors.priorities || result.errors.weekStart))
      || 'Viikkoa ei saatu suljettua. Yritä hetken päästä uudelleen.';
    renderSundayReset();
    return;
  }
  session.finished = true;
  session.focusTitle = true;
  renderSundayReset();
}

async function onAction(action, target = null) {
  if (!session) return;
  switch (action) {
    case 'back': go(session.stepIndex - 1); break;
    case 'skip':
    case 'next': next(); break;
    case 'capture': await capture(); break;
    case 'open-inbox': openInbox(); break;
    case 'capacity-down': adjustCapacity(-1); break;
    case 'capacity-up': adjustCapacity(1); break;
    case 'save-capacity': await saveCapacity(); break;
    case 'toggle-priority': if (target) togglePriorityKey(target); break;
    case 'add-priority': addOwnPriority(); break;
    case 'save-priorities': await savePriorities(); break;
    case 'apply-plan': await applyPlan(); break;
    case 'add-evening': await addEvening(); break;
    case 'add-own-time': await addOwnTime(); break;
    case 'close-week': await closeTheWeek(); break;
    case 'finish': closeSundayReset(); session = null; break;
    default: break;
  }
}

/** Testejä varten: toiminto suoraan (sama kuin painikkeen napautus). */
export function sundayResetActionForTests(action, target = null) {
  return onAction(action, target);
}

function syncPrimaryForDump() {
  const card = maybe('sundayResetCard');
  const button = card && typeof card.querySelector === 'function' ? card.querySelector('[data-focus="primary"]') : null;
  if (!button || currentStepKey() !== 'dump') return;
  const primary = dumpStep().primary;
  button.dataset.reset = primary.action;
  button.textContent = primary.label;
}

function onClick(event) {
  const target = event.target;
  if (!target || typeof target.closest !== 'function') return;
  if (target.closest('#sundayResetClose')) { closeSundayReset(); return; }
  const chip = target.closest('[data-reset-priority]');
  if (chip && !chip.disabled) { onAction('toggle-priority', chip.dataset.resetPriority); return; }
  const button = target.closest('[data-reset]');
  if (button && !button.disabled) onAction(button.dataset.reset);
}

function onInput(event) {
  const field = event.target;
  if (!field || !field.dataset || !session) return;
  switch (field.dataset.focus) {
    case 'dump': session.dumpDraft = field.value; syncPrimaryForDump(); break;
    case 'capacity': session.capacityDraft = field.value; break;
    case 'priority-text': session.priorityText = field.value; break;
    case 'own-time': session.ownTime = field.value; break;
    case 'evening-day': session.eveningDay = Number(field.value); break;
    case 'own-day': session.ownDay = Number(field.value); break;
    default: break;
  }
}

function onKeydown(event) {
  if (!session) return;
  if (event.key === 'Escape') {
    // Escape sulkee; eteneminen säilyy muistissa.
    event.preventDefault();
    closeSundayReset();
    return;
  }
  if (event.key !== 'Enter' || !event.target || !event.target.dataset) return;
  if (event.target.dataset.focus === 'priority-text') {
    event.preventDefault();
    session.priorityText = event.target.value;
    addOwnPriority();
  } else if (event.target.dataset.focus === 'capacity') {
    event.preventDefault();
    session.capacityDraft = event.target.value;
    saveCapacity();
  }
}

/** Kytke dialogin ja paluunapin tapahtumat kerran (ensimmäisellä avauksella). */
function ensureBound() {
  if (bound) return;
  const dialog = dialogNode();
  if (!dialog) return;
  bound = true;
  dialog.addEventListener('click', onClick);
  dialog.addEventListener('input', onInput);
  dialog.addEventListener('change', onInput);
  dialog.addEventListener('keydown', onKeydown);
  // Selaimen oma sulkeminen (esim. lomake tai käyttöjärjestelmän ele).
  dialog.addEventListener('close', () => { dialogOpen = false; });
  const resume = maybe('sundayResetResume');
  if (resume) resume.addEventListener('click', () => openSundayReset({ step: 'sort' }));
}

/** Testejä varten: DOM vaihtui, kytkennät tehdään uudelleen. */
export function rebindSundayResetForTests() {
  bound = false;
  dialogOpen = false;
}

// ------------------------------------------------------------ Tänään-kortti

const entryContainers = new WeakSet();

/**
 * Pieni "Sulje viikko — 10 minuuttia" -kortti. Kutsuja (Tänään) päättää
 * paikan; tämä päättää, näkyykö kortti (shouldShowSundayResetEntry).
 *
 * @param {HTMLElement|null} container
 * @param {{state?:object, now?:Date}} [options]
 * @returns {boolean} näkyykö kortti
 */
export function renderSundayResetEntry(container, { state = getState(), now = new Date() } = {}) {
  const clock = clockNow(now instanceof Date ? now : new Date());
  const visible = shouldShowSundayResetEntry(state, clock);
  if (!container) return visible;
  if (!visible) {
    setHtml(container, '');
    container.hidden = true;
    return false;
  }
  const target = sundayResetTargetWeek(clock.todayIso, clock.nowMinutes);
  const which = target.current ? 'tämä viikko' : 'ensi viikko';
  setHtml(container, `
    <div class="sunday-reset-entry" role="group" aria-labelledby="sundayResetEntryTitle">
      <h2 class="section-title" id="sundayResetEntryTitle">Sulje viikko — 10 minuuttia</h2>
      <p class="hint">${escapeHtml(`Kirjaa mielessä olevat, valitse muutama tärkeä asia ja suojaa omaa aikaa. Sen jälkeen ${which} on suunniteltu.`)}</p>
      <button type="button" class="assist-btn primary" id="sundayResetOpenBtn" data-sunday-reset-open="1">Aloita viikon sulkeminen</button>
    </div>`);
  container.hidden = false;
  if (!entryContainers.has(container) && typeof container.addEventListener === 'function') {
    entryContainers.add(container);
    container.addEventListener('click', event => {
      const button = event.target && typeof event.target.closest === 'function'
        ? event.target.closest('[data-sunday-reset-open]') : null;
      if (button) openSundayReset();
    });
  }
  return true;
}
