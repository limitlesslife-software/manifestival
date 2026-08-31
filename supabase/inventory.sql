-- Manifestival — Supabase-inventointi (VAIN LUKU)
--
-- Aja tämä Supabase Dashboardissa: SQL Editor -> New query -> liitä -> Run.
--
-- Tämä skripti EI muuta mitään. Se vain kertoo, millainen tietokannan
-- nykytila on, jotta WP1:n migraatio voidaan viimeistellä oikeaksi.
-- Kopioi tulokset takaisin, niin migraatio sovitetaan todelliseen skeemaan.
--
-- ÄLÄ kopioi mitään avaimia tai salaisuuksia — tämä skripti ei niitä pyydä.

-- 1. Mitkä taulut sovelluksen skeemassa on?
select table_name, table_type
from information_schema.tables
where table_schema = 'public'
order by table_name;

-- 2. Sarakkeet, tyypit ja oletusarvot
select table_name, ordinal_position, column_name, data_type,
       is_nullable, column_default
from information_schema.columns
where table_schema = 'public'
order by table_name, ordinal_position;

-- 3. Avaimet ja rajoitteet (PK / FK / UNIQUE)
select tc.table_name, tc.constraint_type, tc.constraint_name,
       kcu.column_name,
       ccu.table_name  as references_table,
       ccu.column_name as references_column
from information_schema.table_constraints tc
left join information_schema.key_column_usage kcu
       on tc.constraint_name = kcu.constraint_name
      and tc.table_schema = kcu.table_schema
left join information_schema.constraint_column_usage ccu
       on tc.constraint_name = ccu.constraint_name
      and tc.table_schema = ccu.table_schema
where tc.table_schema = 'public'
order by tc.table_name, tc.constraint_type;

-- 4. RATKAISEVIN KYSYMYS: onko RLS päällä?
select schemaname, tablename, rowsecurity as rls_enabled
from pg_tables
where schemaname = 'public'
order by tablename;

-- 5. Nykyiset RLS-politiikat (jos yhtään)
select schemaname, tablename, policyname, permissive,
       roles, cmd, qual, with_check
from pg_policies
where schemaname = 'public'
order by tablename, policyname;

-- 6. Taulukohtaiset käyttöoikeudet rooleille anon / authenticated
select table_name, grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and grantee in ('anon', 'authenticated')
order by table_name, grantee, privilege_type;

-- 7. Rivimäärät (kuinka paljon oikeaa dataa on suojattavana)
select 'tasks' as table_name, count(*) as rows from public.tasks
union all
select 'profile', count(*) from public.profile;

-- 8. Onko profile-taulussa vanha kiinteä 'me'-rivi?
select id, pg_typeof(id) as id_type from public.profile;

-- 9. Triggerit ja funktiot
select event_object_table as table_name, trigger_name,
       action_timing, event_manipulation
from information_schema.triggers
where trigger_schema = 'public'
order by table_name, trigger_name;

-- 10. Storage-bucketit (sovellus ei käytä näitä, varmistetaan ettei ole avoimia)
select id, name, public from storage.buckets order by name;

-- 11. Rekisteröityneet käyttäjät (määrä ja oma tunniste)
--     TÄRKEÄ: talleta oma user id -arvo — sitä tarvitaan migraation
--     backfill-vaiheessa nykyisen datan omistajaksi.
select count(*) as user_count from auth.users;
select id as your_user_id, email, created_at
from auth.users
order by created_at
limit 10;
