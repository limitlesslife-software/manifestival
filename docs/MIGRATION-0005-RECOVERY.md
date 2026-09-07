# Migraatio 0005 — muistutusasetukset

**Tila:** valmisteltu, EI AJETTU. Portit `notificationPreferences` ovat `false`.

Koko erän ajo-ohje on `docs/MIGRATIONS-0004-0008-PRODUCTION-RUNBOOK.md`.
Tämä dokumentti vastaa yhteen kysymykseen: **mitä tehdä, kun jokin menee
pieleen.**

---

## Mitä 0005 tekee

Luo taulun `notification_preferences`: yksi rivi per käyttäjä,
oletuksena `enabled = false`.

| Objekti | Määrä |
|---------|-------|
| taulut | 1 |
| rajoitteet | 3 |
| liipaisimet | 1 |
| politiikat | 4 |

Yhteensä **9 objektia**.

---

## Mitä tässä migraatiossa on erityistä

### Omistajuusmalli on eri kuin muiden

Omistaja ei ole erillinen `user_id`-sarake vaan pääavain itse:

```sql
id uuid primary key default auth.uid() references auth.users(id)
```

Politiikat kohdistuvat siksi `id`-sarakkeeseen, kuten `profile`-taulussa.
Taulussa ei ole yhtään viitettä toiseen sovellustauluun, joten
yhdistelmävierasavainta ei tarvita — migraatio varmistaa tämän väitteen
ennen committia.

### Hiljaisuus on oletus

`enabled` on `false`. Jos se olisi `true`, jokainen uusi käyttäjä alkaisi
saada ilmoituksia pyytämättä. Se ei olisi virhe jonka käyttäjä
ilmoittaisi — se olisi syy poistaa sovellus.

### Ei koske olemassa olevaan dataan

Migraatio luo yhden uuden taulun.

---

## Ennen ajoa

1. Varmuuskopio Supabasen omalla toiminnolla
2. `supabase/preflight/recovery_snapshot_pre_0004_0008.sql` (kerran koko erälle)
3. `supabase/preflight/preflight_0004_0008_batch.sql` (kerran koko erälle)
4. `supabase/preflight/preflight_0005.sql` (juuri ennen tätä migraatiota)

Yksikin FAIL = migraatiota ei ajeta.

---

## Palautuminen tilanteittain

### CASE A — 0005 kaatuu transaktion sisällä

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

### CASE B — `Migraatio 0005 on JO AJETTU`

Migraatio on ajettu kokonaan. **Älä aja uudelleen.** Aja
`supabase/verify/verify_0005.sql` ja jatka siitä.

### CASE B2 — `Migraatio 0005 on kesken: N objektia 9:sta`

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

### CASE C — portti käännetty, mutta asetuksia ei ole tallennettu

Käännä portti takaisin `false`:ksi ja bumppaa `CACHE_VERSION`. Asetukset
palaavat muistivarastoon ja saavat oletusarvonsa.

### CASE D — asetuksia on jo tallennettu

Rollback poistaa ne, ja asetukset palaavat oletuksiin. Se on turvallinen
suunta: oletus on hiljaisuus, joten kukaan ei ala saada ilmoituksia
poiston takia.

---

## Rollback



```sql
begin;
set local lock_timeout = '5s';
drop table if exists public.notification_preferences;
commit;
```

Rollback EI koske funktioon public.touch_updated_at(): tämä migraatio
ei luonut sitä.

Muista tällöin palauttaa
src/data/schema.js -> TABLES.notificationPreferences = false.

Muista kääntää portit `notificationPreferences` takaisin `false`:ksi tiedostossa
`src/data/schema.js` ja bumpata `CACHE_VERSION`.

---

## Mitä 0005 ei riko

- **Ei muuta olemassa olevia rivejä.** Migraatio todistaa tämän ennen
  committia.
- **Ei kosketa migraatioiden 0001–0002 politiikkoihin eikä RLS:ään.**
- **Ei luo eikä korvaa funktiota `public.touch_updated_at()`.** Se on
  migraation 0002 objekti; tämä migraatio vain tarkistaa, että se on yhä
  kovennettu.

---

## Seuraava askel

Kun `verify_0005.sql` on vihreä, jatka runbookin mukaan seuraavaan
migraatioon. **Porttia ei käännetä ennen kuin koko erä on ajettu,
`verify_0004_0008_final.sql` on vihreä ja hyväksyntätesti on ajettu
oikealla käyttäjällä B.**
