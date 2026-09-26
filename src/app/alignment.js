// Suunta: sovelluskerroksen toiminnot.
//
// Domain (src/domain/alignment.js, alignmentReview.js) laskee ja kuvaa.
// Tämä moduuli tekee sivuvaikutukset: lukee kellon, luo tunnisteet,
// kirjoittaa repositorioihin ja pyytää vahvistuksen.
//
// KAKSI SÄÄNTÖÄ:
//
//   1. Havaintoja ei tallenneta. analyzeCurrentWeek() laskee ne aina
//      tilan lähdefaktoista (samoille kokoelmille vain muistissa oleva
//      välimuisti). Ainoa tallennettu johdos on viikkokatsauksen
//      tilannekuva, ja se on tarkoituksella historiaa.
//
//   2. Mikään muutosehdotus ei muuta mitään ilman vahvistusta.
//      applyAdjustment() näyttää vahvistusdialogin ja kirjoittaa vasta
//      hyväksynnän jälkeen. Sama ehdotus ei voi toteutua kahdesti.

import {
  getState, addLifeAreaToState, replaceLifeAreaInState, removeLifeAreaFromState,
  restoreLifeAreaInState,
  findLifeArea, upsertWeeklyCapacityInState, removeWeeklyCapacityFromState,
  addTimeEntryToState, removeTimeEntryFromState, replaceTimeEntryInState, upsertAlignmentReviewInState,
  removeAlignmentReviewFromState,
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
import { normalizeLifeArea, validateLifeArea, formatMinutes, importanceChoiceError } from '../domain/lifeArea.js';
import {
  normalizeWeeklyCapacity, validateWeeklyCapacity, capacityForWeek, weekStartOf, nextWeekStart
} from '../domain/weeklyCapacity.js';
import { normalizeTimeEntry, validateTimeEntry, entriesForOperation } from '../domain/timeEntry.js';
import { classifyError, ERROR_CLASS } from '../domain/offlineQueue.js';
import { analyzeWeek, alignmentStartOf } from '../domain/alignment.js';
import { addDaysIso } from '../domain/fiTemporal.js';
import {
  buildReviewSnapshot, normalizeAlignmentReview, validateAlignmentReview,
  proposeAdjustments, planningFeedback, explainSignal, ADJUSTMENT, SNAPSHOT_VERSION,
  NON_WRITING_ADJUSTMENTS, ADJUSTMENT_NAVIGATION
} from '../domain/alignmentReview.js';
import { editGoal, setGoalStatus, createTask, editTask } from './actions.js';
import { currentAccessToken } from './auth.js';
import { previewAdjustments } from '../domain/rebalance.js';
import { buildPlanningConstraints, validatePlanAlignment } from '../domain/planAlignment.js';
import { dailyObservations } from '../domain/dailyAlignment.js';
import { weekSummary, compareWeeks, alignmentTrends, FIRST_WEEK_NOTE } from '../domain/reviewComparison.js';
import { TREND_RULES, POLICY_VERSION } from '../domain/alignmentPolicy.js';
import { explainWithFallback, aiExplainEnabled } from '../ai/alignmentExplainClient.js';

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

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Aikaleiman paikallinen päivä (created_at on UTC-aikaleima). */
function localDateOf(timestamp) {
  if (typeof timestamp !== 'string' || !timestamp) return null;
  if (ISO_DAY.test(timestamp)) return timestamp;
  const moment = new Date(timestamp);
  return Number.isNaN(moment.getTime()) ? null : fmtISO(moment);
}

/**
 * Alueet luontipäivineen (`startDate`, paikallinen päivä). Domain ei lue
 * kelloa eikä tunne aikavyöhykettä, joten päivä johdetaan täällä: alue ei
 * voi jäädä huomiotta ajalta, jolloin sitä ei vielä ollut.
 */
export function areasWithStartDates(areas = getState().lifeAreas) {
  return (areas || []).map(area => (area ? { ...area, startDate: localDateOf(area.createdAt) } : area));
}

/** Suunnan käyttöönottopäivä: aikaisin alueen luontipäivä (null = ei tiedossa). */
export function alignmentStartDate(state = getState()) {
  return alignmentStartOf(areasWithStartDates(state.lifeAreas));
}

/**
 * Analyysin syötteet, joiden lataus epäonnistui. Epäonnistunut haku ei
 * tyhjennä tilaa, mutta ensimmäisellä latauksella tila on tyhjä: silloin
 * havainnot ("alue ei saanut aikaa") ja katsauksen tilannekuva tehtäisiin
 * vajaista luvuista. Katsausta ei tallenneta ja havainnot korvataan
 * ilmoituksella, kun yksikin näistä puuttuu.
 */
export const ANALYSIS_DOMAINS = Object.freeze([
  'lifeAreas', 'weeklyCapacities', 'timeEntries', 'alignmentReviews', 'runningTimers',
  'alignmentItemSettings', 'tasks', 'routines', 'routineExceptions', 'goals', 'projects'
]);

export function analysisLoadProblems(state = getState()) {
  const status = (state && state.dataLoadStatus) || {};
  return ANALYSIS_DOMAINS.filter(domain => status[domain] && status[domain].ok === false);
}

/**
 * Analyysien välimuisti (CRIT-01). Yksi piirto tarvitsee saman viikon
 * analyysin useaan kertaan (Suunta, päivän kortti, vertailu, ehdotukset),
 * ja jokainen tilamuutos piirtää uudelleen: ilman välimuistia yksi piirto
 * teki noin kuusi täyttä analyysia.
 *
 * AVAIN ON KOKOELMIEN VIITTAUKSET, EI SISÄLTÖ. Tilan kokoelmia ei koskaan
 * mutatoida paikallaan: jokainen muutos korvaa taulukon uudella (state.js),
 * joten sama viittaus tarkoittaa samaa sisältöä (sama periaate kuin
 * main.js:n muistutusten vahdissa). Lisäksi avaimessa ovat viikko, päivä ja
 * minuutti: analyysi riippuu kellosta ("jäljellä tällä viikolla").
 *
 * Tulosta EI SAA MUTATOIDA: sama olio palautetaan kaikille kutsujille.
 * Pieni LRU riittää: kahdeksan viikon kehitys, seuraava viikko ja
 * mahdollinen toinen katseltu viikko mahtuvat kerralla.
 */
const ANALYSIS_CACHE_SIZE = 12;
let analysisCache = [];
/** Vaihdettavissa testeissä (setWeekAnalyzerForTests): laskee kutsut. */
let weekAnalyzer = analyzeWeek;

/** Analyysin lähdekokoelmat: vain nämä vaikuttavat analyzeWeek()-tulokseen. */
function analysisSources(state) {
  return [
    state.lifeAreas, state.goals, state.projects, state.tasks, state.routines,
    state.routineExceptions, state.timeEntries, state.weeklyCapacities, state.alignmentItemSettings
  ];
}

/**
 * Vain testeille: korvaa analyzeWeek (esim. kutsujen laskenta) ja tyhjennä
 * välimuisti. null palauttaa oikean analyysin.
 */
export function setWeekAnalyzerForTests(analyzer) {
  weekAnalyzer = typeof analyzer === 'function' ? analyzer : analyzeWeek;
  analysisCache = [];
}

/**
 * Viikon analyysi tilan lähdefaktoista. Ei tallenna mitään.
 *
 * Välimuistista, kun kokoelmat, viikko, päivä ja minuutti ovat samat (ks.
 * ANALYSIS_CACHE_SIZE). Palautettu olio on jaettu: älä muuta sitä.
 *
 * @param {string} [weekStart] mikä tahansa viikon päivä (oletus: tämä viikko)
 * @param {{todayIso?: string, nowMinutes?: number}} [clock]
 */
export function analyzeCurrentWeek(weekStart = null, clock = clockNow()) {
  const state = getState();
  const monday = weekStartOf(weekStart || clock.todayIso || fmtISO(todayMidnight()));
  const todayIso = clock.todayIso;
  const minute = Number.isFinite(clock.nowMinutes) ? Math.floor(clock.nowMinutes) : clock.nowMinutes;
  const sources = analysisSources(state);
  const hit = analysisCache.findIndex(entry => entry.monday === monday && entry.todayIso === todayIso
    && entry.minute === minute && entry.sources.every((source, index) => source === sources[index]));
  if (hit >= 0) {
    const [entry] = analysisCache.splice(hit, 1);
    analysisCache.unshift(entry);
    return entry.analysis;
  }
  const analysis = weekAnalyzer({
    weekStart: monday,
    todayIso: clock.todayIso,
    nowMinutes: clock.nowMinutes,
    areas: areasWithStartDates(state.lifeAreas),
    goals: state.goals,
    projects: state.projects,
    tasks: state.tasks,
    routines: state.routines,
    exceptions: state.routineExceptions,
    timeEntries: state.timeEntries,
    capacity: capacityForWeek(state.weeklyCapacities, monday),
    itemSettings: state.alignmentItemSettings
  });
  analysisCache.unshift({ monday, todayIso, minute, sources, analysis });
  if (analysisCache.length > ANALYSIS_CACHE_SIZE) analysisCache.length = ANALYSIS_CACHE_SIZE;
  return analysis;
}

/** Laskettujen ehdotuskierrosten määrä (vain testeille: proposalRunsForTests). */
let proposalRuns = 0;

/** Vain testeille: montako kertaa currentProposals() on laskenut ehdotukset. */
export function proposalRunsForTests() {
  return proposalRuns;
}

/** Seuraavan viikon muutosehdotukset tämän viikon analyysista. */
export function currentProposals(analysis, clock = clockNow()) {
  proposalRuns += 1;
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
    areas: areasWithStartDates(state.lifeAreas), goals: state.goals, projects: state.projects, tasks: state.tasks,
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
      todayIso: clock.todayIso, areas: areasWithStartDates(state.lifeAreas), goals: state.goals, projects: state.projects,
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
export function weekSummaryFor(weekStart, clock = clockNow(), { analysis = null } = {}) {
  const monday = weekStartOf(weekStart);
  const saved = getState().alignmentReviews.find(review => review.weekStart === monday);
  if (saved && saved.snapshot && saved.snapshot.version !== undefined) {
    return weekSummary({ ...saved.snapshot, weekStart: monday }, { origin: 'snapshot' });
  }
  // Näkymä on jo laskenut tämän viikon: sitä ei lasketa uudelleen.
  const live = analysis && analysis.weekStart === monday ? analysis : analyzeCurrentWeek(monday, clock);
  return weekSummary(live, { origin: 'live' });
}

/**
 * Päättyikö viikko ennen Suunnan käyttöönottoa? Silloin viikolla ei ollut
 * alueita, tavoitteita eikä kapasiteettia, eikä sitä verrata (versio 3).
 * Tallennettu katsaus kuuluu aina Suuntaan.
 */
function weekBeforeAlignment(monday, state = getState()) {
  const start = alignmentStartDate(state);
  if (!start || addDaysIso(monday, 6) >= start) return false;
  return !state.alignmentReviews.some(review => review.weekStart === monday
    && review.snapshot && review.snapshot.version !== undefined);
}

/** Tämä viikko vs. edellinen. Ensimmäistä Suunta-viikkoa ei verrata Suuntaa edeltäneeseen. */
export function compareWithPreviousWeek(weekStart, { analysis = null } = {}, clock = clockNow()) {
  const monday = weekStartOf(weekStart);
  const previous = addDaysIso(monday, -7);
  const current = weekSummaryFor(monday, clock, { analysis });
  if (weekBeforeAlignment(previous)) return compareWeeks(current, null, { unavailableNote: FIRST_WEEK_NOTE });
  return compareWeeks(current, weekSummaryFor(previous, clock));
}

/** Kehitys viimeisiltä viikoilta (vanhin ensin). Tyhjät viikot pois. */
export function recentTrends(weekStart, clock = clockNow()) {
  const monday = weekStartOf(weekStart);
  // Viimeisin YHTENÄINEN jakso aineistollisia viikkoja: kehitys ei saa
  // hypätä tyhjän viikon yli ("kasvoi kolmen viikon aikana" koskisi
  // silloin neljää tai useampaa viikkoa). Suuntaa edeltäneet viikot eivät
  // kuulu kehitykseen (versio 3).
  const newestFirst = [];
  for (let back = 0; back < TREND_RULES.WEEKS; back++) {
    const weekMonday = addDaysIso(monday, -7 * back);
    if (weekBeforeAlignment(weekMonday)) break;
    const summary = weekSummaryFor(weekMonday, clock);
    const empty = !summary.capacityMinutes && !summary.plannedMinutes && !summary.actualMinutes;
    if (empty) {
      if (newestFirst.length > 0) break;
      continue;
    }
    newestFirst.push(summary);
  }
  return alignmentTrends(newestFirst.reverse());
}

/** Näytetäänkö tekoälyselityksen painike? Lippu: AI_EXPLAIN_ENABLED. */
export function aiExplanationAvailable() {
  return aiExplainEnabled();
}

/** Tekoälyselitys varapolulla. Palauttaa aina selityksen. */
export async function explainSignalOptionally(signal, analysis, { fetchImpl = null, accessToken = undefined } = {}) {
  // Katkaisin pois: istuntoa ei edes lueta, eikä verkkoon mennä.
  const token = !aiExplainEnabled() ? null
    : accessToken !== undefined ? accessToken : await currentAccessToken().catch(() => null);
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
  // Tärkeys on käyttäjän oma valinta: ei hiljaista oletusta (F7).
  const importanceMissing = importanceChoiceError(input);
  if (importanceMissing) return { ok: false, errors: { importance: importanceMissing } };
  const state = getState();
  const nextOrder = state.lifeAreas.reduce((max, area) => Math.max(max, area.sortOrder + 1), 0);
  // Luontihetki tilaan heti (kanta asettaa oman created_at-arvonsa, joka
  // korvaa tämän seuraavassa latauksessa): alueen seurantajakso alkaa
  // luontipäivästä, ei viikon maanantaista.
  const area = normalizeLifeArea({ sortOrder: nextOrder, ...input, id: newTaskId(), createdAt: new Date().toISOString() });
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

  // Tila luetaan UUDELLEEN vahvistuksen jälkeen: dialogin aikana ehtinyt
  // lataus tai muutos (uusi tavoite alueelle) jäisi muuten palautuksen
  // ulkopuolelle, ja epäonnistunut poisto palauttaisi väärät kytkennät.
  const current = findLifeArea(id);
  if (!current) return false;
  const latest = getState();
  const goalIds = latest.goals.filter(goal => goal.lifeAreaId === id).map(goal => goal.id);
  const entryIds = latest.timeEntries.filter(entry => entry.lifeAreaId === id).map(entry => entry.id);
  removeLifeAreaFromState(id);
  const result = await lifeAreasRepo.remove(id);
  if (!result.ok) {
    // Kanta ei muuttunut: alue ja kytkennät takaisin tilaan.
    restoreLifeAreaInState(current, goalIds, entryIds);
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

// ------------------------------------------ viikkokohtaiset tallennukset

/**
 * Saman viikon katsaus- ja kapasiteettitallennukset JONOSSA. Ilman tätä
 * toinen napautus ensimmäisen INSERTin ollessa kesken luki optimistisen
 * rivin "olemassa olevaksi" ja teki UPDATEn riville, jota kannassa ei
 * vielä ollut (RACE-04): PostgREST kuittasi nollan rivin päivityksen
 * onnistuneeksi, ja tila ja kanta erkanivat.
 */
const weekSaves = new Map();

function serializedSave(key, task) {
  const previous = weekSaves.get(key);
  const run = previous ? previous.then(task) : task();
  const tail = run.then(() => undefined, () => undefined);
  weekSaves.set(key, tail);
  tail.then(() => { if (weekSaves.get(key) === tail) weekSaves.delete(key); });
  return run;
}

/** Kannan uniikkiavain: viikolla on jo rivi (eri tunnisteella). */
function isDuplicate(error) {
  return classifyError(error) === ERROR_CLASS.DUPLICATE;
}

/**
 * Päivitys ei osunut yhteenkään riviin. Muistivarasto (portti kiinni)
 * palauttaa `memory.missing`; kantapolku palauttaa ERROR_CODE.NOT_FOUND
 * (`not_found`), kun päivitys ketjutettuna `.select('id')`:hen ei osunut
 * riviin (collectionsRepo.js). `<taulu>.not_found` on vanha muoto.
 */
function isNotFound(error) {
  const code = String((error && error.code) || '');
  return code === 'memory.missing' || /(^|\.)not_found$/.test(code);
}

// ------------------------------------------------------ kapasiteetti

/** Aseta viikon kapasiteetti. Yksi rivi viikkoa kohti (päivitys, jos on jo). */
export function saveWeeklyCapacity(input) {
  const monday = weekStartOf(input && input.weekStart) || String(input && input.weekStart);
  return serializedSave(`capacity:${monday}`, () => saveWeeklyCapacityNow(input));
}

async function saveWeeklyCapacityNow(input) {
  const state = getState();
  const existing = capacityForWeek(state.weeklyCapacities, input.weekStart);
  const capacity = normalizeWeeklyCapacity({
    ...(existing || {}), ...input, id: existing ? existing.id : newTaskId()
  });
  const { valid, errors } = validateWeeklyCapacity(capacity);
  if (!valid) return { ok: false, errors };

  upsertWeeklyCapacityInState(capacity);
  // Käyttäjä voi vaihtua odotusten välissä: silloin ei tehdä uusia
  // kantakutsuja (ne menisivät uuden käyttäjän tilille) eikä kosketa tilaan.
  const session = sessionSnapshot();
  const sessionChanged = { ok: false, sessionChanged: true };
  let saved = capacity;
  let result = existing
    ? await weeklyCapacitiesRepo.update(capacity)
    : await weeklyCapacitiesRepo.insert(capacity);
  if (!isSameSession(session)) return sessionChanged;
  if (!result.ok && existing && isNotFound(result.error)) {
    // Riviä ei ollut kannassa: luodaan se samalla tunnisteella.
    result = await weeklyCapacitiesRepo.insert(capacity);
    if (!isSameSession(session)) return sessionChanged;
  }
  if (!result.ok && isDuplicate(result.error)) {
    // Viikolla on jo rivi kannassa, vaikka tila ei sitä tuntenut (lataus
    // pyyhki sen kesken tallennuksen, tai edellisen vastaus katosi).
    // Ilman tätä jokainen uusi yritys törmäsi uniikkiavaimeen (RACE-05).
    const listed = await weeklyCapacitiesRepo.list();
    if (!isSameSession(session)) return sessionChanged;
    const stored = listed.ok ? capacityForWeek(listed.value, capacity.weekStart) : null;
    if (stored) {
      saved = normalizeWeeklyCapacity({ ...stored, ...input, id: stored.id, weekStart: capacity.weekStart });
      result = await weeklyCapacitiesRepo.update(saved);
      if (!isSameSession(session)) return sessionChanged;
    }
  }
  if (!result.ok) {
    if (existing) upsertWeeklyCapacityInState(existing);
    else removeWeeklyCapacityFromState(capacity.id);
    showError(result.error);
    return { ok: false };
  }
  // Uudelleen tilaan: samaan aikaan valmistunut lataus on voinut korvata
  // tilan listalla, jossa tätä riviä ei vielä ollut. (Sama viikko korvaa
  // myös optimistisen rivin, jos kannan rivillä oli eri tunniste.)
  upsertWeeklyCapacityInState(saved);
  rememberWrite('capacity', saved);
  logEvent('alignment.capacity_saved', { minutes: saved.availableMinutes, energy: saved.energyLevel });
  return { ok: true, capacity: saved };
}

// ------------------------------------------------------------ toteuma

/**
 * Parhaillaan tallentuvat operaatiot -> valmistumislupaus. Kaksoisklikkaus
 * ei tuota toista riviä, ja poisto odottaa kesken olevan tallennuksen.
 */
const inFlightOperations = new Map();

function sessionUserId() {
  const user = getUser();
  return user && user.id ? String(user.id) : null;
}

// ------------------------------------------ latauksen ja tallennuksen limitys
//
// Lataus (loadUserData) on parikymmentä rinnakkaista hakua. Jos tallennus
// valmistuu, kun haku on jo lähtenyt mutta tulos ei vielä ole tilassa,
// vanhentunut lista korvaa tilan ja juuri tallennettu rivi katoaa
// näkyvistä seuraavaan lataukseen asti — katsaus ja kapasiteetti jopa
// niin, että seuraava tallennus törmää kannan uniikkiavaimeen (23505).
// Siksi tallennukset kirjataan järjestysnumerolla, ja latauksen jälkeen
// sen alun jälkeen tallennetut palautetaan tilaan (keepWritesSince).

let writeSeq = 0;
const recentWrites = [];
const MAX_RECENT_WRITES = 100;

function rememberWrite(kind, value) {
  writeSeq += 1;
  recentWrites.push({ seq: writeSeq, kind, value, owner: sessionUserId() });
  if (recentWrites.length > MAX_RECENT_WRITES) recentWrites.splice(0, recentWrites.length - MAX_RECENT_WRITES);
}

function forgetWrite(kind, matches) {
  for (let index = recentWrites.length - 1; index >= 0; index--) {
    if (recentWrites[index].kind === kind && matches(recentWrites[index].value)) recentWrites.splice(index, 1);
  }
}

/** Kutsu ENNEN latausta: palauttaa merkin keepWritesSince()-kutsulle. */
export function beginDataLoad() {
  return writeSeq;
}

/**
 * Palauta tilaan ne tämän käyttäjän tallennukset, jotka valmistuivat
 * latauksen alun jälkeen mutta puuttuvat ladatusta listasta.
 */
export function keepWritesSince(mark) {
  const owner = sessionUserId();
  for (const write of recentWrites) {
    if (write.seq <= mark || write.owner !== owner) continue;
    const state = getState();
    if (write.kind === 'timeEntry') {
      const known = state.timeEntries.some(entry => entry.id === write.value.id
        || (write.value.operationId && entry.operationId === write.value.operationId));
      if (!known) addTimeEntryToState(write.value);
    } else if (write.kind === 'review') {
      const current = state.alignmentReviews.find(review => review.weekStart === write.value.weekStart);
      const newer = !current || (current.id === write.value.id
        && String(current.completedAt || '') < String(write.value.completedAt || ''));
      if (newer) upsertAlignmentReviewInState(write.value);
    } else if (write.kind === 'capacity') {
      if (!capacityForWeek(state.weeklyCapacities, write.value.weekStart)) upsertWeeklyCapacityInState(write.value);
    }
  }
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
 *
 * @param {object} input
 * @param {object} [options]
 * @param {boolean} [options.silent] ei yhtään ilmoitusta (kutsuja kertoo itse)
 * @param {boolean} [options.announceQueued] kerrotaanko jonotuksesta täällä.
 *   false, kun kutsuja kertoo kirjauksesta itse (timeTracking.announceLogged):
 *   muuten yksi kirjaus näytti kaksi lähes samanlaista ilmoitusta. Virhe ja
 *   kaksoiskappale kerrotaan silti täällä.
 */
export async function logTime(input, { silent = false, announceQueued = true } = {}) {
  const id = newTaskId();
  const entry = normalizeTimeEntry({ ...input, id, operationId: input?.operationId || `log:${id}` });
  const { valid, errors } = validateTimeEntry(entry);
  if (!valid) return { ok: false, errors };
  // Omistajuus: vain käyttäjän omassa tilassa oleva kohde kelpaa. Viite
  // pudotetaan kuitenkin vasta, kun kokoelma on ladattu tässä istunnossa:
  // laitteelta palautettu ajastin voidaan pysäyttää ennen latausta (tai
  // offline-käynnistyksessä ilman sitä), eikä kohde ole silloin poistettu
  // vaan vasta tulossa. Kannan viiteavaimet (user_id, kohde) ja kirjoittajan
  // irrotus (timeEntryWriter, 23503) suojaavat silloin omistajuuden.
  const loaded = domain => getState().dataLoadStatus?.[domain]?.lastSuccessAt != null;
  if (entry.lifeAreaId && loaded('lifeAreas') && !findLifeArea(entry.lifeAreaId)) entry.lifeAreaId = null;
  if (entry.taskId && loaded('tasks') && !findTask(entry.taskId)) entry.taskId = null;
  if (entry.goalId && loaded('goals') && !findGoal(entry.goalId)) entry.goalId = null;
  if (entry.projectId && loaded('projects') && !findProject(entry.projectId)) entry.projectId = null;
  if (entry.routineId && loaded('routines') && !findRoutine(entry.routineId)) {
    entry.routineId = null;
    entry.occurrenceDate = null;
  }

  const existing = entriesForOperation(getState().timeEntries, entry.operationId)
    .find(other => other.operationId === entry.operationId);
  if (existing) return { ok: true, duplicate: true, entry: existing };
  if (inFlightOperations.has(entry.operationId)) return { ok: true, duplicate: true, pending: true };

  let settle = () => {};
  inFlightOperations.set(entry.operationId, new Promise(resolve => { settle = resolve; }));
  const session = sessionSnapshot();
  try {
    addTimeEntryToState(entry);
    const result = await writer.insert(entry);
    // Käyttäjä vaihtui odotuksen aikana: tila kuuluu jo toiselle. Kirjaus
    // on tekijänsä korissa tai kannassa; nykyiseen tilaan ei kosketa.
    if (!isSameSession(session)) {
      return result.ok ? { ok: true, entry, queued: Boolean(result.queued), sessionChanged: true }
        : { ok: false, sessionChanged: true };
    }
    if (!result.ok) {
      removeTimeEntryFromState(entry.id);
      if (!silent) showError(result.error);
      return { ok: false };
    }
    if (result.duplicate) {
      // Sama operaatio on jo kannassa (tai korissa) eri tunnisteella:
      // paikallista kopiota ei jätetä tilaan (se näkyisi kahdesti eikä
      // sitä voisi poistaa). Kannan rivi tulee seuraavassa latauksessa.
      removeTimeEntryFromState(entry.id);
      // Käyttäjän oma kirjaus ei saa kadota hiljaa (F17): esimerkiksi
      // rutiinin kerta on voitu kirjata jo toisella laitteella.
      if (!silent) notify('Tämä aika on jo kirjattu (esimerkiksi toisella laitteella), joten sitä ei lisätty toista kertaa.', 6000);
      return { ok: true, duplicate: true, entry };
    }
    if (result.detached) {
      replaceTimeEntryInState(entry.id, result.entry);
      rememberWrite('timeEntry', result.entry);
      return { ok: true, detached: true, entry: result.entry };
    }
    if (result.queued) {
      // Laitteen tallennus ei toimi: kirjaus elää vain istunnon muistissa,
      // eikä "tallennetaan, kun yhteys palaa" pidä, jos sovellus suljetaan.
      if (!silent && announceQueued) {
        notify(result.sessionOnly
          ? 'Ei yhteyttä, eikä laite voi tallentaa kirjausta: se on tallessa vain tämän istunnon ajan. '
            + 'Älä sulje sovellusta ennen kuin yhteys palaa.'
          : 'Ei yhteyttä: kirjaus tallennetaan, kun yhteys palaa.', result.sessionOnly ? 8000 : 5000);
      }
      return { ok: true, queued: true, sessionOnly: Boolean(result.sessionOnly), entry };
    }
    rememberWrite('timeEntry', entry);
    logEvent('alignment.time_logged', {
      minutes: entry.minutes, source: entry.source,
      linked: Boolean(entry.lifeAreaId || entry.taskId || entry.goalId || entry.projectId || entry.routineId)
    });
    return { ok: true, entry };
  } finally {
    inFlightOperations.delete(entry.operationId);
    settle();
  }
}

/** Lähettämättömien kirjausten määrä (näkymälle). */
export function pendingTimeEntryCount() {
  return writer.pendingCount();
}

/** Korissa odottavien kirjausten operaatiotunnisteet (listan merkintä). */
export function pendingTimeEntryOperations() {
  return typeof writer.pendingOperations === 'function' ? writer.pendingOperations() : new Set();
}

/**
 * Parhaillaan tallentuvan kirjauksen valmistumislupaus, tai null. Tallentuvaa
 * ei voi vielä liittää alueeseen (editTimeEntry hylkää sen).
 */
export function timeEntrySaving(operationId) {
  return (operationId && inFlightOperations.get(operationId)) || null;
}

/**
 * Kirjaukset, joita palvelin ei toistuvasti hyväksynyt (pysyvä virhe, ei
 * verkko). Ne ovat yhä laitteella eivätkä estä muiden lähetystä; käyttäjä
 * päättää niistä Suunta-näkymässä.
 */
export function failedTimeEntries() {
  return typeof writer.failedEntries === 'function' ? writer.failedEntries() : [];
}

/** Epäonnistuneiden operaatiotunnisteet (listan merkintä). */
export function failedTimeEntryOperations() {
  return new Set(failedTimeEntries().map(entry => entry.operationId));
}

/** "Yritä uudelleen": epäonnistuneet takaisin lähetykseen ja lähetys heti. */
export async function retryFailedTimeEntries() {
  const retried = typeof writer.retryFailed === 'function' ? writer.retryFailed() : 0;
  if (retried === 0) return { retried: 0, sent: 0, left: pendingTimeEntryCount() };
  outboxRetry = { failures: 0, notBefore: 0 };
  // Jo käynnissä oleva lähetys on voinut ohittaa ne ennen palautusta:
  // odotetaan se loppuun ja lähetetään sitten uudelleen.
  if (outboxFlush) await outboxFlush.catch(() => null);
  const result = await flushTimeOutbox();
  return { retried, ...result };
}

/**
 * "Hylkää": epäonnistuneet pois laitteelta. Vaatii AINA vahvistuksen (sama
 * sääntö kuin tehtäväjonon epäonnistuneissa): aika on käyttäjän työtä.
 */
export async function discardFailedTimeEntries({ confirmFn = confirmAction } = {}) {
  const count = failedTimeEntries().length;
  if (count === 0) return { discarded: 0 };
  const session = sessionSnapshot();
  const accepted = await confirmFn({
    title: 'Hylätäänkö kirjaukset?',
    message: count === 1
      ? 'Kirjaus poistetaan tältä laitteelta eikä sitä lähetetä. Tätä ei voi perua.'
      : `${count} kirjausta poistetaan tältä laitteelta eikä niitä lähetetä. Tätä ei voi perua.`,
    confirmLabel: 'Hylkää',
    cancelLabel: 'Pidä toistaiseksi',
    destructive: true
  });
  if (!accepted || !isSameSession(session)) return { discarded: 0, cancelled: true };
  let discarded = 0;
  // Luetaan uudelleen vahvistuksen jälkeen: dialogin aikana jokin on voinut lähteä.
  for (const entry of failedTimeEntries()) {
    if (writer.forget(entry).length === 0) continue;
    forgetWrite('timeEntry', value => value.id === entry.id);
    removeTimeEntryFromState(entry.id);
    discarded += 1;
  }
  if (discarded > 0) logEvent('alignment.time_outbox_discarded', { count: discarded });
  return { discarded };
}

/** Automaattisen uusinnan porrastus: epäonnistunut kierros harventaa seuraavia. */
const OUTBOX_RETRY_BASE_MS = 30000;
const OUTBOX_RETRY_MAX_MS = 10 * 60000;
let outboxRetry = { failures: 0, notBefore: 0 };
let outboxFlush = null;

/**
 * Lähetä laitteelle jääneet kirjaukset. Uusinta on turvallinen: sama
 * operaatio tallentuu kerran (kannan uniikkirajoite -> "jo tallennettu").
 *
 * YKSI KERRALLAAN: rinnakkainen kutsu (kirjautuminen, verkon palautuminen,
 * ajastettu uusinta) saa käynnissä olevan lähetyksen tuloksen. Näin
 * "lähetä ensin, lataa sitten" odottaa myös toisen käynnistämän lähetyksen.
 */
export function flushTimeOutbox({ now = Date.now() } = {}) {
  if (outboxFlush) return outboxFlush;
  const run = flushTimeOutboxOnce(now);
  outboxFlush = run;
  const done = () => { if (outboxFlush === run) outboxFlush = null; };
  run.then(done, done);
  return run;
}

async function flushTimeOutboxOnce(now) {
  const session = sessionSnapshot();
  const result = await writer.flush();
  // Käyttäjä vaihtui lähetyksen aikana: tulos koskee edellistä käyttäjää,
  // eikä sitä kirjata tämän käyttäjän tilaan tai tallennusmuistiin.
  if (!isSameSession(session)) return { sent: result.sent, left: result.left };
  for (const entry of result.detached || []) {
    if (getState().timeEntries.some(e => e.id === entry.id)) replaceTimeEntryInState(entry.id, entry);
  }
  for (const entry of result.sentEntries || []) rememberWrite('timeEntry', entry);
  for (const { entry, error } of result.rejected || []) {
    // Palvelin hylkäsi (esim. kohde poistettu): ei uusita loputtomiin.
    removeTimeEntryFromState(entry.id);
    showError(error);
  }
  if ((result.newlyFailed || []).length > 0) {
    // Pysyvä virhe toistui: kirjaus jää laitteelle, eikä sitä enää yritetä
    // automaattisesti. Käyttäjälle kerrotaan, ettei aika kadonnut.
    notify('Aikakirjausta ei saatu tallennettua palvelimelle. Se on tallessa tällä laitteella: '
      + 'voit yrittää uudelleen tai hylätä sen Suunta-näkymässä.', 8000);
  }
  if (result.sent > 0) logEvent('alignment.time_outbox_flushed', { sent: result.sent, left: result.left });
  outboxRetry = result.sent === 0 && result.left > 0
    ? { failures: outboxRetry.failures + 1,
        notBefore: now + Math.min(OUTBOX_RETRY_BASE_MS * 2 ** outboxRetry.failures, OUTBOX_RETRY_MAX_MS) }
    : { failures: 0, notBefore: 0 };
  return { sent: result.sent, left: result.left };
}

/**
 * Ajastettu uusinta (F16): verkko voi pätkiä niin, ettei selain koskaan
 * ilmoita olevansa offline (heikko kenttä, kirjautumissivu). Silloin
 * mikään muu ei lähettäisi koria ennen seuraavaa paluuta sovellukseen.
 * Ei tee mitään, jos kori on tyhjä tai edellinen yritys epäonnistui äsken.
 */
export function retryTimeOutbox({ now = Date.now() } = {}) {
  if (pendingTimeEntryCount() === 0) return Promise.resolve({ sent: 0, left: 0, skipped: 'empty' });
  if (now < outboxRetry.notBefore) return Promise.resolve({ sent: 0, left: pendingTimeEntryCount(), skipped: 'backoff' });
  return flushTimeOutbox({ now });
}

/**
 * Uloskirjautuminen: istuntokohtainen lähetys- ja tallennusmuisti pois.
 * Myös viikkokohtaiset tallennusjonot: edellisen käyttäjän jumittunut
 * tallennus ei saa pidätellä seuraavan käyttäjän saman viikon tallennusta.
 */
export function resetAlignmentSession() {
  outboxRetry = { failures: 0, notBefore: 0 };
  outboxFlush = null;
  recentWrites.length = 0;
  weekSaves.clear();
  // Analyysit sisältävät edellisen käyttäjän alueet ja kohteet.
  analysisCache = [];
}

/**
 * Poista kirjaus.
 *
 * Kesken oleva tallennus (kirjaus tai korin lähetys) odotetaan ensin:
 * muuten myöhästyvä INSERT herättäisi poistetun rivin henkiin. Lähtökorista
 * poistetaan myös (F9): ennen tätä poisto "onnistui" (kanta poisti 0 riviä),
 * mutta seuraava lähetys lisäsi kirjauksen takaisin.
 */
export async function deleteTimeEntry(id) {
  const entry = getState().timeEntries.find(e => e.id === id);
  if (!entry) return false;
  removeTimeEntryFromState(id);
  if (entry.operationId) {
    await inFlightOperations.get(entry.operationId);
    if (typeof writer.settled === 'function') await writer.settled(entry.operationId);
  }
  forgetWrite('timeEntry', value => value.id === entry.id);
  const unqueued = typeof writer.forget === 'function' ? writer.forget(entry) : [];
  // Korin lähetys ehti ottaa kirjauksen matkaan juuri ennen unohdusta:
  // odota sen vastaus, jottei myöhästyvä INSERT herätä poistettua riviä.
  if (entry.operationId && typeof writer.settled === 'function') await writer.settled(entry.operationId);
  const result = await timeEntriesRepo.remove(id);
  if (!result.ok) {
    if (unqueued.length > 0) writer.requeue(unqueued);
    addTimeEntryToState(entry);
    showError(result.error);
    return false;
  }
  return true;
}

/**
 * Liitä kirjattu aika elämänalueeseen jälkikäteen (tai irrota: null).
 *
 * Ainoa muokattava kenttä on alue: minuutit, päivä ja lähde ovat
 * kirjaushetken tosiasioita. Ilman tätä ajastimella "Ei aluetta"
 * kirjattu aika jäi pysyvästi kohdistamattomaksi (F6).
 *
 * Kirjaus, joka odottaa vielä lähetystä (lähtökori tai kesken oleva
 * tallennus), ei ole kannassa: päivitys osuisi nollaan riviin ja korin
 * myöhempi lähetys palauttaisi vanhan arvon. Se liitetään vasta, kun se
 * on tallentunut.
 *
 * @param {string} id
 * @param {{lifeAreaId: string|null}} changes
 * @returns {Promise<{ok: boolean, errors?: object, pending?: boolean, entry?: object}>}
 */
export async function editTimeEntry(id, changes = {}) {
  const entry = getState().timeEntries.find(e => e.id === id);
  if (!entry) return { ok: false, errors: { id: 'Kirjausta ei löytynyt.' } };
  const unsupported = Object.keys(changes || {}).filter(key => key !== 'lifeAreaId');
  if (unsupported.length > 0) return { ok: false, errors: { [unsupported[0]]: 'Vain alueen voi vaihtaa.' } };
  const lifeAreaId = changes.lifeAreaId || null;
  if (lifeAreaId && !findLifeArea(lifeAreaId)) return { ok: false, errors: { lifeAreaId: 'Aluetta ei löytynyt.' } };
  if (entry.operationId && (inFlightOperations.has(entry.operationId) || pendingTimeEntryOperations().has(entry.operationId))) {
    return { ok: false, pending: true, errors: { id: 'Kirjaus odottaa lähetystä. Liitä se alueeseen, kun se on tallentunut.' } };
  }
  if ((entry.lifeAreaId || null) === lifeAreaId) return { ok: true, entry };

  const updated = normalizeTimeEntry({ ...entry, lifeAreaId });
  const { valid, errors } = validateTimeEntry(updated);
  if (!valid) return { ok: false, errors };

  replaceTimeEntryInState(id, updated);
  const session = sessionSnapshot();
  const result = await timeEntriesRepo.update(updated);
  // Käyttäjä vaihtui odotuksen aikana: tila kuuluu jo toiselle.
  if (!isSameSession(session)) return { ok: false, sessionChanged: true };
  if (!result.ok) {
    // Palautus vain, jos kirjaus on yhä tilassa (poisto tai lataus ehti väliin).
    if (getState().timeEntries.some(e => e.id === id)) replaceTimeEntryInState(id, entry);
    showError(result.error);
    return { ok: false };
  }
  logEvent('alignment.time_entry_assigned', { assigned: Boolean(lifeAreaId) });
  return { ok: true, entry: updated };
}

// ------------------------------------------------------- katsaus

/**
 * Tallenna viikkokatsaus: tilannekuva siitä mitä käyttäjä näki, hänen
 * oma pohdintansa ja vahvistetut muutokset.
 */
export function saveWeeklyReview(input = {}, clock = clockNow()) {
  const monday = weekStartOf((input && input.weekStart) || clock.todayIso || fmtISO(todayMidnight()));
  return serializedSave(`review:${monday}`, () => saveWeeklyReviewNow(input || {}, clock));
}

async function saveWeeklyReviewNow({
  weekStart, reflection = null, adjustments = [], reflectionAnswers = undefined
}, clock) {
  // Tilannekuva on historiaa, jota ei lasketa uudelleen: vajaista luvuista
  // (epäonnistunut lataus) sitä ei tehdä. Mitään ei kirjoiteta; käyttäjän
  // pohdinta jää kenttään.
  const problems = analysisLoadProblems();
  if (problems.length > 0) {
    logEvent('alignment.review_refused', { reason: 'incomplete_data', domains: problems.length });
    return { ok: false, code: 'incomplete_data', problems };
  }
  const analysis = analyzeCurrentWeek(weekStart, clock);
  const state = getState();
  const existing = state.alignmentReviews.find(review => review.weekStart === analysis.weekStart) || null;
  // Katsauksen puuttuessa toteutetut muutokset kirjataan nyt (RACE-12).
  const pendingAdjustments = [...(pendingReviewAdjustments.get(analysis.weekStart) || [])];
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
    adjustments: [...new Set([...(existing ? existing.adjustments : []), ...pendingAdjustments, ...adjustments])],
    completedAt: new Date().toISOString()
  });
  const { valid, errors } = validateAlignmentReview(review);
  if (!valid) return { ok: false, errors };

  upsertAlignmentReviewInState(review);
  // Käyttäjä voi vaihtua odotusten välissä: silloin ei tehdä uusia
  // kantakutsuja (A:n pohdinta B:n katsaukseen) eikä kosketa tilaan.
  const session = sessionSnapshot();
  const sessionChanged = { ok: false, sessionChanged: true };
  let saved = review;
  let result = existing ? await alignmentReviewsRepo.update(review) : await alignmentReviewsRepo.insert(review);
  if (!isSameSession(session)) return sessionChanged;
  if (!result.ok && existing && isNotFound(result.error)) {
    // Riviä ei ollut kannassa: luodaan se samalla tunnisteella.
    result = await alignmentReviewsRepo.insert(review);
    if (!isSameSession(session)) return sessionChanged;
  }
  if (!result.ok && isDuplicate(result.error)) {
    // Viikolla on jo katsaus kannassa, vaikka tila ei sitä tuntenut
    // (lataus pyyhki sen kesken tallennuksen, tai vastaus katosi). Ilman
    // tätä jokainen uusi yritys törmäsi uniikkiavaimeen (RACE-05).
    // Käyttäjän kirjoittama voittaa; tallennettu täydentää.
    const listed = await alignmentReviewsRepo.list();
    if (!isSameSession(session)) return sessionChanged;
    const stored = listed.ok ? listed.value.find(row => row.weekStart === review.weekStart) : null;
    if (stored) {
      saved = normalizeAlignmentReview({
        ...review,
        id: stored.id,
        reflection: review.reflection ?? stored.reflection ?? null,
        reflectionAnswers: { ...(stored.reflectionAnswers || {}), ...(review.reflectionAnswers || {}) },
        adjustments: [...new Set([...(stored.adjustments || []), ...review.adjustments])]
      });
      result = await alignmentReviewsRepo.update(saved);
      if (!isSameSession(session)) return sessionChanged;
    }
  }
  if (!result.ok) {
    // Palautus MOLEMMISSA tapauksissa. Ennen korjausta epäonnistunut
    // ENSIMMÄINEN tallennus jätti katsauksen tilaan, seuraava tallennus
    // piti sitä olemassa olevana, päivitti nollaa riviä ja ilmoitti
    // "tallennettu" — pohdinta katosi seuraavassa latauksessa.
    if (existing) upsertAlignmentReviewInState(existing);
    else removeAlignmentReviewFromState(review.id);
    showError(result.error);
    return { ok: false };
  }
  // Uudelleen tilaan: samaan aikaan valmistunut lataus on voinut korvata
  // tilan listalla, jossa tätä katsausta ei vielä ollut.
  upsertAlignmentReviewInState(saved);
  rememberWrite('review', saved);
  const recorded = pendingReviewAdjustments.get(analysis.weekStart);
  if (recorded) {
    for (const id of pendingAdjustments) recorded.delete(id);
    if (recorded.size === 0) pendingReviewAdjustments.delete(analysis.weekStart);
  }
  logEvent('alignment.review_saved', {
    signals: analysis.signals.length, adjustments: saved.adjustments.length,
    quality: analysis.dataQuality.level
  });
  return { ok: true, review: saved };
}

// ------------------------------------------------------- muutokset

/** Tällä istunnolla jo toteutetut ehdotukset: sama ehdotus ei toteudu kahdesti. */
const applied = new Set();

/**
 * Viikko -> toteutetut ehdotukset, joita ei vielä ole kirjattu katsaukseen
 * (katsausta ei ollut toteutushetkellä). Seuraava saveWeeklyReview kirjaa ne.
 */
const pendingReviewAdjustments = new Map();

export function resetAppliedAdjustments() {
  applied.clear();
  pendingReviewAdjustments.clear();
}

/** Luodaanko tehtävä, joka on jo olemassa (sama otsikko ja päivä)? */
function taskAlreadyCreated(payload) {
  const title = String((payload && payload.title) || '').trim();
  if (!title) return false;
  return getState().tasks.some(task => String(task.title || '').trim() === title && task.date === payload.date);
}

/**
 * Onko ehdotus jo toteutettu? Istunnon muisti ei riitä (RACE-12): sivun
 * uudelleenlatauksen tai toisen välilehden jälkeen sama ehdotus näkyi
 * uudelleen ja loi toisen tehtävän. Siksi myös viikon TALLENNETTU
 * katsaus ja (tehtävän luonnissa) olemassa oleva tehtävä ratkaisevat.
 *
 * @param {object} proposal
 * @param {string|null} [weekStart] viikko, jonka analyysista ehdotus syntyi
 */
export function isAdjustmentDone(proposal, weekStart = null) {
  if (!proposal) return false;
  if (applied.has(proposal.id)) return true;
  const monday = weekStart ? weekStartOf(weekStart) : null;
  if (monday) {
    const review = getState().alignmentReviews.find(entry => entry.weekStart === monday);
    if (review && (review.adjustments || []).includes(proposal.id)) return true;
    if ((pendingReviewAdjustments.get(monday) || new Set()).has(proposal.id)) return true;
  }
  return proposal.type === ADJUSTMENT.CREATE_TASK && taskAlreadyCreated(proposal.payload);
}

function describe(proposal) {
  return proposal.detail ? `${proposal.label}\n\n${proposal.detail}` : proposal.label;
}

/**
 * Käyttäjän muokkaaman arvon tarkistus ENNEN vahvistusta: virheellisestä
 * arvosta ei kysytä "Tehdäänkö muutos?", vaan virhe näytetään kentän
 * vieressä. Samat säännöt kuin tallennuksessa (validateLifeArea,
 * validateWeeklyCapacity).
 *
 * @returns {Object<string,string>|null} virheet kentittäin tai null
 */
export function adjustmentErrors(proposal, payload = proposal && proposal.payload) {
  if (!proposal || !payload) return null;
  if (proposal.type === ADJUSTMENT.CHANGE_TARGET) {
    const area = findLifeArea(payload.areaId);
    if (!area) return null;
    const { valid, errors } = validateLifeArea(
      normalizeLifeArea({ ...area, targetMinutesPerWeek: payload.to, id: area.id }), getState().lifeAreas);
    return valid ? null : errors;
  }
  if (proposal.type === ADJUSTMENT.SET_CAPACITY) {
    const { valid, errors } = validateWeeklyCapacity(normalizeWeeklyCapacity({
      weekStart: payload.weekStart, availableMinutes: payload.availableMinutes
    }));
    return valid ? null : errors;
  }
  return null;
}

/**
 * Toteuta yksi muutosehdotus VAHVISTUKSEN JÄLKEEN.
 *
 * @param {object} proposal proposeAdjustments()-tuloksen alkio
 * @param {object} [options]
 * @param {Function} [options.confirmFn] vahvistusdialogi (testeissä korvattava)
 * @param {object} [options.overrides] käyttäjän muokkaama arvo (esim. tavoiteminuutit)
 * @param {string} [options.weekStart] viikko, jonka analyysista ehdotus syntyi:
 *   sen tallennettu katsaus kertoo jo toteutetut, ja toteutus kirjataan siihen
 * @returns {Promise<{ok: boolean, applied?: boolean, cancelled?: boolean, duplicate?: boolean,
 *   errors?: Object<string,string>, navigate?: string}>} `errors`: kelvoton arvo (näytetään kentän vieressä)
 */
export async function applyAdjustment(proposal, {
  confirmFn = confirmAction, overrides = {}, confirmed = false, weekStart = null
} = {}) {
  if (!proposal || !Object.values(ADJUSTMENT).includes(proposal.type)) return { ok: false };
  // Ohjaava ehdotus ei kirjoita mitään: näkymä avaa työnkulun.
  if (NON_WRITING_ADJUSTMENTS.includes(proposal.type)) {
    return { ok: true, applied: false, navigate: ADJUSTMENT_NAVIGATION[proposal.type] || 'estimate' };
  }
  if (applied.has(proposal.id)) return { ok: true, applied: false, duplicate: true };

  const payload = { ...proposal.payload, ...overrides };
  // Jo toteutettu aiemmin (tallennettu katsaus) tai tehtävä on jo olemassa:
  // ei kysytä eikä luoda toista kertaa.
  if (isAdjustmentDone({ ...proposal, payload }, weekStart)) return { ok: true, applied: false, duplicate: true };
  const invalid = adjustmentErrors(proposal, payload);
  if (invalid) return { ok: false, applied: false, errors: invalid };
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
  else if (weekStart && weekStartOf(weekStart)) {
    // Muistiin viikolle: seuraava katsauksen tallennus kirjaa toteutuksen,
    // jolloin sama ehdotus ei toteudu uudelleen latauksen jälkeen.
    const monday = weekStartOf(weekStart);
    if (!pendingReviewAdjustments.has(monday)) pendingReviewAdjustments.set(monday, new Set());
    pendingReviewAdjustments.get(monday).add(proposal.id);
  }
  logEvent('alignment.adjustment', { type: proposal.type, accepted: true, ok: Boolean(result.ok) });
  if (result.ok && !confirmed) notify('Muutos tehty.', 3000);
  // Validointivirheet välitetään näkymälle (ennen tätä ne katosivat, ja
  // napautus näytti tekevän ei mitään).
  return result.ok || !result.errors
    ? { ok: Boolean(result.ok), applied: Boolean(result.ok) }
    : { ok: false, applied: false, errors: result.errors };
}

/**
 * Toteuta valittu RYHMÄ muutoksia yhdellä vahvistuksella.
 *
 * Vahvistusdialogi luettelee JOKAISEN muutoksen ja esikatselun
 * lopputuloksen; mitään ei tehdä piilossa. Ohjaavat ehdotukset
 * (arvioi tehtäviä) eivät kuulu ryhmään.
 *
 * @returns {Promise<{ok: boolean, cancelled?: boolean, results?: Array, invalid?: Array, failed?: Array}>}
 *   `invalid`: kelvottomat arvot (ei kysytty mitään); `failed`: ehdotukset, joita ei saatu tehtyä
 */
export async function applySelectedAdjustments(proposals = [], {
  confirmFn = confirmAction, overrides = {}, preview = null, weekStart = null
} = {}) {
  const writing = (proposals || []).filter(proposal => proposal && !NON_WRITING_ADJUSTMENTS.includes(proposal.type)
    && !isAdjustmentDone({ ...proposal, payload: { ...proposal.payload, ...(overrides[proposal.id] || {}) } }, weekStart));
  if (writing.length === 0) return { ok: true, results: [] };
  // Kelvoton arvo pysäyttää koko ryhmän ENNEN vahvistusta: ryhmää ei
  // tehdä puolittain, eikä käyttäjä vahvista muutosta, joka ei voi onnistua.
  const invalid = writing
    .map(proposal => ({ id: proposal.id, label: proposal.label,
      errors: adjustmentErrors(proposal, { ...proposal.payload, ...(overrides[proposal.id] || {}) }) }))
    .filter(entry => entry.errors);
  if (invalid.length > 0) return { ok: false, invalid, results: [] };
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
    results.push({ id: proposal.id, ...(await applyAdjustment(proposal, {
      overrides: overrides[proposal.id] || {}, confirmed: true, weekStart
    })) });
  }
  const done = results.filter(result => result.applied).length;
  logEvent('alignment.adjustment_group', { count: writing.length, accepted: true, applied: done });
  // Epäonnistuneet nimetään: "0/1 muutosta tehty" ei kertonut mikä jäi tekemättä.
  const failed = writing.map((proposal, index) => ({ proposal, result: results[index] }))
    .filter(({ result }) => !result.applied && !result.duplicate)
    .map(({ proposal, result }) => ({ id: proposal.id, label: proposal.label, errors: result.errors || null }));
  if (done === writing.length) notify('Muutokset tehty.', 4000);
  else {
    notify(`${done}/${writing.length} muutosta tehty.`
      + (failed.length > 0 ? ` Ei tehty: ${failed.map(entry => entry.label).join('; ')}.` : ''), 6000);
  }
  return { ok: done === writing.length, results, failed };
}
