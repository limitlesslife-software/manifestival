-- Supabase-yhteensopiva perusta paikalliselle PostgreSQL:lle.
--
-- VAIN PAIKALLISEEN, KERTAKÄYTTÖISEEN TESTIKANTAAN. Ei koskaan tuotantoon.
--
-- Mitä tämä jäljittelee Supabasesta ja miksi:
--
--   roolit      anon, authenticated, service_role, authenticator — samat
--               nimet ja attribuutit kuin Supabasessa (service_role ohittaa
--               RLS:n, muut eivät).
--   auth.users  vain sarakkeet, joihin migraatiot viittaavat (id). Oikean
--               taulun muut sarakkeet eivät vaikuta vierasavaimiin eikä RLS:ään.
--   auth.uid()  sama määrittely kuin Supabasessa: lukee JWT:n sub-väitteen
--               asetuksesta request.jwt.claim.sub tai request.jwt.claims.
--               PostgREST asettaa saman asetuksen jokaiselle pyynnölle.
--   oletus-     Supabase antaa public-skeeman uusille tauluille ALL-oikeudet
--   oikeudet    rooleille anon, authenticated ja service_role. Juuri siksi
--               migraatiot revokoivat ne erikseen — ja juuri siksi tämä
--               jäljitellään: ilman sitä revoke-lauseiden puuttuminen ei
--               näkyisi testissä.
--
-- Mitä EI jäljitellä (tunnettu ero, raportoidaan):
--
--   * PostgREST-kerros (HTTP, JSON-muunnos, select=*-rajaukset).
--   * Supabasen postgres-rooli ei ole oikea superuser; täällä migraatiot
--     ajetaan superuserina. Migraatiot eivät luota superuser-oikeuksiin
--     (ne tarkistetaan erikseen tools/pg-rehearsal/README.md).
--   * GoTrue (kirjautuminen, tokenien voimassaolo).

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then
    create role authenticator login noinherit;
  end if;
end $$;

grant anon, authenticated, service_role to authenticator;

create schema if not exists auth;
create schema if not exists extensions;

create table if not exists auth.users (
  id         uuid primary key,
  email      text,
  created_at timestamptz not null default now()
);

create or replace function auth.uid() returns uuid
language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

create or replace function auth.role() returns text
language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$$;

create or replace function auth.jwt() returns jsonb
language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')
  )::jsonb
$$;

grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid(), auth.role(), auth.jwt()
  to anon, authenticated, service_role;

grant usage on schema public to anon, authenticated, service_role;
grant usage on schema extensions to anon, authenticated, service_role;

alter default privileges in schema public
  grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public
  grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public
  grant all on functions to anon, authenticated, service_role;
