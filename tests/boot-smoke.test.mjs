// Käynnistyssavu (tools/e2e/boot-smoke.mjs): argumentit ja turvasäännöt
// ilman verkkoa ja ilman selainta.
//
// Selainajo (npm run e2e:boot-smoke -- --root <ehdokas> --label X) vaatii
// Chromen eikä kuulu `npm test`iin. Sen turvasäännöt tarkistetaan silti joka
// ajolla: vieraaseen Chromeen ei liitytä, tuotanto on estetty DNS- ja
// CDP-tasolla, ehdokkaan juuri on vain luku, ja tulos kaatuu jokaisesta
// poikkeuksesta, konsolivirheestä ja tuotantopyynnöstä.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { ROOT, read } from './helpers/sources.mjs';
import {
  parseArgs, UsageError, chromeArgs, HOST_RESOLVER_RULES, PRODUCTION_HOST, EXPECTED_OFFLINE_HOSTS,
  classifyUrl, resolveRequest, profileDirFor, assertDebugPortFree, fingerprintRoot, fingerprintChanges,
  evaluateRun, describeException, describeConsole, locate, smokePageHtml, gitBlobSha, treeMatchesCommit,
  groupIssues, SMOKE_FILES, SMOKE_PREFIX, reportLines, summaryLines
} from '../tools/e2e/boot-smoke.mjs';
import { bootSmokeProblems, parseBootSmoke } from '../tools/activation/acceptance-policy.mjs';
import { ownerSmokeSeed, OWNER_USER_ID, OWNER_COUNTS, SEEDS, mondayOf } from '../tools/e2e/seeds.mjs';
import { createFakeDatabase, createFakeSupabase } from '../tools/e2e/fakeSupabase.mjs';

const RUNNER = read('tools/e2e/boot-smoke.mjs');
const HARNESS = read('tools/e2e/boot-smoke-harness.mjs');
const ORIGIN = 'http://127.0.0.1:5173';
const noComments = source => source.replace(/^\s*\/\/.*$/gm, '').replace(/^\s*\*.*$/gm, '');

// ------------------------------------------------------------ argumentit

test('argumentit: --root ja --label (myös =-muoto); juuri ratkaistaan absoluuttiseksi', () => {
  assert.deepEqual(parseArgs(['--root', ROOT, '--label', 'F']), { root: ROOT, label: 'F', expectSha: null, gates: 'own' });
  assert.deepEqual(parseArgs([`--root=${ROOT}`, '--label=G', '--expect-sha=2C8E230']),
    { root: ROOT, label: 'G', expectSha: '2c8e230', gates: 'own' });
  assert.equal(parseArgs(['--root', '.'], { cwd: ROOT }).root, ROOT);
  assert.equal(parseArgs(['--root', ROOT]).label, path.basename(ROOT), 'nimi oletuksena hakemistosta');
  assert.equal(parseArgs(['--root', ROOT, '--gates', 'J']).gates, 'J');
});

test('argumentit: puuttuva tai kelvoton juuri, tuntematon argumentti ja kelvoton nimi hylätään', () => {
  assert.throws(() => parseArgs([]), UsageError);
  assert.throws(() => parseArgs(['--label', 'F']), /--root puuttuu/);
  assert.throws(() => parseArgs(['--root']), /tarvitsee arvon/);
  assert.throws(() => parseArgs(['--root', '--label', 'F']), /tarvitsee arvon/);
  assert.throws(() => parseArgs(['--root', path.join(ROOT, 'ei-ole-olemassa')]), /ei ole hakemisto/);
  assert.throws(() => parseArgs(['--root', path.join(ROOT, 'tools')]), /index\.html puuttuu/, 'ei sovelluksen juuri');
  assert.throws(() => parseArgs(['--root', ROOT, '--verbose']), /tuntematon argumentti/);
  assert.throws(() => parseArgs(['--root', ROOT, '--label', 'F; rm -rf']), /--label/);
  assert.throws(() => parseArgs(['--root', ROOT, '--expect-sha', 'HEAD~1']), /--expect-sha/);
  assert.throws(() => parseArgs(['--root', ROOT, '--gates', 'closed-ish']), /--gates/);
});

test('KRIITTINEN: vieraaseen Chromeen ei liitytä — portin tai osoitteen antaminen on virhe', () => {
  for (const arg of ['--debug-port', '--debug-port=9222', '--remote-debugging-port=9222', '--port', '--cdp=ws://x',
    '--ws-endpoint=ws://127.0.0.1:9222/devtools/browser/x', '--browser-url=http://127.0.0.1:9222', '--chrome-port=9222']) {
    assert.throws(() => parseArgs(['--root', ROOT, arg, '9222']), /vieraaseen Chromeen ei liitytä/, arg);
  }
});

test('KRIITTINEN: debug-portti todennetaan vapaaksi ennen käynnistystä', async () => {
  await assert.rejects(assertDebugPortFree(9222, async () => true), /ei liitytä vieraaseen prosessiin/);
  await assert.doesNotReject(assertDebugPortFree(9222, async () => false));
  const code = noComments(RUNNER);
  const check = code.indexOf('await assertDebugPortFree(debugPort)');
  assert.ok(check !== -1, 'ajaja tarkistaa portin');
  assert.ok(check < code.indexOf('spawn(chrome'), 'tarkistus ennen Chromen käynnistystä');
  assert.ok(code.indexOf('const debugPort = await freePort()') < check, 'portti valitaan itse (vapaa portti)');
  // Liitytään vain omaan kohteeseen: sama portti kuin käynnistetyllä.
  assert.match(code, /webSocketDebuggerUrl \|\| ''\)\.includes\(`:\$\{debugPort\}\/`\)/);
  assert.match(code, /\/json\/new\?about:blank/);
});

test('chromeArgs: oma portti, profiili ja DNS-esto; ei etäosoitetta', () => {
  const args = chromeArgs({ debugPort: 41234, profile: 'X:/tmp/p' });
  assert.ok(args.includes('--remote-debugging-port=41234'));
  assert.ok(args.includes('--user-data-dir=X:/tmp/p'));
  assert.ok(args.includes('--headless=new'));
  assert.equal(args.filter(a => a.startsWith('--remote-debugging')).length, 1);
  assert.equal(args.some(a => a.startsWith('--remote-debugging-address')), false);
  assert.ok(args.includes(`--host-resolver-rules=${HOST_RESOLVER_RULES}`));
  assert.throws(() => chromeArgs({ profile: 'x' }), /debug-portti puuttuu/);
});

// ------------------------------------------------------------ tuotanto

test('KRIITTINEN: tuotanto estetään DNS-tasolla; säännöt ovat Suunta-E2E:n säännöt ja enemmän', () => {
  for (const rule of ['MAP *.supabase.co ~NOTFOUND', 'MAP supabase.co ~NOTFOUND', 'MAP *.anthropic.com ~NOTFOUND',
    'MAP anthropic.com ~NOTFOUND', 'MAP *.vercel.app ~NOTFOUND', 'MAP cdn.jsdelivr.net ~NOTFOUND',
    'MAP fonts.googleapis.com ~NOTFOUND', 'MAP fonts.gstatic.com ~NOTFOUND']) {
    assert.ok(HOST_RESOLVER_RULES.split(', ').includes(rule), rule);
  }
  const suunta = /--host-resolver-rules=([^']+)'/.exec(read('tools/e2e/run-suunta-e2e.mjs'))[1].split(', ');
  for (const rule of suunta) assert.ok(HOST_RESOLVER_RULES.split(', ').includes(rule), `Suunta-E2E:n sääntö puuttuu: ${rule}`);
});

test('KRIITTINEN: jokainen muu kuin paikallinen pyyntö katkaistaan CDP:n Fetch-tasolla ja luokitellaan', () => {
  const code = noComments(RUNNER);
  assert.match(code, /Fetch\.enable', \{ patterns: \[\{ urlPattern: '\*' \}\] \}/);
  assert.match(code, /Fetch\.failRequest/);
  assert.match(code, /kind === 'local' \|\| kind === 'inline'/, 'vain paikallinen jatkaa');
  assert.match(code, /Network\.requestWillBeSent/);
  // Sovelluksen oma tuotanto-osoite (config.js) on tuotantoa.
  const supabaseUrl = /SUPABASE_URL = '([^']+)'/.exec(read('src/data/config.js'))[1];
  assert.equal(classifyUrl(supabaseUrl + '/rest/v1/tasks', ORIGIN), 'production');
  assert.equal(classifyUrl('https://api.anthropic.com/v1/messages', ORIGIN), 'production');
  assert.equal(classifyUrl('https://manifestival-ten.vercel.app/api/plan', ORIGIN), 'production');
  assert.equal(classifyUrl('https://supabase.co/', ORIGIN), 'production');
  assert.equal(classifyUrl('https://notsupabase.co.evil.example/', ORIGIN), 'external');
  for (const host of EXPECTED_OFFLINE_HOSTS) assert.equal(classifyUrl(`https://${host}/x.css`, ORIGIN), 'offline');
  assert.equal(classifyUrl('https://example.com/pixel.gif', ORIGIN), 'external');
  assert.equal(classifyUrl(`${ORIGIN}/src/app/main.js`, ORIGIN), 'local');
  assert.equal(classifyUrl('http://127.0.0.1:9999/src/app/main.js', ORIGIN), 'external', 'toinen paikallinen portti ei ole savun palvelin');
  assert.equal(classifyUrl('data:,', ORIGIN), 'inline');
  assert.ok(PRODUCTION_HOST.test('twpyubcymdnbvelsjidg.supabase.co'));
});

// ------------------------------------------------------------ vain luku

test('KRIITTINEN: ehdokkaan juuri on vain luku: vain GET/HEAD, ei pistetiedostoja, ei juuren ulkopuolelle', () => {
  const root = path.join(ROOT, 'tmp', 'ehdokas');
  const at = (url, method = 'GET') => resolveRequest({ root, method, url });
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.equal(at('/src/app/main.js', method).status, 405, method);
  assert.equal(at('/src/app/main.js', 'HEAD').kind, 'root');
  assert.deepEqual(at('/src/app/main.js'), { status: 200, kind: 'root', file: path.join(root, 'src', 'app', 'main.js') });
  assert.equal(at('/').file, path.join(root, 'index.html'));
  assert.equal(at('/.git/HEAD').status, 403);
  assert.equal(at('/.env').status, 403);
  assert.equal(at('/src/..%5c..%5c..%5csecret.txt').status, 403, 'koodattu kenoviiva');
  assert.equal(at('/src/%2e%2e/%2e%2e/%2e%2e/secret.txt').file, path.join(root, 'secret.txt'), 'URL normalisoituu juuren sisälle');
  assert.equal(at('/api/plan').status, 501);
  assert.equal(at('/src/data/schema.js?e2e-gates=J').status, 404, 'J-portit vain pyydettäessä');
  assert.equal(resolveRequest({ root, method: 'GET', url: '/src/data/schema.js?e2e-gates=J', gatedSchema: true }).kind, 'gated-schema');
  // Varattu etuliite: vain nimetyt tiedostot tästä repositoriosta.
  assert.equal(at(`${SMOKE_PREFIX}boot.html`).kind, 'smoke-page');
  for (const [name, source] of Object.entries(SMOKE_FILES)) {
    assert.deepEqual(at(`${SMOKE_PREFIX}${name}`), { status: 200, kind: 'smoke', file: path.join(ROOT, source) });
  }
  assert.equal(at(`${SMOKE_PREFIX}../package.json`).kind, 'root', 'normalisoituu ehdokkaan juureen, ei tähän repoon');
  assert.equal(at(`${SMOKE_PREFIX}run-suunta-e2e.mjs`).status, 404);
});

test('KRIITTINEN: ajaja ei kirjoita mitään; profiili on tämän repon tmp/:ssä, ei ehdokkaan puussa', () => {
  const code = noComments(RUNNER);
  const writes = [...code.matchAll(/fs\.(\w+)\(/g)].map(m => m[1])
    .filter(name => !/^(readFile|readFileSync|statSync|existsSync|readdirSync)$/.test(name));
  assert.deepEqual(writes.sort(), ['mkdirSync', 'rmSync']);
  assert.match(code, /fs\.mkdirSync\(profile, \{ recursive: true \}\)/);
  assert.match(code, /fs\.rmSync\(profile, \{ recursive: true, force: true, maxRetries: 10, retryDelay: 300 \}\)/);
  assert.match(code, /catch \(error\) \{\s*console\.warn\(`HUOM  väliaikaisprofiilia ei voitu poistaa \(\$\{error\.code\}\)/, 'EPERM ei peitä tulosta');
  // Git ajetaan vain tässä repositoriossa (ls-tree), ei koskaan ehdokkaan juuressa.
  assert.equal([...code.matchAll(/execFileSync\('git'/g)].length, 1);
  assert.match(code, /execFileSync\('git', \['ls-tree', '-r', '--full-tree', sha, '--', \.\.\.FINGERPRINT_ENTRIES\],\s*\{ cwd: repoRoot/);

  const foreign = path.join(path.dirname(ROOT), 'rc-x');
  const profile = profileDirFor({ root: foreign, label: 'X', pid: 1, now: 2 });
  assert.equal(profile, path.join(ROOT, 'tmp', 'boot-smoke-X-1-2'));
  assert.equal(profileDirFor({ root: ROOT, label: 'P', pid: 1, now: 2 }), path.join(ROOT, 'tmp', 'boot-smoke-P-1-2'), 'oma työpuu sallittu');
  assert.throws(() => profileDirFor({ root: path.dirname(ROOT), label: 'X' }), /profiili osuisi ehdokkaan puuhun/);
});

test('sormenjälki: sisältötiivisteet; muutos, lisäys ja poisto havaitaan', () => {
  const print = fingerprintRoot(ROOT);
  assert.ok(print['index.html'] && print['src/app/main.js'] && print['src/data/client.js']);
  assert.ok(Object.keys(print).every(file => /^(index\.html|sw\.js|manifest\.json|src\/|vendor\/)/.test(file)));
  assert.deepEqual(fingerprintChanges(print, { ...print }), []);
  const changed = { ...print, 'src/app/main.js': 'x', 'src/uusi.js': 'y' };
  delete changed['index.html'];
  assert.deepEqual(fingerprintChanges(print, changed).sort(),
    ['lisätty: src/uusi.js', 'muuttunut: src/app/main.js', 'poistettu: index.html']);
});

test('puu = commit: blob-tiiviste kuten git; CRLF sallitaan; muutos ja commitoimaton tiedosto havaitaan', () => {
  assert.equal(gitBlobSha(Buffer.from('')), 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
  assert.equal(gitBlobSha(Buffer.from('hello\n')), 'ce013625030ba8dba906f756967f9e9ca394464a');
  const print = fingerprintRoot(ROOT);
  const main = read('src/app/main.js').replace(/\r\n/g, '\n');
  const listing = [
    `100644 blob ${gitBlobSha(Buffer.from(main, 'utf8'))}\tsrc/app/main.js`,
    `100644 blob ${'0'.repeat(40)}\tsrc/data/client.js`
  ].join('\n');
  const result = treeMatchesCommit(ROOT, 'abc1234', { lsTree: () => listing });
  assert.equal(result.checked, 2);
  assert.ok(!result.differences.includes('muutettu: src/app/main.js'), 'LF-blob vastaa CRLF-työpuuta');
  assert.ok(result.differences.includes('muutettu: src/data/client.js'));
  assert.ok(result.differences.includes('ei commitissa: index.html'));
  assert.equal(result.differences.filter(d => d.startsWith('ei commitissa:')).length, Object.keys(print).length - 2);
  const missing = treeMatchesCommit(ROOT, 'abc1234', { lsTree: () => { throw new Error('bad object'); } });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /bad object/);
});

// ------------------------------------------------------------ valjas

test('valjas: ehdokkaan oma main.js kannan korvikkeella; ei tokenia, ei supabase-js:ää, ei ulkoisia osoitteita', () => {
  for (const [name, source] of [['harness', HARNESS], ['seeds', read('tools/e2e/seeds.mjs')], ['fakeSupabase', read('tools/e2e/fakeSupabase.mjs')]]) {
    assert.equal(/https?:\/\//.test(noComments(source)), false, `${name} ei hae mitään ulkoa`);
  }
  const code = noComments(HARNESS);
  assert.match(code, /client\.setClient\(fake\)/);
  assert.ok(code.indexOf('client.setClient(fake)') < code.indexOf("import('/src/app/main.js')"), 'korvike ennen main.js:ää');
  assert.match(code, /throw new Error\('ehdokkaan src\/data\/client\.js: setClient puuttuu/, 'ilman setClientiä main.js:ää ei käynnistetä');
  assert.equal(/access_token/.test(HARNESS), false);
  assert.equal(/vendor\/supabase|supabase-js@/.test(HARNESS), false);
  assert.match(code, /navigator\.serviceWorker\.register = async \(\) => null/);
  assert.match(code, /SEEDS\.owner\(\{ todayIso, userId: OWNER_USER_ID \}\)/);

  const page = smokePageHtml('F');
  const scripts = [...page.matchAll(/<script[^>]*src="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(scripts, [`${SMOKE_PREFIX}harness.mjs`]);
  assert.equal(/https?:\/\//.test(page), false);
  assert.match(page, /<base href="\/">/);
  assert.match(page, /<link rel="icon" href="data:,">/);
  assert.equal(/importmap/.test(page), false, 'oletuksena ehdokkaan omat portit');
  const gated = smokePageHtml('P', { gates: 'J' });
  assert.ok(gated.indexOf('importmap') !== -1 && gated.indexOf('importmap') < gated.indexOf(`${SMOKE_PREFIX}harness.mjs`));
});

test('valjas: napautetaan jokainen alapalkin välilehti ja jokainen näytön osiovälilehti ehdokkaan merkinnästä', () => {
  const code = noComments(HARNESS);
  assert.match(code, /querySelectorAll\('\.tab-btn\[data-screen\]'\)/);
  assert.match(code, /\.segment\[role="tablist"\] > button\.segment-btn\[id\^="segment"\]/);
  const runner = noComments(RUNNER);
  assert.match(runner, /for \(const tab of nav\)/);
  assert.match(runner, /for \(const segment of tab\.segments\)/);
  assert.match(runner, /Runtime\.exceptionThrown/);
  assert.match(runner, /Runtime\.consoleAPICalled/);
  assert.match(runner, /Log\.entryAdded/);
});

test('siemen: omistajan kanta (36 avointa tehtävää ilman kestoa, tavoite, projekti, profiili, ilmoitusasetukset, hyvinvointi)', () => {
  assert.equal(OWNER_USER_ID, '2cc00622-f927-4604-a518-361a4328481b');
  assert.equal(SEEDS.owner, ownerSmokeSeed);
  const today = '2026-09-23';
  const { tables } = ownerSmokeSeed({ todayIso: today });
  const monday = mondayOf(today);
  assert.equal(tables.tasks.length, OWNER_COUNTS.tasks);
  assert.ok(tables.tasks.every(t => t.completed === false && t.duration_minutes === null && t.user_id === OWNER_USER_ID));
  assert.equal(tables.tasks.filter(t => t.date < monday).length, OWNER_COUNTS.overdue);
  assert.equal(tables.tasks.filter(t => t.date >= monday && t.date < '2026-09-28').length, OWNER_COUNTS.thisWeek);
  assert.equal(tables.tasks.filter(t => t.date >= '2026-09-28').length, OWNER_COUNTS.nextWeek);
  assert.equal(tables.goals.length, 1);
  assert.equal(tables.projects.length, 1);
  assert.equal(tables.projects[0].goal_id, tables.goals[0].id, 'projekti liitetty tavoitteeseen');
  assert.deepEqual(tables.profile.map(p => p.id), [OWNER_USER_ID]);
  assert.deepEqual(tables.notification_preferences.map(p => p.id), [OWNER_USER_ID]);
  assert.equal(tables.wellbeing_entries.length, 1);
  assert.equal(tables.wellbeing_entries[0].user_id, OWNER_USER_ID);
});

test('siemen: kannan korvike näyttää omistajalle rivit (RLS: vain omat)', async () => {
  const { tables } = ownerSmokeSeed({ todayIso: '2026-09-23' });
  const database = createFakeDatabase({ tables });
  const fake = createFakeSupabase({ database, session: { user: { id: OWNER_USER_ID } }, latencyMs: 0 });
  assert.equal((await fake.from('tasks').select('*')).data.length, 36);
  assert.equal((await fake.from('notification_preferences').select('*').eq('id', OWNER_USER_ID).maybeSingle()).data.enabled, true);
  assert.equal((await fake.from('wellbeing_entries').select('*')).data.length, 1);
  const stranger = createFakeSupabase({ database, session: { user: { id: 'toinen' } }, latencyMs: 0 });
  assert.equal((await stranger.from('tasks').select('*')).data.length, 0);
});

// ------------------------------------------------------------ tulos

const cleanRun = () => ({
  label: 'X', expectSha: null, gateMode: { mode: 'own' }, origin: ORIGIN,
  head: { sha: 'a'.repeat(40), ref: null }, provenance: { ok: true, checked: 1, differences: [] },
  before: { 'index.html': 'h' }, after: { 'index.html': 'h' },
  boot: { appVisible: true, authGateOpen: false, startupError: null, onboarding: 'ei näkynyt' }, bootError: null,
  steps: [
    { kind: 'screen', screen: 'screen-today', label: 'Tänään', exists: true, active: true, visible: true, textLength: 10, dynamic: 3, settled: true },
    { kind: 'segment', screen: 'screen-finance', label: 'Talous › Budjetti', id: 'segmentBudget', exists: true, active: true, visible: true, textLength: 10, dynamic: 3, selected: true, settled: true },
    { kind: 'tick', label: 'ajastimet', periods: [30000] }
  ],
  issues: [], requests: [{ url: `${ORIGIN}/src/app/main.js`, step: 'käynnistys' }], blocked: [], navigations: [{ url: `${ORIGIN}${SMOKE_PREFIX}boot.html`, step: 'käynnistys' }],
  served: [{ kind: 'root', url: '/src/app/main.js', status: 200 }], stats: { queries: 5, writes: [], unsupported: [] }
});

test('tulos: puhdas ajo PASS; odotettu estetty ulkoinen lataus ei kaada', () => {
  const run = cleanRun();
  run.blocked.push({ url: 'https://fonts.googleapis.com/css2?family=X', kind: 'offline', step: 'käynnistys' });
  const verdict = evaluateRun(run);
  assert.equal(verdict.passed, true, verdict.lines.filter(l => !l.ok).map(l => l.name + ': ' + l.detail).join('; '));
});

test('KRIITTINEN: tulos kaatuu poikkeuksesta, hylkäyksestä, konsolivirheestä, tuotantopyynnöstä ja muuttuneesta juuresta', () => {
  const failsWith = (mutate, name) => {
    const run = cleanRun();
    mutate(run);
    const verdict = evaluateRun(run);
    assert.equal(verdict.passed, false, name);
    assert.ok(verdict.lines.some(line => !line.ok && line.name.includes(name)), `${name}: ${JSON.stringify(verdict.lines.filter(l => !l.ok))}`);
  };
  failsWith(run => run.issues.push({ kind: 'exception', message: 'Uncaught TypeError: x', location: 'src/a.js:1:2', step: 'Talous' }), 'poikkeuksia');
  failsWith(run => run.issues.push({ kind: 'rejection', message: 'Uncaught (in promise) ReferenceError: key is not defined', location: 'src/app/views/finance.js:209:71', step: 'käynnistys' }), 'hylkäyksiä');
  failsWith(run => run.issues.push({ kind: 'console', message: 'Manifestival: x', location: 'src/app/state.js:124:15', step: 'Tänään' }), 'konsolivirheitä');
  failsWith(run => run.issues.push({ kind: 'log', message: 'network: 404', location: 'src/x.js', step: 'Tänään' }), 'konsolivirheitä');
  failsWith(run => run.requests.push({ url: 'https://twpyubcymdnbvelsjidg.supabase.co/rest/v1/tasks', step: 'käynnistys' }), 'tuotantoon');
  failsWith(run => run.blocked.push({ url: 'https://api.anthropic.com/v1/messages', kind: 'production', step: 'Suunta' }), 'tuotantoon');
  failsWith(run => run.blocked.push({ url: 'https://example.com/x', kind: 'external', step: 'Suunta' }), 'ulkoisia');
  failsWith(run => run.served.push({ kind: 'api', url: '/api/plan', status: 501 }), '/api/');
  failsWith(run => { run.after = { 'index.html': 'muuttunut' }; }, 'koskematon');
  failsWith(run => { run.boot.authGateOpen = true; }, 'käynnistys');
  failsWith(run => { run.boot = null; run.bootError = 'boot: setClient puuttuu'; }, 'käynnistys');
  failsWith(run => { run.steps[0].textLength = 0; }, 'näyttö Tänään');
  failsWith(run => { run.steps[1].selected = false; }, 'osio Talous');
  failsWith(run => { run.stats.unsupported = ['tasks.rpc:x']; }, 'korvike');
  failsWith(run => run.navigations.push({ url: `${ORIGIN}/`, step: 'Profiili' }), 'valjaassa');
  failsWith(run => { run.steps[2] = { kind: 'tick', label: 'ajastimet', error: 'aikakatkaisu' }; }, 'ajastimet');
  failsWith(run => { run.expectSha = 'b'.repeat(7); }, 'HEAD on odotettu commit');
  failsWith(run => { run.expectSha = 'a'.repeat(7); run.provenance = { ok: false, checked: 3, differences: ['muutettu: src/a.js'] }; }, 'puu = commit');
});

test('virheen sijainti: ehdokkaan polku ja rivi pinosta; hylkäys tunnistetaan', () => {
  const details = {
    text: 'Uncaught (in promise)', lineNumber: 0, columnNumber: 0,
    exception: { description: `ReferenceError: key is not defined\n    at http://127.0.0.1:5173/src/app/views/finance.js:209:71\n    at Array.map (<anonymous>)` }
  };
  assert.deepEqual(describeException(details, ORIGIN), {
    kind: 'rejection', message: 'Uncaught (in promise) ReferenceError: key is not defined', location: 'src/app/views/finance.js:209:71'
  });
  const thrown = describeException({ text: 'Uncaught TypeError: x is not a function', url: `${ORIGIN}/src/app/main.js`, lineNumber: 9, columnNumber: 4 }, ORIGIN);
  assert.equal(thrown.kind, 'exception');
  assert.equal(thrown.location, 'src/app/main.js:10:5', '1-pohjainen rivi');
  const logged = describeConsole({
    args: [{ type: 'string', value: 'Manifestival: tilakuuntelija epäonnistui' },
      { type: 'object', description: 'ReferenceError: key is not defined\n    at renderOverviewDetail (http://127.0.0.1:5173/src/app/views/finance.js:209:71)' }],
    stackTrace: { callFrames: [{ url: `${ORIGIN}/src/app/state.js`, lineNumber: 123, columnNumber: 14 }] }
  }, ORIGIN);
  assert.equal(logged.location, 'src/app/state.js:124:15');
  assert.equal(logged.origin, 'src/app/views/finance.js:209:71');
  assert.equal(locate(`${ORIGIN}${SMOKE_PREFIX}harness.mjs`, 3, 1, ORIGIN), '[savu] tools/e2e/boot-smoke-harness.mjs:3:1');
  const grouped = groupIssues([{ kind: 'console', message: 'm', location: 'a', step: 'A' }, { kind: 'console', message: 'm', location: 'a', step: 'B' }]);
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].count, 2);
  assert.deepEqual(grouped[0].steps, ['A', 'B']);
});

test('npm-skripti ja hyväksyntäpolitiikka: savu on osa AUTOMATED_TECHNICAL_ACCEPTANCEa jokaiselle aallolle', () => {
  assert.equal(JSON.parse(read('package.json')).scripts['e2e:boot-smoke'], 'node tools/e2e/boot-smoke.mjs');
  const policy = read('docs/activation/AUTOMATED-ACCEPTANCE-POLICY.md').replace(/\s+/g, ' ');
  assert.match(policy, /npm run e2e:boot-smoke -- --root \.claude\/worktrees\/rc-X-smoke --label X --expect-sha <deployTarget>/);
  assert.match(policy, /KÄYNNISTYSSAVU \[X\]: PASS/);
  assert.match(policy, /--record-boot-smoke=X --sha=<deployTarget> --smoke-result=/);
  assert.match(policy, /AUTOMATED_TECHNICAL_ACCEPTANCE/);
});

// ------------------------------------------------ sopimus orkestroijan kanssa

/** Täysi ajo raportin tulostusta varten (cleanRun + käynnistyksen tiedot). */
const reportableRun = overrides => ({
  ...cleanRun(), root: 'C:/x/rc-D-smoke', label: 'D', expectSha: 'a'.repeat(40),
  boot: {
    appVisible: true, authGateOpen: false, startupError: null, onboarding: 'ohitettu',
    gates: { tables: { tasks: true }, columns: {} }, adaptations: ['setClient'], userId: OWNER_USER_ID, todayIso: '2026-09-26', seed: { tasks: 36 }
  },
  ...overrides
});

test('KRIITTINEN: savun loppurivit ovat orkestroijan --record-boot-smoke-jäsentimen sopimus', () => {
  const sha = 'a'.repeat(40);
  const run = reportableRun();
  const verdict = evaluateRun(run);
  assert.equal(verdict.passed, true);
  const lines = reportLines(run, verdict);
  assert.deepEqual(lines.slice(-2), summaryLines(run, verdict));
  assert.equal(lines.at(-1), `KÄYNNISTYSSAVU [D]: PASS (${verdict.lines.length}/${verdict.lines.length}; poikkeuksia 0, hylkäyksiä 0, konsolivirheitä 0, tuotantopyyntöjä 0)`);
  assert.equal(lines.at(-2), `EHDOKAS [D]: ${sha} (portit: omat; --expect-sha: ${sha})`);
  // console.log-tuloste sellaisenaan (+ npm:n otsake) kelpaa kirjattavaksi.
  const printed = ['', '> manifestival@1.0.0 e2e:boot-smoke', '', ...lines, ''].join('\n');
  const summary = parseBootSmoke(printed);
  assert.equal(summary.total, verdict.lines.length);
  assert.deepEqual(bootSmokeProblems(summary, { wave: 'D', sha }), []);

  // Epäonnistunut ajo tulostaa FAILin, jota ei kirjata.
  const broken = reportableRun();
  broken.issues.push({ kind: 'exception', message: 'Uncaught ReferenceError: key is not defined', location: 'src/app/views/finance.js:209:71', step: 'Talous' });
  const failed = evaluateRun(broken);
  const failedText = reportLines(broken, failed).join('\n');
  assert.match(failedText.split('\n').at(-1), /^KÄYNNISTYSSAVU \[D\]: FAIL \(\d+\/\d+; poikkeuksia 1,/);
  assert.match(bootSmokeProblems(parseBootSmoke(failedText), { wave: 'D', sha }).join('; '), /savun tulos on FAIL/);

  // Ilman --expect-sha:ta tai J-porteilla ajettu savu ei kelpaa ehdokkaalle.
  const noExpect = reportableRun({ expectSha: null });
  assert.equal(summaryLines(noExpect, evaluateRun(noExpect))[0], `EHDOKAS [D]: ${sha} (portit: omat; --expect-sha: -)`);
  assert.match(bootSmokeProblems(parseBootSmoke(reportLines(noExpect, evaluateRun(noExpect)).join('\n')), { wave: 'D', sha }).join('; '), /ilman --expect-sha:ta/);
  const gatedJ = reportableRun({ gateMode: { mode: 'J', provenance: 'J', matrix: { tables: { tasks: true } } } });
  assert.match(summaryLines(gatedJ, evaluateRun(gatedJ))[0], /\(portit: J; /);
  assert.match(bootSmokeProblems(parseBootSmoke(reportLines(gatedJ, evaluateRun(gatedJ)).join('\n')), { wave: 'D', sha }).join('; '), /omilla porteillaan/);
  // HEAD lukukelvoton: ei täyttä SHA:ta, ei kirjausta.
  const noHead = reportableRun({ head: { sha: null, ref: null } });
  assert.match(summaryLines(noHead, evaluateRun(noHead))[0], /^EHDOKAS \[D\]: \? \(/);
});
