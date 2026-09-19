// Sovelluksen toiminnot: tilan, tietokannan ja käyttöliittymän yhteensovitus.
//
// TÄMÄ KERROS OMISTAA OPTIMISTISEN PÄIVITYKSEN.
//
// Aiemmin jokainen kirjoitus päivitti käyttöliittymän heti ja lähetti
// kirjoituksen matkaan välittämättä lopputuloksesta. Jos kirjoitus
// epäonnistui, näyttö jäi valehtelemaan onnistumisesta ja tieto katosi.
//
// Nyt jokainen kirjoitus noudattaa samaa kaavaa:
//   1. talleta nykytila
//   2. päivitä käyttöliittymä heti (nopea tuntuma säilyy)
//   3. kirjoita kantaan
//   4. jos kirjoitus epäonnistuu: PALAUTA aiempi tila ja kerro käyttäjälle
//
// Näin käyttöliittymä ei koskaan väitä tallentaneensa jotain, mitä ei
// tallennettu.

import * as tasksRepo from '../data/tasksRepo.js';
import * as profileRepo from '../data/profileRepo.js';
import {
  routinesRepo, routineExceptionsRepo, goalsRepo, projectsRepo, wellbeingRepo,
  billsRepo, recurringExpensesRepo, savingsGoalsRepo, aiAuditRepo,
  transactionsRepo, investmentsRepo, milestonesRepo,
  inboxRepo, remindersRepo, noticesRepo, travelPlansRepo, locationRulesRepo,
  volatileCollections, clearAllCollections
} from '../data/collectionsRepo.js';
import { newTaskId } from '../lib/rows.js';
import { offline, isOnlineNow } from './offline.js';
import { classifyError, ERROR_CLASS } from '../domain/offlineQueue.js';
import { fmtISO, todayMidnight } from '../lib/datetime.js';
import { normalizeTask, validateTask, SCHEDULING } from '../domain/task.js';
import { normalizeRoutine, validateRoutine, normalizeException, EXCEPTION } from '../domain/routine.js';
import { normalizeGoal, validateGoal } from '../domain/goal.js';
import { normalizeProject, validateProject } from '../domain/project.js';
import {
  normalizeBill, validateBill, normalizeRecurringExpense,
  validateRecurringExpense, normalizeSavingsGoal, validateSavingsGoal,
  BILL_STATUS
} from '../domain/finance.js';
import { normalizeWellbeingEntry, validateWellbeingEntry } from '../domain/wellbeing.js';
import {
  normalizeTransaction, validateTransaction, transactionFromBill,
  transactionFromSavings, hasTransactionFor, TRANSACTION_KIND,
  TRANSACTION_ORIGIN, SOURCE_KIND
} from '../domain/transactions.js';
import { normalizeHolding, validateHolding } from '../domain/investments.js';
import {
  normalizeMilestone, validateMilestone, nextOrderIndex, reorderMilestone,
  markReached, markOpen, markSkipped
} from '../domain/milestone.js';
import { buildReplanProposal } from '../domain/replan.js';
import {
  EXTRACTION_SUBJECT, validateExtraction, approveExtraction,
  toTransaction as extractionToTransaction, toBill as extractionToBill
} from '../domain/receipts.js';
import { extractFromImage } from './receiptCapture.js';
import { volatileFields } from '../data/schema.js';
import {
  getState, findTask, addTaskToState, removeTaskFromState,
  replaceTaskInState, patchTaskInState, setTasks, setProfile,
  clearOtherWakeFlagsInState,
  setRoutines, addRoutineToState, replaceRoutineInState, removeRoutineFromState, findRoutine,
  setRoutineExceptions, addRoutineExceptionToState, removeRoutineExceptionFromState,
  setGoals, addGoalToState, replaceGoalInState, removeGoalFromState, findGoal,
  setProjects, addProjectToState, replaceProjectInState, removeProjectFromState,
  findProject,
  setWellbeing, upsertWellbeingEntry, setNotificationPreferences,
  setBills, addBillToState, replaceBillInState, removeBillFromState, findBill,
  setRecurringExpenses, addRecurringExpenseToState, replaceRecurringExpenseInState,
  removeRecurringExpenseFromState, findRecurringExpense,
  setSavingsGoals, addSavingsGoalToState, replaceSavingsGoalInState,
  removeSavingsGoalFromState, findSavingsGoal,
  setTransactions, addTransactionToState, replaceTransactionInState,
  removeTransactionFromState, findTransaction,
  setInvestments, addInvestmentToState, replaceInvestmentInState,
  removeInvestmentFromState, findInvestment,
  clearPendingExtraction, setPendingExtraction,
  setMilestones, addMilestoneToState, replaceMilestoneInState,
  removeMilestoneFromState, findMilestone, replaceMilestonesInState,
  setPendingReplan, clearPendingReplan,
  setInboxItems, setReminders, setNotices, setTravelPlans, setLocationRules,
  setAiAudit, setDomainLoadStatus
} from './state.js';
import {
  loadPreferences as loadNotificationPreferences,
  clearPreferences as clearNotificationPreferences
} from '../data/notificationPrefsRepo.js';
import { sessionSnapshot, isSameSession } from '../data/session.js';
import { showError, success, notify } from '../ui/toast.js';
import { confirmDelete, confirmAction } from '../ui/confirm.js';
import { logError } from '../lib/result.js';

/** Kertaalleen näytettävä huomautus kentistä, jotka eivät vielä tallennu. */
let volatileWarningShown = false;

function warnAboutVolatileFields(task) {
  if (volatileWarningShown) return;
  const fields = volatileFields();
  if (fields.length === 0) return;

  const uses = fields.some(field => {
    const value = task[field];
    if (field === 'priority') return value && value !== 'normaali';
    if (field === 'schedulingState') return false;
    return value != null && value !== '';
  });
  if (!uses) return;

  volatileWarningShown = true;
  notify('Kuvaus, kesto ja prioriteetti näkyvät nyt vain tällä istunnolla.', 6000);
}

// ------------------------------------------------------------------ lataus

/** Kertaalleen näytettävä huomautus tiedoista, jotka eivät vielä säily. */
let volatileCollectionWarningShown = false;

function warnAboutVolatileCollections() {
  if (volatileCollectionWarningShown) return;
  if (volatileCollections().length === 0) return;
  volatileCollectionWarningShown = true;
  notify('Rutiinit, tavoitteet ja hyvinvointimerkinnät säilyvät toistaiseksi vain tämän istunnon ajan.', 7000);
}

/**
 * Ota yhden kokoelman hakutulos vastaan.
 *
 * VIIMEKSI ONNISTUNUT TILA EI SAA KADOTA TRANSIENTISSA VIRHEESSÄ. Aiemmin
 * epäonnistunut haku kirjoitti tyhjän listan tilalle — turvallista
 * ENSIMMÄISELLÄ latauksella (tilassa ei ollut mitään menetettävää), mutta
 * väärin heti kun loadUserData() ajetaan uudelleen esim. verkon
 * palautuessa: hetkellinen virhe olisi näyttänyt käyttäjän jo nähneen
 * tiedon poistettuna.
 *
 * Onnistunut haku korvaa kokoelman aina, myös tyhjällä listalla — se on
 * legitiimi tulos, ei virhe. Epäonnistunut haku EI KOSKAAN kutsu
 * asettajaa: mahdollinen aiemmin ladattu tila jää näkyviin, ja
 * epäonnistuminen näkyy vain dataLoadStatus-kentässä.
 *
 * @param {string} domain esim. 'routines', 'goals'
 * @param {{ok:boolean, value?:*, error?:*}} result
 * @param {(value:*) => void} setter
 */
function applyLoadResult(domain, result, setter) {
  if (result.ok) {
    setter(result.value);
    setDomainLoadStatus(domain, true);
    return true;
  }
  setDomainLoadStatus(domain, false, result.error);
  logError(result.error);
  return false;
}

/**
 * Lataa kirjautuneen käyttäjän kaikki tiedot.
 *
 * VANHENTUNUT VASTAUS HYLÄTÄÄN. Lataus on parikymmentä rinnakkaista
 * verkkokutsua, ja käyttäjä ehtii kirjautua ulos niiden aikana. Ilman
 * tarkistusta vastaus kirjoittaisi edellisen käyttäjän rivit tilaan
 * uloskirjautumisen JÄLKEEN — ja jos seuraava käyttäjä ehti jo kirjautua
 * sisään, hänen näytölleen.
 *
 * Tarkistus tehdään istunnon TILANNEKUVASTA eikä pelkästä tunnisteesta:
 * ketju "A ulos -> A takaisin sisään" jättää tunnisteen ennalleen, mutta
 * kesken jäänyt lataus on siitä huolimatta vanhentunut.
 *
 * KUTSUTTAVISSA USEAMMIN KUIN KERRAN. Tätä kutsutaan kirjautuessa ja myös
 * uudelleenlataukseen (esim. verkon palautuessa, ks. reconnect.js) —
 * jälkimmäisellä kertaa mikä tahansa yksittäinen epäonnistuminen ei saa
 * hävittää jo ladattua kokoelmaa, ks. applyLoadResult().
 */
export async function loadUserData() {
  const startedIn = sessionSnapshot();

  const [tasksResult, profileResult, routinesResult, exceptionsResult,
    goalsResult, projectsResult, wellbeingResult, preferencesResult,
    billsResult, expensesResult, savingsResult, transactionsResult,
    investmentsResult, milestonesResult, auditResult,
    inboxResult, remindersResult, noticesResult, travelResult,
    locationResult] = await Promise.all([
    tasksRepo.listTasks(),
    profileRepo.loadProfile(),
    routinesRepo.list(),
    routineExceptionsRepo.list(),
    goalsRepo.list(),
    projectsRepo.list(),
    wellbeingRepo.list(),
    loadNotificationPreferences(),
    billsRepo.list(),
    recurringExpensesRepo.list(),
    savingsGoalsRepo.list(),
    transactionsRepo.list(),
    investmentsRepo.list(),
    milestonesRepo.list(),
    aiAuditRepo.list(),
    inboxRepo.list(),
    remindersRepo.list(),
    noticesRepo.list(),
    travelPlansRepo.list(),
    locationRulesRepo.list()
  ]);

  // Istunto on voinut vaihtua odotuksen aikana.
  if (!isSameSession(startedIn)) {
    return { tasksOk: false, profileOk: false, discarded: true };
  }

  // Jokainen kokoelma kulkee applyLoadResult():n läpi: onnistunut haku
  // korvaa kokoelman (myös tyhjällä listalla — se on kelvollinen tulos),
  // epäonnistunut haku EI KOSKAAN tyhjennä jo ladattua tilaa. Virhe
  // näytetään käyttäjälle, mutta sovellus ei kaadu eikä väitä tiedon
  // kadonneen.
  // Lähettämättömät offline-muutokset lisätään palvelimen listan päälle:
  // muuten lataus korvaisi paikallisen tilan ja odottava tehtävä katoaisi näkyvistä.
  if (!applyLoadResult('tasks', tasksResult, list => setTasks(offline.overlay(list)))) showError(tasksResult.error);

  if (profileResult.ok) {
    setProfile(profileResult.value.profile, profileResult.value.exists);
    setDomainLoadStatus('profile', true);
  } else {
    setDomainLoadStatus('profile', false, profileResult.error);
    showError(profileResult.error);
  }

  // Muistutusasetukset: alkutila on jo hiljainen oletus (normalizePreferences({})),
  // joten epäonnistuessa ensimmäisellä latauksella ei tarvita erillistä
  // fallbackia; uudelleenlatauksella jo ladatut asetukset säilyvät samalla
  // applyLoadResult()-periaatteella.
  const collectionsOk = [
    applyLoadResult('routines', routinesResult, setRoutines),
    applyLoadResult('routineExceptions', exceptionsResult, setRoutineExceptions),
    applyLoadResult('goals', goalsResult, setGoals),
    applyLoadResult('projects', projectsResult, setProjects),
    applyLoadResult('wellbeing', wellbeingResult, setWellbeing),
    applyLoadResult('notificationPreferences', preferencesResult, setNotificationPreferences),
    applyLoadResult('bills', billsResult, setBills),
    applyLoadResult('recurringExpenses', expensesResult, setRecurringExpenses),
    applyLoadResult('savingsGoals', savingsResult, setSavingsGoals),
    applyLoadResult('transactions', transactionsResult, setTransactions),
    applyLoadResult('investments', investmentsResult, setInvestments),
    applyLoadResult('milestones', milestonesResult, setMilestones),
    applyLoadResult('aiAudit', auditResult, setAiAudit),
    // Avustajan kokoelmat. Nämä ladataan VAIKKA käyttöliittymää ei vielä
    // olisi — muuten tieto katoaisi sinä hetkenä kun näkymä rakennetaan.
    applyLoadResult('inboxItems', inboxResult, setInboxItems),
    applyLoadResult('reminders', remindersResult, setReminders),
    applyLoadResult('notices', noticesResult, setNotices),
    applyLoadResult('travelPlans', travelResult, setTravelPlans),
    applyLoadResult('locationRules', locationResult, setLocationRules)
  ];

  // Yksittäiset kokoelmavirheet kirjautuvat konsoliin (applyLoadResult) ja
  // dataLoadStatus-kenttään, mutta eivät yksitellen ilmoituksena — kaksi
  // tusinaa toastia yhdellä verkkokatkolla olisi pahempi kuin hyödyllinen.
  // Yksi kooste riittää, ja se kertoo suoraan, ettei näkyvä tieto katoa.
  if (collectionsOk.includes(false)) {
    notify('Osa tiedoista ei päivittynyt. Aiemmin ladattu tieto pysyy näkyvissä.', 6000);
  }

  return { tasksOk: tasksResult.ok, profileOk: profileResult.ok, discarded: false };
}

// ----------------------------------------------------------------- tehtävät

/**
 * Luo uusi tehtävä.
 * @returns {Promise<{ok:boolean, errors?:object, task?:object}>}
 */
/**
 * Verkko- tai istuntovirheen jälkeen muutos jonotetaan eikä peruta.
 * Palvelimen hylkäys (validointi, RLS) EI jonoteta: sen toisto ei auttaisi.
 */
function canQueueAfter(error) {
  const kind = classifyError(error, { offline: !isOnlineNow() });
  return kind === ERROR_CLASS.NETWORK || kind === ERROR_CLASS.AUTH;
}

let queuedNoticeAt = 0;

/** Kerro jonotuksesta, mutta ei jokaisella muutoksella (ei toast-ryöppyä). */
function announceQueued() {
  const at = Date.now();
  if (at - queuedNoticeAt < 60000) return;
  queuedNoticeAt = at;
  notify('Ei yhteyttä: muutos tallennettiin laitteelle ja lähetetään kun yhteys palaa.', 5000);
}

/**
 * Luo tehtävä.
 *
 * @param {object} input
 * @param {{queueOffline?: boolean}} [options] queueOffline:false estää
 *   offline-jonotuksen (AI-komennon suoritusta ei koskaan jonoteta)
 */
export async function createTask(input, options = {}) {
  const task = normalizeTask({
    ...input,
    id: newTaskId(),
    schedulingState: input.time ? SCHEDULING.MANUAL : SCHEDULING.UNSCHEDULED
  });

  const { valid, errors } = validateTask(task);
  if (!valid) return { ok: false, errors };

  // Optimistinen lisäys.
  addTaskToState(task);
  if (task.isWake) clearOtherWakeFlagsInState(task.date, task.id);
  warnAboutVolatileFields(task);

  const mayQueue = options.queueOffline !== false && offline.isActive();
  // Tiedossa oleva offline-tila: ei odoteta verkkokutsun aikakatkaisua.
  const result = mayQueue && !isOnlineNow()
    ? { ok: false, error: null, skipped: true }
    : await tasksRepo.insertTask(task);

  if (!result.ok) {
    if (mayQueue && (result.skipped || canQueueAfter(result.error))) {
      const queued = offline.enqueueTaskCreate(task);
      if (queued.ok) {
        announceQueued();
        return { ok: true, task, queued: true };
      }
    }
    removeTaskFromState(task.id); // peruutus
    showError(result.error || 'Tehtävää ei voitu tallentaa: ei verkkoyhteyttä eikä tilaa offline-jonossa.');
    return { ok: false };
  }

  if (task.isWake) await tasksRepo.clearOtherWakeFlags(task.date, task.id);
  return { ok: true, task };
}

/**
 * Muokkaa olemassa olevaa tehtävää.
 * @returns {Promise<{ok:boolean, errors?:object}>}
 */
export async function editTask(id, changes, options = {}) {
  const previous = findTask(id);
  if (!previous) return { ok: false };

  const updated = normalizeTask({
    ...previous,
    ...changes,
    // Käyttäjän tekemä ajan muutos on aina manuaalinen päätös. Automaatti
    // ei saa myöhemmin siirtää sitä.
    //
    // POIKKEUS: kutsuja saa asettaa tilan nimenomaisesti. Ilman tätä
    // acceptProposal() ei toimi lainkaan: se antaa sekä ajan että tilan
    // AUTO, ja johdettu sääntö ylikirjoitti tilan MANUALiksi — koska
    // aika oli mukana. Ehdotuksen hyväksyminen merkitsi siis tehtävän
    // käyttäjän omaksi päätökseksi, eikä automaatti saanut enää koskea
    // siihen (canReschedule). Ennen migraatiota 0002 vika oli
    // näkymätön, koska kenttä ei säilynyt tallennuksen yli. Lipun
    // TASK_EXTENDED_FIELDS kääntämisen jälkeen se olisi pysyvää dataa.
    //
    // Lomake ei koskaan lähetä schedulingStatea (ks. readForm), joten
    // käyttäjän polku toimii täsmälleen kuten ennenkin.
    schedulingState: changes.schedulingState !== undefined
      ? changes.schedulingState
      : (changes.time
        ? SCHEDULING.MANUAL
        : (changes.time === null ? SCHEDULING.UNSCHEDULED : previous.schedulingState))
  });

  const { valid, errors } = validateTask(updated);
  if (!valid) return { ok: false, errors };

  replaceTaskInState(id, updated);
  if (updated.isWake) clearOtherWakeFlagsInState(updated.date, id);
  warnAboutVolatileFields(updated);

  const mayQueue = options.queueOffline !== false && offline.isActive();
  const result = mayQueue && !isOnlineNow()
    ? { ok: false, error: null, skipped: true }
    : await tasksRepo.updateTask(updated);

  if (!result.ok) {
    if (mayQueue && (result.skipped || canQueueAfter(result.error))) {
      const queued = offline.enqueueTaskUpdate({ id, previous, updated });
      if (queued.ok) {
        if (queued.queued !== false) announceQueued();
        return { ok: true, queued: queued.queued !== false };
      }
    }
    replaceTaskInState(id, previous); // peruutus
    showError(result.error || 'Muutosta ei voitu tallentaa: ei verkkoyhteyttä eikä tilaa offline-jonossa.');
    return { ok: false };
  }

  if (updated.isWake) await tasksRepo.clearOtherWakeFlags(updated.date, id);
  return { ok: true };
}

/** Merkitse tehtävä tehdyksi tai palauta kesken. */
export async function toggleComplete(id) {
  const task = findTask(id);
  if (!task) return false;

  const nextCompleted = !task.completed;
  patchTaskInState(id, { completed: nextCompleted });

  const mayQueue = offline.isActive();
  const result = mayQueue && !isOnlineNow()
    ? { ok: false, error: null, skipped: true }
    : await tasksRepo.setCompleted(id, nextCompleted);

  if (!result.ok) {
    if (mayQueue && (result.skipped || canQueueAfter(result.error))) {
      const queued = offline.enqueueTaskUpdate({
        id, previous: task, updated: { ...task, completed: nextCompleted }
      });
      if (queued.ok) {
        announceQueued();
        return true;
      }
    }
    patchTaskInState(id, { completed: task.completed }); // peruutus
    showError(result.error || 'Merkintää ei voitu tallentaa: ei verkkoyhteyttä.');
    return false;
  }
  return true;
}

/**
 * Poista tehtävä. Kysyy aina vahvistuksen.
 * @returns {Promise<boolean>} poistettiinko
 */
export async function deleteTask(id) {
  const task = findTask(id);
  if (!task) return false;

  const confirmed = await confirmDelete(task.title);
  if (!confirmed) return false;

  removeTaskFromState(id);

  const result = await tasksRepo.deleteTask(id);
  if (!result.ok) {
    addTaskToState(task); // peruutus: tehtävä palautetaan näkyviin
    showError(result.error);
    return false;
  }

  success('Tehtävä poistettu.');
  return true;
}

/**
 * Hyväksy aikataulumoottorin ehdotus.
 * Merkitään AUTO-tilaan, jolloin moottori saa myöhemmin siirtää sitä.
 */
export async function acceptProposal(proposal) {
  return editTask(proposal.taskId, {
    time: proposal.time,
    endTime: proposal.endTime,
    durationMinutes: proposal.durationMinutes,
    schedulingState: SCHEDULING.AUTO
  });
}

// ----------------------------------------------------------------- rutiinit

/**
 * Luo rutiini.
 * @returns {Promise<{ok:boolean, errors?:object, routine?:object}>}
 */
export async function createRoutine(input) {
  const routine = normalizeRoutine({ ...input, id: newTaskId() });

  const { valid, errors } = validateRoutine(routine);
  if (!valid) return { ok: false, errors };

  addRoutineToState(routine);
  warnAboutVolatileCollections();

  const result = await routinesRepo.insert(routine);
  if (!result.ok) {
    removeRoutineFromState(routine.id); // peruutus
    showError(result.error);
    return { ok: false };
  }
  return { ok: true, routine };
}

/** Muokkaa rutiinia. */
export async function editRoutine(id, changes) {
  const previous = findRoutine(id);
  if (!previous) return { ok: false };

  const updated = normalizeRoutine({ ...previous, ...changes, id });
  const { valid, errors } = validateRoutine(updated);
  if (!valid) return { ok: false, errors };

  replaceRoutineInState(id, updated);

  const result = await routinesRepo.update(updated);
  if (!result.ok) {
    replaceRoutineInState(id, previous); // peruutus
    showError(result.error);
    return { ok: false };
  }
  return { ok: true };
}

/** Aktivoi tai deaktivoi rutiini. Ei poista mitään. */
export async function toggleRoutineActive(id) {
  const routine = findRoutine(id);
  if (!routine) return false;
  const result = await editRoutine(id, { active: !routine.active });
  return result.ok;
}

/** Poista rutiini. Kysyy aina vahvistuksen. */
export async function deleteRoutine(id) {
  const routine = findRoutine(id);
  if (!routine) return false;

  const confirmed = await confirmAction({
    title: 'Poistetaanko rutiini?',
    message: `"${routine.title}" ja kaikki sen tulevat esiintymät poistetaan. `
      + 'Jo tehdyt merkinnät säilyvät. Tätä ei voi perua.',
    confirmLabel: 'Poista',
    cancelLabel: 'Peruuta',
    destructive: true
  });
  if (!confirmed) return false;

  const exceptions = getState().routineExceptions.filter(e => e.routineId === id);
  removeRoutineFromState(id);

  const result = await routinesRepo.remove(id);
  if (!result.ok) {
    addRoutineToState(routine); // peruutus
    for (const exception of exceptions) addRoutineExceptionToState(exception);
    showError(result.error);
    return false;
  }

  success('Rutiini poistettu.');
  return true;
}

/**
 * Ohita rutiinin yksittäinen esiintymä.
 * Rutiini itse ei muutu — vain tämä päivä.
 */
export async function skipRoutineOccurrence(routineId, dateIso) {
  const exception = normalizeException({
    id: newTaskId(), routineId, date: dateIso, type: EXCEPTION.SKIP
  });

  addRoutineExceptionToState(exception);

  const result = await routineExceptionsRepo.insert(exception);
  if (!result.ok) {
    removeRoutineExceptionFromState(routineId, dateIso); // peruutus
    showError(result.error);
    return false;
  }
  return true;
}

/** Palauta ohitettu esiintymä. */
export async function restoreRoutineOccurrence(routineId, dateIso) {
  const existing = getState().routineExceptions.find(
    e => e.routineId === routineId && e.date === dateIso);

  removeRoutineExceptionFromState(routineId, dateIso);

  if (existing && existing.id) {
    const result = await routineExceptionsRepo.remove(existing.id);
    if (!result.ok) {
      addRoutineExceptionToState(existing); // peruutus
      showError(result.error);
      return false;
    }
  }
  return true;
}

// --------------------------------------------------------------- tavoitteet

/** Luo tavoite. */
export async function createGoal(input) {
  const goal = normalizeGoal({ ...input, id: newTaskId() });

  const { valid, errors } = validateGoal(goal);
  if (!valid) return { ok: false, errors };

  addGoalToState(goal);
  warnAboutVolatileCollections();

  const result = await goalsRepo.insert(goal);
  if (!result.ok) {
    removeGoalFromState(goal.id); // peruutus
    showError(result.error);
    return { ok: false };
  }
  return { ok: true, goal };
}

/** Muokkaa tavoitetta. */
export async function editGoal(id, changes) {
  const previous = findGoal(id);
  if (!previous) return { ok: false };

  const updated = normalizeGoal({ ...previous, ...changes, id });
  const { valid, errors } = validateGoal(updated);
  if (!valid) return { ok: false, errors };

  replaceGoalInState(id, updated);

  const result = await goalsRepo.update(updated);
  if (!result.ok) {
    replaceGoalInState(id, previous); // peruutus
    showError(result.error);
    return { ok: false };
  }
  return { ok: true };
}

/** Vaihda tavoitteen tila. */
export async function setGoalStatus(id, status) {
  return editGoal(id, { status });
}

/**
 * Poista tavoite.
 *
 * Tehtäviä EI koskaan poisteta tavoitteen mukana — niiden yhteys vain
 * katkeaa. Työ, joka on jo tehty, ei katoa siksi että tavoite poistuu.
 */
export async function deleteGoal(id) {
  const goal = findGoal(id);
  if (!goal) return false;

  const linked = getState().tasks.filter(task => task.goalId === id);
  const confirmed = await confirmAction({
    title: 'Poistetaanko tavoite?',
    message: linked.length
      ? `"${goal.title}" poistetaan. ${linked.length} tehtävää säilyy, mutta niiden yhteys tavoitteeseen katkeaa.`
      : `"${goal.title}" poistetaan pysyvästi.`,
    confirmLabel: 'Poista',
    cancelLabel: 'Peruuta',
    destructive: true
  });
  if (!confirmed) return false;

  removeGoalFromState(id);

  const result = await goalsRepo.remove(id);
  if (!result.ok) {
    addGoalToState(goal); // peruutus
    showError(result.error);
    return false;
  }

  success('Tavoite poistettu.');
  return true;
}


// --------------------------------------------------------------- projektit
//
// Sama kaava kuin tavoitteilla: optimistinen muutos tilaan, sitten
// tallennus, ja EPÄONNISTUMISESSA tilan peruutus. Käyttöliittymä ei saa
// jäädä näyttämään riviä, jota ei tallennettu.

/** Luo projekti. */
export async function createProject(input) {
  const project = normalizeProject({ ...input, id: newTaskId() });

  const { valid, errors } = validateProject(project);
  if (!valid) return { ok: false, errors };

  addProjectToState(project);
  warnAboutVolatileCollections();

  const result = await projectsRepo.insert(project);
  if (!result.ok) {
    removeProjectFromState(project.id); // peruutus
    showError(result.error);
    return { ok: false };
  }
  return { ok: true, project };
}

/** Muokkaa projektia. */
export async function editProject(id, changes) {
  const previous = findProject(id);
  if (!previous) return { ok: false };

  const updated = normalizeProject({ ...previous, ...changes, id });
  const { valid, errors } = validateProject(updated);
  if (!valid) return { ok: false, errors };

  replaceProjectInState(id, updated);

  const result = await projectsRepo.update(updated);
  if (!result.ok) {
    replaceProjectInState(id, previous); // peruutus
    showError(result.error);
    return { ok: false };
  }
  return { ok: true };
}

/**
 * Poista projekti.
 *
 * Tehtäviä EI poisteta projektin mukana — niiden yhteys vain katkeaa.
 * Sama sääntö kuin tavoitteilla ja sama kuin kannassa: viite on
 * `on delete set null (project_id)`, ei cascade.
 */
export async function deleteProject(id) {
  const project = findProject(id);
  if (!project) return false;

  const linked = getState().tasks.filter(task => task.projectId === id);
  const confirmed = await confirmAction({
    title: 'Poistetaanko projekti?',
    message: linked.length
      ? `"${project.name}" poistetaan. ${linked.length} tehtävää säilyy, mutta niiden yhteys projektiin katkeaa.`
      : `"${project.name}" poistetaan pysyvästi.`,
    confirmLabel: 'Poista',
    cancelLabel: 'Peruuta',
    destructive: true
  });
  if (!confirmed) return false;

  removeProjectFromState(id);

  const result = await projectsRepo.remove(id);
  if (!result.ok) {
    addProjectToState(project); // peruutus
    showError(result.error);
    return false;
  }

  success('Projekti poistettu.');
  return true;
}

// ------------------------------------------------------------------ talous
//
// Kolme kokoelmaa, sama kaava. Raha kulkee SENTTEINÄ läpi koko ketjun:
// lomake jäsentää syötteen `parseMoneyToMinor`-funktiolla, domain
// normalisoi kokonaisluvuksi ja repositorio kirjoittaa
// bigint-sarakkeeseen. Liukulukua ei ole missään vaiheessa.

/** Luo toistuva meno. */
export async function createRecurringExpense(input) {
  const expense = normalizeRecurringExpense({ ...input, id: newTaskId() });

  const { valid, errors } = validateRecurringExpense(expense);
  if (!valid) return { ok: false, errors };

  addRecurringExpenseToState(expense);
  warnAboutVolatileCollections();

  const result = await recurringExpensesRepo.insert(expense);
  if (!result.ok) {
    removeRecurringExpenseFromState(expense.id);
    showError(result.error);
    return { ok: false };
  }
  return { ok: true, expense };
}

/** Muokkaa toistuvaa menoa. */
export async function editRecurringExpense(id, changes) {
  const previous = findRecurringExpense(id);
  if (!previous) return { ok: false };

  const updated = normalizeRecurringExpense({ ...previous, ...changes, id });
  const { valid, errors } = validateRecurringExpense(updated);
  if (!valid) return { ok: false, errors };

  replaceRecurringExpenseInState(id, updated);

  const result = await recurringExpensesRepo.update(updated);
  if (!result.ok) {
    replaceRecurringExpenseInState(id, previous);
    showError(result.error);
    return { ok: false };
  }
  return { ok: true };
}

/**
 * Poista toistuva meno.
 *
 * Laskut EIVÄT poistu mukana. Lasku on historiaa: se on jo erääntynyt ja
 * mahdollisesti maksettu, eikä säännön poistaminen tee sitä
 * tapahtumattomaksi. Kannassa sama sääntö on
 * `on delete set null (recurring_expense_id)`.
 */
export async function deleteRecurringExpense(id) {
  const expense = findRecurringExpense(id);
  if (!expense) return false;

  const linked = getState().bills.filter(bill => bill.recurringExpenseId === id);
  const confirmed = await confirmAction({
    title: 'Poistetaanko toistuva meno?',
    message: linked.length
      ? `"${expense.name}" poistetaan. ${linked.length} laskua säilyy, mutta niiden yhteys menoon katkeaa.`
      : `"${expense.name}" poistetaan pysyvästi.`,
    confirmLabel: 'Poista',
    cancelLabel: 'Peruuta',
    destructive: true
  });
  if (!confirmed) return false;

  removeRecurringExpenseFromState(id);

  const result = await recurringExpensesRepo.remove(id);
  if (!result.ok) {
    addRecurringExpenseToState(expense);
    showError(result.error);
    return false;
  }

  success('Toistuva meno poistettu.');
  return true;
}

/** Luo lasku. */
export async function createBill(input) {
  const bill = normalizeBill({ ...input, id: newTaskId() });

  const { valid, errors } = validateBill(bill);
  if (!valid) return { ok: false, errors };

  addBillToState(bill);
  warnAboutVolatileCollections();

  const result = await billsRepo.insert(bill);
  if (!result.ok) {
    removeBillFromState(bill.id);
    showError(result.error);
    return { ok: false };
  }
  return { ok: true, bill };
}

/** Muokkaa laskua. */
export async function editBill(id, changes) {
  const previous = findBill(id);
  if (!previous) return { ok: false };

  const updated = normalizeBill({ ...previous, ...changes, id });
  const { valid, errors } = validateBill(updated);
  if (!valid) return { ok: false, errors };

  replaceBillInState(id, updated);

  const result = await billsRepo.update(updated);
  if (!result.ok) {
    replaceBillInState(id, previous);
    showError(result.error);
    return { ok: false };
  }
  return { ok: true };
}

/**
 * Merkitse lasku maksetuksi tai takaisin avoimeksi.
 *
 * Tila ja maksupäivä kulkevat YHDESSÄ. Kanta vaatii sen
 * (`bills_paid_date_check`), ja `validateBill` vaatii saman — maksettu
 * lasku ilman maksupäivää olisi tieto, joka ei kerro milloin.
 */
export async function setBillPaid(id, paid, paidDate = null) {
  const bill = findBill(id);
  if (!bill) return { ok: false };

  if (!paid) {
    return editBill(id, { status: BILL_STATUS.OPEN, paidDate: null });
  }
  return editBill(id, {
    status: BILL_STATUS.PAID,
    paidDate: paidDate || fmtISO(todayMidnight())
  });
}

/** Poista lasku. */
export async function deleteBill(id) {
  const bill = findBill(id);
  if (!bill) return false;

  const confirmed = await confirmAction({
    title: 'Poistetaanko lasku?',
    message: `"${bill.name}" poistetaan pysyvästi.`,
    confirmLabel: 'Poista',
    cancelLabel: 'Peruuta',
    destructive: true
  });
  if (!confirmed) return false;

  removeBillFromState(id);

  const result = await billsRepo.remove(id);
  if (!result.ok) {
    addBillToState(bill);
    showError(result.error);
    return false;
  }

  success('Lasku poistettu.');
  return true;
}

/** Luo säästötavoite. */
export async function createSavingsGoal(input) {
  const goal = normalizeSavingsGoal({ ...input, id: newTaskId() });

  const { valid, errors } = validateSavingsGoal(goal);
  if (!valid) return { ok: false, errors };

  addSavingsGoalToState(goal);
  warnAboutVolatileCollections();

  const result = await savingsGoalsRepo.insert(goal);
  if (!result.ok) {
    removeSavingsGoalFromState(goal.id);
    showError(result.error);
    return { ok: false };
  }
  return { ok: true, goal };
}

/** Muokkaa säästötavoitetta. */
export async function editSavingsGoal(id, changes) {
  const previous = findSavingsGoal(id);
  if (!previous) return { ok: false };

  const updated = normalizeSavingsGoal({ ...previous, ...changes, id });
  const { valid, errors } = validateSavingsGoal(updated);
  if (!valid) return { ok: false, errors };

  replaceSavingsGoalInState(id, updated);

  const result = await savingsGoalsRepo.update(updated);
  if (!result.ok) {
    replaceSavingsGoalInState(id, previous);
    showError(result.error);
    return { ok: false };
  }
  return { ok: true };
}

/** Poista säästötavoite. */
export async function deleteSavingsGoal(id) {
  const goal = findSavingsGoal(id);
  if (!goal) return false;

  const confirmed = await confirmAction({
    title: 'Poistetaanko säästötavoite?',
    message: `"${goal.name}" poistetaan pysyvästi.`,
    confirmLabel: 'Poista',
    cancelLabel: 'Peruuta',
    destructive: true
  });
  if (!confirmed) return false;

  removeSavingsGoalFromState(id);

  const result = await savingsGoalsRepo.remove(id);
  if (!result.ok) {
    addSavingsGoalToState(goal);
    showError(result.error);
    return false;
  }

  success('Säästötavoite poistettu.');
  return true;
}

// ------------------------------------------------------------ tapahtumat
//
// Tapahtuma on kirjaus siitä, että raha liikkui. Se ei siirrä rahaa.
//
// MANIFESTIVALILLA EI OLE PANKKIYHTEYTTÄ. Yksikään tämän osion
// toiminnoista ei maksa laskua, tee tilisiirtoa eikä osta mitään.
// Ne kirjaavat, mitä käyttäjä kertoo tapahtuneen.

/** Luo tapahtuma: meno, tulo tai siirto. */
export async function createTransaction(input) {
  const transaction = normalizeTransaction({ ...input, id: newTaskId() });

  const { valid, errors } = validateTransaction(transaction);
  if (!valid) return { ok: false, errors };

  addTransactionToState(transaction);
  warnAboutVolatileCollections();

  const result = await transactionsRepo.insert(transaction);
  if (!result.ok) {
    removeTransactionFromState(transaction.id);
    showError(result.error);
    return { ok: false };
  }
  return { ok: true, transaction };
}

/**
 * Kirjaa tulo.
 *
 * Sama taulu ja sama toiminto kuin menolla — vain `kind` eroaa. Erillinen
 * tulotaulu tarkoittaisi kahta paikkaa laskea rahaa, ja kahdesta
 * paikasta seuraa ennemmin tai myöhemmin kaksi eri vastausta samaan
 * kysymykseen.
 */
export async function createIncome(input) {
  return createTransaction({ ...input, kind: TRANSACTION_KIND.INCOME });
}

/** Muokkaa tapahtumaa. */
export async function editTransaction(id, changes) {
  const previous = findTransaction(id);
  if (!previous) return { ok: false };

  const updated = normalizeTransaction({ ...previous, ...changes, id });
  const { valid, errors } = validateTransaction(updated);
  if (!valid) return { ok: false, errors };

  replaceTransactionInState(id, updated);

  const result = await transactionsRepo.update(updated);
  if (!result.ok) {
    replaceTransactionInState(id, previous);
    showError(result.error);
    return { ok: false };
  }
  return { ok: true };
}

/**
 * Poista tapahtuma.
 *
 * LÄHDETTÄ EI KOSKETA. Jos tapahtuma syntyi laskusta, laskun tila ei
 * muutu takaisin avoimeksi: käyttäjä on saattanut maksaa laskun ja
 * poistaa vain virheellisen kirjauksen. Laskun tilan päättää käyttäjä,
 * ei tämän toiminnon sivuvaikutus.
 */
export async function deleteTransaction(id) {
  const transaction = findTransaction(id);
  if (!transaction) return false;

  const confirmed = await confirmAction({
    title: 'Poistetaanko tapahtuma?',
    message: `"${transaction.description || 'Nimetön tapahtuma'}" poistetaan pysyvästi.`,
    confirmLabel: 'Poista',
    cancelLabel: 'Peruuta',
    destructive: true
  });
  if (!confirmed) return false;

  removeTransactionFromState(id);

  const result = await transactionsRepo.remove(id);
  if (!result.ok) {
    addTransactionToState(transaction);
    showError(result.error);
    return false;
  }

  success('Tapahtuma poistettu.');
  return true;
}

/**
 * Merkitse lasku maksetuksi JA kirjaa siitä tapahtuma.
 *
 * KAKSOISLASKENNAN ESTO: jos laskusta on jo tapahtuma, uutta ei luoda.
 * Muuten sama meno näkyisi budjetissa kahdesti — kerran laskuna ja
 * kerran tapahtumana.
 *
 * Ehto on tarkistettava täällä eikä vasta kannassa: tapahtumataulussa
 * ei ole eikä voi olla uniikkirajoitetta lähteelle, koska sama lasku
 * voidaan perustellusti maksaa kahdessa erässä.
 *
 * Jos tapahtuman kirjaus epäonnistuu, LASKU JÄÄ MAKSETUKSI. Se on
 * oikea järjestys: lasku on tosiasiassa maksettu, ja puuttuva kirjaus
 * on pienempi virhe kuin väärä tieto laskun tilasta.
 */
export async function payBillWithTransaction(id, paidDate = null) {
  const bill = findBill(id);
  if (!bill) return { ok: false };

  const date = paidDate || fmtISO(todayMidnight());

  const paidResult = await setBillPaid(id, true, date);
  if (!paidResult.ok) return paidResult;

  const already = hasTransactionFor(getState().transactions, SOURCE_KIND.BILL, id);
  if (already) return { ok: true, transaction: null, duplicate: true };

  const transaction = transactionFromBill({ ...bill, paidDate: date }, newTaskId());
  if (!transaction) return { ok: true, transaction: null };

  const created = await createTransaction(transaction);
  return { ok: true, transaction: created.transaction || null };
}

/**
 * Kirjaa siirto säästötavoitteeseen.
 *
 * SIIRTO EI OLE MENO. Säästöön siirretty raha on yhä omaa, joten se ei
 * pienennä kuukauden tulosta — `kind` on TRANSFER ja budjetti jättää
 * sen laskuista pois.
 *
 * TÄMÄ EI SIIRRÄ RAHAA MISSÄÄN PANKISSA. Se kirjaa, että käyttäjä on
 * siirtänyt sen itse, ja päivittää säästötavoitteen kertymän.
 */
export async function recordSavingsTransfer(goalId, amountMinor, dateIso = null) {
  const goal = findSavingsGoal(goalId);
  if (!goal) return { ok: false };

  const date = dateIso || fmtISO(todayMidnight());
  const transaction = transactionFromSavings(goal, amountMinor, date, newTaskId());
  if (!transaction) return { ok: false, errors: { amountMinor: 'Anna siirrettävä summa.' } };

  const created = await createTransaction(transaction);
  if (!created.ok) return created;

  // Kertymä kasvaa vasta kun kirjaus onnistui. Toisin päin näyttö
  // väittäisi säästöä, josta ei ole merkintää.
  const updated = await editSavingsGoal(goalId, {
    currentMinor: (goal.currentMinor || 0) + transaction.amountMinor
  });
  if (!updated.ok) {
    // Kertymän päivitys epäonnistui, joten kirjaus perutaan: kaksi
    // lukua, jotka eivät täsmää, on pahempi kuin ei kirjausta.
    removeTransactionFromState(created.transaction.id);
    await transactionsRepo.remove(created.transaction.id);
    return { ok: false };
  }

  return { ok: true, transaction: created.transaction };
}

// ----------------------------------------------------------- sijoitukset

/** Luo sijoitus. */
export async function createInvestment(input) {
  const holding = normalizeHolding({ ...input, id: newTaskId() });

  const { valid, errors } = validateHolding(holding);
  if (!valid) return { ok: false, errors };

  addInvestmentToState(holding);
  warnAboutVolatileCollections();

  const result = await investmentsRepo.insert(holding);
  if (!result.ok) {
    removeInvestmentFromState(holding.id);
    showError(result.error);
    return { ok: false };
  }
  return { ok: true, holding };
}

/** Muokkaa sijoitusta. */
export async function editInvestment(id, changes) {
  const previous = findInvestment(id);
  if (!previous) return { ok: false };

  const updated = normalizeHolding({ ...previous, ...changes, id });
  const { valid, errors } = validateHolding(updated);
  if (!valid) return { ok: false, errors };

  replaceInvestmentInState(id, updated);

  const result = await investmentsRepo.update(updated);
  if (!result.ok) {
    replaceInvestmentInState(id, previous);
    showError(result.error);
    return { ok: false };
  }
  return { ok: true };
}

/**
 * Päivitä sijoituksen nykyarvo käsin.
 *
 * ARVO ON AINA KÄYTTÄJÄN KIRJAAMA. Manifestivalilla ei ole markkinadatan
 * toimittajaa eikä se hae kursseja mistään. `valuedOn` merkitään, jotta
 * käyttöliittymä voi kertoa milloin luku on kirjattu — vanha arvo ei ole
 * väärä, mutta se on vanha.
 */
export async function updateInvestmentValue(id, currentValueMinor, valuedOn = null) {
  return editInvestment(id, {
    currentValueMinor,
    valuedOn: valuedOn || fmtISO(todayMidnight()),
    valueSource: 'manual'
  });
}

/** Poista sijoitus. */
export async function deleteInvestment(id) {
  const holding = findInvestment(id);
  if (!holding) return false;

  const confirmed = await confirmAction({
    title: 'Poistetaanko sijoitus?',
    message: `"${holding.name}" poistetaan pysyvästi.`,
    confirmLabel: 'Poista',
    cancelLabel: 'Peruuta',
    destructive: true
  });
  if (!confirmed) return false;

  removeInvestmentFromState(id);

  const result = await investmentsRepo.remove(id);
  if (!result.ok) {
    addInvestmentToState(holding);
    showError(result.error);
    return false;
  }

  success('Sijoitus poistettu.');
  return true;
}

// --------------------------------------------------- kuitin hyväksyntä
//
// TEKOÄLYN LUENTA ON EHDOTUS. AINA.
//
// Yksikään näistä toiminnoista ei tallenna mitään ilman että käyttäjä
// on nimenomaisesti hyväksynyt luennan. Automaattista hyväksyntää ei
// ole eikä siihen ole polkua: `approveExtraction` on ainoa tapa saada
// luenta tilaan APPROVED, ja `toTransaction` kieltäytyy kaikesta
// muusta.
//
// KUVA EI TULE TÄNNE ASTI. Luennassa ei ole kuvakenttää, joten sitä ei
// voi vahingossakaan tallentaa. Ks. src/domain/receipts.js.

/**
 * Lue kuva ja palauta luenta EHDOTUKSENA.
 *
 * TUNNISTE LUODAAN TÄÄLLÄ, EI NÄKYMÄSSÄ. Tunnisteen luonti on
 * sivuvaikutus, ja sivuvaikutukset kuuluvat tälle kerrokselle —
 * `tests/architecture.test.mjs` valvoo sitä.
 *
 * TÄMÄ EI TALLENNA MITÄÄN. Palautettu luenta menee tilaan
 * tarkistettavaksi, ja vasta `approveReceipt` tai `approveScannedBill`
 * kirjoittaa mitään. Kuva vapautetaan `extractFromImage`-funktiossa
 * riippumatta lopputuloksesta.
 */
export async function scanImage({ file, subject }) {
  const result = await extractFromImage({
    file,
    subject,
    todayIso: fmtISO(todayMidnight()),
    id: newTaskId()
  });

  if (result.ok) setPendingExtraction(result.extraction);
  return result;
}

/**
 * Hyväksy kuittiluenta ja kirjaa siitä tapahtuma.
 *
 * @param {object} extraction  Käyttäjän tarkistama luenta
 */
export async function approveReceipt(extraction) {
  const { valid, errors } = validateExtraction(extraction);
  if (!valid) return { ok: false, errors };

  const approved = approveExtraction(extraction);
  if (!approved) return { ok: false };

  const transaction = extractionToTransaction(approved, newTaskId());
  if (!transaction) return { ok: false };

  const created = await createTransaction({
    ...transaction,
    origin: TRANSACTION_ORIGIN.RECEIPT
  });
  if (!created.ok) return created;

  // Luenta on tehnyt tehtävänsä. Se ei jää mihinkään.
  clearPendingExtraction();
  success('Kuitti kirjattu.');
  return { ok: true, transaction: created.transaction };
}

/**
 * Hyväksy laskuluenta ja luo siitä lasku.
 *
 * SKANNATTU LASKU EI OLE MAKSETTU. Se syntyy tilaan `open`, ja
 * maksaminen on erillinen, käyttäjän tekemä toimenpide.
 * `toBill` pakottaa tilan riippumatta siitä, mitä luennassa luki.
 *
 * TÄMÄ EI KÄYNNISTÄ MAKSUA. Manifestivalilla ei ole valtuutta siirtää
 * rahaa. IBAN ja viite kirjataan, jotta käyttäjä voi kopioida ne omaan
 * pankkiinsa itse.
 */
export async function approveScannedBill(extraction) {
  const { valid, errors } = validateExtraction(extraction);
  if (!valid) return { ok: false, errors };

  if (extraction.subject !== EXTRACTION_SUBJECT.BILL) return { ok: false };

  const approved = approveExtraction(extraction);
  if (!approved) return { ok: false };

  const bill = extractionToBill(approved, newTaskId());
  if (!bill) return { ok: false };

  const created = await createBill(bill);
  if (!created.ok) return created;

  clearPendingExtraction();
  success('Lasku tallennettu avoimena. Maksa se pankissasi.');
  return { ok: true, bill: created.bill };
}

/** Hylkää luenta. Mitään ei tallenneta. */
export function rejectExtractionAction() {
  clearPendingExtraction();
  return { ok: true };
}


// -------------------------------------------------------------- hyvinvointi

/**
 * Tallenna päivän hyvinvointimerkintä.
 *
 * ⚠️ Tämä EI muuta suunnitelmaa. Merkintä on signaali, jonka perusteella
 * käyttöliittymä voi näyttää ehdotuksen — päätös on aina käyttäjän.
 */
export async function saveWellbeingEntry(input) {
  const existing = getState().wellbeing.find(e => e.date === input.date);
  const entry = normalizeWellbeingEntry({
    ...input,
    id: existing?.id || newTaskId()
  });

  const { valid, errors } = validateWellbeingEntry(entry);
  if (!valid) return { ok: false, errors };

  const previous = getState().wellbeing;

  upsertWellbeingEntry(entry);
  warnAboutVolatileCollections();

  const result = existing
    ? await wellbeingRepo.update(entry)
    : await wellbeingRepo.insert(entry);

  if (!result.ok) {
    setWellbeing(previous); // peruutus
    showError(result.error);
    return { ok: false };
  }
  return { ok: true, entry };
}

// ----------------------------------------------------------------- profiili

/** Tallenna profiili. */
export async function saveProfile(profile) {
  const previous = getState().profile;
  setProfile(profile);

  const result = await profileRepo.saveProfile(profile);
  if (!result.ok) {
    setProfile(previous); // peruutus
    showError(result.error);
    return false;
  }
  return true;
}

// -------------------------------------------------- uloskirjautuminen

/**
 * Tyhjennä kaikki paikallinen käyttäjädata.
 *
 * TÄMÄ ON TIETOTURVATOIMENPIDE, EI SIIVOUSTA.
 *
 * Kun migraatioita ei ole vielä ajettu, rutiinit, tavoitteet, projektit ja
 * hyvinvointimerkinnät elävät repositorioiden MUISTIVARASTOSSA. Se on
 * moduulitasoinen eikä katoa uloskirjautuessa: resetState() nollaa
 * sovelluksen tilan, muttei repositorion sisuksia.
 *
 * Ilman tätä kutsua jaetulla selaimella tapahtuisi näin:
 *   1. Käyttäjä A kirjautuu ja luo rutiineja ja tavoitteita
 *   2. A kirjautuu ulos
 *   3. Käyttäjä B kirjautuu samassa välilehdessä
 *   4. loadUserData() kutsuu routinesRepo.list() -> muistivarasto
 *   5. B näkee A:n rutiinit ja tavoitteet
 *
 * RLS ei voi estää tätä, koska palvelimelta ei haeta mitään.
 */
export function clearLocalUserData() {
  clearAllCollections();
  clearNotificationPreferences();
}

// ----------------------------------------------------- välitavoitteet
//
// Välitavoite on TILA, ei työsäiliö. Sillä ei ole tehtäviä eikä kestoa
// — sillä on päivä ja tulos, joka joko on saavutettu tai ei.
//
// VÄLITAVOITE EI ELÄ ILMAN TAVOITETTA. `goalId` on pakollinen, ja
// kannassa yhdistelmävierasavain estää kiinnittämisen toisen käyttäjän
// tavoitteeseen.

/** Luo välitavoite. */
export async function createMilestone(input) {
  const goal = findGoal(input && input.goalId);
  if (!goal) return { ok: false, errors: { goalId: 'Tavoitetta ei löytynyt.' } };

  const milestone = normalizeMilestone({
    ...input,
    id: newTaskId(),
    // Paikka jonossa johdetaan, ei kysytä. Suurin käytössä oleva plus
    // yksi — EI määrä, koska poisto jättää aukon ja uusi rivi saisi jo
    // varatun paikan.
    orderIndex: input.orderIndex ?? nextOrderIndex(getState().milestones, input.goalId)
  });

  const { valid, errors } = validateMilestone(milestone);
  if (!valid) return { ok: false, errors };

  addMilestoneToState(milestone);
  warnAboutVolatileCollections();

  const result = await milestonesRepo.insert(milestone);
  if (!result.ok) {
    removeMilestoneFromState(milestone.id);
    showError(result.error);
    return { ok: false };
  }
  return { ok: true, milestone };
}

/** Muokkaa välitavoitetta. */
export async function editMilestone(id, changes) {
  const previous = findMilestone(id);
  if (!previous) return { ok: false };

  const updated = normalizeMilestone({ ...previous, ...changes, id });
  const { valid, errors } = validateMilestone(updated);
  if (!valid) return { ok: false, errors };

  replaceMilestoneInState(id, updated);

  const result = await milestonesRepo.update(updated);
  if (!result.ok) {
    replaceMilestoneInState(id, previous);
    showError(result.error);
    return { ok: false };
  }
  return { ok: true };
}

/**
 * Merkitse välitavoite saavutetuksi tai takaisin avoimeksi.
 *
 * TILA JA PÄIVÄ KULKEVAT YHDESSÄ. Kanta vaatii sen
 * (`milestones_reached_date_check`), ja `validateMilestone` vaatii
 * saman — saavutettu välitavoite ilman päivää olisi tieto, joka ei
 * kerro milloin.
 */
export async function setMilestoneReached(id, reached, dateIso = null) {
  const milestone = findMilestone(id);
  if (!milestone) return { ok: false };

  const updated = reached
    ? markReached(milestone, dateIso || fmtISO(todayMidnight()))
    : markOpen(milestone);

  return editMilestone(id, updated);
}

/** Ohita välitavoite. Päätös, ei laiminlyönti. */
export async function skipMilestone(id) {
  const milestone = findMilestone(id);
  if (!milestone) return { ok: false };
  return editMilestone(id, markSkipped(milestone));
}

/**
 * Siirrä välitavoite jonossa.
 *
 * Kirjoittaa KAIKKI muuttuneet rivit, ei vain siirrettyä: paikan
 * vaihto koskee aina kahta riviä, ja vain toisen kirjoittaminen
 * jättäisi jonon epäjärjestykseen.
 */
export async function moveMilestone(id, direction) {
  const milestone = findMilestone(id);
  if (!milestone) return { ok: false };

  const previous = getState().milestones;
  const reordered = reorderMilestone(previous, milestone.goalId, id, direction);
  if (reordered.length === 0) return { ok: false };

  replaceMilestonesInState(reordered);

  for (const updated of reordered) {
    const result = await milestonesRepo.update(updated);
    if (!result.ok) {
      // Palauta koko jono: puolittain kirjoitettu järjestys on
      // pahempi kuin ei muutosta lainkaan.
      replaceMilestonesInState(previous);
      showError(result.error);
      return { ok: false };
    }
  }
  return { ok: true };
}

/**
 * Poista välitavoite.
 *
 * TEHTÄVÄT JA PROJEKTIT SÄILYVÄT. Niiden liitos katkeaa, mutta työ ei
 * katoa: tehtävä on tehty tai tekemättä riippumatta siitä, onko sen
 * tarkistuspiste yhä olemassa. Kannassa sama sääntö on
 * `on delete set null (milestone_id)`.
 */
export async function deleteMilestone(id) {
  const milestone = findMilestone(id);
  if (!milestone) return false;

  const linkedTasks = getState().tasks.filter(task => task.milestoneId === id).length;

  const confirmed = await confirmAction({
    title: 'Poistetaanko välitavoite?',
    message: linkedTasks > 0
      ? `"${milestone.title}" poistetaan. ${linkedTasks} tehtävää säilyy, `
        + 'mutta niiden liitos tähän välitavoitteeseen katkeaa.'
      : `"${milestone.title}" poistetaan pysyvästi.`,
    confirmLabel: 'Poista',
    cancelLabel: 'Peruuta',
    destructive: true
  });
  if (!confirmed) return false;

  const previousTasks = getState().tasks;
  const previousProjects = getState().projects;
  removeMilestoneFromState(id);

  const result = await milestonesRepo.remove(id);
  if (!result.ok) {
    addMilestoneToState(milestone);
    setTasks(previousTasks);
    setProjects(previousProjects);
    showError(result.error);
    return false;
  }

  success('Välitavoite poistettu.');
  return true;
}

// ------------------------------------------ mukautuva uudelleensuunnittelu

/**
 * Rakenna muutosehdotus.
 *
 * TÄMÄ EI SIIRRÄ MITÄÄN. Se laskee, mitä siirtoja tarvittaisiin.
 * Varsinainen kirjoitus tapahtuu `applyReplan`-funktiossa ja vain
 * niille siirroille, jotka automaatiotaso sallii tai käyttäjä
 * hyväksyy.
 */
export function proposeReplan(trigger = 'manual', options = {}) {
  const state = getState();

  const proposal = buildReplanProposal({
    trigger,
    tasks: state.tasks,
    goals: state.goals,
    routines: state.routines,
    exceptions: state.routineExceptions,
    profile: state.profile,
    todayIso: fmtISO(todayMidnight()),
    automationLevel: state.automationLevel,
    ...options
  });

  setPendingReplan(proposal);
  return proposal;
}

/**
 * Toteuta muutosehdotus.
 *
 * VAIN NIMENOMAISESTI ANNETUT SIIRROT. Kutsuja päättää, mitkä
 * muutokset toteutetaan — tämä ei valitse puolesta.
 *
 * Jos yksikin siirto epäonnistuu, jo tehdyt PERUUTETAAN. Puolittain
 * siirretty suunnitelma on pahempi kuin siirtämätön: käyttäjä ei
 * tietäisi kumpi puolisko on voimassa.
 */
export async function applyReplan(changes = []) {
  if (!Array.isArray(changes) || changes.length === 0) {
    return { ok: true, applied: 0 };
  }

  const undo = [];

  for (const change of changes) {
    const task = findTask(change.taskId);
    if (!task) continue;

    const previousDate = task.date;

    // SIIRTO EI KIINNITÄ AIKAA. Päivä muuttuu, kellonaika ei — ja
    // aikataulutuksen tila pysyy joustavana, jottei siirto tekisi
    // tehtävästä koskematonta.
    const result = await editTask(change.taskId, { date: change.toDateIso });

    if (!result || !result.ok) {
      for (const entry of undo) {
        await editTask(entry.taskId, { date: entry.dateIso });
      }
      showError('Siirto epäonnistui. Muutokset peruttiin.');
      return { ok: false, applied: 0 };
    }

    undo.unshift({ taskId: change.taskId, dateIso: previousDate });
  }

  clearPendingReplan();
  success(changes.length === 1
    ? 'Tehtävä siirretty.'
    : `${changes.length} tehtävää siirretty.`);

  return { ok: true, applied: changes.length };
}

/** Hylkää muutosehdotus. Mitään ei siirretä. */
export function rejectReplan() {
  clearPendingReplan();
  return { ok: true };
}
