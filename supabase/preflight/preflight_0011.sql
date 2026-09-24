-- Preflight: ENNEN migraatiota 0011_personal_assistant (aalto H)
-- VAIN LUKEVA. Yksi lause, yksi taulukko, yksi kopiointi.
--
-- GENEROITU: node tools/activation/build-preflights.mjs. ÄLÄ MUOKKAA
-- KÄSIN — testi vertaa tiedostoa generaattoriin.
--
-- MILLOIN: juuri ennen kuin 0011 ajetaan, samassa SQL-editorin
-- välilehdessä ja ilman muita avoimia välilehtiä.
--
-- ODOTUS: jokaisen PASS/FAIL-rivin status = 'PASS' ja
-- poikkeavia_yhteensa = 0. INFO-rivit ovat kirjattavia lukuja.
--
-- YKSIKIN FAIL = MIGRAATIOTA 0011 EI AJETA.
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
         'Edellinen migraatio 0010 on ajettu kokonaan (38 objektia)'::text as check_name, '38'::text as odotus,
         (select count(*)::text from (
           select 1 from pg_tables
           where schemaname = 'public' and tablename = 'milestones'
           union all
           select 1 from information_schema.columns
           where table_schema = 'public' and table_name = 'goals'
           and column_name in ('metric', 'unit', 'baseline_value', 'current_value',
           'target_value', 'measured_on', 'savings_goal_id')
           union all
           select 1 from information_schema.columns
           where table_schema = 'public' and table_name = 'tasks'
           and column_name in ('milestone_id', 'depends_on')
           union all
           select 1 from information_schema.columns
           where table_schema = 'public' and table_name = 'projects'
           and column_name in ('milestone_id')
           union all
           select 1 from information_schema.columns
           where table_schema = 'public' and table_name = 'profile'
           and column_name in ('automation_level', 'planning_buffer_ratio')
           union all
           select 1 from pg_constraint
           where conname in ('milestones_status_check',
           'milestones_rule_check',
           'milestones_title_check',
           'milestones_reached_date_check',
           'milestones_order_check',
           'milestones_description_length_check',
           'milestones_goal_fkey',
           'milestones_owner_row_key',
           'goals_metric_pair_check',
           'goals_savings_exclusive_check',
           'goals_metric_length_check',
           'goals_unit_length_check',
           'tasks_depends_on_length_check',
           'tasks_depends_on_no_self_check',
           'tasks_milestone_fkey',
           'projects_milestone_fkey',
           'profile_automation_level_check',
           'profile_buffer_ratio_check')
           union all
           select 1 from pg_indexes
           where schemaname = 'public'
           and indexname in ('milestones_user_goal_idx', 'milestones_user_target_idx')
           union all
           select 1 from pg_trigger
           where not tgisinternal and tgname = 'milestones_touch_updated_at'
           union all
           select 1 from pg_policies
           where schemaname = 'public' and tablename = 'milestones'
           ) kaikki) as toteutui

  union all
  select '07'::text as check_no, '0011'::text as section,
         'tasks_owner_row_key on olemassa (matka- ja sijaintiviitteet)'::text as check_name, '1'::text as odotus,
         (select count(*)::text from pg_constraint where conname = 'tasks_owner_row_key') as toteutui

  union all
  select '08'::text as check_no, '0011'::text as section,
         'Migraation 0011 objekteja ei vielä ole (0/72)'::text as check_name, '0'::text as odotus,
         (select count(*)::text from (
           select 1 from pg_tables
           where schemaname = 'public'
           and tablename in ('inbox_items', 'reminders', 'notices',
           'travel_plans', 'location_rules')
           union all
           select 1 from pg_constraint
           where conname in (
           'inbox_items_status_check', 'inbox_items_source_check',
           'inbox_items_text_check', 'inbox_items_converted_check',
           'inbox_items_owner_row_key',
           'reminders_status_check', 'reminders_target_check',
           'reminders_trigger_check', 'reminders_title_check',
           'reminders_target_pair_check', 'reminders_alert_count_check',
           'reminders_snooze_count_check', 'reminders_lead_check',
           'reminders_owner_row_key',
           'notices_kind_check', 'notices_level_check', 'notices_status_check',
           'notices_title_check', 'notices_target_pair_check',
           'notices_owner_row_key', 'notices_key_unique',
           'travel_plans_mode_check', 'travel_plans_source_check',
           'travel_plans_title_check', 'travel_plans_minutes_check',
           'travel_plans_buffer_check', 'travel_plans_unknown_source_check',
           'travel_plans_owner_row_key', 'travel_plans_task_fkey',
           'location_rules_trigger_check', 'location_rules_place_check',
           'location_rules_owner_row_key', 'location_rules_task_fkey')
           union all
           select 1 from pg_indexes
           where schemaname = 'public'
           and indexname in (
           'inbox_items_user_status_idx', 'inbox_items_user_captured_idx',
           'reminders_user_due_idx', 'reminders_user_status_idx',
           'reminders_user_target_idx',
           'notices_user_status_idx', 'notices_user_created_idx',
           'travel_plans_user_arrival_idx', 'location_rules_user_active_idx')
           union all
           select 1 from pg_trigger
           where not tgisinternal
           and tgname in ('inbox_items_touch_updated_at', 'reminders_touch_updated_at',
           'notices_touch_updated_at', 'travel_plans_touch_updated_at',
           'location_rules_touch_updated_at')
           union all
           select 1 from pg_policies
           where schemaname = 'public'
           and tablename in ('inbox_items', 'reminders', 'notices',
           'travel_plans', 'location_rules')
           ) kaikki) as toteutui

  union all
  select '09'::text as check_no, 'esteet'::text as section,
         'Avoimia idle in transaction -istuntoja ei ole'::text as check_name, '0'::text as odotus,
         (select count(*)::text from pg_stat_activity where datname = current_database()
             and state in ('idle in transaction', 'idle in transaction (aborted)') and pid <> pg_backend_pid()) as toteutui

  union all
  select '10'::text as check_no, 'esteet'::text as section,
         'Yli minuutin kestäneitä kyselyitä ei ole käynnissä'::text as check_name, '0'::text as odotus,
         (select count(*)::text from pg_stat_activity where datname = current_database() and state = 'active'
             and pid <> pg_backend_pid() and now() - query_start > interval '1 minute') as toteutui

  union all
  select '11'::text as check_no, 'esteet'::text as section,
         'Odottavia lukkoja ei ole'::text as check_name, '0'::text as odotus,
         (select count(*)::text from pg_locks where not granted and pid <> pg_backend_pid()) as toteutui

  union all
  select '12'::text as check_no, 'kirjattavat'::text as section,
         'Tehtävien lukumäärä'::text as check_name, 'INFO'::text as odotus,
         (select count(*)::text from public.tasks) as toteutui

  union all
  select '13'::text as check_no, 'kirjattavat'::text as section,
         'Tietokanta'::text as check_name, 'INFO'::text as odotus,
         current_database() as toteutui

  union all
  select '14'::text as check_no, 'kirjattavat'::text as section,
         'Palvelimen versio'::text as check_name, 'INFO'::text as odotus,
         current_setting('server_version') as toteutui

  union all
  select '15'::text as check_no, 'kirjattavat'::text as section,
         'Tarkistuksen hetki (UTC)'::text as check_name, 'INFO'::text as odotus,
         to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS') as toteutui
) c
order by c.check_no;
