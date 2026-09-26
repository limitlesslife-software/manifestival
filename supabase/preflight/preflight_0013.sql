-- Preflight: ENNEN migraatiota 0013_alignment_reality (aalto J)
-- VAIN LUKEVA. Yksi lause, yksi taulukko, yksi kopiointi.
--
-- GENEROITU: node tools/activation/build-preflights.mjs. ÄLÄ MUOKKAA
-- KÄSIN — testi vertaa tiedostoa generaattoriin.
--
-- MILLOIN: juuri ennen kuin 0013 ajetaan, samassa SQL-editorin
-- välilehdessä ja ilman muita avoimia välilehtiä.
--
-- ODOTUS: jokaisen PASS/FAIL-rivin status = 'PASS' ja
-- poikkeavia_yhteensa = 0. INFO-rivit ovat kirjattavia lukuja.
--
-- YKSIKIN FAIL = MIGRAATIOTA 0013 EI AJETA.
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
  select '01'::text as check_no, '0001'::text as section,
         'Omistajasarake tasks.user_id on olemassa'::text as check_name, '1'::text as odotus,
         (select count(*)::text from information_schema.columns where table_schema = 'public' and table_name = 'tasks' and column_name = 'user_id') as toteutui

  union all
  select '02'::text as check_no, '0001'::text as section,
         'RLS on päällä taulussa tasks'::text as check_name, '1'::text as odotus,
         (select count(*)::text from pg_class where relnamespace = 'public'::regnamespace and relname = 'tasks' and relrowsecurity) as toteutui

  union all
  select '03'::text as check_no, 'esiehto'::text as section,
         'Hyväksytty omistaja löytyy auth.users-taulusta'::text as check_name, '1'::text as odotus,
         (select count(*)::text from auth.users where id = '2cc00622-f927-4604-a518-361a4328481b'::uuid) as toteutui

  union all
  select '04'::text as check_no, 'esiehto'::text as section,
         'PostgreSQL 15 tai uudempi'::text as check_name, 'true'::text as odotus,
         (current_setting('server_version_num')::int >= 150000)::text as toteutui

  union all
  select '05'::text as check_no, 'esiehto'::text as section,
         'touch_updated_at on INVOKER ja search_path kiinnitetty'::text as check_name, '1'::text as odotus,
         (select count(*)::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'touch_updated_at' and not p.prosecdef
             and exists (select 1 from unnest(p.proconfig) a where a like 'search\_path=%')) as toteutui

  union all
  select '06'::text as check_no, 'järjestys'::text as section,
         'Edellinen migraatio 0012 on ajettu kokonaan (58 objektia)'::text as check_name, '58'::text as odotus,
         (select count(*)::text from (
           select 1 from pg_tables
           where schemaname = 'public'
           and tablename in ('life_areas', 'weekly_capacities', 'time_entries',
           'alignment_reviews')
           union all
           select 1 from information_schema.columns
           where table_schema = 'public' and table_name = 'goals'
           and column_name = 'life_area_id'
           union all
           select 1 from pg_constraint
           where conname in (
           'life_areas_name_check', 'life_areas_description_check',
           'life_areas_importance_check', 'life_areas_target_check',
           'life_areas_category_check', 'life_areas_sort_order_check',
           'life_areas_owner_row_key', 'life_areas_name_unique',
           'life_areas_category_unique',
           'weekly_capacities_week_start_check', 'weekly_capacities_minutes_check',
           'weekly_capacities_energy_check', 'weekly_capacities_note_check',
           'weekly_capacities_owner_row_key', 'weekly_capacities_week_unique',
           'time_entries_minutes_check', 'time_entries_source_check',
           'time_entries_note_check', 'time_entries_owner_row_key',
           'time_entries_life_area_fkey', 'time_entries_goal_fkey',
           'time_entries_task_fkey',
           'alignment_reviews_week_start_check', 'alignment_reviews_version_check',
           'alignment_reviews_snapshot_check', 'alignment_reviews_reflection_check',
           'alignment_reviews_adjustments_check', 'alignment_reviews_owner_row_key',
           'alignment_reviews_week_unique',
           'goals_life_area_fkey')
           union all
           select 1 from pg_indexes
           where schemaname = 'public'
           and indexname in ('life_areas_user_active_idx', 'time_entries_user_date_idx',
           'goals_user_life_area_idx')
           union all
           select 1 from pg_trigger
           where not tgisinternal
           and tgname in ('life_areas_touch_updated_at', 'weekly_capacities_touch_updated_at',
           'time_entries_touch_updated_at', 'alignment_reviews_touch_updated_at')
           union all
           select 1 from pg_policies
           where schemaname = 'public'
           and tablename in ('life_areas', 'weekly_capacities', 'time_entries',
           'alignment_reviews')
           ) kaikki) as toteutui

  union all
  select '07'::text as check_no, '0013'::text as section,
         '0012:n alkuperäinen lähderajoite on olemassa (korvataan)'::text as check_name, '1'::text as odotus,
         (select count(*)::text from pg_constraint where conname = 'time_entries_source_check') as toteutui

  union all
  select '08'::text as check_no, '0013'::text as section,
         'Omistajan rivin avaimet life_areas, goals, tasks, projects, routines'::text as check_name, '5'::text as odotus,
         (select count(*)::text from pg_constraint where contype = 'u' and conname in ('life_areas_owner_row_key', 'goals_owner_row_key', 'tasks_owner_row_key', 'projects_owner_row_key', 'routines_owner_row_key')) as toteutui

  union all
  select '09'::text as check_no, 'kirjattavat'::text as section,
         'Kirjattuja aikoja (saavat 6 nullable-saraketta)'::text as check_name, 'INFO'::text as odotus,
         (select case when to_regclass('public.time_entries') is null then 'puuttuu' else (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.time_entries', false, true, '')))[1]::text end) as toteutui

  union all
  select '10'::text as check_no, '0013'::text as section,
         'tasks, goals, projects, routines, life_areas, weekly_capacities, time_entries, alignment_reviews: 32 politiikkaa (0013 vaatii ennen committia)'::text as check_name, '32'::text as odotus,
         (select count(*)::text from pg_policies where schemaname = 'public' and tablename in ('tasks', 'goals', 'projects', 'routines', 'life_areas', 'weekly_capacities', 'time_entries', 'alignment_reviews')) as toteutui

  union all
  select '11'::text as check_no, '0013'::text as section,
         'Migraation 0013 objekteja ei vielä ole (0/46)'::text as check_name, '0'::text as odotus,
         (select count(*)::text from (
           select 1 from pg_tables
           where schemaname = 'public'
           and tablename in ('running_timers', 'alignment_item_settings')
           union all
           select 1 from information_schema.columns
           where table_schema = 'public'
           and ((table_name = 'time_entries'
           and column_name in ('project_id', 'routine_id', 'occurrence_date',
           'operation_id', 'started_at', 'ended_at'))
           or (table_name = 'weekly_capacities' and column_name = 'energy_budget_minutes')
           or (table_name = 'alignment_reviews'
           and column_name in ('policy_version', 'reflection_answers')))
           union all
           select 1 from pg_constraint
           where conname in (
           'time_entries_source_v2_check', 'time_entries_operation_check',
           'time_entries_operation_unique', 'time_entries_project_fkey',
           'time_entries_routine_fkey', 'time_entries_span_check',
           'weekly_capacities_energy_budget_check',
           'alignment_reviews_policy_version_check', 'alignment_reviews_reflection_answers_check',
           'running_timers_target_kind_check', 'running_timers_paused_check',
           'running_timers_note_check', 'running_timers_owner_row_key',
           'running_timers_one_per_user', 'running_timers_life_area_fkey',
           'running_timers_goal_fkey', 'running_timers_task_fkey',
           'running_timers_project_fkey', 'running_timers_routine_fkey',
           'alignment_item_settings_kind_check', 'alignment_item_settings_item_id_check',
           'alignment_item_settings_energy_check', 'alignment_item_settings_owner_row_key',
           'alignment_item_settings_item_unique')
           union all
           select 1 from pg_indexes
           where schemaname = 'public'
           and indexname in ('time_entries_user_routine_idx')
           union all
           select 1 from pg_trigger
           where not tgisinternal
           and tgname in ('running_timers_touch_updated_at',
           'alignment_item_settings_touch_updated_at')
           union all
           select 1 from pg_policies
           where schemaname = 'public'
           and tablename in ('running_timers', 'alignment_item_settings')
           ) kaikki) as toteutui

  union all
  select '12'::text as check_no, 'esteet'::text as section,
         'Avoimia idle in transaction -istuntoja ei ole'::text as check_name, '0'::text as odotus,
         (select count(*)::text from pg_stat_activity where datname = current_database()
             and state in ('idle in transaction', 'idle in transaction (aborted)') and pid <> pg_backend_pid()) as toteutui

  union all
  select '13'::text as check_no, 'esteet'::text as section,
         'Yli minuutin kestäneitä kyselyitä ei ole käynnissä'::text as check_name, '0'::text as odotus,
         (select count(*)::text from pg_stat_activity where datname = current_database() and state = 'active'
             and pid <> pg_backend_pid() and now() - query_start > interval '1 minute') as toteutui

  union all
  select '14'::text as check_no, 'esteet'::text as section,
         'Odottavia lukkoja ei ole'::text as check_name, '0'::text as odotus,
         (select count(*)::text from pg_locks l where not l.granted and l.pid <> pg_backend_pid()
             and l.pid in (select a.pid from pg_stat_activity a where a.datname = current_database())) as toteutui

  union all
  select '15'::text as check_no, 'esteet'::text as section,
         'Muut istunnot eivät lukitse tauluja, joita 0013 muuttaa tai joihin se viittaa (public.time_entries, public.weekly_capacities, public.alignment_reviews, public.goals, public.tasks, public.projects, public.routines, public.life_areas, auth.users)'::text as check_name, '0'::text as odotus,
         (select count(*)::text from pg_locks l where l.locktype = 'relation' and l.pid <> pg_backend_pid()
             and l.database = (select oid from pg_database where datname = current_database())
             and l.relation in (to_regclass('public.time_entries'), to_regclass('public.weekly_capacities'), to_regclass('public.alignment_reviews'), to_regclass('public.goals'), to_regclass('public.tasks'), to_regclass('public.projects'), to_regclass('public.routines'), to_regclass('public.life_areas'), to_regclass('auth.users'))) as toteutui

  union all
  select '16'::text as check_no, 'kirjattavat'::text as section,
         'Tehtävien lukumäärä'::text as check_name, 'INFO'::text as odotus,
         (select count(*)::text from public.tasks) as toteutui

  union all
  select '17'::text as check_no, 'kirjattavat'::text as section,
         'Tietokanta'::text as check_name, 'INFO'::text as odotus,
         current_database() as toteutui

  union all
  select '18'::text as check_no, 'kirjattavat'::text as section,
         'Palvelimen versio'::text as check_name, 'INFO'::text as odotus,
         current_setting('server_version') as toteutui

  union all
  select '19'::text as check_no, 'kirjattavat'::text as section,
         'Tarkistuksen hetki (UTC)'::text as check_name, 'INFO'::text as odotus,
         to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS') as toteutui
) c
order by c.check_no;
