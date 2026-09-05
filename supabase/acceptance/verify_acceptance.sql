-- Varmistus: RLS-eristystestin JALKEEN
-- VAIN LUKEVA. Yksi lause, yksi taulukko, yksi kopiointi.
--
-- MILLOIN: kun tools/rls-acceptance on ajettu, sen siivous on nayttanyt
-- PASSin ja vakinainen tili B on poistettu Supabasen Authentication-
-- nakymasta. Vasta tama tiedosto todistaa, etta tuotanto on palannut
-- taysin siihen tilaan, jossa se oli ennen hyvaksyntatestia.
--
-- MIKSI ERILLINEN: selaimessa ajettu testi katsoo kantaa RLS:n lapi. Se
-- ei siis voi nahda, jaiko toisen tilin rivi kantaan — RLS piilottaisi
-- juuri sen rivin, jota etsitaan. Tama tiedosto ajetaan SQL-editorissa
-- ilman RLS-rajausta, ja se on ainoa paikka, josta jaannoksen voi nahda.
--
-- ODOTUS: jokaisen rivin status = 'PASS' ja poikkeavia_yhteensa = 0.
-- Yksikin FAIL tarkoittaa, ettei tuotanto ole palannut lahtotilaan.
-- Ala kaanna yhtaan lippua alaka aja migraatiota 0002 ennen kuin syy on
-- selvitetty.
--
-- Tama tiedosto EI lue kayttajan sisaltoa. Se laskee rivimaaria ja
-- katsoo rakennetta.

select c.check_no,
       c.section,
       c.check_name,
       case when c.toteutui = c.odotus then 'PASS' else 'FAIL' end as status,
       'odotus ' || c.odotus || ', toteutui ' || c.toteutui as details,
       count(*) filter (where c.toteutui <> c.odotus) over () as poikkeavia_yhteensa
from (

  -- ================================================================
  -- TILIN A DATA — onko alkuperainen data koskematon
  -- ================================================================

  select '01' as check_no, 'tilin A data' as section,
         'Tilin A tehtavia on yha 36' as check_name,
         '36' as odotus,
         (select count(*)::text from public.tasks
           where user_id = '2cc00622-f927-4604-a518-361a4328481b'::uuid) as toteutui

  union all
  select '02', 'tilin A data', 'Tilin A profiili on yha olemassa', '1',
         (select count(*)::text from public.profile
           where id = '2cc00622-f927-4604-a518-361a4328481b'::uuid)

  union all
  -- is distinct from, ei <>. Omistajaton rivi ei ole tavallisella
  -- vertailulla "eri kuin A" vaan tuntematon, eika tuntematon kasvattaisi
  -- laskuria. Juuri se rivi jaisi siis nakymatta tassa kohdassa.
  select '03', 'tilin A data', 'Yhtaan tehtavaa ei omista joku muu kuin A', '0',
         (select count(*)::text from public.tasks
           where user_id is distinct from '2cc00622-f927-4604-a518-361a4328481b'::uuid)

  union all
  select '04', 'tilin A data', 'Omistajattomia riveja ei ole kummassakaan taulussa', '0',
         ((select count(*) from public.tasks where user_id is null)
        + (select count(*) from public.profile where id is null))::text

  union all
  select '05', 'tilin A data', 'Orpoja auth-viittauksia ei ole kummassakaan taulussa', '0',
         ((select count(*) from public.tasks x
             left join auth.users u on u.id = x.user_id
            where u.id is null)
        + (select count(*) from public.profile y
             left join auth.users u2 on u2.id = y.id
            where u2.id is null))::text

  union all
  -- legacy_id on ainoa asia, joka tekee migraatiosta purettavan ilman
  -- varmuuskopiota. Hyvaksyntatesti ei koske siihen, mutta jos arvo on
  -- kadonnut, se on kadonnut jostain muusta syysta ja se on tiedettava.
  select '06', 'tilin A data', 'Perumisen merkkipaalu legacy_id on tallella', '1',
         (select count(*)::text from public.profile where legacy_id = 'me')

  -- ================================================================
  -- JAANNOKSET — jaiko hyvaksyntatestista jalkea
  -- ================================================================

  union all
  select '07', 'jaannokset', 'Hyvaksyntatestin merkittyja riveja ei ole jaljella', '0',
         (select count(*)::text from public.tasks
           where id like 'manifestival_rls_acceptance_%')

  union all
  -- Erillinen kohdasta 01. Jos hyvaksyntatestin rivi jai kantaan toisen
  -- tilin nimiin, tilin A luku on yha 36 mutta kokonaisluku on suurempi.
  -- Vain tama kohta nakee sen.
  select '08', 'jaannokset', 'Tehtavia on yhteensa 36 — ei yhtaan vierasta rivia', '36',
         (select count(*)::text from public.tasks)

  union all
  select '09', 'jaannokset', 'Profiilirivien maara on tasan 1', '1',
         (select count(*)::text from public.profile)

  union all
  -- Vakinainen tili B on poistettava testin jalkeen. Sen poisto vie
  -- CASCADEn kautta myos mahdolliset jaljelle jaaneet rivit, joten tama
  -- on samalla ainoa kerta, kun poistoketju tulee oikeasti testattua.
  select '10', 'jaannokset', 'Auth-kayttajia on tasan yksi — tili B on poistettu', '1',
         (select count(*)::text from auth.users)

  -- ================================================================
  -- RAKENNE — onko 0001:n tulos yha voimassa
  -- ================================================================

  union all
  select '11', 'rakenne', 'RLS on paalla molemmissa tauluissa', '2',
         (select count(*)::text from pg_class
           where relnamespace = 'public'::regnamespace
             and relname in ('tasks', 'profile')
             and relrowsecurity)

  union all
  select '12', 'rakenne', 'Politiikkoja on tasan kahdeksan', '8',
         (select count(*)::text from pg_policies
           where schemaname = 'public' and tablename in ('tasks', 'profile'))

  union all
  -- Maara ei riita. Vaara ehto nayttaa ulospain samalta kuin oikea: sama
  -- nimi, sama operaatio, sama rooli. Ero on vain USING- ja
  -- WITH CHECK -lausekkeissa, ja juuri ne ratkaisevat nakeeko kayttaja
  -- toisen rivit. Siksi jokainen kahdeksasta tunnistetaan nimen,
  -- operaation, roolin JA normalisoidun lausekkeen perusteella.
  select '13', 'rakenne', 'Kaikkien kahdeksan politiikan ehdot tasmaavat odotettuun', '8',
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
              on e.tbl = p.tablename
             and e.pol = p.policyname
             and e.operaatio = p.cmd
             and btrim(replace(coalesce(p.qual, ''), ' ', ''), '()') = e.q
             and btrim(replace(coalesce(p.with_check, ''), ' ', ''), '()') = e.wc
           where p.schemaname = 'public'
             and p.roles = '{authenticated}'::name[])

  union all
  select '14', 'rakenne', 'Vierasavaimet osoittavat auth.users(id):hen CASCADElla', '2',
         (select count(*)::text
            from pg_constraint con
            join pg_class ft on ft.oid = con.confrelid
            join pg_namespace fn on fn.oid = ft.relnamespace
           where con.conname in ('tasks_user_id_fkey', 'profile_id_fkey')
             and con.contype = 'f'
             and con.confdeltype = 'c'
             and fn.nspname = 'auth'
             and ft.relname = 'users')

  union all
  -- Indeksi tarkistetaan RAKENTEESTA, ei nimesta. Vaatimus on, etta
  -- jonkin indeksin ENSIMMAINEN sarake on user_id: btree-indeksia voi
  -- kayttaa myos pelkalla etuliitteellaan, joten yhdistelma
  -- (user_id, date) tayttaa vaatimuksen ja (date, user_id) ei.
  --
  -- least(count, 1) muuttaa "vahintaan yksi" vertailtavaksi luvuksi.
  -- indkey on int2vector ja alkaa nollasta.
  select '15', 'rakenne', 'tasks-taulussa on indeksi, jonka ensimmainen sarake on user_id', '1',
         (select least(count(*), 1)::text
            from pg_index x
            join pg_class t on t.oid = x.indrelid
            join pg_namespace n on n.oid = t.relnamespace
            join pg_attribute a on a.attrelid = t.oid and a.attnum = x.indkey[0]
           where n.nspname = 'public'
             and t.relname = 'tasks'
             and a.attname = 'user_id')

  -- ================================================================
  -- OIKEUDET — kuka paasee tauluihin ilman RLS:aa
  -- ================================================================

  union all
  -- Teholliset oikeudet: has_table_privilege ottaa huomioon seka
  -- PUBLIC-perinnan etta roolijasenyydet. Yksikin oikeus anonille
  -- tarkoittaisi, etta julkinen avain riittaa paasyyn ja RLS on ainoa
  -- jaljella oleva este.
  select '16', 'oikeudet', 'anon-roolilla ei ole yhtaan tehollista oikeutta', '0',
         (select count(*)::text
            from (select unnest(array['public.tasks', 'public.profile']) as taulu) tt
            cross join (select unnest(array['select', 'insert', 'update', 'delete',
                                            'truncate', 'references', 'trigger']) as oikeus) pp
           where has_table_privilege('anon', tt.taulu, pp.oikeus))

  union all
  select '17', 'oikeudet', 'authenticated-roolilla on tasan CRUD molempiin tauluihin', '8',
         (select count(*)::text
            from (select unnest(array['public.tasks', 'public.profile']) as taulu) tt
            cross join (select unnest(array['select', 'insert', 'update', 'delete',
                                            'truncate', 'references', 'trigger']) as oikeus) pp
           where has_table_privilege('authenticated', tt.taulu, pp.oikeus))

  union all
  -- PUBLIC tarkoittaa "kaikki roolit", ja sille myonnetyn oikeuden perii
  -- myos anon. Perittya oikeutta ei nay roolikohtaisissa listauksissa
  -- lainkaan, joten se on katsottava taulun oikeuslistasta. aclexplode
  -- purkaa listan riveiksi; PUBLIC on siina grantee-arvo 0.
  select '18', 'oikeudet', 'PUBLIC-roolilla ei ole oikeuksia kumpaankaan tauluun', '0',
         (select count(*)::text
            from pg_class cl, aclexplode(cl.relacl) acl
           where cl.oid = any (array['public.tasks'::regclass, 'public.profile'::regclass])
             and acl.grantee = 0)

) c
order by c.check_no;
