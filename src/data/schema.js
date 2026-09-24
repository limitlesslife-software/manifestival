// Skeemakyvykkyydet: mitkä tietokannan sarakkeet ovat oikeasti olemassa.
//
// MIKSI TÄMÄ ON OLEMASSA
// Domain-malli ja käyttöliittymä on kirjoitettu valmiiksi laajennetuille
// kentille (kuvaus, kesto, prioriteetti, aikataulutuksen tila). Tuotannon
// tietokannassa niitä ei kuitenkaan vielä ole, koska migraatiota 0002 ei ole
// ajettu — ja sen ajaminen on käyttäjän päätös, ei tämän koodin.
//
// Ilman tätä porttia sovellus yrittäisi kirjoittaa olemattomiin sarakkeisiin
// ja JOKAINEN tallennus epäonnistuisi tuotannossa.
//
// TILA: migraatio 0002 on ajettu tuotantoon ja lippu on käännetty.
// Kuvaus, kesto, prioriteetti ja aikataulutuksen tila tallentuvat nyt.
// Ks. docs/TASK-EXTENDED-FIELDS-ACTIVATION.md.

import { TASK_COLUMNS_CORE, TASK_COLUMNS_EXTENDED } from '../lib/rows.js';

/**
 * Onko migraatio 0002 ajettu tuotantoon?
 *
 * false = tasks-taulussa on vain alkuperäiset 9 saraketta.
 *         Kuvaus, kesto, prioriteetti ja aikataulutuksen tila elävät vain
 *         selaimen muistissa ja katoavat sivun latauksessa.
 * true  = kaikki domainin kentät tallentuvat.
 *
 * PRODUCTION GATE. Migraatio 0002 on ajettu ja todennettu, joten tämä on
 * true. Takaisin false vaihtaminen on turvallinen hätävara: sarakkeet
 * jäävät kantaan koskemattomina ja sovellus vain lakkaa kirjoittamasta
 * niihin. Sarakkeita EI saa pudottaa — niissä on käyttäjän tietoa.
 */
export const TASK_EXTENDED_FIELDS = true;

/** Sarakkeet, joita tehtävän kirjoituksissa saa käyttää juuri nyt. */
export function taskColumns() {
  return TASK_EXTENDED_FIELDS ? TASK_COLUMNS_EXTENDED : TASK_COLUMNS_CORE;
}

/**
 * Taulut, joita tietokannassa ei vielä ole.
 *
 * PRODUCTION GATE. Jokainen `false` tarkoittaa, että kyseinen tieto elää
 * VAIN istunnon muistissa (`src/data/memoryStore.js`) ja katoaa sivun
 * latauksessa. Käyttöliittymä kertoo tämän käyttäjälle — se ei teeskentele
 * tallentavansa.
 *
 * Käyttöönotto: aja migraatio ja vaihda vastaava lippu arvoon true.
 * Ks. docs/PRODUCTION-ACTIVATION.md.
 */
export const TABLES = Object.freeze({
  /** Migraatio 0003 */
  routines: true,
  routineExceptions: true,
  /** Migraatio 0004 */
  goals: true,
  projects: true,
  /** Migraatio 0005 */
  notificationPreferences: true,
  /** Migraatio 0006 */
  wellbeing: true,
  /** Migraatio 0007 */
  bills: true,
  recurringExpenses: true,
  savingsGoals: true,
  /** Migraatio 0008 */
  aiAudit: true,
  /** Migraatio 0009 */
  transactions: false,
  investments: false
});

/**
 * Onko migraatio 0009 ajettu `bills`-taulun osalta?
 *
 * PRODUCTION GATE, sarakeportti — sama kuvio kuin TASK_EXTENDED_FIELDS.
 *
 * false = `bills`-taulussa EI ole sarakkeita payee, iban, reference.
 *         Maksutiedot elävät vain istunnon muistissa.
 * true  = maksutiedot tallentuvat.
 *
 * MIKSI TÄMÄ ON ERILLÄÄN TABLES-porteista: `bills`-taulu voi olla
 * olemassa ILMAN näitä sarakkeita, koska migraatio 0007 loi taulun ja
 * migraatio 0009 lisää sarakkeet. Ilman erillistä porttia bills-portin
 * avaaminen ennen migraatiota 0009 tarkoittaisi, että JOKAINEN laskun
 * tallennus kaatuisi tuntemattomaan sarakkeeseen.
 *
 * Tämä saa mennä arvoon true VASTA kun migraatio 0009 on ajettu.
 */
export const BILL_PAYMENT_FIELDS = false;

/** Onko taulu käytettävissä tietokannassa? */
export function hasTable(name) {
  return TABLES[name] === true;
}

/** Taulut, jotka odottavat migraatiota. */
export function pendingTables() {
  return Object.entries(TABLES).filter(([, ready]) => !ready).map(([name]) => name);
}

/**
 * Säilyykö tämä tietotyyppi tallennuksen yli?
 * Käyttöliittymä käyttää tätä rehelliseen viestintään.
 */
export function isPersistent(tableName) {
  return hasTable(tableName);
}

/**
 * Kentät, jotka eivät vielä säily tallennuksen yli.
 * Käyttöliittymä voi kertoa tämän käyttäjälle rehellisesti sen sijaan,
 * että se teeskentelisi tallentavansa ne.
 */
export function volatileFields() {
  return TASK_EXTENDED_FIELDS
    ? []
    : ['description', 'durationMinutes', 'priority', 'schedulingState'];
}

/** Säilyykö annettu domain-kenttä tallennuksen yli? */
export function isPersisted(field) {
  return !volatileFields().includes(field);
}

/**
 * Laskun kentät, jotka eivät vielä säily tallennuksen yli.
 * Käyttöliittymä kertoo tämän käyttäjälle sen sijaan, että
 * teeskentelisi tallentavansa maksutiedot.
 */
export function volatileBillFields() {
  return BILL_PAYMENT_FIELDS ? [] : ['payee', 'iban', 'reference'];
}
