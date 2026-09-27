// Seinäkelloaika, kalenteripäivät ja hetket ilman aikavyöhyketietoa.
//
// PUHDAS MODUULI. Ei kelloa, ei DOM:ia, ei verkkoa, ei satunnaisuutta.
// Uni, aamu ja herätys laskevat kaiken tämän moduulin kautta, jotta
// keskiyön, kuukauden ja vuoden vaihde sekä kesäaika käsitellään yhdessä
// paikassa samalla tavalla.
//
// MIKSI DOMAIN EI TUNNE AIKAVYÖHYKETTÄ
//
// Domainin pitää olla deterministinen: sama syöte, sama tulos, missä
// tahansa koneessa. Aikavyöhyke on ajoympäristön tietoa. Siksi kutsuja
// antaa funktion offsetMinutesFn(epochMs), joka kertoo, montako minuuttia
// paikallinen aika on UTC:stä edellä sillä hetkellä (Helsinki talvella
// 120, kesällä 180). Selaimessa sen saa Date-olion getTimezoneOffset-arvon
// vastalukuna. Testit antavat kiinteän Helsinki-funktion.
//
// KESÄAJAN KAKSI ONGELMAA
//
//   Kevät (Helsinki su 29.3.2026 klo 03.00 -> 04.00): kellonaikoja
//   03.00-03.59 ei ole olemassa. Herätys 03.30 siirtyy seuraavaan
//   olemassa olevaan minuuttiin 04.00, ja tulos kertoo siirrosta.
//
//   Syksy (Helsinki su 25.10.2026 klo 04.00 -> 03.00): kellonajat
//   03.00-03.59 esiintyvät kahdesti. Valitaan ENSIMMÄINEN esiintymä:
//   herätys ei koskaan soi tuntia myöhässä.
//
// Ilman aikavyöhykefunktiota laskenta tehdään seinäkellolla (ZERO_OFFSET):
// silloin vuorokaudessa on aina 24 tuntia. Sisäisesti uni, aamu ja herätys
// käyttävät samaa koodipolkua molemmissa tapauksissa.

import { isIsoDate, isTimeOfDay, toMinutes, fromMinutes } from './task.js';

export const MINUTES_PER_DAY = 1440;
const MS_PER_MINUTE = 60000;
const MS_PER_DAY = MINUTES_PER_DAY * MS_PER_MINUTE;

/** Suurin järkevä aikavyöhykepoikkeama (±18 h, kuten ECMAScript sallii). */
const MAX_OFFSET_MINUTES = 18 * 60;

/** Aikavyöhyke ilman poikkeamaa: seinäkello = laskentakello. */
export const ZERO_OFFSET = Object.freeze(() => 0);

// ------------------------------------------------------------ kalenteri

// Päivänumerot lasketaan puhtaalla kokonaislukuaritmetiikalla (Howard
// Hinnantin days_from_civil). Date-oliota ei tarvita, joten kesäaika tai
// ajoympäristön aikavyöhyke ei voi siirtää päivää.

function daysFromCivil(year, month, day) {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yearOfEra = y - era * 400;
  const shiftedMonth = (month + 9) % 12;
  const dayOfYear = Math.floor((153 * shiftedMonth + 2) / 5) + day - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146097 + dayOfEra - 719468;
}

function civilFromDays(number) {
  const z = number + 719468;
  const era = Math.floor(z / 146097);
  const dayOfEra = z - era * 146097;
  const yearOfEra = Math.floor((dayOfEra - Math.floor(dayOfEra / 1460) + Math.floor(dayOfEra / 36524)
    - Math.floor(dayOfEra / 146096)) / 365);
  const dayOfYear = dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const shiftedMonth = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * shiftedMonth + 2) / 5) + 1;
  const month = shiftedMonth < 10 ? shiftedMonth + 3 : shiftedMonth - 9;
  return [yearOfEra + era * 400 + (month <= 2 ? 1 : 0), month, day];
}

/** 'YYYY-MM-DD' -> päiviä 1970-01-01:stä; virheellinen -> null. */
export function dayNumberOf(iso) {
  if (!isIsoDate(iso)) return null;
  const [year, month, day] = iso.split('-').map(Number);
  return daysFromCivil(year, month, day);
}

/** Päivänumero -> 'YYYY-MM-DD'; vuoden 0000-9999 ulkopuolella null. */
export function isoOfDayNumber(number) {
  if (!Number.isInteger(number)) return null;
  const [year, month, day] = civilFromDays(number);
  if (year < 0 || year > 9999) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Päivä + n päivää. Kuukauden ja vuoden vaihde rullaavat oikein. */
export function shiftDateIso(iso, days) {
  const number = dayNumberOf(iso);
  if (number === null || !Number.isInteger(days)) return null;
  return isoOfDayNumber(number + days);
}

/** ISO-viikonpäivä: 1 = maanantai ... 7 = sunnuntai; virheellinen -> null. */
export function isoWeekday(iso) {
  const number = dayNumberOf(iso);
  if (number === null) return null;
  return ((number % 7) + 7 + 3) % 7 + 1;
}

/** Lauantai- tai sunnuntaiaamu. */
export function isWeekendIso(iso) {
  const weekday = isoWeekday(iso);
  return weekday === 6 || weekday === 7;
}

// ------------------------------------------------------------ hetket

/**
 * Kutsujan aikavyöhykefunktio suojattuna: heittävä tai järjetön arvo on
 * tuntematon (null), ei nolla. Poikkeaman pitää olla kokonaisia minuutteja.
 */
function offsetAt(offsetMinutesFn, epochMs) {
  let value;
  try {
    value = offsetMinutesFn(epochMs);
  } catch {
    return null;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || Math.abs(value) > MAX_OFFSET_MINUTES) return null;
  return value;
}

/** Seinäkello laskentamillisekunteina ikään kuin UTC olisi paikallinen aika. */
function naiveMs(date, time) {
  const day = dayNumberOf(date);
  if (day === null || !isTimeOfDay(time)) return null;
  return day * MS_PER_DAY + toMinutes(time) * MS_PER_MINUTE;
}

function wallFromNaive(ms) {
  const day = Math.floor(ms / MS_PER_DAY);
  const minutes = Math.floor((ms - day * MS_PER_DAY) / MS_PER_MINUTE);
  const date = isoOfDayNumber(day);
  if (date === null) return null;
  return { date, time: fromMinutes(minutes) };
}

/**
 * Seinäkelloaika -> hetki (epoch-millisekunnit).
 *
 * offsetMinutesFn(epochMs) palauttaa paikallisen ajan poikkeaman UTC:stä
 * minuutteina (itään positiivinen). Ilman funktiota ei arvata: null.
 *
 * - Olematon aika (kevään siirtymä): seuraava olemassa oleva minuutti,
 *   adjusted = true, nonexistent = true, time = todellinen soittoaika.
 * - Kahdesti esiintyvä aika (syksyn siirtymä): ensimmäinen esiintymä,
 *   ambiguous = true.
 *
 * @returns {null | {epochMs, date, time, requestedTime, offsetMinutes,
 *                   adjusted, nonexistent, ambiguous}}
 */
export function wallClockToEpoch(date, time, offsetMinutesFn) {
  if (typeof offsetMinutesFn !== 'function') return null;
  const local = naiveMs(date, time);
  if (local === null) return null;

  // Poikkeama vuorokautta ennen ja jälkeen: siirtymä on niiden välissä,
  // jos sellainen on. Todellisissa vyöhykkeissä kahden päivän sisällä on
  // enintään yksi siirtymä.
  const before = offsetAt(offsetMinutesFn, local - MS_PER_DAY);
  const after = offsetAt(offsetMinutesFn, local + MS_PER_DAY);
  if (before === null || after === null) return null;

  const valid = [];
  for (const offset of before === after ? [before] : [before, after]) {
    const epochMs = local - offset * MS_PER_MINUTE;
    if (offsetAt(offsetMinutesFn, epochMs) === offset) valid.push({ epochMs, offset });
  }
  valid.sort((a, b) => a.epochMs - b.epochMs);

  if (valid.length > 0) {
    const first = valid[0];
    return Object.freeze({
      epochMs: first.epochMs,
      date,
      time,
      requestedTime: time,
      offsetMinutes: first.offset,
      adjusted: false,
      nonexistent: false,
      ambiguous: valid.length > 1
    });
  }

  // Olematon aika. Siirtymähetki on välillä [local - suurempi poikkeama,
  // local - pienempi poikkeama]; etsitään se minuutin tarkkuudella
  // puolitushaulla (enintään ~11 kierrosta 18 tunnin välille).
  const low = Math.min(before, after);
  const high = Math.max(before, after);
  let a = (local - high * MS_PER_MINUTE) / MS_PER_MINUTE;
  let b = (local - low * MS_PER_MINUTE) / MS_PER_MINUTE;
  const startOffset = offsetAt(offsetMinutesFn, a * MS_PER_MINUTE);
  const endOffset = offsetAt(offsetMinutesFn, b * MS_PER_MINUTE);
  if (startOffset === null || endOffset === null || startOffset === endOffset) return null;
  while (b - a > 1) {
    const middle = Math.floor((a + b) / 2);
    if (offsetAt(offsetMinutesFn, middle * MS_PER_MINUTE) === startOffset) a = middle;
    else b = middle;
  }
  const epochMs = b * MS_PER_MINUTE;
  const offset = offsetAt(offsetMinutesFn, epochMs);
  if (offset === null) return null;
  const wall = wallFromNaive(epochMs + offset * MS_PER_MINUTE);
  if (!wall) return null;
  return Object.freeze({
    epochMs,
    date: wall.date,
    time: wall.time,
    requestedTime: time,
    offsetMinutes: offset,
    adjusted: true,
    nonexistent: true,
    ambiguous: false
  });
}

/** Hetki -> seinäkelloaika {date, time, offsetMinutes}; sekunnit katkaistaan. */
export function epochToWallClock(epochMs, offsetMinutesFn) {
  if (typeof offsetMinutesFn !== 'function' || typeof epochMs !== 'number' || !Number.isFinite(epochMs)) return null;
  const offset = offsetAt(offsetMinutesFn, epochMs);
  if (offset === null) return null;
  const wall = wallFromNaive(epochMs + offset * MS_PER_MINUTE);
  if (!wall) return null;
  return Object.freeze({ date: wall.date, time: wall.time, offsetMinutes: offset });
}

/**
 * Kulunut aika minuutteina seinäkelloajasta toiseen. Aikavyöhykefunktion
 * kanssa todellinen kesto (kevään yö on tunnin lyhyempi), ilman sitä
 * seinäkellon erotus. Virheellinen syöte -> null.
 */
export function elapsedMinutes(from, to, offsetMinutesFn = ZERO_OFFSET) {
  if (!from || !to || typeof from !== 'object' || typeof to !== 'object') return null;
  const fn = typeof offsetMinutesFn === 'function' ? offsetMinutesFn : ZERO_OFFSET;
  const start = wallClockToEpoch(from.date, from.time, fn);
  const end = wallClockToEpoch(to.date, to.time, fn);
  if (!start || !end) return null;
  return Math.round((end.epochMs - start.epochMs) / MS_PER_MINUTE);
}

// ------------------------------------------------------------ teksti

/** '05:30' -> '5.30' (suomalainen kellonaika puheessa ja tekstissä). */
export function clockText(time) {
  if (!isTimeOfDay(time)) return '';
  const [hours, minutes] = time.split(':');
  return `${Number(hours)}.${minutes}`;
}

/** 120 -> '2 h', 90 -> '1 h 30 min', 20 -> '20 min'. Tuntematon -> ''. */
export function durationText(minutes) {
  if (typeof minutes !== 'number' || !Number.isFinite(minutes)) return '';
  const total = Math.round(Math.abs(minutes));
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  if (hours === 0) return `${rest} min`;
  if (rest === 0) return `${hours} h`;
  return `${hours} h ${rest} min`;
}
