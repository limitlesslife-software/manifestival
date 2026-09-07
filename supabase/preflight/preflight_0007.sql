-- Preflight: ENNEN migraatiota 0007_finance
-- VAIN LUKEVA. Yksi lause, yksi taulukko, yksi kopiointi.
--
-- MILLOIN: juuri ennen kuin 0007 ajetaan. Vastaa kysymykseen "onko
-- tuotanto siina tilassa, jota 0007 olettaa" — ennen kuin 0007 itse
-- sen paattaa ja keskeytyy.
--
-- Koko eran ymparistotarkistus on eri tiedostossa:
-- preflight_0004_0008_batch.sql. Se ajetaan kerran ennen eraa; tama
-- ajetaan jokaisen migraation edella.
--
-- ODOTUS: jokaisen PASS/FAIL-rivin status = 'PASS' ja
-- poikkeavia_yhteensa = 0. INFO-rivit ovat kirjattavia lukuja.
--
-- YKSIKIN FAIL = MIGRAATIOTA 0007 EI AJETA, eika lippua
-- bills, recurringExpenses ja savingsGoals kaanneta.
--
-- MIKA TASSA MIGRAATIOSSA ON ERITYISTA
--
-- 0007 KOSKEE TUOTANNON tasks-TAULUUN. Se lisaa siihen rajoitteen
--
--   alter table public.tasks add constraint tasks_owner_row_key
--     unique (user_id, id);
--
-- Rajoite on valttamaton, koska bills.task_id on yhdistelmavierasavain
-- ja PostgreSQL vaatii kohteelta yksikasitteisyysrajoitteen. Se EI voi
-- kaatua dataan, koska id on jo paaavain — mutta rajoitteen luonti ottaa
-- tauluun ACCESS EXCLUSIVE -lukon ja rakentaa indeksin.
--
-- Tarkistus 22 todistaa, ettei rajoite voi kaatua: pari (user_id, id) on
-- jo yksikasitteinen. Jos se ei olisi, oletus olisi vaara.
--
-- Migraatio vaatii myos PostgreSQL 15:n sarakekohtaisen
-- ON DELETE SET NULL -muodon takia.
--
-- OBJEKTILISTAT
-- Alla olevat nimet ovat migraation 39 objektia. Nolla =
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
  select '07', '0007', 'Migraation tauluja ei ole viela luotu', '0',
         (select count(*)::text from pg_tables
           where schemaname = 'public'
             and tablename in ('bills', 'recurring_expenses', 'savings_goals'))

  union all
  select '08', '0007', 'Migraation rajoitteita ei ole viela luotu', '0',
         (select count(*)::text from pg_constraint
           where conname in ('bills_amount_check', 'bills_currency_check',
                              'bills_name_check', 'bills_paid_date_check',
                              'bills_recurring_expense_id_fkey', 'bills_status_check',
                              'bills_task_id_fkey', 'recurring_expenses_amount_check',
                              'recurring_expenses_cadence_check',
                              'recurring_expenses_currency_check',
                              'recurring_expenses_day_check', 'recurring_expenses_name_check',
                              'recurring_expenses_owner_row_key',
                              'savings_goals_amount_check', 'savings_goals_currency_check',
                              'savings_goals_name_check', 'tasks_owner_row_key'))

  union all
  select '09', '0007', 'Migraation indekseja ei ole viela luotu', '0',
         (select count(*)::text from pg_indexes
           where schemaname = 'public'
             and indexname in ('bills_user_due_idx', 'bills_user_status_due_idx',
                              'recurring_expenses_user_active_idx', 'savings_goals_user_idx'))

  union all
  select '10', '0007', 'Migraation liipaisimia ei ole viela luotu', '0',
         (select count(*)::text from pg_trigger
           where not tgisinternal
             and tgname in ('bills_touch_updated_at', 'recurring_expenses_touch_updated_at',
                              'savings_goals_touch_updated_at'))

  union all
  select '11', '0007', 'Migraation politiikkoja ei ole viela luotu', '0',
         (select count(*)::text from pg_policies
           where schemaname = 'public'
             and policyname in ('bills_delete_own', 'bills_insert_own', 'bills_select_own',
                              'bills_update_own', 'recurring_expenses_delete_own',
                              'recurring_expenses_insert_own',
                              'recurring_expenses_select_own',
                              'recurring_expenses_update_own', 'savings_goals_delete_own',
                              'savings_goals_insert_own', 'savings_goals_select_own',
                              'savings_goals_update_own'))

  union all
  select '12', 'palvelin', 'PostgreSQL on vahintaan versio 15', '1',
         (select case when current_setting('server_version_num')::int >= 150000
                      then '1' else '0' end)

  union all
  select '13', 'esiehdot', 'tasks.user_id on NOT NULL', '1',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'tasks'
             and column_name = 'user_id' and is_nullable = 'NO')

  union all
  select '14', 'esiehdot', 'Tehtavien pari (user_id, id) on jo yksikasitteinen', '0',
         (select count(*)::text from (
            select 1 from public.tasks group by user_id, id having count(*) > 1
          ) kaksoiskappaleet)

  union all
  select '15', 'esiehdot', 'Omistajattomia tai orpoja tehtavia ei ole', '0',
         ((select count(*) from public.tasks where user_id is null)
        + (select count(*) from public.tasks t
             left join auth.users u on u.id = t.user_id
            where u.id is null))::text

  union all
  select '16', 'esteet', 'Avoimia idle in transaction -istuntoja ei ole', '0',
         (select count(*)::text from pg_stat_activity
           where datname = current_database()
             and state = 'idle in transaction'
             and pid <> pg_backend_pid())

  union all
  select '17', 'esteet', 'Yli minuutin kestaneita kyselyita ei ole kaynnissa', '0',
         (select count(*)::text from pg_stat_activity
           where datname = current_database()
             and state = 'active'
             and pid <> pg_backend_pid()
             and now() - query_start > interval '1 minute')

  union all
  select '18', 'esteet', 'Odottavia lukkoja ei ole', '0',
         (select count(*)::text from pg_locks
           where not granted and pid <> pg_backend_pid())

  union all
  select '19', 'kirjattavat', 'Tehtavien lukumaara', 'INFO',
         (select count(*)::text from public.tasks)

  union all
  select '20', 'kirjattavat', 'Tietokanta', 'INFO',
         current_database()

  union all
  select '21', 'kirjattavat', 'Palvelimen versio', 'INFO',
         current_setting('server_version')

  union all
  select '22', 'kirjattavat', 'Tarkistuksen hetki (UTC)', 'INFO',
         to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS')

) c
order by c.check_no;
