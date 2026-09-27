// Aalto L, L0: sovituksen korjaukset ja niiden regressiotestit.
//
// Jokainen testi nimeää korjatun löydöksen (docs/MENTAL-LOAD-CORE.md):
//
//   1. planHorizon laski automaatin ajastaman tehtävän kahdesti
//   2. tekoälysuunnitelma ei saanut Suunnan rajoja eikä suojattua aikaa
//   3. tauolla olevan tavoitteen tehtävät vuotivat suunnitteluun
//   4. Saapuvien "Käsittele" avasi kortin vain Tänään-näkymään
//   5. sleepAffectsCapacity ei vaikuttanut mihinkään
//   6. suunnittelun puskuri ei päätynyt laskentaan
//   7. päivän uudelleensuunnittelu siirsi täydelle päivälle
//   8. viikkokatsauksen +7 pv siirto ei katsonut kohdeviikkoa

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { read } from './helpers/sources.mjs';
import { planHorizon, PLACEMENT } from '../src/domain/planScheduler.js';
import { horizonCapacity, dayCapacity, sleepAdjustRatio, normalizeBufferRatio } from '../src/domain/capacity.js';
import { normalizeTask } from '../src/domain/task.js';
import { buildPlanningContext } from '../src/ai/planSchema.js';
import { planRequestContext, PLAN_CONTEXT_FIELDS } from '../src/app/planning.js';
import { replanDay, REPLAN_CHANGE } from '../src/domain/dayReplan.js';
import { INTERRUPTION_KIND } from '../src/domain/interruptions.js';
import { proposeAdjustments, ADJUSTMENT } from '../src/domain/alignmentReview.js';
import { previewAdjustments } from '../src/domain/rebalance.js';
import { taskPatch } from '../src/app/dayReplanActions.js';
import {
  resetState, getState, setTasks, setProfile, setLifeSettings, setSleepLogs, setPendingCapture
} from '../src/app/state.js';
import { planningBufferRatio, sleepShortfallsFor } from '../src/app/capacityBrake.js';
import { setDevicePreference } from '../src/data/preferences.js';
import { normalizeLifeSettings } from '../src/domain/lifeSettings.js';

const PROFILE = { sleepTargetHours: 8, defaultWakeTime: '07:00', commuteMinutes: 0, routineMinutes: 0 };
const MONDAY = '2026-10-05';

afterEach(() => {
  resetState();
  delete globalThis.localStorage;
  delete globalThis.document;
});

// ------------------------------------------------------------------ 1

test('L0-1 planHorizon: automaatin ajastama tehtävä ei kuluta päivää kahdesti', () => {
  const auto = normalizeTask({
    id: 't-auto', title: 'Raportti', date: MONDAY, time: '10:00', durationMinutes: 60, schedulingState: 'auto'
  });
  const withoutTask = horizonCapacity({ tasks: [], profile: PROFILE, fromIso: MONDAY, toIso: MONDAY });
  const result = planHorizon({ tasks: [auto], profile: PROFILE, fromIso: MONDAY, toIso: MONDAY });
  const day = result.days[0];
  // Päivän käytettävä aika = sama kuin ilman tehtävää; sijoitus vähentää 60 min kerran.
  assert.equal(day.usableMinutes, withoutTask.days[0].usableMinutes);
  assert.equal(day.remainingMinutes, withoutTask.days[0].usableMinutes - 60);
  assert.equal(result.placements[0].result, PLACEMENT.KEPT);
});

test('L0-1 planHorizon: kiinteä tehtävä on yhä maastoa (varattu, ei ehdokas)', () => {
  const fixed = normalizeTask({ id: 't-fixed', title: 'Palaveri', date: MONDAY, time: '09:00', endTime: '11:00' });
  const result = planHorizon({ tasks: [fixed], profile: PROFILE, fromIso: MONDAY, toIso: MONDAY });
  const empty = horizonCapacity({ tasks: [], profile: PROFILE, fromIso: MONDAY, toIso: MONDAY });
  assert.equal(result.placements.length, 0);
  assert.ok(result.days[0].usableMinutes < empty.days[0].usableMinutes);
});

// ------------------------------------------------------------------ 2

test('L0-2 suunnittelupyyntö: Suunnan rajat ja suojattu aika lähtevät mallille lukuina', () => {
  const context = buildPlanningContext({
    goals: [{ id: 'g', status: 'active', targetDate: null }],
    capacity: { dayCount: 7, totalUsableMinutes: 7 * 120 },
    todayIso: MONDAY,
    alignmentConstraints: {
      remainingHours: 6, unestimatedCount: 2, heavyRemainingHours: 3, protectedHours: 4,
      neglectedImportantAreaCount: 1
    },
    protectedTime: { personalHoursPerWeek: 9.5, vacationDays: 3 }
  });
  const body = planRequestContext(context);
  assert.deepEqual(Object.keys(body).sort(), [...PLAN_CONTEXT_FIELDS].filter(f => f !== 'nearestDeadlineDays').sort());
  assert.equal(body.protectedHours, 4);
  assert.equal(body.remainingWeeklyHours, 6);
  assert.equal(body.protectedPersonalHoursPerWeek, 9.5);
  assert.equal(body.vacationDays, 3);
  // Palvelin hyväksyy täsmälleen nämä kentät (ei nimiä eikä otsikoita).
  const validator = read('api/_validatePlan.js');
  for (const field of PLAN_CONTEXT_FIELDS) assert.match(validator, new RegExp(`${field}:`), field);
});

test('L0-2 suunnittelupyynnön runko käyttää koko kontekstia, ei vain kolmea kenttää', () => {
  const code = read('src/app/planning.js');
  assert.match(code, /context: planRequestContext\(context\)/);
  assert.match(code, /brakedHorizonCapacity\(/);
});

// ------------------------------------------------------------------ 3

test('L0-3 tauolla olevan tavoitteen tehtävä ei ole suunnittelun ehdokas', () => {
  const goals = [{ id: 'g-paused', status: 'paused' }, { id: 'g-active', status: 'active' }];
  const tasks = [
    normalizeTask({ id: 'p', title: 'Tauolla', date: MONDAY, goalId: 'g-paused', durationMinutes: 30 }),
    normalizeTask({ id: 'a', title: 'Aktiivinen', date: MONDAY, goalId: 'g-active', durationMinutes: 30 })
  ];
  const result = planHorizon({ tasks, goals, profile: PROFILE, fromIso: MONDAY, toIso: '2026-10-11' });
  const ids = [...result.placements.map(p => p.taskId), ...result.unplaced.map(u => u.task.id)];
  assert.deepEqual(ids, ['a']);
});

test('L0-3 odottava, "ei vielä" ja arkistoitu eivät kuulu suunnitteluun', () => {
  const tasks = [
    normalizeTask({ id: 'w', title: 'Odottaa', date: MONDAY, horizon: 'WAITING', waitingOn: 'Anna' }),
    normalizeTask({ id: 'n', title: 'Ei vielä', date: MONDAY, horizon: 'NOT_YET' }),
    normalizeTask({ id: 'x', title: 'Arkisto', date: MONDAY, archivedAt: '2026-10-01T10:00:00Z' }),
    normalizeTask({ id: 'ok', title: 'Tehtävä', date: MONDAY })
  ];
  const result = planHorizon({ tasks, profile: PROFILE, fromIso: MONDAY, toIso: MONDAY });
  assert.deepEqual(result.placements.map(p => p.taskId), ['ok']);
});

test('L0-3 Suunnittelu-näkymän jäljellä oleva työ käyttää samaa sijoitettavuussääntöä', () => {
  const code = read('src/app/views/planning.js');
  assert.match(code, /isSchedulable\(task, schedCtx\)/);
  assert.match(code, /projects: state\.projects/);
});

// ------------------------------------------------------------------ 4

function installDom(ids) {
  const nodes = new Map();
  globalThis.document = {
    getElementById(id) {
      if (!ids.has(id)) return null;
      if (!nodes.has(id)) {
        nodes.set(id, {
          id, innerHTML: '', textContent: '', value: '', style: {}, dataset: {},
          setAttribute() {}, getAttribute: () => null, addEventListener() {}, querySelectorAll: () => []
        });
      }
      return nodes.get(id);
    }
  };
  return nodes;
}

test('L0-4 Saapuvien "Käsittele" näyttää tarkistuskortin myös Saapuvissa', async () => {
  const html = read('index.html');
  assert.match(html, /id="inboxPending"/);
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
  const nodes = installDom(ids);
  const { renderInbox } = await import('../src/app/views/inbox.js');
  setPendingCapture({ itemId: 'i1', text: 'Soita Annalle', description: 'Luo tehtävä "Soita Annalle"', route: { kind: 'task' } });
  renderInbox();
  assert.match(nodes.get('inboxPending').innerHTML, /review-card/);
  assert.match(nodes.get('capturePending').innerHTML, /review-card/);
});

// ------------------------------------------------------------------ 5

test('L0-5 unen vaje keventää päivää vain, kun asetus on päällä', () => {
  assert.equal(sleepAdjustRatio(0), 0);
  assert.equal(sleepAdjustRatio(60), 0.1);
  assert.equal(sleepAdjustRatio(600), 0.3);
  const base = dayCapacity({ tasks: [], profile: PROFILE, dateIso: MONDAY, events: [], blocks: [] });
  const tired = dayCapacity({ tasks: [], profile: PROFILE, dateIso: MONDAY, events: [], blocks: [], sleepShortfallMinutes: 120 });
  assert.ok(tired.usableMinutes < base.usableMinutes);
  assert.equal(tired.sleepAdjustMinutes, Math.round((base.rawFreeMinutes - base.bufferMinutes) * 0.2));

  setProfile(PROFILE, true);
  setSleepLogs([{ id: 's1', wakeDate: MONDAY, actualBedtime: '01:00', actualWake: '06:00' }]);
  assert.equal(sleepShortfallsFor(getState(), [MONDAY]).size, 0, 'asetus pois: ei vaikutusta');
  setLifeSettings([normalizeLifeSettings({ id: 'ls', sleepAffectsCapacity: true })]);
  assert.equal(sleepShortfallsFor(getState(), [MONDAY]).get(MONDAY), 180);
});

// ------------------------------------------------------------------ 6

test('L0-6 käyttäjän puskuri päätyy laskentaan (laite, kun tilin sarake ei ole käytössä)', () => {
  const store = new Map();
  globalThis.localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k)
  };
  assert.equal(planningBufferRatio(getState()), 0.25);
  setDevicePreference('planningBufferRatio', 0.5);
  assert.equal(planningBufferRatio(getState()), 0.5);
  setDevicePreference('planningBufferRatio', 5);
  assert.equal(planningBufferRatio(getState()), 0.9, 'rajataan 0–0,9');
  assert.equal(normalizeBufferRatio(-1), 0);
  const loose = horizonCapacity({ tasks: [], profile: PROFILE, fromIso: MONDAY, toIso: MONDAY, bufferRatio: 0.1 });
  const tight = horizonCapacity({ tasks: [], profile: PROFILE, fromIso: MONDAY, toIso: MONDAY, bufferRatio: 0.5 });
  assert.ok(tight.totalUsableMinutes < loose.totalUsableMinutes);
});

test('L0-6 puskuri kulkee kaikille kapasiteetin kutsujille jarrun kautta', () => {
  for (const file of ['src/app/planning.js', 'src/app/views/planning.js', 'src/app/dayReplanActions.js',
    'src/app/actions.js', 'src/app/assistantActions.js']) {
    const code = read(file);
    assert.match(code, /brakeInputs\(|brakedHorizonCapacity\(/, file);
  }
  assert.match(read('src/data/profileRepo.js'), /planning_buffer_ratio/);
});

// ------------------------------------------------------------------ 7

function planWith(items) {
  return { dateIso: MONDAY, items, range: { start: 420, end: 1380 } };
}

test('L0-7 loppujen siirto: täydelle päivälle ei siirretä; seuraava päivä jolla on tilaa', () => {
  const task = normalizeTask({ id: 't1', title: 'Kirje', date: MONDAY, durationMinutes: 60 });
  const common = {
    plan: planWith([]), tasks: [task], todayIso: MONDAY, nowMinutes: 600,
    interruption: { kind: INTERRUPTION_KIND.DEFER_REMAINING }
  };
  const full = replanDay({ ...common, days: [{ date: '2026-10-06', usableMinutes: 0 }, { date: '2026-10-07', usableMinutes: 90 }] });
  const deferred = full.changes.find(c => c.taskId === 't1');
  assert.equal(deferred.kind, REPLAN_CHANGE.DEFER);
  assert.equal(deferred.to.date, '2026-10-07');

  const noRoom = replanDay({ ...common, days: [{ date: '2026-10-06', usableMinutes: 0 }, { date: '2026-10-07', usableMinutes: 20 }] });
  assert.equal(noRoom.changes.filter(c => c.taskId === 't1').length, 0, 'ei siirtoa täydelle päivälle');
  assert.ok(noRoom.warnings.some(w => /ei siirretty täydelle päivälle/.test(w)));

  const later = replanDay({ ...common, laterAllowed: true, days: [{ date: '2026-10-06', usableMinutes: 0 }] });
  const toLater = later.changes.find(c => c.taskId === 't1');
  assert.equal(toLater.to.date, null);
  assert.equal(toLater.to.horizon, 'LATER');
  assert.deepEqual(taskPatch(toLater, task), { date: null, time: null, endTime: null, horizon: 'LATER' });
});

test('L0-7 ohitus: ajaton tehtävä siirtyy vain päivälle, jolle se mahtuu', () => {
  const task = normalizeTask({ id: 't2', title: 'Imurointi', date: MONDAY, durationMinutes: 45 });
  const result = replanDay({
    plan: planWith([]), tasks: [task], todayIso: MONDAY, nowMinutes: 600,
    interruption: { kind: INTERRUPTION_KIND.SKIP_ITEM, targetId: 't2' },
    days: [{ date: '2026-10-06', usableMinutes: 30 }, { date: '2026-10-07', usableMinutes: 60 }]
  });
  const change = result.changes.find(c => c.taskId === 't2');
  assert.equal(change.kind, REPLAN_CHANGE.DEFER);
  assert.equal(change.to.date, '2026-10-07');
});

// ------------------------------------------------------------------ 8

function overloadedNextWeek() {
  const items = [
    { kind: 'task', id: 'a', minutes: 120, date: '2026-10-12', completed: false, areaId: null },
    { kind: 'task', id: 'b', minutes: 120, date: '2026-10-13', completed: false, areaId: null }
  ];
  const analysis = {
    weekStart: MONDAY, nextWeekStart: '2026-10-12', signals: [], progress: { state: 'during', fraction: 0.5 },
    capacity: { declared: true, availableMinutes: 60 }, actual: { minutes: 0, entryCount: 0 }, tracking: null
  };
  const next = { planned: { knownMinutes: 240, unknownCount: 0 }, items };
  const tasks = items.map(item => normalizeTask({ id: item.id, title: item.id, date: item.date, durationMinutes: item.minutes }));
  return { analysis, next, tasks };
}

test('L0-8 viikkokatsaus: siirto viikolla eteenpäin vain, jos kohdeviikolla on tilaa', () => {
  const { analysis, next, tasks } = overloadedNextWeek();
  const base = { tasks, nextWeekAnalysis: next, nextCapacity: { availableMinutes: 60 } };
  const unknown = proposeAdjustments(analysis, base).find(p => p.type === ADJUSTMENT.POSTPONE_TASKS);
  assert.equal(unknown.payload.taskIds.length, 2, 'ei tietoa kohdeviikosta: vanha käytös');

  const tight = proposeAdjustments(analysis, { ...base, destinationRoomMinutes: 130 })
    .find(p => p.type === ADJUSTMENT.POSTPONE_TASKS);
  assert.equal(tight.payload.taskIds.length, 1, 'vain yksi mahtuu kohdeviikolle');
  assert.deepEqual(tight.payload.laterTaskIds, []);

  const later = proposeAdjustments(analysis, { ...base, destinationRoomMinutes: 130, laterAllowed: true })
    .find(p => p.type === ADJUSTMENT.POSTPONE_TASKS);
  assert.equal(later.payload.taskIds.length, 1);
  assert.equal(later.payload.laterTaskIds.length, 1);
  assert.match(later.detail, /Myöhemmin/);

  const full = proposeAdjustments(analysis, { ...base, destinationRoomMinutes: 0 })
    .find(p => p.type === ADJUSTMENT.POSTPONE_TASKS);
  assert.equal(full, undefined, 'täydelle viikolle ei ehdoteta siirtoa');
});

test('L0-8 esikatselu näyttää "Myöhemmin"-siirron ilman päivää', () => {
  const tasks = [normalizeTask({ id: 'a', title: 'A', date: '2026-10-12', durationMinutes: 60 })];
  const preview = previewAdjustments({
    inputs: { weekStart: '2026-10-12', todayIso: MONDAY, areas: [], goals: [], projects: [], tasks,
      routines: [], exceptions: [], timeEntries: [], capacity: null, itemSettings: [] },
    proposals: [{ id: 'p', type: ADJUSTMENT.POSTPONE_TASKS, payload: { taskIds: [], laterTaskIds: ['a'], days: 7 } }]
  });
  assert.equal(preview.writes, 1);
  assert.equal(preview.after.plannedMinutes, 0);
});

test('L0-8 sovelluskerros laskee kohdeviikon tilan jarrusta', () => {
  const code = read('src/app/alignment.js');
  assert.match(code, /destinationRoomMinutes: weekRoomMinutes\(/);
  assert.match(code, /laterTaskIds/);
});
