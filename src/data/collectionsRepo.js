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
import { hasTable, BILL_PAYMENT_FIELDS } from './schema.js';
import { createMemoryRepository } from './memoryStore.js';
import { ok, fail } from '../lib/result.js';
import { normalizeRoutine, normalizeException } from '../domain/routine.js';
import { normalizeGoal } from '../domain/goal.js';
import { normalizeProject } from '../domain/project.js';
import { normalizeWellbeingEntry } from '../domain/wellbeing.js';
import {
  normalizeBill, normalizeRecurringExpense, normalizeSavingsGoal
} from '../domain/finance.js';
import { normalizeAuditEntry } from '../domain/audit.js';
import { normalizeTransaction } from '../domain/transactions.js';
import { normalizeHolding } from '../domain/investments.js';

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
 */
export function createRepository({ table, schemaKey, normalize, toRow, fromRow }) {
  const memory = createMemoryRepository({ normalize, name: table });

  const usesDatabase = () => hasTable(schemaKey);

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
      try {
        const { data, error } = await getClient()
          .from(table)
          .select('*')
          .eq('user_id', requireUserId());
        if (error) return fail('Tietojen lataus ei onnistunut.', { cause: error, code: table + '.list' });
        return ok((data || []).map(fromRow));
      } catch (cause) {
        return fail('Tietojen lataus ei onnistunut.', { cause, code: table + '.list' });
      }
    },

    async insert(entity) {
      const normalized = normalize(entity);
      if (!usesDatabase()) return memory.insert(normalized);
      try {
        const { error } = await getClient()
          .from(table)
          .insert(assertClientSafe(toRow(normalized)));
        if (error) return fail('Tallennus ei onnistunut.', { cause: error, code: table + '.insert' });
        return ok(normalized);
      } catch (cause) {
        return fail('Tallennus ei onnistunut.', { cause, code: table + '.insert' });
      }
    },

    async update(entity) {
      const normalized = normalize(entity);
      if (!usesDatabase()) return memory.update(normalized);
      try {
        const { error } = await getClient()
          .from(table)
          .update(assertClientSafe(toRow(normalized)))
          .eq('user_id', requireUserId())
          .eq('id', normalized.id);
        if (error) return fail('Muutoksen tallennus ei onnistunut.', { cause: error, code: table + '.update' });
        return ok(normalized);
      } catch (cause) {
        return fail('Muutoksen tallennus ei onnistunut.', { cause, code: table + '.update' });
      }
    },

    async remove(id) {
      if (!usesDatabase()) return memory.remove(id);
      try {
        const { error } = await getClient()
          .from(table)
          .delete()
          .eq('user_id', requireUserId())
          .eq('id', id);
        if (error) return fail('Poisto ei onnistunut.', { cause: error, code: table + '.delete' });
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
    project_id: goal.projectId
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
    deadline: project.deadline
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
  transactionsRepo, investmentsRepo, aiAuditRepo
]);

/** Tyhjennä kaikki muistivarastot. Kutsutaan uloskirjautumisessa. */
export function clearAllCollections() {
  for (const repo of ALL_REPOSITORIES) repo.clear();
}

/** Mitkä tietotyypit eivät vielä säily tallennuksen yli. */
export function volatileCollections() {
  return ALL_REPOSITORIES.filter(repo => !repo.isPersistent()).map(repo => repo.table);
}
