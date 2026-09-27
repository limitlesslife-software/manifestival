// Ehdokkaan lähdemanifesti (android/app/src/main/AndroidManifest.xml) ja
// MainActivity sallittua APK-lupajoukkoa vasten (tools/android/source-manifest.mjs).
//
// verify-apk tarkistaa valmiin APK:n yhdistetyn manifestin, ja
// tests/android.test.mjs lähdemanifestin säännöt tekstihauilla. Tämä
// tiedosto sitoo nämä yhteen: lähdemanifestin luvat JÄSENNETÄÄN ja
// verrataan samaan vakioon (APK_PERMISSION_ALLOWLIST), jota verify-apk
// käyttää. Sama tarkistus ajetaan hyväksyntäkoonnin esitarkistuksessa
// (`manifest.source`), joten puhe- ja sijaintimuutokset puuttuva ehdokas
// kaatuu ennen Gradlea.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { read } from './helpers/sources.mjs';
import { APK_PERMISSION_ALLOWLIST, REQUIRED_QUERY_INTENT_ACTIONS } from '../tools/android/apk.mjs';
import {
  MAIN_ACTIVITY, REQUIRED_PLUGIN_CLASSES, SOURCE_MANIFEST, SPEECH_PERMISSION, parseManifestXml,
  registersAlarmPlugin, registersPlugin, registersSpeechPlugin, sourceManifestFacts, sourceManifestProblems
} from '../tools/android/source-manifest.mjs';

const LOCATION = /^android\.permission\.ACCESS_\w*LOCATION$/;
const MANIFEST = read(SOURCE_MANIFEST);
const MAIN = read(MAIN_ACTIVITY);

// ------------------------------------------------ repon oma lähdemanifesti

test('lähdemanifestin luvat ovat APK_PERMISSION_ALLOWLISTin osajoukko', () => {
  const facts = sourceManifestFacts(MANIFEST);
  assert.ok(facts, `${SOURCE_MANIFEST}: <manifest> ei jäsentynyt`);
  assert.ok(facts.permissions.length > 0, 'yhtään uses-permissionia ei löytynyt: jäsennin ei osu');
  const outside = facts.permissions.filter(p => !APK_PERMISSION_ALLOWLIST.includes(p));
  assert.deepEqual(outside, [], 'lähdemanifesti julistaa luvan, jota verify-apk ei salli');
});

test('lähdemanifestissa on RECORD_AUDIO eikä yhtään sijaintilupaa', () => {
  const { permissions } = sourceManifestFacts(MANIFEST);
  assert.ok(permissions.includes('android.permission.RECORD_AUDIO'), 'RECORD_AUDIO puuttuu: SpeechPlugin ei saisi mikrofonia');
  assert.equal(SPEECH_PERMISSION, 'android.permission.RECORD_AUDIO');
  assert.deepEqual(permissions.filter(p => LOCATION.test(p)), [], 'sijaintilupa lähdemanifestissa');
});

test('lähdemanifestin <queries> sisältää android.speech.RecognitionService', () => {
  const { queryIntentActions } = sourceManifestFacts(MANIFEST);
  assert.ok(queryIntentActions.includes('android.speech.RecognitionService'));
  for (const action of REQUIRED_QUERY_INTENT_ACTIONS) assert.ok(queryIntentActions.includes(action), action);
});

test('repon lähdemanifesti ja MainActivity läpäisevät esitarkistuksen manifest.source-ehdot', () => {
  assert.deepEqual(sourceManifestProblems({ manifest: MANIFEST, mainActivity: MAIN }), []);
  assert.equal(registersSpeechPlugin(MAIN), true);
  assert.equal(registersAlarmPlugin(MAIN), true);
  assert.deepEqual([...REQUIRED_PLUGIN_CLASSES], ['SpeechPlugin', 'AlarmPlugin']);
});

test('lähdemanifestin herätysluvat: vain käyttäjän myöntämä tarkka herätys ja toiston etualapalvelu', () => {
  const { permissions, queryIntentActions } = sourceManifestFacts(MANIFEST);
  for (const name of ['RECEIVE_BOOT_COMPLETED', 'SCHEDULE_EXACT_ALARM', 'USE_FULL_SCREEN_INTENT',
    'FOREGROUND_SERVICE', 'FOREGROUND_SERVICE_MEDIA_PLAYBACK', 'POST_NOTIFICATIONS', 'WAKE_LOCK']) {
    assert.ok(permissions.includes('android.permission.' + name), name + ' puuttuu');
  }
  assert.equal(permissions.includes('android.permission.USE_EXACT_ALARM'), false);
  assert.deepEqual(permissions.filter(p => /FOREGROUND_SERVICE_/.test(p)), ['android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK']);
  assert.ok(queryIntentActions.includes('android.intent.action.TTS_SERVICE'));
});

// -------------------------------------------------------------- jäsennin

const WRAP = body => '<?xml version="1.0" encoding="utf-8"?>\n'
  + '<manifest xmlns:android="http://schemas.android.com/apk/res/android">\n'
  + '    <application android:allowBackup="false">\n'
  + '        <activity android:name=".MainActivity" android:exported="true" />\n'
  + '    </application>\n' + body + '</manifest>\n';
const PERM = name => `    <uses-permission android:name="android.permission.${name}" />\n`;
const QUERIES = '    <queries>\n        <intent>\n'
  + '            <action android:name="android.speech.RecognitionService" />\n'
  + '        </intent>\n        <intent>\n'
  + '            <action android:name="android.intent.action.TTS_SERVICE" />\n'
  + '        </intent>\n    </queries>\n';
const GOOD = WRAP(PERM('INTERNET') + PERM('RECORD_AUDIO') + QUERIES);
const GOOD_MAIN = 'public class MainActivity extends BridgeActivity {\n'
  + '    protected void onCreate(Bundle s) {\n        registerPlugin(SpeechPlugin.class);\n'
  + '        registerPlugin(AlarmPlugin.class);\n'
  + '        super.onCreate(s);\n    }\n}\n';
const problems = (manifest, mainActivity = GOOD_MAIN) => sourceManifestProblems({ manifest, mainActivity });

test('jäsennin: kommentit ohitetaan, monirivinen elementti ja sisäkkäisyys toimivat', () => {
  assert.deepEqual(problems(GOOD), []);
  const commented = WRAP(PERM('INTERNET') + PERM('RECORD_AUDIO')
    + '    <!-- <uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" /> -->\n' + QUERIES);
  assert.deepEqual(sourceManifestFacts(commented).permissions,
    ['android.permission.INTERNET', 'android.permission.RECORD_AUDIO']);
  const multiline = WRAP(PERM('INTERNET') + '    <uses-permission\n        android:name="android.permission.RECORD_AUDIO"\n    />\n' + QUERIES);
  assert.deepEqual(problems(multiline), []);
  const tree = parseManifestXml(GOOD);
  assert.deepEqual(tree.children.map(e => e.name), ['manifest']);
  assert.deepEqual(tree.children[0].children.map(e => e.name), ['application', 'uses-permission', 'uses-permission', 'queries']);
});

test('sijaintilupa kaatuu, myös väärin sisäkkäisenä; tools:node="remove" ei ole julistus', () => {
  const coarse = WRAP(PERM('INTERNET') + PERM('RECORD_AUDIO') + PERM('ACCESS_COARSE_LOCATION') + QUERIES);
  assert.match(problems(coarse).join(' | '), /sijaintilupa: android\.permission\.ACCESS_COARSE_LOCATION/);
  const nested = GOOD.replace('</application>', PERM('ACCESS_FINE_LOCATION') + '    </application>');
  assert.match(problems(nested).join(' | '), /sijaintilupa: android\.permission\.ACCESS_FINE_LOCATION/);
  const removed = WRAP(PERM('INTERNET') + PERM('RECORD_AUDIO') + QUERIES
    + '    <uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" tools:node="remove" />\n');
  assert.deepEqual(problems(removed), []);
  assert.deepEqual(sourceManifestFacts(removed).removedPermissions, ['android.permission.ACCESS_FINE_LOCATION']);
});

test('puuttuva RECORD_AUDIO, puuttuva <queries>, kielletty tai tuntematon lupa kaatavat', () => {
  // Vanha (ennen puhetta) manifesti: vain INTERNET, ei <queries>-kohtaa.
  const old = problems(WRAP(PERM('INTERNET')));
  assert.equal(old.length, 2);
  assert.match(old[0], /RECORD_AUDIO puuttuu/);
  assert.match(old[1], /<queries><intent><action> puuttuu: android\.speech\.RecognitionService/);
  const camera = problems(WRAP(PERM('INTERNET') + PERM('RECORD_AUDIO') + PERM('CAMERA') + QUERIES));
  assert.deepEqual(camera, ['kielletty lupa: android.permission.CAMERA']);
  const vibrate = problems(WRAP(PERM('INTERNET') + PERM('RECORD_AUDIO') + PERM('VIBRATE') + QUERIES));
  assert.match(vibrate.join(' | '), /ei kuulu sallittuun joukkoon[^|]*VIBRATE/);
});

test('herätysluvat: USE_EXACT_ALARM ja muut kuin toiston etualapalvelut kaatuvat, toisto kelpaa', () => {
  const alarm = PERM('RECEIVE_BOOT_COMPLETED') + PERM('SCHEDULE_EXACT_ALARM') + PERM('USE_FULL_SCREEN_INTENT')
    + PERM('FOREGROUND_SERVICE') + PERM('FOREGROUND_SERVICE_MEDIA_PLAYBACK') + PERM('POST_NOTIFICATIONS') + PERM('WAKE_LOCK');
  assert.deepEqual(problems(WRAP(PERM('INTERNET') + PERM('RECORD_AUDIO') + alarm + QUERIES)), []);
  assert.deepEqual(problems(WRAP(PERM('INTERNET') + PERM('RECORD_AUDIO') + PERM('USE_EXACT_ALARM') + QUERIES)),
    ['kielletty lupa: android.permission.USE_EXACT_ALARM']);
  for (const type of ['MICROPHONE', 'LOCATION', 'DATA_SYNC', 'SPECIAL_USE', 'CAMERA']) {
    assert.deepEqual(problems(WRAP(PERM('INTERNET') + PERM('RECORD_AUDIO') + PERM('FOREGROUND_SERVICE_' + type) + QUERIES)),
      ['kielletty lupa: android.permission.FOREGROUND_SERVICE_' + type], type);
  }
  // Puhemoottorin näkyvyys puuttuu -> kaatuu.
  const noTts = WRAP(PERM('INTERNET') + PERM('RECORD_AUDIO') + QUERIES.replace(
    '        <intent>\n            <action android:name="android.intent.action.TTS_SERVICE" />\n        </intent>\n', ''));
  assert.deepEqual(problems(noTts), ['<queries><intent><action> puuttuu: android.intent.action.TTS_SERVICE']);
});

test('MainActivity: AlarmPlugin puuttuu tai rekisteröidään super.onCreaten jälkeen -> kaatuu', () => {
  assert.deepEqual(problems(GOOD, GOOD_MAIN.replace('registerPlugin(AlarmPlugin.class);\n', '')),
    ['MainActivity ei rekisteröi AlarmPluginia ennen super.onCreatea']);
  const late = GOOD_MAIN.replace('        registerPlugin(AlarmPlugin.class);\n', '')
    .replace('super.onCreate(s);', 'super.onCreate(s);\n        registerPlugin(AlarmPlugin.class);');
  assert.equal(registersAlarmPlugin(late), false);
  assert.equal(registersSpeechPlugin(late), true);
  assert.equal(registersPlugin(GOOD_MAIN, 'Alarm.*'), false, 'luokan nimi ei ole säännöllinen lauseke');
});

test('MainActivity: rekisteröinti puuttuu, on kommentissa tai super.onCreaten jälkeen -> kaatuu', () => {
  assert.match(problems(GOOD, GOOD_MAIN.replace('registerPlugin(SpeechPlugin.class);', '')).join(), /SpeechPlugin/);
  assert.match(problems(GOOD, GOOD_MAIN.replace('registerPlugin', '// registerPlugin')).join(), /SpeechPlugin/);
  const late = 'class MainActivity {\n  void onCreate(Bundle s) {\n    super.onCreate(s);\n'
    + '    registerPlugin(SpeechPlugin.class);\n  }\n}\n';
  assert.equal(registersSpeechPlugin(late), false);
  assert.deepEqual(problems(null, null), [`${SOURCE_MANIFEST} puuttuu`, `${MAIN_ACTIVITY} puuttuu`]);
  assert.match(problems('<foo/>').join(), /<manifest>-elementtiä ei löydy/);
});

test('valinnainen mikrofoni (uses-feature required="false") ei kaada lähdetarkistusta', () => {
  const feature = '    <uses-feature android:name="android.hardware.microphone" android:required="false" />\n';
  const withFeature = WRAP(PERM('INTERNET') + PERM('RECORD_AUDIO') + feature + QUERIES);
  assert.deepEqual(sourceManifestFacts(withFeature).usesFeatures, [{ name: 'android.hardware.microphone', required: false }]);
  assert.deepEqual(problems(withFeature), []);
  // Repon oma manifesti: jos mikrofoni julistetaan ominaisuutena, se on valinnainen.
  for (const f of sourceManifestFacts(MANIFEST).usesFeatures.filter(x => x.name === 'android.hardware.microphone')) {
    assert.equal(f.required, false, 'pakollinen mikrofoni rajaisi jakelun laitteisiin, joissa on mikrofoni');
  }
});
