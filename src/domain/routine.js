// Toistuvien rutiinien domain.
//
// Puhdas moduuli: ei DOM:ia, ei verkkoa, ei kelloa, ei satunnaisuutta.
//
// MIKSI RUTIINIT OVAT OMA KÄSITTEENSÄ
// Rutiini ei ole tehtävä, joka toistuu. Se on *sääntö*, josta esiintymät
// johdetaan. Ero on olennainen: jos rutiinit tallennettaisiin tehtävinä,
// vuoden päivittäinen rutiini olisi 365 riviä, ja säännön muuttaminen
// vaatisi 365 rivin päivittämisen.
//
// Siksi esiintymät LASKETAAN aina uudelleen näkyvälle aikavälille, kuten
// automaattiset herätys- ja unimerkinnät jo tehdään. Kantaan tallennetaan
// vain sääntö ja poikkeukset.
//
// VIIKONPÄIVIEN ESITYS
// Käytetään ISO-numerointia: 1 = maanantai ... 7 = sunnuntai.
// JS:n getDay() palauttaa sunnuntain nollana, mikä on jatkuva virhelähde
// suomalaisessa viikkokäsityksessä. Muunnos tehdään yhdessä paikassa
// (isoWeekday) eikä missään muualla.

import { fmtISO, parseISO, addDays } from '../lib/datetime.js';
import { normalizeCategory } from './categories.js';
import { normalizePriority } from './priority.js';
import { isIsoDate, isTimeOfDay, fromMinutes, toMinutes, MAX_TITLE_LENGTH } from './task.js';

/**
 * Toistosäännön tyypit.
 *
 * Malli on tarkoituksella laajennettava: MONTHLY, INTERVAL ja RRULE voidaan
 * lisätä myöhemmin lisäämällä tyyppi ja sen `matches`-funktio ilman että
 * nykyiset säännöt tai tallennettu data muuttuvat.
 */
export const RECURRENCE = Object.freeze({
  /** Joka päivä. */
  DAILY: 'daily',
  /** Arkipäivät ma–pe. */
  WEEKDAYS: 'weekdays',
  /** Yksi viikonpäivä viikossa. */
  WEEKLY: 'weekly',
  /** Valitut viikonpäivät. */
  CUSTOM_WEEKDAYS: 'custom_weekdays'
});

export const RECURRENCE_TYPES = Object.freeze(Object.values(RECURRENCE));

/**
 * Tulevat tyypit. Nämä EIVÄT ole vielä tuettuja — lista on tässä, jotta
 * validointi voi hylätä ne selkeällä viestillä eikä hiljaisesti.
 */
export const PLANNED_RECURRENCE_TYPES = Object.freeze(['monthly', 'interval', 'rrule']);

/** Miten rutiinin esiintymä sijoittuu päivään. */
export const ROUTINE_SCHEDULING = Object.freeze({
  /** Kiinteä kellonaika. Esiintymä on aina samaan aikaan. */
  FIXED: 'fixed',
  /** Joustava: aikataulumoottori saa sijoittaa sen vapaaseen väliin. */
  FLEXIBLE: 'flexible'
});

/** Poikkeuksen tyypit. */
export const EXCEPTION = Object.freeze({
  /** Tämä esiintymä jätetään väliin. */
  SKIP: 'skip',
  /** Tämä esiintymä siirtyy toiseen aikaan samana päivänä. */
  RESCHEDULE: 'reschedule',
  /** Tämän esiintymän kenttiä muutetaan kertaluonteisesti. */
  OVERRIDE: 'override'
});

export const EXCEPTION_TYPES = Object.freeze(Object.values(EXCEPTION));

/**
 * Laajennuksen enimmäisikkuna päivinä.
 *
 * Suojaa virheeltä, jossa rutiinit laajennettaisiin vahingossa vuosiksi
 * eteenpäin — se olisi hiljainen suorituskykyongelma, joka ilmenisi vasta
 * käyttäjällä.
 */
export const MAX_EXPANSION_DAYS = 400;

export const DEFAULT_ROUTINE_MINUTES = 30;

/** ISO-viikonpäivä Date-oliosta: 1 = maanantai ... 7 = sunnuntai. */
export function isoWeekday(date) {
  const day = date.getDay();
  return day === 0 ? 7 : day;
}

/** Onko arvo kelvollinen ISO-viikonpäivä. */
export function isIsoWeekday(value) {
  return Number.isInteger(value) && value >= 1 && value <= 7;
}

const WEEKDAY_NAMES = Object.freeze([
  null, 'maanantai', 'tiistai', 'keskiviikko', 'torstai', 'perjantai', 'lauantai', 'sunnuntai'
]);

const WEEKDAY_SHORT = Object.freeze([null, 'ma', 'ti', 'ke', 'to', 'pe', 'la', 'su']);

export function weekdayName(iso) {
  return WEEKDAY_NAMES[iso] || '';
}

export function weekdayShort(iso) {
  return WEEKDAY_SHORT[iso] || '';
}

/**
 * Normalisoi viikonpäivälista: yksilölliset, järjestetyt, kelvolliset arvot.
 * Järjestys takaa determinismin ja tekee vertailusta helppoa.
 */
export function normalizeWeekdays(value) {
  if (!Array.isArray(value)) return [];
  const unique = new Set();
  for (const entry of value) {
    const n = Number(entry);
    if (isIsoWeekday(n)) unique.add(n);
  }
  return [...unique].sort((a, b) => a - b);
}

/**
 * Normalisoi mielivaltainen olio rutiiniksi.
 * Ei koskaan heitä poikkeusta — validointiin käytä validateRoutine().
 */
export function normalizeRoutine(input = {}) {
  const type = RECURRENCE_TYPES.includes(input.recurrence?.type)
    ? input.recurrence.type
    : RECURRENCE.DAILY;

  const weekdays = normalizeWeekdays(input.recurrence?.weekdays);

  const rawDuration = Number(input.durationMinutes);
  const durationMinutes = Number.isFinite(rawDuration) && rawDuration > 0
    ? Math.min(Math.round(rawDuration), 1440)
    : DEFAULT_ROUTINE_MINUTES;

  const preferredTime = isTimeOfDay(input.preferredTime) ? input.preferredTime : null;

  return {
    id: input.id != null ? String(input.id) : null,
    title: String(input.title ?? '').trim().slice(0, MAX_TITLE_LENGTH),
    description: input.description ? String(input.description).trim().slice(0, 2000) : null,
    category: normalizeCategory(input.category),
    priority: normalizePriority(input.priority),
    durationMinutes,
    recurrence: { type, weekdays },
    preferredTime,
    // Ilman kellonaikaa rutiini on aina joustava — kiinteä sijoitus ei ole
    // mahdollinen, jos aikaa ei ole annettu.
    scheduling: preferredTime && input.scheduling !== ROUTINE_SCHEDULING.FLEXIBLE
      ? ROUTINE_SCHEDULING.FIXED
      : ROUTINE_SCHEDULING.FLEXIBLE,
    active: input.active !== false,
    /** Vapaaehtoinen yhteys tavoitteeseen. Ks. PROGRESS_MODE.ROUTINE_BASED. */
    goalId: input.goalId != null ? String(input.goalId) : null,
    startDate: isIsoDate(input.startDate) ? input.startDate : null,
    endDate: isIsoDate(input.endDate) ? input.endDate : null,
    createdAt: input.createdAt ?? null,
    updatedAt: input.updatedAt ?? null
  };
}

/**
 * Validoi rutiini.
 * @returns {{valid: boolean, errors: Record<string,string>}}
 */
export function validateRoutine(routine) {
  const errors = {};

  const title = String(routine.title ?? '').trim();
  if (!title) errors.title = 'Anna rutiinille nimi.';
  else if (title.length > MAX_TITLE_LENGTH) errors.title = 'Nimi on liian pitkä.';

  const type = routine.recurrence?.type;
  if (!RECURRENCE_TYPES.includes(type)) {
    errors.recurrence = PLANNED_RECURRENCE_TYPES.includes(type)
      ? 'Tätä toistoa ei vielä tueta.'
      : 'Valitse toistotapa.';
  }

  if (type === RECURRENCE.WEEKLY) {
    if (normalizeWeekdays(routine.recurrence?.weekdays).length !== 1) {
      errors.weekdays = 'Valitse yksi viikonpäivä.';
    }
  }

  if (type === RECURRENCE.CUSTOM_WEEKDAYS) {
    if (normalizeWeekdays(routine.recurrence?.weekdays).length === 0) {
      errors.weekdays = 'Valitse vähintään yksi viikonpäivä.';
    }
  }

  if (routine.preferredTime != null && !isTimeOfDay(routine.preferredTime)) {
    errors.preferredTime = 'Kellonaika ei kelpaa.';
  }

  const duration = Number(routine.durationMinutes);
  if (!Number.isFinite(duration) || duration <= 0) errors.durationMinutes = 'Keston pitää olla positiivinen.';
  else if (duration > 1440) errors.durationMinutes = 'Kesto ei voi ylittää vuorokautta.';

  if (routine.startDate && !isIsoDate(routine.startDate)) errors.startDate = 'Alkupäivä ei kelpaa.';
  if (routine.endDate && !isIsoDate(routine.endDate)) errors.endDate = 'Loppupäivä ei kelpaa.';
  if (routine.startDate && routine.endDate && routine.endDate < routine.startDate) {
    errors.endDate = 'Loppupäivä ei voi olla ennen alkupäivää.';
  }

  return { valid: Object.keys(errors).length === 0, errors };
}

/**
 * Osuuko rutiini annetulle päivälle?
 * Puhdas predikaatti — tämä on toistosäännön koko logiikka yhdessä paikassa.
 */
export function matchesDate(routine, dateIso) {
  if (!routine.active) return false;
  if (routine.startDate && dateIso < routine.startDate) return false;
  if (routine.endDate && dateIso > routine.endDate) return false;

  const weekday = isoWeekday(parseISO(dateIso));
  const { type, weekdays } = routine.recurrence;

  switch (type) {
    case RECURRENCE.DAILY:
      return true;
    case RECURRENCE.WEEKDAYS:
      return weekday >= 1 && weekday <= 5;
    case RECURRENCE.WEEKLY:
    case RECURRENCE.CUSTOM_WEEKDAYS:
      return weekdays.includes(weekday);
    default:
      // Tuntematon tyyppi ei koskaan osu. Hiljainen "joka päivä" olisi
      // pahin mahdollinen oletus.
      return false;
  }
}

/**
 * Esiintymän deterministinen tunniste.
 *
 * Sama rutiini samalle päivälle tuottaa aina saman tunnisteen, eikä kahdella
 * eri esiintymällä voi olla samaa. Tätä tarvitaan, jotta poikkeukset osuvat
 * oikeaan esiintymään ja jotta käyttöliittymä voi tunnistaa rivin.
 */
export function occurrenceId(routineId, dateIso) {
  return `routine:${routineId}:${dateIso}`;
}

/** Poikkeuksen normalisointi. */
export function normalizeException(input = {}) {
  const type = EXCEPTION_TYPES.includes(input.type) ? input.type : EXCEPTION.SKIP;
  return {
    id: input.id != null ? String(input.id) : null,
    routineId: input.routineId != null ? String(input.routineId) : null,
    date: isIsoDate(input.date) ? input.date : null,
    type,
    time: isTimeOfDay(input.time) ? input.time : null,
    durationMinutes: Number.isFinite(Number(input.durationMinutes)) && Number(input.durationMinutes) > 0
      ? Math.round(Number(input.durationMinutes))
      : null,
    title: input.title ? String(input.title).trim().slice(0, MAX_TITLE_LENGTH) : null,
    note: input.note ? String(input.note).trim().slice(0, 300) : null
  };
}

export function validateException(exception) {
  const errors = {};
  if (!exception.routineId) errors.routineId = 'Rutiini puuttuu.';
  if (!isIsoDate(exception.date)) errors.date = 'Päivämäärä puuttuu.';
  if (!EXCEPTION_TYPES.includes(exception.type)) errors.type = 'Tuntematon poikkeustyyppi.';
  if (exception.type === EXCEPTION.RESCHEDULE && !isTimeOfDay(exception.time)) {
    errors.time = 'Siirto vaatii uuden kellonajan.';
  }
  return { valid: Object.keys(errors).length === 0, errors };
}

/** Hakee poikkeuksen tietylle rutiinille ja päivälle. */
export function findException(exceptions, routineId, dateIso) {
  if (!Array.isArray(exceptions)) return null;
  return exceptions.find(e => e.routineId === routineId && e.date === dateIso) || null;
}

/** Rakentaa yhden esiintymän. Sisäinen apufunktio. */
function buildOccurrence(routine, dateIso, exception) {
  const time = exception && exception.type === EXCEPTION.RESCHEDULE && exception.time
    ? exception.time
    : routine.preferredTime;

  const durationMinutes = exception && exception.durationMinutes
    ? exception.durationMinutes
    : routine.durationMinutes;

  const endTime = time ? fromMinutes(toMinutes(time) + durationMinutes) : null;

  return {
    id: occurrenceId(routine.id, dateIso),
    routineId: routine.id,
    date: dateIso,
    time,
    endTime,
    durationMinutes,
    title: (exception && exception.title) || routine.title,
    description: routine.description,
    category: routine.category,
    priority: routine.priority,
    /** Erottaa rutiiniesiintymän tavallisesta tehtävästä käyttöliittymässä. */
    isRoutine: true,
    source: 'routine',
    scheduling: routine.scheduling,
    exceptionApplied: exception ? exception.type : null,
    note: (exception && exception.note) || null
  };
}

/**
 * Laajenna yhden rutiinin esiintymät aikavälille.
 *
 * TAKUUT:
 *  - Deterministinen: sama syöte tuottaa aina saman tuloksen
 *  - Ei koskaan kahta esiintymää samalla tunnisteella
 *  - Ohitettu (SKIP) esiintymä ei näy tuloksessa
 *  - Ei koskaan laajenna yli MAX_EXPANSION_DAYS päivää
 *
 * @param {object} args
 * @param {object} args.routine
 * @param {string} args.from        ISO-päivä (mukaan lukien)
 * @param {string} args.to          ISO-päivä (mukaan lukien)
 * @param {Array}  [args.exceptions]
 * @returns {Array} esiintymät päiväjärjestyksessä
 */
export function expandRoutineOccurrences({ routine, from, to, exceptions = [] }) {
  if (!routine || !routine.id) return [];
  if (!isIsoDate(from) || !isIsoDate(to)) return [];
  if (to < from) return [];
  if (!routine.active) return [];

  const occurrences = [];
  let cursor = parseISO(from);
  const end = parseISO(to);
  let guard = 0;

  while (cursor <= end) {
    if (++guard > MAX_EXPANSION_DAYS) break;

    const dateIso = fmtISO(cursor);
    if (matchesDate(routine, dateIso)) {
      const exception = findException(exceptions, routine.id, dateIso);
      if (!exception || exception.type !== EXCEPTION.SKIP) {
        occurrences.push(buildOccurrence(routine, dateIso, exception));
      }
    }
    cursor = addDays(cursor, 1);
  }

  return occurrences;
}

/**
 * Laajenna useamman rutiinin esiintymät samalle aikavälille.
 * Tulos on järjestetty päivän ja kellonajan mukaan — determinismi säilyy.
 */
export function expandRoutines({ routines, from, to, exceptions = [] }) {
  const all = [];
  for (const routine of routines || []) {
    all.push(...expandRoutineOccurrences({ routine, from, to, exceptions }));
  }
  return all.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (a.time && b.time && a.time !== b.time) return a.time < b.time ? -1 : 1;
    if (a.time && !b.time) return -1;
    if (!a.time && b.time) return 1;
    return a.id.localeCompare(b.id);
  });
}

/**
 * Rutiinin seuraava esiintymä annetusta päivästä eteenpäin.
 * Käytetään käyttöliittymässä ("seuraavaksi: huomenna 07:00").
 *
 * @returns {object|null}
 */
export function nextOccurrence({ routine, fromDate, exceptions = [], horizonDays = 60 }) {
  if (!routine || !routine.active || !isIsoDate(fromDate)) return null;
  const to = fmtISO(addDays(parseISO(fromDate), Math.min(horizonDays, MAX_EXPANSION_DAYS)));
  const occurrences = expandRoutineOccurrences({ routine, from: fromDate, to, exceptions });
  return occurrences[0] || null;
}

/** Toistosäännön kuvaus käyttäjälle. */
export function describeRecurrence(routine) {
  const { type, weekdays } = routine.recurrence;
  switch (type) {
    case RECURRENCE.DAILY:
      return 'Joka päivä';
    case RECURRENCE.WEEKDAYS:
      return 'Arkisin ma–pe';
    case RECURRENCE.WEEKLY:
      return weekdays.length ? `Joka ${weekdayName(weekdays[0])}` : 'Kerran viikossa';
    case RECURRENCE.CUSTOM_WEEKDAYS:
      return weekdays.length
        ? weekdays.map(weekdayShort).join(', ')
        : 'Ei valittuja päiviä';
    default:
      return 'Tuntematon toisto';
  }
}
