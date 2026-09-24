// Uudelleenajon tunnistus 0009–0013: "JO AJETTU" -luvun on vastattava
// sitä, mitä migraatio oikeasti luo.
//
// MIKSI TÄMÄ ON OLEMASSA
//
// Jokainen migraatio laskee esitarkistuksessa omat objektinsa:
//   0            = tuore ajo
//   täysi luku   = JO AJETTU, "älä aja uudelleen, aja verify"
//   muu          = KESKEN, "palautuspolku"
//
// Oikealla PostgreSQL 17:llä (tools/pg-rehearsal) todettiin, että 0010:n
// luku oli 41 vaikka tunnistuslista löytää 38 objektia, ja 0011:n luku
// 63 vaikka lista löytää 72. Täysin ajetun migraation uudelleenajo
// ilmoitti siksi "kesken" — ja ohjasi hyväksyjän palautuspolulle ehjän
// kannan kohdalla. Migraatio kaatui kiinni (ei vahinkoa), mutta viesti
// oli väärä juuri sillä hetkellä, kun hyväksyjä on epävarma.
//
// Tämä testi laskee luodut objektit lähteestä samalla tavalla kuin
// tests/migrations.test.mjs tekee 0004–0008:lle. Korvattu rajoite
// (drop + add SAMALLA nimellä) ei kuulu lukuun: se on olemassa jo ennen
// migraatiota.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const DIR = new URL('../supabase/migrations/', import.meta.url);

function code(file) {
  return readFileSync(new URL(file, DIR), 'utf8')
    .replace(/\r\n/g, '\n')
    .split('\ncommit;')[0]
    .split('\n').filter(line => !line.trim().startsWith('--')).join('\n');
}

function createdObjects(src) {
  const count = re => [...src.matchAll(re)].length;
  const added = new Set([...src.matchAll(/add constraint (\w+)/g)].map(m => m[1]));
  const replaced = [...src.matchAll(/drop constraint (\w+)/g)].map(m => m[1]).filter(n => added.has(n));
  return count(/create table public\.\w+/g)
    + count(/add column \w+/g)
    + count(/add constraint \w+/g)
    + count(/^\s+constraint \w+/gm)
    + count(/create (?:unique )?index \w+/g)
    + count(/create trigger \w+/g)
    + count(/create policy \w+/g)
    - replaced.length;
}

const FILES = readdirSync(DIR).filter(n => /^00(09|1\d)_.*\.sql$/.test(n)).sort();

// Aaltokandidaateissa (F, G, H, I) myöhempiä migraatioita ei vielä ole:
// testi kattaa ne, jotka tässä puussa ovat, ilman aukkoja.
test('uudelleenajon tunnistus kattaa jokaisen migraation 0009:stä alkaen', () => {
  assert.ok(FILES.length >= 1, 'migraatiota 0009 ei löytynyt');
  FILES.forEach((f, i) => assert.equal(Number(f.slice(0, 4)), 9 + i, `aukko numeroinnissa: ${f}`));
});

for (const file of FILES) {
  test(`${file.slice(0, 4)}: "JO AJETTU" -luku = luotujen objektien määrä`, () => {
    const src = code(file);
    const constant = src.match(/if olemassa = (\d+) then/);
    assert.ok(constant, 'uudelleenajon tunnistusta ei löytynyt');
    assert.equal(Number(constant[1]), createdObjects(src),
      'täysin ajetun migraation uudelleenajo ilmoittaisi "kesken" eikä "JO AJETTU"');
  });

  test(`${file.slice(0, 4)}: virheilmoitus ja ilmoitus käyttävät samaa lukua`, () => {
    const src = code(file);
    const n = src.match(/if olemassa = (\d+) then/)[1];
    for (const m of src.matchAll(/objekti\w* (\d+):sta|objekteja 0\/(\d+)/g)) {
      assert.equal(m[1] || m[2], n, `ristiriitainen luku: ${m[0]}`);
    }
  });
}

const has = n => FILES.some(f => f.startsWith(n));

(has('0012') && has('0013') ? test : test.skip)('0012: uudelleenajo 0013:n jälkeen ei väitä 0012:ta keskeneräiseksi', () => {
  // 0013 poistaa 0012:n rajoitteen time_entries_source_check, joten
  // luku on silloin 57. Sen on johdettava "JO AJETTU" -viestiin.
  const src = code('0012_life_alignment.sql');
  // Tunnistus nojaa 0013:n korvaavaan rajoitteeseen eikä 0013:n tauluun:
  // 0012 ei saa mainita 0013:n tauluja (life-alignment-reality-migration).
  assert.match(src, /if olemassa = 57\s+and exists \(select 1 from pg_constraint where conname = 'time_entries_source_v2_check'\) then/);
  const src13 = code('0013_alignment_reality.sql');
  assert.match(src13, /drop constraint time_entries_source_check/);
  assert.match(src13, /add constraint time_entries_source_v2_check/);
});
