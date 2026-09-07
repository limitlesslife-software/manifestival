# Migraatiot 0004–0008 — tuotannon ajo-ohje

**Tila:** valmisteltu, EI AJETTU. Yksikään portti ei ole auki.

Tämä on koko erän ajo-ohje. Se on tarkoitettu luettavaksi kokonaan
ennen kuin ensimmäistäkään lausetta ajetaan, ja pidettäväksi auki ajon
ajan.

---

## Mitä tämä erä tekee

Viisi migraatiota, kahdeksan uutta taulua ja kolme uutta saraketta
tuotannon `tasks`-tauluun.

| # | Tiedosto | Taulut | Objekteja |
|---|----------|--------|-----------|
| 0004 | `0004_goals_projects.sql` | `goals`, `projects` + 3 saraketta `tasks`-tauluun | 36 (37 jos 0003 ajettu) |
| 0005 | `0005_notification_preferences.sql` | `notification_preferences` | 9 |
| 0006 | `0006_wellbeing.sql` | `wellbeing_entries` | 10 |
| 0007 | `0007_finance.sql` | `recurring_expenses`, `bills`, `savings_goals` + rajoite `tasks`-tauluun | 39 |
| 0008 | `0008_ai_audit.sql` | `ai_action_audit` | 11 |

Yhteensä **105 objektia** (106 jos 0003 on ajettu).

---

## Erän tärkein muutos: omistajuus on kannan vastuulla

Tämän erän valmistelussa löytyi vika, joka oli kirjattu aiempaan
versioon **hyväksyttynä riskinä**. Se ei ollut hyväksyttävä.

### Vika

Migraatioiden 0004 ja 0007 viitteet olivat tavallisia yhden sarakkeen
vierasavaimia:

```sql
goal_id text references public.goals(id) on delete set null
```

Se sallii ristiinkiinnityksen: käyttäjä B voi luoda **oman** tehtävänsä,
joka viittaa käyttäjän A tavoitteeseen.

> **RLS estää lukemisen, ei viittaamista.**

Vierasavaimen tarkistus ei kulje RLS:n läpi. Kanta katsoo, onko rivi
olemassa — ei sitä, saisiko viittaaja nähdä sen. Kun B lähettää rivin,
jossa `goal_id` on A:n tavoitteen tunniste, INSERT-politiikan `WITH
CHECK` vertaa vain omistajaa, ja omistaja on oikein: B.

Perustelut, joilla riski aiemmin hyväksyttiin, eivät kestä:

- *"tunnisteet ovat arvaamattomia"* — turvaa hämäryydellä, ja tunniste
  vuotaa jokaisessa jaetussa linkissä, viennissä ja virhelokissa
- *"sovellus tarjoaa valintaan vain omat rivit"* — sovellus on
  selaimessa. Kanta ei voi luottaa siihen mitä selaimessa ajetaan.

### Korjaus

Jokainen viittaus on **yhdistelmävierasavain**:

```sql
foreign key (user_id, goal_id) references public.goals (user_id, id)
  on delete set null (goal_id)
```

Kanta vaatii nyt, että viitattu rivi kuuluu samalle omistajalle. B:n
yritys päättyy virheeseen `23503` riippumatta siitä, mitä selaimessa
ajetaan.

Yhdeksän viitettä kolmessa migraatiossa:

| Viite | Migraatio |
|-------|-----------|
| `routine_exceptions.routine_id → routines` | 0003 |
| `goals.parent_goal_id → goals` | 0004 |
| `goals.project_id → projects` | 0004 |
| `projects.goal_id → goals` | 0004 |
| `tasks.goal_id → goals` | 0004 |
| `tasks.project_id → projects` | 0004 |
| `routines.goal_id → goals` | 0004 |
| `bills.task_id → tasks` | 0007 |
| `bills.recurring_expense_id → recurring_expenses` | 0007 |

Ne vaativat kohteelta yksikäsitteisyysrajoitteen `unique (user_id, id)`.
Sellainen lisätään viiteen tauluun, joista **`tasks` on tuotannon
taulu** — ks. alla.

### `on delete set null (sarake)` vaatii PostgreSQL 15:n

Ilman sarakelistaa PostgreSQL nollaisi **kaikki** vierasavaimen
sarakkeet, myös `user_id`, joka on `NOT NULL`. Silloin tavoitteen tai
tehtävän poistaminen kaatuisi joka kerta.

Sarakelista tuli PostgreSQL 15:ssa. Versio on tarkistettu esiehto
migraatioissa 0004 ja 0007 sekä molemmissa preflighteissä — sitä ei
jätetä parserin varaan.

---

## Toinen löydös: `touch_updated_at` olisi taantunut

Migraatiot 0005, 0006 ja 0007 sisälsivät

```sql
create or replace function public.touch_updated_at() ...
```

**ilman** määreitä `security invoker` ja `set search_path`. Migraatio
0002 loi funktion kovennettuna ja se on tuotannossa. Ajo olisi hiljaa
korvannut kovennetun funktion kovettamattomalla.

Kyseessä ei ole yhden taulun ongelma: sama funktio on liipaisimena myös
tauluissa `tasks`, `routines`, `goals` ja `projects`, ja se ajetaan
jokaisessa UPDATEssa. Kovennuksen menetys olisi näkynyt vain siinä,
mitä ei enää olisi ollut.

Funktio luodaan kerran migraatiossa 0002. Myöhemmät migraatiot
**tarkistavat** sen, eivät kirjoita sitä uudelleen.

---

## 0007 koskee tuotannon `tasks`-tauluun

Toisin kuin tiedoston aiempi versio väitti, 0007 ei luo vain uusia
tauluja. Se lisää rajoitteen tuotannon tauluun:

```sql
alter table public.tasks add constraint tasks_owner_row_key
  unique (user_id, id);
```

- **Ei voi kaatua dataan.** `id` on jo pääavain, joten pari
  `(user_id, id)` on väistämättä yksikäsitteinen. Preflight todistaa
  tämän erikseen.
- **Ottaa ACCESS EXCLUSIVE -lukon** ja rakentaa indeksin. Tuotannossa
  on kymmeniä rivejä, joten se kestää millisekunteja — mutta lukko on
  täysi, ja siksi jokaisessa migraatiossa on `set local lock_timeout`.
- **Jää pysyvästi.** Rollback ei poista sitä.

Sama koskee 0004:ää: se lisää `tasks`-tauluun kolme saraketta ja kaksi
vierasavainta.

---

## Ennen ajoa

Järjestys on merkitsevä. Älä ohita yhtään kohtaa.

1. **Varmuuskopio Supabasen omalla toiminnolla.** Tämä on eri asia kuin
   palautuskuva ja tehdään ensin.

2. **Palautuskuva:** aja `supabase/preflight/recovery_snapshot_pre_0004_0008.sql`.
   Kopioi koko tulos talteen. Se on looginen kuva rakenteesta ja
   mitoista; sillä todetaan palautuksen jälkeen, onko kanta siinä
   tilassa jossa se oli — vai jossain muussa joka vain näyttää
   toimivalta.

3. **Eräpreflight:** aja `supabase/preflight/preflight_0004_0008_batch.sql`.
   Jokaisen PASS/FAIL-rivin on oltava `PASS` ja `poikkeavia_yhteensa`
   nolla.

   INFO-rivit ovat kirjattavia lukuja, eivät esteitä. Kirjaa ne.

   > **Yksikin FAIL = erää ei aloiteta.**

4. **Tarkista rivi 08:** kertoo, onko 0003 ajettu. Se ratkaisee erän
   objektiluvun (105 vai 106) ja sen, syntyykö rutiinille viite
   tavoitteeseen.

### Oletusoikeudet — miksi preflight ei pysähdy niihin

Rivit 25 ja 26 kertovat, montako oletusoikeusmerkintää kannassa on
rooleille `anon` ja `PUBLIC`. Ne ovat **INFO**, eivät FAIL.

Supabase myöntää vakiona oletusoikeudet tuleville tauluille
(`ALTER DEFAULT PRIVILEGES`), joten uusi taulu voi syntyä avoimena.
Jokainen erän migraatio revokoi `PUBLIC`-, `anon`- ja
`authenticated`-roolit **ennen** grantia ja todistaa lopputuloksen
ennen committia. Rivit 27 ja 28 osoittavat, että sama malli on jo
kertaalleen sulkenut `tasks`- ja `profile`-taulut.

> **Älä aja `ALTER DEFAULT PRIVILEGES` -lausetta pelkästään näiden
> rivien takia.** Se muuttaisi koko kannan käytöstä laajemmin kuin erä
> vaatii.

---

## Ajo

Jokaiselle migraatiolle sama kolmen askeleen sykli. **Älä siirry
seuraavaan ennen kuin edellinen on vihreä.**

```
0004  →  preflight_0004.sql   →  0004_goals_projects.sql            →  verify_0004.sql
0005  →  preflight_0005.sql   →  0005_notification_preferences.sql  →  verify_0005.sql
0006  →  preflight_0006.sql   →  0006_wellbeing.sql                 →  verify_0006.sql
0007  →  preflight_0007.sql   →  0007_finance.sql                   →  verify_0007.sql
0008  →  preflight_0008.sql   →  0008_ai_audit.sql                  →  verify_0008.sql
```

Lopuksi: **`supabase/verify/verify_0004_0008_final.sql`**.

### Mitä migraatio tekee itse

Jokainen migraatio on **fail-closed**. Se ei ole idempotentti, ja se on
tarkoitus: `if not exists` tekisi tuoreesta ajosta, toisesta ajosta ja
kesken jääneestä ajosta saman näköisiä. Tila, jota ei voi erottaa, on
tila jota ei voi korjata.

Migraatio laskee objektinsa ja **keskeytyy**, jos yksikin niistä on jo
olemassa:

- `Migraatio 000X on JO AJETTU` → älä aja uudelleen, aja varmistus
- `Migraatio 000X on kesken: N objektia M:sta on jo olemassa (...)` →
  ks. kyseisen migraation palautusdokumentti

Se tarkistaa myös esiehdot (0001, 0002, hyväksytty omistaja, datan
eheys, palvelimen versio) ja ajaa loppuvarmistuksen **ennen committia**
— viimeisen hetken, jolloin virheellinen tulos voidaan perua ilman
jälkiä.

### Jos migraatio keskeytyy

Transaktio peruuntuu kokonaan. Kannassa ei ole puolikasta migraatiota.
Lue virheilmoitus, korjaa syy, aja preflight uudelleen.

`lock_timeout = 5s` tarkoittaa, että migraatio luovuttaa jos taulu on
lukittuna. Se ei ole vika vaan suoja: lukkojono on FIFO, ja jonoon
jäänyt migraatio jumittaisi taakseen jokaisen kirjautumisen ja jokaisen
tehtävän luvun. Odota, että pitkä transaktio päättyy, ja yritä
uudelleen.

---

## Ajon jälkeen — ennen porttien avaamista

Migraatiot ovat ajettu, mutta **yhtäkään porttia ei vielä käännetä.**

Varmistus todistaa rakenteen. Se ei todista, että RLS toimii oikeiden
käyttäjien välillä — sen todistaa vain kaksi oikeaa kirjautunutta
tiliä.

### 1. Hyväksyntätesti

`tools/rls-acceptance` ajetaan selaimessa **kahdella oikealla
tilillä**: tuotannon tili A ja väliaikainen tili B.

- **271 tarkistusta**, joista **16 on ristiinkiinnityshyökkäyksiä** —
  kahdeksan viitettä, INSERT ja UPDATE kumpaakin kohti.
- Ohjeet: `docs/RLS-ACCEPTANCE.md`.
- Testi luo ja poistaa omat rivinsä. Se ei koske A:n oikeaan dataan.

> Tili B luodaan vasta tässä vaiheessa, ja se poistetaan heti testin
> jälkeen.

Odotettu tulos: jokainen rivi `PASS`, siivousosuus `PASS`.

Erityisesti:

- **X1–X8** (INSERT-hyökkäykset) ja **U1–U8** (UPDATE-hyökkäykset):
  jokaisen on hylättävä koodilla **23503**. Koodi on osa väitettä —
  `42501` tarkoittaisi, että RLS torjui rivin, jolloin suoja riippuisi
  politiikasta eikä rakenteesta.
- **X9**: B:n tehtävän liittäminen B:n **omaan** tavoitteeseen on
  onnistuttava. Ilman sitä kaikki kiellot voisivat mennä läpi siksi,
  että viitteet ovat rikki kaikilta.

### 2. Poista tili B

Supabasen Authentication-näkymästä. Poisto on `ON DELETE CASCADE`
kaikissa kymmenessä taulussa.

### 3. Jäännösvarmistus

Aja `supabase/acceptance/verify_0003_0008_acceptance.sql`.

Tämä on **ainoa paikka, josta jäännöksen voi nähdä**. Selaimessa ajettu
testi katsoo kantaa RLS:n läpi eikä voi nähdä, jäikö toisen tilin rivi
kantaan — RLS piilottaisi juuri sen rivin, jota etsitään.

Jokaisen rivin on oltava `PASS`.

---

## Porttien avaaminen

Vasta kun **kaikki** seuraavat ovat vihreitä:

- [ ] `verify_0004.sql` … `verify_0008.sql`
- [ ] `verify_0004_0008_final.sql`
- [ ] hyväksyntätesti, kaikki 271 tarkistusta
- [ ] tili B poistettu
- [ ] `verify_0003_0008_acceptance.sql`

Portit ovat `src/data/schema.js`:

```js
routines, routineExceptions,          // 0003
goals, projects,                      // 0004
notificationPreferences,              // 0005
wellbeing,                            // 0006
bills, recurringExpenses, savingsGoals, // 0007
aiAudit                               // 0008
```

**Käännä ne yksi kerrallaan.** Jokaisen jälkeen:

1. `npm test` läpi
2. bumppaa `CACHE_VERSION` — se on ainoa asia, joka saa selaimen
   asentamaan uuden service workerin ja hakemaan kuoren uudelleen
3. deploy
4. kokeile ominaisuutta tuotannossa
5. vasta sitten seuraava portti

Portin kääntäminen vaihtaa muistivaraston tietokantaan. Jos jokin on
väärin, se näkyy heti — mutta vain siinä ominaisuudessa, jonka portin
juuri avasit. Siksi yksi kerrallaan.

---

## Palautuminen

Migraatiokohtaiset ohjeet:

- `docs/MIGRATION-0004-RECOVERY.md`
- `docs/MIGRATION-0005-RECOVERY.md`
- `docs/MIGRATION-0006-RECOVERY.md`
- `docs/MIGRATION-0007-RECOVERY.md`
- `docs/MIGRATION-0008-RECOVERY.md`

Rollback-lauseet ovat jokaisen migraation lopussa kommentteina.

**Kaksi asiaa, joita rollback ei poista:**

1. `tasks_owner_row_key` — se on oikea rajoite riippumatta siitä,
   viittaako siihen mikään. Poistaminen olisi erillinen harkittu muutos.
2. `public.touch_updated_at()` — se on migraation 0002 objekti.

Jos kanta palautetaan varmuuskopiosta, aja
`recovery_snapshot_pre_0004_0008.sql` uudelleen ja vertaa riveittäin
ennen ajoa otettuun kuvaan. Ero missä tahansa rivissä tarkoittaa, ettei
palautus ole valmis.

Erityisesti rivit 23–30 (turvamalli): RLS voi palautua pois päältä
ilman että mikään kaatuu. Ensimmäinen merkki olisi se, että joku näkee
toisen ihmisen tiedot.

---

## Mitä tämä paketti EI todista

Rehellisyyden vuoksi:

- **Ei todista, että migraatiot ajautuvat läpi.** Niitä ei ole ajettu
  missään. Testit lukevat SQL:n tekstinä; ne eivät ole tietokanta.
- **Ei todista, että RLS toimii tuotannossa.** Sen todistaa vain
  hyväksyntätesti kahdella oikealla tilillä.
- **Ei todista, että sovellus toimii porttien auettua.** Portin takana
  data on muistissa; kannan kautta se käyttäytyy eri tavalla.
  Sopimustestit vertaavat sarakkeita, eivät ajonaikaista käytöstä.
- **Ei kata suorituskykyä.** Indeksit on valittu tunnetuille kyselyille,
  mutta niitä ei ole mitattu oikealla datamäärällä.

---

## Seuraava askel

Tämä erä on valmis ajettavaksi. Seuraava toimenpide on **ihmisen**:
varmuuskopio, palautuskuva ja eräpreflight — siinä järjestyksessä.
