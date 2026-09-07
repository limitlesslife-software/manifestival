-- =====================================================================
-- Manifestival — migraatio 0006: hyvinvointimerkinnät
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
-- Migraatiot 0003–0005 EIVÄT ole esiehto: tämä taulu ei viittaa
-- yhteenkään niiden tauluun. Järjestys on silti se, jossa ne ajetaan.
--
-- TARKOITUS
-- Yksi merkintä per päivä: energia, mieliala, kuormitus, unen määrä ja
-- vapaa muistiinpano. Asteikko on karkea (1–5), koska tavoite on nopea
-- merkintä eikä mittaus. Tarkempi asteikko tuottaisi tarkemmalta näyttävää
-- mutta ei todempaa tietoa.
--
-- TÄMÄ EI OLE TERVEYSTIETOA VAAN OMASEURANTAA
-- Sovellus ei tee diagnooseja eikä anna hoito-ohjeita. Merkintä vaikuttaa
-- vain siihen, minkä ehdotuksen sovellus näyttää päivän suunnittelussa —
-- eikä se koskaan muuta suunnitelmaa itsestään (src/domain/wellbeing.js:
-- planningLoadSuggestion palauttaa ehdotuksen, ei muutosta).
--
-- Tieto on silti arkaluontoista, ja arkaluontoisin kenttä on `note`:
-- vapaa teksti, johon ihminen kirjoittaa mitä tahansa. Siksi sama
-- RLS-malli kuin muussakin datassa, ja siksi yksikään tämän paketin
-- varmistus- tai diagnostiikkakysely EI lue tämän taulun sisältöä —
-- vain rivimääriä ja rakennetta.
--
-- KÄYTTÖÖNOTTO KOODISSA
-- Migraation JA hyväksyntätestin jälkeen:
-- src/data/schema.js -> TABLES.wellbeing = true.
--
-- =====================================================================
-- OMISTAJUUS: MIKSI TÄSSÄ EI TARVITA YHDISTELMÄVIERASAVAINTA
-- =====================================================================
-- Migraatiot 0003, 0004 ja 0007 joutuvat suojaamaan ristiinkiinnitykseltä
-- yhdistelmävierasavaimella, koska niissä rivi VIITTAA toiseen riviin ja
-- vierasavaimen tarkistus ei kulje RLS:n läpi.
--
-- Tässä taulussa sitä vaaraa ei ole, eikä siksi että se olisi hyväksytty
-- riski vaan koska rakenne sulkee sen pois: hyvinvointimerkintä ei viittaa
-- yhteenkään toiseen sovellustauluun. Se on päivämäärä ja viisi arvoa.
-- Ainoa viite on omistajaan (auth.users), ja sen asettaa kanta itse.
--
-- Rivin yksikäsitteisyys `unique (user_id, date)` on jo omistajakohtainen:
-- kahden käyttäjän merkinnät samalle päivälle eivät ole ristiriidassa.
-- Pelkkä `unique (date)` olisi ollut vuoto — se olisi paljastanut toisen
-- käyttäjän merkinnän olemassaolon virheenä.
--
-- MITÄ TÄMÄ EI OLE
-- Tämä ei ole idempotentti migraatio, ja se on tarkoitus. Aiempi versio
-- käytti `if not exists` -muotoa, jolloin toinen ajo, kesken jäänyt ajo
-- ja tuore ajo näyttivät kaikki onnistuneelta. Tila, jota ei voi erottaa,
-- on tila jota ei voi korjata. Nyt migraatio laskee kymmenen objektiaan
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

  -- 3. 0002 on ajettu.
  select count(*) into olemassa
    from information_schema.columns
   where table_schema = 'public' and table_name = 'tasks'
     and column_name in ('description', 'duration_minutes', 'priority',
                         'scheduling_state', 'created_at', 'updated_at');
  if olemassa <> 6 then
    raise exception 'Migraatio 0002 puuttuu: tasks-taulussa on % kuudesta lisasarakkeesta.', olemassa;
  end if;

  -- 4. Olen oikeassa tietokannassa.
  if not exists (select 1 from auth.users where id = omistaja) then
    raise exception 'Hyvaksyttya omistajaa % ei loydy auth.users-taulusta. Vaara projekti?', omistaja;
  end if;

  -- 5. OSITTAISEN TAI AIEMMAN AJON TUNNISTUS
  --
  --    Kymmenen objektia: yksi taulu, kaksi tarkistetta, yksi
  --    yksikasitteisyysrajoite, yksi indeksi, yksi liipaisin ja nelja
  --    politiikkaa. Nolla = tuore ajo. Mika tahansa muu luku tarkoittaa,
  --    etta ajo on tehty tai jaanyt kesken — eika kumpaakaan korjata
  --    ajamalla uudelleen.
  --
  --    Funktio touch_updated_at EI ole listassa: sen luo migraatio 0002,
  --    joka on ajettu. Tama migraatio ei luo sita eika korvaa sita, vaan
  --    tarkistaa sen alla.
  select count(*) into olemassa from (
    select 1 from pg_tables
      where schemaname = 'public' and tablename = 'wellbeing_entries'
    union all
    select 1 from pg_constraint
      where conname in ('wellbeing_entries_unique_day',
                        'wellbeing_entries_scale_check',
                        'wellbeing_entries_sleep_check')
    union all
    select 1 from pg_indexes
      where schemaname = 'public' and indexname = 'wellbeing_entries_user_date_idx'
    union all
    select 1 from pg_trigger
      where not tgisinternal and tgname = 'wellbeing_entries_touch_updated_at'
    union all
    select 1 from pg_policies
      where schemaname = 'public' and tablename = 'wellbeing_entries'
  ) kaikki;

  if olemassa = 10 then
    raise exception 'Migraatio 0006 on JO AJETTU. Ala aja uudelleen — aja supabase/verify/verify_0006.sql.';
  end if;

  if olemassa > 0 then
    select string_agg(nimi, ', ' order by nimi) into nimet from (
      select tablename::text as nimi from pg_tables
        where schemaname = 'public' and tablename = 'wellbeing_entries'
      union all
      select conname::text from pg_constraint
        where conname in ('wellbeing_entries_unique_day',
                          'wellbeing_entries_scale_check',
                          'wellbeing_entries_sleep_check')
      union all
      select indexname::text from pg_indexes
        where schemaname = 'public' and indexname = 'wellbeing_entries_user_date_idx'
      union all
      select tgname::text from pg_trigger
        where not tgisinternal and tgname = 'wellbeing_entries_touch_updated_at'
      union all
      select policyname::text from pg_policies
        where schemaname = 'public' and tablename = 'wellbeing_entries'
    ) loydetyt;

    raise exception 'Migraatio 0006 on kesken: % objektia 10:sta on jo olemassa (%). Ks. docs/MIGRATION-0006-RECOVERY.md.',
      olemassa, nimet;
  end if;

  raise notice 'Esiehdot kunnossa. Omistaja %, 0006:n objekteja 0/10.', omistaja;
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
-- tuotannossa. Jos 0006 olisi ajettu sellaisenaan, se olisi HILJAA
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

  if turvamaare then
    raise exception 'public.touch_updated_at() on SECURITY DEFINER. Se pitaa olla INVOKER.';
  end if;

  if asetukset is null
     or not exists (select 1 from unnest(asetukset) a where a like 'search\_path=%') then
    raise exception 'public.touch_updated_at() ei kiinnita search_pathia.';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- VAIHE 1: wellbeing_entries
--
-- Kaikki mittarit ovat nullable: käyttäjä saa merkitä vain sen mitä haluaa.
-- Osittainen merkintä on parempi kuin ei merkintää lainkaan.
--
-- (user_id, date) on uniikki: päivällä on yksi merkintä, jota muokataan.
-- Ilman tätä sama päivä kertyisi useaksi riviksi ja keskiarvot vääristyisivät.
-- ---------------------------------------------------------------------
create table public.wellbeing_entries (
  id          text primary key,
  user_id     uuid not null default auth.uid()
              references auth.users(id) on delete cascade,

  date        date not null,

  energy      smallint,
  mood        smallint,
  stress      smallint,

  -- Unen määrä tunteina. Puolikkaat tunnit ovat tarpeen, tarkempi ei.
  sleep_hours numeric(4, 2),

  note        text,

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint wellbeing_entries_unique_day unique (user_id, date)
);

alter table public.wellbeing_entries
  add constraint wellbeing_entries_scale_check
  check (
    (energy is null or energy between 1 and 5)
    and (mood   is null or mood   between 1 and 5)
    and (stress is null or stress between 1 and 5)
  );

alter table public.wellbeing_entries
  add constraint wellbeing_entries_sleep_check
  check (sleep_hours is null or (sleep_hours > 0 and sleep_hours <= 24));

create index wellbeing_entries_user_date_idx
  on public.wellbeing_entries (user_id, date desc);

-- ---------------------------------------------------------------------
-- VAIHE 2: updated_at
-- ---------------------------------------------------------------------
create trigger wellbeing_entries_touch_updated_at
  before update on public.wellbeing_entries
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------
-- VAIHE 3: RLS
-- ---------------------------------------------------------------------
alter table public.wellbeing_entries enable row level security;

create policy wellbeing_entries_select_own on public.wellbeing_entries
  for select to authenticated using (auth.uid() = user_id);
create policy wellbeing_entries_insert_own on public.wellbeing_entries
  for insert to authenticated with check (auth.uid() = user_id);
create policy wellbeing_entries_update_own on public.wellbeing_entries
  for update to authenticated using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
create policy wellbeing_entries_delete_own on public.wellbeing_entries
  for delete to authenticated using (auth.uid() = user_id);

-- PUBLIC ENSIN, EIKA VAIN ANON.
--
-- PostgreSQL-rooli PUBLIC tarkoittaa "kaikki roolit", ja sille myonnetyn
-- oikeuden perii jokainen rooli — myos anon. Perittya oikeutta ei nay
-- roolikohtaisissa listauksissa lainkaan, joten `revoke ... from anon`
-- ei poista sita eika sen puuttumista huomaisi mistaan.
revoke all on public.wellbeing_entries from public;
revoke all on public.wellbeing_entries from anon;

-- Myos authenticated nollataan ensin, jotta lopputulos on TASAN nelja
-- oikeutta eika "nelja plus se mita oletusoikeudet sattuivat antamaan".
revoke all on public.wellbeing_entries from authenticated;

grant select, insert, update, delete on public.wellbeing_entries to authenticated;

-- ---------------------------------------------------------------------
-- VAIHE 4: loppuvarmistus ENNEN COMMITTIA
-- ---------------------------------------------------------------------
do $$
declare
  luku int;
begin
  if not exists (
    select 1 from pg_tables
     where schemaname = 'public' and tablename = 'wellbeing_entries'
  ) then
    raise exception 'Taulua wellbeing_entries ei syntynyt.';
  end if;

  if (select count(*) from public.wellbeing_entries) <> 0 then
    raise exception 'Uusi taulu ei ole tyhja. Jotain on jo kirjoitettu.';
  end if;

  -- RLS on paalla. Ilman tata taulu olisi kaikkien luettavissa heti
  -- syntyessaan — ja tama on paketin arkaluontoisin taulu.
  if not exists (
    select 1 from pg_class
     where relnamespace = 'public'::regnamespace
       and relname = 'wellbeing_entries' and relrowsecurity
  ) then
    raise exception 'RLS ei ole paalla taulussa wellbeing_entries.';
  end if;

  -- Nelja politiikkaa, kaikki authenticated-roolille, ja MOLEMMAT puolet
  -- oikein. Jos vain USING tarkistettaisiin, kayttaja voisi ottaa oman
  -- rivinsa ja kirjoittaa sen toisen nimiin.
  select count(*) into luku from pg_policies
   where schemaname = 'public' and tablename = 'wellbeing_entries'
     and roles = '{authenticated}'::name[]
     and coalesce(btrim(replace(qual,       ' ', ''), '()'), 'auth.uid()=user_id') = 'auth.uid()=user_id'
     and coalesce(btrim(replace(with_check, ' ', ''), '()'), 'auth.uid()=user_id') = 'auth.uid()=user_id';
  if luku <> 4 then
    raise exception 'Vain %/4 politiikkaa rajaa omistajuuden oikein.', luku;
  end if;

  select count(*) into luku from pg_policies
   where schemaname = 'public' and tablename = 'wellbeing_entries';
  if luku <> 4 then
    raise exception 'Taulussa on % politiikkaa neljan sijaan.', luku;
  end if;

  -- YKSIKASITTEISYYS ON OMISTAJAKOHTAINEN.
  --
  -- Rajoitteen on katettava TASAN sarakkeet (user_id, date). Pelkka
  -- unique(date) olisi vuoto: se paljastaisi virheella, etta jollakin
  -- toisella kayttajalla on merkinta samalle paivalle.
  select count(*) into luku
    from pg_constraint con
   where con.conname = 'wellbeing_entries_unique_day'
     and con.contype = 'u'
     and (select array_agg(a.attname::text order by a.attname)
            from unnest(con.conkey) k(attnum)
            join pg_attribute a
              on a.attrelid = con.conrelid and a.attnum = k.attnum)
         = array['date', 'user_id'];
  if luku <> 1 then
    raise exception 'wellbeing_entries_unique_day ei kata sarakkeita (user_id, date).';
  end if;

  -- Taulussa ei ole yhtaan viittausta toiseen sovellustauluun. Tama on
  -- se vaite, jonka nojalla yhdistelmavierasavainta ei tarvita; jos
  -- viittaus joskus lisataan, se on lisattava yhdistelmana ja tama
  -- tarkistus on paivitettava samalla.
  select count(*) into luku
    from pg_constraint con
    join pg_class ft on ft.oid = con.confrelid
   where con.conrelid = 'public.wellbeing_entries'::regclass
     and con.contype = 'f'
     and ft.relnamespace = 'public'::regnamespace;
  if luku <> 0 then
    raise exception 'Taulussa on % viitetta public-skeemaan. Omistajuusmalli ei enaa pade.', luku;
  end if;

  -- anon ei saa mitaan, edes perittyna.
  select count(*) into luku
    from (select unnest(array['select', 'insert', 'update', 'delete',
                              'truncate', 'references', 'trigger']) as oikeus) pp
   where has_table_privilege('anon', 'public.wellbeing_entries', pp.oikeus);
  if luku <> 0 then
    raise exception 'anon-roolilla on % tehollista oikeutta uuteen tauluun.', luku;
  end if;

  -- PUBLIC-roolilla ei saa olla mitaan, ja tama katsotaan TAULUN
  -- OIKEUSLISTASTA eika roolikohtaisesti. Kaksi menetelmaa, koska
  -- kumpikaan ei yksin riita: has_table_privilege kertoo ONKO oikeus
  -- (perinta mukaan lukien), aclexplode kertoo MISTA se tulee.
  select count(*) into luku
    from pg_class cl, aclexplode(cl.relacl) acl
   where cl.oid = 'public.wellbeing_entries'::regclass
     and acl.grantee = 0;
  if luku <> 0 then
    raise exception 'PUBLIC-roolilla on % oikeutta uuteen tauluun.', luku;
  end if;

  -- authenticated saa tasan CRUD, ei enempaa.
  select count(*) into luku
    from (select unnest(array['select', 'insert', 'update', 'delete',
                              'truncate', 'references', 'trigger']) as oikeus) pp
   where has_table_privilege('authenticated', 'public.wellbeing_entries', pp.oikeus);
  if luku <> 4 then
    raise exception 'authenticated-roolilla on % oikeutta, odotettiin 4 (CRUD).', luku;
  end if;

  raise notice 'Migraatio 0006 valmis. Aja seuraavaksi supabase/verify/verify_0006.sql.';
end $$;

commit;

-- =====================================================================
-- VARMISTUS MIGRAATION JÄLKEEN
-- =====================================================================
-- supabase/verify/verify_0006.sql — yksi lause, yksi taulukko.
-- Se ei lue tämän taulun sisältöä, vain rivimääriä ja rakennetta.
--
-- =====================================================================
-- ROLLBACK
-- =====================================================================
-- Poisto kadottaa kaikki hyvinvointimerkinnät. Ota varmuuskopio ensin.
--
--   begin;
--   set local lock_timeout = '5s';
--   drop table if exists public.wellbeing_entries;
--   commit;
--
-- Rollback EI koske funktioon public.touch_updated_at(): tämä migraatio
-- ei luonut sitä.
--
-- Muista tällöin palauttaa src/data/schema.js -> TABLES.wellbeing = false.
