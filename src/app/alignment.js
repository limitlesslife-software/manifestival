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
  findGoal, findTask, findProject, findRoutine
} from './state.js';
import {
  lifeAreasRepo, weeklyCapacitiesRepo, timeEntriesRepo, alignmentReviewsRepo
} from '../data/collectionsRepo.js';
import { getUser, sessionSnapshot, isSameSession } from '../data/session.js';
import { loadOutbox, saveOutbox, MAX_OUTBOX_ENTRIES } from '../data/timerStore.js';
import { createTimeEntryWriter } from './timeEntryWriter.js';
import { newTaskId } from '../lib/rows.js';
import { fmtISO, todayMidnight } from '../lib/datetime.js';
import { logEvent } from '../lib/logger.js';
import { showError, notify } from '../ui/toast.js';
import { confirmAction } from '../ui/confirm.js';
import { normalizeLifeArea, validateLifeArea, formatMinutes } from '../domain/lifeArea.js';
import {
  normalizeWeeklyCapacity, validateWeeklyCapacity, capacityForWeek, weekStartOf, nextWeekStart
} from '../domain/weeklyCapacity.js';
import { normalizeTimeEntry, validateTimeEntry, entriesForOperation } from '../domain/timeEntry.js';
import { analyzeWeek } from '../domain/alignment.js';
import { addDaysIso } from '../domain/fiTemporal.js';
import {
  buildReviewSnapshot, normalizeAlignmentReview, validateAlignmentReview,
  proposeAdjustments, planningFeedback, explainSignal, ADJUSTMENT, SNAPSHOT_VERSION,
  NON_WRITING_ADJUSTMENTS
} from '../domain/alignmentReview.js';
import { editGoal, setGoalStatus, createTask, editTask } from './actions.js';
import { currentAccessToken } from './auth.js';
import { previewAdjustments } from '../domain/rebalance.js';
import { buildPlanningConstraints, validatePlanAlignment } from '../domain/planAlignment.js';
import { dailyObservations } from '../domain/dailyAlignment.js';
import { weekSummary, compareWeeks, alignmentTrends } from '../domain/reviewComparison.js';
import { TREND_RULES, POLICY_VERSION } from '../domain/alignmentPolicy.js';
import { explainWithFallback } from '../ai/alignmentExplainClient.js';

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
    capacity: capacityForWeek(state.weeklyCapacities, monday),
    itemSettings: state.alignmentItemSettings
  });
}

/** Seuraavan viikon muutosehdotukset tämän viikon analyysista. */
export function currentProposals(analysis, clock = clockNow()) {
  const state = getState();
  const next = nextWeekStart(analysis.weekStart);
  const nextAnalysis = analyzeCurrentWeek(next, clock);
  // Hiljaisen tavoitteen tunnistus tarvitsee edelliset viikot.
  const recentAnalyses = [1, 2].map(weeks => analyzeCurrentWeek(addDaysIso(analysis.weekStart, -7 * weeks), clock));
  return proposeAdjustments(analysis, {
    areas: state.lifeAreas,
    goals: state.goals,
    tasks: state.tasks,
    nextWeekAnalysis: nextAnalysis,
    nextCapacity: capacityForWeek(state.weeklyCapacities, next),
    recentAnalyses
  });
}

/** analyzeWeek()-syötteet tilasta annetulle viikolle (esikatselu ja tarkistus). */
export function weekInputs(weekStart, clock = clockNow()) {
  const state = getState();
  const monday = weekStartOf(weekStart);
  return {
    weekStart: monday, todayIso: clock.todayIso, nowMinutes: clock.nowMinutes,
    areas: state.lifeAreas, goals: state.goals, projects: state.projects, tasks: state.tasks,
    routines: state.routines, exceptions: state.routineExceptions, timeEntries: state.timeEntries,
    capacity: capacityForWeek(state.weeklyCapacities, monday), itemSettings: state.alignmentItemSettings
  };
}

/**
 * Esikatsele valittujen ehdotusten vaikutus ensi viikkoon. EI kirjoita.
 * @param {string} weekStart tarkasteltava viikko; ehdotukset koskevat seuraavaa
 */
export function previewSelectedAdjustments(weekStart, proposals = [], overrides = {}, clock = clockNow()) {
  return previewAdjustments({ inputs: weekInputs(nextWeekStart(weekStart), clock), proposals, overrides });
}

/** Tavoitteesta tekemiseksi: rajat tälle viikolle (vain luvut). */
export function currentPlanningConstraints(clock = clockNow()) {
  return buildPlanningConstraints(analyzeCurrentWeek(null, clock));
}

/**
 * Tarkista suunnitelmaehdotus Suunnan säännöillä ENNEN hyväksyntää.
 * Alue: olemassa olevan tavoitteen alue, tai suunnitelman kategorian
 * kautta kytketty alue. Ei kirjoita mitään.
 */
export function validatePlanAgainstAlignment(plan, { goalId = null } = {}, clock = clockNow()) {
  if (!plan) return null;
  const state = getState();
  const existing = goalId ? findGoal(goalId) : null;
  const category = plan.goal && plan.goal.category;
  const byCategory = category ? state.lifeAreas.find(area => area.categoryKey === category) : null;
  const areaId = (existing && existing.lifeAreaId) || (byCategory ? byCategory.id : null);
  const keep = list => (list || []).filter(item => item && !item.excluded);
  return validatePlanAlignment({
    planTasks: keep(plan.tasks),
    planRoutines: keep(plan.routines),
    areaId,
    base: {
      todayIso: clock.todayIso, areas: state.lifeAreas, goals: state.goals, projects: state.projects,
      tasks: state.tasks, routines: state.routines, exceptions: state.routineExceptions,
      timeEntries: state.timeEntries, capacities: state.weeklyCapacities, itemSettings: state.alignmentItemSettings
    }
  });
}

/** Päivän havainnot tälle päivälle. */
export function currentDailyAlignment(clock = clockNow()) {
  const state = getState();
  const analysis = analyzeCurrentWeek(null, clock);
  return {
    analysis,
    daily: dailyObservations(analysis, {
      todayIso: clock.todayIso, areas: state.lifeAreas,
      explain: signal => explainSignal(signal, state.lifeAreas)
    })
  };
}

/**
 * Viikon yhteenveto vertailuun ja kehitykseen. Tallennettu katsaus on
 * historiaa ja voittaa: sitä ei lasketa uudelleen nykyisillä säännöillä.
 */
export function weekSummaryFor(weekStart, clock = clockNow()) {
  const monday = weekStartOf(weekStart);
  const saved = getState().alignmentReviews.find(review => review.weekStart === monday);
  if (saved && saved.snapshot && saved.snapshot.version !== undefined) {
    return weekSummary({ ...saved.snapshot, weekStart: monday }, { origin: 'snapshot' });
  }
  return weekSummary(analyzeCurrentWeek(monday, clock), { origin: 'live' });
}

/** Tämä viikko vs. edellinen. */
export function compareWithPreviousWeek(weekStart, clock = clockNow()) {
  const monday = weekStartOf(weekStart);
  return compareWeeks(weekSummaryFor(monday, clock), weekSummaryFor(addDaysIso(monday, -7), clock));
}

/** Kehitys viimeisiltä viikoilta (vanhin ensin). Tyhjät viikot pois. */
export function recentTrends(weekStart, clock = clockNow()) {
  const monday = weekStartOf(weekStart);
  const summaries = [];
  for (let back = TREND_RULES.WEEKS - 1; back >= 0; back--) {
    const summary = weekSummaryFor(addDaysIso(monday, -7 * back), clock);
    const empty = !summary.capacityMinutes && !summary.plannedMinutes && !summary.actualMinutes;
    if (!empty) summaries.push(summary);
  }
  return alignmentTrends(summaries);
}

/** Tekoälyselitys varapolulla. Palauttaa aina selityksen. */
export async function explainSignalOptionally(signal, analysis, { fetchImpl = null, accessToken = undefined } = {}) {
  const token = accessToken !== undefined ? accessToken : await currentAccessToken().catch(() => null);
  const result = await explainWithFallback({
    analysis, signal, areas: getState().lifeAreas, accessToken: token, fetchImpl
  });
  // Lokiin vain lähde ja lopputulos: ei tekstiä, ei aluenimiä.
  logEvent('alignment.explanation', { kind: signal.kind, source: result.source, failure: result.failure || null });
  return result;
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

/** Parhaillaan tallentuvat operaatiot: kaksoisklikkaus ei tuota toista riviä. */
const inFlightOperations = new Set();

function sessionUserId() {
  const user = getUser();
  return user && user.id ? String(user.id) : null;
}

const defaultWriter = createTimeEntryWriter({
  repo: timeEntriesRepo,
  loadOutbox,
  saveOutbox,
  userId: sessionUserId,
  snapshot: sessionSnapshot,
  isSameSession,
  isOffline: () => typeof navigator !== 'undefined' && navigator.onLine === false,
  maxOutbox: MAX_OUTBOX_ENTRIES
});
let writer = defaultWriter;

/** Testejä varten: korvaa kirjoittaja (tekorepositorio). null palauttaa oletuksen. */
export function setTimeEntryWriterForTests(replacement) {
  writer = replacement || defaultWriter;
}

/**
 * Kirjaa aikaa.
 *
 * IDEMPOTENTTI: jokaisella kirjauksella on operaatiotunniste. Jos sama
 * operaatio on jo tilassa tai tallentumassa, uutta riviä ei synny
 * (`duplicate: true`). Kanta vartioi samaa uniikkirajoitteella (0013).
 *
 * OFFLINE: kun kirjaus menisi kantaan ja verkko puuttuu, kirjaus jää
 * tilaan ja laitteen lähtökoriin (`queued: true`) ja lähetetään kun
 * yhteys palaa (flushTimeOutbox). Aika ei katoa hiljaa. Tämä koskee
 * VAIN aikakirjauksia; yleistä offline-jonoa ei laajenneta.
 */
export async function logTime(input, { silent = false } = {}) {
  const id = newTaskId();
  const entry = normalizeTimeEntry({ ...input, id, operationId: input?.operationId || `log:${id}` });
  const { valid, errors } = validateTimeEntry(entry);
  if (!valid) return { ok: false, errors };
  // Omistajuus: vain käyttäjän omassa tilassa oleva kohde kelpaa.
  if (entry.lifeAreaId && !findLifeArea(entry.lifeAreaId)) entry.lifeAreaId = null;
  if (entry.taskId && !findTask(entry.taskId)) entry.taskId = null;
  if (entry.goalId && !findGoal(entry.goalId)) entry.goalId = null;
  if (entry.projectId && !findProject(entry.projectId)) entry.projectId = null;
  if (entry.routineId && !findRoutine(entry.routineId)) {
    entry.routineId = null;
    entry.occurrenceDate = null;
  }

  const existing = entriesForOperation(getState().timeEntries, entry.operationId)
    .find(other => other.operationId === entry.operationId);
  if (existing) return { ok: true, duplicate: true, entry: existing };
  if (inFlightOperations.has(entry.operationId)) return { ok: true, duplicate: true, pending: true };

  inFlightOperations.add(entry.operationId);
  try {
    addTimeEntryToState(entry);
    const result = await writer.insert(entry);
    if (!result.ok) {
      removeTimeEntryFromState(entry.id);
      if (!silent) showError(result.error);
      return { ok: false };
    }
    if (result.duplicate) return { ok: true, duplicate: true, entry };
    if (result.queued) {
      if (!silent) notify('Ei yhteyttä: kirjaus tallennetaan, kun yhteys palaa.', 5000);
      return { ok: true, queued: true, entry };
    }
    logEvent('alignment.time_logged', {
      minutes: entry.minutes, source: entry.source,
      linked: Boolean(entry.lifeAreaId || entry.taskId || entry.goalId || entry.projectId || entry.routineId)
    });
    return { ok: true, entry };
  } finally {
    inFlightOperations.delete(entry.operationId);
  }
}

/** Lähettämättömien kirjausten määrä (näkymälle). */
export function pendingTimeEntryCount() {
  return writer.pendingCount();
}

/**
 * Lähetä laitteelle jääneet kirjaukset. Uusinta on turvallinen: sama
 * operaatio tallentuu kerran (kannan uniikkirajoite -> "jo tallennettu").
 */
export async function flushTimeOutbox() {
  const result = await writer.flush();
  for (const { entry, error } of result.rejected || []) {
    // Palvelin hylkäsi (esim. kohde poistettu): ei uusita loputtomiin.
    removeTimeEntryFromState(entry.id);
    showError(error);
  }
  if (result.sent > 0) logEvent('alignment.time_outbox_flushed', { sent: result.sent, left: result.left });
  return { sent: result.sent, left: result.left };
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
export async function saveWeeklyReview({
  weekStart, reflection = null, adjustments = [], reflectionAnswers = undefined
} = {}, clock = clockNow()) {
  const analysis = analyzeCurrentWeek(weekStart, clock);
  const state = getState();
  const existing = state.alignmentReviews.find(review => review.weekStart === analysis.weekStart) || null;
  const review = normalizeAlignmentReview({
    ...(existing || {}),
    id: existing ? existing.id : newTaskId(),
    weekStart: analysis.weekStart,
    snapshotVersion: SNAPSHOT_VERSION,
    snapshot: buildReviewSnapshot(analysis),
    policyVersion: POLICY_VERSION,
    reflection,
    reflectionAnswers: reflectionAnswers === undefined
      ? (existing ? existing.reflectionAnswers : {}) : reflectionAnswers,
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
export async function applyAdjustment(proposal, { confirmFn = confirmAction, overrides = {}, confirmed = false } = {}) {
  if (!proposal || !Object.values(ADJUSTMENT).includes(proposal.type)) return { ok: false };
  // Ohjaava ehdotus ei kirjoita mitään: näkymä avaa työnkulun.
  if (NON_WRITING_ADJUSTMENTS.includes(proposal.type)) {
    return { ok: true, applied: false, navigate: 'estimate' };
  }
  if (applied.has(proposal.id)) return { ok: true, applied: false, duplicate: true };

  const payload = { ...proposal.payload, ...overrides };
  // `confirmed`: ryhmä on jo vahvistettu yhdellä dialogilla, jossa
  // jokainen muutos oli lueteltu (applySelectedAdjustments).
  const accepted = confirmed || await confirmFn({
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
  if (result.ok && !confirmed) notify('Muutos tehty.', 3000);
  return { ok: Boolean(result.ok), applied: Boolean(result.ok) };
}

/**
 * Toteuta valittu RYHMÄ muutoksia yhdellä vahvistuksella.
 *
 * Vahvistusdialogi luettelee JOKAISEN muutoksen ja esikatselun
 * lopputuloksen; mitään ei tehdä piilossa. Ohjaavat ehdotukset
 * (arvioi tehtäviä) eivät kuulu ryhmään.
 *
 * @returns {Promise<{ok: boolean, cancelled?: boolean, results?: Array}>}
 */
export async function applySelectedAdjustments(proposals = [], { confirmFn = confirmAction, overrides = {}, preview = null } = {}) {
  const writing = (proposals || []).filter(proposal => proposal && !NON_WRITING_ADJUSTMENTS.includes(proposal.type)
    && !applied.has(proposal.id));
  if (writing.length === 0) return { ok: true, results: [] };
  const lines = writing.map((proposal, index) => `${index + 1}. ${proposal.label}`);
  const outcome = preview
    ? `\n\nEnsi viikko muutosten jälkeen: suunniteltu ${formatMinutes(preview.after.plannedMinutes)}`
      + (Number.isFinite(preview.after.capacityMinutes) ? `, kapasiteetti ${formatMinutes(preview.after.capacityMinutes)}.` : '.')
    : '';
  const accepted = await confirmFn({
    title: writing.length === 1 ? 'Tehdäänkö muutos?' : `Tehdäänkö ${writing.length} muutosta?`,
    message: lines.join('\n') + outcome,
    confirmLabel: writing.length === 1 ? 'Tee muutos' : 'Tee muutokset'
  });
  if (!accepted) {
    logEvent('alignment.adjustment_group', { count: writing.length, accepted: false });
    return { ok: true, cancelled: true, results: [] };
  }
  const results = [];
  for (const proposal of writing) {
    results.push({ id: proposal.id, ...(await applyAdjustment(proposal, { overrides: overrides[proposal.id] || {}, confirmed: true })) });
  }
  const done = results.filter(result => result.applied).length;
  logEvent('alignment.adjustment_group', { count: writing.length, accepted: true, applied: done });
  notify(done === writing.length ? 'Muutokset tehty.' : `${done}/${writing.length} muutosta tehty.`, 4000);
  return { ok: done === writing.length, results };
}
