-- =====================================================================
-- Manifestival — migraatio 0002: tehtävän domain-kentät
-- =====================================================================
--
-- TILA: EI AJETTU TUOTANTOON. Sovitettu 0001:n hyväksyttyyn lähtötilaan.
--
-- ESIEHDOT
--   1. Migraatio 0001 on ajettu ja hyväksytty (user_id, RLS, 8 politiikkaa)
--   2. Tuore varmuuskopio on otettu
--   3. Sovellus on suljettu laitteilta lyhyen katkon ajaksi
--
-- TARKOITUS
-- Konseptidokumentin luku 9 määrittelee tehtävälle keston, määräajan,
-- prioriteetin ja tilan. Nykyisessä taulussa on vain otsikko, päivä, aika ja
-- kategoria. Domain-malli (src/domain/task.js) ja käyttöliittymä on jo
-- kirjoitettu näille kentille, mutta ne eivät säily tallennuksen yli ennen
-- kuin tämä migraatio on ajettu.
--
-- KÄYTTÖÖNOTTO KOODISSA
-- Migraation ja verify_0002:n JÄLKEEN: src/data/schema.js ->
-- TASK_EXTENDED_FIELDS = true. Se on tarkoituksella yhden rivin muutos.
--
-- MIKSI TÄMÄ ON TURVALLINEN
-- Migraatio on lähes puhtaasti additiivinen: se lisää sarakkeita eikä
-- poista eikä muuta yhtäkään olemassa olevaa arvoa. Ainoa kirjoitus
-- olemassa oleviin riveihin on `scheduling_state`-sarakkeen täyttö, ja se
-- kirjoittaa sarakkeeseen, joka oli sekuntia aiemmin olemassa tyhjänä.
--
-- MITÄ TÄMÄ EI OLE
-- Tämä ei ole idempotentti migraatio. Se on TARKOITUS. Aiempi versio
-- käytti `if not exists` -muotoa joka kohdassa, jolloin toinen ajo,
-- kesken jäänyt ajo ja tuore ajo näyttivät kaikki samalta: onnistuneelta.
-- Tila, jota ei voi erottaa, on tila jota ei voi korjata. Nyt migraatio
-- tunnistaa aiemman ajon ja KESKEYTYY.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- VAIHE 0: vakiot
--
-- Omistaja on kirjoitettu auki. Se ei ole tälle migraatiolle
-- toiminnallisesti välttämätön — 0002 ei jaa omistajuutta — mutta se
-- vastaa kysymykseen "olenko oikeassa tietokannassa". Väärään projektiin
-- ajettu migraatio on kalliimpi virhe kuin keskeytynyt migraatio.
-- ---------------------------------------------------------------------
create temporary table _migration_0002_params on commit drop as
select '2cc00622-f927-4604-a518-361a4328481b'::uuid as owner_user_id;

-- ---------------------------------------------------------------------
-- VAIHE 1A: taulu on olemassa
-- ---------------------------------------------------------------------
do $$
begin
  if to_regclass('public.tasks') is null then
    raise exception 'public.tasks puuttuu. Aja migraatio 0001 ensin.';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- VAIHE 1B: LUKITUS ENNEN KUIN MIHINKÄÄN LUOTETAAN
--
-- Pelkkä `begin` ei jäädytä taulua. READ COMMITTED -tasolla jokainen
-- lause näkee oman tuoreen tilannekuvansa, joten esiehto voisi olla tosi
-- silloin kun se luetaan ja epätosi silloin kun sen varassa toimitaan.
--
-- lock_timeout on turvaverkko toiseen suuntaan. Ilman sitä ACCESS
-- EXCLUSIVE -pyyntö jää jonoon pitkän kyselyn taakse — ja koska
-- lukkojono on FIFO, sen taakse jonoutuu jokainen seuraava kysely.
-- Migraatio, joka odottaa hiljaa, kaataisi sovelluksen odottaessaan.
-- Viisi sekuntia ja selkeä virhe on parempi kuin tuntematon katko.
-- ---------------------------------------------------------------------
set local lock_timeout = '5s';
lock table public.tasks in access exclusive mode;

-- ---------------------------------------------------------------------
-- VAIHE 1C: esiehdot — kaikki luetaan lukon alla
-- ---------------------------------------------------------------------
do $$
declare
  omistaja   uuid;
  olemassa   int;
  puuttuvat  int;
  riveja     bigint;
  orpoja     bigint;
  nimet      text;
begin
  select owner_user_id into omistaja from _migration_0002_params;

  -- 1. 0001 on ajettu: omistajasarake on olemassa.
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'tasks'
       and column_name = 'user_id'
  ) then
    raise exception 'Migraatio 0001 pitaa ajaa ensin: tasks.user_id puuttuu.';
  end if;

  -- 2. 0001 on ajettu: RLS on paalla. Ilman tata uudet sarakkeet
  --    olisivat kaikkien luettavissa heti niiden synnyttya.
  if not exists (
    select 1 from pg_class
     where relnamespace = 'public'::regnamespace
       and relname = 'tasks' and relrowsecurity
  ) then
    raise exception 'RLS ei ole paalla taulussa tasks. Aja migraatio 0001 ensin.';
  end if;

  -- 3. 0001 on hyvaksytty: kahdeksan omistajuuspolitiikkaa on tallella.
  --    Politiikat eivat ole sarakekohtaisia, joten uudet sarakkeet
  --    perivat ne. Jos niita ei ole, perinta ei suojaa mitaan.
  select count(*) into olemassa
    from pg_policies
   where schemaname = 'public' and tablename = 'tasks';
  if olemassa <> 4 then
    raise exception 'tasks-taulussa on % politiikkaa, odotettiin 4 (0001 luo 8: nelja per taulu). Tarkista 0001.', olemassa;
  end if;

  -- 4. Olen oikeassa tietokannassa: hyvaksytty omistaja on olemassa.
  if not exists (select 1 from auth.users where id = omistaja) then
    raise exception 'Hyvaksyttya omistajaa % ei loydy auth.users-taulusta. Vaara projekti?', omistaja;
  end if;

  -- 5. Omistajuus on ehja. 0002 ei korjaa omistajuutta, joten se ei saa
  --    myoskaan rakentaa uutta rikkinaisen paalle.
  select count(*) into riveja from public.tasks;
  if exists (select 1 from public.tasks where user_id is null) then
    raise exception 'tasks-taulussa on omistajattomia riveja. Aja verify_0001 ja korjaa ensin.';
  end if;

  select count(*) into orpoja
    from public.tasks t
    left join auth.users u on u.id = t.user_id
   where u.id is null;
  if orpoja > 0 then
    raise exception 'tasks-taulussa on % orpoa omistajaviittausta.', orpoja;
  end if;

  -- 6. OSITTAISEN TAI AIEMMAN AJON TUNNISTUS
  --
  --    Kaksitoista objektia: kuusi saraketta, kolme tarkistetta, funktio,
  --    liipaisin ja indeksi. Nolla = tuore ajo. Kaksitoista = jo ajettu.
  --    Mika tahansa siita valilta = kesken jaanyt ajo.
  --
  --    Kaikki kolme paatyvat eri lopputulokseen, ja juuri se on pointti.
  --    Hiljainen no-op on huonoin mahdollinen vastaus kysymykseen
  --    "ajettiinko tama jo?".
  select count(*) into olemassa from (
    select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'tasks'
        and column_name in ('description', 'duration_minutes', 'priority',
                            'scheduling_state', 'created_at', 'updated_at')
    union all
    select 1 from pg_constraint
      where conrelid = 'public.tasks'::regclass
        and conname in ('tasks_priority_check', 'tasks_scheduling_state_check',
                        'tasks_duration_minutes_check')
    union all
    select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'touch_updated_at'
    union all
    select 1 from pg_trigger
      where tgrelid = 'public.tasks'::regclass
        and tgname = 'tasks_touch_updated_at' and not tgisinternal
    union all
    select 1 from pg_indexes
      where schemaname = 'public' and tablename = 'tasks'
        and indexname = 'tasks_user_date_priority_idx'
  ) kaikki;

  puuttuvat := 12 - olemassa;

  if olemassa = 12 then
    raise exception 'Migraatio 0002 on JO AJETTU. Ala aja uudelleen — aja supabase/verify/verify_0002.sql.';
  end if;

  if olemassa > 0 then
    select string_agg(nimi, ', ' order by nimi) into nimet from (
      select column_name::text as nimi from information_schema.columns
        where table_schema = 'public' and table_name = 'tasks'
          and column_name in ('description', 'duration_minutes', 'priority',
                              'scheduling_state', 'created_at', 'updated_at')
      union all
      select conname::text from pg_constraint
        where conrelid = 'public.tasks'::regclass
          and conname in ('tasks_priority_check', 'tasks_scheduling_state_check',
                          'tasks_duration_minutes_check')
      union all
      select p.proname::text from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'touch_updated_at'
      union all
      select tgname::text from pg_trigger
        where tgrelid = 'public.tasks'::regclass
          and tgname = 'tasks_touch_updated_at' and not tgisinternal
      union all
      select indexname::text from pg_indexes
        where schemaname = 'public' and tablename = 'tasks'
          and indexname = 'tasks_user_date_priority_idx'
    ) loydetyt;

    raise exception 'Migraatio 0002 on kesken: % objektia 12:sta on jo olemassa (%). Ala aja uudelleen sokeasti — ks. docs/MIGRATION-0002-RECOVERY.md.',
      olemassa, nimet;
  end if;

  raise notice 'Esiehdot kunnossa. Omistaja %, tehtavia %, puuttuvia objekteja %.',
    omistaja, riveja, puuttuvat;
end $$;

-- ---------------------------------------------------------------------
-- VAIHE 2: kuvaus
-- Otsikko on lyhyt ja skannattava. Pidempi konteksti kuuluu omaan kenttään.
--
-- Tästä eteenpäin ei käytetä `if not exists` -muotoa: VAIHE 1C on juuri
-- todistanut, ettei yhtäkään näistä ole olemassa. Jos jokin silti on,
-- lause kaatuu — ja se on oikea vastaus, ei ongelma.
-- ---------------------------------------------------------------------
alter table public.tasks add column description text;

-- ---------------------------------------------------------------------
-- VAIHE 3: kesto minuutteina
-- Tarvitaan tehtäville, joilla on kesto mutta ei kiinteää kellonaikaa —
-- aikataulumoottori sijoittaa ne vapaisiin väleihin.
-- ---------------------------------------------------------------------
alter table public.tasks add column duration_minutes integer;

alter table public.tasks
  add constraint tasks_duration_minutes_check
  check (duration_minutes is null or (duration_minutes > 0 and duration_minutes <= 1440));

-- ---------------------------------------------------------------------
-- VAIHE 4: prioriteetti
-- Kolme tasoa. Arvot vastaavat src/domain/priority.js:ää.
--
-- NOT NULL + oletusarvo ei kirjoita taulua uudelleen: PostgreSQL 11:stä
-- lähtien vakio-oletus tallennetaan kerran metatietoon. Olemassa olevat
-- rivit saavat arvon 'normaali' lukematta yhtäkään riviä.
-- ---------------------------------------------------------------------
alter table public.tasks add column priority text not null default 'normaali';

alter table public.tasks
  add constraint tasks_priority_check
  check (priority in ('korkea', 'normaali', 'matala'));

-- ---------------------------------------------------------------------
-- VAIHE 5: aikataulutuksen tila
--
-- Erottaa käyttäjän oman päätöksen automaatin ehdotuksesta. Tämä on
-- tuotteen keskeinen lupaus: automaatti ei saa tuhota sitä, mitä käyttäjä on
-- itse päättänyt (konseptidokumentti, luku 7).
--
-- Olemassa olevat rivit merkitään käyttäjän päätöksiksi: ne on luotu
-- käyttäjän omilla toimilla, joten automaatti ei saa siirtää niitä.
-- Kellonajaton rivi ei ole aikataulutettu lainkaan.
--
-- Sarake lisätään ILMAN oletusarvoa ja täytetään vasta sen jälkeen.
-- Oletusarvo 'manual' asetetaan vasta täytön jälkeen, jotta oletus ei
-- ehdi kirjoittaa kellonajattomille riveille väärää arvoa.
-- ---------------------------------------------------------------------
alter table public.tasks add column scheduling_state text;

update public.tasks
   set scheduling_state = case when "time" is null then 'unscheduled' else 'manual' end
 where scheduling_state is null;

alter table public.tasks alter column scheduling_state set default 'manual';

-- NOT NULL vasta täytön jälkeen. Ilman tätä sarake jäisi nulliksi aina kun
-- asiakas lähettää siihen nimenomaisen nullin — ja `check (x in (...))`
-- EI hylkää nullia, koska null ei ole "epätosi" vaan "tuntematon".
-- Odotusarvo ilman rajoitetta on toive; rajoitteen kanssa se on tae.
alter table public.tasks alter column scheduling_state set not null;

alter table public.tasks
  add constraint tasks_scheduling_state_check
  check (scheduling_state in ('manual', 'auto', 'unscheduled'));

-- ---------------------------------------------------------------------
-- VAIHE 6: aikaleimat
-- Tarvitaan myöhemmin edistymisen seurantaan ja synkronointiin.
-- Client ei saa asettaa näitä — ks. SERVER_OWNED_FIELDS src/lib/rows.js.
--
-- HUOM: olemassa olevat 36 riviä saavat kaikki saman `created_at`-arvon,
-- migraation ajanhetken. Todellisia luontiaikoja ei ole tallessa
-- missään, joten niitä ei voi palauttaa. `created_at` ei siis kerro
-- näiden rivien iästä mitään — älä käytä sitä järjestämiseen ennen
-- kuin riveillä on aitoja arvoja.
-- ---------------------------------------------------------------------
alter table public.tasks add column created_at timestamptz not null default now();
alter table public.tasks add column updated_at timestamptz not null default now();

-- Liipaisinfunktio. `search_path` on kiinnitetty: funktio ajetaan
-- kutsujan oikeuksilla (SECURITY INVOKER on oletus), mutta kiinnitetty
-- polku sulkee pois sen, että istunnon polku ohjaisi `now()`-kutsun
-- johonkin muuhun kuin pg_catalogiin. Tämä funktio on tarkoituksella
-- yhteinen kaikille tauluille; 0003 ja 0004 luovat sen uudelleen
-- SANASTA SANAAN samanlaisena, ja testi vartioi sitä.
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
begin
  new.updated_at = now();
  return new;
end $$;

create trigger tasks_touch_updated_at
  before update on public.tasks
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------
-- VAIHE 7: indeksi prioriteettijärjestykselle
-- Päivänäkymä suodattaa käyttäjän ja päivän mukaan ja järjestää
-- prioriteetin mukaan.
--
-- Tämä ei korvaa migraation 0001 indeksiä tasks_user_id_date_idx.
-- (user_id, date, priority) kattaa saman etuliitteen, joten vanhempi on
-- tämän jälkeen teknisesti tarpeeton — mutta sen pudottaminen on eri
-- päätös eri riskeineen eikä kuulu tähän migraatioon.
-- ---------------------------------------------------------------------
create index tasks_user_date_priority_idx
  on public.tasks (user_id, date, priority);

-- ---------------------------------------------------------------------
-- VAIHE 8: loppuvarmistus ENNEN COMMITTIA
--
-- Tämä on viimeinen hetki, jolloin virheellinen tulos voidaan perua
-- ilman jälkiä. Sen jälkeen korjaaminen on eri operaatio.
-- ---------------------------------------------------------------------
do $$
declare
  sarakkeita int;
  tyhjia     bigint;
begin
  select count(*) into sarakkeita
    from information_schema.columns
   where table_schema = 'public' and table_name = 'tasks'
     and column_name in ('description', 'duration_minutes', 'priority',
                         'scheduling_state', 'created_at', 'updated_at');
  if sarakkeita <> 6 then
    raise exception 'Sarakkeita syntyi % kuuden sijaan.', sarakkeita;
  end if;

  select count(*) into tyhjia from public.tasks
   where scheduling_state is null or priority is null;
  if tyhjia > 0 then
    raise exception '% rivia jai ilman tilaa tai prioriteettia.', tyhjia;
  end if;

  if exists (
    select 1 from public.tasks
     where scheduling_state not in ('manual', 'auto', 'unscheduled')
        or priority not in ('korkea', 'normaali', 'matala')
  ) then
    raise exception 'Jokin rivi sai kelvottoman tilan tai prioriteetin.';
  end if;

  raise notice 'Migraatio 0002 valmis. Aja seuraavaksi supabase/verify/verify_0002.sql.';
end $$;

commit;

-- =====================================================================
-- ROLLBACK — PERUMINEN
-- =====================================================================
-- Ks. docs/MIGRATION-0002-RECOVERY.md. Lyhyesti:
--
-- ENNEN COMMITTIA: virhe perii transaktion itse. Aja `rollback;` jos
-- istunto jäi keskeytyneeseen tilaan. Mitään ei jäänyt.
--
-- COMMITIN JÄLKEEN, ENNEN KUIN LIPPU TASK_EXTENDED_FIELDS on true:
-- peruminen on turvallista. Uusiin sarakkeisiin ei ole kirjoitettu
-- mitään, mitä ei voisi laskea uudelleen: `priority` ja
-- `scheduling_state` ovat migraation itsensä johtamia arvoja.
--
--   begin;
--   drop trigger if exists tasks_touch_updated_at on public.tasks;
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
-- HUOM: yllä EI pudoteta funktiota public.touch_updated_at(). Se on
-- jaettu: migraatiot 0003 ja 0004 luovat sille liipaisimet omiin
-- tauluihinsa. Jos 0003 tai 0004 on ajettu, funktion pudottaminen
-- rikkoisi NIIDEN liipaisimet. Pudota se vain jos olet varmistanut,
-- ettei yksikään liipaisin viittaa siihen:
--
--   select tgname, tgrelid::regclass from pg_trigger
--    where tgfoid = 'public.touch_updated_at'::regproc and not tgisinternal;
--
-- LIPUN KÄÄNTÄMISEN JÄLKEEN: peruminen EI ole enää vaaratonta. Sarakkeet
-- sisältävät silloin käyttäjän kirjoittamaa tietoa (kuvaukset, kestot,
-- prioriteetit), jota ei ole missään muualla. `drop column` hävittää sen
-- lopullisesti. Käännä ensin lippu takaisin arvoon false, julkaise, ja
-- vasta sitten harkitse skeeman perumista — tai älä peru lainkaan vaan
-- korjaa eteenpäin.
