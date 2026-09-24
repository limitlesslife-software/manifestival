-- Varmistus: 0011_personal_assistant
-- VAIN LUKEVA. Yksi lause, yksi taulukko, yksi kopiointi.
-- Aja heti migraation jalkeen.
--
-- ODOTUS: jokaisen PASS/FAIL-rivin status = 'PASS' ja
-- poikkeavia_yhteensa = 0. Yksikin FAIL tarkoittaa, ettei lippuja
-- inboxItems, reminders, notices, travelPlans eika locationRules saa
-- kaantaa tiedostossa src/data/schema.js.
--
-- VIISI ASIAA, JOTKA TAMA ERITYISESTI TODISTAA
--
-- 1. KOORDINAATTEJA EI OLE. Matkasuunnitelma ja sijaintisaanto ovat
--    NIMIA, eivat pisteita kartalla. Koordinaatti kannassa olisi
--    koordinaatti varmuuskopiossa, viennissa ja mahdollisessa vuodossa.
--    Tarkistus 12 hakee niita sarakenimista suoraan -- se on ainoa
--    tarkistus tassa tiedostossa, joka etsii jotain mita EI SAA OLLA.
--
-- 2. KAKSOISKAPPALEIDEN ESTO ON RAKENTEELLINEN. notices_key_unique
--    tekee siita kannan asian eika sovelluslogiikkaa: toistuvasti
--    ajettu taustatarkistus ei voi luoda toista rivia edes silloin kun
--    sovelluksen oma tarkistus pettaisi. Tarkistus 27.
--
-- 3. POISTOSAANTO RAJAA NOLLAUKSEN SARAKKEESEEN. Ilman sarakelistaa
--    PostgreSQL nollaisi koko vierasavaimen, myos NOT NULL -sarakkeen
--    user_id -- ja tehtavan poisto kaatuisi. Tarkistus 29.
--
-- 4. KOHDETUNNISTE EI OLE VIERASAVAIN. Muistutus ja ilmoitus ovat
--    tietueita siita, etta muistuttaminen oli tarkoitus. Kohde saa
--    kadota; tietue jaa. Tarkistus 30.
--
-- 5. OLEMASSA OLEVA DATA ON KOSKEMATONTA. Toisin kuin 0010, tama
--    migraatio ei muuta yhtaan olemassa olevaa taulua. Tarkistukset
--    54-56 mittaavat sita jalkikateen -- migraatio itse todisti saman
--    ennen committia.
--
-- Rakenne luetaan KATALOGEISTA, ei nimista.
--
-- Tama tiedosto EI lue sarakkeita text, title, note, reason, message,
-- origin, destination, place eika proposal. Ne ovat kayttajan omaa
-- sisaltoa -- osa suoraan hanen sanelemaansa -- ja varmistus tarvitsee
-- vain rakenteen.

select c.check_no, c.section, c.check_name,
       case when c.odotus = 'INFO' then 'INFO'
            when c.toteutui = c.odotus then 'PASS' else 'FAIL' end as status,
       case when c.odotus = 'INFO' then c.toteutui
            else 'odotus ' || c.odotus || ', toteutui ' || c.toteutui end as details,
       count(*) filter (where c.odotus <> 'INFO' and c.toteutui <> c.odotus)
         over () as poikkeavia_yhteensa
from (

  -- ================================================================
  -- UUDET TAULUT
  --
  -- Kokonaismaara yksin ei todista mitaan: se voisi tasmata, vaikka
  -- odotettu sarake puuttuisi ja tilalla olisi tuntematon. Siksi
  -- jokaisesta taulusta kysytaan kaksi kysymysta: ovatko odotetut
  -- sarakkeet olemassa, ja onko siella jotain muuta.
  -- ================================================================

  select '01' as check_no, 'taulut' as section,
         'Viisi uutta taulua on olemassa' as check_name,
         '5' as odotus,
         (select count(*)::text from pg_tables
           where schemaname = 'public'
             and tablename in ('inbox_items', 'reminders', 'notices',
                               'travel_plans', 'location_rules')) as toteutui

  union all
  select '02', 'taulut', 'inbox_items: yksitoista odotettua saraketta', '11',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'inbox_items'
             and column_name in ('id', 'user_id', 'text', 'status', 'source',
                                 'proposal', 'converted_kind', 'converted_id',
                                 'captured_at', 'created_at', 'updated_at'))

  union all
  select '03', 'taulut', 'inbox_items: ei nimeamattomia sarakkeita', '0',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'inbox_items'
             and column_name not in ('id', 'user_id', 'text', 'status', 'source',
                                     'proposal', 'converted_kind', 'converted_id',
                                     'captured_at', 'created_at', 'updated_at'))

  union all
  select '04', 'taulut', 'reminders: seitsemantoista odotettua saraketta', '17',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'reminders'
             and column_name in ('id', 'user_id', 'title', 'target_type', 'target_id',
                                 'trigger_type', 'due_date', 'due_time', 'lead_minutes',
                                 'status', 'escalate', 'alert_count', 'snooze_count',
                                 'until_time', 'note', 'created_at', 'updated_at'))

  union all
  select '05', 'taulut', 'reminders: ei nimeamattomia sarakkeita', '0',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'reminders'
             and column_name not in ('id', 'user_id', 'title', 'target_type', 'target_id',
                                     'trigger_type', 'due_date', 'due_time', 'lead_minutes',
                                     'status', 'escalate', 'alert_count', 'snooze_count',
                                     'until_time', 'note', 'created_at', 'updated_at'))

  union all
  select '06', 'taulut', 'notices: kolmetoista odotettua saraketta', '13',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'notices'
             and column_name in ('id', 'user_id', 'notice_key', 'kind', 'level',
                                 'status', 'title', 'reason', 'target_type',
                                 'target_id', 'created_date', 'created_at', 'updated_at'))

  union all
  select '07', 'taulut', 'notices: ei nimeamattomia sarakkeita', '0',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'notices'
             and column_name not in ('id', 'user_id', 'notice_key', 'kind', 'level',
                                     'status', 'title', 'reason', 'target_type',
                                     'target_id', 'created_date', 'created_at', 'updated_at'))

  union all
  select '08', 'taulut', 'travel_plans: seitsemantoista odotettua saraketta', '17',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'travel_plans'
             and column_name in ('id', 'user_id', 'title', 'origin', 'destination',
                                 'arrival_date', 'arrival_time', 'mode', 'travel_minutes',
                                 'travel_source', 'estimated_at', 'preparation_minutes',
                                 'arrival_buffer_minutes', 'task_id', 'note',
                                 'created_at', 'updated_at'))

  union all
  select '09', 'taulut', 'travel_plans: ei nimeamattomia sarakkeita', '0',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'travel_plans'
             and column_name not in ('id', 'user_id', 'title', 'origin', 'destination',
                                     'arrival_date', 'arrival_time', 'mode', 'travel_minutes',
                                     'travel_source', 'estimated_at', 'preparation_minutes',
                                     'arrival_buffer_minutes', 'task_id', 'note',
                                     'created_at', 'updated_at'))

  union all
  select '10', 'taulut', 'location_rules: yhdeksan odotettua saraketta', '9',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'location_rules'
             and column_name in ('id', 'user_id', 'place', 'trigger_type', 'message',
                                 'active', 'task_id', 'created_at', 'updated_at'))

  union all
  select '11', 'taulut', 'location_rules: ei nimeamattomia sarakkeita', '0',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'location_rules'
             and column_name not in ('id', 'user_id', 'place', 'trigger_type', 'message',
                                     'active', 'task_id', 'created_at', 'updated_at'))

  -- ================================================================
  -- TIETOSUOJA
  --
  -- Tarkistukset 03, 05, 07, 09 ja 11 loytaisivat lisatyn
  -- koordinaattisarakkeen jo nimeamattomana. Tarkistus 12 on silti
  -- erikseen, ja tahallaan: se sanoo AANEEN mita etsitaan, jotta
  -- sarakelistan huolimaton paivitys ei hiljaa tekisi
  -- sijaintihistoriasta sallittua.
  -- ================================================================

  union all
  select '12', 'tietosuoja', 'Yhdessakaan uudessa taulussa ei ole koordinaattisaraketta', '0',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public'
             and table_name in ('inbox_items', 'reminders', 'notices',
                                'travel_plans', 'location_rules')
             -- Nimen OSA (alaviivojen valissa), ei mika tahansa alimerkkijono:
             -- pelkka '(lat|...)' osui sarakkeeseen reminders.escalate
             -- (esca-LAT-e) ja antoi vaaran FAIL-tuloksen. Todettu oikealla
             -- PostgreSQL:lla, ks. tools/pg-rehearsal.
             and column_name ~ '(^|_)(lat|lon|coord|coords|coordinates|latitude|longitude|lng|geo|geom|geography|geometry|gps|point|sijainti)(_|$)')

  union all
  -- NIMI ON TEKSTIA. Jos naista tulisi joskus numeerisia tai
  -- geometrisia, se olisi juuri se muutos jota ei saa tehda.
  select '13', 'tietosuoja', 'travel_plans: origin ja destination ovat tekstia', '2',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'travel_plans'
             and column_name in ('origin', 'destination') and data_type = 'text')

  union all
  select '14', 'tietosuoja', 'location_rules: place on tekstia', 'text',
         (select data_type::text from information_schema.columns
           where table_schema = 'public' and table_name = 'location_rules'
             and column_name = 'place')

  union all
  -- SIJAINTI VAATII LUVAN, EIKA LUPAA OLETETA. Saannon on oltava
  -- oletuksena pois paalta -- muuten kannan taytto kytkisi seurannan
  -- paalle ilman etta kukaan paatti niin.
  select '15', 'tietosuoja', 'location_rules.active on oletuksena epatosi', 'false',
         (select column_default::text from information_schema.columns
           where table_schema = 'public' and table_name = 'location_rules'
             and column_name = 'active')

  -- ================================================================
  -- TYYPIT
  -- ================================================================

  union all
  -- PAIVA JA KELLONAIKA ERIKSEEN, EI AIKALEIMAA.
  --
  -- timestamptz siirtaisi suomalaisen aamukahdeksan edelliselle
  -- paivalle UTC:ssa, ja muistutus tulisi vaarana paivana. Sama
  -- ratkaisu kuin tasks-taulussa.
  select '16', 'tyypit', 'reminders: due_date on date ja due_time on time', '2',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'reminders'
             and ((column_name = 'due_date' and data_type = 'date')
               or (column_name = 'due_time' and data_type = 'time without time zone')))

  union all
  select '17', 'tyypit', 'reminders: myos until_time on time', 'time without time zone',
         (select data_type::text from information_schema.columns
           where table_schema = 'public' and table_name = 'reminders'
             and column_name = 'until_time')

  union all
  select '18', 'tyypit', 'travel_plans: arrival_date on date ja arrival_time on time', '2',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'travel_plans'
             and ((column_name = 'arrival_date' and data_type = 'date')
               or (column_name = 'arrival_time' and data_type = 'time without time zone')))

  union all
  -- TUNTEMATON ON NULL, EI NOLLA. Nolla tarkoittaisi etta ollaan jo
  -- perilla, ja siita laskettu lahtoaika olisi vale. Sarakkeen ON
  -- oltava nullable, jotta tuntematon voidaan ilmaista lainkaan.
  select '19', 'tyypit', 'travel_plans.travel_minutes on nullable kokonaisluku', 'YES integer',
         (select is_nullable || ' ' || data_type from information_schema.columns
           where table_schema = 'public' and table_name = 'travel_plans'
             and column_name = 'travel_minutes')

  union all
  -- Tulkinta on JASENNELTY OLIO, ei mallin vastaus tekstina.
  select '20', 'tyypit', 'inbox_items.proposal on jsonb', 'jsonb',
         (select data_type::text from information_schema.columns
           where table_schema = 'public' and table_name = 'inbox_items'
             and column_name = 'proposal')

  -- ================================================================
  -- RAJOITTEET
  -- ================================================================

  union all
  select '21', 'rajoitteet', 'inbox_items: nelja CHECK-rajoitetta', '4',
         (select count(*)::text from pg_constraint
           where conrelid = 'public.inbox_items'::regclass and contype = 'c'
             and conname in ('inbox_items_status_check',
                             'inbox_items_source_check',
                             'inbox_items_text_check',
                             'inbox_items_converted_check'))

  union all
  select '22', 'rajoitteet', 'reminders: kahdeksan CHECK-rajoitetta', '8',
         (select count(*)::text from pg_constraint
           where conrelid = 'public.reminders'::regclass and contype = 'c'
             and conname in ('reminders_status_check',
                             'reminders_target_check',
                             'reminders_trigger_check',
                             'reminders_title_check',
                             'reminders_target_pair_check',
                             'reminders_alert_count_check',
                             'reminders_snooze_count_check',
                             'reminders_lead_check'))

  union all
  select '23', 'rajoitteet', 'notices: viisi CHECK-rajoitetta', '5',
         (select count(*)::text from pg_constraint
           where conrelid = 'public.notices'::regclass and contype = 'c'
             and conname in ('notices_kind_check',
                             'notices_level_check',
                             'notices_status_check',
                             'notices_title_check',
                             'notices_target_pair_check'))

  union all
  select '24', 'rajoitteet', 'travel_plans: kuusi CHECK-rajoitetta', '6',
         (select count(*)::text from pg_constraint
           where conrelid = 'public.travel_plans'::regclass and contype = 'c'
             and conname in ('travel_plans_mode_check',
                             'travel_plans_source_check',
                             'travel_plans_title_check',
                             'travel_plans_minutes_check',
                             'travel_plans_buffer_check',
                             'travel_plans_unknown_source_check'))

  union all
  select '25', 'rajoitteet', 'location_rules: kaksi CHECK-rajoitetta', '2',
         (select count(*)::text from pg_constraint
           where conrelid = 'public.location_rules'::regclass and contype = 'c'
             and conname in ('location_rules_trigger_check',
                             'location_rules_place_check'))

  union all
  select '26', 'rajoitteet', 'Viisi omistajan rivin avainta', '5',
         (select count(*)::text from pg_constraint
           where contype = 'u'
             and conname in ('inbox_items_owner_row_key', 'reminders_owner_row_key',
                             'notices_owner_row_key', 'travel_plans_owner_row_key',
                             'location_rules_owner_row_key'))

  union all
  -- KAKSOISKAPPALEIDEN ESTO ON RAKENTEELLINEN.
  --
  -- Ilman tata sama halytys voisi tuottaa kaksi rivia aina kun
  -- taustatarkistus ajetaan kahdesti. Sovelluksen oma tarkistus on
  -- ensimmainen este; tama on toinen, eika se voi pettaa.
  --
  -- Sarakkeita on oltava KAKSI. Pelkka notice_key olisi uniikki koko
  -- kannassa ja estaisi toista kayttajaa saamasta samaa ilmoitusta.
  select '27', 'rajoitteet', 'notices_key_unique kattaa kaksi saraketta', '2',
         (select array_length(conkey, 1)::text from pg_constraint
           where conname = 'notices_key_unique' and contype = 'u')

  union all
  -- YHDISTELMAVIERASAVAIN ON SE, JOKA ESTAA RISTIINKIINNITYKSEN.
  -- Vierasavaimen tarkistus EI kulje RLS:n lapi: RLS estaa lukemisen,
  -- ei viittaamista. Kaksi saraketta viitteessa on koko suoja.
  select '28', 'rajoitteet', 'Kaksi vierasavainta viittaa tehtavaan kahdella sarakkeella', '2',
         (select count(*)::text from pg_constraint
           where conname in ('travel_plans_task_fkey', 'location_rules_task_fkey')
             and contype = 'f'
             and array_length(conkey, 1) = 2)

  union all
  -- POISTOSAANTO RAJAA NOLLAUKSEN SARAKKEESEEN.
  --
  -- Ilman sarakelistaa PostgreSQL nollaisi koko vierasavaimen, myos
  -- user_id:n joka on NOT NULL -- ja tehtavan poisto kaatuisi
  -- virheeseen 23502. Vika loytyi migraatiossa 0004.
  select '29', 'rajoitteet', 'SET NULL rajaa nollauksen yhteen sarakkeeseen', '2',
         (select count(*)::text from pg_constraint
           where conname in ('travel_plans_task_fkey', 'location_rules_task_fkey')
             and confdeltype = 'n'
             and array_length(confdelsetcols, 1) = 1)

  union all
  -- KOHDETUNNISTE EI OLE VIERASAVAIN.
  --
  -- Muistutus ja ilmoitus ovat tietueita siita, etta muistuttaminen
  -- oli tarkoitus. Kohde saa kadota; tietue jaa, ja orpo muistutus
  -- perutaan NAKYVASTI sovelluksessa hiljaisen katoamisen sijaan.
  --
  -- Sama perustelu kuin transactions.source_id (0009) ja
  -- ai_action_audit.target_id (0008).
  --
  -- Naissa kolmessa taulussa on siis tasan yksi vierasavain: user_id.
  select '30', 'rajoitteet', 'inbox_items, reminders ja notices: vain user_id on vierasavain', '3',
         (select count(*)::text from pg_constraint
           where contype = 'f'
             and conrelid in ('public.inbox_items'::regclass,
                              'public.reminders'::regclass,
                              'public.notices'::regclass))

  union all
  -- KAYTTAJAN POISTO VIE RIVIT MUKANAAN.
  select '31', 'rajoitteet', 'Viisi user_id-vierasavainta on CASCADE', '5',
         (select count(*)::text from pg_constraint
           where contype = 'f' and confdeltype = 'c'
             and conrelid in ('public.inbox_items'::regclass,
                              'public.reminders'::regclass,
                              'public.notices'::regclass,
                              'public.travel_plans'::regclass,
                              'public.location_rules'::regclass))

  union all
  -- HALYTYSTEN MAARA ON RAJATTU KANNASSA ASTI.
  --
  -- Loputon toisto on helppo kirjoittaa vahingossa: yksi ehto vaarin
  -- pain ja kayttajan puhelin soi minuutin valein. Sovellus rajaa
  -- viiteen; tama on toinen este saman virheen tiella.
  select '32', 'rajoitteet', 'Halytysten ylaraja on viisi', '1',
         (select count(*)::text from pg_constraint
           where conname = 'reminders_alert_count_check'
             and pg_get_constraintdef(oid) like '%<= 5%')

  union all
  -- TUNTEMATON KESTO EI SAA VAITTAA OLEVANSA MITATTU.
  select '33', 'rajoitteet', 'Tuntematon kesto pakottaa lahteen unknown', '1',
         (select count(*)::text from pg_constraint
           where conname = 'travel_plans_unknown_source_check'
             and pg_get_constraintdef(oid) like '%unknown%')

  -- ================================================================
  -- RLS JA OIKEUDET
  -- ================================================================

  union all
  select '34', 'rls', 'RLS on paalla kaikissa viidessa taulussa', '5',
         (select count(*)::text from pg_class
           where relnamespace = 'public'::regnamespace
             and relname in ('inbox_items', 'reminders', 'notices',
                             'travel_plans', 'location_rules')
             and relrowsecurity)

  union all
  select '35', 'rls', 'Kaksikymmenta omistajuuspolitiikkaa', '20',
         (select count(*)::text from pg_policies
           where schemaname = 'public'
             and tablename in ('inbox_items', 'reminders', 'notices',
                               'travel_plans', 'location_rules'))

  union all
  -- Politiikka joka koskee rooleja {public} paastaisi anonin sisaan
  -- vaikka nimessa lukisi mita tahansa.
  select '36', 'rls', 'Yksikaan politiikka ei koske public-roolia', '0',
         (select count(*)::text from pg_policies
           where schemaname = 'public'
             and tablename in ('inbox_items', 'reminders', 'notices',
                               'travel_plans', 'location_rules')
             and 'public' = any(roles))

  union all
  select '37', 'rls', 'Jokainen politiikka koskee roolia authenticated', '20',
         (select count(*)::text from pg_policies
           where schemaname = 'public'
             and tablename in ('inbox_items', 'reminders', 'notices',
                               'travel_plans', 'location_rules')
             and 'authenticated' = any(roles))

  union all
  select '38', 'oikeudet', 'anon-roolilla ei ole oikeuksia', '0',
         (select count(*)::text from information_schema.role_table_grants
           where table_schema = 'public'
             and table_name in ('inbox_items', 'reminders', 'notices',
                                'travel_plans', 'location_rules')
             and grantee in ('anon', 'public'))

  union all
  select '39', 'oikeudet', 'authenticated saa nelja oikeutta viiteen tauluun', '20',
         (select count(*)::text from information_schema.role_table_grants
           where table_schema = 'public'
             and table_name in ('inbox_items', 'reminders', 'notices',
                                'travel_plans', 'location_rules')
             and grantee = 'authenticated'
             and privilege_type in ('SELECT', 'INSERT', 'UPDATE', 'DELETE'))

  union all
  -- PUBLIC-ROOLIN OIKEUDET LUETAAN SUORAAN ACL:STA.
  --
  -- role_table_grants ei nayta PUBLIC-roolille myonnettya oikeutta
  -- sellaisenaan. aclexplode on ainoa tapa nahda PUBLIC (grantee = 0).
  -- Tarkistus 38 yksin jattaisi taman huomaamatta.
  select '40', 'oikeudet', 'PUBLIC-roolilla ei ole oikeuksia (aclexplode)', '0',
         (select count(*)::text
            from pg_class c2, lateral aclexplode(c2.relacl) a
           where c2.relnamespace = 'public'::regnamespace
             and c2.relname in ('inbox_items', 'reminders', 'notices',
                                'travel_plans', 'location_rules')
             and a.grantee = 0)

  union all
  -- TEHOLLINEN OIKEUS. Myonnot voivat nayttaa oikeilta ja oikeus
  -- silti periytya jostain muualta.
  select '41', 'oikeudet', 'anon-roolilla ei ole tehollista lukuoikeutta', 'false',
         (select bool_or(has_table_privilege('anon', t, 'select'))::text
            from unnest(array['public.inbox_items', 'public.reminders',
                              'public.notices', 'public.travel_plans',
                              'public.location_rules']) as t)

  union all
  select '42', 'oikeudet', 'authenticated-roolilla on tehollinen lukuoikeus kaikkiin', 'true',
         (select bool_and(has_table_privilege('authenticated', t, 'select'))::text
            from unnest(array['public.inbox_items', 'public.reminders',
                              'public.notices', 'public.travel_plans',
                              'public.location_rules']) as t)

  -- ================================================================
  -- INDEKSIT JA LIIPAISIMET
  -- ================================================================

  union all
  select '43', 'indeksit', 'Yhdeksan nimettya indeksia on olemassa', '9',
         (select count(*)::text from pg_indexes
           where schemaname = 'public'
             and indexname in ('inbox_items_user_status_idx', 'inbox_items_user_captured_idx',
                               'reminders_user_due_idx', 'reminders_user_status_idx',
                               'reminders_user_target_idx',
                               'notices_user_status_idx', 'notices_user_created_idx',
                               'travel_plans_user_arrival_idx',
                               'location_rules_user_active_idx'))

  union all
  select '44', 'liipaisimet', 'Viisi touch_updated_at -liipaisinta', '5',
         (select count(*)::text from pg_trigger
           where not tgisinternal
             and tgname in ('inbox_items_touch_updated_at', 'reminders_touch_updated_at',
                            'notices_touch_updated_at', 'travel_plans_touch_updated_at',
                            'location_rules_touch_updated_at'))

  union all
  -- SECURITY DEFINER tassa funktiossa antaisi jokaiselle paivitykselle
  -- omistajan oikeudet. Migraatio tarkisti taman ennen ajoa; tama
  -- tarkistaa sen jalkeen.
  select '45', 'liipaisimet', 'touch_updated_at on yha SECURITY INVOKER', 'false',
         (select p.prosecdef::text from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'touch_updated_at')

  -- ================================================================
  -- DATAN EHEYS
  --
  -- Naiden pitaa olla nollia heti migraation jalkeen, koska taulut
  -- ovat tyhjia. Ne ovat silti tassa: sama tiedosto ajetaan uudelleen
  -- kun portit avataan ja rivit ovat todellisia.
  -- ================================================================

  union all
  select '46', 'data', 'Muunnetulla saapuvalla on kohdelaji', '0',
         (select count(*)::text from public.inbox_items
           where (status = 'converted' and converted_kind is null)
              or (status <> 'converted' and converted_kind is not null))

  union all
  -- EHDOTUS KATOAA KUN RIVI KASITELLAAN.
  --
  -- Tata EI ole rajoitettu kannassa, ja se on tietoinen valinta:
  -- rajoite estaisi kasittelyn kahdessa askeleessa, jossa tila
  -- paivittyy ensin ja ehdotus tyhjennetaan sitten. Saanto on
  -- sovelluksessa, ja tama on paikka jossa sen rikkominen havaitaan.
  select '47', 'data', 'Kasitellylla saapuvalla ei ole enaa ehdotusta', '0',
         (select count(*)::text from public.inbox_items
           where status in ('converted', 'dismissed') and proposal is not null)

  union all
  select '48', 'data', 'Kohdelaji ja tunniste kulkevat parina (muistutukset)', '0',
         (select count(*)::text from public.reminders
           where (target_type = 'standalone' and target_id is not null)
              or (target_type <> 'standalone' and target_id is null))

  union all
  select '49', 'data', 'Kohdelaji ja tunniste kulkevat parina (ilmoitukset)', '0',
         (select count(*)::text from public.notices
           where (target_type is null) <> (target_id is null))

  union all
  select '50', 'data', 'Yksikaan muistutus ei ylita halytysten ylarajaa', '0',
         (select count(*)::text from public.reminders
           where alert_count > 5 or snooze_count > 10)

  union all
  select '51', 'data', 'Tuntematon kesto ei vaita olevansa mitattu', '0',
         (select count(*)::text from public.travel_plans
           where travel_minutes is null and travel_source <> 'unknown')

  union all
  -- Yhdistelmavierasavain takaa taman rakenteellisesti. Tarkistus on
  -- silti tassa: se on halpa, ja se paljastaisi kasin tehdyn
  -- rajoitteen pudotuksen.
  select '52', 'data', 'Jokainen matkasuunnitelman tehtava on omistajan oma', '0',
         (select count(*)::text from public.travel_plans p
           where p.task_id is not null
             and not exists (select 1 from public.tasks t
                              where t.id = p.task_id and t.user_id = p.user_id))

  union all
  select '53', 'data', 'Jokainen sijaintisaannon tehtava on omistajan oma', '0',
         (select count(*)::text from public.location_rules r
           where r.task_id is not null
             and not exists (select 1 from public.tasks t
                              where t.id = r.task_id and t.user_id = r.user_id))

  -- ================================================================
  -- OLEMASSA OLEVA DATA -- MIKAAN EI SAANUT MUUTTUA
  --
  -- Tama migraatio EI KOSKE yhteenkaan olemassa olevaan tauluun.
  -- Se on tietoinen ero migraatioon 0010, joka muutti kolmea taulua
  -- joissa on kayttajan dataa.
  -- ================================================================

  union all
  select '54', 'vanha data', 'tasks, goals ja projects: yha kaksitoista politiikkaa', '12',
         (select count(*)::text from pg_policies
           where schemaname = 'public'
             and tablename in ('tasks', 'goals', 'projects'))

  union all
  select '55', 'vanha data', 'tasks_owner_row_key on yha olemassa', '1',
         (select count(*)::text from pg_constraint
           where conname = 'tasks_owner_row_key' and contype = 'u')

  union all
  -- Migraatio otti lukon tasks-tauluun vierasavaimen luonnin ajaksi.
  -- Lukko ei muuta riveja, ja tama on se rivi josta lukumaaran voi
  -- verrata esitarkistuksen lukemaan.
  select '56', 'vanha data', 'Tehtavien lukumaara (vertaa esitarkistukseen)', 'INFO',
         (select count(*)::text from public.tasks)

  -- ================================================================
  -- KIRJATTAVAT
  -- ================================================================

  union all
  select '57', 'kirjattavat', 'Saapuvien lukumaara', 'INFO',
         (select count(*)::text from public.inbox_items)

  union all
  select '58', 'kirjattavat', 'Muistutusten lukumaara', 'INFO',
         (select count(*)::text from public.reminders)

  union all
  select '59', 'kirjattavat', 'Ilmoitusten lukumaara', 'INFO',
         (select count(*)::text from public.notices)

  union all
  select '60', 'kirjattavat', 'Matkasuunnitelmien lukumaara', 'INFO',
         (select count(*)::text from public.travel_plans)

  union all
  select '61', 'kirjattavat', 'Sijaintisaantojen lukumaara', 'INFO',
         (select count(*)::text from public.location_rules)

  union all
  -- ODOTUS ON NOLLA niin kauan kuin laitehyvaksynta on tekematta.
  -- Nollaa suurempi luku ei ole virhe -- se on merkki siita, etta
  -- joku on kytkenyt saannon paalle, ja se on syyta tietaa.
  select '62', 'kirjattavat', 'Aktiivisia sijaintisaantoja', 'INFO',
         (select count(*)::text from public.location_rules where active)

  union all
  select '63', 'kirjattavat', 'Tietokanta', 'INFO', current_database()

  union all
  select '64', 'kirjattavat', 'Varmistuksen hetki (UTC)', 'INFO',
         to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS')

) c
order by c.check_no;
