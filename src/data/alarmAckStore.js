// Herätysten ja puhuttujen muistutusten kuittausmuisti laitteella.
//
// MITÄ TÄNNE TALLENTUU: laitteen kirjaamat kuittaukset, torkut ja
// hylkäykset (src/domain/notificationAck.js -loki: avain ja aikaleimat)
// sekä lyhyt lista laitteelle ajastetuista merkinnöistä (tunniste,
// kuittausavain, menon ja paikan tunniste, päivä, lähtöaika). EI otsikoita,
// ei osoitteita, ei puhetta, ei sijaintia.
//
// MIKSI LAITTEELLA: muistutukset ajastetaan uudelleen joka synkronoinnissa.
// Ilman tätä muistia jo kuitattu "Lähde nyt" ajastuisi uudelleen seuraavalla
// avauksella. Loki ei ole historiaa: notificationAck.js rajaa sen
// (MAX_ACK_ENTRIES), ja ajastusluettelo on enintään laitteen herätysraja.
//
// ELINKAARI (src/data/deviceData.js DEVICE_STORAGE):
//   - avain on käyttäjäkohtainen, toisen käyttäjän loki ei osu tähän
//   - uloskirjautuminen tyhjentää kaikki tämän etuliitteen avaimet: laitteen
//     herätykset perutaan samalla, joten kuittauksilla ei ole enää kohdetta
//   - tilin poisto poistaa poistetun käyttäjän avaimen
//   - tallennus voi epäonnistua (yksityinen ikkuna, kiintiö): silloin muisti
//     elää vain tämän istunnon ajan. Pahin seuraus on yksi toisto.

import { normalizeAckLog, emptyAckLog } from '../domain/notificationAck.js';

const PREFIX = 'manifestival.alarmAcks.v1.';
const USER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const STORE_VERSION = 1;

/** Ajastusluettelon enimmäiskoko (sama kuin laitteen herätysraja). */
export const MAX_ACK_TARGETS = 50;

const ID_PATTERN = /^[A-Za-z0-9_:.|@#-]{1,120}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^\d{2}:\d{2}$/;
const KINDS = new Set(['wake', 'spoken', 'critical']);

/** Varamuisti, kun localStorage ei ole käytettävissä. */
const memory = new Map();

function storage() {
  try {
    return typeof globalThis !== 'undefined' && globalThis.localStorage ? globalThis.localStorage : null;
  } catch {
    return null;
  }
}

/** Käyttäjän avain tai null (kelvoton tunniste ei koskaan osu toisen avaimeen). */
export function ackStoreKey(userId) {
  const id = userId == null ? '' : String(userId);
  return USER_ID_PATTERN.test(id) ? PREFIX + id : null;
}

function idOrNull(value, pattern = ID_PATTERN) {
  return typeof value === 'string' && pattern.test(value) ? value : null;
}

/** Yksi ajastusluettelon rivi luotettavaksi, tai null. */
export function normalizeAckTarget(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = idOrNull(raw.id);
  const ackKey = idOrNull(raw.ackKey, /^[^\u0000-\u001f]{1,200}$/);
  if (!id || !ackKey) return null;
  return Object.freeze({
    id,
    ackKey,
    kind: KINDS.has(raw.kind) ? raw.kind : null,
    type: typeof raw.type === 'string' && raw.type.length <= 40 ? raw.type : null,
    departureId: idOrNull(raw.departureId),
    eventId: idOrNull(raw.eventId),
    placeId: idOrNull(raw.placeId),
    date: typeof raw.date === 'string' && DATE_PATTERN.test(raw.date) ? raw.date : null,
    leaveTime: typeof raw.leaveTime === 'string' && TIME_PATTERN.test(raw.leaveTime) ? raw.leaveTime : null
  });
}

function normalizeTargets(list) {
  if (!Array.isArray(list)) return Object.freeze([]);
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const target = normalizeAckTarget(raw);
    if (!target || seen.has(target.id)) continue;
    seen.add(target.id);
    out.push(target);
    if (out.length >= MAX_ACK_TARGETS) break;
  }
  return Object.freeze(out);
}

const EMPTY_STATE = Object.freeze({ log: emptyAckLog(), targets: Object.freeze([]) });

/**
 * Lue käyttäjän kuittausmuisti. Ei koskaan heitä: puuttuva, rikkinäinen tai
 * toisen muotoinen sisältö on tyhjä muisti.
 *
 * @returns {{log:object, targets:ReadonlyArray<object>}}
 */
export function loadAckState(userId) {
  const key = ackStoreKey(userId);
  if (!key) return EMPTY_STATE;
  let text = null;
  if (memory.has(key)) text = memory.get(key);
  else {
    try {
      const store = storage();
      if (store) text = store.getItem(key);
    } catch { /* ei luettavissa */ }
  }
  if (typeof text !== 'string' || !text) return EMPTY_STATE;
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || parsed.v !== STORE_VERSION) return EMPTY_STATE;
    return Object.freeze({ log: normalizeAckLog(parsed.log), targets: normalizeTargets(parsed.targets) });
  } catch {
    return EMPTY_STATE;
  }
}

/**
 * Tallenna käyttäjän kuittausmuisti.
 * @returns {{ok:boolean, persistent:boolean}}
 */
export function saveAckState(userId, { log, targets } = {}) {
  const key = ackStoreKey(userId);
  if (!key) return { ok: false, persistent: false };
  let text;
  try {
    text = JSON.stringify({ v: STORE_VERSION, log: normalizeAckLog(log), targets: normalizeTargets(targets) });
  } catch {
    return { ok: false, persistent: false };
  }
  try {
    const store = storage();
    if (store) {
      store.setItem(key, text);
      memory.delete(key);
      return { ok: true, persistent: true };
    }
  } catch { /* kiintiö tai yksityinen tila */ }
  memory.set(key, text);
  return { ok: true, persistent: false };
}

/** Poista yhden käyttäjän kuittausmuisti (tilin poisto). */
export function purgeAckState(userId) {
  const key = ackStoreKey(userId);
  if (!key) return;
  memory.delete(key);
  try {
    const store = storage();
    if (store) store.removeItem(key);
  } catch { /* ei mitään poistettavaa */ }
}

/**
 * Tyhjennä kaikki kuittausmuistit (uloskirjautuminen). Laitteen herätykset
 * perutaan samassa yhteydessä, joten muistettavaa ei jää.
 * @returns {number} poistettujen avainten määrä
 */
export function clearAllAckStates() {
  let removed = 0;
  for (const key of [...memory.keys()]) {
    if (key.startsWith(PREFIX)) { memory.delete(key); removed += 1; }
  }
  const store = storage();
  if (!store) return removed;
  const keys = [];
  try {
    for (let index = 0; index < store.length; index++) {
      const key = store.key(index);
      if (typeof key === 'string' && key.startsWith(PREFIX)) keys.push(key);
    }
  } catch {
    return removed;
  }
  for (const key of keys) {
    try {
      store.removeItem(key);
      removed += 1;
    } catch { /* yksittäisen avaimen poiston epäonnistuminen ei estä muita */ }
  }
  return removed;
}

/** Testejä varten. */
export function resetAckStoreForTests() {
  memory.clear();
}
