// APK-tarkastuksen (scripts/verify-apk.mjs, tools/android/*) jäsentimet,
// odotukset ja assettivertailu.
//
// FIXTURET (tests/fixtures/apk/)
//
//   waveJ-5df40b2.*          OIKEAT tulosteet aallon J hyväksyntä-APK:sta
//                            (sha256 649529…fe405): aapt2 36.0.0 dump
//                            badging/permissions/xmltree, apksigner verify
//                            --print-certs -v, capacitor.plugins.json ja
//                            capacitor.config.json. Rivinvaihdot LF.
//   speech-manifest.*        Samat, muokattuina puhemuutoksen mukaisiksi:
//                            sijaintiluvat pois, RECORD_AUDIO ja <queries>
//                            android.speech.RecognitionService lisätty,
//                            versionCode 23069141 ja versionName
//                            1.0.0-waveJ.v23+5df40b2-debug. EI enää kelpaa
//                            (herätyksen luvat ja puhemoottori puuttuvat).
//   alarm-manifest.*         speech-manifest + herätys (NYKYINEN
//                            lähdemanifesti): USE_FULL_SCREEN_INTENT,
//                            FOREGROUND_SERVICE, FOREGROUND_SERVICE_MEDIA_PLAYBACK,
//                            <queries> TTS_SERVICE + Google Maps -paketti,
//                            suljetut AlarmReceiver, BootReceiver,
//                            AlarmService (mediaPlayback) ja AlarmActivity.
//   legacy-waveJ-5df40b2.apk.json  käsin tehty metatieto (BOM, ei-ISO-aika).
//
// Yksikään testi ei aja aapt2:ta, apksigneria, gitiä eikä Gradlea: tarkastus
// saa tulosteet tekstinä ja assetit muistissa (createZip).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ROOT, read } from './helpers/sources.mjs';
import { ALL_GATES, expectedMatrix } from '../tools/release/waves.mjs';
import {
  APK_DECLARED_PERMISSIONS, APK_FORBIDDEN_FOREGROUND_SERVICE_TYPES, APK_FORBIDDEN_PERMISSIONS,
  APK_PERMISSION_ALLOWLIST, APP_ID,
  CAPACITOR_EXTRA_ASSETS, EXPECTED_CAPACITOR_PLUGINS, EXPECTED_SIGNER_CERT_SHA256,
  REQUIRED_QUERY_INTENT_ACTIONS, WEB_ROOT_FILES, WEB_DIRECTORIES,
  checkBadging, checkCapacitorConfig, checkManifest, checkPermissions, checkPlugins, checkSigner,
  checkWebPayload, compareAssetTrees, expectedPermissions, isForbiddenPermission, isWebBuildPath, manifestFacts,
  parseApksigner, parseBadging, parsePermissionsDump, parseVariablesGradle, parseXmlTree
} from '../tools/android/apk.mjs';
import {
  parseCatFileBatch, parseLsTree, readGitWebTree, readGradleJavaHome, readLocalPropertiesSdk,
  resolveJdkDir, resolveSdkDir, treeDigest
} from '../tools/android/toolchain.mjs';
import { readApkAssets, verifyApkContents } from '../tools/android/verify.mjs';
import { createZip, readZip } from '../tools/android/zip.mjs';
import * as verifyApkScript from '../scripts/verify-apk.mjs';

const FIXTURES = path.join(ROOT, 'tests', 'fixtures', 'apk');
// LF-normalisointi: `* text=auto` + core.autocrlf=true antaa työpuuhun CRLF:n,
// ja alla olevat mutaatiot etsivät '\n'-rivinvaihtoja. Ilman tätä ne eivät
// osuisi mihinkään ja testit menisivät läpi tyhjää vasten.
const fixture = name => fs.readFileSync(path.join(FIXTURES, name), 'utf8').replace(/\r\n/g, '\n');

const J = Object.freeze({
  badging: fixture('waveJ-5df40b2.badging.txt'),
  permissions: fixture('waveJ-5df40b2.permissions.txt'),
  xmltree: fixture('waveJ-5df40b2.xmltree.txt'),
  apksigner: fixture('waveJ-5df40b2.apksigner.txt'),
  plugins: fixture('waveJ-5df40b2.capacitor.plugins.json'),
  config: fixture('waveJ-5df40b2.capacitor.config.json')
});
const SPEECH = Object.freeze({
  badging: fixture('speech-manifest.badging.txt'),
  permissions: fixture('speech-manifest.permissions.txt'),
  xmltree: fixture('speech-manifest.xmltree.txt'),
  apksigner: J.apksigner
});
const ALARM = Object.freeze({
  badging: fixture('alarm-manifest.badging.txt'),
  permissions: fixture('alarm-manifest.permissions.txt'),
  xmltree: fixture('alarm-manifest.xmltree.txt'),
  apksigner: J.apksigner
});
const NEW_NAME = '1.0.0-waveJ.v23+5df40b2-debug';
const NEW_EXPECT = Object.freeze({ versionCode: 23069141, versionName: NEW_NAME });

const failed = checks => checks.filter(c => !c.ok).map(c => c.id).sort();
const byId = (checks, id) => checks.find(c => c.id === id);

// ---------------------------------------------------------------- odotukset

test('sallittu lupajoukko: INTERNET + RECORD_AUDIO + herätys + yhdistyvät kirjastoluvat, ei sijaintia', () => {
  assert.deepEqual(expectedPermissions(), [
    'android.permission.ACCESS_NETWORK_STATE',
    'android.permission.FOREGROUND_SERVICE',
    'android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK',
    'android.permission.INTERNET',
    'android.permission.POST_NOTIFICATIONS',
    'android.permission.RECEIVE_BOOT_COMPLETED',
    'android.permission.RECORD_AUDIO',
    'android.permission.SCHEDULE_EXACT_ALARM',
    'android.permission.USE_FULL_SCREEN_INTENT',
    'android.permission.WAKE_LOCK',
    'fi.limitlesslife.manifestival.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION'
  ]);
  assert.equal(expectedPermissions().some(p => /LOCATION/.test(p)), false);
  assert.deepEqual([...REQUIRED_QUERY_INTENT_ACTIONS], ['android.speech.RecognitionService', 'android.intent.action.TTS_SERVICE']);
  assert.deepEqual([...EXPECTED_CAPACITOR_PLUGINS], ['@capacitor/app', '@capacitor/geolocation', '@capacitor/local-notifications']);
});

test('kielletty ja sallittu eivät leikkaa (etuliitesääntö mukaan lukien)', () => {
  for (const permission of expectedPermissions()) {
    for (const rule of APK_FORBIDDEN_PERMISSIONS) {
      const hit = rule.endsWith('*') ? permission.startsWith(rule.slice(0, -1)) : permission === rule;
      assert.equal(hit, false, `${permission} on sekä sallittu että kielletty (${rule})`);
    }
  }
  for (const name of ['ACCESS_BACKGROUND_LOCATION', 'ACCESS_COARSE_LOCATION', 'ACCESS_FINE_LOCATION',
    'USE_EXACT_ALARM', 'CAMERA', 'MODIFY_AUDIO_SETTINGS', 'READ_EXTERNAL_STORAGE', 'READ_CONTACTS']) {
    assert.ok(APK_FORBIDDEN_PERMISSIONS.includes('android.permission.' + name), name);
  }
  // Etualapalvelu: vain toisto (mediaPlayback) on sallittu; jokainen muu tyyppi on nimetty kielletyksi.
  for (const type of ['MICROPHONE', 'LOCATION', 'CAMERA', 'DATA_SYNC', 'SPECIAL_USE', 'MEDIA_PROJECTION',
    'PHONE_CALL', 'CONNECTED_DEVICE', 'HEALTH', 'REMOTE_MESSAGING', 'SYSTEM_EXEMPTED']) {
    assert.ok(APK_FORBIDDEN_FOREGROUND_SERVICE_TYPES.includes('android.permission.FOREGROUND_SERVICE_' + type), type);
    assert.equal(isForbiddenPermission('android.permission.FOREGROUND_SERVICE_' + type), true, type);
  }
  assert.equal(isForbiddenPermission('android.permission.FOREGROUND_SERVICE'), false);
  assert.equal(isForbiddenPermission('android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK'), false);
  assert.equal(APK_FORBIDDEN_PERMISSIONS.some(rule => rule.endsWith('*')), false,
    'etuliitesääntö FOREGROUND_SERVICE* korvattiin nimetyllä listalla');
});

test('scripts/verify-apk.mjs vie saman sallitun joukon (yksi vakio) ja on tuotavissa ilman ajoa', () => {
  assert.equal(verifyApkScript.APK_PERMISSION_ALLOWLIST, APK_PERMISSION_ALLOWLIST);
  assert.equal(verifyApkScript.APK_FORBIDDEN_PERMISSIONS, APK_FORBIDDEN_PERMISSIONS);
  assert.equal(verifyApkScript.EXPECTED_SIGNER_CERT_SHA256, EXPECTED_SIGNER_CERT_SHA256);
});

// ---------------------------------------------------- jäsentimet (oikea J)

test('badging: oikea J-APK (1 / 1.0, debug, sdk 24/36, sijaintiluvat)', () => {
  const b = parseBadging(J.badging);
  assert.equal(b.packageName, APP_ID);
  assert.equal(b.versionCode, '1');
  assert.equal(b.versionName, '1.0');
  assert.equal(b.minSdk, 24);
  assert.equal(b.targetSdk, 36);
  assert.equal(b.debuggable, true);
  assert.equal(b.launchableActivity, 'fi.limitlesslife.manifestival.MainActivity');
  assert.equal(b.permissions.length, 9);
  assert.ok(b.permissions.includes('android.permission.ACCESS_FINE_LOCATION'));
});

test('badging ja permissions-dump sietävät CRLF-rivinvaihdot', () => {
  const crlf = J.badging.replace(/\r?\n/g, '\r\n');
  assert.deepEqual(parseBadging(crlf), parseBadging(J.badging));
  assert.deepEqual(parsePermissionsDump(J.permissions.replace(/\r?\n/g, '\r\n')), parsePermissionsDump(J.permissions));
});

test('permissions-dump: pyydetyt ja sovelluksen määrittelemät luvat erikseen', () => {
  const p = parsePermissionsDump(J.permissions);
  assert.equal(p.packageName, APP_ID);
  assert.equal(p.requested.length, 9);
  assert.deepEqual(p.declared, ['fi.limitlesslife.manifestival.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION']);
});

test('xmltree: oikean J-APK:n yhdistetty manifesti', () => {
  const facts = manifestFacts(parseXmlTree(J.xmltree));
  assert.equal(facts.packageName, APP_ID);
  assert.equal(facts.versionCode, '1');
  assert.equal(facts.versionName, '1.0');
  assert.deepEqual(facts.application, { debuggable: 'true', allowBackup: 'false', usesCleartextTraffic: 'false' });
  assert.deepEqual(facts.exported.map(c => [c.name, c.permission]), [
    ['fi.limitlesslife.manifestival.MainActivity', null],
    ['androidx.profileinstaller.ProfileInstallReceiver', 'android.permission.DUMP']
  ]);
  assert.deepEqual(facts.queryIntentActions, []);
  assert.deepEqual(facts.declaredPermissions, [{
    name: 'fi.limitlesslife.manifestival.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION', protectionLevel: '0x00000002'
  }]);
});

test('apksigner: oikea J-APK on v2-allekirjoitettu nykyisellä debug-avaimella', () => {
  const s = parseApksigner(J.apksigner);
  assert.equal(s.verifies, true);
  assert.equal(s.schemes.v1, false);
  assert.equal(s.schemes.v2, true);
  assert.equal(s.schemes.v31, false);
  assert.equal(s.signerCount, 1);
  assert.deepEqual(s.signers, [{ dn: 'C=US, O=Android, CN=Android Debug', certSha256: EXPECTED_SIGNER_CERT_SHA256 }]);
  assert.deepEqual(failed(checkSigner(s)), []);
});

// ------------------------------------ uusi manifesti vs. vanha J-APK

test('uuden manifestin mukainen APK läpäisee badging-, lupa- ja manifestitarkistukset', () => {
  assert.deepEqual(failed(checkBadging(parseBadging(ALARM.badging), NEW_EXPECT)), []);
  assert.deepEqual(failed(checkPermissions(parsePermissionsDump(ALARM.permissions))), []);
  const facts = manifestFacts(parseXmlTree(ALARM.xmltree));
  assert.deepEqual(facts.queryIntentActions, ['android.speech.RecognitionService', 'android.intent.action.TTS_SERVICE']);
  assert.deepEqual(failed(checkManifest(facts)), []);
  // Herätyksen komponentit ovat mukana mutta suljettuja: avoimia on yhä vain kaksi.
  assert.deepEqual(facts.exported.map(c => c.name), [
    'fi.limitlesslife.manifestival.MainActivity', 'androidx.profileinstaller.ProfileInstallReceiver'
  ]);
  for (const name of ['AlarmReceiver', 'BootReceiver', 'AlarmService', 'AlarmActivity']) {
    assert.ok(ALARM.xmltree.includes(`"fi.limitlesslife.manifestival.${name}"`), name);
  }
});

test('herätyskomponentti avoimena kaatuu (esim. BootReceiver ilman exported=false)', () => {
  const open = ALARM.xmltree.replace(
    'BootReceiver")\n            A: http://schemas.android.com/apk/res/android:exported(0x01010010)=false\n',
    'BootReceiver")\n');
  assert.notEqual(open, ALARM.xmltree);
  const checks = checkManifest(manifestFacts(parseXmlTree(open)));
  assert.deepEqual(failed(checks), ['manifest.exported']);
  assert.match(byId(checks, 'manifest.exported').detail, /BootReceiver on avoin \(intent-filter ilman android:exported\)/);
});

test('puhe-manifestin APK (ennen herätystä) EI enää kelpaa: herätysluvat ja puhemoottori puuttuvat', () => {
  const perms = checkPermissions(parsePermissionsDump(SPEECH.permissions));
  assert.deepEqual(failed(perms), ['permissions.allowlist']);
  assert.match(byId(perms, 'permissions.allowlist').detail,
    /puuttuu: android\.permission\.FOREGROUND_SERVICE, android\.permission\.FOREGROUND_SERVICE_MEDIA_PLAYBACK, android\.permission\.USE_FULL_SCREEN_INTENT/);
  const manifest = checkManifest(manifestFacts(parseXmlTree(SPEECH.xmltree)));
  assert.deepEqual(failed(manifest), ['manifest.permissions', 'manifest.queries']);
  assert.match(byId(manifest, 'manifest.queries').detail, /android\.intent\.action\.TTS_SERVICE/);
  // USE_EXACT_ALARM lisättynä kaatuu kiellettynä, vaikka muu olisi kunnossa.
  const exact = ALARM.permissions + "uses-permission: name='android.permission.USE_EXACT_ALARM'\n";
  assert.deepEqual(failed(checkPermissions(parsePermissionsDump(exact))), ['permissions.allowlist', 'permissions.forbidden']);
});

test('vanha J-APK (5df40b2) EI läpäise uutta sallittua joukkoa: sijainti mukana, mikrofoni ja <queries> puuttuvat', () => {
  const perms = checkPermissions(parsePermissionsDump(J.permissions));
  assert.deepEqual(failed(perms), ['permissions.allowlist', 'permissions.forbidden']);
  assert.match(byId(perms, 'permissions.allowlist').detail, /puuttuu: [^;]*android\.permission\.RECORD_AUDIO/);
  assert.match(byId(perms, 'permissions.allowlist').detail, /ACCESS_COARSE_LOCATION, android\.permission\.ACCESS_FINE_LOCATION/);
  assert.deepEqual(failed(checkManifest(manifestFacts(parseXmlTree(J.xmltree)))), ['manifest.permissions', 'manifest.queries']);
  assert.deepEqual(failed(checkBadging(parseBadging(J.badging), NEW_EXPECT)),
    ['badging.permissions', 'badging.versionCode', 'badging.versionName']);
});

// --------------------------------------------------------------- mutaatiot

test('ylimääräinen lupa (CAMERA) ja FOREGROUND_SERVICE_* kaatavat', () => {
  const camera = ALARM.permissions + "uses-permission: name='android.permission.CAMERA'\n";
  assert.deepEqual(failed(checkPermissions(parsePermissionsDump(camera))), ['permissions.allowlist', 'permissions.forbidden']);
  const fgs = ALARM.permissions + "uses-permission: name='android.permission.FOREGROUND_SERVICE_MICROPHONE'\n";
  assert.match(byId(checkPermissions(parsePermissionsDump(fgs)), 'permissions.forbidden').detail, /FOREGROUND_SERVICE_MICROPHONE/);
  const declared = ALARM.permissions + 'permission: fi.limitlesslife.manifestival.EXTRA\n';
  assert.deepEqual(failed(checkPermissions(parsePermissionsDump(declared))), ['permissions.declared']);
});

test('väärä paketti (debug-pääte) kaatuu', () => {
  const b = parseBadging(ALARM.badging.replace("name='fi.limitlesslife.manifestival'", "name='fi.limitlesslife.manifestival.debug'"));
  assert.deepEqual(failed(checkBadging(b, NEW_EXPECT)), ['badging.package']);
});

test('versionCode: väärä arvo, 0 ja yli 2100000000 kaatuvat; sallittujen joukko kelpaa', () => {
  const withCode = code => parseBadging(ALARM.badging.replace("versionCode='23069141'", `versionCode='${code}'`));
  assert.deepEqual(failed(checkBadging(withCode(1), NEW_EXPECT)), ['badging.versionCode']);
  assert.deepEqual(failed(checkBadging(withCode(0), { versionName: NEW_NAME })), ['badging.versionCode']);
  assert.deepEqual(failed(checkBadging(withCode(2100000001), { versionName: NEW_NAME })), ['badging.versionCode']);
  assert.deepEqual(failed(checkBadging(withCode(1), { versionCode: [1, 23069141], versionName: NEW_NAME })), []);
});

test('versionName ilman sha:ta kaatuu, vaikka täsmällistä nimeä ei annettaisi', () => {
  const b = parseBadging(ALARM.badging.replace(NEW_NAME, '1.0.0-debug'));
  assert.deepEqual(failed(checkBadging(b, { versionCode: 23069141 })), ['badging.versionName']);
  const other = parseBadging(ALARM.badging.replace(NEW_NAME, '1.0.0-waveJ.v23+1234567-debug'));
  assert.deepEqual(failed(checkBadging(other, NEW_EXPECT)), ['badging.versionName']);
});

test('debuggable: debugissa pakollinen, releasessa kielletty', () => {
  const noDebug = parseBadging(ALARM.badging.replace('application-debuggable\n', ''));
  assert.deepEqual(failed(checkBadging(noDebug, NEW_EXPECT)), ['badging.debuggable']);
  assert.deepEqual(failed(checkBadging(parseBadging(ALARM.badging), { ...NEW_EXPECT, buildType: 'release' })),
    ['badging.debuggable']);
  const facts = manifestFacts(parseXmlTree(ALARM.xmltree));
  assert.deepEqual(failed(checkManifest(facts, { buildType: 'release' })), ['manifest.debuggable']);
});

test('avoin FileProvider, DUMP-suojaton ProfileInstallReceiver ja allowBackup=true kaatavat', () => {
  const openProvider = ALARM.xmltree.replace(
    'android:exported(0x01010010)=false\n            A: http://schemas.android.com/apk/res/android:authorities(0x01010018)="fi.limitlesslife.manifestival.fileprovider"',
    'android:exported(0x01010010)=true\n            A: http://schemas.android.com/apk/res/android:authorities(0x01010018)="fi.limitlesslife.manifestival.fileprovider"');
  assert.notEqual(openProvider, ALARM.xmltree);
  const exported = checkManifest(manifestFacts(parseXmlTree(openProvider)));
  assert.deepEqual(failed(exported), ['manifest.exported']);
  assert.match(byId(exported, 'manifest.exported').detail, /androidx\.core\.content\.FileProvider on avoin/);

  const noDump = ALARM.xmltree.replace(/\n\s*A: [^\n]*android:permission\(0x01010006\)="android\.permission\.DUMP"[^\n]*/, '');
  assert.notEqual(noDump, ALARM.xmltree);
  assert.deepEqual(failed(checkManifest(manifestFacts(parseXmlTree(noDump)))), ['manifest.exported']);

  const backup = ALARM.xmltree.replace('android:allowBackup(0x01010280)=false', 'android:allowBackup(0x01010280)=true');
  assert.deepEqual(failed(checkManifest(manifestFacts(parseXmlTree(backup)))), ['manifest.allowBackup']);
});

test('android:exported: vain kirjaimellinen false sulkee (fail closed), intent-filter-oletus säilyy', () => {
  // Resurssiviittaus (esim. @bool/-arvo) ei ole kirjaimellinen false. Ennen
  // korjausta FileProvider tulkittiin suljetuksi ja tarkastus meni läpi.
  const refProvider = ALARM.xmltree.replace(
    'android:exported(0x01010010)=false\n            A: http://schemas.android.com/apk/res/android:authorities(0x01010018)="fi.limitlesslife.manifestival.fileprovider"',
    'android:exported(0x01010010)=@0x7f050001\n            A: http://schemas.android.com/apk/res/android:authorities(0x01010018)="fi.limitlesslife.manifestival.fileprovider"');
  assert.notEqual(refProvider, ALARM.xmltree);
  const facts = manifestFacts(parseXmlTree(refProvider));
  assert.ok(facts.exported.some(c => c.name === 'androidx.core.content.FileProvider' && c.exportedValue === '@0x7f050001'));
  const checks = checkManifest(facts);
  assert.deepEqual(failed(checks), ['manifest.exported']);
  assert.match(byId(checks, 'manifest.exported').detail, /FileProvider: android:exported=@0x7f050001 ei ole kirjaimellinen/);
  assert.match(byId(checks, 'manifest.exported').detail, /androidx\.core\.content\.FileProvider on avoin/);

  // Sallittukin komponentti kaatuu, jos arvo ei ole kirjaimellinen.
  const refMain = ALARM.xmltree.replace(
    'android:exported(0x01010010)=true\n            A: http://schemas.android.com/apk/res/android:launchMode',
    'android:exported(0x01010010)=@0x7f050002\n            A: http://schemas.android.com/apk/res/android:launchMode');
  assert.notEqual(refMain, ALARM.xmltree);
  const mainChecks = checkManifest(manifestFacts(parseXmlTree(refMain)));
  assert.deepEqual(failed(mainChecks), ['manifest.exported']);
  assert.match(byId(mainChecks, 'manifest.exported').detail, /MainActivity: android:exported=@0x7f050002/);

  // Ei attribuuttia + intent-filter = avoin (Androidin oletus).
  const implicit = ALARM.xmltree.replace(
    'LocalNotificationRestoreReceiver")\n            A: http://schemas.android.com/apk/res/android:exported(0x01010010)=false\n',
    'LocalNotificationRestoreReceiver")\n');
  assert.notEqual(implicit, ALARM.xmltree);
  const implicitChecks = checkManifest(manifestFacts(parseXmlTree(implicit)));
  assert.deepEqual(failed(implicitChecks), ['manifest.exported']);
  assert.match(byId(implicitChecks, 'manifest.exported').detail, /LocalNotificationRestoreReceiver on avoin \(intent-filter ilman android:exported\)/);

  // Kirjaimellinen false ja attribuutiton komponentti ilman intent-filteriä ovat suljettuja.
  assert.deepEqual(manifestFacts(parseXmlTree(ALARM.xmltree)).exported.map(c => c.exportedValue), ['true', 'true']);
});

test('ACCESS_NETWORK_STATE: apk.mjs ja dokumentti nimeävät saman lähteen (iongeolocation-android)', () => {
  const source = read('tools/android/apk.mjs');
  const comment = source.slice(source.indexOf('Loput tulevat kirjastojen manifesteista'), source.indexOf('export const APK_PERMISSION_ALLOWLIST'));
  assert.ok(comment.length > 0, 'lupien alkuperäkommentti puuttuu apk.mjs:stä');
  assert.match(comment, /iongeolocation-android[\s\S]*@capacitor\/geolocation[\s\S]*ACCESS_NETWORK_STATE/);
  assert.doesNotMatch(comment, /Capacitor\/androidx/, 'väärä alkuperä: manifestiyhdistäjän raportin mukaan lupa tulee iongeolocationista');
  const row = read('docs/activation/ANDROID-ACCEPTANCE-BUILD.md').split(/\r?\n/).find(l => l.startsWith('| `ACCESS_NETWORK_STATE`'));
  assert.ok(row, 'dokumentin lupataulukosta puuttuu ACCESS_NETWORK_STATE');
  assert.match(row, /iongeolocation-android/);
  assert.match(row, /@capacitor\/geolocation/);
});

test('<queries> ilman RecognitionServicea kaatuu', () => {
  const other = ALARM.xmltree.replace('"android.speech.RecognitionService" (Raw: "android.speech.RecognitionService")',
    '"android.intent.action.VIEW" (Raw: "android.intent.action.VIEW")');
  assert.deepEqual(failed(checkManifest(manifestFacts(parseXmlTree(other)))), ['manifest.queries']);
});

test('allekirjoitus: eri varmenne, DOES NOT VERIFY, kaksi allekirjoittajaa ja pelkkä v1 kaatavat', () => {
  const s = parseApksigner(J.apksigner);
  assert.deepEqual(failed(checkSigner(s, { expectedCert: 'ab'.repeat(32) })), ['signer.cert']);
  assert.deepEqual(failed(checkSigner(parseApksigner('DOES NOT VERIFY\nERROR: APK Signature Scheme v2 signature did not verify\n'))),
    ['signer.cert', 'signer.count', 'signer.v2', 'signer.verifies']);
  const two = J.apksigner.replace('Number of signers: 1', 'Number of signers: 2');
  assert.deepEqual(failed(checkSigner(parseApksigner(two))), ['signer.count']);
  const v1only = J.apksigner.replace('(APK Signature Scheme v2): true', '(APK Signature Scheme v2): false');
  assert.deepEqual(failed(checkSigner(parseApksigner(v1only))), ['signer.v2']);
});

test('capacitor.plugins.json: tasan app, geolocation, local-notifications', () => {
  assert.deepEqual(failed(checkPlugins(J.plugins)), []);
  const list = JSON.parse(J.plugins);
  const extra = JSON.stringify([...list, { pkg: '@capacitor-community/speech-recognition', classpath: 'x' }]);
  assert.match(checkPlugins(extra)[0].detail, /ylimääräinen: @capacitor-community\/speech-recognition/);
  const missing = JSON.stringify(list.filter(p => p.pkg !== '@capacitor/geolocation'));
  assert.match(checkPlugins(missing)[0].detail, /puuttuu: @capacitor\/geolocation/);
  assert.equal(checkPlugins('{').at(0).ok, false);
});

test('capacitor.config.json verrataan JSON-tasolla (sisennys ja rivinvaihdot eivät merkitse)', () => {
  assert.deepEqual(failed(checkCapacitorConfig(J.config, read('capacitor.config.json'))), []);
  const mixed = J.config.replace('"allowMixedContent": false', '"allowMixedContent": true');
  assert.deepEqual(failed(checkCapacitorConfig(mixed, read('capacitor.config.json'))), ['assets.capacitorConfig']);
});

test('android/variables.gradle: minSdk 24 ja targetSdk 36', () => {
  assert.deepEqual(parseVariablesGradle(read('android/variables.gradle')), { minSdk: 24, targetSdk: 36 });
});

// ---------------------------------------------------------- assettivertailu

const bytes = text => Buffer.from(text, 'utf8');
function tree(entries) { return new Map(Object.entries(entries).map(([k, v]) => [k, Buffer.isBuffer(v) ? v : bytes(v)])); }

test('assetit: identtinen puu kelpaa, Capacitorin cordova-tiedostot sallitaan', () => {
  const dist = tree({ 'index.html': '<p>\r\n', 'src/app/main.js': 'x\r\n' });
  const apk = tree({ 'index.html': '<p>\r\n', 'src/app/main.js': 'x\r\n', 'cordova.js': '', 'cordova_plugins.js': '' });
  const result = compareAssetTrees(apk, dist);
  assert.equal(result.ok, true);
  assert.deepEqual(result.allowedExtra, [...CAPACITOR_EXTRA_ASSETS]);
});

test('assetit: ylimääräinen, puuttuva ja tavuero kaatavat', () => {
  const dist = tree({ 'index.html': 'a', 'src/x.js': 'b' });
  assert.deepEqual(compareAssetTrees(tree({ 'index.html': 'a', 'src/x.js': 'b', 'src/extra.js': 'c' }), dist).extra, ['src/extra.js']);
  assert.deepEqual(compareAssetTrees(tree({ 'index.html': 'a' }), dist).missing, ['src/x.js']);
  const changed = compareAssetTrees(tree({ 'index.html': 'a', 'src/x.js': 'B' }), dist);
  assert.equal(changed.ok, false);
  assert.deepEqual(changed.differing, ['src/x.js']);
});

test('assetit: pelkkä CRLF-ero kaatuu dist/-vertailussa mutta kelpaa git-vertailussa', () => {
  const apk = tree({ 'index.html': '<html>\r\n</html>\r\n', 'icon-192.png': Buffer.from([0x89, 0x50, 13, 10]) });
  const git = tree({ 'index.html': '<html>\n</html>\n', 'icon-192.png': Buffer.from([0x89, 0x50, 13, 10]) });
  const againstDist = compareAssetTrees(apk, git, { normalizeCr: false });
  assert.equal(againstDist.ok, false);
  assert.deepEqual(againstDist.differing, ['index.html']);
  const againstGit = compareAssetTrees(apk, git, { normalizeCr: true });
  assert.equal(againstGit.ok, true);
  assert.deepEqual(againstGit.crOnly, ['index.html']);
  // Binääriä ei normalisoida: CR-ero PNG:ssä on oikea ero.
  const png = compareAssetTrees(tree({ 'icon-192.png': Buffer.from([0x89, 0x50, 10]) }),
    tree({ 'icon-192.png': Buffer.from([0x89, 0x50, 13, 10]) }), { normalizeCr: true });
  assert.deepEqual(png.differing, ['icon-192.png']);
});

/** Pieni mutta aito web-sisältö aallolle. */
function webPayload(wave, cache, extra = {}) {
  const matrix = expectedMatrix(wave);
  return tree({
    'index.html': '<!doctype html>\r\n<title>Manifestival</title>\r\n',
    'manifest.json': '{"name":"Manifestival"}\r\n',
    'sw.js': `const CACHE_VERSION = '${cache}';\r\n`,
    'icon-192.png': Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    'src/app/main.js': 'import "./x.js";\r\n',
    'src/styles.css': 'body{}\r\n',
    'src/data/schema.js': 'export const TABLES = Object.freeze({\r\n'
      + ALL_GATES.map(g => `  ${g}: ${matrix[g]},`).join('\r\n') + '\r\n});\r\nexport function hasTable() {}\r\n',
    ...extra
  });
}

test('web-sisältö: aalto, välimuisti, kielletyt polut ja salaisuudet', () => {
  assert.deepEqual(failed(checkWebPayload(webPayload('J', 'v23'), { wave: 'J' })), []);
  assert.deepEqual(failed(checkWebPayload(webPayload('J', 'v22'), { wave: 'J' })), ['payload.cacheVersion']);
  assert.deepEqual(failed(checkWebPayload(webPayload('I', 'v23'), { wave: 'J' })), ['payload.wave']);
  assert.deepEqual(failed(checkWebPayload(webPayload('J', 'v23', { 'tests/a.test.mjs': 'x', 'src/package.json': '{}' }), { wave: 'J' })),
    ['payload.forbiddenPaths']);
  const key = 'sk-ant-' + 'api03-abcdefghij';
  assert.deepEqual(failed(checkWebPayload(webPayload('J', 'v23', { 'src/leak.js': `const k = '${key}';` }), { wave: 'J' })),
    ['payload.secrets']);
  const noMain = webPayload('J', 'v23');
  noMain.delete('src/app/main.js');
  assert.deepEqual(failed(checkWebPayload(noMain, { wave: 'J' })), ['payload.required']);
});

test('web-koonnin polkusäännöt vastaavat scripts/build-web.mjs:ää', () => {
  const source = read('scripts/build-web.mjs');
  const files = /const FILES = \[([\s\S]*?)\];/.exec(source)[1].match(/'([^']+)'/g).map(s => s.slice(1, -1));
  assert.deepEqual(files, [...WEB_ROOT_FILES], 'build-web.mjs:n FILES ja tools/android/apk.mjs:n WEB_ROOT_FILES erkanivat');
  const dirs = /const DIRECTORIES = \[([^\]]*)\];/.exec(source)[1].match(/'([^']+)'/g).map(s => s.slice(1, -1));
  assert.deepEqual(dirs, [...WEB_DIRECTORIES], 'build-web.mjs:n DIRECTORIES ja tools/android/apk.mjs:n WEB_DIRECTORIES erkanivat');
  assert.equal(isWebBuildPath('index.html'), true);
  assert.equal(isWebBuildPath('src/app/main.js'), true);
  // supabase-js ladataan omasta originista (vendor/), joten se kuuluu APK:hon.
  assert.equal(isWebBuildPath('vendor/supabase-js-2.117.2.min.js'), true);
  assert.equal(isWebBuildPath('vendor/.gitattributes'), false);
  assert.equal(isWebBuildPath('src/package.json'), false);
  assert.equal(isWebBuildPath('src/.eslintrc'), false);
  assert.equal(isWebBuildPath('api/parse.js'), false);
  assert.equal(isWebBuildPath('README.md'), false);
});

// -------------------------------------------------------------- ZIP ja git

test('ZIP: kirjoitus ja luku (stored + deflate), CRC-virhe ja ei-ZIP havaitaan', () => {
  const zip = createZip([
    { name: 'assets/public/index.html', data: '<p>hei</p>\r\n' },
    { name: 'assets/public/icon.png', data: Buffer.from([1, 2, 3, 13, 10]), method: 0 }
  ]);
  const entries = readZip(zip);
  assert.deepEqual([...entries.keys()], ['assets/public/index.html', 'assets/public/icon.png']);
  assert.equal(entries.get('assets/public/index.html').read().toString('utf8'), '<p>hei</p>\r\n');
  assert.deepEqual([...entries.get('assets/public/icon.png').read()], [1, 2, 3, 13, 10]);

  const corrupt = Buffer.from(createZip([{ name: 'a.txt', data: 'abcdef', method: 0 }]));
  corrupt[30 + 'a.txt'.length] ^= 0xff;
  assert.throws(() => readZip(corrupt).get('a.txt').read(), /CRC/);
  assert.throws(() => readZip(Buffer.from('ei zip')), /End of Central Directory/);
});

test('git ls-tree ja cat-file --batch jäsentyvät, ja web-puu seuraa build-web-sääntöjä', () => {
  const blobs = { aaa: 'index\n', bbb: 'main\n', ccc: '{}\n' };
  const lsTree = Buffer.from([
    '100644 blob aaa\tindex.html', '100644 blob bbb\tsrc/app/main.js', '100644 blob ccc\tsrc/package.json', ''
  ].join('\0'));
  assert.deepEqual(parseLsTree(lsTree).map(e => e.path), ['index.html', 'src/app/main.js', 'src/package.json']);

  const calls = [];
  const git = (args, options = {}) => {
    calls.push(args[0]);
    if (args[0] === 'ls-tree') return lsTree;
    const oids = options.input.trim().split('\n');
    return Buffer.concat(oids.map(oid => Buffer.from(`${oid} blob ${blobs[oid].length}\n${blobs[oid]}\n`)));
  };
  const webTree = readGitWebTree(git, 'HEAD');
  assert.deepEqual([...webTree.keys()], ['index.html', 'src/app/main.js']);
  assert.equal(webTree.get('src/app/main.js').toString(), 'main\n');
  assert.deepEqual(calls, ['ls-tree', 'cat-file']);
  assert.throws(() => parseCatFileBatch(Buffer.from('zzz missing\n')), /missing/);
});

test('puun tiiviste on järjestyksestä riippumaton ja muuttuu sisällön mukana', () => {
  const a = treeDigest(new Map([['b.js', bytes('2')], ['a.js', bytes('1')]]));
  const b = treeDigest(new Map([['a.js', bytes('1')], ['b.js', bytes('2')]]));
  assert.deepEqual(a, b);
  assert.equal(a.fileCount, 2);
  assert.match(a.sha256, /^[0-9a-f]{64}$/);
  assert.notEqual(treeDigest(new Map([['a.js', bytes('1')], ['b.js', bytes('3')]])).sha256, a.sha256);
});

// ------------------------------------------------ SDK- ja JDK-polut

test('gradle.properties ja local.properties: polut luetaan, kommentit ohitetaan', () => {
  assert.equal(readGradleJavaHome('# org.gradle.java.home=C:/old\norg.gradle.java.home=C:/Program Files/JDK21\r\n'), 'C:/Program Files/JDK21');
  assert.equal(readGradleJavaHome('org.gradle.jvmargs=-Xmx1g\n'), null);
  assert.equal(readLocalPropertiesSdk('sdk.dir=C\\:\\\\Users\\\\x\\\\Sdk\n'), 'C:\\Users\\x\\Sdk');
});

test('SDK- ja JDK-hakemisto ratkaistaan järjestyksessä: lippu, ympäristö, työpuu, repo', () => {
  const files = {
    [path.join('/wt', 'android', 'local.properties')]: 'sdk.dir=/sdk-wt\n',
    [path.join('/wt', 'android', 'gradle.properties')]: 'org.gradle.java.home=/jdk-wt\n',
    [path.join('/repo', 'android', 'gradle.properties')]: 'org.gradle.java.home=/jdk-repo\n'
  };
  const present = new Set(['/sdk-env', '/sdk-wt', ...Object.keys(files)]);
  const fsDeps = { exists: p => present.has(p), readFile: p => files[p] };
  assert.deepEqual(resolveSdkDir({ env: { ANDROID_HOME: '/sdk-env' }, worktree: '/wt', ...fsDeps }), { dir: '/sdk-env', source: 'ANDROID_HOME' });
  assert.equal(resolveSdkDir({ env: {}, worktree: '/wt', ...fsDeps }).dir, '/sdk-wt');
  assert.equal(resolveSdkDir({ env: {}, ...fsDeps }).dir, null);
  assert.deepEqual(resolveJdkDir({ worktree: '/wt', repoRoot: '/repo', ...fsDeps }),
    { dir: '/jdk-wt', source: 'työpuun android/gradle.properties', pinned: '/jdk-wt' });
  assert.equal(resolveJdkDir({ worktree: '/none', repoRoot: '/repo', ...fsDeps }).dir, '/jdk-repo');
  assert.equal(resolveJdkDir({ override: '/x', worktree: '/wt', ...fsDeps }).source, '--jdk');
});

// ------------------------------------------------ kokonaisuus muistissa

function apkFor({ web, plugins = J.plugins, config = J.config }) {
  return createZip([
    { name: 'AndroidManifest.xml', data: Buffer.from([3, 0, 8, 0]) },
    { name: 'classes.dex', data: Buffer.alloc(64, 7) },
    { name: 'assets/capacitor.config.json', data: config },
    { name: 'assets/capacitor.plugins.json', data: plugins },
    { name: 'assets/public/cordova.js', data: '' },
    { name: 'assets/public/cordova_plugins.js', data: '' },
    ...[...web].map(([name, data]) => ({ name: 'assets/public/' + name, data }))
  ]);
}

function lfOnly(map) {
  return new Map([...map].map(([k, v]) => [k, k.endsWith('.png') ? v : Buffer.from(v.toString('utf8').replace(/\r/g, ''), 'utf8')]));
}

test('KOKONAISUUS: uuden manifestin APK läpäisee kaikki tarkistukset', () => {
  const web = webPayload('J', 'v23');
  const apkBytes = apkFor({ web });
  const assets = readApkAssets(apkBytes);
  assert.equal(assets.publicFiles.size, web.size + 2);

  const result = verifyApkContents({
    apkBytes, wave: 'J', outputs: ALARM, expect: NEW_EXPECT,
    dist: web, git: lfOnly(web), repoCapacitorConfig: read('capacitor.config.json')
  });
  assert.deepEqual(failed(result.checks), []);
  assert.equal(result.passed, true);
  assert.equal(result.facts.signer.certSha256, EXPECTED_SIGNER_CERT_SHA256);
  assert.match(byId(result.checks, 'assets.git').detail, /eroaa vain CR-merkeiltä/);
  assert.equal(byId(result.checks, 'apk.zip'), undefined, 'ZIPin luku epäonnistui');
  for (const id of ['assets.plugins', 'assets.capacitorConfig', 'assets.dist', 'assets.git',
    'payload.wave', 'payload.cacheVersion', 'manifest.queries', 'signer.cert', 'permissions.allowlist']) {
    assert.ok(byId(result.checks, id), `tarkistus ${id} puuttuu`);
  }
});

test('KOKONAISUUS: vanhan J-APK:n tulosteet kaatuvat täsmälleen odotetuista syistä', () => {
  const web = webPayload('J', 'v23');
  const result = verifyApkContents({
    apkBytes: apkFor({ web }), wave: 'J', outputs: J, expect: NEW_EXPECT,
    dist: web, git: lfOnly(web), repoCapacitorConfig: read('capacitor.config.json')
  });
  assert.equal(result.passed, false);
  assert.deepEqual(failed(result.checks), [
    'badging.permissions', 'badging.versionCode', 'badging.versionName',
    'manifest.permissions', 'manifest.queries',
    'permissions.allowlist', 'permissions.forbidden'
  ]);
});

test('valinnainen mikrofoni (uses-feature-not-required) kelpaa: badging, manifesti ja kokonaisuus', () => {
  // Jos lähdemanifestiin lisätään <uses-feature android:name="android.hardware.microphone"
  // android:required="false"/>, aapt2 näyttää sen feature-groupissa
  // julistettuna ja valinnaisena, eikä implisiittistä pakollista
  // mikrofonia enää ole (vrt. oikean J-APK:n location.gps-rivi).
  const badgingText = ALARM.badging.replace(
    "feature-group: label=''\n",
    "feature-group: label=''\n  uses-feature-not-required: name='android.hardware.microphone'\n").replace(
    "  uses-feature: name='android.hardware.microphone'\n"
      + "  uses-implied-feature: name='android.hardware.microphone' reason='requested android.permission.RECORD_AUDIO permission'\n", '');
  assert.notEqual(badgingText, ALARM.badging);
  assert.doesNotMatch(badgingText, /uses-implied-feature: name='android\.hardware\.microphone'/);
  const xmltree = ALARM.xmltree.replace(
    '      E: queries (line=24)\n',
    '      E: uses-feature (line=23)\n'
      + '        A: http://schemas.android.com/apk/res/android:name(0x01010003)="android.hardware.microphone" (Raw: "android.hardware.microphone")\n'
      + '        A: http://schemas.android.com/apk/res/android:required(0x0101028e)=false\n'
      + '      E: queries (line=24)\n');
  assert.notEqual(xmltree, ALARM.xmltree);

  const badging = parseBadging(badgingText);
  assert.deepEqual(badging.features, [
    { name: 'android.hardware.microphone', required: false },
    { name: 'android.hardware.faketouch', required: true }
  ]);
  assert.deepEqual(parseBadging(ALARM.badging).features, [
    { name: 'android.hardware.faketouch', required: true },
    { name: 'android.hardware.microphone', required: true }
  ], 'nykyinen manifesti: mikrofoni on RECORD_AUDIOn implisiittisesti vaatima');
  assert.deepEqual(parseBadging(J.badging).features.find(f => f.name === 'android.hardware.location.gps'),
    { name: 'android.hardware.location.gps', required: false }, 'oikean J-APK:n uses-feature-not-required-rivi');

  assert.deepEqual(failed(checkBadging(badging, NEW_EXPECT)), []);
  const facts = manifestFacts(parseXmlTree(xmltree));
  assert.deepEqual(facts.usesFeatures, [{ name: 'android.hardware.microphone', required: false }]);
  assert.deepEqual(failed(checkManifest(facts)), []);

  const web = webPayload('J', 'v23');
  const result = verifyApkContents({
    apkBytes: apkFor({ web }), wave: 'J', outputs: { ...ALARM, badging: badgingText, xmltree }, expect: NEW_EXPECT,
    dist: web, git: lfOnly(web), repoCapacitorConfig: read('capacitor.config.json')
  });
  assert.deepEqual(failed(result.checks), []);
  assert.equal(result.passed, true);
});

test('KOKONAISUUS: väärä SHA-256, käsin muokattu assetti ja ylimääräinen liitännäinen kaatavat', () => {
  const web = webPayload('J', 'v23');
  const tampered = new Map(web);
  tampered.set('index.html', bytes('<!doctype html>\r\n<title>muokattu</title>\r\n'));
  const plugins = JSON.stringify([...JSON.parse(J.plugins), { pkg: '@capacitor/camera', classpath: 'x' }]);
  const result = verifyApkContents({
    apkBytes: apkFor({ web: tampered, plugins }), wave: 'J', outputs: ALARM,
    expect: { ...NEW_EXPECT, sha256: '0'.repeat(64) },
    dist: web, git: lfOnly(web), repoCapacitorConfig: read('capacitor.config.json')
  });
  assert.deepEqual(failed(result.checks), ['apk.sha256', 'assets.dist', 'assets.git', 'assets.plugins']);
});

test('vanha käsin tehty metatieto: BOM kaataa JSON.parse:n, readMetadataFile sietää sen', () => {
  const raw = fs.readFileSync(path.join(FIXTURES, 'legacy-waveJ-5df40b2.apk.json'));
  assert.deepEqual([...raw.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'fixture on menettänyt BOMinsa');
  assert.throws(() => JSON.parse(raw.toString('utf8')));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-apk-meta-'));
  try {
    const file = path.join(dir, 'legacy.json');
    fs.writeFileSync(file, raw);
    const meta = verifyApkScript.readMetadataFile(file);
    assert.equal(meta.versionCode, 1);
    assert.ok(Number.isNaN(Date.parse(meta.builtAt)), 'vanha aikaleima ei ollut ISO-8601');
    assert.match(meta.sha256, /^[0-9A-F]{64}$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('määritellyt luvat korvataan sovellustunnuksella', () => {
  assert.deepEqual(APK_DECLARED_PERMISSIONS.map(p => p.replace('${applicationId}', 'x.y')), ['x.y.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION']);
  assert.ok(expectedPermissions('x.y').includes('x.y.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION'));
});
