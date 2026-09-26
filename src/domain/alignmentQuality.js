// Aineiston laatu v2: mitä puuttuu ja mitä sille voi tehdä.
//
// Puhdas moduuli: ei DOM:ia, ei verkkoa, ei kelloa.
//
// Ensimmäinen versio kertoi tason (kattava/osittainen/vajaa) ja syyt.
// Tämä muuttaa jokaisen syyn LAUSEEKSI JA TOIMENPITEEKSI:
//
//   "42 % tämän viikon tehtävistä ei sisällä aika-arviota."  -> Arvioi
//   "Vain 35 % kirjatusta ajasta on yhdistetty elämänalueisiin." -> Kohdista
//   "Et ole vielä kirjannut toteutunutta aikaa."              -> Kirjaa
//
// SÄVY: puute on aineiston ominaisuus, ei käyttäjän vika. Ei "sinun
// pitäisi", ei "muista". Lause kertoo mitä tiedetään ja mitä ei.
//
// HARVAT ARVIOT (sääntöversio 3): kun alle QUALITY_RULES.ESTIMATE_COVERAGE_WARN
// suunnitelluista asioista on arvioitu, Suunta sanoo sen ENSIMMÄISENÄ
// (SPARSE_ESTIMATES_NOTICE). Havainnot näkyvät yhä sen alla: sovellus on
// käytettävä vähälläkin aineistolla, ja arvio tarkentuu arvioiden myötä.

import { QUALITY_RULES, TIME_RULES } from './alignmentPolicy.js';
import { countOf } from './lifeArea.js';

/** Harvan arvioaineiston ilmoitus: sama lause Suunnassa ja päivän kortissa. */
export const SPARSE_ESTIMATES_NOTICE = 'Suunnan arvio tarkentuu, kun lisäät aika-arvioita.';

/** Arvioiden kattavuuden taso (ei pisteytys: kertoo vain, paljonko kestoista tiedetään). */
export const ESTIMATE_CONFIDENCE = Object.freeze({ SPARSE: 'sparse', PARTIAL: 'partial', OK: 'ok' });

/**
 * Kuinka luotettava suunnitelman kuva on arvioiden osalta.
 *
 *   sparse   alle TIME_RULES.MIN_ESTIMATE_COVERAGE asioista on arvioitu
 *   partial  alle QUALITY_RULES.ESTIMATE_COVERAGE_WARN
 *   ok       muuten, tai viikolla ei ole suunniteltuja asioita
 */
export function estimateConfidence(analysis) {
  const planned = analysis && analysis.planned;
  if (!planned || !(planned.itemCount > 0)) return ESTIMATE_CONFIDENCE.OK;
  const coverage = planned.estimatedCount / planned.itemCount;
  if (coverage < TIME_RULES.MIN_ESTIMATE_COVERAGE) return ESTIMATE_CONFIDENCE.SPARSE;
  if (coverage < QUALITY_RULES.ESTIMATE_COVERAGE_WARN) return ESTIMATE_CONFIDENCE.PARTIAL;
  return ESTIMATE_CONFIDENCE.OK;
}

/** Avoimet (ei valmiiksi merkityt) asiat ilman kestoa: vain niitä voi vielä arvioida. */
export function openUnknownCountOf(analysis) {
  const planned = (analysis && analysis.planned) || {};
  return Number.isInteger(planned.openUnknownCount) ? planned.openUnknownCount : (planned.unknownCount || 0);
}

export const QUALITY_ACTION = Object.freeze({
  ADD_AREAS: 'add_areas',
  SET_TARGETS: 'set_targets',
  SET_CAPACITY: 'set_capacity',
  ESTIMATE: 'estimate',
  ASSIGN: 'assign',
  /** Kirjattu aika ilman aluetta: näytä kirjaukset, joille alueen voi valita. */
  ASSIGN_TIME: 'assign_time',
  LOG_TIME: 'log_time',
  RATE_ENERGY: 'rate_energy'
});

export const QUALITY_ACTION_LABELS = Object.freeze({
  add_areas: 'Lisää elämänalue',
  set_targets: 'Aseta aikatavoite',
  set_capacity: 'Aseta kapasiteetti',
  estimate: 'Arvioi tehtäviä',
  assign: 'Kohdista luokittelemattomat',
  assign_time: 'Kohdista kirjattu aika',
  log_time: 'Kirjaa aikaa',
  rate_energy: 'Arvioi kuormittavuus'
});

function percentOf(part, whole) {
  return whole > 0 ? Math.round((part / whole) * 100) : null;
}

/**
 * Aineiston puutteet toimenpiteineen, tärkein ensin.
 *
 * @param {object} analysis analyzeWeek()-tulos
 * @returns {Array<{code: string, text: string, action: string|null, percent: number|null}>}
 */
export function qualityIssues(analysis) {
  if (!analysis) return [];
  const issues = [];
  const quality = analysis.dataQuality || { reasons: [] };
  const reasons = new Set(quality.reasons || []);
  const planned = analysis.planned || { itemCount: 0, unknownCount: 0 };

  if (reasons.has('no_areas')) {
    issues.push({ code: 'no_areas', percent: null, action: QUALITY_ACTION.ADD_AREAS,
      text: 'Elämänalueita ei ole vielä määritelty, joten tekemistä ei voi verrata siihen mikä on sinulle tärkeää.' });
    return issues;
  }
  const openUnknown = openUnknownCountOf(analysis);
  if (estimateConfidence(analysis) !== ESTIMATE_CONFIDENCE.OK) {
    // Ensimmäisenä: ilman tätä harvasta aineistosta tehdyt havainnot
    // näyttäisivät yhtä varmoilta kuin kattavasta.
    issues.push({
      code: 'sparse_estimates', percent: percentOf(planned.estimatedCount || 0, planned.itemCount),
      action: openUnknown > 0 ? QUALITY_ACTION.ESTIMATE : null, text: SPARSE_ESTIMATES_NOTICE
    });
  }
  if (reasons.has('no_targets')) {
    issues.push({ code: 'no_targets', percent: null, action: QUALITY_ACTION.SET_TARGETS,
      text: 'Alueilla ei ole aikatavoitteita, joten ajan jakaumaa ei voi verrata toiveisiisi.' });
  }
  if (reasons.has('no_capacity')) {
    issues.push({ code: 'no_capacity', percent: null, action: QUALITY_ACTION.SET_CAPACITY,
      text: 'Tälle viikolle ei ole kapasiteettia, joten kuormitusta ei voi arvioida.' });
  }

  // Arvioitavissa olevat: avoimet asiat ilman kestoa. Valmiiksi merkityt
  // ilman kestoa ovat tieto, eivät toimenpide.
  const unestimatedPercent = percentOf(openUnknown, planned.itemCount);
  if (openUnknown > 0) {
    issues.push({
      code: 'unestimated_work', percent: unestimatedPercent, action: QUALITY_ACTION.ESTIMATE,
      text: `${unestimatedPercent} % tämän viikon suunnitelluista asioista ei sisällä aika-arviota`
        + ` (${openUnknown} kpl). Niitä ei lasketa kuormaan.`
    });
  }
  const completedUnknown = Math.max(0, (planned.unknownCount || 0) - openUnknown);
  if (completedUnknown > 0) {
    issues.push({
      code: 'unestimated_completed', percent: null, action: null,
      text: `${countOf(completedUnknown, 'valmiiksi merkitty', 'valmiiksi merkittyä')} ilman arviota (ei lasketa kuormaan).`
    });
  }

  const unassignedCount = quality.unassignedPlannedCount || 0;
  if (unassignedCount > 0) {
    issues.push({
      code: 'unassigned_work', percent: percentOf(unassignedCount, planned.itemCount), action: QUALITY_ACTION.ASSIGN,
      text: unassignedCount === 1
        ? '1 tämän viikon asia ei ole liitetty elämänalueeseen.'
        : `${unassignedCount} tämän viikon asiaa ei ole liitetty elämänalueeseen.`
    });
  }

  if (reasons.has('no_actual')) {
    issues.push({ code: 'no_actual', percent: null, action: QUALITY_ACTION.LOG_TIME,
      text: 'Et ole vielä kirjannut toteutunutta aikaa tälle viikolle, joten havainnot perustuvat suunnitelmaan.' });
  } else if (Number.isFinite(quality.actualAssignedPercent)
      && quality.actualAssignedPercent < QUALITY_RULES.ACTUAL_ASSIGNED_WARN * 100) {
    issues.push({
      code: 'unassigned_actual', percent: quality.actualAssignedPercent, action: QUALITY_ACTION.ASSIGN_TIME,
      text: `Vain ${quality.actualAssignedPercent} % kirjatusta ajasta on yhdistetty elämänalueisiin.`
    });
  }
  if (reasons.has('partial_actual')) {
    issues.push({
      code: 'partial_actual', percent: quality.loggedSharePercent ?? null, action: QUALITY_ACTION.LOG_TIME,
      text: 'Aikaa on kirjattu vasta osalta viikosta, joten toteumaa ei vielä verrata tavoitteisiin. '
        + 'Kirjaamattomat päivät ovat tuntemattomia, eivät nollaa.'
    });
  }

  const energy = analysis.energy;
  if (energy && Number.isInteger(analysis.capacity?.energyBudgetMinutes)
      && energy.knownMinutes > 0 && energy.unratedCount > 0) {
    issues.push({
      code: 'energy_unrated', percent: energy.ratedPercent === null ? null : 100 - energy.ratedPercent,
      action: QUALITY_ACTION.RATE_ENERGY,
      text: `${100 - (energy.ratedPercent ?? 0)} % suunnitellusta ajasta on ilman kuormittavuusarviota,`
        + ' joten energiarajaa verrataan vain arvioituun osaan.'
    });
  }

  return issues;
}
