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

function initialState() {
  const today = todayMidnight();
  return {
    tasks: [],
    viewDate: today,
    weekStart: startOfWeek(today),
    profile: { ...DEFAULT_PROFILE },
    profileExists: false,
    editingId: null,
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
