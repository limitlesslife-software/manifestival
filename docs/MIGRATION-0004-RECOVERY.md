# Migraatio 0004 — tavoitteet, projektit ja määräajat

**Tila:** valmisteltu, EI AJETTU. Portit `goals` ja `projects` ovat `false`.

Koko erän ajo-ohje on `docs/MIGRATIONS-0004-0008-PRODUCTION-RUNBOOK.md`.
Tämä dokumentti vastaa yhteen kysymykseen: **mitä tehdä, kun jokin menee
pieleen.**

---

## Mitä 0004 tekee

Luo taulut `goals` ja `projects`, lisää `tasks`-tauluun sarakkeet
`deadline`, `goal_id` ja `project_id`, ja kytkee ne toisiinsa kuudella
yhdistelmävierasavaimella.

| Objekti | Määrä |
|---------|-------|
| taulut | 2 |
| sarakkeet `tasks`-tauluun | 3 |
| rajoitteet | 18 |
| indeksit | 4 |
| liipaisimet | 2 |
| politiikat | 8 |

Yhteensä **36 tai 37 objektia**.

---

## Mitä tässä migraatiossa on erityistä

### Tämä migraatio koskee tuotannon `tasks`-tauluun

Se lisää kolme saraketta ja kaksi vierasavainta, ja ottaa siihen ACCESS
EXCLUSIVE -lukon. Sarakkeet ovat nullable ilman oletusarvoa, joten
olemassa olevat rivit eivät muutu — migraatio todistaa sen ennen
committia.

### Vaatii PostgreSQL 15:n

Poistotoiminto on `on delete set null (goal_id)` — sarakelista suluissa.
Ilman sitä PostgreSQL nollaisi myös `user_id`:n, joka on `NOT NULL`, ja
tavoitteen poisto kaatuisi joka kerta. Versio on tarkistettu esiehto.

### Objektiluku riippuu 0003:sta

Jos 0003 on ajettu, migraatio luo lisäksi viitteen
`routines.goal_id → goals` — silloin objekteja on 37, muuten 36.
Migraatio laskee odotuksen kannan tilasta eikä kirjoita sitä vakiona.

---

## Ennen ajoa

1. Varmuuskopio Supabasen omalla toiminnolla
2. `supabase/preflight/recovery_snapshot_pre_0004_0008.sql` (kerran koko erälle)
3. `supabase/preflight/preflight_0004_0008_batch.sql` (kerran koko erälle)
4. `supabase/preflight/preflight_0004.sql` (juuri ennen tätä migraatiota)

Yksikin FAIL = migraatiota ei ajeta.

---

## Palautuminen tilanteittain

### CASE A — 0004 kaatuu transaktion sisällä

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

### CASE B — `Migraatio 0004 on JO AJETTU`

Migraatio on ajettu kokonaan. **Älä aja uudelleen.** Aja
`supabase/verify/verify_0004.sql` ja jatka siitä.

### CASE B2 — `Migraatio 0004 on kesken: N objektia 36 tai 37:sta`

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

### CASE C — portit käännetty, mutta tavoitteita ei ole luotu

Käännä portit takaisin `false`:ksi ja bumppaa `CACHE_VERSION`. Mitään ei
ole menetetty: taulut ovat tyhjiä.

### CASE D — tavoitteita tai projekteja on jo luotu

Rollback poistaa ne. Ota vienti talteen ensin, jos ne halutaan säilyttää:

```sql
select id, title, status, target_date from public.goals order by id;
select id, name, status, deadline from public.projects order by id;
```

Huomaa, että `tasks.goal_id` ja `tasks.project_id` nollautuvat
tavoitteen tai projektin poistuessa (`on delete set null`). Tehtävät
säilyvät — vain liitos katoaa.

---

## Rollback



```sql
begin;
set local lock_timeout = '5s';
alter table public.tasks
  drop constraint if exists tasks_goal_id_fkey,
  drop constraint if exists tasks_project_id_fkey;
drop index if exists public.tasks_user_goal_idx;
drop index if exists public.tasks_user_deadline_idx;
alter table public.tasks
  drop column if exists deadline,
  drop column if exists goal_id,
  drop column if exists project_id;
alter table public.routines drop constraint if exists routines_goal_id_fkey;
-- goals ja projects viittaavat toisiinsa, joten viite on purettava
-- ennen pudotusta.
alter table public.goals drop constraint if exists goals_project_id_fkey;
drop table if exists public.projects;
drop table if exists public.goals;
commit;
```

Rollback EI poista routines_owner_row_key -rajoitetta: se on migraation
0003 objekti eikä tämän.

Muista tällöin palauttaa src/data/schema.js -> TABLES.goals = false ja
TABLES.projects = false.

Muista kääntää portit `goals` ja `projects` takaisin `false`:ksi tiedostossa
`src/data/schema.js` ja bumpata `CACHE_VERSION`.

---

## Mitä 0004 ei riko

- **Ei muuta olemassa olevia rivejä.** Migraatio todistaa tämän ennen
  committia.
- **Ei kosketa migraatioiden 0001–0002 politiikkoihin eikä RLS:ään.**
- **Ei luo eikä korvaa funktiota `public.touch_updated_at()`.** Se on
  migraation 0002 objekti; tämä migraatio vain tarkistaa, että se on yhä
  kovennettu.

---

## Seuraava askel

Kun `verify_0004.sql` on vihreä, jatka runbookin mukaan seuraavaan
migraatioon. **Porttia ei käännetä ennen kuin koko erä on ajettu,
`verify_0004_0008_final.sql` on vihreä ja hyväksyntätesti on ajettu
oikealla käyttäjällä B.**
