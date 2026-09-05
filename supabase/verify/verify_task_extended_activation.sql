-- Varmistus: lipun TASK_EXTENDED_FIELDS AKTIVOINNIN JALKEEN
-- VAIN LUKEVA. Yksi lause, yksi taulukko, yksi kopiointi.
--
-- MILLOIN: runbookin GATE G, kun lippu on kaannetty, koodi on
-- julkaistu ja GATE F:n kayttokokeilut on tehty.
--
-- TAMA EI KORVAA TIEDOSTOA verify_0002.sql. Se todisti, etta migraatio
-- teki mita piti. Tama todistaa, ettei SOVELLUS riko mitaan nyt kun se
-- oikeasti kirjoittaa uusiin sarakkeisiin.
--
-- MITA TAMA EI VOI NAHDA
--   1. Lipun arvo on sovelluksen koodissa (src/data/schema.js), ei
--      kannassa. SQL ei voi lukea sita. Kohta 20 on lahin mahdollinen:
--      se nakee, onko sovellus kirjoittanut uusiin sarakkeisiin.
--   2. Kayttoliittyman toiminta. Se todetaan GATE F:ssa kasin.
--
-- ODOTUS: jokaisen PASS/FAIL-rivin status = 'PASS' ja
-- poikkeavia_yhteensa = 0. INFO-rivit verrataan predeployn lukuihin.
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
  -- SKEEMA ON YHA SE, JOTA SOVELLUS OLETTAA
  -- ================================================================

  select '01' as check_no, 'skeema' as section,
         'Kuusi laajennettua saraketta on yha olemassa' as check_name,
         '6' as odotus,
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'tasks'
             and column_name in ('description', 'duration_minutes', 'priority',
                                 'scheduling_state', 'created_at', 'updated_at')) as toteutui

  union all
  select '02', 'skeema', 'Pakolliset sarakkeet ovat yha NOT NULL', '4',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'tasks'
             and is_nullable = 'NO'
             and column_name in ('priority', 'scheduling_state', 'created_at', 'updated_at'))

  union all
  select '03', 'skeema', 'Kolme tarkistetta on yha olemassa', '3',
         (select count(*)::text from pg_constraint
           where conrelid = 'public.tasks'::regclass and contype = 'c'
             and conname in ('tasks_priority_check', 'tasks_scheduling_state_check',
                             'tasks_duration_minutes_check'))

  union all
  select '04', 'skeema', 'Liipaisin ja indeksi ovat yha paikallaan', '2',
         ((select count(*) from pg_trigger
            where tgrelid = 'public.tasks'::regclass
              and tgname = 'tasks_touch_updated_at' and not tgisinternal)
        + (select count(*) from pg_indexes
            where schemaname = 'public' and tablename = 'tasks'
              and indexname = 'tasks_user_date_priority_idx'))::text

  -- ================================================================
  -- DATA — sovellus ei ole kirjoittanut mitaan kelvotonta
  -- ================================================================

  union all
  -- Nama neljaa kohtaa ovat koko tiedoston ydin. Ne kysyvat: onko
  -- sovellus kirjoittanut riveja, joita se ei olisi saanut kirjoittaa?
  select '05', 'data', 'Yhdellakaan rivilla ei ole tyhjaa prioriteettia', '0',
         (select count(*)::text from public.tasks where priority is null)

  union all
  select '06', 'data', 'Yhdellakaan rivilla ei ole tyhjaa aikataulutustilaa', '0',
         (select count(*)::text from public.tasks where scheduling_state is null)

  union all
  select '07', 'data', 'Yhdellakaan rivilla ei ole kelvotonta prioriteettia', '0',
         (select count(*)::text from public.tasks
           where priority not in ('korkea', 'normaali', 'matala'))

  union all
  select '08', 'data', 'Yhdellakaan rivilla ei ole kelvotonta aikataulutustilaa', '0',
         (select count(*)::text from public.tasks
           where scheduling_state not in ('manual', 'auto', 'unscheduled'))

  union all
  select '09', 'data', 'Yhdellakaan rivilla ei ole kelvotonta kestoa', '0',
         (select count(*)::text from public.tasks
           where duration_minutes is not null
             and (duration_minutes <= 0 or duration_minutes > 1440))

  union all
  -- Tyhja merkkijono ja null tarkoittaisivat "ei kuvausta" kahdella eri
  -- tavalla. normalizeTask muuntaa tyhjan nulliksi; jos taalla nakyy
  -- tyhjia merkkijonoja, jokin kirjoituspolku ohittaa normalisoinnin.
  select '10', 'data', 'Kuvaus ei ole tyhja merkkijono yhdellakaan rivilla', '0',
         (select count(*)::text from public.tasks where description = '')

  union all
  select '11', 'data', 'Kellonajattomat rivit ovat aikatauluttamattomia', '0',
         (select count(*)::text from public.tasks
           where "time" is null and scheduling_state <> 'unscheduled')

  union all
  -- Aikatauluttamaton rivi ilman kellonaikaa on oikein; aikatauluttamaton
  -- rivi JOLLA on kellonaika on ristiriita, jonka vain viallinen
  -- kirjoituspolku voi tuottaa.
  select '12', 'data', 'Aikataulutetuilla riveilla on kellonaika', '0',
         (select count(*)::text from public.tasks
           where scheduling_state in ('manual', 'auto') and "time" is null)

  union all
  select '13', 'data', 'Omistajattomia riveja ei ole', '0',
         (select count(*)::text from public.tasks where user_id is null)

  union all
  select '14', 'data', 'Orpoja omistajaviittauksia ei ole', '0',
         (select count(*)::text
            from public.tasks t left join auth.users u on u.id = t.user_id
           where u.id is null)

  union all
  select '15', 'data', 'Yhtaan tehtavaa ei omista joku muu kuin hyvaksytty omistaja', '0',
         (select count(*)::text from public.tasks
           where user_id is distinct from '2cc00622-f927-4604-a518-361a4328481b'::uuid)

  union all
  -- Aikaleimat ovat kannan omaisuutta. Jos updated_at olisi vanhempi
  -- kuin created_at, joku olisi kirjoittanut ne asiakkaalta kasin.
  select '16', 'data', 'Aikaleimat ovat johdonmukaiset', '0',
         (select count(*)::text from public.tasks where updated_at < created_at)

  -- ================================================================
  -- TURVA — aktivointi ei muuttanut mitaan
  -- ================================================================

  union all
  select '17', 'turva', 'RLS on yha paalla molemmissa tauluissa', '2',
         (select count(*)::text from pg_class
           where relnamespace = 'public'::regnamespace
             and relname in ('tasks', 'profile') and relrowsecurity)

  union all
  select '18', 'turva', 'Kahdeksan omistajuuspolitiikkaa on tallella oikein ehdoin', '8',
         (select count(*)::text
            from pg_policies p
            join (values
                    ('tasks',   'tasks_select_own',   'SELECT', 'auth.uid()=user_id', ''),
                    ('tasks',   'tasks_insert_own',   'INSERT', '',                   'auth.uid()=user_id'),
                    ('tasks',   'tasks_update_own',   'UPDATE', 'auth.uid()=user_id', 'auth.uid()=user_id'),
                    ('tasks',   'tasks_delete_own',   'DELETE', 'auth.uid()=user_id', ''),
                    ('profile', 'profile_select_own', 'SELECT', 'auth.uid()=id',      ''),
                    ('profile', 'profile_insert_own', 'INSERT', '',                   'auth.uid()=id'),
                    ('profile', 'profile_update_own', 'UPDATE', 'auth.uid()=id',      'auth.uid()=id'),
                    ('profile', 'profile_delete_own', 'DELETE', 'auth.uid()=id',      '')
                 ) e(tbl, pol, operaatio, q, wc)
              on e.tbl = p.tablename and e.pol = p.policyname and e.operaatio = p.cmd
             and btrim(replace(coalesce(p.qual, ''), ' ', ''), '()') = e.q
             and btrim(replace(coalesce(p.with_check, ''), ' ', ''), '()') = e.wc
           where p.schemaname = 'public' and p.roles = '{authenticated}'::name[])

  union all
  select '19', 'turva', 'anon-roolilla ei ole taulu- eika sarakekohtaista oikeutta', '0',
         ((select count(*)
             from (select unnest(array['select', 'insert', 'update', 'delete',
                                       'truncate', 'references', 'trigger']) as oikeus) pp
            where has_table_privilege('anon', 'public.tasks', pp.oikeus))
        + (select count(*)
             from unnest(array['description', 'duration_minutes', 'priority',
                               'scheduling_state', 'created_at', 'updated_at']) as sarake
            where has_column_privilege('anon', 'public.tasks', sarake, 'select')
               or has_column_privilege('anon', 'public.tasks', sarake, 'insert')
               or has_column_privilege('anon', 'public.tasks', sarake, 'update')))::text

  union all
  select '20', 'turva', 'authenticated-roolilla on tasan CRUD tauluun tasks', '4',
         (select count(*)::text
            from (select unnest(array['select', 'insert', 'update', 'delete',
                                      'truncate', 'references', 'trigger']) as oikeus) pp
           where has_table_privilege('authenticated', 'public.tasks', pp.oikeus))

  union all
  select '21', 'turva', 'PUBLIC-roolilla ei ole oikeuksia tauluun tasks', '0',
         (select count(*)::text
            from pg_class cl, aclexplode(cl.relacl) acl
           where cl.oid = 'public.tasks'::regclass and acl.grantee = 0)

  union all
  select '22', 'rajaus', 'Migraatioiden 0003-0008 tauluja ei ole olemassa', '0',
         (select count(*)::text from pg_tables
           where schemaname = 'public'
             and tablename in ('routines', 'routine_exceptions', 'goals', 'projects',
                               'notification_preferences', 'wellbeing', 'bills',
                               'recurring_expenses', 'savings_goals', 'ai_audit'))

  -- ================================================================
  -- KIRJATTAVAT LUVUT — verrataan predeployn lukuihin
  -- ================================================================

  union all
  select '23', 'kirjattavat', 'Tehtavia yhteensa (predeploy 10)', 'INFO',
         (select count(*)::text from public.tasks)

  union all
  -- TAMA ON LAHIN, MITA SQL VOI KERTOA LIPUN TILASTA. Ennen aktivointia
  -- luku on nolla: sovellus ei lahettanyt naita sarakkeita lainkaan.
  -- Jos luku on yha nolla GATE F:n kayttokokeilujen jalkeen, lippu ei
  -- ole voimassa julkaistussa koodissa.
  select '24', 'kirjattavat', 'Rivit joilla on kuvaus (predeploy 28, pitaa kasvaa)', 'INFO',
         (select count(*)::text from public.tasks where description is not null)

  union all
  select '25', 'kirjattavat', 'Rivit joilla on kesto (predeploy 29, pitaa kasvaa)', 'INFO',
         (select count(*)::text from public.tasks where duration_minutes is not null)

  union all
  select '26', 'kirjattavat', 'Rivit joilla on muu kuin oletusprioriteetti (predeploy 30)', 'INFO',
         (select count(*)::text from public.tasks where priority <> 'normaali')

  union all
  select '27', 'kirjattavat', 'Rivit tilassa manual (predeploy 25)', 'INFO',
         (select count(*)::text from public.tasks where scheduling_state = 'manual')

  union all
  select '28', 'kirjattavat', 'Rivit tilassa unscheduled (predeploy 26)', 'INFO',
         (select count(*)::text from public.tasks where scheduling_state = 'unscheduled')

  union all
  -- Automaatin sijoittamat rivit. Nolla on kelvollinen tulos, jos
  -- yhtaan ehdotusta ei ole hyvaksytty. Luku on silti kirjattava: jos se
  -- pysyy nollassa vaikka ehdotuksia hyvaksytaan, aikataulutustila ei
  -- tallennu oikein.
  select '29', 'kirjattavat', 'Rivit tilassa auto (predeploy 27)', 'INFO',
         (select count(*)::text from public.tasks where scheduling_state = 'auto')

  union all
  select '30', 'kirjattavat', 'Riveja paivitetty luonnin jalkeen', 'INFO',
         (select count(*)::text from public.tasks where updated_at > created_at)

) c
order by c.check_no;
