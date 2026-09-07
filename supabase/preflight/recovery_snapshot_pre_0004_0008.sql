-- Palautuskuva: ENNEN migraatioerää 0004–0008
-- VAIN LUKEVA. Yksi lause, yksi taulukko, yksi kopiointi.
--
-- MILLOIN: kerran, ennen kuin erä aloitetaan — heti eräpreflightin
-- jälkeen ja ennen ensimmäistä migraatiota.
--
-- MITÄ TÄMÄ ON
-- Tämä ei ole varmuuskopio. Varmuuskopio otetaan Supabasen omalla
-- toiminnolla, ja se on eri asia ja tehdään ensin.
--
-- Tämä on LOGGINEN KUVA kannan rakenteesta ja mitoista sillä hetkellä,
-- kun erä alkaa. Sen tarkoitus on vastata palautuksen jälkeen
-- kysymykseen, johon varmuuskopio ei vastaa:
--
--   "Onko kanta nyt siinä tilassa, jossa se oli ennen erää — vai
--    jossain muussa tilassa, joka vain näyttää toimivalta?"
--
-- Rakenteen palautuminen ei tarkoita samaa kuin palvelimen
-- käynnistyminen. Rivimäärä voi olla oikein ja politiikka silti kadonnut;
-- taulu voi olla paikallaan ja sen oikeudet väärin. Tämä kuva tekee
-- eron näkyväksi, koska sama kysely ajetaan palautuksen jälkeen ja
-- tuloksia verrataan riveittäin.
--
-- KÄYTTÖ
--   1. Aja tämä ENNEN erää. Kopioi koko tulos talteen.
--   2. Jos erä joudutaan perumaan ja kanta palautetaan varmuuskopiosta,
--      aja tämä UUDELLEEN ja vertaa tuloksia.
--   3. Jokaisen rivin on oltava sama. Ero missä tahansa rivissä
--      tarkoittaa, ettei palautus ole valmis.
--
-- TÄMÄ TIEDOSTO EI LUE KÄYTTÄJÄN SISÄLTÖÄ.
-- Ei otsikoita, ei muistiinpanoja, ei sähköpostiosoitteita, ei
-- profiiliarvoja. Tunnisteista lasketaan tiiviste, jotta joukon
-- muuttumattomuuden voi todeta lukematta yhtään riviä.

select c.rivi_no, c.osuus, c.mittari, c.arvo
from (

  -- ================================================================
  -- TUNNISTE: MISTÄ KANNASTA TÄMÄ KUVA ON
  -- ================================================================
  -- Ilman näitä kuvan voisi verrata vahingossa väärään kantaan, ja
  -- silloin "kaikki täsmää" tarkoittaisi vain että molemmat ovat
  -- tyhjiä.

  select '01' as rivi_no, 'tunniste' as osuus,
         'Tietokanta' as mittari,
         current_database() as arvo

  union all
  select '02', 'tunniste', 'Palvelimen versio', current_setting('server_version')

  union all
  select '03', 'tunniste', 'Kuvan hetki (UTC)',
         to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS')

  union all
  select '04', 'tunniste', 'Hyvaksytty omistaja loytyy',
         (select count(*)::text from auth.users
           where id = '2cc00622-f927-4604-a518-361a4328481b'::uuid)

  -- ================================================================
  -- MITAT: PALJONKO DATAA ON
  -- ================================================================
  -- Rivimäärä on karkea mittari, mutta se on ainoa joka huomaa
  -- puuttuvat rivit. Rakenne voi palautua täydellisenä ja data
  -- puolittain.

  union all
  select '05', 'mitat', 'Tehtavia', (select count(*)::text from public.tasks)

  union all
  select '06', 'mitat', 'Profiilirivejä', (select count(*)::text from public.profile)

  union all
  select '07', 'mitat', 'Auth-kayttajia', (select count(*)::text from auth.users)

  union all
  -- Rutiinit ja poikkeukset ovat olemassa vain jos 0003 on ajettu.
  -- to_regclass palauttaa NULL puuttuvalle taululle, joten tama ei
  -- kaadu kummassakaan tapauksessa.
  select '08', 'mitat', 'Rutiineja (tai EI TAULUA)',
         (select case when to_regclass('public.routines') is null
                      then 'EI TAULUA'
                      else (select count(*)::text from public.routines) end)

  union all
  select '09', 'mitat', 'Rutiinipoikkeuksia (tai EI TAULUA)',
         (select case when to_regclass('public.routine_exceptions') is null
                      then 'EI TAULUA'
                      else (select count(*)::text from public.routine_exceptions) end)

  -- ================================================================
  -- TUNNISTEJOUKKO: OVATKO SAMAT RIVIT
  -- ================================================================
  -- Rivimäärä voi täsmätä, vaikka rivit olisivat eri. Tiiviste
  -- tunnisteista kertoo, onko joukko sama — eikä paljasta yhdenkään
  -- rivin sisältöä.

  union all
  select '10', 'joukko', 'Tehtavien tunnisteiden tiiviste',
         (select coalesce(md5(string_agg(id, ',' order by id)), 'ei rivejä')
            from public.tasks)

  union all
  select '11', 'joukko', 'Tehtavien omistajien tiiviste',
         (select coalesce(md5(string_agg(distinct user_id::text, ',')), 'ei rivejä')
            from public.tasks)

  union all
  select '12', 'joukko', 'Rutiinien tunnisteiden tiiviste',
         (select case when to_regclass('public.routines') is null
                      then 'EI TAULUA'
                      else (select coalesce(md5(string_agg(id, ',' order by id)),
                                            'ei rivejä')
                              from public.routines) end)

  -- ================================================================
  -- RAKENNE: MITÄ KANNASSA ON
  -- ================================================================
  -- Nämä luvut ovat se, mihin palautusta verrataan. Jokainen niistä
  -- voi palautua väärin ilman että mikään kaatuu.

  union all
  select '13', 'rakenne', 'Tauluja public-skeemassa',
         (select count(*)::text from pg_tables where schemaname = 'public')

  union all
  select '14', 'rakenne', 'Taulujen nimet aakkosjarjestyksessa',
         (select string_agg(tablename, ', ' order by tablename)
            from pg_tables where schemaname = 'public')

  union all
  select '15', 'rakenne', 'Sarakkeita public-skeemassa',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public')

  union all
  select '16', 'rakenne', 'tasks-taulun sarakkeet',
         (select string_agg(column_name, ', ' order by column_name)
            from information_schema.columns
           where table_schema = 'public' and table_name = 'tasks')

  union all
  select '17', 'rakenne', 'Indekseja public-skeemassa',
         (select count(*)::text from pg_indexes where schemaname = 'public')

  union all
  select '18', 'rakenne', 'Liipaisimia public-skeemassa',
         (select count(*)::text from pg_trigger t
            join pg_class c2 on c2.oid = t.tgrelid
           where not t.tgisinternal
             and c2.relnamespace = 'public'::regnamespace)

  union all
  select '19', 'rakenne', 'Rajoitteita public-skeemassa',
         (select count(*)::text from pg_constraint
           where connamespace = 'public'::regnamespace)

  union all
  -- Vierasavaimet erikseen, koska koko eran ydin on niissa. Jos
  -- palautuksen jalkeen naita on eri maara, jokin viite on kadonnut —
  -- eika kadonnut viite kaada mitaan, se vain lakkaa suojaamasta.
  select '20', 'rakenne', 'Vierasavaimia public-skeemassa',
         (select count(*)::text from pg_constraint
           where connamespace = 'public'::regnamespace and contype = 'f')

  union all
  select '21', 'rakenne', 'Vierasavainten nimet',
         (select coalesce(string_agg(conname, ', ' order by conname), 'ei yhtaan')
            from pg_constraint
           where connamespace = 'public'::regnamespace and contype = 'f')

  union all
  select '22', 'rakenne', 'Funktion touch_updated_at kovennus',
         (select case when count(*) = 1 then 'KOVENNETTU' else 'EI KOVENNETTU' end
            from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'touch_updated_at'
             and p.prosecdef = false
             and p.proconfig is not null
             and exists (select 1 from unnest(p.proconfig) a
                          where a like 'search\_path=%'))

  -- ================================================================
  -- TURVAMALLI: KUKA PÄÄSEE MIHIN
  -- ================================================================
  -- Tämä on se osa, joka palautuu hiljaisimmin väärin. Taulu näyttää
  -- samalta ja data on tallella, mutta RLS on pois päältä tai
  -- politiikka on kadonnut — eikä mikään kaadu. Ensimmäinen merkki
  -- olisi se, että joku näkee toisen ihmisen tiedot.

  union all
  select '23', 'turvamalli', 'Tauluja joissa RLS on paalla',
         (select count(*)::text from pg_class
           where relnamespace = 'public'::regnamespace
             and relkind = 'r' and relrowsecurity)

  union all
  select '24', 'turvamalli', 'Tauluja joissa RLS EI ole paalla',
         (select coalesce(string_agg(relname, ', ' order by relname), 'ei yhtaan')
            from pg_class
           where relnamespace = 'public'::regnamespace
             and relkind = 'r' and not relrowsecurity)

  union all
  select '25', 'turvamalli', 'Politiikkoja public-skeemassa',
         (select count(*)::text from pg_policies where schemaname = 'public')

  union all
  select '26', 'turvamalli', 'Politiikat taulukohtaisesti',
         (select string_agg(rivi, ' | ' order by rivi) from (
            select tablename || '=' || count(*)::text as rivi
              from pg_policies where schemaname = 'public'
             group by tablename
          ) yhteenveto)

  union all
  -- Politiikan olemassaolo ei kerro, mita se sallii. Tama laskee
  -- politiikat, joiden ehto on tasmalleen omistajuusrajaus. Jos luku
  -- putoaa palautuksessa, jokin politiikka on palautunut loysempana.
  select '27', 'turvamalli', 'Politiikkoja joiden ehto on omistajuusrajaus',
         (select count(*)::text from pg_policies
           where schemaname = 'public'
             and btrim(replace(coalesce(qual, with_check), ' ', ''), '()')
                 in ('auth.uid()=user_id', 'auth.uid()=id'))

  union all
  select '28', 'turvamalli', 'anon-roolin tehollisia oikeuksia public-tauluihin',
         (select count(*)::text
            from pg_tables t
            cross join (select unnest(array['select', 'insert', 'update', 'delete',
                                            'truncate', 'references', 'trigger']) as oikeus) pp
           where t.schemaname = 'public'
             and has_table_privilege('anon', format('%I.%I', t.schemaname, t.tablename),
                                     pp.oikeus))

  union all
  -- PUBLIC-roolille myonnetty oikeus ei nay roolikohtaisissa
  -- listauksissa lainkaan, joten se on luettava taulun omasta
  -- oikeuslistasta.
  select '29', 'turvamalli', 'PUBLIC-roolin oikeuksia public-taulujen listoissa',
         (select count(*)::text
            from pg_class cl, aclexplode(cl.relacl) acl
           where cl.relnamespace = 'public'::regnamespace
             and cl.relkind = 'r' and acl.grantee = 0)

  union all
  select '30', 'turvamalli', 'authenticated-roolin tehollisia oikeuksia',
         (select count(*)::text
            from pg_tables t
            cross join (select unnest(array['select', 'insert', 'update', 'delete',
                                            'truncate', 'references', 'trigger']) as oikeus) pp
           where t.schemaname = 'public'
             and has_table_privilege('authenticated',
                                     format('%I.%I', t.schemaname, t.tablename),
                                     pp.oikeus))

  -- ================================================================
  -- ERÄN RAJA: MITÄ EI VIELÄ OLE
  -- ================================================================
  -- Nämä ovat nolla ennen erää. Palautuksen jälkeen niiden on oltava
  -- nolla uudelleen — muuten palautus on jäänyt puolitiehen ja kannassa
  -- on erän jäänteitä.

  union all
  select '31', 'raja', 'Eran tauluja olemassa (odotus 0 ennen eraa)',
         (select count(*)::text from pg_tables
           where schemaname = 'public'
             and tablename in ('goals', 'projects', 'notification_preferences',
                               'wellbeing_entries', 'bills', 'recurring_expenses',
                               'savings_goals', 'ai_action_audit'))

  union all
  select '32', 'raja', 'Eran sarakkeita tasks-taulussa (odotus 0 ennen eraa)',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'tasks'
             and column_name in ('deadline', 'goal_id', 'project_id'))

  union all
  select '33', 'raja', 'tasks_owner_row_key olemassa (odotus 0 ennen eraa)',
         (select count(*)::text from pg_constraint
           where conname = 'tasks_owner_row_key')

) c
order by c.rivi_no;
