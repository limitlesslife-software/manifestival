# Supabase

Tässä hakemistossa on tietokannan inventointi ja versionhallitut migraatiot.

**Yksikään migraatio ei ole ajettu missään ympäristössä.** Kaikki ovat
luonnoksia. Production-Supabase on tällä hetkellä pausella eikä
`inventory.sql`-inventointia ole vielä tehty, joten migraatioiden oletuksia
ei ole voitu vahvistaa oikeaa skeemaa vasten.

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
1. Aja inventory.sql Supabase SQL Editorissa
2. Vertaa tulosta migraation "OLETUKSET"-osioon
3. Korjaa migraatio, jos oletukset eivät päde
4. Ota varmuuskopio (Database -> Backups)
5. Luo tili sovelluksen kirjautumisnäkymästä
6. Hae oma tunniste: select id, email from auth.users;
7. Korvaa migraation 0001 VAIHE 0 -paikanpitäjä sillä arvolla
8. Aja migraatio 0001
9. Aja migraation lopun varmistuskyselyt
10. Aja 0002, 0003, 0004, 0005 ja 0006 samalla tavalla, yksi kerrallaan
```

Migraatio 0001 keskeytyy virheeseen eikä muuta mitään, jos paikanpitäjä on
yhä paikallaan tai jos annettu tunniste ei vastaa yhtään `auth.users`-riviä.
Migraatiot 0002–0006 keskeytyvät, jos 0001 ei ole ajettu.

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

Migraatio 0001 **ei ole häviöttömästi peruttavissa**. Se muuttaa
`profile.id`-sarakkeen tyypin `text -> uuid`, jolloin vanha arvo `'me'` katoaa.
Ainoa luotettava peruutus on palautus varmuuskopiosta.

Migraatiot 0002–0006 ovat peruttavissa: jokaisen lopussa on rollback-lohko.
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
