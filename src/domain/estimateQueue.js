// Kestoarvioiden jono: mitkä asiat kannattaa arvioida ensin.
//
// Puhdas moduuli: ei DOM:ia, ei verkkoa, ei kelloa (tämä päivä annetaan).
//
// =====================================================================
// JÄRJESTYS ON DETERMINISTINEN JA SELITETTÄVÄ
// =====================================================================
//
//   1. tänään         näytetyn viikon tämän päivän asiat
//   2. tämä viikko    näytetyn viikon muut päivät, päivämäärän mukaan
//   3. ensi viikko    seuraavan viikon asiat (includeNextWeek)
//   4. rästissä       ennen näytettyä viikkoa päivätyt avoimet tehtävät,
//                     VAIN pyydettäessä (includeOverdue)
//
// Saman ryhmän sisällä: päivä, prioriteetti (tärkeä, normaali, voi
// odottaa), määräaika (aiempi ensin, puuttuva viimeisenä) ja lopuksi
// tunniste. Sama syöte antaa aina saman jonon.
//
// =====================================================================
// JONO EHDOTTAA, EI PAKOTA
// =====================================================================
//
// Valmiit tehtävät, herätykset ja jo arvioidut eivät ole jonossa. Käyttäjä
// päättää, kuinka monta arvioi: 36 arvioimatonta tehtävää ei tarkoita 36
// pakollista kysymystä. Rutiini arvioidaan kerran (sääntö), ei jokaisena
// esiintymänä.

import { durationOf } from './task.js';
import { expandRoutines } from './routine.js';
import { weekDates, weekStartOf, nextWeekStart } from './weeklyCapacity.js';
import { priorityWeight } from './priority.js';

export const ESTIMATE_BUCKET = Object.freeze({
  TODAY: 'today',
  WEEK: 'week',
  NEXT: 'next',
  OVERDUE: 'overdue'
});

export const ESTIMATE_BUCKET_LABELS = Object.freeze({
  today: 'Tänään',
  week: 'Tällä viikolla',
  next: 'Ensi viikolla',
  overdue: 'Rästissä'
});

const BUCKET_ORDER = Object.freeze([
  ESTIMATE_BUCKET.TODAY, ESTIMATE_BUCKET.WEEK, ESTIMATE_BUCKET.NEXT, ESTIMATE_BUCKET.OVERDUE
]);

function hasEstimate(minutes) {
  return Number.isFinite(minutes) && minutes > 0;
}

/**
 * Arvioitavat asiat järjestyksessä.
 *
 * @param {object} input
 * @param {Array} input.tasks
 * @param {Array} [input.routines]
 * @param {Array} [input.exceptions]      rutiinien poikkeukset
 * @param {string} input.todayIso
 * @param {string} [input.weekStart]      näytetty viikko (oletus: tämän päivän viikko)
 * @param {boolean} [input.includeNextWeek=true]
 * @param {boolean} [input.includeOverdue=false]
 * @returns {Array<{key: string, kind: 'task'|'routine', id: string, routineId?: string,
 *   date: string, bucket: string}>}
 */
export function estimateCandidates({
  tasks = [], routines = [], exceptions = [], todayIso, weekStart = null,
  includeNextWeek = true, includeOverdue = false
} = {}) {
  const monday = weekStartOf(weekStart || todayIso);
  const week = weekDates(monday);
  if (week.length === 0) return [];
  const inWeek = new Set(week);
  const next = includeNextWeek ? weekDates(nextWeekStart(monday)) : [];
  const inNext = new Set(next);

  const bucketOf = date => {
    if (!date) return null;
    if (inWeek.has(date)) return date === todayIso ? ESTIMATE_BUCKET.TODAY : ESTIMATE_BUCKET.WEEK;
    if (inNext.has(date)) return ESTIMATE_BUCKET.NEXT;
    // Rästi: ennen näytettyä viikkoa ja ennen tätä päivää.
    if (includeOverdue && date < week[0] && (!todayIso || date < todayIso)) return ESTIMATE_BUCKET.OVERDUE;
    return null;
  };

  const candidates = [];
  for (const task of tasks || []) {
    if (!task || !task.id || task.completed || task.isWake) continue;
    if (hasEstimate(durationOf(task))) continue;
    const bucket = bucketOf(task.date);
    if (!bucket) continue;
    candidates.push({
      key: 'task:' + task.id, kind: 'task', id: String(task.id), date: task.date, bucket,
      priority: priorityWeight(task.priority), deadline: task.deadline || null
    });
  }

  // Rutiini: yksi ehdokas säännölle, ensimmäisen arvioimattoman esiintymän päivällä.
  const lastDay = (next.length ? next : week)[6];
  const firstDay = week[0];
  const seen = new Set();
  const active = (routines || []).filter(routine => routine && routine.id && routine.active !== false);
  for (const occurrence of expandRoutines({ routines: active, from: firstDay, to: lastDay, exceptions })) {
    if (seen.has(occurrence.routineId) || hasEstimate(occurrence.durationMinutes)) continue;
    const bucket = bucketOf(occurrence.date);
    if (!bucket) continue;
    seen.add(occurrence.routineId);
    candidates.push({
      key: 'routine:' + occurrence.routineId, kind: 'routine', id: String(occurrence.routineId),
      routineId: String(occurrence.routineId), date: occurrence.date, bucket,
      priority: priorityWeight(occurrence.priority), deadline: null
    });
  }

  candidates.sort(compareCandidates);
  return candidates.map(({ priority, deadline, ...rest }) => rest);
}

function compareCandidates(a, b) {
  const bucket = BUCKET_ORDER.indexOf(a.bucket) - BUCKET_ORDER.indexOf(b.bucket);
  if (bucket !== 0) return bucket;
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  if (a.priority !== b.priority) return a.priority - b.priority;
  if (a.deadline !== b.deadline) {
    if (!a.deadline) return 1;
    if (!b.deadline) return -1;
    return a.deadline < b.deadline ? -1 : 1;
  }
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/** Montako ehdokasta kussakin ryhmässä (otsikkoa ja laskuria varten). */
export function countByBucket(candidates = []) {
  const counts = { today: 0, week: 0, next: 0, overdue: 0 };
  for (const candidate of candidates) {
    if (counts[candidate.bucket] !== undefined) counts[candidate.bucket] += 1;
  }
  return counts;
}
