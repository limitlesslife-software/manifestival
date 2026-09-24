-- =====================================================================
-- Manifestival — migraatio 0011: henkilökohtainen avustaja
-- =====================================================================
--
-- TILA: EI AJETTU TUOTANTOON. EI HYVÄKSYTTY.
--
-- TÄMÄ ON SUUNNITELMA, EI SUORITUSKÄSKY.
--
-- =====================================================================
-- TÄMÄ MIGRAATIO EI KOSKE OLEMASSA OLEVAAN DATAAN
-- =====================================================================
--
-- Se on syytä sanoa ääneen, koska edellinen migraatio (0010) koski.
--
-- 0011 LUO VIISI UUTTA TAULUA eikä muuta yhtäkään olemassa olevaa
-- saraketta, rajoitetta tai riviä. Tyhjää taulua ei voi rikkoa, eikä
-- yksikään nykyinen toiminto voi lakata toimimasta tämän takia.
--
-- Ainoa lukitus on `auth.users`-taulun SHARE ROW EXCLUSIVE, jonka
-- vierasavaimen luonti ottaa. `lock_timeout` on silti asetettu.
--
-- =====================================================================
-- MITÄ TÄMÄ LISÄÄ
-- =====================================================================
--
--   public.inbox_items     saapuvat: kirjaa nyt, järjestä myöhemmin
--   public.reminders       muistutusten elinkaari
--   public.notices         ilmoitushistoria
--   public.travel_plans    lähtöajan laskenta
--   public.location_rules  sijaintisäännöt (ei toteutusta)
--
-- =====================================================================
-- MITÄ TÄMÄ EI LISÄÄ — EIKÄ SAA LISÄTÄ
-- =====================================================================
--
-- KOORDINAATTEJA EI TALLENNETA. `travel_plans` ja `location_rules`
-- tuntevat paikan NIMEN, eivät sijaintia.
--
-- Se ei ole tekninen rajoite vaan tietosuojapäätös. Koordinaatti
-- kannassa on koordinaatti varmuuskopiossa, viennissä ja mahdollisessa
-- vuodossa. Sijaintihistoria kertoo missä ihminen asuu, työskentelee ja
-- käy — eikä lähtöajan laskenta tarvitse siitä mitään.
--
-- Jos geoaita joskus toteutetaan, koordinaatit kuuluvat
-- alustasovittimelle suorituksen ajaksi. Ne eivät kuulu tänne.
--
-- ÄÄNTÄ EI TALLENNETA. `inbox_items.source` kertoo, tuliko rivi
-- puheesta, mutta ääntä itseään ei ole missään. Litterointi
-- tallennetaan `text`-sarakkeeseen, koska se ON käyttäjän
-- muistiinpano — ei siksi että se olisi lokia.
--
-- RAAKAA KEHOTETTA EI TALLENNETA. `inbox_items.proposal` sisältää
-- TULKINNAN (jäsennelty olio), ei mallille lähetettyä tekstiä eikä
-- mallin vastausta sellaisenaan.
--
-- =====================================================================
-- OMISTAJUUS
-- =====================================================================
--
-- Jokainen taulu saa `owner_row_key`-avaimen (user_id, id) ja RLS:n.
--
-- `travel_plans.task_id` ja `location_rules.task_id` ovat
-- YHDISTELMÄVIERASAVAIMIA `(user_id, task_id) -> tasks (user_id, id)`.
-- Tavallinen vierasavain sallisi ristiinkiinnityksen: vierasavaimen
-- tarkistus EI kulje RLS:n läpi.
--
-- Poistosääntö on `on delete set null (task_id)`. Tehtävän poisto ei
-- vie matkasuunnitelmaa: matka on yhä olemassa, se ei vain enää liity
-- tehtävään.
--
-- MUISTUTUKSEN JA ILMOITUKSEN `target_id` EI OLE VIERASAVAIN.
--
-- Kohde saa kadota. Muistutus on tietue siitä, että muistuttaminen oli
-- tarkoitus, ja ilmoitus tietue siitä, että asiasta kerrottiin.
-- Vierasavain poistaisi tai tyhjentäisi ne kohteen mukana — juuri sen
-- tiedon, jonka takia ne ovat olemassa. Sama perustelu kuin
-- `ai_action_audit.target_id` (0008) ja `transactions.source_id` (0009).
--
-- Orpo muistutus tunnistetaan sovelluksessa ja perutaan näkyvästi.
--
-- =====================================================================
-- OBJEKTIEN MÄÄRÄ: 72
-- =====================================================================
--
-- KORJATTU 63 -> 72 (todennettu oikealla PostgreSQL 17:llä,
-- tools/pg-rehearsal). Aiempi luku ei vastannut alla olevaa
-- erittelyä eikä tunnistuslistaa, joten täysin ajetun migraation
-- uudelleenajo ilmoitti "kesken: 72 objektia 63:sta" eikä "JO AJETTU".
--
--    5  taulua
--   25  CHECK-rajoitetta
--    5  owner_row_key -avainta
--    1  uniikkirajoite  (notices: kaksoiskappaleiden esto)
--    2  vierasavainta   (travel_plans, location_rules -> tasks)
--    9  indeksiä
--    5  liipaisinta
--   20  politiikkaa     (5 x 4)
--
-- Luku on käsin laskettu ja sitä käytetään osittaisen ajon
-- tunnistukseen. Nolla = tuore ajo. Mikä tahansa muu luku tarkoittaa,
-- että ajo on tehty tai jäänyt kesken — eikä kumpaakaan korjata
-- ajamalla uudelleen.

begin;

-- ---------------------------------------------------------------------
-- VAIHE 0a: lukitusraja
--
-- Migraatio viittaa auth.users- ja tasks-tauluihin, ja vierasavaimen
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

  -- 3. tasks-taulussa on omistajan rivin avain. Yhdistelmavierasavain
  --    matkasuunnitelmasta tehtavaan VAATII sen kohteeltaan.
  if not exists (
    select 1 from pg_constraint where conname = 'tasks_owner_row_key'
  ) then
    raise exception 'tasks_owner_row_key puuttuu. Aja migraatio 0007 ensin.';
  end if;

  -- 4. PostgreSQL 15 tai uudempi.
  --
  --    `on delete set null (sarake)` rajaa nollauksen yhteen
  --    sarakkeeseen. Ilman sarakelistaa PostgreSQL nollaisi KOKO
  --    vierasavaimen, myos NOT NULL -sarakkeen user_id, ja tehtavan
  --    poisto kaatuisi aina. Sama tarkistus kuin 0004:ssa ja 0010:ssa.
  if current_setting('server_version_num')::int < 150000 then
    raise exception 'PostgreSQL % on liian vanha. Yhdistelmavierasavaimen sarakekohtainen ON DELETE SET NULL vaatii version 15.',
      current_setting('server_version');
  end if;

  -- 5. Olen oikeassa tietokannassa.
  if not exists (select 1 from auth.users where id = omistaja) then
    raise exception 'Hyvaksyttya omistajaa % ei loydy auth.users-taulusta. Vaara projekti?', omistaja;
  end if;

  -- 6. OSITTAISEN TAI AIEMMAN AJON TUNNISTUS — 72 objektia.
  --
  --    Funktio touch_updated_at EI ole listassa: sen luo migraatio
  --    0002. Tama migraatio ei luo sita eika korvaa sita.
  select count(*) into olemassa from (
    select 1 from pg_tables
      where schemaname = 'public'
        and tablename in ('inbox_items', 'reminders', 'notices',
                          'travel_plans', 'location_rules')
    union all
    select 1 from pg_constraint
      where conname in (
        'inbox_items_status_check', 'inbox_items_source_check',
        'inbox_items_text_check', 'inbox_items_converted_check',
        'inbox_items_owner_row_key',
        'reminders_status_check', 'reminders_target_check',
        'reminders_trigger_check', 'reminders_title_check',
        'reminders_target_pair_check', 'reminders_alert_count_check',
        'reminders_snooze_count_check', 'reminders_lead_check',
        'reminders_owner_row_key',
        'notices_kind_check', 'notices_level_check', 'notices_status_check',
        'notices_title_check', 'notices_target_pair_check',
        'notices_owner_row_key', 'notices_key_unique',
        'travel_plans_mode_check', 'travel_plans_source_check',
        'travel_plans_title_check', 'travel_plans_minutes_check',
        'travel_plans_buffer_check', 'travel_plans_unknown_source_check',
        'travel_plans_owner_row_key', 'travel_plans_task_fkey',
        'location_rules_trigger_check', 'location_rules_place_check',
        'location_rules_owner_row_key', 'location_rules_task_fkey')
    union all
    select 1 from pg_indexes
      where schemaname = 'public'
        and indexname in (
          'inbox_items_user_status_idx', 'inbox_items_user_captured_idx',
          'reminders_user_due_idx', 'reminders_user_status_idx',
          'reminders_user_target_idx',
          'notices_user_status_idx', 'notices_user_created_idx',
          'travel_plans_user_arrival_idx', 'location_rules_user_active_idx')
    union all
    select 1 from pg_trigger
      where not tgisinternal
        and tgname in ('inbox_items_touch_updated_at', 'reminders_touch_updated_at',
                       'notices_touch_updated_at', 'travel_plans_touch_updated_at',
                       'location_rules_touch_updated_at')
    union all
    select 1 from pg_policies
      where schemaname = 'public'
        and tablename in ('inbox_items', 'reminders', 'notices',
                          'travel_plans', 'location_rules')
  ) kaikki;

  if olemassa = 72 then
    raise exception 'Migraatio 0011 on JO AJETTU. Ala aja uudelleen — aja supabase/verify/verify_0011.sql.';
  end if;

  if olemassa > 0 then
    select string_agg(nimi, ', ' order by nimi) into nimet from (
      select tablename::text as nimi from pg_tables
        where schemaname = 'public'
          and tablename in ('inbox_items', 'reminders', 'notices',
                            'travel_plans', 'location_rules')
      union all
      select conname::text from pg_constraint
        where conname in (
          'inbox_items_status_check', 'inbox_items_source_check',
          'inbox_items_text_check', 'inbox_items_converted_check',
          'inbox_items_owner_row_key',
          'reminders_status_check', 'reminders_target_check',
          'reminders_trigger_check', 'reminders_title_check',
          'reminders_target_pair_check', 'reminders_alert_count_check',
          'reminders_snooze_count_check', 'reminders_lead_check',
          'reminders_owner_row_key',
          'notices_kind_check', 'notices_level_check', 'notices_status_check',
          'notices_title_check', 'notices_target_pair_check',
          'notices_owner_row_key', 'notices_key_unique',
          'travel_plans_mode_check', 'travel_plans_source_check',
          'travel_plans_title_check', 'travel_plans_minutes_check',
          'travel_plans_buffer_check', 'travel_plans_unknown_source_check',
          'travel_plans_owner_row_key', 'travel_plans_task_fkey',
          'location_rules_trigger_check', 'location_rules_place_check',
          'location_rules_owner_row_key', 'location_rules_task_fkey')
      union all
      select indexname::text from pg_indexes
        where schemaname = 'public'
          and indexname in (
            'inbox_items_user_status_idx', 'inbox_items_user_captured_idx',
            'reminders_user_due_idx', 'reminders_user_status_idx',
            'reminders_user_target_idx',
            'notices_user_status_idx', 'notices_user_created_idx',
            'travel_plans_user_arrival_idx', 'location_rules_user_active_idx')
      union all
      select tgname::text from pg_trigger
        where not tgisinternal
          and tgname in ('inbox_items_touch_updated_at', 'reminders_touch_updated_at',
                         'notices_touch_updated_at', 'travel_plans_touch_updated_at',
                         'location_rules_touch_updated_at')
      union all
      select policyname::text from pg_policies
        where schemaname = 'public'
          and tablename in ('inbox_items', 'reminders', 'notices',
                            'travel_plans', 'location_rules')
    ) loydetyt;

    raise exception 'Migraatio 0011 on kesken: % objektia 72:sta on jo olemassa (%).',
      olemassa, nimet;
  end if;

  raise notice 'Esiehdot kunnossa. Omistaja %, 0011:n objekteja 0/72.', omistaja;
end $$;

-- ---------------------------------------------------------------------
-- VAIHE 0c: touch_updated_at on yhä kovennettu
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
-- VAIHE 1: inbox_items
-- ---------------------------------------------------------------------

create table public.inbox_items (
  id             text primary key,
  user_id        uuid not null default auth.uid()
                 references auth.users(id) on delete cascade,

  -- KÄYTTÄJÄN OMA TEKSTI. Tämä on sisältöä, ei lokia: käyttäjä
  -- kirjoitti sen itselleen. Puheesta tullut rivi kantaa litteroinnin,
  -- koska litterointi on silloin se mitä hän sanoi.
  text           text not null,

  -- unprocessed | proposed | needs_review | accepted | converted | dismissed
  status         text not null default 'unprocessed',

  -- text | voice | system. ÄÄNTÄ EI TALLENNETA, vain tieto lähteestä.
  source         text not null default 'text',

  -- Tekoälyn TULKINTA jäsenneltynä oliona. EI raakaa kehotetta eikä
  -- mallin vastausta sellaisenaan. Katoaa kun rivi käsitellään.
  proposal       jsonb,

  -- Mihin rivi muunnettiin. EI VIERASAVAIN: muunnettu tehtävä voidaan
  -- poistaa, eikä saapuvan rivin pidä kadota sen mukana.
  converted_kind text,
  converted_id   text,

  captured_at    timestamptz not null default now(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

alter table public.inbox_items
  add constraint inbox_items_status_check
  check (status in ('unprocessed', 'proposed', 'needs_review',
                    'accepted', 'converted', 'dismissed'));

alter table public.inbox_items
  add constraint inbox_items_source_check
  check (source in ('text', 'voice', 'system'));

alter table public.inbox_items
  add constraint inbox_items_text_check
  check (length(btrim(text)) > 0 and length(text) <= 1000);

-- MUUNNETTU ILMAN KOHDETTA ON TIETO JOKA EI KERRO MIHIN.
-- Sama sääntö kuin maksetulla laskulla ja saavutetulla välitavoitteella.
alter table public.inbox_items
  add constraint inbox_items_converted_check
  check ((status = 'converted' and converted_kind is not null)
      or (status <> 'converted' and converted_kind is null));

alter table public.inbox_items
  add constraint inbox_items_owner_row_key unique (user_id, id);

create index inbox_items_user_status_idx
  on public.inbox_items (user_id, status);

create index inbox_items_user_captured_idx
  on public.inbox_items (user_id, captured_at desc);

alter table public.inbox_items enable row level security;

create policy inbox_items_select_own on public.inbox_items
  for select to authenticated using (auth.uid() = user_id);
create policy inbox_items_insert_own on public.inbox_items
  for insert to authenticated with check (auth.uid() = user_id);
create policy inbox_items_update_own on public.inbox_items
  for update to authenticated using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
create policy inbox_items_delete_own on public.inbox_items
  for delete to authenticated using (auth.uid() = user_id);

revoke all on public.inbox_items from public;
revoke all on public.inbox_items from anon;
revoke all on public.inbox_items from authenticated;
grant select, insert, update, delete on public.inbox_items to authenticated;

create trigger inbox_items_touch_updated_at
  before update on public.inbox_items
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------
-- VAIHE 2: reminders
-- ---------------------------------------------------------------------

create table public.reminders (
  id            text primary key,
  user_id       uuid not null default auth.uid()
                references auth.users(id) on delete cascade,

  title         text not null,

  -- task | routine | bill | milestone | goal | travel | standalone
  --
  -- target_id EI OLE VIERASAVAIN. Kohde saa kadota; muistutus on
  -- tietue siitä että muistuttaminen oli tarkoitus.
  target_type   text not null default 'standalone',
  target_id     text,

  -- at_time | before_target | when_overdue | leave_by
  trigger_type  text not null default 'at_time',

  -- Milloin muistutus laukeaa. date + time, EI timestamptz:
  -- aikaleima siirtäisi suomalaisen aamun edelliselle päivälle UTC:ssä.
  due_date      date,
  due_time      time,

  lead_minutes  integer,

  -- scheduled | due | delivered | acknowledged | snoozed
  -- | completed | expired | cancelled
  status        text not null default 'scheduled',

  escalate      boolean not null default false,
  alert_count   integer not null default 0,
  snooze_count  integer not null default 0,

  -- Mihin asti muistutetaan. Ilman rajaa muistutus jäisi elämään.
  until_time    time,

  note          text,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

alter table public.reminders
  add constraint reminders_status_check
  check (status in ('scheduled', 'due', 'delivered', 'acknowledged',
                    'snoozed', 'completed', 'expired', 'cancelled'));

alter table public.reminders
  add constraint reminders_target_check
  check (target_type in ('task', 'routine', 'bill', 'milestone',
                         'goal', 'travel', 'standalone'));

alter table public.reminders
  add constraint reminders_trigger_check
  check (trigger_type in ('at_time', 'before_target', 'when_overdue', 'leave_by'));

alter table public.reminders
  add constraint reminders_title_check
  check (length(btrim(title)) > 0 and length(title) <= 200);

-- KOHDELAJI JA TUNNISTE KULKEVAT PARINA.
alter table public.reminders
  add constraint reminders_target_pair_check
  check ((target_type = 'standalone' and target_id is null)
      or (target_type <> 'standalone' and target_id is not null));

-- HÄLYTYSTEN MÄÄRÄ ON RAJATTU KANNASSA ASTI.
--
-- Loputon toisto on helppo kirjoittaa vahingossa: yksi ehto väärin päin
-- ja käyttäjän puhelin soi minuutin välein. Sovellus rajaa viiteen;
-- kanta on toinen este saman virheen tiellä.
alter table public.reminders
  add constraint reminders_alert_count_check
  check (alert_count >= 0 and alert_count <= 5);

alter table public.reminders
  add constraint reminders_snooze_count_check
  check (snooze_count >= 0 and snooze_count <= 10);

alter table public.reminders
  add constraint reminders_lead_check
  check (lead_minutes is null or (lead_minutes >= 0 and lead_minutes <= 10080));

alter table public.reminders
  add constraint reminders_owner_row_key unique (user_id, id);

create index reminders_user_due_idx
  on public.reminders (user_id, due_date, due_time);

create index reminders_user_status_idx
  on public.reminders (user_id, status);

create index reminders_user_target_idx
  on public.reminders (user_id, target_type, target_id);

alter table public.reminders enable row level security;

create policy reminders_select_own on public.reminders
  for select to authenticated using (auth.uid() = user_id);
create policy reminders_insert_own on public.reminders
  for insert to authenticated with check (auth.uid() = user_id);
create policy reminders_update_own on public.reminders
  for update to authenticated using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
create policy reminders_delete_own on public.reminders
  for delete to authenticated using (auth.uid() = user_id);

revoke all on public.reminders from public;
revoke all on public.reminders from anon;
revoke all on public.reminders from authenticated;
grant select, insert, update, delete on public.reminders to authenticated;

create trigger reminders_touch_updated_at
  before update on public.reminders
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------
-- VAIHE 3: notices
-- ---------------------------------------------------------------------

create table public.notices (
  id           text primary key,
  user_id      uuid not null default auth.uid()
               references auth.users(id) on delete cascade,

  -- KAKSOISKAPPALEIDEN ESTO KANNASSA ASTI.
  --
  -- Sama hälytys tuottaa saman avaimen. Toistuvasti ajettu
  -- taustatarkistus ei voi luoda toista riviä edes silloin kun
  -- sovelluksen oma tarkistus pettäisi.
  notice_key   text not null,

  kind         text not null,
  level        text not null default 'info',
  status       text not null default 'unread',

  title        text not null,
  reason       text,

  -- EI VIERASAVAIN. Ilmoitus on tietue siitä että asiasta kerrottiin.
  target_type  text,
  target_id    text,

  created_date date not null default (now() at time zone 'UTC')::date,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

alter table public.notices
  add constraint notices_kind_check
  check (kind in ('reminder', 'overdue', 'leave_now', 'conflict',
                  'goal_risk', 'proposal', 'bill_due', 'savings', 'replan'));

alter table public.notices
  add constraint notices_level_check
  check (level in ('info', 'warning', 'urgent'));

alter table public.notices
  add constraint notices_status_check
  check (status in ('unread', 'read', 'acted', 'dismissed'));

alter table public.notices
  add constraint notices_title_check
  check (length(btrim(title)) > 0 and length(title) <= 200);

alter table public.notices
  add constraint notices_target_pair_check
  check ((target_type is null and target_id is null)
      or (target_type is not null and target_id is not null));

alter table public.notices
  add constraint notices_owner_row_key unique (user_id, id);

-- YKSI AVAIN KÄYTTÄJÄÄ KOHTI. Tämä on se rajoite, joka tekee
-- kaksoiskappaleiden estosta rakenteellisen eikä sovelluslogiikkaa.
alter table public.notices
  add constraint notices_key_unique unique (user_id, notice_key);

create index notices_user_status_idx
  on public.notices (user_id, status);

create index notices_user_created_idx
  on public.notices (user_id, created_date desc);

alter table public.notices enable row level security;

create policy notices_select_own on public.notices
  for select to authenticated using (auth.uid() = user_id);
create policy notices_insert_own on public.notices
  for insert to authenticated with check (auth.uid() = user_id);
create policy notices_update_own on public.notices
  for update to authenticated using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
create policy notices_delete_own on public.notices
  for delete to authenticated using (auth.uid() = user_id);

revoke all on public.notices from public;
revoke all on public.notices from anon;
revoke all on public.notices from authenticated;
grant select, insert, update, delete on public.notices to authenticated;

create trigger notices_touch_updated_at
  before update on public.notices
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------
-- VAIHE 4: travel_plans
--
-- ⚠ TÄSSÄ EI OLE KOORDINAATTEJA, EIKÄ NIITÄ SAA LISÄTÄ ⚠
--
-- `origin` ja `destination` ovat käyttäjän kirjoittamia NIMIÄ.
-- Koordinaatti kannassa on koordinaatti varmuuskopiossa, viennissä ja
-- mahdollisessa vuodossa. Sijaintihistoria kertoo missä ihminen asuu,
-- työskentelee ja käy — eikä lähtöajan laskenta tarvitse siitä mitään.
-- ---------------------------------------------------------------------

create table public.travel_plans (
  id                     text primary key,
  user_id                uuid not null default auth.uid()
                         references auth.users(id) on delete cascade,

  title                  text not null,

  -- NIMIÄ, EI KOORDINAATTEJA.
  origin                 text,
  destination            text,

  arrival_date           date,
  arrival_time           time,

  -- driving | transit | walking | cycling | other
  mode                   text not null default 'driving',

  -- NULL TARKOITTAA TUNTEMATONTA, EI NOLLAA. Nolla tarkoittaisi että
  -- ollaan jo perillä, ja siitä laskettu lähtöaika olisi vale.
  travel_minutes         integer,
  -- manual | provider | unknown
  travel_source          text not null default 'unknown',
  estimated_at           timestamptz,

  preparation_minutes    integer not null default 10,
  arrival_buffer_minutes integer not null default 5,

  -- Yhdistelmävierasavain tehtävään. Poisto katkaisee liitoksen,
  -- ei vie matkasuunnitelmaa.
  task_id                text,

  note                   text,

  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

alter table public.travel_plans
  add constraint travel_plans_mode_check
  check (mode in ('driving', 'transit', 'walking', 'cycling', 'other'));

alter table public.travel_plans
  add constraint travel_plans_source_check
  check (travel_source in ('manual', 'provider', 'unknown'));

alter table public.travel_plans
  add constraint travel_plans_title_check
  check (length(btrim(title)) > 0 and length(title) <= 200);

alter table public.travel_plans
  add constraint travel_plans_minutes_check
  check (travel_minutes is null or (travel_minutes > 0 and travel_minutes <= 1440));

alter table public.travel_plans
  add constraint travel_plans_buffer_check
  check (preparation_minutes >= 0 and preparation_minutes <= 480
     and arrival_buffer_minutes >= 0 and arrival_buffer_minutes <= 480);

-- TUNTEMATON KESTO EI SAA VÄITTÄÄ OLEVANSA MITATTU.
--
-- Jos kestoa ei ole, ainoa sallittu lähde on 'unknown'. Muuten
-- käyttöliittymä näyttäisi puuttuvan arvion kirjattuna ja laskisi
-- lähtöajan nollasta.
alter table public.travel_plans
  add constraint travel_plans_unknown_source_check
  check (travel_minutes is not null or travel_source = 'unknown');

alter table public.travel_plans
  add constraint travel_plans_owner_row_key unique (user_id, id);

alter table public.travel_plans
  add constraint travel_plans_task_fkey
  foreign key (user_id, task_id) references public.tasks (user_id, id)
  on delete set null (task_id);

create index travel_plans_user_arrival_idx
  on public.travel_plans (user_id, arrival_date, arrival_time);

alter table public.travel_plans enable row level security;

create policy travel_plans_select_own on public.travel_plans
  for select to authenticated using (auth.uid() = user_id);
create policy travel_plans_insert_own on public.travel_plans
  for insert to authenticated with check (auth.uid() = user_id);
create policy travel_plans_update_own on public.travel_plans
  for update to authenticated using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
create policy travel_plans_delete_own on public.travel_plans
  for delete to authenticated using (auth.uid() = user_id);

revoke all on public.travel_plans from public;
revoke all on public.travel_plans from anon;
revoke all on public.travel_plans from authenticated;
grant select, insert, update, delete on public.travel_plans to authenticated;

create trigger travel_plans_touch_updated_at
  before update on public.travel_plans
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------
-- VAIHE 5: location_rules
--
-- SÄÄNTÖ EI OLE TOTEUTUS. Geoaitaa ei ole eikä sitä voi luvata ilman
-- laitehyväksyntää. Sääntö on dataa, jota voidaan mallintaa ja testata
-- simuloiduilla sijainneilla.
--
-- `active` on oletuksena EPÄTOSI: sijainti vaatii luvan, eikä lupaa
-- oleteta.
-- ---------------------------------------------------------------------

create table public.location_rules (
  id           text primary key,
  user_id      uuid not null default auth.uid()
               references auth.users(id) on delete cascade,

  -- NIMI, EI KOORDINAATTI.
  place        text not null,

  -- arriving | leaving | nearby
  trigger_type text not null default 'arriving',

  message      text,

  active       boolean not null default false,

  task_id      text,

  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

alter table public.location_rules
  add constraint location_rules_trigger_check
  check (trigger_type in ('arriving', 'leaving', 'nearby'));

alter table public.location_rules
  add constraint location_rules_place_check
  check (length(btrim(place)) > 0 and length(place) <= 200);

alter table public.location_rules
  add constraint location_rules_owner_row_key unique (user_id, id);

alter table public.location_rules
  add constraint location_rules_task_fkey
  foreign key (user_id, task_id) references public.tasks (user_id, id)
  on delete set null (task_id);

create index location_rules_user_active_idx
  on public.location_rules (user_id, active);

alter table public.location_rules enable row level security;

create policy location_rules_select_own on public.location_rules
  for select to authenticated using (auth.uid() = user_id);
create policy location_rules_insert_own on public.location_rules
  for insert to authenticated with check (auth.uid() = user_id);
create policy location_rules_update_own on public.location_rules
  for update to authenticated using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
create policy location_rules_delete_own on public.location_rules
  for delete to authenticated using (auth.uid() = user_id);

revoke all on public.location_rules from public;
revoke all on public.location_rules from anon;
revoke all on public.location_rules from authenticated;
grant select, insert, update, delete on public.location_rules to authenticated;

create trigger location_rules_touch_updated_at
  before update on public.location_rules
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------
-- VAIHE 6: invarianttien todistus ENNEN COMMITTIA
-- ---------------------------------------------------------------------

do $$
declare
  n integer;
begin
  select count(*) into n from pg_policies
   where schemaname = 'public'
     and tablename in ('inbox_items', 'reminders', 'notices',
                       'travel_plans', 'location_rules');
  if n <> 20 then
    raise exception 'Odotettiin 20 politiikkaa, loytyi %.', n;
  end if;

  select count(*) into n from pg_class
   where relnamespace = 'public'::regnamespace
     and relname in ('inbox_items', 'reminders', 'notices',
                     'travel_plans', 'location_rules')
     and relrowsecurity;
  if n <> 5 then
    raise exception 'RLS ei ole paalla kaikissa viidessa uudessa taulussa.';
  end if;

  -- POISTOSAANTO RAJAA NOLLAUKSEN SARAKKEESEEN.
  select count(*) into n from pg_constraint
   where conname in ('travel_plans_task_fkey', 'location_rules_task_fkey')
     and confdeltype = 'n'
     and array_length(confdelsetcols, 1) = 1;
  if n <> 2 then
    raise exception 'Poistosaanto ei rajaa nollausta sarakkeeseen. Tehtavan poisto kaatuisi.';
  end if;

  -- KAKSOISKAPPALEIDEN ESTO ON RAKENTEELLINEN.
  if not exists (
    select 1 from pg_constraint
     where conname = 'notices_key_unique' and contype = 'u'
  ) then
    raise exception 'notices_key_unique puuttuu. Kaksoiskappaleiden esto ei ole rakenteellinen.';
  end if;

  -- PUBLIC-ROOLIN OIKEUDET LUETAAN SUORAAN ACL:STA.
  --
  -- role_table_grants ei nayta PUBLIC-roolille myonnettya oikeutta
  -- sellaisenaan. aclexplode on ainoa tapa nahda PUBLIC (grantee = 0).
  select count(*) into n
    from pg_class c,
         lateral aclexplode(c.relacl) a
   where c.relnamespace = 'public'::regnamespace
     and c.relname in ('inbox_items', 'reminders', 'notices',
                       'travel_plans', 'location_rules')
     and a.grantee = 0;
  if n <> 0 then
    raise exception 'PUBLIC-roolilla on % oikeutta uusiin tauluihin.', n;
  end if;

  -- TEHOLLISET OIKEUDET.
  if has_table_privilege('anon', 'public.inbox_items', 'select')
     or has_table_privilege('anon', 'public.reminders', 'select')
     or has_table_privilege('anon', 'public.notices', 'select')
     or has_table_privilege('anon', 'public.travel_plans', 'select')
     or has_table_privilege('anon', 'public.location_rules', 'select') then
    raise exception 'anon-roolilla on lukuoikeus uusiin tauluihin.';
  end if;

  if not has_table_privilege('authenticated', 'public.inbox_items', 'select')
     or not has_table_privilege('authenticated', 'public.reminders', 'select') then
    raise exception 'authenticated-roolilta puuttuu lukuoikeus uusiin tauluihin.';
  end if;

  -- OLEMASSA OLEVAT TAULUT OVAT KOSKEMATTOMIA.
  --
  -- Tama migraatio ei muuta niita, ja se todistetaan tassa: politiikkojen
  -- maara on sama kuin ennen.
  select count(*) into n from pg_policies
   where schemaname = 'public' and tablename in ('tasks', 'goals', 'projects');
  if n <> 12 then
    raise exception 'Olemassa olevien taulujen politiikat muuttuivat: % (odotus 12).', n;
  end if;

  raise notice 'Migraatio 0011 valmis. Aja seuraavaksi supabase/verify/verify_0011.sql.';
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
--   5. supabase/verify/verify_0011.sql
--
-- ESITARKISTUS (vain lukeva, turvallinen ajaa milloin tahansa):
--
--   select
--     (select count(*) from pg_tables
--       where schemaname='public'
--         and tablename in ('inbox_items','reminders','notices',
--                           'travel_plans','location_rules')) as uudet_taulut,
--     (select count(*) from pg_constraint
--       where conname='tasks_owner_row_key') as tasks_omistajan_avain,
--     (select current_setting('server_version_num')::int >= 150000) as pg15_tai_uudempi,
--     (select count(*) from public.tasks) as tehtavia;
--
--   Odotus ennen ajoa: 0, 1, true, <n>
--
--   JOS `tasks_omistajan_avain` EI OLE 1: älä aja. Vierasavainta ei voi luoda.
--   JOS `pg15_tai_uudempi` EI OLE true: älä aja. Sarakelista ei toimi.
--
-- =====================================================================
-- VAIKUTUS OLEMASSA OLEVAAN DATAAN
-- =====================================================================
--
--   EI MITÄÄN.
--
-- Viisi uutta tyhjää taulua. Yhtäkään olemassa olevaa saraketta,
-- rajoitetta, indeksiä tai riviä ei muuteta. Yhtään riviä ei poisteta.
--
-- Tämä on tietoinen ero migraatioon 0010, joka muutti kolmea taulua
-- joissa on käyttäjän dataa. Vaihe 6 todistaa koskemattomuuden ennen
-- committia.
--
-- =====================================================================
-- ROLLBACK
-- =====================================================================
--
--   begin;
--   set local lock_timeout = '5s';
--
--   drop table public.location_rules;
--   drop table public.travel_plans;
--   drop table public.notices;
--   drop table public.reminders;
--   drop table public.inbox_items;
--
--   commit;
--
-- Peruutus on tässä poikkeuksellisen yksinkertainen, koska migraatio ei
-- koskenut olemassa olevaan dataan: taulujen pudottaminen palauttaa
-- kannan täsmälleen edeltävään tilaan.
--
-- HUOM. Peruutus POISTAA rivit pysyvästi. Jos portit on ehditty avata ja
-- käyttäjä on kirjannut saapuvia tai muistutuksia, ne katoavat. Sulje
-- portit ensin ja ota varmuuskopio.
--
-- Muista tällöin myös:
--   src/data/schema.js -> TABLES.inboxItems    = false
--                         TABLES.reminders     = false
--                         TABLES.notices       = false
--                         TABLES.travelPlans   = false
--                         TABLES.locationRules = false
--
-- =====================================================================
-- RISKIT
-- =====================================================================
--
--   MATALA   viisi uutta taulua -- eivät koske olemassa olevaan dataan
--   MATALA   lukitus: vain auth.users ja tasks vierasavaimen luonnin
--            ajaksi, ei ALTER TABLE olemassa oleviin tauluihin
--   MATALA   peruutus on taulujen pudotus, ei rakenteen palautus
--
-- Ajon kesto on käytännössä välitön: kaikki viisi taulua ovat tyhjiä.
--
-- Tämä on selvästi vähemmän vaarallinen kuin migraatio 0010, ja se on
-- syytä sanoa ääneen: kaikki migraatiot eivät ole yhtä riskialttiita,
-- eikä sama varovaisuus sovi jokaiseen.
