# Julkaisu ja ympäristöt

---

## Nykyinen malli

```
paikallinen klooni
   └─ feature/wp-N-...
        └─ main  ──────>  Vercel  ──────>  https://manifestival-ten.vercel.app
```

**Todennettu ihmisen toimesta Vercelin hallintapaneelista:**

| | |
|---|---|
| Vercel-projekti | `manifestival` |
| Kytketty repo | `limitlesslife-software/manifestival` |
| Production Branch Tracking | `main` |
| Vaikutus | **jokainen push `main`iin luo Production-julkaisun** |
| Tuotantodomain | `https://manifestival-ten.vercel.app`, automaattinen osoitteenanto päällä |
| `ANTHROPIC_API_KEY` | on olemassa, laajuus Production + Preview |
| `PARSE_REQUIRE_AUTH` | **ei ole asetettu** — ja se on oikein, ks. alla |

Muita haaroja ei ole etärepossa: `origin` sisältää vain `main`.

---

## VAROITUS: `main` on yhä vanha prototyyppi

**Tuotannossa on tällä hetkellä 7 tiedoston prototyyppi** (`bd652fa`):
`index.html`, `api/parse.js`, `manifest.json`, `package.json` ja kolme
ikonia. Se on 59 committia jäljessä kehityshaarasta, eikä se sisällä
Supabase-autentikaatiota, `src/`-moduulipuuta, turvaotsakkeita eikä
API:n kovennusta.

**Tuotannon sovellus ja tuotannon tietokanta ovat siis eri aikakausilta.**
Tietokantaan on ajettu migraatiot 0001 ja 0002: omistajuus on
`auth.uid()`, RLS on päällä ja anon-roolilta on peruttu kaikki
oikeudet. Prototyyppi taas tekee jokaisen kyselynsä anonina ja hakee
profiilin ehdolla `.eq('id', 'me')`.

Käytännössä tämä tarkoittaa, että **tuotantosivusto on ollut rikki siitä
lähtien kun 0001 ajettiin**: jokainen luku palauttaa `42501 permission
denied` ja profiilikysely `22P02 invalid input syntax for type uuid`.

Ensimmäinen oikea julkaisu ei siis ole riskinotto vaan korjaus.

---

## Paluu vanhaan versioon EI ole turvallinen

**`bd652fa` ei ole kelvollinen paluukohde.** Vercelin *Redeploy previous
deployment* palauttaisi prototyypin, joka ei toimi nykyistä tietokantaa
vasten lainkaan — ei osittain, vaan ei ollenkaan.

Sama koskee jokaista committia ennen migraatiota 0001. Ainoa kelvollinen
paluukohde on **ensimmäisen onnistuneen julkaisun SHA**, ja siksi se on
merkittävä muistiin heti kun savutesti on läpi (ks. *Julkaisun
merkitseminen*).

Tietokantaa ei palauteta taaksepäin koodin takia. Jos koodi on rikki,
korjataan koodi.

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
| `EXPLAIN_ENABLED` | Valinnainen | Ei. **Jätetään asettamatta**, kunnes omistaja ottaa tekoälyselityksen käyttöön — ks. alla |

### EXPLAIN_ENABLED — tekoälyselityksen katkaisin

`/api/explain` (Suunnan havainnon tekoälyselitys) on **oletuksena pois**.
Ehto on `api/explain.js`:ssä: vain täsmälleen `EXPLAIN_ENABLED=true` avaa
päätepisteen. Muuten se vastaa `503 {"error":"Palvelu ei ole käytössä"}`
heti metoditarkistuksen jälkeen — ennen todennusta, joten yhtään
Supabase- tai Anthropic-kutsua ei tehdä eikä kiintiötä kulu.

Selaimessa on vastinpari: `AI_EXPLAIN_ENABLED` (`src/ai/alignmentExplainClient.js`).
Kun se on `false`, "Selitä tekoälyllä" -painiketta ei näytetä eikä selain
kutsu päätepistettä. Käyttöönotto = **molemmat** samassa julkaisussa, ja se on
omistajan päätös (`docs/SUUNTA-ACTIVATION-GO-NOGO.md`). Kumpikin yksin pitää
selityksen poissa, ja käyttäjä näkee aina deterministisen selityksen.

`PARSE_REQUIRE_AUTH=false` **ei** avaa selitystä: `/api/explain` vaatii aina
kirjautuneen käyttäjän. Hätävara koskee puheohjausta ja muita
AI-päätepisteitä (`parse`, `extract`, `plan`, `capture`, `command`).

Funktion enimmäiskesto on `vercel.json`issa 20 s: todennus enintään 5 s +
Anthropic-kutsu enintään 10 s. Selain odottaa 16 s ja näyttää sitten
deterministisen selityksen.

Asetetaan: Vercel -> projekti -> **Settings** -> **Environment Variables**.

Ilman Anthropic-avainta sovellus toimii muuten normaalisti; puheohjaus
tallentaa komennon raakatekstinä eikä jäsennä sitä.

### PARSE_REQUIRE_AUTH — miksi sitä EI aseteta

`/api/parse` vaatii kirjautuneen käyttäjän. Ehto on `api/_auth.js`:ssä:

```js
function authRequired() {
  return process.env.PARSE_REQUIRE_AUTH !== 'false';
}
```

Tämä on **fail-closed**. Taulukko kaikista tapauksista:

| `PARSE_REQUIRE_AUTH` | Todennus | Huomio |
|---|---|---|
| ei asetettu | **vaaditaan** | nykytila, turvallinen oletus |
| `"true"` | vaaditaan | sama kuin asettamatta jättäminen |
| `"false"` | **ei vaadita** | ainoa tapa avata päätepiste |
| `"False"`, `"0"`, `""`, mikä tahansa muu | vaaditaan | kirjoitusvirhe **ei** avaa päätepistettä |

**Muuttujaa ei siis tarvitse eikä kannata asettaa ennen julkaisua.**
Asettaminen arvoon `true` ei muuta mitään, mutta se lisää yhden asian,
joka voi mennä väärin. Muuttuja on hätävara: jos jokin menee julkaisussa
pieleen, `PARSE_REQUIRE_AUTH=false` avaa päätepisteen väliaikaisesti.

Todennus tehdään antamalla kutsujan token Supabasen omalle
`/auth/v1/user`-päätepisteelle. Palvelimelle ei siis tarvita JWT-salaisuutta.

Uusi selainkoodi lähettää tokenin aina (`src/ai/parseClient.js`), vanha
prototyyppi ei. Koska molemmat julkaistaan samasta repostosta samassa
deployssa, tämä ei ole ongelma — mutta se on syy siihen, ettei `api/`
saa koskaan päivittyä yksinään.

### Mitä /api/parse tekee ennen kuin se kuluttaa kiintiötä

Järjestys on olennainen: todennus on ensimmäisenä, joten kirjautumaton
kutsu hylätään ennen kuin se ehtii kuluttaa mitään.

1. `POST` — muut metodit `405`
2. **todennus** — ei tokenia tai vanhentunut token `401`
3. pyyntörajoitin — 20 pyyntöä / 60 s **käyttäjäkohtaisesti**, `429`
4. syötevalidointi — runko enintään 8 kt, litterointi enintään 1000 merkkiä
5. `ANTHROPIC_API_KEY` palvelimen ympäristöstä — puuttuessa `500`
6. kutsu Anthropicille, aikakatkaisu 15 s

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
5. Luo itsellesi tili -> varmista auth.users-tunniste (odotus: 2cc00622-...)
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

---

## Julkaisun merkitseminen

Kun ensimmäinen julkaisu on tehty ja savutesti on läpi, merkitse SHA
muistiin. Se on ainoa kelvollinen paluukohde.

```
git tag -a prod-2026-09-first-release -m "Ensimmainen tuotantojulkaisu" <SHA>
git push origin prod-2026-09-first-release
```

Älä luo merkintää ennen savutestiä: merkintä tarkoittaa "tämän tiedetään
toimivan tuotannossa", ei "tämä julkaistiin".

---

## Skeemaporttien tila julkaisuhetkellä

Kaikki yksitoista porttia ovat `false`. Se on tarkoitus: ensimmäinen
julkaisu vie sovelluksen tuotantoon **ilman** yhtäkään ominaisuutta,
jonka migraatiota ei ole ajettu.

| Portti | Migraatio | Migraatio ajettu | Portti |
|---|---|---|---|
| `TASK_EXTENDED_FIELDS` | 0002 | kyllä | `false` — aktivointi on GATE E |
| `routines`, `routineExceptions` | 0003 | ei | `false` |
| `goals`, `projects` | 0004 | ei | `false` |
| `notificationPreferences` | 0005 | ei | `false` |
| `wellbeing` | 0006 | ei | `false` |
| `bills`, `recurringExpenses`, `savingsGoals` | 0007 | ei | `false` |
| `aiAudit` | 0008 | ei | `false` |

Testi `KRIITTINEN: yksikään portti ei ole auki ilman ajettua migraatiota`
lukee migraatiotiedostojen omat tilamerkinnät ja kaatuu, jos portti
avataan ennen sen migraatiota.

---

## Suositus: suojaa `main`

Jokainen push `main`iin julkaisee tuotannon. Nyt suoja on yksinomaan
muistin varassa.

Suositeltavat asetukset GitHubissa (**ei toteutettu — päätös on ihmisen**):

- Branch protection `main`-haaralle
- Suora push kielletty, muutokset vain pull requestin kautta
- Vaadittu status check: `npm test`
- Force-push ja haaran poisto estetty

Nämä eivät estä ensimmäistä julkaisua — ne kannattaa ottaa käyttöön
vasta sen jälkeen, jottei ensimmäinen push jää oman suojauksensa taakse.
