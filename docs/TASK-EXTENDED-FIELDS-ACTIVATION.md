# TASK_EXTENDED_FIELDS — aktivointi

Migraatio 0002 on ajettu ja hyväksytty. Kuusi saraketta on tuotannossa,
mutta sovellus ei kirjoita niihin. Tämä dokumentti kattaa sen viimeisen
askeleen: mitä kentät tarkoittavat, miten lippu käännetään, ja mitä
tehdään jos jokin menee pieleen.

> **TILA: AKTIVOITU KOODISSA. ODOTTAA TUOTANNON HYVÄKSYNTÄÄ.**
> `TASK_EXTENDED_FIELDS = true`. GATE A–E on tehty; jäljellä ovat
> GATE F (käyttökokeilut selaimessa) ja GATE G (jälkivarmistus SQL:llä).
>
> Tietokantaan ei koskettu: 0002 oli ajettu jo aiemmin, ja aktivointi oli
> yhden rivin muutos sovelluskoodissa.

---

## Miksi tämä on oma vaiheensa

Migraation ajaminen ja lipun kääntäminen ovat eri päätöksiä eri
riskeineen. Migraatio lisäsi sarakkeita, joita kukaan ei käytä — se ei
voinut rikkoa mitään. Lipun kääntäminen muuttaa **jokaisen tehtävän
kirjoituksen** tuotannossa, ja sinä hetkenä kaksi asiaa muuttuu kerralla:

1. jokainen kirjoitus alkaa sisältää `priority`- ja
   `scheduling_state`-sarakkeet, jotka ovat `NOT NULL`
2. `scheduling_state` alkaa **säilyä** — siihen asti se on elänyt vain
   selaimen muistissa ja kadonnut sivun latauksessa

Kumpikin on kohta, jossa hiljainen vika muuttuu pysyväksi. Nimenomainen
`null` `NOT NULL` -sarakkeeseen **ei ota oletusarvoa käyttöön** vaan
hylkää rivin: yksi normalisoimaton kirjoituspolku riittäisi kaatamaan
jokaisen tallennuksen. Ja väärä aikataulutustila jää kantaan pysyvästi.

---

## Kenttäsopimus

Tämä on yksi totuus siitä, mitä kukin kenttä tarkoittaa. Sopimus on
koodattu testeihin (`tests/task-extended-activation.test.mjs`), ei vain
tänne.

### `description` → `description text` (sallii nullin)

| | |
|---|---|
| Domain | `task.description`, merkkijono tai `null` |
| Trimmaus | kyllä, **ennen** tyhjyystarkistusta |
| Tyhjä merkkijono | **ei koskaan.** `''` ja pelkät välilyönnit muuttuvat `null`-arvoksi |
| Pituus | enintään 2000 merkkiä, katkaistaan |
| Kelvoton syöte | `null` |

*Miksi tyhjä merkkijono on kielletty:* `''` ja `null` tarkoittaisivat
kannassa eri asiaa, vaikka käyttäjälle ne näyttävät samalta. Kahdesta
esitystavasta samalle asialle seuraa aina vertailuvirheitä — kysely
`description is null` ohittaisi juuri ne rivit, joissa on välilyönti.

### `duration_minutes` → `duration_minutes integer` (sallii nullin)

| | |
|---|---|
| Domain | `task.durationMinutes`, positiivinen kokonaisluku tai `null` |
| Pyöristys | `Math.round` |
| Sallittu väli | 1–1440 (`tasks_duration_minutes_check`) |
| Kelvoton syöte | `null` (0, negatiivinen, `NaN`, teksti) |
| Yli 1440 | `validateTask` hylkää — käyttäjä saa syöttövirheen, ei tallennusvirhettä |

Domainin ja kannan rajat on lukittu samaksi testillä. Jos ne erkanisivat,
lomakkeesta pääsisi läpi arvo, jonka kanta hylkää — ja virhe näyttäisi
tallennusvirheeltä eikä syöttövirheeltä.

### `priority` → `priority text NOT NULL DEFAULT 'normaali'`

| | |
|---|---|
| Sallitut arvot | `korkea`, `normaali`, `matala` |
| Oletus | `normaali` |
| Kelvoton tai puuttuva | `normaali` — **ei koskaan `null`** |
| Lähde | `src/domain/priority.js`, `normalizePriority()` |

Arvojoukko on lukittu testillä migraation `tasks_priority_check`
-rajoitteeseen.

### `scheduling_state` → `scheduling_state text NOT NULL DEFAULT 'manual'`

| Arvo | Tarkoitus |
|---|---|
| `unscheduled` | ei kellonaikaa — automaatti saa ehdottaa aikaa |
| `manual` | **käyttäjän oma päätös** — automaatti ei saa koskea |
| `auto` | automaatin sijoitus, jonka käyttäjä on hyväksynyt — automaatti saa siirtää uudelleen |

Johtaminen (`normalizeTask`):

- ei kellonaikaa → `unscheduled`, kutsujan mielipiteestä riippumatta
- kellonaika ja kutsuja pyytää `auto` → `auto`
- kellonaika muuten → `manual`

`editTask` kunnioittaa nimenomaisesti annettua tilaa; jos kutsuja ei anna
sitä, tila johdetaan ajan muutoksesta. Lomake ei koskaan lähetä tilaa,
joten käyttäjän tekemä ajan muutos on aina `manual`.

*Tämä on tuotteen keskeinen lupaus* (konseptidokumentti, luku 7):
automaatti ei saa tuhota sitä, minkä käyttäjä on itse päättänyt.
`isMovableByScheduler()` toteuttaa sen.

### `created_at` ja `updated_at` → `timestamptz NOT NULL DEFAULT now()`

| | |
|---|---|
| Omistaja | **tietokanta** |
| `created_at` | sarakkeen oletusarvo, kirjoitetaan kerran |
| `updated_at` | liipaisin `tasks_touch_updated_at`, joka ajaa `touch_updated_at()` jokaisessa `UPDATE`-lauseessa |
| Client kirjoittaa | **ei koskaan** |
| Client lukee | kyllä (`fromRow` → `task.createdAt` / `task.updatedAt`) |

Kolme estettä varmistavat, ettei client kirjoita niitä:

1. sarakkeet eivät ole `TASK_COLUMNS_CORE`- eivätkä
   `TASK_COLUMNS_EXTENDED`-listassa, joten `toRow` ei tuota niitä
2. ne ovat `SERVER_OWNED_FIELDS`-listassa, ja `assertClientSafe` heittää
   poikkeuksen jos ne silti päätyisivät payloadiin
3. testi vartioi molempia

*Miksi tämä on tärkeää:* vanhentunut välilehti, jolla on tunnin vanha
tilannekuva, kirjoittaisi vanhan aikaleiman tuoreen päälle. Kannasta
luettu rivi tuo aikaleimat mukanaan, joten ilman estettä ne palaisivat
takaisin jokaisessa tallennuksessa.

**`created_at` ei kerro tuotannon 36 rivin iästä mitään.** Ne saivat
kaikki saman arvon migraation ajanhetkellä. Todellisia luontiaikoja ei
ole tallessa missään.

---

## Aktivointimekanismi

| | |
|---|---|
| **Tiedosto** | `src/data/schema.js` |
| **Muoto** | `export const TASK_EXTENDED_FIELDS = false;` |
| **Tyyppi** | kovakoodattu ES-moduulin vakio, ei ympäristömuuttuja |
| **Näkyvyys** | selaimessa — tiedosto tarjoillaan sellaisenaan, koontivaihetta ei ole |
| **Vaikutus** | `taskColumns()` palauttaa `TASK_COLUMNS_EXTENDED` eikä `TASK_COLUMNS_CORE`; `volatileFields()` palauttaa tyhjän listan |
| **Aktivointi** | vaihda `false` → `true`, committoi, julkaise |
| **Peruminen** | vaihda takaisin, julkaise |

### Miksi ei ympäristömuuttujaa

Harkittiin ja hylättiin. Ympäristömuuttuja olisi houkutteleva, koska
sen voi kääntää ilman julkaisua — mutta juuri se on ongelma:

- sovelluksessa ei ole koontivaihetta, joten selain ei voi lukea Vercelin
  ympäristömuuttujaa ilman uutta palvelinpäätepistettä ja verkkokutsua
  jokaisen latauksen alussa
- lipun arvo eroaisi silloin siitä, mitä testit ajavat — nyt `npm test`
  todentaa täsmälleen sen arvon, joka on tuotannossa
- yhden rivin muutos versionhallinnassa on jäljitettävä; dashboardissa
  käännetty kytkin ei ole

Kovakoodattu vakio maksaa yhden julkaisun. Se on tässä oikea hinta.

### Vanhentunut välimuisti

Service worker on **network-first**: se hakee aina verkosta ja käyttää
välimuistia vain kun verkko ei vastaa. Verkossa oleva käyttäjä saa siis
uuden `schema.js`:n heti seuraavalla latauksella.

`CACHE_VERSION` nostettiin aktivoinnissa arvoon **`v11`**, eikä se ole
kosmetiikkaa. `schema.js` on esiladattavassa SHELL-listassa, ja
`sw.js`:n muuttuminen on **ainoa** asia, josta selain huomaa uuden
service workerin ja hakee listan uudelleen `cache: 'reload'` -tilassa.
Ilman nostoa offline-kykyisellä asennuksella olisi yhä välimuistissa
`schema.js`, jossa lippu on `false` — eikä mikään päivittäisi sitä
koskaan.

**Android on eri asia.** Capacitor kopioi `src/`-hakemiston APK:n
assetteihin (`android/app/src/main/assets/public/`, ei
versionhallinnassa). Sovelluskuori ei päivity Vercel-julkaisusta, vaan
vaatii `npm run sync:android` ja uuden koonnin. Ks. *Laitehyväksynnän
backlog* alla.

---

## Aktivoinnin runbook

### GATE A — koodi

- [ ] `npm test`, `npm run check`, `npm run smoke` läpi
- [ ] Branch ja commit-tiiviste kirjattu
- [ ] Ei salaisuuksia muutoksissa
- [ ] Tuotantoon ei ole vielä koskettu

### GATE B — tuotannon skeema

Aja `supabase/preflight/predeploy_task_extended_fields.sql`. **Vain
lukeva**, 30 kohtaa.

- [ ] Jokainen PASS/FAIL-rivi on `PASS`, `poikkeavia_yhteensa` = 0
- [ ] INFO-luvut (25–30) kirjattu ylös
- [ ] Kohdat 28–30 ovat **nolla** — sovellus ei ole vielä kirjoittanut
      uusiin sarakkeisiin

**Yksikin FAIL → STOP.**

### GATE C — varmuuskopio

- [ ] Tuore varmuuskopio otettu **tänään**
- [ ] Tiedät, miten palautus tehdään

### GATE D — julkaise koodi lipun ollessa yhä `false`

Julkaise tämän paketin muutokset **ilman** lipun kääntämistä.

- [ ] Vercel-julkaisu tehty
- [ ] Savutesti: tehtävän luonti, muokkaus, valmiiksi merkintä, poisto
- [ ] Käyttäytyminen on täsmälleen entisenlainen
- [ ] Aja `predeploy`-varmistus uudelleen: kohdat 28–30 ovat yhä nolla

*Miksi erillinen julkaisu:* tässä paketissa on koodikorjauksia, jotka
eivät liity lippuun (ehdotuksen hyväksyminen, repositorion normalisointi,
tyhjä kuvaus). Jos ne julkaistaan yhdessä lipun kanssa ja jokin
rikkoutuu, ei tiedetä kumpi rikkoi.

### GATE E — käännä lippu ✔ TEHTY

Lippu on käännetty ja julkaistu. Alla oleva on tallessa siltä varalta,
että se on joskus tehtävä uudelleen.

1. `src/data/schema.js`: `TASK_EXTENDED_FIELDS = false` → `true`
2. `npm test` — tämä kaataa testin *"jokaisen migraation tilamerkintä
   kertoo totuuden"*, joka vartioi lippua. Se on tarkoitus: päivitä
   samalla testin perustelu ja tämän dokumentin tila.
3. Committoi ja julkaise
4. Kirjaa julkaisun commit-tiiviste

Muuta ei muuteta samassa julkaisussa.

### GATE F — käyttökokeilut tuotannossa

Tehtävä käyttäjän omalla tilillä, ei testitilillä:

- [ ] Luo tehtävä, jolla on **kuvaus, kesto ja korkea prioriteetti**
- [ ] Lataa sivu uudelleen — kaikki kolme säilyivät
- [ ] Muokkaa kuvausta, lataa uudelleen — muutos säilyi
- [ ] Avaa **vanha** ajallinen tehtävä (yksi 35:stä), muokkaa, tallenna
- [ ] Avaa **vanha kellonajaton** tehtävä (se yksi), anna sille aika
- [ ] Hyväksy automaatin ehdotus → tehtävän on pysyttävä siirrettävänä
- [ ] Merkitse tehtävä valmiiksi ja takaisin kesken
- [ ] Poista testitehtävä
- [ ] Kirjaudu ulos ja takaisin sisään — näkymä tyhjenee välissä
- [ ] Ei virheilmoituksia; mikään tallennus ei epäonnistu hiljaa

Jos kuvaus ei säily ja virhe väittää saraketta puuttuvaksi, kyse on
PostgRESTin skeemavälimuistista: *Settings → API → Reload schema cache*.
**Älä pura migraatiota tämän takia.**

### GATE G — jälkivarmistus

Aja `supabase/verify/verify_task_extended_activation.sql`. **Vain
lukeva**, 30 kohtaa.

- [ ] Jokainen PASS/FAIL-rivi on `PASS`, `poikkeavia_yhteensa` = 0
- [ ] Kohta 24 (`rivit joilla on kuvaus`) on **kasvanut** predeployn
      lukemasta — se on ainoa kannasta näkyvä todiste siitä, että lippu
      oikeasti kääntyi
- [ ] Kohta 29 (`auto`) on kasvanut, jos ehdotus hyväksyttiin

### GATE H — sulkeminen

- [ ] Tuotannon commit-tiiviste kirjattu
- [ ] Tämän dokumentin tila päivitetty: AKTIVOITU
- [ ] `PRODUCTION-ACTIVATION-GATE.md` päivitetty
- [ ] Migraatiot 0003–0008 ovat yhä ajamatta ja niiden liput `false`

---

## Peruminen ja eteenpäin korjaaminen

### Ennen GATE E:tä

Julkaisun peruminen on täysin turvallista. Skeema on additiivinen ja
sovellus ei ole kirjoittanut uusiin sarakkeisiin. Palauta edellinen
julkaisu Vercelistä.

### GATE E:n jälkeen, ennen kuin käyttäjä on kirjoittanut

Käännä lippu takaisin `false` ja julkaise. Sovellus lakkaa lähettämästä
uusia sarakkeita heti. Skeema jää paikalleen eikä haittaa: kaikki uudet
sarakkeet ovat joko nullable tai niillä on oletusarvo, joten vanha
kirjoituspolku toimii muuttumattomana.

### Kun uusissa sarakkeissa on käyttäjän kirjoittamaa tietoa

**Älä pudota sarakkeita.** Niissä on kuvauksia, kestoja ja
prioriteetteja, joita ei ole missään muualla. `drop column` hävittää ne
hiljaa: lause onnistuu, mitään ei valiteta, ja tieto on poissa.

Oikea järjestys:

1. Käännä lippu `false` ja julkaise. Kirjoitukset lakkaavat, **tieto jää
   kantaan koskemattomana**.
2. Selvitä vika rauhassa.
3. Korjaa, aja `verify_task_extended_activation.sql`, käännä lippu
   takaisin.

Sovellus lukee kuvauksen ja prioriteetin (`fromRow`) riippumatta lipusta,
joten lipun ollessa `false` tieto **näkyy mutta ei muutu**. Se on
turvallisin mahdollinen välitila.

### Jos liipaisin aiheuttaa ongelman

`tasks_touch_updated_at` kirjoittaa `new.updated_at = now()` jokaisessa
`UPDATE`-lauseessa. Jos se on jostain syystä poistettava, se on
turvallista — `updated_at` jää vain päivittymättä:

```sql
drop trigger if exists tasks_touch_updated_at on public.tasks;
```

**Älä pudota funktiota `public.touch_updated_at()`** tarkistamatta:
migraatiot 0003 ja 0004 luovat sille liipaisimet omiin tauluihinsa.
Ks. [`MIGRATION-0002-RECOVERY.md`](MIGRATION-0002-RECOVERY.md).

---

## Mitä tämä paketti korjasi

Kolme vikaa, jotka olisivat muuttuneet pysyviksi lipun kääntyessä:

**1. Ehdotuksen hyväksyminen merkitsi tehtävän käyttäjän päätökseksi.**
`acceptProposal()` antoi `editTask`ille sekä ajan että tilan `auto`, ja
johdettu sääntö ylikirjoitti tilan `manual`-arvoksi koska aika oli
mukana. `isMovableByScheduler()` kielsi sen jälkeen automaatilta pääsyn
omaan sijoitukseensa lopullisesti. Ennen 0002:ta vika oli näkymätön:
kenttä ei säilynyt. Nyt `editTask` kunnioittaa nimenomaisesti annettua
tilaa.

**2. Normalisointi oli sopimus, ei rakenne.** `tasksRepo` luotti siihen,
että jokainen kutsuja on ajanut `normalizeTask`in. Se piti paikkansa,
mutta mikään ei estänyt uutta kutsupaikkaa rakentamasta tehtäväoliota
käsin — ja normalisoimattomasta oliosta `toRow` lähettäisi
`priority: null`, jonka `NOT NULL` -sarake hylkää. Nyt repositorio
normalisoi itse, kuten kaikki muut repositoriot jo tekivät.

**3. Tyhjä kuvaus tallentui tyhjänä merkkijonona.** Pelkkiä välilyöntejä
sisältänyt kuvaus muuttui `''`-arvoksi eikä `null`-arvoksi, jolloin "ei
kuvausta" oli kannassa kahdessa muodossa.

Lisäksi `fromRow` lukee nyt aikaleimat, joita se ei aiemmin lukenut
lainkaan — domain-olio kantoi kenttiä, jotka olivat aina `null`.

---

## Laitehyväksynnän backlog

Nämä vaativat fyysisen Android-laitteen eikä niitä tehdä nyt.

| # | Mitä | Miksi vain laitteella |
|---|---|---|
| D1 | APK:n koonti lipun kääntämisen jälkeen (`npm run sync:android`) | **Ajankohtainen nyt.** `android/app/src/main/assets/public/src/data/schema.js` sisältää yhä `TASK_EXTENDED_FIELDS = false`: Capacitorin assetit ovat edellisestä synkronoinnista eivätkä päivity Vercel-julkaisusta. Verkkokäyttö ei kärsi, mutta Android-kuori jää vanhaan lippuun kunnes assetit synkronoidaan ja uusi APK rakennetaan. Ei este verkkojulkaisulle. |
| D2 | Laajennettujen kenttien tallennus natiivikuoressa | WebView on eri selainmoottori kuin työpöydällä. Verkkovirheiden käsittely ja istunnon säilyminen taustalla käyttäytyvät eri tavalla. |
| D3 | Offline-kirjoitus ja paluu verkkoon | Service worker on network-first; offline-tilan käyttäytyminen laitteella on todettava käsin. |

D1 on **aktivoinnin kannalta olennainen**, jos Androidia käytetään:
lipun kääntäminen ei yksin riitä siellä. Työpöytä- ja selainkäyttö
toimivat julkaisun jälkeen normaalisti.
