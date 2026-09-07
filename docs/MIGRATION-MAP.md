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

## Omistajuusgraafi — lue tämä ennen muuta

Yhdeksän viittausta kolmessa migraatiossa. Jokainen niistä on
**yhdistelmävierasavain**, ei tavallinen viite:

```sql
foreign key (user_id, goal_id) references public.goals (user_id, id)
```

| Viite | Migraatio | Poisto |
|-------|-----------|--------|
| `routine_exceptions.routine_id → routines` | 0003 | cascade |
| `goals.parent_goal_id → goals` | 0004 | set null |
| `goals.project_id → projects` | 0004 | set null |
| `projects.goal_id → goals` | 0004 | set null |
| `tasks.goal_id → goals` | 0004 | set null |
| `tasks.project_id → projects` | 0004 | set null |
| `routines.goal_id → goals` | 0004 | set null |
| `bills.task_id → tasks` | 0007 | set null |
| `bills.recurring_expense_id → recurring_expenses` | 0007 | set null |

### Miksi tavallinen vierasavain ei riitä

> **RLS estää lukemisen, ei viittaamista.**

Vierasavaimen tarkistus ei kulje RLS:n läpi. Kanta katsoo, onko rivi
olemassa — ei sitä, saisiko viittaaja nähdä sen. Kun käyttäjä B lähettää
rivin, jonka `goal_id` on käyttäjän A tavoitteen tunniste,
INSERT-politiikan `WITH CHECK` vertaa vain omistajaa, ja omistaja on
oikein: B.

Tavallinen `references public.goals(id)` sallisi siis sen, että B:n rivi
viittaa A:n riviin. Migraation 0004 aiempi versio dokumentoi tämän
"hyväksyttynä riskinä" — se ei ollut hyväksyttävä, ja se on korjattu.

### Omistajan rivin avaimet

Yhdistelmävierasavain vaatii kohteelta yksikäsitteisyysrajoitteen
`unique (user_id, id)`. Sellainen on viidessä taulussa:

| Avain | Migraatio |
|-------|-----------|
| `routines_owner_row_key` | 0003 |
| `goals_owner_row_key` | 0004 |
| `projects_owner_row_key` | 0004 |
| `tasks_owner_row_key` | **0007 — tuotannon tauluun** |
| `recurring_expenses_owner_row_key` | 0007 |

`id` on jo pääavain jokaisessa, joten avain ei lisää yhtään uutta
rajoitusta riveille eikä voi kaatua dataan.

### `on delete set null (sarake)` vaatii PostgreSQL 15:n

Ilman sarakelistaa PostgreSQL nollaisi kaikki vierasavaimen sarakkeet,
myös `user_id`, joka on `NOT NULL` — ja kohteen poisto kaatuisi joka
kerta. Versio on tarkistettu esiehto migraatioissa 0004 ja 0007.

---

0002–0008 ovat **keskenään riippumattomia** yhtä poikkeusta lukuun
ottamatta: 0004 luo `routines.goal_id`-viitteen ehdollisesti, vain jos
`routines`-taulu on jo olemassa. Järjestys 0003 → 0004 on siksi
suositeltava mutta ei pakollinen.

---

## 0001 — `auth_user_scoping` (708 riviä, 8 politiikkaa, 1 indeksi)

**Ainoa migraatio, joka on sovitettu todennettuun tuotantoskeemaan.**
Muut kahdeksan ovat yleisluonteisia, koska ne luovat uusia tauluja eivätkä
kosketa olemassa olevaa dataa. 0001 koskettaa.

| | |
|---|---|
| **Tarkoitus** | Vaihtaa omistajuusmalli kiinteästä `'me'`-tunnisteesta oikeaan `auth.uid()`-pohjaiseen malliin |
| **Riippuu** | ei mistään — **tämä on pohja** |
| **Taulut** | `tasks` (36 riviä), `profile` (1 rivi) — molemmat olemassa |
| **Sarakkeet** | `tasks.user_id uuid not null default auth.uid()`; `profile.id` uusi `uuid`, vanha arvo säilyy sarakkeessa `profile.legacy_id` |
| **Vierasavaimet** | molemmat `references auth.users(id) on delete cascade` |
| **RLS** | Päälle molempiin; 4 politiikkaa/taulu roolille `authenticated`. Ehto `auth.uid() = user_id` (tasks) ja `auth.uid() = id` (profile) |
| **Omistajuus** | **Tietokanta asettaa**, ei asiakas. Omistaja kovakoodattu — ei rivijärjestystä, ei `LIMIT 1`, ei sähköpostihakua |
| **Lukitus** | `ACCESS EXCLUSIVE` molempiin tauluihin heti olemassaolotarkistuksen jälkeen, `lock_timeout 5s`. Lyhyt katko sovellukselle |
| **Esiehdot** | 7 tarkistusta, kaikki lukon takana ja ennen ensimmäistä muutosta; migraatio keskeyttää itse jos lähtötila ei täsmää |
| **Avaa lipun** | ei yhtään — mahdollistaa kaikki muut |
| **Palautus** | Kolme eri tapausta, ks. runbookin *0001:n peruminen*. Keskeytynyt ajo peruuntuu itse; läpimennyt ajo on purettavissa käsin `legacy_id`:n ansiosta; kadonnut data vain varmuuskopiosta |
| **Varmistus** | `verify_0001.sql`, 20 kohtaa — mukaan lukien politiikkojen USING/WITH CHECK -lausekkeet odotettuun verrattuna ja vierasavainten päät. Ks. runbookin PYSÄYTYS 3 -taulukko |

**Kriittinen kohta 1:** `profile.id` **ei** muunnu tyyppiä vaihtamalla.
Tuotannon ainoan rivin arvo on `'me'`, eikä `'me'` ole uuid — `id::uuid`
kaatuisi heti. Vanha sarake nimetään `legacy_id`:ksi ja uusi uuid-sarake
lisätään sen rinnalle.

**Kriittinen kohta 2:** oikeudet revokoidaan **myös roolilta `PUBLIC`**,
ei vain `anon`-roolilta. PUBLIC tarkoittaa "kaikki roolit": sille
myönnetyn oikeuden perii myös anon, eikä `revoke ... from anon` poista
sitä. Tehollinen oikeus todennetaan `has_table_privilege`-funktiolla,
koska pelkkä myönnettyjen oikeuksien luettelo ei näe perintää.

**Kriittinen kohta 3:** vanhat "salli kaikki" -politiikat poistetaan
nimestä riippumatta, `pg_policies`-kyselyn kautta. Politiikat ovat
OR-ehtoja keskenään: yksi jäljelle jäänyt salliva politiikka kumoaisi
kaikki kahdeksan uutta.

---

## 0002 — `task_domain_fields` (1 indeksi, 3 tarkistetta) — AJETTU, PASS

| | |
|---|---|
| **Tarkoitus** | Domainin tehtäväkentät tietokantaan |
| **Riippuu** | 0001 (ajettu ja hyväksytty). **Ei riipu 0003–0008:sta** |
| **Sarakkeet** | `description`, `duration_minutes`, `priority`, `scheduling_state`, `created_at`, `updated_at` |
| **Muut objektit** | `touch_updated_at()` (jaettu 0003/0004:n kanssa), liipaisin `tasks_touch_updated_at`, indeksi `tasks_user_date_priority_idx` |
| **RLS** | Ei muutosta — uudet sarakkeet perivät 0001:n politiikat |
| **Avaa lipun** | `TASK_EXTENDED_FIELDS` — **yhä `false`**, aktivointi on erillinen päätös ([`TASK-EXTENDED-FIELDS-ACTIVATION.md`](TASK-EXTENDED-FIELDS-ACTIVATION.md)) |
| **Uudelleenajo** | **Keskeytyy.** Migraatio tunnistaa aiemman ja kesken jääneen ajon eikä ole idempotentti |
| **Preflight** | `supabase/preflight/preflight_0002.sql`, 19 kohtaa |
| **Varmistus** | `supabase/verify/verify_0002.sql`, 29 kohtaa yhtenä taulukkona |
| **Palautus** | Turvallinen ennen lipun kääntämistä, **ei sen jälkeen** — ks. [`MIGRATION-0002-RECOVERY.md`](MIGRATION-0002-RECOVERY.md) |

**Kriittinen kohta:** ainoa migraatio, joka muuttaa **jo tuotannossa
käytössä olevan** taulun kirjoituspolkua. Lipun kääntäminen ennen ajoa
rikkoo tehtävien tallennuksen kokonaan.

**Toinen kriittinen kohta:** `touch_updated_at()` luodaan `create or
replace` -lauseella myös migraatioissa 0003 ja 0004. Määrittelyn on
oltava kaikissa kolmessa sanasta sanaan sama, muuten myöhempi migraatio
purkaa hiljaa aiemman kovennuksen. Testi vartioi tätä.

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

## 0004 — `goals_projects` (815 riviä, 8 politiikkaa, 4 indeksiä, 14 tarkistetta)

| | |
|---|---|
| **Tarkoitus** | Tavoitteet, projektit ja tehtävien linkitys niihin |
| **Riippuu** | 0001; **ehdollisesti** 0003 |
| **Taulut** | `goals`, `projects` |
| **Sarakkeet muualle** | `tasks.deadline`, `tasks.goal_id`, `tasks.project_id` |
| **Viitteet** | **Kuusi**, kaikki `on delete set null`: `goals.parent_goal_id`→`goals`, `goals.project_id`→`projects`, `projects.goal_id`→`goals`, `tasks.goal_id`→`goals`, `tasks.project_id`→`projects`, `routines.goal_id`→`goals` (vain jos 0003 ajettu). Kaksi ensimmäistä syntyy `create table` -lauseen sisällä eikä erillisenä `add constraint` -lauseena |
| **RLS** | Päälle molempiin, 4+4 politiikkaa |
| **Avaa liput** | `goals`, `projects` (**yhdessä**) |
| **Palautus** | Keskitaso: `drop table` + kolmen sarakkeen poisto `tasks`-taulusta. Linkitykset menetetään, tehtävät säilyvät |
| **Varmistus** | Kaksi taulua; kolme uutta `tasks`-saraketta; **kaikki FK:t `set null`**; `goals_status_check` sisältää `abandoned`; `goals_progress_mode_check` neljä arvoa; `projects_status_check` sisältää `planned` |

**Kriittinen kohta:** `set null` eikä `cascade`. Tavoitteen poistaminen ei
saa poistaa tehtäviä. Domain sanoo saman
([`project.js`](../src/domain/project.js): `TASK_DELETE_POLICY.UNLINK`), ja
tietokannan on pakotettava se — sovellusvirhe ei saa hävittää dataa.

---

## 0005 — `notification_preferences` (465 riviä, 4 politiikkaa, 5 tarkistetta)

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

## 0006 — `wellbeing` (444 riviä, 4 politiikkaa, 1 indeksiä, 4 tarkistetta)

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

## 0007 — `finance` (879 riviä, 12 politiikkaa, 4 indeksiä, 19 tarkistetta)

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

## 0008 — `ai_audit` (445 riviä, 4 politiikkaa, 1 indeksiä, 8 tarkistetta)

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
