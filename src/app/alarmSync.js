// Herätysten ja puhuttujen muistutusten ajastus laitteelle.
//
// =====================================================================
// MITÄ TÄMÄ TEKEE
// =====================================================================
//
// Laskee YHDESTÄ PAIKASTA, mitä arjen muistutuksia seuraaville päiville
// kuuluu, ja jakaa ne kahdelle toteuttajalle:
//
//   ManifestivalAlarm (Android, src/platform/index.js `alarms`)
//     - herätys (alarmPlan.desiredAlarms)
//     - muistutus, jonka toimitustapa puhuu tai voimistuu hälytykseksi
//       (puhe, ääni ja puhe, voimistuva hälytys): ne soivat myös
//       sovelluksen ollessa kiinni ja näyttö lukittuna
//   tavalliset laitteen ilmoitukset (src/app/notifications.js)
//     - kaikki muu: hiljainen, värinä, ääni
//
// Arjen muistutukset: lähtöketju (valmistaudu, 5 min, nyt) kalenterin
// menoista, menon alku (alkaa klo) menoille, joille lähtöketjua ei ole (ei
// paikkaa tai matka-aikaa), iltarauhoittuminen ja nukkumaanmeno, ateriat ja
// tapojen muutoksen seuraava suunniteltu aika. Kaikki kulkevat saman
// toimituspolitiikan läpi (notificationPolicy.applyNotificationPolicy):
// toimitustapa aiheittain, ohjaustyyli, rauhoitusaika, kooste, päiväraja
// ja kuittausloki (kuitattua ei toisteta, torkutettu tulee torkun lopussa).
//
// YKSI PUTKI. Myös perinteiset muistutukset (tehtävä, rutiini, määräaika,
// päivän suunnitelma, illan katsaus, matkan lähtö; legacyReminderIntents)
// kulkevat SAMAN politiikan läpi samassa kutsussa: "Määräajat"- ja
// "Rutiinit"-valinnat pätevät, puheeksi valittu määräaika menee laitteelle,
// kooste yhdistää vähäiset ja päiväraja on yksi yhteinen. Tavalliset
// ilmoitukset (notifications.js) ajastavat tästä vain paikallisen osan.
//
// Lähdöt, aamun sitoumus ja uni tulevat src/app/dailyLifeModel.js:stä:
// sama laskentapolku kuin kalenterissa ja Tänään-näkymässä, joten herätys
// ja muistutus ovat samaa mieltä näkymän kanssa. Aikavyöhyke on AINA
// laitteen oma (deviceTime.deviceOffsetMinutes).
//
// =====================================================================
// MITÄ TÄMÄ EI TEE
// =====================================================================
//
// - Selaimessa herätystä ei ole eikä sitä teeskennellä: synkronointi ei
//   tee mitään ja kertoo sen (ALARMS_WEB_REASON). JS-ajastin EI OLE
//   koskaan herätyksen lähde: se ei soisi suljetussa välilehdessä.
//   (Viiveajastin tässä vain kokoaa peräkkäiset muutokset yhdeksi
//   ajastukseksi; herätyksen hetken päättää laite.)
// - Arjen muistutuksia ei ajasteta, ellei käyttäjä ole kytkenyt
//   muistutuksia päälle (notificationPreferences.enabled). Herätys on oma
//   valintansa (life_settings.alarm.enabled).
// - Uni- ja iltarauhoittumismuistutus vain, kun käyttäjä on tallentanut
//   arjen asetukset: pelkillä oletuksilla ei muistuteta nukkumaanmenosta.
// - Lupia ei kysytä eikä asetusnäkymiä avata: tarkkojen herätysten ja koko
//   näytön ilmoitusten asetukset avataan vain napautuksesta (Profiili → Arki).
//
// =====================================================================
// KILPAILUTILANTEET
// =====================================================================
//
// Laitteelle menevät kutsut (ajastus ja peruutus) ovat SARJASSA: ajastus
// korvaa koko joukon, joten kaksi rinnakkaista ajastusta tai ajastus ja
// uloskirjautumisen peruutus väärässä järjestyksessä jättäisivät laitteelle
// väärän joukon. Joukko lasketaan vasta vuoron tullessa, ja istunto
// tarkistetaan ennen ajastusta. Uloskirjautuminen kesken ajastuksen
// jonottaa peruutuksen sen perään.

import { alarms } from '../platform/index.js';
import { getState, currentLifeSettings } from './state.js';
import { sessionSnapshot, isSameSession } from '../data/session.js';
import { deviceOffsetMinutes, deviceTimeZone } from './deviceTime.js';
import { departuresOn, firstCommitmentOn, sleepScheduleOn, clockOf, shiftIso } from './dailyLifeModel.js';
import { needsDeparture } from './calendarPlan.js';
import { currentAckLog, rememberScheduledTargets } from './alarmEvents.js';
import { desiredAlarms, DEFAULT_ESCALATION } from '../domain/alarmPlan.js';
import { planDepartureChain, planDailyLifeReminders, DAILY_REMINDER_KIND, firstLeaveOn } from '../domain/dailyReminders.js';
import { eveningBeforeAdvice } from './dailyLifeNotices.js';
import { applyNotificationPolicy, resolveGuidanceStyle, scaleLeadMinutes } from '../domain/notificationPolicy.js';
import { normalizePreferences, DEPARTURE_CHAIN_TYPES, DEFAULT_PREFERENCES, planRange } from '../domain/notification.js';
import { expandRoutines } from '../domain/routine.js';
import { ackIndex, entryHandled } from '../domain/notificationAck.js';
import { dailyMealItems, MEAL_ITEM_KIND } from '../domain/mealRhythm.js';
import { status as habitStatus, HABIT_STATE } from '../domain/habitEngine.js';
import { DELIVERY, DELIVERIES, deliverySpeaks, ESCALATION_STEP } from '../domain/dailyLife.js';
import { wallClockToEpoch, epochToWallClock } from '../domain/wallClock.js';
import { isTimeOfDay } from '../domain/task.js';
import { logEvent } from '../lib/logger.js';

/** Kuinka monta päivää eteenpäin (tänään mukaan lukien). Sama kuin tavallisissa muistutuksissa. */
export const ALARM_SYNC_HORIZON_DAYS = 3;

/** Tilamuutokset kootaan yhdeksi ajastukseksi (sama kuin notifications.RESYNC_DEBOUNCE_MS). */
export const ALARM_SYNC_DEBOUNCE_MS = 2000;

/** Laitteen herätysraja (platform/alarms.js ALARM_LIMITS.maxAlarms; testi pitää samana). */
export const NATIVE_ALARM_LIMIT = 50;

/** Laitteen tekstirajat (ALARM_LIMITS). */
const MAX_TITLE = 200;
const MAX_BODY = 500;
const MAX_SPEECH = 500;
const MAX_ID = 120;
const NATIVE_ID = /^[A-Za-z0-9_:.|@#-]+$/;

/** Lähtömuistutuksen torkku: lyhyt, koska lähtö ei odota. */
const DEPARTURE_SNOOZE_MINUTES = 5;
const DEPARTURE_MAX_SNOOZES = 3;

/** Voimistuva lähtöhälytys puheella: ensin puhe, sitten ääni, lopuksi puhe uudelleen. */
const SPOKEN_CRITICAL_ESCALATION = Object.freeze([
  Object.freeze({ afterSeconds: 0, step: ESCALATION_STEP.SPEECH }),
  Object.freeze({ afterSeconds: 30, step: ESCALATION_STEP.LOUD }),
  Object.freeze({ afterSeconds: 90, step: ESCALATION_STEP.REPEAT_SPEECH })
]);

/**
 * Kokoelmat, joiden muutos voi muuttaa herätyksiä tai muistutuksia. Rutiinit
 * ja matkasuunnitelmat kuuluvat mukaan, koska niiden muistutukset kulkevat
 * samaa putkea ja voivat puhua (laitteelle).
 */
export const ALARM_RELEVANT_KEYS = Object.freeze([
  'calendarEvents', 'savedPlaces', 'lifeSettings', 'habitPlans', 'habitEvents', 'profile',
  'commuteObservations', 'tasks', 'sleepLogs', 'notificationPreferences',
  'routines', 'routineExceptions', 'travelPlans'
]);

const EMPTY = Object.freeze([]);
const MINUTE_MS = 60000;

// =====================================================================
// LASKENTA (ei alustaa, ei kirjoituksia)
// =====================================================================

function listOf(value) {
  return Array.isArray(value) ? value : EMPTY;
}

function clip(text, max) {
  if (typeof text !== 'string') return null;
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  const chars = Array.from(clean);
  return chars.length <= max ? clean : `${chars.slice(0, max - 1).join('').trimEnd()}…`;
}

/** Horisontin päivät: tänään ja seuraavat. */
export function horizonDates(todayIso, days = ALARM_SYNC_HORIZON_DAYS) {
  const dates = [];
  for (let index = 0; index < days; index += 1) {
    const date = shiftIso(todayIso, index);
    if (date) dates.push(date);
  }
  return dates;
}

/**
 * Aikomuksen todellinen hetki (ms) ja seinäkelloaika laitteen vyöhykkeessä.
 * Ankkurillinen (lähtöketju) lasketaan ankkurista todellisina minuutteina,
 * joten "5 min ennen lähtöä" on viisi oikeaa minuuttia myös kesäajan yönä.
 */
export function intentMoment(intent, offsetMinutesFn = deviceOffsetMinutes) {
  if (!intent || typeof intent !== 'object') return null;
  const anchor = intent.anchor;
  if (anchor && typeof anchor === 'object' && Number.isInteger(anchor.offsetMinutes)) {
    const base = wallClockToEpoch(anchor.date, anchor.time, offsetMinutesFn);
    if (base) {
      const epochMs = base.epochMs + anchor.offsetMinutes * MINUTE_MS;
      const wall = epochToWallClock(epochMs, offsetMinutesFn);
      if (wall) return { epochMs, date: wall.date, time: wall.time };
    }
  }
  const at = wallClockToEpoch(intent.date, intent.time, offsetMinutesFn);
  return at ? { epochMs: at.epochMs, date: at.date, time: at.time } : null;
}

/**
 * Menon alun ennakko (DAILY_REMINDER_KIND.EVENT_START): sama asetus kuin
 * tehtävän ennakolla (Profiili → Muistutukset, "Tehtävä tai meno", oletus
 * 10 min), ja ohjaustyyli pidentää sitä samoin kuin tehtävillä.
 */
export function eventLeadMinutes(preferences, settings) {
  const value = preferences && typeof preferences === 'object' ? preferences.taskLeadMinutes : null;
  const base = Number.isInteger(value) && value >= 0 ? value : DEFAULT_PREFERENCES.taskLeadMinutes;
  return scaleLeadMinutes(base, resolveGuidanceStyle(null, settings)) ?? base;
}

/**
 * Lähtöketjun syötteet horisontin menoista + lähdön kohde laitteen reittiä
 * varten, sekä MENON ALUN merkinnät menoille, joille lähtöketjua ei ole
 * (ei paikkaa, tai paikka ilman tiedossa olevaa matka-aikaa): muistutus
 * alku − ennakko. Lähtöaikaa ei arvata, eikä alkua kutsuta lähdöksi.
 */
function departureInputs(state, now, dates, leadMinutes = 0) {
  const inputs = [];
  const routes = new Map();
  const starts = [];
  for (const date of dates) {
    let list = EMPTY;
    try {
      list = departuresOn(date, { state, now });
    } catch {
      list = EMPTY;
    }
    for (const { occurrence, place, departure } of list) {
      if (!departure || departure.known !== true || !departure.leave) {
        starts.push({
          kind: DAILY_REMINDER_KIND.EVENT_START, id: occurrence.id, date: occurrence.date, time: occurrence.time,
          leadMinutes, title: occurrence.title, needsTravel: needsDeparture(occurrence)
        });
        continue;
      }
      inputs.push({
        id: occurrence.id,
        date: occurrence.date,
        prepareStart: departure.prepareStart ? { date: departure.prepareStart.date, time: departure.prepareStart.time } : null,
        leave: { date: departure.leave.date, time: departure.leave.time },
        arrivalTarget: departure.arrivalTarget ? { date: departure.arrivalTarget.date, time: departure.arrivalTarget.time } : null,
        eventStart: departure.eventStart ? { date: departure.eventStart.date, time: departure.eventStart.time } : null,
        title: occurrence.title,
        placeName: place ? place.name : occurrence.locationText,
        knownTravel: true
      });
      routes.set(occurrence.id, {
        eventId: occurrence.eventId,
        placeId: place ? place.id : null,
        date: occurrence.date,
        leaveTime: departure.leave.time,
        destination: (place && (place.address || place.name)) || occurrence.locationText || null,
        mode: departure.mode || (place ? place.travelMode : null) || null
      });
    }
  }
  return { inputs, routes, starts };
}

/** Illan ennakko tulee viimeistään tähän aikaan illalla (minuutit keskiyöstä). */
export const EVENING_BEFORE_LATEST_MINUTES = 18 * 60;
/** ... ja vähintään tämän verran ennen (aikaistettua) iltarauhoittumista. */
export const EVENING_BEFORE_LEAD_MINUTES = 60;
const EVENING_BEFORE_EARLIEST_MINUTES = 12 * 60;

/**
 * Illan ennakon hetki illalle `eveningDate`: iltarauhoittumisen alku − 60 min,
 * kuitenkin viimeistään klo 18.00 ja aikaisintaan klo 12.00. Keskiyön
 * jälkeen alkava rauhoittuminen -> klo 18.00.
 */
export function eveningBeforeTime(eveningDate, windDownDate, windDownStart) {
  let minutes = EVENING_BEFORE_LATEST_MINUTES;
  if (windDownDate === eveningDate && isTimeOfDay(windDownStart)) {
    const [hours, mins] = windDownStart.split(':').map(Number);
    minutes = Math.min(minutes, hours * 60 + mins - EVENING_BEFORE_LEAD_MINUTES);
  } else if (typeof windDownDate === 'string' && windDownDate < eveningDate) {
    return null;
  }
  minutes = Math.max(minutes, EVENING_BEFORE_EARLIEST_MINUTES);
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/**
 * Iltarauhoittuminen ja nukkumaanmeno herätyspäiville huomisesta eteenpäin,
 * sekä ILLAN ENNAKKO (DAILY_REMINDER_KIND.EVENING_BEFORE) iltaan, jonka
 * jälkeinen aamu vaatii tavallista aiemman herätyksen. Neuvo on sama kuin
 * ilmoituskeskuksen merkinnässä (dailyLifeNotices.eveningBeforeAdvice), mutta
 * tämä tulee laitteen muistutuksena, vaikka sovellusta ei avattaisi illalla.
 *
 * @param {Function} [firstLeaveFor] herätyspäivä -> ensimmäinen lähtö 'HH:MM' tai null
 */
function sleepEntries(state, now, dates, firstLeaveFor = () => null) {
  // Pelkillä oletuksilla ei muistuteta nukkumaanmenosta: käyttäjä ei ole
  // kertonut rytmiään, eikä ilmoitus iltaisin saa tulla yllätyksenä. Rytmin
  // kertoo joko tallennettu arjen asetus TAI profiiliin itse asetettu
  // herätysaika (onboarding kysyy sen).
  const toldRhythm = listOf(state.lifeSettings).length > 0
    || (state.profileExists === true && Boolean(state.profile) && isTimeOfDay(state.profile.defaultWakeTime));
  if (!toldRhythm) return [];
  const entries = [];
  for (const date of dates) {
    const wakeDate = shiftIso(date, 1);
    let schedule = null;
    try {
      schedule = sleepScheduleOn(wakeDate, { state, now });
    } catch {
      schedule = null;
    }
    if (!schedule) continue;
    if (schedule.windDownMinutes > 0) {
      entries.push({
        kind: DAILY_REMINDER_KIND.WIND_DOWN, date: schedule.windDownDate, time: schedule.windDownStart,
        bedtime: schedule.bedtime
      });
    }
    entries.push({
      kind: DAILY_REMINDER_KIND.BEDTIME, date: schedule.bedtimeDate, time: schedule.bedtime,
      wakeTime: schedule.wakeTime
    });
    const evening = eveningBeforeEntry(state, now, date, wakeDate, schedule, firstLeaveFor);
    if (evening) entries.push(evening);
  }
  return entries;
}

/** Illan ennakko illalle `date` tai null (ei aiempaa herätystä tai laskentavirhe). */
function eveningBeforeEntry(state, now, date, wakeDate, schedule, firstLeaveFor) {
  let advice = null;
  try {
    advice = eveningBeforeAdvice(wakeDate, { state, now, schedule });
  } catch {
    advice = null;
  }
  if (!advice || !advice.message) return null;
  const time = eveningBeforeTime(date, schedule.windDownDate || schedule.bedtimeDate, advice.windDownStart);
  if (!time) return null;
  let firstLeave = null;
  try {
    firstLeave = firstLeaveFor(wakeDate);
  } catch {
    firstLeave = null;
  }
  return {
    kind: DAILY_REMINDER_KIND.EVENING_BEFORE, date, time, wakeDate,
    message: advice.message, detail: advice.detail, windDownStart: advice.windDownStart, firstLeave
  };
}

/** Ateriat käyttäjän omasta ateriarytmistä (valmistelu huomioiden). */
function mealEntries(settings, dates) {
  const rhythm = settings && settings.mealRhythm;
  if (!rhythm || typeof rhythm !== 'object') return [];
  const meals = Array.isArray(rhythm.meals) ? rhythm.meals : EMPTY;
  const prepById = new Map(meals.filter(meal => meal && meal.id).map(meal => [meal.id, meal.prepMinutes]));
  const entries = [];
  for (const date of dates) {
    for (const item of dailyMealItems({ mealRhythm: rhythm, dateIso: date })) {
      // Lisäravinne, vesi ja iltaraja omina alalajeinaan (oikea sanamuoto);
      // valmistelu on osa ateriaa (prepMinutes), ei oma muistutuksensa.
      if (item.kind === MEAL_ITEM_KIND.SUPPLEMENT || item.kind === MEAL_ITEM_KIND.WATER
        || item.kind === MEAL_ITEM_KIND.LATE_CUTOFF) {
        entries.push({
          kind: DAILY_REMINDER_KIND.MEAL, mealKind: item.kind, id: item.id, date: item.date, time: item.time
        });
        continue;
      }
      if (item.kind !== MEAL_ITEM_KIND.MEAL) continue;
      const prep = item.sourceId ? prepById.get(item.sourceId) : null;
      entries.push({
        kind: DAILY_REMINDER_KIND.MEAL, id: item.sourceId || item.id, date: item.date, time: item.time,
        prepMinutes: Number.isInteger(prep) ? prep : 0, name: item.title
      });
    }
  }
  return entries;
}

/** Tapojen muutoksen seuraava suunniteltu aika aktiivisille suunnitelmille. */
function habitEntries(state, now, dates) {
  const plans = listOf(state.habitPlans).filter(plan => plan && plan.active !== false && plan.id);
  if (plans.length === 0) return { entries: [], delivery: null };
  const timeZone = deviceTimeZone() || undefined;
  const last = dates[dates.length - 1];
  const entries = [];
  let delivery = null;
  for (const plan of plans) {
    let current = null;
    try {
      current = habitStatus({ plan, events: listOf(state.habitEvents), nowMs: now.getTime(), timeZone });
    } catch {
      current = null;
    }
    if (!current || current.state !== HABIT_STATE.WAIT || !Number.isFinite(current.nextAtMs)) continue;
    const wall = epochToWallClock(current.nextAtMs, deviceOffsetMinutes);
    if (!wall || wall.date > last) continue;
    entries.push({ kind: DAILY_REMINDER_KIND.HABIT, id: plan.id, date: wall.date, time: wall.time, habitKind: plan.kind });
    if (delivery === null && DELIVERIES.includes(plan.reminderDelivery)) delivery = plan.reminderDelivery;
  }
  return { entries, delivery };
}

/**
 * Politiikan asetukset: tapasuunnitelman oma muistutustapa pätee, ellei
 * käyttäjä ole valinnut "Tapojen muutos" -aiheelle tapaa asetuksissa.
 */
function policySettings(settings, habitDelivery) {
  if (!habitDelivery) return settings;
  const delivery = settings && settings.delivery && typeof settings.delivery === 'object' ? settings.delivery : {};
  if (DELIVERIES.includes(delivery.habit)) return settings;
  return { ...settings, delivery: { ...delivery, habit: habitDelivery } };
}

/** Torkussa oleva avain: sen menneet aikomukset tarvitaan korvaajan pohjaksi. */
function snoozedKeys(ackLog, nowMs) {
  const keys = new Set();
  for (const [key, entry] of ackIndex(ackLog)) {
    if (!entryHandled(entry) && Number.isFinite(entry.snoozedUntil) && entry.snoozedUntil > nowMs) keys.add(key);
  }
  return keys;
}

function isFuture(intent, nowMs) {
  const moment = intentMoment(intent);
  return Boolean(moment) && moment.epochMs > nowMs;
}

/**
 * Perinteiset muistutukset (tehtävä, rutiini, määräaika, päivän suunnitelma,
 * illan katsaus, matkan lähtö) päiville `dates` RAAKOINA: rauhoitusaika,
 * päiväraja, toimitustapa ja kooste tulevat samasta toimituspolitiikasta
 * kuin arjen muistutuksille (dailyLifeReminderPlan).
 *
 * Ohjaustyyli pidentää tehtävän ja rutiinin ennakkoa
 * (GUIDANCE_EFFECTS.leadMultiplier; aktiivinen 10 -> 15 min), ei koskaan
 * lyhennä. Horisontti on kalenteripäiviä (horizonDates -> shiftIso ->
 * addDays), ei millisekunteja: kesäajan 25-tuntinen vuorokausi ei pudota
 * viimeisen päivän rutiineja. Matkan lähtö lasketaan laitteen vyöhykkeellä.
 *
 * @returns {ReadonlyArray<object>}
 */
export function legacyReminderIntents({ state = getState(), dates, todayIso, preferences = null, settings = null } = {}) {
  const days = listOf(dates).filter(Boolean);
  if (days.length === 0) return EMPTY;
  const prefs = preferences || normalizePreferences(state.notificationPreferences || {});
  const style = resolveGuidanceStyle(null, settings || currentLifeSettings(state));
  const scaled = {
    ...prefs,
    taskLeadMinutes: scaleLeadMinutes(prefs.taskLeadMinutes, style) ?? prefs.taskLeadMinutes,
    routineLeadMinutes: scaleLeadMinutes(prefs.routineLeadMinutes, style) ?? prefs.routineLeadMinutes
  };
  // Rutiiniesiintymät koko horisontille kerralla — ne eivät ole tallennettuja.
  const routineOccurrences = expandRoutines({
    routines: listOf(state.routines),
    from: days[0],
    to: days[days.length - 1],
    exceptions: listOf(state.routineExceptions)
  });
  return planRange({
    tasks: listOf(state.tasks),
    routineOccurrences,
    travelPlans: listOf(state.travelPlans),
    from: days[0],
    days: days.length,
    todayIso: todayIso || days[0],
    preferences: scaled,
    // Kesäaikaan siirtymisen yönä matkan lähtömuistutus ei tule tuntia
    // myöhässä (bugijahti time-04).
    offsetMinutesFn: deviceOffsetMinutes,
    limits: false
  });
}

/** Perinteiset muistutukset; laskennan virhe ei estä arjen muistutuksia. */
function safeLegacyIntents(options) {
  try {
    return legacyReminderIntents(options);
  } catch {
    logEvent('alarm.legacy_plan_failed', { code: 'compute' });
    return EMPTY;
  }
}

/**
 * KAIKKI muistutusaikomukset toimituspolitiikan jälkeen: arjen muistutukset
 * ja perinteiset (legacyReminderIntents) YHDESSÄ politiikan kutsussa, joten
 * toimitustapa aiheittain, puhe, ohjaustyyli, kooste, rauhoitusaika,
 * kuittaukset ja päiväraja koskevat kaikkia samalla tavalla.
 *
 * @param {object} [options]
 * @param {object} [options.state]
 * @param {Date}   [options.now]
 * @param {object} [options.ackLog]
 * @param {boolean} [options.includePast] esikatselu (notifications.planUpcoming):
 *        myös tämän päivän jo menneet mukaan. Ajastus ei koskaan anna tätä.
 * @param {string} [options.fromIso] horisontin ensimmäinen päivä (oletus tänään)
 * @returns {{intents:ReadonlyArray<object>, routes:Map<string,object>}}
 */
export function dailyLifeReminderPlan({
  state = getState(), now = new Date(), ackLog = currentAckLog(), includePast = false, fromIso = null
} = {}) {
  const preferences = normalizePreferences(state.notificationPreferences || {});
  if (!preferences.enabled) return { intents: EMPTY, routes: new Map() };
  const { todayIso } = clockOf(now);
  const nowMs = now.getTime();
  const dates = horizonDates(typeof fromIso === 'string' && fromIso ? fromIso : todayIso);
  const settings = currentLifeSettings(state);

  // Arjen osan laskentavirhe ei vie perinteisiä muistutuksia (eikä päinvastoin).
  let routes = new Map();
  let effective = settings;
  let everyday = EMPTY;
  try {
    const departures = departureInputs(state, now, dates, eventLeadMinutes(preferences, settings));
    routes = departures.routes;
    const habits = habitEntries(state, now, dates);
    effective = policySettings(settings, habits.delivery);
    const chain = planDepartureChain({ departures: departures.inputs, settings: effective, todayIso });
    const firstLeaveFor = wakeDate => firstLeaveOn(departures.inputs, wakeDate);
    const daily = planDailyLifeReminders({
      entries: [
        ...sleepEntries(state, now, dates, firstLeaveFor), ...mealEntries(settings, dates), ...habits.entries,
        ...departures.starts
      ],
      settings: effective,
      todayIso
    });
    everyday = [...chain, ...daily];
  } catch {
    logEvent('alarm.daily_plan_failed', { code: 'compute' });
  }
  const legacy = safeLegacyIntents({ state, dates, todayIso, preferences, settings: effective });

  // Menneet pois ENNEN päivärajaa (muuten aamun menneet veisivät illan
  // paikat), paitsi torkussa olevat: torkun korvaaja rakennetaan niistä.
  const snoozed = snoozedKeys(ackLog, nowMs);
  const candidates = [...legacy, ...everyday].filter(intent =>
    includePast || isFuture(intent, nowMs) || snoozed.has(intent.ackKey || intent.id));
  const policy = applyNotificationPolicy(candidates, { settings: effective, preferences, ackLog, nowMs });
  return {
    intents: Object.freeze(includePast ? [...policy] : policy.filter(intent => isFuture(intent, nowMs))),
    routes
  };
}

/** Sama suunnitelma kuvaavalla nimellä: kaikki muistutukset, yksi putki. */
export const reminderPlan = dailyLifeReminderPlan;

/** Meneekö aikomus laitteen herätysliitännäiselle: puhuu tai voimistuu hälytykseksi. */
export function isNativeBound(intent) {
  return Boolean(intent) && deliverySpeaks(intent.delivery);
}

/**
 * Jaa aikomukset: puhuvat ja voimistuvat laitteen herätysliitännäiselle,
 * muut tavallisiksi ilmoituksiksi. Ilman liitännäistä (selain, vanha
 * Android-sovellus) kaikki jäävät tavallisiksi ilmoituksiksi — silloinkin
 * muistutus näkyy, vaikka se ei puhu.
 *
 * @returns {{native:Array, local:Array}}
 */
export function partitionReminders(intents, { nativeSupported = false, capacity = NATIVE_ALARM_LIMIT } = {}) {
  const native = [];
  const local = [];
  const limit = Number.isInteger(capacity) && capacity >= 0 ? capacity : 0;
  const ordered = [...listOf(intents)].sort((a, b) => (b.level - a.level)
    || String(a.date).localeCompare(String(b.date)) || String(a.time).localeCompare(String(b.time))
    || String(a.id).localeCompare(String(b.id), 'fi'));
  for (const intent of ordered) {
    if (nativeSupported && isNativeBound(intent) && native.length < limit) native.push(intent);
    else local.push(intent);
  }
  return { native, local };
}

/** Herätykset horisontille; kuitatut ja menneet pois. */
export function plannedWakeAlarms({ state = getState(), now = new Date(), ackLog = currentAckLog() } = {}) {
  const { todayIso } = clockOf(now);
  const dates = horizonDates(todayIso);
  const commitmentsByDate = {};
  for (const date of dates) {
    try {
      const commitment = firstCommitmentOn(date, { state, now });
      if (commitment) commitmentsByDate[date] = commitment;
    } catch { /* ilman sitoumusta: tavallinen rytmi */ }
  }
  const settings = currentLifeSettings(state);
  const list = desiredAlarms({
    fromIso: todayIso, days: dates.length, profile: state.profile || {}, settings, commitmentsByDate,
    sleepLogs: listOf(state.sleepLogs), offsetMinutesFn: deviceOffsetMinutes
  });
  const index = ackIndex(ackLog);
  const nowMs = now.getTime();
  return list.filter(alarm => {
    if (entryHandled(index.get(alarm.id) || null)) return false;
    const at = wallClockToEpoch(alarm.date, alarm.time, deviceOffsetMinutes);
    return Boolean(at) && at.epochMs > nowMs;
  });
}

/** Laitteen tunniste: aikomuksen oma, jos kelpaa, muuten vakaa tiiviste. */
export function nativeIdFor(id) {
  const text = String(id ?? '');
  if (text.length > 0 && text.length <= MAX_ID && NATIVE_ID.test(text)) return text;
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `n:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function wakeEntry(alarm) {
  return {
    entry: {
      id: nativeIdFor(alarm.id),
      kind: 'wake',
      date: alarm.date,
      time: alarm.time,
      title: clip(alarm.label, MAX_TITLE) || 'Herätys',
      body: clip(alarm.reason, MAX_BODY),
      speech: clip(alarm.briefText, MAX_SPEECH),
      mode: alarm.mode,
      escalation: listOf(alarm.escalation).map(step => ({ afterSeconds: step.afterSeconds, step: step.step })),
      snoozeMinutes: alarm.snoozeMinutes,
      maxSnoozes: alarm.maxSnoozes,
      routeDestination: null,
      routeMode: null
    },
    target: { id: nativeIdFor(alarm.id), ackKey: alarm.id, kind: 'wake', type: 'wake', date: alarm.forDate }
  };
}

function intentEntry(intent, routes) {
  const moment = intentMoment(intent);
  if (!moment) return null;
  const critical = intent.delivery === DELIVERY.CRITICAL_ESCALATION;
  const speech = clip(intent.speech, MAX_SPEECH);
  const departure = DEPARTURE_CHAIN_TYPES.includes(intent.type) && typeof intent.departureId === 'string'
    ? routes.get(intent.departureId) || null : null;
  const id = nativeIdFor(intent.id);
  let mode;
  if (critical) mode = speech ? 'combination' : 'alarm_sound';
  else mode = speech ? 'speech' : 'alarm_sound';
  return {
    entry: {
      id,
      kind: critical ? 'critical' : 'spoken',
      date: moment.date,
      time: moment.time,
      title: clip(intent.title, MAX_TITLE) || 'Muistutus',
      body: clip(intent.body, MAX_BODY),
      speech,
      mode,
      escalation: critical
        ? (speech ? SPOKEN_CRITICAL_ESCALATION : DEFAULT_ESCALATION).map(step => ({ ...step }))
        : [],
      snoozeMinutes: DEPARTURE_SNOOZE_MINUTES,
      maxSnoozes: DEPARTURE_MAX_SNOOZES,
      routeDestination: departure ? clip(departure.destination, 200) : null,
      routeMode: departure ? departure.mode : null
    },
    target: {
      id,
      ackKey: intent.ackKey || intent.id,
      kind: critical ? 'critical' : 'spoken',
      type: intent.type,
      departureId: departure ? intent.departureId : null,
      eventId: departure ? departure.eventId : null,
      placeId: departure ? departure.placeId : null,
      date: departure ? departure.date : intent.date,
      leaveTime: departure ? departure.leaveTime : null
    }
  };
}

/** Tarkista merkintä alustan säännöillä; kelvoton reitti pudotetaan, muu kelvoton merkintä ohitetaan. */
function checked(item) {
  if (!item) return null;
  let result = alarms.validate(item.entry);
  if (!result.valid && result.errors && (result.errors.routeDestination || result.errors.routeMode)) {
    item = { ...item, entry: { ...item.entry, routeDestination: null, routeMode: null } };
    result = alarms.validate(item.entry);
  }
  return result.valid ? item : null;
}

/**
 * Laitteelle halutut merkinnät: herätykset ja puhuvat/voimistuvat
 * muistutukset. Järjestys: aika, sitten tunniste (deterministinen).
 *
 * @returns {{entries:Array, targets:Array, localIntents:Array}}
 */
export function desiredNativeEntries({
  state = getState(), now = new Date(), ackLog = currentAckLog(), nativeSupported = true
} = {}) {
  const wake = nativeSupported ? plannedWakeAlarms({ state, now, ackLog }) : EMPTY;
  const { intents, routes } = dailyLifeReminderPlan({ state, now, ackLog });
  const { native, local } = partitionReminders(intents, {
    nativeSupported, capacity: Math.max(0, NATIVE_ALARM_LIMIT - wake.length)
  });
  const items = [];
  const seen = new Set();
  const fallback = [];
  for (const item of wake.map(wakeEntry).map(checked)) {
    if (!item || seen.has(item.entry.id)) continue;
    seen.add(item.entry.id);
    items.push(item);
  }
  for (const intent of native) {
    const item = checked(intentEntry(intent, routes));
    // Laite ei hyväksyisi merkintää: muistutus tulee silti tavallisena
    // ilmoituksena, ei katoa.
    if (!item || seen.has(item.entry.id)) {
      fallback.push(intent);
      continue;
    }
    seen.add(item.entry.id);
    items.push(item);
  }
  items.sort((a, b) => a.entry.date.localeCompare(b.entry.date) || a.entry.time.localeCompare(b.entry.time)
    || a.entry.id.localeCompare(b.entry.id, 'fi'));
  return {
    entries: items.map(item => item.entry),
    targets: items.map(item => item.target),
    localIntents: [...local, ...fallback]
  };
}

/**
 * Arjen muistutukset, jotka jäävät tavallisiksi ilmoituksiksi
 * (src/app/notifications.js syncNotifications). Sama jako kuin
 * laitteen herätysajastuksessa, joten muistutus ei tule kahdesti.
 */
export function dailyLifeLocalIntents(options = {}) {
  const nativeSupported = options.nativeSupported ?? alarms.supportsBackgroundAlarms();
  return desiredNativeEntries({ ...options, nativeSupported }).localIntents;
}

// =====================================================================
// AJASTUS LAITTEELLE
// =====================================================================

let activeUserId = null;
let generation = 0;
let chain = Promise.resolve();
let debounceTimer = null;
let queued = null;
let lastDay = null;
let lastRefs = null;
let lastResult = Object.freeze({ ok: false, supported: false, scheduled: 0, requested: 0, reason: '', at: null });

/** Laitteen kutsut yksi kerrallaan, pyyntöjärjestyksessä. */
function serialized(task) {
  const run = chain.then(task, task);
  chain = run.then(() => {}, () => {});
  return run;
}

/** Viimeisimmän ajastuksen tulos (näkymä voi kertoa sen rehellisesti). */
export function alarmSyncStatus() {
  return lastResult;
}

/** Kirjautuminen: ajastus sallitaan tälle käyttäjälle. */
export function activateAlarmSync(userId) {
  activeUserId = typeof userId === 'string' && userId ? userId : null;
  generation += 1;
  lastDay = null;
  lastRefs = null;
}

/**
 * Uloskirjautuminen ja tilin poisto: odottava ajastus pois ja laitteen
 * herätykset perutaan (jonossa ajastuksen perään, ei sen ohi).
 * @returns {Promise<object>} peruutuksen tulos; ei koskaan heitä
 */
export function resetAlarmSync() {
  activeUserId = null;
  generation += 1;
  cancelScheduledAlarmSync();
  queued = null;
  lastDay = null;
  lastRefs = null;
  lastResult = Object.freeze({ ok: false, supported: false, scheduled: 0, requested: 0, reason: '', at: null });
  return cancelNativeAlarms();
}

/** Peru kaikki laitteen herätykset (sarjassa muiden laitekutsujen kanssa). Ei heitä. */
export function cancelNativeAlarms() {
  return serialized(async () => {
    try {
      return await alarms.cancelAll();
    } catch {
      return { ok: false, supported: false, removed: 0 };
    }
  });
}

/**
 * Ajasta herätykset ja puhutut muistutukset laitteelle nyt.
 *
 * Samanaikaiset pyynnöt yhdistyvät: jos ajastus odottaa vuoroaan, uusi
 * pyyntö saa saman tuloksen (joukko lasketaan vasta vuoron tullessa).
 *
 * @returns {Promise<{ok:boolean, supported:boolean, scheduled:number, requested:number, reason:string}>}
 */
export function syncAlarms({ now = null } = {}) {
  if (queued) return queued;
  const ticket = generation;
  const promise = serialized(async () => {
    if (queued === promise) queued = null;
    return runSync(ticket, now);
  });
  queued = promise;
  return promise;
}

async function runSync(ticket, fixedNow) {
  const finish = result => {
    lastResult = Object.freeze({ ...result, at: Date.now() });
    return lastResult;
  };
  if (ticket !== generation || !activeUserId) {
    return { ok: false, supported: alarms.supportsBackgroundAlarms(), scheduled: 0, requested: 0, reason: 'Istunto päättyi' };
  }
  if (!alarms.supportsBackgroundAlarms()) {
    // Selain tai sovellusversio ilman herätysliitännäistä: ei mitään
    // ajastettavaa eikä teeskennellä. Muistutukset tulevat tavallisina
    // ilmoituksina (notifications.js), jos alusta pystyy niihin.
    const status = await alarms.status();
    return finish({ ok: false, supported: false, scheduled: 0, requested: 0, reason: status.reason || '' });
  }
  const session = sessionSnapshot();
  const now = fixedNow instanceof Date ? fixedNow : new Date();
  let desired;
  try {
    desired = desiredNativeEntries({ state: getState(), now, nativeSupported: true });
  } catch (error) {
    logEvent('alarm.sync_failed', { code: 'compute' });
    return finish({ ok: false, supported: true, scheduled: 0, requested: 0, reason: 'Herätyksiä ei voitu laskea.' });
  }
  // Uloskirjautuminen tai tilinvaihto laskennan aikana: ei ajasteta
  // kenenkään nimissä (peruutus on jo jonossa tämän perään).
  if (ticket !== generation || !isSameSession(session) || !activeUserId) {
    return { ok: false, supported: true, scheduled: 0, requested: 0, reason: 'Istunto päättyi' };
  }
  const result = await alarms.schedule(desired.entries);
  if (ticket !== generation) {
    // Uloskirjautuminen ehti tapahtua ajastuksen aikana. Peruutus on
    // jonossa tämän jälkeen, joten laitteelle ei jää tätä joukkoa.
    return { ok: false, supported: true, scheduled: 0, requested: desired.entries.length, reason: 'Istunto päättyi' };
  }
  if (result && result.ok) rememberScheduledTargets(desired.targets);
  logEvent('alarm.synced', {
    requested: desired.entries.length,
    scheduled: result ? result.scheduled || 0 : 0,
    dropped: result && Array.isArray(result.dropped) ? result.dropped.length : 0,
    rejected: result && Array.isArray(result.rejected) ? result.rejected.length : 0
  });
  return finish({
    ok: Boolean(result && result.ok),
    supported: true,
    scheduled: result ? result.scheduled || 0 : 0,
    requested: desired.entries.length,
    exact: Boolean(result && result.exact),
    reason: result && result.reason ? result.reason : ''
  });
}

/** Pyydä ajastus viiveellä: peräkkäiset tilamuutokset yhdeksi kutsuksi. */
export function scheduleAlarmSync() {
  if (!activeUserId) return;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    syncAlarms().catch(() => {});
  }, ALARM_SYNC_DEBOUNCE_MS);
}

/** Peru odottava viivästetty ajastus. */
export function cancelScheduledAlarmSync() {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
}

/**
 * Muuttuiko jokin herätyksiin vaikuttava kokoelma edellisestä kerrasta?
 * Viittausvertailu riittää: tila korvaa kokoelmat, ei muuta niitä paikallaan.
 */
export function alarmRelevantChanged(state = getState()) {
  const refs = ALARM_RELEVANT_KEYS.map(key => state ? state[key] : undefined);
  const changed = lastRefs === null || refs.some((ref, index) => ref !== lastRefs[index]);
  lastRefs = refs;
  return changed;
}

/**
 * Kellon kierros (main.js:n olemassa oleva 30 s tikki): päivän vaihtuessa
 * horisontti siirtyy, joten uusi päivä ajastetaan.
 * @returns {boolean} pyydettiinkö uusi ajastus
 */
export function alarmDayRolled(now = new Date()) {
  const { todayIso } = clockOf(now);
  if (lastDay === null) {
    lastDay = todayIso;
    return false;
  }
  if (todayIso === lastDay) return false;
  lastDay = todayIso;
  return true;
}

/** Testejä varten: odota, että jonossa olevat laitekutsut ovat valmiita. */
export function settledForTests() {
  return chain;
}
