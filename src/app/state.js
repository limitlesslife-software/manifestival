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
import { normalizeProject } from '../domain/project.js';
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
    editingProjectId: null,
    editingBillId: null,
    editingExpenseId: null,
    editingSavingsId: null,
    /** Tavoitenäkymän osio: 'goals' tai 'projects'. */
    goalsSegment: 'goals',
    /** Talousnäkymän osio: 'bills', 'expenses' tai 'savings'. */
    financeSegment: 'bills',
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
  commit({ projects: (projects || []).map(normalizeProject) });
}

export function addProjectToState(project) {
  commit({ projects: [...state.projects, normalizeProject(project)] });
}

export function replaceProjectInState(id, project) {
  commit({
    projects: state.projects.map(p => (p.id === id ? normalizeProject(project) : p))
  });
}

/**
 * Poista projekti tilasta.
 *
 * Tehtäviä EI poisteta projektin mukana — niiden yhteys vain katkeaa.
 * Sama sääntö kuin tavoitteilla, ja sama kuin kannassa: viite on
 * `on delete set null (project_id)`, ei cascade. Tehty työ ei katoa
 * siksi, että sen kehys poistuu.
 *
 * Tavoitteen yhteys projektiin katkeaa samasta syystä.
 */
export function removeProjectFromState(id) {
  commit({
    projects: state.projects.filter(p => p.id !== id),
    tasks: state.tasks.map(t => (t.projectId === id ? { ...t, projectId: null } : t)),
    goals: state.goals.map(g => (g.projectId === id ? { ...g, projectId: null } : g))
  });
}

export function findProject(id) {
  return state.projects.find(p => p.id === id) || null;
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

// ------------------------------------------------------------- talous
//
// Kolme kokoelmaa, sama muoto kuin tavoitteilla: lisäys, korvaus,
// poisto ja haku. Toiminnot (`actions.js`) tekevät optimistisen
// muutoksen tilaan ja peruvat sen, jos tallennus epäonnistuu.

export function addBillToState(bill) {
  commit({ bills: [...state.bills, normalizeBill(bill)] });
}

export function replaceBillInState(id, bill) {
  commit({ bills: state.bills.map(b => (b.id === id ? normalizeBill(bill) : b)) });
}

export function removeBillFromState(id) {
  commit({ bills: state.bills.filter(b => b.id !== id) });
}

export function findBill(id) {
  return state.bills.find(b => b.id === id) || null;
}

export function addRecurringExpenseToState(expense) {
  commit({
    recurringExpenses: [...state.recurringExpenses, normalizeRecurringExpense(expense)]
  });
}

export function replaceRecurringExpenseInState(id, expense) {
  commit({
    recurringExpenses: state.recurringExpenses.map(
      e => (e.id === id ? normalizeRecurringExpense(expense) : e))
  });
}

/**
 * Poista toistuva kulu tilasta.
 *
 * Laskut EIVÄT poistu mukana. Lasku on historiaa: se on jo erääntynyt ja
 * mahdollisesti maksettu, eikä säännön poistaminen tee sitä
 * tapahtumattomaksi. Kannassa sama sääntö on
 * `on delete set null (recurring_expense_id)`.
 */
export function removeRecurringExpenseFromState(id) {
  commit({
    recurringExpenses: state.recurringExpenses.filter(e => e.id !== id),
    bills: state.bills.map(
      b => (b.recurringExpenseId === id ? { ...b, recurringExpenseId: null } : b))
  });
}

export function findRecurringExpense(id) {
  return state.recurringExpenses.find(e => e.id === id) || null;
}

export function addSavingsGoalToState(goal) {
  commit({ savingsGoals: [...state.savingsGoals, normalizeSavingsGoal(goal)] });
}

export function replaceSavingsGoalInState(id, goal) {
  commit({
    savingsGoals: state.savingsGoals.map(
      g => (g.id === id ? normalizeSavingsGoal(goal) : g))
  });
}

export function removeSavingsGoalFromState(id) {
  commit({ savingsGoals: state.savingsGoals.filter(g => g.id !== id) });
}

export function findSavingsGoal(id) {
  return state.savingsGoals.find(g => g.id === id) || null;
}

/** Aseta AI-kirjausketju. */
export function setAiAudit(entries) {
  commit({ aiAudit: (entries || []).map(normalizeAuditEntry) });
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

export function setEditingProjectId(id) {
  commit({ editingProjectId: id });
}

export function setEditingBillId(id) {
  commit({ editingBillId: id });
}

export function setEditingExpenseId(id) {
  commit({ editingExpenseId: id });
}

export function setEditingSavingsId(id) {
  commit({ editingSavingsId: id });
}

export function setTasksSegment(segment) {
  commit({ tasksSegment: segment === 'routines' ? 'routines' : 'tasks' });
}

/** Tavoitenäkymän osio: 'goals' tai 'projects'. */
export function setGoalsSegment(segment) {
  commit({ goalsSegment: segment === 'projects' ? 'projects' : 'goals' });
}

/** Talousnäkymän osio: 'bills', 'expenses' tai 'savings'. */
export function setFinanceSegment(segment) {
  const allowed = ['bills', 'expenses', 'savings'];
  commit({ financeSegment: allowed.includes(segment) ? segment : 'bills' });
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
