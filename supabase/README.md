# Supabase

Tässä hakemistossa on tietokannan inventointi ja versionhallitut migraatiot.

**Yksikään migraatio ei ole ajettu missään ympäristössä.** Kaikki ovat
luonnoksia.

`inventory.sql` **on** ajettu kerran, ja **migraatio 0001 on sovitettu sen
tulokseen**: `profile` 1 rivi arvolla `'me'` (tyyppi `text`), `tasks` 36
riviä ilman `user_id`-saraketta, molemmilla "salli kaikki" -tyyppinen
politiikka. 0001 tarkistaa nämä itse ja keskeytyy, jos jokin ei täsmää.

Migraatiot 0002–0008 ovat yhä yleisluonteisia, koska ne luovat uusia
tauluja eivätkä kosketa olemassa olevaa dataa.

## Tiedostot

| Tiedosto | Mitä tekee | Turvallinen ajaa? |
|---|---|---|
| `inventory.sql` | Lukee skeeman, RLS-tilan, politiikat, oikeudet ja rivimäärät | **Kyllä — vain luku, ei muuta mitään** |
| `migrations/0001_auth_user_scoping.sql` | Käyttäjäkohtainen omistajuus ja RLS | **EI ilman valmistelua** — lue alta |
| `migrations/0002_task_domain_fields.sql` | Tehtävän kuvaus, kesto, prioriteetti, aikataulutuksen tila, aikaleimat | Additiivinen, mutta vaatii 0001:n |
| `migrations/0003_routines.sql` | Rutiinit ja niiden päiväkohtaiset poikkeukset | Vain uusia tauluja |
| `migrations/0004_goals_projects.sql` | Tavoitteet, projektit, tehtävän määräaika ja liitokset | Uusia tauluja + nullable-sarakkeita |
| `migrations/0005_notification_preferences.sql` | Muistutusasetukset (oletus: pois päältä) | Vain uusi taulu |
| `migrations/0006_wellbeing.sql` | Päiväkohtaiset hyvinvointimerkinnät | Vain uusi taulu |

## Ajojärjestys

Migraatiot ajetaan numerojärjestyksessä. 0001 on kaikkien muiden esiehto:
ilman `user_id`-saraketta ja RLS:ää uusilla tauluilla ei olisi omistajaa.

```
1. Ota varmuuskopio (Database -> Backups)
2. Aja inventory.sql Supabase SQL Editorissa
3. Vertaa tulosta migraation TODENNETTU LÄHTÖTILA -osioon
4. Jos rivimäärä on muuttunut, päivitä luku 0001:n VAIHE 0 -lohkoon
5. Aja migraatio 0001 kokonaisuudessaan, yhtenä ajona
6. Aja verify/verify_0001.sql
7. Tee kahden tilin eristystesti (tools/rls-acceptance) — PAKOLLINEN
   ja aja sen jalkeen acceptance/verify_acceptance.sql
8. Aja 0002-0008 samalla tavalla, yksi kerrallaan, lippu kerrallaan
```

Vaiheet, pysäytyspisteet ja odotusarvot:
[`docs/PRODUCTION-ACTIVATION-RUNBOOK.md`](../docs/PRODUCTION-ACTIVATION-RUNBOOK.md).

Migraatio 0001 keskeytyy virheeseen eikä muuta mitään, jos lähtötila ei
vastaa inventaariota tai jos omistajaa ei löydy `auth.users`-taulusta.
Migraatiot 0002–0008 keskeytyvät, jos 0001 ei ole ajettu.

## Koodin liput

Sovellus ei oleta, että migraatio on ajettu. `src/data/schema.js` kertoo
mitkä taulut ovat olemassa. Ennen migraatiota tieto menee muistivarastoon
eikä säily sivun latauksen yli — ja käyttöliittymä kertoo sen käyttäjälle.
Teeskennelty tallennus olisi pahempi kuin puuttuva tallennus.

Migraation jälkeen vaihdetaan tasan yksi lippu kerrallaan:

| Migraatio | Lippu tiedostossa `src/data/schema.js` |
|---|---|
| 0002 | `TASK_EXTENDED_FIELDS = true` |
| 0003 | `TABLES.routines = true`, `TABLES.routineExceptions = true` |
| 0004 | `TABLES.goals = true`, `TABLES.projects = true` |
| 0005 | `TABLES.notificationPreferences = true` |
| 0006 | `TABLES.wellbeing = true` |

Vaiheittainen käyttöönotto on kuvattu tarkemmin tiedostossa
[`docs/PRODUCTION-ACTIVATION.md`](../docs/PRODUCTION-ACTIVATION.md).

## Ajotapa

Supabase Dashboard -> **SQL Editor** -> **New query** -> liitä sisältö -> **Run**.

Migraatio ajetaan yhdessä transaktiossa (`begin` ... `commit`): jos jokin vaihe
epäonnistuu, mitään ei jää puolitiehen.

## Peruutus

Migraatio 0001 **ei muuta `profile.id`:n tyyppiä.** Tuotannon arvo `'me'`
ei ole uuid, joten muunnos kaatuisi. Vanha sarake nimetään `legacy_id`:ksi
ja uusi `uuid`-sarake lisätään sen rinnalle — alkuperäinen arvo säilyy.

Peruminen jakautuu siksi kolmeen tapaukseen: keskeytynyt ajo peruuntuu
itsestään (yksi transaktio), läpimennyt ajo puretaan käsin `legacy_id`:n
avulla, ja kadonnut data vain varmuuskopiosta. Ks. runbookin
*0001:n peruminen*. **Varmuuskopio on silti pakollinen.**

Migraatiot 0002–0008 ovat peruttavissa: jokaisen lopussa on rollback-lohko.
Peruutus kadottaa vain sen tiedon, joka on kirjoitettu migraation jälkeen
uusiin sarakkeisiin tai tauluihin.

## RLS-malli

Kaikissa tauluissa sama malli, poikkeuksetta:

```
Supabase Auth -> auth.uid() -> user_id (tai id) -> RLS -> vain oma data
```

- Omistajuuden asettaa **tietokanta** (`default auth.uid()`), ei selain.
  Client ei koskaan kirjoita `user_id`-saraketta — `src/data/collectionsRepo.js`
  estää sen erikseen.
- `anon`-roolille ei luoda yhtään politiikkaa ja sen oikeudet revokoidaan.
  Kirjautumaton ei näe eikä muuta mitään.
- Jokainen taulu saa neljä politiikkaa: select, insert, update ja delete.

## Käytännöt

- Jokainen skeemamuutos kirjoitetaan numeroituna migraationa tähän hakemistoon.
- Käsin tehtyjä, dokumentoimattomia dashboard-muutoksia ei tehdä. Jos jotain on
  pakko tehdä käsin, se kirjoitetaan jälkikäteen migraatioksi.
- Salaisuuksia ei kirjoiteta näihin tiedostoihin.
