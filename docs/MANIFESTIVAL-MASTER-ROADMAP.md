# Manifestival — master roadmap (kanoninen ominaisuusluettelo)

Tila: 2026-09-27, henkilökäyttöpaketin (arjen käyttöjärjestelmä) jälkeen.
Tämä on koko tuotteen ominaisuusluettelo. Jokaisella ominaisuudella on TASAN
YKSI tila ja yksi prioriteetti (`tests/master-roadmap.test.mjs` vartioi
muodon). Yksityiskohdat ovat viitatuissa dokumenteissa; tämä tiedosto kertoo,
mikä on valmis, mikä odottaa ja miksi. Korvaa vanhan `docs/ROADMAP.md`:n
tilataulukon (1.9.2026).

**Tuotanto:** aalto F (2c8e230, välimuisti v19), kanta 0001–0009. Kaikki alla
oleva, mikä on migraatioiden 0010–0014 takana, on paikallisesti valmista mutta
tulee käyttöön vasta, kun omistaja aktivoi aallot G → H → I → J → K järjestyksessä
(ks. `docs/SUUNTA-FAST-ACTIVATION.md` ja `docs/acceptance/WAVE-K.md`).
"COMPLETE_LOCAL" ei siis tarkoita "tuotannossa".

## Tilat

| Tila | Merkitys |
|---|---|
| COMPLETE_LOCAL | Toteutettu ja testattu paikallisesti (yksikkö-, selain- ja/tai PostgreSQL-harjoitus). Tuotantoon vie aalto + omistajan hyväksyntä. |
| IMPLEMENTED_DEVICE_UNVERIFIED | Koodi valmis ja testattu staattisesti/mockeilla, mutta toimivuus riippuu oikeasta Android-laitteesta (lukitusnäyttö, uudelleenkäynnistys, Doze, TTS-ääni). Laitehyväksyntä: `docs/DEVICE-ACCEPTANCE-BACKLOG.md`. |
| PARTIAL | Osa toteutettu; puuttuva osa nimetty. |
| ARCHITECTURE_ONLY | Rajapinta/sopimus olemassa, toteutusta ei. |
| BLOCKED_EXTERNAL_PROVIDER | Vaatii ulkoisen palvelun tai tilin. Raja on rakennettu ja palauttaa "tuntematon" — mitään ei keksitä. |
| BLOCKED_PRODUCT_DECISION | Vaatii omistajan tuotepäätöksen. |
| FUTURE_COMMERCIAL | Kaupallisen version asia, ei henkilökäytön tarve. |
| NOT_STARTED | Ei aloitettu. |

Prioriteetit: **P0** = PERSONAL_USE_P0 (päivä 1 omassa käytössä), **P1** =
PERSONAL_USE_P1 (ensimmäiset viikot), **P2** = PERSONAL_USE_P2, **CL** = COMMERCIAL_LATER.

<!-- STATUS-TABLE-START -->
| Alue | Ominaisuus | Prioriteetti | Tila | Aalto | Todiste / puuttuva osa |
|---|---|---|---|---|---|
| Ydin | Tehtävät, aikajana, päivän suunnitelma | P0 | COMPLETE_LOCAL | A–F (tuotannossa) | `src/domain/scheduler.js`, `views/today.js` |
| Ydin | Rutiinit ja poikkeukset | P0 | COMPLETE_LOCAL | C (tuotannossa) | `docs/ROUTINES.md` |
| Ydin | Tavoitteet, projektit, välitavoitteet | P0 | COMPLETE_LOCAL | A, G | `docs/GOAL-TO-ACTION.md`; suunnittelu, kapasiteetti ja uudelleensuunnittelu käyttävät kalenterin menoja, matkoja ja suojattua unta; G odottaa 0010:tä |
| Suunta | Elämän suunta (alueet, kapasiteetti, katsaus, ajastin) | P0 | COMPLETE_LOCAL | I–J | `docs/LIFE-ALIGNMENT.md`; odottaa 0012–0013:a |
| Kalenteri | Päivä, viikko ja kuukausi | P0 | COMPLETE_LOCAL | K | `views/calendar.js`, `tests/calendar-ui.test.mjs` |
| Kalenteri | Kiinteät menot, koko päivän menot, viikkotoisto, kerran ohitus | P0 | COMPLETE_LOCAL | K | `domain/calendar.js`, `views/calendarForm.js` |
| Kalenteri | Suojatut lohkot: valmistautuminen, matka, pysäköinti ja kävely, etuaika, iltarauhoittuminen, uni | P0 | COMPLETE_LOCAL | K | `domain/calendarBlocks.js`, `app/calendarPlan.js` |
| Kalenteri | Muistutus menon alkuun, kun lähtöketjua ei ole (ei paikkaa tai matka-aikaa) | P1 | COMPLETE_LOCAL | K | `domain/dailyReminders` EVENT_START + `alarmSync`; "Alkaa klo", lähtöaikaa ei arvata |
| Kalenteri | Ulkoiset kalenterit (Google, Outlook) | P2 | BLOCKED_PRODUCT_DECISION | — | OAuth-tili ja tietosuojapäätös puuttuvat |
| Puhe | Puhe tekstiksi (käyttäjän käynnistämä) | P0 | IMPLEMENTED_DEVICE_UNVERIFIED | — | `SpeechPlugin`; selaimessa Web Speech |
| Puhe | Puhe menoksi paikallisesti (ei tekoälyä) | P0 | COMPLETE_LOCAL | K | `app/localCommands.js` + `domain/eventParse.js`: tarkennus, tarkistus ennen tallennusta, paikan nimityksen oppiminen vasta hyväksynnästä |
| Puhe | Keskeytykset: myöhässä, jatka, ohita, siirrä | P0 | COMPLETE_LOCAL | K | yksi polku `app/dayReplanActions.js` (Tänään-kortti ja puhe), esikatselu + vahvistus + peruutus virheessä |
| Avustaja | Puhuva taustamuistutus (lähtö, 5 min, nyt, nukkumaan, herätys, ateria, tupakka, määräaika) | P0 | IMPLEMENTED_DEVICE_UNVERIFIED | K | `app/alarmSync.js` → natiivi `ManifestivalAlarm` (TTS); puhe ja lukitusnäyttö laitteella vahvistamatta |
| Avustaja | Ilmoitusten tasot (hiljainen … kriittinen) | P0 | COMPLETE_LOCAL | K | `domain/notificationPolicy.js`; puhuvat ja kriittiset natiiviin, muut paikallisiin (`alarmSync.partitionReminders`) |
| Avustaja | Kuittaus (kuitattu, torkku, ohitettu, lähdin) | P0 | COMPLETE_LOCAL | K | natiivit tapahtumat → `app/alarmEvents.js` kuittausmuisti; ilmoituskeskuksen Kuittaa/Torkuta/Hoidettu muistutukseen |
| Avustaja | Kuittaus tavallisten ilmoitusten painikkeista | P2 | NOT_STARTED | — | — |
| Avustaja | Kooste (digest) | P1 | COMPLETE_LOCAL | K | `notificationPolicy.mergeDigest` ajastuksen polulla (`alarmSync`) |
| Avustaja | Ohjaustyyli: rauhallinen, napakka, aktiivinen | P1 | COMPLETE_LOCAL | K | `views/guidanceSettings.js`, `notificationPolicy.guidanceEffects` |
| Paikat | Tallennetut paikat, oletusetuaika, kulkutapa | P0 | COMPLETE_LOCAL | K | `views/placesSettings.js` |
| Paikat | Lisänimet ja niiden vahvistus | P0 | COMPLETE_LOCAL | K | `domain/places.js`, `domain/eventParse.js`: osittain nimetty paikka kysytään, perusmuoto opitaan vahvistuksesta ja liitetään kahden vahvistuksen jälkeen; oma nimitys Paikoissa liitetään heti; luku, poisto, nollaus |
| Paikat | Sijainti (vain etualalla, käyttäjän pyynnöstä) | P2 | ARCHITECTURE_ONLY | — | tarkoituksella pois päältä; ei sijaintihistoriaa |
| Lähtö | Reittipalvelun raja (tuntematon ilman palvelua) | P0 | COMPLETE_LOCAL | K | `domain/routing.js` |
| Lähtö | Reaaliaikainen liikenne ja ETA | P0 | BLOCKED_EXTERNAL_PROVIDER | — | reittipalvelun tili puuttuu; raja palauttaa UNKNOWN |
| Lähtö | Lähtömoottori v2: vaiheet, etuaika, pysäköinti, valmistautuminen | P0 | COMPLETE_LOCAL | K | `domain/departure.js`, `tests/departure-v2.test.mjs` |
| Lähtö | Uudelleenlaskennan hystereesi | P0 | COMPLETE_LOCAL | K | `app/departureWatch.js` |
| Lähtö | Avaa reitti (Google Maps) | P0 | COMPLETE_LOCAL | K | `domain/navigationLink.js` sallittu lista; kalenterin rivi, Tänään-kortti ja tavallisen "Lähde nyt" -ilmoituksen toiminto (`platform/nativeNotifications.js`); natiivi intentti laitteella vahvistamatta |
| Lähtö | Oppiva matka-aika (käyttäjän hyväksymä, selitetty) | P0 | COMPLETE_LOCAL | K | `domain/commuteLearning.js`, Paikat-näkymän ehdotus |
| Lähtö | Myöhästymisten oppiminen | P1 | COMPLETE_LOCAL | K | `commuteLearning` + `app/dailyLifeNotices.js` latenessNotice |
| Aamu | Älykäs aamusuunnittelu (ensimmäinen sitoumus → herätys) | P0 | COMPLETE_LOCAL | K | `domain/morningPlanner.js`, `app/calendarPlan.morningFor` |
| Aamu | Aamurutiinin vaihemuistutukset ("Suihku nyt. Seuraavaksi: Aamiainen.") | P1 | COMPLETE_LOCAL | K | `alarmSync` + `dailyReminders` MORNING_STEP samasta aamusuunnitelmasta, vain kun Aamurutiini-tapa on valittu; iltapäivän meno ei ole aamun meno |
| Uni | Suojattu uni ja nukkumaanmenon siirto | P0 | COMPLETE_LOCAL | K | `domain/sleepRhythm.js` |
| Uni | Unikirjaus ja rytmin ajelehtiminen | P1 | COMPLETE_LOCAL | K | `views/wellbeingHub.js` ("vuoteessa oloaika, ei mitattua unta"); sammutettu herätys kirjaa toteutuneen heräämisen (`app/alarmEvents.js`) |
| Rytmi | Illan ennakkosuunnittelu | P0 | COMPLETE_LOCAL | K | `app/dailyLifeNotices.eveningBeforeAdvice` (sama `sleepPlanOn`-laskenta) ilmoituskeskukseen ja laitteen muistutukseksi (`alarmSync`) |
| Rytmi | Viikonlopun rytmi ja maanantain valmius | P1 | COMPLETE_LOCAL | K | `app/dailyLifeNotices.weekendRhythmNotices` |
| Herätys | Natiivi tarkka herätys (lukitusnäyttö, uudelleenkäynnistys, kesäaika) | P0 | IMPLEMENTED_DEVICE_UNVERIFIED | K | `ManifestivalAlarm` (Java) + `platform/alarms.js` + `app/alarmSync.js`; herätykset ajastetaan viikoksi eteenpäin (tänään + 7), Arki kertoo mihin asti; laitehyväksyntä `docs/DEVICE-ACCEPTANCE-BACKLOG.md` |
| Herätys | Tilat: ääni, musiikki, puhe, yhdistelmä | P0 | IMPLEMENTED_DEVICE_UNVERIFIED | K | `AlarmService`; valittu ääni `pickAlarmSound`; oma musiikki `pickAlarmMusic` (järjestelmän tiedostovalitsin audio/*, pysyvä lukuoikeus, ei tallennuslupaa) soi tavoilla Oma musiikki ja Ääni ja puhe, varavaihtoehto herätysääni (`AlarmMath.soundSources`); laitteella vahvistamatta |
| Herätys | Porrastettu voimistuminen | P1 | IMPLEMENTED_DEVICE_UNVERIFIED | K | `alarmPlan.normalizeEscalation`, `AlarmService` |
| Herätys | Puhuttu aamukooste | P1 | IMPLEMENTED_DEVICE_UNVERIFIED | K | `alarmPlan.morningBrief` luetaan kerran Sammuta-painalluksen jälkeen (`briefOnDismiss`) tavasta riippumatta, myös oletustavalla; ei torkussa; TTS laitteella vahvistamatta |
| Päivä | Päivän uudelleensuunnittelu lohkoineen | P0 | COMPLETE_LOCAL | K | `domain/dayReplan.js` + `app/dayReplanActions.js`; kiinteät menot, matkat ja lepo eivät siirry |
| Päivä | Avoimet asiat ("tällä viikolla") | P1 | COMPLETE_LOCAL | K | Tänään → Avoimet asiat: Ehdota aikaa → perustelu → hyväksyntä |
| Päivä | Asiointien ryhmittely | P1 | COMPLETE_LOCAL | K | Tänään: "olet jo menossa lähelle" -ehdotus |
| Hyvinvointi | Ateriarytmi, vesi ja lisäravinteet | P1 | COMPLETE_LOCAL | K | asetukset + ateria-, lisäravinne-, vesi- ja iltarajamuistutukset (`alarmSync`) |
| Hyvinvointi | Liikunta ja viikkokooste | P1 | COMPLETE_LOCAL | K | `domain/exercise.js`, Hyvinvointi-näkymä |
| Hyvinvointi | Kuntotestit | P2 | NOT_STARTED | — | — |
| Hyvinvointi | Stressi, mieliala, motivaatio, hallinnan tunne | P1 | COMPLETE_LOCAL | K | `wellbeingCheckins`, 14 päivän historia (puuttuva ≠ 0) |
| Hyvinvointi | Nikotiini ja tapojen muutos | P1 | COMPLETE_LOCAL | K | `domain/habitEngine.js`, Tapojen muutos, Tänään-tapakortti, neutraali muistutus |
| Hyvinvointi | Hyvinvointi Suunnan katsauksessa | P1 | COMPLETE_LOCAL | K | `domain/dailyLifeSignals.js`, katsauksen Arki-osio |
| Terveys | Terveysdata ja puettavat (Health Connect) | P2 | ARCHITECTURE_ONLY | — | `domain/healthData.js` sopimus; ei palvelua |
| Talous | Talous 2.0: tapahtumat, budjetti, laskut, kuitit, säästöt | P2 | COMPLETE_LOCAL | F (tuotannossa) | `docs/FINANCE-2.0.md` |
| Talous | Rahan suunta ja ostos työtunteina | P2 | COMPLETE_LOCAL | K | Talous → Säästötavoitteet → Ostos omana aikana (`views/purchaseCheck.js`, oma tunnin arvo); Talous → Budjetti → Harkinnanvarainen käyttö omaa kuukausirajaa vasten (`views/discretionaryLimit.js`, raja laitteella kunnes tilisarake on migraatiossa) ja sama vertailu katsauksen Arki-osiossa |
| Talous | Sijoitukset (oma kirjanpito) | P2 | COMPLETE_LOCAL | F | `docs/INVESTMENTS-ARCHITECTURE.md`; oma tavoitearvo lomakkeessa ja rivillä (`targetComparison`) |
| Talous | Sijoitusten omat hälytykset | P2 | ARCHITECTURE_ONLY | — | `domain/investments.evaluateUserAlerts` valmis; tallennus vaatii migraation (ei taulua eikä saraketta) |
| Talous | Automaattinen kurssiseuranta | P2 | BLOCKED_EXTERNAL_PROVIDER | — | `domain/marketData.js` palauttaa UNKNOWN |
| Talous | Pankkiyhteys | CL | BLOCKED_EXTERNAL_PROVIDER | — | PSD2-palvelu ja sopimus puuttuvat |
| Oppiminen | Selitettävä personointi (käyttäjä hyväksyy) | P1 | COMPLETE_LOCAL | K | oppiminen ehdottaa, ei koskaan muuta itse |
| Tieto | Vienti (kaikki omat tiedot, ei koordinaatteja) | P0 | COMPLETE_LOCAL | K | `domain/dataExport.js` (0014:n kymmenen kokoelmaa) |
| Tieto | Tilin poisto | P0 | BLOCKED_PRODUCT_DECISION | — | koodi ja Edge Function valmiit; funktion deploy odottaa omistajaa (`docs/ACCOUNT-DELETION.md`) |
| Tieto | Offline ja synkronointi | P0 | COMPLETE_LOCAL | K | tehtävät (`offline.js`); menot ja tapakirjaukset (`dailyLifeOutbox.js`), tila samalla rivillä |
| Tieto | Varmuuskopio ja palautus | P1 | COMPLETE_LOCAL | — | `docs/activation/0010-BACKUP-AND-RECOVERY.md` |
| Tieto | Käynnistyksen yhteensopivuus (skeemakoetin) | P0 | COMPLETE_LOCAL | K | `src/data/schema.js`, `tests/schema-session-recovery.test.mjs` |
| Tieto | Useampi välilehti ja kilpatilanteet | P0 | COMPLETE_LOCAL | K | istuntovartija `app/dailyLifeActions.js`, `tests/daily-life-actions.test.mjs` |
| Laatu | Yksityisyys (ei sijaintihistoriaa, arkaluonteinen ei tekoälylle) | P0 | COMPLETE_LOCAL | K | `docs/SECURITY.md`, `docs/DAILY-LIFE-OS.md` |
| Laatu | Saavutettavuus (näppäimistö, 44 px, nimet) | P0 | COMPLETE_LOCAL | K | a11y-testit |
| Käyttöönotto | Ensikäytön asetukset (vaiheittain) | P1 | COMPLETE_LOCAL | K | Profiili → Aloitusasetukset: 11 kohtaa tiedoista (ydin: unitavoite ja arkiherätys), napautus vie kenttään, piilotus käyttäjäkohtainen (`views/setupChecklist.js`); opastusikkuna kevyt |
| Android | APK (henkilökäyttö) | P0 | IMPLEMENTED_DEVICE_UNVERIFIED | K | rakennetaan K-ehdokkaasta, EI ASENNETTAVAKSI ennen aaltoa K |
| Kaupallinen | Perhetila | CL | FUTURE_COMMERCIAL | — | — |
| Kaupallinen | Yrittäjätila | CL | FUTURE_COMMERCIAL | — | — |
| Kaupallinen | Maksulliset oikeudet | CL | FUTURE_COMMERCIAL | — | — |
| Kaupallinen | Sovelluskauppavalmius | CL | BLOCKED_PRODUCT_DECISION | — | julkaisutili ja tietosuojaseloste |
<!-- STATUS-TABLE-END -->
