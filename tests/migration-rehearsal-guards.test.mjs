// Migraatiot 0009–0013: harjoittelun löydösten pysyvät vartijat.
//
// Jokainen alla oleva sääntö on todennettu oikealla PostgreSQL 17:llä
// (tools/pg-rehearsal, docs/activation/REHEARSAL-REPORT.md). Nämä testit
// estävät niiden hiljaisen palautumisen ilman kantaa:
//
//   F11  0010 lukitsee neljä elävää taulua kerralla ennen yhtäkään DDL:ää
//   BK-06 0010 ei väitä keskeytyneen ajon jättävän taulua ilman rajoitetta
//   F8   peruutusvartijat (0010 ylläpitotila, 0012 kun 0013 on ajettu),
//        käänteinen järjestys, 0013:n kohdistuksen menetys
//   F9   jokaisella ennen committia tarkistetulla politiikkamäärällä on
//        preflight-rivi (ei selittämätöntä myöhäistä NO-GO:ta)
//   F10  preflight tarkistaa lukot juuri niissä tauluissa, joita migraatio
//        muuttaa tai joihin se viittaa
//   F12  ei viittauksia vanhaan 16-lauseiseen inventaarioon; paketeilla on
//        blob-tiivisteet

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { ROOT, read } from './helpers/sources.mjs';
import { extractRollback } from '../tools/pg-rehearsal/lib.mjs';
import { LOCKED_TABLES } from '../tools/activation/build-preflights.mjs';
import { withTable, BUNDLES_DOC } from '../tools/pg-rehearsal/bundle-hashes.mjs';

const FILES = {
  '0009': '0009_finance_2.sql', '0010': '0010_goal_to_action.sql', '0011': '0011_personal_assistant.sql',
  '0012': '0012_life_alignment.sql', '0013': '0013_alignment_reality.sql'
};
const lf = s => s.replace(/\r\n/g, '\n');
const migration = n => lf(read(`supabase/migrations/${FILES[n]}`));
/** Suoritettava osa begin..commit ilman kommenttirivejä. */
const body = n => {
  const src = migration(n);
  return src.slice(src.indexOf('\nbegin;'), src.indexOf('\ncommit;'))
    .split('\n').filter(l => !l.trim().startsWith('--')).join('\n');
};

test('KRIITTINEN F11: 0010 lukitsee goals, projects, tasks, profile kerralla ennen yhtäkään DDL:ää', () => {
  const c = body('0010');
  const lock = 'lock table public.goals, public.projects, public.tasks, public.profile in access exclusive mode;';
  assert.equal(c.split(lock).length - 1, 1, 'lukituslause puuttuu tai toistuu');
  assert.equal((c.match(/^lock table /gm) || []).length, 1, 'useampi lukituslause — lukkiutumisen riski');
  const timeout = c.indexOf("set local lock_timeout = '5s';");
  const at = c.indexOf(lock);
  assert.ok(timeout !== -1 && timeout < at, 'lock_timeout on asetettava ennen lukitusta');
  assert.equal(c.slice(timeout, at).replace("set local lock_timeout = '5s';", '').trim(), '',
    'lukituksen on tultava heti lock_timeoutin jälkeen');
  for (const ddl of ['create table', 'alter table', 'create index', 'create policy', 'create trigger', 'drop ']) {
    const first = c.indexOf(ddl);
    if (first !== -1) assert.ok(at < first, `"${ddl}" ennen lukitusta`);
  }
});

test('BK-06: 0010 ei väitä keskeytyneen ajon jättävän taulua ilman tilarajoitetta', () => {
  const src = migration('0010');
  assert.equal(/jos migraatio keskeytyy tähän, rajoite on poissa/.test(src), false);
  assert.equal(/keskeytynyt ajo jättäisi taulun ilman tilarajoitetta/.test(src), false);
  assert.equal(/vaihe 4 tarkistaa/i.test(src), false, 'tarkistus on vaiheessa 5');
  assert.match(src, /keskeytynyt ajo perutaan KOKONAAN/);
  assert.match(src, /preflight_0010 rivi 09/);
  assert.match(src, /verify_0010 rivi 20/);
  // Viitatut rivit ovat oikeat rivit.
  assert.match(lf(read('supabase/preflight/preflight_0010.sql')), /select '09'::text as check_no, '0010'::text as section,\s+'goals_status_check on olemassa/);
  assert.match(lf(read('supabase/verify/verify_0010.sql')), /select '20', 'tilarajoite', 'goals_status_check on olemassa'/);
});

test('KRIITTINEN F8: peruutusvartijat ennen ensimmäistä pudotusta', () => {
  const rb10 = extractRollback(migration('0010'));
  const guard10 = rb10.indexOf("where status = 'maintenance'");
  assert.ok(guard10 !== -1, '0010: ylläpitotilan vartija puuttuu');
  assert.ok(guard10 < rb10.indexOf('drop '), '0010: vartija pudotusten jälkeen');
  assert.match(rb10, /raise exception 'Peruutus keskeytetty: % tavoitetta on tilassa maintenance/);
  const rb12 = extractRollback(migration('0012'));
  const guard12 = rb12.indexOf('time_entries_source_v2_check');
  assert.ok(guard12 !== -1, '0012: 0013-vartija puuttuu');
  assert.ok(guard12 < rb12.indexOf('drop '), '0012: vartija pudotusten jälkeen');
  assert.match(rb12, /confrelid = to_regclass\('public\.life_areas'\)/);
  assert.match(rb12, /raise exception 'Peruutus keskeytetty: migraatio 0013 on yha ajettu/);
  for (const n of ['0010', '0012', '0013']) {
    assert.match(migration(n), /PERUUTUS AINA KÄÄNTEISESSÄ JÄRJESTYKSESSÄ/, `${n}: järjestysohje puuttuu`);
  }
  const src13 = migration('0013');
  assert.match(src13, /KOHDISTUS KATOAA OSITTAIN/);
  assert.match(src13, /Kirjattu aika säilyy/);
});

test('KRIITTINEN F9: jokaisella politiikkamäärän invariantilla on preflight-rivi', () => {
  let found = 0;
  for (const n of ['0011', '0012', '0013']) {
    const c = body(n);
    const created = new Set([...c.matchAll(/create table public\.(\w+)/g)].map(m => m[1]));
    const preflight = lf(read(`supabase/preflight/preflight_${n}.sql`));
    for (const m of c.matchAll(/select count\(\*\) into n from pg_policies\s+where schemaname = 'public'\s+and tablename in \(([^)]*)\);\s+if n <> (\d+) then/g)) {
      const tables = [...m[1].matchAll(/'(\w+)'/g)].map(t => t[1]);
      if (tables.some(t => created.has(t))) continue; // migraation omat taulut: ei ennen ajoa
      found++;
      const list = tables.map(t => `'${t}'`).join(', ');
      const row = new RegExp(`'${m[2]}'::text as odotus,\\s+\\(select count\\(\\*\\)::text from pg_policies where schemaname = 'public' and tablename in \\(${list.replace(/[()]/g, '\\$&')}\\)\\)`);
      assert.match(preflight, row, `preflight_${n}: politiikkarivi puuttuu (${list} = ${m[2]})`);
    }
  }
  assert.equal(found, 3, 'odotettiin kolme vanhojen taulujen politiikkainvarianttia (0011, 0012, 0013)');
});

test('KRIITTINEN F10: preflight tarkistaa lukot jokaisessa taulussa, jota migraatio muuttaa tai johon se viittaa', () => {
  for (const n of Object.keys(FILES)) {
    const c = body(n);
    const created = new Set([...c.matchAll(/create table public\.(\w+)/g)].map(m => m[1]));
    const touched = new Set();
    for (const m of c.matchAll(/(?:alter table|references|lock table) (public\.\w+|auth\.users)/g)) touched.add(m[1]);
    const needed = [...touched].filter(t => !created.has(t.replace('public.', '')) || t === 'auth.users');
    for (const t of needed) {
      assert.ok(LOCKED_TABLES[n].includes(t), `${n}: ${t} puuttuu LOCKED_TABLES-listasta`);
    }
    const preflight = lf(read(`supabase/preflight/preflight_${n}.sql`));
    assert.match(preflight, /Muut istunnot eivät lukitse tauluja/, `preflight_${n}: lukitut taulut -rivi puuttuu`);
    for (const t of LOCKED_TABLES[n]) assert.ok(preflight.includes(`to_regclass('${t}')`), `preflight_${n}: ${t}`);
    // Odottavat lukot rajataan tähän kantaan.
    assert.match(preflight, /a\.datname = current_database\(\)\)\) as toteutui/);
  }
});

test('F12: ei viittauksia vanhaan 16-lauseiseen inventaarioon ajettavana askeleena', () => {
  const files = [
    ...Object.values(FILES).map(f => `supabase/migrations/${f}`),
    ...fs.readdirSync(path.join(ROOT, 'docs/activation')).filter(f => f.endsWith('.md')).map(f => `docs/activation/${f}`),
    'tools/pg-rehearsal/README.md'
  ];
  for (const f of files) assert.equal(read(f).includes('life_alignment_readonly_inventory.sql'), false, f);
});

test('KRIITTINEN F12: MIGRATION-BUNDLES.md:n blob-taulukko vastaa tiedostoja', () => {
  const doc = read(BUNDLES_DOC);
  assert.equal(lf(doc), withTable(doc), 'aja: node tools/pg-rehearsal/bundle-hashes.mjs --write');
  assert.match(doc, /[Pp]eruutus aina käänteisessä järjestyksessä/);
  assert.match(doc, /docs\/activation\/0010-BACKUP-AND-RECOVERY\.md/);
  assert.match(doc, /menettää kohdistuksensa|kohdistus katoaa/i);
});
