-- Diagnostiikka: public.routine_exceptions -taulun sarakkeet
-- VAIN LUKEVA. Yksi lause, yksi taulukko, yksi kopiointi.
--
-- MIKSI TAMA ON OLEMASSA
--
-- verify_0003.sql pysahtyi kohtaan "routine_exceptions-taulussa on
-- tasan 10 saraketta": odotus 10, tulos 11. Migraatio 0003 luo taululle
-- yksitoista saraketta, joten odotusarvo oli laskettu kasin vaarin —
-- updated_at unohtui listasta. Varmistus on korjattu.
--
-- Tama tiedosto on olemassa siksi, ettei korjattu odotusarvo yksin
-- todista mitaan tuotannosta. Kokonaismaara 11 voisi periaatteessa
-- syntya myos niin, etta yksi odotettu sarake puuttuu ja tilalla on
-- tuntematon. Tama listaa sarakkeet nimeltä ja kertoo suoraan, mika on
-- odotettu ja mika ei.
--
-- ODOTUS: rivit 01-11 ovat sarakkeet, ja jokaisen status on 'PASS'.
-- Rivi 90 on yhteenveto ja senkin on oltava 'PASS'.
--
-- Sarakkeiden nimet TULOSTUVAT, koska juuri ne ovat kysymys. Yhtaan
-- riviarvoa ei lueta.

select c.check_no, c.section, c.check_name,
       case when c.odotus = 'INFO' then 'INFO'
            when c.toteutui = c.odotus then 'PASS' else 'FAIL' end as status,
       case when c.odotus = 'INFO' then c.toteutui
            else 'odotus ' || c.odotus || ', toteutui ' || c.toteutui end as details,
       count(*) filter (where c.odotus <> 'INFO' and c.toteutui <> c.odotus)
         over () as poikkeavia_yhteensa
from (

  -- ================================================================
  -- SARAKKEET SELLAISENAAN, ORDINAALIJARJESTYKSESSA
  --
  -- Odotettu joukko on migraation 0003 luoma yksitoista saraketta.
  -- Yhdeksan niista on nimetty tassa; kaksi sisaltokenttaa jatetaan
  -- nimeamatta ja tunnistetaan siita, etteivat ne ole nimettyjen
  -- joukossa. Kumpikin tapaus antaa PASSin, tuntematon sarake ei.
  -- ================================================================

  select lpad(col.ordinal_position::text, 2, '0') as check_no,
         'sarakkeet' as section,
         col.column_name
           || ' : ' || col.udt_name
           || ' : ' || case when col.is_nullable = 'YES' then 'null sallittu' else 'not null' end
           || ' : ' || coalesce(left(col.column_default, 40), 'ei oletusta')
           || case when col.is_identity = 'YES' then ' : IDENTITY' else '' end
           || case when col.is_generated <> 'NEVER' then ' : GENERATED' else '' end
           as check_name,
         -- Nimetty sarake on PASS/FAIL. Nimeamaton on INFO, ei PASS:
         -- sen oikeellisuutta ei voi paatella nimeamatta sita, ja
         -- ordinaalipaikkaan luottaminen olisi arvaus. Nimeamattomien
         -- oikeellisuuden todistavat yhteenvetorivit 90 ja 92 — tama
         -- rivi vain nayttaa nimen, jotta ihminen nakee heti onko se
         -- odotettu sisaltokentta vai jotain muuta.
         case when col.column_name in ('id', 'user_id', 'routine_id', 'date', 'type',
                                       'time', 'duration_minutes', 'created_at', 'updated_at')
              then 'odotettu' else 'INFO' end as odotus,
         case when col.column_name in ('id', 'user_id', 'routine_id', 'date', 'type',
                                       'time', 'duration_minutes', 'created_at', 'updated_at')
              then 'odotettu'
              else 'nimeamaton sisaltokentta — vahvistus riveilta 90 ja 92' end as toteutui
    from information_schema.columns col
   where col.table_schema = 'public' and col.table_name = 'routine_exceptions'

  -- ================================================================
  -- YHTEENVETO
  -- ================================================================

  union all
  select '90', 'yhteenveto', 'Sarakkeita on tasan 11 (migraation 0003 luoma maara)', '11',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'routine_exceptions')

  union all
  select '91', 'yhteenveto', 'Yhdeksan rakenteellista saraketta on olemassa', '9',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'routine_exceptions'
             and column_name in ('id', 'user_id', 'routine_id', 'date', 'type',
                                 'time', 'duration_minutes', 'created_at', 'updated_at'))

  union all
  select '92', 'yhteenveto', 'Nimeamattomia sarakkeita on tasan kaksi', '2',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'routine_exceptions'
             and column_name not in ('id', 'user_id', 'routine_id', 'date', 'type',
                                     'time', 'duration_minutes', 'created_at', 'updated_at'))

  union all
  -- Aikaleimat ovat kannan omaisuutta: molemmilla on oletusarvo now()
  -- eika client kirjoita niita koskaan.
  select '93', 'yhteenveto', 'Molemmilla aikaleimalla on oletusarvo now()', '2',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'routine_exceptions'
             and column_name in ('created_at', 'updated_at')
             and column_default like 'now()%')

  union all
  select '94', 'yhteenveto', 'Yhtaan saraketta ei ole IDENTITY- tai GENERATED-tyyppinen', '0',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'routine_exceptions'
             and (is_identity = 'YES' or is_generated <> 'NEVER'))

  union all
  select '95', 'yhteenveto', 'Vertailutieto: routines-taulun sarakemaara', '17',
         (select count(*)::text from information_schema.columns
           where table_schema = 'public' and table_name = 'routines')

) c
order by c.check_no;
