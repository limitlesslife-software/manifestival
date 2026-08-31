# Tietoturva

Päivitetty 31.8.2026 (WP1).

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
4. **`/api/parse` on julkinen päätepiste**, jota kuka tahansa voi kutsua.

---

## Salaisuudet

| Arvo | Sijainti | Julkinen? | Huomiot |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | Vercelin ympäristömuuttuja | **EI** | Vain palvelinpuolen `api/parse.js` lukee. Ei koskaan selaimeen. |
| Supabase URL | `index.html` | Kyllä | Julkinen projektin osoite |
| Supabase anon-avain | `index.html` | Kyllä | Suunniteltu julkiseksi. Turva perustuu RLS:ään. |
| Supabase `service_role` | **Ei missään** | **EI KOSKAAN** | Ohittaa RLS:n. Ei saa päätyä repoon, selaimeen eikä `api/`-koodiin. |

### Säännöt

- Salaisuudet eivät koskaan mene versionhallintaan. `.gitignore` estää
  `.env`, `.env.*` ja `*.key`.
- `.env.example` sisältää vain muuttujien **nimet**.
- Tuotannon salaisuudet elävät Vercelin projektiasetuksissa.
- Salaisuuksia ei tallenneta työpöydälle tekstitiedostoihin.
- Testit valvovat tätä automaattisesti: `tests/dom-integrity.test.mjs` hylkää
  buildin, jos lähdekoodista löytyy `sk-ant-`-alkuinen merkkijono tai
  `service_role`.

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

### Todentamaton

**RLS:n nykytilaa tuotannossa ei ole todennettu.** Jos RLS on tällä hetkellä
pois päältä, kuka tahansa internetin käyttäjä voi lukea, muuttaa ja poistaa
kaiken datan julkisesti näkyvillä tiedoilla. Tämä on projektin vakavin avoin
riski, kunnes `supabase/inventory.sql` on ajettu.

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
```

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

### Tunnetut puutteet

| Puute | Vaikutus | Korjaus |
|---|---|---|
| `/api/parse` ei vaadi autentikaatiota | Kuka tahansa voi kuluttaa Anthropic-kiintiötä | WP2: Supabase-JWT:n tarkistus |
| Ei pyyntökohtaista rate limitiä | Väärinkäytön kustannus | WP2 |
| Ei kustannusseurantaa | Kulutus ei näy | WP2 |

---

## Muut tunnetut riskit

| # | Riski | Tila |
|---|---|---|
| 1 | RLS-tila tuotannossa todentamaton | **Avoin — korkein prioriteetti** |
| 2 | Anthropic-avain selkokielisenä työpöytätiedostossa | Avoin — kierrätysohje `docs/DEPLOYMENT.md` |
| 3 | Poisto ilman vahvistusta | Avoin — WP3 |
| 4 | Kantavirheet vain `console.error`-lokiin, ei näy käyttäjälle | Osin korjattu (profiilin tallennus näyttää virheen), loput WP3 |
| 5 | Ei datan vientiä eikä tilin poistoa (konsepti luku 24 vaatii) | Avoin — WP:n mukaan |
| 6 | Ei service workeria, ei offline-tukea | Avoin — WP6 |

---

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
