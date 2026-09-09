// Talouden domain: laskut, toistuvat kulut, säästötavoitteet ja
// talousmuistutukset.
//
// PUHDAS MODUULI. Ei DOM:ia, ei verkkoa, ei kelloa. Nykyhetki annetaan
// parametrina, kuten muissakin domain-moduuleissa.
//
// ---------------------------------------------------------------------
// TÄMÄ EI OLE PANKKISOVELLUS
// ---------------------------------------------------------------------
// Ei Open Bankingia, ei tiliyhteyksiä, ei maksuja, ei kortteja, ei
// pankkitunnuksia. Kaikki tieto on käyttäjän itse kirjaamaa. PSD2-
// integraatio vaatisi lisenssin, sopimukset ja oman tietoturva-
// arviointinsa — se on oma pakettinsa, ei sivutuote.
//
// ---------------------------------------------------------------------
// RAHA ON KOKONAISLUKU
// ---------------------------------------------------------------------
// Summat ovat SENTTEJÄ (`amountMinor`). Ks. src/domain/money.js — siellä
// on perustelu ja muunnokset. Tässä moduulissa ei koskaan lasketa
// liukuluvuilla eikä summata eri valuuttoja yhteen.
//
// ---------------------------------------------------------------------
// RAJAUS, JOKA EI OLE NEUVOTELTAVISSA
// ---------------------------------------------------------------------
// Moduuli EI anna sijoitus- eikä talousneuvontaa. Se kuvaa mitä on, ei
// ennusta mitä tulee. Sallittua: "hätävara riittää 2,5 kuukaudeksi".
// Kiellettyä: "sijoita tähän", "myy nyt". Ks. docs/INVESTMENTS-ARCHITECTURE.md.
//
// ---------------------------------------------------------------------
// SUHDE MUUHUN MALLIIN
// ---------------------------------------------------------------------
// Talous ei ole erillinen saareke:
//
//   Lasku          -> eräpäivä on sama käsite kuin tehtävän deadline
//   Toistuva kulu  -> SÄÄNTÖ, kuten rutiini; erääntymiset lasketaan
//   Kumpikin       -> voi synnyttää tehtävän ja muistutuksen

import { fmtISO, parseISO, addDays } from '../lib/datetime.js';
import { isIsoDate } from './task.js';
import {
  DEFAULT_CURRENCY, normalizeCurrency, normalizeMinor, percentOf, remainingMinor,
  sumByCurrency
} from './money.js';

/**
 * Laskun tila.
 *
 * UPCOMING, DUE ja OVERDUE ovat JOHDETTUJA näkymiä avoimeen laskuun —
 * ne lasketaan eräpäivästä eikä tallenneta. Tallennettuna ne vanhenisivat
 * heti: eilen "tulossa" merkitty rivi olisi tänään väärässä.
 *
 * Vain OPEN, PAID ja CANCELLED ovat oikeasti tallennettuja tiloja.
 */
export const BILL_STATUS = Object.freeze({
  OPEN: 'open',
  PAID: 'paid',
  CANCELLED: 'cancelled'
});

export const BILL_STATUSES = Object.freeze(Object.values(BILL_STATUS));

/** Laskun johdettu kiireellisyys. Lasketaan aina uudelleen. */
export const BILL_URGENCY = Object.freeze({
  UPCOMING: 'upcoming',
  DUE: 'due',
  OVERDUE: 'overdue',
  PAID: 'paid',
  CANCELLED: 'cancelled'
});

/** Toistuvan kulun jakso. */
export const CADENCE = Object.freeze({
  WEEKLY: 'weekly',
  MONTHLY: 'monthly',
  QUARTERLY: 'quarterly',
  YEARLY: 'yearly'
});

export const CADENCES = Object.freeze(Object.values(CADENCE));

/** Kuinka monta kertaa vuodessa jakso toistuu. Käytetään kuukausiarvioon. */
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

/** Kuinka monta päivää ennen eräpäivää muistutetaan oletuksena. */
export const DEFAULT_BILL_LEAD_DAYS = 3;

/** Enimmäismäärä laskettuja erääntymisiä. Estää rajattoman materialisoinnin. */
export const MAX_OCCURRENCES = 200;

function cleanText(value, maxLength) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text.slice(0, maxLength) : null;
}

// ------------------------------------------------------------------ lasku

/**
 * Siisti IBAN esitysmuotoon.
 *
 * Isoiksi kirjaimiksi, sallitut merkit vain kirjaimia, numeroita ja
 * välejä. TARKISTUSSUMMAA EI LASKETA: väärä IBAN ei aiheuta täällä
 * mitään vahinkoa, koska sovellus ei maksa mitään, ja liian tiukka
 * tarkistus estäisi käyttäjää kirjaamasta ulkomaista tiliä jonka
 * muotoa emme tunne.
 */
function normalizeIban(value) {
  if (value === null || value === undefined) return null;
  const cleaned = String(value).toUpperCase().replace(/[^A-Z0-9 ]/g, '').trim();
  return cleaned ? cleaned.slice(0, 42) : null;
}

/**
 * Normalisoi lasku.
 *
 * Lasku on kertaluonteinen maksu, jolla on eräpäivä. Toistuva lasku on
 * RecurringExpense, joka ennustaa seuraavan eräpäivän.
 */
export function normalizeBill(input = {}) {
  return {
    id: input.id != null ? String(input.id) : null,
    name: cleanText(input.name ?? input.title, 200) || '',
    /** SENTTEINÄ. Ks. src/domain/money.js. */
    amountMinor: normalizeMinor(input.amountMinor),
    currency: normalizeCurrency(input.currency),
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

    // --------------------------------------------------------------
    // MAKSUTIEDOT
    //
    // Nämä ovat TIETOA, EIVÄT MAKSUKÄSKY. Manifestivalilla ei ole
    // pankkiyhteyttä eikä valtuutta siirtää rahaa. IBAN ja viite ovat
    // olemassa siksi, että käyttäjä voi kopioida ne omaan pankkiinsa —
    // ei siksi, että sovellus tekisi maksun.
    //
    // Sarakkeet syntyvät migraatiossa 0009, jota ei ole ajettu.
    // Ks. BILL_PAYMENT_FIELDS src/data/schema.js.
    // --------------------------------------------------------------

    /** Saaja. */
    payee: cleanText(input.payee, 200),
    /** Tilinumero. Isot kirjaimet, välit säilytetään luettavuuden vuoksi. */
    iban: normalizeIban(input.iban),
    /** Viitenumero tai viestikenttä. */
    reference: cleanText(input.reference, 40),

    note: cleanText(input.note, 500),
    createdAt: input.createdAt ?? null,
    updatedAt: input.updatedAt ?? null
  };
}

export function validateBill(bill) {
  const errors = {};
  if (!bill.name) errors.name = 'Anna laskulle nimi.';
  if (bill.amountMinor === null) errors.amountMinor = 'Anna summa.';
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
 * JOHDETTU tieto, ei tallennettu kenttä.
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

/**
 * Laskun johdettu kiireellisyys.
 *
 * Maksettu ja peruttu ovat omat tilansa; avoin jakautuu eräpäivän mukaan.
 */
export function billUrgency(bill, todayIso, leadDays = DEFAULT_BILL_LEAD_DAYS) {
  if (!bill) return BILL_URGENCY.UPCOMING;
  if (bill.status === BILL_STATUS.PAID) return BILL_URGENCY.PAID;
  if (bill.status === BILL_STATUS.CANCELLED) return BILL_URGENCY.CANCELLED;

  const days = daysUntilDue(bill, todayIso);
  if (days === null) return BILL_URGENCY.UPCOMING;
  if (days < 0) return BILL_URGENCY.OVERDUE;
  if (days <= leadDays) return BILL_URGENCY.DUE;
  return BILL_URGENCY.UPCOMING;
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
    name: cleanText(input.name ?? input.title, 200) || '',
    amountMinor: normalizeMinor(input.amountMinor),
    currency: normalizeCurrency(input.currency),
    cadence: CADENCES.includes(input.cadence) ? input.cadence : CADENCE.MONTHLY,
    /**
     * Kuukauden päivä, jona kulu erääntyy (1–31).
     *
     * Tarvitaan, koska kuukaudet ovat eripituisia: "vuokra 31. päivä" ei voi
     * osua helmikuuhun. Ks. `monthlyDueDate` — päivä rajataan kuukauden
     * viimeiseen, ei vieritetä seuraavaan kuukauteen.
     */
    dayOfMonth: normalizeDayOfMonth(input.dayOfMonth),
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

function normalizeDayOfMonth(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const day = Math.round(n);
  return day >= 1 && day <= 31 ? day : null;
}

export function validateRecurringExpense(expense) {
  const errors = {};
  if (!expense.name) errors.name = 'Anna kululle nimi.';
  if (expense.amountMinor === null) errors.amountMinor = 'Anna summa.';
  if (!CADENCES.includes(expense.cadence)) errors.cadence = 'Valitse jakso.';
  if (!expense.nextDueDate) errors.nextDueDate = 'Anna seuraava eräpäivä.';
  return { valid: Object.keys(errors).length === 0, errors };
}

/**
 * Kuukausikustannus sentteinä.
 *
 * Vuosimaksu jaettuna kahdellatoista on vertailukelpoinen luku, jolla eri
 * jaksoiset kulut voi laskea yhteen. Se ei ole ennuste vaan muunnos.
 * Pyöristys tehdään kokonaisluvuksi — puolikkaita senttejä ei ole.
 */
export function monthlyCostMinor(expense) {
  if (!expense || expense.amountMinor === null) return 0;
  const perYear = CADENCE_PER_YEAR[expense.cadence] ?? 12;
  return Math.round((expense.amountMinor * perYear) / 12);
}

/**
 * Aktiivisten toistuvien kulujen kuukausikustannus valuutoittain.
 * Eri valuuttoja ei lasketa yhteen.
 */
export function monthlyCostByCurrency(expenses = []) {
  return sumByCurrency(
    (expenses || [])
      .filter(expense => expense && expense.active)
      .map(expense => ({
        amountMinor: monthlyCostMinor(expense),
        currency: expense.currency
      }))
  );
}

/**
 * Kuukauden päivä turvallisesti kalenterikuukauteen.
 *
 * "Vuokra 31. päivä" ei voi osua helmikuuhun. Vaihtoehdot olisivat
 * vierittää maaliskuun 3. päivään (Date tekee näin itsestään) tai rajata
 * kuukauden viimeiseen. Rajaus on oikein: lasku erääntyy helmikuussa, ei
 * maaliskuussa, ja vieritys siirtäisi sen väärään kuukauteen kokonaan.
 */
export function monthlyDueDate(year, monthIndex, dayOfMonth) {
  const lastDay = new Date(year, monthIndex + 1, 0).getDate();
  const day = Math.min(Math.max(1, dayOfMonth), lastDay);
  return fmtISO(new Date(year, monthIndex, day));
}

/**
 * Seuraava erääntyminen annetusta päivästä eteenpäin.
 *
 * Kuukausi- ja vuosijaksot käyttävät KALENTERILASKENTAA, eivät kiinteää
 * päivämäärää: 30 päivää ei ole kuukausi, ja 365 päivää ei ole vuosi
 * karkausvuonna. Viikko ja neljännesvuosi lasketaan päivinä, koska niissä
 * ero ei synny.
 */
function advance(dateIso, cadence, dayOfMonth) {
  const date = parseISO(dateIso);

  if (cadence === CADENCE.WEEKLY) return fmtISO(addDays(date, 7));

  if (cadence === CADENCE.MONTHLY || cadence === CADENCE.QUARTERLY
    || cadence === CADENCE.YEARLY) {
    const step = cadence === CADENCE.MONTHLY ? 1 : cadence === CADENCE.QUARTERLY ? 3 : 12;
    const anchor = dayOfMonth ?? date.getDate();
    const year = date.getFullYear();
    const month = date.getMonth() + step;
    return monthlyDueDate(year, month, anchor);
  }

  return fmtISO(addDays(date, 30));
}

/**
 * Ennusta toistuvan kulun erääntymiset aikavälille.
 *
 * TAKUUT:
 *  - Deterministinen: sama syöte tuottaa aina saman tuloksen
 *  - Päiväjärjestyksessä, ei kahta samaa päivää
 *  - Pois kytketty kulu ei tuota yhtään erääntymistä
 *  - Ei koskaan enempää kuin MAX_OCCURRENCES riviä
 *  - Menneet erääntymiset eivät kuulu ennusteeseen
 *
 * @returns {Array<{expenseId, name, amountMinor, currency, date, cadence}>}
 */
export function projectDueDates({ expense, from, to }) {
  if (!expense || !expense.active || !expense.nextDueDate) return [];
  if (!isIsoDate(from) || !isIsoDate(to) || to < from) return [];
  if (!CADENCES.includes(expense.cadence)) return [];

  const results = [];
  let cursor = expense.nextDueDate;
  let guard = 0;

  // Kelaa eteenpäin, kunnes ollaan välin sisällä. Menneet erääntymiset ovat
  // historiaa, eivät suunnitelmaa.
  while (cursor < from && guard++ < MAX_OCCURRENCES) {
    const next = advance(cursor, expense.cadence, expense.dayOfMonth);
    // Suoja: jos askel ei etene, silmukka pysähtyy sen sijaan että jumittuisi.
    if (next <= cursor) return results;
    cursor = next;
  }

  while (cursor <= to && guard++ < MAX_OCCURRENCES) {
    results.push({
      expenseId: expense.id,
      name: expense.name,
      amountMinor: expense.amountMinor,
      currency: expense.currency,
      date: cursor,
      cadence: expense.cadence
    });
    const next = advance(cursor, expense.cadence, expense.dayOfMonth);
    if (next <= cursor) break;
    cursor = next;
  }

  return results;
}

/** Usean kulun ennuste yhtenä päiväjärjestettynä listana. */
export function projectAllDueDates({ expenses = [], from, to }) {
  return expenses
    .flatMap(expense => projectDueDates({ expense, from, to }))
    .sort((a, b) => a.date.localeCompare(b.date)
      || String(a.name).localeCompare(String(b.name), 'fi'));
}

// ------------------------------------------------------ säästötavoite

/**
 * Normalisoi säästötavoite.
 *
 * EI sijoitustuottoja eikä oletettua korkoa. Tavoite on se mitä käyttäjä
 * on itse pannut sivuun — ei se mitä siitä voisi kasvaa.
 */
export function normalizeSavingsGoal(input = {}) {
  return {
    id: input.id != null ? String(input.id) : null,
    name: cleanText(input.name ?? input.title, 200) || '',
    targetMinor: normalizeMinor(input.targetMinor),
    currentMinor: normalizeMinor(input.currentMinor) ?? 0,
    currency: normalizeCurrency(input.currency),
    targetDate: isIsoDate(input.targetDate) ? input.targetDate : null,
    note: cleanText(input.note, 500),
    createdAt: input.createdAt ?? null,
    updatedAt: input.updatedAt ?? null
  };
}

export function validateSavingsGoal(goal) {
  const errors = {};
  if (!goal.name) errors.name = 'Anna tavoitteelle nimi.';
  if (goal.targetMinor === null || goal.targetMinor === 0) {
    errors.targetMinor = 'Anna tavoitesumma.';
  }
  return { valid: Object.keys(errors).length === 0, errors };
}

/** Säästötavoitteen edistyminen. Kaikki johdettua, mitään ei tallenneta. */
export function summarizeSavingsGoal(goal) {
  return {
    goal,
    percent: percentOf(goal.currentMinor, goal.targetMinor),
    remainingMinor: remainingMinor(goal.currentMinor, goal.targetMinor),
    reached: goal.targetMinor !== null && goal.currentMinor >= goal.targetMinor
  };
}

// ------------------------------------------------------ saastosuunnittelu

/**
 * Kuukausierä, jolla tavoite saavutetaan määräpäivään mennessä.
 *
 * Palauttaa `null` kun laskeminen ei ole mielekästä:
 *   - tavoitepäivää ei ole
 *   - tavoite on jo täynnä
 *   - määräpäivä on menneisyydessä
 *
 * `null` on rehellisempi kuin luku. Mennyt määräpäivä ei tarkoita
 * ääretöntä kuukausierää vaan sitä, ettei kysymys ole enää voimassa.
 */
export function monthlyContributionMinor(goal, todayIso) {
  if (!goal || !goal.targetDate || !isIsoDate(todayIso)) return null;

  const remaining = remainingMinor(goal.currentMinor, goal.targetMinor);
  if (remaining <= 0) return null;

  const months = monthsBetween(todayIso, goal.targetDate);
  if (months === null || months <= 0) return null;

  return Math.ceil(remaining / months);
}

/**
 * Kokonaisia kuukausia kahden paivan valilla, alaspain pyoristaen.
 * Palauttaa negatiivisen jos loppu on ennen alkua.
 */
function monthsBetween(fromIso, toIso) {
  if (!isIsoDate(fromIso) || !isIsoDate(toIso)) return null;
  const [fy, fm, fd] = fromIso.split('-').map(Number);
  const [ty, tm, td] = toIso.split('-').map(Number);
  let months = (ty - fy) * 12 + (tm - fm);
  if (td < fd) months -= 1;
  return months;
}

/**
 * Milloin tavoite tayttyy annetulla kuukausierälla?
 *
 * Palauttaa kuukausien maaran, tai `null` jos era on nolla tai
 * negatiivinen -- silloin tavoite ei tayty koskaan, eika "ei koskaan"
 * ole luku.
 */
export function monthsToReach(goal, monthlyMinor) {
  if (!goal) return null;
  const monthly = normalizeMinor(monthlyMinor);
  if (monthly === null || monthly <= 0) return null;

  const remaining = remainingMinor(goal.currentMinor, goal.targetMinor);
  if (remaining <= 0) return 0;

  return Math.ceil(remaining / monthly);
}

/**
 * Onko tavoitepaiva jo mennyt ilman etta tavoite tayttyi?
 *
 * Tama ei ole virhe vaan tilanne, ja kayttoliittyman on sanottava se
 * -- hiljaa ohitettu myohastyminen jattaa kayttajan luulemaan etta
 * suunnitelma on yha voimassa.
 */
export function isSavingsGoalOverdue(goal, todayIso) {
  if (!goal || !goal.targetDate || !isIsoDate(todayIso)) return false;
  if (remainingMinor(goal.currentMinor, goal.targetMinor) <= 0) return false;
  return goal.targetDate < todayIso;
}

/**
 * Saastoehdotus ylijaamasta.
 *
 * TAMA ON EHDOTUS, EI SIIRTO. Manifestivalilla ei ole pankkiyhteytta
 * eika se voi siirtaa rahaa. Se voi laskea, paljonko kuukaudesta jai
 * yli, ja ehdottaa osaa siita saastoon -- siirron tekee kayttaja
 * omassa pankissaan, ja kirjaa sen tanne itse.
 *
 * Osuus on maltillinen tarkoituksella: koko ylijaaman ehdottaminen
 * jattaisi puskurin nollaan.
 */
export function suggestSavingsMinor(surplusMinorAmount, share = 0.5) {
  const surplus = normalizeMinor(surplusMinorAmount);
  if (surplus === null || surplus <= 0) return 0;
  const ratio = Number.isFinite(share) && share > 0 && share <= 1 ? share : 0.5;
  return Math.floor(surplus * ratio);
}

// -------------------------------------------------------- muistutukset

/**
 * Rakenna talousmuistutukset avoimista laskuista.
 *
 * TÄMÄ EI OLE ILMOITUSMOOTTORI. Se tuottaa saman muotoisia kuvauksia kuin
 * domain/notification.js, jotta ilmoituskerros voi käsitellä ne samoin —
 * mutta lähettäminen, rauhoitusajat ja päiväkatot kuuluvat sinne.
 *
 * TAKUUT:
 *  - Maksetusta tai perutusta laskusta ei koskaan muistuteta
 *  - Deterministinen ja eräpäiväjärjestyksessä
 *  - Myöhässä oleva lasku on aina kiireellisempi kuin tuleva
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
    .map(bill => ({
      billId: bill.id,
      name: bill.name,
      dueDate: bill.dueDate,
      amountMinor: bill.amountMinor,
      currency: bill.currency,
      daysUntil: daysUntilDue(bill, todayIso),
      overdue: isBillOverdue(bill, todayIso),
      urgency: billUrgency(bill, todayIso, lead)
    }))
    .filter(reminder => reminder.daysUntil !== null && reminder.daysUntil <= lead)
    .sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate))
      || String(a.name).localeCompare(String(b.name), 'fi'));
}

/**
 * Yhteenveto talouden tilasta.
 *
 * Kuvaa mitä on. Ei ennusta, ei neuvo, ei arvota. Summat valuutoittain,
 * koska eri valuuttoja ei lasketa yhteen.
 */
export function summarizeFinances({
  bills = [], expenses = [], savingsGoals = [], todayIso
} = {}) {
  const open = bills.filter(isOpenBill);
  const overdue = open.filter(bill => isBillOverdue(bill, todayIso));
  const due = open.filter(bill => billUrgency(bill, todayIso) === BILL_URGENCY.DUE);
  const paid = bills.filter(bill => bill.status === BILL_STATUS.PAID);

  return {
    openCount: open.length,
    openTotals: sumByCurrency(open),
    overdueCount: overdue.length,
    overdueTotals: sumByCurrency(overdue),
    dueSoonCount: due.length,
    paidCount: paid.length,
    monthlyRecurringTotals: monthlyCostByCurrency(expenses),
    activeExpenses: expenses.filter(expense => expense && expense.active).length,
    savingsGoals: savingsGoals.map(summarizeSavingsGoal)
  };
}

export { DEFAULT_CURRENCY };
