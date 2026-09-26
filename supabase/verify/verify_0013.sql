-- Varmistus: 0013_alignment_reality
-- VAIN LUKEVA. Yksi lause, yksi taulukko, yksi kopiointi.
-- Aja heti migraation 0013 jalkeen.
--
-- ODOTUS: jokaisen PASS/FAIL-rivin status = 'PASS' ja
-- poikkeavia_yhteensa = 0. Yksikin FAIL tarkoittaa, ettei lippuja
-- runningTimers, alignmentItemSettings eika ALIGNMENT_REALITY_FIELDS saa
-- kaantaa tiedostossa src/data/schema.js.
--
-- HUOM. verify_0012.sql:n tarkistus 21 ("source sallii vain 'manual'")
-- EPAONNISTUU 0013:n jalkeen, koska 0013 korvaa rajoitteen. Aja
-- verify_0012 ENNEN 0013:a. Taman tiedoston tarkistus 12 todistaa
-- korvaavan rajoitteen.
--
-- VIISI ASIAA, JOTKA TAMA ERITYISESTI TODISTAA
--
-- 1. YKSI AJASTIN KAYTTAJAA KOHTI (tarkistus 20).
-- 2. SAMA OPERAATIO KERRAN: time_entries (user_id, operation_id) on
--    uniikki (tarkistus 13).
-- 3. POISTOSAANTO RAJAA NOLLAUKSEN SARAKKEESEEN: kohteen poisto ei vie
--    kirjattua aikaa eika kaynnissa olevaa ajastinta (tarkistus 24).
-- 4. TUOTANNOSSA AUKI OLEVIIN TAULUIHIN EI KOSKETTU (tarkistukset 40-41).
-- 5. TILIN POISTO VIE KAIKEN: migraatioiden 0001-0013 jokaisen taulun
--    vierasavain auth.usersiin on CASCADE, myos kahdessa uudessa
--    taulussa (tarkistukset 25-27). Muut public-taulut eivat ole
--    migraatioiden tulosta: ne raportoidaan rivilla 28 (INFO), ja
--    preflight_0009 tarkistaa ne jo ennen junaa.
--
-- Tama tiedosto EI lue sarakkeita note, reflection, reflection_answers,
-- snapshot eika adjustments. Ne ovat kayttajan omaa sisaltoa.

-- NULL-TULOS ON POIKKEAMA. Puuttuva objekti tuottaa tarkistukseen NULLin:
-- se on FAIL, se lasketaan poikkeavia_yhteensa-lukuun (is distinct from)
-- ja details kertoo "toteutui null". Harjoiteltu: tools/pg-rehearsal
-- (verify:null).
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
             and tablename in ('running_timers', 'alignment_item_settings')) as toteutui

  union all
  select '02', 'taulut', 'running_timers: viisitoista odotettua saraketta', '15',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'running_timers'
             and column_name in ('id', 'user_id', 'target_kind', 'life_area_id', 'goal_id',
                                 'task_id', 'project_id', 'routine_id', 'occurrence_date',
                                 'started_at', 'paused_at', 'paused_seconds', 'note',
                                 'created_at', 'updated_at'))

  union all
  select '03', 'taulut', 'alignment_item_settings: kahdeksan odotettua saraketta', '8',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'alignment_item_settings'
             and column_name in ('id', 'user_id', 'item_kind', 'item_id', 'energy_demand',
                                 'alignment_opt_out', 'estimate_approximate', 'created_at'))

  union all
  select '04', 'sarakkeet', 'time_entries: kuusi uutta saraketta', '6',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'time_entries'
             and column_name in ('project_id', 'routine_id', 'occurrence_date',
                                 'operation_id', 'started_at', 'ended_at'))

  union all
  select '05', 'sarakkeet', 'weekly_capacities.energy_budget_minutes on nullable', 'YES',
         (select coalesce(max(is_nullable), 'puuttuu') from information_schema.columns
           where table_schema = 'public' and table_name = 'weekly_capacities'
             and column_name = 'energy_budget_minutes')

  union all
  select '06', 'sarakkeet', 'alignment_reviews.policy_version NOT NULL, oletus 1', 'NO|1',
         (select coalesce(max(is_nullable || '|' || coalesce(column_default, '')), 'puuttuu')
            from information_schema.columns
           where table_schema = 'public' and table_name = 'alignment_reviews'
             and column_name = 'policy_version')

  union all
  select '07', 'sarakkeet', 'alignment_reviews.reflection_answers on jsonb NOT NULL', 'jsonb|NO',
         (select coalesce(max(data_type || '|' || is_nullable), 'puuttuu')
            from information_schema.columns
           where table_schema = 'public' and table_name = 'alignment_reviews'
             and column_name = 'reflection_answers')

  union all
  select '08', 'sarakkeet', 'Omistaja: user_id NOT NULL default auth.uid() molemmissa', '2',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public'
             and table_name in ('running_timers', 'alignment_item_settings')
             and column_name = 'user_id' and is_nullable = 'NO'
             and column_default like '%auth.uid()%')

  -- ================================================================
  -- RAJOITTEET
  -- ================================================================

  union all
  select '10', 'rajoitteet', 'Kaikki 24 uutta rajoitetta ovat olemassa', '24',
         (select count(*)::text from pg_constraint
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
             'alignment_item_settings_item_unique'))

  union all
  select '11', 'rajoitteet', 'Vanha time_entries_source_check on poistettu', '0',
         (select count(*)::text from pg_constraint where conname = 'time_entries_source_check')

  union all
  select '12', 'rajoitteet', 'Lahde sallii tasmalleen manual ja timer', 'true',
         (select coalesce(bool_and(pg_get_constraintdef(oid) like '%manual%'
                                   and pg_get_constraintdef(oid) like '%timer%'), false)::text
            from pg_constraint where conname = 'time_entries_source_v2_check')

  union all
  select '13', 'idempotenssi', 'Operaatiotunniste on uniikki kayttajaa kohti (user_id, operation_id)', 'true',
         (select coalesce(bool_and(pg_get_constraintdef(oid) = 'UNIQUE (user_id, operation_id)'), false)::text
            from pg_constraint where conname = 'time_entries_operation_unique')

  union all
  select '14', 'rajoitteet', 'Kuormittavuus on 1-5 tai tyhja', 'true',
         (select coalesce(bool_and(pg_get_constraintdef(oid) like '%energy_demand >= 1%'
                                   and pg_get_constraintdef(oid) like '%energy_demand <= 5%'), false)::text
            from pg_constraint where conname = 'alignment_item_settings_energy_check')

  union all
  select '15', 'rajoitteet', 'Yksi asetusrivi kohdetta kohti', 'true',
         (select coalesce(bool_and(pg_get_constraintdef(oid)
                   = 'UNIQUE (user_id, item_kind, item_id)'), false)::text
            from pg_constraint where conname = 'alignment_item_settings_item_unique')

  union all
  select '20', 'ajastin', 'YKSI AJASTIN KAYTTAJAA KOHTI: unique (user_id)', 'true',
         (select coalesce(bool_and(pg_get_constraintdef(oid) = 'UNIQUE (user_id)'), false)::text
            from pg_constraint where conname = 'running_timers_one_per_user')

  union all
  select '21', 'ajastin', 'Tauko ei ole negatiivinen', 'true',
         (select coalesce(bool_and(pg_get_constraintdef(oid) like '%paused_seconds >= 0%'), false)::text
            from pg_constraint where conname = 'running_timers_paused_check')

  union all
  select '22', 'omistajuus', 'Vierasavaimet ovat yhdistelmaavaimia (user_id, x)', '7',
         (select count(*)::text from pg_constraint
           where contype = 'f'
             and conname in ('time_entries_project_fkey', 'time_entries_routine_fkey',
                             'running_timers_life_area_fkey', 'running_timers_goal_fkey',
                             'running_timers_task_fkey', 'running_timers_project_fkey',
                             'running_timers_routine_fkey')
             and array_length(conkey, 1) = 2)

  union all
  select '24', 'omistajuus', 'Poisto nollaa vain oman sarakkeensa (ON DELETE SET NULL (x))', '7',
         (select count(*)::text from pg_constraint
           where conname in ('time_entries_project_fkey', 'time_entries_routine_fkey',
                             'running_timers_life_area_fkey', 'running_timers_goal_fkey',
                             'running_timers_task_fkey', 'running_timers_project_fkey',
                             'running_timers_routine_fkey')
             and confdeltype = 'n' and array_length(confdelsetcols, 1) = 1)

  union all
  -- TILIN POISTO VIE MYOS AJASTIMEN JA ASETUKSET. user_id-vierasavain
  -- auth.usersiin on CASCADE molemmissa uusissa tauluissa; muuten tilin
  -- poisto kaatuisi naihin tauluihin (sama kuin verify_0012 tarkistus 27).
  select '25', 'omistajuus', 'running_timers ja alignment_item_settings: user_id -> auth.users on CASCADE', '2',
         (select count(*)::text from pg_constraint
           where contype = 'f' and confdeltype = 'c'
             and confrelid = 'auth.users'::regclass
             and conrelid in (to_regclass('public.running_timers'),
                              to_regclass('public.alignment_item_settings')))

  union all
  -- MIGRAATIOIDEN 26 TAULUA (0001-0013, sama lista kuin tilin poiston
  -- ACCOUNT_DATA_MAP): yksikaan niiden vierasavain auth.usersiin ei saa
  -- olla muu kuin CASCADE. Muut public-taulut eivat ole migraatioiden
  -- tulosta eivatka kaada tata varmistusta: ne nakyvat rivilla 28.
  select '26', 'omistajuus', 'Migraatioiden 26 taulun jokainen vierasavain auth.usersiin on CASCADE', '0',
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
                               'alignment_reviews', 'alignment_item_settings', 'running_timers'))

  union all
  -- Ja jokaisella niista on sellainen: taulu ilman omistajan
  -- vierasavainta jaisi tilin poistossa jaljelle. Puuttuva taulu
  -- lasketaan myos (sillakaan ei ole avainta).
  select '27', 'omistajuus', 'Jokaisella migraatioiden 26 taululla on vierasavain auth.usersiin', '0',
         (select count(*)::text
            from unnest(array['tasks', 'routines', 'routine_exceptions', 'goals', 'projects',
                              'bills', 'recurring_expenses', 'savings_goals', 'wellbeing_entries',
                              'notification_preferences', 'profile', 'ai_action_audit',
                              'transactions', 'investments', 'milestones', 'inbox_items',
                              'reminders', 'notices', 'travel_plans', 'location_rules',
                              'life_areas', 'weekly_capacities', 'time_entries',
                              'alignment_reviews', 'alignment_item_settings', 'running_timers']) as t(nimi)
           where not exists (select 1 from pg_constraint f
                              join pg_class c on c.oid = f.conrelid
                             where c.relnamespace = 'public'::regnamespace and c.relname = t.nimi
                               and f.contype = 'f' and f.confrelid = 'auth.users'::regclass))

  union all
  -- MUUT PUBLIC-TAULUT (esim. Dashboardista luotu): tieto, ei poikkeama.
  -- Lukumaara ja nimet (rakenne, ei sisaltoa). preflight_0009 on jo
  -- pysaynyt junan, jos jonkin niista vierasavain auth.usersiin ei ole
  -- CASCADE.
  select '28', 'omistajuus', 'Muut public-taulut kuin migraatioiden 26 (INFO, eivat kuulu riveihin 26-27)', 'INFO',
         (select count(*)::text || coalesce(': ' || string_agg(c.relname::text, ', ' order by c.relname), '')
            from pg_class c
           where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
             and c.relname not in ('tasks', 'routines', 'routine_exceptions', 'goals', 'projects',
                                   'bills', 'recurring_expenses', 'savings_goals', 'wellbeing_entries',
                                   'notification_preferences', 'profile', 'ai_action_audit',
                                   'transactions', 'investments', 'milestones', 'inbox_items',
                                   'reminders', 'notices', 'travel_plans', 'location_rules',
                                   'life_areas', 'weekly_capacities', 'time_entries',
                                   'alignment_reviews', 'alignment_item_settings', 'running_timers'))

  -- ================================================================
  -- RLS JA OIKEUDET
  -- ================================================================

  union all
  select '30', 'rls', 'RLS paalla molemmissa uusissa tauluissa', '2',
         (select count(*)::text from pg_class
           where relnamespace = 'public'::regnamespace
             and relname in ('running_timers', 'alignment_item_settings')
             and relrowsecurity)

  union all
  select '31', 'rls', 'Kahdeksan politiikkaa, kaikki authenticated-roolille', '8',
         (select count(*)::text from pg_policies
           where schemaname = 'public'
             and tablename in ('running_timers', 'alignment_item_settings')
             and roles = '{authenticated}')

  union all
  select '32', 'rls', 'Jokainen politiikka rajaa omistajaan auth.uid() = user_id', '8',
         (select count(*)::text from pg_policies
           where schemaname = 'public'
             and tablename in ('running_timers', 'alignment_item_settings')
             and (coalesce(qual, '') like '%auth.uid() = user_id%'
                  or coalesce(with_check, '') like '%auth.uid() = user_id%'))

  union all
  select '33', 'oikeudet', 'anon: ei mitaan oikeutta', '0',
         (select count(*)::text from information_schema.role_table_grants
           where table_schema = 'public'
             and table_name in ('running_timers', 'alignment_item_settings')
             and grantee = 'anon')

  union all
  select '34', 'oikeudet', 'PUBLIC: ei mitaan oikeutta', '0',
         (select count(*)::text
            from pg_class c, lateral aclexplode(c.relacl) a
           where c.relnamespace = 'public'::regnamespace
             and c.relname in ('running_timers', 'alignment_item_settings')
             and a.grantee = 0)

  union all
  select '35', 'oikeudet', 'authenticated: select/insert/update/delete (8)', '8',
         (select count(*)::text from information_schema.role_table_grants
           where table_schema = 'public'
             and table_name in ('running_timers', 'alignment_item_settings')
             and grantee = 'authenticated'
             and privilege_type in ('SELECT', 'INSERT', 'UPDATE', 'DELETE'))

  union all
  select '36', 'liipaisimet', 'updated_at-liipaisin molemmissa tauluissa', '2',
         (select count(*)::text from pg_trigger
           where not tgisinternal
             and tgname in ('running_timers_touch_updated_at',
                            'alignment_item_settings_touch_updated_at'))

  -- ================================================================
  -- OLEMASSA OLEVA TILA KOSKEMATON
  -- ================================================================

  union all
  select '40', 'koskematon', 'tasks/goals/projects/routines: 16 politiikkaa kuten ennen', '16',
         (select count(*)::text from pg_policies
           where schemaname = 'public'
             and tablename in ('tasks', 'goals', 'projects', 'routines'))

  union all
  select '41', 'koskematon', 'tasks/goals/projects/routines: ei uusia sarakkeita energiasta', '0',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public'
             and table_name in ('tasks', 'goals', 'projects', 'routines')
             and column_name in ('energy_demand', 'alignment_opt_out', 'estimate_approximate'))

  union all
  select '50', 'rivit', 'running_timers: riveja (INFO, tuore ajo = 0)', 'INFO',
         (select count(*)::text from public.running_timers)

  union all
  select '51', 'rivit', 'alignment_item_settings: riveja (INFO, tuore ajo = 0)', 'INFO',
         (select count(*)::text from public.alignment_item_settings)

) c
order by c.check_no;
