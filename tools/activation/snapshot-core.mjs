// Looginen tilannekuva ja sen palautus — puhdas ydin (ei tiedostoja, ei
// verkkoa, ei kantaa). Käyttäjät:
//
//   tools/activation/build-snapshots.mjs   supabase/backup/snapshot_state_00NN.sql
//   tools/activation/restore-snapshot.mjs  check / compare / restore
//   tools/pg-rehearsal/backup-scenario.mjs harjoittelu oikealla PostgreSQL:llä
//
// MIKSI NÄIN (docs/activation/0010-BACKUP-AND-RECOVERY.md)
//
// Supabasen oma varmuuskopio riippuu tilauksesta, eikä sitä voi ottaa
// pyynnöstä. Tämä on suunnitelmasta riippumaton, rivitasoinen kopio, jonka
// omistaja ottaa SQL-editorissa yhdellä vain lukevalla SELECTillä ja joka
// palautetaan yhdellä itsensä tarkistavalla transaktiolla.
//
// Harjoittelussa löydetyt ansat, joiden takia säännöt ovat tällaiset:
//
//   1. JSON.parse + stringify pudottaa numericin tarkkuuden (82.40 -> 82.4).
//      Siksi palautukseen upotetaan tiivisteellä todennettu RAAKA teksti
//      sellaisenaan, eikä sitä koskaan sarjallisteta uudelleen.
//   2. touch_updated_at-liipaisimet ylikirjoittavat updated_at:n. Siksi
//      palautus ajaa `disable trigger user` transaktion sisällä.
//   3. goals.project_id <-> projects.goal_id ja goals.parent_goal_id ovat
//      kehäviittauksia, eikä yksikään vierasavain ole DEFERRABLE. Siksi
//      kaksivaiheinen järjestys: ensin rivit ilman nullable-viittauksia,
//      sitten viittaukset.
//   4. query_to_xml on VOLATILE: dynaaminen monen taulun luku lukisi joka
//      taulun eri hetkellä. Siksi taululista on staattinen ja kaikki
//      luetaan YHDESSÄ lauseessa (yksi MVCC-tilannekuva).
//   5. timestamptz:n JSON-muoto riippuu istunnon aikavyöhykkeestä. Siksi
//      manifesti kirjaa vyöhykkeen ja palautus asettaa saman.
//   6. RLS suodattaa HILJAA: rooli, joka ei ohita rivitason suojausta
//      (ei superuser, ei BYPASSRLS, eikä taulun omistaja tai FORCE RLS
//      päällä), näkee vain osan riveistä — ja tiivisteet, rivimäärät ja
//      viite-eheys täsmäävät silti. Siksi manifesti kirjaa taulukohtaisesti
//      `rlsFiltered`, ja `check` hylkää suodatetun kuvan (rlsFilterProblems).

import { createHash } from 'node:crypto';

export const FORMAT = 'mv-snapshot-v1';
/** Hyväksytty omistaja; sama kuin migraatioissa 0001 ja 0010–0013. */
export const OWNER = '2cc00622-f927-4604-a518-361a4328481b';
/** Tilat, joille tilannekuvatiedosto generoidaan. */
export const SNAPSHOT_STATES = Object.freeze(['0008', '0009', '0010', '0011', '0012', '0013']);
/** Taulut, jotka ovat olleet olemassa ennen 0001:tä (docs/SCHEMA.md). */
export const BASE_TABLES = Object.freeze(['tasks', 'profile']);

export const md5 = text => createHash('md5').update(String(text), 'utf8').digest('hex');

const IDENT = /^[a-z_][a-z0-9_]*$/;
function ident(name) {
  if (!IDENT.test(String(name))) throw new Error(`kelvoton tunniste: ${name}`);
  return name;
}
const lit = value => `'${String(value).replace(/'/g, "''")}'`;
/** Sarakkeen nimi lainausmerkeissä: tasks.date / tasks.time ovat avainsanoja. */
const col = name => `"${ident(name)}"`;
const pad2 = n => String(n).padStart(2, '0');

// ---------------------------------------------------------------------
// Taululista
// ---------------------------------------------------------------------

/**
 * Tilan 00NN taulut: tasks, profile + jokainen `create table public.X`
 * migraatioissa <= NN. `migrations` = [{ name: '0003_routines', sql }].
 */
export function tablesAtState(state, migrations) {
  if (!/^\d{4}$/.test(String(state))) throw new Error(`kelvoton tila ${state}`);
  const out = [...BASE_TABLES];
  for (const { name, sql } of [...migrations].sort((a, b) => a.name.localeCompare(b.name))) {
    if (name.slice(0, 4) > state) continue;
    for (const m of String(sql).replace(/\r\n/g, '\n').matchAll(/^create table public\.(\w+)/gm)) {
      if (!out.includes(m[1])) out.push(m[1]);
    }
  }
  return out.map(ident);
}

// ---------------------------------------------------------------------
// Tilannekuva: YKSI vain lukeva SELECT
// ---------------------------------------------------------------------

/** Pelkkä lause (ilman otsikkoa). Tiedoston otsikon tekee build-snapshots.mjs. */
export function buildSnapshotStatement(state, tables) {
  if (!tables.length) throw new Error('taululista on tyhjä');
  tables.forEach(ident);
  const sorted = [...tables].sort();
  const dump = sorted.map(t => `  select ${lit(t)}::text as t, count(*)::bigint as n,
         coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text), '[]'::jsonb)::text as payload
    from public.${t} x`).join('\n  union all\n');
  const list = sorted.map(lit).join(', ');
  return `with
dump as (
${dump}
),
tabs as (
  select c.oid as reloid, c.relname::text as t, c.relowner, c.relrowsecurity, c.relforcerowsecurity
    from pg_class c
   where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
     and c.relname in (${list})
),
cols as (
  select a.attrelid as reloid,
         jsonb_agg(jsonb_build_array(a.attname::text, format_type(a.atttypid, a.atttypmod),
                                     a.attnotnull, a.attgenerated <> '') order by a.attnum) as cols
    from pg_attribute a join tabs tb on tb.reloid = a.attrelid
   where a.attnum > 0 and not a.attisdropped
   group by a.attrelid
),
keys as (
  select con.conrelid as reloid, con.contype::text as kind, con.conname::text as name,
         (select n.nspname::text || '.' || rc.relname::text
            from pg_class rc join pg_namespace n on n.oid = rc.relnamespace
           where rc.oid = con.confrelid) as ref,
         (select jsonb_agg(a.attname::text order by k.ord)
            from unnest(con.conkey) with ordinality k(attnum, ord)
            join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum) as cols,
         (select jsonb_agg(a.attname::text order by k.ord)
            from unnest(con.confkey) with ordinality k(attnum, ord)
            join pg_attribute a on a.attrelid = con.confrelid and a.attnum = k.attnum) as refcols
    from pg_constraint con join tabs tb on tb.reloid = con.conrelid
   where con.contype in ('p', 'f')
),
trg as (
  select tg.tgrelid as reloid, jsonb_agg(tg.tgname::text order by tg.tgname) as names
    from pg_trigger tg join tabs tb on tb.reloid = tg.tgrelid
   where not tg.tgisinternal
   group by tg.tgrelid
),
manifest as (
  select jsonb_build_object(
    'format', ${lit(FORMAT)},
    'state', ${lit(state)},
    'db', current_database(),
    'server', current_setting('server_version'),
    'at', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'timezone', current_setting('TimeZone'),
    'role', current_user,
    'superuser', (select r.rolsuper from pg_roles r where r.rolname = current_user),
    'bypassrls', (select r.rolbypassrls from pg_roles r where r.rolname = current_user),
    'owner', ${lit(OWNER)},
    'ownerPresent', exists (select 1 from auth.users u where u.id = ${lit(OWNER)}::uuid),
    'authUsers', (select count(*) from auth.users),
    'publicTables', (select coalesce(jsonb_agg(c.relname::text order by c.relname), '[]'::jsonb)
                       from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'),
    'tables', (select jsonb_object_agg(d.t, jsonb_build_object(
        'rows', d.n, 'md5', md5(d.payload), 'bytes', octet_length(d.payload),
        'cols', c.cols,
        'pk', (select k.cols from keys k where k.reloid = tb.reloid and k.kind = 'p'),
        'fks', coalesce((select jsonb_agg(jsonb_build_object('name', k.name, 'ref', k.ref,
                                                             'cols', k.cols, 'refCols', k.refcols) order by k.name)
                           from keys k where k.reloid = tb.reloid and k.kind = 'f'), '[]'::jsonb),
        'triggers', coalesce(tr.names, '[]'::jsonb),
        'tableOwner', pg_get_userbyid(tb.relowner),
        'rls', tb.relrowsecurity, 'forceRls', tb.relforcerowsecurity,
        'rlsFiltered', (tb.relrowsecurity
                        and not coalesce((select r.rolsuper or r.rolbypassrls from pg_roles r
                                           where r.rolname = current_user), false)
                        and (tb.relforcerowsecurity or not pg_has_role(current_user, tb.relowner, 'USAGE')))))
      from dump d join tabs tb on tb.t = d.t join cols c on c.reloid = tb.reloid
      left join trg tr on tr.reloid = tb.reloid)
  )::text as m
)
select '00'::text as nro, 'MANIFEST'::text as taulu, null::bigint as rivit, md5(m) as tiiviste, m as sisalto
  from manifest
union all
select lpad((row_number() over (order by d.t collate "C"))::text, 2, '0'), d.t, d.n, md5(d.payload), d.payload
  from dump d
order by 1;
`;
}

// ---------------------------------------------------------------------
// Vienti (CSV / TSV / JSON) -> rivit
// ---------------------------------------------------------------------

const COLUMNS = ['nro', 'taulu', 'rivit', 'tiiviste', 'sisalto'];

function splitDelimited(text, delimiter) {
  // RFC 4180: kenttä on lainausmerkeissä vain, jos se alkaa lainausmerkillä;
  // sisällä "" = ". Rivinvaihto lainausmerkkien sisällä kuuluu kenttään.
  const rows = [];
  let row = [];
  let field = '';
  let i = 0;
  let quoted = false;
  let atFieldStart = true;
  while (i < text.length) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i += 1; continue;
      }
      field += ch; i += 1; continue;
    }
    if (atFieldStart && ch === '"') { quoted = true; atFieldStart = false; i += 1; continue; }
    if (ch === delimiter) { row.push(field); field = ''; atFieldStart = true; i += 1; continue; }
    if (ch === '\r' && text[i + 1] === '\n') { i += 1; continue; }
    if (ch === '\n') {
      row.push(field); rows.push(row); row = []; field = ''; atFieldStart = true; i += 1; continue;
    }
    field += ch; atFieldStart = false; i += 1;
  }
  if (quoted) throw new Error('vienti katkeaa kesken lainausmerkkien (katkennut kopio?)');
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => !(r.length === 1 && r[0] === ''));
}

function normalizeRow(obj) {
  const lower = Object.fromEntries(Object.entries(obj).map(([k, v]) => [String(k).trim().toLowerCase(), v]));
  for (const c of COLUMNS) {
    if (!(c in lower)) throw new Error(`viennistä puuttuu sarake ${c}`);
  }
  const rivit = lower.rivit;
  return {
    nro: pad2(String(lower.nro).trim()),
    taulu: String(lower.taulu).trim(),
    rivit: rivit === null || rivit === undefined || String(rivit).trim() === '' || /^null$/i.test(String(rivit).trim())
      ? null : String(rivit).trim(),
    tiiviste: String(lower.tiiviste ?? '').trim(),
    // Sisältöä EI trimmata eikä muuteta: tiiviste lasketaan tästä tekstistä.
    sisalto: lower.sisalto === null || lower.sisalto === undefined ? '' : String(lower.sisalto)
  };
}

/** SQL-editorin vienti (CSV, sarkainerotettu tai JSON) -> [{nro, taulu, rivit, tiiviste, sisalto}]. */
export function parseExport(text) {
  const src = String(text).replace(/^﻿/, '');
  const trimmed = src.trim();
  if (!trimmed) throw new Error('vienti on tyhjä');
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    let data;
    try { data = JSON.parse(trimmed); } catch (e) { throw new Error(`JSON-vienti ei jäsenny (katkennut kopio?): ${e.message}`); }
    const list = Array.isArray(data) ? data : Array.isArray(data?.rows) ? data.rows : null;
    if (!list) throw new Error('JSON-vienti ei ole rivitaulukko');
    return list.map(normalizeRow);
  }
  const firstLine = src.slice(0, src.search(/\r?\n|$/));
  const delimiter = firstLine.includes('\t') ? '\t' : ',';
  const rows = splitDelimited(src, delimiter);
  const header = rows.shift().map(h => h.trim().toLowerCase());
  return rows.map(cells => {
    if (cells.length !== header.length) {
      throw new Error(`viennin rivillä on ${cells.length} kenttää, otsikossa ${header.length} (katkennut kopio?)`);
    }
    return normalizeRow(Object.fromEntries(header.map((h, i) => [h, cells[i]])));
  });
}

// ---------------------------------------------------------------------
// Jäsennys ja todennus
// ---------------------------------------------------------------------

/**
 * Jaa jsonb-taulukon tekstimuoto alkioiksi JÄSENTÄMÄTTÄ lukuja.
 * PostgreSQL tulostaa jsonb:n kanonisesti: alkion teksti taulukossa on
 * sama kuin alkion oma jsonb::text. Palauttaa alkioiden tekstit.
 */
export function splitJsonArray(raw) {
  const s = String(raw);
  if (s[0] !== '[' || s[s.length - 1] !== ']') throw new Error('payload ei ole JSON-taulukko');
  const out = [];
  let depth = 0;
  let inString = false;
  let start = -1;
  for (let i = 1; i < s.length - 1; i++) {
    const ch = s[i];
    if (inString) {
      if (ch === '\\') { i += 1; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; if (start < 0) start = i; continue; }
    if (ch === '{' || ch === '[') { if (depth === 0 && start < 0) start = i; depth += 1; continue; }
    if (ch === '}' || ch === ']') { depth -= 1; continue; }
    if (ch === ',' && depth === 0) { out.push(s.slice(start, i)); start = -1; continue; }
    if (start < 0 && ch !== ' ') start = i;
  }
  if (start >= 0) out.push(s.slice(start, s.length - 1));
  if ('[' + out.join(', ') + ']' !== s) throw new Error('payloadin alkiojako ei täsmää (odottamaton muoto)');
  return out;
}

const refTable = ref => String(ref || '').replace(/^public\./, '');

/**
 * Suodattiko RLS taulun rivit ottohetkellä? Palauttaa true / false tai
 * null (ei voida todentaa).
 *
 * Uusi vienti: manifestin `rlsFiltered` (palvelin laski sen:
 * relrowsecurity and not (rolsuper or rolbypassrls) and
 * (relforcerowsecurity or not pg_has_role(current_user, relowner, 'USAGE'))).
 *
 * Vanha vienti (ennen kenttää): johdetaan manifestin kentistä rls,
 * forceRls, superuser, bypassrls, tableOwner ja role. Jäsenyyttä
 * omistajarooliin ei tunneta, joten "eri rooli kuin taulun omistaja"
 * tulkitaan suodatukseksi (fail closed). FORCE RLS ilman ohitusta on
 * suodatus aina, vaikka manifesti väittäisi muuta.
 */
export function rlsFilterOf(manifest, table) {
  const m = manifest.tables[table] || {};
  const bool = v => typeof v === 'boolean';
  const noBypass = bool(manifest.superuser) && bool(manifest.bypassrls) && !manifest.superuser && !manifest.bypassrls;
  const forced = m.rls === true && m.forceRls === true && noBypass;
  if ('rlsFiltered' in m) {
    if (!bool(m.rlsFiltered)) return null;
    return m.rlsFiltered || forced;
  }
  if (m.rls === false) return false;
  if (m.rls !== true || !bool(manifest.superuser) || !bool(manifest.bypassrls)) return null;
  if (manifest.superuser || manifest.bypassrls) return false;
  if (!bool(m.forceRls) || typeof m.tableOwner !== 'string' || typeof manifest.role !== 'string') return null;
  return m.forceRls || m.tableOwner !== manifest.role;
}

/** RLS-suodatuksen ongelmat: [] = jokainen taulu luettiin kokonaan. */
export function rlsFilterProblems(manifest) {
  const problems = [];
  for (const t of Object.keys(manifest.tables || {}).sort()) {
    const filtered = rlsFilterOf(manifest, t);
    const m = manifest.tables[t];
    if (filtered === null) {
      problems.push(`${t}: RLS-suodatusta ei voida todentaa (manifestista puuttuu rlsFiltered tai rooli-/omistajatieto). `
        + 'Ota tilannekuva uudelleen nykyisellä snapshot_state_00NN.sql-tiedostolla.');
    } else if (filtered) {
      problems.push(`${t}: RLS suodatti rivit — rooli ${manifest.role} ei ohita rivitason suojausta `
        + `(superuser ${manifest.superuser}, bypassrls ${manifest.bypassrls}, taulun omistaja ${m.tableOwner}`
        + `${m.forceRls ? ', FORCE RLS' : ''}). Kuva olisi hiljaa vajaa: ota se taulujen omistajana (postgres).`);
    }
  }
  return problems;
}

/**
 * Todenna vienti. Heittää virheen, jos yksikin tiiviste, rivimäärä tai
 * viite ei täsmää. Palauttaa { manifest, raw, data, elements, users, warnings }.
 * `raw[t]` on tiivisteellä todennettu alkuperäinen teksti.
 */
export function parseSnapshot(rows) {
  const errors = [];
  const warnings = [];
  const heads = rows.filter(r => r.nro === '00' || r.taulu === 'MANIFEST');
  if (heads.length !== 1) throw new Error(`MANIFEST-rivi 00 puuttuu tai on monta (${heads.length})`);
  const head = heads[0];
  if (md5(head.sisalto) !== head.tiiviste) {
    throw new Error('MANIFEST: tiiviste ei täsmää (katkennut tai muokattu kopio)');
  }
  let manifest;
  try { manifest = JSON.parse(head.sisalto); } catch (e) { throw new Error(`MANIFEST ei jäsenny: ${e.message}`); }
  if (manifest.format !== FORMAT) throw new Error(`MANIFEST: tuntematon muoto ${manifest.format}`);
  if (!/^\d{4}$/.test(String(manifest.state))) throw new Error('MANIFEST: tila puuttuu');
  if (!manifest.tables || typeof manifest.tables !== 'object') throw new Error('MANIFEST: taulut puuttuvat');
  // Nämä päätyvät generoitujen tiedostojen kommentteihin ja polkuihin.
  if (!/^[\w$.-]+$/.test(String(manifest.db))) throw new Error('MANIFEST: kelvoton kannan nimi');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(String(manifest.at))) throw new Error('MANIFEST: kelvoton aikaleima');
  if (manifest.owner !== OWNER) errors.push(`MANIFEST: omistaja ${manifest.owner} ei ole hyväksytty omistaja`);
  if (manifest.ownerPresent !== true) errors.push('omistajaa ei löytynyt tilannekuvan kannasta (väärä projekti?)');
  // RLS:n suodattama kuva on sisäisesti eheä (tiivisteet, rivimäärät ja
  // viitteet täsmäävät näkyviin riveihin) — siksi erillinen tarkistus.
  errors.push(...rlsFilterProblems(manifest));

  const tables = Object.keys(manifest.tables).sort();
  const payloadRows = rows.filter(r => r !== head);
  const known = new Set(tables);
  for (const r of payloadRows) {
    if (!known.has(r.taulu)) errors.push(`${r.taulu}: payload-rivi, jota manifesti ei tunne`);
  }
  const raw = {};
  const data = {};
  const elements = {};
  tables.forEach((t, i) => {
    ident(t);
    const meta = manifest.tables[t];
    const found = payloadRows.filter(r => r.taulu === t);
    if (found.length !== 1) { errors.push(`${t}: payload-rivejä ${found.length}, odotettiin 1`); return; }
    const row = found[0];
    if (row.nro !== pad2(i + 1)) errors.push(`${t}: rivinumero ${row.nro}, odotettiin ${pad2(i + 1)}`);
    if (md5(row.sisalto) !== meta.md5 || row.tiiviste !== meta.md5) {
      errors.push(`${t}: tiiviste ei täsmää (katkennut tai muokattu solu)`);
      return;
    }
    if (Buffer.byteLength(row.sisalto, 'utf8') !== Number(meta.bytes)) {
      errors.push(`${t}: tavumäärä ${Buffer.byteLength(row.sisalto, 'utf8')}, manifesti ${meta.bytes}`);
    }
    if (row.rivit !== null && Number(row.rivit) !== Number(meta.rows)) {
      errors.push(`${t}: rivit-sarake ${row.rivit}, manifesti ${meta.rows}`);
    }
    let list;
    try {
      list = JSON.parse(row.sisalto);
      elements[t] = splitJsonArray(row.sisalto);
    } catch (e) { errors.push(`${t}: payload ei jäsenny: ${e.message}`); return; }
    if (list.length !== Number(meta.rows) || elements[t].length !== list.length) {
      errors.push(`${t}: rivejä ${list.length}, manifesti ${meta.rows}`);
    }
    if (!Array.isArray(meta.pk) || meta.pk.length !== 1) {
      errors.push(`${t}: pääavaimen on oltava yksi sarake (${JSON.stringify(meta.pk)})`);
    } else {
      const ids = list.map(x => x[meta.pk[0]]);
      if (ids.some(id => typeof id !== 'string')) errors.push(`${t}: pääavain ei ole tekstiä`);
      if (new Set(ids).size !== ids.length) errors.push(`${t}: pääavaimessa on kaksoisarvoja`);
    }
    // Todennettu raaka teksti upotetaan palautukseen sellaisenaan:
    // JSON.parse pudottaisi numericin tarkkuuden (82.40 -> 82.4).
    raw[t] = row.sisalto;
    data[t] = list;
  });

  // Viite-eheys: jokainen tilannekuvan sisäinen viittaus osuu tilannekuvaan.
  // Repeytynyt kuva (taulut eri hetkiltä) jää kiinni tästä.
  const users = new Set();
  for (const t of tables) {
    if (!data[t]) continue;
    for (const fk of manifest.tables[t].fks || []) {
      if (fk.ref === 'auth.users') {
        for (const r of data[t]) if (r[fk.cols[0]]) users.add(String(r[fk.cols[0]]));
        continue;
      }
      const ref = refTable(fk.ref);
      if (!manifest.tables[ref]) { errors.push(`${t}: viite tauluun ${fk.ref}, jota ei ole tilannekuvassa`); continue; }
      if (!data[ref]) continue;
      const key = (row, cols) => JSON.stringify(cols.map(c => row[c]));
      const refCols = Array.isArray(fk.refCols) && fk.refCols.length === fk.cols.length
        ? fk.refCols : manifest.tables[ref].pk;
      const have = new Set(data[ref].map(r => key(r, refCols)));
      for (const r of data[t]) {
        if (fk.cols.some(c => r[c] === null || r[c] === undefined)) continue;
        if (!have.has(key(r, fk.cols))) {
          errors.push(`${t}.${r[manifest.tables[t].pk?.[0]]}: ${fk.name} osoittaa riviin, jota ei ole tilannekuvassa (repeytynyt kuva?)`);
        }
      }
    }
  }

  const extra = (manifest.publicTables || []).filter(t => !known.has(t));
  if (extra.length) {
    warnings.push(`Kannassa oli tauluja, joita tilannekuva ei sisällä: ${extra.join(', ')}. `
      + `Tiedosto on tilalle ${manifest.state}; kanta näyttää olevan myöhemmässä tilassa.`);
  }
  if (errors.length) {
    const e = new Error(errors.join('\n'));
    e.errors = errors;
    throw e;
  }
  return { manifest, raw, data, elements, users: [...users].sort(), warnings, manifestMd5: head.tiiviste };
}

// ---------------------------------------------------------------------
// Palautussuunnitelma
// ---------------------------------------------------------------------

/**
 * Kaksivaiheinen suunnitelma. Vierasavain valittuihin tauluihin:
 *   - kaikki muut sarakkeet kuin user_id nullable -> "myöhästetty" (vaihe 2)
 *   - muuten NOT NULL -reuna -> topologinen järjestys (vaihe 1)
 */
export function restorePlan(manifest, tables) {
  const inSet = new Set(tables);
  const info = {};
  for (const t of tables) {
    const m = manifest.tables[t];
    const notNull = new Map(m.cols.map(([n, , nn]) => [n, nn]));
    const deferred = new Set();
    const edges = [];
    for (const fk of m.fks || []) {
      if (fk.ref === 'auth.users') continue;
      const ref = refTable(fk.ref);
      if (!inSet.has(ref)) continue;
      const own = fk.cols.filter(c => c !== 'user_id');
      if (own.length && own.every(c => !notNull.get(c))) own.forEach(c => deferred.add(c));
      else if (ref !== t) edges.push(ref);
      else throw new Error(`${t}: NOT NULL -viittaus tauluun itseensä (${fk.name}) — ei tuettu`);
    }
    info[t] = {
      cols: m.cols.filter(([, , , generated]) => !generated).map(([n]) => ident(n)),
      pk: ident(m.pk[0]),
      deferred,
      edges
    };
  }
  const order = [];
  const done = new Set();
  const visit = (t, stack) => {
    if (done.has(t)) return;
    if (stack.has(t)) throw new Error(`NOT NULL -viitekehä: ${[...stack, t].join(' -> ')}`);
    stack.add(t);
    for (const r of info[t].edges) visit(r, stack);
    stack.delete(t);
    done.add(t);
    order.push(t);
  };
  [...tables].sort().forEach(t => visit(t, new Set()));
  return { info, order };
}

function dollarTag(texts) {
  for (let i = 0; ; i++) {
    const tag = `$mv${i}$`;
    if (!texts.some(p => p.includes(tag))) return tag;
  }
}

const restricted = (cols, alias) =>
  `(select jsonb_object_agg(e.key, e.value) from jsonb_each(to_jsonb(${alias})) e where e.key = any (array[${cols.map(lit).join(', ')}]::text[]))`;

function selectTables(snap, tables) {
  const all = Object.keys(snap.manifest.tables).sort();
  const chosen = tables && tables.length ? [...new Set(tables)] : all;
  for (const t of chosen) {
    if (!snap.manifest.tables[t]) throw new Error(`taulua ${t} ei ole tilannekuvassa (${all.join(', ')})`);
    ident(t);
  }
  return all.filter(t => chosen.includes(t));
}

/**
 * Karsinnan (--prune) riippuvat taulut: tilannekuvan taulut, jotka EIVÄT
 * ole valittuja mutta viittaavat vierasavaimella valittuun tauluun.
 * Karsinta poistaisi valitusta taulusta rivejä, joihin ne viittaavat —
 * ja vierasavaimen säännön mukaan (cascade / set null / restrict) poistaisi,
 * muuttaisi tai estäisi rivejä tauluissa, joita ei palauteta.
 *
 * @returns {{table: string, fk: string, ref: string}[]}
 */
export function pruneDependents(manifest, chosen) {
  const set = new Set(chosen);
  const out = [];
  for (const t of Object.keys(manifest.tables).sort()) {
    if (set.has(t)) continue;
    for (const fk of manifest.tables[t].fks || []) {
      if (fk.ref === 'auth.users') continue;
      const ref = refTable(fk.ref);
      if (set.has(ref)) out.push({ table: t, fk: fk.name, ref });
    }
  }
  return out;
}

/** Virheilmoitus, jos --prune --tables jättäisi riippuvan taulun pois; muuten null. */
export function pruneSelectionProblem(snap, tables) {
  if (!tables || !tables.length) return null;
  const chosen = selectTables(snap, tables);
  const deps = pruneDependents(snap.manifest, chosen);
  if (!deps.length) return null;
  const missing = [...new Set(deps.map(d => d.table))];
  return `--prune --tables=${chosen.join(',')}: karsinta koskisi myös tauluja, joita ei valittu `
    + `(${deps.map(d => `${d.table}.${d.fk} -> ${d.ref}`).join('; ')}). `
    + `Lisää --tables-listaan myös: ${missing.join(', ')} — tai jätä --prune pois.`;
}

function timezoneOf(manifest) {
  const tz = String(manifest.timezone || '');
  if (!/^[A-Za-z0-9_/+\-:.]+$/.test(tz)) throw new Error(`MANIFEST: kelvoton aikavyöhyke ${tz}`);
  return tz;
}

/**
 * Yksi transaktio, joka tarkistaa itsensä: kaatuu (eikä mitään
 * tallenneta), ellei jokainen tilannekuvan rivi ole lopuksi tavu tavulta
 * sama. Uudemmat sarakkeet (esim. depends_on) saavat nykyisen tai
 * oletusarvonsa. --dry-run: sama skripti, joka päättyy rollback;iin.
 */
export function buildRestoreSql(snap, { tables, prune = false, dryRun = false } = {}) {
  const { manifest, raw } = snap;
  const chosen = selectTables(snap, tables);
  // Osittainen karsinta: jokaisen valittuun tauluun viittaavan taulun on
  // oltava mukana (tilannekuvan taulut tässä, kannan muut taulut suojassa 5).
  const partialPrune = prune && Boolean(tables && tables.length);
  if (partialPrune) {
    const problem = pruneSelectionProblem(snap, tables);
    if (problem) throw new Error(problem);
  }
  const { info, order } = restorePlan(manifest, chosen);
  const tz = timezoneOf(manifest);
  const tag = dollarTag(chosen.map(t => raw[t]));
  const withTriggers = chosen.filter(t => (manifest.tables[t].triggers || []).length);
  const users = [...new Set(chosen.flatMap(t => {
    const fk = (manifest.tables[t].fks || []).find(f => f.ref === 'auth.users');
    return fk ? snap.data[t].map(r => r[fk.cols[0]]).filter(Boolean).map(String) : [];
  }))].sort();
  for (const u of users) if (!/^[0-9a-f-]{36}$/.test(u)) throw new Error(`kelvoton käyttäjätunniste ${u}`);

  const out = [];
  out.push('-- =====================================================================');
  out.push(`-- Manifestival — ${dryRun ? 'PALAUTUKSEN KUIVAHARJOITUS' : 'PALAUTUS'} tilannekuvasta (GENEROITU)`);
  out.push('-- =====================================================================');
  out.push('--');
  out.push(`-- Tilannekuva: tila ${manifest.state}, otettu ${manifest.at}, kanta ${manifest.db},`);
  out.push(`-- MANIFEST-tiiviste ${snap.manifestMd5}, aikavyöhyke ${tz}.`);
  out.push(`-- Taulut (${chosen.length}): ${chosen.map(t => `${t} ${manifest.tables[t].rows}`).join(', ')}`);
  out.push(`-- Karsinta (--prune): ${prune ? 'KYLLÄ — tilannekuvan jälkeen luodut rivit POISTETAAN' : 'ei — uudemmat rivit säilyvät'}`);
  out.push(dryRun
    ? '-- KUIVAHARJOITUS: päättyy rollback;iin. Mitään ei tallenneta. Onnistunut ajo = ei ERROR-riviä.'
    : '-- TODELLINEN PALAUTUS: päättyy commit;iin vain, jos lopputarkistus täsmää.');
  out.push('--');
  out.push('-- SISÄLTÄÄ HENKILÖTIETOJA. Älä liitä chattiin, issueen tai committiin.');
  out.push('-- Aja KOKO tiedosto uudessa SQL-editorin välilehdessä, sovellus suljettuna.');
  out.push('-- ERROR = mitään ei muuttunut. Aja silloin samassa välilehdessä: rollback;');
  out.push('-- Ohje: docs/activation/0010-BACKUP-AND-RECOVERY.md');
  out.push('');
  out.push('begin;');
  out.push("set local lock_timeout = '5s';");
  out.push(`set local timezone = ${lit(tz)};`);
  out.push('');

  // Suojat: ennen yhtäkään muutosta.
  const colRows = chosen.flatMap(t => manifest.tables[t].cols.map(([n, ty]) => `(${lit(t)}, ${lit(n)}, ${lit(ty)})`));
  const trgRows = chosen.flatMap(t => (manifest.tables[t].triggers || []).map(g => `(${lit(t)}, ${lit(g)})`));
  const trgValues = trgRows.length ? `values ${trgRows.join(', ')}` : 'select null::text, null::text where false';
  const tableArray = `array[${chosen.map(lit).join(', ')}]::text[]`;
  out.push(`do $mv_guard$
declare
  n integer;
  puuttuu text;
begin
  -- 1. Oikea projekti: current_database() on Supabasessa aina 'postgres',
  --    joten omistajan uuid on todellinen erottelija (kuten migraatioissa).
  if not exists (select 1 from auth.users where id = ${lit(manifest.owner)}::uuid) then
    raise exception 'VÄÄRÄ PROJEKTI TAI OMISTAJA POISTETTU: omistajaa % ei ole auth.users-taulussa. Tämä työkalu ei palauta tilejä.', ${lit(manifest.owner)};
  end if;
  select count(*) into n from unnest(array[${users.map(lit).join(', ')}]::uuid[]) u(id)
   where not exists (select 1 from auth.users x where x.id = u.id);
  if n > 0 then
    raise exception 'Tilannekuvan % käyttäjää puuttuu auth.users-taulusta. Tämä työkalu ei palauta tilejä.', n;
  end if;
  if current_database() <> ${lit(manifest.db)} then
    raise exception 'VÄÄRÄ KANTA: %, tilannekuva on kannasta %.', current_database(), ${lit(manifest.db)};
  end if;
  -- 2. Skeema: jokainen tilannekuvan sarake on olemassa samalla tyypillä.
  select string_agg(v.t || '.' || v.c || ' ' || v.ty, ', '), count(*) into puuttuu, n
    from (values ${colRows.join(',\n                 ')}) v(t, c, ty)
   where not exists (select 1 from pg_attribute a
                      where a.attrelid = to_regclass('public.' || v.t) and a.attname = v.c
                        and not a.attisdropped and format_type(a.atttypid, a.atttypmod) = v.ty);
  if n > 0 then
    raise exception 'Skeema ei vastaa tilannekuvaa (% saraketta puuttuu tai on eri tyyppiä): %', n, puuttuu;
  end if;
  -- 3. Liipaisimet: täsmälleen tilannekuvan joukko, kaikki päällä.
  select string_agg(d.t || '.' || d.g, ', '), count(*) into puuttuu, n from (
    (select c.relname::text as t, tg.tgname::text as g
       from pg_trigger tg join pg_class c on c.oid = tg.tgrelid
      where c.relnamespace = 'public'::regnamespace and c.relname = any (${tableArray})
        and not tg.tgisinternal and tg.tgenabled = 'O'
     except select v.t, v.g from (${trgValues}) v(t, g))
    union all
    (select v.t, v.g from (${trgValues}) v(t, g)
     except select c.relname::text, tg.tgname::text
       from pg_trigger tg join pg_class c on c.oid = tg.tgrelid
      where c.relnamespace = 'public'::regnamespace and c.relname = any (${tableArray})
        and not tg.tgisinternal and tg.tgenabled = 'O')
  ) d;
  if n > 0 then
    raise exception 'Liipaisimet eivät vastaa tilannekuvaa (lisä-, puuttuvat tai pois päältä olevat): %', puuttuu;
  end if;
  -- 4. Oikeudet: liipaisimen poiskytkentä vaatii taulun omistajuuden.
  select string_agg(c.relname::text, ', ') into puuttuu
    from pg_class c
   where c.relnamespace = 'public'::regnamespace and c.relname = any (${tableArray})
     and not pg_has_role(current_user, c.relowner, 'USAGE');
  if puuttuu is not null then
    raise exception 'Rooli % ei omista tauluja: %. Aja palautus taulujen omistajana (postgres).', current_user, puuttuu;
  end if;
  if exists (select 1 from pg_class c
              where c.relnamespace = 'public'::regnamespace and c.relname = any (${tableArray})
                and c.relforcerowsecurity)
     and not exists (select 1 from pg_roles r where r.rolname = current_user and (r.rolsuper or r.rolbypassrls)) then
    raise exception 'FORCE ROW LEVEL SECURITY on päällä ja roolilla % ei ole BYPASSRLS-oikeutta: rivit suodattuisivat.', current_user;
  end if;${partialPrune ? `
  -- 5. Osittainen karsinta: yksikään valitsematon taulu (myöskään
  --    tilannekuvan jälkeen luotu) ei saa viitata valittuun tauluun.
  select string_agg(distinct c.relname::text, ', ' order by c.relname::text) into puuttuu
    from pg_constraint con
    join pg_class c on c.oid = con.conrelid
    join pg_class p on p.oid = con.confrelid
   where con.contype = 'f'
     and p.relnamespace = 'public'::regnamespace and p.relname = any (${tableArray})
     and not (c.relnamespace = 'public'::regnamespace and c.relname = any (${tableArray}));
  if puuttuu is not null then
    raise exception 'KARSINTA ESTETTY: valittuihin tauluihin viittaavat myös taulut %. Lisää ne --tables-listaan tai jätä --prune pois.', puuttuu;
  end if;` : ''}
  raise notice 'Suojat kunnossa: % taulua, % käyttäjää.', ${chosen.length}, ${users.length};
end $mv_guard$;`);
  out.push('');

  // Tilannekuva väliaikaisiin tauluihin nykyisen skeeman muotoisina.
  for (const t of chosen) {
    out.push(`create temp table mv_r_${t} on commit drop as
  select * from jsonb_populate_recordset(null::public.${t}, ${tag}${raw[t]}${tag}::jsonb);`);
  }
  out.push('');
  for (const t of withTriggers) out.push(`alter table public.${t} disable trigger user;`);
  out.push('');

  if (prune) {
    out.push('-- Karsinta: tilannekuvan jälkeen luodut rivit pois (lapset ensin).');
    for (const t of [...order].reverse()) {
      const k = col(info[t].pk);
      out.push(`delete from public.${t} x where not exists (select 1 from mv_r_${t} r where r.${k} = x.${k});`);
    }
    out.push('');
  }

  out.push('-- Vaihe 1: rivit viittausjärjestyksessä, nullable-viittaukset myöhemmin.');
  for (const t of order) {
    const { cols, pk, deferred } = info[t];
    const k = col(pk);
    const setCols = cols.filter(c => c !== pk && !deferred.has(c));
    if (setCols.length) {
      out.push(`update public.${t} x set ${setCols.map(c => `${col(c)} = r.${col(c)}`).join(', ')}
  from mv_r_${t} r where x.${k} = r.${k};`);
    }
    out.push(`insert into public.${t} (${cols.map(col).join(', ')})
  select ${cols.map(c => (deferred.has(c) ? 'null' : `r.${col(c)}`)).join(', ')}
    from mv_r_${t} r where not exists (select 1 from public.${t} x where x.${k} = r.${k});`);
  }
  out.push('');
  out.push('-- Vaihe 2: nullable-viittaukset (kehäviittaukset goals <-> projects ym.).');
  for (const t of order) {
    const { pk, deferred } = info[t];
    if (!deferred.size) continue;
    out.push(`update public.${t} x set ${[...deferred].map(c => `${col(c)} = r.${col(c)}`).join(', ')}
  from mv_r_${t} r where x.${col(pk)} = r.${col(pk)};`);
  }
  out.push('');

  // Lopputarkistus transaktion sisällä: tiiviste tilannekuvan riveistä,
  // tilannekuvan sarakkeista, täsmälleen samalla lausekkeella kuin otossa.
  const checks = chosen.map(t => {
    const m = manifest.tables[t];
    const cols = m.cols.map(([n]) => n);
    const k = col(info[t].pk);
    const lines = [`  select md5(coalesce(jsonb_agg(j order by j::text), '[]'::jsonb)::text), count(*) into h, n
    from (select ${restricted(cols, 'x')} as j
            from public.${t} x where x.${k} in (select r.${k} from mv_r_${t} r)) s;
  if h is distinct from ${lit(m.md5)} or n <> ${Number(m.rows)} then
    raise exception 'PALAUTUS EI TÄSMÄÄ: ${t} (rivejä % / ${Number(m.rows)}, tiiviste %). MITÄÄN EI TALLENNETTU.', n, h;
  end if;`];
    if (prune) {
      lines.push(`  select count(*) into n from public.${t};
  if n <> ${Number(m.rows)} then
    raise exception 'PALAUTUS EI TÄSMÄÄ: ${t} karsinnan jälkeen % riviä, tilannekuvassa ${Number(m.rows)}. MITÄÄN EI TALLENNETTU.', n;
  end if;`);
    }
    return lines.join('\n');
  });
  out.push(`do $mv_verify$
declare
  h text;
  n bigint;
begin
${checks.join('\n')}
  raise notice 'Palautus täsmää tilannekuvaan kaikissa % taulussa.', ${chosen.length};
end $mv_verify$;`);
  out.push('');
  for (const t of withTriggers) out.push(`alter table public.${t} enable trigger user;`);
  if (withTriggers.length) {
    out.push(`do $mv_triggers$
begin
  if exists (select 1 from pg_trigger tg join pg_class c on c.oid = tg.tgrelid
              where c.relnamespace = 'public'::regnamespace and c.relname = any (${tableArray})
                and not tg.tgisinternal and tg.tgenabled <> 'O') then
    raise exception 'Liipaisin jäi pois päältä. MITÄÄN EI TALLENNETTU.';
  end if;
end $mv_triggers$;`);
  }
  out.push('');
  out.push(dryRun ? 'rollback;' : 'commit;');
  return out.join('\n') + '\n';
}

// ---------------------------------------------------------------------
// Vertailu: vain lukeva, vain tunnisteet ja tiivisteet
// ---------------------------------------------------------------------

/** Tilannekuvan rivien tunnisteet ja rivikohtaiset tiivisteet (raakatekstistä). */
export function rowDigests(snap, table) {
  const pk = snap.manifest.tables[table].pk[0];
  return snap.elements[table].map((text, i) => ({ id: String(snap.data[table][i][pk]), md5: md5(text) }));
}

/**
 * compare.sql: YKSI vain lukeva SELECT. Taulukohtaisesti SAMA,
 * SAMA+N UUTTA tai MUUTTUNUT sekä muuttuneet/puuttuvat/uudet tunnisteet.
 * Ei sisältöä: vain tunnisteet, rivitiivisteet ja sarakkeiden nimet.
 */
export function buildCompareSql(snap, { tables } = {}) {
  const { manifest } = snap;
  const chosen = selectTables(snap, tables);
  const tz = timezoneOf(manifest);
  const ctes = [];
  const parts = [];
  chosen.forEach((t, i) => {
    const m = manifest.tables[t];
    const k = col(m.pk[0]);
    const cols = m.cols.map(([n]) => ident(n));
    const digests = rowDigests(snap, t);
    const values = digests.length
      ? `values ${digests.map(d => `(${lit(d.id)}, ${lit(d.md5)})`).join(',\n    ')}`
      : 'select null::text, null::text where false';
    ctes.push(`s_${t}(id, h) as (\n    ${values}\n  )`);
    const hasTz = m.cols.some(([, ty]) => /with time zone/.test(ty));
    const ids = query => `(select string_agg(z.id, ',' order by z.id) from (${query} order by 1 limit 20) z(id))`;
    parts.push(`  select ${lit(pad2(i + 1))}::text as nro, ${lit(t)}::text as taulu, ${hasTz ? 'true' : 'false'} as aikaleimoja,
         ${Number(m.rows)}::bigint as rivit_kuvassa,
         (select count(*) from public.${t})::bigint as rivit_nyt,
         (select count(*) from unnest(array[${cols.map(lit).join(', ')}]::text[]) c(nimi)
           where not exists (select 1 from pg_attribute a where a.attrelid = to_regclass('public.${t}')
                              and a.attname = c.nimi and not a.attisdropped))::bigint as puuttuvia_sarakkeita,
         (select count(*) from s_${t} s where not exists (select 1 from public.${t} x where x.${k}::text = s.id))::bigint as puuttuu,
         (select count(*) from s_${t} s join public.${t} x on x.${k}::text = s.id
           where md5(${restricted(cols, 'x')}::text) <> s.h)::bigint as muuttunut,
         (select count(*) from public.${t} x where not exists (select 1 from s_${t} s where s.id = x.${k}::text))::bigint as uusia,
         ${ids(`select s.id from s_${t} s join public.${t} x on x.${k}::text = s.id where md5(${restricted(cols, 'x')}::text) <> s.h`)} as muuttuneet_id,
         ${ids(`select s.id from s_${t} s where not exists (select 1 from public.${t} x where x.${k}::text = s.id)`)} as puuttuvat_id,
         ${ids(`select x.${k}::text from public.${t} x where not exists (select 1 from s_${t} s where s.id = x.${k}::text)`)} as uudet_id`);
  });
  return `-- =====================================================================
-- Manifestival — VERTAILU tilannekuvaan (GENEROITU, VAIN LUKU, YKSI LAUSE)
-- =====================================================================
--
-- Tilannekuva: tila ${manifest.state}, otettu ${manifest.at}, MANIFEST-tiiviste ${snap.manifestMd5}.
-- Ei sisältöä: vain rivien tunnisteet ja rivikohtaiset tiivisteet.
-- Aja milloin tahansa: mitään ei luoda, muuteta eikä poisteta.
--
-- SAMA            jokainen tilannekuvan rivi on tavu tavulta ennallaan
-- SAMA+N UUTTA    kuten SAMA, lisäksi N tilannekuvan jälkeen luotua riviä
-- MUUTTUNUT       rivejä muuttunut tai puuttuu (tunnisteet sarakkeissa)
-- EI VERTAILTAVISSA  istunnon aikavyöhyke eri kuin otossa (${tz})
-- Ohje: docs/activation/0010-BACKUP-AND-RECOVERY.md

with
${ctes.join(',\n')},
vertailu as (
${parts.join('\n  union all\n')}
)
select v.nro, v.taulu,
       case when v.aikaleimoja and current_setting('TimeZone') <> ${lit(tz)}
              then 'EI VERTAILTAVISSA: aikavyöhyke ' || current_setting('TimeZone') || ', otossa ${tz}'
            when v.puuttuvia_sarakkeita > 0 or v.puuttuu > 0 or v.muuttunut > 0 then 'MUUTTUNUT'
            when v.uusia > 0 then 'SAMA+' || v.uusia || ' UUTTA'
            else 'SAMA' end as tila,
       v.rivit_kuvassa, v.rivit_nyt, v.muuttunut, v.puuttuu, v.uusia, v.puuttuvia_sarakkeita,
       v.muuttuneet_id, v.puuttuvat_id, v.uudet_id
  from vertailu v
 order by v.nro;
`;
}

// ---------------------------------------------------------------------
// Yhteenveto `check`-komennolle
// ---------------------------------------------------------------------

/** Tilan 0009 tilannekuvan luvut, jotka vastaavat preflight_0010:n INFO-rivejä. */
export const PREFLIGHT_0010_ROWS = Object.freeze({ '11': 'goals', '12': 'projects', '13': 'profile', '18': 'tasks' });

export function describeSnapshot(snap) {
  const { manifest } = snap;
  const tables = Object.keys(manifest.tables).sort();
  const lines = [];
  lines.push(`TILANNEKUVA KUNNOSSA (${manifest.format}): tiivisteet, rivimäärät, viite-eheys ja RLS-suodatus täsmäävät.`);
  lines.push(`  tila            ${manifest.state} (migraatiot 0001–${manifest.state} ajettu)`);
  lines.push(`  otettu          ${manifest.at} (UTC), aikavyöhyke ${manifest.timezone}`);
  lines.push(`  kanta           ${manifest.db}, PostgreSQL ${manifest.server}`);
  lines.push(`  rooli           ${manifest.role} (superuser ${manifest.superuser}, bypassrls ${manifest.bypassrls})`);
  lines.push(`  omistaja        ${manifest.ownerPresent ? 'löytyy' : 'PUUTTUU'}, auth-käyttäjiä ${manifest.authUsers}`);
  lines.push(`  MANIFEST md5    ${snap.manifestMd5}`);
  lines.push(`  taulut (${tables.length}):`);
  tables.forEach((t, i) => {
    const m = manifest.tables[t];
    lines.push(`    ${pad2(i + 1)} ${t.padEnd(26)} rivejä ${String(m.rows).padStart(5)}  md5 ${m.md5}  ${m.bytes} t`);
  });
  const owners = [...new Set(tables.map(t => manifest.tables[t].tableOwner))];
  const forced = tables.filter(t => manifest.tables[t].forceRls);
  lines.push(`  taulujen omistaja: ${owners.join(', ')}; RLS päällä ${tables.filter(t => manifest.tables[t].rls).length}/${tables.length}; FORCE RLS: ${forced.length ? forced.join(', ') : 'ei yhdessäkään'}`);
  const derived = tables.some(t => !('rlsFiltered' in manifest.tables[t]));
  lines.push(`  RLS-suodatus    ei yhdessäkään taulussa (${derived ? 'johdettu roolista ja omistajasta: vanha vienti' : 'rlsFiltered manifestissa'})`);
  if (manifest.state === '0009') {
    lines.push('  Vertaa preflight_0010.sql:n INFO-riveihin (samat luvut):');
    for (const [nro, t] of Object.entries(PREFLIGHT_0010_ROWS)) {
      lines.push(`    rivi ${nro}  ${t.padEnd(10)} = ${manifest.tables[t]?.rows ?? 'puuttuu'}`);
    }
  }
  for (const w of snap.warnings) lines.push(`VAROITUS: ${w}`);
  return lines.join('\n');
}

/** Oletushakemisto: .local-backups/db/<UTC>_state_00NN/ (ei versionhallintaan). */
export function defaultOutputDir(manifest) {
  const stamp = String(manifest.at).replace(/[-:]/g, '');
  if (!/^\d{8}T\d{6}Z$/.test(stamp)) throw new Error(`MANIFEST: kelvoton aikaleima ${manifest.at}`);
  return `.local-backups/db/${stamp}_state_${manifest.state}`;
}
