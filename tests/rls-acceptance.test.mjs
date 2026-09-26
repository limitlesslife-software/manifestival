// RLS-hyväksyntätestin ajurin testit.
//
// ONGELMA, JONKA NÄMÄ RATKAISEVAT
//
// tools/rls-acceptance ajetaan tuotantoa vasten täsmälleen kerran, käsin,
// eikä sitä voi harjoitella oikealla kannalla ilman että luodaan toinen
// tuotantotili. Jos ajuri on rikki, se huomataan pahimmassa mahdollisessa
// hetkessä — tai ei ollenkaan, koska rikkinäinen ajuri raportoi mielellään
// PASSin.
//
// Siksi tässä on RLS:ää matkiva tekokanta, jonka politiikat voi rikkoa
// yksi kerrallaan. Jokainen mutaatio vastaa yhtä todellista tapaa, jolla
// migraatio 0001 voisi mennä pieleen, ja jokaisen on saatava ajuri
// raportoimaan FAIL. Testi, joka läpäisee myös rikkinäisellä kannalla,
// ei todista mitään.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runAcceptance, formatReport, idsFor, taskRow, profileRow,
         routineRow, exceptionRow, exceptionDates, ANON_KOHTEET, NIL_UUID,
         goalRow, projectRow, wellbeingRow, recurringExpenseRow,
         billRow, savingsGoalRow, auditRow, notificationPrefsRow,
         MARKER_PREFIX, STATUS, specIdsFor, attackIdFor,
         BESPOKE_COVERAGE, RLS_EXEMPTIONS }
  from '../tools/rls-acceptance/acceptance.js';
import { TABLE_SPECS, COMPOSITE_FK_PROBES, CLEANUP_ORDER, ACCEPTANCE_WAVES, inWave }
  from '../tools/rls-acceptance/tableSpecs.js';
import { WAVES, MIGRATION_WAVE } from '../tools/release/waves.mjs';
import { ACCOUNT_DATA_MAP } from '../src/domain/accountLifecycle.js';
import fs from 'node:fs';
import path from 'node:path';

import { ROOT, read, readCode } from './helpers/sources.mjs';
import { SUPABASE_ANON_KEY } from '../src/data/config.js';
import { TASK_COLUMNS_CORE, SERVER_OWNED_FIELDS } from '../src/lib/rows.js';

const MIGRATION_DIR = 'supabase/migrations';
const NEWLINE = String.fromCharCode(10);

/** Kaikki migraatiotiedostot numerojarjestyksessa. */
function migrationFiles() {
  return fs.readdirSync(path.join(ROOT, MIGRATION_DIR))
    .filter(name => name.endsWith('.sql'))
    .sort();
}

/** Migraation sisalto pienaakkosin — SQL ei ole kirjainkokoherkkaa. */
function sql(name) {
  return read(`${MIGRATION_DIR}/${name}`).toLowerCase();
}

const OWNER_A = '2cc00622-f927-4604-a518-361a4328481b';
const USER_B = '11111111-2222-3333-4444-555555555555';
const TASK_COUNT = 36;

// ---------------------------------------------------------------------
// Tekokanta, joka toteuttaa migraation 0001 politiikat
// ---------------------------------------------------------------------

const clone = row => ({ ...row });

/** Lähtötila: tilin A 36 tehtävää ja yksi profiili. */
function makeDb() {
  return {
    tasks: Array.from({ length: TASK_COUNT }, (_, i) => ({
      id: `oikea-${i}`, date: '2026-09-05', title: `tehtava ${i}`, user_id: OWNER_A
    })),
    profile: [{ id: OWNER_A, legacy_id: 'me', age: 40, weight_kg: null }],
    // Migraation 0003 taulut. Tuotannossa ne ovat tyhjiä: portit ovat
    // false, joten sovellus ei ole kirjoittanut niihin mitään.
    routines: [],
    routine_exceptions: [],
    // Migraatioiden 0004-0008 taulut. Nekin ovat tuotannossa tyhjia:
    // portit ovat false, joten sovellus ei ole kirjoittanut niihin.
    goals: [],
    projects: [],
    notification_preferences: [],
    wellbeing_entries: [],
    recurring_expenses: [],
    bills: [],
    savings_goals: [],
    ai_action_audit: [],
    // Migraatioiden 0009–0013 taulut (tools/rls-acceptance/tableSpecs.js).
    transactions: [],
    investments: [],
    milestones: [],
    inbox_items: [],
    reminders: [],
    notices: [],
    travel_plans: [],
    location_rules: [],
    life_areas: [],
    weekly_capacities: [],
    time_entries: [],
    alignment_reviews: [],
    running_timers: [],
    alignment_item_settings: [],
    users: [OWNER_A, USER_B]
  };
}

/**
 * Taulut, joissa omistaja on paaavain itse eika erillinen user_id.
 *
 * profile tuli migraatiosta 0001, notification_preferences 0005:sta.
 * Molemmissa rivi on tasan yksi per kayttaja, joten erillista
 * paaavainta ei tarvita — ja silloin politiikatkin rajaavat id:lla.
 */
const OMISTAJA_ON_ID = new Set(['profile', 'notification_preferences']);

/**
 * Omistajuuden yhdistelmavierasavaimet, sellaisina kuin migraatiot ne
 * luovat.
 *
 * MIKSI TAMA ON TAALLA
 * Tekokannan on torjuttava ristiinkiinnitys samoin kuin oikean kannan,
 * muuten hyokkaystestit menisivat lapi tekokantaa vasten vaikka suoja
 * puuttuisi. Lista on siis osa testin todistusvoimaa, ei kulissi.
 *
 * Lista verrataan migraatioihin omassa testissaan alempana, joten se ei
 * voi hiljaa erkaantua niista.
 */
const YHDISTELMAVIERASAVAIMET = [
  { table: 'routine_exceptions', column: 'routine_id',           parent: 'routines' },
  { table: 'goals',              column: 'parent_goal_id',       parent: 'goals' },
  { table: 'goals',              column: 'project_id',           parent: 'projects' },
  { table: 'projects',           column: 'goal_id',              parent: 'goals' },
  { table: 'tasks',              column: 'goal_id',              parent: 'goals' },
  { table: 'tasks',              column: 'project_id',           parent: 'projects' },
  { table: 'routines',           column: 'goal_id',              parent: 'goals' },
  { table: 'bills',              column: 'task_id',              parent: 'tasks' },
  { table: 'bills',              column: 'recurring_expense_id', parent: 'recurring_expenses' },
  // 0010–0013. Kirjoitettu käsin eikä luettu työkalusta: jos tekokanta
  // lainaisi listansa työkalulta, väärä lista todistaisi itsensä.
  { table: 'milestones',         column: 'goal_id',              parent: 'goals' },
  { table: 'tasks',              column: 'milestone_id',         parent: 'milestones' },
  { table: 'projects',           column: 'milestone_id',         parent: 'milestones' },
  { table: 'travel_plans',       column: 'task_id',              parent: 'tasks' },
  { table: 'location_rules',     column: 'task_id',              parent: 'tasks' },
  { table: 'goals',              column: 'life_area_id',         parent: 'life_areas' },
  { table: 'time_entries',       column: 'life_area_id',         parent: 'life_areas' },
  { table: 'time_entries',       column: 'goal_id',              parent: 'goals' },
  { table: 'time_entries',       column: 'task_id',              parent: 'tasks' },
  { table: 'time_entries',       column: 'project_id',           parent: 'projects' },
  { table: 'time_entries',       column: 'routine_id',           parent: 'routines' },
  { table: 'running_timers',     column: 'life_area_id',         parent: 'life_areas' },
  { table: 'running_timers',     column: 'goal_id',              parent: 'goals' },
  { table: 'running_timers',     column: 'task_id',              parent: 'tasks' },
  { table: 'running_timers',     column: 'project_id',           parent: 'projects' },
  { table: 'running_timers',     column: 'routine_id',           parent: 'routines' }
];

/**
 * Yksikasitteisyysrajoitteet, sellaisina kuin migraatiot ne luovat.
 *
 * MIKSI TAMA ON TAALLA
 *
 * Tekokanta ei mallintanut naita lainkaan, ja siksi se ei toistanut
 * tuotannon kayttaytymista. E4 meni tekokannassa lapi ja tuotannossa
 * kaatui koodilla 23505: rajoite on `unique (routine_id, date)` —
 * RUTIINIkohtainen, ei kayttajakohtainen — ja E1 oli jo varannut parin
 * (A:n rutiini, today).
 *
 * Simulaatio, joka ei tunne rajoitetta, ei voi ennustaa sita vastaan
 * kaatuvaa lausetta. Nyt se tuntee.
 */
const YKSIKASITTEISYYDET = [
  { table: 'routine_exceptions', columns: ['routine_id', 'date'] },
  { table: 'wellbeing_entries',  columns: ['user_id', 'date'] },
  // 0011–0013. Näitä vastaan hyväksyntätestin rivit on rakennettu
  // (vuoden 1990 maanantait, ajosta johdetut nimet ja avaimet, yksi
  // ajastin): jos tekokanta ei tuntisi niitä, rakenteen virhe näkyisi
  // vasta tuotannossa kuten E4:n 23505.
  { table: 'notices',                 columns: ['user_id', 'notice_key'] },
  { table: 'life_areas',              columns: ['user_id', 'name'] },
  { table: 'life_areas',              columns: ['user_id', 'category_key'] },
  { table: 'weekly_capacities',       columns: ['user_id', 'week_start'] },
  { table: 'alignment_reviews',       columns: ['user_id', 'week_start'] },
  { table: 'time_entries',            columns: ['user_id', 'operation_id'] },
  { table: 'running_timers',          columns: ['user_id'] },
  { table: 'alignment_item_settings', columns: ['user_id', 'item_kind', 'item_id'] }
];

/** Osuuko rivi olemassa olevaan yksikasitteisyysrajoitteeseen? */
function tarkistaYksikasitteisyys(db, table, row, omaOid) {
  for (const rajoite of YKSIKASITTEISYYDET) {
    if (rajoite.table !== table) continue;
    // SQL:n unique sallii useita NULL-arvoja: NULL ei ole yhtä kuin NULL.
    if (rajoite.columns.some(sarake => row[sarake] == null)) continue;
    const osuma = (db[table] || []).find(vanha =>
      vanha !== omaOid
      && rajoite.columns.every(sarake => vanha[sarake] === row[sarake]));
    if (osuma) {
      return { data: null, error: { code: '23505', message: 'duplicate key value' } };
    }
  }
  return null;
}

/**
 * Taulut, joiden `id` on UUID.
 *
 * MIKSI TAMA ON TAALLA
 *
 * T6-n-update ja T6-n-delete odottivat 42501:ta mutta saivat
 * tuotannossa 22P02:n: harness syotti merkkijonon
 * `manifestival_rls_acceptance_anon` uuid-sarakkeeseen, ja PostgreSQL
 * hylkasi arvon ennen kuin oikeustarkistus ehti tapahtua.
 *
 * Tekokanta on tyypiton JavaScript-olio, joten se hyvaksyi arvon
 * ilomielin — eika testi voinut nahda vikaa. Nyt se tarkistaa tyypin.
 */
const UUID_AVAIMELLISET = new Set(['profile', 'notification_preferences']);
const UUID_HAHMO = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TYYPPIVIRHE = arvo => ({
  data: null,
  error: { code: '22P02', message: `invalid input syntax for type uuid: "${arvo}"` }
});

/**
 * Yhdistelmavierasavainten tarkistus.
 *
 * Palauttaa virheen, jos rivi viittaa riviin jota ei ole TAI joka
 * kuuluu toiselle omistajalle.
 *
 * `compositeFkOff` matkii vikaa, jossa vierasavain olisi vain yhden
 * sarakkeen mittainen: viitattu rivi haetaan silloin pelkalla
 * tunnisteella, omistajaa katsomatta. Juuri niin oli ennen kuin
 * migraatiot korjattiin.
 */
function tarkistaViitteet(db, table, row, flaws) {
  for (const fk of YHDISTELMAVIERASAVAIMET) {
    if (fk.table !== table) continue;
    const arvo = row[fk.column];
    // MATCH SIMPLE: NULL-viite ohittaa tarkistuksen kokonaan.
    if (arvo == null) continue;

    // fkOff poistaa YHDEN nimetyn viitteen kerrallaan. Sita tarvitaan
    // sen todistamiseen, etta jokainen hyokkaystesti osuu OMAAN
    // vierasavaimeensa eika johonkin yhteiseen: jos kaikki kahdeksan
    // menisivat lapi saman tarkistuksen kautta, seitseman niista voisi
    // olla suojaamatta ilman etta yksikaan testi huomaisi.
    if (flaws.fkOff && flaws.fkOff.has(`${fk.table}.${fk.column}`)) continue;

    const kohde = (db[fk.parent] || []).find(parent =>
      parent.id === arvo
      && (flaws.compositeFkOff || parent.user_id === row.user_id));

    if (!kohde) {
      return { data: null, error: { code: '23503', message: 'foreign key violation' } };
    }
  }
  return null;
}

const PRIVILEGE_ERROR = code => ({
  data: null, error: { code, message: 'insufficient privilege' }
});

/**
 * Kyselynrakentaja, joka matkii supabase-js:n ketjutusta.
 * `.select()` tarkoittaa eri asiaa ennen ja jälkeen kirjoitusoperaation:
 * ensin se ON operaatio, sitten se pyytää muuttuneet rivit takaisin.
 */
class Query {
  constructor(server, table) {
    this.server = server;
    this.table = table;
    this.op = null;
    this.payload = null;
    this.filters = [];
    this.filterDescriptions = [];
    this.returning = false;
  }
  select() { if (this.op === null) this.op = 'select'; else this.returning = true; return this; }
  insert(row) { this.op = 'insert'; this.payload = row; return this; }
  upsert(row) { this.op = 'upsert'; this.payload = row; return this; }
  update(patch) { this.op = 'update'; this.payload = patch; return this; }
  delete() { this.op = 'delete'; return this; }
  eq(column, value) {
    this.filterDescriptions.push({ kind: 'eq', column, value });
    this.filters.push(row => row[column] === value);
    return this;
  }
  in(column, values) {
    // supabase-js:n `.in()`. Tekoclientin on tarjottava se, koska ajuri
    // kayttaa sita — muuten testi kaatuisi puuttuvaan metodiin eika
    // kertoisi mitaan RLS:sta.
    this.filterDescriptions.push({ kind: 'in', column, value: values });
    this.filters.push(row => values.includes(row[column]));
    return this;
  }
  like(column, pattern) {
    this.filterDescriptions.push({ kind: 'like', column, value: pattern });
    const expression = new RegExp(`^${String(pattern).replace(/%/g, '.*')}$`);
    this.filters.push(row => expression.test(String(row[column])));
    return this;
  }
  then(resolve, reject) {
    return Promise.resolve().then(() => this.server.execute(this)).then(resolve, reject);
  }
}

/**
 * Yksi client yhdelle identiteetille.
 * @param {object} db      jaettu tekokanta
 * @param {string|null} uid  auth.uid(), null = kirjautumaton
 * @param {object} flaws   mitkä politiikat ovat rikki
 */
function makeClient(db, uid, flaws = {}, ledger = null) {
  const server = {
    execute(query) {
      // Jokainen lause kirjataan. Ilman tata voitaisiin todeta vain
      // lopputulos — ei sita, MILLAISIA lauseita kantaan lahetettiin.
      // Vaarallinen lause voi olla vaaraton juuri talla datalla.
      if (ledger) {
        ledger.push({
          uid, table: query.table, op: query.op,
          filters: query.filterDescriptions.slice(),
          payload: query.payload
        });
      }
      // Verkkovirhe: EI ole RLS-kielto, ja ajurin on erotettava ne.
      if (flaws.transportFails && flaws.transportFails(query)) {
        return { data: null, error: { code: '08006', message: 'connection failure' } };
      }

      // TYYPPI ENNEN OIKEUKSIA — SUODATTIMEN ARVOLLE.
      //
      // UPDATE ja DELETE rakentavat WHERE-ehdon, jonka arvo on
      // muunnettava sarakkeen tyypiksi jo suunnitteluvaiheessa. Kelvoton
      // uuid kaatuu siihen ennen kuin oikeustarkistus ehtii tapahtua —
      // juuri niin kavi tuotannossa testeille T6-n-update ja
      // T6-n-delete.
      //
      // INSERTin payload tarkistetaan vasta oikeuksien JALKEEN, koska
      // tuotannossa anonin insert palautti 42501:n eika 22P02:ta.
      // Epasymmetria on havaittu, ei arvattu.
      if (UUID_AVAIMELLISET.has(query.table)) {
        for (const suodatin of query.filterDescriptions) {
          if (suodatin.column !== 'id') continue;
          const arvot = Array.isArray(suodatin.value) ? suodatin.value : [suodatin.value];
          for (const arvo of arvot) {
            if (!UUID_HAHMO.test(String(arvo))) return TYYPPIVIRHE(arvo);
          }
        }
      }

      // anon-roolilta on peruttu kaikki oikeudet, joten kysely ei yllä
      // RLS:ään asti — kanta hylkää sen oikeudettomana.
      if (!uid) {
        if (!flaws.anonAllowed) return PRIVILEGE_ERROR('42501');
        return { data: db[query.table].map(clone), error: null };
      }

      // profile on ainoa taulu, jossa omistajuus on id-sarakkeessa.
      // Kaikilla muilla se on user_id.
      const ownerColumn = OMISTAJA_ON_ID.has(query.table) ? 'id' : 'user_id';
      const owns = row => row[ownerColumn] === uid;
      const matches = row => query.filters.every(check => check(row));
      const rows = db[query.table];

      if (query.op === 'select') {
        const visible = rows.filter(row => (flaws.selectUsingOff || owns(row)) && matches(row));
        return { data: visible.map(clone), error: null };
      }

      if (query.op === 'insert' || query.op === 'upsert') {
        const row = { ...query.payload };
        // WITH CHECK: rivin omistajaksi ei voi kirjoittaa toista.
        if (ownerColumn in row && row[ownerColumn] !== uid && !flaws.withCheckOff) {
          return PRIVILEGE_ERROR('42501');
        }
        // Payload vasta oikeuksien jalkeen, ks. perustelu ylla.
        if (UUID_AVAIMELLISET.has(query.table)
            && row.id != null && !UUID_HAHMO.test(String(row.id))) {
          return TYYPPIVIRHE(row.id);
        }

        // DEFAULT auth.uid(): kanta asettaa omistajan, ei asiakas.
        if (!(ownerColumn in row)) row[ownerColumn] = uid;

        // YHDISTELMAVIERASAVAIN (user_id, routine_id) -> routines(user_id, id).
        //
        // Tarkistus EI kulje RLS:n lapi — se on kannan oma, ja juuri
        // siksi se on ainoa este ristiinkiinnitykselle. Jos parina
        // (omistaja, rutiini) ei loydy routines-taulusta, kanta hylkaa
        // rivin koodilla 23503.
        // JARJESTYS ON OSA VAITETTA.
        //
        // Kannassa lauseen kohtaa ensin RLS:n WITH CHECK, sitten
        // yksikasitteisyysindeksi ja vasta lopuksi vierasavaimen
        // liipaisin. Havaittu tuotannossa: E3c sai 42501:n (RLS torjui
        // ensin) ja E4 sai 23505:n (indeksi torjui ennen vierasavainta).
        //
        // Jos tama jarjestys olisi tekokannassa vaarin, E4 nayttaisi
        // menevan lapi eika kertoisi mitaan siita, mita tuotannossa
        // tapahtuu.
        const yksiVirhe = tarkistaYksikasitteisyys(db, query.table, row, null);
        if (yksiVirhe) return yksiVirhe;

        const viiteVirhe = tarkistaViitteet(db, query.table, row, flaws);
        if (viiteVirhe) return viiteVirhe;

        // ai_action_audit_confirmed_check: kirjaus ei saa vaittaa, etta
        // komento suoritettiin ilman vahvistusta.
        if (query.table === 'ai_action_audit'
            && row.executed === true && row.confirmed !== true
            && !flaws.checkConstraintOff) {
          return { data: null, error: { code: '23514', message: 'check violation' } };
        }

        const existing = rows.find(candidate => candidate.id === row.id);
        if (existing) {
          if (query.op === 'insert') return { data: null, error: { code: '23505', message: 'duplicate key' } };
          Object.assign(existing, row);
          return { data: query.returning ? [clone(existing)] : null, error: null };
        }
        rows.push(row);
        return { data: query.returning ? [clone(row)] : null, error: null };
      }

      if (query.op === 'update') {
        const targets = rows.filter(row => (flaws.updateUsingOff || owns(row)) && matches(row));

        // VIITTEET TARKISTETAAN MYOS UPDATESSA.
        //
        // INSERT ei ole ainoa tapa saada rivi osoittamaan toisen
        // kayttajan riviin: B voi ottaa OMAN rivinsa ja kaantaa
        // viitteen. Silloin rivi lapaisee seka USINGin etta WITH
        // CHECKin — omistaja ei muutu — ja vain vierasavain voi torjua
        // sen.
        //
        // Jos tama puuttuisi, tekokanta hyvaksyisi U1-U8 -hyokkaykset
        // ja testit menisivat lapi vaikka suoja olisi vain puolittainen.
        for (const row of targets) {
          const viiteVirhe = tarkistaViitteet(db, query.table,
            { ...row, ...query.payload }, flaws);
          if (viiteVirhe) return viiteVirhe;
        }

        for (const row of targets) {
          Object.assign(row, query.payload);
          // stampOnUpdate matkii kantaa, jossa on updated_at-liipaisin:
          // arvot sailyttava payload EI siis riita pitamaan rivia samana.
          if (flaws.stampOnUpdate) row.updated_at = '2026-09-05T12:00:00Z';
        }
        return { data: query.returning ? targets.map(clone) : null, error: null };
      }

      if (query.op === 'delete') {
        const targets = rows.filter(row => (flaws.deleteUsingOff || owns(row)) && matches(row));
        // deleteDrops matkii siivousta, joka epaonnistuu hiljaa: lause
        // menee lapi ilman virhetta mutta rivi jaa kantaan.
        const removed = flaws.deleteDrops
          ? targets.filter(row => !flaws.deleteDrops(row))
          : targets;
        for (const row of removed) rows.splice(rows.indexOf(row), 1);
        return { data: query.returning ? removed.map(clone) : null, error: null };
      }

      throw new Error(`tuntematon operaatio: ${query.op}`);
    }
  };

  return { from: table => new Query(server, table) };
}

/**
 * Aja ajuri tekokantaa vasten.
 *
 * `wave` puuttuu = ajurin oletus (0008, aalto E): 0009–0013:n tauluja ei
 * kosketa. Kolmas parametri valitsee aallon, kuten operaattori tekee.
 */
async function runAgainst(flaws = {}, mutate = null, { wave } = {}) {
  const db = makeDb();
  if (mutate) mutate(db);
  const ledger = [];
  const result = await runAcceptance({
    a: makeClient(db, OWNER_A, flaws, ledger),
    b: makeClient(db, USER_B, flaws, ledger),
    anon: makeClient(db, null, flaws, ledger),
    ownerAId: OWNER_A,
    userBId: USER_B,
    expectedTaskCount: TASK_COUNT,
    runId: 'testiajo',
    today: '2026-09-05',
    ...(wave === undefined ? {} : { wave })
  });
  return { ...result, db, ledger };
}

/** Tilin A alkuperaisten rivien tilannekuva vertailua varten. */
function snapshotOriginals(db) {
  return db.tasks
    .filter(taskRow => taskRow.id.startsWith('oikea-'))
    .map(taskRow => JSON.stringify(taskRow))
    .sort();
}

const byNumber = (rows, no) => rows.find(entry => entry.test_no === no);
const failing = rows => rows.filter(entry => entry.status === STATUS.FAIL).map(entry => entry.test_no);

// ---------------------------------------------------------------------
// Perustapaus
// ---------------------------------------------------------------------

test('ehjä RLS: jokainen tarkistus menee läpi', async () => {
  const { rows, summary } = await runAgainst();

  const notPassing = rows.filter(entry => entry.status !== STATUS.PASS);
  assert.deepEqual(notPassing.map(entry => `${entry.test_no}:${entry.status}:${entry.actual}`), [],
    'ehjällä kannalla ei saa olla yhtään muuta kuin PASS');
  assert.equal(summary.verdict, 'PASS');
  assert.equal(summary.fail, 0);
  assert.equal(summary.error, 0);
  assert.equal(summary.skip, 0);
});

test('ajo kattaa kaikki viisi vaadittua tapausta ja siivouksen', async () => {
  const { rows } = await runAgainst();
  const numbers = rows.map(entry => entry.test_no);

  // Jokaisesta ryhmästä on oltava vähintään yksi tarkistus. Jos joku
  // poistaa ryhmän kokonaan, testi kaatuu — pelkkä rivimäärä ei riittäisi.
  for (const prefix of ['P', 'T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'C']) {
    assert.ok(numbers.some(no => no.startsWith(prefix)),
      `ryhmä ${prefix} puuttuu ajosta kokonaan`);
  }

  // Molemmat suunnat on testattava. Yksisuuntainen eristys ei ole eristys.
  assert.ok(numbers.includes('T2d'), 'B ei näe A:n profiilia -tarkistus puuttuu');
  assert.ok(numbers.includes('T5e'), 'A ei poista B:n profiilia -tarkistus puuttuu');
});

test('siivous ei jätä yhtään merkittyä riviä eikä koske A:n oikeaan dataan', async () => {
  const db = makeDb();
  const before = db.tasks.map(row => row.id).sort();

  await runAcceptance({
    a: makeClient(db, OWNER_A),
    b: makeClient(db, USER_B),
    anon: makeClient(db, null),
    ownerAId: OWNER_A, userBId: USER_B,
    expectedTaskCount: TASK_COUNT, runId: 'siivous', today: '2026-09-05'
  });

  assert.deepEqual(db.tasks.map(row => row.id).sort(), before,
    'kanta ei palannut lähtötilaan');
  assert.equal(db.tasks.filter(row => row.id.startsWith(MARKER_PREFIX)).length, 0,
    'merkittyjä rivejä jäi kantaan');
  assert.equal(db.profile.length, 1, 'profiilirivejä jäi ylimääräisiä');
  assert.equal(db.profile[0].id, OWNER_A);
  assert.equal(db.profile[0].legacy_id, 'me', 'perumisen merkkipaalu katosi');
});

test('testin luomat tunnisteet on erotettavissa oikeista riveistä', () => {
  const ids = idsFor('abc');
  for (const value of Object.values(ids)) {
    assert.ok(value.startsWith(MARKER_PREFIX),
      `tunniste ${value} ei ole tunnistettavissa siivousta varten`);
  }
  // Neljäkymmentäkaksi eri riviä, ei törmäyksiä.
  //
  // Törmäys olisi pahempi kuin puuttuva tunniste: kaksi eri tarkoitusta
  // käyttäisi samaa riviä, ja toinen niistä testaisi jotain muuta kuin
  // mitä sen nimi lupaa. Siksi määrä lasketaan joukkona.
  //
  //    4  alkuperäiset (tasks, profile)
  //    7  migraatio 0003 (rutiinit ja poikkeukset)
  //   22  migraatiot 0004-0008 (kahdeksan taulua, A/B/väärennös)
  //    8  ristiinkiinnityshyökkäykset, yksi per yhdistelmävierasavain
  //    1  sallittu oma viite (X9)
  assert.equal(new Set(Object.values(ids)).size, 42);

  for (const avain of ['routineA', 'routineB', 'exceptionA', 'exceptionB',
                       'attackExceptionB',
                       'goalA', 'goalB', 'projectA', 'projectB',
                       'wellbeingA', 'expenseA', 'billA', 'savingsA', 'auditA',
                       'attackGoalParentB', 'attackGoalProjectB',
                       'attackProjectGoalB', 'attackTaskGoalB',
                       'attackTaskProjectB', 'attackRoutineGoalB',
                       'attackBillTaskB', 'attackBillExpenseB', 'ownLinkB']) {
    assert.ok(ids[avain], `tunniste ${avain} puuttuu`);
  }
});

// ---------------------------------------------------------------------
// MUTAATIOT: jokainen rikkinäinen politiikka on huomattava
// ---------------------------------------------------------------------

test('MUTAATIO: SELECT-politiikan USING pois — lukukielto pettää', async () => {
  const { rows, summary } = await runAgainst({ selectUsingOff: true });

  assert.equal(summary.verdict, 'FAIL');
  for (const no of ['T2a', 'T2b', 'T2c', 'T2d']) {
    assert.equal(byNumber(rows, no).status, STATUS.FAIL,
      `${no} ei huomannut, että B näkee A:n datan`);
  }
});

test('MUTAATIO: INSERTin WITH CHECK pois — B voi kirjoittaa A:n nimiin', async () => {
  const { rows, summary } = await runAgainst({ withCheckOff: true });

  assert.equal(summary.verdict, 'FAIL');
  assert.equal(byNumber(rows, 'T3d').status, STATUS.FAIL,
    'väärennetty omistaja meni läpi eikä testi huomannut');
});

test('MUTAATIO: UPDATEn USING pois — vieras rivi on muokattavissa', async () => {
  const { rows, summary } = await runAgainst({ updateUsingOff: true });

  assert.equal(summary.verdict, 'FAIL');
  assert.equal(byNumber(rows, 'T3a').status, STATUS.FAIL, 'B sai muuttaa A:n riviä');
  assert.equal(byNumber(rows, 'T5c').status, STATUS.FAIL, 'A sai muuttaa B:n riviä');
  assert.equal(byNumber(rows, 'T3c').status, STATUS.FAIL, 'B sai kirjoittaa A:n profiiliin');
});

test('MUTAATIO: DELETEn USING pois — vieras rivi on poistettavissa', async () => {
  const { rows, summary } = await runAgainst({ deleteUsingOff: true });

  assert.equal(summary.verdict, 'FAIL');
  assert.equal(byNumber(rows, 'T3b').status, STATUS.FAIL, 'B sai poistaa A:n rivin');
  assert.equal(byNumber(rows, 'T5d').status, STATUS.FAIL, 'A sai poistaa B:n rivin');
  assert.equal(byNumber(rows, 'T5e').status, STATUS.FAIL, 'A sai poistaa B:n profiilin');
});

test('MUTAATIO: anonilta ei olekaan peruttu oikeuksia', async () => {
  const { rows, summary } = await runAgainst({ anonAllowed: true });

  assert.equal(summary.verdict, 'FAIL');
  assert.equal(byNumber(rows, 'T6a').status, STATUS.FAIL, 'kirjautumaton sai lukea tehtävät');
  assert.equal(byNumber(rows, 'T6b').status, STATUS.FAIL, 'kirjautumaton sai lukea profiilin');
});

test('MUTAATIO: edellisen ajon rivi kannassa — ajo pysähtyy heti', async () => {
  const { rows, summary } = await runAgainst({}, db => {
    db.tasks.push({ id: `${MARKER_PREFIX}vanha-ajo`, date: '2026-09-01', title: 'x', user_id: OWNER_A });
  });

  assert.equal(byNumber(rows, 'P0').status, STATUS.FAIL, 'jäännösriviä ei huomattu');
  assert.equal(summary.verdict, 'FAIL');
  assert.ok(summary.aborted, 'ajoa ei keskeytetty, vaikka siivous ei olisi ollut yksiselitteinen');
  // Mitään testirivejä ei saa luoda, kun lähtötila on epäselvä.
  assert.equal(rows.some(entry => entry.test_no.startsWith('T')), false,
    'varsinaisia testejä ajettiin epäselvästä lähtötilasta');
});

test('MUTAATIO: väärä rivimäärä lähtötilassa — ajo pysähtyy', async () => {
  const { rows, summary } = await runAgainst({}, db => { db.tasks.pop(); });

  assert.equal(byNumber(rows, 'P1').status, STATUS.FAIL);
  assert.equal(summary.verdict, 'FAIL');
  assert.ok(summary.aborted);
});

// ---------------------------------------------------------------------
// Virhe ei ole hyväksytty tulos
// ---------------------------------------------------------------------

test('KRIITTINEN: verkkovirhe raportoidaan ERRORina, ei PASSina', async () => {
  // Tämä on koko ajurin vaarallisin virhemahdollisuus. Kieltotestin
  // odotus on "nolla riviä". Katkennut yhteys palauttaa myös nolla riviä.
  // Jos niitä ei eroteta, täysin toimimaton verkko näyttäisi
  // täydelliseltä tietoturvalta.
  const { rows, summary } = await runAgainst({
    transportFails: query => query.table === 'profile'
  });

  assert.ok(summary.error > 0, 'yhtäkään virhettä ei raportoitu');
  assert.equal(summary.verdict, 'FAIL', 'virheellinen ajo hyväksyttiin');

  for (const no of ['T2d', 'T5b']) {
    assert.equal(byNumber(rows, no).status, STATUS.ERROR,
      `${no}: katkennut yhteys tulkittiin RLS-kielloksi`);
  }
  assert.equal(failing(rows).includes('T2d'), false,
    'virhe luokiteltiin FAILiksi — silloin syytä ei erottaisi');
});

test('KRIITTINEN: yksikään PASS ei synny virheellisestä vastauksesta', async () => {
  for (const flaws of [
    { transportFails: () => true },
    { transportFails: query => query.table === 'tasks' },
    { transportFails: query => query.op === 'delete' }
  ]) {
    const { rows } = await runAgainst(flaws);
    for (const entry of rows) {
      if (entry.status !== STATUS.PASS) continue;
      assert.equal(/^(POIKKEUS|08006)/.test(entry.actual), false,
        `${entry.test_no} raportoi PASSin virheestä: ${entry.actual}`);
    }
  }
});

test('KRIITTINEN: poikkeus clientistä ei karkaa raportin ohi', async () => {
  const db = makeDb();
  const rikkinainen = {
    from() { throw new Error('client hajosi'); }
  };

  const { rows, summary } = await runAcceptance({
    a: rikkinainen,
    b: makeClient(db, USER_B),
    anon: makeClient(db, null),
    ownerAId: OWNER_A, userBId: USER_B,
    expectedTaskCount: TASK_COUNT, runId: 'poikkeus', today: '2026-09-05'
  });

  assert.equal(summary.verdict, 'FAIL');
  assert.equal(byNumber(rows, 'P0').status, STATUS.ERROR);
  assert.match(byNumber(rows, 'P0').actual, /POIKKEUS/);
});

// ---------------------------------------------------------------------
// Ajuri kieltäytyy merkityksettömästä ajosta
// ---------------------------------------------------------------------

test('sama tili kahdesti ei kelpaa testiksi', async () => {
  const db = makeDb();
  await assert.rejects(() => runAcceptance({
    a: makeClient(db, OWNER_A), b: makeClient(db, OWNER_A), anon: makeClient(db, null),
    ownerAId: OWNER_A, userBId: OWNER_A,
    expectedTaskCount: TASK_COUNT, runId: 'sama', today: '2026-09-05'
  }), /sama tili/);
});

test('puuttuva client tai tunniste keskeyttää ennen yhtäkään kyselyä', async () => {
  const db = makeDb();
  const base = {
    a: makeClient(db, OWNER_A), b: makeClient(db, USER_B), anon: makeClient(db, null),
    ownerAId: OWNER_A, userBId: USER_B,
    expectedTaskCount: TASK_COUNT, runId: 'puute', today: '2026-09-05'
  };

  await assert.rejects(() => runAcceptance({ ...base, anon: null }), /client/);
  await assert.rejects(() => runAcceptance({ ...base, userBId: '' }), /tunniste/);
  await assert.rejects(() => runAcceptance({ ...base, runId: '' }), /ajotunnus/);
});

// ---------------------------------------------------------------------
// Raportti
// ---------------------------------------------------------------------

test('raportti on yhdellä kopioinnilla siirtyvä taulukko', async () => {
  const { rows, summary } = await runAgainst();
  const report = formatReport(rows, summary);

  for (const column of ['test_no', 'test_name', 'status', 'expected', 'actual', 'details']) {
    assert.ok(report.includes(column), `raportista puuttuu sarake ${column}`);
  }
  assert.ok(report.includes('TULOS: PASS'), 'kokonaistulos puuttuu raportista');
  // Yksi rivi otsikoille, yksi erottimelle, yksi per tarkistus.
  const tableLines = report.split('\n').filter(line => line.startsWith('|'));
  assert.equal(tableLines.length, rows.length + 2);
});

test('putkimerkki solussa ei riko taulukkoa', () => {
  const report = formatReport([{
    test_no: 'X', test_name: 'a|b', status: 'PASS',
    expected: 'c|d', actual: 'e', details: ''
  }], null);

  const cells = report.split('\n')[2].split(/(?<!\\)\|/).slice(1, -1);
  assert.equal(cells.length, 6, 'solujen määrä muuttui pakenemattoman putken takia');
});

// ---------------------------------------------------------------------
// Sivuvaikutukset: mitä ajo tekee kannalle
// ---------------------------------------------------------------------

test('KRIITTINEN: tilin A alkuperäinen data säilyy muuttumattomana kaikissa vikatiloissa', async () => {
  // Tämä on koko työkalun ehto olemassaololle. Hyväksyntätesti, joka
  // voi rikkoa sen datan jota sen on määrä suojella, on huonompi kuin
  // ei testiä lainkaan — se tekee vahingon juuri silloin kun RLS on
  // rikki, eli silloin kun kaikki on jo pielessä.
  //
  // Siksi tätä ei riitä todeta onnistuneella ajolla. Se on todettava
  // JOKAISESSA vikatilassa, myös niissä joissa kaikki kiellot pettävät
  // yhtä aikaa.
  const vikatilat = [
    ['ehjä kanta', {}],
    ['SELECT auki', { selectUsingOff: true }],
    ['UPDATE auki', { updateUsingOff: true }],
    ['DELETE auki', { deleteUsingOff: true }],
    ['WITH CHECK auki', { withCheckOff: true }],
    ['anon auki', { anonAllowed: true }],
    ['kaikki auki', {
      selectUsingOff: true, updateUsingOff: true,
      deleteUsingOff: true, withCheckOff: true, anonAllowed: true
    }],
    ['yhteys katkeilee', { transportFails: query => query.op === 'delete' }]
  ];

  for (const [nimi, flaws] of vikatilat) {
    const ennen = snapshotOriginals(makeDb());
    const ennenProfiili = JSON.stringify(makeDb().profile);

    const { db } = await runAgainst(flaws);

    assert.deepEqual(snapshotOriginals(db), ennen,
      `${nimi}: tilin A alkuperäiset tehtävät muuttuivat`);
    assert.equal(JSON.stringify(db.profile.filter(p => p.id === OWNER_A)), ennenProfiili,
      `${nimi}: tilin A profiili muuttui`);
  }
});

test('KRIITTINEN: A:n profiilin koskemattomuus todetaan, ei oleteta', async () => {
  // T3c on ainoa kirjoitusyritys tilin A oikeaan riviin. Sen turvallisuus
  // perustuu siihen, että payload on rivin nykyiset arvot — mutta se on
  // päättelyä, ja päättely on juuri se, mitä tämä työkalu on olemassa
  // korvaamaan. T3f tarkistaa asian kannasta.
  const ehja = await runAgainst();
  assert.equal(byNumber(ehja.rows, 'T3f').status, STATUS.PASS);

  // Ja tarkistus on aito: jos profiiliin oikeasti kirjoitettaisiin muuta,
  // T3f huomaisi sen. Rikotaan UPDATEn USING ja muutetaan payloadia
  // matkimalla kantaa, joka lisää oman aikaleimansa jokaiseen riviin.
  const { rows } = await runAgainst({
    updateUsingOff: true,
    stampOnUpdate: true
  });
  assert.equal(byNumber(rows, 'T3f').status, STATUS.FAIL,
    'profiilin muuttuminen jäi huomaamatta');
  assert.match(byNumber(rows, 'T3f').actual, /muuttuneet sarakkeet/);
});

test('KRIITTINEN: yksikään muuttava lause ei ole rajaamaton', async () => {
  // Rajaamaton `delete from tasks` on juuri se lause, joka tyhjentäisi
  // tuotannon. Lopputuloksen tarkistaminen ei riitä: lause voi olla
  // vaaraton juuri tällä testidatalla ja tuhoisa oikealla. Siksi
  // tarkistetaan lauseet, ei vain niiden jäljet.
  const { ledger } = await runAgainst();

  const muuttavat = ledger.filter(entry => entry.op === 'update' || entry.op === 'delete');
  assert.ok(muuttavat.length >= 6, 'muuttavia lauseita oli epäilyttävän vähän');

  for (const entry of muuttavat) {
    assert.ok(entry.filters.length >= 1,
      `rajaamaton ${entry.op} tauluun ${entry.table}`);

    // like-ehto on ainoa tapa osua useaan riviin kerralla. Sen on aina
    // oltava sidottu hyväksyntätestin nimiavaruuteen.
    for (const filter of entry.filters) {
      if (filter.kind !== 'like') continue;
      assert.ok(String(filter.value).startsWith(MARKER_PREFIX),
        `${entry.op}: like-ehto "${filter.value}" ei ole sidottu etuliitteeseen`);
    }
  }
});

test('KRIITTINEN: siivous ei koske riveihin, joilla ei ole etuliitettä', async () => {
  // Etuliitteen ja oikean tehtävätunnisteen törmäys tarkoittaisi
  // käyttäjän datan poistamista. Tässä kannassa on tarkoituksella rivi,
  // jonka tunniste muistuttaa etuliitettä mutta ei ala sillä.
  const { db } = await runAgainst({}, database => {
    database.tasks.push({
      id: 'oikea-manifestival_rls_acceptance_ei_ala_talla',
      date: '2026-09-05', title: 'ei saa kadota', user_id: OWNER_A
    });
  });

  assert.ok(
    db.tasks.some(taskRow => taskRow.id === 'oikea-manifestival_rls_acceptance_ei_ala_talla'),
    'siivous poisti rivin, jonka tunniste vain muistutti etuliitettä');
});

// ---------------------------------------------------------------------
// Siivouksen epäonnistuminen
// ---------------------------------------------------------------------

test('MUTAATIO: siivous ei poista mitään — jäännös näkyy raportissa', async () => {
  // Siivous, joka epäonnistuu hiljaa, on pahempi kuin siivous jota ei
  // ole: operaattori poistaisi tilin B luullen kannan olevan puhdas.
  const { rows, summary, db } = await runAgainst({
    deleteDrops: row => String(row.id).startsWith(MARKER_PREFIX)
  });

  assert.equal(summary.verdict, 'FAIL');
  assert.equal(byNumber(rows, 'C9').status, STATUS.FAIL, 'A ei huomannut jäännöstä');
  assert.equal(byNumber(rows, 'C10').status, STATUS.FAIL, 'B ei huomannut jäännöstä');
  assert.equal(byNumber(rows, 'C8').status, STATUS.FAIL, 'rivimäärä ei palannut lähtöarvoon');

  // Ja jäännös on oikeasti kannassa — testi ei kaadu väärästä syystä.
  assert.ok(db.tasks.some(taskRow => taskRow.id.startsWith(MARKER_PREFIX)));
});

test('MUTAATIO: siivous onnistuu vain osittain — sekin näkyy', async () => {
  // Osittainen epäonnistuminen on vaarallisin muoto: viisi kuudesta
  // siivousriviä on PASS, ja pelkkää yhteenvetoa vilkaiseva lukisi sen
  // onnistumiseksi. Kokonaistuloksen on oltava FAIL.
  const { rows, summary } = await runAgainst({
    deleteDrops: row => String(row.id).endsWith('_b_keep')
  });

  assert.equal(summary.verdict, 'FAIL');
  assert.equal(byNumber(rows, 'C10').status, STATUS.FAIL,
    'B:n jäljelle jäänyttä riviä ei huomattu');
  assert.equal(byNumber(rows, 'C9').status, STATUS.PASS,
    'A ei näe B:n riviä — juuri siksi kumpikin tili tarkistetaan erikseen');
});

test('siivous ajetaan myös silloin, kun kielto on pettänyt', async () => {
  // Epäonnistunut ajo on juuri se tilanne, jossa siivous unohtuisi.
  const { db } = await runAgainst({ selectUsingOff: true, updateUsingOff: true });

  assert.equal(db.tasks.filter(taskRow => taskRow.id.startsWith(MARKER_PREFIX)).length, 0,
    'testirivejä jäi kantaan epäonnistuneen ajon jälkeen');
  assert.equal(db.profile.length, 1, 'B:n profiili jäi kantaan');
});

test('siivous poistaa myös rivin, jonka B väärensi tilin A nimiin', async () => {
  // Jos WITH CHECK pettää, B luo rivin jonka omistaja on A. B ei näe
  // sitä eikä siis voi siivota sitä. Vain A voi — ja siksi A:n siivous
  // on sidottu etuliitteeseen eikä pelkkään syöttirivin tunnisteeseen.
  const { db, rows } = await runAgainst({ withCheckOff: true });

  assert.equal(byNumber(rows, 'T3d').status, STATUS.FAIL, 'väärennös ei edes huomattu');
  assert.equal(db.tasks.filter(taskRow => taskRow.id.startsWith(MARKER_PREFIX)).length, 0,
    'väärennetty rivi jäi kantaan');
  assert.equal(byNumber(rows, 'C9').status, STATUS.PASS);
});

// ---------------------------------------------------------------------
// Yhteensopivuus todellisen tuotantoskeeman kanssa
// ---------------------------------------------------------------------

test('KRIITTINEN: testirivit kirjoittavat vain sarakkeita, jotka ovat oikeasti olemassa', () => {
  // Hyväksyntätesti ajetaan tuotantoa vasten kerran. Jos se kirjoittaa
  // sarakkeeseen jota ei ole, ajo kaatuu heti ensimmäiseen lauseeseen —
  // ja se tapahtuu vasta silloin kun väliaikainen tili on jo luotu ja
  // operaattori odottaa tulosta.
  //
  // Tuotannossa on migraatio 0001 mutta EI 0002:ta, joten laajennetut
  // sarakkeet (description, duration_minutes, priority,
  // scheduling_state) eivät ole olemassa. Siksi vertailukohta on
  // nimenomaan TASK_COLUMNS_CORE eikä TASK_COLUMNS_EXTENDED.
  const kirjoitetut = Object.keys(taskRow('x', '2026-09-05', 'y'));

  assert.ok(kirjoitetut.length > 0);
  for (const sarake of kirjoitetut) {
    assert.ok(TASK_COLUMNS_CORE.includes(sarake),
      `taskRow kirjoittaa saraketta ${sarake}, jota tuotannossa ei ole ennen migraatiota 0002`);
  }
});

test('KRIITTINEN: testirivi ei koskaan lähetä omistajuutta', () => {
  // Sama sääntö kuin sovelluksella: omistajuuden asettaa kanta
  // (DEFAULT auth.uid()). Jos ajuri lähettäisi user_id:n omissa
  // riveissään, se testaisi eri asiaa kuin sovellus tekee — ja T4a
  // näyttäisi PASSin vaikka DEFAULT olisi kadonnut.
  //
  // Ainoa poikkeus on T3d, joka lähettää user_id:n TAHALLAAN
  // todistaakseen että WITH CHECK hylkää sen.
  const kirjoitetut = Object.keys(taskRow('x', '2026-09-05', 'y'));

  for (const kielletty of SERVER_OWNED_FIELDS) {
    assert.equal(kirjoitetut.includes(kielletty), false,
      `taskRow lähettää palvelimen omistaman kentän ${kielletty}`);
  }
});

test('KRIITTINEN: profiilin testirivi käyttää sovelluksen omia sarakkeita', () => {
  // Sarakelista luetaan sovelluksen koodista, ei kirjoiteta tähän
  // käsin. Käsin kirjoitettu lista vanhenisi huomaamatta.
  const profileToRow = /export function profileToRow[\s\S]*?\n}/.exec(read('src/data/profileRepo.js'));
  assert.ok(profileToRow, 'profileToRow ei löytynyt sovelluksesta');

  const sovelluksenSarakkeet = [...profileToRow[0].matchAll(/^\s{4}(\w+):/gm)].map(m => m[1]);
  assert.ok(sovelluksenSarakkeet.includes('id'), 'sarakkeiden poiminta epäonnistui');

  for (const sarake of Object.keys(profileRow('jokin-tunniste'))) {
    assert.ok(sovelluksenSarakkeet.includes(sarake),
      `profileRow kirjoittaa saraketta ${sarake}, jota sovellus ei tunne`);
  }
});

test('KRIITTINEN: ajuri ei simuloi tunnistautumista vaan käyttää annettuja istuntoja', () => {
  // Jos ajuri asettaisi auth.uid():n itse (esim. set local role tai
  // request.jwt.claims), se testaisi politiikan lauseketta muttei
  // JWT:n todennusta, anon-avainta eikä PostgRESTin roolinvaihtoa.
  // Silloin GRANT-tason vika jäisi näkymättä kokonaan.
  // readCode riisuu kommentit. Tarpeen, koska tiedoston alussa
  // selitetään nimenomaan se, MIKSI näitä keinoja ei käytetä —
  // ja pelkkä sisältyvyystarkistus kaatuisi selitykseen.
  const runner = readCode('tools/rls-acceptance/acceptance.js');

  for (const kielletty of ['set local role', 'request.jwt.claims', 'set_config', 'rpc(']) {
    assert.equal(runner.includes(kielletty), false,
      `ajuri simuloi tunnistautumista: ${kielletty}`);
  }

  // Identiteetit tulevat parametreina, eivät ajurin sisältä.
  assert.match(runner, /const \{ a, b, anon, ownerAId, userBId/,
    'ajuri ei ota istuntoja parametreina');
  assert.equal(readCode('tools/rls-acceptance/main.js').includes('signInWithPassword'), true,
    'istunnot on saatava oikealla kirjautumisella');
});

// ---------------------------------------------------------------------
// Turvarajat lähdekoodissa
// ---------------------------------------------------------------------

const TOOL_FILES = [
  'tools/rls-acceptance/acceptance.js',
  'tools/rls-acceptance/main.js',
  'tools/rls-acceptance/index.html'
];

test('TURVA: hyväksyntätyökalussa ei ole service_rolea', () => {
  // service_role ohittaa RLS:n kokonaan. Sen läsnäolo tekisi koko
  // testistä merkityksettömän: jokainen kielto menisi läpi.
  for (const file of TOOL_FILES) {
    const source = read(file);
    assert.equal(source.includes('service_role'), false, `service_role tiedostossa ${file}`);
    assert.equal(/eyJ[A-Za-z0-9_-]{20,}/.test(source), false,
      `${file} sisältää kovakoodatun JWT:n — avain kuuluu config.js:ään`);
  }
});

test('TURVA: työkalu käyttää sovelluksen omaa julkista anon-avainta', () => {
  const main = read('tools/rls-acceptance/main.js');
  assert.match(main, /from '\.\.\/\.\.\/src\/data\/config\.js'/,
    'avain ja osoite on haettava samasta paikasta kuin sovelluksessa');
  assert.ok(main.includes('SUPABASE_ANON_KEY'), 'anon-avainta ei käytetä');
  assert.ok(SUPABASE_ANON_KEY.length > 0);
});

test('TURVA: työkalu ei tallenna salasanoja', () => {
  const main = read('tools/rls-acceptance/main.js');
  // Kentät tyhjennetään heti kirjautumisen jälkeen.
  assert.match(main, /passwordA'\)\.value = ''/, 'tilin A salasanaa ei tyhjennetä');
  assert.match(main, /passwordB'\)\.value = ''/, 'tilin B salasanaa ei tyhjennetä');
  for (const forbidden of ['localStorage', 'sessionStorage', 'console.log']) {
    assert.equal(main.includes(forbidden), false, `${forbidden} työkalussa`);
  }
});

test('TURVA: työkalu kieltäytyy ajamasta muualta kuin paikallisesti', () => {
  // Sivu kirjaa sisään oikeita tuotantotilejä. Julkaistuna se olisi
  // valmis kirjautumislomake väärässä paikassa.
  const main = read('tools/rls-acceptance/main.js');
  assert.ok(main.includes('localhost'), 'paikallisuustarkistus puuttuu');
  assert.match(main, /isLocal\(\)/, 'paikallisuutta ei tarkisteta ajon alussa');

  const ignore = read('.vercelignore');
  assert.match(ignore, /^tools\/$/m, 'tools/ ei ole suljettu pois julkaisusta');
});

test('työkalun sivu ei sisällä inline-skriptejä', () => {
  // Sama sääntö kuin sovelluksen rungolla: logiikka on moduuleissa,
  // jotta se on testattavissa.
  const html = read('tools/rls-acceptance/index.html');
  const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>/g)];
  assert.deepEqual(inline.map(match => match[0]), []);
});

// =====================================================================
// MIGRAATION 0003 TAULUT — rutiinit ja poikkeukset
// =====================================================================

test('ehjä RLS: rutiinien ja poikkeusten koko matriisi menee läpi', async () => {
  const { rows } = await runAgainst();
  const numerot = rows.map(e => e.test_no);

  // R1-R5 ja E1-E6 ovat kaikki mukana.
  for (const alku of ['R1', 'R2', 'R3', 'R4', 'R5',
                      'E1', 'E2', 'E3', 'E4', 'E5', 'E6']) {
    assert.ok(numerot.some(no => no.startsWith(alku)),
      `tapausryhmä ${alku} puuttuu ajosta`);
  }

  for (const entry of rows.filter(e => /^[RE]\d/.test(e.test_no))) {
    assert.equal(entry.status, STATUS.PASS,
      `${entry.test_no} (${entry.test_name}): ${entry.status} — ${entry.actual}`);
  }
});

test('KRIITTINEN: ristiinkiinnitys A:n rutiiniin torjutaan vierasavaimella', async () => {
  // E4 on koko osuuden tärkein testi. RLS ei estä sitä: B:n rivin
  // omistaja on oikein — B. Ainoa este on yhdistelmävierasavain.
  const { rows } = await runAgainst();
  const e4 = byNumber(rows, 'E4');

  assert.ok(e4, 'E4 puuttuu kokonaan');
  assert.equal(e4.status, STATUS.PASS, `E4: ${e4.actual}`);
  assert.match(e4.actual, /23503/,
    'E4 hyväksyttiin väärällä koodilla — vain vierasavainvirhe todistaa väitteen');
});

test('MUTAATIO: yhdistelmävierasavain pois — ristiinkiinnitys onnistuisi', async () => {
  // Jos vierasavain olisi pelkkä routine_id, B voisi kiinnittää
  // poikkeuksensa A:n rutiiniin. Rivi ei näkyisi A:lle, mutta se
  // viittaisi toisen ihmisen dataan.
  const { rows, summary } = await runAgainst({ compositeFkOff: true });

  assert.equal(byNumber(rows, 'E4').status, STATUS.FAIL,
    'ristiinkiinnitys meni läpi eikä testi huomannut');
  assert.equal(summary.verdict, 'FAIL');
});

test('MUTAATIO: SELECT-politiikka auki — B näkee A:n rutiinit ja poikkeukset', async () => {
  const { rows, summary } = await runAgainst({ selectUsingOff: true });

  assert.equal(summary.verdict, 'FAIL');
  for (const no of ['R2a', 'R2b', 'E2a', 'E2b']) {
    assert.equal(byNumber(rows, no).status, STATUS.FAIL,
      `${no} ei huomannut, että B näkee A:n datan`);
  }
});

test('MUTAATIO: UPDATE-politiikka auki — vieras rutiini on muokattavissa', async () => {
  const { rows, summary } = await runAgainst({ updateUsingOff: true });

  assert.equal(summary.verdict, 'FAIL');
  for (const no of ['R3a', 'R3d', 'R5b']) {
    assert.equal(byNumber(rows, no).status, STATUS.FAIL, `${no} ei huomannut vuotoa`);
  }

  // POIKKEUSTASON TARKISTUKSET EIVÄT VÄLTTÄMÄTTÄ OLE FAIL — ja se on
  // oikein. R3d onnistuu tässä vikatilassa, eli B siirtää A:n rutiinin
  // omistajuuden itselleen. Sen jälkeen A ei voi enää luoda poikkeusta
  // omaan rutiiniinsa: yhdistelmävierasavain ei löydä paria (A, rutiini).
  // E-tason tarkistukset ohittuvat, koska niiden edellytys tuhoutui.
  //
  // Vaatimus on siis "ei PASS": läpimeno tarkoittaisi, että kielto
  // näytti pitävän vaikka politiikka oli auki.
  for (const no of ['E3a', 'E6b']) {
    assert.notEqual(byNumber(rows, no).status, STATUS.PASS,
      `${no} raportoi PASSin vaikka UPDATE-politiikka oli auki`);
  }
});

test('MUTAATIO: DELETE-politiikka auki — vieras rutiini on poistettavissa', async () => {
  const { rows, summary } = await runAgainst({ deleteUsingOff: true });

  assert.equal(summary.verdict, 'FAIL');
  for (const no of ['R3b', 'R5c']) {
    assert.equal(byNumber(rows, no).status, STATUS.FAIL, `${no} ei huomannut vuotoa`);
  }

  // Sama kaskadi kuin yllä: R3b poistaa A:n rutiinin, jolloin A:n
  // poikkeusta ei voi enää luoda eikä E-tason kieltoja päästä
  // kokeilemaan. Ohitus on rehellinen tulos, läpimeno ei olisi.
  for (const no of ['E3b', 'E6c']) {
    assert.notEqual(byNumber(rows, no).status, STATUS.PASS,
      `${no} raportoi PASSin vaikka DELETE-politiikka oli auki`);
  }
});

test('MUTAATIO: WITH CHECK auki — B voi luoda rivin A:n nimiin', async () => {
  const { rows, summary } = await runAgainst({ withCheckOff: true });

  assert.equal(summary.verdict, 'FAIL');
  assert.equal(byNumber(rows, 'R3c').status, STATUS.FAIL, 'rutiinin väärennös meni läpi');
  assert.equal(byNumber(rows, 'E3c').status, STATUS.FAIL, 'poikkeuksen väärennös meni läpi');
});

test('MUTAATIO: anonilla on oikeuksia uusiin tauluihin', async () => {
  const { rows, summary } = await runAgainst({ anonAllowed: true });

  assert.equal(summary.verdict, 'FAIL');
  for (const no of ['T6-r-select', 'T6-e-select']) {
    assert.equal(byNumber(rows, no).status, STATUS.FAIL,
      `${no}: kirjautumaton pääsi tauluun`);
  }
});

test('KRIITTINEN: siivous tyhjentää molemmat uudet taulut', async () => {
  const { db, rows } = await runAgainst();

  assert.deepEqual(db.routines, [], 'rutiineja jäi kantaan');
  assert.deepEqual(db.routine_exceptions, [], 'poikkeuksia jäi kantaan');

  for (const no of ['C11-r', 'C11-e', 'C12-r', 'C12-e']) {
    assert.equal(byNumber(rows, no).status, STATUS.PASS,
      `${no}: jäännöstarkistus ei mennyt läpi`);
  }
});

test('MUTAATIO: siivous jättää rutiinin — molemmat tilit tarkistavat erikseen', async () => {
  // A:n puhdas näkymä ei kerro mitään siitä, jäikö B:lle jotain: RLS
  // piilottaa toisen rivit. Siksi jäännös tarkistetaan kummallakin.
  const { rows, summary } = await runAgainst({
    deleteDrops: taulu => String(taulu.id).endsWith('_b_routine')
  });

  assert.equal(summary.verdict, 'FAIL');
  assert.equal(byNumber(rows, 'C12-r').status, STATUS.FAIL,
    'B:n jäljelle jäänyttä rutiinia ei huomattu');
  assert.equal(byNumber(rows, 'C11-r').status, STATUS.PASS,
    'A ei näe B:n rutiinia — juuri siksi molemmat tarkistetaan');
});

test('KRIITTINEN: rutiinien testirivit kirjoittavat vain sovelluksen sarakkeita', async () => {
  // Työkalu puhuu kannalle suoraan, joten se voisi kirjoittaa
  // sarakkeisiin joihin sovellus ei koskaan koske. Silloin se testaisi
  // eri asiaa kuin mitä tuotannossa tapahtuu.
  const { routinesRepo, routineExceptionsRepo } = await import('../src/data/collectionsRepo.js');
  const { normalizeRoutine, normalizeException } = await import('../src/domain/routine.js');

  const rutiini = routineRow('x', 'otsikko');
  const sovelluksenRutiini = routinesRepo.mapping.toRow(normalizeRoutine({
    id: 'x', title: 'otsikko', recurrence: { type: 'daily', weekdays: [] }
  }));
  assert.deepEqual(Object.keys(rutiini).sort(), Object.keys(sovelluksenRutiini).sort(),
    'rutiinin testirivi ei vastaa sovelluksen kirjoittamia sarakkeita');

  const poikkeus = exceptionRow('x', 'r', '2026-09-07');
  const sovelluksenPoikkeus = routineExceptionsRepo.mapping.toRow(normalizeException({
    id: 'x', routineId: 'r', date: '2026-09-07', type: 'skip'
  }));
  assert.deepEqual(Object.keys(poikkeus).sort(), Object.keys(sovelluksenPoikkeus).sort(),
    'poikkeuksen testirivi ei vastaa sovelluksen kirjoittamia sarakkeita');

  // Eikä kumpikaan lähetä palvelimen omistamia kenttiä.
  for (const [nimi, rivi] of [['rutiini', rutiini], ['poikkeus', poikkeus]]) {
    for (const kielletty of ['user_id', 'created_at', 'updated_at']) {
      assert.equal(kielletty in rivi, false,
        `${nimi}: testirivi lähettää palvelimen omistaman kentän ${kielletty}`);
    }
  }
});

test('KRIITTINEN: hyvaksyntatesti ei vaadi yhdenkaan portin avaamista', async () => {
  // Tyokalu puhuu kannalle suoraan eika sovelluksen repositorion
  // kautta. Se on koko harnessin suunnitteluperiaate: hyvaksyntatesti
  // todentaa KANNAN, ei sovelluksen porttitilaa, ja siksi sen tulos on
  // riippumaton siita mika portti sattuu olemaan auki.
  //
  // Aiemmin tassa vaadittiin porttien olevan kiinni. Se oli tosi mutta
  // vaara vaite: se sitoi harnessin porttitilaan, jota se ei kayta.
  // Oikea vaite on riippumattomuus, ja se todistetaan lukemalla ettei
  // harness tuo schema.js:aa lainkaan.
  const harness = read('tools/rls-acceptance/acceptance.js');

  assert.equal(/from\s+['"][^'"]*schema\.js['"]/.test(harness), false,
    'hyvaksyntatestin harness lukee sovelluksen porttitilaa');
  assert.equal(/hasTable|TABLES/.test(harness), false,
    'hyvaksyntatestin harness viittaa porttilippuihin');
});

// =====================================================================
// MIGRAATIOT 0004–0008: OMISTAJUUSMATRIISI JA RISTIINKIINNITYS
// =====================================================================

test('ehjä RLS: kaikkien kahdeksan uuden taulun matriisi menee läpi', async () => {
  const { rows } = await runAgainst();
  const numerot = rows.map(e => e.test_no);

  // Jokainen tauluryhmä on mukana ajossa. Puuttuva ryhmä olisi
  // pahempi kuin kaatuva: raportti näyttäisi vihreältä eikä kertoisi,
  // ettei taulua testattu lainkaan.
  for (const alku of ['G1', 'G2', 'G3', 'G4', 'G5',   // tavoitteet
                      'J1', 'J2', 'J3', 'J4', 'J5',   // projektit
                      'W1', 'W2', 'W3', 'W4', 'W5',   // hyvinvointi
                      'X1', 'L1', 'S1', 'K1',         // talous ja kirjaus
                      'N1', 'N3', 'N5']) {            // muistutusasetukset
    assert.ok(numerot.some(no => no.startsWith(alku)),
      `tapausryhmä ${alku} puuttuu ajosta`);
  }

  for (const entry of rows.filter(e => /^[GJWXLSKNU]\d/.test(e.test_no))) {
    assert.equal(entry.status, STATUS.PASS,
      `${entry.test_no} (${entry.test_name}): ${entry.status} — ${entry.actual}`);
  }
});

test('KRIITTINEN: kaikki kahdeksan ristiinkiinnitystä torjutaan vierasavaimella', async () => {
  // TÄMÄ ON KOKO PAKETIN TÄRKEIN TESTI.
  //
  // Kahdeksan viitettä, kaksi hyökkäystä kumpaakin kohti: INSERT luo
  // uuden rivin joka viittaa A:n riviin, UPDATE kääntää B:n OMAN rivin
  // viitteen A:han.
  //
  // Odotettu koodi on osa väitettä. Jos jokin näistä palauttaisi
  // 42501:n, rivi olisi kyllä torjuttu — mutta RLS:n toimesta, ei
  // eheysrajoitteen. Silloin suoja riippuisi politiikasta, joka voidaan
  // muuttaa, eikä rakenteesta.
  const { rows } = await runAgainst();

  const hyokkaykset = ['X1', 'X2', 'X3', 'X4', 'X5', 'X6', 'X7', 'X8',
                       'U1', 'U2', 'U3', 'U4', 'U5', 'U6', 'U7', 'U8'];

  for (const no of hyokkaykset) {
    const entry = byNumber(rows, no);
    assert.ok(entry, `hyökkäystapaus ${no} puuttuu kokonaan`);
    assert.equal(entry.status, STATUS.PASS, `${no}: ${entry.actual}`);
    assert.match(entry.actual, /23503/,
      `${no} hyväksyttiin väärällä koodilla — vain vierasavainvirhe todistaa väitteen`);
  }
});

test('KRIITTINEN: sallittu oma viite onnistuu — kielto ei ole rikki kaikille', async () => {
  // Ilman tätä koko hyökkäysosuus voisi mennä läpi siksi, että viitteet
  // ovat rikki kaikilta. Kielto on merkityksellinen vain jos sallittu
  // tapaus toimii.
  const { rows } = await runAgainst();
  const x9 = byNumber(rows, 'X9');

  assert.ok(x9, 'X9 puuttuu');
  assert.equal(x9.status, STATUS.PASS,
    `B ei saanut liittää tehtäväänsä omaan tavoitteeseensa: ${x9.actual}`);
});

test('MUTAATIO: yhdistelmävierasavaimet pois — kaikki 16 hyökkäystä onnistuisi', async () => {
  // Jos viitteet olisivat yhden sarakkeen mittaisia, jokainen näistä
  // menisi läpi: RLS ei estä niitä, koska rivin omistaja on oikein.
  const { rows, summary } = await runAgainst({ compositeFkOff: true });

  assert.equal(summary.verdict, 'FAIL');
  for (const no of ['X1', 'X2', 'X3', 'X4', 'X5', 'X6', 'X7', 'X8',
                    'U1', 'U2', 'U3', 'U4', 'U5', 'U6', 'U7', 'U8']) {
    assert.equal(byNumber(rows, no).status, STATUS.FAIL,
      `${no}: ristiinkiinnitys meni läpi eikä testi huomannut`);
  }
});

test('KRIITTINEN: jokainen hyökkäys osuu OMAAN vierasavaimeensa', async () => {
  // Edellinen mutaatio poisti kaikki viitteet kerralla. Se ei todista,
  // että kukin testi osuu omaan viitteeseensä: jos kaikki kahdeksan
  // kulkisivat saman tarkistuksen läpi, seitsemän voisi olla
  // suojaamatta ilman että yksikään testi huomaisi.
  //
  // Siksi jokainen viite poistetaan vuorollaan yksin, ja vain sen omien
  // testien pitää kaatua.
  const kartta = [
    ['goals.parent_goal_id',              ['X1', 'U1']],
    ['goals.project_id',                  ['X2', 'U2']],
    ['projects.goal_id',                  ['X3', 'U3']],
    ['tasks.goal_id',                     ['X4', 'U4']],
    ['tasks.project_id',                  ['X5', 'U5']],
    ['routines.goal_id',                  ['X6', 'U6']],
    ['bills.task_id',                     ['X7', 'U7']],
    ['bills.recurring_expense_id',        ['X8', 'U8']]
  ];

  const kaikkiHyokkaykset = kartta.flatMap(([, numerot]) => numerot);

  for (const [viite, omat] of kartta) {
    const { rows } = await runAgainst({ fkOff: new Set([viite]) });

    for (const no of omat) {
      assert.equal(byNumber(rows, no).status, STATUS.FAIL,
        `viite ${viite} poistettiin, mutta ${no} ei huomannut sitä`);
    }

    // Ja NIMENOMAAN vain omat. Jos muutkin kaatuvat, testit eivät
    // erottele viitteitä toisistaan.
    for (const no of kaikkiHyokkaykset.filter(n => !omat.includes(n))) {
      assert.equal(byNumber(rows, no).status, STATUS.PASS,
        `viite ${viite} poistettiin, mutta myös ${no} kaatui`
        + ' — testit eivät erottele viitteitä toisistaan');
    }
  }
});

test('KRIITTINEN: hyökkäysrivit eivät jää kantaan', async () => {
  // Siivouksen onnistuminen ei todista tätä: siivous poistaisi rivin
  // jos se olisi syntynyt. Nämä rivit EIVÄT SAANEET SYNTYÄ lainkaan.
  const { rows, db } = await runAgainst();

  const hyokkaysTunnisteet = Object.entries(idsFor('testiajo'))
    .filter(([avain]) => avain.startsWith('attack'))
    .map(([, arvo]) => arvo);

  for (const taulu of ['goals', 'projects', 'tasks', 'routines', 'bills']) {
    const loytyi = db[taulu].filter(r => hyokkaysTunnisteet.includes(r.id));
    assert.deepEqual(loytyi, [],
      `taulussa ${taulu} on hyökkäysrivejä: ${loytyi.map(r => r.id).join(', ')}`);
  }

  for (const no of ['C13-goals', 'C13-projects', 'C13-tasks',
                    'C13-routines', 'C13-bills']) {
    assert.equal(byNumber(rows, no).status, STATUS.PASS,
      `${no}: hyökkäysrivien tarkistus ei mennyt läpi`);
  }
});

test('MUTAATIO: hyökkäysrivi jää kantaan — jäännöstarkistus huomaa', async () => {
  // Jos suoja pettäisi ja siivous osuisi rivin ohi, C13 on ainoa joka
  // kertoisi siitä.
  const { rows } = await runAgainst({
    compositeFkOff: true,
    deleteDrops: rivi => String(rivi.id).includes('_attack_')
  });

  const huomasi = ['C13-goals', 'C13-projects', 'C13-tasks',
                   'C13-routines', 'C13-bills']
    .some(no => byNumber(rows, no).status === STATUS.FAIL);

  assert.ok(huomasi, 'yksikään jäännöstarkistus ei huomannut kantaan jäänyttä hyökkäysriviä');
});

// ------------------------------------------ muistutusasetukset (0005)

test('KRIITTINEN: B ei voi kirjoittaa A:n muistutusasetuksia', async () => {
  // Tässä taulussa pääavain ON omistaja, joten väärennös on pääavaimen
  // väärennös. Jos se menisi läpi, B päättäisi milloin A saa
  // ilmoituksia.
  const { rows } = await runAgainst();
  const n3 = byNumber(rows, 'N3');

  assert.ok(n3, 'N3 puuttuu');
  assert.equal(n3.status, STATUS.PASS, `N3: ${n3.actual}`);
  assert.match(n3.actual, /42501/, 'N3 hyväksyttiin väärällä koodilla');
});

test('MUTAATIO: WITH CHECK auki — muistutusasetusten suoja pettää', async () => {
  // TÄSSÄ TAULUSSA MUTAATION TULOS ON ERI KUIN MUUALLA, JA SYY ON
  // OPETTAVAINEN.
  //
  // Muissa tauluissa B:n väärennös luo uuden rivin, joten WITH CHECKin
  // poisto päästää sen läpi ja testi kaatuu FAILiin.
  //
  // Täällä rivi on tasan yksi per käyttäjä ja sen tunniste ON käyttäjä.
  // A on jo luonut omansa (N1), joten B:n väärennös törmää pääavaimeen
  // ja saa koodin 23505 eikä odotettua 42501:tä. Testi kirjaa sen
  // ERRORiksi — hylätty, mutta väärästä syystä.
  //
  // Se on oikea luokitus, ei kiertotie. Rivi torjuttiin sattumalta:
  // pääavaimen törmäys ei ole turvamalli, ja jos A ei vielä olisi
  // luonut asetuksiaan, sama yritys menisi läpi. Siksi tässä
  // vaaditaan vain, ETTEI se ole PASS.
  const { rows, summary } = await runAgainst({ withCheckOff: true });

  assert.equal(summary.verdict, 'FAIL');
  assert.notEqual(byNumber(rows, 'N3').status, STATUS.PASS,
    'muistutusasetusten väärennös kirjattiin onnistuneeksi kielloksi');

  // Ja UPDATE-polku kaatuu suoraan, koska siinä rivi on jo olemassa.
  const { rows: rows2 } = await runAgainst({ updateUsingOff: true });
  assert.equal(byNumber(rows2, 'N4').status, STATUS.FAIL,
    'B pääsi muokkaamaan A:n muistutusasetuksia eikä testi huomannut');
});

// ------------------------------------------------- kirjausketju (0008)

test('KRIITTINEN: vahvistamatonta suoritusta ei voi kirjata', async () => {
  // Kirjaus, joka voi väittää komennon suoritetuksi ilman vahvistusta,
  // on kirjaus jota ei voi käyttää todisteena mistään.
  const { rows } = await runAgainst();
  const k9 = byNumber(rows, 'K9');

  assert.ok(k9, 'K9 puuttuu');
  assert.equal(k9.status, STATUS.PASS, `K9: ${k9.actual}`);
  assert.match(k9.actual, /23514/,
    'K9 hyväksyttiin väärällä koodilla — vain tarkisterikkomus todistaa väitteen');
});

test('MUTAATIO: vahvistustarkiste pois — kirjaus voi valehdella', async () => {
  const { rows, summary } = await runAgainst({ checkConstraintOff: true });

  assert.equal(summary.verdict, 'FAIL');
  assert.equal(byNumber(rows, 'K9').status, STATUS.FAIL,
    'vahvistamaton suoritus kirjattiin eikä testi huomannut');
});

// -------------------------------------------------------- siivous

test('KRIITTINEN: siivous tyhjentää kaikki kahdeksan uutta taulua', async () => {
  const { db, rows } = await runAgainst();

  for (const taulu of ['goals', 'projects', 'wellbeing_entries',
                       'recurring_expenses', 'bills', 'savings_goals',
                       'ai_action_audit', 'notification_preferences']) {
    assert.deepEqual(db[taulu], [], `tauluun ${taulu} jäi rivejä`);
  }

  // Ja molemmat tilit tarkistivat sen erikseen. Yksi tili ei riitä:
  // RLS piilottaa toisen rivit, joten A:n puhdas näkymä ei kerro
  // mitään siitä, jäikö B:lle jotain.
  for (const lyhenne of ['g', 'j', 'w', 'x', 'l', 's', 'k', 'n']) {
    for (const tunnus of ['C11', 'C12']) {
      const entry = byNumber(rows, `${tunnus}-${lyhenne}`);
      assert.ok(entry, `jäännöstarkistus ${tunnus}-${lyhenne} puuttuu`);
      assert.equal(entry.status, STATUS.PASS,
        `${tunnus}-${lyhenne}: ${entry.actual}`);
    }
  }
});

test('MUTAATIO: siivous jättää tavoitteen — molemmat tilit tarkistavat', async () => {
  const { rows, summary } = await runAgainst({
    deleteDrops: rivi => String(rivi.id).endsWith('_b_goal')
  });

  assert.equal(summary.verdict, 'FAIL');
  assert.equal(byNumber(rows, 'C12-g').status, STATUS.FAIL,
    'B:n jäljelle jäänyttä tavoitetta ei huomattu');
  assert.equal(byNumber(rows, 'C11-g').status, STATUS.PASS,
    'A ei näe B:n tavoitetta — juuri siksi molemmat tarkistetaan');
});

test('MUTAATIO: muistutusasetukset jäävät — tunnisteella tarkistus huomaa', async () => {
  // Näiden rivien tunniste on käyttäjän uuid, joten etuliitehaku ei
  // löytäisi niitä. Jos jäännöstarkistus nojaisi pelkkään etuliitteeseen,
  // rivi jäisi kantaan huomaamatta.
  const { rows, summary } = await runAgainst({
    deleteDrops: rivi => rivi.id === USER_B && rivi.enabled === false
  });

  assert.equal(summary.verdict, 'FAIL');
  assert.equal(byNumber(rows, 'C12-n').status, STATUS.FAIL,
    'B:n jäljelle jääneitä muistutusasetuksia ei huomattu');
});

// ------------------------------------------------------ anon

test('MUTAATIO: anonilla on oikeuksia kaikkiin uusiin tauluihin', async () => {
  const { rows, summary } = await runAgainst({ anonAllowed: true });

  assert.equal(summary.verdict, 'FAIL');
  for (const lyhenne of ['g', 'j', 'n', 'w', 'x', 'l', 's', 'k']) {
    assert.equal(byNumber(rows, `T6-${lyhenne}-select`).status, STATUS.FAIL,
      `T6-${lyhenne}-select: kirjautumaton pääsi tauluun`);
  }
});

test('KRIITTINEN: anon testataan jokaisella operaatiolla, ei vain lukemisella', async () => {
  // GRANT on operaatiokohtainen. Puuttuva revoke yhdelle operaatiolle
  // jäisi näkymättä, jos vain SELECT tarkistettaisiin.
  const { rows } = await runAgainst();

  for (const lyhenne of ['r', 'e', 'g', 'j', 'n', 'w', 'x', 'l', 's', 'k']) {
    for (const operaatio of ['select', 'insert', 'update', 'delete']) {
      const entry = byNumber(rows, `T6-${lyhenne}-${operaatio}`);
      assert.ok(entry, `T6-${lyhenne}-${operaatio} puuttuu`);
      assert.equal(entry.status, STATUS.PASS, `${entry.test_no}: ${entry.actual}`);
    }
  }
});

// ---------------------------------------------- sopimus migraatioihin

test('KRIITTINEN: tekokannan vierasavainlista vastaa migraatioita', async () => {
  // Tekokanta torjuu ristiinkiinnityksen oman listansa perusteella. Jos
  // lista erkanisi migraatioista, hyökkäystestit menisivät läpi
  // tekokantaa vasten vaikka oikeassa kannassa suojaa ei olisi — eli
  // testi todistaisi vain itsensä.
  const kannassa = compositeForeignKeys(migrationFiles());

  // Migraatiot luovat 25 omistajuusviitettä: yksi 0003:ssa, kuusi
  // 0004:ssä, kaksi 0007:ssä, kolme 0010:ssä, kaksi 0011:ssä, neljä
  // 0012:ssa ja seitsemän 0013:ssa.
  assert.equal(kannassa.length, 25,
    `migraatioista löytyi ${kannassa.length} yhdistelmävierasavainta, odotettiin 25`);

  for (const { table, column, parent } of kannassa) {
    const loytyi = YHDISTELMAVIERASAVAIMET.some(
      fk => fk.table === table && fk.column === column && fk.parent === parent);
    assert.ok(loytyi,
      `migraatio luo viitteen ${table}.${column} -> ${parent}, jota tekokanta ei tunne`);
  }

  for (const fk of YHDISTELMAVIERASAVAIMET) {
    const loytyi = kannassa.some(
      k => k.table === fk.table && k.column === fk.column && k.parent === fk.parent);
    assert.ok(loytyi,
      `tekokanta tuntee viitteen ${fk.table}.${fk.column} -> ${fk.parent}, jota migraatio ei luo`);
  }
});

/**
 * Migraatioiden yhdistelmävierasavaimet käyttäjän omistamiin tauluihin:
 * `foreign key (user_id, C) references public.P (user_id, id)`. Viittaava
 * taulu on lähin edeltävä `create table` tai `alter table` (0003 määrittää
 * avaimen taulun luonnissa, myöhemmät alter tablella). Kommentit riisutaan
 * ensin, koska peruutusohjeet toistavat lauseita kommentteina.
 */
function compositeForeignKeys(files) {
  const found = [];
  for (const nimi of files) {
    const lahde = sql(nimi)
      .split(NEWLINE)
      .filter(line => !line.trim().startsWith('--'))
      .join(NEWLINE);
    const owners = [...lahde.matchAll(/(?:create|alter) table (?:if not exists )?public\.(\w+)/g)];
    for (const m of lahde.matchAll(
      /foreign key \(user_id,\s*(\w+)\)\s*references public\.(\w+)\s*\(user_id,\s*id\)/g)) {
      const owner = owners.filter(candidate => candidate.index < m.index).pop();
      found.push({ migration: nimi.slice(0, 4), table: owner ? owner[1] : null, column: m[1], parent: m[2] });
    }
  }
  return found;
}

test('KRIITTINEN: uusien taulujen testirivit vastaavat sovelluksen sarakkeita', async () => {
  // Työkalu puhuu kannalle suoraan, joten se voisi kirjoittaa
  // sarakkeisiin joihin sovellus ei koskaan koske. Silloin se testaisi
  // eri asiaa kuin mitä tuotannossa tapahtuu.
  const repos = await import('../src/data/collectionsRepo.js');

  const parit = [
    [goalRow('x', 'otsikko'), repos.goalsRepo, { id: 'x', title: 'otsikko' }],
    [projectRow('x', 'nimi'), repos.projectsRepo, { id: 'x', name: 'nimi' }],
    [wellbeingRow('x', '1990-01-01'), repos.wellbeingRepo,
      { id: 'x', date: '1990-01-01', energy: 3 }],
    [recurringExpenseRow('x', 'nimi', '2026-10-01'), repos.recurringExpensesRepo,
      { id: 'x', name: 'nimi', amountMinor: 1000, nextDueDate: '2026-10-01' }],
    [billRow('x', 'nimi', '2026-10-01'), repos.billsRepo,
      { id: 'x', name: 'nimi', amountMinor: 1000, dueDate: '2026-10-01' }],
    [savingsGoalRow('x', 'nimi'), repos.savingsGoalsRepo,
      { id: 'x', name: 'nimi', targetMinor: 1000 }],
    [auditRow('x'), repos.aiAuditRepo,
      { id: 'x', intent: 'create_task', risk: 'medium' }]
  ];

  for (const [testirivi, repo, esimerkki] of parit) {
    const sovelluksen = repo.mapping.toRow(repo.mapping.normalize(esimerkki));
    assert.deepEqual(Object.keys(testirivi).sort(), Object.keys(sovelluksen).sort(),
      `taulun ${repo.table} testirivi ei vastaa sovelluksen kirjoittamia sarakkeita`);

    // Eikä yksikään lähetä palvelimen omistamia kenttiä.
    for (const kielletty of ['user_id', 'created_at', 'updated_at']) {
      assert.equal(kielletty in testirivi, false,
        `${repo.table}: testirivi lähettää palvelimen omistaman kentän ${kielletty}`);
    }
  }
});

test('KRIITTINEN: porttitila on suunniteltu aalto, ei sattuma', async () => {
  // Hyvaksyntatesti ei vaadi mitaan tiettya porttitilaa (ks. yllä),
  // mutta se ei tarkoita etta mika tahansa tila kelpaisi. Portti, joka
  // on auki ilman aaltoa, on avattu ilman hyvaksyntaa.
  const { TABLES } = await import('../src/data/schema.js');
  const { resolveWave, describeMatrix } = await import('../tools/release/waves.mjs');

  assert.ok(resolveWave(TABLES) !== null,
    `porttimatriisi ei vastaa yhtakaan aaltoa: ${describeMatrix(TABLES)}`);
});

// =====================================================================
// TUOTANTOAJOSSA 20260907181539 LÖYTYNEET KOLME VIRHETTÄ
// =====================================================================
//
// Ajo tuotti 268/271 PASS, 0 FAIL, 3 ERROR. Kaikki kolme olivat
// harnessin vikoja, eivät kannan — mutta kumpikaan ei olisi näkynyt
// näissä testeissä, koska tekokanta ei mallintanut niitä rajoitteita
// joihin lauseet kaatuivat.
//
// ERROR on oikea luokitus molemmille: lause torjuttiin, mutta VÄÄRÄSTÄ
// syystä, eikä testi siis todistanut sitä mitä sen piti todistaa.
// Väärällä koodilla saatu torjunta ei ole todiste.

test('KRIITTINEN: E4 kohtaa vierasavaimen, ei yksikäsitteisyysindeksiä', () => {
  // VIKA 1 — E4 sai 23505 (duplicate key) odotetun 23503:n sijaan.
  //
  // Rajoite on `unique (routine_id, date)` — RUTIINIkohtainen, ei
  // käyttäjäkohtainen. E1 loi A:n poikkeuksen pariin
  // (A:n rutiini, today), ja E4 yritti kiinnittää B:n poikkeuksen
  // SAMAAN rutiiniin SAMALLE päivälle. Indeksi torjui rivin ennen kuin
  // vierasavain ehti sanoa mitään.
  //
  // Järjestys kannassa: RLS WITH CHECK -> yksikäsitteisyysindeksi ->
  // vierasavaimen liipaisin.
  //
  // Jokaisen A:n rutiiniin kohdistuvan fikstuurin on siksi käytettävä
  // omaa päiväänsä.
  const paivat = exceptionDates('2026-09-05');

  // Nämä kolme kohdistuvat A:n rutiiniin. Jos kaksi jakaa päivän,
  // jälkimmäinen kohtaa indeksin eikä sitä rajoitetta jota testataan.
  const aRutiiniin = [paivat.ownA, paivat.forgedB, paivat.attackB];
  assert.equal(new Set(aRutiiniin).size, aRutiiniin.length,
    `A:n rutiiniin kohdistuvat poikkeukset jakavat päivän: ${aRutiiniin.join(', ')}`
    + ' — yksikäsitteisyysindeksi torjuisi ennen vierasavainta');

  // Ja ne ovat kelvollisia ISO-päiviä, eivät esimerkiksi NaN-siirtymiä.
  for (const paiva of Object.values(paivat)) {
    assert.match(paiva, /^\d{4}-\d{2}-\d{2}$/, `kelvoton päivä: ${paiva}`);
  }

  // E5 saa jakaa päivän E1:n kanssa: se kohdistuu B:n OMAAN rutiiniin,
  // joten pari (rutiini, päivä) on eri.
  assert.equal(paivat.ownB, paivat.ownA,
    'E5 ei enää jaa päivää E1:n kanssa — jos tämä on tarkoituksellista,'
    + ' päivitä myös perustelu exceptionDates-funktiossa');
});

test('KRIITTINEN: E4 odottaa yhä nimenomaan vierasavainvirhettä', async () => {
  // Vian houkutteleva "korjaus" olisi ollut hyväksyä 23505 odotukseksi.
  // Se olisi tehnyt testistä sellaisen, joka menee läpi ilman että
  // yhdistelmävierasavainta on koskaan koeteltu.
  const { rows } = await runAgainst();
  const e4 = byNumber(rows, 'E4');

  assert.ok(e4, 'E4 puuttuu kokonaan');
  assert.equal(e4.status, STATUS.PASS, `E4: ${e4.actual}`);
  assert.match(e4.expected, /23503/, 'E4 ei enää odota vierasavainvirhettä');
  assert.match(e4.actual, /23503/, `E4 torjuttiin väärällä koodilla: ${e4.actual}`);
  assert.equal(/23505/.test(e4.actual), false,
    'E4 osui yksikäsitteisyysindeksiin — se ei todista vierasavainta');
});

test('KRIITTINEN: anon-kohde on tyypiltään taulun avaimen mukainen', () => {
  // VIKA 2 ja 3 — T6-n-update ja T6-n-delete saivat 22P02
  // (invalid input syntax for type uuid) odotetun 42501:n sijaan.
  //
  // notification_preferences.id on uuid, ja harness syötti siihen
  // merkkijonon `manifestival_rls_acceptance_anon`. PostgreSQL hylkäsi
  // arvon ennen kuin oikeustarkistus ehti tapahtua, joten testi ei
  // todistanut mitään anon-roolin oikeuksista.
  //
  // Odotettu tyyppi luetaan MIGRAATIOSTA, ei kirjoiteta käsin: jos
  // jonkin taulun avain joskus vaihtuu, tämä kaatuu.
  const uuidHahmo = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  /** Taulun id-sarakkeen tyyppi migraatioista. */
  const avaintyyppi = taulu => {
    for (const nimi of fs.readdirSync(path.join(ROOT, 'supabase/migrations'))
                        .filter(n => n.endsWith('.sql'))) {
      const lahde = fs.readFileSync(path.join(ROOT, 'supabase/migrations', nimi), 'utf8');
      const luonti = new RegExp(`create table public\\.${taulu} \\(([\\s\\S]*?)\\n\\);`)
        .exec(lahde);
      if (!luonti) continue;
      const rivi = /^ {2}id\s+(\w+)/m.exec(luonti[1]);
      assert.ok(rivi, `${taulu}: id-saraketta ei löytynyt`);
      return rivi[1].toLowerCase();
    }
    return null;
  };

  let uuidTauluja = 0;
  for (const { taulu, kohde } of ANON_KOHTEET) {
    const tyyppi = avaintyyppi(taulu);
    assert.ok(tyyppi, `taulua ${taulu} ei löydy yhdestäkään migraatiosta`);

    if (tyyppi === 'uuid') {
      uuidTauluja += 1;
      assert.match(kohde, uuidHahmo,
        `${taulu}: anon-kohde "${kohde}" ei ole kelvollinen uuid`
        + ' — kanta hylkäisi sen ennen oikeustarkistusta (22P02)');
    } else {
      assert.ok(kohde.startsWith(MARKER_PREFIX),
        `${taulu}: anon-kohde ei ole tunnistettavissa etuliitteestä`);
    }
  }

  // Tyhjentymissuoja: jos hahmo lakkaisi osumasta, silmukka kävisi läpi
  // nolla uuid-taulua ja menisi läpi.
  assert.equal(uuidTauluja, 1,
    `uuid-avaimellisia tauluja löytyi ${uuidTauluja}, odotettiin 1`
    + ' (notification_preferences)');
});

test('KRIITTINEN: anon-kohde on olematon eikä kenenkään tunniste', () => {
  // Kohteen on oltava syntaktisesti kelvollinen mutta olematon.
  // Oikean käyttäjän tunnistetta ei käytetä: anon ei saa kohdistaa
  // mitään olemassa olevaan riviin edes epäonnistuakseen.
  assert.equal(NIL_UUID, '00000000-0000-0000-0000-000000000000');

  for (const { taulu, kohde } of ANON_KOHTEET) {
    assert.notEqual(kohde, OWNER_A, `${taulu}: anon-kohde on tilin A tunniste`);
    assert.notEqual(kohde, USER_B, `${taulu}: anon-kohde on tilin B tunniste`);
  }
});

test('KRIITTINEN: T6-n-update ja T6-n-delete odottavat yhä 42501:tä', async () => {
  // Vian houkutteleva "korjaus" olisi ollut hyväksyä 22P02 odotukseksi.
  // Silloin testi menisi läpi ilman että anon-roolin oikeuksia on
  // koskaan koeteltu — se todistaisi vain, ettei merkkijono ole uuid.
  const { rows } = await runAgainst();

  for (const operaatio of ['select', 'insert', 'update', 'delete']) {
    const entry = byNumber(rows, `T6-n-${operaatio}`);
    assert.ok(entry, `T6-n-${operaatio} puuttuu`);
    assert.equal(entry.status, STATUS.PASS, `T6-n-${operaatio}: ${entry.actual}`);
    assert.match(entry.expected, /42501/,
      `T6-n-${operaatio} ei enää odota oikeusvirhettä`);
    assert.equal(/22P02/.test(entry.actual), false,
      `T6-n-${operaatio} kaatui tyyppivirheeseen: ${entry.actual}`);
  }
});

test('KRIITTINEN: tekokanta mallintaa ne rajoitteet joihin tuotanto kaatui', () => {
  // Kumpikaan vika ei näkynyt näissä testeissä, koska tekokanta ei
  // tuntenut kumpaakaan rajoitetta. Simulaatio, joka ei tunne
  // rajoitetta, ei voi ennustaa sitä vastaan kaatuvaa lausetta — se
  // antaa väärän varmuuden.
  //
  // Nämä väitteet pitävät mallin paikallaan.
  const migraatio = sql('0003_routines.sql');

  // 1. Yksikäsitteisyys on RUTIINIkohtainen, ei käyttäjäkohtainen.
  //    Jos tämä joskus muuttuu, E4:n päiväjärjestely on turha — ja
  //    tekokannan malli väärä.
  assert.ok(migraatio.includes('constraint routine_exceptions_unique_day unique (routine_id, date)'),
    'routine_exceptions_unique_day ei ole enää (routine_id, date)'
    + ' — tarkista E4:n päivät ja tekokannan malli');

  const mallissa = YKSIKASITTEISYYDET.find(r => r.table === 'routine_exceptions');
  assert.ok(mallissa, 'tekokanta ei mallinna routine_exceptions-yksikäsitteisyyttä');
  assert.deepEqual(mallissa.columns, ['routine_id', 'date'],
    'tekokannan malli ei vastaa migraatiota');

  // 2. Hyvinvointimerkintöjen yksikäsitteisyys on käyttäjäkohtainen.
  assert.ok(sql('0006_wellbeing.sql')
    .includes('constraint wellbeing_entries_unique_day unique (user_id, date)'),
    'wellbeing_entries_unique_day ei ole enää (user_id, date)');

  // 3. Jokaisen migraatioiden luoman yksikäsitteisyysrajoitteen, joka
  //    kattaa muutakin kuin pelkän id:n, on oltava mallissa. Muuten
  //    seuraava samanlainen vika jää taas näkymättä.
  const kannassa = [];
  for (const name of migrationFiles()) {
    for (const m of sql(name).matchAll(/constraint (\w+_unique_\w+) unique \(([^)]*)\)/g)) {
      kannassa.push({ nimi: m[1], columns: m[2].split(',').map(x => x.trim()) });
    }
  }
  assert.ok(kannassa.length >= 2, `yksikäsitteisyysrajoitteita löytyi ${kannassa.length}`);

  for (const { nimi, columns } of kannassa) {
    const loytyi = YKSIKASITTEISYYDET.some(r =>
      r.columns.length === columns.length
      && r.columns.every((sarake, i) => sarake === columns[i]));
    assert.ok(loytyi,
      `rajoitetta ${nimi} (${columns.join(', ')}) ei ole tekokannan mallissa`
      + ' — sitä vastaan kaatuva lause menisi simulaatiossa läpi');
  }

  // 4. Ja jokainen uuid-avaimellinen taulu on tyyppimallissa. Ilman
  //    sitä tekokanta hyväksyisi merkkijonon uuid-sarakkeeseen eikä
  //    voisi ennustaa tuotannon 22P02:ta.
  const uuidTaulut = [];
  for (const name of migrationFiles()) {
    for (const m of sql(name).matchAll(/create table public\.(\w+) \(([\s\S]*?)\n\);/g)) {
      if (/^ {2}id\s+uuid/m.test(m[2])) uuidTaulut.push(m[1]);
    }
  }
  // profile syntyi ennen migraatiota 0003, joten se ei nay yllaolevassa
  // haussa — se lisataan kasin, ja sen avaintyyppi on tarkistettu
  // migraatiossa 0001.
  for (const taulu of uuidTaulut) {
    assert.ok(UUID_AVAIMELLISET.has(taulu),
      `taulun ${taulu} avain on uuid, mutta tekokanta ei tyypitä sitä`);
  }
  assert.ok(uuidTaulut.includes('notification_preferences'),
    'notification_preferences ei enää ole uuid-avaimellinen — tarkista anon-kohteet');
});

test('KRIITTINEN: tekokanta torjuu samassa järjestyksessä kuin PostgreSQL', async () => {
  // MALLIN OMA TESTI, EI HARNESSIN.
  //
  // Kaksi edellistä mutaatiota pääsi läpi, koska ne heikensivät
  // TEKOKANTAA eivätkä harnessia: kun fikstuurit ovat kunnossa,
  // puuttuva rajoitemalli ei näy missään. Se palauttaisi juuri sen
  // sokean pisteen, joka päästi nämä kolme virhettä tuotantoon asti.
  //
  // Siksi malli testataan suoraan: rakennetaan tilanne, jossa
  // rajoitteen PITÄÄ laueta, ja katsotaan laukeaako se — ja oikeassa
  // järjestyksessä.
  const db = makeDb();
  const a = makeClient(db, OWNER_A);
  const b = makeClient(db, USER_B);

  // A:n rutiini ja poikkeus. Pari (rutiini, päivä) on nyt varattu.
  await a.from('routines').insert(routineRow('r-a', 'A:n rutiini')).select();
  await a.from('routine_exceptions')
    .insert(exceptionRow('e-a', 'r-a', '2026-09-05')).select();

  // 1. YKSIKÄSITTEISYYS ON RUTIINIKOHTAINEN, EI KÄYTTÄJÄKOHTAINEN.
  //    A yrittää toista poikkeusta samalle rutiinille samana päivänä.
  const omaTormays = await a.from('routine_exceptions')
    .insert(exceptionRow('e-a2', 'r-a', '2026-09-05')).select();
  assert.equal(omaTormays.error?.code, '23505',
    'tekokanta ei tunne rajoitetta unique (routine_id, date)');

  // 2. JÄRJESTYS: yksikäsitteisyys ENNEN vierasavainta.
  //    B:n rivi viittaa A:n rutiiniin JA osuu varattuun päivään.
  //    Kumpikin rajoite rikkoutuu; PostgreSQL raportoi indeksin.
  //    Juuri tämä nähtiin tuotannossa E4:ssä.
  const molemmatRikki = await b.from('routine_exceptions')
    .insert(exceptionRow('e-b', 'r-a', '2026-09-05')).select();
  assert.equal(molemmatRikki.error?.code, '23505',
    'tekokanta tarkistaa vierasavaimen ennen yksikäsitteisyyttä'
    + ' — väärä järjestys piilottaisi E4:n vian');

  // 3. VAPAALLA PÄIVÄLLÄ sama rivi kohtaa vierasavaimen.
  //    Tämä on se, mitä E4:n pitää mitata.
  const vainViiteRikki = await b.from('routine_exceptions')
    .insert(exceptionRow('e-b2', 'r-a', '2026-09-09')).select();
  assert.equal(vainViiteRikki.error?.code, '23503',
    'yhdistelmävierasavain ei torjunut ristiinkiinnitystä');

  // 4. ERI RUTIINI, SAMA PÄIVÄ: sallittu.
  await b.from('routines').insert(routineRow('r-b', 'B:n rutiini')).select();
  const eriRutiini = await b.from('routine_exceptions')
    .insert(exceptionRow('e-b3', 'r-b', '2026-09-05')).select();
  assert.equal(eriRutiini.error, null,
    'tekokanta estää poikkeuksen eri rutiinille samana päivänä');
});

test('KRIITTINEN: tekokanta tarkistaa uuid-tyypin ennen oikeuksia', async () => {
  // Sama asia toisin päin: jos tyyppitarkistus katoaa mallista,
  // T6-n-update ja T6-n-delete näyttäisivät taas läpimeneviltä
  // vaikka tuotannossa ne kaatuvat 22P02:een.
  const db = makeDb();
  const anon = makeClient(db, null);

  const kelvoton = await anon.from('notification_preferences')
    .update({ id: 'ei-ole-uuid' }).eq('id', 'ei-ole-uuid').select();
  assert.equal(kelvoton.error?.code, '22P02',
    'tekokanta hyväksyy merkkijonon uuid-sarakkeeseen'
    + ' — se ei voi ennustaa tuotannon tyyppivirhettä');

  // Kelvollisella uuid:lla lause pääsee oikeustarkistukseen asti.
  const kelvollinen = await anon.from('notification_preferences')
    .update({ id: NIL_UUID }).eq('id', NIL_UUID).select();
  assert.equal(kelvollinen.error?.code, '42501',
    'kelvollinen uuid ei päässyt oikeustarkistukseen');

  // Ja tekstiavaimellinen taulu ei tyypitä mitään.
  const teksti = await anon.from('goals')
    .update({ id: 'mika-tahansa' }).eq('id', 'mika-tahansa').select();
  assert.equal(teksti.error?.code, '42501',
    'tekstiavaimellinen taulu tyypittää turhaan');
});

// =====================================================================
// MIGRAATIOT 0009–0013 (CRIT-07): 14 TAULUA JA 16 RISTIINKIINNITYSTÄ
// =====================================================================
//
// Ajuri ajaa nämä vain, kun operaattori valitsee aallon, jonka
// migraatiot tuotannossa on ajettu. Tekokanta tuntee kaikki 14 taulua,
// niiden yksikäsitteisyysrajoitteet ja yhdistelmävierasavaimet.

const NEW_MIGRATIONS = ['0009', '0010', '0011', '0012', '0013'];
const newMigrationFiles = () => migrationFiles().filter(name => NEW_MIGRATIONS.includes(name.slice(0, 4)));
const codeOf = table => TABLE_SPECS.find(entry => entry.table === table).code;

/** Taulun luontilause migraatiosta. */
function createStatement(table) {
  for (const name of migrationFiles()) {
    const match = new RegExp(`create table public\\.${table} \\(([\\s\\S]*?)\\n\\);`).exec(sql(name));
    if (match) return match[1];
  }
  return null;
}

/** NOT NULL -sarakkeet ilman oletusarvoa: testirivin on annettava ne. */
function requiredColumns(table) {
  const body = createStatement(table);
  const required = [];
  for (const line of body.split(NEWLINE)) {
    const column = /^ {2}(\w+)\s+/.exec(line);
    if (!column) continue;
    // Monirivinen sarakemäärittely (references …) jatkuu seuraavalla rivillä.
    if (/not null/.test(line) && !/default/.test(line)) required.push(column[1]);
  }
  return required.filter(name => !['user_id'].includes(name));
}

test('0009–0013: TABLE_SPECS kattaa täsmälleen migraatioiden luomat taulut', () => {
  const luodut = [];
  for (const name of newMigrationFiles()) {
    for (const m of sql(name).matchAll(/create table public\.(\w+) \(/g)) luodut.push(m[1]);
  }
  assert.equal(luodut.length, 14, `migraatiot 0009–0013 luovat ${luodut.length} taulua`);
  assert.deepEqual(TABLE_SPECS.map(entry => entry.table).sort(), [...luodut].sort());
  // Tunnukset ovat yksilöllisiä eivätkä törmää 0003–0008:n osioihin.
  const codes = TABLE_SPECS.map(entry => entry.code);
  assert.equal(new Set(codes).size, codes.length);
  for (const code of codes) {
    assert.match(code, /^[A-Z]{2}$/, `${code}: kaksikirjaiminen tunnus erottuu T1a/G1a-tyyleistä`);
  }
  // Siivousjärjestys kattaa jokaisen taulun.
  assert.deepEqual([...CLEANUP_ORDER].sort(), [...luodut].sort());
});

test('0009–0013: jokaisen taulun aalto tulee tools/release/waves.mjs:stä', () => {
  for (const entry of TABLE_SPECS) {
    const wave = WAVES.find(candidate => candidate.tables.includes(entry.table));
    assert.ok(wave, `${entry.table} ei kuulu yhteenkään aaltoon`);
    assert.equal(entry.wave, wave.id, entry.table);
    assert.equal(entry.migration, wave.migration, entry.table);
    assert.ok(NEW_MIGRATIONS.includes(entry.migration), `${entry.table}: ${entry.migration}`);
  }
  // Aallot, joita vasten ajon voi valita: kannan lattiasta (0008) J:hin.
  assert.deepEqual([...ACCEPTANCE_WAVES], ['E', 'F', 'G', 'H', 'I', 'J']);
});

test('KRIITTINEN: ristiinkiinnityslista on johdettu migraatioista 0009–0013', () => {
  // Staattinen jäsennys `foreign key (user_id, …)` → jokaiselle
  // käyttäjän omistaman taulun yhdistelmävierasavaimelle on kokeilu.
  const kannassa = compositeForeignKeys(newMigrationFiles());
  assert.equal(kannassa.length, 16, `migraatioista löytyi ${kannassa.length}`);

  const avain = fk => `${fk.migration}:${fk.table}.${fk.column}->${fk.parent}`;
  assert.deepEqual(COMPOSITE_FK_PROBES.map(avain).sort(), kannassa.map(avain).sort());

  // Aalto on migraation aalto, ei taulun: goals.life_area_id tulee 0012:sta.
  for (const probe of COMPOSITE_FK_PROBES) {
    assert.equal(probe.wave, MIGRATION_WAVE[probe.migration], probe.key);
  }
  assert.equal(COMPOSITE_FK_PROBES.find(p => p.key === 'goals.life_area_id').wave, 'I');
  assert.equal(COMPOSITE_FK_PROBES.find(p => p.key === 'time_entries.project_id').wave, 'J');

  // Jokainen vanhempi on käyttäjän omistama taulu, jonka A:n rivi ajo luo.
  for (const probe of COMPOSITE_FK_PROBES) {
    assert.ok(Object.values(ACCOUNT_DATA_MAP).some(entry => entry.table === probe.parent),
      `${probe.key}: vanhempi ${probe.parent} ei ole käyttäjän taulu`);
  }
});

test('KRIITTINEN: jokainen ACCOUNT_DATA_MAP-taulu on todistettu tai perustellusti rajattu', () => {
  const specTables = new Set(TABLE_SPECS.map(entry => entry.table));
  const puuttuvat = [];
  for (const [name, { table }] of Object.entries(ACCOUNT_DATA_MAP)) {
    const exemption = RLS_EXEMPTIONS[table];
    if (exemption !== undefined) {
      assert.ok(typeof exemption === 'string' && exemption.trim().length >= 20,
        `${table}: rajaus ilman kunnollista perustelua`);
      continue;
    }
    if (!BESPOKE_COVERAGE[table] && !specTables.has(table)) puuttuvat.push(`${name} (${table})`);
  }
  assert.deepEqual(puuttuvat, [], 'tauluja ilman RLS-hyväksyntätestiä');
  // Rajaus ei saa peittää taulua, joka on jo testattu (kaksi totuutta).
  for (const table of Object.keys(RLS_EXEMPTIONS)) {
    assert.equal(specTables.has(table) || Boolean(BESPOKE_COVERAGE[table]), false, table);
  }
});

test('KRIITTINEN: aallossa J jokainen ACCOUNT_DATA_MAP-taulu todella kohtaa B:n lukukiellon ja anonin', async () => {
  // Kattavuuslista voi valehdella; lauseloki ei. Jokaiseen käyttäjän
  // tauluun on lähtenyt B:n SELECT ja kirjautumattoman yritys.
  const { ledger } = await runAgainst({}, null, { wave: 'J' });
  for (const { table } of Object.values(ACCOUNT_DATA_MAP)) {
    if (RLS_EXEMPTIONS[table] !== undefined) continue;
    assert.ok(ledger.some(entry => entry.uid === USER_B && entry.table === table && entry.op === 'select'),
      `${table}: B ei yrittänyt lukea`);
    assert.ok(ledger.some(entry => entry.uid === null && entry.table === table),
      `${table}: kirjautumatonta ei kokeiltu`);
  }
});

test('ehjä RLS aallossa J: jokainen 0003–0013:n tarkistus menee läpi', async () => {
  const { rows, summary } = await runAgainst({}, null, { wave: 'J' });
  const notPassing = rows.filter(entry => entry.status !== STATUS.PASS);
  assert.deepEqual(notPassing.map(entry => `${entry.test_no}:${entry.status}:${entry.actual}`), []);
  assert.equal(summary.verdict, 'PASS');
  assert.equal(summary.wave, 'J');
  assert.deepEqual([...summary.tablesInScope].sort(), TABLE_SPECS.map(entry => entry.table).sort());

  const numerot = new Set(rows.map(entry => entry.test_no));
  for (const entry of TABLE_SPECS) {
    for (const suffix of ['1a', '1b', '1c', '1d', '2a', '2b', '3a', '3b', '3c', '3d', '3e', '4a', '5a', '5b']) {
      assert.ok(numerot.has(`${entry.code}${suffix}`), `${entry.code}${suffix} puuttuu`);
    }
    const lyhenne = entry.code.toLowerCase();
    for (const op of ['select', 'insert', 'update', 'delete']) {
      assert.ok(numerot.has(`T6-${lyhenne}-${op}`), `T6-${lyhenne}-${op} puuttuu`);
    }
    for (const tunnus of ['C11', 'C12']) assert.ok(numerot.has(`${tunnus}-${lyhenne}`));
    for (const kuka of ['a', 'b']) {
      assert.ok(numerot.has(`P0-${lyhenne}-${kuka}`));
      assert.ok(numerot.has(`CV-${lyhenne}-${kuka}`));
    }
  }
  for (const probe of COMPOSITE_FK_PROBES) {
    for (const no of [`XV-${probe.key}`, `UV-${probe.key}`, `CV13-${probe.key}`]) {
      assert.ok(numerot.has(no), `${no} puuttuu`);
    }
  }
  for (const no of ['P2', 'P3', 'XV-ok', 'AR6a', 'AR6b']) assert.ok(numerot.has(no), no);
});

test('KRIITTINEN: B:n aikakirjaus A:n elämänalueeseen torjutaan vierasavaimella (23503)', async () => {
  const { rows, ledger } = await runAgainst({}, null, { wave: 'J' });
  const entry = byNumber(rows, 'XV-time_entries.life_area_id');
  assert.equal(entry.status, STATUS.PASS, entry.actual);
  assert.match(entry.expected, /23503/);
  assert.match(entry.actual, /23503/);
  // Lause oli B:n INSERT, jonka life_area_id on A:n alue — ei mitään muuta.
  const attack = ledger.find(item => item.uid === USER_B && item.op === 'insert'
    && item.table === 'time_entries' && item.payload.id === attackIdFor('testiajo', { table: 'time_entries', column: 'life_area_id' }));
  assert.ok(attack, 'hyökkäyslausetta ei lähetetty');
  assert.equal(attack.payload.life_area_id, specIdsFor('testiajo', 'LA').a);
  assert.equal('user_id' in attack.payload, false, 'omistaja on kannan asettama — muuten testi mittaisi RLS:ää');
});

test('KRIITTINEN: B:n UPDATE A:n viikkokatsauksen pohdintaan osuu nollaan riviin', async () => {
  const { rows, ledger, db } = await runAgainst({}, null, { wave: 'J' });
  const aReview = specIdsFor('testiajo', 'AR').a;
  for (const no of ['AR3a', 'AR6a']) {
    assert.equal(byNumber(rows, no).status, STATUS.PASS, `${no}: ${byNumber(rows, no).actual}`);
    assert.match(byNumber(rows, no).actual, /0 riviä/);
  }
  const updates = ledger.filter(item => item.uid === USER_B && item.op === 'update'
    && item.table === 'alignment_reviews'
    && item.filters.some(filter => filter.column === 'id' && filter.value === aReview));
  assert.ok(updates.some(item => 'reflection' in item.payload), 'B ei yrittänyt pohdintaa');
  assert.equal(byNumber(rows, 'AR6b').status, STATUS.PASS);
  // Raportti ei kanna pohdinnan tekstiä.
  assert.equal(JSON.stringify(rows).includes('B:n kaappaama pohdinta'), false);
  assert.deepEqual(db.alignment_reviews, [], 'katsausrivejä jäi kantaan');
});

test('KRIITTINEN: B ei näe A:n käynnissä olevaa ajastinta', async () => {
  const { rows } = await runAgainst({}, null, { wave: 'J' });
  for (const no of ['RT2a', 'RT2b', 'RT5a']) {
    assert.equal(byNumber(rows, no).status, STATUS.PASS, `${no}: ${byNumber(rows, no).actual}`);
  }
  const { rows: auki } = await runAgainst({ selectUsingOff: true }, null, { wave: 'J' });
  for (const no of ['RT2a', 'RT2b']) {
    assert.equal(byNumber(auki, no).status, STATUS.FAIL, `${no} ei huomannut, että B näkee A:n ajastimen`);
  }
});

test('KRIITTINEN: kaikki 16 uutta ristiinkiinnitystä torjutaan 23503:lla, INSERT ja UPDATE', async () => {
  const { rows } = await runAgainst({}, null, { wave: 'J' });
  for (const probe of COMPOSITE_FK_PROBES) {
    for (const no of [`XV-${probe.key}`, `UV-${probe.key}`]) {
      const entry = byNumber(rows, no);
      assert.equal(entry.status, STATUS.PASS, `${no}: ${entry.actual}`);
      assert.match(entry.actual, /23503/, `${no} torjuttiin väärällä koodilla`);
    }
  }
  assert.equal(byNumber(rows, 'XV-ok').status, STATUS.PASS, 'sallittu oma viite ei toiminut');
});

test('MUTAATIO: yhdistelmävierasavaimet pois — kaikki 32 uutta hyökkäystä huomataan', async () => {
  const { rows, summary } = await runAgainst({ compositeFkOff: true }, null, { wave: 'J' });
  assert.equal(summary.verdict, 'FAIL');
  for (const probe of COMPOSITE_FK_PROBES) {
    for (const no of [`XV-${probe.key}`, `UV-${probe.key}`]) {
      assert.notEqual(byNumber(rows, no).status, STATUS.PASS, `${no}: ristiinkiinnitys meni läpi huomaamatta`);
    }
    assert.equal(byNumber(rows, `UV-${probe.key}`).status, STATUS.FAIL, `UV-${probe.key}`);
  }
});

test('KRIITTINEN: jokainen uusi hyökkäys osuu OMAAN vierasavaimeensa', async () => {
  const kaikki = COMPOSITE_FK_PROBES.flatMap(probe => [`XV-${probe.key}`, `UV-${probe.key}`]);
  for (const probe of COMPOSITE_FK_PROBES) {
    const { rows } = await runAgainst({ fkOff: new Set([probe.key]) }, null, { wave: 'J' });
    const omat = [`XV-${probe.key}`, `UV-${probe.key}`];
    for (const no of omat) {
      assert.notEqual(byNumber(rows, no).status, STATUS.PASS, `${probe.key} pois, mutta ${no} ei huomannut`);
    }
    for (const no of kaikki.filter(candidate => !omat.includes(candidate))) {
      assert.equal(byNumber(rows, no).status, STATUS.PASS,
        `${probe.key} pois, mutta myös ${no} kaatui — testit eivät erottele viitteitä`);
    }
  }
});

test('MUTAATIO aallossa J: rikkinäinen politiikka huomataan jokaisessa uudessa taulussa', async () => {
  const tapaukset = [
    [{ selectUsingOff: true }, ['2a', '2b']],
    [{ updateUsingOff: true }, ['3a', '3d']],
    [{ deleteUsingOff: true }, ['3b']],
    [{ withCheckOff: true }, ['3c']]
  ];
  for (const [flaws, suffixes] of tapaukset) {
    const { rows, summary } = await runAgainst(flaws, null, { wave: 'J' });
    assert.equal(summary.verdict, 'FAIL');
    for (const entry of TABLE_SPECS) {
      for (const suffix of suffixes) {
        const no = `${entry.code}${suffix}`;
        assert.notEqual(byNumber(rows, no).status, STATUS.PASS,
          `${no}: ${JSON.stringify(flaws)} jäi huomaamatta`);
      }
    }
    if (flaws.updateUsingOff) {
      assert.equal(byNumber(rows, 'AR6a').status, STATUS.FAIL, 'pohdinnan kaappaus jäi huomaamatta');
      assert.equal(byNumber(rows, 'AR6b').status, STATUS.FAIL, 'muuttunut pohdinta jäi huomaamatta');
    }
  }
  const { rows } = await runAgainst({ anonAllowed: true }, null, { wave: 'J' });
  for (const entry of TABLE_SPECS) {
    assert.equal(byNumber(rows, `T6-${entry.code.toLowerCase()}-select`).status, STATUS.FAIL, entry.table);
  }
});

test('aalto rajaa ajon: myöhempiin migraatioihin kuuluviin tauluihin ei lähetetä lausetta', async () => {
  const uudet = new Set(TABLE_SPECS.map(entry => entry.table));
  const kosketut = ledger => new Set(ledger.map(entry => entry.table).filter(table => uudet.has(table)));

  // Oletus = 0008 (aalto E): ei yhtään uutta taulua eikä uutta saraketta.
  const oletus = await runAgainst();
  assert.deepEqual([...kosketut(oletus.ledger)], []);
  assert.equal(oletus.summary.wave, 'E');
  assert.equal(oletus.ledger.some(entry => entry.payload && ('milestone_id' in entry.payload
    || 'life_area_id' in entry.payload)), false, 'myöhemmän migraation sarake lähti kantaan');

  for (const wave of ['F', 'G', 'H', 'I', 'J']) {
    const { ledger, summary, rows } = await runAgainst({}, null, { wave });
    const odotetut = TABLE_SPECS.filter(entry => inWave(entry, wave)).map(entry => entry.table);
    assert.deepEqual([...kosketut(ledger)].sort(), [...odotetut].sort(), `aalto ${wave}`);
    assert.equal(summary.verdict, 'PASS', `aalto ${wave}: ${rows.filter(r => r.status !== STATUS.PASS).map(r => r.test_no).join(', ')}`);
    const kokeillut = COMPOSITE_FK_PROBES.filter(probe => rows.some(entry => entry.test_no === `XV-${probe.key}`));
    assert.deepEqual(kokeillut.map(probe => probe.key),
      COMPOSITE_FK_PROBES.filter(probe => inWave(probe, wave)).map(probe => probe.key), `aalto ${wave}`);
  }
  // Aallossa I 0013:n sarakkeita (project_id, routine_id) ei kokeilla.
  const { rows: aaltoI } = await runAgainst({}, null, { wave: 'I' });
  assert.equal(byNumber(aaltoI, 'XV-time_entries.project_id'), undefined);
  assert.ok(byNumber(aaltoI, 'XV-time_entries.life_area_id'));
});

test('tuntematon tai liian vanha aalto keskeyttää ennen yhtäkään kyselyä', async () => {
  const db = makeDb();
  const ledger = [];
  const base = {
    a: makeClient(db, OWNER_A, {}, ledger), b: makeClient(db, USER_B, {}, ledger),
    anon: makeClient(db, null, {}, ledger), ownerAId: OWNER_A, userBId: USER_B,
    expectedTaskCount: TASK_COUNT, runId: 'aalto', today: '2026-09-05'
  };
  for (const wave of ['K', 'A', 'BASE', '', null]) {
    await assert.rejects(() => runAcceptance({ ...base, wave }), /aalto/, String(wave));
  }
  assert.deepEqual(ledger, []);
});

test('KRIITTINEN: A:n käynnissä oleva ajastin pysäyttää ajon ennen yhtäkään kirjoitusta', async () => {
  const { rows, summary, ledger, db } = await runAgainst({}, database => {
    database.running_timers.push({
      id: 'oikea-ajastin', user_id: OWNER_A, target_kind: 'none', started_at: '2026-09-05T06:00:00Z',
      paused_seconds: 0
    });
  }, { wave: 'J' });
  assert.equal(byNumber(rows, 'P2').status, STATUS.FAIL);
  assert.ok(summary.aborted);
  assert.equal(ledger.some(entry => entry.op !== 'select'), false, 'epäselvästä lähtötilasta kirjoitettiin');
  assert.deepEqual(db.running_timers.map(timer => timer.id), ['oikea-ajastin']);
});

test('MUTAATIO: edellisen ajon Suunta-jäänne pysäyttää ajon', async () => {
  const { rows, summary } = await runAgainst({}, database => {
    database.weekly_capacities.push({
      id: `${MARKER_PREFIX}vanha_a_wc`, user_id: OWNER_A, week_start: '1990-01-01', available_minutes: 600
    });
  }, { wave: 'I' });
  assert.equal(byNumber(rows, 'P0-wc-a').status, STATUS.FAIL);
  assert.ok(summary.aborted);
  assert.equal(rows.some(entry => entry.test_no.startsWith('T')), false);
});

test('KRIITTINEN: A:n oikea Suunta-data säilyy kaikissa vikatiloissa', async () => {
  // A:n omat alueet, kirjaukset ja katsaus ovat samoissa tauluissa kuin
  // testirivit. Siivous on sidottu etuliitteeseen, ja jokainen kirjoitus
  // kohdistuu testiriviin — myös silloin, kun kaikki kiellot pettävät.
  const oikeat = database => {
    database.life_areas.push({ id: 'oikea-alue', user_id: OWNER_A, name: 'Terapia', importance: 5 });
    database.time_entries.push({ id: 'oikea-kirjaus', user_id: OWNER_A, entry_date: '2026-09-04',
      minutes: 45, life_area_id: 'oikea-alue', note: 'yksityinen muistiinpano' });
    database.alignment_reviews.push({ id: 'oikea-katsaus', user_id: OWNER_A, week_start: '2026-08-31',
      snapshot: {}, reflection: 'oikea pohdinta' });
  };
  const kuva = database => JSON.stringify(['life_areas', 'time_entries', 'alignment_reviews']
    .map(table => database[table].filter(row => !String(row.id).startsWith(MARKER_PREFIX))));
  const odotettu = (() => { const db = makeDb(); oikeat(db); return kuva(db); })();

  for (const flaws of [{}, { selectUsingOff: true, updateUsingOff: true, deleteUsingOff: true,
    withCheckOff: true, anonAllowed: true }, { compositeFkOff: true }]) {
    const { db, rows } = await runAgainst(flaws, oikeat, { wave: 'J' });
    assert.equal(kuva(db), odotettu, `${JSON.stringify(flaws)}: A:n oikea data muuttui`);
    for (const secret of ['Terapia', 'yksityinen muistiinpano', 'oikea pohdinta']) {
      assert.equal(JSON.stringify(rows).includes(secret), false, `raportti kantaa arvon ${secret}`);
    }
  }
});

test('KRIITTINEN: aallossa J yksikään muuttava lause ei ole rajaamaton', async () => {
  const { ledger } = await runAgainst({}, null, { wave: 'J' });
  const muuttavat = ledger.filter(entry => entry.op === 'update' || entry.op === 'delete');
  assert.ok(muuttavat.length >= 100);
  for (const entry of muuttavat) {
    assert.ok(entry.filters.length >= 1, `rajaamaton ${entry.op} tauluun ${entry.table}`);
    for (const filter of entry.filters) {
      if (filter.kind !== 'like') continue;
      assert.ok(String(filter.value).startsWith(MARKER_PREFIX), `${entry.op}: ${filter.value}`);
    }
  }
});

test('KRIITTINEN: siivous tyhjentää 0009–0013:n taulut, ja jäännös huomataan', async () => {
  const { db, rows } = await runAgainst({}, null, { wave: 'J' });
  for (const entry of TABLE_SPECS) {
    assert.deepEqual(db[entry.table], [], `tauluun ${entry.table} jäi rivejä`);
  }
  const { rows: jaannos, summary } = await runAgainst({
    deleteDrops: row => String(row.id).endsWith('_b_te')
  }, null, { wave: 'J' });
  assert.equal(summary.verdict, 'FAIL');
  assert.equal(byNumber(jaannos, 'C12-te').status, STATUS.FAIL, 'B:n jäljelle jäänyttä kirjausta ei huomattu');
  assert.equal(byNumber(jaannos, 'C11-te').status, STATUS.PASS);
  assert.ok(rows.length > 0);
});

test('KRIITTINEN: 0009–0013:n testirivit kirjoittavat vain sovelluksen sarakkeita ja kaikki pakolliset', async () => {
  const { ALL_REPOSITORIES } = await import('../src/data/collectionsRepo.js');
  const ctx = { today: '2026-09-07', parents: { goalA: 'g-a', goalB: 'g-b' } };
  for (const entry of TABLE_SPECS) {
    const repo = ALL_REPOSITORIES.find(candidate => candidate.table === entry.table);
    assert.ok(repo, `${entry.table}: sovelluksella ei ole repositoriota`);
    // Sovelluksen sarakkeet: repositorion toRow normalisoidulle oliolle.
    const sovellus = Object.keys(repo.mapping.toRow(repo.mapping.normalize({ id: 'x' })));
    const pakolliset = requiredColumns(entry.table);
    assert.ok(pakolliset.length > 0 || entry.table === 'investments', `${entry.table}: jäsennys`);
    for (const variant of ['a', 'b', 'forged']) {
      const testirivi = entry.row(`${MARKER_PREFIX}t_${variant}`, variant, ctx);
      for (const sarake of Object.keys(testirivi)) {
        assert.ok(sovellus.includes(sarake), `${entry.table}.${sarake}: sovellus ei kirjoita tätä saraketta`);
      }
      for (const sarake of pakolliset) {
        assert.ok(testirivi[sarake] !== undefined && testirivi[sarake] !== null,
          `${entry.table}.${sarake}: NOT NULL ilman oletusta puuttuu testiriviltä`);
      }
      for (const kielletty of ['user_id', 'created_at', 'updated_at']) {
        assert.equal(kielletty in testirivi, false, `${entry.table}: ${kielletty}`);
      }
    }
  }
});

test('0009–0013: testirivit väistävät yksikäsitteisyyden rakenteella', () => {
  const ctx = { today: '2026-09-07', parents: { goalA: 'g-a', goalB: 'g-b' } };
  const ids = specIdsFor('20260926120000', 'LA');
  const la = TABLE_SPECS.find(entry => entry.table === 'life_areas');
  const names = ['a', 'b', 'forged'].map(variant => la.row(ids[variant], variant, ctx).name);
  assert.equal(new Set(names).size, 3, 'nimet törmäävät');
  for (const name of names) assert.ok(name.length <= 60, `nimi liian pitkä: ${name.length}`);
  for (const table of ['weekly_capacities', 'alignment_reviews']) {
    const entry = TABLE_SPECS.find(candidate => candidate.table === table);
    const weeks = ['a', 'b', 'forged'].map(variant => entry.row('x', variant, ctx).week_start);
    assert.equal(new Set(weeks).size, 3, `${table}: viikot törmäävät`);
    for (const week of weeks) {
      assert.equal(new Date(`${week}T00:00:00Z`).getUTCDay(), 1, `${table}: ${week} ei ole maanantai`);
      assert.ok(week < '2000-01-01', `${table}: viikko voisi olla käyttäjän oikea viikko`);
    }
  }
  // Tekokanta tuntee jokaisen 0009–0013:n yksikäsitteisyysrajoitteen
  // (pl. (user_id, id), joka ei rajaa mitään testin kannalta).
  for (const name of newMigrationFiles()) {
    for (const m of sql(name).matchAll(/alter table public\.(\w+)\s+add constraint (\w+) unique \(([^)]*)\)/g)) {
      const columns = m[3].split(',').map(column => column.trim());
      if (columns.join(',') === 'user_id,id') continue;
      assert.ok(YKSIKASITTEISYYDET.some(rule => rule.table === m[1] && rule.columns.join(',') === columns.join(',')),
        `${m[2]} (${columns.join(', ')}) puuttuu tekokannan mallista`);
    }
  }
});

test('tekokanta: NULL ei törmää yksikäsitteisyyteen, arvo törmää', async () => {
  const db = makeDb();
  const a = makeClient(db, OWNER_A);
  const eka = await a.from('life_areas').insert({ id: 'l1', name: 'Yksi', category_key: null }).select();
  const toka = await a.from('life_areas').insert({ id: 'l2', name: 'Kaksi', category_key: null }).select();
  assert.equal(eka.error, null);
  assert.equal(toka.error, null, 'kaksi kategoriatonta aluetta on sallittu');
  const sama = await a.from('life_areas').insert({ id: 'l3', name: 'Yksi', category_key: null }).select();
  assert.equal(sama.error?.code, '23505', 'saman niminen alue hyväksyttiin');
  await a.from('running_timers').insert({ id: 't1', started_at: '2026-09-05T06:00:00Z' }).select();
  const toinen = await a.from('running_timers').insert({ id: 't2', started_at: '2026-09-05T07:00:00Z' }).select();
  assert.equal(toinen.error?.code, '23505', 'toinen ajastin samalle käyttäjälle hyväksyttiin');
});

test('KRIITTINEN: tableSpecs ei lue sovelluksen porttitilaa', () => {
  const specs = readCode('tools/rls-acceptance/tableSpecs.js');
  assert.equal(/from\s+['"][^'"]*schema\.js['"]/.test(specs), false);
  assert.equal(/hasTable|\bTABLES\b/.test(specs), false);
  assert.match(specs, /from '\.\.\/release\/waves\.mjs'/, 'aallot luetaan julkaisutyökalusta');
});

test('TURVA: työkalun sivu lataa skriptit vain omasta originista ja valitsee aallon', async () => {
  const html = read('tools/rls-acceptance/index.html');
  const sources = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map(m => m[1]);
  assert.ok(sources.length >= 2);
  for (const src of sources) {
    assert.equal(/^(https?:)?\/\//i.test(src), false, `ulkoinen skripti työkalussa: ${src}`);
  }
  assert.ok(sources.some(src => /vendor\/supabase-js-\d+\.\d+\.\d+\.min\.js$/.test(src)),
    'supabase-js ladataan vendoroituna, ei CDN:stä');
  const options = [...html.matchAll(/<option value="([A-Z])"/g)].map(m => m[1]);
  assert.deepEqual(options, [...ACCEPTANCE_WAVES], 'aaltovalinta ei vastaa sallittuja aaltoja');
  const main = read('tools/rls-acceptance/main.js');
  assert.match(main, /wave:\s*\$\('wave'\)\.value/, 'valittu aalto ei päädy ajuriin');
  assert.match(html, /http-equiv="Content-Security-Policy"/, 'työkalun sivulla ei ole CSP:tä');
});

test('TURVA: tableSpecs ei sisällä avaimia eikä kirjoita vapaata tekstiä muistiinpanoihin', () => {
  const source = read('tools/rls-acceptance/tableSpecs.js');
  assert.equal(source.includes('service_role'), false);
  assert.equal(/eyJ[A-Za-z0-9_-]{20,}/.test(source), false);
  const ctx = { today: '2026-09-07', parents: { goalA: 'g-a', goalB: 'g-b' } };
  for (const entry of TABLE_SPECS) {
    const rivi = entry.row('x', 'a', ctx);
    for (const sarake of ['note', 'description', 'message', 'reason', 'reflection', 'proposal']) {
      if (sarake in rivi) assert.equal(rivi[sarake], null, `${entry.table}.${sarake}`);
    }
  }
});
