-- =====================================================================
-- LOPULLINEN VARMISTUS: migraatiot 0003-0008 hyvaksyntatestin JALKEEN
-- =====================================================================
--
-- VAIN LUKEVA. Yksi lause, yksi tulostaulukko, yksi kopiointi.
--
-- MILLOIN AJETAAN
-- Kun live-hyvaksyntatesti on ajettu tuotantoa vasten, sen siivous on
-- nayttanyt PASSin ja valiaikainen tili B on poistettu Supabasen
-- Authentication-nakymasta.
--
-- AJA ENSIN PRECHECK
-- supabase/acceptance/precheck_0003_0008_auth_final.sql
--
-- Se tarkistaa istunnon roolin ja auth-kayttajien maaran, ja se vaatii
-- postgres-roolin. Tama tiedosto EI vaadi: se lukee vain public-skeemaa
-- ja jarjestelmakatalogeja, joten se toimii istunnon roolista
-- riippumatta.
--
-- MITEN AJETAAN
-- Avaa tama tiedosto, valitse KOKO sisalto, liita Supabasen SQL
-- Editoriin ja aja.
--
-- ODOTUS
-- 40 rivia. Jokaisen rivin status on PASS ja failures_total on 0.
-- Yksikin FAIL tarkoittaa, ettei yhtakaan porttia saa avata.
--
-- ---------------------------------------------------------------------
-- JOS NAET "Success. No rows returned"
-- ---------------------------------------------------------------------
-- Se EI tarkoita, etta tarkistukset olisivat menneet lapi. Se
-- tarkoittaa, ettei tarkistuksia ajettu.
--
-- Tama lause ei voi palauttaa nollaa rivia. Jokainen tarkistus on
-- muotoa `select <vakio>` ilman from-lausetta, joten se tuottaa tasan
-- yhden rivin riippumatta siita, mita kannassa on. Tyhja tulos
-- tarkoittaa, ettei koko tiedosto tullut ajetuksi.
--
-- Yleisin syy: SQL Editorissa on tekstia VALITTUNA, jolloin editori
-- ajaa vain valinnan. Jos valinta osuu pelkkiin kommentteihin, mitaan
-- tulosjoukkoa ei synny -- ja juuri sen ilmoituksen editori nayttaa.
--
-- Tee nain:
--   1. Klikkaa editoria ja paina Ctrl+A, jotta valinta kattaa kaiken,
--      tai poista valinta kokonaan
--   2. Varmista, etta viimeinen nakyva merkki on puolipiste
--   3. Aja uudelleen
--
-- Tassa tiedostossa on TASAN YKSI puolipiste, aivan viimeisena
-- merkkina. Naytetty tulos on siis aina tama tarkistustaulukko eika
-- jonkin toisen lauseen tulos.
--
-- ---------------------------------------------------------------------
-- MITA TAMA EI TEE
-- ---------------------------------------------------------------------
-- Ei kirjoita mitaan. Ei INSERT, UPDATE, DELETE, TRUNCATE, CREATE,
-- ALTER, DROP, GRANT eika REVOKE. Ei SET ROLE. Ei kosketa funktioon
-- rls_auto_enable eika yhteenkaan politiikkaan.
--
-- Ei myoskaan lue kayttajan sisaltoa: ei otsikoita, ei muistiinpanoja,
-- ei rahasummia, ei hyvinvointimerkintoja. Tehtavien tunnisteista
-- lasketaan tiiviste, jotta joukon muuttumattomuuden voi todeta
-- lukematta yhtaan rivia.
-- =====================================================================

with

-- ---------------------------------------------------------------------
-- Odotusarvot yhdessa paikassa
--
-- Luvut on johdettu repositorion migraatioista 0001-0008 ja
-- hyvaksytysta tiedostosta verify_0004_0008_final.sql. Ne eivat ole
-- arvattuja. Automaattinen testi vertaa ne migraatioihin joka ajolla.
-- ---------------------------------------------------------------------
-- LUETTELOT OVAT RIVEJA, EIVAT TAULUKOITA.
--
-- Tama on tietoinen valinta, ei tyylikysymys. Aiempi versio piti
-- luettelot text[]-taulukkoina yhdessa rivissa, ja jasenyys
-- kirjoitettiin muotoon
--
--   tablename = any (select portit from odotukset)
--
-- Se on ANYn SUBQUERY-muoto: alikyselyn pitaisi palauttaa rivejae
-- ALKION tyyppia. Se palautti yhden rivin, jonka sarake oli text[],
-- joten PostgreSQL yritti operaatiota
--
--   name = text[]
--
-- ja kaatui koodiin 42883. Vika ei nakynyt lukemalla, koska sama
-- kirjoitusasu on oikein silloin kun oikea puoli on taulukkoLAUSEKE
-- (= any (array[...])) eika alikysely.
--
-- Kun luettelo on rivijoukko, jasenyys kirjoitetaan muotoon
-- `in (select ...)`. Silloin ei ole mitaan tulkinnanvaraa: molemmat
-- puolet ovat skalaareja. Samalla katoaa unnest-kierros
-- ristiinliitoksista.
portit(taulu) as (
  -- Kymmenen porttitaulua: kaksi migraatiosta 0003, kahdeksan
  -- migraatioista 0004-0008.
  values ('routines'::text), ('routine_exceptions'), ('goals'), ('projects'),
         ('notification_preferences'), ('wellbeing_entries'),
         ('recurring_expenses'), ('bills'), ('savings_goals'),
         ('ai_action_audit')
),

crud_taulut(taulu) as (
  -- Nama yksitoista saavat authenticated-roolilta tasan CRUDin.
  values ('public.tasks'::text), ('public.routines'),
         ('public.routine_exceptions'), ('public.goals'), ('public.projects'),
         ('public.notification_preferences'), ('public.wellbeing_entries'),
         ('public.recurring_expenses'), ('public.bills'),
         ('public.savings_goals'), ('public.ai_action_audit')
),

oikeudet(oikeus) as (
  values ('select'::text), ('insert'), ('update'), ('delete'),
         ('truncate'), ('references'), ('trigger')
),

vakiot as (
  select 'manifestival_rls_acceptance_'::text as etuliite,
         '2cc00622-f927-4604-a518-361a4328481b'::uuid as omistaja,
         36::bigint as tehtavia,
         '1acdb7371be22cfa457b4dae0d0aa800'::text as tehtavien_tiiviste
),

-- ---------------------------------------------------------------------
-- SECURITY DEFINER -funktioiden sallittavuus
--
-- Ympariston oma infrastruktuurifunktio public.rls_auto_enable()
-- kytkee RLS:n paalle uusiin public-skeeman tauluihin. Se on sallittu,
-- mutta VAIN tasmalleen tunnetussa muodossa. Nimi ei ole tunniste:
-- kuka tahansa voi luoda funktion milla tahansa nimella.
--
-- Sama sallittavuus kuin tiedostossa verify_0004_0008_final.sql.
-- ---------------------------------------------------------------------
definer_funktiot as (
  select p.oid, p.proname, p.prosrc, p.proconfig, p.proowner,
         p.prokind, p.pronargs, p.prorettype, p.prolang
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prosecdef
),

tunniste as (
  select f.oid,
         f.proname,
         coalesce(
           f.proname = 'rls_auto_enable'
           and f.prokind = 'f'
           and f.pronargs = 0
           and f.prorettype = 'pg_catalog.event_trigger'::regtype
           and f.prolang = (select oid from pg_language where lanname = 'plpgsql')
           and pg_get_userbyid(f.proowner) = 'postgres'
           and f.proconfig is not null
           and array_length(f.proconfig, 1) = 1
           and f.proconfig[1] like 'search\_path=%'
           and btrim(replace(split_part(f.proconfig[1], '=', 2), '"', '')) = 'pg_catalog'
         , false) as identiteetti_ok,
         coalesce(
           f.prosrc ~* 'pg_event_trigger_ddl_commands'
           and f.prosrc ~* 'enable[[:space:]]+row[[:space:]]+level[[:space:]]+security'
           and f.prosrc !~* '\m(pg_read_file|pg_read_binary_file|lo_import|lo_export|dblink)\M'
           and f.prosrc !~* '\m(grant|revoke)\M'
           and f.prosrc !~* '\m(create|alter|drop|set)\M[[:space:]]+\mrole\M'
         , false) as runko_ok
    from definer_funktiot f
),

-- ---------------------------------------------------------------------
-- Tarkistukset
-- ---------------------------------------------------------------------
tarkistukset as (

  -- =================================================================
  -- A. AUTH JA SIIVOUS
  -- =================================================================

  -- HUOM. AUTH-KAYTTAJIEN MAARA EI OLE TAALLA.
  --
  -- Taulu auth.users vaatii lukuoikeuden, jota authenticated-roolilla ei
  -- ole. Jos tama varmistus lukisi sita, sen ajettavuus riippuisi SQL
  -- Editorin istunnon roolista -- ja se kaatuisi koodiin 42501 ilman
  -- etta yksikaan tarkistus kertoisi mitaan.
  --
  -- Kayttajamaara tarkistetaan erikseen tiedostossa
  -- precheck_0003_0008_auth_final.sql, joka ajetaan ENNEN tata
  -- postgres-roolilla. Tama tiedosto lukee vain public-skeemaa ja
  -- jarjestelmakatalogeja, joten se toimii roolista riippumatta.
  select '01' as check_no, 'A siivous' as section,
         'Tehtavien lukumaara on lahtoarvossa' as check_name,
         (select tehtavia::text from vakiot) as expected,
         (select count(*)::text from public.tasks) as actual

  union all
  select '02', 'A siivous', 'Hyvaksyntatestin tehtavajaannoksia ei ole', '0',
         (select count(*)::text from public.tasks
           where id like (select etuliite from vakiot) || '%')

  union all
  -- Yhdeksan tekstiavaimellista porttitaulua. Muistutusasetukset
  -- tarkistetaan erikseen kohdassa 05, koska niiden tunniste on
  -- kayttajan uuid eika testin etuliite.
  select '03', 'A siivous', 'Hyvaksyntatestin jaannoksia ei ole porttitauluissa', '0',
         ((select count(*) from public.routines
            where id like (select etuliite from vakiot) || '%')
        + (select count(*) from public.routine_exceptions
            where id like (select etuliite from vakiot) || '%')
        + (select count(*) from public.goals
            where id like (select etuliite from vakiot) || '%')
        + (select count(*) from public.projects
            where id like (select etuliite from vakiot) || '%')
        + (select count(*) from public.wellbeing_entries
            where id like (select etuliite from vakiot) || '%')
        + (select count(*) from public.recurring_expenses
            where id like (select etuliite from vakiot) || '%')
        + (select count(*) from public.bills
            where id like (select etuliite from vakiot) || '%')
        + (select count(*) from public.savings_goals
            where id like (select etuliite from vakiot) || '%')
        + (select count(*) from public.ai_action_audit
            where id like (select etuliite from vakiot) || '%'))::text

  union all
  select '04', 'A siivous', 'Muistutusasetusrivia ei ole', '0',
         (select count(*)::text from public.notification_preferences)

  union all
  -- ORPOJA RIVEJA EI VOI OLLA -- RAKENTEEN NOJALLA.
  --
  -- Aiemmin tassa oli kymmenen `left join auth.users` -tarkistusta.
  -- Ne lukivat auth-skeemaa, ja se teki koko varmistuksen
  -- ajettavuudesta riippuvaisen istunnon roolista.
  --
  -- Sama invariantti todistetaan nyt public-skeemasta ja katalogeista,
  -- eika todistus ole heikompi vaan vahvempi:
  --
  --   * Jokaisella kymmenella taululla on VALIDOITU vierasavain
  --     auth.users-tauluun ON DELETE CASCADE -saannolla (tarkistus 17).
  --     Validoitu vierasavain tekee orvosta rivista mahdottoman: kanta
  --     valvoo sita jokaisessa kirjoituksessa, ja `convalidated`
  --     tarkoittaa etta myos olemassa olleet rivit tarkistettiin.
  --   * Yhdeksan porttitaulua on tyhjia (tarkistus 05), joten niissa ei
  --     ole yhtaan rivia jonka omistaja voisi olla kadonnut.
  --   * tasks-taulun jokainen rivi kuuluu tunnetulle omistajalle
  --     (tarkistus 26), ja profile-rivi samoin (tarkistus 32).
  --   * Omistajattomia rivejae ei ole (tarkistukset 24 ja 25).
  --
  -- Se, etta tunnettu omistaja on kannan AINOA kayttaja, todistetaan
  -- precheckissa. Tama on ainoa osa, joka siirtyi privileged-ajoon.
  select '05', 'A siivous', 'Kaikki kymmenen porttitaulua ovat tyhjia', '0',
         ((select count(*) from public.routines)
        + (select count(*) from public.routine_exceptions)
        + (select count(*) from public.goals)
        + (select count(*) from public.projects)
        + (select count(*) from public.notification_preferences)
        + (select count(*) from public.wellbeing_entries)
        + (select count(*) from public.recurring_expenses)
        + (select count(*) from public.bills)
        + (select count(*) from public.savings_goals)
        + (select count(*) from public.ai_action_audit))::text

  union all
  -- HYOKKAYSRIVIT EIVAT SAANEET SYNTYA LAINKAAN.
  --
  -- Tama on eri vaite kuin "siivous onnistui": siivous poistaisi rivin
  -- jos se olisi syntynyt, eika sita nakisi rivimaarista. Jos jokin
  -- naista loytyy, yhdistelmavierasavain ei pitanyt.
  select '06', 'A siivous', 'Ristiinkiinnitysyrityksia ei ole kannassa', '0',
         ((select count(*) from public.tasks
            where id like (select etuliite from vakiot) || '%_attack_%')
        + (select count(*) from public.routines
            where id like (select etuliite from vakiot) || '%_attack_%')
        + (select count(*) from public.routine_exceptions
            where id like (select etuliite from vakiot) || '%_attack_%')
        + (select count(*) from public.goals
            where id like (select etuliite from vakiot) || '%_attack_%')
        + (select count(*) from public.projects
            where id like (select etuliite from vakiot) || '%_attack_%')
        + (select count(*) from public.bills
            where id like (select etuliite from vakiot) || '%_attack_%'))::text

  -- =================================================================
  -- B. TAULUT
  -- =================================================================

  union all
  select '07', 'B taulut', 'Kaikki kymmenen porttitaulua ovat olemassa', '10',
         (select count(*)::text from pg_tables
           where schemaname = 'public'
             and tablename::text in (select taulu from portit))

  -- =================================================================
  -- C. RLS JA OIKEUDET
  -- =================================================================

  union all
  select '08', 'C rls', 'RLS on paalla kaikissa kymmenessa taulussa', '10',
         (select count(*)::text from pg_class
           where relnamespace = 'public'::regnamespace
             and relname::text in (select taulu from portit)
             and relrowsecurity)

  union all
  select '09', 'C rls', 'Neljakymmenta omistajuuspolitiikkaa on tallella', '40',
         (select count(*)::text from pg_policies
           where schemaname = 'public'
             and tablename::text in (select taulu from portit))

  union all
  select '10', 'C rls', 'Jokainen politiikka on vain authenticated-roolille', '40',
         (select count(*)::text from pg_policies
           where schemaname = 'public'
             and tablename::text in (select taulu from portit)
             and roles = '{authenticated}'::name[])

  union all
  -- Politiikan OLEMASSAOLO ei todista mitaan: using (true) nayttaisi
  -- luettelossa aivan samalta. Ehdot luetaan ja verrataan, ja
  -- MOLEMMAT puolet. Pelkka USING sallisi rivin kirjoittamisen toisen
  -- nimiin.
  --
  -- notification_preferences rajaa id-sarakkeella, koska sen omistaja
  -- on paaavain itse. Muut rajaavat user_id-sarakkeella.
  select '11', 'C rls', 'Jokainen politiikka rajaa omistajuuden molemmilta puolilta', '40',
         (select count(*)::text from pg_policies p
           where p.schemaname = 'public'
             and p.tablename::text in (select taulu from portit)
             and coalesce(btrim(replace(p.qual, ' ', ''), '()'),
                          case when p.tablename = 'notification_preferences'
                               then 'auth.uid()=id' else 'auth.uid()=user_id' end)
                 = case when p.tablename = 'notification_preferences'
                        then 'auth.uid()=id' else 'auth.uid()=user_id' end
             and coalesce(btrim(replace(p.with_check, ' ', ''), '()'),
                          case when p.tablename = 'notification_preferences'
                               then 'auth.uid()=id' else 'auth.uid()=user_id' end)
                 = case when p.tablename = 'notification_preferences'
                        then 'auth.uid()=id' else 'auth.uid()=user_id' end)

  union all
  select '12', 'C oikeudet', 'anon-roolilla ei ole tehollista oikeutta porttitauluihin', '0',
         (select count(*)::text
            from portit t
            cross join oikeudet o
           where has_table_privilege('anon', format('public.%I', t.taulu), o.oikeus))

  union all
  -- PUBLICille myonnetty oikeus ei nay roolikohtaisissa listauksissa
  -- lainkaan, joten se luetaan taulun omasta oikeuslistasta.
  select '13', 'C oikeudet', 'PUBLIC-roolilla ei ole oikeuksia porttitauluihin', '0',
         (select count(*)::text
            from pg_class cl, aclexplode(cl.relacl) acl
           where cl.relnamespace = 'public'::regnamespace
             and cl.relname::text in (select taulu from portit)
             and acl.grantee = 0)

  union all
  select '14', 'C oikeudet', 'authenticated-roolilla on tasan CRUD yhdessatoista taulussa', '44',
         (select count(*)::text
            from crud_taulut t
            cross join oikeudet o
           where has_table_privilege('authenticated', t.taulu, o.oikeus))

  -- =================================================================
  -- D. OMISTAJUUS JA VIITE-EHEYS
  -- =================================================================

  union all
  -- MATCH SIMPLE ohittaa yhdistelmavierasavaimen tarkistuksen, jos
  -- yksikin avaimen sarake on NULL. Jos user_id sallisi NULLin
  -- yhdessakin viittaavassa taulussa, koko suoja katoaisi hiljaa.
  select '15', 'D omistajuus', 'user_id on NOT NULL kaikissa kymmenessa taulussa', '10',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public'
             and table_name in ('tasks', 'routines', 'routine_exceptions',
                                'goals', 'projects', 'wellbeing_entries',
                                'recurring_expenses', 'bills', 'savings_goals',
                                'ai_action_audit')
             and column_name = 'user_id' and is_nullable = 'NO')

  union all
  select '16', 'D omistajuus', 'Omistajan asettaa kanta, ei asiakas', '10',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public'
             and ((table_name in ('routines', 'routine_exceptions', 'goals',
                                  'projects', 'wellbeing_entries',
                                  'recurring_expenses', 'bills', 'savings_goals',
                                  'ai_action_audit')
                   and column_name = 'user_id')
                  or (table_name = 'notification_preferences' and column_name = 'id'))
             and column_default like '%auth.uid()%')

  union all
  -- VALIDOITU on olennainen sana.
  --
  -- Tama tarkistus kantaa orpojen rivien todistuksen: validoitu
  -- vierasavain tekee orvosta rivista mahdottoman. `convalidated`
  -- tarkoittaa, etta rajoite tarkistettiin myos jo olemassa olleita
  -- rivejae vastaan -- NOT VALID -rajoite koskisi vain uusia.
  --
  -- Ilman `convalidated`-ehtoa tama olisi voinut nayttaa vihrealta
  -- vaikka kannassa olisi orpoja rivejae, jotka rajoitteen lisays
  -- ohitti.
  --
  -- Viite luetaan katalogista. Se ei lue auth.users-taulun SISALTOA,
  -- joten se ei vaadi lukuoikeutta siihen.
  select '17', 'D omistajuus',
         'Kayttajan poiston cascade on olemassa ja validoitu kaikissa kymmenessa', '10',
         (select count(*)::text
            from pg_constraint con
            join pg_class t on t.oid = con.conrelid
            join pg_class ft on ft.oid = con.confrelid
            join pg_namespace fn on fn.oid = ft.relnamespace
           where con.contype = 'f'
             and fn.nspname = 'auth' and ft.relname = 'users'
             and con.confdeltype = 'c'
             and con.convalidated
             and t.relname::text in (select taulu from portit))

  union all
  -- YHDEKSAN OMISTAJUUSVIITETTA kolmessa migraatiossa. Rakenne
  -- luetaan katalogista eika nimista: conkey kertoo montako saraketta
  -- avaimessa on, user_id:n on oltava yksi niista, ja confkey kertoo
  -- etta kohde on pari (user_id, id).
  select '18', 'D omistajuus', 'Yhdeksan omistajuuden yhdistelmavierasavainta', '9',
         (select count(*)::text
            from pg_constraint con
            join pg_class t on t.oid = con.conrelid
            join pg_class ft on ft.oid = con.confrelid
           where con.contype = 'f'
             and t.relnamespace = 'public'::regnamespace
             and ft.relnamespace = 'public'::regnamespace
             and array_length(con.conkey, 1) = 2
             and exists (select 1 from unnest(con.conkey) k(attnum)
                           join pg_attribute a
                             on a.attrelid = t.oid and a.attnum = k.attnum
                          where a.attname = 'user_id')
             and (select array_agg(a.attname::text order by a.attname)
                    from unnest(con.confkey) k(attnum)
                    join pg_attribute a
                      on a.attrelid = ft.oid and a.attnum = k.attnum)
                 = array['id', 'user_id'])

  union all
  -- ERI VAITE KUIN 20: tama laskee ETTEI heikompia ole. Kumpikaan
  -- yksin ei riita, koska kannassa voisi olla oikea viite ja vanha sen
  -- vieressa -- ja heikompi paastaisi rivin lapi.
  select '19', 'D omistajuus', 'Yhtaan yhden sarakkeen viitetta sovellustauluun ei ole', '0',
         (select count(*)::text
            from pg_constraint con
            join pg_class t on t.oid = con.conrelid
            join pg_class ft on ft.oid = con.confrelid
           where con.contype = 'f'
             and t.relnamespace = 'public'::regnamespace
             and ft.relnamespace = 'public'::regnamespace
             and array_length(con.conkey, 1) < 2)

  union all
  -- Ilman sarakelistaa poisto yrittaisi nollata myos user_id:n, joka
  -- on NOT NULL, ja kohteen poistaminen kaatuisi joka kerta.
  select '20', 'D omistajuus', 'Kahdeksan nollaavaa viitetta rajaa nollauksen sarakkeeseen', '8',
         (select count(*)::text
            from pg_constraint con
            join pg_class t on t.oid = con.conrelid
           where con.contype = 'f'
             and t.relnamespace = 'public'::regnamespace
             and array_length(con.conkey, 1) = 2
             and con.confdeltype = 'n'
             and array_length(con.confdelsetcols, 1) = 1
             and not exists (select 1 from unnest(con.confdelsetcols) k(attnum)
                               join pg_attribute a
                                 on a.attrelid = t.oid and a.attnum = k.attnum
                              where a.attname = 'user_id'))

  union all
  -- Poikkeus ilman rutiinia ei tarkoita mitaan, joten tama yksi viite
  -- on tarkoituksella CASCADE eika SET NULL.
  select '21', 'D omistajuus', 'Poikkeuksen viite rutiiniin on CASCADE', '1',
         (select count(*)::text
            from pg_constraint con
            join pg_class t on t.oid = con.conrelid
            join pg_class ft on ft.oid = con.confrelid
           where con.contype = 'f'
             and t.relname = 'routine_exceptions'
             and ft.relname = 'routines'
             and array_length(con.conkey, 1) = 2
             and con.confdeltype = 'c')

  union all
  -- Yhdistelmavierasavain vaatii kohteelta yksikasitteisyysrajoitteen.
  -- Ilman naita viitteita ei olisi voitu luoda lainkaan.
  select '22', 'D omistajuus', 'Viisi omistajan rivin avainta (user_id, id)', '5',
         (select count(*)::text from pg_constraint con
           where con.conname in ('routines_owner_row_key', 'goals_owner_row_key',
                                 'projects_owner_row_key', 'tasks_owner_row_key',
                                 'recurring_expenses_owner_row_key')
             and con.contype = 'u'
             and (select array_agg(a.attname::text order by a.attname)
                    from unnest(con.conkey) k(attnum)
                    join pg_attribute a
                      on a.attrelid = con.conrelid and a.attnum = k.attnum)
                 = array['id', 'user_id'])

  union all
  -- EHEYS RIIPPUMATTA TESTISTA.
  --
  -- Nama kysyvat toisin pain kuin kohta 08: onko kannassa YHTAAN
  -- rivia, joka viittaa toisen kayttajan riviin. Tama ei tarvitse
  -- tunnisteita lainkaan, joten se loytaisi myos rivin joka syntyi
  -- jotain muuta kautta.
  select '23', 'D eheys', 'Yhtaan riviae ei ole kiinnitetty toisen kayttajan riviin', '0',
         ((select count(*) from public.tasks t
             left join public.goals g on g.id = t.goal_id and g.user_id = t.user_id
            where t.goal_id is not null and g.id is null)
        + (select count(*) from public.tasks t2
             left join public.projects p on p.id = t2.project_id and p.user_id = t2.user_id
            where t2.project_id is not null and p.id is null)
        + (select count(*) from public.goals g2
             left join public.goals pg on pg.id = g2.parent_goal_id and pg.user_id = g2.user_id
            where g2.parent_goal_id is not null and pg.id is null)
        + (select count(*) from public.goals g3
             left join public.projects p2 on p2.id = g3.project_id and p2.user_id = g3.user_id
            where g3.project_id is not null and p2.id is null)
        + (select count(*) from public.projects p3
             left join public.goals g4 on g4.id = p3.goal_id and g4.user_id = p3.user_id
            where p3.goal_id is not null and g4.id is null)
        + (select count(*) from public.routines r
             left join public.goals g5 on g5.id = r.goal_id and g5.user_id = r.user_id
            where r.goal_id is not null and g5.id is null)
        + (select count(*) from public.routine_exceptions e
             left join public.routines r2 on r2.id = e.routine_id and r2.user_id = e.user_id
            where r2.id is null)
        + (select count(*) from public.bills b
             left join public.tasks t3 on t3.id = b.task_id and t3.user_id = b.user_id
            where b.task_id is not null and t3.id is null)
        + (select count(*) from public.bills b2
             left join public.recurring_expenses x on x.id = b2.recurring_expense_id
                                                  and x.user_id = b2.user_id
            where b2.recurring_expense_id is not null and x.id is null))::text

  union all
  select '24', 'D eheys', 'Omistajattomia riveja ei ole yhdessakaan porttitaulussa', '0',
         ((select count(*) from public.routines where user_id is null)
        + (select count(*) from public.routine_exceptions where user_id is null)
        + (select count(*) from public.goals where user_id is null)
        + (select count(*) from public.projects where user_id is null)
        + (select count(*) from public.wellbeing_entries where user_id is null)
        + (select count(*) from public.recurring_expenses where user_id is null)
        + (select count(*) from public.bills where user_id is null)
        + (select count(*) from public.savings_goals where user_id is null)
        + (select count(*) from public.ai_action_audit where user_id is null))::text

  -- =================================================================
  -- E. TUOTANNON VANHA DATA
  -- =================================================================

  union all
  select '25', 'E vanha data', 'Omistajattomia tehtavia ei ole', '0',
         (select count(*)::text from public.tasks where user_id is null)

  union all
  select '26', 'E vanha data', 'Yhtaan tehtavaa ei omista odottamaton kayttaja', '0',
         (select count(*)::text from public.tasks
           where user_id is distinct from (select omistaja from vakiot))

  union all
  -- Tehtavien tunnisteiden tiiviste. Rivimaara voi tasmata, vaikka
  -- rivit olisivat eri. Tama kertoo onko joukko sama, eika paljasta
  -- yhdenkaan rivin sisaltoa.
  select '27', 'E vanha data', 'Tehtavien tunnisteiden tiiviste on ennallaan',
         (select tehtavien_tiiviste from vakiot),
         (select coalesce(md5(string_agg(id, ',' order by id)), 'ei riveja')
            from public.tasks)

  union all
  select '28', 'E vanha data', 'RLS on yha paalla tauluissa tasks ja profile', '2',
         (select count(*)::text from pg_class
           where relnamespace = 'public'::regnamespace
             and relname in ('tasks', 'profile') and relrowsecurity)

  union all
  select '29', 'E vanha data', 'tasks-taulussa on yha nelja politiikkaa', '4',
         (select count(*)::text from pg_policies
           where schemaname = 'public' and tablename = 'tasks')

  union all
  select '30', 'E vanha data', 'profile-taulussa on yha nelja politiikkaa', '4',
         (select count(*)::text from pg_policies
           where schemaname = 'public' and tablename = 'profile')

  union all
  select '31', 'E vanha data', 'Profiilirivien maara on yksi', '1',
         (select count(*)::text from public.profile)

  union all
  -- Profiilin omistaja on sama tunnettu kayttaja kuin tehtavilla.
  --
  -- Tama korvaa osan poistetusta auth.users-liitoksesta: profile on
  -- ainoa taulu tasks-taulun lisaksi, jossa tuotannossa on rivi, ja
  -- sen omistajuus on siksi todettava erikseen. profile-taulussa
  -- omistaja on paaavain itse.
  select '32', 'E vanha data', 'Profiilirivi kuuluu tunnetulle omistajalle', '0',
         (select count(*)::text from public.profile
           where id is distinct from (select omistaja from vakiot))

  -- =================================================================
  -- F. TURVAINVARIANTIT
  -- =================================================================

  union all
  -- Kysytaan toisin pain kuin kohdassa 10: onko public-skeemassa
  -- YHTAAN taulua ilman RLS:aa. Taulu, joka joskus lisataan ilman
  -- politiikkoja, nakyy tassa eika missaan muualla.
  select '33', 'F turva', 'Yhtaan public-taulua ei ole ilman RLS:aa', '0',
         (select count(*)::text from pg_class
           where relnamespace = 'public'::regnamespace
             and relkind = 'r' and not relrowsecurity)

  union all
  select '34', 'F turva', 'PUBLIC-roolilla ei ole oikeuksia yhteenkaan public-tauluun', '0',
         (select count(*)::text
            from pg_class cl, aclexplode(cl.relacl) acl
           where cl.relnamespace = 'public'::regnamespace
             and cl.relkind = 'r' and acl.grantee = 0)

  union all
  select '35', 'F turva', 'anon-roolilla ei ole tehollista oikeutta yhteenkaan tauluun', '0',
         (select count(*)::text
            from pg_tables t
            cross join oikeudet o
           where t.schemaname = 'public'
             and has_table_privilege('anon', format('%I.%I', t.schemaname, t.tablename),
                                     o.oikeus))

  union all
  -- PAAPORTTI. Laskee jokaisen public-skeeman SECURITY DEFINER
  -- -funktion, joka EI ole tasmalleen tunnettu infrastruktuurifunktio,
  -- mukaan lukien samannimisen mutta erimuotoisen.
  --
  -- SECURITY DEFINER ohittaa RLS:n. Se on tarkalleen se rakenne, jolla
  -- taman paketin koko omistajuussuoja voidaan kiertaa.
  select '36', 'F turva', 'Tuntemattomia SECURITY DEFINER -funktioita ei ole', '0',
         (select count(*)::text from tunniste
           where not (identiteetti_ok and runko_ok))

  union all
  -- Odotus lasketaan kannan tilasta. Jos funktiota ei ole, odotus on 0
  -- ja tarkistus menee lapi -- se ei siis vaadi funktion olemassaoloa,
  -- vain sen etta JOS se on, se on oikea.
  select '37', 'F turva', 'Funktio rls_auto_enable on tunnistetiedoiltaan odotettu',
         (select count(*)::text from definer_funktiot
           where proname = 'rls_auto_enable'),
         (select count(*)::text from tunniste
           where proname = 'rls_auto_enable' and identiteetti_ok)

  union all
  select '38', 'F turva', 'Funktion rls_auto_enable runko vastaa RLS-kytkentaa',
         (select count(*)::text from definer_funktiot
           where proname = 'rls_auto_enable'),
         (select count(*)::text from tunniste
           where proname = 'rls_auto_enable' and runko_ok)

  union all
  -- Funktio on liipaisimena tauluissa tasks, routines, goals ja
  -- projects, ja se ajetaan jokaisessa UPDATEssa. Kovennuksen menetys
  -- nakyisi vain siina, mita ei enaa olisi.
  select '39', 'F turva', 'Funktio touch_updated_at on yha kovennettu', '1',
         (select count(*)::text from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'touch_updated_at'
             and p.prosecdef = false
             and p.proconfig is not null
             and exists (select 1 from unnest(p.proconfig) a
                          where a like 'search\_path=%'))

  union all
  select '40', 'F turva', 'Kymmenen updated_at-liipaisinta on tallella', '10',
         (select count(*)::text from pg_trigger t
            join pg_class c2 on c2.oid = t.tgrelid
           where not t.tgisinternal
             and c2.relnamespace = 'public'::regnamespace
             and t.tgname like '%\_touch\_updated\_at')
)

select t.check_no,
       t.section,
       t.check_name,
       t.expected,
       t.actual,
       case when t.actual = t.expected then 'PASS' else 'FAIL' end as status,
       count(*) filter (where t.actual is distinct from t.expected)
         over () as failures_total
  from tarkistukset t
 order by t.check_no;
