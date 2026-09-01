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
    status: project.status,
    goal_id: project.goalId,
    target_date: project.targetDate
  }),
  fromRow: row => normalizeProject({
    id: row.id,
    name: row.name,
    description: row.description,
    category: row.category,
    status: row.status,
    goalId: row.goal_id,
    targetDate: row.target_date,
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

/** Kaikki uudet repositoriot. Käytetään latauksessa ja tyhjennyksessä. */
export const ALL_REPOSITORIES = Object.freeze([
  routinesRepo, routineExceptionsRepo, goalsRepo, projectsRepo, wellbeingRepo
]);

/** Tyhjennä kaikki muistivarastot. Kutsutaan uloskirjautumisessa. */
export function clearAllCollections() {
  for (const repo of ALL_REPOSITORIES) repo.clear();
}

/** Mitkä tietotyypit eivät vielä säily tallennuksen yli. */
export function volatileCollections() {
  return ALL_REPOSITORIES.filter(repo => !repo.isPersistent()).map(repo => repo.table);
}
