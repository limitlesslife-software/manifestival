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
import { normalizeTransaction } from '../domain/transactions.js';
import { normalizeHolding } from '../domain/investments.js';
import { monthKey } from '../domain/budget.js';
import { normalizeMilestone } from '../domain/milestone.js';
import { normalizeAutomationLevel } from '../domain/automation.js';
import { getDevicePreference, setDevicePreference } from '../data/preferences.js';

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
    /** Välitavoitteet. Ei säily ennen migraatiota 0010. */
    milestones: [],
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
    /**
     * Tapahtumat: menot, tulot ja siirrot (Talous 2.0).
     * Ei säily ennen migraatiota 0009.
     */
    transactions: [],
    /** Sijoitukset (Talous 2.0). Ei säily ennen migraatiota 0009. */
    investments: [],
    /**
     * Kuittiluenta, jota käyttäjä parhaillaan tarkistaa.
     *
     * TÄMÄ ON TARKOITUKSELLA VAIN TILASSA, EI KOSKAAN KANNASSA. Luenta
     * elää siihen asti että se hyväksytään tai hylätään; hyväksynnästä
     * syntyy tapahtuma, ja luenta katoaa. Kuvaa ei ole tässä lainkaan.
     */
    pendingExtraction: null,

    /**
     * Suunnitelmaehdotus, jota käyttäjä parhaillaan tarkistaa.
     *
     * TÄMÄ ON TARKOITUKSELLA VAIN TILASSA, EI KOSKAAN KANNASSA.
     * Ehdotus elää siihen asti että se hyväksytään tai hylätään;
     * hyväksynnästä syntyy tavallisia rivejä, ja ehdotus katoaa.
     * Hylätty ehdotus on roskaa, joka ei koskaan katoaisi itsestään.
     *
     * Sama päätös kuin kuittiluennalla. Ks. migraatio 0010.
     */
    pendingPlan: null,

    /** Muutosehdotus, jota käyttäjä parhaillaan tarkistaa. */
    pendingReplan: null,

    /**
     * Automaatiotaso.
     *
     * Luetaan laitekohtaisesta asetuksesta ja EPÄONNISTUU
     * TURVALLISESTI: tuntematon tai puuttuva arvo putoaa tasolle 1.
     */
    automationLevel: normalizeAutomationLevel(getDevicePreference('automationLevel')),

    /** Tavoite, jonka yksityiskohtia katsotaan. Null = lista. */
    openGoalId: null,
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
    editingTransactionId: null,
    editingInvestmentId: null,
    editingMilestoneId: null,
    /** Tavoitenäkymän osio: 'goals', 'projects' tai 'plan'. */
    goalsSegment: 'goals',
    /** Talousnäkymän osio. Ks. FINANCE_SEGMENTS alla. */
    financeSegment: 'overview',
    /**
     * Budjettinäkymän kuukausi 'YYYY-MM'.
     *
     * Oletus on kuluva kuukausi. Tämä on VALINTA, ei suodatin: kaikki
     * tieto on tallessa, näkymä vain katsoo yhtä kuukautta kerrallaan.
     */
    budgetMonth: fmtISO(today).slice(0, 7),
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

// ----------------------------------------------------- välitavoitteet

/** Aseta välitavoitteet. */
export function setMilestones(milestones) {
  commit({ milestones: (milestones || []).map(normalizeMilestone) });
}

export function addMilestoneToState(milestone) {
  commit({ milestones: [...state.milestones, normalizeMilestone(milestone)] });
}

export function replaceMilestoneInState(id, milestone) {
  commit({
    milestones: state.milestones.map(
      m => (m.id === id ? normalizeMilestone(milestone) : m))
  });
}

/**
 * Poista välitavoite tilasta.
 *
 * TEHTÄVÄT JA PROJEKTIT EIVÄT POISTU MUKANA — niiden liitos katkeaa.
 * Tehtävä on tehty tai tekemättä riippumatta siitä, onko sen
 * tarkistuspiste yhä olemassa. Kannassa sama sääntö on
 * `on delete set null (milestone_id)`.
 */
export function removeMilestoneFromState(id) {
  commit({
    milestones: state.milestones.filter(m => m.id !== id),
    tasks: state.tasks.map(t => (t.milestoneId === id ? { ...t, milestoneId: null } : t)),
    projects: state.projects.map(
      p => (p.milestoneId === id ? { ...p, milestoneId: null } : p))
  });
}

export function findMilestone(id) {
  return state.milestones.find(m => m.id === id) || null;
}

/** Korvaa useita välitavoitteita kerralla. Käytetään järjestyksen muutoksessa. */
export function replaceMilestonesInState(updated = []) {
  const byId = new Map(updated.map(m => [m.id, normalizeMilestone(m)]));
  commit({ milestones: state.milestones.map(m => byId.get(m.id) || m) });
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

// -------------------------------------------------------- tapahtumat
//
// Tapahtuma on yksi rahaliike: meno, tulo tai siirto. Sama muoto kuin
// muillakin kokoelmilla.
//
// SUUNTA ON `kind`, EI ETUMERKKI. Summa on aina positiivinen.

/** Aseta tapahtumat. */
export function setTransactions(transactions) {
  commit({ transactions: (transactions || []).map(normalizeTransaction) });
}

export function addTransactionToState(transaction) {
  commit({ transactions: [...state.transactions, normalizeTransaction(transaction)] });
}

export function replaceTransactionInState(id, transaction) {
  commit({
    transactions: state.transactions.map(
      t => (t.id === id ? normalizeTransaction(transaction) : t))
  });
}

export function removeTransactionFromState(id) {
  commit({ transactions: state.transactions.filter(t => t.id !== id) });
}

export function findTransaction(id) {
  return state.transactions.find(t => t.id === id) || null;
}

// -------------------------------------------------------- sijoitukset

/** Aseta sijoitukset. */
export function setInvestments(holdings) {
  commit({ investments: (holdings || []).map(normalizeHolding) });
}

export function addInvestmentToState(holding) {
  commit({ investments: [...state.investments, normalizeHolding(holding)] });
}

export function replaceInvestmentInState(id, holding) {
  commit({
    investments: state.investments.map(
      h => (h.id === id ? normalizeHolding(holding) : h))
  });
}

export function removeInvestmentFromState(id) {
  commit({ investments: state.investments.filter(h => h.id !== id) });
}

export function findInvestment(id) {
  return state.investments.find(h => h.id === id) || null;
}

// ------------------------------------------------------- kuittiluenta
//
// TÄMÄ EI OLE KOKOELMA VAAN YKSI KESKEN OLEVA LUENTA.
//
// Luenta on väliaikainen: se odottaa käyttäjän tarkistusta. Sitä ei
// tallenneta mihinkään eikä se säily sivun latauksen yli. Kun käyttäjä
// hyväksyy sen, siitä syntyy tapahtuma tai lasku — ja luenta katoaa.
//
// Tässä ei ole eikä saa olla kuvaa. Ks. src/domain/receipts.js.

/** Aseta tarkistusta odottava luenta. */
export function setPendingExtraction(extraction) {
  commit({ pendingExtraction: extraction || null });
}

/** Unohda kesken oleva luenta. Kutsutaan hyväksynnän ja hylkäyksen jälkeen. */
export function clearPendingExtraction() {
  commit({ pendingExtraction: null });
}

// --------------------------------------------------- suunnitelmaehdotus
//
// EHDOTUS EI OLE KOKOELMA VAAN YKSI KESKEN OLEVA ASIA.
//
// Se odottaa käyttäjän tarkistusta eikä sitä tallenneta mihinkään.
// Hyväksynnästä syntyy tavallisia rivejä, ja ehdotus katoaa.

/** Aseta tarkistusta odottava suunnitelmaehdotus. */
export function setPendingPlan(plan) {
  commit({ pendingPlan: plan || null });
}

/** Unohda ehdotus. Kutsutaan hyväksynnän ja hylkäyksen jälkeen. */
export function clearPendingPlan() {
  commit({ pendingPlan: null });
}

/** Aseta tarkistusta odottava muutosehdotus. */
export function setPendingReplan(proposal) {
  commit({ pendingReplan: proposal || null });
}

export function clearPendingReplan() {
  commit({ pendingReplan: null });
}

/**
 * Automaatiotaso.
 *
 * Kirjoitetaan myös laitekohtaiseen asetukseen, jotta valinta säilyy
 * sivun latauksen yli. Kirjoituksen epäonnistuminen (yksityinen ikkuna,
 * estetty tallennus) ei ole virhe: tila pysyy silti oikeana istunnon
 * ajan, ja seuraava lataus palaa varovaisimpaan tasoon.
 */
export function setAutomationLevel(level) {
  const normalized = normalizeAutomationLevel(level);
  setDevicePreference('automationLevel', normalized);
  commit({ automationLevel: normalized });
}

/** Avaa tavoitteen yksityiskohdat. Null palaa listaan. */
export function setOpenGoalId(id) {
  commit({ openGoalId: id != null ? String(id) : null });
}

export function setEditingMilestoneId(id) {
  commit({ editingMilestoneId: id });
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

export function setEditingTransactionId(id) {
  commit({ editingTransactionId: id });
}

export function setEditingInvestmentId(id) {
  commit({ editingInvestmentId: id });
}

export function setTasksSegment(segment) {
  commit({ tasksSegment: segment === 'routines' ? 'routines' : 'tasks' });
}

/** Tavoitenäkymän osiot. */
export const GOALS_SEGMENTS = Object.freeze([
  { key: 'goals', label: 'Tavoitteet' },
  { key: 'projects', label: 'Projektit' },
  { key: 'plan', label: 'Suunnittelu' }
]);

const GOALS_SEGMENT_KEYS = Object.freeze(GOALS_SEGMENTS.map(s => s.key));

/** Tavoitenäkymän osio. Tuntematon arvo palautuu tavoitteisiin. */
export function setGoalsSegment(segment) {
  commit({
    goalsSegment: GOALS_SEGMENT_KEYS.includes(segment) ? segment : 'goals'
  });
}

/**
 * Talousnäkymän osiot.
 *
 * Seitsemän osiota on paljon yhdelle riville puhelimessa, joten
 * käyttöliittymä kelaa niitä vaakasuunnassa. Jaottelu on tekemisen
 * mukaan eikä tietomallin: käyttäjä ei etsi "tapahtumataulua" vaan
 * kysyy "mihin rahani meni".
 */
export const FINANCE_SEGMENTS = Object.freeze([
  { key: 'overview', label: 'Yleiskuva' },
  { key: 'transactions', label: 'Tapahtumat' },
  { key: 'budget', label: 'Budjetti' },
  { key: 'bills', label: 'Laskut' },
  { key: 'expenses', label: 'Toistuvat' },
  { key: 'savings', label: 'Säästöt' },
  { key: 'investments', label: 'Sijoitukset' }
]);

const FINANCE_SEGMENT_KEYS = Object.freeze(FINANCE_SEGMENTS.map(s => s.key));

/** Talousnäkymän osio. Tuntematon arvo palautuu yleiskuvaan. */
export function setFinanceSegment(segment) {
  commit({
    financeSegment: FINANCE_SEGMENT_KEYS.includes(segment) ? segment : 'overview'
  });
}

/**
 * Budjettinäkymän kuukausi.
 *
 * Kelvoton arvo jätetään huomiotta: väärä kuukausi näyttäisi tyhjää
 * budjettia, ja tyhjä budjetti näyttää siltä kuin rahaa ei olisi
 * liikkunut.
 */
export function setBudgetMonth(month) {
  const valid = typeof month === 'string' && /^\d{4}-\d{2}$/.test(month);
  if (!valid) return;
  commit({ budgetMonth: month });
}

/** Siirry kuukausi eteen tai taakse. */
export function shiftBudgetMonth(delta) {
  const [year, month] = state.budgetMonth.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1 + delta, 1));
  commit({ budgetMonth: date.toISOString().slice(0, 7) });
}

/** Kuukausitunniste päivästä. Sama toteutus kuin budjetissa. */
export { monthKey };

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
