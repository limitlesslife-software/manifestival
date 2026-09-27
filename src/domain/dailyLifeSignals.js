// Arjen havainnot viikolta: unirytmi, aika unelle, hyvinvoinnin
// kuormitus ja harkinnanvarainen rahankäyttö.
//
// PUHDAS MODUULI: ei kelloa, ei DOM:ia, ei verkkoa, EI TEKOÄLYÄ.
// Viikko ja tämä päivä annetaan parametreina.
//
// =====================================================================
// EI KYTKETTY SUUNTAAN
// =====================================================================
//
// Nämä havainnot EIVÄT ole analyzeWeek-signaaleja eivätkä kulje Suunnan
// katsaukseen, tilannekuvaan tai tekoälyn kontekstiin. Muoto on
// yhteensopiva ({kind, severity, areaId, basis, rule, metrics}), jotta
// kytkentä onnistuu myöhemmin — mutta jo lajin nimi (esim.
// sleep_rhythm_drift) on terveystietoa, joten kytkentä vaatii oman
// suostumuksen, lokisuojauksen ja tekoälyrajauksen (ks.
// docs/LIFE-ALIGNMENT.md ja alignment-kartoitus, kohta F).
//
// =====================================================================
// TUNTEMATON EI OLE "EI HAVAINTOA"
// =====================================================================
//
// Jokainen tarkistus palauttaa arvion, jonka tila on yksi neljästä:
//
//   signal              havainto syntyi
//   clear               tietoa on riittävästi, eikä havaintoa synny
//   insufficient_data   kirjauksia liian vähän (alle vähimmäismäärän tai
//                       kattavuuden) — EI tarkoita, että kaikki on hyvin
//   no_reference        käyttäjä ei ole ilmoittanut omaa vertailulukua
//                       (unitavoite, rytmi, kuukausiraja)
//
// VIITE ON AINA KÄYTTÄJÄN OMA LUKU. Kynnysarvot ovat
// dailyLifeSignalsPolicy.js:ssä, ja selitysten luvut rakennetaan niistä.
// Vakavuus on "Tiedoksi" tai "Huomio" — ei koskaan "Vahva", koska
// omat merkinnät ovat harvoja ja kertovat vain osan.

import {
  SLEEP_SIGNAL_RULES, WELLBEING_SIGNAL_RULES, WELLBEING_RULES
} from './dailyLifeSignalsPolicy.js';
import { SLEEP_KIND, MAX_WEEKEND_SHIFT_MINUTES } from './dailyLife.js';
import { addDaysIso, weekdayOfIso } from './fiTemporal.js';
import {
  DEFAULT_TIME_ZONE, isCalendarDate, clockMinutes, elapsedMinutesBetween, parseTimestampMs
} from './zonedClock.js';
import { strainCounts } from './wellbeingInsights.js';
import { discretionaryStatus, DISCRETIONARY_STATE } from './moneyAlignment.js';
import { formatDuration } from '../lib/format.js';

export const DAILY_LIFE_SIGNAL = Object.freeze({
  SLEEP_RHYTHM_DRIFT: 'sleep_rhythm_drift',
  SLEEP_OPPORTUNITY_LOW: 'sleep_opportunity_low',
  WELLBEING_STRAIN: 'wellbeing_strain',
  MONEY_OVERLOAD: 'money_overload'
});

export const DAILY_LIFE_SIGNALS = Object.freeze(Object.values(DAILY_LIFE_SIGNAL));

/** Samat arvot kuin alignment.SEVERITY:ssä (testi varmistaa). "Vahvaa" ei käytetä. */
export const DAILY_LIFE_SEVERITY = Object.freeze({ INFO: 'info', ATTENTION: 'attention' });

export const EVALUATION_STATUS = Object.freeze({
  SIGNAL: 'signal',
  CLEAR: 'clear',
  INSUFFICIENT_DATA: 'insufficient_data',
  NO_REFERENCE: 'no_reference'
});

export const DAILY_LIFE_RULE = Object.freeze({
  SLEEP_DRIFT: 'sleep.drift_from_own_rhythm',
  SLEEP_SHORT: 'sleep.opportunity_below_own_target',
  WELLBEING_STRAIN: 'wellbeing.high_load_low_energy_or_control',
  MONEY_OVER: 'money.discretionary_over_own_limit',
  MONEY_NEAR: 'money.discretionary_near_own_limit'
});

export const DAILY_LIFE_BASIS = 'reported';

const KIND_ORDER = Object.freeze({
  sleep_opportunity_low: 0, sleep_rhythm_drift: 1, wellbeing_strain: 2, money_overload: 3
});
const SEVERITY_ORDER = Object.freeze({ attention: 0, info: 1 });
const MAX_ID_LENGTH = 200;

/** Hajotettava olio: null, luku tai merkkijono ei kaada funktiota. */
const argsOf = value => (value !== null && typeof value === 'object' ? value : {});

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function durationText(minutes) {
  return formatDuration(Math.abs(minutes)) || '0 min';
}

function percent(part, whole) {
  return whole > 0 ? Math.round((part / whole) * 100) : 0;
}

// ------------------------------------------------------------ ikkuna

/**
 * Tarkasteltava jakso: viikon alusta viikon loppuun tai tähän päivään,
 * kumpi on aiempi. Ilman tätä päivää viikko katsotaan päättyneeksi.
 */
function windowOf(weekStart, todayIso) {
  if (!isCalendarDate(weekStart)) return null;
  const weekEnd = addDaysIso(weekStart, 6);
  let end = weekEnd;
  if (isCalendarDate(todayIso) && todayIso < weekEnd) end = todayIso;
  const days = end < weekStart ? 0 : dayDiff(weekStart, end) + 1;
  return { weekStart, weekEnd, end, days };
}

function dayDiff(fromIso, toIso) {
  let count = 0;
  let cursor = fromIso;
  // Enintään 7 askelta: ikkuna on aina yhden viikon sisällä.
  while (cursor < toIso && count < 8) {
    cursor = addDaysIso(cursor, 1);
    count += 1;
  }
  return count;
}

function evaluation(kind, status, { reason = null, signal = null, metrics = {} } = {}) {
  return Object.freeze({ kind, status, reason, signal, metrics: Object.freeze({ ...metrics }) });
}

function makeSignal(kind, severity, rule, metrics, explanation) {
  return Object.freeze({
    kind,
    severity,
    areaId: null,
    basis: DAILY_LIFE_BASIS,
    rule,
    metrics: Object.freeze({ ...metrics }),
    explanation
  });
}

// ------------------------------------------------------------ uni

function idOf(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' || trimmed.length > MAX_ID_LENGTH ? null : trimmed;
}

/** Yön unikirjaukset herätyspäivän mukaan; kaksoiskirjauksesta myöhemmin päivitetty. */
function nightsIn(sleepLogs, fromIso, toIso) {
  const byDate = new Map();
  if (!Array.isArray(sleepLogs)) return byDate;
  for (const log of sleepLogs) {
    if (!isObject(log) || !isCalendarDate(log.wakeDate)) continue;
    if (log.wakeDate < fromIso || log.wakeDate > toIso) continue;
    const row = {
      id: idOf(log.id),
      wakeDate: log.wakeDate,
      updatedMs: parseTimestampMs(log.updatedAt),
      kind: log.kind === SLEEP_KIND.MEASURED ? SLEEP_KIND.MEASURED : SLEEP_KIND.OPPORTUNITY,
      plannedBedtime: clockMinutes(log.plannedBedtime),
      actualBedtime: clockMinutes(log.actualBedtime),
      plannedWake: clockMinutes(log.plannedWake),
      actualWake: clockMinutes(log.actualWake)
    };
    const existing = byDate.get(row.wakeDate);
    byDate.set(row.wakeDate, existing ? preferredLog(existing, row) : row);
  }
  return byDate;
}

function preferredLog(a, b) {
  const aMs = a.updatedMs ?? -Infinity;
  const bMs = b.updatedMs ?? -Infinity;
  if (aMs !== bMs) return aMs > bMs ? a : b;
  if (a.id !== b.id) {
    if (a.id === null) return b;
    if (b.id === null) return a;
    return a.id < b.id ? a : b;
  }
  return JSON.stringify(a) <= JSON.stringify(b) ? a : b;
}

/** Etumerkillinen ero seinäkellossa, -720..719 min (keskiyön yli oikein). */
function clockDelta(actual, reference) {
  return ((actual - reference + 720) % 1440 + 1440) % 1440 - 720;
}

function declaredOf(sleepDeclared) {
  const d = argsOf(sleepDeclared);
  const hours = typeof d.targetHours === 'number' && Number.isFinite(d.targetHours) ? d.targetHours : null;
  const targetMinutes = hours !== null && hours > 0 && hours <= 24 ? Math.round(hours * 60) : null;
  const shift = Number.isInteger(d.weekendShiftMinutes) && d.weekendShiftMinutes > 0
    && d.weekendShiftMinutes <= MAX_WEEKEND_SHIFT_MINUTES
    ? d.weekendShiftMinutes
    : 0;
  return {
    targetMinutes,
    bedtime: clockMinutes(d.bedtimeTarget),
    wake: clockMinutes(d.wakeTime),
    weekendShiftMinutes: shift
  };
}

/**
 * Unirytmi: poikkesiko nukkumaanmeno tai herääminen omasta rytmistä?
 *
 * Viite yölle: sovelluksen sille yölle suunnittelema aika (plannedBedtime /
 * plannedWake), muuten käyttäjän ilmoittama rytmi (sleepDeclared.bedtimeTarget
 * / wakeTime). Viikonloppuna ilmoitetusta rytmistä sallitaan myöhempään
 * `weekendShiftMinutes` (suunniteltu aika sisältää sen jo valmiiksi).
 */
export function sleepRhythmDrift(input) {
  const { weekStart, todayIso, sleepLogs, sleepDeclared } = argsOf(input);
  const kind = DAILY_LIFE_SIGNAL.SLEEP_RHYTHM_DRIFT;
  const span = windowOf(weekStart, todayIso);
  if (!span) return evaluation(kind, EVALUATION_STATUS.INSUFFICIENT_DATA, { reason: 'no_week' });
  const declared = declaredOf(sleepDeclared);
  const nights = nightsIn(sleepLogs, span.weekStart, span.end);

  let reported = 0;
  let withActuals = 0;
  let drifted = 0;
  let absSum = 0;
  let later = 0;
  let earlier = 0;
  for (const night of nights.values()) {
    if (night.actualBedtime === null && night.actualWake === null) continue;
    withActuals += 1;
    const weekend = weekdayOfIso(night.wakeDate) >= 6;
    const deltas = [];
    const consider = (actual, planned, fallback) => {
      if (actual === null) return;
      if (planned !== null) {
        deltas.push(clockDelta(actual, planned));
      } else if (fallback !== null) {
        let delta = clockDelta(actual, fallback);
        if (weekend && delta > 0) delta = Math.max(0, delta - declared.weekendShiftMinutes);
        deltas.push(delta);
      }
    };
    consider(night.actualBedtime, night.plannedBedtime, declared.bedtime);
    consider(night.actualWake, night.plannedWake, declared.wake);
    if (deltas.length === 0) continue;
    reported += 1;
    const biggest = deltas.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a));
    absSum += Math.abs(biggest);
    if (Math.abs(biggest) >= SLEEP_SIGNAL_RULES.DRIFT_MINUTES) {
      drifted += 1;
      if (biggest > 0) later += 1;
      else earlier += 1;
    }
  }

  const metrics = {
    windowNights: span.days,
    reportedNights: reported,
    coveragePercent: percent(reported, span.days),
    driftNights: drifted,
    meanAbsDeviationMinutes: reported > 0 ? Math.round(absSum / reported) : null
  };
  if (reported === 0 && withActuals > 0) {
    return evaluation(kind, EVALUATION_STATUS.NO_REFERENCE, { reason: 'no_rhythm', metrics });
  }
  if (reported < SLEEP_SIGNAL_RULES.MIN_REPORTED_NIGHTS || reported < span.days * SLEEP_SIGNAL_RULES.MIN_COVERAGE) {
    return evaluation(kind, EVALUATION_STATUS.INSUFFICIENT_DATA, { reason: 'few_nights', metrics });
  }
  if (drifted < SLEEP_SIGNAL_RULES.DRIFT_MIN_NIGHTS) return evaluation(kind, EVALUATION_STATUS.CLEAR, { metrics });

  const direction = later > 0 && earlier === 0 ? 'later' : earlier > 0 && later === 0 ? 'earlier' : 'mixed';
  const severity = drifted >= SLEEP_SIGNAL_RULES.DRIFT_ATTENTION_NIGHTS
    && reported >= SLEEP_SIGNAL_RULES.ATTENTION_MIN_REPORTED_NIGHTS
    ? DAILY_LIFE_SEVERITY.ATTENTION
    : DAILY_LIFE_SEVERITY.INFO;
  let explanation = `Nukkumaanmeno tai herääminen poikkesi omasta rytmistäsi vähintään `
    + `${durationText(SLEEP_SIGNAL_RULES.DRIFT_MINUTES)} ${drifted} yönä ${reported} kirjatusta.`;
  if (direction === 'later') explanation += ' Poikkeamat olivat myöhempään.';
  else if (direction === 'earlier') explanation += ' Poikkeamat olivat aiempaan.';
  const signal = makeSignal(kind, severity, DAILY_LIFE_RULE.SLEEP_DRIFT, { ...metrics, direction }, explanation);
  return evaluation(kind, EVALUATION_STATUS.SIGNAL, { signal, metrics: signal.metrics });
}

/**
 * Aika unelle suhteessa omaan unitavoitteeseen (sleepDeclared.targetHours).
 *
 * Kesto lasketaan todellisena aikana annetussa vyöhykkeessä: kevään
 * vaihtoyö 23.00–07.00 on 7 h, syksyn 9 h. Sovellus ei mittaa unta; jos
 * kirjaus on laitteen mittaama (kind 'measured'), se kerrotaan.
 */
export function sleepOpportunityLow(input) {
  const { weekStart, todayIso, sleepLogs, sleepDeclared, timeZone = DEFAULT_TIME_ZONE } = argsOf(input);
  const kind = DAILY_LIFE_SIGNAL.SLEEP_OPPORTUNITY_LOW;
  const span = windowOf(weekStart, todayIso);
  if (!span) return evaluation(kind, EVALUATION_STATUS.INSUFFICIENT_DATA, { reason: 'no_week' });
  const declared = declaredOf(sleepDeclared);
  if (declared.targetMinutes === null) {
    return evaluation(kind, EVALUATION_STATUS.NO_REFERENCE, { reason: 'no_sleep_target' });
  }
  const nights = nightsIn(sleepLogs, span.weekStart, span.end);

  let reported = 0;
  let short = 0;
  let sum = 0;
  let measured = 0;
  for (const night of nights.values()) {
    if (night.actualBedtime === null || night.actualWake === null) continue;
    if (night.actualBedtime === night.actualWake) continue;
    const bedDate = night.actualBedtime > night.actualWake ? addDaysIso(night.wakeDate, -1) : night.wakeDate;
    const minutes = elapsedMinutesBetween(bedDate, night.actualBedtime, night.wakeDate, night.actualWake, timeZone);
    if (minutes === null || minutes <= 0 || minutes > 1440) continue;
    reported += 1;
    sum += minutes;
    if (night.kind === SLEEP_KIND.MEASURED) measured += 1;
    if (minutes <= declared.targetMinutes - SLEEP_SIGNAL_RULES.SHORTFALL_MINUTES) short += 1;
  }

  const meanMinutes = reported > 0 ? Math.round(sum / reported) : null;
  const meanShortfall = meanMinutes === null ? null : Math.max(0, declared.targetMinutes - meanMinutes);
  const metrics = {
    windowNights: span.days,
    reportedNights: reported,
    coveragePercent: percent(reported, span.days),
    shortNights: short,
    meanMinutes,
    targetMinutes: declared.targetMinutes,
    meanShortfallMinutes: meanShortfall,
    measuredNights: measured
  };
  if (reported < SLEEP_SIGNAL_RULES.MIN_REPORTED_NIGHTS || reported < span.days * SLEEP_SIGNAL_RULES.MIN_COVERAGE) {
    return evaluation(kind, EVALUATION_STATUS.INSUFFICIENT_DATA, { reason: 'few_nights', metrics });
  }
  if (short < SLEEP_SIGNAL_RULES.SHORT_MIN_NIGHTS) return evaluation(kind, EVALUATION_STATUS.CLEAR, { metrics });

  const severity = short >= SLEEP_SIGNAL_RULES.SHORT_ATTENTION_NIGHTS
    && meanShortfall >= SLEEP_SIGNAL_RULES.SHORT_ATTENTION_MEAN_MINUTES
    && reported >= SLEEP_SIGNAL_RULES.ATTENTION_MIN_REPORTED_NIGHTS
    ? DAILY_LIFE_SEVERITY.ATTENTION
    : DAILY_LIFE_SEVERITY.INFO;
  const subject = measured === reported ? 'Mitattua unta' : measured === 0 ? 'Aikaa unelle' : 'Aikaa unelle tai mitattua unta';
  const explanation = `${subject} oli keskimäärin ${durationText(meanMinutes)}, kun oma tavoitteesi on `
    + `${durationText(declared.targetMinutes)}. Vähintään ${durationText(SLEEP_SIGNAL_RULES.SHORTFALL_MINUTES)} `
    + `tavoitetta lyhyempiä öitä oli ${short} / ${reported} kirjatusta.`;
  const signal = makeSignal(kind, severity, DAILY_LIFE_RULE.SLEEP_SHORT, metrics, explanation);
  return evaluation(kind, EVALUATION_STATUS.SIGNAL, { signal, metrics: signal.metrics });
}

// ------------------------------------------------------------ hyvinvointi

/**
 * Kuormitus: korkea kuormitus yhdessä matalan energian tai vähäisen
 * hallinnan tunteen kanssa (omat merkinnät, WELLBEING_RULES).
 */
export function wellbeingStrain(input) {
  const { weekStart, todayIso, wellbeingEntries, wellbeingCheckins } = argsOf(input);
  const kind = DAILY_LIFE_SIGNAL.WELLBEING_STRAIN;
  const span = windowOf(weekStart, todayIso);
  if (!span || span.days === 0) return evaluation(kind, EVALUATION_STATUS.INSUFFICIENT_DATA, { reason: 'no_week' });
  const counts = strainCounts({
    entries: wellbeingEntries, checkins: wellbeingCheckins, fromIso: span.weekStart, toIso: span.end
  });
  const metrics = {
    windowDays: span.days,
    reportedDays: counts.reportedDays,
    coveragePercent: percent(counts.reportedDays, span.days),
    strainedDays: counts.strainedDays,
    lowEnergyDays: counts.lowEnergyDays,
    lowControlDays: counts.lowControlDays
  };
  if (counts.reportedDays < WELLBEING_SIGNAL_RULES.MIN_REPORTED_DAYS
    || counts.reportedDays < span.days * WELLBEING_SIGNAL_RULES.MIN_COVERAGE) {
    return evaluation(kind, EVALUATION_STATUS.INSUFFICIENT_DATA, { reason: 'few_days', metrics });
  }
  if (counts.strainedDays < WELLBEING_SIGNAL_RULES.STRAIN_MIN_DAYS) return evaluation(kind, EVALUATION_STATUS.CLEAR, { metrics });

  const severity = counts.strainedDays >= WELLBEING_SIGNAL_RULES.ATTENTION_MIN_DAYS
    && counts.reportedDays >= WELLBEING_SIGNAL_RULES.ATTENTION_MIN_REPORTED_DAYS
    ? DAILY_LIFE_SEVERITY.ATTENTION
    : DAILY_LIFE_SEVERITY.INFO;
  const explanation = `Kuormitus oli korkea (vähintään ${WELLBEING_RULES.HIGH_LOAD_MIN}/5) ja energia `
    + `(enintään ${WELLBEING_RULES.LOW_ENERGY_MAX}/5) tai hallinnan tunne (enintään ${WELLBEING_RULES.LOW_CONTROL_MAX}/5) `
    + `matala ${counts.strainedDays} päivänä `
    + `${counts.reportedDays} merkitystä. Tämä on havainto omista merkinnöistäsi, ei arvio voinnistasi.`;
  const signal = makeSignal(kind, severity, DAILY_LIFE_RULE.WELLBEING_STRAIN, metrics, explanation);
  return evaluation(kind, EVALUATION_STATUS.SIGNAL, { signal, metrics: signal.metrics });
}

// ------------------------------------------------------------ raha

/**
 * Harkinnanvarainen käyttö suhteessa omaan kuukausirajaan. Vain, kun raja
 * on ilmoitettu. Mittarit ovat prosentteja ja määriä, eivät summia —
 * havaintoon ei tarvita euroja.
 */
export function moneyOverload(input) {
  const {
    monthSummary, declaredCapacityMinor = null, currency, capacityCurrency, mixedCurrencies = false
  } = argsOf(input);
  const kind = DAILY_LIFE_SIGNAL.MONEY_OVERLOAD;
  if (declaredCapacityMinor === null || declaredCapacityMinor === undefined || declaredCapacityMinor === '') {
    return evaluation(kind, EVALUATION_STATUS.NO_REFERENCE, { reason: 'no_declared_capacity' });
  }
  const status = discretionaryStatus({
    monthSummary, declaredCapacityMinor, currency, capacityCurrency, mixedCurrencies
  });
  if (!status) return evaluation(kind, EVALUATION_STATUS.INSUFFICIENT_DATA, { reason: 'sparse_or_mixed_month' });
  if (status.state === DISCRETIONARY_STATE.NO_CAPACITY) {
    return evaluation(kind, EVALUATION_STATUS.NO_REFERENCE, { reason: 'no_declared_capacity' });
  }
  const metrics = {
    month: status.month,
    usedPercent: status.usedPercent,
    transactionCount: status.transactionCount
  };
  if (status.state === DISCRETIONARY_STATE.WITHIN) return evaluation(kind, EVALUATION_STATUS.CLEAR, { metrics });

  const over = status.state === DISCRETIONARY_STATE.OVER;
  const explanation = status.usedPercent === null
    ? 'Harkinnanvaraisia menoja on kirjattu, ja oma kuukausirajasi on 0.'
    : `Harkinnanvaraisia menoja on kirjattu ${status.usedPercent} % omasta kuukausirajastasi.`;
  const signal = makeSignal(
    kind,
    over ? DAILY_LIFE_SEVERITY.ATTENTION : DAILY_LIFE_SEVERITY.INFO,
    over ? DAILY_LIFE_RULE.MONEY_OVER : DAILY_LIFE_RULE.MONEY_NEAR,
    metrics,
    explanation
  );
  return evaluation(kind, EVALUATION_STATUS.SIGNAL, { signal, metrics: signal.metrics });
}

// ------------------------------------------------------------ kooste

function compareSignals(a, b) {
  return SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
    || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]
    || a.rule.localeCompare(b.rule, 'fi');
}

/**
 * Viikon arjen havainnot yhdellä kutsulla.
 *
 * @param {object} input
 * @param {string} input.weekStart   viikon ensimmäinen päivä (ISO)
 * @param {string} [input.todayIso]  kuluva päivä; ilman sitä viikko katsotaan päättyneeksi
 * @param {string} [input.timeZone]  oletus Europe/Helsinki
 * @param {Array}  [input.sleepLogs]
 * @param {object} [input.sleepDeclared] {targetHours, bedtimeTarget, wakeTime, weekendShiftMinutes}
 * @param {Array}  [input.wellbeingEntries]
 * @param {Array}  [input.wellbeingCheckins]
 * @param {object} [input.monthSummary] budget.summarizeMonth-tulos
 * @param {number|null} [input.declaredCapacityMinor]
 * @param {string} [input.currency]
 * @returns {{weekStart, weekEnd, windowEnd, windowDays, signals, evaluations}|null}
 */
export function dailyLifeSignals(input) {
  const args = argsOf(input);
  const span = windowOf(args.weekStart, args.todayIso);
  if (!span) return null;
  const evaluations = [
    sleepOpportunityLow(args),
    sleepRhythmDrift(args),
    wellbeingStrain(args),
    moneyOverload(args)
  ];
  const signals = evaluations.filter(e => e.signal !== null).map(e => e.signal).sort(compareSignals);
  return Object.freeze({
    weekStart: span.weekStart,
    weekEnd: span.weekEnd,
    windowEnd: span.end,
    windowDays: span.days,
    signals: Object.freeze(signals),
    evaluations: Object.freeze(evaluations)
  });
}
