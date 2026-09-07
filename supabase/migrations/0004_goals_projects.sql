-- =====================================================================
-- Manifestival — migraatio 0004: tavoitteet, projektit ja määräajat
-- =====================================================================
--
-- TILA: EI AJETTU TUOTANTOON.
--
-- ESIEHDOT
--   1. Migraatio 0001 on ajettu ja todennettu (user_id, RLS, 4 politiikkaa)
--   2. Migraatio 0002 on ajettu (tehtävän domain-kentät)
--   3. Migraatio 0003 on ajettu TAI tietoisesti ohitettu
--   4. Varmuuskopio on otettu
--      (supabase/preflight/recovery_snapshot_pre_0004_0008.sql)
--   5. PostgreSQL 15 tai uudempi — ks. VAIHE 0b, kohta 6
--
-- TARKOITUS
-- Tehtävä ilman tavoitetta on työtä. Tavoite ilman tehtäviä on toivelista.
-- Tämä migraatio luo yhteyden: tehtävä voi kuulua tavoitteeseen ja
-- projektiin, ja tavoitteen edistyminen lasketaan sen tehtävistä.
--
-- Samalla tehtävälle lisätään määräaika. Määräaika on eri asia kuin
-- aikataulutus: `date` kertoo milloin asiaa on tarkoitus tehdä, `deadline`
-- kertoo milloin sen on oltava valmis. Näiden yhdistäminen samaan kenttään
-- oli alkuperäisen mallin virhe — sen takia myöhästyminen ei ollut
-- havaittavissa.
--
-- KÄYTTÖÖNOTTO KOODISSA
-- Migraation JA hyväksyntätestin jälkeen: src/data/schema.js ->
-- TABLES.goals = true ja TABLES.projects = true.
--
-- =====================================================================
-- TÄMÄN MIGRAATION TÄRKEIN MUUTOS: OMISTAJUUS ON KANNAN VASTUULLA
-- =====================================================================
-- Tämän tiedoston aiempi versio liitti tehtävän tavoitteeseen tavallisella
-- yhden sarakkeen vierasavaimella ja totesi lopussa, ettei se estä
-- ristiinkiinnitystä — että käyttäjä B voisi liittää OMAN tehtävänsä
-- käyttäjän A tavoitteeseen. Se merkittiin hyväksytyksi riskiksi.
--
-- Se ei ole hyväksyttävä riski, ja syy on tämä:
--
--   RLS ESTÄÄ LUKEMISEN, EI VIITTAAMISTA.
--
-- Vierasavaimen tarkistus ei kulje RLS:n läpi. Kanta katsoo, onko rivi
-- olemassa — ei sitä, saisiko viittaaja nähdä sen. Kun B lähettää rivin
-- jossa goal_id on A:n tavoitteen tunniste, RLS hyväksyy rivin
-- moitteetta: rivin omistaja on B, aivan kuten pitääkin. Ainoa asia joka
-- voi torjua sen on kannan oma eheysrajoite.
--
-- Perustelut joilla riski aiemmin hyväksyttiin eivät kestä:
--   "tunnisteet ovat arvaamattomia" — tämä on turvaa hämäryydellä, ja
--     tunniste vuotaa jokaisessa jaetussa linkissä, viennissä ja lokissa.
--   "sovellus tarjoaa vain omat tavoitteet" — sovellus on selaimessa.
--     Kanta ei voi luottaa siihen mitä selaimessa ajetaan.
--
-- Siksi jokainen tämän migraation viittaus on YHDISTELMÄVIERASAVAIN:
--
--   foreign key (user_id, goal_id) references goals (user_id, id)
--
-- Nyt kanta vaatii, että viitattu rivi kuuluu samalle omistajalle. B:n
-- yritys päättyy virheeseen 23503 riippumatta siitä, mitä selaimessa
-- ajetaan. Tämä vaatii tavoitteelta ja projektilta oman rivin avaimen
-- `unique (user_id, id)` — se on tarkoituksellinen ja alla varmistettu.
--
-- Sama korjaus tehtiin migraatioon 0003 (routine_exceptions). Tämä on
-- sama vika kuudessa muussa paikassa.
--
-- MITÄ TÄMÄ EI OLE
-- Tämä ei ole idempotentti migraatio, ja se on tarkoitus. Aiempi versio
-- käytti `if not exists` -muotoa, jolloin toinen ajo, kesken jäänyt ajo
-- ja tuore ajo näyttivät kaikki onnistuneelta. Tila, jota ei voi erottaa,
-- on tila jota ei voi korjata. Nyt migraatio laskee objektinsa ja
-- KESKEYTYY, jos yksikin niistä on jo olemassa.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- VAIHE 0: lukituksen aikakatkaisu
--
-- Tämä migraatio EI ole pelkkä uusien taulujen luonti. Se lisää kolme
-- saraketta ja kaksi vierasavainta TUOTANNON tasks-tauluun ja ottaa
-- siihen ACCESS EXCLUSIVE -lukon. Se viittaa myös auth.users-tauluun,
-- jota jokainen kirjautuminen koskee.
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
  odotettu  int;
  on_0003   boolean;
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
  -- jossa tarkistus OHITETAAN kokonaan jos yksikin sarake on NULL. Jos
  -- user_id voisi olla NULL, tehtava jossa user_id on NULL ja goal_id
  -- osoittaa toisen kayttajan tavoitteeseen menisi lapi.
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

  -- 5. Vanha data on ehjaa. Yhdistelmavierasavain lisataan TUOTANNON
  --    tasks-tauluun; jos siella on omistajaton rivi, viite ei kaadu
  --    (MATCH SIMPLE ohittaa NULLin) mutta se on merkki siita, ettei
  --    kannan tila vastaa oletusta.
  select count(*) into olemassa from public.tasks where user_id is null;
  if olemassa <> 0 then
    raise exception 'tasks-taulussa on % omistajatonta rivia. Korjaa ne ennen 0004:aa.', olemassa;
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
  --    `on delete set null (goal_id)` — sarakelista suluissa. Ilman sita
  --    PostgreSQL nollaisi KAIKKI vierasavaimen sarakkeet, myos user_id,
  --    joka on NOT NULL. Silloin tavoitteen poistaminen kaatuisi aina.
  --
  --    Sarakelista tuli PostgreSQL 15:ssa. Vanhemmalla palvelimella tama
  --    migraatio ei ole vain syntaksivirhe vaan vaarin kirjoitettu: se
  --    pitaisi tehda toisin. Siksi versio tarkistetaan tassa eika jateta
  --    parserin varaan.
  if current_setting('server_version_num')::int < 150000 then
    raise exception 'PostgreSQL % on liian vanha. Yhdistelmavierasavaimen sarakekohtainen ON DELETE SET NULL vaatii version 15.',
      current_setting('server_version');
  end if;

  -- 7. OSITTAISEN TAI AIEMMAN AJON TUNNISTUS
  --
  --    Kolmekymmentakuusi objektia: kaksi taulua, kolme saraketta
  --    tasks-tauluun, seitsemantoista rajoitetta, nelja indeksia, kaksi
  --    liipaisinta ja kahdeksan politiikkaa. Nolla = tuore ajo. Mika
  --    tahansa muu luku tarkoittaa, etta ajo on tehty tai jaanyt kesken
  --    — eika kumpaakaan korjata ajamalla uudelleen.
  --
  --    Jos 0003 on ajettu, mukaan tulee 37. objekti: rutiinin viite
  --    tavoitteeseen. Odotus lasketaan siksi kannan tilasta eika
  --    kirjoiteta vakiona.
  --
  --    Funktio touch_updated_at EI ole listassa: sen luo jo migraatio
  --    0002, joka on ajettu.
  on_0003 := exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'routines' and column_name = 'goal_id'
  );
  odotettu := 36 + (case when on_0003 then 1 else 0 end);

  select count(*) into olemassa from (
    select 1 from pg_tables
      where schemaname = 'public' and tablename in ('goals', 'projects')
    union all
    select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'tasks'
        and column_name in ('deadline', 'goal_id', 'project_id')
    union all
    select 1 from pg_constraint
      where conname in ('goals_status_check', 'goals_progress_mode_check',
                        'goals_manual_progress_check', 'goals_priority_check',
                        'goals_title_check', 'goals_parent_not_self_check',
                        'goals_owner_row_key', 'goals_parent_goal_fkey',
                        'goals_project_id_fkey',
                        'projects_priority_check', 'projects_date_range_check',
                        'projects_status_check', 'projects_name_check',
                        'projects_owner_row_key', 'projects_goal_id_fkey',
                        'tasks_goal_id_fkey', 'tasks_project_id_fkey',
                        'routines_goal_id_fkey')
    union all
    select 1 from pg_indexes
      where schemaname = 'public'
        and indexname in ('goals_user_status_idx', 'projects_user_status_idx',
                          'tasks_user_goal_idx', 'tasks_user_deadline_idx')
    union all
    select 1 from pg_trigger
      where not tgisinternal
        and tgname in ('goals_touch_updated_at', 'projects_touch_updated_at')
    union all
    select 1 from pg_policies
      where schemaname = 'public' and tablename in ('goals', 'projects')
  ) kaikki;

  if olemassa = odotettu then
    raise exception 'Migraatio 0004 on JO AJETTU (%/% objektia). Ala aja uudelleen — aja supabase/verify/verify_0004.sql.',
      olemassa, odotettu;
  end if;

  if olemassa > 0 then
    select string_agg(nimi, ', ' order by nimi) into nimet from (
      select tablename::text as nimi from pg_tables
        where schemaname = 'public' and tablename in ('goals', 'projects')
      union all
      select 'tasks.' || column_name::text from information_schema.columns
        where table_schema = 'public' and table_name = 'tasks'
          and column_name in ('deadline', 'goal_id', 'project_id')
      union all
      select conname::text from pg_constraint
        where conname in ('goals_status_check', 'goals_progress_mode_check',
                          'goals_manual_progress_check', 'goals_priority_check',
                          'goals_title_check', 'goals_parent_not_self_check',
                          'goals_owner_row_key', 'goals_parent_goal_fkey',
                          'goals_project_id_fkey',
                          'projects_priority_check', 'projects_date_range_check',
                          'projects_status_check', 'projects_name_check',
                          'projects_owner_row_key', 'projects_goal_id_fkey',
                          'tasks_goal_id_fkey', 'tasks_project_id_fkey',
                          'routines_goal_id_fkey')
      union all
      select indexname::text from pg_indexes
        where schemaname = 'public'
          and indexname in ('goals_user_status_idx', 'projects_user_status_idx',
                            'tasks_user_goal_idx', 'tasks_user_deadline_idx')
      union all
      select tgname::text from pg_trigger
        where not tgisinternal
          and tgname in ('goals_touch_updated_at', 'projects_touch_updated_at')
      union all
      select policyname::text from pg_policies
        where schemaname = 'public' and tablename in ('goals', 'projects')
    ) loydetyt;

    raise exception 'Migraatio 0004 on kesken: % objektia %:sta on jo olemassa (%). Ks. docs/MIGRATION-0004-RECOVERY.md.',
      olemassa, odotettu, nimet;
  end if;

  raise notice 'Esiehdot kunnossa. Omistaja %, 0003 ajettu: %, 0004:n objekteja 0/%.',
    omistaja, on_0003, odotettu;
end $$;

-- ---------------------------------------------------------------------
-- VAIHE 1: goals
--
-- progress_mode ratkaisee mistä edistyminen tulee:
--   task_based  lasketaan liitetyistä tehtävistä (oletus)
--   manual      käyttäjän itse arvioima prosentti
--
-- Tyhjän tavoitteen edistyminen on 0 %, ei 100 %. Se on tietoinen valinta:
-- "ei tehtäviä" ei tarkoita "valmis". Laskenta on domainissa
-- (src/domain/goal.js), ei kannassa — näin sama sääntö pätee myös silloin
-- kun tieto on vielä muistivarastossa.
--
-- parent_goal_id sallii tavoitehierarkian. Se on nullable ja itseensä
-- viittaava; syklien esto on domainin vastuulla. Viite lisätään vasta kun
-- omistajan rivin avain on olemassa.
-- ---------------------------------------------------------------------
create table public.goals (
  id              text primary key,
  user_id         uuid not null default auth.uid()
                  references auth.users(id) on delete cascade,

  title           text not null,
  description     text,
  category        text not null default 'kehitys',
  priority        text not null default 'normaali',
  status          text not null default 'active',

  target_date     date,

  progress_mode   text not null default 'task_based',
  manual_progress integer not null default 0,

  parent_goal_id  text,
  project_id      text,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

alter table public.goals
  add constraint goals_status_check
  check (status in ('active', 'paused', 'completed', 'abandoned', 'archived'));

alter table public.goals
  add constraint goals_progress_mode_check
  check (progress_mode in ('manual', 'task_based', 'project_based', 'routine_based'));

alter table public.goals
  add constraint goals_manual_progress_check
  check (manual_progress >= 0 and manual_progress <= 100);

alter table public.goals
  add constraint goals_priority_check
  check (priority in ('korkea', 'normaali', 'matala'));

alter table public.goals
  add constraint goals_title_check
  check (length(btrim(title)) > 0);

-- Tavoite ei voi olla oma yläkäsitteensä.
alter table public.goals
  add constraint goals_parent_not_self_check
  check (parent_goal_id is null or parent_goal_id <> id);

-- OMISTAJAN RIVIN AVAIN
--
-- id on jo yksikäsitteinen, joten tämä ei lisää yhtään uutta rajoitusta
-- riveille. Se ei ole tuplavarmistus vaan yhdistelmävierasavaimen kohde:
-- PostgreSQL vaatii, että viitatuille sarakkeille on yksikäsitteisyys-
-- rajoite. Ilman tätä alla olevia viitteitä ei voi luoda lainkaan, ja
-- koko omistajuussuoja jäisi pois.
alter table public.goals
  add constraint goals_owner_row_key unique (user_id, id);

-- Tavoitehierarkia. Yhdistelmävierasavain: alatavoite ei voi kuulua
-- toisen käyttäjän ylätavoitteeseen.
alter table public.goals
  add constraint goals_parent_goal_fkey
  foreign key (user_id, parent_goal_id) references public.goals (user_id, id)
  on delete set null (parent_goal_id);

create index goals_user_status_idx
  on public.goals (user_id, status);

-- ---------------------------------------------------------------------
-- VAIHE 2: projects
--
-- Projekti on tavoitetta konkreettisempi ja tehtävää suurempi: rajattu
-- kokonaisuus, jolla on alku ja loppu. Se voi kuulua tavoitteeseen.
-- ---------------------------------------------------------------------
create table public.projects (
  id          text primary key,
  user_id     uuid not null default auth.uid()
              references auth.users(id) on delete cascade,

  name        text not null,
  description text,
  category    text not null default 'muu',
  priority    text not null default 'normaali',
  status      text not null default 'active',

  goal_id     text,

  -- Aloitus ja määräaika ovat eri asioita: projekti voi olla myöhässä
  -- vaikka yksikään tehtävä ei olisi, ja päinvastoin.
  start_date  date,
  deadline    date,

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table public.projects
  add constraint projects_priority_check
  check (priority in ('korkea', 'normaali', 'matala'));

-- Määräaika ei voi olla ennen aloitusta.
alter table public.projects
  add constraint projects_date_range_check
  check (start_date is null or deadline is null or deadline >= start_date);

alter table public.projects
  add constraint projects_status_check
  check (status in ('planned', 'active', 'on_hold', 'completed', 'archived'));

alter table public.projects
  add constraint projects_name_check
  check (length(btrim(name)) > 0);

-- Omistajan rivin avain, samasta syystä kuin goals-taulussa.
alter table public.projects
  add constraint projects_owner_row_key unique (user_id, id);

create index projects_user_status_idx
  on public.projects (user_id, status);

-- ---------------------------------------------------------------------
-- VAIHE 2b: taulujen väliset viitteet
--
-- goals ja projects viittaavat toisiinsa molempiin suuntiin, joten
-- viitteet lisätään vasta kun molemmat taulut ja niiden omistajan rivin
-- avaimet ovat olemassa.
--
-- Molemmat ovat yhdistelmävierasavaimia: käyttäjä ei voi liittää omaa
-- projektiaan toisen käyttäjän tavoitteeseen eikä päinvastoin.
-- ---------------------------------------------------------------------
alter table public.goals
  add constraint goals_project_id_fkey
  foreign key (user_id, project_id) references public.projects (user_id, id)
  on delete set null (project_id);

alter table public.projects
  add constraint projects_goal_id_fkey
  foreign key (user_id, goal_id) references public.goals (user_id, id)
  on delete set null (goal_id);

-- ---------------------------------------------------------------------
-- VAIHE 3: tasks — määräaika ja liitokset
--
-- Kaikki kolme saraketta ovat nullable eikä niillä ole oletusarvoa:
-- olemassa olevat tehtävät säilyvät täsmälleen sellaisina kuin ovat.
--
-- on delete set null (sarake): tavoitteen poisto ei saa koskaan poistaa
-- tehtävää. Työ on tehty, vaikka syy siihen olisi muuttunut. Sarakelista
-- on pakollinen — ilman sitä poisto yrittäisi nollata myös user_id:n.
-- ---------------------------------------------------------------------
alter table public.tasks add column deadline   date;
alter table public.tasks add column goal_id    text;
alter table public.tasks add column project_id text;

alter table public.tasks
  add constraint tasks_goal_id_fkey
  foreign key (user_id, goal_id) references public.goals (user_id, id)
  on delete set null (goal_id);

alter table public.tasks
  add constraint tasks_project_id_fkey
  foreign key (user_id, project_id) references public.projects (user_id, id)
  on delete set null (project_id);

-- Rutiinin vapaaehtoinen yhteys tavoitteeseen. Sarake luodaan
-- migraatiossa 0003; viite vasta tässä, koska goals syntyy nyt.
-- Ehdollinen, jotta 0004 toimii myös ilman 0003:a.
--
-- routines_owner_row_key on olemassa jo 0003:sta, joten tässä tarvitaan
-- vain viite — ja senkin on oltava yhdistelmä samasta syystä kuin muut.
do $$
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'routines' and column_name = 'goal_id'
  ) then
    alter table public.routines
      add constraint routines_goal_id_fkey
      foreign key (user_id, goal_id) references public.goals (user_id, id)
      on delete set null (goal_id);
  end if;
end $$;

-- Tavoitenäkymä hakee tehtävät tavoitteen mukaan.
create index tasks_user_goal_idx
  on public.tasks (user_id, goal_id);

-- Määräaikanäkymä hakee avoimet tehtävät määräajan mukaan.
create index tasks_user_deadline_idx
  on public.tasks (user_id, deadline)
  where deadline is not null;

-- ---------------------------------------------------------------------
-- VAIHE 4: updated_at
--
-- Funktio on luotu jo migraatiossa 0002 ja se on tuotannossa. Siksi tämä
-- on `create or replace` eikä `create` — se ei ole poikkeus fail-closed
-- -periaatteesta vaan sen seuraus: funktio EI ole tämän migraation
-- objekti, joten sitä ei myöskään lasketa osittaisen ajon tunnistuksessa.
--
-- security invoker ja kiinnitetty search_path: liipaisin ajetaan
-- kirjoittajan oikeuksilla eikä sen nimenselvitystä voi ohjata
-- muuttamalla search_pathia.
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

create trigger goals_touch_updated_at
  before update on public.goals
  for each row execute function public.touch_updated_at();

create trigger projects_touch_updated_at
  before update on public.projects
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------
-- VAIHE 5: RLS
-- ---------------------------------------------------------------------
alter table public.goals    enable row level security;
alter table public.projects enable row level security;

create policy goals_select_own on public.goals
  for select to authenticated using (auth.uid() = user_id);
create policy goals_insert_own on public.goals
  for insert to authenticated with check (auth.uid() = user_id);
create policy goals_update_own on public.goals
  for update to authenticated using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
create policy goals_delete_own on public.goals
  for delete to authenticated using (auth.uid() = user_id);

create policy projects_select_own on public.projects
  for select to authenticated using (auth.uid() = user_id);
create policy projects_insert_own on public.projects
  for insert to authenticated with check (auth.uid() = user_id);
create policy projects_update_own on public.projects
  for update to authenticated using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
create policy projects_delete_own on public.projects
  for delete to authenticated using (auth.uid() = user_id);

-- PUBLIC ENSIN, EIKA VAIN ANON.
--
-- PostgreSQL-rooli PUBLIC tarkoittaa "kaikki roolit", ja sille myonnetyn
-- oikeuden perii jokainen rooli — myos anon. Perittya oikeutta ei nay
-- roolikohtaisissa listauksissa lainkaan, joten `revoke ... from anon`
-- ei poista sita eika sen puuttumista huomaisi mistaan.
revoke all on public.goals    from public;
revoke all on public.projects from public;
revoke all on public.goals    from anon;
revoke all on public.projects from anon;

-- Myos authenticated nollataan ensin, jotta lopputulos on TASAN nelja
-- oikeutta eika "nelja plus se mita oletusoikeudet sattuivat antamaan".
revoke all on public.goals    from authenticated;
revoke all on public.projects from authenticated;

grant select, insert, update, delete on public.goals    to authenticated;
grant select, insert, update, delete on public.projects to authenticated;

-- ---------------------------------------------------------------------
-- VAIHE 6: loppuvarmistus ENNEN COMMITTIA
--
-- Viimeinen hetki, jolloin virheellinen tulos voidaan perua ilman
-- jalkia. Sen jalkeen korjaaminen on eri operaatio.
-- ---------------------------------------------------------------------
do $$
declare
  luku      int;
  odotettu  int;
  on_0003   boolean;
begin
  -- Molemmat taulut ovat olemassa ja tyhjia.
  select count(*) into luku from pg_tables
   where schemaname = 'public' and tablename in ('goals', 'projects');
  if luku <> 2 then
    raise exception 'Tauluja syntyi % kahden sijaan.', luku;
  end if;

  if (select count(*) from public.goals) <> 0
     or (select count(*) from public.projects) <> 0 then
    raise exception 'Uudet taulut eivat ole tyhjia. Jotain on jo kirjoitettu.';
  end if;

  -- RLS on paalla molemmissa. Ilman tata uudet taulut olisivat kaikkien
  -- luettavissa heti syntyessaan.
  select count(*) into luku from pg_class
   where relnamespace = 'public'::regnamespace
     and relname in ('goals', 'projects') and relrowsecurity;
  if luku <> 2 then
    raise exception 'RLS on paalla vain %/2 taulussa.', luku;
  end if;

  -- Kahdeksan politiikkaa, kaikki authenticated-roolille.
  select count(*) into luku from pg_policies
   where schemaname = 'public' and tablename in ('goals', 'projects')
     and roles = '{authenticated}'::name[];
  if luku <> 8 then
    raise exception 'Politiikkoja syntyi % kahdeksan sijaan.', luku;
  end if;

  -- =================================================================
  -- OMISTAJUUSINVARIANTTI — taman migraation koko pointti
  -- =================================================================
  --
  -- Kaksi omistajan rivin avainta. Ilman naita alla olevat viitteet
  -- eivat olisi voineet syntya lainkaan.
  select count(*) into luku from pg_constraint
   where conname in ('goals_owner_row_key', 'projects_owner_row_key')
     and contype = 'u';
  if luku <> 2 then
    raise exception 'Omistajan rivin avaimia on % kahden sijaan.', luku;
  end if;

  -- Jokainen viittaus on YHDISTELMA, ei yhden sarakkeen vierasavain.
  --
  -- Tama katsotaan RAKENTEESTA eika nimesta: conkey kertoo montako
  -- saraketta avaimessa on, ja user_id:n on oltava yksi niista. Nimi
  -- voisi olla mika tahansa; rakenne ei voi valehdella.
  --
  -- confdeltype = 'n' on ON DELETE SET NULL. confdelsetcols kertoo
  -- MITKA sarakkeet nollataan — sen on oltava tasan yksi, ja nimenomaan
  -- se joka EI ole user_id. Jos confdelsetcols olisi NULL, poisto
  -- yrittaisi nollata myos user_id:n ja kaatuisi NOT NULL -virheeseen
  -- joka kerta.
  select count(*) into luku
    from pg_constraint con
    join pg_class t on t.oid = con.conrelid
   where con.conname in ('goals_parent_goal_fkey', 'goals_project_id_fkey',
                         'projects_goal_id_fkey',
                         'tasks_goal_id_fkey', 'tasks_project_id_fkey')
     and con.contype = 'f'
     and array_length(con.conkey, 1) = 2
     and con.confdeltype = 'n'
     and array_length(con.confdelsetcols, 1) = 1
     -- user_id on osa avainta...
     and exists (select 1 from unnest(con.conkey) k(attnum)
                   join pg_attribute a
                     on a.attrelid = t.oid and a.attnum = k.attnum
                  where a.attname = 'user_id')
     -- ...mutta sita EI nollata poistossa.
     and not exists (select 1 from unnest(con.confdelsetcols) k(attnum)
                       join pg_attribute a
                         on a.attrelid = t.oid and a.attnum = k.attnum
                      where a.attname = 'user_id');
  if luku <> 5 then
    raise exception 'Omistajuuden yhdistelmavierasavaimia on % viiden sijaan. Ristiinkiinnitys olisi mahdollinen.', luku;
  end if;

  -- Rutiinin viite, jos 0003 on ajettu. Sama vaatimus.
  on_0003 := exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'routines' and column_name = 'goal_id'
  );
  if on_0003 then
    select count(*) into luku
      from pg_constraint con
      join pg_class t on t.oid = con.conrelid
     where con.conname = 'routines_goal_id_fkey'
       and con.contype = 'f'
       and array_length(con.conkey, 1) = 2
       and con.confdeltype = 'n'
       and array_length(con.confdelsetcols, 1) = 1
       and exists (select 1 from unnest(con.conkey) k(attnum)
                     join pg_attribute a
                       on a.attrelid = t.oid and a.attnum = k.attnum
                    where a.attname = 'user_id');
    if luku <> 1 then
      raise exception 'routines_goal_id_fkey ei ole yhdistelmavierasavain.';
    end if;
  end if;

  -- Yhtaan yhden sarakkeen viitetta naihin tauluihin ei saa jaada.
  --
  -- Tama on ERI vaite kuin ylla: ylla laskettiin ETTA oikeat viitteet
  -- ovat olemassa, tama laskee ETTEI vaaria ole. Kumpikaan yksin ei
  -- riita — migraatio voisi luoda oikean viitteen ja jattaa vanhan
  -- viereen, jolloin heikompi paastaisi rivin lapi.
  select count(*) into luku
    from pg_constraint con
    join pg_class ft on ft.oid = con.confrelid
   where con.contype = 'f'
     and ft.relnamespace = 'public'::regnamespace
     and ft.relname in ('goals', 'projects')
     and array_length(con.conkey, 1) < 2;
  if luku <> 0 then
    raise exception 'Tauluihin goals/projects osoittaa % yhden sarakkeen vierasavainta. Ne sallisivat ristiinkiinnityksen.', luku;
  end if;

  -- =================================================================
  -- OIKEUDET
  -- =================================================================
  -- anon ei saa mitaan, edes perittyna.
  select count(*) into luku
    from (select unnest(array['public.goals', 'public.projects']) as taulu) tt
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
   where cl.oid = any (array['public.goals'::regclass, 'public.projects'::regclass])
     and acl.grantee = 0;
  if luku <> 0 then
    raise exception 'PUBLIC-roolilla on % oikeutta uusiin tauluihin.', luku;
  end if;

  -- authenticated saa tasan CRUD, ei enempaa.
  select count(*) into luku
    from (select unnest(array['public.goals', 'public.projects']) as taulu) tt
    cross join (select unnest(array['select', 'insert', 'update', 'delete',
                                    'truncate', 'references', 'trigger']) as oikeus) pp
   where has_table_privilege('authenticated', tt.taulu, pp.oikeus);
  if luku <> 8 then
    raise exception 'authenticated-roolilla on % oikeutta, odotettiin 8 (CRUD x 2 taulua).', luku;
  end if;

  -- =================================================================
  -- VANHA DATA ON KOSKEMATON
  -- =================================================================
  -- Kolme uutta saraketta ovat kaikilla riveilla NULL. Jos jollain
  -- rivilla olisi arvo, migraatio olisi kirjoittanut dataa jota sen ei
  -- pitanyt kirjoittaa.
  select count(*) into luku from public.tasks
   where deadline is not null or goal_id is not null or project_id is not null;
  if luku <> 0 then
    raise exception 'tasks-taulussa on % rivia joilla uusi sarake ei ole NULL.', luku;
  end if;

  -- Eika yksikaan uusi sarake saanut oletusarvoa tai NOT NULLia.
  -- Oletusarvo tekisi jokaisesta uudesta tehtavasta hiljaa erilaisen.
  select count(*) into luku from information_schema.columns
   where table_schema = 'public' and table_name = 'tasks'
     and column_name in ('deadline', 'goal_id', 'project_id')
     and (column_default is not null or is_nullable <> 'YES');
  if luku <> 0 then
    raise exception '% uudella tasks-sarakkeella on oletusarvo tai NOT NULL.', luku;
  end if;

  odotettu := 36 + (case when on_0003 then 1 else 0 end);
  raise notice 'Migraatio 0004 valmis (% objektia). Aja seuraavaksi supabase/verify/verify_0004.sql.',
    odotettu;
end $$;

commit;

-- =====================================================================
-- VIITE-EHEYS: MITÄ TÄMÄ MIGRAATIO TAKAA
-- =====================================================================
-- Jokainen tämän migraation viittaus on yhdistelmävierasavain muotoa
-- (user_id, viite) -> kohde(user_id, id). Kanta siis takaa, että
-- viitattu rivi kuuluu samalle omistajalle.
--
-- Käytännössä: käyttäjä B ei voi luoda tehtävää, projektia, tavoitetta
-- eikä rutiinia, joka viittaa käyttäjän A tavoitteeseen tai projektiin —
-- ei edes silloin kun B tuntee tunnisteen ja ohittaa sovelluksen
-- kokonaan. Yritys päättyy virheeseen 23503.
--
-- Tämä EI nojaa siihen, että
--   - tunnisteet olisivat arvaamattomia
--   - sovellus tarjoaisi valintaan vain omat rivit
--   - RLS piilottaisi kohteen
-- Yksikään näistä ei estä VIITTAAMISTA, vain näkemisen.
--
-- Todistus ajetaan hyväksyntätestissä (tools/rls-acceptance), jossa oikea
-- kirjautunut käyttäjä B yrittää tämän oikeaa kantaa vasten.
--
-- =====================================================================
-- VARMISTUS MIGRAATION JÄLKEEN
-- =====================================================================
-- supabase/verify/verify_0004.sql — yksi lause, yksi taulukko.
--
-- =====================================================================
-- ROLLBACK
-- =====================================================================
--   begin;
--   set local lock_timeout = '5s';
--   alter table public.tasks
--     drop constraint if exists tasks_goal_id_fkey,
--     drop constraint if exists tasks_project_id_fkey;
--   drop index if exists public.tasks_user_goal_idx;
--   drop index if exists public.tasks_user_deadline_idx;
--   alter table public.tasks
--     drop column if exists deadline,
--     drop column if exists goal_id,
--     drop column if exists project_id;
--   alter table public.routines drop constraint if exists routines_goal_id_fkey;
--   -- goals ja projects viittaavat toisiinsa, joten viite on purettava
--   -- ennen pudotusta.
--   alter table public.goals drop constraint if exists goals_project_id_fkey;
--   drop table if exists public.projects;
--   drop table if exists public.goals;
--   commit;
--
-- Rollback EI poista routines_owner_row_key -rajoitetta: se on migraation
-- 0003 objekti eikä tämän.
--
-- Muista tällöin palauttaa src/data/schema.js -> TABLES.goals = false ja
-- TABLES.projects = false.
