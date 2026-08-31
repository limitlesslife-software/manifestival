# Manifestival

> Suunnittele elämä, jota haluat elää.

Manifestival on henkilökohtainen elämänhallintasovellus, joka yhdistää päivä- ja
viikkosuunnittelun, tehtävät, rutiinit, unirytmin ja puheohjauksen yhdeksi
järjestelmäksi. Se ei ole kalenteri eikä tehtävälista, vaan pyrkii muuttamaan
tavoitteet käytännön tekemiseksi päivä kerrallaan.

Tuotevisio on kuvattu konseptidokumentissa "MANIFESTIVAL – KOKONAISKUVAUS"
(v1.0, 23.7.2026, 31 s.). Se ei ole tässä repossa. Toteutuksen suhde siihen on
kuvattu tiedostossa `docs/ROADMAP.md`.

---

## Nykyinen arkkitehtuuri lyhyesti

Sovellus on **PWA ilman käännösvaihetta**. Selain lataa tiedostot sellaisenaan.

```
Selain (PWA)
  index.html ................ käyttöliittymä, tila ja renderöinti
  src/lib/*.js .............. puhtaat, testattavat apumoduulit
        |
        |-- Supabase JS -----> Supabase (PostgreSQL + Auth)
        |                      taulut: tasks, profile
        |                      turva: RLS, auth.uid() = omistaja
        |
        `-- POST /api/parse -> Vercel serverless -> Anthropic API
                               (API-avain vain palvelimella)
```

Tarkempi kuvaus: `docs/ARCHITECTURE.md`.

| | |
|---|---|
| Frontend | Vanilla JS + CSS, ei frameworkia, ei bundleria |
| Moduulit | Natiivit ES-moduulit (`<script type="module">`) |
| Backend | Supabase (PostgreSQL, Auth) |
| AI | Anthropic Messages API palvelinpuolen proxyn kautta |
| Hosting | Vercel |
| Node | 24.x (vain testien ajoon, ei ajonaikainen riippuvuus) |

---

## Paikallinen ajo

Sovellus käyttää ES-moduuleita, joten **se pitää tarjoilla HTTP:n yli**.
Suoraan `file://`-osoitteesta avaaminen ei toimi (selain estää moduulien
lataamisen).

```bash
npm run serve      # http://localhost:3000
```

Palvelin on `scripts/serve.mjs` — pelkkää Node.js:ää, ei riippuvuuksia eikä
asennusta. Projektissa ei ole `node_modules`-hakemistoa eikä sitä tarvita.

Huomioita:

- `/api/parse` **ei toimi** pelkällä staattisella palvelimella. Puheohjauksen
  jäsennys vaatii Vercelin ajoympäristön (`vercel dev`) tai deployn.
  Ilman sitä puhekomento tallentuu raakatekstinä — sovellus on suunniteltu
  kestämään tämä.
- Sovellus vaatii kirjautumisen. Kirjautumaton käyttäjä ei näe mitään dataa.

---

## Testit

```bash
npm test        # Node.js -testiajuri: yksikkö- ja staattiset turvatestit
npm run check   # palvelinpuolen tiedostojen syntaksitarkistus
```

Testit kattavat:

- puhtaat päivämäärä- ja aikafunktiot (`src/lib/datetime.js`)
- käyttäjäscopingin apufunktiot (`src/lib/rows.js`)
- staattisen eheyden: kaksoiskappale-id:t, rikkinäiset `getElementById`- ja
  SVG-viittaukset
- turvallisuusinvariantit: ei salaisuuksia lähdekoodissa, ei rajaamattomia
  tietokantakutsuja, ei automaattista seed-kirjoitusta
- `/api/parse`-päätepisteen syötevalidoinnin

Testit eivät ota yhteyttä Supabaseen eivätkä Anthropicin API:in.

---

## Ympäristömuuttujat

Vain **nimet** — arvot eivät kuulu versionhallintaan. Ks. `.env.example`.

| Muuttuja | Missä | Selitys |
|---|---|---|
| `ANTHROPIC_API_KEY` | **Vain palvelin** (Vercel) | Puheohjauksen jäsennys. Ei koskaan selaimeen. |
| `SUPABASE_URL` | Julkinen | Supabase-projektin osoite. Nykyisin kovakoodattu `index.html`:ään. |
| `SUPABASE_ANON_KEY` | Julkinen | Supabasen anon-avain. Julkinen arvo; turva perustuu RLS:ään. |

---

## Repo- ja deploy-malli

- `main` on **tuotanto**. Sitä ei käytetä kehitykseen eikä siihen pushata suoraan.
- Kehitys tapahtuu feature-haaroissa ja etenee `develop`-haaran kautta.
- Vercel deployaa `main`-haarasta.

Katso `CONTRIBUTING.md` ja `docs/DEPLOYMENT.md`.

---

## Hakemistorakenne

```
index.html                     Sovellus (käyttöliittymä + logiikka)
manifest.json                  PWA-manifesti
icon-*.png                     Sovelluskuvakkeet
api/
  parse.js                     Vercel serverless: Anthropic-proxy
  _validate.js                 Syötevalidointi (alaviiva = ei julkinen reitti)
src/lib/
  datetime.js                  Puhtaat päivämäärä-/aikafunktiot
  rows.js                      Kanta-/sovellusrivien muunnos + scoping-suojat
  seed.js                      Esimerkkidata — EI kytketty sovellukseen
supabase/
  inventory.sql                Read-only skeeman inventointi
  migrations/                  Versionhallitut migraatiot
tests/                         Node.js -testit
docs/                          Arkkitehtuuri, skeema, turvallisuus, deploy, roadmap
```
