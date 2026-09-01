-- =====================================================================
-- Manifestival — migraatio 0004: tavoitteet, projektit ja määräajat
-- =====================================================================
--
-- TILA: LUONNOS. TÄTÄ EI OLE AJETTU MIHINKÄÄN YMPÄRISTÖÖN.
--
-- ESIEHDOT
--   1. Migraatio 0001 on ajettu ja todennettu (user_id, RLS)
--   2. Migraatio 0002 on ajettu (tehtävän domain-kentät)
--   3. Varmuuskopio on otettu
--
-- TARKOITUS
-- Tehtävä ilman tavoitetta on työtä. Tavoite ilman tehtäviä on toivelista.
-- Tämä migraatio luo yhteyden: tehtävä voi kuulua tavoitteeseen ja
-- projektiin, ja tavoitteen edistyminen lasketaan sen tehtävistä.
--
-- Samalla tehtävälle lisätään määräaika. Määräaika on eri asia kuin
-- aikataulutus: `date` kertoo milloin asiaa on tarkoitus tehdä, `deadline`
-- kertoo milloin sen on oltava valmis. Näiden yhdistäminen samaan kenttään
-- oli alkuperäisen mallin virhe — sen takia myöhästyminen ei ollut
-- havaittavissa.
--
-- KÄYTTÖÖNOTTO KOODISSA
-- Migraation jälkeen: src/data/schema.js -> TABLES.goals = true ja
-- TABLES.projects = true.
--
-- MIKSI TÄMÄ ON TURVALLINEN
-- Uudet taulut ovat uusia. tasks-tauluun lisätään vain nullable-sarakkeita
-- ilman oletusarvoa, joten olemassa oleva data ei muutu eikä vanha koodi
-- riko mitään.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- VAIHE 0: esiehtojen tarkistus
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
-- VAIHE 1: goals
--
-- progress_mode ratkaisee mistä edistyminen tulee:
--   task_based  lasketaan liitetyistä tehtävistä (oletus)
--   manual      käyttäjän itse arvioima prosentti
--
-- Tyhjän tavoitteen edistyminen on 0 %, ei 100 %. Se on tietoinen valinta:
-- "ei tehtäviä" ei tarkoita "valmis". Laskenta on domainissa
-- (src/domain/goal.js), ei kannassa — näin sama sääntö pätee myös silloin
-- kun tieto on vielä muistivarastossa.
--
-- parent_goal_id sallii tavoitehierarkian. Se on nullable ja itseensä
-- viittaava; syklien esto on domainin vastuulla.
-- ---------------------------------------------------------------------
create table if not exists public.goals (
  id              text primary key,
  user_id         uuid not null default auth.uid()
                  references auth.users(id) on delete cascade,

  title           text not null,
  description     text,
  category        text not null default 'kehitys',
  priority        text not null default 'normaali',
  status          text not null default 'active',

  target_date     date,

  progress_mode   text not null default 'task_based',
  manual_progress integer not null default 0,

  parent_goal_id  text references public.goals(id) on delete set null,
  project_id      text,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

alter table public.goals
  drop constraint if exists goals_status_check;
alter table public.goals
  add constraint goals_status_check
  check (status in ('active', 'paused', 'completed', 'archived'));

alter table public.goals
  drop constraint if exists goals_progress_mode_check;
alter table public.goals
  add constraint goals_progress_mode_check
  check (progress_mode in ('manual', 'task_based'));

alter table public.goals
  drop constraint if exists goals_manual_progress_check;
alter table public.goals
  add constraint goals_manual_progress_check
  check (manual_progress >= 0 and manual_progress <= 100);

alter table public.goals
  drop constraint if exists goals_priority_check;
alter table public.goals
  add constraint goals_priority_check
  check (priority in ('korkea', 'normaali', 'matala'));

alter table public.goals
  drop constraint if exists goals_title_check;
alter table public.goals
  add constraint goals_title_check
  check (length(btrim(title)) > 0);

-- Tavoite ei voi olla oma yläkäsitteensä.
alter table public.goals
  drop constraint if exists goals_parent_not_self_check;
alter table public.goals
  add constraint goals_parent_not_self_check
  check (parent_goal_id is null or parent_goal_id <> id);

create index if not exists goals_user_status_idx
  on public.goals (user_id, status);

-- ---------------------------------------------------------------------
-- VAIHE 2: projects
--
-- Projekti on tavoitetta konkreettisempi ja tehtävää suurempi: rajattu
-- kokonaisuus, jolla on alku ja loppu. Se voi kuulua tavoitteeseen.
-- ---------------------------------------------------------------------
create table if not exists public.projects (
  id          text primary key,
  user_id     uuid not null default auth.uid()
              references auth.users(id) on delete cascade,

  name        text not null,
  description text,
  category    text not null default 'muu',
  status      text not null default 'active',

  goal_id     text references public.goals(id) on delete set null,
  target_date date,

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table public.projects
  drop constraint if exists projects_status_check;
alter table public.projects
  add constraint projects_status_check
  check (status in ('active', 'on_hold', 'completed', 'archived'));

alter table public.projects
  drop constraint if exists projects_name_check;
alter table public.projects
  add constraint projects_name_check
  check (length(btrim(name)) > 0);

create index if not exists projects_user_status_idx
  on public.projects (user_id, status);

-- goals.project_id viittaa projektiin. Viite lisätään vasta tässä, koska
-- taulut viittaavat toisiinsa molempiin suuntiin.
alter table public.goals
  drop constraint if exists goals_project_id_fkey;
alter table public.goals
  add constraint goals_project_id_fkey
  foreign key (project_id) references public.projects(id) on delete set null;

-- ---------------------------------------------------------------------
-- VAIHE 3: tasks — määräaika ja liitokset
--
-- Kaikki kolme saraketta ovat nullable eikä niillä ole oletusarvoa:
-- olemassa olevat tehtävät säilyvät täsmälleen sellaisina kuin ovat.
--
-- on delete set null: tavoitteen poisto ei saa koskaan poistaa tehtävää.
-- Työ on tehty, vaikka syy siihen olisi muuttunut.
-- ---------------------------------------------------------------------
alter table public.tasks
  add column if not exists deadline date;

alter table public.tasks
  add column if not exists goal_id text;

alter table public.tasks
  add column if not exists project_id text;

alter table public.tasks
  drop constraint if exists tasks_goal_id_fkey;
alter table public.tasks
  add constraint tasks_goal_id_fkey
  foreign key (goal_id) references public.goals(id) on delete set null;

alter table public.tasks
  drop constraint if exists tasks_project_id_fkey;
alter table public.tasks
  add constraint tasks_project_id_fkey
  foreign key (project_id) references public.projects(id) on delete set null;

-- Tavoitenäkymä hakee tehtävät tavoitteen mukaan.
create index if not exists tasks_user_goal_idx
  on public.tasks (user_id, goal_id);

-- Määräaikanäkymä hakee avoimet tehtävät määräajan mukaan.
create index if not exists tasks_user_deadline_idx
  on public.tasks (user_id, deadline)
  where deadline is not null;

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

drop trigger if exists goals_touch_updated_at on public.goals;
create trigger goals_touch_updated_at
  before update on public.goals
  for each row execute function public.touch_updated_at();

drop trigger if exists projects_touch_updated_at on public.projects;
create trigger projects_touch_updated_at
  before update on public.projects
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------
-- VAIHE 5: RLS
-- ---------------------------------------------------------------------
alter table public.goals    enable row level security;
alter table public.projects enable row level security;

drop policy if exists goals_select_own on public.goals;
drop policy if exists goals_insert_own on public.goals;
drop policy if exists goals_update_own on public.goals;
drop policy if exists goals_delete_own on public.goals;

create policy goals_select_own on public.goals
  for select to authenticated using (auth.uid() = user_id);
create policy goals_insert_own on public.goals
  for insert to authenticated with check (auth.uid() = user_id);
create policy goals_update_own on public.goals
  for update to authenticated using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
create policy goals_delete_own on public.goals
  for delete to authenticated using (auth.uid() = user_id);

drop policy if exists projects_select_own on public.projects;
drop policy if exists projects_insert_own on public.projects;
drop policy if exists projects_update_own on public.projects;
drop policy if exists projects_delete_own on public.projects;

create policy projects_select_own on public.projects
  for select to authenticated using (auth.uid() = user_id);
create policy projects_insert_own on public.projects
  for insert to authenticated with check (auth.uid() = user_id);
create policy projects_update_own on public.projects
  for update to authenticated using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
create policy projects_delete_own on public.projects
  for delete to authenticated using (auth.uid() = user_id);

revoke all on public.goals    from anon;
revoke all on public.projects from anon;

grant select, insert, update, delete on public.goals    to authenticated;
grant select, insert, update, delete on public.projects to authenticated;

commit;

-- =====================================================================
-- HUOMIO VIITEEHEYDESTÄ
-- =====================================================================
-- Vierasavain ei yksin estä sitä, että käyttäjä liittäisi tehtävänsä toisen
-- käyttäjän tavoitteeseen — RLS estää tavoitteen NÄKEMISEN, mutta ei
-- viittausta tunnettuun tunnisteeseen.
--
-- Tämä on hyväksytty riski nykyisessä vaiheessa, koska:
--   1. tunnisteet ovat arvaamattomia (crypto.randomUUID)
--   2. viittaus ei paljasta mitään: tavoitteen sisältö pysyy näkymättömänä
--   3. sovellus tarjoaa valintaan vain käyttäjän omat tavoitteet
--
-- Jos tämä halutaan sulkea kannassa, oikea keino on yhdistetty vierasavain
-- (user_id, id) -pariin. Se vaatii yhdistetyn uniikin indeksin goals- ja
-- projects-tauluihin ja on siksi oma migraationsa.

-- =====================================================================
-- VARMISTUS MIGRAATION JÄLKEEN (aja erikseen, vain luku)
-- =====================================================================
-- select tablename, rowsecurity from pg_tables
--  where schemaname='public' and tablename in ('goals','projects');
--   -> molemmilla true
--
-- select count(*) from public.tasks where deadline is not null;
--   -> 0 heti migraation jälkeen, koska sarake on uusi
--
-- select column_name, is_nullable, column_default
--   from information_schema.columns
--  where table_schema='public' and table_name='tasks'
--    and column_name in ('deadline','goal_id','project_id');
--   -> kaikkien pitää olla nullable ja ilman oletusarvoa
--
-- =====================================================================
-- ROLLBACK
-- =====================================================================
--   begin;
--   alter table public.tasks
--     drop constraint if exists tasks_goal_id_fkey,
--     drop constraint if exists tasks_project_id_fkey;
--   drop index if exists public.tasks_user_goal_idx;
--   drop index if exists public.tasks_user_deadline_idx;
--   alter table public.tasks
--     drop column if exists deadline,
--     drop column if exists goal_id,
--     drop column if exists project_id;
--   -- goals ja projects viittaavat toisiinsa, joten viite on purettava
--   -- ennen pudotusta.
--   alter table public.goals drop constraint if exists goals_project_id_fkey;
--   drop table if exists public.projects;
--   drop table if exists public.goals;
--   commit;
--
-- Muista tällöin palauttaa src/data/schema.js -> TABLES.goals = false ja
-- TABLES.projects = false.
