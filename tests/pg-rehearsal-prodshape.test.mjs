// Tuotannon muotoinen tila 0008 ja kultaiset skeemaerot ILMAN palvelinta.
//
// Oikean kannan todiste: node tools/pg-rehearsal/rehearse.mjs
// --only=prodshape (prodshape:fixture vertaa harjoittelun inventaariota
// tähän tiedostoon, prodshape:chain skeemaeroja kultaisiin tiedostoihin).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { ROOT, read } from './helpers/sources.mjs';
import {
  loadExpectedInventory, compareInventory, expectedInventoryRows, checkRemovals, ALLOWED_REMOVALS,
  goldenFile, PROD_ROWS_0008, LEGAL_GOAL_STATUSES_0004, prodVariants
} from '../tools/pg-rehearsal/prodshape.mjs';
import { parseInventory, scoreInventory } from '../tools/activation/score-inventory.mjs';
import { summaryMarkdown, SUMMARY_DOC, parseGolden } from '../tools/pg-rehearsal/schema-diff-summary.mjs';

const expected = loadExpectedInventory();
const harness0008 = parseInventory(fs.readFileSync(path.join(ROOT, 'tests/fixtures/activation-inventory/state-0008.json'), 'utf8'));

test('KRIITTINEN: odotettu inventaario sisältää täsmälleen omistajan toimittamat arvot', () => {
  const owner = Object.fromEntries(Object.entries(expected.rows).filter(([, s]) => s.source === 'owner').map(([k, s]) => [k, s.value]));
  assert.deepEqual(owner, {
    '01': '170006', '02': '17.6', 40: '1', 41: '1', 42: '5', 44: '0', 45: '0', 50: '0', 51: '0', 52: '0',
    60: 'text', 61: 'text', 62: '0', 63: '36', 64: '1', 65: '1', 66: '1', 67: '0', 68: '0', 69: '1',
    70: '1', 71: '0', 72: '0', 73: '0', 74: '0'
  });
  const byTable = { tasks: '63', profile: '64', goals: '65', projects: '66', routines: '67', routine_exceptions: '68',
    notification_preferences: '69', wellbeing_entries: '70', bills: '71', recurring_expenses: '72',
    savings_goals: '73', ai_action_audit: '74' };
  for (const [table, nro] of Object.entries(byTable)) {
    assert.equal(expected.rows[nro].value, String(PROD_ROWS_0008[table]), `${table} (rivi ${nro})`);
  }
});

test('KRIITTINEN: jokainen inventaariorivi on luokiteltu (owner / derived / absent)', () => {
  assert.deepEqual(Object.keys(expected.rows).sort(), Object.keys(harness0008).sort(),
    'odotettu inventaario ja harjoittelun inventaario eivät kata samoja rivejä');
  for (const [nro, spec] of Object.entries(expected.rows)) {
    assert.ok(['owner', 'derived', 'absent'].includes(spec.source), `rivi ${nro}: lähde ${spec.source}`);
    assert.ok(['exact', 'major', 'none'].includes(spec.compare), `rivi ${nro}: vertailu ${spec.compare}`);
    if (spec.source === 'absent') assert.equal(spec.compare, 'none', `rivi ${nro}: antamatonta ei verrata`);
    assert.ok(spec.note, `rivi ${nro}: selite puuttuu`);
  }
});

test('compareInventory: poikkeama havaitaan, antamaton kirjataan, pääversio riittää', () => {
  const rows = { ...expectedInventoryRows(expected), '01': '170010', '02': '17.10', '03': 'x', '04': 'y', 43: '1' };
  const ok = compareInventory(expected, rows);
  assert.deepEqual(ok.mismatches, []);
  assert.equal(ok.recorded['43'], '1');
  const bad = compareInventory(expected, { ...rows, 63: '38', 41: '2', '01': '150004' });
  assert.deepEqual(bad.mismatches.map(m => m.nro).sort(), ['01', '41', '63']);
  assert.ok(compareInventory(expected, { ...rows, 99: 'uusi' }).mismatches.some(m => m.nro === '99'));
});

test('KRIITTINEN: omistajan inventaario pisteytyy GO / 0009, kun rivi 43 on kunnossa', () => {
  const withoutAbsent = scoreInventory(expectedInventoryRows(expected));
  // Omistaja ei toimittanut riviä 43 (touch_updated_at): pisteytys pysähtyy
  // juuri siihen eikä mihinkään muuhun.
  assert.equal(withoutAbsent.decision, 'STOP');
  assert.equal(withoutAbsent.stops.length, 1, withoutAbsent.stops.join('; '));
  assert.match(withoutAbsent.stops[0], /touch_updated_at/);
  const full = scoreInventory(expectedInventoryRows(expected, { 43: '1' }));
  assert.equal(full.decision, 'GO', full.stops.join('; '));
  assert.equal(full.nextMigration, '0009');
  assert.equal(full.facts.tasks, 36);
  assert.equal(full.facts.taskDateType, 'text');
});

test('muunnelmat: viisi 0004:n tilaa × projekti kytketty/irti', () => {
  assert.deepEqual([...LEGAL_GOAL_STATUSES_0004].sort(),
    ['abandoned', 'active', 'archived', 'completed', 'paused']);
  const v = prodVariants();
  assert.equal(v.length, 10);
  assert.equal(new Set(v.map(x => x.key)).size, 10);
  for (const x of v) assert.match(`mv_rehearsal_val_${x.key}`, /^mv_rehearsal_[a-z0-9_]+$/);
});

test('checkRemovals: vain sallitut poistot, kukin kerran', () => {
  assert.deepEqual(checkRemovals('0009', []), []);
  assert.equal(checkRemovals('0009', ['con:bills:x:CHECK']).length, 1);
  assert.deepEqual(checkRemovals('0010', ['con:goals:goals_status_check:CHECK (...)']), []);
  assert.equal(checkRemovals('0010', []).length, 1, 'tilarajoitteen korvaus puuttuu');
  assert.equal(checkRemovals('0013', ['con:time_entries:time_entries_source_check:x', 'col:tasks.title:text']).length, 1);
});

test('KRIITTINEN: kultaiset skeemaerot 0009–0013 ovat olemassa ja poistavat vain sallitun', () => {
  for (const n of ['0009', '0010', '0011', '0012', '0013']) {
    const text = read(goldenFile(n)).replace(/\r\n/g, '\n');
    const lines = text.split('\n').filter(Boolean);
    assert.ok(lines.length > 20, `${n}: kultainen ero on tyhjä`);
    for (const l of lines) assert.match(l, /^[+-] (rel|col|idx|con|pol|trg|fn|nsp):/, `${n}: outo rivi ${l}`);
    const removed = lines.filter(l => l.startsWith('- ')).map(l => l.slice(2));
    assert.deepEqual(checkRemovals(n, removed), [], `${n}: odottamaton poisto`);
    assert.equal(removed.length, ALLOWED_REMOVALS[n].length, n);
    // Uudet taulut: RLS päällä, ei anon- eikä PUBLIC-oikeutta (ACL:ssa "=..." ilman roolia).
    for (const rel of lines.filter(l => /^\+ rel:\w+:r:/.test(l))) {
      assert.match(rel, /:rls=true:/, `${n}: taulu ilman RLS:ää: ${rel}`);
      assert.equal(/anon=|,=|acl==/.test(rel), false, `${n}: anon/PUBLIC-oikeus: ${rel}`);
      assert.match(rel, /authenticated=arwd\//, `${n}: authenticated ei saa täsmälleen arwd: ${rel}`);
    }
    // Jokainen uusi politiikka on authenticated-roolille.
    for (const pol of lines.filter(l => l.startsWith('+ pol:'))) assert.match(pol, /:authenticated$/, pol);
  }
  // Neljä politiikkaa jokaiselle uudelle taululle.
  for (const n of ['0009', '0010', '0011', '0012', '0013']) {
    const lines = read(goldenFile(n)).replace(/\r\n/g, '\n').split('\n');
    const tables = lines.filter(l => /^\+ rel:\w+:r:/.test(l)).length;
    assert.equal(lines.filter(l => l.startsWith('+ pol:')).length, 4 * tables, `${n}: politiikkoja ≠ 4 × uudet taulut`);
  }
  // Korvaukset: 0010 viidestä kuuteen arvoon, 0013 manual -> manual+timer.
  const d10 = read(goldenFile('0010'));
  assert.match(d10, /- con:goals:goals_status_check:CHECK \(\(status = ANY \(ARRAY\['active'::text, 'paused'::text, 'completed'::text/);
  assert.match(d10, /\+ con:goals:goals_status_check:.*'maintenance'::text/);
  const d13 = read(goldenFile('0013'));
  assert.match(d13, /- con:time_entries:time_entries_source_check:/);
  assert.match(d13, /\+ con:time_entries:time_entries_source_v2_check:.*'timer'::text/);
});

test('KRIITTINEN: SCHEMA-DIFFS-0009-0013.md on johdettu kultaisista tiedostoista', () => {
  assert.equal(read(SUMMARY_DOC).replace(/\r\n/g, '\n'), summaryMarkdown(),
    'aja: node tools/pg-rehearsal/schema-diff-summary.mjs');
  assert.deepEqual(parseGolden('- a:b\n+ c:d\n\n'), { added: ['c:d'], removed: ['a:b'] });
});
