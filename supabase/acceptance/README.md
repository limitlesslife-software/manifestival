# Hyvaksyntatestin jalkivarmistus

Kaksi tiedostoa:

| Tiedosto | Todistaa |
|---|---|
| `verify_acceptance.sql` | tasks- ja profile-taulujen tila (18 kohtaa) |
| `verify_acceptance_0003.sql` | routines- ja routine_exceptions-taulujen tila seka se etteivat vanhat muuttuneet (22 kohtaa) |

Molemmat ajetaan kun hyvaksyntatesti on tehty ja vakinainen tili B
poistettu.

Tama ei ole migraatiokohtainen varmistus. Se ajetaan kerran, kahden tilin
RLS-eristystestin jalkeen, ja se todistaa etta tuotanto palasi tasmalleen
siihen tilaan jossa se oli ennen testia.

MIKSI ERILLINEN TIEDOSTO: selaimessa ajettu eristystesti katsoo kantaa
RLS:n lapi. Se ei siis voi nahda, jaiko toisen tilin rivi kantaan - RLS
piilottaisi juuri sen rivin, jota etsitaan. Tama tiedosto ajetaan
SQL-editorissa ilman RLS-rajausta, ja se on ainoa paikka josta jaannoksen
voi nahda.

Yksi lause, yksi taulukko, yksi kopiointi. Sarakkeet: check_no, section,
check_name, status, details, poikkeavia_yhteensa. Kahdeksantoista
tarkistusta neljassa osiossa (tilin A data, jaannokset, rakenne,
oikeudet).

Odotus: jokaisen rivin status = 'PASS' ja poikkeavia_yhteensa = 0.

Vain lukeva. Ei kayttajan sisaltoa. Testi vartioi molempia.

Koko ohje: `docs/RLS-ACCEPTANCE.md`.
