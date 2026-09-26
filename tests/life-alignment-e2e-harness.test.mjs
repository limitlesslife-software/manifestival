// Suunta E2E -valjaan turvasäännöt (staattinen tarkistus).
//
// Selainajo (npm run e2e:suunta) ei kuulu `npm test`iin, koska se vaatii
// asennetun Chromen. Sen turvasäännöt tarkistetaan kuitenkin joka ajolla:
// jos joku poistaa DNS-eston tai porttitarkistuksen, tämä kaatuu.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { read } from './helpers/sources.mjs';

const RUNNER = read('tools/e2e/run-suunta-e2e.mjs');
const HARNESS = read('tools/e2e/harness.mjs');
const PAGE = read('tools/e2e/suunta-harness.html');

test('E2E: tuotanto estetään DNS-tasolla ja jokainen pyyntö tarkistetaan', () => {
  assert.match(RUNNER, /--host-resolver-rules=MAP \*\.supabase\.co ~NOTFOUND/);
  assert.match(RUNNER, /MAP \*\.anthropic\.com ~NOTFOUND/);
  assert.match(RUNNER, /Network\.requestWillBeSent/);
  assert.match(RUNNER, /supabase\\\.co\|anthropic\\\.com/);
});

test('E2E: debug-portti todennetaan vapaaksi; vieraaseen Chromeen ei liitytä', () => {
  assert.match(RUNNER, /if \(await cdpReachable\(debugPort\)\) throw/);
  assert.match(RUNNER, /--user-data-dir=\$\{profile\}/);
  assert.match(RUNNER, /path\.join\(ROOT, 'tmp',/, 'profiili projektin tmp/-hakemistossa');
  assert.match(RUNNER, /fs\.rmSync\(profile/);
});

test('E2E: valjas ei lataa supabase-js:ää eikä kirjaudu oikeasti', () => {
  const scripts = [...PAGE.matchAll(/<script[^>]*src="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(scripts, ['/tools/e2e/harness.mjs'], 'vain paikallinen valjas, ei CDN-skriptejä');
  assert.equal(/https?:\/\//.test(HARNESS.replace(/\/\/.*$/gm, '')), false, 'valjas ei hae mitään ulkoa');
  assert.match(HARNESS, /setClient\(fakeClient\(\)\)/);
  assert.match(HARNESS, /e2e@example\.invalid/);
  assert.equal(/getSession: async \(\) => \(\{ data: \{ session: null \}/.test(HARNESS), true, 'ei tokenia: tekoälykutsua ei tehdä');
});

test('E2E: skenaariot kattavat pyydetyt polut', () => {
  for (const scenario of ['ensikäyttö', 'ajastin', 'nopea kirjaus', 'kuormitus ja energia', 'huomiotta jääminen',
    'viikkokatsaus', 'esikatselu', 'mobiili 360 px', 'saavutettavuus',
    // Day 1: aloitus (F2), Enter "Muu"-kentässä (CRIT-04), kirjatun ajan
    // alue jälkikäteen (F6) ja arviojono (F4).
    'aloitus: vaihe 1/7', 'näppäimistö: Enter', 'kohdistus jälkikäteen', 'arviojono']) {
    assert.ok(RUNNER.includes(scenario), scenario);
  }
  // Oikea Enter-näppäily (synteettinen tapahtuma ei laukaise lomakkeen lähetystä).
  assert.match(RUNNER, /Input\.dispatchKeyEvent/);
});
