# Arjen käyttöjärjestelmä (Daily Life OS)

Tila: 2026-09-27, yön henkilökäyttöpaketti. Kaikki PAIKALLISTA: ei pushia, ei deployta, ei
tuotannon SQL:ää. Migraatio 0014 on EI AJETTU. Tuotanto pysyy aallossa F (v19, kanta 0009).

## Mitä tämä on

Suunta (Life Alignment) vastaa kysymykseen "elänkö niin kuin itse haluan". Arjen
käyttöjärjestelmä vastaa kysymykseen "mitä minun pitää tehdä nyt, jotta ehdin ilman kiirettä".
Se tuo Manifestivaliin:

- kalenterin (päivä, viikko, kuukausi) kiinteille menoille, toistuville sitoumuksille ja koko
  päivän merkinnöille
- tallennetut paikat ja käyttäjän vahvistamat lisänimet ("parturi" → Parturi Kallio)
- lähtömoottorin v2: lähtöaika lasketaan taaksepäin **saapumistavoitteesta**
- työmatkan oppimisen käyttäjän kuittaamista matkoista (ei sijaintihistoriaa)
- älykkään aamun: herätys lasketaan ensimmäisestä sitoumuksesta taaksepäin
- unen suojauksen, viikonlopun rytmin ja maanantaivalmiuden
- natiivin Android-herätyksen ja puhutut taustamuistutukset
- tapojen muutoksen tuen (esim. nikotiinin vähentäminen omalla suunnitelmalla), ateriarytmin,
  liikunnan ja päivän voinnin

## Periaate: suojattu väljyys

Valmistautuminen, matka, pysäköinti ja kävely, perilläolon varmuusaika, lepo ja uni **eivät ole
vapaata aikaa**. Joustava työ saa liikkua niiden ympärillä. Mikään automaattinen laskenta ei vie
suojattua unta toisen asian tieltä: jos aamu ei mahdu, käyttäjälle näytetään valinnat
("jätä lenkki pois", "lyhennä", "herää aiemmin — maksaa 20 min unta"), eikä mitään tehdä
kysymättä.

Suunnitelma suosii realistista, ajoissa olevaa ja selitettävää — ei mahdollisimman täyttä.

## Lähtöaika

```
saapumistavoite  = menon alku − etuaika            (meno > paikka > asetus, oletus 10 min)
lähtö            = saapumistavoite − pysäköinti/kävely − matka-aika
valmistautuminen = lähtö − valmistautumisaika
```

Vaiheet: TUNTEMATON_MATKA · EI_VIELÄ · VALMISTAUDU_PIAN · VALMISTAUDU_NYT · LÄHDE_5_MIN ·
LÄHDE_NYT · MYÖHÄSSÄ.

Matka-ajan lähde (järjestys): tuore liikennetieto → käyttäjän hyväksymä opittu kesto (vähintään
3 havaintoa; varovainen: suurempi liikennetiedosta ja 80 %:n arvosta) → menon oma arvio → paikan
tavallinen kesto → **tuntematon: lähtöaikaa ei lasketa**. Matka-aikaa ei koskaan keksitä.

Uudelleenlaskenta ei aiheuta ilmoitusmyrskyä: lähtö nousee esiin vain, jos se aikaistuu
vähintään 5 min (tai myöhentyy vähintään 10 min).

## Liikennetieto

Reittipalvelun raja (`src/domain/routing.js`) on rakennettu: pyyntö (lähtö, määränpää,
lähtöaika, kulkutapa) → tulos (tila, kesto, matka, liikennetietoinen, palvelu, laskettu,
voimassa, luotettavuus). Palvelua ei ole määritetty, joten jokainen pyyntö palauttaa tilan
UNKNOWN. **Oikea liikennetieto: BLOCKED_EXTERNAL_PROVIDER** — vaatii omistajan valitseman
palvelun ja tilin (esim. Google Routes API tai HERE).

## Google Maps

"Avaa reitti" rakentaa vain sallitun muodon: Android-intentti `google.navigation:q=…` Google
Mapsin pakettiin, tai varalla `https://www.google.com/maps/dir/?api=1&destination=…`.
Kohde on aina puhdistettu teksti (nimi tai osoite); tekoälyn tai datan antamaa URL-osoitetta ei
koskaan avata (`src/domain/navigationLink.js`).

## Tietomalli (migraatio 0014, aalto K, v24)

Kymmenen uutta taulua, ei muutoksia olemassa oleviin: `saved_places`, `place_aliases`,
`calendar_events`, `commute_observations`, `life_settings` (yksi rivi käyttäjää kohti),
`sleep_logs`, `habit_plans`, `habit_events`, `exercise_sessions`, `wellbeing_checkins`.
Unitavoite ja arkiherätys pysyvät profiilissa (`profile.sleep_target_hours`,
`profile.default_wake_time`). Toistuvan menon esiintymiä ei tallenneta: ne lasketaan kuten
rutiinien esiintymät.

Yksityisyys: ei koordinaatteja, ei sijaintihistoriaa. Uni on **vuoteessa oloaikaa**, ei
mitattua unta. Motivaatio, hallinnan tunne, uni ja nikotiini ovat arkaluonteisia: ne eivät mene
tekoälylle eivätkä lokiin.

## Herätys ja puhe (Android)

Natiiviliitännäinen `ManifestivalAlarm`: tarkka herätys (`setAlarmClock`), puhutut ja kriittiset
muistutukset (`setExactAndAllowWhileIdle`), palautus uudelleenkäynnistyksen, kellonajan ja
aikavyöhykkeen muutoksen jälkeen, etualan soittopalvelu (mediaPlayback), lukitusnäytön
herätysnäkymä, puhe (TextToSpeech fi-FI) ja "Avaa reitti" -toiminto ilmoituksesta. Herätys ei
soi loputtomiin: enintään 10 min, sitten yksi torkku ja loppu. Laitteella toimivuus on
**IMPLEMENTED_DEVICE_UNVERIFIED**, kunnes se on koettu oikealla puhelimella.

## Tekoäly

Kalenteri, lähtö, uni, herätys, muistutukset ja Suunta toimivat ilman tekoälyä. Puhuttu
"Lisää parturi ensi tiistaille klo 16" jäsennetään paikallisesti ja deterministisesti
(`src/domain/eventParse.js`); epäselvä kenttä ("seitsemältä" = 7 vai 19?) kysytään, sitä ei
arvata. Tekoäly ei muuta prioriteetteja, unitavoitetta, nikotiinisuunnitelmaa eikä kapasiteettia
eikä tee kalenteriin muutoksia ilman hyväksyntää.

## Oppiminen on selitettävää

Jokainen opittu ehdotus kertoo syynsä ("Viimeisten 6 työmatkan mediaani oli 38 min").
Käyttäjä voi hyväksyä, ohittaa tai nollata oppimisen. Myöhästelyn oppiminen ei koskaan siirrä
kelloa salaa: se ehdottaa lähtömuistutuksen aikaistamista, ja käyttäjä päättää.

## Paikallinen selain-E2E (`npm run e2e:daily-life`)

`tools/e2e/run-daily-life-e2e.mjs` käynnistää oikean `src/app/main.js`:n headless-Chromessa
tekaistulla istunnolla ja tallentavalla kannan korvikkeella (`tools/e2e/fakeSupabase.mjs`, joka
mallintaa myös 0014:n uniikki- ja viiteavaimet sekä time-sarakkeiden `HH:MM:SS`-muodon). Ei
tuotantoa: `*.supabase.co`, Anthropic ja Googlen nimet estetään DNS-tasolla, jokainen pyyntö
kirjataan, ja yksikin ulkoinen pyyntö kaataa ajon. Kello on kuluvan viikon keskiviikko klo 10.

- **closed** (haaran omat portit): Kalenteri, Arki, Hyvinvointi, Paikat ja Asetukset kertovat,
  että tieto säilyy vain istunnon ajan; 0014:n tauluihin ei kirjoiteta, eikä mikään kaadu.
- **K** (aallon K portit; K-ehdokasta ei vielä ole, joten portit tulevat junan määrittelystä
  `trainMatrix('K')`, tai ehdokkaasta `E2E_K_GATES_REF=<ref>`): uusi meno tallennetulla paikalla
  ja omalla matka-arviolla (suojatut rivit, "Lähde 14.15", Avaa reitti), toistuvan menon yhden
  kerran ohitus, kuukausi ja nuolinäppäimet, puuttuva matka-aika, näppäimistö (Tab, Escape),
  Arki, ohjaustyyli, Paikat (nollaus ja poisto vahvistuksella) ja Hyvinvointi. Jokainen
  todennetaan näkymästä ja kannan riveistä oikean uudelleenlatauksen yli.

Avoimet löydökset (ajossa ODOTTAA, PENDING_ON): tapakirjaukselle (`habit_events`) ja Tänään-
näkymän motivaatio- ja hallinnan tunne -kirjaukselle (`wellbeing_checkins`) ei ole näkymää,
vaikka `tools/release/reachability.mjs` lupaa "kirjaus Tänään-kortista":
`dailyLifeActions.logHabitEvent` ja `saveWellbeingCheckin` eivät ole kytkettyjä mihinkään.
