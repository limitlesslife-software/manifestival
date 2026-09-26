-- =====================================================================
-- Manifestival — looginen tilannekuva, tila 0010 (VAIN LUKU)
-- =====================================================================
--
-- GENEROITU: node tools/activation/build-snapshots.mjs. ÄLÄ MUOKKAA
-- KÄSIN — testi vertaa tiedostoa generaattoriin.
--
-- TÄMÄ TIEDOSTO ON TILALLE 0010: migraatiot 0001–0010 ajettu, 0011 ei.
-- MILLOIN: 0010:n JÄLKEEN ennen kuin mitään peruutetaan:
--          ennen aallon G revertiä aaltoon F, ennen 0010:n
--          ROLLBACK-osiota ja ennen minkä tahansa palautuksen ajoa
--          (nykytila talteen). Ennen migraatiota 0011 samoin.
--
-- Ohje: docs/activation/0010-BACKUP-AND-RECOVERY.md
--
-- YKSI lause, VAIN LUKU: mitään ei luoda, muuteta eikä poisteta.
-- Koko tulos tulee yhdestä MVCC-tilannekuvasta (ei repeytymistä).
-- auth-skeemasta luetaan vain omistajan olemassaolo ja käyttäjien
-- lukumäärä — ei sähköposteja, ei salasanoja, ei tunnisteita.
-- Taulut (15):
--   tasks, profile, routines, routine_exceptions, goals, projects,
--   notification_preferences, wellbeing_entries, recurring_expenses,
--   bills, savings_goals, ai_action_audit, transactions, investments,
--   milestones
--
-- Jos ajo kaatuu virheeseen "relation ... does not exist", kanta on
-- eri tilassa kuin tiedoston nimi: aja tilan mukainen tiedosto.
-- `check` varoittaa, jos kannassa on tauluja, joita tämä ei kata.
--
-- SISÄLTÄÄ HENKILÖTIETOJA (otsikot, muistiinpanot, profiili, summat).
-- Tulosta EI liitetä chattiin, issueen, committiin eikä pilveen.
--
-- MITÄ TEET TULOKSELLA
--
--   1. Tulostaulukossa on rivi 00 (MANIFEST) ja yksi rivi per taulu.
--   2. Vie KOKO tulos tiedostoksi (CSV tai JSON). Älä kopioi soluja
--      käsin: solu voi katketa, ja tiiviste hylkää katkenneen kopion.
--   3. Tallenna tiedosto projektin hakemistoon .local-backups/db/.
--   4. node tools/activation/restore-snapshot.mjs check <tiedosto> --save
--      -> "TILANNEKUVA KUNNOSSA". Mikä tahansa muu = ota kuva uudelleen.

with
dump as (
  select 'ai_action_audit'::text as t, count(*)::bigint as n,
         coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text), '[]'::jsonb)::text as payload
    from public.ai_action_audit x
  union all
  select 'bills'::text as t, count(*)::bigint as n,
         coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text), '[]'::jsonb)::text as payload
    from public.bills x
  union all
  select 'goals'::text as t, count(*)::bigint as n,
         coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text), '[]'::jsonb)::text as payload
    from public.goals x
  union all
  select 'investments'::text as t, count(*)::bigint as n,
         coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text), '[]'::jsonb)::text as payload
    from public.investments x
  union all
  select 'milestones'::text as t, count(*)::bigint as n,
         coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text), '[]'::jsonb)::text as payload
    from public.milestones x
  union all
  select 'notification_preferences'::text as t, count(*)::bigint as n,
         coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text), '[]'::jsonb)::text as payload
    from public.notification_preferences x
  union all
  select 'profile'::text as t, count(*)::bigint as n,
         coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text), '[]'::jsonb)::text as payload
    from public.profile x
  union all
  select 'projects'::text as t, count(*)::bigint as n,
         coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text), '[]'::jsonb)::text as payload
    from public.projects x
  union all
  select 'recurring_expenses'::text as t, count(*)::bigint as n,
         coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text), '[]'::jsonb)::text as payload
    from public.recurring_expenses x
  union all
  select 'routine_exceptions'::text as t, count(*)::bigint as n,
         coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text), '[]'::jsonb)::text as payload
    from public.routine_exceptions x
  union all
  select 'routines'::text as t, count(*)::bigint as n,
         coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text), '[]'::jsonb)::text as payload
    from public.routines x
  union all
  select 'savings_goals'::text as t, count(*)::bigint as n,
         coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text), '[]'::jsonb)::text as payload
    from public.savings_goals x
  union all
  select 'tasks'::text as t, count(*)::bigint as n,
         coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text), '[]'::jsonb)::text as payload
    from public.tasks x
  union all
  select 'transactions'::text as t, count(*)::bigint as n,
         coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text), '[]'::jsonb)::text as payload
    from public.transactions x
  union all
  select 'wellbeing_entries'::text as t, count(*)::bigint as n,
         coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text), '[]'::jsonb)::text as payload
    from public.wellbeing_entries x
),
tabs as (
  select c.oid as reloid, c.relname::text as t, c.relowner, c.relrowsecurity, c.relforcerowsecurity
    from pg_class c
   where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
     and c.relname in ('ai_action_audit', 'bills', 'goals', 'investments', 'milestones', 'notification_preferences', 'profile', 'projects', 'recurring_expenses', 'routine_exceptions', 'routines', 'savings_goals', 'tasks', 'transactions', 'wellbeing_entries')
),
cols as (
  select a.attrelid as reloid,
         jsonb_agg(jsonb_build_array(a.attname::text, format_type(a.atttypid, a.atttypmod),
                                     a.attnotnull, a.attgenerated <> '') order by a.attnum) as cols
    from pg_attribute a join tabs tb on tb.reloid = a.attrelid
   where a.attnum > 0 and not a.attisdropped
   group by a.attrelid
),
keys as (
  select con.conrelid as reloid, con.contype::text as kind, con.conname::text as name,
         (select n.nspname::text || '.' || rc.relname::text
            from pg_class rc join pg_namespace n on n.oid = rc.relnamespace
           where rc.oid = con.confrelid) as ref,
         (select jsonb_agg(a.attname::text order by k.ord)
            from unnest(con.conkey) with ordinality k(attnum, ord)
            join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum) as cols,
         (select jsonb_agg(a.attname::text order by k.ord)
            from unnest(con.confkey) with ordinality k(attnum, ord)
            join pg_attribute a on a.attrelid = con.confrelid and a.attnum = k.attnum) as refcols
    from pg_constraint con join tabs tb on tb.reloid = con.conrelid
   where con.contype in ('p', 'f')
),
trg as (
  select tg.tgrelid as reloid, jsonb_agg(tg.tgname::text order by tg.tgname) as names
    from pg_trigger tg join tabs tb on tb.reloid = tg.tgrelid
   where not tg.tgisinternal
   group by tg.tgrelid
),
manifest as (
  select jsonb_build_object(
    'format', 'mv-snapshot-v1',
    'state', '0010',
    'db', current_database(),
    'server', current_setting('server_version'),
    'at', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'timezone', current_setting('TimeZone'),
    'role', current_user,
    'superuser', (select r.rolsuper from pg_roles r where r.rolname = current_user),
    'bypassrls', (select r.rolbypassrls from pg_roles r where r.rolname = current_user),
    'owner', '2cc00622-f927-4604-a518-361a4328481b',
    'ownerPresent', exists (select 1 from auth.users u where u.id = '2cc00622-f927-4604-a518-361a4328481b'::uuid),
    'authUsers', (select count(*) from auth.users),
    'publicTables', (select coalesce(jsonb_agg(c.relname::text order by c.relname), '[]'::jsonb)
                       from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'),
    'tables', (select jsonb_object_agg(d.t, jsonb_build_object(
        'rows', d.n, 'md5', md5(d.payload), 'bytes', octet_length(d.payload),
        'cols', c.cols,
        'pk', (select k.cols from keys k where k.reloid = tb.reloid and k.kind = 'p'),
        'fks', coalesce((select jsonb_agg(jsonb_build_object('name', k.name, 'ref', k.ref,
                                                             'cols', k.cols, 'refCols', k.refcols) order by k.name)
                           from keys k where k.reloid = tb.reloid and k.kind = 'f'), '[]'::jsonb),
        'triggers', coalesce(tr.names, '[]'::jsonb),
        'tableOwner', pg_get_userbyid(tb.relowner),
        'rls', tb.relrowsecurity, 'forceRls', tb.relforcerowsecurity))
      from dump d join tabs tb on tb.t = d.t join cols c on c.reloid = tb.reloid
      left join trg tr on tr.reloid = tb.reloid)
  )::text as m
)
select '00'::text as nro, 'MANIFEST'::text as taulu, null::bigint as rivit, md5(m) as tiiviste, m as sisalto
  from manifest
union all
select lpad((row_number() over (order by d.t collate "C"))::text, 2, '0'), d.t, d.n, md5(d.payload), d.payload
  from dump d
order by 1;
