# Migraatio 0010 — varmuuskopio ja palautuminen

Koskee ensisijaisesti migraatiota `supabase/migrations/0010_goal_to_action.sql`
(aalto G). Samat työkalut toimivat jokaiselle 0009–0013:lle: tilannekuva on
generoitu jokaiselle tilalle 0008–0013 (`supabase/backup/`).

Kaikki tässä kuvattu on harjoiteltu **paikallisella PostgreSQL 17.10:llä**
tuotannon muotoisesta lähtötilasta molemmilla `tasks.date`-tyypeillä
(`tools/pg-rehearsal/rehearse-backup.mjs`, §10). Se, mitä voi todentaa vain
tuotannossa, on lueteltu erikseen (§10). **Tuotantoon ei ole ajettu mitään
tästä dokumentista.**

---

## §0 TL;DR

**Ensisijainen varmuuskopio = looginen tilannekuva (suunnitelmasta
riippumaton, todennettu paikallisesti); Supabase-varmuuskopio/PITR = lisä,
jos olemassa.**

Ajopäivänä, sovellus suljettuna kaikilta laitteilta:

1. `supabase/preflight/preflight_0010.sql` → 0 FAIL
2. `supabase/backup/snapshot_state_0009.sql` → vie tulos tiedostoksi →
   `node tools/activation/restore-snapshot.mjs check <tiedosto> --save` →
   **TILANNEKUVA KUNNOSSA**
3. Kirjaa ajopäiväkirjaan (§4) → hyväksyntä → 0010 → `supabase/verify/verify_0010.sql` → 0

Jos 0010 päättyy virheeseen: **mitään ei muuttunut** (yksi transaktio).
**Älä palauta. Älä aja ROLLBACK-osiota.** Lue §6.

---

## §1 Mitä 0010 koskee

| Taulu | Muutos |
|---|---|
| `goals` | +7 nullable-saraketta (`metric`, `unit`, `baseline_value`, `current_value`, `target_value`, `measured_on`, `savings_goal_id`), +4 CHECK-rajoitetta, `goals_status_check` **korvataan** (sallii lisäksi `maintenance`) |
| `tasks` | +`milestone_id`, +`depends_on text[] not null default '{}'` |
| `projects` | +`milestone_id` |
| `profile` | +`automation_level`, +`planning_buffer_ratio` (oletusarvoin) |
| `milestones` | uusi taulu |

Yhteensä 38 objektia. 0010 **ei muuta olemassa olevien rivien sisältöä**:
paikallisesti todennettu, että jokainen 0010:tä edeltänyt rivi on 0010:n
jälkeen tavu tavulta sama vanhoilla sarakkeillaan, `updated_at` mukaan
lukien (B3, §10).

Rivimäärät luetaan ajopäivänä `preflight_0010.sql`:n INFO-riveiltä 11
(tavoitteet), 12 (projektit), 13 (profiilit) ja 18 (tehtävät). Viimeisin
repositorioon kirjattu perustila on `tasks` 36 ja `profile` 1
(`docs/PRODUCTION-STATUS.md`); muiden taulujen nykyisiä lukuja ei ole
kirjattu, joten ne kirjataan ajopäiväkirjaan tilannekuvasta.

---

## §2 Mitä varmuuskopioidaan

Tila 0009 = migraatiot 0001–0009 ajettu. `snapshot_state_0009.sql` lukee
**kaikki 14 public-taulua**:

`tasks`, `profile`, `routines`, `routine_exceptions`, `goals`, `projects`,
`notification_preferences`, `wellbeing_entries`, `recurring_expenses`,
`bills`, `savings_goals`, `ai_action_audit`, `transactions`, `investments`.

| Ryhmä | Taulut | Miksi |
|---|---|---|
| Pakolliset | `goals`, `projects`, `tasks`, `profile` | 0010 muuttaa näitä |
| Vierasavainten takia | `routines`, `routine_exceptions`, `bills` | tavoitteen/tehtävän poisto nollaa (SET NULL) tai poistaa (CASCADE) näiden rivejä |
| Täydellisyyden vuoksi | loput | pieniä; palautuksen viite-eheys vaatii koko kuvan |
| **EI KOSKAAN** | `auth.*` | salasanatiivisteet; tilejä ei voi palauttaa SQL:llä. Kuvaan luetaan vain omistajan olemassaolo ja käyttäjien lukumäärä |

### Tietosuoja ja säilytys

Tilannekuva ja palautusskripti **sisältävät henkilötietoja** (tehtävien
otsikot ja muistiinpanot, profiilin ikä ja paino, summat).

- Säilytyspaikka: projektin hakemisto `.local-backups/db/<UTC>_state_0009/`.
  `.gitignore` ignoroi `/.local-backups/`.
- `restore-snapshot.mjs` kirjoittaa **vain** git-ignoroituun polkuun
  projektin sisällä, kieltäytyy versionhallitusta polusta eikä **koskaan
  ylikirjoita** (testattu, `tests/activation-backup.test.mjs`).
- Päätteeseen työkalu tulostaa vain lukumäärät, tiivisteet ja tunnisteet.
- Älä liitä tilannekuvaa tai `restore*.sql`:ää chattiin, issueen,
  committiin tai pilveen.
- `compare.sql` sisältää vain rivien tunnisteet ja tiivisteet — sen voi
  jakaa.
- Toinen kopio (esim. salattu levy) on **omistajan päätös**. Selvitä
  myös, synkronoiko jokin (esim. OneDrive) työpöytäkansion pilveen.

---

## §3 Kerrokset

### L1 — looginen tilannekuva (PAKOLLINEN)

`supabase/backup/snapshot_state_0009.sql` on **yksi vain lukeva SELECT**
(generoitu: `tools/activation/build-snapshots.mjs`). Yksi lause näkee koko
kannan yhdellä MVCC-tilannekuvalla, joten taulut eivät voi olla eri
hetkiltä. Tulos:

- rivi `00` = MANIFEST: muoto, tila, kanta, palvelin, hetki (UTC),
  istunnon aikavyöhyke, rooli ja sen BYPASSRLS, omistajan olemassaolo,
  auth-käyttäjien lukumäärä ja taulukohtaisesti rivit, md5, tavut,
  sarakkeet tyyppeineen, pääavain, vierasavaimet, liipaisimet,
  taulun omistaja ja RLS/FORCE RLS;
- rivit `01`–`14` = yksi rivi per taulu: koko taulu tekstinä
  (`jsonb_agg(to_jsonb(x))::text`) ja sen md5.

`restore-snapshot.mjs check` todentaa MANIFESTin ja jokaisen taulun
tiivisteen, rivimäärät, tavumäärät ja viite-eheyden (jokainen
tilannekuvan sisäinen viittaus osuu tilannekuvaan). Katkennut, muokattu
tai repeytynyt kuva hylätään.

### L2 — Supabasen oma varmuuskopio (VALINNAINEN)

Ei koskaan ainoa kopio. Vahvista ennen ajopäivää ja kirjaa:

1. **Tilaus:** Organization → Billing → mikä suunnitelma.
2. **Varmuuskopiot:** Database → Backups → uusimman varmuuskopion
   aikaleima. Oletus (ei todennettu): ajastettua varmuuskopiota ei voi
   käynnistää pyynnöstä — sen jälkeen tehdyt kirjoitukset ovat vain
   L1:ssä. Repositoriossa on kaksi havaittua aikaleimaa
   (`03 Sep 2026 13:36:47 UTC`, `2026-09-05 06:57:15 UTC`), jotka viittaavat
   ajastettuihin varmuuskopioihin, mutta suunnitelmaa ei ole vahvistettu.
3. **PITR:** onko Point in Time Recovery päällä ja mikä on varhaisin
   palautuspiste.

Supabasen palautus koskee **koko projektia** (myös `auth`), vaatii
katkon ja kadottaa kaiken palautuspisteen jälkeen kirjoitetun. Sitä ei
käytetä rivitason vahinkoon (§7 D) — vain tapaukseen E.

Jos varmuuskopion voi ladata tiedostona, sen vastaavuuden L1:n kanssa voi
tarkistaa palauttamalla sen paikalliseen kertakäyttöiseen kantaan ja
ajamalla siellä `compare.sql`:n. **Tätä ei ole harjoiteltu.**

### L3 — pg_dump / `supabase db dump` (VALINNAINEN)

Vaatii pg_dump ≥ 17 (ei ole projektin `.claude/pg-local`-hakemistossa) ja
tietokannan salasanan. Repositorion koodi ei käytä tietokannan salasanaa
(`api/` lukee vain `ANTHROPIC_API_KEY`:n ja `PARSE_REQUIRE_AUTH`:n;
`supabase/functions/delete-account` käyttää API-avaimia eikä ole
deployattu), joten salasanan vaihto ei rikkoisi repositorion koodipolkuja
— ulkoisia integraatioita ei näe repositoriosta. Tulos säilytetään
`.local-backups/`-hakemistossa. **Ei harjoiteltu; omistajan päätös.**

---

## §4 Aikajana

### T-2 päivää: tuotannon kuivaharjoitus — VAATII OMISTAJAN HYVÄKSYNNÄN

Kuivaharjoitus todistaa ne kaksi asiaa, joita paikallinen harjoittelu ei
voi todistaa: SQL-editorin vienti säilyttää suuren solun tavu tavulta, ja
`postgres`-rooli voi ajaa palautuksen. **Se ottaa lyhyitä lukkoja
(`alter table … disable trigger user` ottaa taulukohtaisen lukon) ja ajaa
rivimuutoksia, jotka perutaan (`rollback;`).** Nettomuutos on nolla, mutta
se on kirjoittava ajo tuotannossa — siksi **omistajan erillinen
hyväksyntä** ja sovellus suljettuna.

1. Aja `supabase/backup/snapshot_state_0009.sql` (vain luku).
2. Vie **koko** tulos tiedostoksi (CSV tai JSON; editorin valikon nimet
   voivat poiketa). Älä kopioi soluja käsin.
3. `node tools/activation/restore-snapshot.mjs check <tiedosto> --save`
   → **TILANNEKUVA KUNNOSSA**. Jos tiiviste ei täsmää, kokeile toista
   vientimuotoa (CSV ↔ JSON).
4. `node tools/activation/restore-snapshot.mjs compare .local-backups/db/<UTC>_state_0009/vienti.csv`
   → aja syntynyt `compare.sql` → jokainen rivi **SAMA**.
5. `node tools/activation/restore-snapshot.mjs restore .local-backups/db/<UTC>_state_0009/vienti.csv --dry-run`
   → aja syntynyt `restore.dry-run.sql` **uudessa välilehdessä kokonaan**
   → onnistuminen = ei ERROR-riviä. Jos tulee ERROR, aja samassa
   välilehdessä `rollback;` ja kirjaa viesti (§8).

### T-0: ajopäivä

1. Sulje sovellus kaikilta laitteilta ja välilehdiltä.
2. `supabase/preflight/preflight_0010.sql` → 0 FAIL.
3. `supabase/backup/snapshot_state_0009.sql` → vie tiedostoksi →
   `node tools/activation/restore-snapshot.mjs check <tiedosto> --save`.
   `--save` arkistoi viennin ja raportin hakemistoon
   `.local-backups/db/<UTC>_state_0009/` (`vienti.*`, `check.txt`).
   Poista sen jälkeen alkuperäinen lataus (esim. Lataukset-kansiosta).
4. Vertaa `check`in rivejä 11, 12, 13 ja 18 preflightin samoihin riveihin:
   luvut ovat samat.
5. Kirjaa ajopäiväkirjaan:
   - tilannekuvan hetki (UTC) ja MANIFEST md5 (`check.txt`)
   - taulukohtaiset md5:t ja rivimäärät (`check.txt`)
   - L2: uusimman Supabase-varmuuskopion aikaleima tai PITR-piste, jos on
   - `git hash-object` tiedostoille `supabase/migrations/0010_goal_to_action.sql`,
     `supabase/verify/verify_0010.sql`, `supabase/preflight/preflight_0010.sql`
     ja `supabase/backup/snapshot_state_0009.sql`
6. Valmiiksi (ei ajeta): `compare` ja `restore --dry-run` samasta
   viennistä, jotta ne ovat käsillä virhetilanteessa.
7. Hyväksyntä → `supabase/migrations/0010_goal_to_action.sql` kokonaan,
   uudessa välilehdessä → `supabase/verify/verify_0010.sql` → 0 poikkeavaa.
8. Aja `compare.sql` → jokainen rivi **SAMA** (0010 ei muuta vanhoja
   sarakkeita).

---

## §5 Miten varmistat, että varmuuskopio on olemassa

Varmuuskopio on olemassa vasta, kun **kaikki** pätee:

1. `check` tulostaa **TILANNEKUVA KUNNOSSA** (tiivisteet, rivimäärät,
   tavumäärät ja viite-eheys täsmäävät).
2. `.local-backups/db/<UTC>_state_0009/vienti.*` on olemassa, ja sen
   koko ja md5 ovat samat kuin `check.txt`:ssä.
3. Rivimäärät ovat samat kuin `preflight_0010.sql`:n riveillä 11, 12, 13
   ja 18.
4. Heti otetun kuvan `compare.sql` näyttää jokaisella rivillä **SAMA**.

Pelkkä ladattu tiedosto ei ole varmuuskopio ennen kuin `check` on
hyväksynyt sen.

---

## §6 Jos 0010 päättyy virheeseen

**Keskeytynyt ajo perutaan kokonaan.** 0010 on yksi transaktio
(`begin … commit`, `set local lock_timeout = '5s'`): harjoittelu todensi
katalogin olevan täsmälleen ennallaan jokaisessa virhetilanteessa, myös
lukon aikakatkaisussa (`docs/activation/REHEARSAL-REPORT.md`, failure).
Vain osittain (valintana) ajettu tiedosto ilman
`begin`iä voisi jättää `goals`-taulun ilman tilarajoitetta —
`preflight_0010.sql`:n rivi 09 ja `verify_0010.sql`:n rivi 20
havaitsevat sen.

Tee näin:

1. Aja samassa välilehdessä `rollback;` ja lue virheilmoitus.
2. Aja `supabase/preflight/preflight_0010.sql` uudelleen: rivi 09 = **1**
   (tilarajoite paikallaan) ja rivi 14 = **0** (0/38 objektia).
3. Aja `compare.sql` → jokainen rivi **SAMA**.
4. **Älä palauta.** Mitään ei muuttunut.
5. **Älä aja ROLLBACK-osiota.** Sen poistamat objektit eivät ole
   olemassa, ja se kaatuisi.
6. Älä aja 0010:tä uudelleen ennen kuin syy on selvä.
   `lock_timeout` / `canceling statement` = sovellus piti lukkoa: sulje
   sovellus ja aja uudelleen (harjoittelussa uusi ajo meni läpi lukon
   vapauduttua).

Erikoisviestit:

- **"Migraatio 0010 on JO AJETTU"** → aja `supabase/verify/verify_0010.sql`.
- **"Migraatio 0010 on kesken: N objektia 38:sta"** → pysähdy. Tila ei
  synny kaatumisesta vaan käsin luoduista objekteista; toimi kuten
  `docs/MIGRATION-0004-RECOVERY.md`, CASE B2.

---

## §7 Päätöspuu

### A. Virhe kesken ajon

→ §6. Ei palautusta.

### B. Commit onnistui, mutta `verify_0010` näyttää poikkeavia > 0

- Aallon G commitia ei deployata; portit pysyvät kiinni.
- Aja `compare.sql` → odotus **SAMA** kaikkialla (0010 ei muuta vanhoja
  sarakkeita; todennettu B3).
- **B1:** jos poikkeama on `verify`-tiedoston väärä hälytys, korjaa
  tiedosto (ennakkotapaus: `verify_0011` rivi 12).
- **B2:** muuten aja 0010:n ROLLBACK-osio (alla). Se on tässä turvallinen:
  `milestones` on tyhjä eikä yksikään tavoite ole tilassa `maintenance`.
  Aja sitten `preflight_0010.sql` → 0 FAIL ja `compare.sql` → SAMA.
- Palauta (§8) vain, jos `compare` näyttää **MUUTTUNUT**.

### C. Aalto G deployattu, sitten sovellusvirhe

1. **Ensin** `supabase/backup/snapshot_state_0010.sql` → vie →
   `check --save`. Tämä on nykytilan kuva: välitavoitteet, mittarit,
   riippuvuudet ja `maintenance`-tilat.
2. Kirjaa `maintenance`-tavoitteet: `verify_0010.sql`:n rivi 44 (lukumäärä)
   ja tunnisteet: `select id from public.goals where status = 'maintenance' order by id;`
3. Palaa aaltoon F: `docs/acceptance/WAVE-G.md` §6.

   **Varoitus (BK-03):** aallon F koodi ei tunne tilaa `maintenance`. Kun
   F:ssä muokataan tavoitetta, joka on tilassa `maintenance`, F kirjoittaa
   sen tilaksi `active` — hiljaa. (Todettu lukemalla aallon F haaran
   rehearsal/wave-f-v3 koodia: normalizeGoal korvaa tuntemattoman tilan
   arvolla active, ja tallennus lähettää koko rivin. Ei ajettu.)
   Revertin jälkeen **älä muokkaa niitä tavoitteita**. Jos niin kävi, palauta tila aallon G palattua
   0010:n jälkeisestä kuvasta vain `goals`-taulusta:
   `restore <vienti> --tables=goals --dry-run`, sitten ilman `--dry-run`.
   Huom.: tämä palauttaa **koko** `goals`-taulun kuvan hetkeen — kuvan
   jälkeiset muokkaukset tavoitteisiin katoavat (muut taulut eivät muutu;
   todennettu B11).
4. Jos vanhaa dataa on vahingoittunut, valitse kuva:
   - 0010:tä edeltävä (`snapshot_state_0009`) kadottaa kaikki myöhemmät
     muokkaukset niihin riveihin;
   - 0010:n jälkeinen vain, jos se otettiin **ennen** vahinkoa.

   Sitten §8: kuivaharjoitus, palautus.
5. Vain jos skeema on pakko poistaa: päätä ensin `maintenance`-tavoitteiden
   tila (`update public.goals set status='active' where status='maintenance';`)
   ja aja sitten ROLLBACK-osio. Kohdan 1 kuva säilyttää välitavoitteet ja
   mittaridatan: ne voi palauttaa, kun 0010 ajetaan uudelleen (todennettu
   B11: kuva → ROLLBACK → 0010 uudelleen → palautus identtinen).

### D. Data vahingoittunut, syystä riippumatta

1. Pysäytä kirjoitukset: sulje sovellus; jos vika on yhä tuotannossa,
   peruuta deploy.
2. Ota vahingoittuneesta tilasta tilannekuva (`snapshot_state_00NN.sql`
   nykyiselle tilalle) → `check --save`. Se on sekä selvitysaineisto että
   paluutie, jos palautus osoittautuu vääräksi.
3. `compare` hyvästä kuvasta → näet, mitkä taulut ja tunnisteet
   muuttuivat.
4. Palautus (§8). Oletus: **ei karsintaa** — kuvan jälkeen luodut rivit
   säilyvät. `--prune` vain, jos myös ne on poistettava.
5. `compare` uudelleen → **SAMA** tai **SAMA+N UUTTA**.
6. 0010:n skeemassa: `supabase/verify/verify_0010.sql` → 0.

### E. Omistajan tili poistettu tai auth-vahinko

Looginen palautus **kieltäytyy tarkoituksella** (todennettu B12: omistaja
tai kuvan käyttäjä puuttuu → hylätään). Vain Supabasen oma palautus
(PITR tai päivittäinen varmuuskopio, L2) voi auttaa. **Ei harjoiteltu;**
päätetään tapauskohtaisesti.

### 0010:n ROLLBACK-osio (sellaisenaan migraatiotiedoston lopusta)

Aja vain kohdissa B2 ja C5 — ei koskaan refleksinä.

```sql
begin;
set local lock_timeout = '5s';

alter table public.tasks drop constraint tasks_milestone_fkey;
alter table public.projects drop constraint projects_milestone_fkey;
drop table public.milestones;

alter table public.tasks drop constraint tasks_depends_on_length_check;
alter table public.tasks drop constraint tasks_depends_on_no_self_check;
alter table public.tasks drop column milestone_id;
alter table public.tasks drop column depends_on;
alter table public.projects drop column milestone_id;

alter table public.goals drop constraint goals_metric_pair_check;
alter table public.goals drop constraint goals_savings_exclusive_check;
alter table public.goals drop constraint goals_metric_length_check;
alter table public.goals drop constraint goals_unit_length_check;
alter table public.goals drop column metric;
alter table public.goals drop column unit;
alter table public.goals drop column baseline_value;
alter table public.goals drop column current_value;
alter table public.goals drop column target_value;
alter table public.goals drop column measured_on;
alter table public.goals drop column savings_goal_id;

-- TILARAJOITE PALAUTETAAN. Tama EPAONNISTUU, jos yksikin tavoite on
-- ehtinyt tilaan 'maintenance'. Se on tarkoitus: peruutus ei saa
-- hiljaa hylata kayttajan tekemaa valintaa.
--
-- Jos nain kay, paata ensin mihin tilaan ne rivit siirretaan:
--   update public.goals set status='active' where status='maintenance';
alter table public.goals drop constraint goals_status_check;
alter table public.goals
  add constraint goals_status_check
  check (status in ('active','paused','completed','abandoned','archived'));

alter table public.profile drop constraint profile_automation_level_check;
alter table public.profile drop constraint profile_buffer_ratio_check;
alter table public.profile drop column automation_level;
alter table public.profile drop column planning_buffer_ratio;

commit;
```

Peruutus **poistaa `milestones`-taulun rivit ja uusien sarakkeiden
datan pysyvästi.** Ota siksi ennen sitä `snapshot_state_0010.sql`.
Paikallisesti todennettu: ROLLBACK kieltäytyy (23514,
`goals_status_check`), kun jokin tavoite on tilassa `maintenance`, eikä
muuta mitään; ROLLBACK + palautus (`--prune`) tuottaa täsmälleen 0010:tä
edeltäneen katalogin ja datan (B9).

---

## §8 Palautuksen ajaminen

Järjestys: **generoi → kuivaharjoitus → palautus → compare → verify → F5.**

```sh
# 1. generoi (paikallisesti; kirjoittaa vain .local-backups/-hakemistoon)
node tools/activation/restore-snapshot.mjs restore .local-backups/db/<UTC>_state_0009/vienti.csv --dry-run
node tools/activation/restore-snapshot.mjs restore .local-backups/db/<UTC>_state_0009/vienti.csv
node tools/activation/restore-snapshot.mjs compare .local-backups/db/<UTC>_state_0009/vienti.csv
# valinnat: --prune (poista myös kuvan jälkeen luodut rivit), --tables=goals,projects
```

2. **Kuivaharjoitus:** aja `restore.dry-run.sql` kokonaan uudessa
   välilehdessä, sovellus suljettuna. Ei ERROR-riviä = palautus toimisi.
   Se päättyy `rollback;`iin: mitään ei tallennu.
3. **Palautus:** aja `restore.sql` kokonaan uudessa välilehdessä.
   Skripti on yksi transaktio, joka tarkistaa itsensä: se päättyy
   `commit;`iin vain, jos jokainen kuvan rivi on lopuksi tavu tavulta sama
   (`updated_at` mukaan lukien). Muuten ERROR ja **mitään ei tallennettu**.
4. **compare.sql** → SAMA tai SAMA+N UUTTA.
5. Tilan verify (esim. `supabase/verify/verify_0010.sql`) → 0.
6. Avaa sovellus ja lataa sivu (F5).

Mitä palautus tekee: suojat (alla) → kuva väliaikaisiin tauluihin
nykyisen skeeman muotoisina → `disable trigger user` (muuten
`touch_updated_at` ylikirjoittaisi `updated_at`:n) → [karsinta] → vaihe 1:
rivit viittausjärjestyksessä ilman nullable-viittauksia → vaihe 2:
nullable-viittaukset (`goals` ↔ `projects` -kehä) → lopputarkistus →
`enable trigger user` → `commit;`. Myöhemmin lisätyt sarakkeet (esim.
`depends_on`) saavat nykyisen tai oletusarvonsa.

| Virheilmoitus | Syy | Toimi |
|---|---|---|
| `VÄÄRÄ PROJEKTI TAI OMISTAJA POISTETTU` | omistajaa ei ole `auth.users`-taulussa | pysähdy; §7 E |
| `Tilannekuvan N käyttäjää puuttuu` | kuvan käyttäjä poistettu | pysähdy; §7 E |
| `VÄÄRÄ KANTA` | eri kanta kuin kuvassa | tarkista projekti |
| `Skeema ei vastaa tilannekuvaa` | sarake puuttuu tai on eri tyyppiä (esim. 0010:n jälkeinen kuva ROLLBACKin jälkeen) | aja ensin kuvan tilan migraatio tai käytä tilan mukaista kuvaa |
| `Liipaisimet eivät vastaa tilannekuvaa` | liipaisin lisätty, puuttuu tai pois päältä | selvitä ennen palautusta |
| `ei omista tauluja` / `FORCE ROW LEVEL SECURITY` | rooli ei ole taulujen omistaja / FORCE RLS ilman BYPASSRLS:ää | aja `postgres`-roolilla |
| `PALAUTUS EI TÄSMÄÄ` | lopputulos ei vastaa kuvaa (esim. muokattu skripti) | älä muokkaa skriptiä; generoi uudelleen |
| `duplicate key value` (23505) | kuvan jälkeen luotu rivi varaa kuvan rivin uniikkiavaimen | `--prune`-versio (kuivaharjoitus ensin) |
| `lock timeout` / `canceling statement` | sovellus piti lukkoa | sulje sovellus, aja uudelleen |

Jokainen näistä on transaktion sisällä: ERROR = mitään ei muuttunut.
Aja samassa välilehdessä `rollback;`.

---

## §9 Mitä EI tehdä

- **Älä aja ROLLBACK-osiota refleksinä.** Se poistaa dataa ja kaatuu,
  jos jokin tavoite on tilassa `maintenance`.
- **Älä käytä Supabasen koko projektin palautusta** rivitason vahinkoon
  tai virheeseen "column does not exist" (se on PostgRESTin
  skeemavälimuisti: Settings → API → Reload schema cache).
- Älä aja migraatiotiedostosta **valintaa** — aina koko tiedosto.
- Älä jätä välilehteä avoimeen transaktioon (virheen jälkeen `rollback;`).
- Älä liitä tilannekuvaa tai palautusskriptiä minnekään (henkilötietoja).
- Älä muokkaa tilannekuvaa tai palautusskriptiä: tiiviste hylkää sen.
- Älä käytä `--prune`-valintaa kevyesti: se poistaa kuvan jälkeen luodut
  rivit (ja niiden vierasavaimien mukaiset riippuvat rivit muista
  tauluista).
- Älä palauta sovelluksen ollessa auki.
- Älä palaa aallosta G aaltoon F tekemättä ensin §7 C:n kohtia 1 ja 2.

---

## §10 Todennettu paikallisesti / Vain tuotannossa todennettavissa

### Todennettu paikallisesti

`node tools/pg-rehearsal/rehearse-backup.mjs` (PostgreSQL 17.10, oma
kertakäyttöinen klusteri 127.0.0.1): jokaiselle N = 0009…0013 ja
molemmille lähtötiloille (`text`, `typed`), P = N−1. **231/231 PASS.**

| # | Mitä | PASS |
|---|---|---|
| B1 | `snapshot_state_P.sql` yksi lause READ ONLY -transaktiossa, katalogi ennallaan | 10/10 |
| B2 | jäsennys; CSV = sarkain = JSON tavu tavulta | 10/10 |
| B3 | preflight_N + N + verify_N; vanhat sarakkeet tavu tavulta ennallaan | 10/10 |
| B4 | vahinko (massapäivitys, poistot kaskadeineen, numeric, uusi rivi) näkyy MUUTTUNUT | 10/10 |
| B5 | palautus eri aikavyöhykkeessä; identtinen ml. `updated_at`; uusi rivi säilyy; verify 0 FAIL; compare väärässä vyöhykkeessä = EI VERTAILTAVISSA | 20/20 |
| B6 | idempotentti | 10/10 |
| B7 | uniikkitörmäys ilman karsintaa kaatuu kiinni (23505); `--prune` → kaikki SAMA, liipaisimet päällä | 20/20 |
| B8 | peukaloitu skripti kaatuu; kontrollit: JS-sarjallistus (82.40 → 82.4) ja palautus ilman `disable trigger user` kaatuvat | 30/30 |
| B9 | ROLLBACK(N) + palautus → katalogi == ennen N:ää ja data sama; 0010:n ROLLBACK kieltäytyy `maintenance`-tilassa | 12/12 |
| B10 | N:n jälkeinen kuva peruutettuun skeemaan hylätään, mitään ei muutu | 10/10 |
| B11 | N:n jälkeinen kuva → ROLLBACK → N uudelleen → palautus identtinen; 0010: `maintenance`, mittari, välitavoitteet, `depends_on`; haara C `--tables=goals` | 14/14 |
| B12 | väärä kanta, puuttuva käyttäjä, puuttuva omistaja, väärä saraketyyppi hylätään | 35/35 |
| B13 | ei-superuser (NOBYPASSRLS) taulujen omistajana onnistuu; FORCE RLS ja ei-omistaja kaatuvat kiinni | 30/30 |
| B14 | kuivaharjoitus: onnistuu, päättyy `rollback;`iin, katalogi ja sisältö ennallaan | 10/10 |

Yksikkötestit ilman kantaa: `tests/activation-backup.test.mjs` ja
`tests/activation-backup-docs.test.mjs`.

### Vain tuotannossa todennettavissa

- **SQL-editorin viennin tarkkuus suurelle tekstisolulle.** Taulun
  payload on yksi solu (kymmeniä kilotavuja). Säilyttääkö CSV- tai
  JSON-vienti sen tavu tavulta? Tiiviste havaitsee muutoksen; todistus
  vaatii T-2-kuivaharjoituksen (§4).
- **`postgres`-roolin oikeudet.** Omistaako `postgres` public-taulut, voiko
  se ajaa `alter table … disable trigger user`, luoda väliaikaisia tauluja
  ja lukea `auth.users`-taulua? Manifesti kirjaa roolin, BYPASSRLS:n,
  taulujen omistajan ja FORCE RLS:n vain lukien; täysi todistus vaatii
  kuivaharjoituksen (§4). Paikallisesti todennettu ei-superuserilla,
  joka omistaa taulut (B13).
- **Monilauseinen skripti editorissa:** noudattaako editori
  `begin … commit/rollback`-rajoja ja pitkää yksirivistä payloadia?
  Epäsuora näyttö: 0001 ajettiin ja käytti `lock table` -lausetta, joka
  toimii vain transaktiolohkossa.
- **Istunnon aikavyöhyke** editorissa (manifesti kirjaa sen; palautus
  asettaa saman; `compare` sanoo EI VERTAILTAVISSA, jos se eroaa).
- **Supabasen suunnitelma, varmuuskopiot ja PITR** (L2): onko
  palautettavia varmuuskopioita, voiko niitä ottaa pyynnöstä (oletus: ei),
  onko PITR päällä. Oletukset, joita ei ole todennettu: ilmaisessa
  suunnitelmassa ei ole palautettavia varmuuskopioita; PITR on maksullinen
  lisä; natiivi palautus kelaa koko projektin, myös `auth`-skeeman.
- **Tallennuspaikka:** synkronoiko jokin työpöytäkansion pilveen.

---

## §11 Viitteet

- `supabase/migrations/0010_goal_to_action.sql` — migraatio ja ROLLBACK-osio
- `supabase/preflight/preflight_0010.sql` — esitarkistus (rivit 09, 11–14, 18)
- `supabase/verify/verify_0010.sql` — todennus (rivit 20–22, 44)
- `supabase/backup/snapshot_state_0009.sql` — kuva ennen 0010:tä
- `supabase/backup/snapshot_state_0010.sql` — kuva 0010:n jälkeen
- `tools/activation/build-snapshots.mjs` — tilannekuvien generaattori
- `tools/activation/snapshot-core.mjs` — jäsennys, palautus, vertailu
- `tools/activation/restore-snapshot.mjs` — `check` / `compare` / `restore`
- `tools/pg-rehearsal/backup-scenario.mjs`, `tools/pg-rehearsal/rehearse-backup.mjs` — harjoittelu B1–B14
- `tests/activation-backup.test.mjs`, `tests/activation-backup-docs.test.mjs`
- `docs/acceptance/WAVE-G.md` — aalto G ja sen peruutus (§6)
- `docs/activation/MIGRATION-BUNDLES.md` — migraatiopaketit 0009–0013
- `docs/MIGRATION-0004-RECOVERY.md` — CASE B2 (kesken-tila)
- `docs/PRODUCTION-STATUS.md` — tuotannon tila
