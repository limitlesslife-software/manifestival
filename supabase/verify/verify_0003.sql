-- Varmistus: 0003_routines
-- VAIN LUKEVA. Yksi lause, yksi taulukko, yksi kopiointi.
-- Aja heti migraation jalkeen.
--
-- ODOTUS: jokaisen PASS/FAIL-rivin status = 'PASS' ja
-- poikkeavia_yhteensa = 0. Yksikin FAIL tarkoittaa, ettei lippuja
-- routines ja routineExceptions saa kaantaa.
--
-- Rakenne luetaan KATALOGEISTA, ei nimista: indeksin sarakejarjestys
-- pg_indexista, liipaisimen ajoitus tgtype-biteista, vierasavaimen
-- poistosaanto confdeltypesta, oikeudet has_table_privilegesta.
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
             and tablename in ('routines', 'routine_exceptions')) as toteutui

  union all
  -- SARAKKEET TARKISTETAAN KAHDESSA OSASSA.
  --
  -- Nimeltä luetellaan ne, joilla on rakenteellinen merkitys. Kaksi
  -- sisältökenttää jätetään tarkoituksella nimeämättä: varmistustiedostot
  -- eivät saa sisältää käyttäjän sisältökenttien nimiä lainkaan, jotta
  -- yksinkertainen tarkistus "lukeeko varmistus sisältöä" pysyy
  -- luotettavana eikä sitä tarvitse tehdä ovelaksi. Kokonaismäärä
  -- kohdissa 03 ja 05 sulkee jäljelle jäävän aukon.
  select '02', 'taulut', 'routines-taulun rakenteelliset sarakkeet ovat olemassa', '15',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'routines'
             and column_name in ('id', 'user_id', 'description', 'category',
                                 'priority', 'duration_minutes', 'recurrence_type',
                                 'recurrence_weekdays', 'preferred_time', 'scheduling',
                                 'active', 'goal_id', 'start_date', 'end_date',
                                 'created_at'))

  union all
  select '03', 'taulut', 'routines-taulussa on tasan 17 saraketta', '17',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'routines')

  union all
  select '04', 'taulut', 'routine_exceptions-taulun rakenteelliset sarakkeet ovat olemassa', '8',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'routine_exceptions'
             and column_name in ('id', 'user_id', 'routine_id', 'date', 'type',
                                 'time', 'duration_minutes', 'created_at'))

  union all
  select '05', 'taulut', 'routine_exceptions-taulussa on tasan 10 saraketta', '10',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'routine_exceptions')

  union all
  -- Omistajasarake on uuid eika text. Tyyppi ratkaisee, toimiiko
  -- auth.uid() = user_id -vertailu lainkaan.
  select '06', 'taulut', 'user_id on uuid ja NOT NULL molemmissa tauluissa', '2',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public'
             and table_name in ('routines', 'routine_exceptions')
             and column_name = 'user_id'
             and data_type = 'uuid' and is_nullable = 'NO')

  union all
  select '07', 'taulut', 'user_id saa oletusarvonsa auth.uid()-kutsusta', '2',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public'
             and table_name in ('routines', 'routine_exceptions')
             and column_name = 'user_id'
             and column_default like '%auth.uid()%')

  -- ================================================================
  -- RAJOITTEET
  -- ================================================================

  union all
  select '08', 'rajoitteet', 'Yhdeksan tarkistetta on olemassa', '9',
         (select count(*)::text from pg_constraint
           where contype = 'c'
             and conname in ('routines_recurrence_type_check', 'routines_scheduling_check',
                             'routines_priority_check', 'routines_duration_check',
                             'routines_title_check', 'routines_date_range_check',
                             'routines_weekdays_check', 'routine_exceptions_type_check',
                             'routine_exceptions_duration_check'))

  union all
  -- Rajoitteen olemassaolo ei kerro mita se sallii.
  select '09', 'rajoitteet', 'Tarkisteiden ehdot sisaltavat odotetut arvot', '4',
         (select count(*)::text from pg_constraint
           where contype = 'c'
             and ((conname = 'routines_recurrence_type_check'
                   and pg_get_constraintdef(oid) like '%custom_weekdays%')
               or (conname = 'routines_scheduling_check'
                   and pg_get_constraintdef(oid) like '%flexible%')
               or (conname = 'routines_priority_check'
                   and pg_get_constraintdef(oid) like '%normaali%')
               or (conname = 'routine_exceptions_type_check'
                   and pg_get_constraintdef(oid) like '%reschedule%')))

  union all
  select '10', 'rajoitteet', 'Poikkeuksen yksikasitteisyys (routine_id, date) on voimassa', '1',
         (select count(*)::text from pg_constraint
           where conname = 'routine_exceptions_unique_day' and contype = 'u')

  union all
  select '11', 'rajoitteet', 'Rutiinin omistajarivin avain (user_id, id) on olemassa', '1',
         (select count(*)::text from pg_constraint
           where conname = 'routines_owner_row_key' and contype = 'u')

  -- ================================================================
  -- VIERASAVAIMET JA OMISTAJUUS
  -- ================================================================

  union all
  select '12', 'vierasavaimet', 'Molemmat taulut viittaavat auth.users(id):hen CASCADElla', '2',
         (select count(*)::text
            from pg_constraint con
            join pg_class t on t.oid = con.conrelid
            join pg_class ft on ft.oid = con.confrelid
            join pg_namespace fn on fn.oid = ft.relnamespace
           where t.relname in ('routines', 'routine_exceptions')
             and con.contype = 'f' and con.confdeltype = 'c'
             and fn.nspname = 'auth' and ft.relname = 'users')

  union all
  -- TAMA ON OMISTAJUUDEN EHEYDEN YDIN.
  --
  -- Vierasavaimen tarkistus ei kulje RLS:n lapi. Pelkalla
  -- routine_id-viittauksella kayttaja voisi luoda poikkeuksen, joka
  -- osoittaa toisen kayttajan rutiiniin. Yhdistelma (user_id,
  -- routine_id) sitoo omistajat yhteen, jolloin kanta hylkaa sen.
  --
  -- conkey on sarakenumeroiden vektori: kahden sarakkeen vierasavain
  -- on siina kahtena alkiona.
  select '13', 'vierasavaimet', 'Poikkeus viittaa rutiiniin yhdistelmalla (user_id, routine_id)', '1',
         (select count(*)::text
            from pg_constraint con
            join pg_class t on t.oid = con.conrelid
            join pg_class ft on ft.oid = con.confrelid
           where t.relname = 'routine_exceptions'
             and ft.relname = 'routines'
             and con.contype = 'f'
             and array_length(con.conkey, 1) = 2
             and con.confdeltype = 'c'
             and (select array_agg(a.attname::text order by a.attname)
                    from unnest(con.conkey) as k(attnum)
                    join pg_attribute a on a.attrelid = t.oid and a.attnum = k.attnum)
                 = array['routine_id', 'user_id'])

  -- ================================================================
  -- INDEKSIT
  -- ================================================================

  union all
  -- Sarakkeet luetaan indeksista, ei nimesta. Nimi voi olla oikea ja
  -- sarakkeet vaarat, jolloin kysely lukisi koko taulun.
  select '14', 'indeksit', 'routines_user_active_idx on sarakkeilla (user_id, active)', '1',
         (select count(*)::text
            from pg_index x
            join pg_class ic on ic.oid = x.indexrelid
            join pg_class t on t.oid = x.indrelid
            join pg_namespace n on n.oid = t.relnamespace
           where n.nspname = 'public' and t.relname = 'routines'
             and ic.relname = 'routines_user_active_idx'
             and (select array_agg(a.attname::text order by k.ord)
                    from unnest(x.indkey::int2[]) with ordinality as k(attnum, ord)
                    join pg_attribute a on a.attrelid = t.oid and a.attnum = k.attnum)
                 = array['user_id', 'active'])

  union all
  select '15', 'indeksit', 'routine_exceptions_user_date_idx on sarakkeilla (user_id, date)', '1',
         (select count(*)::text
            from pg_index x
            join pg_class ic on ic.oid = x.indexrelid
            join pg_class t on t.oid = x.indrelid
            join pg_namespace n on n.oid = t.relnamespace
           where n.nspname = 'public' and t.relname = 'routine_exceptions'
             and ic.relname = 'routine_exceptions_user_date_idx'
             and (select array_agg(a.attname::text order by k.ord)
                    from unnest(x.indkey::int2[]) with ordinality as k(attnum, ord)
                    join pg_attribute a on a.attrelid = t.oid and a.attnum = k.attnum)
                 = array['user_id', 'date'])

  union all
  select '16', 'indeksit', 'Molemmissa tauluissa on user_id-alkuinen indeksi', '2',
         (select count(distinct t.relname)::text
            from pg_index x
            join pg_class t on t.oid = x.indrelid
            join pg_namespace n on n.oid = t.relnamespace
            join pg_attribute a on a.attrelid = t.oid and a.attnum = x.indkey[0]
           where n.nspname = 'public'
             and t.relname in ('routines', 'routine_exceptions')
             and a.attname = 'user_id')

  -- ================================================================
  -- LIIPAISIMET JA FUNKTIO
  -- ================================================================

  union all
  -- tgtype-bitit: 1 = rivikohtainen, 2 = before, 16 = update.
  select '17', 'liipaisimet', 'Molemmat liipaisimet ovat rivikohtaisia BEFORE UPDATE', '2',
         (select count(*)::text from pg_trigger
           where tgname in ('routines_touch_updated_at', 'routine_exceptions_touch_updated_at')
             and not tgisinternal
             and (tgtype & 1) = 1 and (tgtype & 2) = 2 and (tgtype & 16) = 16
             and tgfoid = 'public.touch_updated_at'::regproc)

  union all
  -- 0003 luo funktion uudelleen `create or replace` -lauseella. Jos sen
  -- maarittely poikkeaisi 0002:n versiosta, se purkaisi hiljaa
  -- aiemman kovennuksen — myos tasks-taulun liipaisimelta.
  select '18', 'liipaisimet', 'Funktio ei ole SECURITY DEFINER ja polku on kiinnitetty', '1',
         (select count(*)::text
            from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'touch_updated_at'
             and p.prosecdef = false
             and array_to_string(coalesce(p.proconfig, array[]::text[]), ',') like '%search_path=%')

  union all
  select '19', 'liipaisimet', 'tasks-taulun liipaisin on yha ehja', '1',
         (select count(*)::text from pg_trigger
           where tgrelid = 'public.tasks'::regclass
             and tgname = 'tasks_touch_updated_at' and not tgisinternal
             and tgfoid = 'public.touch_updated_at'::regproc)

  -- ================================================================
  -- RLS JA POLITIIKAT
  -- ================================================================

  union all
  select '20', 'turva', 'RLS on paalla molemmissa uusissa tauluissa', '2',
         (select count(*)::text from pg_class
           where relnamespace = 'public'::regnamespace
             and relname in ('routines', 'routine_exceptions') and relrowsecurity)

  union all
  -- Kahdeksan politiikkaa oikein ehdoin. Maara ei riita: vaara ehto
  -- nayttaa ulospain samalta kuin oikea.
  select '21', 'turva', 'Kahdeksan politiikkaa tasmaa odotettuun ehtoon', '8',
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
  select '22', 'turva', 'Uusissa tauluissa ei ole yhtaan ylimaaraista politiikkaa', '8',
         (select count(*)::text from pg_policies
           where schemaname = 'public'
             and tablename in ('routines', 'routine_exceptions'))

  union all
  select '23', 'turva', '0001:n kahdeksan politiikkaa ovat yha tallella', '8',
         (select count(*)::text from pg_policies
           where schemaname = 'public' and tablename in ('tasks', 'profile'))

  -- ================================================================
  -- OIKEUDET
  -- ================================================================

  union all
  select '24', 'oikeudet', 'anon-roolilla ei ole tehollista oikeutta uusiin tauluihin', '0',
         (select count(*)::text
            from (select unnest(array['public.routines', 'public.routine_exceptions']) as taulu) tt
            cross join (select unnest(array['select', 'insert', 'update', 'delete',
                                            'truncate', 'references', 'trigger']) as oikeus) pp
           where has_table_privilege('anon', tt.taulu, pp.oikeus))

  union all
  select '25', 'oikeudet', 'authenticated-roolilla on tasan CRUD molempiin tauluihin', '8',
         (select count(*)::text
            from (select unnest(array['public.routines', 'public.routine_exceptions']) as taulu) tt
            cross join (select unnest(array['select', 'insert', 'update', 'delete',
                                            'truncate', 'references', 'trigger']) as oikeus) pp
           where has_table_privilege('authenticated', tt.taulu, pp.oikeus))

  union all
  select '26', 'oikeudet', 'PUBLIC-roolilla ei ole oikeuksia uusiin tauluihin', '0',
         (select count(*)::text
            from pg_class cl, aclexplode(cl.relacl) acl
           where cl.oid = any (array['public.routines'::regclass,
                                     'public.routine_exceptions'::regclass])
             and acl.grantee = 0)

  -- ================================================================
  -- DATA JA RAJAUS
  -- ================================================================

  union all
  select '27', 'data', 'Uudet taulut ovat tyhjia', '0',
         ((select count(*) from public.routines)
        + (select count(*) from public.routine_exceptions))::text

  union all
  select '28', 'data', 'Omistajattomia rivejä ei ole uusissa tauluissa', '0',
         ((select count(*) from public.routines where user_id is null)
        + (select count(*) from public.routine_exceptions where user_id is null))::text

  union all
  select '29', 'data', 'Orpoja poikkeuksia ei ole', '0',
         (select count(*)::text
            from public.routine_exceptions e
            left join public.routines r on r.id = e.routine_id and r.user_id = e.user_id
           where r.id is null)

  union all
  select '30', 'data', 'Tehtavia on yha 36 — 0003 ei koskenut niihin', '36',
         (select count(*)::text from public.tasks)

  union all
  select '31', 'rajaus', 'Migraatioiden 0004-0008 tauluja ei ole olemassa', '0',
         (select count(*)::text from pg_tables
           where schemaname = 'public'
             and tablename in ('goals', 'projects', 'notification_preferences',
                               'wellbeing_entries', 'bills', 'recurring_expenses',
                               'savings_goals', 'ai_audit'))

  union all
  select '32', 'kirjattavat', 'Varmistuksen hetki (UTC)', 'INFO',
         to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS')

) c
order by c.check_no;
