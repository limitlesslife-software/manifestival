# Manifestival

> Suunnittele elämä, jota haluat elää.

Manifestival on henkilökohtainen elämänhallintasovellus, joka yhdistää päivä- ja
viikkosuunnittelun, tehtävät, unirytmin ja puheohjauksen yhdeksi järjestelmäksi.
Se ei ole kalenteri eikä tehtävälista: se laskee milloin päiväsi alkaa ja
päättyy, ja auttaa mahduttamaan tärkeät asiat siihen väliin.

Tuotevisio on konseptidokumentissa "MANIFESTIVAL – KOKONAISKUVAUS"
(v1.0, 23.7.2026). Se ei ole tässä repossa; toteutuksen suhde siihen on
kuvattu tiedostossa `docs/ROADMAP.md`.

---

## Arkkitehtuuri lyhyesti

**PWA ilman käännösvaihetta.** Selain lataa moduulit sellaisenaan ja Vercel
tarjoilee ne staattisesti. Ei bundleria, ei transpilointia, ei build-vaihetta
web-tuotannossa.

```
Selain (PWA)  ·  Android (Capacitor-kuori, sama koodi)
  index.html ................ runko, ikonit, entrypoint
  src/app/ ................. näkymät, tila, elinkaari
  src/ui/ .................. DOM-apuvälineet, ilmoitukset, dialogit
  src/domain/ .............. puhdas liiketoimintalogiikka
  src/data/ ................ Supabase, istunto, skeemaportti
  src/ai/ .................. AI-ehdotuksen validointi
  src/platform/ ............ alustaerot (web / natiivi)
  sw.js .................... offline-sovelluskuori
        │                            │
        │ supabase-js                │ POST /api/parse
        v                            v
  Supabase                    Vercel serverless
   Auth + PostgreSQL           api/parse.js
   RLS: auth.uid()             ANTHROPIC_API_KEY (vain palvelimella)
                                      │
                                      v
                               Anthropic Messages API
```

Riippuvuudet osoittavat aina alaspäin: `app → ui/ai/data/domain/lib`,
`domain → lib`, `lib → ei mitään`. Tämä on **testattu invariantti**, ei
pelkkä sopimus. Ks. `docs/MODULARIZATION.md` ja `docs/ARCHITECTURE.md`.

| | |
|---|---|
| Frontend | Vanilla JS + CSS, natiivit ES-moduulit |
| Backend | Supabase (PostgreSQL, Auth) |
| AI | Anthropic Messages API palvelinpuolen proxyn kautta |
| Hosting | Vercel |
| Android | Capacitor 8 (sama koodi, ei toista koodikantaa) |
| Node | 24.x (vain testeihin ja koontiin, ei ajonaikainen riippuvuus) |

---

## Paikallinen ajo

Sovellus käyttää ES-moduuleita, joten **se pitää tarjoilla HTTP:n yli**.
`file://`-osoitteesta avaaminen ei toimi.

```bash
npm run serve      # http://localhost:3000
```

Palvelin on `scripts/serve.mjs` — pelkkää Node.js:ää, ei riippuvuuksia.

Huomioita:

- Sovellus vaatii kirjautumisen. Kirjautumaton ei näe mitään dataa.
- `/api/parse` **ei toimi** staattisella palvelimella; se on Vercelin
  serverless-funktio. Puheohjaus tallentaa komennon raakatekstinä ilman
  jäsennystä — sovellus on suunniteltu kestämään tämä.
- Tietokantayhteys menee **tuotanto-Supabaseen**. Älä luo testidataa siellä.

---

## Komennot

| Komento | Mitä tekee |
|---|---|
| `npm test` | 778 testiä (yksikkö-, arkkitehtuuri-, turva- ja invarianttitestit) |
| `npm run check` | Palvelinpuolen syntaksitarkistus |
| `npm run smoke` | Koko moduuligraafi HTTP:n yli, 74 tarkistusta |
| `npm run serve` | Kehityspalvelin |
| `npm run build:web` | Kokoaa `dist/` — **vain Androidia varten** |
| `npm run sync:android` | `dist/` → Android-projektin assetit |
| `npm run build:android` | Koko ketju + Gradle → APK |

Testit eivät ota verkkoyhteyttä eivätkä koske tietokantaan.
Ks. `docs/TESTING.md`.

---

## Ympäristömuuttujat

Vain **nimet** — arvot eivät kuulu versionhallintaan. Ks. `.env.example`.

| Muuttuja | Missä | Selitys |
|---|---|---|
| `ANTHROPIC_API_KEY` | **Vain palvelin** (Vercel) | Puheohjauksen jäsennys. Ei koskaan selaimeen. |
| `PARSE_REQUIRE_AUTH` | Palvelin, valinnainen | `false` poistaa `/api/parse`-todennuksen. Hätävara. |
| `SUPABASE_URL` | Julkinen | Kovakoodattu `src/data/config.js`:ään |
| `SUPABASE_ANON_KEY` | Julkinen | Julkinen arvo; turva perustuu RLS:ään |

---

## Repo- ja julkaisumalli

- `main` on **tuotanto**. Sitä ei käytetä kehitykseen eikä siihen pushata suoraan.
- Kehitys tapahtuu feature-haaroissa ja etenee `develop`-haaran kautta.
- Vercel julkaisee `main`-haarasta.

Ks. `CONTRIBUTING.md` ja `docs/DEPLOYMENT.md`.

---

## Hakemistorakenne

```
index.html                     Runko: merkintä, ikonit, entrypoint
sw.js                          Service worker (offline-sovelluskuori)
manifest.json                  PWA-manifesti
capacitor.config.json          Android-kuoren konfiguraatio

src/
  styles.css                   Kaikki tyylit
  app/                         Näkymät, tila, elinkaari
    main.js                      bootstrap
    state.js  actions.js         tila ja sen muutokset
    auth.js  navigation.js       kirjautuminen ja navigointi
    voice.js  onboarding.js      puheohjaus ja ensikäyttö
    views/                       today, week, tasks, profile
  ui/                          dom, toast, confirm
  domain/                      task, scheduler, week, categories, priority
  data/                        client, session, tasksRepo, profileRepo,
                               schema (migraatioportti), preferences
  ai/                          proposalSchema, parseClient
  platform/                    alustasovittimet (web / natiivi)
  lib/                         datetime, format, rows, result, seed

api/
  parse.js                     Vercel serverless: Anthropic-proxy
  _auth.js                     Kutsujan todennus
  _ratelimit.js                Pyyntörajoitin
  _validate.js                 Syötevalidointi

android/                       Capacitorin kuori. Ei sovelluslogiikkaa.
supabase/                      inventory.sql + versionhallitut migraatiot
scripts/                       serve, smoke, build-web
tests/                         778 testiä
docs/                          Arkkitehtuuri, skeema, turvallisuus, deploy,
                               roadmap, modularisointi, Android, testaus,
                               domain-malli, rutiinit, tavoitteet,
                               muistutukset, puhekomennot, sijoitukset,
                               tuotannon käyttöönotto
```

---

## Tila

| Alue | Tila |
|---|---|
| Päivä- ja viikkosuunnittelu | Toimii |
| Tehtävät (luonti, muokkaus, poisto, valmistuminen) | Toimii |
| Prioriteetti, kesto, kuvaus | Toimii — **ei vielä tallennu**, ks. migraatio 0002 |
| Automaattinen herätys- ja unilaskenta | Toimii |
| Aikatauluehdotukset | Toimii |
| Puheohjaus ja AI-jäsennys | Toimii |
| Kirjautuminen ja käyttäjäkohtainen data | Toteutettu — **vaatii migraation 0001** |
| Offline-sovelluskuori | Toimii |
| Rutiinit (toistosäännöt, poikkeukset) | Toimii — **ei vielä tallennu**, migraatio 0003 |
| Tavoitteet ja edistyminen | Toimii — **ei vielä tallennu**, migraatio 0004 |
| Määräajat ja myöhässä olevat | Toimii — **ei vielä tallennu**, migraatio 0004 |
| Päivän fokus, illan katsaus, viikkokatsaus | Toimii (johdettu, ei omaa tallennusta) |
| Hyvinvointimerkinnät | Toimii — **ei vielä tallennu**, migraatio 0006 |
| Muistutusten suunnittelu | Toimii — **ei vielä tallennu**, migraatio 0005 |
| Muistutusten ajastus | Toimii Android-sovelluksessa; selaimessa vain etualalla |
| Android-APK | Debug ja allekirjoittamaton release rakennettu, ei testattu laitteella |
| Projektit | Domain valmis, **ei näkymää** |
| Laskut ja toistuvat kulut | Domain valmis, **ei näkymää eikä tallennusta** |
| Sijainti ja taustatoiminta | Ei toteutettu — ks. `docs/ROADMAP.md` |
| Sijoitusseuranta | Vain arkkitehtuuri — `docs/INVESTMENTS-ARCHITECTURE.md` |

**Kuusi migraatiota odottaa ajoa tuotantoon.** Ne ovat luonnoksia eikä niitä
ole ajettu mihinkään ympäristöön. Ks. `supabase/README.md`.
