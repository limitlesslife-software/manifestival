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

/**
 * Sarakkeet migraation 0010 jälkeen.
 *
 * EI AJETTU. Ks. GOAL_PLANNING_FIELDS src/data/schema.js.
 *
 * `tasks` on TUOTANNOSSA AUKI ja siinä on käyttäjän dataa. Näiden
 * lähettäminen ennen migraatiota kaataisi jokaisen tehtävän
 * tallennuksen koodilla 42703 — myös niiden jotka toimivat tänään.
 */
export const TASK_COLUMNS_PLANNING = Object.freeze([
  ...TASK_COLUMNS_EXTENDED,
  'milestone_id', 'depends_on'
]);

/** Domain-kenttä -> kannan sarake. Yksi lähde molemmille sarakejoukoille. */
function columnValues(task) {
  return {
    id: task.id,
    date: task.date,
    time: task.time,
    end_time: task.endTime,
    milestone_id: task.milestoneId,
    depends_on: task.dependsOn,
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
    schedulingState: row.scheduling_state ?? undefined,
    // Suunnittelukentät (migraatio 0010, GOAL_PLANNING_FIELDS). toRow
    // kirjoittaa ne portin ollessa auki, joten ne on myös luettava:
    // muuten välitavoite ja riippuvuudet tallentuisivat mutta katoaisivat
    // uudelleenlatauksessa, ja seuraava koko rivin kirjoitus nollaisi ne
    // (löydös aallon H harjoitteluintegraatiossa). Ennen 0010:tä
    // sarakkeita ei ole, jolloin arvot ovat samat kuin normalizeTaskin
    // oletukset.
    milestoneId: row.milestone_id ?? null,
    dependsOn: Array.isArray(row.depends_on) ? [...row.depends_on] : [],
    // Aikaleimat ovat kannan omaisuutta: created_at saa arvonsa
    // oletusarvosta ja updated_at liipaisimesta (migraatio 0002).
    // Client LUKEE ne mutta ei koskaan kirjoita — ne eivät ole
    // sarakelistoissa, ja assertClientSafe kaataisi kirjoituksen jos ne
    // livahtaisivat payloadiin. Ennen 0002:ta sarakkeita ei ole, jolloin
    // arvoksi jää null aivan kuten ennenkin.
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null
  };
}

/**
 * Ovatko kaksi sarakearvoa samat? Taulukot (tasks.depends_on) verrataan
 * ARVOINA: kaksi erillistä tyhjää taulukkoa ovat sama arvo. Identiteetti-
 * vertailu (===) tulkitsi jokaisen taulukon muuttuneeksi, jolloin
 * ehdollinen kirjoitus lähetti sen ja käytti sitä vertailuehtona.
 * null ja undefined ovat sama tyhjä arvo; taulukkosarakkeessa tyhjä =
 * tyhjä taulukko (sarake on NOT NULL default '{}').
 */
export function sameColumnValue(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    const x = Array.isArray(a) ? a : (a == null ? [] : null);
    const y = Array.isArray(b) ? b : (b == null ? [] : null);
    if (!x || !y || x.length !== y.length) return false;
    return x.every((value, i) => String(value) === String(y[i]));
  }
  return (a === null || a === undefined) && (b === null || b === undefined);
}

/**
 * PostgreSQL-taulukkoliteraali PostgREST-suodattimeen: ['a', 'b'] -> {"a","b"}.
 *
 * `.eq('depends_on', [])` muuttuisi URL:ssa muotoon `depends_on=eq.` ja
 * kanta vastaisi 22P02 (malformed array literal). Alkiot lainataan aina,
 * ja lainausmerkki sekä kenoviiva suojataan.
 */
export function pgArrayLiteral(values) {
  const items = (Array.isArray(values) ? values : [])
    .map(value => '"' + String(value).replace(/(["\\])/g, '\\$1') + '"');
  return '{' + items.join(',') + '}';
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
