# Manifestival — tuotannon tila

**Päivitetty:** 2026-09-08
**Lähde:** ajetut migraatiot, varmistusten tulokset ja live-hyväksyntätesti

Tämä on repositorion **auktoritatiivinen** tieto siitä, mikä on ajettu
tuotantoon ja mikä ei. Jos jokin muu tiedosto on ristiriidassa tämän
kanssa, tämä on oikeassa.

---

## Miksi tämä dokumentti on olemassa

Migraatiotiedostot 0003–0008 sisältävät otsikkorivin

```
-- TILA: EI AJETTU TUOTANTOON.
```

**Se ei enää pidä paikkaansa.** Kaikki kahdeksan on ajettu.

Rivejä ei ole korjattu tiedostoihin, ja se on tietoinen valinta.
Migraatio on tietue siitä, mitä tuotannossa ajettiin. Kun se on kerran
ajettu, sen tiedosto on historiaa: jos sitä muokataan jälkikäteen,
repositorio ei enää kerro mitä oikeasti ajettiin, vaan mitä joku
myöhemmin ajatteli ajetun.

Otsikkorivi oli tosi silloin kun se kirjoitettiin. Se on nyt vanhentunut
samalla tavalla kuin mikä tahansa muu ajanhetkeen sidottu kommentti, ja
oikea paikka ajantasaiselle tiedolle on tämä dokumentti — ei kahdeksan
erillistä tiedostoa, jotka voivat erkaantua toisistaan.

Automaattinen testi vartioi, että tämä dokumentti pysyy ajan tasalla.

---

## Migraatiot

| # | Tiedosto | Tila | Todennus |
|---|----------|------|----------|
| 0001 | `0001_auth_user_scoping.sql` | **AJETTU** | PASS |
| 0002 | `0002_task_domain_fields.sql` | **AJETTU** | PASS |
| 0003 | `0003_routines.sql` | **AJETTU** | PASS |
| 0004 | `0004_goals_projects.sql` | **AJETTU** | PASS |
| 0005 | `0005_notification_preferences.sql` | **AJETTU** | PASS |
| 0006 | `0006_wellbeing.sql` | **AJETTU** | PASS |
| 0007 | `0007_finance.sql` | **AJETTU** | PASS |
| 0008 | `0008_ai_audit.sql` | **AJETTU** | PASS |

> **Yhtäkään ei saa ajaa uudelleen.** Jokainen on fail-closed ja
> keskeytyy itse, mutta älä luota siihen — ne on tarkoitettu ajettaviksi
> kerran.

---

## Todennus

| Vaihe | Tulos |
|---|---|
| 0004–0008 lopullinen skeemavarmistus | **PASS** |
| 0003–0008 live-RLS-hyväksyntä (ajo `20260907184327`) | **271 / 271 PASS**, 0 FAIL, 0 ERROR, 0 SKIP |
| Väliaikainen tili B | poistettu |
| Hyväksyntätestin siivous | PASS |
| Privileged auth-precheck | **6 / 6 PASS**, `failures_total = 0` |
| Lopullinen hyväksynnän jälkeinen varmistus | **40 / 40 PASS**, `failures_total = 0` |

---

## Tuotannon perustila

| Mitta | Arvo |
|---|---|
| `tasks` | **36** |
| `profile` | **1** |
| Tehtävien tunnisteiden tiiviste | `1acdb7371be22cfa457b4dae0d0aa800` |
| Kaikki kymmenen 0003–0008 -taulua | **tyhjiä** |
| Auth-käyttäjiä | 1 |

Nämä luvut ovat hyväksytty lähtötila. Aktivoinnin jälkeinen varmistus
vertaa niihin.

---

## Turvallisuus — todennettu tila

- RLS päällä kaikissa oleellisissa tauluissa
- 40 omistajuuspolitiikkaa, kaikki vain `authenticated`-roolille
- `anon` tehollisia oikeuksia: **0**
- `PUBLIC` oikeuksia: **0**
- `authenticated` tarkoitetut CRUD-oikeudet: **44**
- 9 yhdistelmäomistajuusvierasavainta
- Yhden sarakkeen ohitusvierasavaimia: **0**
- Käyttäjän poiston cascade-viitteet validoituja
- Public-tauluja ilman RLS:ää: **0**
- SECURITY DEFINER -invariantit PASS
- `rls_auto_enable` (ympäristön infrastruktuuri) invariantti PASS
- `touch_updated_at` kovennettu (`security invoker`, kiinnitetty `search_path`)
- 10 `updated_at`-liipaisinta

**Mitään näistä ei saa heikentää.**

---

## Sovelluksen portit

| Portti | Migraatio | Tuotannon tila |
|---|---|---|
| `TASK_EXTENDED_FIELDS` | 0002 | **AKTIVOITU** |
| `routines` | 0003 | kiinni |
| `routineExceptions` | 0003 | kiinni |
| `goals` | 0004 | kiinni |
| `projects` | 0004 | kiinni |
| `notificationPreferences` | 0005 | kiinni |
| `wellbeing` | 0006 | kiinni |
| `bills` | 0007 | kiinni |
| `recurringExpenses` | 0007 | kiinni |
| `savingsGoals` | 0007 | kiinni |
| `aiAudit` | 0008 | kiinni |

Lähde: `src/data/schema.js`. Portit ovat käännösaikaisia vakioita —
niiden muuttaminen vaatii deployn.

Kymmenen porttia odottaa aktivointia. Ks.
`docs/ACTIVATION-0003-0008-RUNBOOK.md`.

---

## Versiot

| | |
|---|---|
| Tuotannon sovellus (`main`) | `81b85e3678ba9f8a6375fa42db0fbbda6851ea8f` |
| Julkaisutagi | `manifestival-prod-v1` |
| Työhaara | `feature/wp-13-20-ultra-product` |

---

## Odottavat asiat

### Laitehyväksyntä

Android-hyväksyntä on siirretty. Ks. `docs/DEVICE-ACCEPTANCE-BACKLOG.md`.
Se ei estä työpöytäaktivointia, koska sovellus toimii selaimessa ja
portit ovat samat.

### Jälkikovennus

`routine_exceptions_unique_day` on `unique (routine_id, date)` eikä
`(user_id, routine_id, date)`. Ristiinkiinnitys on estetty
yhdistelmävierasavaimella, mutta rajoitteiden tarkistusjärjestyksestä
seuraa pieni olemassaolovuoto. Analyysi ja korjausehdotus:
`docs/FOLLOWUP-routine-exceptions-uniqueness.md`.

**Ei estä aktivointia.**

### Avaimen kierrätys

Anthropic-avain on selkokielisenä repositorion ULKOPUOLELLA vanhassa
työpöytävarmuuskopiossa. Kierrätysjärjestys: uusi avain → palvelimen
ympäristömuuttuja → todennus → vanhan kumoaminen → selkokielisen
varmuuskopion poisto.

**Ei kuulu tähän pakettiin eikä estä aktivointia.**
