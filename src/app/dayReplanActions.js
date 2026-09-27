// Päivän uudelleensuunnittelu keskeytyksestä: esikatselu ja toteutus.
//
// YKSI POLKU. Tänään-näkymän keskeytyskortti (views/todayDailyLife.js) ja
// komentopalkin paikallinen puhe- ja tekstikomento (localCommands.js)
// käyttävät tätä samaa esikatselua ja samaa toteutusta. Kahdella polulla
// sama "olen 15 min myöhässä" voisi siirtää päivää eri tavalla.
//
// Päivä lasketaan calendarPlan.calendarDayPlan-funktiolla (menot ja
// suojatut lohkot mukana), joten kiinteät menot, matkat ja suojattu lepo
// eivät koskaan näy vapaana aikana eivätkä siirry.
//
// Toteutus käyttää vain olemassa olevia toimintoja (editTask,
// skipRoutineOccurrence) ja perii kaiken, jos yksikin muutos epäonnistuu:
// puoliksi siirretty päivä olisi pahempi kuin siirtämätön.

import { getState, findTask } from './state.js';
import { editTask, skipRoutineOccurrence, restoreRoutineOccurrence } from './actions.js';
import { calendarDayPlan, calendarInputs } from './calendarPlan.js';
import { clockOf, shiftIso } from './dailyLifeModel.js';
import { deviceOffsetMinutes } from './deviceTime.js';
import { buildDayPlan } from '../domain/scheduler.js';
import { dayCapacity } from '../domain/capacity.js';
import { replanDay, REPLAN_CHANGE } from '../domain/dayReplan.js';
import { INTERRUPTION_KIND } from '../domain/interruptions.js';
import { DEFAULT_HORIZON_DAYS } from '../domain/errands.js';
import { toMinutes } from '../domain/task.js';

const EMPTY = Object.freeze([]);
const MAX_HORIZON_DAYS = 40;

function datesBetween(fromIso, toIso) {
  const dates = [];
  for (let date = fromIso; date && date <= toIso && dates.length < MAX_HORIZON_DAYS; date = shiftIso(date, 1)) dates.push(date);
  return dates;
}

/**
 * Tulevien päivien vapaat välit ja käytettävissä oleva aika (kalenteri ja
 * suojattu lepo mukana). Loppujen siirto ja avoimen asian aikaehdotus
 * käyttävät tätä.
 *
 * @returns {{days: Array<{date, freeSlots, usableMinutes}>, calendar: {events, blocks}}}
 */
export function horizonDays(fromIso, toIso, { state = getState(), now = new Date() } = {}) {
  const clockNow = clockOf(now);
  const inputs = calendarInputs(state, {
    from: fromIso, to: toIso, todayIso: clockNow.todayIso, nowMinutes: clockNow.nowMinutes,
    offsetMinutesFn: deviceOffsetMinutes
  });
  const calendar = { events: inputs.occurrences, blocks: inputs.blocks };
  const days = datesBetween(fromIso, toIso).map(date => {
    const common = {
      tasks: state.tasks, profile: state.profile, dateIso: date,
      routines: state.routines, exceptions: state.routineExceptions,
      events: calendar.events, blocks: calendar.blocks
    };
    const plan = buildDayPlan({
      ...common, todayIso: clockNow.todayIso, nowMinutes: date === clockNow.todayIso ? clockNow.nowMinutes : null
    });
    const capacity = dayCapacity(common);
    return { date, freeSlots: plan.freeSlots, usableMinutes: capacity.usableMinutes };
  });
  return { days, calendar };
}

/**
 * Keskeytyksen ehdotus tästä päivästä. Ei muuta mitään.
 *
 * @param {{kind:string, minutes?:number|null, targetText?:string|null, toDate?:string|null, onDate?:string|null}} interruption
 */
export function previewDayReplan(interruption, { state = getState(), now = new Date() } = {}) {
  const { todayIso, nowMinutes } = clockOf(now);
  const { plan, inputs } = calendarDayPlan(state, todayIso, { todayIso, nowMinutes, offsetMinutesFn: deviceOffsetMinutes });
  const days = interruption && interruption.kind === INTERRUPTION_KIND.DEFER_REMAINING
    ? horizonDays(shiftIso(todayIso, 1), shiftIso(todayIso, DEFAULT_HORIZON_DAYS), { state, now }).days
    : [];
  return replanDay({
    plan,
    interruption,
    nowMinutes,
    todayIso,
    tasks: state.tasks || EMPTY,
    events: plan.eventItems,
    blocks: plan.blocks,
    days,
    // Lähtömoottorin suunnitelmat samasta calendarInputs-laskennasta kuin
    // lohkot: "olen 15 min myöhässä" kertoo myöhästyvän lähdön ja
    // perilläolon (dayReplan.js "lähtö ja kiinteät alut").
    departures: inputs && inputs.departures instanceof Map ? [...inputs.departures.values()] : [],
    offsetMinutesFn: deviceOffsetMinutes
  });
}

/**
 * Muutokset, jotka voidaan tehdä olemassa olevilla toiminnoilla, ja pelkät
 * tiedot. Aikatauluttamaton tehtävä sijoittuu päivään itsestään: siirto ei
 * kirjoita sille kellonaikaa (se tekisi joustavasta kiinteän).
 */
export function splitReplanChanges(changes, state = getState()) {
  const tasks = new Map((state.tasks || EMPTY).map(task => [task.id, task]));
  const applicable = [];
  const informational = [];
  for (const change of Array.isArray(changes) ? changes : EMPTY) {
    const task = change.taskId ? tasks.get(change.taskId) : null;
    if (task) {
      if (change.kind === REPLAN_CHANGE.SHIFT && !task.time) informational.push(change);
      else applicable.push(change);
    } else if (change.kind === REPLAN_CHANGE.SKIP && change.routineId && change.from && change.from.date) {
      applicable.push(change);
    } else {
      informational.push(change);
    }
  }
  return { applicable, informational };
}

/** Tehtävän muutos olemassa olevan editTaskin kentiksi. Kiinteitä menoja tämä ei koskaan saa. */
export function taskPatch(change, task) {
  switch (change.kind) {
    case REPLAN_CHANGE.SHIFT: {
      // Siirto pitää tehtävän joustavana: seuraava keskeytys saa siirtää sitä taas.
      const patch = { time: change.to.time, schedulingState: task.schedulingState };
      // Päivätön tehtävä ei saa päivää siirrosta; päivällinen siirtyy ehdotuksen päivälle.
      if (task.date && change.to.date && change.to.date !== task.date) patch.date = change.to.date;
      // Kestolla ajastettu tehtävä pysyy kestollisena; loppuaika vain sille, jolla se on.
      if (task.endTime || !task.durationMinutes) patch.endTime = change.to.endTime;
      return patch;
    }
    case REPLAN_CHANGE.EXTEND: {
      if (task.endTime || !task.durationMinutes) return { endTime: change.to.endTime };
      const from = toMinutes(change.to.time);
      const to = toMinutes(change.to.endTime);
      const minutes = from !== null && to !== null ? ((to - from + 1440) % 1440) || null : null;
      return minutes ? { durationMinutes: minutes } : null;
    }
    case REPLAN_CHANGE.SKIP:
      return { time: null, endTime: null };
    case REPLAN_CHANGE.DEFER:
      return task.time ? { date: change.to.date, time: null, endTime: null } : { date: change.to.date };
    default:
      return null;
  }
}

/** Onko päivä muuttunut ehdotuksen jälkeen (tehtävä poistettu tai siirretty muualta)? */
export function isStaleChange(change, state = getState()) {
  if (!change.taskId) return false;
  const task = (state.tasks || EMPTY).find(entry => entry.id === change.taskId);
  if (!task) return true;
  return (task.date || null) !== (change.from ? change.from.date : null)
    || (task.time || null) !== (change.from ? change.from.time : null);
}

async function applyOne(change) {
  if (change.taskId) {
    const task = findTask(change.taskId);
    const patch = task ? taskPatch(change, task) : null;
    if (!patch) return { ok: false };
    const previous = {
      date: task.date, time: task.time, endTime: task.endTime,
      durationMinutes: task.durationMinutes, schedulingState: task.schedulingState
    };
    const result = await editTask(change.taskId, patch);
    return result && result.ok ? { ok: true, undo: () => editTask(change.taskId, previous) } : { ok: false };
  }
  if (change.kind === REPLAN_CHANGE.SKIP && change.routineId && change.from && change.from.date) {
    const ok = await skipRoutineOccurrence(change.routineId, change.from.date);
    return ok ? { ok: true, undo: () => restoreRoutineOccurrence(change.routineId, change.from.date) } : { ok: false };
  }
  return { ok: false };
}

/**
 * Tee muutokset järjestyksessä. Jos yksikin epäonnistuu, jo tehdyt
 * perutaan: puoliksi siirretty päivä olisi pahempi kuin siirtämätön.
 */
export async function applyReplanChanges(changes) {
  const done = [];
  for (const change of changes) {
    const step = await applyOne(change);
    if (!step.ok) {
      for (const entry of done.reverse()) await entry.undo();
      return { ok: false, applied: 0 };
    }
    done.push(step);
  }
  return { ok: true, applied: done.length };
}
