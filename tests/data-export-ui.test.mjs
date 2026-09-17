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

test('KRIITTINEN: jokainen vientikokoelma kootaan käyttöliittymästä', () => {
  for (const name of EXPORTED_COLLECTIONS) {
    assert.match(
      profileSource,
      new RegExp(`\\b${name}\\s*:\\s*state\\.${name}\\b`),
      `collectExportData ei kokoa kokoelmaa "${name}"`
    );
  }
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
