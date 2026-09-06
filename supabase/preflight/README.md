# Preflight-kyselyt

Ajetaan ENNEN vastaavaa migraatiota. Vain lukevia: jokainen lause alkaa
sanalla select, eika yksikaan muuta mitaan.

| Tiedosto | Milloin |
|---|---|
| `preflight_0002.sql` | ennen migraatiota 0002 — AJETTU, migraatio on tehty |
| `predeploy_task_extended_fields.sql` | ennen lipun TASK_EXTENDED_FIELDS kaantamista, GATE B |
| `recovery_snapshot_post_0002.sql` | ennen mita tahansa riskialtista, GATE C |
| `preflight_0003.sql` | ennen migraatiota 0003 |
| `recovery_snapshot_pre_0003.sql` | ennen migraatiota 0003, tulos sailytetaan |

MIKSI ERILLINEN MIGRAATION ESIEHDOISTA: migraatio tarkistaa samat asiat
itsekin ja keskeytyy jos jokin ei tasmaa. Preflight kertoo saman ilman
lukkoa, ilman transaktiota ja ilman katkoa — ja keskeytynyt migraatio on
kalliimpi kuin lukeva kysely.

Tuloste on yksi taulukko: check_no, section, check_name, status, details,
poikkeavia_yhteensa.

Odotus: jokainen PASS/FAIL-rivi on PASS ja poikkeavia_yhteensa = 0.

INFO-rivit eivat ole vikoja. Ne ovat lukuja, joiden oikeaa arvoa ei voi
tietaa etukateen: rivimaaria ja objektien lukumaaria. Ne kirjataan yloos
ja verrataan migraation jalkeen verify-tiedoston vastaaviin. Keksitty
PASS olisi huonompi kuin rehellinen INFO.

preflight_0002.sql on ajettu. Muita ei ole ajettu.

recovery_snapshot_post_0002.sql on erikoistapaus: se ei tarkista
valmiutta johonkin vaan KIRJAA nykytilan. Tuorein fyysinen varmuuskopio
(2026-09-05 06:57:15 UTC) on otettu ENNEN migraatiota 0002, joten
palautus siita ei palauta nykyista tilaa. Tilannekuva kertoo, mika on
palautettava — ja sen tulos on sailytettava, ei vain katsottava.
