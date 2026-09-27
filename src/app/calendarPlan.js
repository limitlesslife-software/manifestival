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
// Käytössä oleva herätys kuuluu samaan laskentaan (alarmPlan.alarmWakeOf):
// "Kiinteä aika" on herätysaika, josta uni lasketaan, ja jos aamu vaatisi
// aiemman, siitä kerrotaan varoituksena (sleepPlanFor.alarmNote).
//
// Ei DOM:ia eikä kirjoituksia. Tämä päivä, kellonaika ja vyöhyke annetaan
// parametreina, jotta tulos on toistettava.

import { expandEventOccurrences, addDaysToIso } from '../domain/calendar.js';
import { deriveBlocks } from '../domain/calendarBlocks.js';
import { planDeparture, selectTravelEstimate } from '../domain/departure.js';
import { minusMinutes } from '../domain/travel.js';
import { summarizeCommute } from '../domain/commuteLearning.js';
import { sleepScheduleFor } from '../domain/sleepRhythm.js';
import { morningOfDay, alarmWakeOf, alarmPlanningLimits, fixedAlarmNote } from '../domain/alarmPlan.js';
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
 * HERÄTYKSEN SÄÄNTÖ (alarmPlan.alarmWakeOf) on mukana: kun herätys on
 * käytössä, aamu lasketaan samoilla rajoilla kuin laitteen herätys.
 * "Kiinteä aika" on herätysaika (aamu ei mahdu -> vaje ja valinnat, ei
 * hiljaista eri herätystä), ja suunnitelmaa seuraava herätys ei aikaistu
 * kirjatun nukkumaanmenon suojaaman unen ohi (`sleepLogs`).
 *
 * Valinnaiset `wakeTimeLimit` ja `steps` (tämän aamun oma vaihejoukko)
 * kulkevat aamusuunnittelijalle: Tänään-näkymän aamuvalinnat lasketaan tätä
 * samaa polkua. `wakeTimeLimit` on aamun TODELLINEN alku (herätyksen
 * kuittaus tai käyttäjän "aloitan vasta nyt"), joten se korvaa herätyksen
 * rajan. Herätyksen ja unilohkojen kutsut eivät anna niitä.
 *
 * @returns {{commitment:object|null, morning:object|null, requiredWake:string|null, alarm:object|null}}
 *   alarm: herätyksen sääntö (null, kun herätys ei ole käytössä)
 */
export function morningFor({
  wakeDate, occurrences = EMPTY, departures = new Map(), profile = null, settings = null,
  sleepLogs = EMPTY, offsetMinutesFn = deviceOffsetMinutes, wakeTimeLimit = null, steps = undefined
} = {}) {
  if (!isIsoDate(wakeDate)) return { commitment: null, morning: null, requiredWake: null, alarm: null };
  const alarm = alarmWakeOf({ dateIso: wakeDate, profile, settings, sleepLogs: listOf(sleepLogs), offsetMinutesFn });
  const limits = alarmPlanningLimits(alarm);
  const { commitment, plan: morning } = morningOfDay({
    dateIso: wakeDate, commitments: commitmentsOn(listOf(occurrences), wakeDate, departures), profile, settings,
    offsetMinutesFn,
    usualWakeTime: limits.usualWakeTime,
    wakeTimeLimit: isTimeOfDay(wakeTimeLimit) ? wakeTimeLimit : limits.wakeTimeLimit,
    steps: Array.isArray(steps) ? steps : undefined
  });
  // Varmistus: herätys edellisen päivän puolella ei ole tämän yön herätys
  // (morningOfDay ohittaa jo sellaiset menot), joten silloin tavallinen rytmi.
  const requiredWake = morning && morning.wakeDate === wakeDate ? morning.wakeTime : null;
  return { commitment, morning, requiredWake, alarm };
}

/**
 * Herätyspäivän unirytmi, sen vertailukohta ja aamu YHDESTÄ paikasta:
 * kalenterin unilohkot, Tänään-näkymän Huominen-kortti, ilta- ja
 * nukkumaanmenomuistutukset, illan ennakko ja maanantaivalmius.
 *
 * - schedule: herätys (kiinteä herätys sellaisenaan; muuten tavallinen,
 *   ellei meno vaadi aiempaa), nukkumaanmeno ja iltarutiini siitä.
 * - usual: sama päivä ilman menoa. Käyttäjän oma herätysaika (herätyksen
 *   arki-/viikonloppuaika) on tavallinen herätys, joten kiinteä 6.00 ei
 *   ole joka ilta "tavallista aiemmin".
 * - alarmNote: kiinteän herätyksen varoitus, kun aamu vaatisi aiemman.
 *
 * @returns {{schedule:object|null, usual:object|null, morning:object|null,
 *   commitment:object|null, alarm:object|null, alarmNote:string|null}}
 */
export function sleepPlanFor({
  wakeDate, occurrences = EMPTY, departures = new Map(), profile = null, settings = null,
  sleepLogs = EMPTY, offsetMinutesFn = deviceOffsetMinutes
} = {}) {
  const { commitment, morning, requiredWake, alarm } = morningFor({
    wakeDate, occurrences, departures, profile, settings, sleepLogs, offsetMinutesFn
  });
  const alarmWakeTime = alarm && alarm.override ? alarm.time : null;
  const common = { dateIso: wakeDate, profile, settings, alarmWakeTime, offsetMinutesFn };
  // Kiinteä herätys ei seuraa menoa: uni lasketaan kiinteästä herätyksestä.
  const schedule = sleepScheduleFor({ ...common, requiredWake: alarm && alarm.fixed ? null : requiredWake });
  const usual = sleepScheduleFor({ ...common, requiredWake: null });
  return { schedule, usual, morning, commitment, alarm, alarmNote: fixedAlarmNote(morning, alarm) };
}

/**
 * Unen ja iltarauhoittumisen aikataulut herätyspäiville (calendarBlocks.sleepBlocks).
 *
 * Jokainen herätyspäivä tuottaa yön, joka alkaa EDELLISENÄ iltana. Herätys
 * on sama kuin laitteen herätyksellä (sleepPlanFor): tavallinen, ellei
 * aamun ensimmäinen meno vaadi aiempaa, tai kiinteä herätysaika.
 */
export function sleepSchedulesFor({
  wakeDates = EMPTY, occurrences = EMPTY, departures = new Map(), profile = null, settings = null,
  sleepLogs = EMPTY, offsetMinutesFn = deviceOffsetMinutes
} = {}) {
  const schedules = [];
  for (const wakeDate of listOf(wakeDates)) {
    if (!isIsoDate(wakeDate)) continue;
    const { schedule } = sleepPlanFor({ wakeDate, occurrences, departures, profile, settings, sleepLogs, offsetMinutesFn });
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
    wakeDates, occurrences, departures, profile: state.profile, settings,
    sleepLogs: listOf(state.sleepLogs), offsetMinutesFn // herätyksen suojatun unen raja
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

const EMPTY_PLANNING = Object.freeze({ events: EMPTY, blocks: EMPTY });

/** Pisin suunnitteluhorisontti jaksoina (capacity.MAX_HORIZON_DAYS = 365). */
const MAX_PLANNING_CHUNKS = Math.ceil(366 / MAX_BLOCK_RANGE_DAYS);

/**
 * Menot ja suojatut lohkot suunnittelulle (Tavoitteesta tekemiseen):
 * tekoälysuunnitelman kapasiteetti, Suunnittelu-näkymän horisontti,
 * myöhästyneiden ilmoitus ja "Ehdota muutoksia".
 *
 * Sama calendarInputs kuin Tänään, Kalenteri ja keskeytykset: kiinteät
 * menot pysyvät kiinteinä, valmistautuminen ja matka ovat varattuja ja
 * suojattu uni on suojattu. Pidempi väli kuin MAX_BLOCK_RANGE_DAYS lasketaan
 * jaksoissa, jotta uni suojataan joka yöltä; jaksojen rajalla sama esiintymä
 * tai lohko on mukana vain kerran (tunnisteet ovat päiväkohtaisia).
 *
 * @returns {{events: ReadonlyArray<object>, blocks: ReadonlyArray<object>}}
 */
export function calendarForPlanning(state, {
  from, to, todayIso = null, nowMinutes = null, offsetMinutesFn = deviceOffsetMinutes
} = {}) {
  if (!state || !isIsoDate(from) || !isIsoDate(to) || to < from) return EMPTY_PLANNING;
  const events = [];
  const blocks = [];
  const seen = new Set();
  const keep = (list, target) => {
    for (const item of list) {
      const key = `${target === events ? 'e' : 'b'}|${item.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      target.push(item);
    }
  };
  let start = from;
  for (let chunk = 0; start && start <= to && chunk < MAX_PLANNING_CHUNKS; chunk += 1) {
    const last = addDaysToIso(start, MAX_BLOCK_RANGE_DAYS - 1);
    const end = last && last < to ? last : to;
    const inputs = calendarInputs(state, { from: start, to: end, todayIso, nowMinutes, offsetMinutesFn });
    keep(inputs.occurrences, events);
    keep(inputs.blocks, blocks);
    start = addDaysToIso(end, 1);
  }
  return Object.freeze({ events: Object.freeze(events), blocks: Object.freeze(blocks) });
}
