# Migraatioharjoittelu oikealla PostgreSQL:llä — loppuharjoitus 2026-09-26

**Ympäristö:** PostgreSQL **17.10** (x86_64-windows), oma kertakäyttöinen
klusteri `127.0.0.1:54349`, data
`.claude/pg-local/data-rehearsal` (ignoroitu), ei asennusta eikä palvelua.
Jokainen yhteys todensi ensin, että palvelin on vähintään PostgreSQL 17 ja
sen data-hakemisto on projektin `.claude/pg-local`-hakemistossa
(`lib.assertRehearsalServer`) — portissa 54329 vastaava toisen projektin
PostgreSQL 15 ei kelpaa. Tuotanto on 17.6 (omistajan inventaario): sama
pääversio. Supabase-yhteensopiva perusta:
`tools/pg-rehearsal/supabase-shim.sql` (roolit `anon`, `authenticated`,
`service_role`, `auth.uid()` samalla määrittelyllä, public-skeeman
oletusoikeudet kuten Supabasessa).

**Koodi:** commit `056b553` (työpuu puhdas; raportin JSON listaa 47 luetun
tiedoston git-blob-tiivisteet). SQL-tiedostojen tiivisteet:
`docs/activation/MIGRATION-BUNDLES.md`.

**Ajo:** `node tools/pg-rehearsal/rehearse.mjs --json=…` — 18 skenaariota,
kesto 6 min 2 s (14:06:54–14:12:56 UTC). Tulos: **0 hylättyä**.

**Tuotannon muoto:** tila 0008 rakennettiin täsmälleen omistajan
inventaarion (2026-09-26) mukaan: 1 auth-käyttäjä = hyväksytty omistaja,
`tasks` 36 (`date`/`time` tekstinä, yhdelläkään ei kestoa), `profile` 1,
`goals` 1, `projects` 1, `notification_preferences` 1,
`wellbeing_entries` 1, `routines`, `routine_exceptions`, `bills`,
`recurring_expenses`, `savings_goals`, `ai_action_audit` 0. Omistajan
rivit ja niitä vastaavat sovelluksen kirjoitukset tehtiin roolina
`authenticated` sovelluksen omilla rivimuunnoksilla.

| Skenaario | Tulos | Mitä todistaa |
|---|---|---|
| prodshape:fixture | 10/10 | Harjoittelun inventaario = omistajan: 25 omistajan riviä + 28 johdettua riviä täsmää kaikissa 10 muunnelmassa (5 tavoitteen tilaa × projekti kytketty/irti); pisteytys GO, seuraava 0009; inventaario READ ONLY. Rivejä 03, 04, 43 omistaja ei toimittanut (43 = 1 harjoittelussa) |
| values:0010 | 10/10 | 0010 tuotannon muotoon, kaikki 10 muunnelmaa: jokaisen vanhan rivin arvot vanhoissa sarakkeissa (md5), `xmin` ja taulun `relfilenode` ennallaan (14 taulua); vanhoilla riveillä `depends_on = '{}'`, `milestone_id` null, tavoitteiden 7 uutta saraketta null, `automation_level = 1`, `planning_buffer_ratio = 0.25`; preflight 22 riviä / 0 FAIL, verify 40 PASS / 0 FAIL |
| prodshape:chain | 5/5 | 0009–0013 tuotannon datalla: vanhat rivit, `xmin` ja `relfilenode` ennallaan jokaisen migraation yli; katalogiero = kultainen tiedosto (`expected/schema-diff-00NN.txt`, yhteenveto `SCHEMA-DIFFS-0009-0013.md`); poistettu vain 0010:n `goals_status_check` ja 0013:n `time_entries_source_check` (korvaukset). Preflight 17/22/17/19/19 riviä 0 FAIL; verify 29/40/55/45/30 PASS 0 FAIL |
| prodshape:pause | 6/6 | Jokaisessa taukopisteessä (0008 E; 0009 E→F; 0010 F→G; 0011 G→H; 0012 H→I; 0013 I→J) elävän ja seuraavan aallon kirjoitukset **sovelluksen omilla rivimuunnoksilla** aallon sarakeporteilla, PostgREST-muodossa (insert, update, upsert, delete): 378/378 läpi. Verify kirjoitusten jälkeen 0 FAIL, seuraava preflight 0 FAIL. Peruutuksen kuiva-ajo: vain 0010 estyy (aallon G ylläpitotilan tavoite, vartija P0001) |
| failure:0010-locks | 18/18 + 4/4 | Estäjämatriisi: 0010 × goals/tasks/projects/profile × ACCESS SHARE/ROW EXCLUSIVE → lukon aikakatkaisu 5 009–5 018 ms, **0 DDL-komentoa ennen perumista**, katalogi, rivit ja 5 arvon tilarajoite ennallaan, ei jääneitä lukkoja, uudelleenajo läpi; auth.users: luku ei estä, kirjoitus estää (5 074 ms). 0009: bills estää (44 DDL:ää ehtii, perutaan), auth.users-kirjoitus estää. 0011: tasks/auth.users-luku ei estä, kirjoitus estää. Myöhäinen virhe tilarajoitteen vaihdon jälkeen (42 DDL:ää): katalogi, data ja 5 arvon rajoite ennallaan. Sovelluksen jumi: tasks-luku odotti 5 009 ms. Lukkiutuminen: sovellus sai 40P01 ja 0010 valmistui (verify 0 FAIL). Keskeytynyt istunto: 0 relaatiolukkoa, näkyy preflight_0010:n rivillä 15 |
| (vertailu) 0010 ennen F11:tä | tieto | Sama profile-estäjä: 42 DDL-komentoa (goals, tasks, projects muutettu) ennen perumista; jumi 5 014 ms; lukkiutumisessa migraatio sai 40P01. Molemmat perutaan kokonaan, mutta vain uusi versio odottaa ennen yhtäkään muutosta |
| verify:null | 5/5 | Rikottu objekti (sarake/rajoite pudotettu): FAIL-rivi lasketaan `poikkeavia_yhteensa`-lukuun (3/3, 2/2, 3/3, 3/3, 2/2) ja details kertoo `toteutui null`. Ennen korjausta sama ajo antoi 2 ≠ 3 ja tyhjän detailsin |
| preflight:blockers | 19/19 | Uusi esteet-rivi (`pg_locks`, lukitut taulut) FAIL jokaisella estäjällä 0009–0013 (+ auth.users, profile), 0 FAIL ilman estäjää. Ylimääräinen politiikka → preflight_0011/0012/0013 FAIL etukäteen (13 ≠ 12, 13 ≠ 12, 33 ≠ 32) ja migraatio kaatuu kiinni katalogin muuttumatta |
| rollback:data | 3/3 | 0010 aallon G datalla: peruutus kieltäytyy (P0001, selkeä viesti), katalogi ennallaan; tilakorjauksen jälkeen läpi, katalogi = ennen 0010, vanhat rivit ennallaan. 0012 liitetyllä tuotannon tavoitteella + kirjatulla ajalla: vanhat sarakkeet täsmälleen ennallaan. 0013 aallon J datalla: ennakkokysely 2 ajastinkirjausta / 1 menettää kohteen; peruutuksen jälkeen minuutit, päivä, alue/tavoite/tehtävä ennallaan rivi riviltä, lähde `manual` |
| rollback:reverse-chain | PASS | 0008 → 0009…0013 aaltojen F–J datalla → 0012:n peruutus ennen 0013:a kaatuu vartijaan (katalogi ennallaan) → peruutukset 0013, 0012, 0011, 0010 (4 ylläpitotavoitetta korjattu ensin), 0009 → **katalogi = tuotannon 0008**, tuotannon rivit, `xmin` ja `relfilenode` ennallaan |
| role:nonsuper | 5/5 | 0009–0013 NOSUPERUSER-omistajaroolina (omistaa public-skeeman ja taulut, REFERENCES/SELECT auth.users): kaikki läpi, verify 0 FAIL. Preflight-näkyvyys: ilman `pg_read_all_stats` idle in transaction -rivi PASS vaikka estäjä on auki (sokea), lukitut taulut -rivi FAIL (näkee); oikeuden kanssa molemmat FAIL |
| upgrade:text | 0001→0013 kaikki läpi | Verify 0 FAIL jokaisessa (0013: 30 PASS); 0003:sta alkaen jokaisen vanhan rivin arvot, `xmin` ja `relfilenode` ennallaan (ennen: vain rivimäärät); preflight_0009…0013 0 FAIL |
| upgrade:typed | sama | `date`/`time`-tyypeillä |
| rls | 26 taulua, 311 tarkistusta, 0 hylättyä | Eristys, anon, ei-sub, yhdistelmävierasavaimet, ei anon/PUBLIC-oikeuksia |
| lifecycle | 24/24 | Poistosäännöt, rajat, tilin poiston cascade kaikkiin 26 tauluun |
| failure | 31/31 | Uudelleenajo ("JO AJETTU"), puuttuva esiehto, osittainen tila, lukon aikakatkaisu, myöhäinen esiehto — katalogirivit ennallaan |
| rollback | 5/5 | Tyhjät uudet objektit: ajo → ROLLBACK-osio → katalogirivit täsmälleen samat → ajo uudelleen |
| preflight | 35/35 | Jokainen preflight PASS vain juuri ennen omaa migraatiotaan |
| inventory | 38/38 | Inventaario READ ONLY jokaisessa tilassa, pisteytys oikein |

Katalogivertailu kattaa nyt taulut (RLS, FORCE RLS, omistaja, ACL),
sarakkeet (tyyppi, NOT NULL, oletus, identity/generated, sarake-ACL),
indeksien ja liipaisimien määritelmät (+ enabled), rajoitteet,
politiikat (permissive, komento, ehdot, roolit), funktiot (lähde,
SECURITY DEFINER, `search_path`-asetus, ACL, omistaja) ja skeeman ACL:n.

## Löydökset tässä harjoituksessa (korjattu tähän committiin)

1. **verify_0009…0013 jätti NULL-tulokset pysäytysluvun ulkopuolelle** —
   puuttuva objekti näkyi FAIL-rivinä, mutta `poikkeavia_yhteensa` oli
   yhtä pienempi (2 vs. 3) ja details tyhjä. Operaattorin STOP-ehto on
   juuri tämä luku. Korjattu: `is distinct from` + `coalesce`.
2. **0010 muutti goals-, tasks- ja projects-tauluja ennen kuin jäi
   odottamaan profile-lukkoa** (42 DDL-komentoa). Transaktio perui kaiken,
   mutta lukot olivat päällä koko odotuksen. Nyt neljä taulua lukitaan
   kerralla kiinteässä järjestyksessä ennen yhtäkään muutosta: 0 DDL.
3. **Preflightin idle in transaction -rivi on sokea ilman
   `pg_read_all_stats`-oikeutta** (väärä PASS). Uusi esteet-rivi lukee
   `pg_locks`-näkymää ja näkee estäjän aina.
4. **Preflightit eivät kertoneet politiikkamääristä**, jotka 0011–0013
   vaativat ennen committia: yksi Dashboardista lisätty politiikka olisi
   antanut selittämättömän myöhäisen NO-GO:n. Nyt preflight pysäyttää
   etukäteen.
5. **0012:n peruutus riippui hiljaa 0013:n peruutuksesta** (running
   timers viittaa life_areas-tauluun). Nyt vartija kieltäytyy selkeästi,
   ja jokainen paketti sanoo: peruutus aina käänteisessä järjestyksessä.
6. **0013:n peruutus pudottaa kohdistuksen** (projekti, rutiini,
   esiintymä, ajastimen alku/loppu). Minuutit säilyvät, mutta kirjaus,
   jonka ainoa kohde oli projekti tai rutiini, jää ilman kohdetta. Osioon
   lisättiin vain lukeva ennakkokysely, joka laskee määrän.
7. **Omistajan inventaarioyhteenvedosta puuttui rivi 43**
   (`touch_updated_at` INVOKER + `search_path`). Pisteytys vaatii sen
   (STOP ilman). Tarkista rivi 43 = 1 ennen 0009:ää.

Aiemmat löydökset (2026-09-25, korjattu): verify_0011:n väärä hälytys
(`reminders.escalate`), uudelleenajon väärä "kesken"-viesti (0010, 0011,
0012 0013:n jälkeen) ja vanha 16-lauseinen inventaario, joka kaatui
tekstimuotoiseen `tasks.date`-sarakkeeseen.

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
node tools/pg-rehearsal/rehearse.mjs --json=raportti.json      # kaikki 18 skenaariota (~6 min)
node tools/pg-rehearsal/rehearse.mjs --only=prodshape           # tuotannon muotoiset
node tools/pg-rehearsal/rehearse.mjs --only=failure:0010-locks  # lukot (~2,5 min)
```
