# Muistutukset

**Ilmoitus, jota käyttäjä ei odota, on häiriö. Häiriö poistaa sovelluksen.**

Toteutus: `src/domain/notification.js` (suunnittelu),
`src/platform/notifications.js` (näyttäminen)
Testit: `tests/domain-notification.test.mjs`, `tests/invariants.test.mjs`
Skeema: `supabase/migrations/0005_notification_preferences.sql`

> **Asetukset eivat viela saily.** Migraatiota 0005 ei ole ajettu, ja
> skeemaportti `notificationPreferences` on `false`. Muistutusasetukset
> elavat istunnon muistissa ja palautuvat oletukseen sivun latauksessa.
> Kayttoliittyma kertoo taman kayttajalle.
> Ks. [`PRODUCTION-ACTIVATION-GATE.md`](PRODUCTION-ACTIVATION-GATE.md).

---

## Toteutuksen tila — rehellisesti

| Osa | Tila |
|---|---|
| Suunnittelumoottori (mitä, milloin, millä tasolla) | **IMPLEMENTED** — puhdas, testattu |
| Asetusten normalisointi ja rajat | **IMPLEMENTED** |
| Lupakysely | **IMPLEMENTED** — ei koskaan automaattinen |
| Heti näytettävä ilmoitus | **IMPLEMENTED** (selain, kun lupa on) |
| **Ajastettu ilmoitus** | **PLANNED** — `schedule()` palauttaa `{ ok: false, planned: true }` |
| Asetusten tallennus tilille | REQUIRES MIGRATION 0005 |
| Lähtömuistutus sijainnin perusteella | PLANNED |

Ajastettu ilmoitus on tässä vaiheessa **suunniteltu mutta ei toteutettu**.
Selaimen Notification API ei osaa ajastaa, ja service workerin
Notification Trigger -rajapinta ei ole yleisesti saatavilla. Toteutus vaatii
natiivikerroksen (Capacitor Local Notifications). Rajapinta palauttaa
tarkoituksella epäonnistumisen eikä teeskentele onnistuneensa.

---

## Miksi suunnittelu on domainissa

Ilmoituslogiikka on tuotteen kannalta yhtä tärkeä kuin aikataulutus.
Jos se olisi natiivikutsujen seassa, siitä ei voisi keskustella eikä sitä
voisi testata: "lähetettiinkö tämä ilmoitus liian aikaisin" olisi kysymys,
johon vastaisi vain oikea puhelin ja kello.

Siksi `planNotifications()` on puhdas funktio. Se ei lähetä mitään — se
palauttaa **aikomukset**, jotka alustakerros voi toteuttaa. Sama syöte
tuottaa aina saman tuloksen.

---

## Nelitasoinen eskalaatio

| Taso | Nimi | Merkitys | Kanava |
|---|---|---|---|
| 1 | Tieto | Ei vaadi toimia | hiljainen |
| 2 | Muistutus | Kannattaa tehdä pian | ilmoitus |
| 3 | Toiminta nyt | Aikataulu edellyttää toimintaa | ääni |
| 4 | Kriittinen | Myöhästymisen riski korkea | hälytys |

**Kanavaa ei säädetä erikseen.** Taso määrää kanavan. Jos käyttäjä saisi
nostaa jokaisen ilmoituksen hälytystasolle, kaikesta tulisi kriittistä ja
eskalaatio menettäisi merkityksensä.

Taso johdetaan tilanteesta, ei tallenneta:

- `escalationForTask()` — korkea prioriteetti ja lähestyvä alkuaika nostavat
- `escalationForDeadline()` — myöhässä oleva määräaika nostaa kriittiseksi

---

## Ilmoitustyypit

| Tyyppi | Milloin | Oletustaso |
|---|---|---|
| `daily_plan` | Aamulla, klo 07:30 | Tieto |
| `task_reminder` | 10 min ennen ajastettua tehtävää | Tilanteen mukaan |
| `routine_reminder` | 5 min ennen kiinteää rutiinia | Muistutus |
| `deadline_warning` | Aamulla, kun määräaika lähestyy | Tilanteen mukaan |
| `evening_review` | Illalla, klo 21:00 | Tieto |
| `departure_reminder` | — | **PLANNED**, vaatii sijainnin |

Valmiista tehtävästä ei muistuteta koskaan. Se on lukittu testillä.

---

## Kaksi suojaa hälyä vastaan

### 1. Rauhoitusaika

Oletus 22:00–06:30. Väli saa ylittää keskiyön — `isQuietTime()` käsittelee
sen erikseen, koska naiivi vertailu `from <= time && time <= to` olisi
väärässä juuri siinä tapauksessa, joka on oletus.

Rauhoitusajan läpäisevät **vain kriittiset** ilmoitukset. Jos jokin on
todella myöhässä, hiljaisuus olisi karhunpalvelus. Kaikki muu odottaa
aamuun.

### 2. Päiväkatto

Oletus 12 ilmoitusta vuorokaudessa, enintään 50. Kun katto tulee vastaan,
karsinta säilyttää tärkeimmät — ei ensimmäisiä.

Molemmat rajat on lukittu ominaisuustesteillä, jotka generoivat syötteen
itse: `tests/invariants.test.mjs` ajaa satoja satunnaisia päiviä ja
tarkistaa, ettei kumpikaan raja koskaan petä.

---

## Oletus on hiljaisuus

```js
DEFAULT_PREFERENCES.enabled === false
```

Ennen kuin käyttäjä kytkee muistutukset päälle, `planNotifications()`
palauttaa tyhjän listan. Ei yhtään aikomusta, ei yhtään lupakyselyä.

Sama oletus on tietokannassa: `enabled boolean not null default false`.
Molemmat on lukittu testillä, joka vertaa niitä toisiinsa.

**Lupaa ei kysytä automaattisesti.** `requestPermission()` kutsutaan vain
käyttäjän omasta toimesta. Sivun latauksen yhteydessä ilmestyvä lupakysely on
paras tapa saada kieltävä vastaus pysyvästi.

---

## Tunnisteet ovat johdettuja

```
intentId(type, targetId, dateIso)
```

Sama ilmoitus saa aina saman tunnisteen. Siksi:

- suunnitelman voi laskea uudelleen ilman että ilmoitukset kahdentuvat
- `applyLimits()` poistaa duplikaatit tunnisteen perusteella
- kuittaus ei vaadi erillistä tallennusta

---

## Mitä palvelimella ei tehdä

Palvelinpuolella **ei ole** ilmoitusjonoa, lähetyshistoriaa eikä push-
palvelua. Migraatio 0005 luo vain asetustaulun.

Perustelu: push-ilmoitus vaatisi VAPID-avaimet, tilaustaulun, taustatyön ja
oman tietoturva-arviointinsa. Se on oma pakettinsa. Ennen sitä paikallinen
ajastus natiivikerroksessa kattaa käyttötapaukset ilman että käyttäjän
päivärytmi kulkee palvelimen kautta.

---

## Rajoitukset

- Ei ajastettuja ilmoituksia (vaatii natiivikerroksen)
- Ei push-ilmoituksia
- Ei toistuvaa muistutusta ("muistuta uudelleen 10 min päästä")
- Ei ilmoitusten ryhmittelyä yhdeksi yhteenvedoksi
- Ei lähtömuistutusta matka-ajan perusteella
