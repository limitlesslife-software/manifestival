-- Loppuvarmistus: KOKO ERÄ 0004–0008
-- VAIN LUKEVA. Yksi lause, yksi taulukko, yksi kopiointi.
--
-- MILLOIN: kun kaikki viisi migraatiota on ajettu ja jokaisen oma
-- varmistus (verify_0004.sql ... verify_0008.sql) on antanut PASSin.
--
-- MIKSI ERIKSEEN, VAIKKA JOKAISELLA ON JO OMANSA
-- Migraatiokohtainen varmistus katsoo yhtä migraatiota. Se ei näe
-- kokonaisuutta, ja juuri kokonaisuudessa on tämän erän riski:
--
--   * Viitteitä on yhdeksän ja ne syntyvät KOLMESSA eri migraatiossa
--     (0003, 0004, 0007). Yksikään migraatio ei näe niitä kaikkia.
--   * 0004 ja 0007 koskevat molemmat tuotannon tasks-tauluun. Kumpikin
--     varmistaa oman muutoksensa; kumpikaan ei sitä, mitä tasks-taulusta
--     tuli yhteensä.
--   * Funktio touch_updated_at on yhteinen. Yksi migraatio voi korvata
--     sen kovettamattomana, ja seuraava migraatio ei huomaisi.
--
-- Tämä varmistus katsoo lopputilaa. Se ei toista migraatiokohtaisia
-- tarkistuksia vaan kysyy, mitä kannassa on NYT.
--
-- ODOTUS: jokaisen PASS/FAIL-rivin status = 'PASS' ja
-- poikkeavia_yhteensa = 0.
--
-- YKSIKIN FAIL = YHTÄKÄÄN PORTTIA EI KÄÄNNETÄ.
--
-- Tämä ei vielä riitä porttien avaamiseen. Sitä ennen ajetaan
-- hyväksyntätesti (tools/rls-acceptance) oikealla käyttäjällä B ja sen
-- jälkeen supabase/acceptance/verify_0003_0008_acceptance.sql.
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
  -- KOKO ERÄ ON AJETTU
  -- ================================================================

  select '01' as check_no, 'era' as section,
         'Kaikki kahdeksan uutta taulua ovat olemassa' as check_name,
         '8' as odotus,
         (select count(*)::text from pg_tables
           where schemaname = 'public'
             and tablename in ('goals', 'projects', 'notification_preferences',
                               'wellbeing_entries', 'bills', 'recurring_expenses',
                               'savings_goals', 'ai_action_audit')) as toteutui

  union all
  select '02', 'era', 'Migraation 0003 taulut ovat olemassa', '2',
         (select count(*)::text from pg_tables
           where schemaname = 'public'
             and tablename in ('routines', 'routine_exceptions'))

  union all
  select '03', 'era', 'Kolme uutta saraketta on tasks-taulussa', '3',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'tasks'
             and column_name in ('deadline', 'goal_id', 'project_id'))

  union all
  -- Nelja + kolmekymmentakuusi = neljakymmentä. Jokaisella
  -- kymmenella taululla on nelja politiikkaa.
  select '04', 'era', 'Kaikilla kymmenella taululla on nelja politiikkaa', '40',
         (select count(*)::text from pg_policies
           where schemaname = 'public'
             and tablename in ('routines', 'routine_exceptions',
                               'goals', 'projects', 'notification_preferences',
                               'wellbeing_entries', 'bills', 'recurring_expenses',
                               'savings_goals', 'ai_action_audit'))

  union all
  select '05', 'era', 'RLS on paalla kaikissa kymmenessa taulussa', '10',
         (select count(*)::text from pg_class
           where relnamespace = 'public'::regnamespace
             and relname in ('routines', 'routine_exceptions',
                             'goals', 'projects', 'notification_preferences',
                             'wellbeing_entries', 'bills', 'recurring_expenses',
                             'savings_goals', 'ai_action_audit')
             and relrowsecurity)

  union all
  -- RLS ei ole paalla vain siella minne se muistettiin laittaa. Tama
  -- kysyy toisin pain: onko public-skeemassa yhtaan taulua ILMAN
  -- RLS:aa. Uusi taulu, joka joskus lisataan ilman politiikkoja, nakyy
  -- tassa eika missaan muualla.
  select '06', 'era', 'Yhtaan public-taulua ei ole ilman RLS:aa', '0',
         (select count(*)::text from pg_class
           where relnamespace = 'public'::regnamespace
             and relkind = 'r' and not relrowsecurity)

  -- ================================================================
  -- OMISTAJUUSGRAAFI — ERÄN YDIN
  -- ================================================================
  -- Yhdeksän viitettä, kolmessa eri migraatiossa. Yksikään migraatio ei
  -- näe niitä kaikkia; tämä näkee.

  union all
  -- Viisi omistajan rivin avainta: routines (0003), goals ja projects
  -- (0004), tasks ja recurring_expenses (0007). Nama ovat
  -- yhdistelmavierasavainten kohteita, ja ilman niita viitteita ei
  -- olisi voitu luoda lainkaan.
  select '07', 'omistajuus', 'Viisi omistajan rivin avainta (user_id, id)', '5',
         (select count(*)::text from pg_constraint con
           where con.conname in ('routines_owner_row_key', 'goals_owner_row_key',
                                 'projects_owner_row_key', 'tasks_owner_row_key',
                                 'recurring_expenses_owner_row_key')
             and con.contype = 'u'
             and (select array_agg(a.attname::text order by a.attname)
                    from unnest(con.conkey) k(attnum)
                    join pg_attribute a
                      on a.attrelid = con.conrelid and a.attnum = k.attnum)
                 = array['id', 'user_id'])

  union all
  -- YHDEKSÄN OMISTAJUUSVIITETTÄ.
  --
  -- Tämä on koko erän tärkein luku. Rakenne luetaan katalogista eikä
  -- nimistä: conkey kertoo montako saraketta avaimessa on, user_id:n on
  -- oltava yksi niistä, ja confkey kertoo että kohde on pari
  -- (user_id, id).
  --
  -- Jos tämä on kahdeksan, jokin viite on menetetty — ja menetetty
  -- viite ei kaada mitään, se vain lakkaa suojaamasta.
  select '08', 'omistajuus', 'Yhdeksan omistajuuden yhdistelmavierasavainta', '9',
         (select count(*)::text
            from pg_constraint con
            join pg_class t on t.oid = con.conrelid
            join pg_class ft on ft.oid = con.confrelid
           where con.contype = 'f'
             and t.relnamespace = 'public'::regnamespace
             and ft.relnamespace = 'public'::regnamespace
             and array_length(con.conkey, 1) = 2
             and exists (select 1 from unnest(con.conkey) k(attnum)
                           join pg_attribute a
                             on a.attrelid = t.oid and a.attnum = k.attnum
                          where a.attname = 'user_id')
             and (select array_agg(a.attname::text order by a.attname)
                    from unnest(con.confkey) k(attnum)
                    join pg_attribute a
                      on a.attrelid = ft.oid and a.attnum = k.attnum)
                 = array['id', 'user_id'])

  union all
  -- ERI VÄITE KUIN 08: tämä laskee ETTEI heikompia ole. Kumpikaan yksin
  -- ei riitä — kanta voisi sisältää oikean viitteen ja vanhan sen
  -- vieressä, jolloin heikompi päästäisi rivin läpi.
  --
  -- Tämä kattaa KOKO public-skeeman, ei vain erän tauluja: jos joku
  -- lisää myöhemmin yhden sarakkeen viitteen mihin tahansa, se näkyy
  -- tässä.
  select '09', 'omistajuus', 'Yhtaan yhden sarakkeen viitetta sovellustauluun ei ole', '0',
         (select count(*)::text
            from pg_constraint con
            join pg_class t on t.oid = con.conrelid
            join pg_class ft on ft.oid = con.confrelid
           where con.contype = 'f'
             and t.relnamespace = 'public'::regnamespace
             and ft.relnamespace = 'public'::regnamespace
             and array_length(con.conkey, 1) < 2)

  union all
  -- Nollattavat sarakkeet on rajattu. Ilman sarakelistaa poisto
  -- yrittaisi nollata myos user_id:n, joka on NOT NULL, ja kohteen
  -- poistaminen kaatuisi joka kerta.
  --
  -- Kahdeksan SET NULL -viitetta; yhdeksas (routine_exceptions) on
  -- CASCADE, koska poikkeus ilman rutiinia ei tarkoita mitaan.
  select '10', 'omistajuus', 'Kahdeksan nollaavaa viitetta rajaa nollauksen sarakkeeseen', '8',
         (select count(*)::text
            from pg_constraint con
            join pg_class t on t.oid = con.conrelid
           where con.contype = 'f'
             and t.relnamespace = 'public'::regnamespace
             and array_length(con.conkey, 1) = 2
             and con.confdeltype = 'n'
             and array_length(con.confdelsetcols, 1) = 1
             and not exists (select 1 from unnest(con.confdelsetcols) k(attnum)
                               join pg_attribute a
                                 on a.attrelid = t.oid and a.attnum = k.attnum
                              where a.attname = 'user_id'))

  union all
  select '11', 'omistajuus', 'Poikkeuksen viite rutiiniin on CASCADE', '1',
         (select count(*)::text from pg_constraint
           where conname = 'routine_exceptions_routine_id_fkey'
              or (conrelid = 'public.routine_exceptions'::regclass
                  and contype = 'f' and confdeltype = 'c'
                  and array_length(conkey, 1) = 2))

  union all
  -- MATCH SIMPLE ohittaa yhdistelmavierasavaimen tarkistuksen, jos
  -- yksikin avaimen sarake on NULL. Jos user_id sallisi NULLin
  -- yhdessakin viittaavassa taulussa, koko suoja katoaisi hiljaa
  -- juuri niilta riveilta joilla sita eniten tarvitaan.
  select '12', 'omistajuus', 'user_id on NOT NULL kaikissa kymmenessa taulussa', '10',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public'
             and table_name in ('tasks', 'routines', 'routine_exceptions',
                                'goals', 'projects', 'wellbeing_entries',
                                'bills', 'recurring_expenses', 'savings_goals',
                                'ai_action_audit')
             and column_name = 'user_id' and is_nullable = 'NO')

  union all
  select '13', 'omistajuus', 'Omistajan asettaa kanta jokaisessa uudessa taulussa', '10',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public'
             and ((table_name in ('routines', 'routine_exceptions', 'goals',
                                  'projects', 'wellbeing_entries', 'bills',
                                  'recurring_expenses', 'savings_goals',
                                  'ai_action_audit')
                   and column_name = 'user_id')
                  or (table_name = 'notification_preferences' and column_name = 'id'))
             and column_default like '%auth.uid()%')

  union all
  select '14', 'omistajuus', 'Kayttajan poisto siivoaa kaikki kymmenen taulua', '10',
         (select count(*)::text
            from pg_constraint con
            join pg_class t on t.oid = con.conrelid
            join pg_class ft on ft.oid = con.confrelid
            join pg_namespace fn on fn.oid = ft.relnamespace
           where con.contype = 'f'
             and fn.nspname = 'auth' and ft.relname = 'users'
             and con.confdeltype = 'c'
             and t.relname in ('routines', 'routine_exceptions', 'goals',
                               'projects', 'notification_preferences',
                               'wellbeing_entries', 'bills',
                               'recurring_expenses', 'savings_goals',
                               'ai_action_audit'))

  -- ================================================================
  -- POLITIIKAT SANOVAT SEN, MITÄ NIIDEN PITÄÄ
  -- ================================================================

  union all
  -- Politiikan OLEMASSAOLO ei todista mitaan: `using (true)` nayttaisi
  -- luettelossa aivan samalta. Tama laskee politiikat, joiden ehto on
  -- TASMALLEEN omistajuusrajaus — molemmilla puolilla.
  --
  -- Neljakymmentä politiikkaa: yhdeksan taulua rajaa user_id:lla,
  -- notification_preferences rajaa id:lla.
  select '15', 'politiikat', 'Kaikki 40 politiikkaa rajaavat omistajuuden', '40',
         (select count(*)::text from pg_policies p
           where p.schemaname = 'public'
             and p.tablename in ('routines', 'routine_exceptions', 'goals',
                                 'projects', 'notification_preferences',
                                 'wellbeing_entries', 'bills',
                                 'recurring_expenses', 'savings_goals',
                                 'ai_action_audit')
             and p.roles = '{authenticated}'::name[]
             and coalesce(btrim(replace(p.qual, ' ', ''), '()'),
                          case when p.tablename = 'notification_preferences'
                               then 'auth.uid()=id' else 'auth.uid()=user_id' end)
                 = case when p.tablename = 'notification_preferences'
                        then 'auth.uid()=id' else 'auth.uid()=user_id' end
             and coalesce(btrim(replace(p.with_check, ' ', ''), '()'),
                          case when p.tablename = 'notification_preferences'
                               then 'auth.uid()=id' else 'auth.uid()=user_id' end)
                 = case when p.tablename = 'notification_preferences'
                        then 'auth.uid()=id' else 'auth.uid()=user_id' end)

  union all
  select '16', 'politiikat', 'Yhtaan politiikkaa ei ole muulle kuin authenticated', '0',
         (select count(*)::text from pg_policies
           where schemaname = 'public'
             and roles <> '{authenticated}'::name[])

  union all
  select '17', 'politiikat', 'Jokainen neljasta operaatiosta on katettu', '40',
         (select count(*)::text from pg_policies
           where schemaname = 'public'
             and tablename in ('routines', 'routine_exceptions', 'goals',
                               'projects', 'notification_preferences',
                               'wellbeing_entries', 'bills',
                               'recurring_expenses', 'savings_goals',
                               'ai_action_audit')
             and cmd in ('SELECT', 'INSERT', 'UPDATE', 'DELETE'))

  -- ================================================================
  -- OIKEUDET
  -- ================================================================

  union all
  select '18', 'oikeudet', 'anon-roolilla ei ole tehollista oikeutta yhteenkaan tauluun', '0',
         (select count(*)::text
            from pg_tables t
            cross join (select unnest(array['select', 'insert', 'update', 'delete',
                                            'truncate', 'references', 'trigger']) as oikeus) pp
           where t.schemaname = 'public'
             and has_table_privilege('anon', format('%I.%I', t.schemaname, t.tablename),
                                     pp.oikeus))

  union all
  -- PUBLICille myonnetty oikeus ei nay roolikohtaisissa listauksissa
  -- lainkaan, joten se luetaan taulun omasta oikeuslistasta. Tama
  -- kattaa KOKO public-skeeman.
  select '19', 'oikeudet', 'PUBLIC-roolilla ei ole oikeuksia yhteenkaan public-tauluun', '0',
         (select count(*)::text
            from pg_class cl, aclexplode(cl.relacl) acl
           where cl.relnamespace = 'public'::regnamespace
             and cl.relkind = 'r' and acl.grantee = 0)

  union all
  -- Yksitoista taulua x CRUD = 44. Kymmenen uutta plus tasks; profile
  -- on erikseen alla, koska sen oikeudet asetti migraatio 0001.
  select '20', 'oikeudet', 'authenticated-roolilla on tasan CRUD, ei enempaa', '44',
         (select count(*)::text
            from (select unnest(array['public.tasks', 'public.routines',
                                      'public.routine_exceptions', 'public.goals',
                                      'public.projects',
                                      'public.notification_preferences',
                                      'public.wellbeing_entries', 'public.bills',
                                      'public.recurring_expenses',
                                      'public.savings_goals',
                                      'public.ai_action_audit']) as taulu) tt
            cross join (select unnest(array['select', 'insert', 'update', 'delete',
                                            'truncate', 'references', 'trigger']) as oikeus) pp
           where has_table_privilege('authenticated', tt.taulu, pp.oikeus))

  -- ================================================================
  -- LIIPAISIMET JA FUNKTIO
  -- ================================================================

  union all
  -- Ajoitus luetaan tgtype-biteista: 1 = rivikohtainen, 2 = before,
  -- 16 = update.
  --
  -- Kymmenen liipaisinta: yhdeksan uutta taulua joissa on updated_at,
  -- plus tasks, joka sai omansa jo migraatiossa 0002. Pois jaa vain
  -- ai_action_audit — kirjaus ei muutu jalkikateen, joten silla ei ole
  -- updated_at-saraketta eika mitaan koskettavaa.
  select '21', 'liipaisimet', 'Kymmenen updated_at-liipaisinta ajetaan ennen muutosta', '10',
         (select count(*)::text from pg_trigger t
            join pg_class c2 on c2.oid = t.tgrelid
           where not t.tgisinternal
             and c2.relnamespace = 'public'::regnamespace
             and t.tgname like '%_touch_updated_at'
             and (t.tgtype & 1) = 1 and (t.tgtype & 2) = 2 and (t.tgtype & 16) = 16)

  union all
  -- KOKO ERÄN HILJAISIN RISKI.
  --
  -- Funktio on yhteinen kaikille liipaisimille. Migraatiot 0005, 0006
  -- ja 0007 sisalsivat aiemmin `create or replace` ILMAN kovennusta;
  -- ajo olisi korvannut migraation 0002 kovennetun funktion
  -- kovettamattomalla, eika mikaan olisi kaatunut.
  --
  -- Nyt ne vain tarkistavat sen. Tama tarkistaa lopputilan.
  select '22', 'liipaisimet', 'Funktio touch_updated_at on kovennettu', '1',
         (select count(*)::text from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'touch_updated_at'
             and p.prosecdef = false
             and p.proconfig is not null
             and exists (select 1 from unnest(p.proconfig) a
                          where a like 'search\_path=%'))

  union all
  -- Eika public-skeemassa ole muita SECURITY DEFINER -funktioita.
  -- Sellainen ajetaan omistajansa oikeuksilla ja ohittaa RLS:n.
  select '23', 'liipaisimet', 'Public-skeemassa ei ole SECURITY DEFINER -funktioita', '0',
         (select count(*)::text from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.prosecdef)

  -- ================================================================
  -- UUDET TAULUT OVAT TYHJIÄ, VANHA DATA KOSKEMATON
  -- ================================================================

  union all
  select '24', 'data', 'Kaikki kahdeksan uutta taulua ovat tyhjia', '0',
         ((select count(*) from public.goals)
        + (select count(*) from public.projects)
        + (select count(*) from public.notification_preferences)
        + (select count(*) from public.wellbeing_entries)
        + (select count(*) from public.bills)
        + (select count(*) from public.recurring_expenses)
        + (select count(*) from public.savings_goals)
        + (select count(*) from public.ai_action_audit))::text

  union all
  select '25', 'data', 'Migraation 0003 taulut ovat tyhjia', '0',
         ((select count(*) from public.routines)
        + (select count(*) from public.routine_exceptions))::text

  union all
  select '26', 'data', 'Uudet tasks-sarakkeet ovat kaikilla riveilla NULL', '0',
         (select count(*)::text from public.tasks
           where deadline is not null or goal_id is not null or project_id is not null)

  union all
  select '27', 'data', 'Omistajattomia tehtavia ei ole', '0',
         (select count(*)::text from public.tasks where user_id is null)

  union all
  select '28', 'data', 'Orpoja omistajaviittauksia ei ole', '0',
         (select count(*)::text from public.tasks t
            left join auth.users u on u.id = t.user_id
           where u.id is null)

  union all
  select '29', 'data', 'Yhtaan tehtavaa ei omista odottamaton kayttaja', '0',
         (select count(*)::text from public.tasks
           where user_id is distinct from '2cc00622-f927-4604-a518-361a4328481b'::uuid)

  union all
  select '30', 'data', 'tasks-taulussa on yha nelja politiikkaa', '4',
         (select count(*)::text from pg_policies
           where schemaname = 'public' and tablename = 'tasks')

  union all
  select '31', 'data', 'RLS on yha paalla tauluissa tasks ja profile', '2',
         (select count(*)::text from pg_class
           where relnamespace = 'public'::regnamespace
             and relname in ('tasks', 'profile') and relrowsecurity)

  -- ================================================================
  -- KIRJATTAVAT
  -- ================================================================

  union all
  select '32', 'kirjattavat', 'Tehtavien lukumaara', 'INFO',
         (select count(*)::text from public.tasks)

  union all
  select '33', 'kirjattavat', 'Tehtavien tunnisteiden tiiviste', 'INFO',
         (select coalesce(md5(string_agg(id, ',' order by id)), 'ei rivejä')
            from public.tasks)

  union all
  select '34', 'kirjattavat', 'Tauluja public-skeemassa', 'INFO',
         (select count(*)::text from pg_tables where schemaname = 'public')

  union all
  select '35', 'kirjattavat', 'Vierasavaimia public-skeemassa', 'INFO',
         (select count(*)::text from pg_constraint
           where connamespace = 'public'::regnamespace and contype = 'f')

  union all
  select '36', 'kirjattavat', 'Tietokanta', 'INFO', current_database()

  union all
  select '37', 'kirjattavat', 'Palvelimen versio', 'INFO',
         current_setting('server_version')

  union all
  select '38', 'kirjattavat', 'Varmistuksen hetki (UTC)', 'INFO',
         to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS')

) c
order by c.check_no;
