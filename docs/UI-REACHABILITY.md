# Käyttöliittymän tavoitettavuus — kolmekymmentäneljä domainia

**Tila:** kaikki kolmekymmentäneljä tavoitettavissa (aallon K kymmenen mukaan lukien). Auditoitu ja korjattu.
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
| `inboxItems` | **ON** | **Tänään** → kirjauspalkki; Tekeminen → Saapuvat | Saapuvat | kirjaus, tulkinta, hyväksyntä, hylkäys | H |
| `reminders` | **ON** | **Tekeminen** → Muistutukset | Muistutukset | täysi + torkutus ja kuittaus | H |
| `notices` | **ON** | **Tänään** → Ilmoitukset | Ilmoitukset | luku, kuittaus, hylkäys | H |
| `travelPlans` | **ON** | **Tekeminen** → Matka | Matkat | täysi + matka-ajan käsin kirjaus | H |
| `locationRules` | **ON** | **Tekeminen** → Matka → Paikkamuistutukset | Paikkamuistutukset | täysi + päälle/pois | H |
| `lifeAreas` | **ON** | **Suunta** → Elämänalueet | Elämänalueet | täysi + pois käytöstä | I |
| `weeklyCapacities` | **ON** | **Suunta** → Tämä viikko → Kapasiteetti | Kapasiteetti | luku + tallennus | I |
| `timeEntries` | **ON** | **Suunta** → Toteuma | Toteuma | luonti + luku + poisto | I |
| `alignmentReviews` | **ON** | **Suunta** → Viikkokatsaus | Viikkokatsaus | luonti + luku + päivitys | I |
| `runningTimers` | **ON** | Kaikki näkymät → **Ajanseuranta**-palkki (käynnistys Suunnasta, tehtävästä, projektista tai rutiinista) | Ajanseuranta | käynnistys + tauko + pysäytys + hylkäys | J |
| `alignmentItemSettings` | **ON** | Tehtävä → **Kuormittavuus** (myös rutiini, projekti, Suunta → Arvioi tehtäviä) | Kuormittavuus | luonti + luku + muokkaus + poisto kohteen mukana | J |
| `savedPlaces` | **ON** | **Profiili** → Paikat | Paikat | täysi + oletusetuaika | K |
| `placeAliases` | **ON** | **Profiili** → Paikat → paikan Tunnetut nimitykset | Tunnetut nimitykset | luku + poisto + oppimisen nollaus; syntyy vahvistuksesta | K |
| `calendarEvents` | **ON** | **Kalenteri** → Päivä / Viikko / Kuukausi → Uusi meno | Kalenteri | täysi + yhden kerran ohitus | K |
| `commuteObservations` | **ON** | **Profiili** → Paikat → matkojen oppiminen; syntyy "Lähdin" / "Olin perillä" | Paikat | luku + nollaus | K |
| `lifeSettings` | **ON** | **Profiili** → Arki (ja Asetukset → Ohjaus ja puhe) | Arki | luku + tallennus | K |
| `sleepLogs` | **ON** | **Profiili** → Hyvinvointi → Uni | Uni | luonti + muokkaus | K |
| `habitPlans` | **ON** | **Profiili** → Hyvinvointi → Tapojen muutos | Tapojen muutos | täysi | K |
| `habitEvents` | **ON** | **Profiili** → Hyvinvointi → Tapojen muutos; **Tänään** → tapakortti | Tapojen muutos | kirjaus + edistyminen | K |
| `exerciseSessions` | **ON** | **Profiili** → Hyvinvointi → Liikunta | Liikunta | täysi | K |
| `wellbeingCheckins` | **ON** | **Tänään** → voinnin kortti; **Profiili** → Hyvinvointi (14 pv) | Motivaatio | kirjaus + historia | K |
| `protectedPeriods` | **ON** | **Profiili** → Suojattu aika (`#protectedTimeContainer`) | Suojattu aika | täysi + päälle/pois | L |
| `weeklyPlans` | **ON** | **Tänään** / **Suunta** → Sunnuntain nollaus (`#sundayResetDialog`) | Sunnuntain nollaus | luonti + päivitys + viikon sulkeminen | L |

### Aallon L kaksi domainia

Suojattu aika (Profiili → Suojattu aika, `#protectedTimeContainer`) ja
Sunnuntain nollaus (`#sundayResetDialog`, avataan Tänään-näkymän
`#sundayResetOpenBtn`- ja Suunnan `#dirSundayResetBtn`-painikkeista).
Tekeminen → Tallessa (`#storedListContainer`) näyttää tehtävien
horisontit; se kuuluu sarakeporttiin `MENTAL_LOAD_FIELDS` eikä ole oma
taulunsa. Aalto L on estetty kannan takia: migraatiota `0015` ei ole
ajettu.

### Aallon K kymmenen domainia

Näkymät on rakennettu (Kalenteri-välilehti, Profiilin osiot Arki,
Hyvinvointi ja Paikat sekä Tänään-kortit), ja jokaisella rivillä on
koneellisesti tarkistettava todiste (`tools/release/reachability.mjs`).
Aalto K on estetty enää **vain kannan takia**: migraatiota `0014` ei ole
ajettu.

### Aallon H viisi näkymää

Nämä olivat hetken **EI** — domain, repositorio ja migraatio olivat
olemassa, käyttäjälle näkyvää polkua ei. Se oli rehellinen välitila,
ei taantuma, ja se näkyi aallon H valmiustilassa ESTETTYNÄ.

Näkymät on nyt rakennettu. Aalto H on yhä estetty, mutta enää **vain
kannan takia**: migraatiota `0011` ei ole ajettu.

Huomaa ero `aiAudit`-riviin: kirjausketju on **tausta-aineistoa**, eikä
sille ole tarkoituskaan rakentaa selainta. Ilmoitus sen sijaan
kirjoitetaan nimenomaan käyttäjän luettavaksi — ilmoitus jota ei
näytetä ei ole ilmoitus.

`locationRules` vaatii näkymän lisäksi sijaintiluvan kysymisen. Lupaa
ei oleteta: sääntö on kannassa oletuksena pois päältä, ja päälle
kytkeminen kysyy vahvistuksen.

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
