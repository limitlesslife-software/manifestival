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
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

import { ROOT, read } from './helpers/sources.mjs';
import {
  diffCatalog, compareDigests, digestsIdentical, extractRollback, extractPreRollback, dryRunRollback,
  rehearsalServerProblem, projectRoot, normalizeDir, postgrestSql, wirePayload, formatSchemaDiff, PG_PORT
} from '../tools/pg-rehearsal/lib.mjs';

const MIGRATIONS = ['0009_finance_2', '0010_goal_to_action', '0011_personal_assistant',
  '0012_life_alignment', '0013_alignment_reality', '0014_daily_life', '0015_mental_load'];

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
  // 0014: begin, lock_timeout, kymmenen taulun pudotus lapsista vanhempiin, commit.
  // 0015: begin, lock_timeout, lukitus, kategorian vartija (7), kaksi pudotusta,
  // tasks (10), life_areas (5 riviä, uniikkiuden palautus kahdella rivillä), commit.
  const executable = { '0009': 11, '0010': 39, '0011': 8, '0012': 19, '0013': 19, '0014': 13, '0015': 28 };
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

test('KRIITTINEN: 0014:n peruutus pudottaa täsmälleen omat taulunsa, lapset ennen vanhempia, ilman cascadea', () => {
  const src = read('supabase/migrations/0014_daily_life.sql');
  const rb = extractRollback(src);
  const drops = [...rb.matchAll(/^drop table public\.(\w+);$/gm)].map(m => m[1]);
  const created = [...src.replace(/\r\n/g, '\n').matchAll(/^create table public\.(\w+) \(/gm)].map(m => m[1]);
  assert.equal(created.length, 10);
  assert.deepEqual([...drops].sort(), [...created].sort(), 'peruutus ei pudota täsmälleen 0014:n tauluja');
  const at = t => drops.indexOf(t);
  for (const [child, parent] of [['place_aliases', 'saved_places'], ['commute_observations', 'saved_places'],
    ['calendar_events', 'saved_places'], ['habit_events', 'habit_plans']]) {
    assert.ok(at(child) < at(parent), `${child} pudotetaan vasta ${parent}:n jälkeen`);
  }
  // Ilman cascadea vieras riippuvuus (esim. Dashboardista luotu näkymä)
  // kaataa peruutuksen kiinni eikä poista hiljaa muuta.
  assert.equal(/\bcascade\b/i.test(rb), false);
  // Ei ALTERia olemassa olevaan tauluun: 0014 ei muuttanut yhtäkään.
  assert.equal(/\balter\b/i.test(rb), false);
});

test('KRIITTINEN: 0014 lukitsee goals-taulun uudelleenajon tunnistuksen jälkeen ja ennen ensimmäistä DDL:ää', () => {
  // Harjoittelun löydös 2026-09-27: ilman tätä 0014 loi kaksi taulua ja
  // piti auth.users-lukkoa odottaessaan goals-lukkoa — kirjautuminen jumissa
  // 4 981 ms (failure:0010-locks, authStall0014).
  const src = read('supabase/migrations/0014_daily_life.sql').replace(/\r\n/g, '\n');
  const body = src.slice(src.indexOf('\nbegin;'), src.indexOf('\ncommit;'))
    .split('\n').filter(l => !l.trim().startsWith('--')).join('\n');
  const lock = 'lock table public.goals in share row exclusive mode;';
  assert.equal(body.split(lock).length - 1, 1, 'goals-lukitus puuttuu tai toistuu');
  assert.equal((body.match(/^lock table /gm) || []).length, 1, 'useampi lukituslause');
  const at = body.indexOf(lock);
  assert.ok(body.indexOf("set local lock_timeout = '5s';") < at, 'lock_timeout ennen lukitusta');
  assert.ok(body.indexOf('JO AJETTU') < at, 'uudelleenajon tunnistus ennen lukitusta ("JO AJETTU" heti)');
  assert.ok(body.indexOf('touch_updated_at() on SECURITY DEFINER') < at);
  for (const ddl of ['create table', 'alter table', 'create index', 'create policy', 'create trigger', 'revoke ', 'grant ']) {
    const first = body.indexOf(ddl);
    if (first !== -1) assert.ok(at < first, `"${ddl}" ennen goals-lukitusta`);
  }
  // auth.usersia ei lukita erikseen: LOCK TABLE vaatisi Supabasessa oikeuden,
  // jota postgres-roolilla ei välttämättä ole auth-skeeman tauluun.
  assert.equal(/lock table auth\./.test(body), false);
});

test('harjoittelun ketju = supabase/migrations (0001–0015)', async () => {
  const { MIGRATIONS: CHAIN } = await import('../tools/pg-rehearsal/chain.mjs');
  const files = fs.readdirSync(path.join(ROOT, 'supabase/migrations'))
    .filter(f => /^\d{4}_\w+\.sql$/.test(f)).map(f => f.replace(/\.sql$/, '')).sort();
  assert.deepEqual([...CHAIN], files);
  assert.equal(CHAIN.at(-1), '0015_mental_load');
});

test('KRIITTINEN: 0015:n peruutus: omat taulut, omat sarakkeet, kategorian vartija ennen uniikkiutta, ei NOT NULLia päivälle', () => {
  const src = read('supabase/migrations/0015_mental_load.sql').replace(/\r\n/g, '\n');
  const rb = extractRollback(src);
  const drops = [...rb.matchAll(/^drop table public\.(\w+);$/gm)].map(m => m[1]);
  const created = [...src.matchAll(/^create table public\.(\w+) \(/gm)].map(m => m[1]);
  assert.deepEqual([...drops].sort(), [...created].sort(), 'peruutus ei pudota täsmälleen 0015:n tauluja');
  const added = [...src.matchAll(/^alter table public\.(tasks|life_areas) add column (\w+)/gm)].map(m => `${m[1]}.${m[2]}`);
  const dropped = [...rb.matchAll(/^alter table public\.(tasks|life_areas) drop column (\w+);$/gm)].map(m => `${m[1]}.${m[2]}`);
  assert.deepEqual([...dropped].sort(), [...added].sort(), 'peruutus ei pudota täsmälleen 0015:n sarakkeita');
  assert.equal(/\bcascade\b/i.test(rb), false);
  // Vartija ennen uniikkiuden palautusta: jaettu kategoria kaataa peruutuksen kiinni.
  const guard = rb.indexOf('having count(*) > 1');
  const restore = rb.indexOf('add constraint life_areas_category_unique unique (user_id, category_key)');
  assert.ok(guard > 0 && restore > guard, 'vartija puuttuu tai on palautuksen jälkeen');
  assert.ok(rb.indexOf('lock table public.tasks, public.life_areas in access exclusive mode;') < guard);
  // tasks.date-sarakkeen NOT NULL -ehtoa ei palauteta (recovery §4).
  assert.equal(/set not null/i.test(rb), false);
});

test('KRIITTINEN: 0015 lukitsee tasks- ja life_areas-taulut tunnistuksen jälkeen ja ennen ensimmäistä DDL:ää', () => {
  const src = read('supabase/migrations/0015_mental_load.sql').replace(/\r\n/g, '\n');
  const body = src.slice(src.indexOf('\nbegin;'), src.indexOf('\ncommit;'))
    .split('\n').filter(l => !l.trim().startsWith('--')).join('\n');
  const lock = 'lock table public.tasks, public.life_areas in access exclusive mode;';
  assert.equal(body.split(lock).length - 1, 1, 'lukitus puuttuu tai toistuu');
  assert.equal((body.match(/^lock table /gm) || []).length, 1, 'useampi lukituslause');
  const at = body.indexOf(lock);
  assert.ok(body.indexOf("set local lock_timeout = '5s';") < at, 'lock_timeout ennen lukitusta');
  assert.ok(body.indexOf('JO AJETTU') < at, 'uudelleenajon tunnistus ennen lukitusta ("JO AJETTU" heti)');
  assert.ok(body.indexOf('touch_updated_at() on SECURITY DEFINER') < at);
  for (const ddl of ['create table', 'alter table', 'create index', 'create policy', 'create trigger', 'revoke ', 'grant ']) {
    const first = body.indexOf(ddl);
    if (first !== -1) assert.ok(at < first, `"${ddl}" ennen lukitusta`);
  }
  // Omistajan rivi (auth.users) luetaan vasta lukituksen jälkeen, eikä
  // auth.usersia lukita erikseen (Supabasen postgres-rooli).
  assert.ok(body.indexOf('from auth.users where id = omistaja') > at);
  assert.equal(/lock table auth\./.test(body), false);
  // Uudet taulut (auth.users-vierasavain) vasta ALTERien jälkeen.
  assert.ok(body.indexOf('alter table public.tasks add column') < body.indexOf('create table public.protected_periods'));
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
