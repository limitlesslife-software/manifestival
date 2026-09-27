// Liikuntakerrat: suunniteltu ja toteutunut.
//
// PUHDAS MODUULI: ei kelloa, ei DOM:ia, ei verkkoa.
//
// Kuormittavuus (`intensity`) ja palautumisen tarve (`recoveryDemand`)
// ovat käyttäjän omia arvioita asteikolla 1–5. null = ei arvioitu, EI
// nolla: arvioimaton kerta ei ole kevein mahdollinen. Suunniteltu ja
// toteutunut kesto pidetään erillään: suunnitelmaa ei kopioida
// toteumaksi.

import { SCALE_MIN, SCALE_MAX } from './wellbeing.js';
import {
  idOrNull, textOrNull, requiredText, intOrNull, scaleOrNull, dateOrNull
} from './entityFields.js';

// Vastaavat migraation 0014 CHECK-rajoitteita (exercise_sessions_*).
export const MAX_EXERCISE_KIND_LENGTH = 60;
export const MAX_EXERCISE_MINUTES = 1440;
export const MAX_EXERCISE_NOTE_LENGTH = 500;

/** Normalisoi liikuntakerta. Ei heitä; roska -> null. */
export function normalizeExerciseSession(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  return {
    id: idOrNull(source.id),
    date: dateOrNull(source.date),
    // Käyttäjän oma nimike ("juoksu", "sali"), ei luettelo.
    kind: requiredText(source.kind, MAX_EXERCISE_KIND_LENGTH),
    plannedMinutes: intOrNull(source.plannedMinutes, 1, MAX_EXERCISE_MINUTES),
    actualMinutes: intOrNull(source.actualMinutes, 1, MAX_EXERCISE_MINUTES),
    intensity: scaleOrNull(source.intensity, SCALE_MIN, SCALE_MAX),
    recoveryDemand: scaleOrNull(source.recoveryDemand, SCALE_MIN, SCALE_MAX),
    goalId: idOrNull(source.goalId),
    note: textOrNull(source.note, MAX_EXERCISE_NOTE_LENGTH),
    createdAt: source.createdAt ?? null,
    updatedAt: source.updatedAt ?? null
  };
}

export function validateExerciseSession(session) {
  const errors = {};
  if (!session || typeof session !== 'object') return { valid: false, errors: { session: 'Kertaa ei ole.' } };
  if (!dateOrNull(session.date)) errors.date = 'Valitse päivä.';
  if (!session.kind) errors.kind = 'Mitä liikuntaa?';
  return { valid: Object.keys(errors).length === 0, errors };
}
