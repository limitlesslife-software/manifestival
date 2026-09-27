// Seinäkello annetussa aikavyöhykkeessä.
//
// PUHDAS MODUULI: ei kelloa, ei DOM:ia, ei verkkoa. Hetki annetaan aina
// parametrina millisekunteina (epoch), eikä nykyhetkeä lueta koskaan.
//
// MIKSI OMA MODUULI
//
// Tapojen seuranta ("seuraava suunniteltu aika 14.20") ja unen kesto
// ("aikaa unelle 7 h") tarvitsevat kaksi eri käsitettä, jotka menevät
// helposti sekaisin:
//
//   KESTO      kahden hetken välinen todellinen aika. Kesäajan vaihto ei
//              muuta sitä: 23.00–07.00 on kevään vaihtoyönä 7 h ja syksyn
//              vaihtoyönä 9 h, vaikka kello näyttää samaa.
//   SEINÄKELLO paikallinen päivä ja kellonaika. "Tänään" alkaa paikallisena
//              keskiyönä, ei 24 tunnin välein.
//
// Isäntäkoneen aikavyöhykkeeseen ei nojata (se vaihtelee testikoneen ja
// puhelimen välillä), vaan vyöhyke annetaan nimenä. Oletus on Helsinki,
// koska sovellus on suomalainen; sovelluskerros voi antaa laitteen oman
// vyöhykkeen. Tuntematon vyöhykenimi palaa oletukseen eikä kaada mitään.
//
// Olemattomat ja kahdesti esiintyvät kellonajat (kesäajan vaihto)
// ratkaistaan samoin kuin Temporal-ehdotuksen "compatible"-sääntö:
// keväällä puuttuva 03.30 siirtyy aukon verran eteenpäin (04.30),
// syksyllä kahdesti esiintyvästä 03.30:stä valitaan ensimmäinen.

import { isIsoDate } from './task.js';

export const DEFAULT_TIME_ZONE = 'Europe/Helsinki';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
/** Järkevä aikaikkuna: 1900–9999. Sen ulkopuolinen luku on roskaa, ei hetki. */
const MIN_MS = -2208988800000;
const MAX_MS = 253402300799000;
/** Välimuistin koko: vyöhykkeitä on käytössä yksi tai kaksi, ei satoja. */
const MAX_CACHED_ZONES = 16;

const formatters = new Map();

function formatterFor(timeZone) {
  if (formatters.has(timeZone)) return formatters.get(timeZone);
  let formatter = null;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  } catch {
    formatter = null;
  }
  // Välimuisti ei sisällä käyttäjän dataa, vain muotoilijan. Koko on
  // rajattu, jotta roskasyötteiden virta ei kasvata sitä loputtomiin.
  if (formatters.size < MAX_CACHED_ZONES) formatters.set(timeZone, formatter);
  return formatter;
}

/** Kelvollinen vyöhykenimi tai oletus. Ei koskaan heitä. */
export function resolveTimeZone(value) {
  if (typeof value !== 'string') return DEFAULT_TIME_ZONE;
  const name = value.trim();
  if (name === '' || name.length > 64) return DEFAULT_TIME_ZONE;
  return formatterFor(name) ? name : DEFAULT_TIME_ZONE;
}

const ISO_DATE_PARTS = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAYS_IN_MONTH = Object.freeze([31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]);

/**
 * Onko arvo kalenterissa oleva 'YYYY-MM-DD'-päivä?
 *
 * Sama vastaus kuin task.js:n isIsoDate (testi varmistaa), mutta ilman
 * Date-olion luontia: suurilla kirjausmäärillä ero on satoja millisekunteja.
 */
export function isCalendarDate(value) {
  if (typeof value !== 'string') return false;
  const match = ISO_DATE_PARTS.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const limit = month === 2 && leap ? 29 : DAYS_IN_MONTH[month - 1];
  return day <= limit;
}

function isValidMs(ms) {
  return typeof ms === 'number' && Number.isFinite(ms) && ms >= MIN_MS && ms <= MAX_MS;
}

const pad = (n, width = 2) => String(n).padStart(width, '0');

/** Seinäkellon osat hetkestä. null, jos hetki tai vyöhyke ei kelpaa. */
function wallFields(ms, timeZone) {
  const formatter = formatterFor(timeZone) || formatterFor(DEFAULT_TIME_ZONE);
  if (!formatter || !isValidMs(ms)) return null;
  const fields = {};
  for (const part of formatter.formatToParts(ms)) {
    if (part.type !== 'literal') fields[part.type] = Number(part.value);
  }
  // Vanhat moottorit antoivat keskiyön tunnin 24:nä h23-asetuksesta huolimatta.
  if (fields.hour === 24) fields.hour = 0;
  return fields;
}

/** Vyöhykkeen ero UTC:stä millisekunteina hetkellä `ms`. */
function offsetMsAt(ms, timeZone) {
  const f = wallFields(ms, timeZone);
  if (!f) return null;
  const wallAsUtc = Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second);
  const wholeSecondMs = Math.floor(ms / 1000) * 1000;
  return wallAsUtc - wholeSecondMs;
}

/** Vyöhykkeen ero UTC:stä minuutteina (Helsinki: 120 talvella, 180 kesällä). */
export function offsetMinutesAt(ms, timeZone = DEFAULT_TIME_ZONE) {
  const offset = offsetMsAt(ms, resolveTimeZone(timeZone));
  return offset === null ? null : Math.round(offset / MINUTE_MS);
}

/**
 * YKSI AIKAMALLI. Kellonaikalaskennan ydin on src/domain/wallClock.js:
 * kutsuja antaa funktion offsetMinutesFn(epochMs) -> minuutteja UTC:stä
 * itään. Tämä silta tekee vyöhykenimestä sellaisen funktion, jotta
 * lähtö-, herätys- ja unilaskenta käyttävät samaa vyöhykettä.
 *
 * Sovelluskerros antaa AINA laitteen oman vyöhykkeen (platform), joten
 * Helsinki-oletus on vain viimeinen varasääntö suomalaiselle sovellukselle,
 * ei koskaan hiljainen oletus toisessa maassa.
 *
 * @param {string} timeZone IANA-nimi, esim. 'Europe/Helsinki'
 * @returns {(epochMs:number) => number}
 */
export function offsetFnForTimeZone(timeZone) {
  const zone = resolveTimeZone(timeZone);
  return epochMs => {
    const minutes = offsetMinutesAt(epochMs, zone);
    return minutes === null ? 0 : minutes;
  };
}

/** ISO-viikonpäivä kalenteripäivästä: 1 = maanantai ... 7 = sunnuntai. */
function isoWeekday(year, month, day) {
  // Päivä lasketaan UTC-kalenterista, joten kesäaika ei vaikuta.
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  const weekday = date.getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

/**
 * Hetken paikallinen päivä ja kellonaika.
 *
 * @returns {{date:string, time:string, minutes:number, weekday:number, offsetMinutes:number}|null}
 */
export function zonedParts(ms, timeZone = DEFAULT_TIME_ZONE) {
  const zone = resolveTimeZone(timeZone);
  const f = wallFields(ms, zone);
  if (!f) return null;
  const offset = offsetMsAt(ms, zone);
  return Object.freeze({
    date: `${pad(f.year, 4)}-${pad(f.month)}-${pad(f.day)}`,
    time: `${pad(f.hour)}:${pad(f.minute)}`,
    minutes: f.hour * 60 + f.minute,
    weekday: isoWeekday(f.year, f.month, f.day),
    offsetMinutes: Math.round(offset / MINUTE_MS)
  });
}

/** 'HH:MM' tai minuutit keskiyöstä -> minuutit (0..1439), muuten null. */
export function clockMinutes(value) {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= 0 && value < 1440 ? value : null;
  }
  if (typeof value !== 'string') return null;
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

/**
 * Paikallinen päivä + kellonaika -> hetki (epoch ms).
 *
 * Kesäajan aukossa (olematon kellonaika) hetki siirtyy aukon verran
 * eteenpäin; päällekkäisessä tunnissa valitaan ensimmäinen esiintymä.
 *
 * @param {string} dateIso 'YYYY-MM-DD'
 * @param {string|number} time 'HH:MM' tai minuutit keskiyöstä
 * @returns {number|null}
 */
export function zonedEpochMs(dateIso, time, timeZone = DEFAULT_TIME_ZONE) {
  if (!isIsoDate(dateIso)) return null;
  const minutes = clockMinutes(time);
  if (minutes === null) return null;
  const zone = resolveTimeZone(timeZone);
  const [year, month, day] = dateIso.split('-').map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  const wallAsUtc = date.getTime() + minutes * MINUTE_MS;
  if (!isValidMs(wallAsUtc)) return null;

  // Siirtymä osuu enintään yhteen kohtaan vuorokaudessa, joten ero
  // puoli vuorokautta ennen ja jälkeen kattaa molemmat mahdolliset
  // tulkinnat.
  const before = offsetMsAt(wallAsUtc - 12 * HOUR_MS, zone);
  const after = offsetMsAt(wallAsUtc + 12 * HOUR_MS, zone);
  if (before === null || after === null) return null;

  const candidates = [...new Set([wallAsUtc - before, wallAsUtc - after])]
    .filter(candidate => {
      const offset = offsetMsAt(candidate, zone);
      return offset !== null && candidate + offset === wallAsUtc;
    })
    .sort((a, b) => a - b);

  if (candidates.length > 0) return candidates[0];
  // Aukko: tulkitaan siirtymää edeltävällä erolla, jolloin hetki on
  // aukon jälkeen ja seinäkello näyttää aukon verran myöhempää aikaa.
  return wallAsUtc - before;
}

/**
 * Todellinen kesto minuutteina kahden paikallisen seinäkelloajan välillä.
 * Kesäajan vaihto huomioidaan: kevään vaihtoyö on tunnin lyhyempi.
 */
export function elapsedMinutesBetween(fromDateIso, fromTime, toDateIso, toTime, timeZone = DEFAULT_TIME_ZONE) {
  const start = zonedEpochMs(fromDateIso, fromTime, timeZone);
  const end = zonedEpochMs(toDateIso, toTime, timeZone);
  if (start === null || end === null) return null;
  return Math.round((end - start) / MINUTE_MS);
}

/** Kellonaika suomalaisittain pisteellä: '14.20'. */
export function formatClockFi(ms, timeZone = DEFAULT_TIME_ZONE) {
  const parts = zonedParts(ms, timeZone);
  return parts ? parts.time.replace(':', '.') : null;
}

const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?\s*(Z|z|[+-]\d{2}(?::?\d{2})?)?$/;

/**
 * Aikaleima -> epoch ms. Ei koskaan heitä.
 *
 * Hyväksyy luvun (ms) ja ISO-aikaleiman. Aikaleima ilman vyöhykettä
 * tulkitaan annetun vyöhykkeen seinäkelloksi — EI isäntäkoneen, jotta
 * tulos on sama jokaisella koneella. Date.parse():a ei käytetä, koska se
 * tulkitsisi vyöhykkeettömän ajan koneen omassa vyöhykkeessä.
 */
export function parseTimestampMs(value, timeZone = DEFAULT_TIME_ZONE) {
  if (typeof value === 'number') return isValidMs(value) ? value : null;
  if (typeof value !== 'string' || value.length > 40) return null;
  const match = TIMESTAMP.exec(value.trim());
  if (!match) return null;
  const [, y, mo, d, h, mi, s = '0', frac = '0', zone] = match;
  const dateIso = `${y}-${mo}-${d}`;
  if (!isIsoDate(dateIso)) return null;
  const hour = Number(h);
  const minute = Number(mi);
  const second = Number(s);
  if (hour > 23 || minute > 59 || second > 59) return null;
  const millis = Number(frac.padEnd(3, '0').slice(0, 3));

  if (zone === undefined) {
    const base = zonedEpochMs(dateIso, hour * 60 + minute, timeZone);
    return base === null ? null : base + second * 1000 + millis;
  }

  let offsetMinutes = 0;
  if (zone !== 'Z' && zone !== 'z') {
    const sign = zone[0] === '-' ? -1 : 1;
    const digits = zone.slice(1).replace(':', '');
    const offH = Number(digits.slice(0, 2));
    const offM = digits.length > 2 ? Number(digits.slice(2, 4)) : 0;
    if (offH > 18 || offM > 59) return null;
    offsetMinutes = sign * (offH * 60 + offM);
  }
  const date = new Date(0);
  date.setUTCFullYear(Number(y), Number(mo) - 1, Number(d));
  const ms = date.getTime() + hour * HOUR_MS + minute * MINUTE_MS + second * 1000 + millis
    - offsetMinutes * MINUTE_MS;
  return isValidMs(ms) ? ms : null;
}
