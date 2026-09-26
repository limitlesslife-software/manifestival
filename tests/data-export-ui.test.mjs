// Data-viennin tavoitettavuus käyttöliittymästä.
//
// src/domain/dataExport.js oli aiemmin täysin tavoittamaton: puhdas,
// testattu moduuli, jota mikään näkymä ei kutsunut. Käyttäjä ei voinut
// oikeasti viedä omaa dataansa, vaikka koko toteutus oli valmis.
//
// Nämä testit lukitsevat KOLME asiaa lähdekoodista:
//   1. Profiilinäkymä kutsuu oikeasti buildUserDataExport/serializeExport.
//   2. Jokainen EXPORTED_COLLECTIONS-nimi kootaan viennin dataan --
//      uusi kokoelma ei voi pudota pois vahingossa.
//   3. Painike, jonka käyttäjä näkee, on olemassa ja kytketty.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readCode } from './helpers/sources.mjs';
import { EXPORTED_COLLECTIONS } from '../src/domain/dataExport.js';
import { authAccountDeletable } from '../src/domain/accountLifecycle.js';
import { saveProfile } from '../src/app/actions.js';
import { getState, resetState, setProfile } from '../src/app/state.js';
import { setUser, clearUser } from '../src/data/session.js';
import { setClient } from '../src/data/client.js';

const profileSource = readCode('src/app/views/profile.js');
const indexHtml = readCode('index.html');
const deletionSource = readCode('src/app/accountDeletion.js');

test('KRIITTINEN: profiilinäkymä kutsuu vientifunktioita eikä vain tuo niitä', () => {
  assert.match(profileSource, /buildUserDataExport\(/);
  assert.match(profileSource, /serializeExport\(/);
});

test('KRIITTINEN: vientidata kootaan EXPORTED_COLLECTIONS-listasta, ei käsin kirjoitetusta kopiosta', () => {
  // Käsin kirjoitettu { routines: state.routines, goals: state.goals, ... }
  // ajautuisi EXPORTED_COLLECTIONS:sta eroon ensimmäisellä unohtuneella
  // lisäyksellä. collectExportData() lukee saman listan uudelleenviennillä,
  // joten tämä testi todistaa RAKENTEEN eikä yksittäisiä nimiä.
  assert.match(profileSource,
    /import\s*\{[^}]*EXPORTED_COLLECTIONS[^}]*\}\s*from\s*['"]\.\.\/\.\.\/domain\/dataExport\.js['"]/,
    'profile.js ei tuo EXPORTED_COLLECTIONS:ia dataExport.js:stä');

  const start = profileSource.indexOf('function collectExportData');
  assert.ok(start > -1, 'collectExportData puuttuu');
  const body = profileSource.slice(start, profileSource.indexOf('\n}', start));

  assert.match(body, /for\s*\(\s*const\s+name\s+of\s+EXPORTED_COLLECTIONS\s*\)/,
    'collectExportData ei iteroi EXPORTED_COLLECTIONS:ia — se voisi olla käsin kirjoitettu kopio');
  assert.match(body, /data\[name\]\s*=\s*state\[name\]/,
    'collectExportData ei indeksoi tilaa nimen perusteella');

  // Ja sama lista todella kattaa kaikki nykyiset kokoelmat -- ei tyhjä eikä
  // vaillinainen (tarkistettu erikseen account-lifecycle.test.mjs:ssä).
  assert.ok(EXPORTED_COLLECTIONS.length >= 15, 'EXPORTED_COLLECTIONS näyttää vaillinaiselta');
});

test('vienti ja poiston esikatselu ottavat profiilin vain, jos rivi on olemassa (profileExists)', () => {
  // Tilassa on aina oletusprofiili. Ilman tätä ehtoa vienti väitti
  // oletusarvoja käyttäjän tiedoiksi ja esikatselu laski "Profiili 1"
  // tilille, jolla profiilia ei ole.
  const start = profileSource.indexOf('function collectExportData');
  const body = profileSource.slice(start, profileSource.indexOf('\n}', start));
  assert.match(body, /state\.profileExists !== true\) data\.profile = null/);
});

/** Profiilitaulu, jonka upsert vastaa annetulla virheellä (null = onnistuu). */
function profileClient(error) {
  const calls = [];
  return {
    calls,
    from: table => ({
      upsert: async row => { calls.push({ table, row }); return { data: null, error }; }
    })
  };
}

async function withSignedIn(client, fn) {
  resetState();
  setUser({ id: 'aaaaaaaa-0000-4000-8000-00000000000a', email: 'a@example.com' });
  setClient(client);
  try {
    await fn();
  } finally {
    setClient(null);
    clearUser();
    resetState();
  }
}

test('KRIITTINEN: epäonnistunut ensimmäinen profiilin tallennus ei jätä haamuprofiilia vientiin eikä esikatseluun', async () => {
  const client = profileClient({ message: 'Failed to fetch' });
  await withSignedIn(client, async () => {
    assert.equal(getState().profileExists, false, 'esiehto: uudella käyttäjällä ei ole profiiliriviä');
    const before = getState().profile;

    assert.equal(await saveProfile({ ...before, age: 41 }), false);

    assert.equal(client.calls.length, 1, 'esiehto: tallennusta yritettiin');
    assert.equal(getState().profileExists, false,
      'peruutus merkitsi profiilin olemassa olevaksi: vienti ja poiston esikatselu laskisivat haamuprofiilin');
    assert.deepEqual(getState().profile, before, 'peruutus palauttaa aiemmat arvot');
  });
});

test('epäonnistunut tallennus olemassa olevalle profiilille pitää sen olemassa olevana', async () => {
  await withSignedIn(profileClient({ message: 'Failed to fetch' }), async () => {
    setProfile({ age: 30 }, true);
    assert.equal(await saveProfile({ ...getState().profile, age: 31 }), false);
    assert.equal(getState().profileExists, true);
    assert.equal(getState().profile.age, 30);
  });
});

test('onnistunut ensimmäinen tallennus merkitsee profiilin olemassa olevaksi', async () => {
  await withSignedIn(profileClient(null), async () => {
    assert.equal(await saveProfile({ ...getState().profile, age: 41 }), true);
    assert.equal(getState().profileExists, true);
    assert.equal(getState().profile.age, 41);
  });
});

test('KRIITTINEN: latauspainike on olemassa ja kytketty klikkaukseen', () => {
  assert.match(profileSource, /id="pfExportBtn"/);
  assert.match(profileSource, /pfExportBtn['"]\)/);
  assert.match(profileSource, /addEventListener\('click',\s*runExport\)/);
});

test('vienti ei koskaan lähetä käyttäjätunnistetta eikä tokenia painikkeen kautta', () => {
  // Tämä on jo lukittu domain-tasolla (domain-export.test.mjs), mutta
  // varmistetaan ettei käyttöliittymä ohita redact()-suodatusta lisäämällä
  // oman raa'an kentän mukaan.
  assert.doesNotMatch(profileSource, /userEmail\(\)[^)]*data\.push|token[\s\S]{0,20}collectExportData/i);
});

// ================================================== tilin poiston UX
//
// docs/ACCOUNT-DELETION.md: "Sovellus EI SAA luoda fake-successia."
// Nämä testit lukitsevat, että käyttöliittymä noudattaa sitä kirjaimellisesti:
// poistopainike on olemassa mutta pois päältä kunnes backend on valmis,
// syy näytetään suoraan, ja kuiva-ajo ei koskaan kirjoita mihinkään.

test('KRIITTINEN: DOM-koukku tilin poistolle on olemassa index.html:ssä', () => {
  assert.match(indexHtml, /id="pfAccountDeletion"/);
});

test('KRIITTINEN: poistoon johtava painike on pois päältä niin kauan kuin poisto ei ole käytössä', () => {
  // Poiston käyttöliittymä on src/app/accountDeletion.js:ssä (profiili
  // vain delegoi). Lippu ACCOUNT_DELETION.endpointEnabled on false kunnes
  // Edge Function on oikeasti deployattu -- silloin "Jatka poistoon" on
  // disabled, syy näytetään, eikä mitään verkkokutsua tehdä.
  assert.equal(authAccountDeletable(), false);
  assert.match(deletionSource, /id="pfDeletionContinueBtn"[\s\S]{0,120}\$\{enabled \? '' : 'disabled aria-disabled="true"'\}/,
    'jatka-poistoon-painike ei ole ehdollisesti pois päältä palvelinpoiston mukaan');
  assert.match(deletionSource, /authAccountBlockedReason\(\)/, 'estosyytä ei näytetä käyttäjälle');
  assert.match(profileSource, /renderAccountDeletionSection\(/, 'profiili ei delegoi poistoa');
});

test('poiston esikatselu käyttää dryRunDeletion():ia samasta datasta kuin vienti', () => {
  assert.match(deletionSource, /import\s*\{[^}]*dryRunDeletion[^}]*\}\s*from\s*['"]\.\.\/domain\/accountLifecycle\.js['"]/);
  assert.match(deletionSource, /dryRunDeletion\(readData\(\)/,
    'esikatselu ei käytä annettua dataa');
  assert.match(profileSource, /\(\) => collectExportData\(getState\(\)\)/,
    'esikatselun data ei tule samasta kokoajasta kuin vienti — kaksi eri totuutta samasta tilasta');
});

test('poiston esikatselupainike on kytketty, ja poisto kulkee vain tilakoneen kautta', () => {
  assert.match(deletionSource, /on\('pfDeletionPreviewBtn',\s*openPreview\)/);
  // Varsinainen poistokutsu ei saa olla kytketty suoraan mihinkään
  // painikkeeseen ohi vahvistusvirran: vain submitDeletion() kutsuu sitä.
  const calls = deletionSource.match(/executeAccountDeletion\(\{/g) || [];
  assert.equal(calls.length, 1, 'executeAccountDeletion() saa olla yhdessä paikassa');
  assert.doesNotMatch(deletionSource, /on\('pfDeletionContinueBtn',\s*executeAccountDeletion/);
});
