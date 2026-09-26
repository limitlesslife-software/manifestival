-- Preflight: ENNEN migraatiota 0010_goal_to_action (aalto G)
-- VAIN LUKEVA. Yksi lause, yksi taulukko, yksi kopiointi.
--
-- GENEROITU: node tools/activation/build-preflights.mjs. ÄLÄ MUOKKAA
-- KÄSIN — testi vertaa tiedostoa generaattoriin.
--
-- MILLOIN: juuri ennen kuin 0010 ajetaan, samassa SQL-editorin
-- välilehdessä ja ilman muita avoimia välilehtiä.
--
-- ODOTUS: jokaisen PASS/FAIL-rivin status = 'PASS' ja
-- poikkeavia_yhteensa = 0. INFO-rivit ovat kirjattavia lukuja.
--
-- YKSIKIN FAIL = MIGRAATIOTA 0010 EI AJETA.
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
         'Edellinen migraatio 0009 on ajettu kokonaan (39 objektia)'::text as check_name, '39'::text as odotus,
         (select count(*)::text from (
           select 1 from pg_tables
           where schemaname = 'public'
           and tablename in ('transactions', 'investments')
           union all
           select 1 from information_schema.columns
           where table_schema = 'public' and table_name = 'bills'
           and column_name in ('payee', 'iban', 'reference')
           union all
           select 1 from pg_constraint
           where conname in ('transactions_kind_check',
           'transactions_origin_check',
           'transactions_amount_check',
           'transactions_currency_check',
           'transactions_source_pair_check',
           'transactions_source_kind_check',
           'transactions_transfer_category_check',
           'transactions_description_length_check',
           'transactions_note_length_check',
           'transactions_owner_row_key',
           'investments_kind_check',
           'investments_value_source_check',
           'investments_quantity_check',
           'investments_amounts_check',
           'investments_currency_check',
           'investments_name_check',
           'investments_unknown_value_check',
           'investments_owner_row_key',
           'bills_payee_length_check',
           'bills_iban_check',
           'bills_reference_check')
           union all
           select 1 from pg_indexes
           where schemaname = 'public'
           and indexname in ('transactions_user_date_idx',
           'transactions_user_source_idx',
           'investments_user_name_idx')
           union all
           select 1 from pg_trigger
           where not tgisinternal
           and tgname in ('transactions_touch_updated_at',
           'investments_touch_updated_at')
           union all
           select 1 from pg_policies
           where schemaname = 'public'
           and tablename in ('transactions', 'investments')
           ) kaikki) as toteutui

  union all
  select '07'::text as check_no, '0010'::text as section,
         'Omistajan rivin avaimet goals, projects, tasks'::text as check_name, '3'::text as odotus,
         (select count(*)::text from pg_constraint where contype = 'u' and conname in ('goals_owner_row_key', 'projects_owner_row_key', 'tasks_owner_row_key')) as toteutui

  union all
  select '08'::text as check_no, '0010'::text as section,
         'Jokainen tavoitteen tila kelpaa uudelle goals_status_check-rajoitteelle'::text as check_name, '0'::text as odotus,
         (select count(*)::text from public.goals where status not in ('active', 'paused', 'maintenance', 'completed', 'abandoned', 'archived')) as toteutui

  union all
  select '09'::text as check_no, '0010'::text as section,
         'goals_status_check on olemassa (korvataan)'::text as check_name, '1'::text as odotus,
         (select count(*)::text from pg_constraint where conname = 'goals_status_check') as toteutui

  union all
  select '10'::text as check_no, '0010'::text as section,
         'profile-taulu on olemassa (saa kaksi saraketta)'::text as check_name, '1'::text as odotus,
         (select count(*)::text from pg_tables where schemaname = 'public' and tablename = 'profile') as toteutui

  union all
  select '11'::text as check_no, 'kirjattavat'::text as section,
         'Tavoitteita (muutetaan: 7 saraketta + rajoite)'::text as check_name, 'INFO'::text as odotus,
         (select count(*)::text from public.goals) as toteutui

  union all
  select '12'::text as check_no, 'kirjattavat'::text as section,
         'Projekteja (muutetaan: 1 sarake)'::text as check_name, 'INFO'::text as odotus,
         (select count(*)::text from public.projects) as toteutui

  union all
  select '13'::text as check_no, 'kirjattavat'::text as section,
         'Profiileja (muutetaan: 2 saraketta)'::text as check_name, 'INFO'::text as odotus,
         (select count(*)::text from public.profile) as toteutui

  union all
  select '14'::text as check_no, '0010'::text as section,
         'Migraation 0010 objekteja ei vielä ole (0/38)'::text as check_name, '0'::text as odotus,
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
  select '15'::text as check_no, 'esteet'::text as section,
         'Avoimia idle in transaction -istuntoja ei ole'::text as check_name, '0'::text as odotus,
         (select count(*)::text from pg_stat_activity where datname = current_database()
             and state in ('idle in transaction', 'idle in transaction (aborted)') and pid <> pg_backend_pid()) as toteutui

  union all
  select '16'::text as check_no, 'esteet'::text as section,
         'Yli minuutin kestäneitä kyselyitä ei ole käynnissä'::text as check_name, '0'::text as odotus,
         (select count(*)::text from pg_stat_activity where datname = current_database() and state = 'active'
             and pid <> pg_backend_pid() and now() - query_start > interval '1 minute') as toteutui

  union all
  select '17'::text as check_no, 'esteet'::text as section,
         'Odottavia lukkoja ei ole'::text as check_name, '0'::text as odotus,
         (select count(*)::text from pg_locks l where not l.granted and l.pid <> pg_backend_pid()
             and l.pid in (select a.pid from pg_stat_activity a where a.datname = current_database())) as toteutui

  union all
  select '18'::text as check_no, 'esteet'::text as section,
         'Muut istunnot eivät lukitse tauluja, joita 0010 muuttaa tai joihin se viittaa (public.goals, public.projects, public.tasks, public.profile, auth.users)'::text as check_name, '0'::text as odotus,
         (select count(*)::text from pg_locks l where l.locktype = 'relation' and l.pid <> pg_backend_pid()
             and l.database = (select oid from pg_database where datname = current_database())
             and l.relation in (to_regclass('public.goals'), to_regclass('public.projects'), to_regclass('public.tasks'), to_regclass('public.profile'), to_regclass('auth.users'))) as toteutui

  union all
  select '19'::text as check_no, 'kirjattavat'::text as section,
         'Tehtävien lukumäärä'::text as check_name, 'INFO'::text as odotus,
         (select count(*)::text from public.tasks) as toteutui

  union all
  select '20'::text as check_no, 'kirjattavat'::text as section,
         'Tietokanta'::text as check_name, 'INFO'::text as odotus,
         current_database() as toteutui

  union all
  select '21'::text as check_no, 'kirjattavat'::text as section,
         'Palvelimen versio'::text as check_name, 'INFO'::text as odotus,
         current_setting('server_version') as toteutui

  union all
  select '22'::text as check_no, 'kirjattavat'::text as section,
         'Tarkistuksen hetki (UTC)'::text as check_name, 'INFO'::text as odotus,
         to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS') as toteutui
) c
order by c.check_no;
