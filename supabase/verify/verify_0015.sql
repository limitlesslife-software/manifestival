-- Varmistus: 0015_mental_load
-- VAIN LUKEVA. Yksi lause, yksi taulukko, yksi kopiointi.
-- Aja heti migraation 0015 jalkeen.
--
-- ODOTUS: jokaisen PASS/FAIL-rivin status = 'PASS' ja
-- poikkeavia_yhteensa = 0. Yksikin FAIL tarkoittaa, ettei aallon L
-- lippuja (TABLES.protectedPeriods, TABLES.weeklyPlans ja
-- MENTAL_LOAD_FIELDS) saa kaantaa tiedostossa src/data/schema.js.
--
-- SEITSEMAN ASIAA, JOTKA TAMA ERITYISESTI TODISTAA
--
-- 1. tasks-TAULUN UUDET SARAKKEET ovat olemassa oikeilla tyypeilla, ja
--    reschedule_count on NOT NULL default 0 (tarkistukset 04-07).
-- 2. PAIVATON TEHTAVA on rakenteellisesti sallittu: tasks.date on
--    nullable (tarkistus 08).
-- 3. KATEGORIA EI OLE ENAA UNIIKKI, mutta haku on yha indeksoitu
--    (tarkistukset 22-23).
-- 4. ODOTUS VAIN ODOTTAVALLE: waiting_on is null or horizon = 'WAITING'
--    (NULL-turvallinen: horisontti NULL + odotus hylätään)
--    (tarkistus 24); viikko alkaa maanantaista ja prioriteetteja on
--    enintaan viisi (25-26).
-- 5. RLS: nelja omaa politiikkaa kummassakin uudessa taulussa, ei anon-
--    eika PUBLIC-oikeuksia (tarkistukset 40-47).
-- 6. TILIN POISTO VIE KAIKEN: migraatioiden 0001-0015 jokaisen taulun
--    vierasavain auth.usersiin on CASCADE (tarkistukset 31-33). Muut
--    public-taulut raportoidaan rivilla 33 (INFO).
-- 7. OLEMASSA OLEVA TILA KOSKEMATON: 80 politiikkaa kuten ennen (50).
--
-- Tama tiedosto EI lue yhdenkaan uuden taulun sisaltoa (jaksojen nimia,
-- prioriteetteja, muistiinpanoja, odotusten nimia): vain rakenteen ja
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
         'Kaksi uutta taulua on olemassa' as check_name,
         '2' as odotus,
         (select count(*)::text from pg_tables
           where schemaname = 'public'
             and tablename in ('protected_periods', 'weekly_plans')) as toteutui

  -- Muoto "odotetut/kaikki": vasen luku = loytyneet odotetut sarakkeet,
  -- oikea = taulun kaikki sarakkeet.
  union all
  select '02', 'taulut', 'protected_periods: 16 odotettua saraketta eika muita', '16/16',
         (select (count(*) filter (where column_name in (
                   'id', 'user_id', 'kind', 'recurrence', 'title', 'start_date', 'end_date',
                   'weekdays', 'start_time', 'end_time', 'target_minutes', 'strength',
                   'active', 'note', 'created_at', 'updated_at')))::text || '/' || count(*)::text
            from information_schema.columns
           where table_schema = 'public' and table_name = 'protected_periods')

  union all
  select '03', 'taulut', 'weekly_plans: 9 odotettua saraketta eika muita', '9/9',
         (select (count(*) filter (where column_name in (
                   'id', 'user_id', 'week_start', 'priorities', 'planned_minutes', 'closed_at',
                   'note', 'created_at', 'updated_at')))::text || '/' || count(*)::text
            from information_schema.columns
           where table_schema = 'public' and table_name = 'weekly_plans')

  union all
  select '04', 'sarakkeet', 'tasks: kuusi uutta saraketta oikeilla tyypeilla', '6',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'tasks'
             and ((column_name = 'horizon' and data_type = 'text')
               or (column_name = 'waiting_on' and data_type = 'text')
               or (column_name = 'follow_up_date' and data_type = 'date')
               or (column_name = 'archived_at' and data_type = 'timestamp with time zone')
               or (column_name = 'reschedule_count' and data_type = 'integer')
               or (column_name = 'original_date' and data_type = 'date')))

  union all
  select '05', 'sarakkeet', 'tasks.reschedule_count NOT NULL default 0', '1',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'tasks'
             and column_name = 'reschedule_count' and is_nullable = 'NO'
             and column_default = '0')

  union all
  select '06', 'sarakkeet', 'tasks: horizon, waiting_on, follow_up_date, archived_at, original_date ovat nullable', '5',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'tasks'
             and column_name in ('horizon', 'waiting_on', 'follow_up_date', 'archived_at', 'original_date')
             and is_nullable = 'YES')

  union all
  select '07', 'sarakkeet', 'life_areas.kind text NOT NULL default STANDARD', '1',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'life_areas'
             and column_name = 'kind' and data_type = 'text' and is_nullable = 'NO'
             and column_default like '''STANDARD''%')

  union all
  -- PAIVATON TEHTAVA: sarake on nullable (idempotentti drop not null).
  select '08', 'sarakkeet', 'tasks.date on nullable (paivaton tehtava)', 'YES',
         (select is_nullable::text from information_schema.columns
           where table_schema = 'public' and table_name = 'tasks' and column_name = 'date')

  union all
  select '09', 'sarakkeet', 'Omistaja: user_id NOT NULL default auth.uid() molemmissa uusissa tauluissa', '2',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public'
             and table_name in ('protected_periods', 'weekly_plans')
             and column_name = 'user_id' and is_nullable = 'NO'
             and column_default like '%auth.uid()%')

  union all
  select '10', 'sarakkeet', 'weekly_plans.priorities jsonb NOT NULL', '1',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'weekly_plans'
             and column_name = 'priorities' and data_type = 'jsonb' and is_nullable = 'NO')

  -- ================================================================
  -- RAJOITTEET
  -- ================================================================

  union all
  select '20', 'rajoitteet', 'Kaikki 26 uutta rajoitetta ovat olemassa', '26',
         (select count(*)::text from pg_constraint
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
             'weekly_plans_week_unique', 'weekly_plans_owner_row_key'))

  union all
  -- Validoitu (ei NOT VALID): olemassa olevat rivit on tarkistettu.
  select '21', 'rajoitteet', 'tasks- ja life_areas-rajoitteet on validoitu olemassa olevia riveja vastaan', '5',
         (select count(*)::text from pg_constraint
           where conname in ('life_areas_kind_check', 'tasks_horizon_check', 'tasks_waiting_on_check',
                             'tasks_reschedule_count_check', 'tasks_waiting_on_horizon_check')
             and convalidated)

  union all
  select '22', 'rajoitteet', 'life_areas_category_unique on poistettu (useampi alue saa jakaa kategorian)', '0',
         (select count(*)::text from pg_constraint where conname = 'life_areas_category_unique')

  union all
  select '23', 'rajoitteet', 'life_areas_user_category_idx (user_id, category_key) on ei-uniikki', 'true',
         (select coalesce(bool_and(indexdef like 'CREATE INDEX%(user_id, category_key)%'), false)::text
            from pg_indexes
           where schemaname = 'public' and indexname = 'life_areas_user_category_idx')

  union all
  select '24', 'rajoitteet', 'Odotus vain odottavalle (NULL-turvallinen): waiting_on is null or horizon = WAITING', 'true',
         (select coalesce(bool_and(pg_get_constraintdef(oid) like '%WAITING%'
                                   and pg_get_constraintdef(oid) like '%waiting_on IS NULL%'
                                   and pg_get_constraintdef(oid) like '%horizon IS NOT NULL%'), false)::text
            from pg_constraint where conname = 'tasks_waiting_on_horizon_check')

  union all
  select '25', 'rajoitteet', 'Viikko alkaa maanantaista (isodow = 1)', 'true',
         (select coalesce(bool_and(pg_get_constraintdef(oid) like '%isodow%'
                                   and pg_get_constraintdef(oid) like '%= (1)::numeric%'), false)::text
            from pg_constraint where conname = 'weekly_plans_week_start_check')

  union all
  select '26', 'rajoitteet', 'Prioriteetit: jsonb-taulukko, enintaan viisi', 'true',
         (select coalesce(bool_and(pg_get_constraintdef(oid) like '%jsonb_typeof(priorities)%'
                                   and pg_get_constraintdef(oid) like '%jsonb_array_length(priorities) <= 5%'), false)::text
            from pg_constraint where conname = 'weekly_plans_priorities_check')

  union all
  select '27', 'rajoitteet', 'Yksi suunnitelma viikkoa kohti: unique (user_id, week_start)', 'true',
         (select coalesce(bool_and(pg_get_constraintdef(oid) = 'UNIQUE (user_id, week_start)'), false)::text
            from pg_constraint where conname = 'weekly_plans_week_unique')

  union all
  select '28', 'rajoitteet', 'Suojattu aika: 14 CHECK-rajoitetta (kerta, viikko, viikkotavoite, loma, ajat, paivat)', '14',
         (select count(*)::text from pg_constraint
           where conrelid = to_regclass('public.protected_periods') and contype = 'c')

  -- ================================================================
  -- OMISTAJUUS
  -- ================================================================

  union all
  select '30', 'omistajuus', 'Kaksi uutta taulua: user_id -> auth.users on CASCADE eika muita vierasavaimia', '2/2',
         (select (count(*) filter (where confdeltype = 'c' and confrelid = 'auth.users'::regclass))::text
                 || '/' || count(*)::text
            from pg_constraint
           where contype = 'f'
             and conrelid in (to_regclass('public.protected_periods'), to_regclass('public.weekly_plans')))

  union all
  -- MIGRAATIOIDEN 38 TAULUA (0001-0015, sama lista kuin tilin poiston
  -- ACCOUNT_DATA_MAP): yksikaan niiden vierasavain auth.usersiin ei saa
  -- olla muu kuin CASCADE. Muut public-taulut nakyvat rivilla 33.
  select '31', 'omistajuus', 'Migraatioiden 38 taulun jokainen vierasavain auth.usersiin on CASCADE', '0',
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
                               'wellbeing_checkins', 'protected_periods', 'weekly_plans'))

  union all
  -- Ja jokaisella niista on sellainen: taulu ilman omistajan
  -- vierasavainta jaisi tilin poistossa jaljelle.
  select '32', 'omistajuus', 'Jokaisella migraatioiden 38 taululla on vierasavain auth.usersiin', '0',
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
                              'wellbeing_checkins', 'protected_periods', 'weekly_plans']) as t(nimi)
           where not exists (select 1 from pg_constraint f
                              join pg_class c on c.oid = f.conrelid
                             where c.relnamespace = 'public'::regnamespace and c.relname = t.nimi
                               and f.contype = 'f' and f.confrelid = 'auth.users'::regclass))

  union all
  -- MUUT PUBLIC-TAULUT (esim. Dashboardista luotu): tieto, ei poikkeama.
  select '33', 'omistajuus', 'Muut public-taulut kuin migraatioiden 38 (INFO, eivat kuulu riveihin 31-32)', 'INFO',
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
                                   'wellbeing_checkins', 'protected_periods', 'weekly_plans'))

  union all
  select '34', 'omistajuus', 'Omistajan rivin avain (user_id, id) molemmissa uusissa tauluissa', '2',
         (select count(*)::text from pg_constraint
           where contype = 'u'
             and conname in ('protected_periods_owner_row_key', 'weekly_plans_owner_row_key')
             and pg_get_constraintdef(oid) = 'UNIQUE (user_id, id)')

  -- ================================================================
  -- RLS JA OIKEUDET
  -- ================================================================

  union all
  select '40', 'rls', 'RLS paalla molemmissa uusissa tauluissa', '2',
         (select count(*)::text from pg_class
           where relnamespace = 'public'::regnamespace
             and relname in ('protected_periods', 'weekly_plans')
             and relrowsecurity)

  union all
  select '41', 'rls', '8 politiikkaa, kaikki authenticated-roolille', '8',
         (select count(*)::text from pg_policies
           where schemaname = 'public'
             and tablename in ('protected_periods', 'weekly_plans')
             and roles = '{authenticated}')

  union all
  select '42', 'rls', 'Jokainen politiikka rajaa omistajaan auth.uid() = user_id', '8',
         (select count(*)::text from pg_policies
           where schemaname = 'public'
             and tablename in ('protected_periods', 'weekly_plans')
             and (coalesce(qual, '') like '%auth.uid() = user_id%'
                  or coalesce(with_check, '') like '%auth.uid() = user_id%'))

  union all
  -- Muokkaus rajataan molemmin puolin: USING (mita saa muokata) ja
  -- WITH CHECK (mihin sen saa muuttaa). Pelkka USING sallisi rivin
  -- siirtamisen toisen kayttajan nimiin.
  select '43', 'rls', 'Muokkauspolitiikat rajaavat molemmat puolet (USING ja WITH CHECK)', '2',
         (select count(*)::text from pg_policies
           where schemaname = 'public'
             and tablename in ('protected_periods', 'weekly_plans')
             and cmd = 'UPDATE'
             and coalesce(qual, '') like '%auth.uid() = user_id%'
             and coalesce(with_check, '') like '%auth.uid() = user_id%')

  union all
  select '44', 'oikeudet', 'anon: ei mitaan oikeutta', '0',
         (select count(*)::text from information_schema.role_table_grants
           where table_schema = 'public'
             and table_name in ('protected_periods', 'weekly_plans')
             and grantee = 'anon')

  union all
  select '45', 'oikeudet', 'PUBLIC: ei mitaan oikeutta', '0',
         (select count(*)::text
            from pg_class c, lateral aclexplode(c.relacl) a
           where c.relnamespace = 'public'::regnamespace
             and c.relname in ('protected_periods', 'weekly_plans')
             and a.grantee = 0)

  union all
  select '46', 'oikeudet', 'authenticated: select/insert/update/delete (8)', '8',
         (select count(*)::text from information_schema.role_table_grants
           where table_schema = 'public'
             and table_name in ('protected_periods', 'weekly_plans')
             and grantee = 'authenticated'
             and privilege_type in ('SELECT', 'INSERT', 'UPDATE', 'DELETE'))

  union all
  select '47', 'liipaisimet', 'updated_at-liipaisin molemmissa tauluissa', '2',
         (select count(*)::text from pg_trigger
           where not tgisinternal
             and tgname in ('protected_periods_touch_updated_at', 'weekly_plans_touch_updated_at'))

  -- ================================================================
  -- OLEMASSA OLEVA TILA KOSKEMATON
  -- ================================================================

  union all
  select '50', 'koskematon', 'tasks/goals/projects/routines, 0012:n, 0013:n ja 0014:n taulut: 80 politiikkaa kuten ennen', '80',
         (select count(*)::text from pg_policies
           where schemaname = 'public'
             and tablename in ('tasks', 'goals', 'projects', 'routines',
                               'life_areas', 'weekly_capacities', 'time_entries',
                               'alignment_reviews', 'running_timers', 'alignment_item_settings',
                               'saved_places', 'place_aliases', 'calendar_events',
                               'commute_observations', 'life_settings', 'sleep_logs',
                               'habit_plans', 'habit_events', 'exercise_sessions',
                               'wellbeing_checkins'))

  union all
  select '51', 'koskematon', 'RLS yha paalla tasks- ja life_areas-tauluissa', '2',
         (select count(*)::text from pg_class
           where relnamespace = 'public'::regnamespace
             and relname in ('tasks', 'life_areas') and relrowsecurity)

  union all
  select '52', 'koskematon', 'Asian luonnetta ei tallenneta: tasks/life_areas ilman nature-saraketta', '0',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public'
             and table_name in ('tasks', 'life_areas', 'protected_periods', 'weekly_plans')
             and column_name in ('nature', 'item_nature'))

  -- ================================================================
  -- RIVIT (INFO, tuore ajo = 0)
  --
  -- Rivit 62-64 lukevat 0015:n sarakkeita query_to_xml:n kautta: puuttuva
  -- sarake on 'puuttuu' eika kaada koko varmistusta (muuten yksi puuttuva
  -- sarake piilottaisi kaikki muut tulokset). Rivi 08 kertoo puutteen
  -- FAIL-rivina.
  -- ================================================================

  union all
  select '60', 'rivit', 'protected_periods: riveja (INFO, tuore ajo = 0)', 'INFO',
         (select count(*)::text from public.protected_periods)

  union all
  select '61', 'rivit', 'weekly_plans: riveja (INFO, tuore ajo = 0)', 'INFO',
         (select count(*)::text from public.weekly_plans)

  union all
  select '62', 'rivit', 'tasks: paivattomia tehtavia (INFO, tuore ajo = 0)', 'INFO',
         (select case when (select count(*) from information_schema.columns
                              where table_schema = 'public' and table_name = 'tasks' and column_name = 'date') = 0
                      then 'puuttuu'
                      else (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.tasks where date is null',
                            false, true, '')))[1]::text end)

  union all
  select '63', 'rivit', 'tasks: horisontti tai arkistointi asetettu (INFO, tuore ajo = 0)', 'INFO',
         (select case when (select count(*) from information_schema.columns
                              where table_schema = 'public' and table_name = 'tasks' and column_name = 'archived_at') = 0
                      then 'puuttuu'
                      else (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.tasks where horizon is not null or archived_at is not null',
                            false, true, '')))[1]::text end)

  union all
  select '64', 'rivit', 'life_areas: muita kuin STANDARD-lajia (INFO, tuore ajo = 0)', 'INFO',
         (select case when (select count(*) from information_schema.columns
                              where table_schema = 'public' and table_name = 'life_areas' and column_name = 'kind') = 0
                      then 'puuttuu'
                      else (xpath('/row/c/text()', query_to_xml('select count(*) as c from public.life_areas where kind <> ''STANDARD''',
                            false, true, '')))[1]::text end)

) c
order by c.check_no;
