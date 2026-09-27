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
//   - herätyksen sammutus (kuittaus tai hylkäys) on toteutunut herääminen:
//     heräämispäivän unikirjaus saa heräämisajan (lähde 'alarm', tai
//     käyttäjän rivi täydentyy). Käyttäjän oma heräämisaika voittaa aina.
//     Kirjaus odottaa laitteella, kunnes unikirjaukset on ladattu ja yhteys
//     on, ja sama sammutus kirjautuu vain kerran (flushWakeRecords).
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
import {
  loadAckState, saveAckState, clearAllAckStates, normalizeAckTarget, MAX_ACK_TARGETS,
  normalizeWakes, normalizeWakeRecord
} from '../data/alarmAckStore.js';
import { emptyAckLog, buildAckLog, normalizeAckLog, ackIndex, ACK_EVENT } from '../domain/notificationAck.js';
import { DEPARTURE_CHAIN_TYPES, intentId } from '../domain/notification.js';
import { OBSERVATION_SOURCE } from '../domain/dailyLife.js';
import { epochToWallClock, shiftDateIso } from '../domain/wallClock.js';
import { alarmWakeLogInput } from '../domain/sleepLog.js';
import { deviceOffsetMinutes } from './deviceTime.js';
import { recordCommuteObservation, saveSleepLog } from './dailyLifeActions.js';
import { isOnlineNow } from './offline.js';
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
/** Herätyksen tunniste (alarmPlan.desiredAlarms): 'wake:<herätyspäivä>'. */
const WAKE_ID = /^wake:(\d{4}-\d{2}-\d{2})$/;
/** Odottava herääminen vanhenee: yli viikon takaista aamua ei enää kirjata. */
const WAKE_RECORD_MAX_AGE_DAYS = 7;

let activeUserId = null;
let ackLog = emptyAckLog();
let targets = Object.freeze([]);
/** Herätyksen sammutuksista kirjattavat heräämiset: {pending:[{date,time,plannedWake}], recorded:[päivä]}. */
let wakes = normalizeWakes(null);
/** Heräämisten kirjauskierrokset yksi kerrallaan (elävä tapahtuma ja jonon luku voivat osua yhtä aikaa). */
let wakeChain = Promise.resolve();
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
  saveAckState(activeUserId, { log: ackLog, targets, wakes });
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
  wakes = normalizeWakes(stored.wakes);
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
  wakes = normalizeWakes(null);
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
  // Herätys, jota ajastusluettelo ei enää muista: laji ja aamu tunnisteesta.
  const wake = WAKE_ID.exec(ackKey);
  if (wake) return normalizeAckTarget({ id, ackKey, kind: 'wake', type: 'wake', date: wake[1] });
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

// ------------------------------------------------------------ herääminen herätyksestä

/**
 * Herätyksen sammutus toteutuneeksi heräämiseksi {date, time, plannedWake},
 * tai null. Vain herätyksen (wake) kuittaus tai hylkäys; torkku ja väliin
 * jäänyt eivät ole heräämisiä. Sammutus toisena päivänä kuin herätyksen aamu
 * (esim. herätys peruttiin edellisenä päivänä) ei ole herääminen.
 */
export function wakeRecordFor(event, target) {
  if (!event || !target) return null;
  if (event.type !== DEVICE_EVENT.ACKNOWLEDGED && event.type !== DEVICE_EVENT.DISMISSED) return null;
  if (target.kind !== 'wake' && event.kind !== 'wake') return null;
  const fromId = WAKE_ID.exec(target.ackKey || '');
  const date = target.date || (fromId ? fromId[1] : null);
  if (!date || !Number.isFinite(event.atMs)) return null;
  const wall = epochToWallClock(event.atMs, deviceOffsetMinutes);
  if (!wall || wall.date !== date) return null;
  return normalizeWakeRecord({ date, time: wall.time, plannedWake: target.time });
}

/** Uusi herääminen jonoon; sama aamu vain kerran (ensimmäinen sammutus voittaa). */
function queueWake(record) {
  if (!record) return false;
  if (wakes.recorded.includes(record.date) || wakes.pending.some(item => item.date === record.date)) return false;
  wakes = normalizeWakes({ pending: [...wakes.pending, record], recorded: wakes.recorded });
  return true;
}

function markWakeRecorded(date) {
  wakes = normalizeWakes({
    pending: wakes.pending.filter(item => item.date !== date),
    recorded: [...wakes.recorded.filter(item => item !== date), date]
  });
}

/** Onko unikirjaukset ladattu tässä istunnossa (muuten ei tiedetä, onko päivällä jo rivi). */
function sleepLogsLoaded(state) {
  const status = state && state.dataLoadStatus ? state.dataLoadStatus.sleepLogs : null;
  return Boolean(status && status.lastSuccessAt);
}

async function runWakeFlush(session, nowMs) {
  if (!activeUserId || wakes.pending.length === 0 || !isSameSession(session)) return 0;
  const today = epochToWallClock(nowMs, deviceOffsetMinutes);
  const oldest = today ? shiftDateIso(today.date, -WAKE_RECORD_MAX_AGE_DAYS) : null;
  if (oldest && wakes.pending.some(item => item.date < oldest)) {
    wakes = normalizeWakes({ pending: wakes.pending.filter(item => item.date >= oldest), recorded: wakes.recorded });
    persist();
  }
  // Ennen latausta ei tiedetä, onko päivällä jo (käyttäjän) rivi, ja
  // tunnetusti offline tallennus epäonnistuisi joka paluulla: odotetaan.
  if (wakes.pending.length === 0 || !sleepLogsLoaded(getState()) || !isOnlineNow()) return 0;
  let written = 0;
  for (const record of [...wakes.pending]) {
    if (!isSameSession(session) || !activeUserId) return written;
    const logs = Array.isArray(getState().sleepLogs) ? getState().sleepLogs : [];
    const existing = logs.find(log => log && log.wakeDate === record.date) || null;
    const input = alarmWakeLogInput(existing, {
      wakeDate: record.date, actualWake: record.time, plannedWake: record.plannedWake
    });
    if (!input) {
      // Heräämisaika on jo kirjattu (käyttäjä tai aiempi sammutus): ei päällekirjoitusta.
      markWakeRecorded(record.date);
      continue;
    }
    const result = await saveSleepLog(input);
    if (!isSameSession(session) || !activeUserId) return written;
    if (result && result.ok) {
      markWakeRecorded(record.date);
      written += 1;
    } else if (result && result.errors) {
      // Kelvoton kirjaus ei muutu kelvolliseksi uudella yrityksellä.
      markWakeRecorded(record.date);
    } else {
      // Verkko tai palvelin: tallennus peruttiin, yritetään seuraavalla kerralla.
      break;
    }
  }
  persist();
  // Vain määrä lokiin: kellonajat ovat unitietoa (arkaluonteinen).
  if (written > 0) logEvent('alarm.wake_recorded', { count: written });
  return written;
}

/**
 * Kirjaa odottavat heräämiset unikirjauksiin. Yksi kierros kerrallaan;
 * samanaikainen kutsu odottaa edellisen ja näkee sen kirjaukset.
 * @returns {Promise<number>} kirjoitettujen rivien määrä
 */
export function flushWakeRecords({ session = sessionSnapshot(), nowMs = Date.now() } = {}) {
  const run = wakeChain.then(() => runWakeFlush(session, nowMs), () => runWakeFlush(session, nowMs));
  wakeChain = run.then(() => {}, () => {});
  return run;
}

/** Testejä varten: odottavat heräämiset. */
export function pendingWakeRecordsForTests() {
  return wakes.pending;
}

/**
 * Käsittele laitteen tapahtumat: kuittausloki, "Lähdin"-havainnot ja
 * herätyksen sammutuksesta toteutunut herääminen.
 * @returns {Promise<{recorded:number, departures:number, wakes:number}>}
 */
export async function handleAlarmEvents(events, { session = sessionSnapshot() } = {}) {
  if (!activeUserId || !Array.isArray(events) || events.length === 0) return { recorded: 0, departures: 0, wakes: 0 };
  if (!isSameSession(session)) return { recorded: 0, departures: 0, wakes: 0 };
  const state = getState();
  const ackEvents = [];
  const departures = [];
  let wakeQueued = false;
  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    const target = targetFor(event.id, { state });
    const produced = ackEventsFor(event, target);
    ackEvents.push(...produced);
    if (event.type === DEVICE_EVENT.DEPARTED && target) departures.push({ event, target });
    if (queueWake(wakeRecordFor(event, target))) wakeQueued = true;
  }
  const before = ackLog;
  if (ackEvents.length > 0) ackLog = buildAckLog(ackEvents, ackLog);
  // Odottava herääminen laitteelle ennen yhtäkään odotusta: sovelluksen
  // sulkeminen kesken ei hävitä sitä (laitteen jono on jo luettu).
  if (ackEvents.length > 0 || wakeQueued) persist();
  let recorded = 0;
  for (const { event, target } of departures) {
    if (!isSameSession(session)) break;
    if (await recordDeparture(event, target, session)) recorded += 1;
  }
  if (ackLog !== before) {
    logEvent('alarm.events', { count: ackEvents.length });
    try { onChange(); } catch { /* ajastus on apu */ }
  }
  // Herääminen unikirjaukseen (myös aiemmin odottamaan jäänyt).
  const wakesWritten = isSameSession(session) ? await flushWakeRecords({ session }) : 0;
  return { recorded: ackEvents.length, departures: recorded, wakes: wakesWritten };
}

/**
 * Lue laitteen tapahtumajono (kirjattu sovelluksen ollessa kiinni) ja
 * käsittele se. Kutsutaan kirjautumisen jälkeen ja etualalle palatessa,
 * ENNEN uudelleenajastusta: ajastus näkee silloin jo kuittaukset.
 */
export async function consumeAlarmEvents() {
  if (!activeUserId) return { recorded: 0, departures: 0, wakes: 0 };
  const session = sessionSnapshot();
  let result;
  try {
    result = await alarms.consumeEvents();
  } catch {
    result = null;
  }
  // Toinen käyttäjä ehti kirjautua: edellisen herätysten tapahtumat eivät kuulu hänelle.
  if (!isSameSession(session)) return { recorded: 0, departures: 0, wakes: 0 };
  if (!result || !result.ok || !Array.isArray(result.events) || result.events.length === 0) {
    // Ei uusia tapahtumia: aiemmin odottamaan jäänyt herääminen (unikirjaukset
    // latautumatta tai ei yhteyttä) kirjataan nyt. Kutsutaan latauksen jälkeen.
    return { recorded: 0, departures: 0, wakes: await flushWakeRecords({ session }) };
  }
  return handleAlarmEvents(result.events, { session });
}

/**
 * Sovelluksessa kirjattu lähtö ("Lähdin nyt" Tänään-näkymässä tai muualla)
 * kuittaa saman menon lähtöketjun: laitteen "Lähde nyt" ei saa soida
 * lähteneelle. Vain havainnot, joissa on menon tunniste, päivä ja
 * toteutunut lähtö tai perilläolo. Ei muuta sovelluksen tilaa.
 *
 * @returns {number} uusien kuittausten määrä
 */
export function acknowledgeRecordedDepartures(observations, { nowMs = Date.now() } = {}) {
  if (!activeUserId || !Array.isArray(observations) || observations.length === 0) return 0;
  // Vain tämän päivän lähdöt: vanhempien ketjut ovat jo menneet, eikä
  // loki saa täyttyä historiasta.
  const today = epochToWallClock(nowMs, deviceOffsetMinutes);
  if (!today) return 0;
  const index = ackIndex(ackLog);
  const events = [];
  for (const observation of observations) {
    if (!observation || !observation.eventId || observation.observedOn !== today.date) continue;
    if (!observation.actualDeparture && !observation.arrivalAt) continue;
    const target = normalizeAckTarget({
      id: `departure:${observation.eventId}`,
      ackKey: `departure:${observation.eventId}`,
      departureId: `event:${observation.eventId}:${observation.observedOn}`,
      date: observation.observedOn
    });
    for (const key of chainKeys(target)) {
      const entry = index.get(key);
      if (entry && entry.acknowledgedAt !== null) continue;
      events.push({ type: ACK_EVENT.ACKNOWLEDGED, key, atMs: nowMs });
    }
  }
  if (events.length === 0) return 0;
  ackLog = buildAckLog(events, ackLog);
  persist();
  return events.length;
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
