// Päivän komentokeskus: mikä on juuri nyt tärkeää.
//
// =====================================================================
// YKSI KYSYMYS, KOLME VASTAUSTA
// =====================================================================
//
//   NYT       mikä on käsillä tällä hetkellä
//   SEURAAVA  mikä tulee sen jälkeen
//   PIAN      mistä pitää olla tietoinen
//
// Kolme vastausta, ei kolmeakymmentä korttia. Seinällinen kortteja on
// sama kuin ei vastausta: käyttäjä selaa sen läpi eikä toimi.
//
// =====================================================================
// KIIREELLISYYS ON MATEMATIIKKAA, EI TEKOÄLYÄ
// =====================================================================
//
// Tämä moduuli EI kutsu mallia. Se laskee.
//
// "Mikä on tärkeintä juuri nyt" on ratkaistavissa kellonajalla,
// määräpäivällä, matka-ajalla ja prioriteetilla. Mallin käyttäminen
// siihen olisi hitaampaa, kalliimpaa, epädeterministisempää ja
// mahdotonta selittää — ja selitys on tässä olennainen osa vastausta.
//
// =====================================================================
// JÄRJESTYS ON SELITETTÄVISSÄ
// =====================================================================
//
// Jokainen ehdokas kantaa pisteytyksensä osat mukanaan. Käyttäjä voi
// kysyä "miksi tämä on ensimmäisenä" ja saada oikean vastauksen —
// ei jälkikäteen keksittyä perustelua.

import { isIsoDate, toMinutes, durationOf, deadlineUrgency, URGENCY } from './task.js';
import { priorityWeight } from './priority.js';
import { LIVE_STATUSES, isDue as reminderIsDue } from './reminder.js';
import { leaveStatus, shouldAlertDeparture } from './travel.js';
import { isOpenItem } from './inbox.js';

/** Mitä ehdokas on. */
export const CANDIDATE_KIND = Object.freeze({
  /** Lähtöaika on käsillä. Ohittaa kaiken muun. */
  DEPARTURE: 'departure',
  /** Kiinteä sitoumus alkaa. */
  FIXED: 'fixed',
  /** Muistutus on erääntynyt. */
  REMINDER: 'reminder',
  /** Myöhässä oleva tehtävä. */
  OVERDUE: 'overdue',
  /** Tämän päivän joustava työ. */
  FLEXIBLE: 'flexible',
  /** Rutiini. */
  ROUTINE: 'routine',
  /** Saapuvat odottavat käsittelyä. */
  INBOX: 'inbox'
});

export const CANDIDATE_KINDS = Object.freeze(Object.values(CANDIDATE_KIND));

/**
 * Lajin peruspaino.
 *
 * PIENEMPI ON TÄRKEÄMPI. Lähtöaika on ensimmäinen, koska se on ainoa
 * asia, jonka myöhästyminen ei ole korjattavissa myöhemmin samana
 * päivänä: bussi lähtee ilman käyttäjää.
 *
 * Saapuvat ovat viimeisenä, koska ne eivät ole kiireellisiä — ne ovat
 * kirjattuja juuri siksi, ettei niitä tarvitse ratkaista heti.
 */
const KIND_RANK = Object.freeze({
  [CANDIDATE_KIND.DEPARTURE]: 0,
  [CANDIDATE_KIND.FIXED]: 1,
  [CANDIDATE_KIND.REMINDER]: 2,
  [CANDIDATE_KIND.OVERDUE]: 3,
  [CANDIDATE_KIND.ROUTINE]: 4,
  [CANDIDATE_KIND.FLEXIBLE]: 5,
  [CANDIDATE_KIND.INBOX]: 6
});

/** Kuinka pitkälle eteenpäin "pian" katsoo, minuutteina. */
export const UPCOMING_HORIZON_MINUTES = 240;

/** Montako kohtaa "pian" näyttää enintään. */
export const MAX_UPCOMING = 5;

/**
 * Kuinka lähellä kiinteä sitoumus on, jotta se on NYT eikä SEURAAVA.
 *
 * Kokous, joka alkaa kymmenen minuutin kuluttua, on käsillä. Kokous,
 * joka alkaa kolmen tunnin kuluttua, ei ole.
 */
export const NOW_WINDOW_MINUTES = 30;

function candidate(kind, { id, title, minutes, reason, score, meta = {} }) {
  return Object.freeze({
    kind,
    id,
    title,
    /** Milloin tämä on käsillä, minuutteina päivän alusta. Null = ei aikaa. */
    minutes: minutes ?? null,
    /** Miksi tämä on tässä järjestyksessä. Lasketaan, ei keksitä. */
    reason,
    score,
    ...meta
  });
}

/**
 * Pisteytys.
 *
 * PIENEMPI ON TÄRKEÄMPI. Osat ovat näkyvissä `score`-oliossa, jotta
 * järjestys voidaan selittää.
 *
 *   kind      lajin peruspaino
 *   time      kuinka pian, minuutteina (myöhässä = negatiivinen)
 *   priority  tehtävän prioriteetti
 *
 * Aika painaa lajin sisällä, ei sen yli: myöhässä oleva tehtävä ei
 * ohita alkavaa kokousta, vaikka se olisi myöhässä pidempään.
 */
function scoreOf(kind, { minutes = null, priority = null, urgency = null } = {}) {
  return Object.freeze({
    kind: KIND_RANK[kind] ?? 9,
    time: minutes === null ? Number.MAX_SAFE_INTEGER : minutes,
    priority: priority === null ? 5 : priorityWeight(priority),
    urgency: urgency === null ? 5 : urgencyRank(urgency)
  });
}

function urgencyRank(urgency) {
  return {
    [URGENCY.OVERDUE]: 0,
    [URGENCY.TODAY]: 1,
    [URGENCY.SOON]: 2,
    [URGENCY.LATER]: 3,
    [URGENCY.NONE]: 4
  }[urgency] ?? 5;
}

/**
 * Vertailu.
 *
 * TÄMÄ ON KOKO JÄRJESTYSSÄÄNTÖ YHDESSÄ PAIKASSA:
 *
 *   1. laji (lähtöaika ensin, saapuvat viimeisenä)
 *   2. aika (aikaisempi ensin)
 *   3. kiireellisyys
 *   4. prioriteetti
 *   5. nimi — takaa determinismin
 */
export function compareCandidates(a, b) {
  if (a.score.kind !== b.score.kind) return a.score.kind - b.score.kind;
  if (a.score.time !== b.score.time) return a.score.time - b.score.time;
  if (a.score.urgency !== b.score.urgency) return a.score.urgency - b.score.urgency;
  if (a.score.priority !== b.score.priority) return a.score.priority - b.score.priority;
  return String(a.title ?? '').localeCompare(String(b.title ?? ''), 'fi');
}

/**
 * Kerää ehdokkaat.
 *
 * PUHDAS FUNKTIO. Ei kelloa, ei satunnaisuutta, ei verkkoa — sama
 * syöte tuottaa saman tuloksen, ja se tekee tästä testattavan ilman
 * ajastimia.
 *
 * @param {object} input
 * @param {Array}  input.tasks
 * @param {Array}  [input.reminders]
 * @param {Array}  [input.travelPlans]
 * @param {Array}  [input.routineOccurrences]  expandRoutines(...)
 * @param {Array}  [input.inboxItems]
 * @param {string} input.todayIso
 * @param {number} input.nowMinutes
 */
export function collectCandidates({
  tasks = [],
  reminders = [],
  travelPlans = [],
  routineOccurrences = [],
  inboxItems = [],
  todayIso,
  nowMinutes = 0
} = {}) {
  if (!isIsoDate(todayIso)) return [];

  const out = [];

  // LÄHTÖAIKA ENSIN. Ainoa asia, jonka myöhästyminen ei ole
  // korjattavissa myöhemmin samana päivänä.
  for (const plan of travelPlans) {
    if (!plan) continue;
    if (plan.arrivalDate && plan.arrivalDate !== todayIso) continue;
    if (!shouldAlertDeparture(plan, { todayIso, nowMinutes, leadMinutes: 60 })) continue;

    const status = leaveStatus(plan, { todayIso, nowMinutes });
    const leaveMinutes = status.leaveBy.leaveByTime
      ? toMinutes(status.leaveBy.leaveByTime) : null;

    out.push(candidate(CANDIDATE_KIND.DEPARTURE, {
      id: plan.id,
      title: plan.title || plan.destination || 'Lähtö',
      minutes: leaveMinutes,
      reason: status.late
        ? `Lähtöaika kohteeseen ${plan.destination} meni jo.`
        : `Lähde ${status.minutesUntilLeave} min kuluttua kohteeseen `
          + `${plan.destination}.`,
      score: scoreOf(CANDIDATE_KIND.DEPARTURE, {
        minutes: status.late ? -1 : (status.minutesUntilLeave ?? null)
      }),
      meta: { destination: plan.destination, late: status.late }
    }));
  }

  // KIINTEÄT SITOUMUKSET. Käyttäjän itse ajastama työ.
  for (const task of tasks) {
    if (!task || task.completed || task.date !== todayIso || !task.time) continue;

    const start = toMinutes(task.time);
    const duration = durationOf(task) ?? 0;
    const end = start + duration;

    // Ohi mennyt sitoumus ei ole enää käsillä.
    if (end < nowMinutes) continue;

    const running = start <= nowMinutes && nowMinutes < end;

    out.push(candidate(CANDIDATE_KIND.FIXED, {
      id: task.id,
      title: task.title,
      minutes: start,
      reason: running
        ? `Käynnissä nyt, päättyy klo ${task.endTime || ''}.`.trim()
        : `Alkaa klo ${task.time}`
          + (start - nowMinutes <= 60 ? `, ${start - nowMinutes} min kuluttua.` : '.'),
      score: scoreOf(CANDIDATE_KIND.FIXED, {
        minutes: running ? 0 : start - nowMinutes,
        priority: task.priority
      }),
      meta: { running, taskId: task.id }
    }));
  }

  // ERÄÄNTYNEET MUISTUTUKSET.
  for (const reminder of reminders) {
    if (!reminder || !LIVE_STATUSES.includes(reminder.status)) continue;
    if (!reminderIsDue(reminder, { todayIso, nowMinutes })) continue;

    out.push(candidate(CANDIDATE_KIND.REMINDER, {
      id: reminder.id,
      title: reminder.title,
      minutes: reminder.dueTime ? toMinutes(reminder.dueTime) : null,
      reason: reminder.dueDate < todayIso
        ? `Muistutus ${reminder.dueDate} on yhä kuittaamatta.`
        : `Muistutus klo ${reminder.dueTime}.`,
      score: scoreOf(CANDIDATE_KIND.REMINDER, {
        minutes: reminder.dueTime ? toMinutes(reminder.dueTime) - nowMinutes : null
      }),
      meta: { targetType: reminder.targetType, targetId: reminder.targetId }
    }));
  }

  // MYÖHÄSSÄ OLEVA TYÖ.
  for (const task of tasks) {
    if (!task || task.completed || !task.date) continue;
    if (task.date >= todayIso) continue;

    out.push(candidate(CANDIDATE_KIND.OVERDUE, {
      id: task.id,
      title: task.title,
      minutes: null,
      reason: `Oli määrä tehdä ${task.date}.`,
      score: scoreOf(CANDIDATE_KIND.OVERDUE, {
        // Mitä kauemmin myöhässä, sitä ylemmäs. Negatiivinen aika
        // järjestää vanhimman ensimmäiseksi.
        minutes: daysBetween(task.date, todayIso) * -1,
        priority: task.priority,
        urgency: URGENCY.OVERDUE
      }),
      meta: { taskId: task.id, dueDate: task.date }
    }));
  }

  // RUTIINIT.
  for (const occurrence of routineOccurrences) {
    if (!occurrence || occurrence.date !== todayIso) continue;
    if (occurrence.completed) continue;

    const start = occurrence.time ? toMinutes(occurrence.time) : null;
    if (start !== null && start + (occurrence.durationMinutes || 0) < nowMinutes) continue;

    out.push(candidate(CANDIDATE_KIND.ROUTINE, {
      id: occurrence.id,
      title: occurrence.title,
      minutes: start,
      reason: occurrence.time
        ? `Rutiini klo ${occurrence.time}.`
        : 'Päivän rutiini.',
      score: scoreOf(CANDIDATE_KIND.ROUTINE, {
        minutes: start === null ? null : start - nowMinutes
      }),
      meta: { routineId: occurrence.routineId }
    }));
  }

  // TÄMÄN PÄIVÄN JOUSTAVA TYÖ.
  for (const task of tasks) {
    if (!task || task.completed || task.date !== todayIso || task.time) continue;

    out.push(candidate(CANDIDATE_KIND.FLEXIBLE, {
      id: task.id,
      title: task.title,
      minutes: null,
      reason: 'Tälle päivälle suunniteltu, ei kiinteää aikaa.',
      score: scoreOf(CANDIDATE_KIND.FLEXIBLE, {
        priority: task.priority,
        urgency: deadlineUrgency(task, todayIso)
      }),
      meta: { taskId: task.id, durationMinutes: durationOf(task) }
    }));
  }

  // SAAPUVAT. Viimeisenä: ne eivät ole kiireellisiä.
  const open = inboxItems.filter(isOpenItem);
  if (open.length > 0) {
    out.push(candidate(CANDIDATE_KIND.INBOX, {
      id: 'inbox',
      title: open.length === 1
        ? '1 kirjaus odottaa käsittelyä'
        : `${open.length} kirjausta odottaa käsittelyä`,
      minutes: null,
      reason: 'Kirjasit näitä myöhempää päätöstä varten.',
      score: scoreOf(CANDIDATE_KIND.INBOX),
      meta: { count: open.length }
    }));
  }

  return out.sort(compareCandidates);
}

function daysBetween(fromIso, toIso) {
  const from = Date.parse(fromIso + 'T00:00:00Z');
  const to = Date.parse(toIso + 'T00:00:00Z');
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  return Math.round((to - from) / 86400000);
}

/**
 * NYT, SEURAAVA ja PIAN.
 *
 * =================================================================
 * TYHJÄ ON KELVOLLINEN VASTAUS.
 * =================================================================
 *
 * Jos mitään ei ole käsillä, `now` on `null` — ei ensimmäinen
 * mahdollinen tehtävä. Keksitty "nyt" opettaisi käyttäjän
 * epäilemään kaikkia vastauksia.
 *
 * @returns {{now, next, upcoming, all, empty}}
 */
export function nowNext(input = {}) {
  const all = collectCandidates(input);
  const nowMinutes = Number(input.nowMinutes ?? 0);

  if (all.length === 0) {
    return {
      now: null, next: null, upcoming: [], all: [], empty: true,
      reason: 'Mitään ei ole juuri nyt käsillä.'
    };
  }

  // NYT: ensimmäinen ehdokas, joka on aidosti käsillä.
  //
  // Kiinteä sitoumus on käsillä vasta lähellä alkuaan; ajaton työ on
  // käsillä aina. Kolmen tunnin päässä oleva kokous ei ole "nyt", ja
  // sen esittäminen sellaisena tekisi sanasta merkityksettömän.
  const now = all.find(entry => isAtHand(entry, nowMinutes)) ?? null;

  const rest = all.filter(entry => entry !== now);
  const next = rest[0] ?? null;

  const upcoming = rest
    .filter(entry => entry !== next)
    .filter(entry => entry.minutes === null
      || entry.minutes - nowMinutes <= UPCOMING_HORIZON_MINUTES)
    .slice(0, MAX_UPCOMING);

  return {
    now,
    next,
    upcoming,
    all,
    empty: false,
    reason: now ? now.reason : 'Seuraava asia ei ole vielä käsillä.'
  };
}

/** Onko ehdokas aidosti käsillä juuri nyt? */
export function isAtHand(entry, nowMinutes) {
  if (!entry) return false;

  // Lähtöaika, muistutus ja myöhässä oleva ovat aina käsillä.
  if (entry.kind === CANDIDATE_KIND.DEPARTURE) return true;
  if (entry.kind === CANDIDATE_KIND.REMINDER) return true;
  if (entry.kind === CANDIDATE_KIND.OVERDUE) return true;

  // Saapuvat eivät koskaan ole "nyt".
  if (entry.kind === CANDIDATE_KIND.INBOX) return false;

  // Ajaton työ on käsillä.
  if (entry.minutes === null) return true;

  // Aikaan sidottu on käsillä, kun se on alkanut tai alkamassa.
  return entry.minutes - Number(nowMinutes ?? 0) <= NOW_WINDOW_MINUTES;
}

/**
 * Miksi tämä on ensimmäisenä?
 *
 * Selitys kootaan pisteytyksen osista. Se on siis sama tieto, jonka
 * varassa järjestys tehtiin — ei erikseen kirjoitettu perustelu, joka
 * voisi ajautua siitä erilleen.
 */
export function explainRanking(entry, nowMinutes) {
  if (!entry) return '';

  const osat = [];

  switch (entry.kind) {
    case CANDIDATE_KIND.DEPARTURE:
      osat.push('lähtöaika on käsillä');
      break;
    case CANDIDATE_KIND.FIXED:
      osat.push(entry.running ? 'käynnissä nyt' : 'kiinteä sitoumus');
      break;
    case CANDIDATE_KIND.REMINDER:
      osat.push('muistutus erääntyi');
      break;
    case CANDIDATE_KIND.OVERDUE:
      osat.push('myöhässä');
      break;
    case CANDIDATE_KIND.ROUTINE:
      osat.push('päivän rutiini');
      break;
    case CANDIDATE_KIND.FLEXIBLE:
      osat.push('tälle päivälle suunniteltu');
      break;
    case CANDIDATE_KIND.INBOX:
      osat.push('odottaa käsittelyä');
      break;
    default:
      break;
  }

  if (entry.minutes !== null) {
    const diff = entry.minutes - Number(nowMinutes ?? 0);
    if (diff < 0) osat.push(`${-diff} min sitten`);
    else if (diff === 0) osat.push('juuri nyt');
    else osat.push(`${diff} min kuluttua`);
  }

  return osat.join(', ') + '.';
}

// =====================================================================
// AAMUN SUUNNITELMA
// =====================================================================

/**
 * Päivän aloitus.
 *
 * EI TÄYTÄ JOKAISTA AUKKOA. Se kertoo, mitä päivässä on ja paljonko
 * tilaa jää — ja jättää päätöksen käyttäjälle. Automaattisesti
 * täytetty päivä on suunnitelma, jota kukaan ei valinnut.
 *
 * @param {object} input  sama kuin nowNext + capacity
 */
export function morningPlan({
  tasks = [],
  routineOccurrences = [],
  inboxItems = [],
  capacity = null,
  conflicts = [],
  todayIso
} = {}) {
  if (!isIsoDate(todayIso)) return null;

  const dayTasks = tasks.filter(t => t && t.date === todayIso && !t.completed);
  const fixed = dayTasks.filter(t => t.time && t.schedulingState !== 'auto');
  const flexible = dayTasks.filter(t => !t.time || t.schedulingState === 'auto');

  const overdue = tasks.filter(t =>
    t && !t.completed && t.date && t.date < todayIso);

  const plannedMinutes = dayTasks
    .reduce((sum, task) => sum + (durationOf(task) ?? 0), 0);

  return {
    dateIso: todayIso,
    fixed: fixed.sort((a, b) => String(a.time).localeCompare(String(b.time))),
    flexible,
    routines: routineOccurrences.filter(o => o && o.date === todayIso),
    overdueCount: overdue.length,
    plannedMinutes,
    /** Käytettävissä oleva aika. Null jos kapasiteettia ei laskettu. */
    usableMinutes: capacity ? capacity.usableMinutes : null,
    /**
     * Jääkö aikaa yli?
     *
     * NEGATIIVINEN ON MERKITTÄVÄ TIETO: päivä on ylibuukattu, ja se
     * sanotaan suoraan eikä piiloteta.
     */
    freeMinutes: capacity ? capacity.usableMinutes - plannedMinutes : null,
    conflicts,
    inboxPending: inboxItems.filter(isOpenItem).length,
    /** Onko päivä ylibuukattu? */
    overbooked: capacity ? plannedMinutes > capacity.usableMinutes : false
  };
}

/**
 * Illan katsaus.
 *
 * EI MERKITSE MITÄÄN TEHDYKSI. Se kertoo mitä tapahtui ja ehdottaa
 * mitä siirtää — päätös on käyttäjän.
 */
export function eveningSummary({
  tasks = [],
  reminders = [],
  todayIso
} = {}) {
  if (!isIsoDate(todayIso)) return null;

  const dayTasks = tasks.filter(t => t && t.date === todayIso);
  const completed = dayTasks.filter(t => t.completed);
  const unfinished = dayTasks.filter(t => !t.completed);

  const unacknowledged = reminders.filter(r =>
    r && LIVE_STATUSES.includes(r.status) && r.dueDate === todayIso);

  return {
    dateIso: todayIso,
    completedCount: completed.length,
    unfinishedCount: unfinished.length,
    unfinished,
    unacknowledgedCount: unacknowledged.length,
    /**
     * Ehdotus siirrettävistä. EHDOTUS, EI TOIMENPIDE.
     *
     * Mitään ei siirretä eikä merkitä tehdyksi ilman käyttäjän tekoa.
     */
    suggestedCarryOver: unfinished.filter(t => !t.time),
    completionRate: dayTasks.length === 0
      ? null
      : Math.round((completed.length / dayTasks.length) * 100)
  };
}
