// Herätysliitännäisen (ManifestivalAlarm) rakenteelliset vartijat.
//
// Java-koodia ei ajeta tässä: nämä testit lukevat lähteen ja manifestin
// ja pitävät kiinni päätöksistä, jotka rikkoutuisivat hiljaa vasta
// puhelimessa (ks. docs/DEVICE-ACCEPTANCE-BACKLOG.md, herätys). Puhtaat
// apufunktiot (seinäkello -> hetki, tunnisteen tiiviste, linkin kokoaminen)
// testataan JUnitilla: android/app/src/test/.../AlarmMathTest.java
// (gradlew testDebugUnitTest).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { ROOT, read, readCode } from './helpers/sources.mjs';
import { NATIVE_ALARM_PLUGIN } from '../src/platform/capabilities.js';
import { ALARM_EVENTS, ALARM_LIMITS, NATIVE_ALARM_EVENT } from '../src/platform/alarms.js';
import { MAX_ALARM_RING_MINUTES, MAX_SNOOZE_MINUTES, MAX_SNOOZES } from '../src/domain/dailyLife.js';
import { MAX_ESCALATION_STEPS, DEFAULT_SNOOZE_MINUTES } from '../src/domain/alarmPlan.js';

const JAVA_DIR = 'android/app/src/main/java/fi/limitlesslife/manifestival';
const ALARM_FILES = Object.freeze([
  'AlarmActivity.java', 'AlarmMath.java', 'AlarmPlugin.java', 'AlarmReceiver.java',
  'AlarmScheduler.java', 'AlarmService.java', 'AlarmStore.java', 'BootReceiver.java'
]);

/** Java ilman kommentteja: kiellot koskevat koodia, eivät selityksiä. */
function javaCode(file) {
  return read(`${JAVA_DIR}/${file}`)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter(line => !line.trim().startsWith('//')).join('\n')
    .replace(/\s\/\/[^\n"]*$/gm, '');
}

/** Metodin runko (aaltosulkeiden tasapainolla) nimen perusteella. */
function methodBody(code, signature) {
  const start = code.indexOf(signature);
  assert.ok(start > -1, 'metodia ei löydy: ' + signature);
  const open = code.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < code.length; index++) {
    if (code[index] === '{') depth++;
    else if (code[index] === '}') {
      depth--;
      if (depth === 0) return code.slice(open, index + 1);
    }
  }
  throw new Error('runko ei pääty: ' + signature);
}

function allJava() {
  return fs.readdirSync(path.join(ROOT, JAVA_DIR)).filter(name => name.endsWith('.java'));
}

const manifest = read('android/app/src/main/AndroidManifest.xml');

/** Manifestin komponentti-elementti nimen perusteella (koko tagi). */
function component(tag, name) {
  const match = new RegExp(`<${tag}\\b[^>]*android:name="\\.${name}"[^>]*?(/>|>)`).exec(manifest);
  assert.ok(match, `${tag} ${name} puuttuu manifestista`);
  return match[0];
}

// ------------------------------------------------------------ nimi ja metodit

test('liitännäisen nimi ja tapahtuman nimi ovat samat Javassa ja JS:ssä', () => {
  const java = javaCode('AlarmPlugin.java');
  const name = /@CapacitorPlugin\(\s*name\s*=\s*"([^"]+)"\s*\)/.exec(java);
  assert.ok(name, '@CapacitorPlugin(name = ...) puuttuu');
  assert.equal(name[1], NATIVE_ALARM_PLUGIN);
  assert.equal(name[1], 'ManifestivalAlarm');
  assert.match(java, new RegExp(`static final String EVENT = "${NATIVE_ALARM_EVENT}"`));
  // Ei lupa-aliaksia: liitännäinen ei kysy yhtään ajonaikaista lupaa.
  assert.equal(/permissions\s*=/.test(java.slice(java.indexOf('@CapacitorPlugin'), java.indexOf('public class AlarmPlugin'))), false);
});

/** Capacitorin Plugin-perusluokan omat metodit. */
const CAPACITOR_PLUGIN_BUILTINS = new Set(['addListener', 'removeAllListeners', 'checkPermissions', 'requestPermissions']);

test('KRIITTINEN: jokainen JS:n kutsuma metodi on Javassa @PluginMethod, eikä kuollutta natiivimetodia ole', () => {
  const java = javaCode('AlarmPlugin.java');
  const javaMethods = new Set([...java.matchAll(/@PluginMethod\s+public void (\w+)\(PluginCall call\)/g)].map(m => m[1]));
  assert.ok(javaMethods.has('schedule') && javaMethods.has('status'), 'Javan metodihaku on rikki');

  const js = readCode('src/platform/alarms.js');
  const jsCalls = new Set([
    ...[...js.matchAll(/callPlugin\(\s*plugin\s*,\s*'(\w+)'/g)].map(m => m[1]),
    ...[...js.matchAll(/\bplugin\.(\w+)\(/g)].map(m => m[1])
  ]);
  assert.ok(jsCalls.has('schedule') && jsCalls.has('consumeEvents') && jsCalls.has('addListener'), 'JS:n kutsuhaku on rikki');

  const missing = [...jsCalls].filter(n => !javaMethods.has(n) && !CAPACITOR_PLUGIN_BUILTINS.has(n));
  assert.deepEqual(missing, [], 'JS kutsuu metodia, jota Javassa ei ole (undefined vasta puhelimessa)');
  const unused = [...javaMethods].filter(n => !jsCalls.has(n));
  assert.deepEqual(unused, [], 'natiivimetodi ilman JS-kutsujaa');
  assert.deepEqual([...javaMethods].sort(), [
    'cancel', 'cancelAll', 'consumeEvents', 'list', 'openExactAlarmSettings', 'openFullScreenSettings',
    'openNavigation', 'pickAlarmSound', 'schedule', 'speak', 'status', 'stopSpeaking'
  ]);
});

test('KRIITTINEN: herätyskoodi ratkaisee kutsut eikä koskaan hylkää niitä', () => {
  for (const file of ALARM_FILES) {
    assert.equal(/\.reject\(/.test(javaCode(file)), false, `${file}: call.reject rikkoisi "EI HEITÄ" -sopimuksen`);
  }
  // Jokainen @PluginMethod ratkeaa: joko suoraan, done()-apurin tai pääsäikeen kautta.
  const java = javaCode('AlarmPlugin.java');
  for (const [, name] of java.matchAll(/@PluginMethod\s+public void (\w+)\(PluginCall call\)/g)) {
    const body = methodBody(java, `public void ${name}(PluginCall call)`);
    assert.ok(/call\.resolve\(|done\(call|main\.post\(|startActivityForResult\(call/.test(body), `${name} ei ratkaise kutsua`);
  }
});

// ------------------------------------------------------------ ajastus

test('KRIITTINEN: tarkka ajastus vain, kun canScheduleExactAlarms sallii; muuten epätarkka ja kerrottu', () => {
  const java = javaCode('AlarmScheduler.java');
  const canIndex = java.indexOf('canScheduleExactAlarms()');
  const clockIndex = java.indexOf('setAlarmClock(');
  assert.ok(canIndex > -1 && clockIndex > -1);
  assert.ok(canIndex < clockIndex, 'setAlarmClock ennen oikeuden tarkistusta kaatuisi SecurityExceptioniin');
  assert.match(java, /Build\.VERSION\.SDK_INT < Build\.VERSION_CODES\.S\) return true/);

  const arm = methodBody(java, 'static String arm(');
  const guard = arm.indexOf('if (canScheduleExact(context))');
  assert.ok(guard > -1 && guard < arm.indexOf('setAlarmClock(') && guard < arm.indexOf('setExactAndAllowWhileIdle('));
  assert.match(arm, /catch \(SecurityException/);
  assert.match(arm, /setAndAllowWhileIdle\(AlarmManager\.RTC_WAKEUP/);
  assert.match(arm, /return RESULT_INEXACT/);
  // Herätys = setAlarmClock; puhuttu ja kriittinen = setExactAndAllowWhileIdle.
  assert.match(arm, /if \(wake\) \{\s*manager\.setAlarmClock/);
  // Ei tarkkaa ajastusta ohi tarkistuksen.
  for (const file of ALARM_FILES.filter(f => f !== 'AlarmScheduler.java')) {
    assert.equal(/setAlarmClock\(|setExactAndAllowWhileIdle\(|\.setExact\(/.test(javaCode(file)), false, file);
  }
});

test('KRIITTINEN: jokainen PendingIntent on muuttumaton (FLAG_IMMUTABLE), ei yhtään FLAG_MUTABLEa', () => {
  assert.match(javaCode('AlarmScheduler.java'),
    /static final int PI_FLAGS = PendingIntent\.FLAG_IMMUTABLE \| PendingIntent\.FLAG_UPDATE_CURRENT;/);
  let calls = 0;
  for (const file of ALARM_FILES) {
    const code = javaCode(file);
    assert.equal(code.includes('FLAG_MUTABLE'), false, file);
    for (const match of code.matchAll(/PendingIntent\.get(?:Broadcast|Activity|Service|ForegroundService|Activities)\(([^;]*)\);/g)) {
      calls++;
      assert.match(match[1], /PI_FLAGS|FLAG_IMMUTABLE/, `${file}: ${match[0].slice(0, 80)}`);
    }
  }
  assert.ok(calls >= 5, `PendingIntent-kutsuja löytyi vain ${calls}: haku on rikki`);
});

test('sama tunniste = sama PendingIntent: vakaa pyyntökoodi ja tunnisteen sisältävä data-URI', () => {
  const java = javaCode('AlarmScheduler.java');
  const fire = methodBody(java, 'static PendingIntent firePendingIntent(');
  assert.match(fire, /setData\(Uri\.parse\("manifestival-alarm:\/\/fire\/" \+ Uri\.encode\(id\)\)\)/);
  assert.match(fire, /AlarmMath\.requestCode\(id\)/);
  // Sovitus: kaikki pois ensin, sitten ajastus; peruutus poistaa sekä ajastuksen että tallesta.
  const reconcile = methodBody(java, 'static synchronized Outcome reconcile(');
  assert.ok(reconcile.indexOf('disarm(context, id)') < reconcile.indexOf('arm(context, entry'));
  const cancel = methodBody(java, 'static synchronized int cancel(');
  assert.match(cancel, /disarm\(context, id\)/);
  assert.match(cancel, /stored\.remove\(id\)/);
  assert.match(cancel, /AlarmStore\.saveEntries/);
});

test('KRIITTINEN: etualapalvelu vain AlarmServicessa ja vain tyyppiä mediaPlayback', () => {
  for (const file of allJava()) {
    const code = javaCode(file);
    const uses = /startForeground\(/.test(code);
    assert.equal(uses, file === 'AlarmService.java', `${file}: startForeground`);
  }
  const service = javaCode('AlarmService.java');
  assert.match(service, /ServiceCompat\.startForeground\(this, FOREGROUND_ID, notification, type\)/);
  const types = [...service.matchAll(/FOREGROUND_SERVICE_TYPE_(\w+)/g)].map(m => m[1]);
  assert.deepEqual([...new Set(types)], ['MEDIA_PLAYBACK']);
  assert.match(component('service', 'AlarmService'), /android:foregroundServiceType="mediaPlayback"/);
});

test('KRIITTINEN: BootReceiver vain ajastaa uudelleen, ei koskaan käynnistä palvelua (Android 15)', () => {
  const code = javaCode('BootReceiver.java');
  for (const forbidden of ['AlarmService', 'startService', 'startForegroundService', 'startActivity', 'startForeground']) {
    assert.equal(code.includes(forbidden), false, 'BootReceiver: ' + forbidden);
  }
  assert.match(code, /AlarmScheduler\.rescheduleAll\(/);
  for (const constant of ['Intent.ACTION_BOOT_COMPLETED', 'Intent.ACTION_MY_PACKAGE_REPLACED', 'Intent.ACTION_TIME_CHANGED',
    'Intent.ACTION_TIMEZONE_CHANGED', 'AlarmManager.ACTION_SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED']) {
    assert.ok(code.includes(constant), constant);
  }
  const receiver = manifest.slice(manifest.indexOf('android:name=".BootReceiver"'), manifest.indexOf('</receiver>', manifest.indexOf('android:name=".BootReceiver"')));
  for (const action of ['android.intent.action.BOOT_COMPLETED', 'android.intent.action.MY_PACKAGE_REPLACED',
    'android.intent.action.TIME_SET', 'android.intent.action.TIMEZONE_CHANGED',
    'android.app.action.SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED']) {
    assert.ok(receiver.includes(`<action android:name="${action}" />`), action);
  }
  // Uudelleenlaskenta seinäkelloajasta nykyisessä vyöhykkeessä; menneet
  // AlarmMath.restorePlanin mukaan (ks. seuraava testi).
  const reschedule = methodBody(javaCode('AlarmScheduler.java'), 'static synchronized int rescheduleAll(');
  assert.match(reschedule, /AlarmMath\.wallClockToEpoch\(entry\.optString\("date"\), entry\.optString\("time"\), zone\)/);
  assert.match(reschedule, /AlarmMath\.restorePlan\(/);
});

test('REGRESSIO: erääntynyt, toimittamaton herätys ei katoa avauksessa eikä synkronoinnissa (sama 30 min raja kuin laukeamisessa)', () => {
  // native-zero-grace-drop: ilman tarkkojen herätysten oikeutta (Android 14+
  // oletus) herätys on epätarkka ja voi tulla minuutteja myöhässä. Aiemmin
  // sovelluksen avaus (rescheduleAll) ja JS:n synkronointi (reconcile)
  // pudottivat sen heti hetken jälkeen (target <= now): ei soittoa eikä
  // "missed"-tapahtumaa, vaikka laukeaminen olisi vielä soittanut sen.
  const scheduler = javaCode('AlarmScheduler.java');
  const reschedule = methodBody(scheduler, 'static synchronized int rescheduleAll(');
  const reconcile = methodBody(scheduler, 'static synchronized Outcome reconcile(');
  assert.equal(/target <= now/.test(reschedule + reconcile), false, 'nollan armonajan pudotus palasi');
  assert.match(reschedule, /AlarmMath\.restorePlan\(target, now, entry\.optLong\("firedAt", 0L\), true\)/);
  assert.match(reconcile, /AlarmMath\.restorePlan\(targetOf\(entry\), now, entry\.optLong\("firedAt", 0L\), sameOccurrence\)/);
  // Rajan sisällä heti: AlarmManager laukaisee menneen hetken välittömästi.
  assert.match(reschedule, /arm\(context, entry, Math\.max\(target, now\)\)/);
  assert.match(reconcile, /arm\(context, entry, Math\.max\(targetOf\(entry\), now\)\)/);
  // "missed" kirjataan jokaisella polulla, ei vain käynnistyksessä.
  for (const body of [reschedule, reconcile]) {
    assert.match(body, /if \(plan == AlarmMath\.Restore\.MISSED\) \{\s*AlarmStore\.recordEvent\(context, AlarmStore\.EVENT_MISSED/);
  }
  assert.equal(/reportMissed/.test(ALARM_FILES.map(javaCode).join('\n')), false);
  // Yksi raja: laukeaminen ja uudelleenajastus kysyvät saman funktion.
  assert.match(methodBody(javaCode('AlarmMath.java'), 'static boolean tooLate('), /return now - target > MAX_LATE_MS;/);
  assert.match(methodBody(javaCode('AlarmMath.java'), 'static Restore restorePlan('), /tooLate\(target, now\)/);
  assert.match(javaCode('AlarmReceiver.java'), /AlarmMath\.tooLate\(target, now\)/);
  assert.equal(/MAX_LATE_MS/.test(javaCode('AlarmReceiver.java') + scheduler), false, 'raja kirjoitettu toiseen kertaan');
});

test('KRIITTINEN: tarkkojen herätysten ja koko näytön asetukset avataan vain omista metodeistaan', () => {
  let exactCount = 0;
  let fullCount = 0;
  for (const file of allJava()) {
    const code = javaCode(file);
    exactCount += (code.match(/ACTION_REQUEST_SCHEDULE_EXACT_ALARM/g) || []).length;
    fullCount += (code.match(/ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT/g) || []).length;
  }
  assert.equal(exactCount, 1, 'tarkkojen herätysten asetus avataan useammasta kohdasta');
  assert.equal(fullCount, 1);
  const java = javaCode('AlarmPlugin.java');
  assert.match(methodBody(java, 'public void openExactAlarmSettings(PluginCall call)'), /ACTION_REQUEST_SCHEDULE_EXACT_ALARM/);
  assert.match(methodBody(java, 'public void openFullScreenSettings(PluginCall call)'), /ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT/);
  // Ei lupadialogeja eikä käynnistyksessä avattavia asetuksia.
  assert.equal(/requestPermissionFor|requestPermissions\(/.test(java), false);
  assert.equal(/ACTION_REQUEST|ACTION_MANAGE/.test(methodBody(java, 'public void load()')), false);
});

test('KRIITTINEN: herätyskoodi ei käytä mikrofonia, sijaintia, värinää eikä kirjoita lokiin', () => {
  for (const file of ALARM_FILES) {
    const code = javaCode(file);
    for (const forbidden of ['RECORD_AUDIO', 'AudioRecord', 'MediaRecorder', 'SpeechRecognizer',
      'Manifest.permission', 'LocationManager', 'FusedLocation', 'Vibrator', 'android.util.Log', 'Log.d(',
      'Log.i(', 'Log.w(', 'Log.e(', 'System.out', 'printStackTrace', 'getExternalFilesDir', 'FileOutputStream']) {
      assert.equal(code.includes(forbidden), false, `${file}: ${forbidden}`);
    }
  }
});

test('KRIITTINEN: kaikki herätyskomponentit ovat suljettuja (exported="false")', () => {
  assert.match(component('receiver', 'AlarmReceiver'), /android:exported="false"/);
  assert.match(manifest.slice(manifest.indexOf('android:name=".BootReceiver"'), manifest.indexOf('>', manifest.indexOf('android:name=".BootReceiver"'))),
    /android:exported="false"/);
  assert.match(component('service', 'AlarmService'), /android:exported="false"/);
  const activity = component('activity', 'AlarmActivity');
  assert.match(activity, /android:exported="false"/);
  assert.match(activity, /android:showWhenLocked="true"/);
  assert.match(activity, /android:turnScreenOn="true"/);
  assert.match(activity, /android:excludeFromRecents="true"/);
  assert.equal([...manifest.matchAll(/android:exported="true"/g)].length, 1);
});

// ------------------------------------------------------------ soitto

test('KRIITTINEN: herätys ei soi loputtomiin: 10 min raja, automaattinen torkku kerran, sitten loppu', () => {
  const math = javaCode('AlarmMath.java');
  assert.match(math, new RegExp(`static final int MAX_RING_MINUTES = ${MAX_ALARM_RING_MINUTES};`));
  const service = javaCode('AlarmService.java');
  assert.match(service, /later\(AlarmMath\.MAX_RING_MS, \(\) -> onHardStop\(id\)\)/);
  const hardStop = methodBody(service, 'private void onHardStop(');
  assert.match(hardStop, /alreadyAuto/);
  assert.match(hardStop, /AlarmReceiver\.snooze\(this, [^;]*, true\)/);
  assert.match(hardStop, /EVENT_MISSED/);
  assert.match(hardStop, /stopFor\(id\)/);
  // Automaattinen torkku merkitään, joten toista ei tule.
  assert.match(methodBody(javaCode('AlarmReceiver.java'), 'static boolean snooze('), /if \(auto\) AlarmScheduler\.put\(base, "autoSnoozed", true\)/);
});

test('torkku on idempotentti ja rajattu; sammutus kuittaa ja pysäyttää', () => {
  const receiver = javaCode('AlarmReceiver.java');
  const snooze = methodBody(receiver, 'static boolean snooze(');
  assert.match(snooze, /if \(!ringing && base\.optLong\("snoozeUntil", 0L\) > now\) return false;/,
    'toinen torkkupainallus ei saa ajastaa toista herätystä');
  assert.match(snooze, /if \(!auto && used >= maxSnoozes\) return false;/);
  assert.match(snooze, /AlarmMath\.MAX_SNOOZE_MINUTES/);
  const finish = methodBody(receiver, 'private static void finish(');
  assert.match(finish, /AlarmStore\.markHandled/);
  assert.match(finish, /AlarmScheduler\.cancel\(/);
  assert.match(finish, /AlarmService\.stopRinging\(id\)/);
  // Kuitattua esiintymää ei ajasteta uudelleen seuraavassa synkronoinnissa.
  assert.match(methodBody(javaCode('AlarmScheduler.java'), 'static synchronized Outcome reconcile('),
    /AlarmStore\.isHandled\(context, id, date, time\)/);
  // REGRESSIO: laukeamishetki ei riipu "nyt"-hetkestä. Aiemmin torkutettu
  // herätys palasi laukeamishetkellä alkuperäiseen aikaan, ja kolmen torkun
  // jälkeen puolen tunnin myöhästymisraja olisi hylännyt sen ("missed").
  const target = methodBody(javaCode('AlarmScheduler.java'), 'static long targetOf(JSONObject entry)');
  assert.match(target, /return snoozeUntil > epoch \? snoozeUntil : epoch;/);
  assert.equal(/targetOf\([^)]*,/.test(ALARM_FILES.map(javaCode).join('\n')), false, 'targetOf ei saa ottaa nykyhetkeä');
  // Näkymän Torku toimii, vaikka synkronointi olisi poistanut soivan herätyksen tallesta.
  assert.match(javaCode('AlarmActivity.java'), /AlarmService\.ringingEntryJson\(id\)/);
});

test('herätyslukko on aikarajattu ja vapautetaan', () => {
  const service = javaCode('AlarmService.java');
  assert.match(service, /newWakeLock\(PowerManager\.PARTIAL_WAKE_LOCK/);
  assert.match(service, /lock\.acquire\(timeoutMs\)/);
  assert.equal(/\.acquire\(\)/.test(service), false, 'aikarajaton herätyslukko');
  assert.match(service, /lock\.release\(\)/);
  assert.match(methodBody(service, 'public void onDestroy()'), /releaseWakeLock\(\)/);
  assert.match(methodBody(service, 'private void stopIfIdle()'), /releaseWakeLock\(\)/);
});

test('ääni ja puhe: USAGE_ALARM, suomi, varavaihtoehto kirjataan, puhe sammutetaan', () => {
  const service = javaCode('AlarmService.java');
  assert.match(service, /setUsage\(AudioAttributes\.USAGE_ALARM\)/);
  assert.match(service, /Locale\.forLanguageTag\("fi-FI"\)/);
  assert.match(service, /LANG_MISSING_DATA/);
  assert.match(service, /LANG_NOT_SUPPORTED/);
  assert.match(service, /EVENT_SPEECH_FALLBACK/);
  assert.match(service, /RingtoneManager\.TYPE_ALARM/);
  assert.match(methodBody(service, 'public void onDestroy()'), /tts\.shutdown\(\)/);
  assert.match(methodBody(service, 'public void onDestroy()'), /releasePlayer\(\)/);
});

test('koko näyttö vain luvalla (Android 14+ canUseFullScreenIntent), muuten nouseva ilmoitus', () => {
  const service = javaCode('AlarmService.java');
  assert.match(methodBody(service, 'static boolean fullScreenAllowed('), /canUseFullScreenIntent\(\)/);
  const calls = [...service.matchAll(/setFullScreenIntent\(/g)];
  assert.equal(calls.length, 1);
  assert.match(service, /if \(fullScreenAllowed\(context\)\) builder\.setFullScreenIntent\(/);
  assert.match(service, /CATEGORY_ALARM/);
  assert.match(service, /CHANNEL_ID = "manifestival-alarm"/);
  assert.match(service, /NotificationManager\.IMPORTANCE_HIGH/);
});

test('lukitusnäkymä on natiivi: ei WebViewtä, lukitusta ei avata, isot painikkeet ja kuvaukset', () => {
  const activity = javaCode('AlarmActivity.java');
  assert.match(activity, /extends Activity\b/);
  for (const forbidden of ['WebView', 'BridgeActivity', 'requestDismissKeyguard', 'Capacitor']) {
    assert.equal(activity.includes(forbidden), false, forbidden);
  }
  const lock = methodBody(activity, 'private void showOverLockScreen()');
  assert.match(lock, /if \(Build\.VERSION\.SDK_INT >= Build\.VERSION_CODES\.O_MR1\) \{\s*setShowWhenLocked\(true\);\s*setTurnScreenOn\(true\);/);
  assert.match(lock, /FLAG_SHOW_WHEN_LOCKED/);
  assert.match(lock, /FLAG_TURN_SCREEN_ON/);

  const layout = read('android/app/src/main/res/layout/activity_alarm.xml');
  assert.equal(/WebView/.test(layout.replace(/<!--[\s\S]*?-->/g, '')), false);
  for (const id of ['alarmTime', 'alarmLabel', 'alarmDismiss', 'alarmSnooze']) {
    assert.ok(layout.includes(`@+id/${id}`), id);
    assert.ok(activity.includes(`R.id.${id}`), id);
  }
  for (const button of layout.matchAll(/<Button\b([\s\S]*?)\/>/g)) {
    const minHeight = /android:minHeight="(\d+)dp"/.exec(button[1]);
    assert.ok(minHeight && Number(minHeight[1]) >= 48, 'painike alle 48dp');
    assert.match(button[1], /android:contentDescription="@string\/\w+"/);
  }
});

// ------------------------------------------------------------ navigointi

test('KRIITTINEN: reitin avaus ei koskaan ota linkkiä JS:ltä, vaan kokoaa sen itse', () => {
  const plugin = javaCode('AlarmPlugin.java');
  const open = methodBody(plugin, 'public void openNavigation(PluginCall call)');
  const params = [...open.matchAll(/call\.get\w+\("(\w+)"/g)].map(m => m[1]).sort();
  assert.deepEqual(params, ['destination', 'mode']);
  assert.match(open, /AlarmMath\.sanitizeDestination\(destination\) == null/);
  assert.match(open, /setPackage\(MAPS_PACKAGE\)/);
  assert.match(plugin, /MAPS_PACKAGE = "com\.google\.android\.apps\.maps"/);
  for (const file of ALARM_FILES) {
    assert.equal(/Uri\.parse\(call\./.test(javaCode(file)), false, `${file}: JS:n merkkijono jäsennetään linkiksi`);
  }
  const math = javaCode('AlarmMath.java');
  assert.match(math, /"google\.navigation:q=" \+ encodeComponent\(text\) \+ "&mode=" \+ navMode/);
  assert.match(math, /"https:\/\/www\.google\.com\/maps\/dir\/\?api=1&destination=" \+ encodeComponent\(text\)/);
  // Ilmoituksen "Avaa reitti" menee suoraan karttasovellukseen (ei trampoliinia vastaanottimen kautta).
  assert.match(methodBody(javaCode('AlarmService.java'), 'private static PendingIntent routeIntent('),
    /PendingIntent\.getActivity\(/);
});

// ------------------------------------------------------------ sopimus JS:n kanssa

test('tapahtumien lajit ja rajat ovat samat Javassa, JS:ssä ja domainissa', () => {
  const store = javaCode('AlarmStore.java');
  const javaEvents = [...store.matchAll(/static final String EVENT_\w+ = "(\w+)";/g)].map(m => m[1]).sort();
  assert.deepEqual(javaEvents, [...ALARM_EVENTS].sort());

  const math = javaCode('AlarmMath.java');
  const constant = name => Number(new RegExp(`static final int ${name} = (\\d+);`).exec(math)[1]);
  assert.equal(constant('MAX_SNOOZE_MINUTES'), MAX_SNOOZE_MINUTES);
  assert.equal(constant('MAX_SNOOZES'), MAX_SNOOZES);
  assert.equal(constant('MAX_ESCALATION_STEPS'), MAX_ESCALATION_STEPS);
  assert.equal(constant('DEFAULT_SNOOZE_MINUTES'), DEFAULT_SNOOZE_MINUTES);
  assert.equal(constant('MAX_ID_LENGTH'), ALARM_LIMITS.maxIdLength);
  assert.equal(constant('MAX_TITLE_LENGTH'), ALARM_LIMITS.maxTitleLength);
  assert.equal(constant('MAX_BODY_LENGTH'), ALARM_LIMITS.maxBodyLength);
  assert.equal(constant('MAX_SPEECH_LENGTH'), ALARM_LIMITS.maxSpeechLength);
  assert.equal(constant('MAX_DESTINATION_LENGTH'), ALARM_LIMITS.maxDestinationLength);
  assert.ok(constant('MAX_ENTRIES') >= ALARM_LIMITS.maxAlarms);
});

test('tapahtumissa ei ole otsikoita eikä puhuttua tekstiä (vain tunniste, laji ja aikaleimat)', () => {
  const extras = new Set();
  for (const file of ALARM_FILES) {
    for (const match of javaCode(file).matchAll(/AlarmScheduler\.put\(extra, "(\w+)"/g)) extras.add(match[1]);
  }
  assert.ok(extras.size >= 3, 'haku on rikki');
  for (const key of extras) {
    assert.ok(['fallback', 'untilMs', 'auto', 'superseded', 'spoken', 'code'].includes(key), 'tapahtuman kenttä: ' + key);
  }
  const record = methodBody(javaCode('AlarmStore.java'), 'static JSONObject recordEvent(');
  assert.deepEqual([...record.matchAll(/event\.put\("(\w+)"/g)].map(m => m[1]), ['seq', 'type', 'id', 'kind', 'atMs']);
});

test('MainActivity rekisteröi AlarmPluginin ENNEN super.onCreatea', () => {
  const source = javaCode('MainActivity.java');
  const register = source.indexOf('registerPlugin(AlarmPlugin.class)');
  assert.ok(register > -1, 'AlarmPlugin-liitännäistä ei rekisteröidä');
  assert.ok(register < source.indexOf('super.onCreate('));
});

test('suomenkieliset painikkeet ja kanavat ovat resursseissa', () => {
  const strings = read('android/app/src/main/res/values/strings.xml');
  for (const [name, text] of [['alarm_dismiss', 'Sammuta'], ['alarm_snooze', 'Torku'], ['reminder_ack', 'Kuittaa'],
    ['reminder_departed', 'Lähdin'], ['reminder_snooze', 'Torku 5 min'], ['reminder_route', 'Avaa reitti'],
    ['alarm_channel_name', 'Herätykset ja puhutut muistutukset']]) {
    assert.ok(strings.includes(`<string name="${name}">${text}</string>`), name);
  }
  // Käyttäjälle näkyvä teksti ei ole Java-koodissa kovakoodattuna.
  for (const file of ['AlarmService.java', 'AlarmActivity.java']) {
    assert.equal(/"(Sammuta|Torku|Kuittaa|Avaa reitti|Herätys)"/.test(javaCode(file)), false, file);
  }
});

test('JUnit-testit puhtaille apufunktioille ovat olemassa (gradlew testDebugUnitTest)', () => {
  const junit = read('android/app/src/test/java/fi/limitlesslife/manifestival/AlarmMathTest.java');
  for (const name of ['springForwardGapMovesToNextValidMinute', 'fallBackRepeatedHourUsesFirstOccurrence',
    'requestCodeMatchesJsNumericId', 'destinationMustBePlainText']) {
    assert.ok(junit.includes(`public void ${name}()`), name);
  }
  // Java-lähteissä ei ole ei-ASCII-merkkejä (kääntäjän merkistö ei ratkaise mitään).
  for (const file of ALARM_FILES) {
    assert.equal(/[^\x00-\x7F]/.test(read(`${JAVA_DIR}/${file}`)), false, file);
  }
});
