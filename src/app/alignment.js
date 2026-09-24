// Suunta: sovelluskerroksen toiminnot.
//
// Domain (src/domain/alignment.js, alignmentReview.js) laskee ja kuvaa.
// Tämä moduuli tekee sivuvaikutukset: lukee kellon, luo tunnisteet,
// kirjoittaa repositorioihin ja pyytää vahvistuksen.
//
// KAKSI SÄÄNTÖÄ:
//
//   1. Havaintoja ei tallenneta. analyzeCurrentWeek() laskee ne aina
//      tilan lähdefaktoista. Ainoa tallennettu johdos on viikkokatsauksen
//      tilannekuva, ja se on tarkoituksella historiaa.
//
//   2. Mikään muutosehdotus ei muuta mitään ilman vahvistusta.
//      applyAdjustment() näyttää vahvistusdialogin ja kirjoittaa vasta
//      hyväksynnän jälkeen. Sama ehdotus ei voi toteutua kahdesti.

import {
  getState, addLifeAreaToState, replaceLifeAreaInState, removeLifeAreaFromState,
  restoreLifeAreaInState,
  findLifeArea, upsertWeeklyCapacityInState, removeWeeklyCapacityFromState,
  addTimeEntryToState, removeTimeEntryFromState, upsertAlignmentReviewInState,
  findGoal, findTask
} from './state.js';
import {
  lifeAreasRepo, weeklyCapacitiesRepo, timeEntriesRepo, alignmentReviewsRepo
} from '../data/collectionsRepo.js';
import { newTaskId } from '../lib/rows.js';
import { fmtISO, todayMidnight } from '../lib/datetime.js';
import { logEvent } from '../lib/logger.js';
import { showError, notify } from '../ui/toast.js';
import { confirmAction } from '../ui/confirm.js';
import { normalizeLifeArea, validateLifeArea } from '../domain/lifeArea.js';
import {
  normalizeWeeklyCapacity, validateWeeklyCapacity, capacityForWeek, weekStartOf, nextWeekStart
} from '../domain/weeklyCapacity.js';
import { normalizeTimeEntry, validateTimeEntry } from '../domain/timeEntry.js';
import { analyzeWeek } from '../domain/alignment.js';
import { addDaysIso } from '../domain/fiTemporal.js';
import {
  buildReviewSnapshot, normalizeAlignmentReview, validateAlignmentReview,
  proposeAdjustments, planningFeedback, ADJUSTMENT, SNAPSHOT_VERSION
} from '../domain/alignmentReview.js';
import { editGoal, setGoalStatus, createTask, editTask } from './actions.js';

/** Suunnan muutokset eivät mene offline-jonoon: ne vaativat vahvistuksen ja verkon. */
const NO_QUEUE = Object.freeze({ queueOffline: false });

// ---------------------------------------------------------------- aika

/** Tämä päivä ja minuutit keskiyöstä. Ainoa paikka, jossa Suunta lukee kellon. */
export function clockNow(now = new Date()) {
  return { todayIso: fmtISO(now), nowMinutes: now.getHours() * 60 + now.getMinutes() };
}

export function currentWeekStart(now = new Date()) {
  return weekStartOf(fmtISO(now));
}

// ---------------------------------------------------------- analyysi

/**
 * Viikon analyysi tilan lähdefaktoista. Ei tallenna mitään.
 *
 * @param {string} [weekStart] mikä tahansa viikon päivä (oletus: tämä viikko)
 * @param {{todayIso?: string, nowMinutes?: number}} [clock]
 */
export function analyzeCurrentWeek(weekStart = null, clock = clockNow()) {
  const state = getState();
  const monday = weekStartOf(weekStart || clock.todayIso || fmtISO(todayMidnight()));
  return analyzeWeek({
    weekStart: monday,
    todayIso: clock.todayIso,
    nowMinutes: clock.nowMinutes,
    areas: state.lifeAreas,
    goals: state.goals,
    projects: state.projects,
    tasks: state.tasks,
    routines: state.routines,
    exceptions: state.routineExceptions,
    timeEntries: state.timeEntries,
    capacity: capacityForWeek(state.weeklyCapacities, monday)
  });
}

/** Seuraavan viikon muutosehdotukset tämän viikon analyysista. */
export function currentProposals(analysis, clock = clockNow()) {
  const state = getState();
  const next = nextWeekStart(analysis.weekStart);
  const nextAnalysis = analyzeCurrentWeek(next, clock);
  return proposeAdjustments(analysis, {
    areas: state.lifeAreas,
    goals: state.goals,
    tasks: state.tasks,
    nextWeekAnalysis: nextAnalysis,
    nextCapacity: capacityForWeek(state.weeklyCapacities, next)
  });
}

/**
 * Palaute Tavoitteesta tekemiseksi -moottorille: suunnittelu ei saa olettaa
 * enempää viikkoaikaa kuin käyttäjä on itse sanonut ehtivänsä.
 */
export function currentPlanningFeedback(clock = clockNow()) {
  const state = getState();
  const analysis = analyzeCurrentWeek(null, clock);
  return planningFeedback(analysis, {
    nextCapacity: capacityForWeek(state.weeklyCapacities, nextWeekStart(analysis.weekStart))
  });
}

/** Säilyykö Suunnan tieto tallennuksen yli (migraatio 0012 + portit)? */
export function alignmentPersistence() {
  return {
    lifeAreas: lifeAreasRepo.isPersistent(),
    weeklyCapacities: weeklyCapacitiesRepo.isPersistent(),
    timeEntries: timeEntriesRepo.isPersistent(),
    alignmentReviews: alignmentReviewsRepo.isPersistent()
  };
}

// ------------------------------------------------------ elämänalueet

export async function createLifeArea(input) {
  const state = getState();
  const nextOrder = state.lifeAreas.reduce((max, area) => Math.max(max, area.sortOrder + 1), 0);
  const area = normalizeLifeArea({ sortOrder: nextOrder, ...input, id: newTaskId() });
  const { valid, errors } = validateLifeArea(area, state.lifeAreas);
  if (!valid) return { ok: false, errors };

  addLifeAreaToState(area);
  const result = await lifeAreasRepo.insert(area);
  if (!result.ok) {
    removeLifeAreaFromState(area.id);
    showError(result.error);
    return { ok: false };
  }
  logEvent('alignment.area_created', { importance: area.importance, hasTarget: area.targetMinutesPerWeek !== null });
  return { ok: true, area };
}

export async function editLifeArea(id, changes) {
  const previous = findLifeArea(id);
  if (!previous) return { ok: false };
  const updated = normalizeLifeArea({ ...previous, ...changes, id });
  const { valid, errors } = validateLifeArea(updated, getState().lifeAreas);
  if (!valid) return { ok: false, errors };

  replaceLifeAreaInState(id, updated);
  const result = await lifeAreasRepo.update(updated);
  if (!result.ok) {
    replaceLifeAreaInState(id, previous);
    showError(result.error);
    return { ok: false };
  }
  return { ok: true, area: updated };
}

/**
 * Poista alue vahvistuksen jälkeen. Tavoitteet ja kirjattu aika säilyvät;
 * vain niiden aluekytkentä poistuu.
 */
export async function deleteLifeArea(id, { confirmFn = confirmAction } = {}) {
  const area = findLifeArea(id);
  if (!area) return false;
  const state = getState();
  const goals = state.goals.filter(goal => goal.lifeAreaId === id).length;
  const accepted = await confirmFn({
    title: `Poistetaanko alue ${area.name}?`,
    message: goals > 0
      ? `${goals} tavoitetta jää ilman elämänaluetta. Tavoitteet, tehtävät ja kirjattu aika säilyvät.`
      : 'Tavoitteet, tehtävät ja kirjattu aika säilyvät.',
    confirmLabel: 'Poista alue',
    destructive: true
  });
  if (!accepted) return false;

  const goalIds = state.goals.filter(goal => goal.lifeAreaId === id).map(goal => goal.id);
  const entryIds = state.timeEntries.filter(entry => entry.lifeAreaId === id).map(entry => entry.id);
  removeLifeAreaFromState(id);
  const result = await lifeAreasRepo.remove(id);
  if (!result.ok) {
    // Kanta ei muuttunut: alue ja kytkennät takaisin tilaan.
    restoreLifeAreaInState(area, goalIds, entryIds);
    showError(result.error);
    return false;
  }
  logEvent('alignment.area_deleted', { goals: goalIds.length, entries: entryIds.length });
  return true;
}

/** Liitä tavoite alueeseen tai irrota (areaId = null). */
export async function assignGoalToLifeArea(goalId, areaId) {
  const goal = findGoal(goalId);
  if (!goal) return { ok: false };
  if (areaId && !findLifeArea(areaId)) return { ok: false, errors: { lifeAreaId: 'Aluetta ei löytynyt.' } };
  const result = await editGoal(goalId, { lifeAreaId: areaId || null });
  if (result.ok) logEvent('alignment.goal_assigned', { assigned: Boolean(areaId) });
  return result;
}

// ------------------------------------------------------ kapasiteetti

/** Aseta viikon kapasiteetti. Yksi rivi viikkoa kohti (päivitys, jos on jo). */
export async function saveWeeklyCapacity(input) {
  const state = getState();
  const existing = capacityForWeek(state.weeklyCapacities, input.weekStart);
  const capacity = normalizeWeeklyCapacity({
    ...(existing || {}), ...input, id: existing ? existing.id : newTaskId()
  });
  const { valid, errors } = validateWeeklyCapacity(capacity);
  if (!valid) return { ok: false, errors };

  upsertWeeklyCapacityInState(capacity);
  const result = existing
    ? await weeklyCapacitiesRepo.update(capacity)
    : await weeklyCapacitiesRepo.insert(capacity);
  if (!result.ok) {
    if (existing) upsertWeeklyCapacityInState(existing);
    else removeWeeklyCapacityFromState(capacity.id);
    showError(result.error);
    return { ok: false };
  }
  logEvent('alignment.capacity_saved', { minutes: capacity.availableMinutes, energy: capacity.energyLevel });
  return { ok: true, capacity };
}

// ------------------------------------------------------------ toteuma

export async function logTime(input) {
  const entry = normalizeTimeEntry({ ...input, id: newTaskId() });
  const { valid, errors } = validateTimeEntry(entry);
  if (!valid) return { ok: false, errors };
  if (entry.lifeAreaId && !findLifeArea(entry.lifeAreaId)) entry.lifeAreaId = null;
  if (entry.taskId && !findTask(entry.taskId)) entry.taskId = null;
  if (entry.goalId && !findGoal(entry.goalId)) entry.goalId = null;

  addTimeEntryToState(entry);
  const result = await timeEntriesRepo.insert(entry);
  if (!result.ok) {
    removeTimeEntryFromState(entry.id);
    showError(result.error);
    return { ok: false };
  }
  logEvent('alignment.time_logged', { minutes: entry.minutes, linked: Boolean(entry.lifeAreaId || entry.taskId || entry.goalId) });
  return { ok: true, entry };
}

export async function deleteTimeEntry(id) {
  const entry = getState().timeEntries.find(e => e.id === id);
  if (!entry) return false;
  removeTimeEntryFromState(id);
  const result = await timeEntriesRepo.remove(id);
  if (!result.ok) {
    addTimeEntryToState(entry);
    showError(result.error);
    return false;
  }
  return true;
}

// ------------------------------------------------------- katsaus

/**
 * Tallenna viikkokatsaus: tilannekuva siitä mitä käyttäjä näki, hänen
 * oma pohdintansa ja vahvistetut muutokset.
 */
export async function saveWeeklyReview({ weekStart, reflection = null, adjustments = [] } = {}, clock = clockNow()) {
  const analysis = analyzeCurrentWeek(weekStart, clock);
  const state = getState();
  const existing = state.alignmentReviews.find(review => review.weekStart === analysis.weekStart) || null;
  const review = normalizeAlignmentReview({
    ...(existing || {}),
    id: existing ? existing.id : newTaskId(),
    weekStart: analysis.weekStart,
    snapshotVersion: SNAPSHOT_VERSION,
    snapshot: buildReviewSnapshot(analysis),
    reflection,
    adjustments: [...new Set([...(existing ? existing.adjustments : []), ...adjustments])],
    completedAt: new Date().toISOString()
  });
  const { valid, errors } = validateAlignmentReview(review);
  if (!valid) return { ok: false, errors };

  upsertAlignmentReviewInState(review);
  const result = existing ? await alignmentReviewsRepo.update(review) : await alignmentReviewsRepo.insert(review);
  if (!result.ok) {
    if (existing) upsertAlignmentReviewInState(existing);
    showError(result.error);
    return { ok: false };
  }
  logEvent('alignment.review_saved', {
    signals: analysis.signals.length, adjustments: review.adjustments.length,
    quality: analysis.dataQuality.level
  });
  return { ok: true, review };
}

// ------------------------------------------------------- muutokset

/** Tällä istunnolla jo toteutetut ehdotukset: sama ehdotus ei toteudu kahdesti. */
const applied = new Set();

export function resetAppliedAdjustments() {
  applied.clear();
}

function describe(proposal) {
  return proposal.detail ? `${proposal.label}\n\n${proposal.detail}` : proposal.label;
}

/**
 * Toteuta yksi muutosehdotus VAHVISTUKSEN JÄLKEEN.
 *
 * @param {object} proposal proposeAdjustments()-tuloksen alkio
 * @param {object} [options]
 * @param {Function} [options.confirmFn] vahvistusdialogi (testeissä korvattava)
 * @param {object} [options.overrides] käyttäjän muokkaama arvo (esim. tavoiteminuutit)
 * @returns {Promise<{ok: boolean, applied?: boolean, cancelled?: boolean, duplicate?: boolean}>}
 */
export async function applyAdjustment(proposal, { confirmFn = confirmAction, overrides = {} } = {}) {
  if (!proposal || !Object.values(ADJUSTMENT).includes(proposal.type)) return { ok: false };
  if (applied.has(proposal.id)) return { ok: true, applied: false, duplicate: true };

  const payload = { ...proposal.payload, ...overrides };
  const accepted = await confirmFn({
    title: 'Tehdäänkö muutos?',
    message: describe(proposal),
    confirmLabel: 'Tee muutos'
  });
  if (!accepted) {
    logEvent('alignment.adjustment', { type: proposal.type, accepted: false });
    return { ok: true, applied: false, cancelled: true };
  }
  applied.add(proposal.id);

  let result = { ok: false };
  switch (proposal.type) {
    case ADJUSTMENT.SET_CAPACITY:
      result = await saveWeeklyCapacity({
        weekStart: payload.weekStart, availableMinutes: payload.availableMinutes
      });
      break;
    case ADJUSTMENT.POSTPONE_TASKS: {
      let all = true;
      const days = Number.isInteger(payload.days) ? payload.days : 7;
      for (const taskId of payload.taskIds || []) {
        const current = findTask(taskId);
        // Kadonnut tai jo valmis tehtävä ohitetaan: ehdotus on voinut vanhentua.
        if (!current || current.completed || !current.date) continue;
        const one = await editTask(taskId, { date: addDaysIso(current.date, days) }, NO_QUEUE);
        all = all && one.ok;
      }
      result = { ok: all };
      break;
    }
    case ADJUSTMENT.CREATE_TASK:
      result = await createTask({
        title: payload.title, date: payload.date, durationMinutes: payload.durationMinutes,
        goalId: payload.goalId, category: payload.category || undefined
      }, NO_QUEUE);
      break;
    case ADJUSTMENT.CHANGE_TARGET:
      result = await editLifeArea(payload.areaId, { targetMinutesPerWeek: payload.to });
      break;
    case ADJUSTMENT.PAUSE_GOAL:
      result = await setGoalStatus(payload.goalId, 'paused');
      break;
    default:
      result = { ok: false };
  }

  if (!result.ok) applied.delete(proposal.id);
  logEvent('alignment.adjustment', { type: proposal.type, accepted: true, ok: Boolean(result.ok) });
  if (result.ok) notify('Muutos tehty.', 3000);
  return { ok: Boolean(result.ok), applied: Boolean(result.ok) };
}
