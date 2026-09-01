# Tavoitteet ja projektit

**Tehtävä ilman tavoitetta on työtä. Tavoite ilman tehtäviä on toivelista.**

Toteutus: `src/domain/goal.js`, `src/domain/project.js`, `src/app/views/goals.js`
Testit: `tests/domain-goal-project.test.mjs`, `tests/invariants.test.mjs`
Skeema: `supabase/migrations/0004_goals_projects.sql`

---

## Käsitteiden ero

| Käsite | Vastaa kysymykseen | Elinkaari |
|---|---|---|
| Tavoite | **Miksi?** | Kuukausia tai vuosia |
| Projekti | **Mikä kokonaisuus?** | Viikkoja tai kuukausia |
| Tehtävä | **Mitä teen?** | Minuutteja tai tunteja |

Hierarkia on löyhä tarkoituksella:

```
Tavoite ──> Projekti ──> Tehtävä
   │                        │
   └────────────────────────┘
        (tehtävä voi liittyä suoraan tavoitteeseen)
```

Tehtävän ei ole pakko kuulua projektiin kuuluakseen tavoitteeseen. Pakollinen
välitaso lisäisi kitkaa juuri siihen kohtaan, jossa käyttäjä on
kiireisimmillään.

---

## Yksi tavoite per tehtävä

Tehtävällä on `goalId`, ei `goalIds`. Monen-moneen-suhde hylättiin, koska:

1. Käyttöliittymä muuttuisi monivalinnaksi jokaisessa lomakkeessa.
2. Edistymisen laskenta muuttuisi kaksiselitteiseksi: kumpaan tavoitteeseen
   valmistunut tehtävä lasketaan, vai molempiin?
3. Käytännössä tehtävällä on yksi tarkoitus. Jos tarkoituksia on kaksi,
   tehtäviä on todennäköisesti kaksi.

---

## Edistymisen laskenta

`computeGoalProgress(goal, tasks)` on puhdas funktio.

### Kaksi tapaa

| `progressMode` | Mistä prosentti tulee |
|---|---|
| `task_based` | Liitetyistä tehtävistä: valmiit / kaikki |
| `manual` | Käyttäjän itse arvioima luku |

`task_based` on oletus, koska se on ainoa, joka pysyy totena ilman että
käyttäjä muistaa päivittää sitä.

`manual` on olemassa tavoitteille, joita ei voi pilkkoa tehtäviksi
mielekkäästi ("opi ruotsia"). Käyttöliittymä merkitsee ne näkyvästi tekstillä
"itse arvioitu", jottei lukua luulisi lasketuksi.

### Kolme sääntöä, jotka on helppo saada väärin

**1. Tyhjä tavoite on 0 %, ei 100 %.**

Nolla tehtävää jaettuna nollalla ei ole "valmis". Naiivi toteutus
(`completed / total`) antaisi joko NaN:n tai — jos jakaja suojataan
huolimattomasti — sadan prosentin. Tyhjä tavoite on vasta alussa, ei lopussa.

**2. Saavutettu tavoite on aina 100 %.**

Jos käyttäjä merkitsee tavoitteen saavutetuksi, se on saavutettu — vaikka
tehtävälistalle jäisi rivejä. Käyttäjän päätös voittaa laskennan.

**3. Prosentti ei koskaan laske, kun tehtävä kuitataan.**

Tämä on lukittu invarianttitestillä. Sääntö kuulostaa itsestäänselvältä,
mutta se rikkoutuisi heti, jos laskenta ottaisi mukaan esimerkiksi
"jäljellä olevan ajan" tai suodattaisi valmiit tehtävät pois jakajasta.

---

## Tilat

| Tila | Merkitys | Näkyy valikossa |
|---|---|---|
| `active` | Työn alla | kyllä |
| `paused` | Tauolla, palataan myöhemmin | kyllä |
| `completed` | Saavutettu | ei |
| `archived` | Ei enää ajankohtainen | ei |

Tehtävälomakkeen tavoitevalikko tarjoaa vain avoimia (`active`, `paused`)
tavoitteita. Se pitää valikon lyhyenä.

**Poikkeus, joka on pakko käsitellä:** jos muokattava tehtävä on liitetty
saavutettuun tai arkistoituun tavoitteeseen, kyseinen tavoite lisätään
valikkoon takaisin — merkittynä tilallaan. Ilman tätä lomakkeen tallennus
katkaisisi linkin hiljaisesti, koska selain ei voi valita vaihtoehtoa, jota
ei ole olemassa.

---

## Poistaminen ei koskaan poista työtä

Tavoitteen poisto **ei poista sen tehtäviä**. Tehtävien `goalId` nollataan
(`on delete set null`).

Perustelu: työ on tehty, vaikka syy siihen olisi muuttunut. Tehtävien
poistaminen tavoitteen mukana olisi tietohäviö, jota käyttäjä ei osaa odottaa
ja jota ei voi perua.

Sama pätee projekteihin.

---

## Tavoitepäivä ja myöhästyminen

`targetDate` on vapaaehtoinen. Jos se on menneisyydessä eikä tavoite ole
valmis, tavoite on myöhässä — se näkyy korostettuna sekä tavoitenäkymässä
että viikkonäkymän tavoiteosiossa.

Myöhästyminen on **johdettu**, ei tallennettu tila. Tallennettuna se
vanhenisi heti: rivi, joka on merkitty "ajallaan", olisi huomenna väärässä.

---

## Näkyminen käyttöliittymässä

| Paikka | Miten näkyy |
|---|---|
| Tavoitteet (oma välilehti) | Kortti: edistymispalkki, liitetyt tehtävät, seuraava askel |
| Viikko | Neljän tavoitteen edistyminen viikon lopussa |
| Tehtävälomake | Tavoitevalikko |
| Tänään, fokus | Tavoitteeseen liitetty tehtävä saa pisteitä (+15) |

Tavoitekortti näyttää **liitetyt avoimet tehtävät suoraan**, enintään neljä.
Tavoite, jonka alta ei näe yhtään konkreettista askelta, on juuri se
toivelista, jota tämä moduuli yrittää estää.

---

## Projektit

Projektidomain (`src/domain/project.js`) on toteutettu ja testattu, ja sillä
on oma taulunsa migraatiossa 0004. **Sille ei ole vielä omaa näkymää.**

Tämä on tietoinen rajaus: tavoite + tehtävä riittää useimpaan, ja projektin
oma näkymä kannattaa suunnitella vasta kun tavoitteet ovat olleet
oikeassa käytössä. Domain on olemassa, jotta tehtävän `projectId` ja
tavoitteen `projectId` eivät ole tyhjiä lupauksia skeemassa.

---

## Rajoitukset

- Ei projektinäkymää
- Ei tavoitehierarkian (`parentGoalId`) käyttöliittymää — kenttä on olemassa
  skeemassa ja domainissa, muttei valittavissa
- Ei painotettua edistymistä (kaikki tehtävät ovat yhtä arvokkaita)
- Ei tavoitteen historiaa tai edistymiskäyrää ajassa
