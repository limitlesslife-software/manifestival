# Automaattinen tekninen hyväksyntä — junan C–J hyväksyntäpolitiikka

**Omistajan päätös 2026-09-26, sitova.** Tämä dokumentti **korvaa aiemman
aaltokohtaisen selainhyväksyntäportin** (`docs/acceptance/WAVE-X.md` kohta 4 ja
`docs/acceptance/WAVE-C-OWNER-ACCEPTANCE.md` junan esteenä). Koneellinen puoli:
`tools/activation/acceptance-policy.mjs`; askeleet omistajalle ja Claudelle:
[`docs/SUUNTA-FAST-ACTIVATION.md`](../SUUNTA-FAST-ACTIVATION.md); tila:
[`docs/SUUNTA-ACTIVATION-GO-NOGO.md`](../SUUNTA-ACTIVATION-GO-NOGO.md).

## Periaate

- Historiallisten aaltojen käsin tehtävä selain- ja laitehyväksyntä
  **siirtyy oikeaan käyttöön eikä pysäytä junaa**.
- Jokainen aalto hyväksytään junan kannalta tilaan
  **`AUTOMATED_TECHNICAL_ACCEPTANCE`**, kun **kaikki** alla olevat koneelliset
  ehdot täyttyvät ja tulos on kirjattu päiväkirjaan.
- Käyttöliittymän ja laitteen käytös on **`LIVE_USE_VALIDATION_PENDING`**:
  se tehdään oikeassa käytössä, **ei estä junaa, eikä sitä koskaan kutsuta
  PASSiksi**. Jos oikeassa käytössä löytyy vika, se on vikailmoitus ja
  peruutuspäätös (WAVE-X.md kohta 6), ei hyväksyntäportti.
- Omistajan hyväksyntä vaaditaan **vain**:
  1. jokainen tuotantomigraatio 0009–0013 (**0010 erikseen + tilannekuva ensin**),
  2. jokainen tuotantodeploy D–J,
  3. valinnainen T-2-varmuuskopion kuivaharjoitus tuotannossa
     (`docs/activation/0010-BACKUP-AND-RECOVERY.md`),
  4. AI-selityksen käyttöönotto (`EXPLAIN_ENABLED`, `AI_EXPLAIN_ENABLED`),
  5. Androidin versionCode-politiikka.
- Omistaja hyväksyy lyhyellä viestillä: **"hyväksyn D"**, **"hyväksyn E"**,
  **"hyväksyn 0009/F"**, **"hyväksyn 0010/G"**, **"hyväksyn 0011/H"**,
  **"hyväksyn 0012/I"**, **"hyväksyn 0013/J"**. Migraatioaallon viesti kattaa
  migraation JA deployn; deploy tehdään vasta, kun `verify_00XX.sql` = 0
  poikkeavaa.
- **Fail closed:** puuttuva, epäselvä tai toisen commitin kirjaus = ei
  hyväksyntää. Orkestroija ei suunnittele seuraavaa migraatiota eikä deployta
  ennen kuin tuotannossa olevan aallon `AUTOMATED_TECHNICAL_ACCEPTANCE` on
  päiväkirjassa **täsmälleen tuotannon commitille** (aalto + 40-merkkinen SHA).

## Koneelliset ehdot (jokainen aalto)

| # | Ehto (`checks`-avain) | Miten todennetaan | Kirjataan |
|---|---|---|---|
| 1 | Sukulinja (`ancestry`) | tuotanto on lukon `deployTarget`in esi-isä: push on fast-forward (orkestroijan `PREFLIGHT_REPO`, `git merge-base --is-ancestor`) | päiväkirjan deploy-rivi |
| 2 | Migraatioedellytys (`migrationPrerequisite`) | inventaario (`supabase/acceptance/activation_readonly_inventory.sql`, vain luku) + `node tools/activation/score-inventory.mjs --code-wave=origin-main`: kanta tukee aaltoa | päiväkirjan rivi (inventaarion lähde) |
| 3 | Ehdokkaan oma täysi testipatteristo vihreä (`candidateTests`) | `node --test` ehdokkaan omassa työpuussa (`.claude/worktrees/rc-X-test`), sitten `npm run activation:orchestrate -- --record-candidate-tests=X --sha=<deployTarget> --tests-result=<tuloste>` — vain `fail 0`, `cancelled 0` kirjataan | päiväkirjan `candidate-tests`-rivi |
| 4 | Tietoturva (`security`) | `git grep` ehdokkaasta: ei AI-avaimia (`sk-ant-`), ei `service_role`-viittauksia selaimeen päätyvissä poluissa (`src`, `tools/rls-acceptance`) | päiväkirjan rivi |
| 5 | Julkaisun esitarkistus (`repoPreflight`) | `repoChecks` (portit, välimuisti, sarakeportit, tilannedokumentti, perustiedostot, migraatio- ja SQL-tiedostot): orkestroijan `PREFLIGHT_REPO`; käsin `npm run activation:preflight -- --wave=X --sha=<deployTarget>` → `PASS (testejä/koontia ei ajettu)` | päiväkirjan rivi |
| 6 | Migraation varmistus (`migrationVerify`) | F–J: omistaja ajaa `supabase/verify/verify_00XX.sql` (vain luku) ja liittää → `node tools/activation/score-sql-result.mjs --sql=supabase/verify/verify_00XX.sql <tulos>` = GO (0 poikkeavaa, kaikki rivit) → orkestroijalle `--verify-result=<tulos>` | päiväkirjan rivi |
| 7 | Live-tiedostot = ehdokkaan sormenjälki (`liveAssets`) | orkestroijan `VERIFY_LIVE` (vain GET); käsin `npm run production:verify-assets -- --wave=X --sha=<deployTarget>` | päiväkirjan rivi |
| 8 | Välimuisti ja porttimatriisi sarakeportteineen (`cacheAndGates`) | ehdokkaan `sw.js`/`schema.js` (git show) JA tuotanto: `vNN`, taulumatriisi ja `COLUMN_GATES` täsmälleen aallon mukaiset | päiväkirjan rivi |

**Käynnistyssavu (jokainen aalto C–J):** `AUTOMATED_TECHNICAL_ACCEPTANCE`
edellyttää lisäksi, että ehdokkaan oma koodi omilla porteillaan käynnistyy
oikeassa selaimessa: `npm run e2e:boot-smoke -- --root .claude/worktrees/rc-X
--label X --expect-sha <deployTarget>` (`tools/e2e/boot-smoke.mjs`: omistajan
kaltainen kanta, tekaistu istunto, jokainen alapalkin ja osion välilehti,
tuotanto estetty DNS- ja CDP-tasolla, ehdokkaan puu vain luku). Vain
`KÄYNNISTYSSAVU [X]: PASS` kelpaa; FAIL = ei hyväksyntää (fail closed).
Ajetaan ennen ehdon 3 kirjausta; päiväkirjassa savulla ei vielä ole omaa
`checks`-avainta.

**Kirjauspaikka:** `.claude/activation/journal.jsonl` — paikallinen,
git-ignoroitu, projektikansion sisällä. Kirjaukset ovat vain paikallisia:
mitään ei lähetetä minnekään. Rivityypit:

- `deploy` + `result: AUTOMATED_TECHNICAL_ACCEPTANCE` — orkestroijan
  `--execute-deploy` kirjaa sen VERIFY_LIVE:n jälkeen kaikkine ehtoineen.
- `technical-acceptance` — `npm run production:verify-assets -- --wave=X
  --sha=<40 merkkiä> --record-acceptance` (sama kuin `npm run
  activation:orchestrate -- --record-acceptance=X --sha=<40 merkkiä>`):
  tuotannossa olevan aallon kirjaus live-todennuksesta. Käytetään aallolle C
  (deployattu ennen työkaluja) ja palautumiseen, jos deployn VERIFY_LIVE
  aikakatkaistiin mutta tuotanto täsmää myöhemmin. Migraatioaallolle
  lisäksi `--verify-result=<verify_00XX-tulos>`.
- `candidate-tests` — ehdokkaan vihreä testiajo (ehto 3).

Aallolle **C** ehto 3 ei ole pakollinen: C deployattiin ennen
aktivointityökaluja, ja omistaja päätti, että sen tekninen hyväksyntä
perustuu live-todennukseen. Kaikki muut ehdot todennetaan myös C:lle.

---

## Aallot C–J

Jokaisen aallon taulukossa on **kaksi eri asiaa**: `AUTOMATED PASS`
(koneellinen, estää junan, kirjataan) ja `LIVE USE VALIDATION PENDING`
(käsin, oikeassa käytössä, **ei estä eikä ole koskaan PASS**).

### Aalto C (v16) — tuotannossa `cf259d0`

Paketti: [`docs/acceptance/WAVE-C.md`](../acceptance/WAVE-C.md),
[`WAVE-C-OWNER-ACCEPTANCE.md`](../acceptance/WAVE-C-OWNER-ACCEPTANCE.md). Omistajan hyväksyntää ei tarvita (jo tuotannossa).

| Laji | Tarkistus | Komento | Kirjataan |
|---|---|---|---|
| AUTOMATED PASS | ehdot 1, 2, 4, 5, 7, 8 (ehto 3 ei pakollinen, ehto 6: ei migraatiota) | `npm run production:verify-assets -- --wave=C --sha=cf259d0ef755f7e875cc9cd9c15405eba632e408 --record-acceptance` | `technical-acceptance`-rivi |
| LIVE USE VALIDATION PENDING | rutiinin luonti, muokkaus ja kytkin säilyvät F5:n yli; "Ohita" säilyy; aallot A–B ennallaan; konsoli puhdas | `WAVE-C-OWNER-ACCEPTANCE.md` kohdat 1–3 | ei kirjausta — ei estä, ei PASS |
| LIVE USE VALIDATION PENDING | valinnainen vain luku -tarkistus: `precheck_0003_0008_auth_final.sql` 6/6, `verify_0003_0008_post_activation.sql` `failures_total = 0` | SQL-editori | ei kirjausta — ei estä, ei PASS |

### Aalto D (v17) — talous

Paketti: [`docs/acceptance/WAVE-D.md`](../acceptance/WAVE-D.md). Omistajan viesti: **"hyväksyn D"**.

| Laji | Tarkistus | Komento | Kirjataan |
|---|---|---|---|
| AUTOMATED PASS | ehto 3: D:n oma testipatteristo | `node --test` ehdokkaassa + `--record-candidate-tests=D` | `candidate-tests`-rivi |
| AUTOMATED PASS | ehdot 1, 2, 4, 5, 7, 8 (ehto 6: ei migraatiota) | `npm run activation:orchestrate -- --execute-deploy --approved-sha=<D:n deployTarget>` | `deploy`-rivi |
| LIVE USE VALIDATION PENDING | toistuva meno, lasku ja säästötavoite säilyvät; summa senttiylleen (12,34 → 1234); SET NULL: menon poisto jättää laskun; laskuja ei synny itsestään | `WAVE-D.md` kohta 4 | ei kirjausta — ei estä, ei PASS |
| LIVE USE VALIDATION PENDING | valinnainen vain luku: `verify_0003_0008_post_activation.sql`, rahasarakkeet `bigint` | `WAVE-D.md` kohta 5 | ei kirjausta — ei estä, ei PASS |

### Aalto E (v18) — AI-kirjausketju

Paketti: [`docs/acceptance/WAVE-E.md`](../acceptance/WAVE-E.md). Omistajan viesti: **"hyväksyn E"**.

| Laji | Tarkistus | Komento | Kirjataan |
|---|---|---|---|
| AUTOMATED PASS | ehto 3: E:n oma testipatteristo | `node --test` ehdokkaassa + `--record-candidate-tests=E` | `candidate-tests`-rivi |
| AUTOMATED PASS | ehdot 1, 2, 4, 5, 7, 8 (ehto 6: ei migraatiota) | `npm run activation:orchestrate -- --execute-deploy --approved-sha=<E:n deployTarget>` | `deploy`-rivi |
| LIVE USE VALIDATION PENDING | sovellus latautuu, konsolissa ei `ai_action_audit`-virheitä; A–D toimivat; taulu pysyy tyhjänä | `WAVE-E.md` kohta 4 | ei kirjausta — ei estä, ei PASS |

### Aalto F (v19) — Talous 2.0, migraatio 0009

Paketti: [`docs/acceptance/WAVE-F.md`](../acceptance/WAVE-F.md). Omistajan viesti: **"hyväksyn 0009/F"** (migraatio + deploy).

| Laji | Tarkistus | Komento | Kirjataan |
|---|---|---|---|
| AUTOMATED PASS | ennen migraatiota: tuore inventaario ja `preflight_0009.sql` 0 FAIL | omistaja ajaa (vain luku) → `score-inventory.mjs`, `score-sql-result.mjs` → orkestroijalle `--inventory`, `--preflight-result` | orkestroijan `PREFLIGHT_DB` |
| AUTOMATED PASS | ehto 3: F:n oma testipatteristo (ennen migraatiota) | `node --test` ehdokkaassa + `--record-candidate-tests=F` | `candidate-tests`-rivi |
| AUTOMATED PASS | ehto 6: `verify_0009.sql` = 0 poikkeavaa | `score-sql-result.mjs --sql=supabase/verify/verify_0009.sql` → `--verify-result` | `deploy`-rivi |
| AUTOMATED PASS | ehdot 1, 2, 4, 5, 7, 8 | `npm run activation:orchestrate -- --execute-deploy --approved-sha=<F:n deployTarget> --verify-result=<tulos>` | `deploy`-rivi |
| LIVE USE VALIDATION PENDING | tapahtumat säilyvät; maksettu lasku = yksi tapahtuma; kuitti ehdotuksena, kuva ei Supabaseen; skannattu lasku avoin; sijoitus ilman arvoa tuntematon | `WAVE-F.md` kohta 4 | ei kirjausta — ei estä, ei PASS |

### Aalto G (v20) — Tavoitteesta tekemiseksi, migraatio 0010 (KORKEA riski)

Paketti: [`docs/acceptance/WAVE-G.md`](../acceptance/WAVE-G.md). Omistajan viesti: **"hyväksyn 0010/G"** — **erikseen**, tilannekuva ensin.

| Laji | Tarkistus | Komento | Kirjataan |
|---|---|---|---|
| AUTOMATED PASS | ennen migraatiota: **tilannekuva** `supabase/backup/snapshot_state_0009.sql` → vienti → `check` kunnossa (ei RLS-suodatusta, tiivisteet ja viite-eheys) | omistaja ajaa SQL:n ja vie tuloksen; Claude: `node tools/activation/restore-snapshot.mjs check <vienti> --save` | `.local-backups/db/<UTC>_state_0009/` (git-ignoroitu) |
| AUTOMATED PASS | tuore inventaario ja `preflight_0010.sql` 0 FAIL (rivi 09: `goals_status_check` olemassa) | kuten F | orkestroijan `PREFLIGHT_DB` |
| AUTOMATED PASS | ehto 3: G:n oma testipatteristo | `node --test` ehdokkaassa + `--record-candidate-tests=G` | `candidate-tests`-rivi |
| AUTOMATED PASS | ehto 6: `verify_0010.sql` = 0 poikkeavaa (rivit 20–22: tilarajoite) | `score-sql-result.mjs --sql=supabase/verify/verify_0010.sql` | `deploy`-rivi |
| AUTOMATED PASS | ehdot 1, 2, 4, 5, 7, 8 | `npm run activation:orchestrate -- --execute-deploy --approved-sha=<G:n deployTarget> --verify-result=<tulos>` | `deploy`-rivi |
| LIVE USE VALIDATION PENDING | tavoitteen, projektin ja tehtävän tallennus; välitavoitteet; mittaritavoite; Ylläpidossa-tila; suunnitelmaehdotus ei tallennu ennen hyväksyntää | `WAVE-G.md` kohta 4 | ei kirjausta — ei estä, ei PASS |

Varmuuskopio, palautus ja päätöspuu: [`0010-BACKUP-AND-RECOVERY.md`](0010-BACKUP-AND-RECOVERY.md).
Valinnainen T-2-kuivaharjoitus tuotannossa on oma omistajan hyväksyntänsä.

### Aalto H (v21) — Henkilökohtainen avustaja, migraatio 0011

Paketti: [`docs/acceptance/WAVE-H.md`](../acceptance/WAVE-H.md). Omistajan viesti: **"hyväksyn 0011/H"**. Ehdokas leikataan uudelleen (lukon `missingPatches`): orkestroija pysähtyy `TRAIN_RECUT_REQUIRED` siihen asti.

| Laji | Tarkistus | Komento | Kirjataan |
|---|---|---|---|
| AUTOMATED PASS | tuore inventaario ja `preflight_0011.sql` 0 FAIL | kuten F | orkestroijan `PREFLIGHT_DB` |
| AUTOMATED PASS | ehto 3: uudelleenleikatun H:n oma testipatteristo | `node --test` ehdokkaassa + `--record-candidate-tests=H` | `candidate-tests`-rivi |
| AUTOMATED PASS | ehto 6: `verify_0011.sql` = 0 poikkeavaa | `score-sql-result.mjs --sql=supabase/verify/verify_0011.sql` | `deploy`-rivi |
| AUTOMATED PASS | ehdot 1, 2, 4, 5, 7, 8 | `npm run activation:orchestrate -- --execute-deploy --approved-sha=<H:n deployTarget> --verify-result=<tulos>` | `deploy`-rivi |
| LIVE USE VALIDATION PENDING | kirjaus Saapuviin ehdotuksena; muistutukset (torkku ei muuta määräaikaa); ilmoituskeskus; matka ilman kestoa; paikkasääntö oletuksena pois; ensimmäinen oikea AI-kirjausrivi | `WAVE-H.md` kohta 4 | ei kirjausta — ei estä, ei PASS |

### Aalto I (v22) — Suunta 1, migraatio 0012

Paketti: [`docs/acceptance/WAVE-I.md`](../acceptance/WAVE-I.md). Omistajan viesti: **"hyväksyn 0012/I"**. Leikataan uudelleen kuten H.

| Laji | Tarkistus | Komento | Kirjataan |
|---|---|---|---|
| AUTOMATED PASS | tuore inventaario ja `preflight_0012.sql` 0 FAIL | kuten F | orkestroijan `PREFLIGHT_DB` |
| AUTOMATED PASS | ehto 3: uudelleenleikatun I:n oma testipatteristo | `node --test` ehdokkaassa + `--record-candidate-tests=I` | `candidate-tests`-rivi |
| AUTOMATED PASS | ehto 6: `verify_0012.sql` = 0 poikkeavaa | `score-sql-result.mjs --sql=supabase/verify/verify_0012.sql` | `deploy`-rivi |
| AUTOMATED PASS | ehdot 1, 2, 4, 5, 7, 8 | `npm run activation:orchestrate -- --execute-deploy --approved-sha=<I:n deployTarget> --verify-result=<tulos>` | `deploy`-rivi |
| LIVE USE VALIDATION PENDING | vanha tavoite tallentuu (sarakeportti); elämänalue, kapasiteetti, Kuormitus-havainto; aikakirjaus säilyy alueen poistossa; viikkokatsaus | `WAVE-I.md` kohta 4 | ei kirjausta — ei estä, ei PASS |

### Aalto J (v23) — Suunta 2, migraatio 0013

Paketti: [`docs/acceptance/WAVE-J.md`](../acceptance/WAVE-J.md). Omistajan viesti: **"hyväksyn 0013/J"**. Leikataan uudelleen kuten H.

| Laji | Tarkistus | Komento | Kirjataan |
|---|---|---|---|
| AUTOMATED PASS | edellytys: `verify_0012.sql` = 0 poikkeavaa (ajettu I:n jälkeen); tuore inventaario ja `preflight_0013.sql` 0 FAIL | kuten F | orkestroijan `PREFLIGHT_DB` |
| AUTOMATED PASS | ehto 3: uudelleenleikatun J:n oma testipatteristo | `node --test` ehdokkaassa + `--record-candidate-tests=J` | `candidate-tests`-rivi |
| AUTOMATED PASS | ehto 6: `verify_0013.sql` = 0 poikkeavaa | `score-sql-result.mjs --sql=supabase/verify/verify_0013.sql` | `deploy`-rivi |
| AUTOMATED PASS | ehdot 1, 2, 4, 5, 7, 8 | `npm run activation:orchestrate -- --execute-deploy --approved-sha=<J:n deployTarget> --verify-result=<tulos>` | `deploy`-rivi |
| AUTOMATED PASS | tietoturva: AI-selitys suljettu (`GET /api/explain` 405, `POST` ilman tokenia 503, `OPTIONS` 204) | `WAVE-J.md` kohta 3 (curl, ei tunnuksia, ei maksullista kutsua; orkestroija ei kutsu `/api/`-polkuja) | J:n hyväksyntäraportti omistajalle |
| LIVE USE VALIDATION PENDING | ajastin jatkuu F5:n yli, yksi ajastin, ei kaksoiskirjausta; kuormittavuus; ei "Selitä tekoälyllä" -painiketta | `WAVE-J.md` kohta 4 | ei kirjausta — ei estä, ei PASS |
| LIVE USE VALIDATION PENDING | Day 1 puhelimella: APK asennetaan **vasta kun `verify_0013` = 0 ja J on tuotannossa** | `docs/activation/ANDROID-ACCEPTANCE-BUILD.md`, `docs/SUUNTA-DAY1-ACCEPTANCE.md` | ei kirjausta — ei estä, ei PASS |

---

## Mitä tämä EI muuta

- Peruutus on yhä omistajan päätös: orkestroija tulostaa peruutuspaketin
  VERIFY_LIVE-epäonnistumisessa (`git switch --detach <deployTarget>`,
  `git revert --no-commit <aaltocommit>`, `CACHE_VERSION`-nosto, commit,
  `git ls-remote`-tarkistus, push `<revert-sha>:refs/heads/main` ilman
  forcea), ja peruutus pysäyttää junan tilaan `TRAIN_HALTED_RECUT_REQUIRED`.
- Tuotannon kantaan ei kirjoiteta mitään työkaluista: jokainen SQL on
  omistajan ajama, ja Claude pisteyttää vain liitetyn tuloksen.
- Käsin tehtävät tarkistukset ovat yhä arvokkaita: ne tehdään oikeassa
  käytössä ja löydetyt viat hoidetaan omina korjauksinaan.
