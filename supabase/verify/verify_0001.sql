-- Varmistus: 0001_auth_user_scoping
-- VAIN LUKEVA. Aja migraation jalkeen, runbookin PYSAYTYS 3.
--
-- Sovitettu todennettuun tuotantoskeemaan. Odotusarvot ovat konkreettisia
-- lukuja, ei "pitaisi olla jotain jarkevaa". Jos jokin ei tasmaa, ala
-- kaanna yhtaan lippua ja ala aja seuraavaa migraatiota.
--
-- Tama tiedosto EI lue kayttajan sisaltoa. Se katsoo rakennetta,
-- rivimaaria ja omistajuutta.

-- 1. RLS paalla molemmissa. Odotus: kaksi rivia, molemmat true.
select relname as taulu, relrowsecurity as rls_paalla
from pg_class
where relnamespace = 'public'::regnamespace
  and relname in ('tasks', 'profile')
order by relname;

-- 2. Politiikat. Odotus: TASAN 8 rivia, 4 per taulu.
--    Roolina pitaa lukea {authenticated} jokaisella. Jos jollain lukee
--    {public} tai {anon}, turvamalli on rikki.
select tablename as taulu, policyname as politiikka, cmd as operaatio,
       roles as roolit
from pg_policies
where schemaname = 'public' and tablename in ('tasks', 'profile')
order by tablename, cmd;

-- 3. Politiikkojen maara yhtena lukuna. Odotus: 8.
select count(*) as politiikkoja
from pg_policies
where schemaname = 'public' and tablename in ('tasks', 'profile');

-- 4. tasks.user_id. Odotus: uuid, is_nullable = NO, oletus auth.uid().
select column_name as sarake, data_type as tyyppi,
       is_nullable as sallii_nullin, column_default as oletus
from information_schema.columns
where table_schema = 'public' and table_name = 'tasks'
  and column_name = 'user_id';

-- 5. profile.id ja profile.legacy_id.
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

-- 6. Rivimaarat. Odotus: tasks = 36, profile = 1.
--    Migraatio ei saa havittaa yhtaan rivia. Jos luku on pienempi,
--    palauta varmuuskopiosta.
select 'tasks' as taulu, count(*) as rivit from public.tasks
union all
select 'profile', count(*) from public.profile;

-- 7. Rivit ilman omistajaa. Odotus: 0.
select count(*) as tehtavia_ilman_omistajaa
from public.tasks
where user_id is null;

-- 8. Omistaja on se, joka piti olla. Odotus: molemmat true.
--    bool_and palauttaa yhden totuusarvon, ei tunnisteita rivi riveilta.
select bool_and(user_id = '2cc00622-f927-4604-a518-361a4328481b'::uuid)
         as kaikki_tehtavat_oikealla_omistajalla
from public.tasks;

select bool_and(id = '2cc00622-f927-4604-a518-361a4328481b'::uuid)
         as profiili_oikealla_omistajalla
from public.profile;

-- 9. Eri omistajia yhteensa. Odotus: 1.
--    Jos tassa lukee enemman, backfill on osunut useampaan tiliin.
select count(distinct user_id) as eri_omistajia from public.tasks;

-- 10. Orvot viitteet auth.users-tauluun. Odotus: 0 molemmissa.
select count(*) as tehtavia_ilman_tilia
from public.tasks t
where not exists (select 1 from auth.users u where u.id = t.user_id);

select count(*) as profiileja_ilman_tilia
from public.profile pr
where not exists (select 1 from auth.users u where u.id = pr.id);

-- 11. Vierasavaimet ja niiden poistosaanto.
--     Odotus: kaksi rivia, molemmilla confdeltype = c (cascade).
--     tasks_user_id_fkey ja profile_id_fkey.
select conname as rajoite, confdeltype as poistosaanto
from pg_constraint
where conrelid in ('public.tasks'::regclass, 'public.profile'::regclass)
  and contype = 'f'
order by conname;

-- 12. profile-taulun paaavain. Odotus: yksi rivi, sarakkeena id.
select con.conname as rajoite, col.attname as sarake
from pg_constraint con
join pg_attribute col
  on col.attrelid = con.conrelid
 and col.attnum = any (con.conkey)
where con.conrelid = 'public.profile'::regclass
  and con.contype = 'p';

-- 13. Indeksi. Odotus: tasks_user_id_date_idx loytyy.
select indexname as indeksi
from pg_indexes
where schemaname = 'public' and tablename = 'tasks'
  and indexname = 'tasks_user_id_date_idx';

-- 14. anon-roolin SUORAT oikeudet. Odotus: NOLLA RIVIA.
select table_name as taulu, privilege_type as oikeus
from information_schema.role_table_grants
where table_schema = 'public' and grantee = 'anon'
  and table_name in ('tasks', 'profile');

-- 15. authenticated-roolin SUORAT oikeudet. Odotus: TASAN 8 rivia
--     (4 operaatiota x 2 taulua). Ei TRUNCATE, ei REFERENCES, ei TRIGGER.
select table_name as taulu, privilege_type as oikeus
from information_schema.role_table_grants
where table_schema = 'public' and grantee = 'authenticated'
  and table_name in ('tasks', 'profile')
order by table_name, privilege_type;

-- 16. PUBLIC-roolin oikeudet. Odotus: NOLLA RIVIA.
--
--     Kohta 14 EI riita yksinaan. PostgreSQL-rooli PUBLIC tarkoittaa
--     "kaikki roolit": sille myonnetyn oikeuden perii jokainen rooli,
--     myos anon. Perittya oikeutta ei nay kohdassa 14 lainkaan, koska
--     role_table_grants listaa vain nimenomaiset myonnot roolinimelle.
--
--     aclexplode purkaa taulun oikeuslistan riveiksi. PUBLIC on siina
--     grantee-arvo 0. Jos relacl on tyhja, oikeuksia ei ole myonnetty
--     kenellekaan omistajan ulkopuolella eika tama palauta rivia.
select c.relname as taulu, a.privilege_type as oikeus
from pg_class c, aclexplode(c.relacl) a
where c.oid = any (array['public.tasks'::regclass, 'public.profile'::regclass])
  and a.grantee = 0;

-- 17. TEHOLLISET oikeudet. Tama on lopullinen todiste.
--
--     has_table_privilege kertoo mita rooli TODELLA saa tehda: se ottaa
--     huomioon seka PUBLIC-perinnan etta roolijasenyydet. Kohdat 14-16
--     kertovat mista oikeus tulee, tama kertoo onko sita.
--
--     Odotus, 14 rivia:
--       anon_saa            = false JOKAISELLA rivilla
--       authenticated_saa   = true  neljalla ensimmaisella per taulu
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
