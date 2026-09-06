-- =====================================================================
-- Manifestival — migraatio 0003: rutiinit ja niiden poikkeukset
-- =====================================================================
--
-- TILA: EI AJETTU TUOTANTOON.
--
-- ESIEHDOT
--   1. Migraatiot 0001 ja 0002 on ajettu ja hyvaksytty tuotannossa
--   2. Tuore varmuuskopio on otettu
--   3. supabase/preflight/preflight_0003.sql on ajettu ja on puhdas
--
-- TARKOITUS
-- Rutiini on sääntö, ei tehtävä. "Arkisin klo 07:00 aamulääkkeet" on yksi
-- rivi, ei 260 riviä vuodessa. Esiintymät lasketaan säännöstä ajossa
-- (src/domain/routine.js), joten tietokanta säilyttää vain säännön ja siitä
-- tehdyt poikkeukset.
--
-- Tämä on tarkoituksellinen valinta: jos esiintymät materialisoitaisiin
-- riveiksi, säännön muuttaminen vaatisi tuhansien rivien uudelleenkirjoitusta
-- ja menneisyyden historia sotkeutuisi tulevaisuuden suunnitelmaan.
--
-- KÄYTTÖÖNOTTO KOODISSA
-- Migraation jälkeen: src/data/schema.js -> TABLES.routines = true ja
-- TABLES.routineExceptions = true. Ennen sitä sovellus käyttää
-- muistivarastoa eikä tieto säily — käyttöliittymä kertoo sen käyttäjälle.
--
-- MIKSI TÄMÄ ON TURVALLINEN
-- Migraatio luo vain uusia tauluja. Se ei koske tasks- eikä profile-tauluun
-- eikä muuta yhtään olemassa olevaa riviä.
--
-- MITÄ TÄMÄ EI OLE
-- Tämä ei ole idempotentti migraatio, ja se on tarkoitus. Aiempi versio
-- käytti `if not exists` -muotoa joka kohdassa, jolloin toinen ajo, kesken
-- jäänyt ajo ja tuore ajo näyttivät kaikki samalta: onnistuneelta. Tila,
-- jota ei voi erottaa, on tila jota ei voi korjata. Nyt migraatio laskee
-- 25 objektiaan ja KESKEYTYY, jos yksikin niistä on jo olemassa.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- VAIHE 0: lukituksen aikakatkaisu
--
-- Migraatio luo vain uusia tauluja, joten se ei lukitse tasks- eika
-- profile-taulua. Se KUITENKIN viittaa auth.users-tauluun kahdella
-- vierasavaimella, ja vierasavaimen luonti ottaa viitattuun tauluun
-- SHARE ROW EXCLUSIVE -lukon. auth.users on taulu, jota jokainen
-- kirjautuminen koskee.
--
-- Ilman aikakatkaisua pitkä transaktio auth.users-taulussa jättäisi
-- migraation jonoon — ja koska lukkojono on FIFO, sen taakse jonoutuisi
-- jokainen kirjautuminen. Viisi sekuntia ja selkeä virhe on parempi kuin
-- tuntematon katko kirjautumisessa.
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
  --    Uudet taulut saavat oman politiikkajoukkonsa, mutta jos vanhat
  --    ovat kadonneet, kannan turvamalli ei ole se jota tama olettaa.
  select count(*) into olemassa
    from pg_policies where schemaname = 'public' and tablename = 'tasks';
  if olemassa <> 4 then
    raise exception 'tasks-taulussa on % politiikkaa, odotettiin 4. Tarkista 0001.', olemassa;
  end if;

  -- 3. 0002 on ajettu. 0003 ei riipu 0002:n sarakkeista, mutta tuotannon
  --    hyvaksytty lahtotila sisaltaa ne. Jos ne puuttuvat, ollaan
  --    jossain muussa kannassa kuin oletettiin.
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
  --    Kaksikymmentaviisi objektia: kaksi taulua, yhdeksan tarkistetta,
  --    kaksi yksikasitteisyysrajoitetta, kaksi indeksia, kaksi
  --    liipaisinta ja kahdeksan politiikkaa. Nolla = tuore ajo. Mika
  --    tahansa muu luku tarkoittaa, etta ajo on tehty tai jaanyt kesken
  --    — eika kumpaakaan korjata ajamalla uudelleen.
  --
  --    Funktio touch_updated_at EI ole tassa listassa: sen luo jo
  --    migraatio 0002, joka on ajettu. Siksi se luodaan alla yha
  --    `create or replace` -lauseella.
  select count(*) into olemassa from (
    select 1 from pg_tables
      where schemaname = 'public' and tablename in ('routines', 'routine_exceptions')
    union all
    select 1 from pg_constraint
      where conname in ('routines_recurrence_type_check', 'routines_scheduling_check',
                        'routines_priority_check', 'routines_duration_check',
                        'routines_title_check', 'routines_date_range_check',
                        'routines_weekdays_check', 'routine_exceptions_type_check',
                        'routine_exceptions_duration_check',
                        'routine_exceptions_unique_day', 'routines_owner_row_key')
    union all
    select 1 from pg_indexes
      where schemaname = 'public'
        and indexname in ('routines_user_active_idx', 'routine_exceptions_user_date_idx')
    union all
    select 1 from pg_trigger
      where not tgisinternal
        and tgname in ('routines_touch_updated_at', 'routine_exceptions_touch_updated_at')
    union all
    select 1 from pg_policies
      where schemaname = 'public' and tablename in ('routines', 'routine_exceptions')
  ) kaikki;

  if olemassa = 25 then
    raise exception 'Migraatio 0003 on JO AJETTU. Ala aja uudelleen — aja supabase/verify/verify_0003.sql.';
  end if;

  if olemassa > 0 then
    select string_agg(nimi, ', ' order by nimi) into nimet from (
      select tablename::text as nimi from pg_tables
        where schemaname = 'public' and tablename in ('routines', 'routine_exceptions')
      union all
      select conname::text from pg_constraint
        where conname in ('routines_recurrence_type_check', 'routines_scheduling_check',
                          'routines_priority_check', 'routines_duration_check',
                          'routines_title_check', 'routines_date_range_check',
                          'routines_weekdays_check', 'routine_exceptions_type_check',
                          'routine_exceptions_duration_check',
                          'routine_exceptions_unique_day', 'routines_owner_row_key')
      union all
      select indexname::text from pg_indexes
        where schemaname = 'public'
          and indexname in ('routines_user_active_idx', 'routine_exceptions_user_date_idx')
      union all
      select tgname::text from pg_trigger
        where not tgisinternal
          and tgname in ('routines_touch_updated_at', 'routine_exceptions_touch_updated_at')
      union all
      select policyname::text from pg_policies
        where schemaname = 'public' and tablename in ('routines', 'routine_exceptions')
    ) loydetyt;

    raise exception 'Migraatio 0003 on kesken: % objektia 25:sta on jo olemassa (%). Ks. docs/MIGRATION-0003-RECOVERY.md.',
      olemassa, nimet;
  end if;

  raise notice 'Esiehdot kunnossa. Omistaja %, 0003:n objekteja 0/25.', omistaja;
end $$;

-- ---------------------------------------------------------------------
-- VAIHE 1: routines — toistuva sääntö
--
-- Sarakkeiden nimet vastaavat src/data/collectionsRepo.js:n toRow/fromRow-
-- muunnoksia. Jos muutat toista, muuta toinenkin.
--
-- id on text, koska client generoi sen (crypto.randomUUID()) samoin kuin
-- tasks-taulussa. Tyyppi pidetään yhtenäisenä koko sovelluksessa.
-- ---------------------------------------------------------------------
create table public.routines (
  id                  text primary key,
  user_id             uuid not null default auth.uid()
                      references auth.users(id) on delete cascade,

  title               text not null,
  description         text,
  category            text not null default 'muu',
  priority            text not null default 'normaali',

  -- Kesto minuutteina. Rutiinilla on aina kesto — muuten sitä ei voi
  -- sijoittaa päivään eikä kuormitusta voi laskea.
  duration_minutes    integer not null default 30,

  -- Toistosääntö. weekdays on ISO-viikonpäivä (1 = maanantai, 7 = sunnuntai)
  -- ja sillä on merkitystä vain weekly- ja custom_weekdays-tyypeille.
  recurrence_type     text not null default 'daily',
  recurrence_weekdays integer[] not null default '{}',

  -- Kellonaika. null = joustava, sovellus etsii ajan.
  preferred_time      text,

  -- fixed = käyttäjän valitsema aika on sitova.
  -- flexible = aikataulumoottori saa siirtää esiintymän vapaaseen väliin.
  scheduling          text not null default 'fixed',

  -- Pois kytketty rutiini säilyy historiana mutta ei tuota esiintymiä.
  active              boolean not null default true,

  -- Vapaaehtoinen yhteys tavoitteeseen. Vierasavain lisätään vasta
  -- migraatiossa 0004, koska goals-taulu luodaan siellä. Sarake on tässä,
  -- jotta rutiinien skeema on kerralla valmis eikä muutu takautuvasti.
  goal_id             text,

  -- Voimassaoloväli. Molemmat vapaaehtoisia: ilman niitä sääntö on
  -- voimassa toistaiseksi.
  start_date          date,
  end_date            date,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  -- Yksikasitteisyys omistajan JA rivin yli. Tama ei ole itsessaan
  -- hyodyllinen rajoite — id on jo paaavain — vaan se on se kohde,
  -- johon routine_exceptions viittaa yhdistelmavierasavaimella. Ilman
  -- tata poikkeus voisi viitata toisen kayttajan rutiiniin.
  constraint routines_owner_row_key unique (user_id, id)
);

alter table public.routines
  add constraint routines_recurrence_type_check
  check (recurrence_type in ('daily', 'weekdays', 'weekly', 'custom_weekdays'));

alter table public.routines
  add constraint routines_scheduling_check
  check (scheduling in ('fixed', 'flexible'));

alter table public.routines
  add constraint routines_priority_check
  check (priority in ('korkea', 'normaali', 'matala'));

alter table public.routines
  add constraint routines_duration_check
  check (duration_minutes > 0 and duration_minutes <= 1440);

-- Otsikko ei saa olla tyhjä: nimetön rutiini on käyttäjälle hyödytön.
alter table public.routines
  add constraint routines_title_check
  check (length(btrim(title)) > 0);

-- Loppupäivä ei voi olla ennen alkupäivää — sellainen sääntö ei osuisi
-- koskaan mihinkään päivään.
alter table public.routines
  add constraint routines_date_range_check
  check (start_date is null or end_date is null or end_date >= start_date);

-- Viikonpäivien on oltava ISO-alueella. Tarkistus tehdään kannassa, koska
-- se on viimeinen puolustuslinja domainin validoinnin jälkeen.
--
-- Tyhjä taulukko on sallittu: daily ja weekdays eivät käytä viikonpäiviä
-- lainkaan. Sen että weekly ja custom_weekdays tarvitsevat vähintään yhden
-- päivän, valvoo validateRoutine() — se osaa myös kertoa käyttäjälle miksi.
alter table public.routines
  add constraint routines_weekdays_check
  check (recurrence_weekdays <@ array[1, 2, 3, 4, 5, 6, 7]);

create index routines_user_active_idx
  on public.routines (user_id, active);

-- ---------------------------------------------------------------------
-- VAIHE 2: routine_exceptions — yhden päivän poikkeus sääntöön
--
-- Kolme tyyppiä:
--   skip       tämä päivä jätetään väliin
--   reschedule tämä päivä siirretään toiseen aikaan
--   override   tämän päivän sisältö korvataan (otsikko, kesto)
--
-- Poikkeus on aina sidottu sekä rutiiniin että päivään. Sama päivä voi
-- esiintyä vain kerran samalla rutiinilla — muuten esiintymän tulos olisi
-- epädeterministinen.
-- ---------------------------------------------------------------------
create table public.routine_exceptions (
  id               text primary key,
  user_id          uuid not null default auth.uid()
                   references auth.users(id) on delete cascade,

  -- Vierasavain on YHDISTELMA (user_id, routine_id), ei pelkka
  -- routine_id. Ero ratkaisee omistajuuden eheyden:
  --
  -- Vierasavaimen tarkistus ei kulje RLS:n lapi. Pelkalla
  -- routine_id-viittauksella kayttaja B voisi siis luoda poikkeuksen,
  -- joka osoittaa kayttajan A rutiiniin — B ei nakisi A:n rutiinia,
  -- mutta rivi olisi silti olemassa ja viittaisi toisen ihmisen dataan.
  -- RLS estaa lukemisen, ei viittaamista.
  --
  -- Yhdistelma sitoo poikkeuksen omistajan ja rutiinin omistajan yhteen:
  -- (B, A:n rutiini) ei loydy routines-taulusta, joten kanta hylkaa sen.
  routine_id       text not null,
  date             date not null,
  type             text not null,

  -- Vain reschedule/override käyttää näitä.
  time             text,
  duration_minutes integer,
  title            text,
  note             text,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint routine_exceptions_unique_day unique (routine_id, date),

  foreign key (user_id, routine_id)
    references public.routines (user_id, id) on delete cascade
);

alter table public.routine_exceptions
  add constraint routine_exceptions_type_check
  check (type in ('skip', 'reschedule', 'override'));

alter table public.routine_exceptions
  add constraint routine_exceptions_duration_check
  check (duration_minutes is null
         or (duration_minutes > 0 and duration_minutes <= 1440));

create index routine_exceptions_user_date_idx
  on public.routine_exceptions (user_id, date);

-- ---------------------------------------------------------------------
-- VAIHE 3: updated_at pysyy ajan tasalla
--
-- Funktio public.touch_updated_at() luodaan migraatiossa 0002. Se luodaan
-- tässä uudelleen `create or replace`-lauseella, jotta tämä migraatio
-- toimii myös jos 0002 ajetaan vasta myöhemmin.
--
-- MÄÄRITTELYN ON OLTAVA SANASTA SANAAN SAMA KUIN 0002:SSA. `create or
-- replace` korvaa koko funktion, joten poikkeava versio täällä purkaisi
-- hiljaa 0002:n kovennuksen (security invoker, kiinnitetty search_path)
-- ilman että mikään varmistus huomaisi sitä — verify_0002 olisi ajettu
-- jo aiemmin. Testi vartioi, että kaikki kolme kopiota ovat identtiset.
-- ---------------------------------------------------------------------
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

create trigger routines_touch_updated_at
  before update on public.routines
  for each row execute function public.touch_updated_at();

create trigger routine_exceptions_touch_updated_at
  before update on public.routine_exceptions
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------
-- VAIHE 4: RLS
--
-- Sama malli kuin migraatiossa 0001: käyttäjä näkee vain omat rivinsä,
-- kirjautumaton ei mitään. Yhtään anon-politiikkaa ei luoda.
-- ---------------------------------------------------------------------
alter table public.routines           enable row level security;
alter table public.routine_exceptions enable row level security;


create policy routines_select_own on public.routines
  for select to authenticated using (auth.uid() = user_id);
create policy routines_insert_own on public.routines
  for insert to authenticated with check (auth.uid() = user_id);
create policy routines_update_own on public.routines
  for update to authenticated using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
create policy routines_delete_own on public.routines
  for delete to authenticated using (auth.uid() = user_id);


create policy routine_exceptions_select_own on public.routine_exceptions
  for select to authenticated using (auth.uid() = user_id);
create policy routine_exceptions_insert_own on public.routine_exceptions
  for insert to authenticated with check (auth.uid() = user_id);
create policy routine_exceptions_update_own on public.routine_exceptions
  for update to authenticated using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
create policy routine_exceptions_delete_own on public.routine_exceptions
  for delete to authenticated using (auth.uid() = user_id);

-- PUBLIC ENSIN, EIKA VAIN ANON.
--
-- PostgreSQL-rooli PUBLIC tarkoittaa "kaikki roolit", ja sille myonnetyn
-- oikeuden perii jokainen rooli — myos anon. Perittya oikeutta ei nay
-- roolikohtaisissa listauksissa lainkaan, joten `revoke ... from anon`
-- ei poista sita eika sen puuttumista huomaisi mistaan.
--
-- Uudella taululla PUBLIC ei oletuksena saa mitaan, joten tama on
-- kaytannossa no-op. Se on silti tassa kahdesta syysta: kannassa voi
-- olla ALTER DEFAULT PRIVILEGES, joka myontaa uusille tauluille
-- oikeuksia automaattisesti, ja tama on sama malli jonka migraatio 0001
-- joutui korjaamaan jalkikateen. Sita ei toisteta.
revoke all on public.routines           from public;
revoke all on public.routine_exceptions from public;
revoke all on public.routines           from anon;
revoke all on public.routine_exceptions from anon;

-- Myos authenticated nollataan ensin, jotta lopputulos on TASAN neljä
-- oikeutta eika "nelja plus se mita oletusoikeudet sattuivat antamaan".
revoke all on public.routines           from authenticated;
revoke all on public.routine_exceptions from authenticated;

grant select, insert, update, delete on public.routines           to authenticated;
grant select, insert, update, delete on public.routine_exceptions to authenticated;

-- ---------------------------------------------------------------------
-- VAIHE 6: loppuvarmistus ENNEN COMMITTIA
--
-- Viimeinen hetki, jolloin virheellinen tulos voidaan perua ilman
-- jalkia. Sen jalkeen korjaaminen on eri operaatio.
-- ---------------------------------------------------------------------
do $$
declare
  luku int;
begin
  -- Molemmat taulut ovat olemassa ja tyhjia.
  select count(*) into luku from pg_tables
   where schemaname = 'public' and tablename in ('routines', 'routine_exceptions');
  if luku <> 2 then
    raise exception 'Tauluja syntyi % kahden sijaan.', luku;
  end if;

  if (select count(*) from public.routines) <> 0
     or (select count(*) from public.routine_exceptions) <> 0 then
    raise exception 'Uudet taulut eivat ole tyhjia. Jotain on jo kirjoitettu.';
  end if;

  -- RLS on paalla molemmissa. Ilman tata uudet taulut olisivat
  -- kaikkien luettavissa heti syntyessaan.
  select count(*) into luku from pg_class
   where relnamespace = 'public'::regnamespace
     and relname in ('routines', 'routine_exceptions') and relrowsecurity;
  if luku <> 2 then
    raise exception 'RLS on paalla vain %/2 taulussa.', luku;
  end if;

  -- Kahdeksan politiikkaa, kaikki authenticated-roolille.
  select count(*) into luku from pg_policies
   where schemaname = 'public' and tablename in ('routines', 'routine_exceptions')
     and roles = '{authenticated}'::name[];
  if luku <> 8 then
    raise exception 'Politiikkoja syntyi % kahdeksan sijaan.', luku;
  end if;

  -- anon ei saa mitaan, edes perittyna.
  select count(*) into luku
    from (select unnest(array['public.routines', 'public.routine_exceptions']) as taulu) tt
    cross join (select unnest(array['select', 'insert', 'update', 'delete',
                                    'truncate', 'references', 'trigger']) as oikeus) pp
   where has_table_privilege('anon', tt.taulu, pp.oikeus);
  if luku <> 0 then
    raise exception 'anon-roolilla on % tehollista oikeutta uusiin tauluihin.', luku;
  end if;

  -- authenticated saa tasan CRUD, ei enempaa.
  select count(*) into luku
    from (select unnest(array['public.routines', 'public.routine_exceptions']) as taulu) tt
    cross join (select unnest(array['select', 'insert', 'update', 'delete',
                                    'truncate', 'references', 'trigger']) as oikeus) pp
   where has_table_privilege('authenticated', tt.taulu, pp.oikeus);
  if luku <> 8 then
    raise exception 'authenticated-roolilla on % oikeutta, odotettiin 8 (CRUD x 2 taulua).', luku;
  end if;

  raise notice 'Migraatio 0003 valmis. Aja seuraavaksi supabase/verify/verify_0003.sql.';
end $$;

commit;

-- =====================================================================
-- VARMISTUS MIGRAATION JÄLKEEN (aja erikseen, vain luku)
-- =====================================================================
-- select tablename, rowsecurity from pg_tables
--  where schemaname='public' and tablename in ('routines','routine_exceptions');
--   -> rowsecurity pitää olla true molemmilla
--
-- select tablename, policyname, cmd, roles from pg_policies
--  where schemaname='public' and tablename in ('routines','routine_exceptions')
--  order by tablename, policyname;
--   -> roles pitää olla {authenticated}, ei koskaan {anon} eikä {public}
--
-- select grantee, privilege_type from information_schema.role_table_grants
--  where table_schema='public' and table_name='routines';
--   -> anon ei saa esiintyä
--
-- =====================================================================
-- ROLLBACK — PERUMINEN
-- =====================================================================
-- Ks. docs/MIGRATION-0003-RECOVERY.md. Lyhyesti:
--
-- ENNEN COMMITTIA: virhe perii transaktion itse. Aja `rollback;` jos
-- istunto jäi keskeytyneeseen tilaan. Mitään ei jäänyt.
--
-- COMMITIN JÄLKEEN, ENNEN KUIN LIPUT routines JA routineExceptions ovat
-- true: peruminen on vaaratonta. Taulut ovat uusia ja tyhjiä, eikä
-- sovellus kirjoita niihin.
--
--   begin;
--   drop table if exists public.routine_exceptions;
--   drop table if exists public.routines;
--   commit;
--
-- Funktiota public.touch_updated_at() EI pudoteta. Se on jaettu:
-- migraatio 0002 on ajettu tuotantoon ja sen liipaisin tasks-taulussa
-- käyttää sitä. Pudottaminen rikkoisi sen.
--
-- LIPPUJEN KÄÄNTÄMISEN JÄLKEEN: peruminen EI ole enää vaaratonta.
-- Tauluissa on silloin käyttäjän luomia rutiineja ja poikkeuksia, joita
-- ei ole missään muualla. `drop table` hävittää ne lopullisesti ja
-- hiljaa. Käännä ensin liput takaisin arvoon false, julkaise, ja vasta
-- sitten harkitse skeeman perumista — tai älä peru lainkaan vaan korjaa
-- eteenpäin.
--
-- Viimeisin tiedetty toimiva tuotantoversio: manifestival-prod-v1
-- (81b85e3678ba9f8a6375fa42db0fbbda6851ea8f).
