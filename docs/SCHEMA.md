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

Migraatio siirtää vanhan `'me'`-rivin omistajalle ja muuttaa tyypin
`text -> uuid`. Tämä vaihe **ei ole häviöttömästi peruttavissa**, joten
varmuuskopio on pakollinen.

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
