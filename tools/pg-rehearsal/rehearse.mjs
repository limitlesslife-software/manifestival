// Migraatioharjoittelu oikeaa PostgreSQL:ää vasten — EI TUOTANTOA.
//
// Käyttö:
//   node tools/pg-rehearsal/rehearse.mjs [--json=raportti.json] [--only=upgrade,rls,failure]
//
// Vaatii paikallisen PostgreSQL 15+ -palvelimen osoitteessa 127.0.0.1
// (portti PG_REHEARSAL_PORT, oletus 54329) ja pg-ajurin, ks. README.md.
//
// Skenaariot:
//   upgrade:text   lähtötila (date/time tekstinä) -> 0001..0013, siemennys joka välissä
//   upgrade:typed  sama, date/time omina tyyppeinään
//   rls            eristysmatriisi kaikille tauluille lopputilassa
//   lifecycle      poistosäännöt: alue/tavoite/tehtävä/käyttäjä
//   failure        uudelleenajo, puuttuva esiehto, osittainen tila, lukon aikakatkaisu
//
// Jokainen kanta on kertakäyttöinen (mv_rehearsal_*) ja poistetaan lopuksi.

import fs, { writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  connect, createDatabase, dropDatabase, runSql, runVerify, readSql, asUser, tryAs,
  catalogFingerprint, scalar, OWNER, USER_B
} from './lib.mjs';
import { MIGRATIONS, numberOf, prepareBaseline, applyMigration } from './chain.mjs';
import { SEEDS, ID_OWNED } from './seeds.mjs';

const USER_C = 'cccccccc-0000-4000-8000-00000000000c';
const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? true];
}));
const only = args.only ? new Set(String(args.only).split(',')) : null;
const want = name => !only || only.has(name) || only.has(name.split(':')[0]);

const report = {
  startedAt: new Date().toISOString(),
  server: null,
  scenarios: {},
  failures: []
};

function fail(scenario, message) {
  report.failures.push(`${scenario}: ${message}`);
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

/** Olemassa olevan datan sormenjälki: rivimäärät ja sisällön tiiviste per taulu. */
async function dataFingerprint(client, tables) {
  const out = {};
  for (const t of tables) {
    const exists = await scalar(client, `select to_regclass($1) is not null`, [`public.${t}`]);
    if (!exists) continue;
    out[t] = await scalar(client,
      `select count(*)::text || ':' || coalesce(md5(string_agg(x::text, '|' order by x::text)), '-')
         from (select * from public.${t}) x`);
  }
  return out;
}

async function upgradeScenario(variant) {
  const scenario = `upgrade:${variant}`;
  const db = `mv_rehearsal_upgrade_${variant}`;
  await createDatabase(db);
  const client = await connect(db);
  const steps = [];
  try {
    report.server = report.server || await scalar(client, 'select version()');
    await prepareBaseline(client, variant);
    const baselineTasks = await dataFingerprint(client, ['tasks']);
    for (const name of MIGRATIONS) {
      const n = numberOf(name);
      // Vanha data ennen migraatiota. Uusi migraatio EI saa muuttaa sitä —
      // paitsi 0001, joka tarkoituksella lisää omistajan (ja 0002 ajan).
      const legacyTables = SEEDS.filter(s => s.since < n).map(s => s.table);
      const before = await dataFingerprint(client, [...new Set(legacyTables)]);
      const record = await applyMigration(client, name);
      steps.push(record);
      if (!record.ok) { fail(scenario, `${name} kaatui: ${record.error.message}`); break; }
      if (record.verify?.fail?.length) {
        for (const f of record.verify.fail) fail(scenario, `verify_${n}: ${f}`);
      }
      if (record.verify?.error) fail(scenario, `verify_${n} kaatui: ${record.verify.error}`);
      // 0009+ esitarkistukset (tools/activation/build-preflights.mjs) on
      // ajettava puhtaasti juuri ennen omaa migraatiotaan. (0003:n
      // "yksi auth-käyttäjä" on tuotantokohtainen eikä koske tätä.)
      if (n >= '0009') {
        if (!record.preflight) fail(scenario, `preflight_${n}.sql puuttuu`);
        else if (record.preflight.error) fail(scenario, `preflight_${n} kaatui: ${record.preflight.error}`);
        else for (const f of record.preflight.fail) fail(scenario, `preflight_${n}: ${f}`);
      }
      if (n >= '0003') {
        const after = await dataFingerprint(client, Object.keys(before));
        const changed = Object.keys(before).filter(t => before[t].split(':')[0] !== after[t].split(':')[0]);
        record.legacyRowCountsChanged = changed;
        if (changed.length) fail(scenario, `${name} muutti vanhojen taulujen rivimääriä: ${changed.join(', ')}`);
        // Sisältö: sarakkeiden lisäys muuttaa rivin tekstiesitystä, joten
        // sisällön säilyminen todennetaan sarakekohtaisesti alla (tasks).
      }
      await seedFor(client, n, scenario);
    }
    // Alkuperäiset 36 tehtävää: jokainen alkuperäinen sarake ennallaan.
    const orig = await client.query(
      `select count(*) filter (where user_id = $1) as owned, count(*) as total,
              count(*) filter (where id like 'seed%' or id like 'm%') as legacy
         from public.tasks`, [OWNER]);
    const legacy = orig.rows[0];
    steps.push({ legacyTasks: legacy, baseline: baselineTasks.tasks });
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
  const before = await catalogFingerprint(client);
  const out = await runSql(client, readSql(`supabase/migrations/${name}.sql`));
  const after = await catalogFingerprint(client);
  const msgOk = !expect || (out.error && expect.test(out.error.message));
  const pass = !out.ok && before.hash === after.hash && msgOk;
  if (!pass) {
    fail('failure', `${label}: ${out.ok ? 'MIGRAATIO MENI LÄPI' : 'virhe ' + out.error.message}`
      + `${before.hash !== after.hash ? ' — KATALOGI MUUTTUI' : ''}`);
  }
  return { label, migration: name, pass, error: out.error?.message, code: out.error?.code,
           catalogUnchanged: before.hash === after.hash };
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

async function runInventory(client) {
  // Vain luku todennetaan kannalla, ei lupauksena: READ ONLY -transaktio
  // kaataa minkä tahansa kirjoituksen.
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
  return { cell, table: result.rows, unchanged: before.hash === after.hash };
}

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
      const before = await catalogFingerprint(client);
      const applied = await runSql(client, sql);
      const rolled = rollback ? await runSql(client, rollback) : { ok: false, error: { message: 'ROLLBACK-lohkoa ei löytynyt' } };
      const after = await catalogFingerprint(client);
      // Ja migraatio on ajettavissa uudelleen peruutuksen jälkeen.
      const again = await runSql(client, sql);
      const pass = applied.ok && rolled.ok && before.hash === after.hash && again.ok;
      results.push({ migration: n, pass, applied: applied.ok, rolledBack: rolled.ok,
                     schemaRestored: before.hash === after.hash, reapplied: again.ok,
                     error: applied.error?.message || rolled.error?.message || again.error?.message });
      if (!pass) {
        fail('rollback', `${n}: ${!applied.ok ? 'migraatio kaatui' : !rolled.ok ? 'peruutus kaatui: ' + rolled.error.message
          : before.hash !== after.hash ? 'skeema ei palautunut' : 'uudelleenajo kaatui: ' + again.error?.message}`);
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
      }
    } finally { await client.end(); await dropDatabase(db); }
  }
  return results;
}

// ---------------------------------------------------------------------

try {
  if (want('preflight')) report.scenarios.preflight = await preflightScenario();
  if (want('rollback')) report.scenarios.rollback = await rollbackScenario();
  if (want('inventory')) {
    const dir = args.fixtures ? String(args.fixtures) : null;
    if (dir) fs.mkdirSync(dir, { recursive: true });
    report.scenarios.inventory = await inventoryScenario(dir);
  }
  for (const variant of ['text', 'typed']) {
    if (want(`upgrade:${variant}`) || (variant === 'text' && (want('rls') || want('lifecycle')))) {
      report.scenarios[`upgrade:${variant}`] = await upgradeScenario(variant);
    }
  }
  if (want('failure')) report.scenarios.failure = await failureScenario();
} catch (error) {
  report.failures.push(`KESKEYTYS: ${error.stack || error.message}`);
}
report.finishedAt = new Date().toISOString();

const summary = [];
summary.push(`PostgreSQL: ${report.server}`);
for (const [name, value] of Object.entries(report.scenarios)) {
  if (name.startsWith('upgrade')) {
    const ok = value.filter(s => s.migration).map(s => `${numberOf(s.migration)}${s.ok ? '' : '!'}`
      + (s.verify ? `(${s.verify.pass}P/${s.verify.fail?.length ?? '?'}F)` : ''));
    summary.push(`${name}: ${ok.join(' ')}`);
  } else if (name === 'rls') {
    summary.push(`rls: ${value.tables} taulua, ${value.checks} tarkistusta, ${value.failed} hylättyä`);
  } else if (name === 'lifecycle') {
    const vals = Object.entries(value).filter(([k]) => k !== 'userBRowsBeforeDelete');
    summary.push(`lifecycle: ${vals.filter(([, v]) => v === 'PASS').length}/${vals.length} PASS`);
  } else if (name === 'rollback') {
    summary.push(`rollback: ${value.filter(r => r.pass).length}/${value.length} (ajo -> ROLLBACK-osio -> skeema täsmälleen ennallaan -> ajo uudelleen)`);
  } else if (name === 'preflight') {
    summary.push(`preflight: ${value.filter(r => r.pass).length}/${value.length} odotetusti (PASS vain omassa tilassaan)`);
  } else if (name === 'inventory') {
    summary.push(`inventory: ${value.filter(r => r.pass).length}/${value.length} PASS`);
  } else if (name === 'failure') {
    summary.push(`failure: ${value.filter(r => r.pass).length}/${value.length} kaatui kiinni/odotetusti`);
  }
}
summary.push(`HYLÄTYT: ${report.failures.length}`);
for (const f of report.failures) summary.push(`  - ${f}`);
console.log(summary.join('\n'));
if (args.json) writeFileSync(args.json, JSON.stringify(report, null, 2));
process.exitCode = report.failures.length ? 1 : 0;
