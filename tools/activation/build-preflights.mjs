// Generoi supabase/preflight/preflight_0009.sql ... preflight_0013.sql.
//
//   node tools/activation/build-preflights.mjs          kirjoita tiedostot
//   node tools/activation/build-preflights.mjs --check  vertaa levyyn (testit)
//
// Jokainen esitarkistus on VAIN LUKEVA yksi SELECT (Supabasen editori
// näyttää vain viimeisen tuloksen), samaa muotoa kuin preflight_0003–0008:
// check_no, section, check_name, status (PASS/FAIL/INFO), details,
// poikkeavia_yhteensa. Odotus: 0 FAIL.
//
// MIKSI GENEROIDAAN: "migraation objekteja on 0" on luotettava vain, jos
// se laskee täsmälleen samat objektit kuin migraation oma esitarkistus.
// Lista poimitaan migraatiosta itsestään, kuten inventaariossa.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXPECTED } from './build-inventory.mjs';
import { MIGRATION_WAVE, TRAIN_MIGRATIONS, WAVES } from '../release/waves.mjs';
import { ACCOUNT_DATA_MAP } from '../../src/domain/accountLifecycle.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OWNER = '2cc00622-f927-4604-a518-361a4328481b';

// Migraatio -> tiedosto ja migraatio -> aalto luetaan waves.mjs:stä
// (ACT-12), ei kopioida käsin. 0008 on junaa edeltävä migraatio, jonka
// esitarkistus 0009 tarvitsee "edellinen ajettu" -rivinä.
const FILES = Object.freeze({
  '0008': '0008_ai_audit.sql',
  ...Object.fromEntries(WAVES.filter(w => w.migration)
    .map(w => [w.migration, path.posix.basename(w.migrationFile)]))
});

const WAVE = MIGRATION_WAVE;

function detection(number) {
  const src = fs.readFileSync(path.join(ROOT, 'supabase/migrations', FILES[number]), 'utf8').replace(/\r\n/g, '\n');
  const m = /select count\(\*\) into olemassa from \(\n([\s\S]*?)\n\s*\) kaikki;/.exec(src);
  if (!m) throw new Error(`${number}: tunnistuslohkoa ei löytynyt`);
  return m[1].replace(/'(public\.\w+)'::regclass/g, "to_regclass('$1')")
    .split('\n').map(line => '           ' + line.trim()).join('\n');
}

const count = sql => `(select count(*)::text from (\n${sql}\n           ) kaikki)`;

/** Migraatiokohtaiset lisätarkistukset: [osio, nimi, odotus, arvo-SQL]. */
const SPECIFIC = Object.freeze({
  '0009': [
    ['0009', 'bills-taulu on olemassa (0007)', '1', "(select count(*)::text from pg_tables where schemaname = 'public' and tablename = 'bills')"],
    ['0009', 'bills: maksutietosarakkeita ei vielä ole', '0',
      "(select count(*)::text from information_schema.columns where table_schema = 'public' and table_name = 'bills' and column_name in ('payee', 'iban', 'reference'))"]
  ],
  '0010': [
    ['0010', 'Omistajan rivin avaimet goals, projects, tasks', '3',
      "(select count(*)::text from pg_constraint where contype = 'u' and conname in ('goals_owner_row_key', 'projects_owner_row_key', 'tasks_owner_row_key'))"],
    ['0010', 'Jokainen tavoitteen tila kelpaa uudelle goals_status_check-rajoitteelle', '0',
      "(select count(*)::text from public.goals where status not in ('active', 'paused', 'maintenance', 'completed', 'abandoned', 'archived'))"],
    ['0010', 'goals_status_check on olemassa (korvataan)', '1', "(select count(*)::text from pg_constraint where conname = 'goals_status_check')"],
    ['0010', 'profile-taulu on olemassa (saa kaksi saraketta)', '1', "(select count(*)::text from pg_tables where schemaname = 'public' and tablename = 'profile')"],
    ['kirjattavat', 'Tavoitteita (muutetaan: 7 saraketta + rajoite)', 'INFO', '(select count(*)::text from public.goals)'],
    ['kirjattavat', 'Projekteja (muutetaan: 1 sarake)', 'INFO', '(select count(*)::text from public.projects)'],
    ['kirjattavat', 'Profiileja (muutetaan: 2 saraketta)', 'INFO', '(select count(*)::text from public.profile)']
  ],
  '0011': [
    ['0011', 'tasks_owner_row_key on olemassa (matka- ja sijaintiviitteet)', '1',
      "(select count(*)::text from pg_constraint where conname = 'tasks_owner_row_key')"],
    ['0011', 'tasks/goals/projects: 12 politiikkaa (0011 vaatii ennen committia)', '12', policyCount(['tasks', 'goals', 'projects'])]
  ],
  '0012': [
    ['0012', 'Omistajan rivin avaimet goals ja tasks', '2',
      "(select count(*)::text from pg_constraint where contype = 'u' and conname in ('goals_owner_row_key', 'tasks_owner_row_key'))"],
    ['0012', 'goals.life_area_id -saraketta ei vielä ole', '0',
      "(select count(*)::text from information_schema.columns where table_schema = 'public' and table_name = 'goals' and column_name = 'life_area_id')"],
    ['kirjattavat', 'Tavoitteita (saavat nullable-sarakkeen, ei täyttöä)', 'INFO', '(select count(*)::text from public.goals)'],
    ['0012', 'tasks/goals/projects: 12 politiikkaa (0012 vaatii ennen committia)', '12', policyCount(['tasks', 'goals', 'projects'])]
  ],
  '0013': [
    ['0013', '0012:n alkuperäinen lähderajoite on olemassa (korvataan)', '1',
      "(select count(*)::text from pg_constraint where conname = 'time_entries_source_check')"],
    ['0013', 'Omistajan rivin avaimet life_areas, goals, tasks, projects, routines', '5',
      "(select count(*)::text from pg_constraint where contype = 'u' and conname in ('life_areas_owner_row_key', 'goals_owner_row_key', 'tasks_owner_row_key', 'projects_owner_row_key', 'routines_owner_row_key'))"],
    ['kirjattavat', 'Kirjattuja aikoja (saavat 6 nullable-saraketta)', 'INFO',
      "(select case when to_regclass('public.time_entries') is null then 'puuttuu' else (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.time_entries', false, true, '')))[1]::text end)"],
    ['0013', 'tasks, goals, projects, routines, life_areas, weekly_capacities, time_entries, alignment_reviews: 32 politiikkaa (0013 vaatii ennen committia)', '32',
      policyCount(['tasks', 'goals', 'projects', 'routines', 'life_areas', 'weekly_capacities', 'time_entries', 'alignment_reviews'])]
  ]
});

/** Politiikkojen määrä tauluissa — sama joukko kuin migraation oma invariantti. */
function policyCount(tables) {
  return `(select count(*)::text from pg_policies where schemaname = 'public' and tablename in (${tables.map(t => `'${t}'`).join(', ')}))`;
}

/**
 * Taulut, jotka migraatio lukitsee: ALTER TABLE (ACCESS EXCLUSIVE) tai
 * vierasavaimen kohde (SHARE ROW EXCLUSIVE). auth.users kaikissa, koska
 * jokainen uusi taulu viittaa siihen. Muun istunnon lukko näissä =
 * migraatio odottaa lock_timeoutin (5 s) ja peruuntuu.
 */
export const LOCKED_TABLES = Object.freeze({
  '0009': Object.freeze(['public.bills', 'auth.users']),
  '0010': Object.freeze(['public.goals', 'public.projects', 'public.tasks', 'public.profile', 'auth.users']),
  '0011': Object.freeze(['public.tasks', 'auth.users']),
  '0012': Object.freeze(['public.goals', 'public.tasks', 'auth.users']),
  '0013': Object.freeze(['public.time_entries', 'public.weekly_capacities', 'public.alignment_reviews', 'public.goals',
    'public.tasks', 'public.projects', 'public.routines', 'public.life_areas', 'auth.users'])
});

function previous(number) {
  return String(Number(number) - 1).padStart(4, '0');
}

/**
 * Migraatioiden 0001–0013 taulut = tilin poiston kartta (ACCOUNT_DATA_MAP).
 * verify_0013:n rivit 26–28 käyttävät samaa listaa (testi vertaa).
 */
export const MIGRATION_TABLES = Object.freeze(Object.values(ACCOUNT_DATA_MAP).map(entry => entry.table));

/**
 * Junan alussa (vain preflight_0009, rivien loppuun): oletukset, joihin
 * verify_0013:n tilin poiston rivit 26–28 nojaavat, tarkistetaan ENNEN
 * ensimmäistä migraatiota eikä vasta viimeisen jälkeen.
 */
const TRAIN_START = Object.freeze({
  '0009': [
    ['junan alku', 'Muut public-taulut kuin migraatioiden 0001–0013 (lukumäärä ja nimet, verify_0013 rivi 28)', 'INFO',
      `(select count(*)::text || coalesce(': ' || string_agg(c.relname::text, ', ' order by c.relname), '')
           from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
             and c.relname not in (${MIGRATION_TABLES.map(t => `'${t}'`).join(', ')}))`],
    ['junan alku', 'Jokainen public-taulun vierasavain auth.usersiin on CASCADE (tilin poisto, verify_0013 rivit 26–27)', '0',
      `(select count(*)::text from pg_constraint f where f.contype = 'f' and f.confrelid = 'auth.users'::regclass
             and f.connamespace = 'public'::regnamespace and f.confdeltype <> 'c')`]
  ]
});

export function buildPreflight(number) {
  const prev = previous(number);
  const rows = [];
  let n = 1;
  const add = (section, name, expected, valueSql) => {
    const no = String(n++).padStart(2, '0');
    rows.push(`  select '${no}'::text as check_no, '${section}'::text as section,\n         '${name.replace(/'/g, "''")}'::text as check_name, '${expected}'::text as odotus,\n         ${valueSql} as toteutui`);
  };

  add('0001', 'Omistajasarake tasks.user_id on olemassa', '1',
    "(select count(*)::text from information_schema.columns where table_schema = 'public' and table_name = 'tasks' and column_name = 'user_id')");
  add('0001', 'RLS on päällä taulussa tasks', '1',
    "(select count(*)::text from pg_class where relnamespace = 'public'::regnamespace and relname = 'tasks' and relrowsecurity)");
  add('esiehto', 'Hyväksytty omistaja löytyy auth.users-taulusta', '1',
    `(select count(*)::text from auth.users where id = '${OWNER}'::uuid)`);
  add('esiehto', 'PostgreSQL 15 tai uudempi', 'true',
    "(current_setting('server_version_num')::int >= 150000)::text");
  add('esiehto', 'touch_updated_at on INVOKER ja search_path kiinnitetty', '1',
    `(select count(*)::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'touch_updated_at' and not p.prosecdef
             and exists (select 1 from unnest(p.proconfig) a where a like 'search\\_path=%'))`);
  add('järjestys', `Edellinen migraatio ${prev} on ajettu kokonaan (${EXPECTED[prev]} objektia)`, String(EXPECTED[prev]).split('|').pop(),
    count(detection(prev)));
  for (const [section, name, expected, sql] of SPECIFIC[number]) add(section, name, expected, sql);
  add(number, `Migraation ${number} objekteja ei vielä ole (0/${EXPECTED[number]})`, '0', count(detection(number)));
  add('esteet', 'Avoimia idle in transaction -istuntoja ei ole', '0',
    `(select count(*)::text from pg_stat_activity where datname = current_database()
             and state in ('idle in transaction', 'idle in transaction (aborted)') and pid <> pg_backend_pid())`);
  add('esteet', 'Yli minuutin kestäneitä kyselyitä ei ole käynnissä', '0',
    `(select count(*)::text from pg_stat_activity where datname = current_database() and state = 'active'
             and pid <> pg_backend_pid() and now() - query_start > interval '1 minute')`);
  add('esteet', 'Odottavia lukkoja ei ole', '0',
    `(select count(*)::text from pg_locks l where not l.granted and l.pid <> pg_backend_pid()
             and l.pid in (select a.pid from pg_stat_activity a where a.datname = current_database()))`);
  // pg_locks näkyy kaikille rooleille (toisin kuin pg_stat_activityn tila
  // ilman pg_read_all_stats-oikeutta), joten tämä rivi havaitsee esteen
  // myös silloin, kun idle in transaction -rivi ei näe muiden istuntoja.
  add('esteet', `Muut istunnot eivät lukitse tauluja, joita ${number} muuttaa tai joihin se viittaa (${LOCKED_TABLES[number].join(', ')})`, '0',
    `(select count(*)::text from pg_locks l where l.locktype = 'relation' and l.pid <> pg_backend_pid()
             and l.database = (select oid from pg_database where datname = current_database())
             and l.relation in (${LOCKED_TABLES[number].map(t => `to_regclass('${t}')`).join(', ')}))`);
  add('kirjattavat', 'Tehtävien lukumäärä', 'INFO', '(select count(*)::text from public.tasks)');
  add('kirjattavat', 'Tietokanta', 'INFO', 'current_database()');
  add('kirjattavat', 'Palvelimen versio', 'INFO', "current_setting('server_version')");
  add('kirjattavat', 'Tarkistuksen hetki (UTC)', 'INFO', "to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS')");
  for (const [section, name, expected, sql] of TRAIN_START[number] || []) add(section, name, expected, sql);

  return `-- Preflight: ENNEN migraatiota ${FILES[number].replace('.sql', '')} (aalto ${WAVE[number]})
-- VAIN LUKEVA. Yksi lause, yksi taulukko, yksi kopiointi.
--
-- GENEROITU: node tools/activation/build-preflights.mjs. ÄLÄ MUOKKAA
-- KÄSIN — testi vertaa tiedostoa generaattoriin.
--
-- MILLOIN: juuri ennen kuin ${number} ajetaan, samassa SQL-editorin
-- välilehdessä ja ilman muita avoimia välilehtiä.
--
-- ODOTUS: jokaisen PASS/FAIL-rivin status = 'PASS' ja
-- poikkeavia_yhteensa = 0. INFO-rivit ovat kirjattavia lukuja.
--
-- YKSIKIN FAIL = MIGRAATIOTA ${number} EI AJETA.
--
-- Objektilistat on poimittu migraatioiden omista esitarkistuksista:
-- "0 objektia" tarkoittaa samaa kuin migraation oma tarkistus.
-- Harjoiteltu oikealla PostgreSQL 17:llä: tools/pg-rehearsal.
--
-- Tämä tiedosto EI lue käyttäjän sisältöä.

select c.check_no, c.section, c.check_name,
       case when c.odotus = 'INFO' then 'INFO'
            when c.toteutui = c.odotus then 'PASS' else 'FAIL' end as status,
       case when c.odotus = 'INFO' then c.toteutui
            else 'odotus ' || c.odotus || ', toteutui ' || coalesce(c.toteutui, 'null') end as details,
       count(*) filter (where c.odotus <> 'INFO' and c.toteutui is distinct from c.odotus)
         over () as poikkeavia_yhteensa
from (
${rows.join('\n\n  union all\n')}
) c
order by c.check_no;
`;
}

export const PREFLIGHT_NUMBERS = TRAIN_MIGRATIONS;

if (process.argv[1] && process.argv[1].endsWith('build-preflights.mjs')) {
  let stale = 0;
  for (const number of PREFLIGHT_NUMBERS) {
    const rel = `supabase/preflight/preflight_${number}.sql`;
    const sql = buildPreflight(number);
    const full = path.join(ROOT, rel);
    if (process.argv.includes('--check')) {
      const onDisk = fs.existsSync(full) ? fs.readFileSync(full, 'utf8').replace(/\r\n/g, '\n') : '';
      if (onDisk !== sql) { console.error(`${rel} ei vastaa generaattoria`); stale++; }
    } else {
      fs.writeFileSync(full, sql);
      console.log(`kirjoitettu ${rel}`);
    }
  }
  if (stale) process.exit(1);
}
