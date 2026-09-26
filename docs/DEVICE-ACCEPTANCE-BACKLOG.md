# Laitehyväksynnän backlog

**Tila:** avoin. EI estä työpöytäaktivointia.

Kehitys on työpöytäensisijaista. Tämä on lista siitä, mitä **vain
oikealla laitteella** voi todentaa — ei siitä, mikä on rikki.

---

## Miksi tämä ei estä aktivointia

Manifestival on selainsovellus, ja Android on Capacitor-kuori saman
koodin ympärillä. Portit ovat samat molemmissa: sama
`src/data/schema.js`, sama repositoriokerros, sama RLS.

Työpöytäaktivointi todentaa siis koko datapolun. Laitekohtaista jää:
alustan omat rajapinnat, elinkaari ja verkon katkeaminen.

Jos laitteella löytyy vika, portti suljetaan ja se koskee molempia.
Sitä varten aktivointi tehdään aalloittain.

---

## Ennen laiteajoa

```
npm run sync:android
```

Se ajaa `build:web` ja synkronoi assetit. Vaatii Android SDK:n.
**Älä tee tätä ennen kuin aktivoitava koodi on lopullinen** — muuten
laitteella testataan eri koodia kuin tuotannossa.

---

## Tarkistettavat

### Istunto ja elinkaari

- [ ] Kirjautuminen laitteella
- [ ] Istunnon palautus sovelluksen uudelleenkäynnistyksessä
- [ ] Istunto säilyy taustalle siirryttäessä ja takaisin
- [ ] Tokenin uusiutuminen taustalla ei kadota näkymää
- [ ] Uloskirjautuminen tyhjentää datan
- [ ] **Tilinvaihto ei vuoda edellisen käyttäjän dataa**

Viimeinen on tärkein. Se on automaattitestattu, mutta laitteella
elinkaari on eri: prosessi voi jäädä henkiin taustalle tavalla, jota
selain ei tunne.

### Natiivi resume/pause (`src/platform/lifecycle.js`)

Työpöydällä testattu vain Capacitorin App-liitännäisen
kaksoiskappaleella (`tests/platform-lifecycle.test.mjs`). Sitä, laukeaako
oikea `resume`-tapahtuma oikeissa OS-tilanteissa, ei voi todentaa
selaimesta.

- [ ] Sovelluksen tuominen taustalta etualalle laukaisee NYT/MYÖHÄSSÄ-
      päivityksen ja muistutusten synkronoinnin **heti**, ei vasta
      30 sekunnin ajastimen kohdalla
- [ ] Sama toimii myös kun sovellus on ollut Doze-tilassa tai
      akunsäästössä pitkään taustalla
- [ ] `resume` ei laukea kahdesti samasta palaamisesta (ei
      kaksinkertaista synkronointia — vertaa `visibilitychange`-
      varajärjestelmän kanssa)
- [ ] Sovelluksen tappaminen kokonaan ja uudelleenavaus toimii kuin
      kylmäkäynnistys, ei kuin resume

### Aallottain

**A — muistutusasetukset, hyvinvointi**
- [ ] Asetukset tallentuvat ja säilyvät uudelleenkäynnistyksen yli
- [ ] **Sovelluksen asetus ≠ käyttöjärjestelmän lupa.** `enabled = true`
      ei tarkoita, että käyttäjä on antanut ilmoitusluvan. Tarkista,
      ettei sovellus lupaa ilmoituksia joita se ei voi näyttää
- [ ] Ilmoituslupapyyntö tulee vasta kun käyttäjä pyytää ilmoituksia
- [ ] Hyvinvointimerkintä tallentuu ja säilyy
- [ ] Osittainen merkintä pysyy osittaisena (tyhjä mittari ei saa
      muuttua arvoksi 1 — korjattu vika, jolla on regressiotesti)

**B — tavoitteet, projektit**
- [ ] CRUD toimii ja säilyy
- [ ] Tavoitteen ja projektin liitos toimii
- [ ] Tavoitteen poisto ei poista tehtäviä

**C — rutiinit**
- [ ] Rutiinin luonti ja toisto
- [ ] Poikkeus (skip/muutos) tallentuu
- [ ] **Päivärajan käytös:** rutiinin päivä ratkeaa laitteen
      aikavyöhykkeellä. Testaa keskiyön yli
- [ ] Aikavyöhykkeen vaihto ei monista eikä kadota päiviä

**D — talous**
- [ ] Lasku, toistuva kulu ja säästötavoite tallentuvat
- [ ] Summat ovat oikein sentteinä — ei pyöristysvirheitä
- [ ] Valuutta näkyy oikein

**E — AI-kirjausketju**
- [ ] Kirjaus syntyy AI-toiminnosta
- [ ] Kirjaus ei sisällä raakaa syötettä
- [ ] Vahvistamatonta suoritusta ei kirjata

### Verkko ja offline

- [ ] Toiminta ilman verkkoa: sovellus ei väitä tallentaneensa
- [ ] Yhteyden palautuminen
- [ ] Katkos kesken tallennuksen — ei hiljaista hukkaa eikä tuplariviä
- [ ] Lentokonetila päälle ja pois

### Capacitor

- [ ] Takaisin-painike
- [ ] Syvälinkit, jos käytössä
- [ ] Näppäimistö ei peitä syöttökenttiä
- [ ] Turva-alueet (lovi, alapalkki)
- [ ] Tumma tila
- [ ] Kierto

---

## Raportointi

Jos vika löytyy:

1. Merkitse muistiin: aalto, laite, Android-versio, toistoaskeleet
2. Arvioi koskeeko se myös selainta
3. Jos koskee dataa: sulje aallon portti ja deployaa
4. Jos on laitekohtainen: kirjaa tähän, älä sulje porttia turhaan

**Älä merkitse laiteriippuvaista hyväksyntää suljetuksi ilman fyysistä
todistetta.**

---

## APK on jäädytetty perustilaan (havainto 2026-09-08)

APK:n web-assetit ovat **oma kopionsa** repositoriossa:

```
android/app/src/main/assets/public/src/data/schema.js
```

Tiedosto **ei ole gitin seurannassa**: `android/.gitignore` listaa
`app/src/main/assets/public`, eikä hakemistossa ole yhtään seurattua
tiedostoa (`git ls-files android/app/src/main/assets/` on tyhjä).

Se on työpuun paikallinen kopio, jonka `npx cap sync android` kirjoittaa
`dist/`-hakemistosta. Tuoreessa kloonissa sitä ei ole lainkaan, ja
`tests/android.test.mjs` ohittaa vertailunsa silloin.

> Aiempi versio tästä dokumentista väitti tiedostojen olevan seurattuja.
> Se oli väärin. Tarkistus tehtiin komennolla
> `git ls-files ... && echo TRACKED`, ja `git ls-files` palauttaa nollan
> myös silloin kun se ei tulosta mitään -- ehto oli siis aina tosi.

### Mitä tämä tarkoittaa

**Web-deploy ei muuta APK:ta.** Aallot A–E avaavat portit selaimessa,
mutta laitteella asennettu sovellus jää perustilaan kunnes assetit
synkronoidaan ja APK käännetään uudelleen.

Se on hyvä asia junan aikana: mobiili ei voi rikkoutua web-aktivoinnin
takia, eikä kaksi julkaisukanavaa mene sekaisin.

### Androidia ei synkronoida junan aikana

Synkronointi ei tuota commitoitavaa muutosta -- assetit ovat
seuraamattomia -- mutta se ei hyödytä mitään junan aikana: APK
rakennetaan erikseen, ja välivaiheen synkronointi korvautuisi
seuraavassa.

`npx cap sync android` kirjoittaa lisäksi kaksi gradle-tiedostoa
uudelleen. Sisältö ei muutu, mutta rivinvaihdot vaihtuvat LF-muotoon ja
ne näkyvät hetken `git status`issa. Palauta ne komennolla
`git checkout -- android/`, jos et ole rakentamassa APK:ta.

**Aallot A–E eivät kosketa `android/`-hakemistoa.**

### Synkronointijärjestys aallon E jälkeen

```
1. npm run build:web            # kokoaa dist/, ei muunna eikä minifioi
2. npx cap sync android         # kopioi dist/ APK:n assetteihin
3. git status --porcelain android/   # vain gradle-rivinvaihdot, ei muuta
4. commit omana committinaan
5. cd android && gradlew.bat assembleDebug
6. laitehyväksyntä tämän dokumentin mukaan
```

Vaihe 3 on olennainen. Jos `cap sync` muuttaa muutakin kuin
`assets/public/`-sisältöä — gradle-tiedostoja, Capacitor-versioita,
manifestia — se on eri muutos ja kuuluu omaan pakettiinsa. Älä niputa
sitä porttien aktivointiin.

### Mitä laitteella pitää erikseen tarkistaa junan jälkeen

Nämä ovat asioita, joita selainhyväksyntä ei kata:

- [ ] Portit ovat APK:ssa oikeassa tilassa (asetusnäkymä ei enää sano,
      ettei tieto säily)
- [ ] Tallennus toimii mobiiliverkossa, ei vain WiFissä
- [ ] Sovelluksen taustalle siirtyminen ja palaaminen ei kadota
      tallentamatonta syötettä
- [ ] Istunto säilyy sovelluksen uudelleenkäynnistyksen yli
- [ ] Paikalliset ilmoitukset toimivat aallon A asetuksilla
      (`@capacitor/local-notifications`)
- [ ] Offline: sovellus avautuu ja kertoo rehellisesti ettei verkkoa ole

---

## Tavoitesuunnittelu (Goal-to-Action)

**Tila: RAKENNETTU PAIKALLISESTI. EI DEPLOYATTU. EI MIGROITU.**

Nämä vaativat oikean laitteen eikä niitä voi todentaa paikallisesti.

### Puhesyöte suunnitteluun

Puhe muuttuu tekstiksi `src/app/voice.js`:ssä ja tulee samaan
`requestPlan`-funktioon. Polku on sama kuin tekstillä, mutta
**litterointi laitteella on todentamatta**:

- [ ] Puhu tavoite ääneen → litterointi päätyy suunnittelukenttään
- [ ] Pitkä puhe (yli 30 s) ei katkea kesken
- [ ] Suomenkieliset numerot ("kymmenentuhatta") tulkitaan oikein

### Mobiilirakenne

- [ ] Kolme osiota (Tavoitteet / Projektit / Suunnittelu) mahtuvat
      yhdelle riville kapealla puhelimella
- [ ] Tavoitteen yksityiskohdat korvaavat listan, eivät avaudu sen
      viereen
- [ ] "Takaisin tavoitteisiin" on tavoitettavissa peukalolla
- [ ] Ehdotuksen tarkistuslista on selattavissa ilman vaakavieritystä
- [ ] Välitavoitteen siirtonuolet (↑ ↓) ovat tarpeeksi suuria
      kosketukselle

### Suunnittelun kesto

Palvelinpuolen aikakatkaisu on 45 s. Se on pidempi kuin muilla
päätepisteillä, koska suunnittelu tuottaa rakenteen eikä yhtä oliota.

- [ ] Suunnittelu valmistuu mobiiliverkossa ennen aikakatkaisua
- [ ] "Suunnitellaan…" näkyy koko odotuksen ajan
- [ ] Verkkokatkos kesken suunnittelun ei jätä painiketta jumiin

### Automaatiotaso

Taso on **laitekohtainen** kunnes migraatio 0010 on ajettu.

- [ ] Tason valinta säilyy sovelluksen uudelleenkäynnistyksen yli
- [ ] Uusi laite alkaa tasolta 1
- [ ] Tason 4 varoitusteksti näkyy kokonaan puhelimen leveydellä

### Ilmoitukset ja tausta

- [ ] Suunnitelman muutosehdotus ei tuota ilmoitusta ilman käyttäjän
      pyyntöä
- [ ] Sovelluksen taustalle siirtyminen kesken ehdotuksen tarkistuksen
      ei hukkaa ehdotusta istunnon sisällä
- [ ] Sovelluksen sulkeminen **hukkaa** ehdotuksen — ja se on
      tarkoitus. Tarkista että käyttäjälle ei jää vaikutelmaa, että se
      olisi tallessa.

---

# Henkilökohtainen avustaja — laitehyväksyntä

**Tila: AVOIN. Ei ole ajettu laitteella, eikä yhtäkään kohtaa saa
merkitä hyväksytyksi ennen ajoa.**

Tämä osio on pidempi kuin muut, ja syy on yksi: avustaja lupaa
ajoituksia, ja ajoitus on juuri se asia jonka selain tekee eri tavalla
kuin puhelin.

---

## ⚠ Neljä asiaa, joita EI VOI todentaa selaimessa

Nämä eivät ole "pitäisi vielä testata" -kohtia. Ne ovat kohtia, joissa
selaimen ja puhelimen käyttäytyminen **eroaa rakenteellisesti**.

### 1. Taustaherätys — sitä ei ole

Muistutukset lasketaan, kun sovellus on auki: kirjautumisen jälkeen ja
30 sekunnin välein. Suljetusta sovelluksesta tulevaa hälytystä **ei ole
toteutettu**, eikä sitä luvata käyttöliittymässä.

Laitteella on todennettava, ettei käyttäjä silti oleta toisin:

- [ ] Muistutusnäkymän rivi "Muistutukset lasketaan, kun sovellus on
      auki" näkyy kokonaan puhelimen leveydellä
- [ ] Rivi näkyy myös silloin kun muistutuksia ei ole yhtään
- [ ] Sovelluksen sulkeminen ja avaaminen tunnin päästä näyttää
      erääntyneen muistutuksen — **avaamisen jälkeen**, ei ennen
- [ ] Yhtään ilmoitusta EI tule suljettuun sovellukseen

Viimeinen on se, joka on tarkistettava. Jos ilmoituksia tulisi, ne
tulisivat migraatiosta 0005 (`notification_preferences`) eivätkä tästä
paketista — ja silloin kaksi järjestelmää lupaisi samaa asiaa.

### 2. Puheentunnistus — tuki vaihtelee alustoittain

`src/app/speechInput.js` ja `src/app/voice.js` käyttävät alustasovitinta
`src/platform/speech.js`: selaimessa `SpeechRecognition`-rajapintaa,
Android-sovelluksessa omaa `ManifestivalSpeech`-liitännäistä
(`SpeechPlugin.java`, järjestelmän `SpeechRecognizer`). WebView'n omaa
tunnistinta ei käytetä Android-sovelluksessa lainkaan: Capacitor hylkäisi
sen mikrofonipyynnön.

- [ ] Mikrofonipainike **piilotetaan**, jos tunnistusta ei ole
      (`speechAvailable()` palauttaa epätoden)
- [ ] Mikrofoniluvan kysyminen toimii ja luvan epääminen antaa
      luettavan virheilmoituksen
- [ ] Luvan epääminen EI riko kirjauskenttää — tekstillä pääsee yhä
      eteenpäin
- [ ] Sanelu suomeksi tuottaa tekstin kenttään
- [ ] Teksti näkyy kentässä **ennen** kuin mitään lähetetään
- [ ] Hiljaisuus tuottaa "En kuullut mitään" eikä jää roikkumaan
- [ ] Sovelluksen siirtäminen taustalle kesken kuuntelun ei jätä
      mikrofonia päälle
- [ ] Aikakatkaisu (15 s) laukeaa, jos `onend` ei tule lainkaan

Viimeinen on nimenomaan WebView-ongelma: osa alustoista ei laukaise
`onend`-tapahtumaa, ja ilman aikakatkaisua mikrofonipainike jäisi
ikuisesti aktiiviseksi. Aikaraja on nyt yhteinen (`speech.js`) ja koskee
myös puhepaneelia ja natiivia liitännäistä.

**Ääntä ei tallenneta.** Sitä ei voi todentaa käyttöliittymästä, mutta
sen voi todentaa lähdekoodista — ja `tests/assistant-ui.test.mjs` tekee
sen jokaisella ajolla.

### 3. Sijaintilupa — sääntö on olemassa, geoaita ei

Paikkamuistutus on **sääntö, ei toteutus**. Sääntö voidaan kirjata,
nähdä ja kytkeä päälle, mutta mikään ei seuraa sijaintia. Android-sovellus
ei julista sijaintilupaa lainkaan (`NATIVE_LOCATION_ENABLED = false`).

- [ ] Uusi sääntö on listassa **Pois päältä**
- [ ] "Kytke päälle" avaa vahvistusdialogin, jonka teksti sanoo
      paikkamuistutusten **eivät vielä laukea** eikä sovellus seuraa sijaintia
- [ ] Päälle kytketyn säännön merkintä on "Päällä — ei vielä laukea"
- [ ] Kytkeminen ei avaa järjestelmän sijaintilupadialogia
- [ ] Dialogin teksti mahtuu puhelimen leveydelle
- [ ] Peruutus jättää säännön pois päältä
- [ ] Hyväksyntä kytkee säännön päälle ja tila säilyy latauksen yli
- [ ] "Kytke pois" **ei** kysy mitään
- [ ] Päälle kytketty sääntö EI tuota ilmoituksia — koska seurantaa ei
      ole

Viimeinen on se, joka on helpoin ymmärtää väärin. Kytkin ei valehtele:
se kirjaa käyttäjän aikeen. Jos laitteella syntyy vaikutelma, että
sovellus alkaa seurata sijaintia, teksti on korjattava.

### 4. Kellonaika, aikavyöhyke ja kesäaika

Kaikki muistutus- ja lähtöaikalaskenta on **päivä + minuutit**, ei
aikaleima. Se on tietoinen valinta: aikaleima siirtäisi suomalaisen
aamun edelliselle päivälle UTC:ssä.

Laitteella on todennettava, että laitteen kello ja vyöhyke eivät riko
sitä:

- [ ] Muistutus klo 09:00 hälyttää klo 09:00 laitteen paikallista aikaa
- [ ] Aikavyöhykkeen vaihto laitteen asetuksista ei siirrä olemassa
      olevien muistutusten kellonaikoja
- [ ] Keskiyön yli menevä torkku siirtää päivää oikein
- [ ] Kesäajan vaihtopäivä ei kadota eikä kahdenna muistutusta

---

## Kirjaus ja saapuvat

- [ ] Kirjauskenttä on käytettävissä yhdellä peukalolla
- [ ] Näppäimistön avautuminen ei peitä Kirjaa-painiketta
- [ ] Enter kirjaa
- [ ] Pitkä teksti (yli 1000 merkkiä) katkaistaan eikä hylätä
- [ ] Kirjaus onnistuu **ilman verkkoa** — rivi menee saapuviin
- [ ] Verkoton kirjaus kertoo, ettei tulkinta onnistunut
- [ ] Tulkinta ei kaada kirjausta: rivi on saapuvissa joka tapauksessa
- [ ] Tulkinnan tarkistuskortti mahtuu näytölle ilman vaakavieritystä
- [ ] "Luo" luo rivin ja merkitsee saapuvan muunnetuksi
- [ ] **"Luo" kahdesti nopeasti luo VAIN YHDEN rivin**
- [ ] Hylätty rivi voidaan palauttaa
- [ ] Muunnetulle riville ei tarjota palautusta

Toiseksi viimeinen on tärkein. Puhelimella kaksoisnapautus on
tavallista, ei virhe.

## Muistutukset

- [ ] Tehtävän ajan muokkaus synkronoi laitteen ajastetun ilmoituksen
      uudelleen n. 2 sekunnin kuluttua (`scheduleNotificationResync`) —
      vanha kellonaika ei enää herätä
- [ ] Tehtävän poisto perii laitteelta ajastetun ilmoituksen samassa
      ikkunassa
- [ ] Useita nopeita muokkauksia peräkkäin ei ajasta useaa
      päällekkäistä synkronointia laitteelle
- [ ] Muistutuksen luonti ilman tehtävää toimii
- [ ] Muistutuksen liittäminen tehtävään toimii
- [ ] Torkkupainikkeet (+5 / +15 / +30 / +60) ovat erotettavissa
      toisistaan peukalolla
- [ ] Torkutus siirtää muistutusta — **tehtävän päivämäärä ei muutu**
- [ ] Tehtävän poisto peruu sen muistutuksen näkyvästi
- [ ] Peruttu muistutus näkyy listassa, ei katoa

## Matka ja lähtöaika

- [ ] Matka ilman kestoa näyttää **kentän** eikä kellonaikaa
- [ ] Keston kirjaaminen listasta päivittää lähtöajan heti
- [ ] Lähtöajan erittely (matka + valmistautuminen + pysäköinti) mahtuu
      riville
- [ ] Myöhässä oleva lähtö näkyy punaisena ja sanoo "myöhässä"
- [ ] Numerokenttä avaa numeronäppäimistön

## Ilmoituskeskus

- [ ] Avattava lohko avautuu ja sulkeutuu kosketuksella
- [ ] Lukumäärämerkki näkyy suljettunakin
- [ ] Toimintopainikkeet mahtuvat riville kääntymättä päällekkäin
- [ ] "Avaa" vie oikeaan osioon

## Verkon palautuminen ja taustalta paluu (src/app/reconnect.js)

Deterministisesti testattu ilman oikeaa verkkoa tai ajastimia
(`tests/reconnect.test.mjs`). Laitteella jää: oikea radion tilan
vaihtuminen, oikea taustalle jääminen ja niiden yhteisvaikutus.

- [P0] Lentotila päälle ja pois palauttaa datan ja poistaa
      offline-bannerin **kerran**, ei useaan kertaan peräkkäin
- [P0] Heikko/katkeileva verkko (wifi-tuen reunalla) ei laukaise
      useaa rinnakkaista täyttä latausta
- [P1] Sovelluksen tuominen taustalta etualalle SAMAAN AIKAAN kuin
      verkko palautuu ei tuota kahta rinnakkaista latausta
      (`reconnect.isRefreshing()` on ollut väärässä tilassa yksikkö-
      testien ulkopuolella aiemminkin natiivikuorissa)
- [P1] Uloskirjautuminen kesken odottavan verkon-palautuksen debouncen
      ei kirjoita mitään edellisen käyttäjän näytölle

## AI-komennot (src/app/commandBar.js, haun komentopainike)

Putki lauseesta suoritukseen on yksikkötestattu injektoiduilla
vahvistus-/valintafunktioilla (`tests/command-bar.test.mjs`). Laitteella
jää: oikea dialogi, oikea kosketus, oikea /api/command-verkkokutsu.

- [P0] Tuhoisa komento ("poista X") näyttää AINA vahvistusdialogin
      ennen suoritusta — ei koskaan suoraan
- [P0] Epäselvä kohde näyttää valintalistan, ei arvaa ensimmäistä
- [P1] Komentopainike hakupaneelissa näkyy vain kun kentässä on
      tekstiä, eikä laukea automaattisesti kirjoittaessa
- [P1] Verkkovirhe komentoa luokitellessa näyttää virheen, ei jää
      pyörimään loputtomiin
- [P2] Komennon suomenkielinen tulkinta on käytännössä riittävän
      tarkka yleisimmille lauseille (tuotelaatuasia, ei turva-asia)
- Puheohjattu komento on toteutettu (MEGA BUILD III) samalla putkella;
  laitehyväksyntä on osiossa "MEGA BUILD III" alla.

## Tilin poiston esikatselu (src/app/views/profile.js)

- [P1] "Näytä mitä poistettaisiin" näyttää oikeat rivimäärät laitteen
      omasta, jo ladatusta tilasta
- [P2] "Poista tili pysyvästi" -painike pysyy pois päältä ja selittää
      miksi (`ACCOUNT_DELETION.endpointEnabled = false`) — **tätä ei pidä
      koskaan merkitä hyväksytyksi ennen kuin Edge Function on deployattu ja
      kontrolloitu oikea poisto on tehty testitilillä.** Ks. "MEGA BUILD III".

---

## MEGA BUILD III — laitehyväksyntä (EI SUORITETTU)

Kaikki alla oleva on koodattu ja testattu paikallisesti (selain-/mock-ympäristö,
`node --test`). **Mitään ei ole ajettu fyysisellä laitteella, ADB:llä eikä
tuotannossa.** Yhtäkään kohtaa ei saa merkitä hyväksytyksi ilman laiteajoa.

### Puhekomennot (P0)

- [P0] Mikrofonilupa pyydetään vasta kun käyttäjä avaa puhepaneelin; luvan
      epäys näyttää selityksen ja "Kirjoita sen sijaan" -tilan
- [P0] Puhuttu luontikomento ("lisää tehtävä pestä auto huomenna") näyttää
      tunnistetun tekstin muokattavana, sitten vahvistuksen esikatselun;
      mitään ei tallenneta ennen vahvistusta
- [P0] Puhuttu muutoskomento ("siirrä auton pesu perjantaille") näyttää
      "nykyinen → uusi" ja vaatii vahvistuksen
- [P0] Epäselvä kohde (kaksi samannimistä) näyttää valintalistan
- [P0] Peruutus jokaisessa vaiheessa (kuuntelu, teksti, vahvistus) ei muuta dataa
- [P0] Sovelluksen vienti taustalle / näytön sammutus kuuntelun aikana
      sammuttaa mikrofonin (Android-järjestelmän mikrofoni-ilmaisin sammuu)
- [P0] Puhelu / toinen ääntä käyttävä sovellus keskeyttää kuuntelun siististi
- [P1] "Etsi kaikki rengastilaukseen liittyvät tehtävät" avaa haun sanalla
      "rengastilaukseen" (ei virhettä)
- [P1] Tunnistuksen virhe ("ei puhetta", verkkovirhe) näyttää selkeän viestin
      ja uudelleenyritys toimii; fokus palaa avaajapainikkeeseen suljettaessa
- [P2] Suomen kielen tunnistuslaatu (`fi-FI`) arkilauseilla riittää

### Puhe Android-sovelluksessa: ManifestivalSpeech-liitännäinen (P0, EI SUORITETTU)

Liitännäinen on käännetty (`gradlew compileDebugJavaWithJavac`) mutta sitä
ei ole ajettu puhelimessa. Asenna tuore debug-APK (`npm run build:android`).

- [P0] Tuore asennus: sovelluksen käynnistys **ei** avaa mikrofonilupadialogia;
      Asetukset → Sovellukset → Manifestival → Käyttöoikeudet näyttää
      mikrofonin tilassa "ei sallittu / kysy"
- [P0] Kultainen mikrofoni → paneeli "Käynnistetään mikrofonia…" ja
      järjestelmän lupadialogi. **Salli** → "Kuuntelen…" → sano "lisää tehtävä
      pestä auto huomenna" → teksti näkyy muokattavana
- [P0] **Estä** (ensimmäinen kerta) → viesti "Mikrofonin käyttöä ei sallittu";
      ei "Yritä uudelleen" -painiketta; "Kirjoita sen sijaan" toimii; uusi
      napautus kysyy luvan uudelleen
- [P0] **Estä pysyvästi** (toinen kielto / "älä kysy uudelleen") → viesti
      polusta Asetukset → Sovellukset → Manifestival → Käyttöoikeudet →
      Mikrofoni ja painike **"Avaa asetukset"**, joka avaa sovelluksen
      järjestelmäasetukset; luvan salliminen ja paluu → uusi napautus toimii
- [P0] Kuuntelun aikana Koti-painike / sovelluksen vaihto → Androidin
      mikrofoni-ilmaisin (vihreä piste) **sammuu** heti; palatessa paneeli on
      suljettu eikä myöhäistä tekstiä ilmesty
- [P0] Lupadialogin aikana Koti-painike → palatessa ja sallittaessa mikrofoni
      **ei** aukea itsestään (odotus perutaan `onStop`issa)
- [P0] Kirjauspalkin sanelu: napautus aloittaa, toinen napautus lopettaa ilman
      virheilmoitusta; mikrofoni-ilmaisin sammuu
- [P1] Hiljaisuus 15 s → "Kuuntelu keskeytyi" tai "En kuullut mitään";
      mikrofoni-ilmaisin sammuu
- [P1] Lentotila → selkeä verkkoviesti (järjestelmän tunnistin tarvitsee
      yleensä verkon), ei jumia
- [P1] Laite ilman Googlen tunnistinta (tai se poistettu käytöstä) →
      "Puheentunnistus ei ole käytettävissä…", mikrofoni ei jää auki
- [P1] Tietosuoja: mikään kohta sovelluksessa ei väitä äänen käsittelyn
      tapahtuvan laitteella; Play-kaupan tietoturvalomake kertoo, että
      järjestelmän tunnistin (yleensä Google) käsittelee äänen

### Sijainti (P1)

**Android: EI SOVELLU.** Android-sovellus ei julista sijaintilupaa
(`NATIVE_LOCATION_ENABLED = false`, 26.9.2026), koska mikään toteutettu
ominaisuus ei käytä sijaintia: matka-aika on aina käyttäjän antama. Profiili
näyttää vain syyn, ei "Salli sijainti" -painiketta. Alla olevat kohdat
koskevat **selainta (PWA)**, jossa kertahaku on Profiilin diagnostiikka.

- [P0] Android: Asetukset → Sovellukset → Manifestival → Käyttöoikeudet
      **ei listaa sijaintia lainkaan**; `aapt2 dump permissions` ei näytä
      `ACCESS_*_LOCATION`-lupia eikä `aapt2 dump badging` pakollista
      `android.hardware.location`-ominaisuutta
- [P1] Selain: sijaintilupa pyydetään vasta kun käyttäjä painaa Profiilissa
      "Salli sijainti"; ei käynnistyksessä
- [P1] Selain: lupa evätty → selitys; matka-aika toimii yhä käyttäjän antamana
- [P1] Selain: lupa evätty pysyvästi (`blocked`) → ohjaus selaimen
      asetuksiin, ei toistuvaa kysymistä
- [P1] Selain: kertahaku onnistuu ja näyttää vain tarkkuuden
- [P0] **Koordinaatteja ei löydy** localStoragesta, IndexedDB:stä, lokeista,
      viennistä eikä tilin inventaarioista (tarkista selaimen/WebView:n
      tallennus etätarkastajalla)
- [P0] Asetuksissa/luvissa **ei ole taustasijaintia**

### Lähtöaika ja ilmoitukset (P1)

- [P1] Matka, jolla käyttäjän antama kesto → lähtöaika oikein; ilman kestoa
      ei lähtöaikaa eikä ilmoitusta
- [P1] Lähtöilmoitus (10 min ennen) saapuu ajallaan: sovellus auki, taustalla,
      tapettuna, näyttö lukittuna, Doze-tilassa
- [P1] Ilmoitus säilyy / ajastuu uudelleen laitteen uudelleenkäynnistyksen jälkeen
- [P1] Lähtöajan muutos (kesto tai tehtävän aika muuttuu) siirtää ilmoituksen
      eikä jätä vanhaa
- [P1] Yön yli -matka, kesäajan vaihtuminen ja aikavyöhykkeen vaihto antavat
      oikean lähtöhetken
- [P1] Lähtöilmoitus saapuu hiljaisten tuntien aikana (omistajan päätös: kyllä)
- [P2] Ilmoituskanavan asetukset (ääni/värinä) noudattavat käyttäjän valintoja

### Offline-kirjausjono (P1)

- [P0] Lentotila: tehtävän lisäys näkyy heti listassa merkittynä "odottaa
      synkronointia"; ei häviä sovelluksen uudelleenkäynnistyksessä
- [P0] Yhteyden palautuessa jono toistuu **kerran** (ei tuplia), merkintä poistuu
- [P0] Tehtävän muokkaus offline + sama tehtävä muokattu toisella laitteella →
      ristiriita ratkeaa ilman datan häviämistä (kenttäkohtainen yhdistäminen)
- [P0] Uloskirjautuminen / käyttäjän vaihto: edellisen käyttäjän jono ei
      näy eikä toistu toiselle käyttäjälle
- [P1] Heikko/katkeileva verkko ei tuota rinnakkaisia toistoja
- [P1] Jonoon **ei** päädy poistoja, taloutta, AI-komentoja eikä tilin toimintoja
      (offline-tilassa niiden painikkeet kertovat miksi ne ovat pois päältä)
- [P2] Suuri jono (50+) toistuu ilman jäätymistä

### Tilin poisto (P0/P2)

- [P0] Esikatselu (kuiva-ajo) näyttää oikeat rivimäärät ja **ei poista mitään**
- [P0] Vahvistus vaatii sähköpostin ja lauseen; väärä syöte estää painikkeen
- [P0] Poistopainike on pois käytöstä niin kauan kuin `endpointEnabled = false`
- [ ] **Vasta omistajan päätöksellä, testitilillä:** kontrolloitu oikea poisto
      (deploy → kuiva-ajo → poisto → kirjautuminen epäonnistuu → tiedot poissa)
      — EI SUORITETTU, EI SAA SUORITTAA tuotantotilillä

### Kesto ja ympäristö (P2)

- [P2] Sovellus tapettu / Doze / uudelleenkäynnistys / kesäaika / aikavyöhyke
      edellä oleville virroille (ks. ilmoitukset ja jono)
- [P2] Puhe- ja jonopolut TalkBackilla: fokus, live-alueet, kosketuskohteet ≥ 48 dp
- [P2] Puhepaneelin avaus ja tilanvaihdot pitkällä listalla ilman kuroutumista

---

## Suorituskyky laitteella

Hälytyskierros ajetaan **30 sekunnin välein** niin kauan kuin sovellus
on auki. Se on ainoa tämän paketin koodi, joka ajetaan toistuvasti
ilman käyttäjän tekoa.

- [ ] Sadan muistutuksen ja sadan tehtävän kierros ei näy viiveenä
      käyttöliittymässä
- [ ] Sovellus tunnin taustalla ei kuluta akkua havaittavasti
- [ ] Kierros ei estä vieritystä

Kasvun muoto on testattu deterministisesti
(`tests/assistant-performance.test.mjs`), mutta akku on laiteasia.

---

## Suunta (Life Alignment) — EI SUORITETTU

Näkymä on renderöity paikallisesti headless-Chromessa 390–500 px
leveydellä (ei ylivuotoa, seitsemän välilehteä mahtuu). **Fyysisellä
laitteella ei ole ajettu mitään.** Migraatio 0012 ajamatta: tieto elää
istunnon muistissa, ja näkymä kertoo sen.

- [P1] Elämänalueiden ensikäyttö: ehdotuspainikkeet esitäyttävät lomakkeen
      eivätkä luo mitään; oma nimi, tärkeys ja tavoite tallentuvat
- [P1] Kapasiteetin muokkaus numeronäppäimistöllä (desimaalipilkku "2,5"
      toimii); yli 60 h näyttää varoituksen
- [P1] Viikkokatsaus mobiilissa: seitsemän kysymystä, pohdinta ja
      ehdotukset vierivät; tallennus ei hyppää alkuun
- [P1] Havaintojen luettavuus: vakavuus näkyy SANANA myös ilman värejä
      (harmaasävy/värisokeus); "Miksi tämä näkyy?" avautuu kosketuksella
- [P1] Suunniteltu vs. kapasiteetti -palkki ja aluepalkit: TalkBack lukee
      tekstivastineen (role="img" + aria-label)
- [P1] Muutosehdotus: "Tee muutos…" avaa vahvistuksen; peruutus ei muuta
      mitään; kaksoisnapautus ei toteuta kahdesti
- [P2] Offline/uudelleenyhteys: Suunnan kirjoitukset EIVÄT mene
      offline-jonoon (ne vaativat verkon ja vahvistuksen); virhe näkyy
- [P2] Näppäimistö (Bluetooth/Chromebook): välilehdet nuolilla, lomakkeet
      Tabilla, Esc sulkee aluelomakkeen
- [P2] Turva-alueet (lovi, eleriba): Suunta-otsikko ja välilehtipalkki
      eivät jää peittoon
- [P2] Vaakasuunta: pitkät aluenimet rivittyvät, ei ylivuotoa
- [P2] Päiväkortti Tänään-näkymässä: yksi havainto, ei kaavioita,
      "Avaa Suunta" vie oikeaan välilehteen

---

## Suunta 2: ajastin, kirjaus, energia, katsaus v2 — EI SUORITETTU

Paikallisesti todennettu: yksikkö- ja integraatiotestit sekä
headless-Chromen E2E (`npm run e2e:suunta`, 412 px ja 360 px). **Fyysisellä
laitteella ei ole ajettu mitään.** Migraatiot 0012 ja 0013 ajamatta:
ajastin säilyy laitteen localStoragessa (käyttäjäkohtainen avain), muu
Suunnan tieto elää istunnon muistissa.

Ajastimen kesto lasketaan aikaleimoista. Taustasuoritusta EI ole eikä
sitä väitetä: laitteella todennetaan, että **näyttö** on oikein paluun
jälkeen, ei että jokin laskisi taustalla.

### P0

- [P0] Ajastin: käynnistä → sovellus taustalle 10 min → takaisin:
      palkki näyttää ~10 min lisää, tila "Käynnissä"
- [P0] Ajastin näyttö lukittuna 30 min → avaus: kulunut aika oikein,
      pysäytys kirjaa oikean määrän
- [P0] Ajastin + sovelluksen sulku (swipe pois) → avaus: ajastin palaa
      (localStorage), pysäytys kirjaa koko ajan
- [P0] Ajastin keskiyön yli (esim. 23.40 → 00.20): kaksi kirjausta
      oikeille päiville; sunnuntai → maanantai menee eri viikoille
- [P0] Ajastin offline: lentotila → pysäytä → "tallennetaan, kun yhteys
      palaa" (vain kun 0013 on ajettu ja portti auki); yhteys takaisin →
      yksi kirjaus, ei kahta
- [P0] Nopea kirjaus: +15/+30/+1 h yhdellä napautuksella; kaksoisnapautus
      ei tuota kahta kirjausta
- [P0] Tehtävän valmistuminen: "Kirjataanko tähän käytetty aika?" —
      "Arvio … hyväksyn arvion toteumaksi" näkyy vain kun arvio on;
      "Ohita" ei kirjaa mitään; "Älä kysy" pitää

### P1

- [P1] Energiakentät (tehtävä, rutiini, projekti) ja kuormittavan ajan
      raja: numeronäppäimistö, desimaalipilkku, tyhjä = ei asetettu
- [P1] Suunta vierii mobiilissa: pikatoiminnot, arviointi, kohdistus,
      katsaus v2, esikatselu ja kehitys — ei vaakavieritystä
- [P1] Viikkokatsaus v2: viisi pohdintakysymystä, tallennus ei hyppää
      alkuun, näppäimistö ei peitä aktiivista kenttää
- [P1] Ensi viikon esikatselu → "Vahvista valitut muutokset…" → dialogi
      luettelee jokaisen muutoksen; peruutus ei muuta mitään
- [P1] Pitkät elämänalueiden nimet (60 merkkiä) ajastinpalkissa,
      havainnoissa ja taulukoissa rivittyvät
- [P1] Turva-alue: ajastinpalkki ei jää loven/tilarivin alle
      (env(safe-area-inset-top))
- [P1] TalkBack: ajastinpalkin tila luetaan sanoina ("Käynnissä",
      "Kulunut 1 h 5 min"); painikkeilla on nimet; dialogin fokus

### P2

- [P2] Ajastin kesäajan vaihdon yli (lokakuun viimeinen sunnuntai):
      kesto seinäkellon mukaan oikein (3 h, ei 2 h)
- [P2] Aikavyöhykkeen vaihto ajastimen ollessa käynnissä (matka): kesto
      ei muutu; päivä tulee pysäytyshetken vyöhykkeestä
- [P2] Tumma/vaalea tila: ajastinpalkin kontrasti, Tauolla-tilan väri
- [P2] Ilmoituksia ei käytetä ajastimessa eikä päivän havainnoissa:
      mitään ei ilmoiteta taustalla
- [P2] Tekoälyselitys: ilman verkkoa "Selitä tarkemmin" näyttää
      deterministisen selityksen eikä jumiudu

---

## Muistutus siitä, mitä nämä ovat

> **Yhtäkään tämän osion kohtaa ei saa merkitä hyväksytyksi ilman
> laiteajoa.** Merkitty ruutu on väite, ja väärä väite
> hyväksyntälistassa on pahempi kuin tyhjä ruutu.
