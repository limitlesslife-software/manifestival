# Aalto J — Suunta 2: ajastin, kuormittavuus ja toteuman lähteet

**Portit:** `runningTimers`, `alignmentItemSettings`
**Sarakeportti:** `ALIGNMENT_REALITY_FIELDS` (0012:n taulujen uudet sarakkeet)
**Taulut:** `running_timers`, `alignment_item_settings`
**Välimuistiversio:** `v23`
**Edellinen tuotanto:** aallon I commit (v22)
**Peruutuskohde:** aalto I

**Push-kohde (deployTarget):** junan lukon `docs/activation/release-train-c-j.json`
aallon J `deployTarget` — täysi 40-merkkinen SHA, sama kuin kohdan
"Deploy" push-rivillä. Manifestin (`docs/activation-0003-0008-release-manifest.json`)
`commitSha` on aallon AALTOCOMMIT: peruutuksen ja diffin viite, EI push-kohde.
Push tehdään orkestroijalla (`npm run activation:orchestrate -- --execute-deploy
--approved-sha=<deployTarget>`), joka tarkistaa ensin, että `origin`in main on
yhä odotettu edellinen SHA.

**Hyväksyntä (omistajan päätös 2026-09-26):** junan portti on koneellinen
`AUTOMATED_TECHNICAL_ACCEPTANCE` — ehdot, komennot ja kirjauspaikka:
[`docs/activation/AUTOMATED-ACCEPTANCE-POLICY.md`](../activation/AUTOMATED-ACCEPTANCE-POLICY.md). Kohdan 4 selainhyväksyntä on
`LIVE_USE_VALIDATION_PENDING`: se tehdään oikeassa käytössä, **ei estä junaa
eikä ole koskaan PASS**. Omistajan viesti **"hyväksyn 0013/J"** avaa migraation 0013 ja deployn.

---

## LÄHTÖTILANNE: kanta puuttuu (ESTETTY)

Tätä aaltoa **ei saa vielä deployata**.

Migraatiota `0013_alignment_reality.sql` ei ole ajettu tuotantoon, eikä
myöskään sen edellytystä `0012_life_alignment.sql`. Portin avaaminen
tauluun jota ei ole kaataa jokaisen kirjoituksen virheeseen `42P01`, ja
sarakeportin avaaminen ennen migraatiota kaataisi jokaisen aikakirjauksen,
kapasiteetin ja katsauksen tallennuksen virheeseen `42703`.

Käyttöliittymä on olemassa:

| Portti | Näkymä | Polku |
|---|---|---|
| `runningTimers` | `src/app/views/timeLog.js` | Kaikki näkymät → ajastinpalkki |
| `alignmentItemSettings` | `src/app/views/tasks.js` | Tehtävä → Kuormittavuus |

Valmiustilaa **ei kirjoiteta käsin**: `tests/ui-reachability.test.mjs`
johtaa sen `tools/release/reachability.mjs` -matriisista.

**Aalto riippuu aallosta I.** Migraatio `0013` muuttaa 0012:n tauluja
(`time_entries`, `weekly_capacities`, `alignment_reviews`) ja viittaa
`life_areas`-tauluun. Aalto I voi mennä tuotantoon ilman J:tä, mutta ei
päinvastoin.

---

## Mitä esteen purkaminen vaatii

1. Aalto I tuotannossa: `0012` ajettu ja `verify_0012.sql` → 0 poikkeavaa
   (**aja verify_0012 ennen 0013:a**: 0013 korvaa sen tarkistaman
   lähderajoitteen)
2. Panun kirjallinen hyväksyntä migraatiolle `0013`
3. **Varmuuskopio**
4. Migraation esitarkistus (vain lukeva, tiedoston lopussa):
   - `suunta_0012` = **2**
   - `uudet_0013` = **0**
   - `vanha_lahde` = **1**
5. Migraation ajo `postgres`-roolilla Supabasen SQL-editorissa
6. `supabase/verify/verify_0013.sql` → **poikkeavia_yhteensa = 0**

---

## Migraation vaikutus olemassa olevaan dataan

Migraatio **luo kaksi uutta tyhjää taulua** ja **lisää sarakkeita
0012:n tauluihin** (nullable tai oletusarvolliset: luettelomuutoksia).
Yhtäkään tuotannossa auki olevaa taulua (`tasks`, `goals`, `projects`,
`routines`) ei muuteta; niihin viitataan vain yhdistelmävierasavaimilla.
`time_entries_source_check` korvataan rajoitteella, joka sallii myös
lähteen `timer`.

---

## KOLME ASIAA, JOITA TÄMÄ AALTO EI TEE

### 1. Energiakuormaa ei tallenneta

Kuormittava aika ja `ENERGY_OVERLOAD` **lasketaan**
(`src/domain/energyLoad.js`). Tallennetaan vain käyttäjän oma
kuormittavuusarvio ja oma raja.

### 2. Arviota ei kopioida toteumaksi

Ajastimen kesto johdetaan aikaleimoista. Tehtävän valmistuminen ei tuota
kirjausta; käyttäjä valitsee kirjauksen itse.

### 3. Kaksi ajastinta ei ole mahdollinen

`running_timers_one_per_user unique (user_id)` — **tarkistus 20**.
Sama kirjausoperaatio tallentuu kerran — **tarkistus 13**.

---

## 1. Ennen deployta

```
git rev-parse origin/main          # oltava aallon I SHA
npm run activation:verify-wave -- J
npm run activation:preflight -- --wave=J
npm test && npm run check && npm run smoke && npm run build:web
```

- [ ] **Migraatio 0013 on ajettu ja `verify_0013.sql` antoi 0 poikkeavaa**
- [ ] **Varmuuskopio on otettu ennen migraatiota**
- [ ] Kaikki kaksikymmentäneljä porttia auki
- [ ] `ALIGNMENT_REALITY_FIELDS` on `true`
- [ ] `GOAL_LIFE_AREA_FIELD`, `TASK_EXTENDED_FIELDS` ja `GOAL_PLANNING_FIELDS` yhä `true`
- [ ] `CACHE_VERSION` on `v23`
- [ ] **AI-selitys pois:** `AI_EXPLAIN_ENABLED = false` (`src/ai/alignmentExplainClient.js`)
      ja Vercelissä **ei** ole `EXPLAIN_ENABLED`-muuttujaa (ellei omistaja
      ole kirjannut käyttöönottoa `docs/SUUNTA-ACTIVATION-GO-NOGO.md`:hen)

### Diffin tarkistus

```
git diff <WAVE-I-SHA>..<WAVE-J-SHA> --stat
```

Vain `src/data/schema.js`, `sw.js`, `docs/PRODUCTION-STATUS.md`.

---

## 2. Deploy

Omistajan viesti **"hyväksyn 0013/J"** kattaa migraation 0013 ja tämän askeleen.
Deploy vasta, kun `verify_0013.sql` = 0 poikkeavaa; tulos annetaan
orkestroijalle (`--verify-result`). Ensisijainen (ja ainoa suositeltu)
deploy-askel on orkestroija: se tarkistaa lukon, tuotannon aallon teknisen
hyväksynnän, ehdokkaan kirjatun testiajon ja käynnistyssavun sekä julkaisun esitarkistuksen,
tekee compare-and-swapin, pushaa ja todentaa tuotannon:

```
# STOP J — TRAIN_RECUT_REQUIRED: lukon deployTarget 5df40b2 ei sisällä pakollista korjausta 5aa0d53; ei push- eikä deploy-komentoa ennen uudelleenleikkausta (leikkaa, sitten node tools/activation/train-map.mjs --write ja --sync-docs) [deploy --verify-result=<verify_0013-tulos>]
```

Viitteeksi (älä aja käsin): orkestroija ajaa compare-and-swapin jälkeen
täsmälleen tämän — ei koskaan forcea:

```
# STOP J — TRAIN_RECUT_REQUIRED: lukon deployTarget 5df40b2 ei sisällä pakollista korjausta 5aa0d53; ei push- eikä deploy-komentoa ennen uudelleenleikkausta (leikkaa, sitten node tools/activation/train-map.mjs --write ja --sync-docs) [push]
```

---

## 3. Deployn jälkeen — koneellinen

```
npm run production:verify-assets -- --wave=J
```

- [ ] HTTP 200, `CACHE_VERSION` `v23`
- [ ] Kaikki kaksikymmentäneljä porttia `true`

### AI-selitys (`/api/explain`) — uusi maksullinen päätepiste, suljettuna

Aalto J tuo päätepisteen tuotantoon ensimmäistä kertaa. Se on **pois**,
kunnes omistaja päättää toisin. `verify-assets` ei kutsu `/api/`-polkuja,
joten nämä ajetaan käsin (ei tunnuksia, ei maksullista kutsua):

```
curl -s -o /dev/null -w "%{http_code}\n" https://manifestival-ten.vercel.app/api/explain
curl -s -w "\n%{http_code}\n" -X POST -H "Content-Type: application/json" -d "{}" https://manifestival-ten.vercel.app/api/explain
curl -s -i -X OPTIONS -H "Origin: https://localhost" -H "Access-Control-Request-Method: POST" https://manifestival-ten.vercel.app/api/explain
```

| Tarkistus | Odotus |
|---|---|
| `GET /api/explain` | **405** |
| `POST /api/explain` ilman tokenia | **503** `{"error":"Palvelu ei ole käytössä"}` (katkaisin pois; ei todennusta, ei Anthropic-kutsua) |
| `OPTIONS` originista `https://localhost` | **204** ja `Access-Control-Allow-Origin: https://localhost` (Android-kuoren esikysely) |

- [ ] Kolme riviä yllä täsmäävät. Jos `POST` antaa **401** tai **200**,
      `EXPLAIN_ENABLED` on asetettu Verceliin: poista se tai kirjaa
      omistajan päätös ennen hyväksyntää.

---

## 4. Selainhyväksyntä

> **`LIVE_USE_VALIDATION_PENDING`** (omistajan päätös 2026-09-26): tämä osio
> tehdään oikeassa käytössä. Se **ei estä junaa** eikä sitä merkitä koskaan
> PASSiksi; junan portti on `AUTOMATED_TECHNICAL_ACCEPTANCE` ([`docs/activation/AUTOMATED-ACCEPTANCE-POLICY.md`](../activation/AUTOMATED-ACCEPTANCE-POLICY.md)).

Jokainen kohta tarkistetaan **sivun latauksen jälkeen**.

### Ensin: mikään ei saa olla rikki

- [ ] Tehtävät, tavoitteet, projektit ja rutiinit toimivat
- [ ] Aallon I Suunta toimii (alueet, kapasiteetti, kirjaus, katsaus)

### Suunta 2: Ajanseuranta ja Kuormittavuus

- [ ] Käynnistä ajastin → lataa sivu → ajastin jatkuu, kulunut aika oikein
- [ ] Toinen laite ei voi käynnistää toista ajastinta
- [ ] Pysäytä → kirjaus lähteellä `timer`; kaksoisnapautus ei tuota kahta riviä
- [ ] Merkitse tehtävän kuormittavuus → säilyy latauksen yli
- [ ] Aseta kuormittavan ajan raja → energiakuormitus näkyy erillään aikakuormituksesta
- [ ] Katsauksen pohdintavastaukset ja sääntöversio säilyvät
- [ ] Havainnon "Miksi tämä näkyy?" näyttää selityksen; "Selitä tekoälyllä"
      -painiketta **ei** ole (AI-selitys pois)

### Aiemmat aallot

- [ ] Aaltojen A–I ominaisuudet toimivat kaikki yhä

---

## 5. Tietokannan hyväksyntä

1. `precheck_0003_0008_auth_final.sql` → **6/6 PASS**
2. `verify_0003_0008_post_activation.sql` → **failures_total = 0**
3. `verify_0009.sql`, `verify_0010.sql`, `verify_0011.sql` → **poikkeavia_yhteensa = 0**
4. `verify_0012.sql` ajettu **ennen** 0013:a → poikkeavia_yhteensa = 0
5. `verify_0013.sql` → **poikkeavia_yhteensa = 0**

| Tarkistus (verify_0013) | Odotus |
|---|---|
| 11 — vanha lähderajoite poistettu | PASS |
| 13 — (user_id, operation_id) uniikki | PASS |
| 20 — yksi ajastin käyttäjää kohti | PASS |
| 24 — SET NULL rajaa nollauksen yhteen sarakkeeseen | PASS |
| 34 — PUBLIC-roolilla ei ole oikeuksia | PASS |
| 40 — `tasks`, `goals`, `projects`, `routines` yhä 16 politiikkaa | PASS |
| 50–51 — rivimäärät | INFO |

---

## 6. Peruutus

**Laukaisin:**

- aikakirjauksen, kapasiteetin tai katsauksen tallennus epäonnistuu (sarakeportti)
- ajastin katoaa uudelleenlatauksessa tai tuottaa kaksoiskirjauksen
- `poikkeavia_yhteensa > 0`

**Toimenpide:**

```
git revert --no-edit <WAVE-J-SHA>
# revert-commitissa: nosta CACHE_VERSION v23 -> v24
git push origin HEAD:main
```

Palauttaa **aallon I** tilan.

> **Kantaa ei peruuteta ensin.** Porttien sulkeminen riittää: taulut ja
> sarakkeet jäävät paikoilleen ja sovellus lakkaa kirjoittamasta niihin.
> Kannan peruutus on erikseen migraatiotiedoston lopussa, ja se poistaa
> käyttäjän ajastimet ja kuormittavuusmerkinnät pysyvästi.

---

## 7. Aallon jälkeen

- [ ] `docs/PRODUCTION-STATUS.md` päivitetty: aalto J, kaksi porttia ja sarakeportti
- [ ] `docs/LIFE-ALIGNMENT.md` päivitetty: Suunta 2 tuotannossa
- [ ] Laitehyväksyntä: `docs/DEVICE-ACCEPTANCE-BACKLOG.md`, osio "Suunta 2"
