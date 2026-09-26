-- Varmistus: 0010_goal_to_action
-- VAIN LUKEVA. Yksi lause, yksi taulukko, yksi kopiointi.
-- Aja heti migraation jalkeen.
--
-- ODOTUS: jokaisen PASS/FAIL-rivin status = 'PASS' ja
-- poikkeavia_yhteensa = 0. Yksikin FAIL tarkoittaa, ettei lippuja
-- milestones, GOAL_PLANNING_FIELDS eika GOAL_MAINTENANCE_MODE saa
-- kaantaa.
--
-- NELJA ASIAA, JOTKA TAMA ERITYISESTI TODISTAA
--
-- 1. TILARAJOITE ON YHA OLEMASSA. Migraatio pudottaa
--    goals_status_check -rajoitteen ja luo sen uudelleen. Keskeytynyt
--    ajo jattaisi taulun ilman tilarajoitetta, eika mikaan sovelluksessa
--    huomaisi sita. Tarkistukset 20 ja 21.
--
-- 2. POISTOSAANTO RAJAA NOLLAUKSEN SARAKKEESEEN. Ilman sarakelistaa
--    PostgreSQL nollaisi koko vierasavaimen, myos NOT NULL -sarakkeen
--    user_id -- ja valitavoitteen poisto kaatuisi. Tarkistus 16.
--
-- 3. VALITAVOITE EI VOI KUULUA TOISEN KAYTTAJAN TAVOITTEELLE.
--    Yhdistelmavierasavain estaa sen, ei RLS: vierasavaimen tarkistus
--    EI kulje RLS:n lapi. Tarkistus 15.
--
-- 4. VANHA DATA ON YHA KELVOLLISTA. Migraatio muuttaa tauluja joissa on
--    kayttajan dataa. Tarkistukset 24-27.
--
-- Rakenne luetaan KATALOGEISTA, ei nimista.
--
-- Tama tiedosto EI lue sarakkeita title, description eika metric.
-- Ne ovat kayttajan omaa tekstia, ja varmistus tarvitsee vain rakenteen.

-- NULL-TULOS ON POIKKEAMA. Puuttuva objekti tuottaa tarkistukseen NULLin:
-- se on FAIL, se lasketaan poikkeavia_yhteensa-lukuun (is distinct from)
-- ja details kertoo "toteutui null". Harjoiteltu: tools/pg-rehearsal
-- (verify:null).
select c.check_no, c.section, c.check_name,
       case when c.odotus = 'INFO' then 'INFO'
            when c.toteutui = c.odotus then 'PASS' else 'FAIL' end as status,
       case when c.odotus = 'INFO' then c.toteutui
            else 'odotus ' || c.odotus || ', toteutui ' || coalesce(c.toteutui, 'null') end as details,
       count(*) filter (where c.odotus <> 'INFO' and c.toteutui is distinct from c.odotus)
         over () as poikkeavia_yhteensa
from (

  -- ================================================================
  -- UUSI TAULU
  -- ================================================================

  select '01' as check_no, 'taulut' as section,
         'Taulu milestones on olemassa' as check_name,
         '1' as odotus,
         (select count(*)::text from pg_tables
           where schemaname = 'public' and tablename = 'milestones') as toteutui

  union all
  select '02', 'taulut', 'milestones: odotetut sarakkeet ovat olemassa', '11',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'milestones'
             and column_name in ('id', 'user_id', 'goal_id', 'title', 'description',
                                 'target_date', 'status', 'order_index', 'rule',
                                 'reached_date', 'created_at'))

  union all
  -- Kokonaismaara yksin ei todista mitaan: se voisi tasmata, vaikka
  -- odotettu sarake puuttuisi ja tilalla olisi tuntematon.
  select '03', 'taulut', 'milestones: ei nimeamattomia sarakkeita', '0',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'milestones'
             and column_name not in ('id', 'user_id', 'goal_id', 'title', 'description',
                                     'target_date', 'status', 'order_index', 'rule',
                                     'reached_date', 'created_at', 'updated_at'))

  union all
  select '04', 'taulut', 'milestones.goal_id on NOT NULL', 'NO',
         (select is_nullable::text from information_schema.columns
           where table_schema = 'public' and table_name = 'milestones'
             and column_name = 'goal_id')

  -- ================================================================
  -- UUDET SARAKKEET OLEMASSA OLEVISSA TAULUISSA
  -- ================================================================

  union all
  select '05', 'sarakkeet', 'goals: seitseman uutta saraketta', '7',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'goals'
             and column_name in ('metric', 'unit', 'baseline_value', 'current_value',
                                 'target_value', 'measured_on', 'savings_goal_id'))

  union all
  select '06', 'sarakkeet', 'tasks: kaksi uutta saraketta', '2',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'tasks'
             and column_name in ('milestone_id', 'depends_on'))

  union all
  select '07', 'sarakkeet', 'projects: milestone_id on olemassa', '1',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'projects'
             and column_name = 'milestone_id')

  union all
  select '08', 'sarakkeet', 'profile: kaksi uutta saraketta', '2',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'profile'
             and column_name in ('automation_level', 'planning_buffer_ratio'))

  union all
  -- MITTARI EI OLE RAHAA. Paino on 82,4 kg -- kokonaisluku hukkaisi
  -- desimaalit, ja liukuluku harhautuisi senteissa. numeric on oikea.
  select '09', 'sarakkeet', 'goals: mittarisarakkeet ovat numeric', '3',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'goals'
             and column_name in ('baseline_value', 'current_value', 'target_value')
             and data_type = 'numeric')

  union all
  select '10', 'sarakkeet', 'tasks.depends_on on taulukko', 'ARRAY',
         (select data_type::text from information_schema.columns
           where table_schema = 'public' and table_name = 'tasks'
             and column_name = 'depends_on')

  union all
  -- Uudet sarakkeet olemassa olevissa tauluissa ovat NULLABLE, paitsi
  -- ne joilla on oletusarvo. NOT NULL ilman oletusta olisi tehnyt
  -- vanhoista riveista kelvottomia.
  select '11', 'sarakkeet', 'goals: uudet sarakkeet ovat nullable', '7',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'goals'
             and column_name in ('metric', 'unit', 'baseline_value', 'current_value',
                                 'target_value', 'measured_on', 'savings_goal_id')
             and is_nullable = 'YES')

  -- ================================================================
  -- RAJOITTEET
  -- ================================================================

  union all
  select '12', 'rajoitteet', 'milestones: kuusi CHECK-rajoitetta', '6',
         (select count(*)::text from pg_constraint
           where conrelid = 'public.milestones'::regclass and contype = 'c'
             and conname in ('milestones_status_check',
                             'milestones_rule_check',
                             'milestones_title_check',
                             'milestones_description_length_check',
                             'milestones_reached_date_check',
                             'milestones_order_check'))

  union all
  select '13', 'rajoitteet', 'goals: nelja uutta CHECK-rajoitetta', '4',
         (select count(*)::text from pg_constraint
           where conrelid = 'public.goals'::regclass and contype = 'c'
             and conname in ('goals_metric_pair_check',
                             'goals_savings_exclusive_check',
                             'goals_metric_length_check',
                             'goals_unit_length_check'))

  union all
  select '14', 'rajoitteet', 'tasks: kaksi uutta CHECK-rajoitetta', '2',
         (select count(*)::text from pg_constraint
           where conrelid = 'public.tasks'::regclass and contype = 'c'
             and conname in ('tasks_depends_on_length_check',
                             'tasks_depends_on_no_self_check'))

  union all
  -- YHDISTELMAVIERASAVAIN ON SE, JOKA ESTAA RISTIINKIINNITYKSEN.
  -- Vierasavaimen tarkistus EI kulje RLS:n lapi: RLS estaa lukemisen,
  -- ei viittaamista. Kaksi saraketta viitteessa on koko suoja.
  select '15', 'rajoitteet', 'Kolme vierasavainta viittaa kahdella sarakkeella', '3',
         (select count(*)::text from pg_constraint
           where conname in ('milestones_goal_fkey', 'tasks_milestone_fkey',
                             'projects_milestone_fkey')
             and contype = 'f'
             and array_length(conkey, 1) = 2)

  union all
  -- POISTOSAANTO RAJAA NOLLAUKSEN SARAKKEESEEN.
  --
  -- Ilman sarakelistaa PostgreSQL nollaisi koko vierasavaimen, myos
  -- user_id:n joka on NOT NULL -- ja valitavoitteen poisto kaatuisi
  -- virheeseen 23502. Vika loytyi migraatiossa 0004.
  select '16', 'rajoitteet', 'SET NULL rajaa nollauksen yhteen sarakkeeseen', '2',
         (select count(*)::text from pg_constraint
           where conname in ('tasks_milestone_fkey', 'projects_milestone_fkey')
             and confdeltype = 'n'
             and array_length(confdelsetcols, 1) = 1)

  union all
  -- VALITAVOITE EI ELA ILMAN TAVOITETTA. Tavoitteen poisto vie sen.
  select '17', 'rajoitteet', 'milestones_goal_fkey on CASCADE', 'c',
         (select confdeltype::text from pg_constraint
           where conname = 'milestones_goal_fkey')

  union all
  select '18', 'rajoitteet', 'Omistajan rivin avain on olemassa', '1',
         (select count(*)::text from pg_constraint
           where conname = 'milestones_owner_row_key' and contype = 'u')

  union all
  select '19', 'rajoitteet', 'profile: automaatiotason rajoite on olemassa', '2',
         (select count(*)::text from pg_constraint
           where conrelid = 'public.profile'::regclass and contype = 'c'
             and conname in ('profile_automation_level_check',
                             'profile_buffer_ratio_check'))

  -- ================================================================
  -- TILARAJOITTEEN KORVAAMINEN
  --
  -- TAMA ON MIGRAATION VAARALLISIN KOHTA. Rajoite pudotetaan ja
  -- luodaan uudelleen; keskeytynyt ajo jattaisi taulun ilman
  -- tilarajoitetta, eika mikaan sovelluksessa huomaisi sita.
  -- ================================================================

  union all
  select '20', 'tilarajoite', 'goals_status_check on olemassa', '1',
         (select count(*)::text from pg_constraint
           where conname = 'goals_status_check' and contype = 'c')

  union all
  select '21', 'tilarajoite', 'goals_status_check sallii arvon maintenance', '1',
         (select count(*)::text from pg_constraint
           where conname = 'goals_status_check'
             and pg_get_constraintdef(oid) like '%maintenance%')

  union all
  -- JA SE YHA KIELTAA TUNTEMATTOMAT ARVOT. Rajoite, joka sallii
  -- kaiken, on sama kuin ei rajoitetta.
  select '22', 'tilarajoite', 'goals_status_check luettelee tasan kuusi arvoa', '6',
         (select (length(pg_get_constraintdef(oid))
                  - length(replace(pg_get_constraintdef(oid), '''::text', '')))
                 / length('''::text')
          from pg_constraint where conname = 'goals_status_check')::text

  -- ================================================================
  -- RLS JA OIKEUDET
  -- ================================================================

  union all
  select '23', 'rls', 'RLS on paalla milestones-taulussa', '1',
         (select count(*)::text from pg_class
           where relnamespace = 'public'::regnamespace
             and relname = 'milestones' and relrowsecurity)

  union all
  select '24', 'rls', 'Nelja omistajuuspolitiikkaa', '4',
         (select count(*)::text from pg_policies
           where schemaname = 'public' and tablename = 'milestones')

  union all
  -- Politiikka joka koskee rooleja {public} paastaisi anonin sisaan
  -- vaikka nimessa lukisi mita tahansa.
  select '25', 'rls', 'Yksikaan politiikka ei koske public-roolia', '0',
         (select count(*)::text from pg_policies
           where schemaname = 'public' and tablename = 'milestones'
             and 'public' = any(roles))

  union all
  select '26', 'rls', 'anon-roolilla ei ole oikeuksia', '0',
         (select count(*)::text from information_schema.role_table_grants
           where table_schema = 'public' and table_name = 'milestones'
             and grantee in ('anon', 'public'))

  union all
  select '27', 'rls', 'authenticated saa nelja oikeutta', '4',
         (select count(*)::text from information_schema.role_table_grants
           where table_schema = 'public' and table_name = 'milestones'
             and grantee = 'authenticated'
             and privilege_type in ('SELECT', 'INSERT', 'UPDATE', 'DELETE'))

  -- ================================================================
  -- INDEKSIT JA LIIPAISIN
  -- ================================================================

  union all
  select '28', 'indeksit', 'Kaksi nimettya indeksia on olemassa', '2',
         (select count(*)::text from pg_indexes
           where schemaname = 'public'
             and indexname in ('milestones_user_goal_idx', 'milestones_user_target_idx'))

  union all
  select '29', 'liipaisin', 'milestones_touch_updated_at on olemassa', '1',
         (select count(*)::text from pg_trigger
           where not tgisinternal and tgname = 'milestones_touch_updated_at')

  union all
  select '30', 'liipaisin', 'touch_updated_at on yha SECURITY INVOKER', 'false',
         (select p.prosecdef::text from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'touch_updated_at')

  -- ================================================================
  -- DATAN EHEYS
  -- ================================================================

  union all
  select '31', 'data', 'Jokainen valitavoite kuuluu olemassa olevalle tavoitteelle', '0',
         (select count(*)::text from public.milestones m
           where not exists (select 1 from public.goals g
                              where g.id = m.goal_id and g.user_id = m.user_id))

  union all
  -- Saavutettu ilman paivaa on tieto joka ei kerro milloin.
  select '32', 'data', 'Saavutetulla valitavoitteella on saavutuspaiva', '0',
         (select count(*)::text from public.milestones
           where (status = 'reached' and reached_date is null)
              or (status <> 'reached' and reached_date is not null))

  union all
  select '33', 'data', 'Yksikaan tehtava ei riipu itsestaan', '0',
         (select count(*)::text from public.tasks where id = any(depends_on))

  union all
  select '34', 'data', 'Mittarilla on nimi jos sille on tavoitearvo', '0',
         (select count(*)::text from public.goals
           where target_value is not null and metric is null)

  union all
  select '35', 'data', 'Saastokytkenta ja oma mittari eivat ole yhdessa', '0',
         (select count(*)::text from public.goals
           where savings_goal_id is not null and target_value is not null)

  -- ================================================================
  -- VANHA DATA -- MIKAAN EI SAANUT MUUTTUA
  -- ================================================================

  union all
  select '36', 'vanha data', 'Jokainen tavoite on kelvollisessa tilassa', '0',
         (select count(*)::text from public.goals
           where status not in ('active', 'paused', 'maintenance', 'completed',
                                'abandoned', 'archived'))

  union all
  select '37', 'vanha data', 'goals-taulussa on yha nelja politiikkaa', '4',
         (select count(*)::text from pg_policies
           where schemaname = 'public' and tablename = 'goals')

  union all
  select '38', 'vanha data', 'tasks-taulussa on yha nelja politiikkaa', '4',
         (select count(*)::text from pg_policies
           where schemaname = 'public' and tablename = 'tasks')

  union all
  select '39', 'vanha data', 'projects-taulussa on yha nelja politiikkaa', '4',
         (select count(*)::text from pg_policies
           where schemaname = 'public' and tablename = 'projects')

  union all
  -- depends_on sai oletusarvon, joten yhdenkaan vanhan rivin ei pitaisi
  -- olla NULL. NULL taalla tarkoittaisi etta oletus ei mennyt lapi.
  select '40', 'vanha data', 'Yhdenkaan tehtavan depends_on ei ole NULL', '0',
         (select count(*)::text from public.tasks where depends_on is null)

  -- ================================================================
  -- KIRJATTAVAT
  -- ================================================================

  union all
  select '41', 'kirjattavat', 'Valitavoitteiden lukumaara', 'INFO',
         (select count(*)::text from public.milestones)

  union all
  select '42', 'kirjattavat', 'Tavoitteiden lukumaara', 'INFO',
         (select count(*)::text from public.goals)

  union all
  select '43', 'kirjattavat', 'Tehtavien lukumaara', 'INFO',
         (select count(*)::text from public.tasks)

  union all
  select '44', 'kirjattavat', 'Tavoitteita tilassa maintenance', 'INFO',
         (select count(*)::text from public.goals where status = 'maintenance')

  union all
  select '45', 'kirjattavat', 'Tietokanta', 'INFO', current_database()

  union all
  select '46', 'kirjattavat', 'Varmistuksen hetki (UTC)', 'INFO',
         to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS')

) c
order by c.check_no;
