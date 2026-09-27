// Migraatioketju 0001 -> 0014 tuotannon muotoisesta lähtötilasta.
//
// Jokaisen migraation jälkeen ajetaan sen oma supabase/verify/verify_XXXX.sql,
// ja FAIL-rivit raportoidaan. Ennen migraatioita 0009–0014 ajetaan
// supabase/preflight/preflight_XXXX.sql, jos sellainen on.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  ROOT, OWNER, USER_B, connect, runSql, runVerify, readSql, catalogItems, diffCatalog, isMain
} from './lib.mjs';
import { baselineSql, usersSql } from './baseline.mjs';

export const MIGRATIONS = Object.freeze([
  '0001_auth_user_scoping', '0002_task_domain_fields', '0003_routines',
  '0004_goals_projects', '0005_notification_preferences', '0006_wellbeing',
  '0007_finance', '0008_ai_audit', '0009_finance_2', '0010_goal_to_action',
  '0011_personal_assistant', '0012_life_alignment', '0013_alignment_reality',
  '0014_daily_life'
]);

export const numberOf = name => name.slice(0, 4);
export const migrationName = n => MIGRATIONS.find(m => numberOf(m) === n);

/**
 * Lähtötila ennen 0001:tä. `users` = auth.users-rivit (oletus omistaja +
 * käyttäjä B; tuotannon muoto on pelkkä omistaja, ks. prodshape.mjs).
 */
export async function prepareBaseline(client, variant, { users = [OWNER, USER_B] } = {}) {
  const steps = [
    ['supabase-shim', readSql('tools/pg-rehearsal/supabase-shim.sql')],
    ['synthetic-users', usersSql(users)],
    [`baseline-pre0001(${variant})`, baselineSql(variant)]
  ];
  for (const [label, sql] of steps) {
    const out = await runSql(client, sql);
    if (!out.ok) throw new Error(`${label}: ${out.error.message}`);
  }
}

function summarizeVerify(v) {
  return v.ok
    ? { rows: v.rows.length, pass: v.rows.filter(r => r.status === 'PASS').length,
        fail: v.failed.map(r => `${r.check_no} ${r.check_name}: ${r.details}`),
        poikkeavia: v.poikkeavia, countMismatch: v.countMismatch }
    : { error: v.error.message };
}

/**
 * Aja yksi migraatio + sen todennus. Palauttaa raporttirivin.
 * `diff: true` tallentaa katalogin eron (record.schemaDiff).
 */
export async function applyMigration(client, name, { verify = true, preflight = true, diff = false } = {}) {
  const n = numberOf(name);
  const record = { migration: name };
  const pre = `supabase/preflight/preflight_${n}.sql`;
  if (preflight && existsSync(join(ROOT, pre))) {
    const p = await runVerify(client, pre);
    record.preflight = p.ok
      ? { rows: p.rows.length, fail: p.failed.map(r => `${r.check_no} ${r.check_name}: ${r.details}`),
          poikkeavia: p.poikkeavia, countMismatch: p.countMismatch }
      : { error: p.error.message };
  }
  const before = await catalogItems(client);
  const t0 = Date.now();
  const out = await runSql(client, readSql(`supabase/migrations/${name}.sql`));
  record.ms = Date.now() - t0;
  record.ok = out.ok;
  if (!out.ok) record.error = out.error;
  const after = await catalogItems(client);
  const d = diffCatalog(before, after);
  record.catalogChanged = d.added.length > 0 || d.removed.length > 0;
  if (diff) record.schemaDiff = d;
  const ver = `supabase/verify/verify_${n}.sql`;
  if (verify && out.ok && existsSync(join(ROOT, ver))) {
    record.verify = summarizeVerify(await runVerify(client, ver));
  }
  return record;
}

if (isMain(import.meta.url)) {
  const { createDatabase, dropDatabase } = await import('./lib.mjs');
  const variant = process.argv[2] || 'text';
  const db = `mv_rehearsal_chain_${variant}`;
  await createDatabase(db);
  const client = await connect(db);
  try {
    await prepareBaseline(client, variant);
    for (const m of MIGRATIONS) {
      const r = await applyMigration(client, m);
      console.log(JSON.stringify(r));
      if (!r.ok) break;
    }
  } finally {
    await client.end();
    if (!process.env.KEEP_DB) await dropDatabase(db);
  }
}
