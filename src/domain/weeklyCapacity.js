// Viikkokapasiteetti: "paljonko realistisesti ehdin tällä viikolla?"
//
// Puhdas moduuli: ei DOM:ia, ei verkkoa, ei kelloa.
//
// TÄMÄ EI OLE VALVEILLAOLOAIKA. Kapasiteetti on se aika, jonka käyttäjä
// arvioi voivansa käyttää suunniteltuun tekemiseen (työ, perhe-ajan
// varaukset, harjoitukset...) kun nukkuminen, ruoka, siirtymät ja
// odottamattomat asiat on vähennetty. Siksi arvo on käyttäjän oma, ei
// laskettu: sovellus ei tiedä tätä paremmin.
//
// FANTASIASUUNNITTELUN ESTO: yli REALISTIC_WEEK_MINUTES menevä arvo on
// sallittu mutta tuottaa varoituksen (capacityWarnings), ei virhettä.

import { addDaysIso, weekdayOfIso } from './fiTemporal.js';
import { isIsoDate } from './task.js';
import { MINUTES_PER_WEEK } from './lifeArea.js';

/** 60 h viikossa suunniteltua tekemistä. Yli tämän on harvoin realistista. */
export const REALISTIC_WEEK_MINUTES = 60 * 60;
export const MAX_NOTE_LENGTH = 500;

/** Viikon maanantai annetulle päivälle. Kesäaika ei vaikuta (päivälaskenta). */
export function weekStartOf(iso) {
  if (!isIsoDate(iso)) return null;
  return addDaysIso(iso, -(weekdayOfIso(iso) - 1));
}

export function weekDates(weekStart) {
  const monday = weekStartOf(weekStart);
  if (!monday) return [];
  return Array.from({ length: 7 }, (_, index) => addDaysIso(monday, index));
}

export function nextWeekStart(weekStart) {
  const monday = weekStartOf(weekStart);
  return monday ? addDaysIso(monday, 7) : null;
}

function wholeNumber(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : null;
}

export function normalizeWeeklyCapacity(input = {}) {
  const energy = wholeNumber(input.energyLevel);
  const note = input.note == null ? null : String(input.note).trim().slice(0, MAX_NOTE_LENGTH) || null;
  return {
    id: input.id != null ? String(input.id) : null,
    // Mikä tahansa viikon päivä kelpaa syötteeksi; tallennetaan maanantai.
    weekStart: weekStartOf(input.weekStart),
    availableMinutes: wholeNumber(input.availableMinutes),
    energyLevel: energy !== null && energy >= 1 && energy <= 5 ? energy : null,
    note,
    createdAt: input.createdAt ?? null,
    updatedAt: input.updatedAt ?? null
  };
}

export function validateWeeklyCapacity(capacity) {
  const errors = {};
  if (!capacity || !capacity.weekStart) errors.weekStart = 'Viikko puuttuu.';
  const minutes = capacity?.availableMinutes;
  if (!Number.isInteger(minutes)) {
    errors.availableMinutes = 'Anna viikon käytettävissä oleva aika.';
  } else if (minutes < 0 || minutes > MINUTES_PER_WEEK) {
    errors.availableMinutes = 'Aika on 0–168 tuntia viikossa.';
  }
  return { valid: Object.keys(errors).length === 0, errors };
}

/**
 * Varoitukset, jotka eivät estä tallennusta. Käyttäjä saa päättää, mutta
 * sovellus ei myötäile epärealistista suunnitelmaa hiljaa.
 *
 * @param {object} capacity
 * @param {{previousActualMinutes?: number|null}} [context]
 * @returns {string[]} koodit: 'unrealistic' | 'above_previous_actual'
 */
export function capacityWarnings(capacity, { previousActualMinutes = null } = {}) {
  const warnings = [];
  const minutes = capacity?.availableMinutes;
  if (!Number.isInteger(minutes)) return warnings;
  if (minutes > REALISTIC_WEEK_MINUTES) warnings.push('unrealistic');
  // Kaksinkertainen edellisen viikon kirjattuun toteumaan nähden: arvio
  // ei perustu kokemukseen. Vain jos toteumaa on kirjattu (> 0).
  if (Number.isFinite(previousActualMinutes) && previousActualMinutes > 0
      && minutes > previousActualMinutes * 2) {
    warnings.push('above_previous_actual');
  }
  return warnings;
}

export function capacityForWeek(capacities = [], weekStart) {
  const monday = weekStartOf(weekStart);
  return (capacities || []).find(entry => entry && entry.weekStart === monday) || null;
}
