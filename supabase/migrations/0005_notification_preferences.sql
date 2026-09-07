-- =====================================================================
-- Manifestival — migraatio 0005: muistutusasetukset
-- =====================================================================
--
-- TILA: EI AJETTU TUOTANTOON.
--
-- ESIEHDOT
--   1. Migraatio 0001 on ajettu ja todennettu (user_id, RLS, 4 politiikkaa)
--   2. Migraatio 0002 on ajettu (tuotannon hyväksytty lähtötila)
--   3. Varmuuskopio on otettu
--      (supabase/preflight/recovery_snapshot_pre_0004_0008.sql)
--
-- Migraatiot 0003 ja 0004 EIVÄT ole esiehto: tämä taulu ei viittaa
-- yhteenkään niiden tauluun. Järjestys on silti se, jossa ne ajetaan.
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
-- Migraation JA hyväksyntätestin jälkeen:
-- src/data/schema.js -> TABLES.notificationPreferences = true.
--
-- =====================================================================
-- OMISTAJUUS: MIKSI TÄSSÄ EI TARVITA YHDISTELMÄVIERASAVAINTA
-- =====================================================================
-- Migraatiot 0003, 0004 ja 0007 joutuvat suojaamaan ristiinkiinnitykseltä
-- yhdistelmävierasavaimella, koska niissä rivi VIITTAA toiseen riviin ja
-- vierasavaimen tarkistus ei kulje RLS:n läpi.
--
-- Tässä taulussa sitä vaaraa ei ole, eikä siksi että se olisi hyväksytty
-- riski vaan koska rakenne sulkee sen pois:
--
--   id uuid primary key default auth.uid() references auth.users(id)
--
-- Omistaja EI ole erillinen sarake vaan pääavain itse. Rivillä ei ole
-- yhtään viittausta toiseen sovellustauluun, joten mitään mihin
-- kiinnittyä ei ole. Ja koska politiikat ovat `auth.uid() = id`, B ei voi
-- luoda riviä jonka id olisi A — WITH CHECK torjuu sen.
--
-- Sama malli on profile-taulussa migraatiosta 0001.
--
-- MITÄ TÄMÄ EI OLE
-- Tämä ei ole idempotentti migraatio, ja se on tarkoitus. Aiempi versio
-- käytti `if not exists` -muotoa, jolloin toinen ajo, kesken jäänyt ajo
-- ja tuore ajo näyttivät kaikki onnistuneelta. Tila, jota ei voi erottaa,
-- on tila jota ei voi korjata. Nyt migraatio laskee yhdeksän objektiaan
-- ja KESKEYTYY, jos yksikin niistä on jo olemassa.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- VAIHE 0: lukituksen aikakatkaisu
--
-- Migraatio luo vain uuden taulun eikä lukitse tasks- eikä profile-
-- taulua. Se KUITENKIN viittaa auth.users-tauluun, ja vierasavaimen
-- luonti ottaa viitattuun tauluun SHARE ROW EXCLUSIVE -lukon.
-- auth.users on taulu, jota jokainen kirjautuminen koskee.
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

  -- 2. 0001 on hyvaksytty: nelja omistajuuspolitiikkaa tasks-taulussa.
  select count(*) into olemassa
    from pg_policies where schemaname = 'public' and tablename = 'tasks';
  if olemassa <> 4 then
    raise exception 'tasks-taulussa on % politiikkaa, odotettiin 4. Tarkista 0001.', olemassa;
  end if;

  -- 3. profile-taulu on olemassa. Tama taulu kayttaa samaa
  --    omistajuusmallia (id = auth.uid()), ja jos profile puuttuu, malli
  --    ei ole se jota tama olettaa.
  if not exists (
    select 1 from pg_tables where schemaname = 'public' and tablename = 'profile'
  ) then
    raise exception 'profile-taulua ei ole. Aja migraatio 0001 ensin.';
  end if;

  -- 4. 0002 on ajettu.
  select count(*) into olemassa
    from information_schema.columns
   where table_schema = 'public' and table_name = 'tasks'
     and column_name in ('description', 'duration_minutes', 'priority',
                         'scheduling_state', 'created_at', 'updated_at');
  if olemassa <> 6 then
    raise exception 'Migraatio 0002 puuttuu: tasks-taulussa on % kuudesta lisasarakkeesta.', olemassa;
  end if;

  -- 5. Olen oikeassa tietokannassa.
  if not exists (select 1 from auth.users where id = omistaja) then
    raise exception 'Hyvaksyttya omistajaa % ei loydy auth.users-taulusta. Vaara projekti?', omistaja;
  end if;

  -- 6. OSITTAISEN TAI AIEMMAN AJON TUNNISTUS
  --
  --    Yhdeksan objektia: yksi taulu, kolme tarkistetta, yksi liipaisin
  --    ja nelja politiikkaa. Nolla = tuore ajo. Mika tahansa muu luku
  --    tarkoittaa, etta ajo on tehty tai jaanyt kesken — eika kumpaakaan
  --    korjata ajamalla uudelleen.
  --
  --    Funktio touch_updated_at EI ole listassa: sen luo migraatio 0002,
  --    joka on ajettu. Tama migraatio ei luo sita eika korvaa sita, vaan
  --    tarkistaa sen alla.
  select count(*) into olemassa from (
    select 1 from pg_tables
      where schemaname = 'public' and tablename = 'notification_preferences'
    union all
    select 1 from pg_constraint
      where conname in ('notification_preferences_lead_check',
                        'notification_preferences_max_per_day_check',
                        'notification_preferences_time_format_check')
    union all
    select 1 from pg_trigger
      where not tgisinternal
        and tgname = 'notification_preferences_touch_updated_at'
    union all
    select 1 from pg_policies
      where schemaname = 'public' and tablename = 'notification_preferences'
  ) kaikki;

  if olemassa = 9 then
    raise exception 'Migraatio 0005 on JO AJETTU. Ala aja uudelleen — aja supabase/verify/verify_0005.sql.';
  end if;

  if olemassa > 0 then
    select string_agg(nimi, ', ' order by nimi) into nimet from (
      select tablename::text as nimi from pg_tables
        where schemaname = 'public' and tablename = 'notification_preferences'
      union all
      select conname::text from pg_constraint
        where conname in ('notification_preferences_lead_check',
                          'notification_preferences_max_per_day_check',
                          'notification_preferences_time_format_check')
      union all
      select tgname::text from pg_trigger
        where not tgisinternal
          and tgname = 'notification_preferences_touch_updated_at'
      union all
      select policyname::text from pg_policies
        where schemaname = 'public' and tablename = 'notification_preferences'
    ) loydetyt;

    raise exception 'Migraatio 0005 on kesken: % objektia 9:sta on jo olemassa (%). Ks. docs/MIGRATION-0005-RECOVERY.md.',
      olemassa, nimet;
  end if;

  raise notice 'Esiehdot kunnossa. Omistaja %, 0005:n objekteja 0/9.', omistaja;
end $$;

-- ---------------------------------------------------------------------
-- VAIHE 0c: updated_at-funktio on olemassa JA kovennettu
--
-- Tämä migraatio EI luo eikä korvaa funktiota public.touch_updated_at().
-- Se on tietoinen ero aiempaan versioon, ja syy on tämä:
--
-- Tämän tiedoston aiempi versio sisälsi `create or replace function
-- public.touch_updated_at()` ILMAN määreitä `security invoker` ja
-- `set search_path`. Migraatio 0002 loi funktion kovennettuna ja se on
-- tuotannossa. Jos 0005 olisi ajettu sellaisenaan, se olisi HILJAA
-- korvannut kovennetun funktion kovettamattomalla.
--
-- Kyseessä ei ole tämän taulun ongelma. Sama funktio on liipaisimena
-- tauluissa tasks, routines, goals ja projects, ja se ajetaan jokaisessa
-- UPDATEssa. Kovennuksen menetys olisi näkynyt vain siinä, mitä ei enää
-- olisi ollut — ei missään virheessä.
--
-- Funktio luodaan kerran migraatiossa 0002. Myöhemmät migraatiot
-- tarkistavat sen, eivät kirjoita sitä uudelleen. Tarkistus ei voi
-- taantua samalla tavalla kuin määrittely.
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

  -- security definer ajaisi liipaisimen funktion omistajan oikeuksilla.
  if turvamaare then
    raise exception 'public.touch_updated_at() on SECURITY DEFINER. Se pitaa olla INVOKER.';
  end if;

  -- Kiinnitetty search_path: ilman sita funktion nimenselvitysta voi
  -- ohjata muuttamalla search_pathia kutsun ymparilla.
  if asetukset is null
     or not exists (select 1 from unnest(asetukset) a where a like 'search\_path=%') then
    raise exception 'public.touch_updated_at() ei kiinnita search_pathia.';
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
create table public.notification_preferences (
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
  add constraint notification_preferences_lead_check
  check (task_lead_minutes between 0 and 240
     and routine_lead_minutes between 0 and 240);

alter table public.notification_preferences
  add constraint notification_preferences_max_per_day_check
  check (max_per_day between 1 and 50);

-- Kellonaikojen muoto tarkistetaan kannassa asti: virheellinen aika
-- rikkoisi rauhoitusajan laskennan hiljaisesti.
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
create trigger notification_preferences_touch_updated_at
  before update on public.notification_preferences
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------
-- VAIHE 3: RLS
--
-- Omistajuus on id-sarakkeessa, kuten profile-taulussa.
-- ---------------------------------------------------------------------
alter table public.notification_preferences enable row level security;

create policy notification_preferences_select_own on public.notification_preferences
  for select to authenticated using (auth.uid() = id);
create policy notification_preferences_insert_own on public.notification_preferences
  for insert to authenticated with check (auth.uid() = id);
create policy notification_preferences_update_own on public.notification_preferences
  for update to authenticated using (auth.uid() = id)
  with check (auth.uid() = id);
create policy notification_preferences_delete_own on public.notification_preferences
  for delete to authenticated using (auth.uid() = id);

-- PUBLIC ENSIN, EIKA VAIN ANON.
--
-- PostgreSQL-rooli PUBLIC tarkoittaa "kaikki roolit", ja sille myonnetyn
-- oikeuden perii jokainen rooli — myos anon. Perittya oikeutta ei nay
-- roolikohtaisissa listauksissa lainkaan, joten `revoke ... from anon`
-- ei poista sita eika sen puuttumista huomaisi mistaan.
revoke all on public.notification_preferences from public;
revoke all on public.notification_preferences from anon;

-- Myos authenticated nollataan ensin, jotta lopputulos on TASAN nelja
-- oikeutta eika "nelja plus se mita oletusoikeudet sattuivat antamaan".
revoke all on public.notification_preferences from authenticated;

grant select, insert, update, delete on public.notification_preferences to authenticated;

-- ---------------------------------------------------------------------
-- VAIHE 4: loppuvarmistus ENNEN COMMITTIA
-- ---------------------------------------------------------------------
do $$
declare
  luku int;
begin
  if not exists (
    select 1 from pg_tables
     where schemaname = 'public' and tablename = 'notification_preferences'
  ) then
    raise exception 'Taulua notification_preferences ei syntynyt.';
  end if;

  if (select count(*) from public.notification_preferences) <> 0 then
    raise exception 'Uusi taulu ei ole tyhja. Jotain on jo kirjoitettu.';
  end if;

  -- RLS on paalla. Ilman tata taulu olisi kaikkien luettavissa heti
  -- syntyessaan.
  if not exists (
    select 1 from pg_class
     where relnamespace = 'public'::regnamespace
       and relname = 'notification_preferences' and relrowsecurity
  ) then
    raise exception 'RLS ei ole paalla taulussa notification_preferences.';
  end if;

  -- Nelja politiikkaa, kaikki authenticated-roolille.
  select count(*) into luku from pg_policies
   where schemaname = 'public' and tablename = 'notification_preferences'
     and roles = '{authenticated}'::name[];
  if luku <> 4 then
    raise exception 'Politiikkoja syntyi % neljan sijaan.', luku;
  end if;

  -- OMISTAJUUS ON ID-SARAKKEESSA.
  --
  -- Tama on taman taulun koko turvamalli. Jos politiikka viittaisi
  -- sarakkeeseen jota ei ole tai vaaraan sarakkeeseen, se ei
  -- valttamatta olisi virhe — se voisi olla vain aina tosi. Siksi
  -- ehdot luetaan ja verrataan.
  --
  -- MOLEMMAT PUOLET, ei kumpi tahansa. UPDATE-politiikalla on kaksi
  -- ehtoa: USING ratkaisee mita rivia saa muokata, WITH CHECK mihin sen
  -- saa muuttaa. Jos vain USING tarkistettaisiin, kayttaja voisi ottaa
  -- oman rivinsa ja kirjoittaa sen toisen nimiin. coalesce antaa
  -- puuttuvalle puolelle odotusarvon, jolloin vain LASNA OLEVA vaara
  -- ehto putoaa pois laskusta.
  select count(*) into luku from pg_policies
   where schemaname = 'public' and tablename = 'notification_preferences'
     and coalesce(btrim(replace(qual,       ' ', ''), '()'), 'auth.uid()=id') = 'auth.uid()=id'
     and coalesce(btrim(replace(with_check, ' ', ''), '()'), 'auth.uid()=id') = 'auth.uid()=id';
  if luku <> 4 then
    raise exception 'Vain %/4 politiikkaa rajaa omistajuuden id-sarakkeella.', luku;
  end if;

  -- Hiljaisuus on oletus. Jos enabled saisi oletukseksi true, jokainen
  -- uusi kayttaja alkaisi saada ilmoituksia pyytamatta.
  if (select column_default from information_schema.columns
       where table_schema = 'public' and table_name = 'notification_preferences'
         and column_name = 'enabled') is distinct from 'false' then
    raise exception 'Sarakkeen enabled oletus ei ole false.';
  end if;

  -- Taulussa ei ole yhtaan viittausta toiseen sovellustauluun. Tama on
  -- se vaite, jonka nojalla yhdistelmavierasavainta ei tarvita; jos
  -- viittaus joskus lisataan, se on lisattava yhdistelmana ja tama
  -- tarkistus on paivitettava samalla.
  select count(*) into luku
    from pg_constraint con
    join pg_class ft on ft.oid = con.confrelid
   where con.conrelid = 'public.notification_preferences'::regclass
     and con.contype = 'f'
     and ft.relnamespace = 'public'::regnamespace;
  if luku <> 0 then
    raise exception 'Taulussa on % viitetta public-skeemaan. Omistajuusmalli ei enaa pade.', luku;
  end if;

  -- anon ei saa mitaan, edes perittyna.
  select count(*) into luku
    from (select unnest(array['select', 'insert', 'update', 'delete',
                              'truncate', 'references', 'trigger']) as oikeus) pp
   where has_table_privilege('anon', 'public.notification_preferences', pp.oikeus);
  if luku <> 0 then
    raise exception 'anon-roolilla on % tehollista oikeutta uuteen tauluun.', luku;
  end if;

  -- PUBLIC-roolilla ei saa olla mitaan, ja tama katsotaan TAULUN
  -- OIKEUSLISTASTA eika roolikohtaisesti. Kaksi menetelmaa, koska
  -- kumpikaan ei yksin riita: has_table_privilege kertoo ONKO oikeus
  -- (perinta mukaan lukien), aclexplode kertoo MISTA se tulee.
  select count(*) into luku
    from pg_class cl, aclexplode(cl.relacl) acl
   where cl.oid = 'public.notification_preferences'::regclass
     and acl.grantee = 0;
  if luku <> 0 then
    raise exception 'PUBLIC-roolilla on % oikeutta uuteen tauluun.', luku;
  end if;

  -- authenticated saa tasan CRUD, ei enempaa.
  select count(*) into luku
    from (select unnest(array['select', 'insert', 'update', 'delete',
                              'truncate', 'references', 'trigger']) as oikeus) pp
   where has_table_privilege('authenticated', 'public.notification_preferences', pp.oikeus);
  if luku <> 4 then
    raise exception 'authenticated-roolilla on % oikeutta, odotettiin 4 (CRUD).', luku;
  end if;

  raise notice 'Migraatio 0005 valmis. Aja seuraavaksi supabase/verify/verify_0005.sql.';
end $$;

commit;

-- =====================================================================
-- VARMISTUS MIGRAATION JÄLKEEN
-- =====================================================================
-- supabase/verify/verify_0005.sql — yksi lause, yksi taulukko.
--
-- =====================================================================
-- ROLLBACK
-- =====================================================================
--   begin;
--   set local lock_timeout = '5s';
--   drop table if exists public.notification_preferences;
--   commit;
--
-- Rollback EI koske funktioon public.touch_updated_at(): tämä migraatio
-- ei luonut sitä.
--
-- Muista tällöin palauttaa
-- src/data/schema.js -> TABLES.notificationPreferences = false.
