-- =====================================================================
-- Manifestival — migraatio 0005: muistutusasetukset
-- =====================================================================
--
-- TILA: LUONNOS. TÄTÄ EI OLE AJETTU MIHINKÄÄN YMPÄRISTÖÖN.
--
-- ESIEHDOT
--   1. Migraatio 0001 on ajettu ja todennettu (user_id, RLS)
--   2. Varmuuskopio on otettu
--
-- TARKOITUS
-- Muistutus, jota ei voi säätää, muuttuu häiriöksi ja häiriö poistaa
-- sovelluksen. Siksi asetukset ovat oma taulunsa ja oletus on `enabled =
-- false`: mitään ei lähetetä ennen kuin käyttäjä on itse pyytänyt.
--
-- Tässä taulussa on täsmälleen yksi rivi per käyttäjä, kuten profile-
-- taulussa. Siksi omistajuus on id-sarakkeessa eikä erillisessä user_id-
-- sarakkeessa, ja politiikat kohdistuvat id:hen.
--
-- MITÄ TÄMÄ EI OLE
-- Tämä ei ole ilmoitusjono eikä lähetyshistoria. Ajastettuja ilmoituksia
-- ei toteuteta palvelimella tässä vaiheessa lainkaan: suunnitelman laskee
-- selain (src/domain/notification.js) ja näyttämisen tekee alusta
-- (src/platform/notifications.js). Ks. docs/NOTIFICATIONS.md.
--
-- KÄYTTÖÖNOTTO KOODISSA
-- Migraation jälkeen: src/data/schema.js -> TABLES.notificationPreferences = true.
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
-- VAIHE 1: notification_preferences
--
-- Oletusarvot vastaavat DEFAULT_PREFERENCES-oliota tiedostossa
-- src/domain/notification.js. Jos muutat toista, muuta toinenkin.
--
-- Kellonajat ovat text-tyyppisiä 'HH:MM'-merkkijonoja samasta syystä kuin
-- tasks.time: aika on paikallinen seinäkelloaika ilman aikavyöhykettä.
-- Klo 07:30 tarkoittaa herätystä puoli kahdeksalta riippumatta siitä, missä
-- käyttäjä sattuu olemaan.
-- ---------------------------------------------------------------------
create table if not exists public.notification_preferences (
  id                        uuid primary key default auth.uid()
                            references auth.users(id) on delete cascade,

  -- Pääkytkin. Oletus false: hiljaisuus on turvallinen oletus.
  enabled                   boolean not null default false,

  -- Kuinka monta minuuttia ennen alkua muistutetaan.
  task_lead_minutes         integer not null default 10,
  routine_lead_minutes      integer not null default 5,

  -- Päivän suunnitelma aamulla, katsaus illalla.
  daily_plan_time           text    not null default '07:30',
  evening_review_time       text    not null default '21:00',
  daily_plan_enabled        boolean not null default true,
  evening_review_enabled    boolean not null default true,
  deadline_warnings_enabled boolean not null default true,

  -- Kattoraja vuorokaudessa. Suojaa hälyltä silloinkin kun päivä on täynnä.
  max_per_day               integer not null default 12,

  -- Rauhoitusaika. Väli saa ylittää keskiyön (22:00 -> 06:30).
  quiet_hours_from          text    not null default '22:00',
  quiet_hours_to            text    not null default '06:30',

  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

alter table public.notification_preferences
  drop constraint if exists notification_preferences_lead_check;
alter table public.notification_preferences
  add constraint notification_preferences_lead_check
  check (task_lead_minutes between 0 and 240
     and routine_lead_minutes between 0 and 240);

alter table public.notification_preferences
  drop constraint if exists notification_preferences_max_per_day_check;
alter table public.notification_preferences
  add constraint notification_preferences_max_per_day_check
  check (max_per_day between 1 and 50);

-- Kellonaikojen muoto tarkistetaan kannassa asti: virheellinen aika
-- rikkoisi rauhoitusajan laskennan hiljaisesti.
alter table public.notification_preferences
  drop constraint if exists notification_preferences_time_format_check;
alter table public.notification_preferences
  add constraint notification_preferences_time_format_check
  check (
    daily_plan_time     ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
    and evening_review_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
    and quiet_hours_from ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
    and quiet_hours_to   ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
  );

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

drop trigger if exists notification_preferences_touch_updated_at
  on public.notification_preferences;
create trigger notification_preferences_touch_updated_at
  before update on public.notification_preferences
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------
-- VAIHE 3: RLS
--
-- Omistajuus on id-sarakkeessa, kuten profile-taulussa.
-- ---------------------------------------------------------------------
alter table public.notification_preferences enable row level security;

drop policy if exists notification_preferences_select_own on public.notification_preferences;
drop policy if exists notification_preferences_insert_own on public.notification_preferences;
drop policy if exists notification_preferences_update_own on public.notification_preferences;
drop policy if exists notification_preferences_delete_own on public.notification_preferences;

create policy notification_preferences_select_own on public.notification_preferences
  for select to authenticated using (auth.uid() = id);
create policy notification_preferences_insert_own on public.notification_preferences
  for insert to authenticated with check (auth.uid() = id);
create policy notification_preferences_update_own on public.notification_preferences
  for update to authenticated using (auth.uid() = id)
  with check (auth.uid() = id);
create policy notification_preferences_delete_own on public.notification_preferences
  for delete to authenticated using (auth.uid() = id);

revoke all on public.notification_preferences from anon;
grant select, insert, update, delete on public.notification_preferences to authenticated;

commit;

-- =====================================================================
-- VARMISTUS MIGRAATION JÄLKEEN (aja erikseen, vain luku)
-- =====================================================================
-- select column_name, column_default from information_schema.columns
--  where table_schema='public' and table_name='notification_preferences'
--    and column_name='enabled';
--   -> oletuksen pitää olla false
--
-- select tablename, policyname, roles from pg_policies
--  where schemaname='public' and tablename='notification_preferences';
--   -> roles aina {authenticated}
--
-- =====================================================================
-- ROLLBACK
-- =====================================================================
--   begin;
--   drop table if exists public.notification_preferences;
--   commit;
--
-- Muista tällöin palauttaa
-- src/data/schema.js -> TABLES.notificationPreferences = false.
