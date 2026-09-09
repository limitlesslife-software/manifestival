// Yhtenäinen tapahtumamalli: meno, tulo ja siirto.
//
// MIKSI YKSI MALLI KOLMEN SIJASTA
//
// Talous 1.0:ssa oli kolme erillistä käsitettä — lasku, toistuva meno
// ja säästötavoite — eikä yhtään paikkaa, johon tavallinen ostos olisi
// mahtunut. Kuukauden todellista rahankäyttöä ei voinut laskea, koska
// suurin osa siitä ei ollut missään.
//
// Tapahtuma on se yksi paikka. Lasku ja kuitti eivät ole eri
// talousmalleja vaan eri LÄHTEITÄ samalle taloudelliselle
// tapahtumalle.
//
// ---------------------------------------------------------------
// KAKSOISLASKENNAN ESTO — TÄMÄN MODUULIN TÄRKEIN TEHTÄVÄ
// ---------------------------------------------------------------
//
// Sama euro ei saa näkyä kahdesti. Se on helpompi rikkoa kuin
// huomata: budjetti näyttäisi uskottavalta ja olisi silti väärä.
//
// Kolme sääntöä, ja jokainen niistä on testattu:
//
//   1. LÄHDE OMISTAA TAPAHTUMAN.
//      Kun lasku merkitään maksetuksi, syntyy tapahtuma, jonka
//      `sourceKind` on 'bill' ja `sourceId` on laskun tunniste.
//      Budjetti laskee laskun kuluksi VAIN jos siitä ei ole
//      tapahtumaa. Kumpi tahansa, ei molemmat.
//
//      Yhteys on TUNNISTE, ei summa eikä kuvaus. Kaksi 45,50 euron
//      sähkölaskua samana päivänä ovat eri laskuja, eikä mikään
//      heuristiikka erota niitä luotettavasti.
//
//   2. TOISTUVA MENO ON ENNUSTE, EI TOTEUMA.
//      Se ei koskaan ole toteutunut kulu. Se kertoo mitä on tulossa.
//      Toteuma syntyy vasta laskusta tai tapahtumasta.
//
//   3. SIIRTO EI OLE KULUTUSTA EIKÄ TULOA.
//      Säästötilille siirretty raha ei katoa — se on yhä omaa. Siirto
//      jätetään sekä meno- että tulosummista pois. Jos se laskettaisiin
//      menoksi, säästäminen näyttäisi köyhdyttävän.

import { isIsoDate } from './task.js';
import { normalizeMinor, normalizeCurrency } from './money.js';
import {
  normalizeExpenseCategory, normalizeIncomeCategory
} from './financeCategories.js';

/** Tapahtumalaji. Ratkaisee etumerkin ja sen, lasketaanko mukaan. */
export const TRANSACTION_KIND = Object.freeze({
  /** Kulutus ulos: ostos, lasku, maksu. */
  EXPENSE: 'expense',
  /** Rahaa sisään: palkka, palautus, lahja. */
  INCOME: 'income',
  /**
   * Rahan siirto omasta paikasta toiseen.
   *
   * EI kulutusta eikä tuloa. Säästöön siirretty raha on yhä omaa.
   */
  TRANSFER: 'transfer'
});

export const TRANSACTION_KINDS = Object.freeze(Object.values(TRANSACTION_KIND));

/**
 * Mistä tapahtuma syntyi.
 *
 * Alkuperä ei ole koristetta: se kertoo kenen kanssa tapahtuma jakaa
 * saman taloudellisen tosiasian, ja juuri se estää kaksoislaskennan.
 */
export const TRANSACTION_ORIGIN = Object.freeze({
  /** Käyttäjä kirjasi käsin. */
  MANUAL: 'manual',
  /** Syntyi hyväksytystä kuitista. */
  RECEIPT: 'receipt',
  /** Syntyi laskun maksumerkinnästä. */
  BILL: 'bill',
  /** Syntyi toistuvasta menosta kirjatusta toteumasta. */
  RECURRING: 'recurring',
  /** Siirto säästötavoitteeseen. */
  SAVINGS: 'savings',
  /** Sijoitukseen liittyvä rahaliike. */
  INVESTMENT: 'investment'
});

export const TRANSACTION_ORIGINS = Object.freeze(Object.values(TRANSACTION_ORIGIN));

/**
 * Lähdetietue, johon tapahtuma on sidottu.
 *
 * `null` tarkoittaa itsenäistä tapahtumaa, jolla ei ole lähdettä.
 */
export const SOURCE_KIND = Object.freeze({
  BILL: 'bill',
  RECURRING_EXPENSE: 'recurring_expense',
  SAVINGS_GOAL: 'savings_goal',
  RECEIPT: 'receipt',
  INVESTMENT: 'investment'
});

export const SOURCE_KINDS = Object.freeze(Object.values(SOURCE_KIND));

const MAX_DESCRIPTION = 200;
const MAX_NOTE = 500;

function cleanText(value, maxLength) {
  if (value == null) return null;
  const trimmed = String(value).trim().slice(0, maxLength);
  return trimmed === '' ? null : trimmed;
}

/**
 * Normalisoi tapahtuma.
 *
 * Summa on AINA positiivinen kokonaisluku senttejä. Suunta tulee
 * lajista, ei etumerkistä: negatiivinen tulo ja positiivinen meno
 * olisivat kaksi tapaa sanoa sama asia, ja kahdesta tavasta seuraa
 * ennemmin tai myöhemmin kolmas.
 */
export function normalizeTransaction(input = {}) {
  const kind = TRANSACTION_KINDS.includes(input.kind)
    ? input.kind
    : TRANSACTION_KIND.EXPENSE;

  const origin = TRANSACTION_ORIGINS.includes(input.origin)
    ? input.origin
    : TRANSACTION_ORIGIN.MANUAL;

  const sourceKind = SOURCE_KINDS.includes(input.sourceKind) ? input.sourceKind : null;

  // Lähdetunniste ilman lähdelajia ei tarkoita mitään, eikä lähdelaji
  // ilman tunnistetta osoita mihinkään. Kumpikin tarvitsee toisen.
  const sourceId = sourceKind && input.sourceId != null ? String(input.sourceId) : null;

  const category = kind === TRANSACTION_KIND.INCOME
    ? normalizeIncomeCategory(input.category)
    : kind === TRANSACTION_KIND.TRANSFER
      ? null
      : normalizeExpenseCategory(input.category);

  return {
    id: input.id != null ? String(input.id) : null,
    kind,
    origin,
    /** SENTTEINÄ, aina positiivinen. Ks. src/domain/money.js. */
    amountMinor: normalizeMinor(input.amountMinor),
    currency: normalizeCurrency(input.currency),
    /** Päivä jona raha liikkui. Päivä, ei aikaleima. */
    date: isIsoDate(input.date) ? input.date : null,
    category,
    description: cleanText(input.description, MAX_DESCRIPTION),
    note: cleanText(input.note, MAX_NOTE),
    sourceKind: sourceId ? sourceKind : null,
    sourceId,
    createdAt: input.createdAt ?? null,
    updatedAt: input.updatedAt ?? null
  };
}

export function validateTransaction(transaction) {
  const errors = {};

  if (!transaction.date) errors.date = 'Anna päivämäärä.';

  if (transaction.amountMinor === null) errors.amountMinor = 'Anna summa.';
  else if (transaction.amountMinor <= 0) {
    // Nollan suuruinen rahaliike ei ole tapahtuma, ja negatiivinen
    // olisi toinen tapa ilmaista suunta -- suunta tulee lajista.
    errors.amountMinor = 'Summan pitää olla suurempi kuin nolla.';
  }

  if (!TRANSACTION_KINDS.includes(transaction.kind)) {
    errors.kind = 'Valitse tapahtuman laji.';
  }

  if (transaction.kind !== TRANSACTION_KIND.TRANSFER && !transaction.category) {
    errors.category = 'Valitse luokka.';
  }

  if (transaction.sourceKind && !transaction.sourceId) {
    errors.sourceId = 'Lähdetietue puuttuu.';
  }

  return { valid: Object.keys(errors).length === 0, errors };
}

// =====================================================================
// SUUNTA JA MUKAANLASKENTA
// =====================================================================

/** Onko tapahtuma kulutusta ulospäin? */
export function isExpense(transaction) {
  return Boolean(transaction) && transaction.kind === TRANSACTION_KIND.EXPENSE;
}

/** Onko tapahtuma tuloa? */
export function isIncome(transaction) {
  return Boolean(transaction) && transaction.kind === TRANSACTION_KIND.INCOME;
}

/**
 * Onko tapahtuma siirto?
 *
 * Siirto jätetään sekä meno- että tulosummista pois. Se ei ole
 * kulutusta: raha on yhä omaa, vain toisessa paikassa.
 */
export function isTransfer(transaction) {
  return Boolean(transaction) && transaction.kind === TRANSACTION_KIND.TRANSFER;
}

/**
 * Tapahtuman vaikutus käytettävissä olevaan rahaan, sentteinä.
 *
 * Tulo kasvattaa, meno pienentää, siirto ei muuta. Siirto siirtää
 * rahaa paikasta toiseen, ja molemmat paikat ovat käyttäjän omia.
 */
export function cashFlowMinor(transaction) {
  if (!transaction || transaction.amountMinor === null) return 0;
  if (isIncome(transaction)) return transaction.amountMinor;
  if (isExpense(transaction)) return -transaction.amountMinor;
  return 0;
}

// =====================================================================
// KAKSOISLASKENNAN ESTO
// =====================================================================

/**
 * Onko lähdetietueesta jo kirjattu tapahtuma?
 *
 * TÄMÄ ON SE FUNKTIO, JOKA ESTÄÄ KAKSOISLASKENNAN. Budjetti kysyy
 * tätä ennen kuin laskee laskun kuluksi: jos laskusta on tapahtuma,
 * lasku on jo mukana tapahtumana eikä sitä lasketa toiseen kertaan.
 *
 * Vertailu tehdään TUNNISTEELLA. Summan tai kuvauksen perusteella
 * täsmäävä haku näyttäisi toimivan ja erehtyisi juuri silloin kun
 * kaksi samanlaista tapahtumaa on oikeasti eri asioita.
 */
export function hasTransactionFor(transactions, sourceKind, sourceId) {
  if (!sourceKind || sourceId == null) return false;
  const id = String(sourceId);
  return (transactions || []).some(transaction =>
    transaction
    && transaction.sourceKind === sourceKind
    && transaction.sourceId === id);
}

/** Lähdetietueen tapahtumat. */
export function transactionsForSource(transactions, sourceKind, sourceId) {
  if (!sourceKind || sourceId == null) return [];
  const id = String(sourceId);
  return (transactions || []).filter(transaction =>
    transaction
    && transaction.sourceKind === sourceKind
    && transaction.sourceId === id);
}

/**
 * Tapahtuma maksetusta laskusta.
 *
 * Laskun maksaminen ON taloudellinen tapahtuma. Se kirjataan kerran,
 * ja side laskuun säilyy tunnisteena — jolloin budjetti tietää, ettei
 * laskua saa laskea uudestaan.
 *
 * Tunniste annetaan kutsujalta: domain ei tuota tunnisteita eikä lue
 * kelloa.
 */
export function transactionFromBill(bill, id) {
  if (!bill) return null;
  return normalizeTransaction({
    id,
    kind: TRANSACTION_KIND.EXPENSE,
    origin: TRANSACTION_ORIGIN.BILL,
    amountMinor: bill.amountMinor,
    currency: bill.currency,
    date: bill.paidDate || bill.dueDate,
    category: 'laskut',
    description: bill.name,
    sourceKind: SOURCE_KIND.BILL,
    sourceId: bill.id
  });
}

/**
 * Tapahtuma säästösiirrosta.
 *
 * Laji on SIIRTO, ei meno. Säästäminen ei köyhdytä.
 */
export function transactionFromSavings(goal, amountMinor, dateIso, id) {
  if (!goal) return null;

  // NOLLAN SUURUINEN SIIRTO EI OLE SIIRTO. Ilman tätä syntyisi
  // tapahtuma, jonka kanta hylkää (`transactions_amount_check`) ja
  // jonka virhe näkyisi käyttäjälle vasta tallennuksessa — sanoin,
  // jotka eivät kerro mitä hän teki väärin.
  const amount = normalizeMinor(amountMinor);
  if (amount === null || amount <= 0) return null;

  return normalizeTransaction({
    id,
    kind: TRANSACTION_KIND.TRANSFER,
    origin: TRANSACTION_ORIGIN.SAVINGS,
    amountMinor: amount,
    currency: goal.currency,
    date: dateIso,
    description: goal.name,
    sourceKind: SOURCE_KIND.SAVINGS_GOAL,
    sourceId: goal.id
  });
}

// =====================================================================
// JÄRJESTYS JA SUODATUS
// =====================================================================

/** Uusin ensin, ja saman päivän sisällä vakaa tunnisteen mukaan. */
export function compareTransactions(a, b) {
  const byDate = String(b.date || '').localeCompare(String(a.date || ''));
  if (byDate !== 0) return byDate;
  return String(a.id || '').localeCompare(String(b.id || ''));
}

/** Kuuluuko tapahtuma annettuun kuukauteen? `month` on 'YYYY-MM'. */
export function isInMonth(transaction, month) {
  return Boolean(transaction && transaction.date
    && String(transaction.date).slice(0, 7) === month);
}

/** Kuukauden tapahtumat. */
export function transactionsInMonth(transactions, month) {
  return (transactions || []).filter(transaction => isInMonth(transaction, month));
}

/** Kuukausitunniste päivästä: '2026-09-14' -> '2026-09'. */
export function monthOf(dateIso) {
  return isIsoDate(dateIso) ? String(dateIso).slice(0, 7) : null;
}

/**
 * Summaa sentteinä valuutoittain.
 *
 * VALUUTTOJA EI MUUNNETA. Ilman kurssia muunnos olisi arvaus, ja
 * arvattu summa näyttää yhtä varmalta kuin laskettu.
 */
export function sumByCurrency(transactions) {
  const totals = {};
  for (const transaction of transactions || []) {
    if (!transaction || transaction.amountMinor === null) continue;
    const currency = transaction.currency;
    totals[currency] = (totals[currency] || 0) + transaction.amountMinor;
  }
  return totals;
}
