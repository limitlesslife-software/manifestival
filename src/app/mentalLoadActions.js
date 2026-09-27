// Mielen kuorman tallennustoiminnot (migraatio 0015, aalto L).
//
// SAMA KAAVA KUIN src/app/dailyLifeActions.js:SSÄ: normalisoi -> tarkista
// -> tila heti -> kanta -> epäonnistuessa tila takaisin ja ymmärrettävä
// virhe. Kirjoitukset kulkevat samaa polkua (persistTrackedWrite), joten
// kesken tallennuksen valmistunut lataus ei pyyhi niitä.
//
// Tehtävän horisontti, odotus ja arkistointi ovat tehtävän kenttiä
// (tasks, sarakeportti MENTAL_LOAD_FIELDS) ja kulkevat editTaskin kautta:
// sama validointi, sama offline-jono, sama siirtojen seuranta.
//
// TEKOÄLY EI KUTSU NÄITÄ ILMAN KÄYTTÄJÄN HYVÄKSYNTÄÄ.

import { protectedPeriodsRepo, weeklyPlansRepo } from '../data/collectionsRepo.js';
import { sessionSnapshot } from '../data/session.js';
import { datelessTasksAllowed } from '../data/schema.js';
import { newTaskId } from '../lib/rows.js';
import {
  getState, findTask, upsertProtectedPeriodInState, removeProtectedPeriodFromState,
  upsertWeeklyPlanInState, removeWeeklyPlanFromState
} from './state.js';
import { editTask } from './actions.js';
import { persistTrackedWrite, warnIfVolatileRepo } from './dailyLifeActions.js';
import {
  normalizeProtectedPeriod, validateProtectedPeriod, reconcileFreeTimeRules, PROTECTED_KIND, PERIOD_RECURRENCE
} from '../domain/protectedTime.js';
import {
  normalizeWeeklyPlan, validateWeeklyPlan, weeklyPlanFor, WEEKLY_PRIORITY_LIMIT
} from '../domain/weeklyPlan.js';
import { TASK_HORIZON, isIsoDate } from '../domain/task.js';
import { weekStartOf } from '../domain/weeklyCapacity.js';
import { confirmAction } from '../ui/confirm.js';

function findPeriod(id) {
  return getState().protectedPeriods.find(period => period.id === id) || null;
}

// ------------------------------------------------------ suojattu aika

/**
 * Tallenna suojattu jakso (oma aika, vapaa-ajan sääntö tai loma).
 * @returns {Promise<{ok:boolean, period?:object, errors?:object}>}
 */
export async function saveProtectedPeriod(input = {}) {
  const existing = input.id ? findPeriod(input.id) : null;
  const period = normalizeProtectedPeriod({ ...(existing || {}), ...input, id: existing ? existing.id : newTaskId() });
  const { valid, errors } = validateProtectedPeriod(period);
  if (!valid) return { ok: false, errors };

  const startedIn = sessionSnapshot();
  upsertProtectedPeriodInState(period);
  warnIfVolatileRepo(protectedPeriodsRepo, 'Suojatut ajat');
  const result = await persistTrackedWrite(
    () => (existing ? protectedPeriodsRepo.update(period) : protectedPeriodsRepo.insert(period)),
    () => (existing ? upsertProtectedPeriodInState(existing) : removeProtectedPeriodFromState(period.id)),
    startedIn, { key: `protectedPeriods:${period.id}`, reapply: () => upsertProtectedPeriodInState(period) });
  return result.ok ? { ok: true, period } : result;
}

/** Poista suojattu jakso. Kysyy vahvistuksen, ellei kutsuja ole jo kysynyt. */
export async function deleteProtectedPeriod(id, { confirmed = false } = {}) {
  const previous = findPeriod(id);
  if (!previous) return { ok: false };
  if (!confirmed) {
    const accepted = await confirmAction({
      title: 'Poistetaanko suojattu aika?',
      message: 'Aika vapautuu taas suunnittelulle. Kiinteät menot eivät muutu.',
      confirmLabel: 'Poista'
    });
    if (!accepted) return { ok: false, cancelled: true };
  }
  const startedIn = sessionSnapshot();
  removeProtectedPeriodFromState(id);
  return persistTrackedWrite(() => protectedPeriodsRepo.remove(id), () => upsertProtectedPeriodInState(previous),
    startedIn, { key: `protectedPeriods:${id}`, reapply: () => removeProtectedPeriodFromState(id) });
}

/**
 * Vapaa-ajan säännöt yhdellä tallennuksella: vähimmäistunnit viikossa,
 * suojatut illat, sunnuntai pääosin vapaa, ei velvoitteita klo X jälkeen.
 * Kaikki ovat protected_periods-rivejä (omistajan päätös 4).
 *
 * @param {{minimumMinutes?:number|null, eveningWeekdays?:number[], eveningFrom?:string|null,
 *   sundayMostlyFree?:boolean, cutoffTime?:string|null}} rules
 */
export async function saveFreeTimeRules(rules = {}) {
  const plan = reconcileFreeTimeRules(getState().protectedPeriods, rules);
  const failures = [];
  for (const period of plan.remove) {
    const result = await deleteProtectedPeriod(period.id, { confirmed: true });
    if (!result.ok) failures.push(result);
  }
  for (const period of [...plan.update, ...plan.create]) {
    const result = await saveProtectedPeriod(period);
    if (!result.ok) failures.push(result);
  }
  return failures.length === 0
    ? { ok: true, created: plan.create.length, updated: plan.update.length, removed: plan.remove.length }
    : { ok: false, errors: failures.find(f => f.errors)?.errors || null };
}

/** Loma päivävälille. Kiinteät menot pysyvät; joustavaa työtä ei sijoiteta. */
export function saveVacation({ id = null, startDate, endDate, title = null } = {}) {
  return saveProtectedPeriod({
    id, kind: PROTECTED_KIND.VACATION, recurrence: PERIOD_RECURRENCE.ONCE,
    startDate, endDate: endDate || startDate, title: title || 'Loma'
  });
}

// ------------------------------------------------------ viikkosuunnitelma

/**
 * Tallenna viikon suunnitelma (yksi rivi viikkoa kohti).
 * `limit` rajaa prioriteetit (oletus 3, omistajan päätös).
 */
export async function saveWeeklyPlan(input = {}, { limit = WEEKLY_PRIORITY_LIMIT } = {}) {
  const weekStart = weekStartOf(input.weekStart);
  const existing = weeklyPlanFor(getState().weeklyPlans, weekStart);
  const plan = normalizeWeeklyPlan({ ...(existing || {}), ...input, weekStart, id: existing ? existing.id : newTaskId() });
  const { valid, errors } = validateWeeklyPlan(plan, { limit });
  if (!valid) return { ok: false, errors };

  const startedIn = sessionSnapshot();
  upsertWeeklyPlanInState(plan);
  warnIfVolatileRepo(weeklyPlansRepo, 'Viikkosuunnitelmat');
  const result = await persistTrackedWrite(
    () => (existing ? weeklyPlansRepo.update(plan) : weeklyPlansRepo.insert(plan)),
    () => (existing ? upsertWeeklyPlanInState(existing) : removeWeeklyPlanFromState(plan.id)),
    startedIn, { key: `weeklyPlans:${plan.weekStart}`, reapply: () => upsertWeeklyPlanInState(plan) });
  return result.ok ? { ok: true, plan } : result;
}

/** Sulje viikko: suunnitelma on valmis. `plannedMinutes` = suunnitelman kesto sulkemishetkellä. */
export function closeWeek(weekStart, { priorities, plannedMinutes = null, now = new Date() } = {}) {
  const input = { weekStart, closedAt: now.toISOString(), plannedMinutes };
  if (Array.isArray(priorities)) input.priorities = priorities;
  return saveWeeklyPlan(input);
}

// ------------------------------------------------------ horisontti

function allowedHorizon(horizon) {
  return horizon === null || Object.values(TASK_HORIZON).includes(horizon);
}

/**
 * Siirrä tehtävä horisonttiin. Päivätön vain kun kanta tukee sitä (0015);
 * muuten "myöhemmin" pitää päivän ja kertoo sen.
 *
 *   NOW        päiväksi tämä päivä ja fokukseen
 *   THIS_WEEK  tällä viikolla (päivä poistetaan, jos sallittu)
 *   LATER      myöhemmin, ilman keksittyä päivää
 *   NOT_YET    ei vielä
 *   null       palauta johdettuun (päivän mukaan)
 */
export async function setTaskHorizon(id, horizon, { todayIso = null } = {}) {
  const task = findTask(id);
  if (!task || !allowedHorizon(horizon)) return { ok: false };
  if (horizon === TASK_HORIZON.WAITING) return markWaiting(id, { waitingOn: task.waitingOn });
  const changes = { horizon, waitingOn: null, followUpDate: null };
  if (horizon === TASK_HORIZON.NOW) {
    if (isIsoDate(todayIso)) changes.date = todayIso;
  } else if (horizon && datelessTasksAllowed() && !task.time) {
    changes.date = null;
  }
  return editTask(id, changes);
}

/** Odottaa toista ihmistä tai tahoa. Ei kuluta kapasiteettia. */
export function markWaiting(id, { waitingOn = null, followUpDate = null } = {}) {
  const task = findTask(id);
  if (!task) return Promise.resolve({ ok: false });
  const changes = {
    horizon: TASK_HORIZON.WAITING,
    waitingOn: waitingOn == null ? null : String(waitingOn),
    followUpDate: isIsoDate(followUpDate) ? followUpDate : null
  };
  if (datelessTasksAllowed() && !task.time) changes.date = null;
  return editTask(id, changes);
}

/** Poista näkyvistä (arkisto). Ei poista tietoa; palautettavissa. */
export function archiveTask(id, { now = new Date() } = {}) {
  return editTask(id, { archivedAt: now.toISOString() });
}

export function restoreTask(id) {
  return editTask(id, { archivedAt: null });
}
