// Kuukausibudjetti.
//
// MITÄ TÄMÄ LASKEE JA MITÄ EI
//
// Tämä laskee VAIN siitä mitä käyttäjä on kirjannut. Se ei tiedä
// pankkitilin saldoa eikä voi tietää: Manifestivalilla ei ole
// pankkiyhteyttä. Luku joka näyttäisi saldolta mutta olisi arvaus,
// on pahempi kuin puuttuva luku.
//
// Siksi kolme lukua pidetään erillään, eikä niitä koskaan summata
// yhdeksi "saldoksi":
//
//   TOTEUMA     kirjatut tapahtumat -- tämä on tapahtunut
//   SITOUMUS    avoimet laskut -- tämä on tiedossa mutta maksamatta
//   ENNUSTE     toistuvat menot -- tämä on odotettavissa
//
// ---------------------------------------------------------------
// KAKSOISLASKENNAN ESTO
// ---------------------------------------------------------------
//
// Sama euro ei saa näkyä kahdesti. Kolme sääntöä:
//
//   1. Maksettu lasku, josta on tapahtuma, lasketaan TAPAHTUMANA.
//      Laskua ei lasketa erikseen. Ks. `hasTransactionFor`.
//
//   2. Maksettu lasku ILMAN tapahtumaa lasketaan laskuna. Näin
//      vanhat laskut, jotka on merkitty maksetuiksi ennen kuin
//      tapahtumia oli olemassa, eivät katoa budjetista.
//
//   3. Toistuva meno on ENNUSTE eikä koskaan toteuma. Se ei summaudu
//      toteutuneisiin menoihin missään tilanteessa.
//
// Siirrot jätetään pois sekä menoista että tuloista. Säästöön
// siirretty raha on yhä omaa.

import { isIsoDate } from './task.js';
import { normalizeMinor } from './money.js';
import {
  TRANSACTION_KIND, SOURCE_KIND, hasTransactionFor, isExpense, isIncome,
  isTransfer, transactionsInMonth
} from './transactions.js';
import { BILL_STATUS, isOpenBill, monthlyCostMinor } from './finance.js';

/** Kuukausitunniste 'YYYY-MM' päivästä. */
export function monthKey(dateIso) {
  return isIsoDate(dateIso) ? String(dateIso).slice(0, 7) : null;
}

/** Kuuluuko päivä kuukauteen? */
function inMonth(dateIso, month) {
  return typeof dateIso === 'string' && dateIso.slice(0, 7) === month;
}

/** Summaa kentän arvot sentteinä. */
function sumMinor(rows, pick) {
  let total = 0;
  for (const row of rows || []) {
    const value = normalizeMinor(pick(row));
    if (value !== null) total += value;
  }
  return total;
}

/**
 * Kuukauden budjettikuva.
 *
 * @param {object} input
 * @param {string} input.month              'YYYY-MM'
 * @param {Array}  input.transactions
 * @param {Array}  input.bills
 * @param {Array}  input.recurringExpenses
 * @param {string} [input.todayIso]
 */
export function summarizeMonth({
  month,
  transactions = [],
  bills = [],
  recurringExpenses = [],
  todayIso = null
} = {}) {
  const monthTransactions = transactionsInMonth(transactions, month);

  // ---------------------------------------------------------------
  // TOTEUMA — mitä on oikeasti tapahtunut
  // ---------------------------------------------------------------

  const incomeTransactions = monthTransactions.filter(isIncome);
  const expenseTransactions = monthTransactions.filter(isExpense);
  const transferTransactions = monthTransactions.filter(isTransfer);

  const incomeMinor = sumMinor(incomeTransactions, t => t.amountMinor);
  const expenseFromTransactionsMinor = sumMinor(expenseTransactions, t => t.amountMinor);
  const transferredMinor = sumMinor(transferTransactions, t => t.amountMinor);

  // Maksetut laskut, JOISTA EI OLE TAPAHTUMAA. Ne joista on, ovat jo
  // mukana yllä -- laskeminen tässäkin olisi juuri se kaksoislaskenta
  // jota koko moduuli varoo.
  const paidBillsWithoutTransaction = (bills || []).filter(bill =>
    bill
    && bill.status === BILL_STATUS.PAID
    && inMonth(bill.paidDate, month)
    && !hasTransactionFor(transactions, SOURCE_KIND.BILL, bill.id));

  const expenseFromBillsMinor = sumMinor(paidBillsWithoutTransaction, b => b.amountMinor);

  const actualExpenseMinor = expenseFromTransactionsMinor + expenseFromBillsMinor;

  // ---------------------------------------------------------------
  // SITOUMUS — tiedossa mutta maksamatta
  // ---------------------------------------------------------------

  const openBills = (bills || []).filter(bill =>
    isOpenBill(bill) && inMonth(bill.dueDate, month));

  const openBillsMinor = sumMinor(openBills, b => b.amountMinor);

  const overdueBills = todayIso
    ? openBills.filter(bill => typeof bill.dueDate === 'string' && bill.dueDate < todayIso)
    : [];

  // ---------------------------------------------------------------
  // ENNUSTE — odotettavissa, ei toteuma
  // ---------------------------------------------------------------

  const activeExpenses = (recurringExpenses || []).filter(e => e && e.active !== false);
  const recurringMonthlyMinor = activeExpenses
    .reduce((total, expense) => total + monthlyCostMinor(expense), 0);

  // ---------------------------------------------------------------
  // JOHDETUT LUVUT
  // ---------------------------------------------------------------

  /**
   * Jäljellä: tulot miinus toteutuneet menot.
   *
   * TÄMÄ EI OLE TILIN SALDO. Se on kuukauden kirjattu erotus, ja
   * käyttöliittymän on sanottava se.
   */
  const netMinor = incomeMinor - actualExpenseMinor;

  /**
   * Ennuste kuukauden lopuksi: toteuma miinus vielä maksamattomat
   * laskut. Toistuvia menoja EI vähennetä tästä, koska ne toteutuvat
   * laskuina tai tapahtumina -- muuten sama meno vähennettäisiin
   * kahdesti.
   */
  const projectedNetMinor = netMinor - openBillsMinor;

  return {
    month,

    /** TOTEUMA */
    incomeMinor,
    actualExpenseMinor,
    expenseFromTransactionsMinor,
    expenseFromBillsMinor,
    transferredMinor,
    netMinor,

    /** SITOUMUS */
    openBillsMinor,
    openBillCount: openBills.length,
    overdueBillCount: overdueBills.length,

    /** ENNUSTE */
    recurringMonthlyMinor,
    projectedNetMinor,

    /** Erittelyt */
    byCategory: expensesByCategory(expenseTransactions, paidBillsWithoutTransaction),
    transactionCount: monthTransactions.length,
    counts: {
      income: incomeTransactions.length,
      expense: expenseTransactions.length,
      transfer: transferTransactions.length,
      paidBillsWithoutTransaction: paidBillsWithoutTransaction.length
    }
  };
}

/**
 * Menot luokittain, sentteinä.
 *
 * Mukana ovat sekä menotapahtumat että ne maksetut laskut, joista ei
 * ole tapahtumaa -- täsmälleen sama joukko kuin `actualExpenseMinor`,
 * jotta erittely ja kokonaissumma eivät voi erota toisistaan.
 */
export function expensesByCategory(expenseTransactions, paidBillsWithoutTransaction = []) {
  const totals = {};

  for (const transaction of expenseTransactions || []) {
    if (!transaction || transaction.amountMinor === null) continue;
    const key = transaction.category || 'muu';
    totals[key] = (totals[key] || 0) + transaction.amountMinor;
  }

  for (const bill of paidBillsWithoutTransaction || []) {
    if (!bill || bill.amountMinor === null) continue;
    // Laskun oma kategoria on elämänalue ('talous'), ei kululuokka.
    // Kululuokkana lasku on lasku.
    totals.laskut = (totals.laskut || 0) + bill.amountMinor;
  }

  return totals;
}

/**
 * Luokat suuruusjärjestyksessä, osuus mukana.
 *
 * Osuus lasketaan kokonaismenoista. Jos menoja ei ole, osuus on nolla
 * eikä jakolaskua tehdä.
 */
export function categoryBreakdown(byCategory, totalMinor) {
  const total = normalizeMinor(totalMinor) ?? 0;
  return Object.entries(byCategory || {})
    .map(([category, amountMinor]) => ({
      category,
      amountMinor,
      percent: total > 0 ? Math.round((amountMinor / total) * 100) : 0
    }))
    .sort((a, b) => b.amountMinor - a.amountMinor || a.category.localeCompare(b.category));
}

/**
 * Käytettävissä oleva ylijäämä, sentteinä.
 *
 * Tulot miinus toteutuneet menot miinus avoimet laskut. Tämä on se
 * luku, jonka pohjalta säästöehdotus lasketaan -- ja se on
 * EHDOTUS, ei siirto.
 *
 * Ei koskaan negatiivinen: negatiivinen ylijäämä ei ole ylijäämää.
 */
export function surplusMinor(summary) {
  if (!summary) return 0;
  return Math.max(0, summary.projectedNetMinor);
}

/**
 * Kuukaudet, joilta on kirjauksia -- uusin ensin.
 *
 * Käyttöliittymä tarjoaa näitä kuukausivalitsimeen, jottei käyttäjä
 * selaa tyhjiä kuukausia.
 */
export function monthsWithData({ transactions = [], bills = [] } = {}) {
  const months = new Set();

  for (const transaction of transactions) {
    const month = monthKey(transaction && transaction.date);
    if (month) months.add(month);
  }
  for (const bill of bills) {
    const month = monthKey(bill && (bill.paidDate || bill.dueDate));
    if (month) months.add(month);
  }

  return [...months].sort().reverse();
}
