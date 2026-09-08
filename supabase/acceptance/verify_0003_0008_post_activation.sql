-- =====================================================================
-- AKTIVOINNIN JALKEINEN VARMISTUS: portit 0003-0008
-- =====================================================================
--
-- VAIN LUKEVA. Yksi lause, yksi tulostaulukko, yksi kopiointi.
--
-- ---------------------------------------------------------------------
-- MIKSI TAMA ON ERI TIEDOSTO KUIN POST-ACCEPTANCE
-- ---------------------------------------------------------------------
--
-- Tiedosto verify_0003_0008_post_acceptance_final.sql vaatii, etta
-- kaikki kymmenen porttitaulua ovat TYHJIA. Se oli oikea vaatimus
-- ennen aktivointia: silloin yksikin rivi olisi tarkoittanut, etta
-- jokin kirjoittaa kantaan ilman etta kukaan pyysi.
--
-- Aktivoinnin jalkeen sama vaatimus muuttuu vaaraksi. Portin
-- avaamisen KOKO TARKOITUS on, etta kayttajan tieto alkaa sailya.
-- Tyhjyysvaatimus alkaisi kaatua heti ensimmaisesta oikeasta
-- rutiinista -- ja varmistus, joka kaatuu oikeasta kaytosta, opettaa
-- lukijansa sivuuttamaan punaisen. Se on pahempi kuin varmistus jota
-- ei ole.
--
-- Siksi tama on ERI TIEDOSTO eika muokattu versio. Vanha jaa
-- paikalleen: se on yha oikea varmistus omalle hetkelleen, ja
-- peruutustilanteessa (kaikki portit kiinni) se on juuri se joka
-- ajetaan.
--
-- MITA TAMA VAATII SEN SIJAAN
--
--   sallii    kayttajan omat rivit kaikissa kymmenessa taulussa
--   vaatii    ettei yksikaan rivi ole omistajaton
--   vaatii    ettei yksikaan rivi ole orpo tai toisen kayttajan riviin
--             kiinnitetty
--   vaatii    ettei yksikaan rivi riko domain-invariantteja
--   vaatii    etta koko turvarakenne on tasmalleen ennallaan
--   vaatii    ettei hyvaksyntatestin jaannoksia ole
--
-- ---------------------------------------------------------------------
-- MILLOIN AJETAAN
-- ---------------------------------------------------------------------
-- Jokaisen aallon (A-E) tuotantodeployn ja selainhyvaksynnan jalkeen.
-- Sama tiedosto kelpaa jokaiselle aallolle: se ei vaadi mitaan tiettya
-- porttitilaa, koska se tarkistaa rakenteen ja eheyden -- ei sita mika
-- portti on auki.
--
-- AJA ENSIN PRECHECK
-- supabase/acceptance/precheck_0003_0008_auth_final.sql
--
-- Se tarkistaa istunnon roolin ja auth-kayttajien maaran, ja se vaatii
-- postgres-roolin. Tama tiedosto EI vaadi sita: se lukee vain
-- public-skeemaa ja jarjestelmakatalogeja.
--
-- ---------------------------------------------------------------------
-- MITEN AJETAAN
-- ---------------------------------------------------------------------
-- Avaa tama tiedosto, valitse KOKO sisalto (Ctrl+A), liita Supabasen
-- SQL Editoriin ja aja.
--
-- ODOTUS
-- 50 rivia: 46 invarianttia (PASS/FAIL) ja 4 tilannekuvaa (INFO).
-- Jokaisen PASS/FAIL-rivin status on PASS ja failures_total on 0.
--
-- ---------------------------------------------------------------------
-- KOLME STATUSTA, EI KAHTA
-- ---------------------------------------------------------------------
--
--   PASS   invariantti pitaa
--   FAIL   invariantti ei pida -- pysahdy
--   INFO   tilannekuva, jolla EI ole oikeaa arvoa
--
-- INFO on tassa valttamaton eika laiskuutta. Tehtavien lukumaara oli
-- ennen aktivointia invariantti (36), koska kukaan ei ollut luonut
-- tehtavia. Hyvaksynnan aikana Panu luo tehtavia tarkoituksella --
-- se on nimenomaan se mita hyvaksynnassa tehdaan. Jos lukumaara
-- pysyisi FAIL-tarkistuksena, se kaatuisi oikeasta kaytosta.
--
-- Vaihtoehto olisi poistaa luku kokonaan, mutta silloin katoaisi myos
-- se hyodyllinen tieto, ETTA joukko muuttui ja kuinka paljon. INFO
-- sailyttaa tiedon ilman etta se valehtelee olevansa vaatimus.
--
-- failures_total EI laske INFO-riveja.
--
-- ---------------------------------------------------------------------
-- YHDEN KAYTTAJAN OLETUS
-- ---------------------------------------------------------------------
-- Tarkistus 31 vaatii, etta JOKAINEN rivi kaikissa kymmenessa taulussa
-- kuuluu tunnetulle omistajalle. Se pitaa niin kauan kuin tuotannossa
-- on yksi kayttaja, ja precheck todistaa erikseen etta niin on.
--
-- JOS TUOTANTOON JOSKUS LISATAAN TOINEN OIKEA KAYTTAJA, tarkistus 31
-- on paivitettava -- ei poistettava. Oikea muoto on silloin "jokainen
-- rivi kuuluu JOLLEKIN auth.users-riville", ja se vaatii precheckin
-- puolelle siirtymista, koska se lukee auth-skeemaa.
--
-- ---------------------------------------------------------------------
-- JOS NAET "Success. No rows returned"
-- ---------------------------------------------------------------------
-- Se EI tarkoita, etta tarkistukset olisivat menneet lapi. Se
-- tarkoittaa, ettei tarkistuksia ajettu.
--
-- Tama lause ei voi palauttaa nollaa rivia: jokainen tarkistus on
-- muotoa `select <vakio>` ilman from-lausetta.
--
-- Yleisin syy: SQL Editorissa on tekstia VALITTUNA, jolloin editori
-- ajaa vain valinnan. Paina Ctrl+A ja aja uudelleen. Tassa tiedostossa
-- on TASAN YKSI puolipiste, aivan viimeisena merkkina.
--
-- ---------------------------------------------------------------------
-- MITA TAMA EI TEE
-- ---------------------------------------------------------------------
-- Ei kirjoita mitaan. Ei INSERT, UPDATE, DELETE, TRUNCATE, MERGE,
-- CREATE, ALTER, DROP, GRANT eika REVOKE. Ei SET ROLE.
--
-- Ei lue kayttajan sisaltoa: ei otsikoita, ei muistiinpanoja, ei
-- rahasummia, ei hyvinvointimerkintojen arvoja. Kaikki rivitason
-- tarkistukset ovat LASKUREITA: ne kertovat kuinka moni rivi rikkoo
-- invarianttia, eivat mika rivi tai mita siina lukee.
--
-- Ainoa poikkeus on tarkistus 46, joka etsii avainkuvioita
-- tekstikentista. Sekin palauttaa vain lukumaaran -- ei sisaltoa.
-- =====================================================================

with

-- ---------------------------------------------------------------------
-- Odotusarvot yhdessa paikassa
--
-- LUETTELOT OVAT RIVEJA, EIVAT TAULUKOITA. Sama syy kuin
-- post-acceptance-tiedostossa: `= any (alikysely)` vertaa alkioon,
-- ja text[]-sarakkeen kanssa se kaatuu koodiin 42883. Rivijoukkona
-- jasenyys on `in (select ...)`, jolloin molemmat puolet ovat
-- skalaareja eika tulkinnanvaraa ole.
-- ---------------------------------------------------------------------
portit(taulu) as (
  values ('routines'::text), ('routine_exceptions'), ('goals'), ('projects'),
         ('notification_preferences'), ('wellbeing_entries'),
         ('recurring_expenses'), ('bills'), ('savings_goals'),
         ('ai_action_audit')
),

crud_taulut(taulu) as (
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
         36::bigint as tehtavia_lahtoarvo,
         '1acdb7371be22cfa457b4dae0d0aa800'::text as tiiviste_lahtoarvo
),

-- ---------------------------------------------------------------------
-- SECURITY DEFINER -funktioiden sallittavuus
--
-- Ympariston oma infrastruktuurifunktio public.rls_auto_enable()
-- kytkee RLS:n paalle uusiin public-skeeman tauluihin. Se on sallittu,
-- mutta VAIN tasmalleen tunnetussa muodossa. Nimi ei ole tunniste:
-- kuka tahansa voi luoda funktion milla tahansa nimella.
--
-- SALLITTAVUUS ON MERKKI MERKILTA SAMA kuin tiedostoissa
-- verify_0004_0008_final.sql ja
-- verify_0003_0008_post_acceptance_final.sql.
--
-- Se ei ole tyylikysymys vaan vaatimus. Jos kolme varmistusta
-- kysyisivat samasta funktiosta eri kysymyksen, ne voisivat antaa eri
-- vastauksen -- ja silloin operaattori uskoisi sita, joka sattuu
-- olemaan vihrea. Automaattinen testi vertaa ehdot merkkijonoina, ja
-- se kaatuu jos yksikin niista erkanee.
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

tarkistukset(check_no, section, check_name, expected, actual, kind) as (

  -- =================================================================
  -- A. HYVAKSYNTATESTIN JAANNOKSET
  --
  -- Live-hyvaksyntatesti loi rivejae tunnisteilla, joissa on etuliite
  -- manifestival_rls_acceptance_. Se siivosi ne itse ja valiaikainen
  -- tili B poistettiin. Naiden on oltava poissa PYSYVASTI: jos jokin
  -- palaa, jokin ajaa hyvaksyntatestia tuotantoa vasten.
  -- =================================================================

  select '01' as check_no, 'A jaannokset' as section,
         'Hyvaksyntatestin tehtavajaannoksia ei ole' as check_name,
         '0' as expected,
         (select count(*)::text from public.tasks
           where id like (select etuliite from vakiot) || '%') as actual,
         'gate' as kind

  union all
  -- Yhdeksan tekstiavaimellista porttitaulua. Muistutusasetusten
  -- tunniste on kayttajan uuid eika testin etuliite, joten sen
  -- jaannos nakyy omistajuustarkistuksessa 30.
  select '02', 'A jaannokset', 'Hyvaksyntatestin jaannoksia ei ole porttitauluissa', '0',
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
            where id like (select etuliite from vakiot) || '%'))::text,
         'gate'

  union all
  -- ERI VAITE KUIN 02: naiden rivien ei pitanyt syntya LAINKAAN.
  -- Siivous poistaisi rivin jos se olisi syntynyt, eika sita nakisi
  -- rivimaarista. Jos jokin naista loytyy, yhdistelmavierasavain ei
  -- pitanyt.
  select '03', 'A jaannokset', 'Ristiinkiinnitysyrityksia ei ole kannassa', '0',
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
            where id like (select etuliite from vakiot) || '%_attack_%'))::text,
         'gate'

  -- =================================================================
  -- B. RAKENNE
  -- =================================================================

  union all
  select '04', 'B rakenne', 'Kaikki kymmenen porttitaulua ovat olemassa', '10',
         (select count(*)::text from pg_tables
           where schemaname = 'public'
             and tablename::text in (select taulu from portit)),
         'gate'

  union all
  -- MATCH SIMPLE ohittaa yhdistelmavierasavaimen tarkistuksen, jos
  -- yksikin avaimen sarake on NULL. Jos user_id sallisi NULLin
  -- yhdessakin viittaavassa taulussa, koko suoja katoaisi hiljaa.
  select '05', 'B rakenne', 'user_id on NOT NULL kaikissa kymmenessa taulussa', '10',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public'
             and table_name in ('tasks', 'routines', 'routine_exceptions',
                                'goals', 'projects', 'wellbeing_entries',
                                'recurring_expenses', 'bills', 'savings_goals',
                                'ai_action_audit')
             and column_name = 'user_id' and is_nullable = 'NO'),
         'gate'

  union all
  select '06', 'B rakenne', 'Omistajan asettaa kanta, ei asiakas', '10',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public'
             and ((table_name in ('routines', 'routine_exceptions', 'goals',
                                  'projects', 'wellbeing_entries',
                                  'recurring_expenses', 'bills', 'savings_goals',
                                  'ai_action_audit')
                   and column_name = 'user_id')
                  or (table_name = 'notification_preferences' and column_name = 'id'))
             and column_default like '%auth.uid()%'),
         'gate'

  union all
  -- NELJAKYMMENTAKAKSI NIMETTYA CHECK-RAJOITETTA.
  --
  -- Nama ovat se rakenne, joka pitaa rivi-invariantit voimassa
  -- JOKAISESSA kirjoituksessa. Tarkistukset 35-44 katsovat samoja
  -- asioita datasta -- tama katsoo, etta kanta valvoo niita itse.
  --
  -- Kumpikaan ei riita yksin: rajoite voi olla NOT VALID (tarkistus
  -- 08), ja data voi olla puhdasta vaikka rajoite olisi pudotettu.
  select '07', 'B rakenne', 'Neljakymmentakaksi domain-rajoitetta on tallella', '42',
         (select count(*)::text
            from pg_constraint con
            join pg_class t on t.oid = con.conrelid
           where con.contype = 'c'
             and t.relnamespace = 'public'::regnamespace
             and t.relname::text in (select taulu from portit)),
         'gate'

  union all
  -- NOT VALID -rajoite koskee vain uusia rivejae. Sellainen nayttaisi
  -- luettelossa aivan samalta mutta paastaisi vanhat rikkovat rivit
  -- lapi.
  select '08', 'B rakenne', 'Yhtaan domain-rajoitetta ei ole validoimatta', '0',
         (select count(*)::text
            from pg_constraint con
            join pg_class t on t.oid = con.conrelid
           where con.contype = 'c'
             and t.relnamespace = 'public'::regnamespace
             and t.relname::text in (select taulu from portit)
             and not con.convalidated),
         'gate'

  -- =================================================================
  -- C. RLS
  -- =================================================================

  union all
  select '09', 'C rls', 'RLS on paalla kaikissa kymmenessa taulussa', '10',
         (select count(*)::text from pg_class
           where relnamespace = 'public'::regnamespace
             and relname::text in (select taulu from portit)
             and relrowsecurity),
         'gate'

  union all
  select '10', 'C rls', 'Neljakymmenta omistajuuspolitiikkaa on tallella', '40',
         (select count(*)::text from pg_policies
           where schemaname = 'public'
             and tablename::text in (select taulu from portit)),
         'gate'

  union all
  select '11', 'C rls', 'Jokainen politiikka on vain authenticated-roolille', '40',
         (select count(*)::text from pg_policies
           where schemaname = 'public'
             and tablename::text in (select taulu from portit)
             and roles = '{authenticated}'::name[]),
         'gate'

  union all
  -- Politiikan OLEMASSAOLO ei todista mitaan: using (true) nayttaisi
  -- luettelossa aivan samalta. Ehdot luetaan ja verrataan, ja
  -- MOLEMMAT puolet. Pelkka USING sallisi rivin kirjoittamisen toisen
  -- nimiin.
  select '12', 'C rls', 'Jokainen politiikka rajaa omistajuuden molemmilta puolilta', '40',
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
                        then 'auth.uid()=id' else 'auth.uid()=user_id' end),
         'gate'

  -- =================================================================
  -- D. OIKEUDET
  -- =================================================================

  union all
  select '13', 'D oikeudet', 'anon-roolilla ei ole tehollista oikeutta porttitauluihin', '0',
         (select count(*)::text
            from portit t
            cross join oikeudet o
           where has_table_privilege('anon', format('public.%I', t.taulu), o.oikeus)),
         'gate'

  union all
  -- PUBLICille myonnetty oikeus ei nay roolikohtaisissa listauksissa
  -- lainkaan, joten se luetaan taulun omasta oikeuslistasta.
  select '14', 'D oikeudet', 'PUBLIC-roolilla ei ole oikeuksia porttitauluihin', '0',
         (select count(*)::text
            from pg_class cl, aclexplode(cl.relacl) acl
           where cl.relnamespace = 'public'::regnamespace
             and cl.relname::text in (select taulu from portit)
             and acl.grantee = 0),
         'gate'

  union all
  select '15', 'D oikeudet', 'authenticated-roolilla on tasan CRUD yhdessatoista taulussa', '44',
         (select count(*)::text
            from crud_taulut t
            cross join oikeudet o
           where has_table_privilege('authenticated', t.taulu, o.oikeus)),
         'gate'

  union all
  -- Kysytaan toisin pain kuin kohdassa 09: onko public-skeemassa
  -- YHTAAN taulua ilman RLS:aa. Taulu, joka joskus lisataan ilman
  -- politiikkoja, nakyy tassa eika missaan muualla.
  select '16', 'D oikeudet', 'Yhtaan public-taulua ei ole ilman RLS:aa', '0',
         (select count(*)::text from pg_class
           where relnamespace = 'public'::regnamespace
             and relkind = 'r' and not relrowsecurity),
         'gate'

  union all
  select '17', 'D oikeudet', 'PUBLIC-roolilla ei ole oikeuksia yhteenkaan public-tauluun', '0',
         (select count(*)::text
            from pg_class cl, aclexplode(cl.relacl) acl
           where cl.relnamespace = 'public'::regnamespace
             and cl.relkind = 'r' and acl.grantee = 0),
         'gate'

  union all
  select '18', 'D oikeudet', 'anon-roolilla ei ole tehollista oikeutta yhteenkaan tauluun', '0',
         (select count(*)::text
            from pg_tables t
            cross join oikeudet o
           where t.schemaname = 'public'
             and has_table_privilege('anon', format('%I.%I', t.schemaname, t.tablename),
                                     o.oikeus)),
         'gate'

  -- =================================================================
  -- E. VIERASAVAIMET
  -- =================================================================

  union all
  -- VALIDOITU on olennainen sana. `convalidated` tarkoittaa, etta
  -- rajoite tarkistettiin myos jo olemassa olleita rivejae vastaan --
  -- NOT VALID -rajoite koskisi vain uusia.
  --
  -- Viite luetaan katalogista. Se ei lue auth.users-taulun SISALTOA,
  -- joten se ei vaadi lukuoikeutta siihen.
  select '19', 'E viitteet',
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
             and t.relname::text in (select taulu from portit)),
         'gate'

  union all
  -- YHDEKSAN OMISTAJUUSVIITETTA. Rakenne luetaan katalogista eika
  -- nimista: conkey kertoo montako saraketta avaimessa on, user_id:n
  -- on oltava yksi niista, ja confkey kertoo etta kohde on pari
  -- (user_id, id).
  --
  -- TAMA ON KOKO PAKETIN TARKEIN RAKENNETARKISTUS. Vierasavaimen
  -- tarkistus EI kulje RLS:n lapi: RLS estaa lukemisen, ei
  -- viittaamista. Ilman yhdistelmaviitetta kayttaja voisi kiinnittaa
  -- oman rivinsa toisen kayttajan riviin, vaikka ei nakisi sita.
  select '20', 'E viitteet', 'Yhdeksan omistajuuden yhdistelmavierasavainta', '9',
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
                 = array['id', 'user_id']),
         'gate'

  union all
  -- ERI VAITE KUIN 20: tama laskee ETTEI heikompia ole. Kumpikaan
  -- yksin ei riita, koska kannassa voisi olla oikea viite ja vanha sen
  -- vieressa -- ja heikompi paastaisi rivin lapi.
  select '21', 'E viitteet', 'Yhtaan yhden sarakkeen viitetta sovellustauluun ei ole', '0',
         (select count(*)::text
            from pg_constraint con
            join pg_class t on t.oid = con.conrelid
            join pg_class ft on ft.oid = con.confrelid
           where con.contype = 'f'
             and t.relnamespace = 'public'::regnamespace
             and ft.relnamespace = 'public'::regnamespace
             and array_length(con.conkey, 1) < 2),
         'gate'

  union all
  -- Ilman sarakelistaa poisto yrittaisi nollata myos user_id:n, joka
  -- on NOT NULL, ja kohteen poistaminen kaatuisi joka kerta.
  select '22', 'E viitteet', 'Kahdeksan nollaavaa viitetta rajaa nollauksen sarakkeeseen', '8',
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
                              where a.attname = 'user_id')),
         'gate'

  union all
  -- Poikkeus ilman rutiinia ei tarkoita mitaan, joten tama yksi viite
  -- on tarkoituksella CASCADE eika SET NULL.
  select '23', 'E viitteet', 'Poikkeuksen viite rutiiniin on CASCADE', '1',
         (select count(*)::text
            from pg_constraint con
            join pg_class t on t.oid = con.conrelid
            join pg_class ft on ft.oid = con.confrelid
           where con.contype = 'f'
             and t.relname = 'routine_exceptions'
             and ft.relname = 'routines'
             and array_length(con.conkey, 1) = 2
             and con.confdeltype = 'c'),
         'gate'

  union all
  -- Yhdistelmavierasavain vaatii kohteelta yksikasitteisyysrajoitteen.
  -- Ilman naita viitteita ei olisi voitu luoda lainkaan.
  select '24', 'E viitteet', 'Viisi omistajan rivin avainta (user_id, id)', '5',
         (select count(*)::text from pg_constraint con
           where con.conname in ('routines_owner_row_key', 'goals_owner_row_key',
                                 'projects_owner_row_key', 'tasks_owner_row_key',
                                 'recurring_expenses_owner_row_key')
             and con.contype = 'u'
             and (select array_agg(a.attname::text order by a.attname)
                    from unnest(con.conkey) k(attnum)
                    join pg_attribute a
                      on a.attrelid = con.conrelid and a.attnum = k.attnum)
                 = array['id', 'user_id']),
         'gate'

  -- =================================================================
  -- F. FUNKTIOT JA LIIPAISIMET
  -- =================================================================

  union all
  -- PAAPORTTI. Laskee jokaisen public-skeeman SECURITY DEFINER
  -- -funktion, joka EI ole tasmalleen tunnettu infrastruktuurifunktio,
  -- mukaan lukien samannimisen mutta erimuotoisen.
  --
  -- SECURITY DEFINER ohittaa RLS:n. Se on tarkalleen se rakenne, jolla
  -- taman paketin koko omistajuussuoja voidaan kiertaa.
  select '25', 'F funktiot', 'Tuntemattomia SECURITY DEFINER -funktioita ei ole', '0',
         (select count(*)::text from tunniste
           where not (identiteetti_ok and runko_ok)),
         'gate'

  union all
  -- Odotus lasketaan kannan tilasta. Jos funktiota ei ole, odotus on 0
  -- ja tarkistus menee lapi -- se ei siis vaadi funktion olemassaoloa,
  -- vain sen etta JOS se on, se on oikea.
  select '26', 'F funktiot', 'Funktio rls_auto_enable on tunnistetiedoiltaan odotettu',
         (select count(*)::text from definer_funktiot
           where proname = 'rls_auto_enable'),
         (select count(*)::text from tunniste
           where proname = 'rls_auto_enable' and identiteetti_ok),
         'gate'

  union all
  select '27', 'F funktiot', 'Funktion rls_auto_enable runko vastaa RLS-kytkentaa',
         (select count(*)::text from definer_funktiot
           where proname = 'rls_auto_enable'),
         (select count(*)::text from tunniste
           where proname = 'rls_auto_enable' and runko_ok),
         'gate'

  union all
  -- Funktio ajetaan jokaisessa UPDATEssa kymmenessa taulussa.
  -- Kovennuksen menetys nakyisi vain siina, mita ei enaa olisi.
  select '28', 'F funktiot', 'Funktio touch_updated_at on yha kovennettu', '1',
         (select count(*)::text from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'touch_updated_at'
             and p.prosecdef = false
             and p.proconfig is not null
             and exists (select 1 from unnest(p.proconfig) a
                          where a like 'search\_path=%')),
         'gate'

  union all
  select '29', 'F funktiot', 'Kymmenen updated_at-liipaisinta on tallella', '10',
         (select count(*)::text from pg_trigger t
            join pg_class c2 on c2.oid = t.tgrelid
           where not t.tgisinternal
             and c2.relnamespace = 'public'::regnamespace
             and t.tgname like '%\_touch\_updated\_at'),
         'gate'

  -- =================================================================
  -- G. OMISTAJUUS JA EHEYS
  --
  -- TASSA TAMA VARMISTUS EROAA EDELTAJASTAAN. Rivien OLEMASSAOLO on
  -- nyt sallittua, mutta niiden OMISTAJUUS ja EHEYS ei ole neuvoteltavissa.
  -- =================================================================

  union all
  select '30', 'G omistajuus', 'Omistajattomia riveja ei ole yhdessakaan porttitaulussa', '0',
         ((select count(*) from public.routines where user_id is null)
        + (select count(*) from public.routine_exceptions where user_id is null)
        + (select count(*) from public.goals where user_id is null)
        + (select count(*) from public.projects where user_id is null)
        + (select count(*) from public.wellbeing_entries where user_id is null)
        + (select count(*) from public.recurring_expenses where user_id is null)
        + (select count(*) from public.bills where user_id is null)
        + (select count(*) from public.savings_goals where user_id is null)
        + (select count(*) from public.ai_action_audit where user_id is null))::text,
         'gate'

  union all
  -- YHDEN KAYTTAJAN OLETUS. Ks. tiedoston alun huomautus: jos
  -- tuotantoon lisataan toinen oikea kayttaja, tama on PAIVITETTAVA
  -- muotoon "kuuluu jollekin auth.users-riville" -- ei poistettava.
  --
  -- notification_preferences rajataan id-sarakkeella, koska sen
  -- omistaja on paaavain itse.
  select '31', 'G omistajuus', 'Jokainen porttitaulun rivi kuuluu tunnetulle omistajalle', '0',
         ((select count(*) from public.routines
            where user_id is distinct from (select omistaja from vakiot))
        + (select count(*) from public.routine_exceptions
            where user_id is distinct from (select omistaja from vakiot))
        + (select count(*) from public.goals
            where user_id is distinct from (select omistaja from vakiot))
        + (select count(*) from public.projects
            where user_id is distinct from (select omistaja from vakiot))
        + (select count(*) from public.notification_preferences
            where id is distinct from (select omistaja from vakiot))
        + (select count(*) from public.wellbeing_entries
            where user_id is distinct from (select omistaja from vakiot))
        + (select count(*) from public.recurring_expenses
            where user_id is distinct from (select omistaja from vakiot))
        + (select count(*) from public.bills
            where user_id is distinct from (select omistaja from vakiot))
        + (select count(*) from public.savings_goals
            where user_id is distinct from (select omistaja from vakiot))
        + (select count(*) from public.ai_action_audit
            where user_id is distinct from (select omistaja from vakiot)))::text,
         'gate'

  union all
  -- EHEYS RIIPPUMATTA TESTISTA.
  --
  -- Kysyy toisin pain kuin rakennetarkistukset: onko kannassa YHTAAN
  -- riviae, joka viittaa riviin jota ei ole tai joka kuuluu toiselle
  -- kayttajalle. Tama ei tarvitse tunnisteita lainkaan, joten se
  -- loytaisi myos rivin joka syntyi jotain muuta kautta.
  select '32', 'G omistajuus', 'Yhtaan riviae ei ole kiinnitetty toisen kayttajan riviin', '0',
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
            where b2.recurring_expense_id is not null and x.id is null))::text,
         'gate'

  -- =================================================================
  -- H. TUOTANNON VANHA DATA
  -- =================================================================

  union all
  select '33', 'H vanha data', 'Omistajattomia tehtavia ei ole', '0',
         (select count(*)::text from public.tasks where user_id is null),
         'gate'

  union all
  select '34', 'H vanha data', 'Yhtaan tehtavaa ei omista odottamaton kayttaja', '0',
         (select count(*)::text from public.tasks
           where user_id is distinct from (select omistaja from vakiot)),
         'gate'

  union all
  select '35', 'H vanha data', 'RLS on yha paalla tauluissa tasks ja profile', '2',
         (select count(*)::text from pg_class
           where relnamespace = 'public'::regnamespace
             and relname in ('tasks', 'profile') and relrowsecurity),
         'gate'

  union all
  select '36', 'H vanha data', 'tasks- ja profile-tauluissa on yha nelja politiikkaa kummassakin', '8',
         (select count(*)::text from pg_policies
           where schemaname = 'public' and tablename in ('tasks', 'profile')),
         'gate'

  union all
  select '37', 'H vanha data', 'Profiilirivien maara on yksi', '1',
         (select count(*)::text from public.profile),
         'gate'

  union all
  select '38', 'H vanha data', 'Profiilirivi kuuluu tunnetulle omistajalle', '0',
         (select count(*)::text from public.profile
           where id is distinct from (select omistaja from vakiot)),
         'gate'

  -- =================================================================
  -- I. RIVI-INVARIANTIT
  --
  -- Nama katsovat DATAA, eivat rakennetta. Tarkistukset 07 ja 08 varmistavat, etta
  -- kanta valvoo naita rajoitteita, ja nama varmistavat, etta valvonta on
  -- myos toiminut.
  --
  -- Jokainen palauttaa LUKUMAARAN rikkovista riveista. Yksikaan ei
  -- lue eika palauta kayttajan sisaltoa.
  -- =================================================================

  union all
  select '39', 'I rivit', 'Hyvinvoinnin asteikot ovat sallitulla valilla', '0',
         (select count(*)::text from public.wellbeing_entries
           where (energy is not null and energy not between 1 and 5)
              or (mood   is not null and mood   not between 1 and 5)
              or (stress is not null and stress not between 1 and 5)),
         'gate'

  union all
  -- TYHJA EI OLE NOLLA. Sovelluksessa oli virhe, joka teki
  -- tyhjasta kentasta arvon 1 -- eli fabrikoi mittauksen jota
  -- kayttaja ei antanut. Korjaus on tuotannossa, ja tama nakisi, jos se
  -- palaisi.
  select '40', 'I rivit', 'Unitunnit ovat sallitulla valilla', '0',
         (select count(*)::text from public.wellbeing_entries
           where sleep_hours is not null
             and (sleep_hours <= 0 or sleep_hours > 24)),
         'gate'

  union all
  -- RAHA ON KOKONAISLUKUINA SENTTEINA. Negatiivinen summa tarkoittaisi,
  -- etta jossain on tehty vahennyslasku vaarin pain.
  select '41', 'I rivit', 'Yhtaan negatiivista rahasummaa ei ole', '0',
         ((select count(*) from public.recurring_expenses where amount_minor < 0)
        + (select count(*) from public.bills where amount_minor < 0)
        + (select count(*) from public.savings_goals
            where target_minor < 0 or current_minor < 0))::text,
         'gate'

  union all
  select '42', 'I rivit', 'Valuutta on kolme isoa kirjainta kaikkialla', '0',
         ((select count(*) from public.recurring_expenses
            where currency !~ '^[A-Z]{3}$')
        + (select count(*) from public.bills
            where currency !~ '^[A-Z]{3}$')
        + (select count(*) from public.savings_goals
            where currency !~ '^[A-Z]{3}$'))::text,
         'gate'

  union all
  -- Maksettu lasku ilman maksupaivaa -- tai maksupaiva laskulla jota ei
  -- ole maksettu -- tarkoittaa, etta tila ja tosiasia ovat eri mielta.
  select '43', 'I rivit', 'Laskun tila ja maksupaiva ovat samaa mielta', '0',
         (select count(*)::text from public.bills
           where (status = 'paid' and paid_date is null)
              or (status <> 'paid' and paid_date is not null)),
         'gate'

  union all
  -- SUORITETTU ILMAN VAHVISTUSTA on koko kirjausketjun tarkein
  -- invariantti: AI ei saa olla tehnyt mitaan, mita kayttaja ei
  -- vahvistanut.
  select '44', 'I rivit', 'Yhtaan AI-toimintoa ei ole suoritettu ilman vahvistusta', '0',
         (select count(*)::text from public.ai_action_audit
           where executed = true and confirmed = false),
         'gate'

  union all
  -- Kirjausketjuun talletetaan TIIVISTELMA, ei raakaa syotetta eika
  -- koko vastausta. Pituusrajat ovat se mekanismi, joka pitaa sen
  -- niin.
  select '45', 'I rivit', 'AI-kirjausten pituusrajat pitavat', '0',
         (select count(*)::text from public.ai_action_audit
           where (input_summary is not null and length(input_summary) > 200)
              or (proposal is not null and length(proposal) > 300)),
         'gate'

  union all
  -- Avain ei saa paatya kirjausketjuun. Tama etsii kuviota, ei sisaltoa,
  -- ja palauttaa vain lukumaaran.
  select '46', 'I rivit', 'AI-kirjauksissa ei ole avaimelta nayttavaa merkkijonoa', '0',
         (select count(*)::text from public.ai_action_audit
           where coalesce(input_summary, '') like '%sk-ant-%'
              or coalesce(proposal, '') like '%sk-ant-%'
              or coalesce(input_summary, '') like '%service_role%'
              or coalesce(proposal, '') like '%service_role%'),
         'gate'

  -- =================================================================
  -- J. TILANNEKUVA (INFO)
  --
  -- Naita EI lasketa failures_totaliin. Ks. tiedoston alku, kohta
  -- "KOLME STATUSTA, EI KAHTA".
  -- =================================================================

  union all
  select '47', 'J tilannekuva', 'Tehtavien lukumaara (lahtoarvo 36)',
         (select tehtavia_lahtoarvo::text from vakiot),
         (select count(*)::text from public.tasks),
         'info'

  union all
  -- Tunnisteiden tiiviste. Rivimaara voi tasmata, vaikka rivit
  -- olisivat eri. Tama kertoo onko joukko sama, eika paljasta
  -- yhdenkaan rivin sisaltoa.
  select '48', 'J tilannekuva', 'Tehtavien tunnisteiden tiiviste (lahtoarvo)',
         (select tiiviste_lahtoarvo from vakiot),
         (select coalesce(md5(string_agg(id, ',' order by id)), 'ei riveja')
            from public.tasks),
         'info'

  union all
  select '49', 'J tilannekuva', 'Porttitaulujen rivimaara yhteensa', 'vapaa',
         ((select count(*) from public.routines)
        + (select count(*) from public.routine_exceptions)
        + (select count(*) from public.goals)
        + (select count(*) from public.projects)
        + (select count(*) from public.notification_preferences)
        + (select count(*) from public.wellbeing_entries)
        + (select count(*) from public.recurring_expenses)
        + (select count(*) from public.bills)
        + (select count(*) from public.savings_goals)
        + (select count(*) from public.ai_action_audit))::text,
         'info'

  union all
  select '50', 'J tilannekuva', 'Aallot A-B-C-D-E rivimaarina', 'A / B / C / D / E',
         ((select count(*) from public.notification_preferences)
        + (select count(*) from public.wellbeing_entries))::text || ' / '
      || ((select count(*) from public.goals)
        + (select count(*) from public.projects))::text || ' / '
      || ((select count(*) from public.routines)
        + (select count(*) from public.routine_exceptions))::text || ' / '
      || ((select count(*) from public.recurring_expenses)
        + (select count(*) from public.savings_goals)
        + (select count(*) from public.bills))::text || ' / '
      || (select count(*) from public.ai_action_audit)::text,
         'info'
)

select t.check_no,
       t.section,
       t.check_name,
       t.expected,
       t.actual,
       case when t.kind = 'info' then 'INFO'
            when t.actual = t.expected then 'PASS'
            else 'FAIL' end as status,
       count(*) filter (where t.kind = 'gate'
                          and t.actual is distinct from t.expected)
         over () as failures_total
  from tarkistukset t
 order by t.check_no;
