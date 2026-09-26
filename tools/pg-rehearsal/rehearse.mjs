// Migraatioharjoittelu oikeaa PostgreSQL:ää vasten — EI TUOTANTOA.
//
// Käyttö:
//   node tools/pg-rehearsal/rehearse.mjs [--json=raportti.json] [--only=upgrade,rls,failure]
//                                        [--write-golden] [--fixtures=DIR]
//
// Vaatii paikallisen PostgreSQL 17 -klusterin osoitteessa 127.0.0.1
// (portti PG_REHEARSAL_PORT, oletus 54349), jonka data-hakemisto on
// projektin .claude/pg-local-hakemistossa (lib.assertRehearsalServer),
// ja pg-ajurin, ks. README.md.
//
// Skenaariot (--only hyväksyy nimen tai etuliitteen, esim. prodshape):
//   upgrade:text   lähtötila (date/time tekstinä) -> 0001..0013, siemennys joka välissä;
//                  vanhat rivit (vanhat sarakkeet, xmin, relfilenode) ennallaan 0003:sta alkaen
//   upgrade:typed  sama, date/time omina tyyppeinään
//   rls            eristysmatriisi kaikille tauluille lopputilassa
//   lifecycle      poistosäännöt: alue/tavoite/tehtävä/käyttäjä
//   failure        uudelleenajo, puuttuva esiehto, osittainen tila, lukon aikakatkaisu
//   rollback       jokaisen ROLLBACK-osion ajo tyhjillä uusilla objekteilla
//   preflight      jokainen preflight jokaisessa tilassa 0007..0013
//   inventory      aktivoinnin inventaario + pisteytys jokaisessa tilassa
//   prodshape:fixture      tuotannon 0008-tila = omistajan inventaario (prodshape.mjs)
//   values:0010            0010 säilyttää jokaisen vanhan arvon (5 tilaa × projekti)
//   prodshape:chain        0009..0013 tuotannon datalla + kultaiset skeemaerot
//   prodshape:pause        taukopisteet: aaltojen oikeat kirjoitukset, verify, preflight
//   failure:0010-locks     estäjämatriisi, myöhäinen virhe, jumi, lukkiutuminen (+0009, 0011)
//   verify:null            poikkeavia_yhteensa = FAIL-rivit myös NULL-tuloksilla
//   preflight:blockers     lukitut taulut ja politiikkamäärät havaitaan etukäteen
//   rollback:data          peruutukset datan kanssa (0010, 0012, 0013)
//   rollback:reverse-chain 0013..0009 käänteisessä järjestyksessä -> tuotannon 0008
//   role:nonsuper          migraatiot NOSUPERUSER-omistajana, preflightin näkyvyys
//
// Vain nimenomaisesti (--only=backup; ei kuulu oletusajoon, OPT_IN_SCENARIOS):
//   backup         looginen tilannekuva ja palautus B1–B15 (backup-scenario.mjs);
//                  --backup-fixtures=tests/fixtures/backup kirjoittaa yksikkötestien
//                  aineiston (ERI hakemisto kuin --fixtures). Ennen yhtäkään yhteyttä
//                  sama vahti kuin rehearse-backup.mjs:ssä (lib.guardBackupRehearsal):
//                  PG_REHEARSAL_PORT nimenomaisesti ja ei 54329, PostgreSQL >= 17,
//                  data_directory pääkansion .claude/pg-local/-hakemistossa.
//
// Jokainen kanta on kertakäyttöinen (mv_rehearsal_*) ja poistetaan lopuksi.
// Pelkkä importti ei aja mitään (pääohjelmavahti alla).

import fs, { writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  connect, createDatabase, dropDatabase, runSql, runVerify, readSql, asUser, tryAs,
  catalogItems, diffCatalog, scalar, provenance, isMain, extractRollback, guardBackupRehearsal,
  SERVER, OWNER, USER_B
} from './lib.mjs';
import { MIGRATIONS, numberOf, prepareBaseline, applyMigration } from './chain.mjs';
import { SEEDS, ID_OWNED } from './seeds.mjs';
import { runInventory, snapshotTables, compareSnapshot, dropTemplates } from './prodshape.mjs';

export { extractRollback };

const USER_C = 'cccccccc-0000-4000-8000-00000000000c';

/** Kaikki skenaariot ajojärjestyksessä. */
export const SCENARIOS = Object.freeze([
  'preflight', 'rollback', 'inventory', 'upgrade:text', 'upgrade:typed', 'rls', 'lifecycle', 'failure',
  'prodshape:fixture', 'values:0010', 'prodshape:chain', 'prodshape:pause', 'verify:null', 'preflight:blockers',
  'rollback:data', 'rollback:reverse-chain', 'failure:0010-locks', 'role:nonsuper'
]);

/** Skenaariot, jotka ajetaan VAIN nimettyinä (--only=backup), eivät oletusajossa. */
export const OPT_IN_SCENARIOS = Object.freeze(['backup']);

let args = {};
let only = null;
const want = name => !only || only.has(name) || only.has(name.split(':')[0]);
/** Nimenomaisesti pyydetty (OPT_IN_SCENARIOS): pelkkä oletusajo ei riitä. */
const wantExplicit = name => Boolean(only && only.has(name));

const report = {
  startedAt: null,
  server: null,
  scenarios: {},
  failures: []
};

function fail(scenario, message) {
  report.failures.push(`${scenario}: ${message}`);
}

/** Todennuksen / esitarkistuksen ristiintarkistus (lib.runVerify). */
function checkCounts(scenario, label, part) {
  if (part?.countMismatch) fail(scenario, `${label}: poikkeavia_yhteensa (${part.poikkeavia}) ≠ FAIL-rivien määrä`);
}

async function seedFor(client, number, scenario) {
  for (const seed of SEEDS.filter(s => s.since === number)) {
    for (const [p, uid] of [['a', OWNER], ['b', USER_B]]) {
      if (seed.ownerOnlyB && p === 'a') continue;
      try {
        await asUser(client, uid, () => client.query(seed.sql(p)));
      } catch (error) {
        fail(scenario, `siemen ${seed.table} (${p}) migraation ${number} jälkeen: ${error.message}`);
      }
    }
  }
}

async function upgradeScenario(variant) {
  const scenario = `upgrade:${variant}`;
  const db = `mv_rehearsal_upgrade_${variant}`;
  await createDatabase(db);
  const client = await connect(db);
  const steps = [];
  try {
    await prepareBaseline(client, variant);
    for (const name of MIGRATIONS) {
      const n = numberOf(name);
      // Vanha data ennen migraatiota. Uusi migraatio EI saa muuttaa sitä —
      // paitsi 0001, joka tarkoituksella lisää omistajan (ja 0002 ajan).
      // Tilannekuva: jokaisen taulun rivit rajattuina migraatiota edeltäviin
      // sarakkeisiin (md5), rivin xmin ja taulun relfilenode.
      const before = n >= '0003' ? await snapshotTables(client) : null;
      const record = await applyMigration(client, name);
      steps.push(record);
      if (!record.ok) { fail(scenario, `${name} kaatui: ${record.error.message}`); break; }
      if (record.verify?.fail?.length) {
        for (const f of record.verify.fail) fail(scenario, `verify_${n}: ${f}`);
      }
      if (record.verify?.error) fail(scenario, `verify_${n} kaatui: ${record.verify.error}`);
      checkCounts(scenario, `verify_${n}`, record.verify);
      // 0009+ esitarkistukset (tools/activation/build-preflights.mjs) on
      // ajettava puhtaasti juuri ennen omaa migraatiotaan. (0003:n
      // "yksi auth-käyttäjä" on tuotantokohtainen eikä koske tätä.)
      if (n >= '0009') {
        if (!record.preflight) fail(scenario, `preflight_${n}.sql puuttuu`);
        else if (record.preflight.error) fail(scenario, `preflight_${n} kaatui: ${record.preflight.error}`);
        else for (const f of record.preflight.fail) fail(scenario, `preflight_${n}: ${f}`);
        checkCounts(scenario, `preflight_${n}`, record.preflight);
      }
      if (before) {
        // Arvot vanhoissa sarakkeissa, rivien xmin (ei UPDATEa) ja taulun
        // relfilenode (ei uudelleenkirjoitusta) — ei pelkkä rivimäärä.
        const cmp = await compareSnapshot(client, before);
        record.legacy = cmp.perTable;
        for (const p of cmp.problems) fail(scenario, `${name}: ${p}`);
      }
      await seedFor(client, n, scenario);
    }
    // Alkuperäiset 36 tehtävää säilyivät ja kuuluvat omistajalle.
    const orig = await client.query(
      `select count(*) filter (where user_id = $1) as owned, count(*) as total,
              count(*) filter (where id like 'seed%' or id like 'm%') as legacy
         from public.tasks`, [OWNER]);
    const legacy = orig.rows[0];
    steps.push({ legacyTasks: legacy });
    if (Number(legacy.legacy) !== 36) fail(scenario, `alkuperäisiä tehtäviä ${legacy.legacy}, odotettiin 36`);
    const goalsWithArea = await scalar(client,
      `select count(*) from public.goals where life_area_id is not null`);
    steps.push({ goalsWithLifeAreaAfterMigration: Number(goalsWithArea) });
    if (Number(goalsWithArea) !== 0) fail(scenario, '0012 liitti tavoitteita alueisiin (tuhoava täyttö)');

    if (variant === 'text' && want('rls')) {
      report.scenarios.rls = await rlsScenario(client);
    }
    if (variant === 'text' && want('lifecycle')) {
      report.scenarios.lifecycle = await lifecycleScenario(client);
    }
  } finally {
    await client.end();
    await dropDatabase(db);
  }
  return steps;
}

// ---------------------------------------------------------------------
// RLS-matriisi
// ---------------------------------------------------------------------

async function rlsScenario(client) {
  const scenario = 'rls';
  await client.query(`insert into auth.users (id, email) values ($1, 'user-c@rehearsal.invalid')`, [USER_C]);
  const tables = (await client.query(
    `select c.relname, c.relrowsecurity, c.relforcerowsecurity
       from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
      order by 1`)).rows;
  const results = [];
  for (const { relname: t, relrowsecurity } of tables) {
    const oc = ID_OWNED.has(t) ? 'id' : 'user_id';
    const r = { table: t, rls: relrowsecurity, checks: {} };
    const record = (name, pass, detail) => {
      r.checks[name] = pass ? 'PASS' : `FAIL ${detail || ''}`.trim();
      if (!pass) fail(scenario, `${t}: ${name} ${detail || ''}`);
    };
    record('rls_enabled', relrowsecurity === true);

    const bRow = (await client.query(`select * from public.${t} where ${oc} = $1 limit 1`, [USER_B])).rows[0];
    const aRow = (await client.query(`select * from public.${t} where ${oc} = $1 limit 1`, [OWNER])).rows[0];
    record('seeded_both_users', Boolean(aRow && bRow), `A=${Boolean(aRow)} B=${Boolean(bRow)}`);
    if (!aRow || !bRow) { results.push(r); continue; }
    const pk = 'id';

    // 1. SELECT B:n rivi A:na
    const sel = await tryAs(client, OWNER, `select 1 from public.${t} where ${oc} = $1`, [USER_B]);
    record('A_cannot_select_B', sel.ok && sel.rowCount === 0, JSON.stringify(sel));
    // A näkee vain omansa
    const total = await tryAs(client, OWNER, `select ${oc}::text as o from public.${t}`);
    record('A_sees_only_own', total.ok && total.rows.every(x => x.o === OWNER), `rows=${total.rowCount}`);

    // 2. UPDATE B:n rivi A:na
    const upd = await tryAs(client, OWNER, `update public.${t} set ${oc} = ${oc} where ${pk} = $1`, [bRow[pk]]);
    record('A_cannot_update_B', upd.ok && upd.rowCount === 0, JSON.stringify(upd));

    // 3. DELETE B:n rivi A:na
    const del = await tryAs(client, OWNER, `delete from public.${t} where ${pk} = $1`, [bRow[pk]]);
    const stillThere = await scalar(client, `select count(*) from public.${t} where ${pk} = $1`, [bRow[pk]]);
    record('A_cannot_delete_B', del.ok && del.rowCount === 0 && Number(stillThere) === 1, JSON.stringify(del));

    // 4. INSERT B:n nimissä A:na (kopio A:n rivistä, omistaja vaihdettu)
    const cols = Object.keys(aRow).filter(c => !['created_at', 'updated_at'].includes(c));
    const copy = { ...aRow };
    const target = ID_OWNED.has(t) ? USER_C : USER_B;
    copy[oc] = target;
    if (oc !== 'id') copy.id = `${aRow.id}-forged`;
    // Uniikkiavaimet, jotka sisältävät muita sarakkeita, eivät saa ehtiä
    // kaatamaan lisäystä ennen RLS:ää: muutetaan ne ainutkertaisiksi.
    if ('operation_id' in copy && copy.operation_id) copy.operation_id = `${copy.operation_id}-forged`;
    if ('notice_key' in copy) copy.notice_key = `${copy.notice_key}-forged`;
    if ('week_start' in copy) copy.week_start = '2026-06-01';
    if ('name' in copy && t === 'life_areas') copy.name = 'Väärennetty';
    if (t === 'life_areas') copy.category_key = null;
    if (t === 'wellbeing_entries') copy.date = '2026-06-02';
    if (t === 'routine_exceptions') copy.date = '2026-06-03';
    if (t === 'alignment_item_settings') copy.item_id = 'forged-item';
    // Viittaukset A:n riveihin nollataan, jotta vierasavain ei kaada ensin.
    const fks = (await client.query(
      `select a.attname from pg_constraint c
         join lateral unnest(c.conkey) k(n) on true
         join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.n
        where c.conrelid = $1::regclass and c.contype = 'f' and a.attname not in ('user_id', 'id')`,
      [`public.${t}`])).rows.map(x => x.attname);
    for (const f of fks) if (f in copy && !(t === 'routine_exceptions' && f === 'routine_id')
                              && !(t === 'milestones' && f === 'goal_id')) copy[f] = null;
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
    const values = cols.map(c => copy[c]);
    const ins = await tryAs(client, OWNER,
      `insert into public.${t} (${cols.join(', ')}) values (${placeholders})`, values);
    record('A_cannot_insert_as_other', !ins.ok && ins.code === '42501', JSON.stringify(ins));

    // 5. A siirtää oman rivinsä B:lle
    const move = await tryAs(client, OWNER,
      `update public.${t} set ${oc} = $1 where ${pk} = $2`, [target, aRow[pk]]);
    record('A_cannot_reassign_own_to_B', !move.ok && ['42501', '23503', '23505'].includes(move.code),
      JSON.stringify(move));
    if (!move.ok) r.reassignCode = move.code;

    // 6. anon ei pääse mihinkään
    const anonSel = await tryAs(client, null, `select 1 from public.${t} limit 1`, [], { role: 'anon' });
    record('anon_cannot_select', !anonSel.ok && anonSel.code === '42501', JSON.stringify(anonSel));
    const anonIns = await tryAs(client, null, `insert into public.${t} (id) values (null)`, [], { role: 'anon' });
    record('anon_cannot_insert', !anonIns.ok && anonIns.code === '42501', JSON.stringify(anonIns));

    // 7. authenticated ilman sub-väitettä (vanhentunut/puuttuva token) ei näe mitään
    const nosub = await tryAs(client, null, `select 1 from public.${t}`);
    record('authenticated_without_sub_sees_nothing', nosub.ok && nosub.rowCount === 0, JSON.stringify(nosub));

    // 8. Ristiviittaus: A:n rivi osoittaa B:n riviin yhdistelmävierasavaimella
    const compositeFks = (await client.query(
      `select c.conname, a.attname as col, c.confrelid::regclass::text as target
         from pg_constraint c
         join lateral unnest(c.conkey) k(n) on true
         join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.n
        where c.conrelid = $1::regclass and c.contype = 'f'
          and array_length(c.conkey, 1) = 2 and a.attname <> 'user_id'`,
      [`public.${t}`])).rows;
    for (const fk of compositeFks) {
      const targetRow = (await client.query(
        `select id from ${fk.target} where user_id = $1 limit 1`, [USER_B])).rows[0];
      if (!targetRow) { record(`cross_user_fk:${fk.col}`, false, `B:llä ei riviä taulussa ${fk.target}`); continue; }
      // routine_exceptions: uniikkius (routine_id, date) on globaali, joten
      // päivä vaihdetaan ainutkertaiseksi, jotta vierasavain testataan eikä
      // uniikkius (ks. docs/FOLLOWUP-routine-exceptions-uniqueness.md).
      const extraSet = t === 'routine_exceptions' ? ", date = '2026-06-04'" : '';
      const x = await tryAs(client, OWNER,
        `update public.${t} set ${fk.col} = $1${extraSet} where ${pk} = $2`, [targetRow.id, aRow[pk]]);
      record(`cross_user_fk:${fk.col}`, !x.ok && x.code === '23503', JSON.stringify(x));
    }
    results.push(r);
  }

  // Globaali: yhdelläkään public-taululla ei ole PUBLIC- tai anon-oikeutta.
  const leaks = (await client.query(
    `select c.relname, a.privilege_type, coalesce(r.rolname, 'PUBLIC') as grantee
       from pg_class c cross join lateral aclexplode(c.relacl) a
       left join pg_roles r on r.oid = a.grantee
      where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
        and (a.grantee = 0 or r.rolname = 'anon')`)).rows;
  if (leaks.length) fail(scenario, `anon/PUBLIC-oikeuksia: ${JSON.stringify(leaks)}`);
  const extra = (await client.query(
    `select c.relname, a.privilege_type from pg_class c cross join lateral aclexplode(c.relacl) a
       join pg_roles r on r.oid = a.grantee
      where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
        and r.rolname = 'authenticated'
        and a.privilege_type not in ('SELECT', 'INSERT', 'UPDATE', 'DELETE')`)).rows;
  return {
    tables: results.length,
    checks: results.reduce((n, r) => n + Object.keys(r.checks).length, 0),
    failed: results.reduce((n, r) => n + Object.values(r.checks).filter(v => v !== 'PASS').length, 0),
    anonOrPublicGrants: leaks,
    authenticatedExtraPrivileges: extra,
    results
  };
}

// ---------------------------------------------------------------------
// Poistosäännöt ja tilin elinkaari
// ---------------------------------------------------------------------

async function lifecycleScenario(client) {
  const scenario = 'lifecycle';
  const out = {};
  const check = (name, pass, detail) => {
    out[name] = pass ? 'PASS' : `FAIL ${detail || ''}`;
    if (!pass) fail(scenario, `${name} ${detail || ''}`);
  };
  // Tavoitteen poisto A:na: kirjattu aika säilyy, viite nollautuu,
  // välitavoite (cascade) poistuu, projekti säilyy irrotettuna.
  await asUser(client, OWNER, () => client.query(`delete from public.goals where id = 'a-goal'`));
  const te = (await client.query(`select goal_id, life_area_id, minutes from public.time_entries where id = 'a-te'`)).rows[0];
  check('goal_delete_keeps_time_entry', te && te.goal_id === null && te.life_area_id === 'a-la' && te.minutes === 30,
    JSON.stringify(te));
  const ms = await scalar(client, `select count(*) from public.milestones where id = 'a-ms'`);
  check('goal_delete_cascades_milestones', Number(ms) === 0, ms);
  const proj = (await client.query(`select goal_id from public.projects where id = 'a-proj'`)).rows[0];
  check('goal_delete_detaches_project', proj && proj.goal_id === null, JSON.stringify(proj));

  // Alueen poisto: aika säilyy, alue nollautuu, ajastin säilyy.
  await asUser(client, OWNER, () => client.query(`delete from public.life_areas where id = 'a-la'`));
  const te2 = (await client.query(`select life_area_id, minutes from public.time_entries where id in ('a-te','a-te2') order by id`)).rows;
  check('area_delete_keeps_time', te2.length === 2 && te2.every(x => x.life_area_id === null), JSON.stringify(te2));

  // Tehtävän poisto: ajastin ja kirjaus säilyvät ilman viitettä.
  await asUser(client, OWNER, () => client.query(`delete from public.tasks where id = 'a-task'`));
  const timer = (await client.query(`select task_id from public.running_timers where id = 'a-timer'`)).rows[0];
  check('task_delete_keeps_timer_detached', timer && timer.task_id === null, JSON.stringify(timer));
  const bill = (await client.query(`select task_id from public.bills where id = 'a-bill'`)).rows[0];
  check('task_delete_keeps_bill_detached', bill && bill.task_id === null, JSON.stringify(bill));

  // Yksi ajastin per käyttäjä.
  const second = await tryAs(client, OWNER,
    `insert into public.running_timers (id, started_at) values ('a-timer-2', now())`);
  check('one_timer_per_user', !second.ok && second.code === '23505', JSON.stringify(second));
  // B:n ajastin ei estä A:ta (uniikkius on käyttäjäkohtainen).
  // Sama operation_id kahdesti = sama kirjaus (idempotenssi).
  const dup = await tryAs(client, USER_B,
    `insert into public.time_entries (id, entry_date, minutes, operation_id, source) values ('b-te-dup', '2026-09-23', 10, 'op:b:1', 'manual')`);
  check('operation_id_duplicate_rejected', !dup.ok && dup.code === '23505', JSON.stringify(dup));
  const sameOpOther = await tryAs(client, OWNER,
    `insert into public.time_entries (id, entry_date, minutes, operation_id, source) values ('a-te-op', '2026-09-23', 10, 'op:b:1', 'manual')`);
  check('operation_id_is_per_user', sameOpOther.ok, JSON.stringify(sameOpOther));
  // Rajat: nolla ja yli vuorokauden kesto hylätään.
  const zero = await tryAs(client, OWNER,
    `insert into public.time_entries (id, entry_date, minutes) values ('a-te-zero', '2026-09-23', 0)`);
  check('zero_minutes_rejected', !zero.ok && zero.code === '23514', JSON.stringify(zero));
  const huge = await tryAs(client, OWNER,
    `insert into public.time_entries (id, entry_date, minutes) values ('a-te-huge', '2026-09-23', 1441)`);
  check('over_day_minutes_rejected', !huge.ok && huge.code === '23514', JSON.stringify(huge));
  const badWeek = await tryAs(client, OWNER,
    `insert into public.weekly_capacities (id, week_start, available_minutes) values ('a-cap-x', '2026-09-22', 10)`);
  check('capacity_week_must_be_monday', !badWeek.ok && badWeek.code === '23514', JSON.stringify(badWeek));
  const zeroCap = await tryAs(client, OWNER,
    `insert into public.weekly_capacities (id, week_start, available_minutes) values ('a-cap-0', '2026-09-28', 0)`);
  check('zero_capacity_allowed', zeroCap.ok, JSON.stringify(zeroCap));
  const longName = await tryAs(client, OWNER,
    `insert into public.life_areas (id, name) values ('a-la-long', repeat('x', 61))`);
  check('area_name_over_60_rejected', !longName.ok && longName.code === '23514', JSON.stringify(longName));
  const timerEnds = await tryAs(client, OWNER,
    `insert into public.time_entries (id, entry_date, minutes, started_at, ended_at) values ('a-te-rev', '2026-09-23', 5, '2026-09-23T10:00Z', '2026-09-23T09:00Z')`);
  check('timer_end_before_start_rejected', !timerEnds.ok && timerEnds.code === '23514', JSON.stringify(timerEnds));

  // Taaksepäin yhteensopivuus: migraatio ajetaan aina SILLOIN kun
  // edellisen aallon koodi on tuotannossa (0010 ajetaan aallon F aikana
  // jne.). Vanhan koodin rivimuoto — ilman yhtäkään myöhemmän
  // migraation saraketta — on siis voitava kirjoittaa ja päivittää
  // 0013:n jälkeenkin. Muodot vastaavat src/lib/rows.js:n ja
  // collectionsRepo.js:n sarakejoukkoja kunkin aallon aikaan.
  const legacyShapes = [
    ['tasks (aalto C, 0002-sarakkeet)', `insert into public.tasks (id, date, time, end_time, title, category, note, completed, is_wake, description, duration_minutes, priority, scheduling_state)
       values ('a-old-task', '2026-09-24', '10:00', null, 'Vanha muoto', 'tyo', null, false, false, null, 30, 'normaali', 'manual')`],
    ['tasks päivitys vanhalla sarakejoukolla', `update public.tasks set title = 'Vanha muoto 2', duration_minutes = 45 where id = 'a-old-task'`],
    ['goals (aalto B, 0004-sarakkeet)', `insert into public.goals (id, title, description, category, priority, status, target_date, progress_mode, manual_progress, parent_goal_id, project_id)
       values ('a-old-goal', 'Vanha tavoite', null, 'kehitys', 'normaali', 'active', null, 'task_based', 0, null, null)`],
    ['projects (aalto B, 0004-sarakkeet)', `insert into public.projects (id, name, description, category, priority, status, goal_id, start_date, deadline)
       values ('a-old-proj', 'Vanha projekti', null, 'muu', 'normaali', 'active', 'a-old-goal', null, null)`],
    ['routines (aalto C)', `insert into public.routines (id, title, duration_minutes, recurrence_type, goal_id) values ('a-old-rout', 'Vanha rutiini', 20, 'daily', 'a-old-goal')`],
    ['bills (aalto D, 0007-sarakkeet)', `insert into public.bills (id, name, amount_minor, currency, due_date, status, paid_date, category, task_id, recurring_expense_id, note)
       values ('a-old-bill', 'Vanha lasku', 500, 'EUR', '2026-10-10', 'open', null, 'talous', null, null, null)`],
    ['profile upsert vanhoilla sarakkeilla', `update public.profile set age = 41, sleep_target_hours = 7.5 where id = '${OWNER}'`]
  ];
  for (const [label, sql] of legacyShapes) {
    const r = await tryAs(client, OWNER, sql);
    check(`legacy_shape_after_0013: ${label}`, r.ok && r.rowCount === 1, JSON.stringify(r));
  }

  // Tilin poisto: kaikki B:n rivit kaikista tauluista katoavat (cascade).
  const tables = (await client.query(
    `select c.relname from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'`)).rows
    .map(x => x.relname);
  const beforeB = {};
  for (const t of tables) {
    const oc = ID_OWNED.has(t) ? 'id' : 'user_id';
    beforeB[t] = Number(await scalar(client, `select count(*) from public.${t} where ${oc} = $1`, [USER_B]));
  }
  await client.query(`delete from auth.users where id = $1`, [USER_B]);
  const left = [];
  for (const t of tables) {
    const oc = ID_OWNED.has(t) ? 'id' : 'user_id';
    const n = Number(await scalar(client, `select count(*) from public.${t} where ${oc} = $1`, [USER_B]));
    if (n) left.push(`${t}=${n}`);
  }
  check('account_delete_cascades_all_tables', left.length === 0, left.join(','));
  out.userBRowsBeforeDelete = beforeB;
  const aStill = Number(await scalar(client, `select count(*) from public.tasks where user_id = $1`, [OWNER]));
  check('account_delete_leaves_other_user', aStill >= 36, aStill);
  return out;
}

// ---------------------------------------------------------------------
// Virhetilanteet: jokaisen migraation on kaaduttava kiinni
// ---------------------------------------------------------------------

async function freshAt(db, lastNumber, variant = 'text') {
  await createDatabase(db);
  const client = await connect(db);
  await prepareBaseline(client, variant);
  for (const name of MIGRATIONS) {
    if (numberOf(name) > lastNumber) break;
    const out = await runSql(client, readSql(`supabase/migrations/${name}.sql`));
    if (!out.ok) throw new Error(`${name}: ${out.error.message}`);
    await seedFor(client, numberOf(name), 'failure-setup');
  }
  return client;
}

async function expectClosedFailure(client, label, name, expect) {
  const before = await catalogItems(client);
  const out = await runSql(client, readSql(`supabase/migrations/${name}.sql`));
  const d = diffCatalog(before, await catalogItems(client));
  const unchanged = !d.added.length && !d.removed.length;
  const msgOk = !expect || (out.error && expect.test(out.error.message));
  const pass = !out.ok && unchanged && msgOk;
  if (!pass) {
    fail('failure', `${label}: ${out.ok ? 'MIGRAATIO MENI LÄPI' : 'virhe ' + out.error.message}`
      + `${unchanged ? '' : ` — KATALOGI MUUTTUI ${JSON.stringify(d).slice(0, 300)}`}`);
  }
  return { label, migration: name, pass, error: out.error?.message, code: out.error?.code,
           catalogUnchanged: unchanged };
}

async function failureScenario() {
  const results = [];

  // A. Toinen ajo jokaiselle 0009–0013: kaatuu, ei muuta mitään, ja
  //    sanoo "JO AJETTU" — ei "kesken". Väärä viesti ohjaisi ehjän kannan
  //    palautuspolulle (löydös: 0010 ja 0011 sanoivat "kesken").
  {
    const db = 'mv_rehearsal_fail_rerun_each';
    const client = await freshAt(db, '0008');
    try {
      for (const name of MIGRATIONS.filter(m => numberOf(m) >= '0009')) {
        const first = await runSql(client, readSql(`supabase/migrations/${name}.sql`));
        if (!first.ok) { fail('failure', `${name} ensimmäinen ajo: ${first.error.message}`); break; }
        results.push(await expectClosedFailure(client, `toinen ajo heti ${numberOf(name)}:n jälkeen`, name, /JO AJETTU/));
      }
    } finally { await client.end(); await dropDatabase(db); }
  }
  {
    const db = 'mv_rehearsal_fail_rerun';
    const client = await freshAt(db, '0013');
    try {
      for (const name of MIGRATIONS.filter(m => numberOf(m) >= '0009')) {
        results.push(await expectClosedFailure(client, `toinen ajo koko ketjun jälkeen ${numberOf(name)}`, name, /JO AJETTU/));
      }
    } finally { await client.end(); await dropDatabase(db); }
  }

  // B. Puuttuva esiehto: 0013 ennen 0012:ta, 0012/0011/0010/0009 ennen 0007:ää.
  {
    const db = 'mv_rehearsal_fail_prereq';
    const client = await freshAt(db, '0011');
    try {
      results.push(await expectClosedFailure(client, '0013 ilman 0012:ta', '0013_alignment_reality', null));
    } finally { await client.end(); await dropDatabase(db); }
    const db2 = 'mv_rehearsal_fail_prereq6';
    const c2 = await freshAt(db2, '0006');
    try {
      // 0010 ei tarvitse 0007:ää (se viittaa vain 0004:n tauluihin) — se
      // todennetaan erikseen alla informatiivisena, ei virheenä.
      for (const m of ['0009_finance_2', '0011_personal_assistant', '0012_life_alignment']) {
        results.push(await expectClosedFailure(c2, `${numberOf(m)} ilman 0007:ää`, m, null));
      }
      const out10 = await runSql(c2, readSql('supabase/migrations/0010_goal_to_action.sql'));
      results.push({ label: '0010 0006-tilaan (ei riipu 0007:stä)', pass: out10.ok, error: out10.error?.message, informational: true });
    } finally { await c2.end(); await dropDatabase(db2); }
  }

  // C. Väärä edeltävä skeema: 0012 suoraan 0008-tilaan (ohittaa 0009–0011).
  //    waves.mjs väittää 0012:n olevan riippumaton 0009–0011:stä — todennetaan.
  {
    const db = 'mv_rehearsal_fail_skip';
    const client = await freshAt(db, '0008');
    try {
      const out = await runSql(client, readSql('supabase/migrations/0012_life_alignment.sql'));
      results.push({ label: '0012 suoraan 0008-tilaan (riippumattomuusväite)', pass: out.ok,
                     error: out.error?.message, informational: true });
      const out13 = await runSql(client, readSql('supabase/migrations/0013_alignment_reality.sql'));
      results.push({ label: '0013 0008+0012-tilaan', pass: out13.ok, error: out13.error?.message,
                     informational: true });
    } finally { await client.end(); await dropDatabase(db); }
  }

  // D. Osittainen tila: yksi 0012:n / 0013:n / 0010:n objekti luotu käsin etukäteen.
  {
    const cases = [
      ['0011', '0012_life_alignment', 'create table public.life_areas (id text primary key)'],
      ['0011', '0012_life_alignment', 'alter table public.goals add column life_area_id text'],
      ['0012', '0013_alignment_reality', 'create table public.running_timers (id text primary key)'],
      ['0012', '0013_alignment_reality', 'alter table public.time_entries add column operation_id text'],
      ['0009', '0010_goal_to_action', 'alter table public.tasks add column depends_on text[]'],
      ['0010', '0011_personal_assistant', 'create table public.reminders (id text primary key)'],
      ['0008', '0009_finance_2', 'alter table public.bills add column iban text']
    ];
    let i = 0;
    for (const [at, name, sql] of cases) {
      const db = `mv_rehearsal_fail_partial_${i++}`;
      const client = await freshAt(db, at);
      try {
        await client.query(sql);
        results.push(await expectClosedFailure(client, `osittainen tila ennen ${numberOf(name)}: ${sql}`, name, /kesken|objekti|jo|already|olemassa/i));
      } finally { await client.end(); await dropDatabase(db); }
    }
  }

  // E. Lukon aikakatkaisu: toinen istunto pitää avointa transaktiota
  //    goals-taulussa (kuten PostgRESTin pitkä pyyntö tai unohtunut
  //    SQL-editorin välilehti). Migraation on luovuttava 5 s:ssa ja
  //    perututtava KAIKKI.
  for (const [at, name, table] of [['0009', '0010_goal_to_action', 'goals'],
                                   ['0011', '0012_life_alignment', 'goals'],
                                   ['0012', '0013_alignment_reality', 'time_entries']]) {
    const db = `mv_rehearsal_fail_lock_${numberOf(name)}`;
    const client = await freshAt(db, at);
    const blocker = await connect(db);
    try {
      await blocker.query('begin');
      await blocker.query(`select count(*) from public.${table}`);
      const t0 = Date.now();
      const r = await expectClosedFailure(client, `${numberOf(name)} kun ${table} on avoimen transaktion lukitsema`, name, /lock|lukko/i);
      r.waitedMs = Date.now() - t0;
      results.push(r);
      await blocker.query('rollback');
      // Ja sama migraatio menee läpi, kun lukko vapautuu.
      const retry = await runSql(client, readSql(`supabase/migrations/${name}.sql`));
      results.push({ label: `${numberOf(name)} uudelleen lukon vapauduttua`, pass: retry.ok, error: retry.error?.message });
      if (!retry.ok) fail('failure', `${name} ei mennyt läpi lukon vapauduttua: ${retry.error.message}`);
    } finally { await blocker.end(); await client.end(); await dropDatabase(db); }
  }

  // F. Rajoiterikkomus kesken ajon: 0010 lisää tarkisteen, jota olemassa
  //    oleva rivi rikkoo -> koko migraatio perutaan (transaktio).
  //    tasks.depends_on on 0010:n uusi sarake, joten suoraa ristiriitaa
  //    vanhassa datassa ei voi olla — todennetaan sen sijaan, että
  //    keskeytys JÄLKIMMÄISESSÄ vaiheessa perii koko ajon: luodaan
  //    0010:n viimeisen vaiheen nimeä käyttävä indeksi, jota esitarkistus
  //    ei tunne.
  {
    const db = 'mv_rehearsal_fail_late';
    const client = await freshAt(db, '0012');
    try {
      await client.query(`create index time_entries_user_operation_key_probe on public.time_entries (user_id)`);
      await client.query(`alter table public.time_entries add constraint time_entries_late_probe check (minutes < 1000)`);
      await client.query(`insert into public.time_entries (id, user_id, entry_date, minutes) values ('late-row', '${OWNER}', '2026-09-22', 999)`);
      // Tarkiste, jota 0013 ei tunne, ei estä sitä — mutta 0013 ajetaan nyt
      // tilaan, jossa alignment_reviews on ristiriidassa: policy_version-
      // sarakkeen lisäys onnistuu, joten todellinen myöhäinen virhe
      // tuotetaan vaihtamalla touch_updated_at SECURITY DEFINERiksi.
      await client.query(`alter function public.touch_updated_at() security definer`);
      results.push(await expectClosedFailure(client, '0013 kun jaettu funktio on muuttunut (myöhäinen esiehto)', '0013_alignment_reality', null));
    } finally { await client.end(); await dropDatabase(db); }
  }

  return results;
}

// ---------------------------------------------------------------------
// Aktivoinnin inventaario ja pisteytys jokaisessa junan tilassa
// ---------------------------------------------------------------------

// runInventory (prodshape.mjs): vain luku todennetaan kannalla, ei
// lupauksena — READ ONLY -transaktio kaataa minkä tahansa kirjoituksen.

async function inventoryScenario(fixtureDir) {
  const { parseInventory, scoreInventory } = await import('../activation/score-inventory.mjs');
  const results = [];
  const check = (label, pass, detail) => {
    results.push({ label, pass, detail });
    if (!pass) fail('inventory', `${label}: ${detail}`);
  };
  const cases = [
    ['0008', 'GO', '0009'], ['0009', 'GO', '0010'], ['0010', 'GO', '0011'],
    ['0011', 'GO', '0012'], ['0012', 'GO', '0013'], ['0013', 'GO', null]
  ];
  for (const variant of ['text', 'typed']) {
    for (const [state, decision, next] of cases) {
      const db = `mv_rehearsal_inv_${variant}_${state}`;
      const client = await freshAt(db, state, variant);
      try {
        const inv = await runInventory(client);
        check(`${variant}@${state}: inventaario ei muuta kantaa`, inv.unchanged, 'katalogi muuttui');
        const scored = scoreInventory(parseInventory(inv.cell));
        check(`${variant}@${state}: päätös ${decision}, seuraava ${next}`,
          scored.decision === decision && scored.nextMigration === next,
          JSON.stringify({ decision: scored.decision, next: scored.nextMigration, stops: scored.stops }));
        // Myös koko taulukko liitettynä (sarkainerotettuna) antaa saman.
        const tsv = inv.table.map(r => [r.nro, r.osio, r.tarkistus, r.arvo].join('\t')).join('\n');
        const fromTable = scoreInventory(parseInventory(tsv));
        check(`${variant}@${state}: taulukkosyöte = tiivistesyöte`,
          fromTable.decision === scored.decision && fromTable.nextMigration === scored.nextMigration,
          JSON.stringify(fromTable.stops));
        if (fixtureDir && variant === 'text') {
          fs.writeFileSync(path.join(fixtureDir, `state-${state}.json`), inv.cell + '\n');
        }
      } finally { await client.end(); await dropDatabase(db); }
    }
  }
  // Keskeneräinen 0012 -> STOP.
  {
    const db = 'mv_rehearsal_inv_partial';
    const client = await freshAt(db, '0011');
    try {
      await client.query('create table public.life_areas (id text primary key)');
      const inv = await runInventory(client);
      const scored = scoreInventory(parseInventory(inv.cell));
      check('keskeneräinen 0012: STOP', scored.decision === 'STOP' && scored.facts.migrations['0012'] === 'partial',
        JSON.stringify(scored));
      if (fixtureDir) fs.writeFileSync(path.join(fixtureDir, 'state-0011-partial-0012.json'), inv.cell + '\n');
    } finally { await client.end(); await dropDatabase(db); }
  }
  // Omistaja puuttuu (väärä projekti) -> STOP.
  {
    const db = 'mv_rehearsal_inv_noowner';
    const client = await freshAt(db, '0008');
    try {
      await client.query(`alter table public.tasks disable trigger all`);
      await client.query(`set session_replication_role = replica`);
      await client.query(`delete from auth.users where id = '${OWNER}'`);
      await client.query(`set session_replication_role = default`);
      const inv = await runInventory(client);
      const scored = scoreInventory(parseInventory(inv.cell));
      check('omistaja puuttuu: STOP', scored.decision === 'STOP' && scored.facts.ownerPresent === false,
        JSON.stringify(scored.stops));
      if (fixtureDir) fs.writeFileSync(path.join(fixtureDir, 'state-0008-no-owner.json'), inv.cell + '\n');
    } finally { await client.end(); await dropDatabase(db); }
  }
  return results;
}

// ---------------------------------------------------------------------
// Peruutus: migraation oma ROLLBACK-osio palauttaa skeeman
// ---------------------------------------------------------------------

// extractRollback on siirretty lib.mjs:ään (yksikkötestattava ilman
// palvelinta); tämä moduuli vie sen edelleen vanhoille kutsujille.

async function rollbackScenario() {
  const results = [];
  for (const name of MIGRATIONS.filter(m => numberOf(m) >= '0009')) {
    const n = numberOf(name);
    const prev = String(Number(n) - 1).padStart(4, '0');
    const db = `mv_rehearsal_rb_${n}`;
    const client = await freshAt(db, prev);
    try {
      const sql = readSql(`supabase/migrations/${name}.sql`);
      const rollback = extractRollback(sql);
      const before = await catalogItems(client);
      const applied = await runSql(client, sql);
      const rolled = rollback ? await runSql(client, rollback) : { ok: false, error: { message: 'ROLLBACK-lohkoa ei löytynyt' } };
      const d = diffCatalog(before, await catalogItems(client));
      const restored = !d.added.length && !d.removed.length;
      // Ja migraatio on ajettavissa uudelleen peruutuksen jälkeen.
      const again = await runSql(client, sql);
      const pass = applied.ok && rolled.ok && restored && again.ok;
      results.push({ migration: n, pass, applied: applied.ok, rolledBack: rolled.ok,
                     schemaRestored: restored, schemaDiff: restored ? null : d, reapplied: again.ok,
                     error: applied.error?.message || rolled.error?.message || again.error?.message });
      if (!pass) {
        fail('rollback', `${n}: ${!applied.ok ? 'migraatio kaatui' : !rolled.ok ? 'peruutus kaatui: ' + rolled.error.message
          : !restored ? `skeema ei palautunut: ${JSON.stringify(d).slice(0, 600)}` : 'uudelleenajo kaatui: ' + again.error?.message}`);
      }
    } finally { await client.end(); await dropDatabase(db); }
  }
  return results;
}

// ---------------------------------------------------------------------
// Esitarkistusmatriisi: jokainen preflight jokaisessa tilassa
// ---------------------------------------------------------------------

async function preflightScenario() {
  const results = [];
  const numbers = ['0009', '0010', '0011', '0012', '0013'];
  for (const state of ['0007', '0008', '0009', '0010', '0011', '0012', '0013']) {
    const db = `mv_rehearsal_pre_${state}`;
    const client = await freshAt(db, state);
    try {
      for (const n of numbers) {
        const out = await runVerify(client, `supabase/preflight/preflight_${n}.sql`);
        const shouldPass = Number(state) === Number(n) - 1;
        const passed = out.ok && out.failed.length === 0;
        const pass = out.ok && passed === shouldPass;
        results.push({ state, preflight: n, expected: shouldPass ? 'PASS' : 'FAIL', pass,
                       failed: out.ok ? out.failed.map(r => r.check_name) : [out.error.message] });
        if (!pass) {
          fail('preflight', `preflight_${n} tilassa ${state}: odotus ${shouldPass ? 'PASS' : 'FAIL'}, `
            + (out.ok ? `hylättyjä ${out.failed.length}: ${out.failed.map(r => r.check_name).join('; ')}` : out.error.message));
        }
        checkCounts('preflight', `preflight_${n} tilassa ${state}`, out);
      }
    } finally { await client.end(); await dropDatabase(db); }
  }
  return results;
}

// ---------------------------------------------------------------------
// Pääohjelma
// ---------------------------------------------------------------------

/** Tiivis rivi skenaariosta (konsoli ja REHEARSAL-REPORT.md). */
function summarize(name, value) {
  const passCount = list => `${list.filter(r => r.pass).length}/${list.length}`;
  if (name.startsWith('upgrade')) {
    const ok = value.filter(s => s.migration).map(s => `${numberOf(s.migration)}${s.ok ? '' : '!'}`
      + (s.verify ? `(${s.verify.pass}P/${s.verify.fail?.length ?? '?'}F)` : ''));
    return `${name}: ${ok.join(' ')}`;
  }
  switch (name) {
    case 'rls': return `rls: ${value.tables} taulua, ${value.checks} tarkistusta, ${value.failed} hylättyä`;
    case 'lifecycle': {
      const vals = Object.entries(value).filter(([k]) => k !== 'userBRowsBeforeDelete');
      return `lifecycle: ${vals.filter(([, v]) => v === 'PASS').length}/${vals.length} PASS`;
    }
    case 'rollback': return `rollback: ${passCount(value)} (ajo -> ROLLBACK-osio -> katalogi täsmälleen ennallaan -> ajo uudelleen)`;
    case 'preflight': return `preflight: ${passCount(value)} odotetusti (PASS vain omassa tilassaan)`;
    case 'inventory': return `inventory: ${passCount(value)} PASS`;
    case 'failure': return `failure: ${passCount(value)} kaatui kiinni/odotetusti`;
    case 'prodshape:fixture': return `prodshape:fixture: ${passCount(value.filter(r => !r.informational))} muunnelmaa = omistajan inventaario`;
    case 'values:0010': return `values:0010: ${passCount(value)} muunnelmaa, vanhat arvot/xmin/relfilenode ennallaan`;
    case 'prodshape:chain': return `prodshape:chain: ${passCount(value)} migraatiota, skeemaero = kultainen`;
    case 'prodshape:pause': return `prodshape:pause: ${passCount(value)} taukoa, kirjoituksia ${value.reduce((n, p) => n + (p.liveWrites?.count || 0) + (p.nextWrites?.count || 0), 0)}`;
    case 'verify:null': return `verify:null: ${passCount(value)}`;
    case 'preflight:blockers': return `preflight:blockers: ${passCount(value)}`;
    case 'rollback:data': return `rollback:data: ${passCount(value)}`;
    case 'rollback:reverse-chain': return `rollback:reverse-chain: ${value.pass ? 'PASS' : 'FAIL'} (0013..0009 -> katalogi = tuotannon 0008)`;
    case 'failure:0010-locks': {
      const m = value.matrix || [];
      const parts = [value.late, ...(value.stall || []), ...(value.deadlock || []), value.aborted, value.rerunBlocked].filter(Boolean);
      return `failure:0010-locks: estäjämatriisi ${passCount(m)}, muut ${passCount(parts)}`;
    }
    case 'role:nonsuper': return `role:nonsuper: ${passCount(value.migrations || [])} migraatiota NOSUPERUSER-roolina`;
    case 'backup': {
      const ids = [...new Set(value.map(r => r.id))].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
      return `backup: ${passCount(value)} PASS (${ids.map(id => `${id} ${passCount(value.filter(r => r.id === id))}`).join(' · ')})`;
    }
    default: return `${name}: ajettu`;
  }
}

async function runScenario(name, fn) {
  const t0 = Date.now();
  try {
    report.scenarios[name] = await fn();
  } catch (error) {
    report.failures.push(`KESKEYTYS ${name}: ${error.stack || error.message}`);
  }
  report.durationsMs = { ...(report.durationsMs || {}), [name]: Date.now() - t0 };
}

export async function main(argv = process.argv.slice(2), { guard = guardBackupRehearsal, env = process.env } = {}) {
  args = Object.fromEntries(argv.map(a => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }));
  only = args.only ? new Set(String(args.only).split(',')) : null;
  report.startedAt = new Date().toISOString();
  const ctx = { fail, writeGolden: Boolean(args['write-golden']) };
  const ps = () => import('./prodshape-scenarios.mjs');
  const fs2 = () => import('./failure-scenarios.mjs');
  const rb = () => import('./rollback-scenarios.mjs');
  const bk = () => import('./backup-scenario.mjs');
  // Mallikannat poistetaan vain, jos palvelin todennettiin: epäonnistunut
  // vahti ei saa johtaa yhteenkään uuteen yhteysyritykseen.
  let serverVerified = false;
  try {
    // Varmuuskopioharjoittelu: tiukka vahti ENNEN ensimmäistäkään yhteyttä
    // (portti nimenomaisesti ja ei 54329), sitten versio ja data-hakemisto.
    if (wantExplicit('backup')) report.backupGuard = await guard({ env });
    // Ensimmäinen yhteys todentaa palvelimen (versio + data-hakemisto).
    const probe = await connect();
    report.server = { ...SERVER, versionString: await scalar(probe, 'select version()') };
    await probe.end();
    serverVerified = true;

    if (want('preflight')) await runScenario('preflight', preflightScenario);
    if (want('rollback')) await runScenario('rollback', rollbackScenario);
    if (want('inventory')) {
      const dir = args.fixtures ? String(args.fixtures) : null;
      if (dir) fs.mkdirSync(dir, { recursive: true });
      await runScenario('inventory', () => inventoryScenario(dir));
    }
    for (const variant of ['text', 'typed']) {
      if (want(`upgrade:${variant}`) || (variant === 'text' && (want('rls') || want('lifecycle')))) {
        await runScenario(`upgrade:${variant}`, () => upgradeScenario(variant));
      }
    }
    if (want('failure')) await runScenario('failure', failureScenario);
    if (want('prodshape:fixture')) await runScenario('prodshape:fixture', async () => (await ps()).fixtureScenario(ctx));
    if (want('values:0010')) await runScenario('values:0010', async () => (await ps()).valuesScenario(ctx));
    if (want('prodshape:chain')) await runScenario('prodshape:chain', async () => (await ps()).chainScenario(ctx));
    if (want('prodshape:pause')) await runScenario('prodshape:pause', async () => (await ps()).pauseScenario(ctx));
    if (want('verify:null')) await runScenario('verify:null', async () => (await fs2()).verifyNullScenario(ctx));
    if (want('preflight:blockers')) await runScenario('preflight:blockers', async () => (await fs2()).preflightBlockerScenario(ctx));
    if (want('rollback:data')) await runScenario('rollback:data', async () => (await rb()).rollbackDataScenario(ctx));
    if (want('rollback:reverse-chain')) await runScenario('rollback:reverse-chain', async () => (await rb()).reverseChainScenario(ctx));
    if (want('failure:0010-locks')) await runScenario('failure:0010-locks', async () => (await fs2()).locksScenario(ctx));
    if (want('role:nonsuper')) await runScenario('role:nonsuper', async () => (await fs2()).roleNonsuperScenario(ctx));
    if (wantExplicit('backup')) {
      await runScenario('backup', async () => {
        const dir = args['backup-fixtures'] ? String(args['backup-fixtures']) : null;
        if (dir) fs.mkdirSync(dir, { recursive: true });
        const results = await (await bk()).backupScenario({ fixtureDir: dir });
        for (const r of results.filter(x => !x.pass)) fail('backup', `[${r.variant} ${r.migration}] ${r.id} ${r.label}: ${r.detail}`);
        return results;
      });
    }
  } catch (error) {
    report.failures.push(`KESKEYTYS: ${error.stack || error.message}`);
  } finally {
    if (serverVerified) {
      try { await dropTemplates(); } catch (error) { report.failures.push(`mallikantojen poisto: ${error.message}`); }
    }
  }
  report.finishedAt = new Date().toISOString();
  report.git = provenance();

  const summary = [];
  summary.push(`PostgreSQL: ${report.server?.versionString || '?'} (data ${report.server?.dataDirectory || '?'}, portti ${report.server?.port || '?'})`);
  summary.push(`git: ${report.git.head} (${report.git.branch}); luettuja tiedostoja ${Object.keys(report.git.blobs).length}`
    + (report.git.uncommittedReadFiles.length ? `, COMMITOIMATTOMIA ${report.git.uncommittedReadFiles.length}` : ''));
  for (const [name, value] of Object.entries(report.scenarios)) summary.push(summarize(name, value));
  summary.push(`HYLÄTYT: ${report.failures.length}`);
  for (const f of report.failures) summary.push(`  - ${f}`);
  console.log(summary.join('\n'));
  if (args.json) writeFileSync(args.json, JSON.stringify(report, (k, v) => (v instanceof Map ? Object.fromEntries(v) : v), 2));
  process.exitCode = report.failures.length ? 1 : 0;
  return report;
}

if (isMain(import.meta.url)) await main();
