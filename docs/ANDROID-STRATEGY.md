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
| Puhekomento lukitulla puhelimella | 10 | Puheentunnistus vaatii etualalla olevan välilehden |

Jos nämä jäävät pois, tuotteesta jää jäljelle kalenteri. Natiivikerros ei siis
ole tekninen mieltymys vaan tuotevaatimus.

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
| Puheentunnistus | `@capacitor-community/speech-recognition` — natiivi |
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
| 6 | Natiivi puheentunnistus | PLANNED (WP12) |
| 7 | Allekirjoitettu release-AAB ja Play Store | PLANNED |

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
