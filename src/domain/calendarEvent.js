// Kalenterin menot ja sitoumukset.
//
// PUHDAS MODUULI: ei kelloa, ei DOM:ia, ei verkkoa.
//
// MENO EI OLE TEHTÄVÄ. Tehtävä on tehtävä asia; meno on kiinteä kohta
// päivässä (lääkäri, palaveri, harrastus), jolla on paikka ja matka.
// Toistuvan menon ESIINTYMIÄ EI TALLENNETA: ne lasketaan ensimmäisestä
// päivästä, viikonpäivistä, päättymispäivästä ja ohitetuista päivistä,
// kuten rutiinienkin.
//
// KOKO PÄIVÄ = EI ALKUAIKAA. Kaksi kenttää, jotka voisivat olla
// ristiriidassa, pidetään yhtäpitävinä jo normalisoinnissa (kanta
// valvoo samaa: calendar_events_all_day_check).
//
// Matka-arvot (travelMinutes ym.) ovat TÄMÄN menon omia ohituksia.
// null = ei asetettu (paikan tai asetusten arvo pätee), ei nolla.

import {
  MAX_EVENT_TITLE_LENGTH, MAX_EVENT_NOTES_LENGTH, MAX_SKIP_DATES, MAX_TRAVEL_MINUTES,
  MAX_PREPARATION_MINUTES, MAX_PLACE_ARRIVAL_BUFFER_MINUTES, MAX_OVERHEAD_MINUTES
} from './dailyLife.js';
import { normalizeCategory } from './categories.js';
import { TRAVEL_MODES } from './travel.js';
import {
  idOrNull, textOrNull, requiredText, intOrNull, oneOf, dateOrNull, timeOrNull
} from './entityFields.js';

// Rajat, joita dailyLife.js ei määrittele. Vastaavat migraation 0014
// CHECK-rajoitteita (calendar_events_*_check).
export const MAX_EVENT_CATEGORY_LENGTH = 40;
export const MAX_EVENT_LOCATION_LENGTH = 200;
export const MAX_EVENT_DURATION_MINUTES = 1440;

/** Viikonpäivät 1 (ma) … 7 (su), ilman toistoja, nousevasti. Roska pois. */
function weekdaysOf(value) {
  if (!Array.isArray(value)) return [];
  const days = new Set();
  for (const raw of value) {
    if (typeof raw !== 'number' && typeof raw !== 'string') continue;
    if (typeof raw === 'string' && raw.trim() === '') continue;
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= 7) days.add(n);
  }
  return [...days].sort((a, b) => a - b);
}

/**
 * Ohitetut päivät: kelvolliset ISO-päivät ilman toistoja, nousevasti.
 * Yli rajan menevistä säilytetään MYÖHÄISIMMÄT — vanha ohitus ei enää
 * vaikuta mihinkään, tuleva vaikuttaa.
 */
function skipDatesOf(value) {
  if (!Array.isArray(value)) return [];
  const dates = [...new Set(value.filter(entry => dateOrNull(entry) !== null))].sort();
  return dates.length > MAX_SKIP_DATES ? dates.slice(dates.length - MAX_SKIP_DATES) : dates;
}

/**
 * Normalisoi meno. Ei heitä; roska -> null tai oletus.
 *
 * `date` on ensimmäinen (tai ainoa) esiintymä. Kertaluonteisella menolla
 * (`recurrenceWeekdays` tyhjä) ei ole päättymispäivää.
 */
export function normalizeCalendarEvent(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const allDay = source.allDay === true || timeOrNull(source.startTime) === null;
  const startTime = allDay ? null : timeOrNull(source.startTime);
  const recurrenceWeekdays = weekdaysOf(source.recurrenceWeekdays);
  return {
    id: idOrNull(source.id),
    title: requiredText(source.title, MAX_EVENT_TITLE_LENGTH),
    date: dateOrNull(source.date),
    startTime,
    // Loppuaika ilman alkuaikaa ei kerro mitään (kanta: end_time_check).
    endTime: startTime === null ? null : timeOrNull(source.endTime),
    durationMinutes: intOrNull(source.durationMinutes, 1, MAX_EVENT_DURATION_MINUTES),
    allDay,
    category: normalizeCategory(source.category),
    locationText: textOrNull(source.locationText, MAX_EVENT_LOCATION_LENGTH),
    placeId: idOrNull(source.placeId),
    travelMode: oneOf(source.travelMode, TRAVEL_MODES, null),
    travelMinutes: intOrNull(source.travelMinutes, 1, MAX_TRAVEL_MINUTES),
    preparationMinutes: intOrNull(source.preparationMinutes, 0, MAX_PREPARATION_MINUTES),
    arrivalBufferMinutes: intOrNull(source.arrivalBufferMinutes, 0, MAX_PLACE_ARRIVAL_BUFFER_MINUTES),
    overheadMinutes: intOrNull(source.overheadMinutes, 0, MAX_OVERHEAD_MINUTES),
    recurrenceWeekdays,
    recurrenceUntil: recurrenceWeekdays.length > 0 ? dateOrNull(source.recurrenceUntil) : null,
    skipDates: skipDatesOf(source.skipDates),
    goalId: idOrNull(source.goalId),
    notes: textOrNull(source.notes, MAX_EVENT_NOTES_LENGTH),
    createdAt: source.createdAt ?? null,
    updatedAt: source.updatedAt ?? null
  };
}

/** Toistuuko meno viikoittain? */
export function isRecurringEvent(event) {
  return Boolean(event) && Array.isArray(event.recurrenceWeekdays) && event.recurrenceWeekdays.length > 0;
}

/**
 * Meno, jonka yksi esiintymä on ohitettu. Palauttaa UUDEN normalisoidun
 * menon; alkuperäistä ei muuteta. Kelvoton päivä -> meno ennallaan.
 */
export function withSkipDate(event, dateIso) {
  const normalized = normalizeCalendarEvent(event);
  if (dateOrNull(dateIso) === null || normalized.skipDates.includes(dateIso)) return normalized;
  return normalizeCalendarEvent({ ...normalized, skipDates: [...normalized.skipDates, dateIso] });
}

/**
 * Tarkista meno.
 * @returns {{valid: boolean, errors: Record<string, string>}}
 */
export function validateCalendarEvent(event) {
  const errors = {};
  if (!event || typeof event !== 'object') return { valid: false, errors: { event: 'Menoa ei ole.' } };
  if (!event.title) errors.title = 'Anna menolle nimi.';
  else if (event.title.length > MAX_EVENT_TITLE_LENGTH) {
    errors.title = `Nimi on liian pitkä (enintään ${MAX_EVENT_TITLE_LENGTH} merkkiä).`;
  }
  if (!dateOrNull(event.date)) errors.date = 'Valitse päivä.';
  if (event.allDay !== (event.startTime === null || event.startTime === undefined)) {
    errors.startTime = 'Koko päivän menolla ei ole kellonaikaa.';
  }
  if (event.startTime && event.endTime && event.startTime === event.endTime) {
    errors.endTime = 'Loppuaika on sama kuin alkuaika.';
  }
  if (event.recurrenceUntil && event.date && event.recurrenceUntil < event.date) {
    errors.recurrenceUntil = 'Toisto ei voi päättyä ennen ensimmäistä kertaa.';
  }
  if (Array.isArray(event.skipDates) && event.skipDates.length > MAX_SKIP_DATES) {
    errors.skipDates = `Ohitettuja päiviä voi olla enintään ${MAX_SKIP_DATES}.`;
  }
  if (event.notes && event.notes.length > MAX_EVENT_NOTES_LENGTH) {
    errors.notes = `Lisätiedot ovat liian pitkät (enintään ${MAX_EVENT_NOTES_LENGTH} merkkiä).`;
  }
  return { valid: Object.keys(errors).length === 0, errors };
}
