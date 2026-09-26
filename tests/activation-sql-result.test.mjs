// Omistajan liittämä esitarkistus- tai varmistustulos (ACT-12).
//
// Fixturet ovat synteettisiä: ne rakennetaan OIKEAN SQL-tiedoston
// tarkistusnumeroista (supabase/preflight/preflight_00XX.sql,
// supabase/verify/verify_00XX.sql), jotta liitoksen täydellisyyden
// tarkistus vastaa sitä, mitä Supabasen editori oikeasti palauttaa.
// Oikean kannan tuottamat fixturet kuuluvat harjoittelupaketille
// (tools/pg-rehearsal ei vielä kirjoita niitä).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { read } from './helpers/sources.mjs';
import { countChecksInSql, decide, parseCheckTable } from '../tools/activation/score-sql-result.mjs';

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
  // 16 + rivi "muiden istuntojen lukot migraation tauluissa" (loppuharjoitus F10).
  assert.equal(PREFLIGHT_0009, 17);
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
  assert.match(gap.problems.join(' '), /katkeaa kohdassa 05/);
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
