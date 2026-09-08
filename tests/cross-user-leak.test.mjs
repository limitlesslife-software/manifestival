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
  ALL_REPOSITORIES, clearAllCollections
} from '../src/data/collectionsRepo.js';
import { loadPreferences, savePreferences, clearPreferences }
  from '../src/data/notificationPrefsRepo.js';
import { clearLocalUserData } from '../src/app/actions.js';
import { read } from './helpers/sources.mjs';
import { isGateOpen, fakeClient } from './helpers/gates.mjs';
import { setClient } from '../src/data/client.js';
import { setUser, clearUser } from '../src/data/session.js';

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
