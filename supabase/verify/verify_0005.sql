-- Varmistus: 0005_notification_preferences
-- VAIN LUKEVA. Runbookin PYSAYTYS 12.

-- 1. Taulu ja RLS. Odotus: yksi rivi, true.
select relname as taulu, relrowsecurity as rls_paalla
from pg_class
where relnamespace = 'public'::regnamespace
  and relname = 'notification_preferences';

-- 2. Politiikat. Odotus: 4 rivia, ehto auth.uid() = id.
select policyname as politiikka, cmd as operaatio,
       qual as lukuehto, with_check as kirjoitusehto
from pg_policies
where schemaname = 'public' and tablename = 'notification_preferences'
order by cmd;

-- 3. TARKEIN TARKISTUS: enabled-sarakkeen oletus.
--    Odotus: false. Jos tassa lukee true, migraation ajaminen on
--    kytkenyt muistutukset paalle jokaiselle ilman lupaa.
select column_name as sarake, data_type as tyyppi, column_default as oletus
from information_schema.columns
where table_schema = 'public' and table_name = 'notification_preferences'
order by ordinal_position;

-- 4. Omistajuus id-sarakkeessa, ei erillisessa user_id:ssa.
--    Odotus: id on paaavain ja viittaa auth.users-tauluun.
select conname as rajoite, pg_get_constraintdef(oid) as maaritelma
from pg_constraint
where conrelid = 'public.notification_preferences'::regclass
  and contype in ('p', 'f')
order by contype;

-- 5. Tarkisteet. Odotus: kolme rivia.
select conname as rajoite, pg_get_constraintdef(oid) as maaritelma
from pg_constraint
where conrelid = 'public.notification_preferences'::regclass and contype = 'c'
order by conname;

-- 6. Anon-oikeudet. Odotus: NOLLA RIVIA.
select privilege_type as oikeus
from information_schema.role_table_grants
where table_schema = 'public' and grantee = 'anon'
  and table_name = 'notification_preferences';
