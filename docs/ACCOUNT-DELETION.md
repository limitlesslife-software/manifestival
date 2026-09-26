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

Vienti on käytössä. Poisto on toteutettu ja testattu paikallisesti, mutta
ei käytössä ennen kontrolloitua käyttöönottoa — ja se kerrotaan
käyttäjälle suoraan: poistopainike on pois päältä ja syy näkyy sen alla.

---

## Mitä tiliin kuuluu

Yksi luettelo ohjaa kaikkea: `EXPORTED_COLLECTIONS`
(`src/domain/dataExport.js`). Poistokartta `ACCOUNT_DATA_MAP`
(`src/domain/accountLifecycle.js`) ja sen Edge Function -kopio
(`supabase/functions/_shared/accountInventory.js`) kattavat täsmälleen
saman listan — testi vaatii sen.

Tili kattaa **26 tietotyyppiä**, jokainen omassa taulussaan:

| Kokoelma | Taulu | Omistajasarake | Luotu |
|---|---|---|---|
| `tasks` | `tasks` | `user_id` | lähtötila, omistaja 0001 |
| `profile` | `profile` | `id` | lähtötila, omistaja 0001 |
| `routines` | `routines` | `user_id` | 0003 |
| `routineExceptions` | `routine_exceptions` | `user_id` | 0003 |
| `goals` | `goals` | `user_id` | 0004 |
| `projects` | `projects` | `user_id` | 0004 |
| `notificationPreferences` | `notification_preferences` | `id` | 0005 |
| `wellbeing` | `wellbeing_entries` | `user_id` | 0006 |
| `recurringExpenses` | `recurring_expenses` | `user_id` | 0007 |
| `bills` | `bills` | `user_id` | 0007 |
| `savingsGoals` | `savings_goals` | `user_id` | 0007 |
| `aiAudit` | `ai_action_audit` | `user_id` | 0008 |
| `transactions` | `transactions` | `user_id` | 0009 |
| `investments` | `investments` | `user_id` | 0009 |
| `milestones` | `milestones` | `user_id` | 0010 |
| `inboxItems` | `inbox_items` | `user_id` | 0011 |
| `reminders` | `reminders` | `user_id` | 0011 |
| `notices` | `notices` | `user_id` | 0011 |
| `travelPlans` | `travel_plans` | `user_id` | 0011 |
| `locationRules` | `location_rules` | `user_id` | 0011 |
| `lifeAreas` | `life_areas` | `user_id` | 0012 |
| `weeklyCapacities` | `weekly_capacities` | `user_id` | 0012 |
| `timeEntries` | `time_entries` | `user_id` | 0012 |
| `alignmentReviews` | `alignment_reviews` | `user_id` | 0012 |
| `runningTimers` | `running_timers` | `user_id` | 0013 |
| `alignmentItemSettings` | `alignment_item_settings` | `user_id` | 0013 |

Tallennettuja tiedostoja ei ole (`STORED_FILE_CATEGORIES = []`): kuitin
kuvaa ei tallenneta minnekään.

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

Kattaa kaikki 26 tietotyyppiä **nimenomaisena listana** eikä johdettuna
tilasta: uusi tilakenttä ei päädy vientiin vahingossa.

- Profiili viedään vain, jos käyttäjä on tallentanut sen (`profileExists`).
  Tilan oletusarvot eivät ole käyttäjän tietoa.
- `tests/account-export-columns.test.mjs` lukee jokaisen taulun sarakkeet
  migraatioista ja vaatii, että jokainen päätyy vientiin repositorion
  `fromRow`:n kautta. Poikkeukset on lueteltu perusteluineen
  (`ALLOWED_OMISSIONS`: kannan omat aikaleimat muutamassa taulussa,
  käyttämättömät `profile`-sarakkeet ja korjauksen alla olevat
  `tasks.deadline/goal_id/project_id`).

### Mitä ei viedä — eikä missään olosuhteissa

```
API-avaimet · istunto- ja refresh-tokenit · salasanat ja tiivisteet
Supabase-avaimet · user_id · sisäiset autentikaatiokentät · koordinaatit
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
selain:  esikatselu (palvelimen kuiva-ajo) -> varoitus
         -> sähköposti + "POISTA TILINI" -> lopullinen dialogi
         -> POST /functions/v1/delete-account
funktio: JWT -> auth.getUser (käyttäjä johdetaan tokenista)
         -> vahvistus + tuore kirjautuminen -> auth.admin.deleteUser
         -> jälkitarkistus rivimääristä (residual / unverified / absent)
selain:  1. offline.purge                 offline-jonon muistikopio
         2. purgeDeviceDataForUser        laitteen tallennus (ks. Laitteen tila)
         3. cancelDeviceNotifications     ajastetut + toimitetut muistutukset,
                                          odotetaan enintään 3 s
         4. queueAuthNote                 päätetila kirjautumisporttiin
         5. signOut({ scope: 'local' })   -> SIGNED_OUT -> onSignedOut
            virhe tai poikkeus            -> forceLocalSignOut + uudelleenlataus
```

- Käyttäjän tunniste tulee **vain tokenista**. Rungossa oleva `userId`,
  `user_id` ym. hylätään (400 `unexpected_field`).
- Poisto vaatii täsmälleen oman sähköpostin ja vahvistuslauseen sekä
  kirjautumisen 15 minuutin sisällä (`recent_login_required` muuten).
- Virheet ovat vakiokoodeja; Supabasen viestiä, avaimia, tokeneita tai
  sähköpostia ei palauteta eikä lokiteta.
- CORS on suljettu oletuksena; sallitut originit asetetaan
  `DELETE_ACCOUNT_ALLOWED_ORIGINS`-salaisuudella.
- **Uloskirjautumisen varapolku.** supabase-js ei heitä verkkovirheessä
  vaan palauttaa `{ error }`, jättää istunnon laitteelle eikä laukaise
  SIGNED_OUT-tapahtumaa. Tili on silloin jo poistettu palvelimelta, joten
  `forceLocalSignOut()` tekee saman siivouksen kuin `onSignedOut`
  (käyttäjä, offline-jono, muistivarastot, laiteasetukset, tila), poistaa
  istuntoavaimen `sb-<projekti>-auth-token` ja lataa sivun uudelleen.

### Poistojärjestys: yksi atominen kaskadi, ei käsin kirjoitettu lista

Aiempi suunnitelma (rivikohtaiset DELETE-lauseet järjestyksessä) on
**korvattu**. Jokaisen käyttäjätaulun omistajasarake viittaa
`auth.users(id)` ... `on delete cascade`, joten yksi `auth.admin.deleteUser`
poistaa kaikki **26 taulua** yhdessä tietokantatransaktiossa. Erilliset
PostgREST-DELETE:t olisivat ei-atomisia ja jättäisivät puolikkaan tilin,
jos yksi epäonnistuisi. Taulujen väliset viiteet ovat CASCADE
(`routine_exceptions` → `routines`, `milestones` → `goals`) tai SET NULL;
yksikään ei ole RESTRICT/NO ACTION, joten järjestyksellä ei ole väliä.

Funktio laskee poiston jälkeen rivit uudelleen ja palauttaa
`complete: false` (+ `residual` / `unverified`), jos jotain jäi tai
laskenta epäonnistui — se ei väitä täydellistä onnistumista, jota ei ole
varmistettu.

### Puuttuvat taulut (tuotanto ennen aaltoa J)

Tuotanto etenee aalloittain. Aallolla C kannassa on 12 taulua (lähtötila ja
migraatiot 0001–0008); migraatioiden 0009–0013 14 taulua puuttuvat vielä.

- Funktio tunnistaa puuttuvan taulun PostgRESTin koodista `PGRST205`
  (vanhempi `42P01`) tai HEAD-pyynnön 404:stä, jonka postgrest-js palauttaa
  muodossa `error: null, count: null, status: 204`. Kokoelma raportoidaan
  `present: false`, `rowCount: 0` ja `absent`-listassa.
- Puuttuva taulu **ei estä** `complete: true` -tulosta: siinä ei voi olla
  rivejä, ja jos se luodaan myöhemmin, FK-kaskadi poistaa rivit kannassa.
- Muu virhe tai puuttuva määrä on `count_failed` (varmistamaton), ei
  koskaan hiljainen nolla. Jos yhtäkään taulua ei näy, "puuttuu" ei
  kelpaa (yhteysvika): kaikki ovat varmistamattomia.
- Esikatselu näyttää laskemattoman kokoelman "ei voitu laskea" ja
  puuttuvat "ei käytössä tässä tietokannassa"; osittainen summa on
  "vähintään N riviä". Mitään ei pudoteta pois.

### Kaskadin todistus

Kaskadi **todistetaan kahdesti**, ei oleteta:

1. **Migraatioista** (`tests/account-deletion-inventory.test.mjs`,
   jäsennin `tests/helpers/migrationSchema.mjs`): (1) jokainen viennin
   kokoelma on kartassa, (2) jokainen migraatioiden `CREATE TABLE` on
   luokiteltu — poistokartassa tai perustellusti vapautettu
   (`NON_USER_TABLES`: vain 0001:n ja 0002:n väliaikaiset parametritaulut),
   (3) jokainen viittaus `auth.users`-tauluun on `ON DELETE CASCADE` ja
   (4) kaskadoituvat taulut ovat täsmälleen kartan 26 taulua
   omistajasarakkeineen. Jäsennin tunnistaa myös muut kirjoitustavat
   (isot kirjaimet, `if not exists`, taulutason FOREIGN KEY, ALTER-viite),
   ja negatiiviset näytteet lukitsevat sen.
2. **Oikealla PostgreSQL 17:llä** (`tools/pg-rehearsal`, skenaario
   `lifecycle`): migraatiot 0001–0013 ajetaan, jokaiseen tauluun
   siemennetään kahden käyttäjän rivit, toisen `auth.users`-rivi
   poistetaan, ja jokaisesta `public`-taulusta tarkistetaan, ettei hänen
   rivejään jää (`account_delete_cascades_all_tables`) ja että toisen
   käyttäjän rivit säilyvät. Ajo: `node tools/pg-rehearsal/rehearse.mjs`
   (ks. `tools/pg-rehearsal/README.md`); PostgREST-kerros ei ole mukana.

### Mitä EI ole päätetty (OMISTAJAN PÄÄTÖS)

- `aiAudit` (AI-toimintoloki) poistuu nyt tilin mukana
  (`delete-with-account`, `RETENTION_DECISIONS`). Jos lakisääteinen tai
  turvallisuusperusteinen säilytysvelvoite todetaan, poikkeus vaatii
  skeemamuutoksen (FK ei saa kaskadoitua) — sitä ei ole toteutettu, eikä
  oletus ole hiljainen.
- Uloskirjautuminen jättää lähettämättömät muutokset (offline-jono ja
  aikakirjausten lähtökori, myös muistiinpanot) laitteelle, jotta ne
  lähtevät kun sama käyttäjä palaa. Onko se hyväksyttävää jaetulla
  laitteella, vai tarjotaanko uloskirjautuessa "hylkää lähettämättömät"?

### Käyttöönotto (ei suoritettu)

Ks. `supabase/functions/README.md`: säilytyspäätös, deploy, origin-lista,
kontrolloitu testi kertakäyttöisellä testitilillä (aallon J alapuolella
kuiva-ajon `absent`-lista ei ole tyhjä — vertaa se ajettuihin
migraatioihin), vasta sitten `endpointEnabled = true`.

### Mitä poisto EI saa tehdä

- Ei saa jättää dataa "arkistoituna" ja väittää poistaneensa sen
- Ei saa kestää päiviä ilman että käyttäjälle kerrotaan
- Ei saa vaatia tukipyyntöä
- Ei saa poistaa vain istuntoa ja jättää rivit kantaan
- Ei saa jättää poistetun tilin dataa tai muistutuksia laitteelle

---

## Laitteen tila

Kaikki, mitä sovellus tallentaa laitteen selaintallennukseen, on yhdessä
rekisterissä: `DEVICE_STORAGE` (`src/data/deviceData.js`).
`tests/account-device-data.test.mjs` käy läpi koko `src/`-hakemiston ja
kaatuu, jos jokin moduuli tallentaa avaimella tai käyttää
selaintallennusta ilman rekisterimerkintää.

| Avain (etuliite) | Sisältö | Uloskirjautuminen | Tilin poisto |
|---|---|---|---|
| `manifestival.offlineQueue.v1.<käyttäjä>` | Lähettämättömät tehtävämuutokset | säilyy | poistetaan |
| `manifestival.timer.v1.<käyttäjä>` | Käynnissä olevan ajastimen aikaleimat ja kohteen tunniste | säilyy | poistetaan |
| `manifestival.timeOutbox.v1.<käyttäjä>` | Lähettämättömät aikakirjaukset (myös muistiinpano) | säilyy | poistetaan |
| `manifestival.timerTombstones.v1.<käyttäjä>` | Poistettujen ajastimien tunnisteet | säilyy | poistetaan |
| `manifestival:<asetus>` | Laitekohtaiset asetukset (`DEVICE_DEFAULTS`) | tyhjennetään | tyhjennetään |
| `__manifestival_probe__` | Tallennuskokeilu, kirjoitetaan ja poistetaan heti | — | — |
| `sb-<projekti>-auth-token` | supabase-js:n istunto | supabase-js poistaa | supabase-js poistaa; varapolulla `clearAuthSession()` |

Käyttäjäkohtaiset avaimet säilyvät uloskirjautumisen yli tarkoituksella:
lähettämättömät muutokset lähtevät, kun sama käyttäjä kirjautuu takaisin.
Avain ja sisältö ovat käyttäjäkohtaisia, joten toinen käyttäjä ei osu
niihin. Tilin poisto poistaa ne (`purgeDeviceDataForUser`), koska tiliä,
jolle ne lähetettäisiin, ei enää ole.

Muu laitteen tila:

- **Natiivimuistutukset (Android).** Ajastetut ilmoitukset elävät
  käyttöjärjestelmässä sovelluksesta riippumatta ja sisältävät tehtävien
  otsikoita. `cancelDeviceNotifications()` peruu ajastetut ja poistaa jo
  toimitetut ilmoitusalueelta: uloskirjautuessa odottamatta, tilin
  poistossa odottaen (enintään 3 s) ennen uloskirjautumista.
- **Muistissa elävä tila** (tilan kokoelmat, repositorioiden
  muistivarastot, offline-jonon muistikopio, sijainti, avoimet lomakkeet)
  tyhjennetään uloskirjautuessa (`onSignedOut`) ja katoaa joka tapauksessa
  uudelleenlatauksessa.
- **Service worker** ei tallenna Supabasen eikä `/api`-rajapinnan
  vastauksia välimuistiin; välimuistissa on vain sovelluskuori.
- **Android-kuori** ei tallenna mitään omaa natiivitallennukseen.

### Paikallinen tyhjennys (IMPLEMENTED)

`clearLocalUserData()` tyhjentää repositorioiden muistivarastot ja
muistutusasetukset. Se ajetaan:

- uloskirjautumisessa
- **tilinvaihdossa ilman uloskirjautumista** (`USER_SWITCHED`)
- tilin poiston varapolulla (`forceLocalSignOut`)

Ilman tätä seuraava käyttäjä näkisi edellisen rutiinit ja tavoitteet
samalla selaimella. Molemmat pääreitit ovat regressiotestattuja —
kumpikin oli aiemmin todellinen vuoto.

---

## Tila

| Osa | Tila |
|---|---|
| Datan vienti | **IMPLEMENTED** |
| Viennin sarakekattavuus | **IMPLEMENTED**, testattu (`tests/account-export-columns.test.mjs`) |
| Salaisuuksien suodatus viennistä | **IMPLEMENTED**, testattu |
| Tuonnin jäsennys ja esikatselu | **IMPLEMENTED** |
| Tuonnin kirjoitus | **PLANNED** — vaatii konfliktimallin |
| Paikallisen datan tyhjennys | **IMPLEMENTED** |
| Laitteen tila tilin poistossa | **COMPLETE_LOCAL** (`DEVICE_STORAGE`, natiivimuistutukset) |
| Inventaario + kaskadin todistus | **COMPLETE_LOCAL** (migraatiot + PostgreSQL 17 -harjoitus) |
| Edge Function (lähdekoodi, testit, puuttuvat taulut) | **COMPLETE_LOCAL** |
| Poiston käyttöliittymä ja vahvistusvirta | **COMPLETE_LOCAL** (DOM-osuus laitteella todentamatta) |
| Edge Functionin deploy ja tuotantoaktivointi | **BLOCKED_EXTERNAL_DECISION** |
| aiAudit-säilytyslinjaus | **BLOCKED_EXTERNAL_DECISION** |
