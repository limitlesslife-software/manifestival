-- Varmistus: 0004_goals_projects
-- VAIN LUKEVA. Runbookin PYSAYTYS 10.

-- 1. Taulut ja RLS. Odotus: kaksi rivia, molemmat true.
select relname as taulu, relrowsecurity as rls_paalla
from pg_class
where relnamespace = 'public'::regnamespace
  and relname in ('goals', 'projects')
order by relname;

-- 2. Politiikat. Odotus: 8 rivia.
select tablename as taulu, policyname as politiikka, cmd as operaatio
from pg_policies
where schemaname = 'public' and tablename in ('goals', 'projects')
order by tablename, cmd;

-- 3. TARKEIN TARKISTUS: jokaisen vierasavaimen on oltava SET NULL.
--    Jos yhdessakin lukee CASCADE, tavoitteen poisto veisi tehtavat
--    mukanaan. ALA KAANNA LIPPUJA ennen kuin tama on kunnossa.
select conrelid::regclass as taulu, conname as rajoite,
       pg_get_constraintdef(oid) as maaritelma
from pg_constraint
where contype = 'f'
  and conname in ('tasks_goal_id_fkey', 'tasks_project_id_fkey',
                  'goals_project_id_fkey', 'routines_goal_id_fkey')
order by conname;

-- 4. Uudet tasks-sarakkeet. Odotus: kolme rivia.
select column_name as sarake, data_type as tyyppi
from information_schema.columns
where table_schema = 'public' and table_name = 'tasks'
  and column_name in ('deadline', 'goal_id', 'project_id')
order by column_name;

-- 5. Tilojen ja edistymistapojen tarkisteet vastaavat domainia.
--    goals_status_check sisaltaa abandoned.
--    goals_progress_mode_check sisaltaa project_based ja routine_based.
--    projects_status_check sisaltaa planned.
select conname as rajoite, pg_get_constraintdef(oid) as maaritelma
from pg_constraint
where conname in ('goals_status_check', 'goals_progress_mode_check',
                  'projects_status_check', 'goals_parent_not_self_check',
                  'projects_date_range_check')
order by conname;

-- 6. Anon-oikeudet. Odotus: NOLLA RIVIA.
select table_name as taulu, privilege_type as oikeus
from information_schema.role_table_grants
where table_schema = 'public' and grantee = 'anon'
  and table_name in ('goals', 'projects');
