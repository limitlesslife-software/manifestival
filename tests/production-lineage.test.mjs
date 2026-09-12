// Tämän haaran väitteet vs. origin/mainin todellinen tila -- paikallisesti.
//
// =====================================================================
// MIKSI TÄMÄ TIEDOSTO ON OLEMASSA
// =====================================================================
//
// `tests/release-sequencing.test.mjs` ja `tests/migrations.test.mjs`
// vartioivat kolmen lähteen (schema.js, sw.js, PRODUCTION-STATUS.md)
// KESKINÄISTÄ yhtäpitävyyttä TÄSSÄ PUUSSA. Ne eivät voi huomata sitä,
// että kaikki kolme voivat olla keskenään johdonmukaisia ja silti
// VANHENTUNEITA verrattuna siihen, mitä `origin/main` on juuri nyt --
// juuri niin kuin `docs/RELEASE-SEQUENCING.md` dokumentoi.
//
// Esimerkki, joka on tässä repossa TODELLINEN eikä hypoteettinen: tämä
// haara erkani junasta ennen aaltoja A ja B. Sen PRODUCTION-STATUS.md
// väitti pitkään olevansa ehdoitta auktoritatiivinen samalla kun
// origin/main oli edennyt kaksi aaltoa sen ohi. Kolme yhtäpitävää
// lähdettä oli silti väärässä.
//
// Tämä tiedosto sulkee juuri sen aukon -- paikallisesti, ilman verkkoa.
// `tools/release/lineage.mjs` lukee `origin/main`in paikallisesta
// git-objektikannasta (`git show origin/main:...`), ei ota yhteyttä
// mihinkään. Jos `origin/main` ei ole paikallisesti saatavilla (matala
// kloonaus, täysin verkoton ajo), testit ohitetaan eivätkä vaadi
// verkkoa toimiakseen -- ks. `originMainAvailable()`.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { read } from './helpers/sources.mjs';
import {
  cacheVersionLineageProblem, isDescendantOfOriginMain, originMainAvailable,
  originMainState, versionNumber
} from '../tools/release/lineage.mjs';
import { parseCacheVersion } from '../tools/release/state.mjs';

const STATUS_DOC = 'docs/PRODUCTION-STATUS.md';
const SEQUENCING_DOC = 'docs/RELEASE-SEQUENCING.md';

const available = originMainAvailable();

test('origin/main-tarkistus ei vaadi verkkoa: saatavuus on kyllä/ei-arvo, ei poikkeus', () => {
  // Tämä testi EI saa kaatua verkottomassa ympäristössä -- se vain
  // toteaa, kumpi tila on käsillä. `false` on kelvollinen vastaus.
  assert.equal(typeof available, 'boolean');
});

test('KRIITTINEN: haara joka ei ole origin/mainin jälkeläinen ei väitä itseään ehdoitta ajantasaiseksi', t => {
  if (!available) { t.skip('origin/main ei ole paikallisesti saatavilla'); return; }

  const descendant = isDescendantOfOriginMain();
  if (descendant !== false) { t.skip('tämä haara ON origin/mainin jälkeläinen -- ei sovellu'); return; }

  // Tämä on sama tilanne kuin PRODUCTION-STATUS.md:n historiassa oli:
  // haara erkani ennen kuin origin/main eteni. Dokumentin ON silloin
  // sanottava se ääneen sen sijaan että väittäisi olevansa ajantasainen
  // kuva origin/mainista.
  const doc = read(STATUS_DOC);
  assert.match(doc, /ei varmistetusti ajantasainen/i,
    `${STATUS_DOC} ei tunnusta, että tämä haara erkani ennen origin/mainin `
    + 'myöhempiä aaltoja -- se voisi siis väittää olevansa ajantasainen '
    + 'vaikka ei ole (juuri se regressio, jota tämä testi vartioi)');
  assert.match(doc, /RELEASE-SEQUENCING\.md/,
    `${STATUS_DOC} ei ohjaa lukijaa ajantasaisen tilan lähteelle`);
});

test('KRIITTINEN: tämä haara ei väitä origin/mainia korkeampaa välimuistiversiota ilman jälkeläisyyttä', t => {
  if (!available) { t.skip('origin/main ei ole paikallisesti saatavilla'); return; }

  const localCacheVersion = parseCacheVersion(read('sw.js'));
  assert.ok(localCacheVersion, 'sw.js:n CACHE_VERSION-vakiota ei löytynyt');

  const problem = cacheVersionLineageProblem(localCacheVersion);
  assert.equal(problem, null, problem || '');
});

test('KRIITTINEN: RELEASE-SEQUENCING.md:n merkitsemä origin/main-tila täsmää todelliseen', t => {
  if (!available) { t.skip('origin/main ei ole paikallisesti saatavilla'); return; }

  const doc = read(SEQUENCING_DOC);
  const match = /LINEAGE-CHECK: origin\/main sha=([0-9a-f]{40}) cache=(v\d+)/.exec(doc);
  assert.ok(match,
    `${SEQUENCING_DOC} ei sisällä koneellisesti luettavaa LINEAGE-CHECK-riviä`);

  const [, documentedSha, documentedCache] = match;
  const origin = originMainState();
  assert.ok(origin.available, 'origin/main ei ollut saatavilla vaikka originMainAvailable() sanoi kyllä');

  assert.equal(documentedSha, origin.sha,
    `${SEQUENCING_DOC} sanoo origin/mainin SHA:n olevan ${documentedSha}, `
    + `mutta origin/main on nyt ${origin.sha}. Dokumentti on vanhentunut -- `
    + 'päivitä LINEAGE-CHECK-rivi ja sitä ympäröivä kuvaus.');

  assert.equal(documentedCache, origin.cacheVersion,
    `${SEQUENCING_DOC} sanoo origin/mainin välimuistiversion olevan `
    + `${documentedCache}, mutta origin/main on nyt ${origin.cacheVersion}.`);
});

test('dokumentoitu origin/main-versio on kelvollinen versionumero', t => {
  if (!available) { t.skip('origin/main ei ole paikallisesti saatavilla'); return; }

  const origin = originMainState();
  assert.ok(origin.cacheVersion, 'origin/mainin sw.js:stä ei löytynyt CACHE_VERSION-vakiota');
  assert.notEqual(versionNumber(origin.cacheVersion), null,
    `origin/mainin välimuistiversio ${origin.cacheVersion} ei ole muotoa vNN`);
});
