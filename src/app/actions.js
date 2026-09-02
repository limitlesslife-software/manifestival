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
  volatileCollections, clearAllCollections
} from '../data/collectionsRepo.js';
import { newTaskId } from '../lib/rows.js';
import { normalizeTask, validateTask, SCHEDULING } from '../domain/task.js';
import { normalizeRoutine, validateRoutine, normalizeException, EXCEPTION } from '../domain/routine.js';
import { normalizeGoal, validateGoal } from '../domain/goal.js';
import { normalizeWellbeingEntry, validateWellbeingEntry } from '../domain/wellbeing.js';
import { volatileFields } from '../data/schema.js';
import {
  getState, findTask, addTaskToState, removeTaskFromState,
  replaceTaskInState, patchTaskInState, setTasks, setProfile,
  clearOtherWakeFlagsInState,
  setRoutines, addRoutineToState, replaceRoutineInState, removeRoutineFromState, findRoutine,
  setRoutineExceptions, addRoutineExceptionToState, removeRoutineExceptionFromState,
  setGoals, addGoalToState, replaceGoalInState, removeGoalFromState, findGoal,
  setProjects, setWellbeing, upsertWellbeingEntry, setNotificationPreferences,
  setBills, setRecurringExpenses, setSavingsGoals, setAiAudit
} from './state.js';
import {
  loadPreferences as loadNotificationPreferences,
  clearPreferences as clearNotificationPreferences
} from '../data/notificationPrefsRepo.js';
import { showError, success, notify } from '../ui/toast.js';
import { confirmDelete, confirmAction } from '../ui/confirm.js';

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

/** Lataa kirjautuneen käyttäjän kaikki tiedot. */
export async function loadUserData() {
  const [tasksResult, profileResult, routinesResult, exceptionsResult,
    goalsResult, projectsResult, wellbeingResult, preferencesResult,
    billsResult, expensesResult, savingsResult, auditResult] = await Promise.all([
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
    aiAuditRepo.list()
  ]);

  if (tasksResult.ok) setTasks(tasksResult.value);
  else { setTasks([]); showError(tasksResult.error); }

  if (profileResult.ok) setProfile(profileResult.value.profile, profileResult.value.exists);
  else showError(profileResult.error);

  // Kokoelmien lataus ei saa estää sovelluksen käyttöä: virhe näytetään,
  // mutta tila jää tyhjäksi eikä sovellus kaadu.
  setRoutines(routinesResult.ok ? routinesResult.value : []);
  setRoutineExceptions(exceptionsResult.ok ? exceptionsResult.value : []);
  setGoals(goalsResult.ok ? goalsResult.value : []);
  setProjects(projectsResult.ok ? projectsResult.value : []);
  setWellbeing(wellbeingResult.ok ? wellbeingResult.value : []);

  // Muistutusasetukset: virhe ei saa estää sovelluksen käyttöä, ja
  // epäonnistuessa palataan hiljaiseen oletukseen.
  setNotificationPreferences(preferencesResult.ok ? preferencesResult.value : {});

  // Talous ja kirjausketju. Sama periaate: virhe ei estä sovelluksen
  // käyttöä, vaan tila jää tyhjäksi.
  setBills(billsResult.ok ? billsResult.value : []);
  setRecurringExpenses(expensesResult.ok ? expensesResult.value : []);
  setSavingsGoals(savingsResult.ok ? savingsResult.value : []);
  setAiAudit(auditResult.ok ? auditResult.value : []);

  return { tasksOk: tasksResult.ok, profileOk: profileResult.ok };
}

// ----------------------------------------------------------------- tehtävät

/**
 * Luo uusi tehtävä.
 * @returns {Promise<{ok:boolean, errors?:object, task?:object}>}
 */
export async function createTask(input) {
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

  const result = await tasksRepo.insertTask(task);
  if (!result.ok) {
    removeTaskFromState(task.id); // peruutus
    showError(result.error);
    return { ok: false };
  }

  if (task.isWake) await tasksRepo.clearOtherWakeFlags(task.date, task.id);
  return { ok: true, task };
}

/**
 * Muokkaa olemassa olevaa tehtävää.
 * @returns {Promise<{ok:boolean, errors?:object}>}
 */
export async function editTask(id, changes) {
  const previous = findTask(id);
  if (!previous) return { ok: false };

  const updated = normalizeTask({
    ...previous,
    ...changes,
    // Käyttäjän tekemä ajan muutos on aina manuaalinen päätös. Automaatti
    // ei saa myöhemmin siirtää sitä.
    schedulingState: changes.time
      ? SCHEDULING.MANUAL
      : (changes.time === null ? SCHEDULING.UNSCHEDULED : previous.schedulingState)
  });

  const { valid, errors } = validateTask(updated);
  if (!valid) return { ok: false, errors };

  replaceTaskInState(id, updated);
  if (updated.isWake) clearOtherWakeFlagsInState(updated.date, id);
  warnAboutVolatileFields(updated);

  const result = await tasksRepo.updateTask(updated);
  if (!result.ok) {
    replaceTaskInState(id, previous); // peruutus
    showError(result.error);
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

  const result = await tasksRepo.setCompleted(id, nextCompleted);
  if (!result.ok) {
    patchTaskInState(id, { completed: task.completed }); // peruutus
    showError(result.error);
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
