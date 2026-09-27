// Kapasiteettijarru sovelluskerrokselle: YKSI polku kapasiteettiin.
//
// Ennen yhtäkään joustavaa sijoitusta päivästä varataan järjestyksessä
// (docs/MENTAL-LOAD-CORE.md, "Kapasiteettijarru"):
//
//   uni → kiinteät menot ja tehtävät → matka/valmistautuminen
//   → suojattu oma aika → suojattu vapaa-aika → loma
//   → käyttäjän puskuri → unen vaje (jos asetus päällä)
//   → viikon vähimmäisvapaa-ajan päiväosuus
//
// Joustava työ saa vain jäännöksen. Kalenteri, suojatut lohkot ja uni
// tulevat calendarPlan.calendarForPlanning-polusta (sama kuin Tänään,
// Kalenteri ja keskeytykset); luvut capacity.js:stä. Tämä moduuli vain
// kokoaa syötteet tilasta, jotta tekoälysuunnitelman konteksti,
// Suunnittelu-näkymä, päivän uudelleensuunnittelu, viikkokatsaus,
// sunnuntain nollaus ja Tänään laskevat SAMAN luvun.
//
// Ei DOM:ia eikä kirjoituksia.

import { calendarForPlanning } from './calendarPlan.js';
import { currentLifeSettings } from './state.js';
import {
  horizonCapacity, normalizeBufferRatio, DEFAULT_BUFFER_RATIO
} from '../domain/capacity.js';
import { weeklyFreeTimeReserve, distributeReserve } from '../domain/protectedTime.js';
import { weekStartOf } from '../domain/weeklyCapacity.js';
import { addDaysIso } from '../domain/fiTemporal.js';
import { isIsoDate } from '../domain/task.js';
import { isMovable } from '../domain/planScheduler.js';
import { isSchedulable, schedulingContext, weekEndOf } from '../domain/lifeLoad.js';
import { sleepOpportunityMinutes } from '../domain/sleepLog.js';
import { sleepTargetMinutes } from '../domain/sleepRhythm.js';
import { getDevicePreference } from '../data/preferences.js';
import { columnGateOpen } from '../data/schema.js';
import { deviceOffsetMinutes } from './deviceTime.js';

const EMPTY = Object.freeze([]);
const MAX_DAYS = 400;

function listOf(value) {
  return Array.isArray(value) ? value : EMPTY;
}

/**
 * Välin kapasiteettiin vaikuttavat tehtävät: välin päivät ja niiden
 * naapuripäivät (huomisen aamu määrää tämän illan nukkumaanmenon). Suuren
 * aineiston laskenta ei kulje jokaisen tehtävän läpi jokaisena päivänä.
 */
function tasksNear(tasks, from, to) {
  const start = addDaysIso(from, -1);
  const end = addDaysIso(to, 1);
  return listOf(tasks).filter(task => task && task.date && task.date >= start && task.date <= end);
}

function datesBetween(from, to) {
  const dates = [];
  for (let date = from; date && date <= to && dates.length < MAX_DAYS; date = addDaysIso(date, 1)) dates.push(date);
  return dates;
}

/**
 * Käyttäjän puskuri. Tilikohtainen arvo (profile.planning_buffer_ratio,
 * 0010) voittaa, kun sarake on käytössä; muuten laitteen asetus; muuten
 * oletus 0,25. L0: arvo ei aiemmin päätynyt laskentaan lainkaan.
 */
export function planningBufferRatio(state) {
  const profileValue = state && state.profile ? state.profile.planningBufferRatio : null;
  if (columnGateOpen('GOAL_PLANNING_FIELDS') && Number.isFinite(profileValue)) return normalizeBufferRatio(profileValue);
  const device = Number(getDevicePreference('planningBufferRatio'));
  return normalizeBufferRatio(Number.isFinite(device) ? device : DEFAULT_BUFFER_RATIO);
}

/**
 * Unen vaje heräämispäivittäin (minuutteja tavoitteesta), kun käyttäjä on
 * valinnut "Uni vaikuttaa kapasiteettiin" (life_settings.sleep_affects_capacity).
 * L0: asetus oli olemassa, mutta mikään ei lukenut sitä.
 *
 * @returns {Map<string, number>}
 */
export function sleepShortfallsFor(state, dates = EMPTY) {
  const result = new Map();
  if (!state || !currentLifeSettings(state).sleepAffectsCapacity) return result;
  const target = sleepTargetMinutes(state.profile);
  const byWakeDate = new Map(listOf(state.sleepLogs).filter(log => log && log.wakeDate).map(log => [log.wakeDate, log]));
  for (const date of listOf(dates)) {
    const log = byWakeDate.get(date);
    if (!log) continue;
    const actual = sleepOpportunityMinutes(log, 'actual');
    if (Number.isFinite(actual) && actual < target) result.set(date, target - actual);
  }
  return result;
}

/**
 * Jarrun syötteet välille [from, to]. Kalenteri lasketaan KOKONAISILLE
 * ISO-viikoille, jotta viikon vähimmäisvapaa-aika voidaan jakaa viikon
 * päiville (vain tästä päivästä eteenpäin: mennyt päivä ei voi olla vapaa).
 *
 * @returns {{events, blocks, bufferRatio:number, reserves:Map, sleepShortfalls:Map,
 *   weeks:Array<{weekStart, targetMinutes, coveredMinutes, reserveMinutes}>}}
 */
export function brakeInputs(state, { from, to, todayIso = from, nowMinutes = null, offsetMinutesFn = deviceOffsetMinutes } = {}) {
  const empty = {
    events: EMPTY, blocks: EMPTY, bufferRatio: planningBufferRatio(state),
    reserves: new Map(), sleepShortfalls: new Map(), weeks: []
  };
  if (!state || !isIsoDate(from) || !isIsoDate(to) || to < from) return empty;
  const weekFrom = weekStartOf(from);
  const weekTo = addDaysIso(weekStartOf(to), 6);
  const calendar = calendarForPlanning(state, { from: weekFrom, to: weekTo, todayIso, nowMinutes, offsetMinutesFn });
  const bufferRatio = planningBufferRatio(state);
  const sleepShortfalls = sleepShortfallsFor(state, datesBetween(from, to));
  const reserves = new Map();
  const weeks = [];
  const periods = listOf(state.protectedPeriods);
  const hasTarget = periods.some(period => period && period.active !== false && period.recurrence === 'weekly_target');
  if (hasTarget) {
    const base = horizonCapacity({
      tasks: tasksNear(listOf(state.tasks).filter(task => !isMovable(task)), weekFrom, weekTo), profile: state.profile,
      fromIso: weekFrom, toIso: weekTo, routines: listOf(state.routines), exceptions: listOf(state.routineExceptions),
      bufferRatio, events: calendar.events, blocks: calendar.blocks, sleepShortfalls
    });
    for (let week = weekFrom; week <= weekTo; week = addDaysIso(week, 7)) {
      const dates = datesBetween(week, addDaysIso(week, 6));
      const reserve = weeklyFreeTimeReserve({ periods, blocks: calendar.blocks, weekDates: dates });
      const open = base.days.filter(day => dates.includes(day.dateIso) && (!todayIso || day.dateIso >= todayIso));
      const shares = distributeReserve(open, reserve.reserveMinutes);
      for (const [date, minutes] of shares) if (minutes > 0) reserves.set(date, minutes);
      weeks.push({ weekStart: week, ...reserve });
    }
  }
  return { events: calendar.events, blocks: calendar.blocks, bufferRatio, reserves, sleepShortfalls, weeks };
}

/**
 * Jarrutettu kapasiteetti välille [from, to]. `tasks` oletuksena kaikki
 * tehtävät; suunnittelija antaa ne ilman ehdokkaitaan (planScheduler).
 */
export function brakedHorizonCapacity(state, { from, to, todayIso = from, nowMinutes = null, tasks = null } = {}) {
  const inputs = brakeInputs(state, { from, to, todayIso, nowMinutes });
  const capacity = horizonCapacity({
    tasks: tasksNear(Array.isArray(tasks) ? tasks : listOf(state && state.tasks), from, to), profile: state ? state.profile : null,
    fromIso: from, toIso: to, routines: listOf(state && state.routines), exceptions: listOf(state && state.routineExceptions),
    bufferRatio: inputs.bufferRatio, events: inputs.events, blocks: inputs.blocks,
    reserves: inputs.reserves, sleepShortfalls: inputs.sleepShortfalls
  });
  return { capacity, inputs };
}

/**
 * Tämän päivän ja viikon jäljellä oleva joustava aika elämän kuormalle
 * (lifeLoad.computeLifeLoad). Joustavat, sijoitettavat tehtävät EIVÄT kuluta
 * tätä lukua etukäteen: fokus valitaan juuri niistä.
 *
 * @returns {{todayRemainingMinutes:number|null, weekRemainingMinutes:number|null, today:object|null, vacation:boolean}}
 */
export function loadCapacity(state, { todayIso, nowMinutes = null } = {}) {
  if (!state || !isIsoDate(todayIso)) {
    return { todayRemainingMinutes: null, weekRemainingMinutes: null, today: null, vacation: false };
  }
  const weekEnd = weekEndOf(todayIso);
  const context = schedulingContext({ goals: state.goals, projects: state.projects, todayIso });
  // Fokuksen ehdokkaat ovat ajattomia, sijoitettavia tehtäviä; ajastetut
  // (myös automaatin sijoittamat) ovat jo varattua aikaa.
  const fixedOnly = listOf(state.tasks).filter(task => !(task && !task.completed && !task.time && isMovable(task)
    && isSchedulable(task, context)));
  const { capacity } = brakedHorizonCapacity(state, { from: todayIso, to: weekEnd, todayIso, nowMinutes, tasks: fixedOnly });
  const today = capacity.days.find(day => day.dateIso === todayIso) || null;
  return {
    todayRemainingMinutes: today ? today.usableMinutes : null,
    weekRemainingMinutes: capacity.totalUsableMinutes,
    today,
    vacation: Boolean(today && today.vacation)
  };
}
