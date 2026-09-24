// Migraatioketju 0001 -> 0013 tuotannon muotoisesta lähtötilasta.
//
// Jokaisen migraation jälkeen ajetaan sen oma supabase/verify/verify_XXXX.sql,
// ja FAIL-rivit raportoidaan. Ennen migraatioita 0009–0013 ajetaan
// supabase/preflight/preflight_XXXX.sql, jos sellainen on.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  ROOT, connect, runSql, runVerify, readSql, catalogFingerprint
} from './lib.mjs';
import { baselineSql, usersSql } from './baseline.mjs';

export const MIGRATIONS = Object.freeze([
  '0001_auth_user_scoping', '0002_task_domain_fields', '0003_routines',
  '0004_goals_projects', '0005_notification_preferences', '0006_wellbeing',
  '0007_finance', '0008_ai_audit', '0009_finance_2', '0010_goal_to_action',
  '0011_personal_assistant', '0012_life_alignment', '0013_alignment_reality'
]);

export const numberOf = name => name.slice(0, 4);

export async function prepareBaseline(client, variant) {
  const steps = [
    ['supabase-shim', readSql('tools/pg-rehearsal/supabase-shim.sql')],
    ['synthetic-users', usersSql()],
    [`baseline-pre0001(${variant})`, baselineSql(variant)]
  ];
  for (const [label, sql] of steps) {
    const out = await runSql(client, sql);
    if (!out.ok) throw new Error(`${label}: ${out.error.message}`);
  }
}

/**
 * Aja yksi migraatio + sen todennus. Palauttaa raporttirivin.
 * `expectFailure` = migraation kuuluu keskeytyä (virhetestit).
 */
export async function applyMigration(client, name, { verify = true, preflight = true } = {}) {
  const n = numberOf(name);
  const record = { migration: name };
  const pre = `supabase/preflight/preflight_${n}.sql`;
  if (preflight && existsSync(join(ROOT, pre))) {
    const p = await runVerify(client, pre);
    record.preflight = p.ok
      ? { rows: p.rows.length, fail: p.failed.map(r => `${r.check_no} ${r.check_name}: ${r.details}`) }
      : { error: p.error.message };
  }
  const before = await catalogFingerprint(client);
  const t0 = Date.now();
  const out = await runSql(client, readSql(`supabase/migrations/${name}.sql`));
  record.ms = Date.now() - t0;
  record.ok = out.ok;
  if (!out.ok) record.error = out.error;
  const after = await catalogFingerprint(client);
  record.catalogChanged = before.hash !== after.hash;
  const ver = `supabase/verify/verify_${n}.sql`;
  if (verify && out.ok && existsSync(join(ROOT, ver))) {
    const v = await runVerify(client, ver);
    record.verify = v.ok
      ? { rows: v.rows.length, pass: v.rows.filter(r => r.status === 'PASS').length,
          fail: v.failed.map(r => `${r.check_no} ${r.check_name}: ${r.details}`) }
      : { error: v.error.message };
  }
  return record;
}

if (process.argv[1] && process.argv[1].endsWith('chain.mjs')) {
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
