-- Preflight: ENNEN migraatiota 0015_mental_load (aalto L)
-- VAIN LUKEVA. Yksi lause, yksi taulukko, yksi kopiointi.
--
-- GENEROITU: node tools/activation/build-preflights.mjs. ÄLÄ MUOKKAA
-- KÄSIN — testi vertaa tiedostoa generaattoriin.
--
-- MILLOIN: juuri ennen kuin 0015 ajetaan, samassa SQL-editorin
-- välilehdessä ja ilman muita avoimia välilehtiä.
--
-- ODOTUS: jokaisen PASS/FAIL-rivin status = 'PASS' ja
-- poikkeavia_yhteensa = 0. INFO-rivit ovat kirjattavia lukuja.
--
-- YKSIKIN FAIL = MIGRAATIOTA 0015 EI AJETA.
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
         'Edellinen migraatio 0014 on ajettu kokonaan (153 objektia)'::text as check_name, '153'::text as odotus,
         (select count(*)::text from (
           select 1 from pg_tables
           where schemaname = 'public'
           and tablename in ('saved_places', 'place_aliases', 'calendar_events',
           'commute_observations', 'life_settings', 'sleep_logs',
           'habit_plans', 'habit_events', 'exercise_sessions',
           'wellbeing_checkins')
           union all
           select 1 from pg_constraint
           where conname in (
           'saved_places_name_check', 'saved_places_address_check',
           'saved_places_provider_place_check', 'saved_places_area_check',
           'saved_places_travel_mode_check', 'saved_places_usual_travel_check',
           'saved_places_preparation_check', 'saved_places_arrival_buffer_check',
           'saved_places_overhead_check', 'saved_places_note_check',
           'saved_places_owner_row_key',
           'place_aliases_alias_check', 'place_aliases_confirmations_check',
           'place_aliases_owner_row_key', 'place_aliases_alias_unique',
           'place_aliases_place_fkey',
           'calendar_events_title_check', 'calendar_events_all_day_check',
           'calendar_events_end_time_check', 'calendar_events_duration_check',
           'calendar_events_category_check', 'calendar_events_location_check',
           'calendar_events_travel_mode_check', 'calendar_events_travel_check',
           'calendar_events_preparation_check', 'calendar_events_arrival_buffer_check',
           'calendar_events_overhead_check', 'calendar_events_weekdays_check',
           'calendar_events_until_check', 'calendar_events_skip_dates_check',
           'calendar_events_notes_check', 'calendar_events_owner_row_key',
           'calendar_events_place_fkey', 'calendar_events_goal_fkey',
           'commute_observations_event_id_check', 'commute_observations_weekday_check',
           'commute_observations_travel_check', 'commute_observations_provider_check',
           'commute_observations_preparation_check', 'commute_observations_overhead_check',
           'commute_observations_result_check', 'commute_observations_source_check',
           'commute_observations_owner_row_key', 'commute_observations_place_fkey',
           'life_settings_one_per_user', 'life_settings_weekend_wake_check',
           'life_settings_weekend_bed_check', 'life_settings_wind_down_check',
           'life_settings_arrival_buffer_check', 'life_settings_guidance_check',
           'life_settings_reminder_offset_check', 'life_settings_hourly_value_check',
           'life_settings_currency_check', 'life_settings_alarm_check',
           'life_settings_morning_routine_check', 'life_settings_meal_rhythm_check',
           'life_settings_delivery_check', 'life_settings_owner_row_key',
           'sleep_logs_wake_date_unique', 'sleep_logs_source_check',
           'sleep_logs_kind_check', 'sleep_logs_note_check', 'sleep_logs_owner_row_key',
           'habit_plans_kind_check', 'habit_plans_name_check',
           'habit_plans_min_interval_check', 'habit_plans_daily_target_check',
           'habit_plans_baseline_check', 'habit_plans_steps_check',
           'habit_plans_delivery_check', 'habit_plans_unit_cost_check',
           'habit_plans_owner_row_key',
           'habit_events_action_check', 'habit_events_note_check',
           'habit_events_owner_row_key', 'habit_events_plan_fkey',
           'exercise_sessions_kind_check', 'exercise_sessions_planned_check',
           'exercise_sessions_actual_check', 'exercise_sessions_intensity_check',
           'exercise_sessions_recovery_check', 'exercise_sessions_note_check',
           'exercise_sessions_owner_row_key', 'exercise_sessions_goal_fkey',
           'wellbeing_checkins_motivation_check', 'wellbeing_checkins_control_check',
           'wellbeing_checkins_date_unique', 'wellbeing_checkins_owner_row_key')
           union all
           select 1 from pg_indexes
           where schemaname = 'public'
           and indexname in (
           'saved_places_user_name_idx', 'calendar_events_user_date_idx',
           'commute_observations_user_place_idx', 'habit_events_user_plan_idx',
           'exercise_sessions_user_date_idx')
           union all
           select 1 from pg_trigger
           where not tgisinternal
           and tgname in ('saved_places_touch_updated_at', 'place_aliases_touch_updated_at',
           'calendar_events_touch_updated_at',
           'commute_observations_touch_updated_at',
           'life_settings_touch_updated_at', 'sleep_logs_touch_updated_at',
           'habit_plans_touch_updated_at', 'habit_events_touch_updated_at',
           'exercise_sessions_touch_updated_at',
           'wellbeing_checkins_touch_updated_at')
           union all
           select 1 from pg_policies
           where schemaname = 'public'
           and tablename in ('saved_places', 'place_aliases', 'calendar_events',
           'commute_observations', 'life_settings', 'sleep_logs',
           'habit_plans', 'habit_events', 'exercise_sessions',
           'wellbeing_checkins')
           ) kaikki) as toteutui

  union all
  select '07'::text as check_no, '0015'::text as section,
         'life_areas_category_unique on olemassa (0015 poistaa sen)'::text as check_name, '1'::text as odotus,
         (select count(*)::text from pg_constraint where contype = 'u' and conname = 'life_areas_category_unique') as toteutui

  union all
  select '08'::text as check_no, '0015'::text as section,
         'tasks ja life_areas: RLS päällä (uudet sarakkeet kuuluvat olemassa oleviin politiikkoihin)'::text as check_name, '2'::text as odotus,
         (select count(*)::text from pg_class where relnamespace = 'public'::regnamespace and relname in ('tasks', 'life_areas') and relrowsecurity) as toteutui

  union all
  select '09'::text as check_no, 'kirjattavat'::text as section,
         'tasks.date NOT NULL ennen 0015:tä (kirjaa: peruutus palauttaa ehdon vain jos kyllä)'::text as check_name, 'INFO'::text as odotus,
         (select case when a.attnotnull then 'kyllä' else 'ei' end from pg_attribute a where a.attrelid = to_regclass('public.tasks') and a.attname = 'date' and not a.attisdropped) as toteutui

  union all
  select '10'::text as check_no, 'kirjattavat'::text as section,
         'tasks.date-sarakkeen tyyppi'::text as check_name, 'INFO'::text as odotus,
         (select data_type::text from information_schema.columns where table_schema = 'public' and table_name = 'tasks' and column_name = 'date') as toteutui

  union all
  select '11'::text as check_no, 'kirjattavat'::text as section,
         'Elämänalueita (saavat kind = STANDARD, ei uudelleenkirjoitusta)'::text as check_name, 'INFO'::text as odotus,
         (select case when to_regclass('public.life_areas') is null then 'puuttuu' else (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.life_areas', false, true, '')))[1]::text end) as toteutui

  union all
  select '12'::text as check_no, '0015'::text as section,
         'tasks, goals, projects, routines, 0012:n, 0013:n ja 0014:n taulut: 80 politiikkaa (0015 vaatii ennen committia)'::text as check_name, '80'::text as odotus,
         (select count(*)::text from pg_policies where schemaname = 'public' and tablename in ('tasks', 'goals', 'projects', 'routines', 'life_areas', 'weekly_capacities', 'time_entries', 'alignment_reviews', 'running_timers', 'alignment_item_settings', 'saved_places', 'place_aliases', 'calendar_events', 'commute_observations', 'life_settings', 'sleep_logs', 'habit_plans', 'habit_events', 'exercise_sessions', 'wellbeing_checkins')) as toteutui

  union all
  select '13'::text as check_no, '0015'::text as section,
         'Migraation 0015 objekteja ei vielä ole (0/undefined)'::text as check_name, '0'::text as odotus,
         (select count(*)::text from (
           select 1 from pg_tables
           where schemaname = 'public'
           and tablename in ('protected_periods', 'weekly_plans')
           union all
           select 1 from information_schema.columns
           where table_schema = 'public' and table_name = 'tasks'
           and column_name in ('horizon', 'waiting_on', 'follow_up_date', 'archived_at',
           'reschedule_count', 'original_date')
           union all
           select 1 from information_schema.columns
           where table_schema = 'public' and table_name = 'life_areas'
           and column_name in ('kind')
           union all
           select 1 from pg_constraint
           where conname in (
           'life_areas_kind_check',
           'tasks_horizon_check', 'tasks_waiting_on_check', 'tasks_reschedule_count_check',
           'tasks_waiting_on_horizon_check',
           'protected_periods_kind_check', 'protected_periods_recurrence_check',
           'protected_periods_title_check', 'protected_periods_note_check',
           'protected_periods_weekdays_check', 'protected_periods_target_check',
           'protected_periods_strength_check', 'protected_periods_dates_check',
           'protected_periods_times_check', 'protected_periods_once_check',
           'protected_periods_weekly_check', 'protected_periods_weekly_target_check',
           'protected_periods_vacation_check', 'protected_periods_span_check',
           'protected_periods_owner_row_key',
           'weekly_plans_week_start_check', 'weekly_plans_priorities_check',
           'weekly_plans_planned_minutes_check', 'weekly_plans_note_check',
           'weekly_plans_week_unique', 'weekly_plans_owner_row_key')
           union all
           select 1 from pg_indexes
           where schemaname = 'public'
           and indexname in ('life_areas_user_category_idx', 'protected_periods_user_active_idx')
           union all
           select 1 from pg_trigger
           where not tgisinternal
           and tgname in ('protected_periods_touch_updated_at', 'weekly_plans_touch_updated_at')
           union all
           select 1 from pg_policies
           where schemaname = 'public'
           and tablename in ('protected_periods', 'weekly_plans')
           ) kaikki) as toteutui

  union all
  select '14'::text as check_no, 'esteet'::text as section,
         'Avoimia idle in transaction -istuntoja ei ole'::text as check_name, '0'::text as odotus,
         (select count(*)::text from pg_stat_activity where datname = current_database()
             and state in ('idle in transaction', 'idle in transaction (aborted)') and pid <> pg_backend_pid()) as toteutui

  union all
  select '15'::text as check_no, 'esteet'::text as section,
         'Yli minuutin kestäneitä kyselyitä ei ole käynnissä'::text as check_name, '0'::text as odotus,
         (select count(*)::text from pg_stat_activity where datname = current_database() and state = 'active'
             and pid <> pg_backend_pid() and now() - query_start > interval '1 minute') as toteutui

  union all
  select '16'::text as check_no, 'esteet'::text as section,
         'Odottavia lukkoja ei ole'::text as check_name, '0'::text as odotus,
         (select count(*)::text from pg_locks l where not l.granted and l.pid <> pg_backend_pid()
             and l.pid in (select a.pid from pg_stat_activity a where a.datname = current_database())) as toteutui

  union all
  select '17'::text as check_no, 'esteet'::text as section,
         'Muut istunnot eivät lukitse tauluja, joita 0015 muuttaa tai joihin se viittaa (public.tasks, public.life_areas, auth.users)'::text as check_name, '0'::text as odotus,
         (select count(*)::text from pg_locks l where l.locktype = 'relation' and l.pid <> pg_backend_pid()
             and l.database = (select oid from pg_database where datname = current_database())
             and l.relation in (to_regclass('public.tasks'), to_regclass('public.life_areas'), to_regclass('auth.users'))) as toteutui

  union all
  select '18'::text as check_no, 'kirjattavat'::text as section,
         'Tehtävien lukumäärä'::text as check_name, 'INFO'::text as odotus,
         (select count(*)::text from public.tasks) as toteutui

  union all
  select '19'::text as check_no, 'kirjattavat'::text as section,
         'Tietokanta'::text as check_name, 'INFO'::text as odotus,
         current_database() as toteutui

  union all
  select '20'::text as check_no, 'kirjattavat'::text as section,
         'Palvelimen versio'::text as check_name, 'INFO'::text as odotus,
         current_setting('server_version') as toteutui

  union all
  select '21'::text as check_no, 'kirjattavat'::text as section,
         'Tarkistuksen hetki (UTC)'::text as check_name, 'INFO'::text as odotus,
         to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS') as toteutui
) c
order by c.check_no;
