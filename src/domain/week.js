// Viikkotason domain-logiikka. Puhdas: ei DOM:ia, ei verkkoa.
//
// Viikko alkaa MAANANTAISTA (suomalainen käytäntö). JS:n getDay() palauttaa
// sunnuntain nollana, mikä on klassinen off-by-one-ansa vuoden ja kuukauden
// vaihteessa — siksi rajatapaukset on testattu erikseen.

import { fmtISO, parseISO, addDays, startOfWeek, sameDay, todayMidnight } from '../lib/datetime.js';
import { WD_FULL, capitalize, formatShortDate } from '../lib/format.js';
import { compareByDateThenDay } from './task.js';

/** Viikon seitsemän päivää Date-olioina, maanantaista sunnuntaihin. */
export function weekDays(weekStart) {
  const monday = startOfWeek(weekStart);
  return [0, 1, 2, 3, 4, 5, 6].map(i => addDays(monday, i));
}

/** Viikon päivät ISO-merkkijonoina. */
export function weekDayIsoList(weekStart) {
  return weekDays(weekStart).map(fmtISO);
}

/** Otsikko viikolle: '31.8. – 6.9.' */
export function weekRangeLabel(weekStart) {
  const days = weekDays(weekStart);
  return `${formatShortDate(days[0])} – ${formatShortDate(days[6])}`;
}

/** Kuuluuko päivämäärä tähän viikkoon. */
export function isInWeek(weekStart, dateIso) {
  return weekDayIsoList(weekStart).includes(dateIso);
}

/** Tämän viikon maanantai. */
export function currentWeekStart() {
  return startOfWeek(todayMidnight());
}

/**
 * Ryhmittelee tehtävät päivittäin.
 * Palauttaa Mapin, jossa avain on ISO-päivä ja arvo järjestetty taulukko.
 * Map säilyttää lisäysjärjestyksen, joten tulos on deterministinen.
 */
export function groupByDate(tasks) {
  const sorted = [...tasks].sort(compareByDateThenDay);
  const groups = new Map();
  for (const task of sorted) {
    if (!groups.has(task.date)) groups.set(task.date, []);
    groups.get(task.date).push(task);
  }
  return groups;
}

/**
 * Päiväryhmän otsikko suhteessa tähän päivään.
 * 'Tänään' / 'Huomenna' / 'Eilen' / 'Maanantai 31.8.'
 *
 * @param {string} dateIso
 * @param {Date}   [reference] Vertailupäivä. Annettavissa testejä varten.
 */
export function dayGroupLabel(dateIso, reference = todayMidnight()) {
  const date = parseISO(dateIso);
  if (sameDay(date, reference)) return 'Tänään';
  if (sameDay(date, addDays(reference, 1))) return 'Huomenna';
  if (sameDay(date, addDays(reference, -1))) return 'Eilen';
  return `${capitalize(WD_FULL[date.getDay()])} ${formatShortDate(date)}`;
}

/**
 * Viikon yhteenveto päivittäin: montako tehtävää, montako tehty.
 * Käytetään viikkonauhan kuormituspisteisiin.
 */
export function weekSummary(weekStart, tasks) {
  const byDate = groupByDate(tasks);
  return weekDays(weekStart).map(date => {
    const iso = fmtISO(date);
    const dayTasks = byDate.get(iso) || [];
    return {
      date,
      iso,
      total: dayTasks.length,
      completed: dayTasks.filter(t => t.completed).length,
      hasHighPriority: dayTasks.some(t => t.priority === 'korkea' && !t.completed)
    };
  });
}
