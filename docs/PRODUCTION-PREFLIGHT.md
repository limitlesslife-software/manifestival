# Migraation 0001 preflight ja operaattoripaketti

**Tämän ajaa ihminen. Ei agentti, ei skripti, ei CI.**

Tämä dokumentti on tarkoitettu luettavaksi **yksin**, ilman että koko
repo pitää ymmärtää. Se kattaa yhden asian: migraation 0001 ajamisen
tuotantoon turvallisesti.

Yksityiskohtaiset perustelut: [`PRODUCTION-ACTIVATION-RUNBOOK.md`](PRODUCTION-ACTIVATION-RUNBOOK.md)
· [`MIGRATION-MAP.md`](MIGRATION-MAP.md)

> **TILANNE: tämä dokumentti on suoritettu loppuun.** Migraatio 0001 on
> ajettu, `verify_0001.sql` on läpi, eristystesti tuotti 34/34 PASS ja
> `verify_acceptance.sql` 18/18 PASS. Rivit 1–12 ovat kaikki tehty.
>
> **Seuraava ihmisen toimenpide on migraatio 0002**, eri dokumentissa:
> [`MIGRATION-0002-RECOVERY.md`](MIGRATION-0002-RECOVERY.md) ja
> runbookin vaihe 6 (GATE 0–7). Lukeva preflight on
> `supabase/preflight/preflight_0002.sql`.
>
> Migraatiot 0002–0008 ovat ajamatta ja kaikki skeemaportit ovat `false`.

---

## Mitä 0001 tekee, yhdellä kappaleella

Tuotannossa kaikki data kuuluu yhdelle kiinteälle tunnisteelle `'me'`
eikä yhdelläkään tehtävärivillä ole omistajaa. Julkinen anon-avain on
selaimessa, ja tauluilla on "salli kaikki" -politiikka. **Kuka tahansa,
joka löytää osoitteen ja avaimen, voi lukea ja muuttaa kaiken.** 0001
vaihtaa omistajuusmallin oikeaan `auth.uid()`-pohjaiseen malliin ja
sulkee anonin ulos. Se on ainoa migraatio, joka koskettaa olemassa
olevaa dataa.

---

## Osa 1 — PREFLIGHT

Aja tämä **välittömästi ennen** 0001:tä, ei eilen. Kaikki kohdat ovat
lukevia.

### P0 — Oikea projekti

Supabase Dashboard → varmista, että olet projektissa **Manifestival**,
et jossain muussa. Tämä on ainoa kohta, jota mikään SQL ei voi
tarkistaa puolestasi.

```sql
select current_database() as kanta, current_user as rooli;
```

### P1–P9 — Skeeman ja datan lähtötila

Aja `supabase/inventory.sql` kokonaisuudessaan. Se on vain lukeva.

Poimi tuloksesta:

| # | Tarkistus | Odotus |
|---|---|---|
| P1 | `public`-skeeman taulut | `tasks` ja `profile`, ei muita sovellustauluja |
| P2 | `tasks`-rivimäärä | **36** |
| P3 | `profile`-rivimäärä | **1** |
| P4 | `tasks.user_id` | **ei ole olemassa** |
| P5 | `profile.legacy_id` | **ei ole olemassa** |
| P6 | `profile.id` tyyppi | `text` |
| P7 | `profile.id` arvo | `me` |
| P8 | RLS-tila | tiedossa ja kirjattu |
| P9 | Storage-bucketit | ei yhtään |

**Jos P2 ei ole 36:** olet luonut tehtäviä inventoinnin jälkeen. Se on
normaalia. Päivitä luku migraation **VAIHE 0** -lohkoon
(`expected_task_rows`) ja aja inventaario uudelleen. **Älä poista
tarkistusta.**

**Jos P4 tai P5 on olemassa:** 0001 on jo ajettu tai jäänyt kesken.
**Pysäytä** ja selvitä tilanne ennen kuin jatkat.

### P10 — Nykyiset politiikat talteen

Migraatio poistaa vanhat politiikat nimestä riippumatta eikä tallenna
niiden määritelmiä. **Tämä on ainoa hetki, jolloin ne voi ottaa
talteen.** Ilman tätä purkaminen ei palauta niitä.

```sql
select tablename, policyname, permissive, roles, cmd, qual, with_check
from pg_policies
where schemaname = 'public'
order by tablename, policyname;
```

Kopioi tulos ajopäiväkirjaan. Se on rakennekuvaus, ei henkilödataa.

### P11 — Omistaja on olemassa

```sql
select count(*) as loytyi
from auth.users
where id = '2cc00622-f927-4604-a518-361a4328481b'::uuid;
```

**Odotus: 1.** Jos 0, migraatio keskeytyy itsestään — mutta on parempi
tietää se nyt.

### P12 — Ei odottamattomia viitteitä profile-tauluun

```sql
select tc.constraint_name, tc.table_name
from information_schema.table_constraints tc
join information_schema.constraint_column_usage ccu
  on tc.constraint_name = ccu.constraint_name
 and tc.table_schema = ccu.table_schema
where tc.constraint_type = 'FOREIGN KEY'
  and ccu.table_schema = 'public'
  and ccu.table_name = 'profile';
```

**Odotus: nolla riviä.** Viite estäisi pääavaimen vaihdon.

### P13 — Ei avointa transaktiota

```sql
select pid, state, state_change, left(query, 60) as kysely
from pg_stat_activity
where datname = current_database()
  and state in ('idle in transaction', 'idle in transaction (aborted)')
order by state_change;
```

**Odotus: nolla riviä.**

Avoin transaktio estää `ACCESS EXCLUSIVE` -lukon, ja koska jonossa
odottava lukko estää jo itsessään kaikki uudet lukijat, hidas ajo veisi
sovelluksen alas odottaessaan. Migraatiossa on `lock_timeout = 5s`
juuri tämän varalta, mutta on parempi olla joutumatta siihen.

Yleisin syy: SQL-editorin toinen välilehti, jossa on ajettu `begin;`
ilman `commit;`- tai `rollback;`-lausetta. Sulje se välilehti.

### P14 — Tuore varmuuskopio

Dashboard → Database → Backups → ota varmuuskopio **tänään**.

Kirjaa aikaleima. **Aiempi havainto `03 Sep 2026 13:36:47 UTC` ei
kelpaa** tämän ajon varmuuskopioksi.

### P15 — Sovellus hiljaiseksi

Sulje sovellus kaikilta laitteilta ja välilehdiltä. Ei pakollista, mutta
avoin välilehti näkee virheitä katkon ajan ja voi yrittää
uudelleenlähetystä.

### P16–P18 — Mitä olet ajamassa

Paikallisessa repossa:

```
git rev-parse --short HEAD
git hash-object supabase/migrations/0001_auth_user_scoping.sql
git hash-object supabase/verify/verify_0001.sql
```

Kirjaa kaikki kolme. Liität tiedoston sisällön käsin selaimeen, joten
tämä on ainoa tapa myöhemmin todeta, mikä versio meni läpi.

### P19 — Skeemaportit ovat yhä kiinni

```
grep -n "= false\|: false" src/data/schema.js | wc -l
```

**Odotus: 11.** Yhtäkään porttia ei käännetä ennen kuin 0001 on ajettu
ja koko PYSÄYTYS 5 on läpäisty.

### P20 — Paikalliset testit menevät läpi

```
npm test && npm run check
```

Jos testit eivät mene läpi paikallisesti, älä aja mitään tuotantoon.

---

## Osa 2 — SUORITUS

Vain kun **kaikki** preflight-kohdat ovat kunnossa.

| # | Vaihe | Missä |
|---|---|---|
| 1 | Preflight P0–P20 | yllä |
| 2 | Tuore varmuuskopio otettu | Dashboard |
| 3 | Sovellus suljettu laitteilta | — |
| 4 | **Aja `0001_auth_user_scoping.sql` kokonaisuudessaan** | SQL Editor |
| 5 | Lue `NOTICE`-rivit | SQL Editor |
| 6 | Aja `verify/verify_0001.sql` | SQL Editor |
| 7 | Käy läpi kaikki 20 kohtaa | runbook, PYSÄYTYS 3 |
| 8 | Savutesti tilillä A | sovellus |
| 9 | Luo väliaikainen tili B (**vaatii luvan**) | Dashboard → Authentication |
| 10 | Eristystesti T1–T6 yhtenä ajona | `tools/rls-acceptance/` |
| 11 | Poista tili B — vasta kun siivous on PASS | Dashboard → Authentication |
| 12 | Aja `acceptance/verify_acceptance.sql` | SQL Editor |

**Koko tiedosto kerralla, ei lohko kerrallaan.** Se on yksi transaktio.
Paloittain ajettuna transaktion suoja katoaa.

### Odotetut NOTICE-rivit

```
Esiehdot kunnossa. Omistaja 2cc00622-..., tehtavia 36, profiileja 1.
Poistetaan vanha politiikka tasks....
Poistetaan vanha politiikka profile....
Poistettiin N vanhaa politiikkaa.
Poistetaan vanha paaavain profile_pkey.
Lopputila kunnossa: 8 politiikkaa, RLS paalla, PUBLIC tyhja,
anon ilman tehollista oikeutta, authenticated tasan 4.
```

Jos ajo päättyy `ERROR`-riviin: **mitään ei muuttunut.** Koko tiedosto
peruuntuu itsestään. Lue virheteksti — se nimeää esiehdon, joka ei
täyttynyt.

---

## Osa 3 — HYVÄKSYNTÄPORTTI

0001 on valmis vasta kun **jokainen** näistä on tosi. Yksikin `EI`
tarkoittaa, ettei mitään seuraavaa saa tehdä.

| # | Ehto | Miten todennetaan |
|---|---|---|
| G1 | 0001 committoitui virheittä | ei `ERROR`-riviä, `NOTICE`-rivit näkyvissä |
| G2 | `verify_0001` kaikki 20 kohtaa odotetusti | runbookin PYSÄYTYS 3 -taulukko |
| G3 | Rivimäärät ennallaan | `tasks` 36, `profile` 1 |
| G4 | Omistajuus oikea | kohta 10, molemmat `bool_and` = `true` |
| G5 | `PUBLIC` tyhjä, `anon` ilman tehollista oikeutta | kohdat 19 ja 20 |
| G6 | Politiikkojen ehdot vastaavat odotettua | kohta 4, `poikkeavia_yhteensa` = 0 |
| G7 | Perumisen merkkipaalu tallella | kohta 7, `1, 1, 1, 0` |
| G8 | Sovelluksen savutesti läpi tilillä A | luonti, muokkaus, poisto, uloskirjautuminen |
| G9 | Eristystesti T1–T6: `TULOS: PASS`, ei FAIL, ERROR eikä SKIP | `tools/rls-acceptance/` |
| G10 | Tili B poistettu ja `verify_acceptance.sql` 18/18 `PASS` | `supabase/acceptance/` |

**Vasta kun G1–G10 ovat kaikki tosia**, saa harkita:

- skeemaporttien kääntämistä
- 0001:een nojaavan koodin julkaisua
- siirtymistä migraatioon 0002

**Ennen sitä ei mitään näistä.** Ei myöskään "vain yhtä" porttia.

---

## Osa 4 — MITÄ EI SAA TEHDÄ VIELÄ

| Älä | Miksi |
|---|---|
| Käännä yhtäkään skeemaporttia | 0002–0008 ovat ajamatta; portti auki ilman taulua rikkoo tallennuksen |
| Aja 0002:ta samalla istunnolla | jokainen migraatio on erillinen päätös oman pysäytyksensä kanssa |
| Ohita eristystestiä | se on ainoa todiste RLS:stä; kaikki muu on päättelyä |
| Poista `profile.legacy_id` | se on ainoa asia, joka tekee purkamisesta mahdollista |
| Lisää `force row level security` | katkaisisi dashboardin taulunäkymän; päätös on dokumentoitu 0001:ssä |
| Muuta `service_role`-oikeuksia | ne eivät perustu PUBLICiin eivätkä kuulu tähän migraatioon |
| Kierrätä avaimia samalla kertaa | kaksi muuttujaa yhtä aikaa tekee vianetsinnästä mahdotonta |

---

## Osa 5 — PALAUTUMISEN PÄÄTÖSPUU

Aloita ylhäältä. Ensimmäinen osuva tapaus on vastaus.

### A. Ajo päättyi `ERROR`-riviin ennen committia

**Tee: ei mitään.** Migraatio on yksi transaktio ja jokainen tarkistus on
sen sisällä. Postgres peruu kaiken itse. Kanta on täsmälleen siinä
tilassa kuin ennen ajoa.

Lue virheteksti. Yleisimmät:

| Virhe | Syy | Korjaus |
|---|---|---|
| `public.tasks: N rivia, odotettiin 36` | olet luonut tehtäviä inventoinnin jälkeen | päivitä luku VAIHE 0 -lohkoon |
| `Omistajaa ... ei loydy` | väärä projekti tai tiliä ei ole | tarkista P0 ja P11 |
| `public.tasks.user_id on jo olemassa` | 0001 on ajettu tai kesken | **pysäytä**, selvitä käsin |
| `canceling statement due to lock timeout` | ks. tapaus E | — |

**Älä palauta varmuuskopiosta** pelkän `ERROR`-rivin takia. Se olisi
tarpeeton riski.

### B. `lock_timeout` ylittyi

**Tee: ei mitään kantaan.** Mitään ei committoitu.

Etsi estävä istunto (preflight P13), sulje se, ja aja uudelleen.
**Älä nosta `lock_timeout`-arvoa** päästäksesi ohi — pitkä odotus
jonossa estää kaikki uudet lukijat ja vie sovelluksen alas.

### C. Committoitui, mutta `verify_0001` näyttää poikkeaman

**Tee: PYSÄHDY. Älä jatka 0002:een. Älä käännä portteja.**

Selvitä ensin, mikä poikkeaa:

| Poikkeama kohdassa | Luonne | Toimi |
|---|---|---|
| 19, 20 (oikeudet) | **tietoturva** | korjaa `revoke`/`grant`-lauseilla, aja verify uudelleen |
| 2, 3, 4 (politiikat) | **tietoturva** | vertaa 0001:n VAIHE 5 -lohkoon, luo puuttuva politiikka uudelleen |
| 1 (RLS) | **tietoturva** | `alter table ... enable row level security` |
| 5, 6 (sarakkeet) | rakenne | vertaa 0001:n VAIHE 2 ja 3 -lohkoihin |
| 13, 14 (vierasavaimet) | rakenne | lisää puuttuva rajoite uudelleen |
| 16 (indeksi) | suorituskyky | `create index`, ei kiireellinen |
| 7 (legacy) | palautuvuus | ks. tapaus D |
| 8, 9, 10, 11, 12 (data) | **data** | ks. tapaus E |

Tietoturvapoikkeama on korjattavissa paikallaan — data ei ole
vaarantunut, vain sen suojaus. Korjaa, aja verify uudelleen, jatka vasta
sitten.

### D. Committoitui, mutta `legacy_id` on tyhjä tai väärä

Data on kunnossa; menetetty on **purkumahdollisuus ilman
varmuuskopiota**.

Se ei ole hätätilanne. Varmistu, että varmuuskopio on olemassa (P14),
kirjaa tilanne, ja jatka normaalisti. Älä palauta varmuuskopiosta pelkän
tämän takia.

### E. Rivimäärä tai omistajuus on väärä

**Tämä on ainoa tapaus, jossa varmuuskopion palautus on oikea vastaus.**

Merkit: kohta 8 näyttää alle 36, kohta 9 yli 0, kohta 10 `false`, tai
kohta 11 enemmän kuin 1.

Tee ennen palautusta:

1. **Älä kirjoita mitään kantaan.** Jokainen korjausyritys vaikeuttaa
   palautusta.
2. Kopioi kohtien 8–12 tulokset talteen.
3. Palauta P14:n varmuuskopiosta.
4. Selvitä syy vasta sen jälkeen. Migraation vaiheet 2c, 3g ja 7
   tarkistavat rivimäärät transaktion sisällä, joten tähän päätyminen
   tarkoittaa, että vika on jossain muualla kuin migraatiossa.

### F. Migraatio meni läpi ja verify on kunnossa, mutta sovellus antaa
virheen "column does not exist"

**Tee: odota ja lataa sivu uudelleen.** Tämä ei ole kantaongelma.

PostgREST pitää skeemasta välimuistia. 0001 muutti `profile`-taulun
sarakkeet, joten välimuisti on hetken vanhentunut. Supabase päivittää
sen yleensä itse muutamassa sekunnissa. Voit pakottaa sen:
*Settings → API → Reload schema cache*.

**Älä palauta varmuuskopiosta** eikä pura migraatiota tämän takia.

### G. Kaikki näyttää oikealta, mutta eristystestissä on FAIL

**Tämä on vakavin mahdollinen tulos.** Se tarkoittaa, että toinen
käyttäjä pystyy lukemaan, kirjoittamaan tai muuttamaan toisen dataa.

1. Älä käännä yhtäkään porttia.
2. Vertaa `verify_0001` kohtaa 4: mikä politiikka ei ole `OK`.
3. Lue rivin numero raportista — se kertoo suoraan mikä ehto on rikki:

   | Rivi | Rikki oleva ehto |
   |---|---|
   | `T2*` | `SELECT`-politiikan `USING` |
   | `T3a`, `T5c` | `UPDATE`-politiikan `USING` |
   | `T3b`, `T5d`, `T5e` | `DELETE`-politiikan `USING` |
   | `T3c` | `profile`-taulun `UPDATE`-politiikka |
   | `T3d` | `INSERT`-politiikan `WITH CHECK` |
   | `T4*` | politiikka on liian tiukka — sovellus ei toimisi lainkaan |
   | `T6*` | `anon`-roolilta ei ole peruttu oikeuksia |

4. Luo puuttuva tai väärä politiikka uudelleen 0001:n VAIHE 5 -lohkon
   mukaisesti ja toista koko ajo alusta.
5. Rivi `ERROR` ei ole sama asia kuin `FAIL`: kysely ei päässyt edes
   yrittämään. Korjaa yhteys ja aja uudelleen — älä tulkitse sitä
   tulokseksi suuntaan eikä toiseen.

---

## Osa 6 — Ajopäiväkirjan pohja

```
Päivämäärä:
Projekti:                Manifestival
Kanta (P0):
Varmuuskopion aikaleima (P14):
git HEAD (P16):
0001 hash (P17):
verify_0001 hash (P18):

Preflight P1-P20:        kaikki OK / poikkeamat:
Vanhat politiikat (P10): kopioitu talteen kyllä/ei

0001 ajettu klo:
NOTICE-rivit odotetut:   kyllä/ei
Poistettuja politiikkoja:

verify_0001 kohdat 1-20: kaikki odotetusti / poikkeamat:
Savutesti (G8):          OK/EI
T1:  OK/EI    T2:  OK/EI    T3:  OK/EI    T4:  OK/EI    T5:  OK/EI
Tili B poistettu:        kyllä/ei
tasks lopuksi:           (odotus 36)

Portti G1-G10:           LÄPI / EI LÄPI
Seuraava sallittu askel:
```
