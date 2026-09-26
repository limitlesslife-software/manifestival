# Migraatioharjoittelu oikealla PostgreSQL:llä — loppuharjoituksen uusinta 2026-09-26

**Ympäristö:** PostgreSQL **17.10** (`PostgreSQL 17.10 on x86_64-windows,
compiled by msvc-19.44.35226, 64-bit`), oma kertakäyttöinen klusteri
`127.0.0.1:54369`, data `.claude/pg-local/data-final` (ignoroitu; luotu
tätä ajoa varten `initdb -U postgres --auth=trust --encoding=UTF8
--locale=C`, pysäytetty lopuksi), ei asennusta eikä palvelua. Ennen
yhtäkään kantaa todennettiin `server_version_num = 170010` ja
`data_directory` projektin `.claude/pg-local`-hakemistossa; jokainen
yhteys tarkisti saman (`lib.assertRehearsalServer`), ja
varmuuskopioajo lisäksi nimenomaisen portin (`PG_REHEARSAL_PORT=54369`,
`lib.guardBackupRehearsal`). Portissa 54329 vastaavaan toisen projektin
PostgreSQL 15:een ei yhdistetty. Tuotanto on 17.6 (omistajan
inventaario): sama pääversio. Supabase-yhteensopiva perusta:
`tools/pg-rehearsal/supabase-shim.sql` (roolit `anon`, `authenticated`,
`service_role`, `auth.uid()` samalla määrittelyllä, public-skeeman
oletusoikeudet kuten Supabasessa).

**Koodi (alkuperä):** commit `7c7f1576c4e944bb1924e635a612dec95410c7ae`
(tuotehaara `feature/life-alignment-foundation` `e44644c` + tämän
uusinnan korjaukset), luetut tiedostot commitoituina (0 commitoimatonta).
Oletusajo luki 47 tiedostoa, varmuuskopioajo 30; jokaisen SQL-tiedoston
git-blob alla (sama kuin `git hash-object <polku>`). Tämä raportti on
commitoitu erikseen sen jälkeen; SQL-tiedostoihin se ei koske.

**Ajot:**

| Ajo | Komento | Aika (UTC) | Tulos |
|---|---|---|---|
| Kaikki 18 skenaariota | `PG_REHEARSAL_PORT=54369 node tools/pg-rehearsal/rehearse.mjs --json=…` | 16:38:44–16:43:38 (4 min 54 s) | **0 hylättyä** |
| Varmuuskopio B1–B15 | `PG_REHEARSAL_PORT=54369 node tools/pg-rehearsal/rehearse.mjs --only=backup --json=…` | 16:43:39–16:45:09 (1 min 29 s) | **271/271, 0 hylättyä** |
| SQL-tulosfixturet | `PG_REHEARSAL_PORT=54369 node tools/pg-rehearsal/sql-result-fixtures.mjs` | 16:23 (commit `b6423bc`; samat SQL-blobit, `manifest.json`) | 20/20 odotettu päätös (10 GO, 10 STOP) |

**Tuotannon muoto:** tila 0008 rakennettiin täsmälleen omistajan
inventaarion (2026-09-26) mukaan: 1 auth-käyttäjä = hyväksytty omistaja,
`tasks` 36 (`date`/`time` tekstinä, yhdelläkään ei kestoa), `profile` 1,
`goals` 1, `projects` 1, `notification_preferences` 1,
`wellbeing_entries` 1, `routines`, `routine_exceptions`, `bills`,
`recurring_expenses`, `savings_goals`, `ai_action_audit` 0. Omistajan
rivit ja niitä vastaavat sovelluksen kirjoitukset tehtiin roolina
`authenticated` sovelluksen omilla rivimuunnoksilla.

## Tulokset skenaarioittain

| Skenaario | Tulos | Mitä todistaa |
|---|---|---|
| preflight | 35/35 | Jokainen `preflight_0009…0013` jokaisessa tilassa 0007–0013: PASS vain juuri ennen omaa migraatiotaan. `preflight_0009` on nyt 19 riviä (junan alun rivit 18–19) |
| rollback | 5/5 | Tyhjät uudet objektit: ajo → ROLLBACK-osio → katalogirivit täsmälleen samat → ajo uudelleen |
| inventory | 38/38 | Inventaario READ ONLY jokaisessa tilassa 0008–0013 (text/typed), pisteytys oikein, taulukkosyöte = tiivistesyöte; keskeneräinen 0012 ja puuttuva omistaja → STOP |
| upgrade:text | 13/13 migraatiota läpi | Verify 0 FAIL jokaisessa: 0002 24, 0003 33, 0004 35, 0005 22, 0006 23, 0007 35, 0008 26, 0009 29, 0010 40, 0011 55, 0012 45, 0013 30 PASS (0013: 33 riviä, 3 INFO: 28, 50, 51); `preflight_0009…0013` 0 FAIL (19/22/17/19/19 riviä); 0003:sta alkaen jokaisen vanhan rivin arvot, `xmin` ja `relfilenode` ennallaan; 36 alkuperäistä tehtävää; 0012 ei liittänyt yhtään tavoitetta alueeseen |
| upgrade:typed | 13/13 | Sama `date`/`time`-tyypeillä, samat luvut |
| rls | 26 taulua, 311 tarkistusta, 0 hylättyä | Eristys, anon, ei-sub, yhdistelmävierasavaimet, ei anon/PUBLIC-oikeuksia |
| lifecycle | 24/24 | Poistosäännöt, rajat, tilin poiston cascade kaikkiin 26 tauluun |
| failure | 31/31 | Uudelleenajo ("JO AJETTU") jokaiselle 0009–0013 heti ja koko ketjun jälkeen, puuttuva esiehto, osittainen tila, lukon aikakatkaisu ja uusi ajo lukon vapauduttua, myöhäinen esiehto — katalogirivit ennallaan. Tietona (läpi): 0010 tilaan 0006, 0012 suoraan tilaan 0008, 0013 tilaan 0008+0012 |
| prodshape:fixture | 10/10 | Harjoittelun inventaario = omistajan: **26 omistajan riviä** (uusi rivi 89 = 0) + 28 johdettua riviä täsmää kaikissa 10 muunnelmassa (5 tavoitteen tilaa × projekti kytketty/irti); pisteytys GO, seuraava 0009; READ ONLY. Rivit 03, 04, 43 kirjataan (43 = 1 harjoittelussa). Omistajan rivit sellaisenaan: STOP vain rivin 43 takia |
| values:0010 | 10/10 | 0010 tuotannon muotoon: jokaisen vanhan rivin arvot (md5), `xmin` ja `relfilenode` ennallaan (14 taulua); vanhoilla riveillä `depends_on = '{}'`, `milestone_id` null, tavoitteiden 7 uutta saraketta null, `automation_level = 1`, `planning_buffer_ratio = 0.25`; preflight 22 riviä / 0 FAIL, verify 40 PASS / 0 FAIL |
| prodshape:chain | 5/5 | 0009–0013 tuotannon datalla: vanhat rivit, `xmin`, `relfilenode` ennallaan; katalogiero = kultainen tiedosto (`expected/schema-diff-00NN.txt`, **muuttumaton**); poistettu vain 0010:n `goals_status_check` ja 0013:n `time_entries_source_check`. Preflight 19/22/17/19/19 riviä 0 FAIL; verify 29/40/55/45/30 PASS 0 FAIL |
| prodshape:pause | 6/6 | Taukopisteet 0008 E; 0009 E→F; 0010 F→G; 0011 G→H; 0012 H→I; 0013 I→J: sovelluksen omat rivimuunnokset PostgREST-muodossa 378/378 läpi; verify ja seuraava preflight 0 FAIL; peruutuksen kuiva-ajo estyy vain 0010:ssä (P0001, 1 ylläpitotavoite) |
| verify:null | 5/5 | Rikottu objekti: FAIL-rivit = `poikkeavia_yhteensa` (3/3, 2/2, 3/3, 3/3, 2/2), details `toteutui null` |
| preflight:blockers | 25/25 | Esteet-rivi (`pg_locks`) FAIL jokaisella estäjällä 0009–0013 (+ auth.users, profile), 0 FAIL ilman (16); ylimääräinen politiikka → preflight_0011/0012/0013 FAIL etukäteen (13 ≠ 12, 13 ≠ 12, 33 ≠ 32) ja migraatio kaatuu kiinni (3). **Uusi F13 (6):** vieras public-taulu ei-CASCADE-avaimella → `preflight_0009` rivi 19 FAIL ennen junaa, CASCADE-avaimella 0 FAIL (rivi 18 = `2: mv_rehearsal_ilman_avainta, mv_rehearsal_vieras`); `verify_0013` samoilla tauluilla 0 FAIL, rivi 28 INFO; `goals`-avain ilman CASCADEa → vain rivi 26 FAIL, ilman avainta → vain rivi 27 FAIL |
| rollback:data | 3/3 | 0010 (ylläpitotila → P0001, korjauksen jälkeen läpi), 0012 (liitetty tavoite + kirjattu aika), 0013 (minuutit säilyvät, kohdistuksen menetys ennakkokyselystä) — vanhat rivit ja katalogi ennallaan |
| rollback:reverse-chain | PASS | 0008 → 0009…0013 aaltojen F–J datalla → 0012:n peruutus ennen 0013:a kaatuu vartijaan → peruutukset 0013…0009 → **katalogi = tuotannon 0008**, rivit, `xmin`, `relfilenode` ennallaan |
| failure:0010-locks | 18/18 + 5/5 | Estäjämatriisi: 0010 × goals/tasks/projects/profile × ACCESS SHARE/ROW EXCLUSIVE → lukon aikakatkaisu 5 030–5 066 ms, **0 DDL-komentoa ennen perumista**, katalogi, rivit ja 5 arvon tilarajoite ennallaan, ei jääneitä lukkoja, uudelleenajo läpi; auth.users: luku ei estä (läpi 200 ms), kirjoitus estää (5 082 ms). 0009: bills estää (44 DDL:ää ehtii, perutaan), auth.users-kirjoitus estää. 0011: tasks/auth.users-luku ei estä, kirjoitus estää. Myöhäinen virhe tilarajoitteen vaihdon jälkeen (42 DDL:ää): katalogi, data ja 5 arvon rajoite ennallaan. Sovelluksen jumi: tasks-luku odotti 5 005 ms. Lukkiutuminen: 0010 sai 40P01 ja perui kaiken (katalogi ennallaan), sovelluksen kirjoitus meni läpi — hyväksytty lopputila (edellisessä ajossa päinvastoin: sovellus 40P01, 0010 valmistui; kumpikin hyväksytään, välitilaa ei). Keskeytynyt istunto: 0 relaatiolukkoa, näkyy preflight_0010:n rivillä 15. **Uusi:** uudelleenajo `goals`-kirjoituslukon aikana → "JO AJETTU" 34 ms:ssa, katalogi ennallaan, 0 lukkoa |
| (vertailu) 0010 ennen F11:tä (`5aa0d53`) | tieto | Sama profile-estäjä: 42 DDL-komentoa ennen perumista; jumi 4 973 ms; lukkiutumisessa migraatio sai 40P01 |
| (vertailu) 0010 ennen katalogitarkistusten siirtoa (`e44644c`) | tieto | Sama uudelleenajo `goals`-lukon aikana: 5 015 ms ja "canceling statement due to lock timeout" — väärä syy |
| role:nonsuper | 5/5 | 0009–0013 NOSUPERUSER-omistajaroolina: kaikki läpi, verify 29/40/55/45/30 PASS 0 FAIL. Ilman `pg_read_all_stats` idle in transaction -rivi PASS vaikka estäjä on auki (sokea), lukitut taulut -rivi FAIL (näkee); oikeuden kanssa molemmat FAIL |
| backup (`--only=backup`) | 271/271 | B1 10/10 · B2 10/10 · B3 10/10 · B4 10/10 · B5 20/20 · B6 10/10 · B7 20/20 · B8 30/30 · B9 12/12 · B10 10/10 · B11 14/14 · B12 35/35 · B13 30/30 · B14 10/10 · B15 40/40 (jokainen N = 0009…0013 molemmilla lähtötiloilla; `docs/activation/0010-BACKUP-AND-RECOVERY.md` §10) |

Katalogivertailu kattaa taulut (RLS, FORCE RLS, omistaja, ACL),
sarakkeet (tyyppi, NOT NULL, oletus, identity/generated, sarake-ACL),
indeksien ja liipaisimien määritelmät (+ enabled), rajoitteet,
politiikat (permissive, komento, ehdot, roolit), funktiot (lähde,
SECURITY DEFINER, `search_path`-asetus, ACL, omistaja) ja skeeman ACL:n.

`upgrade:*`-ketjussa `preflight_0003` antaa 2 FAIL-riviä tuotantokohtaisesta
"yksi auth-käyttäjä" -ehdosta (harjoituksessa on kaksi synteettistä
käyttäjää); ketju ei käytä sitä hylkäysehtona, kuten ennenkin.

## Löydökset tässä uusinnassa (korjattu)

1. **`prodshape:fixture` hylkäsi 0/10 lähtökohdassa `e44644c`:**
   inventaarion rivi 89 (tehtäviä, joilla kesto > 0) puuttui odotetusta
   tuotannon inventaariosta ("(ei odotusta)"). Lisätty omistajan arvona
   0 (omistaja: "tasks with duration = 0"; rivi 62 = 0 kattaa sen).
   Uusi yksikkötesti vaatii, että odotetun inventaarion rivit ovat
   täsmälleen inventaario-SQL:n rivinumerot.
2. **`verify_0013`:n rivit 26–27 laskivat koko public-skeeman.** Taulu,
   jota mikään migraatio ei luonut, olisi kaatanut varmistuksen vasta
   junan lopussa. Nyt rivit rajataan migraatioiden 26 tauluun (tilin
   poiston kartta), muut public-taulut näkyvät rivillä 28 (INFO), ja
   `preflight_0009` tarkistaa oletuksen ennen junaa (rivit 18 INFO ja 19
   FAIL, jos jokin vierasavain `auth.users`-tauluun ei ole CASCADE).
3. **0010:n uudelleenajo sovelluksen lukon aikana odotti 5 s ja kaatui
   lukon aikakatkaisuun väärällä syyllä** (`e44644c`: 5 015 ms). Vain
   katalogia lukevat esiehdot ja uudelleenajon tunnistus (38 objektia)
   ajetaan nyt ennen lukitusta: "JO AJETTU" 34 ms:ssa. Lukitus on yhä
   ennen rivien lukua ja ennen yhtäkään DDL:ää (0 DDL estäjämatriisissa).
4. **Puhdas `verify_0013`-tulos pisteytyi STOP:ksi.** Oikean kannan
   tulokset (`tests/fixtures/sql-results`, 20 kpl) paljastivat, että
   `verify_0013`:n numeroinnissa on tarkoituksellisia aukkoja (01–08,
   10–15, 20–28, …) ja `score-sql-result.mjs` oletti 01..N ("numerointi
   katkeaa kohdassa 09") — sekä komentorivillä että orkestroijassa. Nyt
   liitosta verrataan SQL-tiedoston omiin tarkistusnumeroihin.
5. **Varmuuskopioharjoittelu antoi 10 hylkäystä jo lähtökohdassa
   `e44644c`** (todennettu ajamalla `e44644c`:n tiedostot: sama 10).
   B9 odotti 0010:n peruutukselta tilarajoitteen 23514:ää, mutta
   ROLLBACK-osion vartija kieltäytyy ennen yhtäkään DDL:ää (P0001). B15
   otti tilan P kuvan kannasta, jossa N oli jo ajettu (0010:
   projects/tasks → milestones, 0012: goals → life_areas), ja kuva
   hylättiin väärästä syystä. Harjoituksen odotukset korjattu; SQL ei
   muuttunut näiltä osin (0010:n ROLLBACK-osio tavu tavulta sama).

**Kultaiset skeemaerot eivät muuttuneet.** 0010:n muutos siirtää vain
DO-lohkot ja lukituslauseen transaktion sisällä; yksikään taulu, sarake,
rajoite, indeksi, politiikka, liipaisin tai funktio ei muutu.
`prodshape:chain` vertasi jokaisen migraation katalogieron muuttamattomiin
tiedostoihin (5/5 sama); `docs/activation/SCHEMA-DIFFS-0009-0013.md` on
ajan tasalla (`schema-diff-summary.mjs --check`).

**Johdetut tiedostot tarkistettu:** `build-preflights.mjs --check`,
`build-inventory.mjs --check`, `build-snapshots.mjs --check` (6
tilannekuvaa), `schema-diff-summary.mjs --check`, `bundle-hashes.mjs
--check` — kaikki ajan tasalla. Inventaarion fixtureja
(`tests/fixtures/activation-inventory`) ja varmuuskopion fixturea
(`tests/fixtures/backup/state-0009.json`) ei generoitu uudelleen: niiden
SQL ei muuttunut, ja niiden aikaleimoja käytetään orkestroijan
ikätesteissä.

## Aiemmat löydökset (loppuharjoitus 2026-09-26, `056b553`; korjattu)

1. `verify_0009…0013` jätti NULL-tulokset pysäytysluvun ulkopuolelle
   (2 vs. 3) — korjattu: `is distinct from` + `coalesce`.
2. 0010 muutti goals-, tasks- ja projects-tauluja ennen kuin jäi
   odottamaan profile-lukkoa (42 DDL-komentoa) — nyt neljä taulua
   lukitaan kerralla ennen yhtäkään muutosta: 0 DDL.
3. Preflightin idle in transaction -rivi on sokea ilman
   `pg_read_all_stats`-oikeutta — uusi esteet-rivi lukee `pg_locks`-näkymää.
4. Preflightit eivät kertoneet politiikkamääristä, jotka 0011–0013
   vaativat ennen committia — nyt preflight pysäyttää etukäteen.
5. 0012:n peruutus riippui hiljaa 0013:n peruutuksesta — vartija
   kieltäytyy, peruutus aina käänteisessä järjestyksessä.
6. 0013:n peruutus pudottaa kohdistuksen — vain lukeva ennakkokysely
   laskee määrän.
7. Omistajan inventaarioyhteenvedosta puuttui rivi 43
   (`touch_updated_at` INVOKER + `search_path`). Pisteytys vaatii sen
   (STOP ilman). Tarkista rivi 43 = 1 ennen 0009:ää.

Aiemmat löydökset (2026-09-25, korjattu): verify_0011:n väärä hälytys
(`reminders.escalate`), uudelleenajon väärä "kesken"-viesti (0010, 0011,
0012 0013:n jälkeen) ja vanha 16-lauseinen inventaario, joka kaatui
tekstimuotoiseen `tasks.date`-sarakkeeseen.

## Alkuperä: luetut SQL-tiedostot

| Tiedosto | git-blob | Ajo |
|---|---|---|
| `supabase/acceptance/activation_readonly_inventory.sql` | `02602e420c12d9a53b1cc0be0f63abcfe39b0871` | oletusajo |
| `supabase/backup/snapshot_state_0008.sql` | `19cc70760c4d936adbee2c5a134c9c0b83e2da5c` | backup |
| `supabase/backup/snapshot_state_0009.sql` | `3c854291c618566b5b48a1823fa52407e100134d` | backup |
| `supabase/backup/snapshot_state_0010.sql` | `7ca2e5135cd752d86c2bd7fed5e01c4f3a10a359` | backup |
| `supabase/backup/snapshot_state_0011.sql` | `b7f394f37fd4920e9fc8a7bce58b54bc7841d655` | backup |
| `supabase/backup/snapshot_state_0012.sql` | `9992ddb92a6d8427f9ad68b317d489825aa67861` | backup |
| `supabase/backup/snapshot_state_0013.sql` | `6cce28f074cf9b889b950e11df00293480828fe7` | backup |
| `supabase/migrations/0001_auth_user_scoping.sql` | `592aa6b8496d4ba95bd3c67e5a652e99f5430ebf` | molemmat |
| `supabase/migrations/0002_task_domain_fields.sql` | `ff11ea944092509ee98ec90cf79176d32f56f6d6` | molemmat |
| `supabase/migrations/0003_routines.sql` | `c95caf424de1a5350f403b37d41186bd97ae73f9` | molemmat |
| `supabase/migrations/0004_goals_projects.sql` | `f49ec22275eb2a73413e371c5175c1aa82d5ff62` | molemmat |
| `supabase/migrations/0005_notification_preferences.sql` | `6cfa2d4f53447ab58541628f6b49bea5d73c1f1f` | molemmat |
| `supabase/migrations/0006_wellbeing.sql` | `9a66a915874603d3cf43f946055970dc0f80277b` | molemmat |
| `supabase/migrations/0007_finance.sql` | `528cdaae63f83087f1f02bfbc57ee1f56cc28292` | molemmat |
| `supabase/migrations/0008_ai_audit.sql` | `12ee41b180c8758dc4f24ab64305601e24963b55` | molemmat |
| `supabase/migrations/0009_finance_2.sql` | `278a806757e7ed10ee97a0a8f4837f07633f5a97` | molemmat |
| `supabase/migrations/0010_goal_to_action.sql` | `431e9270c8e0c4ce9403b70fdcb47c5e2be174ec` | molemmat |
| `supabase/migrations/0011_personal_assistant.sql` | `2ed6389aabe89af693b1ed278483a6c44f48f147` | molemmat |
| `supabase/migrations/0012_life_alignment.sql` | `c10d2b6ed843b6a0d16c6cb3c82970f67e64b975` | molemmat |
| `supabase/migrations/0013_alignment_reality.sql` | `3825a11a172150f408761f613cf1c9a50d9616ac` | molemmat |
| `supabase/preflight/preflight_0002.sql` | `a4cac6bd88eed44d168f12991a028443b633b689` | oletusajo |
| `supabase/preflight/preflight_0003.sql` | `386a81935532ffef4c55d02f6049edcb0d6f15db` | oletusajo |
| `supabase/preflight/preflight_0004.sql` | `a9d44148269780d69a316be76ff597a1472b9d86` | oletusajo |
| `supabase/preflight/preflight_0005.sql` | `50230f3a35751a7815371150ef59ceb800a940c9` | oletusajo |
| `supabase/preflight/preflight_0006.sql` | `3ccd1d870562478f4900584db293fe43f8af5f87` | oletusajo |
| `supabase/preflight/preflight_0007.sql` | `fa95df5ec77afc271c0f629a55823f41d7334fe9` | oletusajo |
| `supabase/preflight/preflight_0008.sql` | `8e37e2cef768bdc10439ff0ec3477f630d346dc0` | oletusajo |
| `supabase/preflight/preflight_0009.sql` | `5818030a69b0d2b61a4f5bd1a922da86050092f2` | molemmat |
| `supabase/preflight/preflight_0010.sql` | `b9279498e587bdb6609941d28c338415ee5205af` | molemmat |
| `supabase/preflight/preflight_0011.sql` | `3dac36aebaf33c5a57534750531bd6571eaa06d0` | molemmat |
| `supabase/preflight/preflight_0012.sql` | `b4ea1b810b2ab43b3716e4406383849399a9e9c8` | molemmat |
| `supabase/preflight/preflight_0013.sql` | `04aaf286a0e87da2129f330c4ddcfca31891a5d1` | molemmat |
| `supabase/verify/verify_0001.sql` | `ebeed07caecbcfc0e631af8f12c0dc354f5f0c27` | oletusajo |
| `supabase/verify/verify_0002.sql` | `039d4e6cd7348646bc8ddd6d12f3739075572372` | oletusajo |
| `supabase/verify/verify_0003.sql` | `de3375daab18a59e83d870a460a5bc5dba6b6803` | oletusajo |
| `supabase/verify/verify_0004.sql` | `6b160e782e09b5e2ae09386ae528b401cf5a3dd3` | oletusajo |
| `supabase/verify/verify_0005.sql` | `9412e64427407006bbd40472e6c4bbb7046ff38b` | oletusajo |
| `supabase/verify/verify_0006.sql` | `45e2d876e43cfba20633379b595d4ff7040e3b1f` | oletusajo |
| `supabase/verify/verify_0007.sql` | `63da67f9a2c8c0b3d582651140d0d8bba815acb4` | oletusajo |
| `supabase/verify/verify_0008.sql` | `62a50156abae977c2706452ef277751d32260e0d` | oletusajo |
| `supabase/verify/verify_0009.sql` | `470176835858356ecbafd0cef5653fd60ce29961` | molemmat |
| `supabase/verify/verify_0010.sql` | `75cc526992c22b35b03071d1acd00d7b9946d3e3` | molemmat |
| `supabase/verify/verify_0011.sql` | `2f1b8c43f91aa0d44d7bc15a2437b51e9808452f` | molemmat |
| `supabase/verify/verify_0012.sql` | `3d511f251ed96ebb87118a9b5f17e889d7a07b14` | molemmat |
| `supabase/verify/verify_0013.sql` | `7b5b7fdb0c07d250bb523d1794080e3e11974783` | molemmat |

Muut luetut: `docs/activation/release-train-c-j.json`,
`src/data/collectionsRepo.js`, `src/data/notificationPrefsRepo.js`,
`src/data/profileRepo.js`, `src/data/schema.js`, `src/domain/task.js`,
`src/lib/rows.js` (sovelluksen rivimuunnokset) ja
`tools/pg-rehearsal/supabase-shim.sql` (`c2c3a1b32a19…`).

Muuttuneet SQL-tiedostot lähtökohtaan `e44644c` nähden:

| Tiedosto | ennen (`e44644c`) | nyt |
|---|---|---|
| `supabase/preflight/preflight_0009.sql` | `2d4a1d9fb613f7e9364de5e68b482059ad6b24c1` | `5818030a69b0d2b61a4f5bd1a922da86050092f2` |
| `supabase/migrations/0010_goal_to_action.sql` | `270023e401439a6c3d40eb27223d0c58f3602310` | `431e9270c8e0c4ce9403b70fdcb47c5e2be174ec` |
| `supabase/verify/verify_0013.sql` | `6545487363e646ceb44ae683c4fa851d4051ebf9` | `7b5b7fdb0c07d250bb523d1794080e3e11974783` |

## Mitä EI todistettu

| Aukko | Miksi | Luokka |
|---|---|---|
| PostgREST/HTTP-kerros | Ei paikallista PostgRESTiä. Kirjoitukset jäljiteltiin PostgREST 12:n SQL-muodolla (`json_populate_recordset`, `on conflict … do update`) samassa roolissa (`authenticated` + `request.jwt.claims`); HTTP, `Prefer`-otsakkeet ja PostgRESTin skeemavälimuisti eivät ole mukana | REAL_DB_ENVIRONMENT_REQUIRED (aallon hyväksyntä tuotannossa kattaa) |
| Supabasen `postgres`-roolin vivahteet | Harjoitus ajoi superuserina ja NOSUPERUSER-omistajana; Supabasen roolin jäsenyydet (erit. `pg_read_all_stats`), omistukset ja mahdolliset tapahtumaliipaisimet eivät ole mukana | sama; preflightin lukitut taulut -rivi ei riipu niistä |
| Supabasen SQL-editorin käytös | Harjoitus ajaa tiedoston yhtenä simple-query-kutsuna. Editorin tapa ajaa monilauseinen tiedosto, näyttää tulokset ja pitää istuntoa auki virheen jälkeen on todennettu vain epäsuorasti (0001–0008 ajettiin tuotannossa samalla tavalla) | OWNER_ACTION: uusi välilehti jokaiselle ajolle |
| Tuotannon katalogin identtisyys 0001–0008 | Inventaario kertoo objekti- ja rivimäärät, ei määritelmiä. Harjoittelun tila 0008 syntyy repositorion 0001–0008-tiedostoista | OWNER_READ_ONLY_SQL (katalogin tilannekuva) |
| Tuotannon tavoitteen tila ja projektin kytkentä | Inventaario kertoo vain lukumäärät | katettu: kaikki 10 muunnelmaa läpi |
| Varmuuskopio ja palautus | Ei tämän harjoituksen alaa | `docs/activation/0010-BACKUP-AND-RECOVERY.md` |
| Samanaikainen kuorma | Yksittäiset estäjät, jumi ja lukkiutuminen mitattu; ei kuormaa | ei estä (yksi käyttäjä) |
| Supabase Realtime / pitkät taustakyselyt | Preflightin "yli minuutin kyselyt" -rivi voi laueta taustaprosessista | tulkitaan tuotannossa |

## Toistaminen

```sh
# oma klusteri (ks. tools/pg-rehearsal/README.md), sitten:
PG_REHEARSAL_PORT=54369 node tools/pg-rehearsal/rehearse.mjs --json=raportti.json   # kaikki 18 skenaariota (~5 min)
PG_REHEARSAL_PORT=54369 node tools/pg-rehearsal/rehearse.mjs --only=backup          # varmuuskopio B1–B15 (~1,5 min)
PG_REHEARSAL_PORT=54369 node tools/pg-rehearsal/rehearse.mjs --only=failure:0010-locks  # lukot (~2,5 min)
PG_REHEARSAL_PORT=54369 node tools/pg-rehearsal/sql-result-fixtures.mjs             # tests/fixtures/sql-results
```
