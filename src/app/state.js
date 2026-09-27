// Sovelluksen tila.
//
// Yksi paikka, jossa tilaa muutetaan. Aiemmin tila oli globaali olio, jota
// mikä tahansa funktio saattoi mutatoida suoraan — myös datakerros.
//
// Muutokset ilmoitetaan tilaajille (subscribe), jolloin näkymät päivittyvät
// eikä yksikään toiminto joudu muistamaan kutsua renderAll().

import { todayMidnight, startOfWeek, fmtISO } from '../lib/datetime.js';
import { logFailure, LOG_LEVEL } from '../lib/logger.js';
import { DEFAULT_PROFILE } from '../domain/scheduler.js';
import { normalizeTask, isIsoDate } from '../domain/task.js';
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
import { normalizeInboxItem } from '../domain/inbox.js';
import { normalizeReminder } from '../domain/reminder.js';
import { normalizeNotice } from '../domain/notificationCenter.js';
import { normalizeTravelPlan, normalizeLocationRule } from '../domain/travel.js';
import { normalizeLifeArea } from '../domain/lifeArea.js';
import { normalizeWeeklyCapacity } from '../domain/weeklyCapacity.js';
import { normalizeTimeEntry } from '../domain/timeEntry.js';
import { normalizeAlignmentReview } from '../domain/alignmentReview.js';
import { normalizeItemSettings } from '../domain/alignmentItemSettings.js';
import { normalizeTimer } from '../domain/timer.js';
import { normalizeSavedPlace, normalizePlaceAlias } from '../domain/savedPlace.js';
import { normalizeCalendarEvent } from '../domain/calendarEvent.js';
import { normalizeCommuteObservation } from '../domain/commuteObservation.js';
import { normalizeLifeSettings, effectiveLifeSettings } from '../domain/lifeSettings.js';
import { normalizeSleepLog } from '../domain/sleepLog.js';
import { normalizeHabitPlan, normalizeHabitEvent } from '../domain/habit.js';
import { normalizeExerciseSession } from '../domain/exerciseSession.js';
import { normalizeWellbeingCheckin } from '../domain/wellbeingCheckin.js';
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
     * Saapuvat: kirjaa nyt, järjestä myöhemmin.
     * Ei säily ennen migraatiota 0011.
     */
    inboxItems: [],

    /** Muistutukset. Ei säily ennen migraatiota 0011. */
    reminders: [],

    /** Ilmoitushistoria. Ei säily ennen migraatiota 0011. */
    notices: [],

    /** Matkasuunnitelmat. Ei säily ennen migraatiota 0011. */
    travelPlans: [],

    /** Sijaintisäännöt. Ei säily ennen migraatiota 0011. */
    locationRules: [],

    /** Suunta (0012). Ei säily ennen migraatiota 0012. */
    lifeAreas: [],
    weeklyCapacities: [],
    timeEntries: [],
    alignmentReviews: [],
    /** Suunta 2 (0013): kohdeasetukset ja käynnissä oleva ajastin (0–1). */
    alignmentItemSettings: [],
    runningTimers: [],

    /**
     * Arjen käyttöjärjestelmä (0014). Ei säily ennen migraatiota 0014.
     * `lifeSettings` on 0–1 riviä: puuttuva rivi = oletukset
     * (currentLifeSettings). Uni-, motivaatio- ja tapakirjaukset ovat
     * arkaluonteisia: ne eivät kulje tekoälylle eivätkä lokiin.
     */
    savedPlaces: [],
    placeAliases: [],
    calendarEvents: [],
    commuteObservations: [],
    lifeSettings: [],
    sleepLogs: [],
    habitPlans: [],
    habitEvents: [],
    exerciseSessions: [],
    wellbeingCheckins: [],

    /**
     * Kirjaus, jonka tulkintaa käyttäjä parhaillaan tarkistaa.
     *
     * TÄMÄ ON TARKOITUKSELLA VAIN TILASSA. Sama päätös kuin
     * kuittiluennalla ja suunnitelmaehdotuksella: tulkinta elää siihen
     * asti että se hyväksytään tai hylätään.
     *
     * HUOM. `inbox_items.proposal` on eri asia ja tietoinen poikkeus:
     * saapuva RIVI säilyttää ehdotuksensa, koska ilman sitä käyttäjä
     * näkisi tulkinnan vain kerran. Tämä kenttä on se tulkinta, jota
     * hän katsoo juuri nyt.
     */
    pendingCapture: null,

    /**
     * Puhesyötteen hetkellinen tila: null | 'listening' | 'processing'.
     *
     * EI KOSKAAN KANNASSA EIKÄ LEVYLLÄ. Ääntä ei tallenneta; tämä
     * kertoo vain, näytetäänkö mikrofoni aktiivisena.
     */
    voiceState: null,

    /** Muokattavan muistutuksen, matkan tai säännön tunniste. */
    editingReminderId: null,
    editingTravelPlanId: null,
    editingLocationRuleId: null,

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
    /** Profiilinäkymän osio. Ks. PROFILE_SEGMENTS alla. */
    profileSegment: 'daily',
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
    /**
     * Kalenterin näkymä: 'day', 'week' tai 'month'. Oletus on päivä,
     * koska kalenteri vastaa ensin kysymykseen "mitä tänään on".
     */
    calendarView: 'day',
    /**
     * Kalenterin katsottava päivä ISO-muodossa. Päivä- ja kuukausinäkymä
     * lukevat tätä; viikkonäkymällä on oma `weekStart`, jotta vanha
     * viikkonäkymä toimii täsmälleen kuten ennen.
     */
    calendarDate: fmtISO(today),
    /** Näkymä, joka on auki. */
    screen: 'screen-today',
    /** Onko ensimmäinen lataus vielä kesken. */
    loading: true,

    /**
     * Kokoelmakohtainen latausstatus: { [domain]: { ok, error, lastSuccessAt } }.
     *
     * TÄTÄ VARTEN: ilman tätä loadUserData() ei voisi erottaa "kokoelma on
     * oikeasti tyhjä" ja "haku epäonnistui" -tilanteita, ja uudelleenlataus
     * (verkon palautuminen) päätyisi kirjoittamaan tyhjän listan tilalle
     * jo ladatun datan päälle transientin virheen sattuessa. Ks.
     * setDomainLoadStatus() ja loadUserData().
     */
    dataLoadStatus: {}
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

/**
 * Sisäkkäisten batch()-kutsujen syvyys. Sillä aikaa commit() ei ilmoita
 * tilaajille, vaan ilmoitus jää velaksi ja lähtee kerran uloimman batchin
 * lopussa.
 */
let batchDepth = 0;
/** Muuttuiko tila batchin aikana (ilmoitus on velkaa)? */
let notifyOwed = false;

function notify() {
  if (batchDepth > 0) {
    notifyOwed = true;
    return;
  }
  for (const listener of listeners) {
    try {
      listener(state);
    } catch (error) {
      // Yhden näkymän virhe ei saa estää muiden päivittymistä.
      logFailure('state.listener_failed', error, LOG_LEVEL.ERROR);
    }
  }
}

function commit(changes) {
  state = { ...state, ...changes };
  notify();
}

/**
 * Kokoa useampi tilamuutos YHDEKSI ilmoitukseksi.
 *
 * MIKSI: jokainen commit() ilmoittaa tilaajille synkronisesti, ja tilaaja
 * (main.js renderAll) piirtää näkymät. Yksi lataus (loadUserData) asettaa
 * parikymmentä kokoelmaa ja niiden latausstatuksen — ilman tätä yksi
 * lataus tuotti 52 täyttä piirtoa (CRIT-01).
 *
 * Muutokset tehdään heti (getState() näkee ne batchin sisälläkin); vain
 * ilmoitus odottaa uloimman batchin loppuun. Jos mikään ei muuttunut,
 * ilmoitusta ei lähetetä. Heittävä `fn` ei jätä ilmoitusta lähettämättä:
 * jo tehdyt muutokset näkyvät tilaajille, ja virhe välittyy kutsujalle.
 *
 * VAIN SYNKRONISELLE KOODILLE. Odotus (await) batchin sisällä päättäisi
 * batchin ennen kuin odotuksen jälkeiset muutokset tehdään.
 *
 * @template T
 * @param {() => T} fn
 * @returns {T} fn:n paluuarvo
 */
export function batch(fn) {
  batchDepth += 1;
  try {
    return fn();
  } finally {
    batchDepth -= 1;
    if (batchDepth === 0 && notifyOwed) {
      notifyOwed = false;
      notify();
    }
  }
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

/**
 * Poista tehtävä muistista.
 *
 * MATKASUUNNITELMA JA SIJAINTISÄÄNTÖ EIVÄT POISTU MUKANA — niiden
 * liitos katkeaa. Kannassa sama sääntö on
 * `on delete set null (task_id)`, ja tämä on sen peilikuva muistissa.
 *
 * Muistutukset EIVÄT ole täällä. Ne eivät ole vierasavaimella
 * kiinnitettyjä, eikä orpoa muistutusta saa poistaa hiljaa: se
 * perutaan näkyvästi toimintokerroksessa, jotta peruutus myös
 * tallentuu. Ks. `cancelOrphanedReminders` tiedostossa actions.js.
 */
export function removeTaskFromState(id) {
  commit({
    tasks: state.tasks.filter(t => t.id !== id),
    travelPlans: state.travelPlans.map(
      p => (p.taskId === id ? { ...p, taskId: null } : p)),
    locationRules: state.locationRules.map(
      r => (r.taskId === id ? { ...r, taskId: null } : r)),
    // Kirjattu aika säilyy; tehtäväliitos katkeaa (time_entries_task_fkey).
    timeEntries: state.timeEntries.map(e => (e.taskId === id ? { ...e, taskId: null } : e))
  });
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
    tasks: state.tasks.map(t => (t.goalId === id ? { ...t, goalId: null } : t)),
    // Kirjattu aika säilyy; tavoiteliitos katkeaa (time_entries_goal_fkey).
    timeEntries: state.timeEntries.map(e => (e.goalId === id ? { ...e, goalId: null } : e)),
    // Menot ja liikuntakerrat säilyvät (0014: on delete set null (goal_id)).
    calendarEvents: state.calendarEvents.map(e => (e.goalId === id ? { ...e, goalId: null } : e)),
    exerciseSessions: state.exerciseSessions.map(s => (s.goalId === id ? { ...s, goalId: null } : s))
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

/**
 * Tekemisen osiot.
 *
 * Kaikki viisi ovat "asioita jotka pitaa tehda tai muistaa", joten ne
 * kuuluvat samaan nakymaan. Ne ovat silti ERI KASITTEITA, joten ne
 * eivat sekoitu yhteen listaan.
 */
export const TASKS_SEGMENTS = Object.freeze([
  { key: 'tasks', label: 'Tehtavat' },
  { key: 'routines', label: 'Rutiinit' },
  { key: 'inbox', label: 'Saapuvat' },
  { key: 'reminders', label: 'Muistutukset' },
  { key: 'travel', label: 'Matka' }
]);

const TASKS_SEGMENT_KEYS = Object.freeze(TASKS_SEGMENTS.map(s => s.key));

/** Tekemisnakyman osio. Tuntematon arvo palautuu tehtaviin. */
export function setTasksSegment(segment) {
  commit({
    tasksSegment: TASKS_SEGMENT_KEYS.includes(segment) ? segment : 'tasks'
  });
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

/**
 * Kalenterin näkymät. Järjestys on segmenttien järjestys: päivä ensin,
 * koska se on useimmin avattu.
 */
export const CALENDAR_VIEWS = Object.freeze([
  Object.freeze({ key: 'day', label: 'Päivä' }),
  Object.freeze({ key: 'week', label: 'Viikko' }),
  Object.freeze({ key: 'month', label: 'Kuukausi' })
]);

const CALENDAR_VIEW_KEYS = Object.freeze(CALENDAR_VIEWS.map(v => v.key));

/** Kalenterin näkymä. Tuntematon arvo palautuu päivään. */
export function setCalendarView(view) {
  const next = CALENDAR_VIEW_KEYS.includes(view) ? view : 'day';
  if (next === state.calendarView) return;
  commit({ calendarView: next });
}

/**
 * Kalenterin katsottava päivä. Kelvoton päivä jätetään huomiotta: väärä
 * päivä näyttäisi tyhjää kalenteria, ja tyhjä kalenteri näyttää siltä
 * kuin menoja ei olisi.
 */
export function setCalendarDate(dateIso) {
  if (!isIsoDate(dateIso) || dateIso === state.calendarDate) return;
  commit({ calendarDate: dateIso });
}

/**
 * Avaa päivänäkymä annetulle päivälle YHDELLÄ muutoksella (kuukauden tai
 * viikon päivän napautus): kaksi peräkkäistä muutosta piirtäisi näkymän
 * välissä väärälle päivälle.
 */
export function showCalendarDay(dateIso) {
  if (!isIsoDate(dateIso)) return;
  if (state.calendarView === 'day' && state.calendarDate === dateIso) return;
  commit({ calendarView: 'day', calendarDate: dateIso });
}

/** Siirry kuukausi eteen tai taakse. */
export function shiftBudgetMonth(delta) {
  const [year, month] = state.budgetMonth.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1 + delta, 1));
  commit({ budgetMonth: date.toISOString().slice(0, 7) });
}

/** Kuukausitunniste päivästä. Sama toteutus kuin budjetissa. */
export { monthKey };

// =====================================================================
// HENKILÖKOHTAINEN AVUSTAJA
// =====================================================================
//
// Viisi kokoelmaa, joilla on kaikilla sama muoto kuin muillakin.
// Poikkeukset ovat KOHDELIITOKSISSA, ja ne on kirjoitettu auki alla:
// muistutus ja ilmoitus eivät katoa kohteen mukana, matkasuunnitelma
// ei katoa tehtävän mukana.

// ------------------------------------------------------------- saapuvat

export function setInboxItems(items) {
  commit({ inboxItems: (items || []).map(normalizeInboxItem) });
}

export function addInboxItemToState(item) {
  commit({ inboxItems: [...state.inboxItems, normalizeInboxItem(item)] });
}

export function replaceInboxItemInState(id, item) {
  commit({
    inboxItems: state.inboxItems.map(
      i => (i.id === id ? normalizeInboxItem(item) : i))
  });
}

export function removeInboxItemFromState(id) {
  commit({ inboxItems: state.inboxItems.filter(i => i.id !== id) });
}

export function findInboxItem(id) {
  return state.inboxItems.find(i => i.id === id) || null;
}

/**
 * Kirjaus, jonka tulkintaa käyttäjä tarkistaa.
 *
 * Null tyhjentää. Tämä EI kirjoita mihinkään pysyvään.
 */
export function setPendingCapture(capture) {
  commit({ pendingCapture: capture || null });
}

/**
 * Puhesyötteen hetkellinen tila.
 *
 * Tuntematon arvo tyhjentää sen sijaan että se jäisi roikkumaan:
 * mikrofoni, joka näyttää kuuntelevan vaikkei kuuntele, on pahempi
 * kuin mikrofoni joka ei näytä mitään.
 */
export function setVoiceState(voiceState) {
  const valid = voiceState === 'listening' || voiceState === 'processing';
  commit({ voiceState: valid ? voiceState : null });
}

// --------------------------------------------------------- muistutukset

export function setReminders(reminders) {
  commit({ reminders: (reminders || []).map(normalizeReminder) });
}

export function addReminderToState(reminder) {
  commit({ reminders: [...state.reminders, normalizeReminder(reminder)] });
}

export function replaceReminderInState(id, reminder) {
  commit({
    reminders: state.reminders.map(
      r => (r.id === id ? normalizeReminder(reminder) : r))
  });
}

export function removeReminderFromState(id) {
  commit({ reminders: state.reminders.filter(r => r.id !== id) });
}

export function findReminder(id) {
  return state.reminders.find(r => r.id === id) || null;
}

/** Korvaa useita muistutuksia kerralla. Käytetään hälytyskierroksessa. */
export function replaceRemindersInState(updated = []) {
  const byId = new Map(updated.map(r => [r.id, normalizeReminder(r)]));
  commit({ reminders: state.reminders.map(r => byId.get(r.id) || r) });
}

// ------------------------------------------------------------ ilmoitukset

export function setNotices(notices) {
  commit({ notices: (notices || []).map(normalizeNotice) });
}

/**
 * Lisää ilmoitus — TAI ÄLÄ, jos sama avain on jo olemassa.
 *
 * Kaksoiskappaleiden esto on tässä ensimmäinen este ja kannan
 * `notices_key_unique` toinen. Palauttaa `true`, jos rivi syntyi.
 */
export function addNoticeToState(notice) {
  const normalized = normalizeNotice(notice);
  if (!normalized.key) return false;
  if (state.notices.some(n => n.key === normalized.key)) return false;
  commit({ notices: [...state.notices, normalized] });
  return true;
}

export function replaceNoticeInState(id, notice) {
  commit({
    notices: state.notices.map(n => (n.id === id ? normalizeNotice(notice) : n))
  });
}

export function removeNoticeFromState(id) {
  commit({ notices: state.notices.filter(n => n.id !== id) });
}

export function findNotice(id) {
  return state.notices.find(n => n.id === id) || null;
}

/** Korvaa koko ilmoituslista. Käytetään karsinnassa. */
export function replaceNoticesInState(notices = []) {
  commit({ notices: notices.map(normalizeNotice) });
}

// ------------------------------------------------------------------ matka

export function setTravelPlans(plans) {
  commit({ travelPlans: (plans || []).map(normalizeTravelPlan) });
}

export function addTravelPlanToState(plan) {
  commit({ travelPlans: [...state.travelPlans, normalizeTravelPlan(plan)] });
}

export function replaceTravelPlanInState(id, plan) {
  commit({
    travelPlans: state.travelPlans.map(
      p => (p.id === id ? normalizeTravelPlan(plan) : p))
  });
}

export function removeTravelPlanFromState(id) {
  commit({ travelPlans: state.travelPlans.filter(p => p.id !== id) });
}

export function findTravelPlan(id) {
  return state.travelPlans.find(p => p.id === id) || null;
}

// --------------------------------------------------- sijaintisäännöt

export function setLocationRules(rules) {
  commit({ locationRules: (rules || []).map(normalizeLocationRule) });
}

export function addLocationRuleToState(rule) {
  commit({ locationRules: [...state.locationRules, normalizeLocationRule(rule)] });
}

export function replaceLocationRuleInState(id, rule) {
  commit({
    locationRules: state.locationRules.map(
      r => (r.id === id ? normalizeLocationRule(rule) : r))
  });
}

export function removeLocationRuleFromState(id) {
  commit({ locationRules: state.locationRules.filter(r => r.id !== id) });
}

export function findLocationRule(id) {
  return state.locationRules.find(r => r.id === id) || null;
}

// ----------------------------------------------------------- muokkaus

export function setEditingReminderId(id) {
  commit({ editingReminderId: id });
}

export function setEditingTravelPlanId(id) {
  commit({ editingTravelPlanId: id });
}

export function setEditingLocationRuleId(id) {
  commit({ editingLocationRuleId: id });
}

// ------------------------------------------------------------------ näkymä

export function setViewDate(date) {
  commit({ viewDate: date });
}

export function setWeekStart(date) {
  commit({ weekStart: date });
}

/**
 * Kirjautuminen: Tänään-näkymän päivä, viikko ja Kalenterin päivä tähän
 * päivään YHDELLÄ ilmoituksella. Sovellus avautuu aina tähän päivään, ei
 * siihen, mihin edellinen istunto jäi.
 *
 * KAIKKI KATSOTTAVAT PÄIVÄT YHDESSÄ PAIKASSA. Aiemmin kirjautuminen nollasi
 * vain päivän ja viikon; Kalenterin päivä jäi uloskirjautumisen
 * resetState()-kutsun päivään. Keskiyön yli odottanut kirjautumisnäkymä
 * avasi Kalenterin eiliseen ("Eilen"), ja "Uusi meno" ehdotti eilistä.
 */
export function resetDatesToToday(today = todayMidnight()) {
  batch(() => {
    setViewDate(today);
    setWeekStart(startOfWeek(today));
    setCalendarDate(fmtISO(today));
  });
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

/**
 * Profiilinäkymän osiot. Arki on ensimmäinen, koska sitä säädetään
 * useimmin (uni, herätys, aamu); tilin asetukset ovat harvoin tarvittuja.
 */
export const PROFILE_SEGMENTS = Object.freeze([
  { key: 'daily', label: 'Arki' },
  { key: 'wellbeing', label: 'Hyvinvointi' },
  { key: 'places', label: 'Paikat' },
  { key: 'settings', label: 'Asetukset' }
]);

const PROFILE_SEGMENT_KEYS = Object.freeze(PROFILE_SEGMENTS.map(s => s.key));

/** Profiilinäkymän osio. Tuntematon arvo palautuu Arkeen. */
export function setProfileSegment(segment) {
  commit({
    profileSegment: PROFILE_SEGMENT_KEYS.includes(segment) ? segment : 'daily'
  });
}

// -------------------------------------------------------------- lataustila

/**
 * Merkitse yhden kokoelman viimeisimmän haun tulos.
 *
 * KUTSUJA VASTAA SIITÄ, ETTÄ TILAN KOKOELMA PÄIVITETÄÄN VAIN ONNISTUNEELLA
 * HAULLA. Tämä funktio ei koskaan tyhjennä eikä korvaa kokoelmaa itseään —
 * se ainoastaan kirjaa, oliko viimeisin haku onnistunut, jotta näkymä voi
 * kertoa käyttäjälle tiedon olevan vanhentunutta ilman että tieto katoaa.
 *
 * @param {string} domain esim. 'tasks', 'routines'
 * @param {boolean} ok
 * @param {*} [error] tallennetaan vain epäonnistuessa
 */
export function setDomainLoadStatus(domain, ok, error = null) {
  const previous = state.dataLoadStatus[domain] || { lastSuccessAt: null };
  commit({
    dataLoadStatus: {
      ...state.dataLoadStatus,
      [domain]: {
        ok,
        error: ok ? null : error,
        lastSuccessAt: ok ? Date.now() : previous.lastSuccessAt
      }
    }
  });
}

// ------------------------------------------------------------------ elinkaari


/**
 * Palauta tila alkutilaan.
 * Kutsutaan uloskirjautumisessa: seuraava käyttäjä samalla laitteella ei saa
 * nähdä vilaustakaan edellisen datasta.
 */
// ------------------------------------------------------------ Suunta

export function setLifeAreas(areas) {
  commit({ lifeAreas: (areas || []).map(normalizeLifeArea) });
}

export function addLifeAreaToState(area) {
  commit({ lifeAreas: [...state.lifeAreas, normalizeLifeArea(area)] });
}

export function replaceLifeAreaInState(id, area) {
  commit({ lifeAreas: state.lifeAreas.map(a => (a.id === id ? normalizeLifeArea(area) : a)) });
}

/**
 * Poista alue. Tavoitteet ja kirjattu aika SÄILYVÄT, niiden alue vain
 * tyhjenee — sama sääntö kuin kannassa (`on delete set null`).
 */
export function removeLifeAreaFromState(id) {
  commit({
    lifeAreas: state.lifeAreas.filter(a => a.id !== id),
    goals: state.goals.map(g => (g.lifeAreaId === id ? { ...g, lifeAreaId: null } : g)),
    timeEntries: state.timeEntries.map(e => (e.lifeAreaId === id ? { ...e, lifeAreaId: null } : e))
  });
}

/** Peruutus epäonnistuneelle poistolle: alue ja sen kytkennät takaisin. */
export function restoreLifeAreaInState(area, goalIds = [], entryIds = []) {
  const goals = new Set(goalIds);
  const entries = new Set(entryIds);
  commit({
    lifeAreas: [...state.lifeAreas.filter(a => a.id !== area.id), normalizeLifeArea(area)],
    goals: state.goals.map(g => (goals.has(g.id) ? { ...g, lifeAreaId: area.id } : g)),
    timeEntries: state.timeEntries.map(e => (entries.has(e.id) ? { ...e, lifeAreaId: area.id } : e))
  });
}

export function findLifeArea(id) {
  return state.lifeAreas.find(a => a.id === id) || null;
}

export function setWeeklyCapacities(capacities) {
  commit({ weeklyCapacities: (capacities || []).map(normalizeWeeklyCapacity) });
}

/** Yksi rivi viikkoa kohti: sama viikko korvataan. */
export function upsertWeeklyCapacityInState(capacity) {
  const normalized = normalizeWeeklyCapacity(capacity);
  commit({
    weeklyCapacities: [
      ...state.weeklyCapacities.filter(c => c.weekStart !== normalized.weekStart && c.id !== normalized.id),
      normalized
    ]
  });
}

export function removeWeeklyCapacityFromState(id) {
  commit({ weeklyCapacities: state.weeklyCapacities.filter(c => c.id !== id) });
}

export function setTimeEntries(entries) {
  commit({ timeEntries: (entries || []).map(normalizeTimeEntry) });
}

export function addTimeEntryToState(entry) {
  commit({ timeEntries: [...state.timeEntries, normalizeTimeEntry(entry)] });
}

export function removeTimeEntryFromState(id) {
  commit({ timeEntries: state.timeEntries.filter(e => e.id !== id) });
}

export function setAlignmentReviews(reviews) {
  commit({ alignmentReviews: (reviews || []).map(normalizeAlignmentReview) });
}

export function upsertAlignmentReviewInState(review) {
  const normalized = normalizeAlignmentReview(review);
  commit({
    alignmentReviews: [
      ...state.alignmentReviews.filter(r => r.weekStart !== normalized.weekStart && r.id !== normalized.id),
      normalized
    ]
  });
}

export function removeAlignmentReviewFromState(id) {
  commit({ alignmentReviews: state.alignmentReviews.filter(r => r.id !== id) });
}

// ------------------------------------------------------------ Suunta 2

export function setAlignmentItemSettings(settings) {
  commit({ alignmentItemSettings: (settings || []).map(normalizeItemSettings) });
}

/** Yksi rivi kohdetta kohti: sama kohde korvataan. */
export function upsertItemSettingsInState(settings) {
  const normalized = normalizeItemSettings(settings);
  commit({
    alignmentItemSettings: [
      ...state.alignmentItemSettings.filter(s => s.id !== normalized.id
        && !(s.itemKind === normalized.itemKind && s.itemId === normalized.itemId)),
      normalized
    ]
  });
}

export function removeItemSettingsFromState(id) {
  commit({ alignmentItemSettings: state.alignmentItemSettings.filter(s => s.id !== id) });
}

/** Ajastin: enintään yksi. Tyhjä lista = ei ajastinta. */
export function setRunningTimers(timers) {
  const list = (timers || []).map(normalizeTimer).filter(timer => timer.id && timer.startedAt);
  commit({ runningTimers: list.slice(0, 1) });
}

export function setRunningTimerInState(timer) {
  commit({ runningTimers: timer ? [normalizeTimer(timer)] : [] });
}

export function replaceTimeEntryInState(id, entry) {
  commit({ timeEntries: state.timeEntries.map(e => (e.id === id ? normalizeTimeEntry(entry) : e)) });
}

// ---------------------------------------------- arjen käyttöjärjestelmä (0014)
//
// Tila noudattaa samoja poistosääntöjä kuin kanta (migraatio 0014):
//   paikan poisto vie lisänimet ja matkahavainnot (kaskadi) ja katkaisee
//   menojen paikkaliitoksen (set null); tavan poisto vie sen kirjaukset.
// Näin muistitila ja kanta eivät ajaudu erilleen portin auettua.

/** Tunnisteen mukainen korvaus: rivi, jota ei ole, EI synny (ei hiljaista lisäystä). */
function replaceById(list, id, next) {
  return list.map(item => (item.id === id ? next : item));
}

export function setSavedPlaces(places) {
  commit({ savedPlaces: (places || []).map(normalizeSavedPlace) });
}

export function addSavedPlaceToState(place) {
  commit({ savedPlaces: [...state.savedPlaces, normalizeSavedPlace(place)] });
}

export function replaceSavedPlaceInState(id, place) {
  commit({ savedPlaces: replaceById(state.savedPlaces, id, normalizeSavedPlace(place)) });
}

/**
 * Poista paikka kuten kanta: lisänimet ja matkahavainnot poistuvat,
 * menot jäävät ilman paikkaa. Palauttaa poistetut osat peruutusta varten
 * (restoreSavedPlaceInState), tai null jos paikkaa ei ollut.
 */
export function removeSavedPlaceFromState(id) {
  const place = state.savedPlaces.find(p => p.id === id) || null;
  if (!place) return null;
  const removed = {
    place,
    aliases: state.placeAliases.filter(a => a.placeId === id),
    observations: state.commuteObservations.filter(o => o.placeId === id),
    eventIds: state.calendarEvents.filter(e => e.placeId === id).map(e => e.id)
  };
  commit({
    savedPlaces: state.savedPlaces.filter(p => p.id !== id),
    placeAliases: state.placeAliases.filter(a => a.placeId !== id),
    commuteObservations: state.commuteObservations.filter(o => o.placeId !== id),
    calendarEvents: state.calendarEvents.map(e => (e.placeId === id ? { ...e, placeId: null } : e))
  });
  return removed;
}

/** Peruutus epäonnistuneelle poistolle: paikka, sen lapsirivit ja menojen liitokset takaisin. */
export function restoreSavedPlaceInState(removed) {
  if (!removed || !removed.place) return;
  const placeId = removed.place.id;
  const eventIds = new Set(removed.eventIds || []);
  const aliasIds = new Set((removed.aliases || []).map(a => a.id));
  const observationIds = new Set((removed.observations || []).map(o => o.id));
  commit({
    savedPlaces: [...state.savedPlaces.filter(p => p.id !== placeId), normalizeSavedPlace(removed.place)],
    placeAliases: [...state.placeAliases.filter(a => !aliasIds.has(a.id)),
      ...(removed.aliases || []).map(normalizePlaceAlias)],
    commuteObservations: [...state.commuteObservations.filter(o => !observationIds.has(o.id)),
      ...(removed.observations || []).map(normalizeCommuteObservation)],
    calendarEvents: state.calendarEvents.map(e => (eventIds.has(e.id) ? { ...e, placeId } : e))
  });
}

export function findSavedPlace(id) {
  return state.savedPlaces.find(p => p.id === id) || null;
}

export function setPlaceAliases(aliases) {
  commit({ placeAliases: (aliases || []).map(normalizePlaceAlias) });
}

/** Sama lisänimi samalle paikalle kerran (kanta: place_aliases_alias_unique). */
export function upsertPlaceAliasInState(alias) {
  const normalized = normalizePlaceAlias(alias);
  commit({
    placeAliases: [
      ...state.placeAliases.filter(a => a.id !== normalized.id
        && !(a.alias === normalized.alias && a.placeId === normalized.placeId)),
      normalized
    ]
  });
}

export function removePlaceAliasFromState(id) {
  commit({ placeAliases: state.placeAliases.filter(a => a.id !== id) });
}

export function findPlaceAlias(id) {
  return state.placeAliases.find(a => a.id === id) || null;
}

export function setCalendarEvents(events) {
  commit({ calendarEvents: (events || []).map(normalizeCalendarEvent) });
}

export function addCalendarEventToState(event) {
  commit({ calendarEvents: [...state.calendarEvents, normalizeCalendarEvent(event)] });
}

export function replaceCalendarEventInState(id, event) {
  commit({ calendarEvents: replaceById(state.calendarEvents, id, normalizeCalendarEvent(event)) });
}

export function removeCalendarEventFromState(id) {
  commit({ calendarEvents: state.calendarEvents.filter(e => e.id !== id) });
}

export function findCalendarEvent(id) {
  return state.calendarEvents.find(e => e.id === id) || null;
}

export function setCommuteObservations(observations) {
  commit({ commuteObservations: (observations || []).map(normalizeCommuteObservation) });
}

export function addCommuteObservationToState(observation) {
  commit({ commuteObservations: [...state.commuteObservations, normalizeCommuteObservation(observation)] });
}

export function removeCommuteObservationFromState(id) {
  commit({ commuteObservations: state.commuteObservations.filter(o => o.id !== id) });
}

/** Asetukset: 0–1 riviä. Lista, koska lataus ja vienti käsittelevät kokoelmia. */
export function setLifeSettings(rows) {
  commit({ lifeSettings: (rows || []).map(normalizeLifeSettings).slice(0, 1) });
}

/** YKSI RIVI KÄYTTÄJÄÄ KOHTI: uusi rivi korvaa aina edellisen. */
export function upsertLifeSettingsInState(settings) {
  commit({ lifeSettings: settings ? [normalizeLifeSettings(settings)] : [] });
}

/**
 * Voimassa olevat asetukset: tallennettu rivi tai oletukset. Ei koskaan
 * null — kutsujan ei tarvitse tietää, onko käyttäjä tallentanut mitään.
 */
export function currentLifeSettings(current = state) {
  return effectiveLifeSettings(current && current.lifeSettings);
}

export function setSleepLogs(logs) {
  commit({ sleepLogs: (logs || []).map(normalizeSleepLog) });
}

/** Yksi kirjaus heräämispäivää kohti (kanta: sleep_logs_wake_date_unique). */
export function upsertSleepLogInState(log) {
  const normalized = normalizeSleepLog(log);
  commit({
    sleepLogs: [
      ...state.sleepLogs.filter(l => l.id !== normalized.id && l.wakeDate !== normalized.wakeDate),
      normalized
    ]
  });
}

export function removeSleepLogFromState(id) {
  commit({ sleepLogs: state.sleepLogs.filter(l => l.id !== id) });
}

export function setHabitPlans(plans) {
  commit({ habitPlans: (plans || []).map(normalizeHabitPlan) });
}

export function addHabitPlanToState(plan) {
  commit({ habitPlans: [...state.habitPlans, normalizeHabitPlan(plan)] });
}

export function replaceHabitPlanInState(id, plan) {
  commit({ habitPlans: replaceById(state.habitPlans, id, normalizeHabitPlan(plan)) });
}

/**
 * Poista suunnitelma kuten kanta: sen kirjaukset poistuvat (kaskadi).
 * Palauttaa poistetut peruutusta varten (restoreHabitPlanInState).
 */
export function removeHabitPlanFromState(id) {
  const plan = state.habitPlans.find(p => p.id === id) || null;
  if (!plan) return null;
  const removed = { plan, events: state.habitEvents.filter(e => e.planId === id) };
  commit({
    habitPlans: state.habitPlans.filter(p => p.id !== id),
    habitEvents: state.habitEvents.filter(e => e.planId !== id)
  });
  return removed;
}

export function restoreHabitPlanInState(removed) {
  if (!removed || !removed.plan) return;
  const eventIds = new Set((removed.events || []).map(e => e.id));
  commit({
    habitPlans: [...state.habitPlans.filter(p => p.id !== removed.plan.id), normalizeHabitPlan(removed.plan)],
    habitEvents: [...state.habitEvents.filter(e => !eventIds.has(e.id)),
      ...(removed.events || []).map(normalizeHabitEvent)]
  });
}

export function findHabitPlan(id) {
  return state.habitPlans.find(p => p.id === id) || null;
}

export function setHabitEvents(events) {
  commit({ habitEvents: (events || []).map(normalizeHabitEvent) });
}

export function addHabitEventToState(event) {
  commit({ habitEvents: [...state.habitEvents, normalizeHabitEvent(event)] });
}

export function removeHabitEventFromState(id) {
  commit({ habitEvents: state.habitEvents.filter(e => e.id !== id) });
}

export function setExerciseSessions(sessions) {
  commit({ exerciseSessions: (sessions || []).map(normalizeExerciseSession) });
}

export function addExerciseSessionToState(session) {
  commit({ exerciseSessions: [...state.exerciseSessions, normalizeExerciseSession(session)] });
}

export function replaceExerciseSessionInState(id, session) {
  commit({ exerciseSessions: replaceById(state.exerciseSessions, id, normalizeExerciseSession(session)) });
}

export function removeExerciseSessionFromState(id) {
  commit({ exerciseSessions: state.exerciseSessions.filter(s => s.id !== id) });
}

export function findExerciseSession(id) {
  return state.exerciseSessions.find(s => s.id === id) || null;
}

export function setWellbeingCheckins(checkins) {
  commit({ wellbeingCheckins: (checkins || []).map(normalizeWellbeingCheckin) });
}

/** Yksi kirjaus päivää kohti (kanta: wellbeing_checkins_date_unique). */
export function upsertWellbeingCheckinInState(checkin) {
  const normalized = normalizeWellbeingCheckin(checkin);
  commit({
    wellbeingCheckins: [
      ...state.wellbeingCheckins.filter(c => c.id !== normalized.id && c.date !== normalized.date),
      normalized
    ]
  });
}

export function removeWellbeingCheckinFromState(id) {
  commit({ wellbeingCheckins: state.wellbeingCheckins.filter(c => c.id !== id) });
}

export function resetState() {
  state = initialState();
  notify();
}
