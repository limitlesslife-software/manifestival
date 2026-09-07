-- Palautumisen tilannekuva: MIGRAATION 0002 JALKEEN
-- VAIN LUKEVA. Yksi lause, yksi taulukko, yksi kopiointi.
--
-- MIKSI TAMA ON OLEMASSA
--
-- Tuorein fyysinen varmuuskopio on 2026-09-05 06:57:15 UTC, ja se on
-- OTETTU ENNEN migraatiota 0002. Palautus siita ei siis palauta nykyista
-- tilaa vaan aiemman: kuusi saraketta, kolme tarkistetta, liipaisin,
-- funktio ja indeksi katoaisivat.
--
-- Tama tiedosto on se kirjanpito, joka kertoo mika on palautettava. Aja
-- se ENNEN kuin mitaan riskialtista tehdaan (runbookin GATE C), ja
-- SAILYTA TULOS. Jos palautus joskus tehdaan, tama on ainoa asiakirja,
-- joka kertoo mihin tilaan piti paatya.
--
-- MITA TAMA EI OLE
--
-- Tama EI ole varmuuskopio. Se ei sisalla yhtaan riviarvoa eika siita
-- voi rakentaa dataa uudelleen. Se todistaa RAKENTEEN ja LUKUMAARAT.
-- Rivien sisalto on fyysisen varmuuskopion varassa, ja siina on aukko:
-- ks. PALAUTUMISEN AUKOT alla.
--
-- PALAUTUMISEN AUKOT
--
--   1. Varmuuskopio edeltaa migraatiota 0002. Palautuksen jalkeen 0002
--      on ajettava uudelleen. Se on turvallista — migraatio on
--      additiivinen ja versionhallinnassa — mutta se ON tehtava.
--   2. Varmuuskopion jalkeen kirjoitettuja rivimuutoksia EI voi palauttaa
--      taman tiedoston avulla. Jos tehtavia on luotu tai muokattu
--      06:57:15 UTC jalkeen, ne katoavat palautuksessa. Kohta 04 ja
--      sormenjaljet 42-43 kertovat, poikkeaako rivijoukko odotetusta.
--   3. created_at-arvot ovat kaikilla riveilla migraation ajanhetki.
--      Palautus + 0002:n uudelleenajo tuottaa NIILLE ERI ARVON. Se ei
--      ole tietohavio, mutta luku 47 muuttuu eika se ole vika.
--
-- ODOTUS: jokaisen PASS/FAIL-rivin status = 'PASS' ja
-- poikkeavia_yhteensa = 0. INFO-rivit ovat kirjattavia arvoja: ne
-- yksiloivat taman tilannekuvan ja ne verrataan palautuksen jalkeen.
--
-- Tama tiedosto EI lue kayttajan sisaltoa. Sormenjaljet (42-45) ovat
-- yksisuuntaisia tiivisteita: ne todistavat, onko joukko sama, mutta
-- niista ei voi lukea mita joukko sisaltaa.

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
  -- TUNNISTE — mika tilannekuva tama on
  -- ================================================================

  select '01' as check_no, 'tunniste' as section,
         'Tilannekuvan hetki (UTC)' as check_name,
         'INFO' as odotus,
         to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS') as toteutui

  union all
  select '02', 'tunniste', 'Tietokanta', 'INFO',
         current_database()

  union all
  -- Yksiloi taman ajon: hetki, rivimaarat ja skeeman tiiviste yhdessa.
  -- Kaksi eri tilannekuvaa samasta kannasta eroavat toisistaan vain jos
  -- jokin naista on muuttunut — ja juuri sita halutaan tietaa.
  select '03', 'tunniste', 'Tilannekuvan tunniste', 'INFO',
         md5(
           to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS')
           || ':' || (select count(*) from public.tasks)::text
           || ':' || (select count(*) from public.profile)::text
           || ':' || (select count(*) from auth.users)::text
         )

  -- ================================================================
  -- DATA — rivimaarat ja omistajuus
  -- ================================================================

  union all
  select '04', 'data', 'Tehtavien lukumaara', '36',
         (select count(*)::text from public.tasks)

  union all
  select '05', 'data', 'Profiilirivien lukumaara', '1',
         (select count(*)::text from public.profile)

  union all
  select '06', 'data', 'Auth-kayttajien lukumaara', '1',
         (select count(*)::text from auth.users)

  union all
  select '07', 'data', 'Eri omistajia tehtavilla', '1',
         (select count(distinct user_id)::text from public.tasks)

  union all
  select '08', 'data', 'Omistajattomia tehtavia', '0',
         (select count(*)::text from public.tasks where user_id is null)

  union all
  select '09', 'data', 'Orpoja omistajaviittauksia', '0',
         (select count(*)::text
            from public.tasks t left join auth.users u on u.id = t.user_id
           where u.id is null)

  union all
  select '10', 'data', 'Yhtaan tehtavaa ei omista joku muu kuin hyvaksytty omistaja', '0',
         (select count(*)::text from public.tasks
           where user_id is distinct from '2cc00622-f927-4604-a518-361a4328481b'::uuid)

  union all
  select '11', 'data', 'Profiili kuuluu hyvaksytylle omistajalle', '1',
         (select count(*)::text from public.profile
           where id = '2cc00622-f927-4604-a518-361a4328481b'::uuid)

  union all
  select '12', 'data', 'Perumisen merkkipaalu legacy_id on tallella', '1',
         (select count(*)::text from public.profile where legacy_id = 'me')

  -- ================================================================
  -- AIKATAULUTUS — 0002:n tayton tulos
  -- ================================================================

  union all
  select '13', 'aikataulutus', 'Rivit tilassa manual', '35',
         (select count(*)::text from public.tasks where scheduling_state = 'manual')

  union all
  select '14', 'aikataulutus', 'Rivit tilassa unscheduled', '1',
         (select count(*)::text from public.tasks where scheduling_state = 'unscheduled')

  union all
  select '15', 'aikataulutus', 'Rivit tilassa auto', '0',
         (select count(*)::text from public.tasks where scheduling_state = 'auto')

  union all
  -- 0002 merkitsi kellonajattomat rivit aikatauluttamattomiksi. Jos
  -- suhde on rikki, automaatti saa luvan siirtaa jotain, minka kayttaja
  -- on itse paattanyt.
  select '16', 'aikataulutus', 'Kellonajallisia riveja', '35',
         (select count(*)::text from public.tasks where "time" is not null)

  union all
  select '17', 'aikataulutus', 'Kellonajattomia riveja', '1',
         (select count(*)::text from public.tasks where "time" is null)

  union all
  select '18', 'aikataulutus', 'Kellonajattomat rivit ovat aikatauluttamattomia', '0',
         (select count(*)::text from public.tasks
           where "time" is null and scheduling_state <> 'unscheduled')

  -- ================================================================
  -- LAAJENNETUT KENTAT — lippu on false, joten naiden on oltava nollia
  -- ================================================================

  union all
  -- Sovellus ei kirjoita naihin sarakkeisiin ennen kuin lippu
  -- TASK_EXTENDED_FIELDS on true. Nollasta poikkeava luku tarkoittaa,
  -- etta lippu on kaannetty tai kantaan on kirjoitettu suoraan.
  select '19', 'laajennetut', 'Riveja joilla on kuvaus', '0',
         (select count(*)::text from public.tasks where description is not null)

  union all
  select '20', 'laajennetut', 'Riveja joilla on kesto', '0',
         (select count(*)::text from public.tasks where duration_minutes is not null)

  union all
  select '21', 'laajennetut', 'Riveja joilla on muu kuin oletusprioriteetti', '0',
         (select count(*)::text from public.tasks where priority <> 'normaali')

  union all
  select '22', 'laajennetut', 'Riveja joilla on tyhja merkkijono kuvauksena', '0',
         (select count(*)::text from public.tasks where description = '')

  -- ================================================================
  -- SKEEMA — mika on palautettava, jos varmuuskopiosta palataan
  -- ================================================================

  union all
  select '23', 'skeema', 'Kuusi 0002:n saraketta on olemassa', '6',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'tasks'
             and column_name in ('description', 'duration_minutes', 'priority',
                                 'scheduling_state', 'created_at', 'updated_at'))

  union all
  select '24', 'skeema', 'Sarakkeiden tyypit ovat odotetut', '6',
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
  select '25', 'skeema', 'Nullius on jokaisella sarakkeella odotettu', '6',
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
  select '26', 'skeema', 'Oletusarvot ovat odotetut neljalla sarakkeella', '4',
         (select count(*)::text
            from information_schema.columns col
           where col.table_schema = 'public' and col.table_name = 'tasks'
             and ((col.column_name = 'priority'         and col.column_default like '%normaali%')
               or (col.column_name = 'scheduling_state' and col.column_default like '%manual%')
               or (col.column_name = 'created_at'       and col.column_default like 'now()%')
               or (col.column_name = 'updated_at'       and col.column_default like 'now()%')))

  union all
  select '27', 'skeema', 'Kolme 0002:n tarkistetta on olemassa oikein ehdoin', '3',
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
  -- RAKENNE — liipaisin, funktio, indeksit
  -- ================================================================

  union all
  -- tgtype-bitit: 1 = rivikohtainen, 2 = before, 16 = update.
  select '28', 'rakenne', 'Liipaisin tasks_touch_updated_at on rivikohtainen BEFORE UPDATE', '1',
         (select count(*)::text from pg_trigger
           where tgrelid = 'public.tasks'::regclass
             and tgname = 'tasks_touch_updated_at'
             and not tgisinternal
             and (tgtype & 1) = 1 and (tgtype & 2) = 2 and (tgtype & 16) = 16
             and tgfoid = 'public.touch_updated_at'::regproc)

  union all
  select '29', 'rakenne', 'Funktio touch_updated_at ei ole SECURITY DEFINER ja polku on kiinnitetty', '1',
         (select count(*)::text
            from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'touch_updated_at'
             and p.prosecdef = false
             and array_to_string(coalesce(p.proconfig, array[]::text[]), ',') like '%search_path=%')

  union all
  -- Indeksi tunnistetaan SARAKKEISTA, ei nimesta.
  select '30', 'rakenne', 'Indeksi tasks_user_date_priority_idx on sarakkeilla (user_id, date, priority)', '1',
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
  select '31', 'rakenne', 'Omistajahaun indeksi (ensimmainen sarake user_id) on olemassa', '1',
         (select least(count(*), 1)::text
            from pg_index x
            join pg_class t on t.oid = x.indrelid
            join pg_namespace n on n.oid = t.relnamespace
            join pg_attribute a on a.attrelid = t.oid and a.attnum = x.indkey[0]
           where n.nspname = 'public' and t.relname = 'tasks'
             and a.attname = 'user_id')

  union all
  select '32', 'rakenne', 'Vierasavaimet osoittavat auth.users(id):hen CASCADElla', '2',
         (select count(*)::text
            from pg_constraint con
            join pg_class ft on ft.oid = con.confrelid
            join pg_namespace fn on fn.oid = ft.relnamespace
           where con.conname in ('tasks_user_id_fkey', 'profile_id_fkey')
             and con.contype = 'f' and con.confdeltype = 'c'
             and fn.nspname = 'auth' and ft.relname = 'users')

  -- ================================================================
  -- TURVA — 0001:n takeet
  -- ================================================================

  union all
  select '33', 'turva', 'RLS on paalla molemmissa tauluissa', '2',
         (select count(*)::text from pg_class
           where relnamespace = 'public'::regnamespace
             and relname in ('tasks', 'profile') and relrowsecurity)

  union all
  select '34', 'turva', 'Kahdeksan omistajuuspolitiikkaa on tallella oikein ehdoin', '8',
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
  select '35', 'turva', 'anon-roolilla ei ole tehollista oikeutta tauluun tasks', '0',
         (select count(*)::text
            from (select unnest(array['select', 'insert', 'update', 'delete',
                                      'truncate', 'references', 'trigger']) as oikeus) pp
           where has_table_privilege('anon', 'public.tasks', pp.oikeus))

  union all
  select '36', 'turva', 'anon-roolilla ei ole sarakekohtaista oikeutta 0002:n sarakkeisiin', '0',
         (select count(*)::text
            from unnest(array['description', 'duration_minutes', 'priority',
                              'scheduling_state', 'created_at', 'updated_at']) as sarake
           where has_column_privilege('anon', 'public.tasks', sarake, 'select')
              or has_column_privilege('anon', 'public.tasks', sarake, 'insert')
              or has_column_privilege('anon', 'public.tasks', sarake, 'update'))

  union all
  select '37', 'turva', 'authenticated-roolilla on tasan CRUD tauluun tasks', '4',
         (select count(*)::text
            from (select unnest(array['select', 'insert', 'update', 'delete',
                                      'truncate', 'references', 'trigger']) as oikeus) pp
           where has_table_privilege('authenticated', 'public.tasks', pp.oikeus))

  union all
  select '38', 'turva', 'PUBLIC-roolilla ei ole oikeuksia tauluun tasks', '0',
         (select count(*)::text
            from pg_class cl, aclexplode(cl.relacl) acl
           where cl.oid = 'public.tasks'::regclass and acl.grantee = 0)

  -- ================================================================
  -- RAJAUS JA ESTEET
  -- ================================================================

  union all
  select '39', 'rajaus', 'Migraatioiden 0003-0008 tauluja ei ole olemassa', '0',
         (select count(*)::text from pg_tables
           where schemaname = 'public'
             and tablename in ('routines', 'routine_exceptions', 'goals', 'projects',
                               'notification_preferences', 'wellbeing_entries', 'bills',
                               'recurring_expenses', 'savings_goals', 'ai_action_audit'))

  union all
  -- Avoin transaktio pitaa lukkoja. Tilannekuva, joka otetaan avoimen
  -- transaktion aikana, voi kertoa tilasta joka ei ole viela lopullinen.
  select '40', 'esteet', 'Avoimia idle in transaction -istuntoja ei ole', '0',
         (select count(*)::text from pg_stat_activity
           where datname = current_database()
             and state in ('idle in transaction', 'idle in transaction (aborted)')
             and pid <> pg_backend_pid())

  union all
  select '41', 'esteet', 'Yli minuutin kestaneita kyselyita ei ole kaynnissa', '0',
         (select count(*)::text from pg_stat_activity
           where datname = current_database()
             and state = 'active' and pid <> pg_backend_pid()
             and now() - query_start > interval '1 minute')

  -- ================================================================
  -- SORMENJALJET — yksiloivat tilannekuvan paljastamatta sisaltoa
  -- ================================================================

  union all
  -- md5 on yksisuuntainen. Tiiviste todistaa, onko rivijoukko sama kuin
  -- tilannekuvan hetkella, mutta siita ei voi lukea mita rivit ovat.
  -- Talla erotetaan "sama 36 rivia" ja "eri 36 rivia".
  select '42', 'sormenjalki', 'Tehtavien tunnisteiden tiiviste', 'INFO',
         (select coalesce(md5(string_agg(id, '|' order by id)), 'tyhja')
            from public.tasks)

  union all
  -- Laajempi tiiviste: tunniste, paiva, omistaja, prioriteetti ja
  -- aikataulutustila. Ei otsikoita, ei kuvauksia, ei muistiinpanoja.
  select '43', 'sormenjalki', 'Rivien rakenteellinen tiiviste', 'INFO',
         (select coalesce(md5(string_agg(
                   id || '|' || coalesce("date"::text, '-')
                      || '|' || coalesce(user_id::text, '-')
                      || '|' || priority
                      || '|' || scheduling_state,
                   '#' order by id)), 'tyhja')
            from public.tasks)

  union all
  select '44', 'sormenjalki', 'Taulun tasks skeeman tiiviste', 'INFO',
         (select md5(string_agg(
                   column_name || ':' || data_type || ':' || is_nullable
                     || ':' || coalesce(column_default, '-'),
                   '|' order by column_name))
            from information_schema.columns
           where table_schema = 'public' and table_name = 'tasks')

  union all
  select '45', 'sormenjalki', 'Politiikkojen tiiviste', 'INFO',
         (select md5(string_agg(
                   tablename || ':' || policyname || ':' || cmd
                     || ':' || coalesce(qual, '-')
                     || ':' || coalesce(with_check, '-'),
                   '|' order by tablename, policyname))
            from pg_policies
           where schemaname = 'public' and tablename in ('tasks', 'profile'))

  -- ================================================================
  -- KIRJATTAVAT LUVUT — verrataan palautuksen jalkeen
  -- ================================================================

  union all
  select '46', 'kirjattavat', 'Tehtavien paivavali', 'INFO',
         (select coalesce(min("date")::text, '-') || ' .. ' || coalesce(max("date")::text, '-')
            from public.tasks)

  union all
  -- Kaikilla riveilla on sama created_at: migraation ajanhetki.
  -- Palautus ja 0002:n uudelleenajo tuottaa tahan ERI arvon. Se ei ole
  -- vika vaan seuraus siita, ettei alkuperaisia luontiaikoja ole tallessa.
  select '47', 'kirjattavat', 'created_at vali', 'INFO',
         (select coalesce(to_char(min(created_at) at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS'), '-')
              || ' .. '
              || coalesce(to_char(max(created_at) at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS'), '-')
            from public.tasks)

  union all
  select '48', 'kirjattavat', 'updated_at vali', 'INFO',
         (select coalesce(to_char(min(updated_at) at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS'), '-')
              || ' .. '
              || coalesce(to_char(max(updated_at) at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS'), '-')
            from public.tasks)

  union all
  select '49', 'kirjattavat', 'Riveja paivitetty luonnin jalkeen', 'INFO',
         (select count(*)::text from public.tasks where updated_at > created_at)

  union all
  select '50', 'kirjattavat', 'Rajoitteita taulussa tasks', 'INFO',
         (select count(*)::text from pg_constraint
           where conrelid = 'public.tasks'::regclass)

  union all
  select '51', 'kirjattavat', 'Indekseja taulussa tasks', 'INFO',
         (select count(*)::text from pg_indexes
           where schemaname = 'public' and tablename = 'tasks')

  union all
  select '52', 'kirjattavat', 'Sarakkeita taulussa tasks', 'INFO',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'tasks')

) c
order by c.check_no;
