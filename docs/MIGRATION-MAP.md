# Migraatiokartta 0001–0008

**Yhtäkään näistä ei ole ajettu tuotannossa.** Kaikki kahdeksan ovat
luonnoksia. Ajojärjestys ja pysäytyspisteet:
[`PRODUCTION-ACTIVATION-RUNBOOK.md`](PRODUCTION-ACTIVATION-RUNBOOK.md).

Lippujen tila: [`PRODUCTION-ACTIVATION-GATE.md`](PRODUCTION-ACTIVATION-GATE.md).

## Riippuvuusketju

```
0001  auth-omistajuus            (pakollinen pohja kaikelle)
 ├─ 0002  tasks-lisäsarakkeet
 ├─ 0003  routines + poikkeukset ──┐
 ├─ 0004  goals + projects ────────┤ 0004 lisää routines.goal_id
 ├─ 0005  muistutusasetukset       │ vain JOS 0003 on ajettu
 ├─ 0006  hyvinvointi              │
 ├─ 0007  talous ─── tarvitsee myös tasks-taulun
 └─ 0008  AI-kirjaus
```

0002–0008 ovat **keskenään riippumattomia** yhtä poikkeusta lukuun
ottamatta: 0004 luo `routines.goal_id`-viitteen ehdollisesti, vain jos
`routines`-taulu on jo olemassa. Järjestys 0003 → 0004 on siksi
suositeltava mutta ei pakollinen.

---

## 0001 — `auth_user_scoping` (218 riviä, 8 politiikkaa, 1 indeksi)

| | |
|---|---|
| **Tarkoitus** | Vaihtaa omistajuusmalli laitetunnisteesta oikeaan `auth.uid()`-pohjaiseen malliin |
| **Riippuu** | ei mistään — **tämä on pohja** |
| **Taulut** | `tasks`, `profile` (olemassa olevia) |
| **Sarakkeet** | `user_id uuid not null references auth.users(id) on delete cascade`, oletus `auth.uid()` |
| **RLS** | Päälle molempiin; 4 politiikkaa/taulu (select/insert/update/delete), ehto `auth.uid() = user_id` |
| **Omistajuus** | **Tietokanta asettaa**, ei asiakas |
| **Avaa lipun** | ei yhtään — mahdollistaa kaikki muut |
| **Palautus** | **Vaikea.** Sisältää olemassa olevan datan siirron. Ilman varmuuskopiota ei ole paluuta |
| **Varmistus** | `pg_policies` näyttää 8 riviä; `relrowsecurity = true`; `tasks.user_id` ei null yhdelläkään rivillä; anon-oikeudet revokoitu |

**Kriittinen kohta:** `revoke all on public.profile from anon`. Jos anon
säilyttää oikeudet, RLS ei suojaa mitään — anon-rooli näkisi kaikkien rivit.

---

## 0002 — `task_domain_fields` (181 riviä, 1 indeksi, 6 tarkistetta)

| | |
|---|---|
| **Tarkoitus** | Domainin tehtäväkentät tietokantaan |
| **Riippuu** | 0001 |
| **Sarakkeet** | `description`, `duration_minutes`, `priority`, `scheduling_state`, `created_at`, `updated_at` |
| **RLS** | Ei muutosta — perii 0001:n politiikat |
| **Avaa lipun** | `TASK_EXTENDED_FIELDS` |
| **Palautus** | Helppo: `drop column`. Sarakkeiden data menetetään |
| **Varmistus** | Kuusi saraketta olemassa; `tasks_priority_check` ja `tasks_scheduling_state_check` olemassa; `scheduling_state` ei null |

**Kriittinen kohta:** ainoa migraatio, joka muuttaa **jo tuotannossa
käytössä olevan** taulun kirjoituspolkua. Lipun kääntäminen ennen ajoa
rikkoo tehtävien tallennuksen kokonaan.

---

## 0003 — `routines` (302 riviä, 8 politiikkaa, 2 indeksiä, 22 tarkistetta)

| | |
|---|---|
| **Tarkoitus** | Toistuvat rutiinit ja niiden päiväkohtaiset poikkeukset |
| **Riippuu** | 0001 |
| **Taulut** | `routines`, `routine_exceptions` |
| **Viitteet** | `routine_exceptions.routine_id → routines(id) on delete cascade` |
| **RLS** | Päälle molempiin, 4+4 politiikkaa |
| **Avaa liput** | `routines`, `routineExceptions` (**yhdessä**) |
| **Palautus** | Helppo: `drop table` molemmat. Ei koske olemassa olevaan dataan |
| **Varmistus** | Molemmat taulut; 8 politiikkaa; `routine_exceptions_unique_day` olemassa; toistotyypin ja poikkeustyypin tarkisteet vastaavat domainia |

**Kriittinen kohta:** poikkeuksen `cascade` on tässä oikein — poikkeus
ilman sääntöä on merkityksetön. Tämä on ainoa kohta koko skeemassa, jossa
cascade on tarkoituksellinen käyttäjädatan välillä.

---

## 0004 — `goals_projects` (364 riviä, 8 politiikkaa, 4 indeksiä, 24 tarkistetta)

| | |
|---|---|
| **Tarkoitus** | Tavoitteet, projektit ja tehtävien linkitys niihin |
| **Riippuu** | 0001; **ehdollisesti** 0003 |
| **Taulut** | `goals`, `projects` |
| **Sarakkeet muualle** | `tasks.deadline`, `tasks.goal_id`, `tasks.project_id` |
| **Viitteet** | `projects.goal_id`, `tasks.goal_id`, `tasks.project_id`, `routines.goal_id` — **kaikki `on delete set null`** |
| **RLS** | Päälle molempiin, 4+4 politiikkaa |
| **Avaa liput** | `goals`, `projects` (**yhdessä**) |
| **Palautus** | Keskitaso: `drop table` + kolmen sarakkeen poisto `tasks`-taulusta. Linkitykset menetetään, tehtävät säilyvät |
| **Varmistus** | Kaksi taulua; kolme uutta `tasks`-saraketta; **kaikki FK:t `set null`**; `goals_status_check` sisältää `abandoned`; `goals_progress_mode_check` neljä arvoa; `projects_status_check` sisältää `planned` |

**Kriittinen kohta:** `set null` eikä `cascade`. Tavoitteen poistaminen ei
saa poistaa tehtäviä. Domain sanoo saman
([`project.js`](../src/domain/project.js): `TASK_DELETE_POLICY.UNLINK`), ja
tietokannan on pakotettava se — sovellusvirhe ei saa hävittää dataa.

---

## 0005 — `notification_preferences` (179 riviä, 4 politiikkaa, 8 tarkistetta)

| | |
|---|---|
| **Tarkoitus** | Muistutusasetukset palvelimelle laitekohtaisen sijaan |
| **Riippuu** | 0001 |
| **Taulut** | `notification_preferences` — **yksi rivi per käyttäjä**, `id = auth.uid()` |
| **RLS** | Päälle, 4 politiikkaa, ehto `auth.uid() = id` |
| **Avaa lipun** | `notificationPreferences` |
| **Palautus** | Helppo: `drop table` |
| **Varmistus** | Taulu; **`enabled`-oletus on `false`**; kellonaikojen muototarkisteet; omistajuus `id`-sarakkeessa |

**Kriittinen kohta:** `enabled` oletusarvoltaan `false`. Muistutukset ovat
lupa-asia. Jos oletus olisi `true`, migraation ajaminen kytkisi ilmoitukset
päälle jokaiselle käyttäjälle ilman että kukaan pyysi.

---

## 0006 — `wellbeing` (159 riviä, 4 politiikkaa, 1 indeksi, 6 tarkistetta)

| | |
|---|---|
| **Tarkoitus** | Päiväkohtaiset hyvinvointimerkinnät |
| **Riippuu** | 0001 |
| **Taulut** | `wellbeing_entries` |
| **RLS** | Päälle, 4 politiikkaa |
| **Avaa lipun** | `wellbeing` |
| **Palautus** | Helppo: `drop table` |
| **Varmistus** | Taulu; `wellbeing_entries_unique_day (user_id, date)`; asteikot 1–5; `sleep_hours > 0` |

**Kriittinen kohta:** tämä on koko sovelluksen **arkaluontoisin taulu**.
Terveystietoa. RLS-politiikkojen tarkistus ei ole tässä muodollisuus. Loki
ei saa koskaan sisältää näitä arvoja
([`logger.js`](../src/lib/logger.js) `SENSITIVE_KEYS`).

---

## 0007 — `finance` (366 riviä, 12 politiikkaa, 4 indeksiä, 32 tarkistetta)

| | |
|---|---|
| **Tarkoitus** | Laskut, toistuvat kulut, säästötavoitteet |
| **Riippuu** | 0001 (ja `tasks` `bills.task_id`-viitettä varten) |
| **Taulut** | `recurring_expenses`, `bills`, `savings_goals` |
| **Viitteet** | `bills.task_id → tasks`, `bills.recurring_expense_id → recurring_expenses` — molemmat `set null` |
| **RLS** | Päälle kaikkiin kolmeen, 4+4+4 politiikkaa |
| **Avaa liput** | `bills`, `recurringExpenses`, `savingsGoals` (**yhdessä**) |
| **Palautus** | Helppo: `drop table` kolme, oikeassa järjestyksessä (bills ensin) |
| **Varmistus** | Kolme taulua; **`amount_minor`, `target_minor`, `current_minor` ovat `bigint`**; valuuttatarkisteet; `bills_paid_date_check` |

**Kriittinen kohta:** rahasarakkeiden tyyppi. `bigint`, ei `numeric` eikä
`double precision`. `numeric` palautuu ajurin mukaan merkkijonona tai
liukulukuna, ja juuri se muunnos on kohta, jossa sentit katoavat.
`tests/migrations.test.mjs` kieltää `numeric`-tyypin rahasarakkeissa —
kommenttirivit poistetaan ennen tarkistusta, jotta selitysteksti ei laukaise
sitä.

---

## 0008 — `ai_audit` (166 riviä, 4 politiikkaa, 1 indeksi, 12 tarkistetta)

| | |
|---|---|
| **Tarkoitus** | Kirjaus siitä, mitä AI ehdotti, mitä vahvistettiin ja mitä suoritettiin |
| **Riippuu** | 0001 |
| **Taulut** | `ai_action_audit` |
| **Viitteet** | **ei yhtään `target_id`-sarakkeesta** — tarkoituksella |
| **RLS** | Päälle, 4 politiikkaa |
| **Avaa lipun** | `aiAudit` |
| **Palautus** | Helppo: `drop table`. Kirjaushistoria menetetään |
| **Varmistus** | Taulu; **`executed = false or confirmed = true`** -rajoite; `input_summary` enintään 200 merkkiä; `target_id` ei ole FK; tulos- ja riskitarkisteet vastaavat domainia |

**Kriittinen kohta kaksi kertaa:**

1. `executed = false or confirmed = true` on tietokantatason takuu siitä,
   ettei suoritettua vahvistamatonta komentoa voi edes kirjata. Jos
   sovelluslogiikka joskus vuotaa, tietokanta kieltäytyy.
2. `target_id` ei ole vierasavain, koska kohde on voitu poistaa — ja
   kirjaus juuri poistosta on se, mitä halutaan säilyttää.
