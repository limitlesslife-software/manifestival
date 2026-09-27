// Muistutusten toimituspolitiikka: miten, milloin ja kuinka monta.
//
// PUHDAS MODUULI. Ei kelloa (nykyhetki annetaan), ei DOM:ia, ei alustaa.
//
// VASTUUNJAKO
//   notification.js     MITÄ muistutetaan (tasot 1–4, aikomusten muoto)
//   dailyReminders.js   arjen muistutukset: lähtöketju, uni, ateriat, tavat
//   tämä moduuli        MITEN ne toimitetaan: toimitustapa aiheittain,
//                       rauhoitusaika, ohjaustyyli, kooste, kuittaukset,
//                       päiväraja
//   notificationAck.js  mitä käyttäjä on jo tehnyt (kuittausloki)
//
// PERIAATTEET (DESIGN.md "Notifications")
//   - Toimitustapa aiheittain käyttäjän asetuksista (life_settings.delivery),
//     muuten DEFAULT_DELIVERY. Puhe vain, jos käyttäjä on sallinut sen.
//   - Taso rajaa voimakkuuden: Tieto ei koskaan pidä ääntä, eikä mikään
//     muu kuin Kriittinen saa voimistuvaa hälytystä.
//   - Rauhoitusaikana läpi pääsevät vain kriittiset, herätykseen ja
//     lähtöön sidotut muistutukset sekä oman yön alku (iltarauhoittuminen
//     ja nukkumaanmeno, NIGHT_START_TYPES) valitulla tavalla (ks. quietDecision).
//   - Ohjaustyyli muuttaa vain sanamuotoa, ennakkoa ja toistoja — EI
//     KOSKAAN rauhoitusaikaa, toimitustapaa, puheen lupaa eikä yksityisyyttä.
//   - Kooste yhdistää vähäiset (taso ≤ Muistutus) muistutukset yhdeksi
//     päivässä. Hetkeen sidotut (lähtö, uni, ateria, tehtävän alku) eivät
//     mene koosteeseen: myöhästetty "lähde nyt" olisi vaarallinen.
//   - Kuitattua, torkutettua tai hylättyä ei toisteta.
//   - Päiväraja karsii ensin vähäisimmät (capValue: vesitauko ennen
//     nukkumaanmenoa). Kriittistä ei karsita koskaan.
//   - Aalto L: hyvinvoinnin valinnaisen aiheen (ateriat, vesi, lisäravinteet,
//     tavat, liikunta, kirjauskehotteet) voi kytkeä kokonaan pois
//     (life_settings.delivery[aihe] = 'off'). Vesi ja lisäravinteet ovat
//     koosteeseen kelpaavia (eivät ohita koostetta). Kun kuorma on korkea
//     (loadLevel), valinnaiset kehotteet siirtyvät koosteeseen tai jäävät
//     pois; välttämättömät (lähtö, herätys, määräaika, lasku) eivät muutu.

import {
  REMINDER_TOPIC, REMINDER_TOPICS, DELIVERY, DELIVERIES, DEFAULT_DELIVERY,
  GUIDANCE_STYLE, GUIDANCE_STYLES, deliverySpeaks, OPTIONAL_TOPIC, OPTIONAL_TOPICS, DELIVERY_OFF
} from './dailyLife.js';
import {
  NOTIFICATION_TYPE, NOTIFICATION_TYPES, LEVEL, DEPARTURE_CHAIN_TYPES, DEFAULT_PREFERENCES,
  DEPARTURE_ALERT_LEAD_MINUTES, createIntent, compareIntents, intentId, isQuietTime, normalizePreferences
} from './notification.js';
import { ackIndex, entryHandled } from './notificationAck.js';
import { spokenPhrase } from './spokenPhrases.js';
import { isIsoDate, isTimeOfDay, toMinutes, fromMinutes } from './task.js';
import { MEAL_ITEM_KIND } from './mealRhythm.js';

const LEVEL_VALUES = Object.freeze(Object.values(LEVEL));

// =====================================================================
// SEINÄKELLOAIKA
// =====================================================================
//
// Absoluuttiset minuutit = kalenteripäivän järjestysluku × 1440 + minuutit.
// Laskenta on puhdasta kokonaislukuaritmetiikkaa (ei Date-oliota), joten
// kuukauden, vuoden ja karkauspäivän vaihteet menevät oikein eikä
// kesäaika vaikuta. Kesäajan TODELLINEN kesto hoidetaan aikomuksen
// ankkurilla (createIntent), ei täällä.

function daysFromCivil(year, month, day) {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function civilFromDays(days) {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp + (mp < 10 ? 3 : -9);
  const year = yoe + era * 400 + (month <= 2 ? 1 : 0);
  return [year, month, day];
}

/** Seinäkelloaika absoluuttisina minuutteina, tai null. */
export function wallClockMinutes(date, time) {
  if (!isIsoDate(date) || !isTimeOfDay(time)) return null;
  const [year, month, day] = date.split('-').map(Number);
  return daysFromCivil(year, month, day) * 1440 + toMinutes(time);
}

/** Absoluuttiset minuutit takaisin muotoon { date, time }, tai null. */
export function wallClockAt(abs) {
  if (!Number.isInteger(abs)) return null;
  const days = Math.floor(abs / 1440);
  const [year, month, day] = civilFromDays(days);
  if (year < 1 || year > 9999) return null;
  const pad = (n, width = 2) => String(n).padStart(width, '0');
  return Object.freeze({
    date: `${pad(year, 4)}-${pad(month)}-${pad(day)}`,
    time: fromMinutes(abs - days * 1440)
  });
}

// =====================================================================
// AIHE JA TOIMITUSTAPA
// =====================================================================

/** Ilmoitustyypin oletusaihe. null = aiheeton (toimitustapa tasosta). */
const TOPIC_BY_TYPE = Object.freeze({
  [NOTIFICATION_TYPE.TASK_REMINDER]: null,
  [NOTIFICATION_TYPE.ROUTINE_REMINDER]: REMINDER_TOPIC.ROUTINE,
  [NOTIFICATION_TYPE.DEADLINE_WARNING]: REMINDER_TOPIC.DEADLINE,
  [NOTIFICATION_TYPE.DEPARTURE_REMINDER]: REMINDER_TOPIC.DEPARTURE,
  [NOTIFICATION_TYPE.DAILY_PLAN]: REMINDER_TOPIC.MORNING,
  [NOTIFICATION_TYPE.EVENING_REVIEW]: null,
  [NOTIFICATION_TYPE.DEPARTURE_PREPARE]: REMINDER_TOPIC.PREPARATION,
  [NOTIFICATION_TYPE.DEPARTURE_LEAVE_IN_5]: REMINDER_TOPIC.DEPARTURE,
  [NOTIFICATION_TYPE.DEPARTURE_LEAVE_NOW]: REMINDER_TOPIC.DEPARTURE,
  [NOTIFICATION_TYPE.WIND_DOWN]: REMINDER_TOPIC.BEDTIME,
  [NOTIFICATION_TYPE.BEDTIME]: REMINDER_TOPIC.BEDTIME,
  [NOTIFICATION_TYPE.MEAL]: REMINDER_TOPIC.MEAL,
  [NOTIFICATION_TYPE.HABIT]: REMINDER_TOPIC.HABIT,
  // Illan katsaus huomiseen kuuluu aamun valmisteluun: oletuksena hiljainen.
  [NOTIFICATION_TYPE.EVENING_BEFORE]: REMINDER_TOPIC.MORNING,
  [NOTIFICATION_TYPE.MORNING_BRIEF]: REMINDER_TOPIC.MORNING,
  [NOTIFICATION_TYPE.DIGEST]: null,
  // Menon alku ilman lähtöketjua: valmistaudu menoon (Valmistautuminen-valinta).
  [NOTIFICATION_TYPE.EVENT_START]: REMINDER_TOPIC.PREPARATION,
  // Aamurutiinin vaihe: Aamurutiini-valinta ohjaa sen toimitusta.
  [NOTIFICATION_TYPE.MORNING_STEP]: REMINDER_TOPIC.MORNING
});

/** Ilmoitustyypin aihe (REMINDER_TOPIC) tai null. */
export function topicForType(type) {
  return typeof type === 'string' && Object.hasOwn(TOPIC_BY_TYPE, type) ? TOPIC_BY_TYPE[type] : null;
}

/**
 * Toimitustapojen voimakkuus. Puhe ja ääni ovat yhtä keskeyttäviä;
 * ääni + puhe enemmän; voimistuva hälytys eniten.
 */
export const DELIVERY_RANK = Object.freeze({
  [DELIVERY.SILENT]: 0,
  [DELIVERY.VIBRATE]: 1,
  [DELIVERY.SOUND]: 2,
  [DELIVERY.SPEECH]: 2,
  [DELIVERY.SOUND_AND_SPEECH]: 3,
  [DELIVERY.CRITICAL_ESCALATION]: 4
});

/** Tason sallima suurin voimakkuus. Tieto on aina hiljainen. */
const LEVEL_CAP = Object.freeze({
  [LEVEL.INFO]: 0,
  [LEVEL.REMINDER]: 3,
  [LEVEL.ACTION]: 3,
  [LEVEL.CRITICAL]: 4
});

function fallbackForLevel(level) {
  if (level === LEVEL.CRITICAL || level === LEVEL.ACTION) return DELIVERY.SOUND;
  if (level === LEVEL.REMINDER) return DELIVERY.VIBRATE;
  return DELIVERY.SILENT;
}

function capDelivery(delivery, level) {
  const cap = LEVEL_CAP[level] ?? 0;
  if (DELIVERY_RANK[delivery] <= cap) return delivery;
  // Vain voimistuva hälytys ylittää tason 3; alempi taso saa äänen ja puheen.
  return cap >= 3 ? DELIVERY.SOUND_AND_SPEECH : DELIVERY.SILENT;
}

function safeObject(value) {
  return value && typeof value === 'object' ? value : null;
}

/** Käyttäjän oma toimitustapa aiheelle, jos kelvollinen. */
function overrideFor(settings, topic) {
  const map = safeObject(safeObject(settings)?.delivery);
  if (!map || !topic || !Object.hasOwn(map, topic)) return null;
  const value = map[topic];
  return DELIVERIES.includes(value) ? value : null;
}

/**
 * Tyypit, jotka läpäisevät rauhoitusajan: herätykseen ja lähtöön sidotut
 * sekä käyttäjän itse kalenteriin kirjaaman menon alku (kuten lähtöketju:
 * sovittu aika, jolloin käyttäjä on hereillä).
 */
export const QUIET_PASS_TYPES = Object.freeze([
  NOTIFICATION_TYPE.DEPARTURE_REMINDER,
  ...DEPARTURE_CHAIN_TYPES,
  NOTIFICATION_TYPE.MORNING_BRIEF,
  NOTIFICATION_TYPE.EVENT_START,
  // Oma aamu herätyksen jälkeen: käyttäjä on hereillä ja on itse valinnut vaiheet.
  NOTIFICATION_TYPE.MORNING_STEP
]);

/**
 * Oman yön alku: iltarauhoittuminen ja nukkumaanmeno.
 *
 * SÄÄNTÖ: nämä kaksi läpäisevät rauhoitusajan käyttäjän valitsemalla
 * toimitustavalla (myös puheena). Rauhoitusaika suojaa käyttäjän yötä, ja
 * juuri nämä muistutukset aloittavat sen: kun rauhoitusaika alkaa ennen
 * nukkumaanmenoa tai samaan aikaan (oletus 22.00, nukkumaan 22.30),
 * valittu "Puhe" ei saa hiljentyä. Muistutuksia tulee vain, kun käyttäjä
 * on kertonut rytminsä, eikä oletustapa puhu.
 */
export const NIGHT_START_TYPES = Object.freeze([
  NOTIFICATION_TYPE.WIND_DOWN,
  NOTIFICATION_TYPE.BEDTIME
]);

export const QUIET_DECISION = Object.freeze({
  /** Ei rauhoitusaikaa tai läpäisee sen. */
  PASS: 'pass',
  /** Näytetään, mutta äänettömästi. */
  SILENT: 'silent',
  /** Ei näytetä. */
  DROP: 'drop'
});

/**
 * Mitä rauhoitusaika tekee muistutukselle.
 *
 * Kriittinen, lähtö ja aamun kooste (herätyksen jälkeen) läpäisevät:
 * käyttäjä on silloin hereillä tai hänen pitää olla. Iltarauhoittuminen ja
 * nukkumaanmeno (NIGHT_START_TYPES) läpäisevät myös: ne aloittavat käyttäjän
 * oman yön, jota rauhoitusaika suojaa, joten valittu toimitustapa pätee.
 * Muu nukkumaanmenon aiheen muistutus näytetään äänettömästi. Kaikki muu odottaa.
 */
export function quietDecision(intent, quietHours) {
  const { level, type, topic, time } = safeObject(intent) || {};
  if (!isTimeOfDay(time) || !isQuietTime(time, quietHours)) return QUIET_DECISION.PASS;
  if (level === LEVEL.CRITICAL) return QUIET_DECISION.PASS;
  if (QUIET_PASS_TYPES.includes(type) || topic === REMINDER_TOPIC.DEPARTURE) return QUIET_DECISION.PASS;
  if (NIGHT_START_TYPES.includes(type)) return QUIET_DECISION.PASS;
  if (topic === REMINDER_TOPIC.BEDTIME) return QUIET_DECISION.SILENT;
  return QUIET_DECISION.DROP;
}

/**
 * Päätä muistutuksen toimitustapa.
 *
 * Järjestys:
 *   1. käyttäjän valinta aiheelle (settings.delivery[topic]), muuten
 *      DEFAULT_DELIVERY[topic], muuten tason oletus
 *   2. taso rajaa voimakkuuden (Tieto = hiljainen)
 *   3. puhe vain, jos settings.speechEnabled === true; muuten puhe
 *      vaihtuu ääneksi (voimistuva hälytys säilyy, mutta ei puhu)
 *   4. rauhoitusaika (jos time ja quietHours annettu)
 *
 * Ei koskaan heitä. Tuntematon taso käsitellään Tietona (hiljaisin).
 *
 * @returns {{topic:string|null, delivery:string, speak:boolean, allowed:boolean,
 *            quiet:boolean, source:string, reason:string}}
 */
export function resolveDelivery(input) {
  const {
    topic = null, level = null, type = null, time = null, settings = null, quietHours = null
  } = safeObject(input) || {};
  const lvl = LEVEL_VALUES.includes(level) ? level : LEVEL.INFO;
  const knownTopic = REMINDER_TOPICS.includes(topic) ? topic : topicForType(type);

  const override = overrideFor(settings, knownTopic);
  let source = 'level';
  let delivery;
  if (override) {
    delivery = override;
    source = 'setting';
  } else if (knownTopic && DEFAULT_DELIVERY[knownTopic]) {
    delivery = DEFAULT_DELIVERY[knownTopic];
    source = 'default';
  } else {
    delivery = fallbackForLevel(lvl);
  }

  delivery = capDelivery(delivery, lvl);

  const speechEnabled = safeObject(settings)?.speechEnabled === true;
  if (!speechEnabled && (delivery === DELIVERY.SPEECH || delivery === DELIVERY.SOUND_AND_SPEECH)) {
    delivery = DELIVERY.SOUND;
  }
  let speak = speechEnabled && deliverySpeaks(delivery);

  let allowed = true;
  let quiet = false;
  let reason = '';
  const decision = quietDecision({ level: lvl, type, topic: knownTopic, time }, quietHours);
  if (isTimeOfDay(time) && isQuietTime(time, quietHours)) {
    quiet = true;
    if (decision === QUIET_DECISION.PASS) {
      if (lvl === LEVEL.CRITICAL) reason = 'Kriittinen muistutus tulee myös rauhoitusaikana.';
      else if (NIGHT_START_TYPES.includes(type)) {
        reason = 'Iltarauhoittuminen ja nukkumaanmeno aloittavat oman yösi: ne tulevat valitsemallasi tavalla myös rauhoitusaikana.';
      } else if (type === NOTIFICATION_TYPE.EVENT_START) {
        reason = 'Kalenteriin kirjaamasi menon alku tulee myös rauhoitusaikana.';
      } else reason = 'Lähtöön tai herätykseen liittyvä muistutus tulee myös rauhoitusaikana.';
    } else if (decision === QUIET_DECISION.SILENT) {
      delivery = DELIVERY.SILENT;
      speak = false;
      reason = 'Rauhoitusaika: muistutus näytetään äänettömästi.';
    } else {
      allowed = false;
      reason = 'Rauhoitusaika: muistutus odottaa.';
    }
  }

  return Object.freeze({ topic: knownTopic ?? null, delivery, speak, allowed, quiet, source, reason });
}

// =====================================================================
// OHJAUSTYYLI
// =====================================================================

/**
 * Ohjaustyylin vaikutukset. VAIN nämä kolme asiaa muuttuvat:
 *   leadMultiplier  pehmeiden ennakkojen kerroin (tehtävän ja rutiinin
 *                   ennakko). Ei koskaan lyhennä ennakkoa. Lähtöketjun
 *                   ajat (valmistautuminen, 5 min, nyt) eivät riipu tyylistä.
 *   repeat          montako kertaa "lähde nyt" toistetaan, jos sitä ei kuitata
 *   wording         lauseiden sävy (spokenPhrases)
 * Rauhoitusaika, toimitustapa, puheen lupa ja yksityisyys eivät kuulu tänne.
 */
export const GUIDANCE_EFFECTS = Object.freeze({
  [GUIDANCE_STYLE.CALM]: Object.freeze({
    style: GUIDANCE_STYLE.CALM, leadMultiplier: 1, repeat: 0, repeatAfterMinutes: null, wording: GUIDANCE_STYLE.CALM
  }),
  [GUIDANCE_STYLE.BRISK]: Object.freeze({
    style: GUIDANCE_STYLE.BRISK, leadMultiplier: 1, repeat: 0, repeatAfterMinutes: null, wording: GUIDANCE_STYLE.BRISK
  }),
  [GUIDANCE_STYLE.ACTIVE]: Object.freeze({
    style: GUIDANCE_STYLE.ACTIVE, leadMultiplier: 1.5, repeat: 1, repeatAfterMinutes: 3, wording: GUIDANCE_STYLE.ACTIVE
  })
});

/** Kelvollinen ohjaustyyli: annettu, asetusten tai oletus (rauhallinen). */
export function resolveGuidanceStyle(style, settings = null) {
  if (GUIDANCE_STYLES.includes(style)) return style;
  const fromSettings = safeObject(settings)?.guidanceStyle;
  return GUIDANCE_STYLES.includes(fromSettings) ? fromSettings : GUIDANCE_STYLE.CALM;
}

/** Tyylin vaikutukset. Tuntematon tyyli = rauhallinen. */
export function guidanceEffects(style) {
  return GUIDANCE_EFFECTS[GUIDANCE_STYLES.includes(style) ? style : GUIDANCE_STYLE.CALM];
}

/**
 * Pehmeä ennakko tyylin mukaan (esim. tehtävän muistutus 10 min ennen).
 * Tuntematon ennakko pysyy tuntemattomana (null), ei nollaksi.
 * Tulos ei ole koskaan pienempi kuin annettu eikä suurempi kuin `max`.
 */
export function scaleLeadMinutes(baseMinutes, style, max = 240) {
  if (!Number.isInteger(baseMinutes) || baseMinutes < 0) return null;
  const limit = Number.isInteger(max) && max >= 0 ? max : 240;
  const scaled = Math.round(baseMinutes * guidanceEffects(style).leadMultiplier);
  return Math.min(Math.max(scaled, baseMinutes), Math.max(limit, baseMinutes));
}

// =====================================================================
// APUVÄLINEET AIKOMUKSILLE
// =====================================================================

const CORE_FIELDS = new Set(['id', 'type', 'level', 'channel', 'date', 'time', 'atMinutes', 'title',
  'body', 'targetId', 'reason', 'topic', 'delivery', 'speech', 'ackKey', 'anchor']);

function isIntentLike(intent) {
  return Boolean(intent) && typeof intent === 'object'
    && typeof intent.id === 'string' && intent.id.length > 0
    && isIsoDate(intent.date) && isTimeOfDay(intent.time)
    && LEVEL_VALUES.includes(intent.level);
}

function ackKeyOf(intent) {
  return typeof intent.ackKey === 'string' && intent.ackKey ? intent.ackKey : intent.id;
}

/** Jäädytetty kopio. Syötettä ei jäädytetä eikä muuteta. */
function frozenCopy(intent) {
  if (Object.isFrozen(intent)) return intent;
  const copy = { ...intent };
  if (copy.atMinutes === undefined || copy.atMinutes === null) copy.atMinutes = toMinutes(intent.time);
  return Object.freeze(copy);
}

/** Muodosta aikomus uudelleen muutetuin kentin (lisäkentät säilyvät). */
function rebuild(intent, overrides) {
  const extra = {};
  for (const [key, value] of Object.entries(intent)) {
    if (!CORE_FIELDS.has(key)) extra[key] = value;
  }
  for (const [key, value] of Object.entries(overrides.extra || {})) extra[key] = value;
  return createIntent({
    id: intent.id,
    type: intent.type,
    level: intent.level,
    date: intent.date,
    time: intent.time,
    title: intent.title,
    body: intent.body,
    targetId: intent.targetId,
    reason: intent.reason,
    topic: intent.topic ?? null,
    delivery: intent.delivery ?? null,
    speech: intent.speech ?? null,
    ackKey: ackKeyOf(intent),
    anchor: intent.anchor ?? null,
    ...overrides,
    extra
  });
}

/**
 * Deterministinen duplikaattien poisto: samasta tunnisteesta säilyy
 * tärkein (taso, aikaisin aika, sitten sisältö). Ei riipu syötteen järjestyksestä.
 */
function dedupeById(intents) {
  const byId = new Map();
  for (const intent of intents) {
    const existing = byId.get(intent.id);
    if (!existing) { byId.set(intent.id, intent); continue; }
    const order = compareIntents(intent, existing);
    const better = order === 0 ? stableText(intent) < stableText(existing) : order < 0;
    if (better) byId.set(intent.id, intent);
  }
  return [...byId.values()];
}

/** Sisältö tekstinä tasapelin ratkaisuun. Ei heitä (esim. BigInt-kenttä). */
function stableText(intent) {
  try {
    return JSON.stringify(intent) ?? '';
  } catch {
    return '';
  }
}

function validIntents(intents) {
  if (!Array.isArray(intents)) return [];
  const out = [];
  for (const intent of intents) if (isIntentLike(intent)) out.push(intent);
  return out;
}

function finish(list) {
  return Object.freeze([...list].sort(compareIntents));
}

// =====================================================================
// HYVINVOINNIN VALINNAISET AIHEET JA KUORMA (aalto L)
// =====================================================================
//
// Hyvinvointi on valinnaista tukea, ei tehtävälista. Kolme sääntöä:
//
//   1. AIHE POIS. Käyttäjä voi kytkeä valinnaisen aiheen kokonaan pois
//      (life_settings.delivery[aihe] = 'off'). Vain se aihe poistuu:
//      vesi pois ei vie aterioita, ateriat pois ei vie vettä.
//   2. VESI JA LISÄRAVINTEET KOOSTEESEEN. Ne ovat vähäisiä muistutuksia ja
//      kelpaavat koosteeseen (isDigestible), kun kooste on päällä. Ne eivät
//      koskaan ohita koostetta. Ateria ja ruokailun iltaraja pysyvät
//      hetkeen sidottuina.
//   3. KORKEA KUORMA KEVENTÄÄ. Kun kuorma on korkea (reminderLoadLevel:
//      päivän stressi >= 4 tai energia <= 2, viikon aikakuormitus tai
//      kapasiteetin ylivuoto), valinnaiset kehotteet (vesi, lisäravinteet,
//      tavat, liikunta, kirjauskehotteet) siirtyvät koosteeseen, jos se on
//      päällä, ja muuten jäävät tältä päivältä pois. Välttämättömät (lähtö,
//      herätys, nukkumaanmeno, määräajat ja laskut, menot, tehtävät) ja
//      aikomus, jolla on `essential: true` (esim. välttämätön lääke, jos
//      sellainen käsite myöhemmin tulee), eivät muutu.

export const LOAD_LEVEL = Object.freeze({ NORMAL: 'normal', HIGH: 'high' });

/** Korkean kuorman kynnykset (päivän hyvinvointimerkintä, asteikko 1–5). */
export const LOAD_RULES = Object.freeze({
  /** Stressi vähintään tämä = korkea kuorma. */
  HIGH_STRESS_MIN: 4,
  /** Energia enintään tämä = korkea kuorma. */
  LOW_ENERGY_MAX: 2
});

/** Aiheet, joita korkea kuorma keventää (ateriat eivät kuulu: syöminen on perustarve). */
export const LOAD_SUPPRESSIBLE_TOPICS = Object.freeze([
  OPTIONAL_TOPIC.WATER, OPTIONAL_TOPIC.SUPPLEMENT, OPTIONAL_TOPIC.HABIT,
  OPTIONAL_TOPIC.EXERCISE, OPTIONAL_TOPIC.CHECKIN
]);

/**
 * Aikomuksen hyvinvoinnin valinnainen aihe tai null (ei valinnainen).
 * Järjestys: aikomuksen oma `optionalTopic` (tulevat tuottajat: liikunta,
 * kirjauskehotteet), ateriarytmin alalaji (vesi, lisäravinne), ateria,
 * tapojen muutos.
 */
export function optionalTopicOf(intent) {
  const source = safeObject(intent);
  if (!source) return null;
  if (OPTIONAL_TOPICS.includes(source.optionalTopic)) return source.optionalTopic;
  if (source.type === NOTIFICATION_TYPE.MEAL) {
    if (source.mealKind === MEAL_ITEM_KIND.WATER) return OPTIONAL_TOPIC.WATER;
    if (source.mealKind === MEAL_ITEM_KIND.SUPPLEMENT) return OPTIONAL_TOPIC.SUPPLEMENT;
    return OPTIONAL_TOPIC.MEAL;
  }
  if (source.type === NOTIFICATION_TYPE.HABIT) return OPTIONAL_TOPIC.HABIT;
  return null;
}

/** Vähäinen hyvinvoinnin muistutus: vesi tai lisäravinne (kelpaa koosteeseen). */
export function isLowValueWellbeing(intent) {
  const topic = optionalTopicOf(intent);
  return topic === OPTIONAL_TOPIC.WATER || topic === OPTIONAL_TOPIC.SUPPLEMENT;
}

/** Valinnainen kehote, jota korkea kuorma saa keventää. Kriittistä tai välttämätöntä ei koskaan. */
export function isOptionalPrompt(intent) {
  const source = safeObject(intent);
  if (!source || source.essential === true || source.level === LEVEL.CRITICAL) return false;
  return LOAD_SUPPRESSIBLE_TOPICS.includes(optionalTopicOf(source));
}

/** Käyttäjän pois kytkemät valinnaiset aiheet (life_settings.delivery[aihe] = 'off'). */
export function offTopicsOf(settings) {
  const map = safeObject(safeObject(settings)?.delivery);
  const off = new Set();
  if (!map) return off;
  for (const topic of OPTIONAL_TOPICS) if (map[topic] === DELIVERY_OFF) off.add(topic);
  return off;
}

/** Poista pois kytkettyjen aiheiden aikomukset. Muut aiheet säilyvät sellaisinaan. */
export function applyTopicOff(intents, settings) {
  const list = Array.isArray(intents) ? intents : [];
  const off = offTopicsOf(settings);
  if (off.size === 0) return list;
  return list.filter(intent => !off.has(optionalTopicOf(intent)));
}

/**
 * Muistutusten kuormataso. Korkea, kun jokin näistä:
 *   - päivän hyvinvointimerkinnän stressi >= HIGH_STRESS_MIN tai energia <= LOW_ENERGY_MAX
 *   - viikon aikakuormitus (Suunnan OVERLOAD, ei tiedoksi-tasoa)
 *   - kapasiteetin ylivuoto (sovelluskerroksen lippu)
 * Tuntematon ei ole korkea: ilman tietoa muistutukset pysyvät ennallaan.
 */
export function reminderLoadLevel({ wellbeingEntry = null, weekOverloaded = false, capacityOverflow = false } = {}) {
  const entry = safeObject(wellbeingEntry);
  const stress = entry && Number.isFinite(entry.stress) ? entry.stress : null;
  const energy = entry && Number.isFinite(entry.energy) ? entry.energy : null;
  const strained = (stress !== null && stress >= LOAD_RULES.HIGH_STRESS_MIN)
    || (energy !== null && energy <= LOAD_RULES.LOW_ENERGY_MAX);
  return strained || weekOverloaded === true || capacityOverflow === true ? LOAD_LEVEL.HIGH : LOAD_LEVEL.NORMAL;
}

// =====================================================================
// KOOSTE
// =====================================================================

/**
 * Hetkeen sidotut tyypit: niiden arvo katoaa, jos ne siirretään koosteen
 * aikaan. Ne eivät mene koosteeseen tasosta riippumatta.
 */
export const DIGEST_BYPASS_TYPES = Object.freeze([
  NOTIFICATION_TYPE.TASK_REMINDER,
  NOTIFICATION_TYPE.ROUTINE_REMINDER,
  NOTIFICATION_TYPE.DEPARTURE_REMINDER,
  ...DEPARTURE_CHAIN_TYPES,
  NOTIFICATION_TYPE.WIND_DOWN,
  NOTIFICATION_TYPE.BEDTIME,
  NOTIFICATION_TYPE.MEAL,
  NOTIFICATION_TYPE.HABIT,
  NOTIFICATION_TYPE.MORNING_BRIEF,
  // Illan ennakko on hyödytön iltarauhoittumisen jälkeen: ei koosteeseen.
  NOTIFICATION_TYPE.EVENING_BEFORE,
  NOTIFICATION_TYPE.EVENT_START,
  NOTIFICATION_TYPE.MORNING_STEP,
  NOTIFICATION_TYPE.DIGEST
]);

export const DEFAULT_DIGEST_TIME = '18:00';
/** Koosteen tekstissä luetellaan enintään näin monta otsikkoa. */
export const DIGEST_MAX_TITLES = 5;
const DIGEST_TITLE_LENGTH = 40;

/**
 * Meneekö aikomus koosteeseen: vähäinen (≤ Muistutus) eikä hetkeen sidottu.
 * Aalto L: vesi ja lisäravinne ovat ateriatyyppiä, mutta vähäisiä, joten ne
 * kelpaavat koosteeseen (eivät ohita sitä kuten ateria-aika).
 */
export function isDigestible(intent) {
  return isIntentLike(intent)
    && intent.level <= LEVEL.REMINDER
    && NOTIFICATION_TYPES.includes(intent.type)
    && (!DIGEST_BYPASS_TYPES.includes(intent.type) || isLowValueWellbeing(intent))
    && intent.topic !== REMINDER_TOPIC.DEPARTURE
    && intent.snoozed !== true;
}

/** Koosteeseen kelpaava, kun korkea kuorma taittaa valinnaisen kehotteen koosteeseen. */
function foldable(intent) {
  return isIntentLike(intent) && intent.level <= LEVEL.REMINDER && intent.snoozed !== true
    && intent.topic !== REMINDER_TOPIC.DEPARTURE;
}

/**
 * Koosteen kellonaika. Jos toivottu aika osuu rauhoitusaikaan, kooste
 * tulee juuri ennen rauhoitusajan alkua — ei rauhoitusaikana.
 */
export function digestSlot(digestTime, quietHours = null) {
  const time = isTimeOfDay(digestTime) ? digestTime : DEFAULT_DIGEST_TIME;
  if (!isQuietTime(time, quietHours)) return time;
  const before = toMinutes(quietHours.from) - 1;
  return before >= 0 ? fromMinutes(before) : quietHours.to;
}

/** FNV-1a heksana: lyhyt, deterministinen sisältötunniste koosteen kuittausavaimeen. */
function contentHash(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function shortTitle(title) {
  const text = typeof title === 'string' ? title.trim() : '';
  if (text.length <= DIGEST_TITLE_LENGTH) return text;
  return text.slice(0, DIGEST_TITLE_LENGTH - 1).trimEnd() + '…';
}

function digestBody(members) {
  const titles = members.map(member => shortTitle(member.title)).filter(Boolean);
  const shown = titles.slice(0, DIGEST_MAX_TITLES);
  const rest = members.length - shown.length;
  const head = members.length === 1 ? 'Yksi pieni asia' : `${members.length} pientä asiaa`;
  const list = shown.join(', ');
  return `${head}${list ? ': ' + list : ''}${rest > 0 ? ` ja ${rest} muuta` : ''}.`;
}

/**
 * Yhdistä vähäiset muistutukset yhdeksi koosteeksi päivää kohden.
 *
 * Vain kun käyttäjä on kytkenyt koosteen (digestEnabled === true). Koosteeseen
 * menevät taso ≤ Muistutus -aikomukset, jotka eivät ole hetkeen sidottuja
 * (DIGEST_BYPASS_TYPES). Kriittinen herätys- ja lähtömuistutus ohittavat
 * koosteen aina.
 *
 * Kooste perii jäsentensä voimakkaimman toimitustavan ja puhuu vain, jos
 * jokin jäsenistä olisi puhunut. Kuittausavain sisältää jäsenten
 * tunnisteen: jos päivään tulee uusi asia, kooste on uusi eikä jo kuitattu.
 *
 * @param {Array} intents
 * @param {object} [options]
 * @param {boolean} [options.digestEnabled]
 * @param {string}  [options.digestTime]   'HH:MM', oletus 18:00
 * @param {object}  [options.quietHours]   { from, to } — kooste ei koskaan osu tänne
 * @param {string}  [options.guidanceStyle] puhutun koosteen sävy
 * @param {Iterable<string>} [options.foldIds] aalto L: valinnaiset kehotteet,
 *        jotka korkea kuorma taittaa koosteeseen (vaikka tyyppi muuten ohittaisi sen)
 * @returns {ReadonlyArray<object>}
 */
export function mergeDigest(intents, options) {
  const {
    digestEnabled = false, digestTime = DEFAULT_DIGEST_TIME, quietHours = null, guidanceStyle = null, foldIds = null
  } = safeObject(options) || {};
  const list = validIntents(intents);
  if (digestEnabled !== true) return finish(list.map(frozenCopy));

  const folded = new Set(foldIds && typeof foldIds[Symbol.iterator] === 'function' ? foldIds : []);
  const time = digestSlot(digestTime, quietHours);
  const kept = [];
  const byDate = new Map();
  for (const intent of list) {
    const digestible = isDigestible(intent) || (folded.has(intent.id) && foldable(intent));
    if (!digestible) { kept.push(frozenCopy(intent)); continue; }
    if (!byDate.has(intent.date)) byDate.set(intent.date, []);
    byDate.get(intent.date).push(intent);
  }

  const style = GUIDANCE_STYLES.includes(guidanceStyle) ? guidanceStyle : GUIDANCE_STYLE.CALM;
  for (const [date, rawMembers] of byDate) {
    const members = dedupeById(rawMembers).sort(compareIntents);
    const level = members.reduce((max, member) => Math.max(max, member.level), LEVEL.INFO);
    let delivery = null;
    for (const member of members) {
      if (!DELIVERIES.includes(member.delivery)) continue;
      if (delivery === null || DELIVERY_RANK[member.delivery] > DELIVERY_RANK[delivery]) delivery = member.delivery;
    }
    if (delivery !== null) delivery = capDelivery(delivery, level);
    const speaks = members.some(member => typeof member.speech === 'string' && member.speech);
    const mergedAckKeys = [...new Set(members.map(ackKeyOf))].sort((a, b) => a.localeCompare(b, 'fi'));
    const mergedIds = members.map(member => member.id).sort((a, b) => a.localeCompare(b, 'fi'));

    const digest = createIntent({
      id: intentId(NOTIFICATION_TYPE.DIGEST, 'kooste', date),
      type: NOTIFICATION_TYPE.DIGEST,
      level,
      date,
      time,
      title: 'Päivän kooste',
      body: digestBody(members),
      targetId: date,
      reason: members.length === 1
        ? 'Vähäinen muistutus siirrettiin päivän koosteeseen.'
        : `${members.length} vähäistä muistutusta yhdistettiin yhdeksi koosteeksi.`,
      topic: null,
      delivery,
      speech: speaks ? spokenPhrase(NOTIFICATION_TYPE.DIGEST, { style, count: members.length }) : null,
      ackKey: `${NOTIFICATION_TYPE.DIGEST}:${date}:${contentHash(mergedAckKeys.join('\n'))}`,
      extra: { mergedIds, mergedAckKeys, mergedCount: members.length }
    });
    if (digest) kept.push(digest);
  }
  return finish(kept);
}

// =====================================================================
// KUITTAUKSET
// =====================================================================

function compareLocal(date, time, local) {
  if (date !== local.date) return date < local.date ? -1 : 1;
  if (time !== local.time) return time < local.time ? -1 : 1;
  return 0;
}

/**
 * Poista jo käsitellyt ja kunnioita torkkuja.
 *
 *   kuitattu / hylätty    -> poistetaan (myös saman avaimen toistot)
 *   näytetty / avattu     -> säilyy (ei vielä käsitelty)
 *   torkussa, paikallinen päättymisaika tiedossa
 *                         -> ennen torkun loppua olevat poistetaan ja
 *                            torkun loppuun ajastetaan YKSI korvaava
 *                            muistutus (tunniste + ':torkku', sama avain)
 *   torkussa, vain ms tiedossa ja nowMs < loppu
 *                         -> poistetaan (ei voida ajastaa uudelleen)
 *   kooste, jonka kaikki jäsenet on käsitelty -> poistetaan
 *
 * @param {Array} intents
 * @param {object} ackLog  notificationAck-loki (tai tallennettu JSON)
 * @param {object} [options]
 * @param {number} [options.nowMs] nykyhetki millisekunteina
 */
export function applyAcks(intents, ackLog, options) {
  const { nowMs = null } = safeObject(options) || {};
  const list = validIntents(intents);
  const index = ackIndex(ackLog);
  if (index.size === 0) return finish(list.map(frozenCopy));

  const kept = [];
  const snoozedTemplates = new Map();
  for (const intent of list) {
    const key = ackKeyOf(intent);
    const entry = index.get(key) || null;
    if (entryHandled(entry)) continue;

    if (intent.type === NOTIFICATION_TYPE.DIGEST && Array.isArray(intent.mergedAckKeys)
      && intent.mergedAckKeys.length > 0
      && intent.mergedAckKeys.every(member => entryHandled(index.get(member) || null))) continue;

    if (entry && entry.snoozedUntil !== null) {
      const local = entry.snoozedUntilLocal;
      if (local) {
        if (compareLocal(intent.date, intent.time, local) < 0) {
          const current = snoozedTemplates.get(key);
          if (!current || compareIntents(intent, current) < 0) snoozedTemplates.set(key, intent);
          continue;
        }
      } else if (Number.isFinite(nowMs) && nowMs < entry.snoozedUntil) {
        continue;
      }
    }
    kept.push(frozenCopy(intent));
  }

  const keptIds = new Set(kept.map(intent => intent.id));
  for (const [key, template] of snoozedTemplates) {
    const local = index.get(key).snoozedUntilLocal;
    const replacement = rebuild(template, {
      id: `${template.id}:torkku`,
      date: local.date,
      time: local.time,
      anchor: null,
      ackKey: key,
      reason: 'Torkutettu muistutus.',
      extra: { snoozed: true, snoozedFromId: template.id }
    });
    if (replacement && !keptIds.has(replacement.id)) {
      kept.push(replacement);
      keptIds.add(replacement.id);
    }
  }
  return finish(kept);
}

// =====================================================================
// PÄIVÄRAJA
// =====================================================================

/**
 * Muistutuksen arvo päivärajassa (suurempi säilyy ensin).
 *
 *   PROTECTED  aikaan sidotut sitoumukset ja yön suoja: lähtöketju ja
 *              matkan lähtö, iltarauhoittuminen ja nukkumaanmeno,
 *              määräaika, menon alku, illan ennakko ja aamun kooste
 *   NORMAL     tavallinen muistutus: tehtävä, rutiini, ateria, tapa, kooste
 *   LOW        vähäinen: vesitauko, päivän suunnitelma, illan katsaus ja
 *              kaikki Tieto-tason muistutukset
 *
 * Herätys ei ole tässä putkessa (oma laitemerkintänsä, ei koskaan karsita),
 * ja kriittinen säilyy aina (capPerDay).
 */
export const CAP_VALUE = Object.freeze({ LOW: 1, NORMAL: 2, PROTECTED: 3 });

const PROTECTED_TYPES = Object.freeze([
  NOTIFICATION_TYPE.DEPARTURE_REMINDER,
  ...DEPARTURE_CHAIN_TYPES,
  NOTIFICATION_TYPE.WIND_DOWN,
  NOTIFICATION_TYPE.BEDTIME,
  NOTIFICATION_TYPE.DEADLINE_WARNING,
  NOTIFICATION_TYPE.EVENING_BEFORE,
  NOTIFICATION_TYPE.MORNING_BRIEF,
  NOTIFICATION_TYPE.EVENT_START
]);

const LOW_VALUE_TYPES = Object.freeze([
  NOTIFICATION_TYPE.DAILY_PLAN,
  NOTIFICATION_TYPE.EVENING_REVIEW
]);

/** Aikomuksen arvo päivärajassa (CAP_VALUE). */
export function capValue(intent) {
  const source = safeObject(intent) || {};
  if (PROTECTED_TYPES.includes(source.type)) return CAP_VALUE.PROTECTED;
  if (LOW_VALUE_TYPES.includes(source.type) || source.level === LEVEL.INFO) return CAP_VALUE.LOW;
  if (source.type === NOTIFICATION_TYPE.MEAL && source.mealKind === MEAL_ITEM_KIND.WATER) return CAP_VALUE.LOW;
  return CAP_VALUE.NORMAL;
}

/**
 * Enintään `maxPerDay` muistutusta päivää kohden. Arvokkaimmat säilyvät:
 * ensin arvo (capValue: lähtö, nukkumaanmeno ja määräaika ennen vesitaukoa),
 * sitten taso, sitten aikaisin. Näin aamun vesitauot eivät vie illan
 * nukkumaanmenoa eikä iltapäivän lähdön valmistautumista.
 * KRIITTISTÄ EI KARSITA KOSKAAN: jos kriittisiä on enemmän kuin raja,
 * kaikki ne säilyvät ja muut karsitaan. Myöhästyminen on vahinko,
 * ylimääräinen ilmoitus vain haitta.
 */
export function capPerDay(intents, maxPerDay) {
  const max = Number.isInteger(maxPerDay) && maxPerDay >= 1 ? Math.min(maxPerDay, 50) : DEFAULT_PREFERENCES.maxPerDay;
  const byDate = new Map();
  for (const intent of validIntents(intents)) {
    if (!byDate.has(intent.date)) byDate.set(intent.date, []);
    byDate.get(intent.date).push(intent);
  }
  const kept = [];
  for (const group of byDate.values()) {
    const critical = group.filter(intent => intent.level === LEVEL.CRITICAL);
    const others = group.filter(intent => intent.level !== LEVEL.CRITICAL).sort((a, b) => {
      const value = capValue(b) - capValue(a);
      if (value !== 0) return value;
      if (a.level !== b.level) return b.level - a.level;
      if (a.atMinutes !== b.atMinutes) return (a.atMinutes ?? 0) - (b.atMinutes ?? 0);
      return String(a.id).localeCompare(String(b.id), 'fi');
    });
    kept.push(...critical, ...others.slice(0, Math.max(0, max - critical.length)));
  }
  return finish(kept.map(frozenCopy));
}

// =====================================================================
// KOKO PUTKI
// =====================================================================

/**
 * Täydennä aikomukselle aihe, toimitustapa ja puhe käyttäjän asetuksista.
 * Palauttaa { intent, decision } — decision on rauhoitusajan päätös.
 */
function decorate(intent, { settings, quietHours, style }) {
  const topic = REMINDER_TOPICS.includes(intent.topic) ? intent.topic : topicForType(intent.type);
  const resolved = resolveDelivery({
    topic, level: intent.level, type: intent.type, time: intent.time, settings, quietHours
  });
  let speech = null;
  if (resolved.speak) {
    speech = typeof intent.speech === 'string' && intent.speech
      ? intent.speech
      : spokenPhrase(intent.type, {
        style,
        minutes: intent.type === NOTIFICATION_TYPE.DEPARTURE_REMINDER ? DEPARTURE_ALERT_LEAD_MINUTES : undefined
      });
  }
  const decision = quietDecision({ level: intent.level, type: intent.type, topic, time: intent.time }, quietHours);
  const next = { ...intent, topic, delivery: resolved.delivery, speech };
  if (next.atMinutes === undefined || next.atMinutes === null) next.atMinutes = toMinutes(intent.time);
  if (!next.ackKey) next.ackKey = intent.id;
  if (next.anchor === undefined) next.anchor = null;
  return { intent: Object.freeze(next), decision };
}

/**
 * Koko toimituspolitiikka yhdellä kutsulla.
 *
 *   1. kelvottomat pois, duplikaatit pois (deterministisesti)
 *   2. aihe, toimitustapa ja puhe asetuksista (resolveDelivery)
 *   3. kuittaukset ja torkut (applyAcks)
 *   4. kooste (mergeDigest) — myös rauhoitusajan takia odottamaan jäävät
 *      vähäiset muistutukset päätyvät koosteeseen eivätkä katoa; koosteen
 *      oma kuittaus ja torkku tarkistetaan heti sen synnyttyä
 *   5. rauhoitusaika: pudotetaan ne, jotka eivät läpäise
 *   6. päiväraja (capPerDay, preferences.maxPerDay)
 *
 * @param {Array} intents planNotifications- ja dailyReminders-aikomukset
 * @param {object} [options]
 * @param {object} [options.settings]     life_settings (delivery, speechEnabled, digest*, guidanceStyle)
 * @param {object} [options.preferences]  notification_preferences (quietHours, maxPerDay)
 * @param {object} [options.ackLog]       kuittausloki
 * @param {number} [options.nowMs]        nykyhetki (torkkujen tulkintaan)
 * @param {string} [options.guidanceStyle] ohittaa settings.guidanceStyle
 * @param {string} [options.loadLevel]    aalto L: LOAD_LEVEL.HIGH keventää valinnaiset
 *        kehotteet (koosteeseen, jos se on päällä; muuten pois). Oletus normaali.
 * @param {Array<string>} [options.loadDates] päivät, joita korkea kuorma koskee
 *        (esim. vain tämä päivä); null = kaikki päivät
 * @returns {ReadonlyArray<object>} jäädytetyt aikomukset aikajärjestyksessä
 */
export function applyNotificationPolicy(intents, options) {
  const {
    settings = null, preferences = null, ackLog = null, nowMs = null, guidanceStyle = null,
    loadLevel = LOAD_LEVEL.NORMAL, loadDates = null
  } = safeObject(options) || {};
  const prefs = normalizePreferences(safeObject(preferences) || {});
  const style = resolveGuidanceStyle(guidanceStyle, settings);
  const quietHours = prefs.quietHours;

  // Aalto L: käyttäjän pois kytkemät valinnaiset aiheet eivät tule lainkaan.
  const decorated = applyTopicOff(dedupeById(validIntents(intents)), settings)
    .map(intent => decorate(intent, { settings, quietHours, style }).intent);

  const acked = applyAcks(decorated, ackLog, { nowMs });

  const digestEnabled = safeObject(settings)?.digestEnabled === true;
  const digestTime = isTimeOfDay(safeObject(settings)?.digestTime) ? settings.digestTime : DEFAULT_DIGEST_TIME;

  // Torkun korvaaja voi olla uusi aikomus: sekin koristellaan.
  // Korkea kuorma: valinnaiset kehotteet koosteeseen (jos päällä) tai pois.
  const highLoad = loadLevel === LOAD_LEVEL.HIGH;
  const loadDays = Array.isArray(loadDates) ? new Set(loadDates.filter(isIsoDate)) : null;
  const foldIds = new Set();
  const redecorated = [];
  for (const intent of acked) {
    if (highLoad && (!loadDays || loadDays.has(intent.date)) && isOptionalPrompt(intent)) {
      if (!digestEnabled || !foldable(intent)) continue;
      foldIds.add(intent.id);
    }
    redecorated.push(decorate(intent, { settings, quietHours, style }));
  }
  const canDigest = intent => isDigestible(intent) || (foldIds.has(intent.id) && foldable(intent));

  // Koosteeseen menevät vähäiset myös silloin, kun rauhoitusaika pidättäisi
  // ne. Muut rauhoitusajan pidättämät pudotetaan vasta koosteen jälkeen.
  const candidates = redecorated
    .filter(({ intent, decision }) => decision !== QUIET_DECISION.DROP || (digestEnabled && canDigest(intent)))
    .map(({ intent }) => intent);

  const merged = mergeDigest(candidates, { digestEnabled, digestTime, quietHours, guidanceStyle: style, foldIds });

  // Kooste syntyy vasta tässä, joten sen oma kuittaus ja torkku
  // tarkistetaan uudelleen. Muille toinen kierros ei muuta mitään.
  const settled = digestEnabled ? applyAcks(merged, ackLog, { nowMs }) : merged;

  const audible = settled.filter(intent => quietDecision({
    level: intent.level, type: intent.type, topic: intent.topic, time: intent.time
  }, quietHours) !== QUIET_DECISION.DROP);

  return capPerDay(audible, prefs.maxPerDay);
}
