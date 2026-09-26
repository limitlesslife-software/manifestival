# Aalto G — Tavoitteesta tekemiseksi: välitavoitteet

**Portit:** `milestones`, `GOAL_PLANNING_FIELDS`, `GOAL_MAINTENANCE_MODE`
**Taulut:** `milestones` (+ sarakkeita `goals`-, `tasks`-, `projects`- ja `profile`-tauluihin)
**Välimuistiversio:** `v20`
**Edellinen tuotanto:** aallon F commit (v19)
**Peruutuskohde:** aalto F

**Push-kohde (deployTarget):** junan lukon `docs/activation/release-train-c-j.json`
aallon G `deployTarget` — täysi 40-merkkinen SHA, sama kuin kohdan
"Deploy" push-rivillä. Manifestin (`docs/activation-0003-0008-release-manifest.json`)
`commitSha` on aallon AALTOCOMMIT: peruutuksen ja diffin viite, EI push-kohde.
Push tehdään orkestroijalla (`npm run activation:orchestrate -- --execute-deploy
--approved-sha=<deployTarget>`), joka tarkistaa ensin, että `origin`in main on
yhä odotettu edellinen SHA.

**Hyväksyntä (omistajan päätös 2026-09-26):** junan portti on koneellinen
`AUTOMATED_TECHNICAL_ACCEPTANCE` — ehdot, komennot ja kirjauspaikka:
[`docs/activation/AUTOMATED-ACCEPTANCE-POLICY.md`](../activation/AUTOMATED-ACCEPTANCE-POLICY.md). Kohdan 4 selainhyväksyntä on
`LIVE_USE_VALIDATION_PENDING`: se tehdään oikeassa käytössä, **ei estä junaa
eikä ole koskaan PASS**. Omistajan viesti **"hyväksyn 0010/G"** avaa migraation 0010 ja deployn.

---

## LUE TÄMÄ ENSIN: aalto G on ESTETTY

**Migraatiota `0010_goal_to_action.sql` ei ole ajettu tuotantoon.**

Porttien avaaminen ennen migraatiota kaataisi **kolme eri asiaa
kolmella eri virhekoodilla**:

| Portti | Virhe ilman migraatiota | Mitä kaatuisi |
|---|---|---|
| `milestones` | `42P01` taulua ei ole | välitavoitteiden tallennus |
| `GOAL_PLANNING_FIELDS` | `42703` saraketta ei ole | **jokainen tavoitteen, tehtävän ja projektin tallennus** |
| `GOAL_MAINTENANCE_MODE` | `23514` rajoiterikkomus | tavoitteen tila `maintenance` |

Keskimmäinen on se, joka tekee tästä aallosta erilaisen.

---

## ⚠ TÄMÄ MIGRAATIO ON VAARALLISEMPI KUIN AIEMMAT ⚠

Migraatiot 0003–0009 **loivat** uusia tauluja. Tyhjää taulua ei voi
rikkoa.

Migraatio 0010 **muuttaa kolmea taulua, joissa on käyttäjän oikeaa
dataa ja joiden portit ovat auki tuotannossa:**

- `goals` — aalto B ajettu (`ddfc356`)
- `projects` — aalto B ajettu (`ddfc356`)
- `tasks` — migraatiot 0001/0002 ajettu

Konkreettisesti:

1. **`goals_status_check` korvataan.** Rajoite pudotetaan ja luodaan
   uudelleen. Koko tiedosto on yksi transaktio: muut istunnot eivät näe
   välitilaa, ja **keskeytynyt tai virheeseen päättynyt ajo perutaan
   kokonaan** — rajoite jää ennalleen. Taulu voi jäädä ilman
   tilarajoitetta **vain, jos tiedostosta ajetaan VALINTA** (osa
   lauseista editorissa valittuna), eikä mikään sovelluksessa huomaisi
   sitä. Siksi tiedosto ajetaan aina kokonaan uudessa välilehdessä;
   `preflight_0010.sql` rivi 09 (rajoite olemassa ennen ajoa) ja
   `verify_0010.sql` rivi 20 (rajoite olemassa ajon jälkeen) paljastavat
   puuttuvan rajoitteen. Migraation vaihe 5 tarkistaa sen lisäksi ennen
   committia.

2. **`ALTER TABLE` ottaa ACCESS EXCLUSIVE -lukon.** Nämä ovat tauluja,
   joita jokainen sovelluksen käynnistys lukee. `lock_timeout` on
   asetettu viiteen sekuntiin.

3. **Uudet CHECK-rajoitteet validoidaan olemassa olevia rivejä
   vastaan.** Yksikin rikkova rivi peruuttaa koko migraation.

**Varmuuskopio ei ole muodollisuus. Esitarkistus ei ole
suositeltava vaan pakollinen.**

---

## Mitä esteen purkaminen vaatii

1. Panun kirjallinen hyväksyntä migraatiolle 0010
2. **Varmuuskopio**
3. Migraation esitarkistus (vain lukeva, tiedoston lopussa) — erityisesti:
   - `kelvottomia_tiloja` = **0**
   - `omistajan_avain` = **1**
4. Migraation ajo `postgres`-roolilla Supabasen SQL-editorissa
5. `supabase/verify/verify_0010.sql` → **poikkeavia_yhteensa = 0**

---

## KOLME ASIAA, JOITA TÄMÄ AALTO EI TEE

### 1. Suunnitelmaehdotuksia ei tallenneta

**Ehdotustaulua ei ole** — ei tässä migraatiossa eikä missään.

Ehdotus elää istunnon muistissa siihen asti että käyttäjä hyväksyy tai
hylkää sen. Hyväksynnästä syntyy tavallisia rivejä (tavoite,
välitavoitteet, projektit, tehtävät, rutiinit); ehdotus itse katoaa.

Tarkistuslista hyväksynnässä:

- [ ] Ehdotus katoaa sivun latauksessa
- [ ] Hylätty ehdotus ei jätä yhtään riviä

### 2. Mikään automaatiotaso ei siirrä kiinteää työtä

Käyttäjän itse asettama aika on koskematon **jokaisella tasolla, myös
neljännellä**. Automaatiotaso päättää, kuinka pitkälle *joustavaa* työtä
saa siirtää — ei sitä, mikä on joustavaa.

- [ ] Taso 1: mitään ei siirretä ilman hyväksyntää
- [ ] Taso 2: siirto vain saman päivän sisällä
- [ ] Taso 3: siirto vain saman viikon sisällä
- [ ] Kaikilla tasoilla: itse ajastettu tehtävä ei liiku

### 3. Tekoäly ei kirjoita kantaan

Suunnittelija palauttaa **ehdotuksen**. `toCommittable` palauttaa
`null` kaikesta muusta kuin hyväksytystä ehdotuksesta, ja se on ainoa
polku tallennukseen.

- [ ] Ehdotettu suunnitelma ei luo mitään ennen hyväksyntää
- [ ] Muokkaus hyväksynnän jälkeen palauttaa tilan tarkistettavaksi

---

## 1. Ennen deployta

```
git rev-parse origin/main          # oltava aallon F SHA
npm run activation:verify-wave -- G
npm run activation:preflight -- --wave=G
npm test && npm run check && npm run smoke && npm run build:web
```

- [ ] **Migraatio 0010 on ajettu ja `verify_0010.sql` antoi 0 poikkeavaa**
- [ ] **Varmuuskopio on otettu ennen migraatiota**
- [ ] Kaikki kolmetoista porttia auki
- [ ] `GOAL_PLANNING_FIELDS` on `true`
- [ ] `GOAL_MAINTENANCE_MODE` on `true`
- [ ] `TASK_EXTENDED_FIELDS` yhä `true`
- [ ] `CACHE_VERSION` on `v20`

### Diffin tarkistus

```
git diff <WAVE-F-SHA>..<WAVE-G-SHA> --stat
```

Vain `src/data/schema.js`, `sw.js`, `docs/PRODUCTION-STATUS.md`.

---

## 2. Deploy

Omistajan viesti **"hyväksyn 0010/G"** kattaa migraation 0010 ja tämän askeleen.
Deploy vasta, kun `verify_0010.sql` = 0 poikkeavaa; tulos annetaan
orkestroijalle (`--verify-result`). Ensisijainen (ja ainoa suositeltu)
deploy-askel on orkestroija: se tarkistaa lukon, tuotannon aallon teknisen
hyväksynnän, ehdokkaan kirjatun testiajon ja käynnistyssavun sekä julkaisun esitarkistuksen,
tekee compare-and-swapin, pushaa ja todentaa tuotannon:

```
npm run activation:orchestrate -- --execute-deploy --approved-sha=173afd5dc01d16e244ec07e72fb6e29918415e81 --verify-result=<verify_0010-tulos>
```

Viitteeksi (älä aja käsin): orkestroija ajaa compare-and-swapin jälkeen
täsmälleen tämän — ei koskaan forcea:

```
git push origin 173afd5dc01d16e244ec07e72fb6e29918415e81:refs/heads/main
```

---

## 3. Deployn jälkeen — koneellinen

```
npm run production:verify-assets -- --wave=G
```

- [ ] HTTP 200, `CACHE_VERSION` `v20`
- [ ] Kaikki kolmetoista porttia `true`
- [ ] `TASK_EXTENDED_FIELDS = true`

---

## 4. Selainhyväksyntä

> **`LIVE_USE_VALIDATION_PENDING`** (omistajan päätös 2026-09-26): tämä osio
> tehdään oikeassa käytössä. Se **ei estä junaa** eikä sitä merkitä koskaan
> PASSiksi; junan portti on `AUTOMATED_TECHNICAL_ACCEPTANCE` ([`docs/activation/AUTOMATED-ACCEPTANCE-POLICY.md`](../activation/AUTOMATED-ACCEPTANCE-POLICY.md)).

Jokainen kohta tarkistetaan **sivun latauksen jälkeen** — se on ainoa
tapa erottaa tallennus muistista.

### Ensin: mikään ei saa olla rikki

Tämä on aallon tärkein osa. Migraatio kosketti tauluja, jotka toimivat
jo.

- [ ] Tavoitteen luonti, muokkaus ja poisto toimivat
- [ ] Projektin luonti, muokkaus ja poisto toimivat
- [ ] Tehtävän luonti, muokkaus ja poisto toimivat
- [ ] Vanhat tavoitteet näkyvät ennallaan
- [ ] Vanhat tehtävät näkyvät ennallaan

### Välitavoitteet

- [ ] Luo välitavoite tavoitteelle → säilyy latauksen yli
- [ ] Siirrä jonossa ylös/alas → järjestys säilyy
- [ ] Merkitse saavutetuksi → saavutuspäivä tallentuu
- [ ] Poista välitavoite → **liitetyt tehtävät säilyvät**, liitos katkeaa

### Mittaritavoite

- [ ] Luo tavoite mittarilla (esim. paino 90 → 75 kg)
- [ ] Edistyminen lasketaan matkasta, ei arvosta
- [ ] Väärään suuntaan liikkuminen näkyy taantumisena
- [ ] Tavoite ilman lähtöarvoa näyttää **tuntemattoman**, ei nollaa

### Ylläpitotila

- [ ] Siirrä saavutettu tavoite tilaan **Ylläpidossa**
- [ ] Tila säilyy latauksen yli
- [ ] Ylläpitotavoitteen työtä ei suunnitella uudeksi

### Suunnittelu

- [ ] Kirjoita tavoite vapaana tekstinä → saat ehdotuksen
- [ ] Ehdotus **ei** tallennu ennen hyväksyntää
- [ ] Poista kohtia ehdotuksesta → yhteenveto päivittyy
- [ ] Hyväksy → tavoite, välitavoitteet, projektit ja tehtävät syntyvät
- [ ] Hylkää toinen ehdotus → **mitään ei tallennu**
- [ ] Paina hyväksyntää kahdesti → **vain yksi suunnitelma syntyy**

### Aiemmat aallot

- [ ] Aaltojen A–F ominaisuudet toimivat kaikki yhä

---

## 5. Tietokannan hyväksyntä

1. `precheck_0003_0008_auth_final.sql` → **6/6 PASS**
2. `verify_0003_0008_post_activation.sql` → **failures_total = 0**
3. `verify_0009.sql` → **poikkeavia_yhteensa = 0**
4. `verify_0010.sql` → **poikkeavia_yhteensa = 0**

| Tarkistus (verify_0010) | Odotus |
|---|---|
| 15 — vierasavaimet viittaavat kahdella sarakkeella | PASS |
| 16 — SET NULL rajaa nollauksen yhteen sarakkeeseen | PASS |
| 20 — `goals_status_check` on olemassa | PASS |
| 21 — se sallii arvon `maintenance` | PASS |
| 22 — se luettelee tasan kuusi arvoa | PASS |
| 31 — jokainen välitavoite kuuluu olemassa olevalle tavoitteelle | PASS |
| 36 — jokainen tavoite on kelvollisessa tilassa | PASS |
| 40 — yhdenkään tehtävän `depends_on` ei ole NULL | PASS |
| 41–46 — rivimäärät | INFO |

> Tarkistukset **20–22** ovat ne, joita ei saa ohittaa. Ne todistavat,
> että pudotettu ja uudelleen luotu tilarajoite on paikallaan. Rajoite,
> joka sallii kaiken, on sama kuin ei rajoitetta — eikä sovelluksessa
> ole mitään, mikä huomaisi sen.

---

## 6. Peruutus

**Laukaisin:**

- tavoitteen, projektin tai tehtävän tallennus epäonnistuu
- vanhat tavoitteet eivät näy tai näkyvät väärin
- välitavoitteen poisto poistaa tehtäviä
- ehdotus tallentuu ilman hyväksyntää
- automaatio siirtää itse ajastettua työtä
- `failures_total > 0` tai `poikkeavia_yhteensa > 0`

**Toimenpide:**

```
git revert --no-edit <WAVE-G-SHA>
# revert-commitissa: nosta CACHE_VERSION v20 -> v21
git push origin HEAD:main
```

Palauttaa **aallon F** tilan.

> **Kantaa ei peruuteta ensin.** Porttien sulkeminen riittää: sarakkeet
> jäävät paikoilleen ja sovellus lakkaa kirjoittamasta niihin — **paitsi
> tila `maintenance`**, ks. alla.
>
> Migraation peruutus on erikseen migraatiotiedoston lopussa. **Se
> epäonnistuu tarkoituksella**, jos yksikin tavoite on ehtinyt tilaan
> `maintenance` — peruutus ei saa hiljaa hylätä käyttäjän tekemää
> valintaa. Päätä ensin, mihin tilaan ne rivit siirretään.

> **Ennen revertiä: `maintenance`-tavoitteet.** Aallon F koodi ei tunne
> tilaa `maintenance`. Kun F:ssä muokataan tavoitetta, joka on tilassa
> `maintenance`, F kirjoittaa sen tilaksi `active` — hiljaa. Siksi ennen
> `git revert`iä:
>
> 1. Aja `supabase/backup/snapshot_state_0010.sql` ja tarkista tulos:
>    `node tools/activation/restore-snapshot.mjs check <vienti> --save`.
> 2. Kirjaa `verify_0010.sql`:n rivi 44 ja `maintenance`-tavoitteiden
>    tunnisteet.
> 3. Revertin jälkeen älä muokkaa niitä tavoitteita. Jos niin kävi,
>    palauta tila aallon G palattua: `restore <vienti> --tables=goals`
>    (kuivaharjoitus `--dry-run` ensin).
>
>    **Varaus:** `restore --tables=goals` palauttaa **JOKAISEN**
>    tilannekuvassa olevan tavoiterivin kaikkine sarakkeineen kuvan
>    tilaan — myös tavoitteet, joita on muokattu oikein kuvan jälkeen
>    (niiden muutokset katoavat). Kuvan jälkeen luodut tavoitteet jäävät
>    (`--prune` poistaisi ne, ja `--prune --tables=goals` kieltäytyy,
>    koska `goals`-tauluun viittaavat taulut eivät ole valittuina).
>
>    **Kapeampi vaihtoehto (suositus):** aja ensin `compare <vienti>
>    --tables=goals` → `compare.sql`:n sarake `muuttuneet_id` kertoo
>    muuttuneet tunnisteet. Jos muutos koskee vain kohdassa 2 kirjattuja
>    `maintenance`-tavoitteita, palauta **vain niiden tila** omistajan
>    hyväksynnällä, uudessa välilehdessä:
>
>    ```sql
>    update public.goals
>       set status = 'maintenance'
>     where status = 'active'
>       and id in ('<kirjattu-tunniste-1>', '<kirjattu-tunniste-2>');
>    ```
>
>    ja tarkista `select id, status from public.goals where id in (…)` →
>    `maintenance`. (`compare` näyttää nämä rivit yhä MUUTTUNEINA, koska
>    `updated_at` päivittyy; muut tavoitteet pysyvät koskemattomina.)
>
> Varmuuskopio, palautus ja päätöspuu:
> [`docs/activation/0010-BACKUP-AND-RECOVERY.md`](../activation/0010-BACKUP-AND-RECOVERY.md).

---

## 7. Aallon jälkeen

- [ ] `docs/PRODUCTION-STATUS.md` päivitetty: aalto G ja portit
- [ ] `docs/GOAL-TO-ACTION.md` päivitetty: tila ESTETTY → tuotannossa
- [ ] Automaatiotaso siirretään laitekohtaisesta `profile`-tauluun
- [ ] Peruutusta ei ole voimassa

### Jäljelle jäävät asiat

1. **Automaatiotason siirto tiliin** — sarake `profile.automation_level`
   syntyy tässä migraatiossa, mutta sovellus lukee toistaiseksi
   laitekohtaista asetusta
2. **Ulkoinen kalenteri** — sovitin on kuvattu, toteutusta ei ole
3. **Laitehyväksyntä** — `docs/DEVICE-ACCEPTANCE-BACKLOG.md`
