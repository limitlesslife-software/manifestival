# Varmistuskyselyt

Yksi tiedosto migraatiota kohti. Jokainen ajetaan **vasta vastaavan
migraation jalkeen**, runbookin PYSAYTYS-kohdassa.

Kaikki kyselyt ovat **vain lukevia**. Yhdessakaan ei ole insert, update,
delete, alter, drop, create eika grant. Yksikaan ei tulosta salaisuuksia,
avaimia eika kayttajan sisaltoa - vain rakenteen ja rivimaaria.

Ajojarjestys ja tulkinta: `docs/PRODUCTION-ACTIVATION-RUNBOOK.md`.

TILANNE: verify_0001.sql ja verify_0002.sql on ajettu tuotantoa vasten
ja molemmat ovat lapi. verify_0003 on kirjoitettu ALL-IN-ONE-muotoon (32 tarkistusta) ja
migraatio 0003 on auditoitu, mutta sita ei ole ajettu. verify_0004 -
verify_0008 odottavat seka auditointia etta migraatiota.

Hakemistossa on myos verify_task_extended_activation.sql. Se EI ole
migraatiokohtainen varmistus vaan ajetaan kerran, kun lippu
TASK_EXTENDED_FIELDS on kaannetty ja koodi julkaistu. Ks.
docs/TASK-EXTENDED-FIELDS-ACTIVATION.md, GATE G.
verify_0002 - verify_0008 odottavat viela vastaavia migraatioita, joita ei
ole ajettu.

Naiden lisaksi on `supabase/acceptance/verify_acceptance.sql`. Se ei ole
migraatiokohtainen varmistus vaan kahden tilin eristystestin
jalkivarmistus: se todistaa, etta tuotanto palasi lahtotilaan testin
jalkeen. Sama saanto koskee sita - vain lukeva, ei kayttajan sisaltoa.
