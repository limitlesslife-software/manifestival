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

import {
  TASK_COLUMNS_CORE, TASK_COLUMNS_EXTENDED, TASK_COLUMNS_PLANNING
} from '../lib/rows.js';

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

/**
 * Sarakkeet, joita tehtävän kirjoituksissa saa käyttää juuri nyt.
 *
 * KOLME TASOA, KAKSI PORTTIA. Migraatio 0002 toi laajennetut kentät ja
 * migraatio 0010 tuo suunnittelukentät. Portin lukeminen tässä on ainoa
 * paikka, jossa sarakejoukko valitaan — kutsupaikat eivät tiedä
 * migraatioista mitään.
 */
export function taskColumns() {
  if (!TASK_EXTENDED_FIELDS) return TASK_COLUMNS_CORE;
  return GOAL_PLANNING_FIELDS ? TASK_COLUMNS_PLANNING : TASK_COLUMNS_EXTENDED;
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
  routines: false,
  routineExceptions: false,
  /** Migraatio 0004 */
  goals: false,
  projects: false,
  /** Migraatio 0005 */
  notificationPreferences: false,
  /** Migraatio 0006 */
  wellbeing: false,
  /** Migraatio 0007 */
  bills: false,
  recurringExpenses: false,
  savingsGoals: false,
  /** Migraatio 0008 */
  aiAudit: false,
  /** Migraatio 0009 — EI AJETTU. Ks. supabase/migrations/0009_finance_2.sql. */
  transactions: false,
  investments: false,
  /** Migraatio 0010 — EI AJETTU. Ks. supabase/migrations/0010_goal_to_action.sql. */
  milestones: false,
  /**
   * Migraatio 0011 — EI AJETTU.
   * Ks. supabase/migrations/0011_personal_assistant.sql.
   *
   * Nämä viisi ovat kaikki UUSIA TAULUJA. Toisin kuin migraatio 0010,
   * 0011 ei muuta yhtäkään olemassa olevaa taulua — se on siksi
   * selvästi vähemmän vaarallinen, ja se on syytä sanoa ääneen.
   */
  inboxItems: false,
  reminders: false,
  notices: false,
  travelPlans: false,
  locationRules: false
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

/**
 * Onko migraatio 0010 ajettu tavoitteiden ja tehtävien osalta?
 *
 * PRODUCTION GATE, sarakeportti — sama kuvio kuin TASK_EXTENDED_FIELDS
 * ja BILL_PAYMENT_FIELDS.
 *
 * false = seuraavia sarakkeita EI ole kannassa:
 *           goals.metric, unit, baseline_value, current_value,
 *                target_value, measured_on, savings_goal_id
 *           tasks.milestone_id, depends_on
 *           projects.milestone_id
 *         Tieto elää istunnon muistissa.
 * true  = ne tallentuvat.
 *
 * MIKSI TÄMÄ ON ERITYISEN VAARALLINEN PORTTI:
 *
 * `goals` ja `projects` ovat TUOTANNOSSA AUKI (aalto B, ddfc356) ja
 * niissä on käyttäjän oikeaa dataa. Tämän portin avaaminen ennen
 * migraatiota 0010 ei kaataisi uutta ominaisuutta vaan JOKAISEN
 * tavoitteen ja projektin tallennuksen — myös niiden, jotka toimivat
 * tänään.
 *
 * Tämä saa mennä arvoon true VASTA kun migraatio 0010 on ajettu.
 */
export const GOAL_PLANNING_FIELDS = false;

/**
 * Onko `maintenance` sallittu tavoitteen tilaksi?
 *
 * PRODUCTION GATE. Rajoite `goals_status_check` sallii tuotannossa
 * viisi tilaa; `maintenance` on kuudes ja se lisätään migraatiossa
 * 0010.
 *
 * Erillinen portti, koska tilan käyttö kaataisi tallennuksen
 * rajoiterikkomukseen (23514) vaikka kaikki sarakkeet olisivat
 * paikallaan. Sarakkeen puuttuminen ja arvon kieltäminen ovat eri
 * vikoja, ja niillä on eri oire.
 */
export const GOAL_MAINTENANCE_MODE = false;

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

/**
 * Tavoitteen kentät, jotka eivät vielä säily tallennuksen yli.
 * Käyttöliittymä kertoo tämän käyttäjälle sen sijaan, että
 * teeskentelisi tallentavansa mittarin.
 */
export function volatileGoalFields() {
  return GOAL_PLANNING_FIELDS
    ? []
    : ['metric', 'unit', 'baselineValue', 'currentValue', 'targetValue',
       'measuredOn', 'savingsGoalId'];
}

/** Tehtävän kentät, jotka eivät vielä säily tallennuksen yli. */
export function volatileTaskPlanningFields() {
  return GOAL_PLANNING_FIELDS ? [] : ['milestoneId', 'dependsOn'];
}
