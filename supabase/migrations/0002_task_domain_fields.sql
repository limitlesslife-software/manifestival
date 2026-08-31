-- =====================================================================
-- Manifestival — migraatio 0002: tehtävän domain-kentät
-- =====================================================================
--
-- TILA: LUONNOS. TÄTÄ EI OLE AJETTU MIHINKÄÄN YMPÄRISTÖÖN.
--
-- ESIEHDOT
--   1. Migraatio 0001 on ajettu ja todennettu (user_id, RLS)
--   2. Varmuuskopio on otettu
--
-- TARKOITUS
-- Konseptidokumentin luku 9 määrittelee tehtävälle keston, määräajan,
-- prioriteetin ja tilan. Nykyisessä taulussa on vain otsikko, päivä, aika ja
-- kategoria. Domain-malli (src/domain/task.js) ja käyttöliittymä on jo
-- kirjoitettu näille kentille, mutta ne eivät säily tallennuksen yli ennen
-- kuin tämä migraatio on ajettu.
--
-- KÄYTTÖÖNOTTO KOODISSA
-- Migraation jälkeen: src/data/schema.js -> TASK_EXTENDED_FIELDS = true.
-- Se on tarkoituksella yhden rivin muutos.
--
-- MIKSI TÄMÄ ON TURVALLINEN
-- Migraatio on puhtaasti additiivinen: se lisää sarakkeita, ei muuta eikä
-- poista mitään. Olemassa oleva data säilyy koskemattomana ja vanha koodi
-- toimii sen jälkeenkin, koska kaikki uudet sarakkeet ovat nullable tai
-- niillä on oletusarvo.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- VAIHE 0: esiehdon tarkistus
-- Migraatio 0001 on pakko olla ajettu ensin, muuten uusilla riveillä ei
-- olisi omistajaa eikä RLS suojaisi niitä.
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'tasks' and column_name = 'user_id'
  ) then
    raise exception 'Migraatio 0001 pitaa ajaa ensin: tasks.user_id puuttuu.';
  end if;

  if not exists (
    select 1 from pg_tables
     where schemaname = 'public' and tablename = 'tasks' and rowsecurity = true
  ) then
    raise exception 'RLS ei ole paalla taulussa tasks. Aja migraatio 0001 ensin.';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- VAIHE 1: kuvaus
-- Otsikko on lyhyt ja skannattava. Pidempi konteksti kuuluu omaan kenttään.
-- ---------------------------------------------------------------------
alter table public.tasks
  add column if not exists description text;

-- ---------------------------------------------------------------------
-- VAIHE 2: kesto minuutteina
-- Tarvitaan tehtäville, joilla on kesto mutta ei kiinteää kellonaikaa —
-- aikataulumoottori sijoittaa ne vapaisiin väleihin.
-- ---------------------------------------------------------------------
alter table public.tasks
  add column if not exists duration_minutes integer;

alter table public.tasks
  drop constraint if exists tasks_duration_minutes_check;
alter table public.tasks
  add constraint tasks_duration_minutes_check
  check (duration_minutes is null or (duration_minutes > 0 and duration_minutes <= 1440));

-- ---------------------------------------------------------------------
-- VAIHE 3: prioriteetti
-- Kolme tasoa. Arvot vastaavat src/domain/priority.js:ää.
-- ---------------------------------------------------------------------
alter table public.tasks
  add column if not exists priority text not null default 'normaali';

alter table public.tasks
  drop constraint if exists tasks_priority_check;
alter table public.tasks
  add constraint tasks_priority_check
  check (priority in ('korkea', 'normaali', 'matala'));

-- ---------------------------------------------------------------------
-- VAIHE 4: aikataulutuksen tila
--
-- Erottaa käyttäjän oman päätöksen automaatin ehdotuksesta. Tämä on
-- tuotteen keskeinen lupaus: automaatti ei saa tuhota sitä, mitä käyttäjä on
-- itse päättänyt (konseptidokumentti, luku 7).
--
-- Olemassa olevat rivit merkitään manuaalisiksi: ne on luotu käyttäjän omilla
-- toimilla, joten automaatti ei saa siirtää niitä.
-- ---------------------------------------------------------------------
alter table public.tasks
  add column if not exists scheduling_state text;

update public.tasks
   set scheduling_state = case when "time" is null then 'unscheduled' else 'manual' end
 where scheduling_state is null;

alter table public.tasks
  alter column scheduling_state set default 'manual';

alter table public.tasks
  drop constraint if exists tasks_scheduling_state_check;
alter table public.tasks
  add constraint tasks_scheduling_state_check
  check (scheduling_state in ('manual', 'auto', 'unscheduled'));

-- ---------------------------------------------------------------------
-- VAIHE 5: aikaleimat
-- Tarvitaan myöhemmin edistymisen seurantaan ja synkronointiin.
-- Client ei saa asettaa näitä — ks. SERVER_OWNED_FIELDS src/lib/rows.js.
-- ---------------------------------------------------------------------
alter table public.tasks
  add column if not exists created_at timestamptz not null default now();

alter table public.tasks
  add column if not exists updated_at timestamptz not null default now();

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists tasks_touch_updated_at on public.tasks;
create trigger tasks_touch_updated_at
  before update on public.tasks
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------
-- VAIHE 6: indeksi prioriteettijärjestykselle
-- Päivänäkymä suodattaa käyttäjän ja päivän mukaan ja järjestää
-- prioriteetin mukaan.
-- ---------------------------------------------------------------------
create index if not exists tasks_user_date_priority_idx
  on public.tasks (user_id, date, priority);

commit;

-- =====================================================================
-- VARMISTUS MIGRAATION JÄLKEEN (aja erikseen, vain luku)
-- =====================================================================
-- select column_name, data_type, is_nullable, column_default
--   from information_schema.columns
--  where table_schema='public' and table_name='tasks'
--  order by ordinal_position;
--
-- select count(*) as ilman_tilaa from public.tasks where scheduling_state is null;
--   -> pitää olla 0
--
-- select priority, count(*) from public.tasks group by priority;
--   -> kaikkien pitää olla sallittuja arvoja
--
-- =====================================================================
-- ROLLBACK
-- =====================================================================
-- Tämä migraatio on additiivinen ja siksi peruttavissa ilman tietohäviötä
-- (uusiin sarakkeisiin tallennettu tieto katoaa, vanha data säilyy):
--
--   begin;
--   drop trigger if exists tasks_touch_updated_at on public.tasks;
--   drop function if exists public.touch_updated_at();
--   drop index if exists public.tasks_user_date_priority_idx;
--   alter table public.tasks
--     drop column if exists description,
--     drop column if exists duration_minutes,
--     drop column if exists priority,
--     drop column if exists scheduling_state,
--     drop column if exists created_at,
--     drop column if exists updated_at;
--   commit;
--
-- Muista tällöin palauttaa src/data/schema.js -> TASK_EXTENDED_FIELDS = false.
