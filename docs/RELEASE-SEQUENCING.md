# Julkaisujärjestys ja välimuistiversiot — ratkaisematon ongelma

**Tämä dokumentti ei ratkaise mitään. Se kuvaa ongelman, luettelee
vaihtoehdot ja nimeää sen, kenen päätös tämä on.**

Ongelma on todellinen, se on helppo ohittaa, ja sen ohittaminen
rikkoisi tuotannon tavalla joka ei näy virheenä missään.

---

## Yhden lauseen tiivistelmä

Paikallisesti on rakennettu enemmän julkaisuja kuin tuotantoon on
viety, ja **välimuistiversio ei koskaan saa laskea** — joten sitä ei voi
vain valita vapaasti sen mukaan mikä milloinkin deployataan.

---

## Nykytila

### `origin/main` juuri nyt

Luettu suoraan committista, ei dokumentaatiosta:

```
git rev-parse origin/main
  cf259d0ef755f7e875cc9cd9c15405eba632e408

git show cf259d0:sw.js | grep CACHE_VERSION
  const CACHE_VERSION = 'v16';

git show cf259d0:src/data/schema.js | grep ': true'
  routines: true
  routineExceptions: true
  goals: true
  projects: true
  notificationPreferences: true
  wellbeing: true
```

Aallot **A, B ja C on siis deployattu**. Junan tila on aalto C, `v16`.
**Aalto C on DEPLOYATTU mutta EI VIELÄ KÄYTTÄJÄN HYVÄKSYMÄ** -- tämä
päivitys itsessään ei ole hyväksyntätapahtuma, se vain tunnustaa
gitin todellisen tilan tässä dokumentissa. Ks. Panun hyväksyntäpaketti
`docs/acceptance/` -hakemistossa.

### Paikallisesti rakennettu

Kolme tuotepakettia elää haarassa, joka **erkani ennen aaltoja A ja B**:

| Haara | Sisältö | `sw.js` haarassa |
|---|---|---|
| `feature/finance-2.0` | Talous 2.0 | `v13` |
| `feature/goal-to-action` | + Tavoitteesta tekemiseksi | `v13` |
| `feature/personal-assistant-core` | + Henkilökohtainen avustaja | `v13` |

```
git merge-base --is-ancestor origin/main HEAD
  -> epätosi
```

`origin/main` **ei ole näiden haarojen esi-isä**. Se ei ole vahinko:
aallot A ja B ovat pieniä aktivointicommitteja, jotka kääntävät
lippuja, ja ne tehtiin junassa samalla kun tuotepaketteja rakennettiin
erikseen.

### ⚠ TÄMÄN HAARAN `PRODUCTION-STATUS.md` ON VANHENTUNUT

Tämä on se osa ongelmasta, joka on helpoin ohittaa.

| Lähde | Väittää |
|---|---|
| `docs/PRODUCTION-STATUS.md` **tässä haarassa** | `v12`, kaikki portit kiinni |
| `origin/main` | `v16`, kuusi porttia auki |

Dokumentti julistaa itsensä auktoritatiiviseksi ("jos jokin muu
tiedosto on ristiriidassa tämän kanssa, tämä on oikeassa"), ja tässä
haarassa se on **väärässä** — ei siksi että sitä olisi muokattu
väärin, vaan siksi että haara erkani ennen kuin A ja B deployattiin.

Yhtäpitävyystesti ei huomaa tätä, eikä voi: se vertaa kolmea
lähdettä **tässä puussa** toisiinsa, eikä yksikään niistä lue
`origin/main`ia. Kolme yhtäpitävää vanhentunutta lähdettä on
johdonmukainen ja silti väärin.

**Yhdistäminen `main`iin on siis pakollinen askel ennen mitään
deployta**, ja siinä yhdistyvät sekä porttimatriisi että
välimuistiversio. Yhdistämistä ei ole tehty tässä työssä: se olisi
ollut julkaisupäätös.

### Julkaisujunan varaamat numerot

<!-- LINEAGE-CHECK: origin/main sha=cf259d0ef755f7e875cc9cd9c15405eba632e408 cache=v16 -->

`tests/production-lineage.test.mjs` lukee edellisen rivin ja vertaa sitä
siihen, mitä `origin/main` PAIKALLISESTI (ei verkosta) on juuri nyt.
Jos rivi jää jälkeen todellisuudesta, testi kaatuu -- tämä dokumentti ei
siis voi mennä vanhaksi huomaamatta, toisin kuin `PRODUCTION-STATUS.md`
saattoi ennen tätä työtä.

| Aalto | Cache | Tila |
|---|---|---|
| Perustila | `v13` | valmis, ei deployattu |
| A | `v14` | **deployattu** (`703c28f`) |
| B | `v15` | **deployattu** (`ddfc356`) |
| C | `v16` | **deployattu** (`cf259d0`) — tuotannon nykytila, EI VIELÄ hyväksytty käyttäjän toimesta |
| D | `v17` | valmis, ei deployattu — commitoitu `release/activation-0003-0008`-haaraan (`091e73c`) |
| E | `v18` | valmis, ei deployattu — sama haara (`2b947cc`), haaran kärki `86c4325` |
| F | `v19` | estetty (migraatio 0009 ajamatta) |
| G | `v20` | estetty (migraatio 0010 ajamatta) |
| H | `v21` | estetty (migraatio 0011 ajamatta) |
| I | `v22` | estetty (migraatio 0012 ajamatta) |
| J | `v23` | estetty (migraatio 0013 ajamatta; riippuu aallosta I) |

**Aalto C:n deployaus EI ole sama asia kuin sen hyväksyntä.** Rivi
yllä kertoo vain, mitä `origin/main` sisältää -- ei sitä, että Panu
olisi hyväksynyt sen selaimessa. Ks. `docs/PRODUCTION-STATUS.md`
kohta "Odottavat asiat" ja aalto C:n hyväksyntäpaketti.

`release/activation-0003-0008` on ERI asia kuin tuotepakettihaarat.
Se on juna itse: aallot C, D ja E on siellä rakennettu, testattu ja
committoitu omilla `Release-Wave:`-trailereillaan, mutta HAARAA ei ole
yhdistetty `origin/main`iin eikä mitään ole deployattu. Se on
todistettavissa paikallisesti:

```
git merge-base --is-ancestor origin/main release/activation-0003-0008
  -> tosi   (juna sisältää kaiken mitä tuotannossa on)
git branch --contains release/activation-0003-0008 -r
  -> (tyhjä -- origin ei tunne tätä haaraa)
```

Juna on siis VALMIS mutta ei DEPLOYATTU. Se on eri asia kuin
tuotepakettihaarat, jotka ovat DEPLOYAAMATTOMIA JA erkaantuneita
ennen aaltoja A/B.

---

## Kolme tilaa, joita ei saa sekoittaa

Tämän koko dokumentin ongelma tiivistyy siihen, että kolmea eri asiaa
on historiallisesti kutsuttu samalla nimellä ("tuotannon tila").
Jatkossa niillä on kolme eri nimeä, ja jokaisella on yksi ainoa
lähde:

| Tila | Mitä se tarkoittaa | Lähde | Voiko mennä vanhaksi huomaamatta? |
|---|---|---|---|
| **ACTUAL PRODUCTION STATE** | Mitä `origin/main` JUURI NYT sisältää | `git show origin/main:...` -- luettu suoraan, ei dokumentista | Ei: se ON git, se ei voi olla "vanhentunut" versio itsestään |
| **DEVELOPMENT FEATURE STATE** | Mitä tämä haara uskoi tuotannosta sillä hetkellä kun se erkani junasta | `docs/PRODUCTION-STATUS.md` TÄSSÄ haarassa | Kyllä -- ja `production-lineage.test.mjs` vartioi, että se TUNNUSTAA sen sen sijaan että väittäisi olevansa ajantasainen |
| **PLANNED RELEASE STATE** | Mihin junaa on tarkoitus viedä: varatut aallot, cache-versiot, migraatiojärjestys | `tools/release/waves.mjs`, tämä dokumentti | Kyllä samalla tavalla -- `release-sequencing.test.mjs` ja `release-waves.test.mjs` vartioivat sen sisäistä yhtäpitävyyttä |

**Kukin tila vastaa eri kysymykseen:**

- "Mitä käyttäjä näkee tuotannossa juuri nyt?" -> ACTUAL. Kysy gitiltä,
  älä dokumentilta.
- "Mitä tämä haara rakennettiin olettaen?" -> DEVELOPMENT. Hyödyllinen
  historiallisena kontekstina, EI ajantasaisena totuutena.
- "Mihin seuraavaksi ollaan menossa, jos/kun deployataan?" -> PLANNED.
  Suunnitelma, ei tapahtuma -- kukaan portti ei ole auki ennen kuin se
  on oikeasti deployattu.

**Miksi kehityshaaran tila ei voi koskaan olla luotettava ACTUAL-lähde:**
kehitystyö erkanee junasta jonain hetkenä ja elää sen jälkeen omaa
elämäänsä. Jokainen committi joka menee junaan sen JÄLKEEN on
kehityshaaralle näkymätön, ellei sitä erikseen yhdistetä takaisin. Se
ei ole korjattavissa tekemällä dokumentista tarkempi -- se on
rakenteellinen ominaisuus siinä missä haarautunut kehitys ylipäätään
toimii. Ainoa kestävä korjaus on se, ettei kehityshaaran dokumentti
enää TEESKENTELE olevansa ajantasainen: se kertoo mitä se tiesi, ja
ohjaa ajantasaisen tiedon luo.

---

## Miksi tämä on ongelma

### 1. Numerot on jo jaettu, mutta tuotanto on ohittanut osan niistä

Tuotanto on `v15`, joka junan mukaan kuuluu aallolle B. Aallot C–E ovat
`v16`–`v18` eikä niitä ole deployattu. Numerot siis **varaavat
paikkoja**, joita kukaan ei ole vielä käyttänyt — ja tämä haara
sanoo `v13`, joka on jo menneisyyttä.

Se ei ole vika sinänsä. Vika syntyy siitä, että **kolme muuta
tuotepakettia** — Talous 2.0, Tavoitteesta tekemiseksi ja
Henkilökohtainen avustaja — on rakennettu haaroihin, joiden `sw.js`
sanoo `v13`.

`v13` on **pienempi kuin tuotannon `v16`**.

### 2. Välimuistiversio ei koskaan saa laskea

`CACHE_VERSION` on ainoa asia, joka saa selaimen hakemaan
sovelluskuoren uudelleen. Service worker on network-first, mutta
KUORI — `index.html`, moduulit, tyylit — tulee välimuistista niin
kauan kuin nimi on sama.

```js
const CACHE_NAME = `manifestival-shell-${CACHE_VERSION}`;
```

Jos tuotantoon vietäisiin commit, jonka `CACHE_VERSION` on `v13`,
tapahtuisi tämä:

1. Selain, joka on jo nähnyt `v15`:n, säilyttää `manifestival-shell-v15`
2. Uusi service worker luo `manifestival-shell-v13`
3. Vanha `v15` on yhä olemassa eikä sitä siivota
4. Jos joskus myöhemmin deployataan `v15` uudelleen, selain löytää
   **vanhan v15-kuoren** eikä hae uutta

Käyttäjä jää vanhaan kuoreen **pysyvästi**. Se ei näy virheenä
missään: sovellus toimii, se on vain väärä versio.

Tämä on se yksi asia, jota ei voi korjata jälkikäteen deployaamalla
uudelleen.

### 3. Tuotepaketeilla ei ole omaa numeroa

Talous 2.0:lla, Tavoitteesta tekemiseksi -moottorilla ja
Henkilökohtaisella avustajalla **ei ole varattua välimuistiversiota**.
Ne eivät ole junan aaltoja: aalto avaa portin, nämä tuovat
tuotekoodia.

Junan aallot F, G ja H avaavat **niiden portit**, mutta tuotekoodin on
oltava tuotannossa ennen kuin portilla on mitään merkitystä.

---

## Mitä tässä työssä on tehty ja mitä ei

**Tehty:** `sw.js` on jätetty arvoon `v13` jokaisessa haarassa.

**Miksi:** numeron nostaminen olisi päätös siitä, mihin kohtaan junaa
paketti menee — ja se päätös kuuluu deploy-paketille, ei
ominaisuustyölle. Väärään kohtaan arvattu numero olisi vaikeampi
purkaa kuin puuttuva numero.

**Ei tehty:** mitään ei ole deployattu, eikä yhtäkään junan tagia ole
siirretty.

---

## Vaihtoehdot

### A. Juna ensin, tuotepaketit sen jälkeen

Deployataan aallot C–E järjestyksessä (`v16`–`v18`), sitten Talous 2.0,
Tavoitteesta tekemiseksi ja avustaja omina julkaisuinaan `v19`, `v20`,
`v21`, ja aallot F–H vasta niiden jälkeen numeroilla `v22`–`v24`.

**Puolesta:** juna säilyy ehjänä, ja jokainen aalto deployataan siinä
järjestyksessä jossa se suunniteltiin.

**Vastaan:** aaltojen F–H numerot on kirjoitettu
hyväksyntäpaketteihin, `waves.mjs`:ään ja manifestiin. Ne olisi
päivitettävä kaikki yhdessä. Testi vartioi yhtäpitävyyttä, joten
osittainen muutos kaatuu — mikä on hyvä.

### B. Tuotepaketit ensin, portit sitten

Deployataan Talous 2.0, Tavoitteesta tekemiseksi ja avustaja
peräkkäin `v16`, `v17`, `v18` portit kiinni, ja juna jatkaa niistä.

**Puolesta:** tuotekoodi menee tuotantoon aikaisemmin, ja aallot F–H
avaavat portteja koodiin joka on jo paikallaan ja hyväksytty.

**Vastaan:** aallot C–E (rutiinit, talous, kirjausketju) siirtyvät
myöhemmäksi, ja niiden numerot on sekin päivitettävä.

### C. Numeroiden uudelleenjako kerralla

Päätetään koko loppujuna kerralla ja päivitetään `waves.mjs`, kaikki
`docs/acceptance/WAVE-*.md`, `PRODUCTION-STATUS.md` ja manifesti yhdellä
committilla.

**Puolesta:** yksi päätös, yksi commit, ja kolmen lähteen
yhtäpitävyystesti todentaa lopputuloksen.

**Vastaan:** commit on suuri, ja sen diff on käytännössä
mahdotonta lukea rivi riviltä. Toisaalta testi lukee sen puolestasi.

---

## Päätös: integrointijärjestys on lukittu

Yllä olevista vaihtoehdoista lukittu järjestys ei ole puhtaasti A, B
eikä C: se on täsmälleen se, jonka `tools/release/waves.mjs` on jo
kirjoittanut auki aalloille F, G ja H -- kukin tuotepaketti JA sen
migraatio JA sen portit deployataan SAMASSA aallossa, ei erikseen.
Tämä oli auki oleva kysymys; se ei ole enää.

### Kaksi erillistä linjaa

**TUOTEKEHITYSLINJA** (feature-haarat, ei aaltoja eikä cache-versioita
ennen pakkausta):

```
feature/finance-2.0
  -> feature/goal-to-action
    -> feature/personal-assistant-core
      -> tuleva tuotekehitys
```

Todennettu esi-isyys (`git merge-base --is-ancestor`): jokainen nuoli
yllä on TOSI. Linja on lineaarinen, ei haarautunut.

**TUOTANTOJULKAISULINJA** (junan aallot, cache-versiot varattu):

```
Aalto B  v15  (tuotannon nykytila, origin/main)
  -> C  v16   routines + routineExceptions          (rakennettu, ei deployattu)
    -> D  v17   recurringExpenses + savingsGoals + bills  (rakennettu, ei deployattu)
      -> E  v18   aiAudit                            (rakennettu, ei deployattu)
        -> F  v19   Talous 2.0 -- migraatio 0009
          -> G  v20   Tavoitteesta tekemiseksi -- migraatio 0010
            -> H  v21   Henkilökohtainen avustaja -- migraatio 0011
              -> I  v22   Suunta (Life Alignment) -- migraatio 0012
                -> J  v23   Suunta 2: ajastin ja kuormittavuus -- migraatio 0013
```

**Feature-haarat EIVÄT ole tuotantojulkaisulinjan luotettava kuva.**
Ne kertovat mitä tuotekoodia on olemassa ja testattu, eivät mitä
tuotannossa on tai milloin se sinne menee. Aallon numero ja cache-
versio EIVÄT siirry feature-haaraan ennen kuin tuote todella pakataan
osaksi ao. aaltoa -- ks. "Tuotepaketeilla ei ole omaa numeroa" yllä.

### Miksi tämä ei riko "tuotepaketeilla ei ole omaa numeroa" -havaintoa

Havainto oli oikea: Talous 2.0:lla ei ole OMAA cache-versiotaan siksi,
ettei se ole junan aalto sinänsä. Lukittu järjestys ei anna sille
omaa numeroa -- se antaa sille AALLON numeron, samalla perusteella
kuin migraatiokin: F ei ole "avaa kaksi porttia", F ON "Talous 2.0 +
migraatio 0009 + niiden portit", yhtenä hyväksyntätapahtumana. Tämä on
jo kirjoitettu `waves.mjs`:ään (`blockedBy` viittaa migraatioon,
`tables` viittaa tuotteen tauluihin) -- tämä dokumentti vain nimeää
sen ääneen päätökseksi sen sijaan että jättäisi sen auki.

### Migraatioiden julkaisujärjestys ja hyväksyntä

Migraatioita EI koskaan pakata samaan tuotantoikkunaan/transaktioon:

1. **0009** (Talous 2.0) ensin, omalla hyväksynnällään.
2. **0010** (Tavoitteesta tekemiseksi) VASTA sen jälkeen, omalla
   ERILLISELLÄ hyväksynnällään -- se on vaarallisempi kuin mikään
   aiempi, koska se MUUTTAA tauluja (`goals`, `projects`, `tasks`),
   joissa on jo oikeaa käyttäjädataa ja joiden portit ovat auki
   tuotannossa. Ks. `docs/GOAL-TO-ACTION.md`.
3. **0011** (Henkilökohtainen avustaja) pysyy ERISTETTYNÄ 0010:n
   elävän taulun muutoksista: se vain LUO viisi uutta taulua eikä
   koske yhteenkään olemassa olevaan sarakkeeseen tai rajoitteeseen.
   Se voi siksi olla oma hyväksyntätapahtumansa riippumatta siitä,
   missä järjestyksessä 0009/0010 lopulta hyväksytään -- se ei riipu
   niistä.

4. **0012** (Suunta) luo neljä uutta taulua ja LISÄÄ yhden nullable
   sarakkeen `goals`-tauluun (`life_area_id`, ei oletusta, ei täyttöä).
   Se vaatii vain tuotannossa jo olevat 0001/0002/0004/0007, joten se ei
   riipu 0009–0011:stä. Koska se koskee `goals`-tauluun, jonka portti on
   auki, sarakkeella on oma portti `GOAL_LIFE_AREA_FIELD`.

5. **0013** (Suunta 2) luo kaksi uutta taulua (`running_timers`,
   `alignment_item_settings`) ja lisää sarakkeita 0012:n tauluihin.
   Se RIIPPUU 0012:sta (ja `verify_0012.sql` ajetaan ennen sitä, koska
   0013 korvaa sen tarkistaman lähderajoitteen). Tuotannossa auki oleviin
   tauluihin se ei koske; sarakkeilla on oma portti
   `ALIGNMENT_REALITY_FIELDS`.

Kukaan ei saa niputtaa 0009+0010+0011+0012+0013 yhteen tuotantoajoon. Jokainen
saa oman `supabase/verify/verify_00XX.sql`-todennuksensa ja oman
`docs/acceptance/WAVE-*.md`-hyväksyntäpakettinsa.

### Miten tuleva julkaisun integrointihaara syntyy

Kun aalto F on vuorossa: integrointihaara haarautuu SIITÄ SAMASTA
commitista, joka on silloin hyväksytty aallon E tuotantotila (ei
`origin/main`ista sellaisenaan, jos E on sitä myöhempänä -- vaan siitä
tarkasta SHA:sta, jonka manifesti nimeää E:n deploykohteeksi).
Feature-haaran (`feature/finance-2.0`) tuotekommitit rebasetaan tai
mergetään sen päälle, `tools/release/waves.mjs`:n aallon F
`cacheVersion` (`v19`) kirjoitetaan `sw.js`:ään, portit pysyvät
kiinni (migraatio 0009 hyväksytään ja ajetaan ERIKSEEN, ei samassa
committissa), ja `npm run release:manifest -- --write` päivittää
manifestin. Sama toistuu G:lle E:n sijaan F:n hyväksytystä
tuotantotilasta, ja H:lle G:n hyväksytystä tilasta.

Tätä EI tehdä tässä työssä tuotantoon asti: ks. harjoitteluhaarat
alempana ("Harjoittelu"), jotka todistavat saman ketjun paikallisesti,
merkittyinä ei-tuotannoksi, pushaamatta mihinkään.

---

## Harjoittelu (rehearsal) — todistettu, ei tuotantoa

Kolme paikallista haaraa, EI pushattu minnekaan, EI deployattu, EI
lisätty `origin`iin. Jokainen on `origin/main`in (`ddfc356`, v15, Aalto
B) päälle rakennettu `git merge --no-ff`, ei rebase -- historia näkyy
todisteena.

| Haara | Yhdistää | Tulos |
|---|---|---|
| `rehearsal/wave-f-candidate` | `origin/main` + `feature/finance-2.0` | 1688/1689 PASS (1 odotettu: android-assetit synkkaamatta) |
| `rehearsal/wave-g-candidate` | edellinen + `feature/goal-to-action` | 1867/1868 PASS (sama odotettu FAIL) |
| `rehearsal/wave-h-candidate` | edellinen + `feature/personal-assistant-core` | **2206/2206** (2205 PASS, 1 odotettu SKIP), `check`/`smoke`/`build:web` PASS |

**Tekstikonflikteja: nolla.** Kaikki kolme merge-askelta menivät läpi
ilman manuaalista ratkaisua. Kolmen tiedoston (`schema.js`, `sw.js`,
`docs/PRODUCTION-STATUS.md`) 3-way-yhdistely resolvoitui oikein
automaattisesti jokaisessa vaiheessa, koska `origin/main` ja
feature-haarat eivät koskaan muuttaneet samoja rivejä: `origin/main`
avasi olemassa olevia portteja (goals, projects) ja nosti cache-
versiota, feature-haarat lisäsivät UUSIA rivejä (uudet portit,
kiinni). Ei-päällekkäiset lisäykset yhdistyvät aina puhtaasti.

**Yksi todellinen löydös, ei rehearsal-artefakti:**
`tests/activation-gates.test.mjs` haki porttitaulukon rivin naiivilla
`.includes()`-haulla, joka nappasi migraation 0010 varoituslaatikon
("`goals`, `projects`, `tasks`") porttitaulukon oman rivin sijaan.
Feature-haaroilla tämä ei koskaan kaatunut -- goals on niissä kiinni
molemmissa kohdissa, joten ne "sopivat yhteen" vahingossa. Vasta kun
`origin/main`in todellinen (avoin) tila yhdistettiin mukaan `rehearsal/
wave-g-candidate`:ssa, kaksi mainintaa alkoivat olla eri mieltä ja testi
paljasti aiemmin piilossa olleen haurauden. **Korjattu myös oikealla
`feature/personal-assistant-core`-haaralla**, ei vain rehearsal-
haarassa -- ks. commit `c6ada82`.

**Ei menetettyä toiminnallisuutta.** `git diff origin/main
rehearsal/wave-h-candidate --stat` (118 tiedostoa, +35237/-243) sisältää
Talous 2.0:n, Tavoitteesta tekemiseksi -moottorin ja Henkilökohtaisen
avustajan koko tuotekoodin sekä tämän kovennustyön dokumentit ja
`tools/release/lineage.mjs`:n -- ei mitään kadonnutta merge-askeleiden
välissä.

**Ei migraationumerointitörmäystä.** 0009, 0010 ja 0011 pysyivät
erillisinä koko harjoittelun ajan; mikään merge ei yrittänyt yhdistää
niitä samaksi tiedostoksi tai numeroksi.

**Porttitila ja cache-versio pysyivät todellisina.** Yksikään
harjoitteluhaara ei avannut yhtäkään uutta porttia eikä nostanut
`CACHE_VERSION`ia yli `v15`:n -- se ei ole tämän harjoittelun päätös,
ks. "Päätös: integrointijärjestys on lukittu" yllä. Harjoittelu
todistaa että integrointi ON MAHDOLLINEN, ei että se on TEHTY.

Nämä haarat ovat säilytettävissä paikallisena todisteena, mutta EIVÄT
korvaa oikeaa deploy-hetken integrointihaaraa: ne on rakennettu
`origin/main`in SEN HETKISEN tilan päälle, joka voi olla vanhentunut
siihen mennessä kun F oikeasti valmistellaan.

---

## Se, mitä ei saa tehdä

> **ÄLÄ deployaa pelkästään numeroinnin ratkaisemiseksi.**
> Deploy on hyväksyntätapahtuma, ei numeron korjaus.

> **ÄLÄ laske välimuistiversiota tuotannossa.** Ks. kohta 2 yllä.
> Tämä on ainoa virhe tässä dokumentissa, jota ei voi korjata
> jälkikäteen.

> **ÄLÄ kirjoita frozen-aaltojen C, D ja E committeja uudelleen.**
> Ne ovat tietueita siitä, mitä silloin rakennettiin ja testattiin.
> Numeron muutos tehdään uutena committina, ei historiaa muokkaamalla.

---

## Mikä vartioi tätä koneellisesti

| Testi | Mitä se estää |
|---|---|
| `release-waves.test.mjs` — "nykytila vastaa täsmälleen yhtä sallittua aaltoa" | porttimatriisi, joka ei ole suunniteltu |
| `release-waves.test.mjs` — "service workerin välimuistiversio vastaa nykyistä aaltoa" | numero, joka ei vastaa porttitilaa |
| `release-waves.test.mjs` — "paketti kertoo oikeat portit, välimuistin ja peruutuksen" | hyväksyntäpaketti, joka ohjaa väärään versioon |
| `release-waves.test.mjs` — "paketti nostaa välimuistiversion myös peruutuksessa" | peruutus, joka palauttaisi vanhan numeron |
| `migrations.test.mjs` — "tilannedokumentin porttitaulukko vastaa lähdekoodia" | dokumentti, joka kertoo väärän tilan |
| `production-lineage.test.mjs` — "haara joka ei ole origin/mainin jälkeläinen ei väitä itseään ehdoitta ajantasaiseksi" | `PRODUCTION-STATUS.md`, joka väittää olevansa ajantasainen ilman että origin/main todistaa sen |
| `production-lineage.test.mjs` — "tämä haara ei väitä origin/mainia korkeampaa välimuistiversiota ilman jälkeläisyyttä" | keksitty, todentamaton cache-versio joka ohittaisi todellisen tuotannon |
| `production-lineage.test.mjs` — "RELEASE-SEQUENCING.md:n merkitsemä origin/main-tila täsmää todelliseen" | tämä dokumentti itse vanhenee huomaamatta |

Kolme riippumatonta lähdettä — `src/data/schema.js`, `sw.js`,
`docs/PRODUCTION-STATUS.md` — on pidettävä yhtäpitävinä. Väärennös
vaatisi kaikkien kolmen muuttamista johdonmukaisesti, eli täsmälleen
sen mitä kelvollinen aaltocommitti tekee.

**Peruutus nostaa aina versiota.** Jos peruutus palauttaisi vanhan
numeron, selain joka on jo kerran nähnyt sen numeron voisi jäädä
vanhaan kuoreen pysyvästi. Jokainen hyväksyntäpaketti sanoo tämän
erikseen, ja testi tarkistaa että sanoo.

---

## Päätös

**Tämä on Panun päätös, ja se tehdään deploy-paketissa.**

Ominaisuustyö on jättänyt `sw.js`:n arvoon `v13` juuri siksi, ettei se
tekisi tätä päätöstä vahingossa puolestasi.

Kun päätös on tehty, se toteutetaan **yhdessä committissa**, joka
muuttaa:

- `tools/release/waves.mjs` — aaltojen `cacheVersion`
- `sw.js` — `CACHE_VERSION`
- `docs/PRODUCTION-STATUS.md` — vaihetaulukko
- `docs/RELEASE-TRAIN-0003-0008.md` — yleisohje
- `docs/acceptance/WAVE-*.md` — jokainen paketti
- `docs/activation-0003-0008-release-manifest.json` — `npm run release:manifest -- --write`

ja ajaa `npm test`. Testit kaatuvat, jos jokin näistä jää jälkeen.

**Päivitys (arkkitehtuurin kovennus):** OSA tästä päätöksestä on nyt
tehty -- ks. "Päätös: integrointijärjestys on lukittu" yllä. Se, MISSÄ
JÄRJESTYKSESSÄ ja MILLÄ RAJAUKSELLA F/G/H deployataan, ei ole enää
auki: kukin tuotepaketti + sen migraatio + sen portit yhtenä aaltona,
0009 -> 0010 -> 0011, kukin omalla hyväksynnällään. Se mikä on YHÄ
auki, ja YHÄ tämän kohdan mukainen Panun päätös deploy-hetkellä, on
TARKKA AJOITUS: milloin C/D/E/F/G/H oikeasti deployataan ja missä
täsmällisessä committissa `sw.js`:n `CACHE_VERSION` nousee. Sitä ei ole
tehty tässä työssä eikä pidä tehdä ominaisuustyönä -- ks. yllä oleva
perustelu, joka pätee sellaisenaan yhä.
