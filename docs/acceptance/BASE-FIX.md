# Perustila — korjaukset ja kaksi uutta osiota

**Portit:** ei yhtään. **Kaikki kymmenen pysyvät kiinni.**
**Välimuistiversio:** `v13` (tuotannossa `v12`)
**Edellinen tuotanto:** `63a96c5ab90b10a73369cd66e348f4a3774367e2`
**Peruutuskohde:** `63a96c5`

Commit-SHA: ks. `docs/activation-0003-0008-release-manifest.json`, kenttä
`baseSha`.

---

## Miksi tämä deployataan ennen aaltoja

Tuotannon perushyväksyntä meni läpi — kirjautuminen, istunnon
palautuminen, tehtävät, konsoli, precheck 6/6, varmistus 40/40 — mutta
käyttäjä löysi kolme vikaa, jotka mikään koneellinen tarkistus ei
nähnyt. Kaikki kolme koskevat sitä, mitä käyttäjä NÄKEE, eivät sitä
mitä kannassa on.

Sama havainto johti laajempaan tarkastukseen, joka paljasti että
**neljälle domainille ei ollut käyttöliittymää lainkaan**: projekteille
ja talouden kolmelle. Ne rakennettiin olemassa olevan domain-mallin
päälle — ilman skeemamuutoksia.

Kaikki tämä deployataan **ennen** yhdenkään portin avaamista. Muuten
korjausten, uusien näkymien ja porttien vaikutukset sekoittuisivat,
eikä vian sattuessa tietäisi mistä oli kyse.

**Uudet näkymät toimivat jo nyt**, portit kiinni: tieto elää istunnon
muistissa ja käyttöliittymä kertoo sen. Koko käyttöliittymä voidaan
siis hyväksyä ennen kuin mitään aletaan tallentaa pysyvästi.

---

## Mitä korjattiin

### 1. Kesto 01:00–02:00 näkyi kolmenakymmenenä

Lomakkeen kestokenttä **himmennettiin** kun molemmat kellonajat oli
annettu, ja työkaluvihje lupasi että "kesto lasketaan alku- ja
loppuajasta". Laskettua arvoa ei kuitenkaan koskaan kirjoitettu
kenttään — joten himmennettyyn kenttään jäi näkyviin sen paikkamerkki,
luku **30**.

Domain laski koko ajan oikein (`durationOf` antoi 60). Vika oli
lomakkeessa ja siinä, että tallennettu `durationMinutes` sai jäädä
ristiriitaan välin kanssa: tehtävällä saattoi olla väli 01:00–02:00 ja
kesto 30 yhtä aikaa, eikä validointi pitänyt sitä virheenä.

**Korjaus:**

- `normalizeTask` johtaa keston välistä aina kun molemmat ajat ovat
  olemassa. Ristiriitaa ei voi enää syntyä eikä säilyä kannassa.
- Lomake kirjoittaa lasketun arvon kenttään ja päivittää sen
  kirjoitettaessa.
- Paikkamerkki `30` → `esim. 45`, jottei se näytä lasketulta tulokselta.
- `durationOf` palauttaa nyt `null` nollan mittaiselle välille. Aiemmin
  sama alku- ja loppuaika tuotti **1440 minuuttia** eli koko
  vuorokauden.

### 2. Hyvinvointia ei löytynyt

Osio oli olemassa ja toimi, mutta sen otsikko oli **"Miten menee?"** —
eikä sanaa *hyvinvointi* esiintynyt koko käyttöliittymässä kertaakaan.
Osio on lisäksi suljettu `<details>`, joten otsikko on ainoa asia joka
näkyy ennen avaamista.

**Korjaus:** otsikko on nyt **Hyvinvointi**. Ystävällinen kysymys
siirtyi sisälle vihjeeksi.

### 3. AI-kirjausketjulla ei ollut kirjoituspolkua

Koko lähdepuussa oli tasan yksi `aiAuditRepo`-kutsu, ja se oli `list()`.
Sovellus kirjasi AI-toiminnot **vain muistiin**. Portin avaaminen olisi
muuttanut yhden luvun muistista kannaksi eikä tuottanut yhtään riviä.

**Korjaus:** `recordProposal` ja `completeAudit` kirjoittavat nyt myös
repositorioon. Kirjaus on tulosta odottamaton ja virheet nielevä: jos
sen tallennus epäonnistuu, käyttäjän komento on silti joko onnistunut
tai epäonnistunut omilla ehdoillaan.

### 4. Projekteille ei ollut käyttöliittymää

Kanta, RLS, repositorio ja domain-logiikka olivat valmiit. Rivit
ladattiin tilaan eikä niitä renderöity missään, eikä projektia voinut
luoda.

**Rakennettu:** Tavoitteet-välilehden toinen segmentti **Projektit** —
sama kaava kuin Tekeminen-välilehdellä (Tehtävät / Rutiinit). Lista,
tyhjä tila, luonti, muokkaus, poisto vahvistuksella, liitos
tavoitteeseen ja liitoksen purku.

### 5. Taloudelle ei ollut käyttöliittymää

Sama tilanne kolmella domainilla: laskut, toistuvat menot ja
säästötavoitteet. Sanaa "Talous" ei esiintynyt käyttöliittymässä
kertaakaan.

**Rakennettu:** oma **Talous**-välilehti, jossa yleiskuva ja kolme
osiota. Rahat kulkevat sentteinä kokonaislukuina; pilkku ja piste
kelpaavat molemmat desimaalierottimeksi.

---

## 1. Ennen deployta

```
git rev-parse origin/main          # oltava 63a96c5ab90b1...
npm run activation:verify-wave -- BASE
npm run activation:preflight
npm test
npm run check
npm run smoke
npm run build:web
```

Odotus:

- [ ] `origin/main` on `63a96c5ab90b10a73369cd66e348f4a3774367e2`
- [ ] **Kaikki kymmenen porttia `false`**
- [ ] `TASK_EXTENDED_FIELDS` on `true`
- [ ] `CACHE_VERSION` on `v13`
- [ ] Esitarkistus PASS **ilman `--wave`-parametria** — tämä on perustila
- [ ] Testit 0 hylättyä

### Diffin tarkistus

```
git diff 63a96c5..<BASE-FIX-SHA> --stat
```

Diffissä **ei saa olla**:

- `supabase/migrations/` — skeemaa ei kosketa
- RLS:ää, politiikkoja, oikeuksia
- `package.json`:n `dependencies` tai `devDependencies` — ei
  riippuvuuspäivityksiä aktivoinnin yhteydessä
- `src/data/schema.js` — **tiedoston ei pidä muuttua lainkaan.**
  Portit avataan aalloissa, eivät tässä
- `android/` — APK rakennetaan erikseen

Diffissä **saa olla** (ja on):

| Polku | Miksi |
|---|---|
| `src/domain/task.js` | kesto johdetaan välistä |
| `src/app/views/tasks.js` | lomake kirjoittaa lasketun keston kenttään |
| `src/app/views/today.js` | hyvinvointilohkon otsikko |
| `src/app/aiCommands.js` | kirjausketjun kirjoituspolku |
| `index.html` | kestokentän paikkamerkki |
| `sw.js` | välimuistiversio `v13` |
| `package.json` | **vain uusia npm-skriptejä**, ei riippuvuuksia |
| `supabase/acceptance/verify_0003_0008_post_activation.sql` | uusi **vain lukeva** varmistus. Ei migraatio, ei aja itsestään |
| `src/app/views/projects.js` | uusi projektinäkymä |
| `src/app/views/finance.js` | uusi talousnäkymä |
| `src/app/state.js`, `src/app/actions.js` | projektien ja talouden toiminnot |
| `src/app/navigation.js` | uusi Talous-näkymä navigaatioon |
| `src/styles.css` | kuuden välilehden ja kolmen segmentin mitoitus |
| `tests/`, `tools/release/`, `docs/` | testit, julkaisutyökalut, ohjeet |

Tarkista riippuvuudet erikseen — tämän on oltava tyhjä:

```
git diff 63a96c5..<BASE-FIX-SHA> -- package.json | grep -E '"(@|[a-z-]+)": "\^'
```

---

## 2. Deploy

```
git push origin <BASE-FIX-SHA>:main
```

Fast-forward, ei `--force`.

---

## 3. Deployn jälkeen — koneellinen

```
npm run production:verify-assets -- --wave=BASE
```

- [ ] HTTP 200
- [ ] `CACHE_VERSION` on **`v13`**
- [ ] **Kaikki kymmenen porttia `false`**
- [ ] `TASK_EXTENDED_FIELDS = true`
- [ ] Turvaotsakkeet ennallaan

---

## 4. Selainhyväksyntä

Avaa `https://manifestival-ten.vercel.app` ja **lataa sivu kovalla
uudelleenlatauksella** (Ctrl+Shift+R), jotta uusi service worker
asentuu. Ilman sitä näet yhä `v12`-kuoren.

### Kesto — tämä on korjauksen ydin

- [ ] Luo tehtävä: **alku `01:00`, loppu `02:00`**
- [ ] Kestokenttä näyttää **`60`** — ei 30, ei tyhjää
- [ ] Kenttä on himmennetty (arvo tulee väliltä)
- [ ] Tallenna ja **lataa sivu uudelleen**
- [ ] Avaa tehtävä uudelleen — kesto on yhä **`60`**
- [ ] Muuta loppuaika `01:30` → kesto muuttuu **`30`** heti
- [ ] Muuta loppuaika takaisin `02:00` → kesto **`60`**
- [ ] **Poista loppuaika** → kenttä muuttuu muokattavaksi, arvo jää `60`
- [ ] Kirjoita kestoksi `45` ilman loppuaikaa → tallentuu ja säilyy
- [ ] Luo tehtävä `23:30 → 00:30` → kesto **`60`** (yön yli)

### Hyvinvointi — löytyykö se nyt?

- [ ] Avaa **Tänään**
- [ ] Sivulla näkyy otsikko **"Hyvinvointi"**
- [ ] Klikkaa se auki
- [ ] Energia / Mieliala / Kuormitus -asteikot näkyvät
- [ ] Merkintä tallentuu istunnon ajaksi
- [ ] Käyttöliittymä kertoo yhä, ettei tieto vielä säily latauksen yli
      (portti on kiinni — tämä on oikein)

### Projektit — löytyykö ja toimiiko?

Polku: **Tavoitteet → Projektit**.

- [ ] Tavoitteet-välilehdellä on segmentti **Projektit**
- [ ] Tyhjä tila näkyy järkevänä
- [ ] Projektin luonti onnistuu ja näkyy listassa
- [ ] Projektin muokkaus onnistuu
- [ ] Projektin voi liittää tavoitteeseen ja liitoksen purkaa
- [ ] Poisto kysyy vahvistuksen
- [ ] Nimetön projekti hylätään näkyvällä virheellä

### Talous — löytyykö ja toimiiko?

Polku: **Talous** (alapalkin välilehti).

- [ ] Alapalkissa on **Talous**
- [ ] Yleiskuva näkyy ylhäällä
- [ ] Kolme segmenttiä: **Laskut**, **Toistuvat menot**, **Säästötavoitteet**
- [ ] Laskun luonti onnistuu; summa `12,34` näkyy muodossa `12,34 €`
- [ ] **Pilkku ja piste** toimivat molemmat: kokeile `950,00` ja `950.00`
- [ ] Kolme desimaalia (`12,345`) hylätään näkyvästi
- [ ] Laskun voi merkitä maksetuksi ja perua merkinnän
- [ ] Toistuvan menon luonti onnistuu ja sen voi kytkeä pois käytöstä
- [ ] Säästötavoitteen luonti onnistuu ja edistymispalkki näkyy
- [ ] Nollatavoite hylätään näkyvästi
- [ ] Ylitäysi säästötavoite näyttää 100 %, ei enempää

### Navigaatio — löytyykö kaikki?

Käy läpi ilman ohjeita ja merkitse löysitkö:

- [ ] **Tänään** — päivän aikajana
- [ ] **Viikko**
- [ ] **Tekeminen** → *Tehtävät* ja *Rutiinit*
- [ ] **Tavoitteet** → *Tavoitteet* ja *Projektit*
- [ ] **Talous** → *Laskut*, *Toistuvat menot*, *Säästötavoitteet*
- [ ] **Profiili** → *Muistutukset*
- [ ] **Tänään** → *Hyvinvointi*
- [ ] **Tänään** → rutiinin kohdalla *Ohita* (rutiinipoikkeus)

Alapalkissa on nyt **kuusi** välilehteä. Tarkista että ne mahtuvat
puhelimen leveydellä eivätkä mene päällekkäin.

AI-kirjausten selainta **ei ole** eikä sitä pidä etsiä: kirjausketju on
tausta-aineisto. Ks. `docs/UI-REACHABILITY.md`.

### MITÄ EI SAA ODOTTAA — portit ovat kiinni

Projektit, talous, tavoitteet, rutiinit, hyvinvointi ja muistutukset
elävät tässä vaiheessa **istunnon muistissa**. Ne toimivat täysin, ja
käyttöliittymä kertoo ettei tieto vielä säily.

- [ ] Luo projekti → **päivitä sivu** → projekti on **poissa**
- [ ] Sama laskulle
- [ ] Sovellus **kertoo** tämän, ei teeskentele tallentavansa

**Se on oikea tulos, ei vika.** Portit avataan aalloissa A–E, ja vasta
silloin tieto alkaa säilyä. Tehtävät ja profiili säilyvät jo nyt.

### Yleinen

- [ ] Kirjautuminen ja istunnon palautuminen toimivat
- [ ] Tehtävät näkyvät — **36 kappaletta** (plus itse luomasi)
- [ ] Tehtävän luonti, muokkaus ja poisto toimivat
- [ ] Konsolissa ei virheitä
- [ ] Sivu toimii myös kapealla puhelimen leveydellä: ei vaakavieritystä

---

## 5. Tietokannan hyväksyntä

Portit ovat kiinni, joten kannan on oltava **täsmälleen ennallaan**.

1. `supabase/acceptance/precheck_0003_0008_auth_final.sql` → **6/6 PASS**
2. `supabase/acceptance/verify_0003_0008_post_acceptance_final.sql`
   → **40/40 PASS, failures_total = 0**

> Tässä ajetaan **post-acceptance**, ei post-activation. Portit ovat yhä
> kiinni, joten kaikkien kymmenen taulun kuuluu olla tyhjiä — ja juuri
> sen post-acceptance vaatii.

- [ ] **Kaikki kymmenen porttitaulua yhä tyhjiä** (tarkistus 05)
- [ ] `tasks` = 36 ja tiiviste ennallaan, **ellet luonut tehtäviä yllä**
- [ ] `profile` = 1

> Jos loit kestotestissä tehtäviä, tarkistukset 01 ja 27 eroavat
> lähtöarvosta. Se on odotettua. Kirjaa uusi lukumäärä ylös.

---

## 6. Peruutus

**Laukaisin:**

- kesto näyttää yhä väärin
- tehtävän tallennus tai lataus rikkoutuu
- hyvinvointiosio katoaa kokonaan
- konsolissa uusi toistuva virhe
- jokin kymmenestä taulusta ei ole enää tyhjä
- `failures_total > 0`

**Toimenpide:**

```
git revert --no-edit <BASE-FIX-SHA>
# revert-commitissa: nosta CACHE_VERSION v13 -> v14
git push origin HEAD:main
```

Välimuistiversio **nostetaan** myös peruutuksessa, ei lasketa. Ks.
`docs/RELEASE-TRAIN-0003-0008.md`, kohta "Peruutus ja service worker".

Kantaan ei kosketa. Tämä korjaus ei kirjoita kantaan mitään.

---

## 7. Portti aaltoon A

Aalto A aloitetaan vasta kun **kaikki** seuraavista ovat totta:

- [ ] Koneellinen resurssitodennus PASS, `v13`, 0/10 porttia auki
- [ ] Kesto 01:00–02:00 näyttää 60 ja säilyy latauksen yli
- [ ] Hyvinvointi löytyy nimellä
- [ ] Projektit löytyy ja toimii muistissa
- [ ] Talous löytyy ja toimii muistissa
- [ ] Precheck 6/6
- [ ] Post-acceptance 40/40, kymmenen taulua yhä tyhjiä
- [ ] Peruutusta ei tarvittu
- [ ] `docs/PRODUCTION-STATUS.md` päivitetty havaituilla tuloksilla
