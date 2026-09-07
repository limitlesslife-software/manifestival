-- Varmistus: 0005_notification_preferences
-- VAIN LUKEVA. Yksi lause, yksi taulukko, yksi kopiointi.
-- Aja heti migraation jalkeen.
--
-- ODOTUS: jokaisen PASS/FAIL-rivin status = 'PASS' ja
-- poikkeavia_yhteensa = 0. Yksikin FAIL tarkoittaa, ettei lippua
-- notificationPreferences saa kaantaa.
--
-- TAMAN TAULUN OMISTAJUUSMALLI ON ERI KUIN MUIDEN
-- Omistaja ei ole erillinen user_id-sarake vaan paaavain itse:
-- `id uuid primary key default auth.uid()`. Politiikat kohdistuvat
-- siksi id-sarakkeeseen, kuten profile-taulussa. Tarkistukset 08-11
-- todistavat, etta malli on juuri tama eika jotain siita puolittain.
--
-- Rakenne luetaan KATALOGEISTA, ei nimista.
--
-- Tama tiedosto EI lue kayttajan asetuksia arvoina, vain rakenteen ja
-- oletusarvot.

select c.check_no, c.section, c.check_name,
       case when c.odotus = 'INFO' then 'INFO'
            when c.toteutui = c.odotus then 'PASS' else 'FAIL' end as status,
       case when c.odotus = 'INFO' then c.toteutui
            else 'odotus ' || c.odotus || ', toteutui ' || c.toteutui end as details,
       count(*) filter (where c.odotus <> 'INFO' and c.toteutui <> c.odotus)
         over () as poikkeavia_yhteensa
from (

  -- ================================================================
  -- TAULU JA SARAKKEET
  -- ================================================================

  select '01' as check_no, 'taulut' as section,
         'Taulu notification_preferences on olemassa' as check_name,
         '1' as odotus,
         (select count(*)::text from pg_tables
           where schemaname = 'public'
             and tablename = 'notification_preferences') as toteutui

  union all
  select '02', 'taulut', 'Rakenteelliset sarakkeet ovat olemassa', '14',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'notification_preferences'
             and column_name in ('id', 'enabled', 'task_lead_minutes',
                                 'routine_lead_minutes', 'daily_plan_time',
                                 'evening_review_time', 'daily_plan_enabled',
                                 'evening_review_enabled',
                                 'deadline_warnings_enabled', 'max_per_day',
                                 'quiet_hours_from', 'quiet_hours_to',
                                 'created_at', 'updated_at'))

  union all
  -- Kokonaismaara yksin ei todista mitaan: se voisi tasmata, vaikka
  -- odotettu sarake puuttuisi ja tilalla olisi tuntematon.
  select '03', 'taulut', 'Taulussa ei ole nimeamattomia sarakkeita', '0',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'notification_preferences'
             and column_name not in ('id', 'enabled', 'task_lead_minutes',
                                     'routine_lead_minutes', 'daily_plan_time',
                                     'evening_review_time', 'daily_plan_enabled',
                                     'evening_review_enabled',
                                     'deadline_warnings_enabled', 'max_per_day',
                                     'quiet_hours_from', 'quiet_hours_to',
                                     'created_at', 'updated_at'))

  union all
  select '04', 'taulut', 'Taulussa on tasan 14 saraketta', '14',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'notification_preferences')

  union all
  -- HILJAISUUS ON OLETUS.
  --
  -- Jos enabled saisi oletukseksi true, jokainen uusi kayttaja alkaisi
  -- saada ilmoituksia pyytamatta. Se ei olisi virhe jonka kayttaja
  -- ilmoittaisi — se olisi syy poistaa sovellus.
  select '05', 'taulut', 'Sarakkeen enabled oletus on false', 'false',
         (select coalesce(column_default, 'PUUTTUU') from information_schema.columns
           where table_schema = 'public' and table_name = 'notification_preferences'
             and column_name = 'enabled')

  union all
  select '06', 'taulut', 'Kellonajat ovat text-tyyppisia paikallisina aikoina', '4',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'notification_preferences'
             and column_name in ('daily_plan_time', 'evening_review_time',
                                 'quiet_hours_from', 'quiet_hours_to')
             and data_type = 'text')

  union all
  select '07', 'rajoitteet', 'Kolme tarkistetta on olemassa', '3',
         (select count(*)::text from pg_constraint
           where conname in ('notification_preferences_lead_check',
                             'notification_preferences_max_per_day_check',
                             'notification_preferences_time_format_check')
             and contype = 'c')

  -- ================================================================
  -- OMISTAJUUSMALLI — PAAAVAIN ON OMISTAJA
  -- ================================================================

  union all
  select '08', 'omistajuus', 'Paaavain on id ja sen oletus on auth.uid()', '1',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'notification_preferences'
             and column_name = 'id' and udt_name = 'uuid'
             and column_default like '%auth.uid()%')

  union all
  select '09', 'omistajuus', 'Kayttajan poisto siivoaa asetukset', '1',
         (select count(*)::text
            from pg_constraint con
            join pg_class ft on ft.oid = con.confrelid
            join pg_namespace fn on fn.oid = ft.relnamespace
           where con.conrelid = 'public.notification_preferences'::regclass
             and con.contype = 'f'
             and fn.nspname = 'auth' and ft.relname = 'users'
             and con.confdeltype = 'c')

  union all
  -- Erillista user_id-saraketta EI saa olla. Jos se olisi, kannassa
  -- olisi kaksi omistajakasitetta, ja politiikat rajaisivat vain
  -- toista. Rivi voisi kuulua yhdelle ja nakya toiselle.
  select '10', 'omistajuus', 'Erillista user_id-saraketta ei ole', '0',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'notification_preferences'
             and column_name = 'user_id')

  union all
  -- Taulussa ei ole yhtaan viitetta sovellustauluihin. Tama on se
  -- vaite, jonka nojalla yhdistelmavierasavainta ei tarvita. Jos viite
  -- joskus lisataan, vaite vanhenee ja tama kaatuu.
  select '11', 'omistajuus', 'Taulussa ei ole viitteita sovellustauluihin', '0',
         (select count(*)::text
            from pg_constraint con
            join pg_class ft on ft.oid = con.confrelid
           where con.conrelid = 'public.notification_preferences'::regclass
             and con.contype = 'f'
             and ft.relnamespace = 'public'::regnamespace)

  -- ================================================================
  -- LIIPAISIN JA RLS
  -- ================================================================

  union all
  -- Ajoitus luetaan tgtype-biteista: 1 = rivikohtainen, 2 = before,
  -- 16 = update. Nimi ei kerro milloin liipaisin ajetaan.
  select '12', 'liipaisimet', 'updated_at paivittyy ennen rivin muutosta', '1',
         (select count(*)::text from pg_trigger
           where not tgisinternal
             and tgname = 'notification_preferences_touch_updated_at'
             and (tgtype & 1) = 1 and (tgtype & 2) = 2 and (tgtype & 16) = 16)

  union all
  select '13', 'liipaisimet', 'Funktio touch_updated_at on yha kovennettu', '1',
         (select count(*)::text from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'touch_updated_at'
             and p.prosecdef = false
             and p.proconfig is not null
             and exists (select 1 from unnest(p.proconfig) a
                          where a like 'search\_path=%'))

  union all
  select '14', 'rls', 'RLS on paalla', '1',
         (select count(*)::text from pg_class
           where relnamespace = 'public'::regnamespace
             and relname = 'notification_preferences' and relrowsecurity)

  union all
  -- Politiikan OLEMASSAOLO ei todista mitaan: `using (true)` nayttaisi
  -- luettelossa aivan samalta. Siksi ehdot luetaan ja verrataan — ja
  -- MOLEMMAT puolet, koska pelkka USING sallisi rivin kirjoittamisen
  -- toisen nimiin.
  --
  -- Ehto on `auth.uid()=id`, EI `auth.uid()=user_id`. Juuri tama erottaa
  -- taman taulun muista.
  select '15', 'rls', 'Nelja omistajuuspolitiikkaa oikein ehdoin (id, ei user_id)', '4',
         (select count(*)::text
            from pg_policies p
            join (values
                    ('notification_preferences_select_own', 'SELECT', 'auth.uid()=id', ''),
                    ('notification_preferences_insert_own', 'INSERT', '',              'auth.uid()=id'),
                    ('notification_preferences_update_own', 'UPDATE', 'auth.uid()=id', 'auth.uid()=id'),
                    ('notification_preferences_delete_own', 'DELETE', 'auth.uid()=id', '')
                 ) e(pol, operaatio, q, wc)
              on e.pol = p.policyname and e.operaatio = p.cmd
             and btrim(replace(coalesce(p.qual, ''), ' ', ''), '()') = e.q
             and btrim(replace(coalesce(p.with_check, ''), ' ', ''), '()') = e.wc
           where p.schemaname = 'public'
             and p.tablename = 'notification_preferences'
             and p.roles = '{authenticated}'::name[])

  union all
  select '16', 'rls', 'Taulussa ei ole ylimaaraisia politiikkoja', '4',
         (select count(*)::text from pg_policies
           where schemaname = 'public' and tablename = 'notification_preferences')

  -- ================================================================
  -- OIKEUDET
  -- ================================================================

  union all
  select '17', 'oikeudet', 'anon-roolilla ei ole tehollista oikeutta', '0',
         (select count(*)::text
            from (select unnest(array['select', 'insert', 'update', 'delete',
                                      'truncate', 'references', 'trigger']) as oikeus) pp
           where has_table_privilege('anon', 'public.notification_preferences', pp.oikeus))

  union all
  -- Kaksi menetelmaa, koska kumpikaan ei yksin riita: has_table_privilege
  -- kertoo ONKO oikeus (perinta mukaan lukien), aclexplode kertoo MISTA
  -- se tulee. PUBLICille myonnetty oikeus ei nay roolikohtaisissa
  -- listauksissa lainkaan.
  select '18', 'oikeudet', 'PUBLIC-roolilla ei ole oikeuksia', '0',
         (select count(*)::text
            from pg_class cl, aclexplode(cl.relacl) acl
           where cl.oid = 'public.notification_preferences'::regclass
             and acl.grantee = 0)

  union all
  select '19', 'oikeudet', 'authenticated-roolilla on tasan CRUD', '4',
         (select count(*)::text
            from (select unnest(array['select', 'insert', 'update', 'delete',
                                      'truncate', 'references', 'trigger']) as oikeus) pp
           where has_table_privilege('authenticated', 'public.notification_preferences', pp.oikeus))

  -- ================================================================
  -- VANHA DATA ON KOSKEMATON
  -- ================================================================

  union all
  select '20', 'vanha data', 'RLS on yha paalla tauluissa tasks ja profile', '2',
         (select count(*)::text from pg_class
           where relnamespace = 'public'::regnamespace
             and relname in ('tasks', 'profile') and relrowsecurity)

  union all
  select '21', 'vanha data', 'tasks-taulussa on yha nelja politiikkaa', '4',
         (select count(*)::text from pg_policies
           where schemaname = 'public' and tablename = 'tasks')

  union all
  select '22', 'vanha data', 'Uusi taulu on tyhja', '0',
         (select count(*)::text from public.notification_preferences)

  -- ================================================================
  -- KIRJATTAVAT
  -- ================================================================

  union all
  select '23', 'kirjattavat', 'Tehtavien lukumaara', 'INFO',
         (select count(*)::text from public.tasks)

  union all
  select '24', 'kirjattavat', 'Tietokanta', 'INFO', current_database()

  union all
  select '25', 'kirjattavat', 'Varmistuksen hetki (UTC)', 'INFO',
         to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS')

) c
order by c.check_no;
