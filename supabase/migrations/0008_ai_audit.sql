-- =====================================================================
-- Manifestival — migraatio 0008: AI-toimintojen kirjausketju
-- =====================================================================
--
-- TILA: EI AJETTU TUOTANTOON.
--
-- ESIEHDOT
--   1. Migraatio 0001 on ajettu ja todennettu (user_id, RLS)
--   2. Varmuuskopio on otettu
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
-- KÄYTTÖÖNOTTO KOODISSA
-- Migraation jälkeen: src/data/schema.js -> TABLES.aiAudit = true.
--
-- MIKSI TÄMÄ ON TURVALLINEN
-- Migraatio luo yhden uuden taulun eikä koske olemassa olevaan dataan.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- VAIHE 0: esiehdon tarkistus
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'tasks' and column_name = 'user_id'
  ) then
    raise exception 'Migraatio 0001 pitaa ajaa ensin: tasks.user_id puuttuu.';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- VAIHE 1: ai_action_audit
-- ---------------------------------------------------------------------
create table if not exists public.ai_action_audit (
  id             text primary key,
  user_id        uuid not null default auth.uid()
                 references auth.users(id) on delete cascade,

  occurred_at    timestamptz not null default now(),

  -- LYHENNETTY tiivistelmä, ei raaka syöte. Pituusrajoite on alempana.
  input_summary  text,

  intent         text not null,
  risk           text not null,
  target_type    text,

  -- Kohteen tunniste ilman vierasavainta: kohde on voitu poistaa, ja
  -- kirjaus siitä on nimenomaan se, mitä halutaan säilyttää.
  target_id      text,

  proposal       text,
  confirmed      boolean not null default false,
  executed       boolean not null default false,
  result         text not null default 'proposed',
  error_code     text,

  created_at     timestamptz not null default now()
);

alter table public.ai_action_audit
  drop constraint if exists ai_action_audit_result_check;
alter table public.ai_action_audit
  add constraint ai_action_audit_result_check
  check (result in ('proposed', 'cancelled', 'executed', 'failed', 'ambiguous', 'rejected'));

alter table public.ai_action_audit
  drop constraint if exists ai_action_audit_risk_check;
alter table public.ai_action_audit
  add constraint ai_action_audit_risk_check
  check (risk in ('low', 'medium', 'high'));

-- Pituusrajoite on tässä eikä pelkästään sovelluksessa: sovellusvirhe ei
-- saa johtaa siihen, että koko päiväkirjamerkintä päätyy tietokantaan.
alter table public.ai_action_audit
  drop constraint if exists ai_action_audit_summary_length_check;
alter table public.ai_action_audit
  add constraint ai_action_audit_summary_length_check
  check (input_summary is null or length(input_summary) <= 200);

alter table public.ai_action_audit
  drop constraint if exists ai_action_audit_proposal_length_check;
alter table public.ai_action_audit
  add constraint ai_action_audit_proposal_length_check
  check (proposal is null or length(proposal) <= 300);

-- KESKEINEN INVARIANTTI: suoritettu komento ilman vahvistusta olisi merkki
-- turvamallin rikkoutumisesta. Kirjaus ei saa väittää sellaista tapahtuneen.
alter table public.ai_action_audit
  drop constraint if exists ai_action_audit_confirmed_check;
alter table public.ai_action_audit
  add constraint ai_action_audit_confirmed_check
  check (executed = false or confirmed = true);

create index if not exists ai_action_audit_user_time_idx
  on public.ai_action_audit (user_id, occurred_at desc);

-- ---------------------------------------------------------------------
-- VAIHE 2: RLS
-- ---------------------------------------------------------------------
alter table public.ai_action_audit enable row level security;

drop policy if exists ai_action_audit_select_own on public.ai_action_audit;
drop policy if exists ai_action_audit_insert_own on public.ai_action_audit;
drop policy if exists ai_action_audit_update_own on public.ai_action_audit;
drop policy if exists ai_action_audit_delete_own on public.ai_action_audit;

create policy ai_action_audit_select_own on public.ai_action_audit
  for select to authenticated using (auth.uid() = user_id);
create policy ai_action_audit_insert_own on public.ai_action_audit
  for insert to authenticated with check (auth.uid() = user_id);
create policy ai_action_audit_update_own on public.ai_action_audit
  for update to authenticated using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
create policy ai_action_audit_delete_own on public.ai_action_audit
  for delete to authenticated using (auth.uid() = user_id);

revoke all on public.ai_action_audit from anon;
grant select, insert, update, delete on public.ai_action_audit to authenticated;

commit;

-- =====================================================================
-- VARMISTUS MIGRAATION JÄLKEEN (aja erikseen, vain luku)
-- =====================================================================
-- select tablename, rowsecurity from pg_tables
--  where schemaname='public' and tablename='ai_action_audit';
--   -> true
--
-- Invariantin tarkistus: seuraavan pitää EPÄONNISTUA rajoitteeseen.
--   insert into public.ai_action_audit (id, intent, risk, executed, confirmed)
--   values ('testi', 'create_task', 'medium', true, false);
--   -> odotettu virhe: ai_action_audit_confirmed_check
--
-- =====================================================================
-- ROLLBACK
-- =====================================================================
--   begin;
--   drop table if exists public.ai_action_audit;
--   commit;
--
-- Muista tällöin palauttaa src/data/schema.js -> TABLES.aiAudit = false.
