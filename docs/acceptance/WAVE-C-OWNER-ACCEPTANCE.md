# Aalto C — omistajan hyväksyntä (tiivis, ~10 min)

> **Tila 2026-09-26: `LIVE_USE_VALIDATION_PENDING` — ei enää junan portti.**
> Omistajan päätöksellä tämä lista tehdään oikeassa käytössä; se ei estä
> aaltoa D eikä sitä merkitä PASSiksi. Junan portti on C:n
> `AUTOMATED_TECHNICAL_ACCEPTANCE`, joka kirjataan live-todennuksesta:
> `npm run production:verify-assets -- --wave=C --sha=cf259d0ef755f7e875cc9cd9c15405eba632e408 --record-acceptance`.
> Politiikka: [`docs/activation/AUTOMATED-ACCEPTANCE-POLICY.md`](../activation/AUTOMATED-ACCEPTANCE-POLICY.md).

**Tilanne:** aalto C on **deployattu** (`origin/main` = `cf259d0`, v16) mutta
**ei hyväksytty**. Tuotannon tarjoilemat tiedostot todennettu 2026-09-25
yöllä: `npm run production:verify-assets -- --wave=C` → **21/21 PASS**
(v16, täsmälleen aallon C kuusi porttia auki).

Tämä tiivistää `docs/acceptance/WAVE-C.md`:n (korjattu versio haarassa
`docs/wave-c-acceptance-fixes`, `9b40c75`) yhdeksi listaksi. Käyttöliittymän
nimet on tarkistettu tuotannossa olevasta koodista (`cf259d0`).

Tee kaikki tuotantosovelluksessa omalla tililläsi. Luo vain alla mainitut
testirivit — ne ovat tavallista dataa, ja voit poistaa ne lopuksi.

---

## 1. Rutiinit (Tekeminen → Rutiinit)

- [ ] **Luo:** "Lisää rutiini" → "Mikä toistuu?" `Testi C`, Toisto
      *Valitut päivät* (ma + ke), Kellonaika `07:30`, Kesto `15` → **Tallenna**
- [ ] **Lataa sivu (F5).** `Testi C` on listassa; avaa rivi → päivät ma+ke,
      07:30 ja 15 min ovat tallessa
- [ ] **Muokkaa:** vaihda kesto `20` → **Tallenna muutokset**
- [ ] **Lataa sivu (F5).** Kesto on `20`
- [ ] Rivin **kytkin** pois → F5 → yhä pois → takaisin päälle

## 2. Poikkeus (Tänään)

- [ ] Luo toinen rutiini, joka osuu **tälle päivälle** (Toisto *Päivittäin*)
- [ ] Tänään-näkymässä paina rutiiniesiintymän vieressä **"Ohita"**
- [ ] **Lataa sivu (F5).** Esiintymä ei näy tänään (ei Tänään- eikä Viikko-näkymässä)

> "Ohita" on ainoa tapa luoda poikkeus selaimesta. Ohitusta ei voi perua
> selaimesta (ks. WAVE-C.md) — käytä tähän testirutiinia, älä oikeaa.

## 3. Regressio (aallot A ja B)

- [ ] **Tavoitteet → Tavoitteet:** avaa olemassa oleva tavoite, tallenna, F5 → ennallaan
- [ ] **Tavoitteet → Projektit:** sama projektille
- [ ] **Profiili → Muistutukset:** vaihda "Enintään/vrk" → tallennus → F5 → säilyi (palauta arvo)
- [ ] **Tänään → Hyvinvointi:** kirjaa tälle päivälle → F5 → säilyi
- [ ] Selaimen konsolissa (F12) ei punaisia virheitä

## 4. Tietokanta (Supabase → SQL Editor, postgres-rooli, uusi välilehti)

1. [ ] `supabase/acceptance/precheck_0003_0008_auth_final.sql` → **6/6 PASS**, `failures_total = 0`
2. [ ] `supabase/acceptance/verify_0003_0008_post_activation.sql` → **`failures_total = 0`**
      - tarkistus 32 (orpoja poikkeuksia ei ole) PASS
      - tarkistus 47 (tehtävien lukumäärä) ei kasvanut itsestään

> Käytä `verify_0003_0008_post_activation.sql`:ää, **ei**
> `…_post_acceptance_final.sql`:ää: jälkimmäinen vaatii porttitaulujen
> olevan tyhjiä ja kuuluu aktivointia edeltävään vaiheeseen.
> Jos näet "Success. No rows returned", editorissa oli tekstiä valittuna —
> poista valinta ja aja koko tiedosto.

## 5. Valmis, kun

- [ ] Kohdat 1–4 kaikki OK → kerro Claudelle, niin käyttötodennus kirjataan
      muistiinpanoksi. Tämä **ei** ole aallon D edellytys (D:n avaa
      omistajan viesti "hyväksyn D" ja C:n tekninen hyväksyntä).

**Jos jokin epäonnistuu:** älä jatka aaltoon D. Kerro Claudelle mikä
kohta. Peruutus (vain jos tallennus ei toimi) on `git revert` +
**uusi, suurempi** `CACHE_VERSION` — huomaa, että se vie aallon D varaaman
`v17`:n, jolloin aaltojen D–J numerot siirtyvät yhdellä ja kandidaatit on
numeroitava uudelleen. Siksi peruutus on oma päätöksensä, ei refleksi.
Kantaan syntyneet rivit säilyvät peruutuksessa.
