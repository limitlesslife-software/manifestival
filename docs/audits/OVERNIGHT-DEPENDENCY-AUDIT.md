# Riippuvuusauditointi

`npm audit --force` **ei ajettu** eikä pidä ajaa. Perustelu alla.

## Tulos

**3 kohtalaista (moderate) haavoittuvuutta, kaikki samasta ketjusta.**

```
@capacitor/cli  (devDependency)
  └─ xcode
       └─ uuid  < 11.1.1
```

| | |
|---|---|
| Haavoittuvuus | `uuid`: puuttuva puskurin rajatarkistus v3/v5/v6:ssa, kun `buf` annetaan |
| Advisory | GHSA-w5hq-g745-h8pq |
| Vakavuus (ilmoitettu) | moderate |
| **Käytännön vakavuus tässä** | **olematon** |

## Miksi käytännön riski on olematon

**1. Kehitysriippuvuus.** `@capacitor/cli` on koontityökalu. Se ei päädy
APK:hon eikä selaimeen. Ajettava tuote ei sisällä tätä koodia lainkaan.

**2. Koodipolkua ei ole olemassa.** `xcode` on iOS-projektitiedostojen
käsittelykirjasto. Projektissa **ei ole `ios/`-hakemistoa** — vain
`android/`. Capacitorin CLI ei kutsu `xcode`-kirjastoa, koska iOS-alustaa
ei ole lisätty. Haavoittuva funktio ei ole tavoitettavissa millään
komennolla, jota tämä projekti ajaa.

**3. Ei epäluotettavaa syötettä.** Haavoittuvuus vaatii, että kutsuja
antaa `uuid`:n v3/v5/v6-funktiolle liian pienen puskurin. Sitä ei tapahdu
CLI:n normaalikäytössä, eikä käyttäjän syöte pääse lähellekään.

## Miksi korjausta EI tehdä

`npm audit fix --force` asentaisi **`@capacitor/cli@8.4.3`** — eli
**vanhemman** version kuin nykyinen 8.5.1. npm itse merkitsee sen
rikkovaksi muutokseksi.

Se olisi selvästi huonompi lopputulos:

- CLI ajautuisi eri versioon kuin `@capacitor/core@8.5.1` ja
  `@capacitor/android@8.5.0`
- Versioero Capacitorin osien välillä on tunnettu koontivirheiden lähde
- Vaihdossa menetettäisiin 8.5-sarjan korjaukset
- Vastineeksi suljettaisiin koodipolku, jota ei ajeta

**Päätös: ei korjata. Odotetaan, että Capacitor päivittää `xcode`-riippuvuutensa.**

Uudelleenarvioinnin ehdot — kumpi tahansa riittää:

1. Projektiin lisätään `ios/`-alusta (silloin `xcode` alkaa oikeasti ajaa)
2. Capacitor julkaisee 8.5-sarjaan version, jossa ketju on korjattu
   ilman alaspäin siirtymistä

## Riippuvuudet kokonaisuudessaan

| Paketti | Versio | Tyyppi | Päätyy tuotteeseen |
|---|---|---|---|
| `@capacitor/core` | 8.5.1 | runtime | kyllä (APK) |
| `@capacitor/android` | 8.5.0 | runtime | kyllä (APK) |
| `@capacitor/local-notifications` | 8.3.1 | runtime | kyllä (APK) |
| `@capacitor/cli` | 8.5.1 | dev | ei |

**Neljä riippuvuutta.** Ei kehystä, ei koontityökalua, ei
testikirjastoa. Web-sovelluksella ei ole ajonaikaisia npm-riippuvuuksia
lainkaan: Supabase ladataan CDN:ltä ja testit ajetaan Noden omalla
ajurilla.

Tämä on itsessään turvallisuusominaisuus. Hyökkäyspinta
toimitusketjussa on niin pieni kuin se voi olla ilman, että Capacitorista
luovutaan.

`npm ls --depth=0` on ristiriidaton: lukkotiedosto ja `package.json`
vastaavat toisiaan, eikä kelluvia versioita ole.

## Työkaluketju

| | Versio | Huomio |
|---|---|---|
| Node | 24.19.0 | Testiajuri `node --test` |
| npm | 11.17.0 | |
| Gradle | 9.1.0 | Wrapperissa, versionhallinnassa |
| JDK | Android Studion JBR | **Ei koneen oletus** |

Gradle-koonti vaatii Android Studion mukana tulevan JDK:n:

```
JAVA_HOME="/c/Program Files/Android/Android Studio/jbr" ./gradlew assembleRelease
```

Ilman tätä koonti kaatuu koneen oletus-JDK:hon. Wrapper on
versionhallinnassa, joten Gradlen versio ei riipu kehittäjän koneesta —
JDK riippuu, ja se on tämän ketjun ainoa kone­kohtainen osa.

## Android-riippuvuudet

Ei erillistä Android-riippuvuusauditointia. `@capacitor/local-notifications`
tuo AndroidX-kirjastot Gradlen kautta, eikä käytettävissä ole työkalua,
joka tarkistaisi ne turvallisesti ilman verkkoyhteyttä koontipalvelimiin.
**DEFERRED.**
