-- Varmistus: ENNEN lipun TASK_EXTENDED_FIELDS aktivointia
-- VAIN LUKEVA. Yksi lause, yksi taulukko, yksi kopiointi.
--
-- MILLOIN: kun ensimmainen tuotantojulkaisu on tehty ja kertakayttoinen
-- kirjoituskoe (luonti, muokkaus, poisto) on ajettu. Tama on viimeinen
-- portti ennen GATE E:ta.
--
-- MIHIN TAMA VASTAA
--
--   1. Jaiko kirjoituskokeesta jalkea? Kertakayttoinen tehtava luotiin
--      ja poistettiin. Jos se on yha kannassa, se nakyy kolmella eri
--      tavalla: rivimaarana, luontiaikojen lukumaarana ja
--      sormenjaljessa. Yksi niista voisi valehdella, kolme ei.
--   2. Ovatko alkuperaiset 36 rivia koskemattomat?
--   3. Onko 0002:n skeema ja 0001:n turvamalli yha voimassa?
--   4. Voiko lipun kaantaa turvallisesti?
--
-- MITA TAMA EI VOI NAHDA
--
-- Lipun arvo on sovelluksen koodissa (src/data/schema.js), ei kannassa.
-- SQL ei voi lukea sita. Kohdat 18-20 ovat lahin mahdollinen todiste:
-- ne ovat NOLLA niin kauan kuin lippu on false, ja niiden on kasvettava
-- aktivoinnin jalkeen. Ks. verify_task_extended_activation.sql.
--
-- ODOTUS: jokaisen PASS/FAIL-rivin status = 'PASS' ja
-- poikkeavia_yhteensa = 0. INFO-rivit verrataan tiedoston
-- supabase/preflight/recovery_snapshot_post_0002.sql vastaaviin: jos
-- sormenjalki on sama, yhtaan rivia ei ole lisatty, poistettu eika
-- muutettu.
--
-- Tama tiedosto EI lue kayttajan sisaltoa. Sormenjaljet ovat
-- yksisuuntaisia tiivisteita.

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
  -- TUNNISTE
  -- ================================================================

  select '01' as check_no, 'tunniste' as section,
         'Tarkistuksen hetki (UTC)' as check_name,
         'INFO' as odotus,
         to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS') as toteutui

  union all
  select '02', 'tunniste', 'Tietokanta', 'INFO', current_database()

  -- ================================================================
  -- DATA
  -- ================================================================

  union all
  select '03', 'data', 'Tehtavia on 36', '36',
         (select count(*)::text from public.tasks)

  union all
  select '04', 'data', 'Profiilirivien maara on 1', '1',
         (select count(*)::text from public.profile)

  union all
  select '05', 'data', 'Auth-kayttajia on 1', '1',
         (select count(*)::text from auth.users)

  union all
  select '06', 'data', 'Eri omistajia tehtavilla on 1', '1',
         (select count(distinct user_id)::text from public.tasks)

  union all
  select '07', 'data', 'Omistajattomia tehtavia ei ole', '0',
         (select count(*)::text from public.tasks where user_id is null)

  union all
  select '08', 'data', 'Orpoja omistajaviittauksia ei ole', '0',
         (select count(*)::text
            from public.tasks t left join auth.users u on u.id = t.user_id
           where u.id is null)

  union all
  select '09', 'data', 'Yhtaan tehtavaa ei omista odottamaton kayttaja', '0',
         (select count(*)::text from public.tasks
           where user_id is distinct from '2cc00622-f927-4604-a518-361a4328481b'::uuid)

  union all
  select '10', 'data', 'Profiili kuuluu odotetulle omistajalle', '1',
         (select count(*)::text from public.profile
           where id = '2cc00622-f927-4604-a518-361a4328481b'::uuid)

  union all
  select '11', 'data', 'Perumisen merkkipaalu legacy_id on tallella', '1',
         (select count(*)::text from public.profile where legacy_id = 'me')

  -- ================================================================
  -- AIKATAULUTUS
  -- ================================================================

  union all
  select '12', 'aikataulutus', 'Rivit tilassa manual', '35',
         (select count(*)::text from public.tasks where scheduling_state = 'manual')

  union all
  select '13', 'aikataulutus', 'Rivit tilassa unscheduled', '1',
         (select count(*)::text from public.tasks where scheduling_state = 'unscheduled')

  union all
  select '14', 'aikataulutus', 'Rivit tilassa auto', '0',
         (select count(*)::text from public.tasks where scheduling_state = 'auto')

  union all
  select '15', 'aikataulutus', 'Kelvottomia aikataulutustiloja ei ole', '0',
         (select count(*)::text from public.tasks
           where scheduling_state not in ('manual', 'auto', 'unscheduled'))

  union all
  select '16', 'aikataulutus', 'Kellonajattomat rivit ovat aikatauluttamattomia', '0',
         (select count(*)::text from public.tasks
           where "time" is null and scheduling_state <> 'unscheduled')

  union all
  select '17', 'aikataulutus', 'Kellonajallisia riveja on 35', '35',
         (select count(*)::text from public.tasks where "time" is not null)

  -- ================================================================
  -- LAAJENNETTUJEN KENTTIEN LAHTOTILA
  --
  -- Nama ovat nollia niin kauan kuin lippu on false: sovellus ei laheta
  -- naita sarakkeita lainkaan. Nollasta poikkeava luku tarkoittaa joko
  -- ettei lippu ole enaa false, tai etta kantaan on kirjoitettu suoraan.
  -- ================================================================

  union all
  select '18', 'laajennetut', 'Riveja joilla on kuvaus', '0',
         (select count(*)::text from public.tasks where description is not null)

  union all
  select '19', 'laajennetut', 'Riveja joilla on kesto', '0',
         (select count(*)::text from public.tasks where duration_minutes is not null)

  union all
  select '20', 'laajennetut', 'Riveja joilla on muu kuin oletusprioriteetti', '0',
         (select count(*)::text from public.tasks where priority <> 'normaali')

  union all
  select '21', 'laajennetut', 'Kelvottomia prioriteetteja ei ole', '0',
         (select count(*)::text from public.tasks
           where priority not in ('korkea', 'normaali', 'matala'))

  union all
  select '22', 'laajennetut', 'Kelvottomia kestoja ei ole', '0',
         (select count(*)::text from public.tasks
           where duration_minutes is not null
             and (duration_minutes <= 0 or duration_minutes > 1440))

  union all
  select '23', 'laajennetut', 'Pakolliset kentat eivat ole tyhjia yhdellakaan rivilla', '0',
         (select count(*)::text from public.tasks
           where priority is null or scheduling_state is null
              or created_at is null or updated_at is null)

  union all
  -- Tyhja merkkijono ja null tarkoittaisivat "ei kuvausta" kahdella eri
  -- tavalla. normalizeTask muuntaa tyhjan nulliksi.
  select '24', 'laajennetut', 'Kuvaus ei ole tyhja merkkijono yhdellakaan rivilla', '0',
         (select count(*)::text from public.tasks where description = '')

  -- ================================================================
  -- KIRJOITUSKOKEEN JAANNOS
  -- ================================================================

  union all
  -- TAMA ON TAMAN TIEDOSTON TERAVIN KOHTA.
  --
  -- Migraatio 0002 antoi kaikille 36 riville SAMAN created_at-arvon:
  -- vakio-oletus talletetaan kerran metatietoon eika riveja kirjoiteta
  -- uudelleen. Jokainen sovelluksen luoma rivi saa siis oman,
  -- myohemman arvonsa. Erillisia luontiaikoja on tasan yksi vain jos
  -- yhtaan uutta rivia ei ole jaanyt kantaan.
  --
  -- Rivimaara yksin ei riittaisi: 36 voisi tarkoittaa myos "yksi
  -- alkuperainen poistettiin ja yksi uusi jai".
  select '25', 'jaannos', 'Erillisia luontiaikoja on tasan yksi', '1',
         (select count(distinct created_at)::text from public.tasks)

  union all
  select '26', 'jaannos', 'Riveja ei ole luotu migraation jalkeen', '0',
         (select count(*)::text from public.tasks
           where created_at > (select min(created_at) from public.tasks))

  -- ================================================================
  -- SKEEMA
  -- ================================================================

  union all
  select '27', 'skeema', 'Kuusi 0002:n saraketta on olemassa', '6',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'tasks'
             and column_name in ('description', 'duration_minutes', 'priority',
                                 'scheduling_state', 'created_at', 'updated_at'))

  union all
  select '28', 'skeema', 'Sarakkeiden tyypit ovat odotetut', '6',
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
  select '29', 'skeema', 'Nullius on jokaisella sarakkeella odotettu', '6',
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
  -- kelvollisina — ja aktivoinnin jalkeen se, mika suojaa pois jaanyttä
  -- saraketta.
  select '30', 'skeema', 'Oletusarvot ovat odotetut neljalla sarakkeella', '4',
         (select count(*)::text
            from information_schema.columns col
           where col.table_schema = 'public' and col.table_name = 'tasks'
             and ((col.column_name = 'priority'         and col.column_default like '%normaali%')
               or (col.column_name = 'scheduling_state' and col.column_default like '%manual%')
               or (col.column_name = 'created_at'       and col.column_default like 'now()%')
               or (col.column_name = 'updated_at'       and col.column_default like 'now()%')))

  union all
  select '31', 'skeema', 'Kolme tarkistetta on olemassa oikein ehdoin', '3',
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

  -- ================================================================
  -- RAKENNE
  -- ================================================================

  union all
  -- tgtype-bitit: 1 = rivikohtainen, 2 = before, 16 = update.
  select '32', 'rakenne', 'Liipaisin on rivikohtainen BEFORE UPDATE', '1',
         (select count(*)::text from pg_trigger
           where tgrelid = 'public.tasks'::regclass
             and tgname = 'tasks_touch_updated_at'
             and not tgisinternal
             and (tgtype & 1) = 1 and (tgtype & 2) = 2 and (tgtype & 16) = 16
             and tgfoid = 'public.touch_updated_at'::regproc)

  union all
  select '33', 'rakenne', 'Liipaisinfunktio ei ole SECURITY DEFINER ja polku on kiinnitetty', '1',
         (select count(*)::text
            from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'touch_updated_at'
             and p.prosecdef = false
             and array_to_string(coalesce(p.proconfig, array[]::text[]), ',') like '%search_path=%')

  union all
  select '34', 'rakenne', 'Indeksi tasks_user_date_priority_idx on sarakkeilla (user_id, date, priority)', '1',
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

  union all
  select '35', 'rakenne', 'Omistajahaun indeksi (ensimmainen sarake user_id) on olemassa', '1',
         (select least(count(*), 1)::text
            from pg_index x
            join pg_class t on t.oid = x.indrelid
            join pg_namespace n on n.oid = t.relnamespace
            join pg_attribute a on a.attrelid = t.oid and a.attnum = x.indkey[0]
           where n.nspname = 'public' and t.relname = 'tasks'
             and a.attname = 'user_id')

  union all
  select '36', 'rakenne', 'Vierasavaimet osoittavat auth.users(id):hen CASCADElla', '2',
         (select count(*)::text
            from pg_constraint con
            join pg_class ft on ft.oid = con.confrelid
            join pg_namespace fn on fn.oid = ft.relnamespace
           where con.conname in ('tasks_user_id_fkey', 'profile_id_fkey')
             and con.contype = 'f' and con.confdeltype = 'c'
             and fn.nspname = 'auth' and ft.relname = 'users')

  -- ================================================================
  -- TURVA
  -- ================================================================

  union all
  select '37', 'turva', 'RLS on paalla molemmissa tauluissa', '2',
         (select count(*)::text from pg_class
           where relnamespace = 'public'::regnamespace
             and relname in ('tasks', 'profile') and relrowsecurity)

  union all
  select '38', 'turva', 'Kahdeksan omistajuuspolitiikkaa on tallella oikein ehdoin', '8',
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
  select '39', 'turva', 'anon-roolilla ei ole tehollista oikeutta tauluun tasks', '0',
         (select count(*)::text
            from (select unnest(array['select', 'insert', 'update', 'delete',
                                      'truncate', 'references', 'trigger']) as oikeus) pp
           where has_table_privilege('anon', 'public.tasks', pp.oikeus))

  union all
  -- Sarakekohtainen oikeus voi olla olemassa vaikka taulukohtaista ei
  -- ole. 0002:n sarakkeet ovat juuri se paikka, jossa sellainen
  -- syntyisi huomaamatta.
  select '40', 'turva', 'anon-roolilla ei ole sarakekohtaista oikeutta 0002:n sarakkeisiin', '0',
         (select count(*)::text
            from unnest(array['description', 'duration_minutes', 'priority',
                              'scheduling_state', 'created_at', 'updated_at']) as sarake
           where has_column_privilege('anon', 'public.tasks', sarake, 'select')
              or has_column_privilege('anon', 'public.tasks', sarake, 'insert')
              or has_column_privilege('anon', 'public.tasks', sarake, 'update'))

  union all
  select '41', 'turva', 'authenticated-roolilla on tasan CRUD tauluun tasks', '4',
         (select count(*)::text
            from (select unnest(array['select', 'insert', 'update', 'delete',
                                      'truncate', 'references', 'trigger']) as oikeus) pp
           where has_table_privilege('authenticated', 'public.tasks', pp.oikeus))

  union all
  select '42', 'turva', 'PUBLIC-roolilla ei ole oikeuksia tauluun tasks', '0',
         (select count(*)::text
            from pg_class cl, aclexplode(cl.relacl) acl
           where cl.oid = 'public.tasks'::regclass and acl.grantee = 0)

  -- ================================================================
  -- MIGRAATIORAJA JA ESTEET
  -- ================================================================

  union all
  select '43', 'rajaus', 'Migraatioiden 0003-0008 tauluja ei ole olemassa', '0',
         (select count(*)::text from pg_tables
           where schemaname = 'public'
             and tablename in ('routines', 'routine_exceptions', 'goals', 'projects',
                               'notification_preferences', 'wellbeing_entries', 'bills',
                               'recurring_expenses', 'savings_goals', 'ai_action_audit'))

  union all
  select '44', 'esteet', 'Avoimia idle in transaction -istuntoja ei ole', '0',
         (select count(*)::text from pg_stat_activity
           where datname = current_database()
             and state in ('idle in transaction', 'idle in transaction (aborted)')
             and pid <> pg_backend_pid())

  union all
  select '45', 'esteet', 'Yli minuutin kestaneita kyselyita ei ole kaynnissa', '0',
         (select count(*)::text from pg_stat_activity
           where datname = current_database()
             and state = 'active' and pid <> pg_backend_pid()
             and now() - query_start > interval '1 minute')

  -- ================================================================
  -- SORMENJALJET — verrataan recovery_snapshot_post_0002.sql:aan
  -- ================================================================

  union all
  -- Sama tiiviste kuin tilannekuvan kohta 42. Jos se on sama, yhtaan
  -- rivia ei ole lisatty eika poistettu — riippumatta rivimaarasta.
  select '46', 'sormenjalki', 'Tehtavien tunnisteiden tiiviste (vrt. tilannekuva 42)', 'INFO',
         (select coalesce(md5(string_agg(id, '|' order by id)), 'tyhja')
            from public.tasks)

  union all
  select '47', 'sormenjalki', 'Rivien rakenteellinen tiiviste (vrt. tilannekuva 43)', 'INFO',
         (select coalesce(md5(string_agg(
                   id || '|' || coalesce("date"::text, '-')
                      || '|' || coalesce(user_id::text, '-')
                      || '|' || priority
                      || '|' || scheduling_state,
                   '#' order by id)), 'tyhja')
            from public.tasks)

  union all
  select '48', 'sormenjalki', 'Taulun tasks skeeman tiiviste (vrt. tilannekuva 44)', 'INFO',
         (select md5(string_agg(
                   column_name || ':' || data_type || ':' || is_nullable
                     || ':' || coalesce(column_default, '-'),
                   '|' order by column_name))
            from information_schema.columns
           where table_schema = 'public' and table_name = 'tasks')

  union all
  select '49', 'sormenjalki', 'Politiikkojen tiiviste (vrt. tilannekuva 45)', 'INFO',
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
  select '50', 'kirjattavat', 'Tehtavien lukumaara', 'INFO',
         (select count(*)::text from public.tasks)

  union all
  select '51', 'kirjattavat', 'created_at vali (vrt. tilannekuva 47)', 'INFO',
         (select coalesce(to_char(min(created_at) at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS'), '-')
              || ' .. '
              || coalesce(to_char(max(created_at) at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS'), '-')
            from public.tasks)

  union all
  select '52', 'kirjattavat', 'updated_at vali (vrt. tilannekuva 48)', 'INFO',
         (select coalesce(to_char(min(updated_at) at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS'), '-')
              || ' .. '
              || coalesce(to_char(max(updated_at) at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS'), '-')
            from public.tasks)

  union all
  -- INFO eika PASS/FAIL tarkoituksella. Migraation jalkeen jokaisella
  -- rivilla oli updated_at = created_at. Nollasta poikkeava luku
  -- tarkoittaa, etta jotakin ALKUPERAISTA rivia on paivitetty
  -- julkaisun jalkeen — esimerkiksi valmiiksi merkitsemalla. Se voi
  -- olla taysin oikein, joten sita ei voi tuomita automaattisesti.
  -- Luku on silti tiedettava: jos operaattori ei tunnista sita
  -- omakseen, jokin muu on kirjoittanut kantaan.
  select '53', 'kirjattavat', 'Alkuperaisia riveja paivitetty luonnin jalkeen', 'INFO',
         (select count(*)::text from public.tasks where updated_at > created_at)

  union all
  select '54', 'kirjattavat', 'Erillisia paivitysaikoja', 'INFO',
         (select count(distinct updated_at)::text from public.tasks)

) c
order by c.check_no;
