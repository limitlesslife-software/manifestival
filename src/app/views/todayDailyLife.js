// Tänään-näkymän arjen kortit: seuraava lähtö, huominen, aamu, tavat,
// avoimet asiat ja keskeytykset sekä päivän kalenteri (menot ja suojatut
// lohkot) aikajanalle.
//
// =====================================================================
// YKSI LASKENTAPOLKU
// =====================================================================
//
// Lähtö-, aamu- ja uniluvut tulevat AINA src/app/dailyLifeModel.js:stä
// (departuresOn, firstCommitmentOn, morningPlanOn, sleepScheduleOn). Sama
// meno ei saa kahta eri lähtöaikaa kortissa, kalenterissa, herätyksessä ja
// muistutuksessa. Tämä moduuli vain valitsee, mitä näytetään, ja sanoo sen.
//
// =====================================================================
// KORTTI NÄYTTÄÄ TILAN, EI LUO ILMOITUKSIA
// =====================================================================
//
// Lähdön vaiheista ilmoittaa departureWatch.js ja illan, viikonlopun ja
// myöhästelyn ehdotuksista dailyLifeNotices.js. Kortit ovat niiden elävä
// näkymä: ne eivät kirjoita ilmoituskeskukseen mitään.
//
// =====================================================================
// MIKÄÄN EI MUUTU ITSESTÄÄN
// =====================================================================
//
// Aamun valinnat, avoimen asian aikaehdotus ja keskeytyksen jälkeinen
// uudelleensuunnittelu ovat ehdotuksia. Päivän muutokset tehdään vasta
// vahvistusdialogin jälkeen, ja kiinteät menot ja suojatut lohkot eivät
// liiku koskaan (dayReplan.js ei ehdota niitä, ja tämä moduuli tarkistaa
// vielä, että jokainen muutos kohdistuu tehtävään tai rutiinin kertaan).
//
// =====================================================================
// REITTILINKKI ON AINA MEIDÄN KOKOAMAMME
// =====================================================================
//
// "Avaa reitti" kootaan navigationLink.js:llä paikan osoitteesta tai
// nimestä ja tarkistetaan isAllowedNavigationUrl-funktiolla. Linkkiä ei
// koskaan oteta sellaisenaan datasta, puheesta tai tekoälyltä.
//
// Tapa-, uni- ja mielialatiedot ovat arkaluonteisia: niitä ei kirjata
// lokiin. Virhelokiin menee vain kortin nimi.

import * as platform from '../../platform/index.js';
import { getState, currentLifeSettings } from '../state.js';
import { editTask } from '../actions.js';
import { recordCommuteObservation, logHabitEvent } from '../dailyLifeActions.js';
import {
  departuresOn, firstCommitmentOn, morningPlanOn, sleepScheduleOn, clockOf, shiftIso
} from '../dailyLifeModel.js';
import { EVENING_NOTICE_FROM_MINUTES } from '../dailyLifeNotices.js';
import { calendarInputs } from '../calendarPlan.js';
import {
  horizonDays, previewDayReplan, splitReplanChanges, taskPatch, isStaleChange, applyReplanChanges
} from '../dayReplanActions.js';
import { deviceOffsetMinutes, deviceTimeZone } from '../deviceTime.js';
import { sessionSnapshot, isSameSession } from '../../data/session.js';
import { expandEventOccurrences, shortDateLabel, absoluteMinutesOf } from '../../domain/calendar.js';
import { buildDayPlan, blockKindOf, BLOCK_KIND } from '../../domain/scheduler.js';
import { DEPARTURE_PHASE } from '../../domain/departure.js';
import {
  ESTIMATE_SOURCE, ARRIVAL_RESULT, HABIT_KIND, HABIT_ACTION, HABIT_ACTIONS, protectionLabel
} from '../../domain/dailyLife.js';
import { observedTravelMinutes } from '../../domain/commuteLearning.js';
import { sleepScheduleFor, eveningBefore, driftReport, mondayReadiness } from '../../domain/sleepRhythm.js';
import { CHOICE_KIND } from '../../domain/morningPlanner.js';
import { status as habitStatus, habitActionText, HABIT_STATE } from '../../domain/habitEngine.js';
import { proposeOpenEndedSlot, groupErrands, DEFAULT_HORIZON_DAYS } from '../../domain/errands.js';
import { REPLAN_CHANGE } from '../../domain/dayReplan.js';
import { INTERRUPTION_KIND } from '../../domain/interruptions.js';
import { buildNavigationTarget, googleMapsUrl, isAllowedNavigationUrl } from '../../domain/navigationLink.js';
import { foldPlaceText, MIN_ALIAS_CONFIRMATIONS } from '../../domain/places.js';
import { isoWeekday, clockText, durationText } from '../../domain/wallClock.js';
import { toMinutes, fromMinutes, isTimeOfDay, durationOf } from '../../domain/task.js';
import { escapeHtml } from '../../lib/format.js';
import { logEvent } from '../../lib/logger.js';
import { maybe, renderHtml, singleFlight, setBusy } from '../../ui/dom.js';
import { success, showError, notify } from '../../ui/toast.js';
import { confirmAction } from '../../ui/confirm.js';

// ------------------------------------------------------------ rajat

/** Aamukortti näkyy vain, kun ensimmäinen lähtö tai valmistautuminen on ennen puoltapäivää. */
export const MORNING_CARD_BEFORE_MINUTES = 12 * 60;
/** Huominen-kortti illalla: sama raja kuin illan ennakkohuomautuksella. */
export const EVENING_CARD_FROM_MINUTES = EVENING_NOTICE_FROM_MINUTES;
/** Lähdön kuittauksen jälkeen kortti odottaa "Olin perillä" -kuittausta näin kauan menon alusta. */
export const ARRIVAL_WAIT_MINUTES = 90;
/** Valmiit määrät: "Olen myöhässä" ja "Tämä kestää pidempään". */
export const LATE_MINUTE_CHOICES = Object.freeze([5, 10, 15, 30]);
export const EXTEND_MINUTE_CHOICES = Object.freeze([10, 15, 30, 60]);
/** Avoimia asioita kortissa enintään. */
export const MAX_OPEN_ENDED_ROWS = 5;
/** Asiointiehdotuksia kortissa enintään. */
const MAX_ERRAND_GROUPS = 3;
/** Paikan nimen perään sallittu taivutuspääte ("Motonet" -> "Motonetissä"). */
const MAX_CASE_SUFFIX = 5;
/** Lyhyempi paikannimi osuisi liian moneen sanaan. */
const MIN_PLACE_KEY_LENGTH = 3;
/** Päiväsilmukoiden suoja: kalenteri lasketaan enintään näin monelle päivälle kerralla. */
const MAX_RANGE_DAYS = 40;

const EMPTY = Object.freeze([]);
const EMPTY_CALENDAR = Object.freeze({ events: EMPTY, blocks: EMPTY });

/** Kortit säiliöittäin (index.html, screen-today) ja fokuksen varakohteet. */
const CONTAINERS = Object.freeze({
  todayDeparture: 'tdDepartureTitle',
  todayMorning: 'tdMorningTitle',
  todayHabits: 'tdHabitsTitle',
  todayInterruptions: 'tdInterruptTitle',
  todayOpenEnded: 'tdOpenTitle',
  todayTomorrow: 'tdTomorrowTitle'
});

const SOURCE_LABEL = Object.freeze({
  [ESTIMATE_SOURCE.USER_SUPPLIED]: 'oma arvio',
  [ESTIMATE_SOURCE.LEARNED]: 'opittu omista matkoista',
  [ESTIMATE_SOURCE.PROVIDER]: 'liikennetieto'
});

const INTERRUPTION_LABEL = Object.freeze({
  [INTERRUPTION_KIND.RUNNING_LATE]: 'Olen myöhässä',
  [INTERRUPTION_KIND.EXTEND_CURRENT]: 'Tämä kestää pidempään',
  [INTERRUPTION_KIND.DEFER_REMAINING]: 'Siirrä loput'
});

// ------------------------------------------------------------ apurit

function safe(fn, fallback) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function clock(time) {
  return isTimeOfDay(time) ? `klo ${clockText(time)}` : '';
}

function firstError(errors) {
  const values = errors && typeof errors === 'object' ? Object.values(errors) : [];
  const message = values.find(value => typeof value === 'string' && value.trim());
  return message || 'Tallennus ei onnistunut. Yritä uudelleen.';
}

function byTitle(a, b) {
  return String(a.title || '').localeCompare(String(b.title || ''), 'fi')
    || String(a.id).localeCompare(String(b.id), 'fi');
}

/** ISO-päivät from..to (mukaan lukien), enintään MAX_RANGE_DAYS. */
function datesBetween(fromIso, toIso) {
  const dates = [];
  for (let date = fromIso; date <= toIso && dates.length < MAX_RANGE_DAYS; date = shiftIso(date, 1)) dates.push(date);
  return dates;
}

function timeZone() {
  return safe(() => deviceTimeZone(), null) || undefined;
}

// ------------------------------------------------------------ paikallinen tila

// Näkymän omat luonnokset: auki oleva määrävalitsin, keskeytyksen ehdotus,
// avoimen asian aikaehdotus ja aamun valinta. Ne eivät ole käyttäjän
// dataa, joten ne eivät kuulu tilaan. Ne sidotaan istuntoon: toisen
// käyttäjän kirjautuessa (tai uloskirjautuessa) ne unohtuvat, vaikka
// resetTodayDailyLife jäisi kutsumatta.
function freshUi() {
  return { session: sessionSnapshot(), picker: null, replan: null, errand: null, morningChoice: null };
}

let ui = freshUi();

function uiState() {
  if (!isSameSession(ui.session)) ui = freshUi();
  return ui;
}

/** Uloskirjautuminen: luonnokset pois (main.js onSignedOut). */
export function resetTodayDailyLife() {
  ui = freshUi();
  lastContext = null;
}

// ------------------------------------------------------------ malli

/**
 * Yhden piirron laskenta: sama päivä kysytään mallilta vain kerran.
 * Jokainen luku tulee dailyLifeModel.js:stä samoilla valinnoilla.
 */
export function modelFor(state = getState(), now = new Date()) {
  const cache = new Map();
  const options = { state, now };
  const memo = (key, fn) => {
    if (!cache.has(key)) cache.set(key, safe(fn, null));
    return cache.get(key);
  };
  return {
    state,
    now,
    departures: date => memo(`d|${date}`, () => departuresOn(date, options)) || EMPTY,
    first: date => memo(`f|${date}`, () => firstCommitmentOn(date, options)),
    morning: (date, extra = null) => (extra
      ? safe(() => morningPlanOn(date, { ...options, ...extra }), null)
      : memo(`m|${date}`, () => morningPlanOn(date, options))),
    sleep: date => memo(`s|${date}`, () => sleepScheduleOn(date, options))
  };
}

/** Lähtömoottorin luvut lohkoille (calendarBlocks.eventBlocks). Tuntematon matka -> ei lohkoja. */
/**
 * Menojen esiintymät ja suojatut lohkot päiville from..to.
 *
 * YKSI LASKENTAPOLKU: sama calendarPlan.calendarInputs kuin Kalenterissa,
 * herätyksessä ja muistutuksissa. Esiintymät laajennetaan edelliselle
 * päivälle asti (keskiyön yli jatkuva meno näkyy aamulla), ja yöt lasketaan
 * edellisestä illasta viimeisen päivän iltaan: aamun uni ja illan
 * rauhoittuminen ovat suojattua aikaa, eivät vapaita välejä.
 *
 * @returns {{events: ReadonlyArray<object>, blocks: ReadonlyArray<object>}}
 */
export function calendarRange(fromIso, toIso, { state = getState(), now = new Date() } = {}) {
  const clockNow = clockOf(now);
  const inputs = calendarInputs(state, {
    from: fromIso, to: toIso, todayIso: clockNow.todayIso, nowMinutes: clockNow.nowMinutes,
    offsetMinutesFn: deviceOffsetMinutes
  });
  return { events: inputs.occurrences, blocks: inputs.blocks };
}

/**
 * Päivän suunnitelma kalenterin kanssa: menot ja suojatut lohkot ovat
 * aikajanalla, eivätkä ne ole vapaata aikaa. Päivänäkymä ja keskeytyksen
 * uudelleensuunnittelu käyttävät tätä samaa suunnitelmaa.
 */
export function dayPlanFor(dateIso, {
  state = getState(), now = new Date(), nowMinutes = null, todayIso = null, model = null
} = {}) {
  const calendar = safe(() => calendarRange(dateIso, dateIso, { state, now, model }), null);
  if (!calendar) logEvent('today.calendar_failed', { code: 'range' });
  const { events, blocks } = calendar || EMPTY_CALENDAR;
  return buildDayPlan({
    tasks: state.tasks,
    profile: state.profile,
    dateIso,
    nowMinutes,
    routines: state.routines,
    exceptions: state.routineExceptions,
    todayIso,
    events,
    blocks
  });
}

/** Aikajanan rivin laji tekstinä: tila ei koskaan pelkkänä värinä. */
const TIMELINE_BLOCK_LABEL = Object.freeze({
  [BLOCK_KIND.PREPARATION]: 'Valmistautuminen',
  [BLOCK_KIND.TRAVEL]: 'Matka',
  [BLOCK_KIND.OVERHEAD]: 'Pysäköinti ja kävely',
  [BLOCK_KIND.ARRIVAL_BUFFER]: 'Etuaika',
  [BLOCK_KIND.WIND_DOWN]: 'Iltarauhoittuminen',
  [BLOCK_KIND.SLEEP]: 'Uni'
});

/** Aikajanan menon tai lohkon lajin nimi ("Meno", "Matka", "Uni" ...). */
export function timelineKindLabel(item) {
  const kind = blockKindOf(item);
  if (kind) return TIMELINE_BLOCK_LABEL[kind] || 'Varattu';
  return 'Meno';
}

// ------------------------------------------------------------ paikka tekstistä

function wordsOf(folded) {
  return folded.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

function mentions(words, keyWords) {
  outer: for (let i = 0; i + keyWords.length <= words.length; i += 1) {
    for (let j = 0; j < keyWords.length; j += 1) {
      const word = words[i + j];
      const key = keyWords[j];
      const last = j === keyWords.length - 1;
      const ok = last ? word.startsWith(key) && word.length - key.length <= MAX_CASE_SUFFIX : word === key;
      if (!ok) continue outer;
    }
    return true;
  }
  return false;
}

/**
 * Tallennettu paikka, jonka nimi (tai vähintään kahdesti vahvistettu opittu
 * nimi) mainitaan tekstissä: "Käy Motonetissä" -> Motonet.
 *
 * EI ARVATA: vain yksi osuva paikka kelpaa. Kaksi mahdollista paikkaa tai
 * liian lyhyt nimi -> null. Tulos näkyy käyttäjälle ehdotuksen perusteluna,
 * eikä mitään tallenneta sen varassa ilman hyväksyntää.
 */
export function placeIdForText(text, places = [], aliases = []) {
  const folded = foldPlaceText(text);
  if (!folded) return null;
  const words = wordsOf(folded);
  const known = new Map();
  for (const place of Array.isArray(places) ? places : EMPTY) {
    if (place && typeof place.id === 'string' && place.id) known.set(place.id, place);
  }
  const matches = name => {
    const keyWords = wordsOf(foldPlaceText(name));
    if (keyWords.join('').length < MIN_PLACE_KEY_LENGTH) return false;
    return mentions(words, keyWords);
  };
  const hits = new Set();
  for (const place of known.values()) if (matches(place.name)) hits.add(place.id);
  for (const alias of Array.isArray(aliases) ? aliases : EMPTY) {
    if (!alias || !known.has(alias.placeId)) continue;
    const confirmations = Number.isFinite(alias.confirmations) ? alias.confirmations : 0;
    if (confirmations >= MIN_ALIAS_CONFIRMATIONS && matches(alias.alias)) hits.add(alias.placeId);
  }
  return hits.size === 1 ? [...hits][0] : null;
}

// ------------------------------------------------------------ seuraava lähtö

function locationTextOf(item) {
  for (const value of [item.occurrence && item.occurrence.locationText, item.event && item.event.locationText]) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

/** Lähtö kuuluu korttiin, kun menolla on paikka tai matka-aika: verkkopalaveri ei ole lähtö. */
function relevantDeparture(item) {
  if (!item || !item.departure || item.departure.applicable !== true || !item.departure.eventStart) return false;
  return Boolean(item.place) || Boolean(locationTextOf(item)) || item.departure.known === true;
}

/** Tämän päivän kuittaukset tälle menolle: lähtö ja perilläolo. */
export function tripProgress(item, observations, todayIso) {
  const placeId = item && item.place ? item.place.id : null;
  const eventId = item && item.occurrence ? item.occurrence.eventId ?? null : null;
  const own = (Array.isArray(observations) ? observations : EMPTY).filter(o => o
    && placeId && o.placeId === placeId && o.observedOn === todayIso && eventId && o.eventId === eventId);
  const departed = own.filter(o => isTimeOfDay(o.actualDeparture))
    .sort((a, b) => b.actualDeparture.localeCompare(a.actualDeparture))[0] || null;
  const arrived = own.find(o => isTimeOfDay(o.arrivalAt)) || null;
  return {
    departedAt: departed ? departed.actualDeparture : null,
    arrivedAt: arrived ? arrived.arrivalAt : null
  };
}

/**
 * Seuraava lähtö tänään: aikaisin meno, joka ei ole vielä alkanut (tai
 * jolta odotetaan perilläolon kuittausta) eikä ole jo kuitattu perillä.
 */
export function nextDepartureItem(model, clockNow, observations) {
  const nowAbs = absoluteMinutesOf(clockNow.todayIso, clockNow.nowMinutes);
  const candidates = [];
  for (const item of model.departures(clockNow.todayIso)) {
    if (!relevantDeparture(item)) continue;
    const trip = tripProgress(item, observations, clockNow.todayIso);
    if (trip.arrivedAt) continue;
    const startAbs = item.departure.eventStart.abs;
    const open = nowAbs < startAbs || (trip.departedAt && nowAbs < startAbs + ARRIVAL_WAIT_MINUTES);
    if (open) candidates.push({ ...item, trip });
  }
  candidates.sort((a, b) => a.departure.eventStart.abs - b.departure.eventStart.abs
    || String(a.occurrence.id).localeCompare(String(b.occurrence.id), 'fi'));
  return candidates[0] || null;
}

/** Vaihe tekstinä: "Valmistaudu klo 8.10", "Lähde nyt", "Myöhässä 7 min", "Matka-aika puuttuu". */
export function departurePhaseText(departure) {
  if (!departure || departure.known !== true) return 'Matka-aika puuttuu';
  const prepare = departure.prepareStart ? clockText(departure.prepareStart.time) : '';
  const leave = departure.leave ? clockText(departure.leave.time) : '';
  const hasPreparation = (departure.parts && departure.parts.preparation) > 0;
  switch (departure.phase) {
    case DEPARTURE_PHASE.PREPARE_NOW:
      return 'Valmistaudu nyt';
    case DEPARTURE_PHASE.LEAVE_IN_5: {
      const minutes = Number.isInteger(departure.minutesUntilLeave) && departure.minutesUntilLeave > 0
        ? departure.minutesUntilLeave : 5;
      return minutes === 1 ? 'Lähde minuutin päästä' : `Lähde ${minutes} minuutin päästä`;
    }
    case DEPARTURE_PHASE.LEAVE_NOW:
      return 'Lähde nyt';
    case DEPARTURE_PHASE.LATE:
      return Number.isFinite(departure.minutesLate) && departure.minutesLate > 0
        ? `Myöhässä ${departure.minutesLate} min`
        : 'Lähtöaika meni';
    case DEPARTURE_PHASE.UNKNOWN_TRAVEL:
      return 'Matka-aika puuttuu';
    default:
      return hasPreparation ? `Valmistaudu klo ${prepare}` : `Lähde klo ${leave}`;
  }
}

/** Erittely riveinä: valmistautuminen, matka ja sen lähde, pysäköinti ja kävely, etuaika. */
export function departureBreakdown(departure) {
  if (!departure || departure.known !== true) {
    return ['Lisää paikalle tai menolle oma arvio matka-ajasta, niin lähtöaika lasketaan.'];
  }
  const parts = departure.parts || {};
  const lines = [];
  if (parts.preparation > 0) {
    lines.push(`Valmistautuminen ${durationText(parts.preparation)} · alkaa ${clock(departure.prepareStart.time)}`);
  }
  const source = SOURCE_LABEL[departure.source];
  lines.push(`Matka ${durationText(parts.travel)}${source ? ` · ${source}` : ''} · lähde ${clock(departure.leave.time)}`);
  if (parts.overhead > 0) lines.push(`Pysäköinti ja kävely ${durationText(parts.overhead)}`);
  if (parts.early > 0 && departure.arrivalTarget) {
    lines.push(`Etuaika ${durationText(parts.early)} · perillä ${clock(departure.arrivalTarget.time)}`);
  }
  if (departure.reminderOffsetMinutes > 0) {
    lines.push(`Muistutukset tulevat ${durationText(departure.reminderOffsetMinutes)} tavallista aiemmin.`);
  }
  return lines;
}

/** Navigointi Android-sovelluksessa: vain jos herätysliitännäisen silta on olemassa. */
function nativeNavigation() {
  const alarms = platform.alarms;
  return Boolean(alarms && typeof alarms.openNavigation === 'function'
    && typeof platform.isNativeShell === 'function' && safe(() => platform.isNativeShell(), false));
}

/** Reitin kohde: osoite tai paikan nimi, aina navigationLink.js:n siivoamana. */
export function routeTargetOf(item) {
  if (!item) return null;
  return buildNavigationTarget({
    address: item.place ? item.place.address : null,
    placeName: (item.place && item.place.name) || locationTextOf(item),
    mode: item.departure ? item.departure.mode : undefined
  });
}

/** Selaimen reittilinkki: vain sallittu https-osoite, muuten null. */
export function routeUrlOf(item) {
  const target = routeTargetOf(item);
  if (!target) return null;
  const url = googleMapsUrl(target);
  return url && isAllowedNavigationUrl(url) ? url : null;
}

function routeControl(item) {
  const target = routeTargetOf(item);
  if (!target) return '';
  if (nativeNavigation()) {
    return `<button type="button" class="assist-btn" data-td-action="route"
      data-occurrence="${escapeHtml(item.occurrence.id)}">Avaa reitti</button>`;
  }
  const url = routeUrlOf(item);
  if (!url) return '';
  return `<a class="assist-btn td-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer"
    data-td-route="${escapeHtml(item.occurrence.id)}">Avaa reitti<span class="visually-hidden"> (avautuu karttaan)</span></a>`;
}

function departureCard(model, clockNow, state) {
  const item = nextDepartureItem(model, clockNow, state.commuteObservations);
  if (!item) return '';
  const { departure, occurrence, place, trip } = item;
  const placeName = (place && place.name) || locationTextOf(item);
  const late = departure.phase === DEPARTURE_PHASE.LATE;
  const urgent = late || departure.phase === DEPARTURE_PHASE.LEAVE_NOW || departure.phase === DEPARTURE_PHASE.LEAVE_IN_5;
  const phase = trip.departedAt ? `Lähdit ${clock(trip.departedAt)}` : departurePhaseText(departure);
  const lines = departureBreakdown(departure).map(line => `<li>${escapeHtml(line)}</li>`).join('');
  const id = escapeHtml(occurrence.id);
  const title = occurrence.title || 'Meno';
  const actions = [routeControl(item)];
  if (place) {
    if (!trip.departedAt) {
      actions.push(`<button type="button" class="assist-btn" data-td-action="departed" data-occurrence="${id}"
        aria-label="Lähdin nyt: ${escapeHtml(title)}">Lähdin nyt</button>`);
    }
    actions.push(`<button type="button" class="assist-btn${trip.departedAt ? ' primary' : ''}" data-td-action="arrived"
      data-occurrence="${id}" aria-label="Olin perillä: ${escapeHtml(title)}">Olin perillä</button>`);
  }
  return `
    <section class="td-card" aria-labelledby="tdDepartureTitle">
      <h2 class="section-title" id="tdDepartureTitle" tabindex="-1">Seuraava lähtö</h2>
      <div class="assist-row td-departure${urgent && !trip.departedAt ? ' is-urgent' : ''}">
        <p class="td-phase${late && !trip.departedAt ? ' is-late' : ''}">${escapeHtml(phase)}</p>
        <div class="assist-title">${escapeHtml(title)}</div>
        <div class="assist-meta">${placeName ? `${escapeHtml(placeName)} · ` : ''}alkaa ${escapeHtml(clock(occurrence.time))}</div>
        <ul class="td-lines">${lines}</ul>
        ${place ? '' : '<p class="hint">Tallenna paikka, niin voit kuitata lähdön ja perilläolon.</p>'}
        <div class="assist-actions">${actions.filter(Boolean).join('')}</div>
      </div>
    </section>`;
}

/** Lähtöhavainto: suunniteltu ja toteutunut lähtö (myöhästelyn oppiminen). */
export function departureObservation(item, clockNow) {
  const departure = item.departure || {};
  const leave = departure.known && departure.leave && departure.leave.date === clockNow.todayIso ? departure.leave.time : null;
  return {
    placeId: item.place ? item.place.id : null,
    eventId: item.occurrence.eventId ?? null,
    observedOn: clockNow.todayIso,
    plannedDeparture: leave,
    actualDeparture: fromMinutes(clockNow.nowMinutes),
    preparationMinutes: departure.parts ? departure.parts.preparation ?? null : null,
    overheadMinutes: departure.parts ? departure.parts.overhead ?? null : null
  };
}

function arrivalResultOf(departure, clockNow) {
  if (!departure || !departure.eventStart || departure.eventStart.date !== clockNow.todayIso) return null;
  const nowAbs = absoluteMinutesOf(clockNow.todayIso, clockNow.nowMinutes);
  const target = departure.arrivalTarget ? departure.arrivalTarget.abs : departure.eventStart.abs;
  if (nowAbs <= target) return ARRIVAL_RESULT.EARLY;
  if (nowAbs <= departure.eventStart.abs) return ARRIVAL_RESULT.ON_TIME;
  return ARRIVAL_RESULT.LATE;
}

/**
 * Perilläolohavainto. Matka-aika lasketaan vain, jos lähtö kuitattiin
 * tänään samalle menolle (ovelta ovelle miinus pysäköinti ja kävely,
 * sama sääntö kuin oppimisessa). Lähtöaikaa ei kirjata tähän uudelleen,
 * jottei sama myöhästyminen laskisi kahdesti.
 */
export function arrivalObservation(item, clockNow, observations) {
  const departure = item.departure || {};
  const arrivalAt = fromMinutes(clockNow.nowMinutes);
  const trip = tripProgress(item, observations, clockNow.todayIso);
  const overhead = departure.parts ? departure.parts.overhead ?? null : null;
  const travelMinutes = trip.departedAt
    ? observedTravelMinutes({ actualDeparture: trip.departedAt, arrivalAt, overheadMinutes: overhead })
    : null;
  const leave = departure.known && departure.leave && departure.leave.date === clockNow.todayIso ? departure.leave.time : null;
  return {
    placeId: item.place ? item.place.id : null,
    eventId: item.occurrence.eventId ?? null,
    observedOn: clockNow.todayIso,
    plannedDeparture: leave,
    arrivalAt,
    travelMinutes,
    overheadMinutes: overhead,
    arrivalResult: arrivalResultOf(departure, clockNow)
  };
}

function findDeparture(model, todayIso, occurrenceId) {
  return model.departures(todayIso).find(item => item.occurrence && item.occurrence.id === occurrenceId) || null;
}

const recordDeparted = singleFlight(async button => {
  const state = getState();
  const now = new Date();
  const clockNow = clockOf(now);
  const item = findDeparture(modelFor(state, now), clockNow.todayIso, button.dataset.occurrence);
  if (!item || !item.place) return { ok: false };
  setBusy(button, true, 'Kirjataan…');
  try {
    const result = await recordCommuteObservation(departureObservation(item, clockNow));
    if (result && result.ok) success(`Lähtö kirjattu ${clock(fromMinutes(clockNow.nowMinutes))}.`);
    else if (result && result.errors) showError(firstError(result.errors));
    return result;
  } finally {
    setBusy(button, false);
  }
});

const recordArrived = singleFlight(async button => {
  const state = getState();
  const now = new Date();
  const clockNow = clockOf(now);
  const item = findDeparture(modelFor(state, now), clockNow.todayIso, button.dataset.occurrence);
  if (!item || !item.place) return { ok: false };
  setBusy(button, true, 'Kirjataan…');
  try {
    const observation = arrivalObservation(item, clockNow, state.commuteObservations);
    const result = await recordCommuteObservation(observation);
    if (result && result.ok) {
      const travel = observation.travelMinutes ? ` Matka kesti ${durationText(observation.travelMinutes)}.` : '';
      success(`Perillä ${clock(observation.arrivalAt)}.${travel}`);
    } else if (result && result.errors) {
      showError(firstError(result.errors));
    }
    return result;
  } finally {
    setBusy(button, false);
  }
});

const openRoute = singleFlight(async button => {
  const state = getState();
  const now = new Date();
  const item = findDeparture(modelFor(state, now), clockOf(now).todayIso, button.dataset.occurrence);
  const target = routeTargetOf(item);
  if (!target || !nativeNavigation()) return;
  const result = await safe(() => platform.alarms.openNavigation({ destination: target.query, mode: target.mode }), null);
  if (!result || result.opened !== true) showError('Reittiä ei voitu avata. Tarkista, että karttasovellus on asennettu.');
});

// ------------------------------------------------------------ huominen

function weekendLines(state, model, todayIso) {
  const weekday = isoWeekday(todayIso);
  if (weekday !== 6 && weekday !== 7) return [];
  const settings = currentLifeSettings(state);
  const profile = state.profile || {};
  const lines = [];
  const drift = safe(() => driftReport({
    logs: state.sleepLogs || [], profile, settings, todayIso, offsetMinutesFn: deviceOffsetMinutes
  }), null);
  if (drift && drift.drifting && drift.message) lines.push(drift.message);
  const monday = shiftIso(todayIso, weekday === 6 ? 2 : 1);
  const mondaySchedule = model.sleep(monday);
  const recentWeekendWake = drift && drift.weekend && drift.weekend.meanWake ? drift.weekend.meanWake : null;
  if (mondaySchedule && recentWeekendWake) {
    const readiness = safe(() => mondayReadiness({
      todayIso, mondayWake: mondaySchedule.wakeTime, recentWeekendWake, settings, profile,
      offsetMinutesFn: deviceOffsetMinutes
    }), null);
    if (readiness && readiness.message) {
      lines.push(readiness.message);
      if (readiness.detail) lines.push(readiness.detail);
    }
  }
  return lines;
}

/** Huomisen ensimmäinen lähtö korttiin (sama valinta kuin Seuraava lähtö -kortissa). */
function tomorrowDeparture(model, tomorrow) {
  return model.departures(tomorrow)
    .filter(relevantDeparture)
    .sort((a, b) => a.departure.eventStart.abs - b.departure.eventStart.abs)[0] || null;
}

function tomorrowCard(state, model, clockNow) {
  const tomorrow = shiftIso(clockNow.todayIso, 1);
  const schedule = model.sleep(tomorrow);
  if (!schedule) return '';
  const evening = clockNow.nowMinutes >= EVENING_CARD_FROM_MINUTES;
  const earlier = schedule.earlierThanUsualMinutes > 0;
  const weekend = weekendLines(state, model, clockNow.todayIso);
  if (!evening && !earlier && weekend.length === 0) return '';

  const settings = currentLifeSettings(state);
  const usual = safe(() => sleepScheduleFor({
    dateIso: tomorrow, profile: state.profile || {}, settings, requiredWake: null, offsetMinutesFn: deviceOffsetMinutes
  }), null);
  const advice = safe(() => eveningBefore({ tomorrowSchedule: schedule, usualSchedule: usual, settings, cause: 'commitment' }), null);

  const facts = [];
  facts.push(['Herätys', `${clock(schedule.wakeTime)}${earlier ? ` · ${durationText(schedule.earlierThanUsualMinutes)} tavallista aiemmin` : ''}`]);
  const first = tomorrowDeparture(model, tomorrow);
  if (first) {
    const title = first.occurrence.title || 'Meno';
    facts.push(['Lähtö', first.departure.known && first.departure.leave
      ? `${clock(first.departure.leave.time)} · ${title} ${clock(first.occurrence.time)}`
      : `Matka-aika puuttuu · ${title} ${clock(first.occurrence.time)}`]);
  }
  if (schedule.windDownMinutes > 0) facts.push(['Iltarauhoittuminen', clock(schedule.windDownStart)]);
  facts.push(['Nukkumaanmeno', clock(schedule.bedtime)]);

  const factHtml = facts.map(([term, value]) =>
    `<div class="td-fact"><dt>${escapeHtml(term)}</dt> <dd>${escapeHtml(value)}</dd></div>`).join(' ');
  const notes = [advice && advice.message, ...weekend].filter(Boolean)
    .map(text => `<p class="td-note">${escapeHtml(text)}</p>`).join('');
  return `
    <section class="td-card" aria-labelledby="tdTomorrowTitle">
      <h2 class="section-title" id="tdTomorrowTitle" tabindex="-1">Huominen</h2>
      <div class="assist-row">
        <dl class="td-facts">${factHtml}</dl>
        ${notes}
        ${notes ? '<p class="hint">Nämä ovat ehdotuksia: mitään ei muuteta ilman sinua.</p>' : ''}
      </div>
    </section>`;
}

// ------------------------------------------------------------ aamu

function routineStepsOf(state) {
  const settings = currentLifeSettings(state);
  return Array.isArray(settings.morningRoutine) ? settings.morningRoutine : [];
}

/** Valinnan mukainen tämän aamun vaihejoukko. null = valinta ei muuta vaiheita. */
function stepsWithChoice(steps, choice) {
  if (!choice || choice.kind === CHOICE_KIND.WAKE_EARLIER) return null;
  if (choice.kind === CHOICE_KIND.DROP) return steps.filter(step => step.id !== choice.stepId);
  if (choice.kind === CHOICE_KIND.SHORTEN) {
    return steps.map(step => (step.id === choice.stepId ? { ...step, minutes: choice.newMinutes } : step));
  }
  return null;
}

/**
 * Aamun suunnitelma ja valinnat.
 *
 * Jos suunniteltu herätys on jo mennyt, aikaisin mahdollinen herätys on
 * nyt: silloin näytetään, mahtuuko aamu vielä, ja valinnoista puuttuu
 * "herää aiemmin". Jos aamu vaatii tavallista aiemman herätyksen,
 * valinnat kertovat, mitä voisi jättää pois sen sijaan.
 */
export function morningView(model, clockNow, choiceId = null) {
  const base = model.morning(clockNow.todayIso);
  if (!base || !base.commitment || !isTimeOfDay(base.anchorTime)) return null;
  const anchorMinutes = toMinutes(base.anchorTime);
  if (anchorMinutes >= MORNING_CARD_BEFORE_MINUTES || clockNow.nowMinutes >= anchorMinutes) return null;

  const awake = base.wakeDate === clockNow.todayIso && clockNow.nowMinutes > toMinutes(base.wakeTime);
  let limit = null;
  if (awake) limit = fromMinutes(clockNow.nowMinutes);
  else if (base.earlierThanUsualMinutes > 0) limit = base.usualWakeTime;
  const limited = limit ? model.morning(clockNow.todayIso, { wakeTimeLimit: limit }) : null;
  const choices = limited && !limited.fits
    ? limited.choices.filter(choice => !(awake && choice.kind === CHOICE_KIND.WAKE_EARLIER))
    : [];
  const chosen = choiceId ? choices.find(choice => choice.id === choiceId) || null : null;

  // Näytettävä suunnitelma: hereillä ollessa rajattu (mahtuuko vielä),
  // muuten perussuunnitelma; valinta lasketaan samalla rajalla uudelleen.
  let plan = awake && limited ? limited : base;
  let emptied = false;
  if (chosen) {
    const steps = stepsWithChoice(routineStepsOf(model.state), chosen);
    if (steps && steps.length === 0) emptied = true;
    else if (steps) plan = model.morning(clockNow.todayIso, { wakeTimeLimit: limit, steps }) || plan;
    else plan = base;
  }
  // Hereillä oleva on jo herännyt: herätykseksi ei näytetä nykyhetkeä.
  const wakeTime = awake ? base.wakeTime : plan.wakeTime;
  return { base, limited, plan, choices, chosen, awake, emptied, wakeTime };
}

function morningCard(model, clockNow) {
  const current = uiState();
  const choiceId = current.morningChoice && current.morningChoice.todayIso === clockNow.todayIso
    ? current.morningChoice.choiceId : null;
  const view = morningView(model, clockNow, choiceId);
  if (!view) return '';
  const { plan, choices, chosen, awake, emptied, limited, wakeTime } = view;
  const commitment = plan.commitment || view.base.commitment;
  const leave = plan.leaveTime ? ` · lähtö ${clock(plan.leaveTime)}` : '';
  const steps = emptied ? '' : plan.steps.map(step => `
    <li><span class="td-step-time">${escapeHtml(`${clockText(step.start)}–${clockText(step.end)}`)}</span>
      ${escapeHtml(step.name)} <span class="td-tag">${escapeHtml(protectionLabel(step.protection))}</span></li>`).join('');
  let status = '';
  if (chosen) {
    status = plan.fits || emptied
      ? 'Valinnalla aamu mahtuu.'
      : `Valinnalla aamu ei vielä mahdu: aikaa puuttuu ${durationText(plan.shortfallMinutes)}.`;
  } else if (limited && !limited.fits) {
    status = awake
      ? `Aamu ei enää mahdu: aikaa puuttuu ${durationText(limited.shortfallMinutes)}. Valitse, mitä jätät pois tai lyhennät.`
      : limited.explanation;
  }
  const shortfall = status ? `<p class="td-note">${escapeHtml(status)}</p>` : '';
  const choiceHtml = choices.length > 0 ? `
    <div class="assist-actions td-choices" role="group" aria-label="Aamun valinnat">
      ${choices.map(choice => `<button type="button" class="assist-btn" data-td-action="morning-choice"
        data-choice="${escapeHtml(choice.id)}" aria-pressed="${chosen && chosen.id === choice.id ? 'true' : 'false'}">${escapeHtml(choice.label)}</button>`).join('')}
    </div>` : '';
  const chosenHtml = chosen ? `
    <p class="td-note" role="status">Valintasi tälle aamulle: ${escapeHtml(String(chosen.label).replace(/\.\s*$/u, ''))}. Asetuksesi eivät muutu.</p>
    ${emptied ? '<p class="hint">Aamurutiini jää tältä aamulta pois.</p>' : ''}
    <div class="assist-actions"><button type="button" class="assist-btn" data-td-action="morning-undo">Peru valinta</button></div>` : '';
  return `
    <section class="td-card" aria-labelledby="tdMorningTitle">
      <h2 class="section-title" id="tdMorningTitle" tabindex="-1">Aamu</h2>
      <div class="assist-row">
        <div class="assist-title">${escapeHtml(commitment ? commitment.title || 'Meno' : 'Meno')}</div>
        <div class="assist-meta">alkaa ${escapeHtml(clock(commitment ? commitment.startTime : null))}${escapeHtml(leave)} · herätys ${escapeHtml(clock(wakeTime))}</div>
        ${steps ? `<ol class="td-steps">${steps}</ol>` : ''}
        ${shortfall || `<p class="hint">${escapeHtml(plan.explanation || '')}</p>`}
        ${chosen ? chosenHtml : choiceHtml}
      </div>
    </section>`;
}

// ------------------------------------------------------------ tavat

function habitCards(state, now) {
  const plans = (state.habitPlans || [])
    .filter(plan => plan && plan.active !== false && plan.kind === HABIT_KIND.NICOTINE)
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'fi') || String(a.id).localeCompare(String(b.id), 'fi'));
  if (plans.length === 0) return '';
  const nowMs = now.getTime();
  const rows = plans.map(plan => {
    const current = habitStatus({ plan, events: state.habitEvents || [], nowMs, timeZone: timeZone() });
    if (!current) return '';
    const headline = current.state === HABIT_STATE.OK_NOW ? 'Nyt on suunniteltu aika.' : current.text;
    const count = Number.isInteger(current.usesToday)
      ? `Tänään ${current.usesToday} ${current.usesToday === 1 ? 'kerta' : 'kertaa'}`
        + (current.dailyTarget !== null ? `, suunnitelmassa ${current.dailyTarget}.` : '.')
      : '';
    const name = plan.name || 'Tapa';
    const button = (action, label) => `<button type="button" class="assist-btn" data-td-action="habit"
      data-habit-action="${action}" data-plan="${escapeHtml(plan.id)}" aria-label="${escapeHtml(`${label}: ${name}`)}">${escapeHtml(label)}</button>`;
    return `
      <li class="assist-row">
        <div class="assist-title">${escapeHtml(name)}</div>
        <p class="td-phase">${escapeHtml(headline || '')}</p>
        ${count ? `<div class="assist-meta">${escapeHtml(count)}</div>` : ''}
        <div class="assist-actions">
          ${button(HABIT_ACTION.USE, 'Kirjaa nyt')}${button(HABIT_ACTION.DELAY, 'Siirrä 15 min')}${button(HABIT_ACTION.SKIP, 'Ohita')}
        </div>
      </li>`;
  }).join('');
  return `
    <section class="td-card" aria-labelledby="tdHabitsTitle">
      <h2 class="section-title" id="tdHabitsTitle" tabindex="-1">Tapojen muutos</h2>
      <ul class="td-list">${rows}</ul>
      <p class="hint">Kirjaus on tieto sinulle, ei arvosana.</p>
    </section>`;
}

const recordHabit = singleFlight(async button => {
  const planId = button.dataset.plan;
  const action = button.dataset.habitAction;
  if (!HABIT_ACTIONS.includes(action)) return { ok: false };
  setBusy(button, true);
  try {
    const result = await logHabitEvent({ planId, action, nowIso: new Date().toISOString() });
    if (result && result.ok) {
      const state = getState();
      const nowMs = Date.now();
      const plan = (state.habitPlans || []).find(entry => entry.id === planId) || null;
      const next = habitStatus({ plan, events: state.habitEvents || [], nowMs, timeZone: timeZone() });
      success(habitActionText(action, { nextAtMs: next ? next.nextAtMs : null, nowMs, timeZone: timeZone() }) || 'Kirjattu.');
    } else if (result && result.errors) {
      showError(firstError(result.errors));
    }
    return result;
  } finally {
    setBusy(button, false);
  }
});

// ------------------------------------------------------------ avoimet asiat

/**
 * Avoin asia: keskeneräinen tehtävä ilman omaa ajankohtaa -- ei päivää, tai
 * päivä on sama kuin määräaika eikä kellonaikaa ("käydä Motonetissä tällä
 * viikolla" tallentuu sunnuntaille ilman kellonaikaa, src/app/localCommands.js).
 * Tehtävällä on aina päivä (validateTask), joten jälkimmäinen on se muoto,
 * jossa puheesta luotu avoin asia oikeasti on.
 */
function isOpenEnded(task) {
  if (!task || task.completed || !task.deadline) return false;
  return !task.date || (task.date === task.deadline && !task.time);
}

/** Avoimet asiat, joiden määräaika on seuraavan viikon aikana. */
export function openEndedTasks(state, todayIso) {
  const last = shiftIso(todayIso, DEFAULT_HORIZON_DAYS - 1);
  return (state.tasks || [])
    .filter(task => isOpenEnded(task) && task.deadline >= todayIso && task.deadline <= last)
    .sort((a, b) => a.deadline.localeCompare(b.deadline) || byTitle(a, b));
}

function errandTask(task, state) {
  return {
    id: task.id,
    title: task.title,
    durationMinutes: durationOf(task) ?? task.durationMinutes ?? null,
    deadline: task.deadline || null,
    placeId: placeIdForText(task.title, state.savedPlaces, state.placeAliases),
    lifeAreaId: task.lifeAreaId || null
  };
}

/** Asiointiehdotukset: avoimet asiat, jotka voi hoitaa jo suunnitellun menon yhteydessä. */
export function errandGroups(state, todayIso) {
  const tasks = (state.tasks || [])
    // Päivätön tai avoin asia (päivä = määräaika, ei kellonaikaa), ks. isOpenEnded.
    .filter(task => task && !task.completed && !task.time && (!task.date || isOpenEnded(task)))
    .map(task => ({ ...errandTask(task, state), completed: false, time: null }))
    .filter(task => task.placeId);
  if (tasks.length === 0) return EMPTY;
  const last = shiftIso(todayIso, DEFAULT_HORIZON_DAYS - 1);
  const trips = expandEventOccurrences({ events: state.calendarEvents || [], from: todayIso, to: last });
  return groupErrands({ tasks, trips, places: state.savedPlaces || [], todayIso, weekEndIso: last }).slice(0, MAX_ERRAND_GROUPS);
}


/**
 * Aikaehdotus avoimelle asialle: ennen määräaikaa, päivän kuorman rajoissa,
 * mieluiten saman paikan tai alueen menon yhteydessä. Ei muuta mitään.
 */
export function errandProposal(task, { state = getState(), now = new Date() } = {}) {
  const clockNow = clockOf(now);
  const model = modelFor(state, now);
  const weekEnd = shiftIso(clockNow.todayIso, DEFAULT_HORIZON_DAYS - 1);
  const last = task.deadline && task.deadline >= clockNow.todayIso && task.deadline < weekEnd ? task.deadline : weekEnd;
  const { days, calendar } = horizonDays(clockNow.todayIso, last, { state, now, model, clockNow });
  return proposeOpenEndedSlot({
    task: errandTask(task, state),
    days,
    trips: calendar.events,
    places: state.savedPlaces || [],
    todayIso: clockNow.todayIso,
    weekEndIso: weekEnd,
    nowMinutes: clockNow.nowMinutes
  });
}

function whenText(option) {
  return `${shortDateLabel(option.date)} ${clock(option.time)}–${clockText(option.endTime)}`;
}

function errandProposalHtml(pending) {
  const { result } = pending;
  if (!result.proposal) {
    return `
      <div class="td-proposal" role="group" aria-labelledby="tdErrandTitle">
        <h3 class="td-subtitle" id="tdErrandTitle" tabindex="-1">Ehdotus</h3>
        <p class="hint">${escapeHtml(result.reason)}</p>
        <div class="assist-actions"><button type="button" class="assist-btn" data-td-action="errand-cancel">Sulje</button></div>
      </div>`;
  }
  const alternatives = result.alternatives.map((option, index) => `
    <li class="td-alt">
      <span class="td-when">${escapeHtml(whenText(option))}</span>
      <button type="button" class="assist-btn" data-td-action="errand-accept" data-index="${index + 1}"
        aria-label="${escapeHtml(`Valitse ${whenText(option)}`)}">Valitse</button>
      <p class="hint">${escapeHtml(option.reason)}</p>
    </li>`).join('');
  return `
    <div class="td-proposal" role="group" aria-labelledby="tdErrandTitle">
      <h3 class="td-subtitle" id="tdErrandTitle" tabindex="-1">Ehdotus: ${escapeHtml(whenText(result.proposal))}</h3>
      <p class="hint">${escapeHtml(result.proposal.reason)}</p>
      <div class="assist-actions">
        <button type="button" class="assist-btn primary" data-td-action="errand-accept" data-index="0">Hyväksy</button>
        <button type="button" class="assist-btn" data-td-action="errand-cancel">Peruuta</button>
      </div>
      ${alternatives ? `<p class="td-subtitle">Muut vaihtoehdot</p><ul class="td-list">${alternatives}</ul>` : ''}
    </div>`;
}

function openEndedCard(state, clockNow) {
  const current = uiState();
  const tasks = openEndedTasks(state, clockNow.todayIso);
  const groups = safe(() => errandGroups(state, clockNow.todayIso), EMPTY);
  if (tasks.length === 0 && groups.length === 0) return '';
  const places = new Map((state.savedPlaces || []).map(place => [place.id, place]));
  const pending = current.errand && current.errand.todayIso === clockNow.todayIso ? current.errand : null;
  const rows = tasks.slice(0, MAX_OPEN_ENDED_ROWS).map(task => {
    const placeId = placeIdForText(task.title, state.savedPlaces, state.placeAliases);
    const place = placeId ? places.get(placeId) : null;
    const open = pending && pending.taskId === task.id;
    return `
      <li class="assist-row">
        <div class="assist-title">${escapeHtml(task.title)}</div>
        <div class="assist-meta">Määräaika ${escapeHtml(shortDateLabel(task.deadline))}${place ? ` · ${escapeHtml(place.name)}` : ''}</div>
        <div class="assist-actions">
          <button type="button" class="assist-btn" data-td-action="errand-propose" data-task="${escapeHtml(task.id)}"
            aria-expanded="${open ? 'true' : 'false'}" aria-label="${escapeHtml(`Ehdota aikaa: ${task.title}`)}">Ehdota aikaa</button>
        </div>
        ${open ? errandProposalHtml(pending) : ''}
      </li>`;
  }).join('');
  const more = tasks.length > MAX_OPEN_ENDED_ROWS
    ? `<p class="hint">+ ${tasks.length - MAX_OPEN_ENDED_ROWS} muuta Tekeminen-näkymässä.</p>` : '';
  const groupHtml = groups.map(group => `<p class="td-note">${escapeHtml(group.text)}</p>`).join('');
  return `
    <section class="td-card" aria-labelledby="tdOpenTitle">
      <h2 class="section-title" id="tdOpenTitle" tabindex="-1">Avoimet asiat${tasks.length ? ` <span class="count-badge">${tasks.length}</span>` : ''}</h2>
      ${groupHtml}
      ${rows ? `<ul class="td-list">${rows}</ul>` : ''}
      ${more}
    </section>`;
}

function proposeErrand(button) {
  const current = uiState();
  const taskId = button.dataset.task;
  if (current.errand && current.errand.taskId === taskId) {
    current.errand = null;
    rerender();
    return;
  }
  const state = getState();
  const now = new Date();
  const task = (state.tasks || []).find(entry => entry.id === taskId);
  if (!task) return;
  const result = safe(() => errandProposal(task, { state, now }), null);
  if (!result) {
    showError('Ehdotusta ei voitu laskea. Yritä uudelleen.');
    return;
  }
  current.errand = { taskId, todayIso: clockOf(now).todayIso, result };
  rerender();
  focusById('tdErrandTitle');
}

const acceptErrand = singleFlight(async button => {
  const current = uiState();
  const pending = current.errand;
  if (!pending || !pending.result) return { ok: false };
  const index = Number(button.dataset.index);
  const option = index === 0 ? pending.result.proposal : pending.result.alternatives[index - 1];
  if (!option) return { ok: false };
  setBusy(button, true, 'Tallennetaan…');
  try {
    const result = await editTask(pending.taskId, {
      date: option.date, time: option.time, endTime: option.endTime, durationMinutes: option.durationMinutes
    });
    if (result && result.ok) {
      if (current.errand === pending) current.errand = null;
      success(`Aika sovittu: ${whenText(option)}.`);
      rerender();
      focusById('tdOpenTitle');
    } else if (result && result.errors) {
      showError(firstError(result.errors));
    }
    return result;
  } finally {
    setBusy(button, false);
  }
});

// ------------------------------------------------------------ keskeytykset

function hasDayContent(plan) {
  if (!plan) return false;
  const count = list => (Array.isArray(list) ? list.length : 0);
  return count(plan.scheduled) + count(plan.unscheduled) + count(plan.fixedRoutines)
    + count(plan.flexibleRoutines) + count(plan.eventItems) > 0;
}


/** Keskeytyksen ehdotus nykyisestä päivästä (sama polku kuin komentopalkilla). Ei muuta mitään. */
export function interruptionPreview(kind, minutes = null, { state = getState(), now = new Date() } = {}) {
  return previewDayReplan({ kind, minutes }, { state, now });
}

function slotText(slot) {
  if (!slot) return 'jää tänään väliin';
  if (slot.time) return `klo ${clockText(slot.time)}${slot.endTime ? `–${clockText(slot.endTime)}` : ''}`;
  return slot.date ? shortDateLabel(slot.date) : '';
}

function changeLine(change, todayIso) {
  let to;
  if (change.kind === REPLAN_CHANGE.SKIP) to = change.to ? 'ilman kellonaikaa' : 'jää tänään väliin';
  else if (change.kind === REPLAN_CHANGE.DEFER) to = change.to && change.to.date !== todayIso ? shortDateLabel(change.to.date) : 'myöhemmin';
  else to = slotText(change.to);
  const from = change.from && change.from.time ? slotText(change.from) : 'ilman kellonaikaa';
  return `${change.title}: ${from} → ${to}`;
}

function previewHtml(pending, state, todayIso) {
  const { result } = pending;
  const { applicable, informational } = splitReplanChanges(result.changes, state);
  const items = applicable.map(change => `
    <li><strong>${escapeHtml(changeLine(change, todayIso))}</strong><span class="td-reason">${escapeHtml(change.reason)}</span></li>`).join('');
  const info = informational.map(change => `
    <li>${escapeHtml(changeLine(change, todayIso))}<span class="td-reason">Rutiinin tallennettu aika ei muutu; siirrä tämä kerta itse, jos haluat.</span></li>`).join('');
  const warnings = result.warnings.map(text => `<p class="td-note">${escapeHtml(text)}</p>`).join('');
  const question = result.question ? `<p class="td-note">${escapeHtml(result.question)}</p>` : '';
  return `
    <div class="td-proposal" role="group" aria-labelledby="tdReplanTitle">
      <h3 class="td-subtitle" id="tdReplanTitle" tabindex="-1">Ehdotus: ${escapeHtml(INTERRUPTION_LABEL[pending.kind] || '')}${pending.minutes ? ` ${escapeHtml(durationText(pending.minutes))}` : ''}</h3>
      <p class="hint">${escapeHtml(result.summary)}</p>
      ${items ? `<ul class="td-list td-changes">${items}</ul>` : ''}
      ${info ? `<p class="td-subtitle">Vain tiedoksi</p><ul class="td-list td-changes">${info}</ul>` : ''}
      ${question}${warnings}
      <div class="assist-actions">
        ${applicable.length > 0 ? '<button type="button" class="assist-btn primary" data-td-action="replan-apply">Tee muutokset</button>' : ''}
        <button type="button" class="assist-btn" data-td-action="replan-cancel">${applicable.length > 0 ? 'Peruuta' : 'Sulje'}</button>
      </div>
    </div>`;
}

function interruptionCard(state, clockNow, plan) {
  const current = uiState();
  if (current.replan && current.replan.todayIso !== clockNow.todayIso) current.replan = null;
  if (!hasDayContent(plan) && !current.replan) return '';
  const picker = current.picker;
  const kindButton = kind => `<button type="button" class="assist-btn" data-td-action="interrupt" data-kind="${kind}"
    ${kind === INTERRUPTION_KIND.DEFER_REMAINING ? '' : `aria-expanded="${picker === kind ? 'true' : 'false'}"`}>${escapeHtml(INTERRUPTION_LABEL[kind])}</button>`;
  const choices = picker === INTERRUPTION_KIND.RUNNING_LATE ? LATE_MINUTE_CHOICES : EXTEND_MINUTE_CHOICES;
  const pickerHtml = picker ? `
    <div class="td-picker" role="group" aria-labelledby="tdPickerTitle">
      <p class="td-subtitle" id="tdPickerTitle">${picker === INTERRUPTION_KIND.RUNNING_LATE ? 'Kuinka paljon olet myöhässä?' : 'Kuinka paljon lisäaikaa tarvitset?'}</p>
      <div class="assist-actions">
        ${choices.map(minutes => `<button type="button" class="assist-btn" data-td-action="minutes" data-minutes="${minutes}">${minutes} min</button>`).join('')}
      </div>
    </div>` : '';
  return `
    <section class="td-card" aria-labelledby="tdInterruptTitle">
      <h2 class="section-title" id="tdInterruptTitle" tabindex="-1">Jos päivä muuttuu</h2>
      <div class="assist-actions td-interrupt-actions">
        ${kindButton(INTERRUPTION_KIND.RUNNING_LATE)}${kindButton(INTERRUPTION_KIND.EXTEND_CURRENT)}${kindButton(INTERRUPTION_KIND.DEFER_REMAINING)}
      </div>
      ${pickerHtml}
      ${current.replan ? previewHtml(current.replan, state, clockNow.todayIso) : ''}
      <p class="hint">Näet ehdotuksen ensin. Mitään ei muuteta ennen kuin vahvistat, eivätkä kiinteät menot tai suojattu lepo liiku.</p>
    </section>`;
}

function showPreview(kind, minutes) {
  const current = uiState();
  const now = new Date();
  const result = safe(() => interruptionPreview(kind, minutes, { state: getState(), now }), null);
  current.picker = null;
  if (!result) {
    current.replan = null;
    showError('Ehdotusta ei voitu laskea. Päivän suunnitelma pysyy ennallaan.');
    rerender();
    return;
  }
  current.replan = { kind, minutes, todayIso: clockOf(now).todayIso, result };
  rerender();
  focusById('tdReplanTitle');
}

function startInterruption(button) {
  const kind = button.dataset.kind;
  const current = uiState();
  if (kind === INTERRUPTION_KIND.DEFER_REMAINING) {
    showPreview(kind, null);
    return;
  }
  if (kind !== INTERRUPTION_KIND.RUNNING_LATE && kind !== INTERRUPTION_KIND.EXTEND_CURRENT) return;
  current.picker = current.picker === kind ? null : kind;
  current.replan = null;
  rerender();
}

function chooseMinutes(button) {
  const current = uiState();
  const minutes = Number(button.dataset.minutes);
  if (!current.picker || !Number.isInteger(minutes) || minutes <= 0) return;
  showPreview(current.picker, minutes);
}





/**
 * Vahvista ja tee keskeytyksen ehdotus. Vahvistus kysytään AINA ennen
 * ensimmäistäkään muutosta; peruttu vahvistus jättää päivän ennalleen.
 */
export async function applyReplanPreview({ confirm = confirmAction, button = null } = {}) {
  const current = uiState();
  const pending = current.replan;
  if (!pending) return { ok: false };
  const { applicable } = splitReplanChanges(pending.result.changes, getState());
  if (applicable.length === 0) return { ok: false };
  const confirmed = await confirm({
    title: 'Muutetaanko päivän suunnitelmaa?',
    message: `${applicable.length === 1 ? '1 muutos' : `${applicable.length} muutosta`}: ${applicable.map(change => change.title).join(', ')}. `
      + 'Kiinteät menot, matkat ja suojattu lepo pysyvät ennallaan.',
    confirmLabel: 'Tee muutokset'
  });
  if (!confirmed) return { ok: false, cancelled: true };
  // Istunto tai ehdotus vaihtui vahvistuksen aikana: vanhaa ei tehdä.
  if (current !== uiState() || current.replan !== pending) return { ok: false, discarded: true };
  if (applicable.some(change => isStaleChange(change, getState()))) {
    notify('Päivän suunnitelma muuttui välillä. Katso ehdotus uudelleen ennen muutoksia.');
    showPreview(pending.kind, pending.minutes);
    return { ok: false, stale: true };
  }
  setBusy(button, true, 'Tallennetaan…');
  try {
    const outcome = await applyReplanChanges(applicable);
    if (outcome.ok) {
      if (current.replan === pending) current.replan = null;
      success(outcome.applied === 1 ? 'Muutos tehty.' : `${outcome.applied} muutosta tehty.`);
      rerender();
      focusById('tdInterruptTitle');
    } else {
      showError('Muutoksia ei voitu tallentaa. Jo tehdyt muutokset peruttiin.');
    }
    return outcome;
  } finally {
    setBusy(button, false);
  }
}

const applyReplanClick = singleFlight(button => applyReplanPreview({ button }));

function cancelReplan() {
  const current = uiState();
  current.replan = null;
  current.picker = null;
  rerender();
  focusById('tdInterruptTitle');
}

// ------------------------------------------------------------ piirto

let lastContext = null;

function focusById(id) {
  const node = maybe(id);
  if (node && typeof node.focus === 'function') node.focus();
}

function card(id, build) {
  try {
    return build();
  } catch {
    // Yhden kortin laskentavirhe ei saa kaataa koko päivänäkymää.
    logEvent('today.card_failed', { code: id });
    return '';
  }
}

/**
 * Piirrä arjen kortit. Kutsutaan renderToday-funktiosta samalla tilalla ja
 * kellolla kuin muu päivänäkymä. Kortit näkyvät vain kuluvana päivänä ja
 * vain, kun niillä on sanottavaa: tyhjä kortti olisi melua.
 *
 * @param {object} context
 * @param {object} [context.state]
 * @param {Date}   [context.now]
 * @param {boolean} context.isToday
 * @param {object} [context.plan] päivän suunnitelma (dayPlanFor)
 * @param {object} [context.model] saman piirron malli (modelFor samalla tilalla ja kellolla)
 */
export function renderTodayDailyLife({
  state = getState(), now = new Date(), isToday = true, plan = null, model: given = null
} = {}) {
  lastContext = { isToday };
  const clockNow = clockOf(now);
  const model = given && given.state === state && given.now === now ? given : modelFor(state, now);
  const dayPlan = plan || (isToday
    ? safe(() => dayPlanFor(clockNow.todayIso, { state, now, nowMinutes: clockNow.nowMinutes, todayIso: clockNow.todayIso, model }), null)
    : null);
  const builders = {
    todayDeparture: () => departureCard(model, clockNow, state),
    todayMorning: () => morningCard(model, clockNow),
    todayHabits: () => habitCards(state, now),
    todayInterruptions: () => interruptionCard(state, clockNow, dayPlan),
    todayOpenEnded: () => openEndedCard(state, clockNow),
    todayTomorrow: () => tomorrowCard(state, model, clockNow)
  };
  for (const [id, heading] of Object.entries(CONTAINERS)) {
    const container = maybe(id);
    if (!container) continue;
    const html = isToday ? card(id, builders[id]) : '';
    renderHtml(container, html, { fallback: [heading, 'todayTitle'] });
  }
}

/** Näkymän oma muutos (esikatselu, valinta): piirretään nykyisellä tilalla. */
function rerender() {
  if (!lastContext) return;
  renderTodayDailyLife({ state: getState(), now: new Date(), isToday: lastContext.isToday });
}

// ------------------------------------------------------------ kytkennät

function chooseMorning(button) {
  const current = uiState();
  const todayIso = clockOf(new Date()).todayIso;
  const choiceId = button.dataset.choice;
  current.morningChoice = current.morningChoice && current.morningChoice.choiceId === choiceId
    ? null : { todayIso, choiceId };
  rerender();
  focusById('tdMorningTitle');
}

function undoMorning() {
  uiState().morningChoice = null;
  rerender();
  focusById('tdMorningTitle');
}

const ACTIONS = Object.freeze({
  departed: button => recordDeparted(button),
  arrived: button => recordArrived(button),
  route: button => openRoute(button),
  habit: button => recordHabit(button),
  'morning-choice': chooseMorning,
  'morning-undo': undoMorning,
  interrupt: startInterruption,
  minutes: chooseMinutes,
  'replan-apply': button => applyReplanClick(button),
  'replan-cancel': cancelReplan,
  'errand-propose': proposeErrand,
  'errand-accept': button => acceptErrand(button),
  'errand-cancel': () => {
    uiState().errand = null;
    rerender();
    focusById('tdOpenTitle');
  }
});

/** Säiliöt, joihin kuuntelija on jo kytketty (sama säiliö ei saa kahta). */
const wired = new WeakSet();

/**
 * Kytke korttien painikkeet kerran: kuuntelija on säiliössä, ei piirretyissä
 * solmuissa, koska renderHtml ei kirjoita muuttumatonta merkintää uudelleen.
 * Turvallinen kutsua useammin (ks. initTodayNavigation).
 */
export function initTodayDailyLife() {
  for (const id of Object.keys(CONTAINERS)) {
    const container = maybe(id);
    if (!container || wired.has(container)) continue;
    wired.add(container);
    container.addEventListener('click', event => {
      const target = event.target && typeof event.target.closest === 'function'
        ? event.target.closest('[data-td-action]') : null;
      if (!target || target.disabled) return;
      const action = ACTIONS[target.dataset.tdAction];
      if (!action) return;
      Promise.resolve()
        .then(() => action(target))
        .catch(() => {
          logEvent('today.action_failed', { code: String(target.dataset.tdAction || '') });
          showError('Toiminto ei onnistunut. Yritä uudelleen.');
        });
    });
  }
}

// Yksi polku: esikatselu ja toteutus ovat src/app/dayReplanActions.js:ssä.
export { splitReplanChanges, taskPatch, applyReplanChanges };
