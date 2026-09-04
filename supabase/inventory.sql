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

-- 12. Onko odotettu omistaja olemassa? Odotus: 1.
--     Migraatio 0001 tarkistaa tämän itsekin, mutta on parempi tietää
--     ennen kuin sovellus menee katkolle.
select count(*) as omistaja_loytyi
from auth.users
where id = '2cc00622-f927-4604-a518-361a4328481b'::uuid;

-- 13. Onko avoimia transaktioita? Odotus: NOLLA RIVIÄ.
--     Avoin transaktio estää migraation ACCESS EXCLUSIVE -lukon. Koska
--     jonossa odottava lukko estää jo itsessään kaikki uudet lukijat,
--     hidas ajo veisi sovelluksen alas odottaessaan. Yleisin syy on
--     SQL-editorin toinen välilehti, jossa on ajettu begin; ilman
--     commit;- tai rollback;-lausetta.
select pid, state, state_change, left(query, 60) as kysely
from pg_stat_activity
where datname = current_database()
  and state in ('idle in transaction', 'idle in transaction (aborted)')
order by state_change;

-- 14. Viittaako mikään taulu public.profile-tauluun? Odotus: NOLLA RIVIÄ.
--     Viite estäisi pääavaimen vaihdon migraatiossa 0001.
select tc.constraint_name, tc.table_name
from information_schema.table_constraints tc
join information_schema.constraint_column_usage ccu
  on tc.constraint_name = ccu.constraint_name
 and tc.table_schema = ccu.table_schema
where tc.constraint_type = 'FOREIGN KEY'
  and ccu.table_schema = 'public'
  and ccu.table_name = 'profile';
