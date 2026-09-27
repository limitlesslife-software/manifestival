# Mielen kuorman keventäminen (Mental Load Reduction Core) — aalto L

TILA: rakennettu PAIKALLISESTI (2026-09-27). Migraatio 0015 EI AJETTU.
Tuotanto: aalto F / v19 / kanta 0009. Aalto K jäädytetty (d11d8b4 / v24 / 0014).

## Tuotteen ydinsääntö

Manifestivalin ensisijainen tehtävä on VÄHENTÄÄ asioita, jotka käyttäjän on
pidettävä aktiivisesti mielessä. Se ei onnistu sillä, että se aikatauluttaa
enemmän työtä.

Lukittu ketju:

    Brain Dump → elämänalueet → asian luonne → kapasiteettijarru
    → prioriteetti / aktiivinen joukko → Rauhallinen tänään
    → suojattu oma aika / vapaa-aika / loma → sunnuntain nollaus
    → todellisuus / ajautuminen → katsaus ja säätö

Psykologinen sääntö: **"Kaikki muu on tallessa. Sinun ei tarvitse hoitaa sitä tänään."**

## Omistajan lukitsemat päätökset (2026-09-27)

1. `life_areas.kind` ∈ STANDARD, WELLBEING, ENJOYMENT, OWN_TIME, FREE_TIME,
   VACATION. Asian luonne on ERI akseli ja se JOHDETAAN:
   OBLIGATION, GOAL_ACTION, MAINTENANCE, WELLBEING, ENJOYMENT, FREE_TIME.
   Luonnetta ei tallenneta (ei ohitussaraketta ennen kuin tarve on todettu).
2. Päivätön tehtävä on sallittu. Horisontit NOW, THIS_WEEK, LATER, NOT_YET,
   WAITING, ARCHIVED. Keksittyä päivää ei pakoteta.
3. WAITING = asia odottaa toista ihmistä tai tahoa. `waiting_on` on vapaa
   teksti; valinnainen `follow_up_date`. Odottava ei kuluta kapasiteettia.
   Ei yhteystietojärjestelmää.
4. Suojattu vapaa-aika: viikon vähimmäistunnit, suojatut illat, sunnuntai
   pääosin vapaa, ei velvoitteita valitun kellonajan jälkeen — KAIKKI yhden
   `protected_periods`-arkkitehtuurin kautta.
5. Loma: kiinteät menot pysyvät näkyvissä (ei poisteta koskaan hiljaa);
   joustava työ, jono, tavallinen projektityö ja ei-välttämättömät velvoitteet
   eivät sijoitu lomalle automaattisesti.
6. Rauhallinen tänään: enintään 3 AKTIIVISTA FOKUSTA. Hyvinvointi voi viedä
   paikan vain, kun se on oikeasti valittu päivän prioriteetiksi. Rutiini-
   muistutukset (vesi, ateriat, lisäravinteet, venyttely) eivät vie paikkaa.

## Yksi laskenta: `src/domain/lifeLoad.js`

`computeLifeLoad(input)` on AINOA priorisointi- ja kuormamoottori. Tänään,
avustajan NYT/SEURAAVA, suunnittelija, katsaus ja ilmoitukset käyttävät sen
tulosta (tai sen apufunktioita `isSchedulable`, `horizonOf`).

Syöte: tasks, routines, events, bills, lifeAreas, goals, projects,
protectedPeriods, capacity (päivä + viikko), energy, weeklyPlan, todayIso,
nowMinutes, options { nowLimit = 3 }.

Tulos (jäädytetty):

    now[]        ≤ 3 fokusta { kind, item, nature, horizon, reasons[], minutes }
    thisWeek[]   tämän viikon aktiivinen joukko (kapasiteetin sisällä)
    later[]      myöhemmin (päivätty ensi viikolle tai myöhemmäksi, tai ilman päivää)
    notYet[]     ei vielä (käyttäjän valinta tai keskeytetty tavoite)
    waiting[]    odottaa jotakuta (ei kuluta kapasiteettia)
    archived[]   poistettu näkyvistä (archived_at)
    fixedToday[] kiinteät ajastetut tehtävät tänään (EIVÄT fokusta)
    overflow[]   olisi ollut NOW/THIS_WEEK mutta ei mahdu kapasiteettiin
    activeCount, storedCount, explanation

Säännöt:
- Myöhässä ≠ automaattisesti NOW. Myöhässä oleva kilpailee pisteillä; jos se
  ei mahdu, se on THIS_WEEK/overflow ja Tänään sanoo sen rauhallisesti.
- NOW-joukon kesto ≤ tämän päivän jäljellä oleva joustava kapasiteetti
  (vähintään yksi asia, jos jokin mahtuu ylipäätään).
- Laskut ja todelliset velvoitteet (luonne OBLIGATION) saavat kilpailla
  fokuksesta. Laskun ja siihen liitetyn tehtävän kaksoisesiintyminen estetään.
- Rutiinit eivät koskaan ole fokusta.
- Keskeytetyn/arkistoidun tavoitteen tehtävät → NOT_YET (paitsi kiinteät).
- Odottava, jonka `follow_up_date` on tullut → THIS_WEEK ("Tarkista tilanne").

## Kapasiteettijarru

Ennen yhtäkään joustavaa sijoitusta päivästä varataan järjestyksessä:
uni → kiinteät menot ja kiinteät tehtävät → matka/valmistautuminen →
suojattu oma aika → suojattu vapaa-aika → loma → käyttäjän puskuri
(`planningBufferRatio`, oletus 0,25) → [unen vaje, jos `sleepAffectsCapacity`].
Joustava työ saa vain jäännöksen. Mikä ei mahdu, siirtyy (defer) — Tänään-
listaa ei kasvateta. Siirto ja uudelleensuunnittelu tarkistavat kohdepäivän
kapasiteetin. Suojattua aikaa ei koskaan oteta automaattisesti.

Toteutus: suojatut jaksot muunnetaan KALENTERILOHKOIKSI (`BLOCK_KIND.OWN_TIME`,
`FREE_TIME`, `VACATION`) samassa paikassa kuin matka- ja unilohkot
(`src/app/calendarPlan.js`). Näin aikajana, vapaat välit, törmäykset,
kapasiteetti, horisonttiaikatauluttaja ja päivän uudelleensuunnittelu
kunnioittavat niitä ilman erillistä logiikkaa. Viikon vähimmäisvapaa-aika
varataan viikon joustavasta kapasiteetista (`src/domain/protectedTime.js`).

## Migraatio 0015 (`supabase/migrations/0015_mental_load.sql`)

Riippuu 0014:stä. Yksi transaktio, `lock_timeout = '5s'`, objektilaskuri
osittaisen ajon tunnistukseen, täysi RLS (4 politiikkaa / taulu,
`to authenticated`), ei anon-oikeuksia, `owner_row_key (user_id, id)`.

life_areas (0012):
- `kind text not null default 'STANDARD'`, CHECK kuusi arvoa
- POISTETAAN `life_areas_category_unique` (useampi alue saa jakaa kategorian);
  tilalle ei-uniikki indeksi `life_areas_user_category_idx (user_id, category_key)`.
  Kategoriaperinnässä voittaa aktiivinen, pienin `sort_order`, sitten nimi.

tasks (tuotannossa auki):
- `horizon text` NULL, CHECK in ('NOW','THIS_WEEK','LATER','NOT_YET','WAITING')
  (NULL = johdetaan päivästä; NOW = käyttäjän valitsema fokus tälle päivälle)
- `waiting_on text` NULL, pituus 1–200
- `follow_up_date date` NULL
- `archived_at timestamptz` NULL
- `reschedule_count integer not null default 0` CHECK ≥ 0 ja ≤ 10000
- `original_date date` NULL (ensimmäinen suunniteltu päivä ennen siirtoja)
- `date` DROP NOT NULL (idempotentti; päivätön tehtävä)
- CHECK: `horizon = 'WAITING'` tai `waiting_on is null`

protected_periods (uusi):
- id text pk, user_id uuid default auth.uid() → auth.users on delete cascade
- kind in ('OWN_TIME','FREE_TIME','VACATION')
- recurrence in ('once','weekly','weekly_target')
- title text NULL (≤ 60), note text NULL (≤ 500)
- start_date, end_date date NULL; weekdays smallint[] NULL (1–7)
- start_time, end_time time NULL (NULL = koko päivä / nukkumaanmenoon asti)
- target_minutes integer NULL (weekly_target: 0–10080)
- strength in ('firm','soft') default 'firm'
- active boolean default true, created_at, updated_at (+ liipaisin)
- CHECKit: once → start_date not null, end_date ≥ start_date, weekdays null;
  weekly → weekdays ei tyhjä; weekly_target → kind FREE_TIME, target_minutes
  not null, ajat ja viikonpäivät null; VACATION → recurrence once ja ajat null;
  start_time < end_time kun molemmat annettu.

weekly_plans (uusi):
- id text pk, user_id, week_start date not null (ISO-maanantai, CHECK isodow = 1)
- unique (user_id, week_start)
- priorities jsonb not null default '[]' (taulukko, ≤ 5 alkiota; UI rajaa 3)
- planned_minutes integer NULL (suunnitelma viikon sulkemishetkellä; CAPACITY_BIAS)
- closed_at timestamptz NULL (viikko suljettu = suunniteltu)
- note text NULL (≤ 1000), created_at, updated_at (+ liipaisin)

Portit (`src/data/schema.js`):
- TABLES.protectedPeriods, TABLES.weeklyPlans (0015)
- sarakeportti `MENTAL_LOAD_FIELDS` (tasks-sarakkeet + life_areas.kind)
Aalto L: v25, migraatio 0015, riski medium (ALTER tasks), varmuuskopio pakollinen,
verifyPrerequisite 0014.

Kun portti on kiinni, horisontti, odotus, arkistointi, suojatut jaksot ja
viikkosuunnitelma elävät istunnon muistissa ja käyttöliittymä kertoo sen.
Päivätön tehtävä sallitaan vain, kun `MENTAL_LOAD_FIELDS` on auki (muuten
kanta voi vaatia päivän).

## Juna ja lukko

`MENTAL_LOAD_FIELDS` avautuu aallossa L. Lukitut C–K-tietueet eivät sisällä
tätä porttia: train-map vertaa lukkoon vain tietueessa olevat sarakeportit ja
vaatii, että tietueesta puuttuvat (myöhemmin avautuvat) portit ovat
ehdokkaassa kiinni. C–K-tietueet pysyvät tavu tavulta ennallaan.

## Käyttöliittymä

- Tänään: fokus (≤ 3) ylhäällä, "Kaikki muu on tallessa (N)." + rauhoittava
  lause, kiinteät menot, suojattu aika tänään, loman tila, aikakriittiset
  muistutukset. Rajatut osiot. Ei koko jonoa.
- Tallessa (Tekeminen → Tallessa): Tämä viikko / Myöhemmin / Ei vielä /
  Odottaa / Arkisto.
- Brain Dump: monirivinen kirjaus → monta saapuvaa riviä, ei päätöksiä
  kirjaushetkellä; erä-käsittely (alue, luonne, horisontti) myöhemmin.
- Suojattu aika: Profiili → Suojattu aika (oma aika, vapaa-ajan säännöt, loma).
- Sunnuntain nollaus: A kirjaa → B luokittele → C kapasiteetti → D enintään 3
  prioriteettia → E sijoita välttämätön → F suojaa oma/vapaa-aika → G sulje.
  Loppuviesti: "Ensi viikko on suunniteltu. Sinun ei tarvitse miettiä sitä
  enää tänään."

## Ajautuminen v2

Säilyy: OVERLOAD, NEGLECT, MISALIGNMENT, TARGET_TENSION, ENERGY_OVERLOAD.
Uudet deterministiset: BACKLOG_GROWTH, CAPACITY_BIAS, OWN_TIME_EROSION,
FREE_TIME_EROSION, VACATION_INTRUSION, PLAN_CHURN. Ei syyllistävää kieltä;
vastaus on seuraavan suunnitelman säätö.

## Sunnuntain nollaus (toteutus)

`src/app/views/sundayReset.js`, dialogi `#sundayResetDialog` (Tänään-osion
ulkopuolella). Avataan Suunnan painikkeesta `#dirSundayResetBtn` tai
Tänään-kortista (`renderSundayResetEntry`, painike `#sundayResetOpenBtn`).

Kohdeviikko: seuraava ISO-viikko (ma–su) nollauspäivästä. Maanantaina ennen
klo 12 suunnitellaan kuluva viikko (sunnuntain nollaus on voinut jäädä väliin).
Kortti näkyy la/su ja maanantaiaamuna, kun kohdeviikon `weekly_plans`-riviä ei
ole suljettu; muina päivinä ei (kortti ei saa olla pysyvä muistutus).

- A `captureBrainDump`: monirivinen kirjaus saapuviin, ei päätöksiä.
- B saapuvien luku ja enintään viisi riviä; "Järjestä saapuvat" vie
  Tekeminen → Saapuvat (ei toista käsittelynäkymää), "Palaa nollaukseen"
  (`#sundayResetResume`) tuo takaisin.
- C `brakedHorizonCapacity` kohdeviikolle ilman sijoitettavia ehdokkaita
  (sama luku kuin E:n sijoittelulla); erittely laskee yhteen (valveilla −
  varattu − suojattu − puskuri − unen vaje − vähimmäisvapaa-aika − lyhyet
  välit). Käyttäjän luku tallentuu `saveWeeklyCapacity`:llä; pienempi luku
  rajaa uudet sijoitukset, suurempi ei ylitä laskettua päiväkapasiteettia.
- D enintään kolme prioriteettia rajatuista ehdokkaista (kohdeviikolla
  erääntyvät/päivätyt, aktiiviset tavoitteet, alueet; 3 / ryhmä) tai oma
  teksti; `saveWeeklyPlan`.
- E ehdokkaat: kohdeviikolle päivätyt, päivättömät "tällä viikolla",
  prioriteetteihin liittyvät ja viikon loppuun mennessä erääntyvät (ei koko
  jonoa). Jo päivätty pysyy päivällään, jos tilaa on; sitten prioriteetit ja
  määräajat, sitten loput (`planHorizon` kahdessa erässä, jälkimmäinen saa vain
  jäännöksen). Mikä ei mahdu, ei muutu. "Hyväksy" = `editTask` vain päivälle
  (siirtojen seuranta tulee editTaskista).
- F kohdeviikon suojattu aika (`describePeriod` + minuutit), lomapäivät,
  vähimmäisvapaa-ajan tila ja kiinteät menot (enintään 5); pikatoiminnot
  "Lisää vapaa ilta" (`saveFreeTimeRules`, olemassa olevat säännöt säilyvät) ja
  "Lisää oma aika" (OWN_TIME weekly kohdeviikosta alkaen, 1 h).
- G `closeWeek(weekStart, { priorities, plannedMinutes })`, jossa
  `plannedMinutes` = kohdeviikon keskeneräisten, näkyvien tehtävien kestot
  sulkemishetkellä. Loppuviesti täsmälleen: "Ensi viikko on suunniteltu." /
  "Sinun ei tarvitse miettiä sitä enää tänään." ja yksi "Valmis".

Jokainen vaihe (A–F) on ohitettavissa; Escape sulkee ja eteneminen säilyy
muistissa. Kun `weekly_plans` tai `protected_periods` ei ole pysyvä (portti
kiinni), dialogi kertoo kerran, että ne säilyvät vain istunnon ajan.
