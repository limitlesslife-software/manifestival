# Arkkitehtuuri

Tila: WP1:n jälkeen. Päivitetty 31.8.2026.

---

## Yleiskuva

```
┌─────────────────────────────────────────────────────────┐
│ Selain (PWA, max 480 px leveä sovellusnäkymä)           │
│                                                          │
│  index.html                                              │
│    ├─ CSS-muuttujat ja komponenttityylit                │
│    ├─ HTML: 4 näkymää + kirjautumisportti + puhepaneeli  │
│    └─ <script type="module">                             │
│         ├─ tila (state, authUser)                        │
│         ├─ datakerros (Supabase-kutsut)                  │
│         ├─ aikataululogiikka (auto herätys/uni)          │
│         ├─ renderöinti (innerHTML-koosteet)              │
│         └─ autentikointivirta                            │
│                                                          │
│  src/lib/datetime.js   puhtaat aika-/päivämääräfunktiot  │
│  src/lib/rows.js       rivimuunnos + scoping-suojat      │
│  src/lib/seed.js       esimerkkidata (EI kytketty)       │
└───────────┬───────────────────────────┬─────────────────┘
            │                           │
   supabase-js v2 (CDN)          fetch POST /api/parse
            │                           │
            v                           v
┌───────────────────────┐   ┌───────────────────────────────┐
│ Supabase              │   │ Vercel serverless             │
│  Auth (sähköposti)    │   │  api/parse.js                 │
│  PostgreSQL           │   │   + api/_validate.js          │
│   tasks, profile      │   │                               │
│  RLS: auth.uid()      │   │  ANTHROPIC_API_KEY (env)      │
└───────────────────────┘   └──────────────┬────────────────┘
                                           │
                                           v
                              ┌────────────────────────────┐
                              │ Anthropic Messages API     │
                              │ claude-haiku-4-5-20251001  │
                              └────────────────────────────┘
```

---

## Miksi ei frameworkia

Sovellus on tarkoituksella ilman frameworkia, bundleria ja käännösvaihetta:
selain lataa tiedostot sellaisenaan ja Vercel tarjoilee ne staattisesti.
Tämä pitää deployn yksinkertaisena ja poistaa kokonaisen luokan ongelmia
(build-konfiguraatio, riippuvuuspäivitykset, lähdekarttat).

Vaihtoehto arvioitiin WP1:n yhteydessä. Framework-migraatio ei ratkaisisi
yhtäkään todetuista ongelmista (autentikaatio, RLS, ilmoitukset, testit),
joten se lykättiin. Päätös arvioidaan uudelleen, jos näkymien määrä kasvaa
selvästi tai komponenttien uudelleenkäytölle syntyy todellinen tarve.

---

## Moduulirakenne

`index.html` on yhä monoliitti (noin 1 150 riviä), mutta puhtaat apufunktiot on
irrotettu ES-moduuleiksi, jotta ne voidaan testata ilman selainta.

| Moduuli | Sisältö | Miksi irrotettu |
|---|---|---|
| `src/lib/datetime.js` | `fmtISO`, `parseISO`, `addDays`, `startOfWeek`, `sameDay`, `todayMidnight`, `sortByTime`, `loadClass`, `subtractMinutes`, `addMinutes` | Ohjaavat automaattista herätys- ja unilaskentaa. Sisältävät keskiyön ylityksen, jota ei voinut testata monoliitissa. |
| `src/lib/rows.js` | `toRow`, `fromRow`, `assertClientSafe`, `newTaskId` | Turvallisuuskriittinen: estää `user_id`:n lähettämisen clientilta. |
| `src/lib/seed.js` | `seedTasks` | Siirretty pois tuotantopolusta. Ei importoida mistään. |

`src/lib/package.json` sisältää `{"type":"module"}`, jotta Node kohtelee näitä
ES-moduuleina. Se ei vaikuta `api/`-hakemistoon, joka pysyy CommonJS-muodossa
Vercelin serverless-funktioita varten.

**Huom:** ES-moduulien takia sovellusta ei voi enää avata suoraan
`file://`-osoitteesta. Käytä `npm run serve`.

---

## Sovelluksen tila

Yksi globaali olio ja erillinen kirjautumistila:

```js
state = {
  tasks: [],          // kirjautuneen käyttäjän tehtävät
  viewDate: Date,     // Tänään-näkymän päivä
  weekStart: Date,    // Viikko-näkymän maanantai
  profile: {...},     // ikä, paino, pituus, unitavoite, matka-ajat
  editingId: null     // muokattavan tehtävän id
}

authUser = null | { id, email, ... }   // Supabase-käyttäjä
```

`requireUserId()` heittää poikkeuksen, jos kutsu tapahtuu ilman kirjautumista.
Jokainen tietokantakutsu käyttää sitä, jolloin rajaamaton kysely ei ole
mahdollinen vahingossa.

---

## Näkymät ja navigaatio

| Näkymä | Elementti | Sisältö |
|---|---|---|
| Kirjautuminen | `#authGate` | Kirjaudu / Luo tili, virhe- ja latausTilat |
| Tänään | `#screen-today` | Aikajana SVG-polulla, NYT/MYÖHÄSSÄ/ETUAJASSA, kuormitus- ja valmiuschipit |
| Viikko | `#screen-week` | Viikkonauha kuormituspisteillä + ryhmitelty lista |
| Tehtävät | `#screen-tasks` | Kaikki tehtävät, lisäys- ja muokkauslomake |
| Profiili | `#screen-profile` | Henkilötiedot, aikatauluparametrit, uloskirjautuminen |

Navigointi on alapalkin välilehdillä (`switchTab`). Näkymät ovat päällekkäisiä
absoluuttisesti sijoitettuja elementtejä, joista aktiivisella on `.active`.

---

## Automaattinen aikataululogiikka

Merkittävä osa arvosta syntyy laskennasta, jota **ei tallenneta kantaan**.
`getDisplayItemsForDate()` yhdistää oikeat tehtävät ja lasketut ehdotukset:

- **Herätys** — jos päivälle ei ole merkitty herätystä (`is_wake`), se lasketaan
  aikaisimmasta `tyo`-kategorian tehtävästä vähentämällä työmatka ja aamutoimet.
- **Aamutoimet** — herätyksestä eteenpäin profiilin `routineMinutes`, ellei
  käyttäjällä ole omaa merkintää samalla aikavälillä.
- **Uni** — huomisen herätysajasta vähennetään unitavoite.

Nämä renderöidään AUTO-merkintöinä katkoviivalla. Ne eivät ole kuitattavissa
eivätkä ne vaikuta kuormituslaskentaan. Ne on myös suljettu pois
"myöhässä"-päättelystä — muuten ensimmäinen niistä jäisi pysyvästi
myöhässä-tilaan koko päiväksi.

---

## Autentikointi

Supabasen oma sähköposti-/salasanakirjautuminen. Sovellus ei käsittele
salasanoja itse eikä tallenna niitä.

```
sivun lataus
  └─ authSplash näkyy
  └─ sb.auth.getSession()
       ├─ istunto löytyi  -> enterApp(user)  -> loadUserData()
       └─ ei istuntoa     -> showAuthGate()

sb.auth.onAuthStateChange
  ├─ kirjautuminen  -> enterApp(user)
  └─ uloskirjautuminen -> leaveApp()  (tyhjentää tilan muistista)
```

---

## Suunniteltu modularisointi (WP3)

WP1 irrotti vain testattavuuden ja turvallisuuden kannalta välttämättömän.
Varsinainen jako on oma työpakettinsa:

```
src/
  state.js          sovelluksen tila ja sen muutokset
  db.js             kaikki Supabase-kutsut yhdessä paikassa
  auth.js           kirjautumisvirta
  schedule.js       automaattinen herätys-/uni-/rutiinilaskenta
  render/
    today.js  week.js  tasks.js  profile.js
  voice.js          puheohjaus ja jäsennys
  ui/toast.js       keskitetty virheilmoitus
```

Ehto: modularisointi tehdään vasta kun testipohja kattaa siirrettävän
logiikan, jotta regressio havaitaan.
