# Aalto D — talous

**Portit:** `recurringExpenses`, `savingsGoals`, `bills`
**Taulut:** `recurring_expenses`, `savings_goals`, `bills`
**Välimuistiversio:** `v17`
**Edellinen tuotanto:** aallon C commit (v16)
**Peruutuskohde:** aalto C

**Push-kohde (deployTarget):** junan lukon `docs/activation/release-train-c-j.json`
aallon D `deployTarget` — täysi 40-merkkinen SHA, sama kuin kohdan
"Deploy" push-rivillä. Manifestin (`docs/activation-0003-0008-release-manifest.json`)
`commitSha` on aallon AALTOCOMMIT: peruutuksen ja diffin viite, EI push-kohde.
Push tehdään orkestroijalla (`npm run activation:orchestrate -- --execute-deploy
--approved-sha=<deployTarget>`), joka tarkistaa ensin, että `origin`in main on
yhä odotettu edellinen SHA.

**Hyväksyntä (omistajan päätös 2026-09-26):** junan portti on koneellinen
`AUTOMATED_TECHNICAL_ACCEPTANCE` — ehdot, komennot ja kirjauspaikka:
[`docs/activation/AUTOMATED-ACCEPTANCE-POLICY.md`](../activation/AUTOMATED-ACCEPTANCE-POLICY.md). Kohdan 4 selainhyväksyntä on
`LIVE_USE_VALIDATION_PENDING`: se tehdään oikeassa käytössä, **ei estä junaa
eikä ole koskaan PASS**. Omistajan viesti **"hyväksyn D"** avaa deployn.

---

## Miksi kaikki kolme samassa aallossa

```
bills.recurring_expense_id -> recurring_expenses (user_id, id)
bills.task_id              -> tasks (user_id, id)
```

Lasku viittaa toistuvaan kuluun, joten kulut on avattava viimeistään
samassa aallossa. `savings_goals` ei viittaa mihinkään, mutta se kuuluu
samaan käyttöliittymäkokonaisuuteen eikä sen erottaminen omaksi
aalloksi toisi todennusetua.

---

## RAHA ON KOKONAISLUKUINA SENTTEINÄ

Tämä on aallon D ainoa oikeasti vaarallinen kohta.

| Sarake | Tyyppi |
|---|---|
| `recurring_expenses.amount_minor` | `bigint` |
| `bills.amount_minor` | `bigint` |
| `savings_goals.target_minor` | `bigint` |
| `savings_goals.current_minor` | `bigint` |

`numeric` olisi kannassa tarkka, mutta se palautuu JavaScriptiin
merkkijonona tai liukulukuna ajurin mukaan — ja **juuri se muunnos on se
kohta, jossa sentit katoavat**. Siksi tallennusmuoto on kokonaisluku.

Käyttöliittymä saa näyttää euroja desimaaleina. **Tallennussopimus ei
saa muuttua.** Jos näet kannassa desimaaliluvun, peruuta.

---

## 1. Ennen deployta

```
git rev-parse origin/main          # oltava aallon C SHA
npm run activation:verify-wave -- D
npm run activation:preflight -- --wave=D
npm test && npm run check && npm run smoke && npm run build:web
```

- [ ] Auki: aallot A + B + C + kolme talousporttia (yhdeksän)
- [ ] Kiinni: `aiAudit`
- [ ] `CACHE_VERSION` on `v17`

### Diffin tarkistus

```
git diff <WAVE-C-SHA>..<WAVE-D-SHA> --stat
```

Vain `src/data/schema.js`, `sw.js`, `docs/PRODUCTION-STATUS.md`.

---

## 2. Deploy

Omistajan viesti **"hyväksyn D"** avaa tämän askeleen. Ensisijainen (ja ainoa suositeltu)
deploy-askel on orkestroija: se tarkistaa lukon, tuotannon aallon teknisen
hyväksynnän, ehdokkaan kirjatun testiajon ja käynnistyssavun sekä julkaisun esitarkistuksen,
tekee compare-and-swapin, pushaa ja todentaa tuotannon:

```
npm run activation:orchestrate -- --execute-deploy --approved-sha=091e73c0091e8f135641e3501742b998dbac8461
```

Viitteeksi (älä aja käsin): orkestroija ajaa compare-and-swapin jälkeen
täsmälleen tämän — ei koskaan forcea:

```
git push origin 091e73c0091e8f135641e3501742b998dbac8461:refs/heads/main
```

---

## 3. Deployn jälkeen — koneellinen

```
npm run production:verify-assets -- --wave=D
```

- [ ] HTTP 200, `CACHE_VERSION` `v17`, yhdeksän porttia auki, `aiAudit` kiinni

---

## 4. Selainhyväksyntä

> **`LIVE_USE_VALIDATION_PENDING`** (omistajan päätös 2026-09-26): tämä osio
> tehdään oikeassa käytössä. Se **ei estä junaa** eikä sitä merkitä koskaan
> PASSiksi; junan portti on `AUTOMATED_TECHNICAL_ACCEPTANCE` ([`docs/activation/AUTOMATED-ACCEPTANCE-POLICY.md`](../activation/AUTOMATED-ACCEPTANCE-POLICY.md)).

Polku: **Talous** (alapalkin välilehti) → kolme segmenttiä.

- [ ] **Talous** löytyy alapalkista ilman ohjeita
- [ ] Yleiskuva näkyy ylhäällä ja kertoo avoimet laskut, myöhässä olevat,
      toistuvien menojen kuukausisumman ja säästötavoitteiden määrän
- [ ] Tyhjä talous näyttää järkevän tyhjän tilan

### Toistuvat menot

- [ ] Luonti säilyy sivun latauksen yli
- [ ] Summa tallentuu **senttiylleen** — syötä `12,34` ja tarkista että
      kannassa on `1234`
- [ ] **Pilkku ja piste** toimivat molemmat: `950,00` ja `950.00`
- [ ] Kolmen desimaalin syöte (`12,345`) **hylätään näkyvästi**, ei
      pyöristy hiljaa
- [ ] Valuutta valitaan valikosta ja tallentuu
- [ ] Jakso (kuukausittain / muu) tallentuu
- [ ] Seuraava eräpäivä tallentuu
- [ ] Kuukauden päivä tallentuu ja tyhjä pysyy tyhjänä
- [ ] **Käytöstä poisto** ja takaisin kytkeminen säilyvät
- [ ] Poisto kysyy vahvistuksen ja poistaa

### Säästötavoitteet

- [ ] Luonti säilyy
- [ ] Tavoitesumma ja kertynyt summa tallentuvat sentteinä
- [ ] Edistymispalkki näkyy ja vastaa lukuja
- [ ] **Kertynyt nolla** — edistyminen 0 %, ei virhe eikä NaN
- [ ] **Kertynyt yli tavoitteen** — näkyy täytenä (100 %), ei yli
- [ ] **Tavoitesumma nolla tai tyhjä** hylätään näkyvästi
- [ ] Tavoitepäivä tallentuu, tyhjä pysyy tyhjänä

### Laskut

- [ ] Luonti säilyy
- [ ] Summa sentteinä, valuutta valikosta
- [ ] Eräpäivä tallentuu
- [ ] **Merkitse maksetuksi** ruksista → tila `paid` ja maksupäivä täyttyy
- [ ] **Peru maksumerkintä** → tila ei ole `paid` ja maksupäivä tyhjenee
- [ ] Myöhässä oleva avoin lasku näkyy erottuvasti
- [ ] Laskun liittäminen **toistuvaan menoon** toimii ja säilyy
- [ ] Liitoksen purku toimii

### SET NULL -tarkistukset — aallon D ydin

- [ ] Luo toistuva meno, luo lasku ja liitä se siihen,
      **poista toistuva meno**
      → **lasku jää olemaan**, sen menoliitos tyhjenee
- [ ] Vahvistusikkuna kertoo montako laskua säilyy

> Lasku on historiaa. Säännön poisto ei saa poistaa jo syntyneitä
> laskuja — se hävittäisi maksutietoa.

### Ei odottamatonta generointia

- [ ] Toistuvan menon luonti **ei** luo laskuja itsestään
- [ ] Sivun lataus **ei** luo laskuja
- [ ] Tarkista tarkistus **49**: rivimäärä kasvaa vain sen verran kuin loit

> Laskujen automaattinen generointi toistuvasta menosta **ei ole**
> mallissa eikä sitä ole toteutettu. Jos sellainen joskus rakennetaan,
> se on oma pakettinsa ja oma hyväksyntänsä.

### Vähimmäisdata

Luo hyväksynnässä **yksi toistuva meno, yksi lasku ja yksi
säästötavoite** normaalin käyttöliittymän kautta. Ei SQL-lisäyksiä.

Oikeaa dataa (oma vuokra, oikea lasku) ei tarvitse poistaa.
Keinotekoinen poistetaan **käyttöliittymästä**, ei SQL:llä.

### Yleinen

- [ ] Aaltojen A–C ominaisuudet toimivat yhä
- [ ] Konsolissa ei virheitä

---

## 5. Tietokannan hyväksyntä

1. `precheck_0003_0008_auth_final.sql` → **6/6 PASS**
2. `verify_0003_0008_post_activation.sql` → **failures_total = 0**

| Tarkistus | Odotus |
|---|---|
| 41 — negatiivisia rahasummia ei ole | PASS |
| 42 — valuutta on kolme isoa kirjainta | PASS |
| 43 — laskun tila ja maksupäivä ovat samaa mieltä | PASS |
| 22 — kahdeksan sarakerajattua SET NULL -viitettä | PASS |
| 32 — ristiinkiinnitykset | PASS |
| 50 — aallot rivimäärinä | INFO, muotoa `2 / 2 / 3 / 3 / 0` |

### Liukulukutarkistus käsin

Aja SQL Editorissa erikseen, jos haluat varmistua tallennusmuodosta:

```sql
select column_name, data_type
  from information_schema.columns
 where table_schema = 'public'
   and column_name in ('amount_minor', 'target_minor', 'current_minor')
 order by table_name, column_name;
```

Jokaisen on oltava `bigint`. Jos jokin on `numeric`, `real` tai
`double precision`, **peruuta**.

---

## 6. Peruutus

**Laukaisin:**

- summa tallentuu väärin (sentit katoavat tai pyöristyvät)
- kannassa on desimaaliluku rahasarakkeessa
- toistuvan kulun poisto poistaa laskuja
- tehtävän poisto poistaa laskuja
- laskuja syntyy itsestään
- `failures_total > 0`

**Toimenpide:**

```
git revert --no-edit <WAVE-D-SHA>
# revert-commitissa: nosta CACHE_VERSION v17 -> v18
git push origin HEAD:main
```

Palauttaa **aallon C** tilan.

> Jos rahasummia on tallentunut väärin, portin sulkeminen pysäyttää
> vahingon mutta **ei korjaa jo tallennettuja rivejä**. Korjaus on oma
> pakettinsa, ja se vaatii oman analyysinsä siitä mitä oikeasti
> tallentui. Älä korjaa rivejä käsin SQL:llä hyväksynnän aikana.

---

## 7. Portti seuraavaan aaltoon

- [ ] `AUTOMATED_TECHNICAL_ACCEPTANCE` kirjattu päiväkirjaan (orkestroijan
      deploy-rivi; ks. [`docs/activation/AUTOMATED-ACCEPTANCE-POLICY.md`](../activation/AUTOMATED-ACCEPTANCE-POLICY.md))
- [ ] `docs/PRODUCTION-STATUS.md` päivitetty

Käyttötodennus (`LIVE_USE_VALIDATION_PENDING`, **ei estä** aaltoa E):
selainhyväksyntä (myös molemmat SET NULL -tarkistukset), summat senttiylleen,
`failures_total = 0` ja vähintään yksi toistuva kulu, säästötavoite ja lasku
oikeassa käytössä.
