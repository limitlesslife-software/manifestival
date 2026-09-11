# Manifestival — tuotannon tila

**Päivitetty:** 2026-09-08 (julkaisujuna valmisteltu)
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
| 0009 | `0009_finance_2.sql` | **EI AJETTU** | — |
| 0010 | `0010_goal_to_action.sql` | **EI AJETTU** | — |
| 0011 | `0011_personal_assistant.sql` | **EI AJETTU** | — |

> **⚠ Migraatio 0010 on suunniteltu, ei ajettu — ja se on
> vaarallisempi kuin aiemmat.** Se on ensimmäinen migraatio, joka
> MUUTTAA tauluja joissa on käyttäjän dataa ja joiden portit ovat auki
> tuotannossa (`goals`, `projects`, `tasks`). Se myös korvaa
> `goals_status_check` -rajoitteen. Varmuuskopio ei ole muodollisuus.
> Ks. `docs/GOAL-TO-ACTION.md`.

> **Migraatio 0009 on suunniteltu, ei ajettu.** Se luo taulut
> `transactions` ja `investments` sekä lisää `bills`-tauluun kolme
> maksutietosaraketta. Talous 2.0:n sovelluskoodi toimii ilman sitä:
> portit ovat kiinni, jolloin tieto elää istunnon muistissa. Ajaminen
> vaatii Panun erillisen hyväksynnän.

> **Yhtäkään ajettua ei saa ajaa uudelleen.** Jokainen on fail-closed ja
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
| `transactions` | 0009 | kiinni |
| `investments` | 0009 | kiinni |
| `BILL_PAYMENT_FIELDS` | 0009 | kiinni |
| `milestones` | 0010 | kiinni |
| `GOAL_PLANNING_FIELDS` | 0010 | kiinni |
| `GOAL_MAINTENANCE_MODE` | 0010 | kiinni |
| `inboxItems` | 0011 | kiinni |
| `reminders` | 0011 | kiinni |
| `notices` | 0011 | kiinni |
| `travelPlans` | 0011 | kiinni |
| `locationRules` | 0011 | kiinni |

`GOAL_PLANNING_FIELDS` on **sarakeportti** ja `GOAL_MAINTENANCE_MODE`
**arvoportti**. Ne ovat erillisiä, koska niiden viat ovat erilaisia:
puuttuva sarake kaataa tallennuksen koodilla `42703`, kielletty arvo
koodilla `23514`. Kumpikin koskee tauluja, joiden portit ovat **auki
tuotannossa** — niiden ennenaikainen avaaminen kaataisi myös sen, mikä
toimii tänään.

`BILL_PAYMENT_FIELDS` on **sarakeportti**, ei taulu. `bills`-taulu on
ollut olemassa migraatiosta 0007, mutta sarakkeet `payee`, `iban` ja
`reference` syntyvät vasta migraatiossa 0009 — joten taulun portin
avaaminen ei kerro sarakkeista mitään, ja niillä on oltava oma portti.
Ilman sitä `bills`-portin avaaminen ennen migraatiota 0009 kaataisi
jokaisen laskun tallennuksen tuntemattomaan sarakkeeseen.

Lähde: `src/data/schema.js`. Portit ovat käännösaikaisia vakioita —
niiden muuttaminen vaatii deployn.

**Tämä taulukko on yksi kolmesta lähteestä**, joiden on oltava
keskenään yhtäpitäviä: `src/data/schema.js`, `sw.js` ja tämä. Jokainen
aaltocommitti muuttaa kaikkia kolmea, ja
`npm run activation:verify-wave` kaatuu jos ne erkanevat.

---

## Julkaisujuna 0003–0010

Kolmetoista porttia avataan seitsemässä aallossa (A–E porteille
0003–0008, F migraation 0009 porteille, G migraation 0010 porteille). Ohje ja aaltokohtaiset
hyväksyntäpaketit: `docs/RELEASE-TRAIN-0003-0008.md`.

| Vaihe | Portit | Cache | Valmius | Suunniteltu | Deployattu | Selain | Kanta | Turva |
|---|---|---|---|---|---|---|---|---|
| — | tuotanto nyt | `v12` | — | `63a96c5` | **2026-09-08** | **PASS** | **PASS** | **PASS** |
| **Korjaus** | ei yhtään | `v13` | VALMIS | `beac82e` | — | — | — | — |
| **A** | `notificationPreferences`, `wellbeing` | `v14` | VALMIS | `1c2a6d1` | — | — | — | — |
| **B** | `goals`, `projects` | `v15` | OSITTAINEN | `47cfda8` | — | — | — | — |
| **C** | `routines`, `routineExceptions` | `v16` | VALMIS | `78dc6f8` | — | — | — | — |
| **D** | `recurringExpenses`, `savingsGoals`, `bills` | `v17` | **ESTETTY** | `76ba75d` | — | — | — | — |
| **E** | `aiAudit` | `v18` | VALMIS | `edd9b33` | — | — | — | — |
| **F** | `transactions`, `investments` | `v19` | **ESTETTY** | — | — | — | — | — |
| **G** | `milestones` | `v20` | **ESTETTY** | — | — | — | — | — |
| **H** | `inboxItems`, `reminders`, `notices`, `travelPlans`, `locationRules` | `v21` | **ESTETTY** | — | — | — | — | — |

**Aalto F on estetty, ei kesken.** Sen sovelluskoodi on valmis ja
testattu porttien ollessa kiinni. Este on yksi ja nimetty: migraatiota
`0009_finance_2.sql` **ei ole ajettu tuotantoon**. Portteja ei voi
avata tauluihin, joita ei ole.

Aalto muuttuu VALMIIKSI vasta kun

1. Panu on hyväksynyt migraation 0009,
2. migraatio on ajettu tuotantoon, ja
3. `supabase/verify/verify_0009.sql` antaa 0 poikkeavaa.

> **HUOM. Talous 2.0:n tuotantoversiota ei ole vielä valittu.**
>
> Aallon F cache-versio `v19` koskee porttien avaamista. Talous 2.0:n
> *tuotekoodi* on eri asia: se on uusi julkaisu, joka ei muuta yhtään
> porttia mutta muuttaa sovelluskuorta — ja siksi vaatii oman
> cache-version bumpin deployhetkellä. Sitä ei ole annettu tässä
> haarassa, koska oikea numero riippuu siitä, missä järjestyksessä
> aallot C–E ja Talous 2.0 deployataan. Ks.
> `docs/FINANCE-2.0.md`, kohta "Julkaisujärjestys".

Aaltojen commit-SHA:t: `docs/activation-0003-0008-release-manifest.json`.

> **Yhtäkään saraketta ei merkitä PASSiksi ennen kuin todiste on
> olemassa.**
>
> Tuotannon rivi on nyt PASS: käyttäjä hyväksyi kirjautumisen, istunnon
> palautumisen, tehtävät ja konsolin, precheck antoi 6/6 ja varmistus
> 40/40.
>
> **Sama hyväksyntä löysi kolme vikaa**, joita mikään koneellinen
> tarkistus ei nähnyt: kesto 01:00–02:00 näkyi kolmenakymmenenä,
> hyvinvointia ei löytynyt ja talousosiota ei ole olemassa. Kaksi
> ensimmäistä on korjattu perustilan korjauksessa; kolmas estää aallon
> D. Ks. `docs/UI-REACHABILITY.md`.

### Valmius: pääseekö käyttäjä ominaisuuteen?

| Vaihe | Este |
|---|---|
| **B OSITTAINEN** | `projects`-taululle ei ole käyttöliittymää. `goals` on täysin käytettävissä |
| **D ESTETTY** | Taloudelle ei ole käyttöliittymää lainkaan. **Ei deployata** ennen kuin se on rakennettu |

Portti avaa tallennuksen, ei käyttöliittymää. Taulu voi olla valmis
samalla kun käyttäjä ei pääse siihen käsiksi.

### Perustilan koneellinen todennus

| Mitta | Tulos |
|---|---|
| HTTP | 200 |
| `CACHE_VERSION` tuotannossa | `v12` |
| Porttimatriisi tuotannossa | 0/10 auki |
| `TASK_EXTENDED_FIELDS` tuotannossa | `true` |
| Turvaotsakkeet | ennallaan |
| `npm run production:verify-assets` | **21 / 21 PASS** |

---

## Versiot

| | |
|---|---|
| Tuotannon sovellus (`main`) | `63a96c5ab90b10a73369cd66e348f4a3774367e2` |
| Julkaisutagi | `manifestival-prod-v1` |
| Tagiehdotus junan jälkeen | `manifestival-prod-v2` (ei luotu) |
| Työhaara | `feature/wp-13-20-ultra-product` |
| Julkaisuhaara | `release/activation-0003-0008` |

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
