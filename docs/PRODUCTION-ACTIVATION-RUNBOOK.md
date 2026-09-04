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

Varmistuskyselyt: `supabase/verify/` — **vain lukevia**. Jokainen lause
alkaa sanalla `select`: ei `insert`, `update`, `delete`, `alter`,
`create`, `drop`, `grant` eikä `revoke`. Testi vartioi tätä.

---

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

### Miksi pelkkä katsominen ei riitä

Aiempi versio tästä testistä katsoi vain, **näkyykö** toisen tilin data.
Se on puolet asiasta. Politiikassa on kaksi eri ehtoa, ja ne
epäonnistuvat eri tavoin:

| Ehto | Mitä se estää | Missä testataan |
|---|---|---|
| `USING` | toisen rivien **lukemisen, muuttamisen ja poistamisen** | T2, T4 |
| `WITH CHECK` | rivin kirjoittamisen **toisen nimiin** | T3 |

Pelkkä `USING` voi olla oikein ja `WITH CHECK` väärin. Silloin tili B ei
näkisi mitään tilin A dataa, mutta voisi silti luoda rivin, jonka
omistaja on A. Se ei näkyisi missään ennen kuin A ihmettelee, mistä
kalenteriin ilmestyi tekemätöntä työtä.

### Valmistelu

**1. Luo tili B** sovelluksen kirjautumisnäkymästä. Käytä oikeaa
sähköpostiosoitetta, johon pääset käsiksi — Supabase vaatii
vahvistuksen. Älä käytä tilin A osoitetta.

**2. Hae molempien tunnisteet:**

```sql
select id, created_at from auth.users order by created_at;
```

Tilin A tunnisteen on oltava `2cc00622-f927-4604-a518-361a4328481b`.
Kirjaa tilin B tunniste ylös. Alla siitä käytetään merkintää `<B_UUID>`.

**3. Kirjaa lähtöluvut:**

```sql
select count(*) filter (where user_id = '2cc00622-f927-4604-a518-361a4328481b'::uuid) as a_ennen,
       count(*) filter (where user_id <> '2cc00622-f927-4604-a518-361a4328481b'::uuid) as muut_ennen
from public.tasks;
```

Odotus: `36` ja `0`.

---

### T1 — Tili A näkee OMAN datansa

Kirjaudu sovellukseen tilillä A. Avaa päivänäkymä ja profiili.

**Odotus: kaikki 36 tehtävää ja profiilin arvot näkyvät normaalisti.**

Tämä kohta on ensimmäisenä tarkoituksella. Liian tiukka politiikka
lukitsisi omistajan ulos omasta datastaan, ja se on yhtä paha vika kuin
liian löysä — vain helpompi huomata. Jos A ei näe omaa dataansa,
`USING`-ehto tai `user_id`-backfill on väärin. **Pysäytä.**

### T2 — Tili B ei näe tilin A dataa

Kirjaudu ulos ja sisään tilillä B.

- **Päivänäkymä:** siirry päivään, jolla tiedät tilillä A olevan
  tehtäviä. **Odotus: nolla tehtävää.**
- **Profiili:** kenttien pitää olla tyhjiä tai oletusarvoisia —
  **ei tilin A ikää, painoa eikä heräämisaikaa.**

Profiili on erillinen tarkistus, koska `profile` käyttää eri
omistajuusmallia kuin `tasks`: omistajuus on `id`-sarakkeessa, ei
`user_id`-sarakkeessa. Toinen voi toimia ilman että toinen toimii.

Jos näkyy yksikin tilin A rivi: **RLS ei ole voimassa. Pysäytä kaikki.**

### T3 — Tili B ei voi kirjoittaa riviä tilin A nimiin

Tämä on `WITH CHECK` -ehdon testi, eikä sitä voi tehdä
käyttöliittymästä: sovellus ei koskaan lähetä `user_id`-kenttää, joten
UI ei pysty edes yrittämään väärinkäytöstä. Se on pakko tehdä SQL:llä.

> **LUE TÄMÄ ENSIN.** Alla olevassa lohkossa on `insert`-lause, mutta se
> päättyy `rollback`-lauseeseen eikä `commit`-lauseeseen. **Aja koko
> lohko kerralla.** Jos ajat sen rivi kerrallaan ja unohdat lopun, jätät
> transaktion auki — ja avoin transaktio on juuri se, mikä estää
> seuraavan migraation lukituksen. Jos et ole varma, älä aja tätä.

```sql
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"<B_UUID>","role":"authenticated"}';

-- Yritetaan luoda rivi TILIN A nimiin. Taman PITAA epaonnistua.
insert into public.tasks (id, date, title, user_id)
values ('rls-test-t3', current_date, 'ei saa onnistua',
        '2cc00622-f927-4604-a518-361a4328481b'::uuid);

rollback;
```

**Odotus: virhe**
`new row violates row-level security policy for table "tasks"`

**Jos lause menee läpi: turvamalli on rikki.** `WITH CHECK` puuttuu tai
on väärin. Aja `rollback;` heti, pysäytä kaikki äläkä käännä yhtäkään
lippua.

Toista sama ilman `user_id`-kenttää. Tämän **pitää onnistua**, ja rivin
omistajaksi tulee B, ei A:

```sql
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"<B_UUID>","role":"authenticated"}';

insert into public.tasks (id, date, title)
values ('rls-test-t3b', current_date, 'oma rivi');

select user_id = '<B_UUID>'::uuid as omistaja_on_b
from public.tasks where id = 'rls-test-t3b';

rollback;
```

**Odotus: `omistaja_on_b` = `true`.** Tämä todistaa, että
`default auth.uid()` toimii ja omistajuuden asettaa kanta, ei asiakas.

### T4 — Tili B ei voi muuttaa eikä poistaa tilin A rivejä

Tämä on `USING`-ehdon testi kirjoituspuolella. Sama varoitus kuin
T3:ssa: **aja koko lohko kerralla, se päättyy `rollback`-lauseeseen.**

```sql
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"<B_UUID>","role":"authenticated"}';

-- Yritetaan muuttaa KAIKKIA tehtavia. RLS rajaa nakyvat rivit,
-- joten taman pitaa koskea nollaa rivia.
update public.tasks set title = 'kaapattu';

-- Yritetaan poistaa kaikki tehtavat. Sama asia.
delete from public.tasks;

-- Yritetaan muuttaa tilin A profiilia.
update public.profile set age = 999;

rollback;
```

**Odotus: jokainen lause raportoi `UPDATE 0` tai `DELETE 0`.**

Nolla riviä on oikea tulos, ei virhe: RLS ei heitä poikkeusta `update`-
ja `delete`-lauseissa, vaan **rajaa rivit pois**. Rivi, jota ei näe, ei
ole rivi, jota voi muuttaa.

**Jos jokin lause raportoi enemmän kuin 0 riviä: pysäytä kaikki
välittömästi**, aja `rollback;`, ja palauta varmuuskopiosta jos et ole
varma että `rollback` ehti. Se tarkoittaisi, että tili B pystyi
muuttamaan toisen ihmisen dataa.

### T5 — Tili A ei menettänyt mitään, ja kirjautumaton ei näe mitään

Kirjaudu sovellukseen tilillä A.

```sql
select count(*) as tehtavia_a
from public.tasks
where user_id = '2cc00622-f927-4604-a518-361a4328481b'::uuid;
```

**Odotus: 36** — sama luku kuin valmistelun `a_ennen`.

Tarkista myös, ettei yksikään testirivi jäänyt kantaan:

```sql
select count(*) as testirivit
from public.tasks
where id in ('rls-test-t3', 'rls-test-t3b');
```

**Odotus: 0.** Jos tässä on rivi, jokin `rollback` ei mennyt läpi.
Poista rivi käsin ja selvitä miksi, ennen kuin jatkat.

Lopuksi kirjaudu ulos ja lataa sovellus uudelleen. Näkymän pitää olla
tyhjä ja kirjautumislomakkeen näkyvissä — **ei välähdystäkään** tilin A
datasta.

---

### PYSÄYTYS 5

| | Testi | Mitä todistaa |
|---|---|---|
| T1 | A näkee oman datansa | `USING` ei ole liian tiukka |
| T2 | B ei näe A:n tehtäviä eikä profiilia | `USING` estää lukemisen molemmissa omistajuusmalleissa |
| T3 | B ei voi kirjoittaa A:n nimiin; oma rivi saa omistajan kannasta | `WITH CHECK` ja `default auth.uid()` |
| T4 | B:n `update` ja `delete` koskevat nollaa riviä | `USING` estää myös kirjoittamisen |
| T5 | A:lla on yhä 36 tehtävää, testirivejä ei jäänyt, kirjautumaton ei näe mitään | ei sivuvaikutuksia, ei anon-pääsyä |

**Kaikkien viiden on toteuduttava.** Yksikin epäonnistuminen tarkoittaa,
että henkilökohtainen data on toisen käyttäjän saatavilla tai
muokattavissa. Pysäytä kaikki, älä käännä yhtäkään lippua, äläkä aja
yhtäkään muuta migraatiota ennen kuin syy on selvitetty.

Koko hyväksyntäportti G1–G10 on koottu yhteen taulukkoon:
[`PRODUCTION-PREFLIGHT.md`](PRODUCTION-PREFLIGHT.md), osa 3. **Vasta kun
kaikki kymmenen ovat tosia**, saa harkita skeemaporttien kääntämistä tai
siirtymistä migraatioon 0002.

### Testitilin siivous

Kirjaa ensin, montako riviä tilillä B on:

```sql
select count(*) as tehtavia_b
from public.tasks
where user_id = '<B_UUID>'::uuid;
```

Poista sitten tili B Supabasen **Authentication**-näkymästä.

`on delete cascade` vie sen tehtävät mukanaan — tämä on samalla ainoa
kerta, kun poistoketju tulee oikeasti testattua, joten tarkista tulos:

```sql
select count(*) filter (where user_id = '2cc00622-f927-4604-a518-361a4328481b'::uuid) as a_jalkeen,
       count(*) as kaikki_jalkeen
from public.tasks;
```

**Odotus: `a_jalkeen` = 36 ja `kaikki_jalkeen` = 36.**

Jos `a_jalkeen` putosi, poistoketju osui vääriin riveihin.
**Palauta varmuuskopiosta.**

Jos `kaikki_jalkeen` on suurempi kuin 36, tilin B rivit jäivät orvoiksi
eikä cascade toiminut. Se ei ole tietoturvaongelma, mutta se tarkoittaa,
ettei tilin poisto siivoa dataa — ks. `docs/ACCOUNT-DELETION.md`.

---

## Vaihe 6 — Migraatio 0002 (tasks-lisäkentät)

Aja `0002_task_domain_fields.sql`.

### PYSÄYTYS 6
Aja `supabase/verify/verify_0002.sql`. Kuusi saraketta olemassa,
`scheduling_state` ei null, kaksi tarkistetta olemassa.

---

## Vaihe 7 — Lippu `TASK_EXTENDED_FIELDS`

Vaihda `src/data/schema.js`:ssä `TASK_EXTENDED_FIELDS` arvoon `true`.
Aja `npm test`. Committoi.

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
