# Käyttöliittymän tavoitettavuus — kahdeksantoista domainia

**Tila:** kolmetoista tavoitettavissa, **viisi ei**. Aallon H domainit
(saapuvat, muistutukset, ilmoitukset, matka, sijaintisäännöt) ovat
domainina ja kannassa valmiita mutta ilman näkymää — ja siksi aalto H
on merkitty **ESTETYKSI**.
**Lähde:** `tools/release/reachability.mjs`, testattu
`tests/ui-reachability.test.mjs`.

---

## Miksi tämä dokumentti on olemassa

Portti avaa **tallennuksen**. Se ei avaa käyttöliittymää eikä luo
näkymää.

Taulu, RLS, repositorio ja domain-logiikka voivat olla täydellisiä
samalla kun käyttäjä ei pääse ominaisuuteen lainkaan — ja silloin
portin avaaminen ei anna hänelle mitään. Kaikki aiemmat tarkistukset
katsoivat kantaa. Yksikään ei kysynyt, löytääkö käyttäjä ominaisuuden.

Se paljastui vasta kun käyttäjä etsi tuotannosta hyvinvointia ja
taloutta eikä löytänyt kumpaakaan.

---

## Matriisi

| Domain | Käyttöliittymä | Polku | Näkyvä nimi | CRUD | Aalto |
|---|---|---|---|---|---|
| `notificationPreferences` | **ON** | Profiili → asetuslohko | Muistutukset | luku, tallennus | A |
| `wellbeing` | **ON** | Tänään → avattava lohko | **Hyvinvointi** | luku, tallennus | A |
| `goals` | **ON** | Tavoitteet → Tavoitteet | Tavoitteet | täysi | B |
| `projects` | **ON** | Tavoitteet → **Projektit** | Projektit | täysi + tavoiteliitos | B |
| `routines` | **ON** | Tekeminen → Rutiinit | Rutiinit | täysi | C |
| `routineExceptions` | **ON** | Tänään → "Ohita" | Ohita | luonti, peruutus | C |
| `recurringExpenses` | **ON** | **Talous** → Toistuvat menot | Toistuvat menot | täysi + käytöstä poisto | D |
| `savingsGoals` | **ON** | **Talous** → Säästötavoitteet | Säästötavoitteet | täysi | D |
| `bills` | **ON** | **Talous** → Laskut | Laskut | täysi + maksumerkintä | D |
| `aiAudit` | tausta | — | — | kirjoitus AI-komennoista | E |
| `transactions` | **ON** | **Talous** → Tapahtumat | Tapahtumat | täysi + kuitista luenta | F |
| `investments` | **ON** | **Talous** → Sijoitukset | Sijoitukset | täysi + arvon käsin päivitys | F |
| `milestones` | **ON** | **Tavoitteet** → tavoite → Suunnitelma | Välitavoitteet | täysi + järjestys + saavutus | G |
| `inboxItems` | **EI** | — | — | ei mitään | H |
| `reminders` | **EI** | — | — | ei mitään | H |
| `notices` | **EI** | — | — | ei mitään | H |
| `travelPlans` | **EI** | — | — | ei mitään | H |
| `locationRules` | **EI** | — | — | ei mitään | H |

### Aallon H viisi puuttuvaa näkymää

Nämä eivät ole taantuma vaan **rehellinen välitila**. Domain-moduulit
(`src/domain/inbox.js`, `reminder.js`, `travel.js`,
`notificationCenter.js`), repositoriot ja migraatio `0011` ovat
olemassa; käyttäjälle näkyvää polkua ei ole.

Portti pysyy kiinni juuri siksi. Kirjaus ilman lukemista on tiedon
nielu, ja tallennettu muistutus jota ei näytetä on lupaus jota ei
pidetä.

Huomaa ero `aiAudit`-riviin: kirjausketju on **tausta-aineistoa**, eikä
sille ole tarkoituskaan rakentaa selainta. Ilmoitus sen sijaan
kirjoitetaan nimenomaan käyttäjän luettavaksi, joten näkymän
puuttuminen on **puute eikä valinta**.

`locationRules` vaatii näkymän lisäksi sijaintiluvan kysymisen. Lupaa
ei oleteta: sääntö on kannassa oletuksena pois päältä.

**Portti ei vaikuta näkyvyyteen.** Kaikki näkymät ovat käytettävissä
myös portin ollessa kiinni — silloin tieto elää istunnon muistissa ja
käyttöliittymä kertoo sen. Portti vaihtaa vain tallennuspaikan.

Se on tarkoituksellista: koko käyttöliittymä voidaan hyväksyä
selaimessa **ennen** kuin yhtäkään porttia avataan.

---

## Mitä rakennettiin

### Projektit — Tavoitteet-välilehden toinen segmentti

Projekti on tavoitteen ja tehtävän välissä: työn kehys, ei syy eikä
yksittäinen teko. Sama suhde on jo kannassa (`projects.goal_id`), ja
käyttöliittymässä se näkyy parhaiten tavoitteiden vieressä.

Rakenne on **sama kaava kuin Tekeminen-välilehdellä** (Tehtävät /
Rutiinit), joten navigaatioon ei tullut uutta käsitettä.

- lista, tyhjä tila, luonti, muokkaus, poisto vahvistuksella
- liitos tavoitteeseen ja liitoksen purku
- edistyminen liitettyjen tehtävien perusteella
- riskimerkintä (myöhässä / vaarassa) `projectRisk`-funktiosta

**Poisto ei poista tehtäviä.** Niiden liitos vain katkeaa — sama sääntö
kuin kannassa (`on delete set null (project_id)`).

### Talous — oma välilehti

Kolme osiota yhden yleiskuvan alla. Yleiskuva laskee **olemassa
olevista riveistä**: avoimet laskut, myöhässä olevat, toistuvien
menojen kuukausisumma, säästötavoitteiden määrä.

Ei pankkiyhteyksiä, ei tilisaldoja, ei sijoituksia, ei tuloja, ei
ennusteita. Ei mitään mitä mallissa ei ole.

| Osio | Mitä käyttäjä voi tehdä |
|---|---|
| **Laskut** | luonti, muokkaus, poisto, maksetuksi/avoimeksi, liitos toistuvaan menoon |
| **Toistuvat menot** | luonti, muokkaus, poisto, jakso, kuukauden päivä, käytöstä poisto |
| **Säästötavoitteet** | luonti, muokkaus, poisto, tavoite- ja kertynyt summa, edistymispalkki |

**Laskuja ei synny itsestään.** Toistuvasta menosta ei generoidu
laskuja automaattisesti — sellaista ei ole mallissa, eikä sitä
keksitty tässä. Menon poisto **ei poista** siitä syntyneitä laskuja.

---

## Raha

Summat kulkevat **sentteinä kokonaislukuina** koko ketjun läpi:

```
"12,34"  ->  parseMoneyToMinor  ->  1234  ->  bigint  ->  formatMoney  ->  "12,34 €"
```

Liukulukua ei synny missään vaiheessa. Sekä pilkku että piste
kelpaavat desimaalierottimeksi: suomalainen kirjoittaa pilkun,
numeronäppäimistö tuottaa pisteen, ja kumpikin tarkoittaa samaa.

**Kelvoton syöte ei pyöristy hiljaa.** Se on `null`, ja validointi
kertoo siitä käyttäjälle. Kolmen desimaalin `12,345` hylätään — se ei
muutu arvoksi `12,35` ilman että kukaan sanoo mitään.

Edistyminen ei jaa nollalla: `percentOf` palauttaa nollatavoitteelle
nollan, eikä prosentti voi olla `NaN` tai `Infinity`. Ylitys näkyy
täytenä, ei yli sadan prosentin.

---

## Päivät

Kaikki päivämääräkentät ovat kannassa `date`, eivät `timestamptz`.
Käyttöliittymä käsittelee ne ISO-merkkijonoina (`YYYY-MM-DD`) eikä
muunna niitä koskaan aikaleimaksi.

Se on olennaista: jos arvo kulkisi UTC-aikaleiman kautta, suomalainen
1.10. voisi tallentua 30.9:ksi. Testi lukitsee tämän jokaiselle
päivämääräkentälle.

---

## Hyvinvointi: miksi käyttäjä ei löytänyt sitä

Näkymä oli olemassa ja toimi. Vika oli **nimessä ja sijainnissa**:
otsikko oli "Miten menee?", eikä sanaa *hyvinvointi* esiintynyt
käyttöliittymässä kertaakaan.

**Korjattu:** otsikko on nyt **Hyvinvointi**; kysymys siirtyi sisälle
vihjeeksi.

---

## AI-kirjausketju

Kirjausketju on **tausta-aineisto**, ei käyttäjän näkymä. Kirjoituspolku
puuttui kokonaan ja lisättiin perustilan korjauksessa.

Kirjausten lukemiseen ei ole käyttöliittymää. Rivit ovat kannassa ja
luettavissa SQL-editorista. Se ei estä aaltoa E: kirjausketjun arvo on
siinä että se on olemassa, ei siinä että sitä selataan.

---

## Miten tämä pysyy ajan tasalla

`tests/ui-reachability.test.mjs` todentaa jokaisen väitteen
lähdekoodista joka ajolla:

- väitetty `html`-tunniste on `index.html`:ssä
- väitetty näkymätiedosto renderöi siihen
- **väitetty näkyvä nimi esiintyy käyttöliittymässä** — tämä testi
  olisi löytänyt hyvinvointivian
- puuttuvaksi merkitty domain ei esiinny käyttöliittymässä
- **aallon valmiustila johdetaan tavoitettavuudesta**, ei kirjoiteta käsin

Viimeinen on tärkein: aalto, jonka domainilta puuttuu käyttöliittymä,
ei voi olla merkitty valmiiksi. Jos joku poistaa talousnäkymän, aallon
D valmiustila kaatuu automaattisesti.
