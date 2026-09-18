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

const profileSource = readCode('src/app/views/profile.js');

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
