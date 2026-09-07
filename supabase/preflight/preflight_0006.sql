-- Preflight: ENNEN migraatiota 0006_wellbeing
-- VAIN LUKEVA. Yksi lause, yksi taulukko, yksi kopiointi.
--
-- MILLOIN: juuri ennen kuin 0006 ajetaan. Vastaa kysymykseen "onko
-- tuotanto siina tilassa, jota 0006 olettaa" — ennen kuin 0006 itse
-- sen paattaa ja keskeytyy.
--
-- Koko eran ymparistotarkistus on eri tiedostossa:
-- preflight_0004_0008_batch.sql. Se ajetaan kerran ennen eraa; tama
-- ajetaan jokaisen migraation edella.
--
-- ODOTUS: jokaisen PASS/FAIL-rivin status = 'PASS' ja
-- poikkeavia_yhteensa = 0. INFO-rivit ovat kirjattavia lukuja.
--
-- YKSIKIN FAIL = MIGRAATIOTA 0006 EI AJETA, eika lippua
-- wellbeing kaanneta.
--
-- MIKA TASSA MIGRAATIOSSA ON ERITYISTA
--
-- 0006 luo paketin ARKALUONTOISIMMAN taulun. Sarake `note` on vapaata
-- tekstia, johon ihminen kirjoittaa mita tahansa, ja mittarit kertovat
-- jaksamisesta.
--
-- Siksi tama preflight — kuten kaikki taman paketin kyselyt — ei lue
-- yhtaan sisaltosaraketta. Se laskee rivimaaria ja katsoo rakennetta.
--
-- Migraatio ei koske olemassa olevaan dataan.
--
-- OBJEKTILISTAT
-- Alla olevat nimet ovat migraation 10 objektia. Nolla =
-- tuore ajo. Mika tahansa muu luku tarkoittaa, etta ajo on tehty tai
-- jaanyt kesken — eika kumpaakaan korjata ajamalla uudelleen. Migraatio
-- itse tarkistaa saman ja keskeytyy; tama kertoo sen etukateen.
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
  select '06', '0002', 'Funktio touch_updated_at on kovennettu', '1',
         (select count(*)::text from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'touch_updated_at'
             and p.prosecdef = false
             and p.proconfig is not null
             and exists (select 1 from unnest(p.proconfig) a
                          where a like 'search\_path=%'))

  union all
  select '07', '0006', 'Migraation tauluja ei ole viela luotu', '0',
         (select count(*)::text from pg_tables
           where schemaname = 'public'
             and tablename in ('wellbeing_entries'))

  union all
  select '08', '0006', 'Migraation rajoitteita ei ole viela luotu', '0',
         (select count(*)::text from pg_constraint
           where conname in ('wellbeing_entries_scale_check',
                              'wellbeing_entries_sleep_check', 'wellbeing_entries_unique_day'))

  union all
  select '09', '0006', 'Migraation indekseja ei ole viela luotu', '0',
         (select count(*)::text from pg_indexes
           where schemaname = 'public'
             and indexname in ('wellbeing_entries_user_date_idx'))

  union all
  select '10', '0006', 'Migraation liipaisimia ei ole viela luotu', '0',
         (select count(*)::text from pg_trigger
           where not tgisinternal
             and tgname in ('wellbeing_entries_touch_updated_at'))

  union all
  select '11', '0006', 'Migraation politiikkoja ei ole viela luotu', '0',
         (select count(*)::text from pg_policies
           where schemaname = 'public'
             and policyname in ('wellbeing_entries_delete_own', 'wellbeing_entries_insert_own',
                              'wellbeing_entries_select_own', 'wellbeing_entries_update_own'))

  union all
  select '12', 'esteet', 'Avoimia idle in transaction -istuntoja ei ole', '0',
         (select count(*)::text from pg_stat_activity
           where datname = current_database()
             and state = 'idle in transaction'
             and pid <> pg_backend_pid())

  union all
  select '13', 'esteet', 'Yli minuutin kestaneita kyselyita ei ole kaynnissa', '0',
         (select count(*)::text from pg_stat_activity
           where datname = current_database()
             and state = 'active'
             and pid <> pg_backend_pid()
             and now() - query_start > interval '1 minute')

  union all
  select '14', 'esteet', 'Odottavia lukkoja ei ole', '0',
         (select count(*)::text from pg_locks
           where not granted and pid <> pg_backend_pid())

  union all
  select '15', 'kirjattavat', 'Tehtavien lukumaara', 'INFO',
         (select count(*)::text from public.tasks)

  union all
  select '16', 'kirjattavat', 'Tietokanta', 'INFO',
         current_database()

  union all
  select '17', 'kirjattavat', 'Palvelimen versio', 'INFO',
         current_setting('server_version')

  union all
  select '18', 'kirjattavat', 'Tarkistuksen hetki (UTC)', 'INFO',
         to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS')

) c
order by c.check_no;
