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
| **C** v16 | rutiinit, poikkeukset | `cf259d0ef755f7e875cc9cd9c15405eba632e408` (tuotannossa) | — | **DEPLOYATTU** | Hyväksyntä ~10 min: `docs/acceptance/WAVE-C-OWNER-ACCEPTANCE.md` | matala | revert (vie v17:n → numerointi siirtyy) |
| **D** v17 | laskut, menot, säästöt | `091e73c0091e8f135641e3501742b998dbac8461` | — | READY (jäädytetty; testit tänään 1595/1596) | deployhyväksyntä + 5 min UI (`docs/acceptance/WAVE-D.md`) | matala | aalto C |
| **E** v18 | AI-kirjausketju | `86c4325b00e8d58913afebdd0f1eca95d430174e` (`release/activation-0003-0008`) | — | READY | deployhyväksyntä. Hyväksyntä = taulu luettavissa, **0 riviä** (E:ssä ei ole kirjoituspolkua käyttöliittymästä) | matala | D |
| **F** v19 | Talous 2.0 | `5e4e7cf50e40fe1e0ba7b4543b147767e3a0eb32` (`rehearsal/wave-f-v3`) | **0009** | READY 0009:n jälkeen | 0009-hyväksyntä + deploy | matala | E + 0009 ROLLBACK |
| **G** v20 | Tavoitteesta tekemiseksi | `173afd5dc01d16e244ec07e72fb6e29918415e81` (`rehearsal/wave-g-v3`) | **0010** | READY 0010:n jälkeen | **erillinen** 0010-hyväksyntä + **varmuuskopio** | **KORKEA** (muuttaa goals/tasks/projects/profile) | F + 0010 ROLLBACK |
| **H** v21 | Henkilökohtainen avustaja | `48b2cad8bc62362dbe371d08f36b32677df270f6` (`rehearsal/wave-h-v3`; leikataan uudelleen) | **0011** | READY 0011:n jälkeen | 0011-hyväksyntä + deploy | matala | G |
| **I** v22 | **Suunta 1** | `4cfb4bcfea649146fb0bc9202d309aea8d1ffd9e` (`rehearsal/wave-i-v1`; leikataan uudelleen) | **0012** | READY 0012:n jälkeen | 0012-hyväksyntä + deploy (välivaihe) | keski (goals + sarake) | H |
| **J** v23 | **Suunta 2** (ajastin, energia, katsaus v2) + yön korjaukset | `5df40b20cee4f35279a79888959d49c9af88bcc7` (`rehearsal/wave-j-v1`; leikataan uudelleen) | **0013** | READY 0013:n jälkeen | 0013-hyväksyntä + deploy + APK + Day 1 | matala | I (aika säilyy) |

Deploykohde on **lukon** `docs/activation/release-train-c-j.json` täysi SHA
(`deployTarget`) — ei haaran nimi eikä manifestin aaltocommit. Lukon
tarkistus: `npm run activation:train-map`. Koneellinen kartta (jokaisen
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

**4.** Sano "hyväksyn C:n ja D:n deployn" → Claude ajaa orkestroijan, joka
tarkistaa lukon, varmistaa että `origin`in main on yhä tuotannon SHA
(compare-and-swap) ja pushaa **lukon deployTargetin** (ei koskaan force):
`npm run activation:orchestrate -- --execute-deploy --accepted=C --approved-sha=091e73c0091e8f135641e3501742b998dbac8461`
→ Vercel deployaa → orkestroija todentaa tuotannon (välimuisti, portit,
sormenjälki; sama kuin `npm run production:verify-assets -- --wave=D`) →
sinä: 5 min UI (lasku, toistuva meno, säästötavoite → F5 → säilyy).
Toista E:lle omalla hyväksynnälläsi. Kuivaharjoitus milloin tahansa:
`npm run activation:dry-run`.

**5. Jokainen migraatioaalto F–J samalla kaavalla:**
`preflight_00XX.sql` (0 FAIL; orkestroijalle `--preflight-result`) →
**sinun hyväksyntäsi** → migraatio → `verify_00XX.sql` (0 poikkeavaa;
`--verify-result`) → "hyväksyn deployn" → orkestroija pushaa lukon
deployTargetin → UI-hyväksyntä. 0010:lle ensin tuore varmuuskopio. H, I ja
J leikataan uudelleen ennen deployta: orkestroija pysähtyy
(`TRAIN_RECUT_REQUIRED`), kunnes lukko on kirjoitettu uusilla SHA:illa.

Push-kohteet lukosta (orkestroija ajaa nämä compare-and-swapin jälkeen;
`node tools/activation/train-map.mjs --sync-docs` päivittää rivit lukon
mukaan uudelleenleikkauksen jälkeen):

```
git push origin 091e73c0091e8f135641e3501742b998dbac8461:refs/heads/main   # D v17
git push origin 86c4325b00e8d58913afebdd0f1eca95d430174e:refs/heads/main   # E v18
git push origin 5e4e7cf50e40fe1e0ba7b4543b147767e3a0eb32:refs/heads/main   # F v19
git push origin 173afd5dc01d16e244ec07e72fb6e29918415e81:refs/heads/main   # G v20
git push origin 48b2cad8bc62362dbe371d08f36b32677df270f6:refs/heads/main   # H v21 (leikataan uudelleen)
git push origin 4cfb4bcfea649146fb0bc9202d309aea8d1ffd9e:refs/heads/main   # I v22 (leikataan uudelleen)
git push origin 5df40b20cee4f35279a79888959d49c9af88bcc7:refs/heads/main   # J v23 (leikataan uudelleen)
```

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
| OPTIONAL_DAY1 · OWNER_DECISION | **AI-selitys (`/api/explain`) on pois, eikä Day 1 tarvitse sitä.** Aalto J deployaa päätepisteen suljettuna: `EXPLAIN_ENABLED` ei asetettu → 503 ennen todennusta, ei Anthropic-kutsuja; selaimen `AI_EXPLAIN_ENABLED = false` → ei "Selitä tekoälyllä" -painiketta. Käyttöönotto = omistajan päätös: (1) `EXPLAIN_ENABLED=true` Verceliin (Production), (2) `AI_EXPLAIN_ENABLED = true` omassa commitissaan + `CACHE_VERSION`-nosto; sama commit päivittää kaksi KATKAISIN-vartijatestiä, jotka kaatuvat tarkoituksella lipun kääntyessä (`tests/life-alignment-explain.test.mjs` KATKAISIN, `tests/api-explain-readiness.test.mjs` KATKAISIMET), (3) deploy. Kumpikin yksin pitää selityksen pois. Päätös kirjataan tähän riviin |
| PRODUCT_DECISION_REQUIRED | Android versionCode-strategia; tallennetun katsauksen tilannekuva uudelleentallennuksessa; `routine_exceptions`-uniikkius (`docs/FOLLOWUP-routine-exceptions-uniqueness.md`) |
| REAL_DB_ENVIRONMENT_REQUIRED | PostgREST-kerros ja Supabasen `postgres`-rooli (harjoitus ajoi superuserina) — jokaisen aallon tuotantohyväksyntä kattaa |
