// Android-hyväksyntäkoonnin paketointi: tiedostonimi, metatieto-JSON,
// esitarkistus ja koontisuunnitelma (scripts/android-acceptance-build.mjs).
//
// Auditointi AND-PKG-2: J-paketin JSON alkoi BOMilla (Node ei jäsentänyt
// sitä), aikaleima ei ollut ISO-8601, SHA-256 oli isoilla kirjaimilla,
// eikä mukana ollut allekirjoittajaa, puhtaan puun tietoa eikä
// työkaluversioita. Koonti nojasi dokumentoimattomaan node_modules-
// liitokseen.
//
// Esitarkistus saa gitin ja tiedostojärjestelmän parametreina: testit
// eivät aja gitiä, eivät luo tiedostoja eivätkä liitoksia.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { read } from './helpers/sources.mjs';
import { ALL_GATES, expectedMatrix } from '../tools/release/waves.mjs';
import {
  APK_FORBIDDEN_PERMISSIONS, APP_ID, EXPECTED_CAPACITOR_PLUGINS, EXPECTED_SIGNER_CERT_SHA256,
  REQUIRED_QUERY_INTENT_ACTIONS, expectedPermissions
} from '../tools/android/apk.mjs';
import {
  METADATA_SCHEMA, REQUIRED_METADATA_KEYS, buildPackageMetadata, packageFileName,
  parsePackageFileName, serializeMetadata, versionPolicyStatus
} from '../tools/android/package.mjs';
import {
  GENERATED_GRADLE_FILES, LOCK_FILE, buildPlan, junctionCommands, powershellGradleCommand,
  psQuote, runPreflight
} from '../tools/android/preflight.mjs';
import { toolPaths } from '../tools/android/toolchain.mjs';
import { VERSION_CODE_EPOCH_SECONDS, VERSION_POLICY } from '../tools/android/version.mjs';

const SHA = '5df40b20cee4f35279a79888959d49c9af88bcc7';
const CT = 1790294741;
const NAME = '1.0.0-waveJ.v23+5df40b2-debug';

// ------------------------------------------------------------ tiedostonimi

test('tiedostonimi: wave, välimuisti, versionCode ja sha7 nimessä', () => {
  const name = packageFileName({ wave: 'J', cacheVersion: 'v23', versionCode: 1, sha7: '5df40b2' });
  assert.equal(name, 'manifestival-suunta-waveJ-v23-vc1-5df40b2-debug.apk');
  assert.deepEqual(parsePackageFileName(name), { wave: 'J', cacheVersion: 'v23', versionCode: 1, sha7: '5df40b2', buildType: 'debug' });
  assert.equal(parsePackageFileName('manifestival-suunta-waveJ-v23-5df40b2-debug.apk'), null, 'vanha nimi ilman vc-osaa');
  assert.throws(() => packageFileName({ wave: 'J', cacheVersion: 'v23', versionCode: 0, sha7: '5df40b2' }), /versionCode/);
  assert.throws(() => packageFileName({ wave: 'j', cacheVersion: 'v23', versionCode: 1, sha7: '5df40b2' }), /aalto/);
  assert.throws(() => packageFileName({ wave: 'J', cacheVersion: '23', versionCode: 1, sha7: '5df40b2' }), /välimuisti/);
  assert.throws(() => packageFileName({ wave: 'J', cacheVersion: 'v23', versionCode: 1, sha7: '5DF40B2' }), /sha7/);
});

// ------------------------------------------------------------- metatiedot

function metaInput(overrides = {}) {
  return {
    file: 'manifestival-suunta-waveJ-v23-vc23069141-5df40b2-debug.apk',
    bytes: 5807831,
    sha256: '649529244E002E40F9AF988D3C94D9C2C4ABD4FF190E9913EB2596E5250FE405',
    applicationId: APP_ID,
    buildType: 'debug',
    wave: 'J',
    cacheVersion: 'v23',
    gitCommit: SHA,
    sha7: '5df40b2',
    branch: 'rehearsal/wave-j-v1',
    commitEpochSeconds: CT,
    versionCode: 23069141,
    versionName: NAME,
    versionPolicy: VERSION_POLICY.COMMIT_EPOCH,
    gitClean: true,
    gitCleanAfterBuild: true,
    signerCertSha256: EXPECTED_SIGNER_CERT_SHA256.toUpperCase(),
    signerDn: 'C=US, O=Android, CN=Android Debug',
    minSdk: 24,
    targetSdk: 36,
    toolchain: { node: 'v24.19.0', jdk: 'openjdk version "21.0.12.1"', gradle: '9.1.0', agp: '8.13.0', buildTools: '36.0.0' },
    dist: { fileCount: 148, treeSha256: 'a'.repeat(64) },
    aapt: { packageName: APP_ID, versionCode: '23069141', versionName: NAME, minSdk: 24, targetSdk: 36, debuggable: true, permissions: [] },
    verify: { passed: true, checks: 35, failed: [] },
    lock: { file: LOCK_FILE, checked: true, deployTarget: SHA, matches: true },
    builtAt: new Date(Date.UTC(2026, 8, 26, 12, 0, 0)).toISOString(),
    ...overrides
  };
}

test('metatieto-JSON: UTF-8 ilman BOMia, jäsentyy, ISO-aika, pienet SHA-256:t, kaikki avaimet', () => {
  const bytes = serializeMetadata(buildPackageMetadata(metaInput()));
  assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'BOM');
  assert.equal(bytes.includes(13), false, 'CR-tavuja JSONissa');
  const meta = JSON.parse(bytes.toString('utf8'));
  assert.equal(meta.schema, METADATA_SCHEMA);
  assert.match(meta.builtAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
  assert.equal(Number.isNaN(Date.parse(meta.builtAt)), false);
  assert.match(meta.sha256, /^[0-9a-f]{64}$/);
  assert.match(meta.signerCertSha256, /^[0-9a-f]{64}$/);
  assert.equal(meta.signerCertSha256, EXPECTED_SIGNER_CERT_SHA256);
  for (const key of REQUIRED_METADATA_KEYS) assert.ok(key in meta, `avain ${key} puuttuu`);
  assert.equal(meta.gitClean, true);
  assert.equal(meta.versionPolicy, 'commit-seconds-since-2026-01-01Z');
});

test('tiedostonimi ja JSON kertovat saman aallon, välimuistin, versionCoden ja sha7:n', () => {
  const meta = JSON.parse(serializeMetadata(buildPackageMetadata(metaInput())).toString('utf8'));
  const fromName = parsePackageFileName(meta.file);
  assert.deepEqual(fromName, { wave: meta.wave, cacheVersion: meta.cacheVersion,
    versionCode: meta.versionCode, sha7: meta.sha7, buildType: meta.buildType });
  assert.equal(meta.gitCommit.slice(0, 7), meta.sha7);
  assert.ok(meta.versionName.includes(`+${meta.sha7}`));
  assert.equal(String(meta.aapt.versionCode), String(meta.versionCode));
});

test('metatiedot hylkäävät vanhan käsin tehdyn muodon ja epäjohdonmukaisuudet', () => {
  const rejects = (overrides, pattern) => assert.throws(() => buildPackageMetadata(metaInput(overrides)), pattern);
  rejects({ builtAt: '2026-09-25T00.07.56Z' }, /builtAt/);
  rejects({ gitClean: false }, /gitClean/);
  rejects({ verify: { passed: false, checks: 35, failed: ['manifest.queries'] } }, /verify-apk/);
  rejects({ aapt: { versionCode: '1', versionName: NAME } }, /aapt-lukema/);
  rejects({ versionName: '1.0.0-debug' }, /sha7/);
  rejects({ sha256: 'abc' }, /sha256/);
  rejects({ signerCertSha256: null }, /signerCertSha256/);
  rejects({ file: 'manifestival-suunta-waveJ-v23-5df40b2-debug.apk' }, /file/);
  rejects({ sha7: '1234567' }, /sha7|file/);
  rejects({ dist: { fileCount: 148 } }, /dist/);
  rejects({ versionPolicy: 'git-count' }, /versionPolicy/);
});

test('versionCode-käytännön tila kertoo, onko omistajan päätös tehty', () => {
  assert.match(versionPolicyStatus(VERSION_POLICY.FIXED), /^OWNER_PRODUCT_DECISION_PENDING/);
  assert.match(versionPolicyStatus(VERSION_POLICY.COMMIT_EPOCH), /^OWNER_PRODUCT_DECISION_APPLIED/);
  const fixed = buildPackageMetadata(metaInput({
    file: 'manifestival-suunta-waveJ-v23-vc1-5df40b2-debug.apk', versionCode: 1,
    versionPolicy: VERSION_POLICY.FIXED, aapt: { versionCode: '1', versionName: NAME }
  }));
  assert.match(fixed.versionPolicyStatus, /PENDING/);
});

// ------------------------------------------------------------- esitarkistus

const WT = path.resolve('/wt-rc-j');
const MAIN = path.resolve('/main');
const REPO = path.resolve('/repo');
const JDK = path.resolve('/jdk21');
const SDK = path.resolve('/sdk');

function schemaFor(wave) {
  const m = expectedMatrix(wave);
  return 'export const TABLES = Object.freeze({\n' + ALL_GATES.map(g => `  ${g}: ${m[g]},`).join('\n')
    + '\n});\nexport function hasTable() {}\n';
}

/**
 * Muistissa oleva työpuu. Palauttaa preflightin riippuvuudet ja lokin
 * git-kutsuista. Riippuvuuksissa EI ole kirjoittavia funktioita.
 */
function fakeWorld({
  wave = 'J', cache = 'v23', dirty = '', plumbing = true, nodeModules = true, jdk = true, sdk = true,
  lockTarget = SHA, lockConsistent = true, packageExists = false, installed = '8.5.0', locked = '8.5.0',
  mainRepo = MAIN, gradleProperties = `org.gradle.java.home=${JDK}\n`, platform = 'win32'
} = {}) {
  const files = new Map();
  const put = (rel, text, root = WT) => files.set(path.join(root, rel), text);
  const dirs = new Set([WT, path.join(WT, '.git')]);
  put('package.json', JSON.stringify({ version: '1.0.0' }));
  put('src/data/schema.js', schemaFor(wave));
  put('sw.js', `const CACHE_VERSION = '${cache}';\n`);
  put('android/app/build.gradle', plumbing
    ? "def a = project.findProperty('manifestival.versionCode')\ndef b = project.findProperty('manifestival.versionName')\n"
    : 'versionCode 1\nversionName "1.0"\n');
  if (gradleProperties !== null) put('android/gradle.properties', gradleProperties);
  const capacitor = ['android', 'core', 'cli', 'app', 'geolocation', 'local-notifications'];
  put('package-lock.json', JSON.stringify({ packages: Object.fromEntries(capacitor.map(n =>
    [`node_modules/@capacitor/${n}`, { version: n === 'android' ? locked : '8.5.0' }])) }));
  if (nodeModules) {
    put('node_modules/@capacitor/android/capacitor/build.gradle', '');
    for (const n of capacitor) put(`node_modules/@capacitor/${n}/package.json`, JSON.stringify({ version: n === 'android' ? installed : '8.5.0' }));
  }
  put(LOCK_FILE, JSON.stringify({ waves: [{ wave: 'J', ref: 'rehearsal/wave-j-v1', deployTarget: lockTarget,
    waveCommit: 'e96942c296944b4ac1a86d96563f2a1370678d97', consistent: lockConsistent }] }), REPO);
  if (jdk) {
    dirs.add(path.join(JDK, 'bin', 'java.exe'));
    dirs.add(path.join(JDK, 'bin', 'java'));
  }
  if (sdk) {
    dirs.add(SDK);
    const tools = toolPaths({ sdkDir: SDK, jdkDir: JDK });
    dirs.add(tools.aapt2);
    dirs.add(tools.apksignerJar);
  }
  if (packageExists) {
    dirs.add(path.join(mainRepo, '.claude', 'release-packages', 'manifestival-suunta-waveJ-v23-vc1-5df40b2-debug.apk'));
  }

  const gitCalls = [];
  const git = args => {
    gitCalls.push(args.join(' '));
    const key = args.join(' ');
    if (key === 'rev-parse --show-toplevel') return WT.replace(/\\/g, '/');
    if (key === 'status --porcelain --untracked-files=all') return dirty;
    if (key === 'log -1 --format=%H %ct') return `${SHA} ${CT}`;
    if (key === 'rev-parse --abbrev-ref HEAD') return 'rehearsal/wave-j-v1';
    if (key === 'rev-parse --path-format=absolute --git-common-dir') return path.join(mainRepo, '.git');
    throw new Error('odottamaton git-kutsu: ' + key);
  };
  const deps = Object.freeze({
    git,
    exists: p => files.has(p) || dirs.has(p),
    readFile: p => {
      if (!files.has(p)) throw new Error('ENOENT ' + p);
      return files.get(p);
    },
    env: sdk ? { ANDROID_HOME: SDK } : {},
    platform
  });
  return { deps, gitCalls };
}

const preflight = (options = {}, world = {}) => {
  const { deps, gitCalls } = fakeWorld(world);
  const result = runPreflight({ worktree: WT, wave: 'J', repoRoot: REPO, ...options }, deps);
  return { ...result, gitCalls, failedIds: result.checks.filter(c => !c.ok).map(c => c.id) };
};

test('esitarkistus: kunnossa oleva ehdokas menee läpi ja nimeää paketin', () => {
  const pre = preflight();
  assert.deepEqual(pre.failedIds, []);
  assert.equal(pre.ok, true);
  assert.equal(pre.stop, null);
  assert.equal(pre.facts.version.versionCode, 1, 'oletus on yhä 1 (omistajan päätös odottaa)');
  assert.equal(pre.facts.installedVersionName, NAME);
  assert.equal(pre.facts.packagePath,
    path.join(MAIN, '.claude', 'release-packages', 'manifestival-suunta-waveJ-v23-vc1-5df40b2-debug.apk'));
  assert.equal(pre.facts.lock.matches, true);
  assert.equal(pre.facts.jdk.passOnCommandLine, false);
  assert.ok(pre.gitCalls.every(call => !/^(checkout|add|commit|reset|stash|clean|push)/.test(call)),
    'esitarkistus ajoi kirjoittavan git-komennon');
});

test('esitarkistus hylkää likaisen työpuun', () => {
  const pre = preflight({}, { dirty: ' M src/app/main.js\n?? scratch.txt' });
  assert.deepEqual(pre.failedIds, ['git.clean']);
  assert.equal(pre.ok, false);
  assert.match(pre.checks.find(c => c.id === 'git.clean').detail, /2 muutosta/);
});

test('esitarkistus hylkää aallon, joka ei vastaa porttimatriisia tai välimuistia', () => {
  assert.deepEqual(preflight({}, { wave: 'BASE', cache: 'v13' }).failedIds, ['wave.matrix']);
  assert.match(preflight({}, { wave: 'BASE', cache: 'v13' }).checks.find(c => c.id === 'wave.matrix').detail,
    /pyydetty aalto J/);
  assert.deepEqual(preflight({}, { cache: 'v22' }).failedIds, ['wave.matrix']);
  assert.deepEqual(preflight({ wave: 'Q' }).failedIds, ['args.wave']);
});

test('esitarkistus vaatii, että HEAD on lukittu ehdokas; ohitus kirjataan', () => {
  const moved = preflight({}, { lockTarget: 'f'.repeat(40) });
  assert.deepEqual(moved.failedIds, ['lock']);
  assert.match(moved.checks.find(c => c.id === 'lock').detail, /train-map\.mjs --write/);
  assert.deepEqual(preflight({}, { lockConsistent: false }).failedIds, ['lock']);
  const skipped = preflight({ skipLockCheck: true }, { lockTarget: 'f'.repeat(40) });
  assert.deepEqual(skipped.failedIds, []);
  assert.equal(skipped.facts.lock.checked, false);
});

test('esitarkistus pysähtyy ja TULOSTAA liitoskomennon, jos node_modules puuttuu (ei luo sitä)', () => {
  const pre = preflight({}, { nodeModules: false });
  assert.deepEqual(pre.failedIds, ['node_modules']);
  assert.equal(pre.ok, false);
  assert.ok(pre.stop);
  assert.equal(pre.stop.commands.create,
    `cmd /c mklink /J "${path.join(WT, 'node_modules').replace(/\//g, '\\')}" "${path.join(MAIN, 'node_modules').replace(/\//g, '\\')}"`);
  assert.equal(pre.stop.commands.remove, `cmd /c rmdir "${path.join(WT, 'node_modules').replace(/\//g, '\\')}"`);
  assert.match(pre.stop.commands.warning, /rmdir/);
  // Riippuvuuksissa ei ole kirjoittavaa funktiota: liitosta ei voi syntyä.
  assert.deepEqual(Object.keys(fakeWorld().deps).sort(), ['env', 'exists', 'git', 'platform', 'readFile']);
});

test('pääkopiossa (ei työpuu) node_modulesin puute neuvoo npm ci:n, ei liitosta', () => {
  const pre = preflight({}, { nodeModules: false, mainRepo: WT });
  assert.equal(pre.stop.commands, null);
  assert.match(pre.stop.hint, /npm ci/);
});

test('node_modules, joka ei vastaa työpuun package-lock.jsonia, hylätään', () => {
  const pre = preflight({}, { installed: '8.4.0' });
  assert.deepEqual(pre.failedIds, ['node_modules']);
  assert.match(pre.checks.find(c => c.id === 'node_modules').detail, /@capacitor\/android 8\.4\.0 != lock 8\.5\.0/);
});

test('puuttuva JDK 21, SDK, versioputkitus tai varattu paketin nimi kaatavat', () => {
  assert.deepEqual(preflight({}, { jdk: false }).failedIds, ['jdk']);
  assert.deepEqual(preflight({}, { sdk: false }).failedIds, ['sdk']);
  assert.deepEqual(preflight({}, { plumbing: false }).failedIds, ['gradle.versionPlumbing']);
  assert.match(preflight({}, { plumbing: false }).checks.find(c => c.id === 'gradle.versionPlumbing').detail, /cherry-pick/);
  assert.deepEqual(preflight({}, { packageExists: true }).failedIds, ['package.target']);
  assert.deepEqual(preflight({}, { platform: 'linux' }).failedIds, ['platform']);
});

test('kiinnittämätön ehdokas (aallot C–G) tarvitsee --jdk:n, joka annetaan Gradlelle komentorivillä', () => {
  const unpinned = preflight({}, { gradleProperties: 'android.useAndroidX=true\n' });
  assert.deepEqual(unpinned.failedIds, ['jdk']);
  const withFlag = preflight({ jdk: JDK }, { gradleProperties: 'android.useAndroidX=true\n' });
  assert.deepEqual(withFlag.failedIds, []);
  assert.equal(withFlag.facts.jdk.passOnCommandLine, true);
  const plan = buildPlan(withFlag.facts);
  assert.ok(plan.find(s => s.id === 'gradle').args.at(-1).includes(psQuote(`-Dorg.gradle.java.home=${JDK}`)));
});

test('--version-code=commit-epoch antaa committer-ajasta johdetun koodin nimeen ja suunnitelmaan', () => {
  const pre = preflight({ versionCode: 'commit-epoch' });
  assert.deepEqual(pre.failedIds, []);
  assert.equal(pre.facts.version.versionCode, CT - VERSION_CODE_EPOCH_SECONDS);
  assert.equal(pre.facts.version.versionCode, 23069141);
  assert.match(pre.facts.packageName, /-vc23069141-5df40b2-debug\.apk$/);
  const gradle = buildPlan(pre.facts).find(s => s.id === 'gradle');
  assert.ok(gradle.args.at(-1).includes("'-Pmanifestival.versionCode=23069141'"));
});

// -------------------------------------------------------- suunnitelma

test('suunnitelma: build:web -> cap sync -> Gradle PowerShellistä -> tarkastus -> palautus -> paketti', () => {
  const plan = buildPlan(preflight().facts);
  assert.deepEqual(plan.map(s => s.id), ['build-web', 'cap-sync', 'gradle', 'verify', 'restore', 'assert-clean', 'package']);
  assert.equal(plan[0].command, 'npm run build:web');
  assert.equal(plan[1].command, 'npx cap sync android');
  const gradle = plan[2];
  assert.equal(gradle.file, 'powershell.exe');
  assert.deepEqual(gradle.args.slice(0, 4), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass']);
  assert.equal(gradle.args[5], powershellGradleCommand({ versionCode: 1, versionName: '1.0.0-waveJ.v23+5df40b2' }));
  for (const file of GENERATED_GRADLE_FILES) assert.ok(plan[4].command.includes(file));
  assert.match(plan[6].command, /manifestival-suunta-waveJ-v23-vc1-5df40b2-debug\.apk\.json/);
});

test('PowerShell-komento lainaa jokaisen -P-argumentin (PS 5.1 pilkkoisi pisteen kohdalta)', () => {
  const command = powershellGradleCommand({ versionCode: 23069141, versionName: "1.0.0-waveJ.v23+5df40b2" });
  assert.equal(command, "Set-Location -LiteralPath 'android'; & .\\gradlew.bat --console=plain assembleDebug "
    + "'-Pmanifestival.versionCode=23069141' '-Pmanifestival.versionName=1.0.0-waveJ.v23+5df40b2'; exit $LASTEXITCODE");
  assert.equal(psQuote("a'b"), "'a''b'");
});

test('liitoskomennot: luonti mklink /J, poisto vain rmdir', () => {
  const c = junctionCommands({ worktree: path.resolve('/x/wt'), mainRepo: path.resolve('/x/main') });
  assert.match(c.create, /^cmd \/c mklink \/J "[^"]+node_modules" "[^"]+node_modules"$/);
  assert.match(c.remove, /^cmd \/c rmdir "[^"]+node_modules"$/);
  assert.match(c.warning, /Remove-Item -Recurse/);
});

test('package.json: android:acceptance ajaa hyväksyntäkoonnin', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.scripts['android:acceptance'], 'node scripts/android-acceptance-build.mjs');
});

test('koontiskripti ei luo liitoksia eikä koske pakettiin ennen tarkastusta', () => {
  const source = read('scripts/android-acceptance-build.mjs');
  assert.doesNotMatch(source, /symlinkSync|mklink|New-Item/, 'skripti yrittää luoda liitoksen itse');
  const verifyAt = source.indexOf('collectAndVerify({');
  const copyAt = source.indexOf('fs.copyFileSync(apkPath');
  const restoreAt = source.indexOf('const after = restoreGenerated(worktree)');
  assert.ok(verifyAt > 0 && restoreAt > verifyAt && copyAt > restoreAt,
    'järjestys: tarkastus -> palautus + puhdas puu -> paketti');
  assert.match(source, /serializeMetadata\(meta\)/, 'metatiedot kirjoitetaan ilman BOMia serializeMetadatan kautta');
  assert.match(source, /--dry-run|'dry-run'/);
});

// ------------------------------------------------------------ dokumentaatio

const ACCEPTANCE_DOC = 'docs/activation/ANDROID-ACCEPTANCE-BUILD.md';

test('ANDROID-ACCEPTANCE-BUILD.md mainitsee jokaisen sallitun ja kielletyn luvan', () => {
  const doc = read(ACCEPTANCE_DOC);
  for (const permission of expectedPermissions()) {
    const short = permission.split('.').pop();
    assert.ok(doc.includes(short), `luparaulukosta puuttuu ${short} (APK_PERMISSION_ALLOWLIST)`);
  }
  for (const rule of APK_FORBIDDEN_PERMISSIONS) {
    assert.ok(doc.includes(rule.split('.').pop()), `kielletty lupa ${rule} puuttuu dokumentista`);
  }
  for (const action of REQUIRED_QUERY_INTENT_ACTIONS) assert.ok(doc.includes(action));
  for (const plugin of EXPECTED_CAPACITOR_PLUGINS) assert.ok(doc.includes(plugin));
  assert.match(doc, /Sijaintilupia ei ole/);
  assert.match(doc, /RECORD_AUDIO[^\n]*napauttaa mikrofonia/, 'mikrofoniluvan pyytämisen hetki puuttuu');
});

test('ANDROID-ACCEPTANCE-BUILD.md: menettely, versiointipäätös ja allekirjoitus', () => {
  const doc = read(ACCEPTANCE_DOC);
  for (const needle of [
    'npm run android:acceptance', '--dry-run', 'mklink /J', 'cmd /c rmdir', 'Remove-Item -Recurse',
    ...GENERATED_GRADLE_FILES,
    'jdk-21.0.12.101-hotspot', 'VERSION_21',
    'OWNER PRODUCT DECISION', '--version-code=commit-epoch', '1767225600', 'INSTALL_FAILED_VERSION_DOWNGRADE',
    EXPECTED_SIGNER_CERT_SHA256, 'debug.keystore', 'secrets',
    'release-train-c-j.json', 'train-map.mjs --write'
  ]) {
    assert.ok(doc.includes(needle), `${ACCEPTANCE_DOC}: puuttuu "${needle}"`);
  }
  assert.doesNotMatch(doc, /versionCode\/versionName jätettiin ennalleen/, 'vanha "versio jätettiin ennalleen" -teksti');
});

test('Java-ohjeet eivät neuvo Android Studion JBR:ää, kun daemon on kiinnitetty JDK 21:een', () => {
  const pinned = /^\s*org\.gradle\.java\.home\s*=/m.test(read('android/gradle.properties'));
  for (const file of ['docs/ANDROID-STRATEGY.md', 'docs/DEPLOYMENT.md']) {
    const doc = read(file);
    if (pinned) {
      assert.doesNotMatch(doc, /JAVA_HOME=["']?[^\n"']*Android Studio\/jbr/,
        `${file} neuvoo yhä JAVA_HOME=…/jbr, vaikka gradle.properties kiinnittää JDK 21:n`);
    }
    assert.match(doc, /VERSION_21/, `${file}: Java 21 -vaatimuksen syy puuttuu`);
    assert.match(doc, /OMISTAJAN TUOTEPÄÄTÖS/, `${file}: versionCode-päätöksen tila puuttuu`);
  }
  assert.match(read('docs/DEPLOYMENT.md'), /npm run android:acceptance/);
  assert.doesNotMatch(read('docs/ANDROID-STRATEGY.md'), /tasan kaksi JDK:ta|ne 41 tiedostoa/);
});
