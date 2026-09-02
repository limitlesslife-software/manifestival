-- Varmistus: 0001_auth_user_scoping
-- VAIN LUKEVA. Aja migraation jalkeen, runbookin PYSAYTYS 3.

-- 1. RLS paalla molemmissa. Odotus: kaksi rivia, molemmat true.
select relname as taulu, relrowsecurity as rls_paalla
from pg_class
where relnamespace = 'public'::regnamespace
  and relname in ('tasks', 'profile')
order by relname;

-- 2. Politiikat. Odotus: 8 rivia, 4 per taulu.
select tablename as taulu, policyname as politiikka, cmd as operaatio
from pg_policies
where schemaname = 'public' and tablename in ('tasks', 'profile')
order by tablename, cmd;

-- 3. Omistajuussarake ja sen oletus. Odotus: user_id, uuid, ei null,
--    oletuksena auth.uid().
select table_name as taulu, column_name as sarake, data_type as tyyppi,
       is_nullable as sallii_nullin, column_default as oletus
from information_schema.columns
where table_schema = 'public' and table_name in ('tasks', 'profile')
  and column_name = 'user_id';

-- 4. Orvot rivit. Odotus: 0 molemmissa.
select 'tasks' as taulu, count(*) as ilman_omistajaa from public.tasks where user_id is null
union all
select 'profile', count(*) from public.profile where user_id is null;

-- 5. Rivimaara. Verrataan inventaarioon (runbook vaihe 2).
--    Odotus: TASMALLEEN sama luku. Migraatio ei saa havittaa yhtaan rivia.
select 'tasks' as taulu, count(*) as rivit from public.tasks
union all
select 'profile', count(*) from public.profile;

-- 6. Anon-oikeudet. Odotus: NOLLA RIVIA.
--    Jos tassa on rivi, RLS ei suojaa mitaan.
select table_name as taulu, privilege_type as oikeus
from information_schema.role_table_grants
where table_schema = 'public' and grantee = 'anon'
  and table_name in ('tasks', 'profile');
