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
// ne tulevat käyttäjän datasta, ja ne annetaan lukuina. Mallin säännöt
// elävät VAIN palvelimella (api/explain.js, `system`-kenttä): selaimen
// lähettämä teksti ei voi olla ohje.
//
// =====================================================================
// KONTEKSTI ON MINIMOITU
// =====================================================================
//
//   - EI tunnisteita, EI tehtävien tai tavoitteiden otsikoita, EI
//     muistiinpanoja, EI pohdintoja, EI kuvauksia, EI sääntötekstiä
//   - elämänalueiden NIMET korvataan tunnuksilla (A1, A2, ...). Nimet
//     palautetaan vasta paikallisesti (restoreAreaNames), joten edes
//     käyttäjän omat aluenimet ("Avioero", "Terapia") eivät lähde ulos
//   - luvut pyöristetään tunneiksi (0,5 h tarkkuus), ja minuuttikentät
//     nimetään tunneiksi (targetMinutes -> targetHours): malli ei saa
//     lukea tuntilukua minuutteina
//
// Tämä moduuli ei tee verkkokutsua. Kutsupolku on
// src/ai/alignmentExplainClient.js -> api/explain.js, ja se on oletuksena
// pois käytöstä (AI_EXPLAIN_ENABLED). Deterministinen selitys
// (alignmentReview.explainSignal) on aina varapolku.

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

/** Domainin minuuttikenttä -> lähtevän kontekstin tuntikenttä. Muut sellaisinaan. */
function wireMetric(key, value) {
  return /Minutes$/.test(key)
    ? [key.replace(/Minutes$/, 'Hours'), hoursOf(value)]
    : [key, value];
}

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
        const [wireKey, value] = wireMetric(key, signal.metrics[key]);
        metrics[wireKey] = value;
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
 * kokonaisena sanana (A1 ei osu A10:een eikä AA1:een).
 *
 * Yksi läpikäynti korvausfunktiolla: nimen $-merkkejä ("Raha $&") ei
 * tulkita korvauskaavana, eikä jo palautettu nimi ("Projekti A2") voi
 * osua seuraavaan tunnukseen. Tunnus, jolle ei ole nimeä, jää näkyviin
 * sellaisenaan — ei koskaan "undefined".
 */
export function restoreAreaNames(text, aliases) {
  return String(text ?? '').replace(/\bA\d+\b/g, alias => {
    if (!aliases.has(alias)) return alias;
    const name = aliases.get(alias);
    return name === null || name === undefined || name === '' ? alias : String(name);
  });
}
