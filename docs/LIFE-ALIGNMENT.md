# Suunta (Life Alignment)

**Tila:** Suunta 1 (perusta) ja Suunta 2 (toteuma arkeen, ajastin, energia,
katsaus v2) rakennettu paikallisesti, haara `feature/life-alignment-foundation`.
Migraatiot `0012` ja `0013` **EI AJETTU**; portit kiinni, joten tieto elää
istunnon muistissa (ajastin laitteen localStoragessa) ja näkymä sanoo sen.

> Käyttäjä kertoo mikä on tärkeää ja paljonko ehtii. Suunta näyttää, missä
> suunnitelma ja todellisuus poikkeavat siitä — ja käyttäjä päättää mitä
> muuttaa. Sovellus ei päätä arvoja, tärkeyttä eikä suuntaa.

Ketju: **Elämänalueet → Tavoitteet → Kapasiteetti → Tekeminen →
Toteuma / havainnot → Viikkokatsaus → Muutokset ensi viikolle**.

---

## Mallin valinnat ja miksi

| Käsite | Esitys | Miksi |
|---|---|---|
| Elämänalue | Käyttäjän oma rivi (`life_areas`), ei oletusalueita | Sovellus ei päätä mikä on tärkeää. Ehdotukset ovat aloitusapu |
| Tärkeys | 1–5 nimettynä ("Vähän tärkeä" … "Erittäin tärkeä") | Strateginen tärkeys, ei kiire. Ei näennäistarkkuutta |
| Toivottu huomio | **Minuutteja viikossa** (`target_minutes_per_week`); `null` = ei asetettu, `0` = ei nyt | Verrataan suoraan kapasiteettiin ja toteumaan; prosenttien summaa ei tarvitse pitää sadassa. Osuus lasketaan näytettäessä |
| Tavoitteen tärkeys | Olemassa oleva `goals.priority` (3 tasoa) | Uutta kenttää ei tarvittu |
| Tavoite → alue | `goals.life_area_id` (nullable) | Yksi alue per tavoite; vanha tavoite ilman aluetta on kelvollinen |
| Tehtävä/rutiini → alue | **Peritään** tavoitteelta tai projektin tavoitteelta; muuten olemassa olevalta kategorialta (`life_areas.category_key`) | Ei rinnakkaista luokittelua `tasks`-tauluun; vanha data tulee näkyviin ilman täyttöä |
| Kapasiteetti | `weekly_capacities`: minuutit + valinnainen energia 1–5, yksi rivi/viikko (ma) | "Paljonko realistisesti ehdin" on käyttäjän arvio, ei laskelma |
| Suunniteltu | Päivätyt tehtävät + rutiinien esiintymät viikolla; kesto `durationOf()` | Olemassa oleva kesto; puuttuva = **tuntematon**, ei 0 eikä 60 |
| Toteuma | `time_entries` (käyttäjän kirjaama, `source = 'manual'`) | Valmiiksi merkitty ≠ toteutunut aika. Arviota ei kopioida toteumaksi |
| Havainnot | **Lasketaan**, ei tallenneta | Ei vanhenevaa toista totuutta |
| Katsaus | `alignment_reviews`: versioitu tiivis tilannekuva + pohdinta + valitut muutokset | Historia on tarkoituksella jäädytetty |

### Alueen päättely (yksi alue, yksi sääntö — ei kaksoislaskentaa)

```
tehtävä   1. tavoite (ylätavoitteen kautta)  2. projektin tavoite  3. kategoria  4. ei aluetta
rutiini   1. tavoite                          2. kategoria          3. ei aluetta
kirjaus   1. suora alue                       2. tehtävä            3. tavoite    4. ei aluetta
```

Ensimmäinen osuma voittaa. Jokainen kohde lasketaan tasan yhteen alueeseen.

---

## Havaintojen säännöt (tarkat)

Kaikki kynnykset ovat `TIME_RULES`-vientejä tiedostossa
`src/domain/alignmentPolicy.js` (`RULES` alignment.js:ssä on sama olio).
Jokainen havainto kantaa säännön tunnisteen, perustan (`planned`/`actual`) ja
luvut. Perusta näkyy havainnon vieressä sanoin ("suunnitelman perusteella" /
"kirjatun ajan perusteella"); sääntö ja luvut suomenkielisin nimin ovat
kohdassa **"Miksi tämä näkyy?" → "Tekniset luvut"**. Sääntöversion 3 harvan
aineiston rajat: ks. [Sääntöversio 3](#sääntöversio-3-harva-aineisto-ja-ensimmäinen-viikko).

### Kuormitus (`overload`)

- Vaatii käyttäjän asettaman kapasiteetin tälle viikolle.
- `tunnettu suunniteltu > kapasiteetti` → **Huomio**; `≥ 120 %` tai
  kapasiteetti 0 → **Vahva**.
- `tunnettu ≥ 90 %` ja arvioimatonta työtä on → **Tiedoksi** ("voi ylittyä").
- Raportoi: suunniteltu, kapasiteetti, ylitys, prosentti, arvioimattomien määrä.

### Huomiotta jääminen (`neglect`)

Vain aktiiviset alueet, joiden **tärkeys ≥ 4** ja **tavoite ≥ 30 min**.

- **Toteumaan perustuva** (vain kun alueen seuranta on **vakiintunut**, ks.
  sääntöversio 3): `toteuma < 50 % × tavoite × seurantajakson osuus` →
  **Huomio**. Odotettu lasketaan seurantajakson alusta (myöhäisin: viikon
  maanantai, ensimmäinen koskaan kirjattu päivä, alueen luontipäivä), ei
  maanantaista. **Vahva**: viikko päättynyt, jakso kattoi ≥ 6/7 viikosta ja
  toteuma alle 25 %.
- **Suunnitelmaan perustuva** (muuten): `suunniteltu < 50 % tavoitteesta` →
  **Tiedoksi** (suunnitelma on vielä muutettavissa). Jos alueella on
  **avoimia** arvioimattomia asioita (`openUnknownCount`), sääntö on
  `neglect.plan_unknown` ("suunnitelman kesto ei vielä tiedossa"): vajetta ei
  väitetä, eikä sitä käytetä suojattuun aikaan, painotukseen,
  varausehdotukseen, tavoitteen muutokseen eikä katsauksen "Mikä jäi
  huomiotta?" -vastaukseen. Valmiiksi merkitty ilman kestoa ei laukaise sitä
  (arviointi ei kysy valmiita); teksti kertoo sen tietona ("Tiedoksi: 1
  valmiiksi merkitty ilman kestoa ei ole mukana.").
- Maanantaina toteumaa ei verrata. Vähemmän tärkeä alue, tavoite 0/puuttuu tai
  pois käytöstä oleva alue ei ole koskaan "huomiotta".
- Teksti sanoo "kirjattu X", ei "on saanut X": kirjattu aika ei ole eletty aika.
  Kesken viikon alkanut vertailu sanotaan: "(viikon tavoite 10 h, vertailu
  1.10. alkaen)".
- "Tekniset luvut": `plannedMinutes` = "Arvioitu suunniteltu (min)",
  `percentOfTarget` = "Arvioitu tavoitteesta (%)" — arvioimaton ei ole nolla.

### Poikkeama tavoitteista (`misalignment`)

- Toivottu osuus = alueen tavoite / kaikkien aktiivisten tavoitteiden summa.
- Perusta: toteuma, jos seuranta on **vakiintunut** ja alueisiin liitettyä
  aikaa ≥ 120 min; muuten suunnitelma (sama raja), mutta vain jos vähintään
  50 % viikon asioista on arvioitu; muuten ei arvioida.
- Toteuman jakauma: alue, joka luotiin kirjatun ajan vertailujakson alun
  **jälkeen** (esim. lauantaina), ei ole vertailussa kumpaankaan suuntaan,
  eikä sen tavoite ole toivotussa jakaumassa: toivottu osuus ja alueiden
  kirjattu aika lasketaan koko jakson olemassa olleista alueista
  (`excludedAreaCount`, `comparedTargetsMinutes`; "Miksi?" kertoo rajauksen).
- Suunnitelman jakauma: alue, jonka **avoimelta** työltä puuttuu kesto, ei saa
  osuusväitettä eikä tavoitteen muutosehdotusta (tuntematon ei ole nolla).
- `|toteutunut % − toivottu %| ≥ 15 pp` → **Huomio**, `≥ 25 pp` → **Vahva**
  (suunnitelmaan perustuva enintään Huomio; toteumaan perustuva enintään
  Huomio, kunnes viikko on päättynyt).
- Jos alle 60 % ajasta on liitetty alueisiin, tai suunnitelmasta on arvioitu
  50–79 % → **Tiedoksi** ja "suuntaa-antava".
- Tavoite 0 on päätös (siihen kulunut aika on poikkeama); puuttuva tavoite ei.
- Alue, joka on "huomiotta" (todettu vaje), ei saa poikkeamaa kumpaankaan
  suuntaan: vajetta ei raportoida kahdesti, eikä alue voi samaan aikaan viedä
  liikaa (ristiriita).
- Otsikko ja teksti kertovat perustan: "Työ vie **suunnitelmassa** enemmän
  kuin halusit", "Työ sai 62 % **kirjatusta** ajastasi".

### Jännite (`target_tension`)

Alueiden tavoitteiden summa > kapasiteetti → **Tiedoksi**. Tärkeyttä,
tavoitetta tai kapasiteettia ei muuteta puolesta.

### Aineiston laatu

`good` / `partial` / `weak` / `none` + syyt: ei alueita, ei tavoitteita, ei
kapasiteettia, arvioimatonta työtä (avoimet asiat; valmiiksi merkityt ilman
kestoa erikseen tietona `unestimated_completed`), liittämätöntä työtä, ei
toteumaa, **osittainen kirjaus** (`partial_actual`: seuranta `early` tai
`partial`). Kattavuusprosentit: arvioitu osuus, alueeseen liitetty
suunniteltu ja toteuma; lisäksi seurannan taso (`trackingLevel`) ja syy
(`trackingReason`), kirjauspäivät (`trackedDays` / `trackingWindowDays`) ja
kirjattu osuus käyttäjän viitteestä (`loggedSharePercent`,
`loggedShareBasis`).

## Sääntöversio 3: harva aineisto ja ensimmäinen viikko

Lähtötilanne, jolle tämä on tehty: kymmeniä tehtäviä ilman kestoa, ei
alueita, ei kirjauksia, Suunta on uusi. Ennen versiota 3 yksi 45 min
kirjaus torstaina teki kolmesta alueesta "Huomio: jäämässä huomiotta" ja
katsauksesta "Vahva"; kahden arvioidun tehtävän jakauma näkyi päivän
tärkeimpänä havaintona. **Päivä ilman kirjauksia on tuntematon, ei nolla.**

### Seurannan kypsyys (`trackingMaturity`, `analysis.tracking`)

Seurantajakso alkaa myöhäisimmästä: viikon maanantai, **ensimmäinen koskaan
kirjattu päivä**, alueen luontipäivä (koko viikolle: Suunnan käyttöönotto =
aikaisin alueen luontipäivä). Sovelluskerros antaa luontipäivän paikallisena
päivänä (`startDate`); domain ei lue kelloa. `createLifeArea` asettaa
`createdAt`:n heti (kanta korvaa omallaan latauksessa).

| Taso | Ehto (`reason`) |
|---|---|
| `none` | viikolle ei ole kirjauksia |
| `early` | jaksosta kulunut < 3/7 viikkoa (`window`) **tai** kirjauksia < 2 päivältä (`days`) |
| `partial` | kirjauspäiviä < puolet jakson kuluneista päivistä, ylöspäin (`days`), **tai** viitettä ei ole (`no_reference`), **tai** kirjattu aika < 50 % viitteestä (`share`) |
| `established` | muuten — vain tällä tasolla toteumaa verrataan tavoitteisiin |

**Viite** (`referenceBasis`, `referenceMinutes`) on luku, jonka *käyttäjä
itse* on ilmoittanut; ensimmäinen olemassa oleva:

1. `capacity`: viikon kapasiteetti × jakson osuus
2. `targets`: aktiivisten alueiden viikkotavoitteiden summa × jakson osuus
3. `planned`: jakson päiville tähän päivään asti päivätyn arvioidun työn summa

Nolla ei ole viite. Ilman viitettä taso on enintään `partial`: kirjattua
aikaa ei voi suhteuttaa mihinkään, eikä viitettä keksitä.

**Hystereesi viikon sisällä:** kriteerit arvioidaan jakson jokaisen
kuluneen päivän lopussa (jakso ja kirjaukset siihen päivään asti). Kun
`established` saavutettiin jonain aiempana päivänä (`establishedSince`),
taso pysyy loppuviikon (`held: true`), ellei päiväkattavuus petä. Muuten
perjantaiaamu (viite kasvaa, päivän kirjaukset puuttuvat) pudottaisi tason.
`loggedSharePercent` näyttää silti nykyisen osuuden.

Ajastimella ja käsin kirjattu päivä ovat samanarvoisia todisteita
seurannasta; minuutteja ei painoteta lähteen mukaan. Katsauksen
"Tiedossa"-rivi näyttää jaon (ajastimella / käsin).

Aineiston laatu (`partial_actual`) sanoo syyn: "Aikaa on kirjattu vain N
päivänä ikkunan M päivästä, …" (`days`) on eri asia kuin "Kirjattu aika
kattaa vasta noin X % arvioimastasi ajasta, …" (`share`; tavoitteista:
"aikatavoitteidesi mukaisesta ajasta", suunnitelmasta: "tähän mennessä
suunnittelemastasi ajasta"). Ilman viitettä: "Kirjattua aikaa ei voi vielä
suhteuttaa mihinkään …" ilman "Kirjaa aikaa" -toimenpidettä.

### Kynnykset (`TIME_RULES`, `REVIEW_RULES`)

| Vakio | Arvo | Mitä |
|---|---|---|
| `ACTUAL_MIN_TRACKED_DAYS` | 2 | kirjauspäiviä vähintään |
| `ACTUAL_MIN_DAY_COVERAGE` | 0,5 | kirjauspäiviä vähintään tämä osuus jakson kuluneista päivistä |
| `ACTUAL_MIN_LOGGED_SHARE` | 0,5 | kirjattu ≥ osuus × viite (kapasiteetti / tavoitteiden summa × jakson osuus, tai jakson arvioitu suunnitelma) |
| `STRONG_MIN_TRACKED_FRACTION` | 6/7 | vahva huomiotta jääminen vain, kun jakso kattoi lähes koko viikon |
| `PLAN_MIN_ESTIMATE_COVERAGE` | 0,5 | suunnitelman jakaumaa ei arvioida alle tämän arvioidun osuuden |
| `PLAN_FULL_ESTIMATE_COVERAGE` | 0,8 | 0,5–0,8: suunnitelman jakauma enintään Tiedoksi ("suuntaa-antava") |
| `REVIEW_RULES.CAPACITY_MIN_TRACKED_FRACTION` | 6/7 | kapasiteettikysymys kirjatusta ajasta vain vakiintuneesta, lähes koko viikon kirjauksesta |

**Miksi kirjattu osuus on puolet ja miksi viite on aina käyttäjän oma
luku:** sääntöversio 3:n ensimmäinen muoto käytti 25 % ja tarkisti osuuden
vain kapasiteetin kanssa. Auditoinnin skenaario S2 (kapasiteetti 30 h, 70
min päivässä yhdelle alueelle) teki silloin torstaista alkaen muista
tärkeistä alueista "jäämässä huomiotta": 70 min päivässä on noin 27 %
kapasiteetista, eli suurin osa viikosta on kirjaamatonta — tuntematonta,
ei nollaa. Ilman kapasiteettia kaksi 10 minuutin kirjausta riitti
"vakiintuneeksi", ja neljästä 10 minuutin kirjauksesta syntyi katsaukseen
"Vahva" ja tavoitteen muutosehdotus. Nyt osuus on puolet, ja viite on
kapasiteetti, tavoitteiden summa tai jakson arvioitu suunnitelma — aina
jotain, minkä käyttäjä on itse sanonut. Viitettä ei keksitä: ilman sitä
toteumaa ei verrata. Seuraus: toteumaan perustuva kapasiteettikysymys
("Pienennetäänkö…?") syntyy vain viikosta, jossa kirjattiin vähintään
puolet kapasiteetista; vähemmän kirjannut viikko kertoo kirjaamisesta, ei
kapasiteetista.

### Harvat arviot

- `SPARSE_ESTIMATES_NOTICE` = **"Suunnan arvio tarkentuu, kun lisäät
  aika-arvioita."** näkyy, kun alle 80 % viikon asioista on arvioitu
  (`estimateConfidence`: `sparse` < 50 %, `partial` < 80 %, muuten `ok`):
  ENSIMMÄISENÄ Suunnan havaintojen yläpuolella (`role="status"`, "Arvioi
  tehtäviä") ja päivän kortin ensimmäisenä rivinä. Havainnot näkyvät yhä
  sen alla: sovellus on käytettävä vähälläkin aineistolla.
- Päivän havainnoissa arvioimaton työ nousee `sparse`-tilassa sijalle 4
  (ennen huomio-tason suunnitelman havaintoja).
- "Kapasiteettia jäljellä X" sanotaan arvioimattomien kanssa muodossa
  "…jäljellä X arvioidun työn jälkeen; N asiaa ilman kestoarviota ei ole
  mukana."
- Arvioimattomien laskussa käytetään avoimia asioita
  (`planned.openUnknownCount`); valmiiksi merkityt ilman kestoa kerrotaan
  tietona ("N valmiiksi merkittyä ilman arviota (ei lasketa kuormaan)"),
  koska arviointi ei kysy niitä.

### Ensimmäinen katsaus

- Katsauksen alussa **Tiedossa / Ei tiedossa / Ei kirjattu**: arvioitu työ
  (kestoarvio N/M asialla), kirjattu aika päivineen ja lähteineen;
  arvioimattomat ("kokonaiskuormaa ei tiedetä") ja alueet, joiden
  suunnitelmasta puuttuu kesto ("N alueen suunnitelmasta puuttuu kesto
  (Perhe, Työ)."); päivät ilman kirjauksia ("4 päivää ilman kirjauksia —
  tuntemattomia, eivät nollaa." / "1 päivä ilman kirjauksia — tuntematon,
  ei nolla.").
- "Mikä jäi huomiotta?" luettelee vain todetut vajeet (`isNeglectShortfall`);
  `plan_unknown`-alueet ovat "Ei tiedossa" -rivillä.
- Ei vakiintunutta kirjausta: "Kirjattu X N päivänä (kirjaukset alkoivat
  <pvm>). Päivät ilman kirjauksia ovat tuntemattomia, eivät nollaa."
- Ei kuormitusta mutta arvioimattomia: "Arvioitu työ (X) mahtui
  kapasiteettiin (Y); N asiaa ilman arviota, joten kokonaiskuormaa ei
  tiedetä." — ei "Suunnitelma mahtui kapasiteettiin".
- Ehdotukset: kapasiteettia ei ehdoteta kirjatun ajan perusteella
  osittaisesta viikosta; tavoitteen muutos (huomiotta jäämisen haara) vain
  vakiintuneesta toteumasta. **Kumpikaan haara** (huomiotta jääminen,
  poikkeama) ei esitäytä alle 30 min arvoa: silloin ehdotusta ei tehdä
  (0 tai 15 min = käytännössä "ei nyt" hiljentäisi alueen). Suuntaa-antavasta
  poikkeamasta ei ehdoteta tavoitteen muutosta. Uusi ohjaava ehdotus
  `start_tracking` ("Kirjaa aikaa koko ensi viikon, niin katsaus voi verrata
  toteumaa tavoitteisiin") kun kirjaus alkoi mutta ei vakiintunut; ei
  kirjoita mitään.
- Ensimmäistä Suunta-viikkoa ei verrata Suuntaa edeltäneeseen viikkoon
  ("Ensimmäinen Suunta-viikko — vertailu alkaa ensi viikolla."), eikä
  kehitys ulotu Suuntaa edeltäneisiin viikkoihin. Suunniteltu-rivi kertoo
  arvioimattomat ("arvioimattomia A → B"); jos jommallakummalla viikolla
  alle 50 % on arvioitu, suunniteltua ei verrata. Suunnitellun ajan kehitystä
  ei sanoiteta, jos jollakin viikolla alle 80 % oli arvioitu.
- Historia, kun katsauksen kirjaus ei ollut vakiintunut: syyn mukaan
  "(kirjauksia vain N päivänä)", "(toteumaa ei verrattu: vähän kirjattua
  aikaa)" (`share`) tai "(toteumaa ei verrattu: ei kapasiteettia eikä
  tavoitteita)" (`no_reference`).

### Vajaa lataus ja virheelliset arvot

- Jos jonkin analyysin syötteen (alueet, kapasiteetit, kirjaukset,
  katsaukset, ajastimet, asetukset, tehtävät, rutiinit, poikkeukset,
  tavoitteet, projektit) lataus epäonnistui (`analysisLoadProblems`),
  havainnot, laatu, katsaus ja ehdotukset korvataan ilmoituksella, eikä
  katsausta tallenneta (`{ok:false, code:'incomplete_data'}`): "Kaikkia
  tietoja ei saatu ladattua, joten katsausta ei tallennettu vajailla
  luvuilla. Pohdintasi on yhä kentässä – päivitä, kun yhteys toimii."
- Muutosehdotuksen kelvoton arvo näytetään kentän vieressä ("Anna tunnit,
  esim. 5 tai 2,5." / 0–168 h -raja) ennen vahvistusta; ryhmä ei jatka
  puolittain ja nimeää epäonnistuneet.

---

## Viikkokatsaus ja muutokset

Seitsemän kysymystä (`REVIEW_QUESTIONS`): mikä oli tärkeää, mitä suunnittelin,
mitä tapahtui, missä kuormitus ylittyi, mikä jäi huomiotta, missä todellisuus
poikkesi, mitä muutan. Ei valmistumisprosenttia pääviestinä.

Ehdotukset (`proposeAdjustments`) — **mikään ei muutu ennen vahvistusta**,
jokainen erikseen, ja sama ehdotus ei toteudu kahdesti:

| Ehdotus | Milloin | Mitä tekee vahvistettuna |
|---|---|---|
| Aseta ensi viikon kapasiteetti | ei asetettu | tallentaa kapasiteetin (käyttäjä muokkaa arvon) |
| Kevennä ensi viikkoa | ensi viikon suunnitelma > kapasiteetti | siirtää liittämättömät ja vähiten tärkeät tehtävät viikolla eteenpäin |
| Keskeytä tavoite | kuormitus; alueen tärkeys ≤ 2 | tavoitteen tila `paused` (ei katoa) |
| Varaa aikaa alueelle | huomiotta jääminen (ei `plan_unknown`) | luo tehtävän ensi maanantaille alueen tärkeimpään tavoitteeseen |
| Muuta alueen tavoitetta | huomiotta jääminen vakiintuneesta toteumasta / poikkeama (ei suuntaa-antava, ei arvioimatonta aluetta); esitäytetty arvo aina ≥ 30 min | päivittää tavoitteen (käyttäjä muokkaa arvon) |
| Kirjaa aikaa koko ensi viikon | kirjaus alkoi mutta ei vakiintunut (v3) | ei kirjoita mitään: avaa ajan kirjauksen |

## Palaute Tavoitteesta tekemiseksi -moottorille

`planningFeedback()` → suunnittelun konteksti (`buildPlanningContext`) rajaa
viikon vapaan ajan käyttäjän omaan kapasiteettiin (raja vain laskee).
Suunnittelunäkymä kertoo syyn. Huomiotta jäävät alueet ja yli-edustetut
alueet välitetään tunnisteina — ei mallille.

## Tekoäly

Havainnot ovat deterministisiä; testi vartioi, ettei domain tuo mitään
ai-kerroksesta. `src/ai/alignmentContext.js` rakentaa selitystä varten
minimoidun kontekstin (luvut, havainnot, aluenimet tunnuksina A1…, ei
otsikoita/muistiinpanoja/pohdintoja). Suunta 2 lisäsi valinnaisen
kutsupolun (`/api/explain`, ks. "Tekoälyselitys" alla), joka on oletuksena
pois; deterministinen selitys (`explainSignal`) on aina varapolku ja oletus.

## Laajennuspisteet

Life Alignment lukee normalisoidun viikkoaineiston (`analyzeWeek`). Uusi lähde
tuottaa samoja faktoja:

- **Kalenteri** → suunniteltu ja toteutunut aika (uusi `time_entries.source`
  omalla migraatiollaan)
- **Talous** → rahan sitoumukset/toteuma alueittain (erillinen ulottuvuus;
  rahaa ei sekoiteta aikaan)
- **Hyvinvointi** (`wellbeing_entries.energy`) → voi suostumuksella vain
  ehdottaa energia-arviota; ei koskaan kirjoita kapasiteettia. Energiakuorma
  lasketaan Suunta 2:ssa käyttäjän omista kuormittavuusmerkinnöistä (ks. alla)
- **Terveys/aktiivisuus** → energian ja liikkeen näyttö

## Suunta 2 — toteuma arkeen

### Sääntöpolitiikka ja versio

Kaikki kynnykset ovat yhdessä moduulissa `src/domain/alignmentPolicy.js`
(`TIME_RULES`, `ENERGY_RULES`, `DAILY_RULES`, `QUALITY_RULES`,
`REVIEW_RULES`, `TREND_RULES`, `TIMER_RULES`). Ensimmäisen version ajan
kynnykset ovat ennallaan (`RULES` alignment.js:ssä on sama olio); versio 3
lisäsi harvan aineiston rajat (ks. yllä). Kynnyksiä ei näytetä käyttäjälle
säädettävinä.

`POLICY_VERSION = 3` (versio 2: energia ja päivän havainnot; versio 3: harvan
aineiston rajat) tallentuu viikkokatsauksen tilannekuvaan
(`snapshot.policyVersion`, 0013:n jälkeen myös sarakkeeseen). Katsaus ilman
versiota on versio 1. Vanhoja tilannekuvia **ei lasketa uudelleen**; historia
ja vertailu näyttävät millä säännöillä viikko arvioitiin.

### Toteuma: nopea kirjaus ja ajastin

| Mistä | Mitä |
|---|---|
| Suunta → Pikatoiminnot | Aloita ajanseuranta · Kirjaa aikaa (alue valittavissa) |
| Tehtävän lomake | Kirjaa aikaa · Aloita ajastin |
| Projektin lomake | Kirjaa aikaa · Aloita ajastin |
| Tänään → rutiinin esiintymä | Kirjaa (esiintymän identiteetti: rutiini + päivä) |
| Tänään → Suunta-kortti | Kirjaa aikaa |
| Tehtävän valmistuminen | "Kirjataanko tähän käytetty aika?" 15 min / 30 min / Arvio (hyväksyn arvion toteumaksi) / Muu / Ohita |

**Ajastin** (`src/domain/timer.js`): kesto = (tauon alku tai nyt) − alku −
taukojen summa. Aikaleimat ovat totuus; näytön päivitys on vain näyttöä.
Keskiyön ylittävä ajastus jaetaan päiville paikallisen keskiyön kohdalta
(keskiyö rakennetaan kalenterista, joten kesäajan 23/25 tunnin päivät
toimivat; yli 24 h päivä pilkotaan kahteen kirjaukseen). Tauot jaetaan
päiville suhteessa. Alle puolen minuutin ajastus ei tuota kirjausta; yli
12 h pyydetään tarkistamaan. Tulevaisuuden alku hylätään; kello taaksepäin
→ 0 eikä negatiivista. Aikavyöhykkeen vaihto ei muuta kestoa.

**Pysyvyys:** ajastin laitteen localStoragessa käyttäjäkohtaisella avaimella
(sisällön userId tarkistetaan), kannassa `running_timers` 0013:n jälkeen
(YKSI käyttäjää kohti, `unique (user_id)`). Kanta voittaa laitteen kopion.
Uloskirjautuminen tyhjentää tilan; A:n ajastin ei näy B:lle. Tilin poisto
poistaa laitteen kopion.

**Idempotenssi:** jokaisella kirjauksella on operaatiotunniste
(`timer:<id>[.<n>]`, `task-done:<id>:<hetki>`, `routine:<id>:<päivä>[:<n>]`,
`log:<id>`). Sama operaatio tallentuu kerran: tilassa, kesken olevana ja
kannassa (`unique (user_id, operation_id)`, 23505 = jo perillä).

**Offline:** kapea lähtökori vain aikakirjauksille (`src/app/timeEntryWriter.js`).
Verkkovirhe → kirjaus jää tilaan ja koriin; paluu → lähetys järjestyksessä,
pysähtyy ensimmäiseen verkkovirheeseen; hylätty ei uusiudu loputtomiin;
istunnon vaihto keskeyttää. Yleistä offline-jonoa ei laajennettu. Ennen
0013:a sarakeportti `ALIGNMENT_REALITY_FIELDS` pitää uudet sarakkeet pois ja
ajastinkirjaus tallentuu lähteellä 'manual' (minuutit ja kohde säilyvät).

**Alueen päättely kirjaukselle:** suora alue > tehtävä > rutiini > projekti >
tavoite. Ensimmäinen osuma voittaa; sama minuutti ei päädy kahteen alueeseen.

### Energia (ENERGY_OVERLOAD)

Kuormittavuus 1 kevyt · 2 melko kevyt · 3 keskitaso · 4 kuormittava · 5
erittäin kuormittava tehtävälle, rutiinille tai projektille (tehtävä perii
projektin arvon, jos omaa ei ole). Merkitsemätön = tuntematon; mitään ei
päätellä otsikosta. Tallennus omaan tauluun `alignment_item_settings` (ei
tasks-saraketta).

```
kuormittava aika = Σ kesto (min) niistä viikon suunnitelluista kohteista,
                   joiden kuormittavuus >= 4          (ei painoja)
raja             = weekly_capacities.energy_budget_minutes (käyttäjän oma)

energy.heavy_exceeds_budget    raja asetettu, kuormittava > raja       -> Huomio
                               kuormittava >= 1,2 x raja tai raja 0    -> Vahva
energy.possible_with_unrated   kuormittava >= 0,9 x raja ja osa
                               kestollisesta työstä on arvioimatta     -> Tiedoksi
energy.low_energy_heavy_share  ei rajaa; oma energia-arvio <= 2;
                               kuormittavaa >= 50 % tunnetusta ajasta
                               ja >= 2 h                                -> Tiedoksi
```

TIME_OVERLOAD (`overload`) ja ENERGY_OVERLOAD (`energy_overload`) ovat eri
havaintoja; yhdistettyä pistettä ei ole. Selitys sanoo "Aikaa näyttäisi
olevan riittävästi, mutta suunniteltu viikko on energiakuormaltaan raskas",
kun aika ei ylity.

### Päivän Suunta

Enintään 3 havaintoa, deterministinen järjestys: 1 vahva kuormitus · 2 vahva
huomiotta jääminen · 3 vahva poikkeama · 4 energiakuormitus · 5–7 huomio-tason
aikahavainnot · 8 luokittelematon työ (≥ 3) · 9 aineiston laatu (≥ 3
arvioimatonta / ei kapasiteettia; harvalla arvioaineistolla sija 4) · 10
tiedoksi. Ensimmäinen on "Tänään kannattaa huomata", ja jokainen kertoo
"Miksi tämä?" ja perustan. Harvan arvioaineiston ilmoitus on kortin
ensimmäinen rivi. Lisäksi tilarivit:
kapasiteettia jäljellä, kuormittavaa jäljellä rajasta, tämän päivän yhteys
hyvin tärkeisiin alueisiin. Ei ilmoituksia, ei kaavioita.

### Aineiston laatu v2 ja työnkulut

Jokainen puute on lause ja toimenpide (`src/domain/alignmentQuality.js`):
"42 % tämän viikon suunnitelluista asioista ei sisällä aika-arviota" →
Arvioi tehtäviä; "Vain 35 % kirjatusta ajasta on yhdistetty
elämänalueisiin" → Kohdista; "Et ole vielä kirjannut toteutunutta aikaa" →
Kirjaa aikaa. Arviointi: 10 min / 30 min / 1 h / 2 h / muu + "karkea arvio".
Kohdistus yksi kerrallaan: liitä tavoitteeseen, kytke alueeseen kuuluvaan
kategoriaan, **jätä tarkoituksella ilman aluetta** (ei muistuteta uudelleen)
tai ohita nyt. Tehtävää ei liitetä suoraan alueeseen (0012:n periaate).

### Viikkokatsaus v2, vertailu ja kehitys

Osiot: SUUNTA (mitä sanoin tärkeäksi) · SUUNNITELMA · TOTEUMA · POIKKEAMAT
(ml. kuormittavuus) · MIKSI? (viisi valinnaista pohdintakysymystä,
`reflection_answers`, ei tekoälylle) · ENSI VIIKKO (ehdotukset).

Vertailu edelliseen viikkoon kertoo vain erot ("12 h → 15 h"); toteumaa ei
verrata, jos toisella viikolla ei ole kirjauksia; eri sääntöversiot
mainitaan. Kehitys ("kasvoi/väheni") vasta kun ≥ 3 peräkkäistä viikkoa
muuttuu samaan suuntaan ja ≥ 60 min; kuormituksen toistuvuus lukuna. Kehitys
lasketaan vasta pyydettäessä. Ei elämänpisteitä, ei tulostaulua.

### Tasapainotus ja esikatselu

Uudet ehdotukset: kapasiteettioletus kirjatun toteuman perusteella (vain kun
viikko on päättynyt, kirjaaminen oli vakiintunut ja kattoi ≥ 6/7 viikosta,
ja poikkeama ≥ 25 % ja ≥ 2 h; kysymyksenä), arvioi
ensi viikon arvioimattomat (ohjaava, ei kirjoita), hiljainen tavoite (ei
tekemistä 3 viikkoon, alue ≤ 3 tai matala prioriteetti). Tavoitteen muutos on
kysymys: "Pidetäänkö tavoite vai muutetaanko suunnitelmaa?" — ei väitettä,
että tavoite oli väärä.

`previewAdjustments` soveltaa valinnat kopioon ja näyttää ensi viikon ennen
ja jälkeen (suunniteltu, kapasiteetti, havainnot, alueet). Ryhmä vahvistetaan
yhdellä dialogilla, joka luettelee jokaisen muutoksen; mikään ei muutu
ennen sitä. Esikatselu mitätöityy mistä tahansa tilamuutoksesta.

### Tavoitteesta tekemiseksi

Suunnittelija saa lukumuotoiset rajat (`buildPlanningConstraints`):
jäljellä oleva kapasiteetti, tärkeiden vajaiden alueiden suojattu aika ja
lukumäärä, kuormittavaa jäljellä, arvioimattomien määrä. Palvelin päästää läpi
vain nimetyt lukukentät (`api/_validatePlan.js`). Ennen hyväksyntää
suunnitelma ajetaan samojen sääntöjen läpi (`validatePlanAlignment`):
"Suunnitelma mahtuu kapasiteettiin." / "…ylittää kapasiteetin 3 h (viikko
…)" / "…ei mahdu tärkeän alueen Perhe tavoitetta (puuttuu 10 h)". Tarkistus
ei estä hyväksyntää.

### Tekoälyselitys (valinnainen)

**Oletuksena pois** kahdella kytkimellä: selaimen `AI_EXPLAIN_ENABLED`
(`src/ai/alignmentExplainClient.js`, `false`) ja palvelimen
`EXPLAIN_ENABLED` (Vercel, ei asetettu → 503 ilman verkkokutsua).
Käyttöönotto on omistajan päätös (`docs/SUUNTA-ACTIVATION-GO-NOGO.md`).
Pois ollessa painiketta ei ole, ja havainnon "Miksi tämä näkyy?" on
selitys.

Päällä: "Selitä tekoälyllä" (vihje: "Lähettää vain luvut, ei nimiä eikä
otsikoita") havainnon "Miksi?"-osiossa → `/api/explain`
(`api/explain.js`, `api/_validateExplain.js`): vain valittu havainto ja
sen tarvitsemat alueet (kuormitus: ei alueita; tavoitejännite: tärkeys ja
tavoite), alueet tunnuksina A1…, ajat tunteina tuntinimisissä kentissä
(`targetHours`), lueteltuja arvoja; ei otsikoita, ei pohdintoja, ei
sääntötekstiä. Säännöt ovat palvelimella `system`-kentässä: ne kieltävät
tärkeyden/tavoitteiden/kapasiteetin muuttamisen, diagnoosit ja
moralisoinnin. Vastaus hylätään, jos se on kesken jäänyt tai kieltäytyvä
(`stop_reason` ≠ `end_turn`), yli 1 200 merkkiä, väittää tehneensä
muutoksen tai sisältää linkin. Jokainen virhe (katkaisin, ei tokenia,
verkko, 5xx, aikakatkaisu 16 s, kelvoton vastaus) → deterministinen
selitys. Kesken oleva haku pitää painikkeen estettynä. Lokiin vain lähde
ja lopputulos. Android-kuori tarvitsee CORS-vastauksen (`api/_cors.js`).

Lähtevä konteksti ei sisällä sääntöä eikä seurannan jakson lukuja
(`trackedPercent`, `trackedFrom`, `trackedDays`, `trackingLevel`,
`openUnknownCount`). Siksi `neglect.plan_unknown` selitetään **aina
paikallisesti** (`DETERMINISTIC_ONLY_RULES`, `failure: 'deterministic_only'`,
ei verkkokutsua): mallille se näyttäisi tavalliselta "suunniteltu alle
tavoitteen" -havainnolta, ja malli voisi väittää vajetta, jota ei ole
todettu. Toteumaan perustuvan havainnon vertailujakson alku ("vertailu 1.10.
alkaen") on vain deterministisessä selityksessä.

### Toteuman lähteet (laajennuspisteet)

`src/domain/realitySources.js`: jokainen fakta kantaa lähteen, jakson,
resurssin (aika/raha/energia/aktiivisuus), varmuuden ja kattavuuden.
Toteutetut: manual, timer. Tulevat (vain rajapinta, `toFacts() = []`):
calendar, activity, finance (Talous 2.0 auktoritatiivinen, ei omaa taulua),
wellbeing. **Yksikään lähde ei kirjoita kapasiteettia.** Hyvinvointi voi
käyttäjän suostumuksella vain *ehdottaa* energia-arviota
(`suggestEnergyFromWellbeing`, `applies: false`); sovellus ei kytke sitä.

### Migraatio 0013 (EI AJETTU)

`running_timers` (yksi käyttäjää kohti), `alignment_item_settings`
(kuormittavuus, tarkoituksellinen ohitus, karkea arvio; yksi rivi kohdetta
kohti), `time_entries` + kohde-, operaatio- ja aikavälisarakkeet ja lähde
'timer', `weekly_capacities.energy_budget_minutes`,
`alignment_reviews.policy_version` ja `reflection_answers`. 46 objektia,
osittaisen ajon tunnistus, RLS + 8 politiikkaa, yhdistelmävierasavaimet
(`on delete set null (sarake)`), `supabase/verify/verify_0013.sql`.
Tuotannossa auki oleviin tauluihin (tasks, goals, projects, routines) ei
kosketa. Aalto J (v23), riippuu aallosta I. **verify_0012 ajetaan ennen
0013:a** (0013 korvaa 0012:n lähderajoitteen).

## Tila (rehellinen)

| Osa | Tila |
|---|---|
| Elämänalueet, tärkeys, tavoite, kategoriakytkentä | COMPLETE_LOCAL |
| Viikkokapasiteetti + energia-arvio + kuormittavan ajan raja | COMPLETE_LOCAL |
| OVERLOAD / NEGLECT / MISALIGNMENT / TENSION | COMPLETE_LOCAL |
| Nopea kirjaus (Suunta, tehtävä, projekti, rutiini, valmistuminen) | IMPLEMENTED_DEVICE_UNVERIFIED |
| Ajastin (aikaleimat, uudelleenlataus, keskiyö, kesäaika, idempotenssi) | IMPLEMENTED_DEVICE_UNVERIFIED |
| Offline-lähtökori aikakirjauksille | COMPLETE_LOCAL (kantapolku vasta 0013:n jälkeen) |
| Kuormittavuus ja ENERGY_OVERLOAD | COMPLETE_LOCAL |
| Päivän Suunta | IMPLEMENTED_DEVICE_UNVERIFIED |
| Aineiston laatu v2, arviointi ja kohdistus | COMPLETE_LOCAL |
| Viikkokatsaus v2, vertailu, kehitys | COMPLETE_LOCAL |
| Tasapainotus + esikatselu + ryhmävahvistus | COMPLETE_LOCAL |
| Suunnittelun rajat ja suunnitelman tarkistus | COMPLETE_LOCAL |
| Tekoälyselitys + varapolku | OPTIONAL_DAY1: koodi ja testit valmiit, **oletuksena pois** (`AI_EXPLAIN_ENABLED=false`, `EXPLAIN_ENABLED` ei asetettu). Aalto J deployaa päätepisteen suljettuna (503); käyttöönotto omistajan päätöksellä |
| Toteuman lähteet: kalenteri, aktiivisuus, talous, hyvinvointi | ARCHITECTURE_ONLY |
| Sääntöpolitiikka ja versio | COMPLETE_LOCAL |
| Pysyvyys kantaan (0012, 0013) | BLOCKED (ajo vaatii omistajan hyväksynnän) |
| RLS | Staattisesti + simuloidusti todennettu; oikea PostgreSQL-ajo puuttuu (REAL DB RLS = NOT YET PROVEN) |
| Selain-E2E | COMPLETE_LOCAL (`npm run e2e:suunta`, paikallinen valjas, ei kirjautumista) |
