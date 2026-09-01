# Kehityspolku

Perustuu 31.8.2026 tehtyyn tilannekartoitukseen ja konseptidokumenttiin
"MANIFESTIVAL – KOKONAISKUVAUS" (v1.0, 23.7.2026). Päivitetty 1.9.2026 (WP2).

Tämä tiedosto ei määrittele uusia tuotevaatimuksia. Se järjestää
konseptidokumentissa jo määritellyt ominaisuudet toteutusjärjestykseen.

---

## Toteutustilanne

Konseptidokumentin luvun 29 MVP-katalogi, 11 ominaisuutta:

| Ominaisuus | Ennen WP1 | Nyt | Mitä puuttuu |
|---|---|---|---|
| Päivän aikajana | Toimii | **Toimii** | — |
| Puheella lisääminen | Toimii | **Toimii** | automaattitallennus ilman vahvistusta |
| Viikkosuunnittelu | Osittain | **Osittain** | kuormitusanalyysi tavoitteisiin |
| Tehtävärekisteri | Osittain | **Osittain** | määräaika, projekti; kentät eivät vielä tallennu |
| Käyttäjäprofiili | Osittain | **Osittain** | elämäntilanne, työajat, rajoitteet |
| Unirytmi | Osittain | **Osittain** | toteutuman kirjaus, iltarutiini |
| Ilmoitukset | Ei | **Ei** | koko järjestelmä (sovitin valmiina) |
| Toistuvat rutiinit | Ei | **Ei** | toistomoottori |
| Tavoitteet | Ei | **Ei** | koko moduuli |
| Ravintorutiinit | Ei | **Ei** | koko moduuli |
| Perustalous | Ei (kategoria) | **Ei (kategoria)** | tulot, menot, budjetti |

**MVP:n valmiusaste ~45 %** (oli 38 %). Koko konseptin ominaisuuskatalogista
(26 kohtaa: 11 MVP + 9 V2 + 6 Tuleva) noin **23 %** (oli 17 %).

Nousu tulee tehtävädomainin laajennuksesta, aikatauluehdotuksista, AI-polun
kovennuksesta ja puheohjauksen parannuksista — ei uusista moduuleista.
Neljä MVP-ominaisuutta on yhä nollalla.

Konseptidokumentissa ei ole journalointia, social-ominaisuuksia, julkaisuja,
kommentteja eikä reaktioita. Niitä ei ole myöskään koodissa.

---

## Työpaketit

### WP7-WP12 — tuote päivän ympärille (toteutettu)

Päivä lakkasi olemasta irrallinen. Ketju tavoitteesta muistutukseen on
olemassa kokonaisuudessaan, vaikka osa lenkeistä on vielä kevyitä.

| Alue | Tila |
|---|---|
| Rutiinit: toistosäännöt, poikkeukset, koko hallinta | Toteutettu |
| Tavoitteet: edistyminen, tilat, oma välilehti | Toteutettu |
| Projektit | Domain, ei näkymää |
| Määräajat ja myöhässä olevat | Toteutettu |
| Scheduler V3: rutiinit ja kiireellisyys mukaan | Toteutettu |
| Muistutusten suunnittelu ja eskalaatio | Toteutettu |
| Muistutusten ajastus Androidilla | Toteutettu (Capacitor Local Notifications) |
| AI-komentoputki ja turvamalli | Toteutettu; käyttöliittymässä vain luonti |
| Päivä- ja viikkonäkymä V2, katsaukset | Toteutettu |
| Hyvinvointi ja kuormitusehdotus | Toteutettu |
| Laskut ja toistuvat kulut | Domain, ei näkymää eikä tallennusta |
| Sijoitusseuranta | Vain arkkitehtuuridokumentti |

**Kaikki uusi tallennus on migraatioportin takana.** Migraatiot 0003-0006 on
kirjoitettu muttei ajettu. Siihen asti tieto elää istunnon muistissa ja
käyttöliittymä kertoo sen käyttäjälle.

---

### WP1 — Kehitysperusta, autentikaatio ja tietoturva ✅ toteutettu

Paikallinen Git-klooni, haaramalli, repo-hygienia, dokumentaatio, testipohja
(64 testiä), Supabase Auth, käyttäjäkohtainen omistajuusmalli, RLS-migraation
luonnos, `/api/parse`-kovennus, automaattisen seed-kirjoituksen poisto.

---

### WP2 — Modularisointi, tehtävädomain ja päätepisteen suojaus ✅ toteutettu

- `index.html` 1 154 → 250 riviä. Kaikki logiikka moduuleiksi, kerrosrajat
  testattu (`docs/MODULARIZATION.md`)
- Puhdas aikataulumoottori: herätys, uni, vapaat välit, deterministiset
  ehdotukset
- Tehtävädomain: prioriteetti, kesto, kuvaus, aikataulutuksen tila
- Optimistinen päivitys **peruutuksella** — UI ei enää valehtele
  onnistumisesta
- Poiston vahvistus, lomakevalidointi, tuplaklikkaussuoja, saavutettavuus
- `/api/parse`: kirjautuminen vaaditaan, pyyntörajoitin, AI-vastauksen
  tiukka validointi
- Service worker: sovelluskuori offline
- Alustasovittimet ja Capacitor-pohja, ensimmäinen APK
- Testit 64 → 282
- Migraatio 0002 valmisteltu (ei ajettu)

**Avoinna:** migraatiot 0001 ja 0002 vaativat Supabase-dashboardin.

---

### WP3 — Migraatioiden ajo ja tuotantoon vienti

Ensimmäinen paketti, joka **koskee tuotantoa**. Ei uusia ominaisuuksia.

- Aja `supabase/inventory.sql`, todenna skeema ja RLS-tila
- Aja migraatio 0001 (omistajuus + RLS), todenna
- Aja migraatio 0002 (domain-kentät), aseta `TASK_EXTENDED_FIELDS = true`
- Kierrätä Anthropic-avain, poista työpöydän selkokielinen tiedosto
- Julkaise `develop` → `main` oikeassa järjestyksessä
- Todenna tuotannossa: kirjautuminen, oma data, puheohjaus, offline

Riippuvuus: WP2. **Vaatii Supabase- ja Vercel-dashboardin.**

---

### WP4 — Tehtävämallin viimeistely

`deadline`, `project_id`, `status`. Määräaikojen näyttö ja järjestys.
Profiilin laajennus: työajat, elämäntilanne, rajoitteet. Vastaa konseptin
lukua 9. Prioriteetti, kesto ja kuvaus ovat jo WP2:ssa.

Riippuvuus: WP3. Tietokantamuutos (additiivinen).

---

### WP5 — Toistuvien rutiinien moottori

`routines`-taulu, toistosäännöt, laajennus näkymään ajon aikana (ei tuhansia
rivejä kantaan), yksittäisen esiintymän ohitus. Korvaa nykyisen kovakoodatun
`virtual-routine`-erikoistapauksen yleisellä moottorilla.

Riippuvuus: WP4. Uusi taulu + RLS.

---

### WP6 — Ilmoitukset ja muistutukset

Ilmoituslupa, aikaperusteiset muistutukset, konseptin luvun 23 nelitasoinen
logiikka (tieto / muistutus / toiminta nyt / kriittinen hoputus),
ilmoitusasetukset. Sovitinrajapinta on jo olemassa (`src/platform/`).

Rajoite: web push on epäluotettava. **Luotettava toteutus vaatii WP12:n.**
Web-toteutus tehdään ensin, koska se kattaa etualalla olevan käytön.

Riippuvuus: WP3, WP5.

---

### WP7 — Tavoitemoduuli

`goals`-taulu, tavoitenäkymä, välitavoitteet, kytkentä tehtäviin ja rutiineihin,
edistymismittarit. Vastaa konseptin lukua 19. Tavoitteet olivat 27.7.2026
mockupissa mutta poistettiin ensimmäisestä toimivasta versiosta.

Riippuvuus: WP4, WP5.

---

### WP8 — Hyvinvointimoduuli

Oma näkymä. Unen toteutuman kirjaus ja iltarutiini. Ateriat, evässuunnittelu ja
vedenjuonti. Kuormitusnäkymä konseptin luvun 16 mukaan. Mieliala.
Vastaa konseptin lukuja 13, 14 ja 16.

Riippuvuus: WP4, WP5.

---

### WP9 — Talousmoduuli

Tulot, menot, kuukausibudjetti, laskujen muistutukset, säästötavoitteet.
Vastaa konseptin lukua 20. Ei sijoitussuosituksia — konseptin luku 20 rajaa ne
nimenomaisesti pois ilman asianmukaista sääntelyä.

Riippuvuus: WP4.

---

### WP10 — Älykäs uudelleenjärjestely

Suunnitelman päivitys viiveiden jälkeen, tehtävien siirto päivien välillä,
perustellut ehdotukset laajemmin. Vapaan ajan etsintä ja perussijoittelu ovat
jo WP2:ssa.

Riippuvuus: WP4, WP5, WP7.

---

### WP11 — Sijainti ja lähtöajan ennakointi

Sijaintilupa, tapahtumien osoitteet, matka-ajan arvio, valmistautumisaika,
"sinun pitää lähteä nyt" -logiikka. Vastaa konseptin lukua 12. Nykyisin vain
staattinen `commuteMinutes`-vakio profiilissa.

Riippuvuus: WP6. Osa vaatii WP12:n.

---

### WP12 — Natiivikerroksen toteutus

`src/platform/capacitor.js`: natiivi puheentunnistus, ajastetut ilmoitukset,
taustasijainti. Android-projekti ja APK-koonti ovat jo WP2:ssa.

Ratkaisu on Capacitor eikä React Native — perustelut `docs/ANDROID-STRATEGY.md`.

Riippuvuus: WP6. **Ainoa työpaketti, joka vaatii fyysisen laitetestin.**

---

### WP13 — Offline-synkronointi

Muutosloki, palvelinpuolen aikaleimat, konfliktisääntö per kenttä, näkyvä
synkronointitila. Vaatimukset on kuvattu `docs/ARCHITECTURE.md`:ssä.

Tätä **ei tehdä sivutuotteena**. Offline-kirjoitus ilman konfliktimallia on
vaarallisempi kuin sen puuttuminen.

Riippuvuus: WP4, WP12.

---

## Myöhemmät vaiheet

Konseptin luvun 26 vaiheet 5–8 ja luvun 29 "Tuleva"-tason ominaisuudet:
terveystietojen koonti, laiteintegraatiot, laajempi talous ja sijoitukset,
perhetila, yrittäjätila, selittävä tekoälyavustaja, kaupallistaminen.

Näitä ei ole aikataulutettu. Ne edellyttävät, että MVP on ensin todistetusti
hyödyllinen päivittäisessä käytössä.
