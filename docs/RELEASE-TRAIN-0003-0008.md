# Julkaisujuna 0003–0008 — aallot A–E

**Tila:** valmisteltu paikallisesti. **Mitään ei ole deployattu.**

Tämä on junan yleisohje. Aaltokohtaiset tarkistuslistat ovat erikseen:

| Aalto | Portit | Cache | Pack |
|---|---|---|---|
| **A** | `notificationPreferences`, `wellbeing` | `v13` | [WAVE-A.md](acceptance/WAVE-A.md) |
| **B** | `goals`, `projects` | `v14` | [WAVE-B.md](acceptance/WAVE-B.md) |
| **C** | `routines`, `routineExceptions` | `v15` | [WAVE-C.md](acceptance/WAVE-C.md) |
| **D** | `recurringExpenses`, `savingsGoals`, `bills` | `v16` | [WAVE-D.md](acceptance/WAVE-D.md) |
| **E** | `aiAudit` | `v17` | [WAVE-E.md](acceptance/WAVE-E.md) |

Perustila: `63a96c5ab90b10a73369cd66e348f4a3774367e2`, `v12`, kaikki portit kiinni.

Aaltojen commit-SHA:t: `activation-0003-0008-release-manifest.json`.

---

## Juna on lineaarinen, ei yksi iso commit

```
63a96c5  perustila, v12, 0/10 porttia
   |
   +-- aalto A   v13   2/10
   |
   +-- aalto B   v14   4/10
   |
   +-- aalto C   v15   6/10
   |
   +-- aalto D   v16   9/10
   |
   +-- aalto E   v17   10/10
```

Jokainen aalto on **itsenäisesti deployattava commit**. Ei squashia, ei
merge-committeja, ei yhtä committia jossa kaikki portit ovat auki.

Syy on peruutuksessa. Jos viisi porttia avattaisiin kerralla ja jokin
menisi vikaan, et tietäisi mikä niistä aiheutti sen. Yksi aalto
kerrallaan tarkoittaa, että vika näkyy siinä ominaisuudessa jonka juuri
avasit — ja peruutus sulkee vain sen.

---

## Kolme lähdettä, jotka aaltocommitti muuttaa yhdessä

| Tiedosto | Mitä se kertoo |
|---|---|
| `src/data/schema.js` | mitä sovellus oikeasti tekee |
| `sw.js` | välimuistiversio |
| `docs/PRODUCTION-STATUS.md` | mitä väitämme tehneemme |

Yksikään ei yksin riitä. Jos tarkistus lukisi vain `schema.js`:ää ja
vertaisi sitä `schema.js`:stä johdettuun odotukseen, se olisi kehä eikä
todistaisi mitään. Kolmen lähteen on oltava yhtäpitäviä, ja väärennös
vaatisi kaikkien kolmen muuttamista johdonmukaisesti — eli täsmälleen
sen mitä kelvollinen aaltocommitti tekee.

`npm run activation:verify-wave -- <aalto>` tarkistaa kaikki kolme.

---

## Komennot

```
npm run activation:verify-wave -- A      porttimatriisi, millisekunneissa
npm run activation:preflight -- --wave=A koko esitarkistus + testit
npm run production:verify-assets -- --wave=A   deployn jälkeen, vain luku
npm run release:manifest                 manifestin todennus
npm run release:manifest -- --write      manifestin uudelleenluonti
```

Ilman `--wave`-parametria esitarkistus vaatii **perustilan**. Se on
tarkoituksellinen oletus: se on vahtikoira sille, ettei portti pääse
auki vahingossa.

---

## Välimuistiversio: miksi jokaisessa aallossa

Service worker on **network-first**. Verkon ollessa käytettävissä sisältö
tulee aina verkosta, ja välimuisti on vain offline-varasto.

Silti versio on nostettava jokaisessa aallossa. Syy on `install`-vaiheen
esilataus:

1. Aaltocommitti muuttaa `src/data/schema.js`:ää.
2. `schema.js` on `SHELL`-listassa, eli esiladattavien tiedostojen joukossa.
3. Selain huomaa uuden service workerin **vain jos `sw.js` muuttuu tavuina**.
4. Ilman versionostoa `sw.js` on identtinen, uutta workeria ei asenneta,
   eikä `SHELL` haeta uudelleen.
5. Offline-käyttäjällä olisi silloin välimuistissa `schema.js`, jossa
   portti on yhä kiinni — ja mikään ei koskaan päivittäisi sitä.

Verkossa oleva käyttäjä toipuisi itsestään, koska network-first hakee
tuoreen kopion ja kirjoittaa sen välimuistiin. Offline-käyttäjä ei.

Siksi: **versionosto kuuluu SAMAAN committiin kuin porttimuutos.**
Erillistä roikkuvaa cache-committia ei tehdä — se olisi tila, jossa
tuotannossa on uusi versio ilman uutta sisältöä tai päinvastoin.

---

## Peruutus

### Peruutuskohde on aina EDELLINEN aalto

| Epäonnistuu | Palataan | SHA |
|---|---|---|
| A | perustila | `63a96c5` |
| B | aalto A | aallon A commit |
| C | aalto B | aallon B commit |
| D | aalto C | aallon C commit |
| E | aalto D | aallon D commit |

Perustilaan palaaminen aallosta D sulkisi myös aallot A–C, jotka on jo
todennettu toimiviksi. Peruutus saa sulkea vain sen mikä epäonnistui.

### Menetelmä: revert, ei force-push

```
git revert --no-edit <AALLON-SHA>
# nosta revert-commitissa CACHE_VERSION seuraavaan lukuun
git push origin HEAD:main
```

**Miksi revert eikä `git push --force`:**

- Historia säilyy. Tuotannon `main` kertoo mitä tuotannossa oikeasti oli,
  myös peruutetun aallon.
- `main` pysyy fast-forward-kelpoisena. Force-push rikkoisi sen, ja
  jokainen seuraava deploy vaatisi taas forcen.
- Ei kilpajuoksua. Force-push voi hävittää samaan aikaan tehdyn toisen
  pushin. `--force-with-lease` lieventää sitä mutta ei poista.

Force-push taaksepäin on **viimeinen keino** ja vaatii nimenomaisen
päätöksen. Sitä ei tehdä osana normaalia peruutusta.

### Peruutus ja service worker

**Nosta välimuistiversio myös peruutuksessa. Älä laske sitä.**

Selain vertaa tarjoiltua `sw.js`:ää siihen, joka sillä on asennettuna —
tavuina, ei versionumeroina. Peruutus vanhaan numeroon *toimisi* niille
selaimille, joilla on uudempi asennettuna: tiedostot eroavat, joten
päivitys käynnistyy.

Ongelma on toisaalla. Jos revert **ei ole tavulleen käänteinen** —
esimerkiksi jos siihen tulee mukaan jokin muu `SHELL`-listan tiedosto —
niin selain, jolla on jo *tuo* vanha versionumero asennettuna, näkee
identtisen `sw.js`:n eikä päivitä mitään. Se jäisi vanhaan kuoreen
pysyvästi, offline-tilassa lopullisesti.

Uusi, ennennäkemätön versionumero poistaa koko kysymyksen: jokainen
selain asentaa uudelleen ja hakee `SHELL`-listan `cache: 'reload'`
-tilassa, ja `activate` poistaa kaikki muut välimuistit.

Versionumerot ovat siis **monotonisia myös peruutuksessa**:

```
v13 (A)  ->  peruutus  ->  v14
v14 (B)  ->  peruutus  ->  v15
```

Jos aalto B deployataan peruutuksen jälkeen uudelleen, se saa taas
seuraavan vapaan numeron. Numero ei nimeä aaltoa vaan kuorta.

### Mitä peruutus EI tee

Portin sulkeminen **ei poista kantaan syntyneitä rivejä**, eikä
pidäkään: ne ovat käyttäjän omaa dataa. Sovellus vain lakkaa lukemasta
ja kirjoittamasta niitä. Kun portti myöhemmin avataan uudelleen, rivit
ovat siellä missä olivat.

**Ei SQL:ää. Ei migraation peruutusta. Ei rivien poistoa.**

Jos rivejä oikeasti pitää poistaa, se tehdään **sovelluksen kautta**
käyttöliittymästä — ei SQL-editorissa. SQL-poisto ohittaa domainin
säännöt, jättää liitokset epämääräiseen tilaan eikä näy missään
lokissa.

---

## Diffin turvallisuus

Jokaisesta aaltocommitista:

```
git diff <edellinen-aalto-SHA>..<aalto-SHA> --stat
```

Diffissä saa olla **vain**:

- `src/data/schema.js`
- `sw.js`
- `docs/PRODUCTION-STATUS.md`

**Pysähdy**, jos diffissä on:

| Löytyy | Miksi pysäytys |
|---|---|
| `supabase/migrations/` | aalto ei saa muuttaa skeemaa |
| RLS, politiikat, oikeudet | turvamalli on todennettu, sitä ei kosketa junassa |
| `package.json`, `package-lock.json` | riippuvuuspäivitys aktivoinnin aikana sekoittaisi syyn ja seurauksen |
| `android/` | ks. Android alla |
| `api/` | palvelinpuoli ei liity portteihin |
| mikä tahansa muu `src/`-tiedosto | aalto avaa portin, ei muuta toimintaa |

---

## Julkaisutagi

Nykyinen tagi `manifestival-prod-v1` osoittaa ensimmäiseen
tuotantojulkaisuun. **Sitä ei siirretä eikä korvata.**

Ehdotus junan päätökselle: **`manifestival-prod-v2`**

Tagi luodaan vasta kun **kaikki** seuraavista ovat totta:

- [ ] Aallot A–E kaikki deployattu ja tuotannossa hyväksytty
- [ ] `verify_0003_0008_post_activation.sql` → `failures_total = 0`
- [ ] `precheck_0003_0008_auth_final.sql` → 6/6 PASS
- [ ] Yksikään peruutus ei ole voimassa
- [ ] `docs/PRODUCTION-STATUS.md` päivitetty havaituilla tuloksilla

```
git tag -a manifestival-prod-v2 <WAVE-E-SHA> -m "Portit 0003-0008 aktivoitu"
git push origin manifestival-prod-v2
```

Tagi osoittaa **aallon E committiin**, ei myöhempään dokumentaatio-
committiin: se on se tila, joka tuotannossa oikeasti oli.

---

## Android

### Nykytila

APK:n web-assetit ovat **oma kopionsa** repositoriossa:

```
android/app/src/main/assets/public/src/data/schema.js
```

Tiedosto on **seurattu gitissä**, ja siinä on tällä hetkellä kaikki
kymmenen porttia `false`. APK on siis jäädytetty perustilaan.

> Huom. `android/.gitignore` listaa `app/src/main/assets/public`, mutta
> git ohittaa vain seuraamattomia tiedostoja. Nämä on kerran lisätty,
> joten ne ovat seurattuja ja niiden muutokset **näkyvät** `git
> status`issa ja diffeissä.

### Androidia EI synkronoida junan aikana

`npx cap sync android` kopioisi uuden `schema.js`:n APK:n assetteihin ja
tuottaisi diffin `android/`-hakemistoon. Se rikkoisi aaltocommitin
diffisäännön (yllä) ja sekoittaisi kaksi eri asiaa: web-aktivoinnin ja
mobiilijulkaisun.

**Aallot A–E eivät kosketa `android/`-hakemistoa lainkaan.**

### Synkronointijärjestys aallon E jälkeen

```
1. npm run build:web            # kokoaa dist/ — bittiverrannollinen kopio
2. npx cap sync android         # kopioi dist/ APK:n assetteihin
3. git diff --stat android/     # tarkista: vain assets/public/, ei muuta
4. commit omana committinaan    # "chore(android): synkronoi web-assetit aaltoon E"
5. cd android && gradlew.bat assembleDebug
6. laitehyväksyntä
```

Vaihe 3 on olennainen: jos `cap sync` muuttaa muutakin kuin
`assets/public/`-sisältöä (esim. gradle-tiedostoja tai
Capacitor-versioita), se on eri muutos ja kuuluu omaan pakettiinsa.

**Fyysinen laite on erillinen hyväksyntäportti.** Se ei estä
web-aktivointia, koska sovellus toimii selaimessa ja portit ovat samat.
Ks. `docs/DEVICE-ACCEPTANCE-BACKLOG.md`.

---

## Hyväksyntädata: mitä tuotantoon luodaan

Hyväksyntä vaatii oikeaa dataa — muuten se ei todista säilyvyyttä.
Määrä pidetään pienimpänä mahdollisena.

| Aalto | Vähimmäisdata |
|---|---|
| A | 1 asetustallennus, 1 hyvinvointimerkintä |
| B | 1 tavoite, 1 siihen liitetty projekti |
| C | 1 rutiini, 1 poikkeus |
| D | 1 toistuva kulu, 1 säästötavoite, 1 lasku |
| E | ei mitään — kirjoituspolkua ei ole (ks. WAVE-E.md) |

### Jäävätkö ne kantaan?

**Jäävät, jos ne ovat oikeaa dataa.** Luo hyväksynnässä sellaista mitä
oikeasti käytät: oma aamurutiini, oikea lasku, todellinen tavoite.
Silloin siivousta ei tarvita eikä tuotantoon jää roskaa.

Jos luot jotain keinotekoista, **poista se sovelluksen
käyttöliittymästä** hyväksynnän jälkeen. Älä poista SQL:llä: se ohittaa
domainin säännöt ja voi jättää liitokset epämääräiseen tilaan.

Hyväksyntätestin omat rivit ovat eri asia. Ne on siivottu, ja
varmistuksen tarkistukset 01–03 vartioivat ettei niitä ole.

---

## Testien lähtötaso

| Komento | Odotus |
|---|---|
| `npm test` | 1498 läpi, 0 hylättyä |
| `npm run check` | PASS |
| `npm run smoke` | PASS (77) |
| `npm run build:web` | PASS |
| `npm run activation:preflight -- --wave=<X>` | PASS (30 tarkistusta) |

Jokainen aaltocommitti ajaa kaikki nämä ennen committia.

---

## Mitä tämä juna EI kata

- **AI-kirjausketjun kirjoituspolku.** Taulu ja repositorio ovat valmiit,
  mutta sovelluksessa ei ole kutsua joka kirjoittaisi niihin.
  Ks. `docs/acceptance/WAVE-E.md`.
- **`routine_exceptions` -jälkikovennus.**
  Ks. `docs/FOLLOWUP-routine-exceptions-uniqueness.md`. Ei estä.
- **Anthropic-avaimen kierrätys.** Oma pakettinsa.
- **Goal-to-Action-moottori.** Ks. `docs/ADR-goal-to-action-engine.md`.
- **Laitehyväksyntä.** Ks. `docs/DEVICE-ACCEPTANCE-BACKLOG.md`.
