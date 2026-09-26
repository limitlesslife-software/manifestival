// Paikallisen migraatioharjoittelun apufunktiot.
//
// EI KOSKAAN TUOTANTOON. connect() kieltäytyy kaikesta muusta kuin
// silmukkaosoitteesta (127.0.0.1 / localhost / ::1), ja jokainen
// harjoittelukanta luodaan etuliitteellä `mv_rehearsal_` ja poistetaan
// lopuksi.
//
// OMA KLUSTERI, EI MIKÄ TAHANSA PALVELIN. Silmukkaosoite ei riitä:
// 2026-09-26 portissa 54329 vastasi toisen projektin PostgreSQL 15.
// Siksi jokainen yhteys tarkistaa ensin assertRehearsalServer():llä,
// että palvelin on vähintään PostgreSQL 17 ja sen data-hakemisto on
// projektin omassa .claude/pg-local-hakemistossa. Ohitus vain
// nimenomaisesti: PG_REHEARSAL_ALLOW_FOREIGN=1. Porttiin 54329
// (FOREIGN_PORT) ei yhdistetä lainkaan. Varmuuskopioharjoittelu
// (guardBackupRehearsal) on tiukempi: portti annettava nimenomaisesti,
// eikä ohitusta ole.
//
// `pg`-ajuri EI ole projektin riippuvuus. Se ladataan LAISKASTI
// hakemistosta, jonka ympäristömuuttuja PG_REHEARSAL_MODULES nimeää
// (oletus: <projekti>/.claude/pg-local/node_modules). Moduulin
// importointi ei siis avaa yhteyttä eikä edes lataa ajuria — puhtaat
// apufunktiot (diffCatalog, compareDigests, extractRollback) ovat
// yksikkötestattavissa ilman palvelinta.

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Projektin pääkansio myös git-worktreestä ajettaessa: worktree on
 * <projekti>/.claude/worktrees/<nimi>, mutta PostgreSQL-binäärit ja
 * pg-ajuri ovat vain pääkansion .claude/pg-local-hakemistossa.
 */
export function projectRoot(root = ROOT) {
  const m = /^(.*?)[\\/]\.claude[\\/]worktrees[\\/][^\\/]+[\\/]?$/.exec(root);
  return m ? m[1] : root;
}

export const PG_LOCAL = process.env.PG_REHEARSAL_PGLOCAL || join(projectRoot(), '.claude', 'pg-local');

export const PG_HOST = process.env.PG_REHEARSAL_HOST || '127.0.0.1';
/**
 * Oletusportti 54349. Vanha oletus 54329 oli 2026-09-26 toisen projektin
 * PostgreSQL 15:n käytössä; harvinaisempi portti vähentää sekaannusta,
 * ja assertRehearsalServer estää sen joka tapauksessa.
 */
export const PG_PORT = Number(process.env.PG_REHEARSAL_PORT || 54349);
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

if (!LOOPBACK.has(PG_HOST)) {
  throw new Error(`Harjoittelu ajetaan vain paikalliseen kantaan, ei osoitteeseen ${PG_HOST}.`);
}

/** Omistaja, jonka migraatiot 0001 ja 0012 kovakoodaavat. Synteettinen rivi. */
export const OWNER = '2cc00622-f927-4604-a518-361a4328481b';
/** Toinen synteettinen käyttäjä eristystestiä varten. */
export const USER_B = 'bbbbbbbb-0000-4000-8000-00000000000b';

let pgModule = null;
function pg() {
  if (!pgModule) {
    const modulesDir = process.env.PG_REHEARSAL_MODULES || join(PG_LOCAL, 'node_modules');
    const require = createRequire(join(modulesDir, 'noop.js'));
    pgModule = require('pg');
  }
  return pgModule;
}

/** Normalisoi Windows-polun vertailukelpoiseksi: / ja pienaakkoset. */
export function normalizeDir(dir) {
  return String(dir || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/**
 * Puhdas päätös: saako tätä palvelinta käyttää harjoitteluun?
 * Palauttaa null (kelpaa) tai virheilmoituksen.
 */
export function rehearsalServerProblem({ versionNum, dataDirectory }, {
  pgLocal = PG_LOCAL, allowForeign = process.env.PG_REHEARSAL_ALLOW_FOREIGN === '1'
} = {}) {
  if (!(Number(versionNum) >= 170000)) {
    return `Palvelin on versiota ${versionNum}; harjoittelu vaatii PostgreSQL 17:n (tuotanto 17.6).`;
  }
  if (allowForeign) return null;
  const dir = normalizeDir(dataDirectory);
  const base = normalizeDir(pgLocal);
  if (!dir || !dir.startsWith(`${base}/`)) {
    return `Palvelimen data-hakemisto ${dataDirectory} ei ole projektin harjoitteluklusteri (${pgLocal}/...). `
      + 'Väärä palvelin? Ohitus vain tarkoituksella: PG_REHEARSAL_ALLOW_FOREIGN=1.';
  }
  return null;
}

/**
 * Portti, johon EI KOSKAAN oteta yhteyttä: 2026-09-26 siinä vastasi toisen
 * projektin PostgreSQL 15. connect() kieltäytyy siitä ennen yhteyttä.
 */
export const FOREIGN_PORT = 54329;

/**
 * Puhdas päätös ennen yhteyttä (varmuuskopioharjoittelu): portti on
 * annettu NIMENOMAISESTI (PG_REHEARSAL_PORT) eikä se ole FOREIGN_PORT.
 * Palauttaa null (kelpaa) tai virheilmoituksen.
 */
export function rehearsalPortProblem(env = process.env) {
  const raw = env.PG_REHEARSAL_PORT;
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return 'PG_REHEARSAL_PORT puuttuu: anna oman harjoitteluklusterin portti nimenomaisesti '
      + '(README: 54349). Oletusporttiin ei yhdistetä.';
  }
  const text = String(raw).trim();
  if (!/^\d{1,5}$/.test(text) || Number(text) < 1 || Number(text) > 65535) return `PG_REHEARSAL_PORT=${raw} ei ole portti.`;
  if (Number(text) === FOREIGN_PORT) {
    return `PG_REHEARSAL_PORT=${FOREIGN_PORT} kuuluu toisen projektin PostgreSQL 15:lle (2026-09-26): ei yhteyttä.`;
  }
  return null;
}

/**
 * Projektin PÄÄKANSIO (ei worktree): git rev-parse --git-common-dir
 * osoittaa pääkansion .git-hakemistoon myös worktreestä ajettaessa.
 * Jos git ei vastaa, polkulogiikka (projectRoot). `gitCommonDir` on
 * testejä varten ('' = ei gitiä).
 */
export function mainProjectRoot({ root = ROOT, gitCommonDir = null } = {}) {
  let common = gitCommonDir;
  if (common === null) {
    try {
      common = execFileSync('git', ['-C', root, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch { common = ''; }
  }
  const trimmed = String(common || '').replace(/[\\/]+$/, '');
  if (trimmed && /[\\/]\.git$/.test(trimmed)) return trimmed.replace(/[\\/]\.git$/, '');
  return projectRoot(root);
}

/**
 * Tiukka palvelinpäätös (varmuuskopioharjoittelu): PostgreSQL >= 17 ja
 * data-hakemisto pääkansion .claude/pg-local/-hakemistossa. Ei ohitusta
 * (PG_REHEARSAL_ALLOW_FOREIGN) eikä toista pg-local-polkua
 * (PG_REHEARSAL_PGLOCAL).
 */
export function strictRehearsalServerProblem({ versionNum, dataDirectory }, { mainRoot = mainProjectRoot() } = {}) {
  return rehearsalServerProblem({ versionNum, dataDirectory },
    { pgLocal: join(mainRoot, '.claude', 'pg-local'), allowForeign: false });
}

/**
 * Varmuuskopioharjoittelun vahti: kutsutaan ENNEN yhtäkään kannan tai
 * roolin luontia. 1) portti nimenomaisesti ja ei 54329 — ennen yhteyttä;
 * 2) yhteys, jonka jälkeen tiukka palvelintarkistus (versio >= 170000,
 * data_directory pääkansion .claude/pg-local/-hakemistossa, palvelimen
 * oma portti = pyydetty). Heittää virheen; muuten palauttaa palvelimen
 * tiedot. `connectFn` ja `env` injektoidaan testeissä (ei kantaa).
 */
export async function guardBackupRehearsal({ env = process.env, connectFn = () => connect(), mainRoot = null } = {}) {
  const portProblem = rehearsalPortProblem(env);
  if (portProblem) throw new Error(`KESKEYTYS ennen yhteyttä: ${portProblem}`);
  const client = await connectFn();
  try {
    const res = await client.query(
      `select current_setting('server_version_num') as num, current_setting('server_version') as ver,
              current_setting('data_directory') as dir, current_setting('port') as port, version() as full`);
    const { num, ver, dir, port, full } = res.rows[0] || {};
    const problem = strictRehearsalServerProblem({ versionNum: num, dataDirectory: dir },
      { mainRoot: mainRoot ?? mainProjectRoot() });
    if (problem) throw new Error(`KESKEYTYS: ${problem}`);
    if (Number(port) !== Number(String(env.PG_REHEARSAL_PORT).trim())) {
      throw new Error(`KESKEYTYS: palvelin kertoo portikseen ${port}, pyydettiin ${env.PG_REHEARSAL_PORT}.`);
    }
    return { versionNum: Number(num), version: ver, versionString: full ?? null, dataDirectory: dir, port: Number(port) };
  } finally {
    await client.end();
  }
}

/** Palvelin, joka on todennettu tässä prosessissa (raportin alkuperätieto). */
export const SERVER = { verified: false, version: null, versionNum: null, dataDirectory: null, port: PG_PORT };

/**
 * Varmista, että yhteys osui omaan PostgreSQL 17 -klusteriin. Kutsutaan
 * connect():ssa ENNEN kuin mitään luodaan tai poistetaan.
 */
export async function assertRehearsalServer(client) {
  const res = await client.query(
    `select current_setting('server_version_num') as num, current_setting('server_version') as ver,
            current_setting('data_directory') as dir`);
  const { num, ver, dir } = res.rows[0];
  const problem = rehearsalServerProblem({ versionNum: num, dataDirectory: dir });
  if (problem) throw new Error(`KESKEYTYS: ${problem}`);
  Object.assign(SERVER, { verified: true, version: ver, versionNum: Number(num), dataDirectory: dir });
  return SERVER;
}

/**
 * Avaa yhteys. Superuser-yhteys (oletus) todentaa palvelimen joka kerta.
 * Muu rooli (role:nonsuper) ei voi lukea data_directorya, joten se
 * sallitaan vain, kun sama prosessi on jo todentanut palvelimen.
 */
export async function connect(database = 'postgres', { user = 'postgres' } = {}) {
  if (PG_PORT === FOREIGN_PORT) {
    throw new Error(`KESKEYTYS: portti ${FOREIGN_PORT} kuuluu toisen projektin PostgreSQL 15:lle; ei yhteyttä (PG_REHEARSAL_PORT).`);
  }
  if (user !== 'postgres' && !SERVER.verified) {
    throw new Error('Palvelinta ei ole todennettu superuser-yhteydellä ennen roolin yhteyttä.');
  }
  const client = new (pg().Client)({ host: PG_HOST, port: PG_PORT, user, database });
  client.notices = [];
  client.on('notice', n => { client.notices.push(n.message); });
  await client.connect();
  if (user === 'postgres') {
    try {
      await assertRehearsalServer(client);
    } catch (error) {
      await client.end().catch(() => {});
      throw error;
    }
  }
  return client;
}

const DB_NAME = /^mv_rehearsal_[a-z0-9_]+$/;

/**
 * Luo kertakäyttöinen kanta. `template` = toinen mv_rehearsal_*-kanta,
 * josta kloonataan (tuotannon muotoinen lähtötila rakennetaan kerran).
 */
export async function createDatabase(name, { template = null } = {}) {
  if (!DB_NAME.test(name)) throw new Error(`Kielletty kannan nimi ${name}`);
  if (template !== null && !DB_NAME.test(template)) throw new Error(`Kielletty mallikanta ${template}`);
  const admin = await connect();
  try {
    await admin.query(`drop database if exists ${name} with (force)`);
    await admin.query(template
      ? `create database ${name} template ${template}`
      : `create database ${name} template template0 encoding 'UTF8'`);
  } finally {
    await admin.end();
  }
}

export async function dropDatabase(name) {
  if (!DB_NAME.test(name)) throw new Error(`Kielletty kannan nimi ${name}`);
  const admin = await connect();
  try {
    await admin.query(`drop database if exists ${name} with (force)`);
  } finally {
    await admin.end();
  }
}

/** Tiedostot, jotka tämä prosessi on lukenut (raportin blob-tiivisteet). */
export const READ_FILES = new Set();

/** Kirjaa tiedosto alkuperätietoon lukematta sitä (esim. importatut moduulit). */
export function noteRead(relative) {
  READ_FILES.add(relative.replace(/\\/g, '/'));
}

export function readSql(relative) {
  noteRead(relative);
  return readFileSync(join(ROOT, relative), 'utf8');
}

/**
 * Alkuperätieto raporttiin: git HEAD, onko työpuu muuttunut, ja jokaisen
 * luetun tiedoston git-blob-tiiviste (`git hash-object` = sama kuin
 * `git rev-parse HEAD:<polku>`, kun tiedosto on commitoitu). Näin raportin
 * tulos on sidottu täsmälleen niihin SQL-tiedostoihin, jotka ajettiin.
 */
export function provenance(files = [...READ_FILES]) {
  const git = (...args) => {
    try {
      return execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch { return null; }
  };
  const blobs = {};
  for (const file of [...files].sort()) blobs[file] = git('hash-object', '--', file);
  const status = git('status', '--porcelain', '--', ...[...files].sort());
  return { head: git('rev-parse', 'HEAD'), branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
           uncommittedReadFiles: status ? status.split('\n').filter(Boolean) : [], blobs };
}

/**
 * Aja SQL-tiedosto yhtenä simple-query-kutsuna — täsmälleen kuten
 * Supabasen SQL-editori: tiedoston omat begin/commit ratkaisevat
 * transaktiorajat. Virheen jälkeen istunto palautetaan siistiksi,
 * paitsi kun `keepAborted` (keskeytyneen istunnon lukkotesti).
 */
export async function runSql(client, sql, { keepAborted = false } = {}) {
  try {
    const result = await client.query(sql);
    return { ok: true, result };
  } catch (error) {
    if (!keepAborted) {
      try { await client.query('rollback'); } catch { /* ei avointa transaktiota */ }
    }
    return { ok: false, error: { message: error.message, code: error.code } };
  }
}

/**
 * Aja todennus ja palauta rivit. Viimeinen tulosjoukko on taulukko.
 *
 * RISTIINTARKISTUS: operaattorin pysäytysluku on `poikkeavia_yhteensa`,
 * harjoittelu laskee FAIL-rivit. Niiden on oltava sama luku — muuten
 * NULL-tulos näkyisi FAIL-rivinä mutta ei pysäytysluvussa.
 * `countMismatch` = true, jos ne eroavat.
 */
export async function runVerify(client, relative) {
  const out = await runSql(client, readSql(relative));
  if (!out.ok) return { ok: false, error: out.error, rows: [], failed: [] };
  const results = Array.isArray(out.result) ? out.result : [out.result];
  const last = [...results].reverse().find(r => r && Array.isArray(r.rows) && r.fields?.length);
  const rows = last ? last.rows : [];
  const failed = rows.filter(r => String(r.status || '').toUpperCase() === 'FAIL');
  const hasCount = rows.length > 0 && 'poikkeavia_yhteensa' in rows[0];
  const poikkeavia = hasCount ? Number(rows[0].poikkeavia_yhteensa) : null;
  const countMismatch = hasCount && poikkeavia !== failed.length;
  return { ok: true, rows, failed, poikkeavia, countMismatch };
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

const IDENT = /^[a-z_][a-z0-9_]*$/;
const q = name => {
  if (!IDENT.test(name)) throw new Error(`Kielletty tunniste ${name}`);
  return `"${name}"`;
};

/**
 * Sovelluksen lähettämä JSON sellaisenaan: supabase-js sarjallistaa
 * rungon JSON.stringifyllä, joten undefined-kentät PUDOTETAAN eivätkä
 * ne ole nulleja (kanta käyttää silloin oletusarvoa).
 */
export function wirePayload(row) {
  return JSON.parse(JSON.stringify(row));
}

/**
 * PostgREST-kirjoituksen jäljitelmä. Lause on samaa muotoa kuin
 * PostgREST 12 tuottaa: runko puretaan json_populate_recordsetillä
 * taulun rivityyppiin, ja vain rungon avaimet kirjoitetaan.
 *
 *   insert  insert into t (a, b) select a, b from json_populate_recordset(null::t, $1)
 *   update  update t set a = b.a ... from (json_populate_record) b where <match>
 *   upsert  insert ... on conflict (onConflict) do update set a = excluded.a ...
 *
 * Ajetaan asUser():lla roolina authenticated (RLS voimassa).
 * Palauttaa {ok, rowCount, code, message}; ei heitä.
 */
export function postgrestSql(table, payload, { method = 'insert', onConflict = 'id', match = {} } = {}) {
  const t = `public.${q(table)}`;
  if (method === 'delete') {
    const keys = Object.keys(match);
    if (!keys.length) throw new Error(`${table}: delete ilman suodatinta`);
    return { sql: `delete from ${t} where ${keys.map((k, i) => `${t}.${q(k)} = $${i + 1}`).join(' and ')}`,
             params: keys.map(k => match[k]) };
  }
  const body = wirePayload(payload);
  const cols = Object.keys(body);
  if (!cols.length) throw new Error(`${table}: tyhjä runko`);
  const list = cols.map(q).join(', ');
  if (method === 'insert' || method === 'upsert') {
    let sql = `insert into ${t} (${list}) select ${list} from json_populate_recordset(null::${t}, $1::json)`;
    if (method === 'upsert') {
      const target = String(onConflict).split(',').map(s => q(s.trim())).join(', ');
      sql += ` on conflict (${target}) do update set ${cols.map(c => `${q(c)} = excluded.${q(c)}`).join(', ')}`;
    }
    return { sql, params: [JSON.stringify([body])] };
  }
  if (method === 'update') {
    const keys = Object.keys(match);
    if (!keys.length) throw new Error(`${table}: update ilman suodatinta`);
    const where = keys.map((k, i) => `${t}.${q(k)} = $${i + 2}`).join(' and ');
    const sql = `update ${t} set ${cols.map(c => `${q(c)} = pgrst_body.${q(c)}`).join(', ')}`
      + ` from (select * from json_populate_record(null::${t}, $1::json)) pgrst_body where ${where}`;
    return { sql, params: [JSON.stringify(body), ...keys.map(k => match[k])] };
  }
  throw new Error(`Tuntematon metodi ${method}`);
}

export async function postgrestWrite(client, userId, table, payload, opts = {}) {
  const { sql, params } = postgrestSql(table, payload, opts);
  return tryAs(client, userId, sql, params);
}

/**
 * Katalogin rivit public-skeemasta, yksi rivi per objekti, deterministisesti
 * järjestettynä. Kattaa: taulut (RLS, FORCE RLS, omistaja, ACL), sarakkeet
 * (tyyppi, NOT NULL, oletus, identity/generated, sarake-ACL), indeksit
 * (pg_get_indexdef), rajoitteet (pg_get_constraintdef), politiikat
 * (permissive, komento, ehdot, roolit), liipaisimet (pg_get_triggerdef +
 * enabled), funktiot (lähteen tiiviste, SECURITY DEFINER, proconfig eli
 * search_path, ACL, omistaja) ja skeeman omistaja/ACL.
 */
export async function catalogItems(client) {
  const res = await client.query(`
    select 'rel:' || c.relname || ':' || c.relkind::text || ':rls=' || c.relrowsecurity::text
           || ':force=' || c.relforcerowsecurity::text || ':owner=' || c.relowner::regrole::text
           || ':acl=' || coalesce(array_to_string(c.relacl, ','), '') as item
      from pg_class c where c.relnamespace = 'public'::regnamespace
    union all
    select 'col:' || c.relname || '.' || a.attname || ':' || format_type(a.atttypid, a.atttypmod)
           || ':notnull=' || a.attnotnull::text || ':default=' || coalesce(pg_get_expr(d.adbin, d.adrelid), '')
           || ':identity=' || a.attidentity::text || ':generated=' || a.attgenerated::text
           || ':acl=' || coalesce(array_to_string(a.attacl, ','), '')
      from pg_attribute a join pg_class c on c.oid = a.attrelid
      left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
     where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'f')
       and a.attnum > 0 and not a.attisdropped
    union all
    select 'idx:' || ic.relname || ':' || pg_get_indexdef(i.indexrelid)
      from pg_index i join pg_class ic on ic.oid = i.indexrelid
     where ic.relnamespace = 'public'::regnamespace
    union all
    select 'con:' || conrelid::regclass::text || ':' || conname || ':' || pg_get_constraintdef(oid)
           || ':validated=' || convalidated::text
      from pg_constraint where connamespace = 'public'::regnamespace
    union all
    select 'pol:' || tablename || ':' || policyname || ':' || permissive || ':' || cmd::text || ':'
           || coalesce(qual, '') || ':' || coalesce(with_check, '') || ':' || array_to_string(roles::text[], ',')
      from pg_policies where schemaname = 'public'
    union all
    select 'trg:' || t.tgrelid::regclass::text || ':' || t.tgname || ':enabled=' || t.tgenabled::text
           || ':' || pg_get_triggerdef(t.oid)
      from pg_trigger t join pg_class c on c.oid = t.tgrelid
     where c.relnamespace = 'public'::regnamespace and not t.tgisinternal
    union all
    select 'fn:' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || '):src=' || md5(p.prosrc)
           || ':secdef=' || p.prosecdef::text || ':config=' || coalesce(array_to_string(p.proconfig, ','), '')
           || ':owner=' || p.proowner::regrole::text || ':acl=' || coalesce(array_to_string(p.proacl, ','), '')
      from pg_proc p where p.pronamespace = 'public'::regnamespace
    union all
    select 'nsp:public:owner=' || n.nspowner::regrole::text || ':acl=' || coalesce(array_to_string(n.nspacl, ','), '')
      from pg_namespace n where n.nspname = 'public'`);
  return res.rows.map(r => r.item).sort();
}

/**
 * Katalogin sormenjälki: sha256 catalogItems-riveistä. Kaksi samaa
 * sormenjälkeä = skeema ei muuttunut. Tällä todennetaan, että
 * epäonnistunut migraatio ei jättänyt puolivalmista tilaa.
 */
export async function catalogFingerprint(client) {
  const items = await catalogItems(client);
  return { hash: createHash('sha256').update(items.join('\n')).digest('hex'), count: items.length, items };
}

/** Puhdas: katalogirivien ero. Palauttaa lajitellut {added, removed}. */
export function diffCatalog(before, after) {
  const b = new Set(before);
  const a = new Set(after);
  return {
    added: [...a].filter(x => !b.has(x)).sort(),
    removed: [...b].filter(x => !a.has(x)).sort()
  };
}

/** Skeemaeron tekstimuoto (kultainen tiedosto): + lisätty, - poistettu. */
export function formatSchemaDiff(diff) {
  return [...diff.removed.map(x => `- ${x}`), ...diff.added.map(x => `+ ${x}`)].join('\n') + '\n';
}

/** Taulun sarakkeet järjestyksessä. */
export async function tableColumns(client, table, schema = 'public') {
  const res = await client.query(
    `select column_name from information_schema.columns
      where table_schema = $1 and table_name = $2 order by ordinal_position`, [schema, table]);
  return res.rows.map(r => r.column_name);
}

/**
 * Rivien tiivisteet: id -> {h, xmin}. h = md5 rivin jsonb-esityksestä
 * RAJATTUNA annettuihin sarakkeisiin (sarakkeet ennen migraatiota), joten
 * uuden sarakkeen lisäys ei muuta tiivistettä mutta minkä tahansa vanhan
 * arvon muutos muuttaa. xmin muuttuu, jos riviä on päivitetty (UPDATE
 * kirjoittaa uuden rivin version), vaikka arvo olisi sama.
 */
export async function rowDigests(client, table, keepColumns) {
  const res = await client.query(
    `select t.id::text as id, t.xmin::text as xmin,
            md5(coalesce((select jsonb_object_agg(k, v order by k) from jsonb_each(to_jsonb(t)) e(k, v)
                           where k = any($1::text[]))::text, '')) as h
       from public.${q(table)} t order by 1`, [keepColumns]);
  return new Map(res.rows.map(r => [r.id, { h: r.h, xmin: r.xmin }]));
}

/** Taulun tiedostosolmu: muuttuu, jos taulu kirjoitetaan uudelleen. */
export async function relFilenode(client, table) {
  return Number(await scalar(client, 'select pg_relation_filenode($1::regclass)', [`public.${table}`]));
}

/**
 * Puhdas: kahden rowDigests-kartan ero. added/removed = id:t, changed =
 * arvo muuttui (rajatuissa sarakkeissa), xminChanged = rivi kirjoitettiin
 * uudelleen (myös ilman arvomuutosta).
 */
export function compareDigests(before, after) {
  const out = { added: [], removed: [], changed: [], xminChanged: [] };
  for (const [id, b] of before) {
    const a = after.get(id);
    if (!a) { out.removed.push(id); continue; }
    if (a.h !== b.h) out.changed.push(id);
    if (a.xmin !== b.xmin) out.xminChanged.push(id);
  }
  for (const id of after.keys()) if (!before.has(id)) out.added.push(id);
  for (const k of Object.keys(out)) out[k].sort();
  return out;
}

/** Onko ero tyhjä (ei lisättyjä, poistettuja, muuttuneita eikä uudelleenkirjoitettuja)? */
export function digestsIdentical(diff) {
  return !diff.added.length && !diff.removed.length && !diff.changed.length && !diff.xminChanged.length;
}

/** Poimi migraation kommentoitu ROLLBACK-lohko (begin; ... commit;). */
export function extractRollback(sql) {
  const lines = sql.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex(l => /^-- ROLLBACK\s*$/.test(l));
  if (start === -1) return null;
  const out = [];
  let inside = false;
  for (const line of lines.slice(start + 1)) {
    const m = /^--   (.*)$/.exec(line);
    const body = m ? m[1] : null;
    if (!inside && body && /^begin;\s*$/.test(body.trim())) inside = true;
    if (inside && body !== null) out.push(body);
    if (inside && body && /^commit;\s*$/.test(body.trim())) break;
  }
  return out.length ? out.join('\n') : null;
}

/**
 * ROLLBACK-osion vain lukeva ennakkokysely: `--   `-rivit otsikon ja
 * `begin;`-rivin välissä (0013: montako kirjausta menettää kohteensa).
 */
export function extractPreRollback(sql) {
  const lines = sql.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex(l => /^-- ROLLBACK\s*$/.test(l));
  if (start === -1) return null;
  const out = [];
  for (const line of lines.slice(start + 1)) {
    const m = /^--   (.*)$/.exec(line);
    if (!m) continue;
    if (/^begin;\s*$/.test(m[1].trim())) break;
    out.push(m[1]);
  }
  return out.length ? out.join('\n') : null;
}

/**
 * Peruutuksen kuiva-ajo: sama lohko, mutta lopun commit korvataan
 * rollbackilla. DDL on PostgreSQL:ssä transaktionaalista, joten tämä
 * kertoo menisikö peruutus läpi muuttamatta mitään.
 */
export function dryRunRollback(rollbackSql) {
  return rollbackSql.replace(/commit;\s*$/, 'rollback;');
}

export async function scalar(client, sql, params = []) {
  const res = await client.query(sql, params);
  const row = res.rows[0];
  return row ? Object.values(row)[0] : null;
}

/** Onko tämä moduuli komentorivin pääohjelma (ei importti)? */
export function isMain(metaUrl) {
  return Boolean(process.argv[1]) && metaUrl === pathToFileURL(resolve(process.argv[1])).href;
}
