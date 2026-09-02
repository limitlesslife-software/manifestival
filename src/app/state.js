// Sovelluksen tila.
//
// Yksi paikka, jossa tilaa muutetaan. Aiemmin tila oli globaali olio, jota
// mikä tahansa funktio saattoi mutatoida suoraan — myös datakerros.
//
// Muutokset ilmoitetaan tilaajille (subscribe), jolloin näkymät päivittyvät
// eikä yksikään toiminto joudu muistamaan kutsua renderAll().

import { todayMidnight, startOfWeek, fmtISO } from '../lib/datetime.js';
import { DEFAULT_PROFILE } from '../domain/scheduler.js';
import { normalizeTask } from '../domain/task.js';
import { normalizeRoutine, normalizeException } from '../domain/routine.js';
import { normalizeGoal } from '../domain/goal.js';
import { normalizeWellbeingEntry } from '../domain/wellbeing.js';
import { normalizePreferences } from '../domain/notification.js';
import {
  normalizeBill, normalizeRecurringExpense, normalizeSavingsGoal
} from '../domain/finance.js';
import { normalizeAuditEntry } from '../domain/audit.js';

function initialState() {
  const today = todayMidnight();
  return {
    tasks: [],
    /** Toistuvat rutiinit (WP7). */
    routines: [],
    /** Rutiinien kertaluonteiset poikkeukset. */
    routineExceptions: [],
    /** Tavoitteet (WP8). */
    goals: [],
    /** Projektit (WP9). */
    projects: [],
    /** Hyvinvointimerkinnät (WP12). */
    wellbeing: [],
    /**
     * Muistutusasetukset.
     *
     * Oletus on hiljaisuus: `enabled: false`. Mitään ei lähetetä ennen kuin
     * käyttäjä on itse kytkenyt muistutukset päälle.
     */
    notificationPreferences: normalizePreferences({}),
    /** Talous (WP17). Ei säily ennen migraatiota 0007. */
    bills: [],
    recurringExpenses: [],
    savingsGoals: [],
    /** AI-toimintojen kirjausketju (WP13). Ei säily ennen migraatiota 0008. */
    aiAudit: [],
    viewDate: today,
    weekStart: startOfWeek(today),
    profile: { ...DEFAULT_PROFILE },
    profileExists: false,
    editingId: null,
    /** Muokattavan rutiinin tai tavoitteen tunniste. */
    editingRoutineId: null,
    editingGoalId: null,
    /** Tehtävänäkymän osio: 'tasks' tai 'routines'. */
    tasksSegment: 'tasks',
    /** Näkymä, joka on auki. */
    screen: 'screen-today',
    /** Onko ensimmäinen lataus vielä kesken. */
    loading: true
  };
}

let state = initialState();
const listeners = new Set();

/** Nykyinen tila. Kohtele vain luettavana — muuta aina toiminnoilla. */
export function getState() {
  return state;
}

/**
 * Tilaa muutosilmoitukset.
 * @returns {Function} lopeta tilaus
 */
export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify() {
  for (const listener of listeners) {
    try {
      listener(state);
    } catch (error) {
      // Yhden näkymän virhe ei saa estää muiden päivittymistä.
      console.error('Manifestival: tilakuuntelija epäonnistui', error);
    }
  }
}

function commit(changes) {
  state = { ...state, ...changes };
  notify();
}

// ------------------------------------------------------------------ tehtävät

/** Korvaa koko tehtävälista. Käytetään latauksessa. */
export function setTasks(tasks) {
  commit({ tasks: tasks.map(normalizeTask), loading: false });
}

/** Lisää tehtävä muistiin. */
export function addTaskToState(task) {
  commit({ tasks: [...state.tasks, normalizeTask(task)] });
}

/** Korvaa yksi tehtävä. */
export function replaceTaskInState(id, task) {
  commit({ tasks: state.tasks.map(t => (t.id === id ? normalizeTask(task) : t)) });
}

/** Yhdistä muutokset yhteen tehtävään. */
export function patchTaskInState(id, changes) {
  commit({
    tasks: state.tasks.map(t => (t.id === id ? normalizeTask({ ...t, ...changes }) : t))
  });
}

/** Poista tehtävä muistista. */
export function removeTaskFromState(id) {
  commit({ tasks: state.tasks.filter(t => t.id !== id) });
}

/** Hae tehtävä tunnisteella. */
export function findTask(id) {
  return state.tasks.find(t => t.id === id) || null;
}

/**
 * Nollaa herätysmerkintä päivän muilta tehtäviltä muistissa.
 * Päivällä voi olla vain yksi herätysankkuri.
 */
export function clearOtherWakeFlagsInState(dateIso, exceptId) {
  commit({
    tasks: state.tasks.map(t =>
      t.date === dateIso && t.id !== exceptId && t.isWake ? { ...t, isWake: false } : t)
  });
}

// ------------------------------------------------- rutiinit ja tavoitteet

export function setRoutines(routines) {
  commit({ routines: (routines || []).map(normalizeRoutine) });
}

export function addRoutineToState(routine) {
  commit({ routines: [...state.routines, normalizeRoutine(routine)] });
}

export function replaceRoutineInState(id, routine) {
  commit({ routines: state.routines.map(r => (r.id === id ? normalizeRoutine(routine) : r)) });
}

export function removeRoutineFromState(id) {
  commit({
    routines: state.routines.filter(r => r.id !== id),
    // Poikkeukset ovat merkityksettömiä ilman rutiinia — ne poistuvat mukana.
    routineExceptions: state.routineExceptions.filter(e => e.routineId !== id)
  });
}

export function findRoutine(id) {
  return state.routines.find(r => r.id === id) || null;
}

export function setRoutineExceptions(exceptions) {
  commit({ routineExceptions: (exceptions || []).map(normalizeException) });
}

export function addRoutineExceptionToState(exception) {
  const normalized = normalizeException(exception);
  // Päivälle voi olla vain yksi poikkeus rutiinia kohti.
  const others = state.routineExceptions.filter(
    e => !(e.routineId === normalized.routineId && e.date === normalized.date));
  commit({ routineExceptions: [...others, normalized] });
}

export function removeRoutineExceptionFromState(routineId, dateIso) {
  commit({
    routineExceptions: state.routineExceptions.filter(
      e => !(e.routineId === routineId && e.date === dateIso))
  });
}

export function setGoals(goals) {
  commit({ goals: (goals || []).map(normalizeGoal) });
}

export function addGoalToState(goal) {
  commit({ goals: [...state.goals, normalizeGoal(goal)] });
}

export function replaceGoalInState(id, goal) {
  commit({ goals: state.goals.map(g => (g.id === id ? normalizeGoal(goal) : g)) });
}

export function removeGoalFromState(id) {
  commit({
    goals: state.goals.filter(g => g.id !== id),
    // Tehtävät säilyvät, mutta niiden tavoiteyhteys katkeaa — tehtävää ei
    // koskaan poisteta tavoitteen mukana.
    tasks: state.tasks.map(t => (t.goalId === id ? { ...t, goalId: null } : t))
  });
}

export function findGoal(id) {
  return state.goals.find(g => g.id === id) || null;
}

export function setProjects(projects) {
  commit({ projects: projects || [] });
}

export function setWellbeing(entries) {
  commit({ wellbeing: (entries || []).map(normalizeWellbeingEntry) });
}

/** Aseta laskut. */
export function setBills(bills) {
  commit({ bills: (bills || []).map(normalizeBill) });
}

/** Aseta toistuvat kulut. */
export function setRecurringExpenses(expenses) {
  commit({ recurringExpenses: (expenses || []).map(normalizeRecurringExpense) });
}

/** Aseta säästötavoitteet. */
export function setSavingsGoals(goals) {
  commit({ savingsGoals: (goals || []).map(normalizeSavingsGoal) });
}

/** Aseta AI-kirjausketju. */
export function setAiAudit(entries) {
  commit({ aiAudit: (entries || []).map(normalizeAuditEntry) });
}

export function findBill(id) {
  return getState().bills.find(bill => bill.id === id) || null;
}

export function findProject(id) {
  return getState().projects.find(project => project.id === id) || null;
}

/** Aseta muistutusasetukset. Normalisointi takaa kelvolliset rajat. */
export function setNotificationPreferences(preferences) {
  commit({ notificationPreferences: normalizePreferences(preferences) });
}

export function upsertWellbeingEntry(entry) {
  const normalized = normalizeWellbeingEntry(entry);
  const others = state.wellbeing.filter(e => e.date !== normalized.date);
  commit({ wellbeing: [...others, normalized] });
}

export function setEditingRoutineId(id) {
  commit({ editingRoutineId: id });
}

export function setEditingGoalId(id) {
  commit({ editingGoalId: id });
}

export function setTasksSegment(segment) {
  commit({ tasksSegment: segment === 'routines' ? 'routines' : 'tasks' });
}

// ------------------------------------------------------------------ näkymä

export function setViewDate(date) {
  commit({ viewDate: date });
}

export function setWeekStart(date) {
  commit({ weekStart: date });
}

export function setScreen(screen) {
  commit({ screen });
}

export function setEditingId(id) {
  commit({ editingId: id });
}

/** Katsottava päivä ISO-muodossa. */
export function viewDateIso() {
  return fmtISO(state.viewDate);
}

// ----------------------------------------------------------------- profiili

export function setProfile(profile, exists = true) {
  commit({ profile: { ...DEFAULT_PROFILE, ...profile }, profileExists: exists });
}

// ------------------------------------------------------------------ elinkaari


/**
 * Palauta tila alkutilaan.
 * Kutsutaan uloskirjautumisessa: seuraava käyttäjä samalla laitteella ei saa
 * nähdä vilaustakaan edellisen datasta.
 */
export function resetState() {
  state = initialState();
  notify();
}
