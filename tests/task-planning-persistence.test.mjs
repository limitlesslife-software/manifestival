// Tehtävän suunnittelukentät (migraatio 0010) säilyvät ja offline-toisto
// toimii myös portin GOAL_PLANNING_FIELDS ollessa auki.
//
// LÖYDÖS AALLON H HARJOITTELUINTEGRAATIOSSA
//
// Tuotehaaroilla kaikki portit ovat kiinni, joten nämä polut eivät
// koskaan ajautuneet. Kun aallot A–G yhdistettiin natiiviajoon:
//
//   1. fromRow ei lukenut sarakkeita milestone_id ja depends_on. Ne
//      tallentuivat, mutta katosivat uudelleenlatauksessa — ja seuraava
//      koko rivin kirjoitus nollasi ne (datan menetys).
//   2. Ehdollinen osittainen kirjoitus (offline-toisto) vertasi
//      taulukoita identiteetillä: pelkkä otsikon muutos lähetti myös
//      depends_on-sarakkeen JA käytti sitä vertailuehtona
//      `.eq('depends_on', [])`, joka on URL:ssa `depends_on=eq.` ->
//      PostgreSQL 22P02. Jokainen offline-muokkauksen toisto olisi
//      kaatunut aallosta G alkaen.
//
// Portit ovat käännösaikaisia vakioita, joten testit syöttävät
// avoimen portin sarakejoukon (TASK_COLUMNS_PLANNING) suoraan.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  fromRow, toRow, TASK_COLUMNS_PLANNING, TASK_COLUMNS_EXTENDED,
  sameColumnValue, pgArrayLiteral
} from '../src/lib/rows.js';
import { normalizeTask } from '../src/domain/task.js';
import { partialPayloadFor, guardFilter } from '../src/data/tasksRepo.js';
import { decideUpdate } from '../src/domain/offlineQueue.js';

/** Palvelimen rivi sellaisena kuin se on migraation 0010 jälkeen. */
function serverRow(overrides = {}) {
  return {
    id: 't1', date: '2026-09-20', time: null, end_time: null, title: 'Alku',
    category: 'tyo', note: null, completed: false, is_wake: false,
    description: null, duration_minutes: null, priority: 'normaali',
    scheduling_state: 'unscheduled', milestone_id: null, depends_on: [],
    user_id: 'aaaaaaaa-0000-0000-0000-000000000001', ...overrides
  };
}

test('KRIITTINEN: fromRow lukee välitavoitteen ja riippuvuudet', () => {
  const task = fromRow(serverRow({ milestone_id: 'm1', depends_on: ['a', 'b'] }));
  assert.equal(task.milestoneId, 'm1');
  assert.deepEqual(task.dependsOn, ['a', 'b']);
});

test('ennen migraatiota 0010 (sarakkeita ei ole) arvot ovat normalizeTaskin oletukset', () => {
  const row = serverRow();
  delete row.milestone_id;
  delete row.depends_on;
  const task = fromRow(row);
  const defaults = normalizeTask({ id: 't1' });
  assert.equal(task.milestoneId, defaults.milestoneId);
  assert.deepEqual(task.dependsOn, defaults.dependsOn);
});

test('KRIITTINEN: luku -> kirjoitus ei nollaa suunnittelukenttiä (ei datan menetystä)', () => {
  const stored = serverRow({ milestone_id: 'm1', depends_on: ['a'] });
  const written = toRow(normalizeTask(fromRow(stored)), TASK_COLUMNS_PLANNING);
  assert.equal(written.milestone_id, 'm1');
  assert.deepEqual(written.depends_on, ['a']);
});

test('KRIITTINEN: otsikon muutos ei lähetä depends_on-saraketta eikä käytä sitä ehtona', () => {
  const current = fromRow(serverRow({ depends_on: [] }));
  const { diff, guards } = partialPayloadFor({ ...current, title: 'Uusi' }, current, TASK_COLUMNS_PLANNING);
  assert.deepEqual(diff, { title: 'Uusi' });
  assert.deepEqual(guards, { title: 'Alku' });
});

test('sama tulos myös kun riippuvuuksia on', () => {
  const current = fromRow(serverRow({ depends_on: ['a', 'b'] }));
  const { diff } = partialPayloadFor({ ...current, title: 'Uusi' }, current, TASK_COLUMNS_PLANNING);
  assert.deepEqual(Object.keys(diff), ['title']);
});

test('riippuvuuksien oikea muutos lähtee ja sen ehto on taulukkoliteraali', () => {
  const current = fromRow(serverRow({ depends_on: ['a'] }));
  const { diff, guards } = partialPayloadFor({ ...current, dependsOn: ['a', 'b'] }, current, TASK_COLUMNS_PLANNING);
  assert.deepEqual(diff, { depends_on: ['a', 'b'] });
  assert.deepEqual(guardFilter(guards.depends_on), ['eq', '{"a"}']);
});

test('KRIITTINEN: taulukkoehto ei koskaan ole paljas taulukko (22P02)', () => {
  assert.deepEqual(guardFilter([]), ['eq', '{}']);
  assert.deepEqual(guardFilter(null), ['is', null]);
  assert.deepEqual(guardFilter('Alku'), ['eq', 'Alku']);
  assert.equal(pgArrayLiteral(['a"b', 'c\\d']), '{"a\\"b","c\\\\d"}');
});

test('portin ollessa kiinni sarakejoukko ei sisällä suunnittelukenttiä', () => {
  const current = fromRow(serverRow({ depends_on: ['a'] }));
  const { diff } = partialPayloadFor({ ...current, dependsOn: [] }, current, TASK_COLUMNS_EXTENDED);
  assert.equal('depends_on' in diff, false);
});

test('sameColumnValue vertaa taulukot arvoina, ei identiteettinä', () => {
  assert.equal(sameColumnValue([], []), true);
  assert.equal(sameColumnValue(['a'], ['a']), true);
  assert.equal(sameColumnValue(['a'], ['b']), false);
  assert.equal(sameColumnValue(['a', 'b'], ['b', 'a']), false);
  assert.equal(sameColumnValue(null, []), true);
  assert.equal(sameColumnValue(undefined, null), true);
  assert.equal(sameColumnValue('x', ['x']), false);
});

test('KRIITTINEN: offline-toisto ei tulkitse erillisiä mutta samoja taulukoita konfliktiksi', () => {
  const server = normalizeTask(fromRow(serverRow({ depends_on: ['a'] })));
  const decision = decideUpdate({
    serverTask: server,
    baseValues: { title: 'Alku', dependsOn: ['a'] },
    changes: { title: 'Uusi', dependsOn: ['a'] }
  });
  assert.deepEqual(decision, { action: 'apply', patch: { title: 'Uusi' } });
});
