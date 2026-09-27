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
  TASK_COLUMNS_CORE, TASK_COLUMNS_EXTENDED, TASK_COLUMNS_PLANNING, TASK_COLUMNS_LINKS,
  TASK_COLUMNS_MENTAL_LOAD
} from '../lib/rows.js';
import {
  isTableLowered, isColumnGateLowered, tableState, isWritable, isVerified,
  computeCapabilities, currentResults, recordReactiveFailures, setCapabilities,
  requestReprobe, PROBE_RESULT
} from './schemaRuntime.js';
import { failWith, ERROR_CODE } from '../lib/result.js';

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
 *
 * Liitokset (määräaika, tavoite, projekti; migraatio 0004) lisätään
 * jokaiseen tasoon, kun goals- ja projects-taulut ovat käytössä.
 *
 * AJONAIKAINEN TARKISTUS voi vain poistaa sarakkeita (columnGateOpen):
 * jos kanta on sovellusta jäljessä, tehtävä tallentuu silti ilman niitä.
 *
 * @param {(gate: string) => boolean} [isOpen] testejä varten (synteettiset portit)
 */
export function taskColumns(isOpen = columnGateOpen) {
  const base = !isOpen('TASK_EXTENDED_FIELDS') ? TASK_COLUMNS_CORE
    : (isOpen('GOAL_PLANNING_FIELDS') ? TASK_COLUMNS_PLANNING : TASK_COLUMNS_EXTENDED);
  const linked = isOpen('TASK_LINK_FIELDS') ? [...base, ...TASK_COLUMNS_LINKS] : [...base];
  // Mielen kuorman kentät (0015) vaativat laajennetut kentät (0002): ne
  // kuvaavat tehtävän tilaa, jota ydintaso ei tunne.
  if (isOpen('MENTAL_LOAD_FIELDS') && isOpen('TASK_EXTENDED_FIELDS')) linked.push(...TASK_COLUMNS_MENTAL_LOAD);
  return linked.length === base.length ? base : Object.freeze(linked);
}

/**
 * Saako tehtävän tallentaa ilman päivää juuri nyt?
 *
 * Vain kun migraatio 0015 on ajettu (MENTAL_LOAD_FIELDS): ennen sitä
 * horisontti ei tallennu, joten päivätön tehtävä olisi tallessa vain
 * istunnon ajan eikä kanta välttämättä hyväksy tyhjää päivää.
 */
export function datelessTasksAllowed(isOpen = columnGateOpen) {
  return isOpen('MENTAL_LOAD_FIELDS') && isOpen('TASK_EXTENDED_FIELDS');
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
  locationRules: false,
  /**
   * Migraatio 0012 — EI AJETTU.
   * Ks. supabase/migrations/0012_life_alignment.sql.
   *
   * Suunta (Life Alignment): neljä uutta taulua. Portin ollessa kiinni
   * elämänalueet, kapasiteetti, kirjattu aika ja katsaukset elävät
   * istunnon muistissa, ja Suunta-näkymä kertoo sen käyttäjälle.
   */
  lifeAreas: false,
  weeklyCapacities: false,
  timeEntries: false,
  alignmentReviews: false,
  /**
   * Migraatio 0013 — EI AJETTU. Riippuu 0012:sta.
   * Ks. supabase/migrations/0013_alignment_reality.sql.
   *
   * Kaksi uutta taulua: käynnissä oleva ajastin (yksi käyttäjää kohti)
   * ja tehtävän/rutiinin/projektin Suunta-asetukset (kuormittavuus,
   * "tarkoituksella ilman aluetta", karkea arvio). Portin ollessa kiinni
   * ajastin säilyy laitteella (src/data/timerStore.js), asetukset
   * istunnon muistissa.
   */
  runningTimers: false,
  alignmentItemSettings: false,
  /**
   * Migraatio 0014 — EI AJETTU. Riippuu 0013:sta.
   * Ks. supabase/migrations/0014_daily_life.sql.
   *
   * Arjen käyttöjärjestelmä: kymmenen UUTTA TAULUA, ei yhtään muutosta
   * olemassa olevaan tauluun eikä yhtään sarakeporttia. Kaikki kymmenen
   * aukeavat yhdessä aallossa K. Portin ollessa kiinni paikat, menot,
   * asetukset, uni-, tapa- ja liikuntakirjaukset elävät istunnon
   * muistissa, ja käyttöliittymä kertoo sen käyttäjälle.
   */
  savedPlaces: false,
  placeAliases: false,
  calendarEvents: false,
  commuteObservations: false,
  lifeSettings: false,
  sleepLogs: false,
  habitPlans: false,
  habitEvents: false,
  exerciseSessions: false,
  wellbeingCheckins: false,
  /**
   * Migraatio 0015 — EI AJETTU. Riippuu 0014:stä.
   * Ks. supabase/migrations/0015_mental_load.sql ja docs/MENTAL-LOAD-CORE.md.
   *
   * Mielen kuorman keventäminen: suojattu aika (oma aika, vapaa-ajan
   * säännöt, loma) ja viikkosuunnitelma (sunnuntain nollaus, viikon
   * prioriteetit). Portin ollessa kiinni ne elävät istunnon muistissa,
   * ja käyttöliittymä kertoo sen käyttäjälle.
   */
  protectedPeriods: false,
  weeklyPlans: false
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

/**
 * Onko migraatio 0012 ajettu `goals.life_area_id`-sarakkeen osalta?
 *
 * PRODUCTION GATE, sarakeportti — sama kuvio kuin GOAL_PLANNING_FIELDS.
 *
 * `goals` on TUOTANNOSSA AUKI ja siinä on käyttäjän dataa. Sarakkeen
 * lähettäminen ennen migraatiota — NULLINAKIN — kaataisi jokaisen
 * tavoitteen tallennuksen koodilla 42703.
 *
 * false = tavoitteen elämänalue elää istunnon muistissa.
 * true  = se tallentuu. Vasta kun 0012 on ajettu ja varmistettu.
 */
export const GOAL_LIFE_AREA_FIELD = false;

/**
 * Onko migraatio 0013 ajettu 0012:n taulujen uusien sarakkeiden osalta?
 *
 * PRODUCTION GATE, sarakeportti — sama kuvio kuin GOAL_LIFE_AREA_FIELD.
 *
 * false = seuraavia sarakkeita EI ole kannassa:
 *           time_entries.project_id, routine_id, occurrence_date,
 *                        operation_id, started_at, ended_at
 *           weekly_capacities.energy_budget_minutes
 *           alignment_reviews.policy_version, reflection_answers
 *         Ne elävät istunnon muistissa, ja ajastimella tehty kirjaus
 *         tallentuu lähteellä 'manual' (0012 sallii vain sen).
 * true  = ne tallentuvat.
 *
 * MIKSI ERILLÄÄN TABLES-porteista: 0012:n taulut voivat olla auki ilman
 * 0013:a. Ilman tätä porttia jokainen kirjaus kaatuisi tuntemattomaan
 * sarakkeeseen (42703) heti kun timeEntries-portti avataan.
 *
 * Tämä saa mennä arvoon true VASTA kun migraatio 0013 on ajettu.
 */
export const ALIGNMENT_REALITY_FIELDS = false;

/**
 * Onko migraatio 0015 ajettu tasks- ja life_areas-taulujen osalta?
 *
 * PRODUCTION GATE, sarakeportti — sama kuvio kuin GOAL_PLANNING_FIELDS.
 *
 * false = seuraavia sarakkeita EI ole kannassa:
 *           tasks.horizon, waiting_on, follow_up_date, archived_at,
 *                 reschedule_count, original_date
 *           life_areas.kind
 *         Ne elävät istunnon muistissa, eikä päivätöntä tehtävää sallita.
 * true  = ne tallentuvat, ja tehtävän saa tallentaa ilman päivää.
 *
 * MIKSI ERITYISEN TARKKA PORTTI: `tasks` on TUOTANNOSSA AUKI ja siinä on
 * käyttäjän dataa. Sarakkeiden lähettäminen ennen migraatiota — NULLINAKIN
 * — kaataisi JOKAISEN tehtävän tallennuksen koodilla 42703.
 *
 * Tämä saa mennä arvoon true VASTA kun migraatio 0015 on ajettu.
 */
export const MENTAL_LOAD_FIELDS = false;

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
  return columnGateOpen('TASK_EXTENDED_FIELDS')
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
  return columnGateOpen('BILL_PAYMENT_FIELDS') ? [] : ['payee', 'iban', 'reference'];
}

/**
 * Tavoitteen kentät, jotka eivät vielä säily tallennuksen yli.
 * Käyttöliittymä kertoo tämän käyttäjälle sen sijaan, että
 * teeskentelisi tallentavansa mittarin.
 */
export function volatileGoalFields() {
  return columnGateOpen('GOAL_PLANNING_FIELDS')
    ? []
    : ['metric', 'unit', 'baselineValue', 'currentValue', 'targetValue',
       'measuredOn', 'savingsGoalId'];
}

/** Suunta 2 -kentät (0013): mitkä eivät vielä säily tallennuksen yli. */
export function volatileAlignmentRealityFields() {
  return columnGateOpen('ALIGNMENT_REALITY_FIELDS')
    ? []
    : ['timeEntry.projectId', 'timeEntry.routineId', 'timeEntry.occurrenceDate',
       'timeEntry.operationId', 'timeEntry.startedAt', 'timeEntry.endedAt',
       'weeklyCapacity.energyBudgetMinutes', 'alignmentReview.policyVersion',
       'alignmentReview.reflectionAnswers'];
}

/** Tavoitteen elämänalue: säilyykö se tallennuksen yli? */
export function volatileGoalAlignmentFields() {
  return columnGateOpen('GOAL_LIFE_AREA_FIELD') ? [] : ['lifeAreaId'];
}

/** Tehtävän kentät, jotka eivät vielä säily tallennuksen yli. */
export function volatileTaskPlanningFields() {
  return columnGateOpen('GOAL_PLANNING_FIELDS') ? [] : ['milestoneId', 'dependsOn'];
}

/** Mielen kuorman kentät (0015): mitkä eivät vielä säily tallennuksen yli. */
export function volatileMentalLoadFields() {
  return datelessTasksAllowed()
    ? []
    : ['task.horizon', 'task.waitingOn', 'task.followUpDate', 'task.archivedAt',
       'task.rescheduleCount', 'task.originalDate', 'lifeArea.kind'];
}

// =====================================================================
// AJONAIKAINEN SKEEMATARKISTUS
// =====================================================================
//
// Portit yllä ovat käännösaikaisia, ja release-työkalut (tools/release/
// state.mjs) lukevat niiden literaalit tästä tiedostosta. Ne pysyvät
// ennallaan. Alla oleva kerros voi vain LASKEA niitä ajon aikana, kun
// kanta on sovellusta jäljessä (ks. src/data/schemaRuntime.js).
//
//   hasTable(), pendingTables()   käännösaikaiset (työkalut ja testit)
//   isTableAvailable(key)         käännösaikainen JA ajonaikainen
//   columnGateOpen(name)          käännösaikainen JA ajonaikainen
//
// Repositoriot kysyvät kahta jälkimmäistä. Ks. docs/SCHEMA.md,
// "Ajonaikainen skeematarkistus".

/**
 * Käännösaikaiset sarakeportit nimen mukaan.
 *
 * TASK_LINK_FIELDS ei ole oma literaalinsa: tehtävän liitossarakkeet
 * syntyvät samassa migraatiossa (0004) kuin goals- ja projects-taulut,
 * joten ne ovat auki täsmälleen silloin kun molemmat taulut ovat.
 */
export const COMPILE_COLUMN_GATES = Object.freeze({
  TASK_EXTENDED_FIELDS,
  TASK_LINK_FIELDS: TABLES.goals === true && TABLES.projects === true,
  BILL_PAYMENT_FIELDS,
  GOAL_PLANNING_FIELDS,
  GOAL_MAINTENANCE_MODE,
  GOAL_LIFE_AREA_FIELD,
  ALIGNMENT_REALITY_FIELDS,
  MENTAL_LOAD_FIELDS
});

/** Käännösaikaiset portit yhtenä arvona puhtaalle ytimelle. */
export const COMPILE_GATES = Object.freeze({ tables: TABLES, columns: COMPILE_COLUMN_GATES });

/**
 * Onko taulu käytettävissä kannassa JUURI NYT (lukeminen ja kirjoitus)?
 * false aina kun käännösaikainen portti on kiinni.
 */
export function isTableAvailable(key) {
  return hasTable(key) && !isTableLowered(key);
}

/**
 * Onko sarakeportti auki JUURI NYT? false aina kun käännösaikainen on kiinni.
 */
export function columnGateOpen(name) {
  return COMPILE_COLUMN_GATES[name] === true && !isColumnGateLowered(name);
}

/**
 * Mitä kanta vaatii jokaiselta käännösaikaiselta portilta.
 *
 * YKSI RIVI = YKSI TARKISTETTAVA SARAKEJOUKKO. Sarakkeet ovat täsmälleen ne,
 * jotka sovellus kirjoittaa (tai ydintaulussa suodattaa). Testi
 * tests/schema-compat-matrix.test.mjs vertaa ne migraatioihin ja
 * repositorioiden rivimuunnoksiin.
 *
 *   kind: 'table'    TABLES-portti; puute -> taulu vain luettavaksi tai pois
 *   kind: 'column'   sarakeportti; puute -> sarakkeet jätetään pois
 *   core: true       ydin; puute -> huoltotila
 *   lowerAs: 'readonly'  sarakeportin puute tekee taulusta vain luettavan
 *
 * Jokainen migraatio on YKSI transaktio (tasan yksi COMMIT), joten yhden
 * sarakejoukon löytyminen todistaa koko migraation. Siksi
 * GOAL_MAINTENANCE_MODE (0010:n tilarajoite) tarkistetaan saman
 * migraation sarakkeesta goals.metric.
 */
export const SCHEMA_REQUIREMENTS = Object.freeze([
  req({ id: '0001.tasks', migration: '0001', kind: 'table', table: 'tasks', core: true,
    columns: ['user_id', ...TASK_COLUMNS_CORE] }),
  req({ id: '0001.profile', migration: '0001', kind: 'table', table: 'profile', core: true,
    columns: ['id', 'age', 'weight_kg', 'height_cm', 'sleep_target_hours', 'default_wake_time',
      'commute_minutes', 'routine_minutes'] }),
  req({ id: '0002.tasks', migration: '0002', kind: 'column', table: 'tasks', gate: 'TASK_EXTENDED_FIELDS',
    columns: TASK_COLUMNS_EXTENDED.filter(column => !TASK_COLUMNS_CORE.includes(column)) }),

  req({ id: '0003.routines', migration: '0003', kind: 'table', table: 'routines', tableKey: 'routines',
    columns: ['id', 'title', 'description', 'category', 'priority', 'duration_minutes', 'recurrence_type',
      'recurrence_weekdays', 'preferred_time', 'scheduling', 'active', 'goal_id', 'start_date', 'end_date'] }),
  req({ id: '0003.routine_exceptions', migration: '0003', kind: 'table', table: 'routine_exceptions',
    tableKey: 'routineExceptions',
    columns: ['id', 'routine_id', 'date', 'type', 'time', 'duration_minutes', 'title', 'note'] }),

  req({ id: '0004.goals', migration: '0004', kind: 'table', table: 'goals', tableKey: 'goals',
    columns: ['id', 'title', 'description', 'category', 'priority', 'status', 'target_date',
      'progress_mode', 'manual_progress', 'parent_goal_id', 'project_id'] }),
  req({ id: '0004.projects', migration: '0004', kind: 'table', table: 'projects', tableKey: 'projects',
    columns: ['id', 'name', 'description', 'category', 'priority', 'status', 'goal_id', 'start_date',
      'deadline'] }),
  req({ id: '0004.tasks', migration: '0004', kind: 'column', table: 'tasks', gate: 'TASK_LINK_FIELDS',
    columns: [...TASK_COLUMNS_LINKS] }),

  req({ id: '0005.notification_preferences', migration: '0005', kind: 'table',
    table: 'notification_preferences', tableKey: 'notificationPreferences',
    columns: ['id', 'enabled', 'task_lead_minutes', 'routine_lead_minutes', 'daily_plan_time',
      'evening_review_time', 'daily_plan_enabled', 'evening_review_enabled',
      'deadline_warnings_enabled', 'max_per_day', 'quiet_hours_from', 'quiet_hours_to'] }),

  req({ id: '0006.wellbeing_entries', migration: '0006', kind: 'table', table: 'wellbeing_entries',
    tableKey: 'wellbeing', columns: ['id', 'date', 'energy', 'mood', 'stress', 'sleep_hours', 'note'] }),

  req({ id: '0007.bills', migration: '0007', kind: 'table', table: 'bills', tableKey: 'bills',
    columns: ['id', 'name', 'amount_minor', 'currency', 'due_date', 'status', 'paid_date', 'category',
      'task_id', 'recurring_expense_id', 'note'] }),
  req({ id: '0007.recurring_expenses', migration: '0007', kind: 'table', table: 'recurring_expenses',
    tableKey: 'recurringExpenses',
    columns: ['id', 'name', 'amount_minor', 'currency', 'cadence', 'day_of_month', 'next_due_date',
      'category', 'active', 'note'] }),
  req({ id: '0007.savings_goals', migration: '0007', kind: 'table', table: 'savings_goals',
    tableKey: 'savingsGoals',
    columns: ['id', 'name', 'target_minor', 'current_minor', 'currency', 'target_date', 'note'] }),

  req({ id: '0008.ai_action_audit', migration: '0008', kind: 'table', table: 'ai_action_audit',
    tableKey: 'aiAudit',
    columns: ['id', 'occurred_at', 'input_summary', 'intent', 'risk', 'target_type', 'target_id',
      'proposal', 'confirmed', 'executed', 'result', 'error_code'] }),

  req({ id: '0009.transactions', migration: '0009', kind: 'table', table: 'transactions',
    tableKey: 'transactions',
    columns: ['id', 'kind', 'origin', 'amount_minor', 'currency', 'date', 'category', 'description',
      'note', 'source_kind', 'source_id'] }),
  req({ id: '0009.investments', migration: '0009', kind: 'table', table: 'investments',
    tableKey: 'investments',
    columns: ['id', 'name', 'symbol', 'kind', 'quantity', 'cost_basis_minor', 'current_value_minor',
      'valued_on', 'value_source', 'currency', 'target_value_minor', 'note'] }),
  req({ id: '0009.bills', migration: '0009', kind: 'column', table: 'bills', gate: 'BILL_PAYMENT_FIELDS',
    columns: ['payee', 'iban', 'reference'] }),

  req({ id: '0010.milestones', migration: '0010', kind: 'table', table: 'milestones',
    tableKey: 'milestones',
    columns: ['id', 'goal_id', 'title', 'description', 'target_date', 'status', 'order_index', 'rule',
      'reached_date'] }),
  req({ id: '0010.goals', migration: '0010', kind: 'column', table: 'goals', gate: 'GOAL_PLANNING_FIELDS',
    columns: ['metric', 'unit', 'baseline_value', 'current_value', 'target_value', 'measured_on',
      'savings_goal_id'] }),
  req({ id: '0010.tasks', migration: '0010', kind: 'column', table: 'tasks', gate: 'GOAL_PLANNING_FIELDS',
    columns: TASK_COLUMNS_PLANNING.filter(column => !TASK_COLUMNS_EXTENDED.includes(column)) }),
  req({ id: '0010.projects', migration: '0010', kind: 'column', table: 'projects',
    gate: 'GOAL_PLANNING_FIELDS', columns: ['milestone_id'] }),
  req({ id: '0010.goals_status', migration: '0010', kind: 'column', table: 'goals',
    gate: 'GOAL_MAINTENANCE_MODE', columns: ['metric'] }),
  // Suunnittelun puskuri (kapasiteettijarru, aalto L). Sarake on ollut
  // kannassa 0010:stä, mutta sillä ei ollut kirjoittajaa eikä lukijaa.
  req({ id: '0010.profile', migration: '0010', kind: 'column', table: 'profile',
    gate: 'GOAL_PLANNING_FIELDS', columns: ['planning_buffer_ratio'] }),

  req({ id: '0011.inbox_items', migration: '0011', kind: 'table', table: 'inbox_items',
    tableKey: 'inboxItems',
    columns: ['id', 'text', 'status', 'source', 'proposal', 'converted_kind', 'converted_id',
      'captured_at'] }),
  req({ id: '0011.reminders', migration: '0011', kind: 'table', table: 'reminders', tableKey: 'reminders',
    columns: ['id', 'title', 'target_type', 'target_id', 'trigger_type', 'due_date', 'due_time',
      'lead_minutes', 'status', 'escalate', 'alert_count', 'snooze_count', 'until_time', 'note'] }),
  req({ id: '0011.notices', migration: '0011', kind: 'table', table: 'notices', tableKey: 'notices',
    columns: ['id', 'notice_key', 'kind', 'level', 'status', 'title', 'reason', 'target_type',
      'target_id', 'created_date'] }),
  req({ id: '0011.travel_plans', migration: '0011', kind: 'table', table: 'travel_plans',
    tableKey: 'travelPlans',
    columns: ['id', 'title', 'origin', 'destination', 'arrival_date', 'arrival_time', 'mode',
      'travel_minutes', 'travel_source', 'estimated_at', 'preparation_minutes',
      'arrival_buffer_minutes', 'task_id', 'note'] }),
  req({ id: '0011.location_rules', migration: '0011', kind: 'table', table: 'location_rules',
    tableKey: 'locationRules', columns: ['id', 'place', 'trigger_type', 'message', 'active', 'task_id'] }),

  req({ id: '0012.life_areas', migration: '0012', kind: 'table', table: 'life_areas', tableKey: 'lifeAreas',
    columns: ['id', 'name', 'description', 'importance', 'target_minutes_per_week', 'category_key',
      'active', 'sort_order'] }),
  req({ id: '0012.weekly_capacities', migration: '0012', kind: 'table', table: 'weekly_capacities',
    tableKey: 'weeklyCapacities', columns: ['id', 'week_start', 'available_minutes', 'energy_level', 'note'] }),
  req({ id: '0012.time_entries', migration: '0012', kind: 'table', table: 'time_entries',
    tableKey: 'timeEntries',
    columns: ['id', 'entry_date', 'minutes', 'life_area_id', 'goal_id', 'task_id', 'source', 'note'] }),
  req({ id: '0012.alignment_reviews', migration: '0012', kind: 'table', table: 'alignment_reviews',
    tableKey: 'alignmentReviews',
    columns: ['id', 'week_start', 'snapshot_version', 'snapshot', 'reflection', 'adjustments',
      'completed_at'] }),
  req({ id: '0012.goals', migration: '0012', kind: 'column', table: 'goals', gate: 'GOAL_LIFE_AREA_FIELD',
    columns: ['life_area_id'] }),

  req({ id: '0013.running_timers', migration: '0013', kind: 'table', table: 'running_timers',
    tableKey: 'runningTimers',
    columns: ['id', 'target_kind', 'life_area_id', 'goal_id', 'task_id', 'project_id', 'routine_id',
      'occurrence_date', 'started_at', 'paused_at', 'paused_seconds', 'note'] }),
  req({ id: '0013.alignment_item_settings', migration: '0013', kind: 'table',
    table: 'alignment_item_settings', tableKey: 'alignmentItemSettings',
    columns: ['id', 'item_kind', 'item_id', 'energy_demand', 'alignment_opt_out', 'estimate_approximate'] }),
  // Aikakirjaukset nojaavat operation_id:n idempotenssiin (uniikkirajoite):
  // ilman saraketta uusinta voisi monistaa kirjauksen. Siksi puute tekee
  // time_entries-taulusta vain luettavan eikä sarakkeita vain jätetä pois.
  req({ id: '0013.time_entries', migration: '0013', kind: 'column', table: 'time_entries',
    tableKey: 'timeEntries', gate: 'ALIGNMENT_REALITY_FIELDS', lowerAs: 'readonly',
    columns: ['project_id', 'routine_id', 'occurrence_date', 'operation_id', 'started_at', 'ended_at'] }),
  req({ id: '0013.weekly_capacities', migration: '0013', kind: 'column', table: 'weekly_capacities',
    gate: 'ALIGNMENT_REALITY_FIELDS', columns: ['energy_budget_minutes'] }),
  req({ id: '0013.alignment_reviews', migration: '0013', kind: 'column', table: 'alignment_reviews',
    gate: 'ALIGNMENT_REALITY_FIELDS', columns: ['policy_version', 'reflection_answers'] }),

  // 0014: kymmenen uutta taulua, ei sarakeportteja. Sarakkeet = rivi-
  // muunnoksen avaimet (src/data/collectionsRepo.js).
  req({ id: '0014.saved_places', migration: '0014', kind: 'table', table: 'saved_places',
    tableKey: 'savedPlaces',
    columns: ['id', 'name', 'address', 'provider_place_id', 'area', 'travel_mode', 'usual_travel_minutes',
      'preparation_minutes', 'arrival_buffer_minutes', 'overhead_minutes', 'use_learned', 'note'] }),
  req({ id: '0014.place_aliases', migration: '0014', kind: 'table', table: 'place_aliases',
    tableKey: 'placeAliases', columns: ['id', 'place_id', 'alias', 'confirmations', 'last_confirmed_at'] }),
  req({ id: '0014.calendar_events', migration: '0014', kind: 'table', table: 'calendar_events',
    tableKey: 'calendarEvents',
    columns: ['id', 'title', 'event_date', 'start_time', 'end_time', 'duration_minutes', 'all_day', 'category',
      'location_text', 'place_id', 'travel_mode', 'travel_minutes', 'preparation_minutes',
      'arrival_buffer_minutes', 'overhead_minutes', 'recurrence_weekdays', 'recurrence_until', 'skip_dates',
      'goal_id', 'notes'] }),
  req({ id: '0014.commute_observations', migration: '0014', kind: 'table', table: 'commute_observations',
    tableKey: 'commuteObservations',
    columns: ['id', 'place_id', 'event_id', 'observed_on', 'weekday', 'planned_departure', 'actual_departure',
      'arrival_at', 'travel_minutes', 'provider_minutes', 'preparation_minutes', 'overhead_minutes',
      'arrival_result', 'source'] }),
  req({ id: '0014.life_settings', migration: '0014', kind: 'table', table: 'life_settings',
    tableKey: 'lifeSettings',
    columns: ['id', 'weekend_wake_shift_max_minutes', 'weekend_bed_shift_max_minutes', 'wind_down_minutes',
      'bedtime_target', 'arrival_buffer_minutes', 'guidance_style', 'speech_enabled', 'morning_brief_enabled',
      'reminder_offset_minutes', 'digest_enabled', 'digest_time', 'sleep_affects_capacity',
      'hourly_value_minor', 'currency', 'alarm', 'morning_routine', 'meal_rhythm', 'delivery'] }),
  req({ id: '0014.sleep_logs', migration: '0014', kind: 'table', table: 'sleep_logs', tableKey: 'sleepLogs',
    columns: ['id', 'wake_date', 'planned_bedtime', 'actual_bedtime', 'planned_wake', 'actual_wake', 'source',
      'kind', 'note'] }),
  req({ id: '0014.habit_plans', migration: '0014', kind: 'table', table: 'habit_plans', tableKey: 'habitPlans',
    columns: ['id', 'kind', 'name', 'min_interval_minutes', 'daily_target', 'baseline_per_day', 'steps',
      'reminder_delivery', 'unit_cost_minor', 'active'] }),
  req({ id: '0014.habit_events', migration: '0014', kind: 'table', table: 'habit_events', tableKey: 'habitEvents',
    columns: ['id', 'plan_id', 'occurred_at', 'action', 'note'] }),
  req({ id: '0014.exercise_sessions', migration: '0014', kind: 'table', table: 'exercise_sessions',
    tableKey: 'exerciseSessions',
    columns: ['id', 'session_date', 'kind', 'planned_minutes', 'actual_minutes', 'intensity', 'recovery_demand',
      'goal_id', 'note'] }),
  req({ id: '0014.wellbeing_checkins', migration: '0014', kind: 'table', table: 'wellbeing_checkins',
    tableKey: 'wellbeingCheckins', columns: ['id', 'date', 'motivation', 'control'] }),

  // 0015: kaksi uutta taulua ja yksi sarakeportti kahdelle olemassa olevalle
  // taululle (tasks on tuotannossa auki, life_areas 0012:sta).
  req({ id: '0015.protected_periods', migration: '0015', kind: 'table', table: 'protected_periods',
    tableKey: 'protectedPeriods',
    columns: ['id', 'kind', 'recurrence', 'title', 'start_date', 'end_date', 'weekdays', 'start_time',
      'end_time', 'target_minutes', 'strength', 'active', 'note'] }),
  req({ id: '0015.weekly_plans', migration: '0015', kind: 'table', table: 'weekly_plans',
    tableKey: 'weeklyPlans', columns: ['id', 'week_start', 'priorities', 'planned_minutes', 'closed_at', 'note'] }),
  req({ id: '0015.tasks', migration: '0015', kind: 'column', table: 'tasks', gate: 'MENTAL_LOAD_FIELDS',
    columns: [...TASK_COLUMNS_MENTAL_LOAD] }),
  req({ id: '0015.life_areas', migration: '0015', kind: 'column', table: 'life_areas', gate: 'MENTAL_LOAD_FIELDS',
    columns: ['kind'] })
]);

function req(spec) {
  return Object.freeze({ core: false, gate: null, tableKey: null, lowerAs: null, ...spec,
    columns: Object.freeze([...spec.columns]) });
}

/** Vaatimukset, jotka tämä käännös tarkistaa: ydin ja auki olevat portit. */
export function openRequirements(compile = COMPILE_GATES) {
  return SCHEMA_REQUIREMENTS.filter(requirement => requirement.core
    || (requirement.kind === 'table' ? compile.tables[requirement.tableKey] === true
      : compile.columns[requirement.gate] === true));
}

/**
 * Laske kyvykkyys uudelleen tallennetuista tuloksista ja julkaise se.
 * Kutsutaan tarkistuksen jälkeen ja kannan skeemavirheestä.
 */
export function recomputeSchemaCapabilities() {
  return setCapabilities(computeCapabilities({
    requirements: SCHEMA_REQUIREMENTS, compile: COMPILE_GATES,
    results: currentResults(), verified: isVerified()
  }));
}

/**
 * Jätä pois sarakkeet, joiden portti on laskettu ajon aikana.
 *
 * Käännösaikaisesti kiinni olevan portin sarakkeet eivät ole rivissä
 * alunperinkään (rivimuunnoksen ehdot); tämä poistaa ne, jotka kanta on
 * tarkistuksessa ilmoittanut puuttuviksi. `isOpen` on testejä varten.
 */
export function stripLoweredColumns(table, row, isOpen = columnGateOpen) {
  let out = row;
  for (const requirement of SCHEMA_REQUIREMENTS) {
    if (requirement.kind !== 'column' || requirement.table !== table || isOpen(requirement.gate)) continue;
    for (const column of requirement.columns) {
      if (!Object.prototype.hasOwnProperty.call(out, column)) continue;
      if (out === row) out = { ...row };
      delete out[column];
    }
  }
  return out;
}

/** Käyttäjälle: ominaisuutta ei vielä ole palvelimella. Ei taulujen nimiä. */
export const SCHEMA_REFUSAL_MESSAGE = 'Tämä ominaisuus ei ole vielä käytössä palvelimella. Muutosta ei tallennettu.';
/** Käyttäjälle: ydin puuttuu, mitään ei kirjoiteta. */
export const MAINTENANCE_REFUSAL_MESSAGE = 'Palvelussa on huoltokatko. Muutosta ei tallennettu.';

/**
 * Kieltäytyminen ENNEN verkkokutsua, tai null jos kirjoitus saa lähteä.
 *
 * Huoltotila estää kaiken. Ajon aikana laskettu taulu (puuttuu tai vain
 * luettava) estää oman kirjoituksensa: olemassa oleva tieto säilyy
 * näkyvissä, eikä mitään katoa hiljaa -- käyttäjä näkee syyn.
 *
 * @param {string|null} tableKey TABLES-avain, tai null ydintaululle
 */
export function writeRefusal(tableKey = null) {
  if (!isWritable()) return failWith(ERROR_CODE.PERSISTENCE_UNAVAILABLE, MAINTENANCE_REFUSAL_MESSAGE);
  if (tableKey && hasTable(tableKey) && isTableLowered(tableKey)) {
    return failWith(ERROR_CODE.PERSISTENCE_UNAVAILABLE, SCHEMA_REFUSAL_MESSAGE);
  }
  return null;
}

/** Puuttuuko taulu ajon aikana kokonaan (lataus = tyhjä, ei virhe)? */
export function isTableMissing(tableKey) {
  return hasTable(tableKey) && tableState(tableKey) === 'missing';
}

const MISSING_TABLE_CODES = new Set(['PGRST205', '42P01']);
const MISSING_COLUMN_CODES = new Set(['PGRST204', '42703']);
/**
 * Kirjoituksen virheet, jotka ovat pysyviä istunnon ajan. PGRST205 puuttuu
 * tarkoituksella: se tulee PostgRESTin skeemavälimuistista, jota myös
 * tarkistuksen GET käyttää, joten tarkistus näkee saman puutteen.
 */
const STICKY_WRITE_CODES = new Set(['PGRST204', '42703', '42P01']);

/** Sarakkeen nimi PostgRESTin tai PostgreSQL:n viestistä, tai null. */
function columnFromMessage(message) {
  const text = String(message || '');
  const patterns = [
    /Could not find the '([a-z0-9_]+)' column/i,
    /column "?([a-z0-9_]+)"? of relation/i,
    /column [a-z0-9_]+\.([a-z0-9_]+) does not exist/i,
    /column "([a-z0-9_]+)" does not exist/i
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) return match[1];
  }
  return null;
}

/**
 * REAKTIIVINEN KERROS: kanta vastasi skeemavirheellä kesken istunnon.
 *
 * PGRST204/42703 laskee sen sarakeportin, jolle puuttuva sarake kuuluu.
 * PGRST205/42P01 laskee taulun. Ydintä ei lasketa täältä: yksittäinen
 * viesti ei riitä huoltotilaan -- uusi tarkistus päättää. 23514 (CHECK)
 * ei koskaan laske mitään: se on myös tavallinen validointivirhe.
 *
 * YDINTAULUN PUUTTUMINEN (tasks, profile; PGRST205/42P01) ei laske
 * mitään: se on tarkistuksen huoltotila, ja sen sarakeporttien
 * laskeminen jäisi voimaan huoltokatkon jälkeenkin (tehtävät
 * tallentuisivat ilman kuvausta, kestoa ja määräaikaa sivun lataukseen
 * asti). Uusi tarkistus pyydetään silti.
 *
 * KIRJOITUKSEN PUUTE ON PYSYVÄ ISTUNNON AJAN (PGRST204, 42703, 42P01):
 * tarkistuksen GET voi nähdä vaatimuksen kunnossa, vaikka sama kirjoitus
 * kaatuu yhä (PostgRESTin vanhentunut skeemavälimuisti, liipaisin tai
 * näkymä). Jos "ok" kumoaisi sen, kehä pyörisi 30 s välein: lasku ->
 * tarkistus ok -> kumous -> uusi lataus ja toisto -> sama virhe. Vain
 * LUKEMISEN puute (ja PGRST205, jonka tarkistus näkee samasta välimuistista)
 * kumoutuu, kun myöhempi tarkistus näkee vaatimuksen kunnossa (ks.
 * schemaRuntime.js). Palauttaa true, jos jokin laski. Ei heitä.
 *
 * @param {string} table kannan taulu
 * @param {unknown} error Supabase-virhe (tai AppError, jonka cause se on)
 * @param {string[]} [payloadKeys] lähetetyt sarakkeet, jos viestistä ei selviä
 * @param {{write?: boolean}} [options] write: virhe tuli kirjoituksesta
 *   (oletus: payloadKeys ei ole tyhjä). Kirjoitus ilman payloadin avaimia
 *   (lisäys, poisto, upsert) kertoo sen tällä.
 */
export function noteSchemaError(table, error, payloadKeys = [], options = {}) {
  try {
    const write = options && typeof options.write === 'boolean'
      ? options.write : Array.isArray(payloadKeys) && payloadKeys.length > 0;
    const cause = (error && error.cause) || error || {};
    const code = String(cause.code || '');
    if (!MISSING_TABLE_CODES.has(code) && !MISSING_COLUMN_CODES.has(code)) return false;

    if (MISSING_TABLE_CODES.has(code)
      && SCHEMA_REQUIREMENTS.some(requirement => requirement.core && requirement.table === table)) {
      requestReprobe('schema_error');
      return false;
    }

    const open = openRequirements().filter(requirement => requirement.table === table && !requirement.core);
    const failures = {};
    if (MISSING_TABLE_CODES.has(code)) {
      for (const requirement of open) failures[requirement.id] = PROBE_RESULT.MISSING_TABLE;
    } else {
      const column = columnFromMessage(cause.message) || columnFromMessage(cause.details);
      const suspects = column ? [column] : payloadKeys;
      for (const requirement of open) {
        if (requirement.kind !== 'column') continue;
        if (requirement.columns.some(name => suspects.includes(name))) {
          failures[requirement.id] = PROBE_RESULT.MISSING_COLUMN;
        }
      }
      // Puuttuva sarake kuuluu taulun perusjoukkoon: taulu vain luettavaksi.
      if (Object.keys(failures).length === 0 && column) {
        for (const requirement of open) {
          if (requirement.kind === 'table' && requirement.columns.includes(column)) {
            failures[requirement.id] = PROBE_RESULT.MISSING_COLUMN;
          }
        }
      }
    }

    // PGRST204 tulee aina kirjoituksesta (payloadin sarake), joten se on
    // pysyvä, vaikka kutsuja ei kertoisi kirjoittavansa.
    const sticky = code === 'PGRST204' || (write && STICKY_WRITE_CODES.has(code));
    const changed = recordReactiveFailures(failures, { sticky })
      && recomputeSchemaCapabilities();
    // 'lowered' kertoo sovelluskerrokselle, että odottavat muutokset voi
    // lähettää uudelleen heti tarkistuksen jälkeen (ks. src/app/schemaStatus.js).
    requestReprobe(changed ? 'lowered' : 'schema_error');
    return Boolean(changed);
  } catch {
    return false;
  }
}
