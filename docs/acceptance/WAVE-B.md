# Aalto B — tavoitteet ja projektit

**Portit:** `goals`, `projects`
**Taulut:** `goals`, `projects`
**Välimuistiversio:** `v14`
**Edellinen tuotanto:** aallon A commit (v13)
**Peruutuskohde:** aalto A

Aallon commit-SHA: ks. `docs/activation-0003-0008-release-manifest.json`.

---

## Miksi B on toisena ja miksi molemmat samassa aallossa

`goals` ja `projects` viittaavat **toisiinsa**:

```
goals.project_id      -> projects (user_id, id)
projects.goal_id      -> goals (user_id, id)
goals.parent_goal_id  -> goals (user_id, id)
```

Kumpi tahansa järjestys erikseen avattuna rikkoisi toisen suunnan, joten
ne kuuluvat samaan aaltoon. Automaattinen testi lukee riippuvuudet
migraatioista ja kaatuu, jos ne erotetaan
(`tests/release-waves.test.mjs`, "keskinäiset riippuvuudet ovat samassa
aallossa").

Ne ovat lisäksi **viittauskohteita** aalloille C (`routines.goal_id`) ja
D (tehtävien kautta), joten ne on avattava ennen niitä.

---

## 1. Ennen deployta

```
git rev-parse origin/main          # oltava aallon A SHA
npm run activation:verify-wave -- B
npm run activation:preflight -- --wave=B
npm test && npm run check && npm run smoke && npm run build:web
```

Odotus:

- [ ] `origin/main` on aallon A commit
- [ ] Auki: `notificationPreferences`, `wellbeing`, `goals`, `projects`
- [ ] Kiinni: kuusi muuta
- [ ] `CACHE_VERSION` on `v14`
- [ ] **Aallon A portit ovat yhä auki** — tämä on erillinen tarkistus, ei oletus

### Diffin tarkistus

```
git diff <WAVE-A-SHA>..<WAVE-B-SHA> --stat
```

Vain `src/data/schema.js`, `sw.js`, `docs/PRODUCTION-STATUS.md`.

---

## 2. Deploy

```
git push origin <WAVE-B-SHA>:main
```

---

## 3. Deployn jälkeen — koneellinen

```
npm run production:verify-assets -- --wave=B
```

- [ ] HTTP 200, `CACHE_VERSION` `v14`
- [ ] Neljä porttia auki, kuusi kiinni
- [ ] `TASK_EXTENDED_FIELDS = true`

---

## 4. Selainhyväksyntä

### Tavoitteet

- [ ] Tavoitteen luonti onnistuu ja **säilyy sivun latauksen yli**
- [ ] Otsikon ja kuvauksen muokkaus säilyy
- [ ] Tavoitteen tila (`active` / `paused` / `achieved` / `abandoned`) vaihtuu ja säilyy
- [ ] Etenemistila (manuaalinen / laskettu) tallentuu oikein
- [ ] Tavoitepäivä tallentuu ja tyhjä päivä pysyy tyhjänä
- [ ] Prioriteetti tallentuu
- [ ] Tavoitteen poisto poistaa sen myös latauksen jälkeen

### Projektit

- [ ] Projektin luonti säilyy latauksen yli
- [ ] Projektin liittäminen tavoitteeseen toimii
- [ ] **Liitoksen purku** toimii — projekti jää olemaan, tavoite jää olemaan
- [ ] Projektin poisto **ei poista** siihen liitettyä tavoitetta
- [ ] Tavoitteen poisto **ei poista** siihen liitettyä projektia
- [ ] Aloitus- ja päättymispäivä tallentuvat

### Liitokset tehtäviin

- [ ] Tehtävän liittäminen tavoitteeseen toimii ja säilyy
- [ ] Tehtävän liittäminen projektiin toimii ja säilyy
- [ ] **Poista tavoite, johon on liitetty tehtävä** → tehtävä jää olemaan,
      sen tavoiteliitos tyhjenee. Tehtävä **ei saa kadota**
- [ ] Sama projektille

> Tämä on aallon B tärkein yksittäinen tarkistus. Vierasavain on
> `on delete set null (goal_id)` — sarakelistalla. Ilman sarakelistaa
> PostgreSQL yrittäisi nollata myös `user_id`:n, joka on NOT NULL, ja
> tavoitteen poisto kaatuisi joka kerta. Varmistuksen tarkistus 22
> lukee tämän katalogista, mutta selaimessa se näkyy suoraan.

### Yleinen

- [ ] Aallon A ominaisuudet toimivat yhä (asetukset, hyvinvointi)
- [ ] Käyttöliittymä ei enää kerro, ettei tavoite tai projekti säily
- [ ] Konsolissa ei virheitä

---

## 5. Tietokannan hyväksyntä

1. `precheck_0003_0008_auth_final.sql` → **6/6 PASS**
2. `verify_0003_0008_post_activation.sql` → **failures_total = 0**

| Tarkistus | Odotus |
|---|---|
| 31 — omistajuus | PASS |
| 32 — ristiinkiinnitykset | PASS, **tämä on aallon B ydin** |
| 22 — kahdeksan sarakerajattua SET NULL -viitettä | PASS |
| 24 — viisi omistajan rivin avainta | PASS |
| 50 — aallot rivimäärinä | INFO, muotoa `2 / 2 / 0 / 0 / 0` |

Jos tarkistus **32** epäonnistuu, jokin rivi on kiinnitetty toisen
käyttäjän riviin tai riviin jota ei ole. **Peruuta heti.**

---

## 6. Peruutus

**Laukaisin:**

- tavoite tai projekti ei säily latauksen yli
- tavoitteen poisto poistaa tehtävän tai kaatuu
- liitos toiseen käyttäjään syntyy (tarkistus 32 FAIL)
- aallon A ominaisuus lakkaa toimimasta
- `failures_total > 0`

**Toimenpide:**

```
git revert --no-edit <WAVE-B-SHA>
# revert-commitissa: nosta CACHE_VERSION v14 -> v15
git push origin HEAD:main
```

Tämä palauttaa **aallon A** tilan, ei perustilaa. Aallon A portit
jäävät auki, koska ne on jo todennettu.

Kantaan syntyneet tavoitteet ja projektit jäävät paikoilleen.

---

## 7. Portti seuraavaan aaltoon

- [ ] Koneellinen todennus PASS
- [ ] Selainhyväksyntä läpi, myös SET NULL -tarkistukset
- [ ] `failures_total = 0`
- [ ] Vähintään yksi tavoite ja yksi siihen liitetty projekti olemassa
- [ ] Aallon A ominaisuudet toimivat yhä
- [ ] `docs/PRODUCTION-STATUS.md` päivitetty
