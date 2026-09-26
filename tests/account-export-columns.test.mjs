// Jokainen käyttäjän taulun sarake päätyy vientiin.
//
// Vientitestit tarkistivat vain kokoelmien nimet ja määrät. Sarake, jota
// repositorion fromRow ei lue, katosi viennistä hiljaa -- esimerkiksi
// tasks.deadline/goal_id/project_id (0004) ja profile.automation_level
// (0010). Tämä testi lukee sarakkeet MIGRAATIOISTA (lähtötila + jokainen
// CREATE TABLE ja ALTER TABLE ... ADD/DROP/RENAME COLUMN), rakentaa
// näyterivin, ajaa sen oikean fromRow:n ja buildUserDataExport():n läpi ja
// vaatii jokaisen sarakkeen näkyvän viennissä.
//
// Uusi ADD COLUMN käyttäjän tauluun kaataa tämän testin, kunnes sarake
// luetaan fromRow:ssa -- tai se lisätään ALLOWED_OMISSIONS-listaan
// perusteluineen. Nimetty uudelleen viennissä? RENAMES.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { ROOT } from './helpers/sources.mjs';
import { createTableStatements, alterTableActions, columnDefinitions } from './helpers/migrationSchema.mjs';
import { baselineSql } from '../tools/pg-rehearsal/baseline.mjs';
import { ACCOUNT_DATA_MAP } from '../src/domain/accountLifecycle.js';
import { buildUserDataExport } from '../src/domain/dataExport.js';
import { ALL_REPOSITORIES } from '../src/data/collectionsRepo.js';
import { fromRow as taskFromRow } from '../src/lib/rows.js';
import { profileFromRow } from '../src/data/profileRepo.js';
import { preferencesFromRow } from '../src/data/notificationPrefsRepo.js';

const MIGRATIONS_DIR = path.join(ROOT, 'supabase', 'migrations');

/**
 * Sarake -> vientikenttä, kun nimi ei ole sarakkeen camelCase.
 * Avain on `taulu.sarake`.
 */
const RENAMES = Object.freeze({
  'reminders.trigger_type': 'trigger',
  'notices.notice_key': 'key',
  'location_rules.trigger_type': 'trigger',
  'ai_action_audit.occurred_at': 'timestamp'
});

/**
 * Sarakkeet, jotka EIVÄT päädy vientiin, ja miksi. Jokaisella on oltava
 * perustelu. Kun sarake alkaa näkyä viennissä, merkintä on poistettava
 * (testi kaatuu vanhentuneeseen merkintään).
 */
const ALLOWED_OMISSIONS = Object.freeze({
  'profile.legacy_id': 'Migraation 0001 vanha kiinteä tunniste (id = \'me\'), ei käyttäjän tietoa',
  'profile.automation_level': 'Ei kirjoittajaa eikä lukijaa: automaatiotaso on toistaiseksi '
    + 'laitekohtainen asetus (DEVICE_DEFAULTS.automationLevel); sarake on oletusarvossa',
  'profile.planning_buffer_ratio': 'Ei kirjoittajaa eikä lukijaa: sarake jää oletusarvoon (0010), '
    + 'koska tilikohtaiset suunnitteluasetukset (ACCOUNT_DEFAULTS.planning) ovat vielä PLANNED',
  'notification_preferences.created_at': 'Kannan omaa kirjanpitoa (rivin luontihetki), ei käyttäjän syöttämää tietoa',
  'notification_preferences.updated_at': 'Kannan omaa kirjanpitoa (liipaisin), ei käyttäjän syöttämää tietoa',
  'routine_exceptions.created_at': 'Kannan omaa kirjanpitoa (rivin luontihetki), ei käyttäjän syöttämää tietoa',
  'routine_exceptions.updated_at': 'Kannan omaa kirjanpitoa (liipaisin), ei käyttäjän syöttämää tietoa',
  'location_rules.created_at': 'Kannan omaa kirjanpitoa (rivin luontihetki), ei käyttäjän syöttämää tietoa',
  'location_rules.updated_at': 'Kannan omaa kirjanpitoa (liipaisin), ei käyttäjän syöttämää tietoa',
  'ai_action_audit.created_at': 'Kannan omaa kirjanpitoa; tapahtuman hetki viedään kenttänä timestamp (occurred_at)'
});

/** taulu -> Map(sarake -> tyyppi): lähtötila, sitten migraatiot järjestyksessä. */
function schemaColumns() {
  const tables = new Map();
  const apply = sql => {
    for (const table of createTableStatements(sql)) {
      if (table.schema !== 'public' || !table.body) continue;
      tables.set(table.name, new Map(columnDefinitions(table.body).map(column => [column.name, column.type])));
    }
    for (const action of alterTableActions(sql)) {
      const columns = tables.get(action.name);
      if (action.schema !== 'public' || !columns) continue;
      if (action.action === 'add') columns.set(action.column, action.type);
      if (action.action === 'drop') columns.delete(action.column);
      if (action.action === 'rename') {
        const type = columns.get(action.column);
        columns.delete(action.column);
        columns.set(action.to, type);
      }
    }
  };
  apply(baselineSql('text'));
  for (const name of fs.readdirSync(MIGRATIONS_DIR).filter(file => file.endsWith('.sql')).sort()) {
    apply(fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8'));
  }
  return tables;
}

/** Näytearvo sarakkeen tyypin mukaan (ei tarvitse olla domainin sallima -- vain luettava). */
function sampleValue(column, type) {
  if (type.endsWith('[]')) return ['naytteen-arvo'];
  if (type.startsWith('uuid')) return '11111111-1111-4111-8111-111111111111';
  if (/^(smallint|integer|int|bigint)\b/.test(type)) return 3;
  if (/^(numeric|real|double|decimal)\b/.test(type)) return 3;
  if (type.startsWith('bool')) return true;
  if (type === 'date') return '2026-09-21';
  if (type.startsWith('timestamp')) return '2026-09-21T10:00:00.000Z';
  if (type.startsWith('time')) return '08:00';
  if (type.startsWith('json')) return { naytteen: 'arvo' };
  return 'nayte-' + column;
}

const OBJECT_COLLECTIONS = new Set(['profile', 'notificationPreferences']);
const SPECIAL_FROM_ROW = Object.freeze({
  tasks: taskFromRow,
  profile: profileFromRow,
  notification_preferences: preferencesFromRow
});

function fromRowFor(table) {
  if (SPECIAL_FROM_ROW[table]) return SPECIAL_FROM_ROW[table];
  const repo = ALL_REPOSITORIES.find(item => item.table === table);
  return repo ? repo.mapping.fromRow : null;
}

/** Viedyn olion avaimet litistettynä ('quietHours.from') ja vertailumuotoon. */
function exportedKeys(value, prefix = '', out = new Set()) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [key, item] of Object.entries(value)) {
    out.add(normalizeKey(prefix + key));
    exportedKeys(item, prefix + key + '.', out);
  }
  return out;
}

const normalizeKey = key => key.toLowerCase().replace(/[._]/g, '');

/** Vientikentät yhdelle näyteriville: { columns, keys }. */
function exportFor(collection, table, columns) {
  const row = {};
  for (const [column, type] of columns) row[column] = sampleValue(column, type);
  const domain = fromRowFor(table)(row);
  const data = OBJECT_COLLECTIONS.has(collection) ? domain : [domain];
  const exported = buildUserDataExport({ [collection]: data }).data[collection];
  return exportedKeys(OBJECT_COLLECTIONS.has(collection) ? exported : exported[0]);
}

function missingColumns() {
  const schema = schemaColumns();
  const missing = [];
  const present = [];
  for (const [collection, { table, ownerColumn }] of Object.entries(ACCOUNT_DATA_MAP)) {
    const columns = schema.get(table);
    const keys = exportFor(collection, table, columns);
    for (const column of columns.keys()) {
      if (column === ownerColumn) continue;
      const qualified = `${table}.${column}`;
      const expected = RENAMES[qualified] || column;
      (keys.has(normalizeKey(expected)) ? present : missing).push(qualified);
    }
  }
  return { missing, present, schema };
}

test('sarakemalli on luettu: jokainen poistokartan taulu ja sen tunnetut sarakkeet', () => {
  const schema = schemaColumns();
  for (const { table, ownerColumn } of Object.values(ACCOUNT_DATA_MAP)) {
    assert.ok(schema.has(table), `taulun ${table} sarakkeita ei löydy migraatioista`);
    assert.ok(schema.get(table).has(ownerColumn), `${table}: omistajasarake ${ownerColumn} puuttuu mallista`);
    assert.ok(fromRowFor(table), `${table}: fromRow puuttuu`);
  }
  // Pistokokeet eri lähteistä: lähtötila, ADD COLUMN, RENAME, 0013.
  assert.equal(schema.get('tasks').get('title'), 'text');
  assert.equal(schema.get('tasks').get('depends_on'), 'text[]');
  assert.ok(schema.get('profile').has('legacy_id'), 'RENAME COLUMN id -> legacy_id');
  assert.equal(schema.get('profile').get('id'), 'uuid');
  assert.ok(schema.get('time_entries').has('operation_id'));
  assert.equal(schema.get('alignment_reviews').get('reflection_answers'), 'jsonb');
});

test('KRIITTINEN: jokainen käyttäjän taulun sarake päätyy vientiin (tai on perustellusti pois)', () => {
  const { missing } = missingColumns();
  const unexplained = missing.filter(column => !Object.prototype.hasOwnProperty.call(ALLOWED_OMISSIONS, column));
  assert.deepEqual(unexplained, [],
    'Näitä sarakkeita ei lue mikään fromRow, joten ne puuttuvat käyttäjän viennistä: '
    + unexplained.join(', ') + '. Lue sarake repositorion fromRow:ssa tai lisää se '
    + 'ALLOWED_OMISSIONS-listaan perusteluineen.');
});

test('poikkeuslistat ovat ajan tasalla: jokainen poikkeus on yhä totta ja perusteltu', () => {
  const { missing, schema } = missingColumns();
  for (const [column, reason] of Object.entries(ALLOWED_OMISSIONS)) {
    const [table, name] = column.split('.');
    assert.ok(schema.get(table) && schema.get(table).has(name), `${column}: saraketta ei ole (vanhentunut poikkeus)`);
    assert.ok(typeof reason === 'string' && reason.length >= 10, `${column}: perustelu puuttuu`);
    assert.ok(missing.includes(column),
      `${column} näkyy nyt viennissä: poista se ALLOWED_OMISSIONS-listasta, jottei poikkeus peitä tulevaa katoamista`);
  }
  for (const [column, key] of Object.entries(RENAMES)) {
    const [table, name] = column.split('.');
    assert.ok(schema.get(table) && schema.get(table).has(name), `${column}: saraketta ei ole (vanhentunut uudelleennimeys)`);
    assert.equal(missing.includes(column), false, `${column}: vientikenttää ${key} ei ole`);
  }
});

test('Suunnan taulujen (0012/0013) jokainen sarake päätyy vientiin ilman poikkeuksia', () => {
  const { missing } = missingColumns();
  const suunta = ['life_areas', 'weekly_capacities', 'time_entries', 'alignment_reviews',
    'running_timers', 'alignment_item_settings'];
  assert.deepEqual(missing.filter(column => suunta.includes(column.split('.')[0])), []);
});
