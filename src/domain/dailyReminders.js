// Arjen muistutukset: lähtöketju, iltarauhoittuminen, nukkumaanmeno,
// ateriat, tapojen muutos, illan ja aamun kooste.
//
// PUHDAS MODUULI. Ei kelloa (tämä päivä annetaan), ei DOM:ia, ei alustaa.
// Moduuli ei laske lähtöaikoja, unta eikä aterioita itse: ne tulevat omista
// moottoreistaan valmiina hetkinä. Tämä moduuli muuttaa hetket
// ilmoitusaikomuksiksi (notification.createIntent), valitsee tason,
// aiheen, toimitustavan ja puhutun lauseen.
//
// LÄHTÖKETJU
//   valmistautuminen alkaa   taso Muistutus     "Valmistaudu lähtöön."
//   5 min ennen lähtöä       taso Toiminta nyt  "Viiden minuutin päästä pitää lähteä."
//   lähtöaika                taso Kriittinen    "Nyt kannattaa lähteä, jotta olet
//                                                hyvissä ajoin paikalla."
// Tuntematon matka-aika EI tuota ketjua: arvattu lähtöaika olisi
// vaarallisempi kuin hiljaisuus (sama periaate kuin travel.js:ssä).
//
// KESÄAIKA
// Aikomuksen päivä ja kellonaika ovat seinäkelloaikaa (järjestys,
// rauhoitusaika, näyttö). Jokainen ketjun aikomus kantaa lisäksi ankkurin:
// saapumistavoite (tai lähtö) ja siirtymä minuutteina. Alusta laskee
// ilmoitushetken ankkurista TODELLISINA minuutteina, joten "5 min ennen
// lähtöä" on viisi oikeaa minuuttia myös kesäajan vaihtoyönä.

import { REMINDER_TOPIC, HABIT_KIND, MAX_PREPARATION_MINUTES, MAX_REMINDER_OFFSET_MINUTES } from './dailyLife.js';
import { NOTIFICATION_TYPE, LEVEL, createIntent, compareIntents, intentId } from './notification.js';
import {
  resolveDelivery, resolveGuidanceStyle, guidanceEffects, wallClockMinutes, wallClockAt
} from './notificationPolicy.js';
import { spokenPhrase, PHRASE_REPEAT_LEAVE_NOW } from './spokenPhrases.js';
import { isIsoDate, isTimeOfDay } from './task.js';

const EMPTY = Object.freeze([]);

/** "Lähtö pian" -vaihe minuutteina ennen lähtöä. Kiinteä: tyyli ei siirrä sitä. */
export const LEAVE_SOON_MINUTES = 5;

/** Ankkuri voi olla enintään näin kaukana lähdöstä (matka + varmuusajat). */
const MAX_ANCHOR_AFTER_LEAVE_MINUTES = 1440 + 240 + 240;
const MAX_TITLE_LENGTH = 200;
const MAX_PLACE_LENGTH = 80;
const MAX_ID_LENGTH = 200;
const MAX_ENTRIES = 2000;

// ------------------------------------------------------------ apurit

function safeObject(value) {
  return value && typeof value === 'object' ? value : null;
}

function cleanId(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text && text.length <= MAX_ID_LENGTH ? text : null;
}

function cleanText(value, max) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length <= max ? text : text.slice(0, max - 1).trimEnd() + '…';
}

/**
 * Hetki muodossa { date, time, abs }.
 * Hyväksyy 'HH:MM' (päivä `defaultDate`) tai { date, time } -olion.
 * Olion mahdollista abs-kenttää ei käytetä: se lasketaan aina itse.
 */
function pointOf(value, defaultDate) {
  if (typeof value === 'string') {
    if (!isTimeOfDay(value) || !isIsoDate(defaultDate)) return null;
    return { date: defaultDate, time: value, abs: wallClockMinutes(defaultDate, value) };
  }
  const object = safeObject(value);
  if (!object || !isIsoDate(object.date) || !isTimeOfDay(object.time)) return null;
  return { date: object.date, time: object.time, abs: wallClockMinutes(object.date, object.time) };
}

/** Pelkkä kellonaika tulkitaan viimeisimmäksi hetkeksi, joka ei ole `limit`-hetken jälkeen. */
function pointNotAfter(value, limit) {
  const point = pointOf(value, limit.date);
  if (!point) return null;
  if (typeof value === 'string' && point.abs > limit.abs) return atAbs(point.abs - 1440);
  return point;
}

/** Pelkkä kellonaika tulkitaan ensimmäiseksi hetkeksi, joka ei ole ennen `limit`-hetkeä. */
function pointNotBefore(value, limit) {
  const point = pointOf(value, limit.date);
  if (!point) return null;
  if (typeof value === 'string' && point.abs < limit.abs) return atAbs(point.abs + 1440);
  return point;
}

function atAbs(abs) {
  const wall = wallClockAt(abs);
  return wall ? { date: wall.date, time: wall.time, abs } : null;
}

/** Käyttäjän vahvistama myöhästymiskorjaus (0–60 min). Puuttuva = ei korjausta. */
function reminderOffsetOf(settings) {
  const value = safeObject(settings)?.reminderOffsetMinutes;
  return Number.isInteger(value) && value >= 0 && value <= MAX_REMINDER_OFFSET_MINUTES ? value : 0;
}

/**
 * Duplikaatit pois ja vakiojärjestys. Samasta tunnisteesta säilyy aikaisin
 * ja tärkein; täydellisessä tasapelissä sisältö ratkaisee, joten tulos ei
 * riipu syötteen järjestyksestä.
 */
function sortedUnique(intents) {
  const byId = new Map();
  for (const intent of intents) {
    if (!intent) continue;
    const existing = byId.get(intent.id);
    if (!existing) { byId.set(intent.id, intent); continue; }
    const order = compareIntents(intent, existing);
    if (order < 0 || (order === 0 && JSON.stringify(intent) < JSON.stringify(existing))) byId.set(intent.id, intent);
  }
  return Object.freeze([...byId.values()].sort(compareIntents));
}

function speechFor(resolved, kind, context) {
  return resolved.speak ? spokenPhrase(kind, context) : null;
}

// =====================================================================
// LÄHTÖKETJU
// =====================================================================

/**
 * Lähtöketjun muistutukset.
 *
 * Jokainen lähtö: { id, date, prepareStart, leave, title, placeName,
 * knownTravel, arrivalTarget?, eventStart? }
 *   - leave ja prepareStart: 'HH:MM' (päivällä `date`) tai { date, time }.
 *     Pelkkä kellonaika, joka on myöhempi kuin lähtö, tarkoittaa edellistä
 *     päivää (valmistautuminen alkaa ennen keskiyötä, lähtö sen jälkeen).
 *   - knownTravel: vain arvo true tuottaa ketjun. Tuntematon matka-aika ei
 *     tuota yhtään ajastettua muistutusta.
 *   - arrivalTarget / eventStart (vapaaehtoinen): ankkuri, josta
 *     ilmoitushetket lasketaan todellisina minuutteina (kesäaika).
 *
 * Säännöt:
 *   - Valmistautumismuistutus jää pois, jos valmistautumista on enintään
 *     viisi minuuttia: "lähtö 5 min päästä" kattaa sen.
 *   - settings.reminderOffsetMinutes (käyttäjän vahvistama myöhästymis-
 *     korjaus) aikaistaa KOKO ketjua. Lähtömoottori ei saa lisätä sitä
 *     lähtöaikaan itse, muuten korjaus tulisi kahdesti.
 *   - Ohjaustyyli muuttaa vain sanamuotoa ja toistoa: aktiivinen tyyli
 *     toistaa "lähde nyt" -muistutuksen kerran (sama kuittausavain, joten
 *     kuittaus poistaa myös toiston). Ajat eivät muutu.
 *   - todayIso: aiemmille päiville osuvia muistutuksia ei tuoteta.
 *
 * @returns {ReadonlyArray<object>} jäädytetyt aikomukset aikajärjestyksessä
 */
export function planDepartureChain(input) {
  const { departures = null, settings = null, guidanceStyle = null, todayIso = null } = safeObject(input) || {};
  if (!Array.isArray(departures)) return EMPTY;
  const style = resolveGuidanceStyle(guidanceStyle, settings);
  const effects = guidanceEffects(style);
  const offset = reminderOffsetOf(settings);
  const today = isIsoDate(todayIso) ? todayIso : null;

  const intents = [];
  for (const departure of departures.slice(0, MAX_ENTRIES)) {
    try {
      intents.push(...chainFor(departure, { settings, style, effects, offset, today }));
    } catch {
      // Yksi viallinen lähtö ei saa viedä muiden muistutuksia.
    }
  }
  return sortedUnique(intents);
}

function chainFor(departure, { settings, style, effects, offset, today }) {
  const source = safeObject(departure);
  if (!source || source.knownTravel !== true) return [];
  const id = cleanId(source.id);
  if (!id) return [];

  const baseDate = isIsoDate(source.date) ? source.date : null;
  const leave = pointOf(source.leave, baseDate);
  if (!leave) return [];

  let prepare = source.prepareStart === null || source.prepareStart === undefined
    ? null : pointNotAfter(source.prepareStart, leave);
  if (prepare && (prepare.abs > leave.abs || leave.abs - prepare.abs > MAX_PREPARATION_MINUTES)) prepare = null;

  let anchor = leave;
  for (const candidate of [source.arrivalTarget, source.eventStart]) {
    if (candidate === null || candidate === undefined) continue;
    const point = pointNotBefore(candidate, leave);
    if (point && point.abs >= leave.abs && point.abs - leave.abs <= MAX_ANCHOR_AFTER_LEAVE_MINUTES) {
      anchor = point;
      break;
    }
  }

  const identityDate = baseDate || leave.date;
  const title = cleanText(source.title, MAX_TITLE_LENGTH) || 'Lähtö';
  const place = cleanText(source.placeName, MAX_PLACE_LENGTH);
  const placePart = place ? ` (${place})` : '';
  const offsetNote = offset > 0
    ? ` Muistutus tulee ${offset} min aiemmin oman asetuksesi mukaan.`
    : '';

  const nowAbs = leave.abs - offset;
  const soonAbs = nowAbs - LEAVE_SOON_MINUTES;
  let prepareAbs = prepare ? prepare.abs - offset : null;
  // Enintään viiden minuutin valmistautuminen: "lähtö pian" korvaa sen.
  if (prepareAbs !== null && prepareAbs >= soonAbs) prepareAbs = null;

  const steps = [];
  if (prepareAbs !== null) {
    steps.push({
      step: 'prepare',
      type: NOTIFICATION_TYPE.DEPARTURE_PREPARE,
      level: LEVEL.REMINDER,
      topic: REMINDER_TOPIC.PREPARATION,
      abs: prepareAbs,
      title: 'Valmistaudu lähtöön',
      body: `${title}: lähtö klo ${leave.time}${placePart}.`,
      reason: `Valmistautuminen alkaa, jotta ehdit lähteä klo ${leave.time}.${offsetNote}`,
      phrase: NOTIFICATION_TYPE.DEPARTURE_PREPARE
    });
  }
  steps.push({
    step: 'soon',
    type: NOTIFICATION_TYPE.DEPARTURE_LEAVE_IN_5,
    level: LEVEL.ACTION,
    topic: REMINDER_TOPIC.DEPARTURE,
    abs: soonAbs,
    title: `Lähtö ${LEAVE_SOON_MINUTES} minuutin päästä`,
    body: `${title}: lähde klo ${leave.time}${placePart}.`,
    reason: `Lähtöön on ${LEAVE_SOON_MINUTES} minuuttia.${offsetNote}`,
    phrase: NOTIFICATION_TYPE.DEPARTURE_LEAVE_IN_5
  });
  steps.push({
    step: 'now',
    type: NOTIFICATION_TYPE.DEPARTURE_LEAVE_NOW,
    level: LEVEL.CRITICAL,
    topic: REMINDER_TOPIC.DEPARTURE,
    abs: nowAbs,
    title: 'Nyt on lähdön aika',
    body: `${title}: lähde nyt${placePart}.`,
    reason: `Lähtöaika, jolla ehdit perille ajoissa.${offsetNote}`,
    phrase: NOTIFICATION_TYPE.DEPARTURE_LEAVE_NOW
  });
  const repeatAfter = effects.repeatAfterMinutes;
  for (let index = 1; index <= effects.repeat && Number.isInteger(repeatAfter); index++) {
    steps.push({
      step: 'repeat',
      repeatIndex: index,
      type: NOTIFICATION_TYPE.DEPARTURE_LEAVE_NOW,
      level: LEVEL.CRITICAL,
      topic: REMINDER_TOPIC.DEPARTURE,
      abs: nowAbs + index * repeatAfter,
      title: 'Nyt on lähdön aika',
      body: `${title}: lähde nyt${placePart}.`,
      reason: 'Toistettu, koska lähtömuistutusta ei ole vielä kuitattu.',
      phrase: PHRASE_REPEAT_LEAVE_NOW
    });
  }

  const intents = [];
  for (const step of steps) {
    const at = wallClockAt(step.abs);
    if (!at) continue;
    if (today && at.date < today) continue;
    const baseId = intentId(step.type, id, identityDate);
    const resolved = resolveDelivery({ topic: step.topic, level: step.level, type: step.type, settings });
    const intent = createIntent({
      id: step.step === 'repeat' ? `${baseId}:toisto${step.repeatIndex}` : baseId,
      type: step.type,
      level: step.level,
      date: at.date,
      time: at.time,
      title: step.title,
      body: step.body,
      targetId: id,
      reason: step.reason,
      topic: step.topic,
      delivery: resolved.delivery,
      speech: speechFor(resolved, step.phrase, { style, minutes: LEAVE_SOON_MINUTES, time: leave.time }),
      ackKey: baseId,
      anchor: { date: anchor.date, time: anchor.time, offsetMinutes: step.abs - anchor.abs },
      extra: {
        departureId: id,
        step: step.step,
        leaveDate: leave.date,
        leaveTime: leave.time,
        placeName: place
      }
    });
    if (intent) intents.push(intent);
  }
  return intents;
}

/**
 * Päivän ensimmäinen tiedossa oleva lähtöaika 'HH:MM' tai null.
 * Illan ja aamun koosteeseen. Tuntematon matka-aika ei kelpaa.
 */
export function firstLeaveOn(departures, dateIso) {
  if (!Array.isArray(departures) || !isIsoDate(dateIso)) return null;
  let best = null;
  for (const departure of departures.slice(0, MAX_ENTRIES)) {
    const source = safeObject(departure);
    if (!source || source.knownTravel !== true) continue;
    const leave = pointOf(source.leave, isIsoDate(source.date) ? source.date : null);
    if (!leave || leave.date !== dateIso) continue;
    if (best === null || leave.abs < best.abs) best = leave;
  }
  return best ? best.time : null;
}

// =====================================================================
// MUUT ARJEN MUISTUTUKSET
// =====================================================================

export const DAILY_REMINDER_KIND = Object.freeze({
  WIND_DOWN: NOTIFICATION_TYPE.WIND_DOWN,
  BEDTIME: NOTIFICATION_TYPE.BEDTIME,
  MEAL: NOTIFICATION_TYPE.MEAL,
  HABIT: NOTIFICATION_TYPE.HABIT,
  EVENING_BEFORE: NOTIFICATION_TYPE.EVENING_BEFORE,
  MORNING_BRIEF: NOTIFICATION_TYPE.MORNING_BRIEF
});

export const DAILY_REMINDER_KINDS = Object.freeze(Object.values(DAILY_REMINDER_KIND));

const DISPLAY_TOPIC = Object.freeze({
  [DAILY_REMINDER_KIND.WIND_DOWN]: REMINDER_TOPIC.BEDTIME,
  [DAILY_REMINDER_KIND.BEDTIME]: REMINDER_TOPIC.BEDTIME,
  [DAILY_REMINDER_KIND.MEAL]: REMINDER_TOPIC.MEAL,
  [DAILY_REMINDER_KIND.HABIT]: REMINDER_TOPIC.HABIT,
  [DAILY_REMINDER_KIND.EVENING_BEFORE]: REMINDER_TOPIC.MORNING,
  [DAILY_REMINDER_KIND.MORNING_BRIEF]: REMINDER_TOPIC.MORNING
});

/** Rakenna yhden merkinnän aikomus, tai null. */
function dailyIntent(entry, { settings, style, today }) {
  const source = safeObject(entry);
  if (!source || !DAILY_REMINDER_KINDS.includes(source.kind)) return null;
  const kind = source.kind;
  if (!isIsoDate(source.date) || !isTimeOfDay(source.time)) return null;

  let at = pointOf(source.time, source.date);
  let title;
  let body;
  let reason;
  let targetId;
  let phraseContext = { style };
  const extra = {};

  switch (kind) {
    case DAILY_REMINDER_KIND.WIND_DOWN: {
      const bedtime = isTimeOfDay(source.bedtime) ? source.bedtime : null;
      title = 'Iltarauhoittuminen';
      body = bedtime ? `Nukkumaanmeno klo ${bedtime}.` : 'On hyvä hetki alkaa rauhoittua.';
      reason = 'Suunniteltu rauhoittuminen ennen nukkumaanmenoa.';
      targetId = cleanId(source.id) || 'uni';
      phraseContext = { style, bedtime };
      break;
    }
    case DAILY_REMINDER_KIND.BEDTIME: {
      const wake = isTimeOfDay(source.wakeTime) ? source.wakeTime : null;
      title = 'Nukkumaanmenoaika';
      body = wake ? `Herätys klo ${wake}.` : 'Nyt on hyvä aika mennä nukkumaan.';
      reason = 'Suunniteltu nukkumaanmeno, jotta unelle jää tavoiteltu aika.';
      targetId = cleanId(source.id) || 'uni';
      phraseContext = { style, wake };
      break;
    }
    case DAILY_REMINDER_KIND.MEAL: {
      const mealId = cleanId(source.id);
      if (!mealId) return null;
      const prep = Number.isInteger(source.prepMinutes) && source.prepMinutes > 0
        && source.prepMinutes <= MAX_PREPARATION_MINUTES ? source.prepMinutes : 0;
      const mealAt = at;
      at = atAbs(mealAt.abs - prep);
      if (!at) return null;
      title = cleanText(source.name, 80) || 'Ateria';
      body = prep > 0
        ? `Aloita valmistus nyt, niin ruoka on valmis klo ${mealAt.time}.`
        : `Ruoka-aika klo ${mealAt.time}.`;
      reason = prep > 0 ? `Valmistus vie noin ${prep} min.` : 'Suunniteltu ateria-aika.';
      targetId = mealId;
      phraseContext = { style, prep: prep > 0, time: mealAt.time };
      extra.mealId = mealId;
      extra.mealTime = mealAt.time;
      break;
    }
    case DAILY_REMINDER_KIND.HABIT: {
      const planId = cleanId(source.id);
      if (!planId) return null;
      const habitKind = source.habitKind === HABIT_KIND.NICOTINE ? HABIT_KIND.NICOTINE : HABIT_KIND.GENERIC;
      // Lukitusnäytöllä näkyy vain neutraali teksti: tavan nimi on arkaluonteinen.
      title = 'Tapojen muutos';
      body = 'Seuraava suunniteltu aika on nyt.';
      reason = 'Oma suunnitelmasi: seuraava sovittu aika.';
      targetId = `${planId}@${source.time}`;
      phraseContext = { style, habitKind };
      extra.habitPlanId = planId;
      break;
    }
    case DAILY_REMINDER_KIND.EVENING_BEFORE: {
      const firstLeave = isTimeOfDay(source.firstLeave) ? source.firstLeave : null;
      title = 'Huomisen suunnitelma';
      body = firstLeave ? `Huomenna ensimmäinen lähtö klo ${firstLeave}.` : 'Huomenna ei ole sovittuja lähtöjä.';
      reason = 'Illan katsaus huomiseen, jotta aamu sujuu ilman kiirettä.';
      targetId = 'huominen';
      phraseContext = { style, firstLeave };
      break;
    }
    case DAILY_REMINDER_KIND.MORNING_BRIEF: {
      if (safeObject(settings)?.morningBriefEnabled !== true) return null;
      const firstLeave = isTimeOfDay(source.firstLeave) ? source.firstLeave : null;
      title = 'Hyvää huomenta';
      body = firstLeave ? `Tänään ensimmäinen lähtö klo ${firstLeave}.` : 'Tänään ei ole sovittuja lähtöjä.';
      reason = 'Aamun kooste, jonka olet kytkenyt päälle.';
      targetId = 'aamu';
      phraseContext = { style, firstLeave };
      break;
    }
    default:
      return null;
  }

  if (today && at.date < today) return null;
  const topic = DISPLAY_TOPIC[kind];
  const level = LEVEL.REMINDER;
  const resolved = resolveDelivery({ topic, level, type: kind, settings });
  return createIntent({
    type: kind,
    level,
    date: at.date,
    time: at.time,
    title,
    body,
    targetId,
    reason,
    topic,
    delivery: resolved.delivery,
    speech: speechFor(resolved, kind, phraseContext),
    // Tunnisteen päivä on merkinnän oma päivä, vaikka valmistus alkaisi
    // edellisenä iltana: sama ateria = sama muistutus.
    id: intentId(kind, targetId, source.date),
    extra
  });
}

/**
 * Arjen muut muistutukset valmiista hetkistä.
 *
 * Jokainen merkintä: { kind, date, time, ... } missä kind on
 * DAILY_REMINDER_KIND:
 *   wind_down       { date, time, bedtime? }
 *   bedtime         { date, time, wakeTime? }
 *   meal            { id, date, time (ateria), prepMinutes?, name? }
 *                   -> muistutus klo time − prepMinutes ("aloita valmistus")
 *   habit           { id (suunnitelma), date, time, habitKind? }
 *   evening_before  { date, time, firstLeave? }
 *   morning_brief   { date, time, firstLeave? } — vain jos
 *                   settings.morningBriefEnabled === true
 *
 * Kaikki ovat tasoa Muistutus. Toimitustapa tulee aiheen asetuksesta, ja
 * puhe vain luvalla. Kelvoton merkintä ohitetaan hiljaa.
 *
 * @returns {ReadonlyArray<object>}
 */
export function planDailyLifeReminders(input) {
  const { entries = null, settings = null, guidanceStyle = null, todayIso = null } = safeObject(input) || {};
  if (!Array.isArray(entries)) return EMPTY;
  const style = resolveGuidanceStyle(guidanceStyle, settings);
  const today = isIsoDate(todayIso) ? todayIso : null;
  const intents = [];
  for (const entry of entries.slice(0, MAX_ENTRIES)) {
    try {
      const intent = dailyIntent(entry, { settings, style, today });
      if (intent) intents.push(intent);
    } catch {
      // Viallinen merkintä ohitetaan.
    }
  }
  return sortedUnique(intents);
}
