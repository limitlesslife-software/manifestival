// Arjen seurannan ja arjen havaintojen säännöt (kynnysarvot yhdessä paikassa).
//
// PUHDAS MODUULI: vain jäädytettyjä vakioita, ei tuonteja.
//
// MIKSI ERILLINEN TIEDOSTO
//
// Sama periaate kuin Suunnan alignmentPolicy.js:ssä: kynnysarvo on tuotteen
// päätös, ei toteutuksen yksityiskohta. Kun luvut ovat tässä, laskentamoduulit
// (habitEngine, mealRhythm, exercise, wellbeingInsights, moneyAlignment,
// dailyLifeSignals) eivät sisällä yhtään piilotettua kynnystä, ja testit
// voivat tarkistaa sen. Selitystekstien luvut rakennetaan näistä, ei
// kirjoiteta käsin — muuten teksti ja sääntö erkanisivat.
//
// VIITE ON AINA KÄYTTÄJÄN OMA LUKU
//
// Unen riittävyyttä verrataan käyttäjän omaan tavoitteeseen, rahankäyttöä
// hänen itse ilmoittamaansa rajaan ja tapoja hänen omaan suunnitelmaansa.
// Väestötason normeja (esim. "7 tuntia unta") ei ole. Hyvinvoinnin asteikko
// 1–5 on käyttäjän oma arvio, ja rajat viittaavat sen ääripäihin.
//
// NÄMÄ EIVÄT OLE TERVEYSNEUVOJA. Säännöt tuottavat havaintoja ja ehdotuksia,
// eivät diagnooseja eivätkä hoito-ohjeita.

/** Tapojen muutos (esim. nikotiini). */
export const HABIT_RULES = Object.freeze({
  /** "Myöhemmin": seuraava suunniteltu aika siirtyy näin monta minuuttia. */
  DELAY_MINUTES: 15,
  /** Edistymisen oletusjakso päivinä. */
  PROGRESS_DEFAULT_DAYS: 7,
  /** Edistymisen pisin jakso päivinä (vuosi + karkauspäivä). */
  PROGRESS_MAX_DAYS: 366,
  /**
   * Laitteiden kellot voivat erota hieman: näin paljon "tulevaisuudessa"
   * oleva kirjaus lasketaan vielä tehdyksi. Sitä kauempana oleva ohitetaan.
   */
  FUTURE_SKEW_MINUTES: 5
});

/** Ateriarytmi. */
export const MEAL_RULES = Object.freeze({
  /** Vesimuistutusten lyhin väli. Tiheämpi olisi häiriö, ei tuki. */
  WATER_MIN_INTERVAL_MINUTES: 30,
  /** Vesimuistutuksia enintään näin monta päivässä. */
  WATER_MAX_REMINDERS_PER_DAY: 20,
  /** Aterian valmistelun pisin kesto. */
  MAX_PREP_MINUTES: 240,
  /** Lisäravinnemuistutuksia enintään. */
  MAX_SUPPLEMENTS: 10,
  MAX_NAME_LENGTH: 60
});

/** Liikunta. Asteikot 1–5 ovat käyttäjän omia arvioita. */
export const EXERCISE_RULES = Object.freeze({
  SCALE_MIN: 1,
  SCALE_MAX: 5,
  MAX_MINUTES: 1440,
  MAX_KIND_LENGTH: 60,
  /** Päivä on "raskas", kun oma arvio rasittavuudesta tai palautumistarpeesta on vähintään tämä. */
  HARD_MIN_LEVEL: 4,
  /** Palautumisvihje, kun raskaita päiviä on peräkkäin vähintään näin monta. */
  HARD_RUN_DAYS: 3,
  /** Palautumisvihje, kun liikuntaa on kirjattu näin monelle viikon päivälle. */
  NO_REST_ACTIVE_DAYS: 7
});

/** Hyvinvointimerkintöjen yhdistäminen ja kuormitusehdotus. */
export const WELLBEING_RULES = Object.freeze({
  SCALE_MIN: 1,
  SCALE_MAX: 5,
  /** Keskiarvojen oletusikkuna päivinä. */
  AVERAGE_DEFAULT_DAYS: 7,
  AVERAGE_MAX_DAYS: 366,
  /** Oma arvio kuormituksesta vähintään tämä = korkea kuormitus. */
  HIGH_LOAD_MIN: 4,
  /** Oma arvio energiasta enintään tämä = matala energia. */
  LOW_ENERGY_MAX: 2,
  /** Oma arvio hallinnan tunteesta enintään tämä = vähäinen hallinnan tunne. */
  LOW_CONTROL_MAX: 2,
  /** Ehdotuksen tarkastelujakso: viimeiset N päivää. */
  STRAIN_WINDOW_DAYS: 5,
  /** Vähintään näin monta kuormittunutta päivää jakson sisällä. */
  STRAIN_MIN_DAYS: 3,
  /** Vähintään näin monta päivää, joilta on merkintä, ennen kuin mitään sanotaan. */
  STRAIN_MIN_REPORTED_DAYS: 3
});

/** Arjen havainnot: uni. Viite on käyttäjän oma tavoite ja rytmi. */
export const SLEEP_SIGNAL_RULES = Object.freeze({
  /** Vähintään näin monta kirjattua yötä ennen havaintoa. */
  MIN_REPORTED_NIGHTS: 3,
  /** Ja vähintään tämä osuus tarkastelujakson öistä. */
  MIN_COVERAGE: 0.5,
  /** "Huomio"-tasoon vaaditaan näin monta kirjattua yötä. */
  ATTENTION_MIN_REPORTED_NIGHTS: 5,
  /** Rytmi poikkesi, kun nukkumaanmeno tai herääminen erosi omasta ajasta vähintään tämän verran. */
  DRIFT_MINUTES: 60,
  DRIFT_MIN_NIGHTS: 3,
  DRIFT_ATTENTION_NIGHTS: 4,
  /** Yö oli lyhyt, kun aikaa unelle jäi omaa tavoitetta vähintään näin paljon vähemmän. */
  SHORTFALL_MINUTES: 30,
  SHORT_MIN_NIGHTS: 3,
  SHORT_ATTENTION_NIGHTS: 4,
  /** "Huomio" vaatii myös keskimääräisen vajeen vähintään tämän verran. */
  SHORT_ATTENTION_MEAN_MINUTES: 60
});

/** Arjen havainnot: hyvinvoinnin kuormitus. */
export const WELLBEING_SIGNAL_RULES = Object.freeze({
  MIN_REPORTED_DAYS: 3,
  MIN_COVERAGE: 0.5,
  STRAIN_MIN_DAYS: 3,
  ATTENTION_MIN_DAYS: 4,
  ATTENTION_MIN_REPORTED_DAYS: 5
});

/** Raha: harkinnanvarainen käyttö suhteessa käyttäjän omaan rajaan. */
export const MONEY_RULES = Object.freeze({
  /** Alle näin monen kirjauksen kuukaudesta ei sanota mitään. */
  MIN_TRANSACTIONS: 5,
  /** Lähellä rajaa: vähintään tämä osuus omasta rajasta käytetty. */
  NEAR_RATIO: 0.9
});

export const DAILY_LIFE_POLICY = Object.freeze({
  HABIT_RULES,
  MEAL_RULES,
  EXERCISE_RULES,
  WELLBEING_RULES,
  SLEEP_SIGNAL_RULES,
  WELLBEING_SIGNAL_RULES,
  MONEY_RULES
});
