-- =====================================================================
-- Manifestival — migraatio 0014: arjen käyttöjärjestelmä
-- =====================================================================
--
-- TILA: EI AJETTU TUOTANTOON. EI HYVÄKSYTTY.
--
-- TÄMÄ ON SUUNNITELMA, EI SUORITUSKÄSKY.
--
-- RIIPPUU MIGRAATIOSTA 0013 (ei ajettu). 0014 ajetaan vasta 0013:n ja
-- sen varmistuksen (supabase/verify/verify_0013.sql) jälkeen. Julkaisu-
-- aalto K (välimuisti v24) avaa tämän migraation portit.
--
-- =====================================================================
-- TÄMÄ MIGRAATIO EI KOSKE OLEMASSA OLEVAAN DATAAN
-- =====================================================================
--
-- 0014 LUO KYMMENEN UUTTA TAULUA eikä muuta yhtäkään olemassa olevaa
-- taulua, saraketta, rajoitetta tai riviä. Tyhjää taulua ei voi rikkoa,
-- eikä yksikään nykyinen toiminto voi lakata toimimasta tämän takia.
--
-- Ainoat lukot ovat auth.users- ja goals-taulujen SHARE ROW EXCLUSIVE,
-- jotka vierasavainten luonti ottaa hetkeksi. `lock_timeout` rajaa
-- odotuksen viiteen sekuntiin.
--
-- EI SARAKEPORTTEJA. Uusi sarakeportti kirjoittaisi uudelleen jokaisen
-- lukitun C–J-tietueen (docs/activation/release-train-c-j.json). Kaikki
-- kymmenen ovat tauluportteja, jotka aukeavat yhdessä aallossa K.
--
-- =====================================================================
-- MITÄ TÄMÄ LISÄÄ
-- =====================================================================
--
--   public.saved_places          tallennetut paikat: nimi, osoite
--                                TEKSTINÄ, tavallinen matka-aika,
--                                valmistautuminen, perilläolon varmuus-
--                                aika ja pysäköinti/kävely
--   public.place_aliases         käyttäjän vahvistamat paikan lisänimet
--                                ("sali" -> Kuntosali Keskusta)
--   public.calendar_events       menot ja sitoumukset: kerran tai viikoit-
--                                tain toistuva, koko päivän tai kellon-
--                                aikaan; esiintymät LASKETAAN, ei tallenneta
--   public.commute_observations  käyttäjän kuittaamat toteutuneet matkat
--                                ("Lähdin" / "Olin perillä"); rajattu 60
--                                havaintoon paikkaa kohti sovelluksessa
--   public.life_settings         arjen asetukset: YKSI rivi käyttäjää kohti
--                                (uni, herätys, aamurutiini, ateriarytmi,
--                                muistutusten toimitustapa)
--   public.sleep_logs            vuoteessa olon aika (mahdollisuus nukkua),
--                                yksi rivi heräämispäivää kohti
--   public.habit_plans           tapojen muutoksen suunnitelmat (esim.
--                                nikotiinin vähentäminen porrastetusti)
--   public.habit_events          kirjatut tapahtumat: käyttö, lykkäys,
--                                väliin jättäminen
--   public.exercise_sessions     liikuntakerrat: suunniteltu ja toteutunut
--   public.wellbeing_checkins    motivaatio ja hallinnan tunne 1–5, yksi
--                                rivi päivää kohti
--
-- =====================================================================
-- MITÄ TÄMÄ EI LISÄÄ — EIKÄ SAA LISÄTÄ
-- =====================================================================
--
-- KOORDINAATTEJA EI TALLENNETA. Paikka tunnetaan nimenä ja osoitteena
-- tekstinä. Koordinaatti kannassa on koordinaatti varmuuskopiossa,
-- viennissä ja mahdollisessa vuodossa — eikä lähtöajan laskenta tarvitse
-- sitä. Sama tietosuojapäätös kuin migraatiossa 0011.
--
-- SIJAINTIHISTORIAA EI TALLENNETA. commute_observations ei ole reitti-
-- eikä sijaintijälki: se on käyttäjän itse kuittaama lähtö- ja perillä-
-- oloaika. Rivi syntyy vain käyttäjän eleestä, ei taustalla.
--
-- UNTA EI MITATA. sleep_logs kertoo vuoteessa olon ajan, jonka käyttäjä
-- tai herätys kirjasi. `kind = 'measured'` on varattu terveyslaitteen
-- tiedolle; sovellus ei väitä mitanneensa unta.
--
-- MOTIVAATIO, HALLINNAN TUNNE, UNI JA NIKOTIINI OVAT ARKALUONTEISIA.
-- Niitä ei lähetetä tekoälylle eikä kirjoiteta lokiin (src/lib/logger.js
-- SENSITIVE_KEYS). Tämä migraatio ei luo yhtään näkymää, funktiota eikä
-- oikeutta, joka ohittaisi rivitason suojauksen.
--
-- TOISTUVAN MENON ESIINTYMIÄ EI TALLENNETA. Ne lasketaan tapahtumasta
-- (viikonpäivät, päättymispäivä, ohitetut päivät), kuten rutiinienkin.
--
-- EI MUUTOKSIA tasks-, goals-, projects-, routines- TAI 0012/0013:n
-- TAULUIHIN. Uni- ja herätysajan tavoite pysyvät profiilissa
-- (profile.sleep_target_hours, profile.default_wake_time).
--
-- =====================================================================
-- OMISTAJUUS
-- =====================================================================
--
-- Jokainen taulu saa `owner_row_key`-avaimen (user_id, id) ja RLS:n
-- neljällä omalla politiikalla.
--
-- Taulujen väliset viitteet ovat YHDISTELMÄVIERASAVAIMIA
-- `(user_id, x) -> (user_id, id)`. Tavallinen vierasavain sallisi
-- ristiinkiinnityksen toisen käyttäjän riviin: vierasavaimen tarkistus
-- EI kulje RLS:n läpi.
--
--   KASKADI (lapsirivi ei tarkoita mitään ilman vanhempaa):
--     place_aliases.place_id         -> saved_places
--     commute_observations.place_id  -> saved_places
--     habit_events.plan_id           -> habit_plans
--
--   NOLLAUS SARAKKEESEEN (tapahtuma ja liikuntakerta jäävät, liitos
--   katkeaa):
--     calendar_events.place_id       -> saved_places  set null (place_id)
--     calendar_events.goal_id        -> goals         set null (goal_id)
--     exercise_sessions.goal_id      -> goals         set null (goal_id)
--
-- commute_observations.event_id EI OLE VIERASAVAIN. Havainto on
-- toteutunut matka; tapahtuman poisto ei tee matkasta tekemätöntä.
--
-- =====================================================================
-- OBJEKTIEN MÄÄRÄ: 153
-- =====================================================================
--
--    10  taulua
--    88  rajoitetta     (10 owner_row_key -avainta, 4 uniikkirajoitetta,
--                        6 vierasavainta ja 68 CHECK-rajoitetta)
--     5  indeksiä       (joista yksi uniikki: paikan nimi käyttäjää kohti)
--    10  liipaisinta
--    40  politiikkaa    (10 x 4)
--
-- Luku on käsin laskettu ja sitä käytetään osittaisen ajon
-- tunnistukseen. Nolla = tuore ajo. Mikä tahansa muu luku tarkoittaa,
-- että ajo on tehty tai jäänyt kesken — eikä kumpaakaan korjata
-- ajamalla uudelleen.

begin;

-- ---------------------------------------------------------------------
-- VAIHE 0a: lukitusraja
--
-- Vierasavaimen luonti ottaa viitattuun tauluun SHARE ROW EXCLUSIVE
-- -lukon. auth.users on taulu, jota jokainen kirjautuminen koskee, ja
-- goals on tuotannossa auki.
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

  -- 1. 0013 on ajettu: sen kaksi taulua ovat olemassa. Juna etenee
  --    jarjestyksessa; 0014 ei ohita yhtakaan aiempaa migraatiota.
  if (select count(*) from pg_tables
       where schemaname = 'public'
         and tablename in ('running_timers', 'alignment_item_settings')) <> 2 then
    raise exception 'Migraatio 0013 pitaa ajaa ensin: running_timers tai alignment_item_settings puuttuu.';
  end if;

  -- 2. Viitattu omistajan rivin avain on olemassa: tapahtuman ja
  --    liikuntakerran tavoitekytkenta on yhdistelmavierasavain.
  if not exists (
    select 1 from pg_constraint where conname = 'goals_owner_row_key' and contype = 'u'
  ) then
    raise exception 'goals_owner_row_key puuttuu. Tavoitekytkentaa ei voi luoda.';
  end if;

  -- 3. PostgreSQL 15: sarakekohtainen ON DELETE SET NULL. Ilman
  --    sarakelistaa PostgreSQL nollaisi myos NOT NULL -sarakkeen user_id,
  --    ja tavoitteen tai paikan poisto kaatuisi aina.
  if current_setting('server_version_num')::int < 150000 then
    raise exception 'PostgreSQL % on liian vanha (vaatii 15).', current_setting('server_version');
  end if;

  -- 4. Olen oikeassa tietokannassa.
  if not exists (select 1 from auth.users where id = omistaja) then
    raise exception 'Hyvaksyttya omistajaa % ei loydy auth.users-taulusta. Vaara projekti?', omistaja;
  end if;

  -- 5. OSITTAISEN TAI AIEMMAN AJON TUNNISTUS — 153 objektia.
  select count(*) into olemassa from (
    select 1 from pg_tables
      where schemaname = 'public'
        and tablename in ('saved_places', 'place_aliases', 'calendar_events',
                          'commute_observations', 'life_settings', 'sleep_logs',
                          'habit_plans', 'habit_events', 'exercise_sessions',
                          'wellbeing_checkins')
    union all
    select 1 from pg_constraint
      where conname in (
        'saved_places_name_check', 'saved_places_address_check',
        'saved_places_provider_place_check', 'saved_places_area_check',
        'saved_places_travel_mode_check', 'saved_places_usual_travel_check',
        'saved_places_preparation_check', 'saved_places_arrival_buffer_check',
        'saved_places_overhead_check', 'saved_places_note_check',
        'saved_places_owner_row_key',
        'place_aliases_alias_check', 'place_aliases_confirmations_check',
        'place_aliases_owner_row_key', 'place_aliases_alias_unique',
        'place_aliases_place_fkey',
        'calendar_events_title_check', 'calendar_events_all_day_check',
        'calendar_events_end_time_check', 'calendar_events_duration_check',
        'calendar_events_category_check', 'calendar_events_location_check',
        'calendar_events_travel_mode_check', 'calendar_events_travel_check',
        'calendar_events_preparation_check', 'calendar_events_arrival_buffer_check',
        'calendar_events_overhead_check', 'calendar_events_weekdays_check',
        'calendar_events_until_check', 'calendar_events_skip_dates_check',
        'calendar_events_notes_check', 'calendar_events_owner_row_key',
        'calendar_events_place_fkey', 'calendar_events_goal_fkey',
        'commute_observations_event_id_check', 'commute_observations_weekday_check',
        'commute_observations_travel_check', 'commute_observations_provider_check',
        'commute_observations_preparation_check', 'commute_observations_overhead_check',
        'commute_observations_result_check', 'commute_observations_source_check',
        'commute_observations_owner_row_key', 'commute_observations_place_fkey',
        'life_settings_one_per_user', 'life_settings_weekend_wake_check',
        'life_settings_weekend_bed_check', 'life_settings_wind_down_check',
        'life_settings_arrival_buffer_check', 'life_settings_guidance_check',
        'life_settings_reminder_offset_check', 'life_settings_hourly_value_check',
        'life_settings_currency_check', 'life_settings_alarm_check',
        'life_settings_morning_routine_check', 'life_settings_meal_rhythm_check',
        'life_settings_delivery_check', 'life_settings_owner_row_key',
        'sleep_logs_wake_date_unique', 'sleep_logs_source_check',
        'sleep_logs_kind_check', 'sleep_logs_note_check', 'sleep_logs_owner_row_key',
        'habit_plans_kind_check', 'habit_plans_name_check',
        'habit_plans_min_interval_check', 'habit_plans_daily_target_check',
        'habit_plans_baseline_check', 'habit_plans_steps_check',
        'habit_plans_delivery_check', 'habit_plans_unit_cost_check',
        'habit_plans_owner_row_key',
        'habit_events_action_check', 'habit_events_note_check',
        'habit_events_owner_row_key', 'habit_events_plan_fkey',
        'exercise_sessions_kind_check', 'exercise_sessions_planned_check',
        'exercise_sessions_actual_check', 'exercise_sessions_intensity_check',
        'exercise_sessions_recovery_check', 'exercise_sessions_note_check',
        'exercise_sessions_owner_row_key', 'exercise_sessions_goal_fkey',
        'wellbeing_checkins_motivation_check', 'wellbeing_checkins_control_check',
        'wellbeing_checkins_date_unique', 'wellbeing_checkins_owner_row_key')
    union all
    select 1 from pg_indexes
      where schemaname = 'public'
        and indexname in (
          'saved_places_user_name_idx', 'calendar_events_user_date_idx',
          'commute_observations_user_place_idx', 'habit_events_user_plan_idx',
          'exercise_sessions_user_date_idx')
    union all
    select 1 from pg_trigger
      where not tgisinternal
        and tgname in ('saved_places_touch_updated_at', 'place_aliases_touch_updated_at',
                       'calendar_events_touch_updated_at',
                       'commute_observations_touch_updated_at',
                       'life_settings_touch_updated_at', 'sleep_logs_touch_updated_at',
                       'habit_plans_touch_updated_at', 'habit_events_touch_updated_at',
                       'exercise_sessions_touch_updated_at',
                       'wellbeing_checkins_touch_updated_at')
    union all
    select 1 from pg_policies
      where schemaname = 'public'
        and tablename in ('saved_places', 'place_aliases', 'calendar_events',
                          'commute_observations', 'life_settings', 'sleep_logs',
                          'habit_plans', 'habit_events', 'exercise_sessions',
                          'wellbeing_checkins')
  ) kaikki;

  if olemassa = 153 then
    raise exception 'Migraatio 0014 on JO AJETTU. Ala aja uudelleen — aja supabase/verify/verify_0014.sql.';
  end if;

  if olemassa > 0 then
    select string_agg(nimi, ', ' order by nimi) into nimet from (
      select tablename::text as nimi from pg_tables
        where schemaname = 'public'
          and tablename in ('saved_places', 'place_aliases', 'calendar_events',
                            'commute_observations', 'life_settings', 'sleep_logs',
                            'habit_plans', 'habit_events', 'exercise_sessions',
                            'wellbeing_checkins')
      union all
      select conname::text from pg_constraint
        where conname like 'saved\_places\_%'
           or conname like 'place\_aliases\_%'
           or conname like 'calendar\_events\_%'
           or conname like 'commute\_observations\_%'
           or conname like 'life\_settings\_%'
           or conname like 'sleep\_logs\_%'
           or conname like 'habit\_plans\_%'
           or conname like 'habit\_events\_%'
           or conname like 'exercise\_sessions\_%'
           or conname like 'wellbeing\_checkins\_%'
      union all
      select indexname::text from pg_indexes
        where schemaname = 'public'
          and indexname in (
            'saved_places_user_name_idx', 'calendar_events_user_date_idx',
            'commute_observations_user_place_idx', 'habit_events_user_plan_idx',
            'exercise_sessions_user_date_idx')
    ) loydetyt;

    raise exception 'Migraatio 0014 on kesken: % objektia 153:sta on jo olemassa (%).',
      olemassa, nimet;
  end if;

  raise notice 'Esiehdot kunnossa. Omistaja %, 0014:n objekteja 0/153.', omistaja;
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
-- VAIHE 1: saved_places
--
-- ⚠ TÄSSÄ EI OLE KOORDINAATTEJA, EIKÄ NIITÄ SAA LISÄTÄ ⚠
--
-- Paikka on nimi ja osoite tekstinä. `provider_place_id` on liikenne-
-- tietopalvelun oma tunniste (esim. hakutuloksen avain), jolla samaa
-- paikkaa voi kysyä uudelleen — se ei ole sijainti.
--
-- NULL TARKOITTAA TUNTEMATONTA, EI NOLLAA. Tuntemattomasta matka-ajasta
-- ei lasketa lähtöaikaa; nolla väittäisi, että ollaan jo perillä.
-- ---------------------------------------------------------------------

create table public.saved_places (
  id                      text primary key,
  user_id                 uuid not null default auth.uid()
                          references auth.users(id) on delete cascade,

  name                    text not null,
  -- OSOITE TEKSTINÄ, EI KOORDINAATTEJA.
  address                 text,
  provider_place_id       text,
  -- Alue tai kaupunginosa ("Keskusta"): auttaa erottamaan samannimiset.
  area                    text,

  -- driving | transit | walking | cycling | other
  travel_mode             text not null default 'driving',
  -- Käyttäjän oma arvio tavallisesta matka-ajasta. EI liikennetietoa.
  usual_travel_minutes    integer,
  preparation_minutes     integer,
  -- "Haluan olla perillä ajoissa": paikan oma ohitus asetuksen oletukselle.
  arrival_buffer_minutes  integer,
  -- Pysäköinti, kävely ovelle, ilmoittautuminen.
  overhead_minutes        integer,
  -- Opittu matka-aika käytetään VAIN käyttäjän hyväksynnällä.
  use_learned             boolean not null default false,

  note                    text,

  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

alter table public.saved_places
  add constraint saved_places_name_check
  check (length(btrim(name)) > 0 and length(name) <= 80);

alter table public.saved_places
  add constraint saved_places_address_check
  check (address is null or length(address) <= 300);

alter table public.saved_places
  add constraint saved_places_provider_place_check
  check (provider_place_id is null or length(provider_place_id) <= 200);

alter table public.saved_places
  add constraint saved_places_area_check
  check (area is null or length(area) <= 80);

alter table public.saved_places
  add constraint saved_places_travel_mode_check
  check (travel_mode in ('driving', 'transit', 'walking', 'cycling', 'other'));

alter table public.saved_places
  add constraint saved_places_usual_travel_check
  check (usual_travel_minutes is null or usual_travel_minutes between 1 and 1440);

alter table public.saved_places
  add constraint saved_places_preparation_check
  check (preparation_minutes is null or preparation_minutes between 0 and 480);

alter table public.saved_places
  add constraint saved_places_arrival_buffer_check
  check (arrival_buffer_minutes is null or arrival_buffer_minutes between 0 and 240);

alter table public.saved_places
  add constraint saved_places_overhead_check
  check (overhead_minutes is null or overhead_minutes between 0 and 240);

alter table public.saved_places
  add constraint saved_places_note_check
  check (note is null or length(note) <= 500);

alter table public.saved_places
  add constraint saved_places_owner_row_key unique (user_id, id);

-- YKSI NIMI KERRAN KÄYTTÄJÄÄ KOHTI, kirjainkoosta riippumatta: "Sali" ja
-- "sali" olisivat puheessa sama paikka, ja kaksi riviä tekisi
-- tunnistuksesta arpapelin.
create unique index saved_places_user_name_idx
  on public.saved_places (user_id, lower(name));

alter table public.saved_places enable row level security;

create policy saved_places_select_own on public.saved_places
  for select to authenticated using (auth.uid() = user_id);
create policy saved_places_insert_own on public.saved_places
  for insert to authenticated with check (auth.uid() = user_id);
create policy saved_places_update_own on public.saved_places
  for update to authenticated using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
create policy saved_places_delete_own on public.saved_places
  for delete to authenticated using (auth.uid() = user_id);

revoke all on public.saved_places from public;
revoke all on public.saved_places from anon;
revoke all on public.saved_places from authenticated;
grant select, insert, update, delete on public.saved_places to authenticated;

create trigger saved_places_touch_updated_at
  before update on public.saved_places
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------
-- VAIHE 2: place_aliases
--
-- Lisänimi syntyy vain käyttäjän vahvistuksesta ("tarkoititko
-- Kuntosali Keskusta?" -> kyllä). `confirmations` kasvaa jokaisesta
-- vahvistuksesta. Alias on normalisoitu sovelluksessa (pienet
-- kirjaimet, yksi välilyönti).
-- ---------------------------------------------------------------------

create table public.place_aliases (
  id                 text primary key,
  user_id            uuid not null default auth.uid()
                     references auth.users(id) on delete cascade,

  place_id           text not null,
  alias              text not null,
  confirmations      integer not null default 1,
  last_confirmed_at  timestamptz,

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

alter table public.place_aliases
  add constraint place_aliases_alias_check
  check (length(btrim(alias)) > 0 and length(alias) <= 80);

alter table public.place_aliases
  add constraint place_aliases_confirmations_check
  check (confirmations between 1 and 10000);

alter table public.place_aliases
  add constraint place_aliases_owner_row_key unique (user_id, id);

-- Sama lisänimi samalle paikalle kerran. Sama sana saa osoittaa kahteen
-- paikkaan: silloin sovellus kysyy, eikä arvaa.
alter table public.place_aliases
  add constraint place_aliases_alias_unique unique (user_id, alias, place_id);

-- Lisänimi ilman paikkaa ei tarkoita mitään: paikan poisto vie sen.
alter table public.place_aliases
  add constraint place_aliases_place_fkey
  foreign key (user_id, place_id) references public.saved_places (user_id, id)
  on delete cascade;

alter table public.place_aliases enable row level security;

create policy place_aliases_select_own on public.place_aliases
  for select to authenticated using (auth.uid() = user_id);
create policy place_aliases_insert_own on public.place_aliases
  for insert to authenticated with check (auth.uid() = user_id);
create policy place_aliases_update_own on public.place_aliases
  for update to authenticated using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
create policy place_aliases_delete_own on public.place_aliases
  for delete to authenticated using (auth.uid() = user_id);

revoke all on public.place_aliases from public;
revoke all on public.place_aliases from anon;
revoke all on public.place_aliases from authenticated;
grant select, insert, update, delete on public.place_aliases to authenticated;

create trigger place_aliases_touch_updated_at
  before update on public.place_aliases
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------
-- VAIHE 3: calendar_events
--
-- Meno tai sitoumus: kerran (recurrence_weekdays = '{}') tai viikoittain
-- valittuina ISO-viikonpäivinä (1 = ma … 7 = su) päättymispäivään asti.
-- Ohitetut päivät ovat `skip_dates`. ESIINTYMIÄ EI TALLENNETA.
--
-- KOKO PÄIVÄ = EI ALKUAIKAA. Kaksi saraketta, jotka voisivat olla
-- ristiriidassa, sidotaan rajoitteella: all_day = (start_time is null).
-- ---------------------------------------------------------------------

create table public.calendar_events (
  id                      text primary key,
  user_id                 uuid not null default auth.uid()
                          references auth.users(id) on delete cascade,

  title                   text not null,
  -- Ensimmäinen (tai ainoa) esiintymä.
  event_date              date not null,
  start_time              time,
  end_time                time,
  duration_minutes        integer,
  all_day                 boolean not null default false,
  category                text not null default 'muu',

  -- Vapaa paikan kuvaus TEKSTINÄ, tai viite tallennettuun paikkaan.
  location_text           text,
  place_id                text,

  -- Tämän menon omat matka-arvot; ohittavat paikan arvot. NULL = ei
  -- asetettu (paikan tai asetusten arvo pätee), EI nolla.
  travel_mode             text,
  travel_minutes          integer,
  preparation_minutes     integer,
  arrival_buffer_minutes  integer,
  overhead_minutes        integer,

  recurrence_weekdays     smallint[] not null default '{}',
  recurrence_until        date,
  skip_dates              date[] not null default '{}',

  goal_id                 text,
  notes                   text,

  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

alter table public.calendar_events
  add constraint calendar_events_title_check
  check (length(btrim(title)) > 0 and length(title) <= 200);

alter table public.calendar_events
  add constraint calendar_events_all_day_check
  check (all_day = (start_time is null));

-- Loppuaika ilman alkuaikaa ei kerro mitään: koko päivän menolla ei ole
-- kumpaakaan.
alter table public.calendar_events
  add constraint calendar_events_end_time_check
  check (end_time is null or start_time is not null);

alter table public.calendar_events
  add constraint calendar_events_duration_check
  check (duration_minutes is null or duration_minutes between 1 and 1440);

alter table public.calendar_events
  add constraint calendar_events_category_check
  check (length(btrim(category)) > 0 and length(category) <= 40);

alter table public.calendar_events
  add constraint calendar_events_location_check
  check (location_text is null or length(location_text) <= 200);

alter table public.calendar_events
  add constraint calendar_events_travel_mode_check
  check (travel_mode is null
      or travel_mode in ('driving', 'transit', 'walking', 'cycling', 'other'));

alter table public.calendar_events
  add constraint calendar_events_travel_check
  check (travel_minutes is null or travel_minutes between 1 and 1440);

alter table public.calendar_events
  add constraint calendar_events_preparation_check
  check (preparation_minutes is null or preparation_minutes between 0 and 480);

alter table public.calendar_events
  add constraint calendar_events_arrival_buffer_check
  check (arrival_buffer_minutes is null or arrival_buffer_minutes between 0 and 240);

alter table public.calendar_events
  add constraint calendar_events_overhead_check
  check (overhead_minutes is null or overhead_minutes between 0 and 240);

-- Viikonpäivät 1–7, enintään seitsemän. NULL-alkio ei kelpaa: <@ ei
-- pidä NULLia minkään alkion jäsenenä.
alter table public.calendar_events
  add constraint calendar_events_weekdays_check
  check (cardinality(recurrence_weekdays) <= 7
     and recurrence_weekdays <@ '{1,2,3,4,5,6,7}'::smallint[]);

alter table public.calendar_events
  add constraint calendar_events_until_check
  check (recurrence_until is null or recurrence_until >= event_date);

-- Ohitettuja päiviä enintään vuoden verran, eikä yksikään ole NULL.
alter table public.calendar_events
  add constraint calendar_events_skip_dates_check
  check (cardinality(skip_dates) <= 366
     and array_position(skip_dates, null) is null);

alter table public.calendar_events
  add constraint calendar_events_notes_check
  check (notes is null or length(notes) <= 2000);

alter table public.calendar_events
  add constraint calendar_events_owner_row_key unique (user_id, id);

-- Paikan poisto ei vie menoa: meno jää, se ei vain enää liity paikkaan.
alter table public.calendar_events
  add constraint calendar_events_place_fkey
  foreign key (user_id, place_id) references public.saved_places (user_id, id)
  on delete set null (place_id);

alter table public.calendar_events
  add constraint calendar_events_goal_fkey
  foreign key (user_id, goal_id) references public.goals (user_id, id)
  on delete set null (goal_id);

create index calendar_events_user_date_idx
  on public.calendar_events (user_id, event_date);

alter table public.calendar_events enable row level security;

create policy calendar_events_select_own on public.calendar_events
  for select to authenticated using (auth.uid() = user_id);
create policy calendar_events_insert_own on public.calendar_events
  for insert to authenticated with check (auth.uid() = user_id);
create policy calendar_events_update_own on public.calendar_events
  for update to authenticated using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
create policy calendar_events_delete_own on public.calendar_events
  for delete to authenticated using (auth.uid() = user_id);

revoke all on public.calendar_events from public;
revoke all on public.calendar_events from anon;
revoke all on public.calendar_events from authenticated;
grant select, insert, update, delete on public.calendar_events to authenticated;

create trigger calendar_events_touch_updated_at
  before update on public.calendar_events
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------
-- VAIHE 4: commute_observations
--
-- ⚠ EI SIJAINTIHISTORIAA ⚠
--
-- Rivi on käyttäjän kuittaama toteutunut matka: milloin hän lähti ja
-- milloin oli perillä. Ei reittiä, ei pisteitä, ei taustaseurantaa.
-- Sovellus pitää enintään 60 havaintoa paikkaa kohti ja poistaa
-- vanhimmat; opittua aikaa käytetään vain käyttäjän hyväksynnällä.
-- ---------------------------------------------------------------------

create table public.commute_observations (
  id                   text primary key,
  user_id              uuid not null default auth.uid()
                       references auth.users(id) on delete cascade,

  place_id             text not null,
  -- EI VIERASAVAIN: menon poisto ei tee toteutuneesta matkasta tekemätöntä.
  event_id             text,
  observed_on          date not null,
  -- ISO-viikonpäivä 1–7: matka-aika riippuu usein viikonpäivästä.
  weekday              smallint not null,

  planned_departure    time,
  actual_departure     time,
  arrival_at           time,

  -- Toteutunut matka-aika. NULL = ei tiedossa, EI nolla.
  travel_minutes       integer,
  -- Liikennetiedon arvio lähtöhetkellä, jos sellainen oli. Ei keksitty.
  provider_minutes     integer,
  preparation_minutes  integer,
  overhead_minutes     integer,

  -- early | on_time | late
  arrival_result       text,
  -- user_confirmed | departure_ack
  source               text not null default 'user_confirmed',

  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

alter table public.commute_observations
  add constraint commute_observations_event_id_check
  check (event_id is null or length(event_id) between 1 and 100);

alter table public.commute_observations
  add constraint commute_observations_weekday_check
  check (weekday between 1 and 7);

alter table public.commute_observations
  add constraint commute_observations_travel_check
  check (travel_minutes is null or travel_minutes between 1 and 1440);

alter table public.commute_observations
  add constraint commute_observations_provider_check
  check (provider_minutes is null or provider_minutes between 1 and 1440);

alter table public.commute_observations
  add constraint commute_observations_preparation_check
  check (preparation_minutes is null or preparation_minutes between 0 and 480);

alter table public.commute_observations
  add constraint commute_observations_overhead_check
  check (overhead_minutes is null or overhead_minutes between 0 and 240);

alter table public.commute_observations
  add constraint commute_observations_result_check
  check (arrival_result is null or arrival_result in ('early', 'on_time', 'late'));

alter table public.commute_observations
  add constraint commute_observations_source_check
  check (source in ('user_confirmed', 'departure_ack'));

alter table public.commute_observations
  add constraint commute_observations_owner_row_key unique (user_id, id);

-- Havainto ilman paikkaa ei opeta mitään: paikan poisto vie havainnot.
alter table public.commute_observations
  add constraint commute_observations_place_fkey
  foreign key (user_id, place_id) references public.saved_places (user_id, id)
  on delete cascade;

create index commute_observations_user_place_idx
  on public.commute_observations (user_id, place_id, observed_on);

alter table public.commute_observations enable row level security;

create policy commute_observations_select_own on public.commute_observations
  for select to authenticated using (auth.uid() = user_id);
create policy commute_observations_insert_own on public.commute_observations
  for insert to authenticated with check (auth.uid() = user_id);
create policy commute_observations_update_own on public.commute_observations
  for update to authenticated using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
create policy commute_observations_delete_own on public.commute_observations
  for delete to authenticated using (auth.uid() = user_id);

revoke all on public.commute_observations from public;
revoke all on public.commute_observations from anon;
revoke all on public.commute_observations from authenticated;
grant select, insert, update, delete on public.commute_observations to authenticated;

create trigger commute_observations_touch_updated_at
  before update on public.commute_observations
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------
-- VAIHE 5: life_settings
--
-- YKSI RIVI KÄYTTÄJÄÄ KOHTI (life_settings_one_per_user). Puuttuva rivi
-- = oletukset (src/domain/lifeSettings.js DEFAULT_LIFE_SETTINGS).
--
-- jsonb-rakenteet (herätys, aamurutiini, ateriarytmi, toimitustapa)
-- tarkistetaan sovelluksessa kentittäin; kanta rajaa tyypin ja koon,
-- jotta yksikään kirjoitus ei voi kasvattaa riviä rajatta.
-- ---------------------------------------------------------------------

create table public.life_settings (
  id                              text primary key,
  user_id                         uuid not null default auth.uid()
                                  references auth.users(id) on delete cascade,

  -- Viikonlopun herätys ja nukkumaanmeno saavat liukua enintään näin paljon.
  weekend_wake_shift_max_minutes  integer not null default 60,
  weekend_bed_shift_max_minutes   integer not null default 60,
  wind_down_minutes               integer not null default 30,
  bedtime_target                  time,
  -- "Mieluummin ajoissa kuin myöhässä": oletus perilläolon varmuusajaksi.
  arrival_buffer_minutes          integer not null default 10,

  -- rauhallinen | napakka | aktiivinen
  guidance_style                  text not null default 'rauhallinen',
  -- Puhe on aina käyttäjän oma valinta: oletus ei puhu.
  speech_enabled                  boolean not null default false,
  morning_brief_enabled           boolean not null default false,
  -- Käyttäjän hyväksymä muistutusten aikaistus (ei koskaan automaattinen).
  reminder_offset_minutes         integer not null default 0,
  digest_enabled                  boolean not null default false,
  digest_time                     time not null default '18:00',
  sleep_affects_capacity          boolean not null default false,

  -- Oma tuntiarvo sentteinä ("ostos = N työtuntia"). NULL = ei asetettu.
  hourly_value_minor              bigint,
  currency                        text not null default 'EUR',

  alarm                           jsonb not null default '{}'::jsonb,
  morning_routine                 jsonb not null default '[]'::jsonb,
  meal_rhythm                     jsonb not null default '{}'::jsonb,
  delivery                        jsonb not null default '{}'::jsonb,

  created_at                      timestamptz not null default now(),
  updated_at                      timestamptz not null default now()
);

-- YKSI ASETUSRIVI KÄYTTÄJÄÄ KOHTI. Toinen laite ei voi luoda toista
-- riviä: lisäys kaatuu koodilla 23505, ja sovellus päivittää olemassa
-- olevaa.
alter table public.life_settings
  add constraint life_settings_one_per_user unique (user_id);

alter table public.life_settings
  add constraint life_settings_weekend_wake_check
  check (weekend_wake_shift_max_minutes between 0 and 240);

alter table public.life_settings
  add constraint life_settings_weekend_bed_check
  check (weekend_bed_shift_max_minutes between 0 and 240);

alter table public.life_settings
  add constraint life_settings_wind_down_check
  check (wind_down_minutes between 0 and 180);

alter table public.life_settings
  add constraint life_settings_arrival_buffer_check
  check (arrival_buffer_minutes between 0 and 120);

alter table public.life_settings
  add constraint life_settings_guidance_check
  check (guidance_style in ('rauhallinen', 'napakka', 'aktiivinen'));

alter table public.life_settings
  add constraint life_settings_reminder_offset_check
  check (reminder_offset_minutes between 0 and 60);

alter table public.life_settings
  add constraint life_settings_hourly_value_check
  check (hourly_value_minor is null or hourly_value_minor between 1 and 1000000000);

alter table public.life_settings
  add constraint life_settings_currency_check
  check (currency ~ '^[A-Z]{3}$');

alter table public.life_settings
  add constraint life_settings_alarm_check
  check (jsonb_typeof(alarm) = 'object' and pg_column_size(alarm) <= 8192);

alter table public.life_settings
  add constraint life_settings_morning_routine_check
  check (jsonb_typeof(morning_routine) = 'array' and pg_column_size(morning_routine) <= 8192);

alter table public.life_settings
  add constraint life_settings_meal_rhythm_check
  check (jsonb_typeof(meal_rhythm) = 'object' and pg_column_size(meal_rhythm) <= 8192);

alter table public.life_settings
  add constraint life_settings_delivery_check
  check (jsonb_typeof(delivery) = 'object' and pg_column_size(delivery) <= 4096);

alter table public.life_settings
  add constraint life_settings_owner_row_key unique (user_id, id);

alter table public.life_settings enable row level security;

create policy life_settings_select_own on public.life_settings
  for select to authenticated using (auth.uid() = user_id);
create policy life_settings_insert_own on public.life_settings
  for insert to authenticated with check (auth.uid() = user_id);
create policy life_settings_update_own on public.life_settings
  for update to authenticated using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
create policy life_settings_delete_own on public.life_settings
  for delete to authenticated using (auth.uid() = user_id);

revoke all on public.life_settings from public;
revoke all on public.life_settings from anon;
revoke all on public.life_settings from authenticated;
grant select, insert, update, delete on public.life_settings to authenticated;

create trigger life_settings_touch_updated_at
  before update on public.life_settings
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------
-- VAIHE 6: sleep_logs
--
-- VUOTEESSA OLON AIKA, EI MITATTU UNI. Yksi rivi heräämispäivää kohti.
-- Kellonajat ovat `time`: yö ylittää keskiyön, ja heräämispäivä kertoo,
-- mihin yöhön rivi kuuluu.
-- ---------------------------------------------------------------------

create table public.sleep_logs (
  id               text primary key,
  user_id          uuid not null default auth.uid()
                   references auth.users(id) on delete cascade,

  wake_date        date not null,
  planned_bedtime  time,
  actual_bedtime   time,
  planned_wake     time,
  actual_wake      time,

  -- user | alarm
  source           text not null default 'user',
  -- opportunity | measured
  kind             text not null default 'opportunity',

  note             text,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

alter table public.sleep_logs
  add constraint sleep_logs_wake_date_unique unique (user_id, wake_date);

alter table public.sleep_logs
  add constraint sleep_logs_source_check
  check (source in ('user', 'alarm'));

alter table public.sleep_logs
  add constraint sleep_logs_kind_check
  check (kind in ('opportunity', 'measured'));

alter table public.sleep_logs
  add constraint sleep_logs_note_check
  check (note is null or length(note) <= 500);

alter table public.sleep_logs
  add constraint sleep_logs_owner_row_key unique (user_id, id);

alter table public.sleep_logs enable row level security;

create policy sleep_logs_select_own on public.sleep_logs
  for select to authenticated using (auth.uid() = user_id);
create policy sleep_logs_insert_own on public.sleep_logs
  for insert to authenticated with check (auth.uid() = user_id);
create policy sleep_logs_update_own on public.sleep_logs
  for update to authenticated using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
create policy sleep_logs_delete_own on public.sleep_logs
  for delete to authenticated using (auth.uid() = user_id);

revoke all on public.sleep_logs from public;
revoke all on public.sleep_logs from anon;
revoke all on public.sleep_logs from authenticated;
grant select, insert, update, delete on public.sleep_logs to authenticated;

create trigger sleep_logs_touch_updated_at
  before update on public.sleep_logs
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------
-- VAIHE 7: habit_plans
--
-- Tavan muutoksen suunnitelma käyttäjän omilla luvuilla: väli, päivän
-- tavoite, lähtötaso ja porrastus (`steps`: [{from, intervalMinutes,
-- dailyTarget}]). Ei väestönormeja, ei lääketieteellisiä väitteitä.
-- ---------------------------------------------------------------------

create table public.habit_plans (
  id                    text primary key,
  user_id               uuid not null default auth.uid()
                        references auth.users(id) on delete cascade,

  -- nicotine | generic
  kind                  text not null default 'generic',
  name                  text not null,
  min_interval_minutes  integer,
  daily_target          integer,
  baseline_per_day      integer,
  steps                 jsonb not null default '[]'::jsonb,
  -- Hiljainen oletus: muistutus ei kuulu, ellei käyttäjä valitse toisin.
  reminder_delivery     text not null default 'silent',
  -- Yksikön hinta sentteinä (säästön laskemiseen). NULL = ei asetettu.
  unit_cost_minor       bigint,
  active                boolean not null default true,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

alter table public.habit_plans
  add constraint habit_plans_kind_check
  check (kind in ('nicotine', 'generic'));

alter table public.habit_plans
  add constraint habit_plans_name_check
  check (length(btrim(name)) > 0 and length(name) <= 80);

alter table public.habit_plans
  add constraint habit_plans_min_interval_check
  check (min_interval_minutes is null or min_interval_minutes between 1 and 1440);

alter table public.habit_plans
  add constraint habit_plans_daily_target_check
  check (daily_target is null or daily_target between 0 and 200);

alter table public.habit_plans
  add constraint habit_plans_baseline_check
  check (baseline_per_day is null or baseline_per_day between 0 and 200);

alter table public.habit_plans
  add constraint habit_plans_steps_check
  check (jsonb_typeof(steps) = 'array' and pg_column_size(steps) <= 8192);

alter table public.habit_plans
  add constraint habit_plans_delivery_check
  check (reminder_delivery in ('silent', 'vibrate', 'sound', 'speech',
                               'sound_and_speech', 'critical_escalation'));

alter table public.habit_plans
  add constraint habit_plans_unit_cost_check
  check (unit_cost_minor is null or unit_cost_minor between 0 and 10000000);

alter table public.habit_plans
  add constraint habit_plans_owner_row_key unique (user_id, id);

alter table public.habit_plans enable row level security;

create policy habit_plans_select_own on public.habit_plans
  for select to authenticated using (auth.uid() = user_id);
create policy habit_plans_insert_own on public.habit_plans
  for insert to authenticated with check (auth.uid() = user_id);
create policy habit_plans_update_own on public.habit_plans
  for update to authenticated using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
create policy habit_plans_delete_own on public.habit_plans
  for delete to authenticated using (auth.uid() = user_id);

revoke all on public.habit_plans from public;
revoke all on public.habit_plans from anon;
revoke all on public.habit_plans from authenticated;
grant select, insert, update, delete on public.habit_plans to authenticated;

create trigger habit_plans_touch_updated_at
  before update on public.habit_plans
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------
-- VAIHE 8: habit_events
--
-- NEUTRAALI KIRJAUS: use | delay | skip. Ei "retkahdusta" eikä
-- "epäonnistumista" kannassakaan.
-- ---------------------------------------------------------------------

create table public.habit_events (
  id           text primary key,
  user_id      uuid not null default auth.uid()
               references auth.users(id) on delete cascade,

  plan_id      text not null,
  occurred_at  timestamptz not null,
  -- use | delay | skip
  action       text not null,
  note         text,

  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

alter table public.habit_events
  add constraint habit_events_action_check
  check (action in ('use', 'delay', 'skip'));

alter table public.habit_events
  add constraint habit_events_note_check
  check (note is null or length(note) <= 200);

alter table public.habit_events
  add constraint habit_events_owner_row_key unique (user_id, id);

-- Kirjaus ilman suunnitelmaa ei tarkoita mitään: suunnitelman poisto
-- vie sen kirjaukset.
alter table public.habit_events
  add constraint habit_events_plan_fkey
  foreign key (user_id, plan_id) references public.habit_plans (user_id, id)
  on delete cascade;

create index habit_events_user_plan_idx
  on public.habit_events (user_id, plan_id, occurred_at);

alter table public.habit_events enable row level security;

create policy habit_events_select_own on public.habit_events
  for select to authenticated using (auth.uid() = user_id);
create policy habit_events_insert_own on public.habit_events
  for insert to authenticated with check (auth.uid() = user_id);
create policy habit_events_update_own on public.habit_events
  for update to authenticated using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
create policy habit_events_delete_own on public.habit_events
  for delete to authenticated using (auth.uid() = user_id);

revoke all on public.habit_events from public;
revoke all on public.habit_events from anon;
revoke all on public.habit_events from authenticated;
grant select, insert, update, delete on public.habit_events to authenticated;

create trigger habit_events_touch_updated_at
  before update on public.habit_events
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------
-- VAIHE 9: exercise_sessions
--
-- Suunniteltu ja toteutunut liikuntakerta. Kuormittavuus ja palautumisen
-- tarve ovat käyttäjän omia arvioita 1–5; NULL = ei arvioitu, EI nolla.
-- ---------------------------------------------------------------------

create table public.exercise_sessions (
  id               text primary key,
  user_id          uuid not null default auth.uid()
                   references auth.users(id) on delete cascade,

  session_date     date not null,
  -- Käyttäjän oma nimike ("juoksu", "sali").
  kind             text not null,
  planned_minutes  integer,
  actual_minutes   integer,
  intensity        smallint,
  recovery_demand  smallint,
  goal_id          text,
  note             text,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

alter table public.exercise_sessions
  add constraint exercise_sessions_kind_check
  check (length(btrim(kind)) > 0 and length(kind) <= 60);

alter table public.exercise_sessions
  add constraint exercise_sessions_planned_check
  check (planned_minutes is null or planned_minutes between 1 and 1440);

alter table public.exercise_sessions
  add constraint exercise_sessions_actual_check
  check (actual_minutes is null or actual_minutes between 1 and 1440);

alter table public.exercise_sessions
  add constraint exercise_sessions_intensity_check
  check (intensity is null or intensity between 1 and 5);

alter table public.exercise_sessions
  add constraint exercise_sessions_recovery_check
  check (recovery_demand is null or recovery_demand between 1 and 5);

alter table public.exercise_sessions
  add constraint exercise_sessions_note_check
  check (note is null or length(note) <= 500);

alter table public.exercise_sessions
  add constraint exercise_sessions_owner_row_key unique (user_id, id);

-- Tavoitteen poisto ei vie liikuntakertaa: kerta jää, liitos katkeaa.
alter table public.exercise_sessions
  add constraint exercise_sessions_goal_fkey
  foreign key (user_id, goal_id) references public.goals (user_id, id)
  on delete set null (goal_id);

create index exercise_sessions_user_date_idx
  on public.exercise_sessions (user_id, session_date);

alter table public.exercise_sessions enable row level security;

create policy exercise_sessions_select_own on public.exercise_sessions
  for select to authenticated using (auth.uid() = user_id);
create policy exercise_sessions_insert_own on public.exercise_sessions
  for insert to authenticated with check (auth.uid() = user_id);
create policy exercise_sessions_update_own on public.exercise_sessions
  for update to authenticated using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
create policy exercise_sessions_delete_own on public.exercise_sessions
  for delete to authenticated using (auth.uid() = user_id);

revoke all on public.exercise_sessions from public;
revoke all on public.exercise_sessions from anon;
revoke all on public.exercise_sessions from authenticated;
grant select, insert, update, delete on public.exercise_sessions to authenticated;

create trigger exercise_sessions_touch_updated_at
  before update on public.exercise_sessions
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------
-- VAIHE 10: wellbeing_checkins
--
-- Motivaatio ja hallinnan tunne 1–5, yksi rivi päivää kohti. Näytetään
-- saman päivän energian, mielialan ja kuormituksen (wellbeing_entries,
-- 0006) rinnalla; 0006:n taulua EI muuteta. NULL = ei vastattu, EI nolla.
-- ---------------------------------------------------------------------

create table public.wellbeing_checkins (
  id          text primary key,
  user_id     uuid not null default auth.uid()
              references auth.users(id) on delete cascade,

  date        date not null,
  motivation  smallint,
  -- "Hallinnan tunne": kuinka hyvin arki tuntuu olevan omissa käsissä.
  control     smallint,

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table public.wellbeing_checkins
  add constraint wellbeing_checkins_motivation_check
  check (motivation is null or motivation between 1 and 5);

alter table public.wellbeing_checkins
  add constraint wellbeing_checkins_control_check
  check (control is null or control between 1 and 5);

alter table public.wellbeing_checkins
  add constraint wellbeing_checkins_date_unique unique (user_id, date);

alter table public.wellbeing_checkins
  add constraint wellbeing_checkins_owner_row_key unique (user_id, id);

alter table public.wellbeing_checkins enable row level security;

create policy wellbeing_checkins_select_own on public.wellbeing_checkins
  for select to authenticated using (auth.uid() = user_id);
create policy wellbeing_checkins_insert_own on public.wellbeing_checkins
  for insert to authenticated with check (auth.uid() = user_id);
create policy wellbeing_checkins_update_own on public.wellbeing_checkins
  for update to authenticated using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
create policy wellbeing_checkins_delete_own on public.wellbeing_checkins
  for delete to authenticated using (auth.uid() = user_id);

revoke all on public.wellbeing_checkins from public;
revoke all on public.wellbeing_checkins from anon;
revoke all on public.wellbeing_checkins from authenticated;
grant select, insert, update, delete on public.wellbeing_checkins to authenticated;

create trigger wellbeing_checkins_touch_updated_at
  before update on public.wellbeing_checkins
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------
-- VAIHE 11: invarianttien todistus ENNEN COMMITTIA
-- ---------------------------------------------------------------------

do $$
declare
  n integer;
begin
  select count(*) into n from pg_policies
   where schemaname = 'public'
     and tablename in ('saved_places', 'place_aliases', 'calendar_events',
                       'commute_observations', 'life_settings', 'sleep_logs',
                       'habit_plans', 'habit_events', 'exercise_sessions',
                       'wellbeing_checkins');
  if n <> 40 then
    raise exception 'Odotettiin 40 politiikkaa, loytyi %.', n;
  end if;

  select count(*) into n from pg_class
   where relnamespace = 'public'::regnamespace
     and relname in ('saved_places', 'place_aliases', 'calendar_events',
                     'commute_observations', 'life_settings', 'sleep_logs',
                     'habit_plans', 'habit_events', 'exercise_sessions',
                     'wellbeing_checkins')
     and relrowsecurity;
  if n <> 10 then
    raise exception 'RLS ei ole paalla kaikissa kymmenessa uudessa taulussa (%/10).', n;
  end if;

  -- POISTOSAANTO RAJAA NOLLAUKSEN SARAKKEESEEN (3 nollaavaa viitetta).
  select count(*) into n from pg_constraint
   where conname in ('calendar_events_place_fkey', 'calendar_events_goal_fkey',
                     'exercise_sessions_goal_fkey')
     and confdeltype = 'n'
     and array_length(confdelsetcols, 1) = 1;
  if n <> 3 then
    raise exception 'Poistosaanto ei rajaa nollausta sarakkeeseen (%/3).', n;
  end if;

  -- KASKADI: paikan tai suunnitelman poisto vie vain sen omat lapsirivit.
  select count(*) into n from pg_constraint
   where conname in ('place_aliases_place_fkey', 'commute_observations_place_fkey',
                     'habit_events_plan_fkey')
     and contype = 'f'
     and confdeltype = 'c'
     and array_length(conkey, 1) = 2;
  if n <> 3 then
    raise exception 'Lapsirivien kaskadi ei ole yhdistelmavierasavain (%/3).', n;
  end if;

  -- YKSI ASETUSRIVI KAYTTAJAA KOHTI on rakenteellinen.
  if not exists (
    select 1 from pg_constraint
     where conname = 'life_settings_one_per_user' and contype = 'u'
  ) then
    raise exception 'life_settings_one_per_user puuttuu. Asetusrivin ainutkertaisuus ei ole rakenteellinen.';
  end if;

  -- PUBLIC-ROOLIN OIKEUDET LUETAAN SUORAAN ACL:STA (grantee = 0).
  select count(*) into n
    from pg_class c,
         lateral aclexplode(c.relacl) a
   where c.relnamespace = 'public'::regnamespace
     and c.relname in ('saved_places', 'place_aliases', 'calendar_events',
                       'commute_observations', 'life_settings', 'sleep_logs',
                       'habit_plans', 'habit_events', 'exercise_sessions',
                       'wellbeing_checkins')
     and a.grantee = 0;
  if n <> 0 then
    raise exception 'PUBLIC-roolilla on % oikeutta uusiin tauluihin.', n;
  end if;

  -- TEHOLLISET OIKEUDET.
  if has_table_privilege('anon', 'public.saved_places', 'select')
     or has_table_privilege('anon', 'public.place_aliases', 'select')
     or has_table_privilege('anon', 'public.calendar_events', 'select')
     or has_table_privilege('anon', 'public.commute_observations', 'select')
     or has_table_privilege('anon', 'public.life_settings', 'select')
     or has_table_privilege('anon', 'public.sleep_logs', 'select')
     or has_table_privilege('anon', 'public.habit_plans', 'select')
     or has_table_privilege('anon', 'public.habit_events', 'select')
     or has_table_privilege('anon', 'public.exercise_sessions', 'select')
     or has_table_privilege('anon', 'public.wellbeing_checkins', 'select') then
    raise exception 'anon-roolilla on lukuoikeus uusiin tauluihin.';
  end if;

  if not has_table_privilege('authenticated', 'public.saved_places', 'select')
     or not has_table_privilege('authenticated', 'public.calendar_events', 'insert')
     or not has_table_privilege('authenticated', 'public.life_settings', 'update') then
    raise exception 'authenticated-roolilta puuttuu oikeus uusiin tauluihin.';
  end if;

  -- OLEMASSA OLEVAT POLITIIKAT OVAT KOSKEMATTOMIA: sama maara kuin
  -- 0013:n jalkeen (8 taulua x 4 + 0013:n 2 taulua x 4).
  select count(*) into n from pg_policies
   where schemaname = 'public'
     and tablename in ('tasks', 'goals', 'projects', 'routines',
                       'life_areas', 'weekly_capacities', 'time_entries',
                       'alignment_reviews', 'running_timers', 'alignment_item_settings');
  if n <> 40 then
    raise exception 'Olemassa olevien taulujen politiikat muuttuivat: % (odotus 40).', n;
  end if;

  raise notice 'Migraatio 0014 valmis. Aja seuraavaksi supabase/verify/verify_0014.sql.';
end $$;

commit;

-- =====================================================================
-- HYVÄKSYNTÄPORTTI
-- =====================================================================
--
-- TÄTÄ EI OLE AJETTU EIKÄ SAA AJAA ILMAN NIMENOMAISTA HYVÄKSYNTÄÄ.
--
-- Ennen ajoa vaaditaan:
--   1. Panun kirjallinen hyväksyntä ("hyväksyn 0014/K")
--   2. Migraatio 0013 ajettu JA supabase/verify/verify_0013.sql läpi
--   3. supabase/preflight/preflight_0014.sql (vain luku) -> 0 FAIL
--   4. Ajo postgres-roolilla Supabasen SQL-editorissa
--   5. supabase/verify/verify_0014.sql -> 0 poikkeavaa
--   6. Vasta sitten portit src/data/schema.js:ssä (TABLES.savedPlaces …
--      TABLES.wellbeingCheckins, kaikki kymmenen yhdessä) — ja vain
--      julkaisuaallon K mukana (välimuisti v24).
--
-- VARMUUSKOPIO EI OLE PAKOLLINEN: migraatio luo vain uusia tyhjiä
-- tauluja eikä kirjoita yhteenkään olemassa olevaan riviin. Tilan 0013
-- tilannekuva (supabase/backup/snapshot_state_0013.sql) on silti hyvä
-- tapa, jos se on helppo ottaa.
--
-- ESITARKISTUS (vain lukeva, turvallinen ajaa milloin tahansa):
--
--   select
--     (select count(*) from pg_tables where schemaname='public'
--       and tablename in ('running_timers','alignment_item_settings')) as suunta2_0013,
--     (select count(*) from pg_tables where schemaname='public'
--       and tablename in ('saved_places','calendar_events','life_settings')) as uudet_0014,
--     (select count(*) from pg_constraint
--       where conname = 'goals_owner_row_key') as tavoitteen_avain,
--     (select current_setting('server_version_num')::int >= 150000) as pg15_tai_uudempi;
--
--   Odotus ennen ajoa: 2, 0, 1, true
--
-- Täydellinen esitarkistus: supabase/preflight/preflight_0014.sql.
--
-- =====================================================================
-- VAIKUTUS OLEMASSA OLEVAAN DATAAN
-- =====================================================================
--
--   EI MITÄÄN.
--
-- Kymmenen uutta tyhjää taulua. Yhtäkään olemassa olevaa saraketta,
-- rajoitetta, indeksiä tai riviä ei muuteta eikä poisteta. Vaihe 11
-- todistaa ennen committia, että olemassa olevien taulujen politiikat
-- ovat ennallaan.
--
-- =====================================================================
-- ROLLBACK
-- =====================================================================
--
-- PERUUTUS AINA KÄÄNTEISESSÄ JÄRJESTYKSESSÄ: tämä ensin, sitten 0013.
-- Lapsitaulut pudotetaan ennen vanhempiaan (vierasavaimet).
--
--   begin;
--   set local lock_timeout = '5s';
--
--   drop table public.wellbeing_checkins;
--   drop table public.exercise_sessions;
--   drop table public.habit_events;
--   drop table public.habit_plans;
--   drop table public.sleep_logs;
--   drop table public.life_settings;
--   drop table public.commute_observations;
--   drop table public.calendar_events;
--   drop table public.place_aliases;
--   drop table public.saved_places;
--
--   commit;
--
-- Taulun pudotus poistaa sen rajoitteet, indeksit, liipaisimet ja
-- politiikat mukanaan. Peruutus palauttaa kannan täsmälleen tilaan 0013,
-- koska migraatio ei koskenut olemassa olevaan dataan.
--
-- HUOM. Peruutus POISTAA rivit pysyvästi. Jos portit on ehditty avata ja
-- käyttäjä on tallentanut paikkoja, menoja, asetuksia, unikirjauksia,
-- tapojen kirjauksia tai liikuntakertoja, ne katoavat. Sulje portit
-- ensin (aallon K revert aaltoon J) ja ota tilannekuva
-- (supabase/backup/snapshot_state_0014.sql) ennen pudotusta.
--
-- Muista tällöin myös:
--   src/data/schema.js -> TABLES.savedPlaces … TABLES.wellbeingCheckins = false
--
-- =====================================================================
-- RISKIT
-- =====================================================================
--
--   MATALA   kymmenen uutta tyhjää taulua — eivät koske olemassa olevaan
--            dataan
--   MATALA   lukitus: vain auth.users ja goals vierasavainten luonnin
--            ajaksi (SHARE ROW EXCLUSIVE, lock_timeout 5 s); ei ALTER
--            TABLEa olemassa oleviin tauluihin
--   MATALA   peruutus on taulujen pudotus, ei rakenteen palautus
--   HUOMIO   arkaluonteiset tiedot (uni, motivaatio, hallinnan tunne,
--            nikotiini) — RLS neljällä omalla politiikalla, ei anonille
--            eikä PUBLICille; sovellus ei lähetä niitä tekoälylle eikä
--            lokiin
--
-- Ajon kesto on käytännössä välitön: kaikki kymmenen taulua ovat tyhjiä.
