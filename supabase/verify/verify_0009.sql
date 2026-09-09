-- Varmistus: 0009_finance_2
-- VAIN LUKEVA. Yksi lause, yksi taulukko, yksi kopiointi.
-- Aja heti migraation jalkeen.
--
-- ODOTUS: jokaisen PASS/FAIL-rivin status = 'PASS' ja
-- poikkeavia_yhteensa = 0. Yksikin FAIL tarkoittaa, ettei lippuja
-- transactions, investments eika BILL_PAYMENT_FIELDS saa kaantaa.
--
-- KOLME ASIAA, JOTKA TAMA ERITYISESTI TODISTAA
--
-- 1. SUMMA ON AINA POSITIIVINEN. Suunta tulee sarakkeesta kind, ei
--    etumerkista. Jos amount_check katoaisi, negatiivinen meno ja
--    positiivinen tulo alkaisivat tarkoittaa samaa asiaa kahdella eri
--    tavalla — ja budjetti laskisi molemmat. Tarkistukset 09 ja 24.
--
-- 2. source_id EI OLE VIERASAVAIN, eika siita saa tehda sellaista.
--    Lahde saa kadota, mutta tapahtuman on sailyttava: poistettu lasku
--    ei tee maksua tapahtumattomaksi. Tarkistus 14.
--
-- 3. TUNTEMATON SIJOITUKSEN ARVO EI SAA VAITTAA OLEVANSA KIRJATTU.
--    current_value_minor on NULL kun arvoa ei tiedeta — ei nolla — ja
--    silloin value_source on pakko olla 'unknown'. Tarkistus 21.
--
-- Rakenne luetaan KATALOGEISTA, ei nimista.
--
-- Tama tiedosto EI lue sarakkeita description, note, payee, iban eika
-- reference. Ne ovat kayttajan omaa tietoa, ja varmistus tarvitsee
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
  -- TAULUT JA SARAKKEET
  -- ================================================================

  select '01' as check_no, 'taulut' as section,
         'Taulut transactions ja investments ovat olemassa' as check_name,
         '2' as odotus,
         (select count(*)::text from pg_tables
           where schemaname = 'public'
             and tablename in ('transactions', 'investments')) as toteutui

  union all
  select '02', 'taulut', 'transactions: odotetut sarakkeet ovat olemassa', '14',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'transactions'
             and column_name in ('id', 'user_id', 'kind', 'origin', 'amount_minor',
                                 'currency', 'date', 'category', 'description',
                                 'note', 'source_kind', 'source_id',
                                 'created_at', 'updated_at'))

  union all
  -- Kokonaismaara yksin ei todista mitaan: se voisi tasmata, vaikka
  -- odotettu sarake puuttuisi ja tilalla olisi tuntematon.
  select '03', 'taulut', 'transactions: ei nimeamattomia sarakkeita', '0',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'transactions'
             and column_name not in ('id', 'user_id', 'kind', 'origin', 'amount_minor',
                                     'currency', 'date', 'category', 'description',
                                     'note', 'source_kind', 'source_id',
                                     'created_at', 'updated_at'))

  union all
  select '04', 'taulut', 'investments: odotetut sarakkeet ovat olemassa', '15',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'investments'
             and column_name in ('id', 'user_id', 'name', 'symbol', 'kind',
                                 'quantity', 'cost_basis_minor', 'current_value_minor',
                                 'valued_on', 'value_source', 'currency',
                                 'target_value_minor', 'note', 'created_at',
                                 'updated_at'))

  union all
  select '05', 'taulut', 'investments: ei nimeamattomia sarakkeita', '0',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'investments'
             and column_name not in ('id', 'user_id', 'name', 'symbol', 'kind',
                                     'quantity', 'cost_basis_minor', 'current_value_minor',
                                     'valued_on', 'value_source', 'currency',
                                     'target_value_minor', 'note', 'created_at',
                                     'updated_at'))

  union all
  -- RAHA ON KOKONAISLUKU. Liukuluku olisi tassa hiljainen vika: se
  -- toimisi vuosia ja alkaisi sitten harhautua senteissa.
  select '06', 'taulut', 'Uudet rahasarakkeet ovat bigint', '4',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public'
             and ((table_name = 'transactions' and column_name = 'amount_minor')
               or (table_name = 'investments' and column_name in
                   ('cost_basis_minor', 'current_value_minor', 'target_value_minor')))
             and data_type = 'bigint')

  union all
  select '07', 'taulut', 'transactions.date on date, ei timestamptz', 'date',
         (select data_type::text from information_schema.columns
           where table_schema = 'public' and table_name = 'transactions'
             and column_name = 'date')

  union all
  -- MAARA EI OLE RAHAA. Osakkeita voi olla 12,5 ja kryptoa 0,00031.
  select '08', 'taulut', 'investments.quantity on numeric', 'numeric',
         (select data_type::text from information_schema.columns
           where table_schema = 'public' and table_name = 'investments'
             and column_name = 'quantity')

  -- ================================================================
  -- RAJOITTEET
  -- ================================================================

  union all
  select '09', 'rajoitteet', 'transactions: yhdeksan CHECK-rajoitetta', '9',
         (select count(*)::text from pg_constraint
           where conrelid = 'public.transactions'::regclass and contype = 'c'
             and conname in ('transactions_kind_check',
                             'transactions_origin_check',
                             'transactions_amount_check',
                             'transactions_currency_check',
                             'transactions_source_pair_check',
                             'transactions_source_kind_check',
                             'transactions_transfer_category_check',
                             'transactions_description_length_check',
                             'transactions_note_length_check'))

  union all
  select '10', 'rajoitteet', 'investments: seitseman CHECK-rajoitetta', '7',
         (select count(*)::text from pg_constraint
           where conrelid = 'public.investments'::regclass and contype = 'c'
             and conname in ('investments_kind_check',
                             'investments_value_source_check',
                             'investments_quantity_check',
                             'investments_amounts_check',
                             'investments_currency_check',
                             'investments_name_check',
                             'investments_unknown_value_check'))

  union all
  select '11', 'rajoitteet', 'bills: kolme uutta CHECK-rajoitetta', '3',
         (select count(*)::text from pg_constraint
           where conrelid = 'public.bills'::regclass and contype = 'c'
             and conname in ('bills_payee_length_check',
                             'bills_iban_check',
                             'bills_reference_check'))

  union all
  -- Omistajan rivin avain on se, jota yhdistelmavierasavain vaatii
  -- kohteeltaan. Sen puuttuminen huomattaisiin vasta kun joku yrittaa
  -- viitata naihin tauluihin.
  select '12', 'rajoitteet', 'Omistajan rivin avaimet ovat olemassa', '2',
         (select count(*)::text from pg_constraint
           where contype = 'u'
             and conname in ('transactions_owner_row_key',
                             'investments_owner_row_key'))

  union all
  select '13', 'rajoitteet', 'Vierasavaimet osoittavat vain auth.usersiin', '2',
         (select count(*)::text from pg_constraint
           where conrelid in ('public.transactions'::regclass,
                              'public.investments'::regclass)
             and contype = 'f'
             and confrelid = 'auth.users'::regclass)

  union all
  -- TARKEIN YKSITTAINEN TARKISTUS TASSA TIEDOSTOSSA.
  --
  -- source_id EI SAA OLLA VIERASAVAIN. Jos siita tehtaisiin sellainen,
  -- laskun poisto veisi maksukirjauksen mukanaan — juuri sen tiedon,
  -- jonka takia tapahtuma on olemassa.
  select '14', 'rajoitteet', 'transactions: ei vierasavaimia public-tauluihin', '0',
         (select count(*)::text from pg_constraint
           where conrelid = 'public.transactions'::regclass and contype = 'f'
             and confrelid <> 'auth.users'::regclass)

  -- ================================================================
  -- INDEKSIT
  -- ================================================================

  union all
  select '15', 'indeksit', 'Kolme nimettya indeksia on olemassa', '3',
         (select count(*)::text from pg_indexes
           where schemaname = 'public'
             and indexname in ('transactions_user_date_idx',
                               'transactions_user_source_idx',
                               'investments_user_name_idx'))

  -- ================================================================
  -- RLS JA OIKEUDET
  -- ================================================================

  union all
  select '16', 'rls', 'RLS on paalla molemmissa uusissa tauluissa', '2',
         (select count(*)::text from pg_class
           where relnamespace = 'public'::regnamespace
             and relname in ('transactions', 'investments')
             and relrowsecurity)

  union all
  select '17', 'rls', 'Kahdeksan omistajuuspolitiikkaa', '8',
         (select count(*)::text from pg_policies
           where schemaname = 'public'
             and tablename in ('transactions', 'investments'))

  union all
  -- Politiikka joka koskee rooleja {public} paastaisi anonin sisaan
  -- vaikka nimessa lukisi mita tahansa.
  select '18', 'rls', 'Yksikaan politiikka ei koske public-roolia', '0',
         (select count(*)::text from pg_policies
           where schemaname = 'public'
             and tablename in ('transactions', 'investments')
             and 'public' = any(roles))

  union all
  select '19', 'rls', 'anon-roolilla ei ole oikeuksia uusiin tauluihin', '0',
         (select count(*)::text from information_schema.role_table_grants
           where table_schema = 'public'
             and table_name in ('transactions', 'investments')
             and grantee in ('anon', 'public'))

  union all
  select '20', 'rls', 'authenticated saa nelja oikeutta kumpaankin', '8',
         (select count(*)::text from information_schema.role_table_grants
           where table_schema = 'public'
             and table_name in ('transactions', 'investments')
             and grantee = 'authenticated'
             and privilege_type in ('SELECT', 'INSERT', 'UPDATE', 'DELETE'))

  -- ================================================================
  -- DATAN EHEYS
  -- ================================================================

  union all
  -- Tuntematon arvo ei ole nolla eika kirjattu arvo. Jos tama ei
  -- pitaisi, kayttoliittyma laskisi tuoton arvatusta nykyarvosta.
  select '21', 'data', 'Tuntematon sijoitusarvo on aina lahteesta unknown', '0',
         (select count(*)::text from public.investments
           where current_value_minor is null and value_source <> 'unknown')

  union all
  select '22', 'data', 'Yksikaan tapahtuma ei ole ilman lahdeparia', '0',
         (select count(*)::text from public.transactions
           where (source_kind is null) <> (source_id is null))

  union all
  select '23', 'data', 'Siirroilla ei ole kululuokkaa', '0',
         (select count(*)::text from public.transactions
           where kind = 'transfer' and category is not null)

  union all
  select '24', 'data', 'Yksikaan summa ei ole nolla tai negatiivinen', '0',
         (select count(*)::text from public.transactions
           where amount_minor <= 0)

  union all
  select '25', 'data', 'Jokainen laji on sallittu', '0',
         (select count(*)::text from public.transactions
           where kind not in ('expense', 'income', 'transfer'))

  -- ================================================================
  -- VANHA DATA — MIKAAN EI SAANUT MUUTTUA
  -- ================================================================

  union all
  select '26', 'vanha data', 'bills-taulussa on yha nelja politiikkaa', '4',
         (select count(*)::text from pg_policies
           where schemaname = 'public' and tablename = 'bills')

  union all
  select '27', 'vanha data', 'tasks-taulussa on yha nelja politiikkaa', '4',
         (select count(*)::text from pg_policies
           where schemaname = 'public' and tablename = 'tasks')

  union all
  -- Uudet sarakkeet ovat NULLABLE. Jos jokin niista olisi NOT NULL,
  -- vanhat laskut olisivat kelvottomia.
  select '28', 'vanha data', 'bills: uudet sarakkeet ovat nullable', '3',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'bills'
             and column_name in ('payee', 'iban', 'reference')
             and is_nullable = 'YES')

  union all
  select '29', 'vanha data', 'touch_updated_at on yha SECURITY INVOKER', 'false',
         (select p.prosecdef::text from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'touch_updated_at')

  -- ================================================================
  -- KIRJATTAVAT
  -- ================================================================

  union all
  select '30', 'kirjattavat', 'Tapahtumien lukumaara', 'INFO',
         (select count(*)::text from public.transactions)

  union all
  select '31', 'kirjattavat', 'Sijoitusten lukumaara', 'INFO',
         (select count(*)::text from public.investments)

  union all
  select '32', 'kirjattavat', 'Laskujen lukumaara', 'INFO',
         (select count(*)::text from public.bills)

  union all
  select '33', 'kirjattavat', 'Tietokanta', 'INFO', current_database()

  union all
  select '34', 'kirjattavat', 'Varmistuksen hetki (UTC)', 'INFO',
         to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS')

) c
order by c.check_no;
