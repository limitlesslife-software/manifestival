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
  // Jos niitä on enemmän, natiivipuolelle on alkanut kertyä omaa logiikkaa.
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

  assert.ok(javaFiles.length <= 1,
    'natiivipuolella on ' + javaFiles.length + ' lähdetiedostoa: ' + javaFiles.join(', ')
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
  // Oma manifesti pyytää vain INTERNETin. Sijaintilupaa EI ole: mikään
  // toteutettu ominaisuus ei käytä sijaintia (NATIVE_LOCATION_ENABLED =
  // false). Loput luvat tulevat lisäosista yhdistämisen kautta, eikä niitä
  // lisätä käsin.
  const manifest = appManifest();
  const permissions = [...manifest.matchAll(/uses-permission android:name="([^"]+)"/g)]
    .map(m => m[1]);

  assert.deepEqual(permissions, [
    'android.permission.INTERNET'
  ], 'omaan manifestiin lisättiin lupa: ' + permissions.join(', '));

  // Kielletyt. includes() koko tiedostoon, joten nimet eivät saa esiintyä
  // edes kommentissa. Sijaintia ei julisteta ennen kuin jokin ominaisuus
  // käyttää sitä; taustasijaintia ja etualapalvelua ei ole eikä tule.
  for (const forbidden of ['ACCESS_BACKGROUND_LOCATION', 'FOREGROUND_SERVICE',
    'ACCESS_COARSE_LOCATION', 'ACCESS_FINE_LOCATION',
    'CAMERA', 'RECORD_AUDIO',
    'READ_EXTERNAL_STORAGE', 'READ_CONTACTS']) {
    assert.equal(manifest.includes(forbidden), false,
      'lupa ilman toteutusta: ' + forbidden);
  }
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
