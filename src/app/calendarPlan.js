// Kalenterin laskentasyötteet sovelluskerrokselle: menojen esiintymät,
// lähtösuunnitelmat, suojatut lohkot ja uni YHDESTÄ paikasta.
//
// MIKSI OMA MODUULI
//
// Kalenterin päivänäkymä, Tänään-näkymä ja muistutukset kysyvät saman
// asian: mitä päivässä on ja milloin pitää lähteä. Jos jokainen näkymä
// laskisi lähdön itse, sama meno voisi saada kaksi eri lähtöaikaa. Tämä
// moduuli on se yksi paikka, josta puhtaat moottorit (calendar.js,
// departure.js, calendarBlocks.js, sleepRhythm.js, morningPlanner.js,
// scheduler.js) saavat tilasta samat syötteet ja LAITTEEN aikavyöhykkeen
// (deviceTime.js, yksi aikamalli: src/domain/wallClock.js).
//
// MATKA-AIKAA EI KEKSITÄ. Liikennetietoa ei tässä ole: matka-aika tulee
// menon omasta arviosta, paikan tavallisesta ajasta tai omista matkoista
// opitusta (vain kun käyttäjä on hyväksynyt oppimisen paikalle). Ilman
// niitä lähtöä ei lasketa eikä matkalle varata lohkoa.
//
// UNI ON SUOJATTU. Herätys on profiilin oletus, ellei aamun meno vaadi
// aiempaa; nukkumaanmeno lasketaan herätyksestä taaksepäin. Unta ei
// lyhennetä automaattisesti: aiempi herätys siirtää nukkumaanmenoa.
//
// Ei DOM:ia eikä kirjoituksia. Tämä päivä, kellonaika ja vyöhyke annetaan
// parametreina, jotta tulos on toistettava.

import { expandEventOccurrences, addDaysToIso } from '../domain/calendar.js';
import { deriveBlocks } from '../domain/calendarBlocks.js';
import { planDeparture, selectTravelEstimate } from '../domain/departure.js';
import { minusMinutes } from '../domain/travel.js';
import { summarizeCommute } from '../domain/commuteLearning.js';
import { sleepScheduleFor } from '../domain/sleepRhythm.js';
import { morningOfDay } from '../domain/alarmPlan.js';
import { buildDayPlan } from '../domain/scheduler.js';
import { isIsoDate, isTimeOfDay } from '../domain/task.js';
import { currentLifeSettings } from './state.js';
import { deviceOffsetMinutes } from './deviceTime.js';

const EMPTY = Object.freeze([]);

/** Pisin väli, jolle lohkot lasketaan kerralla (kuukausinäkymä ei tarvitse lohkoja). */
export const MAX_BLOCK_RANGE_DAYS = 14;

function listOf(value) {
  return Array.isArray(value) ? value : EMPTY;
}

/**
 * Tarvitseeko esiintymä lähtöä: ajallinen meno, jolla on paikka, paikan
 * nimi tai oma matka-arvio. Koko päivän menolle ja edellisenä päivänä
 * alkaneen menon loppuosalle lähtöä ei lasketa.
 */
export function needsDeparture(occurrence) {
  if (!occurrence || typeof occurrence !== 'object') return false;
  if (occurrence.allDay === true || occurrence.continuation === true) return false;
  if (!isTimeOfDay(occurrence.time)) return false;
  return occurrence.hasPlace === true || Number.isInteger(occurrence.travelMinutes);
}

/**
 * Lähtösuunnitelma yhdelle esiintymälle (departure.planDeparture).
 *
 * Opittu kesto otetaan mukaan vain, kun käyttäjä on hyväksynyt oppimisen
 * paikalle (place.useLearned); departure.selectTravelEstimate vaatii lisäksi
 * vähintään kolme matkaa.
 */
export function departureForOccurrence(occurrence, {
  placesById = new Map(), observations = EMPTY, settings = null,
  todayIso = null, nowMinutes = null, offsetMinutesFn = deviceOffsetMinutes,
  // Liikennetieto (routing.js), jos sellainen joskus on: käytetään vain
  // tuoreena ja tarkistettuna (selectTravelEstimate). Oletuksena ei ole.
  providerResult = null, nowMs = null
} = {}) {
  const place = occurrence && occurrence.placeId ? placesById.get(occurrence.placeId) || null : null;
  const learned = place && place.useLearned === true
    ? summarizeCommute(listOf(observations), { placeId: place.id })
    : null;
  const estimate = selectTravelEstimate({
    event: { travelMinutes: occurrence ? occurrence.travelMinutes : null },
    place,
    learned,
    providerResult,
    nowMs
  });
  return planDeparture({ occurrence, place, settings, estimate, todayIso, nowMinutes, offsetMinutesFn });
}

/**
 * Lähtösuunnitelma lohkomoottorin muotoon (calendarBlocks.eventBlocks).
 * Tuntematon matka-aika -> { known: false }: lohkoja ei synny.
 *
 * Perilläolo ja matkan loppu annetaan lähtömoottorin seinäkellohetkinä
 * samalla vyöhykkeellä kuin lähtö: kesäaikaan siirtymisen yönä "lähtö +
 * matka" seinäkellolla jättäisi matkan loppumaan tuntia liian aikaisin, ja
 * väliin syntyisi keksitty "Olet perillä 60 min ennen alkua" -lohko.
 */
export function departureBlockInput(plan, offsetMinutesFn = deviceOffsetMinutes) {
  if (!plan || plan.known !== true || !plan.leave || !plan.prepareStart || !plan.eventStart) {
    return { known: false };
  }
  const arrivalAbs = plan.arrivalTarget ? plan.arrivalTarget.abs : null;
  return {
    known: true,
    startAbs: plan.eventStart.abs,
    leaveAbs: plan.leave.abs,
    prepareStartAbs: plan.prepareStart.abs,
    travelMinutes: plan.parts.travel,
    overheadMinutes: plan.parts.overhead,
    earlyMinutes: plan.parts.early,
    arrivalAbs,
    travelEndAbs: arrivalAbs === null ? null : minusMinutes(arrivalAbs, plan.parts.overhead || 0, offsetMinutesFn)
  };
}

/**
 * Menot aamun sitoumuksiksi (alarmPlan.morningOfDay).
 * Meno ilman paikkaa ja matkaa alkaa siellä missä olet: lähtö = alku.
 * Paikallinen meno ilman matka-aikaa jättää lähdön tuntemattomaksi, jolloin
 * aamusuunnitelma käyttää profiilin matka-aikaa ja sanoo sen ääneen.
 */
function commitmentsOn(occurrences, dateIso, departures) {
  const list = [];
  for (const occurrence of occurrences) {
    if (occurrence.date !== dateIso || occurrence.allDay === true || occurrence.continuation === true) continue;
    if (!isTimeOfDay(occurrence.time)) continue;
    const plan = departures.get(occurrence.id) || null;
    let leaveTime = null;
    let prepareStart = null;
    if (plan && plan.known === true) {
      leaveTime = plan.leave.time;
      prepareStart = plan.parts.preparation > 0 ? plan.prepareStart.time : null;
    } else if (!needsDeparture(occurrence)) {
      leaveTime = occurrence.time;
    }
    list.push({
      id: occurrence.id, title: occurrence.title, startTime: occurrence.time, leaveTime, prepareStart,
      category: occurrence.category
    });
  }
  return list;
}

/**
 * Päivän aamun sitoumus ja sitä vastaava aamusuunnitelma
 * (alarmPlan.morningOfDay). Sama logiikka kuin unilohkoissa ja
 * herätyksessä, jotta kalenteri, Tänään, herätys ja illan ennakko ovat
 * samaa mieltä. Keskiyön jälkeinen meno, jonka aamu alkaisi jo edellisenä
 * iltana, ei ole aamun sitoumus: valinta siirtyy seuraavaan menoon.
 *
 * Valinnaiset `wakeTimeLimit` (aikaisin sallittu herätys, esim. jo mennyt
 * hetki) ja `steps` (tämän aamun oma vaihejoukko) kulkevat suoraan
 * aamusuunnittelijalle: Tänään-näkymän aamuvalinnat lasketaan tätä samaa
 * polkua. Herätyksen ja unilohkojen kutsut eivät anna niitä.
 *
 * @returns {{commitment:object|null, morning:object|null, requiredWake:string|null}}
 */
export function morningFor({
  wakeDate, occurrences = EMPTY, departures = new Map(), profile = null, settings = null,
  offsetMinutesFn = deviceOffsetMinutes, wakeTimeLimit = null, steps = undefined
} = {}) {
  if (!isIsoDate(wakeDate)) return { commitment: null, morning: null, requiredWake: null };
  const { commitment, plan: morning } = morningOfDay({
    dateIso: wakeDate, commitments: commitmentsOn(listOf(occurrences), wakeDate, departures), profile, settings,
    offsetMinutesFn, wakeTimeLimit, steps: Array.isArray(steps) ? steps : undefined
  });
  // Varmistus: herätys edellisen päivän puolella ei ole tämän yön herätys
  // (morningOfDay ohittaa jo sellaiset menot), joten silloin tavallinen rytmi.
  const requiredWake = morning && morning.wakeDate === wakeDate ? morning.wakeTime : null;
  return { commitment, morning, requiredWake };
}

/**
 * Unen ja iltarauhoittumisen aikataulut herätyspäiville (calendarBlocks.sleepBlocks).
 *
 * Jokainen herätyspäivä tuottaa yön, joka alkaa EDELLISENÄ iltana. Herätys
 * on sleepScheduleFor-oletus, ellei aamun ensimmäinen meno (morningPlanner)
 * vaadi aiempaa.
 */
export function sleepSchedulesFor({
  wakeDates = EMPTY, occurrences = EMPTY, departures = new Map(), profile = null, settings = null,
  offsetMinutesFn = deviceOffsetMinutes
} = {}) {
  const schedules = [];
  for (const wakeDate of listOf(wakeDates)) {
    if (!isIsoDate(wakeDate)) continue;
    const { requiredWake } = morningFor({ wakeDate, occurrences, departures, profile, settings, offsetMinutesFn });
    const schedule = sleepScheduleFor({ dateIso: wakeDate, profile, settings, requiredWake, offsetMinutesFn });
    const evening = addDaysToIso(wakeDate, -1);
    if (!schedule || !evening) continue;
    schedules.push(Object.freeze({
      date: evening,
      wakeDate,
      bedtime: schedule.bedtime,
      wakeTime: schedule.wakeTime,
      windDownMinutes: schedule.windDownMinutes,
      reason: schedule.reason
    }));
  }
  return Object.freeze(schedules);
}

const EMPTY_INPUTS = Object.freeze({
  occurrences: EMPTY, departures: new Map(), blocks: EMPTY, sleepSchedules: EMPTY
});

/**
 * Kalenterin syötteet välille [from, to].
 *
 * Esiintymät lasketaan päivää laajemmin: edellinen päivä keskiyön yli
 * jatkuvia menoja varten ja seuraava päivä, koska aamun meno voi vaatia
 * valmistautumisen ja matkan jo edellisenä iltana ja koska illan uni
 * riippuu seuraavan aamun herätyksestä.
 *
 * @param {object} state getState()
 * @param {object} options
 * @param {string} options.from
 * @param {string} options.to
 * @param {string} [options.todayIso]
 * @param {number} [options.nowMinutes]
 * @param {boolean} [options.withBlocks=true] false: vain esiintymät ja lähdöt
 * @param {Function} [options.offsetMinutesFn] oletuksena laitteen vyöhyke
 * @returns {{occurrences:ReadonlyArray, departures:Map, blocks:ReadonlyArray, sleepSchedules:ReadonlyArray}}
 */
export function calendarInputs(state, {
  from, to, todayIso = null, nowMinutes = null, withBlocks = true, offsetMinutesFn = deviceOffsetMinutes
} = {}) {
  if (!state || !isIsoDate(from) || !isIsoDate(to) || to < from) return EMPTY_INPUTS;
  const expandFrom = addDaysToIso(from, -1) || from;
  const expandTo = addDaysToIso(to, 1) || to;
  const occurrences = expandEventOccurrences({ events: listOf(state.calendarEvents), from: expandFrom, to: expandTo });

  const settings = currentLifeSettings(state);
  const placesById = new Map(listOf(state.savedPlaces).map(place => [place.id, place]));
  const context = {
    placesById, observations: listOf(state.commuteObservations), settings, todayIso, nowMinutes, offsetMinutesFn
  };

  // Edellisenä päivänä alkaneen menon lohkot ovat sen omalla päivällä:
  // lohkot edeltävät menon alkua. Siksi lähdöt vain välille [from, to + 1].
  const departures = new Map();
  for (const occurrence of occurrences) {
    if (occurrence.date < from || !needsDeparture(occurrence)) continue;
    departures.set(occurrence.id, departureForOccurrence(occurrence, context));
  }

  if (!withBlocks) return Object.freeze({ occurrences, departures, blocks: EMPTY, sleepSchedules: EMPTY });

  const wakeDates = [];
  for (let date = from; date && date <= expandTo && wakeDates.length <= MAX_BLOCK_RANGE_DAYS; date = addDaysToIso(date, 1)) {
    wakeDates.push(date);
  }
  const sleepSchedules = sleepSchedulesFor({
    wakeDates, occurrences, departures, profile: state.profile, settings, offsetMinutesFn
  });
  const blocks = deriveBlocks({
    occurrences,
    departureFor: occurrence => departureBlockInput(departures.get(occurrence.id), offsetMinutesFn),
    sleepSchedules
  });
  return Object.freeze({ occurrences, departures, blocks, sleepSchedules });
}

/**
 * Yhden päivän suunnitelma kalenterin menoineen ja suojattuine lohkoineen.
 * Sama buildDayPlan kuin Tänään-näkymässä, joten näkymät ovat samaa mieltä.
 *
 * @returns {{plan:object, inputs:object}}
 */
export function calendarDayPlan(state, dateIso, {
  todayIso = null, nowMinutes = null, offsetMinutesFn = deviceOffsetMinutes
} = {}) {
  const inputs = calendarInputs(state, { from: dateIso, to: dateIso, todayIso, offsetMinutesFn });
  const plan = buildDayPlan({
    tasks: listOf(state && state.tasks),
    profile: state ? state.profile : null,
    dateIso,
    nowMinutes,
    routines: listOf(state && state.routines),
    exceptions: listOf(state && state.routineExceptions),
    todayIso,
    events: inputs.occurrences,
    blocks: inputs.blocks
  });
  return { plan, inputs };
}
