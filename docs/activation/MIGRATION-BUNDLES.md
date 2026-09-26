# Migraatiopaketit 0009–0013

Jokainen migraatio on **oma pakettinsa ja oma hyväksyntänsä**. Niitä ei
koskaan niputeta yhteen SQL-ajoon. Järjestys on 0009 → 0010 → 0011 → 0012 →
0013, ja jokaisen välissä on sen aallon deploy ja hyväksyntä
(`docs/SUUNTA-ACTIVATION-GO-NOGO.md`).

Kaikki alla on harjoiteltu **oikealla PostgreSQL 17.10:llä** tuotannon
muotoisesta lähtötilasta (ennen 0001:tä: 36 tehtävää, `profile` = `'me'`)
molemmilla `tasks.date`-tyypeillä: `tools/pg-rehearsal`,
`docs/activation/REHEARSAL-REPORT.md`.

## Yhteiset säännöt

| Asia | Sääntö |
|---|---|
| Missä ajetaan | Supabase → SQL Editor → **uusi välilehti**, postgres-rooli, ei muita avoimia välilehtiä |
| Miten | Liitä **koko** tiedosto, ei valintaa, Run |
| Transaktio | Jokainen migraatio on yksi `begin … commit`. Kesken kaatunut ajo **perutaan kokonaan** — todennettu: katalogi täsmälleen ennallaan jokaisessa virhetilanteessa (31/31) |
| Lukot | `set local lock_timeout = '5s'`: jos sovelluksen pyyntö pitää lukkoa, migraatio luovuttaa 5 s:ssa ja peruuntuu kokonaan. Todennettu: lukon vapauduttua uusi ajo menee läpi |
| Uudelleenajo | Kaatuu kiinni viestillä **"JO AJETTU"** (korjattu tänä yönä 0010/0011/0012:ssa, jotka sanoivat virheellisesti "kesken") |
| Taaksepäin yhteensopivuus | Jokainen migraatio ajetaan edellisen aallon koodin ollessa tuotannossa. Vanhan koodin rivimuodot ovat yhä kirjoitettavissa 0013:n jälkeen (todennettu) |
| Peruutus | Jokaisen migraation oma ROLLBACK-osio (tiedoston lopussa) palauttaa skeeman täsmälleen — todennettu 5/5. **Peruutus poistaa uusien taulujen rivit**: sulje portit ensin (edellisen aallon deploy) |

**PYSÄYTYSEHDOT (kaikille):** preflight antaa yhdenkin FAIL-rivin ·
migraatio päättyy virheeseen (ei ole vaarallista — mikään ei muuttunut —
mutta älä yritä uudelleen ennen kuin syy on selvä) · verify antaa
`poikkeavia_yhteensa > 0` → **aallon commitia ei deployata**.

**Koneellinen luku (ACT-12):** liitetty preflight- tai verify-tulos
pisteytetään, ei lueta silmällä: `node tools/activation/score-sql-result.mjs
--sql=<tiedosto.sql> tulos.txt` (GO vain kun jokainen rivi on liitetty, 0 FAIL
ja `poikkeavia_yhteensa` = 0). Orkestroija tekee saman lipuilla
`--preflight-result=` ja `--verify-result=`. SQL-tiedostot ajetaan aina
**lukon SQL-lähteestä** (`docs/activation/release-train-c-j.json` →
`sqlSource`, sha256 jokaiselle tiedostolle); `npm run activation:dry-run`
tulostaa ajettavat tiedostot tiivisteineen.

---

## 0009 — Talous 2.0 (aalto F, v19)

| | |
|---|---|
| Tekee | Uudet taulut `transactions`, `investments`; `bills`-tauluun 3 nullable-saraketta (`payee`, `iban`, `reference`) |
| Elävät taulut | `bills` (ALTER, lyhyt ACCESS EXCLUSIVE -lukko) |
| Riski | Matala. Ei täyttöä, ei olemassa olevien rivien muutosta |
| Varmuuskopio | Suositeltava (Dashboard → Database → Backups, tämän päivän) |
| 1 Preflight | `supabase/preflight/preflight_0009.sql` → 0 FAIL |
| 2 Ajo | `supabase/migrations/0009_finance_2.sql` |
| 3 Verify | `supabase/verify/verify_0009.sql` → `poikkeavia_yhteensa = 0` (harjoitus: 29 PASS / 0 FAIL) |
| 4 Deploy | aalto F (`rehearsal/wave-f-v3`, ks. GO/NO-GO) |
| Hyväksyntädata | 1 tapahtuma (Talous → Tapahtumat), 1 sijoitus, 1 lasku maksutiedoilla (saaja, IBAN, viite) → F5 → säilyy |
| Peruutus | ROLLBACK-osio (poistaa `transactions`, `investments` ja 3 saraketta) |

## 0010 — Tavoitteesta tekemiseksi (aalto G, v20) — **KORKEIN RISKI**

| | |
|---|---|
| Tekee | Uusi taulu `milestones`; **muuttaa eläviä tauluja**: `goals` +7 saraketta ja 4 rajoitetta, `goals_status_check` korvataan (sallii lisäksi `maintenance`), `tasks` +2 (`milestone_id`, `depends_on text[] not null default '{}'`), `projects` +1, `profile` +2 (`automation_level`, `planning_buffer_ratio`, oletusarvoin) |
| Elävät taulut | `goals`, `tasks`, `projects`, `profile` — kaikki auki tuotannossa ja niissä on oikeaa dataa |
| Lukot | ACCESS EXCLUSIVE neljään tauluun ajon ajaksi (sekunteja pienellä datalla). `depends_on` lisätään oletusarvolla ilman taulun uudelleenkirjoitusta (PostgreSQL 11+) |
| Epäonnistuminen kesken | Kokonaan peruuntuva transaktio; todennettu myös lukon aikakatkaisulla |
| Olemassa oleva data | Jokainen nykyinen tavoitteen tila on uuden rajoitteen sallima (preflightin rivi tarkistaa sen tuotannosta). Harjoitus: vanhat tavoitteet, projektit ja tehtävät säilyivät, vanhan koodin kirjoitukset toimivat 0010:n jälkeen |
| Varmuuskopio | **PAKOLLINEN**, tänään otettu, aikaleima ylös ennen ajoa |
| 1 Preflight | `supabase/preflight/preflight_0010.sql` → 0 FAIL (sisältää: jokaisen tavoitteen tila kelpaa, `goals_status_check` olemassa, omistaja-avaimet) |
| 2 Ajo | `supabase/migrations/0010_goal_to_action.sql` — **Panun erillinen hyväksyntä juuri tälle ajolle** |
| 3 Verify | `supabase/verify/verify_0010.sql` → 0 (harjoitus: 40 PASS / 0 FAIL) |
| 4 Deploy | aalto G (`rehearsal/wave-g-v3`) |
| Hyväksyntädata | 1 tavoite mittarilla (esim. paino 90→75 kg) + 1 välitavoite; 1 tehtävä, joka riippuu toisesta → F5 → säilyy; tavoitteen tila "Ylläpito" → F5 → säilyy |
| Peruutus | ROLLBACK-osio. **Epäonnistuu tarkoituksella**, jos jokin tavoite on tilassa `maintenance` — päätä ensin sen tila. Poistaa välitavoitteet ja tehtävien riippuvuudet |

## 0011 — Henkilökohtainen avustaja (aalto H, v21)

| | |
|---|---|
| Tekee | 5 uutta taulua (`inbox_items`, `reminders`, `notices`, `travel_plans`, `location_rules`); ei muuta yhtäkään olemassa olevaa taulua |
| Lukot | Lyhyt lukko `tasks`-tauluun vierasavainten luonnin ajan (ei rivimuutoksia) |
| Riski | Matala |
| 1 Preflight | `supabase/preflight/preflight_0011.sql` → 0 FAIL |
| 2 Ajo | `supabase/migrations/0011_personal_assistant.sql` |
| 3 Verify | `supabase/verify/verify_0011.sql` → 0 (harjoitus: 55 PASS / 0 FAIL). **Korjattu tänä yönä:** tarkistus 12 hälytti aiemmin väärin sarakkeesta `reminders.escalate` |
| 4 Deploy | aalto H (`rehearsal/wave-h-v3`) |
| Hyväksyntädata | 1 kirjaus (inbox), 1 muistutus → F5 → säilyy; ilmoitus näkyy |
| Tunnettu rajoitus | Avustajan kirjaus vaatii yhteyden (offline-jono kattaa vain tehtävät) — epäonnistuu näkyvästi, ei valehtele |
| Peruutus | ROLLBACK-osio (poistaa 5 taulua) |

## 0012 — Suunta (aalto I, v22) — ensimmäinen Suunta-julkaisu

| | |
|---|---|
| Tekee | 4 uutta taulua (`life_areas`, `weekly_capacities`, `time_entries`, `alignment_reviews`) + `goals.life_area_id` (nullable, **ei oletusta, ei täyttöä**) |
| Elävät taulut | `goals` (1 sarake + vierasavain), lukko `tasks`-tauluun viiteavaimen ajan |
| Olemassa oleva data | Yhtäkään tavoitetta ei liitetä alueeseen (migraatio tarkistaa itse; harjoitus: 0). Vanhat tavoitteet/tehtävät/projektit/rutiinit toimivat ilman aluetta |
| Varmuuskopio | Suositeltava |
| 1 Preflight | `supabase/preflight/preflight_0012.sql` → 0 FAIL |
| 2 Ajo | `supabase/migrations/0012_life_alignment.sql` |
| 3 Verify | `supabase/verify/verify_0012.sql` → 0 (harjoitus: 45 PASS / 0 FAIL). **Tämä on ajettava ennen 0013:a** |
| 4 Deploy | aalto I (`rehearsal/wave-i-v1`) |
| Hyväksyntädata | 1 elämänalue, 1 viikkokapasiteetti, 1 tavoite liitettynä alueeseen, 1 kirjattu aika → F5 → säilyy |
| Peruutus | ROLLBACK-osio (poistaa 4 taulua ja sarakkeen — kirjattu aika katoaa; sulje portit ja ota varmuuskopio ensin) |

## 0013 — Suunta 2 (aalto J, v23)

| | |
|---|---|
| Tekee | 2 uutta taulua (`running_timers`: **yksi per käyttäjä**, `alignment_item_settings`); sarakkeita 0012:n tauluihin: `time_entries` +6 (`operation_id` uniikki per käyttäjä = idempotentti kirjaus, `started_at`/`ended_at`, projekti, rutiini, esiintymä), `weekly_capacities.energy_budget_minutes`, `alignment_reviews.policy_version`/`reflection_answers`; korvaa lähderajoitteen (`manual` → `manual`/`timer`) |
| Elävät taulut | Ei tuotannossa ennestään auki olevia (vain 0012:n omia) |
| Todennettu | 1 ajastin/käyttäjä (23505 toiselle), sama `operation_id` hylätään, 0 ja 1441 min hylätään, loppu ennen alkua hylätään, tilin poisto poistaa kaiken |
| 1 Preflight | `supabase/preflight/preflight_0013.sql` → 0 FAIL |
| 2 Ajo | `supabase/migrations/0013_alignment_reality.sql` |
| 3 Verify | `supabase/verify/verify_0013.sql` → 0 (harjoitus: 27 PASS / 0 FAIL) |
| 4 Deploy | aalto J (`rehearsal/wave-j-v1`) |
| Hyväksyntädata | 1 nopea kirjaus, 1 ajastinistunto (käynnistä → F5 → yhä käynnissä → pysäytä), 1 energia-arvio, 1 viikkokatsaus |
| Peruutus | ROLLBACK-osio: ajastinkirjausten lähde palautetaan `manual`:ksi, **kirjattu aika säilyy** |

---

## Mitä tämä EI todista

- PostgREST/HTTP-kerrosta ei ajettu (RLS todennettu samalla mekanismilla,
  jota PostgREST käyttää: rooli + `request.jwt.claims`).
- Harjoitus ajoi migraatiot superuserina; Supabasen `postgres` ei ole
  superuser. Migraatiot eivät vaadi superuser-oikeuksia.
- Tuotannon PostgreSQL-versio ja `tasks.date`-tyyppi selviävät vasta
  inventaariosta (`supabase/acceptance/activation_readonly_inventory.sql`).
