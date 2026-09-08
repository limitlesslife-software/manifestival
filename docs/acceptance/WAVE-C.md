# Aalto C — rutiinit ja poikkeukset

**Portit:** `routines`, `routineExceptions`
**Taulut:** `routines`, `routine_exceptions`
**Välimuistiversio:** `v15`
**Edellinen tuotanto:** aallon B commit (v14)
**Peruutuskohde:** aalto B

Aallon commit-SHA: ks. `docs/activation-0003-0008-release-manifest.json`.

---

## Miksi C on kolmantena

`routines.goal_id → goals (user_id, id)`, joten **aalto B on oltava
ensin**. `routine_exceptions` viittaa rutiiniin
(`routine_exceptions.routine_id → routines`), joten ne kuuluvat samaan
aaltoon.

Poikkeuksen viite rutiiniin on ainoa `CASCADE`-viite koko skeemassa —
kaikki muut ovat `SET NULL`. Se on tarkoituksellista: poikkeus ilman
rutiinia ei tarkoita mitään.

---

## 1. Ennen deployta

```
git rev-parse origin/main          # oltava aallon B SHA
npm run activation:verify-wave -- C
npm run activation:preflight -- --wave=C
npm test && npm run check && npm run smoke && npm run build:web
```

- [ ] Auki: aallot A + B + `routines`, `routineExceptions` (kuusi porttia)
- [ ] Kiinni: neljä
- [ ] `CACHE_VERSION` on `v15`

### Diffin tarkistus

```
git diff <WAVE-B-SHA>..<WAVE-C-SHA> --stat
```

Vain `src/data/schema.js`, `sw.js`, `docs/PRODUCTION-STATUS.md`.

---

## 2. Deploy

```
git push origin <WAVE-C-SHA>:main
```

---

## 3. Deployn jälkeen — koneellinen

```
npm run production:verify-assets -- --wave=C
```

- [ ] HTTP 200, `CACHE_VERSION` `v15`, kuusi porttia auki

---

## 4. Selainhyväksyntä

### Rutiinit

- [ ] Rutiinin luonti säilyy sivun latauksen yli
- [ ] Toistuvuus tallentuu oikein: päivittäin, arkisin, valitut viikonpäivät
- [ ] Valittujen viikonpäivien joukko säilyy täsmälleen
- [ ] Toivottu kellonaika tallentuu
- [ ] Kesto tallentuu
- [ ] Aikataulutustapa (kiinteä / joustava) tallentuu
- [ ] Aktiivisuuden kytkeminen pois ja takaisin säilyy
- [ ] Alkamis- ja päättymispäivä tallentuvat, tyhjä pysyy tyhjänä
- [ ] Rutiinin liittäminen **tavoitteeseen** (aalto B) toimii ja säilyy

### Poikkeukset

- [ ] Yksittäisen päivän ohitus (`skip`) tallentuu ja säilyy
- [ ] Ohitettu päivä **ei näy** päivänäkymässä latauksen jälkeen
- [ ] Siirretty tai muokattu esiintymä tallentuu
- [ ] Poikkeuksen poisto palauttaa päivän normaaliksi
- [ ] **Sama rutiini, sama päivä, toinen poikkeus** → sovellus käsittelee
      hallitusti (päivitys tai selkeä virhe), ei hiljaista epäonnistumista

### Cascade — aallon C tärkein tarkistus

- [ ] Luo rutiini ja sille **vähintään kaksi poikkeusta**
- [ ] **Poista rutiini**
- [ ] Lataa sivu — rutiini on poissa
- [ ] SQL-varmistuksen tarkistus **32** on PASS: orpoja poikkeuksia ei ole

> Poikkeukset poistuvat rutiinin mukana `on delete cascade` -säännöllä.
> Jos ne jäisivät, ne olisivat orpoja rivejä joihin ei pääse käsiksi
> käyttöliittymästä — ja tarkistus 32 kaatuisi.

### Päivärajat

- [ ] Luo rutiini kellonajalle lähellä keskiyötä (esim. 23:30)
- [ ] Tarkista, että se näkyy oikeana päivänä päivä- ja viikkonäkymässä
- [ ] Ohita se päivä poikkeuksella ja tarkista, että ohitus osuu oikeaan päivään

### Ei odottamatonta tehtävägenerointia

- [ ] Rutiinin luonti **ei** luo tehtäviä `tasks`-tauluun
- [ ] Tarkista SQL-varmistuksen tarkistus **47**: tehtävien lukumäärä on
      sama kuin ennen aaltoa C (plus vain ne jotka loit käsin)

### Yleinen

- [ ] Aaltojen A ja B ominaisuudet toimivat yhä
- [ ] Konsolissa ei virheitä

---

## 5. Tietokannan hyväksyntä

1. `precheck_0003_0008_auth_final.sql` → **6/6 PASS**
2. `verify_0003_0008_post_activation.sql` → **failures_total = 0**

| Tarkistus | Odotus |
|---|---|
| 23 — poikkeuksen viite rutiiniin on CASCADE | PASS |
| 32 — orpoja poikkeuksia ei ole | PASS, **aallon C ydin** |
| 47 — tehtävien lukumäärä | INFO, ei saa kasvaa itsestään |
| 50 — aallot rivimäärinä | INFO, muotoa `2 / 2 / 3 / 0 / 0` |

---

## 6. Tunnettu jälkikovennus — ei estä

`routine_exceptions_unique_day` on `unique (routine_id, date)` eikä
`(user_id, routine_id, date)`. Ristiinkiinnitys on estetty
yhdistelmävierasavaimella, mutta rajoitteiden tarkistusjärjestyksestä
seuraa **yhden bitin olemassaolovuoto** kahden käyttäjän tilanteessa.

Tuotannossa on yksi käyttäjä, joten vuoto ei ole tällä hetkellä
mielekäs.

**Ei estä aallon C aktivointia.** Analyysi, korjausehdotus ja
peruutussuunnitelma: `docs/FOLLOWUP-routine-exceptions-uniqueness.md`.

Jos tuotantoon lisätään toinen oikea käyttäjä, nosta prioriteettia.

---

## 7. Peruutus

**Laukaisin:**

- rutiini tai poikkeus ei säily latauksen yli
- rutiinin poisto jättää orpoja poikkeuksia (tarkistus 32 FAIL)
- ohitettu päivä näkyy silti
- rutiinin luonti synnyttää tehtäviä joita kukaan ei pyytänyt
- aaltojen A tai B ominaisuus lakkaa toimimasta
- `failures_total > 0`

**Toimenpide:**

```
git revert --no-edit <WAVE-C-SHA>
# revert-commitissa: nosta CACHE_VERSION v15 -> v16
git push origin HEAD:main
```

Palauttaa **aallon B** tilan. Kantaan syntyneet rutiinit ja poikkeukset
jäävät paikoilleen.

---

## 8. Portti seuraavaan aaltoon

- [ ] Koneellinen todennus PASS
- [ ] Selainhyväksyntä läpi, myös cascade-tarkistus
- [ ] `failures_total = 0`
- [ ] Vähintään yksi rutiini ja yksi poikkeus olemassa
- [ ] Tehtävien lukumäärä ei kasvanut itsestään
- [ ] `docs/PRODUCTION-STATUS.md` päivitetty
