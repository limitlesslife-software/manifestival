// Ristiinvuoto käyttäjien välillä jaetulla selaimella.
//
// LÖYTYNYT BUGI, JOTA TÄMÄ TESTI VARTIOI
//
// Kun migraatioita 0003–0006 ei ole ajettu, rutiinit, tavoitteet, projektit
// ja hyvinvointimerkinnät elävät repositorioiden MUISTIVARASTOSSA. Se on
// moduulitasoinen: yksi instanssi koko sivun eliniän ajan.
//
// resetState() nollaa sovelluksen tilan mutta EI repositorion sisuksia.
// clearAllCollections() oli olemassa ja yksikkötestattu, mutta sitä ei
// kutsuttu sovelluksesta kertaakaan. Siitä seurasi:
//
//   1. Käyttäjä A kirjautuu ja luo rutiineja ja tavoitteita
//   2. A kirjautuu ulos
//   3. Käyttäjä B kirjautuu samassa välilehdessä
//   4. loadUserData() -> routinesRepo.list() -> muistivarasto
//   5. B näkee A:n rutiinit ja tavoitteet
//
// RLS ei voi estää tätä, koska palvelimelta ei haeta mitään. Suojaus on
// yksinomaan asiakaspuolen vastuulla, ja siksi se testataan täällä.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  routinesRepo, goalsRepo, projectsRepo, wellbeingRepo, routineExceptionsRepo,
  lifeAreasRepo, weeklyCapacitiesRepo, timeEntriesRepo, alignmentReviewsRepo,
  runningTimersRepo, alignmentItemSettingsRepo,
  ALL_REPOSITORIES, clearAllCollections
} from '../src/data/collectionsRepo.js';
import { loadPreferences, savePreferences, clearPreferences }
  from '../src/data/notificationPrefsRepo.js';
import { clearLocalUserData } from '../src/app/actions.js';
import { read } from './helpers/sources.mjs';
import { isGateOpen, fakeClient } from './helpers/gates.mjs';
import { setClient } from '../src/data/client.js';
import { setUser, clearUser } from '../src/data/session.js';
import {
  getState, resetState, setLifeAreas, setWeeklyCapacities, setTimeEntries, setAlignmentReviews,
  setAlignmentItemSettings, setRunningTimerInState
} from '../src/app/state.js';
import {
  restoreLocalTimer, initTimerCrossTabSync, stopTimerCrossTabSync, resetTimerSync, currentTimer
} from '../src/app/timerState.js';
import { pendingTimeEntryCount, resetAlignmentSession } from '../src/app/alignment.js';
import { offline } from '../src/app/offline.js';
import {
  saveTimer, loadTimer, saveOutbox, loadOutbox, savePendingTimers, loadPendingTimers,
  timerKey, outboxKey, pendingTimersKey, resetTimerStoreForTests
} from '../src/data/timerStore.js';
import { queueKey, resetQueueStoreForTests } from '../src/data/offlineQueueStore.js';
import { ensureSchemaCompatibility, resetSchemaProbeForTests } from '../src/data/schemaProbe.js';
import {
  schemaSnapshot, isWritable, resetSchemaRuntimeForTests, SCHEMA_STATUS
} from '../src/data/schemaRuntime.js';
import { setSchemaStatusActive } from '../src/app/schemaStatus.js';
import { createSchemaServer, memoryStorage, migrationsThrough } from './helpers/schemaServer.mjs';

beforeEach(() => {
  clearAllCollections();
  clearPreferences();
});

// MIKSI NAMA KIRJOITTAVAT MUISTIVARASTOON SUORAAN
//
// Vuoto, jota tama tiedosto vartioi, on nimenomaan ASIAKASPUOLEN
// muistivaraston vuoto: varasto on moduulitasoinen ja elaa koko sivun
// elinajan, joten ilman tyhjennysta seuraava kirjautuja nakisi
// edellisen rivit. RLS ei voi estaa sita, koska palvelimelta ei haeta
// mitaan.
//
// Portin auettua sama repositorio ohjaa kutsut kantaan, jolloin
// `repo.insert()` ei enaa kirjoittaisi muistiin -- eika testi enaa
// todistaisi mitaan siita, mita se on olemassa todistamaan. Siksi
// kirjoitus ja luku tehdaan `repo.memory`-olion kautta: se on sama
// varasto, johon portti-kiinni-polku kirjoittaa, ja se on olemassa
// jokaisessa aallossa.
//
// Tyhjennys sen sijaan kutsutaan OIKEASTA sovelluspolusta
// (`clearLocalUserData`), koska juuri sen kutsumatta jattaminen oli
// alkuperainen bugi.

/** Kirjoita jokaiseen kokoelmaan yksi rivi, kuten käyttäjä A tekisi. */
async function seedAsUserA() {
  await routinesRepo.memory.insert({
    id: 'r-a', title: 'Käyttäjä A:n aamurutiini', active: true,
    recurrence: { type: 'daily', weekdays: [] }
  });
  await routineExceptionsRepo.memory.insert({
    id: 'x-a', routineId: 'r-a', date: '2026-03-15', type: 'skip'
  });
  await goalsRepo.memory.insert({ id: 'g-a', title: 'Käyttäjä A:n salainen tavoite' });
  await projectsRepo.memory.insert({ id: 'p-a', name: 'A:n projekti' });
  await wellbeingRepo.memory.insert({ id: 'w-a', date: '2026-03-15', energy: 2, mood: 2 });
  await savePreferences({ enabled: true, maxPerDay: 7 });
}

/** Mitä uusi käyttäjä näkisi, jos hän kirjautuisi nyt sisään. */
async function whatNextUserSees() {
  const results = await Promise.all(ALL_REPOSITORIES.map(repo => repo.memory.list()));
  return results.flatMap(result => (result.ok ? result.value : []));
}

test('lähtötilanne: käyttäjän data päätyy muistivarastoon', async () => {
  // Ilman tätä koko testi olisi merkityksetön: jos data ei koskaan päädy
  // muistiin, vuotoa ei voisi tapahtua eikä testi todistaisi mitään.
  await seedAsUserA();
  const visible = await whatNextUserSees();

  assert.equal(visible.length, 5, 'testidataa ei tallennettu muistivarastoon');
});

test('REGRESSIO: uloskirjautuminen tyhjentää kaikki kokoelmat', async () => {
  await seedAsUserA();
  assert.ok((await whatNextUserSees()).length > 0);

  clearLocalUserData();

  const visible = await whatNextUserSees();
  assert.deepEqual(visible, [],
    'seuraava käyttäjä näkisi edellisen käyttäjän tiedot:\n'
    + JSON.stringify(visible, null, 2));
});

test('REGRESSIO: uloskirjautuminen palauttaa muistutusasetukset oletukseen', async () => {
  // Muistutusasetukset ovat oma moduulinsa eivatka ALL_REPOSITORIES-
  // listassa, joten ne on tarkistettava erikseen -- juuri sellainen
  // erillisyys jaa muuten huomaamatta.
  //
  // Portin ollessa AUKI asetukset tulevat kannasta. Silloin sama
  // invariantti -- "seuraava kayttaja ei peri edellisen asetuksia" --
  // todistetaan valeasiakkaalla, joka palauttaa uudelle kayttajalle
  // tyhjan tuloksen. Vaite on sama, todistuskeino eri.
  if (isGateOpen('notificationPreferences')) {
    setUser({ id: 'aaaaaaaa-0000-0000-0000-000000000001', email: 'a@example.com' });
    setClient(fakeClient({ data: { id: 'a', enabled: true, daily_plan_time: '05:00' },
                           error: null }));
    const before = await loadPreferences();
    assert.equal(before.value.enabled, true, 'A:n asetuksia ei saatu ladattua');

    clearLocalUserData();

    // Uusi kayttaja, ei riviae kannassa.
    setUser({ id: 'bbbbbbbb-0000-0000-0000-000000000002', email: 'b@example.com' });
    setClient(fakeClient({ data: null, error: null }));
    const after = await loadPreferences();

    assert.equal(after.value.enabled, false,
      'seuraava käyttäjä perisi edellisen muistutusasetukset');
    assert.equal(after.value.dailyPlanTime, '07:30', 'oletusaika ei palautunut');

    clearUser();
    setClient(null);
    return;
  }

  await savePreferences({ enabled: true, maxPerDay: 3, dailyPlanTime: '05:00' });

  const before = await loadPreferences();
  assert.equal(before.value.enabled, true);

  clearLocalUserData();

  const after = await loadPreferences();
  assert.equal(after.value.enabled, false,
    'seuraava käyttäjä perisi edellisen muistutusasetukset');
  assert.equal(after.value.dailyPlanTime, '07:30', 'oletusaika ei palautunut');
});

test('jokainen kokoelma tyhjenee, ei vain osa', async () => {
  // Osittainen tyhjennys olisi pahin mahdollinen lopputulos: se näyttäisi
  // toimivan ja vuotaisi silti.
  await seedAsUserA();
  clearLocalUserData();

  for (const repo of ALL_REPOSITORIES) {
    const result = await repo.memory.list();
    assert.ok(result.ok, repo.table + ': listaus epäonnistui');
    assert.deepEqual(result.value, [], repo.table + ' ei tyhjentynyt');
  }
});

test('tyhjennys on turvallinen kutsua kahdesti', async () => {
  await seedAsUserA();
  clearLocalUserData();
  clearLocalUserData();
  assert.deepEqual(await whatNextUserSees(), []);
});

test('tyhjennys tyhjällä varastolla ei kaadu', () => {
  assert.doesNotThrow(() => clearLocalUserData());
});

test('sovellus kutsuu tyhjennystä uloskirjautuessa', () => {
  // Toiminto voi olla oikein toteutettu ja silti kytkemättä. Juuri niin
  // alkuperäinen bugi syntyi: clearAllCollections oli olemassa ja testattu,
  // mutta sitä ei kutsuttu sovelluksesta kertaakaan.
  const main = read('src/app/main.js');
  const signOut = main.slice(main.indexOf('function onSignedOut'));
  const body = signOut.slice(0, signOut.indexOf('\n}'));

  assert.ok(body.includes('clearLocalUserData()'),
    'onSignedOut ei tyhjennä paikallista dataa');
});

// =====================================================================
// SUUNTA: A -> B SAMALLA LAITTEELLA
// =====================================================================
//
// Suunnan data on sovelluksen yksityisintä (alueiden nimet, pohdinnat,
// kirjausten muistiinpanot), ja osa siitä elää laitteella tarkoituksella
// uloskirjautumisen yli: ajastin, lähtökori ja offline-jono säilyvät A:lle,
// kun A palaa. Siksi vaihto A -> B todistetaan kaikille neljälle: tila ja
// muistivarastot, ajastin (palautus ja välilehtitapahtumat), lähtökori ja
// offline-jono sekä skeemavälimuisti.

const USER_A = { id: 'aaaaaaaa-5151-4151-8151-00000000000a', email: 'a@example.com' };
const USER_B = { id: 'bbbbbbbb-5252-4252-8252-00000000000b', email: 'b@example.com' };
const TIMER_A = { id: 'rt-a', startedAt: '2026-09-21T07:00:00.000Z', targetKind: 'none', note: 'A:n ajastinmuistiinpano' };
const TIMER_B = { id: 'rt-b', startedAt: '2026-09-21T08:00:00.000Z', targetKind: 'none' };

/** Testikohtainen localStorage. */
function installStorage() {
  const data = new Map();
  globalThis.localStorage = {
    getItem: key => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => { data.set(key, String(value)); },
    removeItem: key => { data.delete(key); },
    key: index => [...data.keys()][index] ?? null,
    get length() { return data.size; }
  };
  return data;
}

/** window-korvike storage-tapahtumille (toinen välilehti). */
function tabEvents() {
  const listeners = new Map();
  return {
    addEventListener: (type, fn) => { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
    removeEventListener: (type, fn) => { if (listeners.has(type)) listeners.get(type).delete(fn); },
    dispatch: (type, event) => { for (const fn of [...(listeners.get(type) || [])]) fn(event); },
    count: type => (listeners.get(type) ? listeners.get(type).size : 0)
  };
}

/** main.js onSignedOut ilman DOM-osia, samassa järjestyksessä. */
function signOutLikeApp() {
  offline.deactivate();
  stopTimerCrossTabSync();
  resetTimerSync();
  resetAlignmentSession();
  clearLocalUserData();
  resetState();
  setSchemaStatusActive(false);
  clearUser();
}

/** main.js onSignedIn: jono ja ajastin laitteelta ennen latausta. */
function signInLikeApp(user, target) {
  setUser(user);
  offline.activate(user.id);
  restoreLocalTimer();
  initTimerCrossTabSync(target);
}

function cleanupDevice() {
  offline.deactivate();
  stopTimerCrossTabSync();
  resetTimerSync();
  resetState();
  clearUser();
  resetTimerStoreForTests();
  resetQueueStoreForTests();
  delete globalThis.localStorage;
}

test('REGRESSIO: A -> B — B ei näe A:n alueita, kirjauksia, katsauksia, kapasiteetteja, asetuksia eikä ajastinta', async () => {
  installStorage();
  try {
    setUser(USER_A);
    await lifeAreasRepo.memory.insert({ id: 'la-a', name: 'Terapia', importance: 5 });
    await weeklyCapacitiesRepo.memory.insert({ id: 'wc-a', weekStart: '2026-09-21', availableMinutes: 1200 });
    await timeEntriesRepo.memory.insert({ id: 'te-a', entryDate: '2026-09-21', minutes: 30, note: 'A:n muistiinpano' });
    await alignmentReviewsRepo.memory.insert({ id: 'ar-a', weekStart: '2026-09-21', snapshot: {}, reflection: 'A:n pohdinta' });
    await alignmentItemSettingsRepo.memory.insert({ id: 'as-a', itemKind: 'task', itemId: 't-a', energyDemand: 4 });
    await runningTimersRepo.memory.insert(TIMER_A);
    setLifeAreas([{ id: 'la-a', name: 'Terapia', importance: 5 }]);
    setWeeklyCapacities([{ id: 'wc-a', weekStart: '2026-09-21', availableMinutes: 1200 }]);
    setTimeEntries([{ id: 'te-a', entryDate: '2026-09-21', minutes: 30, note: 'A:n muistiinpano' }]);
    setAlignmentReviews([{ id: 'ar-a', weekStart: '2026-09-21', snapshot: {}, reflection: 'A:n pohdinta' }]);
    setAlignmentItemSettings([{ id: 'as-a', itemKind: 'task', itemId: 't-a', energyDemand: 4 }]);
    setRunningTimerInState(TIMER_A);

    // Lähtötilanne: A:n data on tilassa ja muistissa, muuten testi ei todista mitään.
    const suunta = ['lifeAreas', 'weeklyCapacities', 'timeEntries', 'alignmentReviews',
      'alignmentItemSettings', 'runningTimers'];
    for (const key of suunta) assert.equal(getState()[key].length, 1, `lähtötilanne: ${key}`);

    signOutLikeApp();
    signInLikeApp(USER_B, tabEvents());

    for (const key of suunta) assert.deepEqual(getState()[key], [], `B näkee A:n ${key}`);
    for (const repo of [lifeAreasRepo, weeklyCapacitiesRepo, timeEntriesRepo, alignmentReviewsRepo,
      runningTimersRepo, alignmentItemSettingsRepo]) {
      assert.deepEqual((await repo.memory.list()).value, [], `${repo.table}: muistivarasto ei tyhjentynyt`);
    }
    const nakyva = JSON.stringify(getState());
    for (const secret of ['Terapia', 'A:n pohdinta', 'A:n muistiinpano', 'A:n ajastinmuistiinpano']) {
      assert.equal(nakyva.includes(secret), false, `B:n tila kantaa: ${secret}`);
    }
  } finally {
    cleanupDevice();
  }
});

test('KRIITTINEN: A:n ajastin ei koskaan näy B:lle — ei palautuksessa eikä välilehtitapahtumassa', () => {
  const data = installStorage();
  const tab = tabEvents();
  try {
    setUser(USER_A);
    saveTimer(USER_A.id, TIMER_A);
    signInLikeApp(USER_A, tab);
    assert.equal(currentTimer().id, 'rt-a', 'lähtötilanne: A:n ajastin palautuu A:lle');

    signOutLikeApp();
    signInLikeApp(USER_B, tab);
    assert.equal(currentTimer(), null);
    assert.equal(restoreLocalTimer(), null);
    assert.equal(tab.count('storage'), 1, 'A:n välilehtikuuntelija jäi voimaan');

    // A:n toinen välilehti muuttaa A:n ajastinta ja odottavia: B ei reagoi.
    saveTimer(USER_A.id, { ...TIMER_A, pausedSeconds: 60 });
    tab.dispatch('storage', { key: timerKey(USER_A.id) });
    assert.equal(currentTimer(), null, 'A:n ajastinmuutos näkyi B:lle');
    savePendingTimers(USER_A.id, [{ ...TIMER_A, id: 'rt-a2' }]);
    tab.dispatch('storage', { key: pendingTimersKey(USER_A.id) });
    assert.equal(currentTimer(), null);
    // Koko tallennuksen tyhjennys toisessa välilehdessä (key = null) lukee B:n oman avaimen.
    tab.dispatch('storage', { key: null });
    assert.equal(currentTimer(), null);

    // Väärennös: A:n tallenne B:n avaimella hylätään sisällön userId:n perusteella.
    data.set(timerKey(USER_B.id), data.get(timerKey(USER_A.id)));
    tab.dispatch('storage', { key: timerKey(USER_B.id) });
    assert.equal(currentTimer(), null, 'A:n ajastin kelpasi B:n avaimella');
    assert.equal(loadTimer(USER_B.id), null);
    assert.equal(restoreLocalTimer(), null);

    // B:n oma ajastin näkyy: tarkistus ei ole rikki kaikille.
    saveTimer(USER_B.id, TIMER_B);
    tab.dispatch('storage', { key: timerKey(USER_B.id) });
    assert.equal(currentTimer().id, 'rt-b');

    // A palaa: A:n ajastin (ja vain se) on tallessa.
    signOutLikeApp();
    signInLikeApp(USER_A, tab);
    assert.equal(currentTimer().id, 'rt-a');
    assert.equal(loadPendingTimers(USER_A.id).length, 1);
    assert.equal(loadPendingTimers(USER_B.id).length, 0);
  } finally {
    cleanupDevice();
  }
});

test('KRIITTINEN: A:n lähtökori ja offline-jono eivät näy eivätkä lähde B:n istunnossa', () => {
  const data = installStorage();
  try {
    signInLikeApp(USER_A, tabEvents());
    const queued = offline.enqueueTaskCreate({ id: 't-a', title: 'A:n salainen tehtävä', date: '2026-09-21' });
    assert.equal(queued.ok, true, 'lähtötilanne: jonotus epäonnistui');
    saveOutbox(USER_A.id, [{ id: 'e-a', entryDate: '2026-09-21', minutes: 30, operationId: 'log:e-a', note: 'A:n muistiinpano' }]);
    assert.equal(offline.status().total, 1);
    assert.equal(pendingTimeEntryCount(), 1);

    signOutLikeApp();
    signInLikeApp(USER_B, tabEvents());
    assert.equal(offline.status().total, 0, 'A:n jono aktivoitui B:lle');
    assert.equal(pendingTimeEntryCount(), 0, 'A:n lähtökori laskettiin B:lle');
    assert.deepEqual(loadOutbox(USER_B.id), []);

    // Avaimet ovat käyttäjäkohtaisia, eikä B:n avaimissa ole A:n sisältöä.
    for (const keyOf of [queueKey, outboxKey, timerKey]) {
      assert.notEqual(keyOf(USER_A.id), keyOf(USER_B.id));
      assert.ok(keyOf(USER_A.id).endsWith(USER_A.id));
    }
    const bText = [...data].filter(([key]) => key.includes(USER_B.id)).map(([, value]) => value).join('\n');
    for (const secret of ['A:n salainen tehtävä', 'A:n muistiinpano', USER_A.id]) {
      assert.equal(bText.includes(secret), false, `B:n avaimessa: ${secret}`);
    }

    // A:n muutokset eivät kadonneet: ne lähtevät, kun A palaa.
    signOutLikeApp();
    signInLikeApp(USER_A, tabEvents());
    assert.equal(offline.status().total, 1);
    assert.equal(pendingTimeEntryCount(), 1);
  } finally {
    offline.purge(USER_A.id);
    cleanupDevice();
  }
});

test('KRIITTINEN: skeemavälimuisti A -> B — ei käyttäjätietoa, eikä A:n istunnon kielto siirry B:lle', async () => {
  resetSchemaRuntimeForTests();
  resetSchemaProbeForTests();
  const storage = memoryStorage();
  try {
    setUser(USER_A);
    setSchemaStatusActive(true);
    const server = createSchemaServer({
      applied: migrationsThrough('0013'), revoked: ['profile'], currentUserId: () => USER_A.id
    });
    await ensureSchemaCompatibility({ client: server, isOnline: () => true, storage });
    assert.equal(schemaSnapshot().status, SCHEMA_STATUS.MAINTENANCE, 'lähtötilanne: A:n istunnon kielto');

    // Välimuisti on laitteen ja käännöksen, ei käyttäjän: avaimessa eikä
    // arvossa ei ole tunnistetta, eikä istuntoon sidottu kielto tallennu.
    assert.ok(storage.keys().length > 0, 'välimuistia ei kirjoitettu');
    for (const key of storage.keys()) {
      assert.ok(key.startsWith('manifestival.schemaCompat.v1.'), key);
      const value = storage.getItem(key);
      for (const secret of [USER_A.id, USER_A.email]) {
        assert.equal(key.includes(secret) || value.includes(secret), false, `välimuistissa: ${secret}`);
      }
      assert.equal(Object.values(JSON.parse(value).results).includes('forbidden'), false,
        'istunnon kielto tallentui laitteelle');
    }

    signOutLikeApp();
    setUser(USER_B);
    setSchemaStatusActive(true);
    // B käynnistyy offline: vain välimuisti, ei tarkistusta.
    await ensureSchemaCompatibility({ client: server, isOnline: () => false, storage });
    assert.notEqual(schemaSnapshot().status, SCHEMA_STATUS.MAINTENANCE, 'A:n kielto siirtyi B:lle');
    assert.equal(isWritable(), true);
  } finally {
    setSchemaStatusActive(false);
    resetSchemaRuntimeForTests();
    resetSchemaProbeForTests();
    clearUser();
  }
});
