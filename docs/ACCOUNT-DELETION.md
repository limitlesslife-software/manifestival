# Tilin poisto ja datan omistajuus

**TILA: PAIKALLINEN TOTEUTUS VALMIS JA TESTATTU, EI DEPLOYATTU.**
Palvelinfunktio (`supabase/functions/delete-account`) ja koko
vahvistusvirta on toteutettu, mutta funktiota ei ole otettu käyttöön,
joten sovellus ei väitä poistoa mahdolliseksi
(`ACCOUNT_DELETION.endpointEnabled = false`, `src/data/config.js`).

Vienti: `src/domain/dataExport.js` — **IMPLEMENTED**
Tilin poisto: **COMPLETE_LOCAL, EI KÄYTÖSSÄ TUOTANNOSSA** (omistajan
päätökset ja kontrolloitu käyttöönotto puuttuvat, ks. alla)

---

## Periaate

Tieto on käyttäjän, ei sovelluksen. Jos sovelluksesta ei pääse ulos, se ei
ole työkalu vaan ansa. Konseptidokumentin luku 24 vaatii sekä viennin että
poiston.

Näistä **vienti on toteutettu**, poisto ei — ja ero on kerrottava
käyttäjälle suoraan.

---

## Vienti (IMPLEMENTED)

`buildUserDataExport()` on puhdas kokoaja: ottaa datan, palauttaa
versioidun vientiolion.

```json
{
  "kind": "manifestival-export",
  "manifestivalExportVersion": 1,
  "exportedAt": "2026-09-02T10:00:00.000Z",
  "counts": { "tasks": 128, "goals": 4, "bills": 12 },
  "data": { "tasks": [...], "goals": [...] }
}
```

Kattaa 12 tietotyyppiä **nimenomaisena listana** eikä johdettuna tilasta:
uusi tilakenttä ei päädy vientiin vahingossa.

### Mitä ei viedä — eikä missään olosuhteissa

```
API-avaimet · istunto- ja refresh-tokenit · salasanat ja tiivisteet
Supabase-avaimet · user_id · sisäiset autentikaatiokentät
```

Vienti on tiedosto, joka päätyy latauskansioon, pilveen ja mahdollisesti
sähköpostiin. Salaisuus siinä olisi salaisuus kaikkialla.

Suodatus tehdään **nimen perusteella koko puusta rekursiivisesti**, ei
tyyppikohtaisesti: jos jokin tuleva rivi kantaa tokenia, se putoaa pois
ilman että kukaan muistaa lisätä sääntöä. Testi myrkyttää datan jokaisella
kielletyllä kentällä eri syvyyksissä.

---

## Tuonti (PARSE + VALIDATE + PREVIEW)

Tuonti **ei kirjoita mitään** tässä aallossa.

```
tiedosto → jäsennys → versiotarkistus → rakennetarkistus
        → esikatselu → konfliktianalyysi → [käyttäjän vahvistus] → kirjoitus
                                            ↑ tähän asti toteutettu
```

Uudempaa vientiversiota **ei yritetä arvata**: se voi sisältää rakenteita,
joita tämä versio ei ymmärrä, ja arvaaminen turmelisi käyttäjän tiedot.

Massakirjoitus ilman konfliktimallia olisi paras tapa tuhota olemassa oleva
data yhdellä väärällä tiedostolla. Siksi kirjoitusvaihe on tietoisesti
lykätty.

---

## Tilin poisto (COMPLETE_LOCAL, ei deployattu)

### Arkkitehtuuri

Korotettu oikeus elää **vain Supabase Edge Functionissa**
(`supabase/functions/delete-account`). Se ei ole selaimessa, ei Vercelin
`api/`-hakemistossa eikä repositoriossa: Supabase injektoi avaimen
funktion ympäristöön ajohetkellä. Testit lukitsevat tämän
(`tests/account-deletion-inventory.test.mjs`).

```
selain: esikatselu -> varoitus -> sähköposti + "POISTA TILINI" ->
        lopullinen dialogi -> POST /functions/v1/delete-account
funktio: JWT -> auth.getUser (käyttäjä johdetaan tokenista) ->
         vahvistus + tuore kirjautuminen -> auth.admin.deleteUser ->
         jälkitarkistus rivimääristä
selain: clearLocalUserData + signOut + päätetila
```

- Käyttäjän tunniste tulee **vain tokenista**. Rungossa oleva `userId`,
  `user_id` ym. hylätään (400 `unexpected_field`).
- Poisto vaatii täsmälleen oman sähköpostin ja vahvistuslauseen sekä
  kirjautumisen 15 minuutin sisällä (`recent_login_required` muuten).
- Virheet ovat vakiokoodeja; Supabasen viestiä, avaimia, tokeneita tai
  sähköpostia ei palauteta eikä lokiteta.
- CORS on suljettu oletuksena; sallitut originit asetetaan
  `DELETE_ACCOUNT_ALLOWED_ORIGINS`-salaisuudella.

### Poistojärjestys: yksi atominen kaskadi, ei käsin kirjoitettu lista

Aiempi suunnitelma (rivikohtaiset DELETE-lauseet järjestyksessä) on
**korvattu**. Jokaisen käyttäjätaulun omistajasarake viittaa
`auth.users(id)` ... `on delete cascade`, joten yksi `auth.admin.deleteUser`
poistaa kaikki 20 taulua yhdessä tietokantatransaktiossa. Erilliset
PostgREST-DELETE:t olisivat ei-atomisia ja jättäisivät puolikkaan tilin,
jos yksi epäonnistuisi.

Kaskadi **todistetaan**, ei oleteta:
`tests/account-deletion-inventory.test.mjs` jäsentää migraatiot ja
vaatii, että (1) jokainen viennin kokoelma on kartassa (`ACCOUNT_DATA_MAP`),
(2) jokainen kartan taulu kaskadoituu omistajasarakkeellaan ja (3)
skeemassa ei ole käyttäjätaulua, jota kartta ei tunne. Uusi taulu, jota
inventaario ei tunne, kaataa testin.

Funktio tekee poiston jälkeen rivimäärätarkistuksen ja raportoi
`complete: false` (+ `residual`/`unverified`), jos jotain jäi — se ei
väitä täydellistä onnistumista, jota ei ole varmistettu.

### Mitä EI ole päätetty (OMISTAJAN PÄÄTÖS)

`aiAudit` (AI-toimintoloki) poistuu nyt tilin mukana (`delete-with-account`,
`RETENTION_DECISIONS`). Jos lakisääteinen tai turvallisuusperusteinen
säilytysvelvoite todetaan, poikkeus vaatii skeemamuutoksen (FK ei saa
kaskadoitua) — sitä ei ole toteutettu, eikä oletus ole hiljainen.

### Käyttöönotto (ei suoritettu)

Ks. `supabase/functions/README.md`: säilytyspäätös, deploy, origin-lista,
kontrolloitu testi kertakäyttöisellä testitilillä, vasta sitten
`endpointEnabled = true`.

### Mitä poisto EI saa tehdä

- Ei saa jättää dataa "arkistoituna" ja väittää poistaneensa sen
- Ei saa kestää päiviä ilman että käyttäjälle kerrotaan
- Ei saa vaatia tukipyyntöä
- Ei saa poistaa vain istuntoa ja jättää rivit kantaan

---

## Paikallinen tyhjennys (IMPLEMENTED)

Tämä on eri asia kuin tilin poisto, ja se **on** toteutettu.

`clearLocalUserData()` tyhjentää repositorioiden muistivarastot ja
muistutusasetukset. Se ajetaan:

- uloskirjautumisessa
- **tilinvaihdossa ilman uloskirjautumista** (`USER_SWITCHED`)

Ilman tätä seuraava käyttäjä näkisi edellisen rutiinit ja tavoitteet
samalla selaimella. Molemmat reitit ovat regressiotestattuja —
kumpikin oli aiemmin todellinen vuoto.

---

## Tila

| Osa | Tila |
|---|---|
| Datan vienti | **IMPLEMENTED** |
| Salaisuuksien suodatus viennistä | **IMPLEMENTED**, testattu |
| Tuonnin jäsennys ja esikatselu | **IMPLEMENTED** |
| Tuonnin kirjoitus | **PLANNED** — vaatii konfliktimallin |
| Paikallisen datan tyhjennys | **IMPLEMENTED** |
| Inventaario + kaskadin todistus | **COMPLETE_LOCAL** |
| Edge Function (lähdekoodi, testit) | **COMPLETE_LOCAL** |
| Poiston käyttöliittymä ja vahvistusvirta | **COMPLETE_LOCAL** (DOM-osuus laitteella todentamatta) |
| Edge Functionin deploy ja tuotantoaktivointi | **BLOCKED_EXTERNAL_DECISION** |
| aiAudit-säilytyslinjaus | **BLOCKED_EXTERNAL_DECISION** |
