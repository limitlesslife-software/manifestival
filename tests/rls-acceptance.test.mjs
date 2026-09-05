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

import { runAcceptance, formatReport, idsFor, taskRow, profileRow, MARKER_PREFIX, STATUS }
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
    users: [OWNER_A, USER_B]
  };
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

      const ownerColumn = query.table === 'tasks' ? 'user_id' : 'id';
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
  // Neljä eri riviä, ei törmäyksiä.
  assert.equal(new Set(Object.values(ids)).size, 4);
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
  assert.equal(byNumber(rows, 'C5').status, STATUS.FAIL, 'A ei huomannut jäännöstä');
  assert.equal(byNumber(rows, 'C6').status, STATUS.FAIL, 'B ei huomannut jäännöstä');
  assert.equal(byNumber(rows, 'C4').status, STATUS.FAIL, 'rivimäärä ei palannut lähtöarvoon');

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
  assert.equal(byNumber(rows, 'C6').status, STATUS.FAIL,
    'B:n jäljelle jäänyttä riviä ei huomattu');
  assert.equal(byNumber(rows, 'C5').status, STATUS.PASS,
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
  assert.equal(byNumber(rows, 'C5').status, STATUS.PASS);
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
