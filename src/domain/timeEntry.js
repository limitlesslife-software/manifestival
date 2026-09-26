// Toteutunut aika: käyttäjän itse kirjaama.
//
// Puhdas moduuli: ei DOM:ia, ei verkkoa, ei kelloa.
//
// ARVIO EI OLE TOTEUMA. Valmiiksi merkitty tehtävä ei tuota kirjausta,
// eikä tehtävän arvioitua kestoa kopioida tänne. Jos sovellus keksisi
// toteuman suunnitelmasta, "suunniteltu vs. toteutunut" vertaisi
// suunnitelmaa itseensä ja jokainen viikko näyttäisi täydelliseltä.
//
// Kun käyttäjä valitsee "Arvio (45 min)" tehtävän valmistuessa, HÄN
// päättää hyväksyä arvion toteumaksi, ja kirjaus on silloin tavallinen
// käsin tehty kirjaus. Sovellus ei tee sitä koskaan itse.
//
// LÄHTEET (source):
//   manual  käyttäjä kirjasi minuutit
//   timer   käyttäjä käynnisti ja pysäytti ajastimen (started_at/ended_at)
//
// IDEMPOTENSSI: `operationId` tunnistaa kirjaustoiminnon (ajastimen
// pysäytys, tehtävän valmistumisen kirjaus, rutiinin esiintymän kirjaus).
// Sama operaatio tallentuu kerran, vaikka painiketta painettaisiin
// kahdesti tai offline-jono lähettäisi sen uudelleen.
//
// Migraatio 0013 tuo kentät projectId, routineId, occurrenceDate,
// operationId, startedAt ja endedAt kantaan. Ennen sitä ne elävät
// istunnon muistissa (sarakeportti ALIGNMENT_REALITY_FIELDS).

import { isIsoDate } from './task.js';

export const TIME_SOURCE = Object.freeze({ MANUAL: 'manual', TIMER: 'timer' });
export const TIME_SOURCES = Object.freeze(Object.values(TIME_SOURCE));
export const MAX_ENTRY_MINUTES = 1440;
export const MAX_ENTRY_NOTE_LENGTH = 500;
export const MAX_OPERATION_ID_LENGTH = 100;
const OPERATION_ID_PATTERN = /^[A-Za-z0-9:_.-]+$/;

function optionalId(value) {
  return value === null || value === undefined || value === '' ? null : String(value);
}

function optionalTimestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export function isOperationId(value) {
  return typeof value === 'string' && value.length >= 1 && value.length <= MAX_OPERATION_ID_LENGTH
    && OPERATION_ID_PATTERN.test(value);
}

export function normalizeTimeEntry(input = {}) {
  const minutes = Number(input.minutes);
  const note = input.note == null ? null : String(input.note).trim().slice(0, MAX_ENTRY_NOTE_LENGTH) || null;
  const operationId = input.operationId == null ? null : String(input.operationId);
  return {
    id: input.id != null ? String(input.id) : null,
    entryDate: isIsoDate(input.entryDate) ? input.entryDate : null,
    minutes: Number.isFinite(minutes) && typeof input.minutes !== 'boolean' ? Math.round(minutes) : null,
    lifeAreaId: optionalId(input.lifeAreaId),
    goalId: optionalId(input.goalId),
    taskId: optionalId(input.taskId),
    projectId: optionalId(input.projectId),
    routineId: optionalId(input.routineId),
    // Esiintymän päivä on merkityksellinen vain rutiinille. Kun rutiini
    // poistuu (kanta nollaa routine_id:n), päivä ei jää orvoksi.
    occurrenceDate: optionalId(input.routineId) && isIsoDate(input.occurrenceDate) ? input.occurrenceDate : null,
    source: TIME_SOURCES.includes(input.source) ? input.source : TIME_SOURCE.MANUAL,
    operationId: isOperationId(operationId) ? operationId : null,
    startedAt: optionalTimestamp(input.startedAt),
    endedAt: optionalTimestamp(input.endedAt),
    note,
    createdAt: input.createdAt ?? null,
    updatedAt: input.updatedAt ?? null
  };
}

export function validateTimeEntry(entry) {
  const errors = {};
  if (!entry || !entry.entryDate) errors.entryDate = 'Valitse päivä.';
  const minutes = entry?.minutes;
  if (!Number.isInteger(minutes) || minutes <= 0) {
    errors.minutes = 'Anna käytetty aika minuutteina.';
  } else if (minutes > MAX_ENTRY_MINUTES) {
    errors.minutes = 'Yksi kirjaus voi olla enintään 24 tuntia.';
  }
  // Aikaväli joko kokonaan tai ei ollenkaan, eikä lopu ennen alkua
  // (sama sääntö kuin kannassa: time_entries_span_check).
  const hasStart = Boolean(entry?.startedAt);
  const hasEnd = Boolean(entry?.endedAt);
  if (hasStart !== hasEnd) {
    errors.span = 'Aikavälistä puuttuu alku tai loppu.';
  } else if (hasStart && Date.parse(entry.endedAt) < Date.parse(entry.startedAt)) {
    errors.span = 'Aikaväli ei voi loppua ennen alkuaan.';
  }
  if (entry?.occurrenceDate && !entry.routineId) {
    errors.occurrenceDate = 'Esiintymän päivä vaatii rutiinin.';
  }
  return { valid: Object.keys(errors).length === 0, errors };
}

export function entriesInRange(entries = [], fromIso, toIso) {
  return (entries || []).filter(entry =>
    entry && entry.entryDate && entry.entryDate >= fromIso && entry.entryDate <= toIso);
}

/** Onko tämä operaatio jo kirjattu? Idempotenssin paikallinen puoli. */
export function entriesForOperation(entries = [], operationId) {
  if (!operationId) return [];
  return (entries || []).filter(entry => entry && entry.operationId
    && (entry.operationId === operationId || entry.operationId.startsWith(operationId + '.')));
}

/** Rutiinin yhden esiintymän kirjaukset (esiintymän identiteetti). */
export function entriesForOccurrence(entries = [], routineId, dateIso) {
  if (!routineId || !dateIso) return [];
  return (entries || []).filter(entry => entry && entry.routineId === routineId
    && (entry.occurrenceDate || entry.entryDate) === dateIso);
}

/** Tehtävän kaikki kirjaukset. */
export function entriesForTask(entries = [], taskId) {
  if (!taskId) return [];
  return (entries || []).filter(entry => entry && entry.taskId === taskId);
}

export function sumMinutes(entries = []) {
  return (entries || []).reduce((sum, entry) =>
    sum + (Number.isInteger(entry?.minutes) && entry.minutes > 0 ? entry.minutes : 0), 0);
}

/**
 * Deterministiset operaatiotunnisteet. Sama toiminto tuottaa saman
 * tunnisteen, joten kaksoisklikkaus tai uusinta ei tuota toista riviä.
 *
 * Ajastimen pysäytys: `timer:<ajastimen id>`; jos ajastus jaetaan
 * keskiyön kohdalta usealle päivälle, osat ovat `timer:<id>.<n>`.
 */
export const OPERATION = Object.freeze({
  timer: timerId => `timer:${timerId}`,
  taskCompletion: (taskId, token) => `task-done:${taskId}:${token}`,
  routineOccurrence: (routineId, dateIso) => `routine:${routineId}:${dateIso}`
});
