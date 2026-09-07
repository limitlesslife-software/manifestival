-- Predeploy: ENNEN lipun TASK_EXTENDED_FIELDS kaantamista
-- VAIN LUKEVA. Yksi lause, yksi taulukko, yksi kopiointi.
--
-- MILLOIN: runbookin GATE B, ennen koodin julkaisua ja ennen lipun
-- kaantamista. Tama vastaa kysymykseen "kestaako tuotanto sen, etta
-- sovellus alkaa kirjoittaa kuuteen uuteen sarakkeeseen".
--
-- MITA TAMA EI VOI NAHDA: lipun arvo on sovelluksen koodissa
-- (src/data/schema.js), ei kannassa. SQL ei voi tarkistaa sita. Lipun
-- tila todetaan julkaistusta koodista, ei taalta.
--
-- ODOTUS: jokaisen PASS/FAIL-rivin status = 'PASS' ja
-- poikkeavia_yhteensa = 0. INFO-rivit ovat kirjattavia lukuja.
--
-- Tama tiedosto EI lue kayttajan sisaltoa. Se laskee rivimaaria ja
-- katsoo rakennetta.

select c.check_no,
       c.section,
       c.check_name,
       case when c.odotus = 'INFO'      then 'INFO'
            when c.toteutui = c.odotus  then 'PASS'
            else 'FAIL' end as status,
       case when c.odotus = 'INFO' then c.toteutui
            else 'odotus ' || c.odotus || ', toteutui ' || c.toteutui end as details,
       count(*) filter (where c.odotus <> 'INFO' and c.toteutui <> c.odotus)
         over () as poikkeavia_yhteensa
from (

  -- ================================================================
  -- SKEEMA — 0002:n tulos on yha voimassa
  -- ================================================================

  select '01' as check_no, 'skeema' as section,
         'Kuusi laajennettua saraketta on olemassa' as check_name,
         '6' as odotus,
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'tasks'
             and column_name in ('description', 'duration_minutes', 'priority',
                                 'scheduling_state', 'created_at', 'updated_at')) as toteutui

  union all
  select '02', 'skeema', 'Sarakkeiden tyypit ovat odotetut', '6',
         (select count(*)::text
            from information_schema.columns col
            join (values
                    ('description',      'text'),
                    ('duration_minutes', 'integer'),
                    ('priority',         'text'),
                    ('scheduling_state', 'text'),
                    ('created_at',       'timestamp with time zone'),
                    ('updated_at',       'timestamp with time zone')
                 ) e(sarake, tyyppi)
              on e.sarake = col.column_name and e.tyyppi = col.data_type
           where col.table_schema = 'public' and col.table_name = 'tasks')

  union all
  -- Sovellus alkaa lahettaa priority- ja scheduling_state-sarakkeet.
  -- Molemmat ovat NOT NULL, ja nimenomainen null EI ota oletusarvoa
  -- kayttoon vaan hylkaa rivin. Siksi naiden kahden on oltava
  -- tasmalleen odotetussa tilassa ennen kuin lippu kaantyy.
  select '03', 'skeema', 'Pakolliset sarakkeet ovat NOT NULL', '4',
         (select count(*)::text
            from information_schema.columns col
           where col.table_schema = 'public' and col.table_name = 'tasks'
             and col.is_nullable = 'NO'
             and col.column_name in ('priority', 'scheduling_state',
                                     'created_at', 'updated_at'))

  union all
  select '04', 'skeema', 'Vapaaehtoiset sarakkeet sallivat nullin', '2',
         (select count(*)::text
            from information_schema.columns col
           where col.table_schema = 'public' and col.table_name = 'tasks'
             and col.is_nullable = 'YES'
             and col.column_name in ('description', 'duration_minutes'))

  union all
  select '05', 'skeema', 'Oletusarvot ovat odotetut neljalla sarakkeella', '4',
         (select count(*)::text
            from information_schema.columns col
           where col.table_schema = 'public' and col.table_name = 'tasks'
             and ((col.column_name = 'priority'         and col.column_default like '%normaali%')
               or (col.column_name = 'scheduling_state' and col.column_default like '%manual%')
               or (col.column_name = 'created_at'       and col.column_default like 'now()%')
               or (col.column_name = 'updated_at'       and col.column_default like 'now()%')))

  union all
  select '06', 'skeema', 'Kolme tarkistetta on olemassa oikein ehdoin', '3',
         (select count(*)::text from pg_constraint
           where conrelid = 'public.tasks'::regclass and contype = 'c'
             and ((conname = 'tasks_priority_check'
                   and pg_get_constraintdef(oid) like '%korkea%'
                   and pg_get_constraintdef(oid) like '%normaali%'
                   and pg_get_constraintdef(oid) like '%matala%')
               or (conname = 'tasks_scheduling_state_check'
                   and pg_get_constraintdef(oid) like '%manual%'
                   and pg_get_constraintdef(oid) like '%auto%'
                   and pg_get_constraintdef(oid) like '%unscheduled%')
               or (conname = 'tasks_duration_minutes_check'
                   and pg_get_constraintdef(oid) like '%1440%')))

  union all
  -- Sovellus ei kirjoita aikaleimoja. created_at tulee oletusarvosta ja
  -- updated_at liipaisimesta. Jos liipaisin puuttuisi, updated_at jaisi
  -- luontihetkeen eika kertoisi mitaan.
  select '07', 'skeema', 'Liipaisin on rivikohtainen BEFORE UPDATE', '1',
         (select count(*)::text from pg_trigger
           where tgrelid = 'public.tasks'::regclass
             and tgname = 'tasks_touch_updated_at'
             and not tgisinternal
             and (tgtype & 1) = 1 and (tgtype & 2) = 2 and (tgtype & 16) = 16
             and tgfoid = 'public.touch_updated_at'::regproc)

  union all
  select '08', 'skeema', 'Liipaisinfunktio ei ole SECURITY DEFINER ja polku on kiinnitetty', '1',
         (select count(*)::text
            from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'touch_updated_at'
             and p.prosecdef = false
             and array_to_string(coalesce(p.proconfig, array[]::text[]), ',') like '%search_path=%')

  union all
  -- Paivanakyma suodattaa omistajalla ja paivalla ja jarjestaa
  -- prioriteetilla. Sarakkeet luetaan indeksista, ei nimesta.
  select '09', 'skeema', 'Indeksi (user_id, date, priority) on olemassa', '1',
         (select count(*)::text
            from pg_index x
            join pg_class ic on ic.oid = x.indexrelid
            join pg_class t on t.oid = x.indrelid
            join pg_namespace n on n.oid = t.relnamespace
           where n.nspname = 'public' and t.relname = 'tasks'
             and ic.relname = 'tasks_user_date_priority_idx'
             and (select array_agg(a.attname::text order by k.ord)
                    from unnest(x.indkey::int2[]) with ordinality as k(attnum, ord)
                    join pg_attribute a on a.attrelid = t.oid and a.attnum = k.attnum)
                 = array['user_id', 'date', 'priority'])

  -- ================================================================
  -- DATA — mikaan olemassa oleva rivi ei riko uusia sarakkeita
  -- ================================================================

  union all
  select '10', 'data', 'Tehtavia on 36', '36',
         (select count(*)::text from public.tasks)

  union all
  select '11', 'data', 'Yhtaan tehtavaa ei omista joku muu kuin hyvaksytty omistaja', '0',
         (select count(*)::text from public.tasks
           where user_id is distinct from '2cc00622-f927-4604-a518-361a4328481b'::uuid)

  union all
  select '12', 'data', 'Orpoja omistajaviittauksia ei ole', '0',
         (select count(*)::text
            from public.tasks t left join auth.users u on u.id = t.user_id
           where u.id is null)

  union all
  select '13', 'data', 'Pakollisissa sarakkeissa ei ole tyhjia arvoja', '0',
         (select count(*)::text from public.tasks
           where priority is null or scheduling_state is null
              or created_at is null or updated_at is null)

  union all
  select '14', 'data', 'Yhdellakaan rivilla ei ole kelvotonta prioriteettia', '0',
         (select count(*)::text from public.tasks
           where priority not in ('korkea', 'normaali', 'matala'))

  union all
  select '15', 'data', 'Yhdellakaan rivilla ei ole kelvotonta aikataulutustilaa', '0',
         (select count(*)::text from public.tasks
           where scheduling_state not in ('manual', 'auto', 'unscheduled'))

  union all
  -- Sovellus ei kirjoita yli vuorokauden kestoja (validateTask), mutta
  -- jos jokin rivi rikkoisi rajan jo nyt, se paljastuisi vasta seuraavassa
  -- kirjoituksessa rajoitevirheena.
  select '16', 'data', 'Yhdellakaan rivilla ei ole kelvotonta kestoa', '0',
         (select count(*)::text from public.tasks
           where duration_minutes is not null
             and (duration_minutes <= 0 or duration_minutes > 1440))

  union all
  -- Kellonajaton rivi ei ole aikataulutettu. Jos suhde on vaara,
  -- automaatti saa luvan siirtaa jotain, minka kayttaja on itse
  -- paattanyt — ja lipun kaantamisen jalkeen se on pysyvaa.
  select '17', 'data', 'Kellonajattomat rivit ovat aikatauluttamattomia', '0',
         (select count(*)::text from public.tasks
           where "time" is null and scheduling_state <> 'unscheduled')

  -- ================================================================
  -- TURVA — 0001:n takeet ovat yha voimassa
  -- ================================================================

  union all
  select '18', 'turva', 'RLS on paalla molemmissa tauluissa', '2',
         (select count(*)::text from pg_class
           where relnamespace = 'public'::regnamespace
             and relname in ('tasks', 'profile') and relrowsecurity)

  union all
  select '19', 'turva', 'Kahdeksan omistajuuspolitiikkaa on tallella oikein ehdoin', '8',
         (select count(*)::text
            from pg_policies p
            join (values
                    ('tasks',   'tasks_select_own',   'SELECT', 'auth.uid()=user_id', ''),
                    ('tasks',   'tasks_insert_own',   'INSERT', '',                   'auth.uid()=user_id'),
                    ('tasks',   'tasks_update_own',   'UPDATE', 'auth.uid()=user_id', 'auth.uid()=user_id'),
                    ('tasks',   'tasks_delete_own',   'DELETE', 'auth.uid()=user_id', ''),
                    ('profile', 'profile_select_own', 'SELECT', 'auth.uid()=id',      ''),
                    ('profile', 'profile_insert_own', 'INSERT', '',                   'auth.uid()=id'),
                    ('profile', 'profile_update_own', 'UPDATE', 'auth.uid()=id',      'auth.uid()=id'),
                    ('profile', 'profile_delete_own', 'DELETE', 'auth.uid()=id',      '')
                 ) e(tbl, pol, operaatio, q, wc)
              on e.tbl = p.tablename and e.pol = p.policyname and e.operaatio = p.cmd
             and btrim(replace(coalesce(p.qual, ''), ' ', ''), '()') = e.q
             and btrim(replace(coalesce(p.with_check, ''), ' ', ''), '()') = e.wc
           where p.schemaname = 'public' and p.roles = '{authenticated}'::name[])

  union all
  select '20', 'turva', 'anon-roolilla ei ole tehollista oikeutta tauluun tasks', '0',
         (select count(*)::text
            from (select unnest(array['select', 'insert', 'update', 'delete',
                                      'truncate', 'references', 'trigger']) as oikeus) pp
           where has_table_privilege('anon', 'public.tasks', pp.oikeus))

  union all
  -- Sarakekohtainen oikeus voi olla olemassa vaikka taulukohtaista ei
  -- ole. Uudet sarakkeet ovat juuri se paikka, jossa sellainen syntyisi.
  select '21', 'turva', 'anon-roolilla ei ole sarakekohtaista oikeutta uusiin sarakkeisiin', '0',
         (select count(*)::text
            from unnest(array['description', 'duration_minutes', 'priority',
                              'scheduling_state', 'created_at', 'updated_at']) as sarake
           where has_column_privilege('anon', 'public.tasks', sarake, 'select')
              or has_column_privilege('anon', 'public.tasks', sarake, 'insert')
              or has_column_privilege('anon', 'public.tasks', sarake, 'update'))

  union all
  select '22', 'turva', 'authenticated-roolilla on tasan CRUD tauluun tasks', '4',
         (select count(*)::text
            from (select unnest(array['select', 'insert', 'update', 'delete',
                                      'truncate', 'references', 'trigger']) as oikeus) pp
           where has_table_privilege('authenticated', 'public.tasks', pp.oikeus))

  union all
  select '23', 'turva', 'PUBLIC-roolilla ei ole oikeuksia tauluun tasks', '0',
         (select count(*)::text
            from pg_class cl, aclexplode(cl.relacl) acl
           where cl.oid = 'public.tasks'::regclass and acl.grantee = 0)

  -- ================================================================
  -- RAJAUS — vain 0002 on ajettu, ei mitaan myohempaa
  -- ================================================================

  union all
  -- Lipun kaantaminen koskee VAIN tehtavien lisakenttia. Jos jokin
  -- myohempi migraatio olisi ajettu vahingossa, sen taulut olisivat
  -- olemassa ilman vastaavaa lippua — ja se on eri paatos.
  select '24', 'rajaus', 'Migraatioiden 0003-0008 tauluja ei ole olemassa', '0',
         (select count(*)::text from pg_tables
           where schemaname = 'public'
             and tablename in ('routines', 'routine_exceptions', 'goals', 'projects',
                               'notification_preferences', 'wellbeing_entries', 'bills',
                               'recurring_expenses', 'savings_goals', 'ai_action_audit'))

  -- ================================================================
  -- KIRJATTAVAT LUVUT
  -- ================================================================

  union all
  select '25', 'kirjattavat', 'Rivit tilassa manual', 'INFO',
         (select count(*)::text from public.tasks where scheduling_state = 'manual')

  union all
  select '26', 'kirjattavat', 'Rivit tilassa unscheduled', 'INFO',
         (select count(*)::text from public.tasks where scheduling_state = 'unscheduled')

  union all
  select '27', 'kirjattavat', 'Rivit tilassa auto', 'INFO',
         (select count(*)::text from public.tasks where scheduling_state = 'auto')

  union all
  -- Nama ovat nolla ennen aktivointia: sovellus ei ole viela
  -- kirjoittanut naihin sarakkeisiin. Aktivoinnin jalkeen luvun on
  -- kasvettava — se on ainoa kannasta nakyva todiste siita, etta lippu
  -- oikeasti kaantyi.
  select '28', 'kirjattavat', 'Rivit joilla on kuvaus', 'INFO',
         (select count(*)::text from public.tasks where description is not null)

  union all
  select '29', 'kirjattavat', 'Rivit joilla on kesto', 'INFO',
         (select count(*)::text from public.tasks where duration_minutes is not null)

  union all
  select '30', 'kirjattavat', 'Rivit joilla on muu kuin oletusprioriteetti', 'INFO',
         (select count(*)::text from public.tasks where priority <> 'normaali')

) c
order by c.check_no;
