-- Varmistus: 0006_wellbeing
-- VAIN LUKEVA. Runbookin PYSAYTYS 14.
--
-- HUOM: tama on terveystietoa. Yksikaan kysely alla ei lue merkintojen
-- SISALTOA - vain rakenteen ja rivimaarat.

-- 1. Taulu ja RLS. Odotus: yksi rivi, true.
select relname as taulu, relrowsecurity as rls_paalla
from pg_class
where relnamespace = 'public'::regnamespace and relname = 'wellbeing_entries';

-- 2. Politiikat. Odotus: 4 rivia, kaikissa auth.uid() = user_id.
select policyname as politiikka, cmd as operaatio,
       qual as lukuehto, with_check as kirjoitusehto
from pg_policies
where schemaname = 'public' and tablename = 'wellbeing_entries'
order by cmd;

-- 3. Uniikki paivarajoite. Odotus: yksi rivi.
select indexname as indeksi from pg_indexes
where schemaname = 'public' and indexname = 'wellbeing_entries_unique_day';

-- 4. Asteikkorajoitteet. Odotus: kaksi rivia (1-5 seka sleep_hours > 0).
select conname as rajoite, pg_get_constraintdef(oid) as maaritelma
from pg_constraint
where conrelid = 'public.wellbeing_entries'::regclass and contype = 'c'
order by conname;

-- 5. Anon-oikeudet. Odotus: NOLLA RIVIA.
--    Talla taululla tama on tarkein yksittainen rivi koko tiedostossa.
select privilege_type as oikeus
from information_schema.role_table_grants
where table_schema = 'public' and grantee = 'anon'
  and table_name = 'wellbeing_entries';
