-- Palautumisen tilannekuva: ENNEN migraatiota 0003
-- VAIN LUKEVA. Yksi lause, yksi taulukko, yksi kopiointi.
--
-- MIKSI TAMA ON OLEMASSA
--
-- Aja tama juuri ennen 0003:a ja SAILYTA TULOS. Jos migraatio joudutaan
-- perumaan, tama on ainoa asiakirja, joka kertoo mihin tilaan piti
-- palata — ja ennen kaikkea sen, ETTEI mikaan olemassa oleva muuttunut.
--
-- 0003 luo vain uusia tauluja eika koske tasks- tai profile-tauluun.
-- Tama tilannekuva on siis ennen kaikkea TODISTE SIITA: sormenjaljet
-- 15-18 ovat samat ennen ja jalkeen, tai jokin meni pieleen.
--
-- MITA TAMA EI OLE
--
-- Tama EI ole varmuuskopio. Se ei sisalla yhtaan riviarvoa eika siita
-- voi rakentaa dataa uudelleen. Se todistaa RAKENTEEN ja LUKUMAARAT.
-- Rivien sisalto on fyysisen varmuuskopion varassa — ota sellainen
-- ennen migraatiota.
--
-- Viimeisin tiedetty toimiva tuotantoversio: manifestival-prod-v1
-- (81b85e3678ba9f8a6375fa42db0fbbda6851ea8f).
--
-- ODOTUS: jokaisen PASS/FAIL-rivin status = 'PASS' ja
-- poikkeavia_yhteensa = 0. INFO-rivit kirjataan ja verrataan
-- migraation jalkeen.

select c.check_no, c.section, c.check_name,
       case when c.odotus = 'INFO' then 'INFO'
            when c.toteutui = c.odotus then 'PASS' else 'FAIL' end as status,
       case when c.odotus = 'INFO' then c.toteutui
            else 'odotus ' || c.odotus || ', toteutui ' || c.toteutui end as details,
       count(*) filter (where c.odotus <> 'INFO' and c.toteutui <> c.odotus)
         over () as poikkeavia_yhteensa
from (

  -- ================================================================
  -- TUNNISTE
  -- ================================================================

  select '01' as check_no, 'tunniste' as section,
         'Tilannekuvan hetki (UTC)' as check_name,
         'INFO' as odotus,
         to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS') as toteutui

  union all
  select '02', 'tunniste', 'Tietokanta', 'INFO', current_database()

  union all
  select '03', 'tunniste', 'Tilannekuvan tunniste', 'INFO',
         md5(to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS')
             || ':' || (select count(*) from public.tasks)::text
             || ':' || (select count(*) from pg_tables where schemaname = 'public')::text)

  -- ================================================================
  -- LAHTOTILA — mitaan 0003:n objektia ei viela ole
  -- ================================================================

  union all
  select '04', 'lahtotila', 'Tauluja routines ja routine_exceptions ei ole', '0',
         (select count(*)::text from pg_tables
           where schemaname = 'public'
             and tablename in ('routines', 'routine_exceptions'))

  union all
  select '05', 'lahtotila', 'Migraatioiden 0004-0008 tauluja ei ole', '0',
         (select count(*)::text from pg_tables
           where schemaname = 'public'
             and tablename in ('goals', 'projects', 'notification_preferences',
                               'wellbeing_entries', 'bills', 'recurring_expenses',
                               'savings_goals', 'ai_action_audit'))

  union all
  select '06', 'lahtotila', 'Tehtavia on 36', '36',
         (select count(*)::text from public.tasks)

  union all
  select '07', 'lahtotila', 'Profiilirivien maara on 1', '1',
         (select count(*)::text from public.profile)

  union all
  select '08', 'lahtotila', 'Auth-kayttajia on 1', '1',
         (select count(*)::text from auth.users)

  union all
  select '09', 'lahtotila', 'Omistajattomia tai orpoja tehtavia ei ole', '0',
         ((select count(*) from public.tasks where user_id is null)
        + (select count(*) from public.tasks t
             left join auth.users u on u.id = t.user_id where u.id is null))::text

  union all
  select '10', 'lahtotila', 'RLS on paalla tauluissa tasks ja profile', '2',
         (select count(*)::text from pg_class
           where relnamespace = 'public'::regnamespace
             and relname in ('tasks', 'profile') and relrowsecurity)

  union all
  select '11', 'lahtotila', 'Kahdeksan omistajuuspolitiikkaa on tallella', '8',
         (select count(*)::text from pg_policies
           where schemaname = 'public' and tablename in ('tasks', 'profile'))

  union all
  select '12', 'lahtotila', 'anon-roolilla ei ole tehollista oikeutta tauluun tasks', '0',
         (select count(*)::text
            from (select unnest(array['select', 'insert', 'update', 'delete',
                                      'truncate', 'references', 'trigger']) as oikeus) pp
           where has_table_privilege('anon', 'public.tasks', pp.oikeus))

  union all
  select '13', 'lahtotila', 'PUBLIC-roolilla ei ole oikeuksia tauluun tasks', '0',
         (select count(*)::text
            from pg_class cl, aclexplode(cl.relacl) acl
           where cl.oid = 'public.tasks'::regclass and acl.grantee = 0)

  union all
  select '14', 'lahtotila', 'Funktio touch_updated_at on kovennettu', '1',
         (select count(*)::text
            from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'touch_updated_at'
             and p.prosecdef = false
             and array_to_string(coalesce(p.proconfig, array[]::text[]), ',') like '%search_path=%')

  -- ================================================================
  -- SORMENJALJET — naiden on oltava SAMAT migraation jalkeen
  --
  -- 0003 ei koske olemassa olevaan dataan eika 0001/0002:n rakenteisiin.
  -- Jos jokin naista muuttuu, migraatio teki jotain mita sen ei pitanyt.
  -- Tiivisteet ovat yksisuuntaisia: ne todistavat samuuden paljastamatta
  -- sisaltoa.
  -- ================================================================

  union all
  select '15', 'sormenjalki', 'Tehtavien tunnisteiden tiiviste', 'INFO',
         (select coalesce(md5(string_agg(id, '|' order by id)), 'tyhja')
            from public.tasks)

  union all
  select '16', 'sormenjalki', 'Tehtavarivien rakenteellinen tiiviste', 'INFO',
         (select coalesce(md5(string_agg(
                   id || '|' || coalesce("date"::text, '-')
                      || '|' || coalesce(user_id::text, '-')
                      || '|' || priority
                      || '|' || scheduling_state,
                   '#' order by id)), 'tyhja')
            from public.tasks)

  union all
  select '17', 'sormenjalki', 'tasks-taulun skeeman tiiviste', 'INFO',
         (select md5(string_agg(
                   column_name || ':' || data_type || ':' || is_nullable
                     || ':' || coalesce(column_default, '-'),
                   '|' order by column_name))
            from information_schema.columns
           where table_schema = 'public' and table_name = 'tasks')

  union all
  select '18', 'sormenjalki', 'Politiikkojen tiiviste (tasks + profile)', 'INFO',
         (select md5(string_agg(
                   tablename || ':' || policyname || ':' || cmd
                     || ':' || coalesce(qual, '-')
                     || ':' || coalesce(with_check, '-'),
                   '|' order by tablename, policyname))
            from pg_policies
           where schemaname = 'public' and tablename in ('tasks', 'profile'))

  -- ================================================================
  -- KIRJATTAVAT LUVUT
  -- ================================================================

  union all
  select '19', 'kirjattavat', 'Tauluja public-skeemassa', 'INFO',
         (select count(*)::text from pg_tables where schemaname = 'public')

  union all
  select '20', 'kirjattavat', 'Politiikkoja public-skeemassa', 'INFO',
         (select count(*)::text from pg_policies where schemaname = 'public')

  union all
  select '21', 'kirjattavat', 'Indekseja public-skeemassa', 'INFO',
         (select count(*)::text from pg_indexes where schemaname = 'public')

  union all
  select '22', 'kirjattavat', 'Liipaisimia public-skeemassa', 'INFO',
         (select count(*)::text from pg_trigger tg
            join pg_class c on c.oid = tg.tgrelid
            join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and not tg.tgisinternal)

) c
order by c.check_no;
