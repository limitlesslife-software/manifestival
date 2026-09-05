# Migraatio 0002 — portti, peruminen ja palautuminen

Tämä on 0002:n koko turvallisuuspaperi: mitä lippu suojaa, milloin sen
saa kääntää, ja mitä tehdään jos jokin menee pieleen. Suoritusohje on
runbookissa ([`PRODUCTION-ACTIVATION-RUNBOOK.md`](PRODUCTION-ACTIVATION-RUNBOOK.md),
vaihe 6).

> **TILA: 0002 ON AJETTU JA HYVÄKSYTTY TUOTANNOSSA.** `verify_0002.sql`
> kauttaaltaan PASS, `poikkeavia_yhteensa` = 0. Tuotannossa 36 tehtävää:
> 1 `unscheduled`, 35 `manual`.
>
> **Migraatiota ei ajeta uudelleen** — se tunnistaa aiemman ajon ja
> keskeytyy. Tämä dokumentti jää palautumisohjeeksi: kohdat C ja D ovat
> yhä voimassa, ja kohta D on se, joka koskee nykyhetkeä.
>
> Seuraava askel on lipun `TASK_EXTENDED_FIELDS` aktivointi:
> [`TASK-EXTENDED-FIELDS-ACTIVATION.md`](TASK-EXTENDED-FIELDS-ACTIVATION.md).

---

## Mitä 0002 tekee

Kuusi uutta saraketta tauluun `public.tasks`:

| Sarake | Tyyppi | Null | Oletus |
|---|---|---|---|
| `description` | `text` | sallii | — |
| `duration_minutes` | `integer` | sallii | — |
| `priority` | `text` | **ei** | `'normaali'` |
| `scheduling_state` | `text` | **ei** | `'manual'` |
| `created_at` | `timestamptz` | **ei** | `now()` |
| `updated_at` | `timestamptz` | **ei** | `now()` |

Lisäksi kolme tarkistetta, liipaisin `tasks_touch_updated_at`, jaettu
funktio `public.touch_updated_at()` ja indeksi
`tasks_user_date_priority_idx (user_id, date, priority)`.

**Uusia tauluja ei synny, eikä RLS:ää tai politiikkoja kosketa.**
Politiikat ovat rivikohtaisia, joten uudet sarakkeet perivät 0001:n
kahdeksan omistajuuspolitiikkaa sellaisenaan. Sama koskee oikeuksia:
`grant` annettiin taulutasolla, joten se kattaa uudet sarakkeet.
`verify_0002` tarkistaa molemmat siltä varalta, että jokin muuttui.

Ainoa kirjoitus olemassa oleviin riveihin on `scheduling_state`-sarakkeen
täyttö: kellonajattomat rivit merkitään `unscheduled`, muut `manual`.

---

## Kaksi asiaa, jotka on tiedettävä etukäteen

**1. `created_at` ei kerro olemassa olevien rivien iästä mitään.**
Kaikki nykyiset rivit saavat saman arvon, migraation ajanhetken.
Todellisia luontiaikoja ei ole tallessa missään, joten niitä ei voi
palauttaa. Älä käytä `created_at`-saraketta järjestämiseen ennen kuin
riveillä on aitoja arvoja.

**2. Migraation ja lipun välissä on ikkuna, jossa uudet rivit saavat
oletusarvon `manual`.** Täyttö osaa erottaa kellonajattoman rivin, mutta
sarakkeen oletusarvo ei: se on `'manual'` riippumatta kellonajasta. Kun
lippu on vielä `false`, sovellus ei lähetä `scheduling_state`-saraketta
lainkaan, joten silloin luodut kellonajattomat tehtävät merkitään
`manual` eikä `unscheduled`. Automaatti ei siis ehdota niille aikaa.

Se ei ole tietohäviö eikä turvallisuusongelma, mutta se on syy **kääntää
lippu pian migraation jälkeen** eikä jättää väliä auki viikoiksi.
Korjaus jälkikäteen on yksi UPDATE, mutta se on silti korjaus.

---

## Skeemaportti

| | |
|---|---|
| **PORTTI** | `TASK_EXTENDED_FIELDS`, `src/data/schema.js` |
| **NYKYINEN ARVO** | `false` |
| **MITÄ SE SUOJAA** | Estää sovellusta kirjoittamasta kuutta saraketta, joita tuotannossa ei vielä ole. Ilman porttia **jokainen** tehtävän tallennus epäonnistuisi tuotannossa. |
| **EDELLYTYS ENNEN `true`** | 0002 ajettu **ja** `verify_0002.sql` kauttaaltaan PASS (`poikkeavia_yhteensa = 0`) |
| **MILLOIN SAA KÄÄNTÄÄ** | Runbookin GATE 7. Ei aiemmin, ei osittain |
| **MITEN VARMISTETAAN** | `npm test` läpi, tehtävän luonti ja muokkaus tuotannossa, sivun uudelleenlataus — kuvaus ja prioriteetti säilyvät |

Portin ollessa `false` `taskColumns()` palauttaa `TASK_COLUMNS_CORE`, eli
sovellus kirjoittaa vain alkuperäiset yhdeksän saraketta. Kuvaus, kesto,
prioriteetti ja aikataulutuksen tila elävät siihen asti vain selaimen
muistissa, ja `volatileFields()` kertoo sen käyttöliittymälle, joka
kertoo sen käyttäjälle.

**Kaikki muut yksitoista porttia pysyvät `false`.** 0002 ei liity
niihin: ne odottavat migraatioita 0003–0008, joita ei ole ajettu.

---

## Ennen ajoa

| | Vaatimus |
|---|---|
| 1 | Tuore varmuuskopio Supabasen Backups-näkymästä, **otettu tänään** |
| 2 | Tiedät, miten palautus tehdään — palautusta ei opetella hätätilanteessa |
| 3 | `supabase/preflight/preflight_0002.sql` ajettu, jokainen PASS/FAIL-rivi `PASS`, `poikkeavia_yhteensa = 0` |
| 4 | Preflightin INFO-luvut kirjattu ylös (rivimäärä, kellonajattomat, kellonajalliset, rajoitteet, indeksit) |
| 5 | Sovellus suljettu laitteilta lyhyen katkon ajaksi |
| 6 | Migraation tiiviste kirjattu: `git log -1 --format=%H -- supabase/migrations/0002_task_domain_fields.sql` |

Migraatio ottaa `ACCESS EXCLUSIVE` -lukon tauluun `tasks`. 36 rivillä se
kestää millisekunteja, mutta lukon ajan taulu on täysin poissa käytöstä.
`lock_timeout` on 5 sekuntia: jos joku muu pitää taulua varattuna,
migraatio **keskeytyy** eikä jää odottamaan. Se on tarkoitus — hiljaa
odottava migraatio jonouttaa taakseen jokaisen seuraavan kyselyn ja
kaataisi sovelluksen odottaessaan.

---

## Palautuminen tilanteittain

### A. Virhe ENNEN committia

**Mitään ei jäänyt.** Migraatio on yksi transaktio, ja virhe perii sen
kokonaan. Istunto jää keskeytyneeseen tilaan.

1. Aja `rollback;`.
2. Lue virheilmoitus. Se on kirjoitettu kertomaan syy suoraan.
3. Korjaa syy. Älä aja migraatiota uudelleen ennen sitä.

Tavallisimmat viestit:

| Viesti alkaa | Syy | Toimenpide |
|---|---|---|
| `Migraatio 0001 pitaa ajaa ensin` | väärä tietokanta tai 0001 ajamatta | tarkista projekti |
| `RLS ei ole paalla` | 0001 on peruttu tai osittainen | aja `verify_0001.sql` |
| `tasks-taulussa on N politiikkaa` | politiikkoja on muokattu käsin | aja `verify_0001.sql` |
| `Hyvaksyttya omistajaa ... ei loydy` | **väärä projekti** | pysäytä, tarkista projektiviite |
| `omistajattomia riveja` | 0001:n jälkeen on syntynyt rikkinäistä dataa | selvitä ennen jatkoa |
| `Migraatio 0002 on JO AJETTU` | migraatio on ajettu | aja `verify_0002.sql`, älä migraatiota |
| `Migraatio 0002 on kesken` | aiempi ajo katkesi | ks. kohta B |
| `canceling statement due to lock timeout` | taulu oli varattu | odota, aja preflight uudelleen |

### B. Ajo katkesi kesken — "Migraatio 0002 on kesken"

Tämä viesti tulee vain, jos osa 12 objektista on olemassa ja osa ei.
Viesti **nimeää** löytyneet objektit.

Käytännössä tämä on harvinaista: 0002 on yksi transaktio, joten
keskeytyminen perii itsensä. Osittainen tila syntyy lähinnä jos joku on
ajanut migraatiosta **osan käsin**.

1. Älä aja migraatiota uudelleen. Se ei korjaa osittaista tilaa.
2. Aja `verify_0002.sql` nähdäksesi mitä puuttuu.
3. Valitse **yksi** suunta:
   - **Eteenpäin:** luo puuttuvat objektit käsin migraation lohkoista, ja
     aja sitten `verify_0002.sql` uudelleen.
   - **Taaksepäin:** aja kohdan C perumislohko, joka pudottaa löytyneet
     objektit `if exists` -muodossa, ja aloita alusta.

### C. Onnistunut ajo, mutta lippu on vielä `false`

**Tämä on turvallisin hetki perua.** Uusiin sarakkeisiin ei ole
kirjoitettu mitään, mitä ei voisi laskea uudelleen: `priority` ja
`scheduling_state` ovat migraation itsensä johtamia arvoja, ja sovellus
ei vielä kirjoita niihin.

```sql
begin;
drop trigger if exists tasks_touch_updated_at on public.tasks;
drop index if exists public.tasks_user_date_priority_idx;
alter table public.tasks
  drop column if exists description,
  drop column if exists duration_minutes,
  drop column if exists priority,
  drop column if exists scheduling_state,
  drop column if exists created_at,
  drop column if exists updated_at;
commit;
```

**Funktiota `public.touch_updated_at()` EI pudoteta yllä.** Se on jaettu:
migraatiot 0003 ja 0004 luovat sille liipaisimet omiin tauluihinsa. Jos
kumpikaan ei ole ajettu, funktion voi pudottaa — mutta tarkista se ensin
äläkä oleta:

```sql
select tgname, tgrelid::regclass as taulu
from pg_trigger
where tgfoid = 'public.touch_updated_at'::regproc and not tgisinternal;
```

Jos tulos on tyhjä, `drop function if exists public.touch_updated_at();`
on turvallinen. Jos ei ole, jätä funktio paikalleen — se ei häiritse
mitään.

### D. Lippu on käännetty ja sovellus on kirjoittanut uusiin sarakkeisiin

**Peruminen ei ole enää vaaratonta, eikä sitä pidä esittää sellaisena.**

Sarakkeissa on silloin käyttäjän itsensä kirjoittamaa tietoa — kuvauksia,
kestoja, prioriteetteja — jota ei ole missään muualla. `drop column`
hävittää sen lopullisesti ja hiljaa: lause onnistuu, mitään ei valiteta,
ja tieto on poissa.

Oikea järjestys on tässä tilanteessa **eteenpäin korjaaminen**:

1. Käännä `TASK_EXTENDED_FIELDS` takaisin arvoon `false` ja julkaise.
   Sovellus lakkaa kirjoittamasta uusiin sarakkeisiin heti. Tieto jää
   kantaan koskemattomana.
2. Selvitä vika rauhassa. Skeema saa jäädä paikalleen: ylimääräiset
   sarakkeet eivät haittaa vanhaa koodia, koska ne ovat nullable tai
   niillä on oletusarvo.
3. Korjaa syy, aja `verify_0002.sql` uudelleen ja käännä lippu vasta
   sitten takaisin.

Jos skeema on siitä huolimatta pakko purkaa, ota **ensin** talteen se,
mikä katoaa:

```sql
select id, description, duration_minutes, priority, scheduling_state
from public.tasks
where description is not null
   or duration_minutes is not null
   or priority <> 'normaali'
   or scheduling_state <> 'manual';
```

Kopioi tulos talteen ja vasta sitten aja kohdan C lohko.

### E. Sovellus rikkoutui lipun kääntämisen jälkeen

Yleisin syy on skeemavälimuisti, ei migraatio. PostgREST pitää oman
kuvansa skeemasta, eikä se päivity DDL:stä itsestään. Oire on virhe,
joka väittää sarakkeen puuttuvan vaikka `verify_0002` näkee sen.

Supabase Dashboard → **Settings → API → Reload schema cache**.

**Älä palauta varmuuskopiosta äläkä pura migraatiota tämän takia.**

---

## Mitä 0002 ei riko

| Huoli | Miksi se ei toteudu |
|---|---|
| Olemassa oleva data katoaa | Migraatio ei sisällä yhtäkään `drop`-, `truncate`- eikä `delete`-lausetta. Testi vartioi sitä. |
| Rivit kirjoitetaan uudelleen | `not null default <vakio>` ei kirjoita taulua uudelleen PostgreSQL 11:stä lähtien: oletus tallennetaan kerran metatietoon. |
| Uudet sarakkeet ovat suojaamattomia | Politiikat ovat rivikohtaisia ja `grant` taulutasoinen — molemmat kattavat uudet sarakkeet automaattisesti. `verify_0002` tarkistaa myös sarakekohtaiset oikeudet. |
| Vanha koodi hajoaa | Jokainen uusi sarake on joko nullable tai sillä on oletusarvo, joten vanha `insert` toimii muuttumattomana. |
| Liipaisin pääsee toisen käyttäjän riveihin | `touch_updated_at` on `security invoker` ja kirjoittaa vain `new.updated_at`. Se ei ohita RLS:ää eikä lue mitään. |
| Migraatio jää roikkumaan | `lock_timeout = 5s`. Se keskeytyy ennemmin kuin jonouttaa sovelluksen taakseen. |

---

## Mitä tämä paketti EI todista

Nämä ovat **staattisia** tarkistuksia: testit lukevat SQL:ää tekstinä
eivätkä aja sitä. Ne todistavat, ettei migraatio sisällä niitä
rakenteita, jotka aiemmin menivät pieleen — eivät sitä, että se toimii
oikeassa kannassa.

Ainoa todiste jälkimmäisestä on migraation ajaminen ja `verify_0002.sql`.

0002 ei myöskään vaadi uutta kahden tilin eristystestiä: se ei luo uusia
tauluja eikä kosketa politiikkoihin, joten 0001:n hyväksyntä on yhä
voimassa. Jos joku kuitenkin muuttaa politiikkoja tai lisää taulun,
eristystesti on toistettava — ks. [`RLS-ACCEPTANCE.md`](RLS-ACCEPTANCE.md).
