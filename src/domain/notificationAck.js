// Muistutusten kuittausloki.
//
// PUHDAS MODUULI. Ei kelloa (jokainen tapahtuma tuo oman aikaleimansa
// millisekunteina), ei tallennusta, ei DOM:ia. Loki on tavallista JSONia:
// sovelluskerros voi tallentaa sen laitteelle ja lukea takaisin
// normalizeAckLog-funktiolla, joka ei koskaan heitä.
//
// MIKSI TÄMÄ ON OLEMASSA
// Suunnitelman periaate: "Kuitattua, torkutettua tai hylättyä muistutusta
// ei toisteta." Ilmoitukset suunnitellaan uudelleen joka synkronoinnissa
// (kaikki perutaan ja ajastetaan uudelleen), joten ilman muistia jo
// kuitattu "Lähde nyt" ajastuisi uudelleen seuraavalla avauksella. Loki on
// se muisti: se kertoo, mitä käyttäjä on jo tehnyt millekin avaimelle.
//
// AVAIN = aikomuksen ackKey (src/domain/notification.js). Sama avain
// tarkoittaa samaa muistutusta, vaikka sen kellonaika muuttuisi.
//
// JÄRJESTYKSESTÄ RIIPPUMATON
// Tapahtumat voivat saapua väärässä järjestyksessä (natiivikuoren kuittaus
// ja sovelluksen oma kirjaus kilpailevat). Siksi tietue kootaan
// minimeistä ja maksimeista: ensimmäinen kuittaus, pisin torkku, viimeisin
// hetki. Tulos ei riipu siitä, missä järjestyksessä tapahtumat luettiin.
//
// RAJATTU KOKO
// Enintään MAX_ACK_ENTRIES avainta. Kun raja ylittyy, pisimpään
// koskematon avain poistuu ensin. Loki ei ole historia eikä seuranta:
// se on lyhyt muisti toistojen estämiseksi.

import { isIsoDate, isTimeOfDay } from './task.js';

export const ACK_EVENT = Object.freeze({
  /** Ilmoitus näytettiin laitteella. Ei vielä käsitelty. */
  DELIVERED: 'delivered',
  /** Käyttäjä avasi ilmoituksen. Ei vielä käsitelty. */
  OPENED: 'opened',
  /** Käyttäjä kuittasi: "selvä". Pysyvä: ei enää toistoja. */
  ACKNOWLEDGED: 'acknowledged',
  /** Käyttäjä torkutti: muistuta uudelleen myöhemmin. */
  SNOOZED: 'snoozed',
  /** Käyttäjä hylkäsi: "ei tätä". Pysyvä: ei enää toistoja. */
  DISMISSED: 'dismissed'
});

export const ACK_EVENTS = Object.freeze(Object.values(ACK_EVENT));

/** Tila, jonka ackStatus palauttaa. Käsitellyt (pysyvät) ensin tärkeysjärjestyksessä. */
export const ACK_STATUS = ACK_EVENT;

export const ACK_LOG_VERSION = 1;
export const MAX_ACK_ENTRIES = 500;
export const MAX_ACK_KEY_LENGTH = 200;
/** Torkku ei voi kestää viikkoa pidempään: pidempi on unohtamista, ei torkkua. */
export const MAX_SNOOZE_SPAN_MS = 7 * 24 * 60 * 60 * 1000;
/** Suurin kelvollinen aikaleima (ECMAScriptin aikaraja). */
const MAX_TIMESTAMP = 8.64e15;
const MAX_SNOOZE_COUNT = 1000;

const EMPTY_LOG = Object.freeze({ version: ACK_LOG_VERSION, entries: Object.freeze([]) });

// Tämän moduulin itse tuottamat lokit tunnetaan identiteetin perusteella,
// jotta jo normalisoitua lokia ei käydä läpi uudelleen jokaisessa
// kyselyssä. Pelkkä välimuisti: tulos on sama ilman sitäkin.
const NORMALIZED = new WeakSet([EMPTY_LOG]);

/** Tyhjä loki. */
export function emptyAckLog() {
  return EMPTY_LOG;
}

// ------------------------------------------------------------ validointi

function validKey(key) {
  return typeof key === 'string' && key.length > 0 && key.length <= MAX_ACK_KEY_LENGTH;
}

function validTimestamp(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_TIMESTAMP;
}

function tsOrNull(value) {
  return validTimestamp(value) ? value : null;
}

function localOrNull(value) {
  if (!value || typeof value !== 'object') return null;
  if (!isIsoDate(value.date) || !isTimeOfDay(value.time)) return null;
  return Object.freeze({ date: value.date, time: value.time });
}

function minTs(a, b) {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

function maxTs(a, b) {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

function compareLocal(a, b) {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  if (a.time !== b.time) return a.time < b.time ? -1 : 1;
  return 0;
}

/**
 * Tapahtuma kelvolliseksi tai null. Ei koskaan heitä.
 * Torkku vaatii päättymishetken, joka on tapahtuman jälkeen ja enintään
 * viikon päässä. `untilLocal` ({date, time}) on vapaaehtoinen seinäkelloaika,
 * jonka avulla torkutettu muistutus voidaan ajastaa uudelleen.
 */
export function normalizeAckEvent(event) {
  try {
    return normalizeEventUnsafe(event);
  } catch {
    return null;
  }
}

function normalizeEventUnsafe(event) {
  if (!event || typeof event !== 'object') return null;
  const type = event.type;
  if (!ACK_EVENTS.includes(type)) return null;
  if (!validKey(event.key)) return null;
  if (!validTimestamp(event.atMs)) return null;

  if (type === ACK_EVENT.SNOOZED) {
    const untilMs = event.untilMs;
    if (!validTimestamp(untilMs) || untilMs <= event.atMs
      || untilMs - event.atMs > MAX_SNOOZE_SPAN_MS) return null;
    return Object.freeze({
      type, key: event.key, atMs: event.atMs, untilMs, untilLocal: localOrNull(event.untilLocal)
    });
  }
  return Object.freeze({ type, key: event.key, atMs: event.atMs });
}

// ------------------------------------------------------------ tietue

function blankEntry(key) {
  return {
    key,
    deliveredAt: null,
    openedAt: null,
    acknowledgedAt: null,
    dismissedAt: null,
    snoozedAt: null,
    snoozedUntil: null,
    snoozedUntilLocal: null,
    snoozeCount: 0,
    lastAt: null
  };
}

/** Yhdistä tapahtuma muokattavaan tietueeseen. Minimit ja maksimit: järjestyksestä riippumaton. */
function applyEvent(entry, event) {
  entry.lastAt = maxTs(entry.lastAt, event.atMs);
  switch (event.type) {
    case ACK_EVENT.DELIVERED: entry.deliveredAt = minTs(entry.deliveredAt, event.atMs); break;
    case ACK_EVENT.OPENED: entry.openedAt = minTs(entry.openedAt, event.atMs); break;
    case ACK_EVENT.ACKNOWLEDGED: entry.acknowledgedAt = minTs(entry.acknowledgedAt, event.atMs); break;
    case ACK_EVENT.DISMISSED: entry.dismissedAt = minTs(entry.dismissedAt, event.atMs); break;
    case ACK_EVENT.SNOOZED: {
      // Toistuva sama tapahtuma (sama hetki) ei kasvata laskuria.
      if (entry.snoozedAt === null || event.atMs > entry.snoozedAt) {
        entry.snoozeCount = Math.min(MAX_SNOOZE_COUNT, entry.snoozeCount + 1);
      }
      entry.snoozedAt = maxTs(entry.snoozedAt, event.atMs);
      // Pisin torkku voittaa. Seinäkelloaika kulkee saman torkun mukana,
      // jotta ms-hetki ja paikallinen aika eivät koskaan eriydy.
      if (entry.snoozedUntil === null || event.untilMs > entry.snoozedUntil
        || (event.untilMs === entry.snoozedUntil && event.untilLocal && (!entry.snoozedUntilLocal
          || compareLocal(event.untilLocal, entry.snoozedUntilLocal) > 0))) {
        entry.snoozedUntil = event.untilMs;
        entry.snoozedUntilLocal = event.untilLocal;
      }
      break;
    }
    default: break;
  }
}

function freezeEntry(entry) {
  return Object.freeze({ ...entry });
}

/** Kumpi tietue poistuu ensin, kun loki on täynnä: vanhin viimeinen hetki, sitten avain. */
function evictionOrder(a, b) {
  const lastA = a.lastAt ?? -1;
  const lastB = b.lastAt ?? -1;
  if (lastA !== lastB) return lastA - lastB;
  return a.key.localeCompare(b.key, 'fi');
}

function finalize(map) {
  let entries = [...map.values()];
  if (entries.length > MAX_ACK_ENTRIES) {
    entries.sort(evictionOrder);
    entries = entries.slice(entries.length - MAX_ACK_ENTRIES);
  }
  entries.sort((a, b) => a.key.localeCompare(b.key, 'fi') || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const log = Object.freeze({
    version: ACK_LOG_VERSION,
    entries: Object.freeze(entries.map(freezeEntry))
  });
  NORMALIZED.add(log);
  return log;
}

function toMap(log) {
  const map = new Map();
  for (const entry of normalizeAckLog(log).entries) map.set(entry.key, { ...entry });
  return map;
}

// ------------------------------------------------------------ julkinen

/**
 * Lue loki luotettavaksi. Hyväksyy tallennetun JSONin (tai mitä tahansa
 * roskaa) ja palauttaa aina kelvollisen, jäädytetyn lokin. Ei heitä.
 */
export function normalizeAckLog(raw) {
  if (raw && typeof raw === 'object' && NORMALIZED.has(raw)) return raw;
  try {
    return normalizeUntrusted(raw);
  } catch {
    // Vihamielinen syöte (esim. heittävä getteri) ei kaada sovellusta:
    // tuntematon loki on tyhjä loki. Pahin seuraus on yksi toisto.
    return EMPTY_LOG;
  }
}

function normalizeUntrusted(raw) {
  const list = raw && typeof raw === 'object' && Array.isArray(raw.entries) ? raw.entries : [];
  if (list.length === 0) return EMPTY_LOG;

  const map = new Map();
  for (const item of list) {
    if (!item || typeof item !== 'object' || !validKey(item.key)) continue;
    const entry = map.get(item.key) || blankEntry(item.key);
    entry.deliveredAt = minTs(entry.deliveredAt, tsOrNull(item.deliveredAt));
    entry.openedAt = minTs(entry.openedAt, tsOrNull(item.openedAt));
    entry.acknowledgedAt = minTs(entry.acknowledgedAt, tsOrNull(item.acknowledgedAt));
    entry.dismissedAt = minTs(entry.dismissedAt, tsOrNull(item.dismissedAt));
    entry.snoozedAt = maxTs(entry.snoozedAt, tsOrNull(item.snoozedAt));
    const until = tsOrNull(item.snoozedUntil);
    if (until !== null && (entry.snoozedUntil === null || until > entry.snoozedUntil)) {
      entry.snoozedUntil = until;
      entry.snoozedUntilLocal = localOrNull(item.snoozedUntilLocal);
    }
    const count = Number.isInteger(item.snoozeCount) && item.snoozeCount > 0
      ? Math.min(MAX_SNOOZE_COUNT, item.snoozeCount) : 0;
    entry.snoozeCount = Math.max(entry.snoozeCount, count);
    // Viimeisin hetki: tallennettu tai suurin tunnettu aikaleima.
    entry.lastAt = [tsOrNull(item.lastAt), entry.deliveredAt, entry.openedAt, entry.acknowledgedAt,
      entry.dismissedAt, entry.snoozedAt, entry.lastAt].reduce(maxTs, null);
    map.set(item.key, entry);
  }
  if (map.size === 0) return EMPTY_LOG;
  return finalize(map);
}

/**
 * Kirjaa yksi tapahtuma. Palauttaa UUDEN lokin; alkuperäistä ei muuteta.
 * Kelvoton tapahtuma palauttaa lokin sellaisenaan (normalisoituna).
 */
export function recordAck(log, event) {
  const valid = normalizeAckEvent(event);
  const base = normalizeAckLog(log);
  if (!valid) return base;
  const map = toMap(base);
  const entry = map.get(valid.key) || blankEntry(valid.key);
  applyEvent(entry, valid);
  map.set(valid.key, entry);
  return finalize(map);
}

/**
 * Rakenna loki tapahtumalistasta (esim. natiivikuoren kuittausjonosta).
 * Tapahtumat järjestetään ensin, joten tulos ei riipu syötteen
 * järjestyksestä. Lineaarinen (järjestystä lukuun ottamatta).
 */
export function buildAckLog(events, base = EMPTY_LOG) {
  const valid = [];
  if (Array.isArray(events)) {
    for (const event of events) {
      const normalized = normalizeAckEvent(event);
      if (normalized) valid.push(normalized);
    }
  }
  const map = toMap(base);
  if (valid.length === 0) return map.size === 0 ? EMPTY_LOG : finalize(map);

  const rank = type => ACK_EVENTS.indexOf(type);
  valid.sort((a, b) => (a.atMs - b.atMs)
    || a.key.localeCompare(b.key, 'fi')
    || (rank(a.type) - rank(b.type))
    || ((a.untilMs ?? 0) - (b.untilMs ?? 0)));

  for (const event of valid) {
    const entry = map.get(event.key) || blankEntry(event.key);
    applyEvent(entry, event);
    map.set(event.key, entry);
  }
  return finalize(map);
}

/**
 * Hakemisto nopeaan hakuun: Map avain -> jäädytetty tietue.
 * Käytä, kun samasta lokista tarkistetaan monta avainta.
 */
export function ackIndex(log) {
  const index = new Map();
  for (const entry of normalizeAckLog(log).entries) index.set(entry.key, entry);
  return index;
}

function entryOf(logOrIndex, key) {
  if (!validKey(key)) return null;
  if (logOrIndex instanceof Map) return logOrIndex.get(key) || null;
  return ackIndex(logOrIndex).get(key) || null;
}

/** Onko tietue pysyvästi käsitelty (kuitattu tai hylätty). */
export function entryHandled(entry) {
  return Boolean(entry) && (entry.acknowledgedAt !== null || entry.dismissedAt !== null);
}

/**
 * Onko muistutus jo käsitelty: kuitattu tai hylätty. Näytetty tai avattu
 * EI ole käsitelty — se voi vielä tarvita toimintaa.
 */
export function isHandled(logOrIndex, key) {
  return entryHandled(entryOf(logOrIndex, key));
}

/**
 * Torkun päättymishetki millisekunteina, tai null.
 * Käsitelty muistutus ei ole torkussa, vaikka sitä olisi torkutettu ennen
 * kuittausta: kuittaus on lopullinen.
 */
export function snoozedUntil(logOrIndex, key) {
  const entry = entryOf(logOrIndex, key);
  if (!entry || entryHandled(entry)) return null;
  return entry.snoozedUntil;
}

/** Torkun päättyminen seinäkelloaikana { date, time }, jos kirjaaja antoi sen. */
export function snoozedUntilLocal(logOrIndex, key) {
  const entry = entryOf(logOrIndex, key);
  if (!entry || entryHandled(entry)) return null;
  return entry.snoozedUntilLocal;
}

/**
 * Avaimen tila yhdellä sanalla: dismissed > acknowledged > snoozed >
 * opened > delivered > null. Pysyvä tila voittaa aina.
 */
export function ackStatus(logOrIndex, key) {
  const entry = entryOf(logOrIndex, key);
  if (!entry) return null;
  if (entry.dismissedAt !== null) return ACK_EVENT.DISMISSED;
  if (entry.acknowledgedAt !== null) return ACK_EVENT.ACKNOWLEDGED;
  if (entry.snoozedUntil !== null) return ACK_EVENT.SNOOZED;
  if (entry.openedAt !== null) return ACK_EVENT.OPENED;
  if (entry.deliveredAt !== null) return ACK_EVENT.DELIVERED;
  return null;
}

/**
 * Tapahtumat, jotka yksi käyttäjän toiminto aikomukselle tuottaa.
 *
 * Koosteen kuittaus tai hylkäys koskee myös sen sisältämiä muistutuksia
 * (`mergedAckKeys`): käyttäjä on nähnyt ne koosteessa, eikä niitä pidä
 * toistaa erikseen. Torkku, näyttö ja avaus koskevat vain koostetta.
 *
 * @returns {ReadonlyArray<object>} kelvolliset tapahtumat (voi olla tyhjä)
 */
export function eventsForIntent(intent, type, options) {
  const { atMs, untilMs = null, untilLocal = null } = options && typeof options === 'object' ? options : {};
  if (!intent || typeof intent !== 'object') return Object.freeze([]);
  const key = validKey(intent.ackKey) ? intent.ackKey : (validKey(intent.id) ? intent.id : null);
  if (!key) return Object.freeze([]);

  const keys = [key];
  if ((type === ACK_EVENT.ACKNOWLEDGED || type === ACK_EVENT.DISMISSED) && Array.isArray(intent.mergedAckKeys)) {
    for (const merged of intent.mergedAckKeys) if (validKey(merged) && !keys.includes(merged)) keys.push(merged);
  }

  const events = [];
  for (const each of keys) {
    const event = normalizeAckEvent({ type, key: each, atMs, untilMs, untilLocal });
    if (event) events.push(event);
  }
  return Object.freeze(events);
}
