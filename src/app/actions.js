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
import { newTaskId } from '../lib/rows.js';
import { normalizeTask, validateTask, SCHEDULING } from '../domain/task.js';
import { volatileFields } from '../data/schema.js';
import {
  getState, findTask, addTaskToState, removeTaskFromState,
  replaceTaskInState, patchTaskInState, setTasks, setProfile,
  clearOtherWakeFlagsInState
} from './state.js';
import { showError, success, notify } from '../ui/toast.js';
import { confirmDelete } from '../ui/confirm.js';

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

/** Lataa kirjautuneen käyttäjän tehtävät ja profiili. */
export async function loadUserData() {
  const [tasksResult, profileResult] = await Promise.all([
    tasksRepo.listTasks(),
    profileRepo.loadProfile()
  ]);

  if (tasksResult.ok) setTasks(tasksResult.value);
  else { setTasks([]); showError(tasksResult.error); }

  if (profileResult.ok) setProfile(profileResult.value.profile, profileResult.value.exists);
  else showError(profileResult.error);

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
