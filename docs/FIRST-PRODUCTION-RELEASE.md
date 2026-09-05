# Ensimmäinen tuotantojulkaisu

Tämä on kertaluontoinen dokumentti: `main` viedään 7 tiedoston
prototyypistä nykyiseen sovellukseen. Tavallinen julkaisuohje on
[`DEPLOYMENT.md`](DEPLOYMENT.md).

> **TILA: VALMISTELTU. EI YHDISTETTY, EI JULKAISTU.**
> `main` = `bd652fa`, kehityshaara = `effd200`+, 59 committia edellä.
> Yhdistäminen ja push vaativat nimenomaisen luvan.

---

## Miksi tämä ei ole riskinotto vaan korjaus

Tuotannon sovellus ja tuotannon tietokanta ovat eri aikakausilta.
Tietokantaan on ajettu 0001 ja 0002: omistajuus on `auth.uid()`, RLS on
päällä, anon-roolilta on peruttu kaikki oikeudet. Tuotannon sivusto on
prototyyppi, joka tekee jokaisen kyselynsä anonina ja hakee profiilin
ehdolla `.eq('id', 'me')`.

```
prototyypin kysely                     tulos nykyistä kantaa vasten
────────────────────────────────────   ─────────────────────────────
sb.from('tasks').select('*')           42501 permission denied
sb.from('profile').eq('id','me')       22P02 invalid input syntax for uuid
sb.from('tasks').insert(...)           42501 permission denied
```

**Tuotantosivusto on ollut rikki siitä lähtien kun 0001 ajettiin.**
Julkaisematta jättäminen ei siis ole turvallinen vaihtoehto — se on
nykytilan jatkamista.

---

## Mitä julkaistaan

59 committia, 240 tiedostoa: 237 uutta, 3 muutettua
(`index.html`, `api/parse.js`, `package.json`). **Yhtään tiedostoa ei
poisteta** — prototyypin seitsemästä tiedostosta kaikki säilyvät.

| Alue | Sisältö |
|---|---|
| Autentikaatio | Supabase Auth, istunnon palautus, istunnon sukupolvi, uloskirjautumisen siivous |
| Datakerros | `tasksRepo`, `profileRepo`, `collectionsRepo`, `notificationPrefsRepo`, skeemaportit |
| Domain | tehtävät, rutiinit, tavoitteet, projektit, hyvinvointi, talous, aikataulumoottori |
| Käyttöliittymä | päivä-, viikko-, tehtävä-, tavoite-, profiili- ja asetusnäkymät |
| API | `/api/parse` + todennus, pyyntörajoitin ja syötevalidointi |
| AI | komentoputki, kohteen tunnistus, ehdotusten vahvistus |
| PWA | `sw.js`, offline-kuori, manifest |
| Android | Capacitor-kuori, Gradle-koonti (ei julkaisun osa) |
| Tietokanta | migraatiot 0001–0008, varmistukset, preflightit |
| Turvallisuus | turvaotsakkeet, CSP (report-only), salaisuusinvariantit |
| Testit | 1277 testiä |
| Työkalut | `tools/rls-acceptance` — **suljettu pois julkaisusta** (`.vercelignore`) |

Auditissa ei löytynyt kokeellisia, vanhentuneita, debug-vain- eikä
testitunnuksiin liittyviä tiedostoja julkaistavassa joukossa.

---

## Ennen yhdistämistä

| | Portti | Tila |
|---|---|---|
| 1 | `npm test` 1277/1277, `npm run check`, `npm run smoke` 77 | ✔ |
| 2 | `TASK_EXTENDED_FIELDS = false` julkaistavassa paketissa | ✔ testi vartioi |
| 3 | Kaikki 11 skeemaporttia `false` | ✔ testi vartioi |
| 4 | Ei salaisuuksia julkaistavassa koodissa | ✔ |
| 5 | Vercelin Production Branch = `main`, `ANTHROPIC_API_KEY` olemassa | ✔ ihminen todentanut |
| 6 | Tuore fyysinen varmuuskopio | **tarkista** — tuorein tiedossa 2026-09-05 06:57:15 UTC |
| 7 | Nimenomainen lupa julkaista | **puuttuu** |

Kohta 6 koskee tietokantaa, jota tämä julkaisu ei muuta. Se on silti
syytä tarkistaa: julkaisun jälkeen sovellus alkaa kirjoittaa kantaan
ensimmäistä kertaa auth-omistajuuden alla.

---

## Yhdistäminen

`origin/main` on kehityshaaran **esi-isä**, joten historia ei ole
haarautunut: `git rev-list --count HEAD..origin/main` = 0.
**Konflikteja ei voi tulla.**

### Suositus: fast-forward

```
git fetch origin
git checkout main
git merge --ff-only feature/wp-13-20-ultra-product
git log -1 --format=%H          # kirjaa tämä SHA
git push origin main
```

Fast-forward on tässä oikea valinta kahdesta syystä:

1. **Julkaistava SHA on täsmälleen se, joka läpäisi portit.** `--no-ff`
   loisi uuden yhdistämiscommitin, jonka puu on identtinen mutta jonka
   SHA:ta ei ole testattu eikä auditoitu. Kun jäljitettävyys on koko
   julkaisun perusta, se ero on turha.
2. Julkaisumerkintä saadaan tagilla, joka on tarkoitettu juuri siihen.

### Vaihtoehto: yhdistämiscommit

```
git merge --no-ff feature/wp-13-20-ultra-product -m "release: first production deployment"
```

Käytä tätä vain, jos haluat `main`in historiaan nimenomaisen
julkaisurajan. Se toimii, mutta tuottaa yllä kuvatun SHA-eron.

**Älä käytä `--force`-pushia äläkä rebasea.** `main` on jaettu haara.

### Mitä push käynnistää

Push `main`iin luo Vercelissä Production-julkaisun automaattisesti.
Käännösvaihetta ei ole: repon juuri tarjoillaan staattisesti ja
`api/*.js` muuttuvat serverless-funktioiksi. Julkaisu kestää tyypillisesti
alle minuutin.

---

## Savutesti julkaisun jälkeen

### Vaihe 1 — vain lukeva

Nämä eivät muuta yhtäkään riviä.

- [ ] `https://manifestival-ten.vercel.app` latautuu
- [ ] **Vanha prototyyppi on poissa** — näkyvissä on kirjautumisportti,
      ei suoraan tehtävälistaa
- [ ] Selaimen konsolissa ei fataaleja virheitä
- [ ] Kirjautuminen tilillä A onnistuu
- [ ] **36 tehtävää latautuu** ja profiilin arvot näkyvät
- [ ] Ei `42501`- eikä `22P02`-virheitä konsolissa tai verkkovälilehdellä
- [ ] Navigointi näkymien välillä toimii
- [ ] Sivun uudelleenlataus säilyttää istunnon
- [ ] Uloskirjautuminen tyhjentää näkymän ja palauttaa kirjautumisportin
- [ ] `view-source:https://manifestival-ten.vercel.app/src/data/schema.js`
      → `TASK_EXTENDED_FIELDS = false`
- [ ] Rutiinit, tavoitteet ja hyvinvointi kertovat, ettei tieto vielä säily
- [ ] `/manifest.json` ja `/sw.js` vastaavat 200
- [ ] Puheohjaus: `/api/parse` vastaa kirjautuneelle; kirjautumattomana `401`

### Vaihe 2 — pienin mahdollinen kirjoitus

> **EI TÄSSÄ PAKETISSA.** Vaatii oman lupansa.

- [ ] Luo yksi kertakäyttöinen tehtävä
- [ ] Muokkaa sitä
- [ ] Merkitse valmiiksi ja takaisin kesken
- [ ] Poista se
- [ ] Aja `supabase/preflight/recovery_snapshot_post_0002.sql` — tehtäviä
      on jälleen **36** ja sormenjälki 42 vastaa julkaisua edeltävää

---

## Service worker

Tuotannon prototyypissä **ei ole service workeria**: sen `index.html`
sisältää vain kommentin `no-op placeholder: no service worker yet`.
Origin on siis puhdas.

Ensimmäinen julkaisu asentaa `sw.js`:n version `v10` ensimmäisenä
service workerina koskaan. Tästä seuraa:

- vanhaa välimuistia ei ole, joten `caches.delete` ei löydä mitään
- vanha sovellus ei voi jäädä auktoritatiiviseksi
- **käyttäjän ei tarvitse tehdä pakotettua uudelleenlatausta**

Strategia on network-first: verkosta haetaan aina ensin ja välimuistia
käytetään vain kun verkko ei vastaa. `/api/`-polut ja vieraat originit
(Supabase, Anthropic-välityspalvelin, CDN) ohitetaan kokonaan, joten
henkilökohtaista dataa eikä todennusvastauksia ei talleteta laitteelle.

---

## Paluu taaksepäin

**`bd652fa` EI ole kelvollinen paluukohde.** Vercelin *Redeploy previous
deployment* palauttaisi prototyypin, joka ei toimi nykyistä kantaa vasten
lainkaan. Sama koskee jokaista committia ennen migraatiota 0001.

| Tilanne | Oikea toimenpide |
|---|---|
| Julkaisu ei mene läpi Vercelissä | Lue koontiloki. Mitään ei muuttunut — vanha julkaisu on yhä voimassa. |
| Sovellus latautuu mutta on rikki | Korjaa eteenpäin. Julkaise korjaus `main`iin. |
| Julkaisu on pakko perua | Palaa **ensimmäisen onnistuneen julkaisun SHA:han**, ei tätä aiempaan. |
| Tietokanta näyttää väärältä | Aja `recovery_snapshot_post_0002.sql`. **Älä palauta kantaa koodin takia.** |

Ennen ensimmäistä onnistunutta julkaisua kelvollista paluukohtaa **ei
ole olemassa**. Siksi savutestin läpäisy ja tagin luonti ovat osa
julkaisua, eivät valinnainen jälkityö.

### Tagi

Kun savutesti on läpi:

```
git tag -a prod-2026-09-first-release -m "Ensimmainen tuotantojulkaisu" <SHA>
git push origin prod-2026-09-first-release
```

Tagi tarkoittaa "tämän tiedetään toimivan tuotannossa", ei "tämä
julkaistiin". Älä luo sitä ennen savutestiä.

---

## Pysäytysehdot

Pysäytä ja selvitä ennen kuin jatkat, jos:

- `npm test` ei ole täysin läpi
- yksikin skeemaportti on `true`
- `TASK_EXTENDED_FIELDS` on `true` missä tahansa julkaistavassa tiedostossa
- Vercelin Production Branch ei olekaan `main`
- `ANTHROPIC_API_KEY` puuttuu Production-ympäristöstä
- julkaisun jälkeen tehtävät eivät lataudu tai konsolissa on `42501`
- kirjautuminen ei onnistu
- vanha prototyyppi näkyy yhä uudelleenlatauksen jälkeen

---

## Julkaisun jälkeen

| Seuraava | Missä |
|---|---|
| Suojaa `main` GitHubissa | [`DEPLOYMENT.md`](DEPLOYMENT.md), *Suositus: suojaa main* |
| GATE E — `TASK_EXTENDED_FIELDS` aktivointi | [`TASK-EXTENDED-FIELDS-ACTIVATION.md`](TASK-EXTENDED-FIELDS-ACTIVATION.md) |
| Migraatiot 0003–0008 | [`PRODUCTION-ACTIVATION-RUNBOOK.md`](PRODUCTION-ACTIVATION-RUNBOOK.md) |
| Laitehyväksyntä (APK) | [`TASK-EXTENDED-FIELDS-ACTIVATION.md`](TASK-EXTENDED-FIELDS-ACTIVATION.md), backlog D1–D3 |

Yksikään näistä ei ole osa ensimmäistä julkaisua.
