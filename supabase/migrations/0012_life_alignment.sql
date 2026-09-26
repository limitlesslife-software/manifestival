-- =====================================================================
-- Manifestival — migraatio 0012: Life Alignment (Suunta)
-- =====================================================================
--
-- TILA: EI AJETTU TUOTANTOON. EI HYVÄKSYTTY.
--
-- TÄMÄ ON SUUNNITELMA, EI SUORITUSKÄSKY.
--
-- =====================================================================
-- MITÄ TÄMÄ LISÄÄ
-- =====================================================================
--
--   public.life_areas         käyttäjän omat elämänalueet, tärkeys ja
--                             viikon aikatavoite
--   public.weekly_capacities  "paljonko realistisesti ehdin tällä viikolla"
--   public.time_entries       toteutunut aika (käyttäjän kirjaama)
--   public.alignment_reviews  viikkokatsauksen versioitu tilannekuva
--   goals.life_area_id        tavoitteen elämänalue (nullable)
--
-- =====================================================================
-- MITÄ TÄMÄ EI LISÄÄ — TARKOITUKSELLA
-- =====================================================================
--
-- EI HAVAINTOTAULUA. Kuormitus, huomiotta jääminen ja poikkeama
-- tavoitteista LASKETAAN lähdefaktoista (src/domain/alignment.js). Jos
-- ne tallennettaisiin, kannassa olisi kaksi totuutta, jotka erkanevat
-- heti kun tehtävä siirtyy. Ainoa tallennettu johdos on viikkokatsauksen
-- TILANNEKUVA, ja se on tarkoituksella historiaa: "näin tilanne näytti
-- kun katsoin viikkoa", versioitu `snapshot_version`-kentällä.
--
-- EI tasks.life_area_id -SARAKETTA. Tehtävä ja rutiini perivät alueen
-- tavoitteeltaan (goal_id / projektin goal_id) tai olemassa olevalta
-- kategorialtaan (`life_areas.category_key`). tasks on tuotannon
-- suurin taulu, eikä sitä muuteta rinnakkaisen luokittelun takia.
--
-- EI RAHAA EIKÄ ENERGIAN KULUTUSTA. Viikon energia on käyttäjän arvio
-- (1–5), ei laskettu kuorma. Raha tulee myöhemmin Taloudesta omana
-- lähteenään.
--
-- =====================================================================
-- VAIKUTUS OLEMASSA OLEVAAN DATAAN
-- =====================================================================
--
-- goals-tauluun lisätään YKSI NULLABLE sarake ilman oletusarvoa. Se on
-- PostgreSQL:ssä pelkkä luettelomuutos: rivejä ei kirjoiteta uudelleen,
-- täyttöä ei tehdä, eikä yksikään olemassa oleva tavoite muutu. Tavoite
-- ilman aluetta on kelvollinen ja näkyy käyttöliittymässä kohdassa
-- "Ei elämänaluetta".
--
-- Lukitus: ALTER TABLE goals ottaa ACCESS EXCLUSIVE -lukon hetkeksi, ja
-- vierasavaimen luonti SHARE ROW EXCLUSIVE -lukon tauluihin goals,
-- tasks ja auth.users. `lock_timeout` rajaa odotuksen.
--
-- =====================================================================
-- OMISTAJUUS
-- =====================================================================
--
-- Jokainen uusi taulu saa `owner_row_key`-avaimen (user_id, id) ja RLS:n.
-- Kaikki viittaukset sovellustauluihin ovat YHDISTELMÄVIERASAVAIMIA
-- `(user_id, x) -> t (user_id, id)`: vierasavaimen tarkistus EI kulje
-- RLS:n läpi, joten tavallinen avain sallisi toisen käyttäjän
-- elämänalueen liittämisen omaan tavoitteeseen.
--
-- Poistosääntö on `on delete set null (sarake)`. Alueen poisto ei vie
-- tavoitetta eikä kirjattua aikaa: ne vain lakkaavat kuulumasta alueeseen.
--
-- =====================================================================
-- OBJEKTIEN MÄÄRÄ: 58
-- =====================================================================
--
--    4  taulua
--    1  sarake          (goals.life_area_id)
--   18  CHECK-rajoitetta
--    4  owner_row_key -avainta
--    4  uniikkirajoitetta (alueen nimi, alueen kategoria, kapasiteetin
--                          viikko, katsauksen viikko)
--    4  vierasavainta   (goals -> life_areas; time_entries -> life_areas,
--                        goals, tasks)
--    3  indeksiä
--    4  liipaisinta
--   16  politiikkaa     (4 x 4)
--
-- Luku on käsin laskettu ja sitä käytetään osittaisen ajon
-- tunnistukseen. Nolla = tuore ajo. Mikä tahansa muu luku tarkoittaa,
-- että ajo on tehty tai jäänyt kesken — eikä kumpaakaan korjata
-- ajamalla uudelleen.

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
  -- 1. 0001 on ajettu: omistajasarake ja RLS.
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

  -- 2. 0004 on ajettu: goals-taulu ja sen omistajan rivin avain.
  --    goals.life_area_id -> life_areas on yhdistelmavierasavain, ja
  --    time_entries viittaa goals-tauluun samalla tavalla.
  if to_regclass('public.goals') is null then
    raise exception 'Taulua goals ei ole. Aja migraatio 0004 ensin.';
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'goals_owner_row_key'
  ) then
    raise exception 'goals_owner_row_key puuttuu. Aja migraatio 0004 ensin.';
  end if;

  -- 3. tasks-taulussa on omistajan rivin avain (0007).
  if not exists (
    select 1 from pg_constraint where conname = 'tasks_owner_row_key'
  ) then
    raise exception 'tasks_owner_row_key puuttuu. Aja migraatio 0007 ensin.';
  end if;

  -- 4. PostgreSQL 15 tai uudempi: sarakekohtainen ON DELETE SET NULL.
  --    Ilman sarakelistaa poisto yrittaisi nollata myos user_id:n.
  if current_setting('server_version_num')::int < 150000 then
    raise exception 'PostgreSQL % on liian vanha. Yhdistelmavierasavaimen sarakekohtainen ON DELETE SET NULL vaatii version 15.',
      current_setting('server_version');
  end if;

  -- 5. Olen oikeassa tietokannassa.
  if not exists (select 1 from auth.users where id = omistaja) then
    raise exception 'Hyvaksyttya omistajaa % ei loydy auth.users-taulusta. Vaara projekti?', omistaja;
  end if;

  -- 6. OSITTAISEN TAI AIEMMAN AJON TUNNISTUS — 58 objektia.
  select count(*) into olemassa from (
    select 1 from pg_tables
      where schemaname = 'public'
        and tablename in ('life_areas', 'weekly_capacities', 'time_entries',
                          'alignment_reviews')
    union all
    select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'goals'
        and column_name = 'life_area_id'
    union all
    select 1 from pg_constraint
      where conname in (
        'life_areas_name_check', 'life_areas_description_check',
        'life_areas_importance_check', 'life_areas_target_check',
        'life_areas_category_check', 'life_areas_sort_order_check',
        'life_areas_owner_row_key', 'life_areas_name_unique',
        'life_areas_category_unique',
        'weekly_capacities_week_start_check', 'weekly_capacities_minutes_check',
        'weekly_capacities_energy_check', 'weekly_capacities_note_check',
        'weekly_capacities_owner_row_key', 'weekly_capacities_week_unique',
        'time_entries_minutes_check', 'time_entries_source_check',
        'time_entries_note_check', 'time_entries_owner_row_key',
        'time_entries_life_area_fkey', 'time_entries_goal_fkey',
        'time_entries_task_fkey',
        'alignment_reviews_week_start_check', 'alignment_reviews_version_check',
        'alignment_reviews_snapshot_check', 'alignment_reviews_reflection_check',
        'alignment_reviews_adjustments_check', 'alignment_reviews_owner_row_key',
        'alignment_reviews_week_unique',
        'goals_life_area_fkey')
    union all
    select 1 from pg_indexes
      where schemaname = 'public'
        and indexname in ('life_areas_user_active_idx', 'time_entries_user_date_idx',
                          'goals_user_life_area_idx')
    union all
    select 1 from pg_trigger
      where not tgisinternal
        and tgname in ('life_areas_touch_updated_at', 'weekly_capacities_touch_updated_at',
                       'time_entries_touch_updated_at', 'alignment_reviews_touch_updated_at')
    union all
    select 1 from pg_policies
      where schemaname = 'public'
        and tablename in ('life_areas', 'weekly_capacities', 'time_entries',
                          'alignment_reviews')
  ) kaikki;

  if olemassa = 58 then
    raise exception 'Migraatio 0012 on JO AJETTU. Ala aja uudelleen — aja supabase/verify/verify_0012.sql.';
  end if;

  -- 0013 korvaa 0012:n rajoitteen time_entries_source_check, joten
  -- 0013:n jälkeen luku on 57 eikä 58. Se EI ole keskeneräinen 0012 —
  -- ilman tätä haaraa uudelleenajo ohjaisi palautuspolulle turhaan.
  if olemassa = 57
     and exists (select 1 from pg_constraint where conname = 'time_entries_source_v2_check') then
    raise exception 'Migraatiot 0012 JA 0013 on JO AJETTU. Ala aja uudelleen — aja supabase/verify/verify_0013.sql.';
  end if;

  if olemassa > 0 then
    select string_agg(nimi, ', ' order by nimi) into nimet from (
      select tablename::text as nimi from pg_tables
        where schemaname = 'public'
          and tablename in ('life_areas', 'weekly_capacities', 'time_entries',
                            'alignment_reviews')
      union all
      select 'goals.' || column_name::text from information_schema.columns
        where table_schema = 'public' and table_name = 'goals'
          and column_name = 'life_area_id'
      union all
      select conname::text from pg_constraint
        where conname like 'life\_areas\_%'
           or conname like 'weekly\_capacities\_%'
           or conname like 'time\_entries\_%'
           or conname like 'alignment\_reviews\_%'
           or conname = 'goals_life_area_fkey'
      union all
      select indexname::text from pg_indexes
        where schemaname = 'public'
          and indexname in ('life_areas_user_active_idx', 'time_entries_user_date_idx',
                            'goals_user_life_area_idx')
      union all
      select tgname::text from pg_trigger
        where not tgisinternal
          and tgname in ('life_areas_touch_updated_at', 'weekly_capacities_touch_updated_at',
                         'time_entries_touch_updated_at', 'alignment_reviews_touch_updated_at')
      union all
      select policyname::text from pg_policies
        where schemaname = 'public'
          and tablename in ('life_areas', 'weekly_capacities', 'time_entries',
                            'alignment_reviews')
    ) loydetyt;

    raise exception 'Migraatio 0012 on kesken: % objektia 58:sta on jo olemassa (%).',
      olemassa, nimet;
  end if;

  raise notice 'Esiehdot kunnossa. Omistaja %, 0012:n objekteja 0/58.', omistaja;
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
-- VAIHE 1: life_areas
--
-- KÄYTTÄJÄ MÄÄRITTELEE MIKÄ ON TÄRKEÄÄ. Sovellus ei luo oletusalueita
-- eikä päätä niiden tärkeyttä.
--
-- TÄRKEYS JA AIKATAVOITE OVAT ERI ASIOITA. Tärkeys (1–5) vastaa
-- kysymykseen "kuinka tärkeä tämä on siinä elämässä jota haluan", ja
-- aikatavoite kysymykseen "paljonko aikaa haluan antaa tälle viikossa".
-- Perhe voi olla erittäin tärkeä vaikka viikkoon mahtuu vähän tunteja.
-- Kumpaakaan ei johdeta toisesta.
--
-- AIKATAVOITE ON MINUUTTEJA VIIKOSSA, EI PROSENTTIOSUUS. Minuutit
-- verrataan suoraan viikkokapasiteettiin ja toteumaan; osuus lasketaan
-- niistä näytettäessä. NULL = tavoitetta ei ole asetettu (eri asia kuin
-- 0 = "en halua käyttää tähän aikaa tällä hetkellä").
-- ---------------------------------------------------------------------

create table public.life_areas (
  id                       text primary key,
  user_id                  uuid not null default auth.uid()
                           references auth.users(id) on delete cascade,

  name                     text not null,
  description              text,

  -- 1 = vähän tärkeä ... 5 = erittäin tärkeä. Strateginen tärkeys,
  -- ei tämän päivän kiireellisyys.
  importance               smallint not null default 3,

  target_minutes_per_week  integer,

  -- Olemassa olevan kategorian avain (src/domain/categories.js).
  -- Liittämätön tehtävä tai rutiini, jonka kategoria on tämä, kuuluu
  -- tähän alueeseen. Yksi kategoria voi kuulua vain yhteen alueeseen.
  category_key             text,

  -- Pois kytketty alue säilyy historiana mutta ei tuota havaintoja.
  active                   boolean not null default true,
  sort_order               integer not null default 0,

  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

alter table public.life_areas
  add constraint life_areas_name_check
  check (length(btrim(name)) > 0 and length(name) <= 60);

alter table public.life_areas
  add constraint life_areas_description_check
  check (description is null or length(description) <= 500);

alter table public.life_areas
  add constraint life_areas_importance_check
  check (importance between 1 and 5);

-- Viikossa on 10080 minuuttia. Suurempi tavoite ei ole tavoite.
alter table public.life_areas
  add constraint life_areas_target_check
  check (target_minutes_per_week is null
      or (target_minutes_per_week >= 0 and target_minutes_per_week <= 10080));

alter table public.life_areas
  add constraint life_areas_category_check
  check (category_key is null
      or category_key in ('tyo', 'perhe', 'hyvinvointi', 'harrastus', 'koti',
                          'kehitys', 'talous', 'muu'));

alter table public.life_areas
  add constraint life_areas_sort_order_check
  check (sort_order >= 0 and sort_order <= 999);

alter table public.life_areas
  add constraint life_areas_owner_row_key unique (user_id, id);

-- Kaksi samannimistä aluetta tekisi valinnasta arvauksen.
alter table public.life_areas
  add constraint life_areas_name_unique unique (user_id, name);

-- YKSI KATEGORIA, YKSI ALUE. Muuten sama tehtävä laskettaisiin kahteen
-- alueeseen. NULL-arvot eivät törmää (PostgreSQL:n oletus).
alter table public.life_areas
  add constraint life_areas_category_unique unique (user_id, category_key);

create index life_areas_user_active_idx
  on public.life_areas (user_id, active, sort_order);

alter table public.life_areas enable row level security;

create policy life_areas_select_own on public.life_areas
  for select to authenticated using (auth.uid() = user_id);
create policy life_areas_insert_own on public.life_areas
  for insert to authenticated with check (auth.uid() = user_id);
create policy life_areas_update_own on public.life_areas
  for update to authenticated using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
create policy life_areas_delete_own on public.life_areas
  for delete to authenticated using (auth.uid() = user_id);

revoke all on public.life_areas from public;
revoke all on public.life_areas from anon;
revoke all on public.life_areas from authenticated;
grant select, insert, update, delete on public.life_areas to authenticated;

create trigger life_areas_touch_updated_at
  before update on public.life_areas
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------
-- VAIHE 2: goals.life_area_id
--
-- ⚠ TÄSSÄ MUUTETAAN TAULUA, JOSSA ON KÄYTTÄJÄN DATAA ⚠
--
-- Nullable, ei oletusarvoa, ei täyttöä. Olemassa olevat tavoitteet
-- säilyvät täsmälleen ennallaan (life_area_id = NULL).
-- ---------------------------------------------------------------------

alter table public.goals add column life_area_id text;

alter table public.goals
  add constraint goals_life_area_fkey
  foreign key (user_id, life_area_id) references public.life_areas (user_id, id)
  on delete set null (life_area_id);

create index goals_user_life_area_idx
  on public.goals (user_id, life_area_id);

-- ---------------------------------------------------------------------
-- VAIHE 3: weekly_capacities
--
-- "Paljonko realistisesti ehdin tällä viikolla?" Yksi rivi viikkoa
-- kohti. Viikko alkaa maanantaina (src/domain/week.js).
-- ---------------------------------------------------------------------

create table public.weekly_capacities (
  id                 text primary key,
  user_id            uuid not null default auth.uid()
                     references auth.users(id) on delete cascade,

  week_start         date not null,

  -- Suunniteltavissa oleva aika minuutteina (ei valveilla oloaika).
  available_minutes  integer not null,

  -- Käyttäjän oma arvio viikon energiasta 1–5. Valinnainen. Ei johdettu.
  energy_level       smallint,

  note               text,

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- VIIKKO ALKAA MAANANTAINA. Muuten sama viikko voisi olla kahdella
-- rivillä (ma ja ti), ja uniikkirajoite ei estäisi sitä.
alter table public.weekly_capacities
  add constraint weekly_capacities_week_start_check
  check (extract(isodow from week_start) = 1);

alter table public.weekly_capacities
  add constraint weekly_capacities_minutes_check
  check (available_minutes >= 0 and available_minutes <= 10080);

alter table public.weekly_capacities
  add constraint weekly_capacities_energy_check
  check (energy_level is null or energy_level between 1 and 5);

alter table public.weekly_capacities
  add constraint weekly_capacities_note_check
  check (note is null or length(note) <= 500);

alter table public.weekly_capacities
  add constraint weekly_capacities_owner_row_key unique (user_id, id);

alter table public.weekly_capacities
  add constraint weekly_capacities_week_unique unique (user_id, week_start);

alter table public.weekly_capacities enable row level security;

create policy weekly_capacities_select_own on public.weekly_capacities
  for select to authenticated using (auth.uid() = user_id);
create policy weekly_capacities_insert_own on public.weekly_capacities
  for insert to authenticated with check (auth.uid() = user_id);
create policy weekly_capacities_update_own on public.weekly_capacities
  for update to authenticated using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
create policy weekly_capacities_delete_own on public.weekly_capacities
  for delete to authenticated using (auth.uid() = user_id);

revoke all on public.weekly_capacities from public;
revoke all on public.weekly_capacities from anon;
revoke all on public.weekly_capacities from authenticated;
grant select, insert, update, delete on public.weekly_capacities to authenticated;

create trigger weekly_capacities_touch_updated_at
  before update on public.weekly_capacities
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------
-- VAIHE 4: time_entries
--
-- TOTEUTUNUT AIKA ON KÄYTTÄJÄN KIRJAAMA. Arviota ei koskaan kopioida
-- toteumaksi, eikä valmiiksi merkitty tehtävä tuota tänne riviä.
--
-- `source` sallii tänään vain 'manual'. Tuleva lähde (kalenteri,
-- ajastin) lisätään omalla migraatiollaan, jolloin sen rivit erottuvat
-- aina käyttäjän omasta kirjauksesta.
-- ---------------------------------------------------------------------

create table public.time_entries (
  id            text primary key,
  user_id       uuid not null default auth.uid()
                references auth.users(id) on delete cascade,

  entry_date    date not null,
  minutes       integer not null,

  -- Mihin aika kului. Kaikki valinnaisia; järjestys (alue > tehtävä >
  -- tavoite) ratkaistaan domainissa (src/domain/alignment.js).
  life_area_id  text,
  goal_id       text,
  task_id       text,

  source        text not null default 'manual',
  note          text,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

alter table public.time_entries
  add constraint time_entries_minutes_check
  check (minutes > 0 and minutes <= 1440);

alter table public.time_entries
  add constraint time_entries_source_check
  check (source in ('manual'));

alter table public.time_entries
  add constraint time_entries_note_check
  check (note is null or length(note) <= 500);

alter table public.time_entries
  add constraint time_entries_owner_row_key unique (user_id, id);

alter table public.time_entries
  add constraint time_entries_life_area_fkey
  foreign key (user_id, life_area_id) references public.life_areas (user_id, id)
  on delete set null (life_area_id);

alter table public.time_entries
  add constraint time_entries_goal_fkey
  foreign key (user_id, goal_id) references public.goals (user_id, id)
  on delete set null (goal_id);

alter table public.time_entries
  add constraint time_entries_task_fkey
  foreign key (user_id, task_id) references public.tasks (user_id, id)
  on delete set null (task_id);

create index time_entries_user_date_idx
  on public.time_entries (user_id, entry_date);

alter table public.time_entries enable row level security;

create policy time_entries_select_own on public.time_entries
  for select to authenticated using (auth.uid() = user_id);
create policy time_entries_insert_own on public.time_entries
  for insert to authenticated with check (auth.uid() = user_id);
create policy time_entries_update_own on public.time_entries
  for update to authenticated using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
create policy time_entries_delete_own on public.time_entries
  for delete to authenticated using (auth.uid() = user_id);

revoke all on public.time_entries from public;
revoke all on public.time_entries from anon;
revoke all on public.time_entries from authenticated;
grant select, insert, update, delete on public.time_entries to authenticated;

create trigger time_entries_touch_updated_at
  before update on public.time_entries
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------
-- VAIHE 5: alignment_reviews
--
-- TILANNEKUVA ON HISTORIAA, EI ELÄVÄÄ TOTUUTTA. Se tallentaa mitä
-- käyttäjä näki katsoessaan viikkoa: kapasiteetti, alueiden tavoitteet,
-- toteuman yhteenveto, havainnot ja valitut muutokset. Tiivis
-- (viittaukset tunnisteina, ei kopioita tehtävistä), versioitu.
-- ---------------------------------------------------------------------

create table public.alignment_reviews (
  id                text primary key,
  user_id           uuid not null default auth.uid()
                    references auth.users(id) on delete cascade,

  week_start        date not null,

  snapshot_version  smallint not null default 1,
  snapshot          jsonb not null,

  -- Käyttäjän oma pohdinta. Sisältöä, ei lokia.
  reflection        text,

  -- Valitut ja vahvistetut muutokset seuraavalle viikolle.
  adjustments       jsonb not null default '[]'::jsonb,

  completed_at      timestamptz,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

alter table public.alignment_reviews
  add constraint alignment_reviews_week_start_check
  check (extract(isodow from week_start) = 1);

alter table public.alignment_reviews
  add constraint alignment_reviews_version_check
  check (snapshot_version >= 1 and snapshot_version <= 100);

-- TIIVIS TILANNEKUVA. 64 kt riittää kymmenille alueille ja havainnoille;
-- suurempi tarkoittaisi että kuvaan on kopioitu dataa viittausten sijaan.
alter table public.alignment_reviews
  add constraint alignment_reviews_snapshot_check
  check (jsonb_typeof(snapshot) = 'object' and pg_column_size(snapshot) <= 65536);

alter table public.alignment_reviews
  add constraint alignment_reviews_reflection_check
  check (reflection is null or length(reflection) <= 4000);

alter table public.alignment_reviews
  add constraint alignment_reviews_adjustments_check
  check (jsonb_typeof(adjustments) = 'array' and pg_column_size(adjustments) <= 32768);

alter table public.alignment_reviews
  add constraint alignment_reviews_owner_row_key unique (user_id, id);

alter table public.alignment_reviews
  add constraint alignment_reviews_week_unique unique (user_id, week_start);

alter table public.alignment_reviews enable row level security;

create policy alignment_reviews_select_own on public.alignment_reviews
  for select to authenticated using (auth.uid() = user_id);
create policy alignment_reviews_insert_own on public.alignment_reviews
  for insert to authenticated with check (auth.uid() = user_id);
create policy alignment_reviews_update_own on public.alignment_reviews
  for update to authenticated using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
create policy alignment_reviews_delete_own on public.alignment_reviews
  for delete to authenticated using (auth.uid() = user_id);

revoke all on public.alignment_reviews from public;
revoke all on public.alignment_reviews from anon;
revoke all on public.alignment_reviews from authenticated;
grant select, insert, update, delete on public.alignment_reviews to authenticated;

create trigger alignment_reviews_touch_updated_at
  before update on public.alignment_reviews
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
     and tablename in ('life_areas', 'weekly_capacities', 'time_entries',
                       'alignment_reviews');
  if n <> 16 then
    raise exception 'Odotettiin 16 politiikkaa, loytyi %.', n;
  end if;

  select count(*) into n from pg_class
   where relnamespace = 'public'::regnamespace
     and relname in ('life_areas', 'weekly_capacities', 'time_entries',
                     'alignment_reviews')
     and relrowsecurity;
  if n <> 4 then
    raise exception 'RLS ei ole paalla kaikissa neljassa uudessa taulussa.';
  end if;

  -- POISTOSAANTO RAJAA NOLLAUKSEN SARAKKEESEEN.
  select count(*) into n from pg_constraint
   where conname in ('goals_life_area_fkey', 'time_entries_life_area_fkey',
                     'time_entries_goal_fkey', 'time_entries_task_fkey')
     and confdeltype = 'n'
     and array_length(confdelsetcols, 1) = 1;
  if n <> 4 then
    raise exception 'Poistosaanto ei rajaa nollausta sarakkeeseen. Alueen poisto kaatuisi.';
  end if;

  -- PUBLIC-ROOLIN OIKEUDET LUETAAN SUORAAN ACL:STA.
  select count(*) into n
    from pg_class c,
         lateral aclexplode(c.relacl) a
   where c.relnamespace = 'public'::regnamespace
     and c.relname in ('life_areas', 'weekly_capacities', 'time_entries',
                       'alignment_reviews')
     and a.grantee = 0;
  if n <> 0 then
    raise exception 'PUBLIC-roolilla on % oikeutta uusiin tauluihin.', n;
  end if;

  if has_table_privilege('anon', 'public.life_areas', 'select')
     or has_table_privilege('anon', 'public.weekly_capacities', 'select')
     or has_table_privilege('anon', 'public.time_entries', 'select')
     or has_table_privilege('anon', 'public.alignment_reviews', 'select') then
    raise exception 'anon-roolilla on lukuoikeus uusiin tauluihin.';
  end if;

  if not has_table_privilege('authenticated', 'public.life_areas', 'select')
     or not has_table_privilege('authenticated', 'public.alignment_reviews', 'select') then
    raise exception 'authenticated-roolilta puuttuu lukuoikeus uusiin tauluihin.';
  end if;

  -- OLEMASSA OLEVAT POLITIIKAT OVAT KOSKEMATTOMIA.
  select count(*) into n from pg_policies
   where schemaname = 'public' and tablename in ('tasks', 'goals', 'projects');
  if n <> 12 then
    raise exception 'Olemassa olevien taulujen politiikat muuttuivat: % (odotus 12).', n;
  end if;

  -- YHTÄKÄÄN OLEMASSA OLEVAA TAVOITETTA EI LIITETTY. Ei täyttöä.
  select count(*) into n from public.goals where life_area_id is not null;
  if n <> 0 then
    raise exception 'Tavoitteita liitettiin elamanalueeseen migraatiossa: %.', n;
  end if;

  raise notice 'Migraatio 0012 valmis. Aja seuraavaksi supabase/verify/verify_0012.sql.';
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
--   2. Varmuuskopio
--   3. Vain lukeva inventaario ja esitarkistus:
--        supabase/acceptance/activation_readonly_inventory.sql
--        supabase/preflight/preflight_0012.sql
--   4. Ajo postgres-roolilla Supabasen SQL-editorissa
--   5. supabase/verify/verify_0012.sql
--   6. Vasta sitten portit src/data/schema.js:ssä (TABLES.lifeAreas,
--      weeklyCapacities, timeEntries, alignmentReviews ja
--      GOAL_LIFE_AREA_FIELD) — ja vain oman julkaisuaaltonsa mukana.
--
-- ESITARKISTUS (vain lukeva, turvallinen ajaa milloin tahansa):
--
--   select
--     (select count(*) from pg_tables
--       where schemaname='public'
--         and tablename in ('life_areas','weekly_capacities',
--                           'time_entries','alignment_reviews')) as uudet_taulut,
--     (select count(*) from information_schema.columns
--       where table_schema='public' and table_name='goals'
--         and column_name='life_area_id') as goals_sarake,
--     (select count(*) from pg_constraint
--       where conname in ('goals_owner_row_key','tasks_owner_row_key')) as omistajan_avaimet,
--     (select current_setting('server_version_num')::int >= 150000) as pg15_tai_uudempi;
--
--   Odotus ennen ajoa: 0, 0, 2, true
--
-- =====================================================================
-- ROLLBACK
-- =====================================================================
--
-- PERUUTUS AINA KÄÄNTEISESSÄ JÄRJESTYKSESSÄ: 0013 ensin, sitten tämä.
--
--   begin;
--   set local lock_timeout = '5s';
--
--   -- VARTIJA: jos 0013 on yhä ajettu, sen taulut viittaavat
--   -- life_areas-tauluun ja tämä peruutus kaatuisi kesken
--   -- selittämättä. Tunnistus kuten 0012:n uudelleenajossa: 0013:n
--   -- korvaava lähderajoite tai muu kuin 0012:n oma viittaus
--   -- life_areas-tauluun (0013:n tauluja ei nimetä tässä tiedostossa).
--   do $$
--   begin
--     if exists (select 1 from pg_constraint where conname = 'time_entries_source_v2_check')
--        or exists (select 1 from pg_constraint c join pg_class t on t.oid = c.conrelid
--                    where c.contype = 'f' and c.confrelid = to_regclass('public.life_areas')
--                      and t.relname not in ('goals', 'time_entries')) then
--       raise exception 'Peruutus keskeytetty: migraatio 0013 on yha ajettu. Peruuta ensin 0013 (sen ROLLBACK-osio) ja aja vasta sitten tama.';
--     end if;
--   end $$;
--
--   drop table public.alignment_reviews;
--   drop table public.time_entries;
--   drop table public.weekly_capacities;
--   alter table public.goals drop constraint goals_life_area_fkey;
--   drop index public.goals_user_life_area_idx;
--   alter table public.goals drop column life_area_id;
--   drop table public.life_areas;
--
--   commit;
--
-- Järjestys on pakollinen: goals_life_area_fkey viittaa life_areas-
-- tauluun, joten se pudotetaan ennen taulua.
--
-- HUOM. Peruutus POISTAA pysyvästi käyttäjän elämänalueet, kapasiteetit,
-- kirjatun ajan, katsaukset ja tavoitteiden aluekytkennät. Sulje portit
-- ensin (src/data/schema.js) ja ota varmuuskopio. Tavoitteet itse
-- säilyvät: vain niiden life_area_id-sarake poistuu.
--
-- =====================================================================
-- RISKIT
-- =====================================================================
--
--   MATALA   neljä uutta tyhjää taulua
--   MATALA   goals: yksi nullable sarake ilman oletusta = luettelomuutos,
--            ei rivien uudelleenkirjoitusta; vierasavaimen validointi
--            käy goals-taulun läpi, jossa kaikki arvot ovat NULL
--   KESKI    lukitus: ACCESS EXCLUSIVE goals-tauluun hetkeksi. Aja
--            hiljaisena aikana; lock_timeout keskeyttää jos jono kasvaa
--   MATALA   peruutus on taulujen ja yhden sarakkeen pudotus
