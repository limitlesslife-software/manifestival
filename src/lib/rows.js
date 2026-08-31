// Muunnos sovelluksen tehtäväolion ja Supabase-rivin välillä.
//
// TURVALLISUUSPERIAATE (WP1):
// toRow() ei koskaan kirjoita user_id-kenttää. Omistajuuden asettaa
// tietokanta itse (sarakkeen oletusarvo auth.uid()) ja RLS-politiikka
// varmistaa sen. Näin selain EI voi valita toisen käyttäjän user_id:tä
// edes silloin, kun sovelluskoodissa olisi virhe.
//
// SKEEMAPORTTI (WP2):
// Osa domainin kentistä (description, durationMinutes, priority,
// schedulingState) vaatii migraation 0002. Siihen asti niitä ei kirjoiteta
// kantaan lainkaan. toRow ottaa sarakelistan parametrina ja
// src/data/schema.js päättää kumpaa käytetään. Näin migraation ajaminen on
// yhden vakion muutos, ei uusi refaktorointi.
//
// Ks. supabase/migrations/ ja docs/SCHEMA.md.

/** Kentät, joita client ei saa koskaan lähettää kantaan. */
export const SERVER_OWNED_FIELDS = Object.freeze(['user_id', 'created_at', 'updated_at']);

/** Sarakkeet, jotka tuotantoskeemassa on tällä hetkellä olemassa. */
export const TASK_COLUMNS_CORE = Object.freeze([
  'id', 'date', 'time', 'end_time', 'title', 'category', 'note', 'completed', 'is_wake'
]);

/** Sarakkeet migraation 0002 jälkeen. */
export const TASK_COLUMNS_EXTENDED = Object.freeze([
  ...TASK_COLUMNS_CORE,
  'description', 'duration_minutes', 'priority', 'scheduling_state'
]);

/** Domain-kenttä -> kannan sarake. Yksi lähde molemmille sarakejoukoille. */
function columnValues(task) {
  return {
    id: task.id,
    date: task.date,
    time: task.time,
    end_time: task.endTime,
    title: task.title,
    category: task.category,
    note: task.note,
    completed: task.completed,
    is_wake: !!task.isWake,
    description: task.description ?? null,
    duration_minutes: task.durationMinutes ?? null,
    priority: task.priority ?? null,
    scheduling_state: task.schedulingState ?? null
  };
}

/**
 * Sovelluksen tehtäväolio -> Supabase-rivi.
 * Palauttaa TÄSMÄLLEEN annetut sarakkeet, ei mitään muuta.
 *
 * @param {object} task
 * @param {ReadonlyArray<string>} [columns] Sallitut sarakkeet.
 */
export function toRow(task, columns = TASK_COLUMNS_CORE) {
  const all = columnValues(task || {});
  const row = {};
  for (const column of columns) {
    if (Object.prototype.hasOwnProperty.call(all, column)) row[column] = all[column];
  }
  return row;
}

/**
 * Supabase-rivi -> sovelluksen tehtäväolio.
 * Lukee laajennetut sarakkeet, jos ne ovat olemassa. Sama funktio toimii
 * siis sekä ennen migraatiota 0002 että sen jälkeen.
 */
export function fromRow(row) {
  return {
    id: row.id,
    date: row.date,
    time: row.time,
    endTime: row.end_time,
    title: row.title,
    category: row.category,
    note: row.note,
    completed: row.completed,
    isWake: !!row.is_wake,
    description: row.description ?? null,
    durationMinutes: row.duration_minutes ?? null,
    priority: row.priority ?? undefined,
    schedulingState: row.scheduling_state ?? undefined
  };
}

/**
 * Varmistaa, ettei lähtevässä payloadissa ole palvelimen omistamia kenttiä.
 * Käytetään puolustuksena syvyydessä ennen kirjoituskutsuja.
 * Heittää poikkeuksen, jos kielletty kenttä löytyy.
 */
export function assertClientSafe(row) {
  for (const field of SERVER_OWNED_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(row, field)) {
      throw new Error('Client ei saa asettaa kenttaa: ' + field);
    }
  }
  return row;
}

/**
 * Uusi asiakaspuolen tehtävä-ID.
 *
 * Aiempi toteutus oli aikaleima + NELJÄ satunnaista base36-merkkiä. Neljä
 * merkkiä on vain ~1,7 miljoonaa vaihtoehtoa, joten saman millisekunnin
 * sisällä luoduilla tunnisteilla oli todellinen törmäysriski — testi paljasti
 * sen 500 tunnisteen otoksella. Törmäys olisi tarkoittanut, että tehtävä
 * ylikirjoittaa toisen.
 */
export function newTaskId() {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
    return 'm' + cryptoObj.randomUUID().replace(/-/g, '');
  }

  // Varasuunnitelma vanhemmille ympäristöille: aikaleima + pitkä satunnaisosa.
  let suffix = '';
  while (suffix.length < 16) suffix += Math.random().toString(36).slice(2);
  return 'm' + Date.now().toString(36) + suffix.slice(0, 16);
}
