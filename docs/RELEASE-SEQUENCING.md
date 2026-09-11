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
  ddfc356d7d0d055b3923cdbfefbcb0bb6d92ec9c

git show ddfc356:sw.js | grep CACHE_VERSION
  const CACHE_VERSION = 'v15';

git show ddfc356:src/data/schema.js | grep ': true'
  goals: true
  projects: true
  notificationPreferences: true
  wellbeing: true
```

Aallot **A ja B on siis deployattu**. Junan tila on aalto B, `v15`.

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
| `origin/main` | `v15`, neljä porttia auki |

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

| Aalto | Cache | Tila |
|---|---|---|
| Perustila | `v13` | valmis, ei deployattu |
| A | `v14` | **deployattu** (`703c28f`) |
| B | `v15` | **deployattu** (`ddfc356`) — tuotannon nykytila |
| C | `v16` | valmis, ei deployattu |
| D | `v17` | valmis, ei deployattu |
| E | `v18` | valmis, ei deployattu |
| F | `v19` | estetty (migraatio 0009 ajamatta) |
| G | `v20` | estetty (migraatio 0010 ajamatta) |
| H | `v21` | estetty (migraatio 0011 ajamatta) |

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

`v13` on **pienempi kuin tuotannon `v15`**.

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
