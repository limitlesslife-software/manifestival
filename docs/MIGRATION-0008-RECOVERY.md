# Migraatio 0008 — AI-toimintojen kirjausketju

**Tila:** valmisteltu, EI AJETTU. Portit `aiAudit` ovat `false`.

Koko erän ajo-ohje on `docs/MIGRATIONS-0004-0008-PRODUCTION-RUNBOOK.md`.
Tämä dokumentti vastaa yhteen kysymykseen: **mitä tehdä, kun jokin menee
pieleen.**

---

## Mitä 0008 tekee

Luo taulun `ai_action_audit`: mitä AI ehdotti, mitä käyttäjä vahvisti ja
mitä oikeasti tapahtui.

| Objekti | Määrä |
|---------|-------|
| taulut | 1 |
| rajoitteet | 5 |
| indeksit | 1 |
| politiikat | 4 |

Yhteensä **11 objektia**.

---

## Mitä tässä migraatiossa on erityistä

### Keskeinen invariantti testataan ajon aikana

```sql
check (executed = false or confirmed = true)
```

Kirjaus ei saa väittää, että komento suoritettiin ilman vahvistusta.
Migraatio **kokeilee tätä oikealla insertillä** ennen committia ja vaatii
että rajoite hylkää sen; yritys perutaan, eikä rivi päädy tauluun edes
hetkeksi.

### `target_id` ei ole vierasavain — eikä siitä saa tehdä sellaista

Kirjaus kertoo mitä tapahtui, ja yleisin kirjattava tapahtuma on
**poisto**. Vierasavain joko poistaisi kirjauksen kohteen mukana
(cascade) tai tyhjentäisi sen (set null), ja kummassakin tapauksessa
juuri se tieto katoaisi, jonka takia loki on olemassa.

Tämä ei ole sama aukko kuin 0004:ssä. Siellä B pystyi **kiinnittämään**
oman rivinsä A:n riviin — luomaan kannan tasolla suhteen, jota ei pitäisi
olla. Tässä suhdetta ei ole: `target_id` on tekstikenttä B:n omalla
rivillä, jonka vain B näkee.

### Raakaa syötettä ei tallenneta

`input_summary` on rajattu 200 merkkiin ja `proposal` 300:aan **kannassa
asti**, koska sovellusvirhe ei saa johtaa siihen että koko
päiväkirjamerkintä päätyy tietokantaan.

### Ei liipaisinta

Taulussa on vain `created_at`, ei `updated_at`. Kirjaus ei muutu
jälkikäteen — muokattava kirjausketju ei ole kirjausketju.

---

## Ennen ajoa

1. Varmuuskopio Supabasen omalla toiminnolla
2. `supabase/preflight/recovery_snapshot_pre_0004_0008.sql` (kerran koko erälle)
3. `supabase/preflight/preflight_0004_0008_batch.sql` (kerran koko erälle)
4. `supabase/preflight/preflight_0008.sql` (juuri ennen tätä migraatiota)

Yksikin FAIL = migraatiota ei ajeta.

---

## Palautuminen tilanteittain

### CASE A — 0008 kaatuu transaktion sisällä

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

### CASE B — `Migraatio 0008 on JO AJETTU`

Migraatio on ajettu kokonaan. **Älä aja uudelleen.** Aja
`supabase/verify/verify_0008.sql` ja jatka siitä.

### CASE B2 — `Migraatio 0008 on kesken: N objektia 11:sta`

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

### CASE C — portti käännetty, mutta kirjauksia ei ole syntynyt

Käännä portti takaisin `false`:ksi ja bumppaa `CACHE_VERSION`.

### CASE D — kirjauksia on jo syntynyt

Rollback kadottaa ne. Kirjausketju on käyttäjän oma loki hänen omista
toimistaan; sen menettäminen ei riko mitään toiminnallisuutta, mutta se
poistaa vastauksen kysymykseen "miksi tämä muuttui?".

Vienti ilman käyttäjän omaa tekstiä:

```sql
select id, occurred_at, intent, risk, target_type, confirmed, executed, result
  from public.ai_action_audit order by occurred_at;
```

Sarakkeita `input_summary` ja `proposal` ei viedä ilman erillistä syytä:
ne ovat käyttäjän omaa tekstiä, ja koko taulun tarkoitus on rajata sen
määrää.

---

## Rollback



```sql
begin;
set local lock_timeout = '5s';
drop table if exists public.ai_action_audit;
commit;
```

Muista tällöin palauttaa src/data/schema.js -> TABLES.aiAudit = false.

Muista kääntää portit `aiAudit` takaisin `false`:ksi tiedostossa
`src/data/schema.js` ja bumpata `CACHE_VERSION`.

---

## Mitä 0008 ei riko

- **Ei muuta olemassa olevia rivejä.** Migraatio todistaa tämän ennen
  committia.
- **Ei kosketa migraatioiden 0001–0002 politiikkoihin eikä RLS:ään.**
- **Ei luo eikä korvaa funktiota `public.touch_updated_at()`.** Se on
  migraation 0002 objekti; tämä migraatio vain tarkistaa, että se on yhä
  kovennettu.

---

## Seuraava askel

Kun `verify_0008.sql` on vihreä, jatka runbookin mukaan seuraavaan
migraatioon. **Porttia ei käännetä ennen kuin koko erä on ajettu,
`verify_0004_0008_final.sql` on vihreä ja hyväksyntätesti on ajettu
oikealla käyttäjällä B.**
