-- Preflight: ENNEN migraatiota 0003
-- VAIN LUKEVA. Yksi lause, yksi taulukko, yksi kopiointi.
--
-- MILLOIN: juuri ennen kuin 0003 ajetaan. Vastaa kysymykseen "onko
-- tuotanto siina tilassa, jota 0003 olettaa" — ennen kuin 0003 itse sen
-- paattaa ja keskeytyy.
--
-- ODOTUS: jokaisen PASS/FAIL-rivin status = 'PASS' ja
-- poikkeavia_yhteensa = 0. INFO-rivit ovat kirjattavia lukuja.
--
-- Tama tiedosto EI lue kayttajan sisaltoa.

select c.check_no, c.section, c.check_name,
       case when c.odotus = 'INFO' then 'INFO'
            when c.toteutui = c.odotus then 'PASS' else 'FAIL' end as status,
       case when c.odotus = 'INFO' then c.toteutui
            else 'odotus ' || c.odotus || ', toteutui ' || c.toteutui end as details,
       count(*) filter (where c.odotus <> 'INFO' and c.toteutui <> c.odotus)
         over () as poikkeavia_yhteensa
from (

  -- ================================================================
  -- 0001 JA 0002 OVAT YHA VOIMASSA
  -- ================================================================

  select '01' as check_no, '0001' as section,
         'Omistajasarake tasks.user_id on olemassa' as check_name,
         '1' as odotus,
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'tasks'
             and column_name = 'user_id') as toteutui

  union all
  select '02', '0001', 'RLS on paalla tauluissa tasks ja profile', '2',
         (select count(*)::text from pg_class
           where relnamespace = 'public'::regnamespace
             and relname in ('tasks', 'profile') and relrowsecurity)

  union all
  select '03', '0001', 'Kahdeksan omistajuuspolitiikkaa on tallella', '8',
         (select count(*)::text from pg_policies
           where schemaname = 'public' and tablename in ('tasks', 'profile'))

  union all
  select '04', '0001', 'Hyvaksytty omistaja loytyy auth.users-taulusta', '1',
         (select count(*)::text from auth.users
           where id = '2cc00622-f927-4604-a518-361a4328481b'::uuid)

  union all
  select '05', '0002', 'Kuusi laajennettua saraketta on olemassa', '6',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'tasks'
             and column_name in ('description', 'duration_minutes', 'priority',
                                 'scheduling_state', 'created_at', 'updated_at'))

  union all
  -- 0003 luo funktiolle touch_updated_at uudet liipaisimet. Funktio on
  -- 0002:n luoma, ja sen kovennuksen on oltava voimassa: 0003 luo sen
  -- uudelleen `create or replace` -lauseella samalla maarittelylla.
  select '06', '0002', 'Funktio touch_updated_at on kovennettu', '1',
         (select count(*)::text
            from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'touch_updated_at'
             and p.prosecdef = false
             and array_to_string(coalesce(p.proconfig, array[]::text[]), ',') like '%search_path=%')

  -- ================================================================
  -- 0003:N OMAT OBJEKTIT PUUTTUVAT
  -- ================================================================

  union all
  -- Kaksikymmentaviisi objektia: 2 taulua, 9 tarkistetta, 2
  -- yksikasitteisyysrajoitetta, 2 indeksia, 2 liipaisinta, 8
  -- politiikkaa. Nolla = tuore ajo. Mika tahansa muu luku tarkoittaa,
  -- etta 0003 on ajettu tai jaanyt kesken.
  select '07', '0003-tila', 'Yhtaan 0003:n objektia ei ole olemassa', '0',
         (select count(*)::text from (
            select 1 from pg_tables
              where schemaname = 'public' and tablename in ('routines', 'routine_exceptions')
            union all
            select 1 from pg_constraint
              where conname in ('routines_recurrence_type_check', 'routines_scheduling_check',
                                'routines_priority_check', 'routines_duration_check',
                                'routines_title_check', 'routines_date_range_check',
                                'routines_weekdays_check', 'routine_exceptions_type_check',
                                'routine_exceptions_duration_check',
                                'routine_exceptions_unique_day', 'routines_owner_row_key')
            union all
            select 1 from pg_indexes
              where schemaname = 'public'
                and indexname in ('routines_user_active_idx', 'routine_exceptions_user_date_idx')
            union all
            select 1 from pg_trigger
              where not tgisinternal
                and tgname in ('routines_touch_updated_at', 'routine_exceptions_touch_updated_at')
            union all
            select 1 from pg_policies
              where schemaname = 'public' and tablename in ('routines', 'routine_exceptions')
          ) objektit)

  union all
  -- 0004-0008 ovat ajamatta. 0003 ei riipu niista, mutta jos jokin
  -- niista olisi ajettu, kannan tila ei ole se jota tama olettaa.
  select '08', '0003-tila', 'Migraatioiden 0004-0008 tauluja ei ole olemassa', '0',
         (select count(*)::text from pg_tables
           where schemaname = 'public'
             and tablename in ('goals', 'projects', 'notification_preferences',
                               'wellbeing_entries', 'bills', 'recurring_expenses',
                               'savings_goals', 'ai_audit'))

  -- ================================================================
  -- OLEMASSA OLEVA DATA
  -- ================================================================

  union all
  select '09', 'data', 'Tehtavia on 36', '36',
         (select count(*)::text from public.tasks)

  union all
  select '10', 'data', 'Profiilirivien maara on 1', '1',
         (select count(*)::text from public.profile)

  union all
  select '11', 'data', 'Auth-kayttajia on 1', '1',
         (select count(*)::text from auth.users)

  union all
  select '12', 'data', 'Omistajattomia tehtavia ei ole', '0',
         (select count(*)::text from public.tasks where user_id is null)

  union all
  select '13', 'data', 'Orpoja omistajaviittauksia ei ole', '0',
         (select count(*)::text
            from public.tasks t left join auth.users u on u.id = t.user_id
           where u.id is null)

  union all
  select '14', 'data', 'Yhtaan tehtavaa ei omista odottamaton kayttaja', '0',
         (select count(*)::text from public.tasks
           where user_id is distinct from '2cc00622-f927-4604-a518-361a4328481b'::uuid)

  -- ================================================================
  -- OIKEUDET
  -- ================================================================

  union all
  select '15', 'oikeudet', 'anon-roolilla ei ole tehollista oikeutta tauluun tasks', '0',
         (select count(*)::text
            from (select unnest(array['select', 'insert', 'update', 'delete',
                                      'truncate', 'references', 'trigger']) as oikeus) pp
           where has_table_privilege('anon', 'public.tasks', pp.oikeus))

  union all
  select '16', 'oikeudet', 'authenticated-roolilla on tasan CRUD tauluun tasks', '4',
         (select count(*)::text
            from (select unnest(array['select', 'insert', 'update', 'delete',
                                      'truncate', 'references', 'trigger']) as oikeus) pp
           where has_table_privilege('authenticated', 'public.tasks', pp.oikeus))

  union all
  select '17', 'oikeudet', 'PUBLIC-roolilla ei ole oikeuksia tauluun tasks', '0',
         (select count(*)::text
            from pg_class cl, aclexplode(cl.relacl) acl
           where cl.oid = 'public.tasks'::regclass and acl.grantee = 0)

  union all
  -- 0003 luo uudet taulut ja luottaa siihen, etta oletusoikeudet eivat
  -- myonna niille mitaan PUBLICille. Tama tarkistaa sen ETUKATEEN:
  -- jos oletusoikeuksissa on PUBLIC-myonto, uudet taulut syntyisivat
  -- avoimina ja `revoke ... from anon` ei sita korjaisi.
  select '18', 'oikeudet', 'Oletusoikeuksissa ei ole PUBLIC-myontoja', '0',
         (select count(*)::text
            from pg_default_acl d, aclexplode(d.defaclacl) acl
           where acl.grantee = 0)

  union all
  select '19', 'oikeudet', 'Oletusoikeuksissa ei ole anon-myontoja', '0',
         (select count(*)::text
            from pg_default_acl d, aclexplode(d.defaclacl) acl
            join pg_roles r on r.oid = acl.grantee
           where r.rolname = 'anon')

  -- ================================================================
  -- ESTEET
  -- ================================================================

  union all
  -- 0003 ottaa auth.users-tauluun SHARE ROW EXCLUSIVE -lukon
  -- vierasavaimia luodessaan. auth.users on taulu, jota jokainen
  -- kirjautuminen koskee, joten avoin transaktio siella on este.
  select '20', 'esteet', 'Avoimia idle in transaction -istuntoja ei ole', '0',
         (select count(*)::text from pg_stat_activity
           where datname = current_database()
             and state in ('idle in transaction', 'idle in transaction (aborted)')
             and pid <> pg_backend_pid())

  union all
  select '21', 'esteet', 'Yli minuutin kestaneita kyselyita ei ole kaynnissa', '0',
         (select count(*)::text from pg_stat_activity
           where datname = current_database()
             and state = 'active' and pid <> pg_backend_pid()
             and now() - query_start > interval '1 minute')

  -- ================================================================
  -- KIRJATTAVAT LUVUT
  -- ================================================================

  union all
  select '22', 'kirjattavat', 'Tarkistuksen hetki (UTC)', 'INFO',
         to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS')

  union all
  select '23', 'kirjattavat', 'Tietokanta', 'INFO', current_database()

  union all
  select '24', 'kirjattavat', 'Tehtavien tunnisteiden tiiviste', 'INFO',
         (select coalesce(md5(string_agg(id, '|' order by id)), 'tyhja')
            from public.tasks)

  union all
  select '25', 'kirjattavat', 'Tauluja public-skeemassa', 'INFO',
         (select count(*)::text from pg_tables where schemaname = 'public')

  union all
  select '26', 'kirjattavat', 'Politiikkoja public-skeemassa', 'INFO',
         (select count(*)::text from pg_policies where schemaname = 'public')

) c
order by c.check_no;
