# Talous 2.0

**Tila:** rakennettu, portit kiinni. **Mitään ei ole deployattu eikä
ajettu tuotantoon.**

Tämä dokumentti kertoo, mitä Talous 2.0 on, mitä se tarkoituksella
**ei** tee, ja mitä sen tuotantoon vieminen vaatii.

---

## Yhteenveto

Manifestivalin talousosio oli laskut, toistuvat menot ja
säästötavoitteet. Ne vastaavat kysymykseen "mitä minun pitää maksaa".
Ne eivät vastaa kysymykseen **"mihin rahani meni"** — eivätkä voineet,
koska kirjattua rahaliikettä ei ollut olemassa.

Talous 2.0 tuo sen:

| Osa | Mitä se on |
|---|---|
| **Tapahtumat** | Yksi taulu menoille, tuloille ja siirroille |
| **Tulot** | `kind = 'income'` — ei omaa tauluaan |
| **Budjetti** | Kuukauden toteuma, sitoumus ja ennuste **erikseen** |
| **Kuitit** | Kuvasta luenta, luennasta **ehdotus**, ehdotuksesta tapahtuma |
| **Laskun skannaus** | Kuvasta lasku, **aina avoimena** |
| **Säästösuunnittelu** | Kuukausierä, kuukaudet maaliin, ehdotus ylijäämästä |
| **Sijoitukset** | Käsin kirjattu salkku ilman keksittyjä kursseja |

---

## Neljä asiaa, joita tämä ei tee

Nämä eivät ole puutteita. Ne ovat suunnittelun päätöksiä, ja ne on
kirjoitettu koodiin rajoitteina eikä muistutuksina.

### 1. Rahaa ei siirretä

**Manifestivalilla ei ole pankkiyhteyttä eikä valtuutta siirtää rahaa.**

- Skannattu lasku syntyy aina tilassa `open` — `toBill()` pakottaa sen
  riippumatta siitä, mitä luennassa luki
- `iban` ja `reference` ovat tietoa, jonka käyttäjä kopioi omaan
  pankkiinsa
- Säästösiirto on kirjaus siitä, että käyttäjä siirsi rahaa itse

### 2. Tekoälyn luenta on aina ehdotus

`toTransaction()` palauttaa `null`, ellei luennan tila ole `APPROVED`,
ja ainoa tapa päästä siihen tilaan on `approveExtraction()`, jota vain
käyttäjän toiminto kutsuu. `applyCorrection()` palauttaa tilan takaisin
tarkistettavaksi — korjattu luenta ei ole hyväksytty luenta.

Automaattista hyväksyntää ei ole eikä siihen ole polkua.

### 3. Kuitin kuvaa ei tallenneta

**Kuittitaulua ei ole.** Ei tässä migraatiossa eikä missään.

Kuitin kuva on koko sovelluksen henkilökohtaisin tieto: se kertoo missä
olit, milloin ja mitä ostit. Luenta elää istunnon muistissa siihen asti
että käyttäjä hyväksyy sen, ja hyväksytystä luennasta syntyy tavallinen
tapahtumarivi. Kuva vapautetaan heti.

Luennan tietomallissa **ei ole kuvakenttää**, joten sitä ei voi
vahingossakaan tallentaa. Taulu jota ei ole, ei voi täyttyä.

### 4. Kursseja ei keksitä

Markkinadatan toimittajaa ei ole. `hasMarketDataProvider()` palauttaa
aina `false`, ja `MARKET_DATA_CONTRACT` kuvaa rajapinnan, jota ei ole
toteutettu.

Sijoituksen arvo on joko **käyttäjän kirjaama** — merkittynä ja
päivättynä, jotta vanhentuminen näkyy — tai **tuntematon**, ja silloin
se sanotaan ääneen. Tuntematon arvo on `NULL`, ei nolla.

Keksitty kurssi olisi pahin mahdollinen virhe tässä sovelluksessa: se
näyttäisi täsmälleen yhtä varmalta kuin oikea.

---

## Kaksoislaskennan esto

Sama euro ei saa näkyä kahdesti. Tämä on Talous 2.0:n vaikein
yksittäinen ongelma, koska sama meno voi olla olemassa kolmena eri
asiana: laskuna, toistuvana menona ja tapahtumana.

Ratkaisu nojaa **lähdetunnisteeseen**, ei summien tai kuvausten
vertailuun:

```
transactions.source_kind  bill | recurring_expense | savings_goal | receipt | investment
transactions.source_id    lähteen tunniste
```

Kolme sääntöä (`src/domain/budget.js`):

1. Maksettu lasku, **josta on tapahtuma**, lasketaan tapahtumana. Laskua
   ei lasketa erikseen.
2. Maksettu lasku **ilman tapahtumaa** lasketaan laskuna. Näin vanhat
   laskut, jotka merkittiin maksetuiksi ennen kuin tapahtumia oli
   olemassa, eivät katoa budjetista.
3. Toistuva meno on **ennuste eikä koskaan toteuma**. Se ei summaudu
   toteutuneisiin menoihin missään tilanteessa.

Siirrot jätetään pois sekä menoista että tuloista: säästöön siirretty
raha on yhä omaa.

### Miksi ei uniikkirajoitetta kannassa

`transactions`-taulussa ei ole eikä voi olla uniikkirajoitetta
lähteelle: sama lasku voidaan perustellusti maksaa kahdessa erässä.
Ehto tarkistetaan siksi sovelluksessa (`hasTransactionFor`) ennen
kirjausta.

---

## Kolme lukua, joita ei summata yhteen

Budjetti pitää kolme asiaa erillään, eikä koskaan yhdistä niitä
"saldoksi":

| | Mitä se on |
|---|---|
| **TOTEUMA** | Kirjatut tapahtumat — tämä on tapahtunut |
| **SITOUMUS** | Avoimet laskut — tämä on tiedossa mutta maksamatta |
| **ENNUSTE** | Toistuvat menot — tämä on odotettavissa |

Manifestival **ei tiedä pankkitilin saldoa eikä voi tietää.** Luku joka
näyttäisi saldolta mutta olisi arvaus on pahempi kuin puuttuva luku.
Käyttöliittymä sanoo tämän ääneen jokaisessa kohdassa, jossa luku voisi
näyttää saldolta.

---

## Raha on kokonaisluku

Jokainen rahasumma on **kokonaisluku sentteinä** (`amount_minor`,
`bigint`) domainista kantaan asti. Liukulukua ei käytetä missään kohtaa
ketjua.

`quantity` sijoituksissa on poikkeus, ja se on tarkoituksellinen:
**määrä ei ole rahaa.** Osakkeita voi olla 12,5 ja kryptoa 0,00031, eikä
määrällä ole valuuttaa. Se on `numeric(20,8)`.

---

## Tietokanta

Migraatio: `supabase/migrations/0009_finance_2.sql`
Varmistus: `supabase/verify/verify_0009.sql`

**TILA: EI AJETTU TUOTANTOON. EI HYVÄKSYTTY.**

| Kohde | Muutos |
|---|---|
| `public.transactions` | uusi taulu |
| `public.investments` | uusi taulu |
| `public.bills` | kolme uutta nullable-saraketta |

Olemassa olevia rivejä ei muuteta, yhtään saraketta ei pudoteta,
yhdenkään tyyppiä ei muuteta. Täyttöä ei tehdä eikä tarvita: vanhalla
laskulla ei ole maksutietoja, ja `NULL` on oikea vastaus siihen.

### Miksi `source_id` ei ole vierasavain

Lähde saa kadota, mutta tapahtuman on säilyttävä. **Maksettu lasku,
joka poistetaan, ei tee maksua tapahtumattomaksi.** Sama perustelu kuin
`ai_action_audit.target_id` -sarakkeessa migraatiossa 0008.

Ristiinkiinnitystä ei silti synny: `source_id` ei ole viite vaan
merkintä alkuperästä. Se ei anna pääsyä mihinkään, koska RLS rajaa
molemmat päät erikseen.

---

## Portit

| Portti | Migraatio | Tila |
|---|---|---|
| `transactions` | 0009 | kiinni |
| `investments` | 0009 | kiinni |
| `BILL_PAYMENT_FIELDS` | 0009 | kiinni |

`BILL_PAYMENT_FIELDS` on **sarakeportti**, ei taulu — sama kuvio kuin
`TASK_EXTENDED_FIELDS`. `bills`-taulu on olemassa migraatiosta 0007,
mutta sarakkeet `payee`, `iban` ja `reference` syntyvät vasta
migraatiossa 0009. Ilman erillistä porttia `bills`-portin avaaminen
ennen migraatiota 0009 kaataisi jokaisen laskun tallennuksen
tuntemattomaan sarakkeeseen (`42703`).

**Portit ohjaavat säilyvyyttä, eivät näkyvyyttä.** Koko Talous 2.0:n
käyttöliittymä toimii porttien ollessa kiinni: tieto elää istunnon
muistissa ja käyttöliittymä kertoo sen. Se voidaan siis hyväksyä
selaimessa ennen kuin yhtäkään porttia avataan.

---

## Julkaisujärjestys

**Tässä on avoin päätös, jota tämä työpaketti ei tee.**

Talous 2.0 on kahta eri asiaa julkaisun kannalta:

1. **Tuotekoodi** — uudet näkymät, domain-moduulit ja repositoriot.
   Ei muuta yhtäkään porttia, mutta muuttaa sovelluskuorta ja vaatii
   siksi oman `CACHE_VERSION`-noston deployhetkellä.
2. **Aalto F** — porttien `transactions`, `investments` ja
   `BILL_PAYMENT_FIELDS` avaaminen. Vaatii migraation 0009.

Aallot A–E on numeroitu `v14`–`v18`, ja aalto F on `v19`. Talous 2.0:n
tuotekoodille **ei ole annettu cache-versiota tässä haarassa**, koska
oikea numero riippuu deployjärjestyksestä:

- Jos aallot C, D ja E deployataan ensin, tuotekoodi tulee niiden
  jälkeen ja saa numeron `v19` — jolloin aalto F siirtyy `v20`:een.
- Jos tuotekoodi deployataan ennen aaltoja C–E, se veisi numeron, joka
  on jo varattu myöhemmälle aallolle — ja seuraava aalto laskisi
  cache-version **taaksepäin**.

**Cache-versio ei saa koskaan laskea.** Selain, joka on kerran nähnyt
numeron `v19`, ei asenna service workeria uudelleen numerolle `v17`, ja
jäisi vanhaan kuoreen pysyvästi offline-tilassa.

Aaltojen C, D ja E release-commitit ovat olemassa paikallisesti, eikä
niitä muokata. Numeron valinta on siksi deploypaketin päätös, ei tämän.

> **Tämä haara on kehityshaara.** `sw.js` on yhä perustilan `v13`, ja
> se on oikein: haaraa ei deployata sellaisenaan. Deploypaketti valitsee
> numeron ja nostaa sen samassa commitissa.

---

## Missä koodi on

| Tiedosto | Vastuu |
|---|---|
| `src/domain/transactions.js` | Tapahtuman malli, suunta, lähde, kaksoislaskennan esto |
| `src/domain/budget.js` | Kuukauden toteuma, sitoumus, ennuste, luokkaerittely |
| `src/domain/receipts.js` | Luenta, tarkistus, hyväksyntä, muunnos |
| `src/domain/investments.js` | Salkku, tuotto, vanhentuminen, markkinadatan rajapinta |
| `src/domain/financeCategories.js` | Kulu- ja tuloluokat |
| `src/domain/finance.js` | Laskut, toistuvat menot, säästötavoitteet, säästösuunnittelu |
| `src/data/collectionsRepo.js` | `transactionsRepo`, `investmentsRepo` |
| `src/data/schema.js` | Portit |
| `src/app/actions.js` | Toiminnot, optimistinen päivitys ja peruutus |

### Kululuokat ovat eri asia kuin elämänalueet

`src/domain/categories.js` sisältää kahdeksan **elämänaluetta** (työ,
terveys, ihmissuhteet…). Ne ovat tehtävien ja tavoitteiden jaottelu.

`src/domain/financeCategories.js` sisältää viisitoista **kululuokkaa**
(asuminen, ruoka, liikkuminen…) ja kahdeksan **tuloluokkaa**. Ne ovat
rahan jaottelu.

Nämä ovat tarkoituksella erillään: "terveys" elämänalueena ja
"terveys" kululuokkana vastaavat eri kysymyksiin, ja yhdistäminen
pakottaisi toisen niistä väärään muotoon.

---

## Mitä seuraavaksi

1. **Migraation 0009 hyväksyntä ja ajo** — Panun päätös. Esitarkistus
   on migraatiotiedoston lopussa ja se on vain lukeva.
2. **Tuotekoodin deploypaketti** — cache-version valinta, ks.
   "Julkaisujärjestys" yllä.
3. **Aalto F** — `docs/acceptance/WAVE-F.md`, estettynä kunnes 1 on
   tehty.
4. **Markkinadatan toimittaja** — rajapinta on kuvattu, toteutusta ei
   ole eikä se estä mitään.
