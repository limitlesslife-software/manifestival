# Migraatiopaketit 0009–0015

Jokainen migraatio on **oma pakettinsa ja oma hyväksyntänsä**. Niitä ei
koskaan niputeta yhteen SQL-ajoon. Järjestys on 0009 → 0010 → 0011 → 0012 →
0013 → 0014 → 0015, ja jokaisen välissä on sen aallon deploy ja hyväksyntä
(`docs/SUUNTA-ACTIVATION-GO-NOGO.md`; aalto K: `docs/acceptance/WAVE-K.md`;
aalto L: `docs/acceptance/WAVE-L.md`).

Kaikki alla on harjoiteltu **oikealla PostgreSQL 17:llä** (17.10; tuotanto
17.6) tuotannon muotoisesta tilasta 0008, joka vastaa omistajan
inventaariota 2026-09-26 täsmälleen (1 auth-käyttäjä = omistaja, 36
tehtävää `date`/`time` tekstinä, 1 profiili, 1 tavoite, 1 projekti, 1
muistutusasetus, 1 hyvinvointimerkintä, muut taulut tyhjiä):
`tools/pg-rehearsal`, tulokset `docs/activation/REHEARSAL-REPORT.md`,
skeemaerot `docs/activation/SCHEMA-DIFFS-0009-0015.md`.

## Lähde: mistä SQL kopioidaan

Kopioi jokainen preflight-, migraatio- ja verify-tiedosto
**tuotehaarasta `feature/life-alignment-foundation`** (se commit, jossa
tiivisteet täsmäävät alla olevaan taulukkoon, tai uudempi, jossa
taulukko on päivitetty). Tarkista ennen ajoa:

```sh
git hash-object supabase/migrations/0010_goal_to_action.sql   # = taulukon arvo
```

**Älä kopioi aaltojen ehdokashaaroista** (`rehearsal/wave-f-v4` …
`rehearsal/wave-i-v3`): niissä aallon OMA migraatiotiedosto on tavu
tavulta sama kuin lukon SQL-lähteessä (`rehearsal/wave-j-v2`,
orkestroijan esitarkistus vertaa), mutta 0009–0014:n preflight- ja
verify-tiedostot puuttuvat niistä tai ovat vanhempia. Vanhat leikkaukset
(`wave-g-v3`/`-v4`, `wave-i-v1`/`-v2`, `wave-j-v1`) sisältävät 0010:n,
0012:n ja 0013:n vanhemman version (blobit `7e16f52d…`, `59061f2e…`,
`b7ae23e9…`). Aallon *sovelluskoodi* deployataan ehdokashaarasta; SQL
ajetaan aina tästä taulukosta. 0014 on tuotehaarassa
`feature/daily-life-operating-system` (aalto K on lukittu, lukon SQL-lähde
on K). 0015 on tuotehaarassa `feature/mental-load-core` (aaltoa L ei ole
vielä leikattu eikä lukittu: lukon SQL-lähde on yhä K).

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
| 0014 | `supabase/preflight/preflight_0014.sql` | `590ccb549225151cc13418cbe594e1280cab6778` |
| 0014 | `supabase/migrations/0014_daily_life.sql` | `457150dfa00b3f008d55c2ece454a2323fb69f35` |
| 0014 | `supabase/verify/verify_0014.sql` | `4db67930ccffd779d26cedf66e48d94d244b1156` |
| 0015 | `supabase/preflight/preflight_0015.sql` | `6b06b2a5b25ca79f0809c0cdfe4d8f84b1465df4` |
| 0015 | `supabase/migrations/0015_mental_load.sql` | `f45ae940c9acdb4f4eb2e4907eb7ef8f8084e9df` |
| 0015 | `supabase/verify/verify_0015.sql` | `6bcde496a7a20f3aebf7d92174e8e4fb9e423e23` |
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
| Peruutus | **Peruutus aina käänteisessä järjestyksessä: 0015 → 0014 → 0013 → 0012 → 0011 → 0010 → 0009.** Jokaisen migraation oma ROLLBACK-osio (tiedoston lopussa) palauttaa katalogin täsmälleen — todennettu myös datan kanssa ja koko ketjuna (0014…0009 → katalogi = tuotannon 0008, vanhat rivit ennallaan). 0012 kieltäytyy, jos 0013 on yhä ajettu; **0013:lla ei ole vastaavaa vartijaa 0014:ää vastaan** (0013 on lukittu) — sen peruutus menee läpi 0014:n ollessa ajettu, joten järjestyksestä on huolehdittava itse (inventaario pysäyttää sellaisen tilan); 0010 kieltäytyy, jos jokin tavoite on tilassa `maintenance`. **Peruutus poistaa uusien taulujen rivit**: sulje portit ensin (edellisen aallon deploy) |

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
| 4 Deploy | aalto G (`rehearsal/wave-g-v5`) |
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
| 4 Deploy | aalto H (`rehearsal/wave-h-v5`) |
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
| 4 Deploy | aalto I (`rehearsal/wave-i-v3`) |
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
| 4 Deploy | aalto J (`rehearsal/wave-j-v2`) |
| Hyväksyntädata | 1 nopea kirjaus, 1 ajastinistunto (käynnistä → F5 → yhä käynnissä → pysäytä), 1 energia-arvio, 1 viikkokatsaus |
| Peruutus | ROLLBACK-osio, **vasta kun 0014 on peruttu** (ei vartijaa: tarkista itse, ettei `saved_places` ole olemassa). Aja ensin osion vain lukeva ennakkokysely ja kirjaa luvut. Ajastinkirjausten lähde palautetaan `manual`:ksi, **kirjattu aika säilyy** (minuutit, päivä, alue-, tavoite- ja tehtäväkytkentä; todennettu rivi riviltä). **Kohdistus katoaa osittain:** projekti-, rutiini- ja esiintymäkytkentä sekä ajastimen alku/loppu ja `operation_id` pudotetaan; kirjaus, jonka ainoa kohde oli projekti tai rutiini, menettää kohdistuksensa kokonaan (ennakkokyselyn `menettaa_kohteen_kokonaan`) |

## 0014 — Arjen käyttöjärjestelmä (aalto K, v24)

| | |
|---|---|
| Tekee | 10 uutta taulua (`saved_places`, `place_aliases`, `calendar_events`, `commute_observations`, `life_settings`: **yksi per käyttäjä**, `sleep_logs`, `habit_plans`, `habit_events`, `exercise_sessions`, `wellbeing_checkins`); **ei muuta yhtäkään olemassa olevaa taulua, saraketta, rajoitetta tai riviä**; ei sarakeportteja. Ei koordinaatteja eikä sijaintihistoriaa |
| Elävät taulut | Ei yhtään muutettavaa. Viittaukset `goals` (menon ja liikuntakerran tavoitekytkentä) ja `auth.users` |
| Lukot | Lyhyt SHARE ROW EXCLUSIVE -lukko `goals`- ja `auth.users`-tauluun vierasavainten luonnin ajan: sovelluksen **luku ei estä** (ajo läpi lukukyselyn aikana), avoin **kirjoitus estää** → 5 s ja kokonainen peruutus (harjoitus: estäjämatriisi 4/4, uusi ajo läpi lukon vapauduttua) |
| Uudelleenajo | "JO AJETTU" (153 objektia) katalogista ennen yhtäkään DDL:ää — heti myös sovelluksen `goals`-kirjoituksen aikana |
| Riski | Matala. Varmuuskopio ei pakollinen (vain uusia tyhjiä tauluja); tilan 0013 tilannekuva on hyvä tapa |
| Omistajuus | Kuusi yhdistelmävierasavainta `(user_id, x)`: toisen käyttäjän paikkaan, tavoitteeseen tai suunnitelmaan ei voi viitata (23503, todennettu). Paikan tai tavoitteen poisto nollaa **vain** oman viitesarakkeensa (`on delete set null (place_id)` / `(goal_id)`): meno ja liikuntakerta jäävät omistajalleen. Lisänimet, havainnot ja tapojen kirjaukset poistuvat vanhempansa mukana. `commute_observations.event_id` ei ole vierasavain |
| 1 Preflight | `supabase/preflight/preflight_0014.sql` → 0 FAIL (sisältää: 0013 kokonaan ajettu (46 objektia), `goals_owner_row_key`, vanhojen 10 taulun 40 politiikkaa, jotka migraatio vaatii ennen committia, 0/153 omaa objektia, lukitut taulut `goals`/`auth.users`) |
| 2 Ajo | `supabase/migrations/0014_daily_life.sql` — omistajan hyväksyntä "hyväksyn 0014/K" |
| 3 Verify | `supabase/verify/verify_0014.sql` → 0 (harjoitus: 39 PASS / 0 FAIL, 11 INFO; rivit 34–35 = migraatioiden 36 taulun tilin poiston cascade, rivi 36 INFO muut taulut) |
| 4 Deploy | aalto K (v24; ehdokashaara rakennetaan J v2:n `cba9463` päälle) |
| Hyväksyntädata | 1 paikka + lisänimi, 1 toistuva meno paikalla ja tavoitteella, 1 koko päivän meno, 1 kuitattu matka, arjen asetukset, 1 unikirjaus, 1 tapasuunnitelma + kirjaus, 1 liikuntakerta, 1 motivaatio/hallinta → F5 → säilyy |
| Peruutus | ROLLBACK-osio, **aina ensimmäisenä** (ennen 0013:a): pudottaa kymmenen taulua lapsista vanhempiin ilman cascadea. **Poistaa arjen rivit pysyvästi** — sulje portit ensin (aallon K revert aaltoon J) ja ota tilannekuva `supabase/backup/snapshot_state_0014.sql`. Todennettu aallon K datalla: katalogi = tila 0013, vanhat rivit ennallaan, `verify_0013` 0 FAIL, uusi ajo läpi. **Vasta kun 0015 on peruttu**: 0014:llä ei ole 0015-vartijaa (0014 on lukittu), ja inventaario pysäyttää väärän järjestyksen (todennettu) |

## 0015 — Mielen kuorman keventäminen (aalto L, v25)

| | |
|---|---|
| Tekee | 2 uutta taulua (`protected_periods`, `weekly_plans`); **MUUTTAA `tasks`-taulua** (6 saraketta: `horizon`, `waiting_on`, `follow_up_date`, `archived_at`, `reschedule_count` not null default 0, `original_date`; `date` drop not null) ja `life_areas`-taulua (`kind` not null default 'STANDARD'; `life_areas_category_unique` pois, tilalle ei-uniikki `life_areas_user_category_idx`). Sarakeportti `MENTAL_LOAD_FIELDS`. 47 objektia |
| Elävät taulut | `tasks` (tuotannossa auki) ja `life_areas` (0012). **Ei yhtäkään rivin uudelleenkirjoitusta** (vakio-oletukset; `xmin` ja `relfilenode` ennallaan, todennettu molemmilla lähtötiloilla) |
| Lukot | `tasks` ja `life_areas` ACCESS EXCLUSIVE **kerralla ennen yhtäkään muutosta**: jo sovelluksen lukukysely estää → 5 s ja kokonainen peruutus, 0 DDL-komentoa ennen odotusta. `auth.users` SHARE ROW EXCLUSIVE viimeisenä (uusien taulujen omistaja-avain): vain kirjoitus estää (harjoitus: estäjämatriisi 6/6) |
| Uudelleenajo | "JO AJETTU" (47 objektia) katalogista ennen lukitusta — heti myös sovelluksen `tasks`-kirjoituksen aikana. HUOM. 0012:n uudelleenajo 0015:n jälkeen sanoo "kesken: 56/58" (0015 poisti 0012:n rajoitteen) ja kaatuu kiinni; inventaario tuntee luvun |
| Riski | Keski. **Tuore varmuuskopio pakollinen** (`snapshot_state_0014.sql`) |
| Omistajuus | Ei uusia viitteitä sovellustauluihin; uusien taulujen omistaja-avain auth.usersiin on CASCADE. Viikon prioriteetti on viittaus (`task:<id>`), ei vierasavain: toisen käyttäjän tunniste ei avaa hänen riviään (RLS, todennettu liitoskyselyllä) |
| 1 Preflight | `supabase/preflight/preflight_0015.sql` → 0 FAIL (sisältää: 0014 kokonaan ajettu (153), `life_areas_category_unique` olemassa, RLS tasks/life_areas, vanhojen 20 taulun 80 politiikkaa, 0/47 omaa objektia, lukitut taulut `tasks`/`life_areas`/`auth.users`; INFO: `tasks.date` NOT NULL ennen 0015:tä ja tyyppi) |
| 2 Ajo | `supabase/migrations/0015_mental_load.sql` — omistajan hyväksyntä "hyväksyn 0015/L" |
| 3 Verify | `supabase/verify/verify_0015.sql` → 0 (harjoitus: 34 PASS / 0 FAIL, 6 INFO; rivit 31–32 = migraatioiden 38 taulun tilin poiston cascade, rivi 33 INFO muut taulut) |
| 4 Deploy | aalto L (v25; ehdokashaara rakennetaan K v1:n `d11d8b4` päälle) |
| Hyväksyntädata | 1 päivätön "myöhemmin"-tehtävä, 1 odottava (kenen varassa + tarkistuspäivä), 1 arkistoitu, suojattu ilta + loma + viikon vähimmäisvapaa-aika, 1 viikkosuunnitelma (≤ 3 prioriteettia, suljettu), 2 aluetta samalla kategorialla → F5 → säilyy |
| Peruutus | ROLLBACK-osio, **aina ensimmäisenä** (ennen 0014:ää): vartija kaatuu kiinni, jos kaksi aluetta jakaa kategorian (todennettu); pudottaa kaksi taulua ja seitsemän saraketta, palauttaa `life_areas_category_unique`. `tasks.date`-sarakkeen NOT NULL -ehtoa **ei** palauteta (`docs/MIGRATION-0015-RECOVERY.md` §4). Todennettu aallon L datalla: katalogi = tila 0014, vanhat rivit ennallaan, `verify_0014` 0 FAIL, uusi ajo läpi |

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
