-- Varmistus: 0003_routines
-- VAIN LUKEVA. Runbookin PYSAYTYS 8.

-- 1. Taulut olemassa ja RLS paalla. Odotus: kaksi rivia, molemmat true.
select relname as taulu, relrowsecurity as rls_paalla
from pg_class
where relnamespace = 'public'::regnamespace
  and relname in ('routines', 'routine_exceptions')
order by relname;

-- 2. Politiikat. Odotus: 8 rivia.
select tablename as taulu, policyname as politiikka, cmd as operaatio
from pg_policies
where schemaname = 'public' and tablename in ('routines', 'routine_exceptions')
order by tablename, cmd;

-- 3. Poikkeuksen viite sailioon. Odotus: routine_id -> routines, CASCADE.
--    Tassa cascade on OIKEIN: poikkeus ilman saantoa on merkityksetön.
select conname as rajoite, pg_get_constraintdef(oid) as maaritelma
from pg_constraint
where conrelid = 'public.routine_exceptions'::regclass and contype = 'f';

-- 4. Uniikki paivarajoite. Odotus: yksi rivi.
select indexname as indeksi from pg_indexes
where schemaname = 'public' and indexname = 'routine_exceptions_unique_day';

-- 5. Domainin tarkisteet. Odotus: seitseman rivia.
select conname as rajoite, pg_get_constraintdef(oid) as maaritelma
from pg_constraint
where conrelid in ('public.routines'::regclass,
                   'public.routine_exceptions'::regclass)
  and contype = 'c'
order by conname;

-- 6. Anon-oikeudet. Odotus: NOLLA RIVIA.
select table_name as taulu, privilege_type as oikeus
from information_schema.role_table_grants
where table_schema = 'public' and grantee = 'anon'
  and table_name in ('routines', 'routine_exceptions');
