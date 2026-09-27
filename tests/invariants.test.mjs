// Ominaisuustestit: invariantit satunnaisella syötteellä.
//
// Muut testit tarkistavat yksittäisiä tapauksia, jotka joku on osannut
// kuvitella. Nämä tarkistavat sääntöjä, joiden on pädettävä KAIKELLA
// syötteellä — ja generoivat syötteen itse.
//
// DETERMINISMI ON PAKOLLINEN. Testi, joka kaatuu vain joka kolmas ajo, on
// pahempi kuin ei testiä lainkaan: se opettaa jättämään punaisen huomiotta.
// Siksi satunnaisuus tulee kiinteästä siemenluvusta (mulberry32) eikä
// Math.randomista. Sama ajo tuottaa aina saman syötteen, ja jos testi
// kaatuu, virheilmoitus kertoo tapauksen numeron, jolla se toistuu.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeTask, toMinutes, durationOf, effectiveEndTime, isOverdue,
  deadlineUrgency, URGENCY, partitionDay
} from '../src/domain/task.js';
import {
  normalizeRoutine, normalizeException, expandRoutines, expandRoutineOccurrences,
  matchesDate, RECURRENCE, EXCEPTION, ROUTINE_SCHEDULING, isoWeekday
} from '../src/domain/routine.js';
import {
  buildDayPlan, proposeSchedule, findFreeSlots, occupiedRanges,
  MIN_USEFUL_SLOT_MINUTES
} from '../src/domain/scheduler.js';
import { normalizeGoal, computeGoalProgress, summarizeGoals } from '../src/domain/goal.js';
import { normalizeWellbeingEntry, planningLoadSuggestion } from '../src/domain/wellbeing.js';
import {
  normalizePreferences, planNotifications, applyLimits, isQuietTime, LEVEL
} from '../src/domain/notification.js';
import { rankTasks, scoreTask } from '../src/domain/focus.js';
import { buildEveningReview } from '../src/domain/review.js';
import { planDepartureChain, planDailyLifeReminders } from '../src/domain/dailyReminders.js';
import { applyNotificationPolicy, QUIET_PASS_TYPES, wallClockMinutes } from '../src/domain/notificationPolicy.js';
import { buildAckLog } from '../src/domain/notificationAck.js';
import { DELIVERY, REMINDER_TOPIC, GUIDANCE_STYLES } from '../src/domain/dailyLife.js';

// --------------------------------------------------------- satunnaisuus

/** Siemenennettävä satunnaisgeneraattori. Sama siemen = sama sarja. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CASES = 300;

function makeGen(seed) {
  const random = mulberry32(seed);
  const int = (min, max) => min + Math.floor(random() * (max - min + 1));
  const pick = list => list[int(0, list.length - 1)];
  const maybe = (value, probability = 0.5) => (random() < probability ? value : null);
  return { random, int, pick, maybe };
}

const CATEGORIES = ['tyo', 'perhe', 'hyvinvointi', 'harrastus', 'koti', 'kehitys', 'talous', 'muu'];
const PRIORITIES = ['korkea', 'normaali', 'matala'];

/** Päivämäärä ISO-muodossa kiinteästä nollapisteestä siirtymällä. */
function isoDate(offsetDays) {
  const base = Date.UTC(2026, 0, 5); // maanantai
  const date = new Date(base + offsetDays * 86400000);
  return date.toISOString().slice(0, 10);
}

function timeOfDay(minutes) {
  const m = ((minutes % 1440) + 1440) % 1440;
  return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
}

function randomTask(gen, dateIso) {
  const hasTime = gen.random() < 0.6;
  const start = gen.int(6, 20) * 60 + gen.pick([0, 15, 30, 45]);
  const duration = gen.pick([15, 30, 45, 60, 90, 120]);
  return normalizeTask({
    id: 't' + gen.int(1, 1e9),
    title: 'Tehtava ' + gen.int(1, 999),
    date: dateIso,
    time: hasTime ? timeOfDay(start) : null,
    endTime: hasTime && gen.random() < 0.5 ? timeOfDay(start + duration) : null,
    durationMinutes: gen.random() < 0.6 ? duration : null,
    deadline: gen.maybe(isoDate(gen.int(-10, 20)), 0.4),
    category: gen.pick(CATEGORIES),
    priority: gen.pick(PRIORITIES),
    completed: gen.random() < 0.25,
    goalId: gen.maybe('g' + gen.int(1, 3), 0.5)
  });
}

function randomRoutine(gen) {
  const type = gen.pick(Object.values(RECURRENCE));
  const weekdays = type === RECURRENCE.WEEKLY
    ? [gen.int(1, 7)]
    : type === RECURRENCE.CUSTOM_WEEKDAYS
      ? [...new Set([gen.int(1, 7), gen.int(1, 7)])]
      : [];
  const hasTime = gen.random() < 0.6;
  return normalizeRoutine({
    id: 'r' + gen.int(1, 1e9),
    title: 'Rutiini ' + gen.int(1, 999),
    recurrence: { type, weekdays },
    preferredTime: hasTime ? timeOfDay(gen.int(6, 21) * 60) : null,
    durationMinutes: gen.pick([15, 30, 45, 60]),
    scheduling: hasTime ? gen.pick(Object.values(ROUTINE_SCHEDULING)) : ROUTINE_SCHEDULING.FLEXIBLE,
    category: gen.pick(CATEGORIES),
    priority: gen.pick(PRIORITIES),
    active: gen.random() < 0.85,
    startDate: gen.maybe(isoDate(gen.int(-20, 0)), 0.4),
    endDate: gen.maybe(isoDate(gen.int(1, 40)), 0.3)
  });
}

/** Ajetaan sama tarkistus monella siemenellä ja kerrotaan mikä kaatui. */
function forEachCase(fn, cases = CASES) {
  for (let index = 0; index < cases; index++) {
    try {
      fn(makeGen(index + 1), index);
    } catch (error) {
      error.message = `tapaus #${index} (siemen ${index + 1}): ${error.message}`;
      throw error;
    }
  }
}

// ------------------------------------------------- normalisointi on idempotentti

test('normalizeTask on idempotentti', () => {
  // Jos normalisointi muuttaisi tulostaan toisella kierroksella, tallennus ja
  // lataus muuttaisivat tehtävää joka kerta hiljaisesti.
  forEachCase(gen => {
    const once = randomTask(gen, isoDate(gen.int(-5, 5)));
    const twice = normalizeTask(once);
    assert.deepEqual(twice, once);
  });
});

test('normalizeRoutine on idempotentti', () => {
  forEachCase(gen => {
    const once = randomRoutine(gen);
    assert.deepEqual(normalizeRoutine(once), once);
  });
});

test('normalizeGoal on idempotentti', () => {
  forEachCase(gen => {
    const once = normalizeGoal({
      id: 'g' + gen.int(1, 1e6),
      title: 'Tavoite ' + gen.int(1, 99),
      status: gen.pick(['active', 'paused', 'completed', 'archived']),
      progressMode: gen.pick(['manual', 'task_based']),
      manualProgress: gen.int(-50, 150),
      targetDate: gen.maybe(isoDate(gen.int(-30, 60)), 0.6),
      category: gen.pick(CATEGORIES),
      priority: gen.pick(PRIORITIES)
    });
    assert.deepEqual(normalizeGoal(once), once);
  });
});

test('normalizeWellbeingEntry on idempotentti', () => {
  forEachCase(gen => {
    const once = normalizeWellbeingEntry({
      id: 'w' + gen.int(1, 1e6),
      date: isoDate(gen.int(-10, 0)),
      energy: gen.int(-2, 9),
      mood: gen.int(-2, 9),
      stress: gen.int(-2, 9),
      sleepHours: gen.random() * 30,
      note: gen.maybe('  muistiinpano  ', 0.5)
    });
    assert.deepEqual(normalizeWellbeingEntry(once), once);
  });
});

test('normalizePreferences on idempotentti', () => {
  forEachCase(gen => {
    const once = normalizePreferences({
      enabled: gen.random() < 0.5,
      taskLeadMinutes: gen.int(-100, 500),
      routineLeadMinutes: gen.int(-100, 500),
      maxPerDay: gen.int(-10, 200),
      dailyPlanTime: gen.pick(['07:30', '99:99', '', '23:59']),
      quietHours: { from: gen.pick(['22:00', 'x']), to: gen.pick(['06:30', null]) }
    });
    assert.deepEqual(normalizePreferences(once), once);
  }, 120);
});

// --------------------------------------------------------- rutiinien laajennus

test('rutiiniesiintymät pysyvät pyydetyllä välillä ja ovat järjestyksessä', () => {
  forEachCase(gen => {
    const routines = Array.from({ length: gen.int(0, 5) }, () => randomRoutine(gen));
    const fromOffset = gen.int(-10, 10);
    const toOffset = fromOffset + gen.int(0, 30);
    const from = isoDate(fromOffset);
    const to = isoDate(toOffset);

    const occurrences = expandRoutines({ routines, from, to });

    let previous = '';
    for (const occurrence of occurrences) {
      assert.ok(occurrence.date >= from && occurrence.date <= to,
        `esiintymä ${occurrence.date} välin [${from}, ${to}] ulkopuolella`);
      assert.ok(occurrence.date >= previous, 'esiintymät eivät ole järjestyksessä');
      previous = occurrence.date;
    }
  });
});

test('sama rutiini ei tuota kahta esiintymää samalle päivälle', () => {
  forEachCase(gen => {
    const routine = randomRoutine(gen);
    const from = isoDate(0);
    const to = isoDate(gen.int(0, 60));
    const occurrences = expandRoutineOccurrences({ routine, from, to });
    const keys = occurrences.map(o => o.routineId + '|' + o.date);
    assert.equal(new Set(keys).size, keys.length, 'sama päivä esiintyy kahdesti');
  });
});

test('esiintymä syntyy täsmälleen silloin kun matchesDate sanoo niin', () => {
  // expandRoutineOccurrences ja matchesDate ovat kaksi näkymää samaan
  // sääntöön. Jos ne erkanevat, viikkonäkymä ja päivänäkymä näyttävät eri
  // asioita samasta rutiinista.
  forEachCase(gen => {
    const routine = randomRoutine(gen);
    const from = isoDate(0);
    const days = 30;
    const to = isoDate(days - 1);

    const produced = new Set(
      expandRoutineOccurrences({ routine, from, to }).map(o => o.date));

    for (let day = 0; day < days; day++) {
      const dateIso = isoDate(day);
      assert.equal(produced.has(dateIso), matchesDate(routine, dateIso),
        `${routine.recurrence.type}: ${dateIso} eri mieltä`);
    }
  });
});

test('skip-poikkeus poistaa täsmälleen yhden päivän', () => {
  forEachCase(gen => {
    const routine = normalizeRoutine({
      ...randomRoutine(gen),
      recurrence: { type: RECURRENCE.DAILY, weekdays: [] },
      active: true,
      startDate: null,
      endDate: null
    });
    const from = isoDate(0);
    const to = isoDate(20);

    const before = expandRoutineOccurrences({ routine, from, to });
    assert.ok(before.length > 0);

    const victim = before[gen.int(0, before.length - 1)].date;
    const exception = normalizeException({
      id: 'e1', routineId: routine.id, date: victim, type: EXCEPTION.SKIP
    });

    const after = expandRoutineOccurrences({ routine, from, to, exceptions: [exception] });

    assert.equal(after.length, before.length - 1);
    assert.equal(after.some(o => o.date === victim), false);
  });
});

test('pois kytketty rutiini ei tuota yhtään esiintymää', () => {
  forEachCase(gen => {
    const routine = normalizeRoutine({ ...randomRoutine(gen), active: false });
    const occurrences = expandRoutineOccurrences({
      routine, from: isoDate(0), to: isoDate(60)
    });
    assert.deepEqual(occurrences, []);
  }, 60);
});

test('viikonpäiväsääntö osuu vain valittuihin päiviin', () => {
  forEachCase(gen => {
    const weekdays = [...new Set(Array.from({ length: gen.int(1, 4) }, () => gen.int(1, 7)))];
    const routine = normalizeRoutine({
      id: 'r1', title: 'x', active: true,
      recurrence: { type: RECURRENCE.CUSTOM_WEEKDAYS, weekdays }
    });

    for (const occurrence of expandRoutineOccurrences({
      routine, from: isoDate(0), to: isoDate(27)
    })) {
      const weekday = isoWeekday(new Date(occurrence.date + 'T00:00:00'));
      assert.ok(weekdays.includes(weekday),
        `${occurrence.date} on viikonpäivä ${weekday}, sallitut ${weekdays}`);
    }
  });
});

// ------------------------------------------------------------- päiväsuunnitelma

test('päiväsuunnitelman aikajana on aikajärjestyksessä', () => {
  forEachCase(gen => {
    const dateIso = isoDate(gen.int(-3, 3));
    const tasks = Array.from({ length: gen.int(0, 8) }, () => randomTask(gen, dateIso));
    const routines = Array.from({ length: gen.int(0, 3) }, () => randomRoutine(gen));

    const plan = buildDayPlan({ tasks, dateIso, routines, todayIso: isoDate(0) });

    let previous = -1;
    for (const item of plan.timeline) {
      const minutes = item.time ? toMinutes(item.time) : -1;
      assert.ok(minutes >= previous, 'aikajana ei ole järjestyksessä');
      previous = minutes;
    }
  });
});

test('jokainen päivän tehtävä on täsmälleen yhdessä lohkossa', () => {
  // scheduled / unscheduled / completed eivät saa mennä päällekkäin eivätkä
  // pudottaa mitään: muuten tehtävä katoaisi näkymästä tai näkyisi kahdesti.
  forEachCase(gen => {
    const dateIso = isoDate(0);
    const tasks = Array.from({ length: gen.int(0, 10) }, () => randomTask(gen, dateIso));
    const plan = buildDayPlan({ tasks, dateIso, todayIso: dateIso });

    const ids = [...plan.scheduled, ...plan.unscheduled, ...plan.completed].map(t => t.id);
    assert.equal(new Set(ids).size, ids.length, 'tehtävä esiintyy kahdessa lohkossa');
    assert.equal(ids.length, tasks.length, 'tehtäviä katosi tai monistui');
    assert.equal(plan.load.count, tasks.length);
  });
});

test('partitionDay ei kadota eikä monista tehtäviä', () => {
  forEachCase(gen => {
    const tasks = Array.from({ length: gen.int(0, 12) }, () => randomTask(gen, isoDate(0)));
    const parts = partitionDay(tasks);
    const total = Object.values(parts).flat();
    assert.equal(total.length, tasks.length);
    assert.equal(new Set(total.map(t => t.id)).size, new Set(tasks.map(t => t.id)).size);
  });
});

test('vapaat välit eivät mene päällekkäin varattujen kanssa', () => {
  forEachCase(gen => {
    const dateIso = isoDate(0);
    const tasks = Array.from({ length: gen.int(0, 8) }, () => randomTask(gen, dateIso));
    const routines = Array.from({ length: gen.int(0, 3) }, () => randomRoutine(gen));
    const plan = buildDayPlan({ tasks, dateIso, routines, todayIso: dateIso });

    const busy = occupiedRanges(plan.timeline.filter(it => it.id !== 'virtual-sleep'));

    for (const slot of plan.freeSlots) {
      assert.ok(slot.minutes >= MIN_USEFUL_SLOT_MINUTES,
        `liian lyhyt vapaa väli: ${slot.minutes} min`);
      assert.ok(slot.start >= plan.range.start && slot.start + slot.minutes <= plan.range.end,
        'vapaa väli valveillaoloikkunan ulkopuolella');

      for (const range of busy) {
        const overlap = slot.start < range.end && range.start < slot.start + slot.minutes;
        assert.equal(overlap, false,
          `vapaa väli ${slot.start}-${slot.start + slot.minutes} osuu varattuun `
          + `${range.start}-${range.end}`);
      }
    }
  });
});

test('vapaat välit ovat järjestyksessä eivätkä koske toisiaan', () => {
  forEachCase(gen => {
    const items = Array.from({ length: gen.int(0, 8) }, () => {
      const start = gen.int(6, 21) * 60;
      return { id: 'x' + gen.int(1, 1e6), time: timeOfDay(start),
        durationMinutes: gen.pick([15, 30, 60, 120]) };
    });
    const range = { start: 6 * 60, end: 23 * 60 };
    const slots = findFreeSlots({ items, range });

    let previousEnd = range.start - 1;
    for (const slot of slots) {
      assert.ok(slot.start > previousEnd, 'vapaat välit menevät päällekkäin');
      previousEnd = slot.start + slot.minutes;
      assert.ok(previousEnd <= range.end);
    }
  });
});

// -------------------------------------------------------------- ehdotukset

test('ehdotukset eivät mene päällekkäin keskenään', () => {
  forEachCase(gen => {
    const dateIso = isoDate(0);
    const tasks = Array.from({ length: gen.int(0, 8) }, () => randomTask(gen, dateIso));
    const routines = Array.from({ length: gen.int(0, 4) }, () => randomRoutine(gen));

    const { proposals } = proposeSchedule({ tasks, dateIso, routines, todayIso: dateIso });

    const ranges = proposals
      .map(p => ({ start: toMinutes(p.time), end: toMinutes(p.endTime) }))
      .sort((a, b) => a.start - b.start);

    for (let i = 1; i < ranges.length; i++) {
      assert.ok(ranges[i].start >= ranges[i - 1].end,
        `ehdotukset ${i - 1} ja ${i} menevät päällekkäin`);
    }
  });
});

test('ehdotus ei koskaan osu jo varattuun aikaan', () => {
  forEachCase(gen => {
    const dateIso = isoDate(0);
    const tasks = Array.from({ length: gen.int(1, 8) }, () => randomTask(gen, dateIso));
    const routines = Array.from({ length: gen.int(0, 3) }, () => randomRoutine(gen));

    const plan = buildDayPlan({ tasks, dateIso, routines, todayIso: dateIso });
    const busy = occupiedRanges(plan.timeline.filter(it => it.id !== 'virtual-sleep'));
    const { proposals } = proposeSchedule({ tasks, dateIso, routines, todayIso: dateIso });

    for (const proposal of proposals) {
      const start = toMinutes(proposal.time);
      const end = toMinutes(proposal.endTime);
      for (const range of busy) {
        assert.equal(start < range.end && range.start < end, false,
          `ehdotus ${proposal.time}-${proposal.endTime} osuu varattuun`);
      }
    }
  });
});

test('ehdotus ei koskaan koske käyttäjän itse ajastamaan tehtävään', () => {
  forEachCase(gen => {
    const dateIso = isoDate(0);
    const tasks = Array.from({ length: gen.int(1, 8) }, () => randomTask(gen, dateIso));
    const manualIds = new Set(tasks.filter(t => t.time).map(t => t.id));

    const { proposals } = proposeSchedule({ tasks, dateIso, todayIso: dateIso });

    for (const proposal of proposals) {
      assert.equal(manualIds.has(proposal.taskId), false,
        'scheduler siirtäisi käyttäjän itse ajastaman tehtävän');
    }
  });
});

test('proposeSchedule on deterministinen', () => {
  forEachCase(gen => {
    const dateIso = isoDate(0);
    const tasks = Array.from({ length: gen.int(0, 8) }, () => randomTask(gen, dateIso));
    const routines = Array.from({ length: gen.int(0, 3) }, () => randomRoutine(gen));

    const first = proposeSchedule({ tasks, dateIso, routines, todayIso: dateIso });
    const second = proposeSchedule({ tasks, dateIso, routines, todayIso: dateIso });
    assert.deepEqual(second, first);
  });
});

test('jokainen aikatauluttamaton siirrettävä tehtävä joko sijoitetaan tai jää listaan', () => {
  forEachCase(gen => {
    const dateIso = isoDate(0);
    const tasks = Array.from({ length: gen.int(1, 8) }, () => randomTask(gen, dateIso));
    const plan = buildDayPlan({ tasks, dateIso, todayIso: dateIso });
    const { proposals, unplaced } = proposeSchedule({ tasks, dateIso, todayIso: dateIso });

    const candidates = plan.unscheduled.filter(t => !t.completed);
    const placed = proposals.filter(p => p.taskId).map(p => p.taskId);
    const skipped = unplaced.filter(item => item && item.id).map(item => item.id);

    for (const task of candidates) {
      assert.ok(placed.includes(task.id) || skipped.includes(task.id),
        `tehtävä ${task.id} katosi ehdotuksista kokonaan`);
    }
  });
});

// ------------------------------------------------------------- tavoitteet

test('tavoitteen edistyminen on aina 0-100 kokonaisluku', () => {
  forEachCase(gen => {
    const goal = normalizeGoal({
      id: 'g1',
      title: 'x',
      status: gen.pick(['active', 'paused', 'completed', 'archived']),
      progressMode: gen.pick(['manual', 'task_based']),
      manualProgress: gen.int(-200, 300)
    });
    const tasks = Array.from({ length: gen.int(0, 10) }, () => {
      const task = randomTask(gen, isoDate(0));
      return { ...task, goalId: 'g1' };
    });

    const progress = computeGoalProgress(goal, tasks);
    assert.ok(Number.isInteger(progress.percent), 'prosentti ei ole kokonaisluku');
    assert.ok(progress.percent >= 0 && progress.percent <= 100,
      `prosentti ${progress.percent} alueen ulkopuolella`);
    assert.ok(progress.completed <= progress.total);
  });
});

test('valmis tavoite on aina 100 % ja tyhjä tavoite 0 %', () => {
  const completed = normalizeGoal({ id: 'g1', title: 'x', status: 'completed' });
  assert.equal(computeGoalProgress(completed, []).percent, 100);

  const empty = normalizeGoal({ id: 'g2', title: 'x', status: 'active' });
  assert.equal(computeGoalProgress(empty, []).percent, 0);
});

test('tehtävän merkitseminen tehdyksi ei koskaan laske edistymistä', () => {
  forEachCase(gen => {
    const goal = normalizeGoal({
      id: 'g1', title: 'x', status: 'active', progressMode: 'task_based'
    });
    const tasks = Array.from({ length: gen.int(1, 8) }, (unused, index) => ({
      ...randomTask(gen, isoDate(0)),
      id: 'task' + index,
      goalId: 'g1',
      completed: false
    }));

    let previous = computeGoalProgress(goal, tasks).percent;
    for (let index = 0; index < tasks.length; index++) {
      tasks[index] = { ...tasks[index], completed: true };
      const current = computeGoalProgress(goal, tasks).percent;
      assert.ok(current >= previous,
        `edistyminen laski ${previous} -> ${current} kun tehtävä kuitattiin`);
      previous = current;
    }
    assert.equal(previous, 100);
  });
});

test('summarizeGoals lajittelee jokaisen tavoitteen täsmälleen kerran', () => {
  forEachCase(gen => {
    const goals = Array.from({ length: gen.int(0, 8) }, (unused, index) => normalizeGoal({
      id: 'g' + index,
      title: 'Tavoite ' + index,
      status: gen.pick(['active', 'paused', 'completed', 'archived']),
      targetDate: gen.maybe(isoDate(gen.int(-20, 20)), 0.6)
    }));

    const summary = summarizeGoals(goals, [], isoDate(0));
    const sorted = [...summary.active, ...summary.paused,
      ...summary.completed, ...summary.archived];

    assert.equal(sorted.length, goals.length);
    assert.equal(new Set(sorted.map(entry => entry.goal.id)).size, goals.length);
    assert.equal(summary.all.length, goals.length);
  });
});

// -------------------------------------------------------------- muistutukset

test('muistutuksia ei koskaan enempää kuin katto sallii', () => {
  forEachCase(gen => {
    const dateIso = isoDate(0);
    const preferences = normalizePreferences({
      enabled: true,
      maxPerDay: gen.int(1, 20)
    });
    const tasks = Array.from({ length: gen.int(0, 25) }, () => ({
      ...randomTask(gen, dateIso),
      completed: false
    }));

    const intents = planNotifications({
      tasks, routineOccurrences: [], dateIso, todayIso: dateIso, preferences
    });
    const limited = applyLimits(intents, preferences);

    assert.ok(limited.length <= preferences.maxPerDay,
      `${limited.length} muistutusta, katto ${preferences.maxPerDay}`);
  });
});

test('rauhoitusaikana läpi pääsevät vain kriittiset muistutukset', () => {
  forEachCase(gen => {
    const dateIso = isoDate(0);
    const preferences = normalizePreferences({
      enabled: true,
      maxPerDay: 50,
      quietHours: { from: '22:00', to: '06:30' }
    });
    const tasks = Array.from({ length: gen.int(0, 20) }, () => ({
      ...randomTask(gen, dateIso),
      completed: false
    }));

    const limited = applyLimits(
      planNotifications({
        tasks, routineOccurrences: [], dateIso, todayIso: dateIso, preferences
      }),
      preferences);

    for (const intent of limited) {
      if (!isQuietTime(intent.time, preferences.quietHours)) continue;
      assert.equal(intent.level, LEVEL.CRITICAL,
        `taso ${intent.level} klo ${intent.time} rauhoitusaikana`);
    }
  });
});

test('muistutukset ovat pois päältä kunnes käyttäjä kytkee ne', () => {
  forEachCase(gen => {
    const dateIso = isoDate(0);
    const tasks = Array.from({ length: gen.int(1, 15) }, () => ({
      ...randomTask(gen, dateIso),
      completed: false
    }));
    const intents = planNotifications({
      tasks, routineOccurrences: [], dateIso, todayIso: dateIso,
      preferences: normalizePreferences({})
    });
    assert.deepEqual(intents, [], 'muistutuksia syntyi ilman lupaa');
  }, 60);
});

test('muistutusten tunnisteet ovat uniikkeja', () => {
  forEachCase(gen => {
    const dateIso = isoDate(0);
    const preferences = normalizePreferences({ enabled: true, maxPerDay: 50 });
    const tasks = Array.from({ length: gen.int(0, 20) }, (unused, index) => ({
      ...randomTask(gen, dateIso),
      id: 'task' + index,
      completed: false
    }));

    const intents = planNotifications({
      tasks, routineOccurrences: [], dateIso, todayIso: dateIso, preferences
    });
    const ids = intents.map(intent => intent.id);
    assert.equal(new Set(ids).size, ids.length, 'sama muistutus kahdesti');
  });
});

// --------------------------------------------- arjen muistutukset ja politiikka

function randomDeparture(gen, dateIso, index) {
  const leave = gen.int(0, 1439);
  const prep = gen.pick([null, 0, 3, 5, 6, 15, 30, 90]);
  return {
    id: 'lahto' + index,
    date: dateIso,
    leave: timeOfDay(leave),
    prepareStart: prep === null ? null : timeOfDay(leave - prep),
    title: 'Meno ' + index,
    placeName: gen.maybe('Paikka', 0.5),
    // Tuntematon matka-aika kolmasosassa: sen ei pidä tuottaa mitään.
    knownTravel: gen.random() < 0.67 ? true : gen.pick([false, null, undefined])
  };
}

test('lähtöketju: tuntematon matka-aika ei tuota mitään, tunnettu on aina järjestyksessä', () => {
  forEachCase(gen => {
    const dateIso = isoDate(gen.int(0, 400));
    const departures = Array.from({ length: gen.int(0, 6) }, (unused, i) => randomDeparture(gen, dateIso, i));
    const intents = planDepartureChain({ departures, guidanceStyle: gen.pick(GUIDANCE_STYLES) });

    const known = new Set(departures.filter(d => d.knownTravel === true).map(d => d.id));
    for (const intent of intents) {
      assert.ok(known.has(intent.departureId), `tuntemattomasta matka-ajasta syntyi ${intent.type}`);
    }
    for (const id of known) {
      const own = intents.filter(i => i.departureId === id && i.step !== 'repeat')
        .map(i => wallClockMinutes(i.date, i.time));
      assert.ok(own.length >= 2, 'tunnetulla lähdöllä on vähintään "pian" ja "nyt"');
      for (let i = 1; i < own.length; i++) assert.ok(own[i] > own[i - 1], 'ketju ei ole järjestyksessä');
    }
    const ids = intents.map(i => i.id);
    assert.equal(new Set(ids).size, ids.length, 'sama muistutus kahdesti');
  });
});

test('arjen muistutusputki: rauhoitusaika, kuittaus, päiväraja ja puheen lupa pitävät', () => {
  forEachCase(gen => {
    const dateIso = isoDate(gen.int(0, 400));
    const quietHours = { from: '22:00', to: '06:30' };
    const maxPerDay = gen.int(1, 12);
    const speechEnabled = gen.random() < 0.5;
    const settings = {
      speechEnabled,
      guidanceStyle: gen.pick(GUIDANCE_STYLES),
      digestEnabled: gen.random() < 0.5,
      digestTime: gen.pick(['18:00', '23:30', '07:00']),
      morningBriefEnabled: gen.random() < 0.5,
      delivery: { departure: gen.pick(Object.values(DELIVERY)), meal: gen.pick(Object.values(DELIVERY)),
        bedtime: DELIVERY.SOUND_AND_SPEECH, habit: DELIVERY.SPEECH }
    };
    const departures = Array.from({ length: gen.int(0, 4) }, (unused, i) => randomDeparture(gen, dateIso, i));
    const entries = Array.from({ length: gen.int(0, 8) }, (unused, i) => ({
      kind: gen.pick(['wind_down', 'bedtime', 'meal', 'habit', 'evening_before', 'morning_brief']),
      id: 'a' + i, date: dateIso, time: timeOfDay(gen.int(0, 1439)), prepMinutes: gen.maybe(gen.int(0, 90))
    }));
    const tasks = Array.from({ length: gen.int(0, 10) }, () => ({ ...randomTask(gen, dateIso), completed: false }));

    const all = [
      ...planNotifications({ tasks, routineOccurrences: [], dateIso, todayIso: dateIso,
        preferences: normalizePreferences({ enabled: true, maxPerDay: 50, quietHours: { from: '00:00', to: '00:00' } }) }),
      ...planDepartureChain({ departures, settings }),
      ...planDailyLifeReminders({ entries, settings })
    ];
    const acked = all.filter(() => gen.random() < 0.2);
    const ackLog = buildAckLog(acked.map(i => ({ type: gen.pick(['acknowledged', 'dismissed']), key: i.ackKey, atMs: 1 })));
    const result = applyNotificationPolicy(all, {
      settings, ackLog, preferences: { enabled: true, quietHours, maxPerDay }
    });

    const handled = new Set(acked.map(i => i.ackKey));
    const nonCritical = new Map();
    for (const intent of result) {
      assert.equal(handled.has(intent.ackKey), false, 'kuitattu tai hylätty palasi');
      if (isQuietTime(intent.time, quietHours)) {
        const passes = intent.level === LEVEL.CRITICAL || QUIET_PASS_TYPES.includes(intent.type)
          || intent.topic === REMINDER_TOPIC.DEPARTURE;
        const silentBedtime = intent.topic === REMINDER_TOPIC.BEDTIME && intent.delivery === DELIVERY.SILENT
          && intent.speech === null;
        assert.ok(passes || silentBedtime, `${intent.type} taso ${intent.level} klo ${intent.time} rauhoitusaikana`);
      }
      if (!speechEnabled) assert.equal(intent.speech, null, 'puhe ilman lupaa');
      if (intent.level !== LEVEL.CRITICAL) nonCritical.set(intent.date, (nonCritical.get(intent.date) || 0) + 1);
    }
    for (const [date, count] of nonCritical) assert.ok(count <= maxPerDay, `${date}: ${count} > ${maxPerDay}`);
    const ids = result.map(i => i.id);
    assert.equal(new Set(ids).size, ids.length, 'sama muistutus kahdesti');
  }, 150);
});

// -------------------------------------------------------------- fokus ja katsaus

test('fokuslista on pistejärjestyksessä eikä ylitä rajaa', () => {
  forEachCase(gen => {
    const dateIso = isoDate(0);
    const limit = gen.int(1, 6);
    const tasks = Array.from({ length: gen.int(0, 15) }, () => randomTask(gen, dateIso));

    const entries = rankTasks({ tasks, dateIso, todayIso: dateIso, limit });

    assert.ok(entries.length <= limit);
    for (let index = 1; index < entries.length; index++) {
      assert.ok(entries[index - 1].score >= entries[index].score,
        'fokuslista ei ole pistejärjestyksessä');
    }
    for (const entry of entries) {
      assert.equal(entry.task.completed, false, 'valmis tehtävä fokuksessa');
    }
  });
});

test('myöhässä oleva tehtävä saa aina enemmän pisteitä kuin sama ei-myöhässä', () => {
  forEachCase(gen => {
    const todayIso = isoDate(0);
    const base = { ...randomTask(gen, todayIso), completed: false };

    const late = { ...base, deadline: isoDate(-1 - gen.int(0, 10)) };
    const notLate = { ...base, deadline: isoDate(30) };

    const lateScore = scoreTask(late, { dateIso: todayIso, todayIso });
    const notLateScore = scoreTask(notLate, { dateIso: todayIso, todayIso });

    assert.ok(lateScore.score > notLateScore.score,
      `myöhässä ${lateScore.score} ei ole suurempi kuin ${notLateScore.score}`);
    assert.equal(isOverdue(late, todayIso), true);
    assert.equal(deadlineUrgency(late, todayIso), URGENCY.OVERDUE);
  });
});

test('illan katsauksen luvut täsmäävät päivän tehtäviin', () => {
  forEachCase(gen => {
    const dateIso = isoDate(0);
    const tasks = Array.from({ length: gen.int(0, 12) }, () => randomTask(gen, dateIso));

    const review = buildEveningReview({ tasks, dateIso, todayIso: dateIso });

    const dayTasks = tasks.filter(task => task.date === dateIso);
    assert.equal(review.completed.length + review.remaining.length, dayTasks.length,
      'katsaus kadotti tai monisti tehtäviä');
    assert.equal(review.stats.completed, review.completed.length);
    assert.ok(review.stats.completionRate >= 0 && review.stats.completionRate <= 100);
  });
});

// ------------------------------------------------------------- hyvinvointi

test('hyvinvointiehdotus ei koskaan muuta suunnitelmaa', () => {
  // Sovellus saa ehdottaa kevennystä. Se ei saa tehdä sitä käyttäjän puolesta.
  forEachCase(gen => {
    const dateIso = isoDate(0);
    const tasks = Array.from({ length: gen.int(0, 12) }, () => randomTask(gen, dateIso));
    const plan = buildDayPlan({ tasks, dateIso, todayIso: dateIso });
    const snapshot = JSON.stringify(plan);

    const entry = normalizeWellbeingEntry({
      date: dateIso,
      energy: gen.int(1, 5),
      mood: gen.int(1, 5),
      stress: gen.int(1, 5)
    });

    const suggestion = planningLoadSuggestion({ entry, plan });

    assert.equal(JSON.stringify(plan), snapshot, 'suunnitelma muuttui');
    assert.equal(typeof suggestion.actionable, 'boolean');
    if (suggestion.suggestedReduction != null) {
      assert.ok(suggestion.suggestedReduction >= 0);
      assert.ok(suggestion.suggestedReduction <= plan.load.count);
    }
  });
});

// ------------------------------------------------------------- kestot

test('keston ja päättymisajan laskenta pysyy ristiriidattomana', () => {
  forEachCase(gen => {
    const task = randomTask(gen, isoDate(0));
    const duration = durationOf(task);
    const end = effectiveEndTime(task);

    if (!task.time) {
      assert.equal(end, null, 'aikatauluttamattomalla on päättymisaika');
      return;
    }
    if (duration == null) return;

    assert.ok(duration > 0, `kesto ${duration} ei ole positiivinen`);
    assert.equal(end, timeOfDay(toMinutes(task.time) + duration),
      'päättymisaika ei vastaa kestoa');
  });
});
