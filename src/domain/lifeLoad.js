// Elämän kuorma: YKSI prioriteetti- ja kuormamoottori.
//
// Puhdas moduuli: ei DOM:ia, ei verkkoa, ei kelloa. Sama syöte tuottaa
// aina saman, jäädytetyn tuloksen.
//
// =====================================================================
// TÄMÄN MODUULIN TEHTÄVÄ ON VÄHENTÄÄ, EI LISÄTÄ
// =====================================================================
//
// Manifestivalin ensisijainen tehtävä on vähentää asioita, jotka käyttäjän
// on pidettävä aktiivisesti mielessä (docs/MENTAL-LOAD-CORE.md). Tämä
// moottori jakaa jokaisen avoimen asian yhteen horisonttiin:
//
//   NOW        tänään, enintään kolme, ja vain jos ne mahtuvat päivään
//   THIS_WEEK  tällä viikolla
//   LATER      myöhemmin (päivätty myöhemmäksi tai tarkoituksella ilman päivää)
//   NOT_YET    ei vielä (käyttäjän valinta tai tavoite tauolla)
//   WAITING    odottaa toista ihmistä tai tahoa — ei kuluta kapasiteettia
//   ARCHIVED   poistettu näkyvistä
//
// Kaikki muu kuin NOW on "tallessa". Sen määrä kerrotaan yhtenä lukuna,
// jotta käyttäjän ei tarvitse kantaa listaa mielessään:
//
//   "Kaikki muu on tallessa (12). Sinun ei tarvitse hoitaa sitä tänään."
//
// =====================================================================
// YKSI MOOTTORI
// =====================================================================
//
// Tänään, avustajan NYT/SEURAAVA, suunnittelija (isSchedulable), katsaukset
// ja ilmoitukset käyttävät tätä. Pisteytys on focus.js:n scoreTask (sama
// dokumentoitu taulukko), jota täydennetään vain tämän moduulin säännöillä:
//
//   käyttäjän valitsema fokus (horizon NOW)   +200
//   viikon prioriteetti (weekly_plans)         +45
//   lasku: myöhässä +100, tänään +60, huomenna +35, lähipäivinä +20
//
// SÄÄNNÖT, JOTKA EIVÄT OLE PISTEITÄ
//   - myöhässä ≠ automaattisesti NOW: se kilpailee pisteillä ja kapasiteetilla
//   - NOW-joukon kesto ≤ päivän jäljellä oleva joustava aika (jos tiedossa)
//   - hyvinvointi, ilo ja vapaa-aika pääsevät fokukseen vain, kun käyttäjä on
//     valinnut ne (fokus, viikon prioriteetti tai korkea prioriteetti)
//   - rutiinit eivät ole koskaan fokusta
//   - tänään ajastettu tehtävä (itse tai automaatin) kuuluu aikajanalle, ei fokukseen
//     (sama asia ei näy kahdesti)
//   - laskun ja siihen liitetyn tehtävän kaksoisesiintyminen estetään

import {
  TASK_HORIZON, isIsoDate, durationOf, isOverdue, deadlineUrgency, URGENCY, compareForDay, SCHEDULING
} from './task.js';
import { scoreTask } from './focus.js';
import { deriveNature, NATURE } from './itemNature.js';
import { categoryOwnerArea } from './lifeArea.js';
import { addDaysIso, weekdayOfIso } from './fiTemporal.js';

export const LOAD_HORIZON = Object.freeze({
  NOW: 'NOW',
  THIS_WEEK: 'THIS_WEEK',
  LATER: 'LATER',
  NOT_YET: 'NOT_YET',
  WAITING: 'WAITING',
  ARCHIVED: 'ARCHIVED'
});
export const LOAD_HORIZONS = Object.freeze(Object.values(LOAD_HORIZON));

/** Omistajan päätös 6: enintään kolme aktiivista fokusta. */
export const NOW_LIMIT = 3;

/** Laskun oletuskesto, kun sitä ei tiedetä (maksaminen verkkopankissa). */
export const BILL_DEFAULT_MINUTES = 10;

/** Tehtävän oletuskesto kapasiteettilaskussa (sama kuin aikataulumoottorissa). */
export const DEFAULT_ITEM_MINUTES = 30;

/** Määräaika näin monen päivän sisällä nostaa tehtävän tämän päivän ehdokkaaksi. */
export const DEADLINE_NOW_DAYS = 2;

export const LOAD_SCORE = Object.freeze({
  PINNED: 200,
  WEEKLY_PRIORITY: 45,
  BILL_OVERDUE: 100,
  BILL_TODAY: 60,
  BILL_TOMORROW: 35,
  BILL_SOON: 20,
  FOLLOW_UP_DUE: 30
});

const HORIZON_LABELS = Object.freeze({
  [LOAD_HORIZON.NOW]: 'Tänään',
  [LOAD_HORIZON.THIS_WEEK]: 'Tällä viikolla',
  [LOAD_HORIZON.LATER]: 'Myöhemmin',
  [LOAD_HORIZON.NOT_YET]: 'Ei vielä',
  [LOAD_HORIZON.WAITING]: 'Odottaa',
  [LOAD_HORIZON.ARCHIVED]: 'Arkisto'
});

export function horizonLabel(horizon) {
  return HORIZON_LABELS[horizon] || '';
}

const INACTIVE_GOAL_STATUSES = new Set(['paused', 'completed', 'abandoned', 'archived']);
const OPT_IN_NATURES = new Set([NATURE.WELLBEING, NATURE.ENJOYMENT, NATURE.FREE_TIME]);
const EMPTY = Object.freeze([]);

function listOf(value) {
  return Array.isArray(value) ? value.filter(Boolean) : EMPTY;
}

/** Viikon sunnuntai (ISO-viikko ma–su). */
export function weekEndOf(todayIso) {
  if (!isIsoDate(todayIso)) return null;
  return addDaysIso(todayIso, 7 - weekdayOfIso(todayIso));
}

/** Kiinteästi ajastettu: käyttäjän itse asettama kellonaika. Aikajanan asia. */
export function isFixedTimed(task) {
  return Boolean(task && task.time && task.schedulingState !== SCHEDULING.AUTO);
}

function goalOf(task, goalsById, projectsById) {
  if (!task) return null;
  if (task.goalId && goalsById.has(task.goalId)) return goalsById.get(task.goalId);
  const project = task.projectId ? projectsById.get(task.projectId) : null;
  if (project && project.goalId && goalsById.has(project.goalId)) return goalsById.get(project.goalId);
  return null;
}

function inactiveProjectOf(task, projectsById) {
  const project = task && task.projectId ? projectsById.get(task.projectId) : null;
  return project && INACTIVE_GOAL_STATUSES.has(project.status) ? project : null;
}

/**
 * Tehtävän horisontti ja sen syy. `candidate: true` = tämän päivän ehdokas
 * (NOW), joka voi silti jäädä THIS_WEEK-joukkoon pisteiden tai kapasiteetin
 * takia.
 *
 * @returns {{horizon:string|null, reason:string, candidate:boolean}}
 *   horizon null = ei avoin (valmis tai herätys)
 */
export function horizonOf(task, {
  todayIso, weekEndIso = weekEndOf(todayIso), goalsById = new Map(), projectsById = new Map()
} = {}) {
  if (!task || task.completed || task.isWake) return { horizon: null, reason: '', candidate: false };
  if (task.archivedAt) return { horizon: LOAD_HORIZON.ARCHIVED, reason: 'Poistettu näkyvistä', candidate: false };

  if (task.horizon === TASK_HORIZON.WAITING) {
    const who = task.waitingOn ? `: ${task.waitingOn}` : '';
    if (task.followUpDate && isIsoDate(todayIso) && task.followUpDate <= todayIso) {
      return { horizon: LOAD_HORIZON.THIS_WEEK, reason: `Tarkista tilanne${who}`, candidate: false, followUpDue: true };
    }
    return { horizon: LOAD_HORIZON.WAITING, reason: `Odottaa${who}`, candidate: false };
  }
  if (task.horizon === TASK_HORIZON.NOT_YET) return { horizon: LOAD_HORIZON.NOT_YET, reason: 'Ei vielä', candidate: false };

  // Tauolla tai päättynyt tavoite/projekti: asia on tallessa, ei tekeillä.
  // Kiinteä meno tänään pysyy kuitenkin aikajanalla (käyttäjän lupaus).
  const goal = goalOf(task, goalsById, projectsById);
  const stopped = (goal && INACTIVE_GOAL_STATUSES.has(goal.status)) || inactiveProjectOf(task, projectsById);
  if (stopped && !(isFixedTimed(task) && task.date === todayIso)) {
    return {
      horizon: LOAD_HORIZON.NOT_YET,
      reason: goal && goal.status === 'paused' ? 'Tavoite on tauolla' : 'Tavoite ei ole työn alla',
      candidate: false
    };
  }

  if (task.horizon === TASK_HORIZON.LATER) return { horizon: LOAD_HORIZON.LATER, reason: 'Myöhemmin', candidate: false };
  if (task.horizon === TASK_HORIZON.THIS_WEEK) {
    return { horizon: LOAD_HORIZON.THIS_WEEK, reason: 'Tällä viikolla', candidate: false };
  }
  if (task.horizon === TASK_HORIZON.NOW && (!task.date || task.date === todayIso)) {
    return { horizon: LOAD_HORIZON.NOW, reason: 'Valitsit tämän tälle päivälle', candidate: true, pinned: true };
  }

  const reference = todayIso;
  if (task.date && isIsoDate(reference) && task.date <= reference) {
    return {
      horizon: LOAD_HORIZON.NOW,
      reason: task.date < reference ? 'Päivä meni jo' : 'Tälle päivälle',
      candidate: true
    };
  }
  if (task.deadline && isIsoDate(reference) && task.deadline <= addDaysIso(reference, DEADLINE_NOW_DAYS)) {
    return { horizon: LOAD_HORIZON.NOW, reason: 'Määräaika lähellä', candidate: true };
  }
  if ((task.date && weekEndIso && task.date <= weekEndIso) || (task.deadline && weekEndIso && task.deadline <= weekEndIso)) {
    return { horizon: LOAD_HORIZON.THIS_WEEK, reason: 'Tällä viikolla', candidate: false };
  }
  return { horizon: LOAD_HORIZON.LATER, reason: task.date ? 'Myöhemmin' : 'Ilman päivää', candidate: false };
}

/**
 * Saako suunnittelija (planHorizon, uudelleensuunnittelu) sijoittaa tai
 * siirtää tehtävää? Odottava, "ei vielä", arkistoitu, tauolla olevan
 * tavoitteen tehtävä ja tarkoituksella päivätön (LATER) eivät kuulu
 * automaattiseen suunnitteluun.
 */
export function isSchedulable(task, context = {}) {
  const { horizon } = horizonOf(task, context);
  if (horizon === null || horizon === LOAD_HORIZON.ARCHIVED || horizon === LOAD_HORIZON.WAITING
    || horizon === LOAD_HORIZON.NOT_YET) return false;
  if (!task.date && task.horizon === TASK_HORIZON.LATER) return false;
  return true;
}

/** Suunnittelun konteksti tilasta: tavoitteet ja projektit hakemistoina. */
export function schedulingContext({ goals = EMPTY, projects = EMPTY, todayIso = null } = {}) {
  return {
    todayIso,
    weekEndIso: weekEndOf(todayIso),
    goalsById: new Map(listOf(goals).filter(goal => goal.id).map(goal => [goal.id, goal])),
    projectsById: new Map(listOf(projects).filter(project => project.id).map(project => [project.id, project]))
  };
}

function minutesOf(task) {
  const explicit = durationOf(task);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const stored = Number(task && task.durationMinutes);
  return Number.isFinite(stored) && stored > 0 ? stored : DEFAULT_ITEM_MINUTES;
}

function areaOfTask(task, { goalsById, projectsById, areasById, areas, categoryAreas }) {
  const goal = goalOf(task, goalsById, projectsById);
  if (goal && goal.lifeAreaId && areasById.has(goal.lifeAreaId)) return areasById.get(goal.lifeAreaId);
  if (!task.category || areas.length === 0) return null;
  // Kategorian perivä alue kerran kategoriaa kohti (suuri aineisto).
  if (!categoryAreas.has(task.category)) categoryAreas.set(task.category, categoryOwnerArea(areas, task.category));
  return categoryAreas.get(task.category);
}

/** Tallessa-korien kevyt järjestys: päivä, sitten otsikko (pisteytystä ei tarvita). */
function compareStored(a, b) {
  const ad = a.date || a.deadline || '9999-12-31';
  const bd = b.date || b.deadline || '9999-12-31';
  if (ad !== bd) return ad < bd ? -1 : 1;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

function weeklyPriorityRefs(weeklyPlan) {
  const refs = new Set();
  for (const entry of listOf(weeklyPlan && weeklyPlan.priorities)) {
    if (entry && entry.ref) refs.add(String(entry.ref));
  }
  return refs;
}

function billUrgencyScore(bill, todayIso) {
  if (!isIsoDate(bill.dueDate) || !isIsoDate(todayIso)) return { score: 0, reason: null };
  if (bill.dueDate < todayIso) return { score: LOAD_SCORE.BILL_OVERDUE, reason: 'Lasku erääntyi jo' };
  if (bill.dueDate === todayIso) return { score: LOAD_SCORE.BILL_TODAY, reason: 'Lasku erääntyy tänään' };
  if (bill.dueDate === addDaysIso(todayIso, 1)) return { score: LOAD_SCORE.BILL_TOMORROW, reason: 'Lasku erääntyy huomenna' };
  if (bill.dueDate <= addDaysIso(todayIso, 3)) return { score: LOAD_SCORE.BILL_SOON, reason: 'Lasku erääntyy pian' };
  return { score: 0, reason: null };
}

function freezeEntry(entry) {
  return Object.freeze({ ...entry, reasons: Object.freeze([...entry.reasons]) });
}

function compareEntries(a, b) {
  if (a.score !== b.score) return b.score - a.score;
  if (a.kind === 'task' && b.kind === 'task') {
    const byDay = compareForDay(a.item, b.item);
    if (byDay !== 0) return byDay;
  }
  const ad = a.date || a.deadline || '9999-12-31';
  const bd = b.date || b.deadline || '9999-12-31';
  if (ad !== bd) return ad < bd ? -1 : 1;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/**
 * Laske elämän kuorma.
 *
 * @param {object} input
 * @param {Array}  input.tasks
 * @param {Array}  [input.bills]
 * @param {Array}  [input.goals]
 * @param {Array}  [input.projects]
 * @param {Array}  [input.lifeAreas]
 * @param {object} [input.weeklyPlan]      tämän viikon suunnitelma (priorities)
 * @param {string} input.todayIso
 * @param {object} [input.capacity]        { todayRemainingMinutes?, weekRemainingMinutes? } (null = ei tiedossa)
 * @param {object} [input.energy]          { level?: 1–5 } (matala energia keventää päivää)
 * @param {object} [input.options]         { nowLimit?: number }
 * @returns {Readonly<object>}
 */
export function computeLifeLoad({
  tasks = EMPTY, bills = EMPTY, goals = EMPTY, projects = EMPTY, lifeAreas = EMPTY,
  weeklyPlan = null, todayIso, capacity = null, energy = null, options = {}
} = {}) {
  const limit = Math.max(0, Math.min(NOW_LIMIT, Number.isInteger(options.nowLimit) ? options.nowLimit : NOW_LIMIT));
  const context = schedulingContext({ goals, projects, todayIso });
  const areas = listOf(lifeAreas);
  const areasById = new Map(areas.filter(area => area.id).map(area => [area.id, area]));
  const refs = weeklyPriorityRefs(weeklyPlan);
  const lookup = { ...context, areasById, areas, categoryAreas: new Map() };

  const buckets = {
    [LOAD_HORIZON.NOW]: [], [LOAD_HORIZON.THIS_WEEK]: [], [LOAD_HORIZON.LATER]: [],
    [LOAD_HORIZON.NOT_YET]: [], [LOAD_HORIZON.WAITING]: [], [LOAD_HORIZON.ARCHIVED]: []
  };
  const fixedToday = [];
  const candidates = [];
  const taskIdsLinkedToBills = new Set();

  for (const task of listOf(tasks)) {
    const where = horizonOf(task, context);
    if (where.horizon === null) continue;
    const area = areaOfTask(task, lookup);
    const { nature } = deriveNature(task, { kind: 'task', area });
    const base = {
      key: `task:${task.id}`, kind: 'task', id: task.id, title: task.title || '', item: task,
      nature, areaId: area ? area.id : null, horizon: where.horizon, date: task.date || null,
      deadline: task.deadline || null, minutes: minutesOf(task), reasons: [where.reason].filter(Boolean),
      score: 0, fits: true, pinned: Boolean(where.pinned)
    };

    // Tänään AJASTETTU (itse tai hyväksyttynä ehdotuksena) kuuluu aikajanalle:
    // sama asia ei näy fokuksessa ja aikajanalla (Rauhallinen tänään).
    if (where.horizon === LOAD_HORIZON.NOW && task.time && task.date === todayIso) {
      fixedToday.push(freezeEntry({ ...base, reasons: [`Klo ${task.time}`] }));
      continue;
    }
    if (where.horizon !== LOAD_HORIZON.NOW) {
      // Pisteet vain tämän viikon joukolle (se järjestetään kapasiteetin
      // mukaan); muut korit järjestetään päivän mukaan (compareStored).
      const followUp = where.followUpDue ? LOAD_SCORE.FOLLOW_UP_DUE : 0;
      const score = where.horizon === LOAD_HORIZON.THIS_WEEK
        ? scoreTask(task, { dateIso: task.date || todayIso, todayIso }).score + followUp : 0;
      buckets[where.horizon].push({ ...base, score });
      continue;
    }

    const scored = scoreTask(task, { dateIso: todayIso, todayIso });
    const reasons = [...base.reasons];
    let score = scored.score;
    for (const reason of scored.reasons) if (!reasons.includes(reason)) reasons.push(reason);
    if (where.pinned) score += LOAD_SCORE.PINNED;
    const weekly = refs.has(`task:${task.id}`) || (task.goalId && refs.has(`goal:${task.goalId}`))
      || (task.projectId && refs.has(`project:${task.projectId}`)) || (area && refs.has(`area:${area.id}`));
    if (weekly) {
      score += LOAD_SCORE.WEEKLY_PRIORITY;
      reasons.push('Viikon prioriteetti');
    }
    // Hyvinvointi, ilo ja vapaa-aika vain käyttäjän valinnasta (omistajan päätös 6).
    const optIn = OPT_IN_NATURES.has(nature);
    const chosen = where.pinned || weekly || task.priority === 'korkea';
    candidates.push({ ...base, reasons, score, eligible: !optIn || chosen });
  }

  // Laskut: avoimet, pian erääntyvät. Liitetty tehtävä edustaa laskua.
  for (const bill of listOf(bills)) {
    if (bill.status !== 'open' || !isIsoDate(bill.dueDate)) continue;
    if (bill.taskId) taskIdsLinkedToBills.add(String(bill.taskId));
  }
  const taskKeys = new Set([...candidates, ...Object.values(buckets).flat(), ...fixedToday].map(entry => entry.key));
  for (const bill of listOf(bills)) {
    if (bill.status !== 'open' || !isIsoDate(bill.dueDate)) continue;
    if (bill.taskId && taskKeys.has(`task:${bill.taskId}`)) continue;
    const urgency = billUrgencyScore(bill, todayIso);
    const entry = {
      key: `bill:${bill.id}`, kind: 'bill', id: bill.id, title: bill.name || 'Lasku', item: bill,
      nature: NATURE.OBLIGATION, areaId: null, date: bill.dueDate, deadline: bill.dueDate,
      minutes: BILL_DEFAULT_MINUTES, reasons: [urgency.reason || 'Lasku'], score: urgency.score, fits: true, pinned: false
    };
    if (urgency.score > 0) {
      candidates.push({ ...entry, horizon: LOAD_HORIZON.NOW, eligible: true });
    } else if (context.weekEndIso && bill.dueDate <= context.weekEndIso) {
      buckets[LOAD_HORIZON.THIS_WEEK].push({ ...entry, horizon: LOAD_HORIZON.THIS_WEEK });
    } else {
      buckets[LOAD_HORIZON.LATER].push({ ...entry, horizon: LOAD_HORIZON.LATER });
    }
  }

  // ------------------------------------------------ fokus kapasiteetin sisällä
  let dayRoom = capacity && Number.isFinite(capacity.todayRemainingMinutes)
    ? Math.max(0, capacity.todayRemainingMinutes) : null;
  const lowEnergy = energy && Number.isInteger(energy.level) && energy.level <= 2;
  if (dayRoom !== null && lowEnergy) dayRoom = Math.floor(dayRoom * 0.75);

  candidates.sort(compareEntries);
  const now = [];
  const overflow = new Set();
  let used = 0;
  for (const entry of candidates) {
    const fitsDay = dayRoom === null || used + entry.minutes <= dayRoom;
    if (entry.eligible && now.length < limit && fitsDay) {
      now.push({ ...entry, horizon: LOAD_HORIZON.NOW });
      used += entry.minutes;
      continue;
    }
    const reasons = [...entry.reasons];
    if (entry.eligible && now.length < limit && !fitsDay) {
      reasons.push('Ei mahdu tämän päivän aikaan');
      overflow.add(entry.key);
    } else if (!entry.eligible) {
      reasons.push('Valinnainen: nosta fokukseen, jos haluat');
    }
    buckets[LOAD_HORIZON.THIS_WEEK].push({ ...entry, horizon: LOAD_HORIZON.THIS_WEEK, reasons, fits: fitsDay });
  }

  // ------------------------------------------------ viikko kapasiteetin sisällä
  const weekRoom = capacity && Number.isFinite(capacity.weekRemainingMinutes)
    ? Math.max(0, capacity.weekRemainingMinutes) : null;
  buckets[LOAD_HORIZON.THIS_WEEK].sort(compareEntries);
  if (weekRoom !== null) {
    let weekUsed = used;
    buckets[LOAD_HORIZON.THIS_WEEK] = buckets[LOAD_HORIZON.THIS_WEEK].map(entry => {
      if (weekUsed + entry.minutes <= weekRoom) {
        weekUsed += entry.minutes;
        return entry;
      }
      overflow.add(entry.key);
      return { ...entry, fits: false, reasons: entry.reasons.includes('Ei mahdu tämän viikon aikaan')
        ? entry.reasons : [...entry.reasons, 'Ei mahdu tämän viikon aikaan'] };
    });
  }
  for (const key of [LOAD_HORIZON.LATER, LOAD_HORIZON.NOT_YET, LOAD_HORIZON.WAITING, LOAD_HORIZON.ARCHIVED]) {
    buckets[key].sort(compareStored);
  }

  const frozen = key => Object.freeze(buckets[key].map(freezeEntry));
  const thisWeek = frozen(LOAD_HORIZON.THIS_WEEK);
  const result = {
    todayIso,
    now: Object.freeze(now.map(freezeEntry)),
    thisWeek,
    later: frozen(LOAD_HORIZON.LATER),
    notYet: frozen(LOAD_HORIZON.NOT_YET),
    waiting: frozen(LOAD_HORIZON.WAITING),
    archived: frozen(LOAD_HORIZON.ARCHIVED),
    fixedToday: Object.freeze(fixedToday),
    overflow: Object.freeze(thisWeek.filter(entry => overflow.has(entry.key))),
    nowMinutes: used,
    dayRoomMinutes: dayRoom,
    weekRoomMinutes: weekRoom,
    lowEnergy: Boolean(lowEnergy)
  };
  result.counts = Object.freeze({
    now: result.now.length,
    thisWeek: result.thisWeek.length,
    later: result.later.length,
    notYet: result.notYet.length,
    waiting: result.waiting.length,
    archived: result.archived.length,
    fixedToday: result.fixedToday.length,
    overflow: result.overflow.length
  });
  // "Tallessa" = kaikki avoin, mikä ei ole tämän päivän fokus eikä aikajanan kiinteä.
  result.storedCount = result.thisWeek.length + result.later.length + result.notYet.length + result.waiting.length;
  result.activeCount = result.now.length + result.thisWeek.filter(entry => entry.fits).length;
  result.explanation = explainLoad(result);
  return Object.freeze(result);
}

function countText(count, one, many) {
  return `${count} ${count === 1 ? one : many}`;
}

/** Yksi rauhallinen lause kuormasta. Ei syyllistä, ei kiirehdi. */
export function explainLoad(load) {
  if (!load) return '';
  const parts = [];
  if (load.now.length === 0) {
    parts.push(load.dayRoomMinutes === 0
      ? 'Tänään ei ole tilaa joustavalle työlle, ja se on hyvä niin.'
      : 'Tänään ei ole mitään pakollista.');
  } else {
    parts.push(`${countText(load.now.length, 'asia', 'asiaa')} tänään.`);
  }
  const stored = [];
  if (load.thisWeek.length) stored.push(`${load.thisWeek.length} tällä viikolla`);
  if (load.later.length) stored.push(`${load.later.length} myöhemmin`);
  if (load.notYet.length) stored.push(`${load.notYet.length} ei vielä`);
  if (load.waiting.length) stored.push(`${load.waiting.length} odottaa`);
  if (stored.length) parts.push(`Tallessa: ${stored.join(', ')}.`);
  return parts.join(' ');
}

/** Rauhoittava lause Tänään-näkymään (omistajan psykologinen sääntö). */
export function storedMessage(storedCount) {
  const count = Number.isInteger(storedCount) && storedCount > 0 ? storedCount : 0;
  return {
    title: `Kaikki muu on tallessa (${count}).`,
    text: 'Sinun ei tarvitse hoitaa sitä tänään.'
  };
}

/** Kuuluuko tehtävä tämän päivän fokukseen tuloksen mukaan? */
export function isInNow(load, taskId) {
  return Boolean(load && load.now.some(entry => entry.kind === 'task' && entry.id === taskId));
}

/**
 * Ylittyikö päivä tai määräaika ilman että asia on fokuksessa? Tänään-näkymä
 * kertoo nämä yhtenä rauhallisena rivinä, ei punaisena listana.
 */
export function slippedItems(load) {
  if (!load) return EMPTY;
  return Object.freeze(load.thisWeek.filter(entry => entry.kind === 'task'
    && isOverdue(entry.item, load.todayIso)));
}

/** Kuinka kiireellinen määräaika on (näyttöä varten, sama sanasto kuin focus.js). */
export function urgencyOfEntry(entry, todayIso) {
  if (!entry || entry.kind !== 'task') return null;
  const urgency = deadlineUrgency(entry.item, todayIso);
  return urgency === URGENCY.NONE ? null : urgency;
}
