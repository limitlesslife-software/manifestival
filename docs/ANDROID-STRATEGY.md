# Android-strategia

Päätös tehty 1.9.2026. Tila: **PÄÄTETTY — Capacitor.**

---

## Miksi natiivikerros ylipäätään tarvitaan

Manifestival on tällä hetkellä PWA. Se riittää päivä- ja viikkosuunnitteluun,
tehtäviin ja puheohjaukseen sovelluksen ollessa auki.

Konseptidokumentin lupauksista **kolme ei ole selaimen tavoitettavissa**, ja ne
ovat juuri niitä, jotka erottavat Manifestivalin kalenterista:

| Lupaus | Konseptin luku | Miksi selain ei riitä |
|---|---|---|
| Muistutus oikeaan aikaan, myös sovellus kiinni | 11, 23 | Web push on epäluotettava; Android tappaa taustatilan, iOS ei tue asennettuna |
| Lähtöajan ennakointi sijainnin perusteella | 12 | Taustasijainti ei ole selaimen käytettävissä |
| Puhekomento Android-sovelluksessa (etualalla, napautuksesta) | 10 | WebView'n Web Speech -tunnistus ei saa mikrofonia Capacitorissa; tarvitaan järjestelmän oma tunnistin (vaihe 6) |

Jos nämä jäävät pois, tuotteesta jää jäljelle kalenteri. Natiivikerros ei siis
ole tekninen mieltymys vaan tuotevaatimus.

**Peruttu lupaus (26.9.2026): puhekomento lukitulla puhelimella.** Se vaatisi
taustalla kuuntelevan mikrofonin (etualapalvelu ja jatkuvasti auki oleva
mikrofoni), mikä on ristiriidassa tuotteen perusvaatimuksen "ei aina
kuuntelevaa mikrofonia" kanssa. Puhe toimii vain sovelluksen ollessa auki ja
vain käyttäjän napautuksesta; `speech.supportsBackgroundCapture()` on `false`
kaikilla alustoilla.

**Milloin:** vasta kun ydin on vakaa (ks. `docs/ROADMAP.md`, WP12). Tämä
dokumentti tehdään etukäteen, jotta arkkitehtuuriratkaisut eivät sulje ovea.

---

## Vaihtoehdot

### A) Capacitor — natiivikuori olemassa olevan web-koodin ympärille

Capacitor ajaa saman `index.html`:n ja samat moduulit natiivissa WebView'ssä ja
tarjoaa JS-sillan natiivirajapintoihin.

| | |
|---|---|
| Koodin uudelleenkäyttö | **~100 %.** Sovelluslogiikka, näkymät ja tyylit sellaisenaan |
| Uudelleenkirjoitus | Ei mitään |
| Ilmoitukset | `@capacitor/local-notifications` — natiivi ajastus, toimii sovellus kiinni |
| Taustasijainti | `@capgo/background-geolocation` |
| Puheentunnistus | Oma liitännäinen `SpeechPlugin.java` (`ManifestivalSpeech`), järjestelmän `SpeechRecognizer` — ks. vaihe 6 |
| APK / AAB | `cap sync android` + Gradle |
| Play Store | Normaali julkaisu |
| Ylläpito | Yksi koodikanta, natiivisilta vain sitä vaativille toiminnoille |
| Riski | WebView-suorituskyky, Capacitorin versiopäivitykset |

### B) Trusted Web Activity (TWA) / PWA-kääre

Android-sovellus, joka avaa PWA:n Chrome-moottorissa ilman selaimen käyttöliittymää.

| | |
|---|---|
| Koodin uudelleenkäyttö | 100 % |
| Uudelleenkirjoitus | Ei mitään |
| Ilmoitukset | Vain web push — **ei ratkaise ongelmaa** |
| Taustasijainti | **Ei mahdollinen** |
| Puheentunnistus | Vain selaimen, etualalla — **ei ratkaise ongelmaa** |
| APK / AAB | Kyllä (Bubblewrap / PWABuilder) |
| Play Store | Kyllä, mutta vaatii Digital Asset Links -todennuksen |
| Ylläpito | Kevyin |
| Riski | **Ei anna pääsyä natiivirajapintoihin lainkaan** |

TWA tuottaa asennettavan sovelluksen, mutta ei ratkaise yhtäkään kolmesta
ongelmasta, joiden takia natiivikerrosta ylipäätään harkitaan. Se on
jakelutapa, ei kyvykkyysratkaisu.

### C) React Native / Expo — uudelleenkirjoitus

| | |
|---|---|
| Koodin uudelleenkäyttö | **Domain-logiikka ~35 %, käyttöliittymä 0 %** |
| Uudelleenkirjoitus | Kaikki näkymät, tyylit ja DOM-vuorovaikutus |
| Ilmoitukset | Erinomainen tuki |
| Taustasijainti | Erinomainen tuki |
| Puheentunnistus | Hyvä tuki |
| APK / AAB | Kyllä (EAS tai paikallinen) |
| Play Store | Kyllä |
| Ylläpito | **Kaksi käyttöliittymää: web ja natiivi** tai luovutaan webistä |
| Riski | Suuri kertakustannus, kaksi rinnakkaista käyttöliittymää |

---

## Vertailu numeroina

Nykyisen koodin uudelleenkäyttö vaihtoehdoittain:

| Osa | Rivejä (n.) | Capacitor | TWA | React Native |
|---|---|---|---|---|
| `src/domain/` puhdas logiikka | 700 | ✅ | ✅ | ✅ siirrettävissä |
| `src/lib/` apufunktiot | 300 | ✅ | ✅ | ✅ siirrettävissä |
| `src/data/` Supabase | 400 | ✅ | ✅ | ⚠️ client vaihtuu |
| `src/ai/` | 250 | ✅ | ✅ | ✅ siirrettävissä |
| `src/app/` näkymät ja DOM | 1 400 | ✅ | ✅ | ❌ uudelleen |
| `src/ui/` DOM-apuvälineet | 300 | ✅ | ✅ | ❌ uudelleen |
| `src/styles.css` | 300 | ✅ | ✅ | ❌ uudelleen |
| **Uudelleenkäyttö** | | **~100 %** | **100 %** | **~35 %** |

---

## Päätös: Capacitor

**Perustelu järjestyksessä:**

1. **TWA ei ratkaise ongelmaa.** Se on ainoa vaihtoehto, joka jättää kaikki
   kolme natiivivaatimusta täyttämättä. Se putoaa pois heti.

2. **React Native maksaisi ~2 000 riviä uudelleenkirjoitusta** eikä toisi
   yhtään kyvykkyyttä, jota Capacitor ei toisi. Se myös pakottaisi valitsemaan:
   joko ylläpidetään kahta käyttöliittymää tai luovutaan web-versiosta, joka on
   tällä hetkellä ainoa toimiva tuote.

3. **Capacitor säilyttää koko nykyisen työn.** WP2:n modularisointi tehtiin
   juuri niin, että domain on puhdas ja alustariippuvuus kulkee
   `src/platform/`-sovittimien läpi. Capacitor kytkeytyy näihin sovittimiin —
   ydinsovellus ei muutu lainkaan.

4. **Sama pino toimii jo tässä organisaatiossa.** `Desktop\Tuntiset` on
   Capacitor 8 -sovellus, jossa on `speech-recognition`,
   `local-notifications` ja `background-geolocation` — täsmälleen ne kolme
   liitännäistä, joita Manifestival tarvitsee. Riski on siis mitattu, ei arvattu.

5. **Työkaluketju on jo koneella.** JDK 17, Android SDK (platform 35–37,
   build-tools 34–36) ja Android Studio ovat asennettuina. Uusia
   koneenlaajuisia asennuksia ei tarvita.

**React Nativea ei valittu siksi, että se on tunnettu.** Se hävisi
nimenomaan tässä projektissa, koska olemassa olevan koodin uudelleenkäyttö on
tässä vaiheessa tärkein tekijä.

---

## Mitä tämä tarkoittaa käytännössä

### Yksi koodikanta, ei haarautumista

```
src/                       ← YKSI lähde. Sama web- ja Android-versiossa.
  domain/ lib/ data/ ai/     liiketoimintalogiikka, ei alustariippuvuutta
  app/ ui/                   käyttöliittymä, sama molemmissa
  platform/                  ← AINOA kohta, jossa alustat eroavat
    index.js                   web-toteutus (nykyinen)
    capacitor.js               natiivitoteutus (myöhemmin)

android/                   ← Capacitorin generoima kuori. Ei sovelluslogiikkaa.
```

**Sääntö:** natiivikoodia kirjoitetaan vain `src/platform/`-sovittimen taakse.
Jos Android-versioon tulee liiketoimintalogiikkaa, se on virhe.

Natiivipuolen lähdetiedostot on lueteltu täsmällisesti
(`tests/android.test.mjs`): `MainActivity.java` ja `SpeechPlugin.java`.
Puheliitännäinen on alustarajapinta (mikrofoni → teksti), ei
sovelluslogiikkaa; sen ainoa kuluttaja on `src/platform/speech.js`. Jokainen
uusi natiivitiedosto on omistajan päätös.

### Sovittimen valinta ajon aikana

`src/platform/index.js` tunnistaa jo nyt natiivikuoren
(`Capacitor.isNativePlatform()`). Natiivitoteutus lisätään rinnalle eikä
kutsupaikkoja tarvitse muuttaa.

---

## Käyttöönoton vaiheet

| Vaihe | Sisältö | Tila |
|---|---|---|
| 1 | Capacitor-riippuvuudet ja `capacitor.config.json` | **TEHTY** |
| 2 | `android/`-projekti, sovellustunnus ja ikonit | **TEHTY** |
| 3 | Paikallinen debug-APK | **TEHTY** |
| 4 | `platform/capacitor.js`: ilmoitukset natiivisti | PLANNED (WP12) |
| 5 | Taustasijainti ja lähtöajan ennakointi | PLANNED (WP11–12) |
| 6 | Natiivi puheentunnistus | **KOODI TEHTY** (käännetty; ei laitetestattu) |
| 7 | Allekirjoitettu release-AAB ja Play Store | PLANNED |

### Vaihe 6: puheentunnistus — päätös (26.9.2026)

**Miksi selaimen polku ei toimi Android-sovelluksessa.** WebView tukee Web
Speech -tunnistusta, mutta se pyytää mikrofonin `WebChromeClient.onPermissionRequest`-
polun kautta. Capacitorin `BridgeWebChromeClient` muuttaa pyynnön
ajonaikaiseksi pyynnöksi kahdelle luvalle (äänitys ja äänen asetusten
muokkaus) ja hylkää pyynnön, jos kumpaakaan ei ole julistettu. Tulos oli
`not-allowed` ja harhaanjohtava "salli mikrofoni selaimen asetuksista".

**Valinta: oma liitännäinen, ei `@capacitor-community/speech-recognition`.**
`android/app/src/main/java/fi/limitlesslife/manifestival/SpeechPlugin.java`
(`@CapacitorPlugin(name = "ManifestivalSpeech")`, rekisteröidään
`MainActivity.onCreate`:ssa ennen `super.onCreate`a). Perusteet:

- Täysi hallinta lupaan: vain `RECORD_AUDIO`, ja sitä kysytään **vain**
  `listen()`-kutsussa käyttäjän napautuksesta. `requestPermissions()` vain
  lukee tilan.
- Äänen asetusten muokkauslupaa **ei julisteta tarkoituksella**: silloin
  Capacitor hylkää WebView'n omat mikrofonipyynnöt, eikä web-koodi voi avata
  mikrofonia liitännäisen ohi. Web-puolella natiivikuori ei koskaan rakenna
  `webkitSpeechRecognition`ia (`src/platform/speech.js`).
- Elinkaari: `handleOnPause` katkaisee kuuntelun; `handleOnStop` ja
  `handleOnDestroy` perivät myös lupadialogin odotuksen. Ei etualapalvelua, ei
  taustakuuntelua, ei väliaikatuloksia, ääntä ei tallenneta.
- Kutsut ratkeavat aina (`{ok, text}` tai `{ok:false, code}`), eivät hylkää.
- Pysyvä kielto (`blocked`) → "Avaa asetukset" (`openSettings()`,
  `ACTION_APPLICATION_DETAILS_SETTINGS`).
- Manifestissa `<queries>` → `android.speech.RecognitionService`, jotta
  Android 11+ näyttää tunnistinpalvelun sovellukselle.
- Yhteisöliitännäinen olisi tuonut riippuvuuden, jonka manifestilisäykset ja
  elinkaarikäytös pitäisi auditoida erikseen, eikä se olisi jättänyt
  WebView'n mikrofonipolkua suljetuksi.

**Yksityisyys.** `android.speech.SpeechRecognizer` antaa äänen järjestelmän
tunnistimelle (yleensä Googlen), usein palvelimella käsiteltäväksi.
Laitekohtaisen tunnistimen suosiminen (API 31+ `createOnDeviceSpeechRecognizer`)
on avoin omistajan päätös. Play-kaupan tietoturvalomakkeen ja sovelluksen
tekstien on kerrottava tämä totuudenmukaisesti.

**Todennettu:** `gradlew compileDebugJavaWithJavac` menee läpi (JDK 21,
Capacitor 8.5). **Ei todennettu:** toiminta puhelimessa — ks.
`docs/DEVICE-ACCEPTANCE-BACKLOG.md`.

**Vaiheet 1–3 eivät muuta web-tuotantoa millään tavalla.** Android-projekti on
oma hakemistonsa; `index.html`, `src/` ja `api/` pysyvät ennallaan ja Vercel
julkaisee ne kuten ennenkin.

### Toteutunut koonti (1.9.2026)

| | |
|---|---|
| Capacitor | 8.5.1 (core, cli, android) |
| APK | `android/app/build/outputs/apk/debug/app-debug.apk` |
| Koko | 4,3 MB |
| Sisältö | `index.html`, 35 JS-moduulia, `styles.css`, manifesti, ikonit |
| Application ID | `fi.limitlesslife.manifestival` |
| minSdk / targetSdk | 24 / 36 |
| Tulos | `BUILD SUCCESSFUL` |

**APK on debug-versio eikä sitä ole asennettu mihinkään laitteeseen.**
Asennus ja laitetestaus ovat käyttäjän erillinen vaihe.

### Koontikomennot

```bash
npm run build:web       # kokoaa dist/ (vain Androidia varten)
npm run sync:android    # dist/ -> android/app/src/main/assets/public
npm run build:android   # koko ketju + Gradle
```

### Java-versio — huomio ympäristöstä

Capacitor 8 vaatii **Java 21 tai uudemman**. Koneen oletus-JDK on 17, joten
koonti epäonnistuu virheeseen `invalid source release: 21`, jos `JAVA_HOME`
osoittaa siihen.

Android Studion mukana tulee JDK 25, joka kelpaa. Uutta koneenlaajuista
asennusta ei siis tarvita — riittää osoittaa koonti siihen:

```bash
JAVA_HOME="/c/Program Files/Android/Android Studio/jbr" ./gradlew assembleDebug
```

Android Studiosta rakennettaessa tämä tapahtuu automaattisesti.

### Gradle 9.1 — miksi versio nostettiin

Koneella on tasan kaksi JDK:ta: Adoptium 17 ja Android Studion mukana tuleva
JBR 25. Kumpikaan ei toiminut Gradle 8.14.3:n kanssa:

| JDK | Ongelma |
|---|---|
| 17 | `invalid source release: 21` — Capacitor 8 vaatii Java 21 -tason |
| 25 | `Unsupported class file major version 69` — Gradle 8.14 ei tue Java 25:tä |

Android Studion päivitys nosti JBR:n versioon 25.0.2, mikä katkaisi aiemmin
toimineen koonnin. Gradle 8.14 tukee Javaa korkeintaan versioon 24 asti.

Vaihtoehdot olivat uuden JDK 21:n asentaminen koneelle tai Gradle-wrapperin
nosto. Wrapper valittiin, koska se on **projektin sisäinen ja
versionhallinnassa**: se ei muuta koneen muita projekteja eikä vaadi
asennusta muilta kehittäjiltä.

```
gradle/wrapper/gradle-wrapper.properties
  gradle-8.14.3-all.zip  ->  gradle-9.1.0-all.zip
```

AGP 8.13.0 toimii Gradle 9.1:n kanssa; sekä `assembleDebug` että
`assembleRelease` menevät läpi. Jos koneelle joskus asennetaan JDK 21,
kumpikin versio toimii — Gradle 9.1 tukee myös sitä.

### Web-koonti (`dist/`) — miksi se on olemassa

Web-tuotanto **ei käytä sitä lainkaan**: Vercel tarjoilee tiedostot repon
juuresta ilman käännösvaihetta. `dist/` on olemassa vain siksi, että Capacitor
kopioi `webDir`-hakemiston APK:hon. Jos `webDir` olisi repon juuri, APK:hon
menisivät `node_modules`, `tests`, `docs`, `supabase` ja `android` itse.

`scripts/build-web.mjs` kopioi täsmälleen ne 41 tiedostoa, jotka selain
oikeasti lataa. Se ei muunna eikä minifioi mitään.

---

## Sovellustunnus ja nimi

| | |
|---|---|
| Application ID | `fi.limitlesslife.manifestival` |
| Sovelluksen nimi | Manifestival |
| Ikonit | Olemassa olevista assetseista (`icon-512.png`) |

Application ID on pysyvä: Play Store ei salli sen muuttamista julkaisun
jälkeen. Muoto noudattaa käänteistä verkkotunnusta ja organisaatiota.

---

## Tunnetut rajoitteet

| Rajoite | Vaikutus | Hallinta |
|---|---|---|
| WebView-suorituskyky | Aikajanan SVG-animaatiot voivat nykiä vanhoilla laitteilla | `prefers-reduced-motion` on jo tuettu; mitataan laitetestissä |
| Capacitorin pääversiopäivitykset | Vaativat Android-projektin päivityksen | Sama työ kuin Tuntisessa; ei uusi riski |
| Web ja Android eri julkaisutahdissa | Käyttäjällä voi olla vanha APK | Supabase-skeeman pitää olla taaksepäin yhteensopiva |
| Play Store -tarkistus | Taustasijainti vaatii perustelun | Kuvataan hakemuksessa; ominaisuus on vapaaehtoinen |
| Sijaintilupa | Ei julisteta lainkaan: mikään toteutettu ominaisuus ei käytä sijaintia (`NATIVE_LOCATION_ENABLED = false`) | Lisätään vain likimääräisenä ja `android.hardware.location required="false"` -rivin kanssa, kun reittipalvelu (WP11) sitä tarvitsee |

---

## Mitä EI tehdä

- **Ei kahta koodikantaa.** Jos Android-versioon syntyy oma näkymälogiikkansa,
  päätös on epäonnistunut.
- **Ei natiiviominaisuuksia ennen kuin ydin on vakaa.** Ilmoitukset ilman
  toimivaa aikataulutusta olisivat vain hälyä.
- **Ei iOS:ää vielä.** Capacitor tukee sitä, mutta se vaatii Macin ja
  Apple-kehittäjätilin. Arvioidaan erikseen.
- **Ei automaattista asennusta puhelimeen.** APK rakennetaan koneella;
  käyttäjä asentaa ja testaa sen itse.
