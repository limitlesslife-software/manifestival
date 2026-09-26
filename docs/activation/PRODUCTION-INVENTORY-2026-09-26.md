# Tuotannon inventaario 2026-09-26 — havaittu vs johdettu

**Lähde:** omistaja ajoi tänään (2026-09-26) tuotannon Supabasen SQL-editorissa
vain lukevan `supabase/acceptance/activation_readonly_inventory.sql`:n.
Claudelle toimitettiin **yhteenveto**, ei rivin 00 JSON-solua. Tämä
dokumentti kertoo täsmälleen, mitkä koneellisen fixturen
`tests/fixtures/activation-inventory/production-2026-09-26.json` arvot
omistaja **havaitsi** ja mitkä on **johdettu**.

Fixture on merkitty `"reconstructed": true`. Orkestroija
(`tools/activation/orchestrate.mjs`) **ei hyväksy rekonstruoitua
inventaariota migraation perusteeksi**: ennen migraatiota 0009 omistaja
ajaa inventaarion uudelleen ja liittää rivin 00 (`--inventory=<tiedosto>`).
Deployt D ja E eivät muuta kantaa, joten niiden suunnitteluun tämä riittää.

## Pisteytyksen tulos

```
node tools/activation/score-inventory.mjs --code-wave=C tests/fixtures/activation-inventory/production-2026-09-26.json
PÄÄTÖS (kanta): GO
CURRENT_DB_WAVE: E (viimeisin ajettu migraatio 0008)
EXPECTED_CODE_WAVE: E (sallitut koodiaallot: C, D, E)
NEXT_ACTION: DEPLOY D
```

Kanta on migraatiossa 0008 (tukee aaltoja C–E), tuotannon koodi on aalto C
(`cf259d0`, `v16`), joten seuraava turvallinen askel on **aallon D deploy**,
ei migraatio 0009.

## Havaittu (omistajan yhteenveto)

| Rivi | Tarkistus | Arvo | Yhteenvedon sanamuoto |
|---|---|---|---|
| 01 | server_version_num | `170006` | PostgreSQL 17.6 (server_version_num 170006) |
| 02 | PostgreSQL-versio | `17.6` | PostgreSQL 17.6 |
| 40 | hyväksytty omistaja | `1` | approved owner present |
| 41 | auth-käyttäjiä | `1` | auth users 1 |
| 42 | omistajan rivin avaimet | `5` | owner composite keys 5/5 |
| 44 | kelpaamattomat tavoitetilat | `0` | invalid goal statuses 0 |
| 45 | idle in transaction | `0` | idle-in-transaction 0 |
| 50 | taulut ilman RLS:ää | `0` | public tables without RLS 0 |
| 51 | anon-oikeudet | `0` | anon grants 0 |
| 52 | PUBLIC-oikeudet | `0` | PUBLIC grants 0 |
| 60 | tasks.date | `text` | tasks.date text |
| 61 | tasks.time | `text` | tasks.time text |
| 62 | tehtäviä, joilla kesto | `0` | tasks with a duration = 0 |
| 63–74 | rivimäärät | 36, 1, 1, 1, 0, 0, 1, 1, 0, 0, 0, 0 | tasks 36, profile 1, goals 1, projects 1, routines 0, routine_exceptions 0, notification_preferences 1, wellbeing_entries 1, bills 0, recurring_expenses 0, savings_goals 0, ai_action_audit 0 |
| 75–88 | 0009+ taulut | `puuttuu` | tables from 0009+ absent |

## Johdettu (ei havaittu rivinä)

| Rivi | Arvo | Peruste |
|---|---|---|
| 10 | `1` | "migrations 0001–0008 present": 0001 luo `tasks.user_id`. |
| 11–17 | 12, 25, 37, 9, 10, 39, 11 | "migrations 0001–0008 present". Pisteytys tulkitsee migraation ajetuksi vain täydellä objektimäärällä (`EXPECTED` build-inventory.mjs:ssä); yhteenvedon "present" on sama tila. 0004 = 37, koska `routines`-taulu on olemassa (rivi 67 on luku, ei `puuttuu`). |
| 18–22 | 0 | "0009–0013 absent". |
| **43** | `1` | **EI yhteenvedossa.** Migraatiot 0005, 0006 ja 0007 keskeytyvät poikkeukseen, ellei `touch_updated_at` ole INVOKER ja `search_path` kiinnitetty — ja ne kaikki on ajettu. Arvo on siis välttämätön seuraus, ei havainto. |

Ilman johdettuja rivejä pisteytys **pysähtyy ja nimeää puuttuvat rivit**
(`rivi 10 puuttuu`, …, `rivi 43 puuttuu`): se ei oleta puuttuvaa riviä
kunnossa olevaksi (ACT-11). Tämä on testattu
(`tests/activation-inventory.test.mjs`).

## Jätetty pois

| Rivi | Syy |
|---|---|
| 03 | tietokannan nimi: ei yhteenvedossa |
| 04 | inventaarion hetki: ei yhteenvedossa (päivä tiedossa) |
| 30 | 0013:n korvaava lähderajoite: ei yhteenvedossa, eikä pisteytys tarvitse sitä ennen 0012:ta |
| 89 | `duration_minutes > 0`: rivi lisättiin inventaarioon tämän ajon jälkeen |

## Rivi 62 ja 89 — kesto

Rivi 62 laskee `duration_minutes is not null` ja on tuotannossa 0: yhdelläkään
36 tehtävästä ei ole kestoa. Kysymys "tallentaako tuotanto arvioimattoman
keston nollana vai nullina" ei siksi vaikuta tämän päivän tulkintaan. Uusi
rivi 89 (`duration_minutes > 0`) vastaa siihen seuraavassa inventaariossa.
