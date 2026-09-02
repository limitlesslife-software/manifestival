// Istunnon elinkaaren invariantit.
//
// Tämä on alue, jolla on jo kerran vuotanut dataa käyttäjältä toiselle
// (WP7–WP12, muistivarasto säilyi uloskirjautumisen yli). Nämä testit
// varmistavat, ettei sama palaa mitään reittiä.
//
// Testataan KOLME asiaa:
//   1. tilasiirtymän päättely on oikein (puhdas funktio)
//   2. jokainen siirtymä johtaa oikeaan siivoukseen
//   3. käyttäjän A data ei ole näkyvissä käyttäjälle B

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { AUTH_TRANSITION, resolveAuthTransition } from '../src/app/auth.js';
import { setUser, clearUser, getUser, isAuthenticated, requireUserId, userEmail }
  from '../src/data/session.js';
import { clearLocalUserData, loadUserData } from '../src/app/actions.js';
import {
  routinesRepo, goalsRepo, projectsRepo, wellbeingRepo, ALL_REPOSITORIES
} from '../src/data/collectionsRepo.js';
import { loadPreferences, savePreferences } from '../src/data/notificationPrefsRepo.js';
import { resetState, getState, setTasks } from '../src/app/state.js';
import { read } from './helpers/sources.mjs';

const USER_A = { id: 'aaaaaaaa-0000-0000-0000-000000000001', email: 'a@example.com' };
const USER_B = { id: 'bbbbbbbb-0000-0000-0000-000000000002', email: 'b@example.com' };

beforeEach(() => {
  clearUser();
  clearLocalUserData();
  resetState();
});

// ------------------------------------------------------ tilasiirtymät

test('kirjautuminen tyhjästä on SIGNED_IN', () => {
  assert.equal(resolveAuthTransition(null, USER_A), AUTH_TRANSITION.SIGNED_IN);
});

test('sama käyttäjä uudella tokenilla on TOKEN_REFRESHED', () => {
  // Tokenin uusiutuminen tapahtuu taustalla tunnin välein. Jos se
  // tulkittaisiin uudeksi kirjautumiseksi, näkymä välkkyisi ja
  // keskeneräinen lomake nollautuisi kesken päivän.
  assert.equal(resolveAuthTransition(USER_A, { ...USER_A }),
    AUTH_TRANSITION.TOKEN_REFRESHED);
});

test('KRIITTINEN: eri käyttäjä ilman uloskirjautumista on USER_SWITCHED', () => {
  // Tämä on se reitti, jota vanha toteutus ei tunnistanut lainkaan: se
  // olisi kutsunut vain onSignedIn ja jättänyt A:n muistivarastot
  // paikoilleen.
  assert.equal(resolveAuthTransition(USER_A, USER_B), AUTH_TRANSITION.USER_SWITCHED);
});

test('istunnon päättyminen on SIGNED_OUT', () => {
  assert.equal(resolveAuthTransition(USER_A, null), AUTH_TRANSITION.SIGNED_OUT);
  assert.equal(resolveAuthTransition(USER_A, undefined), AUTH_TRANSITION.SIGNED_OUT);
});

test('kirjautumaton pysyy IDLEnä', () => {
  assert.equal(resolveAuthTransition(null, null), AUTH_TRANSITION.IDLE);
  assert.equal(resolveAuthTransition(undefined, undefined), AUTH_TRANSITION.IDLE);
});

test('tunnisteeton käyttäjä ei ole kirjautunut', () => {
  // Puutteellinen istunto ei saa näyttää kirjautumiselta.
  assert.equal(resolveAuthTransition(null, { email: 'x@example.com' }),
    AUTH_TRANSITION.IDLE);
  assert.equal(resolveAuthTransition({ email: 'a@example.com' }, USER_B),
    AUTH_TRANSITION.SIGNED_IN);
});

test('tunniste vertaillaan merkkijonona', () => {
  assert.equal(resolveAuthTransition({ id: 1 }, { id: '1' }),
    AUTH_TRANSITION.TOKEN_REFRESHED);
  assert.equal(resolveAuthTransition({ id: 1 }, { id: 2 }),
    AUTH_TRANSITION.USER_SWITCHED);
});

test('jokainen siirtymä on tunnettu arvo', () => {
  const seen = new Set([
    resolveAuthTransition(null, USER_A),
    resolveAuthTransition(USER_A, USER_A),
    resolveAuthTransition(USER_A, USER_B),
    resolveAuthTransition(USER_A, null),
    resolveAuthTransition(null, null)
  ]);
  for (const value of seen) {
    assert.ok(Object.values(AUTH_TRANSITION).includes(value), value);
  }
  assert.equal(seen.size, 5, 'jokainen siirtymä on erillinen');
});

// ------------------------------------------------------- istunnon tila

test('setUser hyväksyy vain tunnisteellisen käyttäjän', () => {
  setUser({ email: 'ei-tunnistetta@example.com' });
  assert.equal(isAuthenticated(), false);
  assert.equal(getUser(), null);

  setUser(USER_A);
  assert.equal(isAuthenticated(), true);
  assert.equal(userEmail(), USER_A.email);
});

test('requireUserId heittää ilman kirjautumista', () => {
  clearUser();
  assert.throws(() => requireUserId());

  setUser(USER_A);
  assert.equal(requireUserId(), USER_A.id);
});

test('uloskirjautuminen tyhjentää istunnon', () => {
  setUser(USER_A);
  clearUser();
  assert.equal(isAuthenticated(), false);
  assert.equal(userEmail(), '');
});

// ------------------------------------------- A -> logout -> B, ei vuotoa

/** Kirjoita jokaiseen muistivarastoon rivi, kuten käyttäjä tekisi. */
async function seedAs(label) {
  await routinesRepo.insert({
    id: 'r-' + label, title: label + ':n rutiini', active: true,
    recurrence: { type: 'daily', weekdays: [] }
  });
  await goalsRepo.insert({ id: 'g-' + label, title: label + ':n tavoite' });
  await projectsRepo.insert({ id: 'p-' + label, name: label + ':n projekti' });
  await wellbeingRepo.insert({ id: 'w-' + label, date: '2026-09-02', energy: 2 });
  await savePreferences({ enabled: true, maxPerDay: 5 });
}

/** Kaikki mitä seuraava käyttäjä näkisi. */
async function visibleRows() {
  const results = await Promise.all(ALL_REPOSITORIES.map(repo => repo.list()));
  return results.flatMap(result => (result.ok ? result.value : []));
}

test('KRIITTINEN: A -> uloskirjautuminen -> B ei näytä A:n dataa', async () => {
  // 1. A kirjautuu ja luo dataa
  setUser(USER_A);
  await seedAs('A');
  setTasks([{ id: 't-a', title: 'A:n tehtävä', date: '2026-09-02' }]);

  assert.ok((await visibleRows()).length > 0, 'lähtötilanne ei ole mielekäs');

  // 2. A kirjautuu ulos — sama polku kuin sovelluksessa
  clearUser();
  clearLocalUserData();
  resetState();

  // 3. B kirjautuu
  setUser(USER_B);

  const visible = await visibleRows();
  assert.deepEqual(visible, [],
    'B näkisi A:n tiedot:\n' + JSON.stringify(visible, null, 2));
  assert.deepEqual(getState().tasks, []);

  const preferences = await loadPreferences();
  assert.equal(preferences.value.enabled, false, 'B perisi A:n muistutusasetukset');
});

test('KRIITTINEN: tilinvaihto ilman uloskirjautumista ei vuoda dataa', async () => {
  // Sama tarkistus USER_SWITCHED-reitille, jota vanha toteutus ei
  // tunnistanut lainkaan.
  setUser(USER_A);
  await seedAs('A');
  assert.ok((await visibleRows()).length > 0);

  const transition = resolveAuthTransition(getUser(), USER_B);
  assert.equal(transition, AUTH_TRANSITION.USER_SWITCHED);

  // Sovellus kierrättää USER_SWITCHED-tapauksessa saman siivouspolun.
  clearUser();
  clearLocalUserData();
  resetState();
  setUser(USER_B);

  assert.deepEqual(await visibleRows(), []);
  assert.equal(requireUserId(), USER_B.id);
});

test('A:n tiedot eivät palaa toisella kirjautumiskierroksella', async () => {
  setUser(USER_A);
  await seedAs('A');
  clearUser();
  clearLocalUserData();

  setUser(USER_B);
  await seedAs('B');
  const asB = await visibleRows();
  assert.ok(asB.every(row => !JSON.stringify(row).includes('A:n')),
    'A:n rivejä näkyi B:lle');

  clearUser();
  clearLocalUserData();
  setUser(USER_A);
  assert.deepEqual(await visibleRows(), [], 'A:n oma data ei palaa muistista');
});

// ----------------------------------------------- kytkentä sovelluksessa

test('sovellus käsittelee jokaisen siirtymän nimenomaisesti', () => {
  const source = read('src/app/auth.js');
  for (const transition of Object.values(AUTH_TRANSITION)) {
    if (transition === AUTH_TRANSITION.IDLE) continue; // default-haara
    const constant = Object.entries(AUTH_TRANSITION)
      .find(([, value]) => value === transition)[0];
    assert.ok(source.includes(`AUTH_TRANSITION.${constant}`),
      'siirtymää ei käsitellä: ' + transition);
  }
});

test('KRIITTINEN: tilinvaihto kulkee uloskirjautumisen siivouspolun kautta', () => {
  // Toinen, erillinen siivousreitti unohtuisi seuraavassa muutoksessa.
  const source = read('src/app/auth.js');
  const start = source.indexOf('case AUTH_TRANSITION.USER_SWITCHED:');
  const block = source.slice(start, source.indexOf('break;', start));

  assert.ok(start > -1, 'USER_SWITCHED-haaraa ei ole');
  assert.ok(block.includes('onSignedOut()'),
    'tilinvaihto ei kutsu uloskirjautumisen siivousta');
  assert.ok(block.includes('onSignedIn('), 'tilinvaihto ei kirjaa uutta käyttäjää');
});

test('tokenin uusiutuminen ei lataa dataa uudelleen', () => {
  const source = read('src/app/auth.js');
  const start = source.indexOf('case AUTH_TRANSITION.TOKEN_REFRESHED:');
  const block = source.slice(start, source.indexOf('break;', start));

  assert.ok(start > -1);
  assert.equal(block.includes('onSignedIn('), false,
    'tokenin uusiutuminen laukaisisi datan uudelleenlatauksen');
  assert.ok(block.includes('setUser('), 'käyttäjä pitää silti päivittää');
});

// ------------------------------------ FREEZE: puuttuneet elinkaaritakuut

test('KRIITTINEN: uloskirjautuminen kesken latauksen hylkää vastauksen', async () => {
  // Lataus on kaksitoista rinnakkaista verkkokutsua, ja käyttäjä ehtii
  // kirjautua ulos niiden aikana. Ilman tarkistusta vastaus kirjoittaisi
  // edellisen käyttäjän rivit tilaan uloskirjautumisen JÄLKEEN.
  //
  // Tämä on KOLMAS saman luokan vuotoreitti tässä koodikannassa
  // (uloskirjautuminen, tilinvaihto, nyt vanhentunut vastaus).
  setUser(USER_A);
  await seedAs('A');

  // Simuloi uloskirjautuminen kesken latauksen: repositorion listaus
  // tyhjentää istunnon juuri ennen kuin vastaukset palautuvat.
  const original = routinesRepo.list.bind(routinesRepo);
  routinesRepo.list = async () => {
    clearUser();
    return original();
  };

  try {
    const result = await loadUserData();

    assert.equal(result.discarded, true, 'vanhentunutta vastausta ei hylätty');
    assert.deepEqual(getState().routines, [],
      'edellisen käyttäjän rivit kirjoitettiin tilaan uloskirjautumisen jälkeen');
    assert.deepEqual(getState().goals, []);
  } finally {
    routinesRepo.list = original;
  }
});

test('KRIITTINEN: tilinvaihto kesken latauksen hylkää edellisen vastauksen', async () => {
  // Pahin muunnelma: A:n lataus palaa vasta kun B on jo kirjautunut.
  setUser(USER_A);
  await seedAs('A');

  const original = routinesRepo.list.bind(routinesRepo);
  routinesRepo.list = async () => {
    setUser(USER_B);
    return original();
  };

  try {
    const result = await loadUserData();

    assert.equal(result.discarded, true);
    assert.deepEqual(getState().routines, [], 'B:n näytölle kirjoitettiin A:n rivit');
    assert.equal(requireUserId(), USER_B.id);
  } finally {
    routinesRepo.list = original;
  }
});

test('normaali lataus ei hylkää vastausta', async () => {
  // Vartija ei saa estää tavallista käyttöä.
  setUser(USER_A);
  await seedAs('A');

  const result = await loadUserData();

  assert.equal(result.discarded, false);
  assert.equal(getState().routines.length, 1, 'A näkee omat rivinsä');
  assert.equal(getState().goals.length, 1);
});

test('istunnon vanheneminen kulkee saman siivouspolun kautta kuin uloskirjautuminen', () => {
  // Supabase ilmoittaa vanhentuneesta istunnosta samalla tavalla kuin
  // uloskirjautumisesta: session on null. Erillistä haaraa ei tarvita
  // eikä pidä olla — kaksi polkua samaan lopputulokseen erkanisi.
  assert.equal(resolveAuthTransition(USER_A, null), AUTH_TRANSITION.SIGNED_OUT);

  const source = read('src/app/auth.js');
  const start = source.indexOf('case AUTH_TRANSITION.SIGNED_OUT:');
  const block = source.slice(start, source.indexOf('break;', start));
  assert.ok(block.includes('onSignedOut()'), 'vanheneminen ei siivoa');
});

test('epäonnistunut kirjautuminen ei jätä edellistä istuntoa voimaan', () => {
  // Väärä salasana ei tuota istuntoa, joten siirtymä on IDLE eikä
  // SIGNED_IN. Aiempi käyttäjä on jo tyhjennetty uloskirjautuessa.
  clearUser();
  assert.equal(resolveAuthTransition(null, null), AUTH_TRANSITION.IDLE);
  assert.equal(isAuthenticated(), false);
  assert.throws(() => requireUserId());
});

test('selaimen uudelleenlataus ei säilytä käyttäjädataa muistivarastossa', async () => {
  // Muistivarasto elää moduulin mukana. Uudelleenlataus luo uuden
  // JS-kontekstin, joten varasto on määritelmällisesti tyhjä. Tämä
  // testi lukitsee sen, ettei mitään ole vahingossa siirretty
  // localStorageen, joka säilyisi latauksen yli.
  setUser(USER_A);
  await seedAs('A');

  const persistent = read('src/data/collectionsRepo.js') + read('src/data/memoryStore.js');
  for (const api of ['localStorage', 'sessionStorage', 'indexedDB']) {
    assert.equal(persistent.includes(api), false,
      `muistivarasto käyttää ${api}:a — data säilyisi uudelleenlatauksen yli`);
  }
});

test('laitekohtaiset asetukset eivät sisällä käyttäjän sisältöä', () => {
  // localStorage säilyy uudelleenlatauksen JA uloskirjautumisen yli, jos
  // sitä ei erikseen tyhjennetä. Siksi siellä ei saa olla mitään, mikä
  // paljastaisi edellisen käyttäjän tietoja.
  const source = read('src/data/preferences.js');
  for (const forbidden of ['task', 'goal', 'routine', 'bill', 'wellbeing', 'note', 'title']) {
    assert.equal(new RegExp(`['"\`][^'"\`]*${forbidden}`, 'i').test(source), false,
      `laiteasetuksissa viitataan käyttäjän sisältöön: ${forbidden}`);
  }
  assert.ok(read('src/app/main.js').includes('clearDevicePreferences()'),
    'laiteasetuksia ei tyhjennetä uloskirjautuessa');
});
