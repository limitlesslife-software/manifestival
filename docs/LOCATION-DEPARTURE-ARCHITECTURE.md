# Sijainti ja lähtöaika

Tila kolmiportaisesti. Mikään "laitteella todennettu" -merkintä puuttuu
tarkoituksella: sijaintia ja ilmoituksia ei ole ajettu fyysisellä laitteella.

| Osa | Tila |
|---|---|
| Kertaluonteinen etualan sijainti (`src/platform/geolocation.js`) | IMPLEMENTED_DEVICE_UNVERIFIED |
| Lupatilat, kyvykkyysrekisteri (`capabilities.js`) | COMPLETE_LOCAL (selain/mock), laite todentamatta |
| Tallennetut kohteet / paikkaehdotukset (`suggestPlaces`) | COMPLETE_LOCAL |
| Lähtöaikamoottori ja tilat (`travel.js`: `departureSchedule`, `departureState`) | COMPLETE_LOCAL |
| Lähtöilmoitukset (`notification.js` `DEPARTURE_REMINDER`, natiivi ajastus) | COMPLETE_LOCAL, laite todentamatta |
| Käyttäjän antama matka-aika (`manualEstimate`) | COMPLETE_LOCAL |
| Reititysrajapinta (`TRAVEL_PROVIDER_CONTRACT`, `normalizeRouteResult`) | ARCHITECTURE_ONLY |
| Oikea reititys-/liikennepalvelu | BLOCKED_EXTERNAL_DECISION (palveluntarjoajan valinta, hinta, tietosuoja-arvio) |
| Taustasijainti, geoaidat, jatkuva seuranta | EI TOTEUTETTU, EI TARKOITUKSELLA |

`hasTravelProvider()` palauttaa aina `false`. Sovellus ei koskaan keksi
matka-aikaa: lähtöaika lasketaan vain, kun matka-aika on käyttäjän antama tai
(myöhemmin) reittipalvelun oikeasti laskema ja tuore.

---

## Mitä tämä tekee

```
Hammaslääkäri klo 14:00, Hämeenkatu 12
Matka-aika (käyttäjän antama) 25 min + puskuri 10 min →  lähde klo 13:25
```

Tämä on aidosti arvokasta juuri niille, joille sovellus on tarkoitettu:
ihmisille, jotka myöhästyvät siksi ettei kukaan muistuttanut ajoissa.

---

## Sijainnin käyttö (etualan kertahaku)

- `getCurrentLocation()` hakee YHDEN sijainnin, kun käyttäjä pyytää jotain
  sijaintia tarvitsevaa. Ei `watchPosition`-kutsua, ei taustaa, ei geoaitoja.
- Lupaa ei pyydetä käynnistyksessä eikä itsestään: `allowPrompt: true` vain
  käyttäjän omasta eleestä.
- Lupatilat: `unsupported | not_requested | prompt | granted | denied | blocked |
  error`. `blocked` = vain järjestelmäasetukset auttavat (sovellus ohjaa sinne,
  ei kysy uudelleen). Käyttäjälle näytetään selitys jokaiselle tilalle
  (`describeLocationState`).
- Virheet: `unsupported`, `permission_required`, `permission_denied`,
  `position_unavailable`, `timeout` (10 s), `invalid_position`, `unknown`.
  Käyttöliittymä kertoo syyn eikä jää odottamaan.
- Kaksi samanaikaista pyyntöä jakaa yhden laitekutsun.
- Oletus: aina tuore haku (`maxAgeMs = 0`). Muistivälimuisti korkeintaan 5 min
  (`MAX_CACHE_MS`) vaikka kutsuja hyväksyisi vanhempaa; `clearLocationCache()`
  tyhjentää sen.

## Tietosuojainvariantit (testattu: `tests/geolocation.test.mjs`, `tests/observability.test.mjs`, `tests/data-export-ui.test.mjs`)

1. **Koordinaatit ovat transientteja**: vain muistissa; ei localStorageen,
   IndexedDB:hen, kantaan, tilin inventaarioon, vientiin tai tekoälylle.
2. Palautettu positio kantaa koordinaatit ei-enumeroitavina ominaisuuksina;
   `toJSON` jättää ne pois — `JSON.stringify`, spread ja `console.log` eivät
   vuoda niitä.
3. **Ei sijaintihistoriaa.** Vain viimeisin sijainti, vain muistissa.
4. **Ei lokiin**: `latitude`, `longitude`, `lat`, `lng`, `lon`, `coords`,
   `coordinates`, `position`, `geolocation` ovat `logger.js`:n SENSITIVE_KEYS-listalla ja
   `dataExport.js`:n REDACTED_FIELDS-listalla; `logEvent` ottaa vastaan vain
   koodit ja tunnisteet.
5. Tapahtuman sijainti on käyttäjän kirjoittama teksti, ei automaattinen
   geokoodaus. Osoite ei lähde mihinkään ellei käyttäjä pyydä reititystä
   (jota ei vielä ole).
6. **Ei taustasijaintia**: Android-manifestiin ei lisätä `ACCESS_BACKGROUND_LOCATION`;
   staattiset testit (`tests/geolocation.test.mjs`, `tests/android.test.mjs`) vartioivat sitä. `@capacitor/geolocation`
   ei julista lupia itse, joten oma manifesti julistaa vain
   `ACCESS_COARSE_LOCATION` ja `ACCESS_FINE_LOCATION` (etualan kertahaku) sekä
   `location.gps` `required="false"`. Ilman näitä natiivihaku ei voisi koskaan
   onnistua; APK:n `aapt2 dump badging` vahvistaa (ei taustasijaintia).

---

## Lähtöaikamoottori (`src/domain/travel.js`)

`DepartureDeadline` on **johdettu** tieto, ei tallennettu kenttä.

- `departureSchedule(plan)`: alkuaika − matka-aika − puskurit. Erottaa
  **ovelta lähdön ajan** (`leaveAt`) ja **valmistautumisen aloitusajan**
  (`prepareAt`) — kaksi eri hetkeä, joita ei sekoiteta.
- `departureState(plan, {todayIso, nowMinutes})`: `unknown` (ei kestoa) →
  `not_yet` → `prepare` → `leave_soon` (15 min) → `leave_now` (2 min
  toleranssi) → `late`.
- Keston puuttuessa ei lähtöaikaa: `known: false`, ei oletusta.
- Yön yli / vuorokauden vaihde ja kesäaika: hetket lasketaan päiväpohjaisesti;
  testattu rajatapaukset (`tests/departure-engine.test.mjs`).
- Toistuvat / usean paikan päivä: jokaiselle suunnitelmalle oma laskenta.

### Ilmoitukset

- `NOTIFICATION_TYPE.DEPARTURE_REMINDER` lähtee `DEPARTURE_ALERT_LEAD_MINUTES`
  (10 min) ennen lähtöaikaa olemassa olevan ilmoitusputken kautta.
- Natiivi: `nativeNotifications.js` ajastaa lähtöilmoituksen
  `allowWhileIdle`-tilassa (Doze). `PLANNED_TYPES` on nyt tyhjä: kaikki
  ilmoitustyypit on toteutettu. Puuttuva matka-aika ei tuota ilmoitusta
  lainkaan (`known:false`).
- **Omistajan päätös**: lähtöhälytys ohittaa hiljaiset tunnit
  (`applyLimits`, `notification.js`), koska hiljaa pudonnut aamuvarhaisen
  lähtöilmoitus on pahempi kuin häiriö. Muutos on yksi ehto.
- Lähtöaika muuttuu (matka-aika muokattu, tehtävä siirretty): ilmoitukset
  suunnitellaan `syncNotifications`-ajolla uudelleen (3 päivän horisontti);
  laitteella todentamatta.

## Matka-ajan lähteet

| Lähde | Tila |
|---|---|
| **Käyttäjän antama kesto** (`manualEstimate`, `TRAVEL_SOURCE.MANUAL`) | Käytössä. Ei tietovuotoa, toimii offline, ei riippuvuuksia. |
| Reititysrajapinta (`TRAVEL_PROVIDER_CONTRACT`) | Sopimus + tiukka normalisointi valmiina (`normalizeRouteResult`), ei toteutusta. |
| Ulkoinen reitityspalvelu | **BLOCKED_EXTERNAL_DECISION.** Kutsu paljastaa palveluntarjoajalle missä käyttäjä on ja minne menossa; vaatii oman tietosuoja-arvion ja maksullisen palvelun valinnan. |

Reititystulos hyväksytään vain kun `status: OK`, kesto on positiivinen ja
rajoitettu (`MAX_TRAVEL_MINUTES`), `calculatedAt`/`freshUntil` ovat kelvollisia
eikä tulos ole vanhentunut. Muuten tulos on `UNKNOWN`/`ERROR` eikä lähtöaikaa
näytetä. Nollaa, oletuskestoa tai arvausta ei koskaan käytetä (testattu
`tests/departure-engine.test.mjs` + `tests/helpers/routeProvider.mjs`).

## Tallennetut kohteet

`suggestPlaces(travelPlans, locationRules)` ehdottaa aiemmin käytettyjä
paikkoja (nimi, käyttäjän kirjoittama) `datalist`-ehdotuksina. Kohteet ovat
käyttäjän tekstiä; koordinaatteja ei tallenneta.

## Luvat

| Lupa | Milloin | Mitä ilman sitä |
|---|---|---|
| Sijainti käytön aikana | Käyttäjä painaa "käytä sijaintia" | Käyttäjän antama matka-arvio |
| Taustasijainti | **Ei pyydetä, ei toteutettu** | — |
| Ilmoitukset | Käyttäjän eleestä (olemassa oleva sääntö) | Ei lähtöilmoitusta |

Lupaa ei koskaan pyydetä käynnistyksessä.

---

## Mikä on todentamatta (laitehyväksyntä)

Ks. `docs/DEVICE-ACCEPTANCE-BACKLOG.md`, osio "MEGA BUILD III". Tiivistetysti:
lupadialogi ja "estetty pysyvästi" -polku oikealla Androidilla, sijainti pois
päältä laitteesta, kertahaku ilman koordinaattihistoriaa, lähtöilmoituksen
saapuminen ajallaan (Doze, sovellus tapettu, uudelleenkäynnistys, kesäaika,
aikavyöhykkeen vaihto) sekä ilmoituksen uudelleenajastus lähtöajan muuttuessa.

## Jos reititys joskus toteutetaan

1. Valitse palveluntarjoaja (omistajan päätös: hinta, sijainti, tietosuoja).
2. Toteuta `estimate`-sopimus palvelinpuolella (avain vain palvelimella,
   ei koskaan selaimessa); vain reittipalvelun tarvitsema origin/destination
   lähtee, ei tallenneta.
3. Kytke tulos `withRouteResult`-funktion kautta — normalisointi hylkää
   virheelliset vastaukset.
4. Lisää oma tietosuojaseloste ja suostumus ennen ensimmäistä kutsua.
5. Käännä `hasTravelProvider()` vasta kun 1–4 on tehty ja testattu.
