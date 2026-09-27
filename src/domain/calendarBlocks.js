// Suojatut lohkot: valmistautuminen, matka, pysäköinti, perilläolon
// varmuusaika, rauhoittuminen ja uni.
//
// PUHDAS MODUULI. Ei kelloa, ei DOM:ia, ei verkkoa, ei satunnaisuutta.
// Lohkot LASKETAAN aina uudelleen eikä niitä tallenneta, kuten
// rutiinien ja tapahtumien esiintymät.
//
// =====================================================================
// SUOJATTU VÄLJYYS
// =====================================================================
//
// Matka, valmistautuminen, perilläolon varmuusaika, lepo ja uni EIVÄT ole
// vapaata aikaa. Kun ne ovat kalenterissa lohkoina, aikataulumoottori
// kiertää ne (scheduler.js), kapasiteetti vähentää ne kertaalleen
// (capacity.js) ja ristiriidat kertovat, jos kiinteä merkintä osuu
// niihin (conflicts.js).
//
// =====================================================================
// EI KEKSITTYÄ LÄHTÖÄ
// =====================================================================
//
// Lähtöluvut tulevat kutsujan funktiosta `departureFor(esiintymä)`
// (lähtömoottori: tapahtuma > paikka > oletus, opittu vain luvalla).
// Jos matka-aikaa ei tiedetä, funktio palauttaa `{ known: false }`, eikä
// tapahtumalle synny YHTÄÄN lohkoa. Tuntematon ei ole nolla: ristiriita-
// tarkistus kertoo siitä käyttäjälle (conflicts.js TRAVEL_UNKNOWN).
//
// Absoluuttiset minuutit ovat päivän järjestysluku × 1440 + minuutit,
// sama asteikko kuin travel.js ja calendar.js käyttävät. Lohko, joka
// ylittää keskiyön, pilkotaan päiväkohtaisiksi paloiksi, koska
// päiväsuunnitelma näkee vain yhden vuorokauden kerrallaan.
//
// Ajat ovat seinäkelloaikaa: kesäajan vaihto ei siirrä lohkoa.

import {
  BLOCK_KIND, BLOCK_KINDS, PRESENCE_BLOCK_KINDS, REST_BLOCK_KINDS,
  blocksOnDate, indexCalendarBlocks, isEventOccurrence
} from './scheduler.js';
import { isIsoDate, isTimeOfDay, toMinutes, fromMinutes } from './task.js';
import { isoOfDayNumber, absoluteMinutesOf, addDaysToIso, blockLabel } from './calendar.js';
import {
  DEFAULT_WIND_DOWN_MINUTES, MAX_WIND_DOWN_MINUTES, MAX_TRAVEL_MINUTES,
  MAX_PREPARATION_MINUTES, MAX_OVERHEAD_MINUTES, MAX_PLACE_ARRIVAL_BUFFER_MINUTES
} from './dailyLife.js';

export { BLOCK_KIND, BLOCK_KINDS, PRESENCE_BLOCK_KINDS, REST_BLOCK_KINDS };
export { blockLabel as blockKindLabel };

/**
 * Pisin uskottava lähtöketju: valmistautuminen + matka + pysäköinti +
 * varmuusaika. Pidempi on syöttövirhe, ja siitä syntyisi lohko, joka
 * peittäisi päiviä.
 */
export const MAX_DEPARTURE_SPAN_MINUTES = MAX_PREPARATION_MINUTES + MAX_TRAVEL_MINUTES
  + MAX_OVERHEAD_MINUTES + MAX_PLACE_ARRIVAL_BUFFER_MINUTES;

const EMPTY = Object.freeze([]);
const KIND_ORDER = new Map(BLOCK_KINDS.map((kind, index) => [kind, index]));

function safely(fn, fallback) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function compareText(a, b) {
  const x = String(a);
  const y = String(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * Pilko väli [startAbs, endAbs) kalenteripäivien palasiksi.
 * Tyhjä tai käänteinen väli ei tuota mitään.
 *
 * @returns {Array<{date:string, startMinute:number, endMinute:number, startAbs:number, endAbs:number}>}
 */
export function splitAtMidnight(startAbs, endAbs) {
  if (!Number.isInteger(startAbs) || !Number.isInteger(endAbs) || endAbs <= startAbs) return [];
  // Suoja: yli kolmen vuorokauden väli ei ole lohko vaan virhe.
  if (endAbs - startAbs > 3 * 1440) return [];

  const pieces = [];
  let cursor = startAbs;
  while (cursor < endAbs) {
    const day = Math.floor(cursor / 1440);
    const dayEnd = (day + 1) * 1440;
    const pieceEnd = Math.min(endAbs, dayEnd);
    const date = isoOfDayNumber(day);
    if (date === null) return [];
    pieces.push({
      date,
      startMinute: cursor - day * 1440,
      endMinute: pieceEnd - day * 1440,
      startAbs: cursor,
      endAbs: pieceEnd
    });
    cursor = pieceEnd;
  }
  return pieces;
}

/** Yksi lohko päiväkohtaisina, jäädytettyinä paloina. */
function blockPieces({
  kind, sourceId, eventId = null, occurrenceId = null, sourceTitle = null,
  category, startAbs, endAbs, title, explanation
}) {
  const parts = splitAtMidnight(startAbs, endAbs);
  return parts.map((piece, index) => Object.freeze({
    id: `block:${kind}:${sourceId}:${piece.date}`,
    kind,
    blockKind: kind,
    block: true,
    protected: true,
    completed: false,
    sourceId,
    eventId,
    occurrenceId,
    sourceTitle,
    date: piece.date,
    time: fromMinutes(piece.startMinute),
    // Vuorokauden mittainen pala: loppuaika olisi sama kuin alku, joten
    // kesto kerrotaan pelkällä durationMinutes-kentällä (task.durationOf).
    endTime: piece.endMinute - piece.startMinute >= 1440 ? null : fromMinutes(piece.endMinute),
    durationMinutes: piece.endMinute - piece.startMinute,
    startMinute: piece.startMinute,
    endMinute: piece.endMinute,
    startAbs: piece.startAbs,
    endAbs: piece.endAbs,
    /** Koko lohko ennen pilkkomista. */
    spanStartAbs: startAbs,
    spanEndAbs: endAbs,
    part: index + 1,
    parts: parts.length,
    continuesFromPreviousDay: index > 0,
    continuesToNextDay: index < parts.length - 1,
    title,
    category,
    explanation
  }));
}

function compareBlocks(a, b) {
  return compareText(a.date, b.date)
    || a.startMinute - b.startMinute
    || KIND_ORDER.get(a.kind) - KIND_ORDER.get(b.kind)
    || compareText(a.id, b.id);
}

// =====================================================================
// LÄHTÖ: VALMISTAUTUMINEN, MATKA, PYSÄKÖINTI, VARMUUSAIKA
// =====================================================================

function wholeMinutes(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null;
}

/** Kokonaisluku välillä [0, max]; puuttuva = 0 (ei varattavaa); roska = hylkäys. */
function optionalPart(value, max) {
  if (value === null || value === undefined) return 0;
  const n = wholeMinutes(value);
  return n !== null && n >= 0 && n <= max ? n : undefined;
}

/**
 * Lue lähtömoottorin vastaus. Palauttaa null, jos lähtöä ei tiedetä tai
 * luvut eivät ole johdonmukaisia — silloin EI varata mitään, koska väärään
 * kohtaan varattu matka olisi pahempi kuin rehellinen "ei tiedossa".
 */
function readDeparture(raw, expectedStartAbs) {
  if (!raw || typeof raw !== 'object' || raw.known !== true) return null;

  const prepareStartAbs = wholeMinutes(raw.prepareStartAbs);
  const leaveAbs = wholeMinutes(raw.leaveAbs);
  const startAbs = wholeMinutes(raw.startAbs);
  if (prepareStartAbs === null || leaveAbs === null || startAbs === null) return null;

  // Matka-aika on lähdön ydin: "tiedossa" ilman matka-aikaa on ristiriita.
  const travel = wholeMinutes(raw.travelMinutes);
  if (travel === null || travel < 0 || travel > MAX_TRAVEL_MINUTES) return null;
  const overhead = optionalPart(raw.overheadMinutes, MAX_OVERHEAD_MINUTES);
  const early = optionalPart(raw.earlyMinutes, MAX_PLACE_ARRIVAL_BUFFER_MINUTES);
  if (overhead === undefined || early === undefined) return null;

  // Lähtö lasketaan TÄMÄN esiintymän alusta. Muu alku tarkoittaa, että
  // luvut kuuluvat toiselle päivälle tai toiselle tapahtumalle.
  if (startAbs !== expectedStartAbs) return null;
  if (!(prepareStartAbs <= leaveAbs && leaveAbs <= startAbs)) return null;
  if (startAbs - prepareStartAbs > MAX_DEPARTURE_SPAN_MINUTES) return null;

  return { prepareStartAbs, leaveAbs, startAbs, travel, overhead, early };
}

function isTimedOccurrence(item) {
  return safely(() => isEventOccurrence(item)
    && item.allDay !== true && item.continuation !== true
    && isTimeOfDay(item.time)
    && item.id != null && String(item.id) !== '', false);
}

function clockOf(abs) {
  return fromMinutes(((abs % 1440) + 1440) % 1440);
}

/**
 * Tapahtumien lähtölohkot.
 *
 * Jokaiselle ajalliselle esiintymälle kysytään `departureFor(esiintymä)`:
 *   { known: false }                                  -> ei lohkoja
 *   { known: true, prepareStartAbs, leaveAbs, travelMinutes,
 *     overheadMinutes, earlyMinutes, startAbs }        -> lohkot:
 *
 *   PREPARATION     [prepareStartAbs, leaveAbs)
 *   TRAVEL          [leaveAbs, leaveAbs + matka)
 *   OVERHEAD        [.. , .. + pysäköinti ja kävely)
 *   ARRIVAL_BUFFER  [.. , tapahtuman alku)
 *
 * Nollan mittainen osa ei tuota lohkoa. Heittävä tai roskaa palauttava
 * funktio tulkitaan tuntemattomaksi lähdöksi.
 *
 * @param {object}   input
 * @param {Array}    input.occurrences   calendar.js expandEventOccurrences(...)
 * @param {Function} input.departureFor  esiintymä -> lähtöluvut
 * @returns {ReadonlyArray<object>}
 */
export function eventBlocks({ occurrences = [], departureFor = null } = {}) {
  if (typeof departureFor !== 'function' || !Array.isArray(occurrences)) return EMPTY;

  const blocks = [];
  const seen = new Set();

  for (const occurrence of occurrences) {
    if (!isTimedOccurrence(occurrence)) continue;
    const occurrenceId = String(occurrence.id);
    if (seen.has(occurrenceId)) continue;
    seen.add(occurrenceId);

    const expectedStart = absoluteMinutesOf(occurrence.date, toMinutes(occurrence.time));
    // Heittävä funktio tai heittävä vastaus = tuntematon lähtö.
    const departure = safely(() => readDeparture(departureFor(occurrence), expectedStart), null);
    if (!departure) continue;

    const { prepareStartAbs, leaveAbs, startAbs, travel, overhead } = departure;
    const travelEnd = Math.min(leaveAbs + travel, startAbs);
    const overheadEnd = Math.min(travelEnd + overhead, startAbs);
    const title = safely(() => (typeof occurrence.title === 'string' && occurrence.title.trim()
      ? occurrence.title.trim() : 'Tapahtuma'), 'Tapahtuma');
    const category = safely(() => (typeof occurrence.category === 'string' && occurrence.category
      ? occurrence.category : 'muu'), 'muu');
    const leave = clockOf(leaveAbs);
    const start = clockOf(startAbs);
    const common = {
      sourceId: occurrenceId,
      eventId: safely(() => (occurrence.eventId != null ? String(occurrence.eventId) : null), null),
      occurrenceId,
      sourceTitle: title,
      category
    };

    blocks.push(
      ...blockPieces({
        ...common,
        kind: BLOCK_KIND.PREPARATION,
        startAbs: prepareStartAbs,
        endAbs: leaveAbs,
        title: `${blockLabel(BLOCK_KIND.PREPARATION)} · ${title}`,
        explanation: `Valmistaudu lähtöön klo ${clockOf(prepareStartAbs)}–${leave}, `
          + `jotta ehdit tapahtumaan "${title}" klo ${start}.`
      }),
      ...blockPieces({
        ...common,
        kind: BLOCK_KIND.TRAVEL,
        startAbs: leaveAbs,
        endAbs: travelEnd,
        title: `${blockLabel(BLOCK_KIND.TRAVEL)} · ${title}`,
        explanation: `Lähde klo ${leave}. Matka kestää noin ${travel} min.`
      }),
      ...blockPieces({
        ...common,
        kind: BLOCK_KIND.OVERHEAD,
        startAbs: travelEnd,
        endAbs: overheadEnd,
        title: `${blockLabel(BLOCK_KIND.OVERHEAD)} · ${title}`,
        explanation: `Pysäköinti ja kävely perille noin ${overheadEnd - travelEnd} min.`
      }),
      ...blockPieces({
        ...common,
        kind: BLOCK_KIND.ARRIVAL_BUFFER,
        startAbs: overheadEnd,
        endAbs: startAbs,
        title: `${blockLabel(BLOCK_KIND.ARRIVAL_BUFFER)} · ${title}`,
        explanation: `Olet perillä ${startAbs - overheadEnd} min ennen alkua klo ${start}. `
          + 'Mieluummin ajoissa kuin kiireessä.'
      })
    );
  }

  return Object.freeze(blocks.sort(compareBlocks));
}

// =====================================================================
// UNI JA RAUHOITTUMINEN
// =====================================================================

function windDownOf(value) {
  // Puuttuva arvo = asetusten oletus (life_settings.wind_down_minutes).
  // Se on käyttäjän asetus, ei mittaus, joten oletus ei keksi tietoa.
  if (value === null || value === undefined) return DEFAULT_WIND_DOWN_MINUTES;
  const n = wholeMinutes(value);
  if (n === null) return DEFAULT_WIND_DOWN_MINUTES;
  return Math.max(0, Math.min(MAX_WIND_DOWN_MINUTES, n));
}

function readSleep(raw) {
  return safely(() => {
    if (!raw || typeof raw !== 'object') return null;
    if (!isIsoDate(raw.date) || !isTimeOfDay(raw.bedtime) || !isTimeOfDay(raw.wakeTime)) return null;
    if (raw.bedtime === raw.wakeTime) return null;

    const wakeDate = addDaysToIso(raw.date, 1);
    if (!wakeDate) return null;
    const wakeAbs = absoluteMinutesOf(wakeDate, toMinutes(raw.wakeTime));
    // Nukkumaanmeno on viimeisin `bedtime` ennen herätystä: klo 00:30
    // tarkoittaa yötä herätyspäivän puolella, klo 23:00 edellistä iltaa.
    const sleepMinutes = (toMinutes(raw.wakeTime) - toMinutes(raw.bedtime) + 1440) % 1440;
    return {
      date: raw.date,
      bedtime: raw.bedtime,
      wakeTime: raw.wakeTime,
      windDown: windDownOf(raw.windDownMinutes),
      wakeAbs,
      bedAbs: wakeAbs - sleepMinutes
    };
  }, null);
}

/**
 * Unen ja rauhoittumisen lohkot.
 *
 * Aikataulu on yön mukaan: `date` on ilta, jolloin yö alkaa, ja
 * `wakeTime` on SEURAAVAN päivän herätys.
 *
 *   SLEEP      [nukkumaanmeno, herätys)
 *   WIND_DOWN  [nukkumaanmeno − windDownMinutes, nukkumaanmeno)
 *
 * Sama ilta kahdesti: valitaan sisällön mukaan, ei syötteen järjestyksen.
 *
 * @param {object} input
 * @param {Array}  input.schedules  [{ date, bedtime, wakeTime, windDownMinutes }]
 * @returns {ReadonlyArray<object>}
 */
export function sleepBlocks({ schedules = [] } = {}) {
  if (!Array.isArray(schedules)) return EMPTY;

  const byDate = new Map();
  for (const raw of schedules) {
    const sleep = readSleep(raw);
    if (!sleep) continue;
    const key = `${sleep.bedtime}|${sleep.wakeTime}|${String(sleep.windDown).padStart(3, '0')}`;
    const previous = byDate.get(sleep.date);
    if (!previous || key < previous.key) byDate.set(sleep.date, { key, sleep });
  }

  const blocks = [];
  for (const { sleep } of byDate.values()) {
    const sourceId = `night:${sleep.date}`;
    const bed = sleep.bedtime;
    const wake = sleep.wakeTime;

    if (sleep.windDown > 0) {
      blocks.push(...blockPieces({
        kind: BLOCK_KIND.WIND_DOWN,
        sourceId,
        category: 'hyvinvointi',
        startAbs: sleep.bedAbs - sleep.windDown,
        endAbs: sleep.bedAbs,
        title: blockLabel(BLOCK_KIND.WIND_DOWN),
        explanation: `Rauhoittumisaika ennen nukkumaanmenoa klo ${bed}.`
      }));
    }

    blocks.push(...blockPieces({
      kind: BLOCK_KIND.SLEEP,
      sourceId,
      category: 'hyvinvointi',
      startAbs: sleep.bedAbs,
      endAbs: sleep.wakeAbs,
      title: blockLabel(BLOCK_KIND.SLEEP),
      explanation: `Suojattu uni klo ${bed}–${wake}. Mikään automaattinen suunnitelma ei vie tätä aikaa.`
    }));
  }

  return Object.freeze(blocks.sort(compareBlocks));
}

// =====================================================================
// KOKOAVA JA HAKU
// =====================================================================

/**
 * Kaikki lohkot yhtenä jäädytettynä, järjestettynä listana.
 *
 * @param {object}   input
 * @param {Array}    [input.occurrences]
 * @param {Function} [input.departureFor]
 * @param {Array}    [input.sleepSchedules]
 */
export function deriveBlocks({ occurrences = [], departureFor = null, sleepSchedules = [] } = {}) {
  const all = [
    ...eventBlocks({ occurrences, departureFor }),
    ...sleepBlocks({ schedules: sleepSchedules })
  ];
  // Tunniste on yksikäsitteinen lähteen, lajin ja päivän mukaan; sama
  // tunniste kahdesti tarkoittaisi päällekkäistä syötettä.
  const unique = new Map();
  for (const block of all) if (!unique.has(block.id)) unique.set(block.id, block);
  return Object.freeze([...unique.values()].sort(compareBlocks));
}

/**
 * Päivän lohkot. Jäädytetylle listalle (deriveBlocks palauttaa sellaisen)
 * indeksi rakennetaan kerran, ja jokainen haku sen jälkeen on O(1).
 */
export function blocksOn(blocks, dateIso) {
  return blocksOnDate(blocks, dateIso);
}

/**
 * Valmis päiväindeksi muuttuvasta listasta: rakennetaan kerran, ja
 * `blocksOn(indeksi, päivä)` on sen jälkeen O(1).
 */
export function indexBlocks(blocks) {
  return indexCalendarBlocks(blocks);
}
