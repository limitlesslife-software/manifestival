# WP13–WP20 — Ultra Product Completion Wave

Haara: `feature/wp-13-20-ultra-product`
Lähtö-HEAD: `fb94ee73d1dfd86b5df5d420d6cfdc12f6c440d3`
Baseline: 780/780 testiä, `check` PASS, `smoke` PASS (74).

---

## Yhden lauseen tavoite

**Vie Manifestival niin pitkälle kohti oikeaa tuotetta kuin on turvallista ilman
production-tietokantaa.**

Edellinen aalto rakensi ketjun tavoitteesta muistutukseen. Tämä aalto tekee
siitä käytettävän: AI-komennoista tulee oikea toiminto, projekteista ja
tavoitteista oikeita näkymiä, taloudesta perustason työkalu, ja tiedosta
käyttäjän omaisuutta (vienti, poisto).

---

## Absoluuttinen production-portti

Supabase-inventointi on **tarkoituksella lykätty** siihen asti kun
organisaation Pro/Free-rakenne on päätetty. Se ei saa pysäyttää tätä aaltoa.

| Kerros | Saa valmistua tässä aallossa |
|---|---|
| domain | **Kyllä** |
| application | **Kyllä** |
| UI | **Kyllä** |
| repository *interface* | **Kyllä** |
| in-memory adapter | **Kyllä** |
| testit | **Kyllä** |
| migration draft | **Kyllä** — ei ajeta |
| schema gate -vakio | **Kyllä** — arvo `false` |
| **Supabase-adapteri uusille tauluille** | **EI** ennen inventointia |

**Sääntö, joka ei jousta:** mitään uutta persistenssiä ei merkitä valmiiksi
ennen kuin migraatio on oikeasti ajettu. Käyttöliittymä kertoo käyttäjälle
rehellisesti, mikä ei säily.

---

## Scope työpaketeittain

### WP13 — AI Command System V2

Nykyinen `src/ai/intentSchema.js` kattaa 7 intenttiä ja on turvallinen, mutta
vain `create_task` on kytketty käyttöliittymään. Laajennus:

- ~22 intenttiä: task, routine, goal, project, bill, scheduling, notifications, read-only
- **Entity resolution** omana kerroksenaan: `EXACT` / `AMBIGUOUS` / `NOT_FOUND`
- Riskiluokat `LOW` / `MEDIUM` / `HIGH`, HIGH aina eksplisiittinen vahvistus
- Ihmisluettava esikatselu: mitä, mihin, nykyinen arvo → uusi arvo
- Vahvistusdialogi sovelluksen omalla dialogijärjestelmällä, ei `window.confirm`
- Paikallinen audit-loki

**Ehdoton sääntö:** AI ei suorita mitään. `DELETE` ei koskaan epäselvällä
kohteella. Puhe käyttää samaa putkea ja samoja vahvistussääntöjä.

### WP14 — Projects V2

Nykyinen domain on ohut. Laajennus: `PLANNED`-tila, prioriteetti, `startDate`,
`deadline`, arkistointi, riskiarvio (`ON_TRACK` / `AT_RISK` / `OVERDUE`)
deterministisenä funktiona. Oma näkymä ja tehtävien liittäminen.

**Poistopolitiikka:** projektin poisto **ei** poista tehtäviä. `projectId`
nollataan. Sama periaate kuin tavoitteilla.

### WP15 — Goals V2

Neljä edistymistapaa: `MANUAL`, `TASK_BASED`, `PROJECT_BASED`, `ROUTINE_BASED`.
Tilat `ACTIVE` / `PAUSED` / `ACHIEVED` / `ABANDONED`. Edistyminen aina
kokonaisluku 0–100.

### WP16 — Data ownership: export, import, account deletion

- `buildUserDataExport()` — puhdas kokoaja, versioitu (`manifestivalExportVersion`)
- **Ei koskaan** avaimia, tokeneita, istuntoa
- Import: `PARSE → VALIDATE → PREVIEW`. Ei kirjoitusta tässä aallossa
- Tilin poisto: UI + sopimus, mutta **ei fake-successia** — backend puuttuu

### WP17 — Finance Level 1

**Ei pankkiyhteyttä, ei maksuja, ei Open Bankingia.**

Kriittisin ratkaisu: **raha kokonaislukuina (minor units)**. 129,95 € = `12995`.
Valuutta aina eksplisiittinen. Eri valuuttoja ei koskaan summata yhteen.

`Bill`, `RecurringExpense`, `SavingsGoal`, talousmuistutukset. Toistuvat kulut
laajennetaan kuten rutiinit — ei rajatonta materialisointia.

### WP18 — Daily Experience V3

Päivänäkymästä päätyötila: aamusuunnitelma, illan katsaus V2, viikkokatsaus V2.
Selkeä informaatiohierarkia, ei sekava dashboard.

### WP19 — Search & Command Palette

Yhtenäinen paikallinen haku (tasks, routines, goals, projects, bills).
Komentopaletti `Ctrl/Cmd+K`. Ei regex-injektiota, ei XSS:ää.

### WP20 — State & security hardening

Auth-elinkaaren invariantit, XSS-audit, localStorage-audit,
repository-sopimukset, virhemalli, havainnointi, aika/DST-kovennus.

---

## Arkkitehtuuri

Kerrosjako ei muutu. Uusi `application`-käsite toteutetaan **`src/app/`:n
sisällä** (esim. `src/app/aiCommands.js`), koska olemassa oleva
arkkitehtuuritesti tuntee kerrokset `app / ui / ai / data / platform / domain /
lib`. Uuden ylimmän tason hakemiston lisääminen vaatisi testin muuttamista
ilman todellista hyötyä.

```
domain/     puhdas logiikka          ei DOM, ei verkko, ei kello, ei satunnaisuus
ai/         intent-skeema, resolver  ei suorita mitään
app/        orkestrointi             ainoa paikka jossa kerrokset kohtaavat
data/       repositoriot             yksi rajapinta, kaksi toteutusta
platform/   alustaerot               capability-rekisteri
ui/         dom, toast, confirm      ei tunne domainia
lib/        apurit                   ei riippuvuuksia
```

---

## Invariantit

Nämä lukitaan testeillä. Ne eivät ole tyylikysymyksiä.

1. **AI ei koskaan suorita.** `resolveCommand` palauttaa arvon.
2. **Epäselvä kohde ei koskaan muuta mitään.** `AMBIGUOUS` → käyttäjä valitsee.
3. **HIGH-riski vaatii aina vahvistuksen.** Ei ohitettavissa asetuksella.
4. **Vain nimenomaisesti annetut kentät muuttuvat.** Puuttuva kenttä ei saa
   ylikirjoittua oletusarvolla.
5. **Raha on kokonaisluku.** Ei liukulukuja senttien totuutena.
6. **Eri valuuttoja ei summata.**
7. **Johdettu tieto ei ole tallennettua.** Myöhästyminen, edistyminen,
   riskitila lasketaan aina uudelleen.
8. **Poisto ei kaskadoi.** Projektin tai tavoitteen poisto ei poista tehtäviä.
9. **Uloskirjautuminen tyhjentää kaiken käyttäjäkohtaisen paikallisen tilan.**
10. **Lupaa ei pyydetä käynnistyksessä.**
11. **Vienti ei koskaan sisällä salaisuuksia.**
12. **Toistuvuus ei materialisoidu rajattomasti.**

---

## Turvarajat

| Raja | Toteutus |
|---|---|
| AI-komennot | Allowlist + skeema + primitiivitarkistus + riskiluokka + vahvistus |
| Kohteen tunnistus | `EXACT` vaaditaan mutaatioon; `AMBIGUOUS` pysäyttää |
| XSS | Kaikki käyttäjädata `escapeHtml`in läpi; testivartija |
| URL:t | Vain sallitut protokollat; ei `javascript:` eikä `data:` |
| Salaisuudet | Ei viennissä, ei lokissa, ei selainkoodissa |
| Loki | Redaktio oletuksena: ei tokeneita, sähköposteja, terveys- tai talousmuistiinpanoja |
| Käyttäjien erottelu | Muistivarastot tyhjennetään uloskirjautuessa |

---

## Persistenssirajat

| Tieto | Nyt | Vaatii |
|---|---|---|
| tasks, profile | **Supabase — toimii** | — |
| tehtävän laajennetut kentät | muisti | migraatio 0002 |
| routines, exceptions | muisti | migraatio 0003 |
| goals, projects | muisti | migraatio 0004 |
| notification preferences | muisti | migraatio 0005 |
| wellbeing | muisti | migraatio 0006 |
| **finance (bills, expenses, savings)** | muisti | **migraatio 0007 (uusi)** |
| **AI audit** | muisti | **migraatio 0008 (uusi)** |

---

## UI-integraatiosuunnitelma

Nykyinen visuaalinen kieli säilyy. Ei uudelleensuunnittelua.

| Näkymä | Muutos |
|---|---|
| Tänään | Aamusuunnitelma, laskut, projektien tärkeät — hierarkia selkeäksi |
| Viikko | Projektien riski, ensi viikon laskut |
| Tekeminen | Kolmas osio: projektit |
| Tavoitteet | Neljä edistymistapaa, linkitetyt projektit |
| **Talous** (uusi) | Laskut, toistuvat, säästötavoitteet |
| Profiili | Asetukset V2, vienti, tilin poisto |
| Globaali | Komentopaletti, haku, AI-vahvistusdialogi |

Välilehtiä on jo viisi. Talous menee kuudenneksi vain jos se mahtuu 360 px
näytölle; muuten se on Profiilin alanäkymä. Päätös tehdään toteutuksessa
mittaamalla, ei arvaamalla.

---

## Android / web -rajat

Yksi liiketoimintalogiikka. `android/` sisältää vain kuoren.

| Kyvykkyys | Web | Android | Tässä aallossa |
|---|---|---|---|
| notifications | etuala | ajastettu | valmis, laajennetaan laskuihin |
| speech | Web Speech API | adapterirajapinta | **arkkitehtuuri + web** |
| location | ei | ei toteuteta | **vain dokumentti** |
| background | ei | ei toteuteta | vain rajapinta |

Sijaintia ei toteuteta: sen todentaminen vaatii laitteen, jota ei käytetä.

---

## Testistrategia

Lähtö 780. Tavoite ei ole numero vaan kattavuus siellä missä virhe maksaa.

| Alue | Painopiste |
|---|---|
| AI-komennot | Väärä kohde, puuttuva kenttä, kielletty intentti, epäselvyys |
| Raha | Pyöristys, valuuttojen sekoitus, kokonaislukumuunnos |
| Toistuvuus | 28/29/30/31, karkausvuosi, vuodenvaihde, DST |
| Auth-elinkaari | A → logout → B, ei vuotoa |
| Vienti | Ei salaisuuksia, versiointi, determinismi |
| XSS | Jokainen käyttäjäkenttä |
| Suorituskyky | 1 000 tehtävää, 500 rutiinia, 1 000 laskua |
| Repository-sopimus | Sama semantiikka muistissa ja tuotannossa |

---

## STOP-portit

Työ **pysähtyy** ja raportoi, jos:

1. Jokin vaatisi yhteyden production-Supabaseen
2. Jokin vaatisi migraation ajamista
3. Jokin vaatisi tuotannon skeeman arvaamista
4. Jokin vaatisi allekirjoitusavainta tai salaisuuksia
5. Jokin vaatisi fyysistä laitetta tai ADB:tä
6. Testit eivät ole vihreät — silloin ei commitoida

Portin osuessa: **merkitse SCHEMA-GATED tai PRODUCTION-BLOCKED ja jatka muuta
turvallista työtä.**

---

## Commit-strategia

Loogisia checkpointeja, jokainen vihreänä. Ei pushia, ei mergeä.

```
1. plan + AI command system V2 + resolver
2. AI confirmation UI + audit
3. projects V2
4. goals V2
5. finance level 1 (raha kokonaislukuina)
6. export / import / account deletion
7. daily & weekly experience V3
8. search + command palette
9. state & security hardening
10. docs + cleanup + release
```
