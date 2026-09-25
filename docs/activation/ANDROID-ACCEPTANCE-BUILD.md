# Android-hyväksyntäkoonti (aalto J)

**Ei julkaistu, ei asennettu, ei ajettu laitteella.** ADB:tä ei käytetty.

| | |
|---|---|
| Lähde | `rehearsal/wave-j-v1` (kärki kirjattu tiedostoon `.claude/release-packages/*.json`) |
| Tiedosto | `.claude/release-packages/manifestival-suunta-waveJ-v23-<sha>-debug.apk` (+ `.json`-kuvaus) |
| Tyyppi | debug, `fi.limitlesslife.manifestival`, versionCode **1**, versionName **1.0**, minSdk 24, targetSdk 36 |
| JDK | 21.0.12 (Gradle kiinnitetty `android/gradle.properties`) |
| Koonti | `npm run build:web` → `npx cap sync android` → `gradlew.bat assembleDebug` → BUILD SUCCESSFUL |
| Web-assetit | 148/148 tiedostoa tavu tavulta samat kuin `dist/` (+ Capacitorin `cordova.js`, `cordova_plugins.js`); `sw.js` `v23`; kaikki aallon J portit auki |
| Liitännäiset | `@capacitor/app`, `@capacitor/geolocation`, `@capacitor/local-notifications` |

## ⚠ Asennusjärjestys — tärkein asia tässä dokumentissa

APK sisältää aallon J porttitilan **käännösaikaisena**. Se puhuu
tuotannon Supabaseen. Jos se asennetaan ennen kuin migraatiot
**0009–0013 on ajettu ja todennettu**, se kirjoittaa sarakkeisiin ja
tauluihin, joita ei vielä ole — ja kaataa myös tänään toimivat tehtävien
ja tavoitteiden tallennukset (esim. `depends_on` ennen 0010:tä → 42703).

**Asenna vasta, kun `verify_0013.sql` = 0 poikkeavaa ja aalto J on
deployattu webiin.** Web-sovellus päivittyy deployn mukana; APK ei.

## Versio

versionCode/versionName jätettiin ennalleen (1 / 1.0): kauppaversioinnin
strategia on tuotepäätös (PRODUCT_DECISION_REQUIRED). Tunnistus:
tiedostonimi, SHA-256 ja J-kärjen commit `.json`-kuvauksessa. Jos
laitteessa on jo debug-asennus samalla allekirjoituksella, tämä asentuu
päälle (sama versionCode sallitaan päivityksenä).

## Luvat (manifestista, `aapt dump badging`)

| Lupa | Tarvitaanko Day 1:nä | Huom |
|---|---|---|
| `INTERNET`, `ACCESS_NETWORK_STATE` | Kyllä | Supabase, yhteyden tila |
| `POST_NOTIFICATIONS`, `SCHEDULE_EXACT_ALARM`, `RECEIVE_BOOT_COMPLETED`, `WAKE_LOCK` | Vain muistutuksiin | Suunta toimii ilman; kysytään käyttäjän eleestä |
| `ACCESS_COARSE_LOCATION`, `ACCESS_FINE_LOCATION` | **Ei** | Vain lähtöaikaominaisuus; ajonaikainen lupa pyydetään vasta käyttäjän eleestä (testit vartioivat). Suunta ei käytä sijaintia |
| mikrofoni | ei ilmoitettu | Puhekomennot eivät siksi toimi natiivisti; Suunta ei tarvitse |

Sovellus toimii ilman valinnaisia lupia; Suunta ei tarvitse yhtäkään niistä.
