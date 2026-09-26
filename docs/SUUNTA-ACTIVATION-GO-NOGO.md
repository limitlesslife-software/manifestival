# Suunta — aktivoinnin GO/NO-GO (valmisteltu yöllä 2026-09-25)

**Tuotanto nyt:** `origin/main` = `cf259d0` = **aalto C** (v16). Todennettu
lukevalla GET:llä tuotannon tiedostoista: 35/35 PASS (C:n kuusi porttia auki,
D–J kiinni). **C on deployattu, ei hyväksytty.**

**Paikallinen tuote:** `feature/life-alignment-foundation` (Suunta 1+2 ja
yön korjaukset). Mitään ei ole pushattu, deployattu eikä ajettu tuotantoon.

**Kaikki migraatiot 0009–0013 on harjoiteltu oikealla PostgreSQL 17:llä**
tuotannon muotoisesta datasta: ketju, RLS (311 tarkistusta), virheet
(31), peruutukset (5/5), esitarkistukset (35) — 0 hylättyä
(`docs/activation/REHEARSAL-REPORT.md`).

| Aalto | Sisältö | Deploykohde | Migraatio | Tila | Omistajan toimi | Riski | Peruutus |
|---|---|---|---|---|---|---|---|
| **C** v16 | rutiinit, poikkeukset | `cf259d0` (tuotannossa) | — | **DEPLOYATTU** | Hyväksyntä ~10 min: `docs/acceptance/WAVE-C-OWNER-ACCEPTANCE.md` | matala | revert (vie v17:n → numerointi siirtyy) |
| **D** v17 | laskut, menot, säästöt | `091e73c` | — | READY (jäädytetty; testit tänään 1595/1596) | deployhyväksyntä + 5 min UI (`docs/acceptance/WAVE-D.md`) | matala | aalto C |
| **E** v18 | AI-kirjausketju | `release/activation-0003-0008` (`86c4325`) | — | READY | deployhyväksyntä. Hyväksyntä = taulu luettavissa, **0 riviä** (E:ssä ei ole kirjoituspolkua käyttöliittymästä) | matala | D |
| **F** v19 | Talous 2.0 | `rehearsal/wave-f-v3` (`5e4e7cf`) | **0009** | READY 0009:n jälkeen | 0009-hyväksyntä + deploy | matala | E + 0009 ROLLBACK |
| **G** v20 | Tavoitteesta tekemiseksi | `rehearsal/wave-g-v3` (`173afd5`) | **0010** | READY 0010:n jälkeen | **erillinen** 0010-hyväksyntä + **varmuuskopio** | **KORKEA** (muuttaa goals/tasks/projects/profile) | F + 0010 ROLLBACK |
| **H** v21 | Henkilökohtainen avustaja | `rehearsal/wave-h-v3` (`48b2cad`) | **0011** | READY 0011:n jälkeen | 0011-hyväksyntä + deploy | matala | G |
| **I** v22 | **Suunta 1** | `rehearsal/wave-i-v1` (`4cfb4bc`) | **0012** | READY 0012:n jälkeen | 0012-hyväksyntä + deploy (välivaihe) | keski (goals + sarake) | H |
| **J** v23 | **Suunta 2** (ajastin, energia, katsaus v2) + yön korjaukset | `rehearsal/wave-j-v1` (`5df40b2`) | **0013** | READY 0013:n jälkeen | 0013-hyväksyntä + deploy + APK + Day 1 | matala | I (aika säilyy) |

Koneellinen kartta: `docs/activation/release-train-c-j.json` (jokaisen
kohteen oma `sw.js`/`schema.js`: v16→v23 nousevat, ei törmäyksiä, ei
ennenaikaisia portteja; jokainen aalto edellisen jälkeläinen).
Paketit: `docs/activation/MIGRATION-BUNDLES.md`.

---

## Huomenna

**1. (5 min, vain luku)** Supabase → SQL Editor → uusi välilehti → liitä
koko `supabase/acceptance/activation_readonly_inventory.sql` → Run.
Kopioi **rivin 00 solu "arvo"** (yksi JSON-rivi) ja liitä Claudelle.

**2.** Claude ajaa `node tools/activation/score-inventory.mjs` ja kertoo
GO/STOP + seuraavan portin. Odotettu: *GO, seuraava migraatio 0009*.

**3. (~10 min)** Aallon C hyväksyntä selaimessa:
`docs/acceptance/WAVE-C-OWNER-ACCEPTANCE.md`.

**4.** Sano "hyväksyn D:n deployn" → Claude: `git push origin 091e73c:main`
→ Vercel deployaa → `npm run production:verify-assets -- --wave=D` →
sinä: 5 min UI (lasku, toistuva meno, säästötavoite → F5 → säilyy).
Toista E:lle (`git push origin release/activation-0003-0008:main`).

**5. Jokainen migraatioaalto F–J samalla kaavalla:**
`preflight_00XX.sql` (0 FAIL) → **sinun hyväksyntäsi** → migraatio →
`verify_00XX.sql` (0 poikkeavaa) → "hyväksyn deployn" →
`git push origin rehearsal/wave-X-…:main` → verify-assets → UI-hyväksyntä.
0010:lle ensin tuore varmuuskopio.

**6.** J:n jälkeen: APK puhelimeen (`docs/activation/ANDROID-ACCEPTANCE-BUILD.md`)
ja `docs/SUUNTA-DAY1-ACCEPTANCE.md` (10–15 min). **Älä asenna J-APK:ta
ennen kuin `verify_0013` = 0.**

**Nopein turvallinen polku päivittäiseen käyttöön:** 1 → 2 → 3 → D → E →
0009/F → 0010/G → 0011/H → 0012/I → 0013/J → puhelin. Jokainen askel on
oma porttinsa; D ja E eivät vaadi migraatiota. Kaikki migraatiot ovat
taaksepäin yhteensopivia edellisen aallon koodin kanssa (todennettu), joten
tauko minkä tahansa aallon jälkeen on turvallinen.

---

## Jäljellä olevat esteet (vain nämä luokat)

| Luokka | Mitä |
|---|---|
| OWNER_READ_ONLY_SQL_REQUIRED | Inventaario (askel 1): tuotannon PostgreSQL-versio, `tasks.date`-tyyppi, migraatiotila |
| OWNER_DEPLOY_APPROVAL_REQUIRED | Aallon C hyväksyntä; aaltojen D–J deployt |
| OWNER_PRODUCTION_MIGRATION_APPROVAL_REQUIRED | 0009, **0010 (erikseen, varmuuskopio)**, 0011, 0012, 0013 |
| PHONE_ACCEPTANCE_REQUIRED | Day 1 puhelimella J:n jälkeen |
| EXTERNAL_PROVIDER_REQUIRED | `ANTHROPIC_API_KEY` Vercelissä (`docs/DEPLOYMENT.md` kirjaa sen olemassa olevaksi, Production + Preview — tarkista hallintapaneelista): tekstikomennot (aalto H:n ensimmäinen oikea AI-kirjausrivi). AI-selitys ei käytä avainta ennen kuin se kytketään päälle (alla) |
| OPTIONAL_DAY1 · OWNER_DECISION | **AI-selitys (`/api/explain`) on pois, eikä Day 1 tarvitse sitä.** Aalto J deployaa päätepisteen suljettuna: `EXPLAIN_ENABLED` ei asetettu → 503 ennen todennusta, ei Anthropic-kutsuja; selaimen `AI_EXPLAIN_ENABLED = false` → ei "Selitä tekoälyllä" -painiketta. Käyttöönotto = omistajan päätös: (1) `EXPLAIN_ENABLED=true` Verceliin (Production), (2) `AI_EXPLAIN_ENABLED = true` omassa commitissaan + `CACHE_VERSION`-nosto, (3) deploy. Kumpikin yksin pitää selityksen pois. Päätös kirjataan tähän riviin |
| PRODUCT_DECISION_REQUIRED | Android versionCode-strategia; tallennetun katsauksen tilannekuva uudelleentallennuksessa; `routine_exceptions`-uniikkius (`docs/FOLLOWUP-routine-exceptions-uniqueness.md`) |
| REAL_DB_ENVIRONMENT_REQUIRED | PostgREST-kerros ja Supabasen `postgres`-rooli (harjoitus ajoi superuserina) — jokaisen aallon tuotantohyväksyntä kattaa |
