// APK:n tarkastus kokonaisuutena.
//
// `verifyApkContents` on PUHDAS: se saa APK:n tavut, työkalujen tulosteet
// ja vertailupuut, ja palauttaa tarkistuslistan. `collectAndVerify` tekee
// IO:n (aapt2, apksigner, git, tiedostot) ja kutsuu sitä. Sekä
// scripts/verify-apk.mjs että scripts/android-acceptance-build.mjs
// käyttävät samaa polkua, joten koonti ei voi paketoida APK:ta, jota
// erillinen tarkastus ei hyväksyisi.

import fs from 'node:fs';
import path from 'node:path';

import {
  APP_ID, DEFAULT_MIN_SDK, DEFAULT_TARGET_SDK, EXPECTED_SIGNER_CERT_SHA256,
  checkAssets, checkBadging, checkCapacitorConfig, checkCrossSource, checkManifest,
  checkPermissions, checkPlugins, checkSigner, checkWebPayload, manifestFacts,
  parseApksigner, parseBadging, parsePermissionsDump, parseVariablesGradle, parseXmlTree
} from './apk.mjs';
import { makeGit, makeToolRunners, readGitWebTree, readTree, sha256Hex } from './toolchain.mjs';
import { commitEpochVersionCode, computeAndroidVersion, installedVersionName } from './version.mjs';
import { readZip } from './zip.mjs';

const PUBLIC_PREFIX = 'assets/public/';

/** APK:n assets/public/** Mapiksi sekä Capacitorin JSON-tiedostot. */
export function readApkAssets(apkBytes) {
  const zip = readZip(apkBytes);
  const publicFiles = new Map();
  for (const [name, entry] of zip) {
    if (name.startsWith(PUBLIC_PREFIX) && !name.endsWith('/')) {
      publicFiles.set(name.slice(PUBLIC_PREFIX.length), entry.read());
    }
  }
  const text = name => (zip.has(name) ? zip.get(name).read().toString('utf8') : null);
  return {
    publicFiles: new Map([...publicFiles.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    pluginsJson: text('assets/capacitor.plugins.json'),
    configJson: text('assets/capacitor.config.json'),
    entryCount: zip.size
  };
}

/**
 * @param {object} input
 * @param {Buffer} input.apkBytes
 * @param {string} input.wave
 * @param {{ badging: string, permissions: string, xmltree: string, apksigner: string }} input.outputs
 * @param {object} [input.expect] { versionCode, versionName, certSha256, sha256, minSdk, targetSdk }
 * @param {Map<string, Buffer>|null} [input.dist]
 * @param {Map<string, Buffer>|null} [input.git]
 * @param {string|null} [input.repoCapacitorConfig]
 */
export function verifyApkContents({
  apkBytes, wave, appId = APP_ID, buildType = 'debug', expect = {}, outputs,
  dist = null, git = null, repoCapacitorConfig = null
}) {
  const checks = [];
  const sha256 = sha256Hex(apkBytes);
  if (expect.sha256) {
    const expected = String(expect.sha256).toLowerCase();
    checks.push({ id: 'apk.sha256', ok: sha256 === expected, detail: `sha256 ${sha256} (odotettu ${expected})` });
  }

  const badging = parseBadging(outputs.badging);
  checks.push(...checkBadging(badging, {
    appId, buildType,
    versionCode: expect.versionCode ?? null,
    versionName: expect.versionName ?? null,
    minSdk: expect.minSdk ?? DEFAULT_MIN_SDK,
    targetSdk: expect.targetSdk ?? DEFAULT_TARGET_SDK
  }));

  const permissions = parsePermissionsDump(outputs.permissions);
  checks.push(...checkPermissions(permissions, { appId }));

  const manifest = manifestFacts(parseXmlTree(outputs.xmltree));
  checks.push(...checkManifest(manifest, { appId, buildType }));
  checks.push(...checkCrossSource({ badging, facts: manifest }));

  const signer = parseApksigner(outputs.apksigner);
  checks.push(...checkSigner(signer, { expectedCert: expect.certSha256 ?? EXPECTED_SIGNER_CERT_SHA256 }));

  let assets = null;
  try {
    assets = readApkAssets(apkBytes);
  } catch (error) {
    checks.push({ id: 'apk.zip', ok: false, detail: 'APK:ta ei voitu lukea ZIPinä: ' + error.message });
  }
  if (assets) {
    checks.push(...checkPlugins(assets.pluginsJson));
    if (repoCapacitorConfig !== null) checks.push(...checkCapacitorConfig(assets.configJson, repoCapacitorConfig));
    checks.push(...checkAssets({ apk: assets.publicFiles, dist, git }));
    checks.push(...checkWebPayload(assets.publicFiles, { wave }));
  }

  return {
    passed: checks.length > 0 && checks.every(c => c.ok),
    checks,
    facts: {
      sha256,
      bytes: apkBytes.length,
      badging,
      permissions,
      manifest,
      signer: { verifies: signer.verifies, schemes: signer.schemes, signerCount: signer.signerCount,
        certSha256: signer.signers[0] ? signer.signers[0].certSha256 : null,
        dn: signer.signers[0] ? signer.signers[0].dn : null },
      publicFileCount: assets ? assets.publicFiles.size : null
    }
  };
}

/**
 * Aja työkalut ja tarkasta APK työpuuta vasten.
 *
 * @param {object} options
 * @param {string} options.apkPath
 * @param {string} options.worktree työpuu, josta APK rakennettiin (dist/ ja git)
 * @param {string} options.wave
 * @param {string} options.sdkDir
 * @param {string} options.jdkDir
 * @param {string} [options.commit] vertailtava commit (oletus HEAD)
 * @param {object} [options.expect] ks. verifyApkContents; puuttuvat johdetaan työpuusta
 * @param {boolean} [options.requireDist] kaada, jos dist/ puuttuu (oletus true)
 * @param {Function} [options.spawn]
 */
export function collectAndVerify({
  apkPath, worktree, wave, sdkDir, jdkDir, commit = null, expect = {},
  buildType = 'debug', requireDist = true, spawn, fsImpl = fs
}) {
  const git = makeGit(worktree, spawn);
  const tools = makeToolRunners({ sdkDir, jdkDir, spawn });
  const apkBytes = fsImpl.readFileSync(apkPath);

  const head = git(['rev-parse', commit || 'HEAD']).toString('utf8').trim();
  const show = file => git(['show', `${head}:${file}`]).toString('utf8');

  // Odotettu versionName ja sallitut versionCodet commitista (ei työpuusta:
  // koonnin aikana Capacitor on muuttanut generoituja gradle-tiedostoja).
  const committerEpoch = Number(git(['log', '-1', '--format=%ct', head]).toString('utf8').trim());
  const pkgVersion = JSON.parse(show('package.json')).version;
  const version = computeAndroidVersion({
    committerEpoch, sha: head, schemaSource: show('src/data/schema.js'), swSource: show('sw.js'),
    pkgVersion, expectedWave: wave
  });
  let epochCode = null;
  try { epochCode = commitEpochVersionCode(committerEpoch); } catch { epochCode = null; }

  const sdk = parseVariablesGradle(show('android/variables.gradle'));
  const distDir = path.join(worktree, 'dist');
  const dist = fsImpl.existsSync(distDir) ? readTree(distDir, { fsImpl }) : null;

  const outputs = {
    badging: tools.aapt2(['dump', 'badging', apkPath]),
    permissions: tools.aapt2(['dump', 'permissions', apkPath]),
    xmltree: tools.aapt2(['dump', 'xmltree', '--file', 'AndroidManifest.xml', apkPath]),
    apksigner: tools.apksigner(['verify', '--print-certs', '-v', apkPath])
  };

  const result = verifyApkContents({
    apkBytes, wave, buildType, outputs,
    expect: {
      sha256: expect.sha256 ?? null,
      versionCode: expect.versionCode ?? [1, epochCode].filter(v => v !== null),
      versionName: expect.versionName ?? installedVersionName(version.versionName, buildType),
      certSha256: expect.certSha256 ?? EXPECTED_SIGNER_CERT_SHA256,
      minSdk: sdk.minSdk ?? DEFAULT_MIN_SDK,
      targetSdk: sdk.targetSdk ?? DEFAULT_TARGET_SDK
    },
    dist,
    git: readGitWebTree(git, head),
    repoCapacitorConfig: show('capacitor.config.json')
  });

  if (!dist && requireDist) {
    result.checks.push({ id: 'assets.dist', ok: false,
      detail: `${distDir} puuttuu: aja npm run build:web samasta commitista (tai --no-dist)` });
    result.passed = false;
  }

  result.facts.commit = head;
  result.facts.committerEpoch = committerEpoch;
  result.facts.expectedVersion = version;
  result.facts.toolOutputs = outputs;
  result.facts.toolPaths = tools.paths;
  return result;
}

/** Tarkistuslista ihmisluettavaksi. */
export function formatChecks(checks) {
  return checks.map(c => `    ${c.ok ? 'PASS' : 'FAIL'}  ${c.id.padEnd(32)}${c.detail}`).join('\n');
}
