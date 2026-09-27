-- =====================================================================
-- Manifestival — looginen tilannekuva, tila 0015 (VAIN LUKU)
-- =====================================================================
--
-- GENEROITU: node tools/activation/build-snapshots.mjs. ÄLÄ MUOKKAA
-- KÄSIN — testi vertaa tiedostoa generaattoriin.
--
-- TÄMÄ TIEDOSTO ON TILALLE 0015: migraatiot 0001–0015 ajettu.
-- MILLOIN: ennen mitä tahansa peruutusta tai palautusta tilassa 0015
--          (migraatiot 0001–0015 ajettu), esim. ennen aallon L
--          revertiä tai migraation 0015 ROLLBACK-osiota
--          (docs/MIGRATION-0015-RECOVERY.md).
--
-- Ohje: docs/activation/0010-BACKUP-AND-RECOVERY.md
--
-- YKSI lause, VAIN LUKU: mitään ei luoda, muuteta eikä poisteta.
-- Koko tulos tulee yhdestä MVCC-tilannekuvasta (ei repeytymistä).
-- auth-skeemasta luetaan vain omistajan olemassaolo ja käyttäjien
-- lukumäärä — ei sähköposteja, ei salasanoja, ei tunnisteita.
-- Taulut (38):
--   tasks, profile, routines, routine_exceptions, goals, projects,
--   notification_preferences, wellbeing_entries, recurring_expenses,
--   bills, savings_goals, ai_action_audit, transactions, investments,
--   milestones, inbox_items, reminders, notices, travel_plans,
--   location_rules, life_areas, weekly_capacities, time_entries,
--   alignment_reviews, running_timers, alignment_item_settings,
--   saved_places, place_aliases, calendar_events,
--   commute_observations, life_settings, sleep_logs, habit_plans,
--   habit_events, exercise_sessions, wellbeing_checkins,
--   protected_periods, weekly_plans
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
  select 'alignment_item_settings'::text as t, count(*)::bigint as n,
         coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text), '[]'::jsonb)::text as payload
    from public.alignment_item_settings x
  union all
  select 'alignment_reviews'::text as t, count(*)::bigint as n,
         coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text), '[]'::jsonb)::text as payload
    from public.alignment_reviews x
  union all
  select 'bills'::text as t, count(*)::bigint as n,
         coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text), '[]'::jsonb)::text as payload
    from public.bills x
  union all
  select 'calendar_events'::text as t, count(*)::bigint as n,
         coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text), '[]'::jsonb)::text as payload
    from public.calendar_events x
  union all
  select 'commute_observations'::text as t, count(*)::bigint as n,
         coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text), '[]'::jsonb)::text as payload
    from public.commute_observations x
  union all
  select 'exercise_sessions'::text as t, count(*)::bigint as n,
         coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text), '[]'::jsonb)::text as payload
    from public.exercise_sessions x
  union all
  select 'goals'::text as t, count(*)::bigint as n,
         coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text), '[]'::jsonb)::text as payload
    from public.goals x
  union all
  select 'habit_events'::text as t, count(*)::bigint as n,
         coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text), '[]'::jsonb)::text as payload
    from public.habit_events x
  union all
  select 'habit_plans'::text as t, count(*)::bigint as n,
         coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text), '[]'::jsonb)::text as payload
    from public.habit_plans x
  union all
  select 'inbox_items'::text as t, count(*)::bigint as n,
         coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text), '[]'::jsonb)::text as payload
    from public.inbox_items x
  union all
  select 'investments'::text as t, count(*)::bigint as n,
         coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text), '[]'::jsonb)::text as payload
    from public.investments x
  union all
  select 'life_areas'::text as t, count(*)::bigint as n,
         coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text), '[]'::jsonb)::text as payload
    from public.life_areas x
  union all
  select 'life_settings'::text as t, count(*)::bigint as n,
         coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text), '[]'::jsonb)::text as payload
    from public.life_settings x
  union all
  select 'location_rules'::text as t, count(*)::bigint as n,
         coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text), '[]'::jsonb)::text as payload
    from public.location_rules x
  union all
  select 'milestones'::text as t, count(*)::bigint as n,
         coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text), '[]'::jsonb)::text as payload
    from public.milestones x
  union all
  select 'notices'::text as t, count(*)::bigint as n,
         coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text), '[]'::jsonb)::text as payload
    from public.notices x
  union all
  select 'notification_preferences'::text as t, count(*)::bigint as n,
         coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text), '[]'::jsonb)::text as payload
    from public.notification_preferences x
  union all
  select 'place_aliases'::text as t, count(*)::bigint as n,
         coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text), '[]'::jsonb)::text as payload
    from public.place_aliases x
  union all
  select 'profile'::text as t, count(*)::bigint as n,
         coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text), '[]'::jsonb)::text as payload
    from public.profile x
  union all
  select 'projects'::text as t, count(*)::bigint as n,
         coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text), '[]'::jsonb)::text as payload
    from public.projects x
  union all
  select 'protected_periods'::text as t, count(*)::bigint as n,
         coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text), '[]'::jsonb)::text as payload
    from public.protected_periods x
  union all
  select 'recurring_expenses'::text as t, count(*)::bigint as n,
         coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text), '[]'::jsonb)::text as payload
    from public.recurring_expenses x
  union all
  select 'reminders'::text as t, count(*)::bigint as n,
         coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text), '[]'::jsonb)::text as payload
    from public.reminders x
  union all
  select 'routine_exceptions'::text as t, count(*)::bigint as n,
         coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text), '[]'::jsonb)::text as payload
    from public.routine_exceptions x
  union all
  select 'routines'::text as t, count(*)::bigint as n,
         coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text), '[]'::jsonb)::text as payload
    from public.routines x
  union all
  select 'running_timers'::text as t, count(*)::bigint as n,
         coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text), '[]'::jsonb)::text as payload
    from public.running_timers x
  union all
  select 'saved_places'::text as t, count(*)::bigint as n,
         coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text), '[]'::jsonb)::text as payload
    from public.saved_places x
  union all
  select 'savings_goals'::text as t, count(*)::bigint as n,
         coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text), '[]'::jsonb)::text as payload
    from public.savings_goals x
  union all
  select 'sleep_logs'::text as t, count(*)::bigint as n,
         coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text), '[]'::jsonb)::text as payload
    from public.sleep_logs x
  union all
  select 'tasks'::text as t, count(*)::bigint as n,
         coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text), '[]'::jsonb)::text as payload
    from public.tasks x
  union all
  select 'time_entries'::text as t, count(*)::bigint as n,
         coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text), '[]'::jsonb)::text as payload
    from public.time_entries x
  union all
  select 'transactions'::text as t, count(*)::bigint as n,
         coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text), '[]'::jsonb)::text as payload
    from public.transactions x
  union all
  select 'travel_plans'::text as t, count(*)::bigint as n,
         coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text), '[]'::jsonb)::text as payload
    from public.travel_plans x
  union all
  select 'weekly_capacities'::text as t, count(*)::bigint as n,
         coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text), '[]'::jsonb)::text as payload
    from public.weekly_capacities x
  union all
  select 'weekly_plans'::text as t, count(*)::bigint as n,
         coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text), '[]'::jsonb)::text as payload
    from public.weekly_plans x
  union all
  select 'wellbeing_checkins'::text as t, count(*)::bigint as n,
         coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text), '[]'::jsonb)::text as payload
    from public.wellbeing_checkins x
  union all
  select 'wellbeing_entries'::text as t, count(*)::bigint as n,
         coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text), '[]'::jsonb)::text as payload
    from public.wellbeing_entries x
),
tabs as (
  select c.oid as reloid, c.relname::text as t, c.relowner, c.relrowsecurity, c.relforcerowsecurity
    from pg_class c
   where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
     and c.relname in ('ai_action_audit', 'alignment_item_settings', 'alignment_reviews', 'bills', 'calendar_events', 'commute_observations', 'exercise_sessions', 'goals', 'habit_events', 'habit_plans', 'inbox_items', 'investments', 'life_areas', 'life_settings', 'location_rules', 'milestones', 'notices', 'notification_preferences', 'place_aliases', 'profile', 'projects', 'protected_periods', 'recurring_expenses', 'reminders', 'routine_exceptions', 'routines', 'running_timers', 'saved_places', 'savings_goals', 'sleep_logs', 'tasks', 'time_entries', 'transactions', 'travel_plans', 'weekly_capacities', 'weekly_plans', 'wellbeing_checkins', 'wellbeing_entries')
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
    'state', '0015',
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
        'rls', tb.relrowsecurity, 'forceRls', tb.relforcerowsecurity,
        'rlsFiltered', (tb.relrowsecurity
                        and not coalesce((select r.rolsuper or r.rolbypassrls from pg_roles r
                                           where r.rolname = current_user), false)
                        and (tb.relforcerowsecurity or not pg_has_role(current_user, tb.relowner, 'USAGE')))))
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
