// Julkaisujärjestys: välimuistiversion monotonisuus ja dokumentin totuus.
//
// =====================================================================
// MIKSI TÄMÄ TIEDOSTO ON OLEMASSA
// =====================================================================
//
// `CACHE_VERSION` on ainoa asia, joka saa selaimen hakemaan
// sovelluskuoren uudelleen. Jos se laskee, selain voi jäädä vanhaan
// kuoreen PYSYVÄSTI — eikä se näy virheenä missään: sovellus toimii,
// se on vain väärä versio.
//
// Se on ainoa tämän junan virhe, jota ei voi korjata jälkikäteen
// deployaamalla uudelleen.
//
// =====================================================================
// MITÄ TÄMÄ EI VOI TARKISTAA
// =====================================================================
//
// Testi lukee TÄTÄ PUUTA. Se ei lue `origin/main`ia eikä ota verkkoa,
// joten se ei voi tietää mikä tuotannossa oikeasti on.
//
// Juuri se on `docs/RELEASE-SEQUENCING.md`:n aihe: kolme yhtäpitävää
// mutta vanhentunutta lähdettä on johdonmukainen ja silti väärin. Tämä
// testi vartioi sitä, mitä se voi vartioida — ja dokumentti kertoo
// lopun.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { read } from './helpers/sources.mjs';
import {
  WAVES, BASE, PRODUCTION, WAVE_IDS, cacheVersionOf, rollbackTargetOf,
  waveIndex, blockedWaves
} from '../tools/release/waves.mjs';

const DOC = 'docs/RELEASE-SEQUENCING.md';

/** Versionumero lukuna. 'v15' -> 15. */
function versionNumber(value) {
  const match = /^v(\d+)$/.exec(String(value));
  assert.ok(match, `kelvoton välimuistiversio: ${value}`);
  return Number(match[1]);
}

// =====================================================================
// MONOTONISUUS
// =====================================================================

test('KRIITTINEN: välimuistiversio kasvaa aallosta aaltoon', () => {
  // Yhtä suuri ei riitä: kaksi aaltoa samalla numerolla tarkoittaisi,
  // ettei jälkimmäinen koskaan päivitä selaimen kuorta.
  let previous = versionNumber(BASE.cacheVersion);

  for (const wave of WAVES) {
    const current = versionNumber(wave.cacheVersion);
    assert.ok(current > previous,
      `aalto ${wave.id} on ${wave.cacheVersion}, edellinen oli v${previous}`);
    previous = current;
  }
});

test('KRIITTINEN: yksikään aalto ei alita tuotannon versiota', () => {
  // Tuotannon numero on se, jonka selain on jo nähnyt.
  const tuotanto = versionNumber(PRODUCTION.cacheVersion);

  for (const wave of WAVES) {
    assert.ok(versionNumber(wave.cacheVersion) > tuotanto,
      `aalto ${wave.id} (${wave.cacheVersion}) ei ylitä tuotantoa `
      + `(${PRODUCTION.cacheVersion})`);
  }
});

test('KRIITTINEN: perustila ylittää tuotannon version', () => {
  assert.ok(versionNumber(BASE.cacheVersion) > versionNumber(PRODUCTION.cacheVersion),
    `perustila on ${BASE.cacheVersion}, tuotanto ${PRODUCTION.cacheVersion}`);
});

test('versionumerot ovat peräkkäisiä eivätkä jätä aukkoja', () => {
  // Aukko ei riko mitään, mutta se on merkki siitä että jokin on
  // poistettu tai unohdettu. Se on syytä huomata.
  const kaikki = [BASE, ...WAVES].map(w => versionNumber(w.cacheVersion));

  for (let i = 1; i < kaikki.length; i += 1) {
    assert.equal(kaikki[i], kaikki[i - 1] + 1,
      `versionumeroissa on aukko: v${kaikki[i - 1]} -> v${kaikki[i]}`);
  }
});

test('jokainen aalto perutaan EDELLISEEN, ei perustilaan', () => {
  // Peruutus saa sulkea vain ne portit, joiden avaaminen epäonnistui —
  // ei sellaisia, jotka on jo todennettu toimiviksi.
  for (const wave of WAVES) {
    const kohde = rollbackTargetOf(wave.id);
    const odotettu = waveIndex(wave.id) === 0
      ? 'BASE' : WAVES[waveIndex(wave.id) - 1].id;
    assert.equal(kohde, odotettu,
      `aalto ${wave.id} perutaan kohteeseen ${kohde}, odotettiin ${odotettu}`);
  }
});

// =====================================================================
// DOKUMENTTI VASTAA TODELLISUUTTA
// =====================================================================

test('KRIITTINEN: järjestysdokumentti on olemassa', () => {
  const doc = read(DOC);
  assert.ok(doc.length > 2000, 'dokumentti on liian lyhyt ollakseen hyödyllinen');
});

test('dokumentti luettelee jokaisen aallon ja sen version', () => {
  const doc = read(DOC);

  for (const id of WAVE_IDS) {
    const versio = cacheVersionOf(id);
    assert.ok(doc.includes('`' + versio + '`'),
      `dokumentti ei mainitse versiota ${versio} (aalto ${id})`);
  }

  assert.ok(doc.includes('`' + BASE.cacheVersion + '`'),
    'dokumentti ei mainitse perustilan versiota');
});

test('dokumentti kertoo tämän haaran todellisen välimuistiversion', () => {
  // Dokumentti, joka kertoo väärän numeron, on vaarallisempi kuin
  // dokumentti jota ei ole: väärää ohjetta noudatetaan.
  const match = /const CACHE_VERSION = '(v\d+)'/.exec(read('sw.js'));
  assert.ok(match, 'CACHE_VERSION-vakiota ei löytynyt sw.js:stä');

  const doc = read(DOC);
  assert.ok(doc.includes('`' + match[1] + '`'),
    `dokumentti ei mainitse haaran omaa versiota ${match[1]}`);
});

test('dokumentti nimeää jokaisen estetyn aallon esteen', () => {
  const doc = read(DOC);

  for (const { id, blockedBy } of blockedWaves()) {
    assert.ok(doc.includes(`estetty (migraatio`) || doc.includes(blockedBy),
      `dokumentti ei kerro aallon ${id} estettä`);

    // Migraation numero on mainittava, jotta este on tunnistettavissa.
    const numero = /0(\d{3})_/.exec(blockedBy);
    assert.ok(numero, `esteestä ei voi lukea migraation numeroa: ${blockedBy}`);
    assert.ok(doc.includes(numero[1]) || doc.includes('0' + numero[1]),
      `dokumentti ei mainitse migraatiota ${numero[0]}`);
  }
});

test('KRIITTINEN: dokumentti kieltää version laskemisen nimenomaisesti', () => {
  const doc = read(DOC);
  assert.match(doc, /ei koskaan saa laske/i,
    'dokumentti ei kiellä version laskemista');
  assert.match(doc, /ÄLÄ laske välimuistiversiota/,
    'dokumentissa ei ole nimenomaista kieltoa');
});

test('dokumentti kieltää deployn pelkän numeroinnin takia', () => {
  const doc = read(DOC);
  assert.match(doc, /ÄLÄ deployaa pelkästään numeroinnin/,
    'dokumentti ei kiellä numerointideployta');
});

test('dokumentti nimeää päätöksentekijän eikä jätä päätöstä auki', () => {
  // Dokumentti, joka luettelee vaihtoehdot mutta ei kerro kenen päätös
  // on kyseessä, jää ikuisesti odottamaan.
  const doc = read(DOC);
  assert.match(doc, /Panun päätös/,
    'dokumentti ei nimeä päätöksentekijää');
});

test('dokumentti luettelee ne tiedostot, jotka päätös muuttaa', () => {
  const doc = read(DOC);

  for (const tiedosto of ['tools/release/waves.mjs', 'sw.js',
    'docs/PRODUCTION-STATUS.md', 'docs/RELEASE-TRAIN-0003-0008.md',
    'docs/activation-0003-0008-release-manifest.json']) {
    assert.ok(doc.includes(tiedosto),
      `dokumentti ei mainitse tiedostoa ${tiedosto}`);
  }
});

// =====================================================================
// HYVÄKSYNTÄPAKETIT OVAT YHTÄPITÄVIÄ
// =====================================================================

test('KRIITTINEN: jokainen paketti nostaa versiota myös peruutuksessa', () => {
  // Sama sääntö kuin release-waves.test.mjs:ssä, mutta tässä se
  // kirjoitetaan auki numeroina: peruutus on deploy, ja deploy nostaa
  // aina.
  for (const wave of WAVES) {
    const paketti = read(`docs/acceptance/WAVE-${wave.id}.md`);
    const nykyinen = versionNumber(wave.cacheVersion);

    assert.ok(paketti.includes(`v${nykyinen} -> v${nykyinen + 1}`),
      `WAVE-${wave.id}.md ei nosta versiota peruutuksessa`);

    // EIKÄ YKSIKÄÄN SIIRTYMÄ PAKETISSA SAA LASKEA.
    //
    // Poimitaan kaikki `vN -> vM` -parit ja tarkistetaan jokainen.
    // Pelkkä osamerkkijonohaku ei riitä: "v14 -> v15" sisältää
    // merkkijonon "v14 -> v1", ja naiivi tarkistus antaisi väärän
    // hälytyksen juuri oikeasta ohjeesta.
    for (const [, mista, mihin] of paketti.matchAll(/v(\d+) -> v(\d+)/g)) {
      assert.ok(Number(mihin) > Number(mista),
        `WAVE-${wave.id}.md ohjaa siirtymään v${mista} -> v${mihin}`);
    }
  }
});

test('estetty aalto ei ole deployattavissa', () => {
  for (const { id } of blockedWaves()) {
    const wave = WAVES.find(w => w.id === id);
    assert.ok(wave.blockedBy, `aalto ${id} ei kerro estettään`);
    assert.ok(wave.blockedBy.includes('EI AJETTU'),
      `aallon ${id} este ei nimeä ajamatonta migraatiota`);
  }
});

// =====================================================================
// PERUUTUS PYSÄYTTÄÄ JUNAN (ACT-10)
// =====================================================================

test('KRIITTINEN: peruutuksen nosto törmää seuraavan aallon versioon — ja dokumentti kieltää pushaamasta niitä yhdessä', () => {
  // Jokainen paketti ohjaa peruutuksessa vN -> vN+1. Kaikille aalloille
  // J:tä lukuun ottamatta vN+1 on SEURAAVAN aallon varaama numero. Se ei
  // ole virhe paketissa (versio ei saa laskea), mutta se tarkoittaa, että
  // peruutuksen jälkeen muuttamatonta myöhempää ehdokasta EI SAA pushata.
  for (const wave of WAVES.slice(0, -1)) {
    const bump = versionNumber(wave.cacheVersion) + 1;
    const next = WAVES[waveIndex(wave.id) + 1];
    assert.equal(versionNumber(next.cacheVersion), bump,
      `${wave.id}: peruutuksen v${bump} ei törmää — päivitä tämä testi ja dokumentti`);
  }
  const doc = read(DOC);
  assert.match(doc, /Peruutusversiota EI SAA pushata yhdessä muuttamattoman myöhemmän\s+ehdokkaan kanssa/);
  assert.match(doc, /TRAIN_HALTED_RECUT_REQUIRED/);
  assert.match(doc, /--rollback-of=D/);
});

test('KRIITTINEN: "tuotannon nykytila" nimeää vain LINEAGE-CHECK-rivin aallon', () => {
  const doc = read(DOC);
  const match = /LINEAGE-CHECK: origin\/main sha=([0-9a-f]{40}) cache=(v\d+)/.exec(doc);
  assert.ok(match, 'LINEAGE-CHECK-rivi puuttuu');
  const documentedWave = WAVES.find(w => w.cacheVersion === match[2]);
  assert.ok(documentedWave, `LINEAGE-CHECK-välimuisti ${match[2]} ei ole minkään aallon`);
  const lines = doc.split(/\r?\n/).filter(l => /tuotannon nykytila/i.test(l));
  assert.ok(lines.length >= 1);
  for (const line of lines) {
    const named = [...line.matchAll(/(?:^\|\s*([A-J])\s*\||\bAalto ([A-J])\b|\b([A-J])\s+v\d+)/g)]
      .map(m => m[1] || m[2] || m[3]);
    for (const wave of named) {
      assert.equal(wave, documentedWave.id, `"${line.trim()}" nimeää tuotannoksi aallon ${wave}, LINEAGE-CHECK sanoo ${documentedWave.id}`);
    }
  }
});

test('dokumentti ohjaa lukkoon ja orkestroijaan eikä pidä vanhaa harjoittelua nykyisenä', () => {
  const doc = read(DOC);
  assert.match(doc, /## Lukko ja orkestroija/);
  assert.match(doc, /Push-kohde on AINA lukon `deployTarget`/);
  assert.match(doc, /## Harjoittelu \(rehearsal\) — HISTORIALLINEN/);
  assert.equal(/Aalto B\s+v15\s+\(tuotannon nykytila/.test(doc), false);
});

test('aalto L on junan viimeisenä, heti aallon K jälkeen, K heti J:n ja J heti I:n jälkeen', () => {
  // L:n migraatio (0015) edellyttää 0014:n (verify_0014 = 0) ja muuttaa
  // tasks-taulua: se ei saa olla minkään toisen edellä.
  assert.equal(WAVE_IDS[WAVE_IDS.length - 1], 'L');
  assert.equal(WAVE_IDS[WAVE_IDS.length - 2], 'K');
});

test('aalto K on heti aallon J jälkeen, ja J heti I:n jälkeen', () => {
  // J:n migraatio (0013) riippuu 0012:sta (aalto I), ja K:n migraatio
  // (0014) edellyttää 0013:n (verify_0013 = 0). Aalto, jonka kanta
  // puuttuu, ei saa olla minkään toisen edellä.
  assert.equal(WAVE_IDS[WAVE_IDS.length - 2], 'K');
  assert.equal(WAVE_IDS[WAVE_IDS.length - 3], 'J');
  assert.equal(WAVE_IDS[WAVE_IDS.length - 4], 'I');
});
