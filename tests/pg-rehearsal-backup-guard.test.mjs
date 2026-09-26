// Varmuuskopioharjoittelun vahti ja --only=backup-kytkentä ILMAN palvelinta.
//
// 2026-09-26 portissa 54329 vastasi toisen projektin PostgreSQL 15.
// rehearse-backup.mjs ja rehearse.mjs --only=backup ajavat ennen yhtäkään
// kannan tai roolin luontia lib.guardBackupRehearsal-vahdin:
//
//   1. PG_REHEARSAL_PORT nimenomaisesti ja ei 54329 — ENNEN yhteyttä
//   2. server_version_num >= 170000
//   3. data_directory pääkansion .claude/pg-local/-hakemistossa (ei ohitusta)
//
// Testit injektoivat ympäristön, yhteyden ja kyselyn tuloksen: yhtään
// yhteyttä ei avata.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { ROOT, read } from './helpers/sources.mjs';
import {
  FOREIGN_PORT, guardBackupRehearsal, mainProjectRoot, normalizeDir, projectRoot, rehearsalPortProblem,
  strictRehearsalServerProblem
} from '../tools/pg-rehearsal/lib.mjs';

const MAIN = 'C:\\Users\\info\\Desktop\\Manifestival';
const OWN_DATA = 'C:/Users/info/Desktop/Manifestival/.claude/pg-local/data-rehearsal';

/** Tynkäyhteys: kirjaa kutsut, palauttaa annetun palvelimen tiedot. */
function fakeServer({ num = '170010', ver = '17.10', dir = OWN_DATA, port = '54349' } = {}) {
  const calls = [];
  const connectFn = async () => {
    calls.push('connect');
    return {
      query: async sql => { calls.push(`query:${/current_setting/.test(sql) ? 'settings' : sql}`); return { rows: [{ num, ver, dir, port, full: `PostgreSQL ${ver}` }] }; },
      end: async () => { calls.push('end'); }
    };
  };
  return { calls, connectFn };
}

test('KRIITTINEN: portti on annettava nimenomaisesti eikä se saa olla 54329', () => {
  assert.equal(FOREIGN_PORT, 54329);
  assert.match(rehearsalPortProblem({}), /PG_REHEARSAL_PORT puuttuu/);
  assert.match(rehearsalPortProblem({ PG_REHEARSAL_PORT: '  ' }), /puuttuu/);
  assert.match(rehearsalPortProblem({ PG_REHEARSAL_PORT: '54329' }), /toisen projektin PostgreSQL 15/);
  assert.match(rehearsalPortProblem({ PG_REHEARSAL_PORT: ' 54329 ' }), /toisen projektin/);
  assert.match(rehearsalPortProblem({ PG_REHEARSAL_PORT: 'abc' }), /ei ole portti/);
  assert.match(rehearsalPortProblem({ PG_REHEARSAL_PORT: '70000' }), /ei ole portti/);
  assert.equal(rehearsalPortProblem({ PG_REHEARSAL_PORT: '54349' }), null);
});

test('KRIITTINEN: vahti ei avaa yhteyttä ilman porttia tai portilla 54329', async () => {
  for (const env of [{}, { PG_REHEARSAL_PORT: '54329' }, { PG_REHEARSAL_PORT: '54329', PG_REHEARSAL_ALLOW_FOREIGN: '1' }]) {
    const { calls, connectFn } = fakeServer();
    await assert.rejects(guardBackupRehearsal({ env, connectFn, mainRoot: MAIN }), /KESKEYTYS ennen yhteyttä/);
    assert.deepEqual(calls, [], `yhteys avattiin: ${JSON.stringify(env)}`);
  }
});

test('KRIITTINEN: vahti hylkää PostgreSQL 15:n, vieraan ja etuliitteeltään samannäköisen data-hakemiston', async () => {
  const env = { PG_REHEARSAL_PORT: '54349' };
  const cases = [
    [{ num: '150010', dir: 'C:/Users/info/tuntiset-pg15/data' }, /PostgreSQL 17/],
    [{ num: '160004' }, /PostgreSQL 17/],
    [{ dir: 'C:/Users/info/tuntiset-pg15/data' }, /data-hakemisto/],
    [{ dir: `${MAIN}\\.claude\\pg-local-muu\\data` }, /data-hakemisto/],
    // Worktreen oma .claude/pg-local ei kelpaa: vain pääkansion.
    [{ dir: `${MAIN}\\.claude\\worktrees\\x\\.claude\\pg-local\\data` }, /data-hakemisto/]
  ];
  for (const [server, pattern] of cases) {
    const { calls, connectFn } = fakeServer(server);
    await assert.rejects(guardBackupRehearsal({ env, connectFn, mainRoot: MAIN }), pattern, JSON.stringify(server));
    assert.equal(calls.at(-1), 'end', 'yhteys jäi auki');
  }
});

test('KRIITTINEN: vahdilla ei ole ohitusta (PG_REHEARSAL_ALLOW_FOREIGN ei koske sitä)', async () => {
  const { connectFn } = fakeServer({ dir: 'C:/muu/data' });
  await assert.rejects(guardBackupRehearsal({
    env: { PG_REHEARSAL_PORT: '54349', PG_REHEARSAL_ALLOW_FOREIGN: '1' }, connectFn, mainRoot: MAIN
  }), /data-hakemisto/);
  assert.match(strictRehearsalServerProblem({ versionNum: '170010', dataDirectory: 'C:/muu/data' }, { mainRoot: MAIN }), /data-hakemisto/);
});

test('vahti hyväksyy oman PostgreSQL 17 -klusterin ja palvelimen oman portin', async () => {
  const env = { PG_REHEARSAL_PORT: '54349' };
  const ok = fakeServer();
  const server = await guardBackupRehearsal({ env, connectFn: ok.connectFn, mainRoot: MAIN });
  assert.equal(server.versionNum, 170010);
  assert.equal(server.port, 54349);
  assert.deepEqual(ok.calls, ['connect', 'query:settings', 'end']);
  // Palvelin kertoo eri portin kuin pyydettiin -> keskeytys.
  const other = fakeServer({ port: '54350' });
  await assert.rejects(guardBackupRehearsal({ env, connectFn: other.connectFn, mainRoot: MAIN }), /portikseen 54350, pyydettiin 54349/);
});

test('pääkansio löytyy git-common-dirista, ja polkulogiikka on varalla', () => {
  assert.equal(mainProjectRoot({ root: `${MAIN}\\.claude\\worktrees\\agent-x`, gitCommonDir: 'C:/Users/info/Desktop/Manifestival/.git' }),
    'C:/Users/info/Desktop/Manifestival');
  assert.equal(mainProjectRoot({ root: `${MAIN}\\.claude\\worktrees\\agent-x`, gitCommonDir: '' }), MAIN);
  assert.equal(mainProjectRoot({ root: MAIN, gitCommonDir: `${MAIN}\\.git\\` }), MAIN);
  // Oikea git (tämä repo): sama pääkansio kuin polkulogiikalla.
  assert.equal(normalizeDir(mainProjectRoot()), normalizeDir(projectRoot(ROOT)));
});

test('KRIITTINEN: rehearse-backup.mjs: vahti ENNEN skenaariota; epäonnistunut vahti ei luo mitään', async () => {
  const { main } = await import('../tools/pg-rehearsal/rehearse-backup.mjs');
  const order = [];
  const quiet = () => {};
  const failed = await main(['--fixtures=tests/fixtures/backup', '--quiet'], {
    env: {},
    guard: async () => { order.push('guard'); throw new Error('VAHTI SANOI EI'); },
    scenario: async () => { order.push('scenario'); return []; },
    mkdir: () => { order.push('mkdir'); },
    writeFile: () => { order.push('write'); },
    log: quiet
  });
  assert.deepEqual(order, ['guard']);
  assert.equal(failed.exitCode, 1);
  assert.match(failed.failures[0], /KESKEYTYS: [\s\S]*VAHTI SANOI EI/);

  order.length = 0;
  let seen = null;
  const passed = await main(['--fixtures=tests/fixtures/backup', '--numbers=0010', '--variants=text', '--quiet'], {
    env: { PG_REHEARSAL_PORT: '54349' },
    guard: async ({ env }) => { order.push(`guard:${env.PG_REHEARSAL_PORT}`); return { version: '17.10', dataDirectory: OWN_DATA }; },
    scenario: async options => { order.push('scenario'); seen = options; return [{ id: 'B1', pass: true }]; },
    mkdir: dir => { order.push(`mkdir:${dir}`); },
    log: quiet
  });
  assert.deepEqual(order, ['guard:54349', 'mkdir:tests/fixtures/backup', 'scenario']);
  assert.equal(seen.fixtureDir, 'tests/fixtures/backup');
  assert.deepEqual(seen.numbers, ['0010']);
  assert.deepEqual(seen.variants, ['text']);
  assert.equal(passed.exitCode, 0);
});

test('KRIITTINEN: rehearse.mjs --only=backup: vahti ennen ensimmäistä yhteyttä, oma aineistohakemisto', () => {
  const src = read('tools/pg-rehearsal/rehearse.mjs').replace(/\r\n/g, '\n');
  const guardAt = src.indexOf("if (wantExplicit('backup')) report.backupGuard = await guard({ env });");
  const probeAt = src.indexOf('const probe = await connect();');
  assert.ok(guardAt !== -1, 'vahtia ei kutsuta --only=backup-ajossa');
  assert.ok(probeAt !== -1 && guardAt < probeAt, 'vahti ei ole ennen ensimmäistä yhteyttä');
  assert.match(src, /const bk = \(\) => import\('\.\/backup-scenario\.mjs'\);/);
  assert.match(src, /\(await bk\(\)\)\.backupScenario\(\{ fixtureDir: dir \}\)/);
  assert.match(src, /args\['backup-fixtures'\]/);
  assert.match(src, /if \(serverVerified\) \{\s*try \{ await dropTemplates\(\); \}/, 'epäonnistunut vahti johtaisi mallikantojen poistoyhteyteen');
  assert.match(read('tools/pg-rehearsal/backup-scenario.mjs'), /--only=backup/);
});

test('rehearse.mjs: backup on vain nimenomaisesti pyydetty skenaario', async () => {
  const { SCENARIOS, OPT_IN_SCENARIOS } = await import('../tools/pg-rehearsal/rehearse.mjs');
  assert.deepEqual([...OPT_IN_SCENARIOS], ['backup']);
  assert.equal(SCENARIOS.includes('backup'), false, 'backup ajettaisiin oletusajossa');
});

test('KRIITTINEN: rehearse.mjs main --only=backup: epäonnistunut vahti -> keskeytys, ei yhteyttä, ei skenaarioita', async () => {
  const { main } = await import('../tools/pg-rehearsal/rehearse.mjs');
  const log = console.log;
  const exitCode = process.exitCode;
  let report;
  console.log = () => {};
  try {
    report = await main(['--only=backup'], { env: {}, guard: async () => { throw new Error('VAHTI: portti puuttuu'); } });
  } finally {
    console.log = log;
    process.exitCode = exitCode;
  }
  assert.ok(report.failures.some(f => /KESKEYTYS: [\s\S]*VAHTI: portti puuttuu/.test(f)), report.failures.join('\n'));
  assert.equal(report.server, null, 'palvelimeen otettiin yhteys vahdin jälkeen');
  assert.deepEqual(Object.keys(report.scenarios), []);
});

test('README kertoo --only=backup-ajon ja vahdin', () => {
  const readme = read('tools/pg-rehearsal/README.md').replace(/\r\n/g, '\n');
  assert.match(readme, /--only=backup/);
  assert.match(readme, /--backup-fixtures=tests\/fixtures\/backup/);
  assert.match(readme, /rehearse-backup\.mjs/);
  assert.match(readme, /PG_REHEARSAL_PORT/);
  assert.ok(path.isAbsolute(ROOT));
});
