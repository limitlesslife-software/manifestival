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
tiedostoihin (5/5 sama); `docs/activation/SCHEMA-DIFFS-0009-0013.md` (nyt `SCHEMA-DIFFS-0009-0015.md`) on
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

---

# Migraatio 0014 (aalto K) — harjoittelu 2026-09-27

**Tulos: 0 hylättyä kaikissa lopullisissa ajoissa oikealla PostgreSQL
17:llä.** Harjoittelu löysi 0014:stä yhden lukitusvian, joka korjattiin
ja todennettiin (alla).

**Ympäristö:** PostgreSQL **17.10** (`PostgreSQL 17.10 on x86_64-windows,
compiled by msvc-19.44.35226, 64-bit`), oma klusteri `127.0.0.1:54359`,
data `.claude/pg-local/data-rehearsal` (ei ollut käytössä: portti ja
`postmaster.pid` tarkistettiin ennen käynnistystä; käynnistetty tätä
ajoa varten ja pysäytetty lopuksi). Portteihin 54329 ja 54349 ei
yhdistetty. Jokainen yhteys todensi `server_version_num = 170010` ja
data-hakemiston (`lib.assertRehearsalServer`), varmuuskopioajo lisäksi
nimenomaisen portin (`PG_REHEARSAL_PORT=54359`).

**Koodi (alkuperä):** tuotehaara `feature/daily-life-operating-system`
`8ba874a` + tämän harjoittelun commitit. Lopullinen oletusajo luki 50
tiedostoa commitista `3a555b129317158afa7446fbba8fa45e912636b8`
(0 commitoimatonta). Harjoitteluun lisättiin 0014 kaikkiin skenaarioihin
(`chain.mjs`, `seeds.mjs`, `rehearse.mjs`, `prodshape*.mjs`, `waves.mjs`,
`failure-scenarios.mjs`, `rollback-scenarios.mjs`,
`sql-result-fixtures.mjs`, `bundle-hashes.mjs`, `schema-diff-summary.mjs`,
`backup-scenario.mjs`). Aalto K ei ole vielä lukossa
(`release-train-c-j.json` tuntee C–J), joten `waves.trainWaves()` johtaa
sen `tools/release/waves.mjs`:stä: J:n 24 taulua + 0014:n 10 porttia, ei
uusia sarakeportteja (`locked: false`).

**Ajot** (kaikki `PG_REHEARSAL_PORT=54359`):

| Ajo | Komento | Commit | Aika (UTC) | Tulos |
|---|---|---|---|---|
| Kaikki 18 skenaariota (lopullinen) | `rehearse.mjs --fixtures=tests/fixtures/activation-inventory --fixture-states=0014,0013-partial-0014 --json=…` | `3a555b1` | 08:31:19–08:46:29 | **0 hylättyä** |
| Varmuuskopio B1–B15 | `rehearse.mjs --only=backup --backup-fixtures=<työhakemisto> --json=…` | `5b98ee0` | 08:51:25–08:54:18 | **324/324, 0 hylättyä** |
| SQL-tulosfixturet | `sql-result-fixtures.mjs --numbers=0014` | `af4cd49` | 08:50:20–08:50:51 | 4/4 odotettu päätös (2 GO, 2 STOP) |
| Kultainen ero | `rehearse.mjs --only=prodshape:chain --write-golden` | `dec6010` | ennen koko ajoa | 0014 kirjoitettu; **0009–0013 "sama", ei kirjoitettu** |
| Ensimmäinen koko ajo (alkuperäinen 0014) | `rehearse.mjs --json=…` | `dec6010` | 08:12:35–08:20:39 | 0 hylättyä (lukitusmittausta ei vielä ollut) |
| Lukitusvian todennus | `rehearse.mjs --only=failure:0010-locks` | `dec6010` + uusi mittaus | ennen korjausta | **3 hylättyä = löydös** → korjaus `a664514` → 0 hylättyä |

Lopullisen ajon kesto (15 min) on pidempi kuin ensimmäisen (8 min):
koneella ajettiin samaan aikaan muita töitä. Lukkojen aikarajat ovat
palvelimen `lock_timeout`-arvoja eivätkä riipu kuormasta.

## 0014: tulokset skenaarioittain

| Skenaario | Tulos | 0014 |
|---|---|---|
| preflight | 48/48 (oli 35) | `preflight_0014` PASS vain tilassa 0013 (18 riviä, 0 FAIL); tilassa 0014 jokainen `preflight_0009…0014` FAIL |
| rollback | 6/6 | ajo → ROLLBACK-osio (10 pudotusta lapsista vanhempiin) → katalogirivit täsmälleen samat → ajo uudelleen |
| inventory | 45/45 (oli 38) | tila 0013 → GO, seuraava 0014; tila 0014 → GO, ei seuraavaa (rivi 23 = 153); keskeneräinen 0014 (yksi taulu) → STOP, `0014 = partial`; text ja typed |
| upgrade:text / :typed | 14/14 | `verify_0014` 39 PASS / 0 FAIL (50 riviä, 11 INFO), `preflight_0014` 0 FAIL, ajo 306 ms; 26 vanhan taulun 92 riviä: arvot, `xmin` ja `relfilenode` ennallaan |
| rls | 36 taulua, 427 tarkistusta, 0 hylättyä (oli 26 / 311) | 116 tarkistusta 0014:n tauluissa: A ei lue, päivitä, poista, lisää B:n nimissä (42501) eikä siirrä riviään B:lle (42501); **kuusi yhdistelmävierasavainta** (`place_aliases.place_id`, `calendar_events.place_id`/`goal_id`, `commute_observations.place_id`, `habit_events.plan_id`, `exercise_sessions.goal_id`): viittaus B:n riviin → 23503; anon 42501; ei-sub näkee 0 riviä; ei anon/PUBLIC-oikeuksia |
| lifecycle | 54/54 (30 uutta) | Tavoitteen poisto nollaa **vain** `goal_id`:n (meno ja liikuntakerta jäävät omistajalleen: sarakekohtainen `set null (goal_id)`); paikan poisto: lisänimi ja havainto kaskadoituvat, menon `place_id` nollautuu, B:n rivit koskematta; suunnitelman poisto vie kirjaukset; toinen asetusrivi, sama heräämispäivä, sama tuntemuspäivä, `KUNTOSALI` vs. `Kuntosali` → 23505 (nimi käyttäjäkohtainen); 16 CHECK-rajaa → 23514 (koko päivä + alkuaika, ajastettu ilman alkua, loppu ilman alkua, viikonpäivä 8 tai NULL, ohitettu NULL-päivä, toisto ennen alkua, matka 0 min, motivaatio 6, hallinta 0, tuntematon kirjaus, jsonb väärää tyyppiä tai yli 8 192 tavua, `eur`, uni `deep`); havainnon `event_id` ei ole vierasavain (menon poisto ei vie havaintoa); tuntematon matka-aika = NULL; tilin poisto vie B:n rivit kaikista 36 taulusta |
| failure | 44/44 (13 uutta) | "JO AJETTU" heti 0014:n jälkeen ja koko ketjun jälkeen (jokainen 0009–0014); 0014 ilman 0013:a ja ilman 0012+0013:a → "Migraatio 0013 pitaa ajaa ensin"; osittainen tila (taulu `saved_places`, indeksin nimi `calendar_events_user_date_idx` toisessa taulussa, rajoitteen nimi `life_settings_one_per_user` toisessa taulussa) → "kesken: 1 objektia 153:sta"; goals- ja auth.users-kirjoitus (ROW EXCLUSIVE) → lukon aikakatkaisu, katalogi ennallaan, uusi ajo läpi lukon vapauduttua; goals-lukukysely **ei estä** (läpi); ylimääräinen politiikka vanhassa taulussa → kaatuu vaiheessa 11 kaikkien kymmenen taulun luonnin jälkeen, katalogi ennallaan |
| prodshape:fixture / values:0010 | 10/10 / 10/10 | ennallaan |
| prodshape:chain | 6/6 | 0014 tuotannon datalla täsmälleen J:n skeemaan (tila 0013): vanhat rivit ennallaan; kultainen ero `expected/schema-diff-0014.txt`: 10 taulua, 137 saraketta, 29 indeksiä, 108 rajoitetta (88 nimettyä + 10 pääavainta + 10 omistaja-avainta), 40 politiikkaa, 10 liipaisinta; **0 poistoa, 0 funktiota, yksikään rivi ei koske vanhaa objektia** |
| prodshape:pause | 7/7, 504 kirjoitusta | Tauko 0013 (I → J): J:n kirjoitusten jälkeen `preflight_0014` 0 FAIL. **Tauko 0014 (J → K):** elävän aallon J 52 ja aallon K 74 kirjoitusta sovelluksen omilla rivimuunnoksilla (`repo.mapping.toRow`): kaikki kymmenen taulua insert + update (+ koko päivän menon delete); `verify_0014` datan kanssa 0 FAIL; peruutuksen kuiva-ajo menee läpi (data ei estä) |
| verify:null | 6/6 | `verify_0014`:n jokainen tarkistus on `count()` tai `coalesce()`, joten NULL-tulosta ei synny; rikottu uniikkiavain → FAIL-rivit 20 ja 24 = `poikkeavia_yhteensa` 2 |
| preflight:blockers | 33/33 (oli 25) | Estäjä `goals`/`auth.users` → rivi 14 FAIL (ja 11 idle); ilman estäjää 0 FAIL; ylimääräinen politiikka `running_timers`-taulussa → rivi 09 FAIL (41 ≠ 40) ennen ajoa ja migraatio kaatuu kiinni; F13 `verify_0014`: vieraat taulut → 0 FAIL, rivi 36 INFO; `goals`-avain ilman CASCADEa → vain rivi 34; ilman avainta → vain rivi 35; uuden taulun (`sleep_logs`) avain ilman CASCADEa → rivit 33 ja 34 |
| rollback:data | 4/4 | 0014 aallon K datalla (72 kirjoitusta, rivi jokaisessa kymmenessä taulussa) → ROLLBACK → katalogi = tila 0013, vanhat rivit ennallaan, `verify_0013` 0 FAIL, 0014 uudelleen läpi |
| rollback:reverse-chain | PASS | 0008 → 0009…0014 aaltojen F–K datalla (24/27/37/45/50/72 kirjoitusta) → 0012 ennen 0013:a kaatuu vartijaan → peruutukset 0014…0009 → katalogi = tuotannon 0008 |
| failure:0010-locks | estäjämatriisi 22/22, muut 7/7 | 0014 × goals/auth.users × luku/kirjoitus: luku läpi (369/260 ms), kirjoitus → 5 031/5 078 ms ja peruutus, **goals-estäjällä 0 DDL-komentoa**, katalogi ja rivit ennallaan, uusi ajo läpi. Uudelleenajo goals-kirjoituslukon aikana → "JO AJETTU" 40 ms:ssa. **auth.users-kirjoitus 0014:n odottaessa goals-lukkoa: 5 ms** (ennen korjausta 4 996 ms, ks. löydös) |
| role:nonsuper | 6/6 | 0014 NOSUPERUSER-omistajana: `verify_0014` 39 PASS / 0 FAIL; kaikki 36 taulua roolin omistamia |
| backup (`--only=backup`) | 324/324 (oli 271) | N = 0014 molemmilla lähtötiloilla 53/53: tilan 0013 kuva, 0014 + verify, vahinko, palautus eri aikavyöhykkeessä, idempotenssi, `--prune`, peukalointi, ROLLBACK(0014) + palautus → katalogi = 0013 (B9), 0014:n kuva peruutettuun skeemaan hylätään (B10), 0014 uudelleen → palautus identtinen (B11: erikoismerkit, jsonb, `smallint[]`, `date[]`, `bigint`), B12–B15 |

## 0014: löydös (korjattu) — migraatio piti auth.users-lukkoa odottaessaan goals-lukkoa

**Oire.** Kun sovelluksella on avoin `goals`-kirjoitus (ROW EXCLUSIVE),
alkuperäinen 0014 (`8ba874a`) ehti luoda `saved_places`- ja
`place_aliases`-taulut (**58 DDL-komentoa**) ja jäi sitten odottamaan
`goals`-lukkoa `calendar_events_goal_fkey`:n kohdalla — pitäen samalla
`auth.users`-tauluun SHARE ROW EXCLUSIVE -lukkoa (ensimmäisen taulun
omistaja-avain). GoTruen kaltainen `auth.users`-kirjoitus
(kirjautuminen) oli jumissa **4 981 ms** (toisella mittauksella
4 996 ms), kunnes 0014 luovutti. Migraation otsikon väite "lukot …
hetkeksi" ei pitänyt. Sama vikaluokka kuin 0010:n F11.

**Korjaus** (`a664514`, vain `supabase/migrations/0014_daily_life.sql`):
uusi vaihe 0d `lock table public.goals in share row exclusive mode;`
heti uudelleenajon tunnistuksen ja `touch_updated_at`-tarkistuksen
jälkeen, ennen ensimmäistä DDL:ää. Sama lukitustila, jonka vierasavain
ottaisi muutenkin — ei vahvempaa lukkoa. `auth.users`-tauluun ei lisätä
`lock table`-lausetta: Supabasessa se vaatisi postgres-roolilta
auth-skeeman taulun muokkausoikeuden, jota ei ole todennettu.
Objektimäärä (153), tunnistus, `preflight_0014` ja `verify_0014` ennallaan
(`build-preflights.mjs --check`, `build-inventory.mjs --check`,
`build-snapshots.mjs --check` ajan tasalla).

**Todennus:** goals-kirjoitus estäjänä → 0 DDL-komentoa ennen
perumista, auth.users-kirjoitus **5–6 ms**, "JO AJETTU" yhä heti
(37–40 ms). Vertailu vanhaan versioon ajetaan joka kerta
(`failure:0010-locks` → `authStall0014Before`, git `8ba874a`).
Yksikkötesti `tests/pg-rehearsal-lib.test.mjs` vartioi lukituksen
paikkaa.

## 0014: tiedoksi (ei vikaa 0014:ssä; 0013 on lukittu)

**0013:n peruutuksella ei ole vartijaa 0014:ää vastaan.** Omassa
kloonissaan: 0013:n ROLLBACK-osio menee läpi 0014:n ollessa ajettu ja
jättää 0014:n kymmenen taulua tilaan, jota juna ei tunne. 0012:lla
vastaava vartija on (0013:a vastaan), mutta 0013:a ei muuteta.
Turvaverkko todennettiin: inventaario pysäyttää tilan (STOP: "Migraatio
0014 on ajettu mutta 0013 ei: järjestys on rikki."). Ohje on jo 0014:n
ROLLBACK-otsikossa ja `MIGRATION-BUNDLES.md`:ssä: 0014 ensin, sitten 0013.

## 0014: alkuperä ja generoidut tiedostot

| Tiedosto | git-blob |
|---|---|
| `supabase/migrations/0014_daily_life.sql` | `457150dfa00b3f008d55c2ece454a2323fb69f35` (ennen korjausta `a687961f4bebad8e0f6e556242e6e7eff8243d32`) |
| `supabase/preflight/preflight_0014.sql` | `590ccb549225151cc13418cbe594e1280cab6778` (ennallaan) |
| `supabase/verify/verify_0014.sql` | `4db67930ccffd779d26cedf66e48d94d244b1156` (ennallaan) |
| `supabase/backup/snapshot_state_0014.sql` | `8c775b31c20fb949ad2e2837a152eccf3f8e0113` (ennallaan) |
| `supabase/acceptance/activation_readonly_inventory.sql` | `7072e9c1c713be8bd3e87c1750dd9f477ed295d8` (ennallaan) |

0001–0013:n SQL-tiedostot ovat tavu tavulta samat kuin yllä (esim. 0013
`3825a11a…`, `preflight_0013` `04aaf286…`, `verify_0013` `7b5b7fdb…`).

Generoidut: `tools/pg-rehearsal/expected/schema-diff-0014.txt` (uusi;
0009–0013 ennallaan), `docs/activation/SCHEMA-DIFFS-0009-0015.md`
(nimetty uudelleen 0009-0013:sta, generaattorilla),
`docs/activation/MIGRATION-BUNDLES.md` (blobit + 0014:n paketti),
`tests/fixtures/activation-inventory/state-0014.json` ja
`state-0013-partial-0014.json` (vain nämä: `--fixture-states`),
`tests/fixtures/sql-results/{preflight,verify}_0014-{pass,fail}.tsv` +
manifestin 0014-rivit (`--numbers=0014`: 0009–0013:n rivit ennallaan).
Varmuuskopion fixture (`tests/fixtures/backup/state-0009.json`)
kirjoitettiin työhakemistoon eikä repositorioon: sen SQL ei muuttunut.

## 0014: toistaminen

```sh
PG_REHEARSAL_PORT=54359 node tools/pg-rehearsal/rehearse.mjs --json=raportti.json        # 18 skenaariota
PG_REHEARSAL_PORT=54359 node tools/pg-rehearsal/rehearse.mjs --only=backup                # B1–B15, N = 0009…0014
PG_REHEARSAL_PORT=54359 node tools/pg-rehearsal/rehearse.mjs --only=failure:0010-locks    # lukot + authStall0014
PG_REHEARSAL_PORT=54359 node tools/pg-rehearsal/sql-result-fixtures.mjs --numbers=0014
```
