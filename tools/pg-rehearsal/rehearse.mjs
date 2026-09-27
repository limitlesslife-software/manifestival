// Migraatioharjoittelu oikeaa PostgreSQL:ää vasten — EI TUOTANTOA.
//
// Käyttö:
//   node tools/pg-rehearsal/rehearse.mjs [--json=raportti.json] [--only=upgrade,rls,failure]
//                                        [--write-golden] [--fixtures=DIR] [--fixture-states=0014,...]
//
// Vaatii paikallisen PostgreSQL 17 -klusterin osoitteessa 127.0.0.1
// (portti PG_REHEARSAL_PORT, oletus 54349), jonka data-hakemisto on
// projektin .claude/pg-local-hakemistossa (lib.assertRehearsalServer),
// ja pg-ajurin, ks. README.md.
//
// Skenaariot (--only hyväksyy nimen tai etuliitteen, esim. prodshape):
//   upgrade:text   lähtötila (date/time tekstinä) -> 0001..0014, siemennys joka välissä;
//                  vanhat rivit (vanhat sarakkeet, xmin, relfilenode) ennallaan 0003:sta alkaen
//   upgrade:typed  sama, date/time omina tyyppeinään
//   rls            eristysmatriisi kaikille tauluille lopputilassa
//   lifecycle      poistosäännöt: alue/tavoite/tehtävä/käyttäjä
//   failure        uudelleenajo, puuttuva esiehto, osittainen tila, lukon aikakatkaisu
//   rollback       jokaisen ROLLBACK-osion ajo tyhjillä uusilla objekteilla
//   preflight      jokainen preflight jokaisessa tilassa 0007..0014
//   inventory      aktivoinnin inventaario + pisteytys jokaisessa tilassa
//   prodshape:fixture      tuotannon 0008-tila = omistajan inventaario (prodshape.mjs)
//   values:0010            0010 säilyttää jokaisen vanhan arvon (5 tilaa × projekti)
//   prodshape:chain        0009..0014 tuotannon datalla + kultaiset skeemaerot
//   prodshape:pause        taukopisteet: aaltojen oikeat kirjoitukset, verify, preflight
//   failure:0010-locks     estäjämatriisi, myöhäinen virhe, jumi, lukkiutuminen (+0009, 0011, 0014)
//   verify:null            poikkeavia_yhteensa = FAIL-rivit myös NULL-tuloksilla
//   preflight:blockers     lukitut taulut ja politiikkamäärät havaitaan etukäteen
//   rollback:data          peruutukset datan kanssa (0010, 0012, 0013, 0014)
//   rollback:reverse-chain 0014..0009 käänteisessä järjestyksessä -> tuotannon 0008
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
    // 0014: käyttäjäkohtaiset uniikkiavaimet (B:llä on jo sama päivä,
    // nimi ja asetusrivi) vaihdetaan, jotta kokeiltavaksi jää vain RLS.
    if (t === 'saved_places') copy.name = 'Väärennetty paikka';
    if (t === 'place_aliases') copy.alias = 'väärennetty';
    if (t === 'sleep_logs') copy.wake_date = '2026-06-05';
    if (t === 'wellbeing_checkins') copy.date = '2026-06-06';
    // Viittaukset A:n riveihin nollataan, jotta vierasavain ei kaada ensin.
    // NOT NULL -viitteet (rutiini, tavoite, 0014:n paikka ja suunnitelma)
    // jätetään: nollaus kaatuisi NOT NULLiin eikä RLS:ään.
    const keepFk = new Set(['routine_exceptions.routine_id', 'milestones.goal_id', 'place_aliases.place_id',
      'commute_observations.place_id', 'habit_events.plan_id']);
    const fks = (await client.query(
      `select a.attname from pg_constraint c
         join lateral unnest(c.conkey) k(n) on true
         join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.n
        where c.conrelid = $1::regclass and c.contype = 'f' and a.attname not in ('user_id', 'id')`,
      [`public.${t}`])).rows.map(x => x.attname);
    for (const f of fks) if (f in copy && !keepFk.has(`${t}.${f}`)) copy[f] = null;
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
    // jsonb-arvot JSON-tekstinä: pg-ajuri muuttaisi JS-taulukon PostgreSQL-
    // taulukoksi, ja ei-tyhjä jsonb-taulukko (0014: aamurutiini, portaat)
    // kaatuisi tyyppimuunnokseen ennen RLS:ää.
    const jsonCols = new Set((await client.query(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = $1 and data_type in ('json', 'jsonb')`, [t])).rows
      .map(x => x.column_name));
    const values = cols.map(c => (jsonCols.has(c) && copy[c] !== null ? JSON.stringify(copy[c]) : copy[c]));
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

  // 0014 (aalto K): poistosäännöt ja rajat oikealla kannalla.
  await lifecycle0014(client, check);

  // Taaksepäin yhteensopivuus: migraatio ajetaan aina SILLOIN kun
  // edellisen aallon koodi on tuotannossa (0010 ajetaan aallon F aikana
  // jne.). Vanhan koodin rivimuoto — ilman yhtäkään myöhemmän
  // migraation saraketta — on siis voitava kirjoittaa ja päivittää
  // koko ketjun (0014) jälkeenkin. Muodot vastaavat src/lib/rows.js:n ja
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
    check(`legacy_shape_after_0014: ${label}`, r.ok && r.rowCount === 1, JSON.stringify(r));
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

/**
 * 0014:n poistosäännöt ja rajat. Ajetaan lifecycleScenarion sisällä sen
 * jälkeen, kun A:n tavoite 'a-goal' on poistettu: meno ja liikuntakerta
 * viittasivat siihen.
 */
async function lifecycle0014(client, check) {
  const row = async sql => (await client.query(sql)).rows[0];
  // Tavoitteen poisto nollasi VAIN viitesarakkeen (on delete set null
  // (goal_id)). Ilman sarakelistaa PostgreSQL nollaisi myös NOT NULL
  // -sarakkeen user_id, ja jokainen tavoitteen poisto kaatuisi.
  const ev = await row(`select user_id::text as owner, goal_id, place_id from public.calendar_events where id = 'a-event'`);
  check('0014_goal_delete_detaches_event_keeps_owner',
    ev && ev.owner === OWNER && ev.goal_id === null && ev.place_id === 'a-place', JSON.stringify(ev));
  const ex = await row(`select user_id::text as owner, goal_id, kind from public.exercise_sessions where id = 'a-ex'`);
  check('0014_goal_delete_detaches_exercise_keeps_owner',
    ex && ex.owner === OWNER && ex.goal_id === null && ex.kind === 'juoksu', JSON.stringify(ex));
  const bEv = await row(`select goal_id, place_id from public.calendar_events where id = 'b-event'`);
  check('0014_goal_delete_leaves_other_user_links', bEv && bEv.goal_id === 'b-goal' && bEv.place_id === 'b-place',
    JSON.stringify(bEv));

  // Paikan poisto: lisänimet ja havainnot (kaskadi) lähtevät, meno jää
  // omistajalleen ilman paikkaa.
  await asUser(client, OWNER, () => client.query(`delete from public.saved_places where id = 'a-place'`));
  const after = await row(`select
      (select count(*) from public.place_aliases where id = 'a-alias')::int as aliases,
      (select count(*) from public.commute_observations where id = 'a-commute')::int as commutes,
      (select count(*) from public.place_aliases where id = 'b-alias')::int as b_aliases,
      (select count(*) from public.commute_observations where id = 'b-commute')::int as b_commutes,
      (select place_id from public.calendar_events where id = 'a-event') as event_place,
      (select user_id::text from public.calendar_events where id = 'a-event') as event_owner`);
  check('0014_place_delete_cascades_aliases_and_observations',
    after.aliases === 0 && after.commutes === 0 && after.b_aliases === 1 && after.b_commutes === 1, JSON.stringify(after));
  check('0014_place_delete_detaches_event_keeps_owner', after.event_place === null && after.event_owner === OWNER,
    JSON.stringify(after));

  // Suunnitelman poisto vie sen kirjaukset.
  await asUser(client, OWNER, () => client.query(`delete from public.habit_plans where id = 'a-habit'`));
  const hev = Number(await scalar(client, `select count(*) from public.habit_events where id = 'a-hevent'`));
  const bHev = Number(await scalar(client, `select count(*) from public.habit_events where id = 'b-hevent'`));
  check('0014_plan_delete_cascades_events', hev === 0 && bHev === 1, `a=${hev} b=${bHev}`);

  // Ainutkertaisuudet: yksi asetusrivi käyttäjää kohti, yksi unikirjaus
  // heräämispäivää ja yksi tuntemus päivää kohti, paikan nimi
  // kirjainkoosta riippumatta — kaikki käyttäjäkohtaisia.
  const code = r => (r.ok ? 'ok' : r.code);
  const settings2 = await tryAs(client, OWNER, `insert into public.life_settings (id) values ('a-life-2')`);
  check('0014_one_life_settings_row_per_user', code(settings2) === '23505', JSON.stringify(settings2));
  const sleep2 = await tryAs(client, OWNER, `insert into public.sleep_logs (id, wake_date) values ('a-sleep-2', '2026-09-24')`);
  check('0014_one_sleep_log_per_wake_date', code(sleep2) === '23505', JSON.stringify(sleep2));
  const wbc2 = await tryAs(client, OWNER, `insert into public.wellbeing_checkins (id, date, motivation) values ('a-wbc-2', '2026-09-24', 2)`);
  check('0014_one_checkin_per_date', code(wbc2) === '23505', JSON.stringify(wbc2));
  const place1 = await tryAs(client, OWNER, `insert into public.saved_places (id, name) values ('a-place-2', 'Kuntosali')`);
  check('0014_place_name_unique_is_per_user', place1.ok, JSON.stringify(place1));
  const place2 = await tryAs(client, OWNER, `insert into public.saved_places (id, name) values ('a-place-3', 'KUNTOSALI')`);
  check('0014_place_name_unique_ignores_case', code(place2) === '23505', JSON.stringify(place2));

  // Rajat (23514).
  await asUser(client, OWNER, () => client.query(`insert into public.habit_plans (id, name) values ('a-habit-2', 'Kahvi')`));
  const limits = [
    ['all_day_with_start_time', `insert into public.calendar_events (id, title, event_date, start_time, all_day) values ('a-ev-x1', 'x', '2026-09-25', '10:00', true)`],
    ['timed_event_without_start', `insert into public.calendar_events (id, title, event_date, all_day) values ('a-ev-x2', 'x', '2026-09-25', false)`],
    ['end_time_without_start', `insert into public.calendar_events (id, title, event_date, end_time, all_day) values ('a-ev-x3', 'x', '2026-09-25', '11:00', true)`],
    ['weekday_8', `insert into public.calendar_events (id, title, event_date, all_day, recurrence_weekdays) values ('a-ev-x4', 'x', '2026-09-25', true, '{1,8}')`],
    ['weekday_null_element', `insert into public.calendar_events (id, title, event_date, all_day, recurrence_weekdays) values ('a-ev-x5', 'x', '2026-09-25', true, '{1,NULL}')`],
    ['skip_date_null_element', `insert into public.calendar_events (id, title, event_date, all_day, skip_dates) values ('a-ev-x6', 'x', '2026-09-25', true, '{2026-10-01,NULL}')`],
    ['until_before_first', `insert into public.calendar_events (id, title, event_date, all_day, recurrence_weekdays, recurrence_until) values ('a-ev-x7', 'x', '2026-09-25', true, '{5}', '2026-09-24')`],
    ['travel_minutes_zero', `insert into public.saved_places (id, name, usual_travel_minutes) values ('a-place-x', 'Nolla', 0)`],
    ['motivation_6', `insert into public.wellbeing_checkins (id, date, motivation) values ('a-wbc-x', '2026-09-25', 6)`],
    ['control_0', `insert into public.wellbeing_checkins (id, date, control) values ('a-wbc-y', '2026-09-26', 0)`],
    ['habit_action_unknown', `insert into public.habit_events (id, plan_id, occurred_at, action) values ('a-hev-x', 'a-habit-2', now(), 'relapse')`],
    ['alarm_not_object', `update public.life_settings set alarm = '[]' where id = 'a-life'`],
    ['alarm_over_8192_bytes', `update public.life_settings set alarm = jsonb_build_object('x', repeat('x', 9000)) where id = 'a-life'`],
    ['morning_routine_not_array', `update public.life_settings set morning_routine = '{}' where id = 'a-life'`],
    ['currency_lowercase', `update public.life_settings set currency = 'eur' where id = 'a-life'`],
    ['sleep_kind_unknown', `update public.sleep_logs set kind = 'deep' where id = 'a-sleep'`]
  ];
  for (const [label, sql] of limits) {
    const r = await tryAs(client, OWNER, sql);
    check(`0014_rejects_${label}`, code(r) === '23514', JSON.stringify(r));
  }

  // Havainnon event_id EI ole vierasavain: olemattomaan menoon viittaava
  // havainto kelpaa, ja menon poisto ei vie toteutunutta matkaa.
  const obs = await tryAs(client, OWNER,
    `insert into public.commute_observations (id, place_id, event_id, observed_on, weekday, travel_minutes)
     values ('a-commute-2', 'a-place-2', 'event:ei-ole:2026-09-25', '2026-09-25', 5, 20)`);
  check('0014_observation_event_id_is_not_a_foreign_key', obs.ok, JSON.stringify(obs));
  await asUser(client, OWNER, () => client.query(`delete from public.calendar_events where id = 'a-event'`));
  const obsLeft = Number(await scalar(client, `select count(*) from public.commute_observations where id = 'a-commute-2'`));
  check('0014_event_delete_keeps_observation', obsLeft === 1, obsLeft);
  // Tuntematon on tyhjä, ei nolla: kirjaus ilman matka-aikaa kelpaa.
  const unknown = await tryAs(client, OWNER,
    `insert into public.commute_observations (id, place_id, observed_on, weekday) values ('a-commute-3', 'a-place-2', '2026-09-26', 6)`);
  check('0014_observation_unknown_travel_is_null', unknown.ok
    && (await scalar(client, `select travel_minutes from public.commute_observations where id = 'a-commute-3'`)) === null,
    JSON.stringify(unknown));
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
    // Koko ketju (nyt 0014 asti): jokainen 0009+ uudelleen sanoo "JO AJETTU".
    const client = await freshAt(db, numberOf(MIGRATIONS.at(-1)));
    try {
      for (const name of MIGRATIONS.filter(m => numberOf(m) >= '0009')) {
        results.push(await expectClosedFailure(client, `toinen ajo koko ketjun jälkeen ${numberOf(name)}`, name, /JO AJETTU/));
      }
    } finally { await client.end(); await dropDatabase(db); }
  }

  // B. Puuttuva esiehto: 0013 ennen 0012:ta, 0014 ennen 0013:a ja 0012:ta,
  //    0012/0011/0010/0009 ennen 0007:ää.
  {
    const db = 'mv_rehearsal_fail_prereq';
    const client = await freshAt(db, '0011');
    try {
      results.push(await expectClosedFailure(client, '0013 ilman 0012:ta', '0013_alignment_reality', null));
      results.push(await expectClosedFailure(client, '0014 ilman 0012:ta ja 0013:a', '0014_daily_life', /Migraatio 0013 pitaa ajaa ensin/));
    } finally { await client.end(); await dropDatabase(db); }
    const db12 = 'mv_rehearsal_fail_prereq12';
    const c12 = await freshAt(db12, '0012');
    try {
      // Juna etenee järjestyksessä: 0014 ei ohita 0013:a, vaikka sen
      // omat taulut eivät viittaa 0013:n objekteihin.
      results.push(await expectClosedFailure(c12, '0014 ilman 0013:a', '0014_daily_life', /Migraatio 0013 pitaa ajaa ensin/));
    } finally { await c12.end(); await dropDatabase(db12); }
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
      ['0008', '0009_finance_2', 'alter table public.bills add column iban text'],
      // 0014: taulu, indeksin nimi toisessa taulussa ja rajoitteen nimi
      // toisessa taulussa — tunnistus laskee nimet, ei vain tauluja.
      ['0013', '0014_daily_life', 'create table public.saved_places (id text primary key)'],
      ['0013', '0014_daily_life', 'create index calendar_events_user_date_idx on public.tasks (user_id)'],
      ['0013', '0014_daily_life', 'alter table public.tasks add constraint life_settings_one_per_user unique (id)']
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
  //    0014 ei muuta olemassa olevaa taulua: vierasavaimet ottavat goals-
  //    ja auth.users-tauluihin SHARE ROW EXCLUSIVE -lukon, jonka estää
  //    sovelluksen KIRJOITUS (ROW EXCLUSIVE) mutta ei lukukysely (G alla).
  const LOCK_CASES = [
    ['0009', '0010_goal_to_action', 'public.goals', 'access share'],
    ['0011', '0012_life_alignment', 'public.goals', 'access share'],
    ['0012', '0013_alignment_reality', 'public.time_entries', 'access share'],
    ['0013', '0014_daily_life', 'public.goals', 'row exclusive'],
    ['0013', '0014_daily_life', 'auth.users', 'row exclusive']
  ];
  for (const [at, name, table, mode] of LOCK_CASES) {
    const db = `mv_rehearsal_fail_lock_${numberOf(name)}_${table.replace(/\W/g, '_')}`;
    const client = await freshAt(db, at);
    const blocker = await connect(db);
    try {
      await blocker.query('begin');
      await blocker.query(`lock table ${table} in ${mode} mode`);
      const t0 = Date.now();
      const r = await expectClosedFailure(client, `${numberOf(name)} kun ${table} on avoimen transaktion lukitsema (${mode.toUpperCase()})`, name, /lock|lukko/i);
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

  // G. 0014: lukukysely goals-taulussa EI estä (ACCESS SHARE ei ole
  //    ristiriidassa SHARE ROW EXCLUSIVEn kanssa) — sovellus voi lukea
  //    koko ajon ajan.
  {
    const db = 'mv_rehearsal_fail_read_0014';
    const client = await freshAt(db, '0013');
    const blocker = await connect(db);
    try {
      await blocker.query('begin');
      await blocker.query('select count(*) from public.goals');
      const t0 = Date.now();
      const out = await runSql(client, readSql('supabase/migrations/0014_daily_life.sql'));
      const waitedMs = Date.now() - t0;
      const pass = out.ok && waitedMs < 4500;
      results.push({ label: '0014 kun goals on avoimen lukukyselyn lukitsema (ACCESS SHARE): ei estä', pass, waitedMs,
                     error: out.error?.message });
      if (!pass) fail('failure', `0014 lukukyselyn aikana: ${out.ok ? `odotti ${waitedMs} ms` : out.error.message}`);
    } finally { await blocker.query('rollback').catch(() => {}); await blocker.end(); await client.end(); await dropDatabase(db); }
  }

  // H. 0014: myöhäinen virhe VAIHEESSA 11 (invarianttien todistus ennen
  //    committia) — kaikki kymmenen taulua on jo luotu, kun ylimääräinen
  //    politiikka vanhassa taulussa kaataa ajon. Kaikki perutaan.
  {
    const db = 'mv_rehearsal_fail_late_0014';
    const client = await freshAt(db, '0013');
    try {
      await client.query('create policy mv_rehearsal_extra on public.running_timers for select to authenticated using (false)');
      results.push(await expectClosedFailure(client, '0014 kun vanhan taulun politiikkamäärä on muuttunut (vaihe 11)', '0014_daily_life',
        /politiikat muuttuivat: 41/));
    } finally { await client.end(); await dropDatabase(db); }
  }

  return results;
}

// ---------------------------------------------------------------------
// Aktivoinnin inventaario ja pisteytys jokaisessa junan tilassa
// ---------------------------------------------------------------------

// runInventory (prodshape.mjs): vain luku todennetaan kannalla, ei
// lupauksena — READ ONLY -transaktio kaataa minkä tahansa kirjoituksen.

/**
 * `fixtureStates` rajaa, minkä tilojen tulokset kirjoitetaan
 * `--fixtures`-hakemistoon (`--fixture-states=0014,0013-partial-0014`).
 * Oletus (null) = kaikki, kuten ennen. Vanhojen tilojen fixtureja ei
 * kirjoiteta uudelleen turhaan: orkestroijan ikätestit käyttävät niiden
 * aikaleimoja.
 */
async function inventoryScenario(fixtureDir, fixtureStates = null) {
  const writeFixture = (key, file, text) => {
    if (fixtureDir && (!fixtureStates || fixtureStates.has(key))) fs.writeFileSync(path.join(fixtureDir, file), text);
  };
  const { parseInventory, scoreInventory } = await import('../activation/score-inventory.mjs');
  const results = [];
  const check = (label, pass, detail) => {
    results.push({ label, pass, detail });
    if (!pass) fail('inventory', `${label}: ${detail}`);
  };
  const cases = [
    ['0008', 'GO', '0009'], ['0009', 'GO', '0010'], ['0010', 'GO', '0011'],
    ['0011', 'GO', '0012'], ['0012', 'GO', '0013'], ['0013', 'GO', '0014'], ['0014', 'GO', null]
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
        if (variant === 'text') writeFixture(state, `state-${state}.json`, inv.cell + '\n');
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
      writeFixture('0011-partial-0012', 'state-0011-partial-0012.json', inv.cell + '\n');
    } finally { await client.end(); await dropDatabase(db); }
  }
  // Keskeneräinen 0014 (yksi taulu käsin) -> STOP: rivi 23 = partial.
  {
    const db = 'mv_rehearsal_inv_partial14';
    const client = await freshAt(db, '0013');
    try {
      await client.query('create table public.saved_places (id text primary key)');
      const inv = await runInventory(client);
      const scored = scoreInventory(parseInventory(inv.cell));
      check('keskeneräinen 0014: STOP', scored.decision === 'STOP' && scored.facts.migrations['0014'] === 'partial',
        JSON.stringify({ decision: scored.decision, m: scored.facts.migrations, stops: scored.stops }));
      writeFixture('0013-partial-0014', 'state-0013-partial-0014.json', inv.cell + '\n');
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
      writeFixture('0008-no-owner', 'state-0008-no-owner.json', inv.cell + '\n');
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
  const numbers = ['0009', '0010', '0011', '0012', '0013', '0014'];
  for (const state of ['0007', '0008', '0009', '0010', '0011', '0012', '0013', '0014']) {
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
    case 'rollback:reverse-chain': return `rollback:reverse-chain: ${value.pass ? 'PASS' : 'FAIL'} (0014..0009 -> katalogi = tuotannon 0008)`;
    case 'failure:0010-locks': {
      const m = value.matrix || [];
      const parts = [value.late, ...(value.stall || []), ...(value.deadlock || []), value.aborted, value.rerunBlocked,
        value.rerunBlocked0014, value.authStall0014].filter(Boolean);
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
      const states = args['fixture-states'] ? new Set(String(args['fixture-states']).split(',')) : null;
      await runScenario('inventory', () => inventoryScenario(dir, states));
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
