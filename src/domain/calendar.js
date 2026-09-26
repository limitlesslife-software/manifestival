// Kalenteri: tapahtumien esiintymät sekä päivä-, viikko- ja kuukausinäkymien mallit.
//
// PUHDAS MODUULI. Ei kelloa (tämä päivä annetaan parametrina), ei DOM:ia,
// ei verkkoa, ei satunnaisuutta. Sama syöte tuottaa aina saman,
// jäädytetyn tuloksen. Roskasyöte ei kaada mitään: kelvoton rivi ohitetaan.
//
// =====================================================================
// TAPAHTUMA ON SÄÄNTÖ, ESIINTYMÄ ON LASKETTU
// =====================================================================
//
// Kantaan tallennetaan vain tapahtuma (calendar_events): päivä, kellonaika,
// valinnainen viikoittainen toisto, toiston loppupäivä ja ohitetut päivät.
// Esiintymät lasketaan aina uudelleen näkyvälle aikavälille, kuten
// rutiinien esiintymät (routine.js). Viikoittainen tapahtuma ei siis ole
// 52 riviä, ja säännön muutos näkyy heti joka viikolla.
//
// Esiintymä on KIINTEÄ: aikataulumoottori ei koskaan siirrä sitä
// (scheduler.js). Tehtävät pysyvät tehtävinä; tapahtuma on sitoumus.
//
// =====================================================================
// PÄIVÄMÄÄRÄT OVAT KALENTERIPÄIVIÄ, AJAT SEINÄKELLOAIKAA
// =====================================================================
//
// Päivälaskenta tehdään kokonaislukuina (päivän järjestysluku
// 1970-01-01 alkaen, sama luku kuin travel.js käyttää), joten
// aikavyöhyke ja kesäaika eivät voi siirtää päivää. Kellonaika on
// seinäkelloaikaa: klo 10:00 on klo 10:00 myös kesäajan vaihtopäivänä.
// Kesto on seinäkellon mukainen kuten task.durationOf; vaihtoyön todellinen
// kesto voi poiketa tunnilla, ja sen hoitaa herätys, ei kalenteri.

import { isIsoDate, isTimeOfDay, toMinutes, fromMinutes, durationOf } from './task.js';
import { normalizeCategory, categoryLabel } from './categories.js';
import { normalizeWeekdays, weekdayName, weekdayShort, MAX_EXPANSION_DAYS } from './routine.js';
import { TRAVEL_MODES } from './travel.js';
import {
  MAX_EVENT_TITLE_LENGTH, MAX_EVENT_NOTES_LENGTH, MAX_SKIP_DATES, MAX_TRAVEL_MINUTES,
  MAX_PREPARATION_MINUTES, MAX_PLACE_ARRIVAL_BUFFER_MINUTES, MAX_OVERHEAD_MINUTES
} from './dailyLife.js';
import {
  BLOCK_KIND, blockKindOf, occupiedRanges, DEFAULT_TASK_MINUTES,
  indexEventOccurrences, indexCalendarBlocks, eventsOnDate, eventItemsOnDate, blocksOnDate
} from './scheduler.js';

/**
 * Laajennuksen enimmäisikkuna päivinä. Sama raja kuin rutiineilla:
 * vahingossa vuosiksi eteenpäin laskettu kalenteri olisi hiljainen
 * suorituskykyongelma, joka näkyisi vasta käyttäjällä.
 */
export const MAX_EVENT_EXPANSION_DAYS = MAX_EXPANSION_DAYS;

/** Kuukausiruudukossa on enintään kuusi viikkoriviä. */
export const MAX_MONTH_ROWS = 6;

const EMPTY = Object.freeze([]);

// =====================================================================
// PÄIVÄLASKENTA (kokonaisluvuin, ei Date-olioita)
// =====================================================================

// Howard Hinnantin civil-algoritmi: päivämäärä <-> päivän järjestysluku.
// Proleptinen gregoriaaninen kalenteri; 1970-01-01 on päivä 0.
function daysFromCivil(year, month, day) {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const mp = (month + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function civilFromDays(number) {
  const z = number + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524)
    - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  const year = yoe + era * 400 + (month <= 2 ? 1 : 0);
  return [year, month, day];
}

const pad = (n, width = 2) => String(n).padStart(width, '0');

/** ISO-päivän järjestysluku (1970-01-01 = 0) tai null. */
export function dayNumberOf(dateIso) {
  if (!isIsoDate(dateIso)) return null;
  const [year, month, day] = dateIso.split('-').map(Number);
  return daysFromCivil(year, month, day);
}

/** Järjestysluku -> ISO-päivä, tai null jos luku ei ole vuosilla 0000–9999. */
export function isoOfDayNumber(number) {
  if (!Number.isInteger(number)) return null;
  const [year, month, day] = civilFromDays(number);
  if (year < 0 || year > 9999) return null;
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
}

/** ISO-päivä + n päivää. null, jos syöte ei kelpaa. */
export function addDaysToIso(dateIso, days) {
  const number = dayNumberOf(dateIso);
  if (number === null || !Number.isInteger(days)) return null;
  return isoOfDayNumber(number + days);
}

function weekdayOfNumber(number) {
  // 1970-01-01 oli torstai (ISO 4).
  return ((number % 7) + 7 + 3) % 7 + 1;
}

/** ISO-viikonpäivä: 1 = maanantai ... 7 = sunnuntai. null, jos päivä ei kelpaa. */
export function isoWeekdayOf(dateIso) {
  const number = dayNumberOf(dateIso);
  return number === null ? null : weekdayOfNumber(number);
}

/** Viikon maanantai. */
export function mondayOf(dateIso) {
  const number = dayNumberOf(dateIso);
  if (number === null) return null;
  return isoOfDayNumber(number - (weekdayOfNumber(number) - 1));
}

/**
 * ISO-viikkonumero. Viikko kuuluu sille vuodelle, jolla sen torstai on:
 * 1.1.2027 (perjantai) on vuoden 2026 viikolla 53.
 */
export function isoWeekOf(dateIso) {
  const number = dayNumberOf(dateIso);
  if (number === null) return null;
  const thursday = number - (weekdayOfNumber(number) - 1) + 3;
  const year = civilFromDays(thursday)[0];
  const week = Math.floor((thursday - daysFromCivil(year, 1, 1)) / 7) + 1;
  return Object.freeze({ year, week });
}

/**
 * Absoluuttiset minuutit: päivän järjestysluku × 1440 + minuutit.
 * Sama asteikko kuin travel.js departureSchedule (`abs`), joten lähtö- ja
 * kalenterilaskenta ovat vertailukelpoisia keskiyön yli.
 */
export function absoluteMinutesOf(dateIso, minutes) {
  const number = dayNumberOf(dateIso);
  if (number === null || !Number.isFinite(minutes)) return null;
  return number * 1440 + minutes;
}

/** Absoluuttiset minuutit -> { date, minute, time }. */
export function fromAbsoluteMinutes(abs) {
  if (!Number.isFinite(abs)) return null;
  const rounded = Math.round(abs);
  const day = Math.floor(rounded / 1440);
  const minute = rounded - day * 1440;
  const date = isoOfDayNumber(day);
  if (date === null) return null;
  return Object.freeze({ date, minute, time: fromMinutes(minute) });
}

/** Kuukausi 'YYYY-MM' -> { year, month } tai null. */
function parseMonth(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(value);
  if (!match) return null;
  return { year: Number(match[1]), month: Number(match[2]) };
}

function lastDayOfMonth(year, month) {
  return daysFromCivil(month === 12 ? year + 1 : year, month === 12 ? 1 : month + 1, 1) - 1;
}

/** Edellinen tai seuraava kuukausi 'YYYY-MM'. Vuosi vaihtuu oikein. */
export function shiftMonth(month, delta) {
  const parsed = parseMonth(month);
  if (!parsed || !Number.isInteger(delta)) return null;
  const index = parsed.year * 12 + (parsed.month - 1) + delta;
  const year = Math.floor(index / 12);
  if (year < 0 || year > 9999) return null;
  return `${pad(year, 4)}-${pad(index - year * 12 + 1)}`;
}

// =====================================================================
// SUOMENKIELISET NIMIKKEET
// =====================================================================

const MONTH_NAMES = Object.freeze([
  'tammikuu', 'helmikuu', 'maaliskuu', 'huhtikuu', 'toukokuu', 'kesäkuu',
  'heinäkuu', 'elokuu', 'syyskuu', 'lokakuu', 'marraskuu', 'joulukuu'
]);

/** Kuukauden nimi: 1 -> 'tammikuu'. */
export function monthName(month) {
  return MONTH_NAMES[month - 1] || '';
}

/** 'YYYY-MM' -> 'syyskuu 2026'. */
export function monthLabel(month) {
  const parsed = parseMonth(month);
  return parsed ? `${monthName(parsed.month)} ${parsed.year}` : '';
}

function dateParts(dateIso) {
  const [year, month, day] = dateIso.split('-').map(Number);
  return { year, month, day };
}

/** Lyhyt päiväys: 'la 26.9.' */
export function shortDateLabel(dateIso) {
  if (!isIsoDate(dateIso)) return '';
  const { month, day } = dateParts(dateIso);
  return `${weekdayShort(isoWeekdayOf(dateIso))} ${day}.${month}.`;
}

/** Pitkä päiväys: 'lauantai 26.9.2026' */
export function longDateLabel(dateIso) {
  if (!isIsoDate(dateIso)) return '';
  const { year, month, day } = dateParts(dateIso);
  return `${weekdayName(isoWeekdayOf(dateIso))} ${day}.${month}.${year}`;
}

/** Luettava päiväys ruudunlukijalle: 'lauantai 26. syyskuuta 2026' */
export function spokenDateLabel(dateIso) {
  if (!isIsoDate(dateIso)) return '';
  const { year, month, day } = dateParts(dateIso);
  return `${weekdayName(isoWeekdayOf(dateIso))} ${day}. ${monthName(month)}ta ${year}`;
}

/** Viikon väli: '21.–27.9.2026', '28.9.–4.10.2026' tai '28.12.2026–3.1.2027'. */
export function weekRangeLabel(weekStart) {
  const monday = mondayOf(weekStart);
  if (!monday) return '';
  const sunday = addDaysToIso(monday, 6);
  const a = dateParts(monday);
  const b = dateParts(sunday);
  if (a.year !== b.year) return `${a.day}.${a.month}.${a.year}–${b.day}.${b.month}.${b.year}`;
  if (a.month !== b.month) return `${a.day}.${a.month}.–${b.day}.${b.month}.${b.year}`;
  return `${a.day}.–${b.day}.${b.month}.${b.year}`;
}

function plural(count, one, many) {
  return `${count} ${count === 1 ? one : many}`;
}

const BLOCK_LABELS = Object.freeze({
  [BLOCK_KIND.PREPARATION]: 'Valmistautuminen',
  [BLOCK_KIND.TRAVEL]: 'Matka',
  [BLOCK_KIND.OVERHEAD]: 'Pysäköinti ja kävely',
  [BLOCK_KIND.ARRIVAL_BUFFER]: 'Ajoissa perillä',
  [BLOCK_KIND.WIND_DOWN]: 'Rauhoittuminen',
  [BLOCK_KIND.SLEEP]: 'Uni'
});

/** Lohkon laji suomeksi. */
export function blockLabel(kind) {
  return BLOCK_LABELS[kind] || 'Varattu';
}

const ENTRY_LABELS = Object.freeze({
  event: 'Tapahtuma',
  task: 'Tehtävä',
  routine: 'Rutiini'
});

// =====================================================================
// ESIINTYMÄT
// =====================================================================

/** Kokonaisluku annetulla välillä, muuten null. Tuntematon ei ole nolla. */
function intInRange(value, min, max) {
  let n;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'string' && value.trim() !== '') n = Number(value.trim());
  else return null;
  if (!Number.isFinite(n)) return null;
  const rounded = Math.round(n);
  return rounded >= min && rounded <= max ? rounded : null;
}

function textOrNull(value, maxLength) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim().slice(0, maxLength);
  return text === '' ? null : text;
}

function idOf(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string' && value.trim() !== '') return value;
  return null;
}

/**
 * Lue tapahtumasääntö puolustavasti. Tämä EI ole entiteetin normalisointi
 * (se on calendarEvent.js:n tehtävä) vaan laajennuksen oma suoja: rivi,
 * josta ei voi laskea esiintymää varmasti, ohitetaan kokonaan.
 */
function readEvent(raw) {
  try {
    if (!raw || typeof raw !== 'object') return null;
    const id = idOf(raw.id);
    if (!id || !isIsoDate(raw.date)) return null;

    const startTime = isTimeOfDay(raw.startTime) ? raw.startTime : null;
    const allDay = startTime === null;

    let endTime = null;
    let durationMinutes = null;
    if (!allDay) {
      const explicitEnd = isTimeOfDay(raw.endTime) && raw.endTime !== startTime ? raw.endTime : null;
      if (explicitEnd) {
        // Väli on tosiasia: keskiyön yli kiertävä väli lasketaan kuten tehtävillä.
        endTime = explicitEnd;
        durationMinutes = durationOf({ time: startTime, endTime: explicitEnd });
      } else {
        durationMinutes = intInRange(raw.durationMinutes, 1, 1440);
        if (durationMinutes !== null && durationMinutes < 1440) {
          endTime = fromMinutes(toMinutes(startTime) + durationMinutes);
        }
      }
    }

    const skip = new Set();
    if (Array.isArray(raw.skipDates)) {
      for (const entry of raw.skipDates.slice(0, MAX_SKIP_DATES)) {
        if (isIsoDate(entry)) skip.add(entry);
      }
    }

    const weekdays = normalizeWeekdays(raw.recurrenceWeekdays);
    const travelMode = TRAVEL_MODES.includes(raw.travelMode) ? raw.travelMode : null;

    return {
      id,
      date: raw.date,
      dayNumber: dayNumberOf(raw.date),
      startTime,
      endTime,
      durationMinutes,
      allDay,
      title: textOrNull(raw.title, MAX_EVENT_TITLE_LENGTH) || 'Nimetön tapahtuma',
      category: normalizeCategory(raw.category),
      placeId: idOf(raw.placeId),
      locationText: textOrNull(raw.locationText, 200),
      travelMode,
      travelMinutes: intInRange(raw.travelMinutes, 1, MAX_TRAVEL_MINUTES),
      preparationMinutes: intInRange(raw.preparationMinutes, 0, MAX_PREPARATION_MINUTES),
      arrivalBufferMinutes: intInRange(raw.arrivalBufferMinutes, 0, MAX_PLACE_ARRIVAL_BUFFER_MINUTES),
      overheadMinutes: intInRange(raw.overheadMinutes, 0, MAX_OVERHEAD_MINUTES),
      weekdays,
      weekdaySet: new Set(weekdays),
      until: isIsoDate(raw.recurrenceUntil) ? raw.recurrenceUntil : null,
      skip,
      goalId: idOf(raw.goalId),
      notes: textOrNull(raw.notes, MAX_EVENT_NOTES_LENGTH),
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : ''
    };
  } catch {
    return null;
  }
}

/**
 * Kaksi riviä samalla tunnisteella on syötevirhe. Valinta ei saa riippua
 * syötteen järjestyksestä: uusin muokkaus voittaa, tasatilanteessa
 * sisällön mukaan.
 */
function signature(event) {
  return [
    event.updatedAt, event.date, event.startTime ?? '', event.endTime ?? '',
    event.durationMinutes ?? '', event.title, event.weekdays.join(','), event.until ?? '',
    [...event.skip].sort().join(','), event.category, event.placeId ?? '', event.locationText ?? ''
  ].join('|');
}

function buildOccurrence(event, date) {
  const startMinute = event.allDay ? null : toMinutes(event.startTime);
  const endMinute = startMinute !== null && event.durationMinutes !== null
    ? startMinute + event.durationMinutes
    : null;
  const crossesMidnight = endMinute !== null && endMinute > 1440;
  const placeId = event.placeId;
  const locationText = event.locationText;

  return Object.freeze({
    id: `event:${event.id}:${date}`,
    eventId: event.id,
    date,
    time: event.startTime,
    endTime: event.endTime,
    /** Päivä, jona esiintymä päättyy (seuraava päivä, jos keskiyö ylittyy). */
    endDate: crossesMidnight ? addDaysToIso(date, 1) : date,
    durationMinutes: event.durationMinutes,
    allDay: event.allDay,
    startMinute,
    /** Alkupäivän minuutteina; yli 1440, kun keskiyö ylittyy. null = kesto ei tiedossa. */
    endMinute,
    crossesMidnight,
    title: event.title,
    category: event.category,
    isEvent: true,
    source: 'event',
    placeId,
    locationText,
    hasPlace: placeId !== null || locationText !== null,
    travelMode: event.travelMode,
    travelMinutes: event.travelMinutes,
    preparationMinutes: event.preparationMinutes,
    arrivalBufferMinutes: event.arrivalBufferMinutes,
    overheadMinutes: event.overheadMinutes,
    goalId: event.goalId,
    notes: event.notes,
    recurring: event.weekdays.length > 0
  });
}

function compareOccurrences(a, b) {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
  if (!a.allDay && a.startMinute !== b.startMinute) return a.startMinute - b.startMinute;
  const byTitle = a.title.localeCompare(b.title, 'fi');
  if (byTitle !== 0) return byTitle;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Laajenna tapahtumien esiintymät aikavälille [from, to] (molemmat mukaan).
 *
 * SÄÄNNÖT:
 *  - Kertaluonteinen (recurrenceWeekdays = []): vain `date`.
 *  - Viikoittainen: `date` on aina ensimmäinen esiintymä, sen jälkeen
 *    valitut ISO-viikonpäivät `recurrenceUntil`-päivään asti (mukaan lukien).
 *  - `skipDates`-päivät ohitetaan (myös ensimmäinen).
 *  - Ilman alkuaikaa tapahtuma on koko päivän tapahtuma.
 *  - Loppuaika johdetaan kestosta, jos sitä ei ole; kesto johdetaan
 *    välistä, jos molemmat ajat ovat. Tuntematon kesto on null, ei nolla.
 *
 * TAKUUT: deterministinen (myös sekoitetulla syötteellä), jäädytetty,
 * ei koskaan kahta esiintymää samalla tunnisteella, enintään
 * MAX_EVENT_EXPANSION_DAYS päivää, ei koskaan heitä poikkeusta.
 *
 * @returns {ReadonlyArray<object>} esiintymät päivän ja kellonajan mukaan
 */
export function expandEventOccurrences({ events = [], from, to } = {}) {
  const fromNumber = dayNumberOf(from);
  const requestedTo = dayNumberOf(to);
  if (fromNumber === null || requestedTo === null || requestedTo < fromNumber) return EMPTY;
  const toNumber = Math.min(requestedTo, fromNumber + MAX_EVENT_EXPANSION_DAYS - 1);

  const byId = new Map();
  for (const raw of Array.isArray(events) ? events : []) {
    const event = readEvent(raw);
    if (!event) continue;
    const previous = byId.get(event.id);
    if (!previous || signature(event) > signature(previous)) byId.set(event.id, event);
  }

  const occurrences = [];
  for (const event of byId.values()) {
    const first = event.dayNumber;
    if (first >= fromNumber && first <= toNumber && !event.skip.has(event.date)) {
      occurrences.push(buildOccurrence(event, event.date));
    }
    if (event.weekdays.length === 0) continue;

    const until = event.until ? dayNumberOf(event.until) : Infinity;
    const last = Math.min(toNumber, until);
    for (let number = Math.max(fromNumber, first + 1); number <= last; number++) {
      if (!event.weekdaySet.has(weekdayOfNumber(number))) continue;
      const date = isoOfDayNumber(number);
      if (date === null || event.skip.has(date)) continue;
      occurrences.push(buildOccurrence(event, date));
    }
  }

  return Object.freeze(occurrences.sort(compareOccurrences));
}

/** Aikaväli, jolle päivänäkymän esiintymät kannattaa laajentaa (edellinen päivä mukaan). */
export function agendaRange(dateIso) {
  if (!isIsoDate(dateIso)) return null;
  return Object.freeze({ from: addDaysToIso(dateIso, -1) ?? dateIso, to: dateIso });
}

/** Viikkonäkymän aikaväli (edellinen sunnuntai mukaan keskiyön yli jatkuvia varten). */
export function weekRange(weekStart) {
  const monday = mondayOf(weekStart);
  if (!monday) return null;
  return Object.freeze({ from: addDaysToIso(monday, -1) ?? monday, to: addDaysToIso(monday, 6) });
}

// =====================================================================
// PÄIVÄNÄKYMÄ
// =====================================================================

const KIND_ORDER = Object.freeze({ block: 0, event: 1, routine: 2, task: 3 });

function safely(fn, fallback) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function isTimedItem(item) {
  return isTimeOfDay(item.time) && (!item.endTime || isTimeOfDay(item.endTime));
}

/** Päiväindeksi tehtäville ja rutiiniesiintymille: rakennetaan kerran. */
function indexByDate(items) {
  const map = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const date = safely(() => (item && typeof item === 'object' && isIsoDate(item.date) ? item.date : null), null);
    if (!date) continue;
    const list = map.get(date);
    if (list) list.push(item);
    else map.set(date, [item]);
  }
  return map;
}

function entryOf(kind, item) {
  const start = toMinutes(item.time);
  const duration = durationOf(item);
  const end = duration === null ? null : start + duration;
  const base = {
    kind,
    id: String(item.id),
    date: item.date,
    time: item.time,
    // Vuorokauden mittaisella palalla ei ole näytettävää loppuaikaa (00:00–00:00).
    endTime: end === null || end - start >= 1440 ? null : fromMinutes(end),
    startMinute: start,
    endMinute: end,
    title: String(item.title ?? '') || (kind === 'block' ? blockLabel(blockKindOf(item)) : 'Nimetön'),
    category: normalizeCategory(item.category),
    categoryLabel: categoryLabel(item.category),
    allDay: false,
    item
  };

  if (kind === 'block') {
    const blockKind = blockKindOf(item);
    return Object.freeze({
      ...base,
      label: blockLabel(blockKind),
      blockKind,
      protected: true,
      movable: false,
      sourceId: item.sourceId ?? null,
      explanation: typeof item.explanation === 'string' ? item.explanation : null
    });
  }
  if (kind === 'event') {
    return Object.freeze({
      ...base,
      label: ENTRY_LABELS.event,
      movable: false,
      sourceId: item.eventId ?? null,
      continuation: item.continuation === true,
      hasPlace: Boolean(item.hasPlace)
    });
  }
  if (kind === 'routine') {
    return Object.freeze({
      ...base, label: ENTRY_LABELS.routine, movable: false, sourceId: item.routineId ?? null
    });
  }
  return Object.freeze({
    ...base,
    label: ENTRY_LABELS.task,
    completed: Boolean(item.completed),
    // Vain automaatin sijoittama saa liikkua; käyttäjän oma aika on lukittu.
    movable: item.schedulingState === 'auto' && !item.completed,
    sourceId: String(item.id)
  });
}

function compareEntries(a, b) {
  if (a.startMinute !== b.startMinute) return a.startMinute - b.startMinute;
  if (a.kind !== b.kind) return KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
  const byTitle = a.title.localeCompare(b.title, 'fi');
  if (byTitle !== 0) return byTitle;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function untimedEntry(kind, item) {
  return Object.freeze({
    kind,
    id: String(item.id),
    date: item.date,
    title: String(item.title ?? '') || 'Nimetön',
    label: ENTRY_LABELS[kind],
    category: normalizeCategory(item.category),
    categoryLabel: categoryLabel(item.category),
    completed: kind === 'task' ? Boolean(item.completed) : false,
    durationMinutes: durationOf({ durationMinutes: item.durationMinutes }),
    movable: kind === 'task' ? !item.completed : true,
    item
  });
}

function compareUntimed(a, b) {
  if (a.kind !== b.kind) return a.kind === 'routine' ? -1 : 1;
  if (a.completed !== b.completed) return a.completed ? 1 : -1;
  const byTitle = a.title.localeCompare(b.title, 'fi');
  if (byTitle !== 0) return byTitle;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function summaryOf(counts) {
  const parts = [];
  if (counts.events > 0) parts.push(plural(counts.events, 'tapahtuma', 'tapahtumaa'));
  if (counts.continuing > 0) {
    parts.push(counts.continuing === 1
      ? 'edellisen päivän tapahtuma jatkuu'
      : `${counts.continuing} edellisen päivän tapahtumaa jatkuu`);
  }
  if (counts.tasks > 0) parts.push(plural(counts.tasks, 'tehtävä', 'tehtävää'));
  if (counts.routines > 0) parts.push(plural(counts.routines, 'rutiini', 'rutiinia'));
  if (!parts.length) return 'Ei merkintöjä';
  const text = parts.join(' · ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function unionMinutes(items) {
  return occupiedRanges(items).reduce((total, range) => total + (range.end - range.start), 0);
}

function emptyAgenda(date) {
  return Object.freeze({
    valid: false,
    date: typeof date === 'string' ? date : null,
    weekday: null,
    label: '',
    shortLabel: '',
    spokenLabel: '',
    isToday: false,
    isPast: false,
    allDay: EMPTY,
    entries: EMPTY,
    untimed: EMPTY,
    counts: Object.freeze({
      events: 0, allDay: 0, timedEvents: 0, continuing: 0, tasks: 0, openTasks: 0, routines: 0, blocks: 0
    }),
    busyMinutes: 0,
    protectedMinutes: 0,
    empty: true,
    summary: 'Ei merkintöjä'
  });
}

function buildAgenda(date, context) {
  const { eventIndex, blockIndex, tasksByDate, routinesByDate, todayIso } = context;

  const dayEvents = eventsOnDate(eventIndex, date);
  const allDay = Object.freeze(dayEvents.filter(occurrence => occurrence.allDay === true
    || !isTimeOfDay(occurrence.time)));
  const eventItems = eventItemsOnDate(eventIndex, date);
  const dayBlocks = blocksOnDate(blockIndex, date);

  const dayTasks = (tasksByDate.get(date) || []).filter(task =>
    safely(() => task.id != null, false));
  const dayRoutines = (routinesByDate.get(date) || []).filter(occurrence =>
    safely(() => occurrence.id != null, false));

  const timedTasks = [];
  const untimed = [];
  for (const task of dayTasks) {
    if (safely(() => isTimedItem(task), false)) timedTasks.push(task);
    else untimed.push(safely(() => untimedEntry('task', task), null));
  }
  const timedRoutines = [];
  for (const occurrence of dayRoutines) {
    if (safely(() => isTimedItem(occurrence), false)) timedRoutines.push(occurrence);
    else untimed.push(safely(() => untimedEntry('routine', occurrence), null));
  }

  const entries = [
    ...dayBlocks.map(block => safely(() => entryOf('block', block), null)),
    ...eventItems.map(item => safely(() => entryOf('event', item), null)),
    ...timedRoutines.map(occurrence => safely(() => entryOf('routine', occurrence), null)),
    ...timedTasks.map(task => safely(() => entryOf('task', task), null))
  ].filter(Boolean).sort(compareEntries);

  const counts = Object.freeze({
    events: dayEvents.length,
    allDay: allDay.length,
    timedEvents: dayEvents.length - allDay.length,
    /** Edellisenä päivänä alkaneet, tälle päivälle jatkuvat tapahtumat. */
    continuing: eventItems.filter(item => item.continuation === true).length,
    tasks: dayTasks.length,
    openTasks: dayTasks.filter(task => !safely(() => task.completed, false)).length,
    routines: dayRoutines.length,
    blocks: dayBlocks.length
  });

  // Pelkkä alku ja kesto: vuorokauden mittainen pala (00:00–00:00) ei
  // muuttuisi välistä kestoksi.
  const busyItems = entries
    .filter(entry => entry.kind !== 'task' || !entry.completed)
    .map(entry => ({
      time: entry.time,
      durationMinutes: entry.endMinute === null ? DEFAULT_TASK_MINUTES : entry.endMinute - entry.startMinute
    }));

  return Object.freeze({
    valid: true,
    date,
    weekday: isoWeekdayOf(date),
    label: longDateLabel(date),
    shortLabel: shortDateLabel(date),
    spokenLabel: spokenDateLabel(date),
    isToday: isIsoDate(todayIso) && date === todayIso,
    isPast: isIsoDate(todayIso) && date < todayIso,
    allDay,
    entries: Object.freeze(entries),
    untimed: Object.freeze(untimed.filter(Boolean).sort(compareUntimed)),
    counts,
    /** Varattu aika (unioni) minuutteina. Kesto ilman arviota lasketaan 30 minuutiksi kuten aikataulussa. */
    busyMinutes: unionMinutes(busyItems),
    /** Suojattujen lohkojen aika (unioni) minuutteina. */
    protectedMinutes: unionMinutes(dayBlocks),
    empty: entries.length === 0 && allDay.length === 0 && untimed.length === 0,
    summary: summaryOf(counts)
  });
}

/**
 * Yhden päivän näkymämalli.
 *
 * `entries` on aikajärjestyksessä: lohkot, tapahtumat (myös edellisenä
 * päivänä alkaneiden loppuosat), kiinteät rutiinit ja ajastetut tehtävät.
 * Koko päivän tapahtumat ovat erikseen (`allDay`), ajattomat tehtävät ja
 * joustavat rutiinit listassa `untimed`.
 *
 * @param {object} input
 * @param {string} input.date
 * @param {Array}  [input.occurrences]         tapahtumaesiintymät (myös edelliseltä päivältä)
 * @param {Array}  [input.tasks]
 * @param {Array}  [input.routineOccurrences]  routine.js expandRoutines(...)
 * @param {Array}  [input.blocks]              calendarBlocks.js deriveBlocks(...)
 * @param {string} [input.todayIso]
 */
export function dayAgenda({
  date, occurrences = [], tasks = [], routineOccurrences = [], blocks = [], todayIso = null
} = {}) {
  if (!isIsoDate(date)) return emptyAgenda(date);
  return buildAgenda(date, {
    eventIndex: indexEventOccurrences(occurrences),
    blockIndex: indexCalendarBlocks(blocks),
    tasksByDate: indexByDate(tasks),
    routinesByDate: indexByDate(routineOccurrences),
    todayIso
  });
}

// =====================================================================
// VIIKKONÄKYMÄ
// =====================================================================

/**
 * Viikon näkymämalli: maanantaista sunnuntaihin.
 *
 * `weekStart` voi olla mikä tahansa viikon päivä; se tasataan
 * maanantaihin. Indeksit rakennetaan kerran koko viikolle.
 */
export function weekModel({
  weekStart, occurrences = [], tasks = [], routineOccurrences = [], blocks = [], todayIso = null
} = {}) {
  const monday = mondayOf(weekStart);
  const sunday = monday ? addDaysToIso(monday, 6) : null;
  if (!monday || !sunday) {
    return Object.freeze({
      valid: false, weekStart: null, weekEnd: null, isoWeek: null, isoWeekYear: null,
      label: '', rangeLabel: '', days: EMPTY, containsToday: false,
      previousWeekStart: null, nextWeekStart: null,
      totals: Object.freeze({ events: 0, allDay: 0, tasks: 0, openTasks: 0, routines: 0, blocks: 0, busyMinutes: 0 })
    });
  }

  const context = {
    eventIndex: indexEventOccurrences(occurrences),
    blockIndex: indexCalendarBlocks(blocks),
    tasksByDate: indexByDate(tasks),
    routinesByDate: indexByDate(routineOccurrences),
    todayIso
  };
  const days = Object.freeze(Array.from({ length: 7 }, (_, i) =>
    buildAgenda(addDaysToIso(monday, i), context)));

  const sum = key => days.reduce((total, day) => total + day.counts[key], 0);
  const week = isoWeekOf(monday);

  return Object.freeze({
    valid: true,
    weekStart: monday,
    weekEnd: sunday,
    isoWeek: week.week,
    isoWeekYear: week.year,
    label: `Viikko ${week.week} · ${weekRangeLabel(monday)}`,
    rangeLabel: weekRangeLabel(monday),
    days,
    containsToday: isIsoDate(todayIso) && todayIso >= monday && todayIso <= sunday,
    previousWeekStart: addDaysToIso(monday, -7),
    nextWeekStart: addDaysToIso(monday, 7),
    totals: Object.freeze({
      events: sum('events'),
      allDay: sum('allDay'),
      tasks: sum('tasks'),
      openTasks: sum('openTasks'),
      routines: sum('routines'),
      blocks: sum('blocks'),
      busyMinutes: days.reduce((total, day) => total + day.busyMinutes, 0)
    })
  });
}

// =====================================================================
// KUUKAUSINÄKYMÄ
// =====================================================================

const WEEKDAY_HEADERS = Object.freeze([1, 2, 3, 4, 5, 6, 7].map(weekdayShort));

/** Kuukausiruudukon ensimmäinen ja viimeinen päivä (maanantaista sunnuntaihin). */
export function monthGridRange(month) {
  const parsed = parseMonth(month);
  if (!parsed) return null;
  const first = daysFromCivil(parsed.year, parsed.month, 1);
  const last = lastDayOfMonth(parsed.year, parsed.month);
  const from = first - (weekdayOfNumber(first) - 1);
  const to = last + (7 - weekdayOfNumber(last));
  const fromIso = isoOfDayNumber(from);
  const toIso = isoOfDayNumber(to);
  if (!fromIso || !toIso) return null;
  return Object.freeze({ from: fromIso, to: toIso });
}

function cellLabel(date, counts) {
  const parts = [];
  if (counts.events > 0) parts.push(plural(counts.events, 'tapahtuma', 'tapahtumaa'));
  if (counts.tasks > 0) parts.push(plural(counts.tasks, 'tehtävä', 'tehtävää'));
  return `${spokenDateLabel(date)}: ${parts.length ? parts.join(', ') : 'ei merkintöjä'}`;
}

/**
 * Kuukausiruudukko: ISO-viikon rivit maanantaista alkaen, 4–6 riviä.
 *
 * Kuukauden ulkopuoliset päivät (alussa ja lopussa) merkitään
 * `outsideMonth: true`, jotta ruudukko on aina täysiä viikkoja eikä
 * viikonpäivä vaihda saraketta. Päiväkohtaiset luvut: tapahtumat (joista
 * koko päivän erikseen) ja tehtävät. Esiintymät lasketaan alkamispäivälle.
 *
 * @param {object} input
 * @param {string} input.month        'YYYY-MM'
 * @param {Array}  [input.occurrences] laajennettu vähintään monthGridRange(month) -välille
 * @param {Array}  [input.tasks]
 * @param {string} [input.todayIso]
 */
export function monthGrid({ month, occurrences = [], tasks = [], todayIso = null } = {}) {
  const parsed = parseMonth(month);
  const range = parsed ? monthGridRange(month) : null;
  if (!parsed || !range) {
    return Object.freeze({
      valid: false, month: null, label: '', year: null, monthNumber: null,
      weekdayLabels: WEEKDAY_HEADERS, rows: EMPTY, firstDate: null, lastDate: null,
      gridStart: null, gridEnd: null, previousMonth: null, nextMonth: null,
      containsToday: false, totals: Object.freeze({ events: 0, allDay: 0, tasks: 0, openTasks: 0 })
    });
  }

  const eventIndex = indexEventOccurrences(occurrences);
  const tasksByDate = indexByDate(tasks);
  const firstDate = `${month}-01`;
  const lastDate = isoOfDayNumber(lastDayOfMonth(parsed.year, parsed.month));
  const today = isIsoDate(todayIso) ? todayIso : null;

  const rows = [];
  const totals = { events: 0, allDay: 0, tasks: 0, openTasks: 0 };
  const start = dayNumberOf(range.from);
  const end = dayNumberOf(range.to);

  for (let rowStart = start; rowStart <= end && rows.length < MAX_MONTH_ROWS; rowStart += 7) {
    const days = [];
    for (let offset = 0; offset < 7; offset++) {
      const date = isoOfDayNumber(rowStart + offset);
      const inMonth = date >= firstDate && date <= lastDate;
      const dayEvents = eventsOnDate(eventIndex, date);
      const allDay = dayEvents.filter(occurrence => occurrence.allDay === true
        || !isTimeOfDay(occurrence.time)).length;
      const dayTasks = tasksByDate.get(date) || [];
      const openTasks = dayTasks.filter(task => !safely(() => task.completed, false)).length;
      const counts = Object.freeze({
        events: dayEvents.length,
        allDay,
        timed: dayEvents.length - allDay,
        tasks: dayTasks.length,
        openTasks,
        total: dayEvents.length + dayTasks.length
      });

      if (inMonth) {
        totals.events += counts.events;
        totals.allDay += counts.allDay;
        totals.tasks += counts.tasks;
        totals.openTasks += counts.openTasks;
      }

      const weekday = offset + 1;
      days.push(Object.freeze({
        date,
        day: Number(date.slice(8, 10)),
        weekday,
        inMonth,
        outsideMonth: !inMonth,
        isToday: today !== null && date === today,
        isPast: today !== null && date < today,
        isWeekend: weekday >= 6,
        counts,
        hasEvents: counts.events > 0,
        hasAllDay: counts.allDay > 0,
        label: cellLabel(date, counts)
      }));
    }
    const week = isoWeekOf(isoOfDayNumber(rowStart));
    rows.push(Object.freeze({ isoWeek: week.week, isoWeekYear: week.year, days: Object.freeze(days) }));
  }

  return Object.freeze({
    valid: true,
    month,
    label: monthLabel(month),
    year: parsed.year,
    monthNumber: parsed.month,
    weekdayLabels: WEEKDAY_HEADERS,
    rows: Object.freeze(rows),
    firstDate,
    lastDate,
    gridStart: range.from,
    gridEnd: range.to,
    previousMonth: shiftMonth(month, -1),
    nextMonth: shiftMonth(month, 1),
    containsToday: today !== null && today >= firstDate && today <= lastDate,
    totals: Object.freeze(totals)
  });
}
