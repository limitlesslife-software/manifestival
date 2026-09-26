// Rakennetun APK:n tarkastus: onko tämä täsmälleen se sovellus, jonka
// väitämme rakentaneemme?
//
//   node scripts/verify-apk.mjs --apk <tiedosto.apk> --worktree <hakemisto> --wave <X>
//       [--meta <tiedosto.apk.json>] [--expect-code N] [--expect-name S]
//       [--expect-cert SHA256] [--commit <sha>] [--build-type debug|release]
//       [--sdk <hakemisto>] [--jdk <hakemisto>] [--no-dist] [--json]
//
// MIKSI TÄMÄ ON OLEMASSA
//
// tests/android.test.mjs tarkistaa LÄHDETIEDOSTOT (oma manifesti,
// asetukset). APK on eri asia: kirjastojen manifestit yhdistyvät siihen,
// Capacitor kopioi assetit, Gradle leimaa version ja allekirjoittaa.
// Ennen tätä mikään ei tarkistanut valmista APK:ta automaattisesti.
//
// MITÄ TARKISTETAAN (ks. tools/android/apk.mjs)
//
//   1. SHA-256 = metatietojen arvo (--meta)
//   2. aapt2 dump badging: paketti tasan fi.limitlesslife.manifestival
//      (ei päätettä), versionCode ja versionName odotetut, minSdk/targetSdk
//      android/variables.gradle:n mukaiset, debuggable vain debugissa
//   3. aapt2 dump permissions: TÄSMÄLLEEN sallittu joukko
//      (APK_PERMISSION_ALLOWLIST), ei yhtään kiellettyä
//   4. aapt2 dump xmltree: allowBackup=false, usesCleartextTraffic=false,
//      avoimina vain MainActivity ja DUMP-suojattu ProfileInstallReceiver,
//      <queries> sisältää android.speech.RecognitionService
//   5. apksigner: Verifies, v2, yksi allekirjoittaja, odotettu varmenne
//   6. assetit: capacitor.plugins.json = app, geolocation,
//      local-notifications; capacitor.config.json = repon;
//      assets/public tavu tavulta = dist/, ja = commitin git-blobit
//      CR-normalisoituna; sw.js ja schema.js vastaavat aaltoa; ei
//      testejä/dokumentteja/salaisuuksia
//
// Ei verkkoa, ei kirjoituksia. Ajaa aapt2.exe:n ja JDK 21:n java.exe:n
// (apksigner.jar) sekä lukevia git-komentoja.
//
// PALUUARVO: 0 = kaikki läpi, 1 = jokin tarkistus kaatui, 2 = käyttövirhe

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { REPO_ROOT, isMain, parseCliArgs, rejectPositional } from '../tools/android/cli.mjs';
import { resolveJdkDir, resolveSdkDir } from '../tools/android/toolchain.mjs';
import { collectAndVerify, formatChecks } from '../tools/android/verify.mjs';

export {
  APK_PERMISSION_ALLOWLIST, APK_FORBIDDEN_PERMISSIONS, EXPECTED_CAPACITOR_PLUGINS,
  EXPECTED_SIGNER_CERT_SHA256, REQUIRED_QUERY_INTENT_ACTIONS
} from '../tools/android/apk.mjs';

const NEWLINE = String.fromCharCode(10);
const out = text => process.stdout.write(text + NEWLINE);

/** Metatieto-JSON; sietää vanhan, BOMilla alkavan tiedoston. */
export function readMetadataFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
}

/** Komentorivin liput (vain `--lippu` tai `--lippu=true`; `--no-dist=false` on käyttövirhe). */
export const FLAGS = Object.freeze(['no-dist', 'json', 'help']);

function main(argv) {
  let options;
  try {
    let positional;
    ({ options, positional } = parseCliArgs(argv, FLAGS));
    rejectPositional(positional);
  } catch (error) {
    out('  ' + error.message);
    return 2;
  }
  if (options.help || !options.apk || !options.worktree || !options.wave) {
    out('  Käyttö: node scripts/verify-apk.mjs --apk <apk> --worktree <hakemisto> --wave <X>');
    out('          [--meta <apk.json>] [--expect-code N] [--expect-name S] [--expect-cert SHA256]');
    out('          [--commit <sha>] [--build-type debug|release] [--sdk <dir>] [--jdk <dir>] [--no-dist] [--json]');
    return options.help ? 0 : 2;
  }

  const apkPath = path.resolve(options.apk);
  const worktree = path.resolve(options.worktree);
  const wave = String(options.wave).trim().toUpperCase();
  if (!fs.existsSync(apkPath)) { out(`  APK:ta ei löydy: ${apkPath}`); return 2; }

  const metaPath = options.meta ? path.resolve(options.meta)
    : (fs.existsSync(apkPath + '.json') ? apkPath + '.json' : null);
  const meta = metaPath ? readMetadataFile(metaPath) : null;
  if (meta && meta.wave && meta.wave !== wave) {
    out(`  Metatiedot sanovat aalto ${meta.wave}, pyydetty ${wave}`);
    return 2;
  }

  const sdk = resolveSdkDir({ override: options.sdk, worktree, repoRoot: REPO_ROOT });
  const jdk = resolveJdkDir({ override: options.jdk, worktree, repoRoot: REPO_ROOT });
  if (!sdk.dir) { out(`  Android SDK:ta ei löydy (${sdk.source}); anna --sdk <hakemisto>`); return 2; }
  if (!jdk.dir || !fs.existsSync(jdk.dir)) {
    out(`  JDK 21:tä ei löydy (${jdk.source}: ${jdk.dir}); anna --jdk <hakemisto>`);
    return 2;
  }

  const expect = {
    sha256: meta ? meta.sha256 : null,
    versionCode: options['expect-code'] !== undefined ? Number(options['expect-code'])
      : (meta && Number.isInteger(meta.versionCode) ? meta.versionCode : undefined),
    versionName: options['expect-name'] ?? (meta && meta.schema ? meta.versionName : undefined),
    certSha256: options['expect-cert'] ?? (meta && meta.signerCertSha256 ? meta.signerCertSha256 : undefined)
  };

  const result = collectAndVerify({
    apkPath, worktree, wave,
    sdkDir: sdk.dir, jdkDir: jdk.dir,
    commit: options.commit || (meta ? meta.gitCommit : null),
    buildType: options['build-type'] || (meta && meta.buildType) || 'debug',
    requireDist: !options['no-dist'],
    expect
  });

  if (options.json) {
    const { toolOutputs, ...facts } = result.facts;
    out(JSON.stringify({ passed: result.passed, checks: result.checks, facts }, null, 2));
    return result.passed ? 0 : 1;
  }

  out('');
  out('  APK-TARKASTUS');
  out('');
  out(`  APK:       ${apkPath}`);
  out(`  SHA-256:   ${result.facts.sha256}`);
  out(`  Työpuu:    ${worktree} @ ${result.facts.commit.slice(0, 7)}`);
  out(`  Aalto:     ${wave}`);
  out(`  Odotettu:  ${result.facts.expectedVersion.versionName} (+ koontityypin pääte)`);
  out(`  SDK:       ${sdk.dir} (${sdk.source})`);
  out(`  JDK:       ${jdk.dir} (${jdk.source})`);
  if (metaPath) out(`  Metatiedot: ${metaPath}${meta && !meta.schema ? '  (vanha käsin tehty muoto)' : ''}`);
  out('');
  out(formatChecks(result.checks));
  out('');
  const failed = result.checks.filter(c => !c.ok);
  out(failed.length === 0
    ? `  APK: PASS (${result.checks.length} tarkistusta)`
    : `  APK: FAIL (${failed.length}/${result.checks.length} tarkistusta kaatui)`);
  out('');
  return failed.length === 0 ? 0 : 1;
}

if (isMain(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    out('  VIRHE: ' + (error && error.message ? error.message : String(error)));
    process.exitCode = 2;
  }
}
