-- Preflight: ENNEN migraatiota 0002
-- VAIN LUKEVA. Yksi lause, yksi taulukko, yksi kopiointi.
--
-- MILLOIN: juuri ennen kuin 0002 ajetaan, samassa istunnossa jos
-- mahdollista. Tama vastaa kysymykseen "onko tuotanto siina tilassa,
-- jota 0002 olettaa" — ennen kuin 0002 itse sen paattaa.
--
-- 0002 tarkistaa samat asiat itsekin ja keskeytyy jos jokin ei tasmaa.
-- Tama tiedosto on olemassa siksi, etta keskeytynyt migraatio on
-- kalliimpi kuin lukeva kysely: tama kertoo saman asian ilman lukkoa,
-- ilman transaktiota ja ilman katkoa.
--
-- ODOTUS: jokaisen PASS/FAIL-rivin status = 'PASS' ja
-- poikkeavia_yhteensa = 0. INFO-rivit eivat ole vikoja: ne ovat lukuja,
-- jotka operaattorin on kirjattava yloos ja verrattava verify_0002:n
-- vastaaviin lukuihin migraation jalkeen.
--
-- Tama tiedosto EI lue kayttajan sisaltoa. Se laskee rivimaaria ja
-- katsoo rakennetta.

select c.check_no,
       c.section,
       c.check_name,
       case when c.odotus = 'INFO'      then 'INFO'
            when c.toteutui = c.odotus  then 'PASS'
            else 'FAIL' end as status,
       case when c.odotus = 'INFO' then c.toteutui
            else 'odotus ' || c.odotus || ', toteutui ' || c.toteutui end as details,
       count(*) filter (where c.odotus <> 'INFO' and c.toteutui <> c.odotus)
         over () as poikkeavia_yhteensa
from (

  -- ================================================================
  -- 0001 ON AJETTU JA YHA VOIMASSA
  -- ================================================================

  select '01' as check_no, '0001-perusta' as section,
         'Taulu public.tasks on olemassa' as check_name,
         '1' as odotus,
         (select count(*)::text from pg_class
           where oid = to_regclass('public.tasks')) as toteutui

  union all
  select '02', '0001-perusta', 'Omistajasarake tasks.user_id on olemassa', '1',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'tasks'
             and column_name = 'user_id')

  union all
  select '03', '0001-perusta', 'RLS on paalla taulussa tasks', '1',
         (select count(*)::text from pg_class
           where relnamespace = 'public'::regnamespace
             and relname = 'tasks' and relrowsecurity)

  union all
  -- 0002 ei luo yhtaan politiikkaa. Se luottaa siihen, etta uudet
  -- sarakkeet perivat olemassa olevat: politiikat ovat rivikohtaisia,
  -- eivat sarakekohtaisia. Jos politiikkoja ei ole, perinta ei suojaa
  -- mitaan ja uudet sarakkeet syntyisivat suojaamattomina.
  select '04', '0001-perusta', 'tasks-taulussa on nelja omistajuuspolitiikkaa', '4',
         (select count(*)::text from pg_policies
           where schemaname = 'public' and tablename = 'tasks')

  union all
  select '05', '0001-perusta', 'Indeksi, jonka ensimmainen sarake on user_id, on olemassa', '1',
         (select least(count(*), 1)::text
            from pg_index x
            join pg_class t on t.oid = x.indrelid
            join pg_namespace n on n.oid = t.relnamespace
            join pg_attribute a on a.attrelid = t.oid and a.attnum = x.indkey[0]
           where n.nspname = 'public' and t.relname = 'tasks'
             and a.attname = 'user_id')

  -- ================================================================
  -- OMISTAJUUS ON EHJA
  -- ================================================================

  union all
  -- 0002 ei jaa omistajuutta. Siksi se ei saa myoskaan rakentaa uutta
  -- rikkinaisen paalle: omistajaton rivi jaisi omistajattomaksi ja
  -- nakymattomaksi jokaiselle kayttajalle.
  select '06', 'omistajuus', 'Omistajattomia riveja ei ole', '0',
         (select count(*)::text from public.tasks where user_id is null)

  union all
  select '07', 'omistajuus', 'Orpoja omistajaviittauksia ei ole', '0',
         (select count(*)::text
            from public.tasks t
            left join auth.users u on u.id = t.user_id
           where u.id is null)

  union all
  -- Vastaa kysymykseen "olenko oikeassa tietokannassa". Vaaraan
  -- projektiin ajettu migraatio on kalliimpi virhe kuin keskeytynyt.
  select '08', 'omistajuus', 'Hyvaksytty omistaja loytyy auth.users-taulusta', '1',
         (select count(*)::text from auth.users
           where id = '2cc00622-f927-4604-a518-361a4328481b'::uuid)

  union all
  select '09', 'omistajuus', 'Yhtaan tehtavaa ei omista joku muu kuin hyvaksytty omistaja', '0',
         (select count(*)::text from public.tasks
           where user_id is distinct from '2cc00622-f927-4604-a518-361a4328481b'::uuid)

  -- ================================================================
  -- 0002 EI OLE VIELA AJETTU EIKA KESKEN
  -- ================================================================

  union all
  -- Kaksitoista objektia: kuusi saraketta, kolme tarkistetta, funktio,
  -- liipaisin ja indeksi. Nolla = tuore ajo. Mika tahansa muu luku
  -- tarkoittaa, etta 0002 on joko ajettu tai jaanyt kesken — ja
  -- kumpaakaan ei korjata ajamalla se uudelleen.
  select '10', '0002-tila', 'Yhtaan 0002:n luomaa objektia ei ole viela olemassa', '0',
         (select count(*)::text from (
            select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'tasks'
                and column_name in ('description', 'duration_minutes', 'priority',
                                    'scheduling_state', 'created_at', 'updated_at')
            union all
            select 1 from pg_constraint
              where conrelid = 'public.tasks'::regclass
                and conname in ('tasks_priority_check', 'tasks_scheduling_state_check',
                                'tasks_duration_minutes_check')
            union all
            select 1 from pg_proc p
              join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname = 'touch_updated_at'
            union all
            select 1 from pg_trigger
              where tgrelid = 'public.tasks'::regclass
                and tgname = 'tasks_touch_updated_at' and not tgisinternal
            union all
            select 1 from pg_indexes
              where schemaname = 'public' and tablename = 'tasks'
                and indexname = 'tasks_user_date_priority_idx'
          ) objektit)

  union all
  -- VAIHE 5 lukee saraketta "time" paattaessaan, onko rivi
  -- aikataulutettu. Jos sarake puuttuu, tayttolause kaatuu keskella
  -- migraatiota.
  select '11', '0002-tila', 'Sarakkeet date ja time ovat olemassa taytettya varten', '2',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'tasks'
             and column_name in ('date', 'time'))

  -- ================================================================
  -- LUKITUS ONNISTUU — 0002 ottaa ACCESS EXCLUSIVE -lukon
  -- ================================================================

  union all
  -- Avoin transaktio pitaa lukkoja ja estaisi migraation lukituksen.
  -- 0002:n lock_timeout on 5 s, joten migraatio ei jaa roikkumaan —
  -- mutta se keskeytyy, ja keskeytyminen on turha jos sen olisi voinut
  -- nahda etukateen.
  select '12', 'lukitus', 'Avoimia idle in transaction -istuntoja ei ole', '0',
         (select count(*)::text from pg_stat_activity
           where datname = current_database()
             and state in ('idle in transaction', 'idle in transaction (aborted)')
             and pid <> pg_backend_pid())

  union all
  select '13', 'lukitus', 'Yli minuutin kestaneita kyselyita ei ole kaynnissa', '0',
         (select count(*)::text from pg_stat_activity
           where datname = current_database()
             and state = 'active'
             and pid <> pg_backend_pid()
             and now() - query_start > interval '1 minute')

  -- ================================================================
  -- KIRJATTAVAT LUVUT — verrataan verify_0002:n vastaaviin
  -- ================================================================

  union all
  select '14', 'kirjattavat', 'Tehtavien lukumaara ENNEN migraatiota', 'INFO',
         (select count(*)::text from public.tasks)

  union all
  -- 0002 asettaa kaikille kellonajattomille riveille tilan
  -- 'unscheduled' ja muille 'manual'. Nama kaksi lukua kertovat
  -- etukateen, kuinka monta kumpaakin pitaa syntya.
  select '15', 'kirjattavat', 'Rivit ilman kellonaikaa (-> unscheduled)', 'INFO',
         (select count(*)::text from public.tasks where "time" is null)

  union all
  select '16', 'kirjattavat', 'Rivit joilla on kellonaika (-> manual)', 'INFO',
         (select count(*)::text from public.tasks where "time" is not null)

  union all
  select '17', 'kirjattavat', 'Auth-kayttajien lukumaara', 'INFO',
         (select count(*)::text from auth.users)

  union all
  -- Taulussa voi olla rajoitteita, joita tama repo ei tunne: taulu on
  -- luotu kasin ennen migraatioita. Luku ei ole vika vaan tieto, joka
  -- on verrattava verify_0002:n vastaavaan: 0002 lisaa tasan kolme.
  select '18', 'kirjattavat', 'Rajoitteita taulussa tasks ENNEN migraatiota', 'INFO',
         (select count(*)::text from pg_constraint
           where conrelid = 'public.tasks'::regclass)

  union all
  select '19', 'kirjattavat', 'Indekseja taulussa tasks ENNEN migraatiota', 'INFO',
         (select count(*)::text from pg_indexes
           where schemaname = 'public' and tablename = 'tasks')

) c
order by c.check_no;
