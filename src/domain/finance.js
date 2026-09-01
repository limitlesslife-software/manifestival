// Talouden domain: laskut, toistuvat kulut ja talousmuistutukset.
//
// PUHDAS MODUULI. Ei DOM:ia, ei verkkoa, ei kelloa. Nykyhetki annetaan
// parametrina, kuten muissakin domain-moduuleissa.
//
// RAJAUS, JOKA EI OLE NEUVOTELTAVISSA
// Tämä moduuli EI anna sijoitus- eikä talousneuvontaa. Se kuvaa mitä on, ei
// ennusta mitä tulee. Sallittua: "hätävara riittää 2,5 kuukaudeksi".
// Kiellettyä: "sijoita tähän", "myy nyt". Sijoitusneuvonta on säänneltyä
// toimintaa, eikä henkilökohtainen sovellus voi luvata osaamista jota
// sillä ei ole. Ks. docs/INVESTMENTS-ARCHITECTURE.md.
//
// EI PANKKIYHTEYTTÄ. Kaikki tieto on käyttäjän itse kirjaamaa. PSD2-
// integraatio vaatisi lisenssin, sopimukset ja oman tietoturva-arviointinsa.
//
// SUHDE MUUHUN MALLIIN
// Talous ei ole erillinen saareke. Lasku on määräaika, toistuva kulu on
// rutiini ja kumpikin voi synnyttää tehtävän:
//
//   Lasku          -> deadline  -> muistutus -> (valinnainen tehtävä)
//   Toistuva kulu  -> toisto    -> ennuste seuraavasta eräpäivästä
//
// Siksi tämä moduuli tuottaa samoja käsitteitä kuin task.js ja routine.js
// eikä keksi omaa rinnakkaista aikakäsitystä.

import { fmtISO, parseISO, addDays } from '../lib/datetime.js';
import { isIsoDate } from './task.js';

/** Laskun tila. */
export const BILL_STATUS = Object.freeze({
  /** Odottaa maksua. */
  OPEN: 'open',
  /** Maksettu. */
  PAID: 'paid',
  /** Peruttu tai hyvitetty — ei enää maksettava. */
  CANCELLED: 'cancelled'
});

export const BILL_STATUSES = Object.freeze(Object.values(BILL_STATUS));

/** Toistuvan kulun jakso. */
export const CADENCE = Object.freeze({
  WEEKLY: 'weekly',
  MONTHLY: 'monthly',
  QUARTERLY: 'quarterly',
  YEARLY: 'yearly'
});

export const CADENCES = Object.freeze(Object.values(CADENCE));

/**
 * Jakson pituus päivinä.
 *
 * Tarkoituksella APPROKSIMAATIO eikä kalenterilaskentaa: näitä käytetään
 * vain kuukausikustannuksen arvioon ja seuraavan erääntymisen ennusteeseen.
 * Kalenteritarkka toistuvuus kuuluu rutiinimoduulille, jolla se jo on.
 */
const CADENCE_DAYS = Object.freeze({
  [CADENCE.WEEKLY]: 7,
  [CADENCE.MONTHLY]: 30,
  [CADENCE.QUARTERLY]: 91,
  [CADENCE.YEARLY]: 365
});

/** Kuinka monta kertaa vuodessa jakso toistuu. */
const CADENCE_PER_YEAR = Object.freeze({
  [CADENCE.WEEKLY]: 52,
  [CADENCE.MONTHLY]: 12,
  [CADENCE.QUARTERLY]: 4,
  [CADENCE.YEARLY]: 1
});

const CADENCE_LABELS = Object.freeze({
  [CADENCE.WEEKLY]: 'Viikoittain',
  [CADENCE.MONTHLY]: 'Kuukausittain',
  [CADENCE.QUARTERLY]: 'Neljännesvuosittain',
  [CADENCE.YEARLY]: 'Vuosittain'
});

export function cadenceLabel(cadence) {
  return CADENCE_LABELS[cadence] || cadence;
}

/** Oletusvaluutta. Monivaluuttatuki on PLANNED, ei toteutettu. */
export const DEFAULT_CURRENCY = 'EUR';

/** Suurin hyväksyttävä summa. Suojaa kirjoitusvirheeltä, ei rikkaudelta. */
export const MAX_AMOUNT = 1e9;

/**
 * Rahasumma sentteinä pyöristettynä.
 *
 * Rahaa EI säilytetä liukulukuna laskennassa: 0,1 + 0,2 ei ole 0,3
 * binäärisessä liukuluvussa, ja virhe kertautuu summattaessa. Arvo
 * pyöristetään kahteen desimaaliin heti normalisoinnissa.
 */
function normalizeAmount(value) {
  // Puuttuva arvo on TUNTEMATON, ei nolla. Number(null) ja Number('') ovat
  // molemmat 0, joten ilman tätä tarkistusta tyhjä kenttä muuttuisi
  // hiljaa nollan euron laskuksi — ja validointi hyväksyisi sen, koska
  // summa ei olisi null. Käyttäjä luulisi kirjanneensa laskun oikein.
  if (value === null || value === undefined || value === '') return null;

  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  const rounded = Math.round(number * 100) / 100;
  return rounded > MAX_AMOUNT ? null : rounded;
}

function cleanText(value, maxLength) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text.slice(0, maxLength) : null;
}

// ------------------------------------------------------------------ lasku

/**
 * Normalisoi lasku.
 *
 * Lasku on kertaluonteinen maksu, jolla on eräpäivä. Toistuva lasku on
 * RecurringExpense, joka ennustaa seuraavan eräpäivän.
 */
export function normalizeBill(input = {}) {
  return {
    id: input.id != null ? String(input.id) : null,
    title: cleanText(input.title, 200) || '',
    amount: normalizeAmount(input.amount),
    currency: cleanText(input.currency, 3) || DEFAULT_CURRENCY,
    /** Eräpäivä. Sama käsite kuin tehtävän deadline. */
    dueDate: isIsoDate(input.dueDate) ? input.dueDate : null,
    status: BILL_STATUSES.includes(input.status) ? input.status : BILL_STATUS.OPEN,
    /** Milloin tosiasiassa maksettiin. Vain PAID-tilassa merkityksellinen. */
    paidDate: isIsoDate(input.paidDate) ? input.paidDate : null,
    category: cleanText(input.category, 40) || 'talous',
    /** Valinnainen linkki tehtävään, jos maksaminen halutaan päivän listalle. */
    taskId: input.taskId != null ? String(input.taskId) : null,
    /** Mistä toistuvasta kulusta tämä syntyi, jos syntyi. */
    recurringExpenseId: input.recurringExpenseId != null
      ? String(input.recurringExpenseId) : null,
    note: cleanText(input.note, 500),
    createdAt: input.createdAt ?? null,
    updatedAt: input.updatedAt ?? null
  };
}

export function validateBill(bill) {
  const errors = {};
  if (!bill.title) errors.title = 'Anna laskulle nimi.';
  if (bill.amount === null) errors.amount = 'Anna summa numerona.';
  if (!bill.dueDate) errors.dueDate = 'Anna eräpäivä.';
  if (bill.status === BILL_STATUS.PAID && !bill.paidDate) {
    errors.paidDate = 'Merkitse milloin lasku maksettiin.';
  }
  return { valid: Object.keys(errors).length === 0, errors };
}

/** Onko lasku vielä maksamatta. */
export function isOpenBill(bill) {
  return Boolean(bill) && bill.status === BILL_STATUS.OPEN;
}

/**
 * Onko lasku myöhässä.
 *
 * JOHDETTU tieto, ei tallennettu kenttä. Tallennettuna se vanhenisi heti:
 * eilen "ajallaan" merkitty rivi olisi tänään väärässä.
 */
export function isBillOverdue(bill, todayIso) {
  if (!isOpenBill(bill) || !bill.dueDate || !isIsoDate(todayIso)) return false;
  return bill.dueDate < todayIso;
}

/** Päiviä eräpäivään. Negatiivinen = myöhässä. null jos ei eräpäivää. */
export function daysUntilDue(bill, todayIso) {
  if (!bill || !bill.dueDate || !isIsoDate(todayIso)) return null;
  const due = parseISO(bill.dueDate);
  const today = parseISO(todayIso);
  return Math.round((due.getTime() - today.getTime()) / 86400000);
}

// -------------------------------------------------------- toistuva kulu

/**
 * Normalisoi toistuva kulu.
 *
 * Toistuva kulu ei ole lasku vaan SÄÄNTÖ, aivan kuten rutiini ei ole
 * tehtävä. Yksittäiset erääntymiset johdetaan säännöstä.
 */
export function normalizeRecurringExpense(input = {}) {
  return {
    id: input.id != null ? String(input.id) : null,
    title: cleanText(input.title, 200) || '',
    amount: normalizeAmount(input.amount),
    currency: cleanText(input.currency, 3) || DEFAULT_CURRENCY,
    cadence: CADENCES.includes(input.cadence) ? input.cadence : CADENCE.MONTHLY,
    /** Seuraava tunnettu eräpäivä. Tästä ennusteet lasketaan eteenpäin. */
    nextDueDate: isIsoDate(input.nextDueDate) ? input.nextDueDate : null,
    category: cleanText(input.category, 40) || 'talous',
    /** Pois kytketty kulu säilyy historiana muttei tuota erääntymisiä. */
    active: input.active !== false,
    note: cleanText(input.note, 500),
    createdAt: input.createdAt ?? null,
    updatedAt: input.updatedAt ?? null
  };
}

export function validateRecurringExpense(expense) {
  const errors = {};
  if (!expense.title) errors.title = 'Anna kululle nimi.';
  if (expense.amount === null) errors.amount = 'Anna summa numerona.';
  if (!CADENCES.includes(expense.cadence)) errors.cadence = 'Valitse jakso.';
  if (!expense.nextDueDate) errors.nextDueDate = 'Anna seuraava eräpäivä.';
  return { valid: Object.keys(errors).length === 0, errors };
}

/**
 * Kulun kuukausikustannus.
 *
 * Vuosimaksu jaettuna kahdellatoista on vertailukelpoinen luku, jolla eri
 * jaksoiset kulut voi laskea yhteen. Se ei ole ennuste vaan muunnos.
 */
export function monthlyCost(expense) {
  if (!expense || expense.amount === null) return 0;
  const perYear = CADENCE_PER_YEAR[expense.cadence] ?? 12;
  return Math.round((expense.amount * perYear / 12) * 100) / 100;
}

/** Aktiivisten toistuvien kulujen yhteenlaskettu kuukausikustannus. */
export function totalMonthlyCost(expenses = []) {
  const total = expenses
    .filter(expense => expense && expense.active)
    .reduce((sum, expense) => sum + monthlyCost(expense), 0);
  return Math.round(total * 100) / 100;
}

/**
 * Ennusta toistuvan kulun erääntymiset aikavälille.
 *
 * TAKUUT:
 *  - Deterministinen: sama syöte tuottaa aina saman tuloksen
 *  - Päiväjärjestyksessä, ei kahta samaa päivää
 *  - Pois kytketty kulu ei tuota yhtään erääntymistä
 *  - Ei koskaan enempää kuin MAX_OCCURRENCES riviä
 *
 * @returns {Array<{expenseId:string, date:string, amount:number, title:string}>}
 */
export function projectDueDates({ expense, from, to }) {
  if (!expense || !expense.active || !expense.nextDueDate) return [];
  if (!isIsoDate(from) || !isIsoDate(to) || to < from) return [];

  const step = CADENCE_DAYS[expense.cadence];
  if (!step) return [];

  const results = [];
  let cursor = parseISO(expense.nextDueDate);
  let guard = 0;
  const MAX_OCCURRENCES = 200;

  // Kelaa eteenpäin, kunnes ollaan välin sisällä. Menneet erääntymiset eivät
  // kuulu ennusteeseen — ne ovat historiaa, eivät suunnitelmaa.
  while (fmtISO(cursor) < from && guard++ < MAX_OCCURRENCES) {
    cursor = addDays(cursor, step);
  }

  while (fmtISO(cursor) <= to && guard++ < MAX_OCCURRENCES) {
    results.push({
      expenseId: expense.id,
      title: expense.title,
      amount: expense.amount,
      currency: expense.currency,
      date: fmtISO(cursor),
      cadence: expense.cadence
    });
    cursor = addDays(cursor, step);
  }

  return results;
}

/** Usean kulun ennuste yhtenä päiväjärjestettynä listana. */
export function projectAllDueDates({ expenses = [], from, to }) {
  return expenses
    .flatMap(expense => projectDueDates({ expense, from, to }))
    .sort((a, b) => a.date.localeCompare(b.date)
      || String(a.title).localeCompare(String(b.title), 'fi'));
}

// -------------------------------------------------------- muistutukset

/** Kuinka monta päivää ennen eräpäivää muistutetaan oletuksena. */
export const DEFAULT_BILL_LEAD_DAYS = 3;

/**
 * Rakenna talousmuistutukset avoimista laskuista.
 *
 * TÄMÄ EI OLE ILMOITUSMOOTTORI. Se tuottaa saman muotoisia kuvauksia kuin
 * domain/notification.js, jotta ilmoituskerros voi käsitellä ne samoin —
 * mutta lähettäminen, rauhoitusajat ja päiväkatot kuuluvat sinne, eivät
 * tänne. Yksi vastuu per moduuli.
 *
 * TAKUUT:
 *  - Maksetusta tai perutusta laskusta ei koskaan muistuteta
 *  - Deterministinen ja eräpäiväjärjestyksessä
 *  - Myöhässä oleva lasku on aina kiireellisempi kuin tuleva
 *
 * @returns {Array<{billId, title, dueDate, amount, daysUntil, overdue, urgency}>}
 */
export function buildFinancialReminders({
  bills = [],
  todayIso,
  leadDays = DEFAULT_BILL_LEAD_DAYS
} = {}) {
  if (!isIsoDate(todayIso)) return [];
  const lead = Number.isFinite(Number(leadDays)) ? Math.max(0, Number(leadDays)) : 0;

  return bills
    .filter(isOpenBill)
    .map(bill => {
      const daysUntil = daysUntilDue(bill, todayIso);
      const overdue = isBillOverdue(bill, todayIso);
      return {
        billId: bill.id,
        title: bill.title,
        dueDate: bill.dueDate,
        amount: bill.amount,
        currency: bill.currency,
        daysUntil,
        overdue,
        urgency: overdue ? 'overdue' : daysUntil === 0 ? 'today' : 'soon'
      };
    })
    .filter(reminder =>
      reminder.daysUntil !== null && reminder.daysUntil <= lead)
    .sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate))
      || String(a.title).localeCompare(String(b.title), 'fi'));
}

/**
 * Yhteenveto talouden tilasta.
 *
 * Kuvaa mitä on. Ei ennusta, ei neuvo, ei arvota.
 */
export function summarizeFinances({ bills = [], expenses = [], todayIso } = {}) {
  const open = bills.filter(isOpenBill);
  const overdue = open.filter(bill => isBillOverdue(bill, todayIso));

  const sum = list => Math.round(
    list.reduce((total, bill) => total + (bill.amount || 0), 0) * 100) / 100;

  return {
    openCount: open.length,
    openAmount: sum(open),
    overdueCount: overdue.length,
    overdueAmount: sum(overdue),
    monthlyRecurring: totalMonthlyCost(expenses),
    activeExpenses: expenses.filter(expense => expense && expense.active).length
  };
}
