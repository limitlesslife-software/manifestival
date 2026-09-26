# Aalto I — Suunta: elämänalueet, kapasiteetti, toteuma ja viikkokatsaus

**Portit:** `lifeAreas`, `weeklyCapacities`, `timeEntries`, `alignmentReviews`
**Sarakeportti:** `GOAL_LIFE_AREA_FIELD` (`goals.life_area_id`)
**Taulut:** `life_areas`, `weekly_capacities`, `time_entries`, `alignment_reviews`
**Välimuistiversio:** `v22`
**Edellinen tuotanto:** aallon H commit (v21)
**Peruutuskohde:** aalto H

**Push-kohde (deployTarget):** junan lukon `docs/activation/release-train-c-j.json`
aallon I `deployTarget` — täysi 40-merkkinen SHA, sama kuin kohdan
"Deploy" push-rivillä. Manifestin (`docs/activation-0003-0008-release-manifest.json`)
`commitSha` on aallon AALTOCOMMIT: peruutuksen ja diffin viite, EI push-kohde.
Push tehdään orkestroijalla (`npm run activation:orchestrate -- --execute-deploy
--approved-sha=<deployTarget>`), joka tarkistaa ensin, että `origin`in main on
yhä odotettu edellinen SHA.

**Hyväksyntä (omistajan päätös 2026-09-26):** junan portti on koneellinen
`AUTOMATED_TECHNICAL_ACCEPTANCE` — ehdot, komennot ja kirjauspaikka:
[`docs/activation/AUTOMATED-ACCEPTANCE-POLICY.md`](../activation/AUTOMATED-ACCEPTANCE-POLICY.md). Kohdan 4 selainhyväksyntä on
`LIVE_USE_VALIDATION_PENDING`: se tehdään oikeassa käytössä, **ei estä junaa
eikä ole koskaan PASS**. Omistajan viesti **"hyväksyn 0012/I"** avaa migraation 0012 ja deployn.

---

## LÄHTÖTILANNE: kanta puuttuu (ESTETTY)

Tätä aaltoa **ei saa vielä deployata**.

Migraatiota `0012_life_alignment.sql` ei ole ajettu tuotantoon. Portin
avaaminen tauluun jota ei ole kaataa jokaisen kirjoituksen virheeseen
`42P01`, ja sarakeportin avaaminen ennen migraatiota kaataisi jokaisen
**tavoitteen** tallennuksen virheeseen `42703` — myös niiden, jotka
toimivat tänään.

Käyttöliittymä on olemassa:

| Portti | Näkymä | Polku |
|---|---|---|
| `lifeAreas` | `src/app/views/direction.js` | Suunta → Elämänalueet |
| `weeklyCapacities` | `src/app/views/direction.js` | Suunta → Tämä viikko → Kapasiteetti |
| `timeEntries` | `src/app/views/direction.js` | Suunta → Toteuma |
| `alignmentReviews` | `src/app/views/direction.js` | Suunta → Viikkokatsaus |

Valmiustilaa **ei kirjoiteta käsin**: `tests/ui-reachability.test.mjs`
johtaa sen `tools/release/reachability.mjs` -matriisista.

**Aalto on riippumaton aalloista F–H.** Migraatio `0012` vaatii vain
0001, 0002, 0004 ja 0007 (tavoitteet, tehtävät ja niiden omistajan rivin
avaimet), jotka ovat tuotannossa. Aaltojen järjestys junassa on silti
F → G → H → I: aaltoa ei avata ohi edeltäjiensä.

---

## Mitä esteen purkaminen vaatii

1. Panun kirjallinen hyväksyntä migraatiolle `0012`
2. **Varmuuskopio**
3. Vain lukeva inventaario: `supabase/acceptance/activation_readonly_inventory.sql`
   (rivi 00 Claudelle; `node tools/activation/score-inventory.mjs`)
4. Migraation esitarkistus (vain lukeva, tiedoston lopussa):
   - `uudet_taulut` = **0**
   - `goals_sarake` = **0**
   - `omistajan_avaimet` = **2**
   - `pg15_tai_uudempi` = **true**
5. Migraation ajo `postgres`-roolilla Supabasen SQL-editorissa
6. `supabase/verify/verify_0012.sql` → **poikkeavia_yhteensa = 0**

---

## Migraation vaikutus olemassa olevaan dataan

Migraatio **luo neljä uutta tyhjää taulua** ja **lisää yhden nullable
sarakkeen** `goals`-tauluun ilman oletusarvoa. PostgreSQL:ssä tämä on
luettelomuutos: rivejä ei kirjoiteta uudelleen eikä täyttöä tehdä.
Jokainen olemassa oleva tavoite näkyy Suunnassa kohdassa **"Ei
elämänaluetta"**, kunnes käyttäjä itse liittää sen.

`goals`-tauluun otetaan hetkeksi `ACCESS EXCLUSIVE` -lukko. Aja
hiljaisena aikana; `lock_timeout = 5s` keskeyttää ajon ennemmin kuin
jättää kirjautumiset jonoon.

Migraation vaihe 6 todistaa ennen committia, ettei yhtään tavoitetta
liitetty alueeseen ja että `tasks`-, `goals`- ja `projects`-taulujen
politiikat ovat ennallaan (12).

---

## KOLME ASIAA, JOITA TÄMÄ AALTO EI TEE

### 1. Havaintoja ei tallenneta

Kuormitus, huomiotta jääminen ja poikkeama tavoitteista **lasketaan**
lähdefaktoista (`src/domain/alignment.js`). Tallennettu havainto olisi
toinen totuus, joka vanhenee heti kun tehtävä siirtyy.
`verify_0012.sql` **tarkistus 13** etsii havaintotaulua, jota ei saa olla.

Ainoa tallennettu johdos on viikkokatsauksen **tilannekuva**, ja se on
tarkoituksella historiaa (`snapshot_version`).

### 2. Toteumaa ei keksitä

`time_entries.source` sallii vain arvon `manual`. Arviota ei kopioida
toteumaksi, eikä valmiiksi merkitty tehtävä tuota kirjausta.
**Tarkistus 21.**

### 3. Tekoäly ei päätä mitään

Havainnot ovat deterministisiä sääntöjä. Tekoäly saa enintään selittää
valmiin havainnon minimoidulla kontekstilla (ei tehtävien otsikoita,
ei pohdintoja).

---

## 1. Ennen deployta

```
git rev-parse origin/main          # oltava aallon H SHA
npm run activation:verify-wave -- I
npm run activation:preflight -- --wave=I
npm test && npm run check && npm run smoke && npm run build:web
```

- [ ] **Migraatio 0012 on ajettu ja `verify_0012.sql` antoi 0 poikkeavaa**
- [ ] **Varmuuskopio on otettu ennen migraatiota**
- [ ] Kaikki kaksikymmentäkaksi porttia auki
- [ ] `GOAL_LIFE_AREA_FIELD` on `true`
- [ ] `TASK_EXTENDED_FIELDS` ja `GOAL_PLANNING_FIELDS` yhä `true`
- [ ] `CACHE_VERSION` on `v22`

### Diffin tarkistus

```
git diff <WAVE-H-SHA>..<WAVE-I-SHA> --stat
```

Vain `src/data/schema.js`, `sw.js`, `docs/PRODUCTION-STATUS.md`.

---

## 2. Deploy

Omistajan viesti **"hyväksyn 0012/I"** kattaa migraation 0012 ja tämän askeleen.
Deploy vasta, kun `verify_0012.sql` = 0 poikkeavaa; tulos annetaan
orkestroijalle (`--verify-result`). Ensisijainen (ja ainoa suositeltu)
deploy-askel on orkestroija: se tarkistaa lukon, tuotannon aallon teknisen
hyväksynnän, ehdokkaan kirjatun testiajon ja käynnistyssavun sekä julkaisun esitarkistuksen,
tekee compare-and-swapin, pushaa ja todentaa tuotannon:

```
# STOP I — TRAIN_RECUT_REQUIRED: lukon deployTarget 4cfb4bc ei sisällä pakollista korjausta 5aa0d53; ei push- eikä deploy-komentoa ennen uudelleenleikkausta (leikkaa, sitten node tools/activation/train-map.mjs --write ja --sync-docs) [deploy --verify-result=<verify_0012-tulos>]
```

Viitteeksi (älä aja käsin): orkestroija ajaa compare-and-swapin jälkeen
täsmälleen tämän — ei koskaan forcea:

```
# STOP I — TRAIN_RECUT_REQUIRED: lukon deployTarget 4cfb4bc ei sisällä pakollista korjausta 5aa0d53; ei push- eikä deploy-komentoa ennen uudelleenleikkausta (leikkaa, sitten node tools/activation/train-map.mjs --write ja --sync-docs) [push]
```

---

## 3. Deployn jälkeen — koneellinen

```
npm run production:verify-assets -- --wave=I
```

- [ ] HTTP 200, `CACHE_VERSION` `v22`
- [ ] Kaikki kaksikymmentäkaksi porttia `true`

---

## 4. Selainhyväksyntä

> **`LIVE_USE_VALIDATION_PENDING`** (omistajan päätös 2026-09-26): tämä osio
> tehdään oikeassa käytössä. Se **ei estä junaa** eikä sitä merkitä koskaan
> PASSiksi; junan portti on `AUTOMATED_TECHNICAL_ACCEPTANCE` ([`docs/activation/AUTOMATED-ACCEPTANCE-POLICY.md`](../activation/AUTOMATED-ACCEPTANCE-POLICY.md)).

Jokainen kohta tarkistetaan **sivun latauksen jälkeen** — se on ainoa
tapa erottaa tallennus muistista.

### Ensin: mikään ei saa olla rikki

- [ ] Tehtävät, tavoitteet, projektit ja rutiinit toimivat
- [ ] **Vanha tavoite tallentuu yhä** (sarakeportti)
- [ ] Vanhat rivit näkyvät ennallaan

### Suunta

- [ ] Luo elämänalue, aseta tärkeys ja viikkotavoite → säilyy latauksen yli
- [ ] Samanniminen toinen alue hylätään
- [ ] Liitä tavoite alueeseen → säilyy; tavoitteen tehtävät lasketaan alueelle
- [ ] Liittämätön tavoite näkyy kohdassa "Ei elämänaluetta"
- [ ] Aseta viikon kapasiteetti → suunniteltu vs. kapasiteetti näkyy
- [ ] Suunnitelma yli kapasiteetin → **Kuormitus**-havainto, jossa luvut
- [ ] Arvioimaton tehtävä näkyy arvioimattomana, **ei nollana**
- [ ] Kirjaa aikaa → toteuma näkyy; poista alue → kirjaus säilyy ilman aluetta
- [ ] Viikkokatsaus tallentuu; aiempi viikko on luettavissa
- [ ] Muutosehdotus **ei muuta mitään** ennen vahvistusta

### Aiemmat aallot

- [ ] Aaltojen A–H ominaisuudet toimivat kaikki yhä

---

## 5. Tietokannan hyväksyntä

1. `precheck_0003_0008_auth_final.sql` → **6/6 PASS**
2. `verify_0003_0008_post_activation.sql` → **failures_total = 0**
3. `verify_0009.sql`, `verify_0010.sql`, `verify_0011.sql` → **poikkeavia_yhteensa = 0**
4. `verify_0012.sql` → **poikkeavia_yhteensa = 0**

| Tarkistus (verify_0012) | Odotus |
|---|---|
| 10 — `goals.life_area_id` nullable ilman oletusta | PASS |
| 13 — havaintotaulua ei ole | PASS |
| 21 — `time_entries.source` sallii vain manual | PASS |
| 24 — viitteet kahdella sarakkeella | PASS |
| 25 — SET NULL rajaa nollauksen yhteen sarakkeeseen | PASS |
| 26 — yksikään uusi viite ei ole CASCADE sovellustauluun | PASS |
| 36 — PUBLIC-roolilla ei ole oikeuksia | PASS |
| 44 — `tasks`, `goals` ja `projects` yhä 12 politiikkaa | PASS |
| 46–53 — rivimäärät ja ympäristö | INFO |

---

## 6. Peruutus

**Laukaisin:**

- tavoitteen tallennus epäonnistuu (sarakeportti)
- elämänalueen, kapasiteetin tai kirjauksen tallennus epäonnistuu
- havainto näkyy ilman lukuja tai väärillä luvuilla
- muutosehdotus muuttaa dataa ilman vahvistusta
- `failures_total > 0` tai `poikkeavia_yhteensa > 0`

**Toimenpide:**

```
git revert --no-edit <WAVE-I-SHA>
# revert-commitissa: nosta CACHE_VERSION v22 -> v23
git push origin HEAD:main
```

Palauttaa **aallon H** tilan.

> **Kantaa ei peruuteta ensin.** Porttien sulkeminen riittää: taulut ja
> sarake jäävät paikoilleen ja sovellus lakkaa kirjoittamasta niihin.
> Kannan peruutus on erikseen migraatiotiedoston lopussa, ja se poistaa
> käyttäjän elämänalueet, kirjaukset ja katsaukset pysyvästi.

---

## 7. Aallon jälkeen

- [ ] `docs/PRODUCTION-STATUS.md` päivitetty: aalto I, neljä porttia ja sarakeportti
- [ ] `docs/LIFE-ALIGNMENT.md` päivitetty: tila ESTETTY → tuotannossa
- [ ] Laitehyväksyntä: `docs/DEVICE-ACCEPTANCE-BACKLOG.md`, osio "Suunta"
