// Tapojen muutos (esim. nikotiinin vähentäminen): suunnitelman vaihe,
// seuraava suunniteltu aika, päivän tila ja edistyminen.
//
// PUHDAS MODUULI: ei kelloa, ei DOM:ia, ei verkkoa. Nykyhetki annetaan
// aina parametrina (`nowMs` tai `todayIso`), ja paikallinen päivä
// lasketaan annetussa aikavyöhykkeessä (zonedClock.js), ei koneen omassa.
//
// =====================================================================
// TÄMÄ EI OLE TERVEYSNEUVONTAA
// =====================================================================
//
// Moduuli toteuttaa käyttäjän OMAN suunnitelman: hänen valitsemansa välin,
// päivätavoitteen ja vaiheet. Se ei arvioi, onko suunnitelma hyvä, eikä
// ehdota annoksia. Kieli on neutraalia: kirjaus on tieto, ei arvosana.
// "Seuraava suunniteltu aika 14.20" — ei "vielä 40 minuuttia kestettävää".
// Yksikään teksti ei moralisoi, syyllistä tai puhu retkahduksista.
//
// Tapa-, uni- ja mielialatiedot ovat arkaluonteisia: tämä moduuli ei
// kirjaa mitään lokiin eikä rakenna tekoälyn kontekstia.
//
// =====================================================================
// TOIMINNOT (HABIT_ACTION)
// =====================================================================
//
//   use    käyttökerta. Seuraava suunniteltu aika = kirjaus + vaiheen väli.
//   delay  "myöhemmin": suunniteltu hetki siirtyy HABIT_RULES.DELAY_MINUTES
//          eteenpäin (enintään välin verran). Ei käyttökerta.
//   skip   suunniteltu kerta jätettiin väliin. Seuraava suunniteltu aika =
//          ohitus + vaiheen väli. Ei käyttökerta.
//
// Seuraava suunniteltu aika on näistä myöhäisin: ohitus tai siirto ei
// koskaan aikaista sitä, mitä viimeisin käyttökerta jo määräsi.
//
// =====================================================================
// VAIHEET
// =====================================================================
//
// Suunnitelmalla voi olla vaiheita [{from, intervalMinutes, dailyTarget}].
// Voimassa on vaihe, jonka alkupäivä on myöhäisin mutta enintään tänään.
// Vaiheen tyhjä kenttä (null) perii suunnitelman oman arvon. Ennen
// ensimmäistä vaihetta käytetään suunnitelman omia arvoja.

import { HABIT_KIND, HABIT_KINDS, HABIT_ACTION, HABIT_ACTIONS, MAX_HABIT_STEPS } from './dailyLife.js';
import { isIsoDate } from './task.js';
import { addDaysIso } from './fiTemporal.js';
import { HABIT_RULES } from './dailyLifeSignalsPolicy.js';
import {
  DEFAULT_TIME_ZONE, resolveTimeZone, zonedParts, zonedEpochMs, parseTimestampMs
} from './zonedClock.js';
import { formatMoney, normalizeCurrency } from './money.js';

const MINUTE_MS = 60 * 1000;
const collator = new Intl.Collator('fi');

/** Tietokannan rajat (0014: habit_plans). Rajojen ulkopuolinen arvo on tuntematon. */
const INTERVAL_MIN = 1;
const INTERVAL_MAX = 1440;
const TARGET_MAX = 200;
const UNIT_COST_MAX = 10_000_000;
const MAX_ID_LENGTH = 200;

/** Päivän tila. */
export const HABIT_STATE = Object.freeze({
  /** Suunniteltu väli on kulunut, tai väliä ei ole. */
  OK_NOW: 'ok_now',
  /** Seuraava suunniteltu aika on tulossa. */
  WAIT: 'wait',
  /** Päivän suunniteltu määrä on käytetty. */
  DAILY_TARGET_REACHED: 'daily_target_reached',
  /** Ei aktiivista suunnitelmaa. */
  NO_PLAN: 'no_plan'
});

export const HABIT_STATES = Object.freeze(Object.values(HABIT_STATE));

const ACTION_RANK = Object.freeze({
  [HABIT_ACTION.USE]: 0,
  [HABIT_ACTION.DELAY]: 1,
  [HABIT_ACTION.SKIP]: 2
});

// ------------------------------------------------------------ lukeminen

/** Hajotettava olio: null, luku tai merkkijono ei kaada funktiota. */
const argsOf = value => (value !== null && typeof value === 'object' ? value : {});

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Kokonaisluku annetulla välillä, muuten null. Tyhjä EI ole nolla. */
function intIn(value, min, max) {
  if (value === null || value === undefined || value === '') return null;
  let n;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'string') n = value.trim() === '' ? NaN : Number(value.trim());
  else return null;
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

function compareNullableAsc(a, b) {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
}

const negated = value => (value === null ? null : -value);

function compareSteps(a, b) {
  if (a.from !== b.from) return a.from < b.from ? -1 : 1;
  // Sama alkupäivä kahdesti on syötevirhe. Valinta on silti deterministinen
  // syötteen järjestyksestä riippumatta: pisin väli ja pienin päivätavoite
  // ensin, tyhjät viimeisenä.
  return compareNullableAsc(negated(a.intervalMinutes), negated(b.intervalMinutes))
    || compareNullableAsc(a.dailyTarget, b.dailyTarget);
}

function readSteps(steps) {
  if (!Array.isArray(steps)) return [];
  const valid = [];
  for (const step of steps) {
    if (!isObject(step) || !isIsoDate(step.from)) continue;
    valid.push({
      from: step.from,
      intervalMinutes: intIn(step.intervalMinutes, INTERVAL_MIN, INTERVAL_MAX),
      dailyTarget: intIn(step.dailyTarget, 0, TARGET_MAX)
    });
  }
  valid.sort(compareSteps);
  const unique = [];
  for (const step of valid) {
    if (unique.length > 0 && unique[unique.length - 1].from === step.from) continue;
    unique.push(step);
    if (unique.length >= MAX_HABIT_STEPS) break;
  }
  return unique;
}

/**
 * Suunnitelma sellaisena kuin moottori sen ymmärtää. Ei normalisoija
 * (se on habit.js:ssä), vaan puolustava lukija: roska ei kaada laskentaa.
 */
function readPlan(plan) {
  if (!isObject(plan)) return null;
  return {
    id: cleanId(plan.id),
    kind: HABIT_KINDS.includes(plan.kind) ? plan.kind : HABIT_KIND.GENERIC,
    minIntervalMinutes: intIn(plan.minIntervalMinutes, INTERVAL_MIN, INTERVAL_MAX),
    dailyTarget: intIn(plan.dailyTarget, 0, TARGET_MAX),
    baselinePerDay: intIn(plan.baselinePerDay, 0, TARGET_MAX),
    steps: readSteps(plan.steps),
    unitCostMinor: intIn(plan.unitCostMinor, 0, UNIT_COST_MAX),
    active: plan.active !== false,
    createdAt: plan.createdAt ?? null
  };
}

function compareEvents(a, b) {
  if (a.ms !== b.ms) return a.ms - b.ms;
  const byAction = ACTION_RANK[a.action] - ACTION_RANK[b.action];
  if (byAction !== 0) return byAction;
  if (a.id === b.id) return 0;
  if (a.id === null) return 1;
  if (b.id === null) return -1;
  return collator.compare(a.id, b.id);
}

/**
 * Suunnitelman kirjaukset aikajärjestyksessä.
 *
 * Kirjaukset rajataan suunnitelman tunnisteeseen (jos suunnitelmalla on
 * tunniste). Sama tunniste kahdesti lasketaan kerran — esim. optimistinen
 * lisäys ja uudelleenlataus eivät tuplaa kertoja.
 */
function prepareEvents(events, planId, zone, horizonMs) {
  if (!Array.isArray(events)) return [];
  const list = [];
  for (const event of events) {
    if (!isObject(event)) continue;
    if (planId !== null && cleanId(event.planId) !== planId) continue;
    if (!HABIT_ACTIONS.includes(event.action)) continue;
    const ms = parseTimestampMs(event.occurredAt, zone);
    if (ms === null) continue;
    if (horizonMs !== null && ms > horizonMs) continue;
    list.push({ id: cleanId(event.id), ms, action: event.action });
  }
  list.sort(compareEvents);
  const seen = new Set();
  const unique = [];
  for (const event of list) {
    if (event.id !== null) {
      if (seen.has(event.id)) continue;
      seen.add(event.id);
    }
    unique.push(event);
  }
  return unique;
}

// ------------------------------------------------------------ vaihe

function stepFor(plan, todayIso) {
  let chosen = null;
  let index = null;
  let next = null;
  for (let i = 0; i < plan.steps.length; i += 1) {
    const step = plan.steps[i];
    if (step.from <= todayIso) {
      chosen = step;
      index = i;
    } else {
      next = step;
      break;
    }
  }
  return Object.freeze({
    index,
    from: chosen ? chosen.from : null,
    intervalMinutes: chosen && chosen.intervalMinutes !== null ? chosen.intervalMinutes : plan.minIntervalMinutes,
    dailyTarget: chosen && chosen.dailyTarget !== null ? chosen.dailyTarget : plan.dailyTarget,
    source: chosen ? 'step' : 'plan',
    nextStepFrom: next ? next.from : null,
    stepCount: plan.steps.length
  });
}

/**
 * Voimassa oleva vaihe päivänä `todayIso`.
 *
 * @returns {{index:number|null, from:string|null, intervalMinutes:number|null,
 *   dailyTarget:number|null, source:'step'|'plan', nextStepFrom:string|null,
 *   stepCount:number}|null}
 */
export function currentStep(plan, todayIso) {
  const read = readPlan(plan);
  if (!read || !isIsoDate(todayIso)) return null;
  return stepFor(read, todayIso);
}

// ------------------------------------------------------------ seuraava aika

function delayMinutesFor(intervalMinutes) {
  return intervalMinutes === null
    ? HABIT_RULES.DELAY_MINUTES
    : Math.min(HABIT_RULES.DELAY_MINUTES, intervalMinutes);
}

function computeNextAt(list, intervalMinutes) {
  let lastUse = -1;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i].action === HABIT_ACTION.USE) {
      lastUse = i;
      break;
    }
  }
  let next = lastUse >= 0 && intervalMinutes !== null
    ? list[lastUse].ms + intervalMinutes * MINUTE_MS
    : null;
  for (let i = lastUse + 1; i < list.length; i += 1) {
    const event = list[i];
    let candidate = null;
    if (event.action === HABIT_ACTION.DELAY) {
      candidate = event.ms + delayMinutesFor(intervalMinutes) * MINUTE_MS;
    } else if (event.action === HABIT_ACTION.SKIP && intervalMinutes !== null) {
      candidate = event.ms + intervalMinutes * MINUTE_MS;
    }
    if (candidate !== null && (next === null || candidate > next)) next = candidate;
  }
  return next;
}

function horizonFor(nowMs) {
  return nowMs + HABIT_RULES.FUTURE_SKEW_MINUTES * MINUTE_MS;
}

/**
 * Seuraava suunniteltu aika (epoch ms): viimeisin käyttökerta + voimassa
 * olevan vaiheen väli, siirrot ja ohitukset huomioiden.
 *
 * null, kun väliä ei ole, kirjauksia ei ole tai nykyhetki puuttuu.
 */
export function nextPlannedTime(input) {
  const { plan, events, nowMs, timeZone = DEFAULT_TIME_ZONE } = argsOf(input);
  const read = readPlan(plan);
  if (!read || typeof nowMs !== 'number' || !Number.isFinite(nowMs)) return null;
  const zone = resolveTimeZone(timeZone);
  const today = zonedParts(nowMs, zone);
  if (!today) return null;
  const step = stepFor(read, today.date);
  return computeNextAt(prepareEvents(events, read.id, zone, horizonFor(nowMs)), step.intervalMinutes);
}

// ------------------------------------------------------------ teksti

function formatDecimalFi(value) {
  return String(value).replace('.', ',');
}

/**
 * "1 kerta", muuten "N kertaa" (myös 0 ja desimaalit: "0,5 kertaa").
 * Sama muoto kuin Hyvinvointi-näkymän omassa tekstissä (wellbeingHub.js).
 */
function timesFi(value) {
  return value === 1 ? '1 kerta' : `${formatDecimalFi(value)} kertaa`;
}

function nextTimeText(nextAtMs, todayIso, zone) {
  const parts = zonedParts(nextAtMs, zone);
  if (!parts) return null;
  const clock = parts.time.replace(':', '.');
  if (parts.date === todayIso) return `Seuraava suunniteltu aika ${clock}`;
  if (parts.date === addDaysIso(todayIso, 1)) return `Seuraava suunniteltu aika huomenna ${clock}`;
  const [, month, day] = parts.date.split('-').map(Number);
  return `Seuraava suunniteltu aika ${day}.${month}. ${clock}`;
}

// ------------------------------------------------------------ tila

/**
 * Päivän tila hetkellä `nowMs`.
 *
 * @returns {{state:string, minutesUntil:number|null, nextAtMs:number|null,
 *   usesToday:number, dailyTarget:number|null, intervalMinutes:number|null,
 *   todayIso:string, text:string}|null} null vain, jos nykyhetki ei ole luku
 */
export function status(input) {
  const { plan, events, nowMs, timeZone = DEFAULT_TIME_ZONE } = argsOf(input);
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) return null;
  const zone = resolveTimeZone(timeZone);
  const today = zonedParts(nowMs, zone);
  if (!today) return null;
  const read = readPlan(plan);

  if (!read || !read.active) {
    return Object.freeze({
      state: HABIT_STATE.NO_PLAN,
      minutesUntil: null,
      nextAtMs: null,
      usesToday: null,
      dailyTarget: null,
      intervalMinutes: null,
      todayIso: today.date,
      text: 'Ei aktiivista suunnitelmaa.'
    });
  }

  const step = stepFor(read, today.date);
  const list = prepareEvents(events, read.id, zone, horizonFor(nowMs));
  const dayStart = zonedEpochMs(today.date, 0, zone);
  const dayEnd = zonedEpochMs(addDaysIso(today.date, 1), 0, zone);
  let usesToday = 0;
  for (const event of list) {
    if (event.action === HABIT_ACTION.USE && event.ms >= dayStart && event.ms < dayEnd) usesToday += 1;
  }

  const base = {
    usesToday,
    dailyTarget: step.dailyTarget,
    intervalMinutes: step.intervalMinutes,
    todayIso: today.date
  };

  if (step.dailyTarget !== null && usesToday >= step.dailyTarget) {
    let text;
    if (usesToday > step.dailyTarget) text = `Tänään ${usesToday} kertaa, suunnitelmassa ${step.dailyTarget}.`;
    else if (step.dailyTarget === 0) text = 'Tälle päivälle ei ole suunniteltu kertoja.';
    else text = `Päivän suunniteltu määrä on käytetty (${usesToday}/${step.dailyTarget}).`;
    return Object.freeze({
      state: HABIT_STATE.DAILY_TARGET_REACHED, minutesUntil: null, nextAtMs: null, ...base, text
    });
  }

  const nextAtMs = computeNextAt(list, step.intervalMinutes);
  if (nextAtMs !== null && nextAtMs > nowMs) {
    return Object.freeze({
      state: HABIT_STATE.WAIT,
      minutesUntil: Math.ceil((nextAtMs - nowMs) / MINUTE_MS),
      nextAtMs,
      ...base,
      text: nextTimeText(nextAtMs, today.date, zone)
    });
  }

  return Object.freeze({
    state: HABIT_STATE.OK_NOW,
    minutesUntil: 0,
    nextAtMs,
    ...base,
    text: nextAtMs !== null ? 'Suunniteltu väli on kulunut.' : 'Suunnitelmassa ei ole odotusväliä juuri nyt.'
  });
}

// ------------------------------------------------------------ edistyminen

/**
 * Säästö lähtötasoon verrattuna sentteinä:
 * (lähtötaso × seuratut päivät − käyttökerrat) × yksikköhinta.
 *
 * null, kun lähtötasoa, yksikköhintaa tai seurattuja päiviä ei ole —
 * tuntematon säästö ei ole nolla. Voi olla negatiivinen.
 */
export function moneySaved(input) {
  const { plan, uses, trackedDays } = argsOf(input);
  const read = readPlan(plan);
  if (!read || read.baselinePerDay === null || read.unitCostMinor === null) return null;
  const useCount = intIn(uses, 0, Number.MAX_SAFE_INTEGER);
  const days = intIn(trackedDays, 1, Number.MAX_SAFE_INTEGER);
  if (useCount === null || days === null) return null;
  const saved = (read.baselinePerDay * days - useCount) * read.unitCostMinor;
  return Number.isSafeInteger(saved) ? saved : null;
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

/**
 * Edistyminen viimeisiltä `days` KOKONAISELTA päivältä (ei tätä päivää,
 * joka on vielä kesken ja vääristäisi keskiarvon ja säästön). Tämän päivän
 * kirjaukset ovat erikseen kentässä `today`.
 *
 * Seuranta alkaa suunnitelman luontipäivästä tai ensimmäisestä
 * kirjauksesta (kumpi aiempi). Sitä edeltävät päivät ovat tuntemattomia,
 * eivät nollia. Seurannan aikana päivä ilman kirjauksia on nolla kertaa.
 */
export function progress(input) {
  const {
    plan, events, todayIso, days = HABIT_RULES.PROGRESS_DEFAULT_DAYS, timeZone = DEFAULT_TIME_ZONE, currency
  } = argsOf(input);
  const read = readPlan(plan);
  if (!read || !isIsoDate(todayIso)) return null;
  const windowDays = intIn(days, 1, HABIT_RULES.PROGRESS_MAX_DAYS) ?? HABIT_RULES.PROGRESS_DEFAULT_DAYS;
  const zone = resolveTimeZone(timeZone);
  const code = normalizeCurrency(currency);

  const fromIso = addDaysIso(todayIso, -windowDays);
  const dates = [];
  for (let i = 0; i <= windowDays; i += 1) dates.push(addDaysIso(fromIso, i));
  // Rajat: jokaisen päivän paikallinen keskiyö + huomisen keskiyö.
  const bounds = dates.map(date => zonedEpochMs(date, 0, zone));
  bounds.push(zonedEpochMs(addDaysIso(todayIso, 1), 0, zone));
  if (bounds.some(bound => bound === null)) return null;

  const list = prepareEvents(events, read.id, zone, null);

  const createdMs = parseTimestampMs(read.createdAt, zone);
  const firstMs = list.length > 0 ? list[0].ms : null;
  const startMs = createdMs === null ? firstMs : firstMs === null ? createdMs : Math.min(createdMs, firstMs);
  const startParts = startMs === null ? null : zonedParts(startMs, zone);
  const trackingStart = startParts ? startParts.date : null;

  const buckets = dates.map(() => ({ uses: 0, delays: 0, skips: 0, useTimes: [] }));
  let cursor = 0;
  for (const event of list) {
    if (event.ms < bounds[0]) continue;
    if (event.ms >= bounds[bounds.length - 1]) break;
    while (cursor < dates.length - 1 && event.ms >= bounds[cursor + 1]) cursor += 1;
    const bucket = buckets[cursor];
    if (event.action === HABIT_ACTION.USE) {
      bucket.uses += 1;
      bucket.useTimes.push(event.ms);
    } else if (event.action === HABIT_ACTION.DELAY) bucket.delays += 1;
    else bucket.skips += 1;
  }

  let trackedDays = 0;
  let daysWithEvents = 0;
  let uses = 0;
  let delays = 0;
  let skips = 0;
  let targetDays = 0;
  let daysWithinTarget = 0;
  let gapSum = 0;
  let gapCount = 0;
  const byDay = [];

  for (let i = 0; i < windowDays; i += 1) {
    const date = dates[i];
    const bucket = buckets[i];
    const tracked = trackingStart !== null && date >= trackingStart;
    const target = stepFor(read, date).dailyTarget;
    if (tracked) {
      trackedDays += 1;
      uses += bucket.uses;
      delays += bucket.delays;
      skips += bucket.skips;
      if (bucket.uses + bucket.delays + bucket.skips > 0) daysWithEvents += 1;
      if (target !== null) {
        targetDays += 1;
        if (bucket.uses <= target) daysWithinTarget += 1;
      }
      // Välit vain saman päivän peräkkäisistä kerroista: yön tauko ei ole väli.
      for (let k = 1; k < bucket.useTimes.length; k += 1) {
        gapSum += bucket.useTimes[k] - bucket.useTimes[k - 1];
        gapCount += 1;
      }
    }
    byDay.push(Object.freeze({
      date,
      tracked,
      uses: tracked ? bucket.uses : null,
      delays: tracked ? bucket.delays : null,
      skips: tracked ? bucket.skips : null,
      dailyTarget: target
    }));
  }

  const todayBucket = buckets[windowDays];
  const usesPerDay = trackedDays > 0 ? round1(uses / trackedDays) : null;
  const meanIntervalMinutes = gapCount > 0 ? Math.round(gapSum / gapCount / MINUTE_MS) : null;
  const changeFromBaselinePercent = usesPerDay !== null && read.baselinePerDay
    ? Math.round(((uses / trackedDays) - read.baselinePerDay) / read.baselinePerDay * 100)
    : null;
  const moneySavedMinor = trackedDays > 0 ? moneySaved({ plan: read, uses, trackedDays }) : null;

  let text;
  if (usesPerDay === null) {
    text = 'Edistymisestä ei ole vielä tietoa.';
  } else {
    // LUKU TAIPUU. Yksi seurattu päivä on aina eilinen (ikkuna päättyy
    // eiliseen), eikä yhden päivän "keskimäärin ... päivässä" ole
    // keskiarvo: "Viimeiset 1 päivää ... 1 kertaa" oli väärää suomea.
    text = trackedDays === 1
      ? `Eilen: ${timesFi(uses)}`
      : `Viimeiset ${trackedDays} päivää: keskimäärin ${timesFi(usesPerDay)} päivässä`;
    text += read.baselinePerDay !== null ? `, lähtötaso ${read.baselinePerDay}.` : '.';
    if (moneySavedMinor !== null && moneySavedMinor > 0) {
      text += ` Säästöä lähtötasoon verrattuna noin ${formatMoney(moneySavedMinor, code)}.`;
    }
  }

  return Object.freeze({
    fromIso,
    toIso: addDaysIso(todayIso, -1),
    days: windowDays,
    trackingStart,
    trackedDays,
    daysWithEvents,
    uses,
    delays,
    skips,
    usesPerDay,
    meanIntervalMinutes,
    baselinePerDay: read.baselinePerDay,
    changeFromBaselinePercent,
    targetDays,
    daysWithinTarget,
    moneySavedMinor,
    currency: code,
    byDay: Object.freeze(byDay),
    today: Object.freeze({
      date: todayIso,
      uses: todayBucket.uses,
      delays: todayBucket.delays,
      skips: todayBucket.skips
    }),
    text
  });
}

// ------------------------------------------------------------ kuittaukset

/**
 * Lyhyt, neutraali kuittausteksti kirjauksen jälkeen.
 *
 * @param {string} action HABIT_ACTION
 * @param {{nextAtMs?:number|null, nowMs?:number, timeZone?:string}} [context]
 * @returns {string|null}
 */
export function habitActionText(action, options) {
  const { nextAtMs = null, nowMs = null, timeZone = DEFAULT_TIME_ZONE } = argsOf(options);
  let head;
  if (action === HABIT_ACTION.USE) head = 'Kirjattu.';
  else if (action === HABIT_ACTION.DELAY) head = `Siirretty ${HABIT_RULES.DELAY_MINUTES} min myöhemmäksi.`;
  else if (action === HABIT_ACTION.SKIP) head = 'Ohitus kirjattu.';
  else return null;

  if (typeof nextAtMs !== 'number' || !Number.isFinite(nextAtMs)
    || typeof nowMs !== 'number' || !Number.isFinite(nowMs)) return head;
  const zone = resolveTimeZone(timeZone);
  const today = zonedParts(nowMs, zone);
  const next = today ? nextTimeText(nextAtMs, today.date, zone) : null;
  return next ? `${head} ${next}.` : head;
}
