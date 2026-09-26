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

- [ ] 1. **Kirjaudu** sovellukseen. Tänään-näkymä aukeaa.
- [ ] 2. **Suunta → luo elämänalue** omalla nimelläsi (ehdotukset ovat vain
      ehdotuksia — mitään ei luoda ilman sinun painallustasi).
- [ ] 3. Anna alueelle **tärkeys** ja **viikkotavoite** (tunteja).
      Luo halutessasi 2–4 aluetta lisää.
- [ ] 4. **Liitä olemassa oleva tavoite** alueeseen (Tavoitteet →
      tavoite → elämänalue).
- [ ] 5. Aseta **tämän viikon kapasiteetti** realistisesti.
- [ ] 6. Lisää **kestoarvio** yhteen tämän viikon tehtävään (arvion
      työnkulku kysyy puuttuvat).

## B. Pysyvyys (tärkein osa)

- [ ] 7. **Sulje sovellus kokonaan** (pyyhkäise pois) ja avaa uudelleen:
      alueet, tärkeys, tavoite, kapasiteetti ja tavoitteen alue ovat tallessa.
- [ ] 8. **Ajastin:** aloita ajastin tehtävälle → sulje sovellus kokonaan →
      avaa → ajastin **yhä käynnissä** oikealla ajalla → pysäytä.
      Kirjaus näkyy **kerran** viikon listassa.
- [ ] 9. **Nopea kirjaus:** kirjaa aikaa ja kirjoita "Muu"-kenttään esim.
      **30** → "Kirjaa". (Korjattu tänä yönä: aiemmin selain hylkäsi 30.)
- [ ] 10. **Suunta päivittyy:** kirjattu aika näkyy alueen toteumassa;
      havainnot (kuormitus / huomiotta jääminen / poikkeama) perustuvat
      tallennettuun dataan — sama näkymä latauksen jälkeen.

## C. Ilman verkkoa (1 min)

- [ ] 11. **Lentotila päälle** → kirjaa 10 min → ilmoitus sanoo
      **"Tallentuu, kun yhteys palaa"** (ei "kirjattu") → sulje ja avaa
      sovellus → kirjaus **näkyy yhä** (korjattu tänä yönä) → lentotila
      pois → odota hetki → sama kirjaus näkyy **kerran**, ei kahdesti.

## D. Istunto ja ulkoasu

- [ ] 12. **Kirjaudu ulos ja takaisin:** kaikki tieto on tallessa.
- [ ] 13. **Ei vaakavieritystä** Suunta-, Tänään- ja kirjausdialogeissa
      puhelimen leveydellä; sovellus ei kaadu.
- [ ] 14. Avaa sama tili **selaimessa** (tuotanto-URL): samat alueet ja
      kirjaukset näkyvät.

## E. Viikkokatsaus (voi tehdä sunnuntaina)

- [ ] 15. Tee ensimmäinen **viikkokatsaus**, tallenna, lataa → se on
      historiassa. Valitse ensi viikolle yksi muutos: esikatselu näyttää
      ennen/jälkeen, mitään ei muutu ilman vahvistusta.

---

**Valmis, kun kohdat 1–14 ovat OK.** Kohta 15 ei estä päivittäistä käyttöä.

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
