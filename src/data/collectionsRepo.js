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
import { hasTable } from './schema.js';
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
    note: bill.note
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

// ------------------------------------------------------- AI-kirjausketju

export const aiAuditRepo = createRepository({
  table: 'ai_action_audit',
  schemaKey: 'aiAudit',
  normalize: normalizeAuditEntry,
  toRow: entry => ({
    id: entry.id,
    occurred_at: entry.timestamp,
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
  billsRepo, recurringExpensesRepo, savingsGoalsRepo, aiAuditRepo
]);

/** Tyhjennä kaikki muistivarastot. Kutsutaan uloskirjautumisessa. */
export function clearAllCollections() {
  for (const repo of ALL_REPOSITORIES) repo.clear();
}

/** Mitkä tietotyypit eivät vielä säily tallennuksen yli. */
export function volatileCollections() {
  return ALL_REPOSITORIES.filter(repo => !repo.isPersistent()).map(repo => repo.table);
}
