// Laitteen herätys- ja muistutustapahtumat: kuittaus, torkku, hylkäys ja
// "Lähdin".
//
// MISTÄ TAPAHTUMAT TULEVAT
// Android-sovelluksen ManifestivalAlarm-liitännäinen kirjaa käyttäjän
// painallukset laitteelle myös sovelluksen ollessa kiinni. Sovellus lukee
// ne (alarms.consumeEvents), kun se avataan tai palaa etualalle, ja saa
// ne suoraan (alarms.onEvent), kun se on auki. Alustasovitin poistaa
// kaksoiskappaleet järjestysnumerolla (seq).
//
// MIHIN NE MENEVÄT
//   - kuittauslokiin (src/domain/notificationAck.js), joka on laitteella
//     käyttäjäkohtaisella avaimella (src/data/alarmAckStore.js). Loki
//     kertoo seuraavalle ajastukselle, mitä käyttäjä on jo tehnyt:
//     kuitattua ei toisteta, torkutettu tulee torkun lopussa.
//   - "Lähdin" (departed) kuittaa koko lähtöketjun (valmistaudu, 5 min,
//     nyt), ja jos menolla on tallennettu paikka, siitä tulee käyttäjän
//     vahvistama matkahavainto (lähde: departure_ack). Ei sijaintia: vain
//     painalluksen hetki.
//
// ISTUNTO VOI VAIHTUA ODOTUKSEN AIKANA. Tapahtumat kuuluvat sille, jonka
// herätykset ne olivat. Jos käyttäjä vaihtui laitteen jonon luvun aikana,
// tapahtumia ei kirjata uuden käyttäjän lokiin.
//
// EI HEITÄ. Selaimessa tapahtumia ei ole (liitännäistä ei ole), ja kaikki
// palauttaa tyhjän tuloksen.

import { alarms } from '../platform/index.js';
import { getState } from './state.js';
import { sessionSnapshot, isSameSession } from '../data/session.js';
import { loadAckState, saveAckState, clearAllAckStates, normalizeAckTarget, MAX_ACK_TARGETS } from '../data/alarmAckStore.js';
import { emptyAckLog, buildAckLog, normalizeAckLog, ACK_EVENT } from '../domain/notificationAck.js';
import { DEPARTURE_CHAIN_TYPES, intentId } from '../domain/notification.js';
import { OBSERVATION_SOURCE } from '../domain/dailyLife.js';
import { epochToWallClock } from '../domain/wallClock.js';
import { deviceOffsetMinutes } from './deviceTime.js';
import { recordCommuteObservation } from './dailyLifeActions.js';
import { logEvent } from '../lib/logger.js';

/** Laitteen tapahtumat (platform/alarms.js ALARM_EVENT). Toistettu: sovellus ei tuo alustan sisäosia. */
export const DEVICE_EVENT = Object.freeze({
  ACKNOWLEDGED: 'acknowledged',
  SNOOZED: 'snoozed',
  DISMISSED: 'dismissed',
  DEPARTED: 'departed'
});

const MINUTE_MS = 60000;
const DEPARTURE_ID = /^(departure_prepare|departure_leave_in_5|departure_leave_now):(event:([A-Za-z0-9_-]+):(\d{4}-\d{2}-\d{2})):(\d{4}-\d{2}-\d{2})/;
const SUFFIX = /:(?:toisto\d+|torkku)$/;

let activeUserId = null;
let ackLog = emptyAckLog();
let targets = Object.freeze([]);
let unsubscribeLive = null;
let onChange = () => {};

/** Voimassa oleva kuittausloki (muistissa; laitteella käyttäjäkohtaisesti). */
export function currentAckLog() {
  return ackLog;
}

/** Laitteelle viimeksi ajastetut merkinnät (tunniste -> kuittausavain ja kohde). */
export function scheduledTargets() {
  return targets;
}

function persist() {
  if (!activeUserId) return;
  saveAckState(activeUserId, { log: ackLog, targets });
}

/**
 * Ota käyttäjän kuittausmuisti käyttöön ja kuuntele elävät tapahtumat.
 * Kutsutaan kirjautumisen jälkeen. `changed` ajetaan, kun loki muuttui
 * (main.js ajastaa silloin herätykset ja muistutukset uudelleen).
 */
export function activateAlarmEvents(userId, { changed = null } = {}) {
  stopLive();
  activeUserId = typeof userId === 'string' && userId ? userId : null;
  onChange = typeof changed === 'function' ? changed : () => {};
  const stored = activeUserId ? loadAckState(activeUserId) : { log: emptyAckLog(), targets: [] };
  ackLog = normalizeAckLog(stored.log);
  targets = Object.freeze([...stored.targets]);
  if (!activeUserId) return;
  const session = sessionSnapshot();
  unsubscribeLive = alarms.onEvent(event => {
    if (!isSameSession(session)) return;
    handleAlarmEvents([event], { session }).catch(() => {});
  });
}

function stopLive() {
  if (typeof unsubscribeLive === 'function') {
    try { unsubscribeLive(); } catch { /* jo poistettu */ }
  }
  unsubscribeLive = null;
}

/**
 * Uloskirjautuminen: kuuntelu pois, muisti tyhjäksi ja laitteen
 * kuittausmuistit pois (laitteen herätykset perutaan samalla).
 */
export function resetAlarmEvents({ clearStorage = true } = {}) {
  stopLive();
  activeUserId = null;
  ackLog = emptyAckLog();
  targets = Object.freeze([]);
  onChange = () => {};
  if (clearStorage) clearAllAckStates();
}

/**
 * Muista, mitä laitteelle ajastettiin (tunniste -> kuittausavain, meno,
 * paikka). Uudemmat ensin; vanhoja pidetään rajaan asti, jotta myöhään
 * luettu tapahtuma löytää vielä kohteensa.
 */
export function rememberScheduledTargets(list) {
  if (!activeUserId) return;
  const next = [];
  const seen = new Set();
  for (const raw of [...(Array.isArray(list) ? list : []), ...targets]) {
    const target = normalizeAckTarget(raw);
    if (!target || seen.has(target.id)) continue;
    seen.add(target.id);
    next.push(target);
    if (next.length >= MAX_ACK_TARGETS) break;
  }
  targets = Object.freeze(next);
  persist();
}

/** Kohteen tiedot laitteen tunnisteesta: ensin muistista, sitten tunnisteen rakenteesta. */
export function targetFor(id, { state = getState() } = {}) {
  const known = targets.find(target => target.id === id);
  if (known) return known;
  if (typeof id !== 'string') return null;
  let ackKey = id;
  while (SUFFIX.test(ackKey)) ackKey = ackKey.replace(SUFFIX, '');
  const departure = DEPARTURE_ID.exec(ackKey);
  if (!departure) return normalizeAckTarget({ id, ackKey });
  const eventId = departure[3];
  const event = findEventIn(state, eventId);
  return normalizeAckTarget({
    id, ackKey, type: departure[1], departureId: departure[2], eventId,
    placeId: event ? event.placeId : null, date: departure[4]
  });
}

function findEventIn(state, eventId) {
  const list = state && Array.isArray(state.calendarEvents) ? state.calendarEvents : [];
  return list.find(event => event && event.id === eventId) || null;
}

/** Torkun loppu seinäkelloaikana, pyöristettynä YLÖSPÄIN täyteen minuuttiin (ei koskaan ennen laitteen torkkua). */
function snoozeEndLocal(untilMs) {
  const rounded = Math.ceil(untilMs / MINUTE_MS) * MINUTE_MS;
  const wall = epochToWallClock(rounded, deviceOffsetMinutes);
  return wall ? { date: wall.date, time: wall.time } : null;
}

/** Lähtöketjun kaikki kuittausavaimet (valmistaudu, 5 min, nyt). */
function chainKeys(target) {
  if (!target || !target.departureId || !target.date) return [];
  return DEPARTURE_CHAIN_TYPES.map(type => intentId(type, target.departureId, target.date));
}

/** Yksi laitteen tapahtuma kuittauslokin tapahtumiksi. */
export function ackEventsFor(event, target) {
  if (!event || !target) return [];
  const atMs = event.atMs;
  switch (event.type) {
    case DEVICE_EVENT.ACKNOWLEDGED:
      return [{ type: ACK_EVENT.ACKNOWLEDGED, key: target.ackKey, atMs }];
    case DEVICE_EVENT.DISMISSED:
      return [{ type: ACK_EVENT.DISMISSED, key: target.ackKey, atMs }];
    case DEVICE_EVENT.SNOOZED:
      if (!Number.isFinite(event.untilMs)) return [];
      return [{
        type: ACK_EVENT.SNOOZED, key: target.ackKey, atMs, untilMs: event.untilMs,
        untilLocal: snoozeEndLocal(event.untilMs)
      }];
    case DEVICE_EVENT.DEPARTED: {
      // "Lähdin": koko ketju on hoidettu, myös vielä tulematta olevat vaiheet.
      const keys = new Set([target.ackKey, ...chainKeys(target)]);
      return [...keys].map(key => ({ type: ACK_EVENT.ACKNOWLEDGED, key, atMs }));
    }
    default:
      return [];
  }
}

/** Onko sama lähtö jo kirjattu (toinen lukukerta, kaksi laitetta, tupla-painallus)? */
function alreadyObserved(state, { eventId, placeId, observedOn }) {
  const list = state && Array.isArray(state.commuteObservations) ? state.commuteObservations : [];
  return list.some(observation => observation
    && observation.source === OBSERVATION_SOURCE.DEPARTURE_ACK
    && observation.placeId === placeId
    && observation.eventId === eventId
    && observation.observedOn === observedOn);
}

async function recordDeparture(event, target, session) {
  if (!target.placeId || !target.eventId) return false;
  const state = getState();
  if (!findEventIn(state, target.eventId)) return false;
  const wall = epochToWallClock(event.atMs, deviceOffsetMinutes);
  if (!wall) return false;
  const input = {
    placeId: target.placeId,
    eventId: target.eventId,
    observedOn: wall.date,
    plannedDeparture: target.leaveTime,
    actualDeparture: wall.time,
    source: OBSERVATION_SOURCE.DEPARTURE_ACK
  };
  if (alreadyObserved(state, input)) return false;
  if (!isSameSession(session)) return false;
  const result = await recordCommuteObservation(input);
  if (result && result.ok) logEvent('alarm.departed_recorded', { source: 'device' });
  return Boolean(result && result.ok);
}

/**
 * Käsittele laitteen tapahtumat: kuittausloki ja "Lähdin"-havainnot.
 * @returns {Promise<{recorded:number, departures:number}>}
 */
export async function handleAlarmEvents(events, { session = sessionSnapshot() } = {}) {
  if (!activeUserId || !Array.isArray(events) || events.length === 0) return { recorded: 0, departures: 0 };
  if (!isSameSession(session)) return { recorded: 0, departures: 0 };
  const state = getState();
  const ackEvents = [];
  const departures = [];
  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    const target = targetFor(event.id, { state });
    const produced = ackEventsFor(event, target);
    ackEvents.push(...produced);
    if (event.type === DEVICE_EVENT.DEPARTED && target) departures.push({ event, target });
  }
  const before = ackLog;
  if (ackEvents.length > 0) {
    ackLog = buildAckLog(ackEvents, ackLog);
    persist();
  }
  let recorded = 0;
  for (const { event, target } of departures) {
    if (!isSameSession(session)) break;
    if (await recordDeparture(event, target, session)) recorded += 1;
  }
  if (ackLog !== before) {
    logEvent('alarm.events', { count: ackEvents.length });
    try { onChange(); } catch { /* ajastus on apu */ }
  }
  return { recorded: ackEvents.length, departures: recorded };
}

/**
 * Lue laitteen tapahtumajono (kirjattu sovelluksen ollessa kiinni) ja
 * käsittele se. Kutsutaan kirjautumisen jälkeen ja etualalle palatessa,
 * ENNEN uudelleenajastusta: ajastus näkee silloin jo kuittaukset.
 */
export async function consumeAlarmEvents() {
  if (!activeUserId) return { recorded: 0, departures: 0 };
  const session = sessionSnapshot();
  let result;
  try {
    result = await alarms.consumeEvents();
  } catch {
    return { recorded: 0, departures: 0 };
  }
  if (!result || !result.ok || !Array.isArray(result.events) || result.events.length === 0) {
    return { recorded: 0, departures: 0 };
  }
  // Toinen käyttäjä ehti kirjautua: edellisen herätysten tapahtumat eivät kuulu hänelle.
  if (!isSameSession(session)) return { recorded: 0, departures: 0 };
  return handleAlarmEvents(result.events, { session });
}

/** Testejä varten: onko kuittausavain käsitelty (kuitattu tai hylätty)? */
export function ackTypesFor(key) {
  const entry = normalizeAckLog(ackLog).entries.find(item => item.key === key) || null;
  if (!entry) return null;
  return {
    acknowledged: entry.acknowledgedAt !== null,
    dismissed: entry.dismissedAt !== null,
    snoozedUntil: entry.snoozedUntil,
    snoozedUntilLocal: entry.snoozedUntilLocal
  };
}
