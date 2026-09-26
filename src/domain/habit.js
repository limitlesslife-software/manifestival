// Tapojen muutos: suunnitelmat ja kirjaukset.
//
// PUHDAS MODUULI: ei kelloa, ei DOM:ia, ei verkkoa.
//
// KÄYTTÄJÄN OMAT LUVUT. Väli, päivän tavoite, lähtötaso ja porrastus
// ovat käyttäjän asettamia; sovellus ei tuo väestönormeja eikä
// lääketieteellisiä väitteitä. Nolla päivässä on kelvollinen tavoite
// (lopettaminen) — ja siksi tuntematon on null, ei nolla.
//
// NEUTRAALI KIELI: kirjaus on käyttö, lykkäys tai väliin jättäminen. Ei
// "retkahdusta", ei "epäonnistumista". Nikotiini ja muut tavat ovat
// arkaluonteisia: ne eivät kulje tekoälylle eivätkä lokiin.

import {
  HABIT_KIND, HABIT_KINDS, HABIT_ACTIONS, DELIVERY, DELIVERIES, MAX_HABIT_STEPS
} from './dailyLife.js';
import {
  idOrNull, textOrNull, requiredText, intOrNull, boolOr, oneOf, dateOrNull, timestampOrNull
} from './entityFields.js';

// Vastaavat migraation 0014 CHECK-rajoitteita (habit_plans_*, habit_events_*).
export const MAX_HABIT_NAME_LENGTH = 80;
export const MAX_HABIT_INTERVAL_MINUTES = 1440;
export const MAX_HABIT_DAILY_TARGET = 200;
export const MAX_HABIT_UNIT_COST_MINOR = 10000000;
export const MAX_HABIT_EVENT_NOTE_LENGTH = 200;

/**
 * Porrastus: [{from, intervalMinutes, dailyTarget}] nousevasti alkupäivän
 * mukaan. Porras ilman alkupäivää tai ilman yhtään lukua ei tarkoita
 * mitään ja pudotetaan. Sama päivä kahdesti: viimeinen voittaa.
 */
function normalizeSteps(value) {
  if (!Array.isArray(value)) return [];
  const byDate = new Map();
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const from = dateOrNull(raw.from);
    if (!from) continue;
    const intervalMinutes = intOrNull(raw.intervalMinutes, 1, MAX_HABIT_INTERVAL_MINUTES);
    const dailyTarget = intOrNull(raw.dailyTarget, 0, MAX_HABIT_DAILY_TARGET);
    if (intervalMinutes === null && dailyTarget === null) continue;
    byDate.set(from, { from, intervalMinutes, dailyTarget });
  }
  return [...byDate.values()].sort((a, b) => a.from.localeCompare(b.from)).slice(0, MAX_HABIT_STEPS);
}

/** Normalisoi suunnitelma. Ei heitä; roska -> null tai oletus. */
export function normalizeHabitPlan(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  return {
    id: idOrNull(source.id),
    kind: oneOf(source.kind, HABIT_KINDS, HABIT_KIND.GENERIC),
    name: requiredText(source.name, MAX_HABIT_NAME_LENGTH),
    minIntervalMinutes: intOrNull(source.minIntervalMinutes, 1, MAX_HABIT_INTERVAL_MINUTES),
    dailyTarget: intOrNull(source.dailyTarget, 0, MAX_HABIT_DAILY_TARGET),
    baselinePerDay: intOrNull(source.baselinePerDay, 0, MAX_HABIT_DAILY_TARGET),
    steps: normalizeSteps(source.steps),
    // Hiljainen oletus: muistutus ei kuulu, ellei käyttäjä valitse toisin.
    reminderDelivery: oneOf(source.reminderDelivery, DELIVERIES, DELIVERY.SILENT),
    unitCostMinor: intOrNull(source.unitCostMinor, 0, MAX_HABIT_UNIT_COST_MINOR),
    active: boolOr(source.active, true),
    createdAt: source.createdAt ?? null,
    updatedAt: source.updatedAt ?? null
  };
}

export function validateHabitPlan(plan) {
  const errors = {};
  if (!plan || typeof plan !== 'object') return { valid: false, errors: { plan: 'Suunnitelmaa ei ole.' } };
  if (!plan.name) errors.name = 'Anna tavalle nimi.';
  if (!HABIT_KINDS.includes(plan.kind)) errors.kind = 'Valitse tavan laji.';
  if (Array.isArray(plan.steps) && plan.steps.length > MAX_HABIT_STEPS) {
    errors.steps = `Portaita voi olla enintään ${MAX_HABIT_STEPS}.`;
  }
  return { valid: Object.keys(errors).length === 0, errors };
}

/**
 * Suunnitelman voimassa oleva porras päivänä `dateIso`: viimeisin porras,
 * jonka alkupäivä on viimeistään tämä päivä. Ennen ensimmäistä porrasta
 * pätevät suunnitelman omat luvut. Päivä annetaan (ei kelloa).
 */
export function activeHabitStep(plan, dateIso) {
  const normalized = normalizeHabitPlan(plan);
  const fallback = { from: null, intervalMinutes: normalized.minIntervalMinutes, dailyTarget: normalized.dailyTarget };
  if (!dateOrNull(dateIso)) return fallback;
  let active = null;
  for (const step of normalized.steps) if (step.from <= dateIso) active = step;
  return active
    ? {
      from: active.from,
      intervalMinutes: active.intervalMinutes ?? normalized.minIntervalMinutes,
      dailyTarget: active.dailyTarget ?? normalized.dailyTarget
    }
    : fallback;
}

/** Normalisoi kirjaus. Tuntematon toiminto on null (validointi kertoo), ei arvattu. */
export function normalizeHabitEvent(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  return {
    id: idOrNull(source.id),
    planId: idOrNull(source.planId),
    occurredAt: timestampOrNull(source.occurredAt),
    action: oneOf(source.action, HABIT_ACTIONS, null),
    note: textOrNull(source.note, MAX_HABIT_EVENT_NOTE_LENGTH),
    createdAt: source.createdAt ?? null,
    updatedAt: source.updatedAt ?? null
  };
}

export function validateHabitEvent(event) {
  const errors = {};
  if (!event || typeof event !== 'object') return { valid: false, errors: { event: 'Kirjausta ei ole.' } };
  if (!event.planId) errors.planId = 'Valitse tapa, johon kirjaus kuuluu.';
  if (!event.occurredAt) errors.occurredAt = 'Ajankohta puuttuu.';
  if (!HABIT_ACTIONS.includes(event.action)) errors.action = 'Valitse, mitä kirjaat.';
  return { valid: Object.keys(errors).length === 0, errors };
}
