# Suunta — Day 1 -hyväksyntä (10–15 min, puhelimella)

**Milloin:** vasta kun aalto J on deployattu ja `verify_0013.sql` = 0
poikkeavaa (`docs/SUUNTA-ACTIVATION-GO-NOGO.md`). Ennen sitä Suunnan tieto
ei säily, ja J-APK kaataisi tänään toimivat tallennukset.

**APK:** `.claude/release-packages/manifestival-suunta-waveJ-…-debug.apk`
(ks. `docs/activation/ANDROID-ACCEPTANCE-BUILD.md`). Tarkista, että
tiedoston SHA-256 vastaa `.json`-kuvausta.

**Periaate:** sovellus kysyy, sinä vastaat. Mitään ei ole valmiiksi
täytetty eikä kukaan ole päättänyt puolestasi, mikä sinulle on tärkeää.

---

## A. Ensikäyttö (se, mitä käytät joka päivä)

- [ ] 1. **Kirjaudu** sovellukseen. Sovellus aukeaa (Tänään tai viimeksi
      avattu näkymä). Ensikäytön opastus näkyy korkeintaan kerran tälle
      käyttäjälle — ei uudelleen uloskirjautumisen jälkeen.
- [ ] 2. **Avaa Suunta** (tai Tänään-kortista **Aloita Suunta**). Ilman
      alueita Suunta avautuu **aloitukseen**: "Vaihe 1/7", yksi kysymys
      kerrallaan, [Takaisin] [Ohita tämä vaihe] [Seuraava/Tallenna]; muu
      Suunta on piilossa ("Näytä koko Suunta" siirtää aloituksen sivuun).
      Valitse alueet (ehdotukset tai oma nimi) — **mitään ei luoda ennen
      kuin painat "Tallenna alueet"**, eikä aluevaihetta voi ohittaa.
- [ ] 3. Vaihe 2: anna jokaiselle alueelle **tärkeys** (mitään ei ole
      valittu valmiiksi; kategorian kytkentä on erillinen valinta, joka
      kertoo montako tehtävää se toisi). Vaihe 3: **viikkotavoite**
      ([Ei tavoitetta] ≠ [0 – ei nyt]).
- [ ] 4. Vaihe 5 kertoo, mitä sinulla jo on ("Sinulla on jo N tehtävää,
      N tavoitetta ja N projektia …"). **Liitä olemassa oleva tavoite**
      alueeseen: aloituksen vaihe 5, tai Suunta → Tavoitteet → valitse
      tavoitteelle alue, tai Tavoitteet → muokkaa → **Elämänalue (Suunta)**.
      (Lomakkeiden "Kategoria" on eri asia kuin elämänalue.)
- [ ] 4b. **Tehtävän tavoiteliitos säilyy:** liitä yksi tämän viikon
      tehtävä tavoitteeseen (tehtävälomake → Tavoite) → sulje sovellus
      kokonaan → avaa → tehtävä on yhä tavoitteessa ja näkyy Suunnan alueen
      luvuissa. (Vaatii tehtävän tavoite-, projekti- ja määräaikasarakkeiden
      tallennuksen — F1.)
- [ ] 5. Vaihe 4: aseta **tämän viikon kapasiteetti** realistisesti
      (kentässä ei ole oletusarvoa).
- [ ] 6. Vaihe 6 / **Arvioi tehtäviä** / Tekeminen → **Arvioi kestot (N)**:
      arviojono näyttää **yhden tehtävän kerrallaan** (tänään ensin),
      [10 min] [30 min] [1 h] [2 h] [Muu…] [Ohita], "Kumoa" ja
      "Valmis tältä erää". Kaikkea ei tarvitse arvioida. Jos tällä
      viikolla ei ole päivättyjä tehtäviä, siirrä yksi tälle viikolle tai
      valitse jonossa "Näytä myös rästit".
- [ ] 6b. **Aloita ajanseuranta kysyy alueen** ennen käynnistystä ("Ei
      aluetta" on sallittu). Alueeton kirjaus näkyy Toteuma-listassa
      valinnalla **Liitä alueeseen**.

## B. Pysyvyys (tärkein osa)

- [ ] 7. **Sulje sovellus kokonaan** (pyyhkäise pois) ja avaa uudelleen:
      alueet, tärkeys, tavoite, kapasiteetti ja tavoitteen alue ovat tallessa.
- [ ] 8. **Ajastin:** aloita ajastin tehtävälle → sulje sovellus kokonaan →
      avaa → ajastin **yhä käynnissä** oikealla ajalla → pysäytä.
      Kirjaus näkyy **kerran** viikon listassa.
- [ ] 9. **Nopea kirjaus:** kirjaa aikaa ja kirjoita "Muu"-kenttään esim.
      **30** → "Kirjaa". (Korjattu tänä yönä: aiemmin selain hylkäsi 30.)
      Toista näppäimistöllä: kirjoita **25** ja paina **Enter** → kirjautuu
      25 min (ei ensimmäistä pikavalintaa 15 min).
- [ ] 10. **Suunta päivittyy:** kirjattu aika näkyy alueen toteumassa;
      havainnot (kuormitus / huomiotta jääminen / poikkeama) perustuvat
      tallennettuun dataan — sama näkymä latauksen jälkeen. Ensimmäisellä
      viikolla yksi tai kaksi kirjausta **ei** tee alueesta "huomiotta
      jäävää" (toteumaa verrataan vasta vakiintuneesta kirjauksesta), ja
      kun useimmilta tehtäviltä puuttuu kesto, havaintojen yläpuolella
      lukee ensin **"Suunnan arvio tarkentuu, kun lisäät aika-arvioita."**

## C. Ilman verkkoa (1 min)

- [ ] 11. **Lentotila päälle** → kirjaa 10 min → ilmoitus sanoo
      **"Tallentuu, kun yhteys palaa"** (ei "kirjattu") → sulje ja avaa
      sovellus → kirjaus **näkyy yhä** (korjattu tänä yönä) → lentotila
      pois → odota hetki → sama kirjaus näkyy **kerran**, ei kahdesti.

## D. Istunto ja ulkoasu

- [ ] 12. **Kirjaudu ulos ja takaisin:** kaikki tieto on tallessa, eikä
      ensikäytön opastus tai jo käyty Suunnan aloitus tule uudelleen.
- [ ] 13. **Ei vaakavieritystä** Suunta-, Tänään- ja kirjausdialogeissa
      puhelimen leveydellä; sovellus ei kaadu.
- [ ] 14. Avaa sama tili **selaimessa** (tuotanto-URL): samat alueet ja
      kirjaukset näkyvät.

## E. Viikkokatsaus (voi tehdä sunnuntaina)

- [ ] 15. Tee ensimmäinen **viikkokatsaus**, tallenna, lataa → se on
      historiassa. Katsauksen alussa lukee **Tiedossa / Ei tiedossa / Ei
      kirjattu**; kirjaamattomat päivät ovat "tuntemattomia, eivät nollaa",
      eikä ensimmäistä viikkoa verrata Suuntaa edeltäneeseen. Valitse ensi
      viikolle yksi muutos: esikatselu näyttää ennen/jälkeen, mitään ei muutu
      ilman vahvistusta.

---

**Valmis, kun kohdat 1–14 (ml. 4b, 6b) ovat OK.** Kohta 15 ei estä päivittäistä käyttöä.

## Tunnetut rajoitukset (eivät estä Day 1:tä)

| Rajoitus | Vaikutus | Luokka |
|---|---|---|
| Offline aloitettu ajastin ei siirry `running_timers`-tauluun myöhemmin | Toinen laite ei näe sitä; aika ei katoa eikä monistu | P1-korjaus |
| Toisella laitteella pysäytetty ajastin voi näkyä tällä laitteella käynnissä latauksen jälkeen | Pysäytys ei kirjaa kahdesti (operaatiotunniste) | P1-korjaus |
| "Varaa aikaa" -ehdotuksen voi toteuttaa uudelleen sivun latauksen jälkeen | Toinen samanlainen tehtävä | P1-korjaus |
| Kahden laitteen kilpailutilanne (sama viikon kapasiteetti / alueen nimi / viikon katsaus): jälkimmäinen tallennus ei mene läpi | Viesti kertoo syyn rajoitteen nimen mukaan (`describeError`, `CONFLICT_MESSAGES`), esim. "Tämän viikon kapasiteetti on jo tallennettu toisella laitteella. Päivitä näkymä ja yritä uudelleen." — ei enää yleistä virhettä | tunnettu (viesti korjattu) |
| Tallennetun katsauksen tilannekuva lasketaan uudelleen, jos katsaus tallennetaan uudelleen samalle viikolle | Historia päivittyy | PRODUCT_DECISION_REQUIRED |
| Avustajan kirjaus (aalto H) vaatii yhteyden | Epäonnistuu näkyvästi, ei valehtele | tunnettu |
| Puhe Android-sovelluksessa: aiemmissa APK:issa ei toimi (WebView'n tunnistimen mikrofonipyyntö menee `onPermissionRequest(AUDIO_CAPTURE)`-polkuun, Capacitor vaatii kaksi julistamatonta lupaa → `not-allowed`). Korjaus on koodissa: oma `ManifestivalSpeech`-liitännäinen, `RECORD_AUDIO` kysytään vasta napautuksesta. Ei laitetestattu | Suunta ei tarvitse puhetta; kirjoittaminen toimii aina | P1 |
| AI-selitys (`/api/explain`) ei ole käytössä | Deterministinen selitys näkyy aina | OPTIONAL DAY-1 |

## E2E: paikallinen selainajo (ennen puhelinta)

**Mitä:** `npm run e2e:suunta` (tai `node tools/e2e/run-suunta-e2e.mjs`)
ajaa Suunnan headless-Chromessa koneella. Vaatii Chromen tai Edgen
(`CHROME_PATH`). Vain vanhan käyttäjän ryhmä: `E2E_GROUPS=legacy`.
Kestää alle minuutin. Jos siivous kaatuu hetkelliseen EPERM-virheeseen,
aja uudelleen (tulos on jo tulostettu).

**Turvallisuus:** ei tuotantoa. `*.supabase.co` ja Anthropic estetään
DNS-tasolla, jokainen pyyntö kirjataan (yksikin tuotantopyyntö kaataa
ajon), debug-portti todennetaan vapaaksi ja profiili poistetaan.
supabase-js:ää ei ladata: kanta on paikallinen korvike
(`tools/e2e/fakeSupabase.mjs`), joka tallentaa rivit sivun
sessionStorageen, rajaa ne käyttäjään kuten RLS ja noudattaa
migraatioiden uniikki- ja viiteavaimia (23505, 23503, on delete set null).
Istunnossa ei ole tokenia, joten tekoälykutsuja ei lähde.

**Oikea käynnistys:** valjas liittää `index.html`:n rungon ja importoi
`src/app/main.js`:n: istunnon palautus, skeematarkistus, `loadUserData`,
`renderAll`, ensikäytön opastus — ei käsin kytkettyjä näkymiä.
Uudelleenlataus on oikea sivun lataus (`Page.reload`): `main.js`
käynnistyy uudelleen, laitteen ajastin ja lähtökori luetaan
localStoragesta ja `loadUserData` lukee kannan rivit.

**J-portit:** tämän haaran `src/data/schema.js`, jonka porttiliteraalit
korvataan aallon J arvoilla (`tools/e2e/gates.mjs`). Arvot luetaan
`rehearsal/wave-j-v2`:n schema.js:stä (tai `E2E_GATES_REF`) ja
verrataan junan määrittelyyn (`tools/release/waves.mjs`); ristiriita
keskeyttää ajon. Selain saa tiedoston import mapin kautta, eikä mikään
`src/`-tiedosto muutu. Ehdokkaan tiedostoa ei tarjoilla sellaisenaan
(siitä puuttuu tämän haaran ajonaikainen skeemakerros, jota repositoriot
importoivat), eikä ajoa tehdä J-työpuusta (J on leikattu ennen Day 1
-korjauksia, joten se ei ole koodi, jota tässä hyväksytään).

**Ryhmät:**

| Ryhmä | Kanta | Mitä todistaa |
|---|---|---|
| suljetut portit | tyhjä | aiemmat 17 skenaariota oikealla käynnistyksellä (Suunta muistissa) |
| J-portit | tyhjä | samat skenaariot tallentuvalla Suunnalla |
| J-portit, vanha käyttäjä | 36 tehtävää ilman kestoa (rästi / tämä / ensi viikko), 1 tavoite, 1 projekti tavoitteessa, profiili, ei alueita | tarkistuslistan kohdat 1–11 ja 15 koneella (alla) |

Vanhan käyttäjän ajo (kello: tämän viikon keskiviikko klo 10):

1. Lataus tuo 36 + 1 + 1 riviä; opastus suljetaan omalla painikkeellaan;
   Suunta avautuu aloitukseen 1/7; kuittaus "Sinulla on jo 36 tehtävää,
   1 tavoite ja 1 projekti"; ei huomiotta jäämis- eikä poikkeamaväitteitä;
   ei yhtään kirjoitusta tehtäviin, tavoitteisiin, projekteihin eikä
   Suunnan tauluihin (kohdat 1–2).
2. Alue "Terveys": tärkeyttä ei valittu valmiiksi, kategoria ei kytkeydy
   hiljaa, tallennus vasta valinnan jälkeen -> `life_areas` (kohta 3).
3. Kapasiteetti ilman oletusarvoa -> `weekly_capacities` (kohta 5).
4. Tavoite liitetään alueeseen vaiheessa 5 -> `goals.life_area_id`
   (kohta 4).
5. Arviojono: yksi tämän viikon tehtävä 30 min -> `duration_minutes`,
   muut 35 ennallaan (kohta 6).
6. Ajastin alueelle -> `running_timers`; kello +25 min; uudelleenlataus:
   sama ajastin käynnissä (0:25), alue, kapasiteetti, tavoitteen alue ja
   arvio tallessa, opastus ei palaa (kohdat 7–8).
7. Toinen laite: laitteen ajastinkopio poistetaan, uudelleenlataus ->
   ajastin palautuu kannasta.
8. Pysäytys (+15 min): `time_entries` 40 min kerran, lähde timer,
   0013-sarakkeet; Suunnan toteuma ja aluelista päivittyvät; ensimmäisen
   viikon kirjaus ei tee alueesta huomiotta jäävää (kohdat 8, 10).
9. Tehtävä liitetään tavoitteeseen tehtävälomakkeella, uudelleenlataus ->
   `goal_id` säilyy ja tehtävä näkyy alueen luvuissa (kohta 4b, F1).
10. Viikkokatsaus -> `alignment_reviews` (sääntöversio 3); ensi viikon
    esikatselu ei kirjoita, vahvistus kirjoittaa (kohta 15).
11. Enter "Muu"-kentässä kirjaa kirjoitetut 25 min kantaan (kohta 9).
12. Offline: 10 min lähtökoriin -> uudelleenlataus offline-tilassa ->
    kirjaus näkyy Toteuma-listassa -> yhteys palaa -> kannassa ja
    näkyvissä kerran (kohta 11).
13. Näppäimistö: Enter "Tauko"-painikkeella pitää fokuksen ajastinpalkissa.
    **ODOTTAA** saavutettavuuspakettia (CRIT-03, `renderTimerBar`): ajo
    näyttää rivin ODOTTAA eikä kaadu. Kun korjaus on integroitu, rivi
    onnistuu ja ajo kaatuu viestiin "poista PENDING_ON-merkintä" —
    poista merkintä `run-suunta-e2e.mjs`:stä.

**Ensimmäisen ajon löydökset (korjattu tässä haarassa):**

- Talousnäkymän yleiskatsaus heitti `ReferenceError`in jokaisessa
  piirrossa (aallosta F alkaen): `renderAll` katkesi siihen, eikä
  profiili, ilmoitusasetukset eikä ilmoituskeskus päivittynyt.
  Regressiotesti: `tests/finance-overview-render.test.mjs`.
- Aloituksen vaihe 4: "Tallenna" jäi pois käytöstä kapasiteettia
  kirjoitettaessa; kosketuskäyttäjä ei päässyt vaiheesta eteenpäin.
  Regressiotesti: `tests/suunta-setup-primary-button.test.mjs`.

**Ajettu:** 2026-09-26, integroitu tuotehaara (kaikki paketit ja
katselmoinnin korjaukset), J-portit `rehearsal/wave-j-v2` (cba9463):
PASS 54/54 (18 suljetuilla porteilla, 18 J-porteilla, 16 J-porteilla
vanhana käyttäjänä), 0 pyyntöä tuotantoon, 0 konsolivirhettä. Aja
uudelleen, jos tuotehaara tai J-ehdokas muuttuu, ja kirjaa tulos tähän.

**Mitä E2E EI todista — LIVE_USE_VALIDATION_PENDING:**

- Oikea Supabase: RLS-politiikat, CHECK-rajoitteet, liipaisimet,
  PostgRESTin skeemavälimuisti ja virhemuodot (korvike mallintaa vain
  uniikki- ja viiteavaimet; skeematarkistus saa aina "kunnossa").
- Oikea verkko ja lentotila: viive, aikakatkaisut, puolikkaat vastaukset.
  Offline on simuloitu sivulla (`navigator.onLine` + korvikkeen
  verkkovirhe); sivu itse latautuu paikalliselta palvelimelta eikä
  service workerin välimuistista.
- Android-APK ja WebView: sovelluksen sulkeminen, natiivi resume/pause,
  Capacitor-liitännäiset, puhelimen näppäimistö ja kosketus,
  ruudunlukija.
- Kirjautuminen, tokenin uusiutuminen, uloskirjautuminen ja toinen tili
  (istunto on tekaistu), sekä kaksi oikeaa laitetta samanaikaisesti.
- Omistajan oikea data (siemen vastaa sen muotoa, ei sisältöä) ja
  aikavyöhykkeen tai kesäajan vaihde.
- Tekoälyselitys ja avustajan kutsut (ei tokenia).

Nämä kuitataan yllä olevilla kohdilla 1–15 oikealla laitteella aallon J
jälkeen.
