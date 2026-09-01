# Talous ja sijoitukset — arkkitehtuuriluonnos

**TILA: PLANNED. Tästä ei ole toteutettu riviäkään koodia.**

Tämä dokumentti on suunnitelma, ei kuvaus. Se on kirjoitettu nyt, jotta
myöhemmät päätökset — erityisesti tietoturvaa koskevat — tehdään ennen kuin
ensimmäinen rivi on olemassa, ei sen jälkeen.

Ainoa asia, joka taloudesta on tällä hetkellä olemassa, on kategoria
`talous` tehtävissä ja tavoitteissa.

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

## Ehdotettu tietomalli (ei toteutettu)

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
