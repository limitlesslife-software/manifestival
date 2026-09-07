-- Varmistus: KOKO 0003–0008 -hyväksyntätestin JÄLKEEN
-- VAIN LUKEVA. Yksi lause, yksi taulukko, yksi kopiointi.
--
-- MILLOIN: kun tools/rls-acceptance on ajettu koko 0003–0008 -skeemaa
-- vasten, sen siivous on näyttänyt PASSin ja väliaikainen tili B on
-- poistettu Supabasen Authentication-näkymästä.
--
-- MIKSI ERILLINEN
-- Selaimessa ajettu testi katsoo kantaa RLS:n läpi. Se ei siis voi
-- nähdä, jäikö toisen tilin rivi kantaan — RLS piilottaisi juuri sen
-- rivin, jota etsitään. Tämä ajetaan SQL-editorissa ilman RLS-rajausta,
-- ja se on ainoa paikka josta jäännöksen voi nähdä.
--
-- Tämä EI korvaa tiedostoja verify_acceptance.sql (tasks ja profile)
-- eikä verify_acceptance_0003.sql (rutiinit). Se todistaa migraatioiden
-- 0004–0008 taulut ja sen, etteivät aiemmat muuttuneet.
--
-- ODOTUS: jokaisen rivin status = 'PASS' ja poikkeavia_yhteensa = 0.
--
-- YKSIKIN FAIL = YHTÄKÄÄN PORTTIA EI KÄÄNNETÄ, ja jäännös selvitetään
-- ennen kuin mitään muuta tehdään.
--
-- Tämä tiedosto EI lue käyttäjän sisältöä.

select c.check_no, c.section, c.check_name,
       case when c.toteutui = c.odotus then 'PASS' else 'FAIL' end as status,
       'odotus ' || c.odotus || ', toteutui ' || c.toteutui as details,
       count(*) filter (where c.toteutui <> c.odotus) over () as poikkeavia_yhteensa
from (

  -- ================================================================
  -- JÄÄNNÖKSET — TESTISTÄ EI JÄÄNYT MITÄÄN
  -- ================================================================

  select '01' as check_no, 'jaannokset' as section,
         'Kaikki kymmenen porttitaulua ovat tyhjia' as check_name,
         '0' as odotus,
         ((select count(*) from public.routines)
        + (select count(*) from public.routine_exceptions)
        + (select count(*) from public.goals)
        + (select count(*) from public.projects)
        + (select count(*) from public.notification_preferences)
        + (select count(*) from public.wellbeing_entries)
        + (select count(*) from public.bills)
        + (select count(*) from public.recurring_expenses)
        + (select count(*) from public.savings_goals)
        + (select count(*) from public.ai_action_audit))::text as toteutui

  union all
  -- Erillinen kohdasta 01. Jos jokin rivi jai kantaan, se nakyy myos
  -- etuliitteesta — ja etuliite kertoo, etta se on nimenomaan taman
  -- testin jaannos eika jotain muuta. Ilman tata eroa jaannosta ei
  -- voisi erottaa oikeasta datasta.
  select '02', 'jaannokset', 'Hyvaksyntatestin merkittyja rivejä ei ole yhdessakaan taulussa', '0',
         ((select count(*) from public.routines
            where id like 'manifestival_rls_acceptance_%')
        + (select count(*) from public.routine_exceptions
            where id like 'manifestival_rls_acceptance_%')
        + (select count(*) from public.goals
            where id like 'manifestival_rls_acceptance_%')
        + (select count(*) from public.projects
            where id like 'manifestival_rls_acceptance_%')
        + (select count(*) from public.wellbeing_entries
            where id like 'manifestival_rls_acceptance_%')
        + (select count(*) from public.bills
            where id like 'manifestival_rls_acceptance_%')
        + (select count(*) from public.recurring_expenses
            where id like 'manifestival_rls_acceptance_%')
        + (select count(*) from public.savings_goals
            where id like 'manifestival_rls_acceptance_%')
        + (select count(*) from public.ai_action_audit
            where id like 'manifestival_rls_acceptance_%')
        + (select count(*) from public.tasks
            where id like 'manifestival_rls_acceptance_%'))::text

  union all
  -- MUISTUTUSASETUKSET ERIKSEEN.
  --
  -- Rivin tunniste on kayttajan uuid, ei testin etuliite, joten
  -- kohta 02 ei loytaisi sita koskaan. Kohta 01 kylla laskee sen, mutta
  -- vain summana; tama nimeaa taulun.
  select '03', 'jaannokset', 'Muistutusasetusrivejä ei ole', '0',
         (select count(*)::text from public.notification_preferences)

  union all
  select '04', 'jaannokset', 'Auth-kayttajia on tasan yksi — tili B on poistettu', '1',
         (select count(*)::text from auth.users)

  union all
  -- Kayttajan poisto on ON DELETE CASCADE kaikissa kymmenessa
  -- taulussa. Jos tili B poistettiin ja jokin rivi jai silti, cascade
  -- ei toiminut — ja se olisi vakavampi vika kuin jaannos itse.
  select '05', 'jaannokset', 'Yhtaan rivia ei omista poistettu kayttaja', '0',
         ((select count(*) from public.tasks t
             left join auth.users u on u.id = t.user_id where u.id is null)
        + (select count(*) from public.routines r
             left join auth.users u on u.id = r.user_id where u.id is null)
        + (select count(*) from public.goals g
             left join auth.users u on u.id = g.user_id where u.id is null)
        + (select count(*) from public.projects p
             left join auth.users u on u.id = p.user_id where u.id is null)
        + (select count(*) from public.bills b
             left join auth.users u on u.id = b.user_id where u.id is null))::text

  -- ================================================================
  -- HYÖKKÄYKSET EIVÄT PÄÄSSEET LÄPI
  -- ================================================================
  -- Tämä on eri väite kuin "siivous onnistui". Nämä rivit EIVÄT SAANEET
  -- SYNTYÄ lainkaan. Jos jokin niistä on kannassa, yhdistelmävierasavain
  -- ei pitänyt — eikä sitä näkisi siivouksen rivimääristä, koska siivous
  -- poisti ne.
  --
  -- Selaimessa ajettu testi ei voi todistaa tätä yhtä vahvasti: se
  -- katsoo kantaa RLS:n läpi eikä näkisi toisen tilin riviä.

  union all
  select '06', 'hyokkaykset', 'Ristiinkiinnitysyrityksia ei ole kannassa', '0',
         ((select count(*) from public.goals
            where id like 'manifestival_rls_acceptance_%_attack_%')
        + (select count(*) from public.projects
            where id like 'manifestival_rls_acceptance_%_attack_%')
        + (select count(*) from public.tasks
            where id like 'manifestival_rls_acceptance_%_attack_%')
        + (select count(*) from public.routines
            where id like 'manifestival_rls_acceptance_%_attack_%')
        + (select count(*) from public.bills
            where id like 'manifestival_rls_acceptance_%_attack_%')
        + (select count(*) from public.routine_exceptions
            where id like 'manifestival_rls_acceptance_%_attack_%'))::text

  union all
  -- EHEYS RIIPPUMATTA TESTISTÄ.
  --
  -- Nämä kysyvät saman asian toisin päin: onko kannassa YHTÄÄN riviä,
  -- joka viittaa toisen käyttäjän riviin. Kohta 06 etsii tunnetuilla
  -- tunnisteilla; tämä ei tarvitse tunnisteita lainkaan, joten se
  -- löytäisi myös rivin joka syntyi jotain muuta kautta.
  select '07', 'eheys', 'Yhtaan tehtavaa ei ole kiinnitetty toisen tavoitteeseen', '0',
         (select count(*)::text from public.tasks t
            left join public.goals g on g.id = t.goal_id and g.user_id = t.user_id
           where t.goal_id is not null and g.id is null)

  union all
  select '08', 'eheys', 'Yhtaan tehtavaa ei ole kiinnitetty toisen projektiin', '0',
         (select count(*)::text from public.tasks t
            left join public.projects p on p.id = t.project_id and p.user_id = t.user_id
           where t.project_id is not null and p.id is null)

  union all
  select '09', 'eheys', 'Yhtaan tavoitetta ei ole kiinnitetty toisen ylatavoitteeseen', '0',
         (select count(*)::text from public.goals g
            left join public.goals p
              on p.id = g.parent_goal_id and p.user_id = g.user_id
           where g.parent_goal_id is not null and p.id is null)

  union all
  select '10', 'eheys', 'Yhtaan tavoitetta ei ole kiinnitetty toisen projektiin', '0',
         (select count(*)::text from public.goals g
            left join public.projects p
              on p.id = g.project_id and p.user_id = g.user_id
           where g.project_id is not null and p.id is null)

  union all
  select '11', 'eheys', 'Yhtaan projektia ei ole kiinnitetty toisen tavoitteeseen', '0',
         (select count(*)::text from public.projects p
            left join public.goals g on g.id = p.goal_id and g.user_id = p.user_id
           where p.goal_id is not null and g.id is null)

  union all
  select '12', 'eheys', 'Yhtaan rutiinia ei ole kiinnitetty toisen tavoitteeseen', '0',
         (select count(*)::text from public.routines r
            left join public.goals g on g.id = r.goal_id and g.user_id = r.user_id
           where r.goal_id is not null and g.id is null)

  union all
  select '13', 'eheys', 'Yhtaan poikkeusta ei ole kiinnitetty toisen rutiiniin', '0',
         (select count(*)::text from public.routine_exceptions e
            left join public.routines r on r.id = e.routine_id and r.user_id = e.user_id
           where r.id is null)

  union all
  select '14', 'eheys', 'Yhtaan laskua ei ole kiinnitetty toisen tehtavaan', '0',
         (select count(*)::text from public.bills b
            left join public.tasks t on t.id = b.task_id and t.user_id = b.user_id
           where b.task_id is not null and t.id is null)

  union all
  select '15', 'eheys', 'Yhtaan laskua ei ole kiinnitetty toisen kuluun', '0',
         (select count(*)::text from public.bills b
            left join public.recurring_expenses x
              on x.id = b.recurring_expense_id and x.user_id = b.user_id
           where b.recurring_expense_id is not null and x.id is null)

  union all
  select '16', 'eheys', 'Omistajattomia rivejä ei ole yhdessakaan taulussa', '0',
         ((select count(*) from public.routines where user_id is null)
        + (select count(*) from public.routine_exceptions where user_id is null)
        + (select count(*) from public.goals where user_id is null)
        + (select count(*) from public.projects where user_id is null)
        + (select count(*) from public.wellbeing_entries where user_id is null)
        + (select count(*) from public.bills where user_id is null)
        + (select count(*) from public.recurring_expenses where user_id is null)
        + (select count(*) from public.savings_goals where user_id is null)
        + (select count(*) from public.ai_action_audit where user_id is null))::text

  -- ================================================================
  -- RAKENNE ON YHÄ VOIMASSA
  -- ================================================================
  -- Hyväksyntätesti kirjoittaa ja poistaa satoja rivejä. Se ei muuta
  -- rakennetta, mutta juuri siksi rakenne kannattaa todeta sen jälkeen:
  -- jos jokin muuttui, se muuttui jostain muusta syystä.

  union all
  select '17', 'rakenne', 'RLS on paalla kaikissa kymmenessa taulussa', '10',
         (select count(*)::text from pg_class
           where relnamespace = 'public'::regnamespace
             and relname in ('routines', 'routine_exceptions', 'goals', 'projects',
                             'notification_preferences', 'wellbeing_entries',
                             'bills', 'recurring_expenses', 'savings_goals',
                             'ai_action_audit')
             and relrowsecurity)

  union all
  select '18', 'rakenne', 'Neljakymmentä omistajuuspolitiikkaa on tallella', '40',
         (select count(*)::text from pg_policies
           where schemaname = 'public'
             and tablename in ('routines', 'routine_exceptions', 'goals', 'projects',
                               'notification_preferences', 'wellbeing_entries',
                               'bills', 'recurring_expenses', 'savings_goals',
                               'ai_action_audit'))

  union all
  -- Yhdeksan yhdistelmavierasavainta. Ne ovat se, mika torjui
  -- hyokkaykset; jos jokin niista on kadonnut testin aikana, seuraava
  -- yritys onnistuisi.
  select '19', 'rakenne', 'Yhdeksan omistajuusviitetta on yha voimassa', '9',
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
                          where a.attname = 'user_id'))

  union all
  select '20', 'rakenne', 'Yhtaan yhden sarakkeen viitetta ei ole ilmestynyt', '0',
         (select count(*)::text
            from pg_constraint con
            join pg_class t on t.oid = con.conrelid
            join pg_class ft on ft.oid = con.confrelid
           where con.contype = 'f'
             and t.relnamespace = 'public'::regnamespace
             and ft.relnamespace = 'public'::regnamespace
             and array_length(con.conkey, 1) < 2)

  union all
  select '21', 'oikeudet', 'anon-roolilla ei ole tehollista oikeutta yhteenkaan tauluun', '0',
         (select count(*)::text
            from pg_tables t
            cross join (select unnest(array['select', 'insert', 'update', 'delete',
                                            'truncate', 'references', 'trigger']) as oikeus) pp
           where t.schemaname = 'public'
             and has_table_privilege('anon', format('%I.%I', t.schemaname, t.tablename),
                                     pp.oikeus))

  union all
  select '22', 'oikeudet', 'PUBLIC-roolilla ei ole oikeuksia yhteenkaan tauluun', '0',
         (select count(*)::text
            from pg_class cl, aclexplode(cl.relacl) acl
           where cl.relnamespace = 'public'::regnamespace
             and cl.relkind = 'r' and acl.grantee = 0)

  -- ================================================================
  -- VANHA DATA ON KOSKEMATON
  -- ================================================================
  -- Hyväksyntätesti kirjoitti oikeaan tuotantokantaan. Tämä on se
  -- kohta, jossa se todetaan vaarattomaksi.

  union all
  select '23', 'vanha data', 'Tehtavia on yha 36', '36',
         (select count(*)::text from public.tasks)

  union all
  select '24', 'vanha data', 'Profiilirivien maara on yha 1', '1',
         (select count(*)::text from public.profile)

  union all
  select '25', 'vanha data', 'Yhtaan tehtavaa ei omista odottamaton kayttaja', '0',
         (select count(*)::text from public.tasks
           where user_id is distinct from '2cc00622-f927-4604-a518-361a4328481b'::uuid)

  union all
  -- Testi loi tehtavia, joilla oli goal_id tai project_id. Kun ne
  -- poistettiin, naiden pitaa olla NULL kaikilla oikeilla riveilla —
  -- oikeisiin tehtaviin ei kiinnitetty mitaan.
  select '26', 'vanha data', 'Oikeissa tehtavissa ei ole liitoksia', '0',
         (select count(*)::text from public.tasks
           where goal_id is not null or project_id is not null or deadline is not null)

  union all
  select '27', 'vanha data', 'RLS on yha paalla tauluissa tasks ja profile', '2',
         (select count(*)::text from pg_class
           where relnamespace = 'public'::regnamespace
             and relname in ('tasks', 'profile') and relrowsecurity)

  union all
  select '28', 'vanha data', 'tasks-taulussa on yha nelja politiikkaa', '4',
         (select count(*)::text from pg_policies
           where schemaname = 'public' and tablename = 'tasks')

) c
order by c.check_no;
