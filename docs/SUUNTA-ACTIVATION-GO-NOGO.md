# Suunta — aktivoinnin GO/NO-GO (päivitetty 2026-09-26: automaattinen tekninen hyväksyntä)

**Tuotanto nyt:** `origin/main` = `cf259d0` = **aalto C** (v16). Todennettu
lukevalla GET:llä tuotannon tiedostoista 2026-09-26 (C:n kuusi porttia auki,
D–J kiinni). Kanta: migraatiot 0001–0008 ajettu, 0009–0013 ei
(`docs/activation/PRODUCTION-INVENTORY-2026-09-26.md`).

**Hyväksyntäpolitiikka (omistajan päätös 2026-09-26, sitova):** historiallisten
aaltojen käsin tehtävä selain- ja laitehyväksyntä **siirtyy oikeaan käyttöön
eikä pysäytä junaa**. Jokainen aalto hyväksytään koneellisesti tilaan
`AUTOMATED_TECHNICAL_ACCEPTANCE`; käyttöliittymän ja laitteen käytös on
`LIVE_USE_VALIDATION_PENDING` eikä sitä koskaan kutsuta PASSiksi. Ehdot,
komennot ja kirjauspaikka aalloittain:
[`docs/activation/AUTOMATED-ACCEPTANCE-POLICY.md`](activation/AUTOMATED-ACCEPTANCE-POLICY.md).
Tämä korvaa aiemman aaltokohtaisen selainhyväksyntäportin.

**Nopein polku askel askeleelta (tila / komento / odotus / STOP / seuraava /
omistajan viesti):** [`docs/SUUNTA-FAST-ACTIVATION.md`](SUUNTA-FAST-ACTIVATION.md).

**Omistajan hyväksyntä vaaditaan vain:** jokainen tuotantomigraatio
(0009–0014; **0010 erikseen + varmuuskopio**), jokainen tuotantodeploy (D–K),
valinnainen T-2-varmuuskopion kuivaharjoitus tuotannossa, AI-selityksen
käyttöönotto ja Androidin versionCode-politiikka. Hyväksyntä annetaan
lyhyellä viestillä: "hyväksyn D", "hyväksyn E", "hyväksyn 0009/F",
"hyväksyn 0010/G", "hyväksyn 0011/H", "hyväksyn 0012/I", "hyväksyn 0013/J",
"hyväksyn 0014/K".

**Kaikki migraatiot 0009–0013 on harjoiteltu oikealla PostgreSQL 17:llä**
tuotannon muotoisesta datasta: ketju, RLS (311 tarkistusta), virheet
(31), peruutukset (5/5), esitarkistukset (35) — 0 hylättyä
(`docs/activation/REHEARSAL-REPORT.md`).

| Aalto | Sisältö | Deploykohde | Migraatio | Tila | Omistajan toimi | Riski | Peruutus |
|---|---|---|---|---|---|---|---|
| **C** v16 | rutiinit, poikkeukset | `cf259d0ef755f7e875cc9cd9c15405eba632e408` | — | **DEPLOYATTU**; `AUTOMATED_TECHNICAL_ACCEPTANCE` kirjattu 2026-09-26 | ei hyväksyntää (Claude kirjaa `AUTOMATED_TECHNICAL_ACCEPTANCE`); käyttö `LIVE_USE_VALIDATION_PENDING` | matala | revert (vie v17:n → numerointi siirtyy) |
| **D** v17 | laskut, menot, säästöt | `091e73c0091e8f135641e3501742b998dbac8461` | — | **DEPLOYATTU** 2026-09-26 ("hyväksyn D"); `AUTOMATED_TECHNICAL_ACCEPTANCE` kirjattu; testit 1595/1596, käynnistyssavu 27/27 | "hyväksyn D" | matala | aalto C |
| **E** v18 | AI-kirjausketju | `86c4325b00e8d58913afebdd0f1eca95d430174e` (`release/activation-0003-0008`) | — | **DEPLOYATTU** 2026-09-26 ("hyväksyn E"); `AUTOMATED_TECHNICAL_ACCEPTANCE` kirjattu | "hyväksyn E" (E:ssä ei ole kirjoituspolkua käyttöliittymästä: taulu pysyy tyhjänä) | matala | D |
| **F** v19 | Talous 2.0 | `2c8e230f8864ce0df1529718fb17ae265fb5d82b` (`rehearsal/wave-f-v4`, tuotannossa) | **0009** (ajettu 2026-09-26, verify 34/34) | **DEPLOYATTU** 2026-09-26; `AUTOMATED_TECHNICAL_ACCEPTANCE` kirjattu | "hyväksyn 0009/F" (migraatio + deploy, kun verify_0009 = 0) | matala | E + 0009 ROLLBACK |
| **G** v20 | Tavoitteesta tekemiseksi | `4eb93a9e386123042485881fad9aa91b862069c7` (`rehearsal/wave-g-v5`) | **0010** | READY 0010:n jälkeen | **erillinen** "hyväksyn 0010/G" + **varmuuskopio** ensin ([`0010-BACKUP-AND-RECOVERY.md`](activation/0010-BACKUP-AND-RECOVERY.md)) | **KORKEA** (muuttaa goals/tasks/projects/profile) | F + 0010 ROLLBACK |
| **H** v21 | Henkilökohtainen avustaja | `388cd990a1f764d08e9596bcb0c874451bcb21a9` (`rehearsal/wave-h-v5`) | **0011** | READY 0011:n jälkeen | "hyväksyn 0011/H" | matala | G |
| **I** v22 | **Suunta 1** | `4a24fdf3e2cb74473c4066329a0b693862a0e019` (`rehearsal/wave-i-v3`) | **0012** | READY 0012:n jälkeen | "hyväksyn 0012/I" (välivaihe) | keski (goals + sarake) | H |
| **J** v23 | **Suunta 2** (ajastin, energia, katsaus v2) + yön korjaukset | `cba9463155c823a24d0fdb4632ab18a1fcbd01d0` (`rehearsal/wave-j-v2`) | **0013** | READY 0013:n jälkeen | "hyväksyn 0013/J", sitten APK (vasta kun verify_0013 = 0 ja J on tuotannossa) | matala | I (aika säilyy) |
| **K** v24 | **Arjen käyttöjärjestelmä** (kalenteri, paikat, uni, herätys, tavat, liikunta) | `d11d8b4661bc84c2e90b668132c11104db4cf203` (`rehearsal/wave-k-v1`) | **0014** | READY 0014:n jälkeen (K v1 lukittu J v2:n päälle; lukon SQL-lähde 0009–0014) | "hyväksyn 0014/K" (vasta kun verify_0013 = 0 ja J on tuotannossa; vain uusia tyhjiä tauluja, tilannekuva ei pakollinen) | matala | J (taulut jäävät) |

Deploykohde on **lukon** `docs/activation/release-train-c-j.json` täysi SHA
(`deployTarget`) — ei haaran nimi eikä manifestin aaltocommit. Lukon
tarkistus: `npm run activation:train-map`. Koneellinen kartta (jokaisen
kohteen oma `sw.js`/`schema.js`: v16→v24 nousevat, ei törmäyksiä, ei
ennenaikaisia portteja; jokainen aalto edellisen jälkeläinen).
Paketit: `docs/activation/MIGRATION-BUNDLES.md`. Uudelleenleikatun tai
uuden aallon SHA päivittyy lukosta (`train-map --write`, sitten
`train-map --sync-docs`), eikä sitä kirjoiteta käsin.

---

## Seuraavaksi

**1. (Claude, vain luku)** `npm run activation:dry-run` (tai `-- --offline`).
Odotettu: `NEXT_ACTION: DEPLOY D` — **ei** migraatio 0009: se odottaa, kunnes E
on tuotannossa ja teknisesti hyväksytty. `REQUIRED_OWNER_GATE` sisältää vain
omistajan hyväksynnän "hyväksyn D"; `REQUIRED_TECHNICAL_GATE` kertoo Clauden
koneelliset askeleet (C:n tekninen hyväksyntä, D:n testiajo ja käynnistyssavu);
`LIVE_USE_VALIDATION_PENDING` tulostetaan tiedoksi. Tuore inventaario
(`supabase/acceptance/activation_readonly_inventory.sql`, vain luku) tarvitaan
vasta ennen migraatiota 0009.

**2. (Claude)** C:n tekninen hyväksyntä live-todennuksesta — kirjaus menee
paikalliseen, git-ignoroituun päiväkirjaan `.claude/activation/journal.jsonl`:
`npm run production:verify-assets -- --wave=C --sha=cf259d0ef755f7e875cc9cd9c15405eba632e408 --record-acceptance`.
Aallon C selainlista (`docs/acceptance/WAVE-C-OWNER-ACCEPTANCE.md`) on
`LIVE_USE_VALIDATION_PENDING`: tehdään oikeassa käytössä, ei estä D:tä.

**3. (Claude)** D:n oma testipatteristo ja käynnistyssavu ehdokkaan omissa
työpuissa ja niiden kirjaus (`--record-candidate-tests`, `--record-boot-smoke`;
komennot dry-runin `REQUIRED_TECHNICAL_GATE`-rivillä).

**4. (omistaja)** "hyväksyn D" → Claude ajaa orkestroijan, joka tarkistaa
lukon, teknisen hyväksynnän, testiajon, käynnistyssavun ja esitarkistuksen, varmistaa että
`origin`in main on yhä tuotannon SHA (compare-and-swap), pushaa **lukon
deployTargetin** (ei koskaan force), todentaa tuotannon (välimuisti, portit,
sarakeportit, sormenjälki) ja kirjaa D:n `AUTOMATED_TECHNICAL_ACCEPTANCE`:n.
E samalla kaavalla ("hyväksyn E").

**5. Jokainen migraatioaalto F–K:** omistaja ajaa `preflight_00XX.sql`:n
(vain luku) ja liittää tuloksen → Claude pisteyttää
(`node tools/activation/score-sql-result.mjs`) → "hyväksyn 00XX/W" →
omistaja ajaa migraation → omistaja ajaa `verify_00XX.sql`:n ja liittää →
Claude pisteyttää → Claude deployaa orkestroijalla → live-todennus →
tekninen hyväksyntä kirjataan. 0010:lle ensin tuore tilannekuva
(`supabase/backup/snapshot_state_0009.sql` + `restore-snapshot.mjs check`;
[`docs/activation/0010-BACKUP-AND-RECOVERY.md`](activation/0010-BACKUP-AND-RECOVERY.md)).
F–J on leikattu uudelleen (F v4, G v5, H v5, I v3, J v2) ja lukittu
2026-09-26: jokainen deploykohde sisältää pakolliset korjaukset
(`train-map.mjs` REQUIRED_PATCHES), ja jokaisen ehdokkaan oma
testipatteristo ja käynnistyssavu on kirjattu päiväkirjaan. K v1 on
leikattu J v2:n päälle ja lukittu 2026-09-27 (lukon SQL-lähde 0009–0014);
sen testiajo ja käynnistyssavu kirjataan ennen migraatiota 0014
(orkestroija vaatii ne, `CANDIDATE_TESTS_REQUIRED`, `BOOT_SMOKE_REQUIRED`). Jos lukko
jää korjauksesta jälkeen, orkestroija pysähtyy (`TRAIN_RECUT_REQUIRED`)
ja STOP-rivi pysyy, kunnes lukko on kirjoitettu uusilla SHA:illa.

Deploy-komennot lukosta (ensisijainen askel; `--sync-docs` päivittää ne):

```
npm run activation:orchestrate -- --execute-deploy --approved-sha=091e73c0091e8f135641e3501742b998dbac8461   # D v17
npm run activation:orchestrate -- --execute-deploy --approved-sha=86c4325b00e8d58913afebdd0f1eca95d430174e   # E v18
npm run activation:orchestrate -- --execute-deploy --approved-sha=2c8e230f8864ce0df1529718fb17ae265fb5d82b --verify-result=<verify_0009-tulos>   # F v19
npm run activation:orchestrate -- --execute-deploy --approved-sha=4eb93a9e386123042485881fad9aa91b862069c7 --verify-result=<verify_0010-tulos>   # G v20
npm run activation:orchestrate -- --execute-deploy --approved-sha=388cd990a1f764d08e9596bcb0c874451bcb21a9 --verify-result=<verify_0011-tulos>   # H v21
npm run activation:orchestrate -- --execute-deploy --approved-sha=4a24fdf3e2cb74473c4066329a0b693862a0e019 --verify-result=<verify_0012-tulos>   # I v22
npm run activation:orchestrate -- --execute-deploy --approved-sha=cba9463155c823a24d0fdb4632ab18a1fcbd01d0 --verify-result=<verify_0013-tulos>   # J v23
npm run activation:orchestrate -- --execute-deploy --approved-sha=d11d8b4661bc84c2e90b668132c11104db4cf203 --verify-result=<verify_0014-tulos>   # K v24
```

Push-kohteet (viitteeksi — orkestroija ajaa nämä compare-and-swapin jälkeen;
älä aja käsin):

```
git push origin 091e73c0091e8f135641e3501742b998dbac8461:refs/heads/main   # D v17
git push origin 86c4325b00e8d58913afebdd0f1eca95d430174e:refs/heads/main   # E v18
git push origin 2c8e230f8864ce0df1529718fb17ae265fb5d82b:refs/heads/main   # F v19
git push origin 4eb93a9e386123042485881fad9aa91b862069c7:refs/heads/main   # G v20
git push origin 388cd990a1f764d08e9596bcb0c874451bcb21a9:refs/heads/main   # H v21
git push origin 4a24fdf3e2cb74473c4066329a0b693862a0e019:refs/heads/main   # I v22
git push origin cba9463155c823a24d0fdb4632ab18a1fcbd01d0:refs/heads/main   # J v23
git push origin d11d8b4661bc84c2e90b668132c11104db4cf203:refs/heads/main   # K v24
```

**6.** J:n jälkeen: APK puhelimeen (`docs/activation/ANDROID-ACCEPTANCE-BUILD.md`)
**vasta kun `verify_0013` = 0 ja J on tuotannossa**; Day 1
(`docs/SUUNTA-DAY1-ACCEPTANCE.md`) on `LIVE_USE_VALIDATION_PENDING`.

**7.** K (0014) J:n jälkeen samalla kaavalla kuin kohta 5: edellytys
`verify_0013` = 0, sitten "hyväksyn 0014/K" → 0014 → `verify_0014` = 0 →
deploy K. Riski matala (vain uusia tyhjiä tauluja), tilannekuva ei pakollinen.

**Nopein turvallinen polku päivittäiseen käyttöön:** C (tekninen) → D → E →
0009/F → 0010/G → 0011/H → 0012/I → 0013/J → puhelin → 0014/K. Jokainen deploy ja
migraatio on oma omistajan hyväksyntänsä; D ja E eivät vaadi migraatiota.
Kaikki migraatiot ovat taaksepäin yhteensopivia edellisen aallon koodin
kanssa (todennettu), joten tauko minkä tahansa aallon jälkeen on turvallinen.

---

## Jäljellä olevat esteet (vain nämä luokat)

| Luokka | Mitä |
|---|---|
| OWNER_DEPLOY_APPROVAL_REQUIRED | Aaltojen D–K deployt: "hyväksyn D", "hyväksyn E", F–K migraatioviestin kautta |
| OWNER_PRODUCTION_MIGRATION_APPROVAL_REQUIRED | "hyväksyn 0009/F", **"hyväksyn 0010/G" (erikseen, tilannekuva ensin)**, "hyväksyn 0011/H", "hyväksyn 0012/I", "hyväksyn 0013/J", "hyväksyn 0014/K" |
| OWNER_READ_ONLY_SQL_REQUIRED | Omistajan syöte, ei hyväksyntä: tuore inventaario ennen 0009:ää, `preflight_00XX.sql`- ja `verify_00XX.sql`-tulokset (vain luku, liitetään Claudelle) |
| TECHNICAL_ACCEPTANCE_REQUIRED | Claude: tuotannon aallon `AUTOMATED_TECHNICAL_ACCEPTANCE` päiväkirjaan (C live-todennuksesta, D–K orkestroijan deploysta) |
| CANDIDATE_TESTS_REQUIRED | Claude: ehdokkaan oma täysi testipatteristo vihreänä ja kirjattuna ennen sen migraatiota tai deployta |
| BOOT_SMOKE_REQUIRED | Claude: ehdokkaan käynnistyssavu (`npm run e2e:boot-smoke`, omalla koodilla ja porteilla) PASSina ja kirjattuna (`--record-boot-smoke`) ennen sen migraatiota tai deployta |
| LIVE_USE_VALIDATION_PENDING | Kaikki käsin tehtävät selain- ja laitetarkistukset (WAVE-X.md kohta 4, `WAVE-C-OWNER-ACCEPTANCE.md`, Day 1): oikeassa käytössä, **ei estä junaa, ei koskaan PASS** |
| PHONE_ACCEPTANCE_REQUIRED | Day 1 puhelimella J:n jälkeen — `LIVE_USE_VALIDATION_PENDING` (ei estä); APK asennetaan vasta kun `verify_0013` = 0 ja J on tuotannossa |
| OPTIONAL_OWNER_APPROVAL | T-2-varmuuskopion kuivaharjoitus tuotannossa (valinnainen, oma hyväksyntänsä; `docs/activation/0010-BACKUP-AND-RECOVERY.md`) |
| EXTERNAL_PROVIDER_REQUIRED | `ANTHROPIC_API_KEY` Vercelissä (`docs/DEPLOYMENT.md` kirjaa sen olemassa olevaksi, Production + Preview — tarkista hallintapaneelista): tekstikomennot (aalto H:n ensimmäinen oikea AI-kirjausrivi). AI-selitys ei käytä avainta ennen kuin se kytketään päälle (alla) |
| OPTIONAL_DAY1 · OWNER_DECISION | **AI-selitys (`/api/explain`) on pois, eikä Day 1 tarvitse sitä.** Aalto J deployaa päätepisteen suljettuna: `EXPLAIN_ENABLED` ei asetettu → 503 ennen todennusta, ei Anthropic-kutsuja; selaimen `AI_EXPLAIN_ENABLED = false` → ei "Selitä tekoälyllä" -painiketta. Käyttöönotto = omistajan hyväksyntä: (1) `EXPLAIN_ENABLED=true` Verceliin (Production), (2) `AI_EXPLAIN_ENABLED = true` omassa commitissaan + `CACHE_VERSION`-nosto; sama commit päivittää kaksi KATKAISIN-vartijatestiä, jotka kaatuvat tarkoituksella lipun kääntyessä (`tests/life-alignment-explain.test.mjs` KATKAISIN, `tests/api-explain-readiness.test.mjs` KATKAISIMET), (3) deploy. Kumpikin yksin pitää selityksen pois. Päätös kirjataan tähän riviin |
| PRODUCT_DECISION_REQUIRED | Android versionCode-strategia (omistajan hyväksyntä); tallennetun katsauksen tilannekuva uudelleentallennuksessa; `routine_exceptions`-uniikkius (`docs/FOLLOWUP-routine-exceptions-uniqueness.md`) |
| REAL_DB_ENVIRONMENT_REQUIRED | PostgREST-kerros ja Supabasen `postgres`-rooli (harjoitus ajoi superuserina) — jokaisen aallon `verify_00XX.sql` tuotannossa kattaa |
