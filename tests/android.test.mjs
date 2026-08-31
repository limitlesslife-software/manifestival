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
  const shipped = fs.readFileSync(path.join(assets, 'index.html'), 'utf8');
  const source = read('index.html');
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
  const source = readCode('src/ai/parseClient.js');
  assert.ok(source.includes('apiUrl(API.parse)'),
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
