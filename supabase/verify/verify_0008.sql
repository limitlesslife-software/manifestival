-- Varmistus: 0008_ai_audit
-- VAIN LUKEVA. Yksi lause, yksi taulukko, yksi kopiointi.
-- Aja heti migraation jalkeen.
--
-- ODOTUS: jokaisen PASS/FAIL-rivin status = 'PASS' ja
-- poikkeavia_yhteensa = 0. Yksikin FAIL tarkoittaa, ettei lippua
-- aiAudit saa kaantaa.
--
-- KAKSI ASIAA, JOTKA TAMA ERITYISESTI TODISTAA
--
-- 1. KESKEINEN INVARIANTTI. Kirjaus ei saa vaittaa, etta komento
--    suoritettiin ilman vahvistusta. Migraatio testaa taman ajaessaan
--    oikealla insertilla; tama tarkistaa, etta rajoite on yha
--    paikallaan ja ETTEI YKSIKAAN RIVI riko sita. Tarkistukset 08-10.
--
-- 2. target_id EI OLE VIERASAVAIN, eika siita saa tehda sellaista.
--    Kirjaus kertoo mita tapahtui, ja yleisin kirjattava tapahtuma on
--    POISTO. Vierasavain poistaisi tai tyhjentaisi kirjauksen kohteen
--    mukana — juuri sen tiedon, jonka takia loki on olemassa.
--    Tarkistus 11.
--
-- Rakenne luetaan KATALOGEISTA, ei nimista.
--
-- Tama tiedosto EI lue sarakkeita input_summary eika proposal. Ne ovat
-- kayttajan omaa tekstia, ja koko taulun tarkoitus on rajata sen maaraa.

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
         'Taulu ai_action_audit on olemassa' as check_name,
         '1' as odotus,
         (select count(*)::text from pg_tables
           where schemaname = 'public' and tablename = 'ai_action_audit') as toteutui

  union all
  select '02', 'taulut', 'Rakenteelliset sarakkeet ovat olemassa', '14',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'ai_action_audit'
             and column_name in ('id', 'user_id', 'occurred_at', 'input_summary',
                                 'intent', 'risk', 'target_type', 'target_id',
                                 'proposal', 'confirmed', 'executed', 'result',
                                 'error_code', 'created_at'))

  union all
  -- Kokonaismaara yksin ei todista mitaan: se voisi tasmata, vaikka
  -- odotettu sarake puuttuisi ja tilalla olisi tuntematon. Tassa
  -- taulussa tuntematon sarake olisi erityisen paha — se voisi olla
  -- juuri se raaka syote, jota ei ole tarkoitus tallentaa.
  select '03', 'taulut', 'Taulussa ei ole nimeamattomia sarakkeita', '0',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'ai_action_audit'
             and column_name not in ('id', 'user_id', 'occurred_at', 'input_summary',
                                     'intent', 'risk', 'target_type', 'target_id',
                                     'proposal', 'confirmed', 'executed', 'result',
                                     'error_code', 'created_at'))

  union all
  select '04', 'taulut', 'Taulussa on tasan 14 saraketta', '14',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'ai_action_audit')

  union all
  -- Kirjaus ei muutu jalkikateen, joten sille ei ole mita koskettaa.
  -- Jos updated_at ilmestyisi, se tarkoittaisi etta jokin muokkaa
  -- kirjausketjua — ja muokattava kirjausketju ei ole kirjausketju.
  select '05', 'taulut', 'Taulussa ei ole updated_at-saraketta', '0',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'ai_action_audit'
             and column_name = 'updated_at')

  union all
  select '06', 'taulut', 'Liipaisinta ei ole', '0',
         (select count(*)::text from pg_trigger
           where not tgisinternal
             and tgrelid = 'public.ai_action_audit'::regclass)

  union all
  select '07', 'rajoitteet', 'Kaikki viisi tarkistetta ovat olemassa', '5',
         (select count(*)::text from pg_constraint
           where conname in ('ai_action_audit_result_check',
                             'ai_action_audit_risk_check',
                             'ai_action_audit_summary_length_check',
                             'ai_action_audit_proposal_length_check',
                             'ai_action_audit_confirmed_check')
             and contype = 'c')

  -- ================================================================
  -- KESKEINEN INVARIANTTI
  -- ================================================================

  union all
  -- Rajoitteen olemassaolo ei todista, etta se tekee mita nimi lupaa.
  -- `check (executed = false or confirmed = true)` voisi olla
  -- kirjoitettu vaarin pain ja nayttaisi luettelossa aivan samalta.
  -- Siksi maaritelma luetaan ja verrataan.
  --
  -- Verrataan OSIIN eika koko maaritelmaan. pg_get_constraintdef
  -- palauttaa palvelimen oman jasennyksen sulkuineen, ja se voi
  -- muuttua versiosta toiseen ilman etta rajoite muuttuu. Tasmallinen
  -- merkkijonovertailu tuottaisi silloin FAILin, joka ei tarkoita
  -- mitaan — juuri sellainen vei aikaa migraation 0003 varmistuksessa.
  --
  -- Nama kaksi ehtoa riittavat erottamaan oikean vaarinpainisesta:
  -- kaannetty rajoite olisi `confirmed = false or executed = true`.
  select '08', 'invariantti', 'Vahvistusrajoitteen maaritelma on oikea suunta', '1',
         (select count(*)::text from pg_constraint
           where conname = 'ai_action_audit_confirmed_check'
             and contype = 'c'
             and replace(pg_get_constraintdef(oid), ' ', '') like '%executed=false%'
             and replace(pg_get_constraintdef(oid), ' ', '') like '%confirmed=true%')

  union all
  -- Ja EIKA YKSIKAAN RIVI riko sita. Rajoite voisi olla NOT VALID,
  -- jolloin se koskisi vain uusia riveja — vanhat lipsahtaisivat lapi.
  select '09', 'invariantti', 'Yhtaan vahvistamatonta suoritusta ei ole kirjattu', '0',
         (select count(*)::text from public.ai_action_audit
           where executed = true and confirmed = false)

  union all
  select '10', 'invariantti', 'Vahvistusrajoite on validoitu, ei NOT VALID', '1',
         (select count(*)::text from pg_constraint
           where conname = 'ai_action_audit_confirmed_check'
             and contype = 'c' and convalidated)

  -- ================================================================
  -- OMISTAJUUS
  -- ================================================================

  union all
  -- target_id EI OLE VIERASAVAIN, eika siita saa tehda sellaista.
  --
  -- Tama on eri asia kuin migraatioiden 0004 ja 0007 aukko. Siella B
  -- pystyi KIINNITTAMAAN oman rivinsa A:n riviin — luomaan kannan
  -- tasolla suhteen, jota ei pitaisi olla. Tassa suhdetta ei ole:
  -- target_id on tekstikentta B:n omalla rivilla, jonka vain B nakee.
  -- Se ei anna B:lle paasya A:n riviin eika nay A:lle mitenkaan.
  --
  -- Jos viite joskus lisataan, tama vaite vanhenee ja tarkistus kaatuu.
  -- Se on tarkoitus.
  select '11', 'omistajuus', 'Taulussa ei ole viitteita sovellustauluihin', '0',
         (select count(*)::text
            from pg_constraint con
            join pg_class ft on ft.oid = con.confrelid
           where con.conrelid = 'public.ai_action_audit'::regclass
             and con.contype = 'f'
             and ft.relnamespace = 'public'::regnamespace)

  union all
  select '12', 'omistajuus', 'Omistajan asettaa kanta, ei asiakas', '1',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'ai_action_audit'
             and column_name = 'user_id'
             and is_nullable = 'NO'
             and column_default like '%auth.uid()%')

  union all
  -- Loki poistuu kayttajan mukana. Se ei ole analytiikkaa eika saa
  -- jaada kantaan sen jalkeen kun kayttaja on lahtenyt.
  select '13', 'omistajuus', 'Kayttajan poisto siivoaa kirjausketjun', '1',
         (select count(*)::text
            from pg_constraint con
            join pg_class ft on ft.oid = con.confrelid
            join pg_namespace fn on fn.oid = ft.relnamespace
           where con.conrelid = 'public.ai_action_audit'::regclass
             and con.contype = 'f'
             and fn.nspname = 'auth' and ft.relname = 'users'
             and con.confdeltype = 'c')

  -- ================================================================
  -- ARKALUONTOISUUS
  -- ================================================================

  union all
  -- Pituusrajoite on kannassa eika pelkastaan sovelluksessa, koska
  -- sovellusvirhe ei saa johtaa siihen, etta koko paivakirjamerkinta
  -- paatyy tietokantaan. Rajat luetaan maaritelmasta.
  select '14', 'arkaluontoisuus', 'Tiivistelman pituusraja on 200 merkkia', '1',
         (select count(*)::text from pg_constraint
           where conname = 'ai_action_audit_summary_length_check'
             and contype = 'c'
             and pg_get_constraintdef(oid) like '%200%')

  union all
  select '15', 'arkaluontoisuus', 'Ehdotuksen pituusraja on 300 merkkia', '1',
         (select count(*)::text from pg_constraint
           where conname = 'ai_action_audit_proposal_length_check'
             and contype = 'c'
             and pg_get_constraintdef(oid) like '%300%')

  union all
  -- Rajat myos purevat. Rajoite voisi olla NOT VALID, jolloin se
  -- koskisi vain uusia riveja.
  select '16', 'arkaluontoisuus', 'Pituusrajat on validoitu', '2',
         (select count(*)::text from pg_constraint
           where conname in ('ai_action_audit_summary_length_check',
                             'ai_action_audit_proposal_length_check')
             and contype = 'c' and convalidated)

  -- ================================================================
  -- INDEKSI JA RLS
  -- ================================================================

  union all
  -- Sarakejarjestys luetaan indkey-listasta. (user_id, occurred_at)
  -- palvelee omistajan aikajanaa; toisin pain ei.
  select '17', 'indeksit', 'Hakuindeksi on jarjestyksessa (user_id, occurred_at)', '1',
         (select count(*)::text
            from pg_index i
            join pg_class ic on ic.oid = i.indexrelid
            join pg_class tc on tc.oid = i.indrelid
           where ic.relname = 'ai_action_audit_user_time_idx'
             and (select array_agg(a.attname::text order by k.ord)
                    from unnest(i.indkey) with ordinality k(attnum, ord)
                    join pg_attribute a
                      on a.attrelid = tc.oid and a.attnum = k.attnum)
                 = array['user_id', 'occurred_at'])

  union all
  select '18', 'rls', 'RLS on paalla', '1',
         (select count(*)::text from pg_class
           where relnamespace = 'public'::regnamespace
             and relname = 'ai_action_audit' and relrowsecurity)

  union all
  -- Politiikan OLEMASSAOLO ei todista mitaan: `using (true)` nayttaisi
  -- luettelossa aivan samalta. Siksi ehdot luetaan ja verrataan — ja
  -- MOLEMMAT puolet.
  select '19', 'rls', 'Nelja omistajuuspolitiikkaa oikein ehdoin', '4',
         (select count(*)::text
            from pg_policies p
            join (values
                    ('ai_action_audit_select_own', 'SELECT', 'auth.uid()=user_id', ''),
                    ('ai_action_audit_insert_own', 'INSERT', '',                   'auth.uid()=user_id'),
                    ('ai_action_audit_update_own', 'UPDATE', 'auth.uid()=user_id', 'auth.uid()=user_id'),
                    ('ai_action_audit_delete_own', 'DELETE', 'auth.uid()=user_id', '')
                 ) e(pol, operaatio, q, wc)
              on e.pol = p.policyname and e.operaatio = p.cmd
             and btrim(replace(coalesce(p.qual, ''), ' ', ''), '()') = e.q
             and btrim(replace(coalesce(p.with_check, ''), ' ', ''), '()') = e.wc
           where p.schemaname = 'public' and p.tablename = 'ai_action_audit'
             and p.roles = '{authenticated}'::name[])

  union all
  select '20', 'rls', 'Taulussa ei ole ylimaaraisia politiikkoja', '4',
         (select count(*)::text from pg_policies
           where schemaname = 'public' and tablename = 'ai_action_audit')

  -- ================================================================
  -- OIKEUDET
  -- ================================================================

  union all
  select '21', 'oikeudet', 'anon-roolilla ei ole tehollista oikeutta', '0',
         (select count(*)::text
            from (select unnest(array['select', 'insert', 'update', 'delete',
                                      'truncate', 'references', 'trigger']) as oikeus) pp
           where has_table_privilege('anon', 'public.ai_action_audit', pp.oikeus))

  union all
  -- Kaksi menetelmaa, koska kumpikaan ei yksin riita: has_table_privilege
  -- kertoo ONKO oikeus (perinta mukaan lukien), aclexplode kertoo MISTA
  -- se tulee.
  select '22', 'oikeudet', 'PUBLIC-roolilla ei ole oikeuksia', '0',
         (select count(*)::text
            from pg_class cl, aclexplode(cl.relacl) acl
           where cl.oid = 'public.ai_action_audit'::regclass
             and acl.grantee = 0)

  union all
  select '23', 'oikeudet', 'authenticated-roolilla on tasan CRUD', '4',
         (select count(*)::text
            from (select unnest(array['select', 'insert', 'update', 'delete',
                                      'truncate', 'references', 'trigger']) as oikeus) pp
           where has_table_privilege('authenticated', 'public.ai_action_audit', pp.oikeus))

  -- ================================================================
  -- VANHA DATA ON KOSKEMATON
  -- ================================================================

  union all
  select '24', 'vanha data', 'RLS on yha paalla tauluissa tasks ja profile', '2',
         (select count(*)::text from pg_class
           where relnamespace = 'public'::regnamespace
             and relname in ('tasks', 'profile') and relrowsecurity)

  union all
  select '25', 'vanha data', 'tasks-taulussa on yha nelja politiikkaa', '4',
         (select count(*)::text from pg_policies
           where schemaname = 'public' and tablename = 'tasks')

  union all
  select '26', 'vanha data', 'Uusi taulu on tyhja', '0',
         (select count(*)::text from public.ai_action_audit)

  -- ================================================================
  -- KIRJATTAVAT
  -- ================================================================

  union all
  select '27', 'kirjattavat', 'Tehtavien lukumaara', 'INFO',
         (select count(*)::text from public.tasks)

  union all
  select '28', 'kirjattavat', 'Tietokanta', 'INFO', current_database()

  union all
  select '29', 'kirjattavat', 'Varmistuksen hetki (UTC)', 'INFO',
         to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS')

) c
order by c.check_no;
