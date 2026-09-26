-- =====================================================================
-- Manifestival — migraatio 0010: tavoitteesta tekemiseksi
-- =====================================================================
--
-- TILA: EI AJETTU TUOTANTOON. EI HYVÄKSYTTY.
--
-- TÄMÄ ON SUUNNITELMA, EI SUORITUSKÄSKY.
--
-- =====================================================================
-- ⚠ TÄMÄ MIGRAATIO ON VAARALLISEMPI KUIN 0003–0009 ⚠
-- =====================================================================
--
-- Kaikki aiemmat migraatiot LOIVAT uusia tauluja. Uusi taulu on tyhjä,
-- eikä tyhjää taulua voi rikkoa.
--
-- Tämä migraatio MUUTTAA KOLMEA TAULUA, JOISSA ON KÄYTTÄJÄN OIKEAA
-- DATAA JA JOIDEN PORTIT OVAT AUKI TUOTANNOSSA:
--
--   goals      aalto B ajettu (ddfc356), portti auki, rivejä olemassa
--   projects   aalto B ajettu (ddfc356), portti auki, rivejä olemassa
--   tasks      migraatio 0001/0002 ajettu, portti auki, rivejä olemassa
--
-- Konkreettisesti se tarkoittaa:
--
--   1. `goals_status_check` KORVATAAN. Rajoitteen pudottaminen ja
--      uudelleenluonti on hetki, jossa taulu on ilman suojaa. Se
--      tehdään yhdessä transaktiossa, mutta se on silti se kohta jota
--      pitää katsoa.
--
--   2. ALTER TABLE ottaa ACCESS EXCLUSIVE -lukon. Jokainen tavoitteen
--      ja tehtävän luku ja kirjoitus odottaa sen ajan. `lock_timeout`
--      on siksi olemassa, ja kaikki neljä taulua lukitaan KERRALLA
--      vaiheessa 0a ennen yhtäkään muutosta.
--
--   3. Uusi CHECK-rajoite validoidaan OLEMASSA OLEVIA RIVEJÄ vastaan.
--      Jos yksikin rivi rikkoo sen, koko migraatio peruuntuu.
--
-- Esitarkistus tiedoston lopussa on siksi pakollinen eikä
-- suositeltava.
--
-- =====================================================================
-- MITÄ TÄMÄ LISÄÄ
-- =====================================================================
--
--   public.milestones   uusi taulu     välitavoitteet
--   public.goals        MUUTOS         mittari + säästökytkentä + tila
--   public.tasks        MUUTOS         välitavoite + riippuvuudet
--   public.projects     MUUTOS         välitavoite
--   public.profile      MUUTOS         automaatiotaso + puskuri
--
-- =====================================================================
-- MITÄ TÄMÄ EI LISÄÄ — EIKÄ SAA LISÄTÄ
-- =====================================================================
--
-- SUUNNITELMAEHDOTUKSILLE EI OLE TAULUA. Se ei ole unohdus.
--
-- Ehdotus on väliaikainen: se elää siihen asti että käyttäjä hyväksyy
-- tai hylkää sen, ja hyväksytystä ehdotuksesta syntyy tavallisia
-- rivejä (tavoite, välitavoitteet, projektit, tehtävät, rutiinit).
-- Ehdotus itse ei jää mihinkään.
--
-- Kolme syytä:
--
--   1. Hylätty ehdotus on roskaa, joka ei koskaan katoa itsestään.
--   2. Ehdotus päätyisi vientiin (`dataExport.js`) ja täyttäisi sen
--      asioilla joita käyttäjä ei valinnut.
--   3. Ehdotus sisältää mallin tuottamaa tekstiä. Mitä vähemmän sitä
--      säilytetään, sitä vähemmän sitä voi vuotaa.
--
-- Taulu jota ei ole, ei voi vahingossa täyttyä. Sama päätös kuin
-- kuittiluennalla migraatiossa 0009.
--
-- RIIPPUVUUKSILLE EI OLE OMAA TAULUA. `tasks.depends_on` on
-- `text[]`-sarake eikä liitostaulu. Perustelu:
--
--   - riippuvuus on tehtävän ominaisuus, ei itsenäinen olio
--   - liitostaulu vaatisi oman RLS:nsä ja omat politiikkansa
--   - lista on lyhyt (sovellus rajaa kymmeneen)
--
-- Hinta on se, ettei kanta voi valvoa viite-eheyttä taulukon sisällä.
-- Se on tietoinen: poistettu edeltäjä jättää roikkuvan tunnisteen, ja
-- sovellus ohittaa sellaisen hiljaa (`dependencyLevels`). Roikkuva
-- tunniste on pienempi vahinko kuin tehtävän poiston estäminen.
--
-- =====================================================================
-- OMISTAJUUS
-- =====================================================================
--
-- `milestones.goal_id` on YHDISTELMÄVIERASAVAIN (user_id, goal_id).
-- Tavallinen vierasavain sallisi ristiinkiinnityksen: vierasavaimen
-- tarkistus EI kulje RLS:n läpi, joten käyttäjä voisi kiinnittää oman
-- välitavoitteensa toisen käyttäjän tavoitteeseen näkemättä sitä.
--
-- Sama koskee `tasks.milestone_id` ja `projects.milestone_id`.
--
-- POISTOSÄÄNTÖ ON `on delete cascade` VÄLITAVOITTEELLE MUTTA
-- `on delete set null (sarake)` VIITTAAJILLE:
--
--   tavoite poistetaan   -> välitavoitteet poistuvat (ne eivät elä ilman)
--   välitavoite poistetaan -> tehtävä säilyy, liitos katkeaa
--
-- Tehtävä on tehty tai tekemättä riippumatta siitä, onko sen
-- tarkistuspiste yhä olemassa.
--
-- Sarakelistasyntaksi `(sarake)` on pakollinen: ilman sitä PostgreSQL
-- nollaa KOKO vierasavaimen, myös `user_id`:n, joka on NOT NULL — ja
-- poisto kaatuisi. Sama vika korjattiin migraatiossa 0004.
--
-- =====================================================================
-- OBJEKTIEN MÄÄRÄ: 38
-- =====================================================================
--
-- KORJATTU 41 -> 38 (todennettu oikealla PostgreSQL 17:llä,
-- tools/pg-rehearsal). Aiempi luku laski osan rajoitteista kahdesti,
-- joten täysin ajetun migraation uudelleenajo ilmoitti "kesken: 38
-- objektia 41:sta" eikä "JO AJETTU" — ja ohjasi palautuspolulle
-- turhaan. goals_status_check EI ole luvussa: se on olemassa jo ennen
-- 0010:aa (0004) ja vain korvataan.
--
--    1  taulu           milestones
--    7  rajoitetta      milestones (6 check + owner_row_key)
--    1  vierasavain     milestones -> goals
--    2  indeksiä        milestones
--    1  liipaisin       milestones
--    4  politiikkaa     milestones
--    7  saraketta       goals
--    2  saraketta       tasks
--    1  sarake          projects
--    2  saraketta       profile
--    2  vierasavainta   tasks/projects -> milestones
--    4  rajoitetta      goals (mittari, yksikkö, pari, säästö)
--    2  rajoitetta      tasks (depends_on)
--    2  rajoitetta      profile
--
-- Luku on käsin laskettu ja sitä käytetään osittaisen ajon
-- tunnistukseen. Nolla = tuore ajo. Mikä tahansa muu luku tarkoittaa,
-- että ajo on tehty tai jäänyt kesken.

begin;

-- ---------------------------------------------------------------------
-- VAIHE 0a: lukitusraja
--
-- TÄMÄ ON TÄRKEÄMPI TÄSSÄ MIGRAATIOSSA KUIN AIEMMISSA.
--
-- ALTER TABLE ottaa goals-, tasks- ja projects-tauluihin ACCESS
-- EXCLUSIVE -lukon. Ne ovat tauluja, joita jokainen sovelluksen
-- käynnistys lukee. Ilman rajaa pitkä lukko jäädyttäisi sovelluksen
-- jokaiselta käyttäjältä siksi aikaa.
--
-- KAIKKI LUKOT KERRALLA, KIINTEÄSSÄ JÄRJESTYKSESSÄ (goals, projects,
-- tasks, profile) ja ENNEN YHTÄKÄÄN MUUTOSTA. Jos sovelluksen pyyntö tai
-- avoin editorin välilehti pitää jotakin näistä tauluista, migraatio
-- odottaa tässä lauseessa enintään lock_timeoutin ja peruuntuu ilman,
-- että mitään on ehditty muuttaa. Ilman tätä goals olisi jo muutettu ja
-- lukittuna, kun migraatio jäisi odottamaan tasks-, projects- tai
-- profile-lukkoa, ja vaihteleva lukitusjärjestys voisi lukkiutua
-- sovelluksen kirjoituksen kanssa. Objektien määrä ei muutu.
-- Harjoiteltu: tools/pg-rehearsal (failure:0010-locks).
-- ---------------------------------------------------------------------
set local lock_timeout = '5s';

lock table public.goals, public.projects, public.tasks, public.profile in access exclusive mode;

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

  -- 2. 0002 on ajettu.
  select count(*) into olemassa
    from information_schema.columns
   where table_schema = 'public' and table_name = 'tasks'
     and column_name in ('description', 'duration_minutes', 'priority',
                         'scheduling_state', 'created_at', 'updated_at');
  if olemassa <> 6 then
    raise exception 'Migraatio 0002 puuttuu: tasks-taulussa on % kuudesta lisasarakkeesta.', olemassa;
  end if;

  -- 3. 0004 on ajettu: goals ja projects ovat olemassa. Tama migraatio
  --    MUUTTAA niita, joten niiden on oltava paikallaan.
  if not exists (
    select 1 from pg_tables where schemaname = 'public' and tablename = 'goals'
  ) then
    raise exception 'Migraatio 0004 puuttuu: taulua public.goals ei ole.';
  end if;

  if not exists (
    select 1 from pg_tables where schemaname = 'public' and tablename = 'projects'
  ) then
    raise exception 'Migraatio 0004 puuttuu: taulua public.projects ei ole.';
  end if;

  -- 4. goals-taulussa on omistajan rivin avain. Yhdistelmavierasavain
  --    valitavoitteesta tavoitteeseen VAATII sen kohteeltaan.
  if not exists (
    select 1 from pg_constraint where conname = 'goals_owner_row_key'
  ) then
    raise exception 'goals_owner_row_key puuttuu. Yhdistelmavierasavainta ei voi luoda.';
  end if;

  -- 5. PostgreSQL 15 tai uudempi.
  --
  --    `on delete set null (sarake)` rajaa nollauksen yhteen
  --    sarakkeeseen. Ilman sarakelistaa PostgreSQL nollaisi KOKO
  --    vierasavaimen, myos NOT NULL -sarakkeen user_id, ja
  --    valitavoitteen poisto kaatuisi aina.
  --
  --    Sarakelista tuli PostgreSQL 15:ssa. Vanhemmalla palvelimella
  --    tama migraatio ei ole vain syntaksivirhe vaan vaarin
  --    kirjoitettu: se pitaisi tehda toisin. Siksi versio tarkistetaan
  --    tassa eika jateta parserin varaan. Sama tarkistus kuin 0004:ssa.
  if current_setting('server_version_num')::int < 150000 then
    raise exception 'PostgreSQL % on liian vanha. Yhdistelmavierasavaimen sarakekohtainen ON DELETE SET NULL vaatii version 15.',
      current_setting('server_version');
  end if;

  -- 6. Olen oikeassa tietokannassa.
  if not exists (select 1 from auth.users where id = omistaja) then
    raise exception 'Hyvaksyttya omistajaa % ei loydy auth.users-taulusta. Vaara projekti?', omistaja;
  end if;

  -- 7. OSITTAISEN TAI AIEMMAN AJON TUNNISTUS — 38 objektia.
  select count(*) into olemassa from (
    select 1 from pg_tables
      where schemaname = 'public' and tablename = 'milestones'
    union all
    select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'goals'
        and column_name in ('metric', 'unit', 'baseline_value', 'current_value',
                            'target_value', 'measured_on', 'savings_goal_id')
    union all
    select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'tasks'
        and column_name in ('milestone_id', 'depends_on')
    union all
    select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'projects'
        and column_name in ('milestone_id')
    union all
    select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'profile'
        and column_name in ('automation_level', 'planning_buffer_ratio')
    union all
    select 1 from pg_constraint
      where conname in ('milestones_status_check',
                        'milestones_rule_check',
                        'milestones_title_check',
                        'milestones_reached_date_check',
                        'milestones_order_check',
                        'milestones_description_length_check',
                        'milestones_goal_fkey',
                        'milestones_owner_row_key',
                        'goals_metric_pair_check',
                        'goals_savings_exclusive_check',
                        'goals_metric_length_check',
                        'goals_unit_length_check',
                        'tasks_depends_on_length_check',
                        'tasks_depends_on_no_self_check',
                        'tasks_milestone_fkey',
                        'projects_milestone_fkey',
                        'profile_automation_level_check',
                        'profile_buffer_ratio_check')
    union all
    select 1 from pg_indexes
      where schemaname = 'public'
        and indexname in ('milestones_user_goal_idx', 'milestones_user_target_idx')
    union all
    select 1 from pg_trigger
      where not tgisinternal and tgname = 'milestones_touch_updated_at'
    union all
    select 1 from pg_policies
      where schemaname = 'public' and tablename = 'milestones'
  ) kaikki;

  if olemassa = 38 then
    raise exception 'Migraatio 0010 on JO AJETTU. Ala aja uudelleen — aja supabase/verify/verify_0010.sql.';
  end if;

  if olemassa > 0 then
    select string_agg(nimi, ', ' order by nimi) into nimet from (
      select tablename::text as nimi from pg_tables
        where schemaname = 'public' and tablename = 'milestones'
      union all
      select table_name || '.' || column_name from information_schema.columns
        where table_schema = 'public'
          and ((table_name = 'goals' and column_name in
                ('metric', 'unit', 'baseline_value', 'current_value',
                 'target_value', 'measured_on', 'savings_goal_id'))
            or (table_name = 'tasks' and column_name in ('milestone_id', 'depends_on'))
            or (table_name = 'projects' and column_name = 'milestone_id')
            or (table_name = 'profile' and column_name in
                ('automation_level', 'planning_buffer_ratio')))
      union all
      select conname::text from pg_constraint
        where conname in ('milestones_status_check',
                          'milestones_rule_check',
                          'milestones_title_check',
                          'milestones_reached_date_check',
                          'milestones_order_check',
                          'milestones_description_length_check',
                          'milestones_goal_fkey',
                          'milestones_owner_row_key',
                          'goals_metric_pair_check',
                          'goals_savings_exclusive_check',
                          'goals_metric_length_check',
                          'goals_unit_length_check',
                          'tasks_depends_on_length_check',
                          'tasks_depends_on_no_self_check',
                          'tasks_milestone_fkey',
                          'projects_milestone_fkey',
                          'profile_automation_level_check',
                          'profile_buffer_ratio_check')
      union all
      select indexname::text from pg_indexes
        where schemaname = 'public'
          and indexname in ('milestones_user_goal_idx', 'milestones_user_target_idx')
      union all
      select tgname::text from pg_trigger
        where not tgisinternal and tgname = 'milestones_touch_updated_at'
      union all
      select policyname::text from pg_policies
        where schemaname = 'public' and tablename = 'milestones'
    ) loydetyt;

    raise exception 'Migraatio 0010 on kesken: % objektia 38:sta on jo olemassa (%).',
      olemassa, nimet;
  end if;

  raise notice 'Esiehdot kunnossa. Omistaja %, 0010:n objekteja 0/38.', omistaja;
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
-- VAIHE 0d: OLEMASSA OLEVA DATA KESTÄÄ UUDET RAJOITTEET
--
-- Tämä on se tarkistus, jota aiemmissa migraatioissa ei tarvittu.
-- Uusi CHECK-rajoite validoidaan olemassa olevia rivejä vastaan, ja
-- rikkova rivi peruuttaisi koko migraation.
--
-- Tarkistetaan ETUKÄTEEN ja kerrotaan mikä rivi on ongelma — sen
-- sijaan että annettaisiin PostgreSQL:n kertoa "rajoiterikkomus"
-- ilman että kukaan tietää missä.
-- ---------------------------------------------------------------------
do $$
declare
  n integer;
begin
  -- goals: tila on yksi viidesta nykyisesta arvosta. Jos taalla on jo
  -- jotain muuta, `goals_status_check` on jo rikki eika tama migraatio
  -- ole sen paikka.
  select count(*) into n from public.goals
   where status not in ('active', 'paused', 'completed', 'abandoned', 'archived');
  if n > 0 then
    raise exception 'goals-taulussa on % rivia tuntemattomalla tilalla. Selvita ne ensin.', n;
  end if;

  raise notice 'Olemassa oleva data kestaa uudet rajoitteet.';
end $$;

-- ---------------------------------------------------------------------
-- VAIHE 1: milestones
-- ---------------------------------------------------------------------

create table public.milestones (
  id            text primary key,
  user_id       uuid not null default auth.uid()
                references auth.users(id) on delete cascade,

  -- VÄLITAVOITE EI ELÄ ILMAN TAVOITETTA. Siksi NOT NULL ja cascade.
  goal_id       text not null,

  title         text not null,
  description   text,

  -- Päivä johon mennessä pitäisi saavuttaa. Vapaaehtoinen: käyttäjä voi
  -- tietää järjestyksen ennen kuin tietää päivät.
  target_date   date,

  -- open | reached | skipped
  status        text not null default 'open',

  -- Paikka jonossa. EI välttämättä tiheä: poisto jättää aukon, ja
  -- aukon täyttäminen olisi kirjoitus jokaiseen riviin ilman hyötyä.
  order_index   integer not null default 0,

  -- manual | projects_done | tasks_done
  rule          text not null default 'manual',

  -- Milloin saavutettiin. Tila ja päivä kulkevat yhdessä.
  reached_date  date,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

alter table public.milestones
  add constraint milestones_status_check
  check (status in ('open', 'reached', 'skipped'));

alter table public.milestones
  add constraint milestones_rule_check
  check (rule in ('manual', 'projects_done', 'tasks_done'));

alter table public.milestones
  add constraint milestones_title_check
  check (length(btrim(title)) > 0 and length(title) <= 200);

alter table public.milestones
  add constraint milestones_description_length_check
  check (description is null or length(description) <= 2000);

-- SAAVUTETTU ILMAN PÄIVÄÄ ON TIETO JOKA EI KERRO MILLOIN.
-- Sama sääntö kuin maksetulla laskulla migraatiossa 0007.
alter table public.milestones
  add constraint milestones_reached_date_check
  check ((status = 'reached' and reached_date is not null)
      or (status <> 'reached' and reached_date is null));

alter table public.milestones
  add constraint milestones_order_check
  check (order_index >= 0 and order_index <= 999);

alter table public.milestones
  add constraint milestones_owner_row_key unique (user_id, id);

-- YHDISTELMÄVIERASAVAIN. Ks. tiedoston alku.
alter table public.milestones
  add constraint milestones_goal_fkey
  foreign key (user_id, goal_id) references public.goals (user_id, id)
  on delete cascade;

create index milestones_user_goal_idx
  on public.milestones (user_id, goal_id, order_index);

create index milestones_user_target_idx
  on public.milestones (user_id, target_date);

alter table public.milestones enable row level security;

create policy milestones_select_own on public.milestones
  for select to authenticated using (auth.uid() = user_id);
create policy milestones_insert_own on public.milestones
  for insert to authenticated with check (auth.uid() = user_id);
create policy milestones_update_own on public.milestones
  for update to authenticated using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
create policy milestones_delete_own on public.milestones
  for delete to authenticated using (auth.uid() = user_id);

-- ROOLI PUBLIC TARKOITTAA "KAIKKI ROOLIT", ja sille myönnetyn oikeuden
-- perii jokainen rooli — myös anon. Nollaus kaikille kolmelle ennen
-- myöntämistä.
revoke all on public.milestones from public;
revoke all on public.milestones from anon;
revoke all on public.milestones from authenticated;
grant select, insert, update, delete on public.milestones to authenticated;

create trigger milestones_touch_updated_at
  before update on public.milestones
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------
-- VAIHE 2: goals — mittari, säästökytkentä ja ylläpitotila
--
-- ⚠ TÄSSÄ MUUTETAAN TAULUA, JOSSA ON KÄYTTÄJÄN DATAA.
-- ---------------------------------------------------------------------

-- Kaikki uudet sarakkeet NULLABLE. Olemassa olevat tavoitteet pysyvät
-- kelvollisina eikä täyttöä tarvita: vanhalla tavoitteella ei ole
-- mittaria, ja NULL on oikea vastaus siihen.
alter table public.goals add column metric text;
alter table public.goals add column unit text;

-- MITTARI EI OLE RAHAA eikä sitä pidetä sentteinä: paino on 82,4 kg ja
-- matka 12,5 km. Rahatavoitteet kulkevat savings_goal_id:n kautta
-- Talouteen, jossa summat ovat kokonaislukuja sentteinä.
alter table public.goals add column baseline_value numeric(20, 4);
alter table public.goals add column current_value  numeric(20, 4);
alter table public.goals add column target_value   numeric(20, 4);
alter table public.goals add column measured_on    date;

-- Kytkentä säästötavoitteeseen. YHDISTELMÄVIERASAVAINTA EI OLE:
-- savings_goals-taulu on olemassa (0007) mutta sen PORTTI ON KIINNI
-- tuotannossa, eikä vierasavain tauluun jota sovellus ei käytä toisi
-- suojaa vaan esteen. Kytkentä valvotaan sovelluksessa, ja RLS rajaa
-- molemmat päät erikseen.
--
-- Jos savings_goals-portti joskus avataan, tämän voi kovettaa
-- yhdistelmävierasavaimeksi omassa migraatiossaan.
alter table public.goals add column savings_goal_id text;

alter table public.goals
  add constraint goals_metric_length_check
  check (metric is null or length(metric) <= 60);

alter table public.goals
  add constraint goals_unit_length_check
  check (unit is null or length(unit) <= 20);

-- MITTARI ILMAN NIMEÄ ON LUKU ILMAN MERKITYSTÄ.
alter table public.goals
  add constraint goals_metric_pair_check
  check (target_value is null or metric is not null);

-- KAKSI LUKUA SAMASTA ASIASTA ERKANEE.
-- Säästötavoitteeseen kytketty tavoite saa lukunsa Taloudesta.
alter table public.goals
  add constraint goals_savings_exclusive_check
  check (savings_goal_id is null or target_value is null);

-- ⚠ RAJOITTEEN KORVAAMINEN ⚠
--
-- Tässä taulu on hetken ilman tilarajoitetta. Se tapahtuu saman
-- transaktion sisällä, joten muut istunnot eivät näe välitilaa, ja
-- keskeytynyt ajo perutaan KOKONAAN: rajoite palaa ennalleen
-- (harjoiteltu: virhe injektoitu tämän vaihdon jälkeen,
-- tools/pg-rehearsal failure:0010-locks). Vain osittain — valintana
-- ilman begin/commitia — ajettu tiedosto voi jättää taulun ilman
-- rajoitetta; preflight_0010 rivi 09 ja verify_0010 rivi 20 havaitsevat
-- sen. Vaihe 5 tarkistaa rajoitteen olemassaolon vielä ennen committia.
--
-- Vaihe 0d on todennut, ettei yksikään olemassa oleva rivi riko uutta
-- rajoitetta. Uusi arvo `maintenance` on lisäys, ei poisto: jokainen
-- vanha arvo kelpaa yhä.
alter table public.goals drop constraint goals_status_check;

alter table public.goals
  add constraint goals_status_check
  check (status in ('active', 'paused', 'maintenance', 'completed',
                    'abandoned', 'archived'));

-- ---------------------------------------------------------------------
-- VAIHE 3: tasks ja projects — välitavoite ja riippuvuudet
--
-- ⚠ TÄSSÄ MUUTETAAN TAULUJA, JOISSA ON KÄYTTÄJÄN DATAA.
-- ---------------------------------------------------------------------

alter table public.tasks add column milestone_id text;

-- Riippuvuudet tunnistelistana. Ks. tiedoston alun perustelu sille,
-- miksi tämä ei ole liitostaulu.
alter table public.tasks add column depends_on text[] not null default '{}';

alter table public.tasks
  add constraint tasks_depends_on_length_check
  check (array_length(depends_on, 1) is null or array_length(depends_on, 1) <= 10);

-- TEHTÄVÄ EI VOI RIIPPUA ITSESTÄÄN. Se ei ole mahdoton vaan mahdoton
-- tulkita, ja se kaataisi topologisen järjestyksen aikatauluttajassa.
alter table public.tasks
  add constraint tasks_depends_on_no_self_check
  check (not (id = any(depends_on)));

alter table public.projects add column milestone_id text;

-- VÄLITAVOITTEEN POISTO EI POISTA TYÖTÄ.
--
-- Sarakelistasyntaksi `(milestone_id)` on pakollinen: ilman sitä
-- PostgreSQL nollaa koko vierasavaimen, myös NOT NULL -sarakkeen
-- user_id, ja poisto kaatuisi. Sama vika korjattiin 0004:ssä.
alter table public.tasks
  add constraint tasks_milestone_fkey
  foreign key (user_id, milestone_id) references public.milestones (user_id, id)
  on delete set null (milestone_id);

alter table public.projects
  add constraint projects_milestone_fkey
  foreign key (user_id, milestone_id) references public.milestones (user_id, id)
  on delete set null (milestone_id);

-- ---------------------------------------------------------------------
-- VAIHE 4: profile — automaatiotaso
--
-- Automaatiotaso on TILIKOHTAINEN eikä laitekohtainen: se koskee
-- käyttäjää, ei selainta. Sovellus säilyttää sitä toistaiseksi
-- laitekohtaisesti (src/data/preferences.js) ja siirtyy tähän
-- sarakkeeseen kun portti avataan.
--
-- OLETUS ON VAROVAISIN. Rivi, jolle ei ole valittu tasoa, saa tason 1.
-- ---------------------------------------------------------------------

alter table public.profile add column automation_level smallint not null default 1;
alter table public.profile add column planning_buffer_ratio numeric(3, 2) not null default 0.25;

alter table public.profile
  add constraint profile_automation_level_check
  check (automation_level between 1 and 4);

alter table public.profile
  add constraint profile_buffer_ratio_check
  check (planning_buffer_ratio >= 0 and planning_buffer_ratio <= 0.9);

-- ---------------------------------------------------------------------
-- VAIHE 5: invarianttien todistus ENNEN COMMITTIA
-- ---------------------------------------------------------------------

do $$
declare
  n integer;
begin
  select count(*) into n from pg_policies
   where schemaname = 'public' and tablename = 'milestones';
  if n <> 4 then
    raise exception 'Odotettiin 4 politiikkaa, loytyi %.', n;
  end if;

  select count(*) into n from pg_class
   where relnamespace = 'public'::regnamespace
     and relname = 'milestones' and relrowsecurity;
  if n <> 1 then
    raise exception 'RLS ei ole paalla milestones-taulussa.';
  end if;

  -- TILARAJOITE ON PAIKALLAAN. Tama on se tarkistus, joka havaitsee
  -- pudotuksen ja uudelleenluonnin valiin jaaneen aukon.
  if not exists (
    select 1 from pg_constraint where conname = 'goals_status_check'
  ) then
    raise exception 'goals_status_check puuttuu! Taulu jai ilman tilarajoitetta.';
  end if;

  -- Ja se sallii uuden arvon.
  if not exists (
    select 1 from pg_constraint
     where conname = 'goals_status_check'
       and pg_get_constraintdef(oid) like '%maintenance%'
  ) then
    raise exception 'goals_status_check ei salli arvoa maintenance.';
  end if;

  -- Yhdistelmavierasavaimet ovat paikallaan ja osoittavat oikein.
  select count(*) into n from pg_constraint
   where conname in ('milestones_goal_fkey', 'tasks_milestone_fkey',
                     'projects_milestone_fkey')
     and contype = 'f';
  if n <> 3 then
    raise exception 'Odotettiin 3 vierasavainta, loytyi %.', n;
  end if;

  -- POISTOSAANTO ON SET NULL SARAKELISTALLA, EI KOKO AVAIMELLE.
  select count(*) into n from pg_constraint
   where conname in ('tasks_milestone_fkey', 'projects_milestone_fkey')
     and confdeltype = 'n'
     and array_length(confdelsetcols, 1) = 1;
  if n <> 2 then
    raise exception 'Poistosaanto ei rajaa nollausta sarakkeeseen. Poisto kaatuisi.';
  end if;

  -- PUBLIC-ROOLIN OIKEUDET LUETAAN SUORAAN ACL:STA.
  select count(*) into n
    from pg_class c,
         lateral aclexplode(c.relacl) a
   where c.relnamespace = 'public'::regnamespace
     and c.relname = 'milestones'
     and a.grantee = 0;
  if n <> 0 then
    raise exception 'PUBLIC-roolilla on % oikeutta milestones-tauluun.', n;
  end if;

  if has_table_privilege('anon', 'public.milestones', 'select') then
    raise exception 'anon-roolilla on lukuoikeus milestones-tauluun.';
  end if;

  if not has_table_privilege('authenticated', 'public.milestones', 'select') then
    raise exception 'authenticated-roolilta puuttuu lukuoikeus milestones-tauluun.';
  end if;

  -- Uudet sarakkeet ovat paikallaan.
  select count(*) into n from information_schema.columns
   where table_schema = 'public'
     and ((table_name = 'goals' and column_name in
           ('metric', 'unit', 'baseline_value', 'current_value',
            'target_value', 'measured_on', 'savings_goal_id'))
       or (table_name = 'tasks' and column_name in ('milestone_id', 'depends_on'))
       or (table_name = 'projects' and column_name = 'milestone_id')
       or (table_name = 'profile' and column_name in
           ('automation_level', 'planning_buffer_ratio')));
  if n <> 12 then
    raise exception 'Odotettiin 12 uutta saraketta, loytyi %.', n;
  end if;

  -- Vanhat rivit ovat yha kelvollisia.
  select count(*) into n from public.goals
   where status not in ('active', 'paused', 'maintenance', 'completed',
                        'abandoned', 'archived');
  if n > 0 then
    raise exception 'goals-taulussa on % kelvotonta riviä migraation jalkeen.', n;
  end if;

  raise notice 'Migraatio 0010 valmis. Aja seuraavaksi supabase/verify/verify_0010.sql.';
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
--   2. VARMUUSKOPIO — tämä on ensimmäinen migraatio, joka muuttaa
--      tauluja joissa on käyttäjän dataa. Varmuuskopio ei ole
--      muodollisuus.
--   3. Vain lukeva esitarkistus (alla)
--   4. Ajo postgres-roolilla Supabasen SQL-editorissa
--   5. supabase/verify/verify_0010.sql
--
-- ESITARKISTUS (vain lukeva, turvallinen ajaa milloin tahansa):
--
--   select
--     (select count(*) from pg_tables
--       where schemaname='public' and tablename='milestones') as milestones_on,
--     (select count(*) from information_schema.columns
--       where table_schema='public' and table_name='goals'
--         and column_name in ('metric','unit','baseline_value','current_value',
--                             'target_value','measured_on','savings_goal_id'))
--       as goals_uudet_sarakkeet,
--     (select count(*) from information_schema.columns
--       where table_schema='public' and table_name='tasks'
--         and column_name in ('milestone_id','depends_on')) as tasks_uudet_sarakkeet,
--     (select count(*) from public.goals) as tavoitteita,
--     (select count(*) from public.projects) as projekteja,
--     (select count(*) from public.tasks) as tehtavia,
--     (select count(*) from public.goals
--       where status not in ('active','paused','completed','abandoned','archived'))
--       as kelvottomia_tiloja,
--     (select count(*) from pg_constraint where conname='goals_owner_row_key')
--       as omistajan_avain;
--
--   Odotus ennen ajoa: 0, 0, 0, <n>, <n>, <n>, 0, 1
--
--   JOS `kelvottomia_tiloja` EI OLE 0: älä aja. Selvitä ne rivit ensin.
--   JOS `omistajan_avain` EI OLE 1: älä aja. Vierasavainta ei voi luoda.
--
-- =====================================================================
-- VAIKUTUS OLEMASSA OLEVAAN DATAAN
-- =====================================================================
--
--   milestones   uusi taulu, tyhja
--   goals        SEITSEMAN UUTTA NULLABLE-SARAKETTA + tilarajoite korvattu
--   tasks        KAKSI UUTTA SARAKETTA (depends_on saa oletuksen '{}')
--   projects     YKSI UUSI NULLABLE-SARAKE
--   profile      KAKSI UUTTA SARAKETTA OLETUSARVOLLA
--
-- Olemassa olevia rivejä EI muuteta sisällöllisesti. Täyttöä ei tehdä.
-- Yhtään riviä ei poisteta, yhtään saraketta ei pudoteta, yhdenkään
-- sarakkeen tyyppiä ei muuteta.
--
-- HUOM. `tasks.depends_on` ja `profile.automation_level` ovat NOT NULL
-- oletusarvolla. PostgreSQL 11:stä lähtien se ei kirjoita taulua
-- uudelleen — oletus tallennetaan katalogiin ja luetaan vanhoille
-- riveille lennossa.
--
-- =====================================================================
-- ROLLBACK
-- =====================================================================
--
-- PERUUTUS AINA KÄÄNTEISESSÄ JÄRJESTYKSESSÄ: 0013 -> 0012 -> 0011 ->
-- 0010. Ennen tätä peruutusta 0011 on peruttu (tai ajamatta).
--
--   begin;
--   set local lock_timeout = '5s';
--
--   -- VARTIJA: ylläpitotilassa oleva tavoite ei mahdu vanhaan
--   -- tilarajoitteeseen. Pysähdytään heti ja kerrotaan mitä tehdä,
--   -- ennen kuin mitään on pudotettu.
--   do $$
--   declare
--     n integer;
--   begin
--     select count(*) into n from public.goals where status = 'maintenance';
--     if n > 0 then
--       raise exception 'Peruutus keskeytetty: % tavoitetta on tilassa maintenance. Paata ensin niiden tila, esim. update public.goals set status = ''active'' where status = ''maintenance''; ja aja peruutus sitten uudelleen.', n;
--     end if;
--   end $$;
--
--   alter table public.tasks drop constraint tasks_milestone_fkey;
--   alter table public.projects drop constraint projects_milestone_fkey;
--   drop table public.milestones;
--
--   alter table public.tasks drop constraint tasks_depends_on_length_check;
--   alter table public.tasks drop constraint tasks_depends_on_no_self_check;
--   alter table public.tasks drop column milestone_id;
--   alter table public.tasks drop column depends_on;
--   alter table public.projects drop column milestone_id;
--
--   alter table public.goals drop constraint goals_metric_pair_check;
--   alter table public.goals drop constraint goals_savings_exclusive_check;
--   alter table public.goals drop constraint goals_metric_length_check;
--   alter table public.goals drop constraint goals_unit_length_check;
--   alter table public.goals drop column metric;
--   alter table public.goals drop column unit;
--   alter table public.goals drop column baseline_value;
--   alter table public.goals drop column current_value;
--   alter table public.goals drop column target_value;
--   alter table public.goals drop column measured_on;
--   alter table public.goals drop column savings_goal_id;
--
--   -- TILARAJOITE PALAUTETAAN. Tama EPAONNISTUU, jos yksikin tavoite on
--   -- ehtinyt tilaan 'maintenance'. Se on tarkoitus: peruutus ei saa
--   -- hiljaa hylata kayttajan tekemaa valintaa.
--   --
--   -- Jos nain kay, paata ensin mihin tilaan ne rivit siirretaan:
--   --   update public.goals set status='active' where status='maintenance';
--   alter table public.goals drop constraint goals_status_check;
--   alter table public.goals
--     add constraint goals_status_check
--     check (status in ('active','paused','completed','abandoned','archived'));
--
--   alter table public.profile drop constraint profile_automation_level_check;
--   alter table public.profile drop constraint profile_buffer_ratio_check;
--   alter table public.profile drop column automation_level;
--   alter table public.profile drop column planning_buffer_ratio;
--
--   commit;
--
-- HUOM. Peruutus POISTAA milestones-taulun rivit pysyvästi ja
-- NOLLAA tehtävien riippuvuudet. Sulje portit ensin ja ota
-- varmuuskopio.
--
-- Muista tällöin myös:
--   src/data/schema.js -> TABLES.milestones      = false
--                         GOAL_PLANNING_FIELDS   = false
--                         GOAL_MAINTENANCE_MODE  = false
--
-- =====================================================================
-- RISKIT
-- =====================================================================
--
--   MATALA   milestones -- uusi taulu, ei koske olemassa olevaan dataan
--   MATALA   uudet nullable-sarakkeet, ei täyttöä
--   MATALA   NOT NULL + DEFAULT ei kirjoita taulua uudelleen (PG11+)
--   KESKI    lukitus: goals, projects, tasks ja profile lukitaan
--            kerralla vaiheessa 0a (kiinteä järjestys) ajon ajaksi.
--            Taulut ovat pieniä, mutta ne ovat myös ne, joita jokainen
--            sovelluksen käynnistys lukee. Harjoitus: sovelluksen luku
--            odottaa enintään lock_timeoutin verran.
--   KORKEA   `goals_status_check` PUDOTETAAN JA LUODAAN UUDELLEEN.
--            Transaktion sisällä muut istunnot eivät näe välitilaa, ja
--            keskeytynyt ajo perutaan kokonaan (rajoite palaa). Vain
--            valintana ilman begin/commitia ajettu tiedosto voisi jättää
--            taulun ilman tilarajoitetta: aja AINA koko tiedosto.
--            Vaihe 5 tarkistaa sen ennen committia, preflight_0010 rivi
--            09 ennen ajoa ja verify_0010.sql rivi 20 ajon jälkeen.
--
-- Ajon kesto on käytännössä välitön: milestones on tyhjä, ja
-- muutettavissa tauluissa on kymmeniä rivejä.
