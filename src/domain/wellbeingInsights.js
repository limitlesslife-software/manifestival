// Hyvinvoinnin koosteet: päivän yhdistetty merkintä, keskiarvot ja
// läpinäkyvä kuormitusehdotus.
//
// PUHDAS MODUULI: ei kelloa, ei DOM:ia, ei verkkoa. Päivä annetaan
// parametrina.
//
// KAKSI TAULUA, YKSI PÄIVÄ
//
// Energia, mieliala, kuormitus ja uni ovat wellbeing_entries-taulussa;
// motivaatio ja hallinnan tunne uudessa wellbeing_checkins-taulussa
// (0014, olemassa olevaa taulua ei muutettu). Käyttäjälle ne ovat sama
// päivä, joten ne yhdistetään tässä päivämäärän mukaan.
//
// EHDOTUS, EI DIAGNOOSI
//
// Sama periaate kuin wellbeing.js:ssä: hyvinvointi ei koskaan muuta
// suunnitelmaa itsestään. `strainSuggestion` palauttaa tekstin ja sen
// perustelun — omat merkinnät ja säännön luvut — ei toimenpidettä.
// Se ei nimeä tiloja ("uupumus" tms.) eikä anna hoito-ohjeita.
//
// TUNTEMATON EI OLE NOLLA
//
// Päivä ilman merkintää ei ole huono eikä hyvä päivä vaan tuntematon.
// Keskiarvot lasketaan vain annetuista arvoista, ja liian harvasta
// aineistosta ehdotus on null.

import { SCALE_MIN, SCALE_MAX } from './wellbeing.js';
import { WELLBEING_RULES } from './dailyLifeSignalsPolicy.js';
import { isCalendarDate, parseTimestampMs } from './zonedClock.js';
import { addDaysIso } from './fiTemporal.js';

export const WELLBEING_SUGGESTION = 'lighten_load';

export const STRAIN_RULE = Object.freeze({
  LOW_ENERGY: 'strain.high_load_low_energy',
  LOW_CONTROL: 'strain.high_load_low_control'
});

const MAX_ID_LENGTH = 200;
const codeUnitOrder = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Hajotettava olio: null, luku tai merkkijono ei kaada funktiota. */
const argsOf = value => (value !== null && typeof value === 'object' ? value : {});

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Asteikon arvo 1–5 tai null. Tyhjä ei ole nolla; asteikon ulkopuolinen luku kiristetään. */
function scale(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : NaN;
  if (!Number.isFinite(n)) return null;
  return Math.max(SCALE_MIN, Math.min(SCALE_MAX, Math.round(n)));
}

function sleepHoursOf(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : NaN;
  if (!Number.isFinite(n)) return null;
  const rounded = Math.min(Math.round(n * 10) / 10, 24);
  return rounded > 0 ? rounded : null;
}

function idOf(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' || trimmed.length > MAX_ID_LENGTH ? null : trimmed;
}

function readEntry(input) {
  if (!isObject(input) || !isCalendarDate(input.date)) return null;
  return {
    id: idOf(input.id),
    date: input.date,
    updatedMs: parseTimestampMs(input.updatedAt),
    energy: scale(input.energy),
    mood: scale(input.mood),
    stress: scale(input.stress),
    sleepHours: sleepHoursOf(input.sleepHours)
  };
}

function readCheckin(input) {
  if (!isObject(input) || !isCalendarDate(input.date)) return null;
  return {
    id: idOf(input.id),
    date: input.date,
    updatedMs: parseTimestampMs(input.updatedAt),
    motivation: scale(input.motivation),
    control: scale(input.control)
  };
}

/**
 * Kaksi riviä samalle päivälle on syötevirhe (kannassa unique(user,date)),
 * mutta valinta on silti deterministinen: myöhemmin päivitetty voittaa,
 * sitten pienempi tunniste, sitten sisältö.
 */
function preferred(a, b) {
  const aMs = a.updatedMs ?? -Infinity;
  const bMs = b.updatedMs ?? -Infinity;
  if (aMs !== bMs) return aMs > bMs ? a : b;
  if (a.id !== b.id) {
    if (a.id === null) return b;
    if (b.id === null) return a;
    return codeUnitOrder(a.id, b.id) <= 0 ? a : b;
  }
  return codeUnitOrder(JSON.stringify(a), JSON.stringify(b)) <= 0 ? a : b;
}

function byDate(list, read, fromIso, toIso) {
  const map = new Map();
  if (!Array.isArray(list)) return map;
  for (const input of list) {
    const row = read(input);
    if (!row) continue;
    if (fromIso !== null && row.date < fromIso) continue;
    if (toIso !== null && row.date > toIso) continue;
    const existing = map.get(row.date);
    map.set(row.date, existing ? preferred(existing, row) : row);
  }
  return map;
}

function merged(entry, checkin) {
  const date = (entry || checkin).date;
  return Object.freeze({
    date,
    energy: entry ? entry.energy : null,
    mood: entry ? entry.mood : null,
    stress: entry ? entry.stress : null,
    sleepHours: entry ? entry.sleepHours : null,
    motivation: checkin ? checkin.motivation : null,
    control: checkin ? checkin.control : null,
    hasEntry: Boolean(entry),
    hasCheckin: Boolean(checkin)
  });
}

/**
 * Yhdistä saman päivän hyvinvointimerkintä ja tsekkaus.
 *
 * @returns {object|null} null, jos kumpaakaan ei ole tai päivät eroavat
 */
export function mergeDay(entry, checkin) {
  const e = readEntry(entry);
  const c = readCheckin(checkin);
  if (!e && !c) return null;
  if (e && c && e.date !== c.date) return null;
  return merged(e, c);
}

/** Kaikki päivät yhdistettyinä, päivämääräjärjestyksessä. Rajat valinnaisia. */
export function mergeDays(entries, checkins, options) {
  const { fromIso = null, toIso = null } = argsOf(options);
  const from = isCalendarDate(fromIso) ? fromIso : null;
  const to = isCalendarDate(toIso) ? toIso : null;
  const e = byDate(entries, readEntry, from, to);
  const c = byDate(checkins, readCheckin, from, to);
  const dates = [...new Set([...e.keys(), ...c.keys()])].sort();
  return Object.freeze(dates.map(date => merged(e.get(date) || null, c.get(date) || null)));
}

function windowOf({ fromIso, toIso, todayIso, days }) {
  if (isCalendarDate(fromIso) && isCalendarDate(toIso) && fromIso <= toIso) return { from: fromIso, to: toIso };
  if (!isCalendarDate(todayIso)) return null;
  const n = Number.isInteger(days) && days >= 1 && days <= WELLBEING_RULES.AVERAGE_MAX_DAYS
    ? days
    : WELLBEING_RULES.AVERAGE_DEFAULT_DAYS;
  return { from: addDaysIso(todayIso, -(n - 1)), to: todayIso };
}

function utcDayNumber(iso) {
  const [year, month, day] = iso.split('-').map(Number);
  // setUTCFullYear eikä Date.UTC: jälkimmäinen tulkitsee vuodet 0–99 1900-luvuksi.
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return Math.round(date.getTime() / 86400000);
}

function dayCount(fromIso, toIso) {
  return utcDayNumber(toIso) - utcDayNumber(fromIso) + 1;
}

const METRICS = Object.freeze(['energy', 'mood', 'stress', 'sleepHours', 'motivation', 'control']);

/**
 * Keskiarvot aikaväliltä, myös motivaatio ja hallinnan tunne.
 *
 * Väli annetaan joko `fromIso`–`toIso` tai `todayIso` + `days` (oletus 7,
 * tämä päivä mukaan lukien). Puuttuvat arvot ohitetaan.
 */
export function windowAverages(input) {
  const { entries, checkins, fromIso, toIso, todayIso, days } = argsOf(input);
  const window = windowOf({ fromIso, toIso, todayIso, days });
  if (!window) return null;
  const rows = mergeDays(entries, checkins, { fromIso: window.from, toIso: window.to });
  const result = {
    fromIso: window.from,
    toIso: window.to,
    days: dayCount(window.from, window.to),
    reportedDays: 0
  };
  const counts = {};
  for (const metric of METRICS) {
    let sum = 0;
    let count = 0;
    for (const row of rows) {
      if (row[metric] === null) continue;
      sum += row[metric];
      count += 1;
    }
    result[metric] = count > 0 ? Math.round((sum / count) * 10) / 10 : null;
    counts[metric] = count;
  }
  result.reportedDays = rows.filter(row => METRICS.some(metric => row[metric] !== null)).length;
  result.counts = Object.freeze(counts);
  return Object.freeze(result);
}

/**
 * Kuormittuneiden päivien laskenta aikaväliltä (sääntö WELLBEING_RULES).
 *
 * Päivä on merkitty, kun siltä on kuormitusarvio ja lisäksi energia tai
 * hallinnan tunne. Kuormittunut päivä: kuormitus >= HIGH_LOAD_MIN ja
 * energia <= LOW_ENERGY_MAX (tai hallinnan tunne <= LOW_CONTROL_MAX).
 */
export function strainCounts(input) {
  const { entries, checkins, fromIso, toIso } = argsOf(input);
  if (!isCalendarDate(fromIso) || !isCalendarDate(toIso) || fromIso > toIso) return null;
  const rows = mergeDays(entries, checkins, { fromIso, toIso });
  let reportedDays = 0;
  let lowEnergyDays = 0;
  let lowControlDays = 0;
  let strainedDays = 0;
  for (const row of rows) {
    if (row.stress === null || (row.energy === null && row.control === null)) continue;
    reportedDays += 1;
    const highLoad = row.stress >= WELLBEING_RULES.HIGH_LOAD_MIN;
    const lowEnergy = highLoad && row.energy !== null && row.energy <= WELLBEING_RULES.LOW_ENERGY_MAX;
    const lowControl = highLoad && row.control !== null && row.control <= WELLBEING_RULES.LOW_CONTROL_MAX;
    if (lowEnergy) lowEnergyDays += 1;
    if (lowControl) lowControlDays += 1;
    if (lowEnergy || lowControl) strainedDays += 1;
  }
  return Object.freeze({
    fromIso,
    toIso,
    windowDays: dayCount(fromIso, toIso),
    reportedDays,
    lowEnergyDays,
    lowControlDays,
    strainedDays
  });
}

function plannedPercentOf(plannedLoad) {
  if (!isObject(plannedLoad)) return null;
  const planned = plannedLoad.plannedMinutes;
  const capacity = plannedLoad.capacityMinutes;
  // Tuntematon suunnitelma tai kapasiteetti ei ole nolla: silloin ei sanota mitään.
  if (typeof planned !== 'number' || typeof capacity !== 'number') return null;
  if (!Number.isFinite(planned) || !Number.isFinite(capacity) || planned < 0 || capacity <= 0) return null;
  return Math.round((planned / capacity) * 100);
}

/**
 * Läpinäkyvä kuormitusehdotus viimeisiltä STRAIN_WINDOW_DAYS päiviltä.
 *
 * Esimerkki: kuormitus korkea ja energia matala vähintään 3 päivänä
 * viimeisistä 5 -> "Harkitse kuorman keventämistä tällä viikolla."
 *
 * `plannedLoad` ({plannedMinutes, capacityMinutes}, valinnainen) lisää
 * perusteluun tiedon, jos viikon suunnitelma jo täyttää oman aikasi.
 *
 * @returns {object|null} null, kun aineisto on harvaa tai ehdotettavaa ei ole
 */
export function strainSuggestion(input) {
  const { entries, checkins, plannedLoad = null, todayIso } = argsOf(input);
  if (!isCalendarDate(todayIso)) return null;
  const fromIso = addDaysIso(todayIso, -(WELLBEING_RULES.STRAIN_WINDOW_DAYS - 1));
  const counts = strainCounts({ entries, checkins, fromIso, toIso: todayIso });
  if (!counts || counts.reportedDays < WELLBEING_RULES.STRAIN_MIN_REPORTED_DAYS) return null;

  let rule = null;
  let days = 0;
  let text = null;
  let why = null;
  const window = WELLBEING_RULES.STRAIN_WINDOW_DAYS;
  if (counts.lowEnergyDays >= WELLBEING_RULES.STRAIN_MIN_DAYS) {
    rule = STRAIN_RULE.LOW_ENERGY;
    days = counts.lowEnergyDays;
    text = 'Harkitse kuorman keventämistä tällä viikolla.';
    why = `Kuormitus oli korkea (${WELLBEING_RULES.HIGH_LOAD_MIN}–${SCALE_MAX}) ja energia matala `
      + `(${SCALE_MIN}–${WELLBEING_RULES.LOW_ENERGY_MAX}) ${days} päivänä viimeisistä ${window} päivästä omien merkintöjesi mukaan.`;
  } else if (counts.lowControlDays >= WELLBEING_RULES.STRAIN_MIN_DAYS) {
    rule = STRAIN_RULE.LOW_CONTROL;
    days = counts.lowControlDays;
    text = 'Harkitse, voisiko jonkin tämän viikon asian siirtää tai jakaa.';
    why = `Kuormitus oli korkea (${WELLBEING_RULES.HIGH_LOAD_MIN}–${SCALE_MAX}) ja hallinnan tunne vähäinen `
      + `(${SCALE_MIN}–${WELLBEING_RULES.LOW_CONTROL_MAX}) ${days} päivänä viimeisistä ${window} päivästä omien merkintöjesi mukaan.`;
  }
  if (rule === null) return null;

  const plannedPercent = plannedPercentOf(plannedLoad);
  const plannedLoadNote = plannedPercent !== null && plannedPercent >= 100
    ? 'Tämän viikon suunnitelma täyttää jo koko ilmoittamasi ajan.'
    : null;

  return Object.freeze({
    kind: WELLBEING_SUGGESTION,
    rule,
    basis: 'reported',
    text,
    why,
    plannedLoadNote,
    /** Ehdotus ei koskaan muuta suunnitelmaa itsestään. */
    appliesAutomatically: false,
    metrics: Object.freeze({
      windowDays: window,
      reportedDays: counts.reportedDays,
      strainedDays: days,
      plannedPercent
    })
  });
}
