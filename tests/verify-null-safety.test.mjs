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

const NUMBERS = ['0009', '0010', '0011', '0012', '0013'];
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
});
