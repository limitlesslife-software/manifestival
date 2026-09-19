// Offline-jonon sovelluskohtainen ilmentymä ja tilan julkaisu.
//
// Ohut liima: oikeat riippuvuudet (repositorio, tallennus, istunto, kello)
// kytketään src/app/offlineSync.js:n tehtaaseen, ja jonon tila julkaistaan
// käyttöliittymälle. Logiikka on offlineSync.js:ssä ja domainissa.

import { createOfflineSync } from './offlineSync.js';
import * as tasksRepo from '../data/tasksRepo.js';
import { loadQueueText, saveQueueText, purgeQueue } from '../data/offlineQueueStore.js';
import { getUser, sessionSnapshot, isSameSession } from '../data/session.js';
import { newTaskId } from '../lib/rows.js';

const listeners = new Set();
let syncedHandler = () => {};

/** Tilan muutoksen kuuntelija. Palauttaa peruutusfunktion. */
export function subscribeSyncStatus(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Kutsutaan kun operaatio on synkronoitu/ratkaistu ja tehtävät kannattaa ladata uudelleen. */
export function setSyncedHandler(handler) {
  syncedHandler = typeof handler === 'function' ? handler : () => {};
}

export function isOnlineNow() {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

export const offline = createOfflineSync({
  repo: tasksRepo,
  store: { load: loadQueueText, save: saveQueueText, purge: purgeQueue },
  session: {
    userId: () => {
      const user = getUser();
      return user && user.id ? String(user.id) : null;
    },
    snapshot: sessionSnapshot,
    isSame: isSameSession
  },
  now: () => Date.now(),
  isOnline: isOnlineNow,
  newId: newTaskId,
  onChange: status => { for (const listener of listeners) { try { listener(status); } catch { /* näkymä */ } } },
  onSynced: () => syncedHandler()
});
