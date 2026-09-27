# Aalto L — Mielen kuorman keventäminen: horisontit, odotus, suojattu aika ja sunnuntain nollaus

**Portit:** `protectedPeriods`, `weeklyPlans`
**Sarakeportit:** `MENTAL_LOAD_FIELDS` (tasks: `horizon`, `waiting_on`,
`follow_up_date`, `archived_at`, `reschedule_count`, `original_date`;
life_areas: `kind`)
**Taulut:** `protected_periods`, `weekly_plans`
**Muutetut taulut:** `tasks` (tuotannossa auki), `life_areas` (0012)
**Välimuistiversio:** `v25`
**Edellinen tuotanto:** aallon K commit (v24)
**Peruutuskohde:** aalto K
**Riski:** keski — migraatio 0015 muuttaa tuotannossa auki olevaa
`tasks`-taulua (ALTER TABLE, ACCESS EXCLUSIVE -lukko, `lock_timeout` 5 s).
Ei rivien uudelleenkirjoitusta. **Tuore varmuuskopio on pakollinen**
(`supabase/backup/snapshot_state_0014.sql`).

**Push-kohde (deployTarget):** junan lukon `docs/activation/release-train-c-j.json`
aallon L `deployTarget` — täysi 40-merkkinen SHA. Aaltoa L **ei ole vielä
leikattu** (ehdokas `rehearsal/wave-l-v1` K v1:n `d11d8b4`:n päälle), joten
lukossa ei vielä ole sen tietuetta. Lukitut C–K-tietueet pysyvät tavu
tavulta ennallaan: sarakeportti `MENTAL_LOAD_FIELDS` tulee vain L-tietueeseen
(`tools/activation/train-map.mjs`, `LOCK_V2_COLUMN_GATES`). Manifestin
(`docs/activation-0003-0008-release-manifest.json`) `commitSha` on aallon
AALTOCOMMIT: peruutuksen ja diffin viite, EI push-kohde. Push tehdään
orkestroijalla, joka tarkistaa ensin, että `origin`in main on yhä odotettu
edellinen SHA.

**Hyväksyntä:** junan portti on koneellinen `AUTOMATED_TECHNICAL_ACCEPTANCE` —
ehdot, komennot ja kirjauspaikka:
[`docs/activation/AUTOMATED-ACCEPTANCE-POLICY.md`](../activation/AUTOMATED-ACCEPTANCE-POLICY.md).
Kohdan 4 selainhyväksyntä on `LIVE_USE_VALIDATION_PENDING`: se tehdään
oikeassa käytössä, **ei estä junaa eikä ole koskaan PASS**. Omistajan viesti
**"hyväksyn 0015/L"** avaa migraation 0015 ja deployn.

Sopimus: [`docs/MENTAL-LOAD-CORE.md`](../MENTAL-LOAD-CORE.md). Palautuminen:
[`docs/MIGRATION-0015-RECOVERY.md`](../MIGRATION-0015-RECOVERY.md).

---

## LÄHTÖTILANNE: kanta puuttuu (ESTETTY)

Tätä aaltoa **ei saa vielä deployata**, koska kanta puuttuu:

1. **Kanta puuttuu.** Migraatiota `0015_mental_load.sql` ei ole ajettu
   tuotantoon, eikä myöskään sen edellytystä `0014_daily_life.sql`.
   Sarakeportin avaaminen ennen migraatiota kaataisi JOKAISEN tehtävän
   tallennuksen virheeseen `42703` (tuntematon sarake) — `tasks` on
   tuotannossa auki.

Näkymien sisäänkäynnit: Profiili → Suojattu aika (`#protectedTimeContainer`),
Sulje viikko eli sunnuntain nollaus (`#sundayResetDialog`, avataan Tänään-näkymän
`#sundayResetOpenBtn`- ja Suunnan `#dirSundayResetBtn`-painikkeista) ja
Tekeminen → Tallessa (`#storedListContainer`). Valmiustilaa **ei kirjoiteta
käsin**: `tests/ui-reachability.test.mjs` johtaa sen
`tools/release/reachability.mjs` -matriisista.

**Aalto riippuu aallosta K.** Migraatio `0015` edellyttää 0014:n
(`verify_0014.sql` = 0 poikkeavaa). Uudet taulut eivät viittaa yhteenkään
sovellustauluun; viikon prioriteetti on viittaus (`task:<id>`), ei
vierasavain.

---

## Mitä esteen purkaminen vaatii

1. Aalto K tuotannossa: `0014` ajettu ja `verify_0014.sql` → 0 poikkeavaa
2. Näkymät olemassa ja `tools/release/reachability.mjs` päivitetty
3. Aallon L ehdokas leikattu (`rehearsal/wave-l-v1`), `TRAIN`-alias
   lisätty, lukko kirjoitettu (`train-map --write`, `SQL_SOURCE_WAVE` = L)
   ja dokumentit synkattu (`train-map --sync-docs`)
4. Ehdokkaan oma testipatteristo ja käynnistyssavu kirjattu päiväkirjaan
5. Panun kirjallinen hyväksyntä "hyväksyn 0015/L"
6. **Tuore varmuuskopio:** `supabase/backup/snapshot_state_0014.sql` →
   vienti → `node tools/activation/restore-snapshot.mjs check <tiedosto> --save`
   → TILANNEKUVA KUNNOSSA
7. `supabase/preflight/preflight_0015.sql` (vain luku) → **0 FAIL**; kirjaa
   rivi "tasks.date NOT NULL ennen 0015:tä"
8. Migraation ajo `postgres`-roolilla Supabasen SQL-editorissa
9. `supabase/verify/verify_0015.sql` → **poikkeavia_yhteensa = 0**

---

## Migraation vaikutus olemassa olevaan dataan

- `tasks`: kuusi uutta saraketta (NULL, `reschedule_count` = 0), `date`
  saa olla NULL. **Yhtäkään riviä ei kirjoiteta uudelleen**
  (vakio-oletukset; harjoiteltu: `xmin` ja `relfilenode` ennallaan).
- `life_areas`: `kind` = `STANDARD` jokaiselle riville oletuksena;
  kategorian uniikkius poistuu (useampi alue saa jakaa kategorian).
- Lukot: `tasks` ja `life_areas` ACCESS EXCLUSIVE kerralla ennen
  yhtäkään muutosta; `auth.users` SHARE ROW EXCLUSIVE viimeisenä
  (uusien taulujen vierasavaimet). `lock_timeout` 5 s.

---

## KOLME ASIAA, JOITA TÄMÄ AALTO EI TEE

### 1. Asian luonnetta ei tallenneta

Velvoite, tavoitteen askel, ylläpito, hyvinvointi, nautinto ja vapaa-aika
JOHDETAAN (`src/domain/itemNature.js`). **verify_0015 tarkistus 52**
todistaa, ettei luonnesaraketta ole.

### 2. Odottavalle ei tule yhteystietojärjestelmää

`waiting_on` on vapaa teksti (1–200 merkkiä). Odotus sallitaan vain
horisontilla WAITING (**verify_0015 tarkistus 24**).

### 3. Suojattua aikaa ei koskaan oteta automaattisesti

Loma ei poista kiinteitä menoja; se estää vain automaattisen sijoittamisen.

---

## 1. Ennen deployta

```
git rev-parse origin/main          # oltava aallon K SHA
npm run activation:verify-wave -- L
npm run activation:preflight -- --wave=L
npm test && npm run check && npm run smoke && npm run build:web
```

- [ ] **Tuore varmuuskopio otettu ja tarkistettu (`snapshot_state_0014.sql`)**
- [ ] **Migraatio 0015 on ajettu ja `verify_0015.sql` antoi 0 poikkeavaa**
- [ ] Kaikki kolmekymmentäkuusi porttia auki
- [ ] Sarakeportti `MENTAL_LOAD_FIELDS` on `true`; aiemmat sarakeportit yhä `true`
- [ ] `CACHE_VERSION` on `v25`

### Diffin tarkistus

```
git diff <WAVE-K-SHA>..<WAVE-L-SHA> --stat
```

Aaltocommitissa vain `src/data/schema.js`, `sw.js`, `docs/PRODUCTION-STATUS.md`
ja `tools/release/waves.mjs` (`blockedBy` pois).

---

## 2. Deploy

Omistajan viesti **"hyväksyn 0015/L"** kattaa migraation 0015 ja tämän askeleen.
Deploy vasta, kun `verify_0015.sql` = 0 poikkeavaa; tulos annetaan
orkestroijalle (`--verify-result`). Ensisijainen (ja ainoa suositeltu)
deploy-askel on orkestroija:

```
npm run activation:orchestrate -- --execute-deploy --approved-sha=<deployTarget> --verify-result=<verify_0015-tulos>
```

`<deployTarget>` on lukon aallon L SHA, kun ehdokas on leikattu ja lukko
kirjoitettu. Orkestroija ei koskaan käytä forcea.

---

## 3. Deployn jälkeen — koneellinen

```
npm run production:verify-assets -- --wave=L
```

- [ ] HTTP 200, `CACHE_VERSION` `v25`
- [ ] Kaikki kolmekymmentäkuusi porttia `true`, `MENTAL_LOAD_FIELDS` `true`

---

## 4. Selainhyväksyntä

> **`LIVE_USE_VALIDATION_PENDING`**: tämä osio tehdään oikeassa käytössä. Se
> **ei estä junaa** eikä sitä merkitä koskaan PASSiksi; junan portti on
> `AUTOMATED_TECHNICAL_ACCEPTANCE`.

Jokainen kohta tarkistetaan **sivun latauksen jälkeen**.

- [ ] Aaltojen A–K ominaisuudet toimivat kaikki yhä
- [ ] **Päivätön tehtävä** ("Myöhemmin") säilyy ilman keksittyä päivää
- [ ] **Horisontti** (Tämä viikko / Myöhemmin / Ei vielä) säilyy; Tallessa-lista näyttää sen
- [ ] **Odottaa**: kenen varassa -teksti ja tarkistuspäivä säilyvät
- [ ] **Arkisto**: arkistoitu tehtävä pysyy poissa Tänään-näkymästä ja näkyy Arkistossa
- [ ] **Suojattu aika**: oma aika, vapaa-ajan sääntö ja loma säilyvät
- [ ] **Sulje viikko** (sunnuntain nollaus): viikon prioriteetit (≤ 3) ja suljettu viikko säilyvät
- [ ] **Elämänalueen laji** säilyy; kaksi aluetta voi jakaa kategorian

---

## 5. Tietokannan hyväksyntä

1. `precheck_0003_0008_auth_final.sql` → **6/6 PASS**
2. `verify_0003_0008_post_activation.sql` → **failures_total = 0**
3. `verify_0014.sql` ajettu **ennen** 0015:tä → poikkeavia_yhteensa = 0
4. `verify_0015.sql` → **poikkeavia_yhteensa = 0**

| Tarkistus (verify_0015) | Odotus |
|---|---|
| 02–03 — uusissa tauluissa täsmälleen odotetut sarakkeet | PASS |
| 04–07 — tasks- ja life_areas-sarakkeet oikeilla tyypeillä ja oletuksilla | PASS |
| 08 — tasks.date on nullable (päivätön tehtävä) | PASS |
| 20 — kaikki 26 uutta rajoitetta | PASS |
| 22–23 — kategorian uniikkius poistettu, haku indeksoitu | PASS |
| 24–27 — odotus vain WAITING, maanantai, ≤ 5 prioriteettia, yksi suunnitelma viikossa | PASS |
| 31–32 — migraatioiden 38 taulua: vierasavain auth.usersiin on olemassa ja CASCADE | PASS |
| 33 — muut public-taulut | INFO |
| 40–47 — RLS, 8 politiikkaa, ei anon- eikä PUBLIC-oikeuksia | PASS |
| 50 — olemassa olevien taulujen politiikat ennallaan (80) | PASS |
| 60–64 — rivimäärät | INFO |

---

## 6. Peruutus

**Laukaisin:**

- tehtävän, suojatun jakson tai viikkosuunnitelman tallennus epäonnistuu
- `poikkeavia_yhteensa > 0`

**Toimenpide:**

```
git revert --no-edit <WAVE-L-SHA>
# revert-commitissa: nosta CACHE_VERSION v25 -> v26
git push origin HEAD:main
```

Palauttaa **aallon K** tilan.

> **Kantaa ei peruuteta ensin.** Porttien sulkeminen riittää: aallon K koodi
> ei lähetä 0015:n sarakkeita eikä kirjoita uusiin tauluihin, joten ne jäävät
> paikoilleen koskematta. Kannan peruutus tilaan 0014 on erikseen
> (`docs/MIGRATION-0015-RECOVERY.md` §4), ja se hävittää suojatut jaksot,
> viikkosuunnitelmat, horisontit, odotukset ja arkistoinnit pysyvästi.

---

## 7. Aallon jälkeen

- [ ] `docs/PRODUCTION-STATUS.md` päivitetty: aalto L, kaksi porttia ja sarakeportti
- [ ] `docs/UI-REACHABILITY.md` ja `tools/release/reachability.mjs` ajan tasalla
