-- =====================================================================
-- Manifestival — migraatio 0001: käyttäjäkohtainen omistajuus ja RLS
-- =====================================================================
--
-- TILA: LUONNOS. TÄTÄ EI OLE AJETTU MIHINKÄÄN YMPÄRISTÖÖN.
--
-- Tätä ei saa ajaa ennen kuin:
--   1. supabase/inventory.sql on ajettu ja skeema on todennettu
--   2. tämän tiedoston oletukset on vahvistettu todellista skeemaa vasten
--   3. tietokannasta on otettu varmuuskopio
--   4. OWNER_USER_ID alla on korvattu oikealla arvolla
--
-- Miksi: nykyisessä sovelluksessa ei ole autentikaatiota. Data on jaettu
-- yhteen kiinteään profiiliin ('me') eikä millään rivillä ole omistajaa.
-- Julkisessa repossa oleva anon-avain yhdistettynä puuttuvaan omistajuuteen
-- tarkoittaa, että tietoturva lepää täysin RLS:n varassa. Tämä migraatio
-- luo oikean omistajuusmallin: auth.uid() -> user_id -> RLS.
--
-- Tämä migraatio EI luo väliaikaista anon-roolin kiertotietä. Kirjautumaton
-- käyttäjä ei migraation jälkeen näe eikä muuta mitään.
--
-- ---------------------------------------------------------------------
-- OLETUKSET, JOTKA INVENTOINNIN PITÄÄ VAHVISTAA
-- ---------------------------------------------------------------------
--   A. Taulut public.tasks ja public.profile ovat olemassa.
--   B. tasks.id on tekstityyppinen (client generoi sen: 'm1753...').
--   C. profile.id on tekstityyppinen ja sisältää yhden rivin arvolla 'me'.
--   D. Kummassakaan taulussa ei ole vielä user_id-saraketta.
--   E. Kaikki nykyinen data kuuluu yhdelle henkilölle.
-- Jos jokin oletus ei pidä, PYSÄHDY ja korjaa migraatio ensin.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- VAIHE 0: aseta nykyisen datan omistaja
--
-- Korvaa alla oleva paikanpitäjä omalla user id -arvollasi. Saat sen
-- inventory.sql-skriptin kohdasta 11, tai luomalla tilin sovelluksen
-- kirjautumisnäkymästä ja hakemalla sen jälkeen:
--   select id, email from auth.users;
--
-- Jos jätät paikanpitäjän paikalleen, migraatio keskeytyy virheeseen
-- eikä muuta mitään. Se on tarkoituksellista.
-- ---------------------------------------------------------------------
create temporary table _migration_params as
select '00000000-0000-0000-0000-000000000000'::uuid as owner_user_id;
-- ^^^ KORVAA TÄMÄ ARVO ^^^

do $$
declare
  v_owner uuid;
begin
  select owner_user_id into v_owner from _migration_params;
  if v_owner = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception 'OWNER_USER_ID on yhä paikanpitäjä. Aseta oikea arvo ennen ajoa.';
  end if;
  if not exists (select 1 from auth.users where id = v_owner) then
    raise exception 'OWNER_USER_ID % ei vastaa yhtään auth.users-riviä.', v_owner;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- VAIHE 1: tasks — omistajuussarake
-- ---------------------------------------------------------------------

-- 1a. Lisätään sarake nullable-tilassa, jotta olemassa oleva data säilyy.
alter table public.tasks
  add column if not exists user_id uuid references auth.users(id) on delete cascade;

-- 1b. Backfill: kaikki nykyiset rivit annetaan tunnetulle omistajalle.
update public.tasks
   set user_id = (select owner_user_id from _migration_params)
 where user_id is null;

-- 1c. Oletusarvo: tästä eteenpäin omistajan asettaa TIETOKANTA, ei selain.
--     Tämä on olennainen osa turvamallia — client ei voi valita user_id:tä.
alter table public.tasks
  alter column user_id set default auth.uid();

-- 1d. Pakollinen. Ilman omistajaa ei voi olla rivejä.
alter table public.tasks
  alter column user_id set not null;

-- 1e. Indeksi, koska jokainen kysely suodattaa tällä.
create index if not exists tasks_user_id_date_idx
  on public.tasks (user_id, date);

-- ---------------------------------------------------------------------
-- VAIHE 2: profile — id:stä tulee auth.users-viite
--
-- profile käyttää id = auth.uid() -mallia: yksi rivi per käyttäjä, ei
-- erillistä user_id-saraketta. Siksi politiikat kohdistuvat id-sarakkeeseen.
-- ---------------------------------------------------------------------

-- 2a. Vanha kiinteä 'me'-rivi osoittamaan oikeaa käyttäjää.
update public.profile
   set id = (select owner_user_id::text from _migration_params)
 where id = 'me';

-- 2b. Rivit, jotka eivät ole kelvollisia uuid-arvoja, estäisivät tyyppimuunnoksen.
do $$
declare
  v_bad int;
begin
  select count(*) into v_bad
    from public.profile
   where id !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  if v_bad > 0 then
    raise exception 'profile-taulussa on % riviä, joiden id ei ole uuid. Selvitä ne ennen jatkoa.', v_bad;
  end if;
end $$;

-- 2c. Tyyppimuunnos text -> uuid.
alter table public.profile
  alter column id type uuid using id::uuid;

-- 2d. Viite auth.users-tauluun. Käyttäjän poisto poistaa profiilin.
alter table public.profile
  drop constraint if exists profile_id_fkey;
alter table public.profile
  add constraint profile_id_fkey
  foreign key (id) references auth.users(id) on delete cascade;

-- 2e. Oletusarvo: uusi profiilirivi kuuluu aina kutsujalle.
alter table public.profile
  alter column id set default auth.uid();

-- ---------------------------------------------------------------------
-- VAIHE 3: RLS päälle ja lopulliset politiikat
--
-- Periaate: käyttäjä näkee ja muuttaa VAIN omia rivejään.
-- Kirjautumaton (anon) ei saa mitään — sille ei luoda yhtään politiikkaa.
-- ---------------------------------------------------------------------

alter table public.tasks   enable row level security;
alter table public.profile enable row level security;

-- Poistetaan mahdolliset aiemmat politiikat, jotta lopputila on yksiselitteinen.
drop policy if exists tasks_select_own   on public.tasks;
drop policy if exists tasks_insert_own   on public.tasks;
drop policy if exists tasks_update_own   on public.tasks;
drop policy if exists tasks_delete_own   on public.tasks;
drop policy if exists profile_select_own on public.profile;
drop policy if exists profile_insert_own on public.profile;
drop policy if exists profile_update_own on public.profile;
drop policy if exists profile_delete_own on public.profile;

-- tasks: omistajuus user_id-sarakkeessa
create policy tasks_select_own on public.tasks
  for select to authenticated
  using (auth.uid() = user_id);

create policy tasks_insert_own on public.tasks
  for insert to authenticated
  with check (auth.uid() = user_id);

create policy tasks_update_own on public.tasks
  for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy tasks_delete_own on public.tasks
  for delete to authenticated
  using (auth.uid() = user_id);

-- profile: omistajuus id-sarakkeessa
create policy profile_select_own on public.profile
  for select to authenticated
  using (auth.uid() = id);

create policy profile_insert_own on public.profile
  for insert to authenticated
  with check (auth.uid() = id);

create policy profile_update_own on public.profile
  for update to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);

create policy profile_delete_own on public.profile
  for delete to authenticated
  using (auth.uid() = id);

-- ---------------------------------------------------------------------
-- VAIHE 4: anon-roolin oikeudet pois
--
-- Kirjautumaton käyttäjä ei tarvitse pääsyä henkilökohtaiseen dataan.
-- RLS jo estää sen, mutta oikeuksien poisto on toinen puolustuslinja.
-- ---------------------------------------------------------------------
revoke all on public.tasks   from anon;
revoke all on public.profile from anon;

grant select, insert, update, delete on public.tasks   to authenticated;
grant select, insert, update, delete on public.profile to authenticated;

commit;

-- =====================================================================
-- VARMISTUS MIGRAATION JÄLKEEN (aja erikseen, vain luku)
-- =====================================================================
-- select tablename, rowsecurity from pg_tables
--  where schemaname='public' and tablename in ('tasks','profile');
--
-- select tablename, policyname, cmd, roles, qual, with_check
--   from pg_policies where schemaname='public' order by tablename, policyname;
--
-- select count(*) as tasks_without_owner from public.tasks where user_id is null;
--   -> pitää olla 0
--
-- =====================================================================
-- ROLLBACK
-- =====================================================================
-- Migraatio ajetaan yhdessä transaktiossa: jos jokin vaihe epäonnistuu,
-- mitään ei jää puolitiehen. Jos migraatio menee läpi mutta se halutaan
-- perua, palauta varmuuskopiosta — profile.id:n tyyppimuunnosta text->uuid
-- ei voi perua häviöttömästi ilman alkuperäistä 'me'-arvoa.
-- OTA VARMUUSKOPIO ENNEN AJOA.
