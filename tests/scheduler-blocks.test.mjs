// Kalenteri aikataulumoottorissa: tapahtumat ja suojatut lohkot.
//
// Lukitsee integraation lupaukset (scheduler, capacity, conflicts, replan):
//   - tapahtuma on kiinteä: se ei koskaan päädy ehdokkaaksi eikä siirry
//   - lohko ei ole vapaata aikaa: vapaat välit ja ehdotukset kiertävät sen
//   - suojattu uni vain KAVENTAA valveillaoloikkunaa
//   - tänään ei ehdoteta mennyttä aikaa
//   - reflow siirtää vain automaattisesti sijoitettuja tehtäviä; käyttäjän
//     oma aika ei liiku koskaan
//   - kapasiteetti laskee varatun ajan unionina (ei kahdesti)
//   - ristiriidat: matka = estävä, uni = varoitus, tuntematon matka = tieto
//   - oletusarvoilla kaikki toimii täsmälleen kuten ennen
//   - lineaarinen kasvu, determinismi, ei syötteen muutoksia, ei kaatumista

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDayPlan, proposeSchedule, occupiedRanges, findCalendarCollisions, protectSleepRange,
  DEFAULT_PROFILE, MIN_USEFUL_SLOT_MINUTES
} from '../src/domain/scheduler.js';
import { dayCapacity, horizonCapacity, capacityUntil } from '../src/domain/capacity.js';
import {
  detectBlockConflicts, detectEventOverlaps, detectAllConflicts, detectDayOverload,
  CONFLICT, SEVERITY
} from '../src/domain/conflicts.js';
import { detectReplanTriggers, buildReplanProposal, REPLAN_TRIGGER } from '../src/domain/replan.js';
import { planHorizon } from '../src/domain/planScheduler.js';
import { expandEventOccurrences, absoluteMinutesOf, addDaysToIso } from '../src/domain/calendar.js';
import { deriveBlocks, BLOCK_KIND } from '../src/domain/calendarBlocks.js';
import { normalizeTask, toMinutes, SCHEDULING } from '../src/domain/task.js';
import { normalizeRoutine, RECURRENCE } from '../src/domain/routine.js';

// ------------------------------------------------------------------ apurit

const DAY = '2026-09-28'; // maanantai
const PREV = '2026-09-27';
const NEXT = '2026-09-29';

// Herätys 07:00, aamutoimet 07:00–08:00, nukkumaanmeno 23:00: ikkuna [420, 1380).
const profile = {
  ...DEFAULT_PROFILE, defaultWakeTime: '07:00', sleepTargetHours: 8, commuteMinutes: 30, routineMinutes: 60
};

const task = (over = {}) => normalizeTask({
  id: 't1', title: 'Tehtävä', date: DAY, priority: 'normaali', category: 'muu', ...over
});
const autoTask = over => task({ schedulingState: SCHEDULING.AUTO, ...over });

let eventSeq = 0;
const occurrences = (events, from = PREV, to = NEXT) => expandEventOccurrences({
  events: events.map(over => ({
    id: `e${++eventSeq}`, title: 'Tapahtuma', date: DAY, startTime: '10:00', durationMinutes: 60,
    recurrenceWeekdays: [], skipDates: [], ...over
  })),
  from, to
});

function departureFor({ travel = 30, overhead = 5, early = 10, prep = 15, only = null } = {}) {
  return occurrence => {
    if (only && !only.includes(occurrence.eventId)) return { known: false };
    const startAbs = absoluteMinutesOf(occurrence.date, toMinutes(occurrence.time));
    const leaveAbs = startAbs - early - overhead - travel;
    return {
      known: true, startAbs, leaveAbs, prepareStartAbs: leaveAbs - prep,
      travelMinutes: travel, overheadMinutes: overhead, earlyMinutes: early
    };
  };
}

const slotsOf = plan => plan.freeSlots.map(s => `${s.startTime}-${s.endTime}`);
const overlapsRange = (a, b) => a.start < b.end && b.start < a.end;

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

function seeded(seed) {
  return function random() {
    seed |= 0;
    seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function shuffle(list, random) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function counting(entity) {
  const wrapped = {};
  for (const key of Object.keys(entity)) {
    Object.defineProperty(wrapped, key, {
      enumerable: true,
      get() { counting.total += 1; return entity[key]; }
    });
  }
  return wrapped;
}
counting.total = 0;

const pad = n => String(n).padStart(2, '0');
const hhmm = minutes => `${pad(Math.floor(minutes / 60) % 24)}:${pad(minutes % 60)}`;

/** Satunnainen päivä: tehtäviä, rutiineja, tapahtumia (myös yön yli) ja lohkoja. */
function randomDay(random) {
  const pick = list => list[Math.floor(random() * list.length)];
  const int = (lo, hi) => lo + Math.floor(random() * (hi - lo + 1));

  const tasks = Array.from({ length: int(0, 8) }, (_, i) => {
    const timed = random() < 0.5;
    const start = int(6, 21) * 60 + pick([0, 15, 30, 45]);
    return normalizeTask({
      id: `t${i}`, title: `Tehtävä ${i}`, date: DAY,
      time: timed ? hhmm(start) : null,
      endTime: timed && random() < 0.5 ? hhmm(Math.min(start + pick([15, 30, 60, 90]), 1439)) : null,
      durationMinutes: pick([15, 30, 45, 60, 90, null]),
      schedulingState: timed && random() < 0.5 ? SCHEDULING.AUTO : undefined,
      priority: pick(['korkea', 'normaali', 'matala']),
      completed: random() < 0.15
    });
  });

  const routines = Array.from({ length: int(0, 3) }, (_, i) => normalizeRoutine({
    id: `r${i}`, title: `Rutiini ${i}`, active: true, durationMinutes: pick([15, 30, 45]),
    preferredTime: random() < 0.5 ? hhmm(int(7, 20) * 60) : null,
    recurrence: { type: RECURRENCE.DAILY }
  }));

  const events = occurrences(Array.from({ length: int(0, 5) }, () => {
    const start = int(0, 23) * 60 + pick([0, 20, 40]);
    const kind = random();
    return {
      date: pick([PREV, DAY, DAY, DAY]),
      startTime: kind < 0.15 ? null : hhmm(start),
      durationMinutes: kind < 0.3 ? null : pick([30, 60, 120, 300]),
      endTime: kind > 0.85 ? hhmm((start + pick([90, 240])) % 1440) : null,
      title: `Tapahtuma ${int(1, 99)}`,
      placeId: random() < 0.5 ? 'p1' : null
    };
  }));

  const blocks = deriveBlocks({
    occurrences: events,
    departureFor: departureFor({ travel: int(5, 90), overhead: int(0, 15), early: int(0, 20), prep: int(0, 30) }),
    sleepSchedules: random() < 0.7 ? [
      { date: PREV, bedtime: pick(['22:30', '23:00', '00:15']), wakeTime: pick(['06:30', '07:00', '07:45']) },
      { date: DAY, bedtime: pick(['21:45', '22:30', '23:30']), wakeTime: '07:00', windDownMinutes: int(0, 60) }
    ] : []
  });

  return { tasks, routines, events, blocks };
}

function forEachDay(count, fn, seed = 2026) {
  const random = seeded(seed);
  for (let i = 0; i < count; i++) fn(randomDay(random), random, i);
}

// =====================================================================
// PÄIVÄSUUNNITELMA
// =====================================================================

test('tapahtuma on kiinteä aikajanan merkintä eikä koskaan ehdokas', () => {
  const events = occurrences([{ title: 'Hammaslääkäri', startTime: '10:00', durationMinutes: 60 }]);
  const plan = buildDayPlan({ tasks: [], profile, dateIso: DAY, events });

  const item = plan.timeline.find(it => it.isEvent);
  assert.equal(item.time, '10:00');
  assert.equal(plan.unscheduled.length, 0);
  assert.equal(plan.events.length, 1);
  assert.equal(plan.eventItems.length, 1);
  assert.equal(plan.load.events, 1);
  assert.equal(plan.load.count, 0, 'tapahtuma ei ole tehtävä');
  assert.deepEqual(slotsOf(plan), ['08:00-10:00', '11:00-23:00']);
});

test('lohkot varaavat aikaa: matka ja valmistautuminen eivät ole vapaata', () => {
  const events = occurrences([{ title: 'Hammaslääkäri', startTime: '10:00', durationMinutes: 60 }]);
  const blocks = deriveBlocks({ occurrences: events, departureFor: departureFor() });
  const plan = buildDayPlan({ tasks: [], profile, dateIso: DAY, events, blocks });

  assert.deepEqual(plan.blocks.map(b => b.kind),
    ['preparation', 'travel', 'overhead', 'arrival_buffer']);
  assert.ok(plan.blocks.every(b => plan.timeline.includes(b)), 'lohkot kuuluvat aikajanaan');
  assert.deepEqual(slotsOf(plan), ['08:00-09:00', '11:00-23:00']);
  assert.equal(plan.load.blocks, 4);
});

test('edellisenä iltana alkanut tapahtuma varaa aamun', () => {
  const early = { ...profile, defaultWakeTime: '00:30', routineMinutes: 15 };
  const events = occurrences([{ date: PREV, title: 'Yökeikka', startTime: '22:00', endTime: '01:30' }]);
  const plan = buildDayPlan({ tasks: [], profile: early, dateIso: DAY, events });

  const tail = plan.timeline.find(it => it.continuation);
  assert.equal(tail.id, `event:${events[0].eventId}:${PREV}:jatkuu`);
  assert.equal(tail.time, '00:00');
  assert.equal(tail.endTime, '01:30');
  assert.equal(tail.startedOn, PREV);
  assert.equal(plan.events.length, 0, 'esiintymä alkoi eilen');
  assert.equal(plan.freeSlots[0].startTime, '01:30');
});

test('koko päivän tapahtuma ei varaa kellonaikaa', () => {
  const events = occurrences([{ title: 'Nimipäivä', startTime: null, durationMinutes: null }]);
  const withEvent = buildDayPlan({ tasks: [], profile, dateIso: DAY, events });
  const without = buildDayPlan({ tasks: [], profile, dateIso: DAY });
  assert.deepEqual(withEvent.freeSlots, without.freeSlots);
  assert.deepEqual(withEvent.allDayEvents.map(o => o.title), ['Nimipäivä']);
  assert.equal(withEvent.timeline.some(it => it.isEvent), false);
});

test('suojattu uni kaventaa valveillaoloikkunaa, ei koskaan levennä', () => {
  const blocks = deriveBlocks({ sleepSchedules: [
    { date: PREV, bedtime: '23:30', wakeTime: '07:30' },
    { date: DAY, bedtime: '22:00', wakeTime: '06:00', windDownMinutes: 30 }
  ] });
  const plan = buildDayPlan({ tasks: [], profile, dateIso: DAY, blocks });
  assert.equal(plan.range.start, 450, 'uni jatkuu 07:30 asti');
  assert.equal(plan.range.end, 1320, 'uni alkaa 22:00');
  assert.equal(plan.range.sleepProtected, true);
  assert.equal(plan.timeline.some(it => it.id === 'virtual-sleep'), false, 'uni ei näy kahdesti');
  assert.deepEqual(slotsOf(plan).at(-1), '08:00-21:30', 'rauhoittuminen 21:30–22:00 ei ole vapaata');

  const wider = deriveBlocks({ sleepSchedules: [
    { date: PREV, bedtime: '22:00', wakeTime: '05:00' },
    { date: DAY, bedtime: '23:59', wakeTime: '09:00', windDownMinutes: 0 }
  ] });
  const narrowOnly = buildDayPlan({ tasks: [], profile, dateIso: DAY, blocks: wider });
  assert.equal(narrowOnly.range.start, 420, 'aikaisempi herätys ei levennä ikkunaa');
  assert.equal(narrowOnly.range.end, 1380, 'myöhäisempi nukkumaanmeno ei levennä ikkunaa');

  // Suora apufunktio: ilman unilohkoa sama olio palautetaan.
  const range = { start: 420, end: 1380 };
  assert.equal(protectSleepRange(range, []), range);
});

test('oletusarvoilla päiväsuunnitelma ja ehdotukset ovat täsmälleen ennallaan', () => {
  const tasks = [task({ id: 'a', time: '09:00', endTime: '10:00' }), task({ id: 'b', durationMinutes: 45 })];
  const routines = [normalizeRoutine({ id: 'r', title: 'R', preferredTime: '12:00', recurrence: { type: RECURRENCE.DAILY } })];
  const base = buildDayPlan({ tasks, profile, dateIso: DAY, routines, todayIso: DAY });
  const empty = buildDayPlan({ tasks, profile, dateIso: DAY, routines, todayIso: DAY, events: [], blocks: [] });
  assert.deepEqual(empty, base);
  assert.equal('sleepProtected' in base.range, false);
  assert.deepEqual(
    proposeSchedule({ tasks, profile, dateIso: DAY, routines, todayIso: DAY, events: [], blocks: [] }),
    proposeSchedule({ tasks, profile, dateIso: DAY, routines, todayIso: DAY }));
});

test('INVARIANTTI: vapaat välit eivät osu varattuun ja pysyvät ikkunassa (tapahtumat ja lohkot mukana)', () => {
  forEachDay(150, ({ tasks, routines, events, blocks }) => {
    const plan = buildDayPlan({ tasks, profile, dateIso: DAY, routines, events, blocks, todayIso: DAY });
    const busy = occupiedRanges(plan.timeline.filter(it => it.id !== 'virtual-sleep'));
    for (const slot of plan.freeSlots) {
      assert.ok(slot.minutes >= MIN_USEFUL_SLOT_MINUTES);
      assert.ok(slot.start >= plan.range.start && slot.end <= plan.range.end, 'vapaa väli ikkunan ulkopuolella');
      for (const range of busy) assert.equal(overlapsRange(slot, range), false, `${slot.startTime} osuu varattuun`);
    }
    let previous = -1;
    for (const item of plan.timeline) {
      const minutes = toMinutes(item.time);
      assert.ok(minutes >= previous, 'aikajana ei ole järjestyksessä');
      previous = minutes;
    }
  });
});

// =====================================================================
// EHDOTUKSET
// =====================================================================

test('ehdotus kiertää tapahtuman ja sen lähdön', () => {
  const events = occurrences([{ title: 'Hammaslääkäri', startTime: '10:00', durationMinutes: 60 }]);
  const blocks = deriveBlocks({ occurrences: events, departureFor: departureFor() });
  const { proposals } = proposeSchedule({
    tasks: [task({ id: 'long', title: 'Raportti', durationMinutes: 90 }), task({ id: 'short', title: 'Puhelu', durationMinutes: 30 })],
    profile, dateIso: DAY, events, blocks
  });
  const byId = Object.fromEntries(proposals.map(p => [p.taskId, p]));
  assert.equal(byId.long.time, '11:00', '90 min ei mahdu 08:00–09:00 väliin');
  assert.equal(byId.short.time, '08:00');
});

test('INVARIANTTI: ehdotus ei osu tapahtumaan, lohkoon eikä käyttäjän omaan aikaan', () => {
  forEachDay(150, ({ tasks, routines, events, blocks }) => {
    const plan = buildDayPlan({ tasks, profile, dateIso: DAY, routines, events, blocks, todayIso: DAY });
    const manual = new Set(tasks.filter(t => t.time && t.schedulingState !== SCHEDULING.AUTO).map(t => t.id));
    for (const reflow of [false, true]) {
      const { proposals, reflowed } = proposeSchedule({
        tasks, profile, dateIso: DAY, routines, events, blocks, todayIso: DAY, reflow
      });
      // Siirrettävän tehtävän vanha aika vapautuu; kaikki muu varattu pysyy varattuna.
      const moved = new Set(reflowed);
      const guards = occupiedRanges(plan.timeline.filter(it => it.id !== 'virtual-sleep' && !moved.has(it.id)));
      const placed = [];
      for (const proposal of proposals) {
        assert.equal(manual.has(proposal.taskId), false, 'käyttäjän itse ajastama siirtyisi');
        const range = { start: toMinutes(proposal.time), end: toMinutes(proposal.time) + proposal.durationMinutes };
        for (const guard of guards) assert.equal(overlapsRange(range, guard), false, `${proposal.time} osuu varattuun`);
        for (const other of placed) assert.equal(overlapsRange(range, other), false, 'ehdotukset päällekkäin');
        assert.ok(range.start >= plan.range.start && range.end <= plan.range.end);
        placed.push(range);
      }
      if (!reflow) assert.deepEqual(reflowed, []);
    }
  });
});

test('tänään ei ehdoteta mennyttä aikaa; raja pyöristyy seuraavaan viiteen minuuttiin', () => {
  const tasks = [task({ id: 'a', durationMinutes: 30 }), task({ id: 'b', title: 'B', durationMinutes: 30 })];
  const { proposals } = proposeSchedule({ tasks, profile, dateIso: DAY, todayIso: DAY, nowMinutes: 13 * 60 + 2 });
  assert.deepEqual(proposals.map(p => p.time), ['13:05', '13:35']);

  const past = proposeSchedule({ tasks, profile, dateIso: PREV, todayIso: DAY, nowMinutes: 600 });
  assert.equal(past.proposals.length, 0, 'mennyt päivä: ei ehdotuksia');
  assert.equal(past.unplaced.length, 0, 'eilisen tehtävät eivät ole tämän päivän listalla');

  const future = proposeSchedule({ tasks: tasks.map(t => ({ ...t, date: NEXT })), profile, dateIso: NEXT, todayIso: DAY, nowMinutes: 1300 });
  assert.equal(future.proposals[0].time, '08:00', 'huominen ei riipu kellosta');

  const noToday = proposeSchedule({ tasks, profile, dateIso: DAY, nowMinutes: 600 });
  assert.equal(noToday.proposals[0].time, '10:00', 'ilman todayIso-päivää katsottu päivä on tämä päivä');

  const late = proposeSchedule({ tasks, profile, dateIso: DAY, todayIso: DAY, nowMinutes: 23 * 60 });
  assert.equal(late.proposals.length, 0);
  assert.equal(late.unplaced.length, 2, 'ei tilaa = jää listaan, ei katoa');

  const reference = proposeSchedule({ tasks, profile, dateIso: DAY, todayIso: DAY });
  for (const garbage of [null, undefined, NaN, Infinity, '12:00', {}, true]) {
    assert.deepEqual(proposeSchedule({ tasks, profile, dateIso: DAY, todayIso: DAY, nowMinutes: garbage }), reference);
  }
});

test('reflow: automaattisesti sijoitettu tehtävä siirtyy pois matkan alta, käyttäjän oma ei', () => {
  const events = occurrences([{ title: 'Hammaslääkäri', startTime: '10:00', durationMinutes: 60 }]);
  const blocks = deriveBlocks({ occurrences: events, departureFor: departureFor() });
  const moving = autoTask({ id: 'auto', title: 'Sähköpostit', time: '09:15', endTime: '09:45' });
  const intoEvent = autoTask({ id: 'auto2', title: 'Lasku', time: '10:30', endTime: '10:45' });
  const fine = autoTask({ id: 'auto3', title: 'Lenkki', time: '14:00', endTime: '14:30' });
  const mine = task({ id: 'mine', title: 'Oma', time: '09:20', endTime: '09:40' });
  const tomorrow = autoTask({ id: 'tomorrow', date: NEXT, time: '09:15', endTime: '09:45' });
  const tasks = [moving, intoEvent, fine, mine, tomorrow];

  const result = proposeSchedule({ tasks, profile, dateIso: DAY, events, blocks, reflow: true });
  assert.deepEqual(result.reflowed, ['auto', 'auto2']);
  const moved = result.proposals.find(p => p.taskId === 'auto');
  assert.equal(moved.reflow, true);
  assert.equal(moved.fromTime, '09:15');
  assert.equal(moved.fromEndTime, '09:45');
  assert.equal(moved.durationMinutes, 30, 'kesto säilyy');
  assert.match(moved.reason, /Aiempi aika klo 09:15 osui matkaan/);
  assert.match(result.proposals.find(p => p.taskId === 'auto2').reason, /Aiempi aika klo 10:30 osui tapahtumaan "Hammaslääkäri"/);
  assert.ok(!result.proposals.some(p => ['mine', 'auto3', 'tomorrow'].includes(p.taskId)));

  const off = proposeSchedule({ tasks, profile, dateIso: DAY, events, blocks });
  assert.deepEqual(off.reflowed, []);
  assert.equal(off.proposals.some(p => p.taskId === 'auto'), false, 'ilman reflow-lupaa mitään ei siirretä');
});

test('reflow: tilaa vailla jäävä tehtävä raportoidaan alkuperäisenä', () => {
  const events = occurrences([{ title: 'Koko päivän koulutus', startTime: '08:00', endTime: '23:00' }]);
  const stuck = autoTask({ id: 'stuck', title: 'Jumissa', time: '12:00', endTime: '13:00' });
  const result = proposeSchedule({ tasks: [stuck], profile, dateIso: DAY, events, reflow: true });
  assert.equal(result.proposals.length, 0);
  assert.equal(result.unplaced[0], stuck, 'sama olio, ei irrotettu kopio');
  assert.deepEqual(result.reflowed, ['stuck']);
});

test('ehdotukset ovat deterministisiä, vaikka tapahtumat ja lohkot tulisivat eri järjestyksessä', () => {
  const random = seeded(31);
  forEachDay(60, ({ tasks, routines, events, blocks }) => {
    const reference = proposeSchedule({ tasks, profile, dateIso: DAY, routines, events, blocks, todayIso: DAY, reflow: true });
    const again = proposeSchedule({
      tasks, profile, dateIso: DAY, routines, todayIso: DAY, reflow: true,
      events: shuffle(events, random), blocks: shuffle(blocks, random)
    });
    assert.deepEqual(again, reference);
    const plan = buildDayPlan({ tasks, profile, dateIso: DAY, routines, events, blocks });
    const shuffled = buildDayPlan({ tasks, profile, dateIso: DAY, routines, events: shuffle(events, random), blocks: shuffle(blocks, random) });
    assert.deepEqual(shuffled.timeline.map(i => i.id), plan.timeline.map(i => i.id));
    assert.deepEqual(shuffled.freeSlots, plan.freeSlots);
  }, 77);
});

test('kesäajan vaihtopäivä näyttää saman seinäkellorakenteen kuin tavallinen sunnuntai', () => {
  const scenario = date => {
    const prev = addDaysToIso(date, -1);
    const events = expandEventOccurrences({
      events: [
        { id: 'aamu', title: 'Aamukokous', date, startTime: '03:30', durationMinutes: 60 },
        { id: 'ilta', title: 'Konsertti', date, startTime: '19:00', endTime: '21:00' }
      ],
      from: prev, to: date
    });
    const blocks = deriveBlocks({
      occurrences: events,
      departureFor: departureFor({ travel: 40, prep: 20, overhead: 5, early: 10 }),
      sleepSchedules: [
        { date: prev, bedtime: '23:00', wakeTime: '02:30' },
        { date, bedtime: '23:00', wakeTime: '07:00' }
      ]
    });
    const early = { ...profile, defaultWakeTime: '02:30', routineMinutes: 15 };
    const plan = buildDayPlan({ tasks: [], profile: early, dateIso: date, events, blocks });
    return {
      slots: slotsOf(plan),
      blocks: plan.blocks.map(b => `${b.kind} ${b.time}-${b.endTime}`),
      range: [plan.range.start, plan.range.end]
    };
  };
  assert.deepEqual(scenario('2026-03-29'), scenario('2026-03-22'), 'kevään vaihto');
  assert.deepEqual(scenario('2026-10-25'), scenario('2026-10-18'), 'syksyn vaihto');
  assert.ok(scenario('2026-03-29').blocks.some(b => b.startsWith('travel 02:')), 'matka osuu vaihtotunnille');
});

// =====================================================================
// KAPASITEETTI
// =====================================================================

test('kapasiteetti ilman kalenteria: vanha laskenta ennallaan', () => {
  const tasks = [task({ time: '09:00', endTime: '12:00' }), task({ id: 't2', time: '11:00', endTime: '12:00' })];
  const day = dayCapacity({ tasks, profile, dateIso: DAY });
  assert.equal(day.calendarAware, false);
  assert.equal(day.eventMinutes, null, 'ei annettu = ei laskettu, ei nolla');
  assert.equal(day.blockMinutes, null);
  assert.equal(day.awakeMinutes, 960);
  assert.equal(day.committedMinutes, 240, 'vanha laskenta summaa päällekkäisetkin');
  assert.equal(day.counts.events, 0);
});

test('KRIITTINEN: kalenteritietoinen kapasiteetti laskee varatun ajan unionina', () => {
  const events = occurrences([{ title: 'Hammaslääkäri', startTime: '10:00', durationMinutes: 60 }]);
  const blocks = deriveBlocks({ occurrences: events, departureFor: departureFor() });
  const tasks = [task({ id: 'meeting', time: '09:30', endTime: '10:30' })];
  const day = dayCapacity({ tasks, profile, dateIso: DAY, events, blocks, bufferRatio: 0 });

  assert.equal(day.calendarAware, true);
  assert.equal(day.eventMinutes, 60);
  assert.equal(day.blockMinutes, 60, 'valmistautuminen 09:00 – alku 10:00');
  assert.equal(day.fixedMinutes, 60);
  assert.equal(day.committedMinutes, 120, '09:00–11:00 kerran, ei 60 + 60 + 60');
  assert.equal(day.rawFreeMinutes, 960 - 120);
  assert.equal(day.usableMinutes, 840);
  assert.deepEqual({ ...day.counts }, { fixed: 1, flexible: 0, routines: 0, events: 1, blocks: 4 });
});

test('kapasiteetti: uni kaventaa valveillaoloa eikä vähennä samaa aikaa toiseen kertaan', () => {
  const blocks = deriveBlocks({ sleepSchedules: [
    { date: PREV, bedtime: '23:00', wakeTime: '07:00' },
    { date: DAY, bedtime: '22:00', wakeTime: '06:00', windDownMinutes: 30 }
  ] });
  const day = dayCapacity({ tasks: [], profile, dateIso: DAY, blocks, bufferRatio: 0 });
  assert.equal(day.awakeMinutes, 900, '07:00–22:00');
  assert.equal(day.blockMinutes, 30, 'vain rauhoittuminen on valveillaoloajassa');
  assert.equal(day.committedMinutes, 30);
  assert.equal(day.usableMinutes, 870);

  const outside = dayCapacity({
    tasks: [task({ time: '23:30', endTime: '23:45' })], profile, dateIso: DAY, events: [], bufferRatio: 0
  });
  assert.equal(outside.committedMinutes, 0, 'nukkumaanmenon jälkeinen merkintä ei syö valveillaoloa');
  assert.equal(outside.calendarAware, true, 'tyhjä taulukko on valinta kalenteritietoiseen laskentaan');
});

test('kapasiteetti: tapahtumat ja lohkot kulkevat horisontin, määräpäivän ja suunnittelun läpi', () => {
  const events = occurrences([
    { title: 'Koulutus', date: DAY, startTime: '08:00', endTime: '23:00', recurrenceWeekdays: [1, 2], recurrenceUntil: '2026-10-06' }
  ], DAY, '2026-10-11');
  const blocks = deriveBlocks({ occurrences: events, departureFor: departureFor() });

  const plain = horizonCapacity({ tasks: [], profile, fromIso: DAY, toIso: '2026-10-04' });
  const busy = horizonCapacity({ tasks: [], profile, fromIso: DAY, toIso: '2026-10-04', events, blocks });
  assert.equal(busy.dayCount, plain.dayCount);
  assert.ok(busy.days.every(d => d.calendarAware));
  assert.ok(busy.totalUsableMinutes < plain.totalUsableMinutes);
  assert.equal(busy.days[0].usableMinutes, 0, 'maanantai on koulutusta');
  assert.equal(busy.days[1].usableMinutes, 0);
  assert.equal(busy.days[2].usableMinutes, plain.days[2].usableMinutes, 'keskiviikko on vapaa');

  const until = capacityUntil({ tasks: [], profile, todayIso: DAY, deadlineIso: NEXT, events, blocks });
  assert.equal(until.totalUsableMinutes, 0);

  const flexible = task({ id: 'flex', title: 'Joustava', date: null, durationMinutes: 60 });
  const horizon = planHorizon({ tasks: [flexible], profile, fromIso: DAY, toIso: '2026-10-04', events, blocks });
  assert.equal(horizon.placements[0].toDateIso, '2026-09-30', 'kalenterin täyttämät päivät ohitetaan');
  assert.equal(planHorizon({ tasks: [flexible], profile, fromIso: DAY, toIso: '2026-10-04' }).placements[0].toDateIso, DAY);

  const replan = buildReplanProposal({ tasks: [flexible], profile, todayIso: DAY, horizonDays: 7, events, blocks });
  assert.equal(replan.changes[0].toDateIso, '2026-09-30');
});

test('päivän ahtaus laskee tapahtumat sitoumuksiksi', () => {
  const day = { dateIso: DAY, usableMinutes: 0, counts: { fixed: 2, flexible: 0, routines: 1, events: 5, blocks: 12 } };
  assert.equal(detectDayOverload([day]).length, 1);
  assert.equal(detectDayOverload([{ ...day, counts: { fixed: 2, flexible: 0, routines: 1 } }]).length, 0,
    'vanha kapasiteettiolio ilman tapahtumia lasketaan kuten ennen');
});

// =====================================================================
// RISTIRIIDAT
// =====================================================================

function travelScenario() {
  const events = occurrences([{ title: 'Hammaslääkäri', startTime: '10:00', durationMinutes: 60, placeId: 'p1' }]);
  const blocks = deriveBlocks({
    occurrences: events,
    departureFor: departureFor(),
    sleepSchedules: [{ date: DAY, bedtime: '23:00', wakeTime: '07:00', windDownMinutes: 30 }]
  });
  return { events, blocks };
}

test('KRIITTINEN: käyttäjän oma merkintä matkan päällä on estävä ristiriita', () => {
  const { events, blocks } = travelScenario();
  for (const [time, kind] of [['09:05', 'preparation'], ['09:20', 'travel'], ['09:46', 'overhead'], ['09:55', 'arrival_buffer']]) {
    const found = detectBlockConflicts({ tasks: [task({ time, durationMinutes: 5, title: 'Puhelu' })], events, blocks });
    assert.equal(found.length, 1, time);
    assert.equal(found[0].code, CONFLICT.TRAVEL_OVERLAP);
    assert.equal(found[0].severity, SEVERITY.BLOCKING);
    assert.equal(found[0].blockKind, kind);
    assert.deepEqual(found[0].taskIds, ['t1']);
    assert.match(found[0].message, /Et voi olla kahdessa paikassa yhtä aikaa\./);
    assert.match(found[0].message, /"Puhelu" \(2026-09-28 klo/);
  }
  const travel = detectBlockConflicts({ tasks: [task({ time: '09:20', durationMinutes: 5, title: 'Puhelu' })], events, blocks })[0];
  assert.match(travel.message, /jolloin olet matkalla tapahtumaan "Hammaslääkäri"/);
});

test('ristiriidat: automaattinen, valmis ja rajalla alkava eivät ole ristiriitoja', () => {
  const { events, blocks } = travelScenario();
  const tasks = [
    autoTask({ id: 'auto', time: '09:20', endTime: '09:40' }),
    task({ id: 'done', time: '09:20', endTime: '09:40', completed: true }),
    task({ id: 'edge', time: '08:30', endTime: '09:00' }),
    task({ id: 'after', time: '11:00', endTime: '11:30' })
  ];
  assert.deepEqual(detectBlockConflicts({ tasks, events, blocks }), []);
});

test('ristiriidat: yksi rivi per tapahtuma, vaikka merkintä osuisi moneen lohkoon', () => {
  const { events, blocks } = travelScenario();
  const found = detectBlockConflicts({ tasks: [task({ time: '09:00', endTime: '09:30' })], events, blocks });
  assert.equal(found.length, 1);
  assert.equal(found[0].blockKind, 'preparation');
  assert.equal(found[0].blockIds.length, 2);
});

test('ristiriidat: uni ja rauhoittuminen ovat varoituksia, päätös on käyttäjän', () => {
  const { events, blocks } = travelScenario();
  const late = detectBlockConflicts({ tasks: [task({ time: '22:40', endTime: '23:30', title: 'Elokuva' })], events, blocks });
  assert.equal(late.length, 1, 'rauhoittuminen ja uni samasta yöstä yhtenä rivinä');
  assert.equal(late[0].code, CONFLICT.REST_OVERLAP);
  assert.equal(late[0].severity, SEVERITY.WARNING);
  assert.match(late[0].message, /suojattuun uneen \(klo 23:00–00:00\)\. Päätös on sinun/);

  const windDown = detectBlockConflicts({ tasks: [task({ time: '22:35', endTime: '22:50' })], events, blocks });
  assert.match(windDown[0].message, /rauhoittumisaikaan ennen nukkumaanmenoa/);

  // Keskiyön yli jatkuva oma merkintä osuu seuraavan aamun uneen.
  const nextMorning = deriveBlocks({ sleepSchedules: [{ date: DAY, bedtime: '23:00', wakeTime: '07:00', windDownMinutes: 0 }] });
  const crossing = detectBlockConflicts({
    tasks: [task({ date: PREV, time: '23:30', endTime: '00:30' })], blocks: nextMorning.filter(b => b.date === DAY && b.startMinute === 1380)
  });
  assert.equal(crossing.length, 0, 'eilinen 23:30–00:30 ei osu tämän illan uneen');
  // Illan DAY suunnitelma, jossa nukkumaanmeno 00:10 = seuraavan päivän puolella.
  const tail = detectBlockConflicts({
    tasks: [task({ date: DAY, time: '23:30', endTime: '00:30' })],
    blocks: deriveBlocks({ sleepSchedules: [{ date: DAY, bedtime: '00:10', wakeTime: '07:00', windDownMinutes: 0 }] })
  });
  assert.equal(tail.length, 1, 'yön yli jatkuva osuu seuraavan päivän uneen');
  assert.equal(tail[0].dateIso, NEXT);
});

test('ristiriidat: tapahtuma toisen tapahtuman matkan päällä on estävä; oma lähtö ei ole ristiriita', () => {
  const events = occurrences([
    { title: 'Hammaslääkäri', startTime: '10:00', durationMinutes: 60 },
    { title: 'Kahvit', startTime: '09:00', durationMinutes: 30 }
  ]);
  const blocks = deriveBlocks({ occurrences: events, departureFor: departureFor({ only: [events.find(e => e.title === 'Hammaslääkäri').eventId] }) });
  const found = detectBlockConflicts({ tasks: [], events, blocks });
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, SEVERITY.BLOCKING);
  assert.deepEqual(found[0].occurrenceIds, [events.find(e => e.title === 'Kahvit').id]);
  assert.match(found[0].message, /"Kahvit"/);
});

test('tuntematon matka-aika paikalliselle tapahtumalle on tieto, ei nolla', () => {
  const events = occurrences([
    { title: 'Neuvola', placeId: 'p1' },
    { title: 'Kirjasto', locationText: 'Pasila', startTime: '14:00' },
    { title: 'Etäpalaveri', startTime: '16:00' },
    { title: 'Mökki', startTime: null, placeId: 'p2' }
  ]);
  const found = detectBlockConflicts({ tasks: [], events, blocks: [] });
  assert.deepEqual(found.map(c => c.code), [CONFLICT.TRAVEL_UNKNOWN, CONFLICT.TRAVEL_UNKNOWN]);
  assert.ok(found.every(c => c.severity === SEVERITY.INFO));
  assert.match(found.find(c => /Neuvola/.test(c.message)).message,
    /Matka-aikaa tapahtumaan "Neuvola" \(2026-09-28 klo 10:00\) ei tiedetä, joten lähtöä ei ole varattu kalenteriin/);

  const known = deriveBlocks({ occurrences: events, departureFor: departureFor() });
  assert.deepEqual(detectBlockConflicts({ tasks: [], events, blocks: known }).filter(c => c.code === CONFLICT.TRAVEL_UNKNOWN), []);
});

test('ristiriidat: menneestä ei huomauteta, kun alkupäivä annetaan', () => {
  const { events, blocks } = travelScenario();
  const tasks = [task({ time: '09:20', durationMinutes: 10 })];
  assert.equal(detectBlockConflicts({ tasks, events, blocks, fromIso: DAY }).length, 1);
  assert.equal(detectBlockConflicts({ tasks, events, blocks, fromIso: NEXT }).length, 0);
});

test('tapahtuman päällekkäisyys oman merkinnän tai toisen tapahtuman kanssa', () => {
  const events = occurrences([
    { title: 'Hammaslääkäri', startTime: '10:00', durationMinutes: 60 },
    { title: 'Webinaari', startTime: '10:30', durationMinutes: 60 },
    { title: 'Yövuoro', date: PREV, startTime: '22:00', endTime: '02:00' }
  ]);
  const tasks = [
    task({ id: 'call', title: 'Puhelu', time: '10:45', durationMinutes: 10 }),
    task({ id: 'call2', title: 'Toinen puhelu', time: '10:50', durationMinutes: 10 }),
    task({ id: 'night', title: 'Aamulääke', time: '01:00' }),
    autoTask({ id: 'auto', title: 'Auto', time: '10:15', endTime: '10:20' })
  ];
  const found = detectEventOverlaps({ tasks, events });
  const pairs = found.map(c => c.message).sort();
  assert.ok(found.every(c => c.code === CONFLICT.OVERLAP && c.severity === SEVERITY.BLOCKING));
  assert.ok(pairs.some(m => /"Hammaslääkäri" ja "Webinaari"|"Webinaari" ja "Hammaslääkäri"/.test(m)));
  assert.ok(found.some(c => c.taskIds.includes('night')), 'yön yli jatkuva tapahtuma kattaa aamun');
  assert.ok(!found.some(c => c.taskIds.includes('auto')), 'automaattinen sijoitus ei ole käyttäjän ristiriita');
  assert.ok(!found.some(c => c.taskIds.length === 2), 'kahden tehtävän pari on detectOverlaps-funktion asia');
  // Hammaslääkäri–Webinaari, puhelu × 2 tapahtumaa, toinen puhelu × 2, aamulääke × yövuoro.
  assert.equal(found.length, 6);
});

test('kokoava tarkistus: kalenteri mukaan vain pyydettäessä', () => {
  const { events, blocks } = travelScenario();
  const tasks = [task({ time: '09:20', durationMinutes: 10 })];
  assert.deepEqual(detectAllConflicts({ tasks, todayIso: DAY }), []);
  const all = detectAllConflicts({ tasks, todayIso: DAY, events, blocks });
  assert.deepEqual(all.map(c => c.code), [CONFLICT.TRAVEL_OVERLAP]);
  assert.equal(detectAllConflicts({ tasks, todayIso: NEXT, events, blocks }).length, 0, 'mennyt ei nosta ristiriitaa');
});

// =====================================================================
// UUDELLEENSUUNNITTELU
// =====================================================================

test('CONFLICT-laukaisin: automaattinen tehtävä matkan tai tapahtuman päällä', () => {
  const { events, blocks } = travelScenario();
  const tasks = [
    autoTask({ id: 'auto', title: 'Sähköpostit', time: '09:15', endTime: '09:45' }),
    task({ id: 'mine', time: '09:15', endTime: '09:45' }),
    autoTask({ id: 'past', date: PREV, time: '09:15', endTime: '09:45' })
  ];
  const result = detectReplanTriggers({ tasks, todayIso: DAY, events, blocks });
  const conflict = result.triggers.find(t => t.trigger === REPLAN_TRIGGER.CONFLICT);
  assert.ok(conflict);
  assert.deepEqual(conflict.taskIds, ['auto']);
  assert.deepEqual(conflict.dateIsos, [DAY]);
  // Valmistautuminen päättyy 09:15 (puoliavoin väli), joten ensimmäinen osuma on matka.
  assert.equal(conflict.detail, '"Sähköpostit" (2026-09-28 klo 09:15) osuu matkaan. Ehdotan sille uutta aikaa.');
  assert.equal(result.triggers.at(-1), conflict, 'uusi laukaisin tulee vanhojen jälkeen');

  assert.equal(detectReplanTriggers({ tasks, todayIso: DAY }).triggers.some(t => t.trigger === REPLAN_TRIGGER.CONFLICT), false);

  const many = detectReplanTriggers({
    tasks: [...tasks, autoTask({ id: 'auto2', time: '10:15', endTime: '10:30' })], todayIso: DAY, events, blocks
  }).triggers.find(t => t.trigger === REPLAN_TRIGGER.CONFLICT);
  assert.deepEqual(many.taskIds, ['auto', 'auto2']);
  assert.match(many.detail, /^2 automaattisesti sijoitettua tehtävää/);
});

test('törmäyslista palauttaa vain automaattiset, järjestettynä', () => {
  const { events, blocks } = travelScenario();
  const collisions = findCalendarCollisions({
    tasks: [
      autoTask({ id: 'b', title: 'B', time: '10:15', endTime: '10:30' }),
      autoTask({ id: 'a', title: 'A', time: '09:20', endTime: '09:30' }),
      task({ id: 'm', time: '09:20', endTime: '09:30' })
    ],
    events, blocks
  });
  assert.deepEqual(collisions.map(c => `${c.taskId}:${c.guardKind}`), ['a:travel', 'b:event']);
  assert.ok(Object.isFrozen(collisions) && collisions.every(Object.isFrozen));
});

// =====================================================================
// SYÖTE, ROSKA JA KASVU
// =====================================================================

test('syötettä ei muuteta missään vaiheessa', () => {
  const { events, blocks } = travelScenario();
  const tasks = deepFreeze([
    autoTask({ id: 'auto', time: '09:15', endTime: '09:45' }),
    task({ id: 'mine', time: '09:20', endTime: '09:30' }),
    task({ id: 'free', durationMinutes: 30 })
  ]);
  const before = JSON.stringify({ tasks, events, blocks });
  buildDayPlan({ tasks, profile, dateIso: DAY, events, blocks });
  proposeSchedule({ tasks, profile, dateIso: DAY, events, blocks, reflow: true, nowMinutes: 480, todayIso: DAY });
  dayCapacity({ tasks, profile, dateIso: DAY, events, blocks });
  horizonCapacity({ tasks, profile, fromIso: DAY, toIso: NEXT, events, blocks });
  detectAllConflicts({ tasks, events, blocks, todayIso: DAY });
  detectReplanTriggers({ tasks, events, blocks, todayIso: DAY });
  buildReplanProposal({ tasks, profile, todayIso: DAY, events, blocks });
  assert.equal(JSON.stringify({ tasks, events, blocks }), before);
});

test('roskasyöte tapahtumissa ja lohkoissa ei kaada mitään', () => {
  const hostile = new Proxy({}, { get() { throw new Error('ansa'); } });
  const garbage = [
    null, undefined, 0, 'x', [], hostile, {},
    { isEvent: true, id: 'a', date: DAY, time: 1000 },
    { isEvent: true, id: 'b', date: DAY, time: '10:00', endTime: 7 },
    { isEvent: true, id: 'c', date: DAY, time: '10:00', durationMinutes: 'pitkä' },
    { isEvent: true, date: DAY, time: '10:00' },
    { block: true, kind: 'sleep', id: 'd', date: DAY, time: '10:00' },
    { block: true, kind: 'travel', id: 'e', date: DAY, time: '10:00', endTime: {} },
    { block: true, kind: 'mystery', id: 'f', date: DAY, time: '10:00', durationMinutes: 30 },
    { block: true, kind: 'travel', id: 'g', date: 'eilen', time: '10:00', durationMinutes: 30 }
  ];
  const tasks = [task({ time: '09:00', endTime: '10:30' }), autoTask({ id: 'auto', time: '10:00', endTime: '10:30' })];
  for (const input of [garbage, null, 'x', 5, {}, [hostile]]) {
    assert.doesNotThrow(() => buildDayPlan({ tasks, profile, dateIso: DAY, events: input, blocks: input }));
    assert.doesNotThrow(() => proposeSchedule({ tasks, profile, dateIso: DAY, events: input, blocks: input, reflow: true, nowMinutes: 600 }));
    assert.doesNotThrow(() => dayCapacity({ tasks, profile, dateIso: DAY, events: input, blocks: input }));
    assert.doesNotThrow(() => horizonCapacity({ tasks, profile, fromIso: DAY, toIso: NEXT, events: input, blocks: input }));
    assert.doesNotThrow(() => detectBlockConflicts({ tasks: input, events: input, blocks: input }));
    assert.doesNotThrow(() => detectEventOverlaps({ tasks: input, events: input }));
    assert.doesNotThrow(() => detectAllConflicts({ tasks, events: input, blocks: input, todayIso: DAY }));
    assert.doesNotThrow(() => detectReplanTriggers({ tasks, events: input, blocks: input, todayIso: DAY }));
    assert.doesNotThrow(() => findCalendarCollisions({ tasks: input, events: input, blocks: input }));
  }
  // Vihamielinen tunniste tai otsikko ei kaada ristiriitalistaa.
  const scenario = travelScenario();
  const nasty = [
    { ...task({ time: '09:20', durationMinutes: 10 }), id: Symbol('tunniste') },
    { ...task({ id: 'n2', time: '09:20', durationMinutes: 10 }), title: { toString() { throw new Error('ansa'); } } },
    task({ id: 'ok', title: 'Kelvollinen', time: '09:20', durationMinutes: 10 })
  ];
  const found = detectBlockConflicts({ tasks: nasty, ...scenario });
  assert.ok(found.some(c => c.taskIds && c.taskIds[0] === 'ok'), 'kelvollinen rivi raportoidaan silti');
  assert.doesNotThrow(() => detectEventOverlaps({ tasks: nasty, events: scenario.events }));

  // Roskan seasta jää vain se, minkä voi sijoittaa varmasti. Lohko ilman
  // kestoa ei ole lohko: sen varaamaa aikaa ei tiedetä.
  const plan = buildDayPlan({ tasks: [], profile, dateIso: DAY, events: garbage, blocks: garbage });
  assert.deepEqual(plan.blocks, [], 'lohko ilman kestoa, tuntemattomalla lajilla tai väärällä päivällä hylätään');
  assert.deepEqual(plan.eventItems.map(i => i.id), ['c'], 'vain kelvollinen esiintymä jää (kesto tuntematon)');
});

test('KRIITTINEN: päiväsuunnitelma ja ehdotukset kasvavat lineaarisesti tapahtumien ja lohkojen mukaan', () => {
  const reads = count => {
    const events = occurrences(Array.from({ length: count }, (_, i) => ({
      date: i % 3 === 0 ? PREV : DAY, startTime: hhmm((i * 7) % 1440), durationMinutes: 10 + (i % 5)
    })));
    const blocks = deriveBlocks({ occurrences: events, departureFor: departureFor({ travel: 5, prep: 2, overhead: 1, early: 1 }) });
    const wrappedEvents = events.map(counting);
    const wrappedBlocks = blocks.map(counting);
    counting.total = 0;
    buildDayPlan({ tasks: [], profile, dateIso: DAY, events: wrappedEvents, blocks: wrappedBlocks });
    proposeSchedule({
      tasks: [task({ durationMinutes: 15 }), autoTask({ id: 'a', time: '12:00', endTime: '12:15' })],
      profile, dateIso: DAY, events: wrappedEvents, blocks: wrappedBlocks, reflow: true
    });
    return counting.total;
  };
  const small = reads(200);
  const large = reads(400);
  assert.ok(small > 0);
  assert.ok(large / small < 2.8, `kasvu ${(large / small).toFixed(2)}× näyttää neliölliseltä`);
});

test('KRIITTINEN: ristiriitojen, törmäysten ja horisontin kasvu on lineaarinen', () => {
  // Tapahtumat ja tehtävät jakautuvat päiville: kun aineisto kaksinkertaistuu,
  // päiviä on kaksi kertaa enemmän (todellinen kalenteri kasvaa näin).
  // Horisontti on kiinteä 14 päivää, jolloin päivää kohden tiheys kasvaa:
  // silloinkin kasvun on oltava lineaarinen.
  const build = (count, days) => {
    const events = occurrences(Array.from({ length: count }, (_, i) => ({
      date: addDaysToIso(DAY, i % days), startTime: hhmm(360 + (i * 13) % 900), durationMinutes: 30, placeId: i % 2 ? 'p' : null
    })), DAY, addDaysToIso(DAY, days));
    const blocks = deriveBlocks({ occurrences: events, departureFor: departureFor({ only: events.filter((_, i) => i % 3).map(e => e.eventId) }) });
    const tasks = Array.from({ length: count }, (_, i) => (i % 2 ? autoTask : task)({
      id: `t${i}`, title: `T${i}`, date: addDaysToIso(DAY, i % days), time: hhmm(360 + (i * 17) % 900), durationMinutes: 20
    }));
    return {
      events: events.map(counting), blocks: blocks.map(counting), tasks: tasks.map(counting)
    };
  };
  const measure = (count, days, fn) => {
    const input = build(count, days);
    counting.total = 0;
    fn(input);
    return counting.total;
  };
  const spread = count => Math.max(1, Math.floor(count / 10));
  const cases = {
    conflicts: [spread, ({ tasks, events, blocks }) => detectBlockConflicts({ tasks, events, blocks })],
    overlaps: [spread, ({ tasks, events }) => detectEventOverlaps({ tasks, events })],
    collisions: [spread, ({ tasks, events, blocks }) => findCalendarCollisions({ tasks, events, blocks })],
    horizon: [() => 14, ({ tasks, events, blocks }) =>
      horizonCapacity({ tasks, profile, fromIso: DAY, toIso: addDaysToIso(DAY, 13), events, blocks })]
  };
  for (const [name, [days, fn]] of Object.entries(cases)) {
    const small = measure(150, days(150), fn);
    const large = measure(300, days(300), fn);
    assert.ok(small > 0, name);
    assert.ok(large / small < 2.8, `${name}: kasvu ${(large / small).toFixed(2)}× näyttää neliölliseltä`);
  }
});
