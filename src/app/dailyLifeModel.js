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
import { calendarInputs, departureForOccurrence, morningFor, sleepPlanFor } from './calendarPlan.js';
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
  return departureItems(dateIso, { state, now, providerResults }, occurrence => occurrence.date === dateIso);
}

/**
 * Lähdöt, jotka osuvat päivälle: päivän omat menot SEKÄ seuraavan päivän
 * menot, joiden lähtö tai valmistautuminen alkaa jo tänään.
 *
 * MIKSI. Meno klo 00.20, jonne on 40 min matka, vaatii lähdön edellisenä
 * iltana klo 23.30. Pelkät päivän omat menot katsova kierros ei näkisi
 * sitä ennen keskiyötä, ja ensimmäinen merkintä olisi "myöhässä".
 * Lähtökierros (departureWatch) käyttää tätä; Tänään-näkymän päivän menot
 * tulevat edelleen departuresOn-funktiosta.
 *
 * @param {string} dateIso
 * @param {{state?:object, now?:Date, providerResults?:Map<string,object>}} [options]
 * @returns {Array<{occurrence:object, place:object|null, departure:object|null}>}
 */
export function departuresLeavingOn(dateIso, { state = getState(), now = new Date(), providerResults = null } = {}) {
  const tomorrow = shiftIso(dateIso, 1);
  const startsToday = point => Boolean(point) && point.date === dateIso;
  return departureItems(dateIso, { state, now, providerResults }, (occurrence, departure) => {
    if (occurrence.date === dateIso) return true;
    return occurrence.date === tomorrow && Boolean(departure) && departure.known === true
      && (startsToday(departure.leave) || startsToday(departure.prepareStart));
  });
}

/**
 * Yhteinen runko: laskentasyötteet calendarPlanista, liikennetieto
 * mukaan (jos annettu) ja valinta `accept(esiintymä, lähtö)`.
 */
function departureItems(dateIso, { state, now, providerResults }, accept) {
  const { clock, inputs } = inputsOn(dateIso, state, now);
  const places = new Map((state.savedPlaces || []).map(place => [place.id, place]));
  const settings = currentLifeSettings(state);
  const result = [];
  for (const occurrence of inputs.occurrences) {
    if (occurrence.date < dateIso || occurrence.allDay || !occurrence.time || occurrence.continuation) continue;
    let departure = inputs.departures.get(occurrence.id) || null;
    const providerResult = providerResults ? providerResults.get(occurrence.id) ?? null : null;
    if (departure && providerResult) {
      departure = departureForOccurrence(occurrence, {
        placesById: places, observations: state.commuteObservations || [], settings,
        todayIso: clock.todayIso, nowMinutes: clock.nowMinutes, offsetMinutesFn: deviceOffsetMinutes,
        providerResult, nowMs: clock.nowMs
      });
    }
    if (!accept(occurrence, departure)) continue;
    const place = occurrence.placeId ? places.get(occurrence.placeId) || null : null;
    result.push({ occurrence, place, departure });
  }
  return result;
}

/**
 * Aamun sitoumus, aamusuunnitelma ja vaadittu herätys päivälle. Herätyksen
 * sääntö (kiinteä aika, kirjatun nukkumaanmenon raja) on mukana, kuten
 * laitteen herätyksessä: sleepLogs kulkee calendarPlanille.
 */
function morningOn(dateIso, { state = getState(), now = new Date(), wakeTimeLimit = null, steps } = {}) {
  const { inputs } = inputsOn(dateIso, state, now);
  return morningFor({
    wakeDate: dateIso, occurrences: inputs.occurrences, departures: inputs.departures,
    profile: state.profile || null, settings: currentLifeSettings(state), sleepLogs: state.sleepLogs || [],
    offsetMinutesFn: deviceOffsetMinutes, wakeTimeLimit, steps
  });
}

/**
 * Päivän ensimmäinen kova sitoumus aamusuunnittelijalle (sama kuin
 * herätyksessä ja unilohkoissa). Tuntematonta matka-aikaa ei arvata.
 */
export function firstCommitmentOn(dateIso, options = {}) {
  return morningOn(dateIso, options).commitment || null;
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
  return morningOn(dateIso, options).morning || null;
}

/**
 * Herätyspäivän unirytmi, sen vertailukohta (sama päivä ilman menoa),
 * aamu ja herätyksen sääntö calendarPlan.sleepPlanForista: sama laskenta
 * kuin kalenterin unilohkoissa ja laitteen herätyksessä. Huominen-kortti ja
 * illan ennakko vertaavat `schedule`a `usual`iin, joten kiinteä herätys ei
 * ole joka ilta "tavallista aiemmin", ja `alarmNote` kertoo, jos kiinteä
 * herätys ei riitä aamulle.
 */
export function sleepPlanOn(dateIso, options = {}) {
  const state = options.state || getState();
  const { inputs } = inputsOn(dateIso, state, options.now || new Date());
  return sleepPlanFor({
    wakeDate: dateIso, occurrences: inputs.occurrences, departures: inputs.departures,
    profile: state.profile || null, settings: currentLifeSettings(state), sleepLogs: state.sleepLogs || [],
    offsetMinutesFn: deviceOffsetMinutes
  });
}

/** Unirytmi päivälle: herätys (tarvittaessa aikaisempi tai kiinteä), nukkumaanmeno ja iltarauhoittuminen. */
export function sleepScheduleOn(dateIso, options = {}) {
  return sleepPlanOn(dateIso, options).schedule;
}
