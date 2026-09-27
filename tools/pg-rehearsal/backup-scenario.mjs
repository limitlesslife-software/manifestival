// Harjoitusskenaario `backup`: looginen tilannekuva ja palautus oikealla
// PostgreSQL:llä — EI TUOTANTOA.
//
// Jokaiselle migraatiolle N = 0009…0014 ja molemmille lähtötiloille
// (tasks.date/time tekstinä / omina tyyppeinään), P = N-1:
//
//   B1  snapshot_state_P.sql READ ONLY -transaktiossa: yksi lause, katalogi ennallaan
//   B2  jäsennys ja todennus; CSV-, sarkain- ja JSON-vienti antavat saman tuloksen
//   B3  migraatio N + verify_N; vanhat sarakkeet tavu tavulta ennallaan (compare SAMA)
//   B4  vahinko (massapäivitys, poistot kaskadeineen, profiilin numeric, uusi rivi) -> MUUTTUNUT
//   B5  palautus hyväksytään eri aikavyöhykkeessä; rivit identtisiä ml. updated_at;
//       uusi rivi säilyy; verify_N yhä 0 FAIL
//   B6  palautus on idempotentti
//   B7  uniikkiavaimen törmäys ilman karsintaa kaatuu kiinni; --prune -> kaikki SAMA,
//       liipaisimet päällä
//   B8  peukaloitu palautus kaatuu: mikään ei muutu
//   B9  ROLLBACK(N) + palautus(--prune) -> katalogi == ennen N:ää ja data sama
//       (0010: ROLLBACK:n vartija kieltäytyy (P0001), kun tavoite on 'maintenance')
//   B10 N:n jälkeinen kuva peruutettuun skeemaan hylätään, katalogi ennallaan
//   B11 N:n jälkeinen kuva -> ROLLBACK -> N uudelleen -> palautus identtinen
//   B12 väärä kanta, puuttuva käyttäjä, puuttuva omistaja, väärä saraketyyppi hylätään
//   B13 ei-superuser taulujen omistajana onnistuu; FORCE RLS ja ei-omistaja kaatuvat kiinni
//   B14 kuivaharjoitus: katalogi ja sisältö ennallaan, skripti päättyy rollback;iin
//   B15 RLS:n suodattama kuva ei läpäise tarkistusta: taulujen omistaja (ei FORCE)
//       ja BYPASSRLS-rooli kelpaavat; FORCE RLS omistajalle ja ei-omistaja ilman
//       BYPASSRLS:ää hylätään (manifestin rlsFiltered). Kuva otetaan kannan
//       NYKYISESTÄ tilasta N (snapshot_state_N): tilan P kuva N:n kannassa on
//       ristiriitainen (0010: projects/tasks -> milestones, 0012: goals ->
//       life_areas), ja parseSnapshot hylkää sen oikein.
//
// Kytkentä: node tools/pg-rehearsal/rehearse-backup.mjs (erillinen ajo) tai
// node tools/pg-rehearsal/rehearse.mjs --only=backup
// (--backup-fixtures=tests/fixtures/backup). Kumpikin ajaa ensin
// lib.guardBackupRehearsal-vahdin.
//
// Harjoittelun lib/chain/seeds tuodaan VAIN LUKUUN. extractRollback ja
// seedFor on kopioitu tähän, koska rehearse.mjs:n tuonti ajaisi sen.

import fs from 'node:fs';
import path from 'node:path';
import {
  connect, createDatabase, dropDatabase, runSql, runVerify, readSql, asUser,
  catalogFingerprint, OWNER, USER_B
} from './lib.mjs';
import { MIGRATIONS, numberOf, prepareBaseline, applyMigration } from './chain.mjs';
import { SEEDS } from './seeds.mjs';
import {
  parseExport, parseSnapshot, buildRestoreSql, buildCompareSql, OWNER as CORE_OWNER
} from '../activation/snapshot-core.mjs';

export const BACKUP_NUMBERS = Object.freeze(['0009', '0010', '0011', '0012', '0013', '0014']);
const SNAPSHOT_TZ = 'UTC';
const OTHER_TZ = 'America/Sao_Paulo';

if (CORE_OWNER !== OWNER) throw new Error('snapshot-core ja harjoittelu eri omistajalla');

const prevOf = n => String(Number(n) - 1).padStart(4, '0');
const migrationName = n => MIGRATIONS.find(m => numberOf(m) === n);

/** Sama algoritmi kuin rehearse.mjs:n extractRollback (kopio, ks. yllä). */
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

async function seedFor(client, number) {
  for (const seed of SEEDS.filter(s => s.since === number)) {
    for (const [p, uid] of [['a', OWNER], ['b', USER_B]]) {
      if (seed.ownerOnlyB && p === 'a') continue;
      await asUser(client, uid, () => client.query(seed.sql(p)));
    }
  }
}

// ---------------------------------------------------------------------
// Tuotannon kaltainen hankala sisältö (vain omistaja, kuten tuotannossa)
// ---------------------------------------------------------------------

async function awkwardBase(c) {
  await asUser(c, OWNER, async () => {
    // Erikoismerkit, rivinvaihto, kenoviiva, emoji ja dollarilainausmerkki
    // $mv0$, jotta palautuksen lainausmerkin valinta tulee todennetuksi.
    await c.query(`insert into public.goals (id, title, description, status, target_date, manual_progress, progress_mode)
                   values ('p-goal', 'Paino & kunto <90kg> "tavoite" ''x''', E'rivi1\\nrivi2 \\\\ $mv0$ € 😀 ä ö', 'paused', '2026-12-31', 40, 'manual'),
                          ('p-goal-child', 'Alatavoite', null, 'active', null, 0, 'task_based')`);
    await c.query(`insert into public.projects (id, name, goal_id, status, start_date, deadline)
                   values ('p-proj', 'Projekti ÄÖ', 'p-goal', 'active', '2026-09-01', '2026-10-01')`);
    // Kehäviittaus goals <-> projects ja viittaus tauluun itseensä.
    await c.query(`update public.goals set project_id = 'p-proj' where id = 'p-goal'`);
    await c.query(`update public.goals set parent_goal_id = 'p-goal' where id = 'p-goal-child'`);
    await c.query(`update public.tasks set goal_id = 'p-goal', project_id = 'p-proj',
                          note = E'muistiinpano & <tag> \\t sarkain' where id in ('seed1', 'seed2')`);
    // numeric-mittakaava: 82.40 EI saa muuttua muotoon 82.4.
    await c.query(`update public.profile set weight_kg = 82.40, height_cm = 180.5, sleep_target_hours = 7.25 where id = $1`, [OWNER]);
    await c.query(`update public.routines set goal_id = 'p-goal' where id = 'a-rout'`);
  });
}

/** Migraation n tuomat sarakkeet käyttöön (ajetaan heti n:n jälkeen). */
async function awkwardFor(c, n) {
  await asUser(c, OWNER, async () => {
    if (n === '0009') {
      await c.query(`update public.bills set payee = 'Sähkö Oy', iban = 'FI21 1234 5600 0007 85', reference = '1232' where id = 'a-bill'`);
      await c.query(`update public.investments set quantity = 12.50 where id = 'a-inv'`);
    }
    if (n === '0010') {
      await c.query(`update public.goals set metric = 'paino', unit = 'kg', baseline_value = 90.0000, target_value = 75.5000,
                            current_value = 82.4000, measured_on = '2026-09-20' where id = 'p-goal'`);
      await c.query(`insert into public.milestones (id, goal_id, title, status, reached_date, order_index)
                     values ('ms1', 'p-goal', 'Ensimmäinen 5 kg', 'reached', '2026-09-10', 0),
                            ('ms2', 'p-goal', 'Toinen', 'open', null, 1)`);
      await c.query(`update public.tasks set milestone_id = 'ms2', depends_on = array['seed1', 'seed2'] where id = 'seed5'`);
      await c.query(`update public.projects set milestone_id = 'ms1' where id = 'p-proj'`);
      await c.query(`update public.goals set status = 'maintenance' where id = 'p-goal-child'`);
    }
    if (n === '0012') {
      await c.query(`update public.goals set life_area_id = 'a-la' where id = 'p-goal'`);
    }
    if (n === '0014') {
      // Erikoismerkit, jsonb-rakenteet, taulukot (smallint[], date[]) ja
      // bigint: tilannekuvan on säilytettävä jokainen tavu.
      await c.query(`update public.saved_places set name = 'Sali "Ä" <x> ''y'' 😀', note = E'rivi1\\nrivi2 $mv0$ \\\\'
                     where id = 'a-place'`);
      await c.query(`update public.life_settings set hourly_value_minor = 2500, digest_time = '19:15',
                            alarm = '{"enabled": true, "weekdayTime": "06:30", "escalation": [{"afterSeconds": 0, "step": "soft"}]}'
                      where id = 'a-life'`);
      await c.query(`update public.calendar_events set goal_id = 'p-goal', recurrence_weekdays = '{1,3,5}',
                            skip_dates = '{2026-10-05,2026-10-07}' where id = 'a-event'`);
      await c.query(`update public.habit_plans set unit_cost_minor = 60 where id = 'a-habit'`);
    }
  });
}

/** Kanta tilassa `last`: lähtötila, migraatiot, siemenet ja hankala sisältö. */
async function stateAt(db, last, variant) {
  await createDatabase(db);
  const c = await connect(db);
  await c.query(`set timezone = '${SNAPSHOT_TZ}'`);
  await prepareBaseline(c, variant);
  for (const name of MIGRATIONS) {
    const n = numberOf(name);
    if (n > last) break;
    const out = await runSql(c, readSql(`supabase/migrations/${name}.sql`));
    if (!out.ok) throw new Error(`${name}: ${out.error.message}`);
    await seedFor(c, n);
    if (n === '0004') await awkwardBase(c);
    if (n >= '0009') await awkwardFor(c, n);
  }
  return c;
}

// ---------------------------------------------------------------------
// Mittarit
// ---------------------------------------------------------------------

async function takeSnapshot(c, state) {
  const sql = readSql(`supabase/backup/snapshot_state_${state}.sql`);
  const before = await catalogFingerprint(c);
  await c.query('begin isolation level repeatable read read only');
  let res;
  try { res = await c.query(sql); } finally { await c.query('rollback'); }
  const after = await catalogFingerprint(c);
  const rows = res.rows.map(r => ({ nro: r.nro, taulu: r.taulu, rivit: r.rivit == null ? null : String(r.rivit),
                                    tiiviste: r.tiiviste, sisalto: r.sisalto }));
  return { rows, single: !Array.isArray(res), unchanged: before.hash === after.hash };
}

/** Tilannekuva roolina `role` (READ ONLY): rivit tai heitetty virhe. */
async function snapshotAs(c, state, role) {
  const sql = readSql(`supabase/backup/snapshot_state_${state}.sql`);
  await c.query(`set role ${role}`);
  try {
    await c.query('begin isolation level repeatable read read only');
    try {
      const res = await c.query(sql);
      return res.rows.map(r => ({ nro: r.nro, taulu: r.taulu, rivit: r.rivit == null ? null : String(r.rivit),
                                  tiiviste: r.tiiviste, sisalto: r.sisalto }));
    } finally { await c.query('rollback'); }
  } finally { await c.query('reset role'); }
}

/** Jäsennetty kuva tai virhe (B15). */
async function parsedAs(c, state, role) {
  try { return parseSnapshot(await snapshotAs(c, state, role)); } catch (error) { return error; }
}

/** Tilannekuvan rivit (tunnisteet) tilannekuvan sarakkeilla -> tiiviste == manifesti? */
async function snapRowsDiffer(c, snap) {
  const bad = [];
  for (const [t, m] of Object.entries(snap.manifest.tables)) {
    const cols = m.cols.map(([n]) => n);
    const ids = snap.data[t].map(r => String(r[m.pk[0]]));
    const r = await c.query(`select md5(coalesce(jsonb_agg(j order by j::text), '[]'::jsonb)::text) as h, count(*)::int as n
        from (select (select jsonb_object_agg(e.key, e.value) from jsonb_each(to_jsonb(x)) e where e.key = any($1::text[])) as j
                from public.${t} x where x.${m.pk[0]}::text = any($2::text[])) s`, [cols, ids]);
    if (r.rows[0].h !== m.md5 || r.rows[0].n !== Number(m.rows)) bad.push(`${t}(${r.rows[0].n}/${m.rows})`);
  }
  return bad;
}

/** Koko public-skeeman sisältö: taulu -> md5 kaikista riveistä. */
async function contentFingerprint(c, { except = [] } = {}) {
  const tables = (await c.query(`select relname from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' order by 1`))
    .rows.map(r => r.relname).filter(t => !except.includes(t));
  const parts = [];
  for (const t of tables) {
    const r = await c.query(`select count(*)::int as n, md5(coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text), '[]'::jsonb)::text) as h from public.${t} x`);
    parts.push(`${t}:${r.rows[0].n}:${r.rows[0].h}`);
  }
  return parts.join('|');
}

async function disabledTriggers(c) {
  const r = await c.query(`select count(*)::int as n from pg_trigger t join pg_class k on k.oid = t.tgrelid
      where k.relnamespace = 'public'::regnamespace and not t.tgisinternal and t.tgenabled <> 'O'`);
  return r.rows[0].n;
}

async function compare(c, snap) {
  const r = await c.query(buildCompareSql(snap));
  return Object.fromEntries(r.rows.map(x => [x.taulu, x]));
}

const statusLine = cmp => Object.values(cmp).map(r => `${r.taulu}:${r.tila}`).join(' ');

async function damage(c, { maintenance }) {
  await asUser(c, OWNER, async () => {
    await c.query(`update public.tasks set title = 'RIKKI', completed = not completed`);
    await c.query(`delete from public.tasks where id = 'seed3'`);
    // Kaskadit: välitavoitteet poistuvat, tehtävien/projektien/rutiinien/
    // alatavoitteen viittaukset nollautuvat.
    await c.query(`delete from public.goals where id = 'p-goal'`);
    await c.query(`delete from public.projects where id = 'a-proj'`);
    // NOT NULL -kaskadi: rutiinin poikkeukset poistuvat rutiinin mukana.
    await c.query(`delete from public.routines where id = 'a-rout'`);
    await c.query(`update public.profile set weight_kg = 1, sleep_target_hours = 4 where id = $1`, [OWNER]);
    if (maintenance) await c.query(`update public.goals set status = 'maintenance' where id = 'a-goal'`);
    await c.query(`insert into public.tasks (id, date, title, category) values ('new-after-snapshot', '2026-09-30', 'Uusi', 'muu')`);
  });
}

function toCsv(rows, delimiter = ',') {
  const cols = ['nro', 'taulu', 'rivit', 'tiiviste', 'sisalto'];
  const q = v => (v === null ? '' : `"${String(v).replace(/"/g, '""')}"`);
  return [cols.join(delimiter), ...rows.map(r => cols.map(k => q(r[k])).join(delimiter))].join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------------
// Skenaario
// ---------------------------------------------------------------------

export async function backupScenario({ fixtureDir = null, variants = ['text', 'typed'], numbers = BACKUP_NUMBERS,
  log = () => {} } = {}) {
  const results = [];
  const textSnapshots = {};
  const pid = process.pid;

  for (const variant of variants) {
    for (const n of numbers) {
      const p = prevOf(n);
      const name = migrationName(n);
      const tag = `${variant} ${n}`;
      const check = (id, label, pass, detail = '') => {
        results.push({ variant, migration: n, id, label, pass: Boolean(pass), detail: pass ? '' : String(detail) });
        log(`${pass ? 'PASS' : 'FAIL'}  [${tag}] ${id} ${label}${pass ? '' : `  ${detail}`}`);
      };
      const migrationSql = readSql(`supabase/migrations/${name}.sql`);
      const rollbackSql = extractRollback(migrationSql);
      const db1 = `mv_rehearsal_bk_${variant}_${n}_a`;
      const db2 = `mv_rehearsal_bk_${variant}_${n}_b`;
      const db3 = `mv_rehearsal_bk_${variant}_${n}_c`;
      const roles = [`mv_bk_owner_${pid}`, `mv_bk_notowner_${pid}`, `mv_bk_reader_${pid}`];
      let c;
      let snapP;
      try {
        // ------------------------------------------------ B1–B8, B13, B14
        c = await stateAt(db1, p, variant);
        const shot = await takeSnapshot(c, p);
        check('B1', `snapshot_state_${p}.sql: yksi lause READ ONLY -transaktiossa, katalogi ennallaan`,
          shot.single && shot.unchanged && shot.rows.length >= 2, JSON.stringify({ single: shot.single, unchanged: shot.unchanged }));

        let parsed = null;
        try { parsed = parseSnapshot(shot.rows); } catch (e) { parsed = e; }
        const okParse = !(parsed instanceof Error) && parsed.manifest.state === p;
        const viaCsv = okParse && parseSnapshot(parseExport(toCsv(shot.rows)));
        const viaTsv = okParse && parseSnapshot(parseExport(toCsv(shot.rows, '\t')));
        const viaJson = okParse && parseSnapshot(parseExport(JSON.stringify(shot.rows, null, 2)));
        const same = s => s && s.manifestMd5 === parsed.manifestMd5
          && Object.keys(parsed.raw).every(t => s.raw[t] === parsed.raw[t]);
        check('B2', 'jäsennys: tiivisteet, rivimäärät ja viite-eheys; CSV = sarkain = JSON',
          okParse && same(viaCsv) && same(viaTsv) && same(viaJson),
          parsed instanceof Error ? parsed.message : 'vientimuodot erosivat');
        if (!okParse) throw new Error(`jäsennys epäonnistui: ${parsed.message || 'väärä tila'}`);
        snapP = parsed;
        if (variant === 'text') textSnapshots[n] = snapP;
        if (fixtureDir && variant === 'text' && p === '0009') {
          fs.writeFileSync(path.join(fixtureDir, 'state-0009.json'), JSON.stringify(shot.rows, null, 2) + '\n');
        }

        const applied = await applyMigration(c, name);
        let cmp = await compare(c, snapP);
        let differ = await snapRowsDiffer(c, snapP);
        check('B3', `preflight_${n} + ${n} + verify_${n}: vanhat sarakkeet tavu tavulta ennallaan (compare SAMA)`,
          applied.ok && applied.preflight && !applied.preflight.error && !applied.preflight.fail?.length
            && applied.verify && !applied.verify.error && !applied.verify.fail?.length && differ.length === 0
            && Object.values(cmp).every(r => r.tila === 'SAMA'),
          `${applied.error?.message || ''} ${JSON.stringify(applied.preflight)} ${JSON.stringify(applied.verify)} ${differ.join(',')} ${statusLine(cmp)}`);

        await damage(c, { maintenance: n >= '0010' });
        cmp = await compare(c, snapP);
        const expectChanged = ['tasks', 'goals', 'projects', 'profile', 'routines', 'routine_exceptions'];
        check('B4', 'vahinko näkyy: MUUTTUNUT ja tunnisteet (p-goal puuttuu, uusi rivi)',
          expectChanged.every(t => cmp[t]?.tila === 'MUUTTUNUT')
            && /p-goal/.test(cmp.goals.puuttuvat_id || '') && /new-after-snapshot/.test(cmp.tasks.uudet_id || ''),
          statusLine(cmp));

        // B5: palautus eri aikavyöhykkeessä kuin otto.
        const restoreSql = buildRestoreSql(snapP);
        await c.query(`set timezone = '${OTHER_TZ}'`);
        let out = await runSql(c, restoreSql);
        const cmpOtherTz = await compare(c, snapP);
        await c.query(`set timezone = '${SNAPSHOT_TZ}'`);
        differ = await snapRowsDiffer(c, snapP);
        const kept = (await c.query(`select 1 from public.tasks where id = 'new-after-snapshot'`)).rowCount;
        const ver = await runVerify(c, `supabase/verify/verify_${n}.sql`);
        cmp = await compare(c, snapP);
        check('B5', `palautus hyväksytty (istunto ${OTHER_TZ}); rivit identtisiä ml. updated_at; uusi rivi säilyi; verify_${n} 0 FAIL`,
          out.ok && differ.length === 0 && kept === 1 && ver.ok && ver.failed.length === 0
            && cmp.tasks.tila === 'SAMA+1 UUTTA'
            && Object.values(cmp).filter(r => r.taulu !== 'tasks').every(r => r.tila === 'SAMA'),
          `${out.error?.message || ''} ${differ.join(',')} kept=${kept} ${ver.failed?.map(f => f.check_name).join(';')} ${statusLine(cmp)}`);
        const tzTables = new Set(Object.entries(snapP.manifest.tables)
          .filter(([, m]) => m.cols.some(([, ty]) => /with time zone/.test(ty))).map(([t]) => t));
        check('B5', 'compare eri aikavyöhykkeessä: aikaleimalliset EI VERTAILTAVISSA, muut SAMA (ei vääriä tuloksia)',
          tzTables.size > 0 && Object.values(cmpOtherTz).every(r => (tzTables.has(r.taulu)
            ? /^EI VERTAILTAVISSA/.test(r.tila) : r.tila === 'SAMA')),
          statusLine(cmpOtherTz));

        out = await runSql(c, restoreSql);
        differ = await snapRowsDiffer(c, snapP);
        check('B6', 'palautus on idempotentti', out.ok && differ.length === 0, out.error?.message || differ.join(','));

        // B7: uniikkiavaimen törmäys (wellbeing_entries: yksi merkintä per päivä).
        await asUser(c, OWNER, async () => {
          await c.query(`delete from public.wellbeing_entries where id = 'a-wb'`);
          await c.query(`insert into public.wellbeing_entries (id, date, energy, mood) values ('a-wb-new', '2026-09-22', 1, 1)`);
        });
        const fpBeforeClash = await contentFingerprint(c);
        out = await runSql(c, restoreSql);
        const fpAfterClash = await contentFingerprint(c);
        check('B7', 'ilman karsintaa uniikkiavaimen törmäys kaatuu kiinni (23505), mitään ei muutu',
          !out.ok && out.error.code === '23505' && fpBeforeClash === fpAfterClash && await disabledTriggers(c) === 0,
          out.error?.message || 'meni läpi');
        out = await runSql(c, buildRestoreSql(snapP, { prune: true }));
        cmp = await compare(c, snapP);
        const gone = (await c.query(`select 1 from public.tasks where id = 'new-after-snapshot'`)).rowCount;
        check('B7', '--prune: kaikki SAMA, uusi rivi poistettu, liipaisimet päällä',
          out.ok && gone === 0 && Object.values(cmp).every(r => r.tila === 'SAMA') && await disabledTriggers(c) === 0,
          `${out.error?.message || ''} ${statusLine(cmp)}`);

        // B8: peukaloitu palautus (tilannekuvan teksti muutettu skriptissä).
        await asUser(c, OWNER, () => c.query(`update public.tasks set title = 'RIKKI2' where id = 'seed4'`));
        const tampered = restoreSql.replace('"title": "Synteettinen tehtävä 1"', '"title": "Synteettinen tehtävä X"');
        const fpCat = await catalogFingerprint(c);
        const fpData = await contentFingerprint(c);
        out = await runSql(c, tampered);
        check('B8', 'peukaloitu palautus kaatuu (EI TÄSMÄÄ): katalogi, sisältö ja liipaisimet ennallaan',
          tampered !== restoreSql && !out.ok && /EI TÄSMÄÄ/.test(out.error.message)
            && fpCat.hash === (await catalogFingerprint(c)).hash && fpData === await contentFingerprint(c)
            && await disabledTriggers(c) === 0,
          out.error?.message || 'meni läpi');

        // Negatiiviset kontrollit: miksi säännöt ovat olemassa.
        const reserialized = { ...snapP, raw: { ...snapP.raw, profile: JSON.stringify(JSON.parse(snapP.raw.profile)) } };
        out = await runSql(c, buildRestoreSql(reserialized));
        check('B8', 'kontrolli: JS:ssä uudelleen sarjallistettu payload (82.40 -> 82.4) kaatuu, mitään ei muutu',
          snapP.raw.profile.includes('82.40') && !reserialized.raw.profile.includes('82.40')
            && !out.ok && /EI TÄSMÄÄ: profile/.test(out.error.message) && fpData === await contentFingerprint(c),
          out.error?.message || 'meni läpi');
        const noTriggerOff = restoreSql.split('\n')
          .filter(l => !/^alter table public\.\w+ (disable|enable) trigger user;$/.test(l)).join('\n')
          .replace(/do \$mv_triggers\$[\s\S]*?end \$mv_triggers\$;/, '');
        out = await runSql(c, noTriggerOff);
        check('B8', 'kontrolli: ilman disable trigger user updated_at ylikirjoittuu -> kaatuu, mitään ei muutu',
          noTriggerOff !== restoreSql && !/trigger user/.test(noTriggerOff)
            && !out.ok && /EI TÄSMÄÄ/.test(out.error.message) && fpData === await contentFingerprint(c),
          out.error?.message || 'meni läpi');

        // B14: kuivaharjoitus vahingoittuneeseen tilaan.
        const dry = buildRestoreSql(snapP, { dryRun: true, prune: true });
        out = await runSql(c, dry);
        check('B14', 'kuivaharjoitus: onnistuu, päättyy rollback;iin, katalogi ja sisältö ennallaan',
          out.ok && /\nrollback;\n$/.test(dry) && !/\bcommit;/.test(dry)
            && fpCat.hash === (await catalogFingerprint(c)).hash && fpData === await contentFingerprint(c),
          out.error?.message || 'muutti kantaa');

        // B13: ei-superuser. Taulut siirretään roolille, joka EI ole superuser
        // eikä BYPASSRLS (Supabasen postgres on lähempänä tätä kuin superuseria).
        const [owner, notOwner] = roles;
        await c.query(`create role ${owner} nologin nosuperuser nobypassrls`);
        await c.query(`grant usage on schema auth, public to ${owner}`);
        await c.query(`grant select, references on auth.users to ${owner}`);
        await c.query(`grant temporary on database ${db1} to ${owner}`);
        // Kaikki nykyiset public-taulut (tila N): B13 palauttaa tilan P kuvan
        // (osajoukko), B15 ottaa tilan N kuvan.
        const currentTables = (await c.query(
          `select relname from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' order by 1`)).rows.map(r => r.relname);
        for (const t of currentTables) await c.query(`alter table public.${t} owner to ${owner}`);
        const asRole = async (role, sql) => {
          try { return await runSql(c, `set role ${role};\n${sql}`); } finally { await c.query('reset role'); }
        };
        await asUser(c, OWNER, () => c.query(`update public.tasks set title = 'RIKKI-B13' where id = 'seed1'`));
        out = await asRole(owner, restoreSql);
        differ = await snapRowsDiffer(c, snapP);
        check('B13', 'ei-superuser (nobypassrls) taulujen omistajana: palautus hyväksytty ja identtinen',
          out.ok && differ.length === 0, out.error?.message || differ.join(','));

        // B15: taulujen omistaja ohittaa RLS:n (ei FORCE): kuva kelpaa.
        let asOwner = await parsedAs(c, n, owner);
        check('B15', 'tilannekuva taulujen omistajana (nobypassrls, ei FORCE): kelpaa, rlsFiltered = false',
          !(asOwner instanceof Error) && Object.values(asOwner.manifest.tables).every(m => m.rlsFiltered === false),
          asOwner instanceof Error ? asOwner.message : 'rlsFiltered ei ole false kaikissa tauluissa');

        await c.query('alter table public.tasks force row level security');
        await asUser(c, OWNER, () => c.query(`update public.tasks set title = 'RIKKI-FORCE' where id = 'seed1'`));
        out = await asRole(owner, restoreSql);
        const forced = (await c.query(`select title from public.tasks where id = 'seed1'`)).rows[0]?.title;
        check('B13', 'FORCE RLS ilman BYPASSRLS:ää: suoja kieltäytyy, mitään ei muutu',
          !out.ok && /FORCE ROW LEVEL SECURITY/.test(out.error.message) && forced === 'RIKKI-FORCE',
          out.error?.message || 'meni läpi');
        // B15: FORCE RLS: omistajakin näkee vain politiikan sallimat rivit -> hylätään.
        asOwner = await parsedAs(c, n, owner);
        check('B15', 'FORCE RLS: omistajan tilannekuva hylätään (tasks: RLS suodatti rivit)',
          asOwner instanceof Error && /tasks: RLS suodatti rivit/.test(asOwner.message),
          asOwner instanceof Error ? asOwner.message : 'suodatettu kuva kelpasi');
        await c.query('alter table public.tasks no force row level security');

        await c.query(`create role ${notOwner} nologin nosuperuser bypassrls`);
        await c.query(`grant usage on schema auth, public to ${notOwner}`);
        await c.query(`grant select on auth.users to ${notOwner}`);
        await c.query(`grant select, insert, update, delete on all tables in schema public to ${notOwner}`);
        await c.query(`grant temporary on database ${db1} to ${notOwner}`);
        const fpCat2 = await catalogFingerprint(c);
        out = await asRole(notOwner, restoreSql);
        const still = (await c.query(`select title from public.tasks where id = 'seed1'`)).rows[0]?.title;
        check('B13', 'ei-omistaja kaatuu kiinni (ei omista tauluja), mitään ei muutu',
          !out.ok && /ei omista tauluja/.test(out.error.message) && still === 'RIKKI-FORCE'
            && fpCat2.hash === (await catalogFingerprint(c)).hash,
          out.error?.message || 'meni läpi');

        // B15: BYPASSRLS ohittaa RLS:n; ei-omistaja ilman sitä näkee vain
        // politiikan sallimat rivit (tässä ei yhtään) -> hylätään.
        const asBypass = await parsedAs(c, n, notOwner);
        check('B15', 'tilannekuva ei-omistajana BYPASSRLS-oikeudella: kelpaa, rlsFiltered = false',
          !(asBypass instanceof Error) && Object.values(asBypass.manifest.tables).every(m => m.rlsFiltered === false),
          asBypass instanceof Error ? asBypass.message : 'rlsFiltered ei ole false kaikissa tauluissa');
        const reader = roles[2];
        await c.query(`create role ${reader} nologin nosuperuser nobypassrls`);
        await c.query(`grant usage on schema auth, public to ${reader}`);
        await c.query(`grant select on auth.users to ${reader}`);
        await c.query(`grant select on all tables in schema public to ${reader}`);
        const asReader = await parsedAs(c, n, reader);
        check('B15', 'tilannekuva ei-omistajana ilman BYPASSRLS:ää hylätään (RLS suodatti rivit)',
          asReader instanceof Error && /tasks: RLS suodatti rivit/.test(asReader.message)
            && /goals: RLS suodatti rivit/.test(asReader.message),
          asReader instanceof Error ? asReader.message : 'suodatettu kuva kelpasi');
        await c.end(); c = null;
        await dropDatabase(db1);

        // ------------------------------------------------ B9–B11
        c = await stateAt(db2, p, variant);
        const snap2 = parseSnapshot((await takeSnapshot(c, p)).rows);
        const fp0 = await catalogFingerprint(c);
        out = await runSql(c, migrationSql);
        if (!out.ok) throw new Error(`${name}: ${out.error.message}`);
        await seedFor(c, n);
        await damage(c, { maintenance: n >= '0010' });
        if (n === '0010') {
          const fpm = await catalogFingerprint(c);
          const refused = await runSql(c, rollbackSql);
          // ROLLBACK-osion vartija (F8) kieltäytyy ennen yhtäkään DDL:ää
          // selkeällä viestillä (P0001) — ei enää tilarajoitteen 23514:ää.
          check('B9', '0010:n ROLLBACK:n vartija kieltäytyy, kun tavoite on maintenance (P0001), katalogi ennallaan',
            !refused.ok && refused.error.code === 'P0001' && /tilassa maintenance/.test(refused.error.message)
              && fpm.hash === (await catalogFingerprint(c)).hash,
            refused.error?.message || 'meni läpi');
          await c.query(`update public.goals set status = 'active' where status = 'maintenance'`);
        }
        const rolled = await runSql(c, rollbackSql);
        out = await runSql(c, buildRestoreSql(snap2, { prune: true }));
        const fp1 = await catalogFingerprint(c);
        differ = await snapRowsDiffer(c, snap2);
        cmp = await compare(c, snap2);
        check('B9', `ROLLBACK(${n}) + palautus(--prune): katalogi == ennen ${n}:ää ja data sama (kaikki SAMA)`,
          rolled.ok && out.ok && fp0.hash === fp1.hash && differ.length === 0 && Object.values(cmp).every(r => r.tila === 'SAMA'),
          `${rolled.error?.message || ''} ${out.error?.message || ''} katalogi=${fp0.hash === fp1.hash} ${differ.join(',')}`);

        // B10: N:n jälkeinen kuva peruutettuun skeemaan.
        out = await runSql(c, migrationSql);
        if (!out.ok) throw new Error(`${name} uudelleen: ${out.error.message}`);
        await seedFor(c, n);
        await awkwardFor(c, n);
        const snapN = parseSnapshot((await takeSnapshot(c, n)).rows);
        if (n === '0010') await c.query(`update public.goals set status = 'active' where status = 'maintenance'`);
        const rolled2 = await runSql(c, rollbackSql);
        const fpg = await catalogFingerprint(c);
        const dataG = await contentFingerprint(c);
        out = await runSql(c, buildRestoreSql(snapN));
        check('B10', `${n}:n jälkeinen kuva peruutettuun skeemaan hylätään (Skeema ei vastaa), katalogi ja sisältö ennallaan`,
          rolled2.ok && !out.ok && /Skeema ei vastaa/.test(out.error.message)
            && fpg.hash === (await catalogFingerprint(c)).hash && dataG === await contentFingerprint(c),
          `${rolled2.error?.message || ''} ${out.error?.message || 'meni läpi'}`);

        // B11: vahingossa ajettu ROLLBACK on korjattavissa.
        out = await runSql(c, migrationSql);
        const again = out.ok;
        out = await runSql(c, buildRestoreSql(snapN));
        differ = await snapRowsDiffer(c, snapN);
        cmp = await compare(c, snapN);
        const ver11 = await runVerify(c, `supabase/verify/verify_${n}.sql`);
        check('B11', `${n}:n jälkeinen kuva -> ROLLBACK -> ${n} uudelleen -> palautus identtinen (kaikki SAMA, verify 0 FAIL)`,
          again && out.ok && differ.length === 0 && Object.values(cmp).every(r => r.tila === 'SAMA')
            && ver11.ok && ver11.failed.length === 0,
          `${out.error?.message || ''} ${differ.join(',')} ${statusLine(cmp)}`);
        if (n === '0010') {
          const m = (await c.query(`select status, current_value::text as v from public.goals where id in ('p-goal', 'p-goal-child') order by id`)).rows;
          const ms = Number((await c.query(`select count(*) from public.milestones`)).rows[0].count);
          const dep = (await c.query(`select depends_on from public.tasks where id = 'seed5'`)).rows[0]?.depends_on;
          check('B11', '0010: maintenance, mittari 82.4000, välitavoitteet ja depends_on palautuivat',
            m[1]?.status === 'maintenance' && m[0]?.v === '82.4000' && ms >= 2 && JSON.stringify(dep) === '["seed1","seed2"]',
            JSON.stringify({ m, ms, dep }));

          // Päätöspuun haara C (BK-03): aallon F koodi kirjoittaa muokatessaan
          // 'maintenance' -> 'active'. Aallon G palattua tila palautetaan
          // 0010:n jälkeisestä kuvasta vain goals-taulusta, kuivaharjoitus ensin.
          await asUser(c, OWNER, () => c.query(
            `update public.goals set status = 'active', title = 'F muokkasi' where id = 'p-goal-child'`));
          const othersBefore = await contentFingerprint(c, { except: ['goals'] });
          const dryGoals = await runSql(c, buildRestoreSql(snapN, { tables: ['goals'], dryRun: true }));
          const afterDry = (await c.query(`select status from public.goals where id = 'p-goal-child'`)).rows[0]?.status;
          out = await runSql(c, buildRestoreSql(snapN, { tables: ['goals'] }));
          const back = (await c.query(`select status, title from public.goals where id = 'p-goal-child'`)).rows[0];
          differ = await snapRowsDiffer(c, snapN);
          check('B11', '0010 haara C: F:n kirjoittama active -> maintenance palautuu --tables=goals (kuivaharjoitus ensin), muut taulut koskematta',
            dryGoals.ok && afterDry === 'active' && out.ok && back?.status === 'maintenance' && back?.title === 'Alatavoite'
              && othersBefore === await contentFingerprint(c, { except: ['goals'] }) && differ.length === 0,
            `${dryGoals.error?.message || ''} ${out.error?.message || ''} ${JSON.stringify({ afterDry, back })} ${differ.join(',')}`);
        }
        await c.end(); c = null;
        await dropDatabase(db2);

        // ------------------------------------------------ B12
        c = await stateAt(db3, p, variant);
        const fp3 = await catalogFingerprint(c);
        out = await runSql(c, buildRestoreSql(snapP));
        check('B12', 'väärä kanta hylätään (VÄÄRÄ KANTA), katalogi ennallaan',
          !out.ok && /VÄÄRÄ KANTA/.test(out.error.message) && fp3.hash === (await catalogFingerprint(c)).hash,
          out.error?.message || 'meni läpi');
        if (variant === 'typed' && textSnapshots[n]) {
          // Sama kanta, mutta tekstimuunnelman kuva: tasks.date text vs date.
          const other = textSnapshots[n];
          const patched = { ...other, manifest: { ...other.manifest, db: db3 } };
          out = await runSql(c, buildRestoreSql(patched));
          check('B12', 'eri saraketyyppi (tasks.date text vs date) hylätään (Skeema ei vastaa)',
            !out.ok && /Skeema ei vastaa/.test(out.error.message) && /tasks\.date/.test(out.error.message),
            out.error?.message || 'meni läpi');
        }
        await c.query(`set session_replication_role = replica`);
        await c.query(`delete from auth.users where id = $1`, [USER_B]);
        await c.query(`set session_replication_role = default`);
        out = await runSql(c, buildRestoreSql(snapP));
        check('B12', 'tilannekuvan käyttäjä puuttuu auth.users-taulusta: hylätään',
          !out.ok && /käyttäjää puuttuu/.test(out.error.message), out.error?.message || 'meni läpi');
        await c.query(`set session_replication_role = replica`);
        await c.query(`delete from auth.users where id = $1`, [OWNER]);
        await c.query(`set session_replication_role = default`);
        out = await runSql(c, buildRestoreSql(snapP));
        check('B12', 'omistaja puuttuu (väärä projekti): hylätään, katalogi ennallaan',
          !out.ok && /VÄÄRÄ PROJEKTI/.test(out.error.message) && fp3.hash === (await catalogFingerprint(c)).hash,
          out.error?.message || 'meni läpi');
        await c.end(); c = null;
        await dropDatabase(db3);
      } catch (error) {
        check('KESKEYTYS', error.message, false, error.stack);
      } finally {
        try { await c?.end(); } catch { /* suljettu */ }
        for (const db of [db1, db2, db3]) { try { await dropDatabase(db); } catch { /* ei ollut */ } }
        const admin = await connect();
        try {
          for (const role of roles) await admin.query(`drop role if exists ${role}`);
        } finally { await admin.end(); }
      }
    }
  }
  return results;
}

/** Tiivistelmä: B-tunnus -> läpäisyt/yhteensä. */
export function summarizeBackup(results) {
  const by = {};
  for (const r of results) {
    by[r.id] = by[r.id] || { pass: 0, total: 0 };
    by[r.id].total += 1;
    if (r.pass) by[r.id].pass += 1;
  }
  return by;
}
