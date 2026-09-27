// APK:n tarkastuksen puhdas osa: odotukset, jäsentimet ja tarkistukset.
//
// Tämä moduuli ei aja yhtäkään työkalua. Se saa aapt2:n ja apksignerin
// TULOSTEET tekstinä sekä assettien tavut Map-rakenteina, ja kertoo mikä
// täsmää ja mikä ei. Työkalujen ajaminen on tools/android/toolchain.mjs:ssä
// ja kokonaisuus scripts/verify-apk.mjs:ssä. Näin koko logiikka on
// testattavissa oikeista tulosteista kaapatuilla fixtureilla ilman
// Android SDK:ta (tests/verify-apk.test.mjs).
//
// ODOTUKSET OVAT YHDESSÄ PAIKASSA
//
// Lupien sallittu joukko on alla YHTENÄ vakiona. Jos lupa lisätään tai
// poistetaan, muutetaan tätä vakiota — ja testit vaativat, että
// docs/activation/ANDROID-ACCEPTANCE-BUILD.md mainitsee jokaisen.

import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';

import { parseCacheVersion, parseGates } from '../release/state.mjs';
import { cacheVersionOf, resolveWave } from '../release/waves.mjs';
import { VERSION_CODE_MAX, VERSION_CODE_MIN } from './version.mjs';

/** Sovellustunnus (capacitor.config.json, build.gradle). Ei päätettä. */
export const APP_ID = 'fi.limitlesslife.manifestival';

/** Paikkamerkki, joka korvataan sovellustunnuksella (kuten manifestissa). */
export const APPLICATION_ID_PLACEHOLDER = '${applicationId}';

/**
 * YHDISTETYN (merged) APK-manifestin luvat — TÄSMÄLLEEN nämä.
 *
 * Lähdemanifesti (android/app/src/main/AndroidManifest.xml) julistaa
 * INTERNETin, RECORD_AUDIOn ja herätysten luvat. RECORD_AUDIO on repon oman
 * natiivin SpeechPluginin (rekisteröity MainActivityssä) tarve; ajonaikainen
 * lupa pyydetään vasta kun käyttäjä napauttaa mikrofonia. Sijaintilupia ei ole.
 *
 * Herätys (repon oma AlarmPlugin, AlarmService, BootReceiver):
 *   RECEIVE_BOOT_COMPLETED, SCHEDULE_EXACT_ALARM, POST_NOTIFICATIONS,
 *   WAKE_LOCK (nämä tulevat myös muistutusliitännäisestä),
 *   USE_FULL_SCREEN_INTENT (lukitusnäkymä; Android 14+ tarkistaa
 *   canUseFullScreenIntent), FOREGROUND_SERVICE ja
 *   FOREGROUND_SERVICE_MEDIA_PLAYBACK (soiva herätys ja puhe; vain toisto).
 *
 * Loput tulevat kirjastojen manifesteista yhdistämisessä:
 *   @capacitor/local-notifications: RECEIVE_BOOT_COMPLETED, WAKE_LOCK,
 *     POST_NOTIFICATIONS, SCHEDULE_EXACT_ALARM
 *   io.ionic.libs:iongeolocation-android (tulee @capacitor/geolocationin
 *     riippuvuutena; todennettu manifestiyhdistäjän raportista):
 *     ACCESS_NETWORK_STATE
 *   androidx.core: <appId>.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION
 *     (signature-tasoinen, sovelluksen oma)
 */
export const APK_PERMISSION_ALLOWLIST = Object.freeze([
  'android.permission.INTERNET',
  'android.permission.RECORD_AUDIO',
  'android.permission.RECEIVE_BOOT_COMPLETED',
  'android.permission.WAKE_LOCK',
  'android.permission.POST_NOTIFICATIONS',
  'android.permission.SCHEDULE_EXACT_ALARM',
  'android.permission.USE_FULL_SCREEN_INTENT',
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK',
  'android.permission.ACCESS_NETWORK_STATE',
  '${applicationId}.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION'
]);

/**
 * Etualapalvelun tyypit, joita EI saa olla. Sallittu on vain
 * mediaPlayback (herätyksen ääni ja puhe). Erityisesti mikrofonin
 * etualapalvelu on kielletty: taustakuuntelua ei ole eikä tule.
 */
export const APK_FORBIDDEN_FOREGROUND_SERVICE_TYPES = Object.freeze([
  'android.permission.FOREGROUND_SERVICE_MICROPHONE',
  'android.permission.FOREGROUND_SERVICE_LOCATION',
  'android.permission.FOREGROUND_SERVICE_CAMERA',
  'android.permission.FOREGROUND_SERVICE_DATA_SYNC',
  'android.permission.FOREGROUND_SERVICE_SPECIAL_USE',
  'android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION',
  'android.permission.FOREGROUND_SERVICE_PHONE_CALL',
  'android.permission.FOREGROUND_SERVICE_CONNECTED_DEVICE',
  'android.permission.FOREGROUND_SERVICE_HEALTH',
  'android.permission.FOREGROUND_SERVICE_REMOTE_MESSAGING',
  'android.permission.FOREGROUND_SERVICE_SYSTEM_EXEMPTED'
]);

/**
 * Luvat, joita APK:ssa EI saa olla. Päällekkäinen varmistus sallitun
 * joukon kanssa: selkeämpi virheilmoitus ja suoja sille, että joku lisää
 * näistä yhden sallittuihin. `*` = etuliite.
 *
 * USE_EXACT_ALARM (automaattisesti myönnetty herätyslupa) on kielletty:
 * Play sallii sen vain sovelluksille, joiden päätehtävä on herätyskello tai
 * kalenteri. Tarkat herätykset kulkevat SCHEDULE_EXACT_ALARMilla, jonka
 * käyttäjä myöntää itse.
 */
export const APK_FORBIDDEN_PERMISSIONS = Object.freeze([
  'android.permission.ACCESS_BACKGROUND_LOCATION',
  'android.permission.ACCESS_COARSE_LOCATION',
  'android.permission.ACCESS_FINE_LOCATION',
  ...APK_FORBIDDEN_FOREGROUND_SERVICE_TYPES,
  'android.permission.USE_EXACT_ALARM',
  'android.permission.CAMERA',
  'android.permission.MODIFY_AUDIO_SETTINGS',
  'android.permission.READ_EXTERNAL_STORAGE',
  'android.permission.READ_CONTACTS'
]);

/** Sovelluksen itse MÄÄRITTELEMÄT luvat (<permission>), signature-tasoisina. */
export const APK_DECLARED_PERMISSIONS = Object.freeze([
  '${applicationId}.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION'
]);

/**
 * Pakettien näkyvyys (<queries>): puheentunnistuspalvelu ja puhesynteesi.
 * Ilman näitä Android 11+ piilottaa RecognitionServicen (SpeechPlugin ei
 * löydä tunnistinta) ja puhemoottorin (herätyksen puhe ei kuulu).
 */
export const REQUIRED_QUERY_INTENT_ACTIONS = Object.freeze([
  'android.speech.RecognitionService',
  'android.intent.action.TTS_SERVICE'
]);

/**
 * assets/capacitor.plugins.json: TÄSMÄLLEEN nämä. Repon oma SpeechPlugin
 * rekisteröidään käsin MainActivityssä, joten se ei näy tässä.
 */
export const EXPECTED_CAPACITOR_PLUGINS = Object.freeze([
  '@capacitor/app',
  '@capacitor/geolocation',
  '@capacitor/local-notifications'
]);

/**
 * Ulospäin avoimet komponentit (android:exported="true") — vain nämä.
 * ProfileInstallReceiver tulee androidx.profileinstallerista ja on
 * suojattu DUMP-luvalla (vain adb/järjestelmä).
 */
export const ALLOWED_EXPORTED_COMPONENTS = Object.freeze([
  Object.freeze({ name: '${applicationId}.MainActivity', permission: null }),
  Object.freeze({ name: 'androidx.profileinstaller.ProfileInstallReceiver', permission: 'android.permission.DUMP' })
]);

/**
 * Nykyisen debug-avaimen (~/.android/debug.keystore, luotu 2026-08-16)
 * varmenteen SHA-256. Julkinen tunniste, ei salaisuus. Jos tämä vaihtuu,
 * laitteessa oleva sovellus ei päivity uudella APK:lla vaan se on
 * poistettava ensin — siksi eroavuus kaataa tarkastuksen.
 */
export const EXPECTED_SIGNER_CERT_SHA256 =
  'cfc9d823cc2266354b62914f26c725b572e8fea6de6edc6172cd1608c624d740';

/** SDK-tasot, jos android/variables.gradle ei ole luettavissa. */
export const DEFAULT_MIN_SDK = 24;
export const DEFAULT_TARGET_SDK = 36;

/** Capacitorin lisäämät tyhjät tiedostot assets/public/-hakemistossa. */
export const CAPACITOR_EXTRA_ASSETS = Object.freeze(['cordova.js', 'cordova_plugins.js']);

/**
 * scripts/build-web.mjs:n kopioimat tiedostot (peili; testi vartioi,
 * että lista pysyy samana kuin build-web.mjs:ssä).
 */
export const WEB_ROOT_FILES = Object.freeze([
  'index.html', 'manifest.json', 'sw.js', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'
]);
export const WEB_DIRECTORIES = Object.freeze(['src', 'vendor']);

/** Polut, joita APK:n web-sisällössä ei saa olla. */
const FORBIDDEN_WEB_PREFIXES = Object.freeze([
  'tests/', 'docs/', 'supabase/', 'api/', 'node_modules/', 'android/', 'tools/', 'scripts/'
]);

const TEXT_EXTENSIONS = new Set(['.html', '.js', '.mjs', '.css', '.json', '.webmanifest', '.svg', '.txt', '.md', '.xml']);

const SECRET_PATTERNS = Object.freeze([/sk-ant-[A-Za-z0-9_-]{10}/, /service_role/]);

const CR = 13;
const LINES = /\r?\n/;

// ------------------------------------------------------------ apufunktiot

/** Korvaa ${applicationId} sovellustunnuksella. */
export function withAppId(name, appId = APP_ID) {
  return name.split(APPLICATION_ID_PLACEHOLDER).join(appId);
}

/** Odotettu lupajoukko tälle sovellustunnukselle, aakkosjärjestyksessä. */
export function expectedPermissions(appId = APP_ID) {
  return APK_PERMISSION_ALLOWLIST.map(p => withAppId(p, appId)).sort();
}

/** Onko lupa APK_FORBIDDEN_PERMISSIONS-listalla (`*` = etuliite)? */
export function isForbiddenPermission(permission) {
  return APK_FORBIDDEN_PERMISSIONS.some(rule => rule.endsWith('*')
    ? permission.startsWith(rule.slice(0, -1))
    : permission === rule);
}

function check(id, ok, detail) {
  return Object.freeze({ id, ok: Boolean(ok), detail: String(detail) });
}

function setDiff(actual, expected) {
  const a = new Set(actual);
  const e = new Set(expected);
  return {
    missing: [...e].filter(x => !a.has(x)).sort(),
    extra: [...a].filter(x => !e.has(x)).sort()
  };
}

function describeDiff({ missing, extra }) {
  const parts = [];
  if (missing.length) parts.push('puuttuu: ' + missing.join(', '));
  if (extra.length) parts.push('ylimääräinen: ' + extra.join(', '));
  return parts.join('; ');
}

// --------------------------------------------------------------- jäsentimet

/**
 * `aapt2 dump badging` -tuloste.
 *
 * `features`: feature-groupin laitteisto-ominaisuudet. `uses-feature:` on
 * pakollinen (myös lupien implisiittisesti vaatimat, esim. RECORD_AUDIO ->
 * mikrofoni), `uses-feature-not-required:` valinnainen. Tieto on
 * kuvaileva: sivuladattavan APK:n asennusta ominaisuudet eivät estä, eikä
 * mikään tarkistus kaadu valinnaiseen ominaisuuteen (esim. mikrofoni
 * required="false").
 *
 * @returns {{ packageName: string|null, versionCode: string|null,
 *   versionName: string|null, compileSdk: string|null, minSdk: number|null,
 *   targetSdk: number|null, debuggable: boolean, permissions: string[],
 *   launchableActivity: string|null, features: { name: string, required: boolean }[] }}
 */
export function parseBadging(text) {
  const result = {
    packageName: null, versionCode: null, versionName: null, compileSdk: null,
    minSdk: null, targetSdk: null, debuggable: false, permissions: [], launchableActivity: null,
    features: []
  };
  for (const raw of String(text || '').split(LINES)) {
    const line = raw.trimEnd();
    if (line.startsWith('package:')) {
      const attrs = Object.fromEntries([...line.matchAll(/(\w+)='([^']*)'/g)].map(m => [m[1], m[2]]));
      result.packageName = attrs.name ?? null;
      result.versionCode = attrs.versionCode ?? null;
      result.versionName = attrs.versionName ?? null;
      result.compileSdk = attrs.compileSdkVersion ?? null;
      continue;
    }
    let m;
    if ((m = /^(?:minSdkVersion|sdkVersion):'(\d+)'/.exec(line))) result.minSdk = Number(m[1]);
    else if ((m = /^targetSdkVersion:'(\d+)'/.exec(line))) result.targetSdk = Number(m[1]);
    else if ((m = /^uses-permission(?:-sdk-23)?: name='([^']+)'/.exec(line))) result.permissions.push(m[1]);
    else if (line.trim() === 'application-debuggable') result.debuggable = true;
    else if ((m = /^launchable-activity: name='([^']+)'/.exec(line))) result.launchableActivity = m[1];
    else if ((m = /^\s*uses-feature(-not-required)?: name='([^']+)'/.exec(line))) {
      result.features.push({ name: m[2], required: !m[1] });
    }
  }
  return result;
}

/**
 * `aapt2 dump permissions` -tuloste.
 *
 * @returns {{ packageName: string|null, requested: string[], declared: string[] }}
 */
export function parsePermissionsDump(text) {
  const result = { packageName: null, requested: [], declared: [] };
  for (const raw of String(text || '').split(LINES)) {
    const line = raw.trim();
    let m;
    if ((m = /^package: (\S+)/.exec(line))) result.packageName = m[1];
    else if ((m = /^uses-permission(?:-sdk-23)?: name='([^']+)'/.exec(line))) result.requested.push(m[1]);
    else if ((m = /^permission: (\S+)/.exec(line))) result.declared.push(m[1]);
  }
  return result;
}

/**
 * `aapt2 dump xmltree --file AndroidManifest.xml` -tuloste puuksi.
 *
 * Rivit: `E: nimi (line=N)` = elementti, `A: avain=arvo` = attribuutti,
 * `N:` = nimiavaruus (ohitetaan). Hierarkia sisennyksestä: attribuutti
 * kuuluu lähimpään vähemmän sisennettyyn elementtiin.
 * Android-nimiavaruuden URI lyhennetään muotoon `android:`.
 */
export function parseXmlTree(text) {
  const root = { name: '#document', line: null, attrs: {}, children: [], indent: -1 };
  const stack = [root];
  const popTo = indent => {
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
  };
  for (const raw of String(text || '').split(LINES)) {
    if (!raw.trim()) continue;
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();
    if (line.startsWith('E: ')) {
      const m = /^E: (\S+)(?: \(line=(\d+)\))?/.exec(line);
      popTo(indent);
      const element = { name: m[1], line: m[2] ? Number(m[2]) : null, attrs: {}, children: [], indent };
      stack[stack.length - 1].children.push(element);
      stack.push(element);
    } else if (line.startsWith('A: ')) {
      popTo(indent);
      const body = line.slice(3);
      const eq = body.indexOf('=');
      if (eq === -1) continue;
      const key = body.slice(0, eq)
        .replace(/\(0x[0-9a-fA-F]+\)$/, '')
        .replace('http://schemas.android.com/apk/res/android:', 'android:');
      let value = body.slice(eq + 1);
      if (value.startsWith('"')) {
        const end = value.indexOf('"', 1);
        value = value.slice(1, end === -1 ? undefined : end);
      } else {
        value = value.split(' ')[0];
      }
      stack[stack.length - 1].attrs[key] = value;
    }
  }
  return root;
}

const COMPONENT_TAGS = new Set(['activity', 'activity-alias', 'service', 'receiver', 'provider']);

/**
 * Onko komponentti avoin ulospäin? FAIL CLOSED: vain kirjaimellinen
 * `false` sulkee. Mikä tahansa muu arvo (resurssiviittaus `@0x7f…`,
 * tyypitetty luku, `true`) tulkitaan avoimeksi. Ilman attribuuttia
 * Androidin oletus: avoin, jos komponentilla on intent-filter.
 */
function isExported(component) {
  const value = component.attrs['android:exported'];
  if (value === undefined) return component.children.some(x => x.name === 'intent-filter');
  return value !== 'false';
}

/** Tarkastuksen kannalta olennaiset tiedot manifestipuusta. */
export function manifestFacts(tree) {
  const manifest = (tree.children || []).find(e => e.name === 'manifest');
  if (!manifest) return null;
  const children = manifest.children;
  const application = children.find(e => e.name === 'application') || { attrs: {}, children: [] };

  const components = application.children.filter(e => COMPONENT_TAGS.has(e.name));
  const exported = components
    .filter(isExported)
    .map(c => ({
      tag: c.name,
      name: c.attrs['android:name'] || null,
      permission: c.attrs['android:permission'] || null,
      explicit: c.attrs['android:exported'] !== undefined,
      exportedValue: c.attrs['android:exported'] ?? null
    }));

  const queryIntentActions = [];
  for (const queries of children.filter(e => e.name === 'queries')) {
    for (const intent of queries.children.filter(e => e.name === 'intent')) {
      for (const action of intent.children.filter(e => e.name === 'action')) {
        if (action.attrs['android:name']) queryIntentActions.push(action.attrs['android:name']);
      }
    }
  }

  return {
    packageName: manifest.attrs.package || null,
    versionCode: manifest.attrs['android:versionCode'] ?? null,
    versionName: manifest.attrs['android:versionName'] ?? null,
    usesPermissions: children
      .filter(e => e.name === 'uses-permission' || e.name === 'uses-permission-sdk-23')
      .map(e => e.attrs['android:name']),
    declaredPermissions: children.filter(e => e.name === 'permission')
      .map(e => ({ name: e.attrs['android:name'], protectionLevel: e.attrs['android:protectionLevel'] ?? null })),
    usesFeatures: children.filter(e => e.name === 'uses-feature')
      .map(e => ({ name: e.attrs['android:name'] ?? null, required: e.attrs['android:required'] !== 'false' })),
    application: {
      debuggable: application.attrs['android:debuggable'] ?? null,
      allowBackup: application.attrs['android:allowBackup'] ?? null,
      usesCleartextTraffic: application.attrs['android:usesCleartextTraffic'] ?? null
    },
    exported,
    queryIntentActions
  };
}

/**
 * `apksigner verify --print-certs -v` -tuloste.
 *
 * @returns {{ verifies: boolean, schemes: object, signerCount: number|null,
 *   signers: { dn: string|null, certSha256: string|null }[], warnings: string[] }}
 */
export function parseApksigner(text) {
  const lines = String(text || '').split(LINES).map(l => l.trim()).filter(Boolean);
  const schemes = {};
  const signers = [];
  const warnings = [];
  let signerCount = null;
  let verifies = false;
  for (const line of lines) {
    let m;
    if (line === 'Verifies') verifies = true;
    else if ((m = /^Verified using (v[\d.]+) scheme .*: (true|false)$/.exec(line))) {
      schemes[m[1].replace('.', '')] = m[2] === 'true';
    } else if ((m = /^Number of signers: (\d+)$/.exec(line))) signerCount = Number(m[1]);
    else if ((m = /^Signer #(\d+) certificate DN: (.*)$/.exec(line))) {
      (signers[Number(m[1]) - 1] ||= { dn: null, certSha256: null }).dn = m[2];
    } else if ((m = /^Signer #(\d+) certificate SHA-256 digest: ([0-9a-fA-F]{64})$/.exec(line))) {
      (signers[Number(m[1]) - 1] ||= { dn: null, certSha256: null }).certSha256 = m[2].toLowerCase();
    } else if (/^WARNING/i.test(line) || /^ERROR/i.test(line) || /DOES NOT VERIFY/.test(line)) {
      warnings.push(line);
    }
  }
  if (lines.some(l => /DOES NOT VERIFY/.test(l))) verifies = false;
  return { verifies, schemes, signerCount, signers: signers.filter(Boolean), warnings };
}

/** android/variables.gradle: minSdkVersion ja targetSdkVersion. */
export function parseVariablesGradle(text) {
  const read = key => {
    const m = new RegExp(`\\b${key}\\s*=\\s*(\\d+)`).exec(String(text || ''));
    return m ? Number(m[1]) : null;
  };
  return { minSdk: read('minSdkVersion'), targetSdk: read('targetSdkVersion') };
}

// ------------------------------------------------------------- tarkistukset

/**
 * Badging-tiedot odotuksia vasten.
 *
 * @param {object} expect
 * @param {number|number[]|null} [expect.versionCode] täsmällinen arvo tai sallitut arvot
 * @param {string|null} [expect.versionName] täsmällinen nimi (debugissa päätteineen)
 */
export function checkBadging(badging, {
  appId = APP_ID, versionCode = null, versionName = null,
  minSdk = DEFAULT_MIN_SDK, targetSdk = DEFAULT_TARGET_SDK, buildType = 'debug'
} = {}) {
  const checks = [];
  checks.push(check('badging.package', badging.packageName === appId,
    `package name='${badging.packageName}' (odotettu '${appId}', ei päätettä)`));

  const code = Number(badging.versionCode);
  const inRange = /^\d+$/.test(String(badging.versionCode))
    && code >= VERSION_CODE_MIN && code <= VERSION_CODE_MAX;
  const allowedCodes = versionCode === null ? null : [].concat(versionCode);
  checks.push(check('badging.versionCode',
    inRange && (allowedCodes === null || allowedCodes.includes(code)),
    `versionCode='${badging.versionCode}'`
    + (allowedCodes ? ` (odotettu ${allowedCodes.join(' tai ')})` : ` (sallittu ${VERSION_CODE_MIN}..${VERSION_CODE_MAX})`)));

  const shaInName = /-wave[A-Z]+\.v\d+\+[0-9a-f]{7}\b/.test(String(badging.versionName || ''));
  checks.push(check('badging.versionName',
    shaInName && (versionName === null || badging.versionName === versionName),
    `versionName='${badging.versionName}'`
    + (versionName !== null ? ` (odotettu '${versionName}')` : ' (odotettu muoto x.y.z-wave<X>.v<N>+<sha7>)')));

  checks.push(check('badging.minSdk', badging.minSdk === minSdk,
    `minSdkVersion=${badging.minSdk} (odotettu ${minSdk})`));
  checks.push(check('badging.targetSdk', badging.targetSdk === targetSdk,
    `targetSdkVersion=${badging.targetSdk} (odotettu ${targetSdk})`));

  const wantDebuggable = buildType === 'debug';
  checks.push(check('badging.debuggable', badging.debuggable === wantDebuggable,
    `application-debuggable ${badging.debuggable ? 'on' : 'ei ole'} mukana `
    + `(${buildType}: odotettu ${wantDebuggable ? 'mukana' : 'poissa'})`));

  const diff = setDiff(badging.permissions, expectedPermissions(appId));
  checks.push(check('badging.permissions', !diff.missing.length && !diff.extra.length,
    diff.missing.length || diff.extra.length ? describeDiff(diff) : 'täsmälleen sallittu joukko'));
  return checks;
}

/** `aapt2 dump permissions` odotuksia vasten. */
export function checkPermissions(dump, { appId = APP_ID } = {}) {
  const checks = [];
  checks.push(check('permissions.package', dump.packageName === appId,
    `package ${dump.packageName} (odotettu ${appId})`));

  const diff = setDiff(dump.requested, expectedPermissions(appId));
  checks.push(check('permissions.allowlist', !diff.missing.length && !diff.extra.length,
    diff.missing.length || diff.extra.length
      ? describeDiff(diff)
      : `täsmälleen ${APK_PERMISSION_ALLOWLIST.length} sallittua lupaa`));

  const forbidden = dump.requested.filter(isForbiddenPermission);
  checks.push(check('permissions.forbidden', forbidden.length === 0,
    forbidden.length ? 'kielletty lupa: ' + forbidden.join(', ') : 'ei kiellettyjä lupia'));

  const declaredDiff = setDiff(dump.declared, APK_DECLARED_PERMISSIONS.map(p => withAppId(p, appId)));
  checks.push(check('permissions.declared', declaredDiff.extra.length === 0,
    declaredDiff.extra.length ? 'sovellus määrittelee odottamattoman luvan: ' + declaredDiff.extra.join(', ')
      : 'vain sovelluksen oma signature-lupa'));
  return checks;
}

/** Yhdistetty manifesti (xmltree) odotuksia vasten. */
export function checkManifest(facts, { appId = APP_ID, buildType = 'debug' } = {}) {
  if (!facts) return [check('manifest.parse', false, 'AndroidManifest.xml:n puuta ei voitu jäsentää')];
  const checks = [];
  checks.push(check('manifest.package', facts.packageName === appId,
    `package="${facts.packageName}" (odotettu "${appId}")`));
  checks.push(check('manifest.allowBackup', facts.application.allowBackup === 'false',
    `android:allowBackup=${facts.application.allowBackup} (odotettu false: istunto ei pilveen)`));
  checks.push(check('manifest.usesCleartextTraffic', facts.application.usesCleartextTraffic === 'false',
    `android:usesCleartextTraffic=${facts.application.usesCleartextTraffic} (odotettu false)`));

  const debuggable = facts.application.debuggable === 'true';
  const wantDebuggable = buildType === 'debug';
  checks.push(check('manifest.debuggable', debuggable === wantDebuggable,
    `android:debuggable=${facts.application.debuggable} (${buildType})`));

  const diff = setDiff(facts.usesPermissions, expectedPermissions(appId));
  checks.push(check('manifest.permissions', !diff.missing.length && !diff.extra.length,
    diff.missing.length || diff.extra.length ? describeDiff(diff) : 'uses-permission = sallittu joukko'));

  const declared = facts.declaredPermissions;
  const weakDeclared = declared.filter(p => {
    const level = p.protectionLevel === null ? 0 : parseInt(p.protectionLevel, 16);
    return (level & 0xf) !== 0x2;
  });
  checks.push(check('manifest.declaredProtection', weakDeclared.length === 0,
    weakDeclared.length ? 'ei signature-tasoinen: ' + weakDeclared.map(p => p.name).join(', ')
      : 'määritellyt luvat ovat signature-tasoisia'));

  const allowed = ALLOWED_EXPORTED_COMPONENTS.map(c => ({ ...c, name: withAppId(c.name, appId) }));
  const problems = [];
  for (const component of facts.exported) {
    const rule = allowed.find(a => a.name === component.name);
    const literal = !component.explicit || component.exportedValue === 'true';
    if (!literal) {
      problems.push(`${component.tag} ${component.name}: android:exported=${component.exportedValue} `
        + 'ei ole kirjaimellinen true/false (tulkitaan avoimeksi)');
    }
    if (!rule) problems.push(`${component.tag} ${component.name} on avoin`
      + (component.explicit ? '' : ' (intent-filter ilman android:exported)'));
    else if (rule.permission && component.permission !== rule.permission) {
      problems.push(`${component.name}: android:permission=${component.permission} (odotettu ${rule.permission})`);
    }
  }
  const main = withAppId(ALLOWED_EXPORTED_COMPONENTS[0].name, appId);
  if (!facts.exported.some(c => c.name === main)) problems.push(`${main} ei ole avoin (käynnistin puuttuu)`);
  checks.push(check('manifest.exported', problems.length === 0,
    problems.length ? problems.join('; ') : 'avoimina vain MainActivity ja DUMP-suojattu ProfileInstallReceiver'));

  const missingQueries = REQUIRED_QUERY_INTENT_ACTIONS.filter(a => !facts.queryIntentActions.includes(a));
  checks.push(check('manifest.queries', missingQueries.length === 0,
    missingQueries.length
      ? '<queries><intent><action> puuttuu: ' + missingQueries.join(', ')
      : '<queries> sisältää ' + REQUIRED_QUERY_INTENT_ACTIONS.join(', ')));
  return checks;
}

/** Badgingin, xmltreen ja permissions-dumpin keskinäinen yhtäpitävyys. */
export function checkCrossSource({ badging, facts }) {
  const checks = [];
  if (!facts) return checks;
  checks.push(check('cross.versionCode', String(facts.versionCode) === String(badging.versionCode),
    `badging ${badging.versionCode}, manifesti ${facts.versionCode}`));
  checks.push(check('cross.versionName', facts.versionName === badging.versionName,
    `badging '${badging.versionName}', manifesti '${facts.versionName}'`));
  return checks;
}

/** apksignerin tulos odotuksia vasten. */
export function checkSigner(signer, { expectedCert = EXPECTED_SIGNER_CERT_SHA256 } = {}) {
  const checks = [];
  checks.push(check('signer.verifies', signer.verifies,
    signer.verifies ? 'Verifies' : 'apksigner ei todentanut allekirjoitusta: ' + signer.warnings.join(' | ')));
  checks.push(check('signer.v2', signer.schemes.v2 === true,
    `APK Signature Scheme v2: ${signer.schemes.v2}`));
  checks.push(check('signer.count', signer.signerCount === 1 && signer.signers.length === 1,
    `allekirjoittajia ${signer.signerCount}`));
  const actual = signer.signers[0] ? signer.signers[0].certSha256 : null;
  const expected = expectedCert ? String(expectedCert).toLowerCase() : null;
  checks.push(check('signer.cert', Boolean(actual) && actual === expected,
    `varmenteen SHA-256 ${actual} (odotettu ${expected}). Eri avain = laitteen sovellus `
    + 'pitää poistaa ennen asennusta'));
  return checks;
}

/** assets/capacitor.plugins.json. */
export function checkPlugins(text) {
  let list;
  try { list = JSON.parse(String(text)); } catch (error) {
    return [check('assets.plugins', false, 'capacitor.plugins.json ei ole JSONia: ' + error.message)];
  }
  if (!Array.isArray(list)) return [check('assets.plugins', false, 'capacitor.plugins.json ei ole taulukko')];
  const diff = setDiff(list.map(p => p && p.pkg), EXPECTED_CAPACITOR_PLUGINS);
  return [check('assets.plugins', !diff.missing.length && !diff.extra.length,
    diff.missing.length || diff.extra.length ? describeDiff(diff)
      : 'liitännäiset: ' + EXPECTED_CAPACITOR_PLUGINS.join(', '))];
}

/** assets/capacitor.config.json === repon capacitor.config.json (JSON-tasolla). */
export function checkCapacitorConfig(apkText, repoText) {
  let apk; let repo;
  try { apk = JSON.parse(String(apkText)); repo = JSON.parse(String(repoText)); } catch (error) {
    return [check('assets.capacitorConfig', false, 'JSON-virhe: ' + error.message)];
  }
  return [check('assets.capacitorConfig', isDeepStrictEqual(apk, repo),
    isDeepStrictEqual(apk, repo) ? 'sama kuin repon capacitor.config.json'
      : 'eroaa repon capacitor.config.jsonista')];
}

// ------------------------------------------------------ assettien vertailu

function isTextPath(relativePath) {
  return TEXT_EXTENSIONS.has(path.posix.extname(relativePath).toLowerCase());
}

function stripCr(buffer) {
  if (!buffer.includes(CR)) return buffer;
  return Buffer.from(buffer.filter(byte => byte !== CR));
}

/**
 * APK:n assets/public/ vertailupuuta vasten.
 *
 * @param {Map<string, Buffer>} apk APK:n tiedostot assets/public/:n alla
 * @param {Map<string, Buffer>} reference dist/ tai git-puu
 * @param {object} [options]
 * @param {boolean} [options.normalizeCr] hyväksy ero, joka on pelkkiä
 *   CR-tavuja tekstitiedostossa (git-blobit ovat LF, työpuu CRLF)
 */
export function compareAssetTrees(apk, reference, { normalizeCr = false } = {}) {
  const missing = []; const extra = []; const differing = []; const crOnly = []; const allowedExtra = [];
  for (const [file, expected] of reference) {
    const actual = apk.get(file);
    if (!actual) { missing.push(file); continue; }
    if (actual.equals(expected)) continue;
    if (normalizeCr && isTextPath(file) && stripCr(actual).equals(stripCr(expected))) crOnly.push(file);
    else differing.push(file);
  }
  for (const file of apk.keys()) {
    if (reference.has(file)) continue;
    if (CAPACITOR_EXTRA_ASSETS.includes(file)) allowedExtra.push(file);
    else extra.push(file);
  }
  const sort = list => list.sort();
  return {
    ok: missing.length === 0 && extra.length === 0 && differing.length === 0,
    compared: reference.size,
    missing: sort(missing), extra: sort(extra), differing: sort(differing),
    crOnly: sort(crOnly), allowedExtra: sort(allowedExtra)
  };
}

function describeComparison(result) {
  const parts = [];
  if (result.missing.length) parts.push(`puuttuu ${result.missing.length}: ${result.missing.slice(0, 5).join(', ')}`);
  if (result.extra.length) parts.push(`ylimääräisiä ${result.extra.length}: ${result.extra.slice(0, 5).join(', ')}`);
  if (result.differing.length) parts.push(`eroaa ${result.differing.length}: ${result.differing.slice(0, 5).join(', ')}`);
  return parts.join('; ');
}

/** Assettivertailu tarkistuksiksi (dist tavu tavulta, git CR-normalisoituna). */
export function checkAssets({ apk, dist = null, git = null }) {
  const checks = [];
  if (dist) {
    const result = compareAssetTrees(apk, dist, { normalizeCr: false });
    checks.push(check('assets.dist', result.ok, result.ok
      ? `${result.compared} tiedostoa tavu tavulta samat kuin dist/ (+ ${result.allowedExtra.join(', ') || 'ei lisiä'})`
      : describeComparison(result)));
  }
  if (git) {
    const result = compareAssetTrees(apk, git, { normalizeCr: true });
    checks.push(check('assets.git', result.ok, result.ok
      ? `${result.compared} tiedostoa samat kuin commitin blobit (${result.crOnly.length} eroaa vain CR-merkeiltä)`
      : describeComparison(result)));
  }
  return checks;
}

/**
 * Onko polku scripts/build-web.mjs:n mukaan osa web-koontia?
 * (juuren kuusi tiedostoa + src/** + vendor/**, ei src/package.json, ei pistetiedostoja)
 */
export function isWebBuildPath(relativePath) {
  const parts = relativePath.split('/');
  if (parts.some(part => part.startsWith('.'))) return false;
  if (relativePath === 'src/package.json') return false;
  if (WEB_ROOT_FILES.includes(relativePath)) return true;
  return WEB_DIRECTORIES.some(dir => relativePath.startsWith(dir + '/'));
}

/** APK:n web-sisällön rakenne, aalto ja salaisuudet. */
export function checkWebPayload(apk, { wave }) {
  const checks = [];
  const files = [...apk.keys()];

  const required = ['index.html', 'sw.js', 'src/app/main.js', 'src/styles.css', 'src/data/schema.js'];
  const absent = required.filter(f => !apk.has(f));
  checks.push(check('payload.required', absent.length === 0,
    absent.length ? 'puuttuu: ' + absent.join(', ') : 'index.html, sw.js, main.js, styles.css, schema.js'));

  const forbidden = files.filter(f => FORBIDDEN_WEB_PREFIXES.some(p => f.startsWith(p))
    || f === 'src/package.json' || f.split('/').some(part => part.startsWith('.')));
  checks.push(check('payload.forbiddenPaths', forbidden.length === 0,
    forbidden.length ? 'ei kuulu APK:hon: ' + forbidden.slice(0, 5).join(', ') : 'ei testejä, dokumentteja, api:a, supabasea'));

  const leaks = files.filter(f => isTextPath(f) && SECRET_PATTERNS.some(re => re.test(apk.get(f).toString('utf8'))));
  checks.push(check('payload.secrets', leaks.length === 0,
    leaks.length ? 'salaisuuden kaltainen merkkijono: ' + leaks.join(', ') : 'ei sk-ant-/service_role-merkkijonoja'));

  const cache = apk.has('sw.js') ? parseCacheVersion(apk.get('sw.js').toString('utf8')) : null;
  let expectedCache = null;
  try { expectedCache = cacheVersionOf(wave); } catch { expectedCache = null; }
  checks.push(check('payload.cacheVersion', cache !== null && cache === expectedCache,
    `sw.js CACHE_VERSION ${cache} (aalto ${wave} edellyttää ${expectedCache})`));

  const schema = apk.has('src/data/schema.js') ? apk.get('src/data/schema.js').toString('utf8') : '';
  const gates = parseGates(schema, { allowMissing: true });
  const resolved = gates ? resolveWave(gates) : null;
  checks.push(check('payload.wave', resolved === wave,
    `schema.js:n porttimatriisi vastaa aaltoa ${resolved} (odotettu ${wave})`));
  return checks;
}
