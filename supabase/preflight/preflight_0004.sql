-- Preflight: ENNEN migraatiota 0004_goals_projects
-- VAIN LUKEVA. Yksi lause, yksi taulukko, yksi kopiointi.
--
-- MILLOIN: juuri ennen kuin 0004 ajetaan. Vastaa kysymykseen "onko
-- tuotanto siina tilassa, jota 0004 olettaa" — ennen kuin 0004 itse
-- sen paattaa ja keskeytyy.
--
-- Koko eran ymparistotarkistus on eri tiedostossa:
-- preflight_0004_0008_batch.sql. Se ajetaan kerran ennen eraa; tama
-- ajetaan jokaisen migraation edella.
--
-- ODOTUS: jokaisen PASS/FAIL-rivin status = 'PASS' ja
-- poikkeavia_yhteensa = 0. INFO-rivit ovat kirjattavia lukuja.
--
-- YKSIKIN FAIL = MIGRAATIOTA 0004 EI AJETA, eika lippua
-- goals ja projects kaanneta.
--
-- MIKA TASSA MIGRAATIOSSA ON ERITYISTA
--
-- 0004 ei ole pelkka uusien taulujen luonti. Se lisaa KOLME SARAKETTA ja
-- KAKSI VIERASAVAINTA tuotannon tasks-tauluun ja ottaa siihen ACCESS
-- EXCLUSIVE -lukon. Jos migraatio jaa jonoon pitkan transaktion taakse,
-- sen taakse jonoutuu jokainen tehtavan luku ja jokainen kirjautuminen.
--
-- Se myos vaatii PostgreSQL 15:n: yhdistelmavierasavaimen poistotoiminto
-- on `on delete set null (goal_id)` — sarakelista suluissa. Ilman sita
-- tavoitteen poisto yrittaisi nollata myos user_id:n, joka on NOT NULL,
-- ja kaatuisi joka kerta.
--
-- OBJEKTILISTAT
-- Alla olevat nimet ovat migraation 36 tai 37 objektia. Nolla =
-- tuore ajo. Mika tahansa muu luku tarkoittaa, etta ajo on tehty tai
-- jaanyt kesken — eika kumpaakaan korjata ajamalla uudelleen. Migraatio
-- itse tarkistaa saman ja keskeytyy; tama kertoo sen etukateen.
-- Objektien maara riippuu siita, onko 0003 ajettu: rutiinin viite
-- tavoitteeseen syntyy vain silloin.
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
  select '07', '0004', 'Migraation tauluja ei ole viela luotu', '0',
         (select count(*)::text from pg_tables
           where schemaname = 'public'
             and tablename in ('goals', 'projects'))

  union all
  select '08', '0004', 'Migraation sarakkeita ei ole viela lisatty tasks-tauluun', '0',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'tasks'
             and column_name in ('deadline', 'goal_id', 'project_id'))

  union all
  select '09', '0004', 'Migraation rajoitteita ei ole viela luotu', '0',
         (select count(*)::text from pg_constraint
           where conname in ('goals_manual_progress_check', 'goals_owner_row_key',
                              'goals_parent_goal_fkey', 'goals_parent_not_self_check',
                              'goals_priority_check', 'goals_progress_mode_check',
                              'goals_project_id_fkey', 'goals_status_check',
                              'goals_title_check', 'projects_date_range_check',
                              'projects_goal_id_fkey', 'projects_name_check',
                              'projects_owner_row_key', 'projects_priority_check',
                              'projects_status_check', 'routines_goal_id_fkey',
                              'tasks_goal_id_fkey', 'tasks_project_id_fkey'))

  union all
  select '10', '0004', 'Migraation indekseja ei ole viela luotu', '0',
         (select count(*)::text from pg_indexes
           where schemaname = 'public'
             and indexname in ('goals_user_status_idx', 'projects_user_status_idx',
                              'tasks_user_deadline_idx', 'tasks_user_goal_idx'))

  union all
  select '11', '0004', 'Migraation liipaisimia ei ole viela luotu', '0',
         (select count(*)::text from pg_trigger
           where not tgisinternal
             and tgname in ('goals_touch_updated_at', 'projects_touch_updated_at'))

  union all
  select '12', '0004', 'Migraation politiikkoja ei ole viela luotu', '0',
         (select count(*)::text from pg_policies
           where schemaname = 'public'
             and policyname in ('goals_delete_own', 'goals_insert_own', 'goals_select_own',
                              'goals_update_own', 'projects_delete_own',
                              'projects_insert_own', 'projects_select_own',
                              'projects_update_own'))

  union all
  select '13', 'palvelin', 'PostgreSQL on vahintaan versio 15', '1',
         (select case when current_setting('server_version_num')::int >= 150000
                      then '1' else '0' end)

  union all
  select '14', 'esiehdot', 'tasks.user_id on NOT NULL', '1',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'tasks'
             and column_name = 'user_id' and is_nullable = 'NO')

  union all
  select '15', 'esiehdot', 'Omistajattomia tai orpoja tehtavia ei ole', '0',
         ((select count(*) from public.tasks where user_id is null)
        + (select count(*) from public.tasks t
             left join auth.users u on u.id = t.user_id
            where u.id is null))::text

  union all
  select '16', 'esiehdot', 'Jos 0003 on ajettu, routines_owner_row_key on olemassa', (select case when exists (select 1 from pg_tables
                                    where schemaname = 'public'
                                      and tablename = 'routines')
                      then '1' else '0' end),
         (select count(*)::text from pg_constraint
           where conname = 'routines_owner_row_key' and contype = 'u')

  union all
  select '17', 'esteet', 'Avoimia idle in transaction -istuntoja ei ole', '0',
         (select count(*)::text from pg_stat_activity
           where datname = current_database()
             and state = 'idle in transaction'
             and pid <> pg_backend_pid())

  union all
  select '18', 'esteet', 'Yli minuutin kestaneita kyselyita ei ole kaynnissa', '0',
         (select count(*)::text from pg_stat_activity
           where datname = current_database()
             and state = 'active'
             and pid <> pg_backend_pid()
             and now() - query_start > interval '1 minute')

  union all
  select '19', 'esteet', 'Odottavia lukkoja ei ole', '0',
         (select count(*)::text from pg_locks
           where not granted and pid <> pg_backend_pid())

  union all
  select '20', 'kirjattavat', 'Tehtavien lukumaara', 'INFO',
         (select count(*)::text from public.tasks)

  union all
  select '21', 'kirjattavat', 'Tietokanta', 'INFO',
         current_database()

  union all
  select '22', 'kirjattavat', 'Palvelimen versio', 'INFO',
         current_setting('server_version')

  union all
  select '23', 'kirjattavat', 'Tarkistuksen hetki (UTC)', 'INFO',
         to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS')

) c
order by c.check_no;
