# Domain-malli

Tila: **IMPLEMENTED** (WP2), pois lukien erikseen merkityt kohdat.

Tämä dokumentti kuvaa Manifestivalin käsitteet ja säännöt. Se on
`src/domain/`-hakemiston sanallinen vastine — jos nämä eroavat, koodi on oikeassa.

---

## Tehtävä (task)

Manifestivalin peruskäsite. Ei pelkkä muistilistan rivi, vaan asia jolla on
paikka ajassa, tärkeys ja elämänalue.

| Kenttä | Tyyppi | Tallentuu | Selitys |
|---|---|---|---|
| `id` | string | ✅ | Clientin generoima, `crypto.randomUUID` |
| `title` | string, ≤200 | ✅ | Lyhyt ja skannattava |
| `description` | string, ≤2000 | ⛔ migraatio 0002 | Pidempi konteksti |
| `date` | `YYYY-MM-DD` | ✅ | Paikallinen päivä, ei UTC |
| `time` | `HH:MM` tai null | ✅ | Alkuaika |
| `endTime` | `HH:MM` tai null | ✅ | Loppuaika |
| `durationMinutes` | 1–1440 tai null | ⛔ migraatio 0002 | Kesto, kun kellonaikaa ei ole |
| `category` | enum | ✅ | Elämänalue |
| `priority` | enum | ⛔ migraatio 0002 | Tärkeys |
| `completed` | boolean | ✅ | Kuitattu |
| `isWake` | boolean | ✅ | Päivän herätysankkuri |
| `note` | string tai null | ✅ | Lyhyt lisähuomio |
| `schedulingState` | enum | ⛔ migraatio 0002 | Kuka ajan päätti |

⛔ = elää vain selaimen muistissa, kunnes migraatio 0002 on ajettu.
Ks. `src/data/schema.js`.

### Kesto

Kesto johdetaan ensisijaisesti alku- ja loppuajasta, muuten erillisestä
kentästä. **Keskiyön yli menevä väli lasketaan oikein:** 22:00–06:00 = 480 min,
ei negatiivinen. Tämä on olennaista, koska unijakso on juuri sellainen.

---

## Elämänalueet (kategoriat)

Kahdeksan aluetta, jotka vastaavat konseptidokumentin lukua 21:

`tyo` · `perhe` · `hyvinvointi` · `harrastus` · `koti` · `kehitys` · `talous` · `muu`

Avaimet ovat tuotantodatassa eikä niitä nimetä uudelleen. Uusia voi lisätä
listan loppuun ilman migraatiota, koska sarake on tekstityyppinen.

**`tyo` on erikoisasemassa:** aikataulumoottori käyttää päivän aikaisinta
työtehtävää herätysajan ankkurina.

---

## Prioriteetti

Kolme tasoa. Tarkoituksella vähän: useampi lisäisi päätöksiä vähentämättä
kuormaa, ja kolme erottuu yhdellä silmäyksellä.

| Avain | Teksti | Paino |
|---|---|---|
| `korkea` | Tärkeä | 0 |
| `normaali` | Normaali | 1 |
| `matala` | Voi odottaa | 2 |

Prioriteetti vaikuttaa kolmeen asiaan:

1. **Järjestykseen** — aikatauluttamattomat listautuvat tärkeys edellä
2. **Automaattiseen aikataulutukseen** — tärkeimmät saavat parhaat vapaat välit
3. **Tunnistettavuuteen** — vain poikkeamat merkitään, `normaali` ei näy

---

## Aikataulutuksen tila

**Tuotteen keskeisin sääntö.** Erottaa käyttäjän päätöksen automaatin ehdotuksesta.

| Tila | Merkitys | Saako automaatti siirtää? |
|---|---|---|
| `manual` | Käyttäjä asetti ajan itse | **EI KOSKAAN** |
| `auto` | Käyttäjä hyväksyi ehdotuksen | Kyllä |
| `unscheduled` | Ei aikaa | Kyllä (sijoitetaan) |

Konseptidokumentin luku 7: *"Joustavuus ilman hallinnan menetystä."* Jos
järjestelmä siirtäisi käyttäjän itse päättämän ajan, se rikkoisi luottamuksen,
jonka varaan koko tuote rakentuu.

Tila **johdetaan**, ei luoteta tallennettuun arvoon: jos aika puuttuu, tila on
aina `unscheduled` riippumatta siitä mitä kantaan on kirjattu. Ajan muuttaminen
käsin asettaa tilan aina `manual`.

Valmis tehtävä ja herätysmerkintä eivät koskaan ole siirrettävissä.

---

## Päivä

Päivä ei ole tehtävälista vaan suunnitelma, jolla on alku ja loppu.

```
                   herätys                          nukkumaanmeno
                      │                                   │
   ─────────────────  ▼  ═══════════════════════════════  ▼  ──────────────
                      └── valveillaoloikkuna ─────────────┘
                              vapaat välit
```

### Herätysaika

1. Käyttäjän oma `isWake`-merkintä voittaa aina
2. Muuten: **päivän aikaisin työtehtävä − työmatka − aamutoimet**
3. Muuten: profiilin oletusheräämisaika

### Nukkumaanmenoaika

**HUOMISEN herätysajasta vähennetään unitavoite.**

Tämä on konseptin luvun 13 ydin: uni ei ole se, mikä jää yli, vaan sille
varataan aika. Nukkumaanmeno riippuu huomisesta, ei tästä päivästä.

### Automaattiset merkinnät

Herätys, aamutoimet ja uni näkyvät aikajanalla katkoviivalla ja `AUTO`-merkillä.

- **Niitä ei tallenneta kantaan.** Ne lasketaan aina uudelleen, joten ne
  pysyvät ajan tasalla suunnitelman muuttuessa.
- **Ne eivät ole kuitattavissa** eivätkä vaikuta kuormituslaskentaan.
- **Ne eivät koskaan aiheuta myöhässä-tilaa** — koska ne eivät koskaan tule
  valmiiksi, ensimmäinen niistä jäisi muuten jumiin koko päiväksi. Tämä oli
  todellinen bugi ja siitä on nyt regressiotesti.
- **Ne väistävät käyttäjän omaa suunnitelmaa:** jos aamutoimien aikaikkunassa
  on jo oma merkintä, ehdotusta ei näytetä.

### Kuormitus

Merkintöjen määrä päivässä: 0 = ei suunniteltua, 1–3 kevyt, 4–7 kohtalainen,
8+ raskas. Savenpunainen on varattu **vain** raskaalle päivälle.

---

## Aikataulumoottori

Puhdas funktio: sama syöte tuottaa aina saman tuloksen. Ei kelloa, ei
satunnaisuutta, ei verkkoa, ei DOM:ia. Nykyhetki annetaan parametrina.

### Takuut

1. **Deterministinen** — syötteen järjestys ei vaikuta tulokseen
2. **Ei koskaan siirrä manuaalista tehtävää**
3. **Ei koskaan sijoita päällekkäin** varatun ajan kanssa
4. **Ei ehdota mitään, jos tilaa ei ole** — tehtävä jää `unplaced`-listaan
   sen sijaan että se tungettaisiin väkisin

### Sijoitusalgoritmi

```
1. laske valveillaoloikkuna (herätys → nukkumaanmeno)
2. laske varatut välit (yhdistä päällekkäiset)
3. vapaat välit = ikkuna − varatut, vähintään 15 min
4. järjestä siirrettävät tehtävät: prioriteetti, sitten nimi
5. jokaiselle: ensimmäinen väli johon kesto mahtuu
6. kuluta väli; alle 15 min jäännös hylätään
7. mahtumattomat -> unplaced
```

Kestoton tehtävä saa oletuskeston 30 min.

**Ehdotus ei ole päätös.** Se näytetään perusteluineen ("Vapaa 90 min väli klo
14:00") ja käyttäjä hyväksyy sen erikseen. Vasta hyväksyntä muuttaa tehtävän
tilan `auto`-tilaan.

---

## Viikko

Alkaa **maanantaista**. JS:n `getDay()` palauttaa sunnuntain nollana, mikä on
klassinen off-by-one-ansa kuukauden ja vuoden vaihteessa — siksi rajatapaukset
on testattu erikseen (sunnuntai, kuukauden vaihde, vuodenvaihde, karkausvuosi).

Viikkonauha näyttää päivittäin kuormituspisteen ja merkin, jos päivällä on
kesken oleva tärkeä tehtävä.

---

## Profiili

Profiilin kentät eivät ole koristeita: ne syöttävät suoraan aikataulumoottoria.

| Kenttä | Vaikutus |
|---|---|
| `sleepTargetHours` | Nukkumaanmenoaika |
| `defaultWakeTime` | Herätys, kun päivälle ei ole työtä |
| `commuteMinutes` | Herätys, kun työtehtävä ankkuroi |
| `routineMinutes` | Herätys + aamutoimien pituus |
| `age`, `weightKg`, `heightCm` | **Ei vielä vaikutusta.** Varattu hyvinvointimoduulille (WP8) |

Profiilinäkymä näyttää suoraan, mihin kellonaikoihin nykyiset asetukset
johtavat — abstrakti luku muuttuu ymmärrettäväksi ennen tallennusta.

---

## WP7-WP12:ssa lisätyt käsitteet

Jokaisella on oma dokumenttinsa, jossa perustelut ovat tarkemmin.

| Käsite | Moduuli | Dokumentti |
|---|---|---|
| Rutiini ja poikkeus | `domain/routine.js` | `docs/ROUTINES.md` |
| Tavoite ja edistyminen | `domain/goal.js` | `docs/GOALS.md` |
| Projekti | `domain/project.js` | `docs/GOALS.md` |
| Määräaika ja kiireellisyys | `domain/task.js` | `docs/GOALS.md` |
| Päivän fokus | `domain/focus.js` | — |
| Illan ja viikon katsaus | `domain/review.js` | — |
| Muistutus ja eskalaatio | `domain/notification.js` | `docs/NOTIFICATIONS.md` |
| Hyvinvointimerkintä | `domain/wellbeing.js` | — |
| Lasku ja toistuva kulu | `domain/finance.js` | `docs/INVESTMENTS-ARCHITECTURE.md` |

### Kolme sääntöä, jotka toistuvat kaikissa

1. **Johdettu tieto ei ole tallennettua.** Myöhästyminen, kiireellisyys ja
   tavoitteen edistyminen lasketaan aina uudelleen. Tallennettuna ne
   vanhenisivat heti: eilen "ajallaan" merkitty rivi olisi tänään väärässä.
2. **Sääntö ei ole tapahtuma.** Rutiini on sääntö, ei 260 tehtävää vuodessa.
   Toistuva kulu on sääntö, ei lista laskuja. Esiintymät lasketaan säännöstä.
3. **Käyttäjän päätös voittaa laskennan.** Saavutetuksi merkitty tavoite on
   100 %, vaikka tehtäviä jäisi. Käyttäjän ajastamaa tehtävää ei siirretä.

## Käsitteet, joita EI vielä ole

Konseptidokumentissa määritelty, domainissa ei. Ks. `docs/ROADMAP.md`.

| Käsite | Tila |
|---|---|
| Uni-toteutuma ja ateria | Ei domainia |
| Budjetti ja tulot | Ei domainia; laskut ja kulut ovat |
| Sijainti ja lähtöaika | Ei toteutusta, kyvykkyysrekisterissä PLANNED |
| Rutiinin esiintymän kuittaus | Vaatii oman taulunsa, ks. `docs/ROUTINES.md` |
| Tavoitehierarkia käyttöliittymässä | Kenttä on, valintaa ei |
| Sijoitusseuranta | Vain arkkitehtuuri |

**Ei koodissa eikä konseptissa:** journalointi, social, julkaisut, kommentit,
reaktiot. Nämä eivät kuulu tuotteeseen.
