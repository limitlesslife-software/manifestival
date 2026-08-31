// Paikallinen smoke-testi.
//
// Varmistaa, että sovellus ja KOKO moduuligraafi latautuvat oikeasti HTTP:n
// yli. Yksikkötestit eivät huomaa väärää importpolkua tai puuttuvaa
// tiedostoa — selain huomaisi vasta ajossa.
//
// EI ota yhteyttä Supabaseen eikä Anthropiciin eikä kirjoita mihinkään
// tietokantaan. Kirjautumista ei yritetä.
//
//   npm run smoke

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SMOKE_PORT) || 4173;
const BASE = 'http://127.0.0.1:' + PORT;

let failures = 0;
let checks = 0;

function check(ok, label, detail) {
  checks++;
  if (!ok) failures++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? '  -- ' + detail : ''));
}

async function waitForServer(attempts = 50) {
  for (let i = 0; i < attempts; i++) {
    try {
      const response = await fetch(BASE + '/index.html');
      if (response.ok) return true;
    } catch { /* ei vielä pystyssä */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return false;
}

/** Kerää moduulin suorat riippuvuudet lähdekoodista. */
function importsIn(source) {
  return [
    ...source.matchAll(/(?:^|\n)\s*import\s[^'"]*['"](\.[^'"]+)['"]/g),
    ...source.matchAll(/(?:^|\n)\s*export\s+\*\s+from\s+['"](\.[^'"]+)['"]/g)
  ].map(match => match[1]);
}

/** Lataa moduuli ja kaikki sen riippuvuudet rekursiivisesti. */
async function crawlModules(entryPath) {
  const seen = new Set();
  const queue = [entryPath];
  let loaded = 0;

  while (queue.length) {
    const modulePath = queue.shift();
    if (seen.has(modulePath)) continue;
    seen.add(modulePath);

    const response = await fetch(BASE + modulePath);
    const type = response.headers.get('content-type') || '';
    const ok = response.status === 200 && type.includes('javascript');
    check(ok, 'moduuli latautuu: ' + modulePath, 'status ' + response.status + ', type ' + type);
    if (!ok) continue;

    loaded++;
    const source = await response.text();
    const dir = path.posix.dirname(modulePath);
    for (const specifier of importsIn(source)) {
      queue.push(path.posix.normalize(path.posix.join(dir, specifier)));
    }
  }
  return loaded;
}

const server = spawn(process.execPath, [path.join(ROOT, 'scripts', 'serve.mjs')], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'ignore', 'inherit']
});

try {
  if (!await waitForServer()) {
    console.log('FAIL  palvelin ei käynnistynyt');
    process.exit(1);
  }

  // 1. Sovelluksen runko
  const indexResponse = await fetch(BASE + '/');
  const html = await indexResponse.text();
  check(indexResponse.status === 200, 'GET / palauttaa 200', 'status ' + indexResponse.status);
  check((indexResponse.headers.get('content-type') || '').includes('text/html'),
    'GET / content-type on text/html');

  // 2. Tyylitiedosto
  const cssResponse = await fetch(BASE + '/src/styles.css');
  check(cssResponse.status === 200 && (cssResponse.headers.get('content-type') || '').includes('text/css'),
    'tyylitiedosto latautuu', 'status ' + cssResponse.status);

  // 3. Koko moduuligraafi entrypointista alkaen
  const entry = '/src/app/main.js';
  check(html.includes('src="./src/app/main.js"'), 'index.html viittaa entrypointiin');
  const moduleCount = await crawlModules(entry);
  check(moduleCount >= 20, 'moduuligraafi latautui kokonaan', moduleCount + ' moduulia');

  // 4. PWA-manifesti
  const manifestResponse = await fetch(BASE + '/manifest.json');
  const manifest = await manifestResponse.json();
  check(manifestResponse.status === 200 && manifest.name === 'Manifestival',
    'manifest.json on kelvollinen');
  check(Array.isArray(manifest.icons) && manifest.icons.length >= 2,
    'manifestissa on ikonit', (manifest.icons || []).length + ' kpl');

  // 5. Ikonit ovat oikeasti olemassa
  for (const icon of manifest.icons || []) {
    const iconResponse = await fetch(BASE + icon.src);
    check(iconResponse.status === 200, 'ikoni latautuu: ' + icon.src, 'status ' + iconResponse.status);
  }

  // 6. Käyttöliittymän rakenne
  for (const id of ['authGate', 'authSplash', 'app', 'onboarding', 'screen-today',
                    'screen-week', 'screen-tasks', 'screen-profile', 'voiceOverlay']) {
    check(html.includes('id="' + id + '"'), 'merkinnässä on elementti #' + id);
  }
  check(html.includes('<div id="app" class="app-hidden">'),
    'sovellusnäkymä on piilotettu ennen kirjautumista');

  // 7. Palvelinpuolen koodi ei vuoda staattisena
  for (const route of ['/api/parse', '/api/_auth.js', '/api/_validate.js', '/api/_ratelimit.js']) {
    const response = await fetch(BASE + route);
    check(response.status === 501, 'lähdekoodia ei tarjoilla: ' + route, 'status ' + response.status);
  }

} finally {
  server.kill();
}

console.log('\n' + (failures === 0
  ? `SMOKE TEST: PASS (${checks} tarkistusta)`
  : `SMOKE TEST: FAIL (${failures}/${checks})`));

// Lopetetaan siististi ilman että lapsiprosessin sulkeminen sotkee koodia.
process.exitCode = failures === 0 ? 0 : 1;
