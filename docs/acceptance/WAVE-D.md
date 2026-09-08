# Aalto D — talous

**Portit:** `recurringExpenses`, `savingsGoals`, `bills`
**Taulut:** `recurring_expenses`, `savings_goals`, `bills`
**Välimuistiversio:** `v16`
**Edellinen tuotanto:** aallon C commit (v15)
**Peruutuskohde:** aalto C

Aallon commit-SHA: ks. `docs/activation-0003-0008-release-manifest.json`.

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
- [ ] `CACHE_VERSION` on `v16`

### Diffin tarkistus

```
git diff <WAVE-C-SHA>..<WAVE-D-SHA> --stat
```

Vain `src/data/schema.js`, `sw.js`, `docs/PRODUCTION-STATUS.md`.

---

## 2. Deploy

```
git push origin <WAVE-D-SHA>:main
```

---

## 3. Deployn jälkeen — koneellinen

```
npm run production:verify-assets -- --wave=D
```

- [ ] HTTP 200, `CACHE_VERSION` `v16`, yhdeksän porttia auki, `aiAudit` kiinni

---

## 4. Selainhyväksyntä

### Toistuvat kulut

- [ ] Luonti säilyy sivun latauksen yli
- [ ] Summa tallentuu **senttiylleen** — syötä `12,34 €` ja tarkista että
      kannassa on `1234`
- [ ] Valuutta on `EUR`
- [ ] Toistuvuus (kuukausittain / muu) tallentuu
- [ ] Seuraava eräpäivä tallentuu
- [ ] Aktiivisuuden kytkeminen pois ja takaisin säilyy
- [ ] Poisto poistaa

### Säästötavoitteet

- [ ] Luonti säilyy
- [ ] Tavoitesumma ja nykysumma tallentuvat sentteinä
- [ ] Eteneminen näkyy oikein (nykysumma / tavoitesumma)
- [ ] **Nykysumma nolla** — eteneminen on 0 %, ei virhe eikä NaN
- [ ] **Nykysumma yli tavoitteen** — sovellus käsittelee sen hallitusti
      (100 % tai yli, ei negatiivista eikä kaatumista)
- [ ] Tavoitepäivä tallentuu, tyhjä pysyy tyhjänä

### Laskut

- [ ] Luonti säilyy
- [ ] Summa sentteinä, valuutta `EUR`
- [ ] Eräpäivä tallentuu
- [ ] **Merkitse maksetuksi** → tila `paid` ja maksupäivä täyttyy
- [ ] **Peru maksumerkintä** → tila ei ole `paid` ja maksupäivä tyhjenee
- [ ] Laskun liittäminen **toistuvaan kuluun** toimii ja säilyy
- [ ] Laskun liittäminen **tehtävään** toimii ja säilyy

### SET NULL -tarkistukset — aallon D ydin

- [ ] Luo toistuva kulu, luo siitä lasku, **poista toistuva kulu**
      → **lasku jää olemaan**, sen kululiitos tyhjenee
- [ ] Luo lasku ja liitä se tehtävään, **poista tehtävä**
      → **lasku jää olemaan**, sen tehtäväliitos tyhjenee

> Lasku on historiaa. Säännön poisto ei saa poistaa jo syntyneitä
> laskuja — se hävittäisi maksutietoa.

### Ei odottamatonta generointia

- [ ] Toistuvan kulun luonti **ei** luo laskuja itsestään
- [ ] Sivun lataus **ei** luo laskuja
- [ ] Tarkista tarkistus **49**: rivimäärä kasvaa vain sen verran kuin loit

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
# revert-commitissa: nosta CACHE_VERSION v16 -> v17
git push origin HEAD:main
```

Palauttaa **aallon C** tilan.

> Jos rahasummia on tallentunut väärin, portin sulkeminen pysäyttää
> vahingon mutta **ei korjaa jo tallennettuja rivejä**. Korjaus on oma
> pakettinsa, ja se vaatii oman analyysinsä siitä mitä oikeasti
> tallentui. Älä korjaa rivejä käsin SQL:llä hyväksynnän aikana.

---

## 7. Portti seuraavaan aaltoon

- [ ] Koneellinen todennus PASS
- [ ] Selainhyväksyntä läpi, myös molemmat SET NULL -tarkistukset
- [ ] Summat tallentuvat senttiylleen
- [ ] `failures_total = 0`
- [ ] Vähintään yksi toistuva kulu, yksi säästötavoite ja yksi lasku olemassa
- [ ] `docs/PRODUCTION-STATUS.md` päivitetty
