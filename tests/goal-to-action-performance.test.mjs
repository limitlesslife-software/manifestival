// Suunnittelun suorituskyky realistisella salkulla.
//
// =====================================================================
// KASVUN MUOTO, EI KELLONAIKA
// =====================================================================
//
// Kellolla mitattu raja kertoo koneen kuormasta yhtä paljon kuin
// koodista. Se kaatuu satunnaisesti, ja satunnaisesti kaatuva testi
// poistetaan ennen pitkää — jolloin se ei enää vahdi mitään.
//
// Siksi tämä mittaa DETERMINISTISESTI: kuinka monta kertaa syötettä
// luetaan, kun syöte kaksinkertaistuu. Lineaarinen algoritmi kaksin-
// kertaistaa lukumäärän, neliöllinen nelinkertaistaa sen.
//
// Sama menetelmä kuin `tests/performance.test.mjs`. Sitä ei keksitä
// tässä uudelleen toisin.
//
// =====================================================================
// REALISTINEN SALKKU
// =====================================================================
//
//   10 tavoitetta
//   100 tehtävää
//   20 rutiinia
//   kiinteitä sitoumuksia
//
// Tämä on enemmän kuin useimmilla käyttäjillä on, ja vähemmän kuin
// mihin tuhannen tehtävän testit yltävät. Se on se koko, jossa
// suunnittelu oikeasti ajetaan.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeTask } from '../src/domain/task.js';
import { normalizeGoal } from '../src/domain/goal.js';
import { normalizeRoutine, RECURRENCE } from '../src/domain/routine.js';
import { normalizeMilestone } from '../src/domain/milestone.js';
import { planHorizon, dependencyLevels } from '../src/domain/planScheduler.js';
import { horizonCapacity, remainingWork } from '../src/domain/capacity.js';
import { detectAllConflicts, detectPortfolioConflicts } from '../src/domain/conflicts.js';
import { buildReplanProposal } from '../src/domain/replan.js';
import { computeProgress } from '../src/domain/goalProgress.js';
import { forecastGoal } from '../src/domain/forecast.js';

const pad = n => String(n).padStart(2, '0');
const dayOf = i => `2026-${pad(9 + (i % 3))}-${pad(1 + (i % 28))}`;

/** mulberry32 — sama siemen, sama aineisto, joka ajolla. */
function seeded(seed) {
  return function random() {
    seed |= 0;
    seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

/**
 * Laskeva kääre.
 *
 * Jokainen kentän luku kasvattaa laskuria. Neliöllinen silmukka lukee
 * syötettä neliöllisesti, ja se näkyy lukumäärässä riippumatta siitä,
 * kuinka nopea kone on.
 */
function counting(entity) {
  const store = { ...entity };
  const wrapped = {};
  for (const key of Object.keys(store)) {
    Object.defineProperty(wrapped, key, {
      enumerable: true,
      get() { counting.total += 1; return store[key]; }
    });
  }
  return wrapped;
}
counting.total = 0;

function portfolio(taskCount, goalCount = 10) {
  const random = seeded(4242);

  const goals = Array.from({ length: goalCount }, (_, i) => normalizeGoal({
    id: `g${i}`,
    title: `Tavoite ${i}`,
    targetDate: '2026-12-01',
    priority: ['korkea', 'normaali', 'matala'][i % 3],
    status: 'active'
  }));

  const tasks = Array.from({ length: taskCount }, (_, i) => {
    const kiintea = random() < 0.2;
    return normalizeTask({
      id: `t${i}`,
      title: `Tehtävä ${i}`,
      goalId: `g${i % goalCount}`,
      date: random() < 0.5 ? dayOf(i) : null,
      time: kiintea ? `${pad(8 + (i % 8))}:00` : null,
      endTime: kiintea ? `${pad(9 + (i % 8))}:00` : null,
      schedulingState: kiintea ? 'manual' : 'unscheduled',
      durationMinutes: 15 + Math.floor(random() * 90),
      completed: random() < 0.25,
      // Joka viides tehtävä riippuu edellisestä: ketju, jonka
      // topologinen järjestys on laskettava.
      dependsOn: i > 0 && i % 5 === 0 ? [`t${i - 1}`] : []
    });
  });

  const routines = Array.from({ length: 20 }, (_, i) => normalizeRoutine({
    id: `r${i}`,
    title: `Rutiini ${i}`,
    active: true,
    durationMinutes: 30,
    recurrence: { type: RECURRENCE.DAILY, weekdays: [] }
  }));

  const milestones = Array.from({ length: goalCount * 3 }, (_, i) =>
    normalizeMilestone({
      id: `m${i}`,
      goalId: `g${i % goalCount}`,
      title: `Välitavoite ${i}`,
      orderIndex: Math.floor(i / goalCount),
      targetDate: `2026-${pad(10 + (i % 3))}-01`
    }));

  return { goals, tasks, routines, milestones };
}

const TODAY = '2026-09-10';
const HORIZON_END = '2026-10-07';

// =====================================================================
// KASVUN MUOTO
// =====================================================================

/** Kuinka monta kertaa syötettä luetaan annetulla koolla? */
function readsFor(taskCount) {
  const { goals, tasks, routines } = portfolio(taskCount);

  const wrapped = tasks.map(counting);
  counting.total = 0;

  planHorizon({
    tasks: wrapped,
    goals,
    fromIso: TODAY,
    toIso: HORIZON_END,
    routines
  });

  return counting.total;
}

test('KRIITTINEN: horisonttisuunnittelu ei ole neliöllinen', () => {
  // Lineaarinen kaksinkertaistaa, neliöllinen nelinkertaistaa.
  // Raja 2,8 päästää läpi hieman yli lineaarisen (lajittelu on n log n)
  // mutta kaataa neliöllisen selvästi.
  const pieni = readsFor(100);
  const iso = readsFor(200);

  const kerroin = iso / pieni;

  assert.ok(pieni > 0, 'syötettä ei luettu lainkaan — mittaus ei toimi');
  assert.ok(kerroin < 2.8,
    `kaksinkertainen syöte luki syötettä ${kerroin.toFixed(1)}× — `
    + 'kasvu näyttää neliölliseltä');
});

test('KRIITTINEN: riippuvuustasot eivät ole neliöllisiä', () => {
  const mittaa = count => {
    const { tasks } = portfolio(count);
    const wrapped = tasks.map(counting);
    counting.total = 0;
    dependencyLevels(wrapped);
    return counting.total;
  };

  const kerroin = mittaa(200) / mittaa(100);
  assert.ok(kerroin < 2.8,
    `riippuvuustasojen kasvu on ${kerroin.toFixed(1)}× — näyttää neliölliseltä`);
});

test('KRIITTINEN: kapasiteettilaskenta kasvaa päivien mukaan, ei tehtävien neliönä', () => {
  const mittaa = count => {
    const { tasks, routines } = portfolio(count);
    const wrapped = tasks.map(counting);
    counting.total = 0;
    horizonCapacity({
      tasks: wrapped, fromIso: TODAY, toIso: HORIZON_END, routines
    });
    return counting.total;
  };

  const kerroin = mittaa(200) / mittaa(100);
  assert.ok(kerroin < 2.8,
    `kapasiteetin kasvu on ${kerroin.toFixed(1)}× — näyttää neliölliseltä`);
});

// =====================================================================
// REALISTINEN SALKKU TOIMII
// =====================================================================

test('kymmenen tavoitetta ja sata tehtävää suunnitellaan loppuun', () => {
  const { goals, tasks, routines } = portfolio(100);

  const result = planHorizon({
    tasks, goals, fromIso: TODAY, toIso: HORIZON_END, routines
  });

  // Jokainen siirrettävä ja keskeneräinen tehtävä joko sijoitetaan tai
  // päätyy `unplaced`-listalle. Yksikään ei katoa.
  const ehdokkaat = tasks.filter(task =>
    !task.completed && !(task.time && task.schedulingState !== 'auto')).length;

  assert.equal(result.placements.length + result.unplaced.length, ehdokkaat,
    'osa tehtävistä katosi suunnittelussa');
});

test('KRIITTINEN: sijoitus ei ylitä yhdenkään päivän kapasiteettia', () => {
  const { goals, tasks, routines } = portfolio(100);

  const result = planHorizon({
    tasks, goals, fromIso: TODAY, toIso: HORIZON_END, routines
  });

  for (const day of result.days) {
    assert.ok(day.remainingMinutes >= 0,
      `päivän ${day.dateIso} kapasiteetti ylittyi ${-day.remainingMinutes} min`);
  }
});

test('portfolion ristiriita havaitaan kymmenellä tavoitteella', () => {
  const { goals, tasks } = portfolio(100);

  const entries = goals.map(goal => ({
    goal,
    remaining: remainingWork(tasks.filter(task => task.goalId === goal.id))
  }));

  // Pieni kapasiteetti: kymmenen tavoitetta ei mahdu.
  const found = detectPortfolioConflicts(entries, {
    totalUsableMinutes: 60, dayCount: 1, days: []
  });

  assert.equal(found.length, 1);
  assert.match(found[0].message, /Erikseen jokainen voi olla mahdollinen/);
});

test('ristiriitojen tunnistus kestää sadan tehtävän salkun', () => {
  const { goals, tasks, milestones } = portfolio(100);

  const capacity = horizonCapacity({ tasks, fromIso: TODAY, toIso: HORIZON_END });
  const remaining = remainingWork(tasks);

  const conflicts = detectAllConflicts({
    goal: goals[0],
    goals,
    milestones,
    tasks,
    remaining,
    capacity,
    portfolioEntries: goals.map(goal => ({
      goal,
      remaining: remainingWork(tasks.filter(task => task.goalId === goal.id))
    })),
    todayIso: TODAY
  });

  // Tulos on järjestetty ja deterministinen.
  assert.ok(Array.isArray(conflicts));
  const toinen = detectAllConflicts({
    goal: goals[0], goals, milestones, tasks, remaining, capacity,
    portfolioEntries: goals.map(goal => ({
      goal,
      remaining: remainingWork(tasks.filter(task => task.goalId === goal.id))
    })),
    todayIso: TODAY
  });
  assert.deepEqual(conflicts.map(c => c.code), toinen.map(c => c.code));
});

test('uudelleensuunnittelu kestää sadan tehtävän salkun', () => {
  const { goals, tasks, routines } = portfolio(100);

  const proposal = buildReplanProposal({
    trigger: 'manual', tasks, goals, routines, todayIso: TODAY, automationLevel: 1
  });

  assert.ok(Array.isArray(proposal.changes));
  // Taso 1 ei toteuta mitään automaattisesti, oli muutoksia kuinka paljon
  // tahansa.
  assert.equal(proposal.automatic.length, 0);
});

test('edistyminen ja ennuste lasketaan kymmenelle tavoitteelle', () => {
  const { goals, tasks, milestones } = portfolio(100);
  const capacity = horizonCapacity({ tasks, fromIso: TODAY, toIso: '2026-12-01' });

  for (const goal of goals) {
    const omat = tasks.filter(task => task.goalId === goal.id);
    const progress = computeProgress(goal, { tasks, milestones });
    const forecast = forecastGoal({
      goal,
      remaining: remainingWork(omat),
      capacity,
      tasks: omat,
      todayIso: TODAY
    });

    assert.ok(typeof progress.known === 'boolean');
    assert.ok(forecast.state);
    // Tuntematon edistyminen ei saa muuttua nollaksi missään kohtaa.
    if (!progress.known) assert.equal(progress.percent, null);
  }
});

test('suunnittelu on deterministinen suurellakin salkulla', () => {
  const first = planHorizon({
    ...portfolio(100), fromIso: TODAY, toIso: HORIZON_END
  });
  const second = planHorizon({
    ...portfolio(100), fromIso: TODAY, toIso: HORIZON_END
  });

  assert.deepEqual(
    first.placements.map(p => `${p.taskId}@${p.toDateIso}`),
    second.placements.map(p => `${p.taskId}@${p.toDateIso}`));
});
