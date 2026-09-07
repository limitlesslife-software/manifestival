-- =====================================================================
-- Manifestival — migraatio 0007: laskut, toistuvat kulut ja säästötavoitteet
-- =====================================================================
--
-- TILA: EI AJETTU TUOTANTOON.
--
-- ESIEHDOT
--   1. Migraatio 0001 on ajettu ja todennettu (user_id, RLS, 4 politiikkaa)
--   2. Migraatio 0002 on ajettu (tuotannon hyväksytty lähtötila)
--   3. Varmuuskopio on otettu
--      (supabase/preflight/recovery_snapshot_pre_0004_0008.sql)
--   4. PostgreSQL 15 tai uudempi — ks. VAIHE 0b, kohta 6
--
-- Migraatiot 0003–0006 EIVÄT ole esiehto: laskut viittaavat tehtäviin
-- (0001) ja toistuviin kuluihin (tämä migraatio), eivät niiden tauluihin.
--
-- TARKOITUS
-- Talouden perustaso: mitä on maksettava, mikä toistuu ja mihin säästetään.
-- EI pankkiyhteyttä, EI maksuja, EI Open Bankingia. Kaikki tieto on
-- käyttäjän itse kirjaamaa.
--
-- ---------------------------------------------------------------------
-- RAHA ON KOKONAISLUKU
-- ---------------------------------------------------------------------
-- Summat tallennetaan SENTTEINÄ `bigint`-sarakkeina, ei `numeric`- eikä
-- `float`-tyyppinä.
--
--   129,95 EUR  ->  12995
--
-- Perustelu: liukuluku ei esitä desimaalimurtolukuja tarkasti, ja virhe
-- kertautuu summattaessa. `numeric` olisi tarkka, mutta se palautuu
-- JavaScriptiin merkkijonona tai liukulukuna ajurin mukaan — ja juuri se
-- muunnos on se kohta, jossa sentit katoavat. Kokonaisluku kulkee koko
-- matkan muuttumattomana.
--
-- Ks. src/domain/money.js.
--
-- VALUUTTA ON AINA MUKANA. Eri valuuttoja ei summata yhteen missään
-- kohtaa — ei kannassa eikä sovelluksessa.
--
-- KÄYTTÖÖNOTTO KOODISSA
-- Migraation JA hyväksyntätestin jälkeen: src/data/schema.js ->
-- TABLES.bills = true, TABLES.recurringExpenses = true,
-- TABLES.savingsGoals = true.
--
-- =====================================================================
-- TÄMÄ MIGRAATIO KOSKEE TUOTANNON tasks-TAULUUN
-- =====================================================================
-- Toisin kuin tiedoston aiempi versio väitti ("luo vain uusia tauluja
-- eikä koske olemassa olevaan dataan"), tämä migraatio LISÄÄ RAJOITTEEN
-- tuotannon tasks-tauluun:
--
--   alter table public.tasks add constraint tasks_owner_row_key
--     unique (user_id, id);
--
-- Se on välttämätön, koska bills.task_id viittaa tehtävään ja viittauksen
-- on oltava omistajakohtainen (ks. seuraava osio). PostgreSQL vaatii,
-- että yhdistelmävierasavaimen kohdesarakkeilla on yksikäsitteisyys-
-- rajoite — ilman tätä viitettä ei voi luoda lainkaan.
--
-- MITÄ SE MAKSAA
--   * Rajoite EI voi kaatua dataan: `id` on jo pääavain, joten pari
--     (user_id, id) on väistämättä yksikäsitteinen. Uusia sääntöjä
--     riveille ei siis tule.
--   * Rajoitteen luonti ottaa tasks-tauluun ACCESS EXCLUSIVE -lukon ja
--     rakentaa indeksin. Tuotannossa on kymmeniä rivejä, joten se kestää
--     millisekunteja — mutta lukko on silti täysi, ja siksi tässä
--     tiedostossa on `set local lock_timeout`.
--   * Rajoite jää pysyvästi. Rollback ei poista sitä, koska bills voi
--     olla poistettu ja rajoite silti oikea.
--
-- =====================================================================
-- OMISTAJUUS ON KANNAN VASTUULLA
-- =====================================================================
-- Tämän tiedoston aiempi versio liitti laskun tehtävään ja toistuvaan
-- kuluun tavallisella yhden sarakkeen vierasavaimella:
--
--   task_id text references public.tasks(id) on delete set null
--
-- Se sallii ristiinkiinnityksen: käyttäjä B voi luoda OMAN laskunsa, joka
-- viittaa käyttäjän A tehtävään.
--
--   RLS ESTÄÄ LUKEMISEN, EI VIITTAAMISTA.
--
-- Vierasavaimen tarkistus ei kulje RLS:n läpi. Kanta katsoo, onko rivi
-- olemassa — ei sitä, saisiko viittaaja nähdä sen. B:n rivin omistaja on
-- B, joten RLS hyväksyy sen moitteetta. Ainoa asia joka voi torjua
-- viittauksen on kannan oma eheysrajoite.
--
-- Siksi molemmat viitteet ovat YHDISTELMÄVIERASAVAIMIA:
--
--   foreign key (user_id, task_id) references tasks (user_id, id)
--
-- Sama korjaus tehtiin migraatioihin 0003 ja 0004.
--
-- MITÄ TÄMÄ EI OLE
-- Tämä ei ole idempotentti migraatio, ja se on tarkoitus. Aiempi versio
-- käytti `if not exists` -muotoa, jolloin toinen ajo, kesken jäänyt ajo
-- ja tuore ajo näyttivät kaikki onnistuneelta. Tila, jota ei voi erottaa,
-- on tila jota ei voi korjata. Nyt migraatio laskee 39 objektiaan ja
-- KESKEYTYY, jos yksikin niistä on jo olemassa.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- VAIHE 0: lukituksen aikakatkaisu
--
-- Tämä migraatio ottaa TUOTANNON tasks-tauluun ACCESS EXCLUSIVE -lukon
-- kahdesti: kerran yksikäsitteisyysrajoitteelle ja kerran vierasavaimen
-- kohteena. Se viittaa myös auth.users-tauluun, jota jokainen
-- kirjautuminen koskee.
--
-- Ilman aikakatkaisua pitkä transaktio kummassa tahansa jättäisi
-- migraation jonoon — ja koska lukkojono on FIFO, sen taakse jonoutuisi
-- jokainen kirjautuminen ja jokainen tehtävän luku. Viisi sekuntia ja
-- selkeä virhe on parempi kuin tuntematon katko sovelluksessa.
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

  -- tasks.user_id on oltava NOT NULL. Tama ei ole muodollisuus:
  -- yhdistelmavierasavain kayttaa oletusarvoista MATCH SIMPLE -semantiikkaa,
  -- jossa tarkistus OHITETAAN kokonaan jos yksikin sarake on NULL.
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'tasks'
       and column_name = 'user_id' and is_nullable = 'YES'
  ) then
    raise exception 'tasks.user_id sallii NULLin. Yhdistelmavierasavain ei silloin suojaisi. Korjaa 0001:n tila ensin.';
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

  -- 5. Vanha data on ehjaa. tasks-tauluun lisataan rajoite; jos siella on
  --    omistajaton tai orpo rivi, kannan tila ei vastaa oletusta.
  select count(*) into olemassa from public.tasks where user_id is null;
  if olemassa <> 0 then
    raise exception 'tasks-taulussa on % omistajatonta rivia. Korjaa ne ennen 0007:aa.', olemassa;
  end if;

  select count(*) into olemassa
    from public.tasks t left join auth.users u on u.id = t.user_id
   where u.id is null;
  if olemassa <> 0 then
    raise exception 'tasks-taulussa on % rivia joiden omistajaa ei ole olemassa.', olemassa;
  end if;

  -- 6. PALVELIMEN VERSIO
  --
  --    Yhdistelmavierasavaimen poistotoiminto on
  --    `on delete set null (task_id)` — sarakelista suluissa. Ilman sita
  --    PostgreSQL nollaisi KAIKKI vierasavaimen sarakkeet, myos user_id,
  --    joka on NOT NULL. Silloin tehtavan poistaminen kaatuisi aina.
  --
  --    Sarakelista tuli PostgreSQL 15:ssa.
  if current_setting('server_version_num')::int < 150000 then
    raise exception 'PostgreSQL % on liian vanha. Yhdistelmavierasavaimen sarakekohtainen ON DELETE SET NULL vaatii version 15.',
      current_setting('server_version');
  end if;

  -- 7. OSITTAISEN TAI AIEMMAN AJON TUNNISTUS
  --
  --    Kolmekymmentayhdeksan objektia: kolme taulua, seitsemantoista
  --    rajoitetta (mukaan lukien tasks_owner_row_key), nelja indeksia,
  --    kolme liipaisinta ja kaksitoista politiikkaa. Nolla = tuore ajo.
  --    Mika tahansa muu luku tarkoittaa, etta ajo on tehty tai jaanyt
  --    kesken — eika kumpaakaan korjata ajamalla uudelleen.
  --
  --    Funktio touch_updated_at EI ole listassa: sen luo migraatio 0002,
  --    joka on ajettu. Tama migraatio ei luo sita eika korvaa sita, vaan
  --    tarkistaa sen alla.
  select count(*) into olemassa from (
    select 1 from pg_tables
      where schemaname = 'public'
        and tablename in ('bills', 'recurring_expenses', 'savings_goals')
    union all
    select 1 from pg_constraint
      where conname in ('recurring_expenses_cadence_check',
                        'recurring_expenses_amount_check',
                        'recurring_expenses_day_check',
                        'recurring_expenses_currency_check',
                        'recurring_expenses_name_check',
                        'recurring_expenses_owner_row_key',
                        'bills_status_check', 'bills_amount_check',
                        'bills_currency_check', 'bills_name_check',
                        'bills_paid_date_check',
                        'bills_task_id_fkey', 'bills_recurring_expense_id_fkey',
                        'savings_goals_amount_check',
                        'savings_goals_currency_check',
                        'savings_goals_name_check',
                        'tasks_owner_row_key')
    union all
    select 1 from pg_indexes
      where schemaname = 'public'
        and indexname in ('recurring_expenses_user_active_idx',
                          'bills_user_status_due_idx', 'bills_user_due_idx',
                          'savings_goals_user_idx')
    union all
    select 1 from pg_trigger
      where not tgisinternal
        and tgname in ('bills_touch_updated_at',
                       'recurring_expenses_touch_updated_at',
                       'savings_goals_touch_updated_at')
    union all
    select 1 from pg_policies
      where schemaname = 'public'
        and tablename in ('bills', 'recurring_expenses', 'savings_goals')
  ) kaikki;

  if olemassa = 39 then
    raise exception 'Migraatio 0007 on JO AJETTU. Ala aja uudelleen — aja supabase/verify/verify_0007.sql.';
  end if;

  if olemassa > 0 then
    select string_agg(nimi, ', ' order by nimi) into nimet from (
      select tablename::text as nimi from pg_tables
        where schemaname = 'public'
          and tablename in ('bills', 'recurring_expenses', 'savings_goals')
      union all
      select conname::text from pg_constraint
        where conname in ('recurring_expenses_cadence_check',
                          'recurring_expenses_amount_check',
                          'recurring_expenses_day_check',
                          'recurring_expenses_currency_check',
                          'recurring_expenses_name_check',
                          'recurring_expenses_owner_row_key',
                          'bills_status_check', 'bills_amount_check',
                          'bills_currency_check', 'bills_name_check',
                          'bills_paid_date_check',
                          'bills_task_id_fkey', 'bills_recurring_expense_id_fkey',
                          'savings_goals_amount_check',
                          'savings_goals_currency_check',
                          'savings_goals_name_check',
                          'tasks_owner_row_key')
      union all
      select indexname::text from pg_indexes
        where schemaname = 'public'
          and indexname in ('recurring_expenses_user_active_idx',
                            'bills_user_status_due_idx', 'bills_user_due_idx',
                            'savings_goals_user_idx')
      union all
      select tgname::text from pg_trigger
        where not tgisinternal
          and tgname in ('bills_touch_updated_at',
                         'recurring_expenses_touch_updated_at',
                         'savings_goals_touch_updated_at')
      union all
      select policyname::text from pg_policies
        where schemaname = 'public'
          and tablename in ('bills', 'recurring_expenses', 'savings_goals')
    ) loydetyt;

    raise exception 'Migraatio 0007 on kesken: % objektia 39:sta on jo olemassa (%). Ks. docs/MIGRATION-0007-RECOVERY.md.',
      olemassa, nimet;
  end if;

  raise notice 'Esiehdot kunnossa. Omistaja %, 0007:n objekteja 0/39.', omistaja;
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
-- tuotannossa. Jos 0007 olisi ajettu sellaisenaan, se olisi HILJAA
-- korvannut kovennetun funktion kovettamattomalla.
--
-- Kyseessä ei ole tämän taulun ongelma. Sama funktio on liipaisimena
-- tauluissa tasks, routines, goals ja projects, ja se ajetaan jokaisessa
-- UPDATEssa. Kovennuksen menetys olisi näkynyt vain siinä, mitä ei enää
-- olisi ollut — ei missään virheessä.
--
-- Funktio luodaan kerran migraatiossa 0002. Myöhemmät migraatiot
-- tarkistavat sen, eivät kirjoita sitä uudelleen.
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
-- VAIHE 1: tasks — omistajan rivin avain
--
-- Tämä on ainoa kohta, jossa migraatio koskee olemassa olevaan tauluun.
-- Perustelu on tiedoston alussa. Lyhyesti: bills.task_id on
-- yhdistelmävierasavain, ja sen kohde tarvitsee tämän avaimen.
--
-- Rajoite ei voi kaatua dataan, koska id on jo pääavain.
-- ---------------------------------------------------------------------
alter table public.tasks
  add constraint tasks_owner_row_key unique (user_id, id);

-- ---------------------------------------------------------------------
-- VAIHE 2: recurring_expenses — toistuva kulu on SÄÄNTÖ
--
-- Kuten rutiini, ei kuten tehtävä. Yksittäiset erääntymiset lasketaan
-- säännöstä ajossa (src/domain/finance.js), niitä ei materialisoida.
--
-- day_of_month tarvitaan, koska kuukaudet ovat eripituisia: "vuokra 31.
-- päivä" ei voi osua helmikuuhun. Domain rajaa päivän kuukauden
-- viimeiseen sen sijaan että vierittäisi sen seuraavaan kuukauteen.
-- ---------------------------------------------------------------------
create table public.recurring_expenses (
  id            text primary key,
  user_id       uuid not null default auth.uid()
                references auth.users(id) on delete cascade,

  name          text not null,

  -- SENTTEINÄ. Ei numeric, ei float. Ks. tiedoston alun perustelu.
  amount_minor  bigint not null,
  currency      text not null default 'EUR',

  cadence       text not null default 'monthly',
  day_of_month  smallint,
  next_due_date date not null,

  category      text not null default 'talous',
  active        boolean not null default true,
  note          text,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

alter table public.recurring_expenses
  add constraint recurring_expenses_cadence_check
  check (cadence in ('weekly', 'monthly', 'quarterly', 'yearly'));

alter table public.recurring_expenses
  add constraint recurring_expenses_amount_check
  check (amount_minor >= 0 and amount_minor <= 1000000000);

alter table public.recurring_expenses
  add constraint recurring_expenses_day_check
  check (day_of_month is null or (day_of_month >= 1 and day_of_month <= 31));

alter table public.recurring_expenses
  add constraint recurring_expenses_currency_check
  check (currency ~ '^[A-Z]{3}$');

alter table public.recurring_expenses
  add constraint recurring_expenses_name_check
  check (length(btrim(name)) > 0);

-- Omistajan rivin avain: bills.recurring_expense_id viittaa tähän
-- yhdistelmävierasavaimella, ja PostgreSQL vaatii kohteelta
-- yksikäsitteisyysrajoitteen.
alter table public.recurring_expenses
  add constraint recurring_expenses_owner_row_key unique (user_id, id);

create index recurring_expenses_user_active_idx
  on public.recurring_expenses (user_id, active);

-- ---------------------------------------------------------------------
-- VAIHE 3: bills — kertaluonteinen maksu, jolla on eräpäivä
--
-- Tallennettuja tiloja on kolme: open, paid, cancelled. Kiireellisyys
-- (upcoming / due / overdue) on JOHDETTU eräpäivästä eikä sarake —
-- tallennettuna se vanhenisi heti seuraavana päivänä.
--
-- Molemmat viitteet ovat yhdistelmävierasavaimia, ja ne lisätään
-- taulun luonnin jälkeen omina lauseinaan: se tekee näkyväksi, että
-- kyseessä ei ole tavallinen `references`.
-- ---------------------------------------------------------------------
create table public.bills (
  id                    text primary key,
  user_id               uuid not null default auth.uid()
                        references auth.users(id) on delete cascade,

  name                  text not null,
  amount_minor          bigint not null,
  currency              text not null default 'EUR',

  due_date              date not null,
  status                text not null default 'open',
  paid_date             date,

  category              text not null default 'talous',

  -- Valinnainen linkki tehtävään, jos maksaminen halutaan päivän listalle.
  task_id               text,

  -- Mistä toistuvasta kulusta tämä syntyi, jos syntyi.
  recurring_expense_id  text,

  note                  text,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

alter table public.bills
  add constraint bills_status_check
  check (status in ('open', 'paid', 'cancelled'));

alter table public.bills
  add constraint bills_amount_check
  check (amount_minor >= 0 and amount_minor <= 1000000000);

alter table public.bills
  add constraint bills_currency_check
  check (currency ~ '^[A-Z]{3}$');

alter table public.bills
  add constraint bills_name_check
  check (length(btrim(name)) > 0);

-- Maksettu lasku ilman maksupäivää olisi puolivalmis kirjaus.
alter table public.bills
  add constraint bills_paid_date_check
  check (status <> 'paid' or paid_date is not null);

-- Tehtävän poisto ei saa poistaa laskua: maksu on olemassa vaikka
-- muistutus siitä poistettaisiin. Sarakelista `(task_id)` on pakollinen
-- — ilman sitä poisto yrittäisi nollata myös user_id:n.
alter table public.bills
  add constraint bills_task_id_fkey
  foreign key (user_id, task_id) references public.tasks (user_id, id)
  on delete set null (task_id);

-- Säännön poisto ei poista jo syntyneitä laskuja — ne ovat historiaa.
alter table public.bills
  add constraint bills_recurring_expense_id_fkey
  foreign key (user_id, recurring_expense_id)
  references public.recurring_expenses (user_id, id)
  on delete set null (recurring_expense_id);

create index bills_user_status_due_idx
  on public.bills (user_id, status, due_date);

create index bills_user_due_idx
  on public.bills (user_id, due_date)
  where status = 'open';

-- ---------------------------------------------------------------------
-- VAIHE 4: savings_goals
--
-- EI korkoa, EI tuotto-oletusta, EI ennustetta. Tavoite on se mitä
-- käyttäjä on itse pannut sivuun — ei se mitä siitä voisi kasvaa.
-- Sijoitusneuvonta on säänneltyä toimintaa; ks. docs/INVESTMENTS-ARCHITECTURE.md.
--
-- Tämä taulu ei viittaa yhteenkään toiseen sovellustauluun, joten
-- yhdistelmävierasavainta ei tarvita eikä omistajan rivin avainta myöskään.
-- ---------------------------------------------------------------------
create table public.savings_goals (
  id             text primary key,
  user_id        uuid not null default auth.uid()
                 references auth.users(id) on delete cascade,

  name           text not null,
  target_minor   bigint not null,
  current_minor  bigint not null default 0,
  currency       text not null default 'EUR',
  target_date    date,
  note           text,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

alter table public.savings_goals
  add constraint savings_goals_amount_check
  check (target_minor > 0 and target_minor <= 1000000000
     and current_minor >= 0 and current_minor <= 1000000000);

alter table public.savings_goals
  add constraint savings_goals_currency_check
  check (currency ~ '^[A-Z]{3}$');

alter table public.savings_goals
  add constraint savings_goals_name_check
  check (length(btrim(name)) > 0);

create index savings_goals_user_idx
  on public.savings_goals (user_id);

-- ---------------------------------------------------------------------
-- VAIHE 5: updated_at
-- ---------------------------------------------------------------------
create trigger bills_touch_updated_at
  before update on public.bills
  for each row execute function public.touch_updated_at();

create trigger recurring_expenses_touch_updated_at
  before update on public.recurring_expenses
  for each row execute function public.touch_updated_at();

create trigger savings_goals_touch_updated_at
  before update on public.savings_goals
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------
-- VAIHE 6: RLS
--
-- Talousdata on rahanarvoista tietoa. Sama malli kuin muualla, ei
-- poikkeuksia: omistajuuden asettaa tietokanta, anon ei saa mitään.
-- ---------------------------------------------------------------------
alter table public.bills              enable row level security;
alter table public.recurring_expenses enable row level security;
alter table public.savings_goals      enable row level security;

create policy bills_select_own on public.bills
  for select to authenticated using (auth.uid() = user_id);
create policy bills_insert_own on public.bills
  for insert to authenticated with check (auth.uid() = user_id);
create policy bills_update_own on public.bills
  for update to authenticated using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
create policy bills_delete_own on public.bills
  for delete to authenticated using (auth.uid() = user_id);

create policy recurring_expenses_select_own on public.recurring_expenses
  for select to authenticated using (auth.uid() = user_id);
create policy recurring_expenses_insert_own on public.recurring_expenses
  for insert to authenticated with check (auth.uid() = user_id);
create policy recurring_expenses_update_own on public.recurring_expenses
  for update to authenticated using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
create policy recurring_expenses_delete_own on public.recurring_expenses
  for delete to authenticated using (auth.uid() = user_id);

create policy savings_goals_select_own on public.savings_goals
  for select to authenticated using (auth.uid() = user_id);
create policy savings_goals_insert_own on public.savings_goals
  for insert to authenticated with check (auth.uid() = user_id);
create policy savings_goals_update_own on public.savings_goals
  for update to authenticated using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
create policy savings_goals_delete_own on public.savings_goals
  for delete to authenticated using (auth.uid() = user_id);

-- PUBLIC ENSIN, EIKA VAIN ANON.
--
-- PostgreSQL-rooli PUBLIC tarkoittaa "kaikki roolit", ja sille myonnetyn
-- oikeuden perii jokainen rooli — myos anon. Perittya oikeutta ei nay
-- roolikohtaisissa listauksissa lainkaan, joten `revoke ... from anon`
-- ei poista sita eika sen puuttumista huomaisi mistaan.
revoke all on public.bills              from public;
revoke all on public.recurring_expenses from public;
revoke all on public.savings_goals      from public;
revoke all on public.bills              from anon;
revoke all on public.recurring_expenses from anon;
revoke all on public.savings_goals      from anon;

-- Myos authenticated nollataan ensin, jotta lopputulos on TASAN nelja
-- oikeutta per taulu eika "nelja plus se mita oletusoikeudet sattuivat
-- antamaan".
revoke all on public.bills              from authenticated;
revoke all on public.recurring_expenses from authenticated;
revoke all on public.savings_goals      from authenticated;

grant select, insert, update, delete on public.bills              to authenticated;
grant select, insert, update, delete on public.recurring_expenses to authenticated;
grant select, insert, update, delete on public.savings_goals      to authenticated;

-- ---------------------------------------------------------------------
-- VAIHE 7: loppuvarmistus ENNEN COMMITTIA
--
-- Viimeinen hetki, jolloin virheellinen tulos voidaan perua ilman
-- jalkia. Sen jalkeen korjaaminen on eri operaatio.
-- ---------------------------------------------------------------------
do $$
declare
  luku int;
begin
  -- Kaikki kolme taulua ovat olemassa ja tyhjia.
  select count(*) into luku from pg_tables
   where schemaname = 'public'
     and tablename in ('bills', 'recurring_expenses', 'savings_goals');
  if luku <> 3 then
    raise exception 'Tauluja syntyi % kolmen sijaan.', luku;
  end if;

  if (select count(*) from public.bills) <> 0
     or (select count(*) from public.recurring_expenses) <> 0
     or (select count(*) from public.savings_goals) <> 0 then
    raise exception 'Uudet taulut eivat ole tyhjia. Jotain on jo kirjoitettu.';
  end if;

  -- RLS on paalla kaikissa kolmessa.
  select count(*) into luku from pg_class
   where relnamespace = 'public'::regnamespace
     and relname in ('bills', 'recurring_expenses', 'savings_goals')
     and relrowsecurity;
  if luku <> 3 then
    raise exception 'RLS on paalla vain %/3 taulussa.', luku;
  end if;

  -- Kaksitoista politiikkaa, kaikki authenticated-roolille, ja MOLEMMAT
  -- puolet oikein. Jos vain USING tarkistettaisiin, kayttaja voisi ottaa
  -- oman rivinsa ja kirjoittaa sen toisen nimiin.
  select count(*) into luku from pg_policies
   where schemaname = 'public'
     and tablename in ('bills', 'recurring_expenses', 'savings_goals')
     and roles = '{authenticated}'::name[]
     and coalesce(btrim(replace(qual,       ' ', ''), '()'), 'auth.uid()=user_id') = 'auth.uid()=user_id'
     and coalesce(btrim(replace(with_check, ' ', ''), '()'), 'auth.uid()=user_id') = 'auth.uid()=user_id';
  if luku <> 12 then
    raise exception 'Vain %/12 politiikkaa rajaa omistajuuden oikein.', luku;
  end if;

  select count(*) into luku from pg_policies
   where schemaname = 'public'
     and tablename in ('bills', 'recurring_expenses', 'savings_goals');
  if luku <> 12 then
    raise exception 'Tauluissa on % politiikkaa kahdentoista sijaan.', luku;
  end if;

  -- =================================================================
  -- OMISTAJUUSINVARIANTTI
  -- =================================================================
  --
  -- Kaksi omistajan rivin avainta: tuotannon tasks-taulussa ja uudessa
  -- recurring_expenses-taulussa. Ilman naita alla olevia viitteita ei
  -- olisi voinut luoda lainkaan.
  select count(*) into luku from pg_constraint
   where conname in ('tasks_owner_row_key', 'recurring_expenses_owner_row_key')
     and contype = 'u';
  if luku <> 2 then
    raise exception 'Omistajan rivin avaimia on % kahden sijaan.', luku;
  end if;

  -- Molemmat laskun viitteet ovat YHDISTELMIA, eivat yhden sarakkeen
  -- vierasavaimia.
  --
  -- Tama katsotaan RAKENTEESTA eika nimesta: conkey kertoo montako
  -- saraketta avaimessa on, ja user_id:n on oltava yksi niista. Nimi
  -- voisi olla mika tahansa; rakenne ei voi valehdella.
  --
  -- confdeltype = 'n' on ON DELETE SET NULL. confdelsetcols kertoo
  -- MITKA sarakkeet nollataan — sen on oltava tasan yksi, ja nimenomaan
  -- se joka EI ole user_id. Jos confdelsetcols olisi NULL, tehtavan
  -- poisto yrittaisi nollata myos user_id:n ja kaatuisi NOT NULL
  -- -virheeseen joka kerta.
  select count(*) into luku
    from pg_constraint con
    join pg_class t on t.oid = con.conrelid
   where con.conname in ('bills_task_id_fkey', 'bills_recurring_expense_id_fkey')
     and con.contype = 'f'
     and array_length(con.conkey, 1) = 2
     and con.confdeltype = 'n'
     and array_length(con.confdelsetcols, 1) = 1
     and exists (select 1 from unnest(con.conkey) k(attnum)
                   join pg_attribute a
                     on a.attrelid = t.oid and a.attnum = k.attnum
                  where a.attname = 'user_id')
     and not exists (select 1 from unnest(con.confdelsetcols) k(attnum)
                       join pg_attribute a
                         on a.attrelid = t.oid and a.attnum = k.attnum
                      where a.attname = 'user_id');
  if luku <> 2 then
    raise exception 'Laskun omistajuusviitteita on % kahden sijaan. Ristiinkiinnitys olisi mahdollinen.', luku;
  end if;

  -- Yhtaan yhden sarakkeen viitetta naihin tauluihin ei saa jaada.
  --
  -- Tama on ERI vaite kuin ylla: ylla laskettiin ETTA oikeat viitteet
  -- ovat olemassa, tama laskee ETTEI vaaria ole. Kumpikaan yksin ei
  -- riita — migraatio voisi luoda oikean viitteen ja jattaa vanhan
  -- viereen, jolloin heikompi paastaisi rivin lapi.
  --
  -- tasks on mukana, koska tama migraatio teki siita ensimmaista kertaa
  -- viittauksen kohteen.
  select count(*) into luku
    from pg_constraint con
    join pg_class ft on ft.oid = con.confrelid
   where con.contype = 'f'
     and ft.relnamespace = 'public'::regnamespace
     and ft.relname in ('tasks', 'recurring_expenses', 'bills', 'savings_goals')
     and array_length(con.conkey, 1) < 2;
  if luku <> 0 then
    raise exception 'Naihin tauluihin osoittaa % yhden sarakkeen vierasavainta. Ne sallisivat ristiinkiinnityksen.', luku;
  end if;

  -- =================================================================
  -- RAHA ON KOKONAISLUKU
  -- =================================================================
  -- Jos jokin summasarake olisi numeric tai double precision, sentit
  -- katoaisivat JavaScript-muunnoksessa hiljaa. Tama on halvempi
  -- huomata nyt kuin tilinpaatoksessa.
  select count(*) into luku from information_schema.columns
   where table_schema = 'public'
     and table_name in ('bills', 'recurring_expenses', 'savings_goals')
     and (column_name like '%_minor')
     and data_type <> 'bigint';
  if luku <> 0 then
    raise exception '% summasaraketta ei ole bigint-tyyppisia.', luku;
  end if;

  -- Ja niita on tasan nelja: bills.amount_minor,
  -- recurring_expenses.amount_minor, savings_goals.target_minor ja
  -- savings_goals.current_minor.
  select count(*) into luku from information_schema.columns
   where table_schema = 'public'
     and table_name in ('bills', 'recurring_expenses', 'savings_goals')
     and column_name like '%_minor';
  if luku <> 4 then
    raise exception 'Summasarakkeita on % neljan sijaan.', luku;
  end if;

  -- =================================================================
  -- OIKEUDET
  -- =================================================================
  -- anon ei saa mitaan, edes perittyna.
  select count(*) into luku
    from (select unnest(array['public.bills', 'public.recurring_expenses',
                              'public.savings_goals']) as taulu) tt
    cross join (select unnest(array['select', 'insert', 'update', 'delete',
                                    'truncate', 'references', 'trigger']) as oikeus) pp
   where has_table_privilege('anon', tt.taulu, pp.oikeus);
  if luku <> 0 then
    raise exception 'anon-roolilla on % tehollista oikeutta uusiin tauluihin.', luku;
  end if;

  -- PUBLIC-roolilla ei saa olla mitaan, ja tama katsotaan TAULUN
  -- OIKEUSLISTASTA eika roolikohtaisesti. Kaksi menetelmaa, koska
  -- kumpikaan ei yksin riita: has_table_privilege kertoo ONKO oikeus
  -- (perinta mukaan lukien), aclexplode kertoo MISTA se tulee.
  select count(*) into luku
    from pg_class cl, aclexplode(cl.relacl) acl
   where cl.oid = any (array['public.bills'::regclass,
                             'public.recurring_expenses'::regclass,
                             'public.savings_goals'::regclass])
     and acl.grantee = 0;
  if luku <> 0 then
    raise exception 'PUBLIC-roolilla on % oikeutta uusiin tauluihin.', luku;
  end if;

  -- authenticated saa tasan CRUD, ei enempaa.
  select count(*) into luku
    from (select unnest(array['public.bills', 'public.recurring_expenses',
                              'public.savings_goals']) as taulu) tt
    cross join (select unnest(array['select', 'insert', 'update', 'delete',
                                    'truncate', 'references', 'trigger']) as oikeus) pp
   where has_table_privilege('authenticated', tt.taulu, pp.oikeus);
  if luku <> 12 then
    raise exception 'authenticated-roolilla on % oikeutta, odotettiin 12 (CRUD x 3 taulua).', luku;
  end if;

  -- =================================================================
  -- TUOTANNON tasks-TAULU ON MUUTEN KOSKEMATON
  -- =================================================================
  -- Tama migraatio lisasi siihen tasan yhden rajoitteen. Jos
  -- politiikkoja, RLS:n tilaa tai omistajuutta olisi muutettu, se
  -- nakyisi tassa.
  select count(*) into luku from pg_policies
   where schemaname = 'public' and tablename = 'tasks';
  if luku <> 4 then
    raise exception 'tasks-taulussa on nyt % politiikkaa neljan sijaan.', luku;
  end if;

  if not exists (
    select 1 from pg_class
     where relnamespace = 'public'::regnamespace
       and relname = 'tasks' and relrowsecurity
  ) then
    raise exception 'RLS sammui tasks-taulusta kesken migraation.';
  end if;

  select count(*) into luku from public.tasks where user_id is null;
  if luku <> 0 then
    raise exception 'tasks-tauluun ilmestyi % omistajatonta rivia.', luku;
  end if;

  raise notice 'Migraatio 0007 valmis (39 objektia). Aja seuraavaksi supabase/verify/verify_0007.sql.';
end $$;

commit;

-- =====================================================================
-- VIITE-EHEYS: MITÄ TÄMÄ MIGRAATIO TAKAA
-- =====================================================================
-- Laskun molemmat viitteet ovat yhdistelmävierasavaimia muotoa
-- (user_id, viite) -> kohde(user_id, id). Kanta siis takaa, että
-- viitattu rivi kuuluu samalle omistajalle.
--
-- Käytännössä: käyttäjä B ei voi luoda laskua, joka viittaa käyttäjän A
-- tehtävään tai A:n toistuvaan kuluun — ei edes silloin kun B tuntee
-- tunnisteen ja ohittaa sovelluksen kokonaan. Yritys päättyy virheeseen
-- 23503.
--
-- Todistus ajetaan hyväksyntätestissä (tools/rls-acceptance).
--
-- =====================================================================
-- VARMISTUS MIGRAATION JÄLKEEN
-- =====================================================================
-- supabase/verify/verify_0007.sql — yksi lause, yksi taulukko.
--
-- =====================================================================
-- ROLLBACK
-- =====================================================================
-- Poisto kadottaa kaikki laskut, kulut ja säästötavoitteet. Ota
-- varmuuskopio ensin.
--
--   begin;
--   set local lock_timeout = '5s';
--   drop table if exists public.bills;            -- viittaa kuluihin ja tehtäviin
--   drop table if exists public.savings_goals;
--   drop table if exists public.recurring_expenses;
--   commit;
--
-- Rollback EI poista rajoitetta tasks_owner_row_key eikä funktiota
-- public.touch_updated_at():
--   * tasks_owner_row_key on oikea rajoite riippumatta siitä, viittaako
--     siihen mikään. Sen poistaminen olisi erillinen harkittu muutos.
--   * touch_updated_at on migraation 0002 objekti, ei tämän.
--
-- Muista tällöin palauttaa src/data/schema.js -> TABLES.bills = false,
-- TABLES.recurringExpenses = false, TABLES.savingsGoals = false.
