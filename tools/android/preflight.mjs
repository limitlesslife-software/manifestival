// Hyväksyntä-APK:n esitarkistus ja koontisuunnitelma.
//
// Kaikki riippuvuudet (git, tiedostojärjestelmä, ympäristö) annetaan
// parametreina, joten jokainen hylkäysperuste on testattavissa ilman
// oikeaa työpuuta (tests/android-acceptance-package.test.mjs).
//
// ESITARKISTUS EI KORJAA MITÄÄN. Jos node_modules puuttuu työpuusta, se
// tulostaa TARKAN liitoskomennon (junction) ja pysähtyy — se ei luo
// liitosta hiljaa. Liitos osoittaa pääkopion node_modulesiin, ja sen
// väärä poistotapa (rekursiivinen poisto) tyhjentäisi pääkopion
// riippuvuudet. Siksi ihminen luo ja poistaa sen tietoisesti.

import path from 'node:path';

import { WAVE_IDS } from '../release/waves.mjs';
import { samePath } from './cli.mjs';
import { packageFileName } from './package.mjs';
import { BUILD_TOOLS_VERSION, readGradleJavaHome, resolveJdkDir, resolveSdkDir, toolPaths } from './toolchain.mjs';
import {
  GRADLE_VERSION_CODE_PROPERTY, GRADLE_VERSION_NAME_PROPERTY, computeAndroidVersion,
  hasVersionPlumbing, installedVersionName
} from './version.mjs';

/** Julkaisujunan lukitustiedosto (tools/activation/train-map.mjs --write). */
export const LOCK_FILE = 'docs/activation/release-train-c-j.json';

/** Tiedostot, jotka `npx cap sync android` kirjoittaa uudelleen ja jotka palautetaan. */
export const GENERATED_GRADLE_FILES = Object.freeze([
  'android/capacitor.settings.gradle',
  'android/app/capacitor.build.gradle'
]);

/** Capacitor-paketit, joiden versio verrataan package-lock.jsoniin. */
export const CAPACITOR_PACKAGES = Object.freeze([
  '@capacitor/android', '@capacitor/core', '@capacitor/cli',
  '@capacitor/app', '@capacitor/geolocation', '@capacitor/local-notifications'
]);

/** Debug-APK:n sijainti Gradlen jäljiltä. */
export const DEBUG_APK_OUTPUT = 'android/app/build/outputs/apk/debug/app-debug.apk';

const winPath = p => String(p).replace(/\//g, '\\');

/** PowerShell-merkkijono yksinkertaisissa lainausmerkeissä (kirjaimellinen). */
export function psQuote(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

/**
 * PowerShell-komento Gradlelle.
 *
 * Jokainen -P/-D-argumentti on lainattu: Windows PowerShell 5.1 pilkkoo
 * natiivikomennolle annetun `-Pa.b=c`-argumentin pisteen kohdalta, jos
 * sitä ei lainata (sama ilmiö kuin Mavenin -Dmaven.x=y).
 */
export function powershellGradleCommand({ versionCode, versionName, javaHome = null, task = 'assembleDebug' }) {
  const args = [
    `-P${GRADLE_VERSION_CODE_PROPERTY}=${versionCode}`,
    `-P${GRADLE_VERSION_NAME_PROPERTY}=${versionName}`
  ];
  if (javaHome) args.push(`-Dorg.gradle.java.home=${javaHome}`);
  return `Set-Location -LiteralPath 'android'; & .\\gradlew.bat --console=plain ${task} `
    + args.map(psQuote).join(' ') + '; exit $LASTEXITCODE';
}

/** node_modules-liitoksen luonti- ja poistokomennot (cmd.exe). */
export function junctionCommands({ worktree, mainRepo }) {
  const link = winPath(path.join(worktree, 'node_modules'));
  const target = winPath(path.join(mainRepo, 'node_modules'));
  return {
    create: `cmd /c mklink /J "${link}" "${target}"`,
    remove: `cmd /c rmdir "${link}"`,
    warning: 'Poista liitos VAIN komennolla rmdir. Rekursiivinen poisto (rm -rf, '
      + 'Remove-Item -Recurse) seuraisi liitosta ja tyhjentäisi pääkopion node_modulesin.'
  };
}

function check(id, ok, detail) {
  return { id, ok: Boolean(ok), detail: String(detail) };
}

/**
 * Esitarkistus.
 *
 * @param {object} options
 * @param {string} options.worktree
 * @param {string} options.wave
 * @param {string} [options.versionCode] '1' | 'commit-epoch' | kokonaisluku
 * @param {string} [options.jdk] --jdk
 * @param {string} [options.sdk] --sdk
 * @param {string} [options.outDir] pakettihakemisto (oletus <pääkopio>/.claude/release-packages)
 * @param {boolean} [options.skipLockCheck]
 * @param {string} options.repoRoot tämän skriptin repo (lukitustiedosto)
 * @param {object} deps
 * @param {(args: string[]) => string} deps.git git työpuussa (merkkijono, trimmattu)
 * @param {(file: string) => boolean} deps.exists
 * @param {(file: string) => string} deps.readFile
 * @param {object} [deps.env]
 * @param {string} [deps.platform]
 */
export function runPreflight(options, deps) {
  const { worktree, repoRoot } = options;
  const wave = String(options.wave || '').trim().toUpperCase();
  const { git, exists, readFile } = deps;
  const env = deps.env || {};
  const platform = deps.platform || process.platform;
  const checks = [];
  const facts = { worktree, wave, repoRoot };
  let stop = null;
  const done = () => ({ ok: !stop && checks.every(c => c.ok), checks, facts, stop });
  const read = rel => readFile(path.join(worktree, rel));
  const tryRead = rel => (exists(path.join(worktree, rel)) ? read(rel) : null);

  checks.push(check('platform', platform === 'win32',
    platform === 'win32' ? 'Windows (PowerShell + gradlew.bat)'
      : `alusta ${platform}: tämä koonti ajaa gradlew.bat:n PowerShellistä`));

  if (!wave || (wave !== 'BASE' && !WAVE_IDS.includes(wave))) {
    checks.push(check('args.wave', false, `--wave puuttuu tai on tuntematon: '${options.wave}' (BASE, ${WAVE_IDS.join(', ')})`));
    return done();
  }

  if (!worktree || !exists(worktree) || !exists(path.join(worktree, '.git'))) {
    checks.push(check('worktree.exists', false, `työpuuta ei löydy tai se ei ole git-työpuu: ${worktree}`));
    return done();
  }
  checks.push(check('worktree.exists', true, worktree));

  let toplevel = null;
  try { toplevel = git(['rev-parse', '--show-toplevel']); } catch (error) {
    checks.push(check('git.toplevel', false, error.message));
    return done();
  }
  checks.push(check('git.toplevel', samePath(toplevel, worktree),
    `git-juuri ${toplevel}` + (samePath(toplevel, worktree) ? '' : ` != ${worktree} (anna työpuun juuri)`)));

  const status = git(['status', '--porcelain', '--untracked-files=all']);
  const dirtyLines = status ? status.split(/\r?\n/).filter(Boolean) : [];
  facts.gitClean = dirtyLines.length === 0;
  checks.push(check('git.clean', facts.gitClean, facts.gitClean ? 'työpuu on puhdas'
    : `työpuussa ${dirtyLines.length} muutosta: ${dirtyLines.slice(0, 8).join(' | ')}`));

  const [head, ct] = git(['log', '-1', '--format=%H %ct']).split(' ');
  facts.head = head;
  facts.committerEpoch = Number(ct);
  facts.branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  try {
    const commonDir = git(['rev-parse', '--path-format=absolute', '--git-common-dir']);
    facts.mainRepo = path.dirname(commonDir);
  } catch { facts.mainRepo = null; }

  // Versio ja aalto: sama puhdas funktio kuin testeissä.
  try {
    const pkgVersion = JSON.parse(read('package.json')).version;
    facts.pkgVersion = pkgVersion;
    facts.version = computeAndroidVersion({
      committerEpoch: facts.committerEpoch, sha: head,
      schemaSource: tryRead('src/data/schema.js') || '', swSource: tryRead('sw.js') || '',
      pkgVersion, expectedWave: wave, versionCode: options.versionCode ?? '1'
    });
    facts.installedVersionName = installedVersionName(facts.version.versionName, 'debug');
    checks.push(check('wave.matrix', true,
      `aalto ${facts.version.wave}, ${facts.version.cacheVersion}; versionCode ${facts.version.versionCode} `
      + `(${facts.version.versionPolicy}); versionName ${facts.installedVersionName}`));
  } catch (error) {
    checks.push(check('wave.matrix', false, error.message));
  }

  // Lukitustiedosto: rakennetaanko juuri lukittua ehdokasta?
  const lockPath = path.join(repoRoot, LOCK_FILE);
  if (options.skipLockCheck) {
    facts.lock = { file: LOCK_FILE, checked: false, reason: '--skip-lock-check' };
    checks.push(check('lock', true, 'OHITETTU (--skip-lock-check); kirjataan metatietoihin'));
  } else if (!exists(lockPath)) {
    facts.lock = { file: LOCK_FILE, checked: false, reason: 'lukitustiedosto puuttuu' };
    checks.push(check('lock', false, `${LOCK_FILE} puuttuu (aja node tools/activation/train-map.mjs --write)`));
  } else {
    const lock = JSON.parse(readFile(lockPath).replace(/^﻿/, ''));
    const entry = (lock.waves || []).find(w => w.wave === wave);
    if (!entry) {
      facts.lock = { file: LOCK_FILE, checked: false, reason: `aaltoa ${wave} ei ole lukitustiedostossa` };
      checks.push(check('lock', wave === 'BASE',
        wave === 'BASE' ? 'BASE ei kuulu junaan (tuotehaaran koonti)' : `aaltoa ${wave} ei ole tiedostossa ${LOCK_FILE}`));
    } else {
      const matches = entry.deployTarget === head;
      facts.lock = { file: LOCK_FILE, checked: true, ref: entry.ref, deployTarget: entry.deployTarget,
        waveCommit: entry.waveCommit || null, consistent: entry.consistent === true, matches };
      checks.push(check('lock', matches && entry.consistent === true, matches
        ? `HEAD = lukittu ${entry.ref} (${entry.deployTarget.slice(0, 7)})`
          + (entry.consistent === true ? '' : '; lukitus ei ole yhtäpitävä (consistent=false)')
        : `HEAD ${head.slice(0, 7)} != lukittu ${entry.deployTarget.slice(0, 7)} (${entry.ref}). Jos ehdokas `
          + 'leikattiin uudelleen: node tools/activation/train-map.mjs --write ja '
          + `npm run activation:verify-wave -- ${wave}`));
    }
  }

  // Gradle-putkitus: ilman sitä -P-arvot ohitetaan hiljaa.
  const buildGradle = tryRead('android/app/build.gradle');
  const plumbing = hasVersionPlumbing(buildGradle);
  checks.push(check('gradle.versionPlumbing', plumbing, plumbing
    ? `android/app/build.gradle lukee ${GRADLE_VERSION_CODE_PROPERTY} ja ${GRADLE_VERSION_NAME_PROPERTY}`
    : 'android/app/build.gradle ei lue versio-ominaisuuksia: cherry-pickaa versiointicommit ehdokkaalle '
      + '(muuttaa kärjen SHA:n → train-map --write ja activation:verify-wave)'));

  // node_modules: Capacitorin gradle-projektit ja CLI.
  const needed = ['node_modules/@capacitor/android/capacitor/build.gradle', 'node_modules/@capacitor/cli/package.json'];
  const missing = needed.filter(rel => !exists(path.join(worktree, rel)));
  if (missing.length) {
    const isMainCheckout = facts.mainRepo && samePath(facts.mainRepo, worktree);
    const commands = isMainCheckout || !facts.mainRepo ? null : junctionCommands({ worktree, mainRepo: facts.mainRepo });
    stop = {
      reason: 'node_modules ei ratkea työpuussa: ' + missing.join(', '),
      commands,
      hint: commands ? null : 'aja npm ci tässä hakemistossa'
    };
    checks.push(check('node_modules', false, stop.reason + (commands ? ` — luo liitos: ${commands.create}` : '')));
  } else {
    const lockJson = tryRead('package-lock.json');
    const lockPackages = lockJson ? (JSON.parse(lockJson).packages || {}) : {};
    const versions = {};
    const mismatches = [];
    for (const name of CAPACITOR_PACKAGES) {
      const installedFile = path.join('node_modules', ...name.split('/'), 'package.json');
      const installed = tryRead(installedFile) ? JSON.parse(tryRead(installedFile)).version : null;
      const locked = lockPackages['node_modules/' + name] ? lockPackages['node_modules/' + name].version : null;
      versions[name] = installed;
      if (installed !== locked) mismatches.push(`${name} ${installed} != lock ${locked}`);
    }
    facts.capacitorVersions = versions;
    checks.push(check('node_modules', mismatches.length === 0, mismatches.length
      ? 'node_modules ei vastaa työpuun package-lock.jsonia: ' + mismatches.join('; ')
      : 'Capacitor ' + CAPACITOR_PACKAGES.map(n => `${n.replace('@capacitor/', '')} ${versions[n]}`).join(', ')));
  }

  // JDK 21.
  const jdk = resolveJdkDir({ override: options.jdk || null, worktree, repoRoot, exists, readFile });
  const javaExe = jdk.dir ? path.join(jdk.dir, 'bin', platform === 'win32' ? 'java.exe' : 'java') : null;
  facts.jdk = { dir: jdk.dir, source: jdk.source,
    // Pinnaamattomalle ehdokkaalle (aallot C–G) JDK annetaan komentorivillä.
    passOnCommandLine: Boolean(jdk.dir) && jdk.source !== 'työpuun android/gradle.properties' };
  const pinnedText = tryRead('android/gradle.properties');
  facts.jdk.pinnedInWorktree = readGradleJavaHome(pinnedText);
  checks.push(check('jdk', Boolean(javaExe) && exists(javaExe), javaExe && exists(javaExe)
    ? `${jdk.dir} (${jdk.source})`
    : `JDK 21 puuttuu (${jdk.source}: ${jdk.dir}). Asenna Temurin 21 tai anna --jdk <hakemisto>; `
      + 'Capacitor 8 kääntää Java 21 -tasolla (VERSION_21)'));

  // Android SDK ja tarkastustyökalut.
  const sdk = resolveSdkDir({ override: options.sdk || null, env, worktree, repoRoot, exists, readFile });
  facts.sdk = { dir: sdk.dir, source: sdk.source };
  if (sdk.dir) {
    const tools = toolPaths({ sdkDir: sdk.dir, jdkDir: jdk.dir });
    const absentTools = [tools.aapt2, tools.apksignerJar].filter(t => !exists(t));
    checks.push(check('sdk', absentTools.length === 0, absentTools.length
      ? `build-tools ${BUILD_TOOLS_VERSION} puuttuu: ${absentTools.join(', ')}`
      : `${sdk.dir} (${sdk.source}); build-tools ${BUILD_TOOLS_VERSION}`));
  } else {
    checks.push(check('sdk', false, 'Android SDK:ta ei löydy: aseta ANDROID_HOME tai anna --sdk <hakemisto>'));
  }

  // Paketin kohde: ei ylikirjoiteta aiempaa pakettia.
  facts.outDir = options.outDir || (facts.mainRepo ? path.join(facts.mainRepo, '.claude', 'release-packages') : null);
  if (facts.version && facts.outDir) {
    facts.packageName = packageFileName({
      wave: facts.version.wave, cacheVersion: facts.version.cacheVersion,
      versionCode: facts.version.versionCode, sha7: facts.version.sha7, buildType: 'debug'
    });
    facts.packagePath = path.join(facts.outDir, facts.packageName);
    const taken = exists(facts.packagePath);
    checks.push(check('package.target', !taken, taken
      ? `${facts.packagePath} on jo olemassa: samaa pakettia ei ylikirjoiteta (poista tai siirrä ensin)`
      : facts.packagePath));
  }

  return done();
}

/**
 * Koontisuunnitelma esitarkistuksen tiedoista. Puhdas: palauttaa askeleet
 * sekä kuivaharjoituksen tulostetta että oikeaa ajoa varten.
 */
export function buildPlan(facts) {
  const worktree = facts.worktree;
  const ps = powershellGradleCommand({
    versionCode: facts.version.versionCode,
    versionName: facts.version.versionName,
    javaHome: facts.jdk && facts.jdk.passOnCommandLine ? facts.jdk.dir : null
  });
  return [
    { id: 'build-web', title: 'Web-koonti dist/', kind: 'shell', cwd: worktree, command: 'npm run build:web' },
    { id: 'cap-sync', title: 'Capacitor: dist/ -> android/', kind: 'shell', cwd: worktree, command: 'npx cap sync android' },
    { id: 'gradle', title: 'Gradle assembleDebug (PowerShell)', kind: 'spawn', cwd: worktree,
      file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps],
      command: `powershell -NoProfile -Command "${ps}"` },
    { id: 'verify', title: 'APK-tarkastus (tools/android/verify.mjs)', kind: 'internal',
      command: `node scripts/verify-apk.mjs --apk ${path.join(worktree, DEBUG_APK_OUTPUT)} --worktree ${worktree} `
        + `--wave ${facts.wave} --expect-code ${facts.version.versionCode} --expect-name ${facts.installedVersionName}` },
    { id: 'restore', title: 'Palauta Capacitorin generoimat gradle-tiedostot', kind: 'internal',
      command: `git -C ${worktree} checkout -- ${GENERATED_GRADLE_FILES.join(' ')}` },
    { id: 'assert-clean', title: 'Työpuu on taas puhdas', kind: 'internal',
      command: `git -C ${worktree} status --porcelain --untracked-files=all  (tyhjä)` },
    { id: 'package', title: 'Paketti + metatiedot (UTF-8 ilman BOMia)', kind: 'internal',
      command: `kopioi ${DEBUG_APK_OUTPUT} -> ${facts.packagePath}; kirjoita ${facts.packagePath}.json` }
  ];
}
