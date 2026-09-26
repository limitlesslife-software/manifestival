# Tietoturva

Päivitetty 31.8.2026 (WP1); tietoturvan ja yksityisyyden loppukierros
26.9.2026 (Suunta Day 1): ks. [Loppukierros](#loppukierros-suunta-day-1).

---

## Uhkaoletukset

Manifestival käsittelee hyvin henkilökohtaista tietoa: päivittäisen aikataulun,
työajat, perheen menot, unirytmin, terveystiedon alkeet ja myöhemmin talouden.
Konseptidokumentin luku 24 asettaa luottamuksen tuotteen perusedellytykseksi.

Oletamme, että:

1. **Sovelluskoodi on julkista.** Repo on julkinen ja `index.html` ladataan
   jokaiselle selaimelle. Mikään selaimeen päätyvä arvo ei ole salaisuus.
2. **Hyökkääjä tuntee Supabase-projektin osoitteen ja anon-avaimen.** Ne ovat
   koodissa. Tämä on normaalia eikä itsessään haavoittuvuus.
3. **Ainoa todellinen pääsynvalvonta on tietokannassa.** Selainkoodiin ei voi
   luottaa: kuka tahansa voi kutsua Supabasen REST-rajapintaa suoraan ilman
   sovellusta.
4. **`/api/parse`, `/api/extract` ja `/api/plan` ovat julkisia
   päätepisteitä**, joita kuka tahansa voi kutsua. Kaikki vaativat
   kirjautumisen ja rajoittavat pyyntöjä omalla avaimellaan, mutta
   reitti itsessään on avoin. Molemmat vaativat kirjautumisen ja
   rajoittavat pyyntöjä, mutta reitti itsessään on avoin.

---

## Kuitin kuva

**Kuvaa ei tallenneta mihinkään.**

`/api/extract` vastaanottaa kuitin tai laskun kuvan, lähettää sen
Anthropicille luettavaksi ja unohtaa sen. Kuvaa **ei** kirjoiteta
levylle, **ei** tallenneta Supabaseen, **ei** lokiteta eikä palauteta
vastauksessa. Se elää yhden pyynnön keston.

Kuittitaulua ei ole eikä sitä ole suunniteltu. Migraatio 0009 ei luo
sellaista. Taulu jota ei ole, ei voi vahingossa täyttyä.

Ketju kokonaisuudessaan:

| Vaihe | Missä | Mitä kuvalle tapahtuu |
|---|---|---|
| Valinta | selain | `<input type="file">`, tyhjennetään heti käytön jälkeen |
| Pienennys | selain | canvas, **riisuu EXIF-metatiedot ja GPS-koordinaatit** |
| Lähetys | selain → palvelin | base64, enintään 5 MB |
| Luenta | palvelin → Anthropic | kuva mukana pyynnössä |
| Vapautus | molemmat | `revokeObjectURL`, `input.value = ''`, base64 nollataan |
| Jäljelle jää | selain | luenta — **ei kuvaa** |

Luennan tietomallissa (`src/domain/receipts.js`) **ei ole kuvakenttää**,
joten kuvaa ei voi vahingossakaan tallentaa. Tämä on lukittu testillä
`tests/finance-2-domain.test.mjs`.

Virheviestit eivät koskaan sisällä kuvadataa: base64-pätkä lokissa
olisi juuri se kuitti, jota ei ollut tarkoitus säilyttää. Lukittu
testillä `tests/api-extract-validation.test.cjs`.

---

## Suunnittelun konteksti

**Mallille lähetetään lukuja, ei sisältöä.**

`/api/plan` saa käyttäjän vapaan tavoitetekstin (jonka hän itse
kirjoitti) ja kolme lukua:

```
activeGoalCount       montako tavoitetta kilpailee ajasta
nearestDeadlineDays   kuinka monen päivän päässä lähin määräpäivä on
weeklyFreeHours       paljonko vapaata aikaa viikossa on
```

**Käyttäjän tehtävälista, muistiinpanot, hyvinvointimerkinnät ja
taloustiedot eivät lähde ulos.** Numero ei voi sisältää ohjetta, eikä
siitä voi lukea mitä käyttäjä tekee tai ajattelee.

Kontekstista luetaan vain nimetyt kentät (`cleanContext`). Nimenomainen
sallittujen lista on ainoa tapa varmistaa, ettei promptiin päädy
sisältöä jota kukaan ei osannut kieltää etukäteen. Kelvoton luku
muuttuu `null`-arvoksi eikä nollaksi: nolla olisi väite, `null` on
rehellinen.

Vapaa tavoiteteksti kulkee **JSON-koodattuna**, jolloin lainausmerkki
tai rivinvaihto ei voi katkaista promptin rakennetta.

Lukittu testeillä `tests/api-plan-validation.test.cjs` ja
`tests/goal-to-action-domain.test.mjs`.

### Mallin vastaus on ulkoista syötettä

Malli ei saa päättää tunnisteita, kellonaikoja eikä tiloja. Mallin
ehdottama `id` voisi olla käyttäjän olemassa olevan rivin tunniste, ja
"luonti" ylikirjoittaisi sen.

`src/ai/planSchema.js` pudottaa nämä kentät ja **kirjaa ne
hylätyiksi**, jotta kehotteen ajautuminen huomataan. Kelvoton vastaus
hylätään kokonaan eikä osittain: puolittain ymmärretty suunnitelma
näyttäisi suunnitelmalta.

---

## Suunnitelmaehdotus ei ole pysyvä

Ehdotustaulua ei ole. Ehdotus elää istunnon muistissa siihen asti että
käyttäjä hyväksyy tai hylkää sen; hyväksynnästä syntyy tavallisia
rivejä ja ehdotus katoaa.

Se on myös turvallisuuspäätös: ehdotus sisältää mallin tuottamaa
tekstiä, ja mitä vähemmän sitä säilytetään, sitä vähemmän sitä voi
vuotaa. Hylätty ehdotus ei jää vientiin eikä kantaan.

Uloskirjautuminen nollaa ehdotuksen, muutosehdotuksen ja
idempotenssiavaimet — jäänyt avain estäisi seuraavaa käyttäjää
tallentamasta.

---

## Maksaminen

**Manifestivalilla ei ole pankkiyhteyttä eikä valtuutta siirtää rahaa.**

- Skannattu lasku syntyy aina tilassa `open`. `toBill()` pakottaa sen
  riippumatta siitä, mitä luennassa lukee.
- `iban` ja `reference` ovat tietoa, jonka käyttäjä kopioi omaan
  pankkiinsa. Ne eivät käynnistä mitään.
- Säästösiirto on kirjaus siitä, että käyttäjä siirsi rahaa itse.

Jos sovellukseen joskus lisätään maksuominaisuus, se on oma
turvallisuusarvionsa — ei tämän laajennus.

---

## Salaisuudet

| Arvo | Sijainti | Julkinen? | Huomiot |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | Vercelin ympäristömuuttuja | **EI** | Vain palvelinpuolen `api/parse.js`, `api/extract.js`, `api/plan.js`, `api/capture.js`, `api/command.js` ja `api/explain.js` lukevat. Ei koskaan selaimeen. (`tests/api-explain-readiness.test.mjs` vertaa tätä listaa koodiin.) |
| `EXPLAIN_ENABLED` | Vercelin ympäristömuuttuja | Ei (katkaisin, ei salaisuus) | Vain täsmälleen `true` avaa `/api/explain`in; muuten 503 ennen todennusta. **Oletus: ei asetettu = pois.** Käyttöönotto on omistajan päätös yhdessä selaimen lipun `AI_EXPLAIN_ENABLED` kanssa. |
| Supabase URL | `src/data/config.js` (myös CSP:n `connect-src`) | Kyllä | Julkinen projektin osoite |
| Supabase anon-avain | `src/data/config.js`, `api/_auth.js` | Kyllä | Suunniteltu julkiseksi. Turva perustuu RLS:ään. JWT, jonka `role` on `anon` — `tests/security-secrets.test.mjs` hylkää jokaisen muun JWT-literaalin. |
| Supabase `service_role` | **Ei missään repossa, ei selaimessa, ei `api/`-koodissa** | **EI KOSKAAN** | Ohittaa RLS:n. Ainoa sallittu paikka on Supabasen oma Edge Function -salaisuusvarasto (alla). |
| `SUPABASE_SECRET_KEYS` / `SUPABASE_SERVICE_ROLE_KEY` | Supabase Edge Function -salaisuudet (Supabase asettaa itse; **funktiota ei ole deployattu**) | **EI** | Vain `supabase/functions/delete-account`. `index.ts` välittää handlerille vain neljä nimettyä muuttujaa, ei koko ympäristöä. Repossa on vain muuttujien nimet. |
| `DELETE_ACCOUNT_ALLOWED_ORIGINS` | Edge Function -salaisuus | Ei | Sallittujen selainlähteiden lista; tyhjä = kaikki selainpyynnöt hylätään. |

### Säännöt

- Salaisuudet eivät koskaan mene versionhallintaan. `.gitignore` estää
  `.env`, `.env.*` ja `*.key`.
- `.env.example` sisältää vain muuttujien **nimet**.
- Tuotannon salaisuudet elävät Vercelin projektiasetuksissa.
- Salaisuuksia ei tallenneta työpöydälle tekstitiedostoihin.
- Testit valvovat tätä automaattisesti: `tests/security-invariants.test.mjs`
  hylkää lähdekoodin, jossa on `sk-ant-`-alkuinen merkkijono tai
  `service_role`, ja `tests/security-secrets.test.mjs` käy läpi **koko
  versionhallinnan puun** (paitsi `node_modules/`, `.claude/`, `dist/`):
  Anthropic- ja `sb_secret_`-avaimet, PEM-yksityisavaimet, AWS-, GitHub- ja
  Google-tunnukset, avain- ja `.env`-tiedostot sekä jokainen JWT-literaali
  (vain `role: anon` sallittu). Testien tekoavaimissa on oltava sana
  `TEST` tai `LEAK`.

---

## Autentikaatio

Supabasen oma sähköposti-/salasanakirjautuminen (`sb.auth.signInWithPassword`,
`sb.auth.signUp`, `sb.auth.signOut`).

- Sovellus **ei toteuta omaa salasanajärjestelmää** eikä käsittele, tiivistä
  tai tallenna salasanoja. Tämä on testattu invariantti.
- Istunto palautetaan sivun latauksessa `sb.auth.getSession()`-kutsulla ja
  muutoksia seurataan `onAuthStateChange`-kuuntelijalla.
- Uloskirjautuminen tyhjentää kaiken henkilökohtaisen tilan muistista
  (`leaveApp()`), ei pelkästään piilota näkymää.
- Salasanan vähimmäispituus on 8 merkkiä. Supabasen omat säännöt ovat
  ensisijaiset — client-tarkistus on vain käyttökokemusta varten.
- Virheviestit on käännetty suomeksi eivätkä ne paljasta, oliko sähköposti
  olemassa vai ei ("Sähköposti tai salasana ei täsmää").

### Suositellut Supabase-asetukset

Nämä on tarkistettava dashboardista (ks. `docs/DEPLOYMENT.md`):

- Sähköpostin vahvistus **päälle** (`Confirm email`)
- Salasanan vähimmäispituus vähintään 8
- Kirjautumisyritysten rajoitus päällä
- `Site URL` ja `Redirect URLs` osoittavat tuotantodomainiin

---

## Pääsynvalvonta (RLS)

Tämä on järjestelmän tärkein turvamekanismi.

| Taulu | Ehto |
|---|---|
| `tasks` | `auth.uid() = user_id` — kaikki neljä operaatiota erikseen |
| `profile` | `auth.uid() = id` — kaikki neljä operaatiota erikseen |

- `insert` ja `update` käyttävät `WITH CHECK` -ehtoa, jotta riviä ei voi
  kirjoittaa toisen nimiin.
- `user_id`-sarakkeen oletusarvo on `auth.uid()`. **Client ei lähetä
  `user_id`-kenttää lainkaan** — `src/lib/rows.js:toRow()` ei tuota sitä ja
  `assertClientSafe()` heittää poikkeuksen, jos se jostain ilmestyisi.
  Tämä on puolustusta syvyydessä; varsinainen tae on `WITH CHECK`.
- `anon`-roolilla ei ole yhtään politiikkaa eikä taulukohtaisia oikeuksia.

### Miksi ei väliaikaista anon-mallia

Harkittiin väliaikaista ratkaisua, jossa `anon`-rooli olisi saanut käyttää
"vain omaa dataansa" ennen autentikaation valmistumista. **Se hylättiin**:
ilman autentikaatiota ei ole olemassa luotettavaa käyttäjäidentiteettiä, joten
`anon`-roolille ei voi määritellä turvallista "omaa" rajausta. Mikä tahansa
tällainen politiikka olisi ollut näennäisturvaa.

### Yllä kuvattu on migraation 0001 JÄLKEINEN tila

> **HISTORIALLINEN (ennen 0001:tä).** 0001 on sittemmin ajettu, ja kahden
> tilin eristystesti on hyväksytty 0001–0008:lle
> ([`RLS-ACCEPTANCE.md`](RLS-ACCEPTANCE.md)). Migraatioiden 0009–0013
> neljätoista taulua ovat **todentamatta oikeaa PostgRESTiä vasten**:
> ks. [Loppukierros](#loppukierros-suunta-day-1).

Mikään edellä kuvatuista politiikoista ei ole tällä hetkellä voimassa.
`supabase/migrations/0001_auth_user_scoping.sql` on luonnos, jota ei ole
ajettu.

### Todennettu nykytila — projektin vakavin avoin riski

`supabase/inventory.sql` on ajettu, joten tätä ei enää arvailla.
Tuotannossa on juuri nyt:

- `public.tasks`: 36 riviä, **ei omistajuussaraketta**
- `public.profile`: 1 rivi, `id = 'me'` — kaikille sama rivi
- molemmilla taululla **"salli kaikki" -tyyppinen politiikka**
- `anon`-roolilla on taulukohtaiset oikeudet

Sovellus toimii tälläkin hetkellä ilman kirjautumista, mikä on itsessään
todiste siitä, että julkinen `anon`-avain riittää pääsyyn. Avain on
selaimessa jokaisella sivulatauksella.

**Käytännössä: kuka tahansa, joka löytää projektin URL-osoitteen ja
anon-avaimen, voi lukea, muuttaa ja poistaa kaiken datan.** Politiikka,
joka sallii kaiken, ei ole pääsynvalvontaa.

Tämä on projektin vakavin avoin riski, ja se pysyy avoinna kunnes 0001 on
ajettu ja runbookin **PYSÄYTYS 5** (kahden tilin eristystesti) on läpäisty.
Ks. [`PRODUCTION-ACTIVATION-RUNBOOK.md`](PRODUCTION-ACTIVATION-RUNBOOK.md).

---

## AI-integraation turvallisuus

```
Selain                Vercel serverless            Anthropic
  |                          |                         |
  |-- POST /api/parse ------>|                         |
  |   { transcript,          |-- x-api-key: env ------>|
  |     today, weekday }     |                         |
  |                          |<-- vastaus -------------|
  |<-- { content } ----------|                         |
  |                          |                         |
  |-- POST /api/explain ---->|  (vain jos EXPLAIN_ENABLED=true,
  |   { context: luvut,      |   muuten 503 ilman verkkokutsua)
  |     tunnukset A1.. }     |-- system: säännöt ----->|
  |                          |   user: vain data       |
  |<-- { text } -------------|<-- vastaus -------------|
```

Samat suojaukset koskevat kaikkia AI-päätepisteitä (`parse`, `extract`,
`plan`, `capture`, `command`, `explain`); `tests/api-security.test.cjs`
käy ne läpi hakemistosta, ei kiinteästä listasta.

**CORS** (`api/_cors.js`): Android-kuori lataa sivun originista
`https://localhost` ja kutsuu tuotannon päätepisteitä. Vain
`https://localhost` ja `capacitor://localhost` saavat
`Access-Control-Allow-Origin`-otsakkeen (kaiutettuna, `Vary: Origin`),
esikysely (OPTIONS) saa 204:n ennen POST-tarkistusta, eikä tuntematon origin
saa sallintaa. CORS ei korvaa todennusta.

**Tekoälyselitys** (`/api/explain`, valinnainen): oletuksena pois kahdella
kytkimellä (palvelimen `EXPLAIN_ENABLED`, selaimen `AI_EXPLAIN_ENABLED`).
Vaatii aina todennetun käyttäjän. Kun `PARSE_REQUIRE_AUTH=false`, todennus
ohitetaan eikä käyttäjää tunneta, joten `/api/explain` vastaa 401 kaikille
(myös voimassa olevalla tokenilla) ja selain näyttää deterministisen
selityksen: hätävara ei koskaan avaa selitystä anonyymille.
Säännöt kulkevat `system`-kentässä, data yksin käyttäjän viestissä. Vain
luonnollisesti päättynyt (`stop_reason: end_turn`), enintään 1 200 merkin
vastaus kelpaa; muuten 502 ja selain näyttää deterministisen selityksen.
Lokiin vain tilakoodi tai lopetussyyn luettelokoodi.

- **API-avain ei koskaan päädy selaimeen.** Todennettu: `index.html` ei sisällä
  merkkijonoa `ANTHROPIC_API_KEY` eikä kutsu `api.anthropic.com`-osoitetta.
  Molemmat ovat automaattisia testejä.
- Selain saa vastauksesta vain `content`-osan. Käyttötilastoja,
  pyyntötunnisteita eikä mallin metatietoja ei välitetä.
- Virheviestit ovat yleisiä. Anthropicin virhevastaus lokitetaan palvelimelle,
  ei palauteta clientille.
- Syöte validoidaan ennen kuin yhtään tokenia kuluu: tyypit, tyhjyys,
  enimmäispituus (1 000 merkkiä), rungon enimmäiskoko (8 kB).
- `today` ja `weekday` menevät promptiin, joten ne validoidaan tiukasti:
  `today` ISO-muotoa vasten, `weekday` sallittujen suomenkielisten
  viikonpäivien listaa vasten. Tämä estää mielivaltaisen tekstin ujuttamisen
  promptiin näiden kenttien kautta.
- Ylävirran kutsulla on 15 sekunnin aikakatkaisu.

### Päätepisteen suojaus (WP2)

`/api/parse` oli täysin avoin: kuka tahansa internetin käyttäjä pystyi
kuluttamaan maksullista Anthropic-kiintiötä. Korjattu.

**Todennus** (`api/_auth.js`): pyyntö vaatii kirjautuneen käyttäjän.
Supabasen access token annetaan Supabasen omalle `/auth/v1/user`
-päätepisteelle, joka kertoo onko se voimassa.

Miksi näin: JWT:n allekirjoituksen tarkistus vaatisi projektin JWT-salaisuuden
palvelimelle. **Uutta salaisuutta ei haluttu lisätä vain tätä varten.**
Tarkistus tehdään siellä missä tieto jo on. Hinta on yksi verkkokutsu.

Turvallinen oletus: todennus on päällä, ellei `PARSE_REQUIRE_AUTH=false`
nimenomaisesti aseteta. **Todennuspalvelun virhe EI avaa päätepistettä** —
se palauttaa 503, ei päästä läpi.

**Pyyntörajoitin** (`api/_ratelimit.js`): käyttäjäkohtainen liukuva ikkuna,
20 pyyntöä minuutissa.

Rajoitteet kerrottuna suoraan: rajoitin elää serverless-instanssin muistissa.
Vercel käynnistää rinnakkaisia instansseja, joten laskuri ei ole jaettu eikä
pysyvä. Se on **paras yritys**, ei tae. Se riittää estämään vahingossa
tapahtuvan tulvan ja nostamaan rimaa satunnaiselle väärinkäytölle; se ei kestä
hajautettua tahallista hyökkäystä.

Oikea hajautettu rajoitin vaatisi ulkoisen tilan (Redis / Vercel KV). Se on
maksullinen palvelu, jota ei lisätä ilman erillistä päätöstä. Rajapinta on
sellainen, että toteutuksen voi vaihtaa koskematta kutsupaikkaan.

**AI-vastauksen validointi** (`src/ai/proposalSchema.js`): mallin tuotokseen ei
luoteta. Tuntemattomat kentät hylätään, kategoria ja prioriteetti validoidaan
domainin enumeja vasten, pituudet rajataan. Ylimmän tason taulukko hylätään
eksplisiittisesti sen sijaan että poimittaisiin vaieten ensimmäinen alkio.
**AI ei koskaan kirjoita tietokantaan** — jokainen ehdotus käy käyttäjän
vahvistuksen kautta.

**Prompt-injektio:** `today` ja `weekday` menevät suoraan promptiin, joten ne
validoidaan tiukasti (ISO-muoto, sallittujen viikonpäivien lista). Käyttäjän
teksti upotetaan `JSON.stringify`-koodattuna, joten se ei voi katkaista promptin
rakennetta. Molemmat on testattu.

### Jäljelle jäävät puutteet

| Puute | Vaikutus | Korjaus |
|---|---|---|
| Rajoitin ei ole jaettu instanssien kesken | Hajautettu väärinkäyttö mahdollinen | Ulkoinen tila, erillinen päätös |
| Ei kustannusseurantaa | Kulutus ei näy | Myöhempi työpaketti |

---

## Muut tunnetut riskit

| # | Riski | Tila |
|---|---|---|
| 1 | RLS-tila tuotannossa todentamaton | 0001–0008 todennettu ([`RLS-ACCEPTANCE.md`](RLS-ACCEPTANCE.md)); **0009–0013 avoin**: työkalu valmis, ajo aalloissa I/J omistajan luvalla ja kertakäyttöisellä tilillä |
| 2 | Anthropic-avain selkokielisenä työpöytätiedostossa | Avoin — kierrätysohje `docs/DEPLOYMENT.md` |
| 3 | Poisto ilman vahvistusta | Korjattu — `src/ui/confirm.js` |
| 4 | Kantavirheet vain `console.error`-lokiin | Korjattu — virhe näytetään ja muutos perutaan |
| 5 | Tilin poisto (konsepti luku 24) | Toteutettu paikallisesti, **EI KÄYTÖSSÄ**: Edge Function + esikatselu + vahvistus-UI + testit valmiit; funktiota ei ole deployattu ja `ACCOUNT_DELETION.endpointEnabled = false`. Ks. `docs/ACCOUNT-DELETION.md`. Datan vienti on toteutettu. |
| 9 | Puheohjaus ja AI-komennot | Korjattu MEGA BUILD III:ssa: kaikki komennot yhden allowlist-putken kautta, vahvistus muutoksille, vanhentuneen kohteen suojaus, idempotenssi, tilakone (mikrofoni vain kuunteluvaiheessa), vastakkainasettelutestit (`tests/ai-command-adversarial.test.mjs`) |
| 10 | Sijainti | Vain etualan kertahaku, koordinaatit vain muistissa, ei taustasijaintia; laitteella todentamatta. Ks. `docs/LOCATION-DEPARTURE-ARCHITECTURE.md` |
| 11 | Offline-kirjausjono | Vain tehtävän lisäys/muokkaus; käyttäjäkohtainen avain, ei tunnisteita muille käyttäjille, ei poistoja/talousdataa/AI-komentoja jonoon. Ks. `docs/ARCHITECTURE.md` |
| 6 | Ei service workeria, ei offline-tukea | Korjattu — `sw.js` |
| 7 | Muistutusten sisältö näkyy laitteen lukitusnäytöllä | Hyväksytty — käyttäjä kytkee muistutukset itse |
| 8 | Tavoiteviite voi osoittaa toisen käyttäjän tunnisteeseen | Hyväksytty — ks. migraation 0004 huomio viite-eheydestä |

### Tilin poisto: Edge Function -salaisuusmalli

`supabase/functions/delete-account` on ainoa koodi, joka tarvitsee
palvelinpuolen avaimen, ja se on tarkoituksella erillään `api/`-välityksestä.

- Käyttäjä tunnistetaan **kutsujan omasta Bearer-JWT:stä palvelimella**
  (`auth.getUser`), ei pyynnön rungosta. Poisto vaatii sähköpostin ja lauseen
  `POISTA TILINI`; muuten pyyntö hylätään ennen kuin mitään poistetaan.
  Kuiva-ajo (`mode`) laskee vain rivimäärät eikä muuta mitään.
- Poisto on yksi atominen `auth.admin.deleteUser`, koska kaikki käyttäjätaulut
  viittaavat `auth.users(id) on delete cascade` -sääntöön (drift-testit
  jäsentävät migraatiot: uusi taulu ilman cascadea kaataa testin).
- Palvelinavain luetaan vain funktion ympäristöstä; selain-/repokoodissa ei
  koskaan (`tests/account-deletion-function.test.mjs`, `tests/account-deletion-inventory.test.mjs`).
- Sallitut selainlähteet rajataan `DELETE_ACCOUNT_ALLOWED_ORIGINS`-listalla;
  virheilmoitukset eivät paljasta sisäistä tilaa.
- **Käyttöönotto on omistajan erillinen päätös** (deploy, salaisuudet,
  lähdelista, `endpointEnabled = true`). Sitä ei ole tehty.

---

## Loppukierros (Suunta Day 1)

Suunnan data — elämänalueiden nimet, viikkokatsausten pohdinnat,
aikakirjausten muistiinpanot ja käynnissä oleva ajastin — on sovelluksen
yksityisintä. Loppukierros sulki neljä aukkoa ja lukitsi invariantit
testeihin. Taustana `CRIT-07`, `CRIT-09`, `ERR-15` ja `ERR-16`.

### Content-Security-Policy: pakottava myös APK:ssa

APK:ssa ei ollut CSP:tä lainkaan: Capacitorin paikallinen palvelin ei
lähetä otsakkeita, ja `vercel.json`:n otsake oli vain raportoiva.
`index.html` kantaa nyt **pakottavan** `<meta http-equiv>`-politiikan, joka
kulkee APK:hon bittiverrannollisena kopiona (`scripts/build-web.mjs`).

| Direktiivi | Arvo | Miksi |
|---|---|---|
| `script-src` | `'self'` | supabase-js on vendoroitu (`vendor/`); ei inline-skriptejä eikä evalia |
| `connect-src` | `'self'`, Supabase-projekti, `https://manifestival-ten.vercel.app` | natiivikuori kutsuu `/api`:a tuotanto-originista (`apiUrl`) |
| `img-src` | `'self' data: blob:` | kuitin esikäsittely lataa kuvan object-URL:sta |
| `style-src` / `font-src` | `'unsafe-inline'` + Google Fonts | merkinnän `style`-attribuutit ja fonttipalvelu |
| `object-src`, `base-uri`, `form-action` | `'none'`, `'self'`, `'self'` | |

- Meta on ennen jokaista resurssia. Capacitorin silta ajetaan sitä ennen
  (Capacitor 8: `addDocumentStartJavaScript` tai `<head>`-tagin perään
  lisätty skripti, `JSInjector`), joten `script-src 'self'` ei estä sitä.
  Natiivikutsujen vastaukset kulkevat `evaluateJavascript`- tai
  WebMessage-kanavaa, jonka ei pitäisi olla sivun CSP:n alainen — tämä on
  todennettava laitteella (alla).
- `vercel.json`:n raportoiva otsake on sama politiikka + `frame-ancestors`
  (meta ei tue sitä). `tests/security-csp.test.mjs` vertaa niitä, vaatii
  jokaisen `<script src>`:n olevan omasta originista ja jokaisen koodissa
  esiintyvän absoluuttisen osoitteen olevan `connect-src`:ssä.
- Todennettu paikallisessa headless Chromessa (tuotanto DNS-estetty):
  sovellus käynnistyy, service worker rekisteröityy, blob-kuva latautuu ja
  vieras origin estyy. **Laitteella todentamatta:** avaa APK
  `chrome://inspect`-näkymässä ja tarkista, ettei konsolissa ole
  `Content Security Policy` -rikkomuksia kirjautumisessa, AI-komennossa,
  kuitin luvussa eikä ajastimessa.

### Lokitus ei vuoda sisältöä

- `SENSITIVE_KEYS` kattaa Suunnan ja PostgRESTin kentät (`reflection`,
  `reflectionAnswers`, `answer(s)`, `label`, `detail(s)`, `hint`, `message`,
  `metric`, `unit`, `summary`, `content`, `body`, `query` sekä ennestään
  `name`, `title`, `note`). Vertailu ilman kirjainkokoa ja ala-/väliviivoja.
- `logEvent` pitää merkkijonon vain, jos se on koodin näköinen
  (`/^[a-z0-9_.:-]{1,60}$/i`); muu teksti on `[teksti]`, pitkä `[pitkä]`.
  Avain, jota ei ole listattu, ei siis päästä nimeä läpi.
- `isDevEnvironment()` on epätosi natiivikuoressa, vaikka APK:n origin on
  `https://localhost`: INFO- ja DEBUG-tapahtumat eivät päädy logcatiin.
- `logFailure(event, error)` kirjaa vain virheen nimen, koodin ja
  HTTP-tilan. Sovelluskerroksen raa'at `console.warn/error(…, error)`
  -kutsut on korvattu sillä: PostgRESTin `details` kantaa rivin arvoja
  (`Key (user_id, name)=(…, Terapia)`).
- Testit: `tests/lib-logger-errors.test.mjs` (kentät, merkkijonopolitiikka,
  natiivikuori, `logFailure`, ei raakoja virheolioita `src/app`:ssa) ja
  `tests/life-alignment-privacy.test.mjs` (yksikään loki- tai konsolikutsu
  koko `src/`:ssä ei lue sisältökenttää; Suunnan virrat alueesta
  katsaukseen eivät vie sisältöä konsoliin edes virhepolulla).
- Ulkoista telemetriaa ei ole (testattu).

### Tekoäly ja laite

- Suunnan selityskonteksti on tunnuksia (A1, A2 …) ja lukuja; suunnittelun
  rajat (`buildPlanningConstraints`) ovat pelkkiä lukuja. Pohdinta ei
  kulje tekoälylle millään reitillä.
- Laitteelle jäävä käyttäjäkohtainen data (offline-jono, lähtökori,
  ajastin, odottavat ajastimet, hautakivet, käyttäjäliput) on avaimeltaan
  käyttäjän, säilyy uloskirjautumisen yli omistajalleen ja poistuu tilin
  poistossa (`purgeDeviceDataForUser`); toisen käyttäjän avaimet säilyvät.
- A → B samalla laitteella (`tests/cross-user-leak.test.mjs`): B ei näe
  A:n Suunta-kokoelmia, ajastinta (ei palautuksessa, välilehtitapahtumassa
  eikä väärennettynä B:n avaimella), lähtökoria eikä jonoa, eikä A:n
  istunnon skeemakielto siirry B:lle; skeemavälimuistissa ei ole
  tunnistetta.

### RLS 0009–0013: todiste odottaa omistajan lupaa

`tools/rls-acceptance` kattaa nyt migraatioiden 0009–0013 neljätoista
taulua ja kuusitoista yhdistelmävierasavainta aalloittain (esim. B:n
aikakirjaus A:n alueeseen → 23503, B:n päivitys A:n pohdintaan → 0 riviä,
B ei näe A:n ajastinta). **Työkalua ei ole ajettu:** se puhuu tuotannolle,
ja ajo on aaltojen I ja J hyväksyntävaihe, joka vaatii omistajan
kertakäyttöisen toisen tilin ja nimenomaisen luvan. Ks.
[`RLS-ACCEPTANCE.md`](RLS-ACCEPTANCE.md#aallot-i-ja-j-migraatiot-00090013).

### Jäljelle jäävät

| Puute | Tila |
|---|---|
| 0009–0013:n RLS oikeaa PostgRESTiä vasten | Omistajan päätös: kertakäyttöinen tili + ajo aalloissa I/J |
| CSP laitteella | Laitehyväksyntä: `chrome://inspect`, ei rikkomuksia |
| `src/lib/result.js` `logError` tulostaa virheen `message`- ja `hint`-kentät (details suodatetaan) ja ei-AppError-virheen sellaisenaan | Virhepaketin vastuulla; `logFailure` on valmis korvaaja |
| `verify_acceptance.sql` ei tunne 0009–0013:n tauluja | Jäännöshaku ohjeessa (`RLS-ACCEPTANCE.md`); oma SQL-varmistus myöhemmin |

---

## Korjattu WP7-WP12:ssa

| Löydös | Vakavuus | Korjaus |
|---|---|---|
| Muistivarasto säilyi uloskirjautumisen yli, jolloin seuraava käyttäjä näki edellisen rutiinit ja tavoitteet samalla selaimella | **Korkea** | `clearLocalUserData()` uloskirjautuessa; 7 regressiotestiä |
| Uloskirjautuminen kesken muistutusten synkronoinnin olisi ajastanut edellisen käyttäjän tehtävien otsikot laitteelle | Keskitaso | Asetukset tarkistetaan uudelleen odotuksen jälkeen |
| Turvatesti "kaikki tietokantakutsut yhdessä moduulissa" tunnisti vain merkkijonona kirjoitetun taulun nimen, joten yleistetty repositorio livahti valvonnasta | Keskitaso | Kuvio korjattu; molemmille uusille repositorioille omat rajaustestit |
| XSS-vartija ei tuntenut kenttiä `name` eikä `body` | Matala | Kentät lisätty vartijan kuvioon |
| Tuplaklikkaussuojan tarkistuslista ei kattanut uusia näkymiä | Matala | Lista täydennetty |

### Muistutusten turvamalli

- Lupaa **ei koskaan** pyydetä automaattisesti. `syncNotifications()` ajetaan
  joka avauksella eikä se kysy lupaa; kysely tapahtuu vain pääkytkimen
  painalluksesta. Tämä on lukittu testillä.
- Oletus on hiljaisuus sekä koodissa (`enabled: false`) että kannassa
  (`default false`). Testi vertaa niitä toisiinsa.
- Ajastetut muistutukset perutaan ennen uusien luontia, jottei poistetun
  tehtävän muistutus jää elämään laitteelle.
- Natiivin lupatilan välimuisti alkaa arvosta PROMPT eikä koskaan oleta
  lupaa: väärä "granted" saisi sovelluksen luulemaan lähettävänsä
  ilmoituksia, joita kukaan ei näe.

---

## Korjattu WP2:ssa

- ✅ `/api/parse` vaatii kirjautumisen, todennus Supabasen kautta ilman uusia salaisuuksia
- ✅ Käyttäjäkohtainen pyyntörajoitin (paras yritys, rajoitteet dokumentoitu)
- ✅ AI-vastaus validoidaan tiukasti domainin enumeja vasten
- ✅ Prompt-injektio estetty `today`- ja `weekday`-kenttien kautta
- ✅ Poisto vaatii vahvistuksen (natiivi dialog, fokus peruutuksessa)
- ✅ Epäonnistunut kirjoitus **palauttaa tilan** ja näyttää virheen — UI ei
  enää valehtele onnistumisesta
- ✅ Käyttäjäviesti ja diagnostiikka erotettu rakenteellisesti (`AppError`)
- ✅ `escapeHtml` suojaa myös lainausmerkit; XSS-invariantti testattu
- ✅ Tuplaklikkaussuoja (`singleFlight`) kaikilla async-poluilla
- ✅ Uloskirjautuminen tyhjentää tilan, ilmoitukset ja laiteasetukset
- ✅ Service worker ei välimuistita henkilökohtaista dataa eikä API-kutsuja
- ✅ Tehtävätunnisteiden törmäysriski poistettu (`crypto.randomUUID`)
- ✅ Kaikki tietokantakutsut yhdessä moduulissa — rajauksen valvonta mahdollista

## Korjattu WP1:ssä

- ✅ Autentikaatio toteutettu koodiin (Supabase Auth)
- ✅ Käyttäjäkohtainen omistajuusmalli määritelty (`user_id` / `auth.uid()`)
- ✅ Lopullinen RLS-migraatio kirjoitettu (ei väliaikaista anon-kiertotietä)
- ✅ Kaikki tietokantakutsut rajattu kirjautuneeseen käyttäjään
- ✅ Client ei voi asettaa `user_id`-kenttää
- ✅ Automaattinen esimerkkidatan kirjoitus tuotantoon poistettu
- ✅ `/api/parse` kovennettu: metodi-, syöte- ja kokovalidointi, aikakatkaisu,
  turvallinen virheenkäsittely, rajattu vastaus
- ✅ `.gitignore` estää salaisuuksien commitoinnin
- ✅ Automaattiset testit valvovat näitä invariantteja
