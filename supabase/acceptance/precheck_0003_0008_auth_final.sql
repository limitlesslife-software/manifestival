-- =====================================================================
-- PRECHECK: istunnon rooli ja auth-kayttajat
-- =====================================================================
--
-- VAIN LUKEVA. Yksi lause, yksi tulostaulukko, yksi kopiointi.
--
-- MIKSI TAMA ON ERILLINEN TIEDOSTO
--
-- Taulu auth.users ei ole authenticated-roolin luettavissa. Kun
-- lopullinen varmistus luki sita suoraan, koko varmistuksen ajettavuus
-- riippui SQL Editorin istunnon roolista: vaarassa roolissa se kaatui
-- koodiin 42501 eika yksikaan tarkistus kertonut mitaan.
--
-- Se oli huono jako. Varmistuksen sisalto ei muuttunut roolin mukana --
-- vain sen ajettavuus. Siksi rooliriippuvat tarkistukset ovat nyt
-- tassa, ja lopullinen varmistus lukee pelkkaa public-skeemaa ja
-- jarjestelmakatalogeja.
--
-- OIKEUKSIA EI MUUTETA. Tama tiedosto ei sisalla GRANTia eika REVOKEa,
-- eika sellaista pida tehda: `GRANT SELECT ON auth.users TO
-- authenticated` avaisi jokaiselle kirjautuneelle kayttajalle paasyn
-- kaikkien tilien sahkopostiosoitteisiin.
--
-- MITEN AJETAAN
-- Avaa tama tiedosto, valitse KOKO sisalto, liita Supabasen SQL
-- Editoriin ja aja POSTGRES-ROOLILLA. Ala aseta rooliksi authenticated.
--
-- ODOTUS
-- 6 rivia. Jokaisen rivin status on PASS ja failures_total on 0.
--
-- Jos tarkistus 01 tai 02 on FAIL, olet vaarassa roolissa: avaa uusi
-- SQL Editor -valilehti ja aja uudelleen. Ala korjaa sita GRANTilla.
--
-- Jos tarkistus 04 on FAIL, valiaikainen tili B on yha olemassa.
-- Poista se Supabasen Authentication-nakymasta ennen kuin jatkat.
--
-- JOS NAET "Success. No rows returned"
-- Se ei tarkoita, etta tarkistukset olisivat menneet lapi. Se
-- tarkoittaa, ettei tarkistuksia ajettu. Yleisin syy: editorissa on
-- tekstia VALITTUNA, jolloin editori ajaa vain valinnan. Paina
-- Ctrl+A ja aja uudelleen.
--
-- SEURAAVA ASKEL
-- Kun jokainen rivi on PASS, aja
-- supabase/acceptance/verify_0003_0008_post_acceptance_final.sql
-- =====================================================================

with

vakiot as (
  select '2cc00622-f927-4604-a518-361a4328481b'::uuid as omistaja
),

tarkistukset as (

  -- =================================================================
  -- ISTUNNON ROOLI
  -- =================================================================
  --
  -- Nama kolme kertovat, missa roolissa lause ajetaan. Ne on
  -- tarkistettava ENSIN: jos rooli on vaara, tarkistus 04 kaataa koko
  -- lauseen koodiin 42501 eika mitaan muuta nay.

  select '01' as check_no, 'rooli' as section,
         'Ajossa oleva kayttaja on postgres' as check_name,
         'postgres' as expected,
         current_user::text as actual

  union all
  select '02', 'rooli', 'Istunnon kayttaja on postgres', 'postgres',
         session_user::text

  union all
  -- current_setting('role', true) palauttaa 'none', kun rooliksi ei ole
  -- nimenomaisesti asetettu mitaan. Mika tahansa muu arvo tarkoittaa,
  -- etta istunnossa on ajettu SET ROLE -- ja silloin lukuoikeudet ovat
  -- eri kuin oletetaan.
  --
  -- coalesce siksi, etta asetus voi olla asettamatta kokonaan.
  select '03', 'rooli', 'Rooliksi ei ole asetettu mitaan', 'none',
         coalesce(current_setting('role', true), 'none')

  -- =================================================================
  -- AUTH-KAYTTAJAT
  -- =================================================================

  union all
  -- Valiaikainen tili B luotiin hyvaksyntatestia varten ja poistettiin
  -- sen jalkeen. Jos kayttajia on enemman kuin yksi, poisto ei
  -- onnistunut -- ja silloin kannassa voi olla myos rivejae, joita
  -- lopullinen varmistus ei odota.
  select '04', 'auth', 'Auth-kayttajia on tasan yksi, tili B on poistettu', '1',
         (select count(*)::text from auth.users)

  union all
  -- Ja jaljella oleva kayttaja on se, jonka lopullinen varmistus
  -- olettaa omistavan kaiken tuotantodatan. Pelkka lukumaara ei riita:
  -- yksi kayttaja voisi olla vaara kayttaja.
  select '05', 'auth', 'Jaljella oleva kayttaja on tunnettu omistaja', '1',
         (select count(*)::text from auth.users
           where id = (select omistaja from vakiot))

  union all
  -- Tama on se vaite, jonka nojalla lopullinen varmistus voi luopua
  -- auth.users-liitoksista: kun kayttajia on tasan yksi ja se on
  -- tunnettu omistaja, "rivi kuuluu tunnetulle omistajalle" ja "rivin
  -- omistaja on olemassa" ovat sama asia.
  select '06', 'auth', 'Yhtaan tuntematonta kayttajaa ei ole', '0',
         (select count(*)::text from auth.users
           where id is distinct from (select omistaja from vakiot))
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
