# Testaus

Tila: **IMPLEMENTED.** 282 testiä, kaikki läpi.

---

## Periaate

Projektissa ei ollut yhtään testiä ennen WP1:tä. Sovellus oli yksi 947-rivinen
tie19osto ilman käännösvaihetta, joten mikään ei huomauttanut rikkinäisestä
viittauksesta ennen kuin käyttäjä törmäsi siihen.

Testit on kirjoitettu niin, että ne **estävät juuri niitä virheitä, joita tässä
projektissa on oikeasti tapahtunut** — eivät kattavuusprosentin vuoksi.

Kaikki testit ovat No27e.js:n omalla testiajurilla. Ei frameworkia, ei
riippuvuuksia, ei selainta. Testit eivät ota verkkoyhteyttä eivätkä koske
tietokantaan.

---

## Komennot

```bash
npm test        # 282 testiä
npm run check   # palvelinpuolen syntaksitarkistus
npm run smoke   # koko mo39uuligraafi HTTP:n yli (56 tarkistusta)
```

Kaikkien on mentävä läpi ennen mergeä. Ks. `CONTRIBUTING.m18`.

---

## Testityypit

| Tiedosto | Testejä | Mitä valvoo |
|---|---|---|
| `domain-scheduler.test.mjs` | 39 | Herätys, nukkumaanmeno, vapaat välit, ehdotukset, determinismi |
| `app-logic.test.mjs` | 28 | NYT-tila, kirjautumisen apurit, tilastore, muotoilu, virheet |
| `domain-task.test.mjs` | 27 | Normalisointi, validointi, kesto, järjestys, aikataulutuksen tila |
| `ai-proposal.test.mjs` | 26 | AI-vastauksen validointi, enum-yhdenmukaisuus, prompt-injektio |
| `security-invariants.test.mjs` | 26 | Salaisuudet, käyttäjäscoping, XSS, rollback, vahvistus |
| `api-security.test.cjs` | 20 | Todennus, pyyntörajoitin, päätepisteen rakenne |
| `pwa.test.mjs` | 20 | Manifesti, service workerin strategia, alustasovittimet |
| `datetime.test.mjs` | 19 | Aikavyöhyke, viikon alku, keskiyön ylitys, käänteisoperaatiot |
| `domain-week.test.mjs` | 18 | Viikkorajat, ryhmittely, otsikot, yhteenveto |
| `architecture.test.mjs` | 17 | Kerrosjärjestys, syklit, DOM-viittaukset, index.html on runko |
| `api-validation.test.cjs` | 16 | Syötevalidointi, kokorajat, virheviestit |
| `android.test.mjs` | 13 | Sovellustunnus, ei haarautumista, koonnin eristys |
| `rows.test.mjs` | 13 | Rivimuunnos, skeemaportti, `user_id`-suoja, tunnisteiden yksilöllisyys |
| **Yhteensä** | **282** | |

---

## Mitä testit estävät

Jokainen näistä on todellinen tapahtuma tässä projektissa, ei kuviteltu riski.

| Testi | Esti / paljasti |
|---|---|
| `newTaskId tuottaa yksilöllisiä tunnisteita` | **Löysi aidon bugin:** neljä satunnaista merkkiä törmäsi 500 tunnisteen otoksessa. Törmäys olisi ylikirjoittanut tehtävän. |
| `REGRESSIO: automaattinen merkintä ei jää jumiin myöhässä-tilaan` | Auditoinnissa kuvakaappauksesta löydetty bugi. Lukittu paikalleen. |
| `TURVA: jokainen tasks-kutsu on rajattu käyttäjään` | Rajaamaton `select('*')` — juuri se, mikä oli ennen WP1:tä. |
| `TURVA: toRow ei koskaan päästä user_id:tä läpi` | Client ei voi valita toisen käyttäjän riviä. |
| `SKEEMAPORTTI: laajennetut kentät eivät mene kantaan` | Kirjoitus olemattomaan sarakkeeseen kaataisi tallennuksen tuotannossa. |
| `kerrosjärjestys pitää` | Modularisoinnin rapautuminen ensimmäisen kiireen alla. |
| `ei syklisiä riippuvuuksia` | Moduulien keskinäinen umpisolmu. |
| `aikataulumoottori on puhdas` | `Date.now()` moottorissa rikkoisi determinismin ja testattavuuden. |
| `service worker ei välimuistita vieraita origineja` | Henkilökohtaisen datan tallentuminen laitteelle. |
| `service worker EI käytä skipWaiting` | Moduulien vaihtuminen kesken istunnon. |
| `sovelluskuoren välimuistilista vastaa moduuleja` | Offline rikkoutuisi hiljaa uuden moduulin myötä. |
| `Android ei haaraudu omaksi sovellukseksi` | Kaksi koodikantaa. |

---

## Mitä EI testata automaattisesti

Rehellisyyden vuoksi:

| Alue | Miksi ei | Miten varmistetaan |
|---|---|---|
| Todellinen Supabase-yhteys | Testit eivät saa kirjoittaa tuotantoon | Käsin migraation jälkeen |
| RLS-politiikkojen toiminta | Vaatii oikean tietokannan | Dashboard-todennus, `supabase/inventory.sql` |
| Anthropic-vastauksen laatu | Ei-deterministinen ja maksullinen | Validointi testataan, vastaus ei |
| Selaimen renderöinti | Ei DOM-ympäristöä testeissä | `npm run smoke` + käsin |
| Puheentunnistus | Vaatii mikrofonin ja selaimen | Käsin |
| Service workerin ajonaikainen käytös | Ei service worker -ympäristöä Nodessa | Strategia testataan rakenteellisesti |
| APK laitteessa | Fyysinen laite | Käyttäjän erillinen hyväksyntävaihe |

---

## Smoke-testi

`npm run smoke` käynnistää riippuvuudettoman palvelimen ja tarkistaa 56 asiaa:

- `index.html` ja `styles.css` latautuvat
- **koko moduuligraafi** (32 moduulia) latautuu rekursiivisesti oikealla MIME-tyypillä
- manifesti on kelvollinen ja sen ikonit ovat olemassa
- kirjautumisportti on merkinnässä ja sovellus piilotettu
- `/api/*` ei tarjoile lähdekoodia staattisesti

Tämä on ainoa testi, joka huomaa väärän import-polun — yksikkötesti ei
huomaisi sitä, koska Node resolvoi polut eri tavalla kuin selain.

---

## Testien kirjoittaminen

1. **Testaa se, mikä on oikeasti mennyt rikki.** Regressiotesti on arvokkaampi
   kuin kolme triviaalia.
2. **Anna testille suomenkielinen nimi, joka kertoo säännön** — ei
   `test('toRow works')` vaan `test('TURVA: toRow ei koskaan päästä user_id:tä läpi')`.
3. **Kirjoita väitteelle viesti**, joka kertoo miksi se on tärkeä. Kaatuva
   testi on dokumentaatiota.
4. **Merkitse turvatestit `TURVA:`-etuliitteellä** ja takuut `TAKUU:`-etuliitteellä.
5. **Älä testaa toteutusta vaan käyttäytymistä** — poikkeus: arkkitehtuuritestit,
   joiden koko tarkoitus on valvoa rakennetta.

---

## Testityökalujen omat sudenkuopat

`tests/helpers/sources.mjs` lukee lähdekoodia. Sen `readCode()` poistaa
kommentit, koska koodissa selitetään usein juuri sitä mitä on **poistettu**
("aiemmin tämä kutsui `renderAll()`") — ilman poistoa invarianttitestit
kaatuisivat hyödyllisiin kommentteihin.

Kaksi virhettä tuli tehtyä ja korjattua:

1. Lohkokommentit poistettiin ennen rivikommentteja, jolloin rivikommentissa
   ollut `/api/*` avasi näennäisen lohkokommentin ja nieli koodia.
2. `*`-alkuisten rivien suodatus rikkoi JSDoc-lohkot: sulkeva `*/` katosi ja
   avoimeksi jäänyt `/**` nieli seuraavat funktiot.

Molemmat piilottivat koodia testeiltä — eli testit näyttivät vihreiltä
väärästä syystä. **Testityökalu on koodia sekin.**
