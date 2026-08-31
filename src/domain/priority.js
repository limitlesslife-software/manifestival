// Tehtävien prioriteettimalli.
//
// Tarkoituksella VAIN KOLME tasoa. Konseptidokumentin luku 9 puhuu
// priorisoinnista arjen selkeyttäjänä; useampi taso lisäisi päätöksiä
// vähentämättä kuormaa. Kolme tasoa erottuu myös visuaalisesti yhdellä
// silmäyksellä, mikä on koko tuotteen lupaus.
//
// Prioriteetti vaikuttaa kolmeen asiaan:
//   1. järjestykseen listoissa (compareByPriority)
//   2. automaattiseen aikataulutukseen (domain/scheduler.js sijoittaa
//      korkean prioriteetin tehtävät ensin parhaisiin vapaisiin väleihin)
//   3. käyttöliittymän tunnistettavuuteen (tone-token)

export const DEFAULT_PRIORITY = 'normaali';

/**
 * @typedef {object} Priority
 * @property {string} key
 * @property {string} label
 * @property {number} weight  Pienempi = tärkeämpi. Käytetään järjestykseen.
 * @property {string} tone    Väritoken
 */

/** @type {ReadonlyArray<Priority>} */
export const PRIORITIES = Object.freeze([
  { key: 'korkea',   label: 'Tärkeä',   weight: 0, tone: 'clay'   },
  { key: 'normaali', label: 'Normaali', weight: 1, tone: 'sage'   },
  { key: 'matala',   label: 'Voi odottaa', weight: 2, tone: 'muted' }
].map(Object.freeze));

const BY_KEY = new Map(PRIORITIES.map(p => [p.key, p]));

export const PRIORITY_KEYS = Object.freeze(PRIORITIES.map(p => p.key));

export function isPriority(key) {
  return BY_KEY.has(key);
}

export function getPriority(key) {
  return BY_KEY.get(key) || BY_KEY.get(DEFAULT_PRIORITY);
}

export function priorityLabel(key) {
  return getPriority(key).label;
}

export function priorityWeight(key) {
  return getPriority(key).weight;
}

export function priorityTone(key) {
  return getPriority(key).tone;
}

/** Tuntematon tai puuttuva arvo normalisoituu oletukseksi. */
export function normalizePriority(key) {
  return isPriority(key) ? key : DEFAULT_PRIORITY;
}

/**
 * Vertailufunktio prioriteetin mukaan: tärkein ensin.
 * Deterministinen — samanarvoiset säilyttävät keskinäisen järjestyksensä,
 * koska funktio palauttaa 0 ja Array.prototype.sort on vakaa.
 */
export function compareByPriority(a, b) {
  return priorityWeight(a.priority) - priorityWeight(b.priority);
}
