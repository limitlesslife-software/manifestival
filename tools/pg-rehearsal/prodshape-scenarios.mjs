// Tuotannon muotoiset skenaariot (prodshape.mjs:n malleista kloonattuina).
//
//   prodshape:fixture  inventaario 0008 = omistajan toimittama (10 muunnelmaa)
//   values:0010        0010 ei muuta yhtäkään vanhaa arvoa, ei kirjoita rivejä
//                      eikä tauluja uudelleen; uusien sarakkeiden arvot vanhoilla
//                      riveillä ovat odotetut (5 tilaa × projekti kytketty/irti)
//   prodshape:chain    0009..0015 tuotannon datalla: tiivisteet, xmin ja
//                      relfilenode jokaisen migraation ympärillä + kultaiset
//                      skeemaerot (tools/pg-rehearsal/expected/schema-diff-*.txt)
//   prodshape:pause    jokaisessa tauossa elävän ja seuraavan aallon oikeat
//                      kirjoitukset, verify, seuraava preflight ja peruutuksen
//                      kuiva-ajo (estääkö data peruutuksen)

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import {
  ROOT, OWNER, dropDatabase, runSql, runVerify, readSql, postgrestWrite, extractRollback,
  dryRunRollback, formatSchemaDiff, scalar
} from './lib.mjs';
import { migrationName } from './chain.mjs';
import {
  cloneProdShape, prodVariants, runInventory, loadExpectedInventory, compareInventory,
  expectedInventoryRows, migrateWithEvidence, goldenFile, PROD_IDS
} from './prodshape.mjs';
import { PAUSES, trainWaves, waveWrites } from './waves.mjs';

const NUMBERS = ['0009', '0010', '0011', '0012', '0013', '0014', '0015'];
const pad = n => String(n).padStart(4, '0');

export async function fixtureScenario({ fail }) {
  const { scoreInventory } = await import('../activation/score-inventory.mjs');
  const expected = loadExpectedInventory();
  const results = [];
  // Omistajan rivit sellaisenaan (ilman harjoittelua): mikä pysäyttäisi?
  const ownerOnly = scoreInventory(expectedInventoryRows(expected));
  results.push({ label: 'omistajan rivit sellaisenaan (absent-rivit puuttuvat)', informational: true,
                 decision: ownerOnly.decision, stops: ownerOnly.stops });
  for (const v of prodVariants()) {
    const db = `mv_rehearsal_psfix_${v.key}`;
    const client = await cloneProdShape('0008', db, v);
    try {
      const inv = await runInventory(client);
      const cmp = compareInventory(expected, inv.rows);
      const scored = scoreInventory(inv.rows);
      const pass = inv.unchanged && cmp.mismatches.length === 0 && scored.decision === 'GO' && scored.nextMigration === '0009';
      results.push({ label: `0008 ${v.key}`, pass, compared: cmp.compared, mismatches: cmp.mismatches,
                     recorded: cmp.recorded, decision: scored.decision, next: scored.nextMigration,
                     inventoryReadOnly: inv.unchanged });
      if (!pass) {
        fail('prodshape:fixture', `${v.key}: ${JSON.stringify({ mismatches: cmp.mismatches, decision: scored.decision, stops: scored.stops, unchanged: inv.unchanged })}`);
      }
    } finally { await client.end(); await dropDatabase(db); }
  }
  return results;
}

export async function valuesScenario({ fail }) {
  const results = [];
  for (const v of prodVariants()) {
    const db = `mv_rehearsal_val_${v.key}`;
    const client = await cloneProdShape('0009', db, v);
    try {
      const { record, problems } = await migrateWithEvidence(client, '0010');
      const r = (await client.query(`select
          (select count(*) from public.tasks) as tasks,
          (select count(*) from public.tasks where depends_on <> '{}'::text[] or milestone_id is not null) as tasks_new_nonempty,
          (select count(*) from public.goals where num_nonnulls(metric, unit, baseline_value, current_value,
                                                                target_value, measured_on, savings_goal_id) > 0) as goals_new_nonnull,
          (select count(*) from public.projects where milestone_id is not null) as projects_new_nonnull,
          (select count(*) from public.profile where automation_level is distinct from 1
                                                 or planning_buffer_ratio is distinct from 0.25) as profile_not_default,
          (select status from public.goals where id = $1) as goal_status,
          (select goal_id from public.projects where id = $2) as project_goal`, [PROD_IDS.goal, PROD_IDS.project])).rows[0];
      if (Number(r.tasks) !== 36) problems.push(`tehtäviä ${r.tasks}, odotus 36`);
      if (Number(r.tasks_new_nonempty)) problems.push(`${r.tasks_new_nonempty} tehtävällä depends_on ≠ '{}' tai milestone_id ≠ null`);
      if (Number(r.goals_new_nonnull)) problems.push(`${r.goals_new_nonnull} tavoitteella uusi sarake ei ole null`);
      if (Number(r.projects_new_nonnull)) problems.push(`${r.projects_new_nonnull} projektilla milestone_id ≠ null`);
      if (Number(r.profile_not_default)) problems.push(`${r.profile_not_default} profiilia ilman oletuksia 1 / 0.25`);
      if (r.goal_status !== v.goalStatus) problems.push(`tavoitteen tila ${r.goal_status}, odotus ${v.goalStatus}`);
      if ((r.project_goal === PROD_IDS.goal) !== v.projectLinked) problems.push(`projektin kytkentä ${r.project_goal}`);
      const pass = problems.length === 0;
      results.push({ variant: v.key, pass, problems, legacy: record.legacy, verify: record.verify, preflight: record.preflight });
      for (const p of problems) fail('values:0010', `${v.key}: ${p}`);
    } finally { await client.end(); await dropDatabase(db); }
  }
  return results;
}

function compareGolden(n, diff, { writeGolden }) {
  const text = formatSchemaDiff(diff);
  const file = join(ROOT, goldenFile(n));
  const before = existsSync(file) ? readFileSync(file, 'utf8').replace(/\r\n/g, '\n') : null;
  if (writeGolden) {
    // Kirjoitetaan vain uusi tai muuttunut ero: muuttumaton kultainen
    // tiedosto jää tavu tavulta ennalleen, ja raportti kertoo, oliko
    // vanha tiedosto sama ('sama'), eri ('ERI') vai puuttuiko se.
    const changed = before !== text;
    if (changed) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, text);
    }
    return { written: changed, same: true, previously: before === null ? 'puuttui' : changed ? 'ERI' : 'sama' };
  }
  if (before === null) return { same: false, reason: 'kultainen tiedosto puuttuu' };
  const golden = before;
  if (golden === text) return { same: true };
  const g = new Set(golden.split('\n'));
  const t = new Set(text.split('\n'));
  return { same: false, missing: [...g].filter(x => x && !t.has(x)), unexpected: [...t].filter(x => x && !g.has(x)) };
}

/** Rivilajien määrät kultaisesta erosta (raporttiin). */
export function diffSummary(diff) {
  const count = (list, kind) => list.filter(x => x.startsWith(`${kind}:`)).length;
  const kinds = ['rel', 'col', 'idx', 'con', 'pol', 'trg', 'fn', 'nsp'];
  return {
    added: Object.fromEntries(kinds.map(k => [k, count(diff.added, k)]).filter(([, v]) => v)),
    removed: Object.fromEntries(kinds.map(k => [k, count(diff.removed, k)]).filter(([, v]) => v))
  };
}

export async function chainScenario({ fail, writeGolden = false }) {
  const results = [];
  const db = 'mv_rehearsal_pschain';
  const client = await cloneProdShape('0008', db);
  try {
    for (const n of NUMBERS) {
      const { record, problems } = await migrateWithEvidence(client, n);
      const golden = record.ok ? compareGolden(n, record.schemaDiff, { writeGolden }) : { same: false };
      if (!golden.same) problems.push(`skeemaero ≠ ${goldenFile(n)}: ${JSON.stringify(golden)}`);
      results.push({ migration: n, pass: problems.length === 0, problems, legacy: record.legacy,
                     diff: record.ok ? diffSummary(record.schemaDiff) : null, golden,
                     verify: record.verify, preflight: record.preflight, ms: record.ms });
      for (const p of problems) fail('prodshape:chain', `${n}: ${p}`);
      if (!record.ok) break;
    }
  } finally { await client.end(); await dropDatabase(db); }
  return results;
}

/** Aja aallon kirjoitukset; palauta {ok, failed}. */
export async function runWrites(client, ops) {
  const failed = [];
  for (const op of ops) {
    const r = await postgrestWrite(client, OWNER, op.table, op.payload, op);
    if (!r.ok || r.rowCount !== 1) failed.push(`${op.label}: ${r.ok ? `rivejä ${r.rowCount}` : `${r.code} ${r.message}`}`);
  }
  return { count: ops.length, failed };
}

/** Syy, jos peruutus on estetty: tunnetut estäjät luettuna kannasta. */
async function rollbackBlockers(client, n) {
  if (n === '0010') {
    return { maintenanceGoals: Number(await scalar(client, `select count(*) from public.goals where status = 'maintenance'`)) };
  }
  if (n === '0012') {
    return { runningTimersTable: Boolean(await scalar(client, `select to_regclass('public.running_timers') is not null`)) };
  }
  return {};
}

export async function pauseScenario({ fail }) {
  const train = trainWaves();
  const results = [];
  const db = 'mv_rehearsal_pause';
  const client = await cloneProdShape('0008', db);
  try {
    let slot = 0;
    // Yksi arjen asetusrivi käyttäjää kohti: kun rivi on kirjoitettu,
    // myöhemmät sarjat eivät lisää toista (sovellus päivittäisi sen).
    let singletonsWritten = false;
    const writesFor = async (wave, prefix) => {
      const ops = await waveWrites(wave, { prefix, train, slot: slot++, insertSingletons: !singletonsWritten });
      if (ops.some(o => o.table === 'life_settings' && o.method === 'insert')) singletonsWritten = true;
      return ops;
    };
    for (const pause of PAUSES) {
      const out = { after: pause.after, live: pause.live, next: pause.next };
      const problems = [];
      if (pause.after !== '0008') {
        const { record, problems: p } = await migrateWithEvidence(client, pause.after);
        out.migration = { ok: record.ok, legacy: record.legacy, verify: record.verify, preflight: record.preflight };
        problems.push(...p);
        if (!record.ok) { results.push({ ...out, pass: false, problems }); for (const x of problems) fail('prodshape:pause', `${pause.after}: ${x}`); break; }
      }
      const live = await runWrites(client, await writesFor(pause.live, `p${pause.after}${pause.live.toLowerCase()}`));
      out.liveWrites = live;
      problems.push(...live.failed.map(f => `elävä aalto ${pause.live}: ${f}`));
      if (pause.next) {
        const next = await runWrites(client, await writesFor(pause.next, `p${pause.after}${pause.next.toLowerCase()}`));
        out.nextWrites = next;
        problems.push(...next.failed.map(f => `seuraava aalto ${pause.next}: ${f}`));
      }
      if (pause.after >= '0009') {
        const v = await runVerify(client, `supabase/verify/verify_${pause.after}.sql`);
        out.verifyAfterWrites = v.ok ? { rows: v.rows.length, fail: v.failed.map(r => `${r.check_no} ${r.check_name}: ${r.details}`), poikkeavia: v.poikkeavia } : { error: v.error.message };
        if (!v.ok) problems.push(`verify_${pause.after} kaatui: ${v.error.message}`);
        else {
          for (const f of v.failed) problems.push(`verify_${pause.after} kirjoitusten jälkeen: ${f.check_no} ${f.check_name}: ${f.details}`);
          if (v.countMismatch) problems.push(`verify_${pause.after}: poikkeavia_yhteensa ≠ FAIL-rivit`);
        }
      }
      const nextN = pad(Number(pause.after) + 1);
      if (NUMBERS.includes(nextN)) {
        const p = await runVerify(client, `supabase/preflight/preflight_${nextN}.sql`);
        out.nextPreflight = p.ok ? { preflight: nextN, rows: p.rows.length, fail: p.failed.map(r => `${r.check_no} ${r.check_name}: ${r.details}`) } : { error: p.error.message };
        if (!p.ok) problems.push(`preflight_${nextN} kaatui: ${p.error.message}`);
        else for (const f of p.failed) problems.push(`preflight_${nextN}: ${f.check_no} ${f.check_name}: ${f.details}`);
      }
      if (pause.after >= '0009') {
        const rb = extractRollback(readSql(`supabase/migrations/${migrationName(pause.after)}.sql`));
        const dry = await runSql(client, dryRunRollback(rb));
        out.rollbackDryRun = { ok: dry.ok, error: dry.error?.message || null, code: dry.error?.code || null,
                               blockers: dry.ok ? {} : await rollbackBlockers(client, pause.after) };
        // Odotus: vain 0010:n peruutus estyy, ja vain ylläpitotilan tavoitteiden takia (aalto G kirjoittaa niitä).
        const expectBlocked = pause.after === '0010';
        if (dry.ok === expectBlocked) problems.push(`peruutuksen kuiva-ajo ${pause.after}: ${dry.ok ? 'meni läpi, odotettiin estettä (ylläpitotila)' : `estyi odottamatta: ${dry.error.message}`}`);
      }
      out.pass = problems.length === 0;
      out.problems = problems;
      results.push(out);
      for (const x of problems) fail('prodshape:pause', `${pause.after}: ${x}`);
    }
  } finally { await client.end(); await dropDatabase(db); }
  return results;
}
