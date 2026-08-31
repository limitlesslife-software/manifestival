# Supabase

Tässä hakemistossa on tietokannan inventointi ja versionhallitut migraatiot.

## Tiedostot

| Tiedosto | Mitä tekee | Turvallinen ajaa? |
|---|---|---|
| `inventory.sql` | Lukee skeeman, RLS-tilan, politiikat, oikeudet ja rivimäärät | **Kyllä — vain luku, ei muuta mitään** |
| `migrations/0001_auth_user_scoping.sql` | Lisää käyttäjäkohtaisen omistajuuden ja RLS:n | **EI ilman valmistelua** — lue alta |

## Ajojärjestys

```
1. Aja inventory.sql Supabase SQL Editorissa
2. Vertaa tulosta migraation "OLETUKSET"-osioon
3. Korjaa migraatio, jos oletukset eivät päde
4. Ota varmuuskopio (Database -> Backups)
5. Luo tili sovelluksen kirjautumisnäkymästä
6. Hae oma tunniste: select id, email from auth.users;
7. Korvaa migraation VAIHE 0 -paikanpitäjä sillä arvolla
8. Aja migraatio
9. Aja migraation lopun varmistuskyselyt
```

Migraatio 0001 keskeytyy virheeseen eikä muuta mitään, jos paikanpitäjä on
yhä paikallaan tai jos annettu tunniste ei vastaa yhtään `auth.users`-riviä.

## Ajotapa

Supabase Dashboard -> **SQL Editor** -> **New query** -> liitä sisältö -> **Run**.

Migraatio ajetaan yhdessä transaktiossa (`begin` ... `commit`): jos jokin vaihe
epäonnistuu, mitään ei jää puolitiehen.

## Peruutus

Migraatio 0001 **ei ole häviöttömästi peruttavissa**. Se muuttaa
`profile.id`-sarakkeen tyypin `text -> uuid`, jolloin vanha arvo `'me'` katoaa.
Ainoa luotettava peruutus on palautus varmuuskopiosta.

## Käytännöt

- Jokainen skeemamuutos kirjoitetaan numeroituna migraationa tähän hakemistoon.
- Käsin tehtyjä, dokumentoimattomia dashboard-muutoksia ei tehdä. Jos jotain on
  pakko tehdä käsin, se kirjoitetaan jälkikäteen migraatioksi.
- Salaisuuksia ei kirjoiteta näihin tiedostoihin.
