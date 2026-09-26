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

Kaikki kynnykset ovat `RULES`-vientejä tiedostossa `src/domain/alignment.js`.
Jokainen havainto kantaa säännön tunnisteen, perustan (`planned`/`actual`) ja
luvut; käyttöliittymä näyttää ne kohdassa **"Miksi tämä näkyy?"**.

### Kuormitus (`overload`)

- Vaatii käyttäjän asettaman kapasiteetin tälle viikolle.
- `tunnettu suunniteltu > kapasiteetti` → **Huomio**; `≥ 120 %` tai
  kapasiteetti 0 → **Vahva**.
- `tunnettu ≥ 90 %` ja arvioimatonta työtä on → **Tiedoksi** ("voi ylittyä").
- Raportoi: suunniteltu, kapasiteetti, ylitys, prosentti, arvioimattomien määrä.

### Huomiotta jääminen (`neglect`)

Vain aktiiviset alueet, joiden **tärkeys ≥ 4** ja **tavoite ≥ 30 min**.

- **Toteumaan perustuva** (kun viikolle on kirjattu aikaa JA viikosta on
  kulunut ≥ 3/7 eli torstaista alkaen): `toteuma < 50 % × tavoite ×
  kulunut osuus` → **Huomio**; viikon jälkeen alle 25 % → **Vahva**.
- **Suunnitelmaan perustuva** (muuten): `suunniteltu < 50 % tavoitteesta` →
  **Tiedoksi** (suunnitelma on vielä muutettavissa).
- Maanantaina toteumaa ei verrata. Vähemmän tärkeä alue, tavoite 0/puuttuu tai
  pois käytöstä oleva alue ei ole koskaan "huomiotta".

### Poikkeama tavoitteista (`misalignment`)

- Toivottu osuus = alueen tavoite / kaikkien aktiivisten tavoitteiden summa.
- Perusta: toteuma, jos alueisiin liitettyä aikaa ≥ 120 min; muuten suunnitelma
  (sama raja); muuten ei arvioida.
- `|toteutunut % − toivottu %| ≥ 15 pp` → **Huomio**, `≥ 25 pp` → **Vahva**
  (suunnitelmaan perustuva enintään Huomio).
- Jos alle 60 % ajasta on liitetty alueisiin → **Tiedoksi** ja "suuntaa-antava".
- Tavoite 0 on päätös (siihen kulunut aika on poikkeama); puuttuva tavoite ei.
- Vajetta ei raportoida kahdesti, jos alue on jo "huomiotta".

### Jännite (`target_tension`)

Alueiden tavoitteiden summa > kapasiteetti → **Tiedoksi**. Tärkeyttä,
tavoitetta tai kapasiteettia ei muuteta puolesta.

### Aineiston laatu

`good` / `partial` / `weak` / `none` + syyt: ei alueita, ei tavoitteita, ei
kapasiteettia, arvioimatonta työtä, liittämätöntä työtä, ei toteumaa.
Kattavuusprosentit: arvioitu osuus, alueeseen liitetty suunniteltu ja toteuma.

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
| Varaa aikaa alueelle | huomiotta jääminen | luo tehtävän ensi maanantaille alueen tärkeimpään tavoitteeseen |
| Muuta alueen tavoitetta | huomiotta jääminen / poikkeama | päivittää tavoitteen (käyttäjä muokkaa arvon) |

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
`REVIEW_RULES`, `TREND_RULES`, `TIMER_RULES`). Ajan kynnykset ovat
ensimmäisen version arvot sellaisenaan (`RULES` alignment.js:ssä on sama
olio). Kynnyksiä ei näytetä käyttäjälle säädettävinä.

`POLICY_VERSION = 2` tallentuu viikkokatsauksen tilannekuvaan
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
arvioimatonta / ei kapasiteettia) · 10 tiedoksi. Ensimmäinen on "Tänään
kannattaa huomata", ja jokainen kertoo "Miksi tämä?". Lisäksi tilarivit:
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
viikko on päättynyt ja poikkeama ≥ 25 % ja ≥ 2 h; kysymyksenä), arvioi
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
