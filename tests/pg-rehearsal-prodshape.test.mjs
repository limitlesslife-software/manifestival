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
    70: '1', 71: '0', 72: '0', 73: '0', 74: '0',
    // Omistaja: "tasks with duration = 0" — kattaa myös rivin 89 (kesto > 0).
    89: '0'
  });
  const byTable = { tasks: '63', profile: '64', goals: '65', projects: '66', routines: '67', routine_exceptions: '68',
    notification_preferences: '69', wellbeing_entries: '70', bills: '71', recurring_expenses: '72',
    savings_goals: '73', ai_action_audit: '74' };
  for (const [table, nro] of Object.entries(byTable)) {
    assert.equal(expected.rows[nro].value, String(PROD_ROWS_0008[table]), `${table} (rivi ${nro})`);
  }
});

test('KRIITTINEN: jokainen inventaariorivi on luokiteltu (owner / derived / absent)', () => {
  // Harjoittelun fixture (2026-09-24) on vanhempi kuin rivi 89: sen rivit
  // ovat osajoukko. Täysi joukko tulee inventaario-SQL:stä (testi alla).
  for (const nro of Object.keys(harness0008)) {
    assert.ok(nro in expected.rows, `harjoittelun inventaarion rivi ${nro} puuttuu odotetusta inventaariosta`);
  }
  for (const [nro, spec] of Object.entries(expected.rows)) {
    assert.ok(['owner', 'derived', 'absent'].includes(spec.source), `rivi ${nro}: lähde ${spec.source}`);
    assert.ok(['exact', 'major', 'none'].includes(spec.compare), `rivi ${nro}: vertailu ${spec.compare}`);
    if (spec.source === 'absent') assert.equal(spec.compare, 'none', `rivi ${nro}: antamatonta ei verrata`);
    assert.ok(spec.note, `rivi ${nro}: selite puuttuu`);
  }
});

test('KRIITTINEN: odotetun inventaarion rivit = inventaario-SQL:n rivinumerot', () => {
  // Uusi inventaariorivi ilman luokitusta rikkoisi prodshape:fixturen
  // vasta oikealla kannalla ("(ei odotusta)"). Tämä pysäyttää sen ilman kantaa.
  const sql = read('supabase/acceptance/activation_readonly_inventory.sql');
  const numbers = [...sql.matchAll(/select '(\d{2})'::text as nro/g)].map(m => m[1]);
  assert.ok(numbers.length > 50, `rivinumeroita ${numbers.length}`);
  assert.equal(new Set(numbers).size, numbers.length, 'inventaariossa toistuva rivinumero');
  assert.deepEqual(Object.keys(expected.rows).sort(), [...numbers].sort(),
    'luokittele uusi rivi (owner / derived / absent): tools/pg-rehearsal/expected/production-inventory-0008.json');
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

test('KRIITTINEN: kultaiset skeemaerot 0009–0014 ovat olemassa ja poistavat vain sallitun', () => {
  for (const n of ['0009', '0010', '0011', '0012', '0013', '0014']) {
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
  for (const n of ['0009', '0010', '0011', '0012', '0013', '0014']) {
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

test('KRIITTINEN: 0014:n kultainen ero koskee vain sen kymmentä uutta taulua', () => {
  const NEW = ['saved_places', 'place_aliases', 'calendar_events', 'commute_observations', 'life_settings', 'sleep_logs',
    'habit_plans', 'habit_events', 'exercise_sessions', 'wellbeing_checkins'];
  const lines = read(goldenFile('0014')).replace(/\r\n/g, '\n').split('\n').filter(Boolean);
  assert.equal(lines.filter(l => l.startsWith('- ')).length, 0, '0014 ei poista mitään');
  // Jokainen lisätty objekti (taulu, sarake, indeksi, rajoite, politiikka,
  // liipaisin) kuuluu uuteen tauluun: yhtäkään olemassa olevaa ei muuteta.
  const prefix = new RegExp(`^\\+ (rel|col|idx|con|pol|trg):(${NEW.join('|')})[.:_]`);
  for (const l of lines) assert.match(l, prefix, `0014 koskee vanhaan objektiin: ${l}`);
  assert.equal(lines.filter(l => /^\+ fn:/.test(l)).length, 0, '0014 ei luo funktioita');
  assert.deepEqual(lines.filter(l => /^\+ rel:\w+:r:/.test(l)).map(l => l.split(':')[1]).sort(), [...NEW].sort());
  // Kuusi yhdistelmävierasavainta täsmälleen sovitulla poistosäännöllä.
  const fks = Object.fromEntries(lines.filter(l => /FOREIGN KEY \(user_id, \w+\)/.test(l))
    .map(l => [l.split(':')[2], l.replace(/^.*?FOREIGN KEY/, 'FOREIGN KEY').replace(/:validated=\w+$/, '')]));
  assert.deepEqual(fks, {
    place_aliases_place_fkey: 'FOREIGN KEY (user_id, place_id) REFERENCES saved_places(user_id, id) ON DELETE CASCADE',
    calendar_events_place_fkey: 'FOREIGN KEY (user_id, place_id) REFERENCES saved_places(user_id, id) ON DELETE SET NULL (place_id)',
    calendar_events_goal_fkey: 'FOREIGN KEY (user_id, goal_id) REFERENCES goals(user_id, id) ON DELETE SET NULL (goal_id)',
    commute_observations_place_fkey: 'FOREIGN KEY (user_id, place_id) REFERENCES saved_places(user_id, id) ON DELETE CASCADE',
    habit_events_plan_fkey: 'FOREIGN KEY (user_id, plan_id) REFERENCES habit_plans(user_id, id) ON DELETE CASCADE',
    exercise_sessions_goal_fkey: 'FOREIGN KEY (user_id, goal_id) REFERENCES goals(user_id, id) ON DELETE SET NULL (goal_id)'
  });
  // Omistaja-avain auth.usersiin on CASCADE jokaisessa uudessa taulussa.
  for (const t of NEW) {
    assert.ok(lines.includes(`+ con:${t}:${t}_user_id_fkey:FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE:validated=true`), t);
  }
  // Havainnon event_id ei ole vierasavain.
  assert.equal(lines.some(l => /commute_observations.*FOREIGN KEY \(user_id, event_id\)/.test(l)), false);
});

test('KRIITTINEN: oikean kannan inventaario tilassa 0014: GO, ei seuraavaa migraatiota; keskeneräinen 0014 -> STOP', () => {
  const dir = path.join(ROOT, 'tests/fixtures/activation-inventory');
  const done = parseInventory(fs.readFileSync(path.join(dir, 'state-0014.json'), 'utf8'));
  const scored = scoreInventory(done);
  assert.equal(scored.decision, 'GO', scored.stops.join('; '));
  assert.equal(scored.nextMigration, null);
  assert.equal(scored.facts.migrations['0014'], 'run');
  assert.equal(scored.facts.migrations['0013'], 'run');
  // Rivit 90–99: uusien taulujen rivimäärät. Harjoittelu siemensi jokaiseen
  // tauluun rivin kummallekin synteettiselle käyttäjälle; 'puuttuu' = ei taulua.
  for (let nro = 90; nro <= 99; nro++) assert.equal(done[String(nro)], '2', `rivi ${nro}`);
  const partial = scoreInventory(parseInventory(fs.readFileSync(path.join(dir, 'state-0013-partial-0014.json'), 'utf8')));
  assert.equal(partial.decision, 'STOP');
  assert.equal(partial.facts.migrations['0014'], 'partial');
  assert.ok(partial.stops.some(s => /0014/.test(s)), partial.stops.join('; '));
});

test('KRIITTINEN: SCHEMA-DIFFS-0009-0014.md on johdettu kultaisista tiedostoista', () => {
  assert.equal(read(SUMMARY_DOC).replace(/\r\n/g, '\n'), summaryMarkdown(),
    'aja: node tools/pg-rehearsal/schema-diff-summary.mjs');
  assert.deepEqual(parseGolden('- a:b\n+ c:d\n\n'), { added: ['c:d'], removed: ['a:b'] });
});
