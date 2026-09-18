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

const profileSource = readCode('src/app/views/profile.js');
const indexHtml = readCode('index.html');

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

test('KRIITTINEN: poistopainike on pois päältä niin kauan kuin authAccountDeletable() on false', () => {
  // Tämä testi KAATUU sinä päivänä kun backend valmistuu ja
  // authAccountDeletable() muuttuu todeksi -- se on tarkoituksellista:
  // silloin joku tarkistaa käsin, että painikkeen disabled-ehto ja
  // vahvistuspolku päivitetään samassa yhteydessä, ei jää unohtumaan.
  assert.equal(authAccountDeletable(), false,
    'authAccountDeletable() on true -- päivitä pfDeletionBtn-ehto ja tämä testi tietoisesti');

  const start = profileSource.indexOf('function renderAccountDeletion');
  const body = profileSource.slice(start, profileSource.indexOf('\n}', start));
  assert.match(body, /id="pfDeletionBtn"/);
  assert.match(body, /deletable\s*\?\s*''\s*:\s*'disabled/,
    'poistopainike ei ole ehdollisesti pois päältä authAccountDeletable():n mukaan');
  assert.match(body, /authAccountBlockedReason\(\)/,
    'estosyytä ei näytetä käyttäjälle');
});

test('poiston esikatselu käyttää dryRunDeletion():ia, ei omaa laskentaansa', () => {
  assert.match(profileSource, /import\s*\{[^}]*dryRunDeletion[^}]*\}\s*from\s*['"]\.\.\/\.\.\/domain\/accountLifecycle\.js['"]/);
  const start = profileSource.indexOf('function showDeletionPreview');
  const body = profileSource.slice(start, profileSource.indexOf('\n}', start));
  assert.match(body, /dryRunDeletion\(collectExportData\(getState\(\)\)\)/,
    'esikatselu ei käytä samaa dataa kuin vienti — kaksi eri totuutta samasta tilasta');
});

test('poiston esikatselupainike on kytketty, varsinainen poistopainike ei kutsu mitään', () => {
  const start = profileSource.indexOf('function renderAccountDeletion');
  const body = profileSource.slice(start, profileSource.indexOf('\n}', start));
  assert.match(body, /pfDeletionPreviewBtn['"]\)/);
  assert.match(body, /addEventListener\('click',\s*showDeletionPreview\)/);
  // pfDeletionBtn ei saa olla kytketty mihinkään toimintoon niin kauan
  // kuin se on pois päältä -- muuten se olisi napattavissa DOM:ista käsin.
  assert.doesNotMatch(body, /pfDeletionBtn['"]\)\.addEventListener/);
});
