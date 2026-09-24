// Päivän Suunta: muutama merkityksellinen havainto, ei kojelautaa.
//
// Puhdas moduuli: ei DOM:ia, ei verkkoa, ei kelloa.
//
// Päivänäkymä vastaa enintään näihin:
//
//   - paljonko viikon kapasiteettia on jäljellä
//   - olenko ylikuormittamassa viikkoa
//   - jääkö jokin tärkeä alue huomiotta
//   - liittyykö tämän päivän tekeminen tärkeisiin alueisiin
//   - onko paljon luokittelematonta tekemistä
//   - mikä YKSI asia kannattaa huomata tänään
//
// Havaintoja on enintään DAILY_RULES.MAX_OBSERVATIONS. Jos niitä on
// enemmän, järjestys on DETERMINISTINEN ja jokainen näytetty kantaa
// syyn sille, miksi juuri se näytetään ("Miksi tämä?").
//
// JÄRJESTYS (pienempi = tärkeämpi):
//
//    1 vahva aikakuormitus
//    2 vahva huomiotta jääminen
//    3 vahva poikkeama tavoitteista
//    4 energiakuormitus (huomio tai vahva)
//    5 aikakuormitus (huomio)
//    6 huomiotta jääminen (huomio)
//    7 poikkeama (huomio)
//    8 luokittelematon työ
//    9 aineiston laatu (arvioimaton työ, kapasiteetti puuttuu)
//   10 tiedoksi-tason havainnot
//
// Ei ilmoituksia: tämä on näkymän sisältöä, ei push-viesti.

import { SIGNAL, SEVERITY } from './alignment.js';
import { DAILY_RULES, TIME_RULES } from './alignmentPolicy.js';
import { formatMinutes, countOf } from './lifeArea.js';

export const DAILY_RANK = Object.freeze({
  STRONG_OVERLOAD: 1,
  STRONG_NEGLECT: 2,
  STRONG_MISALIGNMENT: 3,
  ENERGY_OVERLOAD: 4,
  OVERLOAD: 5,
  NEGLECT: 6,
  MISALIGNMENT: 7,
  UNASSIGNED: 8,
  DATA_QUALITY: 9,
  INFO: 10
});

const RANK_REASONS = Object.freeze({
  1: 'Näytetään ensimmäisenä, koska suunniteltu työ ylittää kapasiteettisi selvästi.',
  2: 'Näytetään, koska sinulle tärkeä alue on jäämässä selvästi vajaaksi.',
  3: 'Näytetään, koska ajan jakauma poikkeaa toiveistasi selvästi.',
  4: 'Näytetään, koska viikon kuormittava osuus ylittää oman rajasi. Aika ja energia ovat eri asioita.',
  5: 'Näytetään, koska suunniteltu työ ylittää kapasiteettisi.',
  6: 'Näytetään, koska tärkeä alue saa vähemmän aikaa kuin halusit.',
  7: 'Näytetään, koska ajan jakauma poikkeaa toiveistasi.',
  8: 'Näytetään, koska liittämätöntä työtä on useita: ne eivät näy yhdenkään alueen luvuissa.',
  9: 'Näytetään, koska ilman tätä tietoa havainnot ovat vajaita.',
  10: 'Tiedoksi. Ei vaadi toimenpiteitä.'
});

function signalRank(signal) {
  const strong = signal.severity === SEVERITY.STRONG;
  const info = signal.severity === SEVERITY.INFO;
  switch (signal.kind) {
    case SIGNAL.OVERLOAD:
      return strong ? DAILY_RANK.STRONG_OVERLOAD : info ? DAILY_RANK.INFO : DAILY_RANK.OVERLOAD;
    case SIGNAL.NEGLECT:
      return strong ? DAILY_RANK.STRONG_NEGLECT : info ? DAILY_RANK.INFO : DAILY_RANK.NEGLECT;
    case SIGNAL.MISALIGNMENT:
      return strong ? DAILY_RANK.STRONG_MISALIGNMENT : info ? DAILY_RANK.INFO : DAILY_RANK.MISALIGNMENT;
    case SIGNAL.ENERGY_OVERLOAD:
      return info ? DAILY_RANK.INFO : DAILY_RANK.ENERGY_OVERLOAD;
    default:
      return DAILY_RANK.INFO;
  }
}

/**
 * Tämän päivän tekemisen yhteys tärkeisiin alueisiin (kuvaus, ei havainto).
 */
export function todayConnection(analysis, todayIso, areas = []) {
  if (!analysis || !todayIso) return null;
  const important = new Set((areas || [])
    .filter(area => area && area.active && area.importance >= TIME_RULES.NEGLECT_MIN_IMPORTANCE)
    .map(area => area.id));
  const today = (analysis.items || []).filter(item => item.date === todayIso);
  if (today.length === 0) return { itemCount: 0, knownMinutes: 0, importantMinutes: 0, unknownCount: 0 };
  let knownMinutes = 0;
  let importantMinutes = 0;
  let unknownCount = 0;
  let importantCount = 0;
  for (const item of today) {
    const isImportant = item.areaId && important.has(item.areaId);
    if (isImportant) importantCount += 1;
    if (item.minutes === null) { unknownCount += 1; continue; }
    knownMinutes += item.minutes;
    if (isImportant) importantMinutes += item.minutes;
  }
  return { itemCount: today.length, knownMinutes, importantMinutes, importantCount, unknownCount };
}

/**
 * Päivän havainnot.
 *
 * @param {object} analysis   analyzeWeek()-tulos tälle viikolle
 * @param {object} context
 * @param {string} context.todayIso
 * @param {Array}  context.areas
 * @param {Function} context.explain  (signal) => {title, text, why}
 * @returns {{status: string[], observations: Array, hiddenCount: number, connection: object|null}}
 */
export function dailyObservations(analysis, { todayIso = null, areas = [], explain = null } = {}) {
  if (!analysis) return { status: [], observations: [], hiddenCount: 0, connection: null };
  const candidates = [];

  for (const signal of analysis.signals || []) {
    if (signal.kind === SIGNAL.TARGET_TENSION) continue; // tavoitteiden jännite kuuluu katsaukseen
    const text = explain ? explain(signal) : { title: signal.kind, text: '' };
    candidates.push({
      code: `${signal.kind}:${signal.areaId || 'week'}`, rank: signalRank(signal),
      severity: signal.severity, kind: signal.kind, title: text.title, text: text.text,
      signal, action: signal.kind === SIGNAL.NEGLECT ? 'open_direction' : null
    });
  }

  const quality = analysis.dataQuality || {};
  if ((quality.unassignedPlannedCount || 0) >= DAILY_RULES.UNASSIGNED_MIN_ITEMS) {
    candidates.push({
      code: 'unassigned', rank: DAILY_RANK.UNASSIGNED, severity: SEVERITY.INFO, kind: 'unassigned',
      title: `${countOf(quality.unassignedPlannedCount, 'asia', 'asiaa')} ilman elämänaluetta`,
      text: `Sinulla on ${countOf(quality.unassignedPlannedCount, 'viikon asia', 'viikon asiaa')}, `
        + (quality.unassignedPlannedCount === 1 ? 'jota ei ole liitetty' : 'joita ei ole liitetty')
        + ' elämänalueeseen.',
      action: 'open_unassigned'
    });
  }
  if ((analysis.planned?.unknownCount || 0) >= DAILY_RULES.UNESTIMATED_MIN_ITEMS) {
    candidates.push({
      code: 'unestimated', rank: DAILY_RANK.DATA_QUALITY, severity: SEVERITY.INFO, kind: 'data_quality',
      title: `${countOf(analysis.planned.unknownCount, 'asia', 'asiaa')} ilman kestoarviota`,
      text: 'Arvioimatonta työtä ei lasketa kuormaan, joten viikko voi olla täydempi kuin luvut näyttävät.',
      action: 'open_estimate'
    });
  } else if (!analysis.capacity?.declared) {
    candidates.push({
      code: 'no_capacity', rank: DAILY_RANK.DATA_QUALITY, severity: SEVERITY.INFO, kind: 'data_quality',
      title: 'Viikon kapasiteetti puuttuu',
      text: 'Kerro paljonko realistisesti ehdit, niin näet mahtuuko viikko siihen.',
      action: 'open_direction'
    });
  }

  // Deterministinen järjestys: sija, sitten vakavuus, sitten koodi.
  const severityRank = { strong: 0, attention: 1, info: 2 };
  candidates.sort((a, b) => a.rank - b.rank
    || severityRank[a.severity] - severityRank[b.severity]
    || a.code.localeCompare(b.code));

  const shown = candidates.slice(0, DAILY_RULES.MAX_OBSERVATIONS).map((candidate, index) => ({
    ...candidate,
    // Ensimmäinen on "yksi asia, joka kannattaa huomata tänään".
    primary: index === 0,
    why: RANK_REASONS[candidate.rank]
  }));

  const status = [];
  if (analysis.capacity?.declared) {
    const remaining = analysis.capacity.remainingMinutes;
    status.push(remaining >= 0
      ? `Viikon kapasiteettia jäljellä ${formatMinutes(remaining)}.`
      : `Suunnitelma ylittää viikon kapasiteetin ${formatMinutes(-remaining)}.`);
  }
  if (Number.isInteger(analysis.energy?.budgetMinutes)) {
    const left = analysis.energy.remainingMinutes;
    status.push(left >= 0
      ? `Kuormittavaa tekemistä rajasi puitteissa jäljellä ${formatMinutes(left)}.`
      : `Kuormittavaa tekemistä on ${formatMinutes(-left)} yli oman rajasi.`);
  }

  const connection = todayConnection(analysis, todayIso, areas);
  if (connection && connection.itemCount > 0 && connection.knownMinutes > 0) {
    status.push(connection.importantMinutes > 0
      ? `Tänään suunnitellusta ajasta (${formatMinutes(connection.knownMinutes)}) `
        + `${formatMinutes(connection.importantMinutes)} liittyy sinulle hyvin tärkeisiin alueisiin.`
      : 'Tämän päivän suunnitelma ei liity yhteenkään alueeseen, jonka merkitsit hyvin tärkeäksi.');
  }

  return { status, observations: shown, hiddenCount: Math.max(0, candidates.length - shown.length), connection };
}
