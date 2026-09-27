# Aktivointi 0003–0008 — tuotannon ajo-ohje

> **Tämä on taustadokumentti.** Varsinainen ajo tapahtuu
> julkaisujunan mukaan: `docs/RELEASE-TRAIN-0003-0008.md` ja sen
> aaltokohtaiset hyväksyntäpaketit `docs/acceptance/WAVE-A.md` …
> `WAVE-E.md`.
>
> Tämä dokumentti selittää **miksi** aallot ovat siinä järjestyksessä
> kuin ovat ja mitä portin kääntäminen tarkoittaa. Juna kertoo
> **miten** se tehdään.

**Tila:** valmisteltu, EI AKTIVOITU. Kaikki kymmenen porttia ovat `false`.

Migraatiot on ajettu ja todennettu. Jäljellä on **vain porttien
kääntäminen** — ei SQL:ää, ei skeemamuutoksia. Tuotannon tila:
`docs/PRODUCTION-STATUS.md`.

---

## Mitä aktivointi tarkoittaa

Portti on käännösaikainen vakio tiedostossa `src/data/schema.js`:

```js
export const TABLES = Object.freeze({
  routines: false,   // <- tämä
  ...
});
```

`false` = tieto elää vain istunnon muistissa ja katoaa sivun
latauksessa. Käyttöliittymä kertoo sen käyttäjälle.
`true` = tieto menee oikeaan kantaan RLS:n takana.

**Portin kääntäminen vaatii deployn.** Se ei ole ympäristömuuttuja eikä
palvelinasetus. Se on siunaus ja rasite: peruminen vaatii toisen
deployn, mutta portti ei voi vaihtua vahingossa ajon aikana eikä eri
käyttäjillä voi olla eri tila.

### Rollback on portin sulkeminen

| Ongelma | Toimenpide |
|---|---|
| Portti auki, jotain vialla | Käännä portti `false` ja deployaa |
| Skeema väärin | **Älä palauta kantaa.** Selvitä syy ensin |
| Vanha `main` (`bd652fa`) | **EI ole turvallinen palautuskohde.** Se on auth-tätä-edeltävä prototyyppi, joka ei toimi nykyistä kantaa vasten |

Portin sulkeminen **ei poista dataa**. Rivit jäävät kantaan
koskemattomina; sovellus vain lakkaa lukemasta ja kirjoittamasta niitä.
Se on turvallisin peruutus mitä on: peruuttava, häviötön ja nopea.

---

## Aktivointijärjestys

Järjestys on johdettu **oikeista vierasavainriippuvuuksista**, ei
migraationumeroista. Automaattinen testi
(`tests/activation-gates.test.mjs`) lukee riippuvuudet migraatioista ja
kaatuu, jos järjestys rikkoo yhtäkään.

| Aalto | Portit | Miksi tässä kohtaa |
|---|---|---|
| **A** | `notificationPreferences`, `wellbeing` | Ei viittauksia mihinkään. Pienin pinta-ala, ja `notification_preferences` on eri omistajuusmalli (pääavain on omistaja) — se on syytä todentaa yksin |
| **B** | `goals`, `projects` | Viittaavat toisiinsa mutta eivät mihinkään ulkopuoliseen. Ovat viittauskohteita aalloille C ja D |
| **C** | `routines`, `routineExceptions` | `routines.goal_id → goals`, joten B on oltava ensin. Poikkeus viittaa rutiiniin, joten ne kuuluvat samaan aaltoon |
| **D** | `recurringExpenses`, `savingsGoals`, `bills` | `bills.recurring_expense_id → recurring_expenses` ja `bills.task_id → tasks`. Kulut on aktivoitava viimeistään samassa aallossa |
| **E** | `aiAudit` | Ei vierasavaimia. Viimeisenä, koska se kirjaa muiden toimintaa — sen kannattaa olla käytössä vasta kun kirjattavaa on |
| **F** | `transactions`, `investments` | Talous 2.0. Kumpikaan ei viittaa mihinkään sovellustauluun, joten riippuvuudet eivät pakota sijaintia. **ESTETTY:** migraatiota 0009 ei ole ajettu |
| **G** | `milestones` | Tavoitteesta tekemiseksi. `milestones.goal_id` viittaa tavoitteeseen, joten aalto B on oltava ensin — ja se on tuotannossa. **ESTETTY:** migraatiota 0010 ei ole ajettu |
| **H** | `inboxItems`, `reminders`, `notices`, `travelPlans`, `locationRules` | Henkilökohtainen avustaja. `travel_plans.task_id` ja `location_rules.task_id` viittaavat tehtävään, joka on tuotannossa; muut kolme eivät viittaa mihinkään sovellustauluun. Riippuvuudet eivät siis pakota sijaintia. **ESTETTY KAHDESTI:** migraatiota 0011 ei ole ajettu EIKÄ yhdelläkään viidestä domainista ole näkymää |
| **I** | `lifeAreas`, `weeklyCapacities`, `timeEntries`, `alignmentReviews` | Suunta (Life Alignment). `goals.life_area_id` ja `time_entries` viittaavat tavoitteeseen ja tehtävään yhdistelmävierasavaimella, joten aalto B on oltava ensin — ja se on tuotannossa. Riippumaton aalloista F–H. Sarakeportti `GOAL_LIFE_AREA_FIELD` kuuluu samaan aaltoon. **ESTETTY:** migraatiota 0012 ei ole ajettu |
| **J** | `runningTimers`, `alignmentItemSettings` | Suunta 2: ajastin ja kuormittavuus. Migraatio 0013 muuttaa 0012:n tauluja, joten aalto I on oltava ensin. Sarakeportti `ALIGNMENT_REALITY_FIELDS` kuuluu samaan aaltoon. **ESTETTY:** migraatiota 0013 ei ole ajettu |
| **K** | `savedPlaces`, `placeAliases`, `calendarEvents`, `commuteObservations`, `lifeSettings`, `sleepLogs`, `habitPlans`, `habitEvents`, `exerciseSessions`, `wellbeingCheckins` | Arjen käyttöjärjestelmä: kymmenen uutta taulua (0014), ei muutoksia olemassa oleviin tauluihin eikä sarakeportteja. Menot ja liikuntakerrat viittaavat tavoitteisiin, muut viitteet ovat aallon omien taulujen välisiä. 0014 edellyttää 0013:a. **ESTETTY:** migraatiota 0014 ei ole ajettu ja näkymät rakennetaan erikseen |

> **Aalto H on ainoa, jolla on KAKSINKERTAINEN este.** Migraatiota
> `0011_personal_assistant.sql` ei ole ajettu, eikä yhdelläkään sen
> viidestä domainista ole käyttöliittymää. Jälkimmäinen on tässä
> junassa uusi lajityyppi: portti avaisi tallennuksen paikkaan, jota
> käyttäjä ei näe. Kirjaus ilman lukemista on tiedon nielu.
>
> Migraatio itse on **vähemmän vaarallinen kuin 0010**: viisi uutta
> tyhjää taulua, ei yhtäkään muutosta olemassa olevaan. Sitä ei silti
> saa ajaa ilman hyväksyntää ja varmuuskopiota.
> Hyväksyntäpaketti: `docs/acceptance/WAVE-H.md`.

> **⚠ Aalto G on estetty, ja sen migraatio on vaarallisempi kuin
> aiemmat.** `0010_goal_to_action.sql` on ensimmäinen migraatio, joka
> MUUTTAA tauluja joissa on käyttäjän dataa (`goals`, `projects`,
> `tasks`) ja joiden portit ovat auki tuotannossa. Se myös korvaa
> `goals_status_check` -rajoitteen: keskeytynyt ajo jättäisi taulun
> ilman tilarajoitetta. Varmuuskopio ja esitarkistus ovat pakollisia.
> Hyväksyntäpaketti: `docs/acceptance/WAVE-G.md`.

> **Aalto F on estetty, eikä sitä saa yrittää ajaa.** Sen ainoa este
> on nimetty: `supabase/migrations/0009_finance_2.sql` on suunniteltu
> mutta **ei ajettu tuotantoon**. Portteja ei voi avata tauluihin,
> joita ei ole — yritys kaataisi jokaisen kirjoituksen koodilla
> 42P01. Sovelluskoodi itse toimii porttien ollessa kiinni, joten
> mikään ei ole rikki: tieto vain elää istunnon muistissa.
> Hyväksyntäpaketti: `docs/acceptance/WAVE-F.md`.

### Miksi ei kaikkia kerralla

Jokainen aalto on oma peruutuspisteensä. Jos jokin menee vikaan viiden
portin ollessa auki, et tiedä mikä niistä aiheutti sen. Yksi aalto
kerrallaan tarkoittaa, että vika näkyy siinä ominaisuudessa jonka juuri
avasit.

---

## PHASE 1 — koodin valmius

```
npm run activation:preflight
```

Tarkistaa 28 asiaa: työpuun tila, että yksikään portti ei ole vahingossa
auki, migraatioiden ja varmistusten olemassaolo, ettei `service_role`
tai AI-avain ole lähdepuussa, sekä testit, syntaksitarkistuksen,
savutestin ja käännöksen.

**Ei ota yhteyttä tuotantoon.** Se tarkistaa repositorion.

Palauttaa nollasta poikkeavan koodin, jos yksikin este on. Ei jatketa
ennen kuin se on vihreä.

---

## PHASE 2 — ennen deployta

Aja Supabasen SQL-editorissa **postgres-roolilla**:

1. `supabase/acceptance/precheck_0003_0008_auth_final.sql` → 6 riviä, kaikki PASS
2. `supabase/acceptance/verify_0003_0008_post_acceptance_final.sql` → 40 riviä, kaikki PASS

Nämä todistavat, että kanta on yhä siinä tilassa, johon aktivointi
nojaa. Jos jompikumpi on FAIL, **pysähdy** — koodi ei ole ongelma.

Kirjaa `tasks`-rivimäärä ja tunnisteiden tiiviste ylös. Niitä verrataan
jokaisen aallon jälkeen.

---

## PHASE 3 — deploy portit kiinni

Deployaa nykyinen koodi tuotantoon **ilman yhtäkään porttimuutosta**.

Tämä on tärkeä välivaihe. Se erottaa kaksi asiaa toisistaan: toimiiko
uusi koodi tuotannossa, ja toimivatko portit. Jos ne deployattaisiin
yhdessä ja jokin menisi vikaan, et tietäisi kumpi.

Bumppaa `CACHE_VERSION`. Se on ainoa asia, joka saa selaimen asentamaan
uuden service workerin ja hakemaan kuoren uudelleen.

---

## PHASE 4 — tuotannon savutesti

Portit ovat yhä kiinni. Tarkista selaimessa:

- [ ] Sovellus latautuu
- [ ] Kirjautuminen toimii
- [ ] Tehtävät näkyvät — **36 kappaletta**
- [ ] Tehtävän luonti, muokkaus ja poisto toimivat
- [ ] Käyttöliittymä kertoo, mikä tieto ei vielä säily
- [ ] Konsolissa ei virheitä

Aja sitten `verify_0003_0008_post_acceptance_final.sql` uudelleen.

**Kaikkien kymmenen taulun on yhä oltava tyhjiä.** Jos sivun lataus
loisi rivejä, se näkyisi tässä. Automaattinen testi lukitsee tämän
paikallisesti, mutta tuotannossa se on todennettava.

---

## PHASE 5 — aktivoi aalto

Käännä **yhden aallon** portit `true`:ksi tiedostossa
`src/data/schema.js`, bumppaa `CACHE_VERSION`, aja
`npm run activation:preflight`.

> Esitarkistus kaatuu tässä kohtaa tarkoituksella: se vaatii, ettei
> yksikään portti ole auki. Tämä on ainoa hyväksytty syy ohittaa se,
> ja vain aktivoitavan aallon osalta. Tarkista, että FAIL koskee
> **täsmälleen** niitä portteja jotka aiot avata — ei yhtäkään muuta.

Deployaa.

---

## PHASE 6 — todenna aalto

### Selaimessa

- [ ] Aallon ominaisuus toimii
- [ ] Luonti tallentuu ja **säilyy sivun latauksen yli**
- [ ] Muokkaus tallentuu
- [ ] Poisto poistaa
- [ ] Käyttöliittymä ei enää kerro, ettei tieto säily
- [ ] Ei virheitä konsolissa

### SQL-editorissa

Aja `verify_0003_0008_post_acceptance_final.sql`.

Odotus tässä vaiheessa: **tarkistus 05 (porttitaulut tyhjiä) EPÄONNISTUU**
niiden taulujen osalta, joihin juuri loit rivejä. Se on oikea tulos —
tarkistus kuvaa hyväksynnän jälkeistä tilaa, ei aktivoinnin jälkeistä.

Näiden on silti oltava PASS:

- [ ] `tasks` = 36 ja tiiviste ennallaan (ellet luonut tehtävää)
- [ ] `profile` = 1
- [ ] Omistajattomia rivejä ei ole
- [ ] Ristiinkiinnitysyrityksiä ei ole
- [ ] RLS päällä kaikissa
- [ ] 40 politiikkaa
- [ ] `anon` = 0, `PUBLIC` = 0
- [ ] 9 yhdistelmävierasavainta
- [ ] Tuntemattomia SECURITY DEFINER -funktioita ei ole

### Tilinvaihto

Jos toinen tili on käytettävissä: kirjaudu ulos, kirjaudu toisella,
varmista ettei ensimmäisen dataa näy. Tämä on automaattitestattu, mutta
tuotannossa se on nopea ja halpa tarkistaa.

### Peruutusehto

Peruuta (portti `false` + deploy), jos:

- data ei säily
- toisen käyttäjän dataa näkyy
- `tasks` ≠ 36 ilman että loit tehtävän
- RLS-, politiikka- tai oikeustarkistus muuttui
- tallennus epäonnistuu hiljaa

---

## PHASE 7 — seuraava aalto

Toista PHASE 5–6 järjestyksessä A → B → C → D → E.

**Älä aloita seuraavaa ennen kuin edellinen on todennettu.**

---

## PHASE 8 — lopullinen hyväksyntä

Kun kaikki viisi aaltoa ovat auki ja todennettuja:

- [ ] Jokainen ominaisuus toimii selaimessa
- [ ] `tasks` = 36 (plus tietoisesti luodut)
- [ ] `profile` = 1
- [ ] Turvatarkistukset ennallaan
- [ ] `npm run activation:preflight` — kaikki paitsi porttitarkistus
- [ ] Päivitä `docs/PRODUCTION-STATUS.md`
- [ ] Merkitse julkaisu tagilla

Sitten laitehyväksyntä: `docs/DEVICE-ACCEPTANCE-BACKLOG.md`.

---

## Mitä tämä ohje EI kata

- **Laitehyväksyntää.** Android on erikseen, eikä se estä työpöytää.
- **`routine_exceptions` -jälkikovennusta.**
  Ks. `docs/FOLLOWUP-routine-exceptions-uniqueness.md`. Ei estä aktivointia.
- **Avaimen kierrätystä.** Oma pakettinsa.
- **Goal-to-Action-moottoria.** Ks. `docs/ADR-goal-to-action-engine.md`.
