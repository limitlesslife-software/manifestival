// Android-kuoren rakenteelliset testit.
//
// Keskeinen sääntö (docs/ANDROID-STRATEGY.md): Android on KUORI, ei toinen
// sovellus. Jos android/-hakemistoon alkaa kertyä liiketoimintalogiikkaa tai
// jos web ja Android alkavat erkaantua, päätös on epäonnistunut.
//
// Nämä testit eivät käännä APK:ta — ne valvovat, ettei haarautumista tapahdu.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { ROOT, read, readCode } from './helpers/sources.mjs';

const hasAndroid = fs.existsSync(path.join(ROOT, 'android'));
const config = JSON.parse(read('capacitor.config.json'));
const packageJson = JSON.parse(read('package.json'));

// ------------------------------------------------------------ konfiguraatio

test('Capacitorin sovellustunnus ja nimi ovat pysyviä', () => {
  // Play Store ei salli sovellustunnuksen muuttamista julkaisun jälkeen.
  assert.equal(config.appId, 'fi.limitlesslife.manifestival');
  assert.equal(config.appName, 'Manifestival');
});

test('Capacitor käyttää koottua dist-hakemistoa, ei repon juurta', () => {
  // Repon juuri veisi APK:hon node_modulesin, testit, dokumentit ja
  // supabase-migraatiot — satoja megatavuja tarpeetonta ja osin arkaluonteista.
  assert.equal(config.webDir, 'dist');
});

test('TURVA: Android ei salli sekasisältöä', () => {
  assert.equal(config.android.allowMixedContent, false,
    'HTTP-sisällön salliminen HTTPS-sivulla avaisi man-in-the-middle-riskin');
  assert.equal(config.server.androidScheme, 'https');
});

test('koontiskriptit ovat olemassa ja oikeassa järjestyksessä', () => {
  assert.ok(packageJson.scripts['build:web']);
  assert.ok(packageJson.scripts['sync:android'].includes('build:web'),
    'synkronointi pitää tehdä vasta koonnin jälkeen, muuten APK saa vanhat tiedostot');
  assert.ok(packageJson.scripts['build:android'].includes('sync:android'));
});

test('KRIITTINEN: vanhentuneet Android-assetit paikataan automaattisesti ennen testejä', () => {
  // android/app/src/main/assets/public on gitignorattu (android/.gitignore),
  // joten se syntyy vain kun joku on ajanut sync:androidin paikallisesti.
  // Jos web-lähdettä muutetaan sen jälkeen synkronoimatta uudelleen, "npm
  // test" ei saa enää vain kaataa yhtä testiä 1600+ muun joukossa --
  // pretest-koukun on korjattava tilanne AUTOMAATTISESTI ennen kuin
  // tests/android.test.mjs edes ehtii nähdä vanhentuneen tilan.
  assert.ok(packageJson.scripts.pretest,
    'package.jsonista puuttuu "pretest" -- Android-assettien vanhentuminen '
    + 'näkyisi erottamattomana FAILina muun testijoukon seassa');
  assert.ok(packageJson.scripts.pretest.includes('pretest-android-sync.mjs'),
    'pretest ei aja Android-assettien paikkausskriptiä');
  assert.ok(fs.existsSync(path.join(ROOT, 'scripts/pretest-android-sync.mjs')),
    'pretest-android-sync.mjs puuttuu, vaikka package.json viittaa siihen');

  const skripti = read('scripts/pretest-android-sync.mjs');
  assert.match(skripti, /sync:android/,
    'paikkausskripti ei aja sync:android-komentoa');
  assert.match(skripti, /existsSync/,
    'paikkausskripti ei tarkista, onko assets/public ylipäätään olemassa -- '
    + 'ilman sitä se pakottaisi Android-koonnin myös fressissä kloonissa');
});

// ------------------------------------------------- yksi koodikanta

test('SÄÄNTÖ: Android-hakemistossa ei ole sovelluslogiikkaa', { skip: !hasAndroid }, () => {
  // Capacitorin generoima kuori sisältää yhden Java-tiedoston (MainActivity).
  // Hyväksytyt lisäykset ovat alustarajapintoja, eivät sovelluslogiikkaa:
  //   - puheliitännäinen (SpeechPlugin: mikrofoni -> teksti), kuluttaja
  //     src/platform/speech.js
  //   - herätys ja puhutut muistutukset (AlarmPlugin ja sen apuluokat:
  //     ajastus, soittopalvelu, lukitusnäkymä, uudelleenajastus), kuluttaja
  //     src/platform/alarms.js. Mitä ja milloin herätetään, päättää
  //     domain (src/domain/alarmPlan.js); natiivi vain soittaa.
  // Lista on TÄSMÄLLINEN: jokainen uusi natiivitiedosto on omistajan
  // päätös, ei sivutuote.
  const javaRoot = path.join(ROOT, 'android', 'app', 'src', 'main', 'java');
  if (!fs.existsSync(javaRoot)) return;

  const javaFiles = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.java') || entry.name.endsWith('.kt')) javaFiles.push(entry.name);
    }
  };
  walk(javaRoot);

  assert.deepEqual(javaFiles.sort(), [
    'AlarmActivity.java', 'AlarmMath.java', 'AlarmPlugin.java', 'AlarmReceiver.java',
    'AlarmScheduler.java', 'AlarmService.java', 'AlarmStore.java', 'BootReceiver.java',
    'MainActivity.java', 'SpeechPlugin.java'
  ],
    'natiivipuolen lähdetiedostot: ' + javaFiles.join(', ')
    + ' — logiikan pitää olla src/platform/-sovittimen takana');
});

test('SÄÄNTÖ: Android-assetit tulevat koonnista, niitä ei muokata käsin', { skip: !hasAndroid }, () => {
  const assets = path.join(ROOT, 'android', 'app', 'src', 'main', 'assets', 'public');
  if (!fs.existsSync(assets)) return;

  // Assettien index.html pitää olla identtinen repon juuren kanssa.
  //
  // RIVINVAIHDOT NORMALISOIDAAN ENNEN VERTAILUA. Vertailun kaksi puolta
  // elävät eri sääntöjen alla: repon juuren tiedosto on gitin hallussa
  // ja saa työpuussa alustan mukaiset rivinvaihdot (`* text=auto` ja
  // core.autocrlf), kun taas Capacitorin kopioima assetti on se mitä
  // koonti sattui kirjoittamaan.
  //
  // Ero paljastui ensimmäisessä tuotantojulkaisussa: haaranvaihto
  // main-haaraan ja takaisin kirjoitti työpuun tiedostot uudelleen
  // CRLF-muodossa, jolloin tämä testi kaatui vaikka sisältö oli sama
  // merkki merkiltä.
  //
  // Testin tarkoitus on estää APK-assettien KÄSIN MUOKKAAMINEN.
  // Rivinvaihto ei ole käsin tehty muutos, joten sen ei kuulu kaataa
  // tätä. Kaikki muu ero kaataa yhä.
  // Poistetaan pelkat CR-merkit. Rakennetaan merkkikoodista, jottei
  // rivinvaihto katkaise itse lauseketta.
  const CR = String.fromCharCode(13);
  const rivinvaihdot = text => text.split(CR).join('');

  const shipped = rivinvaihdot(fs.readFileSync(path.join(assets, 'index.html'), 'utf8'));
  const source = rivinvaihdot(read('index.html'));
  assert.equal(shipped, source,
    'APK:n index.html eroaa lähteestä — aja npm run sync:android');
});

test('Android-sovelluksen nimi on Manifestival', { skip: !hasAndroid }, () => {
  const strings = path.join(ROOT, 'android', 'app', 'src', 'main', 'res', 'values', 'strings.xml');
  if (!fs.existsSync(strings)) return;
  const xml = fs.readFileSync(strings, 'utf8');
  assert.match(xml, /<string name="app_name">Manifestival<\/string>/);
  assert.match(xml, /fi\.limitlesslife\.manifestival/);
});

// ----------------------------------------------- alustaerot sovittimen takana

test('natiivikuoressa API-kutsu osoittaa tuotantoon', async () => {
  // Natiivikuoressa sivu ladataan laitteelta, joten suhteellinen /api/parse
  // osuisi paikalliseen kuoreen eikä koskaan palvelimeen.
  const { apiUrl, PRODUCTION_ORIGIN } = await import('../src/platform/index.js');

  assert.equal(apiUrl('/api/parse'), '/api/parse', 'webissä suhteellinen polku riittää');

  const previous = globalThis.Capacitor;
  globalThis.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android' };
  try {
    assert.equal(apiUrl('/api/parse'), PRODUCTION_ORIGIN + '/api/parse');
    assert.ok(PRODUCTION_ORIGIN.startsWith('https://'), 'tuotannon osoitteen pitää olla HTTPS');
  } finally {
    if (previous === undefined) delete globalThis.Capacitor;
    else globalThis.Capacitor = previous;
  }
});

test('AI-kutsu käyttää alustakohtaista osoitetta', () => {
  const source = readCode('src/ai/commandClient.js');
  assert.ok(source.includes('apiUrl(API.command)'),
    'kutsun pitää kulkea alustasovittimen kautta');
});

// ----------------------------------------------------- koonnin eristys

test('koonti jättää pois tiedostot, jotka eivät kuulu APK:hon', () => {
  const build = readCode('scripts/build-web.mjs');
  assert.ok(build.includes("'index.html'"));
  assert.ok(build.includes("'src'"));

  // Nämä eivät saa koskaan päätyä koontiin.
  for (const forbidden of ['node_modules', 'tests', 'docs', 'supabase', 'api']) {
    assert.equal(build.includes(`'${forbidden}'`), false,
      forbidden + ' ei kuulu selainkoontiin');
  }
});

test('koonti tuottaa vain oikeasti tarvittavat tiedostot', { skip: !fs.existsSync(path.join(ROOT, 'dist')) }, () => {
  const distFiles = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else distFiles.push(path.relative(path.join(ROOT, 'dist'), full).split(path.sep).join('/'));
    }
  };
  walk(path.join(ROOT, 'dist'));

  assert.ok(distFiles.includes('index.html'));
  assert.ok(distFiles.includes('src/app/main.js'));
  assert.ok(distFiles.includes('src/styles.css'));
  assert.ok(distFiles.includes('sw.js'));

  for (const file of distFiles) {
    assert.equal(file.startsWith('node_modules'), false);
    assert.equal(file.startsWith('tests/'), false);
    assert.equal(file.startsWith('docs/'), false);
    assert.equal(file.startsWith('supabase/'), false);
    assert.equal(file.startsWith('api/'), false);
  }

  // src/package.json on Nodea varten, ei selainta.
  assert.equal(distFiles.includes('src/package.json'), false);
});

// --------------------------------------------------------- salaisuudet

test('TURVA: Android-projektissa ei ole salaisuuksia', { skip: !hasAndroid }, () => {
  const suspicious = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'build' || entry.name === '.gradle') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(java|kt|xml|gradle|json|properties)$/.test(entry.name)) continue;

      const content = fs.readFileSync(full, 'utf8');
      if (/sk-ant-[A-Za-z0-9_-]{10}/.test(content) || content.includes('service_role')) {
        suspicious.push(path.relative(ROOT, full));
      }
    }
  };
  walk(path.join(ROOT, 'android'));
  assert.deepEqual(suspicious, [], 'salaisuuksia Android-projektissa:\n' + suspicious.join('\n'));
});

test('konekohtaiset polut eivät päädy versionhallintaan', () => {
  const gitignore = read('.gitignore');
  assert.ok(gitignore.includes('android/local.properties'),
    'local.properties sisältää konekohtaisen SDK-polun');
  assert.ok(gitignore.includes('dist/'), 'koonti ei kuulu versionhallintaan');
  assert.ok(gitignore.includes('*.apk'), 'APK ei kuulu versionhallintaan');
  assert.ok(gitignore.includes('*.keystore'), 'allekirjoitusavaimet eivät kuulu repoon');
});

// ---------------------------------- yöajo: manifestin kovennukset

/** Sovelluksen oma manifesti (ei yhdistetty). */
function appManifest() {
  return fs.readFileSync(
    path.join(ROOT, 'android/app/src/main/AndroidManifest.xml'), 'utf8');
}

test('KRIITTINEN: sovellusdataa ei varmuuskopioida pilveen', { skip: !hasAndroid }, () => {
  // Supabase-client on persistSession: true, joten kirjautumisistunto —
  // access token ja pitkäikäinen refresh token — elää WebView'n
  // localStoragessa. Se on sovelluksen datahakemistossa, jonka Androidin
  // automaattinen varmuuskopio veisi käyttäjän Google Driveen.
  //
  // Pitkäikäistä tunnusta ei kuulu varmuuskopioon. Sama koskee tulevaa
  // hyvinvointi- ja talousdataa.
  const manifest = appManifest();

  assert.match(manifest, /android:allowBackup="false"/,
    'automaattinen varmuuskopio veisi kirjautumisistunnon pilveen');

  // Ja peruste on kirjattu, jottei sitä palauteta tietämättömyyttään.
  assert.ok(/refresh token|istunto/i.test(manifest),
    'valinnalle ei ole perustelua manifestissa');
});

test('istunnon tallennus ja varmuuskopiointi eivät ole ristiriidassa', { skip: !hasAndroid }, () => {
  // Nämä kaksi päätöstä liittyvät toisiinsa: jos istunnon säilytys joskus
  // poistetaan, varmuuskopion voi harkita uudelleen — ja päinvastoin. Ilman
  // tätä testiä yhteys katoaa heti kun toinen tiedosto muuttuu yksin.
  const persists = /persistSession:\s*true/.test(read('src/data/client.js'));
  const backedUp = /android:allowBackup="true"/.test(appManifest());

  assert.equal(persists && backedUp, false,
    'istunto säilytetään laitteella JA laite varmuuskopioidaan — tunnus päätyisi pilveen');
});

test('selväkielinen liikenne on nimenomaisesti kielletty', { skip: !hasAndroid }, () => {
  // targetSdk 36:n oletus on jo false, mutta oletukseen ei nojata:
  // nimenomainen arvo säilyy vaikka targetSdk joskus laskisi.
  assert.match(appManifest(), /android:usesCleartextTraffic="false"/,
    'selväkielistä liikennettä ei ole nimenomaisesti kielletty');
});

test('luvat rajoittuvat siihen, mitä toteutetut ominaisuudet vaativat', { skip: !hasAndroid }, () => {
  // Oma manifesti pyytää INTERNETin, mikrofonin (puheentunnistus,
  // SpeechPlugin.java; lupa kysytään vasta napautuksesta) ja herätyksen
  // luvat (AlarmPlugin.java: käynnistyksen jälkeinen palautus, tarkat
  // herätykset käyttäjän myöntämänä, koko näytön herätys, mediaPlayback-
  // etualapalvelu soitolle ja puheelle, ilmoitukset, rajattu herätyslukko).
  // Sijaintilupaa EI ole: mikään toteutettu ominaisuus ei käytä sijaintia
  // (NATIVE_LOCATION_ENABLED = false). Loput luvat tulevat lisäosista
  // yhdistämisen kautta, eikä niitä lisätä käsin.
  const manifest = appManifest();
  const permissions = [...manifest.matchAll(/uses-permission android:name="([^"]+)"/g)]
    .map(m => m[1]);

  assert.deepEqual(permissions, [
    'android.permission.INTERNET',
    'android.permission.RECORD_AUDIO',
    'android.permission.RECEIVE_BOOT_COMPLETED',
    'android.permission.SCHEDULE_EXACT_ALARM',
    'android.permission.USE_FULL_SCREEN_INTENT',
    'android.permission.FOREGROUND_SERVICE',
    'android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK',
    'android.permission.POST_NOTIFICATIONS',
    'android.permission.WAKE_LOCK'
  ], 'omaan manifestiin lisättiin lupa: ' + permissions.join(', '));

  // Kielletyt. includes() koko tiedostoon, joten nimet eivät saa esiintyä
  // edes kommentissa.
  //   - Äänen asetusten muokkauslupa: ilman sitä Capacitor hylkää WebView'n
  //     omat mikrofonipyynnöt, joten web-koodi ei avaa mikrofonia
  //     liitännäisen ohi.
  //   - Etualapalvelu muuna kuin toistona (mikrofoni, sijainti, datasynkka,
  //     erikoiskäyttö ...): ei taustakuuntelua, ei seurantaa. Vain
  //     mediaPlayback on sallittu (herätyksen ääni ja puhe).
  //   - Automaattisesti myönnetty herätyskellon lupa: Play varaa sen
  //     herätyskellosovelluksille; tarkat herätykset kulkevat käyttäjän
  //     myöntämällä SCHEDULE_EXACT_ALARMilla.
  //   - Värinä: sitä ei käytetä, joten lupaa ei julisteta.
  //   - Sijainti: ei julisteta ennen kuin jokin ominaisuus käyttää sitä.
  for (const forbidden of ['MODIFY_AUDIO_SETTINGS', 'CAPTURE_AUDIO_OUTPUT',
    'FOREGROUND_SERVICE_MICROPHONE', 'FOREGROUND_SERVICE_LOCATION', 'FOREGROUND_SERVICE_CAMERA',
    'FOREGROUND_SERVICE_DATA_SYNC', 'FOREGROUND_SERVICE_SPECIAL_USE', 'FOREGROUND_SERVICE_MEDIA_PROJECTION',
    'FOREGROUND_SERVICE_PHONE_CALL', 'FOREGROUND_SERVICE_CONNECTED_DEVICE', 'FOREGROUND_SERVICE_HEALTH',
    'FOREGROUND_SERVICE_REMOTE_MESSAGING', 'FOREGROUND_SERVICE_SYSTEM_EXEMPTED',
    'USE_EXACT_ALARM', 'VIBRATE', 'SYSTEM_ALERT_WINDOW', 'READ_MEDIA_AUDIO',
    'ACCESS_BACKGROUND_LOCATION', 'ACCESS_COARSE_LOCATION', 'ACCESS_FINE_LOCATION',
    'CAMERA', 'READ_EXTERNAL_STORAGE', 'READ_CONTACTS']) {
    assert.equal(manifest.includes(forbidden), false,
      'lupa ilman toteutusta: ' + forbidden);
  }
  // Etualapalvelun tyyppi on vain mediaPlayback.
  const types = [...manifest.matchAll(/android:foregroundServiceType="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(types, ['mediaPlayback']);
});

test('LOC-3: jos sijaintilupa joskus palaa, se ei saa rajata jakelua', { skip: !hasAndroid }, () => {
  // Sijaintilupa synnyttää Play-kaupassa implisiittisen PAKOLLISEN
  // android.hardware.location-ominaisuuden, joka suodattaa laitteet ilman
  // sijaintilaitteistoa. Pelkkä .gps required=false ei riitä.
  const manifest = appManifest();
  const location = [...manifest.matchAll(/uses-permission android:name="android\.permission\.(ACCESS_\w*LOCATION)"/g)];
  if (location.length === 0) return;
  assert.match(manifest,
    /uses-feature android:name="android\.hardware\.location" android:required="false"/,
    'sijaintilupa ilman android.hardware.location required="false" -riviä');
});

test('MIC-1: mikrofonilupa ei saa rajata jakelua (android.hardware.microphone required="false")', { skip: !hasAndroid }, () => {
  // Kuten LOC-3: RECORD_AUDIO synnyttää Play-kaupassa implisiittisen
  // PAKOLLISEN android.hardware.microphone-ominaisuuden, joka suodattaisi
  // laitteet ilman mikrofonia. Puhe on oikotie; kirjoittaminen toimii aina.
  const manifest = appManifest();
  if (!/uses-permission android:name="android\.permission\.RECORD_AUDIO"/.test(manifest)) return;
  assert.match(manifest,
    /<uses-feature android:name="android\.hardware\.microphone" android:required="false" \/>/,
    'mikrofonilupa ilman android.hardware.microphone required="false" -riviä');
  assert.equal(/android\.hardware\.microphone" android:required="true"/.test(manifest), false);
  // <uses-feature> on <manifest>-tason elementti, ei <application>in sisällä.
  assert.ok(manifest.indexOf('<uses-feature android:name="android.hardware.microphone"') > manifest.indexOf('</application>'));
});

test('LOC-1: natiivisijainnin lippu ja manifesti ovat samaa mieltä', { skip: !hasAndroid }, async () => {
  const { NATIVE_LOCATION_ENABLED } = await import('../src/platform/capabilities.js');
  const declares = /uses-permission android:name="android\.permission\.ACCESS_\w*LOCATION"/.test(appManifest());
  if (NATIVE_LOCATION_ENABLED) {
    assert.match(appManifest(), /android\.permission\.ACCESS_COARSE_LOCATION/,
      'natiivisijainti päällä, mutta manifesti ei julista lupaa: pyyntö kaatuisi');
  } else {
    assert.equal(declares, false, 'natiivisijainti pois päältä, mutta manifesti julistaa sijaintiluvan');
  }
});

test('puheentunnistuspalvelu on näkyvissä Android 11+:ssa (<queries>)', { skip: !hasAndroid }, () => {
  const manifest = appManifest();
  const queries = /<queries>([\s\S]*?)<\/queries>/.exec(manifest);
  assert.ok(queries, 'manifestista puuttuu <queries>: SpeechRecognizer ei näkisi tunnistinpalvelua');
  assert.match(queries[1], /<action android:name="android\.speech\.RecognitionService" \/>/);
  // Herätyksen puhe: ilman tätä Android 11+ ei näytä puhemoottoria TextToSpeechille.
  assert.match(queries[1], /<action android:name="android\.intent\.action\.TTS_SERVICE" \/>/);
  // <queries> on <manifest>-tason elementti, ei <application>in sisällä.
  assert.ok(manifest.indexOf('<queries>') > manifest.indexOf('</application>'));
});

// ---------------------------------------------------- puheliitännäinen

const JAVA_DIR = 'android/app/src/main/java/fi/limitlesslife/manifestival';

/** Java-lähde ilman kommentteja: kiellot koskevat koodia, eivät selityksiä. */
function javaCode(file) {
  return read(`${JAVA_DIR}/${file}`)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
}

test('MainActivity rekisteröi puheliitännäisen ENNEN super.onCreatea', { skip: !hasAndroid }, () => {
  const source = javaCode('MainActivity.java');
  const register = source.indexOf('registerPlugin(SpeechPlugin.class)');
  const superCreate = source.indexOf('super.onCreate(');
  assert.ok(register > -1, 'SpeechPlugin-liitännäistä ei rekisteröidä');
  assert.ok(superCreate > -1, 'onCreate ei kutsu super.onCreatea');
  assert.ok(register < superCreate,
    'rekisteröinti super.onCreaten jälkeen ei päädy siltaan (BridgeActivity.load)');
});

test('puheliitännäisen nimi on sama Javassa ja JS:ssä', { skip: !hasAndroid }, async () => {
  const java = javaCode('SpeechPlugin.java');
  const name = /@CapacitorPlugin\(\s*name\s*=\s*"([^"]+)"/.exec(java);
  assert.ok(name, 'SpeechPlugin.java: @CapacitorPlugin(name = ...) puuttuu');
  const { NATIVE_SPEECH_PLUGIN } = await import('../src/platform/speech.js');
  assert.equal(name[1], NATIVE_SPEECH_PLUGIN,
    'eri nimi -> window.Capacitor.Plugins[nimi] olisi undefined ja puhe "ei käytettävissä"');
  assert.equal(name[1], 'ManifestivalSpeech');

  // Tilatapahtuman nimi on sama molemmin puolin.
  const { NATIVE_STATE_EVENT } = await import('../src/platform/speech.js');
  assert.match(java, new RegExp(`STATE_EVENT = "${NATIVE_STATE_EVENT}"`));
});

test('KRIITTINEN: puheliitännäinen kysyy mikrofoniluvan vain listen()-polussa', { skip: !hasAndroid }, () => {
  const java = javaCode('SpeechPlugin.java');

  // Lupa-alias on vain RECORD_AUDIO.
  assert.match(java, /@Permission\(alias = SpeechPlugin\.MICROPHONE, strings = \{ Manifest\.permission\.RECORD_AUDIO \}\)/);
  assert.match(java, /MICROPHONE = "microphone"/);
  assert.equal((java.match(/Manifest\.permission\./g) || []).length, 1, 'liitännäinen julistaa muitakin lupia');

  // Pyyntö on täsmälleen yhdessä paikassa: listen() -> listenOnMain.
  const requests = [...java.matchAll(/requestPermissionFor\w*\(/g)];
  assert.equal(requests.length, 1, 'lupaa pyydetään useammassa kohdassa');
  const listenOnMain = java.slice(java.indexOf('private void listenOnMain'), java.indexOf('@PermissionCallback'));
  assert.match(listenOnMain, /requestPermissionForAlias\(MICROPHONE, call, "onMicrophonePermission"\)/);
  assert.match(java, /public void listen\(PluginCall call\) \{\s*main\.post\(\(\) -> listenOnMain\(call\)\);/);

  // Takaisinkutsun nimi vastaa metodia (muuten Capacitor HYLKÄISI kutsun).
  assert.match(java, /@PermissionCallback\s+private void onMicrophonePermission\(PluginCall call\)/);

  // Ei load()-ylikirjoitusta, joka voisi pyytää käynnistyksessä.
  assert.equal(/void load\(\)/.test(java), false, 'load() ylikirjoitettu: lupa voisi lähteä käynnistyksessä');

  // requestPermissions() EI pyydä: se vain lukee tilan.
  const request = java.slice(java.indexOf('public void requestPermissions'), java.indexOf('handleOnPause'));
  assert.match(request, /checkPermissions\(call\);/);
  assert.equal(/requestPermissionFor/.test(request), false);
});

test('KRIITTINEN: puheliitännäinen sammuttaa mikrofonin taustalle siirryttäessä', { skip: !hasAndroid }, () => {
  const java = javaCode('SpeechPlugin.java');
  const between = (from, to) => java.slice(java.indexOf(from), java.indexOf(to, java.indexOf(from)));

  assert.match(between('protected void handleOnPause', 'protected void handleOnStop'), /stopInternal\("aborted"\)/);
  assert.match(between('protected void handleOnStop', 'protected void handleOnDestroy'), /cancelPermissionWait\(\);\s*stopInternal\("aborted"\)/);
  assert.match(between('protected void handleOnDestroy', 'private void listenOnMain'), /cancelPermissionWait\(\);\s*stopInternal\("aborted"\)/);

  // Tunnistin perutaan JA tuhotaan (muuten palveluyhteys ja mikrofoni jäävät auki).
  const destroy = between('private void destroyRecognizer', 'private void done');
  assert.match(destroy, /current\.cancel\(\)/);
  assert.match(destroy, /current\.destroy\(\)/);

  // Tunnistin on olemassa ennen kuin sitä käytetään.
  assert.match(java, /SpeechRecognizer\.isRecognitionAvailable\(getContext\(\)\)/);
  // Pääsäie: SpeechRecognizer toimii vain siellä.
  assert.match(java, /new Handler\(Looper\.getMainLooper\(\)\)/);
  assert.match(java, /main\.post\(\(\) -> \{\s*cancelPermissionWait\(\);\s*stopInternal\("aborted"\);/);
});

test('KRIITTINEN: puheliitännäinen ei tallenna ääntä eikä kuuntele taustalla', { skip: !hasAndroid }, () => {
  const java = javaCode('SpeechPlugin.java');
  for (const forbidden of ['MediaRecorder', 'AudioRecord', 'EXTRA_AUDIO_SOURCE', 'FileOutputStream',
    'startForeground', 'ForegroundService', 'getExternalFilesDir',
    'SharedPreferences', 'EXTRA_SEGMENTED_SESSION']) {
    assert.equal(java.includes(forbidden), false, 'SpeechPlugin.java: ' + forbidden);
  }
  assert.equal(/EXTRA_PARTIAL_RESULTS,\s*true/.test(java), false, 'väliaikatuloksia ei pyydetä');
  assert.match(java, /EXTRA_PARTIAL_RESULTS, false/);

  // Äänipuskuria ei käsitellä.
  assert.match(java, /public void onBufferReceived\(byte\[\] buffer\) \{\}/);
});

test('puheliitännäinen ratkaisee kutsut eikä koskaan hylkää niitä', { skip: !hasAndroid }, () => {
  const java = javaCode('SpeechPlugin.java');
  assert.equal(/\.reject\(/.test(java), false, 'call.reject rikkoisi JS-puolen "EI HEITÄ" -sopimuksen');

  // Jokainen virhekoodi, jonka Java voi palauttaa, on JS-puolen tuntema.
  const javaCodes = new Set([...java.matchAll(/return "([a-z-]+)";/g)].map(m => m[1]));
  for (const [, literal] of java.matchAll(/(?:done|finish|stopInternal)\([^;]*?"([a-z-]+)"/g)) javaCodes.add(literal);
  const speechSource = read('src/platform/speech.js');
  for (const code of javaCodes) {
    assert.ok(speechSource.includes(`'${code}'`), `Javan virhekoodi ${code} puuttuu speech.js:n taulukosta`);
  }
  assert.ok(javaCodes.has('blocked') && javaCodes.has('not-allowed') && javaCodes.has('unavailable'));
});

/** Capacitorin Plugin-perusluokan omat metodit: JS voi kutsua niitä ilman omaa @PluginMethodia. */
const CAPACITOR_PLUGIN_BUILTINS = new Set(['addListener', 'removeAllListeners', 'checkPermissions', 'requestPermissions']);

test('KRIITTINEN: jokainen JS:n kutsuma puheliitännäisen metodi on Javassa @PluginMethod', { skip: !hasAndroid }, () => {
  // Capacitor luo JS-olion metodit Javan @PluginMethodeista: puuttuva metodi
  // on JS:ssä undefined, ja kutsu kaatuisi vasta puhelimessa.
  const java = javaCode('SpeechPlugin.java');
  const javaMethods = new Set([...java.matchAll(/@PluginMethod\s+public void (\w+)\(PluginCall call\)/g)].map(m => m[1]));
  assert.ok(javaMethods.has('listen') && javaMethods.has('cancel'), 'Javan metodihaku on rikki');

  const speechSource = readCode('src/platform/speech.js');
  const jsCalls = new Set([
    ...[...speechSource.matchAll(/\bplugin\.(\w+)\(/g)].map(m => m[1]),
    ...[...speechSource.matchAll(/nativeSpeechPlugin\(\)\.(\w+)\(/g)].map(m => m[1])
  ]);
  assert.ok(jsCalls.has('listen') && jsCalls.has('cancel') && jsCalls.has('stop'), 'JS:n kutsuhaku on rikki');

  const missing = [...jsCalls].filter(name => !javaMethods.has(name) && !CAPACITOR_PLUGIN_BUILTINS.has(name));
  assert.deepEqual(missing, [], 'JS kutsuu puheliitännäisen metodia, jota Javassa ei ole');
});

test('KRIITTINEN: puheliitännäisen stop() viimeistelee (stopListening), cancel() hylkää', { skip: !hasAndroid }, () => {
  // Sanelun toinen napautus lupaa lopettaa ("lopettaaksesi"): se, mitä
  // ehdittiin sanoa, tulee tuloksena. Peruminen (taustalle siirto,
  // navigointi, uloskirjautuminen) hylkää kaiken ja tuhoaa tunnistimen.
  const java = javaCode('SpeechPlugin.java');
  const between = (from, to) => java.slice(java.indexOf(from), java.indexOf(to, java.indexOf(from)));

  const stop = between('public void stop(PluginCall call)', 'public void openSettings');
  assert.match(stop, /main\.post\(\(\) -> \{\s*cancelPermissionWait\(\);\s*finishListening\(\);\s*call\.resolve\(\);/);
  assert.equal(/stopInternal|destroyRecognizer/.test(stop), false, 'stop() ei saa hylätä kuultua');

  const finishListening = between('private void finishListening', 'private void cancelPermissionWait');
  assert.match(finishListening, /current\.stopListening\(\)/);
  assert.equal(/\.cancel\(\)|destroyRecognizer/.test(finishListening), false,
    'viimeistely ei saa perua tunnistinta ennen tulosta');

  // Tulos kulkee tavallista reittiä: onResults -> finish -> listen ratkeaa tekstillä.
  assert.match(java, /public void onResults\(Bundle results\)[\s\S]*?finish\(owner, null, text\)/);
});

test('vain käynnistysaktiviteetti on ulospäin avoin', { skip: !hasAndroid }, () => {
  const manifest = appManifest();

  // FileProvider ei saa koskaan olla avoin: se antaisi pääsyn
  // sovelluksen tiedostoihin.
  const provider = manifest.slice(manifest.indexOf('<provider'));
  assert.match(provider, /android:exported="false"/,
    'FileProvider on avoin ulospäin');

  // MainActivity on avoin, koska se on käynnistin. Se on ainoa.
  const exported = [...manifest.matchAll(/android:exported="true"/g)];
  assert.equal(exported.length, 1,
    'useampi kuin yksi komponentti on avoin ulospäin');
});
