# Sijainti ja lähtöaika — arkkitehtuuriluonnos

**TILA: PLANNED. Tästä ei ole toteutettu riviäkään koodia.**

Kyvykkyysrekisterissä `location` ja `background` ovat `supported: true`
natiivikuoressa mutta `implemented: false` kaikkialla. Tämä dokumentti
kertoo mitä toteutus vaatisi ja miksi sitä ei tehty nyt.

---

## Mitä tämä ratkaisisi

Konseptidokumentin lupaus: sovellus kertoo **milloin pitää lähteä**, ei
vain milloin tapahtuma alkaa.

```
Hammaslääkäri klo 14:00, Hämeenkatu 12
Matka-aika nyt 25 min  →  lähde klo 13:30
```

Tämä on aidosti arvokasta juuri niille, joille sovellus on tarkoitettu:
ihmisille, jotka myöhästyvät siksi ettei kukaan muistuttanut ajoissa.

---

## Miksi tätä ei toteutettu tässä aallossa

**Sitä ei voi todentaa ilman laitetta.** Sijaintiseuranta on
ominaisuus, jonka voi kirjoittaa näyttämään valmiilta ja joka toimii
väärin tavoilla, jotka paljastuvat vasta kun käyttäjä on myöhässä:

- lupa myönnetty vain "kun sovellus on käytössä"
- taustasijainti tapettu virransäästön takia
- viimeisin sijainti kuukauden vanha
- laite lentokonetilassa

Kirjoittaminen ilman todennusta olisi juuri se, mitä tässä projektissa on
toistuvasti vältetty: ominaisuus, joka väittää toimivansa.

Rajapinta ja kyvykkyysrekisterin merkintä ovat valmiit, joten toteutus on
myöhemmin laajennus eikä uudelleenkirjoitus.

---

## Käsitteet (kaikki PLANNED)

| Käsite | Merkitys |
|---|---|
| `EventLocation` | Tehtävän tai rutiinin sijainti — osoite tai koordinaatit |
| `CurrentLocation` | Missä käyttäjä on nyt |
| `TravelTimeProvider` | Rajapinta matka-ajan arvioon |
| `DepartureDeadline` | **Johdettu**: alkuaika − matka-aika − puskuri |
| `DepartureReminder` | Ilmoitus, joka lähtee kun lähtöaika lähestyy |

`DepartureDeadline` on johdettu tieto, ei tallennettu kenttä. Matka-aika
muuttuu tunnin sisällä; tallennettu lähtöaika olisi väärässä heti.

---

## Suhde olemassa olevaan

```
Tehtävä ── EventLocation
              │
              ├── TravelTimeProvider ──> matka-aika
              │
              └── DepartureDeadline ──> notification.js (DEPARTURE_REMINDER)
```

`NOTIFICATION_TYPE.DEPARTURE_REMINDER` on **jo olemassa** ja listattu
`PLANNED_TYPES`-taulukossa. Testi varmistaa, ettei toteuttamaton tyyppi
voi päätyä suunnitelmaan — eli sovellus ei voi vahingossa luvata
muistutusta, jota se ei osaa lähettää.

---

## Matka-ajan lähde: kolme vaihtoehtoa

| Vaihtoehto | Etu | Haitta |
|---|---|---|
| **Kiinteä arvio** (käyttäjä kertoo "25 min") | Ei riippuvuuksia, ei tietovuotoa, toimii offline | Ei huomioi ruuhkaa |
| **Laitteen navigointi** | Tarkka | Ei ohjelmallista rajapintaa arvioon |
| **Ulkoinen reitityspalvelu** | Tarkin | Kutsu paljastaa palveluntarjoajalle missä käyttäjä on ja minne menossa |

**Suositus: aloita kiinteästä arviosta.** Se kattaa toistuvat matkat
(työ, koulu, harrastus), jotka ovat juuri ne joissa myöhästyminen toistuu.
Se ei vuoda mitään eikä maksa mitään.

Ulkoinen palvelu on oma pakettinsa ja vaatii oman tietosuoja-arviointinsa.
**Tässä aallossa ei rakenneta karttariippuvuutta.**

---

## Tietosuoja

Sijainti on arkaluontoisin tieto, jota sovellus voisi käsitellä. Se kertoo
kotiosoitteen, työpaikan, lääkärikäynnit ja liikkumisen aikataulun.

Säännöt, jos tämä joskus toteutetaan:

1. **Sijaintihistoriaa ei tallenneta.** Vain viimeisin sijainti, vain
   muistissa, vain laskennan ajan.
2. **Tapahtuman sijainti on käyttäjän kirjoittama teksti**, ei automaattinen
   geokoodaus. Osoite ei lähde mihinkään ellei käyttäjä pyydä reititystä.
3. **Sijaintia ei viedä** datan viennissä ilman nimenomaista valintaa.
4. **Ei lokiin.** `logger.js` suodattaa jo nyt nimen perusteella; lisättävä
   `location`, `latitude`, `longitude`, `address`.
5. **Lupa vain käytön aikana.** Taustasijaintia ei pyydetä ennen kuin
   ominaisuus on todistetusti hyödyllinen ilman sitä.

---

## Akku ja taustarajoitukset

Android tappaa taustaprosessit aggressiivisesti, ja valmistajakohtaiset
virransäästöt vaihtelevat. Jatkuva sijaintiseuranta on sekä akkusyöppö
että epäluotettava.

**Vaihtoehto, joka ei vaadi taustaseurantaa:** laske lähtöaika kiinteästä
matka-arviosta ja ajasta ilmoitus normaalisti. Se toimii täsmälleen yhtä
luotettavasti kuin muutkin muistutukset — eli hyvin — eikä vaadi
sijaintilupaa lainkaan.

Tämä kattaa suurimman osan hyödystä murto-osalla riskistä.

---

## Luvat

| Lupa | Milloin | Mitä ilman sitä |
|---|---|---|
| Sijainti käytön aikana | Käyttäjä painaa "käytä sijaintia" | Kiinteä matka-arvio |
| Taustasijainti | **Ei pyydetä** tässä suunnitelmassa | — |
| Ilmoitukset | Jo olemassa | Ei muistutusta |

Lupaa ei koskaan pyydetä käynnistyksessä. Sama sääntö kuin ilmoituksilla.

---

## Toteutusjärjestys, jos tähän palataan

1. `EventLocation` tehtävälle ja rutiinille — pelkkä tekstikenttä
2. Kiinteä matka-arvio per sijainti
3. `DepartureDeadline` johdettuna, näkyviin päivänäkymään
4. `DEPARTURE_REMINDER` olemassa olevan ilmoitusputken kautta
5. **Vasta sitten** harkittava: onko oikeaa sijaintia ylipäätään tarpeen
   lukea?

Vaiheet 1–4 eivät vaadi sijaintilupaa lainkaan. Jos ne riittävät, vaihetta
5 ei tarvita — ja se on paras lopputulos.
