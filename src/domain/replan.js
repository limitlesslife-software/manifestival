// Mukautuva uudelleensuunnittelu.
//
// =====================================================================
// DELTA, EI KOKO ELÄMÄNSUUNNITELMAA UUDESTAAN
// =====================================================================
//
// Kun yksi tehtävä jää tekemättä, oikea vastaus on
//
//   "Siirrä 'Viimeistele X' tiistailta torstaille."
//
// eikä
//
//   "Tässä uusi suunnitelma kaikille tavoitteillesi."
//
// Koko suunnitelman uudelleengenerointi on käyttäjälle kallista
// kahdella tavalla: hän joutuu tarkistamaan kaiken uudelleen, ja hän
// menettää ne päätökset jotka hän oli jo tehnyt. Muutos, jota ei voi
// lukea yhdellä silmäyksellä, hyväksytään lukematta — ja silloin
// hyväksyntä lakkaa tarkoittamasta mitään.
//
// =====================================================================
// KIINTEÄ PYSYY KIINTEÄNÄ
// =====================================================================
//
// Yksikään laukaisin ei anna lupaa siirtää käyttäjän itse ajastamaa
// työtä. Uudelleensuunnittelu koskee joustavaa työtä, ja jos joustavaa
// työtä ei ole tarpeeksi, oikea vastaus on kertoa se — ei laajentaa
// lupaa.

import { isIsoDate } from './task.js';
import { fmtISO, parseISO, addDays } from '../lib/datetime.js';
import { planHorizon, isMovable, PLACEMENT } from './planScheduler.js';
import { normalizeAutomationLevel, partitionMoves, allowsAutoMove } from './automation.js';
import { DEFAULT_BUFFER_RATIO } from './capacity.js';
import { findCalendarCollisions } from './scheduler.js';

/** Mikä käynnisti uudelleensuunnittelun. */
export const REPLAN_TRIGGER = Object.freeze({
  /** Tehtävä jäi tekemättä eräpäivänään. */
  MISSED_TASK: 'missed_task',
  /** Uusi kiireellinen tehtävä vaatii tilaa. */
  NEW_URGENT: 'new_urgent',
  /** Kalenterissa on päällekkäisyys. */
  CONFLICT: 'conflict',
  /** Määräpäivä muuttui. */
  DEADLINE_CHANGED: 'deadline_changed',
  /** Välitavoite myöhästyi. */
  MILESTONE_DELAYED: 'milestone_delayed',
  /** Rutiini on jäänyt toistuvasti väliin. */
  ROUTINE_SKIPPED: 'routine_skipped',
  /** Tavoite siirrettiin tauolle. */
  GOAL_PAUSED: 'goal_paused',
  /** Käytettävissä oleva aika muuttui. */
  CAPACITY_CHANGED: 'capacity_changed',
  /** Käyttäjä pyysi itse. */
  MANUAL: 'manual'
});

export const REPLAN_TRIGGERS = Object.freeze(Object.values(REPLAN_TRIGGER));

const TRIGGER_LABELS = Object.freeze({
  [REPLAN_TRIGGER.MISSED_TASK]: 'Tehtävä jäi tekemättä',
  [REPLAN_TRIGGER.NEW_URGENT]: 'Uusi kiireellinen tehtävä',
  [REPLAN_TRIGGER.CONFLICT]: 'Päällekkäisyys',
  [REPLAN_TRIGGER.DEADLINE_CHANGED]: 'Määräpäivä muuttui',
  [REPLAN_TRIGGER.MILESTONE_DELAYED]: 'Välitavoite myöhästyi',
  [REPLAN_TRIGGER.ROUTINE_SKIPPED]: 'Rutiini jäi toistuvasti väliin',
  [REPLAN_TRIGGER.GOAL_PAUSED]: 'Tavoite tauolla',
  [REPLAN_TRIGGER.CAPACITY_CHANGED]: 'Käytettävissä oleva aika muuttui',
  [REPLAN_TRIGGER.MANUAL]: 'Pyysit uudelleensuunnittelua'
});

export function triggerLabel(trigger) {
  return TRIGGER_LABELS[trigger] || 'Muutos suunnitelmassa';
}

/** Montako kertaa rutiini saa jäädä väliin ennen kuin siitä huomautetaan. */
export const ROUTINE_SKIP_THRESHOLD = 3;

/**
 * Tehtävät, jotka jäivät tekemättä.
 *
 * MYÖHÄSSÄ EI TARKOITA "EILEN". Se tarkoittaa: päivä on mennyt eikä
 * tehtävä ole valmis. Tänään erääntyvä tehtävä ei ole myöhässä, koska
 * päivä on vielä kesken.
 */
export function missedTasks(tasks = [], todayIso) {
  if (!isIsoDate(todayIso)) return [];
  return tasks.filter(task =>
    task && !task.completed && task.date && task.date < todayIso && isMovable(task));
}

/**
 * Rutiinit, jotka ovat jääneet toistuvasti väliin.
 *
 * Lasketaan POIKKEUKSISTA, ei arvauksesta. `skip`-poikkeus on
 * käyttäjän oma merkintä siitä, että kerta jäi väliin.
 */
export function repeatedlySkippedRoutines(routines = [], exceptions = [], todayIso,
  windowDays = 28) {
  if (!isIsoDate(todayIso)) return [];

  const fromIso = fmtISO(addDays(parseISO(todayIso), -Math.abs(windowDays)));
  const counts = new Map();

  for (const exception of exceptions) {
    if (!exception || exception.type !== 'skip') continue;
    if (!exception.date || exception.date < fromIso || exception.date > todayIso) continue;
    counts.set(exception.routineId, (counts.get(exception.routineId) || 0) + 1);
  }

  return routines
    .filter(routine => routine && routine.active !== false
      && (counts.get(routine.id) || 0) >= ROUTINE_SKIP_THRESHOLD)
    .map(routine => ({ routine, skipCount: counts.get(routine.id) }));
}

/**
 * Rakenna muutosehdotus.
 *
 * TÄMÄ EI SIIRRÄ MITÄÄN. Se laskee, mitä siirtoja tarvittaisiin, ja
 * kertoo kummat niistä automaatiotaso sallii ilman hyväksyntää.
 * Varsinainen kirjoitus tapahtuu toimintokerroksessa ja vain
 * hyväksynnän jälkeen.
 *
 * @param {object} input
 * @param {string} input.trigger
 * @param {Array}  input.tasks
 * @param {Array}  [input.goals]
 * @param {Array}  [input.routines]
 * @param {Array}  [input.exceptions]
 * @param {object} [input.profile]
 * @param {string} input.todayIso
 * @param {number} [input.horizonDays]
 * @param {number} [input.automationLevel]
 * @param {Array}  [input.taskIds]  rajaa muutos näihin tehtäviin
 * @param {Array}  [input.events]   tapahtumaesiintymät: pienentävät päivien kapasiteettia
 * @param {Array}  [input.blocks]   suojatut lohkot: pienentävät päivien kapasiteettia
 */
export function buildReplanProposal({
  trigger = REPLAN_TRIGGER.MANUAL,
  tasks = [],
  goals = [],
  routines = [],
  exceptions = [],
  profile,
  todayIso,
  horizonDays = 14,
  automationLevel,
  bufferRatio = DEFAULT_BUFFER_RATIO,
  taskIds = null,
  events = null,
  blocks = null,
  projects = [],
  reserves = null,
  sleepShortfalls = null
} = {}) {
  const level = normalizeAutomationLevel(automationLevel);

  if (!isIsoDate(todayIso)) {
    return emptyProposal(trigger, level, 'Päivämäärä puuttuu.');
  }

  const toIso = fmtISO(addDays(parseISO(todayIso), Math.max(1, horizonDays) - 1));

  // TAUOLLA OLEVAN TAVOITTEEN TYÖ EI KILPAILE AJASTA.
  //
  // Tauko on päätös olla tekemättä nyt. Jos aikatauluttaja sijoittaisi
  // tauolla olevan tavoitteen tehtäviä, tauko ei tarkoittaisi mitään.
  const pausedGoalIds = new Set(
    goals.filter(goal => goal && goal.status === 'paused').map(goal => goal.id));

  const active = tasks.filter(task =>
    task && !task.completed && !pausedGoalIds.has(task.goalId));

  // MYÖHÄSSÄ OLEVAT VEDETÄÄN NYKYHETKEEN.
  //
  // Menneelle päivälle ei voi sijoittaa. Ilman tätä myöhässä oleva
  // tehtävä jäisi `unplaced`-listalle syystä "menneisyydessä ei ole
  // tilaa", mikä on tosi mutta hyödytön.
  const rebased = active.map(task =>
    task.date && task.date < todayIso && isMovable(task)
      ? { ...task, date: null, __wasDue: task.date }
      : task);

  const result = planHorizon({
    tasks: rebased,
    goals,
    profile,
    fromIso: todayIso,
    toIso,
    routines,
    exceptions,
    automationLevel: level,
    bufferRatio,
    events,
    blocks,
    projects,
    reserves,
    sleepShortfalls
  });

  // MUUTOKSET = siirrot ja myöhässä olleiden uudet päivät.
  //
  // Paikallaan pysyvät jätetään pois: muutosehdotus, joka luettelee
  // kaiken mikä ei muutu, on lista jota ei lueta.
  const changes = [];

  for (const placement of result.placements) {
    const original = active.find(task => task.id === placement.taskId);
    if (!original) continue;

    const wasDue = rebased.find(task => task.id === placement.taskId)?.__wasDue ?? null;
    const previousDate = wasDue || original.date || null;

    if (previousDate === placement.toDateIso) continue;
    if (placement.result === PLACEMENT.KEPT) continue;
    if (taskIds && !taskIds.includes(placement.taskId)) continue;

    changes.push({
      taskId: placement.taskId,
      title: placement.title,
      fromDateIso: previousDate,
      toDateIso: placement.toDateIso,
      minutes: placement.minutes,
      goalId: placement.goalId,
      overdue: Boolean(wasDue),
      reason: placement.reason
    });
  }

  // Automaatiotason jako. Siirto, jota taso ei salli, EI katoa — se
  // odottaa hyväksyntää.
  const { automatic, needsApproval } = partitionMoves(
    level,
    changes.map(change => ({
      taskId: change.taskId,
      fromDateIso: change.fromDateIso,
      toDateIso: change.toDateIso
    })),
    { horizonEndIso: toIso }
  );

  const automaticIds = new Set(automatic.map(move => move.taskId));

  return {
    trigger,
    automationLevel: level,
    fromIso: todayIso,
    toIso,
    changes,
    /** Siirrot, jotka taso sallii tehdä ilman erillistä hyväksyntää. */
    automatic: changes.filter(change => automaticIds.has(change.taskId)),
    /** Siirrot, jotka odottavat käyttäjää. */
    needsApproval: changes.filter(change => !automaticIds.has(change.taskId)),
    /** Ei mahtunut mihinkään. Tämä on se osa, jota siirtäminen ei ratkaise. */
    unplaced: result.unplaced.map(entry => ({
      taskId: entry.task.id,
      title: entry.task.title,
      goalId: entry.task.goalId || null,
      reason: entry.reason
    })),
    summary: summarizeReplan(changes, result.unplaced, level),
    refusals: needsApproval
  };
}

function emptyProposal(trigger, level, reason) {
  return {
    trigger,
    automationLevel: level,
    fromIso: null,
    toIso: null,
    changes: [],
    automatic: [],
    needsApproval: [],
    unplaced: [],
    summary: { changeCount: 0, automaticCount: 0, approvalCount: 0, unplacedCount: 0, reason },
    refusals: []
  };
}

function summarizeReplan(changes, unplaced, level) {
  const automaticCount = allowsAutoMove(level) ? changes.length : 0;

  return {
    changeCount: changes.length,
    automaticCount,
    approvalCount: changes.length - automaticCount,
    unplacedCount: unplaced.length,
    reason: changes.length === 0 && unplaced.length === 0
      ? 'Suunnitelma on kunnossa. Mitään ei tarvitse siirtää.'
      : null
  };
}

/**
 * Ihmisluettava selitys yhdelle muutokselle.
 *
 * Muutos ilman perustelua on käsky. Käyttäjän on nähtävä MIKSI, jotta
 * hän voi olla eri mieltä.
 */
export function describeChange(change) {
  if (!change) return '';

  const what = `"${change.title}"`;

  if (change.overdue) {
    return `${what} jäi tekemättä ${change.fromDateIso}. `
      + `Ehdotan uudeksi päiväksi ${change.toDateIso}.`;
  }

  if (!change.fromDateIso) {
    return `${what} ehdotetaan päivälle ${change.toDateIso}.`;
  }

  return `Siirretään ${what} ${change.fromDateIso} → ${change.toDateIso}. `
    + change.reason;
}

/**
 * Pitäisikö uudelleensuunnittelua ehdottaa?
 *
 * EI EHDOTETA ILMAN SYYTÄ. Jatkuva "haluatko järjestellä uudelleen"
 * opettaa käyttäjän ohittamaan kysymyksen, ja silloin se ei enää toimi
 * silloinkaan kun se on tarpeen.
 *
 * KALENTERI (valinnainen): kun `events` tai `blocks` annetaan,
 * automaattisesti sijoitettu (AUTO) tehtävä, joka osuu tapahtumaan,
 * matkaan, valmistautumiseen tai uneen, nostaa CONFLICT-laukaisimen.
 * Se korjataan päivän sisällä (proposeSchedule `reflow: true`), koska
 * päivätason siirto ei ratkaise kellonajan päällekkäisyyttä. Käyttäjän
 * itse ajastama tehtävä ei nosta tätä laukaisinta: sen päällekkäisyys
 * on käyttäjän oma ristiriita (conflicts.js detectBlockConflicts).
 *
 * @returns {{needed: boolean, triggers: Array<{trigger:string, detail:string}>}}
 */
export function detectReplanTriggers({
  tasks = [],
  routines = [],
  exceptions = [],
  goals = [],
  milestones = [],
  todayIso,
  events = [],
  blocks = []
} = {}) {
  const triggers = [];

  const missed = missedTasks(tasks, todayIso);
  if (missed.length > 0) {
    triggers.push({
      trigger: REPLAN_TRIGGER.MISSED_TASK,
      detail: missed.length === 1
        ? `"${missed[0].title}" jäi tekemättä ${missed[0].date}.`
        : `${missed.length} tehtävää jäi tekemättä.`,
      taskIds: missed.map(task => task.id)
    });
  }

  const skipped = repeatedlySkippedRoutines(routines, exceptions, todayIso);
  for (const entry of skipped) {
    triggers.push({
      trigger: REPLAN_TRIGGER.ROUTINE_SKIPPED,
      detail: `"${entry.routine.title}" on jäänyt väliin ${entry.skipCount} kertaa. `
        + 'Kannattaako sitä keventää tai siirtää toiseen aikaan?',
      routineId: entry.routine.id
    });
  }

  const lateMilestones = milestones.filter(milestone =>
    milestone && milestone.status === 'open'
    && milestone.targetDate && isIsoDate(todayIso)
    && milestone.targetDate < todayIso);

  for (const milestone of lateMilestones) {
    triggers.push({
      trigger: REPLAN_TRIGGER.MILESTONE_DELAYED,
      detail: `Välitavoite "${milestone.title}" oli määrä saavuttaa `
        + `${milestone.targetDate}.`,
      milestoneId: milestone.id,
      goalId: milestone.goalId
    });
  }

  // Menneet päivät kuuluvat MISSED_TASK-laukaisimelle, eivät tälle.
  const collisions = findCalendarCollisions({
    tasks, events, blocks, fromIso: isIsoDate(todayIso) ? todayIso : null
  });
  if (collisions.length > 0) {
    const first = collisions[0];
    triggers.push({
      trigger: REPLAN_TRIGGER.CONFLICT,
      detail: collisions.length === 1
        ? `"${first.title}" (${first.dateIso} klo ${first.time}) osuu ${first.phrase}. `
          + 'Ehdotan sille uutta aikaa.'
        : `${collisions.length} automaattisesti sijoitettua tehtävää osuu tapahtumaan, `
          + 'matkaan tai lepoon. Ehdotan niille uudet ajat.',
      taskIds: collisions.map(collision => collision.taskId),
      dateIsos: [...new Set(collisions.map(collision => collision.dateIso))]
    });
  }

  void goals;

  return { needed: triggers.length > 0, triggers };
}
