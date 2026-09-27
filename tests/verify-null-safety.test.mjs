// verify_0009–0013 ja preflight_0009–0013: NULL-tulos on poikkeama.
//
// Operaattorin pysäytysluku on `poikkeavia_yhteensa`. Aiemmin
// verify-tiedostot laskivat sen ehdolla `toteutui <> odotus`, joka on NULL
// kun tarkistettava objekti puuttuu: rivi näkyi FAIL-tilassa mutta EI
// luvussa, ja details oli tyhjä. Oikealla PostgreSQL 17:llä toistettu
// (tools/pg-rehearsal verify:null: 2 vs. 3 FAIL-riviä) ja korjattu.
//
// Lisäksi (tilin elinkaari F10): verify_0013 todistaa, että jokainen
// vierasavain auth.usersiin on CASCADE — muuten tilin poisto jäisi kiinni.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { read } from './helpers/sources.mjs';
import { MIGRATION_TABLES, ACCOUNT_TABLES_THROUGH_0014 } from '../tools/activation/build-preflights.mjs';
import { ACCOUNT_DATA_MAP } from '../src/domain/accountLifecycle.js';
import { waveById } from '../tools/release/waves.mjs';

const NUMBERS = ['0009', '0010', '0011', '0012', '0013', '0014'];
const FILES = [
  ...NUMBERS.map(n => `supabase/verify/verify_${n}.sql`),
  ...NUMBERS.map(n => `supabase/preflight/preflight_${n}.sql`)
];

/** Koodi ilman kommenttirivejä. */
const code = file => read(file).replace(/\r\n/g, '\n').split('\n').filter(l => !l.trim().startsWith('--')).join('\n');

test('KRIITTINEN: poikkeavia_yhteensa laskee myös NULL-tuloksen (is distinct from)', () => {
  for (const file of FILES) {
    const c = code(file);
    const filter = /count\(\*\) filter \(where ([^)]*)\)\s*over \(\) as poikkeavia_yhteensa/.exec(c);
    assert.ok(filter, `${file}: poikkeavia_yhteensa-laskentaa ei löytynyt`);
    assert.match(filter[1], /c\.toteutui is distinct from c\.odotus/, `${file}: NULL jää laskematta`);
    assert.equal(/toteutui\s*<>\s*c\.odotus/.test(c), false, `${file}: NULL-herkkä vertailu`);
  }
});

test('KRIITTINEN: details kertoo "toteutui null" eikä ole tyhjä', () => {
  for (const file of FILES) {
    const c = code(file);
    assert.match(c, /', toteutui ' \|\| coalesce\(c\.toteutui, 'null'\)/, `${file}: details ilman coalescea`);
  }
});

test('KRIITTINEN: verify_0013 todistaa, että tilin poisto vie ajastimet ja asetukset (CASCADE)', () => {
  const c = code('supabase/verify/verify_0013.sql');
  const row = no => {
    const m = new RegExp(`select '${no}'[\\s\\S]*?(?=\\n\\s*union all|\\n\\) c)`).exec(c);
    assert.ok(m, `tarkistus ${no} puuttuu`);
    return m[0];
  };
  const r25 = row('25');
  assert.match(r25, /'2',/);
  assert.match(r25, /confdeltype = 'c'/);
  assert.match(r25, /confrelid = 'auth\.users'::regclass/);
  assert.match(r25, /running_timers/);
  assert.match(r25, /alignment_item_settings/);
  const r26 = row('26');
  assert.match(r26, /'0',/);
  assert.match(r26, /confrelid = 'auth\.users'::regclass/);
  assert.match(r26, /confdeltype <> 'c'/);
  assert.match(r26, /connamespace = 'public'::regnamespace/);
  const r27 = row('27');
  assert.match(r27, /'0',/);
  assert.match(r27, /not exists/);
  // Muut public-taulut: tieto (INFO), ei poikkeama.
  assert.match(row('28'), /'INFO',/);
});

test('KRIITTINEN: verify_0013 rivit 26–28 rajaavat tilin poiston tarkistukset migraatioiden tauluihin', () => {
  // Koko kannan tarkistus kaatuisi tauluun, jota mikään migraatio ei
  // luonut (esim. Dashboardista) — vasta 0013:n jälkeen. Lista = tilin
  // poiston kartta, ja sama lista on preflight_0009:ssä.
  const c = code('supabase/verify/verify_0013.sql');
  const expected = [...MIGRATION_TABLES].sort();
  assert.equal(expected.length, 26);
  // Lista on jäädytetty 0013:n aikaiseksi: kartta ilman aallon K (0014)
  // tauluja. Muuten jo lukittu verify_0013/preflight_0009 muuttuisi.
  const kTables = new Set(waveById('K').tables);
  assert.deepEqual(expected, Object.values(ACCOUNT_DATA_MAP).map(e => e.table).filter(t => !kTables.has(t)).sort());
  for (const no of ['26', '27', '28']) {
    const m = new RegExp(`select '${no}'[\\s\\S]*?(?=\\n\\s*union all|\\n\\) c)`).exec(c);
    assert.ok(m, `tarkistus ${no} puuttuu`);
    const list = /(?:relname (?:not )?in \(|array\[)((?:\s*'\w+',?)+)\s*[)\]]/.exec(m[0]);
    assert.ok(list, `tarkistus ${no}: taululista puuttuu`);
    const tables = [...list[1].matchAll(/'(\w+)'/g)].map(x => x[1]).sort();
    assert.deepEqual(tables, expected, `tarkistus ${no}: lista ≠ migraatioiden taulut`);
  }
  assert.match(c, /select '28', 'omistajuus', [^\n]*'INFO',/);
  assert.match(c, /c\.relname not in \(/);
});

test('KRIITTINEN: verify_0014 rivit 34–36 kattavat koko tilin poiston kartan (36 taulua)', () => {
  const c = code('supabase/verify/verify_0014.sql');
  const expected = [...ACCOUNT_TABLES_THROUGH_0014].sort();
  assert.equal(expected.length, 36);
  assert.deepEqual(expected, Object.values(ACCOUNT_DATA_MAP).map(e => e.table).sort());
  for (const no of ['34', '35', '36']) {
    const m = new RegExp(`select '${no}'[\\s\\S]*?(?=\\n\\s*union all|\\n\\) c)`).exec(c);
    assert.ok(m, `tarkistus ${no} puuttuu`);
    const list = /(?:relname (?:not )?in \(|array\[)((?:\s*'\w+',?)+)\s*[)\]]/.exec(m[0]);
    assert.ok(list, `tarkistus ${no}: taululista puuttuu`);
    const tables = [...list[1].matchAll(/'(\w+)'/g)].map(x => x[1]).sort();
    assert.deepEqual(tables, expected, `tarkistus ${no}: lista ≠ kartan taulut`);
  }
});

test('KRIITTINEN: preflight_0009 tarkistaa tilin poiston oletukset jo ennen junaa', () => {
  const c = code('supabase/preflight/preflight_0009.sql');
  const row = name => {
    const m = new RegExp(`select '(\\d{2})'::text as check_no, 'junan alku'::text as section,\\s+'${name}[^']*'::text as check_name, '(\\w+)'::text as odotus,([\\s\\S]*?)(?=\\n\\s*union all|\\n\\) c)`).exec(c);
    assert.ok(m, `preflight_0009: rivi "${name}" puuttuu`);
    return { no: m[1], odotus: m[2], sql: m[3] };
  };
  const other = row('Muut public-taulut');
  assert.equal(other.odotus, 'INFO');
  for (const t of MIGRATION_TABLES) assert.match(other.sql, new RegExp(`'${t}'`), t);
  const cascade = row('Jokainen public-taulun vierasavain auth.usersiin on CASCADE');
  assert.equal(cascade.odotus, '0');
  assert.match(cascade.sql, /f\.confdeltype <> 'c'/);
  assert.match(cascade.sql, /f\.connamespace = 'public'::regnamespace/);
  // Vain junan alussa: muut esitarkistukset eivät toista rivejä.
  for (const n of ['0010', '0011', '0012', '0013', '0014']) {
    assert.equal(/'junan alku'/.test(read(`supabase/preflight/preflight_${n}.sql`)), false, n);
  }
});
