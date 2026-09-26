// Ajanseuranta ja nopea kirjaus: sovelluskerros.
//
// Domain (src/domain/timer.js) laskee; tämä moduuli lukee kellon, luo
// tunnisteet, kirjoittaa tilaan, laitteelle ja kantaan.
//
// KOLME SÄÄNTÖÄ:
//
//   1. Ajastimen totuus on aikaleimoissa. Näytön päivitys on pelkkää
//      näyttöä (src/app/views/timeLog.js); se ei laske eikä tallenna.
//
//   2. Aika ei katoa hiljaa. Jos kannan kirjoitus epäonnistuu, ajastin
//      pysyy laitteella, ja pysäytetyt kirjaukset jäävät lähtökoriin
//      (alignment.logTime). Pysäytys poistaa ajastimen vasta kun
//      kirjaukset on tallennettu tai jonotettu.
//
//   3. Sama operaatio kerran. Pysäytyksen kirjauksilla on ajastimen
//      tunnisteesta johdettu operaatiotunniste, joten kaksoisklikkaus,
//      uusinta tai toisen laitteen pysäytys ei tuota kahta kirjausta.
//      Pysäytyshetki tallentuu laitteelle ennen ensimmäistä kirjausta,
//      joten osittain epäonnistunut pysäytys uusitaan täsmälleen samoina
//      osina, ja vain puuttuvat osat kirjataan.
//
// Käyttäjä ja istunto otetaan talteen ENNEN jokaista awaitia: kesken
// vaihtunut käyttäjä ei saa toisen ajastinta, kirjauksia eikä hautakiviä.
// Laitteen kopio on välilehtien yhteinen: toisen välilehden pysäyttämää
// ajastinta ei pysäytetä, keskeytetä eikä käynnistetä uudelleen.

import { getState, findTask, findRoutine, findProject, findGoal, findLifeArea,
  upsertItemSettingsInState, removeItemSettingsFromState } from './state.js';
import { alignmentItemSettingsRepo } from '../data/collectionsRepo.js';
import { newTaskId } from '../lib/rows.js';
import { fmtISO } from '../lib/datetime.js';
import { logEvent } from '../lib/logger.js';
import { showError, notify } from '../ui/toast.js';
import { confirmAction } from '../ui/confirm.js';
import {
  startTimer, pauseTimer, resumeTimer, stopTimer, timerStatus, hasStopPlan, TIMER_TARGET
} from '../domain/timer.js';
import { formatMinutes } from '../domain/lifeArea.js';
import {
  entriesForOccurrence, entriesForTask, entriesForOperation, sumMinutes, OPERATION
} from '../domain/timeEntry.js';
import { classifyError, ERROR_CLASS } from '../domain/offlineQueue.js';
import {
  normalizeItemSettings, validateItemSettings, isEmptySettings, settingsKey, indexItemSettings
} from '../domain/alignmentItemSettings.js';
import {
  currentTimer, persistTimerLocally, clearTimerLocally, recordStopPlan, setTimerStateRepo,
  syncTimerToRepo, deviceHoldsTimer, deviceTimer, syncStateFromDevice, reloadRunningTimers,
  pendingTimers, updatePendingTimer, removePendingTimer
} from './timerState.js';
import { getUser, sessionSnapshot, isSameSession } from '../data/session.js';
import { loadTombstones } from '../data/timerStore.js';
import { logTime } from './alignment.js';

export { currentTimer } from './timerState.js';

/** Kellon luku. Ainoa paikka tässä moduulissa; testit antavat oman. */
export function nowMs() {
  return Date.now();
}

/** Uusi kirjausoperaation tunniste (yksi dialogi = yksi operaatio). */
export function newOperationId() {
  return `log:${newTaskId()}`;
}

// ------------------------------------------------------------- kohde

/**
 * Kohteen kentät kirjaukselle. Kohde on { kind, id, occurrenceDate?,
 * lifeAreaId? }. Vain omassa tilassa oleva kohde kelpaa; muuten
 * kirjaus on "yleinen" (ei kohdetta), ei toisen käyttäjän rivi.
 */
export function entryFieldsFor(target = {}) {
  const fields = {
    lifeAreaId: null, goalId: null, taskId: null, projectId: null, routineId: null, occurrenceDate: null
  };
  switch (target.kind) {
    case TIMER_TARGET.TASK:
      if (findTask(target.id)) fields.taskId = target.id;
      break;
    case TIMER_TARGET.ROUTINE:
      if (findRoutine(target.id)) {
        fields.routineId = target.id;
        fields.occurrenceDate = target.occurrenceDate || null;
      }
      break;
    case TIMER_TARGET.PROJECT:
      if (findProject(target.id)) fields.projectId = target.id;
      break;
    case TIMER_TARGET.GOAL:
      if (findGoal(target.id)) fields.goalId = target.id;
      break;
    case TIMER_TARGET.LIFE_AREA:
      if (findLifeArea(target.id)) fields.lifeAreaId = target.id;
      break;
    default:
      if (target.lifeAreaId && findLifeArea(target.lifeAreaId)) fields.lifeAreaId = target.lifeAreaId;
  }
  return fields;
}

/** Kohde ajastimesta (näyttöä varten). */
export function targetOfTimer(timer) {
  if (!timer) return null;
  switch (timer.targetKind) {
    case TIMER_TARGET.TASK: return { kind: 'task', id: timer.taskId };
    case TIMER_TARGET.ROUTINE: return { kind: 'routine', id: timer.routineId, occurrenceDate: timer.occurrenceDate };
    case TIMER_TARGET.PROJECT: return { kind: 'project', id: timer.projectId };
    case TIMER_TARGET.GOAL: return { kind: 'goal', id: timer.goalId };
    case TIMER_TARGET.LIFE_AREA: return { kind: 'life_area', id: timer.lifeAreaId };
    default: return { kind: 'none', lifeAreaId: timer.lifeAreaId };
  }
}

/** Kohteen laji -> kokoelma, jonka latausstatus kertoo, tunnetaanko kohde. */
const TARGET_COLLECTION = Object.freeze({
  task: 'tasks', routine: 'routines', project: 'projects', goal: 'goals', life_area: 'lifeAreas'
});

/**
 * Kohteen kokoelman lataustila tässä istunnossa: 'loaded' (onnistui
 * ainakin kerran), 'failed' (lataus epäonnistui eikä ole koskaan
 * onnistunut) tai 'pending' (ei vielä tulosta).
 */
function collectionLoadState(kind) {
  const domain = TARGET_COLLECTION[kind];
  const status = domain ? getState().dataLoadStatus?.[domain] : null;
  if (status && status.lastSuccessAt != null) return 'loaded';
  if (status && status.ok === false) return 'failed';
  return 'pending';
}

/**
 * Kohteen nimi käyttöliittymään. EI KOSKAAN lokiin: otsikot ja
 * aluenimet ovat käyttäjän sisältöä.
 *
 * Laitteelta palautettu ajastin näkyy ennen latausta: silloin kohde ei ole
 * "poistettu" vaan vasta tulossa, ja nimi kertoo sen. Jos lataus
 * epäonnistui, kohde voi yhä olla olemassa, mutta nimeä ei tiedetä:
 * "Ladataan" jäisi näkyviin pysyvästi, joten nimi on neutraali.
 */
export function describeTarget(target) {
  if (!target) return 'Yleinen ajanseuranta';
  const pick = (kind, id) => {
    switch (kind) {
      case 'task': return findTask(id)?.title;
      case 'routine': return findRoutine(id)?.title;
      case 'project': return findProject(id)?.name;
      case 'goal': return findGoal(id)?.title;
      case 'life_area': return findLifeArea(id)?.name;
      default: return null;
    }
  };
  const name = pick(target.kind, target.id);
  if (name) return name;
  if (target.kind === 'none' && target.lifeAreaId) {
    return findLifeArea(target.lifeAreaId)?.name || 'Yleinen ajanseuranta';
  }
  if (!target.kind || target.kind === 'none') return 'Yleinen ajanseuranta';
  const load = collectionLoadState(target.kind);
  if (load === 'loaded') return 'Poistettu kohde';
  return load === 'failed' ? 'Kohde ei latautunut' : 'Ladataan kohdetta…';
}

// ------------------------------------------------------------ ajastin

function isUniqueViolation(error) {
  return classifyError(error) === ERROR_CLASS.DUPLICATE;
}

/** Ajastimen repositorio (src/app/timerState.js); testit voivat korvata sen tekokannalla. */
export function setTimerRepoForTests(repo) {
  setTimerStateRepo(repo);
}

function sessionUserId() {
  const user = getUser();
  return user && user.id ? String(user.id) : null;
}

/**
 * Käynnistä ajastin kohteelle.
 *
 * @returns {Promise<{ok: boolean, timer?: object, code?: string, message?: string}>}
 */
export async function startTracking(target = { kind: 'none' }, { now = nowMs() } = {}) {
  const owner = sessionUserId();
  const session = sessionSnapshot();
  // Toisen välilehden ajastin on laitteella, vaikka tämän välilehden tila
  // ei sitä vielä tuntisi: kaksi rinnakkaista ajastinta laskisi saman ajan
  // kahdesti, ja jälkimmäinen pyyhkisi ensimmäisen laitteen kopion.
  const device = owner ? deviceTimer(owner) : null;
  const existing = currentTimer() || device;
  const started = startTimer({ id: newTaskId(), target, nowMs: now, existing });
  if (!started.ok) {
    if (!currentTimer() && device) syncStateFromDevice(owner);
    return started;
  }

  // Kohde omasta tilasta; tuntematon -> yleinen.
  const fields = entryFieldsFor(target);
  const timer = { ...started.timer, ...fields };
  if (target.kind && target.kind !== 'none' && !Object.values(fields).some(Boolean)) {
    timer.targetKind = TIMER_TARGET.NONE;
  }
  persistTimerLocally(timer, { owner, synced: false, dirty: true });

  let result = await syncTimerToRepo('insert', timer, { owner });
  if (!result.ok && isUniqueViolation(result.error) && owner && isSameSession(session)) {
    // Kannassa voi olla tämän laitteen OMA pysäytetty ajastin, jonka
    // poisto ei ehtinyt perille (hautakivi). Se ei ole "toisen laitteen"
    // ajastin: haudatut rivit poistetaan ja lisäys yritetään kerran.
    const buried = loadTombstones(owner).filter(id => id !== timer.id);
    if (buried.length > 0) {
      for (const id of buried) await syncTimerToRepo('remove', { id }, { owner });
      result = await syncTimerToRepo('insert', timer, { owner });
    }
  }
  if (result.sessionChanged) {
    // Käyttäjä vaihtui ennen kuin lisäys ehti lähteä: sitä ei lähetetty
    // uuden istunnon tokenilla. Ajastin jää omistajan laitteelle (ei
    // kannassa), ja kanta saa sen, kun omistaja kirjautuu takaisin.
    return { ok: false, code: 'timer.session_changed' };
  }
  if (!result.ok && isUniqueViolation(result.error)) {
    // YKSI AJASTIN KÄYTTÄJÄÄ KOHTI: toisella laitteella on jo ajastin.
    // Vain tämä ajastin siivotaan, ja vain sen omistajan avaimelta.
    clearTimerLocally(timer.id, { owner });
    if (isSameSession(session)) reloadRunningTimers().catch(() => { /* näkyy seuraavassa latauksessa */ });
    return { ok: false, code: 'timer.already_running_elsewhere',
      message: 'Ajastin on jo käynnissä toisella laitteella. Pysäytä se ensin.' };
  }
  // Muu virhe (verkko): ajastin pysyy laitteella, aika ei katoa, ja kanta
  // saa sen seuraavassa latauksessa (src/app/timerState.js).
  logEvent('alignment.timer_started', { target: timer.targetKind });
  return { ok: true, timer };
}

/**
 * Ajastin, jota tauko, jatko tai hylkäys koskee: laitteen kopio on
 * välilehtien yhteinen totuus. Jos toinen välilehti on jo pysäyttänyt tai
 * vaihtanut ajastimen, tila korjataan eikä mitään kirjoiteta.
 */
function heldTimer(owner) {
  const timer = currentTimer();
  if (!timer) return { error: { ok: false, code: 'timer.none' } };
  if (!deviceHoldsTimer(timer, owner)) {
    syncStateFromDevice(owner);
    return { error: { ok: false, code: 'timer.changed' } };
  }
  return { timer: deviceTimer(owner) || timer };
}

export async function pauseTracking({ now = nowMs() } = {}) {
  const owner = sessionUserId();
  const { timer, error } = heldTimer(owner);
  if (error) return error;
  if (hasStopPlan(timer)) return { ok: false, code: 'timer.stopping' };
  if (timer.pausedAt) return { ok: true, timer, unchanged: true };
  const paused = pauseTimer(timer, now);
  persistTimerLocally(paused, { owner, dirty: true });
  await syncTimerToRepo('update', paused, { owner });
  return { ok: true, timer: paused };
}

export async function resumeTracking({ now = nowMs() } = {}) {
  const owner = sessionUserId();
  const { timer, error } = heldTimer(owner);
  if (error) return error;
  if (hasStopPlan(timer)) return { ok: false, code: 'timer.stopping' };
  if (!timer.pausedAt) return { ok: true, timer, unchanged: true };
  const resumed = resumeTimer(timer, now);
  persistTimerLocally(resumed, { owner, dirty: true });
  await syncTimerToRepo('update', resumed, { owner });
  return { ok: true, timer: resumed };
}

/**
 * Pysäytys käynnissä: toinen painallus ei tee mitään. Avain on käyttäjä
 * (ja paikka), joten edellisen käyttäjän kesken jäänyt pysäytys ei tee
 * seuraavan käyttäjän pysäytyksestä "kaksoiskappaletta".
 */
const stopping = new Map();

async function exclusive(key, work) {
  if (stopping.has(key)) return { ok: true, duplicate: true };
  const run = work();
  stopping.set(key, run);
  try {
    return await run;
  } finally {
    if (stopping.get(key) === run) stopping.delete(key);
  }
}

/** Käynnissä oleva ajastin: suunnitelma laitteelle, siivous tilasta, laitteelta ja kannasta. */
const RUNNING_SLOT = Object.freeze({
  savePlan: (timer, owner) => recordStopPlan(timer, { owner }),
  async release(timer, owner) {
    clearTimerLocally(timer.id, { owner });
    await syncTimerToRepo('remove', timer, { owner });
  }
});

/** Päätöstä odottava ajastin: se ei ole kannassa (kannassa on toisen laitteen ajastin). */
const PENDING_SLOT = Object.freeze({
  savePlan: (timer, owner) => updatePendingTimer(timer, { owner }),
  async release(timer, owner) {
    removePendingTimer(timer.id, { owner });
  }
});

/**
 * Pysäytyksen ydin: laske osat, tallenna suunnitelma, kirjaa puuttuvat
 * osat ja siivoa ajastin vasta, kun JOKAINEN osa on tallennettu tai
 * jonotettu.
 */
async function finishStop(timer, { now, overrideMinutes, owner, session, slot }) {
  const planned = hasStopPlan(timer);
  // Sama ajastin on jo pysäytetty muualla (esim. kannasta palannut rivi):
  // aika on kirjattu, ajastin vain siivotaan. Ei toista kirjausta. Oma
  // keskeneräinen pysäytys tunnistetaan suunnitelmasta, eikä sitä ohiteta.
  if (!planned && entriesForOperation(getState().timeEntries, OPERATION.timer(timer.id)).length > 0) {
    await slot.release(timer, owner);
    return { ok: true, duplicate: true, entries: [], totalMinutes: 0 };
  }
  const at = planned ? timer.stopAtMs : now;
  const override = planned ? timer.overrideMinutes ?? null : overrideMinutes;
  const result = stopTimer(timer, at, { overrideMinutes: override });
  if (!result.ok) return { ok: false, code: 'timer.invalid' };
  if (result.needsReview) {
    return { ok: false, needsReview: true, totalMinutes: result.totalMinutes, timerId: timer.id };
  }
  if (result.tooShort) {
    await slot.release(timer, owner);
    return { ok: true, tooShort: true, entries: [], totalMinutes: 0 };
  }

  // Toinen välilehti viimeisteli (tai hylkäsi) saman ajastimen sillä
  // välin: laitteella ei ole enää tätä ajastinta. Sen osat ovat toisen
  // välilehden vastuulla, joten täältä ei kirjata enempää eikä siivota.
  const settledElsewhere = saved => {
    syncStateFromDevice(owner);
    return { ok: true, duplicate: true, entries: saved, totalMinutes: 0 };
  };

  // Pysäytyshetki ja kesto talteen ENNEN ensimmäistä kirjausta: uusinta
  // (myös uudelleenlatauksen jälkeen) laskee samat osat ja tunnisteet.
  let plan = planned ? timer : { ...timer, stopAtMs: at, overrideMinutes: override, loggedOperationIds: [] };
  if (!planned && slot.savePlan(plan, owner).gone) return settledElsewhere([]);

  const saved = [];
  let queued = false;
  let sessionOnly = false;
  for (const entry of result.entries) {
    if ((plan.loggedOperationIds || []).includes(entry.operationId)) continue;
    if (!isSameSession(session)) return { ok: false, code: 'timer.session_changed', entries: saved };
    const one = await logTime(entry, { silent: true });
    if (!one.ok) {
      // Osa ei tallentunut eikä jonottunut: ajastin ja suunnitelma jäävät,
      // jotta käyttäjä voi yrittää uudelleen. Uusinta kirjaa vain puuttuvat
      // osat (sama suunnitelma, samat operaatiotunnisteet).
      showError('Ajan kirjaus ei onnistunut. Ajastin on yhä tallessa; yritä uudelleen.');
      return { ok: false, code: 'timer.log_failed', entries: saved, totalMinutes: result.totalMinutes };
    }
    if (one.entry) saved.push(one.entry);
    if (one.queued) queued = true;
    if (one.sessionOnly) sessionOnly = true;
    // Kirjattu osa muistiin omistajan laitteelle (ei tilaan, jos käyttäjä vaihtui).
    plan = { ...plan, loggedOperationIds: [...(plan.loggedOperationIds || []), entry.operationId] };
    if (slot.savePlan(plan, owner).gone) return settledElsewhere(saved);
  }
  if (!isSameSession(session)) return { ok: false, code: 'timer.session_changed', entries: saved };
  await slot.release(timer, owner);
  logEvent('alignment.timer_stopped', { minutes: result.totalMinutes, parts: result.entries.length });
  return { ok: true, entries: saved, totalMinutes: result.totalMinutes, queued, sessionOnly };
}

/**
 * Pysäytä ja kirjaa.
 *
 * Yli 12 tunnin ajastus palauttaa `needsReview` (ja `timerId`): käyttäjä
 * vahvistaa tai korjaa keston (overrideMinutes) ennen kuin mitään
 * kirjataan. `expectTimerId` varmistaa, että korjaus koskee samaa
 * ajastinta, joka tarkistettiin — ei dialogin aikana vaihtunutta.
 *
 * @returns {Promise<{ok: boolean, entries?: Array, totalMinutes?: number,
 *   tooShort?: boolean, needsReview?: boolean, duplicate?: boolean, code?: string}>}
 */
export async function stopTracking({ now = nowMs(), overrideMinutes = null, expectTimerId = null } = {}) {
  const owner = sessionUserId();
  const key = `run:${owner || ''}`;
  if (stopping.has(key)) return { ok: true, duplicate: true };
  const current = currentTimer();
  if (!current) return { ok: false, code: 'timer.none' };
  if (expectTimerId !== null && current.id !== String(expectTimerId)) return { ok: false, code: 'timer.changed' };

  // Istunto talteen: jos käyttäjä vaihtuu kesken pysäytyksen, loppuja
  // osia ei kirjata toisen käyttäjän nimiin eikä hänen ajastintaan poisteta.
  const session = sessionSnapshot();
  return exclusive(key, async () => {
    // Toinen välilehti on jo pysäyttänyt tämän ajastimen (laitteen kopio
    // puuttuu tai on eri): aika on kirjattu siellä. Ei toista kirjausta.
    if (!deviceHoldsTimer(current, owner)) {
      syncStateFromDevice(owner);
      return { ok: true, duplicate: true, entries: [], totalMinutes: 0 };
    }
    // Laitteen kopio sisältää toisen välilehden mahdollisesti aloittaman
    // suunnitelman ja jo kirjatut osat.
    const timer = deviceTimer(owner) || current;
    return finishStop(timer, { now, overrideMinutes, owner, session, slot: RUNNING_SLOT });
  });
}

/** Hylkää ajastus: mitään ei kirjata. Kysyy vahvistuksen. */
export async function cancelTracking({ now = nowMs(), confirmFn = confirmAction } = {}) {
  const owner = sessionUserId();
  const session = sessionSnapshot();
  const timer = currentTimer();
  if (!timer) return { ok: false, code: 'timer.none' };
  const status = timerStatus(timer, hasStopPlan(timer) ? timer.stopAtMs : now);
  // Kesken jäänyt pysäytys: jo tallennetut osat säilyvät, vain loppu hylätään.
  const partial = hasStopPlan(timer) && (timer.loggedOperationIds || []).length > 0;
  const accepted = await confirmFn({
    title: 'Hylätäänkö ajastus?',
    message: partial
      ? 'Osa ajasta on jo kirjattu, ja se säilyy. Loppua ei kirjata.'
      : `Kulunutta aikaa (${formatMinutes(Math.round(status.elapsedSeconds / 60))}) ei kirjata.`,
    confirmLabel: 'Hylkää ajastus',
    destructive: true
  });
  if (!accepted) return { ok: true, cancelled: false };
  // Vahvistus odotti käyttäjää: istunto tai ajastin on voinut vaihtua sillä
  // välin. Hylkäys koskee vain sitä ajastinta, josta kysyttiin.
  if (!isSameSession(session)) return { ok: false, code: 'timer.session_changed' };
  const latest = currentTimer();
  if (!latest || latest.id !== timer.id || !deviceHoldsTimer(timer, owner)) {
    syncStateFromDevice(owner);
    return { ok: false, code: 'timer.changed' };
  }
  clearTimerLocally(timer.id, { owner });
  await syncTimerToRepo('remove', timer, { owner });
  logEvent('alignment.timer_cancelled', {});
  return { ok: true, cancelled: true };
}

// ------------------------------------------- päätöstä odottava ajastin

/**
 * Tämän laitteen ajastin, joka ei ehtinyt kantaan ennen kuin toisella
 * laitteella käynnistettiin oma (yksi ajastin käyttäjää kohti). Se ei
 * katoa hiljaa: käyttäjä kirjaa tai hylkää sen. null, jos ei ole.
 */
export function pendingTimer() {
  return pendingTimers()[0] || null;
}

/**
 * Kirjaa odottava ajastin. Ilman valmista suunnitelmaa kesto vahvistetaan
 * AINA (`needsReview`): ajastin kävi samaan aikaan toisen laitteen
 * ajastimen kanssa, joten kulunut aika on vain ehdotus.
 */
export async function stopPendingTracking({ now = nowMs(), overrideMinutes = null, expectTimerId = null } = {}) {
  const owner = sessionUserId();
  const timer = pendingTimer();
  if (!timer) return { ok: false, code: 'timer.none' };
  if (expectTimerId !== null && timer.id !== String(expectTimerId)) return { ok: false, code: 'timer.changed' };
  if (!hasStopPlan(timer) && !Number.isInteger(overrideMinutes)) {
    const suggestion = stopTimer(timer, now);
    if (suggestion.ok && !suggestion.tooShort) {
      return { ok: false, needsReview: true, totalMinutes: suggestion.totalMinutes, timerId: timer.id };
    }
  }
  const session = sessionSnapshot();
  return exclusive(`pending:${owner || ''}`, () =>
    finishStop(timer, { now, overrideMinutes, owner, session, slot: PENDING_SLOT }));
}

/** Hylkää odottava ajastin kirjaamatta. Kysyy vahvistuksen. */
export async function discardPendingTracking({ confirmFn = confirmAction, expectTimerId = null } = {}) {
  const owner = sessionUserId();
  const session = sessionSnapshot();
  const timer = pendingTimer();
  if (!timer) return { ok: false, code: 'timer.none' };
  if (expectTimerId !== null && timer.id !== String(expectTimerId)) return { ok: false, code: 'timer.changed' };
  const accepted = await confirmFn({
    title: 'Hylätäänkö kirjaamaton ajastus?',
    message: 'Tämän laitteen aiempaa ajastusta ei kirjata.',
    confirmLabel: 'Hylkää ajastus',
    destructive: true
  });
  if (!accepted) return { ok: true, cancelled: false };
  if (!isSameSession(session)) return { ok: false, code: 'timer.session_changed' };
  if (!pendingTimers(owner).some(other => other.id === timer.id)) return { ok: false, code: 'timer.changed' };
  removePendingTimer(timer.id, { owner });
  logEvent('alignment.timer_cancelled', {});
  return { ok: true, cancelled: true };
}

// --------------------------------------------------- nopea kirjaus

/**
 * Kirjaa aikaa kohteelle muutamalla napautuksella.
 *
 * @param {object} args
 * @param {object} args.target      { kind, id, occurrenceDate?, lifeAreaId? }
 * @param {number} args.minutes
 * @param {string} [args.entryDate] oletus: tämä päivä
 * @param {string} [args.operationId] sama tunniste = sama kirjaus (kaksoisklikkaus)
 */
export async function logQuickTime({ target = { kind: 'none' }, minutes, entryDate = null, operationId = null, note = null } = {}) {
  const fields = entryFieldsFor(target);
  const date = entryDate || (target.kind === 'routine' && target.occurrenceDate) || fmtISO(new Date(nowMs()));
  return logTime({
    ...fields, minutes: Number(minutes), entryDate: date, note, source: 'manual',
    operationId: operationId || undefined
  });
}

/** Tehtävälle kirjattu aika yhteensä (näyttöä varten). */
export function loggedMinutesForTask(taskId) {
  return sumMinutes(entriesForTask(getState().timeEntries, taskId));
}

/** Rutiinin esiintymälle kirjattu aika (esiintymän identiteetti). */
export function loggedMinutesForOccurrence(routineId, dateIso) {
  return sumMinutes(entriesForOccurrence(getState().timeEntries, routineId, dateIso));
}

/**
 * Operaatiotunniste rutiinin esiintymän kirjaukselle. Ensimmäinen
 * kirjaus on `routine:<id>:<päivä>`; jos esiintymälle on jo kirjattu,
 * käyttäjä lisää TIETOISESTI aikaa, ja tunniste saa järjestysnumeron.
 */
export function occurrenceOperationId(routineId, dateIso) {
  const base = OPERATION.routineOccurrence(routineId, dateIso);
  const already = entriesForOccurrence(getState().timeEntries, routineId, dateIso)
    .some(entry => entry.operationId === base);
  // Tietoinen lisäys saa yksilöllisen tunnisteen. Laskurista johdettu
  // tunniste törmäisi aiempaan, jos jokin kirjaus on välillä poistettu,
  // ja uusi aika katoaisi hiljaa "kaksoiskappaleena".
  return already ? `${base}:${newTaskId()}`.slice(0, 100) : base;
}

// --------------------------------------------------- kohdeasetukset

/** Kohteen asetukset tilasta, tai tyhjä oletus. */
export function itemSettingsFor(kind, itemId) {
  const index = indexItemSettings(getState().alignmentItemSettings);
  return index.get(settingsKey(kind, itemId)) || normalizeItemSettings({ itemKind: kind, itemId });
}

/**
 * Päivitä kohteen asetukset (kuormittavuus, tarkoituksella ilman aluetta,
 * karkea arvio). Tyhjäksi muuttunut rivi poistetaan.
 */
export async function saveItemSettings(kind, itemId, changes = {}) {
  const exists = kind === 'task' ? findTask(itemId) : kind === 'routine' ? findRoutine(itemId)
    : kind === 'project' ? findProject(itemId) : null;
  if (!exists) return { ok: false, errors: { itemId: 'Kohdetta ei löytynyt.' } };

  const previous = getState().alignmentItemSettings.find(s => s.itemKind === kind && s.itemId === itemId) || null;
  const next = normalizeItemSettings({
    ...(previous || {}), ...changes, itemKind: kind, itemId, id: previous ? previous.id : newTaskId()
  });
  const { valid, errors } = validateItemSettings(next);
  if (!valid) return { ok: false, errors };

  if (isEmptySettings(next)) {
    if (!previous) return { ok: true, settings: null };
    removeItemSettingsFromState(previous.id);
    const removed = await alignmentItemSettingsRepo.remove(previous.id);
    if (!removed.ok) {
      upsertItemSettingsInState(previous);
      showError(removed.error);
      return { ok: false };
    }
    return { ok: true, settings: null };
  }

  upsertItemSettingsInState(next);
  const result = previous ? await alignmentItemSettingsRepo.update(next) : await alignmentItemSettingsRepo.insert(next);
  if (!result.ok) {
    if (previous) upsertItemSettingsInState(previous);
    else removeItemSettingsFromState(next.id);
    showError(result.error);
    return { ok: false };
  }
  logEvent('alignment.item_settings_saved', {
    kind, energy: next.energyDemand, optOut: next.alignmentOptOut, approximate: next.estimateApproximate
  });
  return { ok: true, settings: next };
}

/** Poista kohteen asetukset kohteen mukana (orpoja rivejä ei jätetä). */
export async function removeItemSettingsFor(kind, itemId) {
  const previous = getState().alignmentItemSettings.find(s => s.itemKind === kind && s.itemId === itemId);
  if (!previous) return { ok: true };
  removeItemSettingsFromState(previous.id);
  const result = await alignmentItemSettingsRepo.remove(previous.id);
  return { ok: Boolean(result.ok) };
}

/** Näyttö: tilateksti ja kulunut aika (ei tallenna mitään). */
export function timerDisplay(now = nowMs()) {
  const timer = currentTimer();
  if (!timer) return null;
  const status = timerStatus(timer, now);
  return { timer, status, target: targetOfTimer(timer), label: describeTarget(targetOfTimer(timer)) };
}

/**
 * Ilmoitus kirjauksesta (yhteinen sanamuoto). `sessionOnly`: laite ei voinut
 * tallentaa jonotettua kirjausta (ERR-19), joten se katoaa, jos sovellus
 * suljetaan ennen kuin yhteys palaa -- ja se sanotaan.
 */
export function announceLogged(minutes, { queued = false, sessionOnly = false } = {}) {
  if (queued && sessionOnly) {
    notify(`${formatMinutes(minutes)} kirjattu tälle istunnolle – laite ei voi tallentaa sitä `
      + 'ennen kuin yhteys palaa. Älä sulje sovellusta.', 8000);
    return;
  }
  notify(queued
    ? `${formatMinutes(minutes)} kirjattu. Tallentuu, kun yhteys palaa.`
    : `${formatMinutes(minutes)} kirjattu.`, 3000);
}
