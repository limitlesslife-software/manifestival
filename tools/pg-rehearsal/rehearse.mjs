// Migraatioharjoittelu oikeaa PostgreSQL:ää vasten — EI TUOTANTOA.
//
// Käyttö:
//   node tools/pg-rehearsal/rehearse.mjs [--json=raportti.json] [--only=upgrade,rls,failure]
//                                        [--write-golden] [--fixtures=DIR] [--fixture-states=0015,...]
//
// Vaatii paikallisen PostgreSQL 17 -klusterin osoitteessa 127.0.0.1
// (portti PG_REHEARSAL_PORT, oletus 54349), jonka data-hakemisto on
// projektin .claude/pg-local-hakemistossa (lib.assertRehearsalServer),
// ja pg-ajurin, ks. README.md.
//
// Skenaariot (--only hyväksyy nimen tai etuliitteen, esim. prodshape):
//   upgrade:text   lähtötila (date/time tekstinä) -> 0001..0015, siemennys joka välissä;
//                  vanhat rivit (vanhat sarakkeet, xmin, relfilenode) ennallaan 0003:sta alkaen
//   upgrade:typed  sama, date/time omina tyyppeinään
//   rls            eristysmatriisi kaikille tauluille lopputilassa
//   lifecycle      poistosäännöt: alue/tavoite/tehtävä/käyttäjä
//   failure        uudelleenajo, puuttuva esiehto, osittainen tila, lukon aikakatkaisu
//   rollback       jokaisen ROLLBACK-osion ajo tyhjillä uusilla objekteilla
//   preflight      jokainen preflight jokaisessa tilassa 0007..0015
//   inventory      aktivoinnin inventaario + pisteytys jokaisessa tilassa
//   prodshape:fixture      tuotannon 0008-tila = omistajan inventaario (prodshape.mjs)
//   values:0010            0010 säilyttää jokaisen vanhan arvon (5 tilaa × projekti)
//   prodshape:chain        0009..0015 tuotannon datalla + kultaiset skeemaerot
//   prodshape:pause        taukopisteet: aaltojen oikeat kirjoitukset, verify, preflight
//   failure:0010-locks     estäjämatriisi, myöhäinen virhe, jumi, lukkiutuminen (+0009, 0011, 0014, 0015)
//   verify:null            poikkeavia_yhteensa = FAIL-rivit myös NULL-tuloksilla
//   preflight:blockers     lukitut taulut ja politiikkamäärät havaitaan etukäteen
//   rollback:data          peruutukset datan kanssa (0010, 0012, 0013, 0014, 0015)
//   rollback:reverse-chain 0015..0009 käänteisessä järjestyksessä -> tuotannon 0008
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
    // 0015: päivätön tehtävä molemmilla lähtötiloilla (date tekstinä tai
    // date-tyyppinä): siemenet a-later/b-later ja yksi lisäys omistajana.
    // Alkuperäisillä riveillä horisontti on NULL ja siirtolaskuri 0.
    const dateless = await tryAs(client, OWNER,
      `insert into public.tasks (id, date, title, horizon) values ('a-dateless-${variant}', null, 'Päivätön', 'LATER')`);
    const datelessRows = Number(await scalar(client, `select count(*) from public.tasks where date is null`));
    const legacyDefaults = (await client.query(
      `select count(*) filter (where horizon is null and waiting_on is null and archived_at is null and reschedule_count = 0) as ok,
              count(*) as total from public.tasks where id like 'seed%' or id like 'm%'`)).rows[0];
    steps.push({ dateless0015: { insert: dateless.ok, rows: datelessRows, legacyDefaults } });
    if (!dateless.ok) fail(scenario, `päivätön tehtävä 0015:n jälkeen: ${dateless.message}`);
    if (datelessRows < 3) fail(scenario, `päivättömiä tehtäviä ${datelessRows}, odotettiin vähintään 3`);
    if (Number(legacyDefaults.ok) !== Number(legacyDefaults.total)) {
      fail(scenario, `0015 muutti alkuperäisten tehtävien uusia sarakkeita: ${JSON.stringify(legacyDefaults)}`);
    }

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
  // 0015 (aalto L): rajat, eristys ja domainin yhtäpitävyys kannan kanssa.
  await lifecycle0015(client, check);

  // Taaksepäin yhteensopivuus: migraatio ajetaan aina SILLOIN kun
  // edellisen aallon koodi on tuotannossa (0010 ajetaan aallon F aikana
  // jne.). Vanhan koodin rivimuoto — ilman yhtäkään myöhemmän
  // migraation saraketta — on siis voitava kirjoittaa ja päivittää
  // koko ketjun (0015) jälkeenkin. Muodot vastaavat src/lib/rows.js:n ja
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
    ['profile upsert vanhoilla sarakkeilla', `update public.profile set age = 41, sleep_target_hours = 7.5 where id = '${OWNER}'`],
    // Aallon K koodi 0015:n jälkeen: tehtävä ja alue ilman 0015:n sarakkeita.
    ['tasks (aalto K, ilman 0015-sarakkeita)', `insert into public.tasks (id, date, time, end_time, title, category, note, completed, is_wake, description, duration_minutes, priority, scheduling_state, deadline, goal_id, project_id, milestone_id, depends_on)
       values ('a-k-task', '2026-09-24', '11:00', null, 'Aallon K muoto', 'tyo', null, false, false, null, 30, 'normaali', 'manual', null, null, null, null, '{}')`],
    ['life_areas (aalto K, ilman kind-saraketta)', `insert into public.life_areas (id, name, description, importance, target_minutes_per_week, category_key, active, sort_order)
       values ('a-k-area', 'Aallon K alue', null, 3, null, 'koti', true, 5)`]
  ];
  for (const [label, sql] of legacyShapes) {
    const r = await tryAs(client, OWNER, sql);
    check(`legacy_shape_after_0015: ${label}`, r.ok && r.rowCount === 1, JSON.stringify(r));
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

/**
 * 0015:n rajat, eristys ja domainin ja kannan yhtäpitävyys oikealla
 * kannalla. Ajetaan lifecycleScenarion sisällä 0014:n jälkeen (A:n
 * tehtävä 'a-task' on jo poistettu). Siemenet: odottava, päivätön ja
 * arkistoitu tehtävä, suojatut jaksot, viikkosuunnitelma ja kaksi aluetta
 * samalla kategorialla molemmille käyttäjille.
 */
async function lifecycle0015(client, check) {
  const code = r => (r.ok ? 'ok' : r.code);
  const count = async (sql, params = []) => Number(await scalar(client, sql, params));

  // --- tasks: odotus, horisontti, arkisto, siirrot, päivätön ------------
  const seeded = await count(`select count(*) from public.tasks where id in ('a-wait','b-wait','a-later','b-later','a-arch','b-arch')`);
  check('0015_seeded_waiting_dateless_archived_both_users', seeded === 6, seeded);
  const wait2 = await tryAs(client, OWNER, `insert into public.tasks (id, date, title, horizon, waiting_on) values ('a-wait-2', null, 'x', 'WAITING', 'Vakuutusyhtiö')`);
  check('0015_waiting_with_waiting_on_accepted', wait2.ok, JSON.stringify(wait2));
  const waitNoName = await tryAs(client, OWNER, `insert into public.tasks (id, date, title, horizon) values ('a-wait-3', '2026-09-30', 'x', 'WAITING')`);
  check('0015_waiting_without_name_accepted', waitNoName.ok, JSON.stringify(waitNoName));
  const dateless = await tryAs(client, OWNER, `insert into public.tasks (id, date, title, horizon) values ('a-later-2', null, 'x', 'THIS_WEEK')`);
  check('0015_dateless_task_accepted', dateless.ok, JSON.stringify(dateless));
  const archive = await tryAs(client, OWNER, `update public.tasks set archived_at = now(), horizon = 'NOT_YET' where id = 'a-later'`);
  check('0015_archive_accepted', archive.ok && archive.rowCount === 1, JSON.stringify(archive));
  const taskLimits = [
    ['non_waiting_with_waiting_on', `insert into public.tasks (id, date, title, horizon, waiting_on) values ('a-t-x1', null, 'x', 'LATER', 'Matti')`],
    ['null_horizon_with_waiting_on', `insert into public.tasks (id, date, title, waiting_on) values ('a-t-x2', '2026-09-30', 'x', 'Matti')`],
    ['horizon_archived', `insert into public.tasks (id, date, title, horizon) values ('a-t-x3', null, 'x', 'ARCHIVED')`],
    ['waiting_on_blank', `insert into public.tasks (id, date, title, horizon, waiting_on) values ('a-t-x4', null, 'x', 'WAITING', '   ')`],
    ['waiting_on_201', `insert into public.tasks (id, date, title, horizon, waiting_on) values ('a-t-x5', null, 'x', 'WAITING', repeat('w', 201))`],
    ['reschedule_negative', `insert into public.tasks (id, date, title, reschedule_count) values ('a-t-x6', null, 'x', -1)`],
    ['reschedule_over_10000', `insert into public.tasks (id, date, title, reschedule_count) values ('a-t-x7', null, 'x', 10001)`],
    ['waiting_on_after_horizon_change', `update public.tasks set horizon = 'LATER' where id = 'a-wait'`]
  ];
  for (const [label, sql] of taskLimits) {
    const r = await tryAs(client, OWNER, sql);
    check(`0015_rejects_${label}`, code(r) === '23514', JSON.stringify(r));
  }
  const nullCount = await tryAs(client, OWNER, `insert into public.tasks (id, date, title, reschedule_count) values ('a-t-x8', null, 'x', null)`);
  check('0015_reschedule_count_not_null', code(nullCount) === '23502', JSON.stringify(nullCount));

  // Uudet sarakkeet kuuluvat rivin omistajalle: A ei näe eikä muuta B:n
  // odotusta, horisonttia eikä arkistointia.
  const seeB = await tryAs(client, OWNER, `select waiting_on from public.tasks where id in ('b-wait', 'b-later', 'b-arch')`);
  check('0015_A_cannot_see_B_waiting_dateless_archived', seeB.ok && seeB.rowCount === 0, JSON.stringify(seeB));
  const touchB = await tryAs(client, OWNER, `update public.tasks set horizon = 'NOT_YET', waiting_on = null, archived_at = now() where id in ('b-wait', 'b-later')`);
  const bWait = (await client.query(`select horizon, waiting_on, archived_at from public.tasks where id = 'b-wait'`)).rows[0];
  check('0015_A_cannot_change_B_horizon_or_waiting', touchB.ok && touchB.rowCount === 0
    && bWait.horizon === 'WAITING' && bWait.waiting_on === 'Matti' && bWait.archived_at === null, JSON.stringify({ touchB, bWait }));
  const seeBArea = await tryAs(client, OWNER, `select kind from public.life_areas where id in ('b-la-own', 'b-la-music')`);
  check('0015_A_cannot_see_B_area_kind', seeBArea.ok && seeBArea.rowCount === 0, JSON.stringify(seeBArea));

  // --- life_areas: laji ja jaettu kategoria -------------------------------
  const shared = await count(`select count(*) from public.life_areas where user_id = $1 and category_key = 'harrastus'`, [OWNER]);
  check('0015_two_areas_share_category', shared === 2, shared);
  const third = await tryAs(client, OWNER, `insert into public.life_areas (id, name, category_key, kind) values ('a-la-c3', 'Kuoro', 'harrastus', 'WELLBEING')`);
  check('0015_third_area_same_category_accepted', third.ok, JSON.stringify(third));
  const defaultKind = await tryAs(client, OWNER, `insert into public.life_areas (id, name) values ('a-la-std', 'Vanha muoto') returning kind`);
  check('0015_area_kind_defaults_to_standard', defaultKind.ok && defaultKind.rows[0]?.kind === 'STANDARD', JSON.stringify(defaultKind));
  const badKind = await tryAs(client, OWNER, `insert into public.life_areas (id, name, kind) values ('a-la-x1', 'x1', 'SPORT')`);
  check('0015_rejects_area_kind_unknown', code(badKind) === '23514', JSON.stringify(badKind));
  const nullKind = await tryAs(client, OWNER, `insert into public.life_areas (id, name, kind) values ('a-la-x2', 'x2', null)`);
  check('0015_area_kind_not_null', code(nullKind) === '23502', JSON.stringify(nullKind));

  // --- protected_periods: säännöt ------------------------------------------
  const periodOk = [
    ['once_own_time_with_times', `insert into public.protected_periods (id, kind, recurrence, start_date, start_time, end_time) values ('a-pp-v1', 'OWN_TIME', 'once', '2026-10-03', '10:00', '12:00')`],
    ['weekly_evening_until_bedtime', `insert into public.protected_periods (id, kind, recurrence, weekdays, start_time) values ('a-pp-v2', 'FREE_TIME', 'weekly', '{1,2,3,4,5}', '17:00')`],
    ['weekly_with_date_range', `insert into public.protected_periods (id, kind, recurrence, weekdays, start_date, end_date) values ('a-pp-v3', 'OWN_TIME', 'weekly', '{6}', '2026-10-01', '2026-12-31')`],
    ['vacation_two_weeks', `insert into public.protected_periods (id, kind, recurrence, start_date, end_date) values ('a-pp-v4', 'VACATION', 'once', '2027-07-01', '2027-07-14')`],
    ['vacation_single_day', `insert into public.protected_periods (id, kind, recurrence, start_date) values ('a-pp-v5', 'VACATION', 'once', '2027-05-01')`],
    ['weekly_target_zero', `insert into public.protected_periods (id, kind, recurrence, target_minutes) values ('a-pp-v6', 'FREE_TIME', 'weekly_target', 0)`],
    ['weekly_target_full_week', `insert into public.protected_periods (id, kind, recurrence, target_minutes) values ('a-pp-v7', 'FREE_TIME', 'weekly_target', 10080)`],
    ['once_365_days', `insert into public.protected_periods (id, kind, recurrence, start_date, end_date) values ('a-pp-v8', 'OWN_TIME', 'once', '2026-01-01', '2027-01-01')`]
  ];
  for (const [label, sql] of periodOk) {
    const r = await tryAs(client, OWNER, sql);
    check(`0015_accepts_period_${label}`, r.ok, JSON.stringify(r));
  }
  const periodBad = [
    ['once_without_start_date', `insert into public.protected_periods (id, kind, recurrence) values ('a-pp-x1', 'OWN_TIME', 'once')`],
    ['once_with_weekdays', `insert into public.protected_periods (id, kind, recurrence, start_date, weekdays) values ('a-pp-x2', 'OWN_TIME', 'once', '2026-10-01', '{1}')`],
    ['end_before_start', `insert into public.protected_periods (id, kind, recurrence, start_date, end_date) values ('a-pp-x3', 'OWN_TIME', 'once', '2026-10-02', '2026-10-01')`],
    ['weekly_without_weekdays', `insert into public.protected_periods (id, kind, recurrence) values ('a-pp-x4', 'FREE_TIME', 'weekly')`],
    ['weekly_empty_weekdays', `insert into public.protected_periods (id, kind, recurrence, weekdays) values ('a-pp-x5', 'FREE_TIME', 'weekly', '{}')`],
    ['weekday_8', `insert into public.protected_periods (id, kind, recurrence, weekdays) values ('a-pp-x6', 'FREE_TIME', 'weekly', '{1,8}')`],
    ['weekday_null_element', `insert into public.protected_periods (id, kind, recurrence, weekdays) values ('a-pp-x7', 'FREE_TIME', 'weekly', '{1,NULL}')`],
    ['weekly_target_own_time', `insert into public.protected_periods (id, kind, recurrence, target_minutes) values ('a-pp-x8', 'OWN_TIME', 'weekly_target', 600)`],
    ['weekly_target_without_minutes', `insert into public.protected_periods (id, kind, recurrence) values ('a-pp-x9', 'FREE_TIME', 'weekly_target')`],
    ['weekly_target_with_time', `insert into public.protected_periods (id, kind, recurrence, target_minutes, start_time) values ('a-pp-x10', 'FREE_TIME', 'weekly_target', 600, '17:00')`],
    ['weekly_target_with_weekdays', `insert into public.protected_periods (id, kind, recurrence, target_minutes, weekdays) values ('a-pp-x11', 'FREE_TIME', 'weekly_target', 600, '{7}')`],
    ['weekly_target_over_week', `insert into public.protected_periods (id, kind, recurrence, target_minutes) values ('a-pp-x12', 'FREE_TIME', 'weekly_target', 10081)`],
    ['minutes_without_target', `insert into public.protected_periods (id, kind, recurrence, weekdays, target_minutes) values ('a-pp-x13', 'FREE_TIME', 'weekly', '{7}', 60)`],
    ['vacation_weekly', `insert into public.protected_periods (id, kind, recurrence, weekdays) values ('a-pp-x14', 'VACATION', 'weekly', '{6}')`],
    ['vacation_with_time', `insert into public.protected_periods (id, kind, recurrence, start_date, start_time) values ('a-pp-x15', 'VACATION', 'once', '2026-12-20', '08:00')`],
    ['start_not_before_end', `insert into public.protected_periods (id, kind, recurrence, weekdays, start_time, end_time) values ('a-pp-x16', 'OWN_TIME', 'weekly', '{2}', '19:00', '18:00')`],
    ['end_time_without_start', `insert into public.protected_periods (id, kind, recurrence, weekdays, end_time) values ('a-pp-x17', 'OWN_TIME', 'weekly', '{2}', '18:00')`],
    ['once_over_a_year', `insert into public.protected_periods (id, kind, recurrence, start_date, end_date) values ('a-pp-x18', 'VACATION', 'once', '2026-01-01', '2027-01-02')`],
    ['kind_unknown', `insert into public.protected_periods (id, kind, recurrence, weekdays) values ('a-pp-x19', 'SLEEP', 'weekly', '{1}')`],
    ['recurrence_unknown', `insert into public.protected_periods (id, kind, recurrence, weekdays) values ('a-pp-x20', 'OWN_TIME', 'daily', '{1}')`],
    ['strength_unknown', `insert into public.protected_periods (id, kind, recurrence, weekdays, strength) values ('a-pp-x21', 'OWN_TIME', 'weekly', '{1}', 'hard')`],
    ['title_over_60', `insert into public.protected_periods (id, kind, recurrence, weekdays, title) values ('a-pp-x22', 'OWN_TIME', 'weekly', '{1}', repeat('t', 61))`],
    ['title_blank', `insert into public.protected_periods (id, kind, recurrence, weekdays, title) values ('a-pp-x23', 'OWN_TIME', 'weekly', '{1}', '  ')`],
    ['note_over_500', `insert into public.protected_periods (id, kind, recurrence, weekdays, note) values ('a-pp-x24', 'OWN_TIME', 'weekly', '{1}', repeat('n', 501))`]
  ];
  for (const [label, sql] of periodBad) {
    const r = await tryAs(client, OWNER, sql);
    check(`0015_rejects_period_${label}`, code(r) === '23514', JSON.stringify(r));
  }
  const before = await scalar(client, `select updated_at::text from public.protected_periods where id = 'a-pp'`);
  await asUser(client, OWNER, () => client.query(`update public.protected_periods set title = 'Sunnuntai vapaa' where id = 'a-pp'`));
  const after = await scalar(client, `select updated_at::text from public.protected_periods where id = 'a-pp'`);
  check('0015_period_touch_updated_at', before !== after, `${before} -> ${after}`);

  // --- weekly_plans: viikko, maanantai, enintään viisi -----------------------
  const dupWeek = await tryAs(client, OWNER, `insert into public.weekly_plans (id, week_start) values ('a-wp-2', '2026-09-28')`);
  check('0015_one_plan_per_week', code(dupWeek) === '23505', JSON.stringify(dupWeek));
  const bSameWeek = await count(`select count(*) from public.weekly_plans where week_start = '2026-09-28'`);
  check('0015_week_unique_is_per_user', bSameWeek === 2, bSameWeek);
  const five = await tryAs(client, OWNER, `insert into public.weekly_plans (id, week_start, priorities) values ('a-wp-5', '2026-10-05',
    '[{"ref":"text","title":"1"},{"ref":"text","title":"2"},{"ref":"text","title":"3"},{"ref":"text","title":"4"},{"ref":"text","title":"5"}]')`);
  check('0015_five_priorities_accepted', five.ok, JSON.stringify(five));
  const planBad = [
    ['tuesday', `insert into public.weekly_plans (id, week_start) values ('a-wp-x1', '2026-09-29')`],
    ['sunday', `insert into public.weekly_plans (id, week_start) values ('a-wp-x2', '2026-10-04')`],
    ['six_priorities', `insert into public.weekly_plans (id, week_start, priorities) values ('a-wp-x3', '2026-10-12',
      '[{"ref":"text","title":"1"},{"ref":"text","title":"2"},{"ref":"text","title":"3"},{"ref":"text","title":"4"},{"ref":"text","title":"5"},{"ref":"text","title":"6"}]')`],
    ['priorities_object', `insert into public.weekly_plans (id, week_start, priorities) values ('a-wp-x4', '2026-10-19', '{"ref":"text"}')`],
    ['planned_over_week', `insert into public.weekly_plans (id, week_start, planned_minutes) values ('a-wp-x5', '2026-10-26', 10081)`],
    ['note_over_1000', `insert into public.weekly_plans (id, week_start, note) values ('a-wp-x6', '2026-11-02', repeat('n', 1001))`]
  ];
  for (const [label, sql] of planBad) {
    const r = await tryAs(client, OWNER, sql);
    check(`0015_rejects_plan_${label}`, code(r) === '23514', JSON.stringify(r));
  }
  const nullPriorities = await tryAs(client, OWNER, `insert into public.weekly_plans (id, week_start, priorities) values ('a-wp-x7', '2026-11-09', null)`);
  check('0015_priorities_not_null', code(nullPriorities) === '23502', JSON.stringify(nullPriorities));

  // Viittaus ei vuoda: A:n suunnitelma voi sisältää B:n tehtävän tunnisteen
  // (pelkkä merkkijono), mutta RLS ei päästä A:ta B:n riviin liitoksenkaan
  // kautta. B näkee oman viittauksensa.
  const leakRef = await tryAs(client, OWNER,
    `update public.weekly_plans set priorities = '[{"ref":"task:b-task","title":"Vieras"},{"ref":"task:b-wait","title":"Vieras 2"}]' where id = 'a-wp'`);
  check('0015_foreign_ref_is_only_text', leakRef.ok && leakRef.rowCount === 1, JSON.stringify(leakRef));
  const joinSql = `select t.id, t.user_id::text as owner from public.weekly_plans w
      cross join lateral jsonb_array_elements(w.priorities) p
      join public.tasks t on 'task:' || t.id = p->>'ref'`;
  const aJoin = await tryAs(client, OWNER, joinSql);
  check('0015_priority_ref_cannot_leak_other_users_rows', aJoin.ok && aJoin.rowCount === 0, JSON.stringify(aJoin));
  const bJoin = await tryAs(client, USER_B, joinSql);
  check('0015_priority_ref_resolves_own_rows', bJoin.ok && bJoin.rows.length === 1 && bJoin.rows[0].owner === USER_B,
    JSON.stringify(bJoin));

  // --- omistajuus ja anon -------------------------------------------------
  for (const t of ['protected_periods', 'weekly_plans']) {
    const own = t === 'protected_periods' ? 'a-pp' : 'a-wp';
    const move = await tryAs(client, OWNER, `update public.${t} set user_id = $1 where id = $2`, [USER_B, own]);
    check(`0015_${t}_ownership_transfer_denied`, code(move) === '42501', JSON.stringify(move));
    const stays = await scalar(client, `select user_id::text from public.${t} where id = $1`, [own]);
    check(`0015_${t}_owner_unchanged`, stays === OWNER, stays);
    for (const [op, sql] of [['select', `select 1 from public.${t}`], ['insert', `insert into public.${t} (id) values ('anon-x')`],
      ['update', `update public.${t} set id = id`], ['delete', `delete from public.${t}`]]) {
      const r = await tryAs(client, null, sql, [], { role: 'anon' });
      check(`0015_${t}_anon_${op}_denied`, code(r) === '42501', JSON.stringify(r));
    }
  }
  for (const [op, sql] of [['update', `update public.tasks set horizon = 'LATER'`], ['delete', `delete from public.tasks`]]) {
    const r = await tryAs(client, null, sql, [], { role: 'anon' });
    check(`0015_tasks_anon_${op}_denied`, code(r) === '42501', JSON.stringify(r));
  }

  await domainRowsAgainstDatabase(client, check);
}

/**
 * Domainin validoimat oliot kannassa: jokainen validoitu suojattu jakso,
 * viikkosuunnitelma ja tehtävän 0015-sarakkeet menee kantaan, ja
 * jokainen validoinnin hylkäämä (kun laji ja toistuvuus ovat kelvollisia)
 * suojattu jakso hylätään kannassa (23514). Sama generaattori kuin
 * tests/mental-load-migration.test.mjs:ssä, mutta oikea PostgreSQL.
 */
async function domainRowsAgainstDatabase(client, check) {
  const { protectedPeriodsRepo, weeklyPlansRepo } = await import('../../src/data/collectionsRepo.js');
  const { validateProtectedPeriod } = await import('../../src/domain/protectedTime.js');
  const { validateWeeklyPlan, WEEKLY_PRIORITY_DB_LIMIT } = await import('../../src/domain/weeklyPlan.js');
  const { normalizeTask, validateTask, TASK_HORIZONS } = await import('../../src/domain/task.js');
  const { toRow: taskToRow, TASK_COLUMNS_MENTAL_LOAD } = await import('../../src/lib/rows.js');
  let seed = 20260927;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const pick = list => list[Math.floor(rand() * list.length)];
  // Toistuvuuden kannalta olennaiset kentät saavat useimmiten arvon,
  // muut harvoin (sama periaate kuin yksikkötestissä): muuten lähes
  // jokainen syöte rikkoisi jonkin rakennesäännön.
  const V = {
    kind: ['OWN_TIME', 'FREE_TIME', 'VACATION'], recurrence: ['once', 'weekly', 'weekly_target'],
    startDate: ['2026-09-28', '2026-12-20', '2028-02-29'], endDate: ['2026-09-28', '2027-01-06', '2027-12-31', '2026-09-01'],
    weekdays: [[7], [1, 2, 3, 4, 5], [6, 7]], startTime: ['07:00', '17:00', '21:30'],
    endTime: ['08:00', '19:00', '23:59', '06:00'], targetMinutes: [0, 600, 10080, 20000],
    strength: ['firm', 'soft'], title: ['Oma ilta', 'x'.repeat(70)], note: ['Lepoa']
  };
  const RELEVANT = { once: ['startDate', 'endDate', 'startTime', 'endTime'],
    weekly: ['weekdays', 'startTime', 'endTime', 'startDate', 'endDate'], weekly_target: ['targetMinutes'] };
  const periodCols = ['id', 'kind', 'recurrence', 'title', 'start_date', 'end_date', 'weekdays', 'start_time', 'end_time',
    'target_minutes', 'strength', 'active', 'note'];
  let valid = 0; let rejectedInvalid = 0; const mismatches = [];
  for (let i = 0; i < 240; i += 1) {
    const input = { id: `a-gen-pp-${i}`, kind: pick(V.kind), recurrence: pick(V.recurrence), strength: pick(V.strength) };
    for (const [field, values] of Object.entries(V)) {
      if (['kind', 'recurrence', 'strength'].includes(field)) continue;
      const likely = field === 'title' || RELEVANT[input.recurrence].includes(field);
      if (rand() < (likely ? 0.7 : 0.1)) input[field] = pick(values);
    }
    const normalized = protectedPeriodsRepo.mapping.normalize(input);
    const verdict = validateProtectedPeriod(normalized);
    const row = protectedPeriodsRepo.mapping.toRow(normalized);
    const r = await tryAs(client, OWNER,
      `insert into public.protected_periods (${periodCols.join(', ')}) values (${periodCols.map((_, k) => `$${k + 1}`).join(', ')})`,
      periodCols.map(c => row[c]));
    if (verdict.valid) {
      valid += 1;
      if (!r.ok) mismatches.push(`domain hyväksyi, kanta hylkäsi (${r.code}): ${JSON.stringify(row)}`);
    } else if (r.ok) {
      mismatches.push(`domain hylkäsi, kanta hyväksyi: ${JSON.stringify(row)} ${JSON.stringify(verdict.errors)}`);
    } else if (r.code === '23514') rejectedInvalid += 1;
    else mismatches.push(`odottamaton virhe ${r.code}: ${r.message}`);
  }
  check('0015_domain_valid_periods_accepted_invalid_rejected', mismatches.length === 0 && valid >= 20 && rejectedInvalid >= 20,
    `${valid} validia, ${rejectedInvalid} hylättyä; ${mismatches.slice(0, 3).join(' | ')}`);

  let plans = 0; const planProblems = [];
  for (let i = 0; i < 40; i += 1) {
    const monday = new Date(Date.UTC(2030, 0, 7 + 7 * i)).toISOString().slice(0, 10);
    const n = Math.floor(rand() * 7);
    const input = {
      id: `a-gen-wp-${i}`, weekStart: i % 5 === 4 ? '2030-01-08' : monday, plannedMinutes: pick([null, 0, 600, 20000]),
      priorities: Array.from({ length: n }, (_, k) => ({ ref: pick(['text', `task:t${k}`, 'bogus']), title: `P${k}` })),
      note: pick([null, 'Hyvä viikko'])
    };
    const normalized = weeklyPlansRepo.mapping.normalize(input);
    const verdict = validateWeeklyPlan(normalized, { limit: WEEKLY_PRIORITY_DB_LIMIT });
    const row = weeklyPlansRepo.mapping.toRow(normalized);
    const r = await tryAs(client, OWNER,
      `insert into public.weekly_plans (id, week_start, priorities, planned_minutes, closed_at, note) values ($1, $2, $3, $4, $5, $6)`,
      [row.id, row.week_start, JSON.stringify(row.priorities), row.planned_minutes, row.closed_at, row.note]);
    if (verdict.valid) { plans += 1; if (!r.ok) planProblems.push(`${r.code} ${JSON.stringify(row)}`); }
    else if (r.ok) planProblems.push(`domain hylkäsi, kanta hyväksyi: ${JSON.stringify(row)}`);
  }
  check('0015_domain_valid_plans_accepted', planProblems.length === 0 && plans >= 20, `${plans} validia; ${planProblems.slice(0, 3).join(' | ')}`);

  let tasks = 0; const taskProblems = [];
  for (let i = 0; i < 80; i += 1) {
    const input = {
      id: `a-gen-t-${i}`, title: 'Generoitu', date: pick(['2026-09-28', null]), horizon: pick([...TASK_HORIZONS, null, 'x']),
      waitingOn: pick([null, 'Matti', '  ', 'w'.repeat(250)]), followUpDate: pick([null, '2026-10-01']),
      archivedAt: pick([null, '2026-09-27T10:00:00.000Z']), rescheduleCount: pick([0, 3, 20000, -2]),
      originalDate: pick([null, '2026-09-20'])
    };
    const normalized = normalizeTask(input);
    if (!validateTask(normalized, { allowDateless: true }).valid) continue;
    tasks += 1;
    const ml = taskToRow(normalized, TASK_COLUMNS_MENTAL_LOAD);
    const cols = ['id', 'date', 'title', ...TASK_COLUMNS_MENTAL_LOAD];
    const values = [normalized.id, normalized.date ?? null, normalized.title, ...TASK_COLUMNS_MENTAL_LOAD.map(c => ml[c])];
    const r = await tryAs(client, OWNER, `insert into public.tasks (${cols.join(', ')}) values (${cols.map((_, k) => `$${k + 1}`).join(', ')})`, values);
    if (!r.ok) taskProblems.push(`${r.code} ${JSON.stringify(ml)}`);
  }
  check('0015_domain_valid_task_columns_accepted', taskProblems.length === 0 && tasks >= 20, `${tasks} validia; ${taskProblems.slice(0, 3).join(' | ')}`);
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
    // Koko ketju (nyt 0015 asti): jokainen 0009+ uudelleen sanoo "JO AJETTU".
    const client = await freshAt(db, numberOf(MIGRATIONS.at(-1)));
    try {
      for (const name of MIGRATIONS.filter(m => numberOf(m) >= '0009')) {
        // 0015 poistaa 0012:n rajoitteen life_areas_category_unique: 0012:n
        // oma tunnistus laskee koko ketjun jälkeen 56/58 ja sanoo "kesken".
        // Se kaatuu yhä kiinni muuttamatta mitään (tarkistettu alla), ja
        // inventaario tuntee luvun (score-inventory SUPERSEDED_OBJECTS:
        // 0012 = 56 on ajettu, kun 0013 ja 0015 on ajettu). 0012 on
        // lukittu, joten sen viestiä ei muuteta.
        const expect = numberOf(name) === '0012' && numberOf(MIGRATIONS.at(-1)) >= '0015'
          ? /JO AJETTU|Migraatio 0012 on kesken: 56 objektia 58:sta/ : /JO AJETTU/;
        results.push(await expectClosedFailure(client, `toinen ajo koko ketjun jälkeen ${numberOf(name)}`, name, expect));
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
    const db13 = 'mv_rehearsal_fail_prereq13';
    const c13 = await freshAt(db13, '0013');
    try {
      results.push(await expectClosedFailure(c13, '0015 ilman 0014:ää', '0015_mental_load', /Migraatio 0014 pitaa ajaa ensin/));
    } finally { await c13.end(); await dropDatabase(db13); }
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
      ['0013', '0014_daily_life', 'alter table public.tasks add constraint life_settings_one_per_user unique (id)'],
      // 0015: taulu, sarake olemassa olevassa taulussa, indeksin nimi
      // toisessa taulussa, rajoitteen nimi ja käsin poistettu
      // life_areas_category_unique (0/47, mutta kanta ei ole tila 0014).
      ['0014', '0015_mental_load', 'create table public.weekly_plans (id text primary key)'],
      ['0014', '0015_mental_load', 'alter table public.tasks add column horizon text'],
      ['0014', '0015_mental_load', 'alter table public.life_areas add column kind text'],
      ['0014', '0015_mental_load', 'create index protected_periods_user_active_idx on public.tasks (user_id)'],
      ['0014', '0015_mental_load', "alter table public.tasks add constraint tasks_horizon_check check (id <> '')"],
      ['0014', '0015_mental_load', 'alter table public.life_areas drop constraint life_areas_category_unique',
        /life_areas_category_unique puuttuu, vaikka 0015:n objekteja on 0\/47/]
    ];
    let i = 0;
    for (const [at, name, sql, expect = /kesken|objekti|jo|already|olemassa/i] of cases) {
      const db = `mv_rehearsal_fail_partial_${i++}`;
      const client = await freshAt(db, at);
      try {
        await client.query(sql);
        results.push(await expectClosedFailure(client, `osittainen tila ennen ${numberOf(name)}: ${sql}`, name, expect));
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
    ['0013', '0014_daily_life', 'auth.users', 'row exclusive'],
    // 0015 MUUTTAA tasks- ja life_areas-tauluja (ACCESS EXCLUSIVE): jo
    // sovelluksen lukukysely estää, ja migraatio luovuttaa ennen yhtäkään
    // muutosta. auth.users: vain kirjoitus estää (uusien taulujen FK).
    ['0014', '0015_mental_load', 'public.tasks', 'access share'],
    ['0014', '0015_mental_load', 'public.life_areas', 'access share'],
    ['0014', '0015_mental_load', 'auth.users', 'row exclusive']
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

  // I. 0015: myöhäinen virhe VAIHEESSA 5 — tasks ja life_areas on jo
  //    muutettu (sarakkeet, rajoitteet, kategorian uniikkius pudotettu) ja
  //    uudet taulut luotu, kun ylimääräinen politiikka tasks-taulussa
  //    kaataa ajon. Koko transaktio perutaan: tasks-taululla ei ole
  //    0015:n sarakkeita ja life_areas_category_unique on yhä olemassa.
  {
    const db = 'mv_rehearsal_fail_late_0015';
    const client = await freshAt(db, '0014');
    try {
      await client.query('create policy mv_rehearsal_extra on public.tasks for select to authenticated using (false)');
      const r = await expectClosedFailure(client, '0015 kun tasks-taulun politiikkamäärä on muuttunut (vaihe 5)', '0015_mental_load',
        /politiikat muuttuivat: 81/);
      const cols = Number(await scalar(client, `select count(*) from information_schema.columns
        where table_schema = 'public' and table_name = 'tasks' and column_name in ('horizon', 'waiting_on', 'reschedule_count')`));
      const uniq = Number(await scalar(client, `select count(*) from pg_constraint where conname = 'life_areas_category_unique'`));
      const notNullDate = await scalar(client, `select is_nullable from information_schema.columns
        where table_schema = 'public' and table_name = 'tasks' and column_name = 'date'`);
      r.tasksColumnsAfter = cols; r.categoryUniqueAfter = uniq; r.dateNullableAfter = notNullDate;
      if (cols !== 0 || uniq !== 1) { r.pass = false; fail('failure', `0015 myöhäinen virhe jätti muutoksia: sarakkeita ${cols}, uniikki ${uniq}`); }
      results.push(r);
    } finally { await client.end(); await dropDatabase(db); }
  }

  // J. 0015 tasks.date NOT NULL -tuotannossa: jos lähtötilan date-sarake on
  //    NOT NULL (tuotannon tila ei ole tiedossa), 0015 pudottaa ehdon, ja
  //    peruutus EI palauta sitä (recovery-dokumentti, §4) — esitarkistus
  //    kirjaa alkuperäisen tilan.
  for (const variant of ['text', 'typed']) {
    const db = `mv_rehearsal_fail_notnull_${variant}`;
    const client = await freshAt(db, '0014', variant);
    try {
      await client.query('alter table public.tasks alter column date set not null');
      const pre = await runVerify(client, 'supabase/preflight/preflight_0015.sql');
      const recorded = pre.ok ? pre.rows.find(x => /NOT NULL ennen 0015/.test(x.check_name))?.details : null;
      const out = await runSql(client, readSql('supabase/migrations/0015_mental_load.sql'));
      const nullable = await scalar(client, `select is_nullable from information_schema.columns
        where table_schema = 'public' and table_name = 'tasks' and column_name = 'date'`);
      const ins = await tryAs(client, OWNER, `insert into public.tasks (id, date, title, horizon) values ('nn-${variant}', null, 'x', 'LATER')`);
      const pass = pre.ok && pre.failed.length === 0 && recorded === 'kyllä' && out.ok && nullable === 'YES' && ins.ok;
      results.push({ label: `0015 kun tasks.date on NOT NULL (${variant}): esitarkistus kirjaa "kyllä", ehto poistuu, päivätön kelpaa`,
        pass, recorded, nullable, error: out.error?.message || ins.message || null });
      if (!pass) fail('failure', `0015 NOT NULL -lähtötila (${variant}): ${JSON.stringify({ recorded, ok: out.ok, nullable, ins })}`);
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
    ['0011', 'GO', '0012'], ['0012', 'GO', '0013'], ['0013', 'GO', '0014'], ['0014', 'GO', '0015'], ['0015', 'GO', null]
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
        // 0015 poistaa 0012:n life_areas_category_unique: 0012 = 56 on silti ajettu.
        if (state === '0015') {
          check(`${variant}@0015: 0012 (56 objektia) tunnistetaan ajetuksi`, scored.facts.migrations['0012'] === 'run'
            && scored.facts.migrations['0015'] === 'run', JSON.stringify(scored.facts.migrations));
        }
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
  // Keskeneräinen 0015 (yksi taulu käsin) -> STOP: rivi 24 = partial.
  {
    const db = 'mv_rehearsal_inv_partial15';
    const client = await freshAt(db, '0014');
    try {
      await client.query('create table public.protected_periods (id text primary key)');
      const inv = await runInventory(client);
      const scored = scoreInventory(parseInventory(inv.cell));
      check('keskeneräinen 0015: STOP', scored.decision === 'STOP' && scored.facts.migrations['0015'] === 'partial',
        JSON.stringify({ decision: scored.decision, m: scored.facts.migrations, stops: scored.stops }));
      writeFixture('0014-partial-0015', 'state-0014-partial-0015.json', inv.cell + '\n');
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
  const numbers = ['0009', '0010', '0011', '0012', '0013', '0014', '0015'];
  for (const state of ['0007', '0008', '0009', '0010', '0011', '0012', '0013', '0014', '0015']) {
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
    case 'rollback:reverse-chain': return `rollback:reverse-chain: ${value.pass ? 'PASS' : 'FAIL'} (0015..0009 -> katalogi = tuotannon 0008)`;
    case 'failure:0010-locks': {
      const m = value.matrix || [];
      const parts = [value.late, ...(value.stall || []), ...(value.deadlock || []), value.aborted, value.rerunBlocked,
        value.rerunBlocked0014, value.authStall0014, value.rerunBlocked0015].filter(Boolean);
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
