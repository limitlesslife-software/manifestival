# Tuotannon aktivoinnin runbook

**Tämän ajaa ihminen. Ei agentti, ei skripti, ei CI.**

Jokainen vaihe on erillinen päätös. Vaiheiden välissä on PYSÄYTYS, jossa
on tarkoitus katsoa tulos ja päättää jatketaanko. **Ei ole olemassa
"aja kaikki migraatiot" -vaihetta eikä sellaista pidä rakentaa.**

**Jos haluat vain ajaa 0001:n etkä lukea perusteluja:**
[`PRODUCTION-PREFLIGHT.md`](PRODUCTION-PREFLIGHT.md) on tiivis
operaattoripaketti — preflight, suoritus, hyväksyntäportti ja
palautumisen päätöspuu yhdessä tiedostossa. Tämä runbook kertoo miksi.

Liittyvät: [`PRODUCTION-PREFLIGHT.md`](PRODUCTION-PREFLIGHT.md) ·
[`MIGRATION-MAP.md`](MIGRATION-MAP.md) ·
[`PRODUCTION-ACTIVATION-GATE.md`](PRODUCTION-ACTIVATION-GATE.md)

Varmistuskyselyt: `supabase/verify/` ja `supabase/acceptance/` — **vain
lukevia**. Jokainen lause alkaa sanalla `select`: ei `insert`, `update`,
`delete`, `alter`, `create`, `drop`, `grant` eikä `revoke`. Testi
vartioi tätä.

---

## MISSÄ MENNÄÄN JUURI NYT

**Vaiheet 1–6 on tehty. Migraatiot 0001 ja 0002 on ajettu, todennettu ja
hyväksytty tuotannossa.**

| | Tulos |
|---|---|
| `verify_0001.sql` | läpi |
| Kahden tilin eristystesti | **34/34 PASS** |
| `verify_acceptance.sql` | **18/18 PASS** |
| `verify_0002.sql` | **kauttaaltaan PASS**, `poikkeavia_yhteensa` = 0 |

Todennettu tuotantotila: 36 tehtävää omistajalla
`2cc00622-f927-4604-a518-361a4328481b` (1 `unscheduled`, 35 `manual`),
1 profiili, tasan yksi auth-käyttäjä, RLS päällä, kahdeksan
omistajuuspolitiikkaa oikein ehdoin, liipaisin ja indeksi paikallaan,
anonilla ei oikeuksia, `authenticated`-roolilla tasan CRUD.

**0001 ja 0002 ovat suljettuja. Kumpaakaan ei ajeta uudelleen** —
molemmat keskeytyvät esiehtoon.

**SEURAAVA IHMISEN TOIMENPIDE: lipun `TASK_EXTENDED_FIELDS` aktivointi,
GATE A–H.** Ohje on omassa dokumentissaan:
[`TASK-EXTENDED-FIELDS-ACTIVATION.md`](TASK-EXTENDED-FIELDS-ACTIVATION.md).
GATE B on lukeva esitarkistus, GATE D julkaisee koodin lipun ollessa yhä
`false`, ja vasta GATE E kääntää lipun.

**Migraatiot 0003–0008 ovat ajamatta** ja kaikki yksitoista
skeemaporttia ovat `false`, `TASK_EXTENDED_FIELDS` mukaan lukien.

## Ennen aloitusta

Aktivointi kannattaa aloittaa vasta kun on aikaa viedä ainakin vaiheet
1–5 loppuun samalla istunnolla. Kesken jäänyt 0001 jättää tuotannon
tilaan, jossa vanha ja uusi omistajuusmalli ovat yhtä aikaa voimassa.

Tarvitset: pääsyn Supabasen SQL-editoriin, varmuuskopion, ja tiedon siitä
kuinka monta riviä `tasks`-taulussa on juuri nyt.

### Todennettu lähtötila

`inventory.sql` on ajettu kerran, ja **0001 on sovitettu juuri tähän
tulokseen** — se ei ole enää yleisluonteinen malli:

| | |
|---|---|
| `public.profile` | 1 rivi, `id = 'me'`, tyyppi `text` |
| `public.tasks` | 36 riviä, **ei** `user_id`-saraketta |
| Politiikat | "salli kaikki" -tyyppinen politiikka molemmilla |
| Omistaja | `2cc00622-f927-4604-a518-361a4328481b` |

Migraatio **tarkistaa nämä itse** ja keskeytyy, jos jokin ei täsmää. Se
ei siis luota siihen, että inventaario on yhä voimassa.

**Jos olet luonut tehtäviä inventoinnin jälkeen**, rivimäärä ei enää ole
36 ja migraatio pysähtyy virheeseen `public.tasks: N rivia, odotettiin
36`. Se ei ole vika vaan tarkoitus. Aja `inventory.sql` uudelleen,
päivitä luku migraation VAIHE 0 -lohkoon ja aja uudelleen.

---

## Vaihe 1 — Varmuuskopio

Ota Supabasen kautta **tuore** varmuuskopio: Dashboard → Database →
Backups. Kirjaa sen aikaleima runbookin ajopäiväkirjaan.

**Tuore tarkoittaa tänään, ennen tätä ajoa.** Aiempi havainto
`03 Sep 2026 13:36:47 UTC` on kirjattu vain siksi, että sellainen oli
olemassa. **Se ei kelpaa tämän ajon varmuuskopioksi**, ellei sen jälkeen
ole todistettavasti tapahtunut nolla muutosta — mitä et voi tietää.

**0001 ei ole peruttavissa ilman tätä.** Se siirtää olemassa olevan datan
omistajuuden. Jos siirto menee pieleen eikä varmuuskopiota ole, dataa ei
saa takaisin.

### PYSÄYTYS 1
Varmuuskopio on otettu **tänään**, se näkyy Supabasen listassa
onnistuneena, ja sen aikaleima on kirjattu ylös.
Jos jokin näistä ei päde: **älä jatka.**

---

## Vaihe 2 — Nykytilan inventaario

Aja `supabase/inventory.sql`. Se on lukeva.

Kirjaa ylös:
- montako riviä `tasks`-taulussa on
- onko `tasks`-taulussa jo `user_id`-sarake
- onko RLS päällä
- montako politiikkaa on olemassa
- mitä oikeuksia `anon`-roolilla on

Vertaa tulosta yllä olevaan **Todennettu lähtötila** -taulukkoon.

### PYSÄYTYS 2
Tulos vastaa odotusta. Erityisesti:

- jos `tasks.user_id` on jo olemassa, **0001 on osittain ajettu** —
  selvitä tilanne ennen jatkoa
- jos `profile.legacy_id` on jo olemassa, sama asia
- jos `tasks`-rivimäärä ei ole 36, **päivitä luku migraation VAIHE 0
  -lohkoon** ennen ajoa. Älä poista tarkistusta.

---

## Vaihe 3 — Migraatio 0001 (auth-omistajuus)

Aja `supabase/migrations/0001_auth_user_scoping.sql` kokonaisuudessaan
— **koko tiedosto kerralla, ei lohko kerrallaan.** Se on yksi
transaktio. Paloittain ajettuna transaktion suoja katoaa ja kanta voi
jäädä puolitiehen.

Tämä on ainoa **pakollinen** migraatio. Kaikki muut ovat valinnaisia ja
voi jättää ajamatta pysyvästi.

### Kirjaa mitä ajoit

Liität tiedoston sisällön käsin selaimeen. Kuukauden päästä ei ole mitään
tapaa tietää, mikä versio meni läpi, ellei sitä kirjata nyt.

Ota talteen ennen ajoa:

```
git rev-parse --short HEAD
git hash-object supabase/migrations/0001_auth_user_scoping.sql
git hash-object supabase/verify/verify_0001.sql
```

Kirjaa kaikki kolme ajopäiväkirjaan yhdessä varmuuskopion aikaleiman
kanssa. Jos jokin menee myöhemmin pieleen, tämä on ainoa tapa todeta,
ajettiinko odotettu versio.

### Lyhyt katko — tiedosta se ennen kuin painat Run

Migraatio ottaa heti alussa **ACCESS EXCLUSIVE -lukon** molempiin
tauluihin:

```sql
lock table public.tasks, public.profile in access exclusive mode;
```

Sen jälkeen sovellus **ei pysty lukemaan eikä kirjoittamaan** näihin
tauluihin ennen kuin transaktio päättyy. Ajo kestää sekunteja, joten
katko on lyhyt — mutta se on todellinen.

Lukko ei ole varotoimi vaan välttämättömyys. `begin;` yksinään ei
jäädytä mitään: Postgresin oletuseristystaso on READ COMMITTED, ja
pelkkä `select` ottaa vain ACCESS SHARE -lukon, joka ei estä toisen
istunnon kirjoituksia. Ilman lukkoa puhelimeen jäänyt välilehti voisi
lisätä tehtävän sen jälkeen kun rivimäärä on todettu 36:ksi mutta ennen
kuin migraatio saa oman DDL-lukkonsa — ja migraatio tekisi päätöksensä
tilasta, jota ei enää ole.

**Sulje sovellus kaikilta laitteilta ennen ajoa.** Se ei ole pakollista,
mutta avoin välilehti näkee virheen katkon ajan ja voi yrittää
uudelleenlähetystä.

Migraatiossa on `lock_timeout = 5s`. Jos lukkoa ei saada siinä ajassa,
ajo **keskeytyy eikä muuta mitään** — silloin jokin toinen istunto on
kesken. Yleisin syy on unohtunut avoin transaktio SQL-editorin toisessa
välilehdessä. Sulje se ja aja uudelleen.

Lue tuloslokista `NOTICE`-rivit. Niiden pitää kertoa:
- `Esiehdot kunnossa. Omistaja 2cc00622-…, tehtavia 36, profiileja 1.`
- montako vanhaa politiikkaa poistettiin
- `Lopputila kunnossa: 8 politiikkaa, RLS paalla, PUBLIC tyhja, anon
  ilman tehollista oikeutta, authenticated tasan 4.`

Jos ajo päättyy `ERROR`-riviin, **mitään ei ole muuttunut** — koko
tiedosto peruuntuu itsestään. Lue virheteksti: se nimeää sen esiehdon,
joka ei täyttynyt.

#### Skeemavälimuisti

PostgREST — se rajapinta, jota selain käyttää — pitää skeemasta
välimuistia. 0001 muuttaa `profile`-taulun sarakkeet, joten välimuisti on
ajon jälkeen vanhentunut. Supabase päivittää sen yleensä itse muutaman
sekunnin sisällä.

Jos sovellus antaa heti ajon jälkeen virheen, jonka mukaan saraketta ei
ole olemassa, **odota hetki ja lataa sivu uudelleen** ennen kuin alat
etsiä vikaa migraatiosta. Välimuistin voi myös pakottaa päivittymään
Supabasen Dashboardista: *Settings → API → Reload schema cache*.

### PYSÄYTYS 3
Aja `supabase/verify/verify_0001.sql`. Tiedostossa on 20 numeroitua
kohtaa, ja odotusarvot ovat täsmällisiä:

| # | Kohta | Odotus |
|---|---|---|
| 1 | RLS | `true` molemmilla |
| 2 | Politiikkojen määritelmät | 8 riviä, rooli `{authenticated}`, `qual` ja `with_check` näkyvissä |
| 3 | Politiikkojen määrä | **tasan 8** |
| 4 | **Politiikat vs. odotettu** | `tulos` = `OK` jokaisella, `poikkeavia_yhteensa` = **0** |
| 5 | `tasks.user_id` | `uuid`, `NO`, oletus `auth.uid()` |
| 6 | `profile.id` / `legacy_id` | `uuid`/`NO`/`auth.uid()` ja `text`/`YES`/**oletus tyhjä** |
| 7 | **Perumisen merkkipaalu** | `1, 1, 1, 0` |
| 8 | Rivimäärät | `tasks` 36, `profile` 1 |
| 9 | Omistajattomat | 0 |
| 10 | Omistajuus | molemmat `bool_and` = `true` |
| 11 | Eri omistajia | 1 |
| 12 | Orvot viitteet | 0 ja 0 |
| 13 | **Vierasavainten päät** | `tulos` = `OK` molemmilla, `poikkeavia_yhteensa` = **0** |
| 14 | **Ylimääräiset vierasavaimet** | **nolla riviä** |
| 15 | `profile`-pääavain | yksi rivi, sarakkeena `id` |
| 16 | Indeksi | `tasks_user_id_date_idx` löytyy |
| 17 | `anon` suorat oikeudet | **nolla riviä** |
| 18 | `authenticated` suorat oikeudet | tasan 8 riviä |
| 19 | `PUBLIC`-myönnöt | **nolla riviä** |
| 20 | Tehollinen oikeus | `anon_saa` = `false` kaikilla 14 rivillä; `authenticated_saa` = `true` vain neljällä per taulu |

Jos rivimäärä muuttui: **palauta varmuuskopiosta.** Migraatio ei saa
hävittää yhtään riviä.

Jos `anon`-oikeuksissa on yksikin rivi, tai jos kohdassa 20 on yksikin
`true` sarakkeessa `anon_saa`: **älä jatka.** Julkinen avain on
selaimessa, ja anonin oikeus tekee RLS:stä ainoan esteen.

**Miksi neljä eri oikeustarkistusta.** Kohta 17 näyttää vain
nimenomaiset myönnöt roolille `anon`. PostgreSQL-rooli `PUBLIC`
tarkoittaa "kaikki roolit", ja sille myönnetyn oikeuden **perii myös
anon** — perittyä oikeutta ei näy kohdassa 17 lainkaan. Kohta 19
paljastaa PUBLIC-myönnöt, ja kohta 20 kertoo `has_table_privilege`illä
mitä rooli lopulta *todella* saa tehdä. Vain kohta 20 on todiste.

**Miksi politiikkojen ehdot luetaan auki.** Politiikan olemassaolo ei
todista mitään. Väärä ehto näyttää ulospäin tasan samalta kuin oikea:
sama nimi, sama operaatio, sama rooli. Ero on vain USING- ja
WITH CHECK -lausekkeissa, ja juuri ne ratkaisevat näkeekö käyttäjä
toisen rivit. Kohta 2 näyttää ne luettavaksi, kohta 4 vertaa ne
odotettuun puolestasi — kahdeksan riviä lausekkeita on juuri sopivan
pituinen lista siihen, että yksi väärä merkki jää huomaamatta
silmämääräisessä luvussa.

**Miksi vierasavaimista katsotaan päät.** Rajoitteen nimi ei kerro
mihin se osoittaa. Oikean niminen vierasavain väärään sarakkeeseen
näyttäisi nimilistassa täysin oikealta. Kohta 13 todistaa että odotetut
kaksi osoittavat tarkalleen `auth.users(id)`-tauluun `CASCADE`-säännöllä,
kohta 14 että muita ei ole.

Jos kohdassa 7 `legacy_me` ei ole `1`, tai jos `profile.legacy_id`
-sarakkeella on kohdassa 6 oletusarvo: **älä jatka.** Ilman säilynyttä
alkuperäistä arvoa migraation ROLLBACK-osion kohta 2 ei enää pidä
paikkaansa, ja jäänyt oletusarvo antaisi jokaiselle uudelle
profiiliriville `legacy_id = 'me'`.

---

## Vaihe 4 — Sovelluksen savutesti oikeaa tuotantoa vasten

Ennen kuin yhtään lippua käännetään: kirjaudu sovellukseen, luo tehtävä,
muokkaa sitä, poista se. Kirjaudu ulos ja takaisin sisään.

Tämän vaiheen tarkoitus on todeta, että **0001 ei rikkonut mitään
olemassa olevaa** — ennen kuin päälle kasataan lisää.

### PYSÄYTYS 4
Tehtävien luonti, muokkaus ja poisto toimivat. Uloskirjautuminen tyhjentää
näkymän. Jos jokin ei toimi: korjaa ennen jatkoa. **Älä jatka vaiheeseen 5
rikkinäisen pohjan päälle.**

---

## Vaihe 5 — PAKOLLINEN eristystesti kahdella tilillä

**Tämä vaihe ei ole valinnainen, eikä sitä saa ohittaa.** Kaikki muu
tässä repossa on päättelyä: testit lukevat SQL:ää tekstinä, eivät aja
sitä. RLS:n toiminnasta on olemassa täsmälleen yksi todiste, ja tämä on
se.

Ennen tätä vaihetta **yhtäkään lippua ei käännetä** eikä yhtäkään muuta
migraatiota ajeta.

**Koko ohje, työkalu ja jälkivarmistus:
[`RLS-ACCEPTANCE.md`](RLS-ACCEPTANCE.md).** Se ei ole liite vaan tämän
vaiheen sisältö. Alla on vain se, mitä runbookin lukijan on tiedettävä
ennen kuin hän avaa sen.

### Mikä muuttui aiempaan versioon nähden

Aiempi versio teki kirjoituskiellot SQL-editorissa tempulla
`set local role authenticated` + `request.jwt.claims`. Se testaa
politiikan lausekkeen, mutta ohittaa JWT:n todennuksen, julkisen
anon-avaimen, PostgRESTin roolinvaihdon ja roolin `authenticated`
GRANTit — eli juuri ne kerrokset, joissa vika olisi näkymätön.
Politiikka voi olla täysin oikein ja pääsy silti auki, jos GRANT on
väärä.

Testi ajetaan nyt **oikeilla kirjautuneilla istunnoilla** samalla
julkisella anon-avaimella kuin sovellus, yhtenä ajona, ja se tuottaa
yhden kopioitavan taulukon. Kaksikymmentä käsin ajettavaa
SQL-kyselyä ei enää ole.

### Mitä ajetaan

```
npm run serve
http://localhost:3000/tools/rls-acceptance/
```

Ennen ajoa on luotava väliaikainen tili B Supabasen Authentication-
näkymästä. **Se on tuotannon auth-kirjoitus ja vaatii nimenomaisen
luvan.** Ohje: `RLS-ACCEPTANCE.md`, kohta A.

### Mitä testi kattaa

| | Testi | Mitä todistaa |
|---|---|---|
| T1 | A lukee oman datansa | `USING` ei ole liian tiukka |
| T2 | B ei näe A:n tehtäviä eikä profiilia | `USING` estää lukemisen molemmissa omistajuusmalleissa |
| T3 | B ei voi muuttaa, poistaa eikä kirjoittaa A:n nimiin | `USING` kirjoituspuolella ja `WITH CHECK` |
| T4 | B luo, lukee, muuttaa ja poistaa oman datansa | politiikka ei ole `using (false)` |
| T5 | A ei näe eikä muuta B:n dataa | eristys on kaksisuuntainen |
| T6 | Kirjautumaton ei saa mitään | anon-roolilta on peruttu oikeudet |

Tilin A 36 oikeaa tehtävää ja profiili **eivät ole testin kohteena**.
Kiellot todistetaan A:n omistamaa syöttiriviä, B:n väliaikaista dataa ja
arvot säilyttävää payloadia vastaan. Perustelu jokaiselle valinnalle on
`RLS-ACCEPTANCE.md`:ssä.

### PYSÄYTYS 5

Migraatiota 0002 ei ajeta eikä yhtäkään lippua käännetä, ennen kuin
**kaikki kolme** ovat totta:

1. Selaintestin raportti: `TULOS: PASS` — ei yhtäkään FAIL, ERROR eikä SKIP
2. Väliaikainen tili B on poistettu Supabasen Authentication-näkymästä
3. `supabase/acceptance/verify_acceptance.sql`: kaikki 18 kohtaa `PASS`
   ja `poikkeavia_yhteensa` = 0

Liitä molemmat raportit ajolokiin sellaisenaan.

Yksikin poikkeama tarkoittaa, että henkilökohtainen data on toisen
käyttäjän saatavilla tai muokattavissa. Pysäytä kaikki, älä käännä
yhtäkään lippua äläkä aja yhtäkään muuta migraatiota ennen kuin syy on
selvitetty. Vikataulukko: `RLS-ACCEPTANCE.md`, *Vikatilanteet*.

---

## Vaihe 6 — Migraatio 0002 (tasks-lisäkentät)

Kuusi uutta saraketta tauluun `tasks`, kolme tarkistetta, liipaisin ja
indeksi. Ei uusia tauluja, ei muutoksia RLS:ään eikä politiikkoihin.

Perustelut, portti ja palautuminen:
[`MIGRATION-0002-RECOVERY.md`](MIGRATION-0002-RECOVERY.md). Alla on
suoritus.

### GATE 0 — lähtötila

- [ ] Työpuu puhdas, oikea branch
- [ ] Migraation tiiviste kirjattu:
      `git log -1 --format=%H -- supabase/migrations/0002_task_domain_fields.sql`
- [ ] Projektiviite on `twpyubcymdnbvelsjidg`
- [ ] 0001 on yhä hyväksytty — ei tuotantomuutoksia sen jälkeen
- [ ] Mikään muu tuotantotyö ei ole kesken

### GATE 1 — preflight

Aja `supabase/preflight/preflight_0002.sql`. **Vain lukeva.**

- [ ] Jokainen PASS/FAIL-rivi on `PASS`
- [ ] `poikkeavia_yhteensa` = 0
- [ ] INFO-rivien luvut kirjattu ylös (14–19): rivimäärä, kellonajattomat,
      kellonajalliset, auth-käyttäjät, rajoitteet, indeksit

**Yksikin FAIL → STOP.** Preflight kertoo saman kuin migraation esiehdot,
mutta ilman lukkoa ja ilman katkoa. Keskeytynyt migraatio on kalliimpi.

### GATE 2 — palautuminen

- [ ] Tuore varmuuskopio otettu **tänään**
- [ ] Tiedät, miten palautus tehdään
- [ ] [`MIGRATION-0002-RECOVERY.md`](MIGRATION-0002-RECOVERY.md) luettu,
      erityisesti kohdat C ja D

**STOP, jos palautumisesta ei ole näyttöä.**

### GATE 3 — nimenomainen lupa

Ihminen päättää, että 0002 ajetaan nyt. Tämä ei ole automaattinen askel.

Sulje sovellus laitteilta. Migraatio ottaa `ACCESS EXCLUSIVE` -lukon:
36 rivillä se kestää millisekunteja, mutta lukon ajan taulu on kokonaan
poissa käytöstä. `lock_timeout` on 5 s — jos taulu on varattu, migraatio
keskeytyy eikä jää odottamaan.

### GATE 4 — suoritus

Aja `supabase/migrations/0002_task_domain_fields.sql` **kokonaisuudessaan,
yhtenä ajona, kerran.**

Odotetut `NOTICE`-rivit:

```
Esiehdot kunnossa. Omistaja 2cc00622-..., tehtavia N, puuttuvia objekteja 12.
Migraatio 0002 valmis. Aja seuraavaksi supabase/verify/verify_0002.sql.
```

- [ ] Kellonaika ja tulos kirjattu

**Virheen sattuessa: STOP. Älä aja uudelleen sokeasti.** Migraatio
tunnistaa aiemman ja kesken jääneen ajon ja keskeytyy niihin
tarkoituksella — uudelleenajo ei korjaa kumpaakaan. Virheviestien
taulukko on recovery-dokumentissa.

### GATE 5 — varmistus

Aja `supabase/verify/verify_0002.sql`. Yksi taulukko, 29 riviä.

- [ ] Jokainen PASS/FAIL-rivi on `PASS`
- [ ] `poikkeavia_yhteensa` = 0
- [ ] INFO-rivit 25–29 vastaavat preflightin lukuja:
      rivimäärä sama, `unscheduled` = preflight 15, `manual` = preflight 16,
      rajoitteita 3 enemmän, indeksejä 1 enemmän

**Yksikin FAIL → lippua ei käännetä.**

### GATE 6 — tarvitaanko uusi eristystesti

**Ei tarvita.** 0002 ei luo tauluja eikä kosketa politiikkoihin, joten
0001:n kahden tilin hyväksyntä on yhä voimassa. `verify_0002` kohdat
19–24 todistavat, että RLS, kahdeksan politiikkaa ja oikeudet ovat
ennallaan.

Jos jokin niistä on FAIL, eristystesti on toistettava ennen jatkoa:
[`RLS-ACCEPTANCE.md`](RLS-ACCEPTANCE.md).

---

## Vaihe 7 — lippu `TASK_EXTENDED_FIELDS`

**Tämä vaihe on kasvanut omaksi dokumentikseen:
[`TASK-EXTENDED-FIELDS-ACTIVATION.md`](TASK-EXTENDED-FIELDS-ACTIVATION.md)**
— kenttäsopimus, aktivointimekanismi, GATE A–H, käyttökokeilut,
peruminen ja laitehyväksynnän backlog.

Lyhyesti: vaihda `src/data/schema.js`:ssä `TASK_EXTENDED_FIELDS` arvoon
`true`, aja `npm test`, committoi ja julkaise. Sitä ennen aja
`supabase/preflight/predeploy_task_extended_fields.sql` ja sen jälkeen
`supabase/verify/verify_task_extended_activation.sql`.

**Käännä lippu pian migraation jälkeen.** Väliaikana sovellus ei lähetä
`scheduling_state`-saraketta, jolloin uudet kellonajattomat tehtävät
saavat oletusarvon `manual` eivätkä `unscheduled` — automaatti ei siis
ehdota niille aikaa. Se ei ole tietohäviö, mutta se on korjattavaa työtä
joka kasvaa joka päivä.

### PYSÄYTYS 7
Luo tuotannossa tehtävä, jolla on kuvaus ja prioriteetti. Lataa sivu
uudelleen. Molempien on säilyttävä. Jos virhe väittää saraketta
puuttuvaksi vaikka `verify_0002` näki sen, kyse on skeemavälimuistista:
*Settings → API → Reload schema cache*.

Deployaa. Kokeile tehtävän luontia kuvauksella ja prioriteetilla.
Lataa sivu uudelleen ja tarkista, että kentät ovat yhä siellä.

### PYSÄYTYS 7
Laajennetut kentät säilyvät uudelleenlatauksen yli. Jos eivät:
käännä lippu takaisin `false`:ksi ja deployaa. Vasta sitten selvitä syy.

---

## Vaihe 8 — Migraatio 0003 (rutiinit)

Aja `0003_routines.sql`.

### PYSÄYTYS 8
Aja `verify_0003.sql`. Molemmat taulut, 8 politiikkaa, uniikki-indeksi.

---

## Vaihe 9 — Liput `routines` + `routineExceptions`

Molemmat `true` **samassa committissa**. Poikkeus ilman sääntöä on orpo.

Päivitä myös `tests/migrations.test.mjs` — se kaatuu tarkoituksella.
Kirjoita commit-viestiin, **mikä migraatio ajettiin ja milloin**.

### PYSÄYTYS 9
Luo rutiini, ohita se yhdeltä päivältä, lataa sivu uudelleen. Sekä
rutiini että poikkeus säilyivät.

---

## Vaihe 10 — Migraatio 0004 (tavoitteet ja projektit)

Aja `0004_goals_projects.sql`.

### PYSÄYTYS 10
Aja `verify_0004.sql`. Tarkista erityisesti: **kaikki KUUSI
vierasavainta ovat `SET NULL`, ei yksikään `CASCADE`.** Kohdan 3b
`vaaria_poistosaantoja` on oltava **0**.

Kuusi, ei neljä. Kaksi niistä syntyy `create table` -lauseen sisällä
eikä erillisenä `add constraint` -lauseena, joten ne on helppo unohtaa:

| Rajoite | Jos tämä olisi CASCADE |
|---|---|
| `goals_parent_goal_id_fkey` | ylätavoitteen poisto veisi kaikki alatavoitteet |
| `projects_goal_id_fkey` | tavoitteen poisto veisi kaikki sen projektit |
| `goals_project_id_fkey` | projektin poisto veisi tavoitteen |
| `tasks_goal_id_fkey` | tavoitteen poisto veisi tehtävät |
| `tasks_project_id_fkey` | projektin poisto veisi tehtävät |
| `routines_goal_id_fkey` | tavoitteen poisto veisi rutiinit |

Jos 0003 on ajamatta, `routines_goal_id_fkey` puuttuu ja rivejä on
viisi. Se on oikein, ei puute.

---

## Vaihe 11 — Liput `goals` + `projects`

Molemmat `true` samassa committissa.

**Huom:** projekteilla ei ole käyttöliittymää. Lipun kääntäminen tekee
projekteista pysyviä, mutta niitä pääsee luomaan vain AI-komennolla.
Tämä on tiedostettu ja hyväksyttävä tila.

### PYSÄYTYS 11
Luo tavoite, liitä siihen tehtävä, poista tavoite. **Tehtävän on jäätävä
olemaan** ilman tavoitelinkkiä. Jos tehtävä katosi: cascade on
väärässä paikassa — palauta varmuuskopiosta.

---

## Vaihe 12 — Migraatio 0005 (muistutusasetukset)

Aja `0005_notification_preferences.sql`.

### PYSÄYTYS 12
Aja `verify_0005.sql`. **`enabled`-sarakkeen oletusarvon on oltava
`false`.** Jos se on `true`, migraation ajaminen on kytkenyt
muistutukset päälle ilman lupaa — korjaa ennen lipun kääntämistä.

---

## Vaihe 13 — Lippu `notificationPreferences`

`true`. Deployaa.

### PYSÄYTYS 13
Aseta rauhoitusaika, lataa sivu uudelleen, tarkista että se säilyi.
Tarkista toisella laitteella, että sama asetus näkyy siellä.

---

## Vaihe 14 — Migraatio 0006 (hyvinvointi) + lippu

Aja `0006_wellbeing.sql`, aja `verify_0006.sql`, käännä lippu `wellbeing`.

### PYSÄYTYS 14
Tämä on terveystietoa. **Toista vaiheen 5 eristystesti tälle taululle
erikseen** kahdella tilillä. Älä ohita sitä sillä perusteella, että RLS
todettiin toimivaksi jo kerran.

`tools/rls-acceptance` kattaa vain taulut `tasks` ja `profile` — ne ovat
ne, jotka 0001 muuttaa. Uusi taulu vaatii oman kierroksensa: laajenna
työkalua tai tee testi käsin samalla kaavalla (lue, kirjoita toisen
nimiin, muuta, poista — molempiin suuntiin).

---

## Vaihe 15 — Migraatio 0007 (talous)

Aja `0007_finance.sql`.

### PYSÄYTYS 15
Aja `verify_0007.sql`. Tarkista rahasarakkeiden tyyppi: kaikkien
kolmen on oltava **`bigint`**. Jos jokin on `numeric` tai
`double precision`, **älä käännä lippuja** — sentit katoaisivat
ajurin muunnoksessa.

---

## Vaihe 16 — Liput `bills` + `recurringExpenses` + `savingsGoals`

Kaikki kolme `true` samassa committissa.

**Huom:** taloudella ei ole käyttöliittymää. Sama tiedostettu tila kuin
projekteilla vaiheessa 11.

### PYSÄYTYS 16
Luo lasku summalla `129,95`. Lataa sivu uudelleen. Summa on edelleen
tasan `129,95` — ei `129,94` eikä `129,950000001`.

---

## Vaihe 17 — Migraatio 0008 (AI-kirjaus) + lippu

Aja `0008_ai_audit.sql`, aja `verify_0008.sql`, käännä lippu `aiAudit`.

### PYSÄYTYS 17
Yritä käsin lisätä kirjaus, jossa `executed = true` ja
`confirmed = false`. **Tietokannan on hylättävä se.** Jos se menee läpi,
rajoite puuttuu.

---

## Peruminen

| Migraatio | Peruminen |
|---|---|
| 0008 | `drop table public.ai_action_audit` |
| 0007 | `drop table` bills → savings_goals → recurring_expenses |
| 0006 | `drop table public.wellbeing_entries` |
| 0005 | `drop table public.notification_preferences` |
| 0004 | `drop table` projects → goals; kolme saraketta pois `tasks`-taulusta |
| 0003 | `drop table` routine_exceptions → routines |
| 0002 | Kuusi saraketta pois `tasks`-taulusta |
| 0001 | Ks. alla — **kolme eri tilannetta, kolme eri vastausta** |

**Käännä aina lippu `false`:ksi ja deployaa ENNEN kuin taulu pudotetaan.**
Toisin päin sovellus kirjoittaa olemattomaan tauluun ja jokainen
tallennus epäonnistuu.

### 0001:n peruminen

Älä kysy "miten 0001 perutaan". Kysy ensin **mikä meni pieleen** — vastaus
on eri jokaisessa kolmessa tapauksessa.

**1. Ajo keskeytyi virheeseen.**
Ei tarvita mitään. Migraatio on yksi transaktio, ja jokainen tarkistus on
sen sisällä. Postgres peruu kaiken itse. Kanta on täsmälleen siinä
tilassa kuin ennen ajoa. Lue virheteksti — se nimeää esiehdon, joka ei
täyttynyt, ja korjaus on yleensä yhden luvun päivitys migraation VAIHE
0 -lohkoon.

Tämä on **ylivoimaisesti todennäköisin** tapaus, ja se on jo hoidettu.

**2. Ajo meni läpi, mutta malli halutaan purkaa.**
Skeema ja data ovat palautettavissa ilman varmuuskopiota: alkuperäinen
`me` säilyy sarakkeessa `profile.legacy_id`, migraatio ei pudota sitä,
eikä `tasks.user_id` ole pudottanut mitään vanhaa.

**Politiikat eivät kuitenkaan palaudu.** Migraatio poistaa vanhat
"salli kaikki" -politiikat nimestä riippumatta eikä tallenna niiden
määritelmiä mihinkään. Jos et ottanut niitä talteen ennen ajoa
(preflight-kohta P10), et voi palauttaa niitä sellaisina kuin ne olivat
— voit vain kirjoittaa uudet. Käytännössä se ei haittaa, koska
palauttaminen tarkoittaisi joka tapauksessa paluuta tilaan, jota ei
pitäisi haluta takaisin. Mutta älä usko, että purkaminen on täydellinen
peruutus. Se ei ole.

Käänteisiä vaiheita ei ole kirjoitettu valmiiksi skriptiksi, eikä sitä
pidä tehdä. **Käänteismigraatio, jota kukaan ei ole koskaan ajanut, on
vaarallisempi kuin sen puuttuminen** — se antaa vaikutelman
turvaverkosta, joka ei ole olemassa. Vaiheet on kuvattu 0001:n
ROLLBACK-osiossa luettavaksi ja käsin sovellettavaksi.

Huomaa lisäksi, mitä purkaminen tarkoittaa: paluu tilaan, jossa
julkinen anon-avain riittää lukemaan kaiken. **Peruminen on
tietoturvan heikennys.** Tee se vain, jos migraatio oikeasti rikkoi
jotain — ei siksi, että jokin näyttää oudolta.

**3. Dataa katosi tai se meni väärälle omistajalle.**
Palauta varmuuskopiosta. Tähän ei ole muuta vastausta.

Migraation rivimäärätarkistukset (vaiheet 2c, 3f ja 7) ja PYSÄYTYS 3:n
varmistuskysely on kirjoitettu juuri sitä varten, ettei tähän tarvitse
päätyä. Ne kaikki ajetaan ennen committia tai heti sen jälkeen, joten
tapaus 3 vaatii käytännössä sen, että vika on jossain muualla kuin
migraatiossa.

### Mitä `legacy_id` on ja miksi se jää

Sarake `profile.legacy_id` sisältää migraation jälkeen arvon `me`. Se on
tarkoituksellinen jäänne:

- sovellus ei lue sitä (`profileFromRow` ei tunne kenttää)
- se ei sisällä henkilökohtaista tietoa
- se on ainoa asia, joka tekee tapauksesta 2 mahdollisen

Sen saa pudottaa myöhemmin **erillisenä päätöksenä**, kun uusi
omistajuusmalli on ollut tuotannossa riittävän kauan. Sitä ei kannata
tehdä samalla kertaa 0001:n kanssa.

---

## Mitä tämä runbook ei kata

- **Vercel-ympäristömuuttujat** — eivät muutu, `SUPABASE_URL` ja
  `SUPABASE_ANON_KEY` ovat jo paikallaan
- **Android-julkaisu** — erillinen prosessi, ks. `docs/ANDROID.md`
- **Tilin poisto** — ks. [`ACCOUNT-DELETION.md`](ACCOUNT-DELETION.md).
  `on delete cascade` `auth.users`-tauluun tekee siitä yhden operaation,
  mutta sitä ei ole koskaan ajettu tuotannossa
- **Sijaintiperusteiset muistutukset** — ei toteutettu, ks.
  [`LOCATION-DEPARTURE-ARCHITECTURE.md`](LOCATION-DEPARTURE-ARCHITECTURE.md)
