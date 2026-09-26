// Viikkojen vertailu ja kehitys: vain havaittavat erot.
//
// Puhdas moduuli: ei DOM:ia, ei verkkoa, ei kelloa.
//
// =====================================================================
// SOVELLUS ESITTÄÄ NÄYTÖN, KÄYTTÄJÄ TULKITSEE
// =====================================================================
//
// Hyvä:   "Työhön kirjattu aika kasvoi kolmen viikon aikana (5 h -> 9 h)."
// Huono:  "Elämäsi on menossa väärään suuntaan."
//
// - Kahden viikon vertailu kertoo ERON ("12 h -> 15 h"), ei suuntaa.
// - Muutoksesta ("kasvoi", "väheni") kerrotaan vasta, kun peräkkäisiä
//   viikkoja on vähintään TREND_RULES.MIN_WEEKS ja muutos on samaan
//   suuntaan joka viikko ja riittävän suuri. Yhdestä viikosta ei tehdä
//   trendiä.
// - Ei elämänpisteitä, ei tulostaulua, ei arvosanaa.
//
// Viikon yhteenveto tulee joko elävästä analyysista tai tallennetusta
// tilannekuvasta (historia). Tilannekuvaa ei lasketa uudelleen: se on
// historiaa, ja sen sääntöversio näytetään.
//
// ARVIOIDEN KATTAVUUS (sääntöversio 3): suunniteltu aika on vain
// arvioitujen asioiden summa. Jos kattavuus vaihtelee viikosta toiseen,
// "suunniteltu kasvoi" voi tarkoittaa vain, että arvioita lisättiin.
// Siksi vertailu kertoo arvioimattomien määrän, ja kehitystä ei
// sanoiteta, jos jollakin viikolla kattavuus jäi alle rajan.

import { SIGNAL, SEVERITY } from './alignment.js';
import { TREND_RULES, TIME_RULES, QUALITY_RULES } from './alignmentPolicy.js';
import { policyVersionOf } from './alignmentPolicy.js';
import { formatMinutes } from './lifeArea.js';

/** Ensimmäinen Suunta-viikko: edellinen viikko on ajalta ennen Suuntaa. */
export const FIRST_WEEK_NOTE = 'Ensimmäinen Suunta-viikko — vertailu alkaa ensi viikolla.';

function numberOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

/**
 * Yhtenäinen viikkoyhteenveto analyysista TAI tilannekuvasta.
 */
export function weekSummary(source, { origin = null } = {}) {
  if (!source) return null;
  const isSnapshot = origin === 'snapshot' || (source.version !== undefined && !source.items);
  const signals = (source.signals || []).map(signal => ({
    kind: signal.kind, severity: signal.severity, areaId: signal.areaId || null
  }));
  return {
    weekStart: source.weekStart,
    origin: isSnapshot ? 'snapshot' : 'live',
    policyVersion: isSnapshot ? policyVersionOf(source) : (source.policyVersion || null),
    capacityMinutes: numberOrNull(source.capacity?.availableMinutes),
    energyBudgetMinutes: numberOrNull(source.capacity?.energyBudgetMinutes),
    plannedMinutes: numberOrNull(source.planned?.knownMinutes),
    unknownCount: numberOrNull(source.planned?.unknownCount),
    // Tilannekuvat ovat tallentaneet kattavuuden aineiston laadussa alusta asti.
    estimateCoveragePercent: numberOrNull(source.dataQuality?.estimateCoveragePercent),
    actualMinutes: numberOrNull(source.actual?.minutes),
    actualEntries: numberOrNull(source.actual?.entryCount),
    actualDays: numberOrNull(source.actual?.daysWithEntries),
    trackingLevel: source.dataQuality?.trackingLevel || null,
    heavyMinutes: numberOrNull(source.energy?.heavyMinutes),
    quality: source.dataQuality?.level || null,
    timeOverloaded: signals.some(s => s.kind === SIGNAL.OVERLOAD && s.severity !== SEVERITY.INFO),
    energyOverloaded: signals.some(s => s.kind === SIGNAL.ENERGY_OVERLOAD && s.severity !== SEVERITY.INFO),
    signals,
    areas: (source.areas || []).map(area => ({
      id: area.id, name: area.name, active: area.active,
      targetMinutes: numberOrNull(area.targetMinutes),
      desiredPercent: numberOrNull(area.desiredPercent),
      plannedMinutes: numberOrNull(area.plannedMinutes),
      actualMinutes: numberOrNull(area.actualMinutes),
      actualPercent: numberOrNull(area.actualPercent)
    }))
  };
}

function hasActual(summary) {
  return summary && summary.actualEntries !== 0 && Number.isFinite(summary.actualMinutes) && summary.actualMinutes > 0;
}

function diffLine(label, before, after) {
  if (!Number.isFinite(before) || !Number.isFinite(after)) return null;
  const delta = after - before;
  const sign = delta > 0 ? '+' : delta < 0 ? '−' : '±';
  return {
    label, before, after, delta,
    text: `${label}: ${formatMinutes(before)} → ${formatMinutes(after)} (${sign}${formatMinutes(Math.abs(delta))})`
  };
}

const QUALITY_LABELS = Object.freeze({ good: 'kattava', partial: 'osittainen', weak: 'vajaa', none: 'ei aineistoa' });
const KIND_LABELS = Object.freeze({
  overload: 'kuormitus', neglect: 'huomiotta jääminen', misalignment: 'poikkeama',
  energy_overload: 'energiakuormitus', target_tension: 'tavoitteiden jännite'
});

/** Kattavuus alle rajan? Tuntematon kattavuus (ei asioita) ei ole vajaa. */
function coverageBelow(summary, limit) {
  return Number.isFinite(summary.estimateCoveragePercent) && summary.estimateCoveragePercent < Math.round(limit * 100);
}

/**
 * Tämä viikko vs. edellinen. Vain erot, ei johtopäätöksiä.
 *
 * @param {object|null} current
 * @param {object|null} previous
 * @param {{unavailableNote?: string}} [options] syy, kun vertailua ei tehdä
 *   (esim. FIRST_WEEK_NOTE: edellinen viikko oli ennen Suuntaa)
 * @returns {{available: boolean, lines: Array<{label, text}>, areas: Array, notes: string[]}}
 */
export function compareWeeks(current, previous, { unavailableNote = null } = {}) {
  if (!current || !previous) {
    return { available: false, lines: [], areas: [],
      notes: [unavailableNote || 'Edellisestä viikosta ei ole vertailtavaa aineistoa.'] };
  }
  // Suunniteltu aika vain arvioiduista asioista: jos kummallakin viikolla
  // alle puolet on arvioitu, erotus kertoisi arvioinnista eikä viikosta.
  const plannedComparable = !coverageBelow(previous, TIME_RULES.PLAN_MIN_ESTIMATE_COVERAGE)
    && !coverageBelow(current, TIME_RULES.PLAN_MIN_ESTIMATE_COVERAGE);
  let planned = plannedComparable ? diffLine('Suunniteltu', previous.plannedMinutes, current.plannedMinutes) : null;
  const unknownBefore = previous.unknownCount || 0;
  const unknownAfter = current.unknownCount || 0;
  if (planned && (unknownBefore > 0 || unknownAfter > 0)) {
    planned = { ...planned, text: `${planned.text} (arvioimattomia ${unknownBefore} → ${unknownAfter})` };
  }
  const lines = [
    diffLine('Kapasiteetti', previous.capacityMinutes, current.capacityMinutes),
    planned,
    hasActual(previous) && hasActual(current)
      ? diffLine('Kirjattu toteuma', previous.actualMinutes, current.actualMinutes) : null,
    diffLine('Kuormittavaa', previous.heavyMinutes, current.heavyMinutes)
  ].filter(Boolean);

  const notes = [];
  if (!plannedComparable) {
    notes.push('Suunniteltua aikaa ei verrata, koska toisella viikolla alle puolet asioista on arvioitu '
      + `(arvioitu ${previous.estimateCoveragePercent ?? '–'} % → ${current.estimateCoveragePercent ?? '–'} %).`);
  }
  if (!hasActual(previous) || !hasActual(current)) {
    notes.push('Toteumaa ei verrata, koska toisella viikolla ei ole kirjattua aikaa.');
  }
  if (previous.quality && current.quality && previous.quality !== current.quality) {
    notes.push(`Aineiston kattavuus: ${QUALITY_LABELS[previous.quality] || previous.quality} → `
      + `${QUALITY_LABELS[current.quality] || current.quality}.`);
  }
  const countKinds = summary => summary.signals.filter(s => s.severity !== SEVERITY.INFO)
    .reduce((map, s) => map.set(s.kind, (map.get(s.kind) || 0) + 1), new Map());
  const before = countKinds(previous);
  const after = countKinds(current);
  for (const kind of Object.keys(KIND_LABELS)) {
    const a = before.get(kind) || 0;
    const b = after.get(kind) || 0;
    if (a !== b) notes.push(`Havaintoja (${KIND_LABELS[kind]}): ${a} → ${b}.`);
  }
  if (previous.policyVersion && current.policyVersion && previous.policyVersion !== current.policyVersion) {
    notes.push(`Viikot on arvioitu eri sääntöversioilla (${previous.policyVersion} ja ${current.policyVersion}).`);
  }

  // Alueet: kirjattu aika, jos molemmilla viikoilla on toteumaa; muuten
  // suunniteltu — mutta ei, jos suunniteltua ei voi verrata (kattavuus).
  const basis = hasActual(previous) && hasActual(current) ? 'actual' : 'planned';
  const previousById = new Map(previous.areas.map(area => [area.id, area]));
  const comparableAreas = basis === 'actual' || plannedComparable ? current.areas : [];
  const areas = comparableAreas.filter(area => area.active !== false).map(area => {
    const old = previousById.get(area.id);
    const key = basis === 'actual' ? 'actualMinutes' : 'plannedMinutes';
    return {
      id: area.id, name: area.name, basis,
      before: old ? old[key] : null, after: area[key],
      delta: old && Number.isFinite(old[key]) && Number.isFinite(area[key]) ? area[key] - old[key] : null
    };
  });

  return { available: true, lines, areas, notes, basis };
}

// ---------------------------------------------------------------- kehitys

function monotonic(values, direction) {
  for (let i = 1; i < values.length; i++) {
    if (direction > 0 ? !(values[i] > values[i - 1]) : !(values[i] < values[i - 1])) return false;
  }
  return true;
}

function trendOf(values, minChange) {
  if (values.length < TREND_RULES.MIN_WEEKS || values.some(value => !Number.isFinite(value))) return 0;
  const tail = values.slice(-TREND_RULES.MIN_WEEKS);
  const change = tail[tail.length - 1] - tail[0];
  if (Math.abs(change) < minChange) return 0;
  const direction = Math.sign(change);
  return monotonic(tail, direction) ? direction : 0;
}

const WEEK_WORDS = Object.freeze({ 2: 'kahden', 3: 'kolmen', 4: 'neljän', 5: 'viiden', 6: 'kuuden', 7: 'seitsemän', 8: 'kahdeksan' });

/**
 * Kehitys viikoittaisista yhteenvedoista (vanhin ensin).
 *
 * @param {Array} summaries weekSummary()-tulokset, peräkkäiset viikot
 * @returns {{weeks: number, enough: boolean, rows: Array, statements: string[]}}
 */
export function alignmentTrends(summaries = []) {
  const series = (summaries || []).filter(Boolean)
    .sort((a, b) => String(a.weekStart).localeCompare(String(b.weekStart)));
  const weeks = series.length;
  const enough = weeks >= TREND_RULES.MIN_WEEKS;
  const rows = series.map(week => ({
    weekStart: week.weekStart,
    origin: week.origin,
    policyVersion: week.policyVersion,
    capacityMinutes: week.capacityMinutes,
    plannedMinutes: week.plannedMinutes,
    actualMinutes: hasActual(week) ? week.actualMinutes : null,
    heavyMinutes: week.heavyMinutes,
    timeOverloaded: week.timeOverloaded,
    energyOverloaded: week.energyOverloaded,
    quality: week.quality
  }));

  const statements = [];
  if (!enough) {
    statements.push(`Kehityksestä kerrotaan, kun aineistoa on vähintään ${TREND_RULES.MIN_WEEKS} viikolta.`);
    return { weeks, enough, rows, statements };
  }

  const span = WEEK_WORDS[TREND_RULES.MIN_WEEKS] || String(TREND_RULES.MIN_WEEKS);
  const describe = (label, values) => {
    const direction = trendOf(values, TREND_RULES.MIN_CHANGE_MINUTES);
    if (direction === 0) return;
    const tail = values.slice(-TREND_RULES.MIN_WEEKS);
    statements.push(`${label} ${direction > 0 ? 'kasvoi' : 'väheni'} ${span} viikon aikana `
      + `(${formatMinutes(tail[0])} → ${formatMinutes(tail[tail.length - 1])}).`);
  };

  // Suunniteltu aika kasvaa myös pelkästä arvioinnista: kehitys vain, kun
  // jokaisella tarkasteltavalla viikolla riittävä osa asioista on arvioitu.
  const plannedSeries = series.map(week => week.plannedMinutes);
  const plannedTail = series.slice(-TREND_RULES.MIN_WEEKS);
  if (plannedTail.every(week => !coverageBelow(week, QUALITY_RULES.ESTIMATE_COVERAGE_WARN))) {
    describe('Suunniteltu aika', plannedSeries);
  } else if (trendOf(plannedSeries, TREND_RULES.MIN_CHANGE_MINUTES) !== 0) {
    statements.push('Suunnitellun ajan kehitystä ei sanoiteta: osalla viikoista alle '
      + `${Math.round(QUALITY_RULES.ESTIMATE_COVERAGE_WARN * 100)} % asioista oli arvioitu, `
      + 'joten muutos voi johtua arvioinnista.');
  }
  const actualSeries = series.map(week => (hasActual(week) ? week.actualMinutes : null));
  describe('Kirjattu aika', actualSeries);

  // Alueet: kirjattu aika alueittain, vain jos jokaisella viikolla on toteumaa.
  const tail = series.slice(-TREND_RULES.MIN_WEEKS);
  const last = series[series.length - 1];
  if (tail.every(hasActual)) {
    for (const area of last.areas.filter(a => a.active !== false)) {
      const values = tail.map(week => week.areas.find(a => a.id === area.id)?.actualMinutes ?? null);
      describe(`${area.name}: kirjattu aika`, values);
    }
  }

  const withCapacity = series.filter(week => Number.isFinite(week.capacityMinutes));
  if (withCapacity.length >= TREND_RULES.MIN_WEEKS) {
    const over = withCapacity.filter(week => week.timeOverloaded).length;
    statements.push(`Suunnitelma ylitti kapasiteetin ${over} viikolla ${withCapacity.length}:stä.`);
  }
  const withBudget = series.filter(week => Number.isFinite(week.energyBudgetMinutes));
  if (withBudget.length >= TREND_RULES.MIN_WEEKS) {
    const over = withBudget.filter(week => week.energyOverloaded).length;
    statements.push(`Kuormittava osuus ylitti oman rajasi ${over} viikolla ${withBudget.length}:stä.`);
  }

  // Toive vs. toteuma viimeisimmällä viikolla: luvut, ei tulkintaa.
  if (hasActual(last)) {
    for (const area of last.areas.filter(a => a.active !== false && Number.isFinite(a.desiredPercent))) {
      if (!Number.isFinite(area.actualPercent)) continue;
      const gap = area.actualPercent - area.desiredPercent;
      if (Math.abs(gap) >= TREND_RULES.MIN_CHANGE_POINTS) {
        statements.push(`${area.name}: toive ${area.desiredPercent} %, kirjattu ${area.actualPercent} % viimeisimmällä viikolla.`);
      }
    }
  }

  if (statements.length === 0) statements.push('Viikkojen välillä ei ole selvää samansuuntaista muutosta.');
  return { weeks, enough, rows, statements };
}
