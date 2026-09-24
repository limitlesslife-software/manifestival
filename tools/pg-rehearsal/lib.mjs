// Paikallisen migraatioharjoittelun apufunktiot.
//
// EI KOSKAAN TUOTANTOON. connect() kieltäytyy kaikesta muusta kuin
// silmukkaosoitteesta (127.0.0.1 / localhost / ::1), ja jokainen
// harjoittelukanta luodaan etuliitteellä `mv_rehearsal_` ja poistetaan
// lopuksi.
//
// `pg`-ajuri EI ole projektin riippuvuus. Se ladataan hakemistosta,
// jonka ympäristömuuttuja PG_REHEARSAL_MODULES nimeää (oletus:
// <projekti>/.claude/pg-local/node_modules). Näin sovelluksen
// package.json ei muutu eikä selaimeen päädy mitään tästä.

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const modulesDir = process.env.PG_REHEARSAL_MODULES
  || join(ROOT, '.claude', 'pg-local', 'node_modules');
const require = createRequire(join(modulesDir, 'noop.js'));
const pg = require('pg');

export const PG_HOST = process.env.PG_REHEARSAL_HOST || '127.0.0.1';
export const PG_PORT = Number(process.env.PG_REHEARSAL_PORT || 54329);
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

if (!LOOPBACK.has(PG_HOST)) {
  throw new Error(`Harjoittelu ajetaan vain paikalliseen kantaan, ei osoitteeseen ${PG_HOST}.`);
}

/** Omistaja, jonka migraatiot 0001 ja 0012 kovakoodaavat. Synteettinen rivi. */
export const OWNER = '2cc00622-f927-4604-a518-361a4328481b';
/** Toinen synteettinen käyttäjä eristystestiä varten. */
export const USER_B = 'bbbbbbbb-0000-4000-8000-00000000000b';

export async function connect(database = 'postgres') {
  const client = new pg.Client({
    host: PG_HOST, port: PG_PORT, user: 'postgres', database
  });
  client.on('notice', () => {});
  await client.connect();
  return client;
}

export async function createDatabase(name) {
  if (!/^mv_rehearsal_[a-z0-9_]+$/.test(name)) throw new Error(`Kielletty kannan nimi ${name}`);
  const admin = await connect();
  try {
    await admin.query(`drop database if exists ${name} with (force)`);
    await admin.query(`create database ${name} template template0 encoding 'UTF8'`);
  } finally {
    await admin.end();
  }
}

export async function dropDatabase(name) {
  if (!/^mv_rehearsal_[a-z0-9_]+$/.test(name)) throw new Error(`Kielletty kannan nimi ${name}`);
  const admin = await connect();
  try {
    await admin.query(`drop database if exists ${name} with (force)`);
  } finally {
    await admin.end();
  }
}

export function readSql(relative) {
  return readFileSync(join(ROOT, relative), 'utf8');
}

/**
 * Aja SQL-tiedosto yhtenä simple-query-kutsuna — täsmälleen kuten
 * Supabasen SQL-editori: tiedoston omat begin/commit ratkaisevat
 * transaktiorajat. Virheen jälkeen istunto palautetaan siistiksi.
 */
export async function runSql(client, sql) {
  try {
    const result = await client.query(sql);
    return { ok: true, result };
  } catch (error) {
    try { await client.query('rollback'); } catch { /* ei avointa transaktiota */ }
    return { ok: false, error: { message: error.message, code: error.code } };
  }
}

/** Aja todennus ja palauta rivit. Viimeinen tulosjoukko on taulukko. */
export async function runVerify(client, relative) {
  const out = await runSql(client, readSql(relative));
  if (!out.ok) return { ok: false, error: out.error, rows: [] };
  const results = Array.isArray(out.result) ? out.result : [out.result];
  const last = [...results].reverse().find(r => r && Array.isArray(r.rows) && r.fields?.length);
  const rows = last ? last.rows : [];
  const failed = rows.filter(r => String(r.status || '').toUpperCase() === 'FAIL');
  return { ok: true, rows, failed };
}

/**
 * Suorita fn istunnossa, joka näyttää PostgRESTin pyynnöltä:
 * rooli `authenticated` ja JWT:n sub = userId. Transaktio perutaan tai
 * hyväksytään fn:n palautuksen mukaan; oletus hyväksyy.
 */
export async function asUser(client, userId, fn, { role = 'authenticated' } = {}) {
  await client.query('begin');
  try {
    const claims = JSON.stringify(userId ? { sub: userId, role } : { role });
    await client.query(`select set_config('request.jwt.claims', $1, true)`, [claims]);
    await client.query(`set local role ${role}`);
    const value = await fn();
    await client.query('commit');
    return value;
  } catch (error) {
    try { await client.query('rollback'); } catch { /* jo peruttu */ }
    throw error;
  }
}

/** Yritä kyselyä käyttäjänä; palauta {ok, rowCount, rows, code}. Ei heitä. */
export async function tryAs(client, userId, sql, params = [], opts = {}) {
  try {
    const res = await asUser(client, userId, () => client.query(sql, params), opts);
    return { ok: true, rowCount: res.rowCount, rows: res.rows };
  } catch (error) {
    return { ok: false, code: error.code, message: error.message };
  }
}

/**
 * Katalogin sormenjälki public-skeemasta: taulut, sarakkeet, rajoitteet,
 * indeksit, politiikat, liipaisimet, funktiot ja oikeudet. Kaksi samaa
 * sormenjälkeä = skeema ei muuttunut. Tällä todennetaan, että
 * epäonnistunut migraatio ei jättänyt puolivalmista tilaa.
 */
export async function catalogFingerprint(client) {
  const parts = await client.query(`
    select 'rel:' || c.relname || ':' || c.relkind::text || ':' || c.relrowsecurity::text
           || ':' || coalesce(array_to_string(c.relacl, ','), '') as item
      from pg_class c where c.relnamespace = 'public'::regnamespace
    union all
    select 'col:' || c.relname || '.' || a.attname || ':' || format_type(a.atttypid, a.atttypmod)
           || ':' || a.attnotnull::text || ':' || coalesce(pg_get_expr(d.adbin, d.adrelid), '')
      from pg_attribute a join pg_class c on c.oid = a.attrelid
      left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
     where c.relnamespace = 'public'::regnamespace and a.attnum > 0 and not a.attisdropped
    union all
    select 'con:' || conrelid::regclass::text || ':' || conname || ':' || pg_get_constraintdef(oid)
      from pg_constraint where connamespace = 'public'::regnamespace
    union all
    select 'pol:' || tablename || ':' || policyname || ':' || cmd::text || ':'
           || coalesce(qual, '') || ':' || coalesce(with_check, '') || ':' || array_to_string(roles::text[], ',')
      from pg_policies where schemaname = 'public'
    union all
    select 'trg:' || tgrelid::regclass::text || ':' || tgname
      from pg_trigger t join pg_class c on c.oid = t.tgrelid
     where c.relnamespace = 'public'::regnamespace and not t.tgisinternal
    union all
    select 'fn:' || p.proname || ':' || md5(p.prosrc) || ':' || p.prosecdef::text
      from pg_proc p where p.pronamespace = 'public'::regnamespace
    order by 1`);
  const text = parts.rows.map(r => r.item).join('\n');
  return { hash: createHash('sha256').update(text).digest('hex'), count: parts.rows.length };
}

export async function scalar(client, sql, params = []) {
  const res = await client.query(sql, params);
  const row = res.rows[0];
  return row ? Object.values(row)[0] : null;
}
