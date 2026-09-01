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
import {
  toMinutes, fromMinutes, isIsoDate, isTimeOfDay,
  deadlineUrgency, isOverdue, URGENCY
} from './task.js';

export const NOTIFICATION_TYPE = Object.freeze({
  TASK_REMINDER: 'task_reminder',
  ROUTINE_REMINDER: 'routine_reminder',
  DEADLINE_WARNING: 'deadline_warning',
  /** Vaatii sijaintikyvykkyyden. PLANNED — ks. docs/ROADMAP.md WP11. */
  DEPARTURE_REMINDER: 'departure_reminder',
  DAILY_PLAN: 'daily_plan',
  EVENING_REVIEW: 'evening_review'
});

export const NOTIFICATION_TYPES = Object.freeze(Object.values(NOTIFICATION_TYPE));

/** Tyypit, joita ei vielä voi toteuttaa millään alustalla. */
export const PLANNED_TYPES = Object.freeze([NOTIFICATION_TYPE.DEPARTURE_REMINDER]);

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
  if (!isTimeOfDay(time) || !quietHours) return false;
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
  return {
    id: intentId(type, targetId, dateIso),
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
    ...extra
  };
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
 * @returns {Array} NotificationIntent[]
 */
export function planNotifications({
  tasks = [],
  routineOccurrences = [],
  dateIso,
  todayIso = null,
  preferences = {}
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

  const allowed = unique.filter(intent =>
    intent.level >= LEVEL.CRITICAL || !isQuietTime(intent.time, prefs.quietHours));

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
 */
export function planRange({ tasks, routineOccurrences, from, days = 1, todayIso, preferences }) {
  if (!isIsoDate(from)) return [];
  const limit = Math.max(1, Math.min(days, 14));
  const all = [];

  for (let i = 0; i < limit; i++) {
    const dateIso = fmtISO(addDays(parseISO(from), i));
    all.push(...planNotifications({
      tasks, routineOccurrences, dateIso, todayIso: todayIso || from, preferences
    }));
  }
  return all;
}
