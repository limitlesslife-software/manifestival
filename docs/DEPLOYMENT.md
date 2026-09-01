# Julkaisu ja ympäristöt

---

## Nykyinen malli

```
paikallinen klooni
   └─ feature/wp-N-...
        └─ develop
             └─ main  ──────>  Vercel  ──────>  https://manifestival-ten.vercel.app
```

Vercel on kytketty GitHub-repoon ja deployaa `main`-haarasta. Repon
`homepageUrl` osoittaa tuotantodomainiin.

> **Todentamaton:** Vercel-projektin asetuksia ei ole tarkistettu. Alla oleva
> perustuu repon rakenteeseen ja Vercelin nollakonfiguraation konventioihin.
> Tarkista kohdan "Vercel-asetusten tarkistus" asiat dashboardista.

---

## Miksi deploy toimii ilman konfiguraatiota

Repo noudattaa Vercelin oletuskonventiota:

- Juuren `index.html` ja staattiset tiedostot tarjoillaan sellaisenaan
- `api/`-hakemiston `.js`-tiedostot muuttuvat automaattisesti
  serverless-funktioiksi: `api/parse.js` -> `POST /api/parse`
- Alaviivalla alkavat tiedostot (`api/_validate.js`) **eivät** muutu reiteiksi
- `package.json` ei määrittele build-komentoa, joten käännösvaihetta ei ole

`vercel.json`-tiedostoa ei tarvita eikä sellaista ole.

WP1 lisäsi hakemistot `src/lib/`, `tests/`, `docs/` ja `supabase/`. Ne
tarjoillaan staattisesti — `src/lib/*.js` on tarkoituskin ladata selaimeen.
`tests/`, `docs/` ja `supabase/` ovat julkisia mutta harmittomia: ne eivät
sisällä salaisuuksia.

---

## Ympäristömuuttujat Vercelissä

| Muuttuja | Ympäristö | Pakollinen |
|---|---|---|
| `ANTHROPIC_API_KEY` | Production (+ Preview jos puheohjausta testataan) | Kyllä, muuten `/api/parse` palauttaa 500 |
| `PARSE_REQUIRE_AUTH` | Valinnainen | Ei. Vain hätävara — ks. alla |

Asetetaan: Vercel -> projekti -> **Settings** -> **Environment Variables**.

Ilman Anthropic-avainta sovellus toimii muuten normaalisti; puheohjaus
tallentaa komennon raakatekstinä eikä jäsennä sitä.

### PARSE_REQUIRE_AUTH — tärkeä julkaisujärjestys

`/api/parse` vaatii oletuksena kirjautuneen käyttäjän. **Uusi selainkoodi
lähettää tokenin, vanha ei.**

Tämä tarkoittaa, että `api/` ja selainkoodi pitää julkaista **yhdessä**. Jos
vain `api/` päivittyisi, tuotannossa oleva vanha selain lakkaisi jäsentämästä
puhetta. Koska molemmat ovat samassa repossa ja samassa deployssa, tämä
tapahtuu automaattisesti — mutta jos jokin menee pieleen, hätävara on asettaa
`PARSE_REQUIRE_AUTH=false` ja korjata tilanne rauhassa.

Mikä tahansa muu arvo kuin `false` pitää todennuksen päällä. Tämä on
tarkoituksellinen: kirjoitusvirhe ei saa avata päätepistettä.

---

## Service workerin versiointi

`sw.js` sisältää vakion:

```js
const CACHE_VERSION = 'v7';
```

**Nosta versiota aina kun sovelluskuori muuttuu** (uusi moduuli, muuttunut
`index.html`, uusi tyylitiedosto). Vanhat välimuistit siivotaan
aktivointivaiheessa, joten nosto on turvallinen tapa pakottaa päivitys.

Service worker ei käytä `skipWaiting`-kutsua: uusi versio otetaan käyttöön
vasta kun kaikki välilehdet on suljettu. Näin JS-moduulit eivät vaihdu kesken
istunnon.

Testi `sovelluskuoren välimuistilista vastaa oikeasti ladattavia moduuleja`
kaatuu, jos uusi moduuli unohtuu listalta.

---

## Preview-deployt

Vercel voi luoda preview-deployn jokaisesta haarasta. Tämä on hyödyllistä
WP1:n testaamiseen ilman tuotantoon koskemista.

**Huomio ennen käyttöönottoa:** preview-deploy käyttää samaa Supabase-projektia
kuin tuotanto, ellei erillistä kehitysprojektia luoda. Preview kirjoittaisi siis
tuotantotietokantaan. Suositus:

1. Luo erillinen Supabase-kehitysprojekti, **tai**
2. Aja migraatio 0001 ensin tuotantoon, jolloin RLS eristää testitilin datan
   omaksi joukokseen

Preview-deployta ei ole otettu käyttöön WP1:ssä.

---

## Julkaisujärjestys WP1:n muutoksille

Koodi ja tietokanta ovat toisistaan riippuvaisia. Väärä järjestys rikkoo
tuotannon.

```
1. Aja supabase/inventory.sql                    (vain luku)
2. Sovita migraatio 0001 todelliseen skeemaan
3. Ota Supabase-varmuuskopio
4. Aseta uusi ANTHROPIC_API_KEY Verceliin        (ks. avaimen kierto)
5. Luo itsellesi tili -> hae auth.users-tunniste
6. Aja migraatio 0001                            (lyhyt katko alkaa)
7. Merge develop -> main                         (tuotanto päivittyy)
8. Todenna: kirjautuminen, oma data, uloskirjautuminen
9. Mitätöi vanha ANTHROPIC_API_KEY               (katko päättyy)
```

Vaiheiden 6 ja 7 välissä vanha tuotantokoodi ei toimi, koska se kysyy
`profile`-riviä arvolla `'me'`. Katko kestää yhden deployn verran.

---

## Anthropic-avaimen kierto

Vanha avain on ollut selkokielisenä työpöytätiedostossa. Se pitää kiertää.
**Järjestys on tärkeä — älä mitätöi vanhaa avainta ensin.**

1. **Luo uusi avain**
   console.anthropic.com -> **API Keys** -> **Create Key**.
   Anna nimi, esim. `manifestival-vercel-prod`. Kopioi arvo talteen kerran.

2. **Lisää se Verceliin**
   Vercel -> projekti -> **Settings** -> **Environment Variables** ->
   nimi `ANTHROPIC_API_KEY`, arvo = uusi avain, ympäristö **Production**
   (ja Preview jos käytät). Tallenna.

3. **Ota uusi avain käyttöön**
   Vercel -> **Deployments** -> viimeisin -> **Redeploy**.
   Ympäristömuuttuja tulee voimaan vasta uudessa deployssa.

4. **Testaa uusi avain**
   Avaa tuotantosovellus, kirjaudu, paina mikrofonipainiketta ja sano esim.
   "muistuta huomenna soittamaan". Jos vahvistuslomake täyttyy jäsennetyillä
   kentillä (otsikko, päivä, kategoria), uusi avain toimii.
   Jos näet "Tulkinta epäonnistui", **pysähdy** — vanhaa avainta ei saa vielä
   mitätöidä.

5. **Vasta sitten mitätöi vanha avain**
   console.anthropic.com -> API Keys -> vanha avain -> **Revoke**.

6. **Poista työpöydän selkokielinen tiedosto**
   `C:\Users\info\Desktop\Manifestival\Apiavain cloudelle\APi key.txt`
   Poista tiedosto ja tyhjennä roskakori. Tämä on **käyttäjän tehtävä** —
   tiedostoa ei poisteta automaattisesti.

7. **Tarkista käyttöhistoria**
   console.anthropic.com -> **Usage**. Jos näet kulutusta, jota et tunnista,
   avain on saattanut vuotaa.

---

## Vercel-asetusten tarkistus

Käy nämä läpi kerran:

- **Settings -> Git**: onko repo `limitlesslife-software/manifestival` kytketty,
  ja onko Production Branch `main`
- **Settings -> Environment Variables**: onko `ANTHROPIC_API_KEY` asetettu
- **Settings -> Deployment Protection**: halutaanko preview-deployt suojata
- **Deployments**: mikä commit on tällä hetkellä tuotannossa

---

## Supabase-asetusten tarkistus

- **Authentication -> Providers**: onko Email päällä
- **Authentication -> Sign In / Providers**: `Confirm email` päälle
- **Authentication -> URL Configuration**: `Site URL` =
  `https://manifestival-ten.vercel.app`
- **Database -> Backups**: onko varmuuskopiointi päällä
- **Database -> Tables**: RLS-status tauluille `tasks` ja `profile`

---

## Android-julkaisu

Android on erillinen julkaisukanava eikä se vaikuta web-tuotantoon.

```bash
npm run build:android    # dist/ -> android -> APK
```

APK: `android/app/build/outputs/apk/debug/app-debug.apk`

**Java-versio:** Capacitor 8 vaatii Java 21+. Koneen oletus-JDK on 17, joten
koonti epäonnistuu virheeseen `invalid source release: 21`. Android Studion
mukana tuleva JDK 25 kelpaa:

```bash
JAVA_HOME="/c/Program Files/Android/Android Studio/jbr" ./gradlew assembleDebug
```

**Huomio versioinnista:** web ja Android julkaistaan eri tahdissa. Käyttäjällä
voi olla vanha APK, kun web on jo päivittynyt. Siksi **Supabase-skeeman pitää
pysyä taaksepäin yhteensopivana** — additiiviset migraatiot, ei sarakkeiden
poistoja tai uudelleennimeämisiä.

Release-AAB ja Play Store vaativat allekirjoitusavaimen. Sitä ei ole vielä
luotu. Avain **ei koskaan** mene versionhallintaan (`.gitignore`: `*.keystore`,
`*.jks`).

---

## Rollback

| Tilanne | Toimenpide |
|---|---|
| Koodi rikki tuotannossa | Vercel -> Deployments -> edellinen toimiva -> **Promote to Production**. Välitön. |
| Koodi rikki, halutaan pysyvä paluu | `git revert <commit>` `main`-haarassa, push -> Vercel deployaa automaattisesti |
| Migraatio rikkoi tietokannan | Palauta Supabase-varmuuskopiosta. Migraatio 0001 ei ole häviöttömästi peruttavissa (`profile.id` text -> uuid). |
| Avain vuotanut | Mitätöi avain heti Anthropic-konsolissa ja luo uusi |

Migraatio 0001 ajetaan yhdessä transaktiossa: jos jokin vaihe epäonnistuu,
mitään ei jää puolitiehen.
