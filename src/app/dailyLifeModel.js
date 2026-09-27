// Arjen johdetut tiedot tilasta: päivän lähdöt, ensimmäinen sitoumus,
// aamusuunnitelma ja unirytmi.
//
// YKSI LASKENTAPOLKU. Tänään-näkymä, kalenteri, herätyksen ja muistutusten
// ajastus, lähdön uudelleentarkistus ja illan huomautukset kysyvät nämä
// täältä, jotta sama meno ei saa kahta eri lähtöaikaa kahdessa paikassa.
//
// Kaikki aikalaskenta saa laitteen vyöhykkeen (deviceTime.js): yksi
// aikamalli, ei kovakoodattua maata. Kello ja tila annetaan parametreina,
// joten funktiot ovat testattavissa ilman selainta.

import { getState, currentLifeSettings } from './state.js';
import { deviceOffsetMinutes } from './deviceTime.js';
import { expandEventOccurrences } from '../domain/calendar.js';
import { planDeparture, selectTravelEstimate } from '../domain/departure.js';
import { summarizeCommute } from '../domain/commuteLearning.js';
import { sleepScheduleFor } from '../domain/sleepRhythm.js';
import { planMorning } from '../domain/morningPlanner.js';
import { fmtISO, addDays, parseISO } from '../lib/datetime.js';

/** Paikallinen päivä ja minuutit hetkestä `now` (Date). */
export function clockOf(now = new Date()) {
  return { todayIso: fmtISO(now), nowMinutes: now.getHours() * 60 + now.getMinutes(), nowMs: now.getTime() };
}

/** ISO-päivä + n päivää (kalenterilasku, kesäaikaturvallinen). */
export function shiftIso(dateIso, days) {
  return fmtISO(addDays(parseISO(dateIso), days));
}

function indexById(list) {
  const map = new Map();
  for (const item of list || []) if (item && item.id) map.set(item.id, item);
  return map;
}

/** Paikan opittu matka-aika (vain jos käyttäjä on hyväksynyt oppimisen). */
function learnedFor(place, observations) {
  if (!place || place.useLearned !== true) return null;
  const summary = summarizeCommute(observations, { placeId: place.id });
  return summary && summary.count > 0 ? summary : null;
}

/**
 * Päivän menot, joilla on kellonaika, ja niiden lähtösuunnitelmat.
 *
 * @param {string} dateIso
 * @param {{state?:object, now?:Date, providerResults?:Map<string,object>}} [options]
 * @returns {Array<{occurrence:object, event:object|null, place:object|null, departure:object}>}
 */
export function departuresOn(dateIso, { state = getState(), now = new Date(), providerResults = null } = {}) {
  const settings = currentLifeSettings(state);
  const events = indexById(state.calendarEvents);
  const places = indexById(state.savedPlaces);
  const clock = clockOf(now);
  const occurrences = expandEventOccurrences({ events: state.calendarEvents || [], from: dateIso, to: dateIso });
  const result = [];
  for (const occurrence of occurrences) {
    if (occurrence.allDay || !occurrence.time) continue;
    const event = events.get(occurrence.eventId) || null;
    const place = occurrence.placeId ? places.get(occurrence.placeId) || null : null;
    const estimate = selectTravelEstimate({
      event: event || {}, place: place || {},
      learned: learnedFor(place, state.commuteObservations),
      providerResult: providerResults ? providerResults.get(occurrence.id) ?? null : null,
      nowMs: clock.nowMs
    });
    const departure = planDeparture({
      occurrence, event, place, settings, estimate,
      todayIso: clock.todayIso, nowMinutes: clock.nowMinutes,
      offsetMinutesFn: deviceOffsetMinutes
    });
    result.push({ occurrence, event, place, departure });
  }
  return result;
}

/**
 * Päivän ensimmäinen kova sitoumus aamusuunnittelijalle: aikaisin meno,
 * jolla on paikka tai kellonaika. Lähtö ja valmistautuminen mukaan, jos
 * matka-aika tiedetään; muuten vain alkuaika (tuntematonta ei arvata).
 */
export function firstCommitmentOn(dateIso, options = {}) {
  const departures = departuresOn(dateIso, options)
    .filter(item => item.occurrence.time)
    .sort((a, b) => a.occurrence.time.localeCompare(b.occurrence.time));
  const first = departures[0];
  if (!first) return null;
  const known = first.departure && first.departure.known;
  return {
    title: first.occurrence.title,
    startTime: first.occurrence.time,
    leaveTime: known && first.departure.leave && first.departure.leave.date === dateIso ? first.departure.leave.time : null,
    prepareStart: known && first.departure.prepareStart && first.departure.prepareStart.date === dateIso
      ? first.departure.prepareStart.time : null,
    occurrenceId: first.occurrence.id
  };
}

/**
 * Aamusuunnitelma päivälle (ensimmäinen sitoumus + aamurutiini + uni).
 *
 * Valinnaiset `wakeTimeLimit` ('HH:MM', aikaisin herätys ilman käyttäjän
 * valintaa, esim. jo mennyt hetki) ja `steps` (tämän aamun oma vaihejoukko)
 * kulkevat suoraan aamusuunnittelijalle: Tänään-näkymän valinnat lasketaan
 * samaa polkua, eivät omalla laskennallaan.
 */
export function morningPlanOn(dateIso, options = {}) {
  const state = options.state || getState();
  const settings = currentLifeSettings(state);
  const commitment = firstCommitmentOn(dateIso, options);
  return planMorning({
    dateIso, firstCommitment: commitment, profile: state.profile || {}, settings,
    wakeTimeLimit: options.wakeTimeLimit ?? null,
    steps: Array.isArray(options.steps) ? options.steps : undefined,
    offsetMinutesFn: deviceOffsetMinutes
  });
}

/** Unirytmi päivälle: herätys (tarvittaessa aikaisempi), nukkumaanmeno ja iltarauhoittuminen. */
export function sleepScheduleOn(dateIso, options = {}) {
  const state = options.state || getState();
  const settings = currentLifeSettings(state);
  const plan = morningPlanOn(dateIso, options);
  const requiredWake = plan && plan.requiredWakeTime && plan.earlierThanUsualMinutes > 0 ? plan.requiredWakeTime : null;
  return sleepScheduleFor({
    dateIso, profile: state.profile || {}, settings, requiredWake, offsetMinutesFn: deviceOffsetMinutes
  });
}
