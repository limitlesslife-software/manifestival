# Suunta — nopea aktivointi C → J (omistajalle ja Claudelle)

Askel kerrallaan tuotannon nykytilasta (C) aaltoon J. Jokaisella askeleella:
**TILA** / **KOMENTO** (tai liitettävä SQL-tiedosto) / **ODOTUS** / **STOP JOS** /
**SEURAAVA**, ja omistajan viesti, joka avaa askeleen. Politiikka:
[`docs/activation/AUTOMATED-ACCEPTANCE-POLICY.md`](activation/AUTOMATED-ACCEPTANCE-POLICY.md)
(käsin tehtävä selain- ja laitetarkistus on `LIVE_USE_VALIDATION_PENDING` eikä
estä junaa). Kokonaiskuva: [`docs/SUUNTA-ACTIVATION-GO-NOGO.md`](SUUNTA-ACTIVATION-GO-NOGO.md).

Säännöt joka askeleella:

- Claude ei aja tuotantoon SQL:ää eikä kirjoita tuotannon kantaan. Omistaja
  ajaa jokaisen SQL-tiedoston Supabasen SQL-editorissa (**koko tiedosto,
  uusi välilehti**) ja liittää tuloksen; Claude pisteyttää sen.
- Deploy tehdään **aina orkestroijalla** (compare-and-swap, ei koskaan force).
  SHA:t tulevat lukosta `docs/activation/release-train-c-j.json`; tämän
  dokumentin SHA:t päivittää `node tools/activation/train-map.mjs --sync-docs`.
- SQL-tiedostot ajetaan **lukon SQL-lähteestä**, ei tuotehaaran työpuusta.
  SQL-lähde (lukon sqlSource): `rehearsal/wave-j-v2` @ `cba9463155c823a24d0fdb4632ab18a1fcbd01d0`.
  Claude kirjoittaa ne omistajalle `git show` -komennolla hakemistoon
  `.claude/activation/sql/` (git-ignoroitu) ja tarkistaa sha256:n
  dry-runin `SQL:`-riviltä.
- Aina ennen askelta: `npm run activation:dry-run` (Claude). Mikä tahansa
  `STOP:`-rivi = pysähdy ja kerro omistajalle.
- Päiväkirja `.claude/activation/journal.jsonl` on paikallinen ja
  git-ignoroitu.

---

## Askel 0 — tila nyt

- **TILA (2026-09-26, E:n deployn jälkeen):** tuotanto `origin/main` =
  `86c4325` = E (v18), `DEPLOYED_TECHNICALLY_ACCEPTED`; C, D ja E teknisesti
  hyväksytty. Kanta 0001–0008 ajettu, 0009–0013 ei. Seuraava askel: F
  (ensimmäinen migraatio, 0009).
- **KOMENTO (Claude):** `npm run activation:dry-run` (tai `-- --offline`)
- **ODOTUS:** `NEXT_ACTION: DEPLOY D`; `REQUIRED_OWNER_GATE` = vain
  "hyväksyn D"; `REQUIRED_TECHNICAL_GATE` = C:n tekninen hyväksyntä, D:n
  testiajo ja D:n käynnistyssavu; `LIVE_USE_VALIDATION_PENDING: C` tiedoksi.
- **STOP JOS:** `LIVE_MISMATCH`, `LOCK_DRIFT`, `PRODUCTION_INCONSISTENT`,
  `TRAIN_HALTED_RECUT_REQUIRED` tai muu `STOP:`.
- **SEURAAVA:** askel C.

## Askel C — C:n tekninen hyväksyntä (ei omistajan viestiä)

- **TILA:** C tuotannossa, ei vielä `AUTOMATED_TECHNICAL_ACCEPTANCE`:a.
- **KOMENTO (Claude, vain GET + paikallinen päiväkirja):**

```
npm run production:verify-assets -- --wave=C --sha=cf259d0ef755f7e875cc9cd9c15405eba632e408 --record-acceptance
```

- **ODOTUS:** jokainen ehto `OK` (sukulinja, migraatioedellytys, tietoturva,
  esitarkistus, live-sormenjälki, välimuisti ja portit; testiajo ja
  käynnistyssavu poikkeuksella: C deployattiin ennen aktivointityökaluja) →
  `AUTOMATED_TECHNICAL_ACCEPTANCE kirjattu`.
- **STOP JOS:** yksikin `STOP`-rivi (esim. tuotanto ei tarjoile `cf259d0`:aa).
- **SEURAAVA:** askel D. (C:n selainlista `WAVE-C-OWNER-ACCEPTANCE.md` on
  `LIVE_USE_VALIDATION_PENDING`: oikeassa käytössä, ei estä.)

## Askel D — deploy D (v17)

- **OMISTAJAN VIESTI:** **"hyväksyn D"**
- **TILA:** C teknisesti hyväksytty; kanta 0008.
- **KOMENTO (Claude, ennen viestiä):** D:n oma testipatteristo ja
  käynnistyssavu ehdokkaan omissa irrotetuissa työpuissa (työpuut ja tarkat
  komennot dry-runin `REQUIRED_TECHNICAL_GATE`-riviltä), sitten kirjaukset:

```
npm run activation:orchestrate -- --record-candidate-tests=D --sha=091e73c0091e8f135641e3501742b998dbac8461 --tests-result=.claude/activation/tests-D.txt
npm run e2e:boot-smoke -- --root .claude/worktrees/rc-D-smoke --label D --expect-sha 091e73c0091e8f135641e3501742b998dbac8461 > .claude/activation/smoke-D.txt
npm run activation:orchestrate -- --record-boot-smoke=D --sha=091e73c0091e8f135641e3501742b998dbac8461 --smoke-result=.claude/activation/smoke-D.txt
```

- **KOMENTO (Claude, viestin jälkeen):**

```
npm run activation:orchestrate -- --execute-deploy --approved-sha=091e73c0091e8f135641e3501742b998dbac8461   # D v17
```

- **ODOTUS:** `DEPLOY OK` → `VERIFY_LIVE OK` (v17, yhdeksän porttia,
  sormenjälki) → `TECH_ACCEPTANCE` → tila `DEPLOYED_TECHNICALLY_ACCEPTED`;
  päiväkirjaan D:n deploy-rivi.
- **STOP JOS:** testiajo ei vihreä (`fail` > 0 → ei kirjata) tai
  käynnistyssavu ei PASS (`EI KIRJATTU`) — selvitä ennen viestiä;
  `REMOTE_MAIN_MOVED`, `VERIFY_LIVE_FAILED` (orkestroija tulostaa
  peruutuspaketin — peruutus on omistajan päätös).
- **SEURAAVA:** askel E.

## Askel E — deploy E (v18)

- **OMISTAJAN VIESTI:** **"hyväksyn E"**
- **TILA:** D teknisesti hyväksytty (deploy-rivi); kanta 0008.
- **KOMENTO (Claude):** E:n testiajo ja käynnistyssavu kirjauksineen
  (työpuut ja komennot dry-runista kuten D), sitten viestin jälkeen:

```
npm run activation:orchestrate -- --record-candidate-tests=E --sha=86c4325b00e8d58913afebdd0f1eca95d430174e --tests-result=.claude/activation/tests-E.txt
npm run e2e:boot-smoke -- --root .claude/worktrees/rc-E-smoke --label E --expect-sha 86c4325b00e8d58913afebdd0f1eca95d430174e > .claude/activation/smoke-E.txt
npm run activation:orchestrate -- --record-boot-smoke=E --sha=86c4325b00e8d58913afebdd0f1eca95d430174e --smoke-result=.claude/activation/smoke-E.txt
npm run activation:orchestrate -- --execute-deploy --approved-sha=86c4325b00e8d58913afebdd0f1eca95d430174e   # E v18
```

- **ODOTUS:** `DEPLOYED_TECHNICALLY_ACCEPTED` (v18, kaikki kymmenen
  0003–0008-porttia auki).
- **STOP JOS:** kuten D.
- **SEURAAVA:** askel F (ensimmäinen migraatio).

## Askel F — migraatio 0009 + deploy F (v19)

- **OMISTAJAN VIESTI:** **"hyväksyn 0009/F"** (kattaa migraation 0009 ja F:n
  deployn, kun `verify_0009` = 0)
- **TILA:** E teknisesti hyväksytty; kanta 0008.
- **KOMENTO (Claude):** F:n testiajo ja käynnistyssavu kirjauksineen
  (työpuut ja komennot dry-runista kuten D), SQL-tiedostot lukon lähteestä:

```
npm run activation:orchestrate -- --record-candidate-tests=F --sha=2c8e230f8864ce0df1529718fb17ae265fb5d82b --tests-result=.claude/activation/tests-F.txt
npm run e2e:boot-smoke -- --root .claude/worktrees/rc-F-smoke --label F --expect-sha 2c8e230f8864ce0df1529718fb17ae265fb5d82b > .claude/activation/smoke-F.txt
npm run activation:orchestrate -- --record-boot-smoke=F --sha=2c8e230f8864ce0df1529718fb17ae265fb5d82b --smoke-result=.claude/activation/smoke-F.txt
git show cba9463155c823a24d0fdb4632ab18a1fcbd01d0:supabase/preflight/preflight_0009.sql > .claude/activation/sql/preflight_0009.sql
git show cba9463155c823a24d0fdb4632ab18a1fcbd01d0:supabase/migrations/0009_finance_2.sql > .claude/activation/sql/0009_finance_2.sql
git show cba9463155c823a24d0fdb4632ab18a1fcbd01d0:supabase/verify/verify_0009.sql > .claude/activation/sql/verify_0009.sql
```

1. **Omistaja (vain luku):** `supabase/acceptance/activation_readonly_inventory.sql`
   (rivi 00) ja `preflight_0009.sql` → liitä molemmat.
2. **Claude:** `node tools/activation/score-inventory.mjs --code-wave=origin-main <inventaario>`
   → GO; `node tools/activation/score-sql-result.mjs --sql=supabase/preflight/preflight_0009.sql <tulos>`
   → GO; `npm run activation:orchestrate -- --inventory=<inventaario> --preflight-result=<tulos>`
   → `STOP_OWNER_MIGRATION` (vain omistajan hyväksyntä auki).
3. **Omistaja:** "hyväksyn 0009/F" → aja `0009_finance_2.sql` kokonaan.
4. **Omistaja (vain luku):** `verify_0009.sql` ja uusi inventaario → liitä.
5. **Claude:** `score-sql-result.mjs --sql=supabase/verify/verify_0009.sql <tulos>` → GO, sitten:

```
npm run activation:orchestrate -- --execute-deploy --approved-sha=2c8e230f8864ce0df1529718fb17ae265fb5d82b --inventory=<uusi-inventaario> --verify-result=<verify_0009-tulos>   # F v19
```

- **ODOTUS:** preflight 0 FAIL; migraatio `COMMIT`; verify 0 poikkeavaa;
  `DEPLOYED_TECHNICALLY_ACCEPTED` (v19).
- **STOP JOS:** testiajo tai käynnistyssavu ei kirjaudu (ei PASS);
  preflight FAIL tai poikkeavia > 0; migraatio päättyy
  virheeseen (yksi transaktio perutaan kokonaan — älä aja tiedoston osia);
  verify ≠ 0 → **älä deployaa** (`WAVE-F.md` §6).
- **SEURAAVA:** askel G.

## Askel G — tilannekuva + migraatio 0010 + deploy G (v20) — KORKEA riski

- **OMISTAJAN VIESTI:** **"hyväksyn 0010/G"** — erillinen hyväksyntä, vasta
  kun tilannekuva on tarkistettu. (Valinnainen T-2-kuivaharjoitus tuotannossa
  on oma hyväksyntänsä: `docs/activation/0010-BACKUP-AND-RECOVERY.md` §4.)
- **TILA:** F teknisesti hyväksytty; kanta 0009.
- **KOMENTO (Claude):** G:n testiajo ja käynnistyssavu kirjauksineen
  (työpuut ja komennot dry-runista kuten D), SQL-tiedostot:

```
npm run activation:orchestrate -- --record-candidate-tests=G --sha=4eb93a9e386123042485881fad9aa91b862069c7 --tests-result=.claude/activation/tests-G.txt
npm run e2e:boot-smoke -- --root .claude/worktrees/rc-G-smoke --label G --expect-sha 4eb93a9e386123042485881fad9aa91b862069c7 > .claude/activation/smoke-G.txt
npm run activation:orchestrate -- --record-boot-smoke=G --sha=4eb93a9e386123042485881fad9aa91b862069c7 --smoke-result=.claude/activation/smoke-G.txt
git show cba9463155c823a24d0fdb4632ab18a1fcbd01d0:supabase/preflight/preflight_0010.sql > .claude/activation/sql/preflight_0010.sql
git show cba9463155c823a24d0fdb4632ab18a1fcbd01d0:supabase/migrations/0010_goal_to_action.sql > .claude/activation/sql/0010_goal_to_action.sql
git show cba9463155c823a24d0fdb4632ab18a1fcbd01d0:supabase/verify/verify_0010.sql > .claude/activation/sql/verify_0010.sql
```

1. **Omistaja:** sulje sovellus kaikilta laitteilta.
2. **Omistaja (vain luku), PAKOLLINEN tilannekuva:** `supabase/backup/snapshot_state_0009.sql`
   → vie koko tulos tiedostoksi projektikansioon.
3. **Claude:** `node tools/activation/restore-snapshot.mjs check <vienti> --save`
   → **TILANNEKUVA KUNNOSSA** (ei RLS-suodatusta; arkisto
   `.local-backups/db/<UTC>_state_0009/`). Valmiiksi: `compare` ja
   `restore --dry-run` samasta viennistä.
4. **Omistaja (vain luku):** inventaario ja `preflight_0010.sql` → liitä.
   **Claude:** `score-inventory.mjs --code-wave=origin-main <inventaario>` → GO;
   `node tools/activation/score-sql-result.mjs --sql=supabase/preflight/preflight_0010.sql <tulos>`
   → GO (rivi 09: rajoite olemassa); orkestroija `--inventory --preflight-result`
   → `STOP_OWNER_MIGRATION`.
5. **Omistaja:** "hyväksyn 0010/G" → aja `0010_goal_to_action.sql` kokonaan.
6. **Omistaja (vain luku):** `verify_0010.sql` (rivit 20–22: tilarajoite) ja
   uusi inventaario → liitä. **Claude:**
   `node tools/activation/score-sql-result.mjs --sql=supabase/verify/verify_0010.sql <tulos>` → GO, sitten:

```
npm run activation:orchestrate -- --execute-deploy --approved-sha=4eb93a9e386123042485881fad9aa91b862069c7 --inventory=<uusi-inventaario> --verify-result=<verify_0010-tulos>   # G v20
```

- **ODOTUS:** tilannekuva kunnossa; verify 0 poikkeavaa; `compare.sql` →
  SAMA; `DEPLOYED_TECHNICALLY_ACCEPTED` (v20).
- **STOP JOS:** testiajo tai käynnistyssavu ei kirjaudu; `check` hylkää
  kuvan; preflight FAIL; migraatio virheeseen
  (koko transaktio perutaan; vain tiedoston OSAN ajaminen voisi jättää
  `goals`-taulun ilman tilarajoitetta — `preflight_0010` rivi 09 ja
  `verify_0010` rivi 20 paljastavat sen); verify ≠ 0 → päätöspuu
  `docs/activation/0010-BACKUP-AND-RECOVERY.md` §7.
- **SEURAAVA:** askel H.

## Askel H — migraatio 0011 + deploy H (v21)

- **OMISTAJAN VIESTI:** **"hyväksyn 0011/H"**
- **TILA:** G teknisesti hyväksytty; kanta 0010. H on leikattu uudelleen
  (H v5) ja lukittu; lukon deploykohde sisältää pakolliset korjaukset. Jos
  alle ilmestyy STOP-rivi, orkestroija pysähtyy `TRAIN_RECUT_REQUIRED`
  (pääkehittäjä: leikkaa, `train-map --write`, `train-map --sync-docs`).
- **KOMENTO (Claude):** H:n testiajo ja käynnistyssavu kirjauksineen
  (työpuut ja komennot dry-runista kuten D), SQL-tiedostot:

```
npm run activation:orchestrate -- --record-candidate-tests=H --sha=388cd990a1f764d08e9596bcb0c874451bcb21a9 --tests-result=.claude/activation/tests-H.txt
npm run e2e:boot-smoke -- --root .claude/worktrees/rc-H-smoke --label H --expect-sha 388cd990a1f764d08e9596bcb0c874451bcb21a9 > .claude/activation/smoke-H.txt
npm run activation:orchestrate -- --record-boot-smoke=H --sha=388cd990a1f764d08e9596bcb0c874451bcb21a9 --smoke-result=.claude/activation/smoke-H.txt
git show cba9463155c823a24d0fdb4632ab18a1fcbd01d0:supabase/preflight/preflight_0011.sql > .claude/activation/sql/preflight_0011.sql
git show cba9463155c823a24d0fdb4632ab18a1fcbd01d0:supabase/migrations/0011_personal_assistant.sql > .claude/activation/sql/0011_personal_assistant.sql
git show cba9463155c823a24d0fdb4632ab18a1fcbd01d0:supabase/verify/verify_0011.sql > .claude/activation/sql/verify_0011.sql
```

1. **Omistaja (vain luku):** inventaario ja `preflight_0011.sql` → liitä. **Claude:**
   `node tools/activation/score-sql-result.mjs --sql=supabase/preflight/preflight_0011.sql <tulos>` → GO;
   orkestroija `--inventory --preflight-result` → `STOP_OWNER_MIGRATION`.
2. **Omistaja:** "hyväksyn 0011/H" → aja `0011_personal_assistant.sql` kokonaan.
3. **Omistaja (vain luku):** `verify_0011.sql` ja uusi inventaario → liitä. **Claude:**
   `node tools/activation/score-sql-result.mjs --sql=supabase/verify/verify_0011.sql <tulos>` → GO, sitten:

```
npm run activation:orchestrate -- --execute-deploy --approved-sha=388cd990a1f764d08e9596bcb0c874451bcb21a9 --inventory=<uusi-inventaario> --verify-result=<verify_0011-tulos>   # H v21
```

- **ODOTUS:** `DEPLOYED_TECHNICALLY_ACCEPTED` (v21).
- **STOP JOS:** STOP-rivi yllä (uudelleenleikkaus kesken); testiajo tai
  käynnistyssavu ei kirjaudu; preflight FAIL; verify ≠ 0.
- **SEURAAVA:** askel I.

## Askel I — migraatio 0012 + deploy I (v22)

- **OMISTAJAN VIESTI:** **"hyväksyn 0012/I"**
- **TILA:** H teknisesti hyväksytty; kanta 0011. Leikattu uudelleen (I v3)
  ja lukittu kuten H.
- **KOMENTO (Claude):** I:n testiajo ja käynnistyssavu kirjauksineen
  (työpuut ja komennot dry-runista kuten D), SQL-tiedostot:

```
npm run activation:orchestrate -- --record-candidate-tests=I --sha=4a24fdf3e2cb74473c4066329a0b693862a0e019 --tests-result=.claude/activation/tests-I.txt
npm run e2e:boot-smoke -- --root .claude/worktrees/rc-I-smoke --label I --expect-sha 4a24fdf3e2cb74473c4066329a0b693862a0e019 > .claude/activation/smoke-I.txt
npm run activation:orchestrate -- --record-boot-smoke=I --sha=4a24fdf3e2cb74473c4066329a0b693862a0e019 --smoke-result=.claude/activation/smoke-I.txt
git show cba9463155c823a24d0fdb4632ab18a1fcbd01d0:supabase/preflight/preflight_0012.sql > .claude/activation/sql/preflight_0012.sql
git show cba9463155c823a24d0fdb4632ab18a1fcbd01d0:supabase/migrations/0012_life_alignment.sql > .claude/activation/sql/0012_life_alignment.sql
git show cba9463155c823a24d0fdb4632ab18a1fcbd01d0:supabase/verify/verify_0012.sql > .claude/activation/sql/verify_0012.sql
```

1. **Omistaja (vain luku):** inventaario ja `preflight_0012.sql` → liitä. **Claude:**
   `node tools/activation/score-sql-result.mjs --sql=supabase/preflight/preflight_0012.sql <tulos>` → GO;
   orkestroija `--inventory --preflight-result` → `STOP_OWNER_MIGRATION`.
2. **Omistaja:** "hyväksyn 0012/I" → aja `0012_life_alignment.sql` kokonaan.
3. **Omistaja (vain luku):** `verify_0012.sql` ja uusi inventaario → liitä. **Claude:**
   `node tools/activation/score-sql-result.mjs --sql=supabase/verify/verify_0012.sql <tulos>` → GO, sitten:

```
npm run activation:orchestrate -- --execute-deploy --approved-sha=4a24fdf3e2cb74473c4066329a0b693862a0e019 --inventory=<uusi-inventaario> --verify-result=<verify_0012-tulos>   # I v22
```

- **ODOTUS:** `DEPLOYED_TECHNICALLY_ACCEPTED` (v22). Säilytä `verify_0012`-tulos:
  se on 0013:n edellytys.
- **STOP JOS:** kuten H.
- **SEURAAVA:** askel J.

## Askel J — migraatio 0013 + deploy J (v23)

- **OMISTAJAN VIESTI:** **"hyväksyn 0013/J"**
- **TILA:** I teknisesti hyväksytty; kanta 0012; `verify_0012` = 0 poikkeavaa.
  Leikattu uudelleen (J v2) ja lukittu kuten H; J on lukon SQL-lähde.
- **KOMENTO (Claude):** J:n testiajo ja käynnistyssavu kirjauksineen
  (työpuut ja komennot dry-runista kuten D), SQL-tiedostot:

```
npm run activation:orchestrate -- --record-candidate-tests=J --sha=cba9463155c823a24d0fdb4632ab18a1fcbd01d0 --tests-result=.claude/activation/tests-J.txt
npm run e2e:boot-smoke -- --root .claude/worktrees/rc-J-smoke --label J --expect-sha cba9463155c823a24d0fdb4632ab18a1fcbd01d0 > .claude/activation/smoke-J.txt
npm run activation:orchestrate -- --record-boot-smoke=J --sha=cba9463155c823a24d0fdb4632ab18a1fcbd01d0 --smoke-result=.claude/activation/smoke-J.txt
git show cba9463155c823a24d0fdb4632ab18a1fcbd01d0:supabase/preflight/preflight_0013.sql > .claude/activation/sql/preflight_0013.sql
git show cba9463155c823a24d0fdb4632ab18a1fcbd01d0:supabase/migrations/0013_alignment_reality.sql > .claude/activation/sql/0013_alignment_reality.sql
git show cba9463155c823a24d0fdb4632ab18a1fcbd01d0:supabase/verify/verify_0013.sql > .claude/activation/sql/verify_0013.sql
```

1. **Omistaja (vain luku):** inventaario, `verify_0012.sql` (edellytys) ja
   `preflight_0013.sql` → liitä. **Claude:**
   `node tools/activation/score-sql-result.mjs --sql=supabase/verify/verify_0012.sql <tulos>` ja
   `node tools/activation/score-sql-result.mjs --sql=supabase/preflight/preflight_0013.sql <tulos>` → GO;
   orkestroija `--inventory --preflight-result` → `STOP_OWNER_MIGRATION`.
2. **Omistaja:** "hyväksyn 0013/J" → aja `0013_alignment_reality.sql` kokonaan.
3. **Omistaja (vain luku):** `verify_0013.sql` ja uusi inventaario → liitä. **Claude:**
   `node tools/activation/score-sql-result.mjs --sql=supabase/verify/verify_0013.sql <tulos>` → GO, sitten:

```
npm run activation:orchestrate -- --execute-deploy --approved-sha=cba9463155c823a24d0fdb4632ab18a1fcbd01d0 --inventory=<uusi-inventaario> --verify-result=<verify_0013-tulos>   # J v23
```

4. **Claude:** AI-selitys suljettu (`WAVE-J.md` kohta 3: `GET /api/explain` 405,
   `POST` 503, `OPTIONS` 204; ei tunnuksia, ei maksullista kutsua).

- **ODOTUS:** `DEPLOYED_TECHNICALLY_ACCEPTED` (v23); dry-run `GO: DONE`.
- **STOP JOS:** kuten H; `/api/explain` POST antaa 401 tai 200.
- **SEURAAVA:** APK.

## Askel APK — puhelin (J:n jälkeen)

- **TILA:** J tuotannossa ja teknisesti hyväksytty, `verify_0013` = 0.
- **KOMENTO:** `docs/activation/ANDROID-ACCEPTANCE-BUILD.md` (koonti ja
  `verify-apk`); versionCode-politiikka on omistajan hyväksyntä.
- **ODOTUS:** APK asentuu; Day 1 (`docs/SUUNTA-DAY1-ACCEPTANCE.md`) on
  `LIVE_USE_VALIDATION_PENDING` — oikeassa käytössä, ei PASS.
- **STOP JOS:** `verify_0013` ≠ 0 tai J ei ole tuotannossa: **älä asenna**.
- **SEURAAVA:** päivittäinen käyttö.
