# Migraatio 0003 — portit, peruminen ja palautuminen

Rutiinit ja niiden poikkeukset. Tämä on 0003:n turvallisuuspaperi: mitä
portit suojaavat, milloin ne saa kääntää, ja mitä tehdään jos jokin menee
pieleen.

> **TILA: VALMISTELTU. EI AJETTU.**
> `TABLES.routines = false`, `TABLES.routineExceptions = false`.
> Viimeisin tiedetty toimiva tuotantoversio: **`manifestival-prod-v1`**
> (`81b85e3678ba9f8a6375fa42db0fbbda6851ea8f`).

---

## Mitä 0003 tekee

Kaksi uutta taulua. **Ei koske `tasks`- eikä `profile`-tauluun eikä muuta
yhtään olemassa olevaa riviä.**

| | `routines` | `routine_exceptions` |
|---|---|---|
| Tarkoitus | toistuva sääntö | yhden päivän poikkeus sääntöön |
| Omistajuus | `user_id uuid not null default auth.uid()` → `auth.users(id)` `CASCADE` | sama |
| Tarkisteet | 7 | 2 |
| Indeksi | `(user_id, active)` | `(user_id, date)` |
| Yksikäsitteisyys | `(user_id, id)` | `(routine_id, date)` |
| RLS | päällä, 4 politiikkaa | päällä, 4 politiikkaa |

Lisäksi kaksi `updated_at`-liipaisinta, jotka käyttävät migraation 0002
luomaa jaettua funktiota `public.touch_updated_at()`.

**Rutiini on sääntö, ei tehtävä.** "Arkisin klo 07:00 aamulääkkeet" on
yksi rivi, ei 260 riviä vuodessa; esiintymät lasketaan säännöstä ajossa.

---

## Mitä auditissa löytyi ja korjattiin

| | Löydös | Korjaus |
|---|---|---|
| 1 | **Ei `lock_timeout`ia.** Vierasavaimen luonti ottaa `auth.users`-tauluun lukon — ja se on taulu, jota jokainen kirjautuminen koskee. Pitkä transaktio siellä olisi jättänyt migraation jonoon, ja FIFO-jonon takia sen taakse olisi jonoutunut jokainen kirjautuminen. | `set local lock_timeout = '5s'` ennen ensimmäistäkään DDL-lausetta |
| 2 | **Esiehto oli yksi rivi.** Tarkisti vain `tasks.user_id`-sarakkeen olemassaolon. | 0001 (RLS, 4 politiikkaa), 0002 (kuusi saraketta), hyväksytty omistaja, ja 0003:n omien objektien puuttuminen |
| 3 | **Täysin idempotentti, ei tilan erottelua.** `if not exists` joka kohdassa: toinen ajo, kesken jäänyt ajo ja tuore ajo näyttivät samalta. | 25 objektin laskenta; **keskeytyy** sekä jo ajettuun että kesken jääneeseen tilaan, jälkimmäisessä nimeten löytyneet |
| 4 | **`revoke ... from anon` mutta ei `from public`.** Sama vika, jonka 0001 joutui korjaamaan jälkikäteen: PUBLIC tarkoittaa "kaikki roolit" ja anon perii sen, mutta peritty oikeus ei näy roolikohtaisissa listauksissa. | `revoke all ... from public`, `from anon` ja `from authenticated` ennen myöntöä |
| 5 | **Poikkeus saattoi viitata toisen käyttäjän rutiiniin.** Vierasavaimen tarkistus ei kulje RLS:n läpi. Käyttäjä B olisi voinut luoda poikkeuksen, joka osoittaa A:n rutiiniin — B ei näkisi rutiinia, mutta rivi viittaisi toisen ihmisen dataan. **RLS estää lukemisen, ei viittaamista.** | Yhdistelmävierasavain `(user_id, routine_id) → routines(user_id, id)`, jonka kohteeksi lisättiin `routines_owner_row_key unique (user_id, id)` |
| 6 | **Ei loppuvarmistusta ennen committia.** | Tarkistaa taulut, tyhjyyden, RLS:n, kahdeksan politiikkaa ja tehokkaat oikeudet — vielä transaktion sisällä |

**Jäljellä olevia esteitä: ei yhtään.** 0003 on riippumaton migraatioista
0004–0008. Se sisältää sarakkeen `routines.goal_id`, mutta sen vierasavain
lisätään vasta 0004:ssä ehdollisesti — 0003 on siis turvallinen yksinään.

---

## Skeemaportit

| | |
|---|---|
| **PORTIT** | `TABLES.routines`, `TABLES.routineExceptions`, `src/data/schema.js` |
| **NYKYINEN ARVO** | molemmat `false` |
| **MITÄ NE SUOJAAVAT** | Estävät sovellusta kirjoittamasta tauluihin, joita tuotannossa ei ole. Portin ollessa `false` repositorio käyttää muistivarastoa eikä ota kantaan yhteyttä lainkaan — testi vartioi tätä. |
| **KÄÄNNETÄÄN YHDESSÄ** | Kyllä. Poikkeus ilman sääntöä on merkityksetön, ja `routine_exceptions` viittaa `routines`-tauluun. |
| **EDELLYTYS** | 0003 ajettu **ja** `verify_0003.sql` kauttaaltaan PASS |

Portin ollessa `false` tieto **ei säily**, ja käyttöliittymä kertoo sen
käyttäjälle (`isPersistent()`). Vaihtoehto — teeskennellä tallennusta —
olisi pahempaa kuin puute.

---

## Ennen ajoa

| | Vaatimus |
|---|---|
| 1 | Tuore varmuuskopio, **otettu tänään** |
| 2 | `supabase/preflight/preflight_0003.sql` ajettu, 21/21 PASS/FAIL-riviä `PASS` (7 INFO-riviä ei estä) |
| 3 | `supabase/preflight/recovery_snapshot_pre_0003.sql` ajettu ja **tulos säilytetty** |
| 4 | Sormenjäljet 15–18 kirjattu ylös |
| 5 | Migraation tiiviste kirjattu |

### Oletusoikeudet — miksi preflight ei pysähdy niihin

Tuotannossa on **60 oletusoikeusmerkintää roolille `anon`**
(`pg_default_acl`). Luku ei tarkoita 60 taulua: `pg_default_acl`
sisältää yhden rivin per (omistaja, skeema, objektityyppi), ja
`aclexplode` purkaa jokaisen yksittäisiksi oikeuksiksi. Luku on siis
rivien ja oikeuksien tulo. Purku:
`supabase/preflight/diagnose_default_acl_0003.sql`.

Tämä on **Supabasen normaali ympäristön tila**, ei tässä kannassa tehty
virhe. Se tarkoittaa, että uusi taulu voi hyvinkin **syntyä avoimena** —
ja juuri siksi migraation oma peruminen ei ole valinnainen.

Suojaus on kolmiosainen, ja jokainen osa on välttämätön:

1. `revoke all ... from public, anon, authenticated` **ennen** myöntöä
2. myöntö tasan CRUD roolille `authenticated`
3. lopputuloksen vahvistus samassa transaktiossa kahdella menetelmällä:
   `has_table_privilege` (onko oikeus, perintä mukaan lukien) ja
   `aclexplode` grantee = 0 (tuleeko se PUBLICilta)

**Välitilaa ei ole.** DDL on PostgreSQL:ssä transaktionaalinen: yksikään
toinen istunto ei näe uusia tauluja ennen `COMMIT`ia, joten hetkeä jona
`anon` näkisi ne ei ole olemassa.

Preflight raportoi oletusoikeuksien määrän **INFO-rivinä** ja tarkistaa
PASS/FAIL:na sen mikä oikeasti ratkaisee: että sama neutralointi on jo
toiminut tässä kannassa tauluille `tasks` ja `profile`. Jos se ei olisi
toiminut niillä, se ei toimisi uusillakaan — ja silloin 0003:a ei saisi
ajaa.

**Globaaleja oletusoikeuksia ei muuteta** (`ALTER DEFAULT PRIVILEGES`).
Se vaikuttaisi kaikkiin tuleviin Supabase-objekteihin, ei vain näihin
kahteen tauluun. Migraatiokohtainen `revoke` riittää ja on rajatumpi.

---

## Palautuminen tilanteittain

### CASE A — 0003 kaatuu transaktion sisällä

**Mitään ei jäänyt.** Migraatio on yksi transaktio, ja virhe perii sen
kokonaan: tauluja ei synny, politiikkoja ei jää, oikeuksia ei muutu.

1. Aja `rollback;` jos istunto jäi keskeytyneeseen tilaan.
2. Lue virheilmoitus — se on kirjoitettu kertomaan syy suoraan.
3. Korjaa syy. Älä aja uudelleen ennen sitä.

| Viesti alkaa | Syy | Toimenpide |
|---|---|---|
| `Migraatio 0001 pitaa ajaa ensin` | väärä tietokanta | tarkista projekti |
| `RLS ei ole paalla` | 0001 on peruttu tai osittainen | aja `verify_0001.sql` |
| `tasks-taulussa on N politiikkaa` | politiikkoja on muokattu käsin | aja `verify_0001.sql` |
| `Migraatio 0002 puuttuu` | väärä kanta tai 0002 peruttu | aja `verify_0002.sql` |
| `Hyvaksyttya omistajaa ... ei loydy` | **väärä projekti** | pysäytä |
| `Migraatio 0003 on JO AJETTU` | ajettu | aja `verify_0003.sql`, älä migraatiota |
| `Migraatio 0003 on kesken` | osa objekteista on olemassa | ks. CASE B |
| `canceling statement due to lock timeout` | `auth.users` oli varattu | odota, aja preflight uudelleen |

### CASE B — 0003 onnistui, portit ovat vielä `false`

**Tämä on turvallisin hetki perua.** Taulut ovat uusia ja **tyhjiä**,
eikä sovellus kirjoita niihin — repositorio käyttää muistivarastoa niin
kauan kuin portit ovat `false`.

```sql
begin;
drop table if exists public.routine_exceptions;
drop table if exists public.routines;
commit;
```

**Funktiota `public.touch_updated_at()` EI pudoteta.** Se on jaettu:
migraatio 0002 on ajettu tuotantoon ja `tasks`-taulun liipaisin käyttää
sitä. Pudottaminen rikkoisi sen.

Jos ajo jäi kesken (osa 25 objektista on olemassa), sama lohko toimii —
`if exists` pudottaa sen mitä on. Aja sen jälkeen `preflight_0003.sql`
uudelleen ja aloita alusta.

### CASE C — portit käännetty, mutta rutiineja ei ole vielä luotu

Käännä portit takaisin `false` ja julkaise. Sovellus lakkaa käyttämästä
tauluja heti; ne jäävät kantaan tyhjinä eivätkä haittaa mitään.

Koodin paluukohde on **`manifestival-prod-v1`**
(`81b85e3678ba9f8a6375fa42db0fbbda6851ea8f`). Sitä aiempaan ei palata:
se on ainoa tiedetty tietokantayhteensopiva versio.

### CASE D — rutiineja ja poikkeuksia on jo luotu

**Älä pudota tauluja.** Niissä on käyttäjän itsensä kirjoittamia
sääntöjä, joita ei ole missään muualla. `drop table` hävittää ne
lopullisesti ja hiljaa: lause onnistuu, mitään ei valiteta, ja tieto on
poissa.

Oikea järjestys on **eteenpäin korjaaminen**:

1. Käännä portit `false` ja julkaise. Kirjoitukset lakkaavat, **tieto jää
   kantaan koskemattomana**. Rutiinit eivät näy käyttöliittymässä, koska
   repositorio siirtyy muistivarastoon — mutta ne ovat tallessa.
2. Selvitä vika rauhassa.
3. Korjaa, aja `verify_0003.sql`, käännä portit takaisin.

Jos skeema on siitä huolimatta pakko purkaa, ota **ensin** talteen se
mikä katoaa. Rivimäärät näkee `verify_0003.sql`:n kohdasta 25.

---

## Mitä 0003 ei riko

| Huoli | Miksi se ei toteudu |
|---|---|
| Olemassa oleva data katoaa | 0003 ei sisällä yhtäkään lausetta, joka koskisi `tasks`- tai `profile`-tauluun. Sormenjäljet 15–18 tilannekuvassa todistavat sen jälkikäteen. |
| Uudet taulut ovat suojaamattomia | RLS päälle, 8 politiikkaa, oikeudet peruttu PUBLICilta ja anonilta ennen myöntöä — ja loppuvarmistus tarkistaa kaikki kolme ennen committia. |
| Poikkeus viittaa toisen rutiiniin | Yhdistelmävierasavain `(user_id, routine_id)`. |
| Jaettu funktio rikkoutuu | 0003 luo sen uudelleen **sanasta sanaan samana** kuin 0002; testi vertaa kaikkia kolmea kopiota. |
| Migraatio jää roikkumaan | `lock_timeout = 5s`. |
| Sovellus koskee olemattomiin tauluihin | Portit ovat `false`, ja testi todistaa ettei kantaan oteta yhteyttä lainkaan. |

---

## Mitä tämä paketti EI todista

Nämä ovat **staattisia** tarkistuksia: testit lukevat SQL:ää tekstinä
eivätkä aja sitä. Ne todistavat, ettei migraatio sisällä niitä
rakenteita, jotka aiemmin menivät pieleen — eivät sitä, että se toimii
oikeassa kannassa.

0003 luo uudet käyttäjäkohtaiset taulut, joten **sen jälkeen on ajettava
kahden tilin eristystesti uudelleen** näille tauluille. Migraation 0001
hyväksyntä ei kata niitä. Ks. [`RLS-ACCEPTANCE.md`](RLS-ACCEPTANCE.md);
työkalu kattaa nyt vain `tasks`- ja `profile`-taulut, joten se on
laajennettava ennen porttien kääntämistä.

---

## Aktivoinnin vaikutukset

| | |
|---|---|
| **Service worker** | `CACHE_VERSION` on nostettava `v11` → `v12` porttien kääntämisen yhteydessä. `schema.js` on esiladattavassa SHELL-listassa, ja `sw.js`:n muuttuminen on ainoa asia, josta selain huomaa uuden service workerin. Ei nyt — vasta aktivoinnissa. |
| **Android** | Aktivointi vaatii `npm run sync:android` ja uuden APK:n. Backlog-kohta **D1** on jo auki lipun `TASK_EXTENDED_FIELDS` osalta; 0003 ei muuta sitä tilannetta vaan kasvattaa sitä. |
| **Vercel** | Ei ympäristömuuttujamuutoksia. |

---

## Seuraava askel

**Aja `supabase/preflight/preflight_0003.sql`.** Se on lukeva eikä muuta
mitään. Vasta sen jälkeen on mielekästä keskustella migraation ajamisesta.
