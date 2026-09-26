// Tilin elinkaari-inventaarion testit.
//
// TÄRKEIN VÄITE TÄSSÄ TIEDOSTOSSA: jos joku lisää uuden repositorion
// collectionsRepo.js:ään (tai uuden aina-auki-olevan taulun tasks/
// profile/notificationPreferences-tapaan) mutta unohtaa lisätä sen
// vientiin/poistoinventaarioon, TÄMÄ TESTI KAATUU. Ilman sitä uusi
// tietotyyppi katoaisi vientitiedostosta ja poiston kuiva-ajosta
// hiljaa, ja käyttäjä luulisi saaneensa kaiken tietonsa vaikka ei olisi.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ACCOUNT_OWNED_COLLECTIONS, STORED_FILE_CATEGORIES,
  authAccountDeletable, authAccountBlockedReason, dryRunDeletion, collectionCount
} from '../src/domain/accountLifecycle.js';
import { EXPORTED_COLLECTIONS, buildUserDataExport } from '../src/domain/dataExport.js';
import { ALL_REPOSITORIES } from '../src/data/collectionsRepo.js';
import { resetState, getState, setProfile } from '../src/app/state.js';
import { collectExportData } from '../src/app/views/profile.js';

// Kokoelmat, joilla ei ole omaa repositoriota collectionsRepo.js:ssä --
// ne käyttävät erillistä moduulia (tasksRepo.js, profileRepo.js,
// notificationPrefsRepo.js), koska ne ovat aina-auki-olevia
// perustauluja eri omistajuusmallilla.
const NON_COLLECTIONS_REPO_TABLES = ['tasks', 'profile', 'notificationPreferences'];

test('KRIITTINEN: elinkaari-inventaario on TÄSMÄLLEEN sama lista kuin vienti', () => {
  // Ei kahta luetteloa, jotka voivat ajautua erilleen -- accountLifecycle.js
  // lukee dataExport.js:n listan uudelleenviennillä eikä omista kopiotaan.
  assert.equal(ACCOUNT_OWNED_COLLECTIONS, EXPORTED_COLLECTIONS,
    'accountLifecycle.js:llä on oma kopio listasta EXPORTED_COLLECTIONS:n sijaan');
});

test('KRIITTINEN: jokainen rekisteröity repositorio on elinkaari-inventaariossa', () => {
  const missing = ALL_REPOSITORIES
    .map(repo => repo.schemaKey)
    .filter(key => !ACCOUNT_OWNED_COLLECTIONS.includes(key));

  assert.deepEqual(missing, [],
    `Näillä repositorioilla on schemaKey, joka puuttuu elinkaari-inventaariosta: ${missing.join(', ')}. `
    + 'Uusi tietotyyppi katoaisi viennistä ja poiston kuiva-ajosta hiljaa.');
});

test('KRIITTINEN: inventaariossa ei ole nimiä joita mikään repositorio tai perustaulu ei tunnista', () => {
  const known = new Set([
    ...ALL_REPOSITORIES.map(repo => repo.schemaKey),
    ...NON_COLLECTIONS_REPO_TABLES
  ]);
  const unknown = ACCOUNT_OWNED_COLLECTIONS.filter(name => !known.has(name));

  assert.deepEqual(unknown, [],
    `Inventaariossa on nimiä, joita mikään repositorio ei tunnista: ${unknown.join(', ')}. `
    + 'Tarkista kirjoitusvirhe tai poistettu tietotyyppi.');
});

test('inventaario kattaa perustaulut jotka eivät ole collectionsRepo.js:ssä', () => {
  for (const table of NON_COLLECTIONS_REPO_TABLES) {
    assert.ok(ACCOUNT_OWNED_COLLECTIONS.includes(table),
      `perustaulu "${table}" puuttuu elinkaari-inventaariosta`);
  }
});

test('collectionCount vastaa listan todellista pituutta', () => {
  assert.equal(collectionCount(), ACCOUNT_OWNED_COLLECTIONS.length);
});

// Olio-kokoelmat: yksi rivi per käyttäjä (id = auth.uid()), ei lista.
const OBJECT_COLLECTIONS = ['profile', 'notificationPreferences'];

test('KRIITTINEN: jokainen inventaarion nimi on sovelluksen tilan oma kenttä oikeaa muotoa', () => {
  // Vienti ja poiston kuiva-ajo lukevat kokoelmat tilasta NIMELLÄ
  // (collectExportData). Nimi, jota tilassa ei ole, vietäisiin aina
  // tyhjänä ja kuiva-ajo näyttäisi nollaa -- vaikka kannassa on rivejä.
  resetState();
  const state = getState();
  for (const name of ACCOUNT_OWNED_COLLECTIONS) {
    assert.ok(Object.prototype.hasOwnProperty.call(state, name), `tilasta puuttuu kenttä ${name}`);
    if (OBJECT_COLLECTIONS.includes(name)) {
      assert.equal(typeof state[name], 'object', name);
      assert.equal(Array.isArray(state[name]), false, name);
    } else {
      assert.ok(Array.isArray(state[name]), `${name} ei ole lista alkutilassa`);
    }
  }
});

test('KRIITTINEN: profiilia, jota ei ole tallennettu, ei lasketa eikä viedä käyttäjän tietona', () => {
  resetState();
  const initial = collectExportData(getState());
  assert.equal(initial.profile, null, 'oletusprofiili ei ole käyttäjän riviä');
  assert.equal(dryRunDeletion(initial).collections.find(c => c.name === 'profile').count, 0);
  assert.deepEqual(buildUserDataExport(initial).data.profile, {});
  // Muut kokoelmat kulkevat tilasta sellaisinaan.
  assert.equal(initial.tasks, getState().tasks);

  setProfile({ age: 40 }, true);
  const saved = collectExportData(getState());
  assert.equal(saved.profile.age, 40);
  assert.equal(dryRunDeletion(saved).collections.find(c => c.name === 'profile').count, 1);

  setProfile({ age: 41 }, false);
  assert.equal(collectExportData(getState()).profile, null);
  resetState();
});

// ============================================================ kuiva-ajo

test('dryRunDeletion laskee rivimäärät jokaiselle kokoelmalle, myös tyhjille', () => {
  const report = dryRunDeletion({ tasks: [{ id: 't1' }, { id: 't2' }], goals: [{ id: 'g1' }] });

  const tasksEntry = report.collections.find(c => c.name === 'tasks');
  const goalsEntry = report.collections.find(c => c.name === 'goals');
  const billsEntry = report.collections.find(c => c.name === 'bills');

  assert.equal(tasksEntry.count, 2);
  assert.equal(goalsEntry.count, 1);
  assert.equal(billsEntry.count, 0, 'mainitsematon kokoelma on nolla, ei puuttuva');
  assert.equal(report.collections.length, ACCOUNT_OWNED_COLLECTIONS.length);
});

test('dryRunDeletion laskee olio-kokoelmat (profile, notificationPreferences) yhtenä rivinä', () => {
  const report = dryRunDeletion({ profile: { name: 'Testi' }, notificationPreferences: { enabled: true } });
  assert.equal(report.collections.find(c => c.name === 'profile').count, 1);
  assert.equal(report.collections.find(c => c.name === 'notificationPreferences').count, 1);
});

test('dryRunDeletion laskee kokonaismäärän oikein', () => {
  const report = dryRunDeletion({
    tasks: [{ id: '1' }, { id: '2' }, { id: '3' }],
    goals: [{ id: 'g' }],
    profile: { name: 'X' }
  });
  assert.equal(report.totalRows, 5);
});

test('dryRunDeletion ei koskaan poista mitään -- se on puhdas laskenta', () => {
  const input = { tasks: [{ id: '1' }] };
  const before = JSON.stringify(input);
  dryRunDeletion(input);
  assert.equal(JSON.stringify(input), before, 'kuiva-ajo muutti syötettä');
});

test('tyhjä syöte tuottaa nollarivisen raportin, ei virhettä', () => {
  const report = dryRunDeletion();
  assert.equal(report.totalRows, 0);
  assert.equal(report.collections.length, ACCOUNT_OWNED_COLLECTIONS.length);
});

test('KRIITTINEN: tallennustiedostokategoriat ovat tyhjä totuudenmukainen lista', () => {
  // Ei "TODO"-listaa eikä arvausta -- kuittia ei tallenneta minnekään
  // (ks. docs/SECURITY.md "Kuitin kuva"), eikä muuta tiedostotallennusta
  // ole toteutettu.
  assert.deepEqual(STORED_FILE_CATEGORIES, []);
  const report = dryRunDeletion({});
  assert.deepEqual(report.storedFileCategories, []);
});

test('KRIITTINEN: auth-tilin poisto on rehellisesti "ei mahdollinen" ilman backendiä', () => {
  assert.equal(authAccountDeletable(), false);
  assert.match(authAccountBlockedReason(), /palvelinpuolen/i);

  const report = dryRunDeletion({});
  assert.equal(report.authDeletable, false);
  assert.equal(report.blockers.length, 1);
  assert.equal(report.blockers[0], authAccountBlockedReason());
});
