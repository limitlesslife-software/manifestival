-- Varmistus: 0008_ai_audit
-- VAIN LUKEVA. Runbookin PYSAYTYS 17.

-- 1. Taulu ja RLS. Odotus: yksi rivi, true.
select relname as taulu, relrowsecurity as rls_paalla
from pg_class
where relnamespace = 'public'::regnamespace and relname = 'ai_action_audit';

-- 2. Politiikat. Odotus: 4 rivia.
select policyname as politiikka, cmd as operaatio,
       qual as lukuehto, with_check as kirjoitusehto
from pg_policies
where schemaname = 'public' and tablename = 'ai_action_audit'
order by cmd;

-- 3. TARKEIN TARKISTUS: suoritettu edellyttaa vahvistettua.
--    Odotus: ai_action_audit_confirmed_check, maaritelmassa
--    executed = false or confirmed = true.
--    Tama on tietokantatason takuu siita, ettei vahvistamatonta
--    suoritusta voi edes kirjata - vaikka sovelluslogiikka vuotaisi.
select conname as rajoite, pg_get_constraintdef(oid) as maaritelma
from pg_constraint
where conrelid = 'public.ai_action_audit'::regclass and contype = 'c'
order by conname;

-- 4. target_id EI SAA olla vierasavain.
--    Odotus: vain user_id-viite. Kohde on voitu poistaa, ja kirjaus
--    juuri poistosta on se, mita halutaan sailyttaa.
select conname as rajoite, pg_get_constraintdef(oid) as maaritelma
from pg_constraint
where conrelid = 'public.ai_action_audit'::regclass and contype = 'f';

-- 5. Anon-oikeudet. Odotus: NOLLA RIVIA.
select privilege_type as oikeus
from information_schema.role_table_grants
where table_schema = 'public' and grantee = 'anon'
  and table_name = 'ai_action_audit';
