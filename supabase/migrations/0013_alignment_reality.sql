-- =====================================================================
-- Manifestival — migraatio 0013: Suunta 2 — toteuma, ajastin, energia
-- =====================================================================
--
-- TILA: EI AJETTU TUOTANTOON. EI HYVÄKSYTTY.
--
-- TÄMÄ ON SUUNNITELMA, EI SUORITUSKÄSKY.
--
-- RIIPPUU MIGRAATIOSTA 0012 (ei ajettu). 0013 ajetaan vasta 0012:n ja
-- sen varmistuksen (supabase/verify/verify_0012.sql) jälkeen.
--
-- =====================================================================
-- MITÄ TÄMÄ LISÄÄ
-- =====================================================================
--
--   public.running_timers           käynnissä oleva ajastin; ENINTÄÄN
--                                   YKSI käyttäjää kohti
--   public.alignment_item_settings  tehtävän/rutiinin/projektin
--                                   Suunta-asetukset: kuormittavuus 1–5,
--                                   "tarkoituksella ilman aluetta",
--                                   "karkea arvio"
--   time_entries                    + project_id, routine_id,
--                                   occurrence_date, operation_id,
--                                   started_at, ended_at; source sallii
--                                   'timer'
--   weekly_capacities               + energy_budget_minutes
--   alignment_reviews               + policy_version, reflection_answers
--
-- Kolme viimeistä ovat 0012:n TAULUJA, jotka ovat tätä kirjoitettaessa
-- tyhjiä ja ajamatta. 0012:ta ei muuteta: se on suunniteltu ja
-- tarkastettu kokonaisuus, ja sen objektilaskenta (58) pysyy totena.
--
-- =====================================================================
-- MITÄ TÄMÄ EI LISÄÄ — TARKOITUKSELLA
-- =====================================================================
--
-- EI SARAKKEITA tasks-, routines- TAI projects-TAULUIHIN. Kuormittavuus
-- ja muut Suunta-asetukset ovat omassa taulussaan. Syy: tasks on
-- tuotannon suurin taulu ja sen portti on auki; sarake sinne vaatisi
-- sarakeportin, ACCESS EXCLUSIVE -lukon ja jokaisen tehtävän
-- tallennuksen riippuvuuden uudesta sarakkeesta. Erillinen taulu on
-- uusi ja tyhjä, eikä sen puuttuminen kaada mitään.
--
-- alignment_item_settings.item_id EI OLE VIERASAVAIN, koska kohde voi
-- olla kolmessa eri taulussa. Seuraus: tehtävän poisto jättää asetuksen
-- orvoksi. Sovellus poistaa asetuksen kohteen mukana, ja orpo rivi on
-- haitaton (se ei viittaa mihinkään eikä näy missään). Käyttäjän
-- poistuessa rivit poistuvat user_id-kaskadilla kuten kaikki muutkin.
--
-- EI ELÄMÄNALUETTA SUORAAN TEHTÄVÄLLE. 0012:n periaate pysyy: tehtävä
-- perii alueen tavoitteelta, projektilta tai kategorialta.
--
-- EI HAVAINTOTAULUA. Energiakuormitus lasketaan kuten muutkin
-- havainnot (src/domain/energyLoad.js).
--
-- =====================================================================
-- YKSI AJASTIN KÄYTTÄJÄÄ KOHTI
-- =====================================================================
--
-- `running_timers_one_per_user unique (user_id)`. Toinen laite ei voi
-- käynnistää toista ajastinta: lisäys kaatuu koodilla 23505, ja
-- sovellus kertoo että ajastin on jo käynnissä.
--
-- Ajastimen kesto johdetaan AIKALEIMOISTA (started_at, paused_at,
-- paused_seconds). Kannassa ei ole juoksevaa laskuria, eikä mikään
-- prosessi päivitä riviä ajastimen käydessä.
--
-- =====================================================================
-- IDEMPOTENSSI
-- =====================================================================
--
-- `time_entries_operation_unique unique (user_id, operation_id)`.
-- Ajastimen pysäytys, tehtävän valmistumisen kirjaus ja offline-jonon
-- uusinta lähettävät saman operation_id:n. Toinen lähetys kaatuu
-- koodilla 23505, ja sovellus tulkitsee sen "jo tallennettu". NULL-arvot
-- eivät törmää (vanha käsin tehty kirjaus ilman tunnistetta).
--
-- =====================================================================
-- OBJEKTIEN MÄÄRÄ: 46
-- =====================================================================
--
--    2  taulua
--    9  saraketta      (time_entries 6, weekly_capacities 1,
--                       alignment_reviews 2)
--   24  rajoitetta     (ks. vaiheet; sisältää 2 owner_row_key -avainta,
--                       3 uniikkirajoitetta ja 7 vierasavainta)
--    1  indeksi
--    2  liipaisinta
--    8  politiikkaa    (2 x 4)
--
-- Lisäksi 0012:n rajoite `time_entries_source_check` PUDOTETAAN ja
-- korvataan rajoitteella `time_entries_source_v2_check`.
--
-- Luku on käsin laskettu ja sitä käytetään osittaisen ajon
-- tunnistukseen. Nolla = tuore ajo.

begin;

-- ---------------------------------------------------------------------
-- VAIHE 0a: lukitusraja
-- ---------------------------------------------------------------------
set local lock_timeout = '5s';

-- ---------------------------------------------------------------------
-- VAIHE 0b: esiehdot
-- ---------------------------------------------------------------------
do $$
declare
  omistaja  uuid := '2cc00622-f927-4604-a518-361a4328481b'::uuid;
  olemassa  int;
  nimet     text;
begin
  -- 0. 0001 on ajettu: omistajasarake ja RLS.
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'tasks' and column_name = 'user_id'
  ) then
    raise exception 'Migraatio 0001 pitaa ajaa ensin: tasks.user_id puuttuu.';
  end if;

  if not exists (
    select 1 from pg_class
     where relnamespace = 'public'::regnamespace
       and relname = 'tasks' and relrowsecurity
  ) then
    raise exception 'RLS ei ole paalla taulussa tasks. Aja migraatio 0001 ensin.';
  end if;

  -- 1. 0012 on ajettu: sen neljä taulua ovat olemassa.
  if (select count(*) from pg_tables
       where schemaname = 'public'
         and tablename in ('life_areas', 'weekly_capacities', 'time_entries',
                           'alignment_reviews')) <> 4 then
    raise exception 'Migraatio 0012 pitaa ajaa ensin: Suunnan taulut puuttuvat.';
  end if;

  -- 2. Viitatut omistajan rivin avaimet ovat olemassa.
  if (select count(*) from pg_constraint
       where conname in ('tasks_owner_row_key', 'goals_owner_row_key',
                         'projects_owner_row_key', 'routines_owner_row_key',
                         'life_areas_owner_row_key')) <> 5 then
    raise exception 'Omistajan rivin avain puuttuu (tasks/goals/projects/routines/life_areas).';
  end if;

  -- 3. PostgreSQL 15: sarakekohtainen ON DELETE SET NULL.
  if current_setting('server_version_num')::int < 150000 then
    raise exception 'PostgreSQL % on liian vanha (vaatii 15).', current_setting('server_version');
  end if;

  -- 4. Olen oikeassa tietokannassa.
  if not exists (select 1 from auth.users where id = omistaja) then
    raise exception 'Hyvaksyttya omistajaa % ei loydy auth.users-taulusta. Vaara projekti?', omistaja;
  end if;

  -- 5. OSITTAISEN TAI AIEMMAN AJON TUNNISTUS — 46 objektia.
  select count(*) into olemassa from (
    select 1 from pg_tables
      where schemaname = 'public'
        and tablename in ('running_timers', 'alignment_item_settings')
    union all
    select 1 from information_schema.columns
      where table_schema = 'public'
        and ((table_name = 'time_entries'
              and column_name in ('project_id', 'routine_id', 'occurrence_date',
                                  'operation_id', 'started_at', 'ended_at'))
          or (table_name = 'weekly_capacities' and column_name = 'energy_budget_minutes')
          or (table_name = 'alignment_reviews'
              and column_name in ('policy_version', 'reflection_answers')))
    union all
    select 1 from pg_constraint
      where conname in (
        'time_entries_source_v2_check', 'time_entries_operation_check',
        'time_entries_operation_unique', 'time_entries_project_fkey',
        'time_entries_routine_fkey', 'time_entries_span_check',
        'weekly_capacities_energy_budget_check',
        'alignment_reviews_policy_version_check', 'alignment_reviews_reflection_answers_check',
        'running_timers_target_kind_check', 'running_timers_paused_check',
        'running_timers_note_check', 'running_timers_owner_row_key',
        'running_timers_one_per_user', 'running_timers_life_area_fkey',
        'running_timers_goal_fkey', 'running_timers_task_fkey',
        'running_timers_project_fkey', 'running_timers_routine_fkey',
        'alignment_item_settings_kind_check', 'alignment_item_settings_item_id_check',
        'alignment_item_settings_energy_check', 'alignment_item_settings_owner_row_key',
        'alignment_item_settings_item_unique')
    union all
    select 1 from pg_indexes
      where schemaname = 'public'
        and indexname in ('time_entries_user_routine_idx')
    union all
    select 1 from pg_trigger
      where not tgisinternal
        and tgname in ('running_timers_touch_updated_at',
                       'alignment_item_settings_touch_updated_at')
    union all
    select 1 from pg_policies
      where schemaname = 'public'
        and tablename in ('running_timers', 'alignment_item_settings')
  ) kaikki;

  if olemassa = 46 then
    raise exception 'Migraatio 0013 on JO AJETTU. Ala aja uudelleen — aja supabase/verify/verify_0013.sql.';
  end if;

  if olemassa > 0 then
    select string_agg(nimi, ', ' order by nimi) into nimet from (
      select tablename::text as nimi from pg_tables
        where schemaname = 'public'
          and tablename in ('running_timers', 'alignment_item_settings')
      union all
      select table_name || '.' || column_name from information_schema.columns
        where table_schema = 'public'
          and ((table_name = 'time_entries'
                and column_name in ('project_id', 'routine_id', 'occurrence_date',
                                    'operation_id', 'started_at', 'ended_at'))
            or (table_name = 'weekly_capacities' and column_name = 'energy_budget_minutes')
            or (table_name = 'alignment_reviews'
                and column_name in ('policy_version', 'reflection_answers')))
      union all
      select conname::text from pg_constraint
        where conname like 'running\_timers\_%'
           or conname like 'alignment\_item\_settings\_%'
           or conname in ('time_entries_source_v2_check', 'time_entries_operation_check',
                          'time_entries_operation_unique', 'time_entries_project_fkey',
                          'time_entries_routine_fkey', 'time_entries_span_check',
                          'weekly_capacities_energy_budget_check',
                          'alignment_reviews_policy_version_check',
                          'alignment_reviews_reflection_answers_check')
    ) loydetyt;

    raise exception 'Migraatio 0013 on kesken: % objektia 46:sta on jo olemassa (%).',
      olemassa, nimet;
  end if;

  -- 6. Korvattava rajoite on olemassa (0012 tuore, ei käsin muutettu).
  if not exists (select 1 from pg_constraint where conname = 'time_entries_source_check') then
    raise exception 'time_entries_source_check puuttuu. 0012 ei ole alkuperaisessa tilassa.';
  end if;

  raise notice 'Esiehdot kunnossa. Omistaja %, 0013:n objekteja 0/46.', omistaja;
end $$;

-- ---------------------------------------------------------------------
-- VAIHE 0c: touch_updated_at on yhä kovennettu
-- ---------------------------------------------------------------------
do $$
declare
  turvamaare  boolean;
  asetukset   text[];
begin
  select p.prosecdef, p.proconfig into turvamaare, asetukset
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'touch_updated_at';

  if not found then
    raise exception 'Funktiota public.touch_updated_at() ei ole. Aja migraatio 0002 ensin.';
  end if;

  if turvamaare then
    raise exception 'public.touch_updated_at() on SECURITY DEFINER. Se pitaa olla INVOKER.';
  end if;

  if asetukset is null
     or not exists (select 1 from unnest(asetukset) a where a like 'search\_path=%') then
    raise exception 'public.touch_updated_at() ei kiinnita search_pathia.';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- VAIHE 1: time_entries — kohde, lähde ja idempotenssi
--
-- TOTEUMA ON YHÄ KÄYTTÄJÄN KIRJAAMA. 'timer' tarkoittaa, että käyttäjä
-- käynnisti ja pysäytti ajastimen; aika johdetaan aikaleimoista.
-- Arviota ei edelleenkään kopioida toteumaksi.
-- ---------------------------------------------------------------------

alter table public.time_entries add column project_id text;
alter table public.time_entries add column routine_id text;
-- Rutiinin esiintymän päivä: sama esiintymä tunnistetaan (routine_id,
-- occurrence_date) -parista. Rutiinin poistuessa routine_id nollautuu ja
-- päivä jää kirjauksen historiaksi (ei rajoitetta, joka kaataisi poiston).
alter table public.time_entries add column occurrence_date date;
alter table public.time_entries add column operation_id text;
alter table public.time_entries add column started_at timestamptz;
alter table public.time_entries add column ended_at timestamptz;

alter table public.time_entries drop constraint time_entries_source_check;

alter table public.time_entries
  add constraint time_entries_source_v2_check
  check (source in ('manual', 'timer'));

alter table public.time_entries
  add constraint time_entries_operation_check
  check (operation_id is null
      or (length(operation_id) between 1 and 100
          and operation_id ~ '^[A-Za-z0-9:_.-]+$'));

-- SAMA OPERAATIO KERRAN. NULL-arvot eivät törmää.
alter table public.time_entries
  add constraint time_entries_operation_unique unique (user_id, operation_id);

alter table public.time_entries
  add constraint time_entries_project_fkey
  foreign key (user_id, project_id) references public.projects (user_id, id)
  on delete set null (project_id);

alter table public.time_entries
  add constraint time_entries_routine_fkey
  foreign key (user_id, routine_id) references public.routines (user_id, id)
  on delete set null (routine_id);

-- Aikaväli on joko kokonaan tai ei ollenkaan, eikä lopu ennen alkua.
alter table public.time_entries
  add constraint time_entries_span_check
  check ((started_at is null and ended_at is null)
      or (started_at is not null and ended_at is not null and ended_at >= started_at));

create index time_entries_user_routine_idx
  on public.time_entries (user_id, routine_id, occurrence_date);

-- ---------------------------------------------------------------------
-- VAIHE 2: weekly_capacities.energy_budget_minutes
--
-- "Kuinka paljon kuormittavaa tekemistä jaksan tällä viikolla?"
-- Käyttäjän oma arvio minuutteina. NULL = ei asetettu. EI johdettu
-- aikakapasiteetista eikä hyvinvointimerkinnöistä.
-- ---------------------------------------------------------------------

alter table public.weekly_capacities add column energy_budget_minutes integer;

alter table public.weekly_capacities
  add constraint weekly_capacities_energy_budget_check
  check (energy_budget_minutes is null
      or (energy_budget_minutes >= 0 and energy_budget_minutes <= 10080));

-- ---------------------------------------------------------------------
-- VAIHE 3: alignment_reviews — sääntöversio ja jäsennelty pohdinta
-- ---------------------------------------------------------------------

-- Millä sääntöversiolla (src/domain/alignmentPolicy.js) havainnot
-- syntyivät. Vanhoja katsauksia EI lasketa uudelleen.
alter table public.alignment_reviews
  add column policy_version smallint not null default 1;

-- Vastaukset valinnaisiin pohdintakysymyksiin: {kysymyskoodi: teksti}.
-- Käyttäjän sisältöä, ei lokia. Ei lähetetä tekoälylle.
alter table public.alignment_reviews
  add column reflection_answers jsonb not null default '{}'::jsonb;

alter table public.alignment_reviews
  add constraint alignment_reviews_policy_version_check
  check (policy_version >= 1 and policy_version <= 100);

alter table public.alignment_reviews
  add constraint alignment_reviews_reflection_answers_check
  check (jsonb_typeof(reflection_answers) = 'object'
     and pg_column_size(reflection_answers) <= 16384);

-- ---------------------------------------------------------------------
-- VAIHE 4: running_timers
--
-- ENINTÄÄN YKSI KÄYNNISSÄ OLEVA AJASTIN KÄYTTÄJÄÄ KOHTI.
-- Kesto = (paused_at tai nyt) − started_at − paused_seconds.
-- ---------------------------------------------------------------------

create table public.running_timers (
  id               text primary key,
  user_id          uuid not null default auth.uid()
                   references auth.users(id) on delete cascade,

  -- Mitä ajastetaan. Kohteen poistuessa sarake nollautuu; ajastin
  -- säilyy (käyttäjä ei menetä kulunutta aikaa).
  target_kind      text not null default 'none',
  life_area_id     text,
  goal_id          text,
  task_id          text,
  project_id       text,
  routine_id       text,
  occurrence_date  date,

  started_at       timestamptz not null,
  paused_at        timestamptz,
  paused_seconds   integer not null default 0,

  note             text,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

alter table public.running_timers
  add constraint running_timers_target_kind_check
  check (target_kind in ('none', 'life_area', 'goal', 'task', 'project', 'routine'));

-- Tauko on ei-negatiivinen ja enintään viikko: pidempi on virhe.
alter table public.running_timers
  add constraint running_timers_paused_check
  check (paused_seconds >= 0 and paused_seconds <= 604800);

alter table public.running_timers
  add constraint running_timers_note_check
  check (note is null or length(note) <= 500);

alter table public.running_timers
  add constraint running_timers_owner_row_key unique (user_id, id);

-- YKSI AJASTIN KÄYTTÄJÄÄ KOHTI.
alter table public.running_timers
  add constraint running_timers_one_per_user unique (user_id);

alter table public.running_timers
  add constraint running_timers_life_area_fkey
  foreign key (user_id, life_area_id) references public.life_areas (user_id, id)
  on delete set null (life_area_id);

alter table public.running_timers
  add constraint running_timers_goal_fkey
  foreign key (user_id, goal_id) references public.goals (user_id, id)
  on delete set null (goal_id);

alter table public.running_timers
  add constraint running_timers_task_fkey
  foreign key (user_id, task_id) references public.tasks (user_id, id)
  on delete set null (task_id);

alter table public.running_timers
  add constraint running_timers_project_fkey
  foreign key (user_id, project_id) references public.projects (user_id, id)
  on delete set null (project_id);

alter table public.running_timers
  add constraint running_timers_routine_fkey
  foreign key (user_id, routine_id) references public.routines (user_id, id)
  on delete set null (routine_id);

alter table public.running_timers enable row level security;

create policy running_timers_select_own on public.running_timers
  for select to authenticated using (auth.uid() = user_id);
create policy running_timers_insert_own on public.running_timers
  for insert to authenticated with check (auth.uid() = user_id);
create policy running_timers_update_own on public.running_timers
  for update to authenticated using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
create policy running_timers_delete_own on public.running_timers
  for delete to authenticated using (auth.uid() = user_id);

revoke all on public.running_timers from public;
revoke all on public.running_timers from anon;
revoke all on public.running_timers from authenticated;
grant select, insert, update, delete on public.running_timers to authenticated;

create trigger running_timers_touch_updated_at
  before update on public.running_timers
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------
-- VAIHE 5: alignment_item_settings
--
-- Käyttäjän Suunta-asetukset yksittäiselle tehtävälle, rutiinille tai
-- projektille. Kaikki valinnaisia; puuttuva rivi = ei asetuksia.
--
--   energy_demand         1 kevyt ... 5 erittäin kuormittava; NULL =
--                         tuntematon. EI päätellä otsikosta.
--   alignment_opt_out     käyttäjä jätti tarkoituksella ilman aluetta
--                         (ei muistuteta uudelleen)
--   estimate_approximate  kestoarvio on karkea
-- ---------------------------------------------------------------------

create table public.alignment_item_settings (
  id                    text primary key,
  user_id               uuid not null default auth.uid()
                        references auth.users(id) on delete cascade,

  item_kind             text not null,
  item_id               text not null,

  energy_demand         smallint,
  alignment_opt_out     boolean not null default false,
  estimate_approximate  boolean not null default false,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

alter table public.alignment_item_settings
  add constraint alignment_item_settings_kind_check
  check (item_kind in ('task', 'routine', 'project'));

alter table public.alignment_item_settings
  add constraint alignment_item_settings_item_id_check
  check (length(item_id) between 1 and 100);

alter table public.alignment_item_settings
  add constraint alignment_item_settings_energy_check
  check (energy_demand is null or energy_demand between 1 and 5);

alter table public.alignment_item_settings
  add constraint alignment_item_settings_owner_row_key unique (user_id, id);

-- Yksi asetusrivi kohdetta kohti.
alter table public.alignment_item_settings
  add constraint alignment_item_settings_item_unique unique (user_id, item_kind, item_id);

alter table public.alignment_item_settings enable row level security;

create policy alignment_item_settings_select_own on public.alignment_item_settings
  for select to authenticated using (auth.uid() = user_id);
create policy alignment_item_settings_insert_own on public.alignment_item_settings
  for insert to authenticated with check (auth.uid() = user_id);
create policy alignment_item_settings_update_own on public.alignment_item_settings
  for update to authenticated using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
create policy alignment_item_settings_delete_own on public.alignment_item_settings
  for delete to authenticated using (auth.uid() = user_id);

revoke all on public.alignment_item_settings from public;
revoke all on public.alignment_item_settings from anon;
revoke all on public.alignment_item_settings from authenticated;
grant select, insert, update, delete on public.alignment_item_settings to authenticated;

create trigger alignment_item_settings_touch_updated_at
  before update on public.alignment_item_settings
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------
-- VAIHE 6: invarianttien todistus ENNEN COMMITTIA
-- ---------------------------------------------------------------------

do $$
declare
  n integer;
begin
  select count(*) into n from pg_policies
   where schemaname = 'public'
     and tablename in ('running_timers', 'alignment_item_settings');
  if n <> 8 then
    raise exception 'Odotettiin 8 politiikkaa, loytyi %.', n;
  end if;

  select count(*) into n from pg_class
   where relnamespace = 'public'::regnamespace
     and relname in ('running_timers', 'alignment_item_settings')
     and relrowsecurity;
  if n <> 2 then
    raise exception 'RLS ei ole paalla molemmissa uusissa tauluissa.';
  end if;

  -- POISTOSAANTO RAJAA NOLLAUKSEN SARAKKEESEEN (7 vierasavainta).
  select count(*) into n from pg_constraint
   where conname in ('time_entries_project_fkey', 'time_entries_routine_fkey',
                     'running_timers_life_area_fkey', 'running_timers_goal_fkey',
                     'running_timers_task_fkey', 'running_timers_project_fkey',
                     'running_timers_routine_fkey')
     and confdeltype = 'n'
     and array_length(confdelsetcols, 1) = 1;
  if n <> 7 then
    raise exception 'Poistosaanto ei rajaa nollausta sarakkeeseen (%/7).', n;
  end if;

  -- Vanha lähderajoite on korvattu, ei rinnakkain.
  if exists (select 1 from pg_constraint where conname = 'time_entries_source_check') then
    raise exception 'time_entries_source_check on yha olemassa.';
  end if;

  select count(*) into n
    from pg_class c,
         lateral aclexplode(c.relacl) a
   where c.relnamespace = 'public'::regnamespace
     and c.relname in ('running_timers', 'alignment_item_settings')
     and a.grantee = 0;
  if n <> 0 then
    raise exception 'PUBLIC-roolilla on % oikeutta uusiin tauluihin.', n;
  end if;

  if has_table_privilege('anon', 'public.running_timers', 'select')
     or has_table_privilege('anon', 'public.alignment_item_settings', 'select') then
    raise exception 'anon-roolilla on lukuoikeus uusiin tauluihin.';
  end if;

  -- OLEMASSA OLEVAT POLITIIKAT OVAT KOSKEMATTOMIA.
  select count(*) into n from pg_policies
   where schemaname = 'public'
     and tablename in ('tasks', 'goals', 'projects', 'routines',
                       'life_areas', 'weekly_capacities', 'time_entries',
                       'alignment_reviews');
  if n <> 32 then
    raise exception 'Olemassa olevien taulujen politiikat muuttuivat: % (odotus 32).', n;
  end if;

  raise notice 'Migraatio 0013 valmis. Aja seuraavaksi supabase/verify/verify_0013.sql.';
end $$;

commit;

-- =====================================================================
-- HYVÄKSYNTÄPORTTI
-- =====================================================================
--
-- TÄTÄ EI OLE AJETTU EIKÄ SAA AJAA ILMAN NIMENOMAISTA HYVÄKSYNTÄÄ.
--
-- Ennen ajoa vaaditaan:
--   1. Panun kirjallinen hyväksyntä
--   2. Migraatio 0012 ajettu JA supabase/verify/verify_0012.sql läpi
--   3. Varmuuskopio
--   4. Ajo postgres-roolilla Supabasen SQL-editorissa
--   5. supabase/verify/verify_0013.sql
--   6. Vasta sitten portit src/data/schema.js:ssä (TABLES.runningTimers,
--      TABLES.alignmentItemSettings ja ALIGNMENT_REALITY_FIELDS) — ja
--      vain oman julkaisuaaltonsa mukana.
--
-- ESITARKISTUS (vain lukeva):
--
--   select
--     (select count(*) from pg_tables where schemaname='public'
--       and tablename in ('life_areas','time_entries')) as suunta_0012,
--     (select count(*) from pg_tables where schemaname='public'
--       and tablename in ('running_timers','alignment_item_settings')) as uudet_0013,
--     (select count(*) from pg_constraint
--       where conname = 'time_entries_source_check') as vanha_lahde;
--
--   Odotus ennen ajoa: 2, 0, 1
--
-- =====================================================================
-- ROLLBACK
-- =====================================================================
--
-- PERUUTUS AINA KÄÄNTEISESSÄ JÄRJESTYKSESSÄ: tämä ensin, sitten 0012.
--
-- ENNEN PERUUTUSTA (vain lukeva): montako ajastinkirjausta muuttuu
-- manual-lähteeksi ja montako kirjausta menettää kohteensa kokonaan
-- (ainoa kohde oli projekti tai rutiini). Kirjaa luvut ylös.
--
--   select count(*) filter (where source = 'timer') as ajastinkirjauksia,
--          count(*) filter (where project_id is not null or routine_id is not null)
--            as projekti_tai_rutiinikytkentaisia,
--          count(*) filter (where (project_id is not null or routine_id is not null)
--                             and life_area_id is null and goal_id is null and task_id is null)
--            as menettaa_kohteen_kokonaan
--     from public.time_entries;
--
--   begin;
--   set local lock_timeout = '5s';
--
--   drop table public.alignment_item_settings;
--   drop table public.running_timers;
--
--   alter table public.alignment_reviews drop column reflection_answers;
--   alter table public.alignment_reviews drop column policy_version;
--   alter table public.weekly_capacities drop column energy_budget_minutes;
--
--   -- Ajastimella tehdyt kirjaukset EIVÄT mahdu vanhaan rajoitteeseen.
--   -- Päätä ennen peruutusta: muutetaanko ne 'manual'-lähteeksi
--   -- (aika säilyy, lähde katoaa) vai jätetäänkö peruutus tekemättä.
--   update public.time_entries set source = 'manual' where source = 'timer';
--   alter table public.time_entries drop constraint time_entries_source_v2_check;
--   alter table public.time_entries
--     add constraint time_entries_source_check check (source in ('manual'));
--
--   drop index public.time_entries_user_routine_idx;
--   alter table public.time_entries drop column ended_at;
--   alter table public.time_entries drop column started_at;
--   alter table public.time_entries drop column operation_id;
--   alter table public.time_entries drop column occurrence_date;
--   alter table public.time_entries drop column routine_id;
--   alter table public.time_entries drop column project_id;
--
--   commit;
--
-- Sarakkeen pudotus poistaa sen rajoitteet ja vierasavaimet mukanaan.
-- HUOM. Peruutus POISTAA käynnissä olevat ajastimet, kuormittavuus-
-- merkinnät, energiarajat ja jäsennellyt pohdinnat. Sulje portit ensin
-- (src/data/schema.js) ja ota varmuuskopio. Kirjattu aika säilyy:
-- minuutit, päivä sekä alue-, tavoite- ja tehtäväkytkentä pysyvät
-- (harjoiteltu: tools/pg-rehearsal rollback:data).
--
-- KOHDISTUS KATOAA OSITTAIN: project_id, routine_id, occurrence_date,
-- started_at, ended_at ja operation_id pudotetaan. Kirjaus, jonka ainoa
-- kohde oli projekti tai rutiini, jää ilman kohdetta (minuutit säilyvät,
-- mutta ne eivät enää kuulu mihinkään). Laske määrä yllä olevalla
-- kyselyllä ennen peruutusta.
--
-- =====================================================================
-- RISKIT
-- =====================================================================
--
--   MATALA   kaksi uutta tyhjää taulua
--   MATALA   sarakkeet lisätään 0012:n tauluihin, jotka ovat tuoreita
--            ja pieniä; nullable/oletusarvolliset sarakkeet ovat
--            luettelomuutoksia
--   MATALA   yhtään tuotannossa auki olevaa taulua (tasks, goals,
--            projects, routines) ei muuteta; niihin viitataan vain
--            yhdistelmävierasavaimilla, mikä ottaa niihin SHARE ROW
--            EXCLUSIVE -lukon hetkeksi (lock_timeout rajaa)
--   MATALA   peruutus on taulujen ja sarakkeiden pudotus
