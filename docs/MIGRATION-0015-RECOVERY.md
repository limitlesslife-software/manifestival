# Migraatio 0015 — mielen kuorman keventäminen: palautuminen

**Tila:** valmisteltu, EI AJETTU. Portit `protectedPeriods`, `weeklyPlans`
ja sarakeportti `MENTAL_LOAD_FIELDS` ovat `false`. Tuotanto: aalto F / v19
/ kanta 0009. Aalto L (v25) avaa portit vasta kun 0015 on ajettu.

Migraatio: `supabase/migrations/0015_mental_load.sql`. Sopimus:
`docs/MENTAL-LOAD-CORE.md`. Tämä dokumentti vastaa yhteen kysymykseen:
**mitä tehdä, kun jokin menee pieleen — ja miten kanta palautetaan
tilaan 0014.**

Kaikki tässä kuvattu on harjoiteltu **paikallisella PostgreSQL 17.10:llä**
molemmilla `tasks.date`-tyypeillä (`text`, `date`):
`tools/pg-rehearsal` (skenaariot `rollback`, `rollback:data`,
`rollback:reverse-chain`, `failure`, `backup`). Tuotantoon ei ole ajettu
mitään tästä dokumentista.

---

## §0 TL;DR

1. **Varmuuskopio on PAKOLLINEN** (aalto L: `backupRequired: true`), koska
   0015 muuttaa tuotannossa auki olevaa `tasks`-taulua:
   `supabase/backup/snapshot_state_0014.sql` → vie tulos tiedostoksi →
   `node tools/activation/restore-snapshot.mjs check <tiedosto> --save` →
   **TILANNEKUVA KUNNOSSA**.
2. `supabase/preflight/preflight_0015.sql` → 0 FAIL. **Kirjaa rivin
   "tasks.date NOT NULL ennen 0015:tä" arvo ajopäiväkirjaan** — peruutus
   tarvitsee sen (§4).
3. Hyväksyntä ("hyväksyn 0015/L") → 0015 → `supabase/verify/verify_0015.sql` → 0.

Jos 0015 päättyy virheeseen: **mitään ei muuttunut** (yksi transaktio).
**Älä palauta. Älä aja ROLLBACK-osiota.** Lue §3.

---

## §1 Mitä 0015 tekee

| Taulu | Muutos |
|---|---|
| `life_areas` | +`kind text not null default 'STANDARD'` + CHECK (6 arvoa); `life_areas_category_unique` **poistetaan**; +ei-uniikki indeksi `life_areas_user_category_idx (user_id, category_key)` |
| `tasks` | +`horizon`, +`waiting_on`, +`follow_up_date`, +`archived_at`, +`reschedule_count integer not null default 0`, +`original_date`; 4 CHECKiä; `date` **drop not null** (idempotentti) |
| `protected_periods` | uusi taulu (suojattu aika: oma aika, vapaa-ajan säännöt, loma) |
| `weekly_plans` | uusi taulu (viikkosuunnitelma, sunnuntain nollaus) |

**47 objektia:** 2 taulua, 7 saraketta, 26 rajoitetta, 2 indeksiä,
2 liipaisinta, 8 politiikkaa. Luku on osittaisen ajon tunnistuksen
perusta (migraation vaihe 0b, `preflight_0015`, inventaarion rivi 24).

0015 **ei kirjoita yhtäkään riviä uudelleen**: `add column … default
<vakio>` on katalogimuutos (PostgreSQL 11+). Harjoittelu todistaa, että
jokaisen tehtävän ja alueen `xmin` ja taulun `relfilenode` pysyvät
ennallaan (`upgrade:text`, `upgrade:typed`).

### Inventaarion erityispiirre

0015 poistaa yhden 0012:n objektin (`life_areas_category_unique`). Täysin
ajetun 0015:n jälkeen 0012:n tunnistus laskee siksi **57** eikä 58.
`tools/activation/score-inventory.mjs` tietää tämän
(`SUPERSEDED_OBJECTS`): 57 on "ajettu", kun rivi 24 (0015) on täysi 47.
Muulloin 57 on yhä "kesken".

---

## §2 Ennen ajoa (T-0)

Sovellus suljettuna kaikilta laitteilta (0015 lukitsee `tasks`-taulun
ACCESS EXCLUSIVE -lukolla; `lock_timeout` 5 s):

1. `supabase/preflight/preflight_0015.sql` (vain luku) → 0 FAIL.
   Kirjaa INFO-rivit: tehtävien ja alueiden määrä, `tasks.date`-sarakkeen
   tyyppi ja **NOT NULL ennen 0015:tä** (`kyllä`/`ei`).
2. `supabase/backup/snapshot_state_0014.sql` → vienti →
   `restore-snapshot.mjs check --save` → TILANNEKUVA KUNNOSSA.
3. Ajo postgres-roolilla SQL-editorissa, koko tiedosto yhdellä kertaa.
4. `supabase/verify/verify_0015.sql` → `poikkeavia_yhteensa = 0`.

---

## §3 Jos 0015 päättyy virheeseen

Yksi transaktio: ERROR = **mitään ei muuttunut**. Aja samassa välilehdessä
`rollback;`, sitten tulkitse viesti:

| Viesti | Syy | Toimi |
|---|---|---|
| `Migraatio 0015 on JO AJETTU` | 47/47 objektia on jo kannassa | älä aja uudelleen; aja `verify_0015.sql` |
| `Migraatio 0015 on kesken: N objektia 47:sta` | osittainen tila (käsin tehty muutos tai keskeytynyt kokeilu) | **pysähdy**, liitä viesti ja inventaario Claudelle; ei uudelleenajoa |
| `Migraatio 0014 pitaa ajaa ensin` | juna ei ole tilassa 0014 | aja 0014 + verify_0014 ensin |
| `life_areas_category_unique puuttuu, vaikka 0015:n objekteja on 0/47` | kantaa on muutettu käsin | pysähdy; selvitä ennen mitään |
| `lock timeout` / `canceling statement due to lock timeout` | sovellus tai toinen välilehti piti `tasks`/`life_areas`/`auth.users`-lukkoa | sulje sovellus ja välilehdet, aja uudelleen |
| `Hyvaksyttya omistajaa … ei loydy` | väärä projekti | pysähdy |

Uudelleenajon tunnistus tapahtuu **ennen** lukitusta: "JO AJETTU" ja
"kesken" tulevat heti, vaikka sovellus pitäisi `tasks`-taulua
(harjoiteltu: `failure`, `failure:0010-locks`: 0015:n estäjämatriisi ja uudelleenajo tasks-lukon aikana).

---

## §4 Peruutus tilaan 0014 (ROLLBACK)

**Vain, jos 0015 on ajettu ja se on päätetty perua.** Järjestys:

1. **Sulje portit ensin**: aallon L revert aaltoon K (v24-koodi ei lähetä
   0015:n sarakkeita). Jos kanta peruttaisiin aallon L koodin ollessa
   tuotannossa, jokainen tehtävän tallennus kaatuisi (42703).
2. **Tilannekuva tilasta 0015:** `supabase/backup/snapshot_state_0015.sql`
   → vienti → `restore-snapshot.mjs check --save`. Peruutus poistaa
   suojatut jaksot, viikkosuunnitelmat, horisontit, odotukset,
   arkistoinnit, siirtolaskurit ja alueiden lajit pysyvästi.
3. **Ennakkokysely (vain luku)** — kolme lukua ajopäiväkirjaan:

   ```sql
   select
     (select count(*) from (select 1 from public.life_areas
        where category_key is not null
        group by user_id, category_key having count(*) > 1) d) as jaetut_kategoriat,
     (select count(*) from public.tasks where date is null) as paivattomat_tehtavat,
     (select count(*) from public.tasks where archived_at is not null) as arkistoidut;
   ```

   - `jaetut_kategoriat` > 0: kategorian uniikkiutta **ei voi** palauttaa.
     Päätä käyttäjän kanssa, mikä alue säilyttää kategorian, ja aseta
     muille `category_key = null` (tai peru peruutus). Peruutuksen oma
     vartija kaatuu muuten (mitään muuttamatta).
   - `paivattomat_tehtavat` > 0: aallon K koodi lukee ne, mutta tehtävällä
     ei ole päivää. Ks. "tasks.date" alla.
   - `arkistoidut` > 0: arkistoidut tehtävät palaavat näkyviin
     (`archived_at` katoaa). Kerro käyttäjälle.

4. **Peruutus** (sama kuin migraation ROLLBACK-osio; harjoiteltu
   `rollback`-skenaariossa: katalogi palaa täsmälleen tilaan 0014 ja 0015
   menee uudelleen läpi):

```sql
begin;
set local lock_timeout = '5s';
lock table public.tasks, public.life_areas in access exclusive mode;

-- Vartija: kategorian uniikkiutta ei voi palauttaa, jos aallon L
-- aikana kaksi aluetta on saanut saman kategorian.
do $$
begin
  if exists (select 1 from public.life_areas where category_key is not null
              group by user_id, category_key having count(*) > 1) then
    raise exception 'Kaksi aluetta jakaa kategorian: ratkaise ennen peruutusta (MIGRATION-0015-RECOVERY.md).';
  end if;
end $$;

drop table public.weekly_plans;
drop table public.protected_periods;

alter table public.tasks drop constraint tasks_waiting_on_horizon_check;
alter table public.tasks drop constraint tasks_reschedule_count_check;
alter table public.tasks drop constraint tasks_waiting_on_check;
alter table public.tasks drop constraint tasks_horizon_check;
alter table public.tasks drop column original_date;
alter table public.tasks drop column reschedule_count;
alter table public.tasks drop column archived_at;
alter table public.tasks drop column follow_up_date;
alter table public.tasks drop column waiting_on;
alter table public.tasks drop column horizon;

drop index public.life_areas_user_category_idx;
alter table public.life_areas drop constraint life_areas_kind_check;
alter table public.life_areas drop column kind;
alter table public.life_areas
  add constraint life_areas_category_unique unique (user_id, category_key);

commit;
```

5. `supabase/verify/verify_0014.sql` → 0 poikkeavaa (harjoiteltu:
   `rollback:data`).
6. Muista `src/data/schema.js`: `TABLES.protectedPeriods = false`,
   `TABLES.weeklyPlans = false`, `MENTAL_LOAD_FIELDS = false` (aallon K
   koodissa ne ovat jo false).

### tasks.date — miksi NOT NULL -ehtoa EI palauteta peruutuksessa

`alter table public.tasks alter column date drop not null` on
idempotentti: jos sarake oli jo nullable (harjoittelun lähtötila, ja
todennäköisesti tuotanto — `docs/SCHEMA.md` ei tunne ehtoa), lause ei
tehnyt mitään. Peruutus ei voi tietää, oliko ehto olemassa, joten se ei
arvaa:

- **Esitarkistus kirjasi "ei"** (tai harjoittelu): älä tee mitään.
  Ehdon lisääminen muuttaisi tilaa, jota ei koskaan ollut.
- **Esitarkistus kirjasi "kyllä"**: palauta ehto VASTA kun päivättömät
  tehtävät on käsitelty (annettu päivä tai poistettu käyttäjän kanssa).
  Muuten `set not null` kaatuu (23502) — mikä on oikein: se estää
  päivättömän rivin hiljaisen katoamisen.

  ```sql
  begin;
  set local lock_timeout = '5s';
  -- 0 = voidaan palauttaa
  select count(*) from public.tasks where date is null;
  alter table public.tasks alter column date set not null;
  commit;
  ```

Nullable `date` ilman ehtoa on aallon K koodille harmiton: se ei luo
päivätöntä tehtävää.

---

## §5 Tilannekuvan palautus

Työkalu: `tools/activation/restore-snapshot.mjs` (sama kuin 0010:ssä,
ks. `docs/activation/0010-BACKUP-AND-RECOVERY.md` §8). Vienti ja
palautusskripti sisältävät henkilötietoja: työkalu kirjoittaa vain
git-ignoroituun `.local-backups/db/<UTC>_state_00NN/`-hakemistoon.

| Kanta nyt | Kuva | Tulos |
|---|---|---|
| tila 0015 | `snapshot_state_0015` | täysi palautus, myös 0015:n sarakkeet ja taulut |
| tila 0014 (peruutuksen jälkeen) | `snapshot_state_0014` | täysi palautus tilaan 0014 |
| tila 0015 | `snapshot_state_0014` | 0014:n rivit palautuvat; uudet sarakkeet saavat oletuksensa (NULL, `reschedule_count = 0`, `kind = 'STANDARD'`); uudet taulut koskematta |
| tila 0014 | `snapshot_state_0015` | **hylätään** (`Skeema ei vastaa tilannekuvaa`): aja ensin 0015 tai käytä tilan 0014 kuvaa |

```sh
node tools/activation/restore-snapshot.mjs restore .local-backups/db/<UTC>_state_0014/vienti.csv --dry-run
node tools/activation/restore-snapshot.mjs restore .local-backups/db/<UTC>_state_0014/vienti.csv
node tools/activation/restore-snapshot.mjs compare .local-backups/db/<UTC>_state_0014/vienti.csv
```

Järjestys: kuivaharjoitus (`restore.dry-run.sql`, päättyy
`rollback;`iin) → palautus (`restore.sql`, yksi itsensä tarkistava
transaktio) → `compare.sql` (SAMA / SAMA+N UUTTA) → tilan verify
(`verify_0014.sql` tai `verify_0015.sql`) → F5.

---

## §6 Uudelleenajo peruutuksen jälkeen

Peruutuksen jälkeen kanta on täsmälleen tilassa 0014 (katalogi sama,
harjoiteltu). 0015 voidaan ajaa uudelleen samalla menettelyllä (§2):
`preflight_0015` → 0 FAIL → 0015 → `verify_0015` → 0.

---

## §7 Mitä EI tehdä

- **Älä aja 0015:tä uudelleen** "varmuuden vuoksi". Se kieltäytyy (JO
  AJETTU / kesken) — ja kesken-tila vaatii selvityksen, ei uutta ajoa.
- **Älä peru kantaa ennen koodia.** Aallon L koodi + tilan 0014 kanta =
  jokainen tehtävän tallennus kaatuu.
- **Älä poista `life_areas_category_unique`-vartijaa** peruutuksesta.
  Ilman sitä `add constraint … unique` kaatuu (23505) — tai, jos joku
  "korjaa" sen poistamalla rivejä, käyttäjän alueita katoaa.
- **Älä lisää `tasks.date`-sarakkeelle NOT NULL -ehtoa**, ellei
  esitarkistus kirjannut sen olleen olemassa.
- **Älä aja `tools/rls-acceptance`-työkalua tuotantoa vasten** osana
  palautusta ilman omistajan hyväksyntää.

---

## §8 Viitteet

- `supabase/migrations/0015_mental_load.sql` (ROLLBACK-osio)
- `supabase/preflight/preflight_0015.sql`, `supabase/verify/verify_0015.sql`
- `supabase/backup/snapshot_state_0014.sql`, `snapshot_state_0015.sql`
- `docs/activation/REHEARSAL-REPORT.md` (0015-osio)
- `docs/activation/0010-BACKUP-AND-RECOVERY.md` (tilannekuvan työkalut)
- `docs/MENTAL-LOAD-CORE.md` (sopimus)
