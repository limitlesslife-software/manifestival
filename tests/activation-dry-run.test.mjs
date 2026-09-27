// `npm run activation:dry-run` (ACT-13): tila ja seuraava askel yhdellä
// komennolla, ilman kirjoituksia, git-muutoksia tai (testeissä) verkkoa.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { ROOT, read } from './helpers/sources.mjs';
import {
  ROOT_STUB, acceptanceEntry, journalOf, lockFrom, projectFiles, shaOf, smokeEntry, stubFetch, stubFs, stubGit, testsEntry
} from './helpers/activation-history.mjs';
import { runDryRun } from '../tools/activation/orchestrate.mjs';
import { TRAIN } from '../tools/activation/train-map.mjs';
import { createGit } from '../tools/release/git-layer.mjs';

const fixture = name => fs.readFileSync(path.join(ROOT, 'tests/fixtures/activation-inventory', name), 'utf8');
const lineOf = (lines, key) => lines.find(l => l.startsWith(`${key}:`)) || '';

function deps({ production = 'C', inventory = fixture('state-0008.json'), gitOptions = {}, liveSha = null, lock = null } = {}) {
  const git = stubGit({ production, ...gitOptions });
  const fsStub = stubFs(projectFiles({ lock: lock || lockFrom(stubGit({ production })), inventory }));
  return {
    git, fs: fsStub, root: ROOT_STUB,
    fetchImpl: stubFetch(git, liveSha || shaOf(production)),
    now: () => new Date('2026-09-26T12:00:00Z')
  };
}

test('KRIITTINEN: kanta 0008 + tuotanto C -> seuraava deploy D, välimuisti v17, 0009 odottaa, omistajan deployportti', async () => {
  const d = deps();
  const result = await runDryRun(d, { live: false, inventoryPath: 'inventaario.json' });
  const { lines, report } = result;
  assert.equal(result.exitCode, 0, lines.join('\n'));
  assert.match(lineOf(lines, 'PRODUCTION_SHA'), new RegExp(shaOf('C')));
  assert.match(lineOf(lines, 'PRODUCTION_SHA'), /FETCH_HEAD/);
  assert.equal(lineOf(lines, 'CURRENT_WAVE'), 'CURRENT_WAVE: C');
  assert.equal(lineOf(lines, 'CURRENT_CACHE'), 'CURRENT_CACHE: v16');
  assert.match(lineOf(lines, 'CURRENT_DB_WAVE'), /^CURRENT_DB_WAVE: E/);
  assert.match(lineOf(lines, 'NEXT_DEPLOYMENT'), new RegExp(`^NEXT_DEPLOYMENT: D ${shaOf('D')}`));
  assert.match(lineOf(lines, 'NEXT_MIGRATION'), /0009 \(aalto F\) — ODOTTAA: aalto E/);
  assert.match(lineOf(lines, 'EXPECTED_CACHE'), /^EXPECTED_CACHE: v17 .*= v17: OK/);
  assert.match(lineOf(lines, 'EXPECTED_SCHEMA_GATE'), /9 porttia auki/);
  assert.match(lineOf(lines, 'EXPECTED_SCHEMA_GATE'), /BILL_PAYMENT_FIELDS=false/);
  assert.match(lineOf(lines, 'EXPECTED_CANDIDATE_SHA'), /== lukko: OK; fast-forward tuotannosta: OK/);
  assert.match(lineOf(lines, 'REQUIRED_OWNER_GATE'), /^REQUIRED_OWNER_GATE: OWNER_DEPLOY_APPROVAL_REQUIRED — aallon D deploy: omistajan viesti "hyväksyn D"/);
  assert.match(lineOf(lines, 'RISK'), /matala/);
  assert.match(lineOf(lines, 'LIVE'), /OFFLINE/);
  assert.equal(report.NEXT_DEPLOYMENT.wave, 'D');
  assert.equal(report.EXPECTED_CACHE.expected, 'v17');
  assert.equal(report.NEXT_MIGRATION.deferred, true);
  assert.equal(report.DECISION, 'GO');
});

test('KRIITTINEN: REQUIRED_OWNER_GATE listaa VAIN omistajan hyväksynnät; tekninen hyväksyntä ja käyttötodennus erikseen', async () => {
  const { lines, report } = await runDryRun(deps(), { live: false, inventoryPath: 'inventaario.json' });
  const owner = lineOf(lines, 'REQUIRED_OWNER_GATE');
  for (const notOwner of [/TECHNICAL_ACCEPTANCE_REQUIRED/, /CANDIDATE_TESTS_REQUIRED/, /BOOT_SMOKE_REQUIRED/, /OWNER_READ_ONLY_SQL_REQUIRED/, /LIVE_USE/, /\bUI\b/, /selain/i]) {
    assert.equal(notOwner.test(owner), false, `REQUIRED_OWNER_GATE sisältää: ${notOwner}`);
  }
  assert.deepEqual(report.REQUIRED_OWNER_GATE.map(g => g.class), ['OWNER_DEPLOY_APPROVAL_REQUIRED']);
  assert.deepEqual(report.REQUIRED_TECHNICAL_GATE.map(g => g.class), ['TECHNICAL_ACCEPTANCE_REQUIRED', 'CANDIDATE_TESTS_REQUIRED', 'BOOT_SMOKE_REQUIRED']);
  assert.match(lineOf(lines, 'REQUIRED_TECHNICAL_GATE'), new RegExp(`--wave=C --sha=${shaOf('C')} --record-acceptance`));
  assert.match(lineOf(lines, 'TECHNICAL_ACCEPTANCE'), /^TECHNICAL_ACCEPTANCE: C 0101010 PUUTTUU — npm run production:verify-assets/);
  // Käyttötodennus tulostetaan tiedoksi, ei porttina eikä PASSina.
  const live = lineOf(lines, 'LIVE_USE_VALIDATION_PENDING');
  assert.match(live, /^LIVE_USE_VALIDATION_PENDING: C — tiedoksi, ei estä junaa eikä ole PASS \(docs\/acceptance\/WAVE-C-OWNER-ACCEPTANCE\.md\)/);
  assert.ok(lines.some(l => /^ {2}- rutiinin luonti/.test(l)));
  assert.deepEqual(report.LIVE_USE_VALIDATION_PENDING.map(l => [l.wave, l.status]), [['C', 'LIVE_USE_VALIDATION_PENDING']]);
  assert.equal(lines.some(l => /LIVE_USE_VALIDATION_PENDING[^\n]*:\s*PASS\b/.test(l)), false);
  assert.match(lines.at(-1), /^GO: seuraava askel DEPLOY D — odottaa: koneelliset .*omistajan hyväksyntä "hyväksyn D"/);
});

test('kirjattu tekninen hyväksyntä, testiajo ja käynnistyssavu: vain omistajan deployhyväksyntä jää', async () => {
  const d = deps();
  d.fs.store.set(path.resolve(ROOT_STUB, '.claude/activation/journal.jsonl'), journalOf(acceptanceEntry('C'), testsEntry('D'), smokeEntry('D')));
  const { lines, report } = await runDryRun(d, { live: false, inventoryPath: 'inventaario.json' });
  assert.match(lineOf(lines, 'TECHNICAL_ACCEPTANCE'), /^TECHNICAL_ACCEPTANCE: C 0101010 = AUTOMATED_TECHNICAL_ACCEPTANCE/);
  assert.equal(lineOf(lines, 'REQUIRED_TECHNICAL_GATE'), 'REQUIRED_TECHNICAL_GATE: -');
  assert.deepEqual(report.REQUIRED_OWNER_GATE.map(g => g.message), ['hyväksyn D']);
});

test('KRIITTINEN: dry-run nimeää puuttuvan käynnistyssavun ja antaa sen tarkan ajo- ja kirjauskomennon', async () => {
  const d = deps();
  d.fs.store.set(path.resolve(ROOT_STUB, '.claude/activation/journal.jsonl'), journalOf(acceptanceEntry('C'), testsEntry('D')));
  const { lines, report } = await runDryRun(d, { live: false, inventoryPath: 'inventaario.json' });
  const sha = shaOf('D');
  const out = '.claude/activation/smoke-D-0202020.txt';
  assert.equal(lineOf(lines, 'REQUIRED_TECHNICAL_GATE'),
    'REQUIRED_TECHNICAL_GATE: BOOT_SMOKE_REQUIRED — ehdokkaan D (0202020) käynnistyssavu omalla koodilla ja porteilla ei ole kirjattu PASSiksi: '
    + `git worktree add --detach .claude/worktrees/rc-D-smoke ${sha} && npm run e2e:boot-smoke -- --root .claude/worktrees/rc-D-smoke --label D --expect-sha ${sha} > ${out}; `
    + `npm run activation:orchestrate -- --record-boot-smoke=D --sha=${sha} --smoke-result=${out}`);
  assert.deepEqual(report.REQUIRED_TECHNICAL_GATE.map(g => [g.class, g.kind]), [['BOOT_SMOKE_REQUIRED', 'TECHNICAL']]);
  assert.match(lines.at(-1), /^GO: seuraava askel DEPLOY D — odottaa: koneelliset \(BOOT_SMOKE_REQUIRED\); omistajan hyväksyntä "hyväksyn D"/);
  // FAIL-kirjaus ei kelpaa: portti pysyy.
  d.fs.store.set(path.resolve(ROOT_STUB, '.claude/activation/journal.jsonl'),
    journalOf(acceptanceEntry('C'), testsEntry('D'), smokeEntry('D', sha, { result: 'FAIL', pass: 26 })));
  const failed = await runDryRun(d, { live: false, inventoryPath: 'inventaario.json' });
  assert.match(lineOf(failed.lines, 'REQUIRED_TECHNICAL_GATE'), /^REQUIRED_TECHNICAL_GATE: BOOT_SMOKE_REQUIRED — /);
  assert.deepEqual(d.fs.writes, [], 'dry-run kirjoitti');
});

test('KRIITTINEN: ilman inventaariota -> OWNER_READ_ONLY_SQL_REQUIRED ja exit 1', async () => {
  const d = deps({ inventory: null });
  const result = await runDryRun(d, { live: false });
  assert.equal(result.exitCode, 1);
  assert.match(lineOf(result.lines, 'INVENTORY'), /UNKNOWN — OWNER_READ_ONLY_SQL_REQUIRED/);
  assert.match(result.lines.join('\n'), /STOP: OWNER_READ_ONLY_SQL_REQUIRED/);
});

test('lukukelvoton inventaario -> exit 2', async () => {
  const d = deps({ inventory: 'tämä ei ole inventaario' });
  const result = await runDryRun(d, { live: false, inventoryPath: 'inventaario.json' });
  assert.equal(result.exitCode, 2);
});

test('oletusinventaario: uusin dokumentoitu tuotannon fixture (rekonstruoitu näkyy)', async () => {
  const git = stubGit();
  const fsStub = stubFs(projectFiles({
    lock: lockFrom(stubGit()),
    productionFixture: { date: '2026-09-26', text: fixture('production-2026-09-26.json') }
  }));
  const result = await runDryRun({ git, fs: fsStub, root: ROOT_STUB, now: () => new Date('2026-09-26T12:00:00Z') }, { live: false });
  assert.equal(result.exitCode, 0, result.lines.join('\n'));
  assert.match(lineOf(result.lines, 'INVENTORY'), /production-2026-09-26\.json — REKONSTRUOITU/);
  assert.match(lineOf(result.lines, 'NEXT_ACTION'), /DEPLOY D/);
});

test('fixture ilman dokumenttia ei kelpaa oletukseksi', async () => {
  const git = stubGit();
  const fsStub = stubFs(projectFiles({
    lock: lockFrom(stubGit()),
    productionFixture: { date: '2026-09-26', text: fixture('production-2026-09-26.json'), doc: false }
  }));
  const result = await runDryRun({ git, fs: fsStub, root: ROOT_STUB, now: () => new Date() }, { live: false });
  assert.equal(result.exitCode, 1);
  assert.match(result.lines.join('\n'), /OWNER_READ_ONLY_SQL_REQUIRED/);
});

test('KRIITTINEN: siirtynyt viite -> STOP', async () => {
  const lock = lockFrom(stubGit());
  const d = deps({ gitOptions: { refOverrides: { [lock.waves[1].ref]: 'ee'.repeat(20) } }, lock });
  const result = await runDryRun(d, { live: false, inventoryPath: 'inventaario.json' });
  assert.equal(result.exitCode, 1);
  assert.match(result.lines.join('\n'), /STOP: LOCK_DRIFT/);
});

test('live-ristiintarkistus: täsmää -> OK; poikkeaa -> STOP', async () => {
  const ok = await runDryRun(deps(), { live: true, inventoryPath: 'inventaario.json' });
  assert.equal(ok.exitCode, 0, ok.lines.join('\n'));
  assert.match(lineOf(ok.lines, 'LIVE'), /^LIVE: OK/);

  const mismatch = await runDryRun(deps({ liveSha: shaOf('D') }), { live: true, inventoryPath: 'inventaario.json' });
  assert.equal(mismatch.exitCode, 1);
  assert.match(mismatch.lines.join('\n'), /STOP: LIVE_MISMATCH/);
});

test('migraatiovaihe: SQL-tiedostot tiivisteineen ja lukittu lähde', async () => {
  const d = deps({ production: 'E' });
  const result = await runDryRun(d, { live: false, inventoryPath: 'inventaario.json' });
  assert.match(lineOf(result.lines, 'NEXT_ACTION'), /MIGRATE F 0009/);
  const sql = result.lines.filter(l => /^\s+supabase\//.test(l));
  assert.equal(sql.length, 3);
  for (const l of sql) {
    assert.match(l, /sha256 [0-9a-f]{64}/);
    // Lukon SQL-lähde on aalto K (0009–0014), ei migraation oma aalto F.
    assert.match(l, new RegExp(`lähde rehearsal/wave-k-v1 @ ${shaOf('K')}`));
  }
  assert.match(lineOf(result.lines, 'NEXT_DEPLOYMENT'), /F .* \(migraation 0009 jälkeen\)/);
  // Migraation hyväksyntä on omistajan portti; vain lukeva SQL on syöte, ei hyväksyntä.
  assert.deepEqual(result.report.REQUIRED_OWNER_GATE.map(g => [g.class, g.message]),
    [['OWNER_PRODUCTION_MIGRATION_APPROVAL_REQUIRED', 'hyväksyn 0009/F']]);
  assert.match(lineOf(result.lines, 'REQUIRED_OWNER_INPUT'), /OWNER_READ_ONLY_SQL_REQUIRED — supabase\/preflight\/preflight_0009\.sql/);
  assert.equal(lineOf(result.lines, 'REQUIRED_OWNER_GATE').includes('OWNER_READ_ONLY_SQL_REQUIRED'), false);
  assert.deepEqual(result.report.LIVE_USE_VALIDATION_PENDING.map(l => l.wave), ['C', 'D', 'E']);
});

test('--json antaa samat kentät objektina', async () => {
  const result = await runDryRun(deps(), { live: false, inventoryPath: 'inventaario.json' });
  for (const key of ['PRODUCTION_SHA', 'FETCH_HEAD', 'CURRENT_WAVE', 'CURRENT_CACHE', 'LIVE', 'INVENTORY',
    'CURRENT_DB_WAVE', 'NEXT_MIGRATION', 'NEXT_DEPLOYMENT', 'RISK', 'REQUIRED_OWNER_GATE',
    'REQUIRED_OWNER_INPUT', 'REQUIRED_TECHNICAL_GATE', 'TECHNICAL_ACCEPTANCE', 'LIVE_USE_VALIDATION_PENDING',
    'REPO_PREFLIGHT', 'EXPECTED_CANDIDATE_SHA', 'EXPECTED_CACHE', 'EXPECTED_SCHEMA_GATE', 'SQL', 'DECISION']) {
    assert.ok(key in result.report, key);
  }
  assert.doesNotThrow(() => JSON.stringify(result.report));
});

test('KRIITTINEN: dry-run ei kirjoita eikä muuta gitiä', async () => {
  const d = deps();
  await runDryRun(d, { live: true, inventoryPath: 'inventaario.json' });
  assert.deepEqual(d.fs.writes, []);
  assert.equal(d.git.calls.some(c => ['push', 'update-ref', 'lsRemoteMain'].includes(c[0])), false);
  for (const r of d.fetchImpl.requests) {
    assert.equal(r.method, 'GET');
    assert.equal(/\/api\//.test(r.url), false);
  }
});

test('KRIITTINEN: dry-run-skriptin lähde: ei kirjoitusta, ei pushia, verkko vain --offline-ehdolla', () => {
  const code = read('scripts/activation-dry-run.mjs');
  for (const forbidden of ['writeFileSync', 'appendFileSync', 'rmSync', 'push', 'update-ref', 'allowPush']) {
    assert.equal(code.includes(forbidden), false, `dry-run sisältää: ${forbidden}`);
  }
  assert.equal(/\bfetch\(/.test(code), false, 'dry-run kutsuu fetchiä suoraan');
  assert.match(code, /fetchImpl: offline \? null : getOnlyFetch/, 'live-haku ei ole --offline-lipun takana');
  assert.match(code, /createGit\(\)/);
});

test('KRIITTINEN: package.jsonissa on activation:dry-run ja activation:orchestrate', () => {
  const scripts = JSON.parse(read('package.json')).scripts;
  assert.equal(scripts['activation:dry-run'], 'node scripts/activation-dry-run.mjs');
  assert.equal(scripts['activation:orchestrate'], 'node scripts/activation-orchestrate.mjs');
});

test('oikea repo (ehdollinen): tuotannon inventaario + origin/main C -> DEPLOY D lukitulla SHA:lla', async t => {
  const git = createGit({ cwd: ROOT });
  const origin = git.revParse('origin/main');
  if (!origin || !git.revParse('091e73c0091e8f135641e3501742b998dbac8461')) { t.skip('ehdokashistoria ei ole paikallisesti saatavilla'); return; }
  if (origin !== 'cf259d0ef755f7e875cc9cd9c15405eba632e408') { t.skip(`origin/main on siirtynyt (${origin.slice(0, 7)}): odotus koski tuotantoa C`); return; }
  const result = await runDryRun({ git, fs, root: ROOT, now: () => new Date('2026-09-26T12:00:00Z') }, { live: false });
  assert.match(lineOf(result.lines, 'NEXT_DEPLOYMENT'), /^NEXT_DEPLOYMENT: D 091e73c0091e8f135641e3501742b998dbac8461/, result.lines.join('\n'));
  assert.match(lineOf(result.lines, 'EXPECTED_CACHE'), /^EXPECTED_CACHE: v17 .*: OK/);
  assert.match(lineOf(result.lines, 'CURRENT_DB_WAVE'), /^CURRENT_DB_WAVE: E/);
  assert.match(lineOf(result.lines, 'REQUIRED_OWNER_GATE'), /^REQUIRED_OWNER_GATE: OWNER_DEPLOY_APPROVAL_REQUIRED — aallon D deploy: omistajan viesti "hyväksyn D"/);
  assert.match(lineOf(result.lines, 'REPO_PREFLIGHT'), /^REPO_PREFLIGHT: PASS/);
});

test('oikea repo (ehdollinen): origin/main F + kanta 0009 -> MIGRATE G 0010 (STOP_OWNER_MIGRATION), K:n lukitseminen ei muuta seuraavaa askelta', async t => {
  const git = createGit({ cwd: ROOT });
  const origin = git.revParse('origin/main');
  const g = '4eb93a9e386123042485881fad9aa91b862069c7';
  if (!origin || !TRAIN.every(e => git.revParse(e.ref))) { t.skip('ehdokashaarat eivät ole paikallisesti saatavilla'); return; }
  if (origin !== '2c8e230f8864ce0df1529718fb17ae265fb5d82b') { t.skip(`origin/main on siirtynyt (${origin.slice(0, 7)}): odotus koski tuotantoa F`); return; }
  const result = await runDryRun({ git, fs, root: ROOT, now: () => new Date('2026-09-27T12:00:00Z') },
    { live: false, inventoryPath: 'tests/fixtures/activation-inventory/state-0009.json' });
  const all = result.lines.join('\n');
  assert.equal(lineOf(result.lines, 'CURRENT_WAVE'), 'CURRENT_WAVE: F', all);
  assert.equal(lineOf(result.lines, 'CURRENT_CACHE'), 'CURRENT_CACHE: v19');
  assert.equal(lineOf(result.lines, 'NEXT_ACTION'), 'NEXT_ACTION: MIGRATE G 0010');
  assert.match(lineOf(result.lines, 'NEXT_DEPLOYMENT'), new RegExp(`^NEXT_DEPLOYMENT: G ${g} \\(migraation 0010 jälkeen\\)`));
  assert.match(lineOf(result.lines, 'REPO_PREFLIGHT'), /^REPO_PREFLIGHT: PASS/);
  assert.equal(result.report.STATE, 'STOP_OWNER_MIGRATION');
  assert.equal(/LOCK_DRIFT|STOP: /.test(all), false, all);
  for (const f of result.report.SQL) {
    assert.equal(f.matchesLock, true, f.path);
    assert.match(f.source, /^rehearsal\/wave-k-v1 @ d11d8b4661bc84c2e90b668132c11104db4cf203$/);
  }
});
