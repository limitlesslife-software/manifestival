// Peruutukset datan kanssa (tuotannon muotoiset kloonit).
//
//   rollback:data           0010 / 0012 / 0013 / 0014: migraatio -> sovelluksen
//                           kirjoitukset seuraavan aallon rivimuodoilla ->
//                           ROLLBACK-osio. Vanhat rivit (vanhat sarakkeet,
//                           xmin, relfilenode) ja katalogi täsmälleen ennallaan.
//                           0010 kieltäytyy selkeästi ylläpitotilan takia,
//                           0013 säilyttää minuutit ja kertoo kohdistuksen
//                           menetyksen etukäteen. 0014 pudottaa kymmenen
//                           taulua aallon K datan kanssa: katalogi = 0013,
//                           vanhat rivit ennallaan, verify_0013 0 FAIL.
//                           0015 aallon L datan kanssa: jaettu kategoria
//                           pysäyttää peruutuksen vartijaan (katalogi
//                           ennallaan), korjauksen jälkeen katalogi = 0014,
//                           vanhat rivit ennallaan, verify_0014 0 FAIL,
//                           uusi ajo läpi.
//   rollback:reverse-chain  0008 -> 0009..0015 datan kanssa -> peruutukset
//                           0015..0009 käänteisessä järjestyksessä -> katalogi
//                           = tuotannon 0008; väärä järjestys (0012 ennen
//                           0013:a) kaatuu kiinni vartijaan. 0013 ennen
//                           0014:ää: 0013:n peruutuksella EI ole vartijaa
//                           (0013 on lukittu) — kirjataan omassa kloonissaan
//                           tiedoksi ja todennetaan, että inventaario
//                           pysäyttää sellaisen tilan.

import {
  OWNER, dropDatabase, runSql, runVerify, readSql, catalogItems, diffCatalog, extractRollback, extractPreRollback,
  rowDigests, compareDigests, digestsIdentical, postgrestWrite
} from './lib.mjs';
import { migrationName } from './chain.mjs';
import { cloneProdShape, snapshotTables, compareSnapshot, runInventory } from './prodshape.mjs';
import { waveWrites, trainWaves } from './waves.mjs';
import { runWrites } from './prodshape-scenarios.mjs';

export const WAVE_OF = Object.freeze({ '0009': 'F', '0010': 'G', '0011': 'H', '0012': 'I', '0013': 'J', '0014': 'K', '0015': 'L' });
/** Käänteisen ketjun migraatiot järjestyksessä (0009..0015). */
export const CHAIN = Object.freeze(Object.keys(WAVE_OF).sort());
/** 0014:n kymmenen taulua (peruutus pudottaa ne). */
export const TABLES_0014 = Object.freeze(['saved_places', 'place_aliases', 'calendar_events', 'commute_observations',
  'life_settings', 'sleep_logs', 'habit_plans', 'habit_events', 'exercise_sessions', 'wellbeing_checkins']);
/** 0015:n kaksi uutta taulua (peruutus pudottaa ne; tasks ja life_areas palautetaan). */
export const TABLES_0015 = Object.freeze(['protected_periods', 'weekly_plans']);
const MAINTENANCE_FIX = `update public.goals set status = 'active' where status = 'maintenance'`;

const migrationSql = n => readSql(`supabase/migrations/${migrationName(n)}.sql`);
const rollbackSql = n => extractRollback(migrationSql(n));

async function migrate(client, n) {
  const out = await runSql(client, migrationSql(n));
  if (!out.ok) throw new Error(`${n}: ${out.error.message}`);
}

/** Vain vanhoilla sarakkeilla: tiivisteet tauluista, jotka olivat olemassa ennen. */
async function legacyDigests(client, snapshot) {
  const out = {};
  for (const [t, s] of Object.entries(snapshot)) out[t] = await rowDigests(client, t, s.columns);
  return out;
}

function sameDigests(before, after) {
  const problems = [];
  for (const [t, b] of Object.entries(before)) {
    const d = compareDigests(b, after[t] || new Map());
    if (!digestsIdentical(d)) problems.push(`${t}: ${JSON.stringify(d)}`);
  }
  return problems;
}

async function case0010({ fail, scenario }) {
  const db = 'mv_rehearsal_rbd_0010';
  const client = await cloneProdShape('0009', db);
  const out = { migration: '0010' };
  try {
    const items0 = await catalogItems(client);
    const snap0 = await snapshotTables(client);
    await migrate(client, '0010');
    const writes = await runWrites(client, await waveWrites('G', { prefix: 'rb10', upsertOwnRows: false }));
    out.writes = writes;
    const itemsBefore = await catalogItems(client);
    const refused = await runSql(client, rollbackSql('0010'));
    const dRefused = diffCatalog(itemsBefore, await catalogItems(client));
    out.firstRollback = { ok: refused.ok, code: refused.error?.code || null, error: refused.error?.message || null,
                          catalogUnchanged: !dRefused.added.length && !dRefused.removed.length };
    const fixed = await client.query(MAINTENANCE_FIX);
    out.maintenanceGoalsReset = fixed.rowCount;
    const rolled = await runSql(client, rollbackSql('0010'));
    out.secondRollback = { ok: rolled.ok, error: rolled.error?.message || null };
    const d = diffCatalog(items0, await catalogItems(client));
    out.catalogEqualsPre0010 = !d.added.length && !d.removed.length;
    const cmp = await compareSnapshot(client, snap0, { allowAdded: true });
    out.legacyRows = cmp.perTable;
    const problems = [];
    if (writes.failed.length) problems.push(`aallon G kirjoitukset: ${writes.failed.join('; ')}`);
    if (refused.ok) problems.push('peruutus meni läpi ylläpitotilan tavoitteesta huolimatta');
    else if (!/maintenance/.test(refused.error.message) || !/Peruutus keskeytetty/.test(refused.error.message)) {
      problems.push(`peruutuksen virhe ei ole vartijan selkeä viesti: ${refused.error.message}`);
    }
    if (!out.firstRollback.catalogUnchanged) problems.push('hylätty peruutus muutti katalogia');
    if (out.maintenanceGoalsReset < 1) problems.push('yhtään ylläpitotilan tavoitetta ei ollut (aalto G ei kirjoittanut)');
    if (!rolled.ok) problems.push(`peruutus tilan korjauksen jälkeen kaatui: ${rolled.error.message}`);
    if (!out.catalogEqualsPre0010) problems.push(`katalogi ≠ ennen 0010: ${JSON.stringify(d).slice(0, 400)}`);
    problems.push(...cmp.problems);
    out.pass = problems.length === 0;
    out.problems = problems;
    for (const p of problems) fail(scenario, `0010: ${p}`);
  } finally { await client.end(); await dropDatabase(db); }
  return out;
}

async function case0012({ fail, scenario }) {
  const db = 'mv_rehearsal_rbd_0012';
  const client = await cloneProdShape('0011', db);
  const out = { migration: '0012' };
  try {
    const items0 = await catalogItems(client);
    const snap0 = await snapshotTables(client);
    await migrate(client, '0012');
    const ops = await waveWrites('I', { prefix: 'rb12', upsertOwnRows: false });
    const writes = await runWrites(client, ops);
    // Tuotannon oma tavoite liitetään alueeseen sovelluksen päivityksellä (aalto I).
    const goalOp = ops.find(o => o.table === 'goals' && o.method === 'insert');
    const link = await postgrestWrite(client, OWNER, 'goals', { ...goalOp.payload, id: 'prod-goal-1', title: 'Tuotannon tavoite' },
      { method: 'update', match: { user_id: OWNER, id: 'prod-goal-1' } });
    out.writes = writes;
    out.prodGoalLinked = link.ok && link.rowCount === 1;
    out.linkedGoals = Number((await client.query('select count(*) from public.goals where life_area_id is not null')).rows[0].count);
    out.timeEntries = Number((await client.query('select count(*) from public.time_entries')).rows[0].count);
    const beforeRollback = await legacyDigests(client, snap0);
    const rolled = await runSql(client, rollbackSql('0012'));
    out.rollback = { ok: rolled.ok, error: rolled.error?.message || null };
    const afterRollback = await legacyDigests(client, snap0);
    const d = diffCatalog(items0, await catalogItems(client));
    out.catalogEqualsPre0012 = !d.added.length && !d.removed.length;
    const problems = [];
    if (writes.failed.length) problems.push(`aallon I kirjoitukset: ${writes.failed.join('; ')}`);
    if (!out.prodGoalLinked) problems.push(`tuotannon tavoitteen liitos kaatui: ${link.message}`);
    if (out.linkedGoals < 2 || out.timeEntries < 1) problems.push(`dataa liian vähän: ${out.linkedGoals} liitettyä, ${out.timeEntries} kirjausta`);
    if (!rolled.ok) problems.push(`peruutus kaatui: ${rolled.error.message}`);
    if (!out.catalogEqualsPre0012) problems.push(`katalogi ≠ ennen 0012: ${JSON.stringify(d).slice(0, 400)}`);
    // Peruutus ei saa muuttaa yhdenkään vanhan rivin vanhoja sarakkeita eikä kirjoittaa rivejä uudelleen.
    problems.push(...sameDigests(beforeRollback, afterRollback));
    out.pass = problems.length === 0;
    out.problems = problems;
    for (const p of problems) fail(scenario, `0012: ${p}`);
  } finally { await client.end(); await dropDatabase(db); }
  return out;
}

async function case0013({ fail, scenario }) {
  const db = 'mv_rehearsal_rbd_0013';
  const client = await cloneProdShape('0012', db);
  const out = { migration: '0013' };
  try {
    const items0 = await catalogItems(client);
    const snap0 = await snapshotTables(client);
    await migrate(client, '0013');
    const ops = await waveWrites('J', { prefix: 'rb13', upsertOwnRows: false });
    const writes = await runWrites(client, ops);
    // Kirjaus, jonka ainoa kohde on projekti: se menettää kohdistuksensa peruutuksessa.
    const te = ops.find(o => o.table === 'time_entries' && o.method === 'insert').payload;
    const only = await postgrestWrite(client, OWNER, 'time_entries', {
      ...te, id: 'rb13-te-proj', operation_id: 'op:rb13:2', life_area_id: null, goal_id: null, task_id: null, routine_id: null
    });
    out.writes = writes;
    const pre = extractPreRollback(migrationSql('0013'));
    const counts = pre ? (await client.query(pre)).rows[0] : null;
    out.preRollbackQuery = counts;
    const rowsBefore = (await client.query(
      `select id, minutes, entry_date::text, life_area_id, goal_id, task_id, source,
              (project_id is not null or routine_id is not null) and life_area_id is null and goal_id is null and task_id is null as loses
         from public.time_entries order by id`)).rows;
    const beforeRollback = await legacyDigests(client, snap0);
    const rolled = await runSql(client, rollbackSql('0013'));
    out.rollback = { ok: rolled.ok, error: rolled.error?.message || null };
    const rowsAfter = (await client.query(
      `select id, minutes, entry_date::text, life_area_id, goal_id, task_id, source from public.time_entries order by id`)).rows;
    const d = diffCatalog(items0, await catalogItems(client));
    out.catalogEqualsPre0013 = !d.added.length && !d.removed.length;
    out.entries = rowsBefore.length;
    out.timerEntriesConvertedToManual = rowsBefore.filter(r => r.source === 'timer').length;
    out.entriesLosingAttribution = rowsBefore.filter(r => r.loses).length;
    const problems = [];
    if (writes.failed.length) problems.push(`aallon J kirjoitukset: ${writes.failed.join('; ')}`);
    if (!only.ok) problems.push(`projektikirjaus kaatui: ${only.message}`);
    if (!counts) problems.push('ROLLBACK-osion ennakkokyselyä ei löytynyt');
    else {
      if (Number(counts.ajastinkirjauksia) !== out.timerEntriesConvertedToManual) problems.push(`ennakkokysely: ajastinkirjauksia ${counts.ajastinkirjauksia} ≠ ${out.timerEntriesConvertedToManual}`);
      if (Number(counts.menettaa_kohteen_kokonaan) !== out.entriesLosingAttribution) problems.push(`ennakkokysely: menettää kohteen ${counts.menettaa_kohteen_kokonaan} ≠ ${out.entriesLosingAttribution}`);
    }
    if (out.timerEntriesConvertedToManual < 1 || out.entriesLosingAttribution < 1) problems.push('dataa liian vähän (ajastin- tai projektikirjaus puuttuu)');
    if (!rolled.ok) problems.push(`peruutus kaatui: ${rolled.error.message}`);
    if (!out.catalogEqualsPre0013) problems.push(`katalogi ≠ ennen 0013: ${JSON.stringify(d).slice(0, 400)}`);
    const after = new Map(rowsAfter.map(r => [r.id, r]));
    for (const b of rowsBefore) {
      const a = after.get(b.id);
      if (!a) { problems.push(`kirjaus ${b.id} katosi`); continue; }
      for (const k of ['minutes', 'entry_date', 'life_area_id', 'goal_id', 'task_id']) {
        if (String(a[k]) !== String(b[k])) problems.push(`kirjaus ${b.id}: ${k} ${b[k]} -> ${a[k]}`);
      }
      if (a.source !== 'manual') problems.push(`kirjaus ${b.id}: lähde ${a.source}, odotus manual`);
    }
    // Muiden kuin time_entries-taulun vanhat rivit: ei muutoksia (time_entries päivitetään tarkoituksella).
    const legacyBefore = Object.fromEntries(Object.entries(beforeRollback).filter(([t]) => t !== 'time_entries'));
    problems.push(...sameDigests(legacyBefore, await legacyDigests(client,
      Object.fromEntries(Object.entries(snap0).filter(([t]) => t !== 'time_entries')))));
    out.pass = problems.length === 0;
    out.problems = problems;
    for (const p of problems) fail(scenario, `0013: ${p}`);
  } finally { await client.end(); await dropDatabase(db); }
  return out;
}

/**
 * 0014: aallon K kirjoitukset kaikkiin kymmeneen tauluun -> ROLLBACK-osio.
 * Peruutus POISTAA arjen rivit (migraation otsikko kertoo sen); vanhojen
 * taulujen rivit (vanhat sarakkeet, xmin, relfilenode) ja katalogi ovat
 * täsmälleen tilan 0013 mukaiset, ja verify_0013 on yhä 0 FAIL.
 */
async function case0014({ fail, scenario }) {
  const db = 'mv_rehearsal_rbd_0014';
  const client = await cloneProdShape('0013', db);
  const out = { migration: '0014' };
  try {
    const items0 = await catalogItems(client);
    const snap0 = await snapshotTables(client);
    await migrate(client, '0014');
    const ops = await waveWrites('K', { prefix: 'rb14', upsertOwnRows: false });
    const writes = await runWrites(client, ops);
    out.writes = writes;
    const counts = (await client.query(
      `select ${TABLES_0014.map(t => `(select count(*) from public.${t})::int as ${t}`).join(', ')}`)).rows[0];
    out.rowsBeforeRollback = counts;
    const beforeRollback = await legacyDigests(client, snap0);
    const rolled = await runSql(client, rollbackSql('0014'));
    out.rollback = { ok: rolled.ok, error: rolled.error?.message || null };
    const d = diffCatalog(items0, await catalogItems(client));
    out.catalogEqualsPre0014 = !d.added.length && !d.removed.length;
    const cmp = await compareSnapshot(client, snap0, { allowAdded: true });
    out.legacyRows = cmp.perTable;
    const v13 = await runVerify(client, 'supabase/verify/verify_0013.sql');
    out.verify0013 = v13.ok ? { fail: v13.failed.length, poikkeavia: v13.poikkeavia } : { error: v13.error.message };
    const again = await runSql(client, migrationSql('0014'));
    out.reapplied = again.ok;
    const problems = [];
    if (writes.failed.length) problems.push(`aallon K kirjoitukset: ${writes.failed.join('; ')}`);
    const empty = TABLES_0014.filter(t => !(counts[t] >= 1));
    if (empty.length) problems.push(`dataa puuttuu tauluista: ${empty.join(', ')}`);
    if (!rolled.ok) problems.push(`peruutus kaatui: ${rolled.error.message}`);
    if (!out.catalogEqualsPre0014) problems.push(`katalogi ≠ ennen 0014: ${JSON.stringify(d).slice(0, 400)}`);
    // Kirjoitukset lisäsivät rivejä vanhoihin tauluihin (allowAdded), mutta
    // peruutus ei saa muuttaa tai kirjoittaa uudelleen yhtäkään vanhaa riviä.
    problems.push(...sameDigests(beforeRollback, await legacyDigests(client, snap0)));
    problems.push(...cmp.problems);
    if (!v13.ok || v13.failed.length) problems.push(`verify_0013 peruutuksen jälkeen: ${JSON.stringify(out.verify0013)}`);
    if (!again.ok) problems.push(`0014 uudelleen peruutuksen jälkeen: ${again.error.message}`);
    out.pass = problems.length === 0;
    out.problems = problems;
    for (const p of problems) fail(scenario, `0014: ${p}`);
  } finally { await client.end(); await dropDatabase(db); }
  return out;
}

/**
 * 0015: aallon L kirjoitukset (suojattu aika, viikkosuunnitelma, tehtävien
 * horisontit, odotus, päivätön tehtävä, alueen laji) -> ROLLBACK-osio.
 *
 * Ensin kaksi aluetta samalla kategorialla: peruutuksen vartija kaatuu
 * kiinni (kategorian uniikkiutta ei voi palauttaa) eikä muuta mitään.
 * Korjauksen (toisen alueen kategoria pois) jälkeen peruutus menee läpi:
 * katalogi = tila 0014 täsmälleen, vanhojen taulujen rivit (vanhat
 * sarakkeet, xmin, relfilenode) ennallaan, verify_0014 0 FAIL ja 0015
 * menee uudelleen läpi. tasks.date-sarakkeen nullable-tila ei muutu
 * (harjoittelun lähtötilassa se on aina ollut nullable).
 */
async function case0015({ fail, scenario }) {
  const db = 'mv_rehearsal_rbd_0015';
  const client = await cloneProdShape('0014', db);
  const out = { migration: '0015' };
  try {
    const items0 = await catalogItems(client);
    const snap0 = await snapshotTables(client);
    await migrate(client, '0015');
    const ops = await waveWrites('L', { prefix: 'rb15', upsertOwnRows: false });
    const writes = await runWrites(client, ops);
    out.writes = writes;
    const dup = await postgrestWrite(client, OWNER, 'life_areas',
      { id: 'rb15-la-dup', name: 'Jaettu kategoria', category_key: 'tyo', kind: 'STANDARD' }, { method: 'insert' });
    const dup2 = await postgrestWrite(client, OWNER, 'life_areas',
      { id: 'rb15-la-dup2', name: 'Jaettu kategoria 2', category_key: 'tyo', kind: 'OWN_TIME' }, { method: 'insert' });
    out.sharedCategoryWritten = dup.ok && dup2.ok;
    const counts = (await client.query(
      `select ${TABLES_0015.map(t => `(select count(*) from public.${t})::int as ${t}`).join(', ')},
              (select count(*) from public.tasks where date is null)::int as dateless,
              (select count(*) from public.tasks where horizon is not null or waiting_on is not null)::int as with_horizon`)).rows[0];
    out.rowsBeforeRollback = counts;
    const itemsBefore = await catalogItems(client);
    const refused = await runSql(client, rollbackSql('0015'));
    const dRefused = diffCatalog(itemsBefore, await catalogItems(client));
    out.guardedRollback = { ok: refused.ok, error: refused.error?.message || null,
                            catalogUnchanged: !dRefused.added.length && !dRefused.removed.length };
    const fixed = await client.query(`update public.life_areas set category_key = null where id = 'rb15-la-dup2'`);
    out.sharedCategoryResolved = fixed.rowCount;
    const beforeRollback = await legacyDigests(client, snap0);
    const rolled = await runSql(client, rollbackSql('0015'));
    out.rollback = { ok: rolled.ok, error: rolled.error?.message || null };
    const d = diffCatalog(items0, await catalogItems(client));
    out.catalogEqualsPre0015 = !d.added.length && !d.removed.length;
    const cmp = await compareSnapshot(client, snap0, { allowAdded: true });
    out.legacyRows = cmp.perTable;
    const v14 = await runVerify(client, 'supabase/verify/verify_0014.sql');
    out.verify0014 = v14.ok ? { fail: v14.failed.length, poikkeavia: v14.poikkeavia } : { error: v14.error.message };
    out.datelessKept = Number((await client.query('select count(*) from public.tasks where date is null')).rows[0].count);
    const again = await runSql(client, migrationSql('0015'));
    out.reapplied = again.ok;
    const problems = [];
    if (writes.failed.length) problems.push(`aallon L kirjoitukset: ${writes.failed.join('; ')}`);
    if (!out.sharedCategoryWritten) problems.push(`jaettua kategoriaa ei voitu kirjoittaa: ${JSON.stringify({ dup, dup2 })}`);
    const empty = TABLES_0015.filter(t => !(counts[t] >= 1));
    if (empty.length) problems.push(`dataa puuttuu tauluista: ${empty.join(', ')}`);
    if (!(counts.dateless >= 1)) problems.push('aalto L ei kirjoittanut päivätöntä tehtävää');
    if (!(counts.with_horizon >= 1)) problems.push('aalto L ei kirjoittanut horisonttia');
    if (refused.ok) problems.push('peruutus meni läpi, vaikka kaksi aluetta jakaa kategorian');
    else if (!/jakaa kategorian/.test(refused.error.message)) problems.push(`vartijan viesti puuttuu: ${refused.error.message}`);
    if (!out.guardedRollback.catalogUnchanged) problems.push('hylätty peruutus muutti katalogia');
    if (!rolled.ok) problems.push(`peruutus kaatui: ${rolled.error.message}`);
    if (!out.catalogEqualsPre0015) problems.push(`katalogi ≠ ennen 0015: ${JSON.stringify(d).slice(0, 600)}`);
    problems.push(...sameDigests(beforeRollback, await legacyDigests(client, snap0)));
    problems.push(...cmp.problems);
    if (!v14.ok || v14.failed.length) problems.push(`verify_0014 peruutuksen jälkeen: ${JSON.stringify(out.verify0014)}`);
    if (!again.ok) problems.push(`0015 uudelleen peruutuksen jälkeen: ${again.error.message}`);
    out.pass = problems.length === 0;
    out.problems = problems;
    for (const p of problems) fail(scenario, `0015: ${p}`);
  } finally { await client.end(); await dropDatabase(db); }
  return out;
}

export async function rollbackDataScenario({ fail }) {
  const scenario = 'rollback:data';
  return [await case0010({ fail, scenario }), await case0012({ fail, scenario }), await case0013({ fail, scenario }),
          await case0014({ fail, scenario }), await case0015({ fail, scenario })];
}

/**
 * Väärä järjestys 0014 ennen 0015:tä omassa kloonissaan. 0014:n
 * ROLLBACK-osiossa ei ole 0015-vartijaa (0014 on lukittu K:n
 * SQL-lähteessä), ja 0015:n objektit eivät riipu 0014:stä, joten
 * peruutus menee läpi. Kirjataan TIEDOKSI, ja todennetaan, että
 * inventaarion pisteytys pysäyttää (STOP: järjestys rikki) sellaisen
 * tilan ennen seuraavaa askelta.
 */
async function outOfOrder0014({ scenario, fail }) {
  const { parseInventory, scoreInventory } = await import('../activation/score-inventory.mjs');
  const db = 'mv_rehearsal_rbchain_ooo15';
  const client = await cloneProdShape('0015', db);
  try {
    const r = await runSql(client, rollbackSql('0014'));
    const inv = await runInventory(client);
    const scored = scoreInventory(parseInventory(inv.cell));
    const out = { informational: true, rollback0014Ok: r.ok, error: r.error?.message || null,
                  inventoryDecision: scored.decision,
                  migrations: { '0014': scored.facts.migrations?.['0014'], '0015': scored.facts.migrations?.['0015'] },
                  stops: scored.stops };
    if (r.ok && scored.decision !== 'STOP') fail(scenario, `0014 peruttu 0015:n ollessa ajettu, mutta inventaario sanoo ${scored.decision}`);
    return out;
  } finally { await client.end(); await dropDatabase(db); }
}

/**
 * Väärä järjestys 0013 ennen 0014:ää omassa kloonissaan. 0013:n
 * ROLLBACK-osiossa ei ole 0014-vartijaa (0013 on lukittu, eikä sitä
 * muuteta), joten peruutus menee läpi ja jättää 0014:n taulut tilaan,
 * jota juna ei tunne. Tämä kirjataan TIEDOKSI, ja todennetaan, että
 * inventaarion pisteytys pysäyttää (STOP) sellaisen tilan ennen
 * seuraavaa askelta.
 */
async function outOfOrder0013({ scenario, fail }) {
  const { parseInventory, scoreInventory } = await import('../activation/score-inventory.mjs');
  const db = 'mv_rehearsal_rbchain_ooo';
  const client = await cloneProdShape('0014', db);
  try {
    const r = await runSql(client, rollbackSql('0013'));
    const inv = await runInventory(client);
    const scored = scoreInventory(parseInventory(inv.cell));
    const tables14 = Number((await client.query(
      `select count(*) from pg_tables where schemaname = 'public' and tablename = any($1::text[])`, [TABLES_0014])).rows[0].count);
    const out = { informational: true, rollback0013Ok: r.ok, error: r.error?.message || null, tables0014Left: tables14,
                  inventoryDecision: scored.decision, migrations: { '0013': scored.facts.migrations?.['0013'], '0014': scored.facts.migrations?.['0014'] },
                  stops: scored.stops };
    // Hylkäys vain, jos inventaario EI pysäyttäisi tällaista tilaa.
    if (r.ok && scored.decision !== 'STOP') fail(scenario, `0013 peruttu 0014:n ollessa ajettu, mutta inventaario sanoo ${scored.decision}`);
    return out;
  } finally { await client.end(); await dropDatabase(db); }
}

export async function reverseChainScenario({ fail }) {
  const scenario = 'rollback:reverse-chain';
  const db = 'mv_rehearsal_rbchain';
  const client = await cloneProdShape('0008', db);
  const out = { forward: [], outOfOrder: null, reverse: [] };
  const train = trainWaves();
  try {
    const items8 = await catalogItems(client);
    const snap8 = await snapshotTables(client);
    for (const n of CHAIN) {
      await migrate(client, n);
      const w = await runWrites(client, await waveWrites(WAVE_OF[n], { prefix: `rc${n}`, upsertOwnRows: false, train }));
      out.forward.push({ migration: n, wave: WAVE_OF[n], writes: w.count, failed: w.failed });
      for (const f of w.failed) fail(scenario, `${n} aalto ${WAVE_OF[n]}: ${f}`);
    }
    // Väärä järjestys: 0012 ennen 0013:a -> vartija kaatuu kiinni.
    {
      const before = await catalogItems(client);
      const r = await runSql(client, rollbackSql('0012'));
      const d = diffCatalog(before, await catalogItems(client));
      out.outOfOrder = { ok: r.ok, error: r.error?.message || null, catalogUnchanged: !d.added.length && !d.removed.length };
      if (r.ok) fail(scenario, '0012:n peruutus meni läpi vaikka 0013 on ajettu');
      else if (!/0013/.test(r.error.message)) fail(scenario, `0012:n peruutus kaatui ilman vartijan viestiä: ${r.error.message}`);
      if (!out.outOfOrder.catalogUnchanged) fail(scenario, 'väärän järjestyksen peruutus muutti katalogia');
    }
    for (const n of [...CHAIN].reverse()) {
      const step = { migration: n };
      if (n === '0010') step.maintenanceGoalsReset = (await client.query(MAINTENANCE_FIX)).rowCount;
      const r = await runSql(client, rollbackSql(n));
      step.ok = r.ok;
      step.error = r.error?.message || null;
      out.reverse.push(step);
      if (!r.ok) { fail(scenario, `peruutus ${n} kaatui: ${r.error.message}`); break; }
    }
    const d = diffCatalog(items8, await catalogItems(client));
    out.catalogEqualsProd0008 = !d.added.length && !d.removed.length;
    if (!out.catalogEqualsProd0008) fail(scenario, `katalogi ≠ tuotannon 0008: ${JSON.stringify(d).slice(0, 600)}`);
    const cmp = await compareSnapshot(client, snap8, { allowAdded: true });
    out.legacyRows = cmp.perTable;
    for (const p of cmp.problems) fail(scenario, `vanhat rivit: ${p}`);
    out.pass = out.catalogEqualsProd0008 && cmp.problems.length === 0 && out.reverse.every(s => s.ok)
      && out.outOfOrder && !out.outOfOrder.ok && out.forward.every(f => !f.failed.length);
  } finally { await client.end(); await dropDatabase(db); }
  out.outOfOrder0013Before0014 = await outOfOrder0013({ scenario, fail });
  out.outOfOrder0014Before0015 = await outOfOrder0014({ scenario, fail });
  return out;
}
