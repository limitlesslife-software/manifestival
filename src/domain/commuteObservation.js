// Toteutuneet matkat: käyttäjän kuittaamat lähtö- ja perilläoloajat.
//
// PUHDAS MODUULI: ei kelloa, ei DOM:ia, ei verkkoa.
//
// ⚠ EI SIJAINTIHISTORIAA ⚠
// Havainto syntyy vain käyttäjän eleestä ("Lähdin", "Olin perillä").
// Siinä ei ole reittiä, pisteitä eikä koordinaatteja. Paikkaa kohden
// säilytetään enintään MAX_OBSERVATIONS_PER_PLACE havaintoa (sovellus
// karsii vanhimmat), ja opittua aikaa käytetään vain käyttäjän
// hyväksynnällä (savedPlace.useLearned).
//
// Tuntematon matka-aika on null, ei nolla. `providerMinutes` on
// liikennetiedon arvio lähtöhetkellä, jos sellainen oli — ei keksitty.

import {
  ARRIVAL_RESULTS, OBSERVATION_SOURCE, OBSERVATION_SOURCES, MAX_TRAVEL_MINUTES,
  MAX_PREPARATION_MINUTES, MAX_OVERHEAD_MINUTES, MAX_OBSERVATIONS_PER_PLACE
} from './dailyLife.js';
import { weekdayOfIso } from './fiTemporal.js';
import {
  idOrNull, intOrNull, oneOf, dateOrNull, timeOrNull
} from './entityFields.js';

export { MAX_OBSERVATIONS_PER_PLACE };

/** Menon tunniste ei ole vierasavain (kanta: commute_observations_event_id_check). */
export const MAX_OBSERVATION_EVENT_ID_LENGTH = 100;

/**
 * Normalisoi havainto. Ei heitä; roska -> null tai oletus.
 *
 * Viikonpäivä JOHDETAAN päivästä, kun päivä on tiedossa: kaksi kenttää,
 * jotka voisivat olla ristiriidassa, eivät saa olla.
 */
export function normalizeCommuteObservation(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const observedOn = dateOrNull(source.observedOn);
  return {
    id: idOrNull(source.id),
    placeId: idOrNull(source.placeId),
    eventId: idOrNull(source.eventId, MAX_OBSERVATION_EVENT_ID_LENGTH),
    observedOn,
    weekday: observedOn ? weekdayOfIso(observedOn) : intOrNull(source.weekday, 1, 7),
    plannedDeparture: timeOrNull(source.plannedDeparture),
    actualDeparture: timeOrNull(source.actualDeparture),
    arrivalAt: timeOrNull(source.arrivalAt),
    travelMinutes: intOrNull(source.travelMinutes, 1, MAX_TRAVEL_MINUTES),
    providerMinutes: intOrNull(source.providerMinutes, 1, MAX_TRAVEL_MINUTES),
    preparationMinutes: intOrNull(source.preparationMinutes, 0, MAX_PREPARATION_MINUTES),
    overheadMinutes: intOrNull(source.overheadMinutes, 0, MAX_OVERHEAD_MINUTES),
    arrivalResult: oneOf(source.arrivalResult, ARRIVAL_RESULTS, null),
    source: oneOf(source.source, OBSERVATION_SOURCES, OBSERVATION_SOURCE.USER_CONFIRMED),
    createdAt: source.createdAt ?? null,
    updatedAt: source.updatedAt ?? null
  };
}

/**
 * Tarkista havainto. Havainnossa on oltava jotain havaittua: matka-aika,
 * lähtöaika tai perilläoloaika. Tyhjä havainto ei opeta mitään.
 */
export function validateCommuteObservation(observation) {
  const errors = {};
  if (!observation || typeof observation !== 'object') {
    return { valid: false, errors: { observation: 'Havaintoa ei ole.' } };
  }
  if (!observation.placeId) errors.placeId = 'Paikka puuttuu.';
  if (!dateOrNull(observation.observedOn)) errors.observedOn = 'Päivä puuttuu.';
  if (observation.travelMinutes == null && !observation.actualDeparture && !observation.arrivalAt) {
    errors.observation = 'Kirjaa lähtöaika, perilläoloaika tai matkan kesto.';
  }
  return { valid: Object.keys(errors).length === 0, errors };
}
