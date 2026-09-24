// Toteutunut aika: käyttäjän itse kirjaama.
//
// Puhdas moduuli: ei DOM:ia, ei verkkoa, ei kelloa.
//
// ARVIO EI OLE TOTEUMA. Valmiiksi merkitty tehtävä ei tuota kirjausta,
// eikä tehtävän arvioitua kestoa kopioida tänne. Jos sovellus keksisi
// toteuman suunnitelmasta, "suunniteltu vs. toteutunut" vertaisi
// suunnitelmaa itseensä ja jokainen viikko näyttäisi täydelliseltä.

import { isIsoDate } from './task.js';

export const TIME_SOURCE = Object.freeze({ MANUAL: 'manual' });
export const TIME_SOURCES = Object.freeze(Object.values(TIME_SOURCE));
export const MAX_ENTRY_MINUTES = 1440;
export const MAX_ENTRY_NOTE_LENGTH = 500;

function optionalId(value) {
  return value === null || value === undefined || value === '' ? null : String(value);
}

export function normalizeTimeEntry(input = {}) {
  const minutes = Number(input.minutes);
  const note = input.note == null ? null : String(input.note).trim().slice(0, MAX_ENTRY_NOTE_LENGTH) || null;
  return {
    id: input.id != null ? String(input.id) : null,
    entryDate: isIsoDate(input.entryDate) ? input.entryDate : null,
    minutes: Number.isFinite(minutes) && typeof input.minutes !== 'boolean' ? Math.round(minutes) : null,
    lifeAreaId: optionalId(input.lifeAreaId),
    goalId: optionalId(input.goalId),
    taskId: optionalId(input.taskId),
    source: TIME_SOURCES.includes(input.source) ? input.source : TIME_SOURCE.MANUAL,
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
  return { valid: Object.keys(errors).length === 0, errors };
}

export function entriesInRange(entries = [], fromIso, toIso) {
  return (entries || []).filter(entry =>
    entry && entry.entryDate && entry.entryDate >= fromIso && entry.entryDate <= toIso);
}
