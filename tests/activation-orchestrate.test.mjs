// Aktivoinnin orkestroija (ACT-01, ACT-10): tynkähistoriaa vasten.
//
// Yksikään testi ei käytä oikeaa gitiä, levyä tai verkkoa: git-kerros,
// tiedostojärjestelmä ja tuotannon fetch ovat tynkiä
// (tests/helpers/activation-history.mjs). DEPLOY-haaraa EI KOSKAAN ajeta
// oikeaa pushia vasten — tynkä kirjaa kutsun, ja testit todistavat
// milloin sitä ei tehty.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { ROOT, read } from './helpers/sources.mjs';
import {
  HEAD_SHA, PREFLIGHT_CHECKS, ROOT_STUB, VERIFY_CHECKS, checkResult, lockFrom, projectFiles,
  shaOf, stubFetch, stubFs, stubGit
} from './helpers/activation-history.mjs';
import {
  appendJournal, planNext, readJournal, readState, resolveJournalPath, rollbackPack,
  runOrchestrator, verifyRollback, recordAcceptance
} from '../tools/activation/orchestrate.mjs';
import { cacheVersionOf, expectedMatrix } from '../tools/release/waves.mjs';

const fixture = name => fs.readFileSync(path.join(ROOT, 'tests/fixtures/activation-inventory', name), 'utf8');

/** Kanta tilassa `state` (fixture), tuore rivi 04 = nyt. */
function inventoryAt(state, now = '2026-09-26 10:00:00') {
  const parsed = JSON.parse(fixture(`state-${state}.json`));
  parsed.rows['04'] = now;
  return JSON.stringify(parsed);
}

function setup({
  production = 'C', dbState = '0008', gitOptions = {}, liveSha, journal = null, inventory = true,
  live = false, lockOverride = null
} = {}) {
  const git = stubGit({ production, ...gitOptions });
  const lock = lockOverride || lockFrom(stubGit({ production }));
  const fsStub = stubFs(projectFiles({ lock, inventory: inventory ? inventoryAt(dbState) : null, journal }));
  const served = { sha: liveSha || shaOf(production) };
  const fetchImpl = stubFetch(git, () => served.sha);
  const deps = {
    git, fs: fsStub, root: ROOT_STUB, fetchImpl,
    now: () => new Date('2026-09-26T12:00:00Z'),
    sleep: async () => {}
  };
  const options = { live, inventoryPath: inventory ? 'inventaario.json' : null };
  return { git, fs: fsStub, deps, served, fetchImpl, lock, options };
}

const pushes = git => git.calls.filter(c => c[0] === 'push' || c[0] === 'update-ref');
const writes = fsStub => fsStub.writes.filter(w => w[0] !== 'mkdirSync');

// =====================================================================
// (a) OLETUS ON KUIVAHARJOITUS
// =====================================================================

test('KRIITTINEN: oletusajo ei kirjoita eikä pushaa — tuotanto C + kanta 0008 -> STOP_OWNER_DEPLOY D', async () => {
  const { git, fs: fsStub, deps, options } = setup();
  const result = await runOrchestrator(deps, options);
  assert.equal(result.plan.state, 'STOP_OWNER_DEPLOY');
  assert.equal(result.plan.nextAction.kind, 'DEPLOY');
  assert.equal(result.plan.candidate.wave, 'D');
  assert.equal(result.plan.candidate.sha, shaOf('D'));
  assert.equal(result.exitCode, 1);
  assert.deepEqual(pushes(git), [], 'push tai update-ref kutsuttiin kuivaharjoituksessa');
  assert.equal(git.calls.some(c => c[0] === 'lsRemoteMain'), false, 'kuivaharjoitus otti yhteyttä originiin');
  assert.deepEqual(writes(fsStub), [], 'kuivaharjoitus kirjoitti levylle');
  const gates = result.plan.pendingGates.map(g => g.detail).join(' | ');
  assert.match(gates, /aallon C hyväksyntä/);
  assert.match(gates, new RegExp(`--approved-sha=${shaOf('D')}`));
});

test('kuivaharjoitus ei pushaa edes --approved-sha:lla ilman --execute-deploy', async () => {
  const { git, deps, options } = setup();
  const result = await runOrchestrator(deps, { ...options, approvedSha: shaOf('D'), accepted: ['C'] });
  assert.equal(result.plan.state, 'STOP_OWNER_DEPLOY');
  assert.deepEqual(pushes(git), []);
});

// =====================================================================
// (b)–(d) DEPLOYN ESTEET
// =====================================================================

test('KRIITTINEN: väärä --approved-sha -> STOP eikä pushia', async () => {
  const { git, deps, options } = setup();
  const result = await runOrchestrator(deps, { ...options, executeDeploy: true, approvedSha: shaOf('E'), accepted: ['C'] });
  assert.equal(result.plan.stopClass, 'APPROVED_SHA_MISMATCH');
  assert.equal(result.exitCode, 1);
  assert.deepEqual(pushes(git), []);
});

test('KRIITTINEN: origin main siirtynyt (compare-and-swap) -> STOP eikä pushia', async () => {
  const { git, deps, options } = setup({ gitOptions: { remoteMain: 'ff'.repeat(20) } });
  const result = await runOrchestrator(deps, { ...options, executeDeploy: true, approvedSha: shaOf('D'), accepted: ['C'] });
  assert.equal(result.plan.stopClass, 'REMOTE_MAIN_MOVED');
  assert.equal(result.deploy.ok, false);
  assert.deepEqual(pushes(git), []);
  assert.equal(result.journal, null, 'päiväkirjaan ei kirjata pushia, jota ei tapahtunut');
});

test('KRIITTINEN: siirtynyt viite (rev-parse != lukko) -> STOP LOCK_DRIFT', async () => {
  const lock = lockFrom(stubGit());
  const { git, deps, options } = setup({ gitOptions: { refOverrides: { [lock.waves[1].ref]: 'ee'.repeat(20) } }, lockOverride: lock });
  const result = await runOrchestrator(deps, { ...options, executeDeploy: true, approvedSha: shaOf('D'), accepted: ['C'] });
  assert.equal(result.plan.stopClass, 'LOCK_DRIFT');
  assert.match(result.plan.reason, /ref siirtynyt|ref puuttuu/);
  assert.deepEqual(pushes(git), []);
});

test('myöhemmän aallon siirtynyt viite ei estä D:tä, mutta näkyy varoituksena', async () => {
  const lock = lockFrom(stubGit());
  const hRef = lock.waves.find(w => w.wave === 'H').ref;
  const { deps, options } = setup({ gitOptions: { refOverrides: { [hRef]: 'ee'.repeat(20) } }, lockOverride: lock });
  const result = await runOrchestrator(deps, options);
  assert.equal(result.plan.state, 'STOP_OWNER_DEPLOY');
  assert.ok(result.plan.warnings.some(w => /lukko, aalto H: ref siirtynyt/.test(w)), result.plan.warnings.join('; '));
});

test('puuttuva pakollinen korjaus (uudelleenleikkaus) -> STOP TRAIN_RECUT_REQUIRED', async () => {
  // Kanta 0011 + koodi G -> seuraava on H, jolta korjaus puuttuu.
  const lockGit = stubGit({ missingPatchWaves: ['H', 'I', 'J'] });
  const lock = lockFrom(lockGit);
  const { git, deps, options } = setup({
    production: 'G', dbState: '0011', gitOptions: { missingPatchWaves: ['H', 'I', 'J'] }, lockOverride: lock
  });
  const result = await runOrchestrator(deps, { ...options, verifyResult: checkResult(VERIFY_CHECKS) });
  assert.equal(result.plan.stopClass, 'TRAIN_RECUT_REQUIRED');
  assert.deepEqual(pushes(git), []);
});

test('työpuu ei puhdas -> deploy estetty', async () => {
  const { git, deps, options } = setup();
  git.statusPorcelain = () => ' M tools/activation/train-map.mjs';
  const result = await runOrchestrator(deps, { ...options, executeDeploy: true, approvedSha: shaOf('D'), accepted: ['C'] });
  assert.equal(result.plan.stopClass, 'WORKING_TREE_DIRTY');
  assert.deepEqual(pushes(git), []);
});

// =====================================================================
// (e) PUUTTUVA OMISTAJAN SYÖTE NIMETÄÄN
// =====================================================================

test('KRIITTINEN: puuttuva inventaario -> STOP OWNER_READ_ONLY_SQL_REQUIRED', async () => {
  const { deps, options } = setup({ inventory: false });
  const result = await runOrchestrator(deps, options);
  assert.equal(result.plan.stopClass, 'OWNER_READ_ONLY_SQL_REQUIRED');
  assert.match(result.plan.reason, /activation_readonly_inventory\.sql/);
  assert.equal(result.exitCode, 1);
});

test('migraatioaalto: puuttuva esitarkistus nimetään, eikä migraatiota koskaan "ajeta" orkestroijasta', async () => {
  const { git, deps, options } = setup({ production: 'E', dbState: '0008' });
  const result = await runOrchestrator(deps, { ...options, accepted: [] });
  assert.equal(result.plan.nextAction.kind, 'MIGRATE');
  assert.equal(result.plan.nextAction.migration, '0009');
  assert.equal(result.plan.state, 'STOP_OWNER_MIGRATION');
  const gates = result.plan.pendingGates.map(g => `${g.class} ${g.detail}`).join(' | ');
  assert.match(gates, /OWNER_READ_ONLY_SQL_REQUIRED supabase\/preflight\/preflight_0009\.sql/);
  assert.match(gates, /OWNER_PRODUCTION_MIGRATION_APPROVAL_REQUIRED/);
  assert.match(gates, /aallon E hyväksyntä/);
  assert.deepEqual(pushes(git), []);
  const sql = result.plan.sql.map(f => f.path);
  assert.deepEqual(sql, ['supabase/preflight/preflight_0009.sql', 'supabase/migrations/0009_finance_2.sql', 'supabase/verify/verify_0009.sql']);
  for (const f of result.plan.sql) {
    assert.match(f.sha256, /^[0-9a-f]{64}$/);
    assert.equal(f.sourceSha, shaOf('J'));
    assert.equal(f.matchesLock, true);
  }
});

test('migraatioaalto: 0 FAIL -esitarkistus -> STOP_OWNER_MIGRATION; FAIL -> PREFLIGHT_DB_FAILED; vajaa liitos -> STOP', async () => {
  const base = setup({ production: 'E', dbState: '0008' });
  const ok = await runOrchestrator(base.deps, { ...base.options, preflightResult: checkResult(PREFLIGHT_CHECKS) });
  assert.equal(ok.plan.state, 'STOP_OWNER_MIGRATION');
  assert.equal(ok.plan.steps.find(s => s.name === 'PREFLIGHT_DB').status, 'OK');

  const failing = await runOrchestrator(base.deps, { ...base.options, preflightResult: checkResult(PREFLIGHT_CHECKS, { fail: 1 }) });
  assert.equal(failing.plan.stopClass, 'PREFLIGHT_DB_FAILED');

  const truncated = await runOrchestrator(base.deps, { ...base.options, preflightResult: checkResult(PREFLIGHT_CHECKS, { drop: 3 }) });
  assert.equal(truncated.plan.stopClass, 'PREFLIGHT_DB_FAILED');
  assert.match(truncated.plan.reason, /vajaa/);
});

test('0010: varmuuskopio on pakollinen omistajan portti', async () => {
  const { deps, options } = setup({ production: 'F', dbState: '0009' });
  const result = await runOrchestrator(deps, { ...options, preflightResult: checkResult(PREFLIGHT_CHECKS) });
  assert.equal(result.plan.nextAction.migration, '0010');
  assert.equal(result.plan.risk.level, 'high');
  assert.match(result.plan.pendingGates.map(g => g.detail).join(' '), /VARMUUSKOPIO/);
});

test('rekonstruoitu tai vanha inventaario ei riitä migraation perusteeksi', async () => {
  const lock = lockFrom(stubGit({ production: 'E' }));
  const production = { date: '2026-09-26', text: fixture('production-2026-09-26.json') };
  const git = stubGit({ production: 'E' });
  const fsStub = stubFs(projectFiles({ lock, productionFixture: production }));
  const deps = { git, fs: fsStub, root: ROOT_STUB, now: () => new Date('2026-09-26T12:00:00Z'), sleep: async () => {} };
  const result = await runOrchestrator(deps, { live: false, preflightResult: checkResult(PREFLIGHT_CHECKS) });
  assert.equal(result.plan.nextAction.kind, 'MIGRATE');
  assert.match(result.plan.pendingGates.map(g => g.detail).join(' '), /tuore inventaario/);
});

test('migraation jälkeen: DEPLOY F vaatii verify_0009-tuloksen (0 poikkeavaa)', async () => {
  const { deps, options } = setup({ production: 'E', dbState: '0009' });
  const missing = await runOrchestrator(deps, options);
  assert.equal(missing.plan.nextAction.kind, 'DEPLOY');
  assert.equal(missing.plan.candidate.wave, 'F');
  assert.match(missing.plan.pendingGates.map(g => g.detail).join(' '), /verify_0009\.sql/);

  const bad = await runOrchestrator(deps, { ...options, verifyResult: checkResult(VERIFY_CHECKS, { fail: 2 }) });
  assert.equal(bad.plan.stopClass, 'VERIFY_FAILED');

  const good = await runOrchestrator(deps, { ...options, verifyResult: checkResult(VERIFY_CHECKS) });
  assert.equal(good.plan.steps.find(s => s.name === 'VERIFY').status, 'OK');
  assert.equal(good.plan.state, 'STOP_OWNER_DEPLOY');
  assert.equal(good.plan.verifySql, undefined);
  assert.deepEqual(good.plan.sql.map(f => f.path), ['supabase/verify/verify_0009.sql']);
});

test('koodi edellä kantaa -> STOP ROLLBACK_CODE', async () => {
  const { git, deps, options } = setup({ production: 'F', dbState: '0008' });
  const result = await runOrchestrator(deps, options);
  assert.equal(result.plan.stopClass, 'ROLLBACK_CODE');
  assert.deepEqual(pushes(git), []);
});

test('J + 0013 -> DONE, exit 0, ei mitään deployattavaa', async () => {
  const { git, deps, options } = setup({ production: 'J', dbState: '0013' });
  const result = await runOrchestrator(deps, options);
  assert.equal(result.plan.decision, 'DONE');
  assert.equal(result.exitCode, 0);
  assert.deepEqual(pushes(git), []);
});

// =====================================================================
// DEPLOY + VERIFY_LIVE + PÄIVÄKIRJA (tynkä-push)
// =====================================================================

test('KRIITTINEN: hyväksytty deploy: CAS, yksi push lukittuun SHA:han, live täsmää, päiväkirja, ei automaattista jatkoa', async () => {
  const { git, fs: fsStub, deps, options, served } = setup();
  const realPush = git.pushMain;
  git.pushMain = sha => { const r = realPush(sha); served.sha = sha; return r; };
  const result = await runOrchestrator(deps, { ...options, executeDeploy: true, approvedSha: shaOf('D'), accepted: ['C'] });
  assert.equal(result.deploy.ok, true, result.plan.reason);
  assert.deepEqual(pushes(git), [['push', shaOf('D')]]);
  const casIndex = git.calls.findIndex(c => c[0] === 'lsRemoteMain');
  const pushIndex = git.calls.findIndex(c => c[0] === 'push');
  assert.ok(casIndex !== -1 && casIndex < pushIndex, 'compare-and-swap ennen pushia');
  assert.equal(result.live.ok, true, result.live.problems.join('; '));
  assert.equal(result.plan.state, 'DEPLOYED_LIVE_USE_VALIDATION_PENDING');
  const accept = result.plan.steps.find(s => s.name === 'TECH_ACCEPTANCE');
  assert.ok(accept.detail.includes('AUTOMATED_TECHNICAL_ACCEPTANCE'));
  assert.ok(accept.detail.includes('LIVE_USE_VALIDATION_PENDING'));
  assert.equal(result.exitCode, 0);

  const appended = fsStub.writes.filter(w => w[0] === 'appendFileSync');
  assert.equal(appended.length, 1);
  assert.equal(appended[0][1], path.resolve(ROOT_STUB, '.claude/activation/journal.jsonl'));
  const entry = JSON.parse(appended[0][2]);
  assert.equal(entry.type, 'deploy');
  assert.equal(entry.wave, 'D');
  assert.equal(entry.sha, shaOf('D'));
  assert.equal(entry.previousSha, shaOf('C'));
  assert.equal(entry.acceptedWave, 'C');
  assert.equal(entry.result, 'AUTOMATED_TECHNICAL_ACCEPTANCE');
  assert.equal(entry.liveUse, 'LIVE_USE_VALIDATION_PENDING');
  assert.equal(fsStub.writes.some(w => w[0] === 'writeFileSync'), false);
});

test('deploy vaatii tuotannon aallon hyväksynnän: ilman --accepted=C ei pushia', async () => {
  const { git, deps, options } = setup();
  const result = await runOrchestrator(deps, { ...options, executeDeploy: true, approvedSha: shaOf('D') });
  assert.equal(result.plan.state, 'STOP_OWNER_DEPLOY');
  assert.match(result.plan.pendingGates.map(g => g.detail).join(' '), /aallon C hyväksyntä/);
  assert.deepEqual(pushes(git), []);
});

test('päiväkirjaan kirjattu hyväksyntä riittää', async () => {
  const journal = JSON.stringify({ at: '2026-09-26T10:00:00Z', type: 'acceptance', wave: 'C', sha: shaOf('C') }) + '\n';
  const { git, deps, options, served } = setup({ journal });
  const realPush = git.pushMain;
  git.pushMain = sha => { const r = realPush(sha); served.sha = sha; return r; };
  const result = await runOrchestrator(deps, { ...options, executeDeploy: true, approvedSha: shaOf('D') });
  assert.equal(result.deploy.ok, true, result.plan.reason);
});

test('KRIITTINEN: sormenjälki ei täsmää pushin jälkeen -> STOP, peruutuspaketti, päiväkirjaan VERIFY_LIVE_FAILED', async () => {
  // Tuotanto jää tarjoilemaan C:tä (Vercel ei deployannut): aikakatkaisu.
  const { git, fs: fsStub, deps, options } = setup();
  const result = await runOrchestrator(deps, {
    ...options, executeDeploy: true, approvedSha: shaOf('D'), accepted: ['C'], pollTimeoutMs: 0
  });
  assert.equal(result.deploy.ok, true);
  assert.equal(result.live.ok, false);
  assert.equal(result.plan.stopClass, 'VERIFY_LIVE_FAILED');
  const step = result.plan.steps.find(s => s.name === 'VERIFY_LIVE');
  const detail = step.detail.join('\n');
  assert.match(detail, /PERUUTUS aallolle D/);
  assert.match(detail, /v17 -> v18/);
  assert.match(detail, /TRAIN_HALTED_RECUT_REQUIRED/);
  assert.match(detail, /EI --force/);
  assert.equal(result.exitCode, 1);
  const entry = JSON.parse(fsStub.writes.find(w => w[0] === 'appendFileSync')[2]);
  assert.equal(entry.result, 'VERIFY_LIVE_FAILED');
  assert.equal(pushes(git).length, 1, 'ei uutta pushia peruutukseksi');
});

test('sormenjälki erottaa saman aallon eri commitit: väärä moduuli tuotannossa -> STOP', async () => {
  const other = 'dd'.repeat(20);
  const git0 = stubGit();
  const files = {};
  for (const p of ['sw.js', 'src/data/schema.js', 'index.html', 'src/domain/wellbeing.js', 'src/data/collectionsRepo.js']) files[p] = git0.show(shaOf('D'), p);
  files['src/app/main.js'] = '// aalto D, mutta eri commit\n';
  const { git, deps, options, served } = setup({ gitOptions: { extraCommits: { [other]: files } } });
  const realPush = git.pushMain;
  git.pushMain = sha => { const r = realPush(sha); served.sha = other; return r; };
  const result = await runOrchestrator(deps, { ...options, executeDeploy: true, approvedSha: shaOf('D'), accepted: ['C'], pollTimeoutMs: 0 });
  assert.equal(result.live.ok, false);
  assert.ok(result.live.problems.some(p => /sormenjälki: \/src\/app\/main\.js eroaa/.test(p)), result.live.problems.join('; '));
});

// =====================================================================
// LIVE-RISTIINTARKISTUS (READ_STATE)
// =====================================================================

test('live täsmää origin/mainiin -> READ_STATE OK', async () => {
  const { deps, options } = setup({ live: true });
  const result = await runOrchestrator(deps, { ...options, live: true });
  assert.equal(result.plan.steps[0].status, 'OK', JSON.stringify(result.plan.steps[0]));
  assert.match(result.plan.steps[0].detail.join(' '), /sormenjälki/);
});

test('KRIITTINEN: live ei vastaa origin/mainia -> STOP LIVE_MISMATCH', async () => {
  const { deps, options } = setup({ liveSha: shaOf('D') });
  const result = await runOrchestrator(deps, { ...options, live: true });
  assert.equal(result.plan.stopClass, 'LIVE_MISMATCH');
});

test('live ilman fetchiä -> STOP (ei hiljaista ohitusta)', async () => {
  const { deps, options } = setup();
  const result = await runOrchestrator({ ...deps, fetchImpl: null }, { ...options, live: true });
  assert.equal(result.plan.stopClass, 'LIVE_MISMATCH');
});

// =====================================================================
// PERUUTUS (ACT-10)
// =====================================================================

test('KRIITTINEN: päiväkirjan "peruttu D" estää E:n suunnittelun, kunnes lukko kirjoitetaan uudelleen', async () => {
  const lock = lockFrom(stubGit({ production: 'C' }));
  const lockText = JSON.stringify(lock, null, 2) + '\n';
  const { createHash } = await import('node:crypto');
  const lockSha256 = createHash('sha256').update(lockText).digest('hex');
  const journal = JSON.stringify({ at: '2026-09-27T10:00:00Z', type: 'rollback', wave: 'D', state: 'TRAIN_HALTED_RECUT_REQUIRED', lockSha256 }) + '\n';
  const { git, deps, options } = setup({ production: 'D', journal, lockOverride: lock });
  const result = await runOrchestrator(deps, options);
  assert.equal(result.plan.stopClass, 'TRAIN_HALTED_RECUT_REQUIRED');
  assert.deepEqual(pushes(git), []);

  // Uusi lukko (eri tiiviste) vapauttaa pysäytyksen.
  const relocked = { ...lock, note: `${lock.note} (uudelleenleikattu)` };
  const again = setup({ production: 'D', journal, lockOverride: relocked });
  const freed = await runOrchestrator(again.deps, again.options);
  assert.notEqual(freed.plan.stopClass, 'TRAIN_HALTED_RECUT_REQUIRED');
});

test('KRIITTINEN: tuotanto peruutustilassa (matriisi C, v18) -> TRAIN_HALTED_RECUT_REQUIRED', async () => {
  const rollbackSha = '99'.repeat(20);
  const git0 = stubGit();
  const files = { ...Object.fromEntries(['src/data/schema.js', 'index.html', 'src/app/main.js'].map(p => [p, git0.show(shaOf('C'), p)])) };
  files['sw.js'] = git0.show(shaOf('C'), 'sw.js').replace("'v16'", "'v18'");
  const { git, deps, options } = setup({ gitOptions: { productionSha: rollbackSha, extraCommits: { [rollbackSha]: files } } });
  const result = await runOrchestrator(deps, options);
  assert.equal(result.plan.stopClass, 'TRAIN_HALTED_RECUT_REQUIRED');
  assert.match(result.plan.reason, /aallon D peruutus/);
  assert.deepEqual(pushes(git), []);
});

test('peruutuksen todennus kirjaa vain --record-lipulla', async () => {
  const rollbackSha = '99'.repeat(20);
  const git0 = stubGit();
  const files = { ...Object.fromEntries(['src/data/schema.js', 'index.html', 'src/app/main.js', 'src/domain/wellbeing.js', 'src/data/collectionsRepo.js'].map(p => [p, git0.show(shaOf('C'), p)])) };
  files['sw.js'] = git0.show(shaOf('C'), 'sw.js').replace("'v16'", "'v18'");
  const { git, fs: fsStub, deps } = setup({ gitOptions: { extraCommits: { [rollbackSha]: files } } });
  const fetchImpl = stubFetch(git, rollbackSha);
  const dry = await verifyRollback({ ...deps, fetchImpl }, { rollbackOf: 'D' });
  assert.equal(dry.ok, true, dry.problems.join('; '));
  assert.equal(dry.journal, null);
  assert.deepEqual(writes(fsStub), []);
  const recorded = await verifyRollback({ ...deps, fetchImpl }, { rollbackOf: 'D', record: true });
  assert.equal(recorded.journal.entry.state, 'TRAIN_HALTED_RECUT_REQUIRED');
  assert.match(recorded.journal.entry.lockSha256, /^[0-9a-f]{64}$/);
});

test('peruutuspaketti nimeää aaltocommitin, törmäävän version ja pysäytyksen', () => {
  const lock = lockFrom(stubGit());
  const pack = rollbackPack('E', { lock }).join('\n');
  assert.match(pack, new RegExp(`git revert --no-edit ${shaOf('E')}`));
  assert.match(pack, /v18 -> v19/);
  assert.match(pack, /aallon F varattu versio/);
  assert.match(pack, /--rollback-of=E/);
  assert.equal(/push[^\n]*--force(?!-with-lease)[^\n]*$/m.test(pack.replace('(EI --force)', '')), false);
});

test('hyväksynnän kirjaus vain tuotannossa olevalle aallolle', () => {
  const { deps } = setup();
  const wrong = recordAcceptance(deps, { wave: 'D' });
  assert.equal(wrong.ok, false);
  assert.deepEqual(writes(deps.fs), []);
  const right = recordAcceptance(deps, { wave: 'C' });
  assert.equal(right.ok, true);
  assert.equal(right.journal.entry.type, 'acceptance');
});

// =====================================================================
// (h) PÄIVÄKIRJAN POLKU, (poikkeukset) FAIL CLOSED
// =====================================================================

test('KRIITTINEN: projektikansion ulkopuolinen päiväkirja hylätään', () => {
  const root = path.resolve('projekti');
  assert.throws(() => resolveJournalPath(root, '../muualla/journal.jsonl'), /ulkopuolella/);
  assert.throws(() => resolveJournalPath(root, path.resolve('toinen', 'journal.jsonl')), /ulkopuolella/);
  assert.throws(() => resolveJournalPath(root, '.'), /ulkopuolella/);
  assert.equal(resolveJournalPath(root), path.join(root, '.claude', 'activation', 'journal.jsonl'));
  const fsStub = stubFs();
  assert.throws(() => appendJournal({ a: 1 }, { fs: fsStub, root, journalPath: '../x.jsonl' }), /ulkopuolella/);
  assert.deepEqual(fsStub.writes, []);
});

test('kelvoton päiväkirjarivi pysäyttää (ei ohiteta)', async () => {
  const { deps, options } = setup({ journal: '{"type":"deploy"}\nei-jsonia\n' });
  const result = await runOrchestrator(deps, options);
  assert.equal(result.plan.stopClass, 'JOURNAL_UNREADABLE');
  const read = readJournal({ fs: deps.fs, root: ROOT_STUB });
  assert.equal(read.entries.length, 1);
  assert.equal(read.problems.length, 1);
});

test('KRIITTINEN: poikkeus git-kerroksessa -> STOP EXCEPTION, exit 1, ei pushia', async () => {
  const { git, deps, options } = setup({ gitOptions: { throwOn: 'isAncestor' } });
  const result = await runOrchestrator(deps, { ...options, executeDeploy: true, approvedSha: shaOf('D'), accepted: ['C'] });
  assert.equal(result.plan.stopClass, 'EXCEPTION');
  assert.equal(result.exitCode, 1);
  assert.deepEqual(pushes(git), []);
});

test('planNext on puhdas: sama tila -> sama suunnitelma', async () => {
  const { deps, options } = setup();
  const state = await readState(deps, options);
  const a = planNext(state, {}, deps);
  const b = planNext(state, {}, deps);
  assert.deepEqual(a, b);
  assert.equal(state.production.sha, shaOf('C'));
  assert.equal(state.production.cacheVersion, cacheVersionOf('C'));
  assert.deepEqual(state.production.gates, expectedMatrix('C'));
});

// =====================================================================
// (g) LÄHDE: EI KANTAYHTEYTTÄ, EI FORCEA
// =====================================================================

/** Lähde ilman kommentteja: kommentti saa KERTOA, ettei psql:ää käytetä. */
function codeOnly(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').split('\n')
    .filter(line => !line.trim().startsWith('//')).join('\n');
}

test('KRIITTINEN: orkestroija ei ota kantayhteyttä eikä käytä force-pushia', () => {
  for (const file of ['tools/activation/orchestrate.mjs', 'scripts/activation-orchestrate.mjs',
    'scripts/activation-dry-run.mjs', 'tools/release/git-layer.mjs', 'tools/release/live-assets.mjs']) {
    const code = codeOnly(read(file));
    for (const forbidden of [/postgres(?:ql)?:\/\//i, /\bpsql\b/, /supabase\s+(db|link|migration|functions)/i,
      /SUPABASE_(SERVICE|DB|ANON)/, /service_role/i, /from ['"]pg['"]/,
      // force komentoriviargumenttina tai '+'-refspecinä (ohjeteksti "EI --force" sallitaan)
      /['"]--force(?:-with-lease)?['"]|['"]-f['"]/, /['"`]\+[0-9a-f$]/]) {
      assert.equal(forbidden.test(code), false, `${file}: ${forbidden}`);
    }
  }
  const layer = read('tools/release/git-layer.mjs');
  assert.match(layer, /\['push', 'origin', `\$\{sha\}:refs\/heads\/main`\]/, 'push-refspec ei ole <sha>:refs/heads/main');
  assert.match(layer, /if \(!allowPush\) throw/);
  assert.equal((layer.match(/'push'/g) || []).length, 1, 'git-kerroksessa on vain yksi push-kutsu');
  const cli = read('scripts/activation-orchestrate.mjs');
  assert.match(cli, /createGit\(\{ allowPush: executeDeploy \}\)/, 'push sallitaan vain --execute-deploy-lipulla');
});

test('git-kerroksen push on estetty oletuksena', async () => {
  const { createGit } = await import('../tools/release/git-layer.mjs');
  const git = createGit({ execFile: () => { throw new Error('ei saa kutsua'); } });
  assert.throws(() => git.pushMain(shaOf('D')), /estetty/);
  const allowed = createGit({ allowPush: true, execFile: () => { throw new Error('ei saa kutsua'); } });
  assert.throws(() => allowed.pushMain('091e73c'), /40-merkkinen/);
});

test('HEAD-tynkä ei ole junan jäsen (tuotehaaraa ei pushata)', () => {
  const git = stubGit();
  assert.equal(git.isAncestor(shaOf('C'), HEAD_SHA), false);
});
