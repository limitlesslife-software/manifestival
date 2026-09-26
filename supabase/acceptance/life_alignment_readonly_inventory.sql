-- =====================================================================
-- Manifestival — Life Alignment -inventaario (VAIN LUKU)
-- =====================================================================
--
-- Tarkoitus: todentaa tuotannon TODELLINEN skeema ja datan muoto ennen
-- kuin migraatio 0012 (elämänalueet, viikkokapasiteetti, toteuma,
-- viikkokatsaukset) hyväksytään ajettavaksi.
--
-- Aja Supabase Dashboardissa: SQL Editor -> New query -> liitä -> Run.
-- Jokainen lause on SELECT tai lukeva WITH. Mitään ei luoda, muuteta
-- eikä poisteta. Testi (tests/migrations.test.mjs) vartioi tämän.
--
-- EI KÄYTTÄJÄN SISÄLTÖÄ: vain rakenne, rivimäärät ja NULL-osuudet.
-- Otsikoita, muistiinpanoja, summia tai sähköposteja ei lueta.
--
-- Kopioi tulokset takaisin kehitykseen; docs/LIFE-ALIGNMENT-SUPABASE-INVENTORY.md
-- kertoo mitä kustakin tuloksesta päätellään.
--
-- ⚠ AJA ENSISIJAISESTI supabase/acceptance/activation_readonly_inventory.sql.
-- Tämä tiedosto on 16 erillistä lausetta, ja Supabasen SQL-editori
-- näyttää vain VIIMEISEN tuloksen. activation_readonly_inventory.sql on
-- yksi lause, yksi taulukko ja rivillä 00 koko tulos yhtenä soluna,
-- jonka tools/activation/score-inventory.mjs pisteyttää. Tätä tiedostoa
-- voi yhä käyttää lause kerrallaan (maalaa lause ja Run).

-- 1. Sovelluksen taulut ja RLS-tila.
select c.relname as taulu,
       c.relrowsecurity as rls_paalla,
       c.relforcerowsecurity as rls_pakotettu
  from pg_class c
 where c.relnamespace = 'public'::regnamespace
   and c.relkind = 'r'
 order by c.relname;

-- 2. Sarakkeet niissä tauluissa, joihin Life Alignment nojaa.
select table_name, ordinal_position, column_name, data_type, is_nullable,
       column_default
  from information_schema.columns
 where table_schema = 'public'
   and table_name in ('tasks', 'goals', 'projects', 'routines', 'routine_exceptions',
                      'wellbeing_entries', 'milestones', 'profile',
                      'life_areas', 'weekly_capacities', 'time_entries', 'alignment_reviews')
 order by table_name, ordinal_position;

-- 3. Vierasavaimet: mistä mihin, ja poistosääntö (c = cascade, n = set null).
select con.conname as rajoite,
       con.conrelid::regclass as taulusta,
       con.confrelid::regclass as tauluun,
       con.confdeltype as poistosaanto,
       array_length(con.confdelsetcols, 1) as nollattavia_sarakkeita
  from pg_constraint con
 where con.contype = 'f'
   and con.connamespace = 'public'::regnamespace
 order by 2, 1;

-- 4. Omistajan rivin avaimet (yhdistelmävierasavaimen kohteet).
select conname as rajoite, conrelid::regclass as taulu
  from pg_constraint
 where contype = 'u'
   and connamespace = 'public'::regnamespace
   and conname like '%owner_row_key'
 order by 2;

-- 5. Politiikat: rooli ja komento. Odotus: jokaisella taululla neljä,
--    kaikki roolille authenticated, ei yhtään anon/public.
select tablename as taulu, policyname as politiikka, roles as roolit, cmd as komento
  from pg_policies
 where schemaname = 'public'
 order by tablename, policyname;

-- 6. Teholliset oikeudet anon-roolille. Odotus: NOLLA RIVIÄ.
select table_name, privilege_type
  from information_schema.role_table_grants
 where table_schema = 'public'
   and grantee = 'anon'
 order by table_name, privilege_type;

-- 7. Mitkä migraatiot on ajettu? Tunnistetaan niiden objekteista.
select '0009' as migraatio, to_regclass('public.transactions') is not null as ajettu
union all
select '0010', to_regclass('public.milestones') is not null
union all
select '0011', to_regclass('public.inbox_items') is not null
union all
select '0012', to_regclass('public.life_areas') is not null;

-- 8. Datan määrä (vain lukumäärät). Kertoo onko kanta tyhjä vai elävä.
select 'tasks' as taulu, count(*) as riveja from public.tasks
union all select 'goals', count(*) from public.goals
union all select 'projects', count(*) from public.projects
union all select 'routines', count(*) from public.routines
union all select 'routine_exceptions', count(*) from public.routine_exceptions
union all select 'wellbeing_entries', count(*) from public.wellbeing_entries;

-- 9. Tehtävien arvioidun keston kattavuus. Life Alignment EI keksi
--    kestoa: kesto on tunnettu vain jos duration_minutes on asetettu.
--    Tämä kertoo kuinka suuri osa suunnitellusta työstä on arvioitu.
select count(*) as tehtavia,
       count(*) filter (where duration_minutes is not null) as kesto_tiedossa,
       count(*) filter (where duration_minutes is null) as kesto_puuttuu,
       count(*) filter (where date is not null) as paivatty,
       count(*) filter (where goal_id is not null) as tavoitteeseen_liitetty,
       count(*) filter (where project_id is not null) as projektiin_liitetty
  from public.tasks;

-- 10. Tehtävien jakauma kategorioittain (kategoria on kiinteä avain,
--     ei käyttäjän tekstiä). Elämänalue voi periä kategorian.
select category as kategoria, count(*) as tehtavia
  from public.tasks
 group by category
 order by count(*) desc;

-- 11. Tavoitteiden tila ja liitokset.
select status as tila, count(*) as tavoitteita,
       count(*) filter (where parent_goal_id is not null) as alatavoitteita,
       count(*) filter (where project_id is not null) as projektiin_liitetty
  from public.goals
 group by status
 order by status;

-- 12. Rutiinien kesto ja tavoiteliitokset.
select active as aktiivinen, count(*) as rutiineja,
       count(*) filter (where goal_id is not null) as tavoitteeseen_liitetty,
       min(duration_minutes) as lyhin_kesto,
       max(duration_minutes) as pisin_kesto
  from public.routines
 group by active
 order by active;

-- 13. Projektien tavoiteliitokset.
select status as tila, count(*) as projekteja,
       count(*) filter (where goal_id is not null) as tavoitteeseen_liitetty
  from public.projects
 group by status
 order by status;

-- 14. Tehtävien viikkojakauma viimeiseltä 8 viikolta (vain lukumäärät).
--     Kertoo kuinka paljon suunniteltua työtä tyypillisellä viikolla on.
--     tasks.date voi olla tuotannossa tekstiä TAI päivämäärä (docs/SCHEMA.md:
--     "date / text"). date_trunc(text) kaatuisi, joten arvo muunnetaan
--     päivämääräksi vain kun se on muotoa VVVV-KK-PP (todettu oikealla
--     PostgreSQL:llä, tools/pg-rehearsal).
select date_trunc('week', left(date::text, 10)::date)::date as viikko_alkaa,
       count(*) as tehtavia,
       coalesce(sum(duration_minutes), 0) as arvioidut_minuutit,
       count(*) filter (where duration_minutes is null) as arvioimattomia
  from public.tasks
 where date::text ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
   and left(date::text, 10)::date >= (current_date - 56)
 group by 1
 order by 1;

-- 15. Onko goals-taulussa jo life_area_id? Odotus ennen 0012:ta: 0.
select count(*) as life_area_sarake
  from information_schema.columns
 where table_schema = 'public'
   and table_name = 'goals'
   and column_name = 'life_area_id';

-- 16. PostgreSQL-versio (0012 käyttää sarakekohtaista ON DELETE SET NULL,
--     joka vaatii version 15).
select current_setting('server_version_num')::int >= 150000 as pg15_tai_uudempi,
       current_setting('server_version') as versio;
