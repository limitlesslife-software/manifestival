// Aikataulumoottori.
//
// TÄMÄ MODUULI ON PUHDAS. Se ei kirjoita DOM:iin, ei kutsu Supabasea, ei tee
// verkkokutsuja eikä lue globaalia tilaa. Kaikki syötteet tulevat parametreina
// ja sama syöte tuottaa aina saman tuloksen. Nykyhetki annetaan parametrina,
// jotta testit ovat toistettavia.
//
// Aiemmin tämä logiikka luki suoraan globaalia `state`-oliota index.html:n
// sisällä, joten sitä ei voinut testata lainkaan.
//
// Moottori vastaa kahteen kysymykseen:
//   1. Milloin päivä alkaa ja päättyy? (herätys, aamutoimet, nukkumaanmeno)
//   2. Mihin aikatauluttamattomat tehtävät mahtuvat? (ehdotukset)

import { fmtISO, parseISO, addDays, subtractMinutes, addMinutes, sortByTime, loadClass } from '../lib/datetime.js';
import {
  toMinutes, fromMinutes, durationOf, isMovableByScheduler, compareForDay,
  isOverdue, deadlineUrgency, schedulingUrgencyWeight, urgencyLabel, URGENCY,
  isIsoDate, isTimeOfDay, SCHEDULING
} from './task.js';
import { priorityWeight, priorityLabel } from './priority.js';
import { expandRoutines, ROUTINE_SCHEDULING } from './routine.js';

export const DEFAULT_PROFILE = Object.freeze({
  age: null,
  weightKg: null,
  heightCm: null,
  sleepTargetHours: 8,
  defaultWakeTime: '07:00',
  commuteMinutes: 30,
  routineMinutes: 60
});

/** Lyhin vapaa väli, jota kannattaa ehdottaa. Alle tämän ei ole hyötyä. */
export const MIN_USEFUL_SLOT_MINUTES = 15;

/** Oletuskesto tehtävälle, jonka kestoa ei tiedetä. */
export const DEFAULT_TASK_MINUTES = 30;

function profileOf(profile) {
  return { ...DEFAULT_PROFILE, ...(profile || {}) };
}

function tasksOn(tasks, dateIso) {
  return tasks.filter(t => t.date === dateIso);
}

/**
 * Päivän ensimmäinen aikataulutettu työtehtävä. Tämä on ankkuri, josta
 * herätysaika lasketaan taaksepäin.
 */
export function findWorkAnchor(tasks, dateIso) {
  return tasksOn(tasks, dateIso)
    .filter(t => t.category === 'tyo' && t.time)
    .sort(sortByTime)[0] || null;
}

/**
 * Päivän herätysaika.
 *
 * Järjestys:
 *   1. Käyttäjän itse merkitsemä herätys (isWake) voittaa aina.
 *   2. Muuten: ensimmäinen työtehtävä − työmatka − aamutoimet.
 *   3. Muuten: profiilin oletusheräämisaika.
 *
 * @returns {{time: string, auto: boolean, basedOn?: object}}
 */
export function computeWakeTime({ tasks, profile, dateIso }) {
  const p = profileOf(profile);
  const manual = tasksOn(tasks, dateIso).find(t => t.isWake && t.time);
  if (manual) return { time: manual.time, auto: false };

  const work = findWorkAnchor(tasks, dateIso);
  if (work) {
    return {
      time: subtractMinutes(work.time, p.commuteMinutes + p.routineMinutes),
      auto: true,
      basedOn: work
    };
  }
  return { time: p.defaultWakeTime || '07:00', auto: true };
}

/**
 * Illan nukkumaanmenoaika: HUOMISEN herätysajasta vähennetään unitavoite.
 *
 * Tämä on tuotteen ydinajatus: uni ei ole "se mikä jää yli", vaan sille
 * varataan aika kalenterista (konseptidokumentti, luku 13).
 */
export function computeBedtime({ tasks, profile, dateIso }) {
  const p = profileOf(profile);
  const tomorrow = fmtISO(addDays(parseISO(dateIso), 1));
  const wake = computeWakeTime({ tasks, profile: p, dateIso: tomorrow });
  const targetMinutes = (p.sleepTargetHours || 8) * 60;
  return {
    bedtime: subtractMinutes(wake.time, targetMinutes),
    wakeTime: wake.time,
    wakeAuto: wake.auto
  };
}

/**
 * Onko käyttäjällä oma merkintä, joka alkaa välillä [start, end)?
 * Käytetään siihen, ettei automaattinen ehdotus koskaan päällekkäisty
 * käyttäjän oman suunnitelman kanssa.
 */
export function hasManualCoverage(tasks, dateIso, start, end) {
  return tasksOn(tasks, dateIso).some(t => t.time && t.time >= start && t.time < end);
}

/**
 * Automaattiset ehdotusmerkinnät päivälle: herätys, aamutoimet ja uni.
 * Näitä EI tallenneta tietokantaan — ne lasketaan aina uudelleen, joten ne
 * pysyvät ajan tasalla, kun suunnitelma muuttuu.
 */
export function buildVirtualItems({ tasks, profile, dateIso }) {
  const p = profileOf(profile);
  const items = [];

  const wake = computeWakeTime({ tasks, profile: p, dateIso });
  if (wake.auto) {
    items.push({
      id: 'virtual-wake',
      date: dateIso,
      time: wake.time,
      endTime: null,
      title: 'Herätys',
      category: 'hyvinvointi',
      completed: false,
      isWake: true,
      virtual: true,
      note: wake.basedOn
        ? `automaattinen ehdotus · ${p.commuteMinutes} min matka + ${p.routineMinutes} min aamutoimet`
        : 'automaattinen ehdotus (oletusaika)'
    });
  }

  const routineEnd = addMinutes(wake.time, p.routineMinutes);
  if (!hasManualCoverage(tasks, dateIso, wake.time, routineEnd)) {
    items.push({
      id: 'virtual-routine',
      date: dateIso,
      time: wake.time,
      endTime: routineEnd,
      title: 'Aamutoimet',
      category: 'hyvinvointi',
      completed: false,
      isWake: false,
      virtual: true,
      note: 'automaattinen ehdotus'
    });
  }

  const bt = computeBedtime({ tasks, profile: p, dateIso });
  items.push({
    id: 'virtual-sleep',
    date: dateIso,
    time: bt.bedtime,
    endTime: bt.wakeTime,
    title: 'Uni',
    category: 'hyvinvointi',
    completed: false,
    isWake: false,
    virtual: true,
    note: 'automaattinen ehdotus'
  });

  return items;
}

/**
 * Valveillaoloikkuna minuutteina: [herätys, nukkumaanmeno).
 * Jos nukkumaanmeno on herätystä aiemmin (mennään keskiyön yli), ikkuna
 * päättyy vuorokauden vaihteeseen.
 */
export function awakeWindow({ tasks, profile, dateIso }) {
  const wake = computeWakeTime({ tasks, profile, dateIso });
  const bt = computeBedtime({ tasks, profile, dateIso });
  const start = toMinutes(wake.time);
  const bedMinutes = toMinutes(bt.bedtime);
  const end = bedMinutes > start ? bedMinutes : 1440;
  return { start, end, wakeTime: wake.time, bedtime: bt.bedtime };
}

/**
 * Varatut aikavälit minuutteina. Ajattomat tehtävät eivät varaa mitään.
 * Palautus on järjestetty ja yhdistetty (päällekkäiset välit sulautetaan).
 */
export function occupiedRanges(items) {
  const ranges = items
    .filter(it => it.time)
    .map(it => {
      const start = toMinutes(it.time);
      const length = durationOf(it) ?? DEFAULT_TASK_MINUTES;
      return { start, end: Math.min(start + length, 1440) };
    })
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const merged = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

/**
 * Vapaat aikavälit valveillaoloikkunassa.
 * @returns {Array<{start:number,end:number,minutes:number,startTime:string,endTime:string}>}
 */
export function findFreeSlots({ items, range, minMinutes = MIN_USEFUL_SLOT_MINUTES }) {
  const occupied = occupiedRanges(items);
  const slots = [];
  let cursor = range.start;

  for (const busy of occupied) {
    if (busy.end <= range.start) continue;   // kokonaan ikkunan alapuolella
    if (busy.start >= range.end) break;      // loput ovat ikkunan yläpuolella

    const gap = Math.min(busy.start, range.end) - cursor;
    if (gap >= minMinutes) slots.push({ start: cursor, end: cursor + gap });

    cursor = Math.max(cursor, Math.min(busy.end, range.end));
  }

  if (range.end - cursor >= minMinutes) {
    slots.push({ start: cursor, end: range.end });
  }

  return slots.map(s => ({
    start: s.start,
    end: s.end,
    minutes: s.end - s.start,
    startTime: fromMinutes(s.start),
    endTime: fromMinutes(s.end)
  }));
}

// =====================================================================
// KALENTERITAPAHTUMAT JA SUOJATUT LOHKOT
// =====================================================================
//
// Tapahtumat (kalenterin sitoumukset) ja niistä johdetut suojatut lohkot
// tulevat tähän moottoriin VALMIIKSI LASKETTUINA tavallisina olioina:
//
//   events  src/domain/calendar.js       expandEventOccurrences(...)
//   blocks  src/domain/calendarBlocks.js deriveBlocks(...)
//
// Moottori EI importoi niitä moduuleja. Syy on käytännöllinen: tämä
// tiedosto ladataan sovelluksen käynnistyksessä, joten jokainen sen
// import kuuluisi sovelluskuoreen (sw.js SHELL, tests/pwa.test.mjs).
// Kalenteri kytketään käyttöliittymään omana vaiheenaan; siihen asti
// moottori tuntee vain olioiden MUODON. Lohkojen lajit määritellään
// siksi täällä, ja calendarBlocks.js vie ne edelleen.
//
// SUOJATTU VÄLJYYS: valmistautuminen, matka, pysäköinti, perilläolon
// varmuusaika, rauhoittuminen ja uni EIVÄT ole vapaata aikaa. Vapaat
// välit kiertävät ne, eikä tapahtumaa koskaan siirretä.
//
// Kaikki ajat ovat SEINÄKELLOAIKAA kuten task.durationOf: kesäajan
// vaihto ei siirrä lohkoa eikä tapahtumaa kellotaululla.

/** Suojatun lohkon laji. */
export const BLOCK_KIND = Object.freeze({
  /** Lähtöön valmistautuminen: [valmistautumisen alku, lähtö). */
  PREPARATION: 'preparation',
  /** Matka: [lähtö, lähtö + matka). */
  TRAVEL: 'travel',
  /** Pysäköinti ja kävely perille. */
  OVERHEAD: 'overhead',
  /** Perilläolon varmuusaika tapahtuman alkuun asti ("mieluummin ajoissa"). */
  ARRIVAL_BUFFER: 'arrival_buffer',
  /** Rauhoittuminen ennen nukkumaanmenoa. */
  WIND_DOWN: 'wind_down',
  /** Suojattu uni: [nukkumaanmeno, herätys). */
  SLEEP: 'sleep',
  /**
   * Suojattu oma aika (migraatio 0015, protected_periods). Harrastus,
   * lepo, yksinolo tai ei mitään: joustavaa työtä ei sijoiteta tähän.
   */
  OWN_TIME: 'own_time',
  /** Suojattu vapaa-aika: suojattu ilta, vapaa sunnuntai, "ei velvoitteita klo X jälkeen". */
  FREE_TIME: 'free_time',
  /** Loma: joustava työ ja jono eivät sijoitu tähän. Kiinteät menot pysyvät. */
  VACATION: 'vacation'
});

export const BLOCK_KINDS = Object.freeze(Object.values(BLOCK_KIND));

/**
 * Suojatun ajan lohkot (src/domain/protectedTime.js). Ne ovat varattua aikaa
 * kapasiteetissa ja vapaissa väleissä kuten matka ja uni, mutta aikajana
 * näyttää ne omana osionaan ja loma on koko päivän tila, ei rivi.
 */
export const PROTECTED_TIME_BLOCK_KINDS = Object.freeze([
  BLOCK_KIND.OWN_TIME, BLOCK_KIND.FREE_TIME, BLOCK_KIND.VACATION
]);

/** Lohkot, joiden aikana olet lähdössä tai matkalla: et voi olla samaan aikaan muualla. */
export const PRESENCE_BLOCK_KINDS = Object.freeze([
  BLOCK_KIND.PREPARATION, BLOCK_KIND.TRAVEL, BLOCK_KIND.OVERHEAD, BLOCK_KIND.ARRIVAL_BUFFER
]);

/** Lepo: käyttäjän päätös voittaa, mutta järjestelmä sanoo sen ääneen. */
export const REST_BLOCK_KINDS = Object.freeze([BLOCK_KIND.WIND_DOWN, BLOCK_KIND.SLEEP]);

const EMPTY = Object.freeze([]);

/** Lohkon laji tai null. Hyväksyy sekä `kind`- että `blockKind`-kentän. */
export function blockKindOf(item) {
  if (!item || typeof item !== 'object') return null;
  const kind = item.blockKind ?? item.kind;
  return BLOCK_KINDS.includes(kind) ? kind : null;
}

/**
 * Onko olio kalenteritapahtuman esiintymä (calendar.js)?
 *
 * Tiukka tarkistus on tarkoituksellinen: tallennettu tapahtumasääntö
 * (startTime, recurrenceWeekdays) EI ole esiintymä, ja sen hiljainen
 * tulkitseminen esiintymäksi sijoittaisi sen väärälle päivälle.
 */
export function isEventOccurrence(item) {
  if (!item || typeof item !== 'object') return false;
  try {
    return (item.isEvent === true || item.source === 'event') && isIsoDate(item.date);
  } catch {
    return false;
  }
}

/** Ajallinen esiintymä, jonka kestoa voi turvallisesti kysyä durationOf-funktiolta. */
function isTimedEvent(item) {
  return item.allDay !== true && isTimeOfDay(item.time)
    && (!item.endTime || isTimeOfDay(item.endTime));
}

/**
 * Kelvollinen lohkon pala: yksi päivä, alkuaika, kesto yli nolla.
 * Keskiyön ylittävä lohko on jo pilkottu päiväkohtaisiksi paloiksi
 * (calendarBlocks.js), joten pala ei koskaan ylitä vuorokauden rajaa.
 */
function isBlockPiece(item) {
  if (!item || typeof item !== 'object') return false;
  try {
    if (blockKindOf(item) === null || !isIsoDate(item.date) || !isTimeOfDay(item.time)) return false;
    if (item.endTime && !isTimeOfDay(item.endTime)) return false;
    return (durationOf(item) ?? 0) > 0;
  } catch {
    return false;
  }
}

function compareIds(a, b) {
  const x = String(a);
  const y = String(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

function compareByTimeThenId(a, b) {
  const byTime = toMinutes(a.time) - toMinutes(b.time);
  if (byTime !== 0) return byTime;
  return compareIds(a.id, b.id);
}

function compareEventsForDay(a, b) {
  const aTimed = isTimedEvent(a);
  const bTimed = isTimedEvent(b);
  // Koko päivän tapahtumat ensin, kuten kalentereissa yleensä.
  if (aTimed !== bTimed) return aTimed ? 1 : -1;
  if (aTimed) {
    const byTime = toMinutes(a.time) - toMinutes(b.time);
    if (byTime !== 0) return byTime;
  }
  const byTitle = String(a.title ?? '').localeCompare(String(b.title ?? ''), 'fi');
  if (byTitle !== 0) return byTitle;
  return compareIds(a.id, b.id);
}

/**
 * Päiväindeksi: päivä -> jäädytetty, järjestetty lista.
 *
 * Jäädytetylle taulukolle indeksi rakennetaan kerran ja muistetaan
 * (WeakMap), joten päiväkohtainen haku on O(1) koko horisontin ajan.
 * Muuttuvaa taulukkoa ei muisteta: kutsuja voisi muuttaa sitä, ja
 * vanhentunut indeksi näyttäisi väärän päivän.
 */
const DATE_INDEX_MARK = Symbol('calendarDateIndex');
const EVENT_INDEX_CACHE = new WeakMap();
const BLOCK_INDEX_CACHE = new WeakMap();
const EMPTY_INDEX = makeIndex(new Map());

function makeIndex(map) {
  return Object.freeze({
    [DATE_INDEX_MARK]: true,
    size: map.size,
    on: dateIso => map.get(dateIso) || EMPTY
  });
}

function isDateIndex(value) {
  return Boolean(value && typeof value === 'object' && value[DATE_INDEX_MARK] === true);
}

function buildDateIndex(items, accept, compare, cache) {
  if (isDateIndex(items)) return items;
  if (!Array.isArray(items) || items.length === 0) return EMPTY_INDEX;
  const frozen = Object.isFrozen(items);
  if (frozen && cache.has(items)) return cache.get(items);

  const map = new Map();
  const seen = new Set();
  for (const item of items) {
    // Roskasyöte (esim. heittävä getter) ohitetaan: yksi rikkinäinen rivi
    // ei saa kaataa koko päivänäkymää.
    let id;
    try {
      if (!accept(item)) continue;
      id = String(item.id);
    } catch {
      continue;
    }
    // Sama tunniste kahdesti on syötevirhe; ensimmäinen järjestyksessä voittaa.
    if (seen.has(id)) continue;
    seen.add(id);
    const list = map.get(item.date);
    if (list) list.push(item);
    else map.set(item.date, [item]);
  }
  for (const [date, list] of map) map.set(date, Object.freeze(list.sort(compare)));

  const index = makeIndex(map);
  if (frozen) cache.set(items, index);
  return index;
}

/**
 * Tapahtumaesiintymien päiväindeksi. Hyväksyy taulukon tai valmiin indeksin.
 * Esiintymä ilman tunnistetta hylätään: sitä ei voisi tunnistaa näkymässä.
 */
export function indexEventOccurrences(events) {
  return buildDateIndex(
    events,
    item => isEventOccurrence(item) && item.id != null && String(item.id) !== '',
    compareEventsForDay,
    EVENT_INDEX_CACHE
  );
}

/** Lohkojen päiväindeksi. Hyväksyy taulukon tai valmiin indeksin. */
export function indexCalendarBlocks(blocks) {
  return buildDateIndex(
    blocks,
    item => isBlockPiece(item) && item.id != null && String(item.id) !== '',
    compareByTimeThenId,
    BLOCK_INDEX_CACHE
  );
}

function shiftIso(dateIso, days) {
  return fmtISO(addDays(parseISO(dateIso), days));
}

/** Tapahtumaesiintymät, jotka ALKAVAT annettuna päivänä (myös koko päivän). */
export function eventsOnDate(events, dateIso) {
  if (!isIsoDate(dateIso)) return EMPTY;
  return indexEventOccurrences(events).on(dateIso);
}

/** Lohkojen palat annetulle päivälle, alkuajan mukaan järjestettynä. */
export function blocksOnDate(blocks, dateIso) {
  if (!isIsoDate(dateIso)) return EMPTY;
  return indexCalendarBlocks(blocks).on(dateIso);
}

/**
 * Edellisenä päivänä alkaneen, keskiyön yli jatkuvan tapahtuman loppuosa.
 *
 * Esiintymän oma päivä näyttää alun (varattu väli rajataan keskiyöhön
 * kuten occupiedRanges tekee). Ilman tätä palaa seuraava aamu näyttäisi
 * vapaalta, vaikka tapahtuma on vielä käynnissä.
 */
function continuationOf(occurrence, dateIso) {
  try {
    if (!isTimedEvent(occurrence)) return null;
    const duration = durationOf(occurrence);
    if (duration === null) return null;
    const start = toMinutes(occurrence.time);
    const end = start + Math.min(duration, 1440);
    if (end <= 1440) return null;
    const tail = end - 1440;
    return Object.freeze({
      ...occurrence,
      id: `${occurrence.id}:jatkuu`,
      occurrenceId: occurrence.id,
      date: dateIso,
      time: '00:00',
      endTime: fromMinutes(tail),
      durationMinutes: tail,
      startMinute: 0,
      endMinute: tail,
      crossesMidnight: false,
      continuation: true,
      startedOn: occurrence.date
    });
  } catch {
    return null;
  }
}

/**
 * Päivän aikajanalle kuuluvat tapahtumapalat: tänään alkavat ajalliset
 * esiintymät sekä edellisenä päivänä alkaneiden loppuosat.
 *
 * Kutsujan kannattaa laajentaa esiintymät myös edelliselle päivälle,
 * jotta keskiyön yli jatkuvat tapahtumat näkyvät.
 */
export function eventItemsOnDate(events, dateIso) {
  if (!isIsoDate(dateIso)) return EMPTY;
  const index = indexEventOccurrences(events);
  const items = [];
  for (const previous of index.on(shiftIso(dateIso, -1))) {
    const piece = continuationOf(previous, dateIso);
    if (piece) items.push(piece);
  }
  for (const occurrence of index.on(dateIso)) {
    if (isTimedEvent(occurrence)) items.push(occurrence);
  }
  return Object.freeze(items.sort(compareByTimeThenId));
}

/** Kohteen varaama väli minuutteina, täsmälleen kuten occupiedRanges laskee sen. */
function itemRange(item) {
  const start = toMinutes(item.time);
  const length = durationOf(item) ?? DEFAULT_TASK_MINUTES;
  return { start, end: Math.min(start + length, 1440) };
}

/**
 * Suojattu uni kaventaa valveillaoloikkunaa.
 *
 * VAIN KAVENTAA. Keskiyöhön päättyvä unen pala siirtää ikkunan loppua
 * aiemmaksi ja keskiyöstä alkava pala sen alkua myöhemmäksi. Ikkunaa ei
 * koskaan leveämmäksi: silloin joustava työ voisi osua aikaan, jota
 * herätys- ja aamutoimimerkinnät eivät tunne.
 *
 * Palauttaa alkuperäisen olion, jos unilohkoa ei ole, jotta vanhat
 * kutsut näkevät täsmälleen saman ikkunan kuin ennen.
 */
export function protectSleepRange(range, dayBlocks = []) {
  let start = range.start;
  let end = range.end;
  let touched = false;

  for (const block of Array.isArray(dayBlocks) ? dayBlocks : []) {
    if (blockKindOf(block) !== BLOCK_KIND.SLEEP || !isBlockPiece(block)) continue;
    const piece = itemRange(block);
    if (piece.start === 0) { start = Math.max(start, piece.end); touched = true; }
    if (piece.end >= 1440) { end = Math.min(end, piece.start); touched = true; }
  }

  if (!touched) return range;
  if (end < start) end = start;
  return { ...range, start, end, sleepProtected: true };
}

/** Päällekkäisyyksien yhdistetty kesto valveillaoloikkunan sisällä. */
export function unionMinutesWithin(items, range) {
  let total = 0;
  for (const busy of occupiedRanges(items)) {
    const start = Math.max(busy.start, range.start);
    const end = Math.min(busy.end, range.end);
    if (end > start) total += end - start;
  }
  return total;
}

const COLLISION_PHRASES = Object.freeze({
  [BLOCK_KIND.PREPARATION]: 'lähtöön valmistautumiseen',
  [BLOCK_KIND.TRAVEL]: 'matkaan',
  [BLOCK_KIND.OVERHEAD]: 'pysäköintiin ja kävelyyn',
  [BLOCK_KIND.ARRIVAL_BUFFER]: 'perilläolon varmuusaikaan',
  [BLOCK_KIND.WIND_DOWN]: 'rauhoittumiseen ennen unta',
  [BLOCK_KIND.SLEEP]: 'suojattuun uneen',
  [BLOCK_KIND.OWN_TIME]: 'suojattuun omaan aikaan',
  [BLOCK_KIND.FREE_TIME]: 'suojattuun vapaa-aikaan',
  [BLOCK_KIND.VACATION]: 'lomaan'
});

/** Suomenkielinen "osui mihin" -ilmaus (illatiivi) lohkolle tai tapahtumalle. */
export function collisionPhrase(item) {
  const kind = blockKindOf(item);
  if (kind) return COLLISION_PHRASES[kind];
  const title = item && item.title ? String(item.title) : '';
  return title ? `tapahtumaan "${title}"` : 'tapahtumaan';
}

function isAutoTimedTask(task) {
  if (!task || typeof task !== 'object') return false;
  try {
    return !task.completed && !task.isWake
      && task.schedulingState === SCHEDULING.AUTO
      && isIsoDate(task.date) && isTimeOfDay(task.time)
      && (!task.endTime || isTimeOfDay(task.endTime));
  } catch {
    return false;
  }
}

/**
 * Automaattisesti sijoitetut tehtävät, jotka osuvat tapahtumaan tai
 * suojattuun lohkoon.
 *
 * AUTO-päällekkäisyys ei ole käyttäjän ristiriita vaan sijoitusvirhe,
 * jonka aikatauluttaja korjaa (proposeSchedule reflow) — siksi tämä
 * palauttaa listan eikä ristiriitoja. Käyttäjän itse ajastamaa
 * (MANUAL) tehtävää tämä ei koskaan palauta.
 *
 * @param {object} input
 * @param {Array}  input.tasks
 * @param {Array}  [input.events]   tapahtumaesiintymät
 * @param {Array}  [input.blocks]   lohkojen palat
 * @param {string} [input.dateIso]  vain tämä päivä
 * @param {string} [input.fromIso]  vain tästä päivästä eteenpäin
 */
export function findCalendarCollisions({
  tasks = [], events = [], blocks = [], dateIso = null, fromIso = null
} = {}) {
  const eventIndex = indexEventOccurrences(events);
  const blockIndex = indexCalendarBlocks(blocks);
  if (eventIndex.size === 0 && blockIndex.size === 0) return EMPTY;

  const guardsByDate = new Map();
  const guardsOn = date => {
    if (!guardsByDate.has(date)) {
      const guards = [...eventItemsOnDate(eventIndex, date), ...blockIndex.on(date)]
        .map(item => ({ ...itemRange(item), item }))
        .sort((a, b) => a.start - b.start || compareIds(a.item.id, b.item.id));
      guardsByDate.set(date, guards);
    }
    return guardsByDate.get(date);
  };

  const found = [];
  for (const task of Array.isArray(tasks) ? tasks : []) {
    if (!isAutoTimedTask(task)) continue;
    if (dateIso && task.date !== dateIso) continue;
    if (fromIso && task.date < fromIso) continue;

    const range = itemRange(task);
    const hit = guardsOn(task.date).find(g => range.start < g.end && g.start < range.end);
    if (!hit) continue;

    found.push(Object.freeze({
      task,
      taskId: task.id,
      title: task.title,
      dateIso: task.date,
      time: task.time,
      guardId: hit.item.id,
      guardKind: blockKindOf(hit.item) || 'event',
      phrase: collisionPhrase(hit.item)
    }));
  }

  return Object.freeze(found.sort((a, b) =>
    compareIds(a.dateIso, b.dateIso)
    || toMinutes(a.time) - toMinutes(b.time)
    || String(a.title ?? '').localeCompare(String(b.title ?? ''), 'fi')
    || compareIds(a.taskId, b.taskId)));
}

/**
 * Päivän koko suunnitelma yhtenä oliona. Tämä on päivänäkymän ainoa syöte.
 *
 * @param {object}   args
 * @param {Array}    args.tasks    Kaikki käyttäjän tehtävät
 * @param {object}   args.profile  Käyttäjän profiili
 * @param {string}   args.dateIso  Päivä, jota katsotaan
 * @param {number}   [args.nowMinutes]  Nykyhetki minuutteina. null = ei "nyt"-tilaa.
 * @param {Array}    [args.events]  Tapahtumaesiintymät (calendar.js). Kiinteitä:
 *                                  niitä ei koskaan siirretä. Anna myös edellisen
 *                                  päivän esiintymät, jotta keskiyön yli jatkuva
 *                                  tapahtuma näkyy aamulla.
 * @param {Array}    [args.blocks]  Suojatut lohkot (calendarBlocks.js). Eivät ole
 *                                  vapaata aikaa; suojattu uni kaventaa ikkunaa.
 */
export function buildDayPlan({
  tasks,
  profile,
  dateIso,
  nowMinutes = null,
  routines = [],
  exceptions = [],
  todayIso = null,
  events = [],
  blocks = []
} = {}) {
  const p = profileOf(profile);
  const dayTasks = tasksOn(tasks, dateIso);

  const scheduled = dayTasks.filter(t => t.time && !t.completed).sort(compareForDay);
  const unscheduled = dayTasks.filter(t => !t.time && !t.completed).sort(compareForDay);
  const completed = dayTasks.filter(t => t.completed).sort(compareForDay);

  // Rutiiniesiintymät lasketaan aina uudelleen — niitä ei tallenneta.
  const occurrences = expandRoutines({ routines, from: dateIso, to: dateIso, exceptions });
  const fixedRoutines = occurrences.filter(o => o.time);
  const flexibleRoutines = occurrences.filter(o => !o.time);

  // Tapahtumat ja lohkot: valmiiksi laskettuja, ei tallenneta.
  const dayEvents = eventsOnDate(events, dateIso);
  const allDayEvents = Object.freeze(dayEvents.filter(o => !isTimedEvent(o)));
  const eventItems = eventItemsOnDate(events, dateIso);
  const dayBlocks = blocksOnDate(blocks, dateIso);

  // Kun suojattu uni on annettu, se näkyy lohkona. Automaattinen
  // unimerkintä jätetään silloin pois, ettei sama uni näy kahdesti.
  const sleepBlockTonight = dayBlocks.some(block =>
    blockKindOf(block) === BLOCK_KIND.SLEEP && itemRange(block).end >= 1440);
  const virtualItems = buildVirtualItems({ tasks, profile: p, dateIso })
    .filter(item => !(sleepBlockTonight && item.id === 'virtual-sleep'));

  // Aikajanalla näkyvät: käyttäjän ajastetut, kuitatut ajastetut,
  // kiinteät rutiinit, tapahtumat, suojatut lohkot ja automaattiset ehdotukset.
  const timeline = [
    ...scheduled,
    ...completed.filter(t => t.time),
    ...fixedRoutines,
    ...eventItems,
    ...dayBlocks,
    ...virtualItems
  ].sort(sortByTime);

  const range = protectSleepRange(awakeWindow({ tasks, profile: p, dateIso }), dayBlocks);

  // Vapaita välejä laskettaessa uni jätetään pois (se on ikkunan ulkopuolella),
  // mutta kiinteät rutiinit, tapahtumat ja lohkot varaavat aikaa kuten mikä
  // tahansa merkintä.
  const freeSlots = findFreeSlots({
    items: timeline.filter(it => it.id !== 'virtual-sleep'),
    range
  });

  const reference = todayIso || dateIso;
  const overdue = (tasks || []).filter(t => isOverdue(t, reference));

  return {
    dateIso,
    timeline,
    scheduled,
    unscheduled,
    completed,
    routineOccurrences: occurrences,
    fixedRoutines,
    flexibleRoutines,
    /** Tänään alkavat tapahtumat (myös koko päivän). */
    events: dayEvents,
    /** Koko päivän tapahtumat: eivät varaa kellonaikaa. */
    allDayEvents,
    /** Aikajanan tapahtumapalat (myös edellisenä päivänä alkaneiden loppuosat). */
    eventItems,
    /** Päivän suojatut lohkot. */
    blocks: dayBlocks,
    overdue,
    freeSlots,
    range,
    load: {
      count: dayTasks.length,
      level: loadClass(dayTasks.length + dayEvents.length),
      completed: completed.length,
      routines: occurrences.length,
      events: dayEvents.length,
      blocks: dayBlocks.length
    },
    nowMinutes
  };
}

/**
 * Aikaisin hetki, jolle saa ehdottaa. null = ei rajaa.
 *
 * Tänään ei ehdoteta mennyttä aikaa: ehdotus klo 9, kun kello on 14, on
 * hyödytön ja opettaa ohittamaan ehdotukset. Raja pyöristetään ylös
 * seuraavaan viiteen minuuttiin, jotta ehdotus ei ala "klo 14:03".
 */
function proposalCutoff({ dateIso, todayIso, nowMinutes }) {
  if (typeof nowMinutes !== 'number' || !Number.isFinite(nowMinutes)) return null;
  if (isIsoDate(todayIso)) {
    if (dateIso > todayIso) return null;
    if (dateIso < todayIso) return 1440;
  }
  const clamped = Math.max(0, Math.min(1440, nowMinutes));
  return Math.min(1440, Math.ceil(clamped / 5) * 5);
}

/**
 * Irrota ajastaan automaattisesti sijoitetut tehtävät, jotka osuvat
 * tapahtumaan tai suojattuun lohkoon.
 *
 * Kopio, ei muutos: alkuperäinen tehtävä jää koskemattomaksi, ja
 * irrotettu kopio on aikatauluttamaton ehdokas samalla kestolla.
 * MANUAL-tehtävää tämä ei koske koskaan (findCalendarCollisions).
 */
function detachCollidingAutoTasks({ tasks, events, blocks, dateIso }) {
  const collisions = findCalendarCollisions({ tasks, events, blocks, dateIso });
  if (collisions.length === 0) return { tasks, detached: new Map() };

  const byId = new Map(collisions.map(c => [c.task, c]));
  const detached = new Map();
  const working = tasks.map(task => {
    const collision = byId.get(task);
    if (!collision) return task;
    const copy = {
      ...task,
      time: null,
      endTime: null,
      durationMinutes: durationOf(task) ?? task.durationMinutes ?? null,
      schedulingState: SCHEDULING.UNSCHEDULED
    };
    detached.set(copy, { original: task, collision });
    return copy;
  });
  return { tasks: working, detached };
}

/**
 * Ehdota aikoja aikatauluttamattomille tehtäville.
 *
 * TAKUUT:
 *  - Deterministinen: sama syöte tuottaa aina saman tuloksen.
 *  - Ei koskaan siirrä käyttäjän itse ajastamaa tehtävää
 *    (isMovableByScheduler palauttaa false manuaalisille).
 *  - Ei koskaan sijoita päällekkäin jo varatun ajan kanssa.
 *  - Ei ehdota mitään, jos tilaa ei ole — tehtävä jää listaan `unplaced`.
 *
 * Järjestys: tärkeimmät ensin, tasatilanteessa nimen mukaan.
 *
 * KALENTERI (valinnainen):
 *  - `events` ja `blocks` varaavat aikaa kuten buildDayPlan: ehdotus ei
 *    koskaan osu tapahtumaan, matkaan, valmistautumiseen tai uneen.
 *  - `nowMinutes`: tänään ei ehdoteta mennyttä aikaa.
 *  - `reflow: true`: automaattisesti sijoitetut (AUTO) tehtävät, jotka
 *    osuvat tapahtumaan tai lohkoon, saavat uuden ehdotuksen. Ehdotuksessa
 *    on silloin `fromTime` ja `reflow: true`. Käyttäjän itse ajastamaa
 *    tehtävää ei siirretä koskaan.
 *
 * @returns {{proposals: Array, unplaced: Array, reflowed: Array<string>}}
 */
export function proposeSchedule({
  tasks,
  profile,
  dateIso,
  routines = [],
  exceptions = [],
  todayIso = null,
  events = [],
  blocks = [],
  nowMinutes = null,
  reflow = false
} = {}) {
  const p = profileOf(profile);
  const { tasks: workingTasks, detached } = reflow === true
    ? detachCollidingAutoTasks({ tasks, events, blocks, dateIso })
    : { tasks, detached: new Map() };
  const plan = buildDayPlan({
    tasks: workingTasks, profile: p, dateIso, routines, exceptions, todayIso, events, blocks
  });
  const reference = todayIso || dateIso;

  // Ehdokkaat kahdesta lähteestä. Rutiinit ennen tehtäviä: ne ovat käyttäjän
  // itse asettamia toistuvia sitoumuksia, joten ne saavat ensin parhaat välit.
  const candidates = [
    ...plan.flexibleRoutines.map(occurrence => ({
      kind: 'routine',
      rank: 0,
      id: occurrence.id,
      routineId: occurrence.routineId,
      title: occurrence.title,
      priority: occurrence.priority,
      urgency: URGENCY.NONE,
      needed: occurrence.durationMinutes || DEFAULT_TASK_MINUTES,
      source: occurrence
    })),
    ...plan.unscheduled.filter(isMovableByScheduler).map(task => ({
      kind: 'task',
      rank: 1,
      id: task.id,
      taskId: task.id,
      title: task.title,
      priority: task.priority,
      urgency: deadlineUrgency(task, reference),
      needed: durationOf(task) ?? DEFAULT_TASK_MINUTES,
      // Irrotettu AUTO-tehtävä raportoidaan alkuperäisenä: käyttäjä
      // tunnistaa sen, eikä kopio vuoda näkymään.
      source: detached.has(task) ? detached.get(task).original : task,
      detached: detached.get(task) || null
    }))
  ];

  // Järjestys — tämä on schedulerin koko priorisointisääntö yhdessä paikassa:
  //   1. rutiinit ennen tehtäviä
  //   2. kiireellisyys (määräaika)
  //   3. prioriteetti
  //   4. nimi — takaa determinismin
  candidates.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    const byUrgency = schedulingUrgencyWeight(a.urgency) - schedulingUrgencyWeight(b.urgency);
    if (byUrgency !== 0) return byUrgency;
    const byPriority = priorityWeight(a.priority) - priorityWeight(b.priority);
    if (byPriority !== 0) return byPriority;
    return String(a.title ?? '').localeCompare(String(b.title ?? ''), 'fi');
  });

  // Kopioidaan vapaat välit, jotta niitä voidaan kuluttaa sijoituksen edetessä.
  // Tänään mennyt aika leikataan pois ennen sijoitusta.
  const cutoff = proposalCutoff({ dateIso, todayIso, nowMinutes });
  const slots = plan.freeSlots
    .map(s => {
      if (cutoff === null || s.start >= cutoff) return { ...s };
      const start = Math.min(Math.max(s.start, cutoff), s.end);
      return { ...s, start, minutes: s.end - start, startTime: fromMinutes(start) };
    })
    .filter(s => s.minutes >= MIN_USEFUL_SLOT_MINUTES);
  const proposals = [];
  const unplaced = [];

  for (const candidate of candidates) {
    const needed = candidate.needed;
    const slotIndex = slots.findIndex(s => s.minutes >= needed);

    if (slotIndex === -1) {
      unplaced.push(candidate.source);
      continue;
    }

    const slot = slots[slotIndex];
    const startTime = fromMinutes(slot.start);
    const endTime = fromMinutes(slot.start + needed);

    const proposal = {
      kind: candidate.kind,
      taskId: candidate.kind === 'task' ? candidate.taskId : null,
      routineId: candidate.kind === 'routine' ? candidate.routineId : null,
      occurrenceId: candidate.kind === 'routine' ? candidate.id : null,
      title: candidate.title,
      time: startTime,
      endTime,
      durationMinutes: needed,
      urgency: candidate.urgency,
      priority: candidate.priority,
      reason: buildReason(candidate, slot)
    };
    if (candidate.detached) {
      proposal.reflow = true;
      proposal.fromTime = candidate.detached.original.time;
      proposal.fromEndTime = candidate.detached.original.endTime ?? null;
    }
    proposals.push(proposal);

    slot.start += needed;
    slot.minutes -= needed;
    slot.startTime = fromMinutes(slot.start);
    if (slot.minutes < MIN_USEFUL_SLOT_MINUTES) slots.splice(slotIndex, 1);
  }

  const reflowed = [...detached.values()]
    .map(entry => entry.original.id)
    .sort(compareIds);

  return { proposals, unplaced, reflowed };
}

/**
 * Rakentaa käyttäjälle näytettävän perustelun.
 *
 * Ehdotus ilman perustelua on käsky. Käyttäjän pitää nähdä MIKSI juuri tämä
 * aika ehdotetaan, jotta hän voi olla eri mieltä (konseptidokumentti, luku 22).
 */
function buildReason(candidate, slot) {
  const parts = [];

  if (candidate.detached) {
    const { original, collision } = candidate.detached;
    parts.push(`Aiempi aika klo ${original.time} osui ${collision.phrase}`);
  }

  if (candidate.kind === 'routine') parts.push('Toistuva rutiini');

  const urgency = urgencyLabel(candidate.urgency);
  if (urgency) parts.push(`Määräaika: ${urgency.toLowerCase()}`);

  if (candidate.priority === 'korkea') parts.push(priorityLabel('korkea'));

  parts.push(`Vapaa ${slot.minutes} min väli klo ${slot.startTime}`);
  return parts.join(' · ');
}
