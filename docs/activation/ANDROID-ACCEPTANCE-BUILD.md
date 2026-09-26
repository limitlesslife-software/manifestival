# Android-hyväksyntäkoonti

**Ei julkaistu, ei asennettu, ei ajettu laitteella.** ADB:tä ei käytetty.

Tämä on toistettava menettely, jolla julkaisujunan ehdokkaasta (Suunnalle
aalto J) rakennetaan debug-APK puhelimeen. Koonti, tarkastus ja paketointi
tehdään yhdellä komennolla:

```powershell
npm run android:acceptance -- --worktree .claude/worktrees/rc-j --wave J --dry-run
npm run android:acceptance -- --worktree .claude/worktrees/rc-j --wave J
```

Skripti on `scripts/android-acceptance-build.mjs`, tarkastus
`scripts/verify-apk.mjs`. Kumpikaan ei deployaa, pushaa eikä koske
tuotantoon.

## ⚠ Asennusjärjestys — tärkein asia tässä dokumentissa

APK sisältää aallon porttitilan **käännösaikaisena**. Se puhuu
tuotannon Supabaseen. Jos aallon J APK asennetaan ennen kuin migraatiot
**0009–0013 on ajettu ja todennettu**, se kirjoittaa sarakkeisiin ja
tauluihin, joita ei vielä ole — ja kaataa myös tänään toimivat tehtävien
ja tavoitteiden tallennukset (esim. `depends_on` ennen 0010:tä → 42703).

**Asenna vasta, kun `verify_0013.sql` = 0 poikkeavaa ja aalto J on
deployattu webiin.** Web-sovellus päivittyy deployn mukana; APK ei.

## Nykyinen paketti 5df40b2 on vanhentunut

`.claude/release-packages/manifestival-suunta-waveJ-v23-5df40b2-debug.apk`
(SHA-256 `649529…fe405`) on rakennettu ennen uutta lähdemanifestia. Siinä on
sijaintiluvat, siitä puuttuvat `RECORD_AUDIO` ja `<queries>`-kohta, ja sen
versionName on `1.0`. `scripts/verify-apk.mjs` hylkää sen tarkoituksella
(6/35 tarkistusta kaatuu, kaikki näistä syistä; 148 web-tiedostoa täsmää yhä
`dist/`:iin ja gittiin). Sen `.json`-kuvaus on vanhaa käsin tehtyä muotoa:
tiedosto alkaa BOM-merkillä, aikaleima ei ole ISO-8601 ja SHA-256 on isoilla
kirjaimilla. verify-apk lukee sen silti.

**Älä asenna sitä.** Rakenna uusi paketti J-ehdokkaasta, kun ehdokas on
leikattu uudelleen ja lukitustiedosto päivitetty.

---

## Koonti vaihe vaiheelta

### 0. Edellytykset

| | |
|---|---|
| JDK | 21: `C:/Program Files/Eclipse Adoptium/jdk-21.0.12.101-hotspot` (`android/gradle.properties`, `org.gradle.java.home`) |
| Android SDK | `C:/Users/info/AppData/Local/Android/Sdk` (`ANDROID_HOME` tai `android/local.properties`) |
| build-tools | 36.0.0 (`aapt2.exe`, `lib/apksigner.jar`) |
| Gradle / AGP | 9.1.0 (wrapper) / 8.13.0 |
| Capacitor | android 8.5.0, core 8.5.1, cli 8.5.1; app 8.1.1, geolocation 8.2.2, local-notifications 8.3.1 |
| Sovellus | `fi.limitlesslife.manifestival`, minSdk 24, targetSdk 36 |

- **Ehdokkaassa on oltava versiointicommit**: `android/app/build.gradle`
  lukee ominaisuudet `manifestival.versionCode` ja `manifestival.versionName`.
  Ilman sitä Gradle ohittaa `-P`-arvot hiljaa, ja APK saa arvot 1 / `1.0`.
  Esitarkistus kaatuu silloin kohtaan `gradle.versionPlumbing`. Korjaus on
  commitin cherry-pick ehdokashaaralle. Se muuttaa kärjen SHA:n, joten aja sen
  jälkeen `node tools/activation/train-map.mjs --write` ja
  `npm run activation:verify-wave -- J`.
- **Lukitus**: ehdokkaiden SHA:t ovat tiedostossa
  `docs/activation/release-train-c-j.json` (kirjoittaa
  `tools/activation/train-map.mjs`). Koonti kieltäytyy, jos työpuun HEAD ei
  ole aallon lukittu `deployTarget`. Ohitus `--skip-lock-check` kirjataan
  paketin metatietoihin.

### 1. Työpuu

```powershell
git worktree add .claude\worktrees\rc-j rehearsal/wave-j-v1   # jos ei jo ole
```

Työpuut ovat projektin sisällä hakemistossa `.claude/worktrees/`.

### 2. Kuivaharjoitus

```powershell
npm run android:acceptance -- --worktree .claude/worktrees/rc-j --wave J --dry-run
```

Ajaa vain esitarkistuksen ja tulostaa suunnitelman. Mitään ei rakenneta
eikä kirjoiteta. Esitarkistus vaatii seuraavat:

- työpuu on puhdas (`git status --porcelain --untracked-files=all` tyhjä)
- `--wave`, `src/data/schema.js`:n porttimatriisi ja `sw.js`:n
  `CACHE_VERSION` vastaavat toisiaan
- HEAD on lukittu ehdokas, ja versioputkitus on paikallaan
- `node_modules` ratkeaa ja vastaa työpuun `package-lock.json`ia
- JDK 21 ja build-tools 36.0.0 löytyvät
- paketin nimi on vapaa (vanhaa pakettia ei ylikirjoiteta)

### 3. node_modules-liitos (vain jos esitarkistus pyytää)

Työpuussa ei ole omaa `node_modules`ia. Skripti **ei luo** liitosta itse,
vaan tulostaa tarkan komennon ja pysähtyy:

```powershell
cmd /c mklink /J "C:\Users\info\Desktop\Manifestival\.claude\worktrees\rc-j\node_modules" "C:\Users\info\Desktop\Manifestival\node_modules"
```

Git jättää liitoksen huomiotta (`.gitignore`: `node_modules/`), joten työpuu
pysyy puhtaana. Tämä todennettiin 26.9.2026. Esitarkistus vertaa liitoksen
takana olevia Capacitor-versioita työpuun `package-lock.json`iin.

### 4. Koonti

```powershell
npm run android:acceptance -- --worktree .claude/worktrees/rc-j --wave J
# vasta omistajan päätöksen jälkeen: --version-code=commit-epoch
```

Skripti tekee järjestyksessä seuraavat askeleet:

| # | Askel | Mitä |
|---|---|---|
| 1 | `npm run build:web` | `dist/` työpuusta (juuren kuusi tiedostoa + `src/`, J: 148) |
| 2 | `npx cap sync android` | assetit ja generoidut gradle-tiedostot |
| 3 | Gradle PowerShellistä | `.\gradlew.bat assembleDebug '-Pmanifestival.versionCode=…' '-Pmanifestival.versionName=…'` |
| 4 | verify-apk | kaikki alla luetellut tarkistukset. Jos yksikin kaatuu, pakettia ei tehdä |
| 5 | palautus | `git checkout -- android/capacitor.settings.gradle android/app/capacitor.build.gradle` |
| 6 | puhdas puu | `git status --porcelain` on oltava taas tyhjä |
| 7 | paketti | `.claude/release-packages/manifestival-suunta-wave<X>-<v>-vc<versionCode>-<sha7>-debug.apk` + `.json` |

Askel 5 on pakollinen: liitoksen kanssa `npx cap sync` kirjoittaa kaksi
generoitua gradle-tiedostoa uudelleen `../../../../node_modules`-poluilla.
Palautus tehdään aina, myös kun koonti kaatuu.

`-P`-argumentit on lainattava: Windows PowerShell 5.1 pilkkoo lainaamattoman
`-Pa.b=c`:n pisteen kohdalta. Git Bashin `cmd //c gradlew.bat` ei löytänyt
wrapperia aiemmassa koonnissa, joten Gradle ajetaan PowerShellistä.

**Sama käsin**, jos skriptiä ei voi käyttää (PowerShell, työpuun juuressa):

```powershell
npm run build:web
npx cap sync android
Set-Location android
.\gradlew.bat --console=plain assembleDebug '-Pmanifestival.versionCode=1' '-Pmanifestival.versionName=1.0.0-waveJ.v23+<sha7>'
Set-Location ..
git checkout -- android/capacitor.settings.gradle android/app/capacitor.build.gradle
git status --porcelain
node C:\Users\info\Desktop\Manifestival\scripts\verify-apk.mjs --apk android\app\build\outputs\apk\debug\app-debug.apk --worktree . --wave J --expect-code 1 --expect-name 1.0.0-waveJ.v23+<sha7>-debug
```

Käsin tehdystä koonnista puuttuu metatieto-JSON. Käytä siksi skriptiä aina
kun voit.

### 5. Siivous

```powershell
cmd /c rmdir "C:\Users\info\Desktop\Manifestival\.claude\worktrees\rc-j\node_modules"
```

**Poista liitos vain rmdir-komennolla.** Rekursiivinen poisto
(`Remove-Item -Recurse`, `rm -rf`) seuraa liitosta ja tyhjentää pääkopion
`node_modules`in.

### 6. Paketin tarkastus jälkikäteen ja ennen asennusta

```powershell
node scripts/verify-apk.mjs --apk .claude/release-packages/<nimi>.apk --worktree .claude/worktrees/rc-j --wave J
```

Skripti lukee `<nimi>.apk.json`in automaattisesti. Sieltä tulevat SHA-256,
versionCode, versionName, allekirjoittaja ja commit. Asennuksen jälkeen
puhelimessa: **Asetukset → Sovellukset → Manifestival → versio** on sama
kuin JSONin `versionName`.

## Mitä verify-apk tarkistaa

| Lähde | Tarkistus |
|---|---|
| tiedosto | SHA-256 = metatiedot (kirjainkoolla ei väliä) |
| `aapt2 dump badging` | paketti tasan `fi.limitlesslife.manifestival` (ei päätettä); versionCode 1…2 100 000 000 ja odotettu; versionName `<versio>-wave<X>.<v>+<sha7>-debug`; minSdk/targetSdk = `android/variables.gradle`; `application-debuggable` vain debugissa |
| `aapt2 dump permissions` | täsmälleen alla oleva lupajoukko; ei yhtään kiellettyä lupaa; sovelluksen omat luvat vain signature-tasoisia |
| `aapt2 dump xmltree` | `allowBackup=false`, `usesCleartextTraffic=false`; avoimina vain MainActivity ja `android.permission.DUMP`-suojattu ProfileInstallReceiver; `<queries>` sisältää `android.speech.RecognitionService` |
| `apksigner verify --print-certs -v` | Verifies, v2, yksi allekirjoittaja, varmenne = odotettu |
| APK:n assetit | liitännäiset; `capacitor.config.json` = repon; `assets/public/**` tavu tavulta = `dist/` (lisänä vain `cordova.js`, `cordova_plugins.js`) ja = commitin git-blobit CR-normalisoituna; `sw.js` ja `schema.js` = aalto; ei `tests/`, `docs/`, `supabase/`, `api/`, `node_modules/`, `src/package.json`; ei `sk-ant-`/`service_role`-merkkijonoja |

apksigner ajetaan muodossa `java -jar build-tools\36.0.0\lib\apksigner.jar`
JDK 21:n java.exe:llä. `apksigner.bat` tekee saman, mutta Node ei aja
.bat-tiedostoja luotettavasti ilman komentotulkkia.

Web-assetit ovat työpuun tavuja. Kehityskoneella `core.autocrlf=true`, joten
tekstitiedostot ovat CRLF-muodossa, kun taas git-blobit ja Vercel käyttävät
LF:ää. Siksi git-vertailu normalisoi CR:t ja `dist/`-vertailu ei. Vaihtoehto
on koota `git archive`sta, jolloin APK olisi tavu tavulta sama kuin tuotanto.
Se muuttaisi `build-web.mjs`:n "bittiverrannollinen kopio" -merkityksen, ja
valinta kuuluu omistajalle tai kehitykselle.

## Paketin metatiedot (`.json`)

Kirjoitetaan UTF-8:na ilman BOMia (`tools/android/package.mjs`, skeema
`manifestival-android-package/1`).

| Kenttä | Sisältö |
|---|---|
| `file`, `bytes`, `sha256` | paketin nimi, koko, SHA-256 pienin kirjaimin |
| `wave`, `cacheVersion`, `gitCommit`, `sha7`, `branch`, `commitEpochSeconds` | lähde |
| `versionCode`, `versionName`, `versionPolicy`, `versionPolicyStatus` | versio ja käytäntö (`fixed-1` / `commit-seconds-since-2026-01-01Z` / `explicit`) |
| `gitClean`, `gitCleanAfterBuild` | puhdas puu ennen koontia ja palautuksen jälkeen |
| `signerCertSha256`, `signerDn` | allekirjoittaja |
| `toolchain` | node, npm, JDK, Gradle, AGP, build-tools, aapt2, apksigner, Capacitor-paketit |
| `dist` | tiedostomäärä ja puun tiiviste (SHA-256 riveistä `<sha256>  <polku>`) |
| `aapt` | badging-lukemat (paketti, versio, SDK:t, debuggable, luvat) |
| `verify`, `lock` | tarkastuksen tulos; lukitustiedoston vastaavuus |
| `builtAt` | ISO-8601 UTC (`new Date().toISOString()`) |

---

## Versiointi

### versionName: käytössä nyt

`<package.json version>-wave<X>.<välimuisti>+<sha7>`, ja debug-koonti lisää
päätteen `-debug`. Esimerkki: `1.0.0-waveJ.v23+5df40b2-debug`. Nimi näkyy
puhelimen sovellusasetuksissa, joten kaksi APK:ta erottaa toisistaan
laitteella. Tavallinen `npm run build:android` ilman `-P`-arvoja tuottaa
nimen `1.0.0-debug`. Tuotehaaran koonnin nimi on muotoa `…-waveBASE.v13+…`.
Sekä nimi että oletus todennettiin 26.9.2026 AGP 8.13 / Gradle 9.1:llä
(`processDebugMainManifest`).

### versionCode: OMISTAJAN TUOTEPÄÄTÖS (OWNER PRODUCT DECISION)

**Oletus on 1**, eli sama kuin tähän asti. Kaikki hyväksyntäkoonnit saavat
versionCode 1:n, kunnes omistaja päättää toisin. Tunnistus perustuu silloin
versionNameen ja SHA-256:een.

**Suositus: `--version-code=commit-epoch`**, eli versionCode =
`git log -1 --format=%ct` − 1767225600. Arvo on ehdokkaan kärkicommitin aika
sekunteina hetkestä 2026-01-01T00:00:00Z.

- Deterministinen: sama commit antaa aina saman koodin, joten uudelleenkoonti
  on toistettava.
- Jokainen uudempi commit antaa suuremman koodin. Tämä koskee myös
  cherry-pickiä ja peruutuscommitia, mikä vastaa sääntöä "peruutus nostaa
  aina versiota".
- Pienin arvo on reilusti yli 1, joten APK korvaa minkä tahansa versionCode 1
  -asennuksen.
- Google Playn yläraja 2 100 000 000 tulee vastaan noin vuonna 2092.
- Muut vaihtoehdot hylättiin. Commitien lukumäärä ei kasva luotettavasti
  haarojen välillä, joten uudelleenleikattu aalto voi saada pienemmän luvun.
  Välimuistiversio antaisi tuotehaaralle (v13) pienemmän koodin kuin aallolle
  J (v23). Aallon järjestysnumero antaisi vanhempaan aaltoon peruutetulle
  koonnille pienemmän koodin.

**Seuraus on yksisuuntainen ovi.** Kun laitteessa on esimerkiksi versionCode
23 069 141, sen päälle ei voi asentaa APK:ta, jonka koodi on pienempi (1 tai
vanhempi commit). Android hylkää asennuksen (`INSTALL_FAILED_VERSION_DOWNGRADE`).
Sen jälkeen paluu edelliseen tehdään peruutuscommitilla ja uudella koonnilla,
tai sovellus poistetaan ensin. Poisto hävittää laitteen istunnon ja ajastetut
muistutukset, mutta data on Supabasessa. Sama versionCode asentuu
päivityksenä, ja nykyinen oletus nojaa siihen.

**Päätös kannattaa tehdä ennen ensimmäistä asennusta puhelimeen.** Git-tageja
ei luoda paikallisille APK:ille. Commitista johdettu versionCode ja paketin
JSON riittävät tunnistukseen.

Sovellustunnukseen ei lisätä debug-päätettä (`applicationIdSuffix`). Pääte
tekisi debug-koonnista eri sovelluksen, jolla olisi oma istunto ja omat
muistutukset (eli tuplamuistutukset) ja oma kuvake. Testi
`tests/android-version.test.mjs` vartioi tätä, kunnes omistaja päättää toisin.

## Allekirjoitus

| | |
|---|---|
| Avain | `%USERPROFILE%\.android\debug.keystore` (luotu 16.8.2026, voimassa 2056 asti) |
| DN | `C=US, O=Android, CN=Android Debug` |
| Varmenteen SHA-256 | `cfc9d823cc2266354b62914f26c725b572e8fea6de6edc6172cd1608c624d740` |

verify-apk vertaa allekirjoittajaa tähän (vakio `EXPECTED_SIGNER_CERT_SHA256`,
`tools/android/apk.mjs`), ja paketin JSON kirjaa `signerCertSha256`:n. Jos
avain vaihtuu, puhelin ei päivitä asennettua sovellusta vaan se pitää poistaa
ensin. Siksi eroava varmenne kaataa tarkastuksen.

**OMISTAJAN PÄÄTÖS**, ennen ensimmäistä asennusta:

- **(a)** Debug-allekirjoitettu, debuggable APK henkilökohtaiseen
  hyväksyntään (nykyinen tila). Suositus: varmuuskopioi `debug.keystore`
  projektin sisälle gitignorattuun salaisuushakemistoon, esim.
  `C:\Users\info\Desktop\Manifestival\secrets\android\debug.keystore`
  (`.gitignore`: `secrets/`). Näin Android Studion uudelleenasennus ei katkaise
  päivityksiä.
- **(b)** Oma release-avain repon ulkopuolella (ks.
  `docs/PRODUCTION-ACTIVATION.md`, vaihe 6) ja allekirjoitettu,
  ei-debuggable release-APK.

Siirtyminen (a):sta (b):hen vaatii yhden sovelluksen poiston. Debuggable APK
sallii USB-virheenkorjauksen kautta WebView-tarkastuksen ja `run-as`-komennon.
Kuka tahansa, jolla on lukitsematon puhelin ja USB-virheenkorjaus päällä,
näkee siis localStoragen, myös Supabasen refresh tokenin.

## Luvat (yhdistetty APK-manifesti)

Lähdemanifesti julistaa vain `INTERNET`in ja `RECORD_AUDIO`n. Loput tulevat
kirjastoista yhdistämisessä. Sallittu joukko on vakio
`APK_PERMISSION_ALLOWLIST` (`tools/android/apk.mjs`). verify-apk vaatii
täsmälleen sen, ja testit vaativat, että tämä taulukko mainitsee jokaisen.

| Lupa | Lähde | Tarvitaanko Day 1:nä | Huom |
|---|---|---|---|
| `INTERNET` | oma manifesti | Kyllä | Supabase |
| `RECORD_AUDIO` | oma manifesti (repon SpeechPlugin) | Ei | Ajonaikainen lupa pyydetään vasta, kun käyttäjä napauttaa mikrofonia. Ilman lupaa puhekomento ei käynnisty, mutta muu sovellus toimii |
| `ACCESS_NETWORK_STATE` | `io.ionic.libs:iongeolocation-android` (tulee `@capacitor/geolocation`-riippuvuuden mukana; todennettu manifestiyhdistäjän raportista) | Ei | Ei ajonaikainen lupa; sovellus ei käytä sitä itse |
| `POST_NOTIFICATIONS`, `SCHEDULE_EXACT_ALARM`, `RECEIVE_BOOT_COMPLETED`, `WAKE_LOCK` | `@capacitor/local-notifications` | Vain muistutuksiin | Kysytään käyttäjän eleestä; Suunta toimii ilman |
| `fi.limitlesslife.manifestival.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION` | androidx.core | – | Signature-tasoinen, sovelluksen oma lupa; ei näy käyttäjälle |

**Sijaintilupia ei ole.** `@capacitor/geolocation` on yhä liitännäislistassa,
mutta koska APK ei julista sijaintilupia, natiivi sijaintihaku ei ole
käytettävissä. Seuraavat luvat kaatavat tarkastuksen: `ACCESS_BACKGROUND_LOCATION`,
`ACCESS_COARSE_LOCATION`, `ACCESS_FINE_LOCATION`, `FOREGROUND_SERVICE*`,
`CAMERA`, `MODIFY_AUDIO_SETTINGS`, `READ_EXTERNAL_STORAGE`, `READ_CONTACTS`.

**Pakettien näkyvyys:** manifestissa on
`<queries><intent><action android:name="android.speech.RecognitionService"/></intent></queries>`.
Ilman sitä Android 11+ piilottaa puheentunnistuspalvelun sovellukselta.

**Liitännäiset** (`assets/capacitor.plugins.json`) ovat täsmälleen
`@capacitor/app`, `@capacitor/geolocation` ja `@capacitor/local-notifications`.
Repon oma SpeechPlugin rekisteröidään käsin MainActivityssä, eikä se siksi
näy listassa.

**Avoimet komponentit:** vain MainActivity (käynnistin) ja androidx:n
ProfileInstallReceiver, joka on suojattu luvalla `android.permission.DUMP`
(vain adb/järjestelmä).

## JDK-kiinnitys

Capacitor 8 kääntää Java 21 -tasolla (`JavaVersion.VERSION_21`,
`android/app/capacitor.build.gradle`). JDK 17 kaatuu virheeseen
`invalid source release: 21`. Gradle-daemon on siksi kiinnitetty JDK 21:een
tiedostossa `android/gradle.properties`
(`org.gradle.java.home=C:/Program Files/Eclipse Adoptium/jdk-21.0.12.101-hotspot`).
Komentotulkin `JAVA_HOME` (Temurin 17) ei vaikuta daemoniin.

Polku on koneen oma, mutta silti versionhallinnassa. Vaihtoehdot ovat
omistajan tai kehityksen valinta:

- **(a)** Siirrä rivi tiedostoon `%USERPROFILE%\.gradle\gradle.properties`,
  eli repon ulkopuolelle kuten `android/local.properties`.
- **(b)** Korvaa rivi tiedostolla `android/gradle/gradle-daemon-jvm.properties`
  (`toolchainVersion=21`). Silloin Gradle valitsee minkä tahansa paikallisen
  JDK 21:n. Todenna ensin yhdellä paikallisella koonnilla.

Kunnes valinta on tehty, esitarkistus varmistaa, että hakemisto on olemassa.
Temurinin päivitys asentaa uuden hakemistonimen, jolloin kiinnitys on
päivitettävä. Tätä ei ole todennettu. Kiinnityscommit (a7f8cb3) puuttuu
aaltojen C–G ehdokkailta. Niistä rakennettaessa JDK annetaan valitsimella
`--jdk "C:/Program Files/Eclipse Adoptium/jdk-21.0.12.101-hotspot"`, ja
skripti välittää sen Gradlelle muodossa `-Dorg.gradle.java.home`.
