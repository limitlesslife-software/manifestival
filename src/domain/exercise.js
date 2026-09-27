// Liikunta: viikon kooste suunnitellusta ja toteutuneesta, oma arvio
// rasittavuudesta ja palautumisvihjeet.
//
// PUHDAS MODUULI: ei kelloa, ei DOM:ia, ei verkkoa. Viikko annetaan
// parametrina.
//
// LIIKUNTAA EI AIKATAULUTETA TÄÄLLÄ
//
// Harjoituksen aikataulu elää siellä missä muukin aikataulu: rutiineissa
// ja tehtävissä. Liikuntakirjaus (exercise_sessions) kertoo mitä oli
// suunniteltu ja mitä tehtiin, mutta tämä moduuli ei tuota kalenterilohkoja
// eikä muistutuksia — muuten sama lenkki olisi päivässä kahdesti, kerran
// rutiinina ja kerran liikuntana. Kaksoiskirjaukset (sama laji samana
// päivänä) voi tunnistaa `findDuplicateSessions`-funktiolla ennen tallennusta.
//
// TUNTEMATON EI OLE NOLLA
//
// Kirjaus ilman toteutunutta kestoa ei ole nollan minuutin liikuntaa.
// Summat lasketaan vain tunnetuista arvoista, ja jos yhtäkään ei ole,
// summa on null. Toteumaprosentti verrataan vain kirjauksiin, joissa
// molemmat luvut tunnetaan.
//
// Palautumisvihjeet ovat havaintoja käyttäjän omista arvioista, eivät
// valmennusta eivätkä terveysneuvoja.

import { isCalendarDate as isIsoDate } from './zonedClock.js';
import { addDaysIso, weekdayOfIso } from './fiTemporal.js';
import { EXERCISE_RULES } from './dailyLifeSignalsPolicy.js';
import { formatDuration } from '../lib/format.js';

export const RECOVERY_HINT = Object.freeze({
  CONSECUTIVE_HARD_DAYS: 'consecutive_hard_days',
  NO_REST_DAY: 'no_rest_day'
});

const WEEKDAY_SHORT = Object.freeze(['ma', 'ti', 'ke', 'to', 'pe', 'la', 'su']);
const DEFAULT_KIND = 'Liikunta';
const MAX_ID_LENGTH = 200;
const collator = new Intl.Collator('fi');

/** Hajotettava olio: null, luku tai merkkijono ei kaada funktiota. */
const argsOf = value => (value !== null && typeof value === 'object' ? value : {});

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function intIn(value, min, max) {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : NaN;
  if (!Number.isFinite(n)) return null;
  const rounded = Math.round(n);
  return rounded >= min && rounded <= max ? rounded : null;
}

function cleanId(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' || trimmed.length > MAX_ID_LENGTH ? null : trimmed;
}

function readSession(input) {
  if (!isObject(input) || !isIsoDate(input.date)) return null;
  const label = typeof input.kind === 'string'
    ? input.kind.trim().replace(/\s+/g, ' ').slice(0, EXERCISE_RULES.MAX_KIND_LENGTH)
    : '';
  const kind = label || DEFAULT_KIND;
  return {
    id: cleanId(input.id),
    date: input.date,
    kind,
    kindKey: kind.toLocaleLowerCase('fi'),
    plannedMinutes: intIn(input.plannedMinutes, 1, EXERCISE_RULES.MAX_MINUTES),
    actualMinutes: intIn(input.actualMinutes, 1, EXERCISE_RULES.MAX_MINUTES),
    intensity: intIn(input.intensity, EXERCISE_RULES.SCALE_MIN, EXERCISE_RULES.SCALE_MAX),
    recoveryDemand: intIn(input.recoveryDemand, EXERCISE_RULES.SCALE_MIN, EXERCISE_RULES.SCALE_MAX),
    goalId: cleanId(input.goalId)
  };
}

const codeUnitOrder = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Sisäinen kanoninen järjestys (ei näytetä sellaisenaan). Merkkikoodien
 * vertailu riittää determinismiin ja on nopea; näkyvät listat (lajit,
 * tavoitteet, tunnisteet) järjestetään erikseen suomen aakkosin.
 */
function compareSessions(a, b) {
  if (a.date !== b.date) return codeUnitOrder(a.date, b.date);
  if (a.kindKey !== b.kindKey) return codeUnitOrder(a.kindKey, b.kindKey);
  if (a.id !== b.id) {
    if (a.id === null) return 1;
    if (b.id === null) return -1;
    return codeUnitOrder(a.id, b.id);
  }
  // Viimeinen erottelija: koko sisältö, jotta tunnisteettomatkin kirjaukset
  // asettuvat samaan järjestykseen syötteen järjestyksestä riippumatta.
  return codeUnitOrder(JSON.stringify(a), JSON.stringify(b));
}

/** Kelvolliset kirjaukset väliltä, järjestettyinä, sama tunniste kerran. */
function sessionsBetween(sessions, fromIso, toIso) {
  if (!Array.isArray(sessions)) return [];
  const list = [];
  for (const input of sessions) {
    // Rajaus ensin: viikon ulkopuolista kirjausta ei tarvitse lukea.
    const date = isObject(input) ? input.date : null;
    if (typeof date !== 'string') continue;
    if (fromIso !== null && date < fromIso) continue;
    if (toIso !== null && date > toIso) continue;
    const session = readSession(input);
    if (session) list.push(session);
  }
  list.sort(compareSessions);
  const seen = new Set();
  return list.filter(session => {
    if (session.id === null) return true;
    if (seen.has(session.id)) return false;
    seen.add(session.id);
    return true;
  });
}

/** Tunnettujen arvojen summa; null, jos yhtäkään ei tunneta. */
function knownSum(list, key) {
  let sum = 0;
  let count = 0;
  for (const item of list) {
    if (item[key] === null) continue;
    sum += item[key];
    count += 1;
  }
  return count > 0 ? sum : null;
}

function knownMean(list, key) {
  let sum = 0;
  let count = 0;
  for (const item of list) {
    if (item[key] === null) continue;
    sum += item[key];
    count += 1;
  }
  return count > 0 ? Math.round((sum / count) * 10) / 10 : null;
}

function totals(list) {
  return {
    sessionCount: list.length,
    plannedMinutes: knownSum(list, 'plannedMinutes'),
    actualMinutes: knownSum(list, 'actualMinutes')
  };
}

function isHard(session) {
  return (session.intensity !== null && session.intensity >= EXERCISE_RULES.HARD_MIN_LEVEL)
    || (session.recoveryDemand !== null && session.recoveryDemand >= EXERCISE_RULES.HARD_MIN_LEVEL);
}

function durationText(minutes) {
  return formatDuration(minutes) || '0 min';
}

/**
 * Viikon liikunta.
 *
 * @param {{sessions: Array, weekStart: string}} input viikko = weekStart + 6 päivää
 * @returns {object|null} null, jos viikon alku ei ole päivämäärä
 */
export function weeklyExercise(input) {
  const { sessions, weekStart } = argsOf(input);
  if (!isIsoDate(weekStart)) return null;
  const weekEnd = addDaysIso(weekStart, 6);
  const list = sessionsBetween(sessions, weekStart, weekEnd);

  const comparable = list.filter(s => s.plannedMinutes !== null && s.actualMinutes !== null);
  const comparedPlanned = knownSum(comparable, 'plannedMinutes');
  const comparedActual = knownSum(comparable, 'actualMinutes');

  const perDate = new Map();
  for (const session of list) {
    if (!perDate.has(session.date)) perDate.set(session.date, []);
    perDate.get(session.date).push(session);
  }
  const byDay = [];
  for (let i = 0; i < 7; i += 1) {
    const date = addDaysIso(weekStart, i);
    const day = perDate.get(date) || [];
    byDay.push(Object.freeze({
      date,
      weekday: weekdayOfIso(date),
      ...totals(day),
      hard: day.some(isHard)
    }));
  }

  const kindGroups = new Map();
  const goalGroups = new Map();
  for (const session of list) {
    if (!kindGroups.has(session.kindKey)) kindGroups.set(session.kindKey, []);
    kindGroups.get(session.kindKey).push(session);
    if (session.goalId !== null) {
      if (!goalGroups.has(session.goalId)) goalGroups.set(session.goalId, []);
      goalGroups.get(session.goalId).push(session);
    }
  }
  const byKind = [...kindGroups.values()]
    .map(group => Object.freeze({ kind: group[0].kind, ...totals(group) }))
    .sort((a, b) => (b.actualMinutes ?? -1) - (a.actualMinutes ?? -1) || collator.compare(a.kind, b.kind));
  const byGoal = [...goalGroups.entries()]
    .map(([goalId, group]) => Object.freeze({ goalId, ...totals(group) }))
    .sort((a, b) => collator.compare(a.goalId, b.goalId));

  const recoveryHints = [];
  let run = [];
  const flushRun = () => {
    if (run.length >= EXERCISE_RULES.HARD_RUN_DAYS) {
      const labels = run.map(day => WEEKDAY_SHORT[day.weekday - 1]).join(', ');
      recoveryHints.push(Object.freeze({
        kind: RECOVERY_HINT.CONSECUTIVE_HARD_DAYS,
        dates: Object.freeze(run.map(day => day.date)),
        text: `Raskaita päiviä peräkkäin ${run.length} (${labels}) omien arvioidesi mukaan. `
          + 'Kevyempi päivä väliin antaa aikaa palautumiselle.'
      }));
    }
    run = [];
  };
  for (const day of byDay) {
    if (day.hard) run.push(day);
    else flushRun();
  }
  flushRun();

  const activeDays = byDay.filter(day => day.sessionCount > 0).length;
  if (activeDays >= EXERCISE_RULES.NO_REST_ACTIVE_DAYS) {
    recoveryHints.push(Object.freeze({
      kind: RECOVERY_HINT.NO_REST_DAY,
      dates: Object.freeze([]),
      text: 'Liikuntaa on jokaisena viikon päivänä. Lepopäivän voi halutessaan lisätä.'
    }));
  }

  const all = totals(list);
  let text;
  if (list.length === 0) text = 'Tälle viikolle ei ole liikuntakirjauksia.';
  else if (all.actualMinutes === null && all.plannedMinutes === null) text = 'Liikuntaa on kirjattu ilman kestoja.';
  else if (all.actualMinutes === null) text = `Suunniteltua liikuntaa ${durationText(all.plannedMinutes)}, toteumaa ei ole vielä kirjattu.`;
  else {
    text = `Liikuntaa ${durationText(all.actualMinutes)}`;
    text += all.plannedMinutes !== null ? ` (suunniteltu ${durationText(all.plannedMinutes)}).` : '.';
  }

  return Object.freeze({
    weekStart,
    weekEnd,
    ...all,
    plannedKnownCount: list.filter(s => s.plannedMinutes !== null).length,
    completedCount: list.filter(s => s.actualMinutes !== null).length,
    comparedSessions: comparable.length,
    completionPercent: comparedPlanned ? Math.round((comparedActual / comparedPlanned) * 100) : null,
    intensityAverage: knownMean(list, 'intensity'),
    recoveryDemandAverage: knownMean(list, 'recoveryDemand'),
    activeDays,
    completedDays: new Set(list.filter(s => s.actualMinutes !== null).map(s => s.date)).size,
    byDay: Object.freeze(byDay),
    byKind: Object.freeze(byKind),
    byGoal: Object.freeze(byGoal),
    recoveryHints: Object.freeze(recoveryHints),
    text
  });
}

/**
 * Tavoitteeseen liitetty liikunta aikaväliltä (molemmat päät mukaan).
 * Rajat ovat valinnaisia; null = ei rajaa.
 */
export function exerciseForGoal(input) {
  const { sessions, goalId, fromIso = null, toIso = null } = argsOf(input);
  const id = cleanId(goalId);
  if (id === null) return null;
  const from = isIsoDate(fromIso) ? fromIso : null;
  const to = isIsoDate(toIso) ? toIso : null;
  const list = sessionsBetween(sessions, from, to).filter(s => s.goalId === id);
  return Object.freeze({
    goalId: id,
    fromIso: from,
    toIso: to,
    ...totals(list),
    lastDate: list.length > 0 ? list[list.length - 1].date : null
  });
}

/**
 * Mahdolliset kaksoiskirjaukset: sama laji (kirjainkoosta riippumatta)
 * samana päivänä eri tunnisteilla. Käyttöliittymä voi kysyä ennen
 * tallennusta — mitään ei poisteta automaattisesti.
 */
export function findDuplicateSessions(sessions) {
  const groups = new Map();
  for (const session of sessionsBetween(sessions, null, null)) {
    const key = `${session.date}\u0000${session.kindKey}`;
    if (!groups.has(key)) groups.set(key, { date: session.date, kind: session.kind, ids: [] });
    groups.get(key).ids.push(session.id);
  }
  const compareIds = (a, b) => (a === b ? 0 : a === null ? 1 : b === null ? -1 : a.localeCompare(b, 'fi'));
  return Object.freeze([...groups.values()]
    .filter(group => group.ids.length > 1)
    .map(group => Object.freeze({ ...group, ids: Object.freeze([...group.ids].sort(compareIds)) })));
}
