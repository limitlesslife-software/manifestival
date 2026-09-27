// Arjen johdetut tiedot tilasta: päivän lähdöt, ensimmäinen sitoumus,
// aamusuunnitelma ja unirytmi.
//
// YKSI LASKENTAPOLKU. Tämä on ohut julkisivu src/app/calendarPlan.js:n
// päälle: kalenteri, Tänään-näkymä, herätyksen ja muistutusten ajastus,
// lähdön uudelleentarkistus ja illan huomautukset saavat saman lähtöajan,
// saman aamun sitoumuksen ja saman herätyksen samasta koodista.
//
// Kaikki aikalaskenta saa laitteen vyöhykkeen (deviceTime.js): yksi
// aikamalli, ei kovakoodattua maata. Kello ja tila annetaan parametreina,
// joten funktiot ovat testattavissa ilman selainta.

import { getState, currentLifeSettings } from './state.js';
import { deviceOffsetMinutes } from './deviceTime.js';
import { calendarInputs, departureForOccurrence, morningFor } from './calendarPlan.js';
import { sleepScheduleFor } from '../domain/sleepRhythm.js';
import { fmtISO, addDays, parseISO } from '../lib/datetime.js';

/** Paikallinen päivä, minuutit ja hetki (ms) Date-oliosta. */
export function clockOf(now = new Date()) {
  return { todayIso: fmtISO(now), nowMinutes: now.getHours() * 60 + now.getMinutes(), nowMs: now.getTime() };
}

/** ISO-päivä + n päivää (kalenterilasku, kesäaikaturvallinen). */
export function shiftIso(dateIso, days) {
  return fmtISO(addDays(parseISO(dateIso), days));
}

/** Päivän esiintymät ja lähdöt calendarPlanista (ilman lohkoja). */
function inputsOn(dateIso, state, now) {
  const clock = clockOf(now);
  const inputs = calendarInputs(state, {
    from: dateIso, to: dateIso, todayIso: clock.todayIso, nowMinutes: clock.nowMinutes,
    withBlocks: false, offsetMinutesFn: deviceOffsetMinutes
  });
  return { clock, inputs };
}

/**
 * Päivän ajalliset menot ja niiden lähtösuunnitelmat. Menolle, jolla ei ole
 * paikkaa eikä matka-arviota, ei lasketa lähtöä (departure = null).
 *
 * @param {string} dateIso
 * @param {{state?:object, now?:Date, providerResults?:Map<string,object>}} [options]
 *   providerResults: esiintymän tunniste -> reittipalvelun tulos (routing.js)
 * @returns {Array<{occurrence:object, place:object|null, departure:object|null}>}
 */
export function departuresOn(dateIso, { state = getState(), now = new Date(), providerResults = null } = {}) {
  const { clock, inputs } = inputsOn(dateIso, state, now);
  const places = new Map((state.savedPlaces || []).map(place => [place.id, place]));
  const settings = currentLifeSettings(state);
  const result = [];
  for (const occurrence of inputs.occurrences) {
    if (occurrence.date !== dateIso || occurrence.allDay || !occurrence.time || occurrence.continuation) continue;
    let departure = inputs.departures.get(occurrence.id) || null;
    const providerResult = providerResults ? providerResults.get(occurrence.id) ?? null : null;
    if (departure && providerResult) {
      departure = departureForOccurrence(occurrence, {
        placesById: places, observations: state.commuteObservations || [], settings,
        todayIso: clock.todayIso, nowMinutes: clock.nowMinutes, offsetMinutesFn: deviceOffsetMinutes,
        providerResult, nowMs: clock.nowMs
      });
    }
    const place = occurrence.placeId ? places.get(occurrence.placeId) || null : null;
    result.push({ occurrence, place, departure });
  }
  return result;
}

/** Aamun sitoumus, aamusuunnitelma ja vaadittu herätys päivälle. */
function morningOn(dateIso, { state = getState(), now = new Date() } = {}) {
  const { inputs } = inputsOn(dateIso, state, now);
  return morningFor({
    wakeDate: dateIso, occurrences: inputs.occurrences, departures: inputs.departures,
    profile: state.profile || null, settings: currentLifeSettings(state), offsetMinutesFn: deviceOffsetMinutes
  });
}

/**
 * Päivän ensimmäinen kova sitoumus aamusuunnittelijalle (sama kuin
 * herätyksessä ja unilohkoissa). Tuntematonta matka-aikaa ei arvata.
 */
export function firstCommitmentOn(dateIso, options = {}) {
  return morningOn(dateIso, options).commitment || null;
}

/** Aamusuunnitelma päivälle (ensimmäinen sitoumus + aamurutiini + uni). */
export function morningPlanOn(dateIso, options = {}) {
  return morningOn(dateIso, options).morning || null;
}

/** Unirytmi päivälle: herätys (tarvittaessa aikaisempi), nukkumaanmeno ja iltarauhoittuminen. */
export function sleepScheduleOn(dateIso, options = {}) {
  const state = options.state || getState();
  const { requiredWake } = morningOn(dateIso, { ...options, state });
  return sleepScheduleFor({
    dateIso, profile: state.profile || {}, settings: currentLifeSettings(state), requiredWake,
    offsetMinutesFn: deviceOffsetMinutes
  });
}
