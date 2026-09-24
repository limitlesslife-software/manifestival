// Suunnan konteksti tekoälylle — selitystä varten, EI päätöksentekoon.
//
// =====================================================================
// TEKOÄLY EI PÄÄTÄ MITÄÄN
// =====================================================================
//
// Havainnot (kuormitus, huomiotta jääminen, poikkeama) on jo laskettu
// deterministisesti (src/domain/alignment.js). Tekoäly saa ne VALMIINA ja
// voi enintään muotoilla selityksen tai kysymyksen käyttäjälle.
//
// Tekoäly ei keksi tärkeyttä, kapasiteettia, arvoja eikä tavoitteita:
// ne tulevat käyttäjän datasta, ja ne annetaan lukuina.
//
// =====================================================================
// KONTEKSTI ON MINIMOITU
// =====================================================================
//
//   - EI tunnisteita, EI tehtävien tai tavoitteiden otsikoita, EI
//     muistiinpanoja, EI pohdintoja, EI kuvauksia
//   - elämänalueiden NIMET korvataan tunnuksilla (A1, A2, ...). Nimet
//     palautetaan vasta paikallisesti (restoreAreaNames), joten edes
//     käyttäjän omat aluenimet ("Avioero", "Terapia") eivät lähde ulos
//   - luvut pyöristetään tunneiksi (0,5 h tarkkuus)
//
// Tämä moduuli ei tee verkkokutsua. Kutsupolku (palvelinpääte) on
// tarkoituksella rakentamatta: deterministinen selitys
// (alignmentReview.explainSignal) riittää ensimmäiseen versioon.

/** Ohje mallille. Kiinteä: malli ei saa muuttaa havaintoja. */
export const ASSISTANT_RULES = Object.freeze([
  'Selitä annetut havainnot suomeksi, lyhyesti ja toteavasti.',
  'Älä lisää, poista tai muuta havaintoja; ne on laskettu jo.',
  'Älä keksi tärkeyttä, kapasiteettia, arvoja tai tavoitteita.',
  'Älä moralisoi. Tarjoa valinta: keventää, muuttaa tavoitetta tai jatkaa ennallaan.'
]);

function hoursOf(minutes) {
  return Number.isFinite(minutes) ? Math.round((minutes / 60) * 2) / 2 : null;
}

const SIGNAL_METRIC_KEYS = Object.freeze([
  'plannedMinutes', 'availableMinutes', 'overageMinutes', 'percentOfCapacity', 'unknownCount',
  'targetMinutes', 'expectedByNowMinutes', 'actualMinutes', 'percentOfExpected',
  'weekProgressPercent', 'direction', 'desiredPercent', 'actualPercent', 'deviationPoints',
  'coveragePercent', 'incomplete', 'targetsMinutes', 'differenceMinutes',
  // Energiakuormitus (Suunta 2). Vain lukuja ja totuusarvoja.
  'heavyMinutes', 'veryHeavyMinutes', 'energyBudgetMinutes', 'percentOfBudget',
  'unratedCount', 'unratedMinutes', 'timeOverloaded', 'heavySharePercent', 'energyLevel', 'knownMinutes'
]);

/**
 * Rakenna minimoitu konteksti.
 *
 * @param {object} analysis analyzeWeek()-tulos
 * @returns {{context: object, aliases: Map<string, string>}} aliases: tunnus -> oikea nimi
 */
export function buildAlignmentAssistantContext(analysis) {
  const aliases = new Map();
  const aliasById = new Map();
  (analysis.areas || []).forEach((area, index) => {
    const alias = `A${index + 1}`;
    aliasById.set(area.id, alias);
    aliases.set(alias, area.name);
  });

  const signals = (analysis.signals || []).map(signal => {
    const metrics = {};
    for (const key of SIGNAL_METRIC_KEYS) {
      if (signal.metrics && Object.prototype.hasOwnProperty.call(signal.metrics, key)) {
        const value = signal.metrics[key];
        metrics[key] = /Minutes$/.test(key) ? hoursOf(value) : value;
      }
    }
    return {
      kind: signal.kind,
      severity: signal.severity,
      area: signal.areaId ? aliasById.get(signal.areaId) || null : null,
      basis: signal.basis,
      metrics
    };
  });

  const context = {
    rules: [...ASSISTANT_RULES],
    capacityHours: hoursOf(analysis.capacity ? analysis.capacity.availableMinutes : null),
    plannedHours: hoursOf(analysis.planned ? analysis.planned.knownMinutes : null),
    unestimatedCount: analysis.planned ? analysis.planned.unknownCount : 0,
    actualHours: hoursOf(analysis.actual ? analysis.actual.minutes : null),
    dataQuality: analysis.dataQuality ? analysis.dataQuality.level : null,
    areas: (analysis.areas || []).map(area => ({
      area: aliasById.get(area.id),
      importance: area.importance,
      active: area.active,
      targetHours: hoursOf(area.targetMinutes),
      plannedHours: hoursOf(area.plannedMinutes),
      actualHours: hoursOf(area.actualMinutes)
    })),
    signals
  };
  return { context, aliases };
}

/**
 * Palauta aluenimet mallin tekstiin paikallisesti. Tunnus korvataan vain
 * kokonaisena sanana (A1 ei osu A10:een).
 */
export function restoreAreaNames(text, aliases) {
  let result = String(text ?? '');
  const ordered = [...aliases.entries()].sort((a, b) => b[0].length - a[0].length);
  for (const [alias, name] of ordered) {
    result = result.replace(new RegExp(`\\b${alias}\\b`, 'g'), name);
  }
  return result;
}
