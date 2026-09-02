-- =====================================================================
-- Manifestival — migraatio 0003: rutiinit ja niiden poikkeukset
-- =====================================================================
--
-- TILA: LUONNOS. TÄTÄ EI OLE AJETTU MIHINKÄÄN YMPÄRISTÖÖN.
--
-- ESIEHDOT
--   1. Migraatio 0001 on ajettu ja todennettu (user_id, RLS)
--   2. Varmuuskopio on otettu
--
-- TARKOITUS
-- Rutiini on sääntö, ei tehtävä. "Arkisin klo 07:00 aamulääkkeet" on yksi
-- rivi, ei 260 riviä vuodessa. Esiintymät lasketaan säännöstä ajossa
-- (src/domain/routine.js), joten tietokanta säilyttää vain säännön ja siitä
-- tehdyt poikkeukset.
--
-- Tämä on tarkoituksellinen valinta: jos esiintymät materialisoitaisiin
-- riveiksi, säännön muuttaminen vaatisi tuhansien rivien uudelleenkirjoitusta
-- ja menneisyyden historia sotkeutuisi tulevaisuuden suunnitelmaan.
--
-- KÄYTTÖÖNOTTO KOODISSA
-- Migraation jälkeen: src/data/schema.js -> TABLES.routines = true ja
-- TABLES.routineExceptions = true. Ennen sitä sovellus käyttää
-- muistivarastoa eikä tieto säily — käyttöliittymä kertoo sen käyttäjälle.
--
-- MIKSI TÄMÄ ON TURVALLINEN
-- Migraatio luo vain uusia tauluja. Se ei koske tasks- eikä profile-tauluun
-- eikä muuta yhtään olemassa olevaa riviä.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- VAIHE 0: esiehdon tarkistus
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'tasks' and column_name = 'user_id'
  ) then
    raise exception 'Migraatio 0001 pitaa ajaa ensin: tasks.user_id puuttuu.';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- VAIHE 1: routines — toistuva sääntö
--
-- Sarakkeiden nimet vastaavat src/data/collectionsRepo.js:n toRow/fromRow-
-- muunnoksia. Jos muutat toista, muuta toinenkin.
--
-- id on text, koska client generoi sen (crypto.randomUUID()) samoin kuin
-- tasks-taulussa. Tyyppi pidetään yhtenäisenä koko sovelluksessa.
-- ---------------------------------------------------------------------
create table if not exists public.routines (
  id                  text primary key,
  user_id             uuid not null default auth.uid()
                      references auth.users(id) on delete cascade,

  title               text not null,
  description         text,
  category            text not null default 'muu',
  priority            text not null default 'normaali',

  -- Kesto minuutteina. Rutiinilla on aina kesto — muuten sitä ei voi
  -- sijoittaa päivään eikä kuormitusta voi laskea.
  duration_minutes    integer not null default 30,

  -- Toistosääntö. weekdays on ISO-viikonpäivä (1 = maanantai, 7 = sunnuntai)
  -- ja sillä on merkitystä vain weekly- ja custom_weekdays-tyypeille.
  recurrence_type     text not null default 'daily',
  recurrence_weekdays integer[] not null default '{}',

  -- Kellonaika. null = joustava, sovellus etsii ajan.
  preferred_time      text,

  -- fixed = käyttäjän valitsema aika on sitova.
  -- flexible = aikataulumoottori saa siirtää esiintymän vapaaseen väliin.
  scheduling          text not null default 'fixed',

  -- Pois kytketty rutiini säilyy historiana mutta ei tuota esiintymiä.
  active              boolean not null default true,

  -- Vapaaehtoinen yhteys tavoitteeseen. Vierasavain lisätään vasta
  -- migraatiossa 0004, koska goals-taulu luodaan siellä. Sarake on tässä,
  -- jotta rutiinien skeema on kerralla valmis eikä muutu takautuvasti.
  goal_id             text,

  -- Voimassaoloväli. Molemmat vapaaehtoisia: ilman niitä sääntö on
  -- voimassa toistaiseksi.
  start_date          date,
  end_date            date,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

alter table public.routines
  drop constraint if exists routines_recurrence_type_check;
alter table public.routines
  add constraint routines_recurrence_type_check
  check (recurrence_type in ('daily', 'weekdays', 'weekly', 'custom_weekdays'));

alter table public.routines
  drop constraint if exists routines_scheduling_check;
alter table public.routines
  add constraint routines_scheduling_check
  check (scheduling in ('fixed', 'flexible'));

alter table public.routines
  drop constraint if exists routines_priority_check;
alter table public.routines
  add constraint routines_priority_check
  check (priority in ('korkea', 'normaali', 'matala'));

alter table public.routines
  drop constraint if exists routines_duration_check;
alter table public.routines
  add constraint routines_duration_check
  check (duration_minutes > 0 and duration_minutes <= 1440);

-- Otsikko ei saa olla tyhjä: nimetön rutiini on käyttäjälle hyödytön.
alter table public.routines
  drop constraint if exists routines_title_check;
alter table public.routines
  add constraint routines_title_check
  check (length(btrim(title)) > 0);

-- Loppupäivä ei voi olla ennen alkupäivää — sellainen sääntö ei osuisi
-- koskaan mihinkään päivään.
alter table public.routines
  drop constraint if exists routines_date_range_check;
alter table public.routines
  add constraint routines_date_range_check
  check (start_date is null or end_date is null or end_date >= start_date);

-- Viikonpäivien on oltava ISO-alueella. Tarkistus tehdään kannassa, koska
-- se on viimeinen puolustuslinja domainin validoinnin jälkeen.
--
-- Tyhjä taulukko on sallittu: daily ja weekdays eivät käytä viikonpäiviä
-- lainkaan. Sen että weekly ja custom_weekdays tarvitsevat vähintään yhden
-- päivän, valvoo validateRoutine() — se osaa myös kertoa käyttäjälle miksi.
alter table public.routines
  drop constraint if exists routines_weekdays_check;
alter table public.routines
  add constraint routines_weekdays_check
  check (recurrence_weekdays <@ array[1, 2, 3, 4, 5, 6, 7]);

create index if not exists routines_user_active_idx
  on public.routines (user_id, active);

-- ---------------------------------------------------------------------
-- VAIHE 2: routine_exceptions — yhden päivän poikkeus sääntöön
--
-- Kolme tyyppiä:
--   skip       tämä päivä jätetään väliin
--   reschedule tämä päivä siirretään toiseen aikaan
--   override   tämän päivän sisältö korvataan (otsikko, kesto)
--
-- Poikkeus on aina sidottu sekä rutiiniin että päivään. Sama päivä voi
-- esiintyä vain kerran samalla rutiinilla — muuten esiintymän tulos olisi
-- epädeterministinen.
-- ---------------------------------------------------------------------
create table if not exists public.routine_exceptions (
  id               text primary key,
  user_id          uuid not null default auth.uid()
                   references auth.users(id) on delete cascade,

  routine_id       text not null references public.routines(id) on delete cascade,
  date             date not null,
  type             text not null,

  -- Vain reschedule/override käyttää näitä.
  time             text,
  duration_minutes integer,
  title            text,
  note             text,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint routine_exceptions_unique_day unique (routine_id, date)
);

alter table public.routine_exceptions
  drop constraint if exists routine_exceptions_type_check;
alter table public.routine_exceptions
  add constraint routine_exceptions_type_check
  check (type in ('skip', 'reschedule', 'override'));

alter table public.routine_exceptions
  drop constraint if exists routine_exceptions_duration_check;
alter table public.routine_exceptions
  add constraint routine_exceptions_duration_check
  check (duration_minutes is null
         or (duration_minutes > 0 and duration_minutes <= 1440));

create index if not exists routine_exceptions_user_date_idx
  on public.routine_exceptions (user_id, date);

-- ---------------------------------------------------------------------
-- VAIHE 3: updated_at pysyy ajan tasalla
--
-- Funktio public.touch_updated_at() luodaan migraatiossa 0002. Se luodaan
-- tässä uudelleen `create or replace`-lauseella, jotta tämä migraatio
-- toimii myös jos 0002 ajetaan vasta myöhemmin.
-- ---------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists routines_touch_updated_at on public.routines;
create trigger routines_touch_updated_at
  before update on public.routines
  for each row execute function public.touch_updated_at();

drop trigger if exists routine_exceptions_touch_updated_at on public.routine_exceptions;
create trigger routine_exceptions_touch_updated_at
  before update on public.routine_exceptions
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------
-- VAIHE 4: RLS
--
-- Sama malli kuin migraatiossa 0001: käyttäjä näkee vain omat rivinsä,
-- kirjautumaton ei mitään. Yhtään anon-politiikkaa ei luoda.
-- ---------------------------------------------------------------------
alter table public.routines           enable row level security;
alter table public.routine_exceptions enable row level security;

drop policy if exists routines_select_own on public.routines;
drop policy if exists routines_insert_own on public.routines;
drop policy if exists routines_update_own on public.routines;
drop policy if exists routines_delete_own on public.routines;

create policy routines_select_own on public.routines
  for select to authenticated using (auth.uid() = user_id);
create policy routines_insert_own on public.routines
  for insert to authenticated with check (auth.uid() = user_id);
create policy routines_update_own on public.routines
  for update to authenticated using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
create policy routines_delete_own on public.routines
  for delete to authenticated using (auth.uid() = user_id);

drop policy if exists routine_exceptions_select_own on public.routine_exceptions;
drop policy if exists routine_exceptions_insert_own on public.routine_exceptions;
drop policy if exists routine_exceptions_update_own on public.routine_exceptions;
drop policy if exists routine_exceptions_delete_own on public.routine_exceptions;

create policy routine_exceptions_select_own on public.routine_exceptions
  for select to authenticated using (auth.uid() = user_id);
create policy routine_exceptions_insert_own on public.routine_exceptions
  for insert to authenticated with check (auth.uid() = user_id);
create policy routine_exceptions_update_own on public.routine_exceptions
  for update to authenticated using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
create policy routine_exceptions_delete_own on public.routine_exceptions
  for delete to authenticated using (auth.uid() = user_id);

revoke all on public.routines           from anon;
revoke all on public.routine_exceptions from anon;

grant select, insert, update, delete on public.routines           to authenticated;
grant select, insert, update, delete on public.routine_exceptions to authenticated;

commit;

-- =====================================================================
-- VARMISTUS MIGRAATION JÄLKEEN (aja erikseen, vain luku)
-- =====================================================================
-- select tablename, rowsecurity from pg_tables
--  where schemaname='public' and tablename in ('routines','routine_exceptions');
--   -> rowsecurity pitää olla true molemmilla
--
-- select tablename, policyname, cmd, roles from pg_policies
--  where schemaname='public' and tablename in ('routines','routine_exceptions')
--  order by tablename, policyname;
--   -> roles pitää olla {authenticated}, ei koskaan {anon} eikä {public}
--
-- select grantee, privilege_type from information_schema.role_table_grants
--  where table_schema='public' and table_name='routines';
--   -> anon ei saa esiintyä
--
-- =====================================================================
-- ROLLBACK
-- =====================================================================
-- Taulut ovat uusia, joten poisto ei kadota mitään vanhaa dataa. Se kadottaa
-- kaikki migraation jälkeen luodut rutiinit — ota varmuuskopio ensin.
--
--   begin;
--   drop table if exists public.routine_exceptions;
--   drop table if exists public.routines;
--   commit;
--
-- Muista tällöin palauttaa src/data/schema.js -> TABLES.routines = false ja
-- TABLES.routineExceptions = false.
