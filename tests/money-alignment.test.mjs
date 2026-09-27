// Raha suhteessa omaan aikaan ja tavoitteisiin: ostos työaikana,
// säästötavoitevertailu ja harkinnanvarainen käyttö omaan rajaan.
// Mukana myös negatiivisten summien muotoilu (money.formatMoney).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  purchaseInWork, savingsComparison, discretionaryStatus, workTimeText,
  MONEY_DISCRETIONARY_CATEGORIES, isDiscretionaryCategory, DISCRETIONARY_STATE
} from '../src/domain/moneyAlignment.js';
import { MONEY_RULES } from '../src/domain/dailyLifeSignalsPolicy.js';
import { EXPENSE_CATEGORY_KEYS } from '../src/domain/financeCategories.js';
import { summarizeMonth } from '../src/domain/budget.js';
import { formatMoney, formatTotals, MAX_MINOR } from '../src/domain/money.js';

const JUDGEMENT = /tuhla|liikaa|turha|huono|järjetön|pitäisi|häpe|vastuuton|kannattaa|suosit/i;

// ================================================================ TYÖAIKA

test('ostos työaikana: hinta / oma tunnin arvo, pyöristys minuutteihin', () => {
  const r = purchaseInWork({ priceMinor: 5000, currency: 'EUR', hourlyValueMinor: 2000, hourlyCurrency: 'EUR' });
  assert.equal(r.minutes, 150);
  assert.equal(r.hoursText, '2 h 30 min');
  assert.equal(r.text, 'Vastaa noin 2 h 30 min työtä oman tuntiarvosi mukaan.');
  assert.ok(Object.isFrozen(r));
  assert.equal(purchaseInWork({ priceMinor: 1000, hourlyValueMinor: 2000 }).hoursText, '30 min');
  assert.equal(purchaseInWork({ priceMinor: 4000, hourlyValueMinor: 2000 }).hoursText, '2 h');
  assert.equal(purchaseInWork({ priceMinor: 0, hourlyValueMinor: 2000 }).hoursText, '0 min', 'ilmainen on tieto');
  // 0,5 minuuttia pyöristyy ylöspäin (1), 0,49 alaspäin (0).
  assert.equal(purchaseInWork({ priceMinor: 25, hourlyValueMinor: 3000 }).minutes, 1);
  assert.equal(purchaseInWork({ priceMinor: 24, hourlyValueMinor: 3000 }).minutes, 0);
  assert.equal(purchaseInWork({ priceMinor: MAX_MINOR, hourlyValueMinor: 1 }).minutes, MAX_MINOR * 60, 'ei ylivuotoa');
});

test('ostos työaikana: tuntematon tai eri valuutta -> null', () => {
  assert.equal(purchaseInWork({ priceMinor: 5000, hourlyValueMinor: null }), null);
  assert.equal(purchaseInWork({ priceMinor: 5000, hourlyValueMinor: 0 }), null, 'nollalla ei jaeta');
  assert.equal(purchaseInWork({ priceMinor: null, hourlyValueMinor: 2000 }), null);
  assert.equal(purchaseInWork({ priceMinor: -5, hourlyValueMinor: 2000 }), null);
  assert.equal(purchaseInWork({ priceMinor: 5000, currency: 'USD', hourlyValueMinor: 2000, hourlyCurrency: 'EUR' }), null);
  assert.equal(purchaseInWork({ priceMinor: 5000, currency: 'usd', hourlyValueMinor: 2000, hourlyCurrency: 'USD' }).minutes, 150);
  for (const bad of [undefined, null, 5, 'x']) assert.equal(purchaseInWork(bad), null);
  assert.equal(workTimeText(-1), null);
  assert.equal(workTimeText(1.5), null);
});

// ================================================================ SÄÄSTÖT

const GOALS = [
  { id: 'g1', name: 'Matka', targetMinor: 200000, currentMinor: 150000, currency: 'EUR' },
  { id: 'g2', name: 'Auto', targetMinor: 1000000, currentMinor: 0, currency: 'EUR' },
  { id: 'g3', name: 'Dollarit', targetMinor: 10000, currentMinor: 0, currency: 'USD' },
  { id: 'g4', name: 'Valmis', targetMinor: 5000, currentMinor: 6000, currency: 'EUR' },
  { id: 'g5', name: 'Ääretön', targetMinor: null, currentMinor: 100, currency: 'EUR' }
];

test('säästövertailu: prosentti kunkin tavoitteen jäljellä olevasta summasta', () => {
  const rows = savingsComparison({ priceMinor: 5000, currency: 'EUR', savingsGoals: GOALS });
  assert.deepEqual(rows.map(r => r.name), ['Auto', 'Dollarit', 'Matka', 'Valmis', 'Ääretön'], 'suomen aakkoset (Ä lopussa)');
  const byId = Object.fromEntries(rows.map(r => [r.goalId, r]));
  assert.equal(byId.g1.remainingMinor, 50000);
  assert.equal(byId.g1.percentOfRemaining, 10);
  assert.equal(byId.g1.percentOfTarget, 3);
  assert.equal(byId.g1.text, 'Vastaa 10 % tavoitteen jäljellä olevasta summasta.');
  assert.equal(byId.g2.percentOfRemaining, 1);
  assert.equal(byId.g3.comparable, false);
  assert.equal(byId.g3.reason, 'currency');
  assert.equal(byId.g3.percentOfRemaining, null, 'eri valuuttaa ei muunneta');
  assert.equal(byId.g4.reached, true);
  assert.equal(byId.g4.percentOfRemaining, null);
  assert.equal(byId.g5.reason, 'no_target');
  assert.ok(Object.isFrozen(rows) && rows.every(Object.isFrozen));
});

test('säästövertailu: tuntematon hinta tai tavoitelista -> tyhjä lista', () => {
  assert.deepEqual(savingsComparison({ priceMinor: null, savingsGoals: GOALS }), []);
  assert.deepEqual(savingsComparison({ priceMinor: 100, savingsGoals: 'x' }), []);
  assert.deepEqual(savingsComparison(null), []);
  const big = savingsComparison({ priceMinor: 100000, savingsGoals: [GOALS[0]] });
  assert.equal(big[0].percentOfRemaining, 200, 'yli sadan prosentin vertailu näytetään sellaisenaan');
});

// ================================================================ HARKINNANVARAINEN

test('harkinnanvaraiset luokat: jäädytetty joukko, vain olemassa olevia kululuokkia', () => {
  assert.ok(Object.isFrozen(MONEY_DISCRETIONARY_CATEGORIES));
  assert.deepEqual([...MONEY_DISCRETIONARY_CATEGORIES].sort(), ['harrastukset', 'ostokset', 'viihde']);
  for (const key of MONEY_DISCRETIONARY_CATEGORIES) assert.ok(EXPENSE_CATEGORY_KEYS.includes(key), key);
  assert.throws(() => MONEY_DISCRETIONARY_CATEGORIES.add('asuminen'), TypeError);
  assert.throws(() => MONEY_DISCRETIONARY_CATEGORIES.delete('viihde'), TypeError);
  assert.throws(() => MONEY_DISCRETIONARY_CATEGORIES.clear(), TypeError);
  assert.equal(MONEY_DISCRETIONARY_CATEGORIES.size, 3);
  assert.equal(isDiscretionaryCategory('asuminen'), false);
  assert.equal(isDiscretionaryCategory('viihde'), true);
  assert.equal(isDiscretionaryCategory({}), false);
});

function month(expenses, extra = {}) {
  const transactions = expenses.map(([category, amountMinor], i) => ({
    id: `t${i}`, kind: 'expense', category, amountMinor, currency: 'EUR', date: '2026-06-10'
  }));
  return summarizeMonth({ month: '2026-06', transactions, ...extra });
}

const FIVE = [['viihde', 3000], ['ostokset', 4500], ['ruoka', 8000], ['harrastukset', 2500], ['asuminen', 90000]];

test('harkinnanvarainen käyttö: summarizeMonth-tulos, oma raja ja tila', () => {
  const summary = month(FIVE);
  assert.equal(summary.transactionCount, 5);
  const within = discretionaryStatus({ monthSummary: summary, declaredCapacityMinor: 20000, currency: 'EUR' });
  assert.equal(within.spentMinor, 10000);
  assert.deepEqual(within.categories.map(c => c.category), ['harrastukset', 'ostokset', 'viihde']);
  assert.equal(within.usedPercent, 50);
  assert.equal(within.remainingMinor, 10000);
  assert.equal(within.state, DISCRETIONARY_STATE.WITHIN);
  assert.match(within.text, /\(50 %\)\. Rajaan on 100,00/);
  assert.ok(Object.isFrozen(within) && Object.isFrozen(within.categories));

  // Raja-arvot: 90 % = lähellä, 89 % = sisällä, 100 % = raja täynnä.
  const near = discretionaryStatus({ monthSummary: summary, declaredCapacityMinor: Math.round(10000 / MONEY_RULES.NEAR_RATIO), currency: 'EUR' });
  assert.equal(near.state, DISCRETIONARY_STATE.NEAR);
  assert.equal(discretionaryStatus({ monthSummary: summary, declaredCapacityMinor: 11236, currency: 'EUR' }).state, DISCRETIONARY_STATE.WITHIN);
  const at = discretionaryStatus({ monthSummary: summary, declaredCapacityMinor: 10000, currency: 'EUR' });
  assert.equal(at.state, DISCRETIONARY_STATE.OVER);
  assert.equal(at.remainingMinor, 0);
  const over = discretionaryStatus({ monthSummary: summary, declaredCapacityMinor: 8000, currency: 'EUR' });
  assert.equal(over.usedPercent, 125);
  assert.doesNotMatch(over.text, /Rajaan on/);
});

test('harkinnanvarainen käyttö: ilman omaa rajaa vain kirjattu summa (tuntematon raja ei ole nolla)', () => {
  const r = discretionaryStatus({ monthSummary: month(FIVE), declaredCapacityMinor: null, currency: 'EUR' });
  assert.equal(r.state, DISCRETIONARY_STATE.NO_CAPACITY);
  assert.equal(r.capacityMinor, null);
  assert.equal(r.usedPercent, null);
  assert.equal(r.remainingMinor, null);
  assert.match(r.text, /kirjattu tässä kuussa 100,00/);
  const zero = discretionaryStatus({ monthSummary: month(FIVE), declaredCapacityMinor: 0, currency: 'EUR' });
  assert.equal(zero.state, DISCRETIONARY_STATE.OVER, 'oma raja 0 on tieto');
  assert.equal(zero.usedPercent, null, 'nollalla ei jaeta');
});

test('harkinnanvarainen käyttö: harva kuukausi ja valuuttaristiriita -> null', () => {
  assert.equal(discretionaryStatus({ monthSummary: month(FIVE.slice(0, MONEY_RULES.MIN_TRANSACTIONS - 1)), declaredCapacityMinor: 1000, currency: 'EUR' }), null);
  assert.notEqual(discretionaryStatus({ monthSummary: month(FIVE.slice(0, MONEY_RULES.MIN_TRANSACTIONS)), declaredCapacityMinor: 1000, currency: 'EUR' }), null);
  assert.equal(discretionaryStatus({ monthSummary: month(FIVE), declaredCapacityMinor: 1000, currency: 'EUR', mixedCurrencies: true }), null);
  assert.equal(discretionaryStatus({ monthSummary: month(FIVE), declaredCapacityMinor: 1000, currency: 'EUR', capacityCurrency: 'SEK' }), null);
  assert.equal(discretionaryStatus({ monthSummary: { ...month(FIVE), currency: 'USD' }, declaredCapacityMinor: 1000, currency: 'EUR' }), null);
  assert.equal(discretionaryStatus({ monthSummary: null, currency: 'EUR' }), null);
  for (const bad of [undefined, null, 1, 'x', { monthSummary: 'x' }, { monthSummary: { transactionCount: 'x' } }]) {
    assert.doesNotThrow(() => discretionaryStatus(bad));
  }
  const odd = discretionaryStatus({
    monthSummary: { transactionCount: 9, byCategory: { viihde: -5, ostokset: 'x', harrastukset: 700, asuminen: 1e12 } },
    declaredCapacityMinor: 'x', currency: 'EUR'
  });
  assert.equal(odd.spentMinor, 700);
  assert.equal(odd.state, DISCRETIONARY_STATE.NO_CAPACITY);
});

test('SÄVY: yksikään teksti ei arvota eikä neuvo', () => {
  const texts = [
    purchaseInWork({ priceMinor: 999999, hourlyValueMinor: 1500 }).text,
    ...savingsComparison({ priceMinor: 5000, savingsGoals: GOALS }).map(r => r.text)
  ];
  for (const capacity of [null, 0, 5000, 10000, 11000, 50000]) {
    texts.push(discretionaryStatus({ monthSummary: month(FIVE), declaredCapacityMinor: capacity, currency: 'EUR' }).text);
  }
  for (const text of texts) assert.doesNotMatch(text, JUDGEMENT, text);
});

test('DETERMINISMI ja syötteen koskemattomuus', () => {
  const goals = Object.freeze(GOALS.map(g => Object.freeze({ ...g })));
  const before = JSON.stringify(goals);
  const base = JSON.stringify(savingsComparison({ priceMinor: 5000, savingsGoals: goals }));
  for (let seed = 1; seed <= 12; seed += 1) {
    const mixed = [...goals];
    let x = seed;
    for (let i = mixed.length - 1; i > 0; i -= 1) {
      x = (x * 1103515245 + 12345) % 2147483648;
      const j = x % (i + 1);
      [mixed[i], mixed[j]] = [mixed[j], mixed[i]];
    }
    assert.equal(JSON.stringify(savingsComparison({ priceMinor: 5000, savingsGoals: mixed })), base);
  }
  assert.equal(JSON.stringify(goals), before);
});

// ================================================================ money.formatMoney

test('KORJAUS: negatiivinen summa muotoillaan miinusmerkillä, ei tyhjänä', () => {
  const text = formatMoney(-12995, 'EUR');
  assert.notEqual(text, '');
  assert.match(text, /129,95/);
  assert.match(text, /[−-]/, 'miinusmerkki näkyy');
  assert.match(text, /€/);
  assert.equal(formatMoney(-12995, 'EUR').replace(/[−-]/, ''), formatMoney(12995, 'EUR'));
  assert.match(formatMoney(-1, 'EUR'), /0,01/);
  assert.equal(formatMoney(-0.4, 'EUR'), formatMoney(0, 'EUR'), 'negatiivinen nolla on nolla');
  assert.doesNotMatch(formatMoney(-0.4, 'EUR'), /[−-]/);
  assert.match(formatMoney(-MAX_MINOR, 'EUR'), /10\s000\s000,00/);
  assert.equal(formatMoney(-MAX_MINOR - 1, 'EUR'), '', 'raja on sama molempiin suuntiin');
  assert.equal(formatMoney(MAX_MINOR + 1, 'EUR'), '');
  assert.match(formatMoney(-1000, 'XYZ'), /-10\.00 XYZ|XYZ/, 'tuntematon valuutta ei kaada');
  assert.equal(formatMoney(true), '', 'totuusarvo ei ole summa');
  assert.equal(formatMoney(null), '');
  assert.equal(formatMoney('roskaa'), '');
  // Salkun tappio ja kuukauden miinus näkyvät nyt kokonaissummissa.
  const totals = formatTotals({ EUR: -5000, USD: 900 });
  assert.equal(totals.length, 2);
  assert.ok(totals.every(t => t.length > 0));
});
