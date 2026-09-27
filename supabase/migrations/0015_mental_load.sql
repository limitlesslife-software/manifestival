-- =====================================================================
-- Manifestival — migraatio 0015: mielen kuorman keventäminen
-- =====================================================================
--
-- TILA: EI AJETTU TUOTANTOON. EI HYVÄKSYTTY.
--
-- TÄMÄ ON SUUNNITELMA, EI SUORITUSKÄSKY.
--
-- RIIPPUU MIGRAATIOSTA 0014 (ei ajettu). 0015 ajetaan vasta 0014:n ja
-- sen varmistuksen (supabase/verify/verify_0014.sql) jälkeen. Julkaisu-
-- aalto L (välimuisti v25) avaa tämän migraation portit.
-- Sopimus: docs/MENTAL-LOAD-CORE.md.
--
-- =====================================================================
-- ⚠ TÄMÄ MIGRAATIO MUUTTAA TUOTANNOSSA AUKI OLEVAA TAULUA ⚠
-- =====================================================================
--
-- Toisin kuin 0014, tämä migraatio EI vain luo uusia tauluja. Se
-- MUUTTAA KAHTA OLEMASSA OLEVAA TAULUA:
--
--   tasks        migraatio 0001/0002 ajettu, portti auki, käyttäjän dataa
--   life_areas   migraatio 0012 (aalto I)
--
-- Konkreettisesti:
--
--   1. ALTER TABLE ottaa ACCESS EXCLUSIVE -lukon. Jokainen tehtävän luku
--      ja kirjoitus odottaa sen ajan. Molemmat taulut lukitaan KERRALLA
--      vaiheessa 0c ennen yhtäkään muutosta; `lock_timeout` rajaa
--      odotuksen viiteen sekuntiin.
--
--   2. Uudet CHECK-rajoitteet validoidaan OLEMASSA OLEVIA RIVEJÄ
--      vastaan. Kaikki uudet sarakkeet ovat NULL tai saavat oletuksen
--      (reschedule_count = 0, kind = 'STANDARD'), joten yksikään
--      olemassa oleva rivi ei voi rikkoa niitä. Vaihe 0e todistaa sen
--      silti ennen muutoksia.
--
--   3. EI TAULUN UUDELLEENKIRJOITUSTA. `add column ... default <vakio>`
--      on PostgreSQL 11:stä lähtien pelkkä katalogimuutos; yksikään
--      olemassa oleva rivi ei saa uutta versiota (xmin) eikä taulu uutta
--      tiedostoa (relfilenode). Harjoiteltu: tools/pg-rehearsal.
--
--   4. `life_areas_category_unique` POISTETAAN (omistajan päätös 1:
--      useampi alue saa jakaa kategorian). Rajoitteen poisto ei koske
--      yhteenkään riviin. Tilalle ei-uniikki indeksi.
--
--   5. `tasks.date` MENETTÄÄ NOT NULL -EHDON, jos sillä sellainen on
--      (päivätön tehtävä, omistajan päätös 2). Lause on idempotentti:
--      jos sarake on jo nullable (harjoittelun lähtötila), se ei tee
--      mitään. Tuotannon alkuperäinen tila kirjataan esitarkistuksessa
--      (preflight_0015 "tasks.date NOT NULL ennen 0015:tä") — peruutus
--      palauttaa ehdon VAIN, jos se oli olemassa (ks.
--      docs/MIGRATION-0015-RECOVERY.md).
--
-- =====================================================================
-- MITÄ TÄMÄ LISÄÄ
-- =====================================================================
--
--   public.life_areas         MUUTOS   kind (alueen laji, 6 arvoa),
--                                      kategoria ei enää uniikki
--   public.tasks              MUUTOS   horizon, waiting_on, follow_up_date,
--                                      archived_at, reschedule_count,
--                                      original_date; date nullable
--   public.protected_periods  uusi     suojattu aika: oma aika, vapaa-ajan
--                                      säännöt ja loma YHTENÄ mallina
--   public.weekly_plans       uusi     viikkosuunnitelma (sunnuntain
--                                      nollaus): enintään 5 prioriteettia
--
-- =====================================================================
-- MITÄ TÄMÄ EI LISÄÄ — EIKÄ SAA LISÄTÄ
-- =====================================================================
--
-- ASIAN LUONNETTA EI TALLENNETA. OBLIGATION, GOAL_ACTION, MAINTENANCE,
-- WELLBEING, ENJOYMENT ja FREE_TIME JOHDETAAN (src/domain/itemNature.js).
-- Ohitussaraketta ei lisätä ennen kuin tarve on todettu.
--
-- ARKISTOINTI EI OLE HORISONTTI. `archived_at` on oma sarakkeensa;
-- horizon ei saa arvoa 'ARCHIVED'. Näin arkistoitu asia muistaa, missä
-- horisontissa se oli.
--
-- ODOTTAVALLE EI TULE YHTEYSTIETOJÄRJESTELMÄÄ. `waiting_on` on vapaa
-- teksti (1–200 merkkiä), ei viite ihmiseen.
--
-- VIIKON PRIORITEETTI EI OLE VIERASAVAIN. `weekly_plans.priorities` on
-- jsonb-taulukko viittauksia ('task:<id>' …) tai tekstiä. Poistettu
-- kohde ei vie viikon suunnitelmaa mukanaan, se vain lakkaa osumasta.
-- Viittaus ei ohita RLS:ää: sovellus ratkaisee sen vain käyttäjän omista
-- riveistä, ja toisen käyttäjän tunniste on pelkkä merkkijono.
--
-- EI UUSIA VIERASAVAIMIA sovellustauluihin. Ainoat vierasavaimet ovat
-- uusien taulujen omistajasarakkeet (auth.users, on delete cascade).
--
-- EI MUUTOKSIA goals-, projects-, routines- TAI 0013/0014:n TAULUIHIN.
-- EI MUUTOKSIA olemassa oleviin politiikkoihin tai oikeuksiin.
--
-- =====================================================================
-- OMISTAJUUS
-- =====================================================================
--
-- Molemmat uudet taulut saavat `owner_row_key`-avaimen (user_id, id)
-- ja RLS:n neljällä omalla politiikalla (`to authenticated`,
-- `auth.uid() = user_id`; muokkaus rajataan sekä USING- että WITH CHECK
-- -puolelta, joten riviä ei voi siirtää toisen käyttäjän nimiin).
-- anon- ja PUBLIC-rooleilla ei ole mitään oikeutta.
--
-- tasks- ja life_areas-taulujen uudet sarakkeet kuuluvat rivin
-- omistajalle olemassa olevien politiikkojen kautta; ne eivät muutu.
--
-- =====================================================================
-- OBJEKTIEN MÄÄRÄ: 47
-- =====================================================================
--
--     2  taulua          protected_periods, weekly_plans
--     7  saraketta       tasks (6), life_areas (1: kind)
--    26  rajoitetta      life_areas 1 CHECK;
--                        tasks 4 CHECK;
--                        protected_periods 14 CHECK + owner_row_key;
--                        weekly_plans 4 CHECK + week_unique + owner_row_key
--     2  indeksiä        life_areas_user_category_idx,
--                        protected_periods_user_active_idx
--     2  liipaisinta     updated_at
--     8  politiikkaa     (2 x 4)
--
-- Luku on käsin laskettu ja sitä käytetään osittaisen ajon
-- tunnistukseen. Nolla = tuore ajo. Mikä tahansa muu luku tarkoittaa,
-- että ajo on tehty tai jäänyt kesken — eikä kumpaakaan korjata
-- ajamalla uudelleen.
--
-- Luvussa EIVÄT ole: pääavaimet ja omistajasarakkeiden vierasavaimet
-- (automaattiset nimet, kuten 0014:ssä), poistettava
-- `life_areas_category_unique` (sen PUUTTUMINEN ei ole objekti) eikä
-- `tasks.date`-sarakkeen nullable-tila (idempotentti, voi olla jo
-- valmiiksi nullable).
--
-- HUOM. INVENTAARIO: 0015 poistaa yhden 0012:n objektin
-- (life_areas_category_unique). Täysin ajetun 0015:n jälkeen 0012:n
-- tunnistus laskee siksi 57 eikä 58; score-inventory tietää tämän
-- (SUPERSEDED_OBJECTS).

begin;

-- ---------------------------------------------------------------------
-- VAIHE 0a: lukitusraja
--
-- ALTER TABLE ottaa tasks- ja life_areas-tauluihin ACCESS EXCLUSIVE
-- -lukon, ja uusien taulujen vierasavaimet auth.users-tauluun SHARE ROW
-- EXCLUSIVE -lukon. 5 s per lukon odotus (lock_timeout koskee jokaista
-- lukkoa erikseen).
-- ---------------------------------------------------------------------
set local lock_timeout = '5s';

-- ---------------------------------------------------------------------
-- VAIHE 0b: esiehdot ja uudelleenajon tunnistus — VAIN KATALOGI
--
-- Nämä tarkistukset lukevat vain järjestelmäkatalogia. Ne eivät lue
-- yhdenkään taulun rivejä eivätkä odota tasks- tai life_areas-taulun
-- lukkoa. Siksi ne ajetaan ENNEN lukitusta (vaihe 0c): jo ajettu
-- migraatio ("JO AJETTU"), kesken jäänyt ajo ja puuttuva edeltäjä
-- kerrotaan heti ja oikealla syyllä, vaikka sovellus pitäisi tasks-
-- taulua. Sama järjestys kuin 0010:ssä (failure:0010-locks).
-- ---------------------------------------------------------------------
do $$
declare
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

  -- 1. 0014 on ajettu: sen kymmenen taulua ovat olemassa. Juna etenee
  --    jarjestyksessa; 0015 ei ohita yhtakaan aiempaa migraatiota.
  if (select count(*) from pg_tables
       where schemaname = 'public'
         and tablename in ('saved_places', 'place_aliases', 'calendar_events',
                           'commute_observations', 'life_settings', 'sleep_logs',
                           'habit_plans', 'habit_events', 'exercise_sessions',
                           'wellbeing_checkins')) <> 10 then
    raise exception 'Migraatio 0014 pitaa ajaa ensin: jokin sen kymmenesta taulusta puuttuu.';
  end if;

  -- 2. 0012 on ajettu: life_areas on olemassa (saa kind-sarakkeen).
  if not exists (
    select 1 from pg_tables where schemaname = 'public' and tablename = 'life_areas'
  ) then
    raise exception 'Migraatio 0012 puuttuu: taulua public.life_areas ei ole.';
  end if;

  -- 3. PostgreSQL 15 tai uudempi (sama lattia kuin 0010–0014).
  if current_setting('server_version_num')::int < 150000 then
    raise exception 'PostgreSQL % on liian vanha (vaatii 15).', current_setting('server_version');
  end if;

  -- 4. OSITTAISEN TAI AIEMMAN AJON TUNNISTUS — 47 objektia.
  select count(*) into olemassa from (
    select 1 from pg_tables
      where schemaname = 'public'
        and tablename in ('protected_periods', 'weekly_plans')
    union all
    select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'tasks'
        and column_name in ('horizon', 'waiting_on', 'follow_up_date', 'archived_at',
                            'reschedule_count', 'original_date')
    union all
    select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'life_areas'
        and column_name in ('kind')
    union all
    select 1 from pg_constraint
      where conname in (
        'life_areas_kind_check',
        'tasks_horizon_check', 'tasks_waiting_on_check', 'tasks_reschedule_count_check',
        'tasks_waiting_on_horizon_check',
        'protected_periods_kind_check', 'protected_periods_recurrence_check',
        'protected_periods_title_check', 'protected_periods_note_check',
        'protected_periods_weekdays_check', 'protected_periods_target_check',
        'protected_periods_strength_check', 'protected_periods_dates_check',
        'protected_periods_times_check', 'protected_periods_once_check',
        'protected_periods_weekly_check', 'protected_periods_weekly_target_check',
        'protected_periods_vacation_check', 'protected_periods_span_check',
        'protected_periods_owner_row_key',
        'weekly_plans_week_start_check', 'weekly_plans_priorities_check',
        'weekly_plans_planned_minutes_check', 'weekly_plans_note_check',
        'weekly_plans_week_unique', 'weekly_plans_owner_row_key')
    union all
    select 1 from pg_indexes
      where schemaname = 'public'
        and indexname in ('life_areas_user_category_idx', 'protected_periods_user_active_idx')
    union all
    select 1 from pg_trigger
      where not tgisinternal
        and tgname in ('protected_periods_touch_updated_at', 'weekly_plans_touch_updated_at')
    union all
    select 1 from pg_policies
      where schemaname = 'public'
        and tablename in ('protected_periods', 'weekly_plans')
  ) kaikki;

  if olemassa = 47 then
    raise exception 'Migraatio 0015 on JO AJETTU. Ala aja uudelleen — aja supabase/verify/verify_0015.sql.';
  end if;

  if olemassa > 0 then
    select string_agg(nimi, ', ' order by nimi) into nimet from (
      select tablename::text as nimi from pg_tables
        where schemaname = 'public'
          and tablename in ('protected_periods', 'weekly_plans')
      union all
      select table_name || '.' || column_name from information_schema.columns
        where table_schema = 'public'
          and ((table_name = 'tasks' and column_name in
                ('horizon', 'waiting_on', 'follow_up_date', 'archived_at',
                 'reschedule_count', 'original_date'))
            or (table_name = 'life_areas' and column_name = 'kind'))
      union all
      select conname::text from pg_constraint
        where conname like 'protected\_periods\_%'
           or conname like 'weekly\_plans\_%'
           or conname in ('life_areas_kind_check', 'tasks_horizon_check',
                          'tasks_waiting_on_check', 'tasks_reschedule_count_check',
                          'tasks_waiting_on_horizon_check')
      union all
      select indexname::text from pg_indexes
        where schemaname = 'public'
          and indexname in ('life_areas_user_category_idx', 'protected_periods_user_active_idx')
    ) loydetyt;

    raise exception 'Migraatio 0015 on kesken: % objektia 47:sta on jo olemassa (%).',
      olemassa, nimet;
  end if;

  -- 5. Poistettava rajoite on olemassa. Jos se puuttuu mutta yksikään
  --    0015:n objekti ei ole olemassa, kanta on kasin muutettu: se ei
  --    ole tila 0014, eika tama migraatio ole sen korjaus.
  if not exists (
    select 1 from pg_constraint where conname = 'life_areas_category_unique' and contype = 'u'
  ) then
    raise exception 'life_areas_category_unique puuttuu, vaikka 0015:n objekteja on 0/47. Kanta ei ole tilassa 0014.';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- VAIHE 0b2: touch_updated_at on yhä kovennettu — VAIN KATALOGI
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
-- VAIHE 0c: tasks ja life_areas lukitaan KERRALLA ENNEN yhtäkään
-- muutosta
--
-- Kiinteä järjestys (tasks, life_areas), yksi lause. Jos sovelluksen
-- pyyntö tai avoin editorin välilehti pitää jompaakumpaa, migraatio
-- odottaa TÄSSÄ lauseessa ja peruuntuu ilman, että mitään on muutettu
-- — eikä auth.users-tauluun ole sillä hetkellä kuin vaiheen 0b
-- katalogilukujen lukulukot. Ilman tätä tasks olisi jo muutettu ja
-- lukittuna, kun migraatio jäisi odottamaan life_areas-lukkoa.
--
-- auth.users-lukko (SHARE ROW EXCLUSIVE, uusien taulujen vierasavaimet)
-- otetaan TARKOITUKSELLA VIIMEISENÄ (vaiheet 3 ja 4): se pidetään
-- committiin asti ja estää sen ajan kirjautumiset, joten sen kesto
-- halutaan mahdollisimman lyhyeksi. Sama järjestys kuin 0010:ssä.
-- Harjoiteltu: tools/pg-rehearsal (failure:0015-locks).
-- ---------------------------------------------------------------------
lock table public.tasks, public.life_areas in access exclusive mode;

-- ---------------------------------------------------------------------
-- VAIHE 0d: oikea tietokanta
--
-- Lukee auth.users-taulun rivin (ei pelkkää katalogia), joten se
-- ajetaan lukituksen jälkeen.
-- ---------------------------------------------------------------------
do $$
declare
  omistaja  uuid := '2cc00622-f927-4604-a518-361a4328481b'::uuid;
begin
  if not exists (select 1 from auth.users where id = omistaja) then
    raise exception 'Hyvaksyttya omistajaa % ei loydy auth.users-taulusta. Vaara projekti?', omistaja;
  end if;

  raise notice 'Esiehdot kunnossa. Omistaja %, 0015:n objekteja 0/47.', omistaja;
end $$;

-- ---------------------------------------------------------------------
-- VAIHE 0e: OLEMASSA OLEVA DATA KESTÄÄ UUDET RAJOITTEET
--
-- Uudet sarakkeet ovat NULL tai saavat oletuksen, joten tämä on
-- rakenteellisesti totta. Se todistetaan silti ETUKÄTEEN: jos
-- tasks-taulussa olisi jo samanniminen sarake väärällä sisällöllä,
-- vaihe 0b olisi pysäyttänyt ("kesken"). Tässä varmistetaan vain, että
-- lukitut taulut ovat luettavissa ja kirjataan rivimäärät.
-- ---------------------------------------------------------------------
do $$
declare
  tehtavia  bigint;
  alueita   bigint;
  pakollinen boolean;
begin
  select count(*) into tehtavia from public.tasks;
  select count(*) into alueita from public.life_areas;
  select a.attnotnull into pakollinen
    from pg_attribute a
   where a.attrelid = 'public.tasks'::regclass and a.attname = 'date' and not a.attisdropped;

  raise notice 'tasks: % rivia, life_areas: % rivia, tasks.date NOT NULL ennen 0015:ta: %.',
    tehtavia, alueita, coalesce(pakollinen::text, 'sarake puuttuu');
end $$;

-- ---------------------------------------------------------------------
-- VAIHE 1: life_areas — alueen laji, kategoria ei enää uniikki
--
-- Alueen laji (kind) on ERI akseli kuin asian luonne: luonne johdetaan
-- (src/domain/itemNature.js), laji on käyttäjän valinta.
-- ---------------------------------------------------------------------

alter table public.life_areas add column kind text not null default 'STANDARD';

alter table public.life_areas
  add constraint life_areas_kind_check
  check (kind in ('STANDARD', 'WELLBEING', 'ENJOYMENT', 'OWN_TIME', 'FREE_TIME', 'VACATION'));

-- OMISTAJAN PÄÄTÖS 1: useampi alue saa jakaa kategorian. Kategoria-
-- perinnässä voittaa aktiivinen, pienin sort_order, sitten nimi
-- (src/domain/lifeArea.js). Rajoitteen poisto ei koske yhteenkään riviin.
alter table public.life_areas drop constraint life_areas_category_unique;

-- Kategoriahaku käyttäjää kohti pysyy nopeana ilman uniikkiutta.
create index life_areas_user_category_idx
  on public.life_areas (user_id, category_key);

-- ---------------------------------------------------------------------
-- VAIHE 2: tasks — horisontti, odotus, arkisto ja siirtojen seuranta
--
-- ⚠ tasks ON TUOTANNOSSA AUKI ⚠
--
-- Kaikki sarakkeet ovat NULL paitsi reschedule_count (oletus 0). Ennen
-- aaltoa L sovellus ei lähetä yhtäkään niistä (sarakeportti
-- MENTAL_LOAD_FIELDS, src/data/schema.js), joten aallon K koodi toimii
-- tämän migraation jälkeen täsmälleen kuten ennen.
-- ---------------------------------------------------------------------

-- NULL = johdetaan päivästä ja määräajasta (src/domain/lifeLoad.js).
-- NOW = käyttäjän valitsema fokus tälle päivälle. Ei 'ARCHIVED':
-- arkistointi on archived_at.
alter table public.tasks add column horizon text;
-- Kenen tai minkä tahon varassa asia odottaa. Vapaa teksti.
alter table public.tasks add column waiting_on text;
-- Odottavan asian tarkistuspäivä.
alter table public.tasks add column follow_up_date date;
-- Poistettu näkyvistä (Tallessa → Arkisto). Ei poistoa.
alter table public.tasks add column archived_at timestamptz;
-- Montako kertaa keskeneräisen tehtävän päivää on siirretty
-- (ajautuminen: PLAN_CHURN). Vakio-oletus: ei uudelleenkirjoitusta.
alter table public.tasks add column reschedule_count integer not null default 0;
-- Ensimmäinen suunniteltu päivä ennen siirtoja.
alter table public.tasks add column original_date date;

alter table public.tasks
  add constraint tasks_horizon_check
  check (horizon is null
      or horizon in ('NOW', 'THIS_WEEK', 'LATER', 'NOT_YET', 'WAITING'));

alter table public.tasks
  add constraint tasks_waiting_on_check
  check (waiting_on is null
      or (length(btrim(waiting_on)) > 0 and length(waiting_on) <= 200));

alter table public.tasks
  add constraint tasks_reschedule_count_check
  check (reschedule_count >= 0 and reschedule_count <= 10000);

-- Odotus kuuluu vain odottavalle asialle.
alter table public.tasks
  add constraint tasks_waiting_on_horizon_check
  check (horizon = 'WAITING' or waiting_on is null);

-- PÄIVÄTÖN TEHTÄVÄ (omistajan päätös 2). Idempotentti: nullable
-- sarakkeelle tämä ei tee mitään. Ei rivien kirjoitusta.
alter table public.tasks alter column date drop not null;

-- ---------------------------------------------------------------------
-- VAIHE 3: protected_periods — suojattu aika
--
-- YKSI MALLI (omistajan päätös 4): oma aika, vapaa-ajan säännöt ja loma
-- ovat saman taulun rivejä.
--
--   suojattu ilta              FREE_TIME weekly, viikonpäivä, klo 17.00–
--   sunnuntai pääosin vapaa    FREE_TIME weekly {7}, koko päivä, soft
--   ei velvoitteita klo X jälk FREE_TIME weekly {1..7}, klo X–
--   vähintään N h viikossa     FREE_TIME weekly_target, target_minutes
--   oma aika                   OWN_TIME once tai weekly
--   loma                       VACATION once, päiväväli, ei kellonaikoja
--
-- Rajoitteet ovat TÄSMÄLLEEN validateProtectedPeriod-funktion säännöt
-- (src/domain/protectedTime.js): muistipolku ei hyväksy riviä, jonka
-- kanta hylkäisi, eikä kanta hylkää validoitua riviä
-- (tests/mental-load-migration.test.mjs).
-- ---------------------------------------------------------------------

create table public.protected_periods (
  id              text primary key,
  user_id         uuid not null default auth.uid()
                  references auth.users(id) on delete cascade,

  -- OWN_TIME | FREE_TIME | VACATION
  kind            text not null,
  -- once | weekly | weekly_target
  recurrence      text not null,
  title           text,

  start_date      date,
  end_date        date,
  -- ISO-viikonpäivät 1 = ma … 7 = su.
  weekdays        smallint[],
  -- NULL = koko päivä / nukkumaanmenoon asti.
  start_time      time,
  end_time        time,
  -- Vain weekly_target: viikon vähimmäisvapaa-aika minuutteina.
  target_minutes  integer,
  -- firm = ei koskaan automaattisesti; soft = "pääosin vapaa".
  strength        text not null default 'firm',
  active          boolean not null default true,
  note            text,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

alter table public.protected_periods
  add constraint protected_periods_kind_check
  check (kind in ('OWN_TIME', 'FREE_TIME', 'VACATION'));

alter table public.protected_periods
  add constraint protected_periods_recurrence_check
  check (recurrence in ('once', 'weekly', 'weekly_target'));

alter table public.protected_periods
  add constraint protected_periods_title_check
  check (title is null or (length(btrim(title)) > 0 and length(title) <= 60));

alter table public.protected_periods
  add constraint protected_periods_note_check
  check (note is null or length(note) <= 500);

alter table public.protected_periods
  add constraint protected_periods_weekdays_check
  check (weekdays is null
      or (cardinality(weekdays) between 1 and 7
          and weekdays <@ '{1,2,3,4,5,6,7}'::smallint[]));

-- Viikossa on 10080 minuuttia.
alter table public.protected_periods
  add constraint protected_periods_target_check
  check (target_minutes is null or target_minutes between 0 and 10080);

alter table public.protected_periods
  add constraint protected_periods_strength_check
  check (strength in ('firm', 'soft'));

alter table public.protected_periods
  add constraint protected_periods_dates_check
  check (start_date is null or end_date is null or end_date >= start_date);

-- Loppuaika vaatii alkuajan, ja alku on ennen loppua. Jakso ei ylitä
-- keskiyötä: ilta "klo 17 alkaen" on alkuaika ilman loppua.
alter table public.protected_periods
  add constraint protected_periods_times_check
  check ((end_time is null or start_time is not null)
     and (start_time is null or end_time is null or start_time < end_time));

-- Kertajakso: alkupäivä pakollinen, ei viikonpäiviä.
alter table public.protected_periods
  add constraint protected_periods_once_check
  check (recurrence <> 'once' or (start_date is not null and weekdays is null));

-- Viikoittainen: vähintään yksi viikonpäivä.
alter table public.protected_periods
  add constraint protected_periods_weekly_check
  check (recurrence <> 'weekly' or (weekdays is not null and cardinality(weekdays) >= 1));

-- Viikon vähimmäisaika koskee vain vapaa-aikaa, on pelkkä luku (ei
-- kellonaikoja eikä viikonpäiviä), ja luku kuuluu vain sille.
alter table public.protected_periods
  add constraint protected_periods_weekly_target_check
  check ((recurrence = 'weekly_target'
          and kind = 'FREE_TIME' and target_minutes is not null
          and start_time is null and end_time is null and weekdays is null)
      or (recurrence <> 'weekly_target' and target_minutes is null));

-- Loma on päiväväli: kertajakso ilman kellonaikoja.
alter table public.protected_periods
  add constraint protected_periods_vacation_check
  check (kind <> 'VACATION'
      or (recurrence = 'once' and start_time is null and end_time is null));

-- Kertajakso on enintään vuoden (366 päivää) mittainen.
alter table public.protected_periods
  add constraint protected_periods_span_check
  check (recurrence <> 'once' or end_date is null or start_date is null
      or end_date - start_date < 366);

alter table public.protected_periods
  add constraint protected_periods_owner_row_key unique (user_id, id);

create index protected_periods_user_active_idx
  on public.protected_periods (user_id, active);

alter table public.protected_periods enable row level security;

create policy protected_periods_select_own on public.protected_periods
  for select to authenticated using (auth.uid() = user_id);
create policy protected_periods_insert_own on public.protected_periods
  for insert to authenticated with check (auth.uid() = user_id);
create policy protected_periods_update_own on public.protected_periods
  for update to authenticated using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
create policy protected_periods_delete_own on public.protected_periods
  for delete to authenticated using (auth.uid() = user_id);

revoke all on public.protected_periods from public;
revoke all on public.protected_periods from anon;
revoke all on public.protected_periods from authenticated;
grant select, insert, update, delete on public.protected_periods to authenticated;

create trigger protected_periods_touch_updated_at
  before update on public.protected_periods
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------
-- VAIHE 4: weekly_plans — viikkosuunnitelma (sunnuntain nollaus)
--
-- Yksi rivi ISO-viikkoa (maanantaita) kohti. priorities on taulukko
-- { ref, title } -olioita; kanta sallii viisi, käyttöliittymä rajaa
-- kolmeen (src/domain/weeklyPlan.js).
-- ---------------------------------------------------------------------

create table public.weekly_plans (
  id               text primary key,
  user_id          uuid not null default auth.uid()
                   references auth.users(id) on delete cascade,

  week_start       date not null,
  priorities       jsonb not null default '[]'::jsonb,
  -- Suunnitelman kesto viikon sulkemishetkellä (ajautuminen: CAPACITY_BIAS).
  planned_minutes  integer,
  -- Viikko suljettu = suunniteltu.
  closed_at        timestamptz,
  note             text,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

alter table public.weekly_plans
  add constraint weekly_plans_week_start_check
  check (extract(isodow from week_start) = 1);

alter table public.weekly_plans
  add constraint weekly_plans_priorities_check
  check (jsonb_typeof(priorities) = 'array' and jsonb_array_length(priorities) <= 5);

alter table public.weekly_plans
  add constraint weekly_plans_planned_minutes_check
  check (planned_minutes is null or planned_minutes between 0 and 10080);

alter table public.weekly_plans
  add constraint weekly_plans_note_check
  check (note is null or length(note) <= 1000);

alter table public.weekly_plans
  add constraint weekly_plans_week_unique unique (user_id, week_start);

alter table public.weekly_plans
  add constraint weekly_plans_owner_row_key unique (user_id, id);

alter table public.weekly_plans enable row level security;

create policy weekly_plans_select_own on public.weekly_plans
  for select to authenticated using (auth.uid() = user_id);
create policy weekly_plans_insert_own on public.weekly_plans
  for insert to authenticated with check (auth.uid() = user_id);
create policy weekly_plans_update_own on public.weekly_plans
  for update to authenticated using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
create policy weekly_plans_delete_own on public.weekly_plans
  for delete to authenticated using (auth.uid() = user_id);

revoke all on public.weekly_plans from public;
revoke all on public.weekly_plans from anon;
revoke all on public.weekly_plans from authenticated;
grant select, insert, update, delete on public.weekly_plans to authenticated;

create trigger weekly_plans_touch_updated_at
  before update on public.weekly_plans
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------
-- VAIHE 5: jälkitarkistukset ennen committia
-- ---------------------------------------------------------------------
do $$
declare
  n integer;
begin
  select count(*) into n from pg_policies
   where schemaname = 'public' and tablename in ('protected_periods', 'weekly_plans');
  if n <> 8 then
    raise exception 'Odotettiin 8 politiikkaa, loytyi %.', n;
  end if;

  select count(*) into n from pg_class
   where relnamespace = 'public'::regnamespace
     and relname in ('protected_periods', 'weekly_plans')
     and relrowsecurity;
  if n <> 2 then
    raise exception 'RLS ei ole paalla molemmissa uusissa tauluissa (%/2).', n;
  end if;

  -- KATEGORIA EI OLE ENAA UNIIKKI, mutta haku on yha indeksoitu.
  if exists (select 1 from pg_constraint where conname = 'life_areas_category_unique') then
    raise exception 'life_areas_category_unique on yha olemassa.';
  end if;

  -- PAIVATON TEHTAVA ON RAKENTEELLISESTI SALLITTU.
  if exists (
    select 1 from pg_attribute
     where attrelid = 'public.tasks'::regclass and attname = 'date'
       and not attisdropped and attnotnull
  ) then
    raise exception 'tasks.date on yha NOT NULL.';
  end if;

  -- PUBLIC-ROOLIN OIKEUDET LUETAAN SUORAAN ACL:STA (grantee = 0).
  select count(*) into n
    from pg_class c,
         lateral aclexplode(c.relacl) a
   where c.relnamespace = 'public'::regnamespace
     and c.relname in ('protected_periods', 'weekly_plans')
     and a.grantee = 0;
  if n <> 0 then
    raise exception 'PUBLIC-roolilla on % oikeutta uusiin tauluihin.', n;
  end if;

  if has_table_privilege('anon', 'public.protected_periods', 'select')
     or has_table_privilege('anon', 'public.weekly_plans', 'select')
     or has_table_privilege('anon', 'public.protected_periods', 'insert')
     or has_table_privilege('anon', 'public.weekly_plans', 'insert') then
    raise exception 'anon-roolilla on oikeus uusiin tauluihin.';
  end if;

  if not has_table_privilege('authenticated', 'public.protected_periods', 'select')
     or not has_table_privilege('authenticated', 'public.weekly_plans', 'insert')
     or not has_table_privilege('authenticated', 'public.weekly_plans', 'update') then
    raise exception 'authenticated-roolilta puuttuu oikeus uusiin tauluihin.';
  end if;

  -- OLEMASSA OLEVAT POLITIIKAT OVAT KOSKEMATTOMIA: sama maara kuin
  -- 0014:n jalkeen (tasks, goals, projects, routines, 0012:n ja 0013:n
  -- taulut: 40; 0014:n kymmenen taulua: 40).
  select count(*) into n from pg_policies
   where schemaname = 'public'
     and tablename in ('tasks', 'goals', 'projects', 'routines',
                       'life_areas', 'weekly_capacities', 'time_entries',
                       'alignment_reviews', 'running_timers', 'alignment_item_settings',
                       'saved_places', 'place_aliases', 'calendar_events',
                       'commute_observations', 'life_settings', 'sleep_logs',
                       'habit_plans', 'habit_events', 'exercise_sessions',
                       'wellbeing_checkins');
  if n <> 80 then
    raise exception 'Olemassa olevien taulujen politiikat muuttuivat: % (odotus 80).', n;
  end if;

  raise notice 'Migraatio 0015 valmis. Aja seuraavaksi supabase/verify/verify_0015.sql.';
end $$;

commit;

-- =====================================================================
-- HYVÄKSYNTÄPORTTI
-- =====================================================================
--
-- TÄTÄ EI OLE AJETTU EIKÄ SAA AJAA ILMAN NIMENOMAISTA HYVÄKSYNTÄÄ.
--
-- Ennen ajoa vaaditaan:
--   1. Panun kirjallinen hyväksyntä ("hyväksyn 0015/L")
--   2. Migraatio 0014 ajettu JA supabase/verify/verify_0014.sql läpi
--   3. TUORE VARMUUSKOPIO (pakollinen: tasks-taulua muutetaan):
--      supabase/backup/snapshot_state_0014.sql, tulos talteen
--   4. supabase/preflight/preflight_0015.sql (vain luku) -> 0 FAIL;
--      kirjaa rivin "tasks.date NOT NULL ennen 0015:tä" arvo
--   5. Ajo postgres-roolilla Supabasen SQL-editorissa
--   6. supabase/verify/verify_0015.sql -> 0 poikkeavaa
--   7. Vasta sitten portit src/data/schema.js:ssä (TABLES.protectedPeriods,
--      TABLES.weeklyPlans ja MENTAL_LOAD_FIELDS, kaikki kolme yhdessä) —
--      ja vain julkaisuaallon L mukana (välimuisti v25).
--
-- ESITARKISTUS (vain lukeva, turvallinen ajaa milloin tahansa):
--
--   select
--     (select count(*) from pg_tables where schemaname='public'
--       and tablename in ('saved_places','calendar_events','life_settings')) as arki_0014,
--     (select count(*) from pg_tables where schemaname='public'
--       and tablename in ('protected_periods','weekly_plans')) as uudet_0015,
--     (select count(*) from pg_constraint
--       where conname = 'life_areas_category_unique') as kategoria_uniikki,
--     (select current_setting('server_version_num')::int >= 150000) as pg15_tai_uudempi;
--
--   Odotus ennen ajoa: 3, 0, 1, true
--
-- Täydellinen esitarkistus: supabase/preflight/preflight_0015.sql.
--
-- =====================================================================
-- VAIKUTUS OLEMASSA OLEVAAN DATAAN
-- =====================================================================
--
--   tasks        uudet sarakkeet NULL, reschedule_count = 0; date saa
--                olla NULL. Yhtäkään riviä ei kirjoiteta uudelleen.
--   life_areas   kind = 'STANDARD' jokaiselle riville (oletus, ei
--                uudelleenkirjoitusta); kategorian uniikkius poistuu.
--   muut         ei mitään. Vaihe 5 todistaa ennen committia, että
--                olemassa olevien taulujen politiikat ovat ennallaan.
--
-- =====================================================================
-- ROLLBACK
-- =====================================================================
--
-- Täydellinen ohje, tarkistukset ja tilannekuvan palautus:
-- docs/MIGRATION-0015-RECOVERY.md. Alla sama SQL tiivistettynä.
--
-- PERUUTUS AINA KÄÄNTEISESSÄ JÄRJESTYKSESSÄ: tämä ensin, sitten 0014.
-- Sulje portit ENSIN (aallon L revert aaltoon K): muuten aallon L koodi
-- lähettää sarakkeita, joita ei enää ole, ja jokainen tehtävän tallennus
-- kaatuu (42703).
--
--   begin;
--   set local lock_timeout = '5s';
--   lock table public.tasks, public.life_areas in access exclusive mode;
--
--   -- Vartija: kategorian uniikkiutta ei voi palauttaa, jos aallon L
--   -- aikana kaksi aluetta on saanut saman kategorian.
--   do $$
--   begin
--     if exists (select 1 from public.life_areas where category_key is not null
--                 group by user_id, category_key having count(*) > 1) then
--       raise exception 'Kaksi aluetta jakaa kategorian: ratkaise ennen peruutusta (MIGRATION-0015-RECOVERY.md).';
--     end if;
--   end $$;
--
--   drop table public.weekly_plans;
--   drop table public.protected_periods;
--
--   alter table public.tasks drop constraint tasks_waiting_on_horizon_check;
--   alter table public.tasks drop constraint tasks_reschedule_count_check;
--   alter table public.tasks drop constraint tasks_waiting_on_check;
--   alter table public.tasks drop constraint tasks_horizon_check;
--   alter table public.tasks drop column original_date;
--   alter table public.tasks drop column reschedule_count;
--   alter table public.tasks drop column archived_at;
--   alter table public.tasks drop column follow_up_date;
--   alter table public.tasks drop column waiting_on;
--   alter table public.tasks drop column horizon;
--
--   drop index public.life_areas_user_category_idx;
--   alter table public.life_areas drop constraint life_areas_kind_check;
--   alter table public.life_areas drop column kind;
--   alter table public.life_areas
--     add constraint life_areas_category_unique unique (user_id, category_key);
--
--   commit;
--
-- tasks.date-SARAKKEEN NOT NULL -EHTOA EI PALAUTETA TÄSSÄ. Se palautetaan
-- VAIN, jos esitarkistus kirjasi sen olleen olemassa ennen 0015:tä, ja
-- vasta kun päivättömät tehtävät on käsitelty (ks. recovery-dokumentti).
-- Harjoittelun lähtötilassa sarake on aina ollut nullable.
--
-- Peruutus POISTAA suojatut jaksot, viikkosuunnitelmat, horisontit,
-- odotukset, arkistoinnit, siirtolaskurit ja alueiden lajit pysyvästi.
-- Ota tilannekuva (supabase/backup/snapshot_state_0015.sql) ennen
-- pudotusta. Arkistoidut tehtävät palaavat näkyviin (archived_at katoaa).
--
-- Muista tällöin myös:
--   src/data/schema.js -> TABLES.protectedPeriods = false,
--                         TABLES.weeklyPlans = false,
--                         MENTAL_LOAD_FIELDS = false
--
-- =====================================================================
-- RISKIT
-- =====================================================================
--
--   KESKI    tasks on tuotannossa auki: ALTER TABLE ottaa ACCESS
--            EXCLUSIVE -lukon (lock_timeout 5 s, lukitus ennen yhtäkään
--            muutosta); ei uudelleenkirjoitusta (vakio-oletukset)
--   KESKI    kategorian uniikkiuden poisto: peruutus vaatii, ettei
--            yksikään käyttäjä ole ehtinyt jakaa kategoriaa
--   MATALA   kaksi uutta tyhjää taulua, RLS neljällä omalla
--            politiikalla, ei anonille eikä PUBLICille
--   HUOMIO   päivätön tehtävä: aallon K koodi ei luo sellaista, mutta
--            lukee sen (date = null) — ks. MENTAL-LOAD-CORE.md
--
-- Ajon kesto on käytännössä välitön: kaikki muutokset ovat katalogi-
-- muutoksia, ja CHECK-rajoitteiden validointi lukee tasks-taulun kerran.
