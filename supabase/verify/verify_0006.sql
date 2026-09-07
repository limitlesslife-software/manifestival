-- Varmistus: 0006_wellbeing
-- VAIN LUKEVA. Yksi lause, yksi taulukko, yksi kopiointi.
-- Aja heti migraation jalkeen.
--
-- ODOTUS: jokaisen PASS/FAIL-rivin status = 'PASS' ja
-- poikkeavia_yhteensa = 0. Yksikin FAIL tarkoittaa, ettei lippua
-- wellbeing saa kaantaa.
--
-- TAMA ON PAKETIN ARKALUONTOISIN TAULU
-- Sarake `note` on vapaata tekstia, johon ihminen kirjoittaa mita
-- tahansa. Tama tiedosto EI lue yhtaan sisaltosaraketta — ei
-- muistiinpanoja eika mittariarvoja, vain rivimaaria ja rakennetta.
--
-- Rakenne luetaan KATALOGEISTA, ei nimista.

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
         'Taulu wellbeing_entries on olemassa' as check_name,
         '1' as odotus,
         (select count(*)::text from pg_tables
           where schemaname = 'public' and tablename = 'wellbeing_entries') as toteutui

  union all
  select '02', 'taulut', 'Rakenteelliset sarakkeet ovat olemassa', '10',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'wellbeing_entries'
             and column_name in ('id', 'user_id', 'date', 'energy', 'mood',
                                 'stress', 'sleep_hours', 'note',
                                 'created_at', 'updated_at'))

  union all
  -- Kokonaismaara yksin ei todista mitaan: se voisi tasmata, vaikka
  -- odotettu sarake puuttuisi ja tilalla olisi tuntematon.
  select '03', 'taulut', 'Taulussa ei ole nimeamattomia sarakkeita', '0',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'wellbeing_entries'
             and column_name not in ('id', 'user_id', 'date', 'energy', 'mood',
                                     'stress', 'sleep_hours', 'note',
                                     'created_at', 'updated_at'))

  union all
  select '04', 'taulut', 'Taulussa on tasan 10 saraketta', '10',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'wellbeing_entries')

  union all
  -- Osittainen merkinta on parempi kuin ei merkintaa lainkaan. Jos
  -- mittarit olisivat NOT NULL, kayttajan olisi pakko keksia luku
  -- jokaiseen — ja keksitty luku on huonompi kuin puuttuva.
  select '05', 'taulut', 'Kaikki mittarit ovat vapaaehtoisia', '5',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'wellbeing_entries'
             and column_name in ('energy', 'mood', 'stress', 'sleep_hours', 'note')
             and is_nullable = 'YES')

  union all
  -- Unen maara on numeric(4,2), ei liukuluku: puolikkaat tunnit ovat
  -- tarpeen, mutta liukuluvun pyoristysvirhe ei ole.
  select '06', 'taulut', 'Unen maara on numeric(4,2)', '1',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'wellbeing_entries'
             and column_name = 'sleep_hours'
             and data_type = 'numeric'
             and numeric_precision = 4 and numeric_scale = 2)

  union all
  select '07', 'rajoitteet', 'Asteikko- ja unitarkisteet ovat olemassa', '2',
         (select count(*)::text from pg_constraint
           where conname in ('wellbeing_entries_scale_check',
                             'wellbeing_entries_sleep_check')
             and contype = 'c')

  -- ================================================================
  -- OMISTAJUUS
  -- ================================================================

  union all
  -- YKSIKASITTEISYYS ON OMISTAJAKOHTAINEN.
  --
  -- Rajoitteen on katettava TASAN sarakkeet (user_id, date). Pelkka
  -- unique(date) olisi vuoto: se paljastaisi virheella, etta jollakin
  -- TOISELLA kayttajalla on merkinta samalle paivalle. Se on pieni
  -- vuoto, mutta se on vuoto nimenomaan siita datasta, joka on
  -- arkaluontoisinta.
  select '08', 'omistajuus', 'Paivan yksikasitteisyys kattaa parin (user_id, date)', '1',
         (select count(*)::text from pg_constraint con
           where con.conname = 'wellbeing_entries_unique_day'
             and con.contype = 'u'
             and (select array_agg(a.attname::text order by a.attname)
                    from unnest(con.conkey) k(attnum)
                    join pg_attribute a
                      on a.attrelid = con.conrelid and a.attnum = k.attnum)
                 = array['date', 'user_id'])

  union all
  select '09', 'omistajuus', 'Omistajan asettaa kanta, ei asiakas', '1',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'wellbeing_entries'
             and column_name = 'user_id'
             and is_nullable = 'NO'
             and column_default like '%auth.uid()%')

  union all
  select '10', 'omistajuus', 'Kayttajan poisto siivoaa merkinnat', '1',
         (select count(*)::text
            from pg_constraint con
            join pg_class ft on ft.oid = con.confrelid
            join pg_namespace fn on fn.oid = ft.relnamespace
           where con.conrelid = 'public.wellbeing_entries'::regclass
             and con.contype = 'f'
             and fn.nspname = 'auth' and ft.relname = 'users'
             and con.confdeltype = 'c')

  union all
  -- Taulussa ei ole yhtaan viitetta sovellustauluihin. Tama on se
  -- vaite, jonka nojalla yhdistelmavierasavainta ei tarvita. Jos viite
  -- joskus lisataan, vaite vanhenee ja tama kaatuu.
  select '11', 'omistajuus', 'Taulussa ei ole viitteita sovellustauluihin', '0',
         (select count(*)::text
            from pg_constraint con
            join pg_class ft on ft.oid = con.confrelid
           where con.conrelid = 'public.wellbeing_entries'::regclass
             and con.contype = 'f'
             and ft.relnamespace = 'public'::regnamespace)

  -- ================================================================
  -- INDEKSI, LIIPAISIN JA RLS
  -- ================================================================

  union all
  -- Sarakejarjestys luetaan indkey-listasta. (user_id, date) palvelee
  -- omistajan aikasarjahakua; (date, user_id) ei.
  select '12', 'indeksit', 'Hakuindeksi on jarjestyksessa (user_id, date)', '1',
         (select count(*)::text
            from pg_index i
            join pg_class ic on ic.oid = i.indexrelid
            join pg_class tc on tc.oid = i.indrelid
           where ic.relname = 'wellbeing_entries_user_date_idx'
             and (select array_agg(a.attname::text order by k.ord)
                    from unnest(i.indkey) with ordinality k(attnum, ord)
                    join pg_attribute a
                      on a.attrelid = tc.oid and a.attnum = k.attnum)
                 = array['user_id', 'date'])

  union all
  -- Ajoitus luetaan tgtype-biteista: 1 = rivikohtainen, 2 = before,
  -- 16 = update. Nimi ei kerro milloin liipaisin ajetaan.
  select '13', 'liipaisimet', 'updated_at paivittyy ennen rivin muutosta', '1',
         (select count(*)::text from pg_trigger
           where not tgisinternal
             and tgname = 'wellbeing_entries_touch_updated_at'
             and (tgtype & 1) = 1 and (tgtype & 2) = 2 and (tgtype & 16) = 16)

  union all
  select '14', 'liipaisimet', 'Funktio touch_updated_at on yha kovennettu', '1',
         (select count(*)::text from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'touch_updated_at'
             and p.prosecdef = false
             and p.proconfig is not null
             and exists (select 1 from unnest(p.proconfig) a
                          where a like 'search\_path=%'))

  union all
  select '15', 'rls', 'RLS on paalla', '1',
         (select count(*)::text from pg_class
           where relnamespace = 'public'::regnamespace
             and relname = 'wellbeing_entries' and relrowsecurity)

  union all
  -- Politiikan OLEMASSAOLO ei todista mitaan: `using (true)` nayttaisi
  -- luettelossa aivan samalta. Siksi ehdot luetaan ja verrataan — ja
  -- MOLEMMAT puolet, koska pelkka USING sallisi rivin kirjoittamisen
  -- toisen nimiin.
  select '16', 'rls', 'Nelja omistajuuspolitiikkaa oikein ehdoin', '4',
         (select count(*)::text
            from pg_policies p
            join (values
                    ('wellbeing_entries_select_own', 'SELECT', 'auth.uid()=user_id', ''),
                    ('wellbeing_entries_insert_own', 'INSERT', '',                   'auth.uid()=user_id'),
                    ('wellbeing_entries_update_own', 'UPDATE', 'auth.uid()=user_id', 'auth.uid()=user_id'),
                    ('wellbeing_entries_delete_own', 'DELETE', 'auth.uid()=user_id', '')
                 ) e(pol, operaatio, q, wc)
              on e.pol = p.policyname and e.operaatio = p.cmd
             and btrim(replace(coalesce(p.qual, ''), ' ', ''), '()') = e.q
             and btrim(replace(coalesce(p.with_check, ''), ' ', ''), '()') = e.wc
           where p.schemaname = 'public' and p.tablename = 'wellbeing_entries'
             and p.roles = '{authenticated}'::name[])

  union all
  select '17', 'rls', 'Taulussa ei ole ylimaaraisia politiikkoja', '4',
         (select count(*)::text from pg_policies
           where schemaname = 'public' and tablename = 'wellbeing_entries')

  -- ================================================================
  -- OIKEUDET
  -- ================================================================

  union all
  select '18', 'oikeudet', 'anon-roolilla ei ole tehollista oikeutta', '0',
         (select count(*)::text
            from (select unnest(array['select', 'insert', 'update', 'delete',
                                      'truncate', 'references', 'trigger']) as oikeus) pp
           where has_table_privilege('anon', 'public.wellbeing_entries', pp.oikeus))

  union all
  -- Kaksi menetelmaa, koska kumpikaan ei yksin riita: has_table_privilege
  -- kertoo ONKO oikeus (perinta mukaan lukien), aclexplode kertoo MISTA
  -- se tulee.
  select '19', 'oikeudet', 'PUBLIC-roolilla ei ole oikeuksia', '0',
         (select count(*)::text
            from pg_class cl, aclexplode(cl.relacl) acl
           where cl.oid = 'public.wellbeing_entries'::regclass
             and acl.grantee = 0)

  union all
  select '20', 'oikeudet', 'authenticated-roolilla on tasan CRUD', '4',
         (select count(*)::text
            from (select unnest(array['select', 'insert', 'update', 'delete',
                                      'truncate', 'references', 'trigger']) as oikeus) pp
           where has_table_privilege('authenticated', 'public.wellbeing_entries', pp.oikeus))

  -- ================================================================
  -- VANHA DATA ON KOSKEMATON
  -- ================================================================

  union all
  select '21', 'vanha data', 'RLS on yha paalla tauluissa tasks ja profile', '2',
         (select count(*)::text from pg_class
           where relnamespace = 'public'::regnamespace
             and relname in ('tasks', 'profile') and relrowsecurity)

  union all
  select '22', 'vanha data', 'tasks-taulussa on yha nelja politiikkaa', '4',
         (select count(*)::text from pg_policies
           where schemaname = 'public' and tablename = 'tasks')

  union all
  select '23', 'vanha data', 'Uusi taulu on tyhja', '0',
         (select count(*)::text from public.wellbeing_entries)

  -- ================================================================
  -- KIRJATTAVAT
  -- ================================================================

  union all
  select '24', 'kirjattavat', 'Tehtavien lukumaara', 'INFO',
         (select count(*)::text from public.tasks)

  union all
  select '25', 'kirjattavat', 'Tietokanta', 'INFO', current_database()

  union all
  select '26', 'kirjattavat', 'Varmistuksen hetki (UTC)', 'INFO',
         to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS')

) c
order by c.check_no;
