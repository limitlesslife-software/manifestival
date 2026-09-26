// tools/pg-rehearsal: puhtaat apufunktiot ja turvavahdit ILMAN palvelinta.
//
// Oikean kannan todiste on node tools/pg-rehearsal/rehearse.mjs
// (docs/activation/REHEARSAL-REPORT.md). Nämä testit vartioivat sitä, mikä
// voi rikkoutua koodissa:
//
//   1. importti ei avaa yhteyttä eikä aja skenaarioita (2026-09-26 importti
//      yritti yhteyttä toisen projektin PostgreSQL 15:een)
//   2. palvelinvahti hylkää väärän version ja vieraan data-hakemiston
//   3. katalogi- ja rivieron vertailu, ROLLBACK-osion poiminta ja
//      PostgREST-kirjoituksen SQL-muoto

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

import { ROOT, read } from './helpers/sources.mjs';
import {
  diffCatalog, compareDigests, digestsIdentical, extractRollback, extractPreRollback, dryRunRollback,
  rehearsalServerProblem, projectRoot, normalizeDir, postgrestSql, wirePayload, formatSchemaDiff, PG_PORT
} from '../tools/pg-rehearsal/lib.mjs';

const MIGRATIONS = ['0009_finance_2', '0010_goal_to_action', '0011_personal_assistant',
  '0012_life_alignment', '0013_alignment_reality'];

test('KRIITTINEN: harjoittelumoduulien importti ei avaa yhteyttä eikä aja mitään', () => {
  // pg-ajurin hakemisto osoittaa olemattomaan paikkaan: jos yksikin moduuli
  // lataisi ajurin tai yrittäisi yhteyttä importissa, lapsiprosessi kaatuisi.
  const modules = ['lib.mjs', 'chain.mjs', 'baseline.mjs', 'seeds.mjs', 'prodshape.mjs', 'waves.mjs',
    'prodshape-scenarios.mjs', 'failure-scenarios.mjs', 'rollback-scenarios.mjs', 'rehearse.mjs',
    'backup-scenario.mjs', 'rehearse-backup.mjs'];
  const urls = modules.map(m => pathToFileURL(path.join(ROOT, 'tools/pg-rehearsal', m)).href);
  const script = `for (const u of ${JSON.stringify(urls)}) await import(u); console.log('IMPORTED');`;
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', timeout: 30000,
    env: { ...process.env, PG_REHEARSAL_MODULES: path.join(ROOT, 'tools/pg-rehearsal/__ei_pg_ajuria__'), PG_REHEARSAL_PORT: '1' }
  });
  assert.equal(res.status, 0, `importti kaatui: ${res.stderr}`);
  assert.equal(res.stdout.trim(), 'IMPORTED', `importti tulosti jotain (ajoiko skenaarioita?): ${res.stdout}`);
});

test('KRIITTINEN: palvelinvahti vaatii PostgreSQL 17:n ja oman data-hakemiston', () => {
  const pgLocal = 'C:\\Users\\info\\Desktop\\Manifestival\\.claude\\pg-local';
  const opts = { pgLocal, allowForeign: false };
  // Toisen projektin PostgreSQL 15 (2026-09-26 portissa 54329).
  assert.match(rehearsalServerProblem({ versionNum: '150010', dataDirectory: 'C:/Users/info/tuntiset-pg15/data' }, opts), /PostgreSQL 17/);
  assert.match(rehearsalServerProblem({ versionNum: '170010', dataDirectory: 'C:/Users/info/tuntiset-pg15/data' }, opts), /data-hakemisto/);
  // Etuliite ei riitä: pg-local-muu ei ole pg-local.
  assert.match(rehearsalServerProblem({ versionNum: '170010', dataDirectory: `${pgLocal}-muu/data` }, opts), /data-hakemisto/);
  assert.equal(rehearsalServerProblem({ versionNum: '170010', dataDirectory: 'C:/Users/info/Desktop/Manifestival/.claude/pg-local/data-rehearsal' }, opts), null);
  assert.equal(rehearsalServerProblem({ versionNum: '170006', dataDirectory: 'c:\\users\\info\\desktop\\manifestival\\.claude\\pg-local\\data' }, opts), null);
  // Ohitus koskee vain hakemistoa, ei versiota.
  assert.equal(rehearsalServerProblem({ versionNum: '170010', dataDirectory: '/muu' }, { pgLocal, allowForeign: true }), null);
  assert.match(rehearsalServerProblem({ versionNum: '160001', dataDirectory: '/muu' }, { pgLocal, allowForeign: true }), /PostgreSQL 17/);
});

test('worktree löytää projektin pääkansion (pg-local on vain siellä)', () => {
  assert.equal(projectRoot('C:\\Users\\info\\Desktop\\Manifestival\\.claude\\worktrees\\wf_1'), 'C:\\Users\\info\\Desktop\\Manifestival');
  assert.equal(projectRoot('/home/x/Manifestival/.claude/worktrees/rc-f'), '/home/x/Manifestival');
  assert.equal(projectRoot('C:\\Users\\info\\Desktop\\Manifestival'), 'C:\\Users\\info\\Desktop\\Manifestival');
  assert.equal(normalizeDir('C:\\A\\B\\'), 'c:/a/b');
});

test('oletusportti ei ole 54329 (toisen projektin PostgreSQL 15)', () => {
  if (process.env.PG_REHEARSAL_PORT) return;
  assert.notEqual(PG_PORT, 54329);
  assert.equal(PG_PORT, 54349);
  assert.match(read('tools/pg-rehearsal/README.md'), /54349/);
});

test('diffCatalog: lisätyt ja poistetut rivit lajiteltuina', () => {
  const d = diffCatalog(['con:goals:a', 'col:goals.x', 'rel:goals'], ['rel:goals', 'con:goals:b', 'col:goals.x', 'col:goals.y']);
  assert.deepEqual(d, { added: ['col:goals.y', 'con:goals:b'], removed: ['con:goals:a'] });
  assert.deepEqual(diffCatalog(['a'], ['a']), { added: [], removed: [] });
  assert.equal(formatSchemaDiff(d), '- con:goals:a\n+ col:goals.y\n+ con:goals:b\n');
});

test('compareDigests: lisätty, poistettu, muuttunut ja uudelleen kirjoitettu rivi', () => {
  const before = new Map([['a', { h: '1', xmin: '10' }], ['b', { h: '2', xmin: '11' }], ['c', { h: '3', xmin: '12' }]]);
  const after = new Map([['a', { h: '1', xmin: '10' }], ['b', { h: '9', xmin: '20' }], ['c', { h: '3', xmin: '21' }], ['d', { h: '4', xmin: '22' }]]);
  const d = compareDigests(before, after);
  assert.deepEqual(d, { added: ['d'], removed: [], changed: ['b'], xminChanged: ['b', 'c'] });
  assert.equal(digestsIdentical(d), false);
  const gone = compareDigests(before, new Map([['a', { h: '1', xmin: '10' }]]));
  assert.deepEqual(gone.removed, ['b', 'c']);
  assert.equal(digestsIdentical(compareDigests(before, new Map(before))), true);
});

test('KRIITTINEN: jokaisen ROLLBACK-osion poiminta: begin, lock_timeout, commit', () => {
  const executable = { '0009': 11, '0010': 39, '0011': 8, '0012': 19, '0013': 19 };
  for (const name of MIGRATIONS) {
    const rb = extractRollback(read(`supabase/migrations/${name}.sql`));
    assert.ok(rb, `${name}: ROLLBACK-osiota ei löytynyt`);
    const lines = rb.split('\n').filter(l => l.trim() && !l.trim().startsWith('--'));
    assert.equal(lines[0], 'begin;', name);
    assert.equal(lines[1], "set local lock_timeout = '5s';", `${name}: lock_timeout ei ole heti beginin jälkeen`);
    assert.equal(lines.at(-1), 'commit;', name);
    assert.equal(lines.length, executable[name.slice(0, 4)], `${name}: suoritettavien rivien määrä muuttui`);
    assert.equal(dryRunRollback(rb).trim().endsWith('rollback;'), true);
  }
});

test('0013:n ROLLBACK-osion ennakkokysely on yksi vain lukeva SELECT; muilla sitä ei ole', () => {
  for (const name of MIGRATIONS) {
    const pre = extractPreRollback(read(`supabase/migrations/${name}.sql`));
    if (name.startsWith('0013')) {
      assert.ok(pre, '0013: ennakkokysely puuttuu');
      assert.match(pre, /^select /);
      assert.equal(/\b(insert|update|delete|drop|alter|create)\b/i.test(pre), false);
      assert.match(pre, /menettaa_kohteen_kokonaan/);
      assert.equal(pre.trim().replace(/;$/, '').includes(';'), false, 'useampi lause');
    } else {
      assert.equal(pre, null, `${name}: odottamaton ennakkokysely`);
    }
  }
});

test('PostgREST-jäljitelmä: insert, upsert, update ja delete', () => {
  const ins = postgrestSql('goals', { id: 'g1', title: 'x', metric: undefined });
  assert.equal(ins.sql, 'insert into public."goals" ("id", "title") select "id", "title" from json_populate_recordset(null::public."goals", $1::json)');
  assert.deepEqual(JSON.parse(ins.params[0]), [{ id: 'g1', title: 'x' }], 'undefined-kenttä ei saa lähteä nullina');
  const up = postgrestSql('profile', { id: 'u', age: 3 }, { method: 'upsert', onConflict: 'id' });
  assert.match(up.sql, /on conflict \("id"\) do update set "id" = excluded\."id", "age" = excluded\."age"$/);
  const upd = postgrestSql('goals', { id: 'g1', title: 'y' }, { method: 'update', match: { user_id: 'u', id: 'g1' } });
  assert.match(upd.sql, /^update public\."goals" set "id" = pgrst_body\."id", "title" = pgrst_body\."title" from \(select \* from json_populate_record\(null::public\."goals", \$1::json\)\) pgrst_body where public\."goals"\."user_id" = \$2 and public\."goals"\."id" = \$3$/);
  assert.deepEqual(upd.params.slice(1), ['u', 'g1']);
  const del = postgrestSql('running_timers', null, { method: 'delete', match: { user_id: 'u', id: 't' } });
  assert.equal(del.sql, 'delete from public."running_timers" where public."running_timers"."user_id" = $1 and public."running_timers"."id" = $2');
  assert.throws(() => postgrestSql('goals; drop table x', { id: 1 }), /Kielletty tunniste/);
  assert.throws(() => postgrestSql('goals', { 'id"': 1 }), /Kielletty tunniste/);
  assert.throws(() => postgrestSql('goals', { id: 1 }, { method: 'update' }), /ilman suodatinta/);
  assert.deepEqual(wirePayload({ a: undefined, b: null, c: [1] }), { b: null, c: [1] });
});
