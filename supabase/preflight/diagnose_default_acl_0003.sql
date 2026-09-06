-- Diagnostiikka: oletusoikeudet (pg_default_acl) ennen migraatiota 0003
-- VAIN LUKEVA. Yksi lause, yksi taulukko, yksi kopiointi.
--
-- MIKSI TAMA ON OLEMASSA
--
-- preflight_0003.sql kohta 19 palautti tuotannossa luvun 60, missa
-- odotus oli 0. Luku EI tarkoita 60 taulua eika 60 avointa oikeutta.
-- pg_default_acl sisaltaa yhden rivin jokaista yhdistelmaa
-- (omistajarooli, skeema, objektityyppi) kohti, ja aclexplode purkaa
-- jokaisen rivin ACL-listan YKSITTAISIKSI OIKEUKSIKSI. Luku on siis
--
--     (oletusoikeusrivien maara) x (myonnettyjen oikeuksien maara)
--
-- eli esimerkiksi yksi `grant all on tables` tuottaa seitseman riviä
-- (select, insert, update, delete, truncate, references, trigger),
-- `grant all on sequences` kolme ja `grant all on functions` yhden.
--
-- Tama tiedosto purkaa luvun osiin ja vastaa kysymykseen, joka
-- oikeasti ratkaisee: koskeeko jokin naista TULEVIA TAULUJA skeemassa
-- public, ja onko sama tilanne jo neutraloitu olemassa olevilla
-- tauluilla.
--
-- MITA TAMA EI OLE
-- Tama ei muuta mitaan eika ehdota muutosta oletusoikeuksiin.
-- Migraatiokohtainen `revoke` on parempi kuin globaalien
-- oletusoikeuksien muuttaminen, koska jalkimmainen vaikuttaa kaikkiin
-- tuleviin Supabase-objekteihin.
--
-- Rivit 01-12 ovat kiinteita tarkistuksia. Rivista 50 alkaen on
-- erittely: yksi rivi per (omistaja, skeema, objektityyppi, saaja).

select c.check_no, c.section, c.check_name,
       case when c.odotus = 'INFO' then 'INFO'
            when c.toteutui = c.odotus then 'PASS' else 'FAIL' end as status,
       case when c.odotus = 'INFO' then c.toteutui
            else 'odotus ' || c.odotus || ', toteutui ' || c.toteutui end as details,
       count(*) filter (where c.odotus <> 'INFO' and c.toteutui <> c.odotus)
         over () as poikkeavia_yhteensa
from (

  -- ================================================================
  -- KONTEKSTI
  -- ================================================================

  select '01' as check_no, 'konteksti' as section,
         'Rooli, joka luo objektit tassa istunnossa' as check_name,
         'INFO' as odotus,
         current_user || ' (istunto: ' || session_user || ')' as toteutui

  union all
  select '02', 'konteksti', 'Tietokanta ja hetki (UTC)', 'INFO',
         current_database() || ' @ '
         || to_char(now() at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS')

  -- ================================================================
  -- LUVUN 60 PURKU
  -- ================================================================

  union all
  select '03', 'purku', 'Oletusoikeusrivejä yhteensä (pg_default_acl)', 'INFO',
         (select count(*)::text from pg_default_acl)

  union all
  -- Tama on preflightin kohdan 19 luku. Se on yksittaisten oikeuksien
  -- maara, ei taulujen eika rivien.
  select '04', 'purku', 'Yksittaisia oikeusmerkintoja roolille anon', 'INFO',
         (select count(*)::text
            from pg_default_acl d, aclexplode(d.defaclacl) acl
            join pg_roles r on r.oid = acl.grantee
           where r.rolname = 'anon')

  union all
  select '05', 'purku', 'Yksittaisia oikeusmerkintoja roolille authenticated', 'INFO',
         (select count(*)::text
            from pg_default_acl d, aclexplode(d.defaclacl) acl
            join pg_roles r on r.oid = acl.grantee
           where r.rolname = 'authenticated')

  union all
  select '06', 'purku', 'Yksittaisia oikeusmerkintoja roolille PUBLIC', 'INFO',
         (select count(*)::text
            from pg_default_acl d, aclexplode(d.defaclacl) acl
           where acl.grantee = 0)

  -- ================================================================
  -- MIKA NAISTA KOSKEE TULEVIA TAULUJA SKEEMASSA public
  --
  -- Vain tama vaikuttaa migraatioon 0003. Jonot ja funktiot eivat luo
  -- paasya uusiin tauluihin.
  -- ================================================================

  union all
  select '07', 'kohdistus', 'anon: oletusoikeuksia TULEVIIN TAULUIHIN skeemassa public', 'INFO',
         (select count(*)::text
            from pg_default_acl d, aclexplode(d.defaclacl) acl
            join pg_roles r on r.oid = acl.grantee
            left join pg_namespace n on n.oid = d.defaclnamespace
           where r.rolname = 'anon'
             and d.defaclobjtype = 'r'
             and coalesce(n.nspname, '-') = 'public')

  union all
  select '08', 'kohdistus', 'anon: oletusoikeuksia tuleviin jonoihin (sequence)', 'INFO',
         (select count(*)::text
            from pg_default_acl d, aclexplode(d.defaclacl) acl
            join pg_roles r on r.oid = acl.grantee
           where r.rolname = 'anon' and d.defaclobjtype = 'S')

  union all
  select '09', 'kohdistus', 'anon: oletusoikeuksia tuleviin funktioihin', 'INFO',
         (select count(*)::text
            from pg_default_acl d, aclexplode(d.defaclacl) acl
            join pg_roles r on r.oid = acl.grantee
           where r.rolname = 'anon' and d.defaclobjtype = 'f')

  union all
  select '10', 'kohdistus', 'PUBLIC: oletusoikeuksia TULEVIIN TAULUIHIN skeemassa public', 'INFO',
         (select count(*)::text
            from pg_default_acl d, aclexplode(d.defaclacl) acl
            left join pg_namespace n on n.oid = d.defaclnamespace
           where acl.grantee = 0
             and d.defaclobjtype = 'r'
             and coalesce(n.nspname, '-') = 'public')

  -- ================================================================
  -- TODISTE: SAMA TILANNE ON JO NEUTRALOITU
  --
  -- Taulut tasks ja profile luotiin samassa kannassa samojen
  -- oletusoikeuksien vallitessa, ja migraatio 0001 perui niilta anonin
  -- ja PUBLICin oikeudet. Jos nama ovat nolla, oletusoikeus EI ole
  -- este: se on tila, jonka migraatio neutraloi.
  -- ================================================================

  union all
  select '11', 'todiste', 'anon-roolilla ei ole tehollista oikeutta tauluihin tasks/profile', '0',
         (select count(*)::text
            from (select unnest(array['public.tasks', 'public.profile']) as taulu) tt
            cross join (select unnest(array['select', 'insert', 'update', 'delete',
                                            'truncate', 'references', 'trigger']) as oikeus) pp
           where has_table_privilege('anon', tt.taulu, pp.oikeus))

  union all
  select '12', 'todiste', 'PUBLIC-roolilla ei ole oikeuksia tauluihin tasks/profile', '0',
         (select count(*)::text
            from pg_class cl, aclexplode(cl.relacl) acl
           where cl.oid = any (array['public.tasks'::regclass, 'public.profile'::regclass])
             and acl.grantee = 0)

  union all
  select '13', 'todiste', 'authenticated-roolilla on tasan CRUD tauluihin tasks/profile', '8',
         (select count(*)::text
            from (select unnest(array['public.tasks', 'public.profile']) as taulu) tt
            cross join (select unnest(array['select', 'insert', 'update', 'delete',
                                            'truncate', 'references', 'trigger']) as oikeus) pp
           where has_table_privilege('authenticated', tt.taulu, pp.oikeus))

  union all
  -- Skeeman kayttooikeus on eri asia kuin taulun oikeus. anon tarvitsee
  -- USAGE-oikeuden skeemaan paastakseen kasiksi mihinkaan tauluun, mutta
  -- pelkka USAGE ei anna paasya yhteenkaan tauluun. Tama on INFO, ei
  -- vika: Supabase myontaa sen vakiona.
  select '14', 'todiste', 'anon-roolilla on USAGE skeemaan public', 'INFO',
         (select case when has_schema_privilege('anon', 'public', 'usage')
                      then 'kylla (normaali)' else 'ei' end)

  -- ================================================================
  -- ERITTELY: yksi rivi per (omistaja, skeema, objektityyppi, saaja)
  -- ================================================================

  union all
  select lpad((49 + row_number() over (order by e.omistaja, e.skeema, e.objekti, e.saaja))::text, 2, '0'),
         'erittely',
         e.omistaja || ' / ' || e.skeema || ' / ' || e.objekti || ' -> ' || e.saaja,
         'INFO',
         e.oikeudet || ' (' || e.lkm::text || ' merkintaa)'
    from (
      select coalesce(owner_role.rolname, 'kaikki omistajat') as omistaja,
             coalesce(ns.nspname, 'kaikki skeemat')           as skeema,
             case d.defaclobjtype
               when 'r' then 'TAULUT'
               when 'S' then 'jonot'
               when 'f' then 'funktiot'
               when 'T' then 'tyypit'
               when 'n' then 'skeemat'
               else d.defaclobjtype::text
             end                                              as objekti,
             coalesce(grantee_role.rolname, 'PUBLIC')         as saaja,
             string_agg(distinct acl.privilege_type, ', ' order by acl.privilege_type) as oikeudet,
             count(*)                                         as lkm
        from pg_default_acl d
        cross join lateral aclexplode(d.defaclacl) acl
        left join pg_roles owner_role   on owner_role.oid = d.defaclrole
        left join pg_namespace ns       on ns.oid = d.defaclnamespace
        left join pg_roles grantee_role on grantee_role.oid = acl.grantee
       group by 1, 2, 3, 4
    ) e

) c
order by c.check_no;
