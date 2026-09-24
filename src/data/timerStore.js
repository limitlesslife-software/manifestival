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
//   - tilin poisto poistaa (purgeTimerData)
//   - tallennus voi epäonnistua (yksityinen ikkuna): silloin kopio elää
//     vain muistissa, ja `persistent: false` kerrotaan kutsujalle

import { normalizeTimer, validateTimer } from '../domain/timer.js';
import { normalizeTimeEntry, validateTimeEntry } from '../domain/timeEntry.js';

const TIMER_PREFIX = 'manifestival.timer.v1.';
const OUTBOX_PREFIX = 'manifestival.timeOutbox.v1.';
const USER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** Lähettämättömiä kirjauksia enintään. Ylimääräinen hylätään näkyvästi. */
export const MAX_OUTBOX_ENTRIES = 200;

const memory = new Map();

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

function readText(key) {
  if (!key) return null;
  try {
    const store = storage();
    if (store) return store.getItem(key);
  } catch { /* varamuisti */ }
  return memory.has(key) ? memory.get(key) : null;
}

function writeText(key, text) {
  if (!key) return { ok: false, persistent: false };
  try {
    const store = storage();
    if (store) {
      if (text === null) store.removeItem(key);
      else store.setItem(key, text);
      memory.delete(key);
      return { ok: true, persistent: true };
    }
  } catch { /* kiintiö tai yksityinen tila */ }
  if (text === null) memory.delete(key);
  else memory.set(key, text);
  return { ok: true, persistent: false };
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

/** Käyttäjän ajastin laitteelta, tai null. Kelvoton sisältö ohitetaan. */
export function loadTimer(userId) {
  const value = parse(readText(timerKey(userId)), userId);
  if (!value || !value.timer) return null;
  const timer = normalizeTimer(value.timer);
  return validateTimer(timer).valid ? timer : null;
}

/** Tallenna tai poista (timer = null). */
export function saveTimer(userId, timer) {
  const key = timerKey(userId);
  if (!timer) return writeText(key, null);
  return writeText(key, JSON.stringify({ v: 1, userId: String(userId), timer: normalizeTimer(timer) }));
}

/** Lähettämättömät kirjaukset. */
export function loadOutbox(userId) {
  const value = parse(readText(outboxKey(userId)), userId);
  if (!value || !Array.isArray(value.entries)) return [];
  return value.entries.map(normalizeTimeEntry)
    .filter(entry => entry.id && entry.operationId && validateTimeEntry(entry).valid);
}

export function saveOutbox(userId, entries) {
  const key = outboxKey(userId);
  const list = (entries || []).slice(0, MAX_OUTBOX_ENTRIES);
  if (list.length === 0) return writeText(key, null);
  return writeText(key, JSON.stringify({ v: 1, userId: String(userId), entries: list }));
}

/** Tilin poisto: ajastin ja lähettämättömät kirjaukset pois laitteelta. */
export function purgeTimerData(userId) {
  writeText(timerKey(userId), null);
  writeText(outboxKey(userId), null);
}

/** Testejä varten. */
export function resetTimerStoreForTests() {
  memory.clear();
}
