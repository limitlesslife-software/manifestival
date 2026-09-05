# Varmistuskyselyt

Yksi tiedosto migraatiota kohti. Jokainen ajetaan **vasta vastaavan
migraation jalkeen**, runbookin PYSAYTYS-kohdassa.

Kaikki kyselyt ovat **vain lukevia**. Yhdessakaan ei ole insert, update,
delete, alter, drop, create eika grant. Yksikaan ei tulosta salaisuuksia,
avaimia eika kayttajan sisaltoa - vain rakenteen ja rivimaaria.

Ajojarjestys ja tulkinta: `docs/PRODUCTION-ACTIVATION-RUNBOOK.md`.

TILANNE: verify_0001.sql on ajettu tuotantoa vasten ja se on lapi.
verify_0002.sql on kirjoitettu valmiiksi ALL-IN-ONE-muotoon (29
tarkistusta, yksi taulukko), mutta migraatiota 0002 ei ole ajettu.
verify_0002 - verify_0008 odottavat viela vastaavia migraatioita, joita ei
ole ajettu.

Naiden lisaksi on `supabase/acceptance/verify_acceptance.sql`. Se ei ole
migraatiokohtainen varmistus vaan kahden tilin eristystestin
jalkivarmistus: se todistaa, etta tuotanto palasi lahtotilaan testin
jalkeen. Sama saanto koskee sita - vain lukeva, ei kayttajan sisaltoa.
