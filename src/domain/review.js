// Katsaukset: illan päätös ja viikon yhteenveto.
//
// Puhdas moduuli: ei DOM:ia, ei verkkoa, ei kelloa, ei AI:ta.
//
// MIKSI KATSAUKSET
// Konseptidokumentin luku 7 päättää perusketjun sanoihin "seuranta →
// oppiminen → parempi seuraava suunnitelma". Ilman katsausta ketju katkeaa:
// päivä päättyy, mutta mitään ei opita.
//
// Katsaus koostetaan PAIKALLISESTA DATASTA. AI-yhteenveto voidaan lisätä
// myöhemmin päälle, mutta se ei ole edellytys — järjestelmän pitää osata
// kertoa mitä tapahtui ilman mallia.
//
// EI PAKOTETTUA JOURNALOINTIA
// Katsaus näyttää faktat ja ehdottaa siirtoja. Se ei kysy "miltä tuntui"
// eikä vaadi kirjoittamaan mitään.

import { fmtISO, parseISO, addDays, startOfWeek } from '../lib/datetime.js';
import { isOverdue, deadlineUrgency, URGENCY, compareForDay } from './task.js';
import { weekDayIsoList } from './week.js';
import { computeGoalProgress, isOpenGoal, isGoalOverdue } from './goal.js';
import { todayFocus, rankTasks } from './focus.js';

/** Montako ehdotusta katsaus enintään nostaa. */
export const MAX_SUGGESTIONS = 5;

/**
 * Illan katsaus.
 *
 * Vastaa kolmeen kysymykseen: mikä valmistui, mikä jäi, mitä huomenna.
 *
 * @param {object} args
 * @param {Array}  args.tasks
 * @param {string} args.dateIso   Päättyvä päivä
 * @param {string} [args.todayIso]
 * @param {Array}  [args.routineOccurrences]
 */
export function buildEveningReview({
  tasks = [],
  dateIso,
  todayIso = null,
  routineOccurrences = []
} = {}) {
  const reference = todayIso || dateIso;
  const tomorrowIso = fmtISO(addDays(parseISO(dateIso), 1));

  const dayTasks = tasks.filter(task => task.date === dateIso);
  const completed = dayTasks.filter(task => task.completed).sort(compareForDay);
  const remaining = dayTasks.filter(task => !task.completed).sort(compareForDay);

  // Siirtoehdotukset: kesken jääneet, joilla ei ole tämän päivän määräaikaa.
  // Määräaikaan sidottua ei ehdoteta siirrettäväksi — se ei ratkaisisi mitään.
  const moveCandidates = remaining.filter(task => {
    const urgency = deadlineUrgency(task, reference);
    return urgency !== URGENCY.OVERDUE && urgency !== URGENCY.TODAY;
  }).slice(0, MAX_SUGGESTIONS);

  const stuck = remaining.filter(task => {
    const urgency = deadlineUrgency(task, reference);
    return urgency === URGENCY.OVERDUE || urgency === URGENCY.TODAY;
  });

  const tomorrowTop = todayFocus({
    tasks,
    dateIso: tomorrowIso,
    todayIso: reference,
    limit: 3
  });

  const routinesDone = routineOccurrences.filter(o => o.date === dateIso).length;

  return {
    dateIso,
    tomorrowIso,
    completed,
    remaining,
    /** Kesken jääneet, jotka voi turvallisesti siirtää huomiselle. */
    moveCandidates,
    /** Kesken jääneet, joita EI voi vain siirtää — määräaika painaa. */
    stuck,
    tomorrowTop,
    stats: {
      planned: dayTasks.length,
      completed: completed.length,
      remaining: remaining.length,
      routines: routinesDone,
      completionRate: dayTasks.length === 0
        ? null
        : Math.round((completed.length / dayTasks.length) * 100)
    }
  };
}

/**
 * Viikkokatsaus.
 *
 * @param {object} args
 * @param {Array}  args.tasks
 * @param {Array}  [args.goals]
 * @param {string} args.weekStartIso  Viikon maanantai
 * @param {string} [args.todayIso]
 */
export function buildWeeklyReview({
  tasks = [],
  goals = [],
  weekStartIso,
  todayIso = null
} = {}) {
  const monday = startOfWeek(parseISO(weekStartIso));
  const days = weekDayIsoList(monday);
  const reference = todayIso || days[0];

  const weekTasks = tasks.filter(task => days.includes(task.date));
  const completed = weekTasks.filter(task => task.completed);
  const open = weekTasks.filter(task => !task.completed);

  // Myöhässä olevat lasketaan KOKO tehtäväjoukosta: viikkokatsauksen pitää
  // kertoa myös vanhemmista rästeistä, ei vain tämän viikon.
  const overdue = tasks.filter(task => isOverdue(task, reference));

  const byDay = days.map(dateIso => {
    const dayTasks = weekTasks.filter(task => task.date === dateIso);
    return {
      dateIso,
      total: dayTasks.length,
      completed: dayTasks.filter(task => task.completed).length
    };
  });

  const goalProgress = (goals || [])
    .filter(isOpenGoal)
    .map(goal => ({
      goal,
      progress: computeGoalProgress(goal, tasks),
      overdue: isGoalOverdue(goal, reference)
    }))
    .sort((a, b) => {
      if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
      return b.progress.percent - a.progress.percent;
    });

  const nextWeekStart = fmtISO(addDays(monday, 7));
  const nextWeekDays = weekDayIsoList(parseISO(nextWeekStart));
  const nextWeekTasks = tasks.filter(task => nextWeekDays.includes(task.date) && !task.completed);

  // rankTasks eikä todayFocus: seuraavan viikon tärkeimmät nostetaan KOKO
  // viikolta, ei pelkästään maanantailta.
  const nextWeekTop = rankTasks({
    tasks: [...nextWeekTasks, ...overdue],
    dateIso: nextWeekStart,
    todayIso: reference,
    limit: 5
  });

  const busiest = [...byDay].sort((a, b) => b.total - a.total)[0] || null;

  return {
    weekStartIso: days[0],
    weekEndIso: days[6],
    days: byDay,
    completed,
    open,
    overdue,
    goalProgress,
    nextWeekStart,
    nextWeekTop,
    stats: {
      planned: weekTasks.length,
      completed: completed.length,
      open: open.length,
      overdue: overdue.length,
      completionRate: weekTasks.length === 0
        ? null
        : Math.round((completed.length / weekTasks.length) * 100),
      busiestDay: busiest && busiest.total > 0 ? busiest.dateIso : null,
      activeGoals: goalProgress.length
    }
  };
}

/**
 * Lyhyt sanallinen yhteenveto ilman AI:ta.
 *
 * Sävy on tarkoituksella toteava. Konseptidokumentin luku 16: "Tavoitteena ei
 * ole syyllistää käyttäjää, vaan auttaa jatkamaan silloin, kun täydellinen
 * suoritus ei ole mahdollinen."
 */
export function summarizeReview(stats) {
  if (!stats || stats.planned === 0) {
    return 'Ei suunniteltua. Tyhjä päivä on myös valinta.';
  }
  if (stats.completed === stats.planned) {
    return `Kaikki ${stats.planned} suunniteltua valmistui.`;
  }
  if (stats.completed === 0) {
    return `${stats.planned} suunniteltua jäi kesken. Siirretäänkö osa eteenpäin?`;
  }
  return `${stats.completed}/${stats.planned} valmistui.`;
}
