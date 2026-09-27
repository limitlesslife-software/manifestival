// Arjen käyttöjärjestelmän (Daily Life OS) yhteiset käsitteet.
//
// PUHDAS MODUULI: vain vakioita ja pieniä nimikefunktioita. Ei kelloa, ei
// DOM:ia, ei verkkoa, ei tuonteja. Kalenteri, paikat, lähtö, uni, aamu,
// herätys, puhutut muistutukset, tavat ja ateriat nojaavat näihin, jotta
// sama käsite ei synny kahteen kertaan kahdella nimellä.
//
// PERIAATE: SUOJATTU VÄLJYYS (PROTECTED SLACK)
//
// Valmistautuminen, matka, perilläolon varmuusaika, lepo ja uni EIVÄT ole
// vapaata aikaa. Joustava työ saa liikkua niiden ympärillä, mutta mikään
// automaattinen laskenta ei koskaan vie suojattua unta toisen asian tieltä.
// Suunnitelma suosii realistista, ajoissa olevaa ja selitettävää —
// ei mahdollisimman täyttä.
//
// RAJAT (MAX_*) VASTAAVAT MIGRAATIOIDEN 0014 JA 0015 CHECK-RAJOITTEITA.
// Jos jompaakumpaa muutetaan, molempia muutetaan.

// ------------------------------------------------------------ suojaus

/**
 * Aamurutiinin ja päivän lohkojen suojausluokka.
 *
 * MANDATORY           pakollinen (pukeutuminen): ei koskaan pudoteta
 * PROTECTED           suojattu (uni, hengitysharjoitus): ei pudoteta
 *                     automaattisesti, vain käyttäjän valinnalla
 * IMPORTANT_FLEXIBLE  tärkeä mutta joustava (aamulenkki): voidaan lyhentää
 *                     tai siirtää, kun aamu ei mahdu — käyttäjä valitsee
 * OPTIONAL            valinnainen: ensimmäinen, joka jää pois
 */
export const PROTECTION = Object.freeze({
  MANDATORY: 'mandatory',
  PROTECTED: 'protected',
  IMPORTANT_FLEXIBLE: 'important_flexible',
  OPTIONAL: 'optional'
});

export const PROTECTIONS = Object.freeze(Object.values(PROTECTION));

const PROTECTION_LABELS = Object.freeze({
  [PROTECTION.MANDATORY]: 'Pakollinen',
  [PROTECTION.PROTECTED]: 'Suojattu',
  [PROTECTION.IMPORTANT_FLEXIBLE]: 'Tärkeä, joustava',
  [PROTECTION.OPTIONAL]: 'Valinnainen'
});

export function protectionLabel(value) {
  return PROTECTION_LABELS[value] || PROTECTION_LABELS[PROTECTION.OPTIONAL];
}

/** Järjestys, jossa aamun osia karsitaan: pienin ensin. Pakollista ei koskaan. */
export const PROTECTION_DROP_ORDER = Object.freeze([
  PROTECTION.OPTIONAL, PROTECTION.IMPORTANT_FLEXIBLE
]);

// ------------------------------------------------------------ ohjaustyyli

/**
 * Ohjauksen tyyli. Vaikuttaa muistutusten määrään, sanamuodon
 * voimakkuuteen ja toiston kynnykseen — EI KOSKAAN turva- tai
 * yksityisyyssääntöihin.
 */
export const GUIDANCE_STYLE = Object.freeze({
  CALM: 'rauhallinen',
  BRISK: 'napakka',
  ACTIVE: 'aktiivinen'
});

export const GUIDANCE_STYLES = Object.freeze(Object.values(GUIDANCE_STYLE));

const GUIDANCE_LABELS = Object.freeze({
  [GUIDANCE_STYLE.CALM]: 'Rauhallinen',
  [GUIDANCE_STYLE.BRISK]: 'Napakka',
  [GUIDANCE_STYLE.ACTIVE]: 'Aktiivinen'
});

export function guidanceStyleLabel(value) {
  return GUIDANCE_LABELS[value] || GUIDANCE_LABELS[GUIDANCE_STYLE.CALM];
}

// ------------------------------------------------------------ toimitustapa

/**
 * Miten muistutus toimitetaan. Tärkeysaste (src/domain/notification.js
 * LEVEL 1–4) kertoo KUINKA TÄRKEÄ; toimitustapa kertoo MITEN se kuuluu.
 */
export const DELIVERY = Object.freeze({
  SILENT: 'silent',
  VIBRATE: 'vibrate',
  SOUND: 'sound',
  SPEECH: 'speech',
  SOUND_AND_SPEECH: 'sound_and_speech',
  CRITICAL_ESCALATION: 'critical_escalation'
});

export const DELIVERIES = Object.freeze(Object.values(DELIVERY));

const DELIVERY_LABELS = Object.freeze({
  [DELIVERY.SILENT]: 'Hiljainen',
  [DELIVERY.VIBRATE]: 'Värinä',
  [DELIVERY.SOUND]: 'Ääni',
  [DELIVERY.SPEECH]: 'Puhe',
  [DELIVERY.SOUND_AND_SPEECH]: 'Ääni ja puhe',
  [DELIVERY.CRITICAL_ESCALATION]: 'Voimistuva hälytys'
});

export function deliveryLabel(value) {
  return DELIVERY_LABELS[value] || DELIVERY_LABELS[DELIVERY.SILENT];
}

/** Puhuuko toimitustapa ääneen. */
export function deliverySpeaks(value) {
  return value === DELIVERY.SPEECH || value === DELIVERY.SOUND_AND_SPEECH
    || value === DELIVERY.CRITICAL_ESCALATION;
}

/**
 * Muistutusten aiheet, joille käyttäjä voi valita toimitustavan.
 * Avain on myös life_settings.delivery-olion avain.
 */
export const REMINDER_TOPIC = Object.freeze({
  DEPARTURE: 'departure',
  PREPARATION: 'preparation',
  BEDTIME: 'bedtime',
  MORNING: 'morning',
  MEAL: 'meal',
  HABIT: 'habit',
  DEADLINE: 'deadline',
  ROUTINE: 'routine'
});

export const REMINDER_TOPICS = Object.freeze(Object.values(REMINDER_TOPIC));

const TOPIC_LABELS = Object.freeze({
  [REMINDER_TOPIC.DEPARTURE]: 'Lähtö',
  [REMINDER_TOPIC.PREPARATION]: 'Valmistautuminen',
  [REMINDER_TOPIC.BEDTIME]: 'Nukkumaanmeno',
  [REMINDER_TOPIC.MORNING]: 'Aamurutiini',
  [REMINDER_TOPIC.MEAL]: 'Ateriat',
  [REMINDER_TOPIC.HABIT]: 'Tapojen muutos',
  [REMINDER_TOPIC.DEADLINE]: 'Määräajat',
  [REMINDER_TOPIC.ROUTINE]: 'Rutiinit'
});

export function reminderTopicLabel(value) {
  return TOPIC_LABELS[value] || value;
}

/**
 * Hyvinvoinnin valinnaiset muistutusaiheet, jotka käyttäjä voi kytkeä
 * KOKONAAN pois (aalto L: hyvinvointi on valinnaista tukea, ei tehtävälista).
 *
 * Pois kytkentä tallentuu samaan life_settings.delivery-olioon arvolla
 * DELIVERY_OFF ('off'): ateriat ja tavat ovat myös toimitustavan aiheita
 * (REMINDER_TOPIC), joten 'off' korvaa niiden tavan; vesi, lisäravinteet,
 * liikunta ja hyvinvoinnin kirjauskehotteet ovat vain päälle/pois
 * (puuttuva avain = päällä, toimitustapa tulee yläaiheesta).
 *
 * Jokainen aihe on oma: veden kytkeminen pois ei vie aterioita, eikä
 * aterioiden kytkeminen pois vie vettä tai lisäravinteita.
 * Lähtö, herätys, nukkumaanmeno, määräajat ja laskut EIVÄT ole tällä
 * listalla: niitä ei voi kytkeä pois tästä (turva ja sitoumukset).
 */
export const DELIVERY_OFF = 'off';

export const OPTIONAL_TOPIC = Object.freeze({
  MEAL: 'meal',
  WATER: 'water',
  SUPPLEMENT: 'supplement',
  HABIT: 'habit',
  EXERCISE: 'exercise',
  CHECKIN: 'checkin'
});

export const OPTIONAL_TOPICS = Object.freeze(Object.values(OPTIONAL_TOPIC));

const OPTIONAL_TOPIC_LABELS = Object.freeze({
  [OPTIONAL_TOPIC.MEAL]: 'Ateriat ja ruokailun iltaraja',
  [OPTIONAL_TOPIC.WATER]: 'Vesitauot',
  [OPTIONAL_TOPIC.SUPPLEMENT]: 'Lisäravinteet',
  [OPTIONAL_TOPIC.HABIT]: 'Tapojen muutos (myös nikotiini)',
  [OPTIONAL_TOPIC.EXERCISE]: 'Liikunta',
  [OPTIONAL_TOPIC.CHECKIN]: 'Hyvinvoinnin kirjauskehotteet'
});

export function optionalTopicLabel(value) {
  return OPTIONAL_TOPIC_LABELS[value] || value;
}

/** Oletustoimitustapa aiheittain. Puhe on aina käyttäjän oma valinta: oletus ei puhu. */
export const DEFAULT_DELIVERY = Object.freeze({
  [REMINDER_TOPIC.DEPARTURE]: DELIVERY.SOUND,
  [REMINDER_TOPIC.PREPARATION]: DELIVERY.SOUND,
  [REMINDER_TOPIC.BEDTIME]: DELIVERY.VIBRATE,
  // Aamurutiinin aiheeseen kuuluu illan ennakko ("Huominen alkaa aiemmin"):
  // se on toimintaa vaativa neuvo, joten oletus värisee eikä jää huomaamatta.
  // Päivän suunnitelma on Tieto-tasoa ja pysyy silti hiljaisena (tasoraja).
  [REMINDER_TOPIC.MORNING]: DELIVERY.VIBRATE,
  [REMINDER_TOPIC.MEAL]: DELIVERY.VIBRATE,
  [REMINDER_TOPIC.HABIT]: DELIVERY.SILENT,
  [REMINDER_TOPIC.DEADLINE]: DELIVERY.SOUND,
  [REMINDER_TOPIC.ROUTINE]: DELIVERY.VIBRATE
});

// ------------------------------------------------------------ herätys

/** Herätyksen tapa. */
export const ALARM_MODE = Object.freeze({
  SOUND: 'alarm_sound',
  MUSIC: 'music',
  SPEECH: 'speech',
  COMBINATION: 'combination'
});

export const ALARM_MODES = Object.freeze(Object.values(ALARM_MODE));

const ALARM_MODE_LABELS = Object.freeze({
  [ALARM_MODE.SOUND]: 'Herätysääni',
  [ALARM_MODE.MUSIC]: 'Oma musiikki',
  [ALARM_MODE.SPEECH]: 'Puhe',
  [ALARM_MODE.COMBINATION]: 'Ääni ja puhe'
});

export function alarmModeLabel(value) {
  return ALARM_MODE_LABELS[value] || ALARM_MODE_LABELS[ALARM_MODE.SOUND];
}

/** Voimistuvan herätyksen vaiheen toiminto. */
export const ESCALATION_STEP = Object.freeze({
  SOFT: 'soft',
  SPEECH: 'speech',
  LOUD: 'loud',
  REPEAT_SPEECH: 'repeat_speech'
});

export const ESCALATION_STEPS = Object.freeze(Object.values(ESCALATION_STEP));

/** Herätys soi enintään näin kauan ilman kuittausta, sitten se torkkuu kerran ja lopettaa. Ei loputonta hälytystä. */
export const MAX_ALARM_RING_MINUTES = 10;
export const MAX_SNOOZE_MINUTES = 30;
export const MAX_SNOOZES = 3;

// ------------------------------------------------------------ matka

/** Mistä lähtölaskennan matka-aika on peräisin (lähtömoottori v2). */
export const ESTIMATE_SOURCE = Object.freeze({
  /** Oikea reittipalvelu, tuore arvio. */
  PROVIDER: 'provider',
  /** Käyttäjän itse kertoma tavallinen kesto. EI ole liikennetietoa. */
  USER_SUPPLIED: 'user_supplied',
  /** Käyttäjän hyväksymä oppiminen omista matkoista (selitettävä). */
  LEARNED: 'learned',
  /** Ei tiedossa: lähtöaikaa EI lasketa. */
  UNKNOWN: 'unknown'
});

export const ESTIMATE_SOURCES = Object.freeze(Object.values(ESTIMATE_SOURCE));

/** Toteutuneen matkan lopputulos (käyttäjän kuittaama). */
export const ARRIVAL_RESULT = Object.freeze({
  EARLY: 'early',
  ON_TIME: 'on_time',
  LATE: 'late'
});

export const ARRIVAL_RESULTS = Object.freeze(Object.values(ARRIVAL_RESULT));

/** Havainnon lähde. Ei koskaan sijaintihistoriaa. */
export const OBSERVATION_SOURCE = Object.freeze({
  USER_CONFIRMED: 'user_confirmed',
  DEPARTURE_ACK: 'departure_ack'
});

export const OBSERVATION_SOURCES = Object.freeze(Object.values(OBSERVATION_SOURCE));

// ------------------------------------------------------------ uni

/**
 * Unen tiedon laji. Sovellus EI mittaa unta: se tietää vain vuoteessa
 * olon ajan (mahdollisuuden nukkua). Mitattu uni vaatii terveyslaitteen.
 */
export const SLEEP_KIND = Object.freeze({
  OPPORTUNITY: 'opportunity',
  MEASURED: 'measured'
});

export const SLEEP_KINDS = Object.freeze(Object.values(SLEEP_KIND));

export const SLEEP_SOURCE = Object.freeze({
  USER: 'user',
  ALARM: 'alarm'
});

export const SLEEP_SOURCES = Object.freeze(Object.values(SLEEP_SOURCE));

// ------------------------------------------------------------ tavat

export const HABIT_KIND = Object.freeze({
  NICOTINE: 'nicotine',
  GENERIC: 'generic'
});

export const HABIT_KINDS = Object.freeze(Object.values(HABIT_KIND));

/** Kirjattu tapahtuma. Neutraali kieli: ei "retkahdusta", ei "epäonnistumista". */
export const HABIT_ACTION = Object.freeze({
  USE: 'use',
  DELAY: 'delay',
  SKIP: 'skip'
});

export const HABIT_ACTIONS = Object.freeze(Object.values(HABIT_ACTION));

// ------------------------------------------------------------ oletukset ja rajat

/** "Mieluummin ajoissa kuin myöhässä": oletus perilläolon varmuusajaksi. */
export const DEFAULT_ARRIVAL_BUFFER_MINUTES = 10;
export const ARRIVAL_BUFFER_CHOICES = Object.freeze([5, 10, 15]);
export const MAX_ARRIVAL_BUFFER_MINUTES = 120;
export const MAX_PLACE_ARRIVAL_BUFFER_MINUTES = 240;
export const MAX_OVERHEAD_MINUTES = 240;
export const MAX_PREPARATION_MINUTES = 480;
export const MAX_TRAVEL_MINUTES = 1440;

export const DEFAULT_WIND_DOWN_MINUTES = 30;
export const MAX_WIND_DOWN_MINUTES = 180;
export const DEFAULT_WEEKEND_SHIFT_MINUTES = 60;
export const MAX_WEEKEND_SHIFT_MINUTES = 240;
export const MAX_REMINDER_OFFSET_MINUTES = 60;

export const MAX_PLACE_NAME_LENGTH = 80;
export const MAX_ADDRESS_LENGTH = 300;
export const MAX_ALIAS_LENGTH = 80;
export const MAX_EVENT_TITLE_LENGTH = 200;
export const MAX_EVENT_NOTES_LENGTH = 2000;
export const MAX_SKIP_DATES = 366;
export const MAX_MORNING_STEPS = 20;
export const MAX_MEALS = 8;
export const MAX_HABIT_STEPS = 52;

/** Kuinka monta havaintoa paikkaa kohden säilytetään. Rajattu historia, ei seurantaa. */
export const MAX_OBSERVATIONS_PER_PLACE = 60;
