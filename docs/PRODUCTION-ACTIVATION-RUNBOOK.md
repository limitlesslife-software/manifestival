# Tuotannon aktivoinnin runbook

**Tämän ajaa ihminen. Ei agentti, ei skripti, ei CI.**

Jokainen vaihe on erillinen päätös. Vaiheiden välissä on PYSÄYTYS, jossa
on tarkoitus katsoa tulos ja päättää jatketaanko. **Ei ole olemassa
"aja kaikki migraatiot" -vaihetta eikä sellaista pidä rakentaa.**

Liittyvät: [`MIGRATION-MAP.md`](MIGRATION-MAP.md) ·
[`PRODUCTION-ACTIVATION-GATE.md`](PRODUCTION-ACTIVATION-GATE.md)

Varmistuskyselyt: `supabase/verify/` — **vain lukevia**, ei yhtään
`insert`, `update`, `delete` tai `alter`.

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

Ota Supabasen kautta täysi varmuuskopio. Kirjaa aikaleima muistiin.

**0001 ei ole peruttavissa ilman tätä.** Se siirtää olemassa olevan datan
omistajuuden. Jos siirto menee pieleen eikä varmuuskopiota ole, dataa ei
saa takaisin.

### PYSÄYTYS 1
Varmuuskopio on olemassa ja sen aikaleima on kirjattu.
Jos ei: **älä jatka.**

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

Lue tuloslokista `NOTICE`-rivit. Niiden pitää kertoa:
- `Esiehdot kunnossa. Omistaja 2cc00622-…, tehtavia 36, profiileja 1.`
- montako vanhaa politiikkaa poistettiin
- `Lopputila kunnossa: 8 politiikkaa, RLS paalla, anon ilman oikeuksia.`

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
Aja `supabase/verify/verify_0001.sql`. Odotusarvot ovat täsmällisiä:

| Kohta | Odotus |
|---|---|
| RLS | `true` molemmilla |
| Politiikkoja | **tasan 8**, jokaisen rooli `{authenticated}` |
| `tasks.user_id` | `uuid`, `NO`, oletus `auth.uid()` |
| `profile.id` | `uuid`, `NO`, oletus `auth.uid()` |
| `profile.legacy_id` | `text`, `YES` — sisältää yhä `me` |
| Rivimäärät | `tasks` 36, `profile` 1 |
| Omistajuus | molemmat `bool_and` = `true` |
| Eri omistajia | 1 |
| Orvot viitteet | 0 ja 0 |
| Vierasavaimet | 2 riviä, `confdeltype = c` |
| `anon`-oikeudet | **nolla riviä** |
| `authenticated`-oikeudet | tasan 8 riviä |

Jos rivimäärä muuttui: **palauta varmuuskopiosta.** Migraatio ei saa
hävittää yhtään riviä.

Jos `anon`-oikeuksissa on yksikin rivi: **älä jatka.** Julkinen avain on
selaimessa, ja anonin oikeus tekee RLS:stä ainoan esteen.

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

### Valmistelu

Luo **tili B** sovelluksen kirjautumisnäkymästä. Käytä oikeaa
sähköpostiosoitetta, johon pääset käsiksi — Supabase vaatii
vahvistuksen. Älä käytä tilin A osoitetta.

Kirjaa tilin B tunniste talteen:

```sql
select id, email from auth.users order by created_at;
```

Tilin A tunnisteen pitää olla `2cc00622-f927-4604-a518-361a4328481b`.

### T1 — Tili B ei näe tilin A tehtäviä

Kirjaudu sisään tilillä B. Avaa päivänäkymä ja siirry siihen
päivämäärään, jolla tiedät tilillä A olevan tehtäviä.

**Odotus: nolla tehtävää. Ei yhtään.**

Jos näkyy yksikin tilin A tehtävä: **RLS ei ole voimassa.** Pysäytä
kaikki. Älä käännä lippuja. Palaa PYSÄYTYS 3:n varmistuskyselyyn ja
katso, mikä sen kohdista oli väärin.

### T2 — Tili B ei näe tilin A profiilia

Avaa profiiliasetukset tilillä B. Kenttien pitää olla tyhjiä tai
oletusarvoisia — **ei tilin A ikää, painoa eikä heräämisaikaa.**

Tämä on erillinen tarkistus, koska `profile` käyttää eri
omistajuusmallia kuin `tasks`: omistajuus on `id`-sarakkeessa, ei
`user_id`-sarakkeessa. Yksi näistä voi toimia ilman että toinen toimii.

### T3 — Tili B ei voi kirjoittaa tilin A datan päälle

Luo tilillä B tehtävä. Palaa tilille A ja tarkista, **ettei tilin B
tehtävä näy siellä.**

Sen jälkeen SQL-editorissa:

```sql
select count(*) as tehtavia_b
from public.tasks
where user_id <> '2cc00622-f927-4604-a518-361a4328481b'::uuid;
```

Luvun pitää olla tasan se määrä tehtäviä, jonka loit tilillä B.

### T4 — Tili A ei menettänyt mitään

Kirjaudu takaisin tilille A. Kaikkien 36 tehtävän pitää olla paikallaan
ja profiilin arvojen ennallaan.

```sql
select count(*) as tehtavia_a
from public.tasks
where user_id = '2cc00622-f927-4604-a518-361a4328481b'::uuid;
```

**Odotus: 36.**

### T5 — Kirjautumaton ei näe mitään

Kirjaudu ulos. Lataa sovellus uudelleen. Näkymän pitää olla tyhjä ja
kirjautumislomakkeen näkyvissä — ei välähdystäkään tilin A datasta.

### PYSÄYTYS 5

| | |
|---|---|
| T1 | Tili B ei näe tilin A tehtäviä |
| T2 | Tili B ei näe tilin A profiilia |
| T3 | Tilien data pysyy erillään molempiin suuntiin |
| T4 | Tili A:lla on yhä 36 tehtävää |
| T5 | Kirjautumaton ei näe mitään |

**Kaikkien viiden on toteuduttava.** Yksikin epäonnistuminen tarkoittaa,
että henkilökohtainen data on toisen käyttäjän saatavilla. Pysäytä
kaikki, älä käännä yhtäkään lippua, äläkä aja yhtäkään muuta
migraatiota ennen kuin syy on selvitetty.

### Testitilin siivous

Kun kaikki viisi kohtaa ovat vihreitä, poista tili B Supabasen
Authentication-näkymästä. `on delete cascade` vie sen tehtävät mukanaan
— se on samalla ainoa kerta, kun poistoketju tulee oikeasti testattua.

Tarkista poiston jälkeen, että tilin A luku on yhä 36:

```sql
select count(*) as tehtavia_a
from public.tasks
where user_id = '2cc00622-f927-4604-a518-361a4328481b'::uuid;
```

Jos luku putosi, poistoketju osui vääriin riveihin. **Palauta
varmuuskopiosta.**

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
Aja `verify_0004.sql`. Tarkista erityisesti: **kaikki neljä
vierasavainta ovat `SET NULL`, ei yksikään `CASCADE`.** Jos jokin on
cascade, tavoitteen poisto veisi tehtävät mukanaan.

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
Tämä on mahdollista ilman varmuuskopiota, koska alkuperäinen `me` säilyy
sarakkeessa `profile.legacy_id`. Migraatio ei pudota sitä.

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
