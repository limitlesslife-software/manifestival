-- Varmistus: 0004_goals_projects
-- VAIN LUKEVA. Yksi lause, yksi taulukko, yksi kopiointi.
-- Aja heti migraation jalkeen.
--
-- ODOTUS: jokaisen PASS/FAIL-rivin status = 'PASS' ja
-- poikkeavia_yhteensa = 0. Yksikin FAIL tarkoittaa, ettei lippuja
-- goals ja projects saa kaantaa.
--
-- Rakenne luetaan KATALOGEISTA, ei nimista: vierasavaimen sarakemaara
-- pg_constraint.conkeysta, poistosaanto confdeltypesta, nollattavat
-- sarakkeet confdelsetcolsista, oikeudet has_table_privilegesta ja
-- aclexplodesta.
--
-- TAMAN VARMISTUKSEN YDIN
-- Migraatio 0004 muutti kuusi yhden sarakkeen vierasavainta
-- yhdistelmavierasavaimiksi. Ilman sita kayttaja B voisi liittaa oman
-- tehtavansa kayttajan A tavoitteeseen: RLS ei estaisi sita, koska B:n
-- rivin omistaja on B. Tarkistukset 12-18 ovat siksi tarkeimmat.
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
  -- TAULUT JA SARAKKEET
  -- ================================================================

  select '01' as check_no, 'taulut' as section,
         'Molemmat taulut ovat olemassa' as check_name,
         '2' as odotus,
         (select count(*)::text from pg_tables
           where schemaname = 'public'
             and tablename in ('goals', 'projects')) as toteutui

  union all
  select '02', 'taulut', 'goals-taulun rakenteelliset sarakkeet ovat olemassa', '14',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'goals'
             and column_name in ('id', 'user_id', 'title', 'description',
                                 'category', 'priority', 'status', 'target_date',
                                 'progress_mode', 'manual_progress',
                                 'parent_goal_id', 'project_id',
                                 'created_at', 'updated_at'))

  union all
  -- Kokonaismaara yksin ei todista mitaan: se voisi tasmata, vaikka
  -- odotettu sarake puuttuisi ja tilalla olisi tuntematon. Siksi
  -- nimeamattomien maara lukitaan erikseen ja kolmen luvun on oltava
  -- keskenaan johdonmukaiset.
  select '03', 'taulut', 'goals-taulussa ei ole nimeamattomia sarakkeita', '0',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'goals'
             and column_name not in ('id', 'user_id', 'title', 'description',
                                     'category', 'priority', 'status', 'target_date',
                                     'progress_mode', 'manual_progress',
                                     'parent_goal_id', 'project_id',
                                     'created_at', 'updated_at'))

  union all
  select '04', 'taulut', 'goals-taulussa on tasan 14 saraketta', '14',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'goals')

  union all
  select '05', 'taulut', 'projects-taulun rakenteelliset sarakkeet ovat olemassa', '12',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'projects'
             and column_name in ('id', 'user_id', 'name', 'description',
                                 'category', 'priority', 'status', 'goal_id',
                                 'start_date', 'deadline',
                                 'created_at', 'updated_at'))

  union all
  select '06', 'taulut', 'projects-taulussa ei ole nimeamattomia sarakkeita', '0',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'projects'
             and column_name not in ('id', 'user_id', 'name', 'description',
                                     'category', 'priority', 'status', 'goal_id',
                                     'start_date', 'deadline',
                                     'created_at', 'updated_at'))

  union all
  select '07', 'taulut', 'projects-taulussa on tasan 12 saraketta', '12',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'projects')

  union all
  select '08', 'taulut', 'Kolme uutta saraketta on lisatty tasks-tauluun', '3',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'tasks'
             and column_name in ('deadline', 'goal_id', 'project_id'))

  union all
  -- Oletusarvo tekisi jokaisesta uudesta tehtavasta hiljaa erilaisen,
  -- ja NOT NULL kaataisi jokaisen vanhan rivin paivityksen.
  select '09', 'taulut', 'Uudet tasks-sarakkeet ovat nullable ja ilman oletusta', '3',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'tasks'
             and column_name in ('deadline', 'goal_id', 'project_id')
             and is_nullable = 'YES' and column_default is null)

  union all
  select '10', 'taulut', 'Uudet tasks-sarakkeet ovat kaikilla riveilla NULL', '0',
         (select count(*)::text from public.tasks
           where deadline is not null or goal_id is not null or project_id is not null)

  -- ================================================================
  -- OMISTAJUUSINVARIANTTI — TAMAN MIGRAATION YDIN
  -- ================================================================

  union all
  -- Omistajan rivin avain on yhdistelmavierasavaimen kohde. Ilman sita
  -- viitteita ei olisi voitu luoda lainkaan.
  select '11', 'omistajuus', 'Omistajan rivin avaimet (user_id, id) ovat olemassa', '2',
         (select count(*)::text from pg_constraint con
           where con.conname in ('goals_owner_row_key', 'projects_owner_row_key')
             and con.contype = 'u'
             and (select array_agg(a.attname::text order by a.attname)
                    from unnest(con.conkey) k(attnum)
                    join pg_attribute a
                      on a.attrelid = con.conrelid and a.attnum = k.attnum)
                 = array['id', 'user_id'])

  union all
  -- VIISI YHDISTELMAVIERASAVAINTA.
  --
  -- Tama on koko migraation tarkein tarkistus. Rakenne luetaan
  -- katalogista eika nimesta: conkey kertoo montako saraketta avaimessa
  -- on, ja user_id:n on oltava yksi niista. Nimi voisi olla mika
  -- tahansa; rakenne ei voi valehdella.
  --
  -- confdeltype = 'n' on ON DELETE SET NULL. confdelsetcols kertoo
  -- MITKA sarakkeet nollataan — sen on oltava tasan yksi eika user_id.
  -- Jos confdelsetcols olisi NULL, tavoitteen poisto yrittaisi nollata
  -- myos user_id:n ja kaatuisi NOT NULL -virheeseen joka kerta.
  select '12', 'omistajuus', 'Viisi omistajuuden yhdistelmavierasavainta on voimassa', '5',
         (select count(*)::text
            from pg_constraint con
            join pg_class t on t.oid = con.conrelid
           where con.conname in ('goals_parent_goal_fkey', 'goals_project_id_fkey',
                                 'projects_goal_id_fkey',
                                 'tasks_goal_id_fkey', 'tasks_project_id_fkey')
             and con.contype = 'f'
             and array_length(con.conkey, 1) = 2
             and con.confdeltype = 'n'
             and array_length(con.confdelsetcols, 1) = 1
             and exists (select 1 from unnest(con.conkey) k(attnum)
                           join pg_attribute a
                             on a.attrelid = t.oid and a.attnum = k.attnum
                          where a.attname = 'user_id')
             and not exists (select 1 from unnest(con.confdelsetcols) k(attnum)
                               join pg_attribute a
                                 on a.attrelid = t.oid and a.attnum = k.attnum
                              where a.attname = 'user_id'))

  union all
  -- Rutiinin viite tavoitteeseen syntyy vain jos 0003 on ajettu.
  -- Odotus lasketaan kannan tilasta, jotta 0003:n puuttuminen ei nayta
  -- puutteelta.
  select '13', 'omistajuus', 'Rutiinin viite tavoitteeseen on yhdistelma (jos 0003 ajettu)',
         (select case when exists (select 1 from information_schema.columns
                                    where table_schema = 'public'
                                      and table_name = 'routines'
                                      and column_name = 'goal_id')
                      then '1' else '0' end),
         (select count(*)::text
            from pg_constraint con
            join pg_class t on t.oid = con.conrelid
           where con.conname = 'routines_goal_id_fkey'
             and con.contype = 'f'
             and array_length(con.conkey, 1) = 2
             and con.confdeltype = 'n'
             and array_length(con.confdelsetcols, 1) = 1
             and exists (select 1 from unnest(con.conkey) k(attnum)
                           join pg_attribute a
                             on a.attrelid = t.oid and a.attnum = k.attnum
                          where a.attname = 'user_id'))

  union all
  -- ERI VAITE KUIN 12: tama laskee ETTEI vaaria ole. Kumpikaan yksin ei
  -- riita — migraatio olisi voinut luoda oikean viitteen ja jattaa
  -- vanhan viereen, jolloin heikompi paastaisi rivin lapi.
  select '14', 'omistajuus', 'Yhtaan yhden sarakkeen viitetta tavoitteisiin ei ole', '0',
         (select count(*)::text
            from pg_constraint con
            join pg_class ft on ft.oid = con.confrelid
           where con.contype = 'f'
             and ft.relnamespace = 'public'::regnamespace
             and ft.relname in ('goals', 'projects')
             and array_length(con.conkey, 1) < 2)

  union all
  -- Jokainen viite osoittaa nimenomaan pariin (user_id, id), ei mihin
  -- tahansa kahteen sarakkeeseen. confkey on kohteen sarakelista.
  select '15', 'omistajuus', 'Viitteiden kohde on aina pari (user_id, id)', '5',
         (select count(*)::text
            from pg_constraint con
            join pg_class ft on ft.oid = con.confrelid
           where con.conname in ('goals_parent_goal_fkey', 'goals_project_id_fkey',
                                 'projects_goal_id_fkey',
                                 'tasks_goal_id_fkey', 'tasks_project_id_fkey')
             and con.contype = 'f'
             and (select array_agg(a.attname::text order by a.attname)
                    from unnest(con.confkey) k(attnum)
                    join pg_attribute a
                      on a.attrelid = ft.oid and a.attnum = k.attnum)
                 = array['id', 'user_id'])

  union all
  -- MATCH SIMPLE ohittaa tarkistuksen, jos yksikin avaimen sarake on
  -- NULL. Jos user_id sallisi NULLin, koko suoja katoaisi hiljaa.
  select '16', 'omistajuus', 'Omistajasarake on NOT NULL kaikissa viittaavissa tauluissa', '3',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public'
             and table_name in ('tasks', 'goals', 'projects')
             and column_name = 'user_id' and is_nullable = 'NO')

  union all
  select '17', 'omistajuus', 'Omistajan asettaa kanta, ei asiakas', '2',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name in ('goals', 'projects')
             and column_name = 'user_id'
             and column_default like '%auth.uid()%')

  union all
  select '18', 'omistajuus', 'Kayttajan poisto siivoaa tavoitteet ja projektit', '2',
         (select count(*)::text
            from pg_constraint con
            join pg_class ft on ft.oid = con.confrelid
            join pg_namespace fn on fn.oid = ft.relnamespace
           where con.conrelid in ('public.goals'::regclass, 'public.projects'::regclass)
             and con.contype = 'f'
             and fn.nspname = 'auth' and ft.relname = 'users'
             and con.confdeltype = 'c')

  -- ================================================================
  -- RAJOITTEET JA INDEKSIT
  -- ================================================================

  union all
  select '19', 'rajoitteet', 'goals-taulun tarkisteet ovat olemassa', '6',
         (select count(*)::text from pg_constraint
           where conname in ('goals_status_check', 'goals_progress_mode_check',
                             'goals_manual_progress_check', 'goals_priority_check',
                             'goals_title_check', 'goals_parent_not_self_check')
             and contype = 'c')

  union all
  select '20', 'rajoitteet', 'projects-taulun tarkisteet ovat olemassa', '4',
         (select count(*)::text from pg_constraint
           where conname in ('projects_priority_check', 'projects_date_range_check',
                             'projects_status_check', 'projects_name_check')
             and contype = 'c')

  union all
  -- Indeksin sarakejarjestys luetaan pg_indexin indkey-listasta.
  -- Jarjestys ratkaisee: (user_id, status) palvelee omistajan hakua,
  -- (status, user_id) ei.
  select '21', 'indeksit', 'Hakuindeksit ovat oikeassa sarakejarjestyksessa', '2',
         (select count(*)::text
            from pg_index i
            join pg_class ic on ic.oid = i.indexrelid
            join pg_class tc on tc.oid = i.indrelid
           where ic.relname in ('goals_user_status_idx', 'projects_user_status_idx')
             and (select array_agg(a.attname::text order by k.ord)
                    from unnest(i.indkey) with ordinality k(attnum, ord)
                    join pg_attribute a
                      on a.attrelid = tc.oid and a.attnum = k.attnum)
                 = array['user_id', 'status'])

  union all
  select '22', 'indeksit', 'tasks-taulun uudet indeksit ovat olemassa', '2',
         (select count(*)::text from pg_indexes
           where schemaname = 'public'
             and indexname in ('tasks_user_goal_idx', 'tasks_user_deadline_idx'))

  union all
  -- Liipaisimen ajoitus luetaan tgtype-biteista: 1 = rivikohtainen,
  -- 2 = before, 16 = update. Nimi ei kerro milloin se ajetaan.
  select '23', 'liipaisimet', 'updated_at paivittyy ennen rivin muutosta', '2',
         (select count(*)::text from pg_trigger
           where not tgisinternal
             and tgname in ('goals_touch_updated_at', 'projects_touch_updated_at')
             and (tgtype & 1) = 1 and (tgtype & 2) = 2 and (tgtype & 16) = 16)

  union all
  -- Funktio on migraation 0002 objekti. 0004 ei luo sita uudelleen,
  -- mutta jos jokin muu on korvannut sen kovettamattomalla, se nakyy
  -- tassa.
  select '24', 'liipaisimet', 'Funktio touch_updated_at on yha kovennettu', '1',
         (select count(*)::text from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'touch_updated_at'
             and p.prosecdef = false
             and p.proconfig is not null
             and exists (select 1 from unnest(p.proconfig) a
                          where a like 'search\_path=%'))

  -- ================================================================
  -- RLS JA POLITIIKAT
  -- ================================================================

  union all
  select '25', 'rls', 'RLS on paalla molemmissa uusissa tauluissa', '2',
         (select count(*)::text from pg_class
           where relnamespace = 'public'::regnamespace
             and relname in ('goals', 'projects') and relrowsecurity)

  union all
  -- Politiikan OLEMASSAOLO ei todista mitaan: `using (true)` nayttaisi
  -- luettelossa aivan samalta. Siksi ehdot luetaan ja verrataan.
  -- MOLEMMAT puolet: USING ratkaisee mita rivia saa muokata, WITH CHECK
  -- mihin sen saa muuttaa.
  select '26', 'rls', 'Kahdeksan omistajuuspolitiikkaa oikein ehdoin', '8',
         (select count(*)::text
            from pg_policies p
            join (values
                    ('goals',    'goals_select_own',    'SELECT', 'auth.uid()=user_id', ''),
                    ('goals',    'goals_insert_own',    'INSERT', '',                   'auth.uid()=user_id'),
                    ('goals',    'goals_update_own',    'UPDATE', 'auth.uid()=user_id', 'auth.uid()=user_id'),
                    ('goals',    'goals_delete_own',    'DELETE', 'auth.uid()=user_id', ''),
                    ('projects', 'projects_select_own', 'SELECT', 'auth.uid()=user_id', ''),
                    ('projects', 'projects_insert_own', 'INSERT', '',                   'auth.uid()=user_id'),
                    ('projects', 'projects_update_own', 'UPDATE', 'auth.uid()=user_id', 'auth.uid()=user_id'),
                    ('projects', 'projects_delete_own', 'DELETE', 'auth.uid()=user_id', '')
                 ) e(tbl, pol, operaatio, q, wc)
              on e.tbl = p.tablename and e.pol = p.policyname and e.operaatio = p.cmd
             and btrim(replace(coalesce(p.qual, ''), ' ', ''), '()') = e.q
             and btrim(replace(coalesce(p.with_check, ''), ' ', ''), '()') = e.wc
           where p.schemaname = 'public' and p.roles = '{authenticated}'::name[])

  union all
  select '27', 'rls', 'Uusissa tauluissa ei ole ylimaaraisia politiikkoja', '8',
         (select count(*)::text from pg_policies
           where schemaname = 'public' and tablename in ('goals', 'projects'))

  -- ================================================================
  -- OIKEUDET
  -- ================================================================

  union all
  select '28', 'oikeudet', 'anon-roolilla ei ole tehollista oikeutta uusiin tauluihin', '0',
         (select count(*)::text
            from (select unnest(array['public.goals', 'public.projects']) as taulu) tt
            cross join (select unnest(array['select', 'insert', 'update', 'delete',
                                            'truncate', 'references', 'trigger']) as oikeus) pp
           where has_table_privilege('anon', tt.taulu, pp.oikeus))

  union all
  -- Kaksi menetelmaa, koska kumpikaan ei yksin riita: has_table_privilege
  -- kertoo ONKO oikeus (perinta mukaan lukien), aclexplode kertoo MISTA
  -- se tulee. PUBLICille myonnetty oikeus ei nay roolikohtaisissa
  -- listauksissa lainkaan.
  select '29', 'oikeudet', 'PUBLIC-roolilla ei ole oikeuksia uusiin tauluihin', '0',
         (select count(*)::text
            from pg_class cl, aclexplode(cl.relacl) acl
           where cl.oid = any (array['public.goals'::regclass,
                                     'public.projects'::regclass])
             and acl.grantee = 0)

  union all
  select '30', 'oikeudet', 'authenticated-roolilla on tasan CRUD molempiin tauluihin', '8',
         (select count(*)::text
            from (select unnest(array['public.goals', 'public.projects']) as taulu) tt
            cross join (select unnest(array['select', 'insert', 'update', 'delete',
                                            'truncate', 'references', 'trigger']) as oikeus) pp
           where has_table_privilege('authenticated', tt.taulu, pp.oikeus))

  -- ================================================================
  -- VANHA DATA ON KOSKEMATON
  -- ================================================================

  union all
  select '31', 'vanha data', 'RLS on yha paalla tauluissa tasks ja profile', '2',
         (select count(*)::text from pg_class
           where relnamespace = 'public'::regnamespace
             and relname in ('tasks', 'profile') and relrowsecurity)

  union all
  select '32', 'vanha data', 'tasks-taulussa on yha nelja politiikkaa', '4',
         (select count(*)::text from pg_policies
           where schemaname = 'public' and tablename = 'tasks')

  union all
  select '33', 'vanha data', 'Omistajattomia tehtavia ei ole', '0',
         (select count(*)::text from public.tasks where user_id is null)

  union all
  select '34', 'vanha data', 'Uudet taulut ovat tyhjia', '0',
         ((select count(*) from public.goals)
        + (select count(*) from public.projects))::text

  union all
  select '35', 'rajaus', 'Migraatioiden 0005-0008 tauluja ei ole olemassa', '0',
         (select count(*)::text from pg_tables
           where schemaname = 'public'
             and tablename in ('notification_preferences', 'wellbeing_entries',
                               'bills', 'recurring_expenses', 'savings_goals',
                               'ai_action_audit'))

  -- ================================================================
  -- KIRJATTAVAT
  -- ================================================================

  union all
  select '36', 'kirjattavat', 'Tehtavien lukumaara', 'INFO',
         (select count(*)::text from public.tasks)

  union all
  select '37', 'kirjattavat', 'Tietokanta', 'INFO', current_database()

  union all
  select '38', 'kirjattavat', 'Palvelimen versio', 'INFO',
         current_setting('server_version')

  union all
  select '39', 'kirjattavat', 'Varmistuksen hetki (UTC)', 'INFO',
         to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS')

) c
order by c.check_no;
