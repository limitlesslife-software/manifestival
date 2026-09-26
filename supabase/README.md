# Supabase

Tässä hakemistossa ovat tietokannan versionhallitut migraatiot sekä niiden
vain lukevat esitarkistukset, todennukset, inventaariot ja tilannekuvat.

**Tila:** migraatiot 0001–0008 on ajettu tuotantoon ja todennettu.
0009–0013 ovat valmiita ja harjoiteltuja, mutta **ajamattomia**; ne
ajetaan yksi kerrallaan, kukin omalla hyväksynnällään. Ajantasainen tila:
[`docs/PRODUCTION-STATUS.md`](../docs/PRODUCTION-STATUS.md); paketit:
[`docs/activation/MIGRATION-BUNDLES.md`](../docs/activation/MIGRATION-BUNDLES.md).

`inventory.sql` ajettiin kerran ennen 0001:tä, ja **migraatio 0001 on
sovitettu sen tulokseen**: `profile` 1 rivi arvolla `'me'` (tyyppi `text`),
`tasks` 36 riviä ilman `user_id`-saraketta, molemmilla "salli kaikki"
-tyyppinen politiikka.

## Tiedostot

| Polku | Mitä tekee | Turvallinen ajaa? |
|---|---|---|
| `inventory.sql` | Alkuperäinen inventaario ennen 0001:tä | **Kyllä — vain luku** |
| `migrations/0001_*.sql` … `migrations/0013_*.sql` | Numeroidut migraatiot; jokaisen lopussa kommentoitu ROLLBACK-osio | **Vain hyväksynnällä**, yksi kerrallaan, koko tiedosto |
| `preflight/preflight_00NN.sql` | Esitarkistus juuri ennen migraatiota (0009–0013 generoitu: `tools/activation/build-preflights.mjs`) | **Kyllä — vain luku** |
| `verify/verify_00NN.sql` | Todennus migraation jälkeen: `poikkeavia_yhteensa = 0` | **Kyllä — vain luku** |
| `acceptance/` | Hyväksyntä- ja inventaariokyselyt, mm. `acceptance/activation_readonly_inventory.sql` | **Kyllä — vain luku** |
| `backup/snapshot_state_00NN.sql` | Looginen tilannekuva tilalle 0008–0013 (generoitu: `tools/activation/build-snapshots.mjs`) | **Kyllä — vain luku.** Tulos sisältää henkilötietoja: vain `.local-backups/`-hakemistoon |
| `preflight/recovery_snapshot_*.sql` | Rakenteen ja lukumäärien sormenjälki — **ei varmuuskopio** | **Kyllä — vain luku** |
| `functions/` | Edge-funktiot (`delete-account`, ei deployattu) | Ks. `functions/README.md` |

## Ajojärjestys (0009–0013)

Jokainen migraatio on oma pakettinsa ja oma hyväksyntänsä:

```
1. Vahvista Supabasen oma varmuuskopio (valinnainen: Database -> Backups,
   PITR) ja ota looginen tilannekuva (pakollinen 0010:lle, suositeltava
   muille): backup/snapshot_state_00NN.sql + tools/activation/restore-snapshot.mjs check
2. Aja preflight/preflight_00NN.sql -> 0 FAIL
3. Aja migraatio kokonaisuudessaan, yhtenä ajona, uudessa välilehdessä
4. Aja verify/verify_00NN.sql -> poikkeavia_yhteensa = 0
5. Vasta sitten aallon deploy ja portit (docs/acceptance/WAVE-X.md)
```

Tilannekuva, palautus ja päätöspuu:
[`docs/activation/0010-BACKUP-AND-RECOVERY.md`](../docs/activation/0010-BACKUP-AND-RECOVERY.md).
Supabasen omaa varmuuskopiota ei välttämättä voi ottaa pyynnöstä, ja sen
olemassaolo riippuu tilauksesta — siksi se ei ole koskaan ainoa kopio.

0001:n alkuperäiset vaiheet ja pysäytyspisteet:
[`docs/PRODUCTION-ACTIVATION-RUNBOOK.md`](../docs/PRODUCTION-ACTIVATION-RUNBOOK.md).

## Koodin portit

Sovellus ei oleta, että migraatio on ajettu. `src/data/schema.js` kertoo,
mitkä taulut ja sarakkeet ovat olemassa (`TABLES` ja sarakeportit kuten
`GOAL_PLANNING_FIELDS`). Ennen migraatiota tieto menee muistivarastoon
eikä säily sivun latauksen yli — ja käyttöliittymä kertoo sen
käyttäjälle. Teeskennelty tallennus olisi pahempi kuin puuttuva
tallennus.

Portit avataan aalloittain, aina vasta migraation ja sen todennuksen
jälkeen: aallot ja niiden portit
[`docs/activation/release-train-c-j.json`](../docs/activation/release-train-c-j.json),
hyväksyntäpaketit `docs/acceptance/WAVE-*.md`.

## Ajotapa

Supabase Dashboard -> **SQL Editor** -> **New query** -> liitä koko sisältö -> **Run**.

Migraatio ajetaan yhdessä transaktiossa (`begin` ... `commit`): jos jokin
vaihe epäonnistuu, koko ajo perutaan eikä mitään jää puolitiehen. Älä
koskaan aja tiedostosta valintaa.

## Peruutus

Migraatio 0001 **ei muuttanut `profile.id`:n tyyppiä.** Tuotannon arvo
`'me'` ei ole uuid, joten vanha sarake nimettiin `legacy_id`:ksi ja uusi
`uuid`-sarake lisättiin sen rinnalle. Ks. runbookin *0001:n peruminen*.

Migraatiot 0002–0013 ovat peruttavissa: jokaisen lopussa on
ROLLBACK-osio. Peruutus kadottaa sen tiedon, joka on kirjoitettu
migraation jälkeen uusiin sarakkeisiin tai tauluihin — ota siksi ensin
tilan mukainen tilannekuva (`backup/snapshot_state_00NN.sql`). Peruutus
ei ole ensimmäinen vastaus sovellusvirheeseen: ensin porttien
sulkeminen (edellisen aallon deploy).

## RLS-malli

Kaikissa tauluissa sama malli, poikkeuksetta:

```
Supabase Auth -> auth.uid() -> user_id (tai id) -> RLS -> vain oma data
```

- Omistajuuden asettaa **tietokanta** (`default auth.uid()`), ei selain.
  Client ei koskaan kirjoita `user_id`-saraketta — `src/data/collectionsRepo.js`
  estää sen erikseen.
- `anon`-roolille ei luoda yhtään politiikkaa ja sen oikeudet revokoidaan.
  Kirjautumaton ei näe eikä muuta mitään.
- Jokainen taulu saa neljä politiikkaa: select, insert, update ja delete.

## Käytännöt

- Jokainen skeemamuutos kirjoitetaan numeroituna migraationa tähän hakemistoon.
- Käsin tehtyjä, dokumentoimattomia dashboard-muutoksia ei tehdä. Jos jotain on
  pakko tehdä käsin, se kirjoitetaan jälkikäteen migraatioksi.
- Salaisuuksia ei kirjoiteta näihin tiedostoihin.
- Tilannekuvien tuloksia ei tallenneta tähän hakemistoon eikä
  versionhallintaan: ne sisältävät henkilötietoja (`.local-backups/`).
