-- Preflight: ENNEN migraatioerää 0004–0008
-- VAIN LUKEVA. Yksi lause, yksi taulukko, yksi kopiointi.
--
-- MILLOIN: kerran, juuri ennen kuin erä aloitetaan. Vastaa kysymykseen
-- "onko tuotanto siinä tilassa, jonka koko erä olettaa" — ennen kuin
-- ensimmäinen migraatio itse sen päättää ja keskeytyy.
--
-- Tämän lisäksi jokaisella migraatiolla on oma preflightinsa
-- (preflight_0004.sql ... preflight_0008.sql), joka ajetaan juuri ennen
-- kyseistä migraatiota. Tämä tiedosto EI korvaa niitä: tämä katsoo
-- ympäristöä ja koko erää, ne katsovat yhtä migraatiota.
--
-- ODOTUS: jokaisen PASS/FAIL-rivin status = 'PASS' ja
-- poikkeavia_yhteensa = 0. INFO-rivit ovat kirjattavia lukuja.
--
-- YKSIKIN FAIL = ERÄÄ EI ALOITETA.
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
  -- MATCH SIMPLE ohittaa yhdistelmavierasavaimen tarkistuksen, jos
  -- yksikin avaimen sarake on NULL. Koko eran omistajuussuoja nojaa
  -- siihen, etta tasks.user_id on NOT NULL — jos se sallisi NULLin,
  -- suoja katoaisi hiljaa juuri niilta riveilta joilla sita eniten
  -- tarvitaan.
  select '02', '0001', 'tasks.user_id on NOT NULL', '1',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'tasks'
             and column_name = 'user_id' and is_nullable = 'NO')

  union all
  select '03', '0001', 'RLS on paalla tauluissa tasks ja profile', '2',
         (select count(*)::text from pg_class
           where relnamespace = 'public'::regnamespace
             and relname in ('tasks', 'profile') and relrowsecurity)

  union all
  select '04', '0001', 'Kahdeksan omistajuuspolitiikkaa on tallella', '8',
         (select count(*)::text from pg_policies
           where schemaname = 'public' and tablename in ('tasks', 'profile'))

  union all
  select '05', '0001', 'Hyvaksytty omistaja loytyy auth.users-taulusta', '1',
         (select count(*)::text from auth.users
           where id = '2cc00622-f927-4604-a518-361a4328481b'::uuid)

  union all
  select '06', '0002', 'Kuusi laajennettua saraketta on olemassa', '6',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'tasks'
             and column_name in ('description', 'duration_minutes', 'priority',
                                 'scheduling_state', 'created_at', 'updated_at'))

  union all
  -- Migraatiot 0005-0008 EIVAT enaa maarittele tata funktiota. Ne
  -- tarkistavat sen. Jos se on jo kovettamaton, ne keskeyttavat — ja
  -- talloin syy on jossain muualla kuin tassa erassa.
  select '07', '0002', 'Funktio touch_updated_at on kovennettu', '1',
         (select count(*)::text from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'touch_updated_at'
             and p.prosecdef = false
             and p.proconfig is not null
             and exists (select 1 from unnest(p.proconfig) a
                          where a like 'search\_path=%'))

  -- ================================================================
  -- 0003:N TILA
  -- ================================================================

  union all
  -- 0003 EI ole eran esiehto. Jos se on ajettu, 0004 lisaa rutiinille
  -- viitteen tavoitteeseen; jos ei, se jattaa sen tekematta. Kumpikin on
  -- oikein — mutta operaattorin on tiedettava kumpi, koska objektien
  -- odotusluku riippuu siita.
  select '08', '0003', 'Onko 0003 ajettu (INFO — ratkaisee eran objektiluvun)', 'INFO',
         (select case when exists (select 1 from pg_tables
                                    where schemaname = 'public'
                                      and tablename = 'routines')
                      then 'KYLLA — eran objekteja 106'
                      else 'EI — eran objekteja 105' end)

  union all
  -- Jos 0003 on ajettu, sen omistajan rivin avaimen ON oltava olemassa.
  -- 0004 luo rutiinille yhdistelmaviitteen tavoitteeseen, ja ilman tata
  -- avainta se kaatuisi kesken erän.
  select '09', '0003', 'Jos 0003 on ajettu, routines_owner_row_key on olemassa',
         (select case when exists (select 1 from pg_tables
                                    where schemaname = 'public' and tablename = 'routines')
                      then '1' else '0' end),
         (select count(*)::text from pg_constraint
           where conname = 'routines_owner_row_key' and contype = 'u')

  -- ================================================================
  -- KOKO ERA ON AJAMATTA
  -- ================================================================

  union all
  -- Nolla objektia sadastaviidesta. Mika tahansa muu luku tarkoittaa,
  -- etta jokin eran migraatioista on jo ajettu tai jaanyt kesken — eika
  -- kumpaakaan korjata aloittamalla alusta.
  --
  -- Objektit lasketaan tassa yhtena joukkona. Yksittaisen migraation
  -- tarkka jakauma on sen omassa preflightissa.
  select '10', 'era', 'Yhtaan eran taulua ei ole olemassa', '0',
         (select count(*)::text from pg_tables
           where schemaname = 'public'
             and tablename in ('goals', 'projects', 'notification_preferences',
                               'wellbeing_entries', 'bills', 'recurring_expenses',
                               'savings_goals', 'ai_action_audit'))

  union all
  select '11', 'era', 'Yhtaan eran saraketta ei ole lisatty tasks-tauluun', '0',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'tasks'
             and column_name in ('deadline', 'goal_id', 'project_id'))

  union all
  select '12', 'era', 'Yhtaan eran rajoitetta ei ole olemassa', '0',
         (select count(*)::text from pg_constraint
           where conname in (
             -- 0004
             'goals_status_check', 'goals_progress_mode_check',
             'goals_manual_progress_check', 'goals_priority_check',
             'goals_title_check', 'goals_parent_not_self_check',
             'goals_owner_row_key', 'goals_parent_goal_fkey',
             'goals_project_id_fkey', 'projects_priority_check',
             'projects_date_range_check', 'projects_status_check',
             'projects_name_check', 'projects_owner_row_key',
             'projects_goal_id_fkey', 'tasks_goal_id_fkey',
             'tasks_project_id_fkey', 'routines_goal_id_fkey',
             -- 0005
             'notification_preferences_lead_check',
             'notification_preferences_max_per_day_check',
             'notification_preferences_time_format_check',
             -- 0006
             'wellbeing_entries_unique_day', 'wellbeing_entries_scale_check',
             'wellbeing_entries_sleep_check',
             -- 0007
             'recurring_expenses_cadence_check', 'recurring_expenses_amount_check',
             'recurring_expenses_day_check', 'recurring_expenses_currency_check',
             'recurring_expenses_name_check', 'recurring_expenses_owner_row_key',
             'bills_status_check', 'bills_amount_check', 'bills_currency_check',
             'bills_name_check', 'bills_paid_date_check', 'bills_task_id_fkey',
             'bills_recurring_expense_id_fkey', 'savings_goals_amount_check',
             'savings_goals_currency_check', 'savings_goals_name_check',
             'tasks_owner_row_key',
             -- 0008
             'ai_action_audit_result_check', 'ai_action_audit_risk_check',
             'ai_action_audit_summary_length_check',
             'ai_action_audit_proposal_length_check',
             'ai_action_audit_confirmed_check'))

  union all
  select '13', 'era', 'Yhtaan eran indeksia ei ole olemassa', '0',
         (select count(*)::text from pg_indexes
           where schemaname = 'public'
             and indexname in ('goals_user_status_idx', 'projects_user_status_idx',
                               'tasks_user_goal_idx', 'tasks_user_deadline_idx',
                               'wellbeing_entries_user_date_idx',
                               'recurring_expenses_user_active_idx',
                               'bills_user_status_due_idx', 'bills_user_due_idx',
                               'savings_goals_user_idx',
                               'ai_action_audit_user_time_idx'))

  union all
  select '14', 'era', 'Yhtaan eran liipaisinta ei ole olemassa', '0',
         (select count(*)::text from pg_trigger
           where not tgisinternal
             and tgname in ('goals_touch_updated_at', 'projects_touch_updated_at',
                            'notification_preferences_touch_updated_at',
                            'wellbeing_entries_touch_updated_at',
                            'bills_touch_updated_at',
                            'recurring_expenses_touch_updated_at',
                            'savings_goals_touch_updated_at'))

  -- ================================================================
  -- PALVELIN OSAA SEN, MITA ERA VAATII
  -- ================================================================

  union all
  -- Yhdistelmavierasavaimen poistotoiminto on
  -- `on delete set null (sarake)` — sarakelista suluissa. Ilman sita
  -- PostgreSQL nollaisi kaikki vierasavaimen sarakkeet, myos user_id,
  -- joka on NOT NULL. Silloin tavoitteen tai tehtavan poistaminen
  -- kaatuisi aina.
  --
  -- Sarakelista tuli PostgreSQL 15:ssa. Migraatiot 0004 ja 0007
  -- tarkistavat taman itsekin, mutta jos se on vaarin, on parempi
  -- tietaa se ENNEN kuin era on aloitettu.
  select '15', 'palvelin', 'PostgreSQL on vahintaan versio 15', '1',
         (select case when current_setting('server_version_num')::int >= 150000
                      then '1' else '0' end)

  union all
  select '16', 'palvelin', 'Palvelimen versio (INFO)', 'INFO',
         current_setting('server_version')

  -- ================================================================
  -- DATA ON EHJAA
  -- ================================================================

  union all
  -- 0004 ja 0007 lisaavat rajoitteita TUOTANNON tasks-tauluun.
  -- Omistajaton rivi ei kaataisi niita (MATCH SIMPLE ohittaa NULLin),
  -- mutta se olisi merkki siita, ettei kannan tila vastaa oletusta.
  select '17', 'data', 'Omistajattomia tehtavia ei ole', '0',
         (select count(*)::text from public.tasks where user_id is null)

  union all
  select '18', 'data', 'Orpoja omistajaviittauksia ei ole', '0',
         (select count(*)::text from public.tasks t
            left join auth.users u on u.id = t.user_id
           where u.id is null)

  union all
  select '19', 'data', 'Yhtaan tehtavaa ei omista odottamaton kayttaja', '0',
         (select count(*)::text from public.tasks
           where user_id is distinct from '2cc00622-f927-4604-a518-361a4328481b'::uuid)

  union all
  -- 0007 lisaa tasks-tauluun rajoitteen unique (user_id, id). Se ei voi
  -- kaatua dataan, koska id on jo paaavain — mutta jos tama luku ei
  -- olisi nolla, oletus olisi vaara ja rajoite kaatuisi kesken eran.
  select '20', 'data', 'Tehtavien pari (user_id, id) on jo yksikasitteinen', '0',
         (select count(*)::text from (
            select 1 from public.tasks group by user_id, id having count(*) > 1
          ) kaksoiskappaleet)

  union all
  select '21', 'data', 'Tehtavien lukumaara (INFO)', 'INFO',
         (select count(*)::text from public.tasks)

  union all
  select '22', 'data', 'Auth-kayttajia (INFO)', 'INFO',
         (select count(*)::text from auth.users)

  -- ================================================================
  -- OIKEUSYMPARISTO
  -- ================================================================

  union all
  select '23', 'oikeudet', 'anon-roolilla ei ole tehollista oikeutta tauluun tasks', '0',
         (select count(*)::text
            from (select unnest(array['select', 'insert', 'update', 'delete',
                                      'truncate', 'references', 'trigger']) as oikeus) pp
           where has_table_privilege('anon', 'public.tasks', pp.oikeus))

  union all
  select '24', 'oikeudet', 'PUBLIC-roolilla ei ole oikeuksia tauluun tasks', '0',
         (select count(*)::text
            from pg_class cl, aclexplode(cl.relacl) acl
           where cl.oid = 'public.tasks'::regclass and acl.grantee = 0)

  union all
  -- OLETUSOIKEUDET: TURVALLINEN YMPARISTOEHTO, EI ESTE.
  --
  -- Supabase myontaa vakiona oletusoikeudet tuleville tauluille
  -- (ALTER DEFAULT PRIVILEGES). Uusi taulu voi siis SYNTYA avoimena.
  -- Tama on INFO eika FAIL, koska jokainen eran migraatio revokoi
  -- PUBLIC-, anon- ja authenticated-roolit ennen grantia ja todistaa
  -- lopputuloksen ennen committia.
  --
  -- Nailla ei siis ole vaikutusta lopputulokseen — mutta jos luku on
  -- suuri ja jokin migraatio unohtaisi revoken, ero olisi juuri tassa.
  -- Siksi se kirjataan.
  --
  -- ALA aja ALTER DEFAULT PRIVILEGES -lausetta pelkastaan taman rivin
  -- takia. Se muuttaisi koko kannan kaytosta laajemmin kuin era vaatii.
  select '25', 'ymparisto', 'Oletusoikeusmerkintoja roolille anon (INFO)', 'INFO',
         (select count(*)::text
            from pg_default_acl d, aclexplode(d.defaclacl) acl
           where acl.grantee = (select oid from pg_roles where rolname = 'anon'))

  union all
  select '26', 'ymparisto', 'Oletusoikeusmerkintoja roolille PUBLIC (INFO)', 'INFO',
         (select count(*)::text
            from pg_default_acl d, aclexplode(d.defaclacl) acl
           where acl.grantee = 0)

  union all
  -- TODISTUS SIITA, ETTA REVOKE-MALLI TOIMII TASSA KANNASSA.
  --
  -- Ylla olevat luvut kertovat, etta oletusoikeuksia on. Nama kaksi
  -- riviae kertovat, etta ne on jo kertaalleen neutraloitu olemassa
  -- olevissa tauluissa samalla mallilla, jota era kayttaa. Jos nama
  -- olisivat nollaa suurempia, mallia ei voisi luottaa toimivan.
  select '27', 'oikeudet', 'Malli toimii: anon ei paase tauluihin tasks/profile', '0',
         (select count(*)::text
            from (select unnest(array['public.tasks', 'public.profile']) as taulu) tt
            cross join (select unnest(array['select', 'insert', 'update', 'delete',
                                            'truncate', 'references', 'trigger']) as oikeus) pp
           where has_table_privilege('anon', tt.taulu, pp.oikeus))

  union all
  select '28', 'oikeudet', 'Malli toimii: PUBLIC ei paase tauluihin tasks/profile', '0',
         (select count(*)::text
            from pg_class cl, aclexplode(cl.relacl) acl
           where cl.oid = any (array['public.tasks'::regclass,
                                     'public.profile'::regclass])
             and acl.grantee = 0)

  -- ================================================================
  -- ESTEET: LUKOT JA PITKAT TRANSAKTIOT
  -- ================================================================

  union all
  -- Migraatiot 0004 ja 0007 ottavat TUOTANNON tasks-tauluun ACCESS
  -- EXCLUSIVE -lukon. Kaikki viisi viittaavat auth.users-tauluun, jota
  -- jokainen kirjautuminen koskee.
  --
  -- Lukkojono on FIFO: jos migraatio jaa jonoon pitkan transaktion
  -- taakse, sen TAAKSE jonoutuu jokainen kirjautuminen ja jokainen
  -- tehtavan luku. lock_timeout = 5s rajaa vahingon, mutta on parempi
  -- olla aloittamatta kuin keskeyttaa.
  select '29', 'esteet', 'Avoimia idle in transaction -istuntoja ei ole', '0',
         (select count(*)::text from pg_stat_activity
           where datname = current_database()
             and state = 'idle in transaction'
             and pid <> pg_backend_pid())

  union all
  select '30', 'esteet', 'Yli minuutin kestaneita kyselyita ei ole kaynnissa', '0',
         (select count(*)::text from pg_stat_activity
           where datname = current_database()
             and state = 'active'
             and pid <> pg_backend_pid()
             and now() - query_start > interval '1 minute')

  union all
  select '31', 'esteet', 'Odottavia lukkoja ei ole', '0',
         (select count(*)::text from pg_locks
           where not granted and pid <> pg_backend_pid())

  union all
  select '32', 'esteet', 'tasks-taulussa ei ole muiden istuntojen lukkoja', '0',
         (select count(*)::text from pg_locks
           where relation = 'public.tasks'::regclass
             and pid <> pg_backend_pid())

  -- ================================================================
  -- KIRJATTAVAT
  -- ================================================================

  union all
  select '33', 'kirjattavat', 'Tietokanta', 'INFO', current_database()

  union all
  select '34', 'kirjattavat', 'Tauluja public-skeemassa', 'INFO',
         (select count(*)::text from pg_tables where schemaname = 'public')

  union all
  select '35', 'kirjattavat', 'Politiikkoja public-skeemassa', 'INFO',
         (select count(*)::text from pg_policies where schemaname = 'public')

  union all
  -- Tiiviste tunnisteista, ei sisallosta. Sen avulla voi jalkikateen
  -- todeta, ettei tehtavajoukko muuttunut eran aikana — ilman etta
  -- yhtaan otsikkoa luetaan tai kirjataan mihinkaan.
  select '36', 'kirjattavat', 'Tehtavien tunnisteiden tiiviste', 'INFO',
         (select coalesce(md5(string_agg(id, ',' order by id)), 'ei rivejä')
            from public.tasks)

  union all
  select '37', 'kirjattavat', 'Tarkistuksen hetki (UTC)', 'INFO',
         to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS')

) c
order by c.check_no;
