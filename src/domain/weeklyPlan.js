// Viikkosuunnitelma: sunnuntain nollauksen tulos.
//
// Puhdas moduuli: ei DOM:ia, ei verkkoa, ei kelloa.
//
// Yksi rivi viikkoa (maanantaita) kohti (weekly_plans, migraatio 0015):
//
//   priorities      ENINTÄÄN KOLME todellista viikon prioriteettia
//                   (kanta sallii viisi; käyttöliittymä rajaa kolmeen)
//   plannedMinutes  suunnitelman kesto viikon sulkemishetkellä
//                   (todellisuus/ajautuminen: CAPACITY_BIAS)
//   closedAt        viikko suljettu = suunniteltu
//
// Prioriteetti viittaa tehtävään, tavoitteeseen, projektiin tai alueeseen
// (`ref` = 'task:<id>' | 'goal:<id>' | 'project:<id>' | 'area:<id>') tai on
// pelkkä teksti ('text'). Viittaus ei ole vierasavain: poistettu kohde ei
// vie viikon suunnitelmaa mukanaan, se vain lakkaa osumasta.

import { isIsoDate } from './task.js';
import { weekdayOfIso } from './fiTemporal.js';

/** Omistajan päätös: oletuksena enintään kolme viikon prioriteettia. */
export const WEEKLY_PRIORITY_LIMIT = 3;
/** Kannan raja (0015 CHECK jsonb_array_length <= 5). */
export const WEEKLY_PRIORITY_DB_LIMIT = 5;
export const MAX_PRIORITY_TITLE_LENGTH = 200;
export const MAX_WEEKLY_NOTE_LENGTH = 1000;

const REF_PATTERN = /^(task|goal|project|area):[^\s]{1,200}$/;

function textOrNull(value, max) {
  if (value === null || value === undefined) return null;
  const text = String(value).normalize('NFC').trim();
  return text ? text.slice(0, max) : null;
}

export function normalizePriorityEntry(input) {
  if (!input || typeof input !== 'object') return null;
  const title = textOrNull(input.title, MAX_PRIORITY_TITLE_LENGTH);
  const ref = typeof input.ref === 'string' && REF_PATTERN.test(input.ref) ? input.ref : 'text';
  if (!title) return null;
  return { ref, title };
}

export function normalizeWeeklyPlan(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const seen = new Set();
  const priorities = [];
  for (const entry of Array.isArray(source.priorities) ? source.priorities : []) {
    const normalized = normalizePriorityEntry(entry);
    if (!normalized) continue;
    const key = normalized.ref === 'text' ? `text:${normalized.title.toLocaleLowerCase('fi')}` : normalized.ref;
    if (seen.has(key)) continue;
    seen.add(key);
    priorities.push(normalized);
    if (priorities.length >= WEEKLY_PRIORITY_DB_LIMIT) break;
  }
  const planned = Number(source.plannedMinutes);
  return {
    id: source.id != null && String(source.id) !== '' ? String(source.id) : null,
    weekStart: isIsoDate(source.weekStart) ? source.weekStart : null,
    priorities,
    plannedMinutes: source.plannedMinutes === null || source.plannedMinutes === undefined || !Number.isFinite(planned)
      ? null : Math.max(0, Math.min(10080, Math.round(planned))),
    closedAt: typeof source.closedAt === 'string' && source.closedAt ? source.closedAt : null,
    note: textOrNull(source.note, MAX_WEEKLY_NOTE_LENGTH),
    createdAt: source.createdAt ?? null,
    updatedAt: source.updatedAt ?? null
  };
}

export function validateWeeklyPlan(plan, { limit = WEEKLY_PRIORITY_LIMIT } = {}) {
  const errors = {};
  if (!plan || !isIsoDate(plan.weekStart)) errors.weekStart = 'Viikko puuttuu.';
  else if (weekdayOfIso(plan.weekStart) !== 1) errors.weekStart = 'Viikko alkaa maanantaista.';
  if (plan && Array.isArray(plan.priorities) && plan.priorities.length > limit) {
    errors.priorities = `Valitse enintään ${limit} viikon prioriteettia. Loput ovat tallessa.`;
  }
  return { valid: Object.keys(errors).length === 0, errors };
}

export function weeklyPlanFor(plans = [], weekStart) {
  return (Array.isArray(plans) ? plans : []).find(plan => plan && plan.weekStart === weekStart) || null;
}

export function isWeekClosed(plan) {
  return Boolean(plan && plan.closedAt);
}

/** Viittaus kohteeseen: 'task:abc'. */
export function priorityRef(kind, id) {
  return `${kind}:${id}`;
}
