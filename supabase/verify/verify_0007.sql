-- Varmistus: 0007_finance
-- VAIN LUKEVA. Runbookin PYSAYTYS 15.

-- 1. Kolme taulua ja RLS. Odotus: kolme rivia, kaikki true.
select relname as taulu, relrowsecurity as rls_paalla
from pg_class
where relnamespace = 'public'::regnamespace
  and relname in ('bills', 'recurring_expenses', 'savings_goals')
order by relname;

-- 2. Politiikat. Odotus: 12 rivia.
select tablename as taulu, policyname as politiikka, cmd as operaatio
from pg_policies
where schemaname = 'public'
  and tablename in ('bills', 'recurring_expenses', 'savings_goals')
order by tablename, cmd;

-- 3. TARKEIN TARKISTUS: rahasarakkeiden tyyppi.
--    Odotus: KAIKKI bigint.
--    Jos jokin on numeric tai double precision: ALA KAANNA LIPPUJA.
--    Ajurin muunnos on juuri se kohta, jossa sentit katoavat.
select table_name as taulu, column_name as sarake, data_type as tyyppi
from information_schema.columns
where table_schema = 'public'
  and table_name in ('bills', 'recurring_expenses', 'savings_goals')
  and column_name in ('amount_minor', 'target_minor', 'current_minor')
order by table_name, column_name;

-- 4. Vierasavaimet. Odotus: bills.task_id ja bills.recurring_expense_id,
--    molemmat SET NULL. Laskun poisto ei saa poistaa tehtavaa.
select conname as rajoite, pg_get_constraintdef(oid) as maaritelma
from pg_constraint
where conrelid = 'public.bills'::regclass and contype = 'f'
order by conname;

-- 5. Tarkisteet. Odotus: valuuttamuoto kaikissa kolmessa, summat
--    ei-negatiivisia, bills_paid_date_check olemassa.
select conrelid::regclass as taulu, conname as rajoite,
       pg_get_constraintdef(oid) as maaritelma
from pg_constraint
where conrelid in ('public.bills'::regclass,
                   'public.recurring_expenses'::regclass,
                   'public.savings_goals'::regclass)
  and contype = 'c'
order by conrelid, conname;

-- 6. Anon-oikeudet. Odotus: NOLLA RIVIA.
select table_name as taulu, privilege_type as oikeus
from information_schema.role_table_grants
where table_schema = 'public' and grantee = 'anon'
  and table_name in ('bills', 'recurring_expenses', 'savings_goals');
