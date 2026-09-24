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

import { QUALITY_RULES } from './alignmentPolicy.js';

export const QUALITY_ACTION = Object.freeze({
  ADD_AREAS: 'add_areas',
  SET_TARGETS: 'set_targets',
  SET_CAPACITY: 'set_capacity',
  ESTIMATE: 'estimate',
  ASSIGN: 'assign',
  LOG_TIME: 'log_time',
  RATE_ENERGY: 'rate_energy'
});

export const QUALITY_ACTION_LABELS = Object.freeze({
  add_areas: 'Lisää elämänalue',
  set_targets: 'Aseta aikatavoite',
  set_capacity: 'Aseta kapasiteetti',
  estimate: 'Arvioi tehtäviä',
  assign: 'Kohdista luokittelemattomat',
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
  if (reasons.has('no_targets')) {
    issues.push({ code: 'no_targets', percent: null, action: QUALITY_ACTION.SET_TARGETS,
      text: 'Alueilla ei ole aikatavoitteita, joten ajan jakaumaa ei voi verrata toiveisiisi.' });
  }
  if (reasons.has('no_capacity')) {
    issues.push({ code: 'no_capacity', percent: null, action: QUALITY_ACTION.SET_CAPACITY,
      text: 'Tälle viikolle ei ole kapasiteettia, joten kuormitusta ei voi arvioida.' });
  }

  const unestimatedPercent = percentOf(planned.unknownCount, planned.itemCount);
  if (planned.unknownCount > 0) {
    issues.push({
      code: 'unestimated_work', percent: unestimatedPercent, action: QUALITY_ACTION.ESTIMATE,
      text: `${unestimatedPercent} % tämän viikon suunnitelluista asioista ei sisällä aika-arviota`
        + ` (${planned.unknownCount} kpl). Niitä ei lasketa kuormaan.`
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
      code: 'unassigned_actual', percent: quality.actualAssignedPercent, action: QUALITY_ACTION.ASSIGN,
      text: `Vain ${quality.actualAssignedPercent} % kirjatusta ajasta on yhdistetty elämänalueisiin.`
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
