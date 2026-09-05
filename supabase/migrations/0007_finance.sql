-- =====================================================================
-- Manifestival — migraatio 0007: laskut, toistuvat kulut ja säästötavoitteet
-- =====================================================================
--
-- TILA: EI AJETTU TUOTANTOON.
--
-- ESIEHDOT
--   1. Migraatio 0001 on ajettu ja todennettu (user_id, RLS)
--   2. Varmuuskopio on otettu
--
-- TARKOITUS
-- Talouden perustaso: mitä on maksettava, mikä toistuu ja mihin säästetään.
-- EI pankkiyhteyttä, EI maksuja, EI Open Bankingia. Kaikki tieto on
-- käyttäjän itse kirjaamaa.
--
-- ---------------------------------------------------------------------
-- RAHA ON KOKONAISLUKU — TÄMÄN MIGRAATION TÄRKEIN RATKAISU
-- ---------------------------------------------------------------------
-- Summat tallennetaan SENTTEINÄ `bigint`-sarakkeina, ei `numeric`- eikä
-- `float`-tyyppinä.
--
--   129,95 EUR  ->  12995
--
-- Perustelu: liukuluku ei esitä desimaalimurtolukuja tarkasti, ja virhe
-- kertautuu summattaessa. `numeric` olisi tarkka, mutta se palautuu
-- JavaScriptiin merkkijonona tai liukulukuna ajurin mukaan — ja juuri se
-- muunnos on se kohta, jossa sentit katoavat. Kokonaisluku kulkee koko
-- matkan muuttumattomana.
--
-- Ks. src/domain/money.js.
--
-- VALUUTTA ON AINA MUKANA. Eri valuuttoja ei summata yhteen missään
-- kohtaa — ei kannassa eikä sovelluksessa.
--
-- KÄYTTÖÖNOTTO KOODISSA
-- Migraation jälkeen: src/data/schema.js -> TABLES.bills = true,
-- TABLES.recurringExpenses = true, TABLES.savingsGoals = true.
--
-- MIKSI TÄMÄ ON TURVALLINEN
-- Migraatio luo vain uusia tauluja eikä koske olemassa olevaan dataan.
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
-- VAIHE 1: recurring_expenses — toistuva kulu on SÄÄNTÖ
--
-- Kuten rutiini, ei kuten tehtävä. Yksittäiset erääntymiset lasketaan
-- säännöstä ajossa (src/domain/finance.js), niitä ei materialisoida.
--
-- day_of_month tarvitaan, koska kuukaudet ovat eripituisia: "vuokra 31.
-- päivä" ei voi osua helmikuuhun. Domain rajaa päivän kuukauden
-- viimeiseen sen sijaan että vierittäisi sen seuraavaan kuukauteen.
-- ---------------------------------------------------------------------
create table if not exists public.recurring_expenses (
  id            text primary key,
  user_id       uuid not null default auth.uid()
                references auth.users(id) on delete cascade,

  name          text not null,

  -- SENTTEINÄ. Ei numeric, ei float. Ks. tiedoston alun perustelu.
  amount_minor  bigint not null,
  currency      text not null default 'EUR',

  cadence       text not null default 'monthly',
  day_of_month  smallint,
  next_due_date date not null,

  category      text not null default 'talous',
  active        boolean not null default true,
  note          text,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

alter table public.recurring_expenses
  drop constraint if exists recurring_expenses_cadence_check;
alter table public.recurring_expenses
  add constraint recurring_expenses_cadence_check
  check (cadence in ('weekly', 'monthly', 'quarterly', 'yearly'));

alter table public.recurring_expenses
  drop constraint if exists recurring_expenses_amount_check;
alter table public.recurring_expenses
  add constraint recurring_expenses_amount_check
  check (amount_minor >= 0 and amount_minor <= 1000000000);

alter table public.recurring_expenses
  drop constraint if exists recurring_expenses_day_check;
alter table public.recurring_expenses
  add constraint recurring_expenses_day_check
  check (day_of_month is null or (day_of_month >= 1 and day_of_month <= 31));

alter table public.recurring_expenses
  drop constraint if exists recurring_expenses_currency_check;
alter table public.recurring_expenses
  add constraint recurring_expenses_currency_check
  check (currency ~ '^[A-Z]{3}$');

alter table public.recurring_expenses
  drop constraint if exists recurring_expenses_name_check;
alter table public.recurring_expenses
  add constraint recurring_expenses_name_check
  check (length(btrim(name)) > 0);

create index if not exists recurring_expenses_user_active_idx
  on public.recurring_expenses (user_id, active);

-- ---------------------------------------------------------------------
-- VAIHE 2: bills — kertaluonteinen maksu, jolla on eräpäivä
--
-- Tallennettuja tiloja on kolme: open, paid, cancelled. Kiireellisyys
-- (upcoming / due / overdue) on JOHDETTU eräpäivästä eikä sarake —
-- tallennettuna se vanhenisi heti seuraavana päivänä.
-- ---------------------------------------------------------------------
create table if not exists public.bills (
  id                    text primary key,
  user_id               uuid not null default auth.uid()
                        references auth.users(id) on delete cascade,

  name                  text not null,
  amount_minor          bigint not null,
  currency              text not null default 'EUR',

  due_date              date not null,
  status                text not null default 'open',
  paid_date             date,

  category              text not null default 'talous',

  -- Valinnainen linkki tehtävään, jos maksaminen halutaan päivän listalle.
  -- Tehtävän poisto ei saa poistaa laskua: maksu on olemassa vaikka
  -- muistutus siitä poistettaisiin.
  task_id               text references public.tasks(id) on delete set null,

  -- Mistä toistuvasta kulusta tämä syntyi, jos syntyi. Säännön poisto ei
  -- poista jo syntyneitä laskuja — ne ovat historiaa.
  recurring_expense_id  text references public.recurring_expenses(id) on delete set null,

  note                  text,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

alter table public.bills
  drop constraint if exists bills_status_check;
alter table public.bills
  add constraint bills_status_check
  check (status in ('open', 'paid', 'cancelled'));

alter table public.bills
  drop constraint if exists bills_amount_check;
alter table public.bills
  add constraint bills_amount_check
  check (amount_minor >= 0 and amount_minor <= 1000000000);

alter table public.bills
  drop constraint if exists bills_currency_check;
alter table public.bills
  add constraint bills_currency_check
  check (currency ~ '^[A-Z]{3}$');

alter table public.bills
  drop constraint if exists bills_name_check;
alter table public.bills
  add constraint bills_name_check
  check (length(btrim(name)) > 0);

-- Maksettu lasku ilman maksupäivää olisi puolivalmis kirjaus.
alter table public.bills
  drop constraint if exists bills_paid_date_check;
alter table public.bills
  add constraint bills_paid_date_check
  check (status <> 'paid' or paid_date is not null);

create index if not exists bills_user_status_due_idx
  on public.bills (user_id, status, due_date);

create index if not exists bills_user_due_idx
  on public.bills (user_id, due_date)
  where status = 'open';

-- ---------------------------------------------------------------------
-- VAIHE 3: savings_goals
--
-- EI korkoa, EI tuotto-oletusta, EI ennustetta. Tavoite on se mitä
-- käyttäjä on itse pannut sivuun — ei se mitä siitä voisi kasvaa.
-- Sijoitusneuvonta on säänneltyä toimintaa; ks. docs/INVESTMENTS-ARCHITECTURE.md.
-- ---------------------------------------------------------------------
create table if not exists public.savings_goals (
  id             text primary key,
  user_id        uuid not null default auth.uid()
                 references auth.users(id) on delete cascade,

  name           text not null,
  target_minor   bigint not null,
  current_minor  bigint not null default 0,
  currency       text not null default 'EUR',
  target_date    date,
  note           text,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

alter table public.savings_goals
  drop constraint if exists savings_goals_amount_check;
alter table public.savings_goals
  add constraint savings_goals_amount_check
  check (target_minor > 0 and target_minor <= 1000000000
     and current_minor >= 0 and current_minor <= 1000000000);

alter table public.savings_goals
  drop constraint if exists savings_goals_currency_check;
alter table public.savings_goals
  add constraint savings_goals_currency_check
  check (currency ~ '^[A-Z]{3}$');

alter table public.savings_goals
  drop constraint if exists savings_goals_name_check;
alter table public.savings_goals
  add constraint savings_goals_name_check
  check (length(btrim(name)) > 0);

create index if not exists savings_goals_user_idx
  on public.savings_goals (user_id);

-- ---------------------------------------------------------------------
-- VAIHE 4: updated_at
-- ---------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists bills_touch_updated_at on public.bills;
create trigger bills_touch_updated_at
  before update on public.bills
  for each row execute function public.touch_updated_at();

drop trigger if exists recurring_expenses_touch_updated_at on public.recurring_expenses;
create trigger recurring_expenses_touch_updated_at
  before update on public.recurring_expenses
  for each row execute function public.touch_updated_at();

drop trigger if exists savings_goals_touch_updated_at on public.savings_goals;
create trigger savings_goals_touch_updated_at
  before update on public.savings_goals
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------
-- VAIHE 5: RLS
--
-- Talousdata on rahanarvoista tietoa. Sama malli kuin muualla, ei
-- poikkeuksia: omistajuuden asettaa tietokanta, anon ei saa mitään.
-- ---------------------------------------------------------------------
alter table public.bills              enable row level security;
alter table public.recurring_expenses enable row level security;
alter table public.savings_goals      enable row level security;

drop policy if exists bills_select_own on public.bills;
drop policy if exists bills_insert_own on public.bills;
drop policy if exists bills_update_own on public.bills;
drop policy if exists bills_delete_own on public.bills;

create policy bills_select_own on public.bills
  for select to authenticated using (auth.uid() = user_id);
create policy bills_insert_own on public.bills
  for insert to authenticated with check (auth.uid() = user_id);
create policy bills_update_own on public.bills
  for update to authenticated using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
create policy bills_delete_own on public.bills
  for delete to authenticated using (auth.uid() = user_id);

drop policy if exists recurring_expenses_select_own on public.recurring_expenses;
drop policy if exists recurring_expenses_insert_own on public.recurring_expenses;
drop policy if exists recurring_expenses_update_own on public.recurring_expenses;
drop policy if exists recurring_expenses_delete_own on public.recurring_expenses;

create policy recurring_expenses_select_own on public.recurring_expenses
  for select to authenticated using (auth.uid() = user_id);
create policy recurring_expenses_insert_own on public.recurring_expenses
  for insert to authenticated with check (auth.uid() = user_id);
create policy recurring_expenses_update_own on public.recurring_expenses
  for update to authenticated using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
create policy recurring_expenses_delete_own on public.recurring_expenses
  for delete to authenticated using (auth.uid() = user_id);

drop policy if exists savings_goals_select_own on public.savings_goals;
drop policy if exists savings_goals_insert_own on public.savings_goals;
drop policy if exists savings_goals_update_own on public.savings_goals;
drop policy if exists savings_goals_delete_own on public.savings_goals;

create policy savings_goals_select_own on public.savings_goals
  for select to authenticated using (auth.uid() = user_id);
create policy savings_goals_insert_own on public.savings_goals
  for insert to authenticated with check (auth.uid() = user_id);
create policy savings_goals_update_own on public.savings_goals
  for update to authenticated using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
create policy savings_goals_delete_own on public.savings_goals
  for delete to authenticated using (auth.uid() = user_id);

revoke all on public.bills              from anon;
revoke all on public.recurring_expenses from anon;
revoke all on public.savings_goals      from anon;

grant select, insert, update, delete on public.bills              to authenticated;
grant select, insert, update, delete on public.recurring_expenses to authenticated;
grant select, insert, update, delete on public.savings_goals      to authenticated;

commit;

-- =====================================================================
-- VARMISTUS MIGRAATION JÄLKEEN (aja erikseen, vain luku)
-- =====================================================================
-- select tablename, rowsecurity from pg_tables
--  where schemaname='public'
--    and tablename in ('bills','recurring_expenses','savings_goals');
--   -> kaikilla true
--
-- select column_name, data_type from information_schema.columns
--  where table_schema='public' and table_name='bills'
--    and column_name like '%minor%';
--   -> data_type pitää olla bigint, EI numeric eikä double precision
--
-- select grantee, privilege_type from information_schema.role_table_grants
--  where table_schema='public' and table_name='bills';
--   -> anon ei saa esiintyä
--
-- =====================================================================
-- ROLLBACK
-- =====================================================================
-- Poisto kadottaa kaikki laskut, kulut ja säästötavoitteet. Ota
-- varmuuskopio ensin.
--
--   begin;
--   drop table if exists public.bills;            -- viittaa kuluihin
--   drop table if exists public.savings_goals;
--   drop table if exists public.recurring_expenses;
--   commit;
--
-- Muista tällöin palauttaa src/data/schema.js -> TABLES.bills = false,
-- TABLES.recurringExpenses = false, TABLES.savingsGoals = false.
