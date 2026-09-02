# Yöajo: kovennus ja koko koodikannan verifiointi

Työpäiväkirja. Yksityiskohtainen evidenssi: `docs/audits/`.

## Lähtötila

| | |
|---|---|
| Haara | `feature/wp-13-20-ultra-product` |
| Alku-HEAD | `ca0e5d7` |
| Testit | 1071 / 1071 PASS |
| `npm run check` | PASS |
| `npm run smoke` | PASS (77) |
| Skeemaportit | 0 / 11 true |
| Migraatiot | 0 / 8 ajettu |
| Tuotanto | koskematon |

## Tunnetut tuotantoesteet (ei ratkaistavissa paikallisesti)

- `inventory.sql` ajamatta -> tuotannon todellista skeemaa ei tiedetä
- RLS todentamatta -> turvamallia ei ole todistettu, vain suunniteltu
- Migraatiot ajamatta -> persistenssi ei ole olemassa millekään portin takaiselle
- Tuotannon allekirjoitusavainta ei ole -> release-APK jää allekirjoittamattomaksi
- Fyysistä laitetta ei käytetä -> natiivi-ilmoitusten todellista käytöstä ei todenneta

## Invariantit, joita ei saa rikkoa

1. Yksikään skeemaportti ei käänny trueksi
2. Yhtäkään migraatiota ei ajeta
3. Tuotantoon ei oteta yhteyttä
4. Vain paikallisia committeja, ei pushia
5. Jokainen commit on vihreä
6. Domain pysyy puhtaana: ei DOM, ei verkko, ei kello, ei satunnaisuus

## Työjärjestys (riskijärjestys, ei tehtävälistan järjestys)

1. Auth/istunto ja tilan elinkaari (korkein riski, kolme aiempaa vuotoa)
2. AI-komentoputki adversariaalisesti
3. XSS ja DOM-injektio
4. Selaimen tallennus ja lokitus
5. Aika, DST, toisto, raha
6. Ilmoitukset ja duplikaatit
7. Repositoriosopimukset ja omistajuus
8. API ja serverless
9. PWA ja service worker
10. Android-manifesti ja build
11. Arkkitehtuuri, kuollut koodi, suorituskyky, saavutettavuus
12. Dokumentaation totuudenmukaisuus

## Loppu

| | Alku | Loppu |
|---|---|---|
| HEAD | `ca0e5d7` | `b1a88fc` |
| Testit | 1071 | **1160** |
| Committeja | - | 8 |
| Skeemaportit | 0 / 11 | **0 / 11** |
| Migraatiot | 0 / 8 | **0 / 8** |

## Loydokset

| Vakavuus | Loydos | Tila |
|---|---|---|
| HIGH | Tilinvaihto kesken muistutussynkronointia ajasti edellisen kayttajan tehtavien otsikot laitteelle | korjattu |
| MEDIUM | `allowBackup=true` vei refresh tokenin Google-varmuuskopioon | korjattu |
| MEDIUM | Vanhentunut lataus hyvaksyttiin ketjussa "A ulos -> A sisaan" | korjattu |
| MEDIUM | Kolme ominaisuusdokumenttia vaitti persistenssia, jota ei ole | korjattu |
| LOW | Hakujarjestys ei erottanut arkistoitua ajankohtaisesta | korjattu |
| LOW | `summarizeInput` ylitti oman rajansa yhdella merkilla | korjattu |
| LOW | `isQuietTime` heitti osittaisella oliolla (ei tavoitettavissa) | korjattu |
| LOW | Horisontti laski paivia millisekunteina (ennakoiva) | korjattu |
| - | HTTP-turvaotsakkeita ei ollut lainkaan | lisatty |

## Auditoitu ilman muutostarvetta

/api/parse, pyyntorajoitin, service worker, orpojen viitteiden kasittely,
rahan kokonaislukumalli, toistuvan kulun kuukausipaivapolitiikka,
skedulerin determinismi, rauhoitusajan puoliavoin vali, testien eristys.

## Deferred

Supabase-inventaario, RLS-todennus, migraatiot, CSP:n pakottaminen
(vaatii selaintodennuksen), Android-riippuvuusauditointi, laitetestit,
`SCHEDULE_EXACT_ALARM`-luvan epayksen kaytos.
