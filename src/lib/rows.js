// Muunnos sovelluksen tehtavaolion ja Supabase-rivin valilla.
//
// TURVALLISUUSPERIAATE (WP1):
// toRow() ei koskaan kirjoita user_id-kenttaa. Omistajuuden asettaa
// tietokanta itse (sarakkeen oletusarvo auth.uid()) ja RLS-politiikka
// varmistaa sen. Nain selain EI voi valita toisen kayttajan user_id:ta
// edes silloin, kun sovelluskoodissa olisi virhe.
//
// Ks. supabase/migrations/0001_auth_user_scoping.sql ja docs/SECURITY.md.

/** Kentat, joita client ei saa koskaan lahettaa kantaan. */
export const SERVER_OWNED_FIELDS = Object.freeze(['user_id', 'created_at', 'updated_at']);

/**
 * Sovelluksen tehtavaolio -> Supabase-rivi.
 * Palauttaa TASMALLEEN sallitut sarakkeet, ei mitaan muuta.
 */
export function toRow(t) {
  return {
    id: t.id,
    date: t.date,
    time: t.time,
    end_time: t.endTime,
    title: t.title,
    category: t.category,
    note: t.note,
    completed: t.completed,
    is_wake: !!t.isWake
  };
}

/** Supabase-rivi -> sovelluksen tehtavaolio. */
export function fromRow(r) {
  return {
    id: r.id,
    date: r.date,
    time: r.time,
    endTime: r.end_time,
    title: r.title,
    category: r.category,
    note: r.note,
    completed: r.completed,
    isWake: !!r.is_wake
  };
}

/**
 * Varmistaa, ettei lahtevassa payloadissa ole palvelimen omistamia kenttia.
 * Kaytetaan puolustuksena syvyydessa ennen kirjoituskutsuja.
 * Heittaa poikkeuksen, jos kielletty kentta loytyy.
 */
export function assertClientSafe(row) {
  for (const field of SERVER_OWNED_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(row, field)) {
      throw new Error('Client ei saa asettaa kenttaa: ' + field);
    }
  }
  return row;
}

/** Uusi asiakaspuolen tehtava-ID. Tormaysriski on kaytannossa olematon. */
export function newTaskId() {
  return 'm' + Date.now() + Math.random().toString(36).slice(2, 6);
}
