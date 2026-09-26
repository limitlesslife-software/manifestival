# Aalto E — AI-toimintojen kirjausketju

**Portti:** `aiAudit`
**Taulu:** `ai_action_audit`
**Välimuistiversio:** `v18`
**Edellinen tuotanto:** aallon D commit (v17)
**Peruutuskohde:** aalto D

**Push-kohde (deployTarget):** junan lukon `docs/activation/release-train-c-j.json`
aallon E `deployTarget` — täysi 40-merkkinen SHA, sama kuin kohdan
"Deploy" push-rivillä. Manifestin (`docs/activation-0003-0008-release-manifest.json`)
`commitSha` on aallon AALTOCOMMIT: peruutuksen ja diffin viite, EI push-kohde.
Push tehdään orkestroijalla (`npm run activation:orchestrate -- --execute-deploy
--approved-sha=<deployTarget>`), joka tarkistaa ensin, että `origin`in main on
yhä odotettu edellinen SHA.

---

## LUE TÄMÄ ENSIN: aalto E ei kirjoita mitään

Sovelluksessa **ei ole kirjoituspolkua** `ai_action_audit`-tauluun.

Koko lähdepuussa on tasan yksi kutsu:

```
src/app/actions.js:111   aiAuditRepo.list()
```

`aiAuditRepo.insert()`, `.update()` ja `.remove()` eivät esiinny
`src/`-puussa kertaakaan. Repositorio, sen rivimuunnos ja kannan taulu
ovat valmiit ja todennetut, mutta **mikään ei kutsu niitä**.

### Mitä portin avaaminen siis tekee

| Ennen | Jälkeen |
|---|---|
| `aiAuditRepo.list()` lukee muistivarastosta (aina tyhjä) | `aiAuditRepo.list()` lukee kannasta (aina tyhjä) |

Se on koko muutos. Yksi luku muuttuu muistista kannaksi.

### Mitä tämä tarkoittaa hyväksynnälle

- **Aalto E on junan vähäriskisin.** Se ei voi tuottaa vääriä rivejä,
  koska se ei tuota rivejä.
- **Aallolle E ei voi luoda hyväksyntädataa käyttöliittymästä.**
  Muiden aaltojen hyväksyntä nojaa siihen, että luot rivin ja tarkistat
  että se säilyy. Täällä ei ole mitään luotavaa.
- **Kirjausketju ei ole vielä toiminnassa.** Jos AI-komentojen
  kirjaaminen on tarkoitus saada käyttöön, se vaatii oman pakettinsa:
  kirjoituskutsut komentopolkuun ja niiden todennus. Portin avaaminen
  on sen esiehto, ei toteutus.

Tämä ei ole vika eikä este. Se on tila, ja se on syytä tietää ennen
kuin aaltoa E arvioidaan.

---

## 1. Ennen deployta

```
git rev-parse origin/main          # oltava aallon D SHA
npm run activation:verify-wave -- E
npm run activation:preflight -- --wave=E
npm test && npm run check && npm run smoke && npm run build:web
```

- [ ] **Kaikki kymmenen porttia auki**
- [ ] `TASK_EXTENDED_FIELDS` yhä `true`
- [ ] `CACHE_VERSION` on `v18`

### Diffin tarkistus

```
git diff <WAVE-D-SHA>..<WAVE-E-SHA> --stat
```

Vain `src/data/schema.js`, `sw.js`, `docs/PRODUCTION-STATUS.md`.

---

## 2. Deploy

```
git push origin 86c4325b00e8d58913afebdd0f1eca95d430174e:refs/heads/main
```

---

## 3. Deployn jälkeen — koneellinen

```
npm run production:verify-assets -- --wave=E
```

- [ ] HTTP 200, `CACHE_VERSION` `v18`
- [ ] Kaikki kymmenen porttia `true`
- [ ] `TASK_EXTENDED_FIELDS = true`

---

## 4. Selainhyväksyntä

Koska kirjoituspolkua ei ole, hyväksyntä koskee sitä, että **lukupolku
ei riko mitään**.

- [ ] Sovellus latautuu ja kirjautuminen toimii
- [ ] Konsolissa ei virheitä — erityisesti ei `ai_action_audit`-tauluun
      liittyvää virhettä
- [ ] Aaltojen A–D ominaisuudet toimivat kaikki yhä:
  - [ ] muistutusasetukset säilyvät
  - [ ] hyvinvointimerkintä säilyy
  - [ ] tavoite ja projekti säilyvät
  - [ ] rutiini ja poikkeus säilyvät
  - [ ] toistuva kulu, säästötavoite ja lasku säilyvät
- [ ] Tehtävien luonti, muokkaus ja poisto toimivat
- [ ] AI-komento (jos käytät sitä) toimii kuten ennenkin — se **ei** luo
      kirjausriviä, eikä sen pidäkään

> Jos konsolissa näkyy virhe `ai_action_audit`-tauluun luettaessa, se on
> oikeusongelma tai politiikkaongelma, ei sovellusvirhe. Peruuta ja aja
> varmistus.

---

## 5. Tietokannan hyväksyntä

1. `precheck_0003_0008_auth_final.sql` → **6/6 PASS**
2. `verify_0003_0008_post_activation.sql` → **failures_total = 0**

| Tarkistus | Odotus |
|---|---|
| 44 — yhtään AI-toimintoa ei ole suoritettu ilman vahvistusta | PASS (tyhjä taulu ⇒ triviaalisti tosi) |
| 45 — pituusrajat pitävät | PASS |
| 46 — avaimelta näyttävää merkkijonoa ei ole | PASS |
| 50 — aallot rivimäärinä | INFO, muotoa `2 / 2 / 3 / 3 / 0` — **viimeinen luku on 0** |

> Viimeisen luvun **kuuluu** olla nolla. Jos siinä on rivejä, jokin
> kirjoittaa tauluun — eikä sovelluksessa ole sellaista polkua.
> Selvitä mistä ne tulivat ennen kuin jatkat.

### Kirjausketjun sopimus, kun kirjoituspolku joskus tehdään

Nämä ovat voimassa jo nyt kannan CHECK-rajoitteina, ja
`tests/wave-activation.test.mjs` lukitsee rivimuunnoksen kenttäjoukon:

- `input_summary` ≤ 200 merkkiä — **tiivistelmä, ei raakaa syötettä**
- `proposal` ≤ 300 merkkiä — **ei koko vastausta**
- `executed = true` edellyttää `confirmed = true`
- `occurred_at` jätetään pois kun aikaleimaa ei ole → kanta antaa `now()`
- taulussa ei ole saraketta salaisuuksille eikä API-avaimille
- `target_id` on **ilman vierasavainta**: kohde on voitu poistaa, ja
  kirjaus siitä on nimenomaan se mitä halutaan säilyttää

---

## 6. Peruutus

**Laukaisin:**

- konsolissa virhe `ai_action_audit`-taulua luettaessa
- tauluun ilmestyy rivejä, vaikka kirjoituspolkua ei ole
- jokin aaltojen A–D ominaisuus lakkaa toimimasta
- `failures_total > 0`

**Toimenpide:**

```
git revert --no-edit <WAVE-E-SHA>
# revert-commitissa: nosta CACHE_VERSION v18 -> v19
git push origin HEAD:main
```

Palauttaa **aallon D** tilan.

---

## 7. Junan päätös

Kun aalto E on hyväksytty:

- [ ] Kaikki kymmenen porttia auki ja todennettu
- [ ] `failures_total = 0`
- [ ] Peruutusta ei ole voimassa
- [ ] `docs/PRODUCTION-STATUS.md` päivitetty kaikilta aalloilta
- [ ] Julkaisutagi luodaan: ks. `docs/RELEASE-TRAIN-0003-0008.md`, kohta
      "Julkaisutagi"
- [ ] Android-synkronointi harkitaan: ks. sama dokumentti, kohta "Android"

### Jäljelle jäävät asiat

Nämä eivät ole junan osia eivätkä estä sen päättämistä:

1. **AI-kirjausketjun kirjoituspolku** — oma pakettinsa, ks. yllä
2. **`routine_exceptions_unique_day` -jälkikovennus** —
   `docs/FOLLOWUP-routine-exceptions-uniqueness.md`
3. **Laitehyväksyntä** — `docs/DEVICE-ACCEPTANCE-BACKLOG.md`
4. **Anthropic-avaimen kierrätys** — oma pakettinsa
