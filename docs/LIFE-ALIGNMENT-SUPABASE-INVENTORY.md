# Life Alignment — Supabase-inventaario

**Päivitetty:** 2026-09-24 · haara `feature/life-alignment-foundation`

## Miten tämä on koottu

**Rekonstruoitu repositoriosta, EI live-kannasta.** Migraatiot 0001–0011,
`src/data/collectionsRepo.js`, `src/data/schema.js`, `src/lib/rows.js`,
domain-normalisoinnit ja staattiset testit (`tests/migrations.test.mjs`).

Live-introspektiota ei tehty: sovelluksessa on vain julkinen anon-avain,
jonka RLS rajaa käyttäjän omiin riveihin, eikä katalogikyselyjä voi ajaa
sillä. Palvelinavainta ei käytetä eikä tuotantoon lähetetty yhtään kyselyä.

Tuotannon todellinen tila todennetaan käsin ajettavalla, **vain lukevalla**
skriptillä `supabase/acceptance/life_alignment_readonly_inventory.sql`
(16 kyselyä; vain rakenne, lukumäärät ja NULL-osuudet — ei sisältöä).
Testi vartioi, että jokainen lause on `select`/lukeva `with`.

### Tuotanto vs. tämä haara

`docs/PRODUCTION-STATUS.md` + `git show origin/main:src/data/schema.js`:

| Migraatio | Tuotannossa | Portit `origin/main`issa |
|---|---|---|
| 0001–0002 | AJETTU | tasks, profile, laajennetut tehtäväkentät auki |
| 0003–0006 | AJETTU | routines, routine_exceptions, goals, projects, notification_preferences, wellbeing **auki** |
| 0007–0008 | AJETTU | bills, recurring_expenses, savings_goals, ai_action_audit **kiinni** |
| 0009–0011 | EI AJETTU | — |
| 0012 (tämä paketti) | EI AJETTU, EI SAA AJAA ilman hyväksyntää | — |

Tämä kehityshaara erkani ennen aaltoja A–B, joten sen `TABLES`-portit ovat
kaikki `false`. Se on tunnettu ja dokumentoitu (`docs/RELEASE-SEQUENCING.md`).
Seuraava vapaa migraationumero tarkistettiin **kaikista** paikallisista ja
etähaaroista: suurin on 0011 → **0012 on vapaa**.

**Tuotannossa on oikeaa dataa** (`tasks`, `goals`, `projects`, `routines`,
`wellbeing_entries`). Uusi skeema ei saa vaatia täyttöä eikä rikkoa
liittämätöntä vanhaa dataa.

---

## Taulut

Kaikissa taulussa: `user_id uuid not null default auth.uid() references
auth.users(id) on delete cascade`, RLS päällä, neljä `authenticated`-
politiikkaa (`auth.uid() = user_id`), ei anon-oikeuksia. Poikkeukset
mainittu. "Yhd. FK" = yhdistelmävierasavain `(user_id, x) -> t (user_id, id)`,
joka estää ristiinkiinnityksen toisen käyttäjän riviin (FK-tarkistus ei
kulje RLS:n läpi).

| Taulu | Tarkoitus | PK | Vierasavaimet | Käyttö nyt | Merkitys Life Alignmentille | Päätös |
|---|---|---|---|---|---|---|
| `tasks` | Tehtävät | `id text` (+ `tasks_owner_row_key`) | `goal_id`, `project_id` (0004), `milestone_id` (0010) yhd. FK, `on delete set null (sarake)` | Ydin, tuotannossa | **Suunniteltu työ.** `date` = viikko, `duration_minutes`/`time–end_time` = arvio, `completed` = valmis, `goal_id`/`project_id` = liitos, `category` = kiinteä luokka | **REUSE** (ei muutoksia) |
| `goals` | Tavoitteet | `id text` (+ owner key) | `parent_goal_id`, `project_id` yhd. FK | Tuotannossa | **Tavoitteet → elämänalue.** `priority` (korkea/normaali/matala) = tavoitteen tärkeys; `status` (paused ym.) = keskeytys | **EXTEND:** `life_area_id` (0012) |
| `projects` | Projektit | `id text` (+ owner key) | `goal_id` yhd. FK | Tuotannossa | Perii elämänalueen tavoitteeltaan | **REUSE** |
| `routines` | Toistuvat rutiinit | `id text` (+ owner key) | `goal_id` yhd. FK (0004) | Tuotannossa | **Suunniteltu toistuva työ.** `duration_minutes NOT NULL` (rutiinilla on aina kesto), esiintymät johdetaan säännöstä | **REUSE** |
| `routine_exceptions` | Rutiinin päiväpoikkeus (skip/reschedule/override) | `id text` | `(user_id, routine_id)` cascade | Tuotannossa | Ohitettu esiintymä ei ole suunniteltua työtä; override muuttaa kestoa | **REUSE** |
| `milestones` (0010) | Välitavoitteet | `id text` | `goal_id` yhd. FK cascade | EI AJETTU | Ei tarvita elämänalueeseen (kulkee tavoitteen kautta) | **LEAVE ALONE** |
| `profile` | Käyttäjäprofiili | `id uuid` = käyttäjä | auth.users | Tuotannossa | `planning_buffer_ratio` (0010) on päiväkapasiteetin puskuri, **ei** viikkokapasiteetti | **LEAVE ALONE** |
| `wellbeing_entries` | Päivän energia/mieliala/stressi/uni 1–5 | `id text`, uniikki `(user_id, date)` | — | Tuotannossa | **Tuleva energiadatan lähde** (toteutunut energia). Ei käytetä tässä viipaleessa | **LEAVE ALONE** (laajennuspiste) |
| `notification_preferences` | Muistutusasetukset | `id uuid` = käyttäjä | auth.users | Tuotannossa | Ei suoraa | **LEAVE ALONE** |
| `bills`, `recurring_expenses`, `savings_goals` (0007) | Talous | `id text` | `bills.task_id` yhd. FK | Ajettu, portit kiinni | **Tuleva rahan sitoumusten lähde** | **LEAVE ALONE** |
| `transactions`, `investments` (0009) | Talous 2.0 | `id text` | — | EI AJETTU | **Tuleva rahan toteuman lähde** | **LEAVE ALONE** |
| `ai_action_audit` (0008) | AI-komentojen kirjausketju | `id text` | `target_id` EI FK (tarkoituksella) | Ajettu, portti kiinni | Ei | **LEAVE ALONE** |
| `inbox_items`, `reminders`, `notices`, `travel_plans`, `location_rules` (0011) | Avustaja | `id text` | `travel_plans/location_rules.task_id` yhd. FK | EI AJETTU | `travel_plans.travel_minutes` voisi joskus olla osa suunniteltua aikaa — ei tässä | **LEAVE ALONE** |

### Tärkeät olemassa olevat suhteet

```
tasks.goal_id ───────────────► goals
tasks.project_id ─► projects.goal_id ─► goals
routines.goal_id ────────────► goals
goals.parent_goal_id ────────► goals          (hierarkia, sykli estetty domainissa)
tasks.category / routines.category / goals.category / projects.category
                              = kiinteä avain src/domain/categories.js
                                (tyo, perhe, hyvinvointi, harrastus, koti, kehitys, talous, muu)
```

---

## Vaihe B: mitä on jo, mitä puuttuu

| Tarve | Onko kannassa? | Päätös |
|---|---|---|
| Tavoitteen omistajuus | `goals.user_id` + RLS | Käytetään |
| Tavoitteen tärkeys | `goals.priority` (3 tasoa) | **Käytetään** tavoitteen tärkeytenä. Ei uutta kenttää |
| Tavoitteen tila / keskeytys | `goals.status` (`paused`) | Käytetään ("keskeytä tavoite" -ehdotus) |
| Tehtävä → tavoite | `tasks.goal_id` | Käytetään (periytyminen) |
| Projekti → tavoite | `projects.goal_id` | Käytetään (periytyminen) |
| Rutiini → tavoite | `routines.goal_id` | Käytetään (periytyminen) |
| Arvioitu kesto | `tasks.duration_minutes` / `time`+`end_time`; `routines.duration_minutes` | Käytetään. **Puuttuva kesto = TUNTEMATON**, ei nolla eikä oletus |
| Aikataulutettu päivä | `tasks.date`; rutiinin esiintymät johdetaan | Käytetään |
| Valmistumisaika | **EI** (`completed` on totuusarvo; `updated_at` ei ole valmistumishetki) | Ei päätellä. Valmistuminen ≠ toteutunut aika |
| Toteutunut kesto | **EI** | **UUSI:** `time_entries` (käyttäjän kirjaama aika) |
| Elämänalue käyttäjän omana käsitteenä | **EI** (kategoriat ovat kiinteä globaali lista) | **UUSI:** `life_areas` |
| Tavoite → elämänalue | **EI** | **UUSI sarake:** `goals.life_area_id` (nullable, yhd. FK) |
| Liittämätön tehtävä/rutiini → elämänalue | Vain kiinteä `category` | **Käytetään kategoriaa:** `life_areas.category_key` kytkee alueen olemassa olevaan kategoriaan. Ei uutta saraketta tehtäviin/rutiineihin |
| Viikkokapasiteetti | **EI** (`capacity.js` laskee päiväkapasiteetin herätys–nukkumaan-ikkunasta; `planning_buffer_ratio` on ajamatta) | **UUSI:** `weekly_capacities` |
| Energia/kuorma | `wellbeing_entries.energy` (toteutunut päivän energia) | Viikon arvio `weekly_capacities.energy_level` (valinnainen). Hyvinvointi on laajennuspiste |
| Viikkokatsauksen historia | **EI** (`review.js` laskee lennosta) | **UUSI:** `alignment_reviews` (versioitu tiivis tilannekuva) |

**Miksi kategoria eikä uusi `tasks.life_area_id`:** jokaisella olemassa olevalla
tehtävällä ja rutiinilla on jo kategoria. Kun käyttäjä kytkee alueensa
"Perhe" kategoriaan `perhe`, vanha data tulee näkyviin ilman yhtään täyttöä
tai muutosta `tasks`-tauluun, joka on tuotannon suurin ja käytetyin taulu.
Tehtäviin tai rutiineihin ei tarvita toista rinnakkaista luokittelua.

---

## Migraatio 0012 (luotu, EI AJETTU)

Tarkka sisältö: `supabase/migrations/0012_life_alignment.sql`,
varmistus `supabase/verify/verify_0012.sql`.

| Objekti | Uusi / muutos |
|---|---|
| `life_areas` | uusi taulu |
| `weekly_capacities` | uusi taulu, uniikki `(user_id, week_start)`, `week_start` on maanantai |
| `time_entries` | uusi taulu, yhd. FK:t `life_area_id`, `goal_id`, `task_id` (`on delete set null (sarake)`) |
| `alignment_reviews` | uusi taulu, uniikki `(user_id, week_start)` |
| `goals.life_area_id` | **uusi nullable sarake olemassa olevaan tauluun**, yhd. FK `on delete set null (life_area_id)` |

Ei täyttöä. Yhtäkään olemassa olevaa riviä, saraketta tai rajoitetta ei
muuteta. Portit (`src/data/schema.js`): `TABLES.lifeAreas`,
`weeklyCapacities`, `timeEntries`, `alignmentReviews` ja sarakeportti
`GOAL_LIFE_AREA_FIELD` — kaikki `false`, joten ennen ajoa tieto elää
istunnon muistissa ja käyttöliittymä kertoo sen.

---

## Laajennuspisteet (tulevat tietolähteet)

Life Alignment ei tunne lähteitä nimeltä: se lukee normalisoidun
viikkoaineiston (`src/domain/alignment.js` `buildAlignmentWeek`). Uusi
lähde lisätään tuottamaan samoja faktoja:

| Lähde | Tuottaa | Tila |
|---|---|---|
| Kalenteri | suunniteltu aika (sitoumukset) ja toteutunut aika | NOT_STARTED |
| Talous (`transactions`, `bills`) | rahan toteuma ja sitoumukset alueittain | NOT_STARTED — `alignment.js` ei tunne rahaa, rahaa ei sekoiteta aikaan |
| Hyvinvointi (`wellbeing_entries`) | toteutunut energia/palautuminen | NOT_STARTED |
| Terveys/aktiivisuus | energian ja liikkeen näyttö | NOT_STARTED |
| Sijainti | ei tallenneta (ks. 0011) | EI TEHDÄ |

`time_entries.source` sallii tänään vain arvon `manual`. Uusi lähde lisätään
omalla migraatiollaan, jolloin sen tuottama rivi on aina tunnistettavissa
eikä sekoitu käyttäjän itse kirjaamaan aikaan.
