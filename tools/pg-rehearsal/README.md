# Migraatioharjoittelu oikealla PostgreSQL:llä

**EI TUOTANTOA.** Kaikki tässä hakemistossa ajetaan paikalliseen,
kertakäyttöiseen PostgreSQL 17 -klusteriin osoitteessa `127.0.0.1`.
`lib.mjs` kieltäytyy muista osoitteista, ja jokainen kanta on nimeltään
`mv_rehearsal_*` ja poistetaan ajon lopuksi.

**Oma klusteri, ei mikä tahansa palvelin.** Silmukkaosoite ei riitä:
2026-09-26 portissa 54329 vastasi toisen projektin PostgreSQL 15.
Jokainen yhteys tarkistaa ensin (`lib.assertRehearsalServer`), että
palvelin on vähintään PostgreSQL 17 ja sen `data_directory` on projektin
omassa `.claude/pg-local/`-hakemistossa (myös worktreestä ajettaessa:
pääkansion `.claude/pg-local`). Ohitus vain tarkoituksella:
`PG_REHEARSAL_ALLOW_FOREIGN=1`. Oletusportti on **54349**. Pelkkä
moduulien importti ei avaa yhteyttä eikä aja skenaarioita.

## Mitä tämä todistaa

`rehearse.mjs` ajaa migraatiot **0001 → 0013 järjestyksessä** tuotannon
muotoisesta lähtötilasta (ennen 0001:tä: `tasks` 36 riviä ilman
`user_id`:tä, `profile` yksi rivi `id = 'me'`, "salli kaikki" -politiikat)
ja jokaisen jälkeen sen oman `supabase/verify/verify_XXXX.sql`:n.

| Skenaario | Sisältö |
|---|---|
| `upgrade:text` / `upgrade:typed` | Ketju kahdella lähtötilalla: `tasks.date/time` tekstinä tai omina tyyppeinään. Sovellusdata siemennetään kahdelle käyttäjälle **roolina `authenticated`** heti kunkin taulun synnyttyä. 0003:sta alkaen jokaisen migraation ympärillä: jokaisen vanhan rivin arvot vanhoissa sarakkeissa (md5), rivin `xmin` (ei UPDATEa) ja taulun `relfilenode` (ei uudelleenkirjoitusta) täsmälleen ennallaan; alkuperäiset 36 tehtävää säilyvät; 0012 ei liitä yhtään tavoitetta alueeseen. |
| `rls` | Jokaiselle 26 taululle: A ei voi lukea, päivittää, poistaa, lisätä B:n nimissä, siirtää omaa riviään B:lle eikä viitata B:n riviin yhdistelmävierasavaimella; `anon` ei pääse mihinkään; `authenticated` ilman `sub`-väitettä ei näe mitään; PUBLIC/anon-oikeuksia ei ole. |
| `lifecycle` | Poistosäännöt, yksi ajastin per käyttäjä, `operation_id`-idempotenssi, rajat ja tilin poiston cascade kaikkiin tauluihin; vanhojen aaltojen käsin kirjoitetut rivimuodot 0013:n jälkeen. |
| `preflight` | Jokainen `preflight_0009…0013.sql` jokaisessa tilassa 0007–0013: PASS vain juuri ennen omaa migraatiotaan (35 tapausta). |
| `inventory` | `activation_readonly_inventory.sql` jokaisessa junan tilassa READ ONLY -transaktiossa + `score-inventory.mjs`:n päätös. `--fixtures=DIR` kirjoittaa tulokset yksikkötesteille. |
| `rollback` | Jokaiselle 0009–0013: ajo → oma ROLLBACK-osio → **katalogirivit** (`lib.catalogItems`) täsmälleen samat → ajo uudelleen. |
| `failure` | Uudelleenajo ("JO AJETTU"), puuttuva esiehto, osittainen tila, lukon aikakatkaisu, myöhäinen esiehto — katalogi ennallaan jokaisen epäonnistumisen jälkeen. |
| `prodshape:fixture` | Tuotannon tila 0008 (`prodshape.mjs`) = omistajan inventaario 2026-09-26 (`expected/production-inventory-0008.json`): omistajan antamat rivit verrataan, johdetut merkitty `derived`, antamattomat `absent`. 5 tavoitteen tilaa × projekti kytketty/irti. |
| `values:0010` | 0010 tuotannon muotoiseen kantaan (10 muunnelmaa): yksikään vanha arvo ei muutu, yhtään riviä ei kirjoiteta uudelleen (`xmin`), yhtään taulua ei kirjoiteta uudelleen (`relfilenode`); uudet sarakkeet vanhoilla riveillä: `depends_on = '{}'`, muut null, `automation_level = 1`, `planning_buffer_ratio = 0.25`. |
| `prodshape:chain` | 0009–0013 tuotannon datalla: tiivisteet jokaisen migraation ympärillä + skeemaero = kultainen tiedosto `expected/schema-diff-00NN.txt`; poistoja vain sallitut (`ALLOWED_REMOVALS`: 0010 goals_status_check, 0013 time_entries_source_check). |
| `prodshape:pause` | Junan taukopisteet (`waves.mjs`): elävän ja seuraavan aallon kirjoitukset sovelluksen **omilla rivimuunnoksilla** (`repo.mapping.toRow`, `rows.js toRow`, `profileToRow`, `preferencesToRow`) aallon sarakeporteilla PostgREST-muodossa (insert/update/upsert/delete roolina authenticated), verify uudelleen, seuraava preflight, peruutuksen kuiva-ajo (estääkö data peruutuksen). |
| `failure:0010-locks` | Estäjämatriisi goals/tasks/projects/profile/auth.users × ACCESS SHARE / ROW EXCLUSIVE (+ 0009 bills, 0011 tasks): odotus 4,5–7 s, katalogi, rivit ja tilarajoite ennallaan, ei jääneitä lukkoja, uudelleenajo läpi. Myöhäinen virhe tilarajoitteen vaihdon jälkeen (event trigger skeemassa `rehearsal_inject`), sovelluksen jumin mittaus, lukkiutuminen (40P01), keskeytynyt istunto. Vertailu 0010:aan ennen lukitusjärjestystä (git). |
| `verify:null` | Rikottu objekti → NULL-tulos on FAIL ja lasketaan `poikkeavia_yhteensa`-lukuun. |
| `preflight:blockers` | Uusi esteet-rivi (lukitut taulut, `pg_locks`) ja politiikkamäärärivit havaitsevat esteen ennen migraatiota. |
| `rollback:data` | 0010 (ylläpitotila → selkeä kieltäytyminen, korjauksen jälkeen läpi), 0012 (liitetty tavoite + kirjattu aika), 0013 (minuutit säilyvät, kohdistuksen menetys ennakkokyselystä) — vanhat rivit ja katalogi täsmälleen ennallaan. |
| `rollback:reverse-chain` | 0008 → 0013 datan kanssa → peruutukset 0013…0009 → katalogi = tuotannon 0008; 0012 ennen 0013:a kaatuu vartijaan. |
| `role:nonsuper` | Migraatiot NOSUPERUSER-omistajaroolina; preflightin esteet-rivit `pg_read_all_stats`-oikeuden kanssa ja ilman. |
| `backup` (vain `--only=backup`) | Looginen tilannekuva ja palautus B1–B15 (`backup-scenario.mjs`, ks. `docs/activation/0010-BACKUP-AND-RECOVERY.md` §10) jokaiselle 0009–0013 molemmilla lähtötiloilla; B15: RLS:n suodattama kuva hylätään. Ei kuulu oletusajoon. Sama ajo erikseen: `rehearse-backup.mjs`. |

## Mitä tämä EI todista (tunnetut erot Supabaseen)

- **PostgREST-kerros** (HTTP, JSON, `Prefer`-otsakkeet) ei ole mukana.
  Kirjoitukset jäljitellään PostgREST 12:n SQL-muodolla samassa
  roolissa (`set local role authenticated` + `request.jwt.claims`),
  mutta ei HTTP:n kautta.
- **Roolit.** Supabasen `postgres`-rooli ei ole superuser, ja sen
  tarkat jäsenyydet (esim. `pg_read_all_stats`) ja omistukset ovat
  tuotannon asia. `role:nonsuper` jäljittelee NOSUPERUSER-omistajaa,
  ei Supabasen roolia sellaisenaan.
- **SQL-editori.** Editorin tapa ajaa monilauseinen tiedosto,
  näyttää tulokset ja pitää istuntoa auki virheen jälkeen ei ole mukana
  (harjoittelu: yksi simple-query-kutsu, kuten editori).
- **Versio.** Paikallinen palvelin on PostgreSQL 17.10, tuotanto 17.6.
  Tuotannon versio luetaan `supabase/acceptance/activation_readonly_inventory.sql`:llä.
- **GoTrue** (kirjautuminen, tokenien voimassaolo) ei ole mukana.

## Käyttöönotto (kerran, paikallisesti, ei asennusta)

PostgreSQL-binäärit ja `pg`-ajuri pidetään projektin ignoroidussa
hakemistossa `.claude/pg-local/` — ei globaalia asennusta, ei palvelua,
poistettavissa poistamalla hakemisto.

```sh
mkdir -p .claude/pg-local && cd .claude/pg-local
npm pack @embedded-postgres/windows-x64@17.10.0-beta.17   # PostgreSQL 17.10 -binäärit
tar -xzf embedded-postgres-windows-x64-17.10.0-beta.17.tgz
package/native/bin/initdb.exe -D "$PWD/data-rehearsal" -U postgres --auth=trust --encoding=UTF8 --locale=C
echo '{"name":"pg-local-harness","private":true}' > package.json && npm install pg@8
```

Käynnistys (PowerShell), vain silmukkaosoitteeseen. Tarkista ensin, ettei
portti ole muun prosessin käytössä (`Get-NetTCPConnection -LocalPort 54349`):

```powershell
$b = ".claude\pg-local"
& "$b\package\native\bin\pg_ctl.exe" -D "$b\data-rehearsal" -l "$b\pg-rehearsal.log" -o "-p 54349 -c listen_addresses=127.0.0.1" -w start
```

Pysäytys: sama komento `stop`-sanalla. Poisto: poista `.claude/pg-local`.

## Ajo

```sh
node tools/pg-rehearsal/rehearse.mjs                    # kaikki 18 skenaariota (~6 min)
node tools/pg-rehearsal/rehearse.mjs --only=failure     # failure + failure:0010-locks
node tools/pg-rehearsal/rehearse.mjs --only=prodshape   # tuotannon muotoiset
node tools/pg-rehearsal/rehearse.mjs --only=prodshape:chain --write-golden   # päivitä kultaiset skeemaerot
node tools/pg-rehearsal/rehearse.mjs --only=inventory --fixtures=tests/fixtures/activation-inventory
node tools/pg-rehearsal/rehearse.mjs --json=raportti.json
node tools/pg-rehearsal/chain.mjs text                  # pelkkä ketju + verify
node tools/pg-rehearsal/bundle-hashes.mjs               # MIGRATION-BUNDLES.md:n blob-taulukko
```

### Varmuuskopioharjoittelu (`backup`)

Ei kuulu oletusajoon. Kaksi samanarvoista tapaa (PowerShellissä
`$env:PG_REHEARSAL_PORT = '54349'`):

```sh
PG_REHEARSAL_PORT=54349 node tools/pg-rehearsal/rehearse.mjs --only=backup
PG_REHEARSAL_PORT=54349 node tools/pg-rehearsal/rehearse.mjs --only=backup --backup-fixtures=tests/fixtures/backup
PG_REHEARSAL_PORT=54349 node tools/pg-rehearsal/rehearse-backup.mjs --fixtures=tests/fixtures/backup [--numbers=0010] [--variants=text]
```

Yksikkötestien aineisto (`state-0009.json`) menee **omaan hakemistoonsa**
`tests/fixtures/backup` — `--fixtures` on inventaarion aineistolle
(`tests/fixtures/activation-inventory`), `--backup-fixtures` tälle.

Ennen yhtäkään kantaa tai roolia ajetaan tiukka vahti
(`lib.guardBackupRehearsal`), jolla ei ole ohitusta:

1. `PG_REHEARSAL_PORT` on annettu **nimenomaisesti** eikä se ole `54329`
   (toisen projektin PostgreSQL 15) — tarkistetaan ennen yhteyttä;
   `connect()` kieltäytyy portista 54329 aina;
2. palvelin on PostgreSQL 17 (`server_version_num >= 170000`) ja kertoo
   portikseen saman kuin pyydettiin;
3. `data_directory` on projektin **pääkansion** `.claude/pg-local/`-hakemistossa
   (`git rev-parse --git-common-dir`, myös worktreestä ajettaessa);
   `PG_REHEARSAL_ALLOW_FOREIGN` ja `PG_REHEARSAL_PGLOCAL` eivät koske sitä.

Muuten ajo keskeytyy (`KESKEYTYS`), eikä mitään luoda. Vahti on
yksikkötestattu ilman palvelinta: `tests/pg-rehearsal-backup-guard.test.mjs`.

Poistumiskoodi on 0 vain, jos yksikään tarkistus ei hylätty. Raportti
(`--json`) sisältää alkuperätiedon: git HEAD, palvelimen versio ja
data-hakemisto sekä jokaisen luetun SQL-tiedoston git-blob-tiivisteen.

## Tiedostot

| Tiedosto | Sisältö |
|---|---|
| `lib.mjs` | yhteys + palvelinvahti, `catalogItems`/`diffCatalog`, `rowDigests`/`compareDigests`, PostgREST-jäljitelmä, `extractRollback`, alkuperätieto |
| `chain.mjs`, `baseline.mjs`, `seeds.mjs` | ketju, lähtötila ennen 0001:tä, kahden käyttäjän siemenet |
| `prodshape.mjs` | tuotannon tila 0008 mallikantana, kloonit, inventaarion vertailu, todisteet migraation ympärillä |
| `waves.mjs`, `app-gate-hooks.mjs` | junan taukopisteet ja sovelluksen rivimuunnokset aallon sarakeporteilla |
| `*-scenarios.mjs` | uudet skenaariot (tuotannon muoto, virheet ja lukot, peruutukset) |
| `backup-scenario.mjs`, `rehearse-backup.mjs` | looginen tilannekuva ja palautus B1–B15 (`--only=backup` tai erillinen ajo) |
| `expected/` | omistajan inventaario 0008 ja kultaiset skeemaerot 0009–0013 |

## Löydökset, jotka tämä on jo tehnyt

1. `verify_0011.sql` tarkistus 12 antoi ehjälle kannalle FAIL-tuloksen:
   säännöllinen lauseke `(lat|lon|…)` osui sarakkeeseen
   `reminders.escalate`. Korjattu; `tests/verify-false-positives.test.mjs`.
2. 0010:n uudelleenajon tunnistusluku oli 41 (oikea 38) ja 0011:n 63
   (oikea 72): täysin ajetun migraation uudelleenajo ilmoitti "kesken".
   Korjattu; `tests/migration-rerun-detection.test.mjs`.
3. 0012:n uudelleenajo 0013:n jälkeen ilmoitti "kesken 57/58", koska 0013
   korvaa yhden 0012:n rajoitteen. Korjattu omalla haaralla.
4. Vanha 16-lauseinen inventaario kaatui kokonaan (`date_trunc(text)`),
   jos `tasks.date` on tekstiä. Korjattu; yksilauseinen
   `activation_readonly_inventory.sql` korvaa sen.
5. `verify_0009…0013`: NULL-tulos (puuttuva objekti) näkyi FAIL-rivinä
   mutta ei `poikkeavia_yhteensa`-luvussa (esim. 2 vs. 3 FAIL-riviä).
   Korjattu (`is distinct from`, `coalesce`); `verify:null`.
6. 0010 muutti goals-, tasks- ja projects-tauluja (42 DDL-komentoa)
   ennen kuin jäi odottamaan profile-lukkoa. Nyt kaikki neljä lukitaan
   ensin kiinteässä järjestyksessä: 0 DDL-komentoa ennen lukon
   aikakatkaisua (`failure:0010-locks`).
7. Ilman `pg_read_all_stats`-oikeutta preflightin idle in transaction
   -rivi ei näe muiden roolien istuntoja (väärä PASS). Uusi esteet-rivi
   lukee `pg_locks`-näkymää ja näkee estäjän aina (`role:nonsuper`).
