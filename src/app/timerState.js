// Ajastimen tila: missä ajastin on ja kumpi kopio voittaa.
//
// Kaksi paikkaa, yksi sääntö:
//
//   kanta (running_timers, 0013)  auktoritatiivinen, kun portti on auki
//                                 ja lataus onnistui; YKSI käyttäjää kohti
//   laite (timerStore)            varmistus uudelleenlatausta ja
//                                 verkkokatkoa varten; ainoa paikka ennen
//                                 migraatiota
//
// Tämä moduuli ei tuo actions.js:ää eikä alignment.js:ää, jotta lataus
// (actions.loadUserData) voi kutsua sitä ilman kehäriippuvuutta.

import { getState, setRunningTimerInState } from './state.js';
import { runningTimersRepo } from '../data/collectionsRepo.js';
import { loadTimer, saveTimer } from '../data/timerStore.js';
import { getUser } from '../data/session.js';
import { normalizeTimer, validateTimer } from '../domain/timer.js';

function userId() {
  const user = getUser();
  return user && user.id ? String(user.id) : null;
}

/** Nykyinen ajastin tai null. */
export function currentTimer() {
  return getState().runningTimers[0] || null;
}

/**
 * Latauksen tulos: kannasta (tai muistivarastosta) saatu lista.
 *
 * - Kanta käytössä ja siellä on ajastin -> se voittaa; laitteen kopio
 *   päivitetään vastaamaan sitä (toisella laitteella käynnistetty näkyy).
 * - Muuten laitteen kopio: uudelleenlataus ei hukkaa kulunutta aikaa.
 */
export function adoptLoadedTimers(list = []) {
  const id = userId();
  const fromRepo = (list || []).map(normalizeTimer).filter(timer => validateTimer(timer).valid);
  if (runningTimersRepo.isPersistent() && fromRepo.length > 0) {
    const timer = fromRepo[0];
    setRunningTimerInState(timer);
    if (id) saveTimer(id, timer);
    return timer;
  }
  const local = id ? loadTimer(id) : null;
  setRunningTimerInState(local || fromRepo[0] || null);
  return currentTimer();
}

/** Palauta laitteen ajastin tilaan (käynnistys ennen latausta). */
export function restoreLocalTimer() {
  const id = userId();
  const local = id ? loadTimer(id) : null;
  if (local) setRunningTimerInState(local);
  return local;
}

/**
 * Tallenna ajastin tilaan ja laitteelle. Kanta päivitetään erikseen
 * (timeTracking.js), koska sen epäonnistuminen ei saa hukata ajastinta.
 */
export function persistTimerLocally(timer) {
  const id = userId();
  setRunningTimerInState(timer || null);
  return id ? saveTimer(id, timer || null) : { ok: false, persistent: false };
}
