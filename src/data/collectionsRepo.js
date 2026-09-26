// Rutiinien, tavoitteiden, projektien ja hyvinvoinnin tallennus.
//
// KAKSI TOTEUTUSTA SAMAN RAJAPINNAN TAKANA
//
//   Taulu olemassa (migraatio ajettu)  -> Supabase, käyttäjäkohtaisesti rajattu
//   Taulu puuttuu                      -> muistivarasto, katoaa sivun latauksessa
//
// Valinta tehdään `src/data/schema.js`-lipuista. Sovelluskerros ei tiedä
// kumpaa se käyttää — migraation jälkeen vaihto on yhden lipun muutos eikä
// vaadi muutoksia kutsupaikkoihin.
//
// ⚠️ Kun taulu puuttuu, tieto EI SÄILY. Käyttöliittymä kertoo sen käyttäjälle.
// Vaihtoehto — teeskennellä tallennusta — olisi pahempaa kuin puute.
//
// TURVALLISUUS: Supabase-polulla jokainen kysely rajataan requireUserId():llä
// ja `user_id` jätetään aina pois kirjoituksesta. Omistajuuden asettaa
// tietokanta (DEFAULT auth.uid()) ja RLS valvoo sitä.

import { getClient } from './client.js';
import { requireUserId } from './session.js';
import {
  hasTable, BILL_PAYMENT_FIELDS, GOAL_PLANNING_FIELDS, GOAL_LIFE_AREA_FIELD,
  ALIGNMENT_REALITY_FIELDS, columnGateOpen, isTableMissing, writeRefusal,
  stripLoweredColumns, noteSchemaError
} from './schema.js';
import { createMemoryRepository } from './memoryStore.js';
import { ok, fail, failWith, ERROR_CODE } from '../lib/result.js';
import { normalizeRoutine, normalizeException } from '../domain/routine.js';
import { normalizeGoal, isStorableGoalStatus } from '../domain/goal.js';
import { normalizeProject } from '../domain/project.js';
import { normalizeWellbeingEntry } from '../domain/wellbeing.js';
import {
  normalizeBill, normalizeRecurringExpense, normalizeSavingsGoal
} from '../domain/finance.js';
import { normalizeAuditEntry } from '../domain/audit.js';
import { normalizeTransaction } from '../domain/transactions.js';
import { normalizeHolding } from '../domain/investments.js';
import { normalizeMilestone } from '../domain/milestone.js';
import { normalizeInboxItem } from '../domain/inbox.js';
import { normalizeReminder } from '../domain/reminder.js';
import { normalizeNotice } from '../domain/notificationCenter.js';
import { normalizeTravelPlan, normalizeLocationRule } from '../domain/travel.js';
import { normalizeLifeArea } from '../domain/lifeArea.js';
import { normalizeWeeklyCapacity } from '../domain/weeklyCapacity.js';
import { normalizeTimeEntry } from '../domain/timeEntry.js';
import { normalizeAlignmentReview } from '../domain/alignmentReview.js';
import { normalizeTimer } from '../domain/timer.js';
import { normalizeItemSettings } from '../domain/alignmentItemSettings.js';

/** Kentät, joita client ei saa koskaan lähettää. */
const SERVER_OWNED = Object.freeze(['user_id', 'created_at', 'updated_at']);

function assertClientSafe(row) {
  for (const field of SERVER_OWNED) {
    if (Object.prototype.hasOwnProperty.call(row, field)) {
      throw new Error('Client ei saa asettaa kenttaa: ' + field);
    }
  }
  return row;
}

/**
 * Luo repositorio, joka käyttää Supabasea jos taulu on olemassa ja
 * muistivarastoa muuten.
 *
 * @param {object} config
 * @param {string} config.table       Taulun nimi tietokannassa
 * @param {string} config.schemaKey   Avain schema.js:n TABLES-oliossa
 * @param {Function} config.normalize Domain-normalisointi
 * @param {Function} config.toRow     Domain -> kannan rivi
 * @param {Function} config.fromRow   Kannan rivi -> domain
 * @param {Function} [config.guardWrite] normalisoitu -> kieltäytyminen tai null
 *   (arvot, joita kanta ei vielä hyväksy; tarkistetaan ennen verkkoa)
 *
 * AJONAIKAINEN SKEEMATARKISTUS (src/data/schema.js, schemaRuntime.js):
 * käännösaikainen portti valitsee yhä kannan ja muistin välillä. Jos kanta
 * on sovellusta jäljessä, auki oleva portti EI putoa muistiin (se
 * teeskentelisi tallentavansa) vaan:
 *
 *   taulu puuttuu        lataus = tyhjä lista, kirjoitus torjutaan
 *   sarakkeita puuttuu   lataus toimii, kirjoitus torjutaan (vain luku)
 *   sarakeportti laski   sarakkeet jätetään pois, kirjoitus toimii
 *   huoltotila           kirjoitus torjutaan
 *
 * Torjunta tapahtuu ENNEN verkkokutsua ja kertoo syyn käyttäjälle.
 */
export function createRepository({ table, schemaKey, normalize, toRow, fromRow, guardWrite = null }) {
  const memory = createMemoryRepository({ normalize, name: table });

  const usesDatabase = () => hasTable(schemaKey);
  const refusal = normalized => writeRefusal(schemaKey) || (guardWrite ? guardWrite(normalized) : null);

  return {
    table,
    schemaKey,

    /** Säilyykö tieto tallennuksen yli tällä hetkellä? */
    isPersistent: () => usesDatabase(),

    /** Muistivarasto — vain testejä ja uloskirjautumista varten. */
    memory,

    /**
     * Rivimuunnokset tarkastelua varten.
     *
     * Portin ollessa false tietokantapolkua ei voi ajaa, joten sen
     * lähettämää payloadia ei voi todentaa ajamalla. Tämä paljastaa
     * muunnoksen sellaisenaan, jotta testi voi tarkistaa TÄSMÄLLEEN
     * mitä kantaan lähtisi portin auettua — ilman että porttia
     * avataan.
     *
     * Vain luku: nämä ovat samat funktiot joita insert ja update
     * käyttävät, eivät kopio.
     */
    mapping: Object.freeze({ toRow, fromRow, normalize }),

    async list() {
      if (!usesDatabase()) return memory.list();
      // Taulua ei ole kannassa (ajon aikana todettu): tyhjä ja kelvollinen
      // tulos, ei "lataus epäonnistui, tarkista yhteys" -- päivitys ei
      // auttaisi, ja tyhjässä taulussa ei ole mitään kadonnutta.
      if (isTableMissing(schemaKey)) return ok([]);
      try {
        const { data, error } = await getClient()
          .from(table)
          .select('*')
          .eq('user_id', requireUserId());
        if (error) {
          noteSchemaError(table, error);
          return fail('Tietojen lataus ei onnistunut.', { cause: error, code: table + '.list' });
        }
        return ok((data || []).map(fromRow));
      } catch (cause) {
        return fail('Tietojen lataus ei onnistunut.', { cause, code: table + '.list' });
      }
    },

    async insert(entity) {
      const normalized = normalize(entity);
      if (!usesDatabase()) return memory.insert(normalized);
      const refused = refusal(normalized);
      if (refused) return refused;
      try {
        const { error } = await getClient()
          .from(table)
          .insert(stripLoweredColumns(table, assertClientSafe(toRow(normalized))));
        if (error) {
          noteSchemaError(table, error, Object.keys(toRow(normalized)));
          return fail('Tallennus ei onnistunut.', { cause: error, code: table + '.insert' });
        }
        return ok(normalized);
      } catch (cause) {
        return fail('Tallennus ei onnistunut.', { cause, code: table + '.insert' });
      }
    },

    async update(entity) {
      const normalized = normalize(entity);
      if (!usesDatabase()) return memory.update(normalized);
      const refused = refusal(normalized);
      if (refused) return refused;
      try {
        const { error } = await getClient()
          .from(table)
          .update(stripLoweredColumns(table, assertClientSafe(toRow(normalized))))
          .eq('user_id', requireUserId())
          .eq('id', normalized.id);
        if (error) {
          noteSchemaError(table, error, Object.keys(toRow(normalized)));
          return fail('Muutoksen tallennus ei onnistunut.', { cause: error, code: table + '.update' });
        }
        return ok(normalized);
      } catch (cause) {
        return fail('Muutoksen tallennus ei onnistunut.', { cause, code: table + '.update' });
      }
    },

    async remove(id) {
      if (!usesDatabase()) return memory.remove(id);
      const refused = writeRefusal(schemaKey);
      if (refused) return refused;
      try {
        const { error } = await getClient()
          .from(table)
          .delete()
          .eq('user_id', requireUserId())
          .eq('id', id);
        if (error) {
          noteSchemaError(table, error);
          return fail('Poisto ei onnistunut.', { cause: error, code: table + '.delete' });
        }
        return ok({ id });
      } catch (cause) {
        return fail('Poisto ei onnistunut.', { cause, code: table + '.delete' });
      }
    },

    /** Tyhjennä muistivarasto. Kutsutaan uloskirjautumisessa. */
    clear() {
      memory.clear();
    }
  };
}

// ------------------------------------------------------------- rutiinit

export const routinesRepo = createRepository({
  table: 'routines',
  schemaKey: 'routines',
  normalize: normalizeRoutine,
  toRow: routine => ({
    id: routine.id,
    title: routine.title,
    description: routine.description,
    category: routine.category,
    priority: routine.priority,
    duration_minutes: routine.durationMinutes,
    recurrence_type: routine.recurrence.type,
    recurrence_weekdays: routine.recurrence.weekdays,
    preferred_time: routine.preferredTime,
    scheduling: routine.scheduling,
    active: routine.active,
    goal_id: routine.goalId,
    start_date: routine.startDate,
    end_date: routine.endDate
  }),
  fromRow: row => normalizeRoutine({
    id: row.id,
    title: row.title,
    description: row.description,
    category: row.category,
    priority: row.priority,
    durationMinutes: row.duration_minutes,
    recurrence: { type: row.recurrence_type, weekdays: row.recurrence_weekdays },
    preferredTime: row.preferred_time,
    scheduling: row.scheduling,
    active: row.active,
    goalId: row.goal_id,
    startDate: row.start_date,
    endDate: row.end_date,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  })
});

export const routineExceptionsRepo = createRepository({
  table: 'routine_exceptions',
  schemaKey: 'routineExceptions',
  normalize: normalizeException,
  toRow: exception => ({
    id: exception.id,
    routine_id: exception.routineId,
    date: exception.date,
    type: exception.type,
    time: exception.time,
    duration_minutes: exception.durationMinutes,
    title: exception.title,
    note: exception.note
  }),
  fromRow: row => normalizeException({
    id: row.id,
    routineId: row.routine_id,
    date: row.date,
    type: row.type,
    time: row.time,
    durationMinutes: row.duration_minutes,
    title: row.title,
    note: row.note
  })
});

// ----------------------------------------------------------- tavoitteet

export const goalsRepo = createRepository({
  table: 'goals',
  schemaKey: 'goals',
  normalize: normalizeGoal,
  // YLLÄPITOTILA vaatii migraation 0010 (goals_status_check). Ennen sitä
  // arvoa ei lähetetä lainkaan: kanta hylkäisi sen koodilla 23514.
  guardWrite: goal => (isStorableGoalStatus(goal.status, {
    maintenanceAllowed: columnGateOpen('GOAL_MAINTENANCE_MODE')
  }) ? null : failWith(ERROR_CODE.VALIDATION_ERROR,
    'Ylläpitotila ei ole vielä käytössä. Valitse tavoitteelle toinen tila.')),
  toRow: goal => ({
    id: goal.id,
    title: goal.title,
    description: goal.description,
    category: goal.category,
    priority: goal.priority,
    status: goal.status,
    target_date: goal.targetDate,
    progress_mode: goal.progressMode,
    manual_progress: goal.manualProgress,
    parent_goal_id: goal.parentGoalId,
    project_id: goal.projectId,

    // MITTARI JA SÄÄSTÖKYTKENTÄ JÄTETÄÄN POIS, JOS SARAKKEITA EI OLE.
    //
    // `goals` on TUOTANNOSSA AUKI ja siinä on käyttäjän dataa. Näiden
    // lähettäminen — NULLINAKIN — kaataisi jokaisen tavoitteen
    // tallennuksen koodilla 42703, myös niiden jotka toimivat tänään.
    // Sama kuvio kuin taskColumns() ja BILL_PAYMENT_FIELDS.
    ...(GOAL_PLANNING_FIELDS ? {
      metric: goal.metric,
      unit: goal.unit,
      baseline_value: goal.baselineValue,
      current_value: goal.currentValue,
      target_value: goal.targetValue,
      measured_on: goal.measuredOn,
      savings_goal_id: goal.savingsGoalId
    } : {}),

    // ELÄMÄNALUE (0012) jätetään pois kunnes sarake on olemassa. Sama
    // syy kuin yllä: goals on tuotannossa auki.
    ...(GOAL_LIFE_AREA_FIELD ? { life_area_id: goal.lifeAreaId } : {})
  }),
  fromRow: row => normalizeGoal({
    id: row.id,
    title: row.title,
    description: row.description,
    category: row.category,
    priority: row.priority,
    status: row.status,
    targetDate: row.target_date,
    progressMode: row.progress_mode,
    manualProgress: row.manual_progress,
    parentGoalId: row.parent_goal_id,
    projectId: row.project_id,
    // Lukeminen on turvallista kummassakin tilassa: ennen migraatiota
    // kenttää ei ole rivissä, jolloin arvo on undefined ja
    // normalizeGoal tekee siitä nullin.
    metric: row.metric,
    unit: row.unit,
    baselineValue: row.baseline_value,
    currentValue: row.current_value,
    targetValue: row.target_value,
    measuredOn: row.measured_on,
    savingsGoalId: row.savings_goal_id,
    lifeAreaId: row.life_area_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  })
});

// ------------------------------------------------------------ projektit

export const projectsRepo = createRepository({
  table: 'projects',
  schemaKey: 'projects',
  normalize: normalizeProject,
  toRow: project => ({
    id: project.id,
    name: project.name,
    description: project.description,
    category: project.category,
    priority: project.priority,
    status: project.status,
    goal_id: project.goalId,
    start_date: project.startDate,
    deadline: project.deadline,
    ...(GOAL_PLANNING_FIELDS ? { milestone_id: project.milestoneId } : {})
  }),
  fromRow: row => normalizeProject({
    id: row.id,
    name: row.name,
    description: row.description,
    category: row.category,
    priority: row.priority,
    status: row.status,
    goalId: row.goal_id,
    startDate: row.start_date,
    deadline: row.deadline,
    milestoneId: row.milestone_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  })
});

// ---------------------------------------------------------- hyvinvointi

export const wellbeingRepo = createRepository({
  table: 'wellbeing_entries',
  schemaKey: 'wellbeing',
  normalize: normalizeWellbeingEntry,
  toRow: entry => ({
    id: entry.id,
    date: entry.date,
    energy: entry.energy,
    mood: entry.mood,
    stress: entry.stress,
    sleep_hours: entry.sleepHours,
    note: entry.note
  }),
  fromRow: row => normalizeWellbeingEntry({
    id: row.id,
    date: row.date,
    energy: row.energy,
    mood: row.mood,
    stress: row.stress,
    sleepHours: row.sleep_hours,
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  })
});

// --------------------------------------------------------------- talous

/**
 * Rahasummat kulkevat kantaan SENTTEINÄ (`amount_minor`, `bigint`).
 * Ks. src/domain/money.js ja migraatio 0007 — liukulukua ei käytetä
 * missään kohtaa ketjua.
 */
export const billsRepo = createRepository({
  table: 'bills',
  schemaKey: 'bills',
  normalize: normalizeBill,
  toRow: bill => ({
    id: bill.id,
    name: bill.name,
    amount_minor: bill.amountMinor,
    currency: bill.currency,
    due_date: bill.dueDate,
    status: bill.status,
    paid_date: bill.paidDate,
    category: bill.category,
    task_id: bill.taskId,
    recurring_expense_id: bill.recurringExpenseId,
    note: bill.note,

    // MAKSUTIEDOT JÄTETÄÄN POIS, JOS SARAKKEITA EI OLE.
    //
    // Sarakkeet payee, iban ja reference syntyvät migraatiossa 0009.
    // Ennen sitä ne eivät ole olemassa, ja niiden lähettäminen —
    // NULLINAKIN — kaataisi JOKAISEN laskun tallennuksen koodilla
    // 42703 (undefined column). Sama kuvio kuin taskColumns().
    ...(BILL_PAYMENT_FIELDS
      ? { payee: bill.payee, iban: bill.iban, reference: bill.reference }
      : {})
  }),
  fromRow: row => normalizeBill({
    id: row.id,
    name: row.name,
    amountMinor: row.amount_minor,
    currency: row.currency,
    dueDate: row.due_date,
    status: row.status,
    paidDate: row.paid_date,
    category: row.category,
    taskId: row.task_id,
    recurringExpenseId: row.recurring_expense_id,
    note: row.note,
    // Lukeminen on turvallista kummassakin tilassa: ennen migraatiota
    // 0009 kenttää ei ole rivissä, jolloin arvo on undefined ja
    // normalizeBill tekee siitä nullin.
    payee: row.payee,
    iban: row.iban,
    reference: row.reference,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  })
});

export const recurringExpensesRepo = createRepository({
  table: 'recurring_expenses',
  schemaKey: 'recurringExpenses',
  normalize: normalizeRecurringExpense,
  toRow: expense => ({
    id: expense.id,
    name: expense.name,
    amount_minor: expense.amountMinor,
    currency: expense.currency,
    cadence: expense.cadence,
    day_of_month: expense.dayOfMonth,
    next_due_date: expense.nextDueDate,
    category: expense.category,
    active: expense.active,
    note: expense.note
  }),
  fromRow: row => normalizeRecurringExpense({
    id: row.id,
    name: row.name,
    amountMinor: row.amount_minor,
    currency: row.currency,
    cadence: row.cadence,
    dayOfMonth: row.day_of_month,
    nextDueDate: row.next_due_date,
    category: row.category,
    active: row.active,
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  })
});

export const savingsGoalsRepo = createRepository({
  table: 'savings_goals',
  schemaKey: 'savingsGoals',
  normalize: normalizeSavingsGoal,
  toRow: goal => ({
    id: goal.id,
    name: goal.name,
    target_minor: goal.targetMinor,
    current_minor: goal.currentMinor,
    currency: goal.currency,
    target_date: goal.targetDate,
    note: goal.note
  }),
  fromRow: row => normalizeSavingsGoal({
    id: row.id,
    name: row.name,
    targetMinor: row.target_minor,
    currentMinor: row.current_minor,
    currency: row.currency,
    targetDate: row.target_date,
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  })
});

// ---------------------------------------------------------- tapahtumat

/**
 * Tapahtumat: menot, tulot ja siirrot samassa taulussa.
 *
 * SUUNTA ON `kind`, EI ETUMERKKI. `amount_minor` on aina positiivinen
 * kokonaisluku senttejä; kanta valvoo sen CHECK-rajoitteella.
 *
 * `source_kind` ja `source_id` kertovat mistä tapahtuma syntyi.
 * Ne EIVÄT ole vierasavain: lähde saa kadota, mutta maksettu lasku ei
 * muutu maksamattomaksi sillä, että lasku poistetaan. Ks. migraatio
 * 0009 ja src/domain/transactions.js.
 */
export const transactionsRepo = createRepository({
  table: 'transactions',
  schemaKey: 'transactions',
  normalize: normalizeTransaction,
  toRow: transaction => ({
    id: transaction.id,
    kind: transaction.kind,
    origin: transaction.origin,
    amount_minor: transaction.amountMinor,
    currency: transaction.currency,
    date: transaction.date,
    category: transaction.category,
    description: transaction.description,
    note: transaction.note,
    source_kind: transaction.sourceKind,
    source_id: transaction.sourceId
  }),
  fromRow: row => normalizeTransaction({
    id: row.id,
    kind: row.kind,
    origin: row.origin,
    amountMinor: row.amount_minor,
    currency: row.currency,
    date: row.date,
    category: row.category,
    description: row.description,
    note: row.note,
    sourceKind: row.source_kind,
    sourceId: row.source_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  })
});

// ---------------------------------------------------------- sijoitukset

/**
 * Sijoitukset.
 *
 * MÄÄRÄ EI OLE RAHAA: `quantity` on numeric(20,8), koska osakkeita voi
 * olla 12,5 ja kryptoa 0,00031. Rahasummat ovat yhä sentteinä.
 *
 * `current_value_minor` on NULL kun arvoa ei tiedetä — EI nolla.
 * Manifestivalilla ei ole markkinadatan toimittajaa eikä se keksi
 * kursseja. Ks. src/domain/investments.js.
 */
export const investmentsRepo = createRepository({
  table: 'investments',
  schemaKey: 'investments',
  normalize: normalizeHolding,
  toRow: holding => ({
    id: holding.id,
    name: holding.name,
    symbol: holding.symbol,
    kind: holding.kind,
    quantity: holding.quantity,
    cost_basis_minor: holding.costBasisMinor,
    current_value_minor: holding.currentValueMinor,
    valued_on: holding.valuedOn,
    value_source: holding.valueSource,
    currency: holding.currency,
    target_value_minor: holding.targetValueMinor,
    note: holding.note
  }),
  fromRow: row => normalizeHolding({
    id: row.id,
    name: row.name,
    symbol: row.symbol,
    kind: row.kind,
    // numeric palautuu Supabasesta merkkijonona tarkkuuden
    // säilyttämiseksi. normalizeHolding tekee siitä luvun.
    quantity: row.quantity,
    costBasisMinor: row.cost_basis_minor,
    currentValueMinor: row.current_value_minor,
    valuedOn: row.valued_on,
    valueSource: row.value_source,
    currency: row.currency,
    targetValueMinor: row.target_value_minor,
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  })
});

// ------------------------------------------------------ välitavoitteet

/**
 * Välitavoitteet.
 *
 * VÄLITAVOITE EI ELÄ ILMAN TAVOITETTA: `goal_id` on NOT NULL ja
 * yhdistelmävierasavain `(user_id, goal_id)` estää kiinnittämisen
 * toisen käyttäjän tavoitteeseen. Vierasavaimen tarkistus EI kulje
 * RLS:n läpi, joten kaksi saraketta viitteessä on koko suoja.
 *
 * Ks. migraatio 0010 — EI AJETTU.
 */
export const milestonesRepo = createRepository({
  table: 'milestones',
  schemaKey: 'milestones',
  normalize: normalizeMilestone,
  toRow: milestone => ({
    id: milestone.id,
    goal_id: milestone.goalId,
    title: milestone.title,
    description: milestone.description,
    target_date: milestone.targetDate,
    status: milestone.status,
    order_index: milestone.orderIndex,
    rule: milestone.rule,
    reached_date: milestone.reachedDate
  }),
  fromRow: row => normalizeMilestone({
    id: row.id,
    goalId: row.goal_id,
    title: row.title,
    description: row.description,
    targetDate: row.target_date,
    status: row.status,
    orderIndex: row.order_index,
    rule: row.rule,
    reachedDate: row.reached_date,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  })
});


// -------------------------------------------------------- saapuvat

/**
 * Saapuvat: kirjaa nyt, järjestä myöhemmin.
 *
 * `proposal` on tekoälyn tuottamaa tietoa ja se tallennetaan `jsonb`-
 * sarakkeeseen. Se on tietoinen poikkeus siihen sääntöön, ettei mallin
 * tuotosta säilytetä: ehdotus on osa rivin tilaa siihen asti että
 * käyttäjä käsittelee sen, ja ilman sitä käyttäjä näkisi tulkinnan vain
 * kerran.
 *
 * Ehdotus katoaa, kun rivi muunnetaan tai hylätään — ks. migraatio 0011.
 */
export const inboxRepo = createRepository({
  table: 'inbox_items',
  schemaKey: 'inboxItems',
  normalize: normalizeInboxItem,
  toRow: item => ({
    id: item.id,
    text: item.text,
    status: item.status,
    source: item.source,
    proposal: item.proposal,
    converted_kind: item.convertedKind,
    converted_id: item.convertedId,
    captured_at: item.capturedAt
  }),
  fromRow: row => normalizeInboxItem({
    id: row.id,
    text: row.text,
    status: row.status,
    source: row.source,
    proposal: row.proposal,
    convertedKind: row.converted_kind,
    convertedId: row.converted_id,
    capturedAt: row.captured_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  })
});

// ----------------------------------------------------- muistutukset

/**
 * Muistutukset.
 *
 * `target_id` EI OLE VIERASAVAIN. Kohde voidaan poistaa, ja muistutus
 * on silti tietue siitä että muistuttaminen oli tarkoitus. Orpo
 * muistutus tunnistetaan sovelluksessa (`isOrphaned`) ja perutaan
 * näkyvästi — hiljaisen katoamisen sijaan.
 *
 * Sama perustelu kuin `transactions.source_id` (0009) ja
 * `ai_action_audit.target_id` (0008).
 */
export const remindersRepo = createRepository({
  table: 'reminders',
  schemaKey: 'reminders',
  normalize: normalizeReminder,
  toRow: reminder => ({
    id: reminder.id,
    title: reminder.title,
    target_type: reminder.targetType,
    target_id: reminder.targetId,
    trigger_type: reminder.trigger,
    due_date: reminder.dueDate,
    due_time: reminder.dueTime,
    lead_minutes: reminder.leadMinutes,
    status: reminder.status,
    escalate: reminder.escalate,
    alert_count: reminder.alertCount,
    snooze_count: reminder.snoozeCount,
    until_time: reminder.untilTime,
    note: reminder.note
  }),
  fromRow: row => normalizeReminder({
    id: row.id,
    title: row.title,
    targetType: row.target_type,
    targetId: row.target_id,
    trigger: row.trigger_type,
    dueDate: row.due_date,
    dueTime: row.due_time,
    leadMinutes: row.lead_minutes,
    status: row.status,
    escalate: row.escalate,
    alertCount: row.alert_count,
    snoozeCount: row.snooze_count,
    untilTime: row.until_time,
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  })
});

// --------------------------------------------------- ilmoituskeskus

/**
 * Ilmoitushistoria.
 *
 * `key` on UNIIKKI KÄYTTÄJÄÄ KOHTI. Se on kaksoiskappaleiden esto
 * kannassa asti: sama hälytys tuottaa saman avaimen, ja toistuvasti
 * ajettu taustatarkistus ei voi luoda toista riviä edes silloin kun
 * sovelluksen oma tarkistus pettäisi.
 */
export const noticesRepo = createRepository({
  table: 'notices',
  schemaKey: 'notices',
  normalize: normalizeNotice,
  toRow: notice => ({
    id: notice.id,
    notice_key: notice.key,
    kind: notice.kind,
    level: notice.level,
    status: notice.status,
    title: notice.title,
    reason: notice.reason,
    target_type: notice.targetType,
    target_id: notice.targetId,
    created_date: notice.createdDate
  }),
  fromRow: row => normalizeNotice({
    id: row.id,
    key: row.notice_key,
    kind: row.kind,
    level: row.level,
    status: row.status,
    title: row.title,
    reason: row.reason,
    targetType: row.target_type,
    targetId: row.target_id,
    createdDate: row.created_date,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  })
});

// ------------------------------------------------------------- matka

/**
 * Matkasuunnitelmat.
 *
 * TÄSSÄ EI OLE KOORDINAATTEJA. `origin` ja `destination` ovat
 * käyttäjän kirjoittamia nimiä. Koordinaattien tallentaminen tekisi
 * niistä osan vientiä, varmuuskopiota ja mahdollista vuotoa — ja
 * lähtöajan laskentaan riittää kesto.
 */
export const travelPlansRepo = createRepository({
  table: 'travel_plans',
  schemaKey: 'travelPlans',
  normalize: normalizeTravelPlan,
  toRow: plan => ({
    id: plan.id,
    title: plan.title,
    origin: plan.origin,
    destination: plan.destination,
    arrival_date: plan.arrivalDate,
    arrival_time: plan.arrivalTime,
    mode: plan.mode,
    travel_minutes: plan.travelMinutes,
    travel_source: plan.travelSource,
    estimated_at: plan.estimatedAt,
    preparation_minutes: plan.preparationMinutes,
    arrival_buffer_minutes: plan.arrivalBufferMinutes,
    task_id: plan.taskId,
    note: plan.note
  }),
  fromRow: row => normalizeTravelPlan({
    id: row.id,
    title: row.title,
    origin: row.origin,
    destination: row.destination,
    arrivalDate: row.arrival_date,
    arrivalTime: row.arrival_time,
    mode: row.mode,
    travelMinutes: row.travel_minutes,
    travelSource: row.travel_source,
    estimatedAt: row.estimated_at,
    preparationMinutes: row.preparation_minutes,
    arrivalBufferMinutes: row.arrival_buffer_minutes,
    taskId: row.task_id,
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  })
});

/**
 * Sijaintisäännöt.
 *
 * SÄÄNTÖ EI OLE TOTEUTUS. Geoaitaa ei ole eikä sitä voi luvata ilman
 * laitehyväksyntää. Sääntö on data, jota voidaan mallintaa ja testata
 * simuloiduilla sijainneilla — ja kytkeä myöhemmin oikeaan
 * sovittimeen.
 *
 * `active` on oletuksena EPÄTOSI: sijainti vaatii luvan, eikä lupaa
 * oleteta.
 */
export const locationRulesRepo = createRepository({
  table: 'location_rules',
  schemaKey: 'locationRules',
  normalize: normalizeLocationRule,
  toRow: rule => ({
    id: rule.id,
    place: rule.place,
    trigger_type: rule.trigger,
    message: rule.message,
    active: rule.active,
    task_id: rule.taskId
  }),
  fromRow: row => normalizeLocationRule({
    id: row.id,
    place: row.place,
    trigger: row.trigger_type,
    message: row.message,
    active: row.active,
    taskId: row.task_id
  })
});

// ------------------------------------------------------------ Suunta (0012)

/**
 * Elämänalueet. Käyttäjän oma määritelmä siitä mikä on tärkeää.
 * Portti kiinni -> istunnon muisti (migraatio 0012 EI AJETTU).
 */
export const lifeAreasRepo = createRepository({
  table: 'life_areas',
  schemaKey: 'lifeAreas',
  normalize: normalizeLifeArea,
  toRow: area => ({
    id: area.id,
    name: area.name,
    description: area.description,
    importance: area.importance,
    target_minutes_per_week: area.targetMinutesPerWeek,
    category_key: area.categoryKey,
    active: area.active,
    sort_order: area.sortOrder
  }),
  fromRow: row => normalizeLifeArea({
    id: row.id,
    name: row.name,
    description: row.description,
    importance: row.importance,
    targetMinutesPerWeek: row.target_minutes_per_week,
    categoryKey: row.category_key,
    active: row.active,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  })
});

/** Viikkokapasiteetti: yksi rivi viikkoa (maanantaita) kohti. */
export const weeklyCapacitiesRepo = createRepository({
  table: 'weekly_capacities',
  schemaKey: 'weeklyCapacities',
  normalize: normalizeWeeklyCapacity,
  toRow: capacity => ({
    id: capacity.id,
    week_start: capacity.weekStart,
    available_minutes: capacity.availableMinutes,
    energy_level: capacity.energyLevel,
    // 0013: sarake puuttuu kunnes migraatio on ajettu -> jätetään pois.
    ...(ALIGNMENT_REALITY_FIELDS ? { energy_budget_minutes: capacity.energyBudgetMinutes } : {}),
    note: capacity.note
  }),
  fromRow: row => normalizeWeeklyCapacity({
    id: row.id,
    weekStart: row.week_start,
    availableMinutes: row.available_minutes,
    energyLevel: row.energy_level,
    energyBudgetMinutes: row.energy_budget_minutes,
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  })
});

/**
 * Kirjattu aika. TOTEUMA ON KÄYTTÄJÄN KIRJAAMA: arviota ei kopioida
 * tänne eikä valmiiksi merkintä tuota riviä.
 */
export const timeEntriesRepo = createRepository({
  table: 'time_entries',
  schemaKey: 'timeEntries',
  normalize: normalizeTimeEntry,
  toRow: entry => ({
    id: entry.id,
    entry_date: entry.entryDate,
    minutes: entry.minutes,
    life_area_id: entry.lifeAreaId,
    goal_id: entry.goalId,
    task_id: entry.taskId,
    // 0012 sallii vain lähteen 'manual'. Ennen 0013:a ajastimen kirjaus
    // tallentuu 'manual'-lähteellä: minuutit ja kohde säilyvät, vain
    // lähteen erottelu odottaa migraatiota. ARVOPORTTI, ei sarakeportti:
    // sarakkeen pois jättäminen ei riittäisi, joten ajonaikainen tieto
    // luetaan tässä (columnGateOpen) eikä vain sarakkeita riisuttaessa.
    source: columnGateOpen('ALIGNMENT_REALITY_FIELDS') ? entry.source : 'manual',
    note: entry.note,
    ...(ALIGNMENT_REALITY_FIELDS ? {
      project_id: entry.projectId,
      routine_id: entry.routineId,
      occurrence_date: entry.occurrenceDate,
      operation_id: entry.operationId,
      started_at: entry.startedAt,
      ended_at: entry.endedAt
    } : {})
  }),
  fromRow: row => normalizeTimeEntry({
    id: row.id,
    entryDate: row.entry_date,
    minutes: row.minutes,
    lifeAreaId: row.life_area_id,
    goalId: row.goal_id,
    taskId: row.task_id,
    projectId: row.project_id,
    routineId: row.routine_id,
    occurrenceDate: row.occurrence_date,
    operationId: row.operation_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    source: row.source,
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  })
});

/** Viikkokatsaukset: versioitu tilannekuva + pohdinta + valitut muutokset. */
export const alignmentReviewsRepo = createRepository({
  table: 'alignment_reviews',
  schemaKey: 'alignmentReviews',
  normalize: normalizeAlignmentReview,
  toRow: review => ({
    id: review.id,
    week_start: review.weekStart,
    snapshot_version: review.snapshotVersion,
    snapshot: review.snapshot,
    reflection: review.reflection,
    adjustments: review.adjustments,
    completed_at: review.completedAt,
    ...(ALIGNMENT_REALITY_FIELDS ? {
      policy_version: review.policyVersion,
      reflection_answers: review.reflectionAnswers
    } : {})
  }),
  fromRow: row => normalizeAlignmentReview({
    id: row.id,
    weekStart: row.week_start,
    snapshotVersion: row.snapshot_version,
    snapshot: row.snapshot,
    reflection: row.reflection,
    adjustments: row.adjustments,
    policyVersion: row.policy_version,
    reflectionAnswers: row.reflection_answers,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  })
});

// ---------------------------------------------------- Suunta 2 (0013)

/**
 * Käynnissä oleva ajastin. ENINTÄÄN YKSI KÄYTTÄJÄÄ KOHTI (kannan
 * uniikkirajoite). Portti kiinni -> muisti; ajastin säilyy silti
 * laitteella (src/data/timerStore.js), jotta uudelleenlataus ei hukkaa
 * kulunutta aikaa.
 */
export const runningTimersRepo = createRepository({
  table: 'running_timers',
  schemaKey: 'runningTimers',
  normalize: normalizeTimer,
  toRow: timer => ({
    id: timer.id,
    target_kind: timer.targetKind,
    life_area_id: timer.lifeAreaId,
    goal_id: timer.goalId,
    task_id: timer.taskId,
    project_id: timer.projectId,
    routine_id: timer.routineId,
    occurrence_date: timer.occurrenceDate,
    started_at: timer.startedAt,
    paused_at: timer.pausedAt,
    paused_seconds: timer.pausedSeconds,
    note: timer.note
  }),
  fromRow: row => normalizeTimer({
    id: row.id,
    targetKind: row.target_kind,
    lifeAreaId: row.life_area_id,
    goalId: row.goal_id,
    taskId: row.task_id,
    projectId: row.project_id,
    routineId: row.routine_id,
    occurrenceDate: row.occurrence_date,
    startedAt: row.started_at,
    pausedAt: row.paused_at,
    pausedSeconds: row.paused_seconds,
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  })
});

/** Tehtävän/rutiinin/projektin Suunta-asetukset: kuormittavuus ym. */
export const alignmentItemSettingsRepo = createRepository({
  table: 'alignment_item_settings',
  schemaKey: 'alignmentItemSettings',
  normalize: normalizeItemSettings,
  toRow: settings => ({
    id: settings.id,
    item_kind: settings.itemKind,
    item_id: settings.itemId,
    energy_demand: settings.energyDemand,
    alignment_opt_out: settings.alignmentOptOut,
    estimate_approximate: settings.estimateApproximate
  }),
  fromRow: row => normalizeItemSettings({
    id: row.id,
    itemKind: row.item_kind,
    itemId: row.item_id,
    energyDemand: row.energy_demand,
    alignmentOptOut: row.alignment_opt_out,
    estimateApproximate: row.estimate_approximate,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  })
});

// ------------------------------------------------------- AI-kirjausketju

export const aiAuditRepo = createRepository({
  table: 'ai_action_audit',
  schemaKey: 'aiAudit',
  normalize: normalizeAuditEntry,
  toRow: entry => ({
    id: entry.id,
    // AIKALEIMA JÄTETÄÄN POIS, EI LÄHETETÄ NULLINA.
    //
    // Sarake on `occurred_at timestamptz not null default now()`.
    // Oletusarvo ei pelasta nimenomaista NULLia: PostgreSQL käyttää
    // oletusta vain kun sarake jätetään pois lauseesta, ja lähetetty
    // NULL on arvo, joka hylätään koodilla 23502.
    //
    // Aiemmin tässä luki `occurred_at: entry.timestamp`, ja kun
    // domainin timestamp oli tyhjä, jokainen kirjaus olisi kaatunut
    // heti kun aiAudit-portti avataan. Muistivarasto ei välitä
    // NOT NULLista, joten vika olisi näkynyt vasta tuotannossa.
    //
    // Kun aikaleimaa ei ole, oikea arvo on kannan `now()`: kirjaus
    // tapahtui silloin kun se kirjattiin.
    ...(entry.timestamp != null ? { occurred_at: entry.timestamp } : {}),
    input_summary: entry.inputSummary,
    intent: entry.intent,
    risk: entry.risk,
    target_type: entry.targetType,
    target_id: entry.targetId,
    proposal: entry.proposal,
    confirmed: entry.confirmed,
    executed: entry.executed,
    result: entry.result,
    error_code: entry.errorCode
  }),
  fromRow: row => normalizeAuditEntry({
    id: row.id,
    timestamp: row.occurred_at,
    inputSummary: row.input_summary,
    intent: row.intent,
    risk: row.risk,
    targetType: row.target_type,
    targetId: row.target_id,
    proposal: row.proposal,
    confirmed: row.confirmed,
    executed: row.executed,
    result: row.result,
    errorCode: row.error_code
  })
});

/** Kaikki uudet repositoriot. Käytetään latauksessa ja tyhjennyksessä. */
export const ALL_REPOSITORIES = Object.freeze([
  routinesRepo, routineExceptionsRepo, goalsRepo, projectsRepo, wellbeingRepo,
  billsRepo, recurringExpensesRepo, savingsGoalsRepo,
  transactionsRepo, investmentsRepo, milestonesRepo,
  inboxRepo, remindersRepo, noticesRepo, travelPlansRepo, locationRulesRepo,
  lifeAreasRepo, weeklyCapacitiesRepo, timeEntriesRepo, alignmentReviewsRepo,
  runningTimersRepo, alignmentItemSettingsRepo,
  aiAuditRepo
]);

/** Tyhjennä kaikki muistivarastot. Kutsutaan uloskirjautumisessa. */
export function clearAllCollections() {
  for (const repo of ALL_REPOSITORIES) repo.clear();
}

/** Mitkä tietotyypit eivät vielä säily tallennuksen yli. */
export function volatileCollections() {
  return ALL_REPOSITORIES.filter(repo => !repo.isPersistent()).map(repo => repo.table);
}
