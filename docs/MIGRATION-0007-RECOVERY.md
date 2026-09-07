# Migraatio 0007 — laskut, toistuvat kulut ja säästötavoitteet

**Tila:** valmisteltu, EI AJETTU. Portit `bills`, `recurringExpenses` ja `savingsGoals` ovat `false`.

Koko erän ajo-ohje on `docs/MIGRATIONS-0004-0008-PRODUCTION-RUNBOOK.md`.
Tämä dokumentti vastaa yhteen kysymykseen: **mitä tehdä, kun jokin menee
pieleen.**

---

## Mitä 0007 tekee

Luo taulut `recurring_expenses`, `bills` ja `savings_goals`, ja lisää
tuotannon `tasks`-tauluun rajoitteen `tasks_owner_row_key`.

| Objekti | Määrä |
|---------|-------|
| taulut | 3 |
| rajoitteet | 17 |
| indeksit | 4 |
| liipaisimet | 3 |
| politiikat | 12 |

Yhteensä **39 objektia**.

---

## Mitä tässä migraatiossa on erityistä

### Tämä migraatio koskee tuotannon `tasks`-tauluun

```sql
alter table public.tasks add constraint tasks_owner_row_key
  unique (user_id, id);
```

Rajoite on välttämätön, koska `bills.task_id` on yhdistelmävierasavain ja
PostgreSQL vaatii kohteelta yksikäsitteisyysrajoitteen.

- **Ei voi kaatua dataan:** `id` on jo pääavain, joten pari
  `(user_id, id)` on väistämättä yksikäsitteinen. Preflight todistaa
  tämän erikseen ennen ajoa.
- **Ottaa ACCESS EXCLUSIVE -lukon** ja rakentaa indeksin.
- **Jää pysyvästi.** Rollback ei poista sitä, koska se on oikea rajoite
  riippumatta siitä viittaako siihen mikään.

### Raha on kokonaisluku

Summat ovat sentteinä `bigint`-sarakkeina. Liukuluku ei esitä
desimaalimurtolukuja tarkasti ja virhe kertautuu summattaessa; `numeric`
olisi tarkka, mutta se palautuu JavaScriptiin merkkijonona tai
liukulukuna ajurin mukaan — ja juuri se muunnos on se kohta, jossa
sentit katoavat.

Migraatio varmistaa ennen committia, että kaikki neljä summasaraketta
ovat `bigint`.

### Vaatii PostgreSQL 15:n

Samasta syystä kuin 0004: `on delete set null (task_id)`.

---

## Ennen ajoa

1. Varmuuskopio Supabasen omalla toiminnolla
2. `supabase/preflight/recovery_snapshot_pre_0004_0008.sql` (kerran koko erälle)
3. `supabase/preflight/preflight_0004_0008_batch.sql` (kerran koko erälle)
4. `supabase/preflight/preflight_0007.sql` (juuri ennen tätä migraatiota)

Yksikin FAIL = migraatiota ei ajeta.

---

## Palautuminen tilanteittain

### CASE A — 0007 kaatuu transaktion sisällä

**Mitään ei ole tapahtunut.** Migraatio on yksi transaktio: kaatuminen
peruuttaa sen kokonaan, eikä kannassa ole puolikasta migraatiota.

Lue virheilmoitus. Se kertoo syyn suoraan:

| Viesti | Syy |
|--------|-----|
| `Migraatio 0001 pitaa ajaa ensin` | esiehto puuttuu |
| `tasks-taulussa on N politiikkaa, odotettiin 4` | 0001:n tila ei ole odotettu |
| `Migraatio 0002 puuttuu` | 0002:n sarakkeita ei ole |
| `Hyvaksyttya omistajaa ... ei loydy` | **väärä projekti** — pysähdy |
| `PostgreSQL ... on liian vanha` | palvelin ei tue sarakelistaa |
| `lock_timeout` / `canceling statement` | taulu oli lukittuna |

Korjaa syy, aja preflight uudelleen, aja migraatio uudelleen.

### CASE B — `Migraatio 0007 on JO AJETTU`

Migraatio on ajettu kokonaan. **Älä aja uudelleen.** Aja
`supabase/verify/verify_0007.sql` ja jatka siitä.

### CASE B2 — `Migraatio 0007 on kesken: N objektia 39:sta`

Tämä on ainoa tila, joka vaatii harkintaa. Se tarkoittaa, että osa
objekteista on olemassa ja osa ei.

Virheilmoitus **luettelee löytyneet objektit nimeltä**. Se kertoo, mihin
asti aiempi ajo pääsi.

Koska migraatio on yksi transaktio, tämä tila ei synny kaatumisesta. Se
syntyy siitä, että objekteja on luotu **käsin** tai jokin muu migraatio
on luonut samannimisiä.

Toimi näin:

1. Älä aja migraatiota uudelleen — se keskeytyy joka tapauksessa
2. Selvitä nimetyistä objekteista, mistä ne ovat peräisin
3. Jos ne ovat tämän migraation jäänteitä, aja rollback alta ja aloita
   alusta
4. Jos et tunnista niitä, **pysähdy** — kanta ei ole siinä tilassa jota
   tämä migraatio olettaa

### CASE C — portit käännetty, mutta laskuja ei ole luotu

Käännä portit takaisin `false`:ksi ja bumppaa `CACHE_VERSION`.

### CASE D — laskuja, kuluja tai säästötavoitteita on jo luotu

**Rollback kadottaa ne.** Ota vienti talteen ensin:

```sql
select id, name, amount_minor, currency, due_date, status, paid_date
  from public.bills order by due_date;
select id, name, amount_minor, currency, cadence, next_due_date, active
  from public.recurring_expenses order by next_due_date;
select id, name, target_minor, current_minor, currency, target_date
  from public.savings_goals order by id;
```

Poistojärjestys on merkitsevä: `bills` ensin, koska se viittaa sekä
tehtäviin että toistuviin kuluihin.

### CASE E — vain `tasks_owner_row_key` halutaan pois

Se ei kuulu rollbackiin, koska rajoite on oikea sinänsä. Jos se silti on
poistettava, tarkista ensin ettei yksikään yhdistelmävierasavain viittaa
`tasks`-tauluun:

```sql
select conname from pg_constraint
 where confrelid = 'public.tasks'::regclass and contype = 'f';
```

Jos tuloksia on, rajoitteen poisto epäonnistuu — ja se on oikein.

---

## Rollback

Poisto kadottaa kaikki laskut, kulut ja säästötavoitteet. Ota
varmuuskopio ensin.

```sql
begin;
set local lock_timeout = '5s';
drop table if exists public.bills;            -- viittaa kuluihin ja tehtäviin
drop table if exists public.savings_goals;
drop table if exists public.recurring_expenses;
commit;
```

Rollback EI poista rajoitetta tasks_owner_row_key eikä funktiota
public.touch_updated_at():
  * tasks_owner_row_key on oikea rajoite riippumatta siitä, viittaako
    siihen mikään. Sen poistaminen olisi erillinen harkittu muutos.
  * touch_updated_at on migraation 0002 objekti, ei tämän.

Muista tällöin palauttaa src/data/schema.js -> TABLES.bills = false,
TABLES.recurringExpenses = false, TABLES.savingsGoals = false.

Muista kääntää portit `bills`, `recurringExpenses` ja `savingsGoals` takaisin `false`:ksi tiedostossa
`src/data/schema.js` ja bumpata `CACHE_VERSION`.

---

## Mitä 0007 ei riko

- **Ei muuta olemassa olevia rivejä.** Migraatio todistaa tämän ennen
  committia.
- **Ei kosketa migraatioiden 0001–0002 politiikkoihin eikä RLS:ään.**
- **Ei luo eikä korvaa funktiota `public.touch_updated_at()`.** Se on
  migraation 0002 objekti; tämä migraatio vain tarkistaa, että se on yhä
  kovennettu.

---

## Seuraava askel

Kun `verify_0007.sql` on vihreä, jatka runbookin mukaan seuraavaan
migraatioon. **Porttia ei käännetä ennen kuin koko erä on ajettu,
`verify_0004_0008_final.sql` on vihreä ja hyväksyntätesti on ajettu
oikealla käyttäjällä B.**
