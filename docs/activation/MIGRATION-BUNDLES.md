# Migraatiopaketit 0009–0013

Jokainen migraatio on **oma pakettinsa ja oma hyväksyntänsä**. Niitä ei
koskaan niputeta yhteen SQL-ajoon. Järjestys on 0009 → 0010 → 0011 → 0012 →
0013, ja jokaisen välissä on sen aallon deploy ja hyväksyntä
(`docs/SUUNTA-ACTIVATION-GO-NOGO.md`).

Kaikki alla on harjoiteltu **oikealla PostgreSQL 17:llä** (17.10; tuotanto
17.6) tuotannon muotoisesta tilasta 0008, joka vastaa omistajan
inventaariota 2026-09-26 täsmälleen (1 auth-käyttäjä = omistaja, 36
tehtävää `date`/`time` tekstinä, 1 profiili, 1 tavoite, 1 projekti, 1
muistutusasetus, 1 hyvinvointimerkintä, muut taulut tyhjiä):
`tools/pg-rehearsal`, tulokset `docs/activation/REHEARSAL-REPORT.md`,
skeemaerot `docs/activation/SCHEMA-DIFFS-0009-0013.md`.

## Lähde: mistä SQL kopioidaan

Kopioi jokainen preflight-, migraatio- ja verify-tiedosto
**tuotehaarasta `feature/life-alignment-foundation`** (se commit, jossa
tiivisteet täsmäävät alla olevaan taulukkoon, tai uudempi, jossa
taulukko on päivitetty). Tarkista ennen ajoa:

```sh
git hash-object supabase/migrations/0010_goal_to_action.sql   # = taulukon arvo
```

**Älä kopioi aaltojen ehdokashaaroista** (`rehearsal/wave-g-v3`,
`rehearsal/wave-i-v1`, `rehearsal/wave-j-v1`): niissä on 0010:n, 0012:n ja
0013:n vanhempi versio (blobit `7e16f52d…`, `59061f2e…`, `b7ae23e9…` —
0010 ilman lukitusjärjestystä, 0012/0013 ilman peruutusvartijoita), eikä
haaroissa `wave-f-v3` … `wave-i-v1` ole preflight-tiedostoja lainkaan
(`wave-j-v1`:n preflightit ovat vanhempia). Aallon *sovelluskoodi*
deployataan ehdokashaarasta; SQL ajetaan aina tästä taulukosta.

<!-- blob-taulukko:alku (node tools/pg-rehearsal/bundle-hashes.mjs --write) -->
| Migraatio | Tiedosto | git-blob (`git hash-object <polku>`) |
|---|---|---|
| 0009 | `supabase/preflight/preflight_0009.sql` | `5818030a69b0d2b61a4f5bd1a922da86050092f2` |
| 0009 | `supabase/migrations/0009_finance_2.sql` | `278a806757e7ed10ee97a0a8f4837f07633f5a97` |
| 0009 | `supabase/verify/verify_0009.sql` | `470176835858356ecbafd0cef5653fd60ce29961` |
| 0010 | `supabase/preflight/preflight_0010.sql` | `b9279498e587bdb6609941d28c338415ee5205af` |
| 0010 | `supabase/migrations/0010_goal_to_action.sql` | `431e9270c8e0c4ce9403b70fdcb47c5e2be174ec` |
| 0010 | `supabase/verify/verify_0010.sql` | `75cc526992c22b35b03071d1acd00d7b9946d3e3` |
| 0011 | `supabase/preflight/preflight_0011.sql` | `3dac36aebaf33c5a57534750531bd6571eaa06d0` |
| 0011 | `supabase/migrations/0011_personal_assistant.sql` | `2ed6389aabe89af693b1ed278483a6c44f48f147` |
| 0011 | `supabase/verify/verify_0011.sql` | `2f1b8c43f91aa0d44d7bc15a2437b51e9808452f` |
| 0012 | `supabase/preflight/preflight_0012.sql` | `b4ea1b810b2ab43b3716e4406383849399a9e9c8` |
| 0012 | `supabase/migrations/0012_life_alignment.sql` | `c10d2b6ed843b6a0d16c6cb3c82970f67e64b975` |
| 0012 | `supabase/verify/verify_0012.sql` | `3d511f251ed96ebb87118a9b5f17e889d7a07b14` |
| 0013 | `supabase/preflight/preflight_0013.sql` | `04aaf286a0e87da2129f330c4ddcfca31891a5d1` |
| 0013 | `supabase/migrations/0013_alignment_reality.sql` | `3825a11a172150f408761f613cf1c9a50d9616ac` |
| 0013 | `supabase/verify/verify_0013.sql` | `7b5b7fdb0c07d250bb523d1794080e3e11974783` |
<!-- blob-taulukko:loppu -->

## Yhteiset säännöt

| Asia | Sääntö |
|---|---|
| Missä ajetaan | Supabase → SQL Editor → **uusi välilehti**, postgres-rooli, ei muita avoimia välilehtiä |
| Miten | Liitä **koko** tiedosto, ei valintaa, Run |
| Transaktio | Jokainen migraatio on yksi `begin … commit`. Kesken kaatunut ajo **perutaan kokonaan** — todennettu: katalogi, vanhat rivit ja tilarajoite täsmälleen ennallaan jokaisessa virhetilanteessa, myös kun virhe injektoitiin 0010:n tilarajoitteen vaihdon **jälkeen** |
| Lukot | `set local lock_timeout = '5s'` — 5 s per lukon odotus (lock_timeout koskee jokaista lukkoa erikseen): jos sovelluksen pyyntö tai avoin välilehti pitää lukkoa, migraatio luovuttaa 5 s:ssa ja peruuntuu kokonaan; lukon vapauduttua uusi ajo menee läpi. **0010 lukitsee `goals`, `projects`, `tasks` ja `profile` kerralla ennen yhtäkään muutosta**: estäjä missä tahansa niistä = 0 DDL-komentoa ennen perumista, sovelluksen luku odottaa enintään ~5 s |
| Virheen jälkeen | Avaa **uusi** editorin välilehti. Kaatunut istunto ei pidä lukkoja (todennettu), mutta se näkyy preflightissa rivinä *idle in transaction (aborted)* |
| Esteet preflightissa | *Avoimia idle in transaction -istuntoja*, *Odottavia lukkoja* (tämä kanta) ja *Muut istunnot eivät lukitse tauluja, joita NNNN muuttaa* (`pg_locks`). Idle-rivi ei näe muiden roolien istuntoja ilman `pg_read_all_stats`-oikeutta; lukitut taulut -rivi näkee estäjän aina (todennettu NOSUPERUSER-roolilla) |
| Uudelleenajo | Kaatuu kiinni viestillä **"JO AJETTU"**. 0010 tunnistaa sen katalogista ennen lukitusta: viesti tulee heti (harjoitus 55 ms), vaikka sovellus pitäisi `goals`-lukkoa — aiemmin lukon aikakatkaisu 5 s:n jälkeen väärällä syyllä |
| Vanha data | Jokaisen vanhan rivin arvot vanhoissa sarakkeissa, rivin `xmin` (ei UPDATEa) ja taulun `relfilenode` (ei uudelleenkirjoitusta) ennallaan jokaisen migraation yli. 0010: kaikki 5 tavoitteen tilaa × projekti kytketty/irti |
| Taaksepäin yhteensopivuus | Jokainen migraatio ajetaan edellisen aallon koodin ollessa tuotannossa. Jokaisessa tauossa elävän ja seuraavan aallon **oikeat** rivimuodot (sovelluksen omat rivimuunnokset, insert/update/upsert) menivät läpi, ja verify + seuraava preflight antoivat 0 FAIL |
| Verify-luku | `poikkeavia_yhteensa` laskee myös NULL-tuloksen (puuttuva objekti), ja details kertoo `toteutui null` |
| Peruutus | **Peruutus aina käänteisessä järjestyksessä: 0013 → 0012 → 0011 → 0010 → 0009.** Jokaisen migraation oma ROLLBACK-osio (tiedoston lopussa) palauttaa katalogin täsmälleen — todennettu myös datan kanssa ja koko ketjuna (0013…0009 → katalogi = tuotannon 0008, vanhat rivit ennallaan). 0012 kieltäytyy, jos 0013 on yhä ajettu; 0010 kieltäytyy, jos jokin tavoite on tilassa `maintenance`. **Peruutus poistaa uusien taulujen rivit**: sulje portit ensin (edellisen aallon deploy) |

**PYSÄYTYSEHDOT (kaikille):** preflight antaa yhdenkin FAIL-rivin ·
migraatio päättyy virheeseen (ei ole vaarallista — mikään ei muuttunut —
mutta älä yritä uudelleen ennen kuin syy on selvä) · verify antaa
`poikkeavia_yhteensa > 0` → **aallon commitia ei deployata**.

**Koneellinen luku (ACT-12):** liitetty preflight- tai verify-tulos
pisteytetään, ei lueta silmällä: `node tools/activation/score-sql-result.mjs
--sql=<tiedosto.sql> tulos.txt` (GO vain kun täsmälleen tiedoston omat
tarkistusnumerot on liitetty — numeroinnissa voi olla aukkoja, esim.
`verify_0013` — 0 FAIL ja `poikkeavia_yhteensa` = 0; todennettu oikean
kannan tuloksilla `tests/fixtures/sql-results`). Orkestroija tekee saman lipuilla
`--preflight-result=` ja `--verify-result=`. SQL-tiedostot ajetaan aina
**lukon SQL-lähteestä** (`docs/activation/release-train-c-j.json` →
`sqlSource`, sha256 jokaiselle tiedostolle); `npm run activation:dry-run`
tulostaa ajettavat tiedostot tiivisteineen.

---

## 0009 — Talous 2.0 (aalto F, v19)

| | |
|---|---|
| Tekee | Uudet taulut `transactions`, `investments`; `bills`-tauluun 3 nullable-saraketta (`payee`, `iban`, `reference`) |
| Elävät taulut | `bills` (ALTER, lyhyt ACCESS EXCLUSIVE -lukko), viittaus `auth.users` |
| Riski | Matala. Ei täyttöä, ei olemassa olevien rivien muutosta |
| Varmuuskopio | Suositeltava (Dashboard → Database → Backups, tämän päivän) |
| 1 Preflight | `supabase/preflight/preflight_0009.sql` → 0 FAIL (sisältää junan alun rivit 18–19: muut public-taulut kuin migraatioiden 26 (INFO) ja jokainen public-taulun vierasavain `auth.users`-tauluun CASCADE — `verify_0013`:n tilin poiston oletus tarkistetaan ennen junaa eikä vasta sen lopussa) |
| 2 Ajo | `supabase/migrations/0009_finance_2.sql` |
| 3 Verify | `supabase/verify/verify_0009.sql` → `poikkeavia_yhteensa = 0` (harjoitus: 29 PASS / 0 FAIL) |
| 4 Deploy | aalto F (`rehearsal/wave-f-v3`, ks. GO/NO-GO) |
| Hyväksyntädata | 1 tapahtuma (Talous → Tapahtumat), 1 sijoitus, 1 lasku maksutiedoilla (saaja, IBAN, viite) → F5 → säilyy |
| Peruutus | ROLLBACK-osio (poistaa `transactions`, `investments` ja 3 saraketta). Vasta kun 0010 on peruttu |

## 0010 — Tavoitteesta tekemiseksi (aalto G, v20) — **KORKEIN RISKI**

| | |
|---|---|
| Tekee | Uusi taulu `milestones`; **muuttaa eläviä tauluja**: `goals` +7 saraketta ja 4 rajoitetta, `goals_status_check` korvataan (sallii lisäksi `maintenance`), `tasks` +2 (`milestone_id`, `depends_on text[] not null default '{}'`), `projects` +1, `profile` +2 (`automation_level`, `planning_buffer_ratio`, oletusarvoin) |
| Elävät taulut | `goals`, `tasks`, `projects`, `profile` — kaikki auki tuotannossa ja niissä on oikeaa dataa; viittaus `auth.users` |
| Järjestys | 0a–0b vain katalogia lukevat esiehdot, uudelleenajon tunnistus (**"JO AJETTU"** / kesken, 38 objektia) ja `touch_updated_at` — **ennen lukitusta**, joten ne vastaavat heti eivätkä odota sovelluksen lukkoa → 0c `set local lock_timeout = '5s'` (5 s per lukon odotus; lock_timeout koskee jokaista lukkoa erikseen) ja lukitus → 0d omistajan rivi `auth.users`-taulussa ja 0e tavoitteiden tilat (rivien luku vasta lukituksen jälkeen) → vaihe 1: ensimmäinen DDL |
| Lukot | Neljä elävää taulua lukitaan **kerralla, kiinteässä järjestyksessä, ennen ensimmäistä rivien lukua ja ennen yhtäkään muutosta** (`lock table … in access exclusive mode`). Estäjä → 5 s ja peruutus ilman ainuttakaan DDL:ää (harjoitus: 8/8 estäjää goals/tasks/projects/profile × luku/kirjoitus; ennen tätä profile-estäjä ehti 42 DDL-komentoa). `depends_on` lisätään oletusarvolla ilman taulun uudelleenkirjoitusta |
| Epäonnistuminen kesken | Kokonaan peruuntuva transaktio; todennettu lukon aikakatkaisulla, lukkiutumisella (40P01) ja virheellä tilarajoitteen vaihdon jälkeen: tilarajoite palaa 0004:n viiden arvon versioksi |
| Olemassa oleva data | Jokainen nykyinen tavoitteen tila on uuden rajoitteen sallima (preflightin rivi 08). Harjoitus 10 muunnelmalla: yksikään vanha arvo ei muutu, yhtään riviä tai taulua ei kirjoiteta uudelleen; vanhoilla riveillä `depends_on = '{}'`, `automation_level = 1`, `planning_buffer_ratio = 0.25`, muut uudet sarakkeet null |
| Varmuuskopio | **PAKOLLINEN**, tänään otettu, aikaleima ylös ennen ajoa. Ohje ja palautus: `docs/activation/0010-BACKUP-AND-RECOVERY.md` |
| 1 Preflight | `supabase/preflight/preflight_0010.sql` → 0 FAIL (sisältää: jokaisen tavoitteen tila kelpaa, `goals_status_check` olemassa (rivi 09), omistaja-avaimet, lukitut taulut) |
| 2 Ajo | `supabase/migrations/0010_goal_to_action.sql` — **Panun erillinen hyväksyntä juuri tälle ajolle** |
| 3 Verify | `supabase/verify/verify_0010.sql` → 0 (harjoitus: 40 PASS / 0 FAIL; rivi 20 = tilarajoite olemassa) |
| 4 Deploy | aalto G (`rehearsal/wave-g-v3`) |
| Hyväksyntädata | 1 tavoite mittarilla (esim. paino 90→75 kg) + 1 välitavoite; 1 tehtävä, joka riippuu toisesta → F5 → säilyy; tavoitteen tila "Ylläpito" → F5 → säilyy |
| Peruutus | ROLLBACK-osio, vasta kun 0011 on peruttu. **Kieltäytyy heti**, jos jokin tavoite on tilassa `maintenance` (aalto G kirjoittaa niitä): viesti kertoo korjauslauseen `update public.goals set status = 'active' where status = 'maintenance';` — päätä ensin tila. Poistaa välitavoitteet ja tehtävien riippuvuudet |

## 0011 — Henkilökohtainen avustaja (aalto H, v21)

| | |
|---|---|
| Tekee | 5 uutta taulua (`inbox_items`, `reminders`, `notices`, `travel_plans`, `location_rules`); ei muuta yhtäkään olemassa olevaa taulua |
| Lukot | Lyhyt SHARE ROW EXCLUSIVE -lukko `tasks`- ja `auth.users`-tauluun vierasavainten luonnin ajan: sovelluksen luku ei estä, avoin kirjoitus estää (harjoitus) |
| Riski | Matala |
| 1 Preflight | `supabase/preflight/preflight_0011.sql` → 0 FAIL (sisältää: tasks/goals/projects = 12 politiikkaa, jonka migraatio vaatii ennen committia) |
| 2 Ajo | `supabase/migrations/0011_personal_assistant.sql` |
| 3 Verify | `supabase/verify/verify_0011.sql` → 0 (harjoitus: 55 PASS / 0 FAIL) |
| 4 Deploy | aalto H (`rehearsal/wave-h-v3`) |
| Hyväksyntädata | 1 kirjaus (inbox), 1 muistutus → F5 → säilyy; ilmoitus näkyy |
| Tunnettu rajoitus | Avustajan kirjaus vaatii yhteyden (offline-jono kattaa vain tehtävät) — epäonnistuu näkyvästi, ei valehtele |
| Peruutus | ROLLBACK-osio (poistaa 5 taulua), vasta kun 0012 on peruttu |

## 0012 — Suunta (aalto I, v22) — ensimmäinen Suunta-julkaisu

| | |
|---|---|
| Tekee | 4 uutta taulua (`life_areas`, `weekly_capacities`, `time_entries`, `alignment_reviews`) + `goals.life_area_id` (nullable, **ei oletusta, ei täyttöä**) |
| Elävät taulut | `goals` (1 sarake + vierasavain), lukko `tasks`-tauluun viiteavaimen ajan |
| Olemassa oleva data | Yhtäkään tavoitetta ei liitetä alueeseen (migraatio tarkistaa itse; harjoitus: 0). Vanhat tavoitteet/tehtävät/projektit/rutiinit toimivat ilman aluetta |
| Varmuuskopio | Suositeltava |
| 1 Preflight | `supabase/preflight/preflight_0012.sql` → 0 FAIL (sisältää: tasks/goals/projects = 12 politiikkaa) |
| 2 Ajo | `supabase/migrations/0012_life_alignment.sql` |
| 3 Verify | `supabase/verify/verify_0012.sql` → 0 (harjoitus: 45 PASS / 0 FAIL). **Tämä on ajettava ennen 0013:a** |
| 4 Deploy | aalto I (`rehearsal/wave-i-v1`) |
| Hyväksyntädata | 1 elämänalue, 1 viikkokapasiteetti, 1 tavoite liitettynä alueeseen, 1 kirjattu aika → F5 → säilyy |
| Peruutus | ROLLBACK-osio, **vasta kun 0013 on peruttu** — vartija kieltäytyy muuten (todennettu). Poistaa 4 taulua ja sarakkeen — kirjattu aika katoaa; sulje portit ja ota varmuuskopio ensin. Tavoitteiden muut sarakkeet säilyvät täsmälleen (todennettu liitetyllä tavoitteella) |

## 0013 — Suunta 2 (aalto J, v23)

| | |
|---|---|
| Tekee | 2 uutta taulua (`running_timers`: **yksi per käyttäjä**, `alignment_item_settings`); sarakkeita 0012:n tauluihin: `time_entries` +6 (`operation_id` uniikki per käyttäjä = idempotentti kirjaus, `started_at`/`ended_at`, projekti, rutiini, esiintymä), `weekly_capacities.energy_budget_minutes`, `alignment_reviews.policy_version`/`reflection_answers`; korvaa lähderajoitteen (`manual` → `manual`/`timer`) |
| Elävät taulut | Ei tuotannossa ennestään auki olevia (vain 0012:n omia); viittaukset `tasks`, `goals`, `projects`, `routines`, `life_areas`, `auth.users` |
| Todennettu | 1 ajastin/käyttäjä (23505 toiselle), sama `operation_id` hylätään, 0 ja 1441 min hylätään, loppu ennen alkua hylätään, tilin poisto poistaa kaiken; verify todistaa, että migraatioiden 26 taulun (tilin poiston kartta) jokainen vierasavain `auth.users`-tauluun on CASCADE ja jokaisella on sellainen (rivit 25–27). Muut public-taulut eivät kaada varmistusta: ne näkyvät rivillä 28 (INFO), ja `preflight_0009` on tarkistanut niiden vierasavaimet jo ennen junaa |
| 1 Preflight | `supabase/preflight/preflight_0013.sql` → 0 FAIL (sisältää: 8 taulun 32 politiikkaa) |
| 2 Ajo | `supabase/migrations/0013_alignment_reality.sql` |
| 3 Verify | `supabase/verify/verify_0013.sql` → 0 (harjoitus: 30 PASS / 0 FAIL) |
| 4 Deploy | aalto J (`rehearsal/wave-j-v1`) |
| Hyväksyntädata | 1 nopea kirjaus, 1 ajastinistunto (käynnistä → F5 → yhä käynnissä → pysäytä), 1 energia-arvio, 1 viikkokatsaus |
| Peruutus | ROLLBACK-osio, **aina ensimmäisenä**. Aja ensin osion vain lukeva ennakkokysely ja kirjaa luvut. Ajastinkirjausten lähde palautetaan `manual`:ksi, **kirjattu aika säilyy** (minuutit, päivä, alue-, tavoite- ja tehtäväkytkentä; todennettu rivi riviltä). **Kohdistus katoaa osittain:** projekti-, rutiini- ja esiintymäkytkentä sekä ajastimen alku/loppu ja `operation_id` pudotetaan; kirjaus, jonka ainoa kohde oli projekti tai rutiini, menettää kohdistuksensa kokonaan (ennakkokyselyn `menettaa_kohteen_kokonaan`) |

---

## Mitä tämä EI todista

- PostgREST/HTTP-kerrosta ei ajettu: kirjoitukset jäljiteltiin PostgREST 12:n
  SQL-muodolla samassa roolissa (`authenticated` + `request.jwt.claims`).
- Supabasen `postgres`-roolin tarkat oikeudet: harjoitus ajoi migraatiot
  superuserina ja NOSUPERUSER-omistajaroolina (molemmat läpi), mutta ei
  Supabasen roolina sellaisenaan (jäsenyydet, esim. `pg_read_all_stats`).
- Supabasen SQL-editorin käytös (monilauseisen tiedoston ajo, istunnon
  tila virheen jälkeen) — harjoitus käyttää yhtä simple-query-kutsua.
- Tuotannon tavoitteen tarkka tila ja projektin kytkentä (inventaario kertoo
  vain lukumäärät) — siksi kaikki 10 muunnelmaa.
