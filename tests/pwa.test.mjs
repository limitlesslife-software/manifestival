// PWA:n ja alustasovittimien testit.
//
// Service workeria ei voi ajaa Nodessa, joten sen KÄYTTÄYTYMINEN todennetaan
// rakenteellisesti: mitä se välimuistittaa, mitä se ei koskaan välimuistita,
// ja miten versionvaihto hoidetaan. Nämä ovat juuri ne kohdat, joissa
// service worker voi rikkoa sovelluksen pahasti ja pysyvästi.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { browserModules, importsOf, read, readCode, ROOT } from './helpers/sources.mjs';
import {
  capabilities, platformName, isNativeShell, notifications, location, speech, background
} from '../src/platform/index.js';

const sw = read('sw.js');
const swCode = readCode('sw.js');
const manifest = JSON.parse(read('manifest.json'));

// ------------------------------------------------------------- manifesti

test('manifesti sisältää asennettavuuden vaatimat kentät', () => {
  assert.equal(manifest.name, 'Manifestival');
  assert.ok(manifest.short_name);
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.display, 'standalone');
  assert.ok(manifest.background_color, 'taustaväri puuttuu');
  assert.ok(manifest.theme_color, 'teemaväri puuttuu');
});

test('manifestin ikonit ovat olemassa ja oikean kokoisia', () => {
  const sizes = manifest.icons.map(icon => icon.sizes);
  assert.ok(sizes.includes('192x192'), '192px ikoni puuttuu');
  assert.ok(sizes.includes('512x512'), '512px ikoni vaaditaan asennukseen');

  for (const icon of manifest.icons) {
    const file = path.join(ROOT, icon.src.replace(/^\//, ''));
    assert.ok(fs.existsSync(file), 'ikonitiedostoa ei ole: ' + icon.src);
  }
});

test('manifestin teemaväri vastaa merkinnän theme-color-metatietoa', () => {
  const html = read('index.html');
  const match = /<meta name="theme-color" content="([^"]+)"/.exec(html);
  assert.ok(match, 'theme-color-metatieto puuttuu');
  assert.equal(match[1], manifest.theme_color, 'värit ovat eri — tilapalkki vilkkuisi');
});

// -------------------------------------------------------- service worker

test('service worker on versioitu ja siivoaa vanhat välimuistit', () => {
  assert.match(swCode, /const CACHE_VERSION = 'v\d+'/, 'välimuistilla pitää olla versio');
  assert.ok(swCode.includes('caches.delete'), 'vanhat välimuistit pitää poistaa');
  assert.ok(swCode.includes("name.startsWith('manifestival-shell-')"),
    'siivouksen pitää koskea vain omia välimuisteja');
});

test('TURVA: service worker ei koskaan välimuistita API-kutsuja', () => {
  assert.ok(swCode.includes("url.pathname.startsWith('/api/')"),
    'API-polut pitää ohittaa');
});

test('TURVA: service worker ei välimuistita vieraita origineja', () => {
  assert.ok(swCode.includes('url.origin !== self.location.origin'),
    'vain oman originin resurssit saa välimuistittaa — Supabase sisältää henkilökohtaista dataa');
});

test('TURVA: service worker ei välimuistita kirjoituksia', () => {
  assert.ok(swCode.includes("request.method !== 'GET'"),
    'vain GET-pyyntöjä saa välimuistittaa');
});

test('service worker käyttää network-first-strategiaa', () => {
  // Cache-first olisi vaarallinen: ilman sisältötiivisteitä käyttäjälle voisi
  // jäädä vanha index.html uusien moduulien kanssa.
  const fetchHandler = swCode.slice(swCode.indexOf("addEventListener('fetch'"));
  const networkIndex = fetchHandler.indexOf('await fetch(request)');
  const cacheIndex = fetchHandler.indexOf('caches.match(request)');
  assert.ok(networkIndex > -1 && cacheIndex > -1);
  assert.ok(networkIndex < cacheIndex, 'verkkoa pitää yrittää ennen välimuistia');
});

test('service worker EI käytä skipWaiting-kutsua', () => {
  // skipWaiting vaihtaisi moduulit kesken käynnissä olevan istunnon, jolloin
  // sovelluksen sisällä olisi kahden version sekoitus.
  assert.equal(swCode.includes('skipWaiting'), false,
    'skipWaiting aiheuttaisi versioristiriidan kesken istunnon');
});

test('service worker sietää yksittäisen puuttuvan tiedoston asennuksessa', () => {
  assert.equal(swCode.includes('cache.addAll'), false,
    'addAll on kaikki-tai-ei-mitään ja estäisi asennuksen kokonaan');
  assert.ok(swCode.includes('cache.put'), 'tiedostot haetaan yksitellen');
});

test('sovelluskuoren välimuistilista vastaa oikeasti ladattavia moduuleja', () => {
  // Verrataan siihen, mikä on TODELLA saavutettavissa entrypointista.
  // Kytkemattomat moduulit eivat kuulu kuoreen - selain ei koskaan
  // lataa niita, joten niiden valimuistitus olisi turhaa kaistaa.
  const reachable = new Set();
  const queue = ['src/app/main.js'];
  while (queue.length) {
    const file = queue.shift();
    if (reachable.has(file)) continue;
    reachable.add(file);
    for (const dependency of importsOf(file)) queue.push(dependency);
  }

  const shellPaths = [...sw.matchAll(/'(\/src\/[^']+)'/g)].map(m => m[1]);
  const reachablePaths = [...reachable].map(file => '/' + file).sort();

  const missingFromShell = reachablePaths.filter(p => !shellPaths.includes(p));
  const staleInShell = shellPaths.filter(p => !reachablePaths.includes(p) && p !== '/src/styles.css');

  assert.deepEqual(missingFromShell, [],
    'nämä ladattavat moduulit puuttuvat sovelluskuoresta — offline rikkoutuisi:\n' + missingFromShell.join('\n'));
  assert.deepEqual(staleInShell, [],
    'sovelluskuori viittaa tiedostoihin, joita ei ladata:\n' + staleInShell.join('\n'));
});

test('sovelluskuori sisältää tyylitiedoston ja rungon', () => {
  for (const required of ['/index.html', '/src/styles.css', '/manifest.json', '/src/app/main.js']) {
    assert.ok(sw.includes(`'${required}'`), 'sovelluskuoresta puuttuu ' + required);
  }
});

test('sovellus rekisteröi service workerin turvallisesti', () => {
  const main = readCode('src/app/main.js');
  assert.ok(main.includes("navigator.serviceWorker.register('/sw.js')"));
  assert.ok(main.includes("'serviceWorker' in navigator"), 'tuki pitää tarkistaa ensin');
  assert.ok(/register\('\/sw\.js'\)\.catch/.test(main),
    'epäonnistuminen ei saa kaataa sovellusta');
});

test('index.html:ssä ei ole enää service workerin paikanpitäjää', () => {
  const html = read('index.html');
  assert.equal(html.includes('no service worker yet'), false);
  assert.equal(html.includes('no-op placeholder'), false);
});

// ------------------------------------------------------ alustasovittimet

test('alustan tunnistus toimii ilman Capacitoria', () => {
  assert.equal(platformName(), 'web');
  assert.equal(isNativeShell(), false);
});

test('alustan tunnistus lukee Capacitorin globaalin, jos se on', () => {
  const previous = globalThis.Capacitor;
  globalThis.Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => 'android'
  };
  try {
    assert.equal(isNativeShell(), true);
    assert.equal(platformName(), 'android');
  } finally {
    if (previous === undefined) delete globalThis.Capacitor;
    else globalThis.Capacitor = previous;
  }
});

test('toteuttamattomat sovittimet kertovat sen rehellisesti', async () => {
  for (const adapter of [location, background]) {
    const capability = adapter.capability();
    assert.equal(capability.supported, false);
    assert.match(capability.reason, /natiivi/i, 'syyn pitää kertoa mitä puuttuu');
  }

  const scheduled = await notifications.schedule();
  assert.equal(scheduled.ok, false, 'toteuttamaton toiminto ei saa väittää onnistuneensa');
  assert.ok(scheduled.reason);

  const located = await location.current();
  assert.equal(located.ok, false);
});

test('puhesovitin kertoo, ettei taustakuuntelu onnistu selaimessa', () => {
  assert.equal(speech.supportsBackgroundCapture(), false,
    'selain ei voi kuunnella sovelluksen ollessa kiinni');
});

test('capabilities() kokoaa alustan tilan yhteen', () => {
  const state = capabilities();
  assert.equal(state.platform, 'web');
  assert.equal(state.native, false);
  for (const key of ['notifications', 'location', 'speech', 'background']) {
    assert.equal(typeof state[key].supported, 'boolean', key + ' puuttuu');
  }
});

test('ilmoitussovitin ei kaadu ilman Notification-rajapintaa', async () => {
  assert.equal(notifications.permission(), 'unsupported');
  assert.equal(await notifications.requestPermission(), false);
  assert.equal(notifications.capability().supported, false);
});
