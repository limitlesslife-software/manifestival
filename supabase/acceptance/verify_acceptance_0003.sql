-- Varmistus: rutiinien RLS-eristystestin JALKEEN
-- VAIN LUKEVA. Yksi lause, yksi taulukko, yksi kopiointi.
--
-- MILLOIN: kun tools/rls-acceptance on ajettu migraation 0003 taulujen
-- kanssa, sen siivous on nayttanyt PASSin ja vakinainen tili B on
-- poistettu Supabasen Authentication-nakymasta.
--
-- MIKSI ERILLINEN: selaimessa ajettu testi katsoo kantaa RLS:n lapi. Se
-- ei siis voi nahda, jaiko toisen tilin rivi kantaan — RLS piilottaisi
-- juuri sen rivin, jota etsitaan. Tama ajetaan SQL-editorissa ilman
-- RLS-rajausta, ja se on ainoa paikka josta jaannoksen voi nahda.
--
-- Tama EI korvaa tiedostoa verify_acceptance.sql. Se todisti tasks- ja
-- profile-taulujen tilan; tama todistaa 0003:n taulut ja sen etteivat
-- vanhat muuttuneet.
--
-- ODOTUS: jokaisen rivin status = 'PASS' ja poikkeavia_yhteensa = 0.
--
-- Tama tiedosto EI lue kayttajan sisaltoa.

select c.check_no, c.section, c.check_name,
       case when c.toteutui = c.odotus then 'PASS' else 'FAIL' end as status,
       'odotus ' || c.odotus || ', toteutui ' || c.toteutui as details,
       count(*) filter (where c.toteutui <> c.odotus) over () as poikkeavia_yhteensa
from (

  -- ================================================================
  -- JAANNOKSET — hyvaksyntatestista ei jaanyt mitaan
  -- ================================================================

  select '01' as check_no, 'jaannokset' as section,
         'Rutiineja on nolla' as check_name,
         '0' as odotus,
         (select count(*)::text from public.routines) as toteutui

  union all
  select '02', 'jaannokset', 'Poikkeuksia on nolla', '0',
         (select count(*)::text from public.routine_exceptions)

  union all
  -- Erillinen kohdista 01-02. Jos jokin rivi jai kantaan, se nakyy
  -- myos etuliitteesta — ja etuliite kertoo, etta se on nimenomaan
  -- taman testin jaannos eika jotain muuta.
  select '03', 'jaannokset', 'Hyvaksyntatestin merkittyja rutiineja ei ole', '0',
         (select count(*)::text from public.routines
           where id like 'manifestival_rls_acceptance_%')

  union all
  select '04', 'jaannokset', 'Hyvaksyntatestin merkittyja poikkeuksia ei ole', '0',
         (select count(*)::text from public.routine_exceptions
           where id like 'manifestival_rls_acceptance_%')

  union all
  select '05', 'jaannokset', 'Auth-kayttajia on tasan yksi — tili B on poistettu', '1',
         (select count(*)::text from auth.users)

  -- ================================================================
  -- EHEYS — mitaan rikkinaista ei jaanyt
  -- ================================================================

  union all
  select '06', 'eheys', 'Omistajattomia riveja ei ole uusissa tauluissa', '0',
         ((select count(*) from public.routines where user_id is null)
        + (select count(*) from public.routine_exceptions where user_id is null))::text

  union all
  select '07', 'eheys', 'Orpoja omistajaviittauksia ei ole uusissa tauluissa', '0',
         ((select count(*) from public.routines r
             left join auth.users u on u.id = r.user_id where u.id is null)
        + (select count(*) from public.routine_exceptions e
             left join auth.users u2 on u2.id = e.user_id where u2.id is null))::text

  union all
  -- Poikkeus, jonka rutiinia ei ole tai joka kuuluu eri omistajalle.
  -- Yhdistelmavierasavaimen pitaisi tehda tasta mahdotonta; tama
  -- todistaa etta se piti myos hyvaksyntatestin aikana.
  select '08', 'eheys', 'Orpoja tai vaaraan omistajaan kiinnitettyja poikkeuksia ei ole', '0',
         (select count(*)::text
            from public.routine_exceptions e
            left join public.routines r
              on r.id = e.routine_id and r.user_id = e.user_id
           where r.id is null)

  -- ================================================================
  -- RAKENNE — 0003:n tulos on yha voimassa
  -- ================================================================

  union all
  select '09', 'rakenne', 'RLS on yha paalla molemmissa uusissa tauluissa', '2',
         (select count(*)::text from pg_class
           where relnamespace = 'public'::regnamespace
             and relname in ('routines', 'routine_exceptions') and relrowsecurity)

  union all
  select '10', 'rakenne', 'Kahdeksan omistajuuspolitiikkaa on tallella oikein ehdoin', '8',
         (select count(*)::text
            from pg_policies p
            join (values
                    ('routines',           'routines_select_own',           'SELECT', 'auth.uid()=user_id', ''),
                    ('routines',           'routines_insert_own',           'INSERT', '',                   'auth.uid()=user_id'),
                    ('routines',           'routines_update_own',           'UPDATE', 'auth.uid()=user_id', 'auth.uid()=user_id'),
                    ('routines',           'routines_delete_own',           'DELETE', 'auth.uid()=user_id', ''),
                    ('routine_exceptions', 'routine_exceptions_select_own', 'SELECT', 'auth.uid()=user_id', ''),
                    ('routine_exceptions', 'routine_exceptions_insert_own', 'INSERT', '',                   'auth.uid()=user_id'),
                    ('routine_exceptions', 'routine_exceptions_update_own', 'UPDATE', 'auth.uid()=user_id', 'auth.uid()=user_id'),
                    ('routine_exceptions', 'routine_exceptions_delete_own', 'DELETE', 'auth.uid()=user_id', '')
                 ) e(tbl, pol, operaatio, q, wc)
              on e.tbl = p.tablename and e.pol = p.policyname and e.operaatio = p.cmd
             and btrim(replace(coalesce(p.qual, ''), ' ', ''), '()') = e.q
             and btrim(replace(coalesce(p.with_check, ''), ' ', ''), '()') = e.wc
           where p.schemaname = 'public' and p.roles = '{authenticated}'::name[])

  union all
  select '11', 'rakenne', 'Uusissa tauluissa ei ole ylimaaraisia politiikkoja', '8',
         (select count(*)::text from pg_policies
           where schemaname = 'public'
             and tablename in ('routines', 'routine_exceptions'))

  union all
  -- Yhdistelmavierasavain on se, joka esti ristiinkiinnityksen. Sen on
  -- oltava yha paikallaan kahden sarakkeen avaimena ja CASCADElla.
  select '12', 'rakenne', 'Omistajuuden yhdistelmavierasavain on yha voimassa', '1',
         (select count(*)::text
            from pg_constraint con
            join pg_class t on t.oid = con.conrelid
            join pg_class ft on ft.oid = con.confrelid
           where t.relname = 'routine_exceptions' and ft.relname = 'routines'
             and con.contype = 'f'
             and array_length(con.conkey, 1) = 2
             and con.confdeltype = 'c'
             and (select array_agg(a.attname::text order by a.attname)
                    from unnest(con.conkey) as k(attnum)
                    join pg_attribute a on a.attrelid = t.oid and a.attnum = k.attnum)
                 = array['routine_id', 'user_id'])

  union all
  select '13', 'rakenne', 'Rutiinin omistajarivin avain (user_id, id) on yha olemassa', '1',
         (select count(*)::text from pg_constraint
           where conname = 'routines_owner_row_key' and contype = 'u')

  -- ================================================================
  -- OIKEUDET
  -- ================================================================

  union all
  select '14', 'oikeudet', 'anon-roolilla ei ole tehollista oikeutta uusiin tauluihin', '0',
         (select count(*)::text
            from (select unnest(array['public.routines', 'public.routine_exceptions']) as taulu) tt
            cross join (select unnest(array['select', 'insert', 'update', 'delete',
                                            'truncate', 'references', 'trigger']) as oikeus) pp
           where has_table_privilege('anon', tt.taulu, pp.oikeus))

  union all
  select '15', 'oikeudet', 'authenticated-roolilla on tasan CRUD molempiin tauluihin', '8',
         (select count(*)::text
            from (select unnest(array['public.routines', 'public.routine_exceptions']) as taulu) tt
            cross join (select unnest(array['select', 'insert', 'update', 'delete',
                                            'truncate', 'references', 'trigger']) as oikeus) pp
           where has_table_privilege('authenticated', tt.taulu, pp.oikeus))

  union all
  select '16', 'oikeudet', 'PUBLIC-roolilla ei ole oikeuksia uusiin tauluihin', '0',
         (select count(*)::text
            from pg_class cl, aclexplode(cl.relacl) acl
           where cl.oid = any (array['public.routines'::regclass,
                                     'public.routine_exceptions'::regclass])
             and acl.grantee = 0)

  -- ================================================================
  -- VANHA DATA ON KOSKEMATON
  -- ================================================================

  union all
  select '17', 'vanha data', 'Tehtavia on yha 36', '36',
         (select count(*)::text from public.tasks)

  union all
  select '18', 'vanha data', 'Profiilirivien maara on yha 1', '1',
         (select count(*)::text from public.profile)

  union all
  select '19', 'vanha data', 'Yhtaan tehtavaa ei omista odottamaton kayttaja', '0',
         (select count(*)::text from public.tasks
           where user_id is distinct from '2cc00622-f927-4604-a518-361a4328481b'::uuid)

  union all
  select '20', 'vanha data', 'Hyvaksyntatestin merkittyja tehtavia ei ole', '0',
         (select count(*)::text from public.tasks
           where id like 'manifestival_rls_acceptance_%')

  union all
  select '21', 'vanha data', 'RLS on yha paalla tauluissa tasks ja profile', '2',
         (select count(*)::text from pg_class
           where relnamespace = 'public'::regnamespace
             and relname in ('tasks', 'profile') and relrowsecurity)

  union all
  select '22', 'rajaus', 'Migraatioiden 0004-0008 tauluja ei ole olemassa', '0',
         (select count(*)::text from pg_tables
           where schemaname = 'public'
             and tablename in ('goals', 'projects', 'notification_preferences',
                               'wellbeing_entries', 'bills', 'recurring_expenses',
                               'savings_goals', 'ai_action_audit'))

) c
order by c.check_no;
