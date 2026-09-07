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
         routineRow, exceptionRow,
         goalRow, projectRow, wellbeingRow, recurringExpenseRow,
         billRow, savingsGoalRow, auditRow, notificationPrefsRow,
         MARKER_PREFIX, STATUS }
  from '../tools/rls-acceptance/acceptance.js';
import { read, readCode } from './helpers/sources.mjs';
import { SUPABASE_ANON_KEY } from '../src/data/config.js';
import { TASK_COLUMNS_CORE, SERVER_OWNED_FIELDS } from '../src/lib/rows.js';

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
  { table: 'bills',              column: 'recurring_expense_id', parent: 'recurring_expenses' }
];

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
        // DEFAULT auth.uid(): kanta asettaa omistajan, ei asiakas.
        if (!(ownerColumn in row)) row[ownerColumn] = uid;

        // YHDISTELMAVIERASAVAIN (user_id, routine_id) -> routines(user_id, id).
        //
        // Tarkistus EI kulje RLS:n lapi — se on kannan oma, ja juuri
        // siksi se on ainoa este ristiinkiinnitykselle. Jos parina
        // (omistaja, rutiini) ei loydy routines-taulusta, kanta hylkaa
        // rivin koodilla 23503.
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

/** Aja ajuri tekokantaa vasten. */
async function runAgainst(flaws = {}, mutate = null) {
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
    today: '2026-09-05'
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

test('KRIITTINEN: rutiiniportit pysyvät kiinni hyväksyntätestistä huolimatta', async () => {
  // Työkalu puhuu kannalle suoraan eikä sovelluksen repositorion kautta,
  // joten hyväksyntätesti EI vaadi porttien avaamista — eikä sitä saa
  // tehdä ennen kuin testi on ajettu ja hyväksytty.
  const { TABLES } = await import('../src/data/schema.js');
  assert.equal(TABLES.routines, false, 'rutiiniportti on auki');
  assert.equal(TABLES.routineExceptions, false, 'poikkeusportti on auki');
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
  const fs = await import('node:fs');
  const migraatiot = ['0003_routines.sql', '0004_goals_projects.sql',
                      '0007_finance.sql'];

  const kannassa = [];
  for (const nimi of migraatiot) {
    const lahde = fs.readFileSync(`supabase/migrations/${nimi}`, 'utf8')
      .split('\n')
      .filter(line => !line.trim().startsWith('--'))
      .join('\n');

    for (const m of lahde.matchAll(
      /foreign key \(user_id,\s*(\w+)\)\s*references public\.(\w+)\s*\(user_id,\s*id\)/g)) {
      kannassa.push({ column: m[1], parent: m[2] });
    }
  }

  // Migraatiot luovat yhdeksän omistajuusviitettä: yksi 0003:ssa,
  // kuusi 0004:ssä ja kaksi 0007:ssä.
  assert.equal(kannassa.length, 9,
    `migraatioista löytyi ${kannassa.length} yhdistelmävierasavainta, odotettiin 9`);

  for (const { column, parent } of kannassa) {
    const loytyi = YHDISTELMAVIERASAVAIMET.some(
      fk => fk.column === column && fk.parent === parent);
    assert.ok(loytyi,
      `migraatio luo viitteen ${column} -> ${parent}, jota tekokanta ei tunne`);
  }

  for (const fk of YHDISTELMAVIERASAVAIMET) {
    const loytyi = kannassa.some(
      k => k.column === fk.column && k.parent === fk.parent);
    assert.ok(loytyi,
      `tekokanta tuntee viitteen ${fk.column} -> ${fk.parent}, jota migraatio ei luo`);
  }
});

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

test('KRIITTINEN: kaikki kahdeksan porttia pysyvät kiinni', async () => {
  // Työkalu puhuu kannalle suoraan eikä sovelluksen repositorion
  // kautta, joten hyväksyntätesti EI vaadi porttien avaamista — eikä
  // sitä saa tehdä ennen kuin testi on ajettu ja hyväksytty.
  const { TABLES } = await import('../src/data/schema.js');

  for (const portti of ['routines', 'routineExceptions', 'goals', 'projects',
                        'notificationPreferences', 'wellbeing', 'bills',
                        'recurringExpenses', 'savingsGoals', 'aiAudit']) {
    assert.equal(TABLES[portti], false, `portti ${portti} on auki`);
  }
});
