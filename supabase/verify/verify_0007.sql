-- Varmistus: 0007_finance
-- VAIN LUKEVA. Yksi lause, yksi taulukko, yksi kopiointi.
-- Aja heti migraation jalkeen.
--
-- ODOTUS: jokaisen PASS/FAIL-rivin status = 'PASS' ja
-- poikkeavia_yhteensa = 0. Yksikin FAIL tarkoittaa, ettei lippuja
-- bills, recurringExpenses ja savingsGoals saa kaantaa.
--
-- KAKSI ASIAA, JOTKA TAMA ERITYISESTI TODISTAA
--
-- 1. OMISTAJUUS. Laskun molemmat viitteet — tehtavaan ja toistuvaan
--    kuluun — ovat yhdistelmavierasavaimia. Ilman sita kayttaja B voisi
--    liittaa oman laskunsa kayttajan A tehtavaan: RLS ei estaisi sita,
--    koska B:n rivin omistaja on B. Tarkistukset 11-17.
--
-- 2. RAHA ON KOKONAISLUKU. Jos jokin summasarake olisi numeric tai
--    liukuluku, sentit katoaisivat JavaScript-muunnoksessa hiljaa.
--    Tarkistukset 18-20.
--
-- TAMA MIGRAATIO KOSKI TUOTANNON tasks-TAULUUN. Se lisasi siihen
-- rajoitteen tasks_owner_row_key. Tarkistukset 25-28 todistavat, ettei
-- muuta muuttunut.
--
-- Rakenne luetaan KATALOGEISTA, ei nimista.
--
-- Tama tiedosto EI lue laskujen nimia, summia eika muistiinpanoja.

select c.check_no, c.section, c.check_name,
       case when c.odotus = 'INFO' then 'INFO'
            when c.toteutui = c.odotus then 'PASS' else 'FAIL' end as status,
       case when c.odotus = 'INFO' then c.toteutui
            else 'odotus ' || c.odotus || ', toteutui ' || c.toteutui end as details,
       count(*) filter (where c.odotus <> 'INFO' and c.toteutui <> c.odotus)
         over () as poikkeavia_yhteensa
from (

  -- ================================================================
  -- TAULUT JA SARAKKEET
  -- ================================================================

  select '01' as check_no, 'taulut' as section,
         'Kaikki kolme taulua ovat olemassa' as check_name,
         '3' as odotus,
         (select count(*)::text from pg_tables
           where schemaname = 'public'
             and tablename in ('bills', 'recurring_expenses',
                               'savings_goals')) as toteutui

  union all
  select '02', 'taulut', 'recurring_expenses: rakenteelliset sarakkeet', '13',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'recurring_expenses'
             and column_name in ('id', 'user_id', 'name', 'amount_minor',
                                 'currency', 'cadence', 'day_of_month',
                                 'next_due_date', 'category', 'active', 'note',
                                 'created_at', 'updated_at'))

  union all
  select '03', 'taulut', 'recurring_expenses: ei nimeamattomia sarakkeita', '0',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'recurring_expenses'
             and column_name not in ('id', 'user_id', 'name', 'amount_minor',
                                     'currency', 'cadence', 'day_of_month',
                                     'next_due_date', 'category', 'active', 'note',
                                     'created_at', 'updated_at'))

  union all
  select '04', 'taulut', 'bills: rakenteelliset sarakkeet', '14',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'bills'
             and column_name in ('id', 'user_id', 'name', 'amount_minor',
                                 'currency', 'due_date', 'status', 'paid_date',
                                 'category', 'task_id', 'recurring_expense_id',
                                 'note', 'created_at', 'updated_at'))

  union all
  select '05', 'taulut', 'bills: ei nimeamattomia sarakkeita', '0',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'bills'
             and column_name not in ('id', 'user_id', 'name', 'amount_minor',
                                     'currency', 'due_date', 'status', 'paid_date',
                                     'category', 'task_id', 'recurring_expense_id',
                                     'note', 'created_at', 'updated_at'))

  union all
  select '06', 'taulut', 'savings_goals: rakenteelliset sarakkeet', '10',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'savings_goals'
             and column_name in ('id', 'user_id', 'name', 'target_minor',
                                 'current_minor', 'currency', 'target_date',
                                 'note', 'created_at', 'updated_at'))

  union all
  select '07', 'taulut', 'savings_goals: ei nimeamattomia sarakkeita', '0',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'savings_goals'
             and column_name not in ('id', 'user_id', 'name', 'target_minor',
                                     'current_minor', 'currency', 'target_date',
                                     'note', 'created_at', 'updated_at'))

  union all
  -- Kokonaismaara erikseen: kolmen luvun on oltava keskenaan
  -- johdonmukaiset, muuten puuttuva sarake voisi peittya tuntemattoman
  -- taakse.
  select '08', 'taulut', 'Sarakkeita on yhteensa tasan 37', '37',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public'
             and table_name in ('bills', 'recurring_expenses', 'savings_goals'))

  union all
  -- Viisi + viisi + kolme. Luku on migraation objektilaskennasta, ei
  -- arvattu: jos tarkiste katoaa, kanta hyvaksyisi rivin jonka domain
  -- hylkaisi — ja ero nakyisi vasta silloin kun sovellus luottaa siihen,
  -- etta kanta piti huolen.
  select '09', 'rajoitteet', 'Kaikki 13 tarkistetta ovat olemassa', '13',
         (select count(*)::text from pg_constraint
           where conname in ('recurring_expenses_cadence_check',
                             'recurring_expenses_amount_check',
                             'recurring_expenses_day_check',
                             'recurring_expenses_currency_check',
                             'recurring_expenses_name_check',
                             'bills_status_check', 'bills_amount_check',
                             'bills_currency_check', 'bills_name_check',
                             'bills_paid_date_check',
                             'savings_goals_amount_check',
                             'savings_goals_currency_check',
                             'savings_goals_name_check')
             and contype = 'c')

  union all
  -- Kiireellisyys (upcoming/due/overdue) on JOHDETTU erapaivasta eika
  -- sarake. Tallennettuna se vanhenisi heti seuraavana paivana ja
  -- nayttaisi vaaraa tietoa juuri silloin kun sita tarvitaan.
  select '10', 'taulut', 'Kiireellisyytta ei ole tallennettu sarakkeeksi', '0',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'bills'
             and column_name in ('urgency', 'is_overdue', 'is_due', 'days_left'))

  -- ================================================================
  -- OMISTAJUUSINVARIANTTI
  -- ================================================================

  union all
  -- Omistajan rivin avaimet ovat yhdistelmavierasavainten kohteita.
  -- tasks_owner_row_key lisattiin TUOTANNON tauluun; ilman sita laskun
  -- viitetta tehtavaan ei olisi voitu luoda lainkaan.
  select '11', 'omistajuus', 'Omistajan rivin avaimet (user_id, id) ovat olemassa', '2',
         (select count(*)::text from pg_constraint con
           where con.conname in ('tasks_owner_row_key',
                                 'recurring_expenses_owner_row_key')
             and con.contype = 'u'
             and (select array_agg(a.attname::text order by a.attname)
                    from unnest(con.conkey) k(attnum)
                    join pg_attribute a
                      on a.attrelid = con.conrelid and a.attnum = k.attnum)
                 = array['id', 'user_id'])

  union all
  -- LASKUN MOLEMMAT VIITTEET OVAT YHDISTELMIA.
  --
  -- Rakenne luetaan katalogista eika nimesta: conkey kertoo montako
  -- saraketta avaimessa on, ja user_id:n on oltava yksi niista.
  --
  -- confdeltype = 'n' on ON DELETE SET NULL. confdelsetcols kertoo
  -- MITKA sarakkeet nollataan — sen on oltava tasan yksi eika user_id.
  -- Jos confdelsetcols olisi NULL, tehtavan poisto yrittaisi nollata
  -- myos user_id:n ja kaatuisi NOT NULL -virheeseen joka kerta.
  select '12', 'omistajuus', 'Laskun kaksi omistajuusviitetta ovat yhdistelmia', '2',
         (select count(*)::text
            from pg_constraint con
            join pg_class t on t.oid = con.conrelid
           where con.conname in ('bills_task_id_fkey',
                                 'bills_recurring_expense_id_fkey')
             and con.contype = 'f'
             and array_length(con.conkey, 1) = 2
             and con.confdeltype = 'n'
             and array_length(con.confdelsetcols, 1) = 1
             and exists (select 1 from unnest(con.conkey) k(attnum)
                           join pg_attribute a
                             on a.attrelid = t.oid and a.attnum = k.attnum
                          where a.attname = 'user_id')
             and not exists (select 1 from unnest(con.confdelsetcols) k(attnum)
                               join pg_attribute a
                                 on a.attrelid = t.oid and a.attnum = k.attnum
                              where a.attname = 'user_id'))

  union all
  select '13', 'omistajuus', 'Viitteiden kohde on aina pari (user_id, id)', '2',
         (select count(*)::text
            from pg_constraint con
            join pg_class ft on ft.oid = con.confrelid
           where con.conname in ('bills_task_id_fkey',
                                 'bills_recurring_expense_id_fkey')
             and con.contype = 'f'
             and (select array_agg(a.attname::text order by a.attname)
                    from unnest(con.confkey) k(attnum)
                    join pg_attribute a
                      on a.attrelid = ft.oid and a.attnum = k.attnum)
                 = array['id', 'user_id'])

  union all
  -- ERI VAITE KUIN 12: tama laskee ETTEI vaaria ole. Kumpikaan yksin ei
  -- riita — migraatio olisi voinut luoda oikean viitteen ja jattaa
  -- vanhan viereen, jolloin heikompi paastaisi rivin lapi.
  --
  -- tasks on mukana, koska 0007 teki siita ensimmaista kertaa
  -- viittauksen kohteen.
  select '14', 'omistajuus', 'Yhtaan yhden sarakkeen viitetta naihin tauluihin ei ole', '0',
         (select count(*)::text
            from pg_constraint con
            join pg_class ft on ft.oid = con.confrelid
           where con.contype = 'f'
             and ft.relnamespace = 'public'::regnamespace
             and ft.relname in ('tasks', 'recurring_expenses', 'bills',
                                'savings_goals')
             and array_length(con.conkey, 1) < 2)

  union all
  -- MATCH SIMPLE ohittaa tarkistuksen, jos yksikin avaimen sarake on
  -- NULL. Jos user_id sallisi NULLin, koko suoja katoaisi hiljaa.
  select '15', 'omistajuus', 'Omistajasarake on NOT NULL kaikissa neljassa taulussa', '4',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public'
             and table_name in ('tasks', 'bills', 'recurring_expenses',
                                'savings_goals')
             and column_name = 'user_id' and is_nullable = 'NO')

  union all
  select '16', 'omistajuus', 'Omistajan asettaa kanta, ei asiakas', '3',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public'
             and table_name in ('bills', 'recurring_expenses', 'savings_goals')
             and column_name = 'user_id'
             and column_default like '%auth.uid()%')

  union all
  select '17', 'omistajuus', 'Kayttajan poisto siivoaa kaikki kolme taulua', '3',
         (select count(*)::text
            from pg_constraint con
            join pg_class ft on ft.oid = con.confrelid
            join pg_namespace fn on fn.oid = ft.relnamespace
           where con.conrelid in ('public.bills'::regclass,
                                  'public.recurring_expenses'::regclass,
                                  'public.savings_goals'::regclass)
             and con.contype = 'f'
             and fn.nspname = 'auth' and ft.relname = 'users'
             and con.confdeltype = 'c')

  -- ================================================================
  -- RAHA ON KOKONAISLUKU
  -- ================================================================

  union all
  -- Liukuluku ei esita desimaalimurtolukuja tarkasti ja virhe kertautuu
  -- summattaessa. numeric olisi tarkka, mutta se palautuu
  -- JavaScriptiin merkkijonona tai liukulukuna ajurin mukaan — ja juuri
  -- se muunnos on se kohta, jossa sentit katoavat.
  select '18', 'raha', 'Kaikki summasarakkeet ovat bigint-tyyppisia', '4',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public'
             and table_name in ('bills', 'recurring_expenses', 'savings_goals')
             and column_name like '%\_minor'
             and data_type = 'bigint')

  union all
  select '19', 'raha', 'Summasarakkeita on tasan nelja', '4',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public'
             and table_name in ('bills', 'recurring_expenses', 'savings_goals')
             and column_name like '%\_minor')

  union all
  -- Valuutta on aina mukana. Eri valuuttoja ei summata yhteen missaan
  -- kohtaa, joten jokaisen rivin on tiedettava omansa.
  select '20', 'raha', 'Jokaisella taululla on valuutta oletuksella EUR', '3',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public'
             and table_name in ('bills', 'recurring_expenses', 'savings_goals')
             and column_name = 'currency'
             and is_nullable = 'NO'
             and column_default like '%EUR%')

  -- ================================================================
  -- INDEKSIT, LIIPAISIMET JA RLS
  -- ================================================================

  union all
  select '21', 'indeksit', 'Kaikki nelja hakuindeksia ovat olemassa', '4',
         (select count(*)::text from pg_indexes
           where schemaname = 'public'
             and indexname in ('recurring_expenses_user_active_idx',
                               'bills_user_status_due_idx', 'bills_user_due_idx',
                               'savings_goals_user_idx'))

  union all
  -- Osittainen indeksi: vain avoimet laskut. Ilman ehtoa se kasvaisi
  -- maksettujen mukana eika palvelisi sita kyselya, jota varten se on.
  select '22', 'indeksit', 'Avointen laskujen indeksi on osittainen', '1',
         (select count(*)::text
            from pg_index i
            join pg_class ic on ic.oid = i.indexrelid
           where ic.relname = 'bills_user_due_idx'
             and i.indpred is not null)

  union all
  -- Ajoitus luetaan tgtype-biteista: 1 = rivikohtainen, 2 = before,
  -- 16 = update. Nimi ei kerro milloin liipaisin ajetaan.
  select '23', 'liipaisimet', 'updated_at paivittyy ennen rivin muutosta', '3',
         (select count(*)::text from pg_trigger
           where not tgisinternal
             and tgname in ('bills_touch_updated_at',
                            'recurring_expenses_touch_updated_at',
                            'savings_goals_touch_updated_at')
             and (tgtype & 1) = 1 and (tgtype & 2) = 2 and (tgtype & 16) = 16)

  union all
  select '24', 'liipaisimet', 'Funktio touch_updated_at on yha kovennettu', '1',
         (select count(*)::text from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'touch_updated_at'
             and p.prosecdef = false
             and p.proconfig is not null
             and exists (select 1 from unnest(p.proconfig) a
                          where a like 'search\_path=%'))

  union all
  select '25', 'rls', 'RLS on paalla kaikissa kolmessa taulussa', '3',
         (select count(*)::text from pg_class
           where relnamespace = 'public'::regnamespace
             and relname in ('bills', 'recurring_expenses', 'savings_goals')
             and relrowsecurity)

  union all
  -- Politiikan OLEMASSAOLO ei todista mitaan: `using (true)` nayttaisi
  -- luettelossa aivan samalta. Siksi ehdot luetaan ja verrataan — ja
  -- MOLEMMAT puolet.
  select '26', 'rls', 'Kaksitoista omistajuuspolitiikkaa oikein ehdoin', '12',
         (select count(*)::text
            from pg_policies p
            join (values
                    ('bills',              'SELECT', 'auth.uid()=user_id', ''),
                    ('bills',              'INSERT', '',                   'auth.uid()=user_id'),
                    ('bills',              'UPDATE', 'auth.uid()=user_id', 'auth.uid()=user_id'),
                    ('bills',              'DELETE', 'auth.uid()=user_id', ''),
                    ('recurring_expenses', 'SELECT', 'auth.uid()=user_id', ''),
                    ('recurring_expenses', 'INSERT', '',                   'auth.uid()=user_id'),
                    ('recurring_expenses', 'UPDATE', 'auth.uid()=user_id', 'auth.uid()=user_id'),
                    ('recurring_expenses', 'DELETE', 'auth.uid()=user_id', ''),
                    ('savings_goals',      'SELECT', 'auth.uid()=user_id', ''),
                    ('savings_goals',      'INSERT', '',                   'auth.uid()=user_id'),
                    ('savings_goals',      'UPDATE', 'auth.uid()=user_id', 'auth.uid()=user_id'),
                    ('savings_goals',      'DELETE', 'auth.uid()=user_id', '')
                 ) e(tbl, operaatio, q, wc)
              on e.tbl = p.tablename and e.operaatio = p.cmd
             and p.policyname = e.tbl || '_' || lower(e.operaatio) || '_own'
             and btrim(replace(coalesce(p.qual, ''), ' ', ''), '()') = e.q
             and btrim(replace(coalesce(p.with_check, ''), ' ', ''), '()') = e.wc
           where p.schemaname = 'public' and p.roles = '{authenticated}'::name[])

  union all
  select '27', 'rls', 'Uusissa tauluissa ei ole ylimaaraisia politiikkoja', '12',
         (select count(*)::text from pg_policies
           where schemaname = 'public'
             and tablename in ('bills', 'recurring_expenses', 'savings_goals'))

  -- ================================================================
  -- OIKEUDET
  -- ================================================================

  union all
  select '28', 'oikeudet', 'anon-roolilla ei ole tehollista oikeutta uusiin tauluihin', '0',
         (select count(*)::text
            from (select unnest(array['public.bills', 'public.recurring_expenses',
                                      'public.savings_goals']) as taulu) tt
            cross join (select unnest(array['select', 'insert', 'update', 'delete',
                                            'truncate', 'references', 'trigger']) as oikeus) pp
           where has_table_privilege('anon', tt.taulu, pp.oikeus))

  union all
  -- Kaksi menetelmaa, koska kumpikaan ei yksin riita: has_table_privilege
  -- kertoo ONKO oikeus (perinta mukaan lukien), aclexplode kertoo MISTA
  -- se tulee.
  select '29', 'oikeudet', 'PUBLIC-roolilla ei ole oikeuksia uusiin tauluihin', '0',
         (select count(*)::text
            from pg_class cl, aclexplode(cl.relacl) acl
           where cl.oid = any (array['public.bills'::regclass,
                                     'public.recurring_expenses'::regclass,
                                     'public.savings_goals'::regclass])
             and acl.grantee = 0)

  union all
  select '30', 'oikeudet', 'authenticated-roolilla on tasan CRUD kaikkiin kolmeen', '12',
         (select count(*)::text
            from (select unnest(array['public.bills', 'public.recurring_expenses',
                                      'public.savings_goals']) as taulu) tt
            cross join (select unnest(array['select', 'insert', 'update', 'delete',
                                            'truncate', 'references', 'trigger']) as oikeus) pp
           where has_table_privilege('authenticated', tt.taulu, pp.oikeus))

  -- ================================================================
  -- TUOTANNON tasks-TAULU ON MUUTEN KOSKEMATON
  -- ================================================================
  -- Tama migraatio lisasi siihen tasan yhden rajoitteen. Nama neljä
  -- tarkistusta todistavat, ettei muuta muuttunut.

  union all
  select '31', 'vanha data', 'RLS on yha paalla tauluissa tasks ja profile', '2',
         (select count(*)::text from pg_class
           where relnamespace = 'public'::regnamespace
             and relname in ('tasks', 'profile') and relrowsecurity)

  union all
  select '32', 'vanha data', 'tasks-taulussa on yha nelja politiikkaa', '4',
         (select count(*)::text from pg_policies
           where schemaname = 'public' and tablename = 'tasks')

  union all
  select '33', 'vanha data', 'Omistajattomia tehtavia ei ole', '0',
         (select count(*)::text from public.tasks where user_id is null)

  union all
  select '34', 'vanha data', 'Orpoja omistajaviittauksia ei ole tehtavissa', '0',
         (select count(*)::text from public.tasks t
            left join auth.users u on u.id = t.user_id
           where u.id is null)

  union all
  select '35', 'vanha data', 'Uudet taulut ovat tyhjia', '0',
         ((select count(*) from public.bills)
        + (select count(*) from public.recurring_expenses)
        + (select count(*) from public.savings_goals))::text

  -- ================================================================
  -- KIRJATTAVAT
  -- ================================================================

  union all
  select '36', 'kirjattavat', 'Tehtavien lukumaara', 'INFO',
         (select count(*)::text from public.tasks)

  union all
  select '37', 'kirjattavat', 'Tietokanta', 'INFO', current_database()

  union all
  select '38', 'kirjattavat', 'Varmistuksen hetki (UTC)', 'INFO',
         to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS')

) c
order by c.check_no;
