// TASK_EXTENDED_FIELDS — aktivoinnin valmius.
//
// MITÄ TÄSSÄ VARTIOIDAAN
//
// Migraatio 0002 on ajettu tuotantoon. Kuusi saraketta on olemassa, ja
// kaksi niistä on NOT NULL. Lippu `TASK_EXTENDED_FIELDS` on vielä
// `false`, joten sovellus ei kirjoita niihin. Sinä hetkenä kun lippu
// kääntyy, kaksi asiaa muuttuu kerralla:
//
//   1. jokainen tehtävän kirjoitus alkaa sisältää `priority`- ja
//      `scheduling_state`-sarakkeet
//   2. `scheduling_state` alkaa SÄILYÄ — siihen asti se on elänyt vain
//      selaimen muistissa ja kadonnut sivun latauksessa
//
// Kumpikin on kohta, jossa hiljainen vika muuttuu pysyväksi. Nimenomainen
// null NOT NULL -sarakkeeseen ei ota oletusarvoa käyttöön vaan hylkää
// rivin, ja väärä aikataulutustila jää kantaan pysyvästi.
//
// Nämä testit eivät ota yhteyttä mihinkään tietokantaan.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeTask, validateTask, SCHEDULING, schedulingStateOf, isMovableByScheduler,
  MAX_DESCRIPTION_LENGTH
} from '../src/domain/task.js';
import {
  toRow, fromRow, assertClientSafe,
  TASK_COLUMNS_CORE, TASK_COLUMNS_EXTENDED, SERVER_OWNED_FIELDS
} from '../src/lib/rows.js';
import { TASK_EXTENDED_FIELDS, taskColumns, volatileFields, isPersisted } from '../src/data/schema.js';
import { PRIORITY_KEYS, DEFAULT_PRIORITY } from '../src/domain/priority.js';
import { setClient } from '../src/data/client.js';
import { setUser, clearUser } from '../src/data/session.js';
import * as tasksRepo from '../src/data/tasksRepo.js';
import { buildUserDataExport, parseImport } from '../src/domain/dataExport.js';
import { read } from './helpers/sources.mjs';

const NEWLINE = String.fromCharCode(10);

const USER = { id: 'aaaaaaaa-0000-0000-0000-000000000001', email: 'a@example.com' };

/** Sarakkeet, jotka migraatio 0002 määrittelee NOT NULLiksi. */
const NOT_NULL_COLUMNS = ['priority', 'scheduling_state'];

// ---------------------------------------------------------------------
// Kiinnikkeet
// ---------------------------------------------------------------------

/**
 * Kirjaava tekoclient. Ottaa talteen TÄSMÄLLEEN sen payloadin, joka
 * lähtisi verkkoon — ei sitä, mitä kutsuja luuli lähettävänsä.
 */
function recordingClient(response = { data: null, error: null }) {
  const kirjatut = [];
  const chain = op => {
    const q = {
      op,
      eq() { return q; },
      neq() { return q; },
      select() { return q; },
      then(resolve, reject) {
        return Promise.resolve(response).then(resolve, reject);
      }
    };
    return q;
  };
  return {
    kirjatut,
    from() {
      return {
        insert(payload) { kirjatut.push({ op: 'insert', payload }); return chain('insert'); },
        update(payload) { kirjatut.push({ op: 'update', payload }); return chain('update'); },
        delete() { kirjatut.push({ op: 'delete', payload: null }); return chain('delete'); },
        select() { return chain('select'); }
      };
    }
  };
}

/** Tuotannon 36 riviä ovat tätä muotoa: 0002:n jälkeen, ilman sovelluksen kirjoituksia. */
function legacyRow(overrides = {}) {
  return {
    id: 'legacy-1', date: '2026-09-05', time: '08:30', end_time: null,
    title: 'vanha rivi', category: 'muu', note: null,
    completed: false, is_wake: false,
    // 0002 loi nämä: kaikki rivit saivat oletusarvon tai täytön.
    description: null, duration_minutes: null,
    priority: 'normaali', scheduling_state: 'manual',
    created_at: '2026-09-05T10:00:00.000Z', updated_at: '2026-09-05T10:00:00.000Z',
    ...overrides
  };
}

beforeEach(() => {
  clearUser();
  setClient(null);
});

// =====================================================================
// KENTTÄSOPIMUS
// =====================================================================

test('SOPIMUS: kuvaus on trimmattu teksti tai null, ei koskaan tyhjä merkkijono', () => {
  // Tyhjä merkkijono ja null tarkoittaisivat kannassa eri asiaa, vaikka
  // käyttäjälle ne näyttävät samalta: molemmat ovat "ei kuvausta".
  // Kahdesta esitystavasta samalle asialle seuraa aina vertailuvirheitä.
  assert.equal(normalizeTask({ description: '' }).description, null);
  assert.equal(normalizeTask({ description: '   ' }).description, null);
  assert.equal(normalizeTask({ description: '  teksti  ' }).description, 'teksti');
  assert.equal(normalizeTask({}).description, null);

  const pitka = 'x'.repeat(MAX_DESCRIPTION_LENGTH + 500);
  assert.equal(normalizeTask({ description: pitka }).description.length, MAX_DESCRIPTION_LENGTH);
});

test('SOPIMUS: kesto on positiivinen kokonaisluku tai null', () => {
  assert.equal(normalizeTask({ durationMinutes: 45 }).durationMinutes, 45);
  assert.equal(normalizeTask({ durationMinutes: '45' }).durationMinutes, 45);
  assert.equal(normalizeTask({ durationMinutes: 44.6 }).durationMinutes, 45);
  for (const kelvoton of [0, -5, 'abc', null, undefined, NaN, Infinity]) {
    assert.equal(normalizeTask({ durationMinutes: kelvoton }).durationMinutes, null,
      `kelvoton kesto ${kelvoton} ei muuttunut nulliksi`);
  }
});

test('SOPIMUS: keston rajat ovat samat domainissa ja kannassa', () => {
  // Kanta hylkää yli vuorokauden keston rajoitteella
  // tasks_duration_minutes_check. Jos domainin raja eroaisi, käyttäjä
  // saisi lomakkeesta läpi arvon, jonka kanta hylkää — ja virhe
  // näyttäisi tallennusvirheeltä eikä syöttövirheeltä.
  const migraatio = read('supabase/migrations/0002_task_domain_fields.sql');
  const raja = /duration_minutes > 0 and duration_minutes <= (\d+)/.exec(migraatio);
  assert.ok(raja, 'kannan kestorajaa ei löytynyt migraatiosta');

  const yla = Number(raja[1]);
  assert.equal(validateTask({ title: 't', date: '2026-09-05', durationMinutes: yla }).valid, true,
    `domain hylkää keston ${yla}, jonka kanta hyväksyy`);
  assert.equal(validateTask({ title: 't', date: '2026-09-05', durationMinutes: yla + 1 }).valid, false,
    `domain hyväksyy keston ${yla + 1}, jonka kanta hylkää`);
});

test('SOPIMUS: prioriteetin arvot ovat samat domainissa ja kannassa', () => {
  const migraatio = read('supabase/migrations/0002_task_domain_fields.sql');
  const check = /check \(priority in \(([^)]*)\)\)/.exec(migraatio);
  assert.ok(check, 'kannan prioriteettirajoitetta ei löytynyt');

  const kannassa = [...check[1].matchAll(/'([^']+)'/g)].map(m => m[1]).sort();
  assert.deepEqual([...PRIORITY_KEYS].sort(), kannassa);

  // Tuntematon arvo korvautuu oletuksella eikä pääse kantaan.
  assert.equal(normalizeTask({ priority: 'kiireellinen' }).priority, DEFAULT_PRIORITY);
  assert.equal(normalizeTask({ priority: null }).priority, DEFAULT_PRIORITY);
  assert.equal(normalizeTask({}).priority, DEFAULT_PRIORITY);
  assert.ok(kannassa.includes(DEFAULT_PRIORITY));
});

test('SOPIMUS: aikataulutuksen tilan arvot ovat samat domainissa ja kannassa', () => {
  const migraatio = read('supabase/migrations/0002_task_domain_fields.sql');
  const check = /check \(scheduling_state in \(([^)]*)\)\)/.exec(migraatio);
  assert.ok(check, 'kannan tilarajoitetta ei löytynyt');

  const kannassa = [...check[1].matchAll(/'([^']+)'/g)].map(m => m[1]).sort();
  assert.deepEqual(Object.values(SCHEDULING).sort(), kannassa);
});

test('SOPIMUS: aikataulutuksen tila johdetaan kellonajasta', () => {
  // Kellonajaton tehtävä ei ole aikataulutettu, oli kutsujan mielipide
  // mikä tahansa. Kellonajallinen on käyttäjän päätös, ellei nimenomaan
  // pyydetä automaatin sijoitusta.
  assert.equal(normalizeTask({ time: null }).schedulingState, SCHEDULING.UNSCHEDULED);
  assert.equal(normalizeTask({ time: null, schedulingState: SCHEDULING.AUTO }).schedulingState,
    SCHEDULING.UNSCHEDULED);
  assert.equal(normalizeTask({ time: '09:00' }).schedulingState, SCHEDULING.MANUAL);
  assert.equal(normalizeTask({ time: '09:00', schedulingState: SCHEDULING.AUTO }).schedulingState,
    SCHEDULING.AUTO);
  assert.equal(normalizeTask({ time: '09:00', schedulingState: 'roskaa' }).schedulingState,
    SCHEDULING.MANUAL);
});

test('SOPIMUS: automaatti saa siirtää vain omia sijoituksiaan', () => {
  const kayttajanPaatos = normalizeTask({ time: '09:00' });
  const automaatinSijoitus = normalizeTask({ time: '09:00', schedulingState: SCHEDULING.AUTO });
  const aikatauluttamaton = normalizeTask({ time: null });

  assert.equal(isMovableByScheduler(kayttajanPaatos), false, 'automaatti siirtäisi käyttäjän päätöksen');
  assert.equal(isMovableByScheduler(automaatinSijoitus), true);
  assert.equal(isMovableByScheduler(aikatauluttamaton), true);
  assert.equal(schedulingStateOf(kayttajanPaatos), SCHEDULING.MANUAL);
});

// =====================================================================
// KIRJOITUSPOLUT — normalisointi on rakenne, ei sopimus
// =====================================================================

test('KRIITTINEN: normalizeTask on idempotentti', () => {
  // Repositorio normalisoi uudelleen jo normalisoidun olion. Jos se
  // muuttaisi arvoja, tallennus muuttaisi tehtävää huomaamatta.
  const kerran = normalizeTask({
    id: 'x', title: '  Otsikko  ', date: '2026-09-05', time: '09:00',
    description: ' kuvaus ', durationMinutes: '45.4', priority: 'korkea',
    schedulingState: SCHEDULING.AUTO, note: 'muistiinpano', isWake: 1
  });
  assert.deepEqual(normalizeTask(kerran), kerran);
  assert.deepEqual(normalizeTask(normalizeTask(kerran)), kerran);
});

test('KRIITTINEN: repositorio normalisoi itse — kutsuja ei voi ohittaa sitä', async () => {
  // Aiemmin tämä oli sopimus: "jokainen kutsupaikka ajaa normalizeTaskin".
  // Se piti paikkansa, mutta sopimus ei ole rakenne. Uusi kutsupaikka —
  // tuonti, ääniohjaus, automaatti — voisi rakentaa olion käsin, ja
  // toRow lähettäisi normalisoimattomasta oliosta priority: null.
  // NOT NULL -sarake hylkää nimenomaisen nullin, joten JOKAINEN
  // tallennus epäonnistuisi.
  //
  // Normalisointi todetaan ARVOISTA, ei lähdekoodista: raaka olio
  // sisältää arvoja, jotka näkyvät payloadissa eri muodossa riippuen
  // siitä, ajettiinko normalizeTask vai ei. Tämä toimii myös lipun
  // ollessa false, koska kaikki kolme kenttää ovat ydinsarakkeissa.
  setUser(USER);
  const client = recordingClient();
  setClient(client);

  const raaka = {
    id: 'raaka',
    date: '2026-09-05',
    title: '   Reunavälit   ',
    completed: 'kylla',        // ei boolean
    time: 'ei-kellonaika'      // ei kelvollinen
  };

  await tasksRepo.insertTask(raaka);
  await tasksRepo.updateTask(raaka);

  assert.equal(client.kirjatut.length, 2);
  for (const { op, payload } of client.kirjatut) {
    assert.equal(payload.title, 'Reunavälit',
      `${op}: otsikkoa ei trimmattu — olio ei kulkenut normalizeTaskin läpi`);
    assert.equal(payload.completed, true,
      `${op}: completed lähti muodossa ${JSON.stringify(payload.completed)} eikä booleanina`);
    assert.equal(payload.time, null,
      `${op}: kelvoton kellonaika lähti kantaan sellaisenaan`);

    // Eikä yksikään lähetetty sarake ole kelvoton NOT NULL -sarake.
    for (const sarake of NOT_NULL_COLUMNS) {
      if (!(sarake in payload)) continue;
      assert.notEqual(payload[sarake], null,
        `${op}: ${sarake} lähtisi nullina ja kanta hylkäisi rivin`);
    }
  }

  // Ja sama takuu koskee laajennettua sarakejoukkoa, jota lippu käyttää
  // kun se on true. Sitä ei voi ajaa repositorion läpi testissä, koska
  // lippu on vakio — mutta payloadFor on täsmälleen tämä yhdistelmä.
  const laajennettu = toRow(normalizeTask(raaka), TASK_COLUMNS_EXTENDED);
  for (const sarake of NOT_NULL_COLUMNS) {
    assert.notEqual(laajennettu[sarake], null,
      `laajennettu payload lähettäisi ${sarake}: null`);
  }
  assert.equal(laajennettu.title, 'Reunavälit');
});

test('KRIITTINEN: normalisoimaton olio tuottaa kelvollisen laajennetun payloadin', () => {
  // Sama asia suoraan sarakejoukolla, jota lippu käyttää kun se on true.
  const raaka = { id: 'x', date: '2026-09-05', title: 'x' };
  const rivi = toRow(normalizeTask(raaka), TASK_COLUMNS_EXTENDED);

  for (const sarake of NOT_NULL_COLUMNS) {
    assert.notEqual(rivi[sarake], null, `${sarake} on null`);
    assert.notEqual(rivi[sarake], undefined, `${sarake} puuttuu`);
  }
  assert.equal(rivi.priority, DEFAULT_PRIORITY);
  assert.equal(rivi.scheduling_state, SCHEDULING.UNSCHEDULED);
});

test('KRIITTINEN: vain tasksRepo kirjoittaa tasks-tauluun', () => {
  // Kirjoituspolkujen määrä on turvallisuusluku: jokainen niistä on
  // paikka, jossa normalisointi voi jäädä tekemättä.
  const kirjoittajat = ['src/data/tasksRepo.js', 'src/data/collectionsRepo.js',
                        'src/data/profileRepo.js', 'src/data/notificationPrefsRepo.js']
    .filter(file => /const TABLE = 'tasks'/.test(read(file)));

  assert.deepEqual(kirjoittajat, ['src/data/tasksRepo.js'],
    'tasks-tauluun kirjoitetaan useammasta kuin yhdestä moduulista');

  // Ja jokainen koko rivin kirjoitus kulkee payloadForin kautta.
  const repo = read('src/data/tasksRepo.js');
  // Rivi kerrallaan: kirjoituslause mahtuu tässä tiedostossa yhdelle
  // riville, ja rivikohtainen haku välttää sulkujen laskennan.
  const kirjoitukset = repo.split(NEWLINE)
    .map(line => /\.(insert|update)\((.+)\)$/.exec(line.trim()))
    .filter(Boolean)
    .map(m => ({ op: m[1], arg: m[2].trim() }));

  assert.ok(kirjoitukset.length >= 2, `kirjoituksia löytyi ${kirjoitukset.length}`);
  for (const { op, arg } of kirjoitukset) {
    // Sallittua on kaksi muotoa: koko rivin kirjoitus payloadForin kautta,
    // tai osittainen kirjoitus yhteen tunnettuun sarakkeeseen.
    const kokoRivi = arg.startsWith('payloadFor(');
    const osittainen = /^\{ ?(completed|is_wake)/.test(arg);
    assert.ok(kokoRivi || osittainen,
      `${op}(${arg}) ei kulje payloadForin kautta eikä ole osittainen kirjoitus`);
  }
});

// =====================================================================
// AIKALEIMAT
// =====================================================================

test('KRIITTINEN: client ei kirjoita aikaleimoja koskaan', () => {
  // created_at saa arvonsa oletusarvosta ja updated_at liipaisimesta.
  // Jos client kirjoittaisi ne, se voisi vierittää aikaleimoja
  // taaksepäin vanhentuneella tilannekuvalla.
  for (const sarakkeet of [TASK_COLUMNS_CORE, TASK_COLUMNS_EXTENDED]) {
    for (const kielletty of SERVER_OWNED_FIELDS) {
      assert.equal(sarakkeet.includes(kielletty), false,
        `${kielletty} on sarakelistassa — client kirjoittaisi sen`);
    }
  }

  const tehtava = normalizeTask({
    id: 'x', date: '2026-09-05', title: 'x',
    createdAt: '1999-01-01T00:00:00Z', updatedAt: '1999-01-01T00:00:00Z'
  });
  const rivi = toRow(tehtava, TASK_COLUMNS_EXTENDED);

  assert.equal('created_at' in rivi, false);
  assert.equal('updated_at' in rivi, false);
  assert.doesNotThrow(() => assertClientSafe(rivi));
});

test('KRIITTINEN: vanhentunut olio ei voi vierittää aikaleimoja taaksepäin', () => {
  // Kannasta luettu rivi tuo aikaleimat mukanaan. Jos sama olio
  // kirjoitetaan takaisin, aikaleimojen on jäätävä pois payloadista —
  // muuten vanha välilehti kirjoittaisi tuoreen arvon päälle.
  const kannasta = fromRow(legacyRow({
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-09-05T10:00:00.000Z'
  }));

  assert.equal(kannasta.createdAt, '2026-01-01T00:00:00.000Z', 'client ei lue created_at-arvoa');
  assert.equal(kannasta.updatedAt, '2026-09-05T10:00:00.000Z', 'client ei lue updated_at-arvoa');

  const takaisin = toRow(normalizeTask(kannasta), TASK_COLUMNS_EXTENDED);
  assert.equal('created_at' in takaisin, false, 'created_at palaisi kantaan');
  assert.equal('updated_at' in takaisin, false, 'updated_at palaisi kantaan');
});

test('aikaleimat puuttuvat siististi, jos migraatiota ei ole ajettu', () => {
  // fromRow ajetaan myös ennen 0002:ta luettuihin riveihin (esim.
  // vanhentunut välilehti). Puuttuva sarake ei saa tuottaa undefinedia,
  // jota käyttöliittymä ei osaisi näyttää.
  const ennen = fromRow({
    id: 'x', date: '2026-09-05', title: 'x', completed: false, is_wake: false
  });
  assert.equal(ennen.createdAt, null);
  assert.equal(ennen.updatedAt, null);
});

// =====================================================================
// LIPUN KOLME TILAA
// =====================================================================

test('TILA B: lippu on päällä ja kirjoitetaan täsmälleen laajennetut sarakkeet', () => {
  // Migraatio 0002 on ajettu ja todennettu, joten lippu on true.
  assert.equal(TASK_EXTENDED_FIELDS, true, 'lippu ei ole päällä');
  assert.deepEqual([...taskColumns()], [...TASK_COLUMNS_EXTENDED]);

  const rivi = toRow(normalizeTask({ id: 'x', date: '2026-09-05', time: '09:00', title: 'x',
    description: 'kuvaus', durationMinutes: 30, priority: 'korkea' }), taskColumns());

  assert.deepEqual(Object.keys(rivi).sort(), [...TASK_COLUMNS_EXTENDED].sort());
  for (const laajennettu of ['description', 'duration_minutes', 'priority', 'scheduling_state']) {
    assert.ok(laajennettu in rivi, `${laajennettu} ei lähde kantaan, vaikka lippu on päällä`);
  }
  // Palvelimen omistamat kentät eivät ole mukana edes nyt.
  assert.doesNotThrow(() => assertClientSafe(rivi));
});

test('HÄTÄVARA: lipun kääntäminen takaisin palauttaa ydinsarakkeet', () => {
  // Lipun voi kääntää takaisin false, jos jokin menee pieleen. Sarakkeet
  // jäävät kantaan koskemattomina ja sovellus vain lakkaa kirjoittamasta
  // niihin. Tämä testaa sen polun, jota taskColumns() käyttäisi silloin.
  const rivi = toRow(normalizeTask({
    id: 'x', date: '2026-09-05', title: 'x',
    description: 'kuvaus', durationMinutes: 30, priority: 'korkea'
  }), TASK_COLUMNS_CORE);

  assert.deepEqual(Object.keys(rivi).sort(), [...TASK_COLUMNS_CORE].sort());
  for (const laajennettu of ['description', 'duration_minutes', 'priority', 'scheduling_state']) {
    assert.equal(laajennettu in rivi, false,
      `${laajennettu} lähtisi kantaan hätävarapolulla`);
  }
});

test('TILA B: yksikään kenttä ei ole enää haihtuva', () => {
  // Lipun ollessa false käyttöliittymä kertoi, ettei kuvaus, kesto,
  // prioriteetti eikä aikataulutuksen tila säily. Nyt ne säilyvät, joten
  // varoitusta ei saa enää näyttää — se olisi valhe toiseen suuntaan.
  assert.deepEqual(volatileFields(), []);
  for (const kentta of ['description', 'durationMinutes', 'priority', 'schedulingState']) {
    assert.equal(isPersisted(kentta), true, `${kentta} ei muka säily`);
  }
});

test('TILA B: lipun ollessa true kirjoitetaan täsmälleen laajennetut sarakkeet', () => {
  // Lippua ei voi kääntää testissä (se on vakio), joten testataan sitä
  // sarakejoukkoa, jonka taskColumns() palauttaa kun lippu on true.
  const rivi = toRow(normalizeTask({
    id: 'x', date: '2026-09-05', time: '09:00', title: 'x',
    description: 'kuvaus', durationMinutes: 30, priority: 'korkea'
  }), TASK_COLUMNS_EXTENDED);

  assert.deepEqual(Object.keys(rivi).sort(), [...TASK_COLUMNS_EXTENDED].sort());
  assert.equal(rivi.description, 'kuvaus');
  assert.equal(rivi.duration_minutes, 30);
  assert.equal(rivi.priority, 'korkea');
  assert.equal(rivi.scheduling_state, SCHEDULING.MANUAL);
  assert.doesNotThrow(() => assertClientSafe(rivi));
});

test('TILA C: puuttuva sarake tuottaa näkyvän virheen, ei hiljaista onnistumista', async () => {
  // Jos lippu käännettäisiin ilman migraatiota, PostgREST vastaisi
  // koodilla PGRST204. Sen on näyttävä käyttäjälle: hiljainen
  // epäonnistuminen tarkoittaisi, että sovellus väittää tallentaneensa
  // eikä käyttäjä huomaa menettäneensä työtään.
  setUser(USER);
  setClient(recordingClient({
    data: null,
    error: { code: 'PGRST204', message: "Could not find the 'priority' column" }
  }));

  const tulos = await tasksRepo.insertTask(normalizeTask({
    id: 'x', date: '2026-09-05', title: 'x'
  }));

  assert.equal(tulos.ok, false, 'puuttuva sarake näytti onnistumiselta');
  assert.ok(tulos.error, 'virhe ei päätynyt kutsujalle');
  assert.equal(tulos.error.code, 'tasks.insert');
});

// =====================================================================
// VIRHEIDEN NÄKYVYYS
// =====================================================================

test('KRIITTINEN: jokainen kannan hylkäys päätyy kutsujalle virheenä', async () => {
  setUser(USER);
  const tehtava = normalizeTask({ id: 'x', date: '2026-09-05', title: 'x' });

  const virheet = [
    ['23502', 'null value in column violates not-null constraint'],
    ['23514', 'new row violates check constraint'],
    ['42501', 'new row violates row-level security policy'],
    ['PGRST301', 'JWT expired'],
    ['08006', 'connection failure']
  ];

  for (const [code, message] of virheet) {
    setClient(recordingClient({ data: null, error: { code, message } }));

    const lisays = await tasksRepo.insertTask(tehtava);
    assert.equal(lisays.ok, false, `${code}: lisäys näytti onnistuneen`);

    const muutos = await tasksRepo.updateTask(tehtava);
    assert.equal(muutos.ok, false, `${code}: muutos näytti onnistuneen`);

    const poisto = await tasksRepo.deleteTask('x');
    assert.equal(poisto.ok, false, `${code}: poisto näytti onnistuneen`);
  }
});

test('KRIITTINEN: verkkopoikkeus ei näytä onnistumiselta', async () => {
  setUser(USER);
  setClient({
    from() { throw new Error('verkko poikki'); }
  });

  const tulos = await tasksRepo.insertTask(normalizeTask({
    id: 'x', date: '2026-09-05', title: 'x'
  }));
  assert.equal(tulos.ok, false);
  assert.ok(tulos.error);
});

test('KRIITTINEN: kirjautumaton kirjoitus kaatuu ennen verkkoa', async () => {
  clearUser();
  const client = recordingClient();
  setClient(client);

  const tulos = await tasksRepo.updateTask(normalizeTask({
    id: 'x', date: '2026-09-05', title: 'x'
  }));

  assert.equal(tulos.ok, false, 'rajaamaton kirjoitus lähti liikkeelle');
  assert.equal(client.kirjatut.some(k => k.op === 'update' && k.payload), true,
    'update-payload rakennettiin ennen requireUserId-kutsua — hyväksyttävää, kunhan kysely ei lähtenyt');
});

// =====================================================================
// VANHA DATA
// =====================================================================

test('VANHA DATA: tuotannon 36 riviä luetaan ja kirjoitetaan takaisin ehjinä', () => {
  // Tuotannossa on 1 aikatauluttamaton ja 35 manuaalista riviä.
  const fixtuurit = [
    ['kellonajallinen', legacyRow({ time: '08:30', scheduling_state: 'manual' })],
    ['kellonajaton', legacyRow({ id: 'legacy-2', time: null, scheduling_state: 'unscheduled' })],
    ['valmis', legacyRow({ id: 'legacy-3', completed: true })],
    ['heratys', legacyRow({ id: 'legacy-4', is_wake: true })]
  ];

  for (const [nimi, rivi] of fixtuurit) {
    const tehtava = normalizeTask(fromRow(rivi));

    assert.equal(tehtava.id, rivi.id, `${nimi}: tunniste katosi`);
    assert.equal(tehtava.title, rivi.title, `${nimi}: otsikko katosi`);
    assert.equal(tehtava.completed, rivi.completed, `${nimi}: valmis-tila katosi`);
    assert.equal(tehtava.isWake, rivi.is_wake, `${nimi}: herätysmerkintä katosi`);
    assert.equal(tehtava.schedulingState, rivi.scheduling_state,
      `${nimi}: aikataulutustila muuttui lukemisessa`);

    const takaisin = toRow(tehtava, TASK_COLUMNS_EXTENDED);
    assert.equal(takaisin.priority, rivi.priority, `${nimi}: prioriteetti muuttui`);
    assert.equal(takaisin.scheduling_state, rivi.scheduling_state,
      `${nimi}: aikataulutustila muuttui kirjoituksessa`);
    assert.notEqual(takaisin.priority, null);
    assert.notEqual(takaisin.scheduling_state, null);
  }
});

test('VANHA DATA: kellonajaton rivi pysyy aikatauluttamattomana', () => {
  // Tuotannossa on täsmälleen yksi tällainen. Jos se muuttuisi
  // lukiessa manuaaliseksi, automaatti ei ehdottaisi sille enää aikaa.
  const tehtava = normalizeTask(fromRow(
    legacyRow({ time: null, scheduling_state: 'unscheduled' })));

  assert.equal(tehtava.schedulingState, SCHEDULING.UNSCHEDULED);
  assert.equal(isMovableByScheduler(tehtava), true, 'automaatti ei enää koskisi riviin');
});

test('VANHA DATA: rikkinäinen olio ei kaada eikä tuota kelvotonta riviä', () => {
  const roskaa = [
    {}, null, undefined,
    { id: 5, title: 12, date: 'ei-paiva', priority: {}, durationMinutes: 'x',
      schedulingState: [], description: 0, completed: 'kylla' }
  ];

  for (const syote of roskaa) {
    const tehtava = normalizeTask(syote ?? {});
    const rivi = toRow(tehtava, TASK_COLUMNS_EXTENDED);

    assert.ok(PRIORITY_KEYS.includes(rivi.priority),
      `kelvoton prioriteetti: ${rivi.priority}`);
    assert.ok(Object.values(SCHEDULING).includes(rivi.scheduling_state),
      `kelvoton aikataulutustila: ${rivi.scheduling_state}`);
    assert.ok(rivi.duration_minutes === null || Number.isInteger(rivi.duration_minutes));
    assert.ok(rivi.description === null || typeof rivi.description === 'string');
  }
});

// =====================================================================
// ISTUNNON RAJA
// =====================================================================

test('KRIITTINEN: laajennetut kentät eivät säily istunnosta toiseen', async () => {
  // Aiemmin tässä projektissa on vuotanut dataa käyttäjältä toiselle
  // moduulitasoisen tilan kautta. Laajennetut kentät ovat tasks-taulussa
  // eivätkä muistivarastossa, joten RLS suojaa niitä palvelinpuolella —
  // mutta vain jos client ei säilytä niitä uloskirjautumisen yli.
  const { resetState, getState, setTasks } = await import('../src/app/state.js');

  setTasks([normalizeTask({
    id: 'a-1', date: '2026-09-05', title: 'A:n salainen kuvaus',
    description: 'ei saa näkyä B:lle', priority: 'korkea'
  })]);
  assert.equal(getState().tasks.length, 1);

  resetState();

  assert.deepEqual(getState().tasks, [], 'tehtävät jäivät uloskirjautumisen yli');
  const sarjallistettu = JSON.stringify(getState());
  assert.equal(sarjallistettu.includes('ei saa näkyä'), false,
    'kuvaus jäi sovelluksen tilaan');
});

test('KRIITTINEN: laajennettuja kenttiä ei talleteta selaimeen', () => {
  // localStorage on laitekohtainen eikä käyttäjäkohtainen: sinne
  // tallennettu kuvaus näkyisi seuraavalle kirjautujalle.
  const laiteTallennus = read('src/data/preferences.js');
  for (const kentta of ['description', 'duration_minutes', 'priority', 'scheduling_state']) {
    assert.equal(laiteTallennus.includes(kentta), false,
      `${kentta} päätyy laitekohtaiseen tallennukseen`);
  }
});

// =====================================================================
// VIENTI JA TUONTI
// =====================================================================

test('VIENTI: laajennetut kentät säilyvät viennissä', () => {
  const tehtava = normalizeTask({
    id: 'x', date: '2026-09-05', time: '09:00', title: 'x',
    description: 'kuvaus', durationMinutes: 30, priority: 'korkea'
  });

  const vienti = buildUserDataExport({ tasks: [tehtava] });
  const viety = vienti.data.tasks[0];

  assert.equal(viety.description, 'kuvaus');
  assert.equal(viety.durationMinutes, 30);
  assert.equal(viety.priority, 'korkea');
  assert.equal(viety.schedulingState, SCHEDULING.MANUAL);
  assert.equal(vienti.counts.tasks, 1);
});

test('TUONTI: vanha vienti ilman laajennettuja kenttiä normalisoituu turvallisesti', () => {
  // Ennen 0002:ta tehty vienti ei sisällä näitä kenttiä lainkaan.
  const vanha = JSON.stringify({
    kind: 'manifestival-export',
    manifestivalExportVersion: 1,
    data: { tasks: [{ id: 'vanha', date: '2026-09-05', title: 'vanha tehtävä' }] }
  });

  const tuotu = parseImport(vanha);
  assert.equal(tuotu.status, 'ok', `tuonti epäonnistui: ${tuotu.reason || tuotu.status}`);

  const tehtava = normalizeTask(tuotu.parsed.data.tasks[0]);
  const rivi = toRow(tehtava, TASK_COLUMNS_EXTENDED);

  for (const sarake of NOT_NULL_COLUMNS) {
    assert.notEqual(rivi[sarake], null,
      `vanhasta viennistä tuotu rivi lähtisi nullilla sarakkeessa ${sarake}`);
  }
});

// =====================================================================
// AUTOMAATIN EHDOTUS
// =====================================================================

test('KRIITTINEN: ehdotuksen hyväksyminen merkitsee tehtävän automaatin sijoittamaksi', async () => {
  // LÖYTYNYT VIKA, JOTA TÄMÄ VARTIOI
  //
  // acceptProposal() antaa editTaskille sekä ajan että tilan AUTO.
  // editTask johti tilan ajasta: "aika mukana -> käyttäjän päätös ->
  // MANUAL". Johdettu sääntö ylikirjoitti nimenomaisen pyynnön, joten
  // ehdotuksen hyväksyminen merkitsi tehtävän käyttäjän omaksi
  // päätökseksi — ja isMovableByScheduler() kielsi automaatilta pääsyn
  // omaan sijoitukseensa lopullisesti.
  //
  // Ennen migraatiota 0002 vika oli näkymätön: kenttä ei säilynyt
  // tallennuksen yli. Lipun kääntämisen jälkeen se olisi pysyvää dataa
  // jokaisessa hyväksytyssä ehdotuksessa.
  const { acceptProposal } = await import('../src/app/actions.js');
  const { resetState, getState, setTasks } = await import('../src/app/state.js');

  setUser(USER);
  setClient(recordingClient());
  resetState();

  setTasks([normalizeTask({
    id: 'ehdotettava', date: '2026-09-05', title: 'siirrettävä', time: null
  })]);

  const tulos = await acceptProposal({
    taskId: 'ehdotettava', time: '10:00', endTime: '11:00', durationMinutes: 60
  });
  assert.equal(tulos.ok, true, `hyväksyminen epäonnistui: ${JSON.stringify(tulos.errors)}`);

  const jalkeen = getState().tasks.find(t => t.id === 'ehdotettava');
  assert.equal(jalkeen.schedulingState, SCHEDULING.AUTO,
    'hyväksytty ehdotus merkittiin käyttäjän omaksi päätökseksi');
  assert.equal(isMovableByScheduler(jalkeen), true,
    'automaatti ei saa enää siirtää omaa sijoitustaan');
  assert.equal(jalkeen.time, '10:00');

  resetState();
});

test('käyttäjän tekemä ajan muutos on yhä aina manuaalinen päätös', async () => {
  // Korjaus ei saa avata porttia toiseen suuntaan: lomake ei lähetä
  // schedulingStatea, joten johdettu sääntö pätee siihen entiseen tapaan.
  const { editTask } = await import('../src/app/actions.js');
  const { resetState, getState, setTasks } = await import('../src/app/state.js');

  setUser(USER);
  setClient(recordingClient());
  resetState();

  setTasks([normalizeTask({
    id: 'kayttajan', date: '2026-09-05', title: 'oma', time: '09:00',
    schedulingState: SCHEDULING.AUTO
  })]);

  await editTask('kayttajan', { time: '11:00' });

  const jalkeen = getState().tasks.find(t => t.id === 'kayttajan');
  assert.equal(jalkeen.schedulingState, SCHEDULING.MANUAL,
    'käyttäjän siirtämä tehtävä jäisi automaatin siirreltäväksi');
  assert.equal(isMovableByScheduler(jalkeen), false);

  // Ja ajan poisto tekee tehtävästä aikatauluttamattoman.
  await editTask('kayttajan', { time: null });
  assert.equal(getState().tasks.find(t => t.id === 'kayttajan').schedulingState,
    SCHEDULING.UNSCHEDULED);

  resetState();
});

// =====================================================================
// JULKAISUPAKETIN PORTTI
// =====================================================================

test('KRIITTINEN: julkaistava paketti sisältää aktivoidun lipun eikä yhtään vanhentunutta kopiota', async () => {
  // GATE D julkaisee koodin lippu YHÄ FALSE. Aiemmat testit tarkistavat
  // tuodun vakion arvon; tämä tarkistaa TIEDOSTOT, jotka oikeasti
  // tarjoillaan. Ero on olennainen: tuotu arvo tulee siitä samasta
  // tiedostosta, mutta julkaisuun voi päätyä myös koontituloksia, joita
  // yksikään import ei koske — esimerkiksi APK:n assetit.
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { ROOT, browserModules, serverModules } = await import('./helpers/sources.mjs');

  // Vercel tarjoilee repon juuren; .vercelignore sulkee pois tools/.
  const julkaistavat = [
    ...browserModules(),
    ...serverModules(),
    'index.html',
    'sw.js'
  ];

  // Koontitulokset eivät ole versionhallinnassa, mutta ne päätyvät
  // APK:hon. Jos ne ovat olemassa, ne kuuluvat samaan porttiin.
  const koonnit = [
    'dist/src/data/schema.js',
    'android/app/src/main/assets/public/src/data/schema.js'
  ].filter(rel => fs.existsSync(path.join(ROOT, rel)));

  const kaikki = [...julkaistavat, ...koonnit];
  assert.ok(kaikki.length > 20, `julkaistavia tiedostoja löytyi vain ${kaikki.length}`);

  // Vanhentunut kopio on nyt se vaara, ei aktivoitu lippu. Jos jokin
  // julkaistava tiedosto sisältäisi yhä `= false`, sovellus lakkaisi
  // kirjoittamasta laajennettuja kenttiä juuri siellä missä se kopio
  // ladataan — ja vika näkyisi vasta kun käyttäjä huomaa kuvauksen
  // kadonneen.
  const vanhentunut = /TASK_EXTENDED_FIELDS\s*=\s*false/;
  for (const file of julkaistavat) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.equal(vanhentunut.test(source), false,
      `${file} sisältää vanhentuneen lipun arvon false`);
  }

  // Ja määrittelyjä on tasan yksi, arvo false. Kaksi määrittelyä
  // tarkoittaisi, ettei kukaan tiedä kumpi on voimassa.
  const maarittelyt = kaikki.filter(file =>
    /export const TASK_EXTENDED_FIELDS\s*=/.test(fs.readFileSync(path.join(ROOT, file), 'utf8')));

  assert.equal(maarittelyt.includes('src/data/schema.js'), true,
    'lipun lähdemäärittely puuttuu');
  assert.equal(maarittelyt.filter(f => f.startsWith('src/')).length, 1,
    `lipulla on ${maarittelyt.filter(f => f.startsWith('src/')).length} määrittelyä lähdekoodissa`);

  for (const file of maarittelyt.filter(f => f.startsWith('src/'))) {
    const arvo = /export const TASK_EXTENDED_FIELDS\s*=\s*(\w+)/
      .exec(fs.readFileSync(path.join(ROOT, file), 'utf8'))[1];
    assert.equal(arvo, 'true', `${file}: lipun arvo on ${arvo}`);
  }

  // KOONTITULOKSET ovat eri asia kuin julkaistava lähde. dist/ ja
  // Capacitorin assetit eivät ole versionhallinnassa eivätkä päädy
  // Verceliin — ne menevät APK:hon. Jos ne ovat vanhentuneet, se on
  // laitehyväksynnän asia (backlog D1) eikä verkkojulkaisun este.
  // Testi ei siis kaadu niihin, mutta backlogin on oltava kirjattuna.
  const vanhentuneetKoonnit = koonnit.filter(file =>
    vanhentunut.test(fs.readFileSync(path.join(ROOT, file), 'utf8')));

  if (vanhentuneetKoonnit.length > 0) {
    const aktivointidoc = read('docs/TASK-EXTENDED-FIELDS-ACTIVATION.md');
    assert.match(aktivointidoc, /D1/,
      `koontituloksissa on vanhentunut lippu (${vanhentuneetKoonnit.join(', ')}), `
      + 'mutta laitehyväksynnän backlogia ei ole kirjattu');
    assert.ok(aktivointidoc.includes('sync:android'),
      'backlog ei kerro, miten koontitulokset päivitetään');
  }
});

test('service workerin välimuistiversio on nostettu tätä julkaisua varten', () => {
  // Service worker on network-first, joten uusi koodi tulee käyttöön
  // seuraavalla latauksella. Version nosto siivoaa vanhat välimuistit
  // myös offline-käyttäjiltä, joille vanha kopio olisi muuten yhä
  // auktoritatiivinen.
  const sw = read('sw.js');
  const versio = /const CACHE_VERSION = 'v(\d+)'/.exec(sw);
  assert.ok(versio, 'välimuistin versiota ei löytynyt');
  // Versio nostettiin lipun aktivoinnissa v11:een. Se ei ole kosmetiikkaa:
  // sw.js:n muuttuminen on AINOA asia, josta selain huomaa uuden service
  // workerin ja hakee SHELL-listan uudelleen `cache: 'reload'` -tilassa.
  // Ilman nostoa offline-kykyisellä asennuksella olisi yhä välimuistissa
  // schema.js, jossa lippu on false — eikä mikään koskaan päivittäisi sitä.
  assert.ok(Number(versio[1]) >= 11,
    `välimuistin versio on v${versio[1]}, odotettiin vähintään v11`);
});

// =====================================================================
// AKTIVOIDUN TILAN SOPIMUSTESTIT
//
// Lippu on päällä, joten jokainen tehtävän kirjoitus sisältää nyt neljä
// uutta saraketta. Nämä testit ajavat oikean repositoriopolun ja
// tarkastavat TÄSMÄLLEEN sen payloadin, joka lähtisi verkkoon.
// =====================================================================

/** Aja yksi kirjoitus ja palauta lähtenyt payload. */
async function payloadOf(fn) {
  const client = recordingClient();
  setUser(USER);
  setClient(client);
  await fn();
  assert.equal(client.kirjatut.length, 1, 'odotettiin tasan yhtä kirjoitusta');
  return client.kirjatut[0];
}

test('LUONTI: jokainen laajennettu kenttä lähtee kantaan', async () => {
  const tapaukset = [
    ['ajallinen tehtävä', { time: '09:00' }, { scheduling_state: 'manual' }],
    ['ajaton tehtävä', { time: null }, { scheduling_state: 'unscheduled' }],
    ['kuvaus', { description: '  pitkä konteksti  ' }, { description: 'pitkä konteksti' }],
    ['kesto', { durationMinutes: 45 }, { duration_minutes: 45 }],
    ['korkea prioriteetti', { priority: 'korkea' }, { priority: 'korkea' }],
    ['matala prioriteetti', { priority: 'matala' }, { priority: 'matala' }],
    ['automaatin sijoitus', { time: '09:00', schedulingState: SCHEDULING.AUTO },
      { scheduling_state: 'auto' }]
  ];

  for (const [nimi, syote, odotus] of tapaukset) {
    const { op, payload } = await payloadOf(() => tasksRepo.insertTask(normalizeTask({
      id: 'uusi', date: '2026-09-06', title: 'testi', ...syote
    })));

    assert.equal(op, 'insert', nimi + ': väärä operaatio');
    for (const [sarake, arvo] of Object.entries(odotus)) {
      assert.equal(payload[sarake], arvo,
        nimi + ': ' + sarake + ' = ' + JSON.stringify(payload[sarake])
        + ', odotettiin ' + JSON.stringify(arvo));
    }
    // Sarakejoukko on täsmälleen laajennettu — ei enempää eikä vähempää.
    assert.deepEqual(Object.keys(payload).sort(), [...TASK_COLUMNS_EXTENDED].sort(),
      nimi + ': väärä sarakejoukko');
  }
});

test('LUONTI: tyhjät valinnaiset kentät lähtevät nullina, pakolliset eivät koskaan', async () => {
  const { payload } = await payloadOf(() => tasksRepo.insertTask(normalizeTask({
    id: 'uusi', date: '2026-09-06', title: 'vain pakolliset'
  })));

  assert.equal(payload.description, null, 'tyhjä kuvaus ei ole null');
  assert.equal(payload.duration_minutes, null, 'tyhjä kesto ei ole null');
  assert.equal(payload.priority, 'normaali', 'prioriteetti ei saanut oletusta');
  assert.equal(payload.scheduling_state, 'unscheduled', 'aikataulutustila väärin');
});

test('MUOKKAUS: laajennettujen kenttien asetus, muutos ja tyhjennys', async () => {
  const { editTask } = await import('../src/app/actions.js');
  const { resetState, setTasks } = await import('../src/app/state.js');

  const alku = normalizeTask({
    id: 'muokattava', date: '2026-09-06', time: '09:00', title: 'tehtävä',
    description: 'alkuperäinen', durationMinutes: 30, priority: 'korkea'
  });

  const askeleet = [
    ['kuvauksen muutos', { description: 'muutettu' }, { description: 'muutettu' }],
    ['kuvauksen tyhjennys', { description: '' }, { description: null }],
    ['keston muutos', { durationMinutes: 90 }, { duration_minutes: 90 }],
    ['keston tyhjennys', { durationMinutes: null }, { duration_minutes: null }],
    ['prioriteetin muutos', { priority: 'matala' }, { priority: 'matala' }],
    ['aikataulutustilan muutos', { schedulingState: SCHEDULING.AUTO }, { scheduling_state: 'auto' }]
  ];

  for (const [nimi, muutos, odotus] of askeleet) {
    const client = recordingClient();
    setUser(USER);
    setClient(client);
    resetState();
    setTasks([alku]);

    const tulos = await editTask('muokattava', muutos);
    assert.equal(tulos.ok, true, nimi + ': muokkaus epäonnistui');

    const { payload } = client.kirjatut.find(k => k.op === 'update');
    for (const [sarake, arvo] of Object.entries(odotus)) {
      assert.equal(payload[sarake], arvo,
        nimi + ': ' + sarake + ' = ' + JSON.stringify(payload[sarake]));
    }
    resetState();
  }
});

test('KRIITTINEN: tavallinen muokkaus ei pyyhi laajennettuja kenttiä', async () => {
  // Koko rivin kirjoitus on ylikirjoitus. Jos otsikon vaihtaminen
  // lähettäisi tyhjän kuvauksen, käyttäjän kirjoittama teksti katoaisi
  // ilman että mikään kertoisi siitä.
  const { editTask } = await import('../src/app/actions.js');
  const { resetState, setTasks } = await import('../src/app/state.js');

  const client = recordingClient();
  setUser(USER);
  setClient(client);
  resetState();
  setTasks([normalizeTask({
    id: 'sailyva', date: '2026-09-06', time: '09:00', title: 'vanha otsikko',
    description: 'tärkeä konteksti', durationMinutes: 45, priority: 'korkea'
  })]);

  await editTask('sailyva', { title: 'uusi otsikko', date: '2026-09-07' });

  const { payload } = client.kirjatut.find(k => k.op === 'update');
  assert.equal(payload.title, 'uusi otsikko');
  assert.equal(payload.date, '2026-09-07');
  assert.equal(payload.description, 'tärkeä konteksti', 'kuvaus katosi otsikon muutoksessa');
  assert.equal(payload.duration_minutes, 45, 'kesto katosi');
  assert.equal(payload.priority, 'korkea', 'prioriteetti katosi');
  resetState();
});

test('KRIITTINEN: osittaiset kirjoitukset koskevat tasan yhteen sarakkeeseen', async () => {
  // setCompleted ja herätysmerkinnän nollaus lähettävät VAIN oman
  // sarakkeensa. Jos ne lähettäisivät koko rivin, ne ylikirjoittaisivat
  // laajennetut kentät sillä tilannekuvalla, joka selaimella sattuu
  // olemaan — ja valmiiksi merkitseminen voisi pyyhkiä kuvauksen.
  const valmis = await payloadOf(() => tasksRepo.setCompleted('x', true));
  assert.equal(valmis.op, 'update');
  assert.deepEqual(Object.keys(valmis.payload), ['completed'],
    'setCompleted lähetti: ' + Object.keys(valmis.payload).join(', '));

  const heratys = await payloadOf(() => tasksRepo.clearOtherWakeFlags('2026-09-06', 'x'));
  assert.equal(heratys.op, 'update');
  assert.deepEqual(Object.keys(heratys.payload), ['is_wake'],
    'clearOtherWakeFlags lähetti: ' + Object.keys(heratys.payload).join(', '));
});

test('KRIITTINEN: aikaleimat eivät lähde kantaan edes aktivoituna', async () => {
  const { payload } = await payloadOf(() => tasksRepo.insertTask(normalizeTask({
    id: 'uusi', date: '2026-09-06', title: 'x',
    createdAt: '1999-01-01T00:00:00Z', updatedAt: '1999-01-01T00:00:00Z'
  })));

  assert.equal('created_at' in payload, false, 'created_at lähti kantaan');
  assert.equal('updated_at' in payload, false, 'updated_at lähti kantaan');
  assert.equal('user_id' in payload, false, 'user_id lähti kantaan');
});

test('LUKUPOLKU: tuotannon 36 rivin malli luetaan ja kirjoitetaan ehjänä', async () => {
  // Tuotannossa on 35 manual- ja 1 unscheduled-riviä, eikä yhdelläkään
  // ole vielä kuvausta, kestoa tai muuta kuin oletusprioriteetti.
  const tuotanto = [
    ...Array.from({ length: 35 }, (_, i) => legacyRow({
      id: 'manual-' + i, time: '08:30', scheduling_state: 'manual'
    })),
    legacyRow({ id: 'unscheduled-1', time: null, scheduling_state: 'unscheduled' })
  ];

  const luetut = tuotanto.map(rivi => normalizeTask(fromRow(rivi)));

  assert.equal(luetut.filter(t => t.schedulingState === SCHEDULING.MANUAL).length, 35);
  assert.equal(luetut.filter(t => t.schedulingState === SCHEDULING.UNSCHEDULED).length, 1);

  for (const tehtava of luetut) {
    // Käyttöliittymä ei saa kaatua tyhjiin valinnaisiin kenttiin.
    assert.equal(tehtava.description, null);
    assert.equal(tehtava.durationMinutes, null);
    assert.equal(tehtava.priority, 'normaali');
    assert.ok(tehtava.createdAt, 'created_at ei luettu');
    assert.ok(tehtava.updatedAt, 'updated_at ei luettu');

    // Ja takaisin kirjoitettuna rivi on kelvollinen laajennetussa tilassa.
    const rivi = toRow(tehtava, TASK_COLUMNS_EXTENDED);
    assert.notEqual(rivi.priority, null);
    assert.notEqual(rivi.scheduling_state, null);
    assert.equal('created_at' in rivi, false);
  }
});
