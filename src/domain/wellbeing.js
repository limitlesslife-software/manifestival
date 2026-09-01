// Hyvinvoinnin kevyt perusta.
//
// Puhdas moduuli: ei DOM:ia, ei verkkoa, ei kelloa.
//
// TARKOITUKSELLISEN KEVYT
// Tämä EI ole terveyssovellus. Konseptidokumentin luku 18 rajaa asian
// yksiselitteisesti: "Manifestival ei korvaa terveydenhuollon ammattilaista
// eikä tee lääketieteellisiä diagnooseja."
//
// Tarkoitus on yksi: jotta suunnitelma voi joskus ottaa huomioon sen, missä
// kunnossa käyttäjä on. Neljä lukua riittää siihen.
//
// ⚠️ HYVINVOINTI EI KOSKAAN MUUTA SUUNNITELMAA ITSESTÄÄN
// Se antaa signaalin ja ehdotuksen. Se ei poista tehtäviä, siirrä määräaikoja
// eikä muuta prioriteetteja. Jos järjestelmä alkaisi karsia päivää sen
// perusteella, että käyttäjä merkitsi olevansa väsynyt, se veisi hallinnan
// juuri silloin kun sitä eniten tarvitaan.

import { isIsoDate } from './task.js';

/** Asteikko. Sama kaikille mittareille, jotta niitä ei tarvitse opetella erikseen. */
export const SCALE_MIN = 1;
export const SCALE_MAX = 5;

export const METRIC = Object.freeze({
  ENERGY: 'energy',
  MOOD: 'mood',
  STRESS: 'stress'
});

const METRIC_LABELS = Object.freeze({
  [METRIC.ENERGY]: 'Energia',
  [METRIC.MOOD]: 'Mieliala',
  [METRIC.STRESS]: 'Kuormitus'
});

export function metricLabel(metric) {
  return METRIC_LABELS[metric] || metric;
}

function clampScale(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(SCALE_MIN, Math.min(SCALE_MAX, Math.round(n)));
}

/**
 * Normalisoi hyvinvointimerkintä.
 * Kaikki kentät ovat vapaaehtoisia — osittainenkin merkintä on arvokas.
 */
export function normalizeWellbeingEntry(input = {}) {
  const sleepRaw = Number(input.sleepHours);
  const sleepHours = Number.isFinite(sleepRaw) && sleepRaw > 0
    ? Math.min(Math.round(sleepRaw * 10) / 10, 24)
    : null;

  return {
    id: input.id != null ? String(input.id) : null,
    date: isIsoDate(input.date) ? input.date : null,
    energy: clampScale(input.energy),
    mood: clampScale(input.mood),
    /** Korkea arvo = paljon kuormitusta. */
    stress: clampScale(input.stress),
    sleepHours,
    note: input.note ? String(input.note).trim().slice(0, 500) : null,
    createdAt: input.createdAt ?? null,
    updatedAt: input.updatedAt ?? null
  };
}

export function validateWellbeingEntry(entry) {
  const errors = {};
  if (!isIsoDate(entry.date)) errors.date = 'Päivämäärä puuttuu.';

  const hasAny = entry.energy != null || entry.mood != null
    || entry.stress != null || entry.sleepHours != null || entry.note;
  if (!hasAny) errors.entry = 'Merkitse edes yksi asia.';

  return { valid: Object.keys(errors).length === 0, errors };
}

/** Päivän merkintä, jos sellainen on. */
export function entryForDate(entries, dateIso) {
  if (!Array.isArray(entries)) return null;
  return entries.find(entry => entry.date === dateIso) || null;
}

/**
 * Keskiarvot viimeisiltä päiviltä.
 * Puuttuvat arvot ohitetaan — ne eivät saa vetää keskiarvoa alaspäin.
 */
export function averages(entries, { fromIso, toIso } = {}) {
  const inRange = (entries || []).filter(entry => {
    if (!entry.date) return false;
    if (fromIso && entry.date < fromIso) return false;
    if (toIso && entry.date > toIso) return false;
    return true;
  });

  const mean = key => {
    const values = inRange.map(e => e[key]).filter(v => v != null);
    if (values.length === 0) return null;
    return Math.round((values.reduce((sum, v) => sum + v, 0) / values.length) * 10) / 10;
  };

  return {
    days: inRange.length,
    energy: mean('energy'),
    mood: mean('mood'),
    stress: mean('stress'),
    sleepHours: mean('sleepHours')
  };
}

/** Kuormitustilan tasot. Vastaa konseptin luvun 16 liikennevaloa. */
export const LOAD_STATE = Object.freeze({
  UNKNOWN: 'unknown',
  GOOD: 'good',
  CAUTION: 'caution',
  STRAINED: 'strained'
});

/**
 * Arvioi käyttäjän kuormitustila merkinnöistä.
 * Palauttaa UNKNOWN, jos tietoa ei ole — arvaaminen olisi pahempaa kuin
 * myöntää tietämättömyys.
 */
export function assessLoadState(entry) {
  if (!entry) return LOAD_STATE.UNKNOWN;

  const signals = [];
  if (entry.energy != null) signals.push(entry.energy >= 4 ? 1 : entry.energy <= 2 ? -1 : 0);
  if (entry.mood != null) signals.push(entry.mood >= 4 ? 1 : entry.mood <= 2 ? -1 : 0);
  // Kuormitus on käänteinen: korkea arvo on huono.
  if (entry.stress != null) signals.push(entry.stress <= 2 ? 1 : entry.stress >= 4 ? -1 : 0);
  if (entry.sleepHours != null) signals.push(entry.sleepHours >= 7 ? 1 : entry.sleepHours < 6 ? -1 : 0);

  if (signals.length === 0) return LOAD_STATE.UNKNOWN;

  const total = signals.reduce((sum, value) => sum + value, 0);
  if (total <= -2) return LOAD_STATE.STRAINED;
  if (total < 0) return LOAD_STATE.CAUTION;
  return LOAD_STATE.GOOD;
}

/**
 * Ehdotus päivän kuormitukseen.
 *
 * ⚠️ TÄMÄ ON EHDOTUS, EI TOIMENPIDE.
 *
 * Funktio EI muuta tehtäviä, EI siirrä määräaikoja eikä EI muuta
 * prioriteetteja. Se palauttaa tekstin ja luvun, jotka käyttöliittymä voi
 * näyttää. Päätös on aina käyttäjän.
 *
 * @param {object} args
 * @param {object} [args.entry]    Päivän hyvinvointimerkintä
 * @param {object} [args.plan]     buildDayPlan-tulos
 * @returns {{state:string, suggestion:string|null, suggestedReduction:number, actionable:boolean}}
 */
export function planningLoadSuggestion({ entry = null, plan = null } = {}) {
  const state = assessLoadState(entry);
  const plannedCount = plan?.load?.count ?? 0;

  if (state === LOAD_STATE.UNKNOWN) {
    return {
      state,
      suggestion: null,
      suggestedReduction: 0,
      actionable: false
    };
  }

  if (state === LOAD_STATE.STRAINED) {
    // Ehdotetaan kevennystä, mutta vain jos päivässä on oikeasti karsittavaa.
    const reduction = plannedCount >= 5 ? Math.ceil(plannedCount * 0.3) : 0;
    return {
      state,
      suggestion: reduction > 0
        ? `Päivä näyttää raskaalta. Haluatko siirtää ${reduction} asiaa eteenpäin?`
        : 'Päivä näyttää raskaalta. Muista tauot.',
      suggestedReduction: reduction,
      actionable: reduction > 0
    };
  }

  if (state === LOAD_STATE.CAUTION) {
    return {
      state,
      suggestion: plannedCount >= 8
        ? 'Suunnitelma on tiivis. Kannattaako jokin siirtää?'
        : 'Ota päivä rauhallisesti.',
      suggestedReduction: 0,
      actionable: false
    };
  }

  return {
    state,
    suggestion: plannedCount === 0
      ? 'Hyvä vireystila. Tässä olisi tilaa isommalle asialle.'
      : null,
    suggestedReduction: 0,
    actionable: false
  };
}

/** Kuormitustilan teksti käyttöliittymälle. */
export function loadStateLabel(state) {
  switch (state) {
    case LOAD_STATE.GOOD: return 'Hyvä vire';
    case LOAD_STATE.CAUTION: return 'Kohtalainen';
    case LOAD_STATE.STRAINED: return 'Kuormittunut';
    default: return 'Ei tietoa';
  }
}
