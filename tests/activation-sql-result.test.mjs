// Omistajan liittämä esitarkistus- tai varmistustulos (ACT-12).
//
// Kaksi aineistoa:
//
//   1. Synteettiset taulukot (alla rows()), jotka rakennetaan OIKEAN
//      SQL-tiedoston tarkistusmäärästä: muodot (sarkain, CSV, putki),
//      vajaa liitos, kahdesti liitetty rivi.
//   2. OIKEAN KANNAN tulokset tests/fixtures/sql-results/: jokainen
//      preflight_0009…0013 ja verify_0009…0013 ajettuna paikallisessa
//      PostgreSQL 17:ssä tuotannon muotoisella synteettisellä datalla
//      (node tools/pg-rehearsal/sql-result-fixtures.mjs): PASS-tila ja
//      yksi FAIL-tila kustakin. Ei käyttäjän sisältöä.
//
// Oikea aineisto paljasti: verify_0013:n numeroinnissa on aukkoja
// (01–08, 10–15, 20–28, …), ja pisteytys oletti 01..N — puhdas tulos
// olisi ollut STOP. Nyt decide() vertaa SQL-tiedoston omiin numeroihin.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { ROOT, read } from './helpers/sources.mjs';
import { checkNumbersInSql, countChecksInSql, decide, parseCheckTable } from '../tools/activation/score-sql-result.mjs';

const HEADER = ['check_no', 'section', 'check_name', 'status', 'details', 'poikkeavia_yhteensa'];

/** Tulosrivit: n tarkistusta, joista `fail` ensimmäistä FAIL ja viimeinen INFO. */
function rows(n, { fail = 0, poikkeavia = fail } = {}) {
  return Array.from({ length: n }, (_, i) => {
    const no = String(i + 1).padStart(2, '0');
    const status = i < fail ? 'FAIL' : (i === n - 1 ? 'INFO' : 'PASS');
    return [no, 'osio', `Tarkistus ${no}, "lainaus" mukana`, status,
      status === 'INFO' ? '36' : `odotus 1, toteutui ${status === 'FAIL' ? '0' : '1'}`, String(poikkeavia)];
  });
}
const tsv = (data, header = true) => [...(header ? [HEADER] : []), ...data].map(r => r.join('\t')).join('\n');
const csv = data => [HEADER, ...data].map(r => r.map(c => (/[",]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\r\n');
const pipe = data => [
  ` ${HEADER.join(' | ')} `,
  HEADER.map(h => '-'.repeat(h.length + 2)).join('+'),
  ...data.map(r => ` ${r.join(' | ')} `),
  `(${data.length} rows)`
].join('\n');

const PREFLIGHT_0009 = countChecksInSql(read('supabase/preflight/preflight_0009.sql'));
const VERIFY_0011 = countChecksInSql(read('supabase/verify/verify_0011.sql'));

test('tarkistusmäärä luetaan generoidusta SQL:stä', () => {
  // 16 + rivi "muiden istuntojen lukot migraation tauluissa" (loppuharjoitus F10)
  // + junan alun kaksi riviä (muut public-taulut, CASCADE auth.usersiin).
  assert.equal(PREFLIGHT_0009, 19);
  assert.ok(VERIFY_0011 > 20, `verify_0011: ${VERIFY_0011}`);
  for (const n of ['0009', '0010', '0011', '0012', '0013']) {
    assert.ok(countChecksInSql(read(`supabase/preflight/preflight_${n}.sql`)) >= 10, n);
    assert.ok(countChecksInSql(read(`supabase/verify/verify_${n}.sql`)) >= 10, n);
  }
});

test('KRIITTINEN: puhdas esitarkistus kelpaa sarkain-, CSV- ja putkimuodossa', () => {
  for (const [name, text] of [['tsv', tsv(rows(PREFLIGHT_0009))], ['csv', csv(rows(PREFLIGHT_0009))], ['pipe', pipe(rows(PREFLIGHT_0009))]]) {
    const parsed = parseCheckTable(text);
    assert.ok(parsed, name);
    assert.equal(parsed.rows.length, PREFLIGHT_0009, name);
    assert.equal(parsed.fail, 0, name);
    assert.equal(parsed.info, 1, name);
    assert.equal(parsed.poikkeavia, 0, name);
    assert.deepEqual(decide(parsed, { expectedChecks: PREFLIGHT_0009 }), { decision: 'GO', reasons: [] }, name);
  }
});

test('otsikoton sarkainliitos kelpaa (sarakejärjestys oletetaan)', () => {
  const parsed = parseCheckTable(tsv(rows(PREFLIGHT_0009), false));
  assert.equal(decide(parsed, { expectedChecks: PREFLIGHT_0009 }).decision, 'GO');
});

test('KRIITTINEN: yksikin FAIL -> STOP ja nimetään', () => {
  const parsed = parseCheckTable(tsv(rows(PREFLIGHT_0009, { fail: 1 })));
  const verdict = decide(parsed, { expectedChecks: PREFLIGHT_0009 });
  assert.equal(verdict.decision, 'STOP');
  assert.match(verdict.reasons.join(' '), /1 FAIL: 01 Tarkistus 01/);
});

test('KRIITTINEN: varmistuksen poikkeavia_yhteensa = 1 -> STOP', () => {
  const data = rows(VERIFY_0011).map(r => [...r.slice(0, 5), '1']);
  const verdict = decide(parseCheckTable(csv(data)), { expectedChecks: VERIFY_0011 });
  assert.equal(verdict.decision, 'STOP');
  assert.match(verdict.reasons.join(' '), /poikkeavia_yhteensa = 1/);
});

test('KRIITTINEN: vajaa liitos (viimeiset rivit puuttuvat) -> STOP', () => {
  const verdict = decide(parseCheckTable(tsv(rows(VERIFY_0011).slice(0, -3))), { expectedChecks: VERIFY_0011 });
  assert.equal(verdict.decision, 'STOP');
  assert.match(verdict.reasons.join(' '), /liitos on vajaa tai väärästä tiedostosta/);
});

test('aukko numeroinnissa tai kahdesti liitetty rivi -> STOP', () => {
  const data = rows(PREFLIGHT_0009);
  const gap = parseCheckTable(tsv(data.filter((_, i) => i !== 4)));
  assert.equal(decide(gap).decision, 'STOP');
  assert.match(decide(gap).reasons.join(' '), /katkeaa kohdassa 05/);
  // SQL-tiedoston omat numerot: sama aukko on puuttuva tarkistus 05.
  const numbers = data.map(r => r[0]);
  const withSql = decide(gap, { expectedChecks: numbers.length, expectedNumbers: numbers });
  assert.equal(withSql.decision, 'STOP');
  assert.match(withSql.reasons.join(' '), /tarkistukset 05 puuttuvat liitoksesta/);
  const dup = parseCheckTable(tsv([...data, data[2]]));
  assert.match(dup.problems.join(' '), /kahdesti/);
});

test('väärän tiedoston tulos (eri tarkistusmäärä) -> STOP', () => {
  const verdict = decide(parseCheckTable(tsv(rows(PREFLIGHT_0009))), { expectedChecks: VERIFY_0011 });
  assert.equal(verdict.decision, 'STOP');
});

test('tuntematon tila tai lukukelvoton syöte ei tuota GO:ta', () => {
  const weird = rows(3).map((r, i) => (i === 1 ? [r[0], r[1], r[2], 'OK?', r[4], r[5]] : r));
  const parsed = parseCheckTable(tsv(weird));
  assert.equal(decide(parsed).decision, 'STOP');
  assert.equal(parseCheckTable('hei'), null);
  assert.equal(parseCheckTable(''), null);
  assert.equal(decide(null).decision, 'STOP');
});

test('poikkeavia_yhteensa puuttuu -> STOP (ei oleteta nollaksi)', () => {
  const data = rows(PREFLIGHT_0009).map(r => r.slice(0, 5));
  const parsed = parseCheckTable([HEADER.slice(0, 5), ...data].map(r => r.join('\t')).join('\n'));
  assert.equal(decide(parsed, { expectedChecks: PREFLIGHT_0009 }).decision, 'STOP');
});

// =====================================================================
// OIKEAN KANNAN TULOKSET (tests/fixtures/sql-results)
// =====================================================================

const REAL_DIR = path.join(ROOT, 'tests/fixtures/sql-results');
const NUMBERS = ['0009', '0010', '0011', '0012', '0013'];
const REAL = NUMBERS.flatMap(n => ['preflight', 'verify'].flatMap(kind => ['pass', 'fail'].map(outcome => ({
  n, kind, outcome, name: `${kind}_${n}-${outcome}.tsv`, sql: `supabase/${kind}/${kind}_${n}.sql`
}))));
const realText = name => fs.readFileSync(path.join(REAL_DIR, name), 'utf8');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(REAL_DIR, 'manifest.json'), 'utf8'));

test('oikean kannan tuloksia on 20: preflight ja verify 0009–0013, PASS ja FAIL', () => {
  assert.equal(REAL.length, 20);
  for (const f of REAL) assert.ok(fs.existsSync(path.join(REAL_DIR, f.name)), `${f.name} puuttuu`);
  assert.deepEqual(Object.keys(MANIFEST.files).sort(), REAL.map(f => f.name).sort());
  assert.match(MANIFEST.server.version, /^PostgreSQL 17\./);
  assert.match(MANIFEST.data, /synteettinen/);
});

test('KRIITTINEN: countChecksInSql ja tarkistusnumerot vastaavat jokaista oikean kannan tulosta', () => {
  for (const f of REAL) {
    const sql = read(f.sql);
    const parsed = parseCheckTable(realText(f.name));
    assert.ok(parsed, f.name);
    assert.deepEqual(parsed.problems, [], f.name);
    assert.equal(countChecksInSql(sql), parsed.rows.length, `${f.name}: countChecksInSql(${f.sql})`);
    assert.deepEqual(parsed.rows.map(r => r.no), checkNumbersInSql(sql), `${f.name}: numerot ≠ ${f.sql}`);
    assert.equal(MANIFEST.files[f.name].sql, f.sql, f.name);
  }
});

test('KRIITTINEN: oikean kannan PASS- ja 0-tulokset -> GO, FAIL-tulokset -> STOP', () => {
  for (const f of REAL) {
    const sql = read(f.sql);
    const expectedNumbers = checkNumbersInSql(sql);
    const parsed = parseCheckTable(realText(f.name));
    const verdict = decide(parsed, { expectedChecks: countChecksInSql(sql), expectedNumbers });
    if (f.outcome === 'pass') {
      assert.deepEqual(verdict, { decision: 'GO', reasons: [] }, f.name);
      assert.equal(parsed.fail, 0, f.name);
      assert.equal(parsed.poikkeavia, 0, f.name);
    } else {
      assert.equal(verdict.decision, 'STOP', f.name);
      assert.ok(parsed.fail > 0, `${f.name}: ei FAIL-riviä`);
      assert.equal(parsed.poikkeavia, parsed.fail, `${f.name}: poikkeavia_yhteensa ≠ FAIL-rivit`);
      assert.match(verdict.reasons.join(' '), new RegExp(`${parsed.fail} FAIL:`), f.name);
    }
    assert.equal(MANIFEST.files[f.name].decision, verdict.decision, `${f.name}: manifest`);
  }
});

test('KRIITTINEN: verify_0013:n tarkoitukselliset aukot eivät pysäytä, kun SQL-tiedoston numerot annetaan', () => {
  const sql = read('supabase/verify/verify_0013.sql');
  const numbers = checkNumbersInSql(sql);
  assert.ok(numbers.includes('08') && !numbers.includes('09') && numbers.includes('10'), 'verify_0013:ssa ei ole aukkoa 09');
  const parsed = parseCheckTable(realText('verify_0013-pass.tsv'));
  // Ilman SQL:n numeroita oletus 01..N näkee aukon (tämä oli vika).
  assert.match(decide(parsed, { expectedChecks: numbers.length }).reasons.join(' '), /katkeaa kohdassa 09/);
  assert.equal(decide(parsed, { expectedChecks: numbers.length, expectedNumbers: numbers }).decision, 'GO');
  // Keskeltä puuttuva rivi näkyy yhä.
  const cut = parseCheckTable(realText('verify_0013-pass.tsv').split('\n').filter(l => !l.startsWith('27\t')).join('\n'));
  const verdict = decide(cut, { expectedChecks: numbers.length, expectedNumbers: numbers });
  assert.equal(verdict.decision, 'STOP');
  assert.match(verdict.reasons.join(' '), /tarkistukset 27 puuttuvat liitoksesta/);
  // Väärän tiedoston tulos: numerot eivät täsmää.
  const wrong = decide(parseCheckTable(realText('verify_0012-pass.tsv')), { expectedChecks: numbers.length, expectedNumbers: numbers });
  assert.equal(wrong.decision, 'STOP');
  assert.match(wrong.reasons.join(' '), /ei ole SQL-tiedostossa/);
});

test('oikean kannan tulokset eivät sisällä käyttäjän sisältöä', () => {
  for (const f of REAL) {
    const parsed = parseCheckTable(realText(f.name));
    for (const r of parsed.rows) {
      if (r.status === 'INFO') {
        // Lukumäärä, tunnisteen muotoinen nimi, versio tai hetki.
        assert.match(r.details, /^(\d+(: [a-z_, ]+)?|puuttuu|mv_rehearsal_\w+|17\.\d+|\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})$/, `${f.name} ${r.no}: ${r.details}`);
      } else {
        assert.match(r.details, /^odotus .*, toteutui .*$/, `${f.name} ${r.no}`);
      }
    }
  }
});
