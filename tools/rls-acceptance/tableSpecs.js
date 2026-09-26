// Migraatioiden 0009–0013 taulut RLS-hyväksyntätestissä (CRIT-07).
//
// MIKSI TÄMÄ ON OLEMASSA
//
// Hyväksyntätesti todisti oikeaa PostgRESTiä vasten vain migraatioiden
// 0001–0008 taulut. Neljätoista myöhempää taulua — kaikki kuusi Suunnan
// taulua mukaan lukien, eli pohdinnat, kirjattu aika muistiinpanoineen ja
// käynnissä oleva ajastin — olivat todistettuja vain SQL:ää lukemalla ja
// paikallisella PG17-harjoituksella (set role, ei JWT:tä, ei PostgRESTiä).
//
// Tämä moduuli on niiden määrittely: yksi rivi taulua kohti ja yksi rivi
// jokaista yhdistelmävierasavainta kohti. acceptance.js ajaa ne samalla
// omistajuusmatriisilla (ownershipSection) kuin 0004–0008:n taulut.
//
// AALTO RATKAISEE, MITÄ AJETAAN
//
// Taulua ei ole tuotannossa ennen kuin sen migraatio on ajettu. Jokaisen
// taulun aalto luetaan tools/release/waves.mjs:stä (aallon `tables`), ja
// vierasavaimen aalto sen migraatiosta (MIGRATION_WAVE): esimerkiksi
// goals.life_area_id syntyy vasta 0012:ssa (aalto I), vaikka goals on
// aallosta B. Ajaja valitsee aallon, jonka migraatiot tuotannossa on
// ajettu; sitä myöhempiä tauluja ei kosketa lainkaan.
//
// TÄMÄ EI OLE SOVELLUKSEN PORTTITILA. Moduuli ei lue src/data/schema.js:ää:
// hyväksyntätesti todistaa KANNAN, ja kanta voi olla porttien edellä.
//
// TESTIRIVIT
//
// Sarakkeet ovat osajoukko siitä, mitä sovelluksen repositorio kirjoittaa
// (src/data/collectionsRepo.js toRow), ja ne kattavat jokaisen NOT NULL
// -sarakkeen, jolla ei ole oletusarvoa. 0013:n lisäämiä sarakkeita ei
// kirjoiteta 0012:n tauluihin, jotta sama rivi kelpaa aalloissa I ja J.
// user_id, created_at ja updated_at jäävät pois: ne ovat kannan omaisuutta.
//
// Yksikäsitteisyysrajoitteet on väistetty rakenteella, ei toivolla (vrt.
// E4, tuotantoajo 20260907181539): viikkorivit käyttävät vuoden 1990
// maanantaita, nimet ja avaimet johdetaan ajon tunnisteesta, eikä
// vapaata tekstiä kirjoiteta muistiinpanoihin eikä pohdintoihin.

import { WAVES, MIGRATION_WAVE, DB_FLOOR, waveIndex } from '../release/waves.mjs';

/** Taulun aalto tools/release/waves.mjs:n mukaan. */
function waveOfTable(table) {
  const wave = WAVES.find(candidate => candidate.tables.includes(table));
  if (!wave) throw new Error(`taulu ${table} ei kuulu yhteenkään aaltoon`);
  return wave;
}

/** Viikkorivin maanantai: kaukana menneisyydessä, eri kullekin roolille. */
const MONDAYS = Object.freeze({ a: '1990-01-01', b: '1990-01-08', forged: '1990-01-15' });

/** Tunnisteesta johdettu nimi: yksilöllinen ajoa ja roolia kohti, alle 60 merkkiä. */
function nameFrom(id) {
  return `RLS ${String(id).slice(-40)}`;
}

function spec(fields) {
  const wave = waveOfTable(fields.table);
  return Object.freeze({ ...fields, wave: wave.id, migration: wave.migration });
}

/**
 * Taulukohtaiset määrittelyt.
 *
 *   code        raportin tunnuksen alku (esim. TE1a, TE2b)
 *   row(id, variant, ctx)
 *               testirivi; variant on 'a' (A:n oma), 'b' (B:n oma) tai
 *               'forged' (B:n väärennös A:n nimiin); ctx.today ja
 *               ctx.parents (A:n ja B:n tavoitteet välitavoitteille)
 *   patch       muutos, jolla omistaja todistaa päivitysoikeutensa ja jota
 *               vieras yrittää; patchField/patchValue tarkistetaan 3e:ssä
 */
export const TABLE_SPECS = Object.freeze([
  // --- 0009 (aalto F) ------------------------------------------------
  spec({
    code: 'TR', table: 'transactions', label: 'tapahtuman',
    row: (id, variant, { today }) => ({
      id, kind: 'expense', origin: 'manual', amount_minor: 1000, currency: 'EUR', date: today,
      category: null, description: null, note: null, source_kind: null, source_id: null
    }),
    patch: { amount_minor: 2000 }, patchField: 'amount_minor', patchValue: 2000
  }),
  spec({
    code: 'IV', table: 'investments', label: 'sijoituksen',
    row: id => ({
      id, name: nameFrom(id), symbol: null, kind: 'other', quantity: null, cost_basis_minor: null,
      current_value_minor: null, valued_on: null, value_source: 'unknown', currency: 'EUR',
      target_value_minor: null, note: null
    }),
    patch: { kind: 'fund' }, patchField: 'kind', patchValue: 'fund'
  }),

  // --- 0010 (aalto G) ------------------------------------------------
  // Välitavoite EI elä ilman tavoitetta: A:n rivi osoittaa A:n
  // tavoitteeseen, B:n rivi B:n. Väärennös osoittaa A:n tavoitteeseen,
  // jotta RLS:n WITH CHECK on ainoa este (vierasavain hyväksyisi parin).
  spec({
    code: 'MS', table: 'milestones', label: 'välitavoitteen',
    row: (id, variant, { parents }) => ({
      id, goal_id: variant === 'b' ? parents.goalB : parents.goalA, title: nameFrom(id),
      description: null, target_date: null, status: 'open', order_index: 0, rule: 'manual',
      reached_date: null
    }),
    patch: { order_index: 5 }, patchField: 'order_index', patchValue: 5
  }),

  // --- 0011 (aalto H) ------------------------------------------------
  // captured_at jää pois: NOT NULL DEFAULT now(). Nimenomainen null
  // kaatuisi 23502:een (sama havainto kuin ai_action_audit.occurred_at).
  spec({
    code: 'IB', table: 'inbox_items', label: 'saapuneen kirjauksen',
    row: id => ({
      id, text: nameFrom(id), status: 'unprocessed', source: 'text', proposal: null,
      converted_kind: null, converted_id: null
    }),
    patch: { status: 'dismissed' }, patchField: 'status', patchValue: 'dismissed'
  }),
  spec({
    code: 'RM', table: 'reminders', label: 'muistutuksen',
    row: (id, variant, { today }) => ({
      id, title: nameFrom(id), target_type: 'standalone', target_id: null, trigger_type: 'at_time',
      due_date: today, due_time: null, lead_minutes: null, status: 'scheduled', escalate: false,
      alert_count: 0, snooze_count: 0, until_time: null, note: null
    }),
    patch: { status: 'cancelled' }, patchField: 'status', patchValue: 'cancelled'
  }),
  // notice_key on uniikki käyttäjää kohti: avain on rivin oma tunniste.
  spec({
    code: 'NT', table: 'notices', label: 'ilmoituksen',
    row: (id, variant, { today }) => ({
      id, notice_key: id, kind: 'reminder', level: 'info', status: 'unread', title: nameFrom(id),
      reason: null, target_type: null, target_id: null, created_date: today
    }),
    patch: { status: 'read' }, patchField: 'status', patchValue: 'read'
  }),
  spec({
    code: 'TP', table: 'travel_plans', label: 'matkasuunnitelman',
    row: (id, variant, { today }) => ({
      id, title: nameFrom(id), origin: null, destination: null, arrival_date: today,
      arrival_time: null, mode: 'driving', travel_minutes: null, travel_source: 'unknown',
      estimated_at: null, preparation_minutes: 10, arrival_buffer_minutes: 5, task_id: null,
      note: null
    }),
    patch: { mode: 'walking' }, patchField: 'mode', patchValue: 'walking'
  }),
  spec({
    code: 'LR', table: 'location_rules', label: 'paikkamuistutuksen',
    row: id => ({
      id, place: nameFrom(id), trigger_type: 'arriving', message: null, active: false, task_id: null
    }),
    patch: { trigger_type: 'leaving' }, patchField: 'trigger_type', patchValue: 'leaving'
  }),

  // --- 0012 (aalto I): Suunta -----------------------------------------
  // Nimi on uniikki käyttäjää kohti (life_areas_name_unique), ja A:n
  // oikeat alueet ovat samassa taulussa: nimi johdetaan ajon tunnisteesta.
  // category_key jää nulliksi (life_areas_category_unique sallii useita).
  spec({
    code: 'LA', table: 'life_areas', label: 'elämänalueen',
    row: id => ({
      id, name: nameFrom(id), description: null, importance: 3, target_minutes_per_week: null,
      category_key: null, active: true, sort_order: 0
    }),
    patch: { importance: 5 }, patchField: 'importance', patchValue: 5
  }),
  spec({
    code: 'WC', table: 'weekly_capacities', label: 'viikkokapasiteetin',
    row: (id, variant) => ({
      id, week_start: MONDAYS[variant], available_minutes: 600, energy_level: null, note: null
    }),
    patch: { available_minutes: 900 }, patchField: 'available_minutes', patchValue: 900
  }),
  spec({
    code: 'TE', table: 'time_entries', label: 'aikakirjauksen',
    row: (id, variant, { today }) => ({
      id, entry_date: today, minutes: 15, life_area_id: null, goal_id: null, task_id: null,
      source: 'manual', note: null
    }),
    patch: { minutes: 30 }, patchField: 'minutes', patchValue: 30
  }),
  // POHDINTA ON KOKO SOVELLUKSEN YKSITYISIN SARAKE. Päivitys kohdistuu
  // juuri siihen: B:n UPDATE A:n pohdintaan (AR3a) osuu nollaan riviin,
  // ja AR6a/AR6b todistavat eri arvolla, ettei A:n pohdinta muuttunut.
  spec({
    code: 'AR', table: 'alignment_reviews', label: 'viikkokatsauksen',
    row: (id, variant) => ({
      id, week_start: MONDAYS[variant], snapshot_version: 1, snapshot: {}, reflection: null,
      adjustments: [], completed_at: null
    }),
    patch: { reflection: 'RLS-testin pohdinta' }, patchField: 'reflection',
    patchValue: 'RLS-testin pohdinta'
  }),

  // --- 0013 (aalto J): Suunta 2 ---------------------------------------
  // YKSI AJASTIN KÄYTTÄJÄÄ KOHTI (running_timers_one_per_user). Siksi
  // ajo pysähtyy lähtötilaan (P2), jos A:lla on käynnissä oleva ajastin,
  // ja B:n INSERT-ristiinkiinnitykset ajetaan ennen B:n omaa ajastinta.
  spec({
    code: 'RT', table: 'running_timers', label: 'ajastimen',
    row: (id, variant, { today }) => ({
      id, target_kind: 'none', life_area_id: null, goal_id: null, task_id: null, project_id: null,
      routine_id: null, occurrence_date: null, started_at: `${today}T00:00:00Z`, paused_at: null,
      paused_seconds: 0, note: null
    }),
    patch: { paused_seconds: 60 }, patchField: 'paused_seconds', patchValue: 60
  }),
  spec({
    code: 'AS', table: 'alignment_item_settings', label: 'Suunta-asetuksen',
    row: id => ({
      id, item_kind: 'task', item_id: id, energy_demand: null, alignment_opt_out: false,
      estimate_approximate: false
    }),
    patch: { energy_demand: 3 }, patchField: 'energy_demand', patchValue: 3
  })
]);

/**
 * Jokainen migraatioiden 0009–0013 yhdistelmävierasavain käyttäjän
 * omistamaan tauluun: `foreign key (user_id, column) references
 * public.parent (user_id, id)`.
 *
 * tests/rls-acceptance.test.mjs jäsentää migraatiot ja vaatii, että tämä
 * lista on täsmälleen sama. Jokaiselle ajetaan kaksi hyökkäystä: B luo
 * rivin, joka viittaa A:n riviin (XV-), ja B kääntää OMAN rivinsä viitteen
 * A:n riviin (UV-). Molempien odotus on 23503 — RLS ei estä kumpaakaan,
 * koska rivin omistaja on oikein.
 */
export const COMPOSITE_FK_PROBES = Object.freeze([
  ['0010', 'milestones', 'goal_id', 'goals'],
  ['0010', 'tasks', 'milestone_id', 'milestones'],
  ['0010', 'projects', 'milestone_id', 'milestones'],
  ['0011', 'travel_plans', 'task_id', 'tasks'],
  ['0011', 'location_rules', 'task_id', 'tasks'],
  ['0012', 'goals', 'life_area_id', 'life_areas'],
  ['0012', 'time_entries', 'life_area_id', 'life_areas'],
  ['0012', 'time_entries', 'goal_id', 'goals'],
  ['0012', 'time_entries', 'task_id', 'tasks'],
  ['0013', 'time_entries', 'project_id', 'projects'],
  ['0013', 'time_entries', 'routine_id', 'routines'],
  ['0013', 'running_timers', 'life_area_id', 'life_areas'],
  ['0013', 'running_timers', 'goal_id', 'goals'],
  ['0013', 'running_timers', 'task_id', 'tasks'],
  ['0013', 'running_timers', 'project_id', 'projects'],
  ['0013', 'running_timers', 'routine_id', 'routines']
].map(([migration, table, column, parent]) => Object.freeze({
  migration, wave: MIGRATION_WAVE[migration], table, column, parent,
  key: `${table}.${column}`
})));

/**
 * Siivousjärjestys: lapset ennen vanhempia. Ajastin ja kirjaukset ennen
 * alueita, välitavoitteet ennen alueita, alueet viimeisenä (goals ja
 * time_entries viittaavat niihin, ON DELETE SET NULL).
 */
export const CLEANUP_ORDER = Object.freeze([
  'running_timers', 'time_entries', 'alignment_item_settings', 'alignment_reviews',
  'weekly_capacities', 'travel_plans', 'location_rules', 'notices', 'reminders',
  'inbox_items', 'transactions', 'investments', 'milestones', 'life_areas'
]);

/** Aallot, joita vasten testin voi ajaa: kannan lattiasta (0008 = E) viimeiseen. */
export const ACCEPTANCE_WAVES = Object.freeze(
  WAVES.map(wave => wave.id).filter(id => waveIndex(id) >= waveIndex(DB_FLOOR.wave)));

/** Oletusaalto: tuotannon kanta ilman junan migraatioita (0008). */
export const DEFAULT_ACCEPTANCE_WAVE = DB_FLOOR.wave;

/** Kuuluuko aalto `item` ajoon, kun tuotannon kanta on aallossa `wave`? */
export function inWave(item, wave) {
  const limit = waveIndex(wave);
  const own = waveIndex(item.wave);
  return limit !== null && own !== null && own <= limit;
}

/** Määrittely taulun nimellä, tai null. */
export function specFor(table) {
  return TABLE_SPECS.find(entry => entry.table === table) || null;
}
