# Tietokantaskeema

Supabase-projekti: `twpyubcymdnbvelsjidg`

> **TILA: OSITTAIN TODENTAMATON.**
> Alla oleva skeema on **johdettu sovelluskoodista**, ei luettu tietokannasta.
> Repossa ei ole aiempia migraatioita, joten skeema on tähän asti elänyt vain
> Supabase-pilvessä. Todellinen rakenne on todennettava ajamalla
> `supabase/inventory.sql` (vain luku) ennen kuin migraatio 0001 ajetaan.

---

## Nykytila (johdettu koodista)

### `public.tasks`

| Sarake | Tyyppi (oletettu) | Selitys |
|---|---|---|
| `id` | text | Clientin generoima: `'m' + timestamp + satunnainen`. Vanhat rivit `'seed1'…'seed10'`. |
| `date` | date / text | `YYYY-MM-DD`, käyttäjän paikallinen päivä |
| `time` | time / text | `HH:MM` tai null |
| `end_time` | time / text | `HH:MM` tai null |
| `title` | text | Tehtävän nimi |
| `category` | text | `tyo`, `perhe`, `hyvinvointi`, `harrastus`, `koti`, `kehitys`, `talous`, `muu` |
| `note` | text | Vapaa muistiinpano tai null |
| `completed` | boolean | Kuitattu |
| `is_wake` | boolean | Päivän herätysankkuri. Enintään yksi per päivä. |

### `public.profile`

| Sarake | Tyyppi (oletettu) | Selitys |
|---|---|---|
| `id` | text | **Nykyisin kiinteä arvo `'me'`** — kaikille sama rivi |
| `age` | integer | |
| `weight_kg` | numeric | |
| `height_cm` | numeric | |
| `sleep_target_hours` | numeric | Oletus 8 |
| `default_wake_time` | time / text | Oletus `07:00` |
| `commute_minutes` | integer | Oletus 30 |
| `routine_minutes` | integer | Oletus 60, aamutoimien kesto |

### Mitä nykytilasta puuttuu

- **Ei omistajuutta.** Yhdelläkään rivillä ei ole `user_id`-saraketta.
- **Ei auth-kytkentää.** `profile.id = 'me'` on jaettu vakio.
- **RLS-tila tuntematon.** Ei todennettu.
- Ei `created_at`- / `updated_at`-sarakkeita.
- Ei indeksejä tiedossa.
- Ei Storage-bucketteja käytössä, ei RPC-funktioita, ei triggereitä (koodin
  perusteella; todennettava).

---

## Tavoitetila (migraatio 0001)

`supabase/migrations/0001_auth_user_scoping.sql` — **luonnos, ei ajettu.**

### `public.tasks` muutokset

```sql
user_id uuid NOT NULL
  DEFAULT auth.uid()
  REFERENCES auth.users(id) ON DELETE CASCADE

INDEX tasks_user_id_date_idx (user_id, date)
```

Kriittinen yksityiskohta: `DEFAULT auth.uid()`. Client **ei lähetä**
`user_id`-kenttää lainkaan (`src/lib/rows.js` varmistaa sen), joten
omistajuuden asettaa tietokanta. Selain ei voi valita toisen käyttäjän
tunnistetta edes silloin, jos sovelluskoodissa olisi virhe.

### `public.profile` muutokset

```sql
id uuid PRIMARY KEY
  DEFAULT auth.uid()
  REFERENCES auth.users(id) ON DELETE CASCADE
```

`profile` käyttää `id = auth.uid()` -mallia: yksi rivi per käyttäjä, ei
erillistä `user_id`-saraketta. Siksi RLS-politiikat kohdistuvat `id`-sarakkeeseen.

Migraatio **ei** muuta `profile.id`:n tyyppiä. Tuotannon ainoan rivin
arvo on `'me'`, eikä `'me'` ole uuid — `id::uuid` kaatuisi heti.
Sen sijaan vanha sarake nimetään `legacy_id`:ksi ja sen rinnalle
lisätään uusi `uuid`-sarake `id`, joka saa omistajan tunnisteen.

Alkuperäinen arvo säilyy siis kannassa. Se on tarkoituksellista: se on
ainoa asia, joka tekee migraatiosta purettavaksi ilman varmuuskopiota.
Varmuuskopio on silti pakollinen — ks.
[`PRODUCTION-ACTIVATION-RUNBOOK.md`](PRODUCTION-ACTIVATION-RUNBOOK.md).

---

## Omistajuusmalli

| Taulu | Omistajuussarake | RLS-ehto |
|---|---|---|
| `tasks` | `user_id` | `auth.uid() = user_id` |
| `profile` | `id` | `auth.uid() = id` |

Kaikki neljä operaatiota (`select`, `insert`, `update`, `delete`) rajataan
erikseen, ja `insert`/`update` käyttävät lisäksi `WITH CHECK` -ehtoa, jotta
riviä ei voi kirjoittaa toisen käyttäjän nimiin.

`anon`-roolille **ei luoda yhtään politiikkaa**, ja sen taulukohtaiset
oikeudet poistetaan (`revoke all`). Kirjautumaton käyttäjä ei näe eikä muuta
mitään. Tämä on tietoinen valinta: ilman autentikaatiota ei ole olemassa
käsitettä "oma data", joten anon-roolille ei voi määritellä turvallista rajausta.

---

---

## Migraatio 0002 — tehtävän domain-kentät

`supabase/migrations/0002_task_domain_fields.sql` — **luonnos, ei ajettu.**

Esiehto: migraatio 0001 on ajettu ja RLS on päällä. Migraatio tarkistaa tämän
itse ja keskeytyy virheeseen, jos ehto ei täyty.

| Sarake | Tyyppi | Selitys |
|---|---|---|
| `description` | text | Pidempi konteksti; otsikko pysyy lyhyenä |
| `duration_minutes` | integer, 1–1440 | Kesto, kun kellonaikaa ei ole |
| `priority` | text, not null, oletus `normaali` | `korkea` / `normaali` / `matala` |
| `scheduling_state` | text, oletus `manual` | `manual` / `auto` / `unscheduled` |
| `created_at` | timestamptz, oletus `now()` | |
| `updated_at` | timestamptz, oletus `now()` | Trigger päivittää |

Lisäksi indeksi `(user_id, date, priority)`.

**Miksi turvallinen:** puhtaasti additiivinen. Ei muuta eikä poista mitään.
Olemassa oleva data säilyy ja vanha koodi toimii sen jälkeenkin, koska kaikki
uudet sarakkeet ovat nullable tai niillä on oletusarvo.

**Peruttavissa** ilman tietohäviötä (uusiin sarakkeisiin tallennettu tieto
katoaa, vanha data säilyy). Rollback-SQL on migraation lopussa.

### Olemassa olevien rivien aikataulutuksen tila

Migraatio merkitsee vanhat rivit `manual`-tilaan, jos niillä on kellonaika.
Ne on luotu käyttäjän omilla toimilla, joten automaatti ei saa siirtää niitä.
Tämä on tietoinen valinta konseptin luvun 7 mukaisesti.

### Koodin käyttöönotto

Migraation jälkeen: `src/data/schema.js` → `TASK_EXTENDED_FIELDS = true`.
Yhden rivin muutos; kaikki muu koodi on jo valmiina.

**Ennen tätä** kuvaus, kesto, prioriteetti ja aikataulutuksen tila elävät vain
selaimen muistissa. Käyttöliittymä kertoo sen käyttäjälle — se ei teeskentele
tallentavansa niitä.

---

## Ajonaikainen skeematarkistus

Käännösaikaiset portit (`src/data/schema.js`) kertovat, mihin tämä
käännös AIKOO kirjoittaa. Kanta voi silti olla jäljessä: asennettu APK
kantaa porttinsa mukanaan, ja jokaisella migraatiolla 0009–0013 on
peruutus. Siksi sovellus tarkistaa kirjautumisen jälkeen, mitä kanta
oikeasti sisältää, ja voi **laskea** (ei koskaan nostaa) porttejaan.

### Vaatimukset

`SCHEMA_REQUIREMENTS` (`src/data/schema.js`) luettelee jokaiselle
portille sen sarakejoukon ja migraation:

| Tyyppi | Esimerkki | Puutteen seuraus |
|---|---|---|
| ydin | `0001.tasks`, `0001.profile` | huoltotila: ei kirjoituksia |
| taulu | `0012.time_entries` | puuttuu: tyhjä lataus; sarakkeita puuttuu: vain luku |
| sarakeportti | `0010.goals` (GOAL_PLANNING_FIELDS) | sarakkeet jätetään pois |
| sarakeportti, `lowerAs: 'readonly'` | `0013.time_entries` | taulu vain luettavaksi |

Tehtävän liitokset (`deadline`, `goal_id`, `project_id`, migraatio 0004)
ovat oma sarakeporttinsa `TASK_LINK_FIELDS`, joka on auki täsmälleen
silloin kun goals- ja projects-portit ovat. `GOAL_MAINTENANCE_MODE`
tarkistetaan 0010:n sarakkeesta `goals.metric`: jokainen migraatio on
yksi transaktio, joten yksi sarake todistaa koko migraation.

Testi `tests/schema-compat-matrix.test.mjs` vertaa vaatimuksia
migraatioihin ja repositorioiden rivimuunnoksiin, ja ajaa oikean koodin
aaltojen C–J porteilla kannan tiloja 0008, +0009, +0010, +0011, +0012,
0008+0012, +0013 ja "0013 ilman operation_id:tä" vastaan.

### Tarkistus

- Yksi `GET` per taulu: `select=<sarakkeet>&limit=0`. Ei rivejä, ei
  kirjoituksia, ei `head`-pyyntöä (siitä puuttuisi virhekoodi).
- Puuttuva sarake tarkennetaan vaatimus kerrallaan.
- `PGRST205`/`42P01` = taulu puuttuu, `42703`/`PGRST204` = sarake puuttuu,
  `42501` = kielletty (ei välimuistiin). Kaikki muu = ei tiedetä.
- Välimuistin avain: `manifestival.schemaCompat.v1.<tiiviste>` palvelimen
  osoitteesta ja tämän käännöksen vaatimuksista.

### Ylläpito

Migraation jälkeen PostgRESTin skeemavälimuisti on ladattava uudelleen
(ajo-ohjeen "Reload schema cache"). Jos se unohtuu, tarkistus voi mennä
läpi (se kysyy PostgreSQL:ltä), mutta kirjoitus kaatuu PGRST204:ään.
Reaktiivinen kerros laskee silloin portin istunnon ajaksi, joten tehtävät
ja tavoitteet tallentuvat silti — ilman uusia kenttiä.

---

## Ajojärjestys

Migraatio ja siitä riippuva koodi ovat toisistaan riippuvaisia. Väärä
järjestys rikkoo tuotannon.

```
1. Aja supabase/inventory.sql            (vain luku, todentaa skeeman)
2. Sovita migraatio 0001 todelliseen skeemaan
3. Ota varmuuskopio
4. Luo itsellesi tili sovelluksen kirjautumisnäkymästä
   -> saat auth.users-tunnisteen migraation backfill-vaiheeseen
5. Aja migraatio 0001
6. Varmista migraation lopun tarkistuskyselyillä
7. Vasta sitten julkaise auth-koodi tuotantoon
```

Vaiheiden 5 ja 7 välissä tuotannossa oleva vanha koodi **ei toimi**, koska se
kysyy `profile`-riviä arvolla `'me'` eikä lähetä `user_id`:tä. Käytännössä
vaiheet 5–7 kannattaa tehdä peräkkäin lyhyen katkon aikana.
