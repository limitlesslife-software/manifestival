# Migraatio 0006 — hyvinvointimerkinnät

**Tila:** valmisteltu, EI AJETTU. Portit `wellbeing` ovat `false`.

Koko erän ajo-ohje on `docs/MIGRATIONS-0004-0008-PRODUCTION-RUNBOOK.md`.
Tämä dokumentti vastaa yhteen kysymykseen: **mitä tehdä, kun jokin menee
pieleen.**

---

## Mitä 0006 tekee

Luo taulun `wellbeing_entries`: yksi merkintä per päivä, mittarit
1–5, unen määrä tunteina.

| Objekti | Määrä |
|---------|-------|
| taulut | 1 |
| rajoitteet | 3 |
| indeksit | 1 |
| liipaisimet | 1 |
| politiikat | 4 |

Yhteensä **10 objektia**.

---

## Mitä tässä migraatiossa on erityistä

### Tämä on erän arkaluontoisin taulu

Sarake `note` on vapaata tekstiä, johon ihminen kirjoittaa mitä tahansa,
ja mittarit kertovat jaksamisesta.

Yksikään tämän paketin varmistus- tai diagnostiikkakysely **ei lue tämän
taulun sisältöä** — vain rivimääriä ja rakennetta. Sama koskee
hyväksyntätestin testirivejä: niiden `note` on aina `null`.

### Yksikäsitteisyys on omistajakohtainen

Rajoite on `unique (user_id, date)`. Pelkkä `unique (date)` olisi vuoto:
se paljastaisi virheellä, että jollakin **toisella** käyttäjällä on
merkintä samalle päivälle.

### Ei koske olemassa olevaan dataan

Migraatio luo yhden uuden taulun eikä viittaa yhteenkään
sovellustauluun.

---

## Ennen ajoa

1. Varmuuskopio Supabasen omalla toiminnolla
2. `supabase/preflight/recovery_snapshot_pre_0004_0008.sql` (kerran koko erälle)
3. `supabase/preflight/preflight_0004_0008_batch.sql` (kerran koko erälle)
4. `supabase/preflight/preflight_0006.sql` (juuri ennen tätä migraatiota)

Yksikin FAIL = migraatiota ei ajeta.

---

## Palautuminen tilanteittain

### CASE A — 0006 kaatuu transaktion sisällä

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

### CASE B — `Migraatio 0006 on JO AJETTU`

Migraatio on ajettu kokonaan. **Älä aja uudelleen.** Aja
`supabase/verify/verify_0006.sql` ja jatka siitä.

### CASE B2 — `Migraatio 0006 on kesken: N objektia 10:sta`

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

### CASE C — portti käännetty, mutta merkintöjä ei ole tehty

Käännä portti takaisin `false`:ksi ja bumppaa `CACHE_VERSION`.

### CASE D — merkintöjä on jo tehty

**Rollback kadottaa ne pysyvästi.** Nämä ovat henkilökohtaisia
merkintöjä, joita ei voi tuottaa uudelleen. Ota vienti talteen ennen
poistoa, ja käsittele vientitiedostoa kuten terveystietoa:

```sql
select id, date, energy, mood, stress, sleep_hours, note
  from public.wellbeing_entries order by date;
```

Harkitse, onko poisto oikea ratkaisu. Portin sulkeminen jättää taulun
kantaan koskemattomana ja on peruttavissa; taulun pudottaminen ei.

---

## Rollback

Poisto kadottaa kaikki hyvinvointimerkinnät. Ota varmuuskopio ensin.

```sql
begin;
set local lock_timeout = '5s';
drop table if exists public.wellbeing_entries;
commit;
```

Rollback EI koske funktioon public.touch_updated_at(): tämä migraatio
ei luonut sitä.

Muista tällöin palauttaa src/data/schema.js -> TABLES.wellbeing = false.

Muista kääntää portit `wellbeing` takaisin `false`:ksi tiedostossa
`src/data/schema.js` ja bumpata `CACHE_VERSION`.

---

## Mitä 0006 ei riko

- **Ei muuta olemassa olevia rivejä.** Migraatio todistaa tämän ennen
  committia.
- **Ei kosketa migraatioiden 0001–0002 politiikkoihin eikä RLS:ään.**
- **Ei luo eikä korvaa funktiota `public.touch_updated_at()`.** Se on
  migraation 0002 objekti; tämä migraatio vain tarkistaa, että se on yhä
  kovennettu.

---

## Seuraava askel

Kun `verify_0006.sql` on vihreä, jatka runbookin mukaan seuraavaan
migraatioon. **Porttia ei käännetä ennen kuin koko erä on ajettu,
`verify_0004_0008_final.sql` on vihreä ja hyväksyntätesti on ajettu
oikealla käyttäjällä B.**
