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
import { loadTimer, saveTimer, loadTombstones, clearTombstone } from '../data/timerStore.js';
import { getUser } from '../data/session.js';
import { normalizeTimer, validateTimer } from '../domain/timer.js';

function userId() {
  const user = getUser();
  return user && user.id ? String(user.id) : null;
}

/** Ajastimen repositorio; testit voivat korvata sen (timeTracking.setTimerRepoForTests). */
let repo = runningTimersRepo;

export function setTimerStateRepo(replacement) {
  repo = replacement || runningTimersRepo;
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
  const tombstones = new Set(id ? loadTombstones(id) : []);
  // Tällä laitteella pysäytetty/hylätty, mutta poisto ei ehtinyt kantaan:
  // EI herätetä henkiin. Poisto yritetään uudelleen taustalla.
  for (const buried of fromRepo.filter(timer => tombstones.has(timer.id))) {
    Promise.resolve(repo.remove(buried.id)).then(result => {
      if (result && result.ok && id) clearTombstone(id, buried.id);
    }).catch(() => { /* yritetään seuraavalla latauksella */ });
  }
  const live = fromRepo.filter(timer => !tombstones.has(timer.id));
  const local = id ? loadTimer(id) : null;
  if (repo.isPersistent() && live.length > 0) {
    const remote = live[0];
    // Sama ajastin: laitteen kopio sisältää tämän laitteen tuoreimmat
    // muutokset (esim. offline-tauko), joten se voittaa. Eri ajastin =
    // toisella laitteella käynnistetty: kanta voittaa.
    const timer = local && local.id === remote.id ? local : remote;
    setRunningTimerInState(timer);
    if (id) saveTimer(id, timer);
    const differs = local && ['startedAt', 'pausedAt', 'pausedSeconds'].some(key => local[key] !== remote[key]);
    if (timer === local && differs) {
      Promise.resolve(repo.update(local)).catch(() => { /* seuraavalla kerralla */ });
    }
    return timer;
  }
  setRunningTimerInState(local && !tombstones.has(local.id) ? local : (live[0] || null));
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
