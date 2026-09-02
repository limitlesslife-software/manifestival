# Android-auditointi

Auditoitu **julkaisupaketin yhdistetystä manifestista**, ei pelkästä
lähdemanifestista. Ero on olennainen: suurin osa luvista tulee
ilmoituslisäosasta yhdistämisen kautta eikä näy omassa tiedostossamme.

Laitetta ei käytetty. ADB:tä ei käytetty. APK:ta ei asennettu.

## Luvat julkaisupaketissa

| Lupa | Mistä | Perustelu |
|---|---|---|
| `INTERNET` | oma manifesti | Supabase ja `/api/parse` |
| `POST_NOTIFICATIONS` | lisäosa | Muistutukset, Android 13+ |
| `RECEIVE_BOOT_COMPLETED` | lisäosa | Ajastetut muistutukset uudelleenkäynnistyksen jälkeen |
| `SCHEDULE_EXACT_ALARM` | lisäosa | Muistutus täsmällisenä kellonaikana |
| `WAKE_LOCK` | lisäosa | Ilmoituksen toimitus |

**Ei sijaintia. Ei kameraa. Ei mikrofonia. Ei tallennustilaa. Ei
yhteystietoja.** Jokainen lupa palautuu toteutettuun ominaisuuteen.

Oma manifesti pyytää **vain `INTERNET`**. Testi kaatuu, jos sinne
lisätään mitä tahansa muuta.

### Julkaisua koskeva huomio

`SCHEDULE_EXACT_ALARM` on Androidilla arkaluontoinen lupa. Google Play
vaatii sille perustelun julkaisulomakkeessa, ja käyttäjä voi evätä sen
asetuksista. Sovelluksen pitää kestää epäys — muistutukset siirtyvät
silloin epätäsmällisiksi. **Tätä ei ole todennettu laitteella.**

## Ulospäin avoimet komponentit

| Komponentti | `exported` | Kunnossa |
|---|---|---|
| `MainActivity` | `true` | Kyllä — se on käynnistin, ja ainoa avoin |
| `FileProvider` | `false` | Kyllä |
| `LocalNotificationRestoreReceiver` | `false` | Kyllä |
| `LocalNotificationsAssetProvider` | `false` | Kyllä |
| `TimedNotificationPublisher` | ei asetettu | Ei intent-filteriä → oletus `false` |
| `NotificationDismissReceiver` | ei asetettu | Sama |
| `ProfileInstallReceiver` | `true` | AndroidX:n oma, luvalla suojattu |

targetSdk on 36. Android vaatii ≥ 31:llä nimenomaisen `exported`-arvon
jokaiselle komponentille, jolla on intent-filter — koonti onnistuu, joten
asettamattomilla ei ole intent-filteriä ja niiden oletus on `false`.

## Korjattu: varmuuskopio vei kirjautumisistunnon pilveen

**Löydös (MEDIUM).** `android:allowBackup="true"` oli voimassa.

Supabase-client luodaan `persistSession: true` -asetuksella
(`src/data/client.js`), joten kirjautumisistunto — access token ja
**pitkäikäinen refresh token** — elää WebView'n `localStorage`issa. Se
sijaitsee sovelluksen datahakemistossa, jonka Androidin automaattinen
varmuuskopio kopioi käyttäjän Google Driveen ja palauttaa uudelle
laitteelle.

Pitkäikäinen tunnus ei kuulu varmuuskopioon. Sama koskee tulevaa
hyvinvointi- ja talousdataa, jos persistenssi joskus siirtyy laitteelle.

**Korjaus:** `android:allowBackup="false"`.

Hinta on pieni. Käyttäjän oma data on Supabasessa, joten laitteen
vaihdossa menetetään vain istunto ja laitekohtaiset asetukset (viimeksi
avattu näkymä). Käyttäjä kirjautuu uudelleen.

Kaksi testiä vartioi tätä. Toinen tarkistaa arvon, toinen sen, etteivät
`persistSession: true` ja `allowBackup="true"` voi koskaan olla yhtä aikaa
voimassa — yhteys näiden kahden päätöksen välillä katoaisi muuten heti,
kun toinen tiedosto muuttuu yksin.

## Korjattu: selväkielinen liikenne oli vain oletuksen varassa

`usesCleartextTraffic` ei ollut asetettu. targetSdk 36:n **oletus on jo
`false`**, joten käytännön aukkoa ei ollut — mutta oletukseen ei nojata.
Nimenomainen `android:usesCleartextTraffic="false"` säilyy, vaikka
targetSdk joskus laskisi.

Luokitus: LOW, ennakoiva.

## Kuoren eheys

`android/`-hakemistossa ei ole sovelluslogiikkaa. Assetit tulevat
`dist/`-koonnista eikä niitä muokata käsin. Molemmat on jo testattu
(`tests/android.test.mjs`), eikä niissä löytynyt puutteita.

## Koonti

| | Polku | Koko |
|---|---|---|
| Debug | `android/app/build/outputs/apk/debug/app-debug.apk` | 4 611 491 tavua |
| Release | `android/app/build/outputs/apk/release/app-release-unsigned.apk` | 3 616 410 tavua |

Release on **allekirjoittamaton**. Tuotannon allekirjoitusavainta ei luotu.

Gradle 9.1.0, JDK Android Studion mukana tuleva JBR. Menetelmä:

```
JAVA_HOME="/c/Program Files/Android/Android Studio/jbr" ./gradlew assembleRelease
```

Ilman tätä `JAVA_HOME`-asetusta koonti kaatuu koneen oletus-JDK:hon.

## Todentamatta (vaatii laitteen)

- Ilmoitusten todellinen toimitus
- `SCHEDULE_EXACT_ALARM`-luvan epäyksen käytös
- Varmuuskopion poiskytkennän vaikutus laitteen vaihdossa
- WebView'n `localStorage` oikeassa kuoressa
