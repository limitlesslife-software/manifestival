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
