// Supabase-clientin luonti ja jakelu.
//
// Client luodaan laiskasti, jotta moduulin voi importoida myös ympäristössä,
// jossa supabase-js:ää ei ole ladattu (esim. Node-testit). Testit voivat
// syöttää oman clientinsä setClient()-funktiolla, jolloin repositoriot
// voidaan testata ilman verkkoyhteyttä.

import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

let client = null;

/**
 * Supabase-pyynnön aikaraja. Heikolla mobiiliyhteydellä pyyntö voi muuten
 * roikkua minuutteja: kirjaus ei ehdi lähtökoriin, ja sovelluksen
 * sulkeminen sillä välin hukkasi sen (F10).
 */
export const REQUEST_TIMEOUT_MS = 15000;

/**
 * fetch aikarajalla. Aikakatkaisu näkyy verkkovirheenä ("Failed to fetch"),
 * jolloin kutsuja jonottaa tai yrittää uudelleen kuten muussakin
 * verkkokatkossa (domain/offlineQueue.js classifyError). Kutsujan oma
 * keskeytys (signal) välitetään ennallaan.
 */
export function fetchWithTimeout(fetchImpl = globalThis.fetch, timeoutMs = REQUEST_TIMEOUT_MS,
  { setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = {}) {
  return (input, init = {}) => {
    const controller = new AbortController();
    const outer = init && init.signal;
    let timedOut = false;
    const onOuterAbort = () => controller.abort(outer.reason);
    if (outer) {
      if (outer.aborted) controller.abort(outer.reason);
      else outer.addEventListener('abort', onOuterAbort, { once: true });
    }
    const timer = setTimeoutFn(() => { timedOut = true; controller.abort(); }, timeoutMs);
    return Promise.resolve()
      .then(() => fetchImpl(input, { ...init, signal: controller.signal }))
      .catch(error => {
        if (timedOut) throw new TypeError(`Failed to fetch: aikaraja ${Math.round(timeoutMs / 1000)} s ylittyi`);
        throw error;
      })
      .finally(() => {
        clearTimeoutFn(timer);
        if (outer) outer.removeEventListener('abort', onOuterAbort);
      });
  };
}

/**
 * Korvaa clientin. Tarkoitettu testeille ja adaptereille.
 * @param {object|null} instance
 */
export function setClient(instance) {
  client = instance;
}

/**
 * Palauttaa Supabase-clientin. Luo sen ensimmäisellä kutsulla.
 * Heittää selkeän virheen, jos supabase-js:ää ei ole ladattu.
 */
export function getClient() {
  if (client) return client;

  const globalSupabase = typeof globalThis !== 'undefined' ? globalThis.supabase : undefined;
  if (!globalSupabase || typeof globalSupabase.createClient !== 'function') {
    throw new Error('supabase-js ei ole ladattu');
  }

  client = globalSupabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      // Istunto säilyy selaimen uudelleenlatauksen yli ja token uusitaan
      // automaattisesti, jotta käyttäjä ei putoa ulos kesken päivän.
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true
    },
    // Jokaisella pyynnöllä on aikaraja (ks. fetchWithTimeout).
    global: { fetch: fetchWithTimeout((...args) => globalThis.fetch(...args)) }
  });
  return client;
}


