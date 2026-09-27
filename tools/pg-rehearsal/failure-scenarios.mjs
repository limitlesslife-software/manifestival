// Virhe- ja lukitusskenaariot tuotannon muotoisilla klooneilla.
//
//   failure:0010-locks   estäjämatriisi (goals/tasks/projects/profile/auth.users
//                        × ACCESS SHARE / ROW EXCLUSIVE), myöhäinen virhe
//                        tilarajoitteen vaihdon JÄLKEEN (event trigger
//                        skeemassa rehearsal_inject), sovelluksen jumin
//                        mittaus, lukkikkotilanne, keskeytyneen istunnon
//                        lukot; sama matriisi 0009:lle (bills), 0011:lle
//                        (tasks) ja 0014:lle (goals, auth.users: vain
//                        kirjoitus estää); 0014:n uudelleenajo goals-
//                        kirjoituksen aikana sanoo "JO AJETTU" heti.
//                        Vertailuna 0010 ennen F11:tä (git).
//   verify:null          verify_0009..0014: poikkeavia_yhteensa = FAIL-rivit
//                        myös kun tarkistus palauttaa NULLin
//   preflight:blockers   uudet esteet-rivit (lukitut taulut) ja
//                        politiikkamäärät havaitsevat esteen ETUKÄTEEN;
//                        tilin poiston oletukset (F13): vieras public-taulu
//                        preflight_0009:ssä, verify_0013:n riveillä 26–28 ja
//                        verify_0014:n riveillä 34–36
//   role:nonsuper        migraatiot NOSUPERUSER-omistajaroolina; preflightin
//                        esteet-rivit pg_read_all_stats-oikeuden kanssa/ilman

import { execFileSync } from 'node:child_process';
import {
  ROOT, OWNER, connect, dropDatabase, runSql, runVerify, readSql, catalogItems, diffCatalog, scalar
} from './lib.mjs';
import { migrationName, applyMigration } from './chain.mjs';
import { cloneProdShape, snapshotTables, compareSnapshot, PROD_IDS } from './prodshape.mjs';
import { LOCKED_TABLES } from '../activation/build-preflights.mjs';

const LOCK_TIMEOUT_MS = 5000;
const WAIT_MIN = 4500;
const WAIT_MAX = 7000;
/** 0010 ennen F11:n lukitusjärjestystä (vertailu). */
export const F11_BASELINE_REF = '5aa0d53';

/** Lukkotilojen ristiriidat (PostgreSQL:n taulukko), vain käytetyt. */
const CONFLICTS = Object.freeze({
  AccessExclusiveLock: new Set(['AccessShareLock', 'RowShareLock', 'RowExclusiveLock', 'ShareUpdateExclusiveLock',
    'ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock']),
  ShareRowExclusiveLock: new Set(['RowExclusiveLock', 'ShareUpdateExclusiveLock', 'ShareLock',
    'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock'])
});

/** Migraatioiden lukot tauluittain (ALTER = ACCESS EXCLUSIVE, viite = SHARE ROW EXCLUSIVE). */
export const MIGRATION_LOCKS = Object.freeze({
  '0009': { 'public.bills': 'AccessExclusiveLock', 'auth.users': 'ShareRowExclusiveLock' },
  '0010': { 'public.goals': 'AccessExclusiveLock', 'public.tasks': 'AccessExclusiveLock',
            'public.projects': 'AccessExclusiveLock', 'public.profile': 'AccessExclusiveLock',
            'auth.users': 'ShareRowExclusiveLock' },
  '0011': { 'public.tasks': 'ShareRowExclusiveLock', 'auth.users': 'ShareRowExclusiveLock' },
  // 0014 ei muuta olemassa olevaa taulua: vain uusien taulujen vierasavaimet
  // (tavoite, omistaja) ottavat viitattuun tauluun SHARE ROW EXCLUSIVE -lukon.
  '0014': { 'public.goals': 'ShareRowExclusiveLock', 'auth.users': 'ShareRowExclusiveLock' }
});

export const BLOCKER_MODES = Object.freeze({ 'ACCESS SHARE': 'AccessShareLock', 'ROW EXCLUSIVE': 'RowExclusiveLock' });

/** Puhdas: estääkö estäjän tila migraation lukon? */
export function blocks(migrationLock, blockerLock) {
  return CONFLICTS[migrationLock]?.has(blockerLock) ?? true;
}

const OWNER_COLUMN = { 'public.profile': 'id' };

/**
 * Avaa estäjä: toinen istunto, jonka transaktio jää auki.
 * ACCESS SHARE = sovelluksen / editorin lukukysely; ROW EXCLUSIVE =
 * sovelluksen kirjoitus (roolina authenticated, oma rivi), auth.usersissa
 * GoTruen kaltainen päivitys.
 */
async function openBlocker(db, table, mode) {
  const c = await connect(db);
  await c.query('begin');
  if (mode === 'ACCESS SHARE') {
    await c.query(`select count(*) from ${table}`);
  } else if (table === 'auth.users') {
    await c.query(`update auth.users set email = email where id = $1`, [OWNER]);
  } else {
    await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: OWNER, role: 'authenticated' })]);
    await c.query('set local role authenticated');
    const col = OWNER_COLUMN[table] || 'user_id';
    await c.query(`update ${table} set ${col} = ${col} where ${col} = $1`, [OWNER]);
  }
  return c;
}

async function closeBlocker(c) {
  try { await c.query('rollback'); } catch { /* jo peruttu */ }
  await c.end();
}

async function statusCheckDef(client) {
  return scalar(client, `select pg_get_constraintdef(oid) from pg_constraint where conname = 'goals_status_check'`);
}

async function relationLocksOf(monitor, pid) {
  return Number(await scalar(monitor, `select count(*) from pg_locks where pid = $1 and locktype = 'relation'`, [pid]));
}

/** Asenna DDL-laskuri: event trigger ilmoittaa jokaisen DDL-komennon alun. */
async function installDdlCounter(client) {
  await client.query(`
    create schema if not exists rehearsal_inject;
    create or replace function rehearsal_inject.count_ddl() returns event_trigger language plpgsql as $$
    begin raise notice 'mv-ddl: %', tg_tag; end $$;
    drop event trigger if exists mv_rehearsal_count_ddl;
    create event trigger mv_rehearsal_count_ddl on ddl_command_start execute function rehearsal_inject.count_ddl();`);
}

/** Aja migraatio ja laske, montako DDL-komentoa ehti alkaa. */
async function runCounted(client, sql, opts) {
  client.notices.length = 0;
  const t0 = Date.now();
  const out = await runSql(client, sql, opts);
  return { ...out, ms: Date.now() - t0, ddlStarted: client.notices.filter(n => n.startsWith('mv-ddl:')).length };
}

function gitShow(ref, path) {
  try {
    return execFileSync('git', ['-C', ROOT, 'show', `${ref}:${path}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return null; }
}

/** Yksi estäjätapaus: kloonaa, estä, aja, tarkista, vapauta, aja uudelleen. */
async function blockerCase({ n, table, mode, sql, label, fail, scenario }) {
  const prev = String(Number(n) - 1).padStart(4, '0');
  const db = `mv_rehearsal_lk_${n}_${table.replace(/\W/g, '_')}_${mode === 'ACCESS SHARE' ? 'as' : 're'}`.toLowerCase();
  const client = await cloneProdShape(prev, db);
  const monitor = await connect(db);
  const expectBlocked = blocks(MIGRATION_LOCKS[n][table], BLOCKER_MODES[mode]);
  const out = { migration: n, table, mode, expectBlocked, label };
  try {
    await installDdlCounter(client);
    const pid = Number(await scalar(client, 'select pg_backend_pid()'));
    const itemsBefore = await catalogItems(client);
    const before = await snapshotTables(client);
    const defBefore = await statusCheckDef(client);
    const blocker = await openBlocker(db, table, mode);
    let run;
    try {
      run = await runCounted(client, sql);
    } finally {
      out.migrationRelationLocksAfter = await relationLocksOf(monitor, pid);
      await closeBlocker(blocker);
    }
    Object.assign(out, { ok: run.ok, waitedMs: run.ms, ddlStarted: run.ddlStarted, error: run.error?.message || null, code: run.error?.code || null });
    const problems = [];
    if (expectBlocked) {
      if (run.ok) problems.push('migraatio meni läpi, vaikka estäjä piti ristiriitaista lukkoa');
      else {
        if (!/lock timeout/i.test(run.error.message)) problems.push(`virhe ei ole lukon aikakatkaisu: ${run.error.message}`);
        if (run.ms < WAIT_MIN || run.ms > WAIT_MAX) problems.push(`odotus ${run.ms} ms, odotus ${WAIT_MIN}–${WAIT_MAX}`);
        const d = diffCatalog(itemsBefore, await catalogItems(client));
        out.catalogUnchanged = !d.added.length && !d.removed.length;
        if (!out.catalogUnchanged) problems.push(`katalogi muuttui: ${JSON.stringify(d).slice(0, 400)}`);
        const cmp = await compareSnapshot(client, before);
        if (cmp.problems.length) problems.push(...cmp.problems);
        out.dataUnchanged = cmp.problems.length === 0;
        // Tilarajoite on täsmälleen sama kuin ennen ajoa; 0010:n kohdalla
        // se on yhä 0004:n viiden arvon versio (vaihto peruttiin).
        const def = await statusCheckDef(client);
        out.statusCheckUnchanged = def === defBefore && (n !== '0010' || !String(def).includes('maintenance'));
        if (!out.statusCheckUnchanged) problems.push(`goals_status_check muuttui: ${def}`);
        if (out.migrationRelationLocksAfter !== 0) problems.push(`migraation istunnolla ${out.migrationRelationLocksAfter} relaatiolukkoa epäonnistumisen jälkeen`);
        const retry = await runSql(client, sql);
        out.retryOk = retry.ok;
        if (!retry.ok) problems.push(`uudelleenajo estäjän vapauduttua kaatui: ${retry.error.message}`);
      }
    } else if (!run.ok) {
      problems.push(`migraatio kaatui, vaikka estäjän lukko ei ole ristiriidassa: ${run.error.message}`);
    }
    out.pass = problems.length === 0;
    out.problems = problems;
    for (const p of problems) fail(scenario, `${n} ${table} ${mode}: ${p}`);
  } finally {
    await monitor.end();
    await client.end();
    await dropDatabase(db);
  }
  return out;
}

/** Odota, kunnes istunto pid odottaa lukkoa taulussa (tai aikaraja). */
async function waitUntilWaiting(monitor, pid, table, timeoutMs = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const waiting = Number(await scalar(monitor,
      `select count(*) from pg_locks where pid = $1 and not granted and relation = to_regclass($2)`, [pid, table]));
    if (waiting) return Date.now() - t0;
    await new Promise(r => setTimeout(r, 25));
  }
  return null;
}

/** Sovelluksen jumi: kauanko tasks-luku odottaa, kun migraatio odottaa profile-lukkoa. */
async function stallCase({ sql, label, fail, scenario }) {
  const db = `mv_rehearsal_lk_stall_${label.replace(/\W/g, '_')}`.toLowerCase().slice(0, 60);
  const client = await cloneProdShape('0009', db);
  const monitor = await connect(db);
  const app = await connect(db);
  const out = { label };
  try {
    await installDdlCounter(client);
    const pid = Number(await scalar(client, 'select pg_backend_pid()'));
    const blocker = await openBlocker(db, 'public.profile', 'ROW EXCLUSIVE');
    try {
      client.notices.length = 0;
      const t0 = Date.now();
      const migration = runSql(client, sql).then(r => ({ ...r, ms: Date.now() - t0 }));
      const waitedAfter = await waitUntilWaiting(monitor, pid, 'public.profile');
      out.migrationWaitingOnProfileAfterMs = waitedAfter;
      const s0 = Date.now();
      await app.query('select count(*) from public.tasks');
      out.appStallMs = Date.now() - s0;
      const run = await migration;
      out.migrationOk = run.ok;
      out.migrationMs = run.ms;
      out.ddlStartedBeforeFailure = client.notices.filter(n => n.startsWith('mv-ddl:')).length;
      out.error = run.error?.message || null;
      const problems = [];
      if (waitedAfter === null) problems.push('migraatio ei jäänyt odottamaan profile-lukkoa');
      if (run.ok) problems.push('migraatio meni läpi estäjästä huolimatta');
      if (out.appStallMs > LOCK_TIMEOUT_MS + 1500) problems.push(`sovelluksen jumi ${out.appStallMs} ms > lock_timeout + 1,5 s`);
      out.pass = problems.length === 0;
      out.problems = problems;
      for (const p of problems) fail(scenario, `${label}: ${p}`);
    } finally {
      await closeBlocker(blocker);
    }
  } finally {
    await app.end();
    await monitor.end();
    await client.end();
    await dropDatabase(db);
  }
  return out;
}

/**
 * Lukkiutuminen: sovellus pitää projects-rivilukkoa (ROW EXCLUSIVE), 0010
 * odottaa projectsia pitäen goalsia, ja sovellus lisää projektin, jonka
 * vierasavain tarvitsee goalsin. Hyväksyttävät lopputilat: migraatio
 * kaatuu kiinni (40P01/55P03, katalogi ennallaan) TAI sovellus saa 40P01
 * ja migraatio valmistuu kokonaan (verify 0 FAIL). Ei koskaan välitilaa.
 */
async function deadlockCase({ sql, label, fail, scenario }) {
  const db = `mv_rehearsal_lk_dl_${label.replace(/\W/g, '_')}`.toLowerCase().slice(0, 60);
  const client = await cloneProdShape('0009', db);
  const monitor = await connect(db);
  const app = await connect(db);
  const out = { label };
  try {
    const pid = Number(await scalar(client, 'select pg_backend_pid()'));
    const itemsBefore = await catalogItems(client);
    await app.query('begin');
    await app.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: OWNER, role: 'authenticated' })]);
    await app.query('set local role authenticated');
    await app.query(`update public.projects set name = name where id = $1`, [PROD_IDS.project]);
    const migration = runSql(client, sql);
    out.migrationWaitingOnProjectsAfterMs = await waitUntilWaiting(monitor, pid, 'public.projects', 6000);
    let appResult;
    try {
      await app.query(`insert into public.projects (id, name, goal_id) values ('dl-proj', 'Lukkiutuminen', $1)`, [PROD_IDS.goal]);
      appResult = { ok: true };
    } catch (error) {
      appResult = { ok: false, code: error.code, message: error.message };
    }
    await app.query('rollback').catch(() => {});
    const run = await migration;
    out.app = appResult;
    out.migration = { ok: run.ok, code: run.error?.code || null, error: run.error?.message || null };
    const problems = [];
    if (out.migrationWaitingOnProjectsAfterMs === null) problems.push('migraatio ei jäänyt odottamaan projects-lukkoa');
    if (run.ok) {
      const v = await runVerify(client, 'supabase/verify/verify_0010.sql');
      out.verifyFail = v.ok ? v.failed.length : `virhe ${v.error.message}`;
      if (!v.ok || v.failed.length) problems.push(`migraatio valmistui mutta verify: ${JSON.stringify(out.verifyFail)}`);
      if (appResult.ok || appResult.code !== '40P01') problems.push(`sovellus ei saanut 40P01:tä: ${JSON.stringify(appResult)}`);
    } else {
      const d = diffCatalog(itemsBefore, await catalogItems(client));
      out.catalogUnchanged = !d.added.length && !d.removed.length;
      if (!out.catalogUnchanged) problems.push('migraatio kaatui mutta katalogi muuttui (välitila)');
      if (!['40P01', '55P03'].includes(run.error.code)) problems.push(`odottamaton virhe ${run.error.code} ${run.error.message}`);
    }
    out.pass = problems.length === 0;
    out.problems = problems;
    for (const p of problems) fail(scenario, `${label}: ${p}`);
  } finally {
    await app.end();
    await monitor.end();
    await client.end();
    await dropDatabase(db);
  }
  return out;
}

/** Myöhäinen virhe tilarajoitteen vaihdon jälkeen: profile-taulun ALTER kaatuu. */
async function lateFailureCase({ sql, fail, scenario }) {
  const db = 'mv_rehearsal_lk_late_0010';
  const client = await cloneProdShape('0009', db);
  const out = { label: '0010 kaatuu profile-vaiheessa (goals_status_check jo vaihdettu)' };
  try {
    await client.query(`
      create schema rehearsal_inject;
      create function rehearsal_inject.fail_on_profile() returns event_trigger language plpgsql as $$
      begin
        if exists (select 1 from pg_event_trigger_ddl_commands() where object_identity = 'public.profile') then
          raise exception 'mv-inject: myöhäinen virhe profile-vaiheessa';
        end if;
      end $$;
      create event trigger mv_rehearsal_fail_on_profile on ddl_command_end
        when tag in ('ALTER TABLE') execute function rehearsal_inject.fail_on_profile();`);
    await installDdlCounter(client);
    const itemsBefore = await catalogItems(client);
    const before = await snapshotTables(client);
    const defBefore = await statusCheckDef(client);
    const run = await runCounted(client, sql);
    const d = diffCatalog(itemsBefore, await catalogItems(client));
    const cmp = await compareSnapshot(client, before);
    const def = await statusCheckDef(client);
    Object.assign(out, { ok: run.ok, error: run.error?.message || null, ddlStarted: run.ddlStarted,
      catalogUnchanged: !d.added.length && !d.removed.length, dataUnchanged: cmp.problems.length === 0,
      statusCheck5: def === defBefore && !String(def).includes('maintenance'),
      publicObjectsFromInjection: Number(await scalar(client,
        `select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname like 'fail_on%'`)) });
    const problems = [];
    if (run.ok) problems.push('migraatio meni läpi injektiosta huolimatta');
    else if (!/mv-inject/.test(run.error.message)) problems.push(`väärä virhe: ${run.error.message}`);
    if (run.ddlStarted < 20) problems.push(`vain ${run.ddlStarted} DDL-komentoa ennen virhettä — virhe ei osunut vaihdon jälkeen`);
    if (!out.catalogUnchanged) problems.push(`katalogi muuttui: ${JSON.stringify(d).slice(0, 300)}`);
    if (!out.dataUnchanged) problems.push(...cmp.problems);
    if (!out.statusCheck5) problems.push(`goals_status_check ei ole 5 arvon alkuperäinen: ${def}`);
    out.pass = problems.length === 0;
    out.problems = problems;
    for (const p of problems) fail(scenario, `myöhäinen virhe: ${p}`);
  } finally {
    await client.end();
    await dropDatabase(db);
  }
  return out;
}

/** Keskeytynyt istunto (ei rollbackia): pitääkö se lukkoja, näkyykö preflightissa? */
async function abortedSessionCase({ sql, fail, scenario }) {
  const db = 'mv_rehearsal_lk_aborted_0010';
  const client = await cloneProdShape('0009', db);
  const monitor = await connect(db);
  const out = { label: '0010 kaatuu lukkoon, istunto jää keskeytyneeseen transaktioon' };
  try {
    const pid = Number(await scalar(client, 'select pg_backend_pid()'));
    const blocker = await openBlocker(db, 'public.profile', 'ACCESS SHARE');
    const run = await runSql(client, sql, { keepAborted: true });
    await closeBlocker(blocker);
    out.migrationError = run.error?.message || null;
    out.state = await scalar(monitor, 'select state from pg_stat_activity where pid = $1', [pid]);
    out.relationLocksHeld = await relationLocksOf(monitor, pid);
    const pre = await runVerify(monitor, 'supabase/preflight/preflight_0010.sql');
    out.preflightFailedRows = pre.ok ? pre.failed.map(r => `${r.check_no} ${r.check_name}`) : [pre.error.message];
    await client.query('rollback');
    const pre2 = await runVerify(monitor, 'supabase/preflight/preflight_0010.sql');
    out.preflightAfterRollbackFail = pre2.ok ? pre2.failed.length : pre2.error.message;
    const problems = [];
    if (run.ok) problems.push('migraatio meni läpi');
    if (out.state !== 'idle in transaction (aborted)') problems.push(`istunnon tila ${out.state}`);
    if (out.relationLocksHeld !== 0) problems.push(`keskeytynyt istunto pitää ${out.relationLocksHeld} relaatiolukkoa`);
    if (!pre.ok || !pre.failed.some(r => /idle in transaction/.test(r.check_name))) problems.push('preflight_0010 ei ilmoittanut keskeytynyttä istuntoa');
    if (pre.ok && pre.failed.length !== 1) problems.push(`preflight_0010: odotettiin 1 FAIL (idle), saatiin ${pre.failed.length}`);
    if (out.preflightAfterRollbackFail !== 0) problems.push(`preflight_0010 rollbackin jälkeen: ${out.preflightAfterRollbackFail}`);
    out.pass = problems.length === 0;
    out.problems = problems;
    for (const p of problems) fail(scenario, `keskeytynyt istunto: ${p}`);
  } finally {
    await monitor.end();
    await client.end();
    await dropDatabase(db);
  }
  return out;
}

/** 0010 ennen kuin katalogitarkistukset siirrettiin lukituksen eteen (vertailu). */
export const RERUN_BASELINE_REF = 'e44644c';

/**
 * Uudelleenajo, kun sovellus pitää lukkoa: 0010 on jo ajettu ja goals on
 * avoimen kirjoituksen lukitsema. Katalogitarkistus ennen lukitusta
 * sanoo "JO AJETTU" heti — ei lukon aikakatkaisua 5 s:n päästä.
 */
async function rerunUnderLockCase({ sql, label, fail, scenario, n = '0010' }) {
  const db = `mv_rehearsal_lk_rerun_${n}_${label.replace(/\W/g, '_')}`.toLowerCase().slice(0, 60);
  const client = await cloneProdShape(n, db);
  const monitor = await connect(db);
  const out = { migration: n, label: `${label}: ${n} uudelleen, kun goals on avoimen kirjoituksen lukitsema` };
  try {
    const pid = Number(await scalar(client, 'select pg_backend_pid()'));
    const itemsBefore = await catalogItems(client);
    const blocker = await openBlocker(db, 'public.goals', 'ROW EXCLUSIVE');
    let run;
    try {
      const t0 = Date.now();
      run = await runSql(client, sql);
      out.waitedMs = Date.now() - t0;
    } finally {
      out.migrationRelationLocksAfter = await relationLocksOf(monitor, pid);
      await closeBlocker(blocker);
    }
    const d = diffCatalog(itemsBefore, await catalogItems(client));
    Object.assign(out, { ok: run.ok, error: run.error?.message || null, catalogUnchanged: !d.added.length && !d.removed.length });
    const problems = [];
    if (run.ok) problems.push('uudelleenajo meni läpi');
    else if (!/JO AJETTU/.test(run.error.message)) problems.push(`virhe ei ole "JO AJETTU": ${run.error.message}`);
    if (out.waitedMs >= WAIT_MIN) problems.push(`odotti ${out.waitedMs} ms (lukkoa) ennen vastausta`);
    if (!out.catalogUnchanged) problems.push('katalogi muuttui');
    if (out.migrationRelationLocksAfter !== 0) problems.push(`${out.migrationRelationLocksAfter} relaatiolukkoa jäi`);
    out.pass = problems.length === 0;
    out.problems = problems;
    for (const p of problems) fail(scenario, `uudelleenajo lukon aikana (${label}): ${p}`);
  } finally {
    await monitor.end();
    await client.end();
    await dropDatabase(db);
  }
  return out;
}

export async function locksScenario({ fail }) {
  const scenario = 'failure:0010-locks';
  const results = { matrix: [], late: null, stall: [], deadlock: [], aborted: null, rerunBlocked: null, rerunBlocked0014: null, beforeF11: null };
  const sql0010 = readSql(`supabase/migrations/${migrationName('0010')}.sql`);
  for (const n of ['0010', '0009', '0011', '0014']) {
    const sql = n === '0010' ? sql0010 : readSql(`supabase/migrations/${migrationName(n)}.sql`);
    for (const table of Object.keys(MIGRATION_LOCKS[n])) {
      for (const mode of Object.keys(BLOCKER_MODES)) {
        results.matrix.push(await blockerCase({ n, table, mode, sql, label: 'nykyinen', fail, scenario }));
      }
    }
  }
  // F11: kaikki odotukset ennen yhtäkään DDL:ää. Estäjä goals/projects/tasks/profile -> 0 DDL-komentoa.
  for (const r of results.matrix.filter(x => x.migration === '0010' && x.expectBlocked && x.table !== 'auth.users')) {
    if (r.ddlStarted !== 0) fail(scenario, `0010 ${r.table} ${r.mode}: ${r.ddlStarted} DDL-komentoa ennen lukon aikakatkaisua (odotus 0, F11)`);
  }
  results.late = await lateFailureCase({ sql: sql0010, fail, scenario });
  results.stall.push(await stallCase({ sql: sql0010, label: 'nykyinen 0010', fail, scenario }));
  results.deadlock.push(await deadlockCase({ sql: sql0010, label: 'nykyinen 0010', fail, scenario }));
  results.aborted = await abortedSessionCase({ sql: sql0010, fail, scenario });
  results.rerunBlocked = await rerunUnderLockCase({ sql: sql0010, label: 'nykyinen', fail, scenario });
  // 0014: tunnistus ennen yhtäkään DDL:ää ja vain katalogia (+ omistajan
  // rivi ACCESS SHARE -lukolla): sovelluksen goals-kirjoitus ei viivästä
  // "JO AJETTU" -vastausta.
  results.rerunBlocked0014 = await rerunUnderLockCase({ sql: readSql(`supabase/migrations/${migrationName('0014')}.sql`),
    label: 'nykyinen', fail, scenario, n: '0014' });
  // Vertailu: sama uudelleenajo 0010:llä, jossa tunnistus oli lukituksen jälkeen.
  const beforeReorder = gitShow(RERUN_BASELINE_REF, 'supabase/migrations/0010_goal_to_action.sql');
  if (beforeReorder && beforeReorder.indexOf('lock table public.goals') < beforeReorder.indexOf('into olemassa from (')) {
    results.rerunBlockedBefore = await rerunUnderLockCase({ sql: beforeReorder, label: `ennen ${RERUN_BASELINE_REF}`, fail: () => {}, scenario });
  } else {
    results.rerunBlockedBefore = { skipped: `git show ${RERUN_BASELINE_REF} ei saatavilla tai tunnistus on jo ennen lukitusta` };
  }

  // Vertailu: 0010 ennen F11:tä (sama mittaus, ei hylkäysehtoja DDL-määrälle).
  const old = gitShow(F11_BASELINE_REF, 'supabase/migrations/0010_goal_to_action.sql');
  if (old && !/lock table public\.goals, public\.projects/.test(old)) {
    const noFail = () => {};
    const profileAS = await blockerCase({ n: '0010', table: 'public.profile', mode: 'ACCESS SHARE', sql: old, label: `ennen F11 (${F11_BASELINE_REF})`, fail: noFail, scenario });
    results.beforeF11 = {
      ref: F11_BASELINE_REF,
      profileBlocker: { ok: profileAS.ok, waitedMs: profileAS.waitedMs, ddlStarted: profileAS.ddlStarted, catalogUnchanged: profileAS.catalogUnchanged },
      stall: await stallCase({ sql: old, label: `ennen F11 ${F11_BASELINE_REF}`, fail: noFail, scenario }),
      deadlock: await deadlockCase({ sql: old, label: `ennen F11 ${F11_BASELINE_REF}`, fail: noFail, scenario })
    };
  } else {
    results.beforeF11 = { skipped: `git show ${F11_BASELINE_REF} ei saatavilla tai sisältää jo F11:n` };
  }
  return results;
}

// ---------------------------------------------------------------------
// verify:null — NULL-tulos lasketaan pysäytyslukuun
// ---------------------------------------------------------------------

/** Rikotaan yksi objekti niin, että tarkistus palauttaa NULLin (tai FAILin). */
export const NULL_SABOTAGE = Object.freeze({
  '0009': { sql: 'alter table public.transactions drop column date cascade', nullCheck: '07' },
  '0010': { sql: 'alter table public.milestones drop constraint milestones_goal_fkey', nullCheck: '17' },
  '0011': { sql: 'alter table public.location_rules drop column place cascade', nullCheck: '14' },
  '0012': { sql: 'alter table public.life_areas drop column target_minutes_per_week cascade', nullCheck: '12' },
  '0013': { sql: 'alter table public.running_timers drop column note cascade', nullCheck: null },
  // verify_0014:n jokainen tarkistus on count() tai coalesce(): puuttuva
  // rajoite näkyy lukuna (87 ≠ 88) ja 'false'-arvona, ei NULLina.
  '0014': { sql: 'alter table public.wellbeing_checkins drop constraint wellbeing_checkins_date_unique', nullCheck: null }
});

export async function verifyNullScenario({ fail }) {
  const scenario = 'verify:null';
  const results = [];
  for (const [n, s] of Object.entries(NULL_SABOTAGE)) {
    const db = `mv_rehearsal_vnull_${n}`;
    const client = await cloneProdShape(n, db);
    try {
      const clean = await runVerify(client, `supabase/verify/verify_${n}.sql`);
      await client.query(s.sql);
      const v = await runVerify(client, `supabase/verify/verify_${n}.sql`);
      const nullRow = s.nullCheck ? v.rows.find(r => r.check_no === s.nullCheck) : null;
      const out = { migration: n, sabotage: s.sql, cleanFail: clean.ok ? clean.failed.length : clean.error.message,
                    ok: v.ok, failRows: v.ok ? v.failed.length : null, poikkeavia: v.poikkeavia,
                    nullCheck: nullRow ? { check: nullRow.check_no, status: nullRow.status, details: nullRow.details } : null };
      const problems = [];
      if (!clean.ok || clean.failed.length) problems.push(`ehjä tila ei ole 0 FAIL: ${JSON.stringify(out.cleanFail)}`);
      if (!v.ok) problems.push(`verify kaatui: ${v.error.message}`);
      else {
        if (!v.failed.length) problems.push('rikottu tila ei antanut yhtään FAIL-riviä');
        if (v.countMismatch) problems.push(`poikkeavia_yhteensa ${v.poikkeavia} ≠ FAIL-rivejä ${v.failed.length}`);
        if (s.nullCheck && (!nullRow || nullRow.status !== 'FAIL' || !/toteutui null/.test(String(nullRow.details)))) {
          problems.push(`tarkistus ${s.nullCheck}: ${JSON.stringify(out.nullCheck)} (odotus FAIL, "toteutui null")`);
        }
      }
      out.pass = problems.length === 0;
      out.problems = problems;
      results.push(out);
      for (const p of problems) fail(scenario, `verify_${n}: ${p}`);
    } finally { await client.end(); await dropDatabase(db); }
  }
  return results;
}

// ---------------------------------------------------------------------
// preflight:blockers — uudet rivit havaitsevat esteen etukäteen
// ---------------------------------------------------------------------

const rowByName = (rows, pattern) => rows.find(r => pattern.test(r.check_name));

export async function preflightBlockerScenario({ fail }) {
  const scenario = 'preflight:blockers';
  const results = [];
  // F10: lukittu taulu -> esteet-rivi FAIL. Ensimmäinen taulu + auth.users kullekin migraatiolle.
  for (const n of ['0009', '0010', '0011', '0012', '0013', '0014']) {
    const prev = String(Number(n) - 1).padStart(4, '0');
    const db = `mv_rehearsal_pfb_${n}`;
    const client = await cloneProdShape(prev, db);
    try {
      for (const table of [LOCKED_TABLES[n][0], 'auth.users', ...(n === '0010' ? ['public.profile'] : [])]) {
        const blocker = await openBlocker(db, table, 'ACCESS SHARE');
        let v;
        try { v = await runVerify(client, `supabase/preflight/preflight_${n}.sql`); } finally { await closeBlocker(blocker); }
        const row = v.ok ? rowByName(v.rows, /Muut istunnot eivät lukitse/) : null;
        const pass = Boolean(row && row.status === 'FAIL') && !v.countMismatch;
        results.push({ preflight: n, blocker: `${table} ACCESS SHARE`, pass, row: row ? `${row.check_no} ${row.status} ${row.details}` : null,
                       failed: v.ok ? v.failed.map(r => r.check_no) : v.error.message });
        if (!pass) fail(scenario, `preflight_${n} ei havainnut estäjää ${table}: ${JSON.stringify(row)}`);
      }
      const after = await runVerify(client, `supabase/preflight/preflight_${n}.sql`);
      const clean = after.ok && after.failed.length === 0;
      results.push({ preflight: n, blocker: 'ei estäjää', pass: clean, failed: after.ok ? after.failed.map(r => r.check_name) : after.error.message });
      if (!clean) fail(scenario, `preflight_${n} ilman estäjää: ${JSON.stringify(after.failed?.map(r => r.check_name))}`);
    } finally { await client.end(); await dropDatabase(db); }
  }
  // F9: ylimääräinen politiikka (esim. Dashboardista luotu) -> preflight FAIL ja migraatio kaatuu myöhään kiinni.
  for (const [n, table] of [['0011', 'tasks'], ['0012', 'goals'], ['0013', 'life_areas'], ['0014', 'running_timers']]) {
    const prev = String(Number(n) - 1).padStart(4, '0');
    const db = `mv_rehearsal_pfp_${n}`;
    const client = await cloneProdShape(prev, db);
    try {
      await client.query(`create policy mv_rehearsal_extra on public.${table} for select to authenticated using (false)`);
      const v = await runVerify(client, `supabase/preflight/preflight_${n}.sql`);
      const row = v.ok ? rowByName(v.rows, /politiikkaa/) : null;
      const itemsBefore = await catalogItems(client);
      const run = await runSql(client, readSql(`supabase/migrations/${migrationName(n)}.sql`));
      const d = diffCatalog(itemsBefore, await catalogItems(client));
      const pass = Boolean(row && row.status === 'FAIL') && !run.ok && !d.added.length && !d.removed.length;
      results.push({ preflight: n, blocker: `ylimääräinen politiikka taulussa ${table}`, pass,
                     row: row ? `${row.check_no} ${row.status} ${row.details}` : null,
                     migration: run.ok ? 'meni läpi' : run.error.message, catalogUnchanged: !d.added.length && !d.removed.length });
      if (!pass) fail(scenario, `politiikkamäärä ${n}: ${JSON.stringify(results.at(-1))}`);
    } finally { await client.end(); await dropDatabase(db); }
  }
  results.push(...await accountCascadeCases({ fail, scenario }));
  return results;
}

/** Kaksi public-taulua, joita mikään migraatio ei luo (esim. Dashboardista). */
const FOREIGN_TABLES_SQL = `
  create table public.mv_rehearsal_vieras (id text primary key, user_id uuid references auth.users(id));
  create table public.mv_rehearsal_ilman_avainta (id text primary key);`;
const FOREIGN_INFO = '2: mv_rehearsal_ilman_avainta, mv_rehearsal_vieras';

/**
 * F13: tilin poiston oletukset. Muu kuin migraatioiden public-taulu ei
 * kaada verify_0013:a (rivit 26–27 rajattu migraatioiden 26 tauluun,
 * rivi 28 INFO), mutta sen ei-CASCADE-vierasavain auth.usersiin
 * pysäyttää junan jo preflight_0009:ssä. Migraatioiden taulun
 * ei-CASCADE-avain tai puuttuva avain kaatuu yhä riveille 26 ja 27.
 */
async function accountCascadeCases({ fail, scenario }) {
  const results = [];
  const check = (label, v, pass, extra = {}) => {
    const detail = { failed: v.ok ? v.failed.map(r => r.check_no) : v.error.message, poikkeavia: v.poikkeavia ?? null, ...extra };
    const ok = Boolean(pass) && v.ok && !v.countMismatch;
    results.push({ preflight: label.split(':')[0], blocker: label, pass: ok, ...detail });
    if (!ok) fail(scenario, `${label}: ${JSON.stringify(detail)}`);
  };
  const failedNos = v => (v.ok ? v.failed.map(r => r.check_no).join(',') : null);
  {
    const db = 'mv_rehearsal_pfc_0008';
    const client = await cloneProdShape('0008', db);
    try {
      const clean = await runVerify(client, 'supabase/preflight/preflight_0009.sql');
      const cleanInfo = clean.ok ? rowByName(clean.rows, /Muut public-taulut/) : null;
      check('preflight_0009: vain migraatioiden taulut -> 0 FAIL, INFO 0', clean,
        failedNos(clean) === '' && cleanInfo?.status === 'INFO' && cleanInfo.details === '0', { info: cleanInfo?.details });
      await client.query(FOREIGN_TABLES_SQL);
      const v = await runVerify(client, 'supabase/preflight/preflight_0009.sql');
      const info = v.ok ? rowByName(v.rows, /Muut public-taulut/) : null;
      const cascade = v.ok ? rowByName(v.rows, /vierasavain auth\.usersiin on CASCADE/) : null;
      check('preflight_0009: vieras taulu ei-CASCADE-avaimella -> FAIL ennen junaa', v,
        v.ok && v.failed.length === 1 && cascade?.status === 'FAIL' && info?.details === FOREIGN_INFO,
        { info: info?.details, cascade: cascade ? `${cascade.check_no} ${cascade.status} ${cascade.details}` : null });
      await client.query(`alter table public.mv_rehearsal_vieras drop constraint mv_rehearsal_vieras_user_id_fkey,
        add constraint mv_rehearsal_vieras_user_id_fkey foreign key (user_id) references auth.users(id) on delete cascade`);
      const v2 = await runVerify(client, 'supabase/preflight/preflight_0009.sql');
      const info2 = v2.ok ? rowByName(v2.rows, /Muut public-taulut/) : null;
      check('preflight_0009: vieras taulu CASCADE-avaimella -> 0 FAIL, INFO 2', v2,
        failedNos(v2) === '' && info2?.details === FOREIGN_INFO, { info: info2?.details });
    } finally { await client.end(); await dropDatabase(db); }
  }
  {
    const db = 'mv_rehearsal_pfc_0013';
    const client = await cloneProdShape('0013', db);
    try {
      await client.query(FOREIGN_TABLES_SQL);
      const v = await runVerify(client, 'supabase/verify/verify_0013.sql');
      const r28 = v.ok ? v.rows.find(r => r.check_no === '28') : null;
      check('verify_0013: vieraat taulut eivät kaada riviä 26–27, rivi 28 INFO', v,
        failedNos(v) === '' && r28?.status === 'INFO' && r28.details === FOREIGN_INFO, { r28: r28?.details });
      const fk = await scalar(client,
        `select conname from pg_constraint where conrelid = 'public.goals'::regclass and confrelid = 'auth.users'::regclass`);
      await client.query(`alter table public.goals drop constraint ${fk},
        add constraint ${fk} foreign key (user_id) references auth.users(id)`);
      const v2 = await runVerify(client, 'supabase/verify/verify_0013.sql');
      check('verify_0013: goals-avain ei CASCADE -> rivi 26 FAIL', v2, failedNos(v2) === '26' && v2.poikkeavia === 1);
      await client.query(`alter table public.goals drop constraint ${fk}`);
      const v3 = await runVerify(client, 'supabase/verify/verify_0013.sql');
      check('verify_0013: goals ilman avainta auth.usersiin -> rivi 27 FAIL', v3, failedNos(v3) === '27' && v3.poikkeavia === 1);
    } finally { await client.end(); await dropDatabase(db); }
  }
  {
    // verify_0014: rivit 34–35 rajattu migraatioiden 36 tauluun (0001–0014),
    // rivi 36 INFO. Rivi 33 koskee vain uusia tauluja, joten vanhan taulun
    // avain näkyy vain riveillä 34 ja 35.
    const db = 'mv_rehearsal_pfc_0014';
    const client = await cloneProdShape('0014', db);
    try {
      await client.query(FOREIGN_TABLES_SQL);
      const v = await runVerify(client, 'supabase/verify/verify_0014.sql');
      const r36 = v.ok ? v.rows.find(r => r.check_no === '36') : null;
      check('verify_0014: vieraat taulut eivät kaada rivejä 34–35, rivi 36 INFO', v,
        failedNos(v) === '' && r36?.status === 'INFO' && r36.details === FOREIGN_INFO, { r36: r36?.details });
      const fk = await scalar(client,
        `select conname from pg_constraint where conrelid = 'public.goals'::regclass and confrelid = 'auth.users'::regclass`);
      await client.query(`alter table public.goals drop constraint ${fk},
        add constraint ${fk} foreign key (user_id) references auth.users(id)`);
      const v2 = await runVerify(client, 'supabase/verify/verify_0014.sql');
      check('verify_0014: goals-avain ei CASCADE -> rivi 34 FAIL', v2, failedNos(v2) === '34' && v2.poikkeavia === 1);
      await client.query(`alter table public.goals drop constraint ${fk}`);
      const v3 = await runVerify(client, 'supabase/verify/verify_0014.sql');
      check('verify_0014: goals ilman avainta auth.usersiin -> rivi 35 FAIL', v3, failedNos(v3) === '35' && v3.poikkeavia === 1);
      // Uuden taulun omistaja-avain ilman CASCADEa: rivit 33 ja 34.
      const fk14 = await scalar(client,
        `select conname from pg_constraint where conrelid = 'public.sleep_logs'::regclass and confrelid = 'auth.users'::regclass`);
      await client.query(`alter table public.sleep_logs drop constraint ${fk14},
        add constraint ${fk14} foreign key (user_id) references auth.users(id)`);
      const v4 = await runVerify(client, 'supabase/verify/verify_0014.sql');
      check('verify_0014: sleep_logs-avain ei CASCADE -> rivit 33 ja 34 FAIL (35 yhä FAIL)', v4,
        failedNos(v4) === '33,34,35' && v4.poikkeavia === 3);
    } finally { await client.end(); await dropDatabase(db); }
  }
  return results;
}

// ---------------------------------------------------------------------
// role:nonsuper — migraatiot NOSUPERUSER-omistajana
// ---------------------------------------------------------------------

export const NONSUPER_ROLE = 'mv_rehearsal_owner';

async function prepareNonsuper(admin) {
  const r = NONSUPER_ROLE;
  await admin.query(`
    do $$ begin
      if not exists (select 1 from pg_roles where rolname = '${r}') then
        create role ${r} login nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
      end if;
    end $$;
    alter schema public owner to ${r};
    do $$ declare x record; begin
      for x in select c.relname from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' loop
        execute format('alter table public.%I owner to ${r}', x.relname);
      end loop;
      for x in select p.oid::regprocedure::text as sig from pg_proc p where p.pronamespace = 'public'::regnamespace loop
        execute format('alter function %s owner to ${r}', x.sig);
      end loop;
    end $$;
    grant usage on schema auth to ${r};
    grant select, references on auth.users to ${r};
    alter default privileges for role ${r} in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges for role ${r} in schema public grant all on functions to anon, authenticated, service_role;`);
}

export async function roleNonsuperScenario({ fail }) {
  const scenario = 'role:nonsuper';
  const db = 'mv_rehearsal_nonsuper';
  const admin = await cloneProdShape('0008', db);
  const results = { role: NONSUPER_ROLE, migrations: [], preflightVisibility: [] };
  let owner = null;
  try {
    await prepareNonsuper(admin);
    owner = await connect(db, { user: NONSUPER_ROLE });
    results.isSuperuser = await scalar(owner, `select rolsuper from pg_roles where rolname = current_user`);
    for (const n of ['0009', '0010', '0011', '0012', '0013', '0014']) {
      if (n === '0010') {
        // Näkyvyys: postgres-istunto pitää goals-lukkoa avoimessa transaktiossa.
        for (const stats of [false, true]) {
          await admin.query(`${stats ? 'grant' : 'revoke'} pg_read_all_stats ${stats ? 'to' : 'from'} ${NONSUPER_ROLE}`);
          const blocker = await openBlocker(db, 'public.goals', 'ACCESS SHARE');
          let v;
          try { v = await runVerify(owner, 'supabase/preflight/preflight_0010.sql'); } finally { await closeBlocker(blocker); }
          const idle = v.ok ? rowByName(v.rows, /idle in transaction/) : null;
          const locked = v.ok ? rowByName(v.rows, /Muut istunnot eivät lukitse/) : null;
          results.preflightVisibility.push({ pg_read_all_stats: stats,
            idleInTransactionRow: idle ? `${idle.status} ${idle.details}` : null,
            lockedTablesRow: locked ? `${locked.status} ${locked.details}` : null });
          const problems = [];
          if (!locked || locked.status !== 'FAIL') problems.push('lukitut taulut -rivi ei nähnyt estäjää');
          if (stats && (!idle || idle.status !== 'FAIL')) problems.push('idle-rivi ei nähnyt estäjää vaikka pg_read_all_stats');
          for (const p of problems) fail(scenario, `preflight_0010 (pg_read_all_stats=${stats}): ${p}`);
        }
        await admin.query(`revoke pg_read_all_stats from ${NONSUPER_ROLE}`);
      }
      const record = await applyMigration(owner, migrationName(n));
      const problems = [];
      if (!record.ok) problems.push(`migraatio kaatui: ${record.error.message}`);
      for (const f of record.preflight?.fail || []) problems.push(`preflight: ${f}`);
      if (record.preflight?.error) problems.push(`preflight kaatui: ${record.preflight.error}`);
      for (const f of record.verify?.fail || []) problems.push(`verify: ${f}`);
      if (record.verify?.error) problems.push(`verify kaatui: ${record.verify.error}`);
      results.migrations.push({ migration: n, ok: record.ok, pass: problems.length === 0, problems,
                                verify: record.verify, preflightFail: record.preflight?.fail });
      for (const p of problems) fail(scenario, `${n}: ${p}`);
      if (!record.ok) break;
    }
    results.ownerOfNewTables = (await admin.query(
      `select relowner::regrole::text as owner, count(*)::int as n from pg_class
        where relnamespace = 'public'::regnamespace and relkind = 'r' group by 1 order by 1`)).rows;
  } finally {
    if (owner) await owner.end();
    await admin.end();
    await dropDatabase(db);
    const c = await connect();
    try {
      await c.query(`drop role if exists ${NONSUPER_ROLE}`);
    } catch (error) {
      fail(scenario, `roolin ${NONSUPER_ROLE} poisto: ${error.message}`);
    } finally { await c.end(); }
  }
  return results;
}
