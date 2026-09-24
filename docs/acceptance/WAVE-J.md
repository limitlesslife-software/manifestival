# Aalto J — Suunta 2: ajastin, kuormittavuus ja toteuman lähteet

**Portit:** `runningTimers`, `alignmentItemSettings`
**Sarakeportti:** `ALIGNMENT_REALITY_FIELDS` (0012:n taulujen uudet sarakkeet)
**Taulut:** `running_timers`, `alignment_item_settings`
**Välimuistiversio:** `v23`
**Edellinen tuotanto:** aallon I commit (v22)
**Peruutuskohde:** aalto I

Aallon commit-SHA: ks. `docs/activation-0003-0008-release-manifest.json`.

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

### Diffin tarkistus

```
git diff <WAVE-I-SHA>..<WAVE-J-SHA> --stat
```

Vain `src/data/schema.js`, `sw.js`, `docs/PRODUCTION-STATUS.md`.

---

## 2. Deploy

```
git push origin <WAVE-J-SHA>:main
```

---

## 3. Deployn jälkeen — koneellinen

```
npm run production:verify-assets -- --wave=J
```

- [ ] HTTP 200, `CACHE_VERSION` `v23`
- [ ] Kaikki kaksikymmentäneljä porttia `true`

---

## 4. Selainhyväksyntä

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
