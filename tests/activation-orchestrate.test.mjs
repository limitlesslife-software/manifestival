// Aktivoinnin orkestroija (ACT-01, ACT-10): tynkähistoriaa vasten.
//
// Yksikään testi ei käytä oikeaa gitiä, levyä tai verkkoa: git-kerros,
// tiedostojärjestelmä ja tuotannon fetch ovat tynkiä
// (tests/helpers/activation-history.mjs). DEPLOY-haaraa EI KOSKAAN ajeta
// oikeaa pushia vasten — tynkä kirjaa kutsun, ja testit todistavat
// milloin sitä ei tehty.
//
// HYVÄKSYNTÄPOLITIIKKA (docs/activation/AUTOMATED-ACCEPTANCE-POLICY.md):
// tuotannon aallon portti on AUTOMATED_TECHNICAL_ACCEPTANCE päiväkirjassa,
// ei omistajan UI-hyväksyntä. Omistajan hyväksyntä vain migraatioille ja
// deployille.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { ROOT, read } from './helpers/sources.mjs';
import {
  HEAD_SHA, PREFLIGHT_CHECKS, ROOT_STUB, VERIFY_CHECKS, acceptanceEntry, checkResult, journalOf, lockFrom,
  projectFiles, shaOf, smokeEntry, smokeOutput, stubFetch, stubFs, stubGit, testOutput, testsEntry
} from './helpers/activation-history.mjs';
import {
  acceptancePack, appendJournal, bootSmokeCommand, planNext, readJournal, readState, recordBootSmoke, recordCandidateTests,
  recordTechnicalAcceptance, resolveJournalPath, rollbackPack, runOrchestrator, technicalAcceptance, verifyRollback
} from '../tools/activation/orchestrate.mjs';
import { TECHNICAL_REQUIREMENTS } from '../tools/activation/acceptance-policy.mjs';
import { cacheVersionOf, expectedMatrix } from '../tools/release/waves.mjs';

const fixture = name => fs.readFileSync(path.join(ROOT, 'tests/fixtures/activation-inventory', name), 'utf8');

/** Kanta tilassa `state` (fixture), tuore rivi 04 = nyt. */
function inventoryAt(state, now = '2026-09-26 10:00:00') {
  const parsed = JSON.parse(fixture(`state-${state}.json`));
  parsed.rows['04'] = now;
  return JSON.stringify(parsed);
}

/** Valmis päiväkirja: tuotannon aalto teknisesti hyväksytty + seuraavan ehdokkaan testit ja käynnistyssavu. */
const READY_C_TO_D = journalOf(acceptanceEntry('C'), testsEntry('D'), smokeEntry('D'));

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

/** Deploy-ajo: live-tila tarkistettu (LIVE_REQUIRED), push siirtää tuotannon. */
function deploySetup(overrides = {}) {
  const s = setup({ journal: READY_C_TO_D, live: true, ...overrides });
  const realPush = s.git.pushMain;
  s.git.pushMain = sha => { const r = realPush(sha); s.served.sha = sha; return r; };
  return s;
}

const pushes = git => git.calls.filter(c => c[0] === 'push' || c[0] === 'update-ref');
const writes = fsStub => fsStub.writes.filter(w => w[0] !== 'mkdirSync');
const kinds = plan => Object.fromEntries(['OWNER_APPROVAL', 'OWNER_INPUT', 'TECHNICAL']
  .map(k => [k, plan.pendingGates.filter(g => g.kind === k).map(g => g.class)]));

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
  assert.match(gates, /aallon C \(0101010\) tekninen hyväksyntä puuttuu/);
  assert.match(gates, new RegExp(`--wave=C --sha=${shaOf('C')} --record-acceptance`));
  assert.match(gates, new RegExp(`--approved-sha=${shaOf('D')}`));
  assert.match(gates, /omistajan viesti "hyväksyn D"/);
  assert.equal(/UI|selain/i.test(gates), false, 'UI-hyväksyntä on yhä portti');
  assert.deepEqual(kinds(result.plan), {
    OWNER_APPROVAL: ['OWNER_DEPLOY_APPROVAL_REQUIRED'],
    OWNER_INPUT: [],
    TECHNICAL: ['TECHNICAL_ACCEPTANCE_REQUIRED', 'CANDIDATE_TESTS_REQUIRED', 'BOOT_SMOKE_REQUIRED']
  });
  assert.deepEqual(result.plan.liveUse.map(l => [l.wave, l.status]), [['C', 'LIVE_USE_VALIDATION_PENDING']]);
});

test('KRIITTINEN: suunnitelma antaa puuttuvan käynnistyssavun tarkan ajo- ja kirjauskomennon', async () => {
  const d = shaOf('D');
  assert.equal(bootSmokeCommand('D', d),
    `git worktree add --detach .claude/worktrees/rc-D-smoke ${d} && npm run e2e:boot-smoke -- --root .claude/worktrees/rc-D-smoke --label D --expect-sha ${d} > .claude/activation/smoke-D-0202020.txt; `
    + `npm run activation:orchestrate -- --record-boot-smoke=D --sha=${d} --smoke-result=.claude/activation/smoke-D-0202020.txt`);
  const { deps, options } = setup({ journal: journalOf(acceptanceEntry('C'), testsEntry('D')) });
  const result = await runOrchestrator(deps, options);
  const smoke = result.plan.pendingGates.find(g => g.class === 'BOOT_SMOKE_REQUIRED');
  assert.equal(smoke.kind, 'TECHNICAL');
  assert.equal(smoke.detail,
    `ehdokkaan D (0202020) käynnistyssavu omalla koodilla ja porteilla ei ole kirjattu PASSiksi: ${bootSmokeCommand('D', d)}`);
  assert.deepEqual(kinds(result.plan).TECHNICAL, ['BOOT_SMOKE_REQUIRED']);
  assert.equal(result.plan.evidence.bootSmoke, undefined);
  assert.match(result.plan.steps.at(-1).detail.join(' '), /BOOT_SMOKE_REQUIRED: .*--record-boot-smoke=D/);

  // Kirjattu PASS poistaa portin ja päätyy todisteeksi.
  const ready = setup({ journal: READY_C_TO_D });
  const plan = (await runOrchestrator(ready.deps, ready.options)).plan;
  assert.equal(plan.pendingGates.some(g => g.class === 'BOOT_SMOKE_REQUIRED'), false);
  assert.match(plan.evidence.bootSmoke, /^käynnistyssavu \[D\] 27\/27 PASS omilla porteilla, poikkeuksia 0, hylkäyksiä 0, konsolivirheitä 0, tuotantopyyntöjä 0/);

  // Migraatioaallon ehdokas: portti näkyy jo ennen migraatiota.
  const migrate = setup({ production: 'E', dbState: '0008' });
  const gates = (await runOrchestrator(migrate.deps, migrate.options)).plan.pendingGates;
  assert.match(gates.find(g => g.class === 'BOOT_SMOKE_REQUIRED').detail, new RegExp(`--record-boot-smoke=F --sha=${shaOf('F')}`));
});

test('kuivaharjoitus ei pushaa edes --approved-sha:lla ilman --execute-deploy', async () => {
  const { git, deps, options } = setup({ journal: READY_C_TO_D });
  const result = await runOrchestrator(deps, { ...options, approvedSha: shaOf('D') });
  assert.equal(result.plan.state, 'STOP_OWNER_DEPLOY');
  assert.deepEqual(kinds(result.plan).TECHNICAL, [], 'tekninen hyväksyntä ja testit ovat päiväkirjassa');
  assert.deepEqual(pushes(git), []);
});

// =====================================================================
// (b)–(d) DEPLOYN ESTEET
// =====================================================================

test('KRIITTINEN: väärä --approved-sha -> STOP eikä pushia', async () => {
  const { git, deps, options } = deploySetup();
  const result = await runOrchestrator(deps, { ...options, executeDeploy: true, approvedSha: shaOf('E') });
  assert.equal(result.plan.stopClass, 'APPROVED_SHA_MISMATCH');
  assert.equal(result.exitCode, 1);
  assert.deepEqual(pushes(git), []);
});

test('KRIITTINEN: origin main siirtynyt (compare-and-swap) -> STOP eikä pushia', async () => {
  const { git, deps, options } = deploySetup({ gitOptions: { remoteMain: 'ff'.repeat(20) } });
  const result = await runOrchestrator(deps, { ...options, executeDeploy: true, approvedSha: shaOf('D') });
  assert.equal(result.plan.stopClass, 'REMOTE_MAIN_MOVED');
  assert.equal(result.deploy.ok, false);
  assert.deepEqual(pushes(git), []);
  assert.equal(result.journal, null, 'päiväkirjaan ei kirjata pushia, jota ei tapahtunut');
});

test('KRIITTINEN: siirtynyt viite (rev-parse != lukko) -> STOP LOCK_DRIFT', async () => {
  const lock = lockFrom(stubGit());
  const { git, deps, options } = deploySetup({ gitOptions: { refOverrides: { [lock.waves[1].ref]: 'ee'.repeat(20) } }, lockOverride: lock });
  const result = await runOrchestrator(deps, { ...options, executeDeploy: true, approvedSha: shaOf('D') });
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
  const { git, deps, options } = deploySetup();
  git.statusPorcelain = () => ' M tools/activation/train-map.mjs';
  const result = await runOrchestrator(deps, { ...options, executeDeploy: true, approvedSha: shaOf('D') });
  assert.equal(result.plan.stopClass, 'WORKING_TREE_DIRTY');
  assert.deepEqual(pushes(git), []);
});

test('KRIITTINEN: git status epäonnistui (null) -> deploy STOP WORKING_TREE_UNKNOWN; kuivaharjoitus ei pysähdy', async () => {
  const { git, deps, options } = deploySetup();
  git.statusPorcelain = () => null;
  const result = await runOrchestrator(deps, { ...options, executeDeploy: true, approvedSha: shaOf('D') });
  assert.equal(result.plan.stopClass, 'WORKING_TREE_UNKNOWN');
  assert.deepEqual(pushes(git), []);
  const dry = await runOrchestrator(deps, options);
  assert.equal(dry.plan.state, 'STOP_OWNER_DEPLOY');

  // Git-kerros ilman statusPorcelainia: sama (ei "puhdas" oletuksena).
  const bare = deploySetup();
  delete bare.git.statusPorcelain;
  const noStatus = await runOrchestrator(bare.deps, { ...bare.options, executeDeploy: true, approvedSha: shaOf('D') });
  assert.equal(noStatus.plan.stopClass, 'WORKING_TREE_UNKNOWN');
  assert.deepEqual(pushes(bare.git), []);
});

test('KRIITTINEN: --execute-deploy ilman tarkistettua live-tilaa -> STOP LIVE_REQUIRED (kirjastotaso)', async () => {
  const { git, deps, options } = deploySetup();
  const offline = await runOrchestrator(deps, { ...options, live: false, executeDeploy: true, approvedSha: shaOf('D') });
  assert.equal(offline.plan.stopClass, 'LIVE_REQUIRED');
  const state = await readState(deps, { ...options, live: false });
  assert.equal(planNext(state, { executeDeploy: true, approvedSha: shaOf('D') }, deps).stopClass, 'LIVE_REQUIRED');
  const noFetch = await runOrchestrator({ ...deps, fetchImpl: null }, { ...options, executeDeploy: true, approvedSha: shaOf('D') });
  assert.equal(noFetch.plan.stopClass, 'LIVE_MISMATCH', 'live pyydetty ilman fetchiä: ei hiljaista ohitusta');
  assert.deepEqual(pushes(git), []);
  assert.equal(git.calls.some(c => c[0] === 'lsRemoteMain'), false);
});

// =====================================================================
// TEKNINEN HYVÄKSYNTÄ ON PORTTI, UI-HYVÄKSYNTÄ EI
// =====================================================================

test('KRIITTINEN: deploy vaatii tuotannon aallon teknisen hyväksynnän: ilman sitä STOP eikä pushia', async () => {
  const { git, deps, options } = deploySetup({ journal: journalOf(testsEntry('D'), smokeEntry('D')) });
  const result = await runOrchestrator(deps, { ...options, executeDeploy: true, approvedSha: shaOf('D') });
  assert.equal(result.plan.decision, 'STOP');
  assert.equal(result.plan.stopClass, 'TECHNICAL_ACCEPTANCE_REQUIRED');
  assert.deepEqual(pushes(git), []);
  assert.equal(git.calls.some(c => c[0] === 'lsRemoteMain'), false);
});

test('KRIITTINEN: deploy vaatii ehdokkaan vihreän testiajon: ilman sitä STOP CANDIDATE_TESTS_REQUIRED', async () => {
  for (const journal of [journalOf(acceptanceEntry('C'), smokeEntry('D')),
    journalOf(acceptanceEntry('C'), testsEntry('D', shaOf('D'), { fail: 1 }), smokeEntry('D'))]) {
    const { git, deps, options } = deploySetup({ journal });
    const result = await runOrchestrator(deps, { ...options, executeDeploy: true, approvedSha: shaOf('D') });
    assert.equal(result.plan.stopClass, 'CANDIDATE_TESTS_REQUIRED');
    assert.match(result.plan.steps.at(-1).detail.join(' '), /--record-candidate-tests=D/);
    assert.deepEqual(pushes(git), []);
  }
});

test('KRIITTINEN: deploy vaatii ehdokkaan käynnistyssavun (PASS samalle SHA:lle): ilman sitä STOP BOOT_SMOKE_REQUIRED', async () => {
  for (const [name, journal] of [
    ['ei savua', journalOf(acceptanceEntry('C'), testsEntry('D'))],
    ['savu FAIL', journalOf(acceptanceEntry('C'), testsEntry('D'), smokeEntry('D', shaOf('D'), { result: 'FAIL', pass: 26 }))],
    ['PASS mutta poikkeus', journalOf(acceptanceEntry('C'), testsEntry('D'), smokeEntry('D', shaOf('D'), { exceptions: 1 }))],
    ['toisen commitin savu', journalOf(acceptanceEntry('C'), testsEntry('D'), smokeEntry('D', 'dd'.repeat(20)))],
    ['toisen aallon savu', journalOf(acceptanceEntry('C'), testsEntry('D'), smokeEntry('E', shaOf('D')))],
    ['PASS, sitten FAIL', journalOf(acceptanceEntry('C'), testsEntry('D'), smokeEntry('D'), smokeEntry('D', shaOf('D'), { result: 'FAIL', pass: 20 }))]
  ]) {
    const { git, deps, options } = deploySetup({ journal });
    const result = await runOrchestrator(deps, { ...options, executeDeploy: true, approvedSha: shaOf('D') });
    assert.equal(result.plan.stopClass, 'BOOT_SMOKE_REQUIRED', name);
    assert.match(result.plan.steps.at(-1).detail.join(' '), /--record-boot-smoke=D/, name);
    assert.deepEqual(pushes(git), [], name);
    assert.equal(git.calls.some(c => c[0] === 'lsRemoteMain'), false, name);
  }
});

test('KRIITTINEN: vanhan mallin UI-hyväksyntä tai toisen commitin hyväksyntä ei kelpaa (fail closed)', async () => {
  const legacy = journalOf({ at: '2026-09-26T10:00:00Z', type: 'acceptance', wave: 'C', sha: shaOf('C') }, testsEntry('D'), smokeEntry('D'));
  const otherSha = journalOf(acceptanceEntry('C', 'cc'.repeat(20)), testsEntry('D'), smokeEntry('D'));
  const wrongWave = journalOf(acceptanceEntry('B', shaOf('C')), testsEntry('D'), smokeEntry('D'));
  for (const journal of [legacy, otherSha, wrongWave]) {
    const { git, deps, options } = deploySetup({ journal });
    const result = await runOrchestrator(deps, { ...options, executeDeploy: true, approvedSha: shaOf('D') });
    assert.equal(result.plan.stopClass, 'TECHNICAL_ACCEPTANCE_REQUIRED', journal);
    assert.deepEqual(pushes(git), []);
  }
});

test('esitarkistus (repoChecks) kuuluu PREFLIGHT_REPOon: tietoturvaosuma ehdokkaassa -> STOP', async () => {
  const { git, deps, options } = setup({ journal: READY_C_TO_D });
  git.grep = () => ['src/app/vuoto.js'];
  const result = await runOrchestrator(deps, options);
  assert.equal(result.plan.stopClass, 'LOCK_DRIFT');
  assert.match(result.plan.reason, /esitarkistus \(repoChecks\): .*AI-avainta/);
  delete git.grep;
  const noGrep = await runOrchestrator(deps, options);
  assert.match(noGrep.plan.reason, /tietoturvahaku \(git grep\) ei ole käytettävissä/);
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
  const result = await runOrchestrator(deps, options);
  assert.equal(result.plan.nextAction.kind, 'MIGRATE');
  assert.equal(result.plan.nextAction.migration, '0009');
  assert.equal(result.plan.state, 'STOP_OWNER_MIGRATION');
  const gates = result.plan.pendingGates.map(g => `${g.class} ${g.detail}`).join(' | ');
  assert.match(gates, /OWNER_READ_ONLY_SQL_REQUIRED supabase\/preflight\/preflight_0009\.sql/);
  assert.match(gates, /OWNER_PRODUCTION_MIGRATION_APPROVAL_REQUIRED .*"hyväksyn 0009\/F"/);
  assert.match(gates, /aallon E \(0303030\) tekninen hyväksyntä/);
  assert.match(gates, /ehdokkaan F .* testipatteristo/);
  assert.deepEqual(kinds(result.plan).OWNER_APPROVAL, ['OWNER_PRODUCTION_MIGRATION_APPROVAL_REQUIRED']);
  assert.deepEqual(pushes(git), []);
  const sql = result.plan.sql.map(f => f.path);
  assert.deepEqual(sql, ['supabase/preflight/preflight_0009.sql', 'supabase/migrations/0009_finance_2.sql', 'supabase/verify/verify_0009.sql']);
  for (const f of result.plan.sql) {
    assert.match(f.sha256, /^[0-9a-f]{64}$/);
    // SQL luetaan aina lukon SQL-lähteestä (SQL_SOURCE_WAVE = K), ei ehdokkaasta F.
    assert.equal(f.sourceSha, shaOf('K'));
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

test('0010: varmuuskopio (snapshot_state_0009 + restore check) on pakollinen osa omistajan porttia', async () => {
  const { deps, options } = setup({ production: 'F', dbState: '0009' });
  const result = await runOrchestrator(deps, { ...options, preflightResult: checkResult(PREFLIGHT_CHECKS) });
  assert.equal(result.plan.nextAction.migration, '0010');
  assert.equal(result.plan.risk.level, 'high');
  const approval = result.plan.pendingGates.find(g => g.class === 'OWNER_PRODUCTION_MIGRATION_APPROVAL_REQUIRED');
  assert.match(approval.detail, /VARMUUSKOPIO/);
  assert.match(approval.detail, /supabase\/backup\/snapshot_state_0009\.sql/);
  assert.match(approval.detail, /restore-snapshot\.mjs check/);
  assert.match(approval.detail, /"hyväksyn 0010\/G"/);
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
  assert.match(missing.plan.pendingGates.find(g => g.class === 'OWNER_DEPLOY_APPROVAL_REQUIRED').detail, /"hyväksyn 0009\/F"/);

  const bad = await runOrchestrator(deps, { ...options, verifyResult: checkResult(VERIFY_CHECKS, { fail: 2 }) });
  assert.equal(bad.plan.stopClass, 'VERIFY_FAILED');

  const good = await runOrchestrator(deps, { ...options, verifyResult: checkResult(VERIFY_CHECKS) });
  assert.equal(good.plan.steps.find(s => s.name === 'VERIFY').status, 'OK');
  assert.equal(good.plan.state, 'STOP_OWNER_DEPLOY');
  assert.equal(good.plan.verifySql, undefined);
  assert.deepEqual(good.plan.sql.map(f => f.path), ['supabase/verify/verify_0009.sql']);
  assert.match(good.plan.evidence.migrationVerify, /verify_0009\.sql: 30\/30 tarkistusta, 0 poikkeavaa/);
});

test('KRIITTINEN: oikean kannan verify-tulos, jonka numeroinnissa on aukkoja (kuten verify_0013), kelpaa', async () => {
  // verify_0013:n numerot ovat 01–08, 10–15, 20–28, … Aiemmin pisteytys
  // oletti 01..N ja pysäytti puhtaan tuloksen ("numerointi katkeaa
  // kohdassa 09"). Nyt vertailu on SQL-tiedoston omiin numeroihin.
  const sqlOverrides = { 'supabase/verify/verify_0009.sql': read('supabase/verify/verify_0013.sql') };
  const lock = lockFrom(stubGit({ production: 'E', sqlOverrides }));
  const { deps, options } = setup({ production: 'E', dbState: '0009', gitOptions: { sqlOverrides }, lockOverride: lock });
  const real = name => fs.readFileSync(path.join(ROOT, 'tests/fixtures/sql-results', name), 'utf8');
  const good = await runOrchestrator(deps, { ...options, verifyResult: real('verify_0013-pass.tsv') });
  assert.equal(good.plan.steps.find(s => s.name === 'VERIFY').status, 'OK', JSON.stringify(good.plan.steps.find(s => s.name === 'VERIFY')));
  assert.match(good.plan.evidence.migrationVerify, /33\/33 tarkistusta, 0 poikkeavaa/);
  const bad = await runOrchestrator(deps, { ...options, verifyResult: real('verify_0013-fail.tsv') });
  assert.equal(bad.plan.stopClass, 'VERIFY_FAILED');
  // Rivi puuttuu keskeltä (tarkistus 26) -> STOP ja nimetään.
  const cut = real('verify_0013-pass.tsv').split('\n').filter(l => !l.startsWith('26\t')).join('\n');
  const partial = await runOrchestrator(deps, { ...options, verifyResult: cut });
  assert.equal(partial.plan.stopClass, 'VERIFY_FAILED');
  assert.match(JSON.stringify(partial.plan.steps.find(s => s.name === 'VERIFY')), /tarkistukset 26 puuttuvat liitoksesta/);
});

test('koodi edellä kantaa -> STOP ROLLBACK_CODE', async () => {
  const { git, deps, options } = setup({ production: 'F', dbState: '0008' });
  const result = await runOrchestrator(deps, options);
  assert.equal(result.plan.stopClass, 'ROLLBACK_CODE');
  assert.deepEqual(pushes(git), []);
});

test('KRIITTINEN: J + 0013 -> seuraavaksi K (0014): lukittu K pysähtyy omistajan migraatioporttiin, ei pushia', async () => {
  // Aalto K (arjen käyttöjärjestelmä, 0014) seuraa J:tä ja on lukittu.
  // Orkestroija suunnittelee migraation 0014, mutta ei koskaan aja sitä:
  // STOP_OWNER_MIGRATION, SQL lukon lähteestä (K), verify_0013 edellytyksenä.
  const { git, fs: fsStub, deps, options } = setup({ production: 'J', dbState: '0013' });
  const result = await runOrchestrator(deps, { ...options, preflightResult: checkResult(PREFLIGHT_CHECKS) });
  assert.equal(result.plan.nextAction.kind, 'MIGRATE');
  assert.equal(result.plan.nextAction.wave, 'K');
  assert.equal(result.plan.nextAction.migration, '0014');
  assert.equal(result.plan.nextAction.verifyPrerequisite, 'supabase/verify/verify_0013.sql');
  assert.equal(result.plan.state, 'STOP_OWNER_MIGRATION');
  assert.equal(result.plan.candidate.sha, shaOf('K'));
  assert.equal(result.plan.steps.find(s => s.name === 'PREFLIGHT_REPO').status, 'OK');
  assert.equal(result.plan.steps.find(s => s.name === 'PREFLIGHT_DB').status, 'OK');
  assert.equal(result.plan.risk.level, 'low');
  assert.equal(result.plan.risk.backupRequired, false);
  assert.deepEqual(result.plan.sql.map(f => f.path), ['supabase/verify/verify_0013.sql', 'supabase/preflight/preflight_0014.sql',
    'supabase/migrations/0014_daily_life.sql', 'supabase/verify/verify_0014.sql']);
  for (const f of result.plan.sql) {
    assert.equal(f.sourceSha, shaOf('K'));
    assert.equal(f.matchesLock, true, f.path);
  }
  const approval = result.plan.pendingGates.find(g => g.class === 'OWNER_PRODUCTION_MIGRATION_APPROVAL_REQUIRED');
  assert.match(approval.detail, /"hyväksyn 0014\/K"/);
  assert.equal(/VARMUUSKOPIO/.test(approval.detail), false, '0014 ei vaadi tilannekuvaa');
  const gates = result.plan.pendingGates.map(g => `${g.class} ${g.detail}`).join(' | ');
  assert.match(gates, /aallon J \(0808080\) tekninen hyväksyntä/);
  assert.match(gates, /--record-candidate-tests=K/);
  assert.match(gates, /--record-boot-smoke=K/);
  assert.equal(result.exitCode, 1);
  assert.deepEqual(pushes(git), []);
  assert.deepEqual(writes(fsStub), []);
});

test('KRIITTINEN: lukitsematon aalto (lukko ilman K:ta) pysäyttää (LOCK_DRIFT), ei pushia', async () => {
  // Sama tilanne kuin ennen K v1:n lukitsemista: orkestroija kertoo
  // seuraavan askeleen mutta pysähtyy — lukitsematonta SHA:ta ei koskaan
  // deployata eikä sen migraatiota suunnitella.
  const full = lockFrom(stubGit({ production: 'J' }));
  const lockOverride = { ...full, waves: full.waves.filter(w => w.wave !== 'K') };
  for (const executeDeploy of [false, true]) {
    const { git, deps, options } = setup({ production: 'J', dbState: '0013', lockOverride, live: executeDeploy });
    const result = await runOrchestrator(deps, { ...options, executeDeploy, approvedSha: executeDeploy ? shaOf('K') : null });
    assert.equal(result.plan.decision, 'STOP');
    assert.equal(result.plan.stopClass, 'LOCK_DRIFT');
    assert.equal(result.plan.nextAction.kind, 'MIGRATE');
    assert.equal(result.plan.nextAction.wave, 'K');
    assert.equal(result.plan.nextAction.migration, '0014');
    assert.notEqual(result.exitCode, 0);
    assert.deepEqual(pushes(git), []);
  }
});

test('K + 0014: DEPLOY K vaatii verify_0014-tuloksen; K tuotannossa + 0014 -> DONE (junan loppu)', async () => {
  const pending = setup({ production: 'J', dbState: '0014' });
  const missing = await runOrchestrator(pending.deps, pending.options);
  assert.equal(missing.plan.nextAction.kind, 'DEPLOY');
  assert.equal(missing.plan.candidate.wave, 'K');
  assert.equal(missing.plan.candidate.sha, shaOf('K'));
  assert.match(missing.plan.pendingGates.map(g => g.detail).join(' '), /verify_0014\.sql/);
  assert.match(missing.plan.pendingGates.find(g => g.class === 'OWNER_DEPLOY_APPROVAL_REQUIRED').detail, /"hyväksyn 0014\/K"/);
  const good = await runOrchestrator(pending.deps, { ...pending.options, verifyResult: checkResult(VERIFY_CHECKS) });
  assert.equal(good.plan.state, 'STOP_OWNER_DEPLOY');
  assert.match(good.plan.evidence.migrationVerify, /verify_0014\.sql: 30\/30 tarkistusta, 0 poikkeavaa/);
  assert.deepEqual(pushes(pending.git), []);

  const done = setup({ production: 'K', dbState: '0014', journal: journalOf(acceptanceEntry('K')) });
  const end = await runOrchestrator(done.deps, done.options);
  assert.equal(end.plan.decision, 'DONE', end.plan.reason);
  assert.equal(end.exitCode, 0);
  assert.deepEqual(pushes(done.git), []);
});

// =====================================================================
// DEPLOY + VERIFY_LIVE + PÄIVÄKIRJA (tynkä-push)
// =====================================================================

test('KRIITTINEN: hyväksytty deploy: CAS, yksi push lukittuun SHA:han, live täsmää, tekninen hyväksyntä kirjataan, ei automaattista jatkoa', async () => {
  const { git, fs: fsStub, deps, options } = deploySetup();
  const result = await runOrchestrator(deps, { ...options, executeDeploy: true, approvedSha: shaOf('D') });
  assert.equal(result.deploy.ok, true, result.plan.reason);
  assert.deepEqual(pushes(git), [['push', shaOf('D')]]);
  const casIndex = git.calls.findIndex(c => c[0] === 'lsRemoteMain');
  const pushIndex = git.calls.findIndex(c => c[0] === 'push');
  assert.ok(casIndex !== -1 && casIndex < pushIndex, 'compare-and-swap ennen pushia');
  assert.equal(result.live.ok, true, result.live.problems.join('; '));
  assert.equal(result.plan.state, 'DEPLOYED_TECHNICALLY_ACCEPTED');
  const accept = result.plan.steps.find(s => s.name === 'TECH_ACCEPTANCE');
  assert.ok(accept.detail.includes('AUTOMATED_TECHNICAL_ACCEPTANCE'));
  assert.ok(accept.detail.includes('LIVE_USE_VALIDATION_PENDING'));
  assert.equal(accept.detail.some(d => /LIVE_USE_VALIDATION_PENDING\s*[:=]\s*PASS|käyttö\w*\s*[:=]\s*PASS/i.test(d)), false, 'käyttötodennusta kutsutaan PASSiksi');
  assert.ok(accept.detail.some(d => /LIVE_USE_VALIDATION_PENDING \(tiedoksi — ei estä junaa, ei PASS\): docs\/acceptance\/WAVE-D\.md/.test(d)));
  assert.equal(result.exitCode, 0);

  const appended = fsStub.writes.filter(w => w[0] === 'appendFileSync');
  assert.equal(appended.length, 1);
  assert.equal(appended[0][1], path.resolve(ROOT_STUB, '.claude/activation/journal.jsonl'));
  const entry = JSON.parse(appended[0][2]);
  assert.equal(entry.type, 'deploy');
  assert.equal(entry.wave, 'D');
  assert.equal(entry.sha, shaOf('D'));
  assert.equal(entry.previousSha, shaOf('C'));
  assert.deepEqual(entry.previousAcceptance, { wave: 'C', sha: shaOf('C'), at: '2026-09-26T10:00:00.000Z' });
  assert.equal(entry.ownerMessage, 'hyväksyn D');
  assert.equal(entry.result, 'AUTOMATED_TECHNICAL_ACCEPTANCE');
  assert.equal(entry.liveUse, 'LIVE_USE_VALIDATION_PENDING');
  for (const r of TECHNICAL_REQUIREMENTS) assert.ok(entry.checks[r.id], `päiväkirjan ehto puuttuu: ${r.id}`);
  assert.match(entry.checks.bootSmoke, /^käynnistyssavu \[D\] 27\/27 PASS omilla porteilla/);
  assert.equal('acceptedWave' in entry, false, 'vanha UI-hyväksyntäkenttä');
  assert.equal(fsStub.writes.some(w => w[0] === 'writeFileSync'), false);

  // Seuraava ajo: D on nyt teknisesti hyväksytty tuotannon commitina.
  git.setOrigin(shaOf('D'));
  const next = await runOrchestrator(deps, { ...options, live: false });
  assert.equal(next.plan.candidate.wave, 'E');
  assert.equal(next.plan.pendingGates.some(g => g.class === 'TECHNICAL_ACCEPTANCE_REQUIRED'), false);
});

test('KRIITTINEN: sormenjälki ei täsmää pushin jälkeen -> STOP, peruutuspaketti, päiväkirjaan VERIFY_LIVE_FAILED', async () => {
  // Tuotanto jää tarjoilemaan C:tä (Vercel ei deployannut): aikakatkaisu.
  const { git, fs: fsStub, deps, options } = setup({ journal: READY_C_TO_D, live: true });
  const result = await runOrchestrator(deps, {
    ...options, executeDeploy: true, approvedSha: shaOf('D'), pollTimeoutMs: 0
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
  const { git, deps, options, served } = setup({ journal: READY_C_TO_D, live: true, gitOptions: { extraCommits: { [other]: files } } });
  const realPush = git.pushMain;
  git.pushMain = sha => { const r = realPush(sha); served.sha = other; return r; };
  const result = await runOrchestrator(deps, { ...options, executeDeploy: true, approvedSha: shaOf('D'), pollTimeoutMs: 0 });
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
// TEKNISEN HYVÄKSYNNÄN KIRJAUS LIVE-TODENNUKSESTA (C) JA TESTIAJON KIRJAUS
// =====================================================================

test('KRIITTINEN: C:n tekninen hyväksyntä live-todennuksesta: kaikki ehdot, yksi päiväkirjarivi, ja portti aukeaa', async () => {
  const { fs: fsStub, deps, options } = setup();
  const dry = await technicalAcceptance(deps, { wave: 'C', sha: shaOf('C'), inventoryPath: 'inventaario.json' });
  assert.equal(dry.ok, true, dry.problems.join('; '));
  assert.deepEqual(writes(fsStub), [], 'technicalAcceptance ei kirjoita');
  for (const r of TECHNICAL_REQUIREMENTS) assert.ok(dry.checks[r.id], `ehto puuttuu: ${r.id}`);
  assert.match(dry.checks.candidateTests, /ennen aktivointityökaluja/);
  assert.match(dry.checks.bootSmoke, /^C: ei kirjattua savua — C deployattiin ennen aktivointityökaluja/);
  assert.match(dry.checks.liveAssets, /sormenjälki \d+ tiedostoa = 0101010/);

  const recorded = await recordTechnicalAcceptance(deps, { wave: 'C', sha: shaOf('C'), inventoryPath: 'inventaario.json' });
  assert.equal(recorded.ok, true);
  const appended = fsStub.writes.filter(w => w[0] === 'appendFileSync');
  assert.equal(appended.length, 1);
  assert.equal(appended[0][1], path.resolve(ROOT_STUB, '.claude/activation/journal.jsonl'));
  const entry = JSON.parse(appended[0][2]);
  assert.equal(entry.type, 'technical-acceptance');
  assert.equal(entry.result, 'AUTOMATED_TECHNICAL_ACCEPTANCE');
  assert.equal(entry.liveUse, 'LIVE_USE_VALIDATION_PENDING');
  assert.equal(entry.sha, shaOf('C'));

  const after = await runOrchestrator(deps, options);
  assert.equal(after.plan.pendingGates.some(g => g.class === 'TECHNICAL_ACCEPTANCE_REQUIRED'), false);
  assert.equal(after.plan.technicalAcceptance.status, 'AUTOMATED_TECHNICAL_ACCEPTANCE');
});

test('KRIITTINEN: teknistä hyväksyntää ei kirjata, jos yksikin ehto pettää', async () => {
  const cases = [
    ['väärä aalto', setup(), { wave: 'D', sha: shaOf('D') }, /origin\/main on aalto C, ei D/],
    ['väärä SHA', setup(), { wave: 'C', sha: shaOf('D') }, /vain tuotannossa oleva commit/],
    ['live tarjoilee muuta', setup({ liveSha: shaOf('D') }), { wave: 'C', sha: shaOf('C') }, /live: /],
    ['ei verkkoa', (() => { const s = setup(); s.deps.fetchImpl = null; return s; })(), { wave: 'C', sha: shaOf('C') }, /LIVE_REQUIRED/],
    ['ei inventaariota', setup({ inventory: false }), { wave: 'C', sha: shaOf('C') }, /OWNER_READ_ONLY_SQL_REQUIRED/],
    ['lyhyt SHA', setup(), { wave: 'C', sha: '0101010' }, /40-merkkisen/]
  ];
  for (const [name, s, opts, pattern] of cases) {
    const result = await recordTechnicalAcceptance(s.deps, { inventoryPath: s.options.inventoryPath, ...opts });
    assert.equal(result.ok, false, name);
    assert.match(result.problems.join('; '), pattern, name);
    assert.equal(result.journal, null, name);
    assert.deepEqual(writes(s.fs), [], `${name}: kirjoitti päiväkirjaan`);
  }
});

test('D:n ja F:n tekninen hyväksyntä vaatii kirjatun testiajon ja käynnistyssavun; F myös verify_0009-tuloksen', async () => {
  const d = setup({ production: 'D' });
  const noTests = await technicalAcceptance(d.deps, { wave: 'D', sha: shaOf('D'), inventoryPath: 'inventaario.json' });
  assert.equal(noTests.ok, false);
  assert.match(noTests.problems.join(' '), /CANDIDATE_TESTS_REQUIRED/);
  assert.match(noTests.problems.join(' '), /BOOT_SMOKE_REQUIRED/);

  // Testiajo kirjattu, savu puuttuu tai ei ole PASS: ei hyväksyntää eikä kirjausta.
  for (const [name, journal] of [
    ['savu puuttuu', journalOf(testsEntry('D'))],
    ['savu FAIL', journalOf(testsEntry('D'), smokeEntry('D', shaOf('D'), { result: 'FAIL', pass: 26 }))],
    ['toisen commitin savu', journalOf(testsEntry('D'), smokeEntry('D', 'dd'.repeat(20)))]
  ]) {
    const s = setup({ production: 'D', journal });
    const refused = await recordTechnicalAcceptance(s.deps, { wave: 'D', sha: shaOf('D'), inventoryPath: 'inventaario.json' });
    assert.equal(refused.ok, false, name);
    assert.deepEqual(refused.problems.filter(p => !p.startsWith('BOOT_SMOKE_REQUIRED')), [], `${name}: ${refused.problems.join('; ')}`);
    assert.equal(refused.problems.length, 1, name);
    assert.ok(refused.problems[0].includes(`--record-boot-smoke=D --sha=${shaOf('D')}`), name);
    assert.ok(refused.checks.candidateTests, `${name}: testiajo todennettiin`);
    assert.equal(refused.checks.bootSmoke, undefined, name);
    assert.equal(refused.journal, null, name);
    assert.deepEqual(writes(s.fs), [], `${name}: kirjoitti päiväkirjaan`);
  }

  // Molemmat kirjattu: hyväksytään, ja kirjaus sisältää molemmat ehdot.
  const dOk = setup({ production: 'D', journal: journalOf(testsEntry('D'), smokeEntry('D')) });
  const accepted = await recordTechnicalAcceptance(dOk.deps, { wave: 'D', sha: shaOf('D'), inventoryPath: 'inventaario.json' });
  assert.equal(accepted.ok, true, accepted.problems.join('; '));
  assert.match(accepted.entry.checks.candidateTests, /node --test 1600\/1600 PASS/);
  assert.match(accepted.entry.checks.bootSmoke, /^käynnistyssavu \[D\] 27\/27 PASS omilla porteilla/);
  for (const r of TECHNICAL_REQUIREMENTS) assert.ok(accepted.entry.checks[r.id], `ehto puuttuu: ${r.id}`);

  const f = setup({ production: 'F', dbState: '0009', journal: journalOf(testsEntry('F'), smokeEntry('F')) });
  const noVerify = await technicalAcceptance(f.deps, { wave: 'F', sha: shaOf('F'), inventoryPath: 'inventaario.json' });
  assert.match(noVerify.problems.join(' '), /verify_0009\.sql -tulos puuttuu/);
  const withVerify = await technicalAcceptance(f.deps, { wave: 'F', sha: shaOf('F'), inventoryPath: 'inventaario.json', verifyResult: checkResult(VERIFY_CHECKS) });
  assert.equal(withVerify.ok, true, withVerify.problems.join('; '));
  assert.match(withVerify.checks.migrationVerify, /verify_0009\.sql: 30\/30/);
  const badVerify = await technicalAcceptance(f.deps, { wave: 'F', sha: shaOf('F'), inventoryPath: 'inventaario.json', verifyResult: checkResult(VERIFY_CHECKS, { fail: 1 }) });
  assert.equal(badVerify.ok, false);
});

test('ehdokkaan testiajon kirjaus: vain vihreä, vain lukon deployTarget, yhteenveto pakollinen', () => {
  const s = setup();
  const green = recordCandidateTests(s.deps, { wave: 'D', sha: shaOf('D'), testsText: testOutput({ pass: 1596 }) });
  assert.equal(green.ok, true, green.reason);
  assert.equal(green.entry.type, 'candidate-tests');
  assert.equal(green.entry.pass, 1596);
  assert.equal(green.entry.fail, 0);
  assert.match(green.entry.outputSha256, /^[0-9a-f]{64}$/);

  const before = writes(s.fs).length;
  for (const [opts, pattern] of [
    [{ wave: 'D', sha: shaOf('D'), testsText: testOutput({ pass: 1595, fail: 1 }) }, /ei ole vihreä/],
    [{ wave: 'D', sha: shaOf('D'), testsText: testOutput({ pass: 1595, cancelled: 1 }) }, /ei ole vihreä/],
    [{ wave: 'D', sha: shaOf('D'), testsText: 'kaikki meni hyvin' }, /yhteenvetoa/],
    [{ wave: 'D', sha: shaOf('E'), testsText: testOutput() }, /ei ole aallon D lukittu deployTarget/],
    [{ wave: 'D', sha: '091e73c', testsText: testOutput() }, /40-merkkisen/]
  ]) {
    const result = recordCandidateTests(s.deps, opts);
    assert.equal(result.ok, false);
    assert.match(result.reason, pattern);
  }
  assert.equal(writes(s.fs).length, before, 'hylätty testiajo kirjattiin');
});

test('KRIITTINEN: käynnistyssavun kirjaus: vain PASS n/n nollalaskureilla, sama täysi SHA = lukon deployTarget, oikea aalto', () => {
  const s = setup();
  const d = shaOf('D');
  const text = smokeOutput({ label: 'D', sha: d });
  const green = recordBootSmoke(s.deps, { wave: 'D', sha: d, smokeText: text });
  assert.equal(green.ok, true, green.reason);
  const appended = s.fs.writes.filter(w => w[0] === 'appendFileSync');
  assert.equal(appended.length, 1);
  assert.equal(appended[0][1], path.resolve(ROOT_STUB, '.claude/activation/journal.jsonl'), 'vain (virtuaalinen) päiväkirja');
  const entry = JSON.parse(appended[0][2]);
  assert.deepEqual(entry, green.entry);
  assert.deepEqual(
    [entry.type, entry.wave, entry.sha, entry.result, entry.gates, entry.pass, entry.total, entry.exceptions, entry.rejections, entry.consoles, entry.production],
    ['boot-smoke', 'D', d, 'PASS', 'omat', 27, 27, 0, 0, 0, 0]);
  assert.equal(entry.command, `npm run e2e:boot-smoke -- --label D --expect-sha ${d}`);
  assert.equal(entry.at, '2026-09-26T12:00:00.000Z');
  assert.match(entry.outputSha256, /^[0-9a-f]{64}$/);

  const before = writes(s.fs).length;
  for (const [name, opts, pattern] of [
    ['FAIL', { wave: 'D', sha: d, smokeText: smokeOutput({ result: 'FAIL', pass: 25 }) }, /savun tulos on FAIL \(25\/27\)/],
    ['n/m', { wave: 'D', sha: d, smokeText: smokeOutput({ pass: 26 }) }, /tarkistuksia 26\/27/],
    ['konsolivirhe', { wave: 'D', sha: d, smokeText: smokeOutput({ consoles: 2 }) }, /konsolivirheitä 2/],
    ['tuotantopyyntö', { wave: 'D', sha: d, smokeText: smokeOutput({ production: 1 }) }, /tuotantopyyntöjä 1/],
    ['tulosrivi puuttuu', { wave: 'D', sha: d, smokeText: smokeOutput({ verdictLine: false }) }, /viimeinen rivi ei ole "KÄYNNISTYSSAVU/],
    ['EHDOKAS puuttuu', { wave: 'D', sha: d, smokeText: smokeOutput({ candidateLine: false }) }, /EHDOKAS-rivi/],
    ['tyhjä tuloste', { wave: 'D', sha: d, smokeText: '' }, /tuloste puuttuu tai on tyhjä/],
    ['ei tulostetta', { wave: 'D', sha: d, smokeText: null }, /--smoke-result/],
    ['UTF-16 (PowerShell)', { wave: 'D', sha: d, smokeText: [...smokeOutput()].join('\u0000') }, /UTF-16/],
    ['savu toiselle commitille', { wave: 'D', sha: d, smokeText: smokeOutput({ head: shaOf('E'), expectSha: shaOf('E') }) }, /savu ajettiin commitille 0303/],
    ['väärä nimi (--label E)', { wave: 'D', sha: d, smokeText: smokeOutput({ label: 'E' }) }, /savun nimi on \[E\], ei aalto \[D\]/],
    ['--gates J', { wave: 'D', sha: d, smokeText: smokeOutput({ gates: 'J' }) }, /omilla porteillaan/],
    ['E:n savu D:n kirjauksena', { wave: 'E', sha: d, smokeText: smokeOutput({ label: 'E', sha: d }) }, /ei ole aallon E lukittu deployTarget/],
    ['E:n SHA D:lle', { wave: 'D', sha: shaOf('E'), smokeText: smokeOutput({ label: 'D', sha: shaOf('E') }) }, /ei ole aallon D lukittu deployTarget/],
    ['lyhyt SHA', { wave: 'D', sha: '0202020', smokeText: text }, /40-merkkisen/],
    ['ei junan aalto', { wave: 'B', sha: d, smokeText: text }, /ei ole junan C–K aalto/]
  ]) {
    const result = recordBootSmoke(s.deps, opts);
    assert.equal(result.ok, false, name);
    assert.equal(result.journal, null, name);
    assert.match(result.reason, pattern, name);
  }
  assert.equal(writes(s.fs).length, before, 'hylätty savu kirjattiin');
});

test('C (PRE_TOOLING_WAVE): savun kirjaus sallitaan kuten testiajon; kirjattu savu näkyy todisteena, puuttuva ei estä', async () => {
  const s = setup();
  const c = shaOf('C');
  const recorded = recordBootSmoke(s.deps, { wave: 'C', sha: c, smokeText: smokeOutput({ label: 'C', sha: c }) });
  assert.equal(recorded.ok, true, recorded.reason);
  const accepted = await technicalAcceptance(s.deps, { wave: 'C', sha: c, inventoryPath: 'inventaario.json' });
  assert.equal(accepted.ok, true, accepted.problems.join('; '));
  assert.match(accepted.checks.bootSmoke, /^käynnistyssavu \[C\] 27\/27 PASS/);
  assert.match(accepted.checks.candidateTests, /ennen aktivointityökaluja/, 'testiajo yhä poikkeuksella');
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

test('KRIITTINEN: peruutuspaketti: irrotus deployTargetiin, revert ilman committia, versionnosto, CAS ja push revert-SHA:sta ilman forcea', () => {
  const lock = lockFrom(stubGit());
  const lines = rollbackPack('E', { lock });
  const pack = lines.join('\n');
  const at = pattern => lines.findIndex(l => pattern.test(l));
  const order = [
    new RegExp(`^  git switch --detach ${shaOf('E')}$`),
    new RegExp(`^  git revert --no-commit ${shaOf('E')}$`),
    /nosta CACHE_VERSION v18 -> v19 \(seuraava vapaa vN/,
    /^  git commit -am "revert\(release\): peru aalto E \(v19\)"$/,
    /^  git rev-parse HEAD/,
    new RegExp(`^  git ls-remote origin refs/heads/main .*compare-and-swap: oltava yhä ${shaOf('E')}`),
    /^  git push origin <revert-sha>:refs\/heads\/main {3}\(EI --force\)$/,
    /--rollback-of=E/,
    /--verify-rollback-of=E --record/
  ].map(at);
  assert.ok(order.every(i => i !== -1), `puuttuva rivi: ${order.join(', ')}\n${pack}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order, `järjestys väärin:\n${pack}`);
  assert.match(lines[0], /^PERUUTUS aallolle E -> tila D/);
  assert.match(pack, /v19 on aallon F varattu versio/);
  assert.match(pack, /TRAIN_HALTED_RECUT_REQUIRED/);
  assert.equal(/--no-edit/.test(pack), false, 'vanha revert --no-edit jäi pakettiin');
  assert.equal(/push origin HEAD:main/.test(pack), false, 'vanha HEAD-push jäi pakettiin');
  assert.equal(/push[^\n]*--force(?!-with-lease)[^\n]*$/m.test(pack.replace('(EI --force)', '')), false);
  assert.equal(/-f\b|\+[0-9a-f<]/.test(lines.find(l => l.includes('git push'))), false);
});

test('peruutuspaketti junan viimeiselle aallolle K: tila J, v25, ei seuraavan aallon varausta', () => {
  const lock = lockFrom(stubGit());
  const pack = rollbackPack('K', { lock }).join('\n');
  assert.match(pack, /^PERUUTUS aallolle K -> tila J/);
  assert.match(pack, new RegExp(`git switch --detach ${shaOf('K')}`));
  assert.match(pack, /nosta CACHE_VERSION v24 -> v25/);
  assert.match(pack, /v25 on aallon - varattu versio/);
});

test('hyväksyntäpaketti: APK J:n jälkeen (verify_0013), ei siirry junan viimeisen aallon K taakse', () => {
  const lock = lockFrom(stubGit());
  const of = wave => acceptancePack(wave, lock.waves.find(w => w.wave === wave)).join('\n');
  assert.match(of('J'), /J:n jälkeen: APK \(docs\/activation\/ANDROID-ACCEPTANCE-BUILD\.md; vasta kun verify_0013 = 0 ja J on tuotannossa\)/);
  assert.equal(/APK/.test(of('K')), false, 'APK-ehto siirtyi K:hon');
  assert.match(of('K'), /K on junan viimeinen aalto/);
  assert.match(of('K'), /supabase\/verify\/verify_0014\.sql \(vain luku\) = 0 poikkeavaa/);
  assert.equal(/APK|viimeinen aalto/.test(of('I')), false);
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
  const recorded = await recordTechnicalAcceptance(deps, { wave: 'C', sha: shaOf('C'), inventoryPath: 'inventaario.json' });
  assert.equal(recorded.ok, false);
  assert.match(recorded.problems[0], /päiväkirja/);
});

test('KRIITTINEN: poikkeus git-kerroksessa -> STOP EXCEPTION, exit 1, ei pushia', async () => {
  const { git, deps, options } = deploySetup({ gitOptions: { throwOn: 'isAncestor' } });
  const result = await runOrchestrator(deps, { ...options, executeDeploy: true, approvedSha: shaOf('D') });
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
  for (const file of ['tools/activation/orchestrate.mjs', 'tools/activation/acceptance-policy.mjs', 'scripts/activation-orchestrate.mjs',
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
  assert.match(cli, /--accepted on poistettu/, 'vanha --accepted-lippu ei pysähdy');
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

test('KRIITTINEN: verify-assets --record-acceptance kulkee saman kirjastofunktion kautta eikä salli muuta kohdetta', () => {
  const cli = read('scripts/production-verify-assets.mjs');
  assert.match(cli, /--record-acceptance/);
  assert.match(cli, /recordTechnicalAcceptance\(/);
  assert.match(cli, /if \(!aalto \|\| !sha \|\| peruutus \|\| päättele \|\| argumentti\('url'\)\)/);
  assert.match(cli, /fetchImpl: hae/, 'kirjaus ei käytä vain-GET-käärettä');
});
