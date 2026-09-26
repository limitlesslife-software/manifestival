// Ajastimen ja lähettämättömien aikakirjausten tallennus laitteelle.
//
// MIKSI LAITTEELLE: ajastimen alkuhetki ei saa kadota sivun
// uudelleenlatauksessa. Ennen migraatiota 0013 kannassa ei ole
// ajastintaulua, ja sen jälkeenkin verkko voi puuttua juuri kun ajastin
// käynnistetään tai pysäytetään. Laitteen kopio on varmistus, ei toinen
// totuus: kun kannan rivi on saatavilla, se voittaa (src/app/timerState.js).
//
// MITÄ TÄNNE TALLENTUU: ajastimen aikaleimat ja kohteen TUNNISTEET
// (ei otsikoita, ei nimiä), sekä lähettämättömät aikakirjaukset samassa
// muodossa kuin time_entries-rivi. Ei tokeneita, ei sähköpostia.
//
//   - avain on käyttäjäkohtainen, ja sisältö tarkistetaan vielä
//     userId:n osalta: käyttäjän A ajastin ei voi näkyä käyttäjälle B
//   - uloskirjautuminen EI poista (A:n aika ei katoa, kun hän kirjautuu
//     takaisin), mutta tila tyhjennetään eikä B:n avain osu A:n dataan
//   - tilin poisto poistaa (purgeTimerData), ja sen jälkeen kesken jäänyt
//     lähetys tai synkronointi ei voi kirjoittaa poistettua dataa takaisin
//   - tallennus voi epäonnistua (yksityinen ikkuna): silloin kopio elää
//     vain muistissa, ja `persistent: false` kerrotaan kutsujalle
//
// AJASTIMEN LIPUT (kumpi kopio voittaa, src/app/timerState.js):
//
//   synced  ajastin on ollut kannassa (lisäys onnistui tai se ladattiin
//           onnistuneesta listasta)
//   dirty   laitteella on muutos, joka ei ole vielä kannassa (esim. tauko
//           ilman verkkoa)

import { normalizeTimer, validateTimer } from '../domain/timer.js';
import { normalizeTimeEntry, validateTimeEntry } from '../domain/timeEntry.js';

const TIMER_PREFIX = 'manifestival.timer.v1.';
const OUTBOX_PREFIX = 'manifestival.timeOutbox.v1.';
const TOMBSTONE_PREFIX = 'manifestival.timerTombstones.v1.';
const PENDING_PREFIX = 'manifestival.timerPending.v1.';
/** Poistettuja ajastimia muistetaan enintään näin monta. */
const MAX_TOMBSTONES = 20;
/** Käyttäjän päätöstä odottavia (kirjaamattomia) ajastimia enintään. */
const MAX_PENDING_TIMERS = 5;
const USER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** Lähettämättömiä kirjauksia enintään. Ylimääräinen hylätään näkyvästi. */
export const MAX_OUTBOX_ENTRIES = 200;

const memory = new Map();

/**
 * Tällä sivulla poistetut tilit. Niiden avaimiin ei kirjoiteta enää,
 * vaikka poiston aikana kesken ollut lähetys palaisi myöhemmin.
 */
const purgedUsers = new Set();

function storage() {
  try {
    return typeof globalThis !== 'undefined' && globalThis.localStorage ? globalThis.localStorage : null;
  } catch {
    return null;
  }
}

function keyFor(prefix, userId) {
  const id = userId == null ? '' : String(userId);
  return USER_ID_PATTERN.test(id) ? prefix + id : null;
}

export const timerKey = userId => keyFor(TIMER_PREFIX, userId);
export const outboxKey = userId => keyFor(OUTBOX_PREFIX, userId);
export const tombstoneKey = userId => keyFor(TOMBSTONE_PREFIX, userId);
export const pendingTimersKey = userId => keyFor(PENDING_PREFIX, userId);

function readText(key) {
  if (!key) return null;
  // Muistin kopio ensin: se on olemassa vain, jos laitteelle kirjoitus
  // epäonnistui (kiintiö, yksityinen tila), ja on silloin tuorein. Ilman
  // tätä jonotettu kirjaus "katosi" heti luettaessa.
  if (memory.has(key)) return memory.get(key);
  try {
    const store = storage();
    if (store) return store.getItem(key);
  } catch { /* ei tallennusta */ }
  return null;
}

function writeText(key, text) {
  if (!key) return { ok: false, persistent: false };
  const store = storage();
  if (store) {
    try {
      if (text === null) store.removeItem(key);
      else store.setItem(key, text);
      memory.delete(key);
      return { ok: true, persistent: true };
    } catch {
      // Kiintiö tai yksityinen tila: muistin kopio (myös poisto, null)
      // peittää laitteen vanhentuneen arvon, kunnes kirjoitus onnistuu.
      memory.set(key, text);
      return { ok: true, persistent: false };
    }
  }
  if (text === null) memory.delete(key);
  else memory.set(key, text);
  return { ok: true, persistent: false };
}

/** Kirjoitus käyttäjän avaimeen; poistetun tilin avaimeen ei kirjoiteta. */
function writeFor(prefix, userId, text) {
  if (userId != null && purgedUsers.has(String(userId))) return { ok: false, persistent: false, purged: true };
  return writeText(keyFor(prefix, userId), text);
}

function parse(text, userId) {
  if (!text) return null;
  try {
    const value = JSON.parse(text);
    // Toisen käyttäjän sisältö ei kelpaa, vaikka avain osuisi.
    if (!value || value.v !== 1 || value.userId !== String(userId)) return null;
    return value;
  } catch {
    return null;
  }
}

/**
 * Käyttäjän ajastin lippuineen laitteelta, tai null.
 *
 * Vanha muoto (ilman lippuja) käsitellään kantaan ehtimättömänä ja
 * muuttuneena: sitä ei pudoteta eikä sen päälle kirjoiteta.
 *
 * @returns {{timer: object, synced: boolean, dirty: boolean} | null}
 */
export function loadTimerRecord(userId) {
  const value = parse(readText(timerKey(userId)), userId);
  if (!value || !value.timer) return null;
  const timer = normalizeTimer(value.timer);
  if (!validateTimer(timer).valid) return null;
  return { timer, synced: value.synced === true, dirty: value.dirty !== false };
}

/** Käyttäjän ajastin laitteelta, tai null. Kelvoton sisältö ohitetaan. */
export function loadTimer(userId) {
  const record = loadTimerRecord(userId);
  return record ? record.timer : null;
}

/**
 * Tallenna tai poista (timer = null).
 *
 * `expectId` poistossa: poista vain, jos laitteella on juuri tämä ajastin.
 * Toinen välilehti on voinut jo käynnistää uuden, eikä vanhan ajastimen
 * siivous saa pyyhkiä sitä.
 */
export function saveTimer(userId, timer, { synced = false, dirty = true, expectId = null } = {}) {
  if (!timer) {
    if (expectId !== null && expectId !== undefined) {
      const stored = loadTimer(userId);
      if (stored && stored.id !== String(expectId)) return { ok: true, persistent: true, skipped: true };
    }
    return writeFor(TIMER_PREFIX, userId, null);
  }
  return writeFor(TIMER_PREFIX, userId, JSON.stringify({
    v: 1, userId: String(userId), timer: normalizeTimer(timer), synced: Boolean(synced), dirty: Boolean(dirty)
  }));
}

/**
 * Käyttäjän päätöstä odottavat ajastimet: tämän laitteen ajastin, joka ei
 * koskaan ehtinyt kantaan, kun kannassa oli jo toisen laitteen ajastin.
 * Sitä ei pudoteta hiljaa; käyttäjä kirjaa tai hylkää sen.
 */
export function loadPendingTimers(userId) {
  const value = parse(readText(pendingTimersKey(userId)), userId);
  if (!value || !Array.isArray(value.timers)) return [];
  return value.timers.map(normalizeTimer).filter(timer => validateTimer(timer).valid);
}

export function savePendingTimers(userId, timers) {
  const list = (timers || []).map(normalizeTimer).filter(timer => validateTimer(timer).valid)
    .slice(0, MAX_PENDING_TIMERS);
  if (list.length === 0) return writeFor(PENDING_PREFIX, userId, null);
  return writeFor(PENDING_PREFIX, userId, JSON.stringify({ v: 1, userId: String(userId), timers: list }));
}

/** Lähettämättömät kirjaukset. */
export function loadOutbox(userId) {
  const value = parse(readText(outboxKey(userId)), userId);
  if (!value || !Array.isArray(value.entries)) return [];
  return value.entries.map(normalizeTimeEntry)
    .filter(entry => entry.id && entry.operationId && validateTimeEntry(entry).valid);
}

export function saveOutbox(userId, entries) {
  const list = (entries || []).slice(0, MAX_OUTBOX_ENTRIES);
  if (list.length === 0) return writeFor(OUTBOX_PREFIX, userId, null);
  return writeFor(OUTBOX_PREFIX, userId, JSON.stringify({ v: 1, userId: String(userId), entries: list }));
}

/**
 * "Hautakivet": ajastimet, jotka tällä laitteella pysäytettiin tai
 * hylättiin. Hautakivi lisätään ENNEN kannan poistoa ja poistetaan vasta,
 * kun kannan lista vahvistaa rivin puuttuvan (src/app/timerState.js).
 * Latauksessa kannasta palaava sama ajastin ohitetaan ja poisto yritetään
 * uudelleen, jottei pysäytetty ajastin herää henkiin eikä aikaa kirjata
 * kahdesti.
 */
export function loadTombstones(userId) {
  const value = parse(readText(tombstoneKey(userId)), userId);
  return value && Array.isArray(value.ids) ? value.ids.filter(id => typeof id === 'string') : [];
}

export function addTombstone(userId, timerId) {
  const ids = [...loadTombstones(userId).filter(id => id !== timerId), String(timerId)].slice(-MAX_TOMBSTONES);
  return writeFor(TOMBSTONE_PREFIX, userId, JSON.stringify({ v: 1, userId: String(userId), ids }));
}

export function clearTombstone(userId, timerId) {
  const ids = loadTombstones(userId).filter(id => id !== timerId);
  return writeFor(TOMBSTONE_PREFIX, userId, ids.length ? JSON.stringify({ v: 1, userId: String(userId), ids }) : null);
}

/**
 * Tilin poisto: ajastin, odottavat ajastimet, hautakivet ja lähettämättömät
 * kirjaukset pois laitteelta. Sen jälkeen tämän käyttäjän avaimiin ei
 * kirjoiteta tällä sivulla enää (kesken ollut lähetys ei palauta niitä).
 */
export function purgeTimerData(userId) {
  for (const prefix of [TIMER_PREFIX, OUTBOX_PREFIX, TOMBSTONE_PREFIX, PENDING_PREFIX]) {
    writeText(keyFor(prefix, userId), null);
  }
  if (keyFor(TIMER_PREFIX, userId)) purgedUsers.add(String(userId));
}

/** Testejä varten. */
export function resetTimerStoreForTests() {
  memory.clear();
  purgedUsers.clear();
}
