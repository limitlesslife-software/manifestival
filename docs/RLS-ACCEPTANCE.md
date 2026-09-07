# Kahden tilin eristystesti (T1–T5)

Tämä on runbookin **vaihe 5** kokonaisuudessaan: ohje, työkalu ja
jälkivarmistus. Runbook viittaa tänne eikä toista sisältöä.

> **TILA: SUORITETTU JA HYVÄKSYTTY.** Testi ajettiin tuotantoa vasten
> ja tuotti **34/34 PASS** (0 FAIL, 0 ERROR, 0 SKIP) siinä laajuudessa
> kuin se silloin oli. Työkalu kattaa nyt **271 tarkistusta**: migraatiot
> 0003–0008, kymmenen taulua ja kuusitoista ristiinkiinnityshyökkäystä.
> Väliaikainen tili B
> on poistettu ja `verify_acceptance.sql` tuotti **18/18 PASS**,
> `poikkeavia_yhteensa` = 0.
>
> Ohje jää tänne kahdesta syystä: se on toistettava, jos jokin muutos
> koskee politiikkoja tai lisää uuden käyttäjäkohtaisen taulun, ja se on
> ainoa paikka, jossa lukee miksi testi on rakennettu juuri näin.
>
> **Migraatio 0002 EI vaatinut tämän toistamista:** se ei luonut tauluja
> eikä koskenut politiikkoihin.
>
> **Migraatio 0003 VAATII.** Se loi kaksi uutta käyttäjäkohtaista taulua,
> `routines` ja `routine_exceptions`, joiden RLS:stä ei ole elävää
> todistetta. Työkalu kattaa ne nyt (osiot R1–R5 ja E1–E6), ja testi on
> **ajettava uudelleen ennen kuin rutiiniportit avataan**.

## Työnkulku yhdellä silmäyksellä

| # | Vaihe | Kuka | Missä |
|---|---|---|---|
| 1 | **Nimenomainen lupa** luoda väliaikainen tili B | ihminen | — |
| 2 | Luo tili B käsin | ihminen | Supabase Dashboard → Authentication |
| 3 | Aja hyväksyntätesti tilien A ja B tunnuksilla | ihminen | `localhost:3000/tools/rls-acceptance/` |
| 4 | Kopioi yksi tulosraportti | ihminen | työkalun **Kopioi raportti** |
| 5 | Tarkista siivous (`C1`–`C6` kaikki `PASS`) | ihminen | sama raportti |
| 6 | Poista tili B — **vain jos kohta 5 on PASS** | ihminen | Dashboard → Authentication |
| 7 | Aja `supabase/acceptance/verify_acceptance.sql` | ihminen | Supabase SQL Editor |
| 8 | Kopioi sen tulos | ihminen | SQL Editor |
| 9 | Katselmoi molemmat raportit ennen migraatiota 0002 | ihminen | — |

**Mikään näistä ei tapahdu automaattisesti.** Työkalu ei luo tiliä B
eikä poista sitä. Migraatiot 0002–0008 pysyvät pysäytettyinä ja kaikki
yksitoista skeemaporttia arvossa `false`, kunnes kohta 9 on tehty.

---

## Miksi tämä ei ole valinnainen

Koko repossa on täsmälleen yksi asia, jota ei voi testata lukemalla:
**toimiiko RLS oikeasti.** 1211 automaattitestiä lukee SQL:ää tekstinä.
Ne todistavat, että migraatio *sanoo* oikeat asiat. Ne eivät todista,
että tietokanta *tekee* ne.

Ennen tätä vaihetta ei käännetä yhtäkään lippua eikä ajeta yhtäkään
muuta migraatiota.

## Miksi selaimessa eikä SQL-editorissa

Aiempi versio tästä vaiheesta teki kirjoituskiellot SQL-editorissa
tempulla `set local role authenticated` + `request.jwt.claims`. Se
testaa politiikan lausekkeen — mutta ei mitään muuta siitä ketjusta,
jota oikea käyttäjä kulkee:

| Kerros | SQL-editorin temppu | Oikea istunto |
|---|---|---|
| Politiikan lauseke | testataan | testataan |
| JWT:n todennus | ohitetaan | testataan |
| Julkinen anon-avain | ohitetaan | testataan |
| PostgREST ja sen roolinvaihto | ohitetaan | testataan |
| Roolin `authenticated` GRANTit | osittain | testataan |

Ohitetut kerrokset ovat juuri ne, joissa vika olisi näkymätön:
politiikka voi olla täysin oikein ja silti pääsy auki, jos GRANT on
väärä tai anon-rooli ei olekaan se, joka kyselyn ajaa.

Siksi testi ajetaan **oikeilla kirjautuneilla istunnoilla** samalla
julkisella anon-avaimella kuin sovellus. RLS:n ohittavaa palvelinavainta
ei ole selaimessa eikä työkalussa. Jos se olisi, jokainen kielto menisi
läpi ja raportti kertoisi vain siitä.

## Mitä testi todistaa

| | Testi | Mitä todistaa |
|---|---|---|
| **T1** | A lukee oman datansa | `USING` ei ole liian tiukka; omistaja ei ole lukittu ulos |
| **T2** | B ei näe A:n tehtäviä eikä profiilia | `USING` estää lukemisen **molemmissa** omistajuusmalleissa |
| **T3** | B ei voi muuttaa, poistaa eikä kirjoittaa A:n nimiin | `USING` kirjoituspuolella ja `WITH CHECK` |
| **T4** | B luo, lukee, muuttaa ja poistaa oman datansa | politiikka ei ole `using (false)` |
| **T5** | A ei näe eikä muuta B:n dataa | eristys on kaksisuuntainen |
| **T6** | Kirjautumaton ei saa mitään | anon-roolilta on peruttu oikeudet |
| **R1–R5** | Sama matriisi `routines`-taululle | 0003:n politiikat toimivat |
| **E1–E6** | Sama matriisi `routine_exceptions`-taululle | 0003:n politiikat toimivat |
| **E4** | **B ei voi kiinnittää poikkeustaan A:n rutiiniin** | yhdistelmävierasavain — **RLS ei estäisi tätä** |
| **G, J** | Sama matriisi `goals`- ja `projects`-tauluille | 0004:n politiikat toimivat |
| **W** | Sama matriisi `wellbeing_entries`-taululle | 0006:n politiikat toimivat |
| **X, L, S** | Sama matriisi taloustauluille | 0007:n politiikat toimivat |
| **K** | Sama matriisi `ai_action_audit`-taululle | 0008:n politiikat toimivat |
| **K9** | Vahvistamatonta suoritusta ei voi kirjata | tarkiste puree oikealla käyttäjällä (23514) |
| **N1–N6** | `notification_preferences` — omistaja on pääavain | eri omistajuusmalli kuin muissa |
| **X1–X8** | **Ristiinkiinnitys INSERTillä, kahdeksan viitettä** | yhdistelmävierasavaimet (23503) |
| **U1–U8** | **Ristiinkiinnitys UPDATElla, samat kahdeksan** | eri koodipolku — rivi läpäisee RLS:n |
| **X9** | B saa liittää tehtävänsä **omaan** tavoitteeseensa | kielto ei johdu siitä että viitteet ovat rikki |

### Ristiinkiinnityshyökkäykset ovat osuuden ydin

Kahdeksan viitettä, kaksi hyökkäystä kumpaakin kohti.

**INSERT (X1–X8):** B luo uuden rivin, joka viittaa A:n riviin.

**UPDATE (U1–U8):** B ottaa **oman** rivinsä ja kääntää viitteen A:han.
Tämä on eri koodipolku, ei lisätesti: rivi läpäisee sekä `USING`in että
`WITH CHECK`in — omistaja ei muutu — ja vain vierasavain voi torjua
muutoksen. Jos vain INSERT testattaisiin, kanta voisi olla suojattu
luonnissa ja auki muokkauksessa.

**Odotettu koodi `23503` on osa väitettä.** Jos jokin näistä palauttaisi
`42501`:n, rivi olisi kyllä torjuttu — mutta RLS:n toimesta, ei
eheysrajoitteen. Silloin suoja riippuisi politiikasta, joka voidaan
muuttaa, eikä rakenteesta. Siksi väärä koodi kirjataan ERRORiksi eikä
PASSiksi.

**X9 todistaa vastakohdan.** Ilman sitä kaikki kuusitoista kieltoa
voisivat mennä läpi siksi, että viitteet ovat rikki kaikilta.

### Fikstuurien on kohdattava se rajoite, jota ne testaavat

Tuotantoajo 20260907181539 tuotti kolme ERRORia, jotka olivat kaikki
harnessin vikoja — ei kannan. Molemmat opetukset ovat samoja:

**E4 sai 23505:n odotetun 23503:n sijaan.** Rajoite
`routine_exceptions_unique_day` on `unique (routine_id, date)` —
RUTIINIkohtainen, ei käyttäjäkohtainen. E1 oli varannut parin
(A:n rutiini, tämä päivä), ja E4 yritti samaa paria. Yksikäsitteisyys-
indeksi torjui rivin ennen kuin vierasavain ehti sanoa mitään.

Järjestys kannassa on **RLS WITH CHECK → yksikäsitteisyysindeksi →
vierasavaimen liipaisin**. Siksi jokainen A:n rutiiniin kohdistuva
poikkeus käyttää nyt omaa päiväänsä (`exceptionDates`).

**T6-n-update ja T6-n-delete saivat 22P02:n odotetun 42501:n sijaan.**
`notification_preferences.id` on uuid, ja harness syötti siihen
merkkijonon. PostgreSQL hylkäsi arvon ennen oikeustarkistusta, joten
testi todisti vain sen, ettei merkkijono ole uuid. Kohde on nyt
tyypiltään taulun avaimen mukainen (`ANON_KOHTEET`).

Kumpaakaan ei korjattu löysäämällä odotusta. Väärällä koodilla saatu
torjunta ei ole todiste: 23505 ei kerro mitään omistajuudesta eikä
22P02 mitään oikeuksista.

**T4 on yhtä tärkeä kuin kiellot.** Politiikka `using (false)` läpäisisi
jokaisen kieltotestin ja rikkoisi sovelluksen täysin. Ilman T4:ää testi
ei erottaisi turvallista kannasta, joka ei toimi lainkaan.

**T5 on erillinen T2:sta.** Yksisuuntainen eristys ei ole eristys. Jos
vain toinen suunta testattaisiin, vuoto "vanhemmalta uudemmalle" jäisi
huomaamatta.

## Miksi tilin A oikeaa dataa ei kosketa

Kiellon todistaminen vaatii kohteen, jota yritetään muuttaa. Kohde ei
saa olla tilin A oikea rivi: jos RLS olisikin rikki, testi tuhoaisi juuri
sen, mitä sen on määrä suojella.

Ratkaisu on kolmiosainen:

1. **Tehtävät:** A luo yhden **syöttirivin**. Sillä on sama omistaja ja
   siten täsmälleen sama RLS-raja kuin A:n oikeilla riveillä, mutta se on
   heitettävä. B:n kaikki kirjoitusyritykset kohdistuvat siihen.
2. **Profiili:** profiilia ei voi monistaa (pääavain on `id`, yksi rivi
   per käyttäjä). Siksi B:n kirjoitusyritys A:n profiiliin tehdään
   **arvot säilyttävänä**: payload on A:n nykyiset arvot. Jos RLS
   pettäisi, rivi kirjoittuisi itsekseen eikä yksikään arvo muutu.
3. **Profiilin poistokielto** testataan **toisesta suunnasta**: A yrittää
   poistaa B:n väliaikaisen profiilin. Sama politiikkaperhe, sama
   predikaatti, nollariski — koska kohde on testin itsensä luoma.

Arvot säilyttävä payload on silti päättelyä, ja päättely on juuri se,
minkä tämä työkalu on olemassa korvaamaan. Siksi **`T3f` lukee A:n
profiilin uudelleen ja vertaa sen sarake sarakkeelta** ennen yritystä
otettuun tilannekuvaan. Se huomaa myös sellaisen muutoksen, jota payload
ei tehnyt — esimerkiksi `updated_at`-liipaisimen jättämän jäljen.

Jokainen testin luoma rivi saa tunnisteen etuliitteellä
`manifestival_rls_acceptance_`. Siivous kohdistuu vain siihen. Laajaa `delete`-lausetta
ei ole missään.

## Nolla riviä ei ole sama asia kuin virhe

Kieltotestin odotus on "nolla riviä". Katkennut yhteys palauttaa myös
nolla riviä. Jos näitä ei eroteta, **täysin toimimaton verkko näyttäisi
täydelliseltä tietoturvalta.**

Työkalu erottaa ne:

| Tulos | Tarkoitus |
|---|---|
| `PASS` | odotus toteutui **eikä virhettä tullut** |
| `FAIL` | kielto ei pitänyt, tai sallitun piti onnistua eikä onnistunut |
| `ERROR` | kysely ei päässyt yrittämään: verkko, CORS, väärä virhekoodi |
| `SKIP` | edellytys puuttui — ei hyväksytty tulos |

Kokonaistulos on `PASS` vain jos **jokainen** rivi on `PASS`.

## E4 — ainoa kohta, jota RLS ei suojaa

Kaikki muut kiellot nojaavat rivitason politiikkaan. E4 ei.

Käyttäjä B tuntee A:n rutiinin tunnisteen ja yrittää kiinnittää siihen
**oman** poikkeuksensa: `user_id` jää B:ksi, koska kanta asettaa sen,
mutta `routine_id` osoittaa A:n rutiiniin.

**RLS päästäisi tämän läpi.** INSERT-politiikan `WITH CHECK` vertaa vain
omistajaa, ja omistaja on oikein — B. Vierasavaimen tarkistus taas ei
kulje RLS:n läpi lainkaan, joten pelkkä `routine_id`-viittaus kelpaisi
vaikka rutiini kuuluu toiselle. B ei näkisi riviään A:n rutiinissa, mutta
rivi olisi olemassa ja viittaisi toisen ihmisen dataan.

Ainoa este on yhdistelmävierasavain

```
routine_exceptions(user_id, routine_id) → routines(user_id, id)
```

Paria `(B, A:n rutiini)` ei ole olemassa, joten kanta hylkää rivin
koodilla **`23503`** (`foreign_key_violation`).

Testi hyväksyy **vain** koodin 23503. Jos vastaus olisi 42501, rivi olisi
kyllä torjuttu — mutta RLS:n toimesta, ei siitä syystä jonka piti
todistua. Väärä koodi on siksi `ERROR`, ei `PASS`.

---

# Operaattorin ohje

## A. Luo väliaikainen tili B

> **Tämä on ainoa kohta, joka kirjoittaa tuotantoon ennen testiä, ja se
> vaatii nimenomaisen luvan.** Tiliä ei luoda automaattisesti.

1. Supabase Dashboard → projekti `twpyubcymdnbvelsjidg` → **Authentication
   → Users → Add user → Create new user**.
2. Sähköposti: käytä osoitetta, johon pääset käsiksi. **Älä käytä tilin A
   osoitetta.** Suositus: erillinen alias, esim. `+rlstest`-muodossa.
3. Salasana: satunnainen, kertakäyttöinen. Sitä ei tallenneta minnekään.
4. Rastita **Auto Confirm User**, jotta kirjautuminen onnistuu heti.
5. Kirjaa tilin B tunniste (UUID) ylös. Sitä tarvitaan kohdassa F.

Tili B on olemassa vain tämän testin ajan. Se poistetaan kohdassa F.

## B. Käynnistä työkalu paikallisesti

```
npm run serve
```

Avaa selaimessa:

```
http://localhost:3000/tools/rls-acceptance/
```

Sivu kieltäytyy toimimasta muualta kuin `localhost`-osoitteesta, ja se on
suljettu pois julkaisusta (`.vercelignore`). Se kirjaa sisään oikeita
tuotantotilejä, joten julkaistuna se olisi valmis kirjautumislomake
väärässä paikassa.

Salasanat luetaan kentistä, annetaan supabase-js:lle ja kentät
tyhjennetään heti. Niitä ei tallenneta, ei kirjoiteta lokiin eikä lähetetä
minnekään muualle kuin Supabasen omaan auth-päätepisteeseen.

## C. Aja testi

Täytä molempien tilien tunnukset. Kentässä **Odotettu tunniste** on
tilin A UUID valmiina — työkalu **keskeyttää**, jos kirjautunut tili ei
ole se. Väärää tiliä vastaan ei ajeta.

Paina **Aja hyväksyntätesti**. Ajo tekee kaiken yhdellä kertaa: molemmat
istunnot, T1–T6, siivouksen ja loppulaskennan. Erillisiä
sisään- ja uloskirjautumisia ei tarvita, koska istunnot ovat kolmessa
erillisessä clientissä samalla sivulla (`persistSession: false` ja oma
`storageKey` kullekin).

## D. Kopioi tulos

Paina **Kopioi raportti**. Se on yksi taulukko sarakkeilla
`test_no`, `test_name`, `status`, `expected`, `actual`, `details` sekä
loppurivi muodossa `TULOS: PASS — 271/271 PASS, 0 FAIL, 0 ERROR, 0 SKIP`.

Liitä se runbookin ajolokiin sellaisenaan.

**Jos yksikin rivi on FAIL:** pysäytä kaikki. Älä käännä yhtäkään lippua
äläkä aja migraatiota 0002. Ks. *Vikatilanteet* alla.

## E. Siivous

Työkalu siivoaa itse (rivit `C1`–`C6`) ja ajaa siivouksen **myös
epäonnistuneen ajon jälkeen**. Kumpikin tili poistaa omansa etuliitteen
perusteella; RLS itse takaa, ettei siivous voi osua toisen riveihin, ja
`P0` on todistanut ettei etuliitteellä ollut rivejä ennen ajoa. Kumpikin
suunta tarvitaan: jos `WITH CHECK` olisi pettänyt, B:n väärentämän rivin
omistaja olisi A eikä B näkisi sitä lainkaan.

Siivous on onnistunut, kun:

- `C8` — A:n tehtävämäärä on takaisin lähtöarvossa (36)
- `C9` ja `C10` — kumpikaan tili ei näe jäännöstä `tasks`-taulussa
- `C11-r`, `C11-e`, `C12-r`, `C12-e` — kumpikaan tili ei näe jäännöstä
  `routines`- eikä `routine_exceptions`-taulussa

Poikkeukset siivotaan ennen rutiineja, vaikka vierasavain on
`ON DELETE CASCADE`. Jos cascadeen luotettaisiin, siivouksen onnistuminen
todistaisi cascaden toiminnan eikä sitä, että poikkeukset ovat oikeasti
poistettavissa. Nyt molemmat tulevat todistetuiksi erikseen.

**Jos siivous ei ole PASS, älä poista tiliä B vielä.** Selvitä ensin,
mikä rivi jäi ja miksi.

## F. Poista tili B — vasta kun siivous on PASS

1. Supabase Dashboard → **Authentication → Users** → tili B → **Delete
   user**.
2. `on delete cascade` vie mukanaan kaiken, mitä tilille B mahdollisesti
   jäi. Tämä on samalla ainoa kerta, kun poistoketju tulee oikeasti
   testattua.

## G. Jälkivarmistus

Aja SQL-editorissa:

```
supabase/acceptance/verify_acceptance.sql
supabase/acceptance/verify_acceptance_0003.sql
```

Ensimmäinen todistaa `tasks`- ja `profile`-taulujen tilan (18 kohtaa),
toinen migraation 0003 taulut ja sen, etteivät vanhat muuttuneet
(22 kohtaa).

Yksi lause, yksi taulukko, yksi kopiointi. **Odotus: jokaisen rivin
`status` = `PASS` ja `poikkeavia_yhteensa` = 0.**

Tämä tiedosto on erillinen syystä: selaimessa ajettu testi katsoo kantaa
RLS:n läpi eikä siis voi nähdä, jäikö toisen tilin rivi kantaan — RLS
piilottaisi juuri sen rivin, jota etsitään. Jälkivarmistus ajetaan
SQL-editorissa ilman RLS-rajausta, ja se on ainoa paikka, josta jäännöksen
voi nähdä.

Tuloksen sarakkeet ovat `check_no`, `section`, `check_name`, `status`,
`details` ja `poikkeavia_yhteensa`. Kahdeksantoista tarkistusta neljässä
osiossa:

| Osio | Kohdat | Mitä todentaa |
|---|---|---|
| `tilin A data` | 01–06 | 36 tehtävää, profiili, omistajuus, ei omistajattomia, ei orpoja, `legacy_id` tallella |
| `jaannokset` | 07–10 | ei merkittyjä rivejä, 36 tehtävää **yhteensä**, 1 profiilirivi, tili B poistettu |
| `rakenne` | 11–15 | RLS päällä, 8 politiikkaa, niiden ehdot, vierasavaimet `CASCADE`, user_id-alkuinen indeksi |
| `oikeudet` | 16–18 | anon ilman oikeuksia, `authenticated` tasan CRUD, `PUBLIC` tyhjä |

Kohta 08 on erillinen kohdasta 01 tarkoituksella: jos testirivi jäi
kantaan **toisen tilin nimiin**, A:n luku on yhä 36 mutta kokonaisluku on
suurempi. Vain kohta 08 näkee sen.

---

## PYSÄYTYS 5 — hyväksymisportti

Migraatiota 0002 ei ajeta eikä yhtäkään lippua käännetä, ennen kuin
**kaikki kolme** ovat totta:

1. Selaintestin raportti: `TULOS: PASS`, ei yhtäkään FAIL, ERROR eikä SKIP
2. Tili B on poistettu Supabasen Authentication-näkymästä
3. `verify_acceptance.sql`: jokainen rivi `PASS`, `poikkeavia_yhteensa` = 0

Yksikin poikkeama tarkoittaa, että henkilökohtainen data on toisen
käyttäjän saatavilla tai muokattavissa. Se ei ole asia, jota kierretään.

---

## Vikatilanteet

| Oire | Mitä se tarkoittaa | Toimenpide |
|---|---|---|
| `T1a` FAIL, A näkee liian vähän | `USING` on liian tiukka tai `user_id`-backfill on väärin | Pysäytä. Ks. runbookin perumisosio. |
| `T2*` FAIL | B näkee A:n dataa — RLS ei ole voimassa | **Pysäytä kaikki.** Tarkista `relrowsecurity` ja politiikat. |
| `T3a`/`T3b` FAIL | `USING` ei estä kirjoittamista | Pysäytä. Vahinko kohdistui syöttiriviin, ei oikeaan dataan. |
| `T3c` FAIL | B pääsi kirjoittamaan A:n profiiliin | Pysäytä. Arvot eivät muuttuneet (arvot säilyttävä payload), mutta raja on auki. |
| `T3f` FAIL | A:n profiilin arvo muuttui | **Pysäytä heti.** Rivi näyttää mitkä sarakkeet. Palauta arvot varmuuskopiosta. |
| `T3d` FAIL | `WITH CHECK` puuttuu tai on väärin | Pysäytä. B voi luoda rivejä toisen nimiin. |
| `T4*` FAIL | politiikka on liian tiukka — sovellus ei toimisi lainkaan | Pysäytä. Kiellot menivät läpi vain siksi, ettei mikään toimi. |
| `T6*` FAIL | anon-roolilta ei ole peruttu oikeuksia | Pysäytä. Julkinen avain riittää pääsyyn. |
| Rivi `ERROR` | kysely ei päässyt yrittämään | **Ei hyväksytty tulos.** Korjaa yhteys ja aja koko testi uudelleen. |
| `P0` FAIL | edellisen ajon rivi on kannassa | Poista se käsin tunnisteen perusteella ja aja uudelleen. Siivous ei ole yksiselitteinen ennen sitä. |
| `C5`/`C6` FAIL | testirivi jäi kantaan | Poista käsin tunnisteen perusteella. **Älä** poista tiliä B ennen sitä. |
| `T1c` tai `T4a` `ERROR`, koodi `23502` | taulussa on `NOT NULL` -sarake, jota testirivi ei täytä | Lisää sarake `taskRow()`-funktioon (`acceptance.js`) ja aja uudelleen. Ei tietoturva-asia. |
| `T4e` `ERROR`, koodi `23502` | sama asia `profile`-taulussa | Lisää puuttuva sarake T4e:n payloadiin ja aja uudelleen. |

Jos jokin kielto pettää, ajo **ei** keskeydy: jäljellä olevien yritysten
kohteet ovat joko syöttirivi, B:n väliaikainen data tai arvot säilyttävä
payload, joten yksikään ei voi vahingoittaa A:n oikeaa dataa edes silloin,
kun RLS on täysin rikki. Keskeytys sen sijaan hukkaisi juuri sen tiedon,
jota vian selvittäminen vaatii: kuinka moni kielto petti ja mitkä.

---

## Työkalun rakenne

| Tiedosto | Vastuu |
|---|---|
| `tools/rls-acceptance/acceptance.js` | koko päättely: testit, luokittelu, siivous, raportti |
| `tools/rls-acceptance/main.js` | clientit, kirjautuminen, piirto |
| `tools/rls-acceptance/index.html` | runko, ei logiikkaa |
| `supabase/acceptance/verify_acceptance.sql` | jälkivarmistus, vain lukeva |
| `tests/rls-acceptance.test.mjs` | ajurin testit |

Päättely on omassa moduulissaan, jotta se voidaan yksikkötestata ilman
verkkoa. `tests/rls-acceptance.test.mjs` ajaa sen RLS:ää matkivaa
tekokantaa vasten ja **rikkoo politiikat yksi kerrallaan**: jokainen
mutaatio vastaa yhtä todellista tapaa, jolla 0001 voisi mennä pieleen, ja
jokaisen on saatava ajuri raportoimaan FAIL. Ajuri, joka läpäisee myös
rikkinäisellä kannalla, ei todistaisi mitään.

Etuliite `manifestival_rls_acceptance_` on sama JS:ssä ja SQL:ssä, ja
`tests/migrations.test.mjs` vartioi sitä. Jos ne ajautuisivat erilleen,
jälkivarmistus raportoisi tyytyväisenä nolla jäännösriviä — koska se
etsisi etuliitettä, jota kukaan ei enää käytä.
