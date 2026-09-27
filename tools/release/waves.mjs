// Aktivoinnin julkaisujuna 0003–0008: aaltojen kanoninen määrittely.
//
// MITÄ TÄMÄ ON
//
// Kymmenen porttia avataan tuotantoon viidessä aallossa. Tämä moduuli
// on se yksi paikka, jossa aallot on määritelty: mitkä portit kuuluvat
// mihinkin aaltoon, mikä välimuistiversio kuuluu mihinkin aaltoon ja
// mihin kukin aalto perutaan.
//
// MIKSI OMANA MODUULINAAN EIKÄ src/-puussa
//
// Tämä on JULKAISUTYÖKALU, ei sovelluskoodi. Selaimeen menevä koodi ei
// saa tietää aalloista mitään: portit ovat käännösaikaisia vakioita
// `src/data/schema.js`:ssä, ja juuri se on niiden arvokkain
// ominaisuus — deployattu commit on determinististä tilaa, jota ei voi
// muuttaa ajon aikana eikä käyttäjäkohtaisesti.
//
// Siksi tämä moduuli EI ole `src/`-puussa eikä sitä importoida sieltä.
// Sen käyttäjät ovat testit ja skriptit.
//
// KOLME RIIPPUMATONTA LÄHDETTÄ
//
// Aallon tila todennetaan kolmesta toisistaan riippumattomasta
// tiedostosta, jotka jokainen aaltocommit muuttaa yhdessä:
//
//   1. src/data/schema.js          mitä sovellus oikeasti tekee
//   2. sw.js                       välimuistiversio
//   3. docs/PRODUCTION-STATUS.md   mitä väitämme tehneemme
//
// Yksikään ei yksin riitä. Jos tarkistus lukisi vain schema.js:ää ja
// vertaisi sitä schema.js:stä johdettuun odotukseen, se olisi kehä
// eikä todistaisi mitään. Kolmen lähteen on oltava keskenään
// yhtäpitäviä, ja väärennös vaatisi kaikkien kolmen muuttamista
// johdonmukaisesti — eli täsmälleen sen mitä kelvollinen aaltocommit
// tekee.

/** Kaikki portit siinä järjestyksessä kuin ne ovat schema.js:ssä. */
export const ALL_GATES = Object.freeze([
  'routines', 'routineExceptions',
  'goals', 'projects',
  'notificationPreferences',
  'wellbeing',
  'bills', 'recurringExpenses', 'savingsGoals',
  'aiAudit',
  'transactions', 'investments',
  'milestones',
  'inboxItems', 'reminders', 'notices', 'travelPlans', 'locationRules',
  'lifeAreas', 'weeklyCapacities', 'timeEntries', 'alignmentReviews',
  'runningTimers', 'alignmentItemSettings',
  'savedPlaces', 'placeAliases', 'calendarEvents', 'commuteObservations', 'lifeSettings',
  'sleepLogs', 'habitPlans', 'habitEvents', 'exerciseSessions', 'wellbeingCheckins',
  'protectedPeriods', 'weeklyPlans'
]);

/**
 * HISTORIALLINEN tuotantotila: se julkaisu, joka oli tuotannossa kun
 * perustilan korjaus ja aallot A–E suunniteltiin.
 *
 * Kaikki kymmenen porttia kiinni. Tämä on se, mihin perustilan korjaus
 * deployataan — ja se on korjauksen peruutuskohde, ei aaltojen.
 *
 * TÄMÄ EI OLE TUOTANNON NYKYTILA (ACT-09). Tuotannon nykytila luetaan
 * ajon aikana gitistä: `originMainState()` (tools/release/lineage.mjs).
 * Nimi `PRODUCTION` säilyy, koska manifesti ja sen testit viittaavat
 * siihen; uusi koodi käyttää nimeä `HISTORICAL_BASE_PRODUCTION`.
 */
export const PRODUCTION = Object.freeze({
  sha: '63a96c5ab90b10a73369cd66e348f4a3774367e2',
  cacheVersion: 'v12'
});

/** Sama kuin `PRODUCTION`, nimellä joka ei väitä olevansa nykytila. */
export const HISTORICAL_BASE_PRODUCTION = PRODUCTION;

/**
 * Perustila: KORJATTU pohja, jolta juna lähtee.
 *
 * Tämä ei ole sama kuin tuotannossa juuri nyt oleva commit. Tuotannon
 * `63a96c5` sisältää kolme käyttäjän löytämää vikaa:
 *
 *   1. kesto 01:00-02:00 näkyi lomakkeessa kolmenakymmenenä
 *   2. hyvinvointiosio oli otsikon "Miten menee?" takana, eikä sanaa
 *      hyvinvointi esiintynyt käyttöliittymässä lainkaan
 *   3. AI-kirjausketjulla ei ollut kirjoituspolkua
 *
 * Perustilan korjaus deployataan ENSIN, kaikki kymmenen porttia yhä
 * kiinni. Vasta sen jälkeen aallot. Näin porttien avaaminen ei sekoitu
 * korjausten todentamiseen.
 *
 * `sha` on null: tämä tiedosto on osa sitä committia, joten se ei voi
 * sisältää omaa tunnistettaan. Manifesti löytää sen
 * `Release-Wave: BASE` -merkinnästä.
 */
export const BASE = Object.freeze({
  id: 'BASE',
  sha: null,
  cacheVersion: 'v13',
  gates: Object.freeze([])
});

/**
 * Aallot järjestyksessä.
 *
 * JÄRJESTYS ON JOHDETTU VIERASAVAINRIIPPUVUUKSISTA, ei
 * migraationumeroista. `tests/activation-gates.test.mjs` lukee
 * riippuvuudet migraatioista ja kaatuu, jos tämä järjestys rikkoo
 * yhtäkään niistä.
 *
 * `gates` on se joukko, joka avataan TÄSSÄ aallossa. Aiempien aaltojen
 * portit pysyvät auki — kumulatiivinen joukko lasketaan
 * `cumulativeGates()`-funktiolla.
 */
export const WAVES = Object.freeze([
  Object.freeze({
    id: 'A',
    cacheVersion: 'v14',
    // Aktivoinnin metatiedot (ACT-12): ks. "AKTIVOINNIN METATIEDOT" alla.
    migration: null,
    migrationFile: null,
    risk: 'low',
    ownerGates: Object.freeze(['OWNER_DEPLOY_APPROVAL_REQUIRED']),
    backupRequired: false,
    verifyPrerequisite: null,
    readiness: 'READY',
    gates: Object.freeze(['notificationPreferences', 'wellbeing']),
    title: 'Muistutusasetukset ja hyvinvointi',
    rationale:
      'Ei viittauksia mihinkään. Pienin pinta-ala. notification_preferences '
      + 'on lisäksi eri omistajuusmalli (pääavain on omistaja), joten se on '
      + 'syytä todentaa yksin.',
    tables: Object.freeze(['notification_preferences', 'wellbeing_entries'])
  }),
  Object.freeze({
    id: 'B',
    cacheVersion: 'v15',
    // Aktivoinnin metatiedot (ACT-12): ks. "AKTIVOINNIN METATIEDOT" alla.
    migration: null,
    migrationFile: null,
    risk: 'low',
    ownerGates: Object.freeze(['OWNER_DEPLOY_APPROVAL_REQUIRED']),
    backupRequired: false,
    verifyPrerequisite: null,
    readiness: 'READY',
    gates: Object.freeze(['goals', 'projects']),
    title: 'Tavoitteet ja projektit',
    rationale:
      'Viittaavat toisiinsa mutta eivät mihinkään ulkopuoliseen. Ovat '
      + 'viittauskohteita aalloille C ja D, joten ne on avattava ennen niitä.',
    tables: Object.freeze(['goals', 'projects'])
  }),
  Object.freeze({
    id: 'C',
    cacheVersion: 'v16',
    // Aktivoinnin metatiedot (ACT-12): ks. "AKTIVOINNIN METATIEDOT" alla.
    migration: null,
    migrationFile: null,
    risk: 'low',
    ownerGates: Object.freeze(['OWNER_DEPLOY_APPROVAL_REQUIRED']),
    backupRequired: false,
    verifyPrerequisite: null,
    readiness: 'READY',
    gates: Object.freeze(['routines', 'routineExceptions']),
    title: 'Rutiinit ja poikkeukset',
    rationale:
      'routines.goal_id viittaa goals-tauluun, joten B on oltava ensin. '
      + 'Poikkeus viittaa rutiiniin, joten ne kuuluvat samaan aaltoon.',
    tables: Object.freeze(['routines', 'routine_exceptions'])
  }),
  Object.freeze({
    id: 'D',
    cacheVersion: 'v17',
    // Aktivoinnin metatiedot (ACT-12): ks. "AKTIVOINNIN METATIEDOT" alla.
    migration: null,
    migrationFile: null,
    risk: 'low',
    ownerGates: Object.freeze(['OWNER_DEPLOY_APPROVAL_REQUIRED']),
    backupRequired: false,
    verifyPrerequisite: null,
    readiness: 'READY',
    gates: Object.freeze(['recurringExpenses', 'savingsGoals', 'bills']),
    title: 'Talous',
    rationale:
      'bills.recurring_expense_id viittaa recurring_expenses-tauluun ja '
      + 'bills.task_id tasks-tauluun. Toistuvat kulut on siksi avattava '
      + 'viimeistään samassa aallossa kuin laskut.',
    tables: Object.freeze(['recurring_expenses', 'savings_goals', 'bills'])
  }),
  Object.freeze({
    id: 'E',
    cacheVersion: 'v18',
    // Aktivoinnin metatiedot (ACT-12): ks. "AKTIVOINNIN METATIEDOT" alla.
    migration: null,
    migrationFile: null,
    risk: 'low',
    ownerGates: Object.freeze(['OWNER_DEPLOY_APPROVAL_REQUIRED']),
    backupRequired: false,
    verifyPrerequisite: null,
    readiness: 'READY',
    gates: Object.freeze(['aiAudit']),
    title: 'AI-toimintojen kirjausketju',
    rationale:
      'Ei vierasavaimia. Viimeisenä, koska se kirjaa muiden toimintaa — '
      + 'sen kannattaa olla käytössä vasta kun kirjattavaa on.',
    tables: Object.freeze(['ai_action_audit'])
  }),
  Object.freeze({
    id: 'F',
    cacheVersion: 'v19',
    // Aktivoinnin metatiedot (ACT-12): ks. "AKTIVOINNIN METATIEDOT" alla.
    migration: '0009',
    migrationFile: 'supabase/migrations/0009_finance_2.sql',
    risk: 'low',
    ownerGates: Object.freeze(['OWNER_PRODUCTION_MIGRATION_APPROVAL_REQUIRED', 'OWNER_DEPLOY_APPROVAL_REQUIRED']),
    backupRequired: false,
    verifyPrerequisite: null,

    // READY KOSKEE KÄYTTÖLIITTYMÄÄ, `blockedBy` KANTAA.
    //
    // Nämä ovat kaksi eri asiaa, ja niiden sekoittaminen olisi ollut
    // helppoa: `readiness` JOHDETAAN käyttöliittymän
    // tavoitettavuudesta (`tests/ui-reachability.test.mjs`), eikä sitä
    // voi kirjoittaa käsin. Talous 2.0:n näkymät ovat olemassa, joten
    // se on READY siinä merkityksessä.
    //
    // Aallon este on toisaalla eikä se näy tavoitettavuudessa
    // lainkaan: migraatiota 0009 EI OLE AJETTU tuotantoon, eikä
    // porttia voi avata tauluun jota ei ole.
    //
    // Deployattavuus on siksi molempien ehtojen konjunktio. Ks.
    // `isDeployable()`.
    readiness: 'READY',
    // Este poistettu aaltocommitissa: 0009_finance_2.sql on tämän commitin
    // EDELLYTYS. Deploy vasta kun verify_0009.sql = 0 poikkeavaa.
    blockedBy: null,
    gates: Object.freeze(['transactions', 'investments']),
    title: 'Talous 2.0: tapahtumat ja sijoitukset',
    rationale:
      'Kumpikaan taulu ei viittaa mihinkään sovellustauluun, joten '
      + 'riippuvuusjärjestys ei pakota tätä mihinkään kohtaan. Viimeisenä '
      + 'siksi, että se on ainoa aalto, jonka migraatiota ei ole ajettu — '
      + 'ja aalto jonka kanta puuttuu ei saa olla minkään toisen edellä.',
    tables: Object.freeze(['transactions', 'investments'])
  }),
  Object.freeze({
    id: 'G',
    cacheVersion: 'v20',
    // Aktivoinnin metatiedot (ACT-12): ks. "AKTIVOINNIN METATIEDOT" alla.
    migration: '0010',
    migrationFile: 'supabase/migrations/0010_goal_to_action.sql',
    risk: 'high',
    ownerGates: Object.freeze(['OWNER_PRODUCTION_MIGRATION_APPROVAL_REQUIRED', 'OWNER_DEPLOY_APPROVAL_REQUIRED']),
    backupRequired: true,
    verifyPrerequisite: null,

    // READY koskee käyttöliittymää, `blockedBy` kantaa. Ks. aalto F.
    readiness: 'READY',
    // Este poistettu aaltocommitissa: 0010_goal_to_action.sql on tämän commitin
    // EDELLYTYS. Deploy vasta kun verify_0010.sql = 0 poikkeavaa.
    blockedBy: null,
    gates: Object.freeze(['milestones']),
    title: 'Tavoitteesta tekemiseksi: välitavoitteet',
    rationale:
      'Välitavoite viittaa tavoitteeseen yhdistelmävierasavaimella, joten '
      + 'aallon B (goals) on oltava ensin — ja se on tuotannossa. '
      + 'MIGRAATIO 0010 ON VAARALLISEMPI KUIN AIEMMAT: se ei vain luo uutta '
      + 'taulua vaan MUUTTAA goals-, tasks- ja projects-tauluja, joissa on '
      + 'käyttäjän oikeaa dataa ja joiden portit ovat auki tuotannossa.',
    tables: Object.freeze(['milestones'])
  }),
  Object.freeze({
    id: 'H',
    cacheVersion: 'v21',
    // Aktivoinnin metatiedot (ACT-12): ks. "AKTIVOINNIN METATIEDOT" alla.
    migration: '0011',
    migrationFile: 'supabase/migrations/0011_personal_assistant.sql',
    risk: 'low',
    ownerGates: Object.freeze(['OWNER_PRODUCTION_MIGRATION_APPROVAL_REQUIRED', 'OWNER_DEPLOY_APPROVAL_REQUIRED']),
    backupRequired: false,
    verifyPrerequisite: null,

    // READY koskee käyttöliittymää, `blockedBy` kantaa. Ks. aalto F.
    //
    // Aalto oli hetken ESTETTY MOLEMMISTA SYISTÄ: migraatio oli
    // ajamatta JA näkymät rakentamatta. Näkymät on nyt rakennettu, ja
    // valmiustila muuttui samassa committissa kuin tavoitettavuusmatriisi.
    //
    // Valmiustilaa ei kirjoiteta käsin — `tests/ui-reachability.test.mjs`
    // johtaa sen matriisista ja kaataa tämän, jos arvo ei vastaa.
    //
    // `blockedBy` on yhä voimassa: käyttöliittymä on olemassa, kantaa ei.
    readiness: 'READY',
    // Este poistettu aaltocommitissa: 0011_personal_assistant.sql on tämän commitin
    // EDELLYTYS. Deploy vasta kun verify_0011.sql = 0 poikkeavaa.
    blockedBy: null,
    gates: Object.freeze(['inboxItems', 'reminders', 'notices',
                          'travelPlans', 'locationRules']),
    title: 'Henkilökohtainen avustaja: kirjaus, muistutukset ja matka',
    rationale:
      'Viisi uutta taulua, jotka eivät muuta yhtäkään olemassa olevaa. '
      + 'travel_plans ja location_rules viittaavat tasks-tauluun '
      + 'yhdistelmävierasavaimella, ja tasks on tuotannossa. '
      + 'Muut kolme eivät viittaa mihinkään sovellustauluun: muistutuksen '
      + 'ja ilmoituksen kohdetunniste EI OLE vierasavain, koska kohde saa '
      + 'kadota ilman että tietue muistuttamisen aikeesta katoaa. '
      + 'Aalto on siksi riippumaton A–G:stä ja voi tulla vasta viimeisenä '
      + 'ilman että mikään pakottaa siihen.',
    tables: Object.freeze(['inbox_items', 'reminders', 'notices',
                           'travel_plans', 'location_rules'])
  }),
  Object.freeze({
    id: 'I',
    cacheVersion: 'v22',
    // Aktivoinnin metatiedot (ACT-12): ks. "AKTIVOINNIN METATIEDOT" alla.
    migration: '0012',
    migrationFile: 'supabase/migrations/0012_life_alignment.sql',
    risk: 'medium',
    ownerGates: Object.freeze(['OWNER_PRODUCTION_MIGRATION_APPROVAL_REQUIRED', 'OWNER_DEPLOY_APPROVAL_REQUIRED']),
    backupRequired: false,
    verifyPrerequisite: null,

    // READY koskee käyttöliittymää, `blockedBy` kantaa. Ks. aalto F.
    readiness: 'READY',
    // Este poistettu aaltocommitissa: 0012_life_alignment.sql on tämän commitin
    // EDELLYTYS. Deploy vasta kun verify_0012.sql = 0 poikkeavaa.
    blockedBy: null,
    gates: Object.freeze(['lifeAreas', 'weeklyCapacities', 'timeEntries', 'alignmentReviews']),
    title: 'Suunta: elämänalueet, kapasiteetti, toteuma ja viikkokatsaus',
    rationale:
      'Neljä uutta taulua ja yksi nullable sarake goals-tauluun (life_area_id). '
      + 'goals.life_area_id ja time_entries viittaavat goals- ja tasks-tauluihin '
      + 'yhdistelmävierasavaimella, joten aallon B (goals) on oltava tuotannossa. '
      + 'Havaintoja (kuormitus, huomiotta jääminen, poikkeama) ei tallenneta: '
      + 'ne lasketaan, joten aalto ei tuo johdettua dataa kantaan. '
      + 'Riippumaton aalloista F–H: 0012 ei vaadi 0009–0011:tä.',
    tables: Object.freeze(['life_areas', 'weekly_capacities', 'time_entries', 'alignment_reviews'])
  }),
  Object.freeze({
    id: 'J',
    cacheVersion: 'v23',
    // Aktivoinnin metatiedot (ACT-12): ks. "AKTIVOINNIN METATIEDOT" alla.
    migration: '0013',
    migrationFile: 'supabase/migrations/0013_alignment_reality.sql',
    risk: 'low',
    ownerGates: Object.freeze(['OWNER_PRODUCTION_MIGRATION_APPROVAL_REQUIRED', 'OWNER_DEPLOY_APPROVAL_REQUIRED', 'PHONE_ACCEPTANCE_REQUIRED']),
    backupRequired: false,
    verifyPrerequisite: '0012',

    // READY koskee käyttöliittymää, `blockedBy` kantaa. Ks. aalto F.
    readiness: 'READY',
    // Este poistettu aaltocommitissa: 0013_alignment_reality.sql on tämän commitin
    // EDELLYTYS. Deploy vasta kun verify_0013.sql = 0 poikkeavaa.
    blockedBy: null,
    gates: Object.freeze(['runningTimers', 'alignmentItemSettings']),
    title: 'Suunta 2: ajastin, kuormittavuus ja toteuman lähteet',
    rationale:
      'Kaksi uutta taulua (running_timers, alignment_item_settings) ja '
      + 'sarakkeita aallon I tauluihin (time_entries, weekly_capacities, '
      + 'alignment_reviews). Riippuu aallosta I: 0013 muuttaa 0012:n tauluja '
      + 'ja viittaa life_areas-tauluun. Yhtäkään tuotannossa auki olevaa '
      + 'taulua (tasks, goals, projects, routines) ei muuteta; niihin '
      + 'viitataan vain yhdistelmävierasavaimilla. Siksi oma aalto: I voi '
      + 'mennä tuotantoon ilman J:tä, mutta ei päinvastoin.',
    tables: Object.freeze(['running_timers', 'alignment_item_settings'])
  }),
  Object.freeze({
    id: 'K',
    cacheVersion: 'v24',
    // Aktivoinnin metatiedot (ACT-12): ks. "AKTIVOINNIN METATIEDOT" alla.
    migration: '0014',
    migrationFile: 'supabase/migrations/0014_daily_life.sql',
    // MATALA: vain uusia tyhjiä tauluja, ei yhtään olemassa olevan datan
    // uudelleenkirjoitusta eikä ALTER TABLEa olemassa olevaan tauluun.
    risk: 'low',
    ownerGates: Object.freeze(['OWNER_PRODUCTION_MIGRATION_APPROVAL_REQUIRED', 'OWNER_DEPLOY_APPROVAL_REQUIRED']),
    // Ei pakollista varmuuskopiota: migraatio ei kirjoita yhteenkään
    // olemassa olevaan riviin, ja peruutus on taulujen pudotus.
    backupRequired: false,
    verifyPrerequisite: '0013',

    // Näkymät on rakennettu (Kalenteri, Profiili -> Arki / Hyvinvointi /
    // Paikat, Tänään-kortit), joten aalto on estetty enää vain kannan
    // takia: migraatiota 0014 ei ole ajettu. Valmiustila JOHDETAAN
    // tavoitettavuudesta (tests/ui-reachability.test.mjs).
    readiness: 'READY',
    // Este poistettu aaltocommitissa: 0014_daily_life.sql on tämän commitin
    // EDELLYTYS. Deploy vasta kun verify_0014.sql = 0 poikkeavaa.
    blockedBy: null,
    gates: Object.freeze(['savedPlaces', 'placeAliases', 'calendarEvents', 'commuteObservations',
                          'lifeSettings', 'sleepLogs', 'habitPlans', 'habitEvents',
                          'exerciseSessions', 'wellbeingCheckins']),
    title: 'Arjen käyttöjärjestelmä: kalenteri, paikat, uni, herätys, tavat ja liikunta',
    rationale:
      'Kymmenen uutta taulua (0014) eikä yhtään muutosta olemassa olevaan '
      + 'tauluun tai sarakeporttia. calendar_events ja exercise_sessions '
      + 'viittaavat goals-tauluun yhdistelmävierasavaimella (aalto B on '
      + 'tuotannossa); muut viitteet ovat aallon omien taulujen välisiä. '
      + 'Viimeisenä, koska 0014 edellyttää 0013:n (verify_0013 = 0 '
      + 'poikkeavaa): juna etenee järjestyksessä. Riski on matala — vain '
      + 'uusia tyhjiä tauluja, joten tuore varmuuskopio ei ole pakollinen.',
    tables: Object.freeze(['saved_places', 'place_aliases', 'calendar_events', 'commute_observations',
                           'life_settings', 'sleep_logs', 'habit_plans', 'habit_events',
                           'exercise_sessions', 'wellbeing_checkins'])
  }),
  Object.freeze({
    id: 'L',
    cacheVersion: 'v25',
    // Aktivoinnin metatiedot (ACT-12): ks. "AKTIVOINNIN METATIEDOT" alla.
    migration: '0015',
    migrationFile: 'supabase/migrations/0015_mental_load.sql',
    // KESKI: 0015 muuttaa tuotannossa auki olevaa tasks-taulua (ALTER
    // TABLE, ACCESS EXCLUSIVE -lukko, uudet CHECK-rajoitteet) ja poistaa
    // life_areas-taulun kategorian uniikkiuden. Ei uudelleenkirjoitusta.
    risk: 'medium',
    ownerGates: Object.freeze(['OWNER_PRODUCTION_MIGRATION_APPROVAL_REQUIRED', 'OWNER_DEPLOY_APPROVAL_REQUIRED']),
    // PAKOLLINEN varmuuskopio: tasks on käyttäjän dataa, ja peruutus
    // pudottaa sarakkeita (docs/MIGRATION-0015-RECOVERY.md).
    backupRequired: true,
    verifyPrerequisite: '0014',

    // READY koskee käyttöliittymää, `blockedBy` kantaa. Ks. aalto F.
    readiness: 'READY',
    // Este poistettu aaltocommitissa: 0015_mental_load.sql on tämän commitin
    // EDELLYTYS. Deploy vasta kun verify_0015.sql = 0 poikkeavaa.
    blockedBy: null,
    gates: Object.freeze(['protectedPeriods', 'weeklyPlans']),
    title: 'Mielen kuorman keventäminen: horisontit, odotus, suojattu aika ja sunnuntain nollaus',
    rationale:
      'Kaksi uutta taulua (protected_periods, weekly_plans) ja sarakeportti '
      + 'MENTAL_LOAD_FIELDS: tasks-taulun horisontti, odotus, arkistointi ja '
      + 'siirtojen seuranta sekä life_areas.kind. Uudet taulut eivät viittaa '
      + 'yhteenkään sovellustauluun. Viimeisenä, koska 0015 edellyttää 0014:n '
      + '(verify_0014 = 0 poikkeavaa): juna etenee järjestyksessä. Riski on '
      + 'keski — tasks on tuotannossa auki — joten tuore varmuuskopio on '
      + 'pakollinen.',
    tables: Object.freeze(['protected_periods', 'weekly_plans'])
  })
]);

/**
 * Sarakeportit: portteja, jotka eivät ole tauluja.
 *
 * `BILL_PAYMENT_FIELDS` on `bills`-taulun kolme uutta saraketta
 * (payee, iban, reference). Taulu on olemassa migraatiosta 0007, mutta
 * sarakkeet syntyvät vasta migraatiossa 0009 — joten taulun portin
 * avaaminen EI riitä, ja sarakeportti on erillinen.
 *
 * Se kuuluu samaan aaltoon F kuin taulutkin: sama migraatio, sama
 * hyväksyntä, sama peruutus.
 */
export const COLUMN_GATES = Object.freeze({
  BILL_PAYMENT_FIELDS: 'F',
  /** goals-, tasks- ja projects-taulujen uudet sarakkeet. */
  GOAL_PLANNING_FIELDS: 'G',
  /** `maintenance` sallittuna tavoitteen tilana. */
  GOAL_MAINTENANCE_MODE: 'G',
  /** goals.life_area_id (migraatio 0012). */
  GOAL_LIFE_AREA_FIELD: 'I',
  /** 0012:n taulujen uudet sarakkeet (migraatio 0013). */
  ALIGNMENT_REALITY_FIELDS: 'J',
  /**
   * tasks-taulun horisontti, odotus, arkisto ja siirrot sekä
   * life_areas.kind (migraatio 0015). Lukitut C–K-tietueet eivät tunne
   * tätä porttia: train-map vertaa vain tietueessa olevat portit ja
   * vaatii puuttuvan olevan kiinni (docs/MENTAL-LOAD-CORE.md).
   */
  MENTAL_LOAD_FIELDS: 'L'
});

/**
 * Onko aalto deployattavissa juuri nyt?
 *
 * KAKSI RIIPPUMATONTA EHTOA:
 *
 *   readiness === 'READY'   käyttöliittymä on olemassa (johdettu)
 *   blockedBy == null       kanta on valmis (julistettu)
 *
 * Kumpikin voi estää yksin. Aalto, jonka domainilta puuttuu näkymä, ei
 * ole hyväksyttävissä; aalto, jonka taulua ei ole, kaataa jokaisen
 * kirjoituksen. Yhteen lukuun puristettuna toinen niistä katoaisi.
 */
export function isDeployable(id) {
  const wave = waveById(id);
  if (!wave) return false;
  if (id === 'BASE') return true;
  return wave.readiness === 'READY' && !wave.blockedBy;
}

/** Aallot, joilla on julistettu este. */
export function blockedWaves() {
  return WAVES.filter(wave => wave.blockedBy)
    .map(wave => Object.freeze({ id: wave.id, blockedBy: wave.blockedBy }));
}

/** Aaltotunnisteet järjestyksessä. */
export const WAVE_IDS = Object.freeze(WAVES.map(w => w.id));

/** Aalto tunnisteella, tai null. `BASE` kelpaa tunnisteeksi. */
export function waveById(id) {
  if (id === 'BASE') return BASE;
  return WAVES.find(w => w.id === id) || null;
}

/** Aallon järjestysnumero (BASE = -1, A = 0, ...), tai null. */
export function waveIndex(id) {
  if (id === 'BASE') return -1;
  const index = WAVES.findIndex(w => w.id === id);
  return index === -1 ? null : index;
}

/**
 * Kaikki portit, jotka ovat auki kun tämä aalto on deployattu —
 * aiemmat aallot mukaan luettuina.
 */
export function cumulativeGates(id) {
  const index = waveIndex(id);
  if (index === null) throw new Error(`Tuntematon aalto: ${id}`);
  const gates = [];
  for (let i = 0; i <= index; i++) gates.push(...WAVES[i].gates);
  return Object.freeze(gates);
}

/**
 * Odotettu porttimatriisi tälle aallolle: jokainen kymmenestä portista
 * ja sen odotettu arvo.
 *
 * Tämä on se joukko, jota vasten `src/data/schema.js` tarkistetaan.
 * Osittainenkin ero on virhe: portti joka avautuu liian aikaisin
 * tuottaa vierasavainvirheitä, ja portti joka jää auki liian pitkäksi
 * aikaa hämärtää sen, mikä aalto vian aiheutti.
 */
export function expectedMatrix(id) {
  const open = new Set(id === 'BASE' ? [] : cumulativeGates(id));
  const matrix = {};
  for (const gate of ALL_GATES) matrix[gate] = open.has(gate);
  return Object.freeze(matrix);
}

/** Aallon odotettu välimuistiversio. */
export function cacheVersionOf(id) {
  const wave = waveById(id);
  if (!wave) throw new Error(`Tuntematon aalto: ${id}`);
  return wave.cacheVersion;
}

/**
 * Mihin tämä aalto perutaan, jos se epäonnistuu tuotannossa?
 *
 * Aina EDELLINEN aalto — ei perustila. Aallon A epäonnistuminen
 * perutaan perustilaan, aallon B epäonnistuminen aaltoon A ja niin
 * edelleen. Näin peruutus sulkee vain ne portit, joiden avaaminen
 * epäonnistui, eikä sellaisia jotka on jo todennettu toimiviksi.
 */
export function rollbackTargetOf(id) {
  const index = waveIndex(id);
  if (index === null) throw new Error(`Tuntematon aalto: ${id}`);
  return index === 0 ? 'BASE' : WAVES[index - 1].id;
}

/**
 * Mitä aaltoa annettu porttimatriisi vastaa?
 *
 * Palauttaa aaltotunnisteen ('BASE', 'A', ...) tai null, jos matriisi
 * ei vastaa YHTÄKÄÄN sallittua tilaa.
 *
 * TÄMÄ ON KOKO TYÖKALUN YDIN. Kolmetoista porttia tuottaa 8192
 * yhdistelmää; niistä vain kahdeksan on sallittuja. Kaikki muut ovat
 * virheitä — joko portti on avattu liian aikaisin, portti on jäänyt
 * avaamatta tai jokin on sulkeutunut vahingossa. Jokainen näistä on
 * tuotantovirhe, ja jokainen niistä kaatuu tässä.
 */
export function resolveWave(tables) {
  if (!tables || typeof tables !== 'object') return null;

  // Tuntematon portti on aina virhe: se tarkoittaa, että schema.js ja
  // tämä moduuli ovat erkaantuneet toisistaan.
  const keys = Object.keys(tables).sort();
  if (keys.length !== ALL_GATES.length) return null;
  if (keys.join(',') !== [...ALL_GATES].sort().join(',')) return null;

  for (const id of ['BASE', ...WAVE_IDS]) {
    const expected = expectedMatrix(id);
    if (ALL_GATES.every(gate => tables[gate] === expected[gate])) return id;
  }
  return null;
}

/** Ihmisluettava kuvaus matriisista, virheilmoituksia varten. */
export function describeMatrix(tables) {
  return ALL_GATES
    .map(gate => `${gate}=${tables && tables[gate] === true ? 'true' : 'false'}`)
    .join(' ');
}

/**
 * Aaltojen koko suunnitelma taulukkona — julkaisumanifestia ja
 * dokumentaatiota varten.
 */
export function releasePlan() {
  return WAVES.map(wave => Object.freeze({
    id: wave.id,
    title: wave.title,
    cacheVersion: wave.cacheVersion,
    gatesEnabled: [...wave.gates],
    gatesCumulative: [...cumulativeGates(wave.id)],
    gatesDisabled: ALL_GATES.filter(g => !cumulativeGates(wave.id).includes(g)),
    tables: [...wave.tables],
    rollbackTarget: rollbackTargetOf(wave.id),
    rationale: wave.rationale
  }));
}

// =====================================================================
// AKTIVOINNIN METATIEDOT (ACT-12)
// =====================================================================
//
// Jokaisella aallolla on yllä kentät
//
//   migration           junan migraatio, jonka aalto tarvitsee ('0009'…),
//                       tai null (A–E: 0003–0008 ajettiin ennen junaa)
//   migrationFile       sen tiedosto repon juuresta
//   risk                'low' | 'medium' | 'high'
//   ownerGates          omistajan portit (docs/SUUNTA-ACTIVATION-GO-NOGO.md,
//                       "Jäljellä olevat esteet")
//   backupRequired      tuore varmuuskopio PAKOLLINEN ennen migraatiota
//   verifyPrerequisite  migraatio, jonka verify_00XX.sql on oltava
//                       0 poikkeavaa ennen tämän aallon migraatiota
//
// Nämä olivat aiemmin vain proosaa kolmessa dokumentissa ja kolmessa
// työkalussa (score-inventory, build-preflights, train-map), jotka
// kukin kopioivat migraatio -> aalto -kartan käsin. Nyt kaikki lukevat
// sen täältä, ja tests/activation-metadata.test.mjs vertaa
// GO/NO-GO-taulukkoa näihin kenttiin.

/**
 * Junan C–K ensimmäinen aalto: tuotannossa jo oleva lattia. Kanta 0008
 * tukee aaltoja A–E, mutta tuotanto ei voi palata C:tä vanhempaan
 * (välimuistiversio ei saa laskea), joten sallitut koodiaallot alkavat
 * tästä.
 */
export const TRAIN_FLOOR_WAVE = 'C';

/**
 * Kannan lähtötila ennen junan migraatioita: 0008 on ajettu, ja se tukee
 * kaikkia aaltoja E:hen asti.
 */
export const DB_FLOOR = Object.freeze({ migration: '0008', wave: 'E' });

/** Junan migraatiot järjestyksessä ('0009' … '0015'). */
export const TRAIN_MIGRATIONS = Object.freeze(
  WAVES.filter(w => w.migration).map(w => w.migration));

/** Migraatio -> aalto, jonka portit se mahdollistaa. */
export const MIGRATION_WAVE = Object.freeze(Object.fromEntries(
  WAVES.filter(w => w.migration).map(w => [w.migration, w.id])));

/** Riskiluokan suomenkielinen nimi (GO/NO-GO-taulukon sanasto). */
export const RISK_LABEL_FI = Object.freeze({ low: 'matala', medium: 'keski', high: 'KORKEA' });

/** Seuraava aalto, tai null (L on viimeinen). BASE -> A. */
export function nextWaveId(id) {
  const index = waveIndex(id);
  if (index === null) return null;
  return index + 1 < WAVES.length ? WAVES[index + 1].id : null;
}

/** Edellinen aalto, tai null. A -> BASE. */
export function previousWaveId(id) {
  const index = waveIndex(id);
  if (index === null || index === -1) return null;
  return index === 0 ? 'BASE' : WAVES[index - 1].id;
}

/**
 * Minkä aallon koodia kanta tukee, kun `lastMigration` on viimeisin
 * täysin ajettu migraatio? 0008 -> E, 0009 -> F … 0015 -> L.
 */
export function schemaWaveOfMigration(lastMigration) {
  if (lastMigration === DB_FLOOR.migration) return DB_FLOOR.wave;
  return MIGRATION_WAVE[lastMigration] || null;
}

/** Esitarkistuksen polku migraatiolle ('0009' -> supabase/preflight/preflight_0009.sql). */
export function preflightPathOf(migration) {
  return migration ? `supabase/preflight/preflight_${migration}.sql` : null;
}

/** Varmistuksen polku migraatiolle ('0009' -> supabase/verify/verify_0009.sql). */
export function verifyPathOf(migration) {
  return migration ? `supabase/verify/verify_${migration}.sql` : null;
}

/**
 * Deployatun commitin tila porttimatriisista ja välimuistiversiosta.
 *
 * Tavallinen aalto: matriisi ratkeaa aaltoon W ja välimuisti on
 * täsmälleen cacheVersionOf(W).
 *
 * PERUUTUS (ACT-10): aallon W+1 peruutus palauttaa aallon W matriisin,
 * mutta nostaa välimuistia (peruutus on deploy, ja deploy nostaa aina).
 * Se näkyy matriisina W ja välimuistina, joka on SUUREMPI kuin
 * cacheVersionOf(W). Tila on 'ROLLBACK' ja `rollbackOf` = W+1. Sellainen
 * tila pysäyttää junan: myöhempien ehdokkaiden välimuistiversiot
 * törmäävät peruutuksen versioon, joten ne on leikattava uudelleen
 * (TRAIN_HALTED_RECUT_REQUIRED).
 *
 * @param {{gates: object|null, cacheVersion: string|null}} deployed
 * @returns {{state: 'WAVE'|'ROLLBACK'|'INCONSISTENT', wave: string|null,
 *   matrixWave: string|null, rollbackOf: string|null, label: string}}
 */
export function classifyDeployedState({ gates, cacheVersion }) {
  const matrixWave = gates ? resolveWave(gates) : null;
  const number = value => {
    const match = /^v(\d+)$/.exec(String(value));
    return match ? Number(match[1]) : null;
  };
  const inconsistent = label => ({
    state: 'INCONSISTENT', wave: null, matrixWave, rollbackOf: null, label
  });
  if (!matrixWave) return inconsistent('matriisi ei vastaa yhtäkään aaltoa');
  const expected = number(cacheVersionOf(matrixWave));
  const actual = number(cacheVersion);
  if (actual === null) return inconsistent('välimuistiversiota ei voitu lukea');
  if (actual === expected) {
    return { state: 'WAVE', wave: matrixWave, matrixWave, rollbackOf: null, label: matrixWave };
  }
  const rollbackOf = nextWaveId(matrixWave);
  if (actual > expected && rollbackOf) {
    return {
      state: 'ROLLBACK', wave: null, matrixWave, rollbackOf,
      label: `ROLLBACK(${rollbackOf})`
    };
  }
  return inconsistent(
    `välimuisti ${cacheVersion} ei sovi matriisiin ${matrixWave} (${cacheVersionOf(matrixWave)})`);
}
