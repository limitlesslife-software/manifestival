# Tuotannon aktivointiportti — skeemaporttien inventaario

**Kaikki portit ovat `false`. Yhtäkään ei käännetä ennen kuin vastaava
migraatio on oikeasti ajettu ja todennettu.**

Tämä dokumentti on yksi keskitetty totuus siitä, mikä toimii paikallisesti
ja mikä ei säily tallennuksen yli. Runbook on erikseen:
[`PRODUCTION-ACTIVATION-RUNBOOK.md`](PRODUCTION-ACTIVATION-RUNBOOK.md).

Portin arvot: `src/data/schema.js`.

---

## Miksi portteja on

Domain, käyttöliittymä ja repositoriorajapinta voidaan rakentaa valmiiksi
ilman tietokantaa. Portti erottaa **toteutuksen** ja **tuotannon
persistenssin** toisistaan, jotta:

1. sovellus ei yritä kirjoittaa olemattomiin tauluihin — jokainen tallennus
   epäonnistuisi tuotannossa
2. käyttöliittymä voi kertoa käyttäjälle rehellisesti, mikä ei vielä säily
3. käyttöönotto on yhden rivin muutos migraation jälkeen, ei uudelleenkirjoitus

Portin ollessa `false` repositorio käyttää **muistivarastoa**. Tieto katoaa
sivun latauksessa ja uloskirjautumisessa.

---

## Kokonaiskuva

| Portti | Domain | Repo | UI | Migraatio | Persistenssi |
|---|---|---|---|---|---|
| `TASK_EXTENDED_FIELDS` | ✔ | ✔ | ✔ | 0002 | **EI** |
| `routines` | ✔ | ✔ | ✔ | 0003 | **EI** |
| `routineExceptions` | ✔ | ✔ | ✔ | 0003 | **EI** |
| `goals` | ✔ | ✔ | ✔ | 0004 | **EI** |
| `projects` | ✔ | ✔ | ✘ | 0004 | **EI** |
| `notificationPreferences` | ✔ | ✔ | ✔ | 0005 | **EI** |
| `wellbeing` | ✔ | ✔ | ✔ | 0006 | **EI** |
| `bills` | ✔ | ✔ | ✘ | 0007 | **EI** |
| `recurringExpenses` | ✔ | ✔ | ✘ | 0007 | **EI** |
| `savingsGoals` | ✔ | ✔ | ✘ | 0007 | **EI** |
| `aiAudit` | ✔ | ✔ | ✘ | 0008 | **EI** |

`tasks` (perussarakkeet) ja `profile` **toimivat jo tuotannossa** eivätkä ole
portin takana.

---

## Portti kerrallaan

### `TASK_EXTENDED_FIELDS` — migraatio 0002

| | |
|---|---|
| **Domain** | Valmis: kuvaus, kesto, prioriteetti, aikataulutuksen tila |
| **Repo** | `tasksRepo`, `taskColumns()` valitsee sarakejoukon |
| **UI** | Valmis — kentät näkyvissä tehtävälomakkeessa |
| **Persistenssi** | **EI.** Kentät elävät istunnon muistissa |
| **Ennen kytkentää** | Runbookin GATE 0–6 läpi: `preflight_0002.sql` puhdas, 0002 ajettu kerran, `verify_0002.sql` kauttaaltaan `PASS` (`poikkeavia_yhteensa` = 0) |
| **Milloin** | GATE 7, ei aiemmin |
| **Miten varmistetaan** | `npm test` läpi; tuotannossa luotu tehtävä, jolla on kuvaus ja prioriteetti, säilyy sivun uudelleenlatauksen yli |

Erityishuomio: tämä on ainoa portti, joka muuttaa **olemassa olevan** taulun
kirjoituksia. Väärä kytkentä rikkoo tehtävien tallennuksen kokonaan.

**Käännä lippu pian migraation jälkeen.** Väliaikana sovellus ei lähetä
`scheduling_state`-saraketta, jolloin uudet kellonajattomat tehtävät saavat
oletusarvon `manual` eivätkä `unscheduled` — automaatti ei ehdota niille
aikaa. Ks. [`MIGRATION-0002-RECOVERY.md`](MIGRATION-0002-RECOVERY.md).

### `routines` ja `routineExceptions` — migraatio 0003

| | |
|---|---|
| **Domain** | Valmis: neljä toistotyyppiä, kolme poikkeustyyppiä, voimassaoloväli |
| **Repo** | `routinesRepo`, `routineExceptionsRepo` |
| **UI** | Valmis — Tekeminen → Rutiinit |
| **Persistenssi** | **EI** |
| **Ennen kytkentää** | Taulut olemassa; RLS päällä molemmissa; neljä politiikkaa kummallakin; `routine_exceptions_unique_day` olemassa; `routines.goal_id` olemassa; anon-oikeudet revokoitu |

Molemmat portit kytketään **yhdessä**: poikkeus ilman sääntöä on orpo.

### `goals` ja `projects` — migraatio 0004

| | |
|---|---|
| **Domain** | Valmis: neljä edistymistapaa, viisi projektitilaa, riskiarvio |
| **Repo** | `goalsRepo`, `projectsRepo` |
| **UI** | Tavoitteet valmis; **projekteilla ei ole näkymää** |
| **Persistenssi** | **EI** |
| **Ennen kytkentää** | Taulut olemassa; `tasks.deadline`, `tasks.goal_id`, `tasks.project_id` olemassa; kaikki FK-viitteet ovat `on delete set null` (**ei** cascade); `goals_status_check` sisältää `abandoned`; `goals_progress_mode_check` sisältää `project_based` ja `routine_based`; `projects_status_check` sisältää `planned` |

Erityishuomio: FK:n on oltava `set null`. `cascade` poistaisi tehtävät
tavoitteen mukana — se on suoraan vastoin domainin sopimusta.

### `notificationPreferences` — migraatio 0005

| | |
|---|---|
| **Domain** | Valmis: eskalaatio, rauhoitusaika, päiväkatto |
| **Repo** | `notificationPrefsRepo` (yksi rivi per käyttäjä, `id = auth.uid()`) |
| **UI** | Valmis — Profiili → Muistutukset |
| **Persistenssi** | **EI** |
| **Ennen kytkentää** | Taulu olemassa; `enabled`-sarakkeen oletus on **false**; kellonaikojen muototarkistus olemassa; omistajuus `id`-sarakkeessa, ei erillisessä `user_id`:ssä |

Erityishuomio: jos `enabled`-oletus olisi `true`, migraation ajaminen
kytkisi muistutukset päälle kaikille ilman lupaa.

### `wellbeing` — migraatio 0006

| | |
|---|---|
| **Domain** | Valmis: asteikko 1–5, kuormitusarvio, ehdotus |
| **Repo** | `wellbeingRepo` |
| **UI** | Valmis — Tänään → Miten menee? |
| **Persistenssi** | **EI** |
| **Ennen kytkentää** | Taulu olemassa; `wellbeing_entries_unique_day (user_id, date)` olemassa; asteikkorajoitteet 1–5; `sleep_hours > 0` |

### `bills`, `recurringExpenses`, `savingsGoals` — migraatio 0007

| | |
|---|---|
| **Domain** | Valmis: kokonaislukusentit, kalenteritoisto, säästötavoitteet |
| **Repo** | `billsRepo`, `recurringExpensesRepo`, `savingsGoalsRepo` |
| **UI** | **Ei näkymää** |
| **Persistenssi** | **EI** |
| **Ennen kytkentää** | Kolme taulua olemassa; **`amount_minor`, `target_minor`, `current_minor` ovat `bigint`** — ei `numeric` eikä liukuluku; valuuttamuodon tarkistus kaikissa kolmessa; `bills_paid_date_check` olemassa; FK:t `task_id` ja `recurring_expense_id` ovat `set null` |

Erityishuomio: rahasarakkeen tyyppi on tämän portin tärkein tarkistus.
`numeric` palautuu JavaScriptiin ajurin mukaan merkkijonona tai
liukulukuna — ja juuri se muunnos on kohta, jossa sentit katoavat.

Kolme porttia kytketään **yhdessä**: lasku voi viitata toistuvaan kuluun.

### `aiAudit` — migraatio 0008

| | |
|---|---|
| **Domain** | Valmis: kirjaus, tiivistelmä, lopputulokset |
| **Repo** | `aiAuditRepo` |
| **UI** | **Ei näkymää** |
| **Persistenssi** | **EI** |
| **Ennen kytkentää** | Taulu olemassa; **`executed = false or confirmed = true`** -rajoite olemassa; `input_summary` pituusrajoite ≤ 200; `target_id` **ei** ole vierasavain; `ai_action_audit_result_check` ja `_risk_check` vastaavat domainia |

Erityishuomio: `target_id` ei saa olla vierasavain. Kohde on voitu poistaa,
ja kirjaus siitä on nimenomaan se, mitä halutaan säilyttää.

---

## Portin kytkeminen — sääntö

```
1. Aja migraatio
2. Aja migraation lopun varmistuskyselyt
3. Aja tämän dokumentin "Ennen kytkentää" -kohdat
4. VASTA SITTEN vaihda portti trueksi
5. Päivitä tests/migrations.test.mjs samassa committissa
6. Sano commit-viestissä ääneen mikä migraatio ajettiin ja milloin
```

**Yksi portti kerrallaan.** Poikkeus: `routines`+`routineExceptions`,
`goals`+`projects` ja kolme talousporttia kytketään pareina/kolmikkona,
koska ne viittaavat toisiinsa.

---

## Testi, joka kaatuu tarkoituksella

`tests/migrations.test.mjs` sisältää:

```
test('yksikään taululippu ei ole päällä ennen migraation ajoa', ...)
```

Se **kaatuu heti**, kun mikä tahansa portti käännetään. Se on
tarkoituksellinen: lippua ei voi vaihtaa vahingossa, ja kytkentä pakottaa
toteamaan ääneen että migraatio on oikeasti ajettu tuotannossa.

`TASK_EXTENDED_FIELDS` ei ole `TABLES`-oliossa, joten se ei kuulu tämän
testin piiriin — sen kytkentä on tarkistettava käsin.

---

## Mitä käyttäjä näkee nyt

Sovellus **ei teeskentele tallentavansa**:

- `volatileCollections()` kertoo, mitkä tietotyypit eivät säily
- `warnAboutVolatileCollections()` näyttää huomautuksen kerran istunnossa
- Muistutusasetusten näkymä kertoo erikseen, ettei asetus säily
- Tehtävälomake kertoo laajennetuista kentistä

Ks. [`ACCOUNT-DELETION.md`](ACCOUNT-DELETION.md) ja
[`PRODUCTION-ACTIVATION.md`](PRODUCTION-ACTIVATION.md).
