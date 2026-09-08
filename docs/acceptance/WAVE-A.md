# Aalto A — muistutusasetukset ja hyvinvointi

**Portit:** `notificationPreferences`, `wellbeing`
**Taulut:** `notification_preferences`, `wellbeing_entries`
**Välimuistiversio:** `v13`
**Edellinen tuotanto:** `63a96c5ab90b10a73369cd66e348f4a3774367e2` (perustila, v12)
**Peruutuskohde:** perustila `63a96c5`

Aallon commit-SHA: ks. `docs/activation-0003-0008-release-manifest.json`.

---

## Miksi A on ensimmäinen

Kumpikaan taulu **ei viittaa mihinkään**. Ne ovat siis ainoat, joiden
avaaminen ei voi tuottaa vierasavainvirhettä riippumatta siitä, mitä
muuta on auki.

`notification_preferences` on lisäksi **eri omistajuusmalli** kuin muut
yhdeksän: omistaja on pääavain itse (`id uuid primary key default
auth.uid()`), ei erillinen `user_id`-sarake. Politiikat rajaavat
`auth.uid() = id`. Se on ainoa laatuaan, ja siksi se on syytä todentaa
yksin — ennen kuin sen rinnalla on yhdeksän muuta muuttujaa.

---

## 1. Ennen deployta

```
git rev-parse origin/main          # oltava perustila 63a96c5...
npm run activation:verify-wave -- A
npm run activation:preflight -- --wave=A
npm test
npm run check
npm run smoke
npm run build:web
```

Odotus:

- [ ] `origin/main` on `63a96c5ab90b10a73369cd66e348f4a3774367e2`
- [ ] Aallon todennus PASS: `notificationPreferences` ja `wellbeing` auki, **kahdeksan muuta kiinni**
- [ ] `CACHE_VERSION` on `v13`
- [ ] Esitarkistus PASS
- [ ] Testit 0 hylättyä
- [ ] Työpuu puhdas

### Diffin tarkistus

```
git diff 63a96c5..<WAVE-A-SHA> --stat
```

Diffissä saa olla **vain**:

- `src/data/schema.js` (kaksi porttia)
- `sw.js` (välimuistiversio)
- `docs/PRODUCTION-STATUS.md` (porttitaulukko)
- `docs/activation-0003-0008-release-manifest.json` (tarvittaessa)

**Pysähdy**, jos diffissä on migraatioita, RLS:ää, oikeuksia,
riippuvuuksia tai Android-tiedostoja.

---

## 2. Deploy

```
git push origin <WAVE-A-SHA>:main
```

Fast-forward, ei `--force`. Tämä käynnistää Vercelin tuotantodeployn.

---

## 3. Deployn jälkeen — koneellinen

```
npm run production:verify-assets -- --wave=A
```

Odotus:

- [ ] HTTP 200
- [ ] `CACHE_VERSION` on `v13`
- [ ] `notificationPreferences = true`, `wellbeing = true`
- [ ] Kahdeksan muuta porttia `false`
- [ ] `TASK_EXTENDED_FIELDS = true`
- [ ] Turvaotsakkeet ennallaan

---

## 4. Selainhyväksyntä

Avaa `https://manifestival-ten.vercel.app` ja **lataa sivu kovalla
uudelleenlatauksella**, jotta uusi service worker asentuu.

### Muistutusasetukset

- [ ] Asetusnäkymä avautuu
- [ ] Näkymä **ei enää** kerro, ettei tieto säily
- [ ] Muuta yksi asetus (esim. `maxPerDay` tai päivän suunnitelman aika) ja tallenna
- [ ] **Lataa sivu uudelleen** — muutos on tallessa
- [ ] Aseta pääkytkin pois päältä ja takaisin — tila säilyy
- [ ] Selaimen ilmoituslupa on **eri asia** kuin sovelluksen asetus: luvan
      epääminen ei saa muuttaa tallennettua asetusta

> Älä laukaise oikeita käyttöjärjestelmän ilmoituksia tässä. Asetuksen
> tallentuminen on se mitä todennetaan.

### Hyvinvointi

- [ ] Hyvinvointimerkinnän luonti onnistuu
- [ ] **Jätä yksi mittari tyhjäksi** ja tallenna — sen on pysyttävä tyhjänä,
      **ei muututtava nollaksi eikä ykköseksi**
- [ ] Lataa sivu uudelleen — merkintä ja tyhjä mittari ovat ennallaan
- [ ] Muokkaa merkintää — muutos säilyy
- [ ] Luo merkintä **samalle päivälle uudelleen** — sovelluksen on
      käsiteltävä se hallitusti (päivitys tai selkeä virhe), ei hiljaista
      epäonnistumista
- [ ] Poista merkintä — se katoaa myös latauksen jälkeen

### Yleinen

- [ ] Kirjautuminen ja istunnon palautuminen toimivat
- [ ] Tehtävät näkyvät ja niiden luonti, muokkaus ja poisto toimivat
- [ ] Konsolissa ei virheitä
- [ ] Muut kahdeksan ominaisuutta kertovat yhä, ettei tieto säily

---

## 5. Tietokannan hyväksyntä

Supabasen SQL Editorissa **postgres-roolilla**, tässä järjestyksessä:

1. `supabase/acceptance/precheck_0003_0008_auth_final.sql` → **6/6 PASS**
2. `supabase/acceptance/verify_0003_0008_post_activation.sql` → **46 PASS, 4 INFO, failures_total = 0**

> Älä aja `verify_0003_0008_post_acceptance_final.sql`. Se vaatii kaikkien
> kymmenen taulun olevan tyhjiä, ja aallon A jälkeen kaksi niistä ei enää
> ole. Se tiedosto on peruutustilannetta varten.

### Mitä odottaa

| Tarkistus | Odotus |
|---|---|
| 31 — jokainen rivi kuuluu tunnetulle omistajalle | PASS |
| 30 — omistajattomia rivejä ei ole | PASS |
| 32 — ristiinkiinnityksiä ei ole | PASS |
| 39–40 — hyvinvoinnin asteikot ja unitunnit | PASS |
| 49 — porttitaulujen rivimäärä | INFO, pieni luku (luomasi rivit) |
| 50 — aallot rivimäärinä | INFO, muotoa `2 / 0 / 0 / 0 / 0` |

### Turvainvariantit — nämä eivät saa muuttua

- [ ] RLS päällä kaikissa kymmenessä (09)
- [ ] 40 politiikkaa, kaikki vain `authenticated` (10, 11)
- [ ] Omistajuus molemmilta puolilta (12)
- [ ] `anon` = 0, `PUBLIC` = 0 (13, 14, 17, 18)
- [ ] 9 yhdistelmävierasavainta, 0 yhden sarakkeen viitettä (20, 21)
- [ ] Tuntemattomia SECURITY DEFINER -funktioita ei ole (25)
- [ ] `touch_updated_at` kovennettu (28)

---

## 6. Peruutus

**Laukaisin — peruuta jos mikä tahansa näistä:**

- tallennettu asetus tai hyvinvointimerkintä ei säily latauksen yli
- tyhjä mittari muuttuu luvuksi
- tallennus näyttää onnistuvan mutta rivi ei ilmesty kantaan
- toisen käyttäjän dataa näkyy
- mikä tahansa turvainvariantti (yllä) muuttuu
- `failures_total > 0`
- konsolissa toistuva virhe, joka liittyy näihin kahteen tauluun

**Toimenpide:**

```
git revert --no-edit <WAVE-A-SHA>
# revert-commitissa: nosta CACHE_VERSION v13 -> v14
git push origin HEAD:main
```

Ks. `docs/RELEASE-TRAIN-0003-0008.md`, kohta "Peruutus ja service
worker" — **välimuistiversio on nostettava myös peruutuksessa**, ei
laskettava.

Peruutus sulkee portit. **Se ei poista kantaan syntyneitä rivejä**, eikä
pidäkään: ne ovat käyttäjän omaa dataa. Portin sulkeuduttua sovellus
lakkaa lukemasta ja kirjoittamasta niitä.

**Ei SQL:ää. Ei migraation peruutusta. Ei rivien poistoa.**

---

## 7. Portti seuraavaan aaltoon

Aalto B aloitetaan vasta kun **kaikki** seuraavista ovat totta:

- [ ] Koneellinen resurssitodennus PASS
- [ ] Selainhyväksyntä kokonaan läpi
- [ ] Precheck 6/6 ja aktivoinnin jälkeinen varmistus `failures_total = 0`
- [ ] Vähintään yksi rivi kummassakin taulussa, ja molemmat säilyivät latauksen yli
- [ ] Peruutusta ei tarvittu
- [ ] `docs/PRODUCTION-STATUS.md` päivitetty havaituilla tuloksilla
