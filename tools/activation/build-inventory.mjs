// Generoi supabase/acceptance/activation_readonly_inventory.sql.
//
//   node tools/activation/build-inventory.mjs          kirjoita tiedosto
//   node tools/activation/build-inventory.mjs --check  vertaa levyyn (testit)
//
// MIKSI GENEROIDAAN
//
// Inventaario kertoo, missä tilassa tuotannon kanta on migraatioiden
// 0002–0015 suhteen: ajamaton (0 objektia), ajettu (täysi luku) vai kesken
// (muu luku). Luku on luotettava vain, jos inventaario laskee TÄSMÄLLEEN
// samat objektit kuin migraatio itse laskee ennen ajoa. Siksi
// tunnistuslistoja ei kopioida käsin: ne poimitaan jokaisen migraation
// omasta `select count(*) into olemassa from ( ... ) kaikki;` -lohkosta.
//
// MIKSI YKSI LAUSE
//
// Supabasen SQL-editori näyttää vain VIIMEISEN lauseen tuloksen. Aiempi
// life_alignment_readonly_inventory.sql oli 16 lausetta — ja kaatui
// kokonaan, jos tasks.date on tekstiä (date_trunc(text)). Tämä on yksi
// SELECT, joka palauttaa yhden taulukon, ja jonka rivillä 00 on koko
// tulos yhtenä JSON-solun tiivisteenä.
//
// VAIN LUKU. Ei käyttäjän sisältöä: vain rakenne, lukumäärät ja tilat.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = 'supabase/acceptance/activation_readonly_inventory.sql';
const OWNER = '2cc00622-f927-4604-a518-361a4328481b';

/** Täysi objektimäärä jokaiselle migraatiolle. 0004: 36, tai 37 jos routines on olemassa. */
export const EXPECTED = Object.freeze({
  '0002': 12, '0003': 25, '0004': '36|37', '0005': 9, '0006': 10, '0007': 39,
  '0008': 11, '0009': 39, '0010': 38, '0011': 72, '0012': 58, '0013': 46, '0014': 153, '0015': 47
});

/**
 * Migraation 0014 taulut: rivimäärät riveille 90–99 (rivin 89 jälkeen).
 * Vanhoja rivinumeroita EI numeroida uudelleen: liitetyt inventaariot ja
 * fixturet pysyvät luettavina.
 */
export const DAILY_LIFE_TABLES = Object.freeze([
  'saved_places', 'place_aliases', 'calendar_events', 'commute_observations', 'life_settings',
  'sleep_logs', 'habit_plans', 'habit_events', 'exercise_sessions', 'wellbeing_checkins'
]);
export const DAILY_LIFE_FIRST_ROW = 90;

/**
 * Migraation 0015 uudet taulut: rivimäärät riveille 31–32, ja rivi 33
 * päivättömille tehtäville. Rivit 90–99 ovat täynnä, eikä kolminumeroinen
 * rivi kelpaa: taulukkomuotoinen liitos (score-inventory parseInventory)
 * ja lajittelu (order by 1, tekstinä) tuntevat vain kaksinumeroiset.
 * 31–39 ovat vapaita; vanhoja rivejä ei numeroida uudelleen.
 */
export const MENTAL_LOAD_TABLES = Object.freeze(['protected_periods', 'weekly_plans']);
export const MENTAL_LOAD_FIRST_ROW = 31;

function detectionBlock(file) {
  const src = fs.readFileSync(path.join(ROOT, 'supabase/migrations', file), 'utf8').replace(/\r\n/g, '\n');
  const m = /select count\(\*\) into olemassa from \(\n([\s\S]*?)\n\s*\) kaikki;/.exec(src);
  if (!m) throw new Error(`${file}: tunnistuslohkoa ei löytynyt`);
  // Kohdetaulu ei ehkä ole vielä olemassa (inventaario ajetaan myös ennen
  // edeltäviä migraatioita): 'public.x'::regclass kaatuisi jo
  // suunnitteluvaiheessa, to_regclass palauttaa nullin.
  return m[1]
    .replace(/'(public\.\w+)'::regclass/g, "to_regclass('$1')")
    .split('\n').map(line => '        ' + line.trim()).join('\n');
}

/** Rivitaulukon muodostin: [nro, osio, tarkistus, arvo-SQL]. */
function row(nro, osio, nimi, arvoSql) {
  return `  select '${nro}'::text as nro, '${osio}'::text as osio, '${nimi.replace(/'/g, "''")}'::text as tarkistus,\n         (${arvoSql})::text as arvo`;
}

/** Rivimäärä taululle, joka ei ehkä ole olemassa (query_to_xml on vain lukeva). */
function countIfExists(table) {
  return `case when to_regclass('public.${table}') is null then 'puuttuu'
              else (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.${table}', false, true, '')))[1]::text end`;
}

export function buildInventorySql() {
  const migrations = fs.readdirSync(path.join(ROOT, 'supabase/migrations'))
    .filter(n => /^00(0[2-9]|1\d)_.*\.sql$/.test(n)).sort();

  const rows = [];
  rows.push(row('01', 'kanta', 'PostgreSQL server_version_num', "current_setting('server_version_num')"));
  rows.push(row('02', 'kanta', 'PostgreSQL versio', "current_setting('server_version')"));
  rows.push(row('03', 'kanta', 'Tietokanta', 'current_database()'));
  rows.push(row('04', 'kanta', 'Hetki (UTC)', "to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS')"));

  rows.push(row('10', 'migraatio', '0001 tasks.user_id', `(select count(*) from information_schema.columns
        where table_schema = 'public' and table_name = 'tasks' and column_name = 'user_id')`));
  let nro = 11;
  for (const file of migrations) {
    const n = file.slice(0, 4);
    rows.push(row(String(nro++), 'migraatio', `${n} objekteja`, `select count(*) from (\n${detectionBlock(file)}\n      ) kaikki`));
  }
  rows.push(row('30', 'migraatio', '0013 korvaava lähderajoite (time_entries_source_v2_check)',
    "(select count(*) from pg_constraint where conname = 'time_entries_source_v2_check')"));

  rows.push(row('40', 'esiehto', 'Hyväksytty omistaja auth.users-taulussa (0010–0015 vaativat)',
    `(select count(*) from auth.users where id = '${OWNER}'::uuid)`));
  rows.push(row('41', 'esiehto', 'Auth-käyttäjiä (lukumäärä)', '(select count(*) from auth.users)'));
  rows.push(row('42', 'esiehto', 'Omistajan rivin avaimet (goals, projects, tasks, routines, recurring_expenses)',
    `(select count(*) from pg_constraint where contype = 'u' and conname in
        ('goals_owner_row_key', 'projects_owner_row_key', 'tasks_owner_row_key',
         'routines_owner_row_key', 'recurring_expenses_owner_row_key'))`));
  rows.push(row('43', 'esiehto', 'touch_updated_at on INVOKER ja search_path kiinnitetty',
    `(select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'touch_updated_at' and not p.prosecdef
          and exists (select 1 from unnest(p.proconfig) a where a like 'search\\_path=%'))`));
  rows.push(row('44', 'esiehto', 'Tavoitteita, joiden tila ei kelpaa 0010:n rajoitteelle',
    `case when to_regclass('public.goals') is null then 'puuttuu' else
       (xpath('/row/c/text()', query_to_xml($q$select count(*) as c from public.goals
          where status not in ('active','paused','maintenance','completed','abandoned','archived')$q$,
          false, true, '')))[1]::text end`));
  rows.push(row('45', 'esiehto', 'Avoimia idle in transaction -istuntoja (lukitsisivat migraation)',
    `(select count(*) from pg_stat_activity where datname = current_database()
        and state in ('idle in transaction', 'idle in transaction (aborted)') and pid <> pg_backend_pid())`));

  rows.push(row('50', 'turva', 'Public-tauluja ilman RLS:ää',
    "(select count(*) from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and not relrowsecurity)"));
  rows.push(row('51', 'turva', 'anon-roolin tauluoikeuksia',
    "(select count(*) from information_schema.role_table_grants where table_schema = 'public' and grantee = 'anon')"));
  rows.push(row('52', 'turva', 'PUBLIC-roolin tauluoikeuksia',
    `(select count(*) from pg_class c cross join lateral aclexplode(c.relacl) a
        where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and a.grantee = 0)`));

  rows.push(row('60', 'data', 'tasks.date tietotyyppi',
    "(select data_type from information_schema.columns where table_schema = 'public' and table_name = 'tasks' and column_name = 'date')"));
  rows.push(row('61', 'data', 'tasks.time tietotyyppi',
    "(select data_type from information_schema.columns where table_schema = 'public' and table_name = 'tasks' and column_name = 'time')"));
  rows.push(row('62', 'data', 'Tehtäviä, joilla kesto', `case when (select count(*) from information_schema.columns
        where table_schema = 'public' and table_name = 'tasks' and column_name = 'duration_minutes') = 0 then 'puuttuu'
        else (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.tasks where duration_minutes is not null', false, true, '')))[1]::text end`));
  let dn = 63;
  for (const table of ['tasks', 'profile', 'goals', 'projects', 'routines', 'routine_exceptions',
    'notification_preferences', 'wellbeing_entries', 'bills', 'recurring_expenses', 'savings_goals',
    'ai_action_audit', 'transactions', 'investments', 'milestones', 'inbox_items', 'reminders',
    'notices', 'travel_plans', 'location_rules', 'life_areas', 'weekly_capacities', 'time_entries',
    'alignment_reviews', 'running_timers', 'alignment_item_settings']) {
    rows.push(row(String(dn++), 'data', `rivejä: ${table}`, countIfExists(table)));
  }

  // RIVI 89: tehtäviä, joiden kesto on POSITIIVINEN (ACT-11).
  //
  // Rivi 62 laskee `duration_minutes is not null`. Jos tuotanto tallentaa
  // arvioimattoman keston nollana, rivi 62 liioittelee arvioituja
  // tehtäviä. Uusi rivi lisätään LOPPUUN eikä olemassa olevia numeroida
  // uudelleen: liitetyt vanhat inventaariot ja fixturet pysyvät
  // luettavina, ja pisteytys ei vaadi tätä riviä.
  if (dn !== 89) {
    throw new Error(`rivilaskuri on ${dn}, ei 89: uusi taulu törmäisi riviin 89 — numeroi rivitaulukko uudelleen harkiten`);
  }
  rows.push(row('89', 'data', 'Tehtäviä, joilla kesto > 0 (rivin 62 tarkennus)', `case when (select count(*) from information_schema.columns
        where table_schema = 'public' and table_name = 'tasks' and column_name = 'duration_minutes') = 0 then 'puuttuu'
        else (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.tasks where duration_minutes > 0', false, true, '')))[1]::text end`));

  // RIVIT 90–99: migraation 0014 taulujen rivimäärät. Loppuun, kuten rivi
  // 89: pisteytys ei vaadi niitä, joten 0014:ää edeltävä inventaario
  // pysyy kelvollisena. Taulu, jota ei ole, on 'puuttuu', ei nolla.
  let kn = DAILY_LIFE_FIRST_ROW;
  for (const table of DAILY_LIFE_TABLES) {
    rows.push(row(String(kn++), 'data', `rivejä: ${table}`, countIfExists(table)));
  }

  // RIVIT 31–33: migraation 0015 taulut ja päivättömät tehtävät.
  // Pisteytys ei vaadi niitä. Päivätön tehtävä on mahdollinen vasta 0015:n
  // jälkeen; ennen sitä sarake voi olla NOT NULL, joten luku on silloinkin
  // turvallinen (0).
  let ln = MENTAL_LOAD_FIRST_ROW;
  for (const table of MENTAL_LOAD_TABLES) {
    rows.push(row(String(ln++), 'data', `rivejä: ${table}`, countIfExists(table)));
  }
  rows.push(row(String(ln++), 'data', 'Päivättömiä tehtäviä (tasks.date is null, mahdollinen 0015:n jälkeen)',
    `case when to_regclass('public.tasks') is null then 'puuttuu'
              else (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.tasks where date is null', false, true, '')))[1]::text end`));

  const union = rows.join('\n  union all\n');
  const expected = Object.entries(EXPECTED).map(([k, v]) => `${k}=${v}`).join(' ');

  return `-- =====================================================================
-- Manifestival — aktivoinnin inventaario 0001–0015 (VAIN LUKU)
-- =====================================================================
--
-- GENEROITU: node tools/activation/build-inventory.mjs. ÄLÄ MUOKKAA
-- KÄSIN — testi vertaa tiedostoa generaattoriin.
--
-- Aja Supabase Dashboardissa: SQL Editor -> New query -> liitä -> Run.
-- YKSI lause, YKSI taulukko. Mitään ei luoda, muuteta eikä poisteta.
-- Ei käyttäjän sisältöä: vain rakenne, lukumäärät ja tilat.
--
-- MITÄ TEET TULOKSELLA
--
--   Kopioi RIVIN 00 solu "arvo" (yksi JSON-rivi) ja liitä se Claudelle.
--   Vaihtoehto: valitse koko tulostaulukko, kopioi ja liitä.
--   Claude ajaa: node tools/activation/score-inventory.mjs
--   ja kertoo seuraavan portin.
--
-- Migraatioiden tunnistuslistat on poimittu migraatioiden omista
-- esitarkistuksista, joten luku tarkoittaa samaa kuin migraation oma
-- viesti: 0 = ajamaton, täysi = ajettu, muu = kesken.
-- Täydet luvut: ${expected}
--   (0004: 37 jos routines on olemassa. 0012: 57 kun 0013 on ajettu,
--    koska 0013 korvaa rajoitteen time_entries_source_check, ja 56 kun
--    myös 0015 on ajettu, koska 0015 poistaa life_areas_category_unique.)

with rivit as (
${union}
)
select '00' as nro, 'tiiviste' as osio, 'KOPIOI TÄMÄ SOLU CLAUDELLE' as tarkistus,
       json_build_object('inventory', 'mv-activation-v1',
                         'rows', json_object_agg(r.nro, r.arvo order by r.nro))::text as arvo
  from rivit r
union all
select nro, osio, tarkistus, arvo from rivit
order by 1;
`;
}

if (process.argv[1] && process.argv[1].endsWith('build-inventory.mjs')) {
  const sql = buildInventorySql();
  const full = path.join(ROOT, OUT);
  if (process.argv.includes('--check')) {
    const onDisk = fs.existsSync(full) ? fs.readFileSync(full, 'utf8').replace(/\r\n/g, '\n') : '';
    if (onDisk !== sql) { console.error(`${OUT} ei vastaa generaattoria`); process.exit(1); }
    console.log(`${OUT}: ajan tasalla`);
  } else {
    fs.writeFileSync(full, sql);
    console.log(`kirjoitettu ${OUT}`);
  }
}
