# Preflight-kyselyt

Ajetaan ENNEN vastaavaa migraatiota. Vain lukevia: jokainen lause alkaa
sanalla select, eika yksikaan muuta mitaan.

| Tiedosto | Milloin |
|---|---|
| `preflight_0002.sql` | ennen migraatiota 0002, runbookin GATE 1 |

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

Naita ei ole ajettu.
