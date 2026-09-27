// Aalto L: mielen kuorman ydin — yksi kuormamoottori, asian luonne,
// suojattu aika, kapasiteettijarru, viikkosuunnitelma ja Rauhallinen tänään.
//
// docs/MENTAL-LOAD-CORE.md on sopimus; nämä testit ovat sen todisteet.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { read } from './helpers/sources.mjs';
import { freezeLocalDate } from './helpers/clock.mjs';
import {
  computeLifeLoad, horizonOf, isSchedulable, schedulingContext, LOAD_HORIZON, NOW_LIMIT,
  storedMessage, explainLoad, slippedItems, weekEndOf
} from '../src/domain/lifeLoad.js';
import { deriveNature, NATURE, AREA_KIND, competesForFocus } from '../src/domain/itemNature.js';
import {
  normalizeProtectedPeriod, validateProtectedPeriod, periodBlocks, vacationOn, weeklyFreeTimeReserve,
  distributeReserve, freeTimeRules, freeTimeRulePeriods, reconcileFreeTimeRules, describePeriod,
  PROTECTED_KIND, PERIOD_RECURRENCE, protectedDaySummary, protectedPlanningHours, ruleOf, RULE
} from '../src/domain/protectedTime.js';
import { normalizeWeeklyPlan, validateWeeklyPlan, WEEKLY_PRIORITY_LIMIT } from '../src/domain/weeklyPlan.js';
import { normalizeTask, validateTask, reschedulePatch, isOverdue, TASK_HORIZON } from '../src/domain/task.js';
import { normalizeLifeArea, validateLifeArea, categoryOwnerArea } from '../src/domain/lifeArea.js';
import { dayCapacity, horizonCapacity } from '../src/domain/capacity.js';
import { planHorizon } from '../src/domain/planScheduler.js';
import { taskColumns, datelessTasksAllowed } from '../src/data/schema.js';
import { toRow, fromRow, TASK_COLUMNS_MENTAL_LOAD } from '../src/lib/rows.js';
import {
  resetState, getState, setTasks, setBills, setProtectedPeriods, setGoals, setViewDate, setWeeklyPlans
} from '../src/app/state.js';
import { lifeLoadFor, resetLifeLoadCache, focusTaskIds } from '../src/app/lifeLoadModel.js';

const PROFILE = { sleepTargetHours: 8, defaultWakeTime: '07:00', commuteMinutes: 0, routineMinutes: 0 };
const MON = '2026-10-05';
const TUE = '2026-10-06';
const SUN = '2026-10-11';

const task = (id, fields = {}) => normalizeTask({ id, title: `T ${id}`, ...fields });

beforeEach(() => {
  resetState();
  resetLifeLoadCache();
});

// =====================================================================
// YKSI KUORMAMOOTTORI
// =====================================================================

test('NOW on enintään kolme, ja muu on tallessa (storedCount)', () => {
  const tasks = [1, 2, 3, 4, 5].map(n => task(`t${n}`, { date: MON, durationMinutes: 20, priority: n === 5 ? 'korkea' : 'normaali' }));
  const load = computeLifeLoad({ tasks, todayIso: MON });
  assert.equal(load.now.length, NOW_LIMIT);
  assert.equal(load.now[0].id, 't5', 'tärkeä ensin');
  assert.equal(load.storedCount, 2);
  assert.equal(storedMessage(load.storedCount).title, 'Kaikki muu on tallessa (2).');
  assert.equal(storedMessage(load.storedCount).text, 'Sinun ei tarvitse hoitaa sitä tänään.');
});

test('myöhässä ei ole automaattisesti NOW: kapasiteetti ratkaisee', () => {
  const overdue = [1, 2, 3].map(n => task(`o${n}`, { date: '2026-09-28', durationMinutes: 60 }));
  const load = computeLifeLoad({ tasks: overdue, todayIso: MON, capacity: { todayRemainingMinutes: 90 } });
  assert.equal(load.now.length, 1, 'vain yksi tunti mahtuu 90 minuuttiin');
  assert.equal(load.overflow.length, 2);
  assert.ok(load.thisWeek.every(entry => entry.reasons.includes('Ei mahdu tämän päivän aikaan')));
  assert.equal(slippedItems(load).length, 2);
});

test('täysi päivä: ei fokusta, rauhallinen selitys', () => {
  const load = computeLifeLoad({ tasks: [task('a', { date: MON })], todayIso: MON, capacity: { todayRemainingMinutes: 0 } });
  assert.equal(load.now.length, 0);
  assert.match(explainLoad(load), /ei ole tilaa joustavalle työlle/);
});

test('kiinteästi ajastettu kuuluu aikajanalle, ei fokukseen (ei kaksoisesiintymistä)', () => {
  const load = computeLifeLoad({
    tasks: [task('f', { date: MON, time: '10:00', endTime: '11:00' }), task('x', { date: MON })], todayIso: MON
  });
  assert.deepEqual(load.fixedToday.map(e => e.id), ['f']);
  assert.deepEqual(load.now.map(e => e.id), ['x']);
  assert.equal(load.storedCount, 0);
});

test('lasku kilpailee fokuksesta, ja liitetty tehtävä edustaa laskua (ei kahdesti)', () => {
  const bills = [
    { id: 'b1', name: 'Sähkö', status: 'open', dueDate: MON, taskId: null },
    { id: 'b2', name: 'Vuokra', status: 'open', dueDate: TUE, taskId: 'tb' },
    { id: 'b3', name: 'Maksettu', status: 'paid', dueDate: MON }
  ];
  const load = computeLifeLoad({ tasks: [task('tb', { date: MON, title: 'Maksa vuokra' })], bills, todayIso: MON });
  const keys = [...load.now, ...load.thisWeek, ...load.later].map(e => e.key);
  assert.ok(keys.includes('bill:b1'));
  assert.ok(!keys.includes('bill:b2'), 'liitetty tehtävä edustaa laskua');
  assert.ok(!keys.includes('bill:b3'));
  assert.equal(load.now.find(e => e.key === 'bill:b1').nature, NATURE.OBLIGATION);
});

test('hyvinvointi vie fokuspaikan vain valittuna; muuten valinnainen', () => {
  const areas = [normalizeLifeArea({ id: 'w', name: 'Terveys', importance: 4, kind: AREA_KIND.WELLBEING, categoryKey: 'hyvinvointi' })];
  const walk = task('walk', { date: MON, category: 'hyvinvointi' });
  const plain = computeLifeLoad({ tasks: [walk], lifeAreas: areas, todayIso: MON });
  assert.equal(plain.now.length, 0);
  assert.ok(plain.thisWeek[0].reasons.some(r => /Valinnainen/.test(r)));
  const chosen = computeLifeLoad({ tasks: [{ ...walk, priority: 'korkea' }], lifeAreas: areas, todayIso: MON });
  assert.equal(chosen.now.length, 1);
  const pinned = computeLifeLoad({ tasks: [{ ...walk, horizon: 'NOW' }], lifeAreas: areas, todayIso: MON });
  assert.equal(pinned.now.length, 1);
});

test('viikon prioriteetti nostaa asian fokukseen', () => {
  const tasks = [task('a', { date: MON, priority: 'korkea' }), task('b', { date: MON }), task('c', { date: MON }), task('d', { date: MON, goalId: 'g1' })];
  const plan = normalizeWeeklyPlan({ weekStart: MON, priorities: [{ ref: 'goal:g1', title: 'Juoksu' }] });
  const load = computeLifeLoad({ tasks, weeklyPlan: plan, todayIso: MON, options: { nowLimit: 2 } });
  assert.ok(load.now.map(e => e.id).includes('d'));
  assert.ok(load.now.find(e => e.id === 'd').reasons.includes('Viikon prioriteetti'));
});

test('tauolla olevan tavoitteen tehtävä on NOT_YET, odottava WAITING ja tarkistuspäivä tuo sen takaisin', () => {
  const goals = [{ id: 'gp', status: 'paused' }];
  const tasks = [
    task('p', { date: MON, goalId: 'gp' }),
    task('w', { horizon: 'WAITING', waitingOn: 'Anna' }),
    task('wf', { horizon: 'WAITING', waitingOn: 'Taloyhtiö', followUpDate: MON }),
    task('n', { horizon: 'NOT_YET' }),
    task('l', { horizon: 'LATER' }),
    task('x', { date: MON, archivedAt: '2026-10-01T10:00:00Z' })
  ];
  const load = computeLifeLoad({ tasks, goals, todayIso: MON });
  assert.deepEqual(load.notYet.map(e => e.id).sort(), ['n', 'p']);
  assert.deepEqual(load.waiting.map(e => e.id), ['w']);
  assert.ok(load.thisWeek.some(e => e.id === 'wf' && e.reasons[0].startsWith('Tarkista tilanne')));
  assert.deepEqual(load.later.map(e => e.id), ['l']);
  assert.deepEqual(load.archived.map(e => e.id), ['x']);
  assert.equal(load.storedCount, 5, 'arkisto ei ole tallessa-lukua');
});

test('horizonOf: päivä, määräaika ja viikko', () => {
  const ctx = schedulingContext({ todayIso: MON });
  assert.equal(horizonOf(task('a', { date: '2026-10-01' }), ctx).horizon, LOAD_HORIZON.NOW);
  assert.equal(horizonOf(task('b', { date: '2026-10-20', deadline: TUE }), ctx).horizon, LOAD_HORIZON.NOW);
  assert.equal(horizonOf(task('c', { date: '2026-10-09' }), ctx).horizon, LOAD_HORIZON.THIS_WEEK);
  assert.equal(horizonOf(task('d', { date: '2026-10-20' }), ctx).horizon, LOAD_HORIZON.LATER);
  assert.equal(horizonOf(task('e', { horizon: 'NOW', date: '2026-10-01' }), ctx).horizon, LOAD_HORIZON.NOW,
    'vanha fokusvalinta ei ole voimassa, päivä ratkaisee');
  assert.equal(weekEndOf(MON), SUN);
});

test('matala energia keventää päivää', () => {
  const tasks = [task('a', { date: MON, durationMinutes: 50 }), task('b', { date: MON, durationMinutes: 50 })];
  const normal = computeLifeLoad({ tasks, todayIso: MON, capacity: { todayRemainingMinutes: 120 } });
  const tired = computeLifeLoad({ tasks, todayIso: MON, capacity: { todayRemainingMinutes: 120 }, energy: { level: 2 } });
  assert.equal(normal.now.length, 2);
  assert.equal(tired.now.length, 1);
  assert.equal(tired.lowEnergy, true);
});

test('viikon kapasiteetti merkitsee mahtumattomat, mutta ne pysyvät tallessa', () => {
  const tasks = [task('a', { date: '2026-10-08', durationMinutes: 120 }), task('b', { date: '2026-10-09', durationMinutes: 120 })];
  const load = computeLifeLoad({ tasks, todayIso: MON, capacity: { todayRemainingMinutes: 60, weekRemainingMinutes: 150 } });
  assert.equal(load.thisWeek.length, 2);
  assert.equal(load.overflow.length, 1);
  assert.equal(load.thisWeek.find(e => e.fits === false).reasons.at(-1), 'Ei mahdu tämän viikon aikaan');
});

test('isSchedulable: odottava, ei vielä, arkisto ja tarkoituksella päivätön eivät kuulu suunnitteluun', () => {
  const ctx = schedulingContext({ todayIso: MON });
  assert.equal(isSchedulable(task('a', { date: MON }), ctx), true);
  assert.equal(isSchedulable(task('b', { horizon: 'LATER' }), ctx), false);
  assert.equal(isSchedulable(task('c', { horizon: 'THIS_WEEK' }), ctx), true);
  assert.equal(isSchedulable(task('d', { horizon: 'WAITING' }), ctx), false);
  assert.equal(isSchedulable(task('e', { date: MON, archivedAt: 'x' }), ctx), false);
});

test('tulos on jäädytetty ja deterministinen', () => {
  const input = { tasks: [task('a', { date: MON }), task('b', { date: MON })], todayIso: MON };
  const one = computeLifeLoad(input);
  assert.ok(Object.isFrozen(one) && Object.isFrozen(one.now));
  assert.deepEqual(computeLifeLoad(input).now.map(e => e.id), one.now.map(e => e.id));
});

// =====================================================================
// ASIAN LUONNE
// =====================================================================

test('luonne johdetaan: lasku, alue, tavoite, määräaika, rutiini, kategoria', () => {
  assert.equal(deriveNature({}, { kind: 'bill' }).nature, NATURE.OBLIGATION);
  assert.equal(deriveNature(task('a'), { area: { kind: AREA_KIND.ENJOYMENT, name: 'Musiikki' } }).nature, NATURE.ENJOYMENT);
  assert.equal(deriveNature(task('a'), { area: { kind: AREA_KIND.VACATION } }).nature, NATURE.FREE_TIME);
  assert.equal(deriveNature(task('b', { goalId: 'g' })).nature, NATURE.GOAL_ACTION);
  assert.equal(deriveNature(task('c', { deadline: MON })).nature, NATURE.OBLIGATION);
  assert.equal(deriveNature({ category: 'hyvinvointi' }, { kind: 'routine' }).nature, NATURE.WELLBEING);
  assert.equal(deriveNature({ category: 'koti' }, { kind: 'routine' }).nature, NATURE.MAINTENANCE);
  assert.equal(deriveNature(task('d', { category: 'harrastus' })).nature, NATURE.ENJOYMENT);
  assert.equal(deriveNature(task('e', { category: 'muu' })).nature, NATURE.MAINTENANCE);
  assert.equal(competesForFocus(NATURE.WELLBEING), false);
});

test('alueen laji ja jaettu kategoria (0015)', () => {
  const a = normalizeLifeArea({ id: 'a', name: 'Työ A', categoryKey: 'tyo', importance: 3, sortOrder: 2 });
  const b = normalizeLifeArea({ id: 'b', name: 'Työ B', categoryKey: 'tyo', importance: 3, sortOrder: 1 });
  assert.equal(a.kind, AREA_KIND.STANDARD);
  assert.equal(normalizeLifeArea({ kind: 'OBLIGATION' }).kind, AREA_KIND.STANDARD, 'luonne ei ole alueen laji');
  assert.equal(validateLifeArea(a, [b]).valid, false, 'ennen 0015:tä kanta vaatii uniikin kategorian');
  assert.equal(validateLifeArea(a, [b], { allowSharedCategory: true }).valid, true);
  assert.equal(categoryOwnerArea([a, b], 'tyo').id, 'b', 'pienin järjestysnumero perii');
});

// =====================================================================
// SUOJATTU AIKA
// =====================================================================

test('suojattu jakso: validointi vastaa kannan sääntöjä', () => {
  const ok = [
    { kind: 'OWN_TIME', recurrence: 'weekly', weekdays: [2, 4], startTime: '18:00', endTime: '20:00' },
    { kind: 'FREE_TIME', recurrence: 'weekly', weekdays: [7], strength: 'soft' },
    { kind: 'FREE_TIME', recurrence: 'weekly_target', targetMinutes: 600 },
    { kind: 'VACATION', recurrence: 'once', startDate: '2026-12-20', endDate: '2027-01-02' },
    { kind: 'OWN_TIME', recurrence: 'once', startDate: MON, startTime: '10:00', endTime: '12:00' }
  ];
  for (const input of ok) assert.equal(validateProtectedPeriod(normalizeProtectedPeriod(input)).valid, true, JSON.stringify(input));
  const bad = [
    { kind: 'OWN_TIME', recurrence: 'weekly', weekdays: [] },
    { kind: 'OWN_TIME', recurrence: 'weekly_target', targetMinutes: 60 },
    { kind: 'VACATION', recurrence: 'weekly', weekdays: [1] },
    { kind: 'VACATION', recurrence: 'once', startDate: MON, startTime: '10:00' },
    { kind: 'OWN_TIME', recurrence: 'once', startDate: TUE, endDate: MON },
    { kind: 'FREE_TIME', recurrence: 'weekly', weekdays: [1], startTime: '20:00', endTime: '19:00' },
    { kind: 'OBLIGATION', recurrence: 'once', startDate: MON }
  ];
  for (const input of bad) assert.equal(validateProtectedPeriod(normalizeProtectedPeriod(input)).valid, false, JSON.stringify(input));
});

test('jaksot lohkoiksi: ilta päättyy rauhoittumiseen, sunnuntai pääosin vapaa, loma koko päivä', () => {
  const periods = [
    normalizeProtectedPeriod({ id: 'eve', kind: 'FREE_TIME', recurrence: 'weekly', weekdays: [1], startTime: '17:00' }),
    normalizeProtectedPeriod({ id: 'sun', kind: 'FREE_TIME', recurrence: 'weekly', weekdays: [7], strength: 'soft' }),
    normalizeProtectedPeriod({ id: 'vac', kind: 'VACATION', recurrence: 'once', startDate: '2026-10-08', endDate: '2026-10-09' }),
    normalizeProtectedPeriod({ id: 'own', kind: 'OWN_TIME', recurrence: 'weekly', weekdays: [2], startTime: '18:00', endTime: '19:30' })
  ];
  const blocks = periodBlocks({ periods, from: MON, to: SUN, restStartFor: () => 22 * 60 });
  const byId = id => blocks.filter(b => b.periodId === id);
  assert.deepEqual(byId('eve').map(b => [b.date, b.time, b.endTime]), [[MON, '17:00', '22:00']]);
  assert.equal(byId('sun')[0].strength, 'soft');
  assert.equal(byId('sun')[0].time, '00:00');
  assert.deepEqual(byId('vac').map(b => b.date), ['2026-10-08', '2026-10-09']);
  assert.equal(byId('vac')[0].durationMinutes, 1440);
  assert.equal(byId('own')[0].blockKind, 'own_time');
  assert.ok(vacationOn(periods, '2026-10-08'));
  assert.equal(vacationOn(periods, MON), null);
  assert.equal(protectedPlanningHours({ blocks, from: MON, to: SUN }).vacationDays, 2);
});

test('viikon vähimmäisvapaa-aika: suojatut lohkot kattavat osan, loppu varataan ja jaetaan', () => {
  const periods = [
    normalizeProtectedPeriod({ id: 't', kind: 'FREE_TIME', recurrence: 'weekly_target', targetMinutes: 600 }),
    normalizeProtectedPeriod({ id: 'e', kind: 'FREE_TIME', recurrence: 'weekly', weekdays: [3], startTime: '18:00', endTime: '21:00' })
  ];
  const week = [MON, TUE, '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', SUN];
  const blocks = periodBlocks({ periods, from: MON, to: SUN });
  const reserve = weeklyFreeTimeReserve({ periods, blocks, weekDates: week });
  assert.deepEqual(reserve, { targetMinutes: 600, coveredMinutes: 180, reserveMinutes: 420 });
  const shares = distributeReserve(week.map((dateIso, i) => ({ dateIso, usableMinutes: 100 + i * 10 })), 420);
  assert.equal([...shares.values()].reduce((a, b) => a + b, 0), 420);
  assert.ok(shares.get(SUN) > shares.get(MON), 'suhteessa päivän tilaan');
});

test('vapaa-ajan säännöt: yksi arkkitehtuuri, edestakaisin ilman kaksoiskappaleita', () => {
  const rules = { minimumMinutes: 480, eveningWeekdays: [2, 4], eveningFrom: '17:30', sundayMostlyFree: true, cutoffTime: '20:00' };
  const periods = freeTimeRulePeriods(rules).map((p, i) => ({ ...p, id: `r${i}` }));
  assert.equal(periods.length, 4);
  assert.deepEqual(periods.map(ruleOf).sort(), [RULE.CUTOFF, RULE.EVENING, RULE.OTHER, RULE.SUNDAY].sort());
  assert.deepEqual(freeTimeRules(periods), { ...rules });
  const same = reconcileFreeTimeRules(periods, rules);
  assert.deepEqual([same.create.length, same.update.length, same.remove.length], [0, 0, 0]);
  const changed = reconcileFreeTimeRules(periods, { ...rules, cutoffTime: null, eveningFrom: '18:00' });
  assert.equal(changed.remove.length, 1);
  assert.equal(changed.update.length, 1);
  assert.match(describePeriod(periods.find(p => ruleOf(p) === RULE.CUTOFF)), /klo 20\.00 alkaen/);
  assert.match(describePeriod(periods.find(p => p.recurrence === 'weekly_target')), /8 h viikossa/);
});

// =====================================================================
// KAPASITEETTIJARRU
// =====================================================================

test('jarru: suojattu aika ja loma varataan ennen joustavaa työtä; kiinteä meno säilyy lomalla', () => {
  const own = periodBlocks({
    periods: [normalizeProtectedPeriod({ id: 'o', kind: 'OWN_TIME', recurrence: 'weekly', weekdays: [1], startTime: '09:00', endTime: '12:00' })],
    from: MON, to: MON
  });
  const base = dayCapacity({ tasks: [], profile: PROFILE, dateIso: MON, events: [], blocks: [] });
  const braked = dayCapacity({ tasks: [], profile: PROFILE, dateIso: MON, events: [], blocks: own });
  assert.equal(braked.ownTimeMinutes, 180);
  assert.ok(braked.usableMinutes < base.usableMinutes);

  const vac = periodBlocks({
    periods: [normalizeProtectedPeriod({ id: 'v', kind: 'VACATION', recurrence: 'once', startDate: MON, endDate: MON })],
    from: MON, to: MON
  });
  const fixed = task('dentist', { date: MON, time: '10:00', endTime: '11:00' });
  const vacation = dayCapacity({ tasks: [fixed], profile: PROFILE, dateIso: MON, events: [], blocks: vac });
  assert.equal(vacation.vacation, true);
  assert.equal(vacation.usableMinutes, 0, 'lomalla ei joustavaa aikaa');
  assert.equal(vacation.counts.fixed, 1, 'kiinteä meno lasketaan eikä katoa');

  const reserved = dayCapacity({ tasks: [], profile: PROFILE, dateIso: MON, events: [], blocks: [], reservedMinutes: 60 });
  assert.equal(reserved.reservedFreeMinutes, 60);
  assert.equal(reserved.usableMinutes, base.usableMinutes - 60);
});

test('jarru: suunnittelija ei sijoita lomalle eikä pääosin vapaaseen sunnuntaihin', () => {
  const periods = [
    normalizeProtectedPeriod({ id: 'v', kind: 'VACATION', recurrence: 'once', startDate: TUE, endDate: '2026-10-10' }),
    normalizeProtectedPeriod({ id: 's', kind: 'FREE_TIME', recurrence: 'weekly', weekdays: [7], strength: 'soft' })
  ];
  const blocks = periodBlocks({ periods, from: MON, to: SUN });
  const tasks = Array.from({ length: 10 }, (_, n) => task(`p${n}`, { durationMinutes: 120 }));
  const result = planHorizon({ tasks, profile: PROFILE, fromIso: MON, toIso: SUN, events: [], blocks });
  const dates = result.placements.map(p => p.toDateIso);
  assert.ok(dates.every(date => date === MON), `vain maanantai: ${dates}`);
  assert.ok(result.unplaced.length > 0, 'mikä ei mahdu, jää sijoittamatta eikä kasvata päivää');
});

test('jarru: täyttä päivää ei ylitetä (horisontin summa ei ylitä kapasiteettia)', () => {
  const tasks = Array.from({ length: 12 }, (_, n) => task(`q${n}`, { durationMinutes: 90 }));
  const result = planHorizon({ tasks, profile: PROFILE, fromIso: MON, toIso: TUE, events: [], blocks: [] });
  for (const day of result.days) assert.ok(day.remainingMinutes >= 0);
  const cap = horizonCapacity({ tasks: [], profile: PROFILE, fromIso: MON, toIso: TUE, events: [], blocks: [] });
  const placed = result.placements.reduce((sum, p) => sum + p.minutes, 0);
  assert.ok(placed <= cap.totalUsableMinutes);
});

// =====================================================================
// TEHTÄVÄ, VIIKKOSUUNNITELMA, RIVIT
// =====================================================================

test('päivätön tehtävä: sallittu vain horisontilla ja kun kanta tukee sitä', () => {
  const later = task('a', { horizon: 'LATER' });
  assert.equal(later.date, null);
  assert.equal(validateTask(later).valid, false, 'ennen 0015:tä päivä vaaditaan');
  assert.equal(validateTask(later, { allowDateless: true }).valid, true);
  assert.equal(validateTask(task('b', {}), { allowDateless: true }).valid, false, 'ilman horisonttia päivä vaaditaan');
  assert.equal(validateTask(task('c', { horizon: 'LATER', time: '10:00' }), { allowDateless: true }).valid, false);
  assert.equal(validateTask(normalizeTask({ title: 'x', date: MON, horizon: 'NOT_YET', waitingOn: 'A' })).valid, true,
    'waitingOn putoaa, kun horisontti ei ole WAITING');
  assert.equal(datelessTasksAllowed(), false, 'tuotehaaralla portti kiinni');
});

test('siirtojen seuranta ja myöhässä-sääntö', () => {
  const t = task('a', { date: MON });
  assert.deepEqual(reschedulePatch(t, TUE), { rescheduleCount: 1, originalDate: MON });
  assert.deepEqual(reschedulePatch({ ...t, rescheduleCount: 1, originalDate: '2026-10-01' }, TUE),
    { rescheduleCount: 2, originalDate: '2026-10-01' });
  assert.deepEqual(reschedulePatch(t, MON), {});
  assert.deepEqual(reschedulePatch({ ...t, completed: true }, TUE), {});
  assert.equal(isOverdue(task('w', { date: '2026-09-01', horizon: 'WAITING' }), MON), false);
  assert.equal(isOverdue(task('n', { date: '2026-09-01', horizon: 'NOT_YET' }), MON), false);
  assert.equal(isOverdue(task('o', { date: '2026-09-01' }), MON), true);
});

test('viikkosuunnitelma: enintään kolme prioriteettia, maanantai, kaksoiskappaleet pois', () => {
  const plan = normalizeWeeklyPlan({ weekStart: MON, priorities: [
    { ref: 'goal:g1', title: 'A' }, { ref: 'goal:g1', title: 'A2' }, { ref: 'text', title: 'Lepo' },
    { ref: 'task:t1', title: 'B' }, { ref: 'area:a', title: 'C' }, { ref: 'bad ref', title: 'D' }
  ] });
  assert.equal(plan.priorities.length, 5);
  assert.equal(plan.priorities.filter(p => p.ref === 'goal:g1').length, 1);
  assert.equal(validateWeeklyPlan(plan).valid, false);
  assert.equal(validateWeeklyPlan({ ...plan, priorities: plan.priorities.slice(0, WEEKLY_PRIORITY_LIMIT) }).valid, true);
  assert.equal(validateWeeklyPlan({ ...plan, weekStart: TUE, priorities: [] }).valid, false);
});

test('rivit: 0015-sarakkeet kirjoitetaan vain portin ollessa auki ja luetaan aina', () => {
  const closed = taskColumns(() => false);
  assert.ok(!closed.includes('horizon'));
  const open = taskColumns(gate => gate === 'MENTAL_LOAD_FIELDS' || gate === 'TASK_EXTENDED_FIELDS');
  for (const column of TASK_COLUMNS_MENTAL_LOAD) assert.ok(open.includes(column), column);
  const t = task('a', { horizon: 'WAITING', waitingOn: 'Anna', followUpDate: TUE, rescheduleCount: 2, originalDate: MON });
  const row = toRow(t, open);
  assert.equal(row.waiting_on, 'Anna');
  assert.equal(row.reschedule_count, 2);
  const back = normalizeTask(fromRow({ ...row, title: 'x' }));
  assert.equal(back.horizon, 'WAITING');
  assert.equal(back.followUpDate, TUE);
});

// =====================================================================
// SOVELLUSKERROS JA RAUHALLINEN TÄNÄÄN
// =====================================================================

test('lifeLoadFor muistaa tuloksen samalle tilalle ja päivälle', () => {
  setTasks([task('a', { date: MON })]);
  const one = lifeLoadFor(getState(), { todayIso: MON });
  assert.equal(lifeLoadFor(getState(), { todayIso: MON }), one);
  setTasks([task('a', { date: MON }), task('b', { date: MON })]);
  assert.notEqual(lifeLoadFor(getState(), { todayIso: MON }), one);
  assert.equal(focusTaskIds(lifeLoadFor(getState(), { todayIso: MON })).size, 2);
});

function stubElement(id) {
  return {
    id, innerHTML: '', textContent: '', value: '', checked: false, disabled: false, hidden: false,
    style: {}, dataset: {}, className: '',
    classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
    setAttribute() {}, getAttribute: () => null, removeAttribute() {},
    addEventListener() {}, removeEventListener() {}, focus() {}, scrollIntoView() {},
    querySelector: () => null, querySelectorAll: () => [], appendChild() {}, remove() {},
    closest: () => null, contains: () => false
  };
}

function installDom() {
  const ids = new Set([...read('index.html').matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
  const nodes = new Map();
  globalThis.document = {
    activeElement: null,
    getElementById(id) {
      if (!ids.has(id)) return null;
      if (!nodes.has(id)) nodes.set(id, stubElement(id));
      return nodes.get(id);
    },
    createElement: () => stubElement(null),
    querySelectorAll: () => [],
    body: { appendChild() {}, classList: { toggle() {} } }
  };
  globalThis.CSS = { escape: value => String(value) };
  return nodes;
}

afterEach(() => {
  delete globalThis.document;
  delete globalThis.CSS;
});

test('Rauhallinen tänään: enintään kolme fokusta, "Kaikki muu on tallessa (N)", ei kaksoisesiintymiä', async t => {
  freezeLocalDate(t, MON, '09:00');
  const nodes = installDom();
  const { renderToday } = await import('../src/app/views/today.js');
  setViewDate(new Date(2026, 9, 5));
  setTasks([
    ...[1, 2, 3, 4, 5, 6].map(n => task(`t${n}`, { date: MON, durationMinutes: 15, title: `Tehtävä ${n}` })),
    task('fixed', { date: MON, time: '14:00', endTime: '15:00', title: 'Hammaslääkäri' }),
    task('old', { date: '2026-09-30', durationMinutes: 15, title: 'Vanha asia' })
  ]);
  renderToday();
  const focus = nodes.get('todayFocus').innerHTML;
  assert.equal((focus.match(/class="focus-row"/g) || []).length, 3);
  assert.match(focus, /Kaikki muu on tallessa \(4\)\./);
  assert.match(focus, /Sinun ei tarvitse hoitaa sitä tänään\./);
  assert.doesNotMatch(focus, /Hammaslääkäri/, 'kiinteä meno ei ole fokuksessa');
  assert.doesNotMatch(nodes.get('todayUnscheduled').innerHTML, /Tehtävä \d/, 'Tänään ei ole koko jono');
  assert.doesNotMatch(nodes.get('todayOverdue').innerHTML, /class="task-row overdue"/, 'ei punaista rästilistaa');
});

test('Rauhallinen tänään: loma ja suojattu aika näkyvät omana osionaan', async t => {
  freezeLocalDate(t, MON, '09:00');
  const nodes = installDom();
  const { renderToday } = await import('../src/app/views/today.js');
  setViewDate(new Date(2026, 9, 5));
  setProtectedPeriods([
    { id: 'v', kind: 'VACATION', recurrence: 'once', startDate: MON, endDate: TUE },
    { id: 'o', kind: 'OWN_TIME', recurrence: 'weekly', weekdays: [1], startTime: '18:00', endTime: '19:00', title: 'Kitara' }
  ]);
  setTasks([task('a', { date: MON, durationMinutes: 30 })]);
  renderToday();
  const protectedHtml = nodes.get('todayProtected').innerHTML;
  assert.match(protectedHtml, /Lomalla\./);
  assert.match(protectedHtml, /Kitara/);
  assert.match(nodes.get('todayFocus').innerHTML, /Olet lomalla/);
  assert.doesNotMatch(nodes.get('todayTimelineContainer').innerHTML, /Kitara/, 'suojattu aika ei toistu aikajanalla');
});

test('Today-järjestys: fokus heti kirjauksen jälkeen, ennen aikajanaa', () => {
  const html = read('index.html');
  const at = id => html.indexOf(`id="${id}"`);
  assert.ok(at('captureBar') < at('todayFocus'));
  assert.ok(at('todayFocus') < at('todayNowNext'));
  assert.ok(at('todayFocus') < at('todayDeparture'));
  assert.ok(at('todayProtected') < at('todayTimelineContainer'));
  assert.ok(at('todayFocus') < at('todayHabits'));
});
