-- =====================================================================
-- Manifestival — migraatio 0001: käyttäjäkohtainen omistajuus ja RLS
-- =====================================================================
--
-- TILA: LUONNOS. TÄTÄ EI OLE AJETTU MIHINKÄÄN YMPÄRISTÖÖN.
--
-- Tämä tiedosto on sovitettu TODENNETTUUN tuotantoskeemaan. Se ei ole
-- enää yleisluonteinen malli. Jos tuotanto ei vastaa alla kuvattua
-- lähtötilaa, migraatio KESKEYTYY ITSE eikä muuta mitään.
--
-- ---------------------------------------------------------------------
-- TODENNETTU LÄHTÖTILA (inventory.sql ajettu, tulos vahvistettu)
-- ---------------------------------------------------------------------
--   public.profile   1 rivi.  id = 'me',  id:n tyyppi TEXT.
--   public.tasks    36 riviä. EI user_id-saraketta.
--   Molemmilla tauluilla on "salli kaikki" -tyyppinen politiikka.
--   Omistaja auth.users-taulussa: 2cc00622-f927-4604-a518-361a4328481b
--
-- ---------------------------------------------------------------------
-- MIKSI profile.id:tä EI MUUNNETA TYYPPIÄ VAIHTAMALLA
-- ---------------------------------------------------------------------
-- Aiempi luonnos teki näin:
--
--     alter table public.profile alter column id type uuid using id::uuid;
--
-- Se KAATUU tuotannossa. Ainoan rivin id on kirjaimellisesti 'me', eikä
-- 'me' ole uuid. Muunnos ei ole "melkein oikein" — se on virhe, joka
-- keskeyttää migraation kesken kaiken.
--
-- Tämä versio ei muunna tyyppiä lainkaan. Vanha sarake nimetään
-- uudelleen (legacy_id) ja sen rinnalle lisätään uusi uuid-sarake.
-- Alkuperäistä arvoa 'me' EI hävitetä. Se on ainoa asia, joka tekee
-- tästä migraatiosta perumiskelpoisen ilman varmuuskopion palautusta.
--
-- ---------------------------------------------------------------------
-- MIKSI OMISTAJA ON KIRJOITETTU TÄHÄN KOVAKOODATTUNA
-- ---------------------------------------------------------------------
-- Omistaja EI saa valikoitua ajonaikaisesti. Kiellettyjä tapoja:
--
--     select id from auth.users order by created_at ...   -- rivijärjestys
--     select id from auth.users where email = '...'       -- arvaus
--
-- Molemmat antaisivat väärän vastauksen sillä hetkellä, kun kantaan on
-- ehtinyt syntyä toinen tili. Silloin 36 tehtävää siirtyisi väärälle
-- ihmiselle, ja RLS lukitsisi oikean omistajan ulos omasta datastaan.
-- Arvo on siksi vakio, ja migraatio tarkistaa sen olemassaolon ennen
-- kuin se koskee mihinkään.
--
-- ---------------------------------------------------------------------
-- MERKISTÖ
-- ---------------------------------------------------------------------
-- Kommentit ovat suomea ääkkösineen. Virheilmoitukset EIVÄT ole:
-- ne on kirjoitettu ASCII-merkein tarkoituksella. Virheilmoitus on juuri
-- se teksti, joka luetaan silloin kun jokin on mennyt pieleen, eikä
-- silloin haluta arvailla, onko "rivia" vai "rivi" oikea sana vai onko
-- pääte hajonnut asiakasohjelman merkistöasetuksissa. Sama käytäntö on
-- tiedostoissa supabase/verify/.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- VAIHE 0: migraation vakiot
--
-- Yksi paikka, jossa nämä arvot esiintyvät. Jos rivimäärät ovat
-- muuttuneet laillisesti (olet lisännyt tehtäviä inventoinnin jälkeen),
-- päivitä luku TÄSSÄ ja aja inventory.sql uudelleen ensin. Älä poista
-- tarkistusta.
-- ---------------------------------------------------------------------
create temporary table _migration_params on commit drop as
select
  '2cc00622-f927-4604-a518-361a4328481b'::uuid as owner_user_id,
  1::bigint  as expected_profile_rows,
  36::bigint as expected_task_rows,
  'me'::text as legacy_profile_id;

-- ---------------------------------------------------------------------
-- VAIHE 1: esiehdot
--
-- Jokainen tarkistus vastaa yhteen tapaan, jolla tämä migraatio voisi
-- tehdä vahinkoa. Kaikki ajetaan ENNEN yhtäkään muutosta, samassa
-- transaktiossa.
-- ---------------------------------------------------------------------
do $$
declare
  p            record;
  v_count      bigint;
  v_type       text;
  v_constraint text;
begin
  select * into p from _migration_params;

  -- 1.1 Taulut ovat olemassa.
  if to_regclass('public.tasks') is null then
    raise exception 'Taulua public.tasks ei ole. Vaara kanta tai vaara skeema.';
  end if;
  if to_regclass('public.profile') is null then
    raise exception 'Taulua public.profile ei ole. Vaara kanta tai vaara skeema.';
  end if;

  -- 1.2 Omistaja on olemassa. Ilman tätä backfill loisi orpoja rivejä,
  --     ja vierasavaimen lisäys kaatuisi vasta myöhemmin.
  if not exists (select 1 from auth.users u where u.id = p.owner_user_id) then
    raise exception
      'Omistajaa % ei loydy auth.users-taulusta. Luo tili ensin tai korjaa vakio.',
      p.owner_user_id;
  end if;

  -- 1.3 Migraatiota ei ole jo osittain ajettu.
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'tasks' and column_name = 'user_id'
  ) then
    raise exception
      'public.tasks.user_id on jo olemassa. 0001 on ajettu tai osittain ajettu. PYSAHDY.';
  end if;

  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'profile' and column_name = 'legacy_id'
  ) then
    raise exception
      'public.profile.legacy_id on jo olemassa. 0001 on ajettu tai osittain ajettu. PYSAHDY.';
  end if;

  -- 1.4 profile.id on yhä tekstityyppinen ja sisältää tunnetun arvon.
  select data_type into v_type
    from information_schema.columns
   where table_schema = 'public' and table_name = 'profile' and column_name = 'id';

  if v_type is null then
    raise exception 'public.profile.id-saraketta ei ole.';
  end if;
  if v_type not in ('text', 'character varying', 'character') then
    raise exception
      'public.profile.id on tyyppia %. Odotettiin tekstityyppia. Tarkista inventaario.',
      v_type;
  end if;

  -- 1.5 Rivimäärät vastaavat inventaariota.
  select count(*) into v_count from public.profile;
  if v_count <> p.expected_profile_rows then
    raise exception
      'public.profile: % rivia, odotettiin %. Aja inventory.sql uudelleen ennen jatkoa.',
      v_count, p.expected_profile_rows;
  end if;

  select count(*) into v_count from public.tasks;
  if v_count <> p.expected_task_rows then
    raise exception
      'public.tasks: % rivia, odotettiin %. Aja inventory.sql uudelleen ennen jatkoa.',
      v_count, p.expected_task_rows;
  end if;

  -- 1.6 Ainoa profiilirivi on se, jonka omistaja tiedetään.
  select count(*) into v_count from public.profile where id = p.legacy_profile_id;
  if v_count <> 1 then
    raise exception
      'public.profile ei sisalla tasan yhta rivia arvolla %. Loytyi %. PYSAHDY.',
      p.legacy_profile_id, v_count;
  end if;

  -- 1.7 Mikään taulu ei viittaa public.profile-tauluun. Viite estäisi
  --     avaimen vaihdon ja jäisi osoittamaan vanhaan arvoon.
  select tc.constraint_name into v_constraint
    from information_schema.table_constraints tc
    join information_schema.constraint_column_usage ccu
      on tc.constraint_name = ccu.constraint_name
     and tc.table_schema = ccu.table_schema
   where tc.constraint_type = 'FOREIGN KEY'
     and ccu.table_schema = 'public'
     and ccu.table_name = 'profile';

  if v_constraint is not null then
    raise exception
      'Vierasavain % viittaa public.profile-tauluun. Selvita se ennen avaimen vaihtoa.',
      v_constraint;
  end if;

  raise notice 'Esiehdot kunnossa. Omistaja %, tehtavia %, profiileja %.',
    p.owner_user_id, p.expected_task_rows, p.expected_profile_rows;
end $$;

-- ---------------------------------------------------------------------
-- VAIHE 2: tasks — omistajuussarake
--
-- Järjestys on olennainen: sarake lisätään NULL-sallivana, data
-- täytetään, täyttö TARKISTETAAN, ja vasta sitten sarake lukitaan
-- pakolliseksi. Toisin päin lisäys kaatuisi 36 rivin kohdalla.
-- ---------------------------------------------------------------------

-- 2a. Sarake ilman rajoitteita. Olemassa oleva data säilyy koskemattomana.
alter table public.tasks add column user_id uuid;

-- 2b. Backfill. Kaikki nykyinen data kuuluu yhdelle tunnetulle ihmiselle.
update public.tasks
   set user_id = (select owner_user_id from _migration_params)
 where user_id is null;

-- 2c. Täytön tarkistus ennen lukitsemista.
do $$
declare
  v_null  bigint;
  v_total bigint;
  v_owner bigint;
begin
  select count(*) into v_null  from public.tasks where user_id is null;
  select count(*) into v_total from public.tasks;
  select count(*) into v_owner from public.tasks
    where user_id = (select owner_user_id from _migration_params);

  if v_null <> 0 then
    raise exception 'Backfill jatti % rivia ilman omistajaa.', v_null;
  end if;
  if v_owner <> v_total then
    raise exception
      'Vain % rivia %:sta sai odotetun omistajan.', v_owner, v_total;
  end if;
  if v_total <> (select expected_task_rows from _migration_params) then
    raise exception 'Rivimaara muuttui migraation aikana: %.', v_total;
  end if;
end $$;

-- 2d. Pakollinen vasta täytön jälkeen.
alter table public.tasks alter column user_id set not null;

-- 2e. Omistajan asettaa TIETOKANTA, ei selain. Tämä on turvamallin ydin:
--     client ei voi valita toisen käyttäjän user_id:tä edes silloin, kun
--     sovelluskoodissa on virhe. Ks. src/lib/rows.js (SERVER_OWNED_FIELDS).
alter table public.tasks alter column user_id set default auth.uid();

-- 2f. Vierasavain.
--
--     ON DELETE CASCADE on tietoinen valinta, ei oletus. Kun käyttäjä
--     poistetaan auth.users-taulusta, hänen tehtävänsä poistuvat samassa
--     operaatiossa. Vaihtoehdot ja miksi ne hylättiin:
--
--       SET NULL   jättäisi henkilökohtaista tekstiä kantaan ilman
--                  omistajaa. RLS ei näyttäisi rivejä kenellekään, joten
--                  ne olisivat näkymätöntä jäämää — ja user_id on
--                  NOT NULL, joten se ei edes onnistuisi.
--       RESTRICT   estäisi tilin poiston kokonaan. Tilin poisto on
--                  käyttäjän oikeus, ks. docs/ACCOUNT-DELETION.md.
--
--     CASCADE tekee tilin poistosta yhden operaation, joka ei jätä
--     jälkeä. Se on sama päätös kuin migraatioissa 0003-0008.
--
--     HUOM: tämä ei ole sama asia kuin tehtävän ja projektin välinen
--     suhde. Se on SET NULL (migraatio 0004): projektin poisto irrottaa
--     tehtävät mutta ei poista niitä. Ks. tests/entity-lifecycle.test.mjs.
alter table public.tasks
  add constraint tasks_user_id_fkey
  foreign key (user_id) references auth.users(id) on delete cascade;

-- 2g. Indeksi. Jokainen kysely suodattaa omistajalla, useimmat myös
--     päivämäärällä.
create index if not exists tasks_user_id_date_idx
  on public.tasks (user_id, date);

-- ---------------------------------------------------------------------
-- VAIHE 3: profile — avain vaihtuu ilman tyyppimuunnosta
--
-- profile käyttää mallia id = auth.uid(): yksi rivi per käyttäjä, ei
-- erillistä user_id-saraketta. Siksi politiikat kohdistuvat id-sarakkeeseen.
--
-- Vanha arvo säilytetään sarakkeessa legacy_id. Se ei ole roskaa vaan
-- perumisen edellytys: ilman sitä 'me' olisi lopullisesti poissa.
-- Sarakkeen saa pudottaa myöhemmin erillisenä päätöksenä, kun uusi malli
-- on todettu toimivaksi. Sovellus ei lue sitä (ks. profileFromRow).
-- ---------------------------------------------------------------------

-- 3a. Vanha pääavain pois. Se on yhä vanhassa sarakkeessa.
--
--     Nimeä ei oleteta. Oletusnimi olisi profile_pkey, mutta taulu on
--     luotu käsin dashboardissa, ja käsin luodun rajoitteen nimi voi
--     olla mikä tahansa. Väärä oletus jättäisi vanhan avaimen paikalleen
--     ja kaataisi vaiheen 3g vasta myöhemmin.
do $$
declare
  v_pkey text;
begin
  select conname into v_pkey
    from pg_constraint
   where conrelid = 'public.profile'::regclass
     and contype = 'p';

  if v_pkey is null then
    raise notice 'public.profile-taululla ei ole paaavainta. Jatketaan.';
  else
    raise notice 'Poistetaan vanha paaavain %.', v_pkey;
    execute format('alter table public.profile drop constraint %I', v_pkey);
  end if;
end $$;

-- 3b. Vanha sarake sivuun, arvo tallella.
alter table public.profile rename column id to legacy_id;

-- 3c. Vanha oletusarvo pois.
--
--     TÄMÄ ON PAKOLLINEN, EI SIISTEYTTÄ. Tuotannon sarakkeella on
--     `default 'me'`, ja Postgresissa oletusarvo seuraa saraketta
--     uudelleennimeämisessä. Ilman tätä riviä JOKAINEN migraation
--     jälkeen syntyvä profiilirivi saisi automaattisesti
--     legacy_id = 'me'.
--
--     Se olisi hiljainen virhe pahimmassa muodossaan: sarake, jonka
--     nimi lupaa historiatietoa, täyttyisikin uudella datalla, ja
--     rollback-osion oletus "legacy_id kertoo mikä rivi oli
--     alkuperäinen" lakkaisi pitämästä paikkaansa.
--
--     Olemassa olevaa arvoa EI kosketa. 'me' jää sinne missä se on.
alter table public.profile alter column legacy_id drop default;

-- 3d. Nimenomainen NULL-sallivuus. Pääavaimen poisto jättää
--     NOT NULL -merkinnän voimaan joissakin Postgres-versioissa, ja
--     uudet käyttäjät eivät koskaan saa legacy-arvoa.
alter table public.profile alter column legacy_id drop not null;

-- 3e. Uusi avainsarake.
alter table public.profile add column id uuid;

-- 3f. Omistajuus tunnetulle käyttäjälle.
update public.profile
   set id = (select owner_user_id from _migration_params)
 where legacy_id = (select legacy_profile_id from _migration_params);

-- 3g. Tarkistus ennen lukitsemista. Myös legacy-arvo tarkistetaan:
--     sen katoaminen tarkoittaisi, että perumisen edellytys on mennyt.
do $$
declare
  v_null   bigint;
  v_total  bigint;
  v_legacy bigint;
  v_default text;
begin
  select count(*) into v_null  from public.profile where id is null;
  select count(*) into v_total from public.profile;
  select count(*) into v_legacy from public.profile
    where legacy_id = (select legacy_profile_id from _migration_params);

  if v_null <> 0 then
    raise exception 'profile: % rivia jai ilman uutta tunnistetta.', v_null;
  end if;
  if v_total <> (select expected_profile_rows from _migration_params) then
    raise exception 'profile: rivimaara muuttui migraation aikana: %.', v_total;
  end if;
  if v_legacy <> 1 then
    raise exception
      'profile.legacy_id: alkuperainen arvo katosi (% rivia). Peruminen ei olisi enaa mahdollista.',
      v_legacy;
  end if;

  select column_default into v_default
    from information_schema.columns
   where table_schema = 'public' and table_name = 'profile'
     and column_name = 'legacy_id';
  if v_default is not null then
    raise exception
      'profile.legacy_id sai jaada oletusarvon %. Uudet rivit perisivat sen.',
      v_default;
  end if;
end $$;

-- 3h. Uusi pääavain.
alter table public.profile alter column id set not null;
alter table public.profile add constraint profile_pkey primary key (id);

-- 3i. Uusi rivi kuuluu aina kutsujalle. Sama periaate kuin tasks-taulussa.
alter table public.profile alter column id set default auth.uid();

-- 3j. Viite auth.users-tauluun. Tilin poisto vie profiilin mukanaan,
--     samasta syystä kuin vaiheessa 2f.
alter table public.profile
  add constraint profile_id_fkey
  foreign key (id) references auth.users(id) on delete cascade;

-- ---------------------------------------------------------------------
-- VAIHE 4: vanhat politiikat pois
--
-- Tuotannossa on "salli kaikki" -tyyppinen politiikka. Sen nimeen ei
-- luoteta: nimi on voitu antaa käsin dashboardissa. Poistetaan siksi
-- kaikki näiden kahden taulun politiikat nimestä riippumatta ja
-- kirjataan lokiin, mitä poistettiin.
--
-- Yksi jäljelle jäänyt salliva politiikka riittäisi kumoamaan koko
-- turvamallin: politiikat ovat OR-ehtoja keskenään.
-- ---------------------------------------------------------------------
do $$
declare
  pol record;
  v_dropped int := 0;
begin
  for pol in
    select policyname, tablename
      from pg_policies
     where schemaname = 'public'
       and tablename in ('tasks', 'profile')
  loop
    raise notice 'Poistetaan vanha politiikka %.%', pol.tablename, pol.policyname;
    execute format('drop policy %I on public.%I', pol.policyname, pol.tablename);
    v_dropped := v_dropped + 1;
  end loop;

  raise notice 'Poistettiin % vanhaa politiikkaa.', v_dropped;
end $$;

-- ---------------------------------------------------------------------
-- VAIHE 5: RLS ja lopulliset politiikat
--
-- Periaate: käyttäjä näkee ja muuttaa VAIN omia rivejään.
-- Kirjautumaton (anon) ei saa mitään — sille ei luoda yhtään politiikkaa.
--
-- FORCE ROW LEVEL SECURITY jätetään tarkoituksella pois. Se koskisi myös
-- taulun omistajaa (postgres), jolloin Supabase-dashboardin taulunäkymä ja
-- ylläpitokyselyt lakkaisivat toimimasta. PostgREST yhdistää rooleilla
-- anon ja authenticated, jotka eivät ole taulun omistajia, joten RLS on
-- niitä vastaan voimassa ilman FORCEa. Jos taulun omistajuus joskus
-- siirtyy, tämä päätös on arvioitava uudelleen.
-- ---------------------------------------------------------------------

alter table public.tasks   enable row level security;
alter table public.profile enable row level security;

-- tasks: omistajuus user_id-sarakkeessa
create policy tasks_select_own on public.tasks
  for select to authenticated
  using (auth.uid() = user_id);

create policy tasks_insert_own on public.tasks
  for insert to authenticated
  with check (auth.uid() = user_id);

create policy tasks_update_own on public.tasks
  for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy tasks_delete_own on public.tasks
  for delete to authenticated
  using (auth.uid() = user_id);

-- profile: omistajuus id-sarakkeessa
create policy profile_select_own on public.profile
  for select to authenticated
  using (auth.uid() = id);

create policy profile_insert_own on public.profile
  for insert to authenticated
  with check (auth.uid() = id);

create policy profile_update_own on public.profile
  for update to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);

create policy profile_delete_own on public.profile
  for delete to authenticated
  using (auth.uid() = id);

-- ---------------------------------------------------------------------
-- VAIHE 6: roolioikeudet
--
-- RLS on ensimmäinen puolustuslinja, oikeudet toinen. Kirjautumaton ei
-- tarvitse pääsyä henkilökohtaiseen dataan millään tasolla.
--
-- PUBLIC ENSIN. Tämä on olennaista eikä pelkkää huolellisuutta:
-- PostgreSQL-rooli PUBLIC ei ole rooli vaan "kaikki roolit". Sille
-- myönnetyn oikeuden perii jokainen rooli, myös anon — eikä
-- `revoke all ... from anon` poista sitä, koska anonilla ei ole sitä
-- suoraan. Se on peritty.
--
-- Toisin sanoen: pelkkä anon-revoke EI ole todiste siitä, ettei anon
-- pääse tauluun. Se on todiste vain siitä, ettei sillä ole SUORAA
-- oikeutta. Siksi PUBLIC suljetaan nimenomaisesti.
--
-- revoke all kattaa myös oikeudet TRUNCATE, REFERENCES ja TRIGGER,
-- joita yksikään näistä rooleista ei tarvitse. authenticated saa
-- takaisin vain neljä rivioperaatiota — ei enempää.
--
-- service_role ei ole tässä listassa tarkoituksella. Sen oikeudet ovat
-- nimenomaisia eivätkä perustu PUBLICiin, joten ne säilyvät
-- koskemattomina. Palvelinpuolen ylläpito ei saa rikkoutua tästä.
-- ---------------------------------------------------------------------
revoke all on table public.tasks   from public;
revoke all on table public.profile from public;

revoke all on table public.tasks   from anon;
revoke all on table public.profile from anon;

revoke all on table public.tasks   from authenticated;
revoke all on table public.profile from authenticated;

grant select, insert, update, delete on public.tasks   to authenticated;
grant select, insert, update, delete on public.profile to authenticated;

-- ---------------------------------------------------------------------
-- VAIHE 7: lopputilan tarkistus samassa transaktiossa
--
-- Viimeinen mahdollisuus perua automaattisesti. Tämän jälkeen commit on
-- lopullinen, ja korjaus vaatii ihmisen.
-- ---------------------------------------------------------------------
-- Oikeuksien tarkistus tehdään KAHDELLA eri tavalla, koska ne todistavat
-- eri asian:
--
--   1. pg_class.relacl + aclexplode  -> mitä on NIMENOMAISESTI myönnetty.
--      Tässä PUBLIC näkyy grantee-arvona 0. Se on ainoa luotettava tapa
--      nähdä PUBLIC-myönnöt; information_schema.role_table_grants ei
--      listaa niitä roolinimellä lainkaan.
--
--   2. has_table_privilege()         -> mitä rooli TODELLA saa tehdä.
--      Tämä ottaa huomioon sekä PUBLICin että roolijäsenyydet, eli juuri
--      ne perintäpolut, jotka suora revoke jättäisi näkemättä.
--
-- Kohta 1 yksin ei riitä (perintä jäisi huomaamatta). Kohta 2 yksin ei
-- riitä (ei kertoisi MISTÄ oikeus tulee). Molemmat yhdessä riittävät.
do $$
declare
  v_tables text[] := array['public.tasks', 'public.profile'];
  v_all    text[] := array['select', 'insert', 'update', 'delete',
                           'truncate', 'references', 'trigger'];
  v_crud   text[] := array['select', 'insert', 'update', 'delete'];
  v_extra  text[] := array['truncate', 'references', 'trigger'];
  t          text;
  pr         text;
  v_policies int;
  v_rls      int;
  v_public   int;
begin
  -- 7.1 Roolien olemassaolo. Ilman tätä has_table_privilege heittäisi
  --     epäselvän virheen, ja puuttuva rooli olisi itsessään merkki
  --     siitä, ettei tämä ole se kanta jota luultiin.
  foreach pr in array array['anon', 'authenticated'] loop
    if not exists (select 1 from pg_roles where rolname = pr) then
      raise exception 'Roolia % ei ole. Onko tama oikea Supabase-kanta?', pr;
    end if;
  end loop;

  -- 7.2 Politiikat.
  select count(*) into v_policies
    from pg_policies
   where schemaname = 'public' and tablename in ('tasks', 'profile');
  if v_policies <> 8 then
    raise exception 'Politiikkoja on %, pitaisi olla 8.', v_policies;
  end if;

  -- 7.3 RLS.
  select count(*) into v_rls
    from pg_class
   where relnamespace = 'public'::regnamespace
     and relname in ('tasks', 'profile')
     and relrowsecurity;
  if v_rls <> 2 then
    raise exception 'RLS on paalla vain %:ssa taulussa kahdesta.', v_rls;
  end if;

  -- 7.4 PUBLIC-roolille ei yhtään myönnettyä oikeutta. grantee = 0 on
  --     aclexplode-esityksessä PUBLIC.
  select count(*) into v_public
    from pg_class c, aclexplode(c.relacl) a
   where c.oid = any (array['public.tasks'::regclass,
                            'public.profile'::regclass])
     and a.grantee = 0;
  if v_public <> 0 then
    raise exception
      'PUBLIC-roolilla on % myonnettya oikeutta. Jokainen rooli perii ne, myos anon.',
      v_public;
  end if;

  foreach t in array v_tables loop
    -- 7.5 anon: ei yhtään TEHOLLISTA oikeutta. Tämä on se tarkistus,
    --     joka kattaa myös perityn oikeuden.
    foreach pr in array v_all loop
      if has_table_privilege('anon', t, pr) then
        raise exception
          'anon-roolilla on tehollinen oikeus % tauluun %. Julkinen avain riittaisi paasyyn.',
          pr, t;
      end if;
    end loop;

    -- 7.6 authenticated: tasan neljä rivioperaatiota.
    foreach pr in array v_crud loop
      if not has_table_privilege('authenticated', t, pr) then
        raise exception
          'authenticated-roolilta puuttuu oikeus % tauluun %. Sovellus ei toimisi.',
          pr, t;
      end if;
    end loop;

    -- 7.7 ...eikä yhtään enempää.
    foreach pr in array v_extra loop
      if has_table_privilege('authenticated', t, pr) then
        raise exception
          'authenticated-roolilla on tarpeeton oikeus % tauluun %.', pr, t;
      end if;
    end loop;
  end loop;

  raise notice
    'Lopputila kunnossa: 8 politiikkaa, RLS paalla, PUBLIC tyhja, anon ilman tehollista oikeutta, authenticated tasan 4.';
end $$;

commit;

-- =====================================================================
-- ROLLBACK
-- =====================================================================
--
-- Kolme eri tilannetta, kolme eri vastausta. Älä sekoita niitä.
--
-- 1. MIGRAATIO KAATUI KESKEN AJON
--    Ei tarvita mitään. Koko tiedosto ajetaan yhtenä transaktiona, ja
--    jokainen tarkistus on transaktion sisällä. Postgres peruu kaiken
--    itse. Kanta on täsmälleen siinä tilassa kuin ennen ajoa.
--    Lue virheilmoitus — se kertoo mikä esiehto ei täyttynyt.
--
-- 2. MIGRAATIO MENI LÄPI, MUTTA SE HALUTAAN PERUA
--    Tämä on mahdollista, koska alkuperäinen 'me' säilyy sarakkeessa
--    profile.legacy_id. Peruminen on kuitenkin KÄSITYÖTÄ, ei valmis
--    skripti. Sellaista ei kirjoiteta tähän valmiiksi: automaattinen
--    käänteismigraatio, jota kukaan ei ole koskaan ajanut, on
--    vaarallisempi kuin sen puuttuminen. Vaiheet ovat:
--
--      - poista kahdeksan politiikkaa
--      - kytke RLS pois molemmista tauluista
--      - pudota vierasavaimet profile_id_fkey ja tasks_user_id_fkey
--      - pudota profile_pkey, pudota sarake profile.id
--      - nimeä profile.legacy_id takaisin id:ksi ja palauta pääavain
--      - palauta sarakkeen oletusarvo 'me', jos vanha malli otetaan
--        oikeasti takaisin käyttöön (migraatio pudotti sen vaiheessa 3c)
--      - pudota sarake tasks.user_id ja indeksi tasks_user_id_date_idx
--      - palauta anon-roolin oikeudet, jos niitä oikeasti tarvitaan.
--        HUOM: PUBLIC-roolin oikeuksia EI palauteta. Ne olivat
--        perintäpolku anonille, ja niiden palauttaminen avaisi taulut
--        jokaiselle roolille kerralla.
--
--    Huomaa mitä tämä TARKOITTAA: paluu tilaan, jossa julkinen
--    anon-avain riittää lukemaan kaiken. Peruminen on tietoturvan
--    heikennys. Tee se vain, jos migraatio oikeasti rikkoi jotain.
--
-- 3. DATA MENI PIELEEN
--    Palauta varmuuskopiosta. Rivimäärätarkistukset (vaiheet 2c, 3f, 7)
--    on kirjoitettu juuri sitä varten, ettei tähän tarvitse päätyä.
--
-- OTA VARMUUSKOPIO ENNEN AJOA. Kirjaa sen aikaleima runbookiin.
--
-- =====================================================================
-- MIGRAATION JÄLKEEN
-- =====================================================================
-- Aja supabase/verify/verify_0001.sql. Se on vain lukeva.
-- Sen jälkeen runbookin PYSÄYTYS 3 ja PYSÄYTYS 5 (kahden tilin
-- eristystesti). Eristystesti on ainoa oikea todiste siitä, että RLS
-- toimii. Kaikki muu on päättelyä.
