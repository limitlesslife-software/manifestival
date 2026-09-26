// Hyväksyntä-APK:n paketointi: tiedostonimi ja metatieto-JSON.
//
// Aiempi, käsin tehty paketti (aalto J, 5df40b2) jätti jälkeensä JSONin,
// jota Node ei osannut lukea: tiedosto alkoi BOM-merkillä (PowerShellin
// oletus), aikaleima oli muotoa `2026-09-25T00.07.56Z` (Date.parse = NaN),
// SHA-256 oli isoilla kirjaimilla, eikä mukana ollut allekirjoittajaa,
// puhtaan työpuun tietoa, versiokäytäntöä eikä työkaluversioita.
//
// Tämä moduuli tekee metatiedot PUHTAASTI: sama syöte, samat tavut
// (paitsi builtAt, jonka kutsuja antaa). Kirjoitus tehdään
// fs.writeFileSync:llä Bufferista, joten BOMia ei voi syntyä.

import { VERSION_CODE_MAX, VERSION_CODE_MIN, VERSION_POLICY } from './version.mjs';

/** Metatietojen skeematunniste. Nosta, jos kenttien merkitys muuttuu. */
export const METADATA_SCHEMA = 'manifestival-android-package/1';

/** Kentät, jotka jokaisessa paketin JSONissa on oltava. */
export const REQUIRED_METADATA_KEYS = Object.freeze([
  'schema', 'file', 'bytes', 'sha256', 'applicationId', 'buildType',
  'wave', 'cacheVersion', 'gitCommit', 'sha7', 'branch', 'commitEpochSeconds',
  'versionCode', 'versionName', 'versionPolicy', 'versionPolicyStatus',
  'gitClean', 'gitCleanAfterBuild', 'signerCertSha256', 'signerDn',
  'minSdk', 'targetSdk', 'toolchain', 'dist', 'aapt', 'verify', 'lock',
  'builtAt', 'status'
]);

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const HEX64 = /^[0-9a-f]{64}$/;
const WAVE_ID = /^(BASE|[A-Z])$/;
const CACHE = /^v\d+$/;
const SHA7 = /^[0-9a-f]{7}$/;

/**
 * Paketin tiedostonimi:
 * `manifestival-suunta-wave<X>-<välimuisti>-vc<versionCode>-<sha7>-<tyyppi>.apk`
 */
export function packageFileName({ wave, cacheVersion, versionCode, sha7, buildType = 'debug' }) {
  if (!WAVE_ID.test(String(wave))) throw new Error(`aalto ei kelpaa tiedostonimeen: ${wave}`);
  if (!CACHE.test(String(cacheVersion))) throw new Error(`välimuistiversio ei kelpaa: ${cacheVersion}`);
  if (!Number.isInteger(versionCode) || versionCode < VERSION_CODE_MIN || versionCode > VERSION_CODE_MAX) {
    throw new Error(`versionCode ei kelpaa: ${versionCode}`);
  }
  if (!SHA7.test(String(sha7))) throw new Error(`sha7 ei kelpaa: ${sha7}`);
  if (!['debug', 'release'].includes(buildType)) throw new Error(`koontityyppi ei kelpaa: ${buildType}`);
  return `manifestival-suunta-wave${wave}-${cacheVersion}-vc${versionCode}-${sha7}-${buildType}.apk`;
}

/** Tiedostonimestä takaisin osiin (null, jos nimi ei ole tätä muotoa). */
export function parsePackageFileName(name) {
  const m = /^manifestival-suunta-wave(BASE|[A-Z])-(v\d+)-vc(\d+)-([0-9a-f]{7})-(debug|release)\.apk$/.exec(String(name));
  if (!m) return null;
  return { wave: m[1], cacheVersion: m[2], versionCode: Number(m[3]), sha7: m[4], buildType: m[5] };
}

/** versionCode-käytännön tila metatietoihin. */
export function versionPolicyStatus(policy) {
  return policy === VERSION_POLICY.FIXED
    ? 'OWNER_PRODUCT_DECISION_PENDING: versionCode pidetty arvossa 1 (nykyinen käytös)'
    : 'OWNER_PRODUCT_DECISION_APPLIED: versionCode > 1 on yksisuuntainen ovi laitteella';
}

/**
 * Metatieto-objekti. Tarkistaa muodon ja normalisoi SHA-256:t pieniksi
 * kirjaimiksi; kaatuu, jos jokin pakollinen tieto puuttuu tai on väärin.
 */
export function buildPackageMetadata(input) {
  const meta = {
    schema: METADATA_SCHEMA,
    file: input.file,
    bytes: input.bytes,
    sha256: String(input.sha256 || '').toLowerCase(),
    applicationId: input.applicationId,
    buildType: input.buildType || 'debug',
    wave: input.wave,
    cacheVersion: input.cacheVersion,
    gitCommit: input.gitCommit,
    sha7: input.sha7,
    branch: input.branch ?? null,
    commitEpochSeconds: input.commitEpochSeconds,
    versionCode: input.versionCode,
    versionName: input.versionName,
    versionPolicy: input.versionPolicy,
    versionPolicyStatus: versionPolicyStatus(input.versionPolicy),
    gitClean: input.gitClean,
    gitCleanAfterBuild: input.gitCleanAfterBuild,
    signerCertSha256: String(input.signerCertSha256 || '').toLowerCase(),
    signerDn: input.signerDn ?? null,
    minSdk: input.minSdk,
    targetSdk: input.targetSdk,
    toolchain: input.toolchain || {},
    dist: input.dist,
    aapt: input.aapt,
    verify: input.verify,
    lock: input.lock ?? null,
    builtAt: input.builtAt,
    status: input.status
      || 'EI HYVÄKSYTTY LAITTEELLA. Asenna vasta, kun aallon migraatio on todennettu ja aalto on deployattu webiin.'
  };

  const problems = [];
  const expectedName = (() => {
    try {
      return packageFileName({ wave: meta.wave, cacheVersion: meta.cacheVersion,
        versionCode: meta.versionCode, sha7: meta.sha7, buildType: meta.buildType });
    } catch (error) { problems.push(error.message); return null; }
  })();
  if (expectedName && meta.file !== expectedName) problems.push(`file ${meta.file} != ${expectedName}`);
  if (!Number.isInteger(meta.bytes) || meta.bytes <= 0) problems.push('bytes puuttuu');
  if (!HEX64.test(meta.sha256)) problems.push('sha256 ei ole 64 heksamerkkiä');
  if (!HEX64.test(meta.signerCertSha256)) problems.push('signerCertSha256 ei ole 64 heksamerkkiä');
  if (!/^[0-9a-f]{40}$/.test(String(meta.gitCommit))) problems.push('gitCommit ei ole täysi SHA');
  if (String(meta.gitCommit).slice(0, 7) !== meta.sha7) problems.push('sha7 ei vastaa gitCommitia');
  if (!Number.isInteger(meta.commitEpochSeconds)) problems.push('commitEpochSeconds puuttuu');
  if (!Object.values(VERSION_POLICY).includes(meta.versionPolicy)) problems.push(`versionPolicy ${meta.versionPolicy}`);
  if (typeof meta.versionName !== 'string' || !meta.versionName.includes(`+${meta.sha7}`)) {
    problems.push('versionName ei sisällä commitin sha7:ää');
  }
  if (meta.gitClean !== true) problems.push('gitClean ei ole true: paketti vain puhtaasta puusta');
  if (typeof meta.gitCleanAfterBuild !== 'boolean') problems.push('gitCleanAfterBuild puuttuu');
  if (!ISO_UTC.test(String(meta.builtAt)) || Number.isNaN(Date.parse(meta.builtAt))) {
    problems.push(`builtAt ei ole ISO-8601 UTC: ${meta.builtAt}`);
  }
  if (!meta.dist || !Number.isInteger(meta.dist.fileCount) || !HEX64.test(String(meta.dist.treeSha256))) {
    problems.push('dist.fileCount / dist.treeSha256 puuttuu');
  }
  if (!meta.aapt || String(meta.aapt.versionCode) !== String(meta.versionCode)
    || meta.aapt.versionName !== meta.versionName) {
    problems.push('aapt-lukema ei vastaa versionCodea/versionNamea');
  }
  if (!meta.verify || meta.verify.passed !== true) problems.push('verify-apk ei mennyt läpi');
  if (problems.length) throw new Error('paketin metatiedot eivät kelpaa: ' + problems.join('; '));
  return meta;
}

/** JSON-tavut: UTF-8 ilman BOMia, kahden välilyönnin sisennys, LF-loppu. */
export function serializeMetadata(meta) {
  return Buffer.from(JSON.stringify(meta, null, 2) + '\n', 'utf8');
}
