// Android-hyväksyntäkoonnin versiointi: versionCode ja versionName.
//
// MIKSI TÄMÄ ON OLEMASSA
//
// android/app/build.gradle kovakoodasi pitkään versionCode 1 /
// versionName "1.0". Jokainen APK — tuotehaaran kokeilu, aallon J
// hyväksyntäpaketti, vanha kopio build-hakemistossa — näytti puhelimen
// asetuksissa samalta, eikä niitä voinut erottaa toisistaan.
//
// Tämä moduuli laskee versiotiedot PUHTAASTI (ei gitiä, ei tiedostoja):
// kutsuja antaa commitin ajan, SHA:n, schema.js:n, sw.js:n ja
// package.jsonin version. Samat syötteet antavat aina saman tuloksen,
// joten koonti on toistettavissa ja funktio on testattavissa ilman
// Android-työkaluja.
//
// KAKSI ERI PÄÄTÖSTÄ
//
// 1. versionName on näyttöteksti. Sen muuttaminen on turvallista NYT:
//    `<package.json version>-wave<X>.<välimuisti>+<sha7>`, ja debug-
//    koonti lisää Gradlessa päätteen `-debug`. Esim. aallon J vanha kärki:
//    `1.0.0-waveJ.v23+5df40b2-debug`.
//
// 2. versionCode > 1 puhelimeen on OMISTAJAN TUOTEPÄÄTÖS (OWNER PRODUCT
//    DECISION). Se on yksisuuntainen ovi: kun laitteessa on versionCode
//    23 069 141, sitä vanhempaa APK:ta ei voi asentaa päälle ilman
//    sovelluksen poistoa. Siksi oletus on yhä 1 ('fixed-1'), ja
//    suositeltu käytäntö ('commit-epoch') otetaan käyttöön vain
//    nimenomaisella valinnalla (--version-code=commit-epoch).
//    Ks. docs/activation/ANDROID-ACCEPTANCE-BUILD.md, "Versiointi".
//
// SUOSITELTU versionCode: commitin committer-aika sekunteina
// 2026-01-01T00:00:00Z:sta. Sama commit antaa aina saman koodin; jokainen
// uudempi commit (myös cherry-pick ja peruutuscommit) antaa suuremman;
// pienin arvo on reilusti yli 1, joten se korvaa minkä tahansa
// versionCode 1 -asennuksen; Google Playn yläraja 2 100 000 000 tulee
// vastaan vasta noin vuonna 2092. Commitien LUKUMÄÄRÄ ei kelpaa, koska se
// ei ole monotoninen haarojen välillä (uudelleenleikattu aalto voi saada
// pienemmän luvun kuin edellinen leikkaus).

import { parseCacheVersion, parseGates } from '../release/state.mjs';
import { WAVE_IDS, cacheVersionOf, describeMatrix, resolveWave } from '../release/waves.mjs';

/** 2026-01-01T00:00:00Z Unix-sekunteina. */
export const VERSION_CODE_EPOCH_SECONDS = 1767225600;

/** Google Playn versionCode-yläraja (Android itse sallii 2^31-1). */
export const VERSION_CODE_MAX = 2100000000;

/** Pienin sallittu versionCode (Android: positiivinen kokonaisluku). */
export const VERSION_CODE_MIN = 1;

/** Debug-koonnin versionNameSuffix android/app/build.gradle:ssa. */
export const DEBUG_VERSION_NAME_SUFFIX = '-debug';

/** Gradle-ominaisuudet, joilla versiot annetaan koonnille. */
export const GRADLE_VERSION_CODE_PROPERTY = 'manifestival.versionCode';
export const GRADLE_VERSION_NAME_PROPERTY = 'manifestival.versionName';

/** versionCode-käytännöt. Tunniste päätyy paketin metatietoihin. */
export const VERSION_POLICY = Object.freeze({
  /** Nykyinen käytös: aina 1. Oletus, kunnes omistaja päättää toisin. */
  FIXED: 'fixed-1',
  /** Suositus: committer-aika sekunteina 2026-01-01Z:sta. */
  COMMIT_EPOCH: 'commit-seconds-since-2026-01-01Z',
  /** Käsin annettu kokonaisluku (poikkeustilanteisiin). */
  EXPLICIT: 'explicit'
});

const SHA = /^[0-9a-f]{7,40}$/i;
const SEMVER = /^\d+\.\d+\.\d+$/;

/**
 * Komentoriviarvo `--version-code=<arvo>` käytännöksi.
 *
 *   (puuttuu) | '1'   -> fixed-1
 *   'commit-epoch'    -> commit-seconds-since-2026-01-01Z
 *   '<kokonaisluku>'  -> explicit (1..2100000000)
 *
 * @returns {{ policy: string, value: number|null }}
 */
export function parseVersionCodeOption(raw) {
  if (raw === undefined || raw === null || raw === '' || raw === 1 || raw === '1') {
    return Object.freeze({ policy: VERSION_POLICY.FIXED, value: 1 });
  }
  const text = String(raw).trim();
  if (text === 'commit-epoch' || text === VERSION_POLICY.COMMIT_EPOCH) {
    return Object.freeze({ policy: VERSION_POLICY.COMMIT_EPOCH, value: null });
  }
  if (/^\d{1,10}$/.test(text)) {
    const value = Number(text);
    assertVersionCodeRange(value);
    return Object.freeze({ policy: VERSION_POLICY.EXPLICIT, value });
  }
  throw new Error(
    `--version-code: tuntematon arvo '${text}' (sallitut: 1, commit-epoch, `
    + `kokonaisluku ${VERSION_CODE_MIN}..${VERSION_CODE_MAX})`);
}

function assertVersionCodeRange(code) {
  if (!Number.isInteger(code) || code < VERSION_CODE_MIN || code > VERSION_CODE_MAX) {
    throw new Error(
      `versionCode ${code} ei ole välillä ${VERSION_CODE_MIN}..${VERSION_CODE_MAX}`);
  }
}

/**
 * Suositeltu versionCode: committer-aika sekunteina 2026-01-01Z:sta.
 *
 * Kaatuu, jos commit on ennen 2026-01-01Z:aa, jos tulos on <= 1 (ei
 * erottuisi oletuksesta eikä korvaisi versionCode 1 -asennusta) tai jos
 * tulos ylittää Google Playn ylärajan.
 */
export function commitEpochVersionCode(committerEpoch) {
  if (!Number.isInteger(committerEpoch)) {
    throw new Error(`committer-aika ei ole kokonaisluku: ${committerEpoch}`);
  }
  if (committerEpoch < VERSION_CODE_EPOCH_SECONDS) {
    throw new Error(
      `commit on ennen 2026-01-01T00:00:00Z (committer-aika ${committerEpoch}); `
      + 'commit-epoch-käytäntö ei ole määritelty sitä vanhemmille commiteille');
  }
  const code = committerEpoch - VERSION_CODE_EPOCH_SECONDS;
  if (code <= 1) {
    throw new Error(
      `commit-epoch-versionCode ${code} <= 1: ei erottuisi oletuksesta 1`);
  }
  if (code > VERSION_CODE_MAX) {
    throw new Error(
      `commit-epoch-versionCode ${code} ylittää Google Playn ylärajan ${VERSION_CODE_MAX}`);
  }
  return code;
}

/**
 * Aallon tunniste schema.js:n porttimatriisista ja sw.js:n välimuistista.
 *
 * Käyttää `allowMissing: true` -jäsennystä kuten tools/activation/
 * train-map.mjs: vanhempi aaltocommit (C–G) ei tunne myöhempien aaltojen
 * portteja, ja tuntematon portti on silloin kiinni.
 *
 * @returns {{ wave: string, cacheVersion: string }}
 */
export function resolveBuildWave({ schemaSource, swSource }) {
  const gates = parseGates(schemaSource, { allowMissing: true });
  if (!gates) {
    throw new Error('src/data/schema.js: porttilohkoa (export const TABLES) ei voitu lukea');
  }
  const wave = resolveWave(gates);
  if (wave === null) {
    throw new Error(
      'porttimatriisi ei vastaa yhtäkään sallittua aaltoa: ' + describeMatrix(gates));
  }
  const cacheVersion = parseCacheVersion(swSource);
  if (!cacheVersion) {
    throw new Error("sw.js: CACHE_VERSION-vakiota ei löytynyt");
  }
  if (cacheVersion !== cacheVersionOf(wave)) {
    throw new Error(
      `sw.js CACHE_VERSION on ${cacheVersion}, aalto ${wave} edellyttää ${cacheVersionOf(wave)}`);
  }
  return { wave, cacheVersion };
}

/**
 * Hyväksyntäkoonnin versiotiedot.
 *
 * @param {object} input
 * @param {number} [input.committerEpoch] `git log -1 --format=%ct` (pakollinen commit-epochille)
 * @param {string} input.sha commitin SHA (vähintään 7 heksamerkkiä)
 * @param {string} input.schemaSource src/data/schema.js
 * @param {string} input.swSource sw.js
 * @param {string} input.pkgVersion package.jsonin version (x.y.z)
 * @param {boolean} [input.dirty] onko työpuussa muutoksia
 * @param {boolean} [input.allowDirty] salli likainen puu (nimi saa '.dirty')
 * @param {string} [input.expectedWave] operaattorin nimeämä aalto (--wave)
 * @param {string|number} [input.versionCode] '1' (oletus) | 'commit-epoch' | kokonaisluku
 */
export function computeAndroidVersion({
  committerEpoch, sha, schemaSource, swSource, pkgVersion,
  dirty = false, allowDirty = false, expectedWave = null, versionCode = '1'
} = {}) {
  if (typeof sha !== 'string' || !SHA.test(sha)) {
    throw new Error(`commitin SHA puuttuu tai ei ole heksaa: ${sha}`);
  }
  if (typeof pkgVersion !== 'string' || !SEMVER.test(pkgVersion)) {
    throw new Error(`package.jsonin version ei ole muotoa x.y.z: ${pkgVersion}`);
  }
  if (expectedWave !== null && expectedWave !== 'BASE' && !WAVE_IDS.includes(expectedWave)) {
    throw new Error(`tuntematon aalto: ${expectedWave} (sallitut: BASE, ${WAVE_IDS.join(', ')})`);
  }
  if (dirty && !allowDirty) {
    throw new Error(
      'työpuussa on committoimattomia muutoksia: hyväksyntä-APK rakennetaan vain '
      + 'puhtaasta commitista, jotta metatietojen gitCommit pitää paikkansa');
  }

  const { wave, cacheVersion } = resolveBuildWave({ schemaSource, swSource });
  if (expectedWave !== null && expectedWave !== wave) {
    throw new Error(
      `pyydetty aalto ${expectedWave}, mutta commitin porttimatriisi ja välimuisti `
      + `vastaavat aaltoa ${wave} (${cacheVersion})`);
  }

  const option = parseVersionCodeOption(versionCode);
  let code;
  if (option.policy === VERSION_POLICY.COMMIT_EPOCH) code = commitEpochVersionCode(committerEpoch);
  else code = option.value;
  assertVersionCodeRange(code);

  const sha7 = sha.slice(0, 7).toLowerCase();
  const versionName = `${pkgVersion}-wave${wave}.${cacheVersion}+${sha7}`
    + (dirty ? '.dirty' : '');

  return Object.freeze({
    versionCode: code,
    versionName,
    versionPolicy: option.policy,
    wave,
    label: `wave${wave}`,
    cacheVersion,
    sha7,
    dirty: Boolean(dirty)
  });
}

/** versionName sellaisena kuin laite sen näyttää (debug lisää päätteen). */
export function installedVersionName(versionName, buildType = 'debug') {
  return buildType === 'debug' ? versionName + DEBUG_VERSION_NAME_SUFFIX : versionName;
}

/**
 * Onko android/app/build.gradle:ssa versioiden Gradle-putkitus?
 *
 * Ilman sitä `-Pmanifestival.versionCode=...` ohitetaan hiljaa ja APK saa
 * vanhat arvot. Hyväksyntäkoonti tarkistaa tämän ennen Gradlea.
 */
export function hasVersionPlumbing(buildGradleSource) {
  const source = String(buildGradleSource || '');
  return source.includes(`'${GRADLE_VERSION_CODE_PROPERTY}'`)
    && source.includes(`'${GRADLE_VERSION_NAME_PROPERTY}'`);
}
