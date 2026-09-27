-- Varmistus: 0014_daily_life
-- VAIN LUKEVA. Yksi lause, yksi taulukko, yksi kopiointi.
-- Aja heti migraation 0014 jalkeen.
--
-- ODOTUS: jokaisen PASS/FAIL-rivin status = 'PASS' ja
-- poikkeavia_yhteensa = 0. Yksikin FAIL tarkoittaa, ettei aallon K
-- lippuja (TABLES.savedPlaces … TABLES.wellbeingCheckins) saa kaantaa
-- tiedostossa src/data/schema.js.
--
-- KUUSI ASIAA, JOTKA TAMA ERITYISESTI TODISTAA
--
-- 1. EI KOORDINAATTEJA: yhdessakaan uudessa taulussa ei ole sijainti- tai
--    koordinaattisaraketta (tarkistus 13), eika tauluissa ole muita kuin
--    odotetut sarakkeet (tarkistukset 02-11: "odotetut/kaikki").
-- 2. YKSI ASETUSRIVI KAYTTAJAA KOHTI, yksi unikirjaus heraamispaivaa ja
--    yksi tuntemuskirjaus paivaa kohti (tarkistukset 22-24).
-- 3. KOKO PAIVA = EI ALKUAIKAA kannan tasolla (tarkistus 21).
-- 4. POISTOSAANNOT: paikan tai tavoitteen poisto nollaa vain oman
--    sarakkeensa (31), lapsirivit kaskadoituvat (32), eika havainnon
--    event_id ole vierasavain (37).
-- 5. TILIN POISTO VIE KAIKEN: migraatioiden 0001-0014 jokaisen taulun
--    vierasavain auth.usersiin on CASCADE (tarkistukset 33-35). Muut
--    public-taulut raportoidaan rivilla 36 (INFO).
-- 6. OLEMASSA OLEVA TILA KOSKEMATON (tarkistukset 50-51).
--
-- Tama tiedosto EI lue yhdenkaan uuden taulun sisaltoa (nimia, osoitteita,
-- muistiinpanoja, unen tai tuntemusten arvoja): vain rakenteen ja
-- rivimaarat.

-- NULL-TULOS ON POIKKEAMA. Puuttuva objekti tuottaa tarkistukseen NULLin:
-- se on FAIL, se lasketaan poikkeavia_yhteensa-lukuun (is distinct from)
-- ja details kertoo "toteutui null".
select c.check_no, c.section, c.check_name,
       case when c.odotus = 'INFO' then 'INFO'
            when c.toteutui = c.odotus then 'PASS' else 'FAIL' end as status,
       case when c.odotus = 'INFO' then c.toteutui
            else 'odotus ' || c.odotus || ', toteutui ' || coalesce(c.toteutui, 'null') end as details,
       count(*) filter (where c.odotus <> 'INFO' and c.toteutui is distinct from c.odotus)
         over () as poikkeavia_yhteensa
from (

  -- ================================================================
  -- TAULUT JA SARAKKEET
  -- ================================================================

  select '01' as check_no, 'taulut' as section,
         'Kymmenen uutta taulua on olemassa' as check_name,
         '10' as odotus,
         (select count(*)::text from pg_tables
           where schemaname = 'public'
             and tablename in ('saved_places', 'place_aliases', 'calendar_events',
                               'commute_observations', 'life_settings', 'sleep_logs',
                               'habit_plans', 'habit_events', 'exercise_sessions',
                               'wellbeing_checkins')) as toteutui

  -- Muoto "odotetut/kaikki": vasen luku = loytyneet odotetut sarakkeet,
  -- oikea = taulun kaikki sarakkeet. Ylimaarainen sarake (esim. sijainti)
  -- nakyy oikeassa luvussa.
  union all
  select '02', 'taulut', 'saved_places: 15 odotettua saraketta eika muita', '15/15',
         (select (count(*) filter (where column_name in (
                   'id', 'user_id', 'name', 'address', 'provider_place_id', 'area',
                   'travel_mode', 'usual_travel_minutes', 'preparation_minutes',
                   'arrival_buffer_minutes', 'overhead_minutes', 'use_learned', 'note',
                   'created_at', 'updated_at')))::text || '/' || count(*)::text
            from information_schema.columns
           where table_schema = 'public' and table_name = 'saved_places')

  union all
  select '03', 'taulut', 'place_aliases: 8 odotettua saraketta eika muita', '8/8',
         (select (count(*) filter (where column_name in (
                   'id', 'user_id', 'place_id', 'alias', 'confirmations', 'last_confirmed_at',
                   'created_at', 'updated_at')))::text || '/' || count(*)::text
            from information_schema.columns
           where table_schema = 'public' and table_name = 'place_aliases')

  union all
  select '04', 'taulut', 'calendar_events: 23 odotettua saraketta eika muita', '23/23',
         (select (count(*) filter (where column_name in (
                   'id', 'user_id', 'title', 'event_date', 'start_time', 'end_time',
                   'duration_minutes', 'all_day', 'category', 'location_text', 'place_id',
                   'travel_mode', 'travel_minutes', 'preparation_minutes',
                   'arrival_buffer_minutes', 'overhead_minutes', 'recurrence_weekdays',
                   'recurrence_until', 'skip_dates', 'goal_id', 'notes',
                   'created_at', 'updated_at')))::text || '/' || count(*)::text
            from information_schema.columns
           where table_schema = 'public' and table_name = 'calendar_events')

  union all
  select '05', 'taulut', 'commute_observations: 17 odotettua saraketta eika muita', '17/17',
         (select (count(*) filter (where column_name in (
                   'id', 'user_id', 'place_id', 'event_id', 'observed_on', 'weekday',
                   'planned_departure', 'actual_departure', 'arrival_at', 'travel_minutes',
                   'provider_minutes', 'preparation_minutes', 'overhead_minutes',
                   'arrival_result', 'source', 'created_at', 'updated_at')))::text
                 || '/' || count(*)::text
            from information_schema.columns
           where table_schema = 'public' and table_name = 'commute_observations')

  union all
  select '06', 'taulut', 'life_settings: 22 odotettua saraketta eika muita', '22/22',
         (select (count(*) filter (where column_name in (
                   'id', 'user_id', 'weekend_wake_shift_max_minutes',
                   'weekend_bed_shift_max_minutes', 'wind_down_minutes', 'bedtime_target',
                   'arrival_buffer_minutes', 'guidance_style', 'speech_enabled',
                   'morning_brief_enabled', 'reminder_offset_minutes', 'digest_enabled',
                   'digest_time', 'sleep_affects_capacity', 'hourly_value_minor', 'currency',
                   'alarm', 'morning_routine', 'meal_rhythm', 'delivery',
                   'created_at', 'updated_at')))::text || '/' || count(*)::text
            from information_schema.columns
           where table_schema = 'public' and table_name = 'life_settings')

  union all
  select '07', 'taulut', 'sleep_logs: 12 odotettua saraketta eika muita', '12/12',
         (select (count(*) filter (where column_name in (
                   'id', 'user_id', 'wake_date', 'planned_bedtime', 'actual_bedtime',
                   'planned_wake', 'actual_wake', 'source', 'kind', 'note',
                   'created_at', 'updated_at')))::text || '/' || count(*)::text
            from information_schema.columns
           where table_schema = 'public' and table_name = 'sleep_logs')

  union all
  select '08', 'taulut', 'habit_plans: 13 odotettua saraketta eika muita', '13/13',
         (select (count(*) filter (where column_name in (
                   'id', 'user_id', 'kind', 'name', 'min_interval_minutes', 'daily_target',
                   'baseline_per_day', 'steps', 'reminder_delivery', 'unit_cost_minor',
                   'active', 'created_at', 'updated_at')))::text || '/' || count(*)::text
            from information_schema.columns
           where table_schema = 'public' and table_name = 'habit_plans')

  union all
  select '09', 'taulut', 'habit_events: 8 odotettua saraketta eika muita', '8/8',
         (select (count(*) filter (where column_name in (
                   'id', 'user_id', 'plan_id', 'occurred_at', 'action', 'note',
                   'created_at', 'updated_at')))::text || '/' || count(*)::text
            from information_schema.columns
           where table_schema = 'public' and table_name = 'habit_events')

  union all
  select '10', 'taulut', 'exercise_sessions: 12 odotettua saraketta eika muita', '12/12',
         (select (count(*) filter (where column_name in (
                   'id', 'user_id', 'session_date', 'kind', 'planned_minutes',
                   'actual_minutes', 'intensity', 'recovery_demand', 'goal_id', 'note',
                   'created_at', 'updated_at')))::text || '/' || count(*)::text
            from information_schema.columns
           where table_schema = 'public' and table_name = 'exercise_sessions')

  union all
  select '11', 'taulut', 'wellbeing_checkins: 7 odotettua saraketta eika muita', '7/7',
         (select (count(*) filter (where column_name in (
                   'id', 'user_id', 'date', 'motivation', 'control',
                   'created_at', 'updated_at')))::text || '/' || count(*)::text
            from information_schema.columns
           where table_schema = 'public' and table_name = 'wellbeing_checkins')

  union all
  select '12', 'sarakkeet', 'Omistaja: user_id NOT NULL default auth.uid() kaikissa kymmenessa', '10',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public'
             and table_name in ('saved_places', 'place_aliases', 'calendar_events',
                                'commute_observations', 'life_settings', 'sleep_logs',
                                'habit_plans', 'habit_events', 'exercise_sessions',
                                'wellbeing_checkins')
             and column_name = 'user_id' and is_nullable = 'NO'
             and column_default like '%auth.uid()%')

  union all
  -- EI KOORDINAATTEJA EIKA SIJAINTIHISTORIAA. Sarakkeen nimen osa tai
  -- tyyppi paljastaisi sen; kumpaakaan ei saa loytya.
  select '13', 'tietosuoja', 'Uusissa tauluissa ei ole koordinaatti- tai sijaintisaraketta', '0',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public'
             and table_name in ('saved_places', 'place_aliases', 'calendar_events',
                                'commute_observations', 'life_settings', 'sleep_logs',
                                'habit_plans', 'habit_events', 'exercise_sessions',
                                'wellbeing_checkins')
             and (column_name ~ '(^|_)(lat|lng|lon|latitude|longitude|geo|gps|coord|coords|point|geometry|geography)(_|$)'
                  or udt_name in ('geometry', 'geography', 'point')))

  -- ================================================================
  -- RAJOITTEET
  -- ================================================================

  union all
  select '20', 'rajoitteet', 'Kaikki 88 uutta rajoitetta ovat olemassa', '88',
         (select count(*)::text from pg_constraint
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
             'wellbeing_checkins_date_unique', 'wellbeing_checkins_owner_row_key'))

  union all
  select '21', 'rajoitteet', 'Koko paiva = ei alkuaikaa (all_day = start_time is null)', 'true',
         (select coalesce(bool_and(pg_get_constraintdef(oid) like '%all_day = (start_time IS NULL)%'), false)::text
            from pg_constraint where conname = 'calendar_events_all_day_check')

  union all
  select '22', 'rajoitteet', 'YKSI ASETUSRIVI KAYTTAJAA KOHTI: unique (user_id)', 'true',
         (select coalesce(bool_and(pg_get_constraintdef(oid) = 'UNIQUE (user_id)'), false)::text
            from pg_constraint where conname = 'life_settings_one_per_user')

  union all
  select '23', 'rajoitteet', 'Yksi unikirjaus heraamispaivaa kohti (user_id, wake_date)', 'true',
         (select coalesce(bool_and(pg_get_constraintdef(oid) = 'UNIQUE (user_id, wake_date)'), false)::text
            from pg_constraint where conname = 'sleep_logs_wake_date_unique')

  union all
  select '24', 'rajoitteet', 'Yksi motivaatio- ja hallintakirjaus paivaa kohti (user_id, date)', 'true',
         (select coalesce(bool_and(pg_get_constraintdef(oid) = 'UNIQUE (user_id, date)'), false)::text
            from pg_constraint where conname = 'wellbeing_checkins_date_unique')

  union all
  select '25', 'rajoitteet', 'Paikan nimi on uniikki kayttajaa kohti kirjainkoosta riippumatta', 'true',
         (select coalesce(bool_and(indexdef like 'CREATE UNIQUE INDEX%lower(name)%'), false)::text
            from pg_indexes
           where schemaname = 'public' and indexname = 'saved_places_user_name_idx')

  union all
  select '26', 'rajoitteet', 'Sama lisanimi samalle paikalle kerran (user_id, alias, place_id)', 'true',
         (select coalesce(bool_and(pg_get_constraintdef(oid) = 'UNIQUE (user_id, alias, place_id)'), false)::text
            from pg_constraint where conname = 'place_aliases_alias_unique')

  union all
  select '27', 'rajoitteet', 'Motivaatio ja hallinnan tunne ovat 1-5 tai tyhja', 'true',
         (select coalesce(bool_and(pg_get_constraintdef(oid) like '%>= 1)%'
                                   and pg_get_constraintdef(oid) like '%<= 5)%'
                                   and pg_get_constraintdef(oid) like '%IS NULL%'), false)::text
            from pg_constraint
           where conname in ('wellbeing_checkins_motivation_check', 'wellbeing_checkins_control_check'))

  union all
  select '28', 'rajoitteet', 'jsonb-rakenteiden koko on rajattu (4 asetussaraketta ja portaat)', '5',
         (select count(*)::text from pg_constraint
           where conname in ('life_settings_alarm_check', 'life_settings_morning_routine_check',
                             'life_settings_meal_rhythm_check', 'life_settings_delivery_check',
                             'habit_plans_steps_check')
             and pg_get_constraintdef(oid) like '%pg_column_size%'
             and pg_get_constraintdef(oid) like '%jsonb_typeof%')

  -- ================================================================
  -- OMISTAJUUS JA POISTOSAANNOT
  -- ================================================================

  union all
  select '30', 'omistajuus', 'Vierasavaimet ovat yhdistelmaavaimia (user_id, x)', '6',
         (select count(*)::text from pg_constraint
           where contype = 'f'
             and conname in ('place_aliases_place_fkey', 'calendar_events_place_fkey',
                             'calendar_events_goal_fkey', 'commute_observations_place_fkey',
                             'habit_events_plan_fkey', 'exercise_sessions_goal_fkey')
             and array_length(conkey, 1) = 2)

  union all
  select '31', 'omistajuus', 'Paikan ja tavoitteen poisto nollaa vain oman sarakkeensa (ON DELETE SET NULL (x))', '3',
         (select count(*)::text from pg_constraint
           where conname in ('calendar_events_place_fkey', 'calendar_events_goal_fkey',
                             'exercise_sessions_goal_fkey')
             and confdeltype = 'n' and array_length(confdelsetcols, 1) = 1)

  union all
  select '32', 'omistajuus', 'Lisanimet, havainnot ja tapojen kirjaukset poistuvat vanhempansa mukana (CASCADE)', '3',
         (select count(*)::text from pg_constraint
           where conname in ('place_aliases_place_fkey', 'commute_observations_place_fkey',
                             'habit_events_plan_fkey')
             and confdeltype = 'c')

  union all
  -- TILIN POISTO VIE MYOS ARJEN TIEDOT. user_id-vierasavain auth.usersiin
  -- on CASCADE jokaisessa uudessa taulussa.
  select '33', 'omistajuus', 'Kymmenen uutta taulua: user_id -> auth.users on CASCADE', '10',
         (select count(*)::text from pg_constraint
           where contype = 'f' and confdeltype = 'c'
             and confrelid = 'auth.users'::regclass
             and conrelid in (to_regclass('public.saved_places'), to_regclass('public.place_aliases'),
                              to_regclass('public.calendar_events'),
                              to_regclass('public.commute_observations'),
                              to_regclass('public.life_settings'), to_regclass('public.sleep_logs'),
                              to_regclass('public.habit_plans'), to_regclass('public.habit_events'),
                              to_regclass('public.exercise_sessions'),
                              to_regclass('public.wellbeing_checkins')))

  union all
  -- MIGRAATIOIDEN 36 TAULUA (0001-0014, sama lista kuin tilin poiston
  -- ACCOUNT_DATA_MAP): yksikaan niiden vierasavain auth.usersiin ei saa
  -- olla muu kuin CASCADE. Muut public-taulut nakyvat rivilla 36.
  select '34', 'omistajuus', 'Migraatioiden 36 taulun jokainen vierasavain auth.usersiin on CASCADE', '0',
         (select count(*)::text from pg_constraint f
            join pg_class c on c.oid = f.conrelid
           where f.contype = 'f' and f.confrelid = 'auth.users'::regclass
             and f.connamespace = 'public'::regnamespace
             and f.confdeltype <> 'c'
             and c.relname in ('tasks', 'routines', 'routine_exceptions', 'goals', 'projects',
                               'bills', 'recurring_expenses', 'savings_goals', 'wellbeing_entries',
                               'notification_preferences', 'profile', 'ai_action_audit',
                               'transactions', 'investments', 'milestones', 'inbox_items',
                               'reminders', 'notices', 'travel_plans', 'location_rules',
                               'life_areas', 'weekly_capacities', 'time_entries',
                               'alignment_reviews', 'alignment_item_settings', 'running_timers',
                               'saved_places', 'place_aliases', 'calendar_events',
                               'commute_observations', 'life_settings', 'sleep_logs',
                               'habit_plans', 'habit_events', 'exercise_sessions',
                               'wellbeing_checkins'))

  union all
  -- Ja jokaisella niista on sellainen: taulu ilman omistajan
  -- vierasavainta jaisi tilin poistossa jaljelle.
  select '35', 'omistajuus', 'Jokaisella migraatioiden 36 taululla on vierasavain auth.usersiin', '0',
         (select count(*)::text
            from unnest(array['tasks', 'routines', 'routine_exceptions', 'goals', 'projects',
                              'bills', 'recurring_expenses', 'savings_goals', 'wellbeing_entries',
                              'notification_preferences', 'profile', 'ai_action_audit',
                              'transactions', 'investments', 'milestones', 'inbox_items',
                              'reminders', 'notices', 'travel_plans', 'location_rules',
                              'life_areas', 'weekly_capacities', 'time_entries',
                              'alignment_reviews', 'alignment_item_settings', 'running_timers',
                              'saved_places', 'place_aliases', 'calendar_events',
                              'commute_observations', 'life_settings', 'sleep_logs',
                              'habit_plans', 'habit_events', 'exercise_sessions',
                              'wellbeing_checkins']) as t(nimi)
           where not exists (select 1 from pg_constraint f
                              join pg_class c on c.oid = f.conrelid
                             where c.relnamespace = 'public'::regnamespace and c.relname = t.nimi
                               and f.contype = 'f' and f.confrelid = 'auth.users'::regclass))

  union all
  -- MUUT PUBLIC-TAULUT (esim. Dashboardista luotu): tieto, ei poikkeama.
  select '36', 'omistajuus', 'Muut public-taulut kuin migraatioiden 36 (INFO, eivat kuulu riveihin 34-35)', 'INFO',
         (select count(*)::text || coalesce(': ' || string_agg(c.relname::text, ', ' order by c.relname), '')
            from pg_class c
           where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
             and c.relname not in ('tasks', 'routines', 'routine_exceptions', 'goals', 'projects',
                                   'bills', 'recurring_expenses', 'savings_goals', 'wellbeing_entries',
                                   'notification_preferences', 'profile', 'ai_action_audit',
                                   'transactions', 'investments', 'milestones', 'inbox_items',
                                   'reminders', 'notices', 'travel_plans', 'location_rules',
                                   'life_areas', 'weekly_capacities', 'time_entries',
                                   'alignment_reviews', 'alignment_item_settings', 'running_timers',
                                   'saved_places', 'place_aliases', 'calendar_events',
                                   'commute_observations', 'life_settings', 'sleep_logs',
                                   'habit_plans', 'habit_events', 'exercise_sessions',
                                   'wellbeing_checkins'))

  union all
  -- Havainnon event_id EI OLE vierasavain: vain omistaja ja paikka.
  select '37', 'omistajuus', 'commute_observations: vain kaksi vierasavainta (omistaja ja paikka)', '2',
         (select count(*)::text from pg_constraint
           where contype = 'f' and conrelid = to_regclass('public.commute_observations'))

  -- ================================================================
  -- RLS JA OIKEUDET
  -- ================================================================

  union all
  select '40', 'rls', 'RLS paalla kaikissa kymmenessa uudessa taulussa', '10',
         (select count(*)::text from pg_class
           where relnamespace = 'public'::regnamespace
             and relname in ('saved_places', 'place_aliases', 'calendar_events',
                             'commute_observations', 'life_settings', 'sleep_logs',
                             'habit_plans', 'habit_events', 'exercise_sessions',
                             'wellbeing_checkins')
             and relrowsecurity)

  union all
  select '41', 'rls', '40 politiikkaa, kaikki authenticated-roolille', '40',
         (select count(*)::text from pg_policies
           where schemaname = 'public'
             and tablename in ('saved_places', 'place_aliases', 'calendar_events',
                               'commute_observations', 'life_settings', 'sleep_logs',
                               'habit_plans', 'habit_events', 'exercise_sessions',
                               'wellbeing_checkins')
             and roles = '{authenticated}')

  union all
  select '42', 'rls', 'Jokainen politiikka rajaa omistajaan auth.uid() = user_id', '40',
         (select count(*)::text from pg_policies
           where schemaname = 'public'
             and tablename in ('saved_places', 'place_aliases', 'calendar_events',
                               'commute_observations', 'life_settings', 'sleep_logs',
                               'habit_plans', 'habit_events', 'exercise_sessions',
                               'wellbeing_checkins')
             and (coalesce(qual, '') like '%auth.uid() = user_id%'
                  or coalesce(with_check, '') like '%auth.uid() = user_id%'))

  union all
  -- Muokkaus rajataan molemmin puolin: USING (mita saa muokata) ja
  -- WITH CHECK (mihin sen saa muuttaa). Pelkka USING sallisi rivin
  -- siirtamisen toisen kayttajan nimiin.
  select '43', 'rls', 'Muokkauspolitiikat rajaavat molemmat puolet (USING ja WITH CHECK)', '10',
         (select count(*)::text from pg_policies
           where schemaname = 'public'
             and tablename in ('saved_places', 'place_aliases', 'calendar_events',
                               'commute_observations', 'life_settings', 'sleep_logs',
                               'habit_plans', 'habit_events', 'exercise_sessions',
                               'wellbeing_checkins')
             and cmd = 'UPDATE'
             and coalesce(qual, '') like '%auth.uid() = user_id%'
             and coalesce(with_check, '') like '%auth.uid() = user_id%')

  union all
  select '44', 'oikeudet', 'anon: ei mitaan oikeutta', '0',
         (select count(*)::text from information_schema.role_table_grants
           where table_schema = 'public'
             and table_name in ('saved_places', 'place_aliases', 'calendar_events',
                                'commute_observations', 'life_settings', 'sleep_logs',
                                'habit_plans', 'habit_events', 'exercise_sessions',
                                'wellbeing_checkins')
             and grantee = 'anon')

  union all
  select '45', 'oikeudet', 'PUBLIC: ei mitaan oikeutta', '0',
         (select count(*)::text
            from pg_class c, lateral aclexplode(c.relacl) a
           where c.relnamespace = 'public'::regnamespace
             and c.relname in ('saved_places', 'place_aliases', 'calendar_events',
                               'commute_observations', 'life_settings', 'sleep_logs',
                               'habit_plans', 'habit_events', 'exercise_sessions',
                               'wellbeing_checkins')
             and a.grantee = 0)

  union all
  select '46', 'oikeudet', 'authenticated: select/insert/update/delete (40)', '40',
         (select count(*)::text from information_schema.role_table_grants
           where table_schema = 'public'
             and table_name in ('saved_places', 'place_aliases', 'calendar_events',
                                'commute_observations', 'life_settings', 'sleep_logs',
                                'habit_plans', 'habit_events', 'exercise_sessions',
                                'wellbeing_checkins')
             and grantee = 'authenticated'
             and privilege_type in ('SELECT', 'INSERT', 'UPDATE', 'DELETE'))

  union all
  select '47', 'liipaisimet', 'updated_at-liipaisin kaikissa kymmenessa taulussa', '10',
         (select count(*)::text from pg_trigger
           where not tgisinternal
             and tgname in ('saved_places_touch_updated_at', 'place_aliases_touch_updated_at',
                            'calendar_events_touch_updated_at',
                            'commute_observations_touch_updated_at',
                            'life_settings_touch_updated_at', 'sleep_logs_touch_updated_at',
                            'habit_plans_touch_updated_at', 'habit_events_touch_updated_at',
                            'exercise_sessions_touch_updated_at',
                            'wellbeing_checkins_touch_updated_at'))

  -- ================================================================
  -- OLEMASSA OLEVA TILA KOSKEMATON
  -- ================================================================

  union all
  select '50', 'koskematon', 'tasks/goals/projects/routines, 0012:n ja 0013:n taulut: 40 politiikkaa kuten ennen', '40',
         (select count(*)::text from pg_policies
           where schemaname = 'public'
             and tablename in ('tasks', 'goals', 'projects', 'routines',
                               'life_areas', 'weekly_capacities', 'time_entries',
                               'alignment_reviews', 'running_timers', 'alignment_item_settings'))

  union all
  select '51', 'koskematon', 'profile ja wellbeing_entries: ei uusia arjen sarakkeita', '0',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public'
             and table_name in ('profile', 'wellbeing_entries', 'tasks', 'goals')
             and column_name in ('motivation', 'control', 'bedtime_target', 'wind_down_minutes',
                                 'guidance_style', 'place_id', 'event_date', 'use_learned'))

  -- ================================================================
  -- RIVIT (INFO, tuore ajo = 0)
  -- ================================================================

  union all
  select '60', 'rivit', 'saved_places: riveja (INFO, tuore ajo = 0)', 'INFO',
         (select count(*)::text from public.saved_places)

  union all
  select '61', 'rivit', 'place_aliases: riveja (INFO, tuore ajo = 0)', 'INFO',
         (select count(*)::text from public.place_aliases)

  union all
  select '62', 'rivit', 'calendar_events: riveja (INFO, tuore ajo = 0)', 'INFO',
         (select count(*)::text from public.calendar_events)

  union all
  select '63', 'rivit', 'commute_observations: riveja (INFO, tuore ajo = 0)', 'INFO',
         (select count(*)::text from public.commute_observations)

  union all
  select '64', 'rivit', 'life_settings: riveja (INFO, tuore ajo = 0)', 'INFO',
         (select count(*)::text from public.life_settings)

  union all
  select '65', 'rivit', 'sleep_logs: riveja (INFO, tuore ajo = 0)', 'INFO',
         (select count(*)::text from public.sleep_logs)

  union all
  select '66', 'rivit', 'habit_plans: riveja (INFO, tuore ajo = 0)', 'INFO',
         (select count(*)::text from public.habit_plans)

  union all
  select '67', 'rivit', 'habit_events: riveja (INFO, tuore ajo = 0)', 'INFO',
         (select count(*)::text from public.habit_events)

  union all
  select '68', 'rivit', 'exercise_sessions: riveja (INFO, tuore ajo = 0)', 'INFO',
         (select count(*)::text from public.exercise_sessions)

  union all
  select '69', 'rivit', 'wellbeing_checkins: riveja (INFO, tuore ajo = 0)', 'INFO',
         (select count(*)::text from public.wellbeing_checkins)

) c
order by c.check_no;
