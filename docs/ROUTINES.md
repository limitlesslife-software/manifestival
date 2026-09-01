# Rutiinit

**Rutiini on sääntö, ei tehtävä.**

Tämä yksi lause selittää lähes kaikki tämän moduulin ratkaisut. "Arkisin klo
07:00 aamulääkkeet" on yksi rivi tietokannassa, ei 260 riviä vuodessa.

Toteutus: `src/domain/routine.js`, `src/app/views/routines.js`
Testit: `tests/domain-routine.test.mjs`, `tests/invariants.test.mjs`
Skeema: `supabase/migrations/0003_routines.sql`

---

## Miksi esiintymiä ei tallenneta

Vaihtoehto olisi luoda jokaisesta toistosta oikea tehtävärivi etukäteen
("materialisointi"). Se hylättiin kolmesta syystä:

1. **Säännön muuttaminen olisi kallista.** "Siirrä aamurutiini seitsemästä
   kuuteen" tarkoittaisi tuhannen rivin päivitystä — ja päätöstä siitä,
   koskeeko muutos myös menneisyyttä.
2. **Horisontti olisi mielivaltainen.** Kuinka pitkälle tulevaisuuteen rivejä
   luodaan? Mikä tahansa valinta on väärä jollekin käyttäjälle.
3. **Menneisyys ja tulevaisuus sekoittuisivat.** Toteutunut historia ja
   suunniteltu tulevaisuus näyttäisivät tietokannassa samalta.

Siksi esiintymät lasketaan aina uudelleen säännöstä
(`expandRoutineOccurrences`) ja poikkeukset tallennetaan erikseen. Laskenta
on puhdas funktio: sama sääntö ja sama päiväväli tuottavat aina saman
tuloksen.

---

## Toistosäännöt

| Tyyppi | Merkitys | Käyttää `weekdays` |
|---|---|---|
| `daily` | Joka päivä | ei |
| `weekdays` | Arkisin (ma–pe) | ei |
| `weekly` | Kerran viikossa valittuna päivänä | kyllä, tasan yksi |
| `custom_weekdays` | Valittuina viikonpäivinä | kyllä, vähintään yksi |

Viikonpäivät ovat ISO-numeroita: 1 = maanantai … 7 = sunnuntai. Tämä on
tietoinen valinta: JavaScriptin oma `getDay()` palauttaa sunnuntaille 0, mikä
on toistuva virhelähde suomalaisessa viikkokalenterissa. Muunnos tehdään
yhdessä paikassa, funktiossa `isoWeekday()`.

### Suunnitellut mutta toteuttamattomat

`PLANNED_RECURRENCE_TYPES` listaa tyypit, joita **ei** ole toteutettu:
`monthly`, `interval`, `rrule`. Ne ovat listassa siksi, että validointi voi
antaa niistä selkeän virheilmoituksen sen sijaan että ne menisivät läpi
hiljaisesti väärin tulkittuina.

---

## Voimassaoloväli

`startDate` ja `endDate` ovat molemmat vapaaehtoisia.

- Ilman kumpaakaan sääntö on voimassa toistaiseksi.
- `startDate` on hyödyllinen tulevaisuuteen ajoitetulle rutiinille
  ("kuntosali alkaa ensi kuussa").
- `endDate` on hyödyllinen määräaikaiselle ("kuuri kestää 10 päivää").

Laajennus rajaa aina sekä pyydettyyn väliin että voimassaoloväliin.
`MAX_EXPANSION_DAYS = 400` estää sen, että virheellinen väli tuottaisi
loputtoman listan.

---

## Kiinteä vai joustava

| `scheduling` | Merkitys |
|---|---|
| `fixed` | Käyttäjän valitsema kellonaika on sitova. Aikataulumoottori ei siirrä sitä. |
| `flexible` | Sovellus saa etsiä sopivan ajan päivän vapaista väleistä. |

Rutiini ilman kellonaikaa on aina joustava — muuta vaihtoehtoa ei ole.
Käyttöliittymä kytkee "joustava"-valinnan pois käytöstä, jos kellonaikaa ei
ole annettu, jottei tila voi olla ristiriitainen.

Aikataulumoottorissa joustavat rutiinit saavat parhaat vapaat välit **ennen
tehtäviä** (`rank: 0`). Perustelu: rutiini on käyttäjän itse asettama
toistuva sitoumus, ja jos se jää päivästä pois, koko sen tarkoitus katoaa.
Yksittäinen tehtävä siirtyy huomiselle helpommin kuin unilääke.

---

## Poikkeukset

Poikkeus koskee **yhtä päivää**, ei sääntöä.

| Tyyppi | Vaikutus |
|---|---|
| `skip` | Tämä päivä jätetään väliin. Sääntö jatkuu normaalisti. |
| `reschedule` | Tämän päivän esiintymä siirretään toiseen aikaan. |
| `override` | Tämän päivän sisältö korvataan (otsikko, kesto). |

Sama rutiini voi saada samalle päivälle vain yhden poikkeuksen. Se on
tietokantatason uniikkirajoite: kaksi poikkeusta tekisi esiintymästä
epädeterministisen.

Kun käyttäjä painaa "Ohita" päivänäkymässä, syntyy `skip`-poikkeus — **ei**
muutosta rutiiniin. Tämä on tärkeä ero: yhden päivän ohittaminen ei saa
lopettaa rutiinia.

### Rutiinin poisto

Rutiinin poisto poistaa myös sen poikkeukset (`on delete cascade`).
Poikkeuksella ei ole merkitystä ilman sääntöä, johon se viittaa.

---

## Käytössäolo

`active = false` säilyttää rutiinin historiana mutta lopettaa esiintymien
tuottamisen. Tämä on eri asia kuin poisto.

Käyttöliittymässä käytössäolo on **listan kytkin**, ei lomakkeen kenttä.
Siksi rutiinin muokkaus ei saa muuttaa sitä. Lomake lukee nykyisen arvon
olemassa olevasta rutiinista — muuten pois kytketty rutiini heräisi henkiin
joka kerta kun sen otsikkoa korjataan.

---

## Esiintymän muoto

`expandRoutineOccurrences` palauttaa olioita, jotka näyttävät tarpeeksi
tehtävältä, että aikajana ja viikkonäkymä osaavat piirtää ne — mutta joilla
on oma tunniste:

```
routine:<routineId>:<YYYY-MM-DD>
```

Tunniste on deterministinen ja johdettu, ei generoitu. Sama esiintymä saa
aina saman tunnisteen, joten sitä voi verrata ja muistutukset voi kuitata
ilman erillistä tallennusta.

Esiintymässä **ei ole** `completed`-kenttää. Rutiinin esiintymän kuittaus on
tietoisesti jätetty tästä aallosta pois: se vaatisi oman taulunsa
(`routine_completions`) ja päätöksen siitä, mitä kuittaus tarkoittaa
menneisyydessä. Ks. `docs/ROADMAP.md`.

---

## Näkyminen käyttöliittymässä

| Paikka | Miten näkyy |
|---|---|
| Tänään, aikajana | Kiinteät rutiinit omalla merkillään, ei valintaruutua |
| Tänään, "Odottaa aikaa" | Joustavat rutiinit ennen tehtäviä |
| Tänään, ehdotukset | Rutiinit saavat vapaat välit ensin |
| Viikko | Esiintymät päiväryhmien alussa |
| Tekeminen -> Rutiinit | Sääntö sellaisenaan: "Arkisin ma–pe klo 07:00" |

Rutiinilistassa näytetään **sääntö**, ei esiintymiä — ja sen lisäksi
"Seuraavaksi: huomenna klo 07:00". Ilman sitä sääntö olisi abstrakti;
seuraava osuma tekee siitä ymmärrettävän ilman kalenteria.

---

## Rajoitukset

- Ei kuukausittaista toistoa ("joka kuun 15. päivä")
- Ei väliä ("joka 3. päivä")
- Ei rutiinin esiintymän kuittausta
- Ei sarjan katkaisua ("tästä päivästä eteenpäin uusi aika")
- Poikkeus ei voi siirtää esiintymää toiselle päivälle, vain toiseen aikaan
