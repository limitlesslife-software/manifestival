// Migraation 0003 valmius — rutiinit ja niiden poikkeukset.
//
// TILANNE
//
// Migraatiota 0003 EI ole ajettu, ja portit `routines` ja
// `routineExceptions` ovat `false`. Rutiinit elävät siis muistivarastossa
// ja katoavat sivun latauksessa.
//
// Nämä testit valmistelevat aktivointia kahdessa tilassa:
//
//   TILA A  portti false — sovellus ei saa koskea olemattomiin tauluihin
//   TILA B  portti true  — mitä kantaan LÄHTISI, jos portti avattaisiin
//
// TILA B testataan repositorion omalla rivimuunnoksella (`mapping`), ei
// avaamalla porttia. Muunnos on sama funktio jota insert ja update
// käyttävät, joten se kertoo täsmälleen mitä kantaan menisi — ilman että
// mitään aktivoidaan.
//
// Nämä testit eivät ota yhteyttä mihinkään tietokantaan.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { routinesRepo, routineExceptionsRepo, clearAllCollections }
  from '../src/data/collectionsRepo.js';
import { normalizeRoutine, normalizeException, RECURRENCE, ROUTINE_SCHEDULING, EXCEPTION }
  from '../src/domain/routine.js';
import { assertClientSafe, SERVER_OWNED_FIELDS } from '../src/lib/rows.js';
import { TABLES, hasTable } from '../src/data/schema.js';
import { setClient } from '../src/data/client.js';
import { setUser, clearUser } from '../src/data/session.js';
import { read } from './helpers/sources.mjs';

const NEWLINE = String.fromCharCode(10);
const USER = { id: 'aaaaaaaa-0000-0000-0000-000000000001', email: 'a@example.com' };
const MIGRAATIO = 'supabase/migrations/0003_routines.sql';

/** Client joka kirjaa jokaisen kutsun. Jos tähän tulee mitään, portti vuotaa. */
function recordingClient() {
  const kutsut = [];
  const chain = () => {
    const q = {
      eq: () => q, neq: () => q, select: () => q,
      then: (res, rej) => Promise.resolve({ data: [], error: null }).then(res, rej)
    };
    return q;
  };
  return {
    kutsut,
    from(table) {
      kutsut.push(table);
      return {
        select: () => chain(), insert: () => chain(),
        update: () => chain(), delete: () => chain()
      };
    }
  };
}

/** Kelvollinen rutiini domain-muodossa. */
function rutiini(overrides = {}) {
  return normalizeRoutine({
    id: 'r-1',
    title: 'Aamulaakkeet',
    category: 'hyvinvointi',
    priority: 'korkea',
    durationMinutes: 10,
    recurrence: { type: RECURRENCE.WEEKDAYS, weekdays: [] },
    preferredTime: '07:00',
    scheduling: ROUTINE_SCHEDULING.FIXED,
    active: true,
    ...overrides
  });
}

beforeEach(() => {
  clearUser();
  setClient(null);
  clearAllCollections();
});

// =====================================================================
// TILA A — portti on kiinni
// =====================================================================

// Rutiiniportit avataan aallossa C. Tata ennen ne ovat kiinni, ja
// TILA A -testit kuvaavat sita puolta. Aallon C jalkeen sama koodi
// ajetaan tietokantapolulla, ja se todistetaan tiedostossa
// tests/wave-activation.test.mjs oikealla ajolla valeasiakasta vasten.
const RUTIINIPORTIT_AUKI = TABLES.routines === true;

test('TILA A: rutiiniporttien tila on yhtenainen', () => {
  // Kumpikin portti kuuluu SAMAAN aaltoon, koska routine_exceptions
  // viittaa routines-tauluun. Jos ne olisivat eri tilassa, poikkeuksen
  // tallennus tuottaisi vierasavainvirheen -- tai poikkeus jaisi
  // muistiin vaikka rutiini sailyy.
  assert.equal(TABLES.routineExceptions, TABLES.routines,
    'rutiinit ja poikkeukset ovat eri porttitilassa');

  assert.equal(hasTable('routines'), RUTIINIPORTIT_AUKI);
  assert.equal(hasTable('routineExceptions'), RUTIINIPORTIT_AUKI);
  assert.equal(routinesRepo.isPersistent(), RUTIINIPORTIT_AUKI);
  assert.equal(routineExceptionsRepo.isPersistent(), RUTIINIPORTIT_AUKI);
});

test('KRIITTINEN: portin ollessa kiinni kantaan ei oteta yhteyttä lainkaan', async () => {
  // Jos repositorio kutsuisi Supabasea ilman taulua, jokainen operaatio
  // epäonnistuisi tuotannossa — ja epäonnistuisi juuri siinä kohdassa,
  // jossa käyttäjä luulee tallentaneensa rutiinin.
  if (RUTIINIPORTIT_AUKI) return;
  setUser(USER);
  const client = recordingClient();
  setClient(client);

  await routinesRepo.list();
  await routinesRepo.insert(rutiini());
  await routinesRepo.update(rutiini({ title: 'Muutettu' }));
  await routinesRepo.remove('r-1');
  await routineExceptionsRepo.list();
  await routineExceptionsRepo.insert(normalizeException({
    id: 'x-1', routineId: 'r-1', date: '2026-09-06', type: EXCEPTION.SKIP
  }));

  assert.deepEqual(client.kutsut, [],
    `kantaan otettiin yhteyttä tauluihin: ${client.kutsut.join(', ')}`);
});

test('TILA A: muistivarasto toimii mutta kertoo, ettei tieto säily', async () => {
  // Muistivarasto testataan SUORAAN, jotta testi kertoo varastosta
  // eika porttitilasta. Sama varasto on olemassa jokaisessa aallossa,
  // ja portin ollessa kiinni juuri se on tallennuspaikka.
  const lisays = await routinesRepo.memory.insert(rutiini());
  assert.equal(lisays.ok, true);

  const lista = await routinesRepo.memory.list();
  assert.equal(lista.ok, true);
  assert.equal(lista.value.length, 1);
  assert.equal(lista.value[0].title, 'Aamulaakkeet');

  // Ja sailyvyysvaite vastaa porttia.
  assert.equal(routinesRepo.isPersistent(), RUTIINIPORTIT_AUKI);
});

// =====================================================================
// TILA B — mitä kantaan lähtisi, jos portti avattaisiin
// =====================================================================

test('TILA B: rutiinin payload sisältää vain sarakkeita jotka 0003 luo', () => {
  // Sarakelista luetaan MIGRAATIOSTA, ei kirjoiteta tähän käsin. Käsin
  // kirjoitettu lista vanhenisi huomaamatta.
  const migraatio = read(MIGRAATIO);
  const luonti = /create table public\.routines \(([\s\S]*?)\n\);/.exec(migraatio);
  assert.ok(luonti, 'routines-taulun luontia ei löytynyt migraatiosta');

  const kannassa = new Set(
    luonti[1].split(NEWLINE)
      .map(line => /^\s{2}(\w+)\s+\S/.exec(line))
      .filter(Boolean)
      .map(m => m[1]));

  const rivi = routinesRepo.mapping.toRow(rutiini());
  for (const sarake of Object.keys(rivi)) {
    assert.ok(kannassa.has(sarake),
      `payload sisältää sarakkeen ${sarake}, jota 0003 ei luo`);
  }
  assert.ok(Object.keys(rivi).length >= 12, 'payload on epäilyttävän suppea');
});

test('KRIITTINEN: omistajuutta ei voi väärentää eikä aikaleimoja kirjoittaa', () => {
  // user_id ei ole payloadissa: kanta asettaa sen oletusarvosta
  // auth.uid(). Jos client lähettäisi sen, RLS:n WITH CHECK hylkäisi
  // vieraan arvon — mutta oikea suoja on se, ettei sitä lähetetä.
  for (const [nimi, repo, entity] of [
    ['rutiini', routinesRepo, rutiini({ user_id: 'vieras', userId: 'vieras' })],
    ['poikkeus', routineExceptionsRepo, normalizeException({
      id: 'x-1', routineId: 'r-1', date: '2026-09-06', type: EXCEPTION.SKIP,
      user_id: 'vieras', userId: 'vieras'
    })]
  ]) {
    const rivi = repo.mapping.toRow(entity);
    for (const kielletty of SERVER_OWNED_FIELDS) {
      assert.equal(kielletty in rivi, false,
        `${nimi}: payload sisältää palvelimen omistaman kentän ${kielletty}`);
    }
    assert.doesNotThrow(() => assertClientSafe(rivi), `${nimi}: assertClientSafe hylkäsi`);
  }
});

test('KRIITTINEN: normalisoimaton syöte ei tuota kelvotonta riviä', () => {
  // Kanta hylkäisi kelvottoman arvon tarkisteella, mutta virhe näkyisi
  // vasta tallennuksessa. Normalisointi on ensimmäinen puolustuslinja.
  const roskaa = routinesRepo.mapping.normalize({
    id: 5, title: '   Otsikko   ', category: {}, priority: 'kiireellinen',
    durationMinutes: -3, recurrence: { type: 'joka-toinen-tiistai', weekdays: [9, 0] },
    scheduling: 'satunnainen', active: 'kylla'
  });
  const rivi = routinesRepo.mapping.toRow(roskaa);

  assert.equal(rivi.title, 'Otsikko', 'otsikkoa ei trimmattu');
  assert.ok(['korkea', 'normaali', 'matala'].includes(rivi.priority),
    `kelvoton prioriteetti: ${rivi.priority}`);
  assert.ok(Object.values(RECURRENCE).includes(rivi.recurrence_type),
    `kelvoton toistotyyppi: ${rivi.recurrence_type}`);
  assert.ok(Object.values(ROUTINE_SCHEDULING).includes(rivi.scheduling),
    `kelvoton aikataulutus: ${rivi.scheduling}`);
  assert.equal(typeof rivi.active, 'boolean');
  assert.ok(rivi.duration_minutes > 0 && rivi.duration_minutes <= 1440,
    `kelvoton kesto: ${rivi.duration_minutes}`);
  for (const paiva of rivi.recurrence_weekdays) {
    assert.ok(paiva >= 1 && paiva <= 7, `kelvoton viikonpäivä: ${paiva}`);
  }
});

test('TILA B: kannasta luettu rivi palautuu ehjänä takaisin', () => {
  const kannasta = {
    id: 'r-1', user_id: USER.id, title: 'Aamulaakkeet', description: null,
    category: 'hyvinvointi', priority: 'korkea', duration_minutes: 10,
    recurrence_type: 'weekdays', recurrence_weekdays: [], preferred_time: '07:00',
    scheduling: 'fixed', active: true, goal_id: null,
    start_date: null, end_date: null,
    created_at: '2026-09-06T10:00:00.000Z', updated_at: '2026-09-06T10:00:00.000Z'
  };

  const domain = routinesRepo.mapping.fromRow(kannasta);
  assert.equal(domain.id, 'r-1');
  assert.equal(domain.title, 'Aamulaakkeet');
  assert.equal(domain.recurrence.type, 'weekdays');
  assert.equal(domain.active, true);

  const takaisin = routinesRepo.mapping.toRow(domain);
  for (const sarake of ['id', 'title', 'category', 'priority', 'duration_minutes',
                        'recurrence_type', 'preferred_time', 'scheduling', 'active']) {
    assert.equal(takaisin[sarake], kannasta[sarake], `${sarake} muuttui kierroksella`);
  }
  assert.equal('user_id' in takaisin, false, 'omistajuus palaisi kantaan');
});

// =====================================================================
// ISTUNNON RAJA
// =====================================================================

test('KRIITTINEN: rutiinit eivät säily istunnosta toiseen', async () => {
  // Tämä on se vikaluokka, joka tässä projektissa on jo kerran vuotanut:
  // muistivarasto on moduulitasoinen ja säilyi uloskirjautumisen yli,
  // jolloin seuraava käyttäjä näki edellisen rutiinit.
  //
  // Vuoto koskee ASIAKASPUOLEN muistivarastoa, joten se todennetaan
  // varastoa vasten suoraan -- ei portin lapi, joka aallon C jalkeen
  // ohjaisi kutsut kantaan eika kertoisi varastosta mitaan.
  setUser(USER);
  await routinesRepo.memory.insert(rutiini({ title: 'Kayttajan A salainen rutiini' }));
  await routineExceptionsRepo.memory.insert(normalizeException({
    id: 'x-1', routineId: 'r-1', date: '2026-09-06', type: EXCEPTION.SKIP
  }));

  assert.equal((await routinesRepo.memory.list()).value.length, 1);

  clearAllCollections();
  clearUser();

  assert.deepEqual((await routinesRepo.memory.list()).value, [],
    'rutiinit jäivät uloskirjautumisen yli');
  assert.deepEqual((await routineExceptionsRepo.memory.list()).value, [],
    'poikkeukset jäivät uloskirjautumisen yli');
});

test('KRIITTINEN: rutiinit eivät päädy laitekohtaiseen tallennukseen', () => {
  // localStorage on laitekohtainen eikä käyttäjäkohtainen: sinne
  // tallennettu rutiini näkyisi seuraavalle kirjautujalle.
  const laiteTallennus = read('src/data/preferences.js');
  for (const sana of ['routine', 'recurrence', 'weekdays']) {
    assert.equal(laiteTallennus.toLowerCase().includes(sana), false,
      `${sana} päätyy laitekohtaiseen tallennukseen`);
  }
});

test('rutiinien repositorio on ainoa kirjoituspolku näihin tauluihin', () => {
  // Kirjoituspolkujen määrä on turvallisuusluku. Jokainen erillinen
  // polku on paikka, jossa normalisointi tai omistajuus voi jäädä pois.
  const lahteet = ['src/data/collectionsRepo.js', 'src/data/tasksRepo.js',
                   'src/data/profileRepo.js', 'src/data/notificationPrefsRepo.js'];

  const kirjoittajat = lahteet.filter(file =>
    /'routines'|'routine_exceptions'/.test(read(file)));

  assert.deepEqual(kirjoittajat, ['src/data/collectionsRepo.js'],
    `rutiinitauluihin viitataan useasta moduulista: ${kirjoittajat.join(', ')}`);
});
