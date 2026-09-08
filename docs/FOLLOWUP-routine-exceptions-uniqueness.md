# Jälkikovennus: `routine_exceptions_unique_day`

**Tila:** analysoitu, EI korjattu. Ei estä aktivointia.
**Löytyi:** hyväksyntätestin E4-virhettä selvitettäessä (ajo 20260907181539)

---

## Havainto

Migraatio 0003 luo rajoitteen

```sql
constraint routine_exceptions_unique_day unique (routine_id, date)
```

Se on **rutiinikohtainen**, ei käyttäjäkohtainen. Yhdistelmävierasavain
`(user_id, routine_id) → routines (user_id, id)` estää
ristiinkiinnityksen, mutta rajoitteet tarkistetaan tässä järjestyksessä:

> **RLS `WITH CHECK` → yksikäsitteisyysindeksi → vierasavaimen liipaisin**

Tämä havaittiin tuotannossa, ei päätelty: E3c sai koodin `42501` (RLS
torjui rivin, jonka omistajaksi oli merkitty toinen käyttäjä) ja E4 sai
`23505` (rivin omistaja oli oikein, joten se läpäisi RLS:n ja pysähtyi
indeksiin).

---

## Seuraus

Käyttäjä B, joka **jo tuntee** käyttäjän A rutiinin tunnisteen, voi
erottaa kaksi tilannetta:

| B:n yritys | Vastaus | Mitä se kertoo |
|---|---|---|
| A:n rutiinilla on poikkeus päivälle X | `23505` | poikkeus on olemassa |
| A:n rutiinilla ei ole poikkeusta päivälle X | `23503` | poikkeusta ei ole |

Vuoto on **yksi bitti per kysely**: onko tietylle rutiinille tehty
poikkeus tiettynä päivänä.

---

## Vakavuus: matala

Perustelut, ja myös se mitä ne eivät kata:

**Vaatii ennakkotiedon.** Hyökkääjän on tiedettävä A:n rutiinin
tunniste. Tunnisteet ovat `crypto.randomUUID()`-arvoja eivätkä esiinny
missään jaetussa pinnassa.

> Tämä on turvaa hämäryydellä, ja sellaisena heikko perustelu. Se on
> tässä lieventävä tekijä, ei syy jättää korjaamatta.

**Ei paljasta sisältöä.** Vuotava tieto on olemassaolo, ei poikkeuksen
tyyppi, kellonaika, otsikko eikä muistiinpano. RLS estää kaiken
lukemisen.

**Ei mahdollista kiinnittämistä.** Yhdistelmävierasavain torjuu rivin
joka tapauksessa. B ei saa riviään kiinni A:n rutiiniin, sai se sitten
`23505`:n tai `23503`:n.

**Yksi käyttäjä.** Tuotannossa on tällä hetkellä yksi auth-käyttäjä.
Vuoto edellyttää kahta.

---

## Korjausehdotus

Yksikäsitteisyys omistajakohtaiseksi:

```sql
-- EI AJETTU. Ehdotus tulevaksi migraatioksi 0009.
begin;
set local lock_timeout = '5s';

alter table public.routine_exceptions
  drop constraint routine_exceptions_unique_day;

alter table public.routine_exceptions
  add constraint routine_exceptions_unique_day
  unique (user_id, routine_id, date);

commit;
```

### Miksi tämä on oikea korjaus

Pari `(user_id, routine_id)` on jo yhdistelmävierasavaimen kattama,
joten `(user_id, routine_id, date)` ei löysennä mitään: rutiini kuuluu
aina yhdelle omistajalle, joten `(routine_id, date)` ja
`(user_id, routine_id, date)` hylkäävät täsmälleen samat **omat** rivit.

Ero on vain siinä, että toisen käyttäjän rivi ei enää osu indeksiin —
jolloin vierasavain torjuu sen ensin, ja vastaus on aina `23503`.

### Miksi tätä ei tehty nyt

1. **Se on tuotannon skeemamuutos.** Tämä paketti ei aja SQL:ää
   tuotantoon.
2. **Se ei estä aktivointia.** Ristiinkiinnitys on jo estetty.
3. **Se vaatii oman todennuksensa:** preflight, migraatio, varmistus ja
   hyväksyntätestin E4-tapauksen tarkistus sen jälkeen.

### Ennen ajamista tarkistettava

- Onko `routine_exceptions` tyhjä? Jos on, rajoitteen vaihto ei voi
  kaatua dataan. Jos ei, tarkista ettei `(user_id, routine_id, date)`
  ole jo rikki.
- Rajoitteen pudotus ja lisäys ottavat `ACCESS EXCLUSIVE` -lukon.
  Käytä `lock_timeout`ia.
- Hyväksyntätestin E4 odottaa `23503`:a. Korjauksen jälkeen se saa sen
  myös silloin kun päivä on varattu — testin päiväjärjestely
  (`exceptionDates`) muuttuu tarpeettomaksi mutta ei haitalliseksi.

---

## Suositus

**Aktivoi rutiinit normaalisti.** Tee tämä korjaus omana pakettinaan
sen jälkeen, kun aktivointi on todennettu.

Jos tuotantoon tulee toinen käyttäjä ennen korjausta, nosta prioriteettia
— vuoto edellyttää kahta käyttäjää ollakseen mielekäs.
