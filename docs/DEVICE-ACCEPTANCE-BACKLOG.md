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
