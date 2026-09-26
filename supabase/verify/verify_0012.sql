-- Varmistus: 0012_life_alignment
-- VAIN LUKEVA. Yksi lause, yksi taulukko, yksi kopiointi.
-- Aja heti migraation jalkeen.
--
-- ODOTUS: jokaisen PASS/FAIL-rivin status = 'PASS' ja
-- poikkeavia_yhteensa = 0. Yksikin FAIL tarkoittaa, ettei lippuja
-- lifeAreas, weeklyCapacities, timeEntries, alignmentReviews eika
-- GOAL_LIFE_AREA_FIELD saa kaantaa tiedostossa src/data/schema.js.
--
-- NELJA ASIAA, JOTKA TAMA ERITYISESTI TODISTAA
--
-- 1. HAVAINTOJA EI TALLENNETA. Kuormitus, huomiotta jaaminen ja
--    poikkeama lasketaan lahdefaktoista. Tarkistus 13 etsii
--    havaintotaulua, jota EI SAA OLLA.
--
-- 2. TOTEUTUMA ON KAYTTAJAN KIRJAAMA. time_entries.source sallii vain
--    arvon 'manual' (tarkistus 21). Arviota ei kopioida toteumaksi.
--
-- 3. POISTOSAANTO RAJAA NOLLAUKSEN SARAKKEESEEN. Alueen, tavoitteen tai
--    tehtavan poisto ei vie kirjattua aikaa eika tavoitetta
--    (tarkistukset 25-26).
--
-- 4. OLEMASSA OLEVA DATA ON KOSKEMATONTA. goals sai yhden nullable
--    sarakkeen; yhtakaan tavoitetta ei liitetty alueeseen migraatiossa
--    (tarkistukset 44-47).
--
-- Rakenne luetaan KATALOGEISTA, ei nimista.
--
-- Tama tiedosto EI lue sarakkeita name, description, note, reflection,
-- snapshot eika adjustments. Ne ovat kayttajan omaa sisaltoa.

-- NULL-TULOS ON POIKKEAMA. Puuttuva objekti tuottaa tarkistukseen NULLin:
-- se on FAIL, se lasketaan poikkeavia_yhteensa-lukuun (is distinct from)
-- ja details kertoo "toteutui null". Harjoiteltu: tools/pg-rehearsal
-- (verify:null).
select c.check_no, c.section, c.check_name,
       case when c.odotus = 'INFO' then 'INFO'
            when c.toteutui = c.odotus then 'PASS' else 'FAIL' end as status,
       case when c.odotus = 'INFO' then c.toteutui
            else 'odotus ' || c.odotus || ', toteutui ' || coalesce(c.toteutui, 'null') end as details,
       count(*) filter (where c.odotus <> 'INFO' and c.toteutui is distinct from c.odotus)
         over () as poikkeavia_yhteensa
from (

  -- ================================================================
  -- UUDET TAULUT JA SARAKE
  -- ================================================================

  select '01' as check_no, 'taulut' as section,
         'Nelja uutta taulua on olemassa' as check_name,
         '4' as odotus,
         (select count(*)::text from pg_tables
           where schemaname = 'public'
             and tablename in ('life_areas', 'weekly_capacities', 'time_entries',
                               'alignment_reviews')) as toteutui

  union all
  select '02', 'taulut', 'life_areas: yksitoista odotettua saraketta', '11',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'life_areas'
             and column_name in ('id', 'user_id', 'name', 'description', 'importance',
                                 'target_minutes_per_week', 'category_key', 'active',
                                 'sort_order', 'created_at', 'updated_at'))

  union all
  select '03', 'taulut', 'life_areas: ei nimeamattomia sarakkeita', '0',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'life_areas'
             and column_name not in ('id', 'user_id', 'name', 'description', 'importance',
                                     'target_minutes_per_week', 'category_key', 'active',
                                     'sort_order', 'created_at', 'updated_at'))

  union all
  select '04', 'taulut', 'weekly_capacities: kahdeksan odotettua saraketta', '8',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'weekly_capacities'
             and column_name in ('id', 'user_id', 'week_start', 'available_minutes',
                                 'energy_level', 'note', 'created_at', 'updated_at'))

  union all
  select '05', 'taulut', 'weekly_capacities: ei nimeamattomia sarakkeita', '0',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'weekly_capacities'
             and column_name not in ('id', 'user_id', 'week_start', 'available_minutes',
                                     'energy_level', 'note', 'created_at', 'updated_at'))

  union all
  select '06', 'taulut', 'time_entries: yksitoista odotettua saraketta', '11',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'time_entries'
             and column_name in ('id', 'user_id', 'entry_date', 'minutes', 'life_area_id',
                                 'goal_id', 'task_id', 'source', 'note',
                                 'created_at', 'updated_at'))

  union all
  select '07', 'taulut', 'time_entries: ei nimeamattomia sarakkeita', '0',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'time_entries'
             and column_name not in ('id', 'user_id', 'entry_date', 'minutes', 'life_area_id',
                                     'goal_id', 'task_id', 'source', 'note',
                                     'created_at', 'updated_at'))

  union all
  select '08', 'taulut', 'alignment_reviews: kymmenen odotettua saraketta', '10',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'alignment_reviews'
             and column_name in ('id', 'user_id', 'week_start', 'snapshot_version',
                                 'snapshot', 'reflection', 'adjustments', 'completed_at',
                                 'created_at', 'updated_at'))

  union all
  select '09', 'taulut', 'alignment_reviews: ei nimeamattomia sarakkeita', '0',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'alignment_reviews'
             and column_name not in ('id', 'user_id', 'week_start', 'snapshot_version',
                                     'snapshot', 'reflection', 'adjustments', 'completed_at',
                                     'created_at', 'updated_at'))

  union all
  -- NULLABLE JA ILMAN OLETUSTA. Oletusarvo taydentaisi jokaisen vanhan
  -- tavoitteen johonkin alueeseen, jota kayttaja ei valinnut.
  select '10', 'taulut', 'goals.life_area_id on nullable teksti ilman oletusta', 'YES text -',
         (select is_nullable || ' ' || data_type || ' ' || coalesce(column_default, '-')
            from information_schema.columns
           where table_schema = 'public' and table_name = 'goals'
             and column_name = 'life_area_id')

  -- ================================================================
  -- TYYPIT
  -- ================================================================

  union all
  select '11', 'tyypit', 'Viikko ja paiva ovat date-tyyppia (kolme saraketta)', '3',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and data_type = 'date'
             and ((table_name = 'weekly_capacities' and column_name = 'week_start')
               or (table_name = 'time_entries' and column_name = 'entry_date')
               or (table_name = 'alignment_reviews' and column_name = 'week_start')))

  union all
  -- TAVOITE PUUTTUU ON NULL, EI NOLLA. Nolla on paatos ("en halua
  -- kayttaa tahan aikaa"), NULL on "en ole asettanut".
  select '12', 'tyypit', 'life_areas.target_minutes_per_week on nullable kokonaisluku', 'YES integer',
         (select is_nullable || ' ' || data_type from information_schema.columns
           where table_schema = 'public' and table_name = 'life_areas'
             and column_name = 'target_minutes_per_week')

  union all
  -- JOHDETUT HAVAINNOT EIVAT ELA KANNASSA.
  select '13', 'tyypit', 'Havaintotaulua ei ole (havainnot lasketaan)', '0',
         (select count(*)::text from pg_tables
           where schemaname = 'public'
             and tablename ~ '(signal|drift|alignment_score|havainto)')

  union all
  select '14', 'tyypit', 'Tilannekuva ja muutokset ovat jsonb', '2',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'alignment_reviews'
             and column_name in ('snapshot', 'adjustments') and data_type = 'jsonb')

  -- ================================================================
  -- RAJOITTEET
  -- ================================================================

  union all
  select '15', 'rajoitteet', 'life_areas: kuusi CHECK-rajoitetta', '6',
         (select count(*)::text from pg_constraint
           where conrelid = 'public.life_areas'::regclass and contype = 'c'
             and conname in ('life_areas_name_check', 'life_areas_description_check',
                             'life_areas_importance_check', 'life_areas_target_check',
                             'life_areas_category_check', 'life_areas_sort_order_check'))

  union all
  select '16', 'rajoitteet', 'weekly_capacities: nelja CHECK-rajoitetta', '4',
         (select count(*)::text from pg_constraint
           where conrelid = 'public.weekly_capacities'::regclass and contype = 'c'
             and conname in ('weekly_capacities_week_start_check',
                             'weekly_capacities_minutes_check',
                             'weekly_capacities_energy_check',
                             'weekly_capacities_note_check'))

  union all
  select '17', 'rajoitteet', 'time_entries: kolme CHECK-rajoitetta', '3',
         (select count(*)::text from pg_constraint
           where conrelid = 'public.time_entries'::regclass and contype = 'c'
             and conname in ('time_entries_minutes_check', 'time_entries_source_check',
                             'time_entries_note_check'))

  union all
  select '18', 'rajoitteet', 'alignment_reviews: viisi CHECK-rajoitetta', '5',
         (select count(*)::text from pg_constraint
           where conrelid = 'public.alignment_reviews'::regclass and contype = 'c'
             and conname in ('alignment_reviews_week_start_check',
                             'alignment_reviews_version_check',
                             'alignment_reviews_snapshot_check',
                             'alignment_reviews_reflection_check',
                             'alignment_reviews_adjustments_check'))

  union all
  select '19', 'rajoitteet', 'Nelja omistajan rivin avainta', '4',
         (select count(*)::text from pg_constraint
           where contype = 'u'
             and conname in ('life_areas_owner_row_key', 'weekly_capacities_owner_row_key',
                             'time_entries_owner_row_key', 'alignment_reviews_owner_row_key'))

  union all
  -- YKSI VIIKKO, YKSI RIVI. Uniikkirajoite kattaa KAKSI saraketta:
  -- pelkka week_start estaisi toista kayttajaa asettamasta samaa viikkoa.
  select '20', 'rajoitteet', 'Nelja kaksisarakkeista uniikkirajoitetta (nimi, kategoria, 2 x viikko)', '4',
         (select count(*)::text from pg_constraint
           where contype = 'u' and array_length(conkey, 1) = 2
             and conname in ('life_areas_name_unique', 'life_areas_category_unique',
                             'weekly_capacities_week_unique', 'alignment_reviews_week_unique'))

  union all
  select '21', 'rajoitteet', 'time_entries.source sallii vain manual', '1',
         (select count(*)::text from pg_constraint
           where conname = 'time_entries_source_check'
             and pg_get_constraintdef(oid) like '%manual%'
             and pg_get_constraintdef(oid) not like '%,%')

  union all
  select '22', 'rajoitteet', 'Viikko alkaa maanantaina (kaksi rajoitetta)', '2',
         (select count(*)::text from pg_constraint
           where conname in ('weekly_capacities_week_start_check',
                             'alignment_reviews_week_start_check')
             and pg_get_constraintdef(oid) like '%isodow%')

  union all
  select '23', 'rajoitteet', 'Tarkeys on asteikolla 1-5', '1',
         (select count(*)::text from pg_constraint
           where conname = 'life_areas_importance_check'
             and pg_get_constraintdef(oid) like '%1%' and pg_get_constraintdef(oid) like '%5%')

  union all
  -- YHDISTELMAVIERASAVAIN ON SE, JOKA ESTAA RISTIINKIINNITYKSEN.
  select '24', 'rajoitteet', 'Nelja viitetta kahdella sarakkeella', '4',
         (select count(*)::text from pg_constraint
           where conname in ('goals_life_area_fkey', 'time_entries_life_area_fkey',
                             'time_entries_goal_fkey', 'time_entries_task_fkey')
             and contype = 'f'
             and array_length(conkey, 1) = 2)

  union all
  -- POISTOSAANTO RAJAA NOLLAUKSEN SARAKKEESEEN.
  select '25', 'rajoitteet', 'SET NULL rajaa nollauksen yhteen sarakkeeseen', '4',
         (select count(*)::text from pg_constraint
           where conname in ('goals_life_area_fkey', 'time_entries_life_area_fkey',
                             'time_entries_goal_fkey', 'time_entries_task_fkey')
             and confdeltype = 'n'
             and array_length(confdelsetcols, 1) = 1)

  union all
  -- ALUEEN POISTO EI VIE TAVOITETTA. Jos tama olisi CASCADE, alueen
  -- poistaminen poistaisi kayttajan tavoitteet.
  select '26', 'rajoitteet', 'Yksikaan uusi viite ei ole CASCADE sovellustauluun', '0',
         (select count(*)::text from pg_constraint
           where conname in ('goals_life_area_fkey', 'time_entries_life_area_fkey',
                             'time_entries_goal_fkey', 'time_entries_task_fkey')
             and confdeltype = 'c')

  union all
  -- KAYTTAJAN POISTO VIE RIVIT MUKANAAN.
  select '27', 'rajoitteet', 'Nelja user_id-vierasavainta on CASCADE', '4',
         (select count(*)::text from pg_constraint
           where contype = 'f' and confdeltype = 'c'
             and confrelid = 'auth.users'::regclass
             and conrelid in ('public.life_areas'::regclass,
                              'public.weekly_capacities'::regclass,
                              'public.time_entries'::regclass,
                              'public.alignment_reviews'::regclass))

  -- ================================================================
  -- RLS JA OIKEUDET
  -- ================================================================

  union all
  select '28', 'rls', 'RLS on paalla kaikissa neljassa taulussa', '4',
         (select count(*)::text from pg_class
           where relnamespace = 'public'::regnamespace
             and relname in ('life_areas', 'weekly_capacities', 'time_entries',
                             'alignment_reviews')
             and relrowsecurity)

  union all
  select '29', 'rls', 'Kuusitoista omistajuuspolitiikkaa', '16',
         (select count(*)::text from pg_policies
           where schemaname = 'public'
             and tablename in ('life_areas', 'weekly_capacities', 'time_entries',
                               'alignment_reviews'))

  union all
  select '30', 'rls', 'Yksikaan politiikka ei koske public-roolia', '0',
         (select count(*)::text from pg_policies
           where schemaname = 'public'
             and tablename in ('life_areas', 'weekly_capacities', 'time_entries',
                               'alignment_reviews')
             and 'public' = any(roles))

  union all
  select '31', 'rls', 'Jokainen politiikka koskee roolia authenticated', '16',
         (select count(*)::text from pg_policies
           where schemaname = 'public'
             and tablename in ('life_areas', 'weekly_capacities', 'time_entries',
                               'alignment_reviews')
             and 'authenticated' = any(roles))

  union all
  -- MOLEMMAT PUOLET: using JA with check. Pelkka using paivityksessa
  -- sallisi rivin siirtamisen toiselle kayttajalle.
  select '32', 'rls', 'Jokainen politiikka rajaa auth.uid() = user_id', '16',
         (select count(*)::text from pg_policies
           where schemaname = 'public'
             and tablename in ('life_areas', 'weekly_capacities', 'time_entries',
                               'alignment_reviews')
             and (coalesce(qual, '') like '%auth.uid()%user_id%'
                  or coalesce(with_check, '') like '%auth.uid()%user_id%'))

  union all
  select '33', 'rls', 'Paivityspolitiikoilla on molemmat puolet', '4',
         (select count(*)::text from pg_policies
           where schemaname = 'public'
             and tablename in ('life_areas', 'weekly_capacities', 'time_entries',
                               'alignment_reviews')
             and cmd = 'UPDATE' and qual is not null and with_check is not null)

  union all
  select '34', 'oikeudet', 'anon-roolilla ei ole oikeuksia', '0',
         (select count(*)::text from information_schema.role_table_grants
           where table_schema = 'public'
             and table_name in ('life_areas', 'weekly_capacities', 'time_entries',
                                'alignment_reviews')
             and grantee in ('anon', 'public'))

  union all
  select '35', 'oikeudet', 'authenticated saa nelja oikeutta neljaan tauluun', '16',
         (select count(*)::text from information_schema.role_table_grants
           where table_schema = 'public'
             and table_name in ('life_areas', 'weekly_capacities', 'time_entries',
                                'alignment_reviews')
             and grantee = 'authenticated'
             and privilege_type in ('SELECT', 'INSERT', 'UPDATE', 'DELETE'))

  union all
  select '36', 'oikeudet', 'PUBLIC-roolilla ei ole oikeuksia (aclexplode)', '0',
         (select count(*)::text
            from pg_class c2, lateral aclexplode(c2.relacl) a
           where c2.relnamespace = 'public'::regnamespace
             and c2.relname in ('life_areas', 'weekly_capacities', 'time_entries',
                                'alignment_reviews')
             and a.grantee = 0)

  union all
  select '37', 'oikeudet', 'anon-roolilla ei ole tehollista lukuoikeutta', 'false',
         (select bool_or(has_table_privilege('anon', t, 'select'))::text
            from unnest(array['public.life_areas', 'public.weekly_capacities',
                              'public.time_entries', 'public.alignment_reviews']) as t)

  union all
  select '38', 'oikeudet', 'authenticated-roolilla on tehollinen lukuoikeus kaikkiin', 'true',
         (select bool_and(has_table_privilege('authenticated', t, 'select'))::text
            from unnest(array['public.life_areas', 'public.weekly_capacities',
                              'public.time_entries', 'public.alignment_reviews']) as t)

  -- ================================================================
  -- INDEKSIT JA LIIPAISIMET
  -- ================================================================

  union all
  select '39', 'indeksit', 'Kolme nimettya indeksia on olemassa', '3',
         (select count(*)::text from pg_indexes
           where schemaname = 'public'
             and indexname in ('life_areas_user_active_idx', 'time_entries_user_date_idx',
                               'goals_user_life_area_idx'))

  union all
  select '40', 'liipaisimet', 'Nelja touch_updated_at -liipaisinta', '4',
         (select count(*)::text from pg_trigger
           where not tgisinternal
             and tgname in ('life_areas_touch_updated_at', 'weekly_capacities_touch_updated_at',
                            'time_entries_touch_updated_at', 'alignment_reviews_touch_updated_at'))

  union all
  select '41', 'liipaisimet', 'touch_updated_at on yha SECURITY INVOKER', 'false',
         (select p.prosecdef::text from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'touch_updated_at')

  -- ================================================================
  -- DATAN EHEYS
  -- ================================================================

  union all
  select '42', 'data', 'Jokainen tavoitteen alue on omistajan oma', '0',
         (select count(*)::text from public.goals g
           where g.life_area_id is not null
             and not exists (select 1 from public.life_areas a
                              where a.id = g.life_area_id and a.user_id = g.user_id))

  union all
  select '43', 'data', 'Jokainen kirjatun ajan alue on omistajan oma', '0',
         (select count(*)::text from public.time_entries e
           where e.life_area_id is not null
             and not exists (select 1 from public.life_areas a
                              where a.id = e.life_area_id and a.user_id = e.user_id))

  -- ================================================================
  -- OLEMASSA OLEVA DATA
  -- ================================================================

  union all
  select '44', 'vanha data', 'tasks, goals ja projects: yha kaksitoista politiikkaa', '12',
         (select count(*)::text from pg_policies
           where schemaname = 'public'
             and tablename in ('tasks', 'goals', 'projects'))

  union all
  select '45', 'vanha data', 'goals_owner_row_key ja tasks_owner_row_key yha olemassa', '2',
         (select count(*)::text from pg_constraint
           where conname in ('goals_owner_row_key', 'tasks_owner_row_key') and contype = 'u')

  union all
  -- Heti migraation jalkeen odotus on 0: taytto ei kuulu migraatioon.
  -- Kun portti on auki, luku kertoo kuinka moni tavoite on liitetty.
  select '46', 'vanha data', 'Alueeseen liitettyja tavoitteita', 'INFO',
         (select count(*)::text from public.goals where life_area_id is not null)

  union all
  select '47', 'vanha data', 'Tavoitteiden lukumaara (vertaa inventaarioon)', 'INFO',
         (select count(*)::text from public.goals)

  -- ================================================================
  -- KIRJATTAVAT
  -- ================================================================

  union all
  select '48', 'kirjattavat', 'Elamanalueiden lukumaara', 'INFO',
         (select count(*)::text from public.life_areas)

  union all
  select '49', 'kirjattavat', 'Kapasiteettiviikkojen lukumaara', 'INFO',
         (select count(*)::text from public.weekly_capacities)

  union all
  select '50', 'kirjattavat', 'Kirjattujen aikojen lukumaara', 'INFO',
         (select count(*)::text from public.time_entries)

  union all
  select '51', 'kirjattavat', 'Viikkokatsausten lukumaara', 'INFO',
         (select count(*)::text from public.alignment_reviews)

  union all
  select '52', 'kirjattavat', 'Tietokanta', 'INFO', current_database()

  union all
  select '53', 'kirjattavat', 'Varmistuksen hetki (UTC)', 'INFO',
         to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS')

) c
order by c.check_no;
