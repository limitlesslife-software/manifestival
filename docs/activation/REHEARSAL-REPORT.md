# Migraatioharjoittelu oikealla PostgreSQL:llä — raportti 2026-09-25

**Ympäristö:** PostgreSQL **17.10** (x86_64-windows), paikallinen ja
kertakäyttöinen: `127.0.0.1:54329`, data `.claude/pg-local/` (ignoroitu),
ei asennusta eikä palvelua. Supabase-yhteensopiva perusta
(`tools/pg-rehearsal/supabase-shim.sql`): roolit `anon`,
`authenticated`, `service_role`, `auth.uid()` samalla määrittelyllä kuin
Supabasessa, public-skeeman oletusoikeudet kuten Supabasessa.

**Ajo:** `node tools/pg-rehearsal/rehearse.mjs` (~1–2 min). Tulos:
**0 hylättyä** kaikissa skenaarioissa.

| Skenaario | Tulos | Mitä todistaa |
|---|---|---|
| upgrade:text | 0001→0013 kaikki PASS, verify 0 FAIL jokaisessa | Ketju tuotannon muotoisesta lähtötilasta (36 tehtävää, `profile='me'`, "salli kaikki" -politiikat), `tasks.date/time` tekstinä |
| upgrade:typed | sama | sama, `date`/`time`-tyypeillä (tuotannon tyyppiä ei ole todennettu) |
| rls | 26 taulua, 311 tarkistusta, 0 hylättyä | Jokaisessa taulussa: A ei lue/päivitä/poista B:n riviä, ei lisää B:n nimissä (42501), ei siirrä omaa riviään B:lle (42501), ei viittaa B:n riviin yhdistelmävierasavaimella (23503); anon 42501; kirjautunut ilman `sub`:ia ei näe mitään; ei yhtään anon/PUBLIC-oikeutta |
| lifecycle | 24/24 | Poistosäännöt (tavoite/alue/tehtävä → kirjattu aika säilyy, viite nollautuu), 1 ajastin/käyttäjä, `operation_id`-idempotenssi, rajat (0/1441 min, maanantai, nimen pituus, ajastimen loppu < alku), tilin poiston cascade kaikkiin 26 tauluun, **vanhojen aaltojen rivimuodot kirjoitettavissa 0013:n jälkeen** |
| failure | 31/31 | Uudelleenajo ("JO AJETTU"), puuttuva esiehto, osittainen tila, lukon aikakatkaisu (5 s) ja uudelleenajo lukon vapauduttua, myöhäinen esiehto — katalogi täsmälleen ennallaan jokaisen epäonnistumisen jälkeen |
| rollback | 5/5 | 0009–0013: ajo → oma ROLLBACK-osio → skeema täsmälleen ennallaan → ajo uudelleen |
| preflight | 35/35 | Jokainen `preflight_0009…0013.sql` PASS vain juuri ennen omaa migraatiotaan, FAIL kaikissa muissa tiloissa |
| inventory | 38/38 | `activation_readonly_inventory.sql` READ ONLY -transaktiossa jokaisessa tilassa, pisteytys GO/STOP oikein; keskeneräinen 0012 ja puuttuva omistaja → STOP |

## Löydökset (kaikki korjattu tuotehaaraan ja poimittu ehdokkaisiin)

1. **verify_0011 väärä hälytys** — tarkistus 12 osui sarakkeeseen
   `reminders.escalate` (esca-**LAT**-e): ehjä 0011 olisi saanut FAIL:n
   ja aalto H olisi pysähtynyt.
2. **Uudelleenajon viesti väärä** — täysin ajettu 0010 ("kesken 38/41")
   ja 0011 ("kesken 72/63"), sekä 0012 0013:n jälkeen ("kesken 57/58"),
   ohjasivat palautuspolulle ehjän kannan kohdalla.
3. **Inventaario kaatui** — `life_alignment_readonly_inventory.sql`
   päättyi virheeseen `date_trunc(text)`, jos `tasks.date` on tekstiä, eikä
   Supabasen editori olisi näyttänyt 16 lauseesta kuin viimeisen.

## Mitä EI todistettu

| Aukko | Miksi | Luokka |
|---|---|---|
| PostgREST/HTTP-kerros | Ei paikallista PostgRESTiä; RLS todennettu samalla mekanismilla (rooli + JWT-väitteet) | REAL_DB_ENVIRONMENT_REQUIRED (tuotannon aaltohyväksyntä kattaa) |
| Supabasen `postgres`-rooli ≠ superuser | Harjoitus ajoi superuserina | sama |
| Tuotannon PostgreSQL-versio ja `tasks.date`-tyyppi | Luetaan inventaariosta | OWNER_READ_ONLY_SQL_REQUIRED |
| Samanaikainen kuorma | Vain lukon aikakatkaisu testattu | ei estä (yksi käyttäjä) |
