// Toistettava Android-hyväksyntäkoonti ehdokastyöpuusta.
//
//   npm run android:acceptance -- --worktree .claude/worktrees/rc-j --wave J --dry-run
//   npm run android:acceptance -- --worktree .claude/worktrees/rc-j --wave J
//       [--version-code=1|commit-epoch|<N>] [--jdk <dir>] [--sdk <dir>]
//       [--out-dir <dir>] [--skip-lock-check]
//
// MIKSI TÄMÄ ON OLEMASSA
//
// Aallon J ensimmäinen APK paketoitiin käsin: node_modules-liitos
// työpuuhun (dokumentoimatta), Gradle PowerShellistä, kopio ja uudelleen-
// nimeäminen, JSON PowerShellillä (BOM, ei-ISO-aikaleima, isot
// kirjaimet SHA:ssa), generoidut gradle-tiedostot palautettiin
// muistinvaraisesti. Tämä skripti tekee saman aina samalla tavalla ja
// kieltäytyy, jos jokin lähtöehto ei täyty.
//
// ASKELEET (docs/activation/ANDROID-ACCEPTANCE-BUILD.md)
//
//   0. Esitarkistus: puhdas työpuu, --wave = porttimatriisi = välimuisti,
//      HEAD = lukittu ehdokas (docs/activation/release-train-c-j.json),
//      versioputkitus build.gradlessa, node_modules ratkeaa (muuten
//      TULOSTETAAN liitoskomento ja pysähdytään), JDK 21 ja SDK löytyvät,
//      pakettinimi on vapaa.
//   1. npm run build:web
//   2. npx cap sync android
//   3. gradlew.bat assembleDebug -Pmanifestival.versionCode=… -Pmanifestival.versionName=…
//      PowerShellistä
//   4. APK-tarkastus (sama kuin scripts/verify-apk.mjs); kaatuu -> ei pakettia
//   5. android/capacitor.settings.gradle ja android/app/capacitor.build.gradle
//      palautetaan, työpuun on oltava taas puhdas
//   6. kopio .claude/release-packages/manifestival-suunta-wave<X>-<v>-vc<N>-<sha7>-debug.apk
//      + .json (UTF-8 ilman BOMia)
//
// --dry-run ajaa VAIN esitarkistuksen ja tulostaa suunnitelman.
//
// versionCode: oletus 1 (nykyinen käytös). `--version-code=commit-epoch`
// on suositus, mutta sen käyttöönotto on OMISTAJAN TUOTEPÄÄTÖS (OWNER
// PRODUCT DECISION): laitteeseen asennettu suurempi versionCode estää
// vanhemman APK:n asentamisen päälle.
//
// Ei verkkoa (paitsi mitä npm/Gradle omista välimuisteistaan tekevät),
// ei deployta, ei pushia, ei tuotantoon koskemista.
//
// PALUUARVO: 0 = valmis (tai kuivaharjoituksen esitarkistus läpi),
// 1 = esitarkistus tai koonti kaatui, 2 = käyttövirhe

import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { APP_ID, EXPECTED_SIGNER_CERT_SHA256 } from '../tools/android/apk.mjs';
import { REPO_ROOT, isMain, parseCliArgs } from '../tools/android/cli.mjs';
import { buildPackageMetadata, serializeMetadata } from '../tools/android/package.mjs';
import {
  DEBUG_APK_OUTPUT, GENERATED_GRADLE_FILES, buildPlan, runPreflight
} from '../tools/android/preflight.mjs';
import {
  BUILD_TOOLS_VERSION, defaultSpawn, makeToolRunners, readAgpVersion, readGradleVersion,
  readTree, sha256Hex, treeDigest
} from '../tools/android/toolchain.mjs';
import { collectAndVerify, formatChecks } from '../tools/android/verify.mjs';

const NEWLINE = String.fromCharCode(10);
const out = text => process.stdout.write(text + NEWLINE);

/** Lukeva git-ajaja preflightille (merkkijono, trimmattu). */
function gitIn(worktree) {
  return args => {
    const result = spawnSync('git', ['-C', worktree, '--no-optional-locks', ...args], { encoding: 'utf8', windowsHide: true });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${String(result.stderr).trim()}`);
    return String(result.stdout).trim();
  };
}

function printPreflight(pre) {
  out('');
  out('  ESITARKISTUS');
  out('');
  out(formatChecks(pre.checks));
  out('');
  if (pre.stop) {
    out('  PYSÄHDYTTY: ' + pre.stop.reason);
    if (pre.stop.commands) {
      out('');
      out('  Luo node_modules-liitos itse (skripti ei luo sitä):');
      out('    ' + pre.stop.commands.create);
      out('  Poista koonnin jälkeen:');
      out('    ' + pre.stop.commands.remove);
      out('  ' + pre.stop.commands.warning);
    } else if (pre.stop.hint) {
      out('  ' + pre.stop.hint);
    }
    out('');
  }
}

function printPlan(plan) {
  out('  SUUNNITELMA');
  out('');
  plan.forEach((step, index) => {
    out(`    ${index + 1}. ${step.title}`);
    out(`       ${step.command}`);
  });
  out('');
}

function firstLine(text) {
  return String(text || '').split(/\r?\n/).map(l => l.trim()).find(Boolean) || null;
}

function toolchainVersions({ worktree, facts, tools }) {
  const read = rel => {
    const file = path.join(worktree, rel);
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  };
  const safe = fn => { try { return fn(); } catch { return null; } };
  const java = safe(() => {
    const r = defaultSpawn(tools.paths.java, ['-version']);
    return firstLine(r.stderr) || firstLine(r.stdout);
  });
  const aapt2 = safe(() => {
    const r = defaultSpawn(tools.paths.aapt2, ['version']);
    return firstLine(r.stderr) || firstLine(r.stdout);
  });
  const apksigner = safe(() => firstLine(tools.apksigner(['--version'])));
  const npm = safe(() => firstLine(execSync('npm --version', { cwd: worktree, encoding: 'utf8' })));
  return {
    node: process.version,
    npm,
    jdk: java,
    jdkHome: facts.jdk.dir,
    gradle: readGradleVersion(read('android/gradle/wrapper/gradle-wrapper.properties')),
    agp: readAgpVersion(read('android/build.gradle')),
    buildTools: BUILD_TOOLS_VERSION,
    aapt2,
    apksigner,
    capacitor: facts.capacitorVersions || {}
  };
}

function restoreGenerated(worktree) {
  const git = gitIn(worktree);
  git(['checkout', '--', ...GENERATED_GRADLE_FILES]);
  const status = git(['status', '--porcelain', '--untracked-files=all']);
  return { clean: status === '', status };
}

function main(argv) {
  let options;
  try {
    ({ options } = parseCliArgs(argv, ['dry-run', 'skip-lock-check', 'help']));
  } catch (error) {
    out('  ' + error.message);
    return 2;
  }
  if (options.help || !options.worktree || !options.wave) {
    out('  Käyttö: npm run android:acceptance -- --worktree <hakemisto> --wave <X> [--dry-run]');
    out('          [--version-code=1|commit-epoch|<N>] [--jdk <dir>] [--sdk <dir>] [--out-dir <dir>] [--skip-lock-check]');
    return options.help ? 0 : 2;
  }

  // Suhteellinen polku siitä hakemistosta, jossa komento kirjoitettiin
  // (npm run vaihtaa cwd:n paketin juureen ja jättää alkuperäisen INIT_CWD:hen).
  const worktree = path.resolve(process.env.INIT_CWD || process.cwd(), options.worktree);
  const pre = runPreflight({
    worktree, wave: options.wave, versionCode: options['version-code'] ?? '1',
    jdk: options.jdk, sdk: options.sdk, outDir: options['out-dir'] ? path.resolve(options['out-dir']) : null,
    skipLockCheck: Boolean(options['skip-lock-check']), repoRoot: REPO_ROOT
  }, {
    git: gitIn(worktree),
    exists: fs.existsSync,
    readFile: file => fs.readFileSync(file, 'utf8'),
    env: process.env,
    platform: process.platform
  });

  out('');
  out('  ANDROID-HYVÄKSYNTÄKOONTI' + (options['dry-run'] ? '  (KUIVAHARJOITUS)' : ''));
  out('');
  out(`  Työpuu:  ${worktree}`);
  if (pre.facts.head) out(`  Commit:  ${pre.facts.head} (${pre.facts.branch})`);
  out(`  Aalto:   ${pre.facts.wave}`);
  if (pre.facts.version) {
    out(`  Versio:  versionCode ${pre.facts.version.versionCode} (${pre.facts.version.versionPolicy}), `
      + `versionName ${pre.facts.installedVersionName}`);
  }
  printPreflight(pre);

  if (pre.facts.version && pre.facts.packagePath) printPlan(buildPlan(pre.facts));

  if (!pre.ok) {
    out(`  ESITARKISTUS: FAIL (${pre.checks.filter(c => !c.ok).length} kaatui)`
      + (options['dry-run'] ? ' — koonti pysähtyisi tähän' : ' — mitään ei ajettu'));
    out('');
    return 1;
  }
  if (options['dry-run']) {
    out('  ESITARKISTUS: PASS — kuivaharjoitus, mitään ei ajettu');
    out('');
    return 0;
  }

  const plan = buildPlan(pre.facts);
  const step = id => plan.find(s => s.id === id);
  let restored = false;
  try {
    for (const id of ['build-web', 'cap-sync']) {
      out(`  >> ${step(id).title}: ${step(id).command}`);
      execSync(step(id).command, { cwd: worktree, stdio: 'inherit' });
    }
    const dist = treeDigest(readTree(path.join(worktree, 'dist')));

    const gradle = step('gradle');
    out(`  >> ${gradle.title}`);
    const result = spawnSync(gradle.file, gradle.args, { cwd: worktree, stdio: 'inherit', windowsHide: true });
    if (result.status !== 0) throw new Error(`Gradle päättyi koodiin ${result.status}`);

    const apkPath = path.join(worktree, DEBUG_APK_OUTPUT);
    out(`  >> APK-tarkastus: ${apkPath}`);
    const verification = collectAndVerify({
      apkPath, worktree, wave: pre.facts.wave, sdkDir: pre.facts.sdk.dir, jdkDir: pre.facts.jdk.dir,
      commit: pre.facts.head, buildType: 'debug',
      expect: {
        versionCode: pre.facts.version.versionCode,
        versionName: pre.facts.installedVersionName,
        certSha256: EXPECTED_SIGNER_CERT_SHA256
      }
    });
    out(formatChecks(verification.checks));
    if (!verification.passed) throw new Error('APK-tarkastus kaatui: pakettia ei tehty');

    out('  >> Palautetaan generoidut gradle-tiedostot');
    const after = restoreGenerated(worktree);
    restored = true;
    if (!after.clean) throw new Error('työpuu ei ole puhdas palautuksen jälkeen: ' + after.status);

    const tools = makeToolRunners({ sdkDir: pre.facts.sdk.dir, jdkDir: pre.facts.jdk.dir });
    const bytes = fs.readFileSync(apkPath);
    const { badging, signer } = verification.facts;
    const meta = buildPackageMetadata({
      file: pre.facts.packageName,
      bytes: bytes.length,
      sha256: sha256Hex(bytes),
      applicationId: APP_ID,
      buildType: 'debug',
      wave: pre.facts.version.wave,
      cacheVersion: pre.facts.version.cacheVersion,
      gitCommit: pre.facts.head,
      sha7: pre.facts.version.sha7,
      branch: pre.facts.branch,
      commitEpochSeconds: pre.facts.committerEpoch,
      versionCode: pre.facts.version.versionCode,
      versionName: pre.facts.installedVersionName,
      versionPolicy: pre.facts.version.versionPolicy,
      gitClean: pre.facts.gitClean,
      gitCleanAfterBuild: after.clean,
      signerCertSha256: signer.certSha256,
      signerDn: signer.dn,
      minSdk: badging.minSdk,
      targetSdk: badging.targetSdk,
      toolchain: toolchainVersions({ worktree, facts: pre.facts, tools }),
      dist: { fileCount: dist.fileCount, treeSha256: dist.sha256 },
      aapt: {
        packageName: badging.packageName,
        versionCode: badging.versionCode,
        versionName: badging.versionName,
        minSdk: badging.minSdk,
        targetSdk: badging.targetSdk,
        debuggable: badging.debuggable,
        permissions: [...badging.permissions].sort()
      },
      verify: { passed: verification.passed, checks: verification.checks.length,
        failed: verification.checks.filter(c => !c.ok).map(c => c.id) },
      lock: pre.facts.lock,
      builtAt: new Date().toISOString()
    });

    fs.mkdirSync(pre.facts.outDir, { recursive: true });
    fs.copyFileSync(apkPath, pre.facts.packagePath);
    fs.writeFileSync(pre.facts.packagePath + '.json', serializeMetadata(meta));
    out('');
    out(`  VALMIS: ${pre.facts.packagePath}`);
    out(`          sha256 ${meta.sha256}`);
    out(`          versionCode ${meta.versionCode}, versionName ${meta.versionName}`);
    out('  Muista poistaa node_modules-liitos: cmd /c rmdir "<työpuu>\\node_modules"');
    out('');
    return 0;
  } catch (error) {
    out('');
    out('  KOONTI KAATUI: ' + error.message);
    out('');
    return 1;
  } finally {
    if (!restored) {
      try {
        const after = restoreGenerated(worktree);
        out(`  Generoidut gradle-tiedostot palautettu; työpuu ${after.clean ? 'puhdas' : 'EI puhdas: ' + after.status}`);
      } catch (error) {
        out('  Palautus epäonnistui: ' + error.message
          + ` — aja: git -C ${worktree} checkout -- ${GENERATED_GRADLE_FILES.join(' ')}`);
      }
    }
  }
}

if (isMain(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    out('  VIRHE: ' + (error && error.message ? error.message : String(error)));
    process.exitCode = 2;
  }
}
