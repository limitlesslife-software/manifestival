// Supabase-clientin luonti ja jakelu.
//
// Client luodaan laiskasti, jotta moduulin voi importoida myös ympäristössä,
// jossa supabase-js:ää ei ole ladattu (esim. Node-testit). Testit voivat
// syöttää oman clientinsä setClient()-funktiolla, jolloin repositoriot
// voidaan testata ilman verkkoyhteyttä.

import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

let client = null;

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
    }
  });
  return client;
}

/** Onko client jo luotu. Käytetään siihen, ettei luoda sitä turhaan. */
export function hasClient() {
  return client !== null;
}
