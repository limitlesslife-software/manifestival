// Tuotannon muotoinen tila 0008 — TÄSMÄLLEEN omistajan inventaarion
// mukainen (2026-09-26), ja siitä kloonatut harjoituskannat.
//
// Tuotanto 0008:ssa: yksi auth-käyttäjä (hyväksytty omistaja), tasks 36
// (date/time tekstinä, yhdelläkään ei kestoa), profile 1, goals 1,
// projects 1, notification_preferences 1, wellbeing_entries 1, kaikki muut
// taulut tyhjiä. Rakennetaan KERRAN kantaan mv_rehearsal_prodshape_0008:
//
//   shim -> auth.users (vain omistaja) -> lähtötila ennen 0001:tä (text)
//   -> 0001..0008, ja sovellus kirjoittaa omistajana OIKEILLA
//      rivimuunnoksilla (waves.mjs, aalto C) sillä hetkellä kun taulu
//      syntyy: tavoite + projekti 0004:n jälkeen, muistutusasetukset
//      0005:n jälkeen, hyvinvointimerkintä 0006:n jälkeen.
//
// Aliskenaariot kloonataan siitä: `create database X template
// mv_rehearsal_prodshape_0008` — ne alkavat aidosti tilasta 0008 eivätkä
// toista ketjua 0001:stä. Myöhemmät mallit (0009..0014) syntyvät
// kloonaamalla edellinen ja ajamalla yksi migraatio.
//
// Tuotannon tavoitteen tila ja projektin kytkentä eivät ole tiedossa
// (inventaario kertoo vain lukumäärät), joten values:0010 ja
// prodshape:fixture käyvät läpi kaikki viisi 0004:n sallimaa tilaa ×
// projekti kytketty/kytkemätön.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ROOT, OWNER, connect, createDatabase, dropDatabase, runSql, readSql, catalogFingerprint,
  postgrestWrite, wirePayload, rowDigests, tableColumns, relFilenode, compareDigests, scalar
} from './lib.mjs';
import { MIGRATIONS, numberOf, prepareBaseline, migrationName, applyMigration } from './chain.mjs';
import { loadAppModules, trainWaves } from './waves.mjs';

export const TEMPLATE_PREFIX = 'mv_rehearsal_prodshape_';
export const templateAt = n => `${TEMPLATE_PREFIX}${n}`;

/** 0004:n validoitu tilarajoite sallii nämä viisi. */
export const LEGAL_GOAL_STATUSES_0004 = Object.freeze(['active', 'paused', 'completed', 'abandoned', 'archived']);

export const PROD_IDS = Object.freeze({ goal: 'prod-goal-1', project: 'prod-proj-1', wellbeing: 'prod-wb-1' });

/** Tuotannon rivimäärät tilassa 0008 (omistajan inventaario). */
export const PROD_ROWS_0008 = Object.freeze({
  tasks: 36, profile: 1, goals: 1, projects: 1, routines: 0, routine_exceptions: 0,
  notification_preferences: 1, wellbeing_entries: 1, bills: 0, recurring_expenses: 0,
  savings_goals: 0, ai_action_audit: 0
});

export const EXPECTED_INVENTORY_FILE = 'tools/pg-rehearsal/expected/production-inventory-0008.json';

/** Sovelluksen rivi aallon C porteilla (kaikki sarakeportit kiinni). */
async function appRow(schemaKey, entity) {
  const mods = await loadAppModules(trainWaves().C.gates);
  const repo = mods.repos.ALL_REPOSITORIES.find(r => r.schemaKey === schemaKey);
  return wirePayload(repo.mapping.toRow(repo.mapping.normalize(entity)));
}

async function write(client, table, payload, opts) {
  const r = await postgrestWrite(client, OWNER, table, payload, opts);
  if (!r.ok || r.rowCount !== 1) throw new Error(`prodshape ${table} ${opts?.method || 'insert'}: ${r.message || `rivejä ${r.rowCount}`}`);
}

/** Tuotannon rivit sillä hetkellä kun taulu syntyy. */
async function seedProduction(client, number) {
  if (number === '0004') {
    await write(client, 'goals', await appRow('goals', {
      id: PROD_IDS.goal, title: 'Tuotannon tavoite', category: 'kehitys', priority: 'normaali', status: 'active'
    }));
    await write(client, 'projects', await appRow('projects', {
      id: PROD_IDS.project, name: 'Tuotannon projekti', category: 'kehitys', status: 'active', goalId: PROD_IDS.goal
    }));
  }
  if (number === '0005') {
    const mods = await loadAppModules(trainWaves().C.gates);
    await write(client, 'notification_preferences',
      wirePayload(mods.prefs.preferencesToRow({ enabled: false }, OWNER)), { method: 'upsert', onConflict: 'id' });
  }
  if (number === '0006') {
    await write(client, 'wellbeing_entries', await appRow('wellbeing', {
      id: PROD_IDS.wellbeing, date: '2026-09-20', energy: 3, mood: 4, stress: 2, sleepHours: 7
    }));
  }
}

const built = new Set();

/** Rakenna mv_rehearsal_prodshape_0008 (kerran per ajo). */
export async function buildProdShape0008() {
  const db = templateAt('0008');
  await createDatabase(db);
  const client = await connect(db);
  try {
    await prepareBaseline(client, 'text', { users: [OWNER] });
    for (const name of MIGRATIONS) {
      const n = numberOf(name);
      if (n > '0008') break;
      const out = await runSql(client, readSql(`supabase/migrations/${name}.sql`));
      if (!out.ok) throw new Error(`prodshape ${name}: ${out.error.message}`);
      await seedProduction(client, n);
    }
  } finally {
    await client.end();
  }
  built.add('0008');
  return db;
}

/** Varmista malli tilassa n (0008..0014); rakentaa puuttuvat edeltäjät. */
export async function ensureTemplate(n) {
  if (built.has(n)) return templateAt(n);
  if (n === '0008') return buildProdShape0008();
  const prev = String(Number(n) - 1).padStart(4, '0');
  await ensureTemplate(prev);
  const db = templateAt(n);
  await createDatabase(db, { template: templateAt(prev) });
  const client = await connect(db);
  try {
    const out = await runSql(client, readSql(`supabase/migrations/${migrationName(n)}.sql`));
    if (!out.ok) throw new Error(`prodshape-malli ${n}: ${out.error.message}`);
  } finally {
    await client.end();
  }
  built.add(n);
  return db;
}

export async function dropTemplates() {
  for (const n of [...built].sort().reverse()) await dropDatabase(templateAt(n));
  built.clear();
}

/**
 * Klooni tuotannon muotoinen kanta tilassa n. `goalStatus` ja
 * `projectLinked` asettavat tuntemattomat tuotannon arvot sovelluksen
 * omalla päivityksellä (PostgREST-muoto, aalto C).
 */
export async function cloneProdShape(n, name, { goalStatus = 'active', projectLinked = true } = {}) {
  await ensureTemplate(n);
  await createDatabase(name, { template: templateAt(n) });
  const client = await connect(name);
  if (goalStatus !== 'active') {
    await write(client, 'goals', await appRow('goals', {
      id: PROD_IDS.goal, title: 'Tuotannon tavoite', category: 'kehitys', priority: 'normaali', status: goalStatus
    }), { method: 'update', match: { user_id: OWNER, id: PROD_IDS.goal } });
  }
  if (!projectLinked) {
    await write(client, 'projects', await appRow('projects', {
      id: PROD_IDS.project, name: 'Tuotannon projekti', category: 'kehitys', status: 'active', goalId: null
    }), { method: 'update', match: { user_id: OWNER, id: PROD_IDS.project } });
  }
  return client;
}

/** Kaikki muunnelmat: 5 tilaa × projekti kytketty/kytkemätön. */
export function prodVariants() {
  const out = [];
  for (const goalStatus of LEGAL_GOAL_STATUSES_0004) {
    for (const projectLinked of [true, false]) out.push({ goalStatus, projectLinked, key: `${goalStatus}_${projectLinked ? 'kytketty' : 'irti'}` });
  }
  return out;
}

// ---------------------------------------------------------------------
// Inventaario
// ---------------------------------------------------------------------

/** Aja activation_readonly_inventory.sql READ ONLY -transaktiossa. */
export async function runInventory(client) {
  const before = await catalogFingerprint(client);
  await client.query('begin read only');
  let result;
  try {
    result = await client.query(readSql('supabase/acceptance/activation_readonly_inventory.sql'));
  } finally {
    await client.query('rollback');
  }
  const after = await catalogFingerprint(client);
  const cell = result.rows.find(r => r.nro === '00').arvo;
  return { cell, table: result.rows, rows: JSON.parse(cell).rows, unchanged: before.hash === after.hash };
}

export function loadExpectedInventory() {
  return JSON.parse(readFileSync(join(ROOT, EXPECTED_INVENTORY_FILE), 'utf8'));
}

/**
 * Puhdas: vertaa harjoittelun inventaariorivejä omistajan toimittamaan.
 * owner/derived verrataan (exact tai major), absent vain kirjataan.
 */
export function compareInventory(expected, actualRows) {
  const mismatches = [];
  const compared = { owner: 0, derived: 0 };
  const recorded = {};
  for (const [nro, spec] of Object.entries(expected.rows)) {
    const actual = actualRows[nro];
    if (spec.compare === 'none' || spec.source === 'absent') { recorded[nro] = actual ?? null; continue; }
    let ok;
    if (spec.compare === 'major') {
      const major = v => String(v ?? '').replace(/^(\d{2})\d{4}$/, '$1').split('.')[0];
      ok = major(actual) === major(spec.value);
    } else {
      ok = String(actual) === String(spec.value);
    }
    compared[spec.source] = (compared[spec.source] || 0) + 1;
    if (!ok) mismatches.push({ nro, expected: spec.value, actual: actual ?? null, source: spec.source, note: spec.note });
  }
  for (const nro of Object.keys(actualRows)) {
    if (!(nro in expected.rows)) mismatches.push({ nro, expected: '(ei odotusta)', actual: actualRows[nro], source: 'unknown' });
  }
  return { mismatches, compared, recorded };
}

/** Omistajan rivit pisteytyksen syötteeksi: absent-rivit jätetään pois. */
export function expectedInventoryRows(expected, fill = {}) {
  const rows = {};
  for (const [nro, spec] of Object.entries(expected.rows)) {
    if (spec.source !== 'absent' && spec.value !== null) rows[nro] = spec.value;
  }
  return { ...rows, ...fill };
}

// ---------------------------------------------------------------------
// Todisteet migraation ympärillä: rivien tiivisteet, xmin, tiedostosolmu
// ---------------------------------------------------------------------

/** public-skeeman taulut. */
export async function publicTables(client) {
  const res = await client.query(
    `select relname from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' order by 1`);
  return res.rows.map(r => r.relname);
}

/** Tilannekuva jokaisesta olemassa olevasta taulusta: sarakkeet, tiivisteet, solmu. */
export async function snapshotTables(client, tables = null) {
  const list = tables || await publicTables(client);
  const out = {};
  for (const t of list) {
    const exists = await scalar(client, 'select to_regclass($1) is not null', [`public.${t}`]);
    if (!exists) continue;
    const columns = await tableColumns(client, t);
    out[t] = { columns, digests: await rowDigests(client, t, columns), filenode: await relFilenode(client, t) };
  }
  return out;
}

/** Vertaa ennen/jälkeen: samat vanhat sarakkeet, samat tiivisteet, sama xmin ja solmu. */
export async function compareSnapshot(client, before, { allowXmin = [], allowAdded = false } = {}) {
  const problems = [];
  const perTable = {};
  for (const [t, b] of Object.entries(before)) {
    const exists = await scalar(client, 'select to_regclass($1) is not null', [`public.${t}`]);
    if (!exists) { problems.push(`${t}: taulu katosi`); continue; }
    const after = await rowDigests(client, t, b.columns);
    const d = compareDigests(b.digests, after);
    const filenode = await relFilenode(client, t);
    perTable[t] = { rows: b.digests.size, changed: d.changed.length, added: d.added.length, removed: d.removed.length,
                    xminChanged: d.xminChanged.length, rewritten: filenode !== b.filenode };
    if (d.removed.length) problems.push(`${t}: rivejä poistui ${d.removed.join(',')}`);
    if (d.added.length && !allowAdded) problems.push(`${t}: rivejä lisättiin ${d.added.join(',')}`);
    if (d.changed.length) problems.push(`${t}: vanhojen sarakkeiden arvot muuttuivat ${d.changed.join(',')}`);
    if (d.xminChanged.length && !allowXmin.includes(t)) problems.push(`${t}: rivejä kirjoitettiin uudelleen (xmin) ${d.xminChanged.join(',')}`);
    if (filenode !== b.filenode) problems.push(`${t}: taulu kirjoitettiin uudelleen (relfilenode ${b.filenode} -> ${filenode})`);
  }
  return { problems, perTable };
}

/** Kultaiset skeemaerot ja sallitut poistot. */
export const GOLDEN_DIR = 'tools/pg-rehearsal/expected';
export const goldenFile = n => `${GOLDEN_DIR}/schema-diff-${n}.txt`;
export const ALLOWED_REMOVALS = Object.freeze({
  '0009': Object.freeze([]),
  '0010': Object.freeze(['con:goals:goals_status_check:']),
  '0011': Object.freeze([]),
  '0012': Object.freeze([]),
  '0013': Object.freeze(['con:time_entries:time_entries_source_check:']),
  // 0014 luo vain uusia tauluja: yhtäkään olemassa olevaa objektia ei poisteta.
  '0014': Object.freeze([])
});

/** Puhdas: ovatko poistot täsmälleen sallitut (kukin sallittu etuliite kerran)? */
export function checkRemovals(n, removed) {
  const allowed = ALLOWED_REMOVALS[n] || [];
  const problems = [];
  for (const line of removed) {
    if (!allowed.some(p => line.startsWith(p))) problems.push(`odottamaton poisto: ${line}`);
  }
  for (const p of allowed) {
    const hits = removed.filter(line => line.startsWith(p)).length;
    if (hits !== 1) problems.push(`sallittu poisto ${p} esiintyi ${hits} kertaa (odotus 1)`);
  }
  return problems;
}

/**
 * Aja migraatio todisteineen: tiivisteet ennen, migraatio (+ preflight,
 * verify, katalogiero), tiivisteet jälkeen. Palauttaa raporttirivin ja
 * listan ongelmista.
 */
export async function migrateWithEvidence(client, n, { verify = true, preflight = true } = {}) {
  const before = await snapshotTables(client);
  const record = await applyMigration(client, migrationName(n), { verify, preflight, diff: true });
  const problems = [];
  if (!record.ok) { problems.push(`${n} kaatui: ${record.error.message}`); return { record, problems }; }
  if (record.preflight?.error) problems.push(`preflight_${n} kaatui: ${record.preflight.error}`);
  for (const f of record.preflight?.fail || []) problems.push(`preflight_${n}: ${f}`);
  if (record.preflight?.countMismatch) problems.push(`preflight_${n}: poikkeavia_yhteensa ≠ FAIL-rivit`);
  if (record.verify?.error) problems.push(`verify_${n} kaatui: ${record.verify.error}`);
  for (const f of record.verify?.fail || []) problems.push(`verify_${n}: ${f}`);
  if (record.verify?.countMismatch) problems.push(`verify_${n}: poikkeavia_yhteensa ≠ FAIL-rivit`);
  const cmp = await compareSnapshot(client, before);
  record.legacy = cmp.perTable;
  problems.push(...cmp.problems);
  problems.push(...checkRemovals(n, record.schemaDiff.removed));
  return { record, problems };
}
