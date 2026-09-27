// TESTIKÄYTTÖÖN: skeemaa noudattava PostgREST-korvike.
//
// MIKSI TÄMÄ ON OLEMASSA
//
// Aiemmat korvikkeet (multiTableServer, gates.mjs fakeClient) hyväksyvät
// minkä tahansa taulun ja sarakkeen. Niillä ei voi havaita sitä vikaa,
// jota ajonaikainen skeematarkistus torjuu: sovellus kirjoittaa
// sarakkeeseen, jota kannassa ei vielä ole (PGRST204), tai tauluun, jota
// ei ole (PGRST205).
//
// Tämä palvelin johtaa taulut ja sarakkeet SUORAAN migraatioista
// (supabase/migrations/*.sql, create table + alter table add column) ja
// tuotannon lähtötilasta (tools/pg-rehearsal/baseline.mjs) annetulle
// joukolle ajettuja migraatioita. Se vastaa kuten PostgREST:
//
//   tuntematon taulu            PGRST205 (404)
//   tuntematon select-sarake    42703    (400)
//   tuntematon payload-avain    PGRST204 (400)
//   time_entries.source='timer' ennen 0013:a   23514
//   goals.status='maintenance'  ennen 0010:tä  23514
//   kielletty taulu (revoked)   42501    (403)
//
// ja vikatilat: offline (heittää TypeError 'Failed to fetch'), 503
// (PGRST002), jwt (PGRST301, 401) ja hang (ei vastaa ennen keskeytystä).
// Jokainen kutsu kirjataan (`calls`), jotta testi voi todistaa mitä
// verkkoon lähti.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { baselineSql } from '../../tools/pg-rehearsal/baseline.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIGRATIONS = path.join(ROOT, 'supabase', 'migrations');

export const ALL_MIGRATIONS = Object.freeze(fs.readdirSync(MIGRATIONS)
  .filter(name => /^\d{4}_.*\.sql$/.test(name)).sort().map(name => name.slice(0, 4)));

const ID_OWNED = new Set(['profile', 'notification_preferences']);

function stripComments(sql) {
  return sql.replace(/--[^\n]*/g, '').replace(/\r/g, '');
}

function splitTop(body) {
  const out = [];
  let depth = 0;
  let current = '';
  for (const ch of body) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) { out.push(current); current = ''; } else current += ch;
  }
  if (current.trim()) out.push(current);
  return out;
}

/** create table -sarakkeet ja alter table add column -sarakkeet yhdestä SQL-tekstistä. */
export function parseColumns(sql) {
  const code = stripComments(sql);
  const creates = new Map();
  for (const match of code.matchAll(/create table (?:if not exists )?public\.(\w+)\s*\(([\s\S]*?)\n\);/g)) {
    const columns = [];
    for (const part of splitTop(match[2])) {
      const text = part.trim();
      if (!text || /^(constraint|primary|foreign|unique|check|exclude)\b/i.test(text)) continue;
      const name = /^(\w+)\s+/.exec(text);
      if (name) columns.push(name[1]);
    }
    creates.set(match[1], columns);
  }
  const adds = new Map();
  for (const statement of code.matchAll(/alter table (?:only )?public\.(\w+)\s+((?:add column[\s\S]*?))(?=;)/g)) {
    for (const column of statement[2].matchAll(/add column (?:if not exists )?(\w+)/g)) {
      if (!adds.has(statement[1])) adds.set(statement[1], []);
      adds.get(statement[1]).push(column[1]);
    }
  }
  return { creates, adds };
}

let cachedPerMigration = null;

/** Migraatio -> { creates, adds }. Lähtötila (ennen 0001:tä) avaimella 'baseline'. */
export function migrationCatalog() {
  if (cachedPerMigration) return cachedPerMigration;
  const out = new Map();
  out.set('baseline', parseColumns(baselineSql('text')));
  for (const name of fs.readdirSync(MIGRATIONS).filter(n => /^\d{4}_.*\.sql$/.test(n)).sort()) {
    out.set(name.slice(0, 4), parseColumns(fs.readFileSync(path.join(MIGRATIONS, name), 'utf8')));
  }
  cachedPerMigration = out;
  return out;
}

/**
 * Kannan skeema annetuilla migraatioilla: taulu -> Set(sarakkeet).
 *
 * @param {string[]} applied esim. ['0001', ..., '0008', '0012']
 * @param {Record<string, string[]>} [drop] sarakkeet, jotka poistetaan (vajaa migraatio)
 */
export function schemaAt(applied, drop = {}) {
  const catalog = migrationCatalog();
  const tables = new Map();
  for (const key of ['baseline', ...[...applied].sort()]) {
    const entry = catalog.get(key);
    if (!entry) throw new Error('Tuntematon migraatio: ' + key);
    for (const [table, columns] of entry.creates) tables.set(table, new Set(columns));
    for (const [table, columns] of entry.adds) {
      if (!tables.has(table)) continue;
      for (const column of columns) tables.get(table).add(column);
    }
  }
  for (const [table, columns] of Object.entries(drop)) {
    for (const column of columns) tables.get(table)?.delete(column);
  }
  return tables;
}

/** Migraatiot 0001..n. */
export function migrationsThrough(last) {
  return ALL_MIGRATIONS.filter(id => id <= last);
}

function pgArray(values) {
  return '{' + values.map(value => '"' + String(value).replace(/(["\\])/g, '\\$1') + '"').join(',') + '}';
}

/**
 * @param {object} options
 * @param {string[]} options.applied ajetut migraatiot
 * @param {Record<string,string[]>} [options.drop] poistettavat sarakkeet
 * @param {string[]} [options.revoked] taulut, joihin ei ole oikeutta (42501)
 * @param {() => string|null} [options.currentUserId]
 * @param {null|'offline'|'503'|'jwt'|'hang'} [options.failMode]
 */
export function createSchemaServer({
  applied, drop = {}, revoked = [], currentUserId = () => 'user-1', failMode = null
} = {}) {
  const schema = schemaAt(applied, drop);
  const has = migration => applied.includes(migration);
  const rows = new Map();
  const calls = [];
  let mode = failMode;

  const tableRows = name => {
    if (!rows.has(name)) rows.set(name, []);
    return rows.get(name);
  };
  const owner = name => (ID_OWNED.has(name) ? 'id' : 'user_id');

  function builder(name) {
    const entry = { table: name, op: 'select', columns: '*', payloadKeys: null, limit: null, filters: [] };
    let payload = null;
    let single = false;
    let returning = false;
    let signal = null;

    const matches = row => entry.filters.every(([kind, column, value]) => {
      const current = row[column];
      if (kind === 'is') return current === null || current === undefined;
      const text = Array.isArray(current) ? pgArray(current) : String(current);
      return kind === 'eq' ? text === String(value) : text !== String(value);
    });

    function fail(code, message, status) {
      return { data: null, error: { code, message, details: null, hint: null }, status };
    }

    function run() {
      if (!schema.has(name)) {
        return fail('PGRST205', `Could not find the table 'public.${name}' in the schema cache`, 404);
      }
      if (revoked.includes(name)) return fail('42501', `permission denied for table ${name}`, 403);
      const columns = schema.get(name);

      if (entry.op === 'select') {
        if (entry.columns !== '*') {
          for (const column of entry.columns.split(',').map(c => c.trim()).filter(Boolean)) {
            if (!columns.has(column)) return fail('42703', `column ${name}.${column} does not exist`, 400);
          }
        }
        if (entry.limit === 0) return { data: [], error: null, status: 200 };
        let found = tableRows(name).filter(matches).map(row => ({ ...row }));
        // Sivutettu lataus (collectionsRepo selectOwnedRows).
        if (entry.range) found = found.slice(entry.range[0], entry.range[1] + 1);
        return { data: single ? (found[0] || null) : found, error: null, status: 200 };
      }

      const list = entry.op === 'delete' ? [] : (Array.isArray(payload) ? payload : [payload]);
      for (const item of list) {
        const unknown = Object.keys(item).find(column => !columns.has(column));
        if (unknown) {
          return fail('PGRST204', `Could not find the '${unknown}' column of '${name}' in the schema cache`, 400);
        }
        if (name === 'time_entries' && item.source !== undefined
          && !(has('0013') ? ['manual', 'timer'] : ['manual']).includes(item.source)) {
          return fail('23514', 'new row for relation "time_entries" violates check constraint', 400);
        }
        if (name === 'goals' && item.status === 'maintenance' && !has('0010')) {
          return fail('23514', 'new row for relation "goals" violates check constraint "goals_status_check"', 400);
        }
      }

      const uid = currentUserId();
      const stored = tableRows(name);
      if (entry.op === 'insert' || entry.op === 'upsert') {
        for (const item of list) {
          const row = { ...item };
          if (row[owner(name)] == null) row[owner(name)] = uid;
          const at = stored.findIndex(r => String(r.id) === String(row.id));
          if (at !== -1 && entry.op === 'insert') {
            return fail('23505', 'duplicate key value violates unique constraint', 409);
          }
          if (at !== -1) stored[at] = { ...stored[at], ...row };
          else stored.push(row);
        }
        return { data: returning ? list.map(item => ({ id: item.id })) : null, error: null, status: 201 };
      }
      if (entry.op === 'update') {
        const hit = stored.filter(matches);
        for (const row of hit) Object.assign(row, payload);
        return { data: returning ? hit.map(row => ({ id: row.id })) : null, error: null, status: 200 };
      }
      if (entry.op === 'delete') {
        const keep = stored.filter(row => !matches(row));
        rows.set(name, keep);
        return { data: null, error: null, status: 204 };
      }
      return fail('PGRST000', 'tuntematon operaatio', 500);
    }

    function respond() {
      calls.push({ ...entry, filters: [...entry.filters] });
      if (mode === 'offline') return Promise.reject(new TypeError('Failed to fetch'));
      if (mode === '503') {
        return Promise.resolve(fail('PGRST002', 'Could not query the database for the schema cache. Retrying.', 503));
      }
      if (mode === 'jwt') return Promise.resolve(fail('PGRST301', 'JWT expired', 401));
      if (mode === 'hang') {
        return new Promise((resolve, reject) => {
          if (signal) {
            signal.addEventListener('abort', () => {
              const error = new Error('The operation was aborted.');
              error.name = 'AbortError';
              reject(error);
            });
          }
        });
      }
      return Promise.resolve(run());
    }

    const q = {
      select(columns = '*') {
        if (entry.op === 'select') entry.columns = String(columns);
        else returning = true;
        return q;
      },
      limit(n) { entry.limit = n; return q; },
      abortSignal(value) { signal = value; return q; },
      eq(column, value) { entry.filters.push(['eq', column, value]); return q; },
      neq(column, value) { entry.filters.push(['neq', column, value]); return q; },
      is(column, value) { entry.filters.push(['is', column, value]); return q; },
      order() { return q; },
      range(from, to) { entry.range = [from, to]; return q; },
      maybeSingle() { single = true; return q; },
      single() { single = true; return q; },
      insert(value) { entry.op = 'insert'; payload = value; entry.payloadKeys = keysOf(value); return q; },
      upsert(value) { entry.op = 'upsert'; payload = value; entry.payloadKeys = keysOf(value); return q; },
      update(value) { entry.op = 'update'; payload = value; entry.payloadKeys = keysOf(value); return q; },
      delete() { entry.op = 'delete'; return q; },
      then(resolve, reject) { return respond().then(resolve, reject); }
    };
    return q;
  }

  return {
    from: name => builder(name),
    calls,
    schema,
    rows: name => tableRows(name),
    writes: () => calls.filter(call => call.op !== 'select'),
    setFailMode: next => { mode = next; },
    /** Onko sarake(-joukko) kannassa? */
    hasColumns: (table, columns) => schema.has(table) && columns.every(column => schema.get(table).has(column))
  };
}

function keysOf(value) {
  const list = Array.isArray(value) ? value : [value];
  return [...new Set(list.flatMap(item => Object.keys(item || {})))];
}

/** Muistinvarainen Storage-korvike (localStorage-rajapinta). */
export function memoryStorage() {
  const map = new Map();
  return {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: key => { map.delete(key); },
    keys: () => [...map.keys()],
    size: () => map.size
  };
}

/**
 * Kannan tilat, joita matriisi käy läpi. Nimet kertovat mitä kannassa on,
 * eivät aaltoja (selainkoodi ei tunne aaltoja).
 */
export const DB_STATES = Object.freeze({
  '0008': { applied: migrationsThrough('0008') },
  '+0009': { applied: migrationsThrough('0009') },
  '+0010': { applied: migrationsThrough('0010') },
  '+0011': { applied: migrationsThrough('0011') },
  '+0012': { applied: migrationsThrough('0012') },
  '0008+0012': { applied: [...migrationsThrough('0008'), '0012'] },
  '+0013': { applied: migrationsThrough('0013') },
  '0013-ilman-operation_id': { applied: migrationsThrough('0013'), drop: { time_entries: ['operation_id'] } },
  '+0014': { applied: migrationsThrough('0014') }
});
