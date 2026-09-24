# Migraatioharjoittelu oikealla PostgreSQL:llä

**EI TUOTANTOA.** Kaikki tässä hakemistossa ajetaan paikalliseen,
kertakäyttöiseen PostgreSQL-palvelimeen osoitteessa `127.0.0.1`.
`lib.mjs` kieltäytyy muista osoitteista, ja jokainen kanta on nimeltään
`mv_rehearsal_*` ja poistetaan ajon lopuksi.

## Mitä tämä todistaa

`rehearse.mjs` ajaa migraatiot **0001 → 0013 järjestyksessä** tuotannon
muotoisesta lähtötilasta (ennen 0001:tä: `tasks` 36 riviä ilman
`user_id`:tä, `profile` yksi rivi `id = 'me'`, "salli kaikki" -politiikat)
ja jokaisen jälkeen sen oman `supabase/verify/verify_XXXX.sql`:n.

| Skenaario | Sisältö |
|---|---|
| `upgrade:text` / `upgrade:typed` | Ketju kahdella lähtötilalla: `tasks.date/time` tekstinä tai omina tyyppeinään (tuotannon tyyppiä ei ole todennettu, `docs/SCHEMA.md`). Sovellusdata siemennetään kahdelle käyttäjälle **roolina `authenticated`** heti kunkin taulun synnyttyä, joten myöhemmät migraatiot ajetaan olemassa olevaa dataa vasten. Todennetaan, ettei yksikään migraatio muuta vanhojen taulujen rivimääriä, alkuperäiset 36 tehtävää säilyvät ja 0012 ei liitä yhtään tavoitetta alueeseen. |
| `rls` | Jokaiselle 26 taululle: A ei voi lukea, päivittää, poistaa, lisätä B:n nimissä, siirtää omaa riviään B:lle eikä viitata B:n riviin yhdistelmävierasavaimella; `anon` ei pääse mihinkään; `authenticated` ilman `sub`-väitettä ei näe mitään; PUBLIC/anon-oikeuksia ei ole. |
| `lifecycle` | Poistosäännöt (tavoite, alue, tehtävä), yksi ajastin per käyttäjä, `operation_id`-idempotenssi, rajat (0 min, > 1440 min, maanantai, nimen pituus, ajastimen loppu ennen alkua) ja tilin poiston cascade kaikkiin tauluihin. Lisäksi taaksepäin yhteensopivuus: vanhojen aaltojen rivimuodot (ilman myöhempien migraatioiden sarakkeita) ovat yhä kirjoitettavissa 0013:n jälkeen — migraatio ajetaan aina edellisen aallon koodin ollessa tuotannossa. |
| `preflight` | Jokainen `supabase/preflight/preflight_0009…0013.sql` jokaisessa tilassa 0007–0013: PASS vain juuri ennen omaa migraatiotaan (35 tapausta). Upgrade-ketjussa 0009+ esitarkistuksen FAIL on hylkäys. |
| `inventory` | `activation_readonly_inventory.sql` jokaisessa junan tilassa molemmilla lähtötiloilla READ ONLY -transaktiossa + `score-inventory.mjs`:n päätös (GO/STOP, seuraava migraatio), keskeneräinen 0012 ja puuttuva omistaja -> STOP. `--fixtures=DIR` kirjoittaa tulokset yksikkötesteille. |
| `failure` | Uudelleenajo heti ja koko ketjun jälkeen (viestin on oltava "JO AJETTU"), puuttuva esiehto, osittainen tila (yksi objekti etukäteen), lukon aikakatkaisu avoimen transaktion takia (5 s) ja uudelleenajo lukon vapauduttua, myöhäinen esiehto. Jokaisessa todennetaan katalogin sormenjäljellä, ettei epäonnistunut ajo jättänyt **mitään** jälkeä. |

## Mitä tämä EI todista (tunnetut erot Supabaseen)

- **PostgREST-kerros** (HTTP, JSON, `Prefer`-otsakkeet) ei ole mukana.
  RLS todennetaan samalla mekanismilla, jota PostgREST käyttää
  (`set local role authenticated` + `request.jwt.claims`), mutta ei
  HTTP:n kautta.
- **Roolit.** Migraatiot ajetaan täällä superuserina. Supabasen
  `postgres`-rooli ei ole superuser. Migraatiot eivät tarvitse
  superuser-oikeuksia (ne luovat tauluja, politiikkoja ja oikeuksia omiin
  tauluihinsa), mutta ero on olemassa.
- **Versio.** Paikallinen palvelin on PostgreSQL 17. Tuotannon versio
  luetaan `supabase/acceptance/life_alignment_readonly_inventory.sql`:llä.
  Migraatiot vaativat vähintään 15:n ja tarkistavat sen itse.
- **GoTrue** (kirjautuminen, tokenien voimassaolo) ei ole mukana.
- **Samanaikaisuus** todennetaan vain lukon aikakatkaisun osalta.

## Käyttöönotto (kerran, paikallisesti, ei asennusta)

PostgreSQL-binäärit ja `pg`-ajuri pidetään projektin ignoroidussa
hakemistossa `.claude/pg-local/` — ei globaalia asennusta, ei palvelua,
poistettavissa poistamalla hakemisto.

```sh
mkdir -p .claude/pg-local && cd .claude/pg-local
npm pack @embedded-postgres/windows-x64@17.10.0-beta.17   # PostgreSQL 17.10 -binäärit
tar -xzf embedded-postgres-windows-x64-17.10.0-beta.17.tgz
package/native/bin/initdb.exe -D "$PWD/data" -U postgres --auth=trust --encoding=UTF8 --locale=C
echo '{"name":"pg-local-harness","private":true}' > package.json && npm install pg@8
```

Käynnistys (PowerShell), vain silmukkaosoitteeseen:

```powershell
$b = ".claude\pg-local"
& "$b\package\native\bin\pg_ctl.exe" -D "$b\data" -l "$b\pg.log" -o "-p 54329 -c listen_addresses=127.0.0.1" -w start
```

Pysäytys: sama komento `stop`-sanalla. Poisto: poista `.claude/pg-local`.

## Ajo

```sh
node tools/pg-rehearsal/rehearse.mjs                    # kaikki skenaariot (~1 min)
node tools/pg-rehearsal/rehearse.mjs --only=failure     # vain virhetilanteet
node tools/pg-rehearsal/rehearse.mjs --only=inventory --fixtures=tests/fixtures/activation-inventory
node tools/pg-rehearsal/rehearse.mjs --json=raportti.json
node tools/pg-rehearsal/chain.mjs text                  # pelkkä ketju + verify
```

Poistumiskoodi on 0 vain, jos yksikään tarkistus ei hylätty.

## Löydökset, jotka tämä on jo tehnyt

1. `verify_0011.sql` tarkistus 12 antoi ehjälle kannalle FAIL-tuloksen:
   säännöllinen lauseke `(lat|lon|…)` osui sarakkeeseen
   `reminders.escalate`. Korjattu; `tests/verify-false-positives.test.mjs`.
2. 0010:n uudelleenajon tunnistusluku oli 41 (oikea 38) ja 0011:n 63
   (oikea 72): täysin ajetun migraation uudelleenajo ilmoitti "kesken".
   Korjattu; `tests/migration-rerun-detection.test.mjs`.
3. 0012:n uudelleenajo 0013:n jälkeen ilmoitti "kesken 57/58", koska 0013
   korvaa yhden 0012:n rajoitteen. Korjattu omalla haaralla.
4. `supabase/acceptance/life_alignment_readonly_inventory.sql` kaatui
   kokonaan (`date_trunc(text)`), jos `tasks.date` on tekstiä. Korjattu;
   uusi yksilauseinen `activation_readonly_inventory.sql` korvaa sen.
