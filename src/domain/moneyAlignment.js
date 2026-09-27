// Raha suhteessa omaan aikaan ja omiin tavoitteisiin.
//
// PUHDAS MODUULI: ei kelloa, ei DOM:ia, ei verkkoa.
//
// KUVAA, EI ARVOTA
//
// "Tämä vastaa noin 2 h 30 min työtä" ja "12 % säästötavoitteen
// jäljellä olevasta summasta" ovat mittasuhteita, eivät tuomioita.
// Moduuli ei sano, onko ostos järkevä, eikä käytä sanoja kuten
// "tuhlaus" tai "liikaa". Vertailukohta on aina käyttäjän oma luku:
// itse ilmoitettu tunnin arvo (life_settings.hourly_value_minor), omat
// säästötavoitteet ja itse ilmoitettu harkinnanvarainen kuukausiraja.
// Ilman omaa lukua ei ole vertailua — vain kirjattu summa.
//
// SÄÄNNÖT money.js:stä
//
//   - raha on kokonaislukuja sentteinä
//   - valuuttoja ei summata eikä muunneta: eri valuutta = ei vertailua (null)
//   - tuntematon on null, ei nolla
//
// Harkinnanvarainen käyttö luetaan budget.summarizeMonth-tuloksesta
// (byCategory). Harvasta kuukaudesta (alle MONEY_RULES.MIN_TRANSACTIONS
// kirjausta) ei sanota mitään: kolmesta kuitista ei näe kuukautta.

import { normalizeMinor, normalizeCurrency, formatMoney, remainingMinor, MAX_MINOR } from './money.js';
import { MONEY_RULES } from './dailyLifeSignalsPolicy.js';
import { formatDuration } from '../lib/format.js';

const collator = new Intl.Collator('fi');

/** Hajotettava olio: null, luku tai merkkijono ei kaada funktiota. */
const argsOf = value => (value !== null && typeof value === 'object' ? value : {});

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Muuttumaton joukko: `has`, `size` ja iterointi toimivat; muuttaminen
 * heittää TypeErrorin kuten jäädytetyn olion kenttään kirjoittaminen.
 * (Object.freeze(new Set()) ei estäisi add-kutsua.)
 */
function frozenSet(values) {
  const set = new Set(values);
  const refuse = () => {
    throw new TypeError('Joukko on lukittu.');
  };
  set.add = refuse;
  set.delete = refuse;
  set.clear = refuse;
  return Object.freeze(set);
}

/**
 * Harkinnanvaraiset kululuokat (financeCategories.EXPENSE_CATEGORIES).
 *
 * Mukana: harrastukset, ostokset, viihde. EI mukana: asuminen, ruoka,
 * liikkuminen, auto, terveys, vakuutukset, laskut, lapset, työ,
 * säästäminen, sijoittaminen, muu — ne ovat pakollisia, rahan siirtoa
 * itselle tai liian epämääräisiä ("muu") luokiteltaviksi.
 */
export const MONEY_DISCRETIONARY_CATEGORIES = frozenSet(['harrastukset', 'ostokset', 'viihde']);

export function isDiscretionaryCategory(key) {
  return typeof key === 'string' && MONEY_DISCRETIONARY_CATEGORIES.has(key);
}

export const DISCRETIONARY_STATE = Object.freeze({
  /** Omaa rajaa ei ole ilmoitettu: näytetään vain kirjattu summa. */
  NO_CAPACITY: 'no_capacity',
  WITHIN: 'within',
  /** Vähintään MONEY_RULES.NEAR_RATIO omasta rajasta käytetty. */
  NEAR: 'near',
  /** Kirjattu käyttö on vähintään oma raja. */
  OVER: 'over'
});

/** Minuutit luettavaksi: 45 -> '45 min', 150 -> '2 h 30 min', 0 -> '0 min'. */
export function workTimeText(minutes) {
  if (!Number.isInteger(minutes) || minutes < 0) return null;
  return formatDuration(minutes) || '0 min';
}

/**
 * Ostos työaikana: hinta / oma tunnin arvo.
 *
 * @returns {{minutes:number, hoursText:string, text:string}|null}
 *   null, kun hinta tai tunnin arvo puuttuu, tunnin arvo on 0 tai
 *   valuutat eroavat (ilman kurssia vertailu olisi arvaus)
 */
export function purchaseInWork(input) {
  const { priceMinor, currency, hourlyValueMinor, hourlyCurrency } = argsOf(input);
  const price = normalizeMinor(priceMinor);
  const hourly = normalizeMinor(hourlyValueMinor);
  if (price === null || hourly === null || hourly === 0) return null;
  if (normalizeCurrency(currency) !== normalizeCurrency(hourlyCurrency)) return null;
  const minutes = Math.round((price * 60) / hourly);
  const hoursText = workTimeText(minutes);
  return Object.freeze({
    minutes,
    hoursText,
    text: `Vastaa noin ${hoursText} työtä oman tuntiarvosi mukaan.`
  });
}

/**
 * Ostoksen hinta suhteessa kunkin säästötavoitteen jäljellä olevaan summaan.
 *
 * Eri valuutassa oleva tai tavoitesummaton tavoite ei ole vertailukelpoinen
 * (prosentti null, syy kerrotaan). Täyttyneen tavoitteen jäljellä oleva
 * summa on 0, jolloin prosenttia ei lasketa.
 *
 * @returns {ReadonlyArray<object>} tavoitteen nimen mukaan (suomen aakkoset)
 */
export function savingsComparison(input) {
  const { priceMinor, currency, savingsGoals } = argsOf(input);
  const price = normalizeMinor(priceMinor);
  if (price === null || !Array.isArray(savingsGoals)) return Object.freeze([]);
  const code = normalizeCurrency(currency);
  const rows = [];
  for (const goal of savingsGoals) {
    if (!isObject(goal)) continue;
    const goalCurrency = normalizeCurrency(goal.currency);
    const target = normalizeMinor(goal.targetMinor);
    const current = normalizeMinor(goal.currentMinor) ?? 0;
    const name = typeof goal.name === 'string' ? goal.name.trim().slice(0, 200) : '';
    const id = goal.id != null ? String(goal.id).slice(0, 200) : null;
    let reason = null;
    if (goalCurrency !== code) reason = 'currency';
    else if (target === null || target === 0) reason = 'no_target';
    const remaining = reason === null ? remainingMinor(current, target) : null;
    const reached = reason === null && remaining === 0;
    const percentOfRemaining = reason === null && remaining > 0 ? Math.round((price / remaining) * 100) : null;
    const percentOfTarget = reason === null ? Math.round((price / target) * 100) : null;
    let text = null;
    if (reason === 'currency') text = 'Eri valuutta: vertailua ei tehdä.';
    else if (reason === 'no_target') text = 'Tavoitesummaa ei ole asetettu.';
    else if (reached) text = 'Tavoite on jo täynnä.';
    else text = `Vastaa ${percentOfRemaining} % tavoitteen jäljellä olevasta summasta.`;
    rows.push(Object.freeze({
      goalId: id,
      name,
      currency: goalCurrency,
      comparable: reason === null,
      reason,
      remainingMinor: remaining,
      percentOfRemaining,
      percentOfTarget,
      reached,
      text
    }));
  }
  rows.sort((a, b) => collator.compare(a.name, b.name)
    || (a.goalId === b.goalId ? 0 : a.goalId === null ? 1 : b.goalId === null ? -1 : collator.compare(a.goalId, b.goalId)));
  return Object.freeze(rows);
}

/**
 * Harkinnanvarainen käyttö kuukaudessa suhteessa omaan rajaan.
 *
 * @param {object} input
 * @param {object} input.monthSummary budget.summarizeMonth-tulos
 * @param {number|null} input.declaredCapacityMinor käyttäjän oma kuukausiraja tai null
 * @param {string} input.currency kuukauden valuutta (summarizeMonth ei kanna valuuttaa)
 * @param {string} [input.capacityCurrency] rajan valuutta, oletus = currency
 * @param {boolean} [input.mixedCurrencies] kuukauden kirjauksissa useampi valuutta
 * @returns {object|null} null, kun kuukausi puuttuu, kirjauksia on liian vähän
 *   tai valuutat eivät täsmää
 */
export function discretionaryStatus(input) {
  const {
    monthSummary, declaredCapacityMinor = null, currency, capacityCurrency, mixedCurrencies = false
  } = argsOf(input);
  if (!isObject(monthSummary) || mixedCurrencies === true) return null;
  const code = normalizeCurrency(currency);
  if (typeof monthSummary.currency === 'string' && normalizeCurrency(monthSummary.currency) !== code) return null;
  const capacityCode = capacityCurrency === undefined || capacityCurrency === null
    ? code
    : normalizeCurrency(capacityCurrency);
  if (capacityCode !== code) return null;

  const transactionCount = Number.isInteger(monthSummary.transactionCount) ? monthSummary.transactionCount : 0;
  if (transactionCount < MONEY_RULES.MIN_TRANSACTIONS) return null;

  const categories = [];
  let spentMinor = 0;
  const byCategory = isObject(monthSummary.byCategory) ? monthSummary.byCategory : {};
  for (const key of Object.keys(byCategory).sort()) {
    if (!isDiscretionaryCategory(key)) continue;
    const amount = normalizeMinor(byCategory[key]);
    if (amount === null) continue;
    spentMinor += amount;
    categories.push(Object.freeze({ category: key, amountMinor: amount }));
  }
  // Yli kymmenen miljoonan euron harkinnanvarainen kuukausi on kirjausvirhe,
  // ei tieto, jonka varaan kannattaisi sanoa mitään.
  if (spentMinor > MAX_MINOR) return null;

  const capacityMinor = normalizeMinor(declaredCapacityMinor);
  let state;
  let usedPercent = null;
  let remaining = null;
  if (capacityMinor === null) {
    state = DISCRETIONARY_STATE.NO_CAPACITY;
  } else {
    remaining = Math.max(0, capacityMinor - spentMinor);
    usedPercent = capacityMinor > 0 ? Math.round((spentMinor / capacityMinor) * 100) : null;
    if (spentMinor >= capacityMinor && (capacityMinor > 0 || spentMinor > 0)) state = DISCRETIONARY_STATE.OVER;
    else if (capacityMinor > 0 && spentMinor >= capacityMinor * MONEY_RULES.NEAR_RATIO) state = DISCRETIONARY_STATE.NEAR;
    else state = DISCRETIONARY_STATE.WITHIN;
  }

  const spentText = formatMoney(spentMinor, code);
  let text;
  if (state === DISCRETIONARY_STATE.NO_CAPACITY) {
    text = `Harkinnanvaraisia menoja on kirjattu tässä kuussa ${spentText}.`;
  } else {
    text = `Harkinnanvaraisia menoja ${spentText}, oma kuukausirajasi ${formatMoney(capacityMinor, code)}`;
    text += usedPercent !== null ? ` (${usedPercent} %).` : '.';
    if (state !== DISCRETIONARY_STATE.OVER) text += ` Rajaan on ${formatMoney(remaining, code)}.`;
  }

  return Object.freeze({
    month: typeof monthSummary.month === 'string' ? monthSummary.month : null,
    currency: code,
    transactionCount,
    spentMinor,
    capacityMinor,
    remainingMinor: remaining,
    usedPercent,
    state,
    categories: Object.freeze(categories),
    text
  });
}
