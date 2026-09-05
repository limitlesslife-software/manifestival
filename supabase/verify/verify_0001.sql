-- Varmistus: 0001_auth_user_scoping
-- VAIN LUKEVA. Aja migraation jalkeen, runbookin PYSAYTYS 3.
--
-- Sovitettu todennettuun tuotantoskeemaan. Odotusarvot ovat konkreettisia
-- lukuja, ei "pitaisi olla jotain jarkevaa". Jos jokin ei tasmaa, ala
-- kaanna yhtaan lippua ja ala aja seuraavaa migraatiota.
--
-- Tama tiedosto EI lue kayttajan sisaltoa. Se katsoo rakennetta,
-- rivimaaria, omistajuutta ja politiikkojen ehtoja.
--
-- Jokainen lause alkaa sanalla select. Ei insert, update, delete, alter,
-- create, drop, grant eika revoke. Testi vartioi tata.

-- 1. RLS paalla molemmissa. Odotus: kaksi rivia, molemmat true.
select relname as taulu, relrowsecurity as rls_paalla
from pg_class
where relnamespace = 'public'::regnamespace
  and relname in ('tasks', 'profile')
order by relname;

-- 2. Politiikkojen TAYDELLISET maaritelmat.
--
--    Politiikan olemassaolo ei todista mitaan. Vaara ehto nayttaa
--    ulospain tasan samalta kuin oikea: sama nimi, sama operaatio, sama
--    rooli. Ero on vain USING- ja WITH CHECK -lausekkeissa, ja juuri ne
--    ratkaisevat nakeeko kayttaja toisen rivit.
--
--    Odotus, 8 rivia:
--      tasks_select_own    SELECT  {authenticated}  using auth.uid() = user_id  check tyhja
--      tasks_insert_own    INSERT  {authenticated}  using tyhja                 check auth.uid() = user_id
--      tasks_update_own    UPDATE  {authenticated}  using auth.uid() = user_id  check auth.uid() = user_id
--      tasks_delete_own    DELETE  {authenticated}  using auth.uid() = user_id  check tyhja
--      profile_select_own  SELECT  {authenticated}  using auth.uid() = id       check tyhja
--      profile_insert_own  INSERT  {authenticated}  using tyhja                 check auth.uid() = id
--      profile_update_own  UPDATE  {authenticated}  using auth.uid() = id       check auth.uid() = id
--      profile_delete_own  DELETE  {authenticated}  using auth.uid() = id       check tyhja
--
--    INSERTilla ei ole USINGia eika SELECTilla ja DELETElla WITH CHECKia.
--    Tyhja solu on niissa oikea tulos, ei puute.
select tablename as taulu, policyname as politiikka, cmd as operaatio,
       permissive as sallivuus, roles as roolit,
       qual as using_ehto, with_check as with_check_ehto
from pg_policies
where schemaname = 'public' and tablename in ('tasks', 'profile')
order by tablename, policyname;

-- 3. Politiikkojen maara yhtena lukuna. Odotus: 8.
select count(*) as politiikkoja
from pg_policies
where schemaname = 'public' and tablename in ('tasks', 'profile');

-- 4. Politiikat verrattuna ODOTETTUUN. Tama on kohdan 2 objektiivinen pari.
--
--    Kahdeksan rivia lausekkeita on juuri sopivan pituinen lista siihen,
--    etta yksi vaara merkki jaa huomaamatta silmamaaraisessa luvussa.
--    Tama kysely tekee vertailun puolestasi.
--
--    Odotus: sarake tulos = OK jokaisella rivilla ja
--            poikkeavia_yhteensa = 0.
--
--    Normalisointi koskee VAIN muotoilua: valilyonnit pois ja mahdolliset
--    uloimmat sulkeet pois. Postgres voi tulostaa saman lausekkeen
--    muodossa (auth.uid() = user_id) tai auth.uid() = user_id riippuen
--    versiosta. Sisempia sulkeita ei kosketa, joten esimerkiksi
--    auth.uid()-kutsun sulkeet sailyvat eika semantiikkaa loysenneta.
select x.taulu, x.politiikka, x.operaatio, x.roolit,
       x.odotettu_using, x.todellinen_using,
       x.odotettu_check, x.todellinen_check,
       x.tulos,
       count(*) filter (where x.tulos <> 'OK') over () as poikkeavia_yhteensa
from (
  select e.taulu, e.politiikka, e.operaatio,
         p.roles::text[] as roolit,
         e.odotettu_using,
         btrim(replace(coalesce(p.qual, ''), ' ', ''), '()') as todellinen_using,
         e.odotettu_check,
         btrim(replace(coalesce(p.with_check, ''), ' ', ''), '()') as todellinen_check,
         case
           when p.policyname is null then 'PUUTTUU'
           when p.permissive <> 'PERMISSIVE' then 'VAARA SALLIVUUS'
           when p.cmd <> e.operaatio then 'VAARA OPERAATIO'
           when p.roles::text[] <> array['authenticated'] then 'VAARA ROOLI'
           when btrim(replace(coalesce(p.qual, ''), ' ', ''), '()') <> e.odotettu_using
             then 'VAARA USING'
           when btrim(replace(coalesce(p.with_check, ''), ' ', ''), '()') <> e.odotettu_check
             then 'VAARA WITH CHECK'
           else 'OK'
         end as tulos
  from (values
    ('tasks',   'tasks_select_own',   'SELECT', 'auth.uid()=user_id', ''),
    ('tasks',   'tasks_insert_own',   'INSERT', '',                   'auth.uid()=user_id'),
    ('tasks',   'tasks_update_own',   'UPDATE', 'auth.uid()=user_id', 'auth.uid()=user_id'),
    ('tasks',   'tasks_delete_own',   'DELETE', 'auth.uid()=user_id', ''),
    ('profile', 'profile_select_own', 'SELECT', 'auth.uid()=id',      ''),
    ('profile', 'profile_insert_own', 'INSERT', '',                   'auth.uid()=id'),
    ('profile', 'profile_update_own', 'UPDATE', 'auth.uid()=id',      'auth.uid()=id'),
    ('profile', 'profile_delete_own', 'DELETE', 'auth.uid()=id',      '')
  ) as e(taulu, politiikka, operaatio, odotettu_using, odotettu_check)
  left join pg_policies p
    on p.schemaname = 'public'
   and p.tablename = e.taulu
   and p.policyname = e.politiikka
) x
order by x.taulu, x.politiikka;

-- 5. tasks.user_id. Odotus: uuid, is_nullable = NO, oletus auth.uid().
select column_name as sarake, data_type as tyyppi,
       is_nullable as sallii_nullin, column_default as oletus
from information_schema.columns
where table_schema = 'public' and table_name = 'tasks'
  and column_name = 'user_id';

-- 6. profile.id ja profile.legacy_id.
--    Odotus: id        = uuid, NO,  auth.uid()
--            legacy_id = text, YES, oletus TYHJA
--
--    legacy_id on tarkoituksella jaljella. Se sisaltaa alkuperaisen
--    arvon 'me' ja on ainoa asia, joka tekee migraatiosta peruttavan.
--
--    KATSO OLETUSSARAKE. Tuotannossa profile.id:lla oli default 'me',
--    ja oletus seuraa saraketta uudelleennimeamisessa. Jos oletus on
--    yha voimassa, JOKAINEN uusi profiilirivi saa legacy_id = 'me' ja
--    sarake lakkaa kertomasta kuka oli alkuperainen. Odotusarvo on
--    tyhja solu, ei mitaan muuta.
select column_name as sarake, data_type as tyyppi,
       is_nullable as sallii_nullin, column_default as oletus
from information_schema.columns
where table_schema = 'public' and table_name = 'profile'
  and column_name in ('id', 'legacy_id')
order by column_name;

-- 7. Perumisen merkkipaalu. Odotus: 1, 1, 1, 0.
--
--    legacy_id on ainoa asia, joka tekee lapimenneesta migraatiosta
--    purettavan ilman varmuuskopiota. Jos arvo on kadonnut, ROLLBACK-
--    osion kohta 2 ei enaa pida paikkaansa — ja se huomattaisiin vasta
--    silloin kun perumista oikeasti tarvitaan.
--
--    legacy_muu > 0 tarkoittaisi, etta oletusarvo jai voimaan ja uusia
--    riveja on syntynyt legacy-arvon kanssa, tai etta sarakkeeseen on
--    kirjoitettu jotain muuta. Kumpikaan ei kuulu tapahtua.
select count(*) as profiilirivit,
       count(*) filter (where legacy_id is not null) as legacy_ei_tyhja,
       count(*) filter (where legacy_id = 'me')      as legacy_me,
       count(*) filter (where legacy_id is not null
                          and legacy_id <> 'me')     as legacy_muu
from public.profile;

-- 8. Rivimaarat. Odotus: tasks = 36, profile = 1.
--    Migraatio ei saa havittaa yhtaan rivia. Jos luku on pienempi,
--    palauta varmuuskopiosta.
select 'tasks' as taulu, count(*) as rivit from public.tasks
union all
select 'profile', count(*) from public.profile;

-- 9. Rivit ilman omistajaa. Odotus: 0.
select count(*) as tehtavia_ilman_omistajaa
from public.tasks
where user_id is null;

-- 10. Omistaja on se, joka piti olla. Odotus: molemmat true.
--     bool_and palauttaa yhden totuusarvon, ei tunnisteita rivi riveilta.
select bool_and(user_id = '2cc00622-f927-4604-a518-361a4328481b'::uuid)
         as kaikki_tehtavat_oikealla_omistajalla
from public.tasks;

select bool_and(id = '2cc00622-f927-4604-a518-361a4328481b'::uuid)
         as profiili_oikealla_omistajalla
from public.profile;

-- 11. Eri omistajia yhteensa. Odotus: 1.
--     Jos tassa lukee enemman, backfill on osunut useampaan tiliin.
select count(distinct user_id) as eri_omistajia from public.tasks;

-- 12. Orvot viitteet auth.users-tauluun. Odotus: 0 molemmissa.
select count(*) as tehtavia_ilman_tilia
from public.tasks t
where not exists (select 1 from auth.users u where u.id = t.user_id);

select count(*) as profiileja_ilman_tilia
from public.profile pr
where not exists (select 1 from auth.users u where u.id = pr.id);

-- 13. Vierasavaimet: PAAT, ei vain nimi ja poistosaanto.
--
--     Rajoitteen nimi ei kerro mihin se osoittaa. Oikean niminen
--     vierasavain vaaraan sarakkeeseen tai vaaraan tauluun nayttaisi
--     nimilistassa taysin oikealta.
--
--     Odotus: kaksi rivia, molemmilla tulos = OK ja
--             poikkeavia_yhteensa = 0.
--
--       tasks_user_id_fkey   public.tasks(user_id) -> auth.users(id)  CASCADE
--       profile_id_fkey      public.profile(id)    -> auth.users(id)  CASCADE
select x.rajoite, x.lahde, x.kohde, x.poistosaanto, x.sarakkeita, x.tulos,
       count(*) filter (where x.tulos <> 'OK') over () as poikkeavia_yhteensa
from (
  select e.rajoite,
         coalesce(srcns.nspname || '.' || src.relname || '(' || srccol.attname || ')',
                  'PUUTTUU') as lahde,
         coalesce(tgtns.nspname || '.' || tgt.relname || '(' || tgtcol.attname || ')',
                  'PUUTTUU') as kohde,
         coalesce(case con.confdeltype
                    when 'c' then 'CASCADE'
                    when 'n' then 'SET NULL'
                    when 'd' then 'SET DEFAULT'
                    when 'r' then 'RESTRICT'
                    when 'a' then 'NO ACTION'
                    else 'TUNTEMATON'
                  end, 'PUUTTUU') as poistosaanto,
         array_length(con.conkey, 1) as sarakkeita,
         case
           when con.conname is null                        then 'PUUTTUU'
           when srcns.nspname <> 'public'                  then 'VAARA LAHDESKEEMA'
           when src.relname <> e.lahde_taulu               then 'VAARA LAHDETAULU'
           when array_length(con.conkey, 1) <> 1           then 'MONISARAKKEINEN'
           when srccol.attname <> e.lahde_sarake           then 'VAARA LAHDESARAKE'
           when tgtns.nspname <> 'auth'                    then 'VAARA KOHDESKEEMA'
           when tgt.relname <> 'users'                     then 'VAARA KOHDETAULU'
           when tgtcol.attname <> 'id'                     then 'VAARA KOHDESARAKE'
           when con.confdeltype <> 'c'                     then 'EI CASCADE'
           else 'OK'
         end as tulos
  from (values
    ('tasks_user_id_fkey', 'tasks',   'user_id'),
    ('profile_id_fkey',    'profile', 'id')
  ) as e(rajoite, lahde_taulu, lahde_sarake)
  left join pg_constraint con
    on con.conname = e.rajoite
   and con.contype = 'f'
   and con.conrelid in ('public.tasks'::regclass, 'public.profile'::regclass)
  left join pg_class     src    on src.oid = con.conrelid
  left join pg_namespace srcns  on srcns.oid = src.relnamespace
  left join pg_class     tgt    on tgt.oid = con.confrelid
  left join pg_namespace tgtns  on tgtns.oid = tgt.relnamespace
  left join pg_attribute srccol on srccol.attrelid = con.conrelid
                               and srccol.attnum = con.conkey[1]
  left join pg_attribute tgtcol on tgtcol.attrelid = con.confrelid
                               and tgtcol.attnum = con.confkey[1]
) x
order by x.rajoite;

-- 14. Ylimaaraiset vierasavaimet. Odotus: NOLLA RIVIA.
--     Kohta 13 todistaa etta odotetut ovat oikein. Tama todistaa ettei
--     muita ole.
select con.conname as rajoite, src.relname as taulu
from pg_constraint con
join pg_class src on src.oid = con.conrelid
where con.conrelid in ('public.tasks'::regclass, 'public.profile'::regclass)
  and con.contype = 'f'
  and con.conname not in ('tasks_user_id_fkey', 'profile_id_fkey')
order by con.conname;

-- 15. profile-taulun paaavain. Odotus: yksi rivi, sarakkeena id.
select con.conname as rajoite, col.attname as sarake
from pg_constraint con
join pg_attribute col
  on col.attrelid = con.conrelid
 and col.attnum = any (con.conkey)
where con.conrelid = 'public.profile'::regclass
  and con.contype = 'p';

-- 16. Indeksi. Odotus: vahintaan yksi rivi, jolla tulos = 'OK', ja
--     kelpaavia_indekseja >= 1.
--
--     TARKISTETAAN RAKENNE, EI NIMEA. Aiempi versio vaati taydellisen
--     osuman indeksin nimeen. Se on kahdella tapaa vaarin:
--
--       1. Nimi ei todista mitaan. Indeksi nimelta tasks_user_id_date_idx
--          voisi olla sarakkeella (date), ja nimeen luottava tarkistus
--          hyvaksyisi sen.
--       2. Oikea indeksi hylattaisiin vaaralla perusteella. Tuotannossa
--          on yhdistelmaindeksi (user_id, date). Tasmalleen sarakelistaa
--          (user_id) vaatinut tarkistus raportoi siita FAILin, vaikka
--          kanta oli kunnossa. Se oli varmistimen virhe, ei kannan.
--
--     Vaatimus on rakenteellinen: jonkin indeksin ENSIMMAISEN sarakkeen
--     on oltava user_id. Yhdistelmaindeksi (user_id, date) tayttaa sen,
--     koska btree-indeksia voi kayttaa myos pelkalla etuliitteellaan.
--     Toinen sarake on nopeutta, ei oikeellisuutta.
--
--     indkey on int2vector ja alkaa nollasta: indkey[0] on indeksin
--     ensimmainen sarake. Lausekeindeksien attnum on 0 eika liity
--     pg_attributeen — ne putoavat pois liitoksessa, mika on oikein,
--     koska lauseke ei ole sarake user_id.
select c.relname as indeksi,
       a.attname as ensimmainen_sarake,
       pg_get_indexdef(x.indexrelid) as maaritelma,
       case when a.attname = 'user_id' then 'OK' else '-' end as tulos,
       count(*) filter (where a.attname = 'user_id') over () as kelpaavia_indekseja
from pg_index x
join pg_class c on c.oid = x.indexrelid
join pg_class t on t.oid = x.indrelid
join pg_namespace n on n.oid = t.relnamespace
join pg_attribute a on a.attrelid = t.oid and a.attnum = x.indkey[0]
where n.nspname = 'public' and t.relname = 'tasks'
order by (a.attname = 'user_id') desc, c.relname;

-- 17. anon-roolin SUORAT oikeudet. Odotus: NOLLA RIVIA.
select table_name as taulu, privilege_type as oikeus
from information_schema.role_table_grants
where table_schema = 'public' and grantee = 'anon'
  and table_name in ('tasks', 'profile');

-- 18. authenticated-roolin SUORAT oikeudet. Odotus: TASAN 8 rivia
--     (4 operaatiota x 2 taulua). Ei TRUNCATE, ei REFERENCES, ei TRIGGER.
select table_name as taulu, privilege_type as oikeus
from information_schema.role_table_grants
where table_schema = 'public' and grantee = 'authenticated'
  and table_name in ('tasks', 'profile')
order by table_name, privilege_type;

-- 19. PUBLIC-roolin oikeudet. Odotus: NOLLA RIVIA.
--
--     Kohta 17 EI riita yksinaan. PostgreSQL-rooli PUBLIC tarkoittaa
--     "kaikki roolit": sille myonnetyn oikeuden perii jokainen rooli,
--     myos anon. Perittya oikeutta ei nay kohdassa 17 lainkaan, koska
--     role_table_grants listaa vain nimenomaiset myonnot roolinimelle.
--
--     aclexplode purkaa taulun oikeuslistan riveiksi. PUBLIC on siina
--     grantee-arvo 0. Jos relacl on tyhja, oikeuksia ei ole myonnetty
--     kenellekaan omistajan ulkopuolella eika tama palauta rivia.
select c.relname as taulu, a.privilege_type as oikeus
from pg_class c, aclexplode(c.relacl) a
where c.oid = any (array['public.tasks'::regclass, 'public.profile'::regclass])
  and a.grantee = 0;

-- 20. TEHOLLISET oikeudet. Tama on lopullinen todiste.
--
--     has_table_privilege kertoo mita rooli TODELLA saa tehda: se ottaa
--     huomioon seka PUBLIC-perinnan etta roolijasenyydet. Kohdat 17-19
--     kertovat mista oikeus tulee, tama kertoo onko sita.
--
--     Odotus, 14 rivia:
--       anon_saa            = false JOKAISELLA rivilla
--       authenticated_saa   = true  neljalla per taulu
--                                   (delete, insert, select, update)
--       authenticated_saa   = false loput (references, trigger, truncate)
--
--     Yksikin true anon-sarakkeessa tarkoittaa, etta julkinen avain
--     riittaa paasyyn ja RLS on ainoa jaljella oleva este.
select t.taulu, p.oikeus,
       has_table_privilege('anon', t.taulu, p.oikeus) as anon_saa,
       has_table_privilege('authenticated', t.taulu, p.oikeus) as authenticated_saa
from (select unnest(array['public.tasks', 'public.profile']) as taulu) t
cross join (select unnest(array['select', 'insert', 'update', 'delete',
                                'truncate', 'references', 'trigger']) as oikeus) p
order by t.taulu, p.oikeus;
