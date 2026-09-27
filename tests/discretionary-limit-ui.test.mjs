// Talous → Budjetti: "Harkinnanvarainen käyttö" (src/app/views/discretionaryLimit.js)
// ja rahan arvion tekstit (dailyLifeSignals.moneyOverload / evaluationText).
//
// MITÄ TÄMÄ VARTIOI
//
// - Vertailukohta on AINA käyttäjän oma kuukausiraja; ilman sitä näytetään
//   vain kirjattu summa, eikä mitään verrata.
// - Harva kuukausi (alle MONEY_RULES.MIN_TRANSACTIONS kirjausta) ja eri
//   valuutat ovat tuntemattomia, eivät "rajassa".
// - Kuvaa, ei arvota: ei sanoja "liikaa", "tuhlaus", "pitäisi".
// - Raja tallentuu käyttäjäkohtaisena laitteelle; toinen käyttäjä ei peri
//   sitä, ja muistiin jäänyt roska ei muutu rajaksi.
// - Rajaa ei lokiteta eikä lähetetä tekoälylle.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDocument, installDocument, type, assertSameNode } from './helpers/a11yDom.mjs';
import { readCode } from './helpers/sources.mjs';
import { setUser, clearUser } from '../src/data/session.js';
import { clearAllCollections } from '../src/data/collectionsRepo.js';
import { setUserPreference, getUserPreference, purgeUserPreferences } from '../src/data/preferences.js';
import { resetState, getState, subscribe, setTransactions, setBudgetMonth } from '../src/app/state.js';
import {
  renderDiscretionaryLimit, initDiscretionaryLimit, resetDiscretionaryLimit, discretionaryModel,
  discretionaryMonthInput, discretionaryReviewInput, readDiscretionaryLimit, saveDiscretionaryLimit, parseLimit
} from '../src/app/views/discretionaryLimit.js';
import {
  moneyOverload, evaluationText, EVALUATION_STATUS
} from '../src/domain/dailyLifeSignals.js';
import { MONEY_RULES } from '../src/domain/dailyLifeSignalsPolicy.js';
import { summarizeMonth } from '../src/domain/budget.js';

const USER = { id: 'dddddddd-2222-4222-8222-0000000000dd', email: 'raja@example.invalid' };
const OTHER = { id: 'dddddddd-3333-4333-8333-0000000000de', email: 'toinen@example.invalid' };
const MONTH = '2026-09';
const TONE = /tuhla|liikaa|pitäisi|huono|kannattaa|epäonnist|holtit/i;

const expense = (id, category, amountMinor, extra = {}) => ({
  id, kind: 'expense', category, amountMinor, currency: 'EUR', date: `${MONTH}-10`, ...extra
});
/** Viisi kirjausta: 180 € harkinnanvaraista (viihde, ostokset), 900 € asumista. */
const FIVE = [
  expense('t1', 'viihde', 4000), expense('t2', 'ostokset', 8000), expense('t3', 'harrastukset', 6000),
  expense('t4', 'asuminen', 90000), expense('t5', 'ruoka', 0)
];

function withStorage(t) {
  const uninstall = installDocument(createDocument('<main></main>'));
  t.after(() => { uninstall(); clearUser(); });
}

function mount(t) {
  clearUser();
  clearAllCollections();
  resetState();
  resetDiscretionaryLimit();
  const doc = createDocument('<main><section id="host" aria-label="Budjetti"></section></main>');
  const uninstall = installDocument(doc);
  setUser(USER);
  setBudgetMonth(MONTH);
  const container = doc.getElementById('host');
  initDiscretionaryLimit(container);
  const unsubscribe = subscribe(() => renderDiscretionaryLimit(container));
  renderDiscretionaryLimit(container);
  t.after(() => {
    unsubscribe();
    resetDiscretionaryLimit();
    uninstall();
    clearUser();
  });
  return { doc, container, byId: id => doc.getElementById(id), text: () => container.textContent.replace(/\s+/g, ' ') };
}

// ================================================================ DOMAIN: tekstit

test('raha: tuntemattoman syy kerrotaan — harva kuukausi, sekavaluutta, eri valuutta', () => {
  const sparse = moneyOverload({
    monthSummary: summarizeMonth({ month: MONTH, transactions: FIVE.slice(0, 2) }), declaredCapacityMinor: 20000, currency: 'EUR'
  });
  assert.equal(sparse.status, EVALUATION_STATUS.INSUFFICIENT_DATA);
  assert.equal(sparse.reason, 'few_transactions');
  assert.deepEqual({ ...sparse.metrics }, { month: MONTH, transactionCount: 2 });
  assert.equal(evaluationText(sparse),
    `Kuukaudelta on kirjattu vasta 2 tapahtumaa (vertailuun tarvitaan vähintään ${MONEY_RULES.MIN_TRANSACTIONS}), joten tätä ei vielä tiedetä.`);

  const summary = summarizeMonth({ month: MONTH, transactions: FIVE });
  const mixed = moneyOverload({ monthSummary: summary, declaredCapacityMinor: 20000, currency: 'EUR', mixedCurrencies: true });
  assert.equal(mixed.reason, 'mixed_currencies');
  assert.match(evaluationText(mixed), /useita valuuttoja, joten vertailua omaan rajaan ei tehdä\.$/);
  const mismatch = moneyOverload({ monthSummary: summary, declaredCapacityMinor: 20000, currency: 'EUR', capacityCurrency: 'SEK' });
  assert.equal(mismatch.reason, 'currency_mismatch');
  assert.match(evaluationText(mismatch), /eri valuutassa/);
  assert.equal(moneyOverload({ declaredCapacityMinor: 100, currency: 'EUR' }).reason, 'no_month');

  for (const e of [sparse, mixed, mismatch]) {
    for (const key of Object.keys(e.metrics)) assert.doesNotMatch(key, /minor|amount|cents/i, key);
  }
});

test('raha: selvä ja havainto prosentteina omasta rajasta; ilman rajaa ei verrata; ei arvottavia sanoja', () => {
  const summary = summarizeMonth({ month: MONTH, transactions: FIVE });
  const clear = moneyOverload({ monthSummary: summary, declaredCapacityMinor: 60000, currency: 'EUR' });
  assert.equal(clear.status, EVALUATION_STATUS.CLEAR);
  assert.equal(evaluationText(clear), 'Harkinnanvaraisia menoja on kirjattu 30 % omasta kuukausirajastasi.');
  const near = moneyOverload({ monthSummary: summary, declaredCapacityMinor: 20000, currency: 'EUR' });
  assert.equal(near.status, EVALUATION_STATUS.SIGNAL);
  assert.equal(evaluationText(near), 'Harkinnanvaraisia menoja on kirjattu 90 % omasta kuukausirajastasi.');
  const none = moneyOverload({ monthSummary: summary, declaredCapacityMinor: null, currency: 'EUR' });
  assert.equal(none.status, EVALUATION_STATUS.NO_REFERENCE);
  assert.match(evaluationText(none), /^Omaa harkinnanvaraista kuukausirajaa ei ole asetettu \(Talous → Budjetti\), joten rahankäyttöä ei verrata mihinkään\.$/);
  const zero = moneyOverload({
    monthSummary: summarizeMonth({ month: MONTH, transactions: FIVE.filter(t => t.category === 'asuminen' || t.category === 'ruoka')
      .concat([expense('t6', 'laskut', 100), expense('t7', 'laskut', 100), expense('t8', 'laskut', 100)]) }),
    declaredCapacityMinor: 0, currency: 'EUR'
  });
  assert.equal(zero.status, EVALUATION_STATUS.CLEAR);
  assert.equal(evaluationText(zero), 'Harkinnanvaraisia menoja ei ole kirjattu, ja oma kuukausirajasi on 0.');
  for (const e of [clear, near, none, zero]) {
    assert.doesNotMatch(evaluationText(e), TONE);
    assert.doesNotMatch(evaluationText(e), /€|\d+,\d\d/, 'katsauksen tekstissä ei euromääriä');
  }
});

// ================================================================ RAJA LAITTEELLA

test('raja: käyttäjäkohtainen, muoto tarkistetaan, tyhjä poistaa, tilin poisto poistaa', t => {
  withStorage(t);
  setUser(USER);
  assert.equal(readDiscretionaryLimit(), null);
  assert.equal(saveDiscretionaryLimit(20000, 'eur'), true);
  assert.deepEqual({ ...readDiscretionaryLimit() }, { minor: 20000, currency: 'EUR' });
  assert.equal(readDiscretionaryLimit(OTHER.id), null, 'toinen käyttäjä ei peri rajaa');
  for (const garbage of [5, 'x', [], { minor: -1, currency: 'EUR' }, { minor: 1.5, currency: 'EUR' },
    { minor: 100, currency: 'euro' }, { minor: 2e9, currency: 'EUR' }]) {
    setUserPreference(USER.id, 'discretionaryLimit', garbage);
    assert.equal(readDiscretionaryLimit(), null, JSON.stringify(garbage));
  }
  assert.equal(saveDiscretionaryLimit(20000, 'EUR'), true);
  assert.equal(saveDiscretionaryLimit(-5, 'EUR'), false);
  assert.equal(saveDiscretionaryLimit(null), true);
  assert.equal(getUserPreference(USER.id, 'discretionaryLimit'), null);
  saveDiscretionaryLimit(20000, 'EUR');
  purgeUserPreferences(USER.id);
  assert.equal(readDiscretionaryLimit(), null);
});

test('raja: syöte euroina; tyhjä = poista; nolla on oma valinta; teksti on virhe', () => {
  assert.deepEqual(parseLimit(''), { value: null });
  assert.deepEqual(parseLimit('200'), { value: 20000 });
  assert.deepEqual(parseLimit('199,90'), { value: 19990 });
  assert.deepEqual(parseLimit('0'), { value: 0 });
  assert.ok(parseLimit('paljon').error);
  assert.ok(parseLimit('-5').error);
});

test('kuukauden syöte: eri valuutan harkinnanvarainen meno tekee kuukaudesta sekavaluuttaisen', t => {
  withStorage(t);
  setUser(USER);
  resetState();
  setTransactions([...FIVE, expense('u1', 'asuminen', 5000, { currency: 'USD' })]);
  const limit = { minor: 20000, currency: 'EUR' };
  assert.equal(discretionaryMonthInput({ month: MONTH, state: getState(), limit }).mixedCurrencies, false,
    'pakollinen meno toisessa valuutassa ei estä vertailua');
  setTransactions([...FIVE, expense('u2', 'viihde', 5000, { currency: 'USD' })]);
  const input = discretionaryMonthInput({ month: MONTH, state: getState(), limit });
  assert.equal(input.mixedCurrencies, true);
  assert.equal(input.declaredCapacityMinor, 20000);
  assert.equal(input.currency, 'EUR');

  resetState();
  assert.equal(discretionaryReviewInput({ month: MONTH, state: getState() }), null, 'ei rajaa eikä tapahtumia -> ei riviä');
  saveDiscretionaryLimit(20000, 'EUR');
  assert.notEqual(discretionaryReviewInput({ month: MONTH, state: getState() }), null, 'oma raja -> rivi');
});

// ================================================================ NÄKYMÄ

test('näkymä: ilman rajaa vain kirjattu summa; harva kuukausi sanotaan; raja tallentuu ja vertailu näkyy', t => {
  const view = mount(t);
  assert.match(view.text(), /Kuukaudelta on kirjattu 0 tapahtumaa\. Vertailu tehdään, kun kirjauksia on vähintään 5/);
  setTransactions(FIVE);
  assert.match(view.text(), /Harkinnanvaraisia menoja on kirjattu tässä kuussa 180,00\s€\./);
  assert.doesNotMatch(view.text(), /kuukausirajasi 0/, 'ei keksittyä rajaa');

  const field = view.byId('dlLimit');
  field.focus();
  type(field, '200');
  assertSameNode(view.doc.activeElement, view.byId('dlLimit'), 'näppäily ei piirrä kenttää uudelleen');
  view.byId('dlSave').click();
  assert.deepEqual({ ...readDiscretionaryLimit() }, { minor: 20000, currency: 'EUR' });
  assert.match(view.text(), /Raja tallennettu\./);
  assert.match(view.text(), /Harkinnanvaraisia menoja 180,00\s€, oma kuukausirajasi 200,00\s€ \(90 %\)\. Rajaan on 20,00\s€\./);
  assert.equal(view.byId('dlLimit').value, '200,00');
  assert.doesNotMatch(view.text(), TONE);
  assert.equal(discretionaryModel({ state: getState(), month: MONTH }).status.state, 'near');
});

test('näkymä: virheellinen raja -> virhe kentän alla (role=alert, aria-invalid); tyhjä poistaa rajan', t => {
  const view = mount(t);
  setTransactions(FIVE);
  type(view.byId('dlLimit'), 'paljon');
  view.byId('dlSave').click();
  assert.equal(view.byId('dlLimitError').getAttribute('role'), 'alert');
  assert.match(view.byId('dlLimitError').textContent, /Anna raja euroina/);
  assert.equal(view.byId('dlLimit').getAttribute('aria-invalid'), 'true');
  assert.equal(readDiscretionaryLimit(), null);

  type(view.byId('dlLimit'), '150');
  view.byId('dlSave').click();
  assert.equal(readDiscretionaryLimit().minor, 15000);
  assert.equal(view.byId('dlLimitError'), null);
  type(view.byId('dlLimit'), '');
  view.byId('dlSave').click();
  assert.equal(readDiscretionaryLimit(), null);
  assert.match(view.text(), /Raja poistettu\./);
});

test('uloskirjautuminen tyhjentää luonnoksen; rajaa ei lokiteta eikä lähetetä tekoälylle', t => {
  const view = mount(t);
  type(view.byId('dlLimit'), '999');
  resetDiscretionaryLimit();
  renderDiscretionaryLimit(view.container);
  assert.equal(view.byId('dlLimit').value, '');
  const code = readCode('src/app/views/discretionaryLimit.js');
  assert.equal(/logEvent|logFailure|console\./.test(code), false, 'raja ei päädy lokiin');
  for (const file of ['src/ai/alignmentContext.js', 'src/ai/alignmentExplainClient.js', 'src/domain/alignmentReview.js']) {
    assert.equal(/discretionary/i.test(readCode(file)), false, file);
  }
  const main = readCode('src/app/main.js');
  assert.match(main, /resetDiscretionaryLimit\(\)/);
  assert.match(main, /initDiscretionaryLimit\(\)/);
  assert.match(readCode('src/app/views/finance.js'), /renderDiscretionaryLimit\(\)/);
});
