-- Varmistus: 0002_task_domain_fields
-- VAIN LUKEVA. Yksi lause, yksi taulukko, yksi kopiointi.
-- Runbookin PYSAYTYS 6. Aja heti migraation jalkeen.
--
-- ODOTUS: jokaisen PASS/FAIL-rivin status = 'PASS' ja
-- poikkeavia_yhteensa = 0. INFO-rivit ovat lukuja, jotka verrataan
-- preflight_0002:n vastaaviin — niita ei voi tarkistaa automaattisesti,
-- koska oikea arvo riippuu siita, mita tuotannossa oli ennen ajoa.
--
-- Yksikin FAIL tarkoittaa, ettei lippua TASK_EXTENDED_FIELDS saa
-- kaantaa. Ks. docs/MIGRATION-0002-RECOVERY.md.
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
  -- SARAKKEET
  -- ================================================================

  select '01' as check_no, 'sarakkeet' as section,
         'Kuusi uutta saraketta on olemassa' as check_name,
         '6' as odotus,
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'tasks'
             and column_name in ('description', 'duration_minutes', 'priority',
                                 'scheduling_state', 'created_at', 'updated_at')) as toteutui

  union all
  -- Tyyppi ei ole muotoseikka. integer-sarakkeeseen text-arvo menisi
  -- lapi vain implisiittisella muunnoksella, ja timestamptz vs
  -- timestamp eroavat aikavyohykkeen kasittelyssa — siina erossa
  -- katoaa tunti kaksi kertaa vuodessa.
  select '02', 'sarakkeet', 'Kuuden sarakkeen tyypit ovat odotetut', '6',
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
  -- priority, scheduling_state, created_at ja updated_at eivat saa olla
  -- tyhjia; description ja duration_minutes saavat.
  select '03', 'sarakkeet', 'Nullius on jokaisella sarakkeella odotettu', '6',
         (select count(*)::text
            from information_schema.columns col
            join (values
                    ('description',      'YES'),
                    ('duration_minutes', 'YES'),
                    ('priority',         'NO'),
                    ('scheduling_state', 'NO'),
                    ('created_at',       'NO'),
                    ('updated_at',       'NO')
                 ) e(sarake, sallii)
              on e.sarake = col.column_name and e.sallii = col.is_nullable
           where col.table_schema = 'public' and col.table_name = 'tasks')

  union all
  -- Oletusarvot ovat se, mika pitaa lipun ollessa false luodut rivit
  -- kelvollisina: sovellus ei viela laheta naita sarakkeita lainkaan.
  select '04', 'sarakkeet', 'Oletusarvot ovat odotetut neljalla sarakkeella', '4',
         (select count(*)::text
            from information_schema.columns col
           where col.table_schema = 'public' and col.table_name = 'tasks'
             and ((col.column_name = 'priority'         and col.column_default like '%normaali%')
               or (col.column_name = 'scheduling_state' and col.column_default like '%manual%')
               or (col.column_name = 'created_at'       and col.column_default like 'now()%')
               or (col.column_name = 'updated_at'       and col.column_default like 'now()%')))

  -- ================================================================
  -- RAJOITTEET
  -- ================================================================

  union all
  select '05', 'rajoitteet', 'Kolme tarkistetta on olemassa', '3',
         (select count(*)::text from pg_constraint
           where conrelid = 'public.tasks'::regclass
             and contype = 'c'
             and conname in ('tasks_priority_check', 'tasks_scheduling_state_check',
                             'tasks_duration_minutes_check'))

  union all
  -- Rajoitteen olemassaolo ei kerro mita se sallii. Nimi voi olla oikea
  -- ja ehto vaara, ja vaara ehto nakyy vasta silloin kun kelvoton arvo
  -- on jo tallessa.
  select '06', 'rajoitteet', 'Kolmen tarkisteen ehdot sisaltavat odotetut arvot', '3',
         (select count(*)::text from pg_constraint
           where conrelid = 'public.tasks'::regclass
             and contype = 'c'
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

  -- ================================================================
  -- DATA — mitaan ei kadonnut eika jaanyt tyhjaksi
  -- ================================================================

  union all
  select '07', 'data', 'Yhdellakaan rivilla ei ole tyhjaa aikataulutustilaa', '0',
         (select count(*)::text from public.tasks where scheduling_state is null)

  union all
  select '08', 'data', 'Yhdellakaan rivilla ei ole tyhjaa prioriteettia', '0',
         (select count(*)::text from public.tasks where priority is null)

  union all
  select '09', 'data', 'Yhdellakaan rivilla ei ole kelvotonta prioriteettia', '0',
         (select count(*)::text from public.tasks
           where priority not in ('korkea', 'normaali', 'matala'))

  union all
  select '10', 'data', 'Yhdellakaan rivilla ei ole kelvotonta aikataulutustilaa', '0',
         (select count(*)::text from public.tasks
           where scheduling_state not in ('manual', 'auto', 'unscheduled'))

  union all
  -- Taytto merkitsi kellonajattomat rivit aikatauluttamattomiksi ja
  -- muut kayttajan omiksi paatoksiksi. Jos naiden suhde on vaara,
  -- automaatti saa luvan siirtaa jotain, mita kayttaja on itse
  -- paattanyt — tai jattaa siirtamatta jotain, mita se saisi siirtaa.
  select '11', 'data', 'Kellonajattomat rivit ovat aikatauluttamattomia', '0',
         (select count(*)::text from public.tasks
           where "time" is null and scheduling_state <> 'unscheduled')

  union all
  select '12', 'data', 'Omistajuus sailyi: omistajattomia riveja ei ole', '0',
         (select count(*)::text from public.tasks where user_id is null)

  union all
  select '13', 'data', 'Omistajuus sailyi: orpoja viittauksia ei ole', '0',
         (select count(*)::text
            from public.tasks t
            left join auth.users u on u.id = t.user_id
           where u.id is null)

  union all
  select '14', 'data', 'Yhtaan tehtavaa ei omista joku muu kuin hyvaksytty omistaja', '0',
         (select count(*)::text from public.tasks
           where user_id is distinct from '2cc00622-f927-4604-a518-361a4328481b'::uuid)

  -- ================================================================
  -- RAKENNE — indeksi, liipaisin, funktio, RLS
  -- ================================================================

  union all
  -- Indeksi tunnistetaan SARAKKEISTA, ei nimesta. Nimi voi olla oikea
  -- ja sarakkeet vaarat, jolloin kysely lukisi koko taulun ja
  -- varmistus kertoisi kaiken olevan kunnossa.
  select '15', 'rakenne', 'Indeksi tasks_user_date_priority_idx on sarakkeilla (user_id, date, priority)', '1',
         (select count(*)::text
            from pg_index x
            join pg_class ic on ic.oid = x.indexrelid
            join pg_class t on t.oid = x.indrelid
            join pg_namespace n on n.oid = t.relnamespace
           where n.nspname = 'public' and t.relname = 'tasks'
             and ic.relname = 'tasks_user_date_priority_idx'
             and (select array_agg(a.attname::text order by k.ord)
                    from unnest(x.indkey::int2[]) with ordinality as k(attnum, ord)
                    join pg_attribute a
                      on a.attrelid = t.oid and a.attnum = k.attnum)
                 = array['user_id', 'date', 'priority'])

  union all
  -- 0001:n vaatimus on yha voimassa: jonkin indeksin ensimmaisen
  -- sarakkeen on oltava user_id.
  select '16', 'rakenne', 'Omistajahaun indeksi on yha olemassa', '1',
         (select least(count(*), 1)::text
            from pg_index x
            join pg_class t on t.oid = x.indrelid
            join pg_namespace n on n.oid = t.relnamespace
            join pg_attribute a on a.attrelid = t.oid and a.attnum = x.indkey[0]
           where n.nspname = 'public' and t.relname = 'tasks'
             and a.attname = 'user_id')

  union all
  -- tgtype-bitit: 1 = rivikohtainen, 2 = before, 16 = update.
  -- Lauseikohtainen tai after-liipaisin ei paivittaisi riveja oikein.
  select '17', 'rakenne', 'Liipaisin on rivikohtainen BEFORE UPDATE', '1',
         (select count(*)::text from pg_trigger
           where tgrelid = 'public.tasks'::regclass
             and tgname = 'tasks_touch_updated_at'
             and not tgisinternal
             and (tgtype & 1) = 1
             and (tgtype & 2) = 2
             and (tgtype & 16) = 16
             and tgfoid = 'public.touch_updated_at'::regproc)

  union all
  -- SECURITY DEFINER -funktio ajaisi omistajan oikeuksilla ja ohittaisi
  -- RLS:n. Kiinnittamaton search_path taas antaisi istunnon polun
  -- ratkaista, mihin funktion sisalla viitataan.
  select '18', 'rakenne', 'Liipaisinfunktio ei ole SECURITY DEFINER ja sen search_path on kiinnitetty', '1',
         (select count(*)::text
            from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'touch_updated_at'
             and p.prosecdef = false
             and array_to_string(coalesce(p.proconfig, array[]::text[]), ',') like '%search_path=%')

  union all
  select '19', 'rakenne', 'RLS on yha paalla taulussa tasks', '1',
         (select count(*)::text from pg_class
           where relnamespace = 'public'::regnamespace
             and relname = 'tasks' and relrowsecurity)

  union all
  -- 0002 ei kosketa politiikkoihin. Siksi niiden on oltava tasan
  -- samat kuin 0001:n jalkeen — myos ehdoiltaan.
  select '20', 'rakenne', 'Kahdeksan omistajuuspolitiikkaa on yha tallella oikein ehdoin', '8',
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
              on e.tbl = p.tablename
             and e.pol = p.policyname
             and e.operaatio = p.cmd
             and btrim(replace(coalesce(p.qual, ''), ' ', ''), '()') = e.q
             and btrim(replace(coalesce(p.with_check, ''), ' ', ''), '()') = e.wc
           where p.schemaname = 'public'
             and p.roles = '{authenticated}'::name[])

  -- ================================================================
  -- OIKEUDET — uudet sarakkeet perivat taulun oikeudet
  -- ================================================================

  union all
  select '21', 'oikeudet', 'anon-roolilla ei ole yhtaan tehollista oikeutta tauluun', '0',
         (select count(*)::text
            from (select unnest(array['select', 'insert', 'update', 'delete',
                                      'truncate', 'references', 'trigger']) as oikeus) pp
           where has_table_privilege('anon', 'public.tasks', pp.oikeus))

  union all
  -- Sarakekohtainen oikeus voi olla olemassa vaikka taulukohtaista ei
  -- ole. Uudet sarakkeet ovat juuri se paikka, jossa sellainen syntyisi
  -- huomaamatta.
  select '22', 'oikeudet', 'anon-roolilla ei ole sarakekohtaista oikeutta uusiin sarakkeisiin', '0',
         (select count(*)::text
            from unnest(array['description', 'duration_minutes', 'priority',
                              'scheduling_state', 'created_at', 'updated_at']) as sarake
           where has_column_privilege('anon', 'public.tasks', sarake, 'select')
              or has_column_privilege('anon', 'public.tasks', sarake, 'insert')
              or has_column_privilege('anon', 'public.tasks', sarake, 'update'))

  union all
  select '23', 'oikeudet', 'authenticated-roolilla on tasan CRUD tauluun tasks', '4',
         (select count(*)::text
            from (select unnest(array['select', 'insert', 'update', 'delete',
                                      'truncate', 'references', 'trigger']) as oikeus) pp
           where has_table_privilege('authenticated', 'public.tasks', pp.oikeus))

  union all
  select '24', 'oikeudet', 'PUBLIC-roolilla ei ole oikeuksia tauluun tasks', '0',
         (select count(*)::text
            from pg_class cl, aclexplode(cl.relacl) acl
           where cl.oid = 'public.tasks'::regclass
             and acl.grantee = 0)

  -- ================================================================
  -- KIRJATTAVAT LUVUT — verrataan preflight_0002:n vastaaviin
  -- ================================================================

  union all
  select '25', 'kirjattavat', 'Tehtavien lukumaara migraation JALKEEN', 'INFO',
         (select count(*)::text from public.tasks)

  union all
  select '26', 'kirjattavat', 'Rivit tilassa unscheduled (vrt. preflight 15)', 'INFO',
         (select count(*)::text from public.tasks where scheduling_state = 'unscheduled')

  union all
  select '27', 'kirjattavat', 'Rivit tilassa manual (vrt. preflight 16)', 'INFO',
         (select count(*)::text from public.tasks where scheduling_state = 'manual')

  union all
  select '28', 'kirjattavat', 'Rajoitteita taulussa tasks (preflight 18 + 3)', 'INFO',
         (select count(*)::text from pg_constraint
           where conrelid = 'public.tasks'::regclass)

  union all
  select '29', 'kirjattavat', 'Indekseja taulussa tasks (preflight 19 + 1)', 'INFO',
         (select count(*)::text from pg_indexes
           where schemaname = 'public' and tablename = 'tasks')

) c
order by c.check_no;
