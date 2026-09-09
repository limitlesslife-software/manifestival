-- =====================================================================
-- Manifestival — migraatio 0009: Talous 2.0
-- =====================================================================
--
-- TILA: EI AJETTU TUOTANTOON. EI HYVÄKSYTTY.
--
-- TÄMÄ ON SUUNNITELMA, EI SUORITUSKÄSKY. Tiedosto on migraatioiden
-- hakemistossa, koska se on niiden kanssa sama käsite ja sitä
-- tarkistetaan samoilla testeillä. Sitä EI OLE AJETTU eikä sitä saa
-- ajaa ennen kuin Panu on erikseen hyväksynyt sen — ks. tiedoston
-- lopun kohta HYVÄKSYNTÄPORTTI.
--
-- Talous 2.0:n sovelluskoodi toimii ilman tätä migraatiota: portit
-- `transactions` ja `investments` ovat kiinni, jolloin tieto elää
-- istunnon muistissa kuten muillakin aktivoimattomilla domaineilla.
-- Migraatio tarvitaan vasta kun ne halutaan säilyviksi.
--
-- =====================================================================
-- MITÄ TÄMÄ LISÄÄ
-- =====================================================================
--
--   public.transactions   uusi taulu   yhtenäinen meno/tulo/siirto
--   public.investments    uusi taulu   salkun omistukset
--   public.bills          MUUTOS       kolme uutta saraketta
--
-- =====================================================================
-- MITÄ TÄMÄ EI LISÄÄ — EIKÄ SAA LISÄTÄ
-- =====================================================================
--
-- KUITEILLE EI OLE TAULUA. Se ei ole unohdus.
--
-- Kuitin kuva on koko sovelluksen henkilökohtaisin tieto: se kertoo
-- missä olit, milloin ja mitä ostit. Sitä ei talleteta mihinkään — ei
-- Storageen, ei sarakkeeseen, ei base64-merkkijonona.
--
-- Luenta elää vain istunnon muistissa siihen asti että käyttäjä
-- hyväksyy sen, ja hyväksytystä luennasta syntyy tavallinen rivi
-- transactions-tauluun. Kuva vapautetaan heti.
--
-- Taulu jota ei ole, ei voi vahingossa täyttyä. Jos kuittitaulu joskus
-- lisätään, se on tietoinen tietosuojapäätös eikä toteutuksen
-- sivutuote.
--
-- TULOILLE EI OLE OMAA TAULUA. Tulo on transactions-rivi, jonka `kind`
-- on 'income'. Erillinen taulu tarkoittaisi kahta paikkaa laskea rahaa
-- ja kahta tapaa laskea se väärin.
--
-- =====================================================================
-- OMISTAJUUS
-- =====================================================================
--
-- Molemmat uudet taulut saavat `owner_row_key`-avaimen (user_id, id).
-- Se on se avain, jota YHDISTELMÄVIERASAVAIN vaatii kohteeltaan, ja
-- sen puuttuminen huomattaisiin vasta kun joku yrittää viitata näihin
-- tauluihin.
--
-- Tässä migraatiossa ei ole yhtäkään vierasavainta sovellustauluihin.
-- Se on tietoinen valinta:
--
--   transactions.source_id EI OLE VIERASAVAIN. Lähde saa kadota, mutta
--   tapahtuman on säilyttävä. Maksettu lasku, joka poistetaan, ei tee
--   maksua tapahtumattomaksi. Sama perustelu kuin
--   ai_action_audit.target_id -sarakkeessa migraatiossa 0008.
--
--   Ristiinkiinnitystä ei silti synny: source_id ei ole viite vaan
--   merkintä alkuperästä. Se ei anna pääsyä mihinkään, koska RLS
--   rajaa molemmat päät erikseen.
--
-- Omistajuuden asettaa `default auth.uid()` ja RLS valvoo sitä.
--
-- =====================================================================
-- OBJEKTIEN MÄÄRÄ: 39
-- =====================================================================
--
--    2  taulua          transactions, investments
--   10  rajoitetta      transactions (9 check + owner_row_key)
--    8  rajoitetta      investments (7 check + owner_row_key)
--    3  rajoitetta      bills (payee, iban, reference)
--    3  saraketta       bills
--    3  indeksiä        transactions x2, investments x1
--    2  liipaisinta     touch_updated_at
--    8  politiikkaa     4 + 4
--
-- Luku on käsin laskettu ja sitä käytetään osittaisen ajon
-- tunnistukseen. Nolla = tuore ajo. Mikä tahansa muu luku tarkoittaa,
-- että ajo on tehty tai jäänyt kesken — eikä kumpaakaan korjata
-- ajamalla uudelleen.

begin;

-- ---------------------------------------------------------------------
-- VAIHE 0a: lukitusraja
--
-- Migraatio viittaa auth.users-tauluun, ja vierasavaimen luonti ottaa
-- viitattuun tauluun SHARE ROW EXCLUSIVE -lukon. auth.users on taulu,
-- jota jokainen kirjautuminen koskee.
--
-- Raja koskee myös bills-taulua: ADD COLUMN ottaa siihen ACCESS
-- EXCLUSIVE -lukon ja kolme uutta CHECK-rajoitetta validoidaan
-- olemassa olevia rivejä vastaan.
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

  -- 2. 0002 on ajettu. Sen mukana tuli touch_updated_at, joka
  --    tarkistetaan erikseen vaiheessa 0c.
  select count(*) into olemassa
    from information_schema.columns
   where table_schema = 'public' and table_name = 'tasks'
     and column_name in ('description', 'duration_minutes', 'priority',
                         'scheduling_state', 'created_at', 'updated_at');
  if olemassa <> 6 then
    raise exception 'Migraatio 0002 puuttuu: tasks-taulussa on % kuudesta lisasarakkeesta.', olemassa;
  end if;

  -- 3. 0007 on ajettu: bills-taulu on olemassa. Tama migraatio LISAA
  --    siihen sarakkeita, joten sen on oltava paikallaan.
  if not exists (
    select 1 from pg_tables where schemaname = 'public' and tablename = 'bills'
  ) then
    raise exception 'Migraatio 0007 puuttuu: taulua public.bills ei ole.';
  end if;

  -- 4. Olen oikeassa tietokannassa.
  if not exists (select 1 from auth.users where id = omistaja) then
    raise exception 'Hyvaksyttya omistajaa % ei loydy auth.users-taulusta. Vaara projekti?', omistaja;
  end if;

  -- 5. OSITTAISEN TAI AIEMMAN AJON TUNNISTUS — 39 objektia.
  --
  --    Funktio touch_updated_at EI ole listassa: sen luo migraatio
  --    0002. Tama migraatio ei luo sita eika korvaa sita.
  select count(*) into olemassa from (
    select 1 from pg_tables
      where schemaname = 'public'
        and tablename in ('transactions', 'investments')
    union all
    select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'bills'
        and column_name in ('payee', 'iban', 'reference')
    union all
    select 1 from pg_constraint
      where conname in ('transactions_kind_check',
                        'transactions_origin_check',
                        'transactions_amount_check',
                        'transactions_currency_check',
                        'transactions_source_pair_check',
                        'transactions_source_kind_check',
                        'transactions_transfer_category_check',
                        'transactions_description_length_check',
                        'transactions_note_length_check',
                        'transactions_owner_row_key',
                        'investments_kind_check',
                        'investments_value_source_check',
                        'investments_quantity_check',
                        'investments_amounts_check',
                        'investments_currency_check',
                        'investments_name_check',
                        'investments_unknown_value_check',
                        'investments_owner_row_key',
                        'bills_payee_length_check',
                        'bills_iban_check',
                        'bills_reference_check')
    union all
    select 1 from pg_indexes
      where schemaname = 'public'
        and indexname in ('transactions_user_date_idx',
                          'transactions_user_source_idx',
                          'investments_user_name_idx')
    union all
    select 1 from pg_trigger
      where not tgisinternal
        and tgname in ('transactions_touch_updated_at',
                       'investments_touch_updated_at')
    union all
    select 1 from pg_policies
      where schemaname = 'public'
        and tablename in ('transactions', 'investments')
  ) kaikki;

  if olemassa = 39 then
    raise exception 'Migraatio 0009 on JO AJETTU. Ala aja uudelleen — aja supabase/verify/verify_0009.sql.';
  end if;

  if olemassa > 0 then
    select string_agg(nimi, ', ' order by nimi) into nimet from (
      select tablename::text as nimi from pg_tables
        where schemaname = 'public'
          and tablename in ('transactions', 'investments')
      union all
      select column_name::text from information_schema.columns
        where table_schema = 'public' and table_name = 'bills'
          and column_name in ('payee', 'iban', 'reference')
      union all
      select conname::text from pg_constraint
        where conname in ('transactions_kind_check',
                          'transactions_origin_check',
                          'transactions_amount_check',
                          'transactions_currency_check',
                          'transactions_source_pair_check',
                          'transactions_source_kind_check',
                          'transactions_transfer_category_check',
                          'transactions_description_length_check',
                          'transactions_note_length_check',
                          'transactions_owner_row_key',
                          'investments_kind_check',
                          'investments_value_source_check',
                          'investments_quantity_check',
                          'investments_amounts_check',
                          'investments_currency_check',
                          'investments_name_check',
                          'investments_unknown_value_check',
                          'investments_owner_row_key',
                          'bills_payee_length_check',
                          'bills_iban_check',
                          'bills_reference_check')
      union all
      select indexname::text from pg_indexes
        where schemaname = 'public'
          and indexname in ('transactions_user_date_idx',
                            'transactions_user_source_idx',
                            'investments_user_name_idx')
      union all
      select tgname::text from pg_trigger
        where not tgisinternal
          and tgname in ('transactions_touch_updated_at',
                         'investments_touch_updated_at')
      union all
      select policyname::text from pg_policies
        where schemaname = 'public'
          and tablename in ('transactions', 'investments')
    ) loydetyt;

    raise exception 'Migraatio 0009 on kesken: % objektia 39:sta on jo olemassa (%).',
      olemassa, nimet;
  end if;

  raise notice 'Esiehdot kunnossa. Omistaja %, 0009:n objekteja 0/39.', omistaja;
end $$;

-- ---------------------------------------------------------------------
-- VAIHE 0c: touch_updated_at on yhä kovennettu
--
-- Funktio luodaan kerran migraatiossa 0002. Myöhemmät migraatiot
-- tarkistavat sen, eivät kirjoita sitä uudelleen. SECURITY DEFINER
-- -taantuma näkyisi vain siinä, mitä ei enää olisi — ei missään
-- virheessä.
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
-- VAIHE 1: transactions
-- ---------------------------------------------------------------------

create table public.transactions (
  id            text primary key,
  user_id       uuid not null default auth.uid()
                references auth.users(id) on delete cascade,

  -- expense | income | transfer. Suunta tulee lajista, EI etumerkistä.
  kind          text not null,

  -- manual | receipt | bill | recurring | savings | investment
  origin        text not null default 'manual',

  -- SENTTEINÄ, aina positiivinen. Ks. src/domain/money.js.
  amount_minor  bigint not null,
  currency      text not null default 'EUR',

  -- Päivä jona raha liikkui. date, EI timestamptz: aikaleima siirtäisi
  -- suomalaisen lokakuun ensimmäisen edelliselle päivälle UTC:ssä, ja
  -- kuukausibudjetti laskisi sen väärään kuukauteen.
  date          date not null,

  -- Kululuokka menoille, tuloluokka tuloille, NULL siirroille.
  category      text,

  description   text,
  note          text,

  -- Mistä tapahtuma syntyi. EI vierasavain — ks. tiedoston alku.
  source_kind   text,
  source_id     text,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

alter table public.transactions
  add constraint transactions_kind_check
  check (kind in ('expense', 'income', 'transfer'));

alter table public.transactions
  add constraint transactions_origin_check
  check (origin in ('manual', 'receipt', 'bill', 'recurring', 'savings', 'investment'));

-- Nollan suuruinen rahaliike ei ole tapahtuma, eikä negatiivinen ole
-- suunta: suunta on `kind`.
alter table public.transactions
  add constraint transactions_amount_check
  check (amount_minor > 0);

alter table public.transactions
  add constraint transactions_currency_check
  check (currency ~ '^[A-Z]{3}$');

-- Lähdelaji ilman tunnistetta ei osoita mihinkään, ja tunniste ilman
-- lajia ei kerro mihin se osoittaa. Kumpikin tarvitsee toisen.
alter table public.transactions
  add constraint transactions_source_pair_check
  check ((source_kind is null and source_id is null)
      or (source_kind is not null and source_id is not null));

alter table public.transactions
  add constraint transactions_source_kind_check
  check (source_kind is null or source_kind in
        ('bill', 'recurring_expense', 'savings_goal', 'receipt', 'investment'));

-- Siirrolla ei ole kululuokkaa: se ei ole kulutusta eikä tuloa.
alter table public.transactions
  add constraint transactions_transfer_category_check
  check (kind <> 'transfer' or category is null);

alter table public.transactions
  add constraint transactions_description_length_check
  check (description is null or length(description) <= 200);

alter table public.transactions
  add constraint transactions_note_length_check
  check (note is null or length(note) <= 500);

alter table public.transactions
  add constraint transactions_owner_row_key unique (user_id, id);

create index transactions_user_date_idx
  on public.transactions (user_id, date desc);

-- Kaksoislaskennan esto nojaa lähdehakuun: budjetti kysyy jokaisesta
-- maksetusta laskusta, onko siitä jo tapahtuma. Ilman indeksiä
-- jokainen kysymys kävisi koko taulun läpi.
create index transactions_user_source_idx
  on public.transactions (user_id, source_kind, source_id);

alter table public.transactions enable row level security;

create policy transactions_select_own on public.transactions
  for select to authenticated using (auth.uid() = user_id);
create policy transactions_insert_own on public.transactions
  for insert to authenticated with check (auth.uid() = user_id);
create policy transactions_update_own on public.transactions
  for update to authenticated using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
create policy transactions_delete_own on public.transactions
  for delete to authenticated using (auth.uid() = user_id);

-- ROOLI PUBLIC TARKOITTAA "KAIKKI ROOLIT", ja sille myönnetyn
-- oikeuden perii jokainen rooli — myös anon. Perittyä oikeutta ei näy
-- roolikohtaisissa listauksissa lainkaan, joten pelkkä
-- `revoke ... from anon` ei poistaisi sitä eikä sen jäämistä
-- huomaisi mistään. Siksi nollaus tehdään kaikille kolmelle roolille
-- ennen myöntämistä.
revoke all on public.transactions from public;
revoke all on public.transactions from anon;
revoke all on public.transactions from authenticated;
grant select, insert, update, delete on public.transactions to authenticated;

create trigger transactions_touch_updated_at
  before update on public.transactions
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------
-- VAIHE 2: investments
-- ---------------------------------------------------------------------

create table public.investments (
  id                  text primary key,
  user_id             uuid not null default auth.uid()
                      references auth.users(id) on delete cascade,

  name                text not null,
  symbol              text,
  kind                text not null default 'other',

  -- MÄÄRÄ EI OLE RAHAA. Osakkeita voi olla 12,5 ja kryptoa 0,00031.
  -- numeric, ei bigint: murto-osat ovat todellisia eikä määrällä ole
  -- valuuttaa. Rahasummat ovat yhä kokonaislukuja sentteinä.
  quantity            numeric(20, 8),

  cost_basis_minor    bigint,
  -- Käsin kirjattu nykyarvo. NULL = TUNTEMATON, EI nolla.
  current_value_minor bigint,
  valued_on           date,
  -- manual | unknown | provider. 'provider' on varattu tulevalle
  -- markkinadatan toimittajalle, jota ei ole olemassa.
  value_source        text not null default 'unknown',

  currency            text not null default 'EUR',
  target_value_minor  bigint,

  note                text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

alter table public.investments
  add constraint investments_kind_check
  check (kind in ('stock', 'fund', 'etf', 'crypto', 'index', 'other'));

alter table public.investments
  add constraint investments_value_source_check
  check (value_source in ('manual', 'unknown', 'provider'));

alter table public.investments
  add constraint investments_quantity_check
  check (quantity is null or quantity > 0);

alter table public.investments
  add constraint investments_amounts_check
  check ((cost_basis_minor is null or cost_basis_minor >= 0)
     and (current_value_minor is null or current_value_minor >= 0)
     and (target_value_minor is null or target_value_minor >= 0));

alter table public.investments
  add constraint investments_currency_check
  check (currency ~ '^[A-Z]{3}$');

alter table public.investments
  add constraint investments_name_check
  check (length(btrim(name)) > 0 and length(name) <= 120);

-- TUNTEMATON ARVO EI SAA VÄITTÄÄ OLEVANSA KÄSIN KIRJATTU. Jos arvoa ei
-- ole, ainoa sallittu lähde on 'unknown' — muuten käyttöliittymä
-- näyttäisi puuttuvan arvon kirjattuna ja laskisi tuoton nollasta.
alter table public.investments
  add constraint investments_unknown_value_check
  check (current_value_minor is not null or value_source = 'unknown');

alter table public.investments
  add constraint investments_owner_row_key unique (user_id, id);

create index investments_user_name_idx on public.investments (user_id, name);

alter table public.investments enable row level security;

create policy investments_select_own on public.investments
  for select to authenticated using (auth.uid() = user_id);
create policy investments_insert_own on public.investments
  for insert to authenticated with check (auth.uid() = user_id);
create policy investments_update_own on public.investments
  for update to authenticated using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
create policy investments_delete_own on public.investments
  for delete to authenticated using (auth.uid() = user_id);

-- ROOLI PUBLIC TARKOITTAA "KAIKKI ROOLIT", ja sille myönnetyn
-- oikeuden perii jokainen rooli — myös anon. Perittyä oikeutta ei näy
-- roolikohtaisissa listauksissa lainkaan, joten pelkkä
-- `revoke ... from anon` ei poistaisi sitä eikä sen jäämistä
-- huomaisi mistään. Siksi nollaus tehdään kaikille kolmelle roolille
-- ennen myöntämistä.
revoke all on public.investments from public;
revoke all on public.investments from anon;
revoke all on public.investments from authenticated;
grant select, insert, update, delete on public.investments to authenticated;

create trigger investments_touch_updated_at
  before update on public.investments
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------
-- VAIHE 3: bills — maksutiedot
--
-- Kolme uutta saraketta, kaikki NULLABLE. Olemassa olevat rivit
-- pysyvät kelvollisina eikä täyttöä tarvita: vanhalla laskulla ei ole
-- maksutietoja, ja NULL on oikea vastaus siihen.
--
-- NÄMÄ EIVÄT KÄYNNISTÄ MAKSUA. Manifestivalilla ei ole pankkiyhteyttä
-- eikä valtuutta siirtää rahaa. IBAN ja viite ovat tietoa, jonka
-- käyttäjä kopioi omaan pankkiinsa itse.
-- ---------------------------------------------------------------------

alter table public.bills add column payee text;
alter table public.bills add column iban text;
alter table public.bills add column reference text;

alter table public.bills
  add constraint bills_payee_length_check
  check (payee is null or length(payee) <= 200);

-- IBAN tarkistetaan väljästi: tiukka maakohtainen tarkistus kuuluu
-- sovellukseen, ja liian tiukka kanta estäisi kirjaamasta ulkomaista
-- tiliä jonka muotoa emme tunne. Kanta estää vain ilmiselvän roskan.
alter table public.bills
  add constraint bills_iban_check
  check (iban is null or (length(iban) between 5 and 42 and iban ~ '^[A-Z0-9 ]+$'));

alter table public.bills
  add constraint bills_reference_check
  check (reference is null or length(reference) <= 40);

-- ---------------------------------------------------------------------
-- VAIHE 4: invarianttien todistus ENNEN COMMITTIA
-- ---------------------------------------------------------------------

do $$
declare
  n integer;
begin
  select count(*) into n from pg_policies
   where schemaname = 'public' and tablename in ('transactions', 'investments');
  if n <> 8 then
    raise exception 'Odotettiin 8 politiikkaa, loytyi %.', n;
  end if;

  select count(*) into n from pg_class
   where relnamespace = 'public'::regnamespace
     and relname in ('transactions', 'investments') and relrowsecurity;
  if n <> 2 then
    raise exception 'RLS ei ole paalla molemmissa uusissa tauluissa.';
  end if;

  select count(*) into n from information_schema.columns
   where table_schema = 'public' and table_name = 'bills'
     and column_name in ('payee', 'iban', 'reference');
  if n <> 3 then
    raise exception 'bills-taulun kolme uutta saraketta puuttuvat.';
  end if;

  -- PUBLIC-ROOLIN OIKEUDET LUETAAN SUORAAN ACL:STA.
  --
  -- role_table_grants ei nayta PUBLIC-roolille myonnettya oikeutta
  -- sellaisenaan, ja has_table_privilege kertoo vain onko oikeus —
  -- ei sita, mista se tulee. aclexplode on ainoa tapa nahda PUBLIC
  -- (grantee = 0) omana merkintanaan.
  select count(*) into n
    from pg_class c,
         lateral aclexplode(c.relacl) a
   where c.relnamespace = 'public'::regnamespace
     and c.relname in ('transactions', 'investments')
     and a.grantee = 0;
  if n <> 0 then
    raise exception 'PUBLIC-roolilla on % oikeutta uusiin tauluihin.', n;
  end if;

  -- Anon ei saa nahda kumpaakaan uutta taulua — ei suoraan eika
  -- perittyna.
  select count(*) into n from information_schema.role_table_grants
   where table_schema = 'public'
     and table_name in ('transactions', 'investments')
     and grantee in ('anon', 'public');
  if n <> 0 then
    raise exception 'Uusilla tauluilla on % oikeutta anon- tai public-roolille.', n;
  end if;

  -- TEHOLLISET OIKEUDET: mita anon oikeasti saa tehda, riippumatta
  -- siita mista oikeus tulisi.
  if has_table_privilege('anon', 'public.transactions', 'select')
     or has_table_privilege('anon', 'public.investments', 'select') then
    raise exception 'anon-roolilla on lukuoikeus uusiin tauluihin.';
  end if;

  if not has_table_privilege('authenticated', 'public.transactions', 'select')
     or not has_table_privilege('authenticated', 'public.investments', 'select') then
    raise exception 'authenticated-roolilta puuttuu lukuoikeus uusiin tauluihin.';
  end if;

  raise notice 'Migraatio 0009 valmis. Aja seuraavaksi supabase/verify/verify_0009.sql.';
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
--   2. Varmuuskopio
--   3. Vain lukeva esitarkistus (alla)
--   4. Ajo postgres-roolilla Supabasen SQL-editorissa
--   5. supabase/verify/verify_0009.sql
--
-- ESITARKISTUS (vain lukeva, turvallinen ajaa milloin tahansa):
--
--   select
--     (select count(*) from pg_tables
--       where schemaname='public' and tablename='transactions') as transactions_on,
--     (select count(*) from pg_tables
--       where schemaname='public' and tablename='investments') as investments_on,
--     (select count(*) from information_schema.columns
--       where table_schema='public' and table_name='bills'
--         and column_name in ('payee','iban','reference')) as bills_uudet_sarakkeet,
--     (select count(*) from public.bills) as laskuja;
--
--   Odotus ennen ajoa: 0, 0, 0, <laskujen maara>
--
-- =====================================================================
-- VAIKUTUS OLEMASSA OLEVAAN DATAAN
-- =====================================================================
--
--   transactions   uusi taulu, tyhja
--   investments    uusi taulu, tyhja
--   bills          KOLME UUTTA NULLABLE-SARAKETTA
--
-- Olemassa olevia rivejä EI muuteta. Täyttöä ei tehdä eikä tarvita.
-- Yhtään riviä ei poisteta, yhtään saraketta ei pudoteta, yhdenkään
-- sarakkeen tyyppiä ei muuteta.
--
-- =====================================================================
-- ROLLBACK
-- =====================================================================
--
--   begin;
--   set local lock_timeout = '5s';
--
--   drop table public.transactions;
--   drop table public.investments;
--
--   alter table public.bills drop constraint bills_payee_length_check;
--   alter table public.bills drop constraint bills_iban_check;
--   alter table public.bills drop constraint bills_reference_check;
--   alter table public.bills drop column payee;
--   alter table public.bills drop column iban;
--   alter table public.bills drop column reference;
--
--   commit;
--
-- HUOM. Peruutus POISTAA transactions- ja investments-taulujen rivit
-- pysyvästi. Jos portit on ehditty avata ja käyttäjä on kirjannut
-- tapahtumia, ne katoavat. Sulje portit ensin ja ota varmuuskopio.
--
-- Muista tällöin myös:
--   src/data/schema.js -> TABLES.transactions   = false
--                         TABLES.investments    = false
--                         BILL_PAYMENT_FIELDS   = false
--
-- =====================================================================
-- RISKIT
-- =====================================================================
--
--   MATALA   uudet taulut -- eivät koske olemassa olevaan dataan
--   MATALA   bills: kolme nullable-saraketta, ei täyttöä. ADD COLUMN
--            ilman oletusarvoa ei kirjoita taulua uudelleen
--            PostgreSQL 11:stä lähtien.
--   KESKI    kolme uutta CHECK-rajoitetta bills-tauluun validoidaan
--            olemassa olevia rivejä vastaan. Ne ovat NULL, joten
--            tarkistus menee läpi -- mutta se on syy ajaa esitarkistus
--            ensin eikä oletuksena.
--
-- Ajon kesto on käytännössä välitön: molemmat uudet taulut ovat tyhjiä
-- ja bills-taulussa on muutamia rivejä.
