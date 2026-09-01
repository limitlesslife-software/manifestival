# Testaus

Tila: **IMPLEMENTED.** 778 testiä, kaikki läpi.

---

## Periaate

Projektissa ei ollut yhtään testiä ennen WP1:tä. Sovellus oli yksi 947-rivinen
tiedosto ilman käännösvaihetta, joten mikään ei huomauttanut rikkinäisestä
viittauksesta ennen kuin käyttäjä törmäsi siihen.

Testit on kirjoitettu niin, että ne **estävät juuri niitä virheitä, joita tässä
projektissa on oikeasti tapahtunut** — eivät kattavuusprosentin vuoksi.

Kaikki testit ajetaan Node.js:n omalla testiajurilla. Ei frameworkia, ei
riippuvuuksia, ei selainta. Testit eivät ota verkkoyhteyttä eivätkä koske
tietokantaan.

---

## Komennot

```bash
npm test        # 778 testiä
npm run check   # palvelinpuolen syntaksitarkistus
npm run smoke   # koko moduuligraafi HTTP:n yli (74 tarkistusta)
```

Kaikkien on mentävä läpi ennen mergeä. Ks. `CONTRIBUTING.md`.

---

## Testityypit

### Domain — puhdas logiikka, ei ympäristöä

| Tiedosto | Testejä | Mitä valvoo |
|---|---|---|
| `domain-routine.test.mjs` | 51 | Toistosäännöt, laajennus, poikkeukset, voimassaolo |
| `domain-goal-project.test.mjs` | 46 | Edistyminen, tilat, projektit, myöhästyminen |
| `domain-focus-review-wellbeing.test.mjs` | 40 | Fokuspisteytys, katsaukset, kuormitusarvio |
| `domain-scheduler.test.mjs` | 39 | Herätys, nukkumaanmeno, vapaat välit, ehdotukset |
| `domain-notification.test.mjs` | 39 | Eskalaatio, rauhoitusaika, päiväkatto |
| `domain-finance.test.mjs` | 36 | Laskut, toistuvat kulut, pyöristys, muistutukset |
| `domain-scheduler-v3.test.mjs` | 30 | Rutiinit aikataulussa, kiireellisyysjärjestys |
| `domain-task.test.mjs` | 27 | Normalisointi, validointi, kesto, määräajat |
| `domain-week.test.mjs` | 19 | Viikkorajat, ryhmittely, otsikot |
| `week-boundaries.test.mjs` | 19 | Kuukausi, vuosi, karkausvuosi, tyhjä ja täysi viikko |
| `datetime.test.mjs` | 19 | Aikavyöhyke, viikon alku, keskiyön ylitys |

### Sovellus ja data

| Tiedosto | Testejä | Mitä valvoo |
|---|---|---|
| `app-logic.test.mjs` | 28 | NYT-tila, kirjautumisen apurit, tilastore, virheet |
| `data-collections.test.mjs` | 22 | Repositoriot, muistivarasto, skeemaportti |
| `app-notifications.test.mjs` | 17 | Orkestrointi domainista alustalle, katot, kilpailutilanteet |
| `rows.test.mjs` | 13 | Rivimuunnos, `user_id`-suoja, tunnisteiden yksilöllisyys |
| `cross-user-leak.test.mjs` | 7 | Paikallisen datan tyhjennys uloskirjautuessa |

### AI ja alusta

| Tiedosto | Testejä | Mitä valvoo |
|---|---|---|
| `ai-intent.test.mjs` | 39 | Komentojen allowlist, riskitasot, muutoskomennon turvallisuus |
| `platform.test.mjs` | 31 | supported / implemented / permission -erottelu |
| `platform-native.test.mjs` | 27 | Capacitor-sovitin mockatulla liitännäisellä |
| `ai-proposal.test.mjs` | 26 | AI-vastauksen validointi, prompt-injektio |

### Rajat ja invariantit

| Tiedosto | Testejä | Mitä valvoo |
|---|---|---|
| `invariants.test.mjs` | 34 | Ominaisuustestit siemenellisellä satunnaissyötteellä |
| `accessibility.test.mjs` | 34 | Roolit, nimet, näppäimistö, fokus, kapea näyttö |
| `security-invariants.test.mjs` | 30 | Salaisuudet, käyttäjärajaus, XSS, tuplaklikkaus |
| `pwa.test.mjs` | 20 | Manifesti, service worker, välimuistin rajat |
| `api-security.test.cjs` | 20 | Todennus, pyyntörajoitin, päätepisteen rakenne |
| `migrations.test.mjs` | 19 | Migraatiot vastaavat domainia; RLS ja omistajuus |
| `architecture.test.mjs` | 17 | Kerrosjärjestys, syklit, DOM-viittaukset |
| `api-validation.test.cjs` | 16 | Syötevalidointi, kokorajat, virheviestit |
| `android.test.mjs` | 13 | Sovellustunnus, ei haarautumista, koonnin eristys |
| **Yhteensä** | **778** | |

---

## Ominaisuustestit

`invariants.test.mjs` generoi syötteen itse ja tarkistaa sääntöjä, joiden on
pädettävä **kaikella** syötteellä — ei vain niillä tapauksilla, jotka joku on
osannut kuvitella.

Satunnaisuus tulee kiinteästä siemenluvusta (mulberry32), ei
`Math.random()`:sta. Tämä on olennaista: testi, joka kaatuu vain joka kolmas
ajo, on pahempi kuin ei testiä lainkaan, koska se opettaa jättämään punaisen
huomiotta. Kun testi kaatuu, virheilmoitus kertoo tapauksen numeron, jolla se
toistuu.

Lukittuja invariantteja mm.:

- Normalisointi on idempotentti — muuten tallennus ja lataus muuttaisivat
  tietoa hiljaisesti joka kierroksella
- Aikataulumoottori on deterministinen eikä sijoita päällekkäin
- Tavoitteen edistyminen ei koskaan laske, kun tehtävä kuitataan
- Muistutusten päiväkatto ja rauhoitusaika pitävät aina

---

## Mitä testit estävät

Jokainen näistä on todellinen tapahtuma tässä projektissa, ei kuviteltu riski.

| Testi | Esti / paljasti |
|---|---|
| `newTaskId tuottaa yksilöllisiä tunnisteita` | **Aito bugi:** neljä satunnaista merkkiä törmäsi 500 tunnisteen otoksessa. Törmäys olisi ylikirjoittanut tehtävän. |
| `uloskirjautuminen tyhjentää kaikki kokoelmat` | **Aito bugi:** muistivarasto säilyi uloskirjautumisen yli, joten seuraava käyttäjä olisi nähnyt edellisen rutiinit ja tavoitteet. |
| `sovittimet eivät sekoita supported- ja implemented-tiloja` | **Aito bugi:** Android-käyttäjälle olisi kerrottu ettei laite tue sijaintia, vaikka puute oli sovelluksessa. |
| `normalizeWellbeingEntry on idempotentti` | **Aito bugi:** unen tunnit pyöristyivät nollaksi ja rikkoivat kannan rajoitteen. |
| `puuttuva summa on tuntematon eikä nolla` | **Aito bugi:** tyhjä summakenttä tallentui nollan euron laskuna. |
| `mennyttä aikaa ei ajasteta` | Ilmoitusryöppy, kun sovellus avataan illalla. |
| `rauhoitusaikana vain kriittiset` | Yöllinen herätys tavallisesta muistutuksesta. |
| `TURVA: jokainen tasks-kutsu on rajattu käyttäjään` | Rajaamaton `select('*')` — juuri se, mikä oli ennen WP1:tä. |
| `SKEEMAPORTTI: laajennetut kentät eivät mene kantaan` | Kirjoitus olemattomaan sarakkeeseen kaataisi tallennuksen tuotannossa. |
| `kerrosjärjestys pitää` | Modularisoinnin rapautuminen ensimmäisen kiireen alla. |
| `service worker ei välimuistita vieraita origineja` | Henkilökohtaisen datan tallentuminen laitteelle. |
| `sovelluskuoren välimuistilista vastaa moduuleja` | Offline rikkoutuisi hiljaa uuden moduulin myötä. |

---

## Mitä EI testata automaattisesti

Rehellisyys tässä on tärkeämpää kuin lukumäärä.

| Alue | Miksi ei | Miten varmistetaan |
|---|---|---|
| Todellinen Supabase-yhteys | Testit eivät saa kirjoittaa tuotantoon | Käsin migraation jälkeen |
| RLS-politiikkojen toiminta | Vaatii oikean tietokannan | `supabase/inventory.sql` + dashboard |
| Anthropic-vastauksen laatu | Ei-deterministinen ja maksullinen | Validointi testataan, vastaus ei |
| Selaimen renderöinti | Ei DOM-ympäristöä testeissä | `npm run smoke` + käsin |
| Puheentunnistus | Vaatii mikrofonin ja selaimen | Käsin |
| Ilmoituksen näkyminen ruudulla | Vaatii fyysisen laitteen | Käsin laitteella |
| APK laitteessa | Fyysinen laite | Käyttäjän erillinen hyväksyntävaihe |

Näitä ei voi todentaa tästä ympäristöstä, eikä niitä siksi väitetä
todennetuiksi.

---

## Smoke-testi

`npm run smoke` käynnistää riippuvuudettoman palvelimen ja tarkistaa 74 asiaa:

- `index.html` ja `styles.css` latautuvat
- **koko moduuligraafi** (50 moduulia) latautuu rekursiivisesti oikealla
  MIME-tyypillä
- manifesti on kelvollinen ja sen ikonit ovat olemassa
- kirjautumisportti on merkinnässä ja sovellus piilotettu
- `/api/*` ei tarjoile lähdekoodia staattisesti

Tämä on ainoa testi, joka huomaa väärän import-polun — yksikkötesti ei
huomaisi sitä, koska Node resolvoi polut eri tavalla kuin selain.

---

## Testien kirjoittaminen

1. **Testaa se, mikä on oikeasti mennyt rikki.** Regressiotesti on arvokkaampi
   kuin kolme triviaalia, ja sen kommentti kertoo minkä bugin se esti.
2. **Anna testille suomenkielinen nimi, joka kertoo säännön** — ei
   `test('toRow works')` vaan `test('TURVA: toRow ei koskaan päästä user_id:tä läpi')`.
3. **Kirjoita väitteelle viesti**, joka kertoo miksi se on tärkeä. Kaatuva
   testi on dokumentaatiota.
4. **Merkitse turvatestit `TURVA:`-etuliitteellä** ja takuut `TAKUU:`-etuliitteellä.
5. **Älä hyväksy vacuous-testiä.** Jos jäsennys ei löydä mitään, testi menisi
   läpi vaikka toteutus olisi rikki. Tarkista jäsennyksen tulos erikseen.
6. **Testi saa kaatua tarkoituksella.** `migrations.test.mjs` vaatii, että
   kaikki taululiput ovat `false`. Se kaatuu heti kun lippu käännetään — ja
   pakottaa toteamaan ääneen, että migraatio on oikeasti ajettu tuotannossa.

---

## Testityökalujen omat sudenkuopat

`tests/helpers/sources.mjs` lukee lähdekoodia. Sen `readCode()` poistaa
kommentit, koska koodissa selitetään usein juuri sitä mitä on **poistettu**
("aiemmin tämä kutsui `renderAll()`") — ilman poistoa invarianttitestit
kaatuisivat hyödyllisiin kommentteihin.

Kolme virhettä tuli tehtyä ja korjattua:

1. Lohkokommentit poistettiin ennen rivikommentteja, jolloin rivikommentissa
   ollut `/api/*` avasi näennäisen lohkokommentin ja nieli koodia.
2. `*`-alkuisten rivien suodatus rikkoi JSDoc-lohkot: sulkeva `*/` katosi ja
   avoimeksi jäänyt `/**` nieli seuraavat funktiot.
3. Moduulien välimuistin ohitus kyselymerkkijonolla koski vain päällimmäistä
   moduulia; sisemmät importit osoittivat alkuperäiseen instanssiin, jolloin
   jaettu tila vuoti testien välillä.

Kaikki kolme piilottivat koodia testeiltä — eli testit näyttivät vihreiltä
väärästä syystä. **Testityökalu on koodia sekin.**
