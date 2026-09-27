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
| Herätys ja puhutut muistutukset | Oma liitännäinen `AlarmPlugin.java` (`ManifestivalAlarm`): `AlarmManager`, etualapalvelu (`mediaPlayback`), `TextToSpeech`, lukitusnäkymä — ks. vaihe 8 |
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
(`tests/android.test.mjs`): `MainActivity.java`, `SpeechPlugin.java` ja
herätyksen tiedostot `AlarmPlugin.java`, `AlarmScheduler.java`,
`AlarmStore.java`, `AlarmMath.java`, `AlarmReceiver.java`,
`BootReceiver.java`, `AlarmService.java` ja `AlarmActivity.java`.
Puheliitännäinen on alustarajapinta (mikrofoni → teksti), ei
sovelluslogiikkaa; sen ainoa kuluttaja on `src/platform/speech.js`.
Herätysliitännäinen on samoin alustarajapinta (soita tämä tähän aikaan):
mitä ja milloin herätetään, päättää domain (`src/domain/alarmPlan.js`), ja
ainoa kuluttaja on `src/platform/alarms.js`. Jokainen uusi natiivitiedosto on
omistajan päätös.

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
| 8 | Natiivi herätys, puhutut muistutukset ja reitin avaus | **KOODI TEHTY** (käännetty, JUnit; ei laitetestattu) |

### Vaihe 8: herätys ja puhutut muistutukset — päätös (27.9.2026)

**Miksi oma liitännäinen.** `@capacitor/local-notifications` hoitaa
tavalliset muistutukset, mutta ei soivaa herätystä: se ei käytä
`setAlarmClock`ia, ei soita ääntä etualapalvelussa, ei puhu eikä näytä
lukitusnäkymää. Selaimessa herätystä ei ole lainkaan: ajastin avoimessa
välilehdessä lupaisi herätyksen, joka jää soimatta. Siksi
`android/app/src/main/java/fi/limitlesslife/manifestival/AlarmPlugin.java`
(`@CapacitorPlugin(name = "ManifestivalAlarm")`, rekisteröidään
`MainActivity.onCreate`:ssa ennen `super.onCreate`a) ja sen JS-puoli
`src/platform/alarms.js`. Selain ja PWA kertovat rehellisesti: "toimii vain
Android-sovelluksessa".

**Ratkaisut:**

- **Tarkka herätys vain käyttäjän luvalla.** `SCHEDULE_EXACT_ALARM`
  (käyttäjä myöntää Asetuksista; Android 14+ ei anna sitä oletuksena).
  Automaattisesti myönnettyä herätyskellon lupaa ei julisteta (Play varaa sen
  herätyskellosovelluksille; verify-apk kieltää sen). Herätys:
  `setAlarmClock`; puhuttu ja kriittinen muistutus:
  `setExactAndAllowWhileIdle`. Ilman oikeutta `setAndAllowWhileIdle`, ja
  tulos kertoo "inexact". Asetus avataan vain napautuksesta
  (`openExactAlarmSettings`).
- **Seinäkello on totuus.** JS antaa päivän ja kellonajan; laite laskee
  hetken omassa aikavyöhykkeessään (`AlarmMath.wallClockToEpoch`: kevään
  olematon aika → seuraava minuutti, syksyn toistuva tunti → ensimmäinen) ja
  laskee sen uudelleen käynnistyksessä, päivityksessä, kellon tai vyöhykkeen
  vaihtuessa ja oikeuden muuttuessa (`BootReceiver`, joka EI käynnistä
  palvelua: Android 15 kieltää sen).
- **Soitto on rajattu.** Etualapalvelu `mediaPlayback` (ei mikrofonia, ei
  sijaintia), `USAGE_ALARM`-ääni, suomenkielinen puhe (`TextToSpeech`,
  varavaihtoehtona ääni ja teksti), voimistuminen vaiheittain, kova raja
  10 minuuttia → automaattinen torkku kerran → loppu. Herätyslukko on
  aikarajattu.
- **Lukitusnäkymä on pieni natiivinäkymä** (`AlarmActivity`): kellonaika,
  nimi, Sammuta ja Torku. WebView'tä ei avata lukitun näytön päälle. Koko
  näytön ilmoitus vain, jos Android 14+ sallii (`canUseFullScreenIntent`),
  muuten nouseva ilmoitus.
- **Puhuttu muistutus** luetaan kerran; ilmoituksessa Kuittaa (tai Lähdin,
  kun mukana on reitin kohde), Torku 5 min ja Avaa reitti (suoraan
  karttasovellukseen, ei trampoliinia).
- **Reitti kootaan aina itse.** `openNavigation` ottaa vain kohteen tekstin
  ja kulkutavan: `google.navigation:q=…&mode=…` Google Mapsiin, muuten
  https-reittiohje. Linkkiä ei koskaan oteta vastaan JS:ltä.
- **Kuittaukset talteen.** Laite kirjaa soinnin, kuittauksen, torkun,
  hylkäyksen, "Lähdin"-painalluksen ja varavaihtoehdot jonoon
  (`consumeEvents`), jonka sovellus lukee avautuessaan. Tapahtumissa ei ole
  otsikoita eikä puhuttua tekstiä.
- **Yksi järjestelmä per muistutus.** Herätystason muistutukset kulkevat
  tämän liitännäisen kautta, tavalliset `@capacitor/local-notifications`in;
  sama muistutus ei saa olla molemmissa (sovelluskerroksen reititys).

**Todennettu:** `gradlew compileDebugJavaWithJavac` ja
`gradlew testDebugUnitTest` (`AlarmMathTest`) menevät läpi (JDK 21,
Capacitor 8.5). **Ei todennettu:** toiminta puhelimessa — ks.
`docs/DEVICE-ACCEPTANCE-BACKLOG.md`, kohta "Herätys ja puhutut muistutukset".

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

### Java-versio — JDK 21 kiinnitetty

Capacitor 8 kääntää **Java 21 -tasolla**. Generoitu
`android/app/capacitor.build.gradle` ja
`node_modules/@capacitor/android/capacitor/build.gradle` asettavat
`JavaVersion.VERSION_21`. JDK 17:llä koonti kaatuu siksi virheeseen
`invalid source release: 21`. Vaatimus tulee Capacitorista: Gradle 9.1 itse
toimisi JVM 17:llä.

Gradle-daemon on kiinnitetty JDK 21:een tiedostossa
`android/gradle.properties`:

```
org.gradle.java.home=C:/Program Files/Eclipse Adoptium/jdk-21.0.12.101-hotspot
```

Komentotulkin `JAVA_HOME` (tällä koneella Temurin 17) ei siksi enää ratkaise
daemonin JDK:ta, eikä `JAVA_HOME`a tarvitse asettaa. Gradle ajetaan
PowerShellistä:

```powershell
Set-Location android; .\gradlew.bat assembleDebug
```

Kiinnitys on koneen oma, absoluuttinen polku versionhallinnassa. Kaksi
vaihtoehtoa on kirjattu omistajan tai kehityksen valinnaksi:

- (a) siirrä rivi käyttäjäkohtaiseen `%USERPROFILE%\.gradle\gradle.properties`-tiedostoon
- (b) korvaa rivi tiedostolla `gradle/gradle-daemon-jvm.properties` (`toolchainVersion=21`)

Temurinin päivitys asentaa uuden hakemistonimen, jolloin kiinnitys on
päivitettävä. Tätä ei ole todennettu. Kiinnitys (a7f8cb3) puuttuu aaltojen
C–G ehdokkailta. Ks. `docs/activation/ANDROID-ACCEPTANCE-BUILD.md`, kohta
"JDK-kiinnitys".

### Versiointi

Hyväksyntä-APK rakennetaan komennolla `npm run android:acceptance`
(`docs/activation/ANDROID-ACCEPTANCE-BUILD.md`).

- **versionName** on muotoa `<package.json version>-wave<X>.<välimuisti>+<sha7>`,
  ja debug-koonti lisää päätteen `-debug`. Ilman koontiskriptiä tulos on
  `1.0.0-debug`.
- **versionCode** on 1, kunnes omistaja päättää toisin. Tämä on
  OMISTAJAN TUOTEPÄÄTÖS (OWNER PRODUCT DECISION). Suositus on commitin aika
  sekunteina hetkestä 2026-01-01Z (`--version-code=commit-epoch`). Se on
  laitteella yksisuuntainen ovi: vanhempaa APK:ta ei voi asentaa suuremman
  versionCoden päälle.

Arvot tulevat Gradle-ominaisuuksista `manifestival.versionCode` ja
`manifestival.versionName` (`android/app/build.gradle`).
Sovellustunnukseen ei lisätä debug-päätettä.

### Gradle 9.1 — miksi versio nostettiin

Noston hetkellä koneella oli kaksi JDK:ta: Adoptium 17 ja Android Studion
mukana tuleva JBR 25. Kumpikaan ei toiminut Gradle 8.14.3:n kanssa:

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
`assembleRelease` menevät läpi. Myöhemmin koneelle asennettiin JDK 21
(Temurin 21.0.12), ja daemon kiinnitettiin siihen (ks. "Java-versio"
yllä). Koneella on nyt kolme JDK:ta: 17, 21 ja JBR 25.

### Web-koonti (`dist/`) — miksi se on olemassa

Web-tuotanto **ei käytä sitä lainkaan**: Vercel tarjoilee tiedostot repon
juuresta ilman käännösvaihetta. `dist/` on olemassa vain siksi, että Capacitor
kopioi `webDir`-hakemiston APK:hon. Jos `webDir` olisi repon juuri, APK:hon
menisivät `node_modules`, `tests`, `docs`, `supabase` ja `android` itse.

`scripts/build-web.mjs` kopioi täsmälleen ne tiedostot, jotka selain
oikeasti lataa: juuren kuusi tiedostoa ja koko `src/`-puun, pois lukien
`src/package.json` (aalto J: 148 tiedostoa). Se ei muunna eikä minifioi
mitään.

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
| Tarkkojen herätysten oikeus | Android 14+ ei anna sitä oletuksena; oikeuden peruminen poistaa herätykset ja sulkee sovelluksen | Epätarkka varavaihtoehto kerrotaan ("inexact"); asetus avataan napautuksesta; herätykset ajastetaan uudelleen sovelluksen avautuessa |
| Koko näytön ilmoitus | Android 14+ myöntää sen vain herätys- ja puhelusovelluksille (Play-ilmoitus) | Nouseva ilmoitus Sammuta/Torku-painikkein; sovelluksen avaus soiton aikana näyttää herätysnäkymän |
| Suomenkielinen puhe | Laitteessa ei välttämättä ole suomen puhedataa | Ääni ja ilmoituksen teksti; tapahtuma `speech_fallback`; `status().tts = "missing"` |
| Valmistajien virransäästö | Osa valmistajista viivästää tai estää taustaherätyksiä (Doze ja omat rajoitukset) | `setAlarmClock` ohittaa Dozen; laitehyväksynnässä testataan; `status().batteryOptimized` kertoo tilan |

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
