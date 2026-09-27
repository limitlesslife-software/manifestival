// Muistutusten domain.
//
// PUHDAS MODUULI. Ei DOM:ia, ei natiivirajapintoja, ei verkkoa, ei kelloa.
// Tämä moduuli EI lähetä yhtään ilmoitusta — se päättää mitä pitäisi lähettää
// ja milloin. Lähettäminen kuuluu alustakerrokselle.
//
// MIKSI NÄIN
// Konseptidokumentin luku 23 on yksiselitteinen: "Liiallinen ilmoittaminen
// tekee sovelluksesta helposti häiritsevän, joten järjestelmän pitää
// priorisoida ilmoitukset ja yhdistellä vähäisempiä asioita."
//
// Ilmoituslogiikka on siis tuotteen kannalta yhtä tärkeä kuin aikataulutus,
// ja yhtä lailla testattava. Jos se olisi natiivikutsujen seassa, sitä ei
// voisi testata eikä siitä voisi keskustella.
//
// NELITASOINEN ESKALAATIO (konseptin luku 23)
//   1 Tieto              käyttäjän ei tarvitse toimia
//   2 Muistutus          asia kannattaa tehdä pian
//   3 Toiminta nyt       aikataulu edellyttää välitöntä toimintaa
//   4 Kriittinen hoputus myöhästymisen tai unohtamisen riski on korkea

import { fmtISO, parseISO, addDays } from '../lib/datetime.js';
import { departureSchedule, leaveAtMinus, TRAVEL_SOURCE } from './travel.js';
import {
  toMinutes, fromMinutes, isIsoDate, isTimeOfDay,
  deadlineUrgency, isOverdue, URGENCY
} from './task.js';

export const NOTIFICATION_TYPE = Object.freeze({
  TASK_REMINDER: 'task_reminder',
  ROUTINE_REMINDER: 'routine_reminder',
  DEADLINE_WARNING: 'deadline_warning',
  /**
   * Lähtömuistutus: matkasuunnitelman (päivä, saapumisaika, tiedossa oleva
   * kesto) perusteella. EI vaadi sijaintia. Ilman tiedossa olevaa kestoa
   * mitään ei synny -- ks. planNotifications ja src/domain/travel.js.
   */
  DEPARTURE_REMINDER: 'departure_reminder',
  DAILY_PLAN: 'daily_plan',
  EVENING_REVIEW: 'evening_review',

  // ---- Arjen käyttöjärjestelmä (src/domain/dailyReminders.js) ----
  //
  // Nämä EIVÄT synny planNotifications-funktiossa: niiden lähtötiedot
  // (kalenterin lähdöt, uni, ateriat, tavat) tulevat omista moottoreistaan,
  // ja dailyReminders.js rakentaa aikomukset createIntent-funktiolla.
  // Tavallinen ilmoitus riittää niiden toimittamiseen, joten mikään niistä
  // ei ole PLANNED_TYPES-listalla.

  /** Lähtöketju 1/3: valmistautuminen alkaa (taso Muistutus). */
  DEPARTURE_PREPARE: 'departure_prepare',
  /** Lähtöketju 2/3: lähtöön viisi minuuttia (taso Toiminta nyt). */
  DEPARTURE_LEAVE_IN_5: 'departure_leave_in_5',
  /** Lähtöketju 3/3: lähde nyt (taso Kriittinen). */
  DEPARTURE_LEAVE_NOW: 'departure_leave_now',
  /** Iltarauhoittumisen alku (nukkumaanmeno − rauhoittumisaika). */
  WIND_DOWN: 'wind_down',
  /** Nukkumaanmenoaika. */
  BEDTIME: 'bedtime',
  /** Aterian valmistuksen alku tai ruoka-aika. */
  MEAL: 'meal',
  /** Tapojen muutoksen seuraava suunniteltu aika. */
  HABIT: 'habit',
  /** Edellisen illan katsaus huomiseen. */
  EVENING_BEFORE: 'evening_before',
  /** Aamun lyhyt kooste herätyksen jälkeen (vain jos käyttäjä on kytkenyt sen). */
  MORNING_BRIEF: 'morning_brief',
  /** Päivän kooste, johon vähäiset muistutukset on yhdistetty (notificationPolicy.mergeDigest). */
  DIGEST: 'digest'
});

export const NOTIFICATION_TYPES = Object.freeze(Object.values(NOTIFICATION_TYPE));

/**
 * Tyypit, joita ei vielä voi toteuttaa millään alustalla.
 *
 * TYHJÄ TARKOITUKSELLA: jokainen tyyppi toimitetaan tavallisena ajastettuna
 * ilmoituksena. Puhe ja voimistuva hälytys ovat TOIMITUSTAPOJA (delivery),
 * eivät tyyppejä — jos niitä ei laitteella ole, ilmoitus näkyy silti.
 */
export const PLANNED_TYPES = Object.freeze([]);

/** Lähtöketjun tyypit järjestyksessä. Alusta sallii nämä lepotilassa (Doze). */
export const DEPARTURE_CHAIN_TYPES = Object.freeze([
  NOTIFICATION_TYPE.DEPARTURE_PREPARE,
  NOTIFICATION_TYPE.DEPARTURE_LEAVE_IN_5,
  NOTIFICATION_TYPE.DEPARTURE_LEAVE_NOW
]);

/** Kuinka monta minuuttia ennen lähtöä lähtömuistutus näytetään. */
export const DEPARTURE_ALERT_LEAD_MINUTES = 10;

/** Eskalaatiotasot. */
export const LEVEL = Object.freeze({
  INFO: 1,
  REMINDER: 2,
  ACTION: 3,
  CRITICAL: 4
});

const LEVEL_LABELS = Object.freeze({
  [LEVEL.INFO]: 'Tieto',
  [LEVEL.REMINDER]: 'Muistutus',
  [LEVEL.ACTION]: 'Toiminta nyt',
  [LEVEL.CRITICAL]: 'Kriittinen'
});

export function levelLabel(level) {
  return LEVEL_LABELS[level] || LEVEL_LABELS[LEVEL.INFO];
}

/**
 * Kanava kuvaa, kuinka voimakkaasti ilmoitus keskeyttää.
 * Taso määrää kanavan — käyttäjä ei säädä näitä erikseen, koska se johtaisi
 * siihen että kaikki on kriittistä.
 */
export const CHANNEL = Object.freeze({
  SILENT: 'silent',
  NOTIFICATION: 'notification',
  SOUND: 'sound',
  ALARM: 'alarm'
});

export function channelForLevel(level) {
  if (level >= LEVEL.CRITICAL) return CHANNEL.ALARM;
  if (level >= LEVEL.ACTION) return CHANNEL.SOUND;
  if (level >= LEVEL.REMINDER) return CHANNEL.NOTIFICATION;
  return CHANNEL.SILENT;
}

/**
 * Oletusasetukset.
 *
 * TILA: LOCAL ONLY. Nämä elävät toistaiseksi vain muistissa ja laitteen
 * asetuksissa. Tilikohtainen tallennus vaatii migraation 0005.
 */
export const DEFAULT_PREFERENCES = Object.freeze({
  enabled: false,
  /** Minuutteja ennen tehtävän alkua. */
  taskLeadMinutes: 10,
  /** Minuutteja ennen rutiinin alkua. */
  routineLeadMinutes: 5,
  /** Milloin päivän suunnitelma näytetään. */
  dailyPlanTime: '07:30',
  /** Milloin illan katsaus näytetään. */
  eveningReviewTime: '21:00',
  /** Näytetäänkö päivän suunnitelma lainkaan. */
  dailyPlanEnabled: true,
  eveningReviewEnabled: true,
  deadlineWarningsEnabled: true,
  /** Enimmäismäärä ilmoituksia vuorokaudessa. Suojaa hälyltä. */
  maxPerDay: 12,
  /** Rauhoitusaika: ei ilmoituksia tällä välillä. */
  quietHours: Object.freeze({ from: '22:00', to: '06:30' })
});

export function normalizePreferences(input = {}) {
  const number = (value, fallback, min, max) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.round(n)));
  };
  const time = (value, fallback) => (isTimeOfDay(value) ? value : fallback);

  return {
    enabled: input.enabled === true,
    taskLeadMinutes: number(input.taskLeadMinutes, DEFAULT_PREFERENCES.taskLeadMinutes, 0, 240),
    routineLeadMinutes: number(input.routineLeadMinutes, DEFAULT_PREFERENCES.routineLeadMinutes, 0, 240),
    dailyPlanTime: time(input.dailyPlanTime, DEFAULT_PREFERENCES.dailyPlanTime),
    eveningReviewTime: time(input.eveningReviewTime, DEFAULT_PREFERENCES.eveningReviewTime),
    dailyPlanEnabled: input.dailyPlanEnabled !== false,
    eveningReviewEnabled: input.eveningReviewEnabled !== false,
    deadlineWarningsEnabled: input.deadlineWarningsEnabled !== false,
    maxPerDay: number(input.maxPerDay, DEFAULT_PREFERENCES.maxPerDay, 1, 50),
    quietHours: {
      from: time(input.quietHours?.from, DEFAULT_PREFERENCES.quietHours.from),
      to: time(input.quietHours?.to, DEFAULT_PREFERENCES.quietHours.to)
    }
  };
}

/**
 * Osuuko kellonaika rauhoitusaikaan?
 * Rauhoitusaika ylittää tyypillisesti keskiyön (22:00–06:30).
 */
export function isQuietTime(time, quietHours) {
  // PUOLIAVOIN VALI [from, to): alkuhetki kuuluu rauhoitukseen, loppuhetki ei.
  //
  // from === to tarkoittaa NOLLAN MITTAISTA valia eli ei rauhoitusta
  // lainkaan. Vaihtoehto olisi tulkita se koko vuorokaudeksi, mutta se
  // olisi ristiriidassa valin muun kasittelyn kanssa: [22:00, 22:00) ei
  // sisalla yhtaan hetkea, aivan kuten tyhja valikin.
  //
  // Tama on TARKOITUKSELLINEN paatos eika sivuvaikutus. Kaytannon
  // seuraus: jos kayttaja asettaa alun ja lopun samaksi, muistutukset
  // kulkevat lapi normaalisti.
  if (!isTimeOfDay(time) || !quietHours) return false;

  // Osittainen olio ei saa heittaa. Nykyinen ainoa kutsuja antaa aina
  // normalisoidut asetukset, joten tama ei ole tavoitettavissa sielta -
  // mutta viety funktio, joka kaatuu muotoa {} olevaan syotteeseen, on
  // ansa seuraavalle kutsujalle.
  if (!isTimeOfDay(quietHours.from) || !isTimeOfDay(quietHours.to)) return false;

  const minutes = toMinutes(time);
  const from = toMinutes(quietHours.from);
  const to = toMinutes(quietHours.to);
  return from > to
    ? (minutes >= from || minutes < to)   // keskiyön yli
    : (minutes >= from && minutes < to);
}

/**
 * Tehtävän muistutuksen eskalaatiotaso.
 *
 * Taso nousee kolmesta syystä: määräaika lähestyy, prioriteetti on korkea,
 * tai tehtävä on jo myöhässä. Nämä lasketaan yhteen, mutta tulos rajataan —
 * kaikki ei voi olla kriittistä.
 */
export function escalationForTask(task, todayIso) {
  if (!task || task.completed) return LEVEL.INFO;

  if (isOverdue(task, todayIso)) return LEVEL.CRITICAL;

  const urgency = deadlineUrgency(task, todayIso);
  let level = LEVEL.INFO;

  if (urgency === URGENCY.TODAY) level = LEVEL.ACTION;
  else if (urgency === URGENCY.TOMORROW) level = LEVEL.REMINDER;
  else if (urgency === URGENCY.SOON) level = LEVEL.REMINDER;

  // Korkea prioriteetti nostaa yhdellä, muttei koskaan kriittiseksi asti —
  // kriittinen on varattu todelliselle myöhästymiselle.
  if (task.priority === 'korkea') level = Math.min(level + 1, LEVEL.ACTION);

  // Ajastetulla tehtävällä on aina vähintään muistutustaso: se on sovittu aika.
  if (task.time && level < LEVEL.REMINDER) level = LEVEL.REMINDER;

  return level;
}

/** Määräaikavaroituksen taso. */
export function escalationForDeadline(task, todayIso) {
  const urgency = deadlineUrgency(task, todayIso);
  switch (urgency) {
    case URGENCY.OVERDUE: return LEVEL.CRITICAL;
    case URGENCY.TODAY: return LEVEL.ACTION;
    case URGENCY.TOMORROW: return LEVEL.REMINDER;
    case URGENCY.SOON: return LEVEL.INFO;
    default: return null; // ei varoitusta
  }
}

/** Deterministinen tunniste, jotta samaa ilmoitusta ei ajasteta kahdesti. */
export function intentId(type, targetId, dateIso) {
  return `${type}:${targetId || 'none'}:${dateIso}`;
}

function makeIntent({ type, level, dateIso, time, title, body, targetId, reason, extra = {} }) {
  const id = intentId(type, targetId, dateIso);
  return {
    id,
    type,
    level,
    channel: channelForLevel(level),
    date: dateIso,
    time,
    /** Minuutteja keskiyöstä — helpottaa järjestämistä ja vertailua. */
    atMinutes: isTimeOfDay(time) ? toMinutes(time) : null,
    title,
    body,
    targetId: targetId || null,
    reason,
    // Arjen käyttöjärjestelmän kentät. Perinteiset aikomukset eivät itse
    // tiedä aihettaan eivätkä toimitustapaansa: ne täydentää
    // notificationPolicy.applyNotificationPolicy käyttäjän asetuksista.
    // null tarkoittaa "ei vielä päätetty", EI hiljaista.
    topic: null,
    delivery: null,
    speech: null,
    /** Kuittausavain: sama avain = sama muistutus, vaikka kellonaika muuttuisi. */
    ackKey: id,
    anchor: null,
    ...extra
  };
}

/** Kelvolliset tasot. Muu arvo ei ole taso vaan virhe. */
const LEVEL_VALUES = Object.freeze(Object.values(LEVEL));

/** Aikomuksen hetken ankkurin suurin sallittu siirtymä (minuuttia). */
export const MAX_ANCHOR_OFFSET_MINUTES = 2 * 1440;

function freezeExtraValue(value) {
  if (Array.isArray(value)) return Object.freeze([...value]);
  if (value && typeof value === 'object') return Object.freeze({ ...value });
  return value;
}

/**
 * Rakenna JÄÄDYTETTY aikomus (arjen muistutukset, kooste, torkku).
 *
 * Sama muoto kuin planNotifications-aikomuksilla, jotta alusta ja
 * käytännöt käsittelevät kaikkia samalla tavalla. Ero: kelvoton syöte
 * palauttaa null — tämä funktio ei koskaan arvaa päivää, kellonaikaa eikä
 * tasoa.
 *
 * `anchor` = { date, time, offsetMinutes }: hetki, josta ilmoitus lasketaan
 * TODELLISENA kestona (alusta: intentAt(anchor) + offsetMinutes). Tarvitaan
 * kesäajan vaihtoyönä: "5 min ennen lähtöä" on viisi oikeaa minuuttia,
 * vaikka seinäkelloaika hyppäisi tunnin. `date`/`time` ovat silti
 * seinäkelloaika järjestämistä, rauhoitusaikaa ja näyttöä varten.
 *
 * @returns {object|null}
 */
export function createIntent(input) {
  const {
    id = null, type, level, date, time, title, body = '', targetId = null, reason = '',
    topic = null, delivery = null, speech = null, ackKey = null, anchor = null, extra = {}
  } = input && typeof input === 'object' ? input : {};
  if (!NOTIFICATION_TYPES.includes(type)) return null;
  if (!LEVEL_VALUES.includes(level)) return null;
  if (!isIsoDate(date) || !isTimeOfDay(time)) return null;
  if (typeof title !== 'string' || !title.trim()) return null;

  const finalId = typeof id === 'string' && id ? id : intentId(type, targetId, date);
  let frozenAnchor = null;
  if (anchor && isIsoDate(anchor.date) && isTimeOfDay(anchor.time)
    && Number.isInteger(anchor.offsetMinutes)
    && Math.abs(anchor.offsetMinutes) <= MAX_ANCHOR_OFFSET_MINUTES) {
    frozenAnchor = Object.freeze({ date: anchor.date, time: anchor.time, offsetMinutes: anchor.offsetMinutes });
  }

  // Lisäkentät ENSIN: ne eivät saa ylikirjoittaa ydinkenttiä (tunniste,
  // taso, aika), joiden varassa kuittaus ja ajastus toimivat.
  const extras = {};
  if (extra && typeof extra === 'object') {
    for (const [key, value] of Object.entries(extra)) extras[key] = freezeExtraValue(value);
  }

  return Object.freeze({
    ...extras,
    id: finalId,
    type,
    level,
    channel: channelForLevel(level),
    date,
    time,
    atMinutes: toMinutes(time),
    title,
    body: typeof body === 'string' ? body : '',
    targetId: targetId === null || targetId === undefined ? null : String(targetId),
    reason: typeof reason === 'string' ? reason : '',
    topic: typeof topic === 'string' ? topic : null,
    delivery: typeof delivery === 'string' ? delivery : null,
    speech: typeof speech === 'string' && speech ? speech : null,
    ackKey: typeof ackKey === 'string' && ackKey ? ackKey : finalId,
    anchor: frozenAnchor
  });
}

/**
 * Aikomusten vakiojärjestys: päivä, kellonaika, taso (kiireellisin ensin),
 * tunniste. Sama järjestys kaikkialla, jotta sama syöte tuottaa aina
 * saman listan riippumatta syötteen järjestyksestä.
 */
export function compareIntents(a, b) {
  const dateA = typeof a.date === 'string' ? a.date : '';
  const dateB = typeof b.date === 'string' ? b.date : '';
  if (dateA !== dateB) return dateA < dateB ? -1 : 1;
  const minutesA = Number.isFinite(a.atMinutes) ? a.atMinutes : Number.MAX_SAFE_INTEGER;
  const minutesB = Number.isFinite(b.atMinutes) ? b.atMinutes : Number.MAX_SAFE_INTEGER;
  if (minutesA !== minutesB) return minutesA - minutesB;
  const levelA = Number.isFinite(a.level) ? a.level : 0;
  const levelB = Number.isFinite(b.level) ? b.level : 0;
  if (levelA !== levelB) return levelB - levelA;
  return String(a.id).localeCompare(String(b.id), 'fi');
}

/**
 * Suunnittele päivän ilmoitukset.
 *
 * PUHDAS FUNKTIO. Sama syöte tuottaa aina saman tuloksen. Ei ajasta eikä
 * lähetä mitään — palauttaa aikomukset, jotka alustakerros voi toteuttaa.
 *
 * TAKUUT:
 *  - Deterministinen ja järjestetty ajan mukaan
 *  - Ei kahta ilmoitusta samalla tunnisteella
 *  - Ei koskaan ilmoituksia rauhoitusaikana (paitsi kriittiset)
 *  - Ei koskaan enempää kuin maxPerDay
 *  - Valmiista tehtävästä ei koskaan muistuteta
 *
 * @param {object} args
 * @param {Array}  args.tasks
 * @param {Array}  [args.routineOccurrences] Laajennetut esiintymät tälle päivälle
 * @param {string} args.dateIso              Päivä, jolle suunnitellaan
 * @param {string} [args.todayIso]           Nykyinen päivä (kiireellisyyteen)
 * @param {object} [args.preferences]
 * @param {Function} [args.offsetMinutesFn]  Laitteen vyöhyke (wallClock.js). Matkojen lähtö
 *        lasketaan sillä todellisina minuutteina, jotta kesäaikaan siirtymisen yönä muistutus
 *        ei tule tuntia myöhässä. Ilman sitä puhdas seinäkello.
 * @param {boolean} [args.limits=true]  false = rauhoitusaikaa ja päivärajaa EI sovelleta
 *        tässä. Sovelluksen ajastuspolku antaa false: sama toimituspolitiikka
 *        (notificationPolicy.applyNotificationPolicy) rajaa silloin kaikki
 *        muistutukset yhdessä, eikä kaksi erillistä kattoa kaksinkertaista hälyä.
 * @returns {Array} NotificationIntent[]
 */
export function planNotifications({
  tasks = [],
  routineOccurrences = [],
  travelPlans = [],
  dateIso,
  todayIso = null,
  preferences = {},
  offsetMinutesFn = null,
  limits = true
} = {}) {
  const prefs = normalizePreferences(preferences);
  if (!prefs.enabled) return [];
  if (!isIsoDate(dateIso)) return [];

  const reference = todayIso || dateIso;
  const intents = [];

  // 1. Päivän suunnitelma
  if (prefs.dailyPlanEnabled) {
    const dayTasks = tasks.filter(t => t.date === dateIso && !t.completed);
    intents.push(makeIntent({
      type: NOTIFICATION_TYPE.DAILY_PLAN,
      level: LEVEL.INFO,
      dateIso,
      time: prefs.dailyPlanTime,
      title: 'Päivän suunnitelma',
      body: dayTasks.length
        ? `${dayTasks.length} asiaa suunniteltuna`
        : 'Päivä on vielä avoin',
      targetId: dateIso,
      reason: 'Päivän aloitus'
    }));
  }

  // 2. Tehtävämuistutukset ajastetuille tehtäville
  for (const task of tasks) {
    if (task.date !== dateIso || task.completed || !task.time) continue;

    const level = escalationForTask(task, reference);
    const startMinutes = toMinutes(task.time);
    const remindAt = Math.max(0, startMinutes - prefs.taskLeadMinutes);

    intents.push(makeIntent({
      type: NOTIFICATION_TYPE.TASK_REMINDER,
      level,
      dateIso,
      time: fromMinutes(remindAt),
      title: task.title,
      body: `Alkaa klo ${task.time}`,
      targetId: task.id,
      reason: prefs.taskLeadMinutes > 0
        ? `${prefs.taskLeadMinutes} min ennen alkua`
        : 'Alkamisaika',
      extra: { taskId: task.id }
    }));
  }

  // 3. Rutiinimuistutukset
  for (const occurrence of routineOccurrences) {
    if (occurrence.date !== dateIso || !occurrence.time) continue;

    const startMinutes = toMinutes(occurrence.time);
    const remindAt = Math.max(0, startMinutes - prefs.routineLeadMinutes);

    intents.push(makeIntent({
      type: NOTIFICATION_TYPE.ROUTINE_REMINDER,
      level: LEVEL.REMINDER,
      dateIso,
      time: fromMinutes(remindAt),
      title: occurrence.title,
      body: `Rutiini klo ${occurrence.time}`,
      targetId: occurrence.id,
      reason: 'Toistuva rutiini',
      extra: { routineId: occurrence.routineId }
    }));
  }

  // 4. Määräaikavaroitukset
  if (prefs.deadlineWarningsEnabled) {
    for (const task of tasks) {
      if (task.completed || !task.deadline) continue;

      const level = escalationForDeadline(task, reference);
      if (level === null) continue;

      // Varoitus näytetään sinä päivänä, jolle suunnitellaan — ei tehtävän
      // omana päivänä, koska määräaika koskee myös aikatauluttamattomia.
      intents.push(makeIntent({
        type: NOTIFICATION_TYPE.DEADLINE_WARNING,
        level,
        dateIso,
        time: prefs.dailyPlanTime,
        title: task.title,
        body: `Määräaika ${task.deadline}`,
        targetId: task.id,
        reason: 'Määräaika lähestyy',
        extra: { taskId: task.id, deadline: task.deadline }
      }));
    }
  }

  // 4b. Lähtömuistutukset
  //
  // VAIN PÄIVÄLLISILLE SUUNNITELMILLE JA VAIN TIEDOSSA OLEVALLA KESTOLLA.
  // Päivätön suunnitelma tulkitaan "tänään", ja sen ajastaminen toistuisi
  // joka päivä (vanhentunut suunnitelma herättäisi joka aamu). Tuntematon
  // kesto ei tuota lähtöaikaa (departureSchedule known:false), joten se
  // ei tuota myöskään ilmoitusta -- valelähtöaika olisi vaarallisempi kuin
  // hiljaisuus. Käsin annettu kesto kelpaa.
  for (const plan of travelPlans) {
    if (!plan || !plan.arrivalDate) continue;
    const schedule = departureSchedule(plan, { todayIso: reference, offsetMinutesFn });
    if (!schedule.known) continue;

    const alert = leaveAtMinus(schedule, DEPARTURE_ALERT_LEAD_MINUTES, { offsetMinutesFn });
    if (!alert || alert.date !== dateIso) continue;

    const source = plan.travelSource === TRAVEL_SOURCE.MANUAL ? 'itse arvioitu'
      : plan.travelSource === TRAVEL_SOURCE.PROVIDER ? 'reittipalvelusta' : '';
    intents.push(makeIntent({
      type: NOTIFICATION_TYPE.DEPARTURE_REMINDER,
      level: LEVEL.ACTION,
      dateIso,
      time: alert.time,
      title: 'Lähde ' + DEPARTURE_ALERT_LEAD_MINUTES + ' min kuluttua',
      body: `Lähde noin ${schedule.leave.time} kohteeseen ${plan.destination || 'perille'}, `
        + `jotta ehdit klo ${plan.arrivalTime} (matka ${schedule.parts.travel} min${source ? ', ' + source : ''}).`,
      targetId: plan.id,
      reason: 'Lähtöaika lähestyy',
      extra: { travelPlanId: plan.id }
    }));
  }

  // 5. Illan katsaus
  if (prefs.eveningReviewEnabled) {
    intents.push(makeIntent({
      type: NOTIFICATION_TYPE.EVENING_REVIEW,
      level: LEVEL.INFO,
      dateIso,
      time: prefs.eveningReviewTime,
      title: 'Päivän katsaus',
      body: 'Katso mitä valmistui ja mitä siirtyy huomiselle',
      targetId: dateIso,
      reason: 'Päivän päätös'
    }));
  }

  // Yksi putki: ilman rajoja raaka suunnitelma (järjestettynä), jonka
  // toimituspolitiikka rajaa yhdessä arjen muistutusten kanssa.
  if (limits === false) return [...intents].sort(compareIntents);
  return applyLimits(intents, prefs);
}

/**
 * Karsii ilmoitukset rauhoitusajan ja päivärajan mukaan.
 *
 * Kriittiset läpäisevät rauhoitusajan: jos jokin on todella myöhässä,
 * hiljaisuus olisi karhunpalvelus. Kaikki muu odottaa.
 */
export function applyLimits(intents, preferences) {
  const prefs = normalizePreferences(preferences);

  // Poista duplikaatit tunnisteen perusteella. Ensimmäinen voittaa.
  const unique = [];
  const seen = new Set();
  for (const intent of intents) {
    if (seen.has(intent.id)) continue;
    seen.add(intent.id);
    unique.push(intent);
  }

  // Lähtömuistutus läpäisee rauhoitusajan: käyttäjä on itse kirjannut
  // matkan ja saapumisajan, ja hiljaa pudonnut aamuvarhaisen lähtö-
  // ilmoitus olisi pahempi kuin häiriö. (Omistajan päätös, jos halutaan toisin.)
  const allowed = unique.filter(intent =>
    intent.level >= LEVEL.CRITICAL
    || intent.type === NOTIFICATION_TYPE.DEPARTURE_REMINDER
    || !isQuietTime(intent.time, prefs.quietHours));

  // Järjestys: aika, sitten taso (kiireellisin ensin), sitten tunniste.
  allowed.sort((a, b) => {
    if (a.atMinutes !== b.atMinutes) return (a.atMinutes ?? 0) - (b.atMinutes ?? 0);
    if (a.level !== b.level) return b.level - a.level;
    return a.id.localeCompare(b.id);
  });

  if (allowed.length <= prefs.maxPerDay) return allowed;

  // Yli rajan: säilytetään tärkeimmät, mutta palautetaan aikajärjestyksessä.
  const byImportance = [...allowed].sort((a, b) => {
    if (a.level !== b.level) return b.level - a.level;
    return (a.atMinutes ?? 0) - (b.atMinutes ?? 0);
  });

  const kept = new Set(byImportance.slice(0, prefs.maxPerDay).map(i => i.id));
  return allowed.filter(intent => kept.has(intent.id));
}

/**
 * Yhteenveto suunnitelluista ilmoituksista.
 * Käyttöliittymä voi näyttää tämän asetuksissa: "Tänään 5 muistutusta."
 */
export function summarizeIntents(intents) {
  const byLevel = { 1: 0, 2: 0, 3: 0, 4: 0 };
  const byType = {};

  for (const intent of intents) {
    byLevel[intent.level] = (byLevel[intent.level] || 0) + 1;
    byType[intent.type] = (byType[intent.type] || 0) + 1;
  }

  return {
    total: intents.length,
    byLevel,
    byType,
    critical: intents.filter(i => i.level === LEVEL.CRITICAL),
    first: intents[0] || null
  };
}

/**
 * Ilmoitukset useammalle päivälle.
 * Käytetään esimerkiksi silloin, kun natiivikerros ajastaa etukäteen.
 * `offsetMinutesFn` (laitteen vyöhyke) ja `limits` kulkevat planNotificationsille.
 */
export function planRange({
  tasks, routineOccurrences, travelPlans = [], from, days = 1, todayIso, preferences, offsetMinutesFn = null,
  limits = true
}) {
  if (!isIsoDate(from)) return [];
  const limit = Math.max(1, Math.min(days, 14));
  const all = [];

  for (let i = 0; i < limit; i++) {
    const dateIso = fmtISO(addDays(parseISO(from), i));
    all.push(...planNotifications({
      tasks, routineOccurrences, travelPlans, dateIso, todayIso: todayIso || from, preferences, offsetMinutesFn,
      limits
    }));
  }
  return all;
}
