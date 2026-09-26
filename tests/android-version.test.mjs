// Android-versiointi: versionCode/versionName ja niiden Gradle-putkitus.
//
// Taustalla auditoinnin havainto AND-VER-1: jokainen APK näytti
// puhelimen asetuksissa samalta (versionCode 1, versionName 1.0).
// versionName muuttuu nyt; versionCode > 1 on OMISTAJAN TUOTEPÄÄTÖS
// ja pysyy oletuksena 1 (docs/activation/ANDROID-ACCEPTANCE-BUILD.md).
//
// Testit ovat haarariippumattomia: ne ajetaan myös ehdokashaaroilla
// (rehearsal/wave-*), joille versiointicommit cherry-pickataan. Siksi
// "tuotehaara = BASE" -tapaus rakennetaan synteettisesti eikä lueta
// työpuun schema.js:stä.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { read } from './helpers/sources.mjs';
import { currentState } from '../tools/release/state.mjs';
import { ALL_GATES, expectedMatrix } from '../tools/release/waves.mjs';
import {
  DEBUG_VERSION_NAME_SUFFIX, VERSION_CODE_EPOCH_SECONDS, VERSION_CODE_MAX, VERSION_POLICY,
  commitEpochVersionCode, computeAndroidVersion, hasVersionPlumbing, installedVersionName,
  parseVersionCodeOption
} from '../tools/android/version.mjs';

/** schema.js:n porttilohko annetulle aallolle (sama muoto kuin oikeassa tiedostossa). */
function schemaFor(wave, overrides = {}) {
  const matrix = { ...expectedMatrix(wave), ...overrides };
  return 'export const TABLES = Object.freeze({\n'
    + ALL_GATES.map(gate => `  ${gate}: ${matrix[gate]},`).join('\n')
    + '\n});\n\nexport function hasTable(name) { return TABLES[name] === true; }\n';
}
const swFor = cache => `const CACHE_VERSION = '${cache}';\nconst CACHE_NAME = \`manifestival-shell-\${CACHE_VERSION}\`;\n`;

/** Aallon J vanha kärki 5df40b2 (auditointi: ct 1790294741). */
const J_TIP = Object.freeze({
  committerEpoch: 1790294741,
  sha: '5df40b20cee4f35279a79888959d49c9af88bcc7',
  schemaSource: schemaFor('J'),
  swSource: swFor('v23'),
  pkgVersion: '1.0.0'
});

// ------------------------------------------------ computeAndroidVersion

test('(a) J-kärki: commit-epoch antaa 23069141 ja nimen 1.0.0-waveJ.v23+5df40b2', () => {
  const v = computeAndroidVersion({ ...J_TIP, versionCode: 'commit-epoch', expectedWave: 'J' });
  assert.equal(v.versionCode, 23069141);
  assert.equal(v.versionName, '1.0.0-waveJ.v23+5df40b2');
  assert.equal(v.versionPolicy, VERSION_POLICY.COMMIT_EPOCH);
  assert.equal(v.wave, 'J');
  assert.equal(v.cacheVersion, 'v23');
  assert.equal(installedVersionName(v.versionName), '1.0.0-waveJ.v23+5df40b2-debug');
});

test('oletus on nykyinen käytös: versionCode 1 (omistajan päätös odottaa), nimi silti yksilöivä', () => {
  const v = computeAndroidVersion(J_TIP);
  assert.equal(v.versionCode, 1);
  assert.equal(v.versionPolicy, VERSION_POLICY.FIXED);
  assert.equal(v.versionName, '1.0.0-waveJ.v23+5df40b2');
});

test('(b) myöhempi commit antaa aina suuremman koodin (myös uudelleenleikattu aalto)', () => {
  // Auditoinnin mittaamat committer-ajat rakennusjärjestyksessä: C, F, G, H, I, J, tuotehaara.
  const codes = [21682610, 23065596, 23065940, 23066600, 23066888, 23069141, 23199413];
  const epochs = codes.map(code => code + VERSION_CODE_EPOCH_SECONDS);
  const computed = epochs.map(ct => commitEpochVersionCode(ct));
  assert.deepEqual(computed, codes);
  for (let i = 1; i < computed.length; i++) assert.ok(computed[i] > computed[i - 1]);

  const later = computeAndroidVersion({ ...J_TIP, committerEpoch: J_TIP.committerEpoch + 1, versionCode: 'commit-epoch' });
  assert.ok(later.versionCode > 23069141);
});

test('(c) koodi <= 1, yli 2100000000 tai commit ennen 2026-01-01Z kaatuu', () => {
  const at = ct => () => computeAndroidVersion({ ...J_TIP, committerEpoch: ct, versionCode: 'commit-epoch' });
  assert.throws(at(VERSION_CODE_EPOCH_SECONDS - 1), /ennen 2026-01-01/);
  assert.throws(at(VERSION_CODE_EPOCH_SECONDS), /<= 1/);
  assert.throws(at(VERSION_CODE_EPOCH_SECONDS + 1), /<= 1/);
  assert.equal(computeAndroidVersion({ ...J_TIP, committerEpoch: VERSION_CODE_EPOCH_SECONDS + 2, versionCode: 'commit-epoch' }).versionCode, 2);
  assert.equal(commitEpochVersionCode(VERSION_CODE_EPOCH_SECONDS + VERSION_CODE_MAX), VERSION_CODE_MAX);
  assert.throws(at(VERSION_CODE_EPOCH_SECONDS + VERSION_CODE_MAX + 1), /ylittää/);
  assert.throws(at(1790294741.5), /kokonaisluku/);
  assert.throws(at(undefined), /kokonaisluku/);
});

test('(d) porttimatriisi, joka ei vastaa aaltoa, tai välimuistin ja aallon ristiriita kaatuu', () => {
  // runningTimers auki ilman alignmentItemSettingsiä: ei yksikään sallittu tila.
  assert.throws(() => computeAndroidVersion({ ...J_TIP, schemaSource: schemaFor('J', { alignmentItemSettings: false }) }),
    /ei vastaa yhtäkään sallittua aaltoa/);
  assert.throws(() => computeAndroidVersion({ ...J_TIP, swSource: swFor('v22') }),
    /CACHE_VERSION on v22, aalto J edellyttää v23/);
  assert.throws(() => computeAndroidVersion({ ...J_TIP, schemaSource: 'export const X = 1;' }), /porttilohkoa/);
  assert.throws(() => computeAndroidVersion({ ...J_TIP, swSource: '' }), /CACHE_VERSION/);
});

test('(e) likainen puu kaatuu, ellei allowDirty; silloin nimi saa .dirty-päätteen', () => {
  assert.throws(() => computeAndroidVersion({ ...J_TIP, dirty: true }), /committoimattomia/);
  const v = computeAndroidVersion({ ...J_TIP, dirty: true, allowDirty: true });
  assert.equal(v.versionName, '1.0.0-waveJ.v23+5df40b2.dirty');
  assert.equal(v.dirty, true);
});

test('(f) tuotehaaran tila (kaikki portit kiinni, v13) on waveBASE ja hylätään, kun pyydetään J', () => {
  const base = { ...J_TIP, schemaSource: schemaFor('BASE'), swSource: swFor('v13') };
  const v = computeAndroidVersion(base);
  assert.equal(v.label, 'waveBASE');
  assert.equal(v.versionName, '1.0.0-waveBASE.v13+5df40b2');
  assert.throws(() => computeAndroidVersion({ ...base, expectedWave: 'J' }),
    /pyydetty aalto J, mutta .* aaltoa BASE/);
});

test('vanhempi aaltocommit, joka ei tunne myöhempiä portteja, tulkitaan (puuttuva portti = kiinni)', () => {
  // Aallon C commit ei tunne F–J:n portteja lainkaan.
  const matrix = expectedMatrix('C');
  const known = ALL_GATES.slice(0, 10);
  const schema = 'export const TABLES = Object.freeze({\n'
    + known.map(gate => `  ${gate}: ${matrix[gate]},`).join('\n') + '\n});\nexport function hasTable() {}\n';
  const v = computeAndroidVersion({ ...J_TIP, schemaSource: schema, swSource: swFor('v16'), expectedWave: 'C' });
  assert.equal(v.versionName, '1.0.0-waveC.v16+5df40b2');
});

test('työpuun oikea tila kelpaa sellaisenaan (millä tahansa haaralla)', () => {
  const state = currentState();
  assert.ok(state.wave, 'työpuun porttimatriisi ei vastaa aaltoa: ' + state.problems.join('; '));
  const pkg = JSON.parse(read('package.json'));
  const v = computeAndroidVersion({
    committerEpoch: 1790294741, sha: 'abcdef0123456789abcdef0123456789abcdef01',
    schemaSource: read('src/data/schema.js'), swSource: read('sw.js'),
    pkgVersion: pkg.version, expectedWave: state.wave
  });
  assert.equal(v.versionName, `${pkg.version}-wave${state.wave}.${state.cacheVersion}+abcdef0`);
});

test('syötteiden muoto: SHA, package.json-versio ja aalto tarkistetaan', () => {
  assert.throws(() => computeAndroidVersion({ ...J_TIP, sha: 'xyz' }), /SHA/);
  assert.throws(() => computeAndroidVersion({ ...J_TIP, sha: 'abc12' }), /SHA/);
  assert.throws(() => computeAndroidVersion({ ...J_TIP, pkgVersion: '1.0' }), /x\.y\.z/);
  assert.throws(() => computeAndroidVersion({ ...J_TIP, expectedWave: 'Z' }), /tuntematon aalto/);
  assert.equal(computeAndroidVersion({ ...J_TIP, sha: '5DF40B2' }).sha7, '5df40b2');
});

test('--version-code: 1, commit-epoch tai kokonaisluku 1..2100000000; muu kaatuu', () => {
  assert.deepEqual({ ...parseVersionCodeOption(undefined) }, { policy: VERSION_POLICY.FIXED, value: 1 });
  assert.deepEqual({ ...parseVersionCodeOption('1') }, { policy: VERSION_POLICY.FIXED, value: 1 });
  assert.deepEqual({ ...parseVersionCodeOption('commit-epoch') }, { policy: VERSION_POLICY.COMMIT_EPOCH, value: null });
  assert.deepEqual({ ...parseVersionCodeOption('42') }, { policy: VERSION_POLICY.EXPLICIT, value: 42 });
  assert.throws(() => parseVersionCodeOption('0'), /välillä/);
  assert.throws(() => parseVersionCodeOption('2100000001'), /välillä/);
  assert.throws(() => parseVersionCodeOption('git-count'), /tuntematon/);
  assert.equal(computeAndroidVersion({ ...J_TIP, versionCode: '42' }).versionPolicy, VERSION_POLICY.EXPLICIT);
});

// ------------------------------------------------ android/app/build.gradle

/** build.gradle ilman //-kommentteja (kommentti saa selittää kielletyn asian). */
function buildGradleCode() {
  return read('android/app/build.gradle').split(/\r?\n/)
    .map(line => line.replace(/^\s*\/\/.*$/, ''))
    .join('\n');
}

test('build.gradle lukee manifestival.versionCode-ominaisuuden, oletus 1, ja vartioi 1..2100000000', () => {
  const code = buildGradleCode();
  assert.ok(hasVersionPlumbing(code), 'versio-ominaisuuksien putkitus puuttuu');
  assert.match(code, /findProperty\('manifestival\.versionCode'\)\s*\?:\s*'1'/,
    'oletus-versionCode ei ole 1: kaikki koonnit muuttuisivat ilman omistajan päätöstä');
  assert.match(code, /2100000000/, 'Google Playn ylärajan vartija puuttuu');
  assert.match(code, /GradleException/);
  assert.match(code, /versionCode\s*=\s*mfVersionCode/);
  assert.match(code, /versionName\s*=\s*mfVersionName/);
  assert.doesNotMatch(code, /versionCode\s+1\b/, 'kovakoodattu versionCode 1 on yhä paikallaan');
});

test('debug-buildType lisää versionNameen päätteen "-debug"', () => {
  const code = buildGradleCode();
  const debugBlock = /buildTypes\s*\{[\s\S]*?\bdebug\s*\{([^}]*)\}/.exec(code);
  assert.ok(debugBlock, 'buildTypes.debug puuttuu');
  assert.match(debugBlock[1], /versionNameSuffix\s*=?\s*["']-debug["']/);
  assert.equal(DEBUG_VERSION_NAME_SUFFIX, '-debug');
});

test('OMISTAJAN PÄÄTÖS: applicationIdSuffixia ei ole (debug on laitteella sama sovellus)', () => {
  // Pääte tekisi debug-koonnista eri sovelluksen: oma istunto, omat
  // muistutukset (tuplamuistutukset), kaksi kuvaketta. Tämä testi
  // kääntyy vasta, jos omistaja päättää toisin (AND-ID-5).
  assert.doesNotMatch(buildGradleCode(), /applicationIdSuffix/);
  assert.match(buildGradleCode(), /applicationId\s+"fi\.limitlesslife\.manifestival"/);
});

test('versionNamen oletuspohja on package.jsonin versio', () => {
  const pkg = JSON.parse(read('package.json'));
  const m = /findProperty\('manifestival\.versionName'\)\s*\?:\s*'([^']+)'/.exec(buildGradleCode());
  assert.ok(m, 'versionNamen oletus puuttuu');
  assert.equal(m[1], pkg.version, 'build.gradlen oletus-versionName ja package.jsonin versio erkanivat');
});

// ------------------------------------------------ android/gradle.properties

test('JDK-kiinnityksen vieressä on oikea syy: Capacitor 8 kääntää tasolla VERSION_21', () => {
  const lines = read('android/gradle.properties').split(/\r?\n/);
  const index = lines.findIndex(line => /^\s*org\.gradle\.java\.home\s*=/.test(line));
  if (index === -1) return; // ei kiinnitystä tässä commitissa (esim. aallot C–G)
  const comment = [];
  for (let i = index - 1; i >= 0 && lines[i].trim().startsWith('#'); i--) comment.unshift(lines[i]);
  const text = comment.join('\n');
  assert.match(text, /VERSION_21/, 'kiinnityksen kommentti ei kerro Java 21 -vaatimuksen lähdettä');
  assert.match(text, /Capacitor/);
  assert.doesNotMatch(text, /Gradle 9\.x[^\n]*requires JDK 21/, 'vanha, väärä perustelu on palannut');
});
