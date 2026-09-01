# Talous ja sijoitukset — arkkitehtuuriluonnos

**TILA: SIJOITUSSEURANTA ON PLANNED — siitä ei ole toteutettu riviäkään.**
**Laskuista ja toistuvista kuluista on kevyt domain, ei muuta.**

Tämä dokumentti on suunnitelma, ei kuvaus. Se on kirjoitettu nyt, jotta
myöhemmät päätökset — erityisesti tietoturvaa koskevat — tehdään ennen kuin
ensimmäinen rivi on olemassa, ei sen jälkeen.

Taloudesta on tällä hetkellä olemassa kaksi asiaa:

1. Kategoria `talous` tehtävissä ja tavoitteissa.
2. **Kevyt domain** `src/domain/finance.js`: `Bill`, `RecurringExpense` ja
   talousmuistutukset. Puhdas ja testattu (36 testiä), mutta sillä **ei ole
   käyttöliittymää eikä tallennusta** — se on perusta, ei ominaisuus.

Sijoitusseurannasta ei ole olemassa riviäkään koodia.

---

## Miksi tämä on eri asia kuin muu sovellus

Manifestivalin muu data on henkilökohtaista mutta ei suoraan rahanarvoista.
Kalenterimerkinnän vuotaminen on kiusallista. **Varallisuustiedon vuotaminen
on vaarallista** — se tekee käyttäjästä kohteen.

Siksi tämä osa-alue ei ole "vielä yksi taulu lisää". Se vaatii omat
päätöksensä ennen toteutusta:

| Kysymys | Ei saa jäädä auki toteutusvaiheeseen |
|---|---|
| Mitä tallennetaan? | Saldo vai vain tavoite ja edistyminen? |
| Kuka näkee? | Riittääkö RLS vai tarvitaanko salaus levossa? |
| Mistä data tulee? | Käsin vai integraatio? |
| Mitä sovellus saa sanoa? | Neuvo vai havainto? |

---

## Rajaus: sovellus ei anna sijoitusneuvontaa

Tämä on kova rajaus, ei mielipide.

Sijoitusneuvonta on säänneltyä toimintaa. Henkilökohtainen sovellus, joka
sanoo "osta tätä" tai "myy nyt", on sekä juridisesti ongelmallinen että
tuotteena väärässä: se lupaa osaamista, jota sillä ei ole.

| Sallittu | Kielletty |
|---|---|
| "Säästötavoitteesta on kertynyt 62 %" | "Sijoita tähän rahastoon" |
| "Kuluerä X on kasvanut kolmena kuukautena" | "Myy nyt, markkina kääntyy" |
| "Hätävara riittää 2,5 kuukaudeksi" | "Tämä on hyvä ostopaikka" |
| "Et ole kirjannut kuluja 3 viikkoon" | Tuotto-odotusten ennustaminen |

Sovellus **kuvaa mitä on**, ei ennusta mitä tulee. Sama periaate kuin
hyvinvoinnissa: havainto ja ehdotus ovat sallittuja, diagnoosi ja määräys
eivät.

---

## Kolme tasoa, kolme eri riskiä

Toteutus kannattaa tehdä tasoittain, ja jokainen taso on oma päätöksensä.

### Taso 1 — Talousrutiinit (pienin riski)

Ei rahasummia lainkaan. Vain toistuvat tekemiset:

- "Maksa laskut" — rutiini, joka toistuu kuukausittain
- "Tarkista tilitapahtumat" — viikoittain
- "Säästä palkasta" — kuukausittain

**Tämä on jo mahdollista** nykyisillä rutiineilla ja kategorialla `talous`.
Ei vaadi uutta koodia eikä uutta skeemaa. Ainoa puute on kuukausittainen
toisto, joka on rutiinimoduulin tunnettu rajoitus.

### Taso 2 — Säästötavoitteet (keskitason riski)

Tavoite, jolla on numeerinen kohde ja kertymä:

```
Hätävara            tavoite 6000 €   kertynyt 3700 €   62 %
Auton vaihto        tavoite 15000 €  kertynyt 2100 €   14 %
```

Tämä sopii olemassa olevaan tavoitemalliin lähes sellaisenaan:
`progressMode = 'manual'` ja prosentti. Erillinen numeerinen kenttä olisi
kuitenkin parempi, koska prosentti kadottaa summan.

Ehdotettu laajennus tavoitteeseen — **ei toteutettu**:

```
target_amount   numeric(12, 2)
current_amount  numeric(12, 2)
currency        text default 'EUR'
```

Riski: summat ovat rahanarvoista tietoa, mutta ne ovat käyttäjän itse
kirjaamia eivätkä yhdisty tiliin. Sama RLS-malli riittää.

### Taso 3 — Salkku ja varallisuus (suurin riski)

Omistukset, arvot, tuotto. **Tätä ei pidä toteuttaa ennen kuin tasot 1 ja 2
ovat olleet oikeassa käytössä.**

Vaatii päätökset, joita ei ole tehty:

- Salataanko arvot levossa asiakaspuolen avaimella? Silloin palvelin ei näe
  niitä — mutta silloin niitä ei voi myöskään laskea yhteen palvelimella
  eikä palauttaa unohtuneella salasanalla.
- Haetaanko markkinahinnat? Se tarkoittaa ulkoista rajapintaa, jonka kutsut
  paljastavat mitä käyttäjä omistaa.
- Mitä tapahtuu, kun käyttäjä poistaa tilinsä? Varallisuushistoria on
  poistettava välittömästi, ei varmuuskopioiden elinkaaren mukaan.

---

## Sijoitusseurannan domain-malli (PLANNED, ei toteutettu)

Kuusi käsitettä. Jokainen on **PLANNED** — yhtään ei ole toteutettu, eikä
tässä aallossa integroida markkinadataa.

| Käsite | Vastaa kysymykseen | Tila |
|---|---|---|
| `Portfolio` | Mitä kokonaisuutta seuraan? | PLANNED |
| `Holding` | Mitä omistan ja kuinka paljon? | PLANNED |
| `Transaction` | Mitä tapahtui ja milloin? | PLANNED |
| `PriceSnapshot` | Mikä oli arvo tiettynä hetkenä? | PLANNED |
| `TargetPrice` | Mihin hintaan haluan reagoida? | PLANNED |
| `AlertRule` | Milloin minulle kerrotaan? | PLANNED |

### Omaisuuslajit

```
crypto | stock | etf | fund | index
```

`index` on mukana seurattavana vertailukohtana, ei omistuksena: indeksiä ei
voi omistaa, mutta siihen voi verrata. Siksi `Holding.quantity` on sille
null ja se esiintyy vain seurantalistalla.

### Suhteet

```
Portfolio 1 ── n Holding 1 ── n Transaction
                   │
                   ├── n PriceSnapshot   (aikasarja, vain luku)
                   └── n TargetPrice ── 1 AlertRule
```

### Miksi Transaction on erillinen Holdingista

`Holding` kertoo nykytilan, `Transaction` sen miten siihen päädyttiin.
Naiivissa mallissa olisi vain `Holding.quantity` ja `Holding.unitCost`, jota
päivitetään oston yhteydessä. Se rikkoutuu heti kun:

- osto tehdään useassa erässä eri hintaan (hankintahinnan keskiarvo)
- osa myydään (mikä erä myytiin? FIFO vai keskihinta?)
- tarvitaan verotusta varten toteutunut voitto

Tapahtumat ovat **muuttumattomia**: virhe korjataan uudella oikaisevalla
tapahtumalla, ei muokkaamalla vanhaa. Sama periaate kuin kirjanpidossa, ja
samasta syystä — historian jälkikäteinen muuttaminen tekee luvuista
tarkistuskelvottomia.

### Miksi Holdingissa ei ole nykyarvoa

`Holding` sisältää määrän ja hankintahinnan, **ei nykyarvoa**. Nykyarvo on
johdettu tieto, joka vanhenee heti kirjoitushetkellä — sama syy kuin miksi
tehtävän "myöhässä" ei ole tallennettu kenttä. Arvo lasketaan viimeisimmästä
`PriceSnapshot`-rivistä tarvittaessa.

### AlertRule ja rajaus neuvontaan

`AlertRule` saa kertoa vain sen, mitä käyttäjä on itse pyytänyt:

```
"Kerro kun BTC käy alle 50 000 €"        sallittu — käyttäjän oma sääntö
"Nyt kannattaa ostaa"                     KIELLETTY — neuvo
"Tuotto-odotus ensi vuonna on 8 %"        KIELLETTY — ennuste
```

Hälytys on kello, ei neuvonantaja. Ero on juridinen, mutta myös tuotteen
kannalta oikea: sovellus ei tiedä käyttäjän kokonaistilannetta eikä
riskinsietokykyä.

### Kenttäluonnos

```
Portfolio       id, userId, name, baseCurrency, createdAt
Holding         id, userId, portfolioId, assetType, symbol, label,
                quantity, averageUnitCost, currency, watchOnly
Transaction     id, userId, holdingId, kind (buy|sell|dividend|fee),
                quantity, unitPrice, fee, currency, executedAt
PriceSnapshot   id, holdingId, price, currency, capturedAt, source
TargetPrice     id, userId, holdingId, direction (above|below),
                price, currency, active
AlertRule       id, userId, targetPriceId, channel, active, lastFiredAt
```

Kaikissa sama omistajuusmalli kuin muualla: `userId uuid default auth.uid()`,
RLS neljällä politiikalla, `anon` revokoitu.

### Mitä ennen toteutusta on päätettävä

1. **Salataanko arvot levossa?** Jos kyllä, palvelin ei voi laskea summia
   eikä salasanan unohtaminen ole palautettavissa.
2. **Mistä hinnat tulevat?** Ulkoisen rajapinnan kutsut paljastavat
   palveluntarjoajalle mitä käyttäjä omistaa.
3. **Mitä tilin poisto tarkoittaa?** Varallisuushistoria on poistettava
   välittömästi, ei varmuuskopioiden elinkaaren mukaan.

Yhtäkään näistä ei ratkaista tässä aallossa.

---

## Ehdotettu tietomalli laskuille ja säästötavoitteille (ei toteutettu)

Jos tasot 2 ja 3 joskus toteutetaan, muoto olisi tämä. Nimet vastaisivat
nykyisiä käytäntöjä: `text`-tunniste, `user_id uuid default auth.uid()`,
RLS neljällä politiikalla, `anon` revokoitu.

```
financial_goals
  id, user_id, title, target_amount, current_amount, currency,
  target_date, status, created_at, updated_at

recurring_expenses
  id, user_id, title, amount, currency, cadence, next_due_date,
  category, active, created_at, updated_at

holdings                        -- taso 3, ei ennen erillistä arviointia
  id, user_id, label, kind, quantity, unit_cost, currency,
  acquired_at, created_at, updated_at
```

Huom: `holdings`-taulussa **ei ole** nykyarvoa. Se olisi johdettu tieto, joka
vanhenee heti — sama syy kuin miksi myöhästyminen ei ole tallennettu kenttä.

---

## Mitä ei tehdä

- **Ei pankkiyhteyttä.** PSD2-integraatio vaatii lisenssin tai välittäjän,
  sopimuksia ja oman tietoturva-auditointinsa. Se ei kuulu henkilökohtaiseen
  projektiin ilman erillistä päätöstä.
- **Ei markkinadatan tilausta.** Reaaliaikainen kurssidata maksaa ja sitoo
  toimittajaan.
- **Ei automaattista kulujen luokittelua AI:lla.** Tilitapahtumien
  lähettäminen kielimallille on tietovuoto, jota käyttäjä ei odota.
- **Ei jakamista.** Talousnäkymää ei jaeta kenellekään, ei edes lukuoikeudella.

---

## Suhde muuhun sovellukseen

Talous ei ole erillinen saareke. Se liittyy olemassa olevaan malliin
kolmesta kohdasta:

```
Tavoite ──> säästötavoite (numeerinen kohde)
Rutiini ──> toistuva maksu tai tarkistus
Tehtävä ──> yksittäinen talousasia, kategoria 'talous'
```

Tämä on syy siihen, miksi omaa "talousmoduulia" ei kannata rakentaa
rinnakkaiseksi järjestelmäksi. Suurin osa tarpeesta täyttyy laajentamalla
sitä, mikä on jo olemassa.

---

## Seuraava askel, jos tähän joskus palataan

1. Käytä tasoa 1 (rutiinit + kategoria) vähintään kuukausi oikeasti.
2. Kirjaa mitä siitä puuttui. Älä suunnittele sitä etukäteen.
3. Toteuta taso 2 vasta sen perusteella.
4. Tee tasosta 3 erillinen tietoturva-arviointi ennen kuin kirjoitat
   ensimmäistä migraatiota.
