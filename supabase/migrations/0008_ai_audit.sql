-- =====================================================================
-- Manifestival — migraatio 0008: AI-toimintojen kirjausketju
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
-- Migraatiot 0003–0007 EIVÄT ole esiehto: tämä taulu ei viittaa
-- yhteenkään niiden tauluun. Järjestys on silti se, jossa ne ajetaan.
--
-- TARKOITUS
-- Kirjaus siitä, mitä AI ehdotti, mitä käyttäjä vahvisti ja mitä oikeasti
-- tapahtui. Se vastaa kysymykseen "miksi tämä muuttui?" silloin kun
-- käyttäjä ei muista tehneensä muutosta.
--
-- ---------------------------------------------------------------------
-- MITÄ TÄMÄ EI OLE
-- ---------------------------------------------------------------------
-- Tämä EI ole analytiikkaa. Se ei mittaa käyttöä, ei seuraa
-- käyttäytymistä eikä lähde mihinkään. Se on käyttäjän oma loki hänen
-- omista toimistaan, ja se poistuu käyttäjän mukana (on delete cascade).
--
-- ---------------------------------------------------------------------
-- ARKALUONTOISUUS: RAAKAA SYÖTETTÄ EI TALLENNETA
-- ---------------------------------------------------------------------
-- "Soita Matille numeroon 040 1234567 ja kysy koetuloksista" on lause,
-- jonka käyttäjä ei odota säilyvän lokissa. Siksi tallennetaan vain
-- LYHENNETTY tiivistelmä, jonka pituus on rajattu kannassa asti.
--
-- Rajoitus on tässä eikä pelkästään sovelluksessa, koska sovellusvirhe ei
-- saa johtaa siihen, että koko päiväkirjamerkintä päätyy tietokantaan.
--
-- Samasta syystä yksikään tämän paketin varmistus- tai
-- diagnostiikkakysely EI lue sarakkeita input_summary eikä proposal —
-- vain rivimääriä ja rakennetta.
--
-- KÄYTTÖÖNOTTO KOODISSA
-- Migraation JA hyväksyntätestin jälkeen:
-- src/data/schema.js -> TABLES.aiAudit = true.
--
-- =====================================================================
-- OMISTAJUUS: MIKSI target_id EI OLE VIERASAVAIN
-- =====================================================================
-- Migraatiot 0003, 0004 ja 0007 muuttivat jokaisen viittauksensa
-- yhdistelmävierasavaimeksi, koska tavallinen vierasavain sallii
-- ristiinkiinnityksen: vierasavaimen tarkistus ei kulje RLS:n läpi.
--
-- Tässä taulussa target_id EI ole vierasavain lainkaan, eikä siitä pidä
-- tehdä sellaista. Syy on kirjausketjun luonteessa:
--
--   Kirjaus kertoo, mitä tapahtui. Yleisin kirjattava tapahtuma on
--   POISTO. Jos target_id olisi vierasavain, kohteen poisto joko
--   poistaisi kirjauksen (cascade) tai tyhjentäisi sen (set null) — ja
--   kummassakin tapauksessa juuri se tieto katoaisi, jonka takia loki
--   on olemassa.
--
-- MIKSI TÄMÄ EI OLE SAMA AUKKO KUIN 0004:SSÄ
-- Aukko 0004:ssä oli se, että B pystyi KIINNITTÄMÄÄN oman rivinsä A:n
-- riviin — luomaan kannan tasolla suhteen, jota ei pitäisi olla. Tässä
-- suhdetta ei ole: target_id on tekstikenttä B:n omalla rivillä, jonka
-- vain B näkee. Se ei anna B:lle pääsyä A:n riviin, ei paljasta sen
-- sisältöä eikä näy A:lle mitenkään. Se on merkintä B:n omassa lokissa.
--
-- Ero on olennainen: 0004:ssä kanta olisi VAHVISTANUT väärän suhteen,
-- tässä kanta ei vahvista mitään suhdetta.
--
-- Alla oleva loppuvarmistus tarkistaa, ETTEI tässä taulussa ole yhtään
-- viitettä sovellustauluihin. Jos sellainen joskus lisätään, väite
-- vanhenee ja varmistus kaatuu — se on tarkoitus.
--
-- MITÄ TÄMÄ EI OLE
-- Tämä ei ole idempotentti migraatio, ja se on tarkoitus. Aiempi versio
-- käytti `if not exists` -muotoa, jolloin toinen ajo, kesken jäänyt ajo
-- ja tuore ajo näyttivät kaikki onnistuneelta. Tila, jota ei voi erottaa,
-- on tila jota ei voi korjata. Nyt migraatio laskee yksitoista objektiaan
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
  --    Yksitoista objektia: yksi taulu, viisi tarkistetta, yksi indeksi
  --    ja nelja politiikkaa. Nolla = tuore ajo. Mika tahansa muu luku
  --    tarkoittaa, etta ajo on tehty tai jaanyt kesken — eika kumpaakaan
  --    korjata ajamalla uudelleen.
  --
  --    Liipaisinta ei ole: taulussa on vain created_at eika updated_at.
  --    Kirjaus ei muutu jalkikateen, joten sille ei ole mita koskettaa.
  select count(*) into olemassa from (
    select 1 from pg_tables
      where schemaname = 'public' and tablename = 'ai_action_audit'
    union all
    select 1 from pg_constraint
      where conname in ('ai_action_audit_result_check',
                        'ai_action_audit_risk_check',
                        'ai_action_audit_summary_length_check',
                        'ai_action_audit_proposal_length_check',
                        'ai_action_audit_confirmed_check')
    union all
    select 1 from pg_indexes
      where schemaname = 'public' and indexname = 'ai_action_audit_user_time_idx'
    union all
    select 1 from pg_policies
      where schemaname = 'public' and tablename = 'ai_action_audit'
  ) kaikki;

  if olemassa = 11 then
    raise exception 'Migraatio 0008 on JO AJETTU. Ala aja uudelleen — aja supabase/verify/verify_0008.sql.';
  end if;

  if olemassa > 0 then
    select string_agg(nimi, ', ' order by nimi) into nimet from (
      select tablename::text as nimi from pg_tables
        where schemaname = 'public' and tablename = 'ai_action_audit'
      union all
      select conname::text from pg_constraint
        where conname in ('ai_action_audit_result_check',
                          'ai_action_audit_risk_check',
                          'ai_action_audit_summary_length_check',
                          'ai_action_audit_proposal_length_check',
                          'ai_action_audit_confirmed_check')
      union all
      select indexname::text from pg_indexes
        where schemaname = 'public' and indexname = 'ai_action_audit_user_time_idx'
      union all
      select policyname::text from pg_policies
        where schemaname = 'public' and tablename = 'ai_action_audit'
    ) loydetyt;

    raise exception 'Migraatio 0008 on kesken: % objektia 11:sta on jo olemassa (%). Ks. docs/MIGRATION-0008-RECOVERY.md.',
      olemassa, nimet;
  end if;

  raise notice 'Esiehdot kunnossa. Omistaja %, 0008:n objekteja 0/11.', omistaja;
end $$;

-- ---------------------------------------------------------------------
-- VAIHE 1: ai_action_audit
-- ---------------------------------------------------------------------
create table public.ai_action_audit (
  id             text primary key,
  user_id        uuid not null default auth.uid()
                 references auth.users(id) on delete cascade,

  occurred_at    timestamptz not null default now(),

  -- LYHENNETTY tiivistelmä, ei raaka syöte. Pituusrajoite on alempana.
  input_summary  text,

  intent         text not null,
  risk           text not null,
  target_type    text,

  -- Kohteen tunniste ILMAN vierasavainta: kohde on voitu poistaa, ja
  -- kirjaus siitä on nimenomaan se, mitä halutaan säilyttää.
  -- Ks. tiedoston alun perustelu.
  target_id      text,

  proposal       text,
  confirmed      boolean not null default false,
  executed       boolean not null default false,
  result         text not null default 'proposed',
  error_code     text,

  created_at     timestamptz not null default now()
);

alter table public.ai_action_audit
  add constraint ai_action_audit_result_check
  check (result in ('proposed', 'cancelled', 'executed', 'failed', 'ambiguous', 'rejected'));

alter table public.ai_action_audit
  add constraint ai_action_audit_risk_check
  check (risk in ('low', 'medium', 'high'));

-- Pituusrajoite on tässä eikä pelkästään sovelluksessa: sovellusvirhe ei
-- saa johtaa siihen, että koko päiväkirjamerkintä päätyy tietokantaan.
alter table public.ai_action_audit
  add constraint ai_action_audit_summary_length_check
  check (input_summary is null or length(input_summary) <= 200);

alter table public.ai_action_audit
  add constraint ai_action_audit_proposal_length_check
  check (proposal is null or length(proposal) <= 300);

-- KESKEINEN INVARIANTTI: suoritettu komento ilman vahvistusta olisi merkki
-- turvamallin rikkoutumisesta. Kirjaus ei saa väittää sellaista tapahtuneen.
alter table public.ai_action_audit
  add constraint ai_action_audit_confirmed_check
  check (executed = false or confirmed = true);

create index ai_action_audit_user_time_idx
  on public.ai_action_audit (user_id, occurred_at desc);

-- ---------------------------------------------------------------------
-- VAIHE 2: RLS
-- ---------------------------------------------------------------------
alter table public.ai_action_audit enable row level security;

create policy ai_action_audit_select_own on public.ai_action_audit
  for select to authenticated using (auth.uid() = user_id);
create policy ai_action_audit_insert_own on public.ai_action_audit
  for insert to authenticated with check (auth.uid() = user_id);
create policy ai_action_audit_update_own on public.ai_action_audit
  for update to authenticated using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
create policy ai_action_audit_delete_own on public.ai_action_audit
  for delete to authenticated using (auth.uid() = user_id);

-- PUBLIC ENSIN, EIKA VAIN ANON.
--
-- PostgreSQL-rooli PUBLIC tarkoittaa "kaikki roolit", ja sille myonnetyn
-- oikeuden perii jokainen rooli — myos anon. Perittya oikeutta ei nay
-- roolikohtaisissa listauksissa lainkaan, joten `revoke ... from anon`
-- ei poista sita eika sen puuttumista huomaisi mistaan.
revoke all on public.ai_action_audit from public;
revoke all on public.ai_action_audit from anon;

-- Myos authenticated nollataan ensin, jotta lopputulos on TASAN nelja
-- oikeutta eika "nelja plus se mita oletusoikeudet sattuivat antamaan".
revoke all on public.ai_action_audit from authenticated;

grant select, insert, update, delete on public.ai_action_audit to authenticated;

-- ---------------------------------------------------------------------
-- VAIHE 3: loppuvarmistus ENNEN COMMITTIA
-- ---------------------------------------------------------------------
do $$
declare
  luku      int;
  -- Sama hyvaksytty omistaja kuin esiehdoissa. Tarvitaan invariantin
  -- kokeeseen, jotta rivi ei kaadu NOT NULLiin vaan tarkisteeseen.
  omistaja  uuid := '2cc00622-f927-4604-a518-361a4328481b'::uuid;
begin
  if not exists (
    select 1 from pg_tables
     where schemaname = 'public' and tablename = 'ai_action_audit'
  ) then
    raise exception 'Taulua ai_action_audit ei syntynyt.';
  end if;

  if (select count(*) from public.ai_action_audit) <> 0 then
    raise exception 'Uusi taulu ei ole tyhja. Jotain on jo kirjoitettu.';
  end if;

  -- RLS on paalla.
  if not exists (
    select 1 from pg_class
     where relnamespace = 'public'::regnamespace
       and relname = 'ai_action_audit' and relrowsecurity
  ) then
    raise exception 'RLS ei ole paalla taulussa ai_action_audit.';
  end if;

  -- Nelja politiikkaa, kaikki authenticated-roolille, ja MOLEMMAT puolet
  -- oikein. Jos vain USING tarkistettaisiin, kayttaja voisi ottaa oman
  -- rivinsa ja kirjoittaa sen toisen nimiin.
  select count(*) into luku from pg_policies
   where schemaname = 'public' and tablename = 'ai_action_audit'
     and roles = '{authenticated}'::name[]
     and coalesce(btrim(replace(qual,       ' ', ''), '()'), 'auth.uid()=user_id') = 'auth.uid()=user_id'
     and coalesce(btrim(replace(with_check, ' ', ''), '()'), 'auth.uid()=user_id') = 'auth.uid()=user_id';
  if luku <> 4 then
    raise exception 'Vain %/4 politiikkaa rajaa omistajuuden oikein.', luku;
  end if;

  select count(*) into luku from pg_policies
   where schemaname = 'public' and tablename = 'ai_action_audit';
  if luku <> 4 then
    raise exception 'Taulussa on % politiikkaa neljan sijaan.', luku;
  end if;

  -- KESKEINEN INVARIANTTI ON OLEMASSA JA SE PUREE.
  --
  -- Rajoitteen olemassaolo ei todista, etta se tekee mita nimi lupaa.
  -- `check (executed = false or confirmed = true)` voisi olla kirjoitettu
  -- vaarin päin ja nayttaisi luettelossa aivan samalta. Siksi tassa
  -- yritetaan oikeasti kirjoittaa rivi, joka vaittaa komennon
  -- suoritetuksi ilman vahvistusta. Sen ON kaaduttava.
  --
  -- MIKSI user_id ANNETAAN NIMENOMAISESTI
  -- Sarakkeen oletus on auth.uid(), joka on SQL-editorissa NULL, koska
  -- editorilla ei ole kayttajan tokenia. Ilman nimenomaista arvoa rivi
  -- kaatuisi NOT NULL -virheeseen (23502) eika tarkisteeseen (23514) —
  -- ja koe "onnistuisi" vaarasta syysta. Tassa vaaditaan nimenomaan
  -- check_violation.
  --
  -- MIKSI TAMA EI KIRJOITA MITAAN
  -- plpgsql:n `begin ... exception ... end` -lohko on oma sisainen
  -- savepointtinsa: poikkeuksen sattuessa lohkon kaikki muutokset
  -- perutaan automaattisesti. Nimenomaista SAVEPOINT-lausetta ei voi
  -- kayttaa plpgsql:ssa lainkaan. Rivi ei siis paady tauluun edes
  -- hetkeksi, ja alla oleva rivimaaran tarkistus todistaa sen.
  begin
    insert into public.ai_action_audit
      (id, user_id, intent, risk, executed, confirmed)
    values ('invariantin_koe', omistaja, 'create_task', 'medium', true, false);

    -- Tanne ei pitaisi paasta. Talla koodilla (P0001) on eri SQLSTATE
    -- kuin alla kasitellyilla, joten se kulkee lapi ja kaataa migraation.
    raise exception 'Rajoite ai_action_audit_confirmed_check ei pure: vahvistamaton suoritus meni lapi.';
  exception
    when check_violation then
      null;  -- odotettu tulos
    when not_null_violation then
      raise exception 'Invariantin koe kaatui NOT NULLiin eika tarkisteeseen. Koe ei todistanut mitaan.';
  end;

  -- Ja taulu on yha tyhja: lohkon muutokset peruttiin.
  if (select count(*) from public.ai_action_audit) <> 0 then
    raise exception 'Invariantin koe jatti rivin tauluun.';
  end if;

  -- TAULUSSA EI OLE YHTAAN VIITETTA SOVELLUSTAULUIHIN.
  --
  -- Tama on se vaite, jonka nojalla target_id saa olla pelkkaa tekstia
  -- (ks. tiedoston alun perustelu). Jos viite joskus lisataan, vaite
  -- vanhenee ja tama kaatuu — se on tarkoitus.
  select count(*) into luku
    from pg_constraint con
    join pg_class ft on ft.oid = con.confrelid
   where con.conrelid = 'public.ai_action_audit'::regclass
     and con.contype = 'f'
     and ft.relnamespace = 'public'::regnamespace;
  if luku <> 0 then
    raise exception 'Taulussa on % viitetta public-skeemaan. target_id:n perustelu ei enaa pade.', luku;
  end if;

  -- anon ei saa mitaan, edes perittyna.
  select count(*) into luku
    from (select unnest(array['select', 'insert', 'update', 'delete',
                              'truncate', 'references', 'trigger']) as oikeus) pp
   where has_table_privilege('anon', 'public.ai_action_audit', pp.oikeus);
  if luku <> 0 then
    raise exception 'anon-roolilla on % tehollista oikeutta uuteen tauluun.', luku;
  end if;

  -- PUBLIC-roolilla ei saa olla mitaan, ja tama katsotaan TAULUN
  -- OIKEUSLISTASTA eika roolikohtaisesti. Kaksi menetelmaa, koska
  -- kumpikaan ei yksin riita: has_table_privilege kertoo ONKO oikeus
  -- (perinta mukaan lukien), aclexplode kertoo MISTA se tulee.
  select count(*) into luku
    from pg_class cl, aclexplode(cl.relacl) acl
   where cl.oid = 'public.ai_action_audit'::regclass
     and acl.grantee = 0;
  if luku <> 0 then
    raise exception 'PUBLIC-roolilla on % oikeutta uuteen tauluun.', luku;
  end if;

  -- authenticated saa tasan CRUD, ei enempaa.
  select count(*) into luku
    from (select unnest(array['select', 'insert', 'update', 'delete',
                              'truncate', 'references', 'trigger']) as oikeus) pp
   where has_table_privilege('authenticated', 'public.ai_action_audit', pp.oikeus);
  if luku <> 4 then
    raise exception 'authenticated-roolilla on % oikeutta, odotettiin 4 (CRUD).', luku;
  end if;

  raise notice 'Migraatio 0008 valmis. Aja seuraavaksi supabase/verify/verify_0008.sql.';
end $$;

commit;

-- =====================================================================
-- VARMISTUS MIGRAATION JÄLKEEN
-- =====================================================================
-- supabase/verify/verify_0008.sql — yksi lause, yksi taulukko.
-- Se ei lue sarakkeita input_summary eikä proposal.
--
-- Keskeinen invariantti testataan jo migraation sisällä (VAIHE 3):
-- vahvistamaton suoritus yritetään kirjoittaa ja sen on kaaduttava.
--
-- =====================================================================
-- ROLLBACK
-- =====================================================================
--   begin;
--   set local lock_timeout = '5s';
--   drop table if exists public.ai_action_audit;
--   commit;
--
-- Muista tällöin palauttaa src/data/schema.js -> TABLES.aiAudit = false.
