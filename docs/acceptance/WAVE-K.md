# Aalto K — Arjen käyttöjärjestelmä: kalenteri, paikat, uni, herätys, tavat ja liikunta

**Portit:** `savedPlaces`, `placeAliases`, `calendarEvents`, `commuteObservations`,
`lifeSettings`, `sleepLogs`, `habitPlans`, `habitEvents`, `exerciseSessions`,
`wellbeingCheckins`
**Sarakeportit:** ei yhtään (0014 ei muuta yhtäkään olemassa olevaa taulua)
**Taulut:** `saved_places`, `place_aliases`, `calendar_events`, `commute_observations`,
`life_settings`, `sleep_logs`, `habit_plans`, `habit_events`, `exercise_sessions`,
`wellbeing_checkins`
**Välimuistiversio:** `v24`
**Edellinen tuotanto:** aallon J commit (v23)
**Peruutuskohde:** aalto J
**Riski:** matala — vain uusia tyhjiä tauluja, ei olemassa olevan datan
uudelleenkirjoitusta. Tuore varmuuskopio ei ole pakollinen.

**Push-kohde (deployTarget):** junan lukon `docs/activation/release-train-c-j.json`
aallon K `deployTarget` — täysi 40-merkkinen SHA. Aaltoa K **ei ole vielä
leikattu** (ehdokas `rehearsal/wave-k-v1` J:n `cba9463`:n päälle), joten
lukossa ei vielä ole sen tietuetta. Manifestin
(`docs/activation-0003-0008-release-manifest.json`) `commitSha` on aallon
AALTOCOMMIT: peruutuksen ja diffin viite, EI push-kohde. Push tehdään
orkestroijalla, joka tarkistaa ensin, että `origin`in main on yhä odotettu
edellinen SHA.

**Hyväksyntä:** junan portti on koneellinen `AUTOMATED_TECHNICAL_ACCEPTANCE` —
ehdot, komennot ja kirjauspaikka:
[`docs/activation/AUTOMATED-ACCEPTANCE-POLICY.md`](../activation/AUTOMATED-ACCEPTANCE-POLICY.md).
Kohdan 4 selainhyväksyntä on `LIVE_USE_VALIDATION_PENDING`: se tehdään
oikeassa käytössä, **ei estä junaa eikä ole koskaan PASS**. Omistajan viesti
**"hyväksyn 0014/K"** avaa migraation 0014 ja deployn.

---

## LÄHTÖTILANNE: kanta puuttuu (ESTETTY)

Tätä aaltoa **ei saa vielä deployata**, koska kanta puuttuu:

1. **Kanta puuttuu.** Migraatiota `0014_daily_life.sql` ei ole ajettu
   tuotantoon, eikä myöskään sen edellytystä `0013_alignment_reality.sql`.
   Portin avaaminen tauluun jota ei ole kaataisi jokaisen kirjoituksen
   virheeseen `42P01` (ajonaikainen skeematarkistus torjuu sen ennen
   verkkoa, mutta tieto ei silloin säily).

Näkymät ovat valmiit: Kalenteri (Päivä / Viikko / Kuukausi), Profiili →
Arki, Hyvinvointi ja Paikat (Tunnetut nimitykset, matkojen oppiminen),
Tänään-kortit. Valmiustilaa **ei kirjoiteta käsin**:
`tests/ui-reachability.test.mjs` johtaa sen `tools/release/reachability.mjs`
-matriisista.

**Aalto riippuu aallosta J.** Migraatio `0014` edellyttää 0013:n
(`verify_0013.sql` = 0 poikkeavaa). Menot ja liikuntakerrat viittaavat
`goals`-tauluun yhdistelmävierasavaimella; muut viitteet ovat aallon omien
taulujen välisiä.

---

## Mitä esteen purkaminen vaatii

1. Aalto J tuotannossa: `0013` ajettu ja `verify_0013.sql` → 0 poikkeavaa
2. (tehty) Näkymät olemassa ja `tools/release/reachability.mjs` päivitetty
3. Aallon K ehdokas leikattu (`rehearsal/wave-k-v1`), lukko kirjoitettu
   (`train-map --write`, `SQL_SOURCE_WAVE` = K) ja dokumentit synkattu
   (`train-map --sync-docs`)
4. Panun kirjallinen hyväksyntä "hyväksyn 0014/K"
5. `supabase/preflight/preflight_0014.sql` (vain luku) → **0 FAIL**
6. Migraation ajo `postgres`-roolilla Supabasen SQL-editorissa
7. `supabase/verify/verify_0014.sql` → **poikkeavia_yhteensa = 0**

---

## Migraation vaikutus olemassa olevaan dataan

**Ei mitään.** Migraatio luo kymmenen uutta tyhjää taulua. Yhtäkään
olemassa olevaa taulua, saraketta, rajoitetta tai riviä ei muuteta.
Ainoat lukot ovat `auth.users`- ja `goals`-taulujen hetkelliset
SHARE ROW EXCLUSIVE -lukot vierasavainten luonnin ajan (`lock_timeout` 5 s).

---

## KOLME ASIAA, JOITA TÄMÄ AALTO EI TEE

### 1. Sijaintia ei tallenneta

Paikka on nimi ja osoite tekstinä. Koordinaatteja ei ole missään
sarakkeessa — **verify_0014 tarkistus 13** todistaa sen kannasta.
Matka-aika on käyttäjän itse kuittaama ("Lähdin" / "Olin perillä"),
ei sijaintihistoria.

### 2. Unta ei mitata eikä arkaluonteista tietoa lähetetä

Unikirjaus on vuoteessa olon aika, ei mitattu uni. Uni, motivaatio,
hallinnan tunne, tavat ja liikunta eivät kulje tekoälylle eivätkä lokiin.

### 3. Toistuvan menon esiintymiä ei tallenneta

Esiintymät lasketaan menosta (viikonpäivät, päättymispäivä, ohitetut
päivät), kuten rutiineissa.

---

## 1. Ennen deployta

```
git rev-parse origin/main          # oltava aallon J SHA
npm run activation:verify-wave -- K
npm run activation:preflight -- --wave=K
npm test && npm run check && npm run smoke && npm run build:web
```

- [ ] **Migraatio 0014 on ajettu ja `verify_0014.sql` antoi 0 poikkeavaa**
- [ ] Kaikki kolmekymmentäneljä porttia auki
- [ ] Sarakeportit ennallaan (`ALIGNMENT_REALITY_FIELDS` ym. yhä `true`)
- [ ] `CACHE_VERSION` on `v24`

### Diffin tarkistus

```
git diff <WAVE-J-SHA>..<WAVE-K-SHA> --stat
```

Aaltocommitissa vain `src/data/schema.js`, `sw.js`, `docs/PRODUCTION-STATUS.md`
ja `tools/release/waves.mjs` (`blockedBy` pois).

---

## 2. Deploy

Omistajan viesti **"hyväksyn 0014/K"** kattaa migraation 0014 ja tämän askeleen.
Deploy vasta, kun `verify_0014.sql` = 0 poikkeavaa; tulos annetaan
orkestroijalle (`--verify-result`). Ensisijainen (ja ainoa suositeltu)
deploy-askel on orkestroija:

```
npm run activation:orchestrate -- --execute-deploy --approved-sha=<deployTarget> --verify-result=<verify_0014-tulos>
```

`<deployTarget>` on lukon aallon K SHA, kun ehdokas on leikattu ja lukko
kirjoitettu. Orkestroija ei koskaan käytä forcea.

---

## 3. Deployn jälkeen — koneellinen

```
npm run production:verify-assets -- --wave=K
```

- [ ] HTTP 200, `CACHE_VERSION` `v24`
- [ ] Kaikki kolmekymmentäneljä porttia `true`

---

## 4. Selainhyväksyntä

> **`LIVE_USE_VALIDATION_PENDING`**: tämä osio tehdään oikeassa käytössä. Se
> **ei estä junaa** eikä sitä merkitä koskaan PASSiksi; junan portti on
> `AUTOMATED_TECHNICAL_ACCEPTANCE`.

Jokainen kohta tarkistetaan **sivun latauksen jälkeen**.

- [ ] Aaltojen A–J ominaisuudet toimivat kaikki yhä
- [ ] **Kalenteri**: meno (kerran ja viikoittain toistuva) säilyy; esiintymän ohitus säilyy
- [ ] **Paikat**: paikka säilyy; kaksi samannimistä paikkaa ei synny
- [ ] **Tunnetut nimitykset**: vahvistettu nimitys säilyy ja näkyy paikan alla
- [ ] **Arki**: arjen asetukset säilyvät; puuttuva asetus käyttää oletusta
- [ ] **Uni**, **Tapojen muutos**, **Liikunta** ja **Motivaatio** (voinnin kortti):
      kirjaukset säilyvät; tyhjä arvo pysyy tyhjänä eikä muutu nollaksi

---

## 5. Tietokannan hyväksyntä

1. `precheck_0003_0008_auth_final.sql` → **6/6 PASS**
2. `verify_0003_0008_post_activation.sql` → **failures_total = 0**
3. `verify_0013.sql` ajettu **ennen** 0014:ää → poikkeavia_yhteensa = 0
4. `verify_0014.sql` → **poikkeavia_yhteensa = 0**

| Tarkistus (verify_0014) | Odotus |
|---|---|
| 02–11 — jokaisessa taulussa täsmälleen odotetut sarakkeet | PASS |
| 13 — ei koordinaatti- eikä sijaintisaraketta | PASS |
| 22 — yksi asetusrivi käyttäjää kohti | PASS |
| 31 — SET NULL rajaa nollauksen yhteen sarakkeeseen | PASS |
| 32 — lisänimet, havainnot ja tapojen kirjaukset kaskadoituvat vanhempansa mukana | PASS |
| 34–35 — migraatioiden 36 taulua: vierasavain auth.usersiin on olemassa ja CASCADE | PASS |
| 36 — muut public-taulut | INFO |
| 45 — PUBLIC-roolilla ei ole oikeuksia | PASS |
| 50 — olemassa olevien taulujen politiikat ennallaan | PASS |
| 60–69 — rivimäärät | INFO |

---

## 6. Peruutus

**Laukaisin:**

- menon, paikan, asetusten tai kirjausten tallennus epäonnistuu
- `poikkeavia_yhteensa > 0`

**Toimenpide:**

```
git revert --no-edit <WAVE-K-SHA>
# revert-commitissa: nosta CACHE_VERSION v24 -> v25
git push origin HEAD:main
```

Palauttaa **aallon J** tilan.

> **Kantaa ei peruuteta ensin.** Porttien sulkeminen riittää: taulut jäävät
> paikoilleen ja sovellus lakkaa kirjoittamasta niihin. Kannan peruutus on
> erikseen migraatiotiedoston lopussa, ja se hävittää käyttäjän paikat,
> menot, asetukset ja kirjaukset pysyvästi.

---

## 7. Aallon jälkeen

- [ ] `docs/PRODUCTION-STATUS.md` päivitetty: aalto K, kymmenen porttia
- [ ] `docs/UI-REACHABILITY.md` ja `tools/release/reachability.mjs` ajan tasalla
