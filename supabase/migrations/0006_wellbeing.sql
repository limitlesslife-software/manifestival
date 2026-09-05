-- =====================================================================
-- Manifestival — migraatio 0006: hyvinvointimerkinnät
-- =====================================================================
--
-- TILA: EI AJETTU TUOTANTOON.
--
-- ESIEHDOT
--   1. Migraatio 0001 on ajettu ja todennettu (user_id, RLS)
--   2. Varmuuskopio on otettu
--
-- TARKOITUS
-- Yksi merkintä per päivä: energia, mieliala, kuormitus, unen määrä ja
-- vapaa muistiinpano. Asteikko on karkea (1–5), koska tavoite on nopea
-- merkintä eikä mittaus. Tarkempi asteikko tuottaisi tarkemmalta näyttävää
-- mutta ei todempaa tietoa.
--
-- TÄMÄ EI OLE TERVEYSTIETOA VAAN OMASEURANTAA
-- Sovellus ei tee diagnooseja eikä anna hoito-ohjeita. Merkintä vaikuttaa
-- vain siihen, minkä ehdotuksen sovellus näyttää päivän suunnittelussa —
-- eikä se koskaan muuta suunnitelmaa itsestään (src/domain/wellbeing.js:
-- planningLoadSuggestion palauttaa ehdotuksen, ei muutosta).
--
-- Tieto on silti arkaluontoista. Siksi sama RLS-malli kuin muussakin
-- datassa: vain omistaja näkee, kirjautumaton ei mitään.
--
-- KÄYTTÖÖNOTTO KOODISSA
-- Migraation jälkeen: src/data/schema.js -> TABLES.wellbeing = true.
--
-- MIKSI TÄMÄ ON TURVALLINEN
-- Migraatio luo yhden uuden taulun eikä koske olemassa olevaan dataan.
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
-- VAIHE 1: wellbeing_entries
--
-- Kaikki mittarit ovat nullable: käyttäjä saa merkitä vain sen mitä haluaa.
-- Osittainen merkintä on parempi kuin ei merkintää lainkaan.
--
-- (user_id, date) on uniikki: päivällä on yksi merkintä, jota muokataan.
-- Ilman tätä sama päivä kertyisi useaksi riviksi ja keskiarvot vääristyisivät.
-- ---------------------------------------------------------------------
create table if not exists public.wellbeing_entries (
  id          text primary key,
  user_id     uuid not null default auth.uid()
              references auth.users(id) on delete cascade,

  date        date not null,

  energy      smallint,
  mood        smallint,
  stress      smallint,

  -- Unen määrä tunteina. Puolikkaat tunnit ovat tarpeen, tarkempi ei.
  sleep_hours numeric(4, 2),

  note        text,

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint wellbeing_entries_unique_day unique (user_id, date)
);

alter table public.wellbeing_entries
  drop constraint if exists wellbeing_entries_scale_check;
alter table public.wellbeing_entries
  add constraint wellbeing_entries_scale_check
  check (
    (energy is null or energy between 1 and 5)
    and (mood   is null or mood   between 1 and 5)
    and (stress is null or stress between 1 and 5)
  );

alter table public.wellbeing_entries
  drop constraint if exists wellbeing_entries_sleep_check;
alter table public.wellbeing_entries
  add constraint wellbeing_entries_sleep_check
  check (sleep_hours is null or (sleep_hours > 0 and sleep_hours <= 24));

create index if not exists wellbeing_entries_user_date_idx
  on public.wellbeing_entries (user_id, date desc);

-- ---------------------------------------------------------------------
-- VAIHE 2: updated_at
-- ---------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists wellbeing_entries_touch_updated_at on public.wellbeing_entries;
create trigger wellbeing_entries_touch_updated_at
  before update on public.wellbeing_entries
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------
-- VAIHE 3: RLS
-- ---------------------------------------------------------------------
alter table public.wellbeing_entries enable row level security;

drop policy if exists wellbeing_entries_select_own on public.wellbeing_entries;
drop policy if exists wellbeing_entries_insert_own on public.wellbeing_entries;
drop policy if exists wellbeing_entries_update_own on public.wellbeing_entries;
drop policy if exists wellbeing_entries_delete_own on public.wellbeing_entries;

create policy wellbeing_entries_select_own on public.wellbeing_entries
  for select to authenticated using (auth.uid() = user_id);
create policy wellbeing_entries_insert_own on public.wellbeing_entries
  for insert to authenticated with check (auth.uid() = user_id);
create policy wellbeing_entries_update_own on public.wellbeing_entries
  for update to authenticated using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
create policy wellbeing_entries_delete_own on public.wellbeing_entries
  for delete to authenticated using (auth.uid() = user_id);

revoke all on public.wellbeing_entries from anon;
grant select, insert, update, delete on public.wellbeing_entries to authenticated;

commit;

-- =====================================================================
-- VARMISTUS MIGRAATION JÄLKEEN (aja erikseen, vain luku)
-- =====================================================================
-- select tablename, rowsecurity from pg_tables
--  where schemaname='public' and tablename='wellbeing_entries';
--   -> true
--
-- select count(*) from public.wellbeing_entries;
--   -> 0 heti migraation jälkeen
--
-- =====================================================================
-- ROLLBACK
-- =====================================================================
-- Poisto kadottaa kaikki hyvinvointimerkinnät. Ota varmuuskopio ensin.
--
--   begin;
--   drop table if exists public.wellbeing_entries;
--   commit;
--
-- Muista tällöin palauttaa src/data/schema.js -> TABLES.wellbeing = false.
