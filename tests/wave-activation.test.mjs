// Aallon aktivoinnin ajonaikainen sopimus.
//
// MIKSI TÄMÄ TIEDOSTO ON KIRJOITETTU KERRAN JA SYVENEE ITSESTÄÄN
//
// Portti on käännösaikainen vakio. Kun se on `false`, tietokantapolkua
// EI VOI ajaa — repositorio ei edes kutsu asiakasta. Siksi
// aiemmat testit todistivat portti-EPÄTOSI-puolen ajamalla ja
// portti-TOSI-puolen lukemalla.
//
// Aaltocommitissa tilanne muuttuu: portti ON auki, ja silloin sama
// koodi voidaan vihdoin AJAA oikeaa rajapintaa vasten valeasiakkaalla
// (`setClient`). Tämä tiedosto tekee sen automaattisesti:
//
//   portti kiinni  ->  muistivarastosopimus, ei yhtään kantakutsua
//   portti auki    ->  koko tietokantasopimus ajettuna
//
// Yhtään testiä ei siis tarvitse lisätä aaltocommitissa. Kun portti
// kääntyy, sen domain siirtyy raskaampaan matriisiin itsestään — ja
// jos siirtymä paljastaa vian, se paljastuu ennen deployta.
//
// TÄMÄ EI OTA YHTEYTTÄ MIHINKÄÄN TIETOKANTAAN. Valeasiakas kirjaa
// kutsut ja palauttaa sen mitä testi käskee.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { setClient } from '../src/data/client.js';
import { setUser, clearUser, sessionSnapshot, isSameSession } from '../src/data/session.js';
import { TABLES } from '../src/data/schema.js';
import {
  ALL_REPOSITORIES, clearAllCollections, volatileCollections
} from '../src/data/collectionsRepo.js';
import * as prefsRepo from '../src/data/notificationPrefsRepo.js';
import { RECURRENCE, ROUTINE_SCHEDULING, EXCEPTION } from '../src/domain/routine.js';
import { ALL_GATES } from '../tools/release/waves.mjs';
import { currentState } from '../tools/release/state.mjs';

const KAYTTAJA_A = { id: 'aaaaaaaa-0000-0000-0000-000000000001', email: 'a@example.com' };
const KAYTTAJA_B = { id: 'bbbbbbbb-0000-0000-0000-000000000002', email: 'b@example.com' };

/** Palvelimen omistamat kentät. Client ei saa lähettää näitä koskaan. */
const PALVELIMEN_KENTAT = ['user_id', 'created_at', 'updated_at'];

// =====================================================================
// VALEASIAKAS
// =====================================================================

/**
 * Supabase-asiakkaan korvike, joka kirjaa jokaisen kutsun.
 *
 * Ketju on sama kuin oikealla asiakkaalla:
 *   from(t).select('*').eq(...)          -> { data, error }
 *   from(t).insert(row)                  -> { data, error }
 *   from(t).update(row).eq(...).eq(...)  -> { data, error }
 *   from(t).delete().eq(...).eq(...)     -> { data, error }
 *   from(t).select('*').eq(...).maybeSingle()
 *   from(t).upsert(row)
 *
 * @param {object} vastaus  { data, error } tai { throws: Error }
 */
function valeasiakas(vastaus = { data: [], error: null }) {
  const kutsut = [];

  const ketju = (merkinta) => {
    const q = {
      eq(sarake, arvo) {
        merkinta.suodattimet.push([sarake, arvo]);
        return q;
      },
      maybeSingle() {
        merkinta.maybeSingle = true;
        return q;
      },
      // Sivutettu lataus (collectionsRepo selectOwnedRows, arjen taulut 0014):
      // järjestys ja rajaus kirjataan. Vastaus on aina yksi sivu, joten vajaa
      // sivu päättää latauksen. Ilman näitä aallon K avoin portti kaatui
      // valeasiakkaaseen eikä sovelluksen lukupolkuun.
      order(sarake) {
        merkinta.jarjestys = sarake;
        return q;
      },
      range(alku, loppu) {
        merkinta.rajaus = [alku, loppu];
        return q;
      },
      then(res, rej) {
        if (vastaus.throws) return Promise.reject(vastaus.throws).then(res, rej);
        return Promise.resolve({
          data: vastaus.data === undefined ? [] : vastaus.data,
          error: vastaus.error || null
        }).then(res, rej);
      }
    };
    return q;
  };

  return {
    kutsut,
    from(taulu) {
      const luo = (operaatio) => (payload) => {
        const merkinta = { taulu, operaatio, payload, suodattimet: [], maybeSingle: false };
        kutsut.push(merkinta);
        return ketju(merkinta);
      };
      return {
        select: luo('select'),
        insert: luo('insert'),
        update: luo('update'),
        upsert: luo('upsert'),
        delete: luo('delete')
      };
    }
  };
}

// =====================================================================
// FIXTUURIT
// =====================================================================
//
// Yksi kelvollinen domain-olio jokaiselle kahdeksalletoista portille.
// Nämä ovat se syöte, jolla tietokantapolku ajetaan portin auettua.

const FIXTUURIT = Object.freeze({
  routines: {
    id: 'w-r-1', title: 'Aamulenkki', category: 'hyvinvointi', priority: 'normaali',
    durationMinutes: 30, recurrence: { type: RECURRENCE.DAILY, weekdays: [] },
    preferredTime: '07:00', scheduling: ROUTINE_SCHEDULING.FIXED, active: true
  },
  routineExceptions: {
    id: 'w-x-1', routineId: 'w-r-1', date: '2026-09-10', type: EXCEPTION.SKIP
  },
  goals: { id: 'w-g-1', title: 'Opettele espanjaa' },
  projects: { id: 'w-p-1', name: 'Keittiöremontti' },
  wellbeing: { id: 'w-w-1', date: '2026-09-10', energy: 3, mood: 4, stress: 2 },
  bills: { id: 'w-b-1', name: 'Sähkö', amountMinor: 4550, dueDate: '2026-10-01' },
  recurringExpenses: {
    id: 'w-e-1', name: 'Vuokra', amountMinor: 95000, nextDueDate: '2026-10-01'
  },
  savingsGoals: { id: 'w-s-1', name: 'Puskuri', targetMinor: 300000 },
  aiAudit: { id: 'w-a-1', intent: 'create_task', risk: 'medium' },
  transactions: {
    id: 'w-t-1', kind: 'expense', amountMinor: 1250, date: '2026-09-10',
    category: 'ruoka', description: 'Ruokakauppa'
  },
  investments: {
    id: 'w-i-1', name: 'Indeksirahasto', kind: 'fund', quantity: 12.5,
    costBasisMinor: 250000
  },
  milestones: {
    id: 'w-m-1', goalId: 'w-g-1', title: 'Ominaisuusvalmis',
    targetDate: '2026-11-01', orderIndex: 0
  },
  inboxItems: {
    id: 'w-in-1', text: 'Soita hammaslaakarille', status: 'unprocessed',
    source: 'text'
  },
  reminders: {
    id: 'w-mu-1', title: 'Soita hammaslaakarille', targetType: 'standalone',
    trigger: 'at_time', dueDate: '2026-09-12', dueTime: '09:00'
  },
  notices: {
    id: 'w-il-1', key: 'reminder:w-mu-1:2026-09-12:540', kind: 'reminder',
    level: 'info', title: 'Soita hammaslaakarille', createdDate: '2026-09-12'
  },
  travelPlans: {
    id: 'w-ma-1', title: 'Hammaslaakari', origin: 'Koti',
    destination: 'Keskusta', arrivalDate: '2026-09-12', arrivalTime: '10:00',
    mode: 'transit'
  },
  locationRules: {
    id: 'w-si-1', place: 'Kauppa', trigger: 'arriving',
    message: 'Osta maitoa', active: false
  },
  lifeAreas: {
    id: 'w-la-1', name: 'Perhe', importance: 5, targetMinutesPerWeek: 600,
    categoryKey: 'perhe', active: true, sortOrder: 0
  },
  weeklyCapacities: {
    id: 'w-wc-1', weekStart: '2026-09-14', availableMinutes: 1800, energyLevel: 3
  },
  timeEntries: {
    id: 'w-te-1', entryDate: '2026-09-15', minutes: 45, lifeAreaId: 'w-la-1'
  },
  alignmentReviews: {
    id: 'w-ar-1', weekStart: '2026-09-14', snapshotVersion: 1,
    snapshot: { version: 1, weekStart: '2026-09-14' }, adjustments: []
  },
  // Migraatio 0013 (aalto J).
  runningTimers: {
    id: 'w-rt-1', targetKind: 'none', startedAt: '2026-09-17T08:00:00.000Z', pausedSeconds: 0
  },
  alignmentItemSettings: {
    id: 'w-ais-1', itemKind: 'task', itemId: 'w-task-1', energyDemand: 4
  },
  // Migraatio 0014 (aalto K): arjen käyttöjärjestelmä.
  savedPlaces: { id: 'w-place-1', name: 'Työ', travelMode: 'driving', usualTravelMinutes: 35 },
  placeAliases: { id: 'w-alias-1', placeId: 'w-place-1', alias: 'duuni', confirmations: 2 },
  calendarEvents: {
    id: 'w-event-1', title: 'Parturi', date: '2026-09-29', startTime: '16:00', durationMinutes: 45
  },
  commuteObservations: {
    id: 'w-obs-1', placeId: 'w-place-1', observedOn: '2026-09-28', weekday: 1, travelMinutes: 38
  },
  lifeSettings: { id: 'w-life-1', windDownMinutes: 30, arrivalBufferMinutes: 10 },
  sleepLogs: { id: 'w-sleep-1', wakeDate: '2026-09-28', actualBedtime: '22:45', actualWake: '06:10' },
  habitPlans: { id: 'w-habit-1', kind: 'nicotine', name: 'Nikotiini', minIntervalMinutes: 120 },
  habitEvents: { id: 'w-hev-1', planId: 'w-habit-1', occurredAt: '2026-09-28T08:00:00.000Z', action: 'use' },
  exerciseSessions: { id: 'w-ex-1', date: '2026-09-28', kind: 'Juoksu', actualMinutes: 30, intensity: 3 },
  wellbeingCheckins: { id: 'w-wc-1', date: '2026-09-28', motivation: 4, control: 3 }
});

/** Repositorio porttiavaimella. */
function repoOf(schemaKey) {
  return ALL_REPOSITORIES.find(r => r.schemaKey === schemaKey) || null;
}

/** Portit, jotka ovat auki juuri nyt. */
const AUKI = ALL_GATES.filter(gate => TABLES[gate] === true);

/** Portit, jotka ovat yhä kiinni. */
const KIINNI = ALL_GATES.filter(gate => TABLES[gate] !== true);

beforeEach(() => {
  clearUser();
  setClient(null);
  clearAllCollections();
  prefsRepo.clearPreferences();
});

// =====================================================================
// AALTOTILA
// =====================================================================

test('KRIITTINEN: aaltotila on tunnistettu ja portit jakautuvat kahtia', () => {
  const tila = currentState();
  assert.ok(tila.wave !== null, 'porttimatriisi ei vastaa yhtäkään aaltoa');
  assert.deepEqual(tila.problems, []);

  assert.equal(AUKI.length + KIINNI.length, ALL_GATES.length);
  for (const portti of AUKI) assert.equal(TABLES[portti], true);
  for (const portti of KIINNI) assert.equal(TABLES[portti], false);
});

// =====================================================================
// PASSIIVINEN LATAUS — KAIKKI KYMMENEN, JOKAISESSA AALLOSSA
// =====================================================================

test('KRIITTINEN: pelkkä luku ei kirjoita yhteenkään kymmenestä taulusta', async () => {
  // TUOTANNON TURVALLISUUSVAATIMUS, JOKA KOSKEE JOKAISTA AALTOA.
  //
  // Kun portit avataan, ensimmäinen asia joka tapahtuu on että joku
  // avaa sovelluksen. Jos lataus loisi rivejä, tuotantoon ilmestyisi
  // dataa jota kukaan ei pyytänyt — ja aktivoinnin jälkeinen varmistus
  // kertoisi omistajuudesta oikein mutta rivien alkuperästä väärin.
  //
  // Tämä ajetaan OIKEALLA repositoriolla: portin ollessa auki lukupolku
  // menee valeasiakkaalle, ja kirjaus paljastaisi jokaisen kirjoituksen.
  setUser(KAYTTAJA_A);
  const asiakas = valeasiakas({ data: [], error: null });
  setClient(asiakas);

  for (const repo of ALL_REPOSITORIES) {
    const tulos = await repo.list();
    assert.equal(tulos.ok, true, `${repo.table}: luku epäonnistui`);
  }
  const prefs = await prefsRepo.loadPreferences();
  assert.equal(prefs.ok, true, 'muistutusasetusten lataus epäonnistui');

  const kirjoitukset = asiakas.kutsut.filter(k => k.operaatio !== 'select');
  assert.deepEqual(kirjoitukset.map(k => `${k.taulu}.${k.operaatio}`), [],
    'lukupolku kirjoitti kantaan');
});

test('KRIITTINEN: oletusasetukset eivät synny kantaan itsestään', async () => {
  // Muistutusasetuksissa on oletusarvot. Ne palautetaan MUISTISTA kun
  // riviä ei ole — niitä ei kirjoiteta kantaan siltä varalta. Jos
  // lataus kirjoittaisi oletusrivin, jokainen sisäänkirjautuminen
  // loisi rivin notification_preferences-tauluun.
  setUser(KAYTTAJA_A);
  const asiakas = valeasiakas({ data: null, error: null });
  setClient(asiakas);

  const eka = await prefsRepo.loadPreferences();
  assert.equal(eka.ok, true);
  assert.equal(eka.value.enabled, false,
    'oletusasetukset eivät ole hiljaisuus — uusi käyttäjä alkaisi saada ilmoituksia');

  const toka = await prefsRepo.loadPreferences();
  assert.deepEqual(toka.value, eka.value,
    'peräkkäiset lataukset antavat eri tuloksen — jokin luo tilaa');

  assert.equal(asiakas.kutsut.some(k => k.operaatio !== 'select'), false,
    'muistutusasetusten LATAUS kirjoitti kantaan');
});

// =====================================================================
// PORTTI KIINNI — MUISTIVARASTOSOPIMUS
// =====================================================================

test('KRIITTINEN: kiinni oleva portti ei ota yhteyttä kantaan lainkaan', async () => {
  setUser(KAYTTAJA_A);
  const asiakas = valeasiakas();
  setClient(asiakas);

  for (const portti of KIINNI) {
    const repo = repoOf(portti);
    if (!repo) continue;                 // notificationPreferences on oma moduulinsa
    const fixtuuri = FIXTUURIT[portti];

    await repo.list();
    await repo.insert(fixtuuri);
    await repo.update(fixtuuri);
    await repo.remove(fixtuuri.id);
  }

  if (KIINNI.includes('notificationPreferences')) {
    await prefsRepo.loadPreferences();
    await prefsRepo.savePreferences({ enabled: true });
  }

  const koskettu = [...new Set(asiakas.kutsut.map(k => k.taulu))];
  const kiinniTaulut = KIINNI.map(p => repoOf(p)).filter(Boolean).map(r => r.table);
  for (const taulu of kiinniTaulut) {
    assert.equal(koskettu.includes(taulu), false,
      `kiinni olevaan tauluun ${taulu} otettiin yhteyttä`);
  }
});

test('KRIITTINEN: kiinni oleva portti kertoo rehellisesti, ettei tieto säily', async () => {
  for (const portti of KIINNI) {
    const repo = repoOf(portti);
    if (repo) {
      assert.equal(repo.isPersistent(), false,
        `${repo.table}: väittää säilyvänsä vaikka portti on kiinni`);
    }
  }
  if (KIINNI.includes('notificationPreferences')) {
    assert.equal(prefsRepo.isPersistent(), false,
      'muistutusasetukset väittävät säilyvänsä vaikka portti on kiinni');
  }

  // Ja muistivarasto toimii: tieto elää istunnon ajan.
  for (const portti of KIINNI) {
    const repo = repoOf(portti);
    if (!repo) continue;
    const lisays = await repo.insert(FIXTUURIT[portti]);
    assert.equal(lisays.ok, true, `${repo.table}: muistivarastoon kirjoitus epäonnistui`);

    const lista = await repo.list();
    assert.ok(lista.value.some(r => r.id === FIXTUURIT[portti].id),
      `${repo.table}: kirjoitettu rivi ei näy muistivarastossa`);
    repo.clear();
  }

  // volatileCollections on se lista, jonka perusteella käyttöliittymä
  // kertoo käyttäjälle mikä ei säily. Vajaa lista olisi lupaus jota
  // sovellus ei pidä.
  const haihtuvat = volatileCollections();
  for (const portti of KIINNI) {
    const repo = repoOf(portti);
    if (!repo) continue;
    assert.ok(haihtuvat.includes(repo.table),
      `${repo.table} puuttuu haihtuvien listalta`);
  }
  for (const portti of AUKI) {
    const repo = repoOf(portti);
    if (!repo) continue;
    assert.equal(haihtuvat.includes(repo.table), false,
      `${repo.table} on haihtuvien listalla vaikka portti on auki`);
  }
});

// =====================================================================
// PORTTI AUKI — TIETOKANTASOPIMUS AJETTUNA
// =====================================================================
//
// Nämä testit ovat tyhjiä perustilassa ja syvenevät aalto aallolta.
// Se ei ole puute vaan koko rakenteen tarkoitus: aallon oma commit
// tuo mukanaan oman todistuksensa.

test('AKTIVOITU: avoin portti kirjoittaa oikeaan tauluun ilman omistajuuskenttiä', async () => {
  setUser(KAYTTAJA_A);

  for (const portti of AUKI) {
    const repo = repoOf(portti);
    if (!repo) continue;

    const asiakas = valeasiakas({ data: [], error: null });
    setClient(asiakas);

    const tulos = await repo.insert(FIXTUURIT[portti]);
    assert.equal(tulos.ok, true, `${repo.table}: kirjoitus epäonnistui`);

    assert.equal(asiakas.kutsut.length, 1, `${repo.table}: odotettiin tasan yhtä kutsua`);
    const kutsu = asiakas.kutsut[0];
    assert.equal(kutsu.taulu, repo.table);
    assert.equal(kutsu.operaatio, 'insert');

    // OMISTAJUUDEN ASETTAA KANTA. Jos client lähettäisi user_id:n, se
    // voisi yrittää kirjoittaa toisen nimiin — RLS estäisi sen, mutta
    // puolustus ei saa nojata yhteen kerrokseen.
    for (const kentta of PALVELIMEN_KENTAT) {
      assert.equal(Object.prototype.hasOwnProperty.call(kutsu.payload, kentta), false,
        `${repo.table}: kirjoitus sisältää palvelimen kentän ${kentta}`);
    }

    assert.equal(kutsu.payload.id, FIXTUURIT[portti].id,
      `${repo.table}: tunniste ei mennyt läpi`);
  }
});

test('AKTIVOITU: jokainen luku, muutos ja poisto rajataan omistajaan', async () => {
  // RLS on viimeinen este, ei ainoa. Kysely, joka ei rajaa omistajaan,
  // nojaisi yksin politiikkaan — ja politiikka voidaan muuttaa
  // kannassa ilman että sovelluskoodi muuttuu.
  setUser(KAYTTAJA_A);

  for (const portti of AUKI) {
    const repo = repoOf(portti);
    if (!repo) continue;

    const asiakas = valeasiakas({ data: [], error: null });
    setClient(asiakas);

    await repo.list();
    await repo.update(FIXTUURIT[portti]);
    await repo.remove(FIXTUURIT[portti].id);

    for (const kutsu of asiakas.kutsut) {
      const omistaja = kutsu.suodattimet.find(([sarake]) => sarake === 'user_id');
      assert.ok(omistaja,
        `${repo.table}.${kutsu.operaatio}: kysely ei rajaa omistajaan`);
      assert.equal(omistaja[1], KAYTTAJA_A.id,
        `${repo.table}.${kutsu.operaatio}: rajaus ei ole kirjautunut käyttäjä`);
    }

    // Muutos ja poisto rajaavat lisäksi tunnisteeseen.
    for (const kutsu of asiakas.kutsut.filter(k => k.operaatio !== 'select')) {
      assert.ok(kutsu.suodattimet.some(([sarake]) => sarake === 'id'),
        `${repo.table}.${kutsu.operaatio}: kysely ei rajaa tunnisteeseen`);
    }
  }

  // Muistutusasetukset rajaavat id-sarakkeella, koska niiden omistaja
  // on pääavain itse.
  if (AUKI.includes('notificationPreferences')) {
    const asiakas = valeasiakas({ data: null, error: null });
    setClient(asiakas);
    await prefsRepo.loadPreferences();
    const kutsu = asiakas.kutsut[0];
    assert.ok(kutsu.suodattimet.some(([s, v]) => s === 'id' && v === KAYTTAJA_A.id),
      'muistutusasetusten lataus ei rajaa omistajaan');
  }
});

test('AKTIVOITU: ilman kirjautumista mikään ei mene kantaan', async () => {
  // FAIL CLOSED. requireUserId() heittää ilman kirjautunutta käyttäjää,
  // ja repositorion on palautettava fail — ei ok, eikä heittää
  // kutsujalle.
  clearUser();

  for (const portti of AUKI) {
    const repo = repoOf(portti);
    if (!repo) continue;

    const asiakas = valeasiakas({ data: [], error: null });
    setClient(asiakas);

    for (const [nimi, kutsu] of [
      ['list', () => repo.list()],
      ['update', () => repo.update(FIXTUURIT[portti])],
      ['remove', () => repo.remove(FIXTUURIT[portti].id)]
    ]) {
      const tulos = await kutsu();
      assert.equal(tulos.ok, false,
        `${repo.table}.${nimi}: onnistui ilman kirjautumista`);
    }
  }

  if (AUKI.includes('notificationPreferences')) {
    setClient(valeasiakas({ data: null, error: null }));
    const lataus = await prefsRepo.loadPreferences();
    assert.equal(lataus.ok, false, 'asetusten lataus onnistui ilman kirjautumista');
    const tallennus = await prefsRepo.savePreferences({ enabled: true });
    assert.equal(tallennus.ok, false, 'asetusten tallennus onnistui ilman kirjautumista');
  }
});

test('AKTIVOITU: virhe ei koskaan palaudu onnistumisena', async () => {
  // Jos kirjoitus epäonnistuu ja repositorio palauttaisi ok:n,
  // käyttöliittymä kertoisi tallennuksen onnistuneen ja käyttäjä
  // menettäisi työnsä huomaamatta.
  setUser(KAYTTAJA_A);

  const virheet = [
    ['RLS-kielto', { data: null, error: { code: '42501', message: 'permission denied' } }],
    ['yksikäsitteisyys', { data: null, error: { code: '23505', message: 'duplicate key' } }],
    ['vierasavain', { data: null, error: { code: '23503', message: 'fk violation' } }],
    ['verkkovirhe', { throws: new TypeError('Failed to fetch') }]
  ];

  for (const portti of AUKI) {
    const repo = repoOf(portti);
    if (!repo) continue;

    for (const [nimi, vastaus] of virheet) {
      setClient(valeasiakas(vastaus));

      for (const [operaatio, kutsu] of [
        ['list', () => repo.list()],
        ['insert', () => repo.insert(FIXTUURIT[portti])],
        ['update', () => repo.update(FIXTUURIT[portti])],
        ['remove', () => repo.remove(FIXTUURIT[portti].id)]
      ]) {
        const tulos = await kutsu();
        assert.equal(tulos.ok, false,
          `${repo.table}.${operaatio}: ${nimi} palautui onnistumisena`);
        assert.ok(tulos.error && tulos.error.message,
          `${repo.table}.${operaatio}: virheestä ei jäänyt viestiä`);
      }
    }
  }
});

test('AKTIVOITU: tilinvaihto vaihtaa rajauksen eikä vuoda edellisen dataa', async () => {
  // Sama kysely, kaksi eri käyttäjää. Jos rajaus ei vaihtuisi,
  // B:n istunto lukisi A:n rivit.
  for (const portti of AUKI) {
    const repo = repoOf(portti);
    if (!repo) continue;

    setUser(KAYTTAJA_A);
    const asiakasA = valeasiakas({ data: [], error: null });
    setClient(asiakasA);
    await repo.list();

    setUser(KAYTTAJA_B);
    const asiakasB = valeasiakas({ data: [], error: null });
    setClient(asiakasB);
    await repo.list();

    const rajausA = asiakasA.kutsut[0].suodattimet.find(([s]) => s === 'user_id');
    const rajausB = asiakasB.kutsut[0].suodattimet.find(([s]) => s === 'user_id');

    assert.equal(rajausA[1], KAYTTAJA_A.id, `${repo.table}: A:n rajaus väärä`);
    assert.equal(rajausB[1], KAYTTAJA_B.id, `${repo.table}: B:n rajaus väärä`);
    assert.notEqual(rajausA[1], rajausB[1], `${repo.table}: rajaus ei vaihtunut`);
  }
});

test('AKTIVOITU: uloskirjautuminen mitätöi kesken olevan vastauksen', async () => {
  // Pitkä pyyntö voi valmistua vasta uloskirjautumisen jälkeen.
  // Istunnon sukupolvi on se, joka erottaa "sama käyttäjä" -tapauksen
  // ketjusta ulos -> sisään, jossa pelkkä tunniste olisi lopussa sama.
  setUser(KAYTTAJA_A);
  const ennen = sessionSnapshot();
  assert.equal(isSameSession(ennen), true);

  clearUser();
  assert.equal(isSameSession(ennen), false, 'uloskirjautuminen ei mitätöinyt tilannekuvaa');

  setUser(KAYTTAJA_A);
  assert.equal(isSameSession(ennen), false,
    'ulos ja takaisin sisään näytti samalta istunnolta');
});

test('AKTIVOITU: rikkinäinen rivi ei kaada lukua', async () => {
  // Kannasta voi tulla rivi, jonka sarakkeet ovat null tai väärää
  // muotoa. Sen on mäpättävä turvallisesti, ei heittää — muuten yksi
  // vioittunut rivi estäisi koko listan latautumisen.
  setUser(KAYTTAJA_A);

  for (const portti of AUKI) {
    const repo = repoOf(portti);
    if (!repo) continue;

    setClient(valeasiakas({ data: [{ id: null }, {}, { id: 'x' }], error: null }));
    const tulos = await repo.list();

    assert.equal(tulos.ok, true, `${repo.table}: rikkinäinen rivi kaatoi luvun`);
    assert.equal(Array.isArray(tulos.value), true);
    assert.equal(tulos.value.length, 3, `${repo.table}: rivejä katosi mäppäyksessä`);
  }
});

test('AKTIVOITU: avoin portti kertoo säilyvyydestä totuuden', async () => {
  for (const portti of AUKI) {
    const repo = repoOf(portti);
    if (repo) {
      assert.equal(repo.isPersistent(), true,
        `${repo.table}: portti on auki mutta repositorio väittää muuta`);
    }
  }
  if (AUKI.includes('notificationPreferences')) {
    assert.equal(prefsRepo.isPersistent(), true,
      'muistutusasetusten portti on auki mutta moduuli väittää muuta');
  }
});

test('AKTIVOITU: muistutusasetusten tallennus on upsert eikä sokea update', async () => {
  // Uudella käyttäjällä ei ole vielä riviä. Pelkkä update ei
  // epäonnistuisi vaan päivittäisi nolla riviä — ja kertoisi
  // onnistuneensa.
  if (!AUKI.includes('notificationPreferences')) return;

  setUser(KAYTTAJA_A);
  const asiakas = valeasiakas({ data: null, error: null });
  setClient(asiakas);

  const tulos = await prefsRepo.savePreferences({ enabled: true, maxPerDay: 5 });
  assert.equal(tulos.ok, true);

  // Ennen istunnon ensimmäistä tallennusta rivi luetaan: oletusten päälle
  // tehty muutos ei saa korvata palvelimella jo olevaa riviä. Lukuja saa
  // siis olla, kirjoituksia tasan yksi.
  const kirjoitukset = asiakas.kutsut.filter(k => k.operaatio !== 'select');
  assert.equal(kirjoitukset.length, 1);
  assert.equal(kirjoitukset[0].operaatio, 'upsert',
    'asetusten tallennus ei ole upsert');
  assert.equal(kirjoitukset[0].payload.id, KAYTTAJA_A.id,
    'asetusrivin omistaja ei ole kirjautunut käyttäjä');

  // created_at ja updated_at ovat palvelimen omia myös täällä.
  for (const kentta of ['created_at', 'updated_at']) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(kirjoitukset[0].payload, kentta), false,
      `asetusrivi sisältää palvelimen kentän ${kentta}`);
  }
});

// =====================================================================
// AI-KIRJAUSKETJUN SALLITTUJEN KENTTIEN LUETTELO
// =====================================================================
//
// Kirjausketju on ainoa taulu, johon kirjoitetaan AI:n toiminnasta.
// Juuri siksi se on se paikka, johon raaka syöte, koko vastaus tai
// avain voisi vahingossa päätyä — eikä sitä huomaisi kukaan, koska
// taulua ei lueta käyttöliittymässä.
//
// Sallittujen kenttien luettelo on siis kirjoitettu auki. Uusi kenttä
// ei mene läpi vahingossa: se kaataa tämän testin, ja silloin joku
// joutuu toteamaan ääneen mitä siihen tallennetaan ja miksi.

test('KRIITTINEN: AI-kirjaus tallentaa vain sallitut kentät', () => {
  const repo = repoOf('aiAudit');
  assert.ok(repo, 'aiAudit-repositoriota ei löytynyt');

  const SALLITUT = [
    'id', 'occurred_at', 'input_summary', 'intent', 'risk',
    'target_type', 'target_id', 'proposal', 'confirmed', 'executed',
    'result', 'error_code'
  ];

  const rivi = repo.mapping.toRow(repo.mapping.normalize({
    id: 'a-1',
    timestamp: '2026-09-10T08:00:00.000Z',
    input: 'käyttäjän koko puhe, joka on pitkä ja henkilökohtainen',
    intent: 'create_task', risk: 'medium',
    targetType: 'task', targetId: 't-1',
    proposal: 'Luodaan tehtävä', confirmed: true, executed: true,
    result: 'executed', errorCode: null
  }));

  for (const kentta of Object.keys(rivi)) {
    assert.ok(SALLITUT.includes(kentta),
      `AI-kirjaus lähettää kentän ${kentta}, jota ei ole sallittujen listalla`);
  }

  // Eikä yksikään kielletty kenttä ole mukana.
  for (const kielletty of ['user_id', 'created_at', 'updated_at',
                           'raw_input', 'prompt', 'response', 'api_key',
                           'transcript', 'messages']) {
    assert.equal(Object.prototype.hasOwnProperty.call(rivi, kielletty), false,
      `AI-kirjaus lähettää kielletyn kentän ${kielletty}`);
  }
});

test('KRIITTINEN: AI-kirjaus ei tallenna raakaa syötettä eikä ylitä pituusrajoja', () => {
  const repo = repoOf('aiAudit');

  const pitkaSyote = 'x'.repeat(1000);
  const pitkaEhdotus = 'y'.repeat(1000);

  const rivi = repo.mapping.toRow(repo.mapping.normalize({
    id: 'a-2', timestamp: '2026-09-10T08:00:00.000Z',
    input: pitkaSyote, proposal: pitkaEhdotus,
    intent: 'create_task', risk: 'low'
  }));

  // Kannassa on CHECK-rajoitteet 200 ja 300. Jos domain päästäisi
  // pidemmän läpi, jokainen kirjaus hylättäisiin koodilla 23514 --
  // eli kirjausketju lakkaisi toimimasta hiljaa.
  assert.ok(rivi.input_summary.length <= 200,
    `input_summary on ${rivi.input_summary.length} merkkiä, raja on 200`);
  assert.ok(rivi.proposal.length <= 300,
    `proposal on ${rivi.proposal.length} merkkiä, raja on 300`);

  // Eikä raaka syöte ole tallessa kokonaisena.
  assert.equal(rivi.input_summary === pitkaSyote, false,
    'raaka syöte tallentuu sellaisenaan');
});

test('KRIITTINEN: aikaleima jätetään pois kun sitä ei ole', () => {
  // Sarake on `occurred_at timestamptz not null default now()`.
  // Oletusarvo EI pelasta nimenomaista NULLia: PostgreSQL käyttää
  // oletusta vain kun sarake jätetään pois lauseesta. Lähetetty NULL
  // on arvo, joka hylätään koodilla 23502 -- ja jokainen kirjaus
  // kaatuisi heti kun portti avataan.
  const repo = repoOf('aiAudit');

  const ilman = repo.mapping.toRow(repo.mapping.normalize({
    id: 'a-3', intent: 'create_task', risk: 'low'
  }));
  assert.equal(Object.prototype.hasOwnProperty.call(ilman, 'occurred_at'), false,
    'aikaleima lähetetään vaikka sitä ei ole — kanta hylkäisi rivin');

  const kanssa = repo.mapping.toRow(repo.mapping.normalize({
    id: 'a-4', timestamp: '2026-09-10T08:00:00.000Z',
    intent: 'create_task', risk: 'low'
  }));
  assert.equal(kanssa.occurred_at, '2026-09-10T08:00:00.000Z',
    'annettu aikaleima ei mene läpi');
});

test('KRIITTINEN: suoritettu ilman vahvistusta ei ole kelvollinen kirjaus', async () => {
  // Kannassa on `check (executed = false or confirmed = true)`.
  // Sama invariantti on domainissa, ja sen on oltava MOLEMMISSA: kanta
  // on viimeinen este, ei ainoa. Jos vain kanta valvoisi sitä, virhe
  // näkyisi käyttäjälle vasta tallennuksen epäonnistumisena — eikä
  // silloin tiedettäisi, oliko kyse virheestä vai turvamallin
  // rikkoutumisesta.
  const { validateAuditEntry, normalizeAuditEntry } =
    await import('../src/domain/audit.js');

  const rikkova = normalizeAuditEntry({
    id: 'a-5', timestamp: '2026-09-10T08:00:00.000Z',
    intent: 'create_task', risk: 'high',
    confirmed: false, executed: true, result: 'executed'
  });
  const tulos = validateAuditEntry(rikkova);
  assert.equal(tulos.valid, false,
    'suoritettu ilman vahvistusta läpäisi domain-tarkistuksen');
  assert.ok(tulos.errors.confirmed, 'virhettä ei kohdistettu vahvistukseen');

  // Ja vahvistettu suoritus on kelvollinen.
  const kelvollinen = normalizeAuditEntry({
    id: 'a-6', timestamp: '2026-09-10T08:00:00.000Z',
    intent: 'create_task', risk: 'high',
    confirmed: true, executed: true, result: 'executed'
  });
  assert.equal(validateAuditEntry(kelvollinen).valid, true);
});

test('TILANNE: sovelluksessa ei ole AI-kirjauksen kirjoituspolkua', async () => {
  // TÄMÄ TESTI KUVAA TILAA, EI VAADI SITÄ.
  //
  // Koko lähdepuussa on tasan yksi aiAuditRepo-kutsu, ja se on `list()`.
  // Kirjausketju on siis valmis mutta kytkemättä: portin avaaminen
  // muuttaa yhden luvun muistista kannaksi eikä tuota yhtään riviä.
  //
  // Se on olennainen tieto aallon E hyväksynnälle, koska sille ei voi
  // luoda hyväksyntädataa käyttöliittymästä. Jos kirjoituspolku joskus
  // lisätään, tämä testi kaatuu — ja silloin aallon E hyväksyntäohje
  // on päivitettävä samassa yhteydessä.
  const { read } = await import('./helpers/sources.mjs');
  const koodi = read('src/app/actions.js');

  const kutsut = [...koodi.matchAll(/aiAuditRepo\.(\w+)\(/g)].map(m => m[1]);
  assert.deepEqual(kutsut, ['list'],
    `aiAuditRepo-kutsut ovat nyt: ${kutsut.join(', ')}.`
    + ' Jos kirjoituspolku lisättiin, päivitä docs/acceptance/WAVE-E.md.');
});
