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

import { getState, findTask, findRoutine, findProject, findGoal, findLifeArea,
  upsertItemSettingsInState, removeItemSettingsFromState } from './state.js';
import { runningTimersRepo, alignmentItemSettingsRepo } from '../data/collectionsRepo.js';
import { newTaskId } from '../lib/rows.js';
import { fmtISO } from '../lib/datetime.js';
import { logEvent } from '../lib/logger.js';
import { showError, notify } from '../ui/toast.js';
import { confirmAction } from '../ui/confirm.js';
import {
  startTimer, pauseTimer, resumeTimer, stopTimer, timerStatus, TIMER_TARGET
} from '../domain/timer.js';
import { formatMinutes } from '../domain/lifeArea.js';
import {
  entriesForOccurrence, entriesForTask, entriesForOperation, sumMinutes, OPERATION
} from '../domain/timeEntry.js';
import { classifyError, ERROR_CLASS } from '../domain/offlineQueue.js';
import {
  normalizeItemSettings, validateItemSettings, isEmptySettings, settingsKey, indexItemSettings
} from '../domain/alignmentItemSettings.js';
import { currentTimer, persistTimerLocally, setTimerStateRepo } from './timerState.js';
import { getUser, sessionSnapshot, isSameSession } from '../data/session.js';
import { addTombstone, clearTombstone } from '../data/timerStore.js';
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

/**
 * Kohteen nimi käyttöliittymään. EI KOSKAAN lokiin: otsikot ja
 * aluenimet ovat käyttäjän sisältöä.
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
  return target.kind && target.kind !== 'none' ? 'Poistettu kohde' : 'Yleinen ajanseuranta';
}

// ------------------------------------------------------------ ajastin

function isUniqueViolation(error) {
  return classifyError(error) === ERROR_CLASS.DUPLICATE;
}

/** Ajastimen repositorio; testit voivat korvata sen tekokannalla. */
let timerRepo = runningTimersRepo;

export function setTimerRepoForTests(repo) {
  timerRepo = repo || runningTimersRepo;
  setTimerStateRepo(repo);
}

function sessionUserId() {
  const user = getUser();
  return user && user.id ? String(user.id) : null;
}

async function syncTimerToRepo(action, timer) {
  if (!timerRepo.isPersistent()) return { ok: true };
  const result = action === 'insert' ? await timerRepo.insert(timer)
    : action === 'update' ? await timerRepo.update(timer)
      : await timerRepo.remove(timer.id);
  if (action === 'remove') {
    // Poisto ei ehtinyt kantaan (verkko): muistetaan laitteella, ettei
    // latauksessa palaava rivi herätä pysäytettyä ajastinta henkiin.
    const id = sessionUserId();
    if (id) {
      if (result && result.ok) clearTombstone(id, timer.id);
      else addTombstone(id, timer.id);
    }
  }
  return result;
}

/**
 * Käynnistä ajastin kohteelle.
 *
 * @returns {Promise<{ok: boolean, timer?: object, code?: string, message?: string}>}
 */
export async function startTracking(target = { kind: 'none' }, { now = nowMs() } = {}) {
  const existing = currentTimer();
  const started = startTimer({ id: newTaskId(), target, nowMs: now, existing });
  if (!started.ok) return started;

  // Kohde omasta tilasta; tuntematon -> yleinen.
  const fields = entryFieldsFor(target);
  const timer = { ...started.timer, ...fields };
  if (target.kind && target.kind !== 'none' && !Object.values(fields).some(Boolean)) {
    timer.targetKind = TIMER_TARGET.NONE;
  }
  persistTimerLocally(timer);

  const result = await syncTimerToRepo('insert', timer);
  if (!result.ok && isUniqueViolation(result.error)) {
    // YKSI AJASTIN KÄYTTÄJÄÄ KOHTI: toisella laitteella on jo ajastin.
    persistTimerLocally(null);
    return { ok: false, code: 'timer.already_running_elsewhere',
      message: 'Ajastin on jo käynnissä toisella laitteella. Pysäytä se ensin.' };
  }
  // Muu virhe (verkko): ajastin pysyy laitteella, aika ei katoa.
  logEvent('alignment.timer_started', { target: timer.targetKind });
  return { ok: true, timer };
}

export async function pauseTracking({ now = nowMs() } = {}) {
  const timer = currentTimer();
  if (!timer) return { ok: false, code: 'timer.none' };
  if (timer.pausedAt) return { ok: true, timer, unchanged: true };
  const paused = pauseTimer(timer, now);
  persistTimerLocally(paused);
  await syncTimerToRepo('update', paused);
  return { ok: true, timer: paused };
}

export async function resumeTracking({ now = nowMs() } = {}) {
  const timer = currentTimer();
  if (!timer) return { ok: false, code: 'timer.none' };
  if (!timer.pausedAt) return { ok: true, timer, unchanged: true };
  const resumed = resumeTimer(timer, now);
  persistTimerLocally(resumed);
  await syncTimerToRepo('update', resumed);
  return { ok: true, timer: resumed };
}

/** Pysäytys käynnissä: toinen painallus ei tee mitään. */
let stopping = null;

/**
 * Pysäytä ja kirjaa.
 *
 * Yli 12 tunnin ajastus palauttaa `needsReview`: käyttäjä vahvistaa tai
 * korjaa keston (overrideMinutes) ennen kuin mitään kirjataan.
 *
 * @returns {Promise<{ok: boolean, entries?: Array, totalMinutes?: number,
 *   tooShort?: boolean, needsReview?: boolean, duplicate?: boolean}>}
 */
export async function stopTracking({ now = nowMs(), overrideMinutes = null } = {}) {
  if (stopping) return { ok: true, duplicate: true };
  const timer = currentTimer();
  if (!timer) return { ok: false, code: 'timer.none' };

  // Istunto talteen: jos käyttäjä vaihtuu kesken pysäytyksen, loppuja
  // osia ei kirjata toisen käyttäjän nimiin eikä hänen ajastintaan poisteta.
  const session = sessionSnapshot();
  stopping = (async () => {
    // Sama ajastin on jo pysäytetty (esim. kannasta palannut rivi):
    // aika on kirjattu, ajastin vain siivotaan. Ei toista kirjausta.
    if (entriesForOperation(getState().timeEntries, OPERATION.timer(timer.id)).length > 0) {
      persistTimerLocally(null);
      await syncTimerToRepo('remove', timer);
      return { ok: true, duplicate: true, entries: [], totalMinutes: 0 };
    }
    const result = stopTimer(timer, now, { overrideMinutes });
    if (!result.ok) return { ok: false, code: 'timer.invalid' };
    if (result.needsReview) {
      return { ok: false, needsReview: true, totalMinutes: result.totalMinutes };
    }
    if (result.tooShort) {
      persistTimerLocally(null);
      await syncTimerToRepo('remove', timer);
      return { ok: true, tooShort: true, entries: [], totalMinutes: 0 };
    }

    const saved = [];
    let queued = false;
    for (const entry of result.entries) {
      if (!isSameSession(session)) return { ok: false, code: 'timer.session_changed', entries: saved };
      const one = await logTime(entry, { silent: true });
      if (!one.ok) {
        // Kirjaus ei tallentunut eikä jonottunut: ajastin jää, jotta
        // käyttäjä voi yrittää uudelleen. Jo tallennetut osat eivät
        // monistu uusinnassa (sama operaatiotunniste).
        showError('Ajan kirjaus ei onnistunut. Ajastin on yhä tallessa; yritä uudelleen.');
        return { ok: false, entries: saved, totalMinutes: result.totalMinutes };
      }
      saved.push(one.entry);
      if (one.queued) queued = true;
    }
    if (!isSameSession(session)) return { ok: false, code: 'timer.session_changed', entries: saved };
    persistTimerLocally(null);
    await syncTimerToRepo('remove', timer);
    logEvent('alignment.timer_stopped', { minutes: result.totalMinutes, parts: saved.length });
    return { ok: true, entries: saved, totalMinutes: result.totalMinutes, queued };
  })();

  try {
    return await stopping;
  } finally {
    stopping = null;
  }
}

/** Hylkää ajastus: mitään ei kirjata. Kysyy vahvistuksen. */
export async function cancelTracking({ now = nowMs(), confirmFn = confirmAction } = {}) {
  const timer = currentTimer();
  if (!timer) return { ok: false, code: 'timer.none' };
  const status = timerStatus(timer, now);
  const accepted = await confirmFn({
    title: 'Hylätäänkö ajastus?',
    message: `Kulunutta aikaa (${formatMinutes(Math.round(status.elapsedSeconds / 60))}) ei kirjata.`,
    confirmLabel: 'Hylkää ajastus',
    destructive: true
  });
  if (!accepted) return { ok: true, cancelled: false };
  persistTimerLocally(null);
  await syncTimerToRepo('remove', timer);
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

/** Ilmoitus kirjauksesta (yhteinen sanamuoto). */
export function announceLogged(minutes, { queued = false } = {}) {
  notify(queued
    ? `${formatMinutes(minutes)} kirjattu. Tallentuu, kun yhteys palaa.`
    : `${formatMinutes(minutes)} kirjattu.`, 3000);
}
