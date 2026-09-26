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
| Kahden laitteen kilpailutilanne (sama viikon kapasiteetti / alueen nimi) näyttää yleisen virheen | Lataa sivu ja yritä uudelleen | P1 |
| Tallennetun katsauksen tilannekuva lasketaan uudelleen, jos katsaus tallennetaan uudelleen samalle viikolle | Historia päivittyy | PRODUCT_DECISION_REQUIRED |
| Avustajan kirjaus (aalto H) vaatii yhteyden | Epäonnistuu näkyvästi, ei valehtele | tunnettu |
| Puhe Android-sovelluksessa: aiemmissa APK:issa ei toimi (WebView'n tunnistimen mikrofonipyyntö menee `onPermissionRequest(AUDIO_CAPTURE)`-polkuun, Capacitor vaatii kaksi julistamatonta lupaa → `not-allowed`). Korjaus on koodissa: oma `ManifestivalSpeech`-liitännäinen, `RECORD_AUDIO` kysytään vasta napautuksesta. Ei laitetestattu | Suunta ei tarvitse puhetta; kirjoittaminen toimii aina | P1 |
| AI-selitys (`/api/explain`) ei ole käytössä | Deterministinen selitys näkyy aina | OPTIONAL DAY-1 |
