# Kehityspolku

Perustuu 31.8.2026 tehtyyn tilannekartoitukseen ja konseptidokumenttiin
"MANIFESTIVAL – KOKONAISKUVAUS" (v1.0, 23.7.2026).

Tämä tiedosto ei määrittele uusia tuotevaatimuksia. Se järjestää
konseptidokumentissa jo määritellyt ominaisuudet toteutusjärjestykseen.

---

## Toteutustilanne

Konseptidokumentin luvun 29 MVP-katalogi, 11 ominaisuutta:

| Ominaisuus | Tila |
|---|---|
| Päivän aikajana | Toimii |
| Puheella lisääminen | Toimii |
| Viikkosuunnittelu | Osittain — ei kuormitusanalyysiä tavoitteisiin |
| Käyttäjäprofiili | Osittain — 7 kenttää, ei elämäntilannetta eikä työaikoja |
| Tehtävärekisteri | Osittain — ei kestoa, määräaikaa, prioriteettia eikä projektia |
| Unirytmi | Osittain — laskenta on, toteutuman kirjaus puuttuu |
| Toistuvat rutiinit | Ei toteutettu — vain yksi kovakoodattu aamurutiini |
| Ilmoitukset | Ei toteutettu |
| Tavoitteet | Ei toteutettu |
| Ravintorutiinit | Ei toteutettu |
| Perustalous | Ei toteutettu — vain kategoria `talous` |

MVP:n valmiusaste on noin **38 %**. Koko konseptin ominaisuuskatalogista
(26 kohtaa: 11 MVP + 9 V2 + 6 Tuleva) on toteutettu noin **17 %**.

Konseptidokumentissa ei ole journalointia, social-ominaisuuksia, julkaisuja,
kommentteja eikä reaktioita. Niitä ei ole myöskään koodissa.

---

## Työpaketit

### WP1 — Kehitysperusta, autentikaatio ja tietoturva ✅ toteutettu

Paikallinen Git-klooni, haaramalli, repo-hygienia, dokumentaatio, testipohja,
Supabase Auth, käyttäjäkohtainen omistajuusmalli, RLS-migraation luonnos,
`/api/parse`-kovennus, automaattisen seed-kirjoituksen poisto.

Avoinna: migraation ajo ja RLS:n todennus vaativat Supabase-dashboardin.

---

### WP2 — Auth-viimeistely ja päätepisteen suojaus

Migraatio 0001 ajetaan ja todennetaan. `/api/parse` alkaa vaatia Supabase-JWT:n.
Rate limit ja kustannusseuranta. Onboarding-virta uudelle käyttäjälle, johon
`src/lib/seed.js` kytketään vapaaehtoiseksi "täytä esimerkkipäivällä"
-toiminnoksi. Salasanan palautus. Tilin poisto ja datan vienti
(konseptin luku 24 vaatii).

Riippuvuus: WP1. Vaatii Supabase-dashboardin.

---

### WP3 — Modularisointi, virheenkäsittely ja testikattavuus

`index.html` jaetaan moduuleiksi suunnitelman mukaan (`docs/ARCHITECTURE.md`).
Keskitetty virheilmoitus: jokainen epäonnistunut kantakutsu näkyy käyttäjälle.
Poiston vahvistus. Testit aikataululogiikalle ennen sen siirtoa.

Riippuvuus: WP1. Ei tietokantamuutoksia.

---

### WP4 — Tehtävämallin laajennus

`duration_minutes`, `deadline`, `priority`, `project_id`, `status`.
Prioriteettijärjestys listoissa. Profiilin laajennus: työajat, elämäntilanne,
rajoitteet. Vastaa konseptin lukua 9.

Riippuvuus: WP3. Tietokantamuutos (additiivinen).

---

### WP5 — Toistuvien rutiinien moottori

`routines`-taulu, toistosäännöt, laajennus näkymään ajon aikana (ei tuhansia
rivejä kantaan), yksittäisen esiintymän ohitus. Korvaa nykyisen kovakoodatun
`virtual-routine`-erikoistapauksen. Vastaa konseptin lukua 9 ja MVP-katalogin
kohtaa "Toistuvat rutiinit".

Riippuvuus: WP4. Uusi taulu + RLS.

---

### WP6 — Service worker, offline ja ilmoitukset

Service worker ja välimuististrategia — nykyinen `index.html` sisältää vain
no-op-paikanpitäjän. Offline-kirjoitusjono. Ilmoituslupa ja aikaperusteiset
muistutukset. Konseptin luvun 23 nelitasoinen ilmoituslogiikka: tieto,
muistutus, toiminta nyt, kriittinen hoputus. Ilmoitusasetukset.

Riippuvuus: WP3, WP5. Rajoite: web push on epäluotettava iOS:llä ja rajoitettu
Androidin taustatilassa — täysi toteutus vaatii WP12:n.

---

### WP7 — Tavoitemoduuli

`goals`-taulu, tavoitenäkymä, välitavoitteet, kytkentä tehtäviin ja rutiineihin,
edistymismittarit. Vastaa konseptin lukua 19. Tavoitteet olivat 27.7.2026
mockupissa mutta poistettiin ensimmäisestä toimivasta versiosta.

Riippuvuus: WP4, WP5.

---

### WP8 — Hyvinvointimoduuli

Oma näkymä. Unen toteutuman kirjaus ja iltarutiini. Ateriat, evässuunnittelu ja
vedenjuonti. Kuormitusnäkymä (vihreä/keltainen/punainen) konseptin luvun 16
mukaan. Mieliala. Vastaa konseptin lukuja 13, 14 ja 16. Hyvinvointi oli
27.7.2026 mockupissa mutta poistettiin.

Riippuvuus: WP4, WP5.

---

### WP9 — Talousmoduuli

Tulot, menot, kuukausibudjetti, laskujen muistutukset, säästötavoitteet.
Vastaa konseptin lukua 20. Ei sijoitussuosituksia — konseptin luku 20 rajaa ne
nimenomaisesti pois ilman asianmukaista sääntelyä.

Riippuvuus: WP4.

---

### WP10 — Älykäs aikataulutus

Vapaan ajan etsintä, tehtävien automaattinen sijoittelu, uudelleenjärjestely
viiveiden jälkeen, perustellut ehdotukset. Vastaa konseptin lukuja 9 ja 22 sekä
V2-katalogin kohtia "Älykäs aikaehdotus" ja "Automaattinen uudelleenjärjestely".

Riippuvuus: WP4, WP5, WP7.

---

### WP11 — Sijainti ja lähtöajan ennakointi

Sijaintilupa, tapahtumien osoitteet, matka-ajan arvio, valmistautumisaika,
"sinun pitää lähteä nyt" -logiikka. Vastaa konseptin lukua 12. Nykyisin vain
staattinen `commuteMinutes`-vakio profiilissa.

Riippuvuus: WP6. Osa vaatii WP12:n.

---

### WP12 — Natiivi mobiilikerros (Capacitor)

Capacitor-käärintä nykyisen web-koodin ympärille. Taustatoiminta, natiivi
puheentunnistus, luotettavat ilmoitukset, taustasijainti. Mahdollistaa
konseptin V2-lupaukset, joita selain ei pysty toteuttamaan.

Ratkaisu on Capacitor eikä React Native: Capacitor kääriin olemassa olevan
web-koodin sellaisenaan, kun taas React Native vaatisi täyden
uudelleenkirjoituksen.

Riippuvuus: WP3, WP6. **Ainoa työpaketti, joka vaatii fyysisen laitetestin.**

---

## Myöhemmät vaiheet

Konseptin luvun 26 vaiheet 5–8 ja luvun 29 "Tuleva"-tason ominaisuudet:
terveystietojen koonti, laiteintegraatiot, laajempi talous ja sijoitukset,
perhetila, yrittäjätila, selittävä tekoälyavustaja, kaupallistaminen.

Näitä ei ole aikataulutettu. Ne edellyttävät, että MVP on ensin todistetusti
hyödyllinen päivittäisessä käytössä.
