// Salaisuuksien haku koko repon puusta.
//
// tests/security-invariants.test.mjs tarkistaa selaimen ja palvelimen
// lähdekoodin. Salaisuus voi kuitenkin päätyä mihin tahansa: dokumenttiin,
// skriptiin, työkaluun, testifikstuuriin, SQL-tiedostoon tai Android-
// projektiin. Tämä testi käy läpi jokaisen versionhallintaan kuuluvan
// tiedoston (seuratut + seuraamattomat, joita .gitignore ei rajaa pois)
// paitsi node_modules/, .claude/ ja dist/.
//
// MITÄ ETSITÄÄN
//   - Anthropicin avain (sk-ant-…)
//   - Supabasen service_role-JWT (JWT, jonka payloadin role on
//     service_role) ja uuden mallin salainen avain (sb_secret_…)
//   - yksityiset avaimet (PEM-otsake) ja avaintiedostot (.pem, .key,
//     .jks, .keystore, .p12, .pfx) sekä .env-tiedostot (.env.example pl.)
//   - yleiset pilvi- ja koodipalvelun tunnukset (AWS, GitHub, Google)
//
// Julkinen anon-avain (src/data/config.js, api/_auth.js) on sallittu: se on
// JWT, jonka role on anon, eikä se ohita RLS:ää (ks. docs/SECURITY.md).
//
// Testifikstuurin tekoavaimen on sisällettävä sana TEST tai LEAK, jotta
// se erottuu oikeasta avaimesta (esim. sb_secret_TESTKEY_…).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { ROOT } from './helpers/sources.mjs';

/** Hakemistot, joita ei käydä läpi (riippuvuudet, agenttien työpuut, koonti). */
const EXCLUDED_DIRS = ['node_modules', '.claude', 'dist', '.git'];
/** Binäärit: kuvat, fontit, arkistot. Avaintiedostot tarkistetaan nimeltä. */
const BINARY = /\.(png|jpe?g|gif|ico|webp|woff2?|ttf|otf|zip|jar|apk|aab|gz|pdf|mp3|mp4)$/i;
const KEY_FILE = /\.(pem|key|p12|pfx|jks|keystore)$|(^|\/)\.env(\.(?!example$)[^/]*)?$/i;

const excluded = file => EXCLUDED_DIRS.some(dir => file === dir || file.startsWith(`${dir}/`));

/** Kaikki versionhallintaan kuuluvat tiedostot (git), tai hakemistopuu ilman gitiä. */
function repoFiles() {
  try {
    const output = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    return output.split('\0').filter(Boolean).filter(file => !excluded(file)
      && fs.existsSync(path.join(ROOT, file)));
  } catch {
    const files = [];
    const walk = relative => {
      for (const entry of fs.readdirSync(path.join(ROOT, relative), { withFileTypes: true })) {
        const child = relative ? `${relative}/${entry.name}` : entry.name;
        if (excluded(child) || ['tmp', '.local-backups', 'build', '.gradle'].includes(entry.name)) continue;
        if (entry.isDirectory()) walk(child);
        else files.push(child);
      }
    };
    walk('');
    return files;
  }
}

const FILES = repoFiles();

// Kuviot kootaan paloista, jotta tämä tiedosto ei itse osu niihin.
const PRIVATE_KEY_HEADER = new RegExp('-----BEGIN (?:[A-Z]+ )*' + 'PRIVATE KEY(?: BLOCK)?-----');
const PATTERNS = Object.freeze([
  ['Anthropic-avain', new RegExp('sk-' + 'ant-[A-Za-z0-9_-]{20,}')],
  ['Supabasen salainen avain', new RegExp('sb_' + 'secret_[A-Za-z0-9_-]{20,}')],
  ['yksityinen avain', PRIVATE_KEY_HEADER],
  ['AWS-avain', new RegExp('\\bAKIA' + '[0-9A-Z]{16}\\b')],
  ['GitHub-tunnus', new RegExp('\\bgh[pousr]_' + '[A-Za-z0-9]{36,}')],
  ['Google-avain', new RegExp('\\bAIza' + '[0-9A-Za-z_-]{35}')]
]);
const JWT = /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
const FIXTURE_MARK = /TEST|LEAK/;

/** JWT:n payload, tai null. */
function jwtPayload(token) {
  try {
    const part = token.split('.')[1];
    return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function textOf(file) {
  const absolute = path.join(ROOT, file);
  if (fs.statSync(absolute).size > 16 * 1024 * 1024) return '';
  return fs.readFileSync(absolute, 'utf8');
}

test('haku kattaa koko repon eikä vain lähdekoodia', () => {
  // Tyhjentymissuoja: jos listaus lakkaisi toimimasta, testi menisi läpi.
  assert.ok(FILES.length > 300, `tiedostoja vain ${FILES.length}`);
  for (const expected of ['index.html', 'src/data/config.js', 'api/_auth.js', 'docs/SECURITY.md',
    'supabase/migrations/0013_alignment_reality.sql', 'tools/rls-acceptance/acceptance.js',
    'scripts/build-web.mjs', 'android/app/build.gradle']) {
    assert.ok(FILES.includes(expected), `${expected} puuttuu hausta`);
  }
  assert.equal(FILES.some(file => file.startsWith('node_modules/') || file.startsWith('.claude/')
    || file.startsWith('dist/')), false);
});

test('KRIITTINEN: repossa ei ole avaintiedostoja eikä .env-tiedostoja', () => {
  const found = FILES.filter(file => KEY_FILE.test(file));
  assert.deepEqual(found, [], 'avain- tai ympäristötiedosto repossa');
  // Tarkistin itse: tunnistaa sen mitä pitää, ei esimerkkiä.
  for (const name of ['release.jks', 'android/app/upload.keystore', 'x/.env', '.env.local', 'id.pem']) {
    assert.equal(KEY_FILE.test(name), true, name);
  }
  assert.equal(KEY_FILE.test('.env.example'), false);
});

test('KRIITTINEN: yhdessäkään tiedostossa ei ole salaista avainta', () => {
  const hits = [];
  for (const file of FILES) {
    if (BINARY.test(file)) continue;
    const text = textOf(file);
    for (const [label, pattern] of PATTERNS) {
      const match = pattern.exec(text);
      if (match && !FIXTURE_MARK.test(match[0])) hits.push(`${file}: ${label}`);
    }
  }
  assert.deepEqual(hits, []);
});

test('KRIITTINEN: jokainen JWT-literaali on julkinen anon-avain, ei service_role', () => {
  let anon = 0;
  const offenders = [];
  for (const file of FILES) {
    if (BINARY.test(file)) continue;
    for (const [token] of textOf(file).matchAll(JWT)) {
      const payload = jwtPayload(token);
      if (!payload) continue;
      if (payload.role === 'anon') { anon += 1; continue; }
      offenders.push(`${file}: role=${payload.role || '-'}`);
    }
  }
  assert.deepEqual(offenders, [], 'JWT, joka ei ole anon-avain');
  // Anon-avain on kahdessa paikassa (selain + palvelimen todennus). Jos
  // luku putoaa nollaan, haku ei enää löydä JWT:tä lainkaan.
  assert.ok(anon >= 2, `anon-avaimia löytyi ${anon}`);
});

test('tarkistin tunnistaa oikean muotoiset salaisuudet', () => {
  const fakeJwt = role => ['eyJhbGciOiJIUzI1NiJ9', Buffer.from(JSON.stringify({ role })).toString('base64url'),
    'c2lnbmF0dXJlLXZhbHVl'].join('.');
  assert.equal(jwtPayload(fakeJwt('service_role')).role, 'service_role');
  assert.equal(JWT.test(fakeJwt('service_role')), true);
  JWT.lastIndex = 0;
  const samples = {
    'Anthropic-avain': 'sk-' + 'ant-api03-' + 'x'.repeat(24),
    'Supabasen salainen avain': 'sb_' + 'secret_' + 'a1B2'.repeat(8),
    'yksityinen avain': '-----BEGIN ' + 'RSA PRIVATE KEY-----',
    'AWS-avain': 'AKIA' + 'ABCDEFGHIJKLMNOP'
  };
  for (const [label, pattern] of PATTERNS) {
    if (samples[label]) assert.ok(pattern.test(samples[label]), label);
  }
  assert.ok(PRIVATE_KEY_HEADER.test('-----BEGIN ' + 'PRIVATE KEY-----'));
  assert.ok(PRIVATE_KEY_HEADER.test('-----BEGIN ' + 'OPENSSH PRIVATE KEY-----'));
  assert.equal(FIXTURE_MARK.test('sb_' + 'secret_TESTKEY_should_never_leak'), true);
});
