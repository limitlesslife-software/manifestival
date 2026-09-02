// Suorituskyky suurilla aineistoilla.
//
// Aineisto rakennetaan SIEMENELLISELLÄ generaattorilla, joten jokainen ajo
// käyttää täsmälleen samaa dataa. Ilman sitä mittaus kertoisi enemmän
// satunnaisluvuista kuin koodista.
//
// RAJAT OVAT VÄLJÄT TARKOITUKSELLA. Nämä eivät ole suorituskykytavoitteita
// vaan pysähtymisvahteja: ne kaatuvat jos joku vahingossa tekee
// silmukasta neliöllisen, mutta eivät siksi että kone on hetken hidas.
// Mitatut ajat ovat kertaluokkaa pienemmät kuin rajat.
//
// Todelliset mittaukset: docs/audits/OVERNIGHT-PERFORMANCE.md

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeTask } from '../src/domain/task.js';
import { normalizeRoutine, RECURRENCE, expandRoutines } from '../src/domain/routine.js';
import { normalizeGoal } from '../src/domain/goal.js';
import { normalizeProject } from '../src/domain/project.js';
import { normalizeBill } from '../src/domain/finance.js';
import { buildDayPlan, proposeSchedule } from '../src/domain/scheduler.js';
import { planNotifications } from '../src/domain/notification.js';
import { searchAll } from '../src/domain/search.js';
import { summarizeFinances } from '../src/domain/finance.js';

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

const pad = n => String(n).padStart(2, '0');
const dayOf = i => `2026-${pad(1 + (i % 12))}-${pad(1 + (i % 28))}`;

function fixtures() {
  const random = seeded(12345);

  const tasks = [];
  for (let i = 0; i < 1000; i++) {
    tasks.push(normalizeTask({
      id: 't' + i, title: 'Tehtävä ' + i, date: dayOf(i),
      time: random() < 0.5 ? pad(7 + Math.floor(random() * 12)) + ':00' : null,
      durationMinutes: 15 + Math.floor(random() * 90),
      completed: random() < 0.3
    }));
  }

  const routines = [];
  for (let i = 0; i < 500; i++) {
    routines.push(normalizeRoutine({
      id: 'r' + i, title: 'Rutiini ' + i, active: true,
      preferredTime: pad(6 + (i % 16)) + ':00',
      recurrence: { type: RECURRENCE.DAILY, weekdays: [] }
    }));
  }

  const goals = [];
  for (let i = 0; i < 200; i++) goals.push(normalizeGoal({ id: 'g' + i, title: 'Tavoite ' + i }));

  const projects = [];
  for (let i = 0; i < 200; i++) projects.push(normalizeProject({ id: 'p' + i, name: 'Projekti ' + i }));

  const bills = [];
  for (let i = 0; i < 1000; i++) {
    bills.push(normalizeBill({
      id: 'b' + i, name: 'Lasku ' + i, amountMinor: 1000 + i, dueDate: dayOf(i)
    }));
  }

  return { tasks, routines, goals, projects, bills };
}

/** Millisekunteina. */
function timed(fn) {
  const started = process.hrtime.bigint();
  const value = fn();
  return { ms: Number(process.hrtime.bigint() - started) / 1e6, value };
}

const DATA = fixtures();

test('päiväsuunnitelma tuhannella tehtävällä', () => {
  const { ms, value } = timed(() =>
    buildDayPlan({ tasks: DATA.tasks, profile: {}, dateIso: '2026-09-10' }));

  assert.ok(value, 'suunnitelmaa ei syntynyt');
  assert.ok(ms < 500, `päiväsuunnitelma kesti ${ms.toFixed(1)} ms`);
});

test('aikatauluehdotus tuhannella tehtävällä', () => {
  const { ms } = timed(() =>
    proposeSchedule({ tasks: DATA.tasks, profile: {}, dateIso: '2026-09-10' }));

  assert.ok(ms < 500, `ehdotus kesti ${ms.toFixed(1)} ms`);
});

test('rutiinien laajennus 500 rutiinilla 30 päivälle', () => {
  // Raskain yksittäinen operaatio: 500 × 30 = 15 000 esiintymää.
  const { ms, value } = timed(() => expandRoutines({
    routines: DATA.routines, from: '2026-09-01', to: '2026-09-30', exceptions: []
  }));

  assert.ok(value.length > 10000, 'esiintymiä syntyi odotettua vähemmän: ' + value.length);
  assert.ok(ms < 2000, `laajennus kesti ${ms.toFixed(1)} ms`);
});

test('muistutusten suunnittelu tuhannella tehtävällä', () => {
  const { ms } = timed(() => planNotifications({
    tasks: DATA.tasks, dateIso: '2026-09-10', todayIso: '2026-09-10',
    preferences: { enabled: true, maxPerDay: 20 }
  }));

  assert.ok(ms < 500, `muistutusten suunnittelu kesti ${ms.toFixed(1)} ms`);
});

test('haku 2400 tietueen yli', () => {
  const { ms, value } = timed(() => searchAll({
    query: 'tehtävä',
    collections: {
      tasks: DATA.tasks, goals: DATA.goals,
      projects: DATA.projects, bills: DATA.bills
    }
  }));

  assert.ok(value, 'hakutulosta ei syntynyt');
  assert.ok(ms < 500, `haku kesti ${ms.toFixed(1)} ms`);
});

test('talousyhteenveto tuhannella laskulla', () => {
  const { ms } = timed(() => summarizeFinances({
    bills: DATA.bills, recurringExpenses: [], savingsGoals: [], todayIso: '2026-09-10'
  }));

  assert.ok(ms < 500, `yhteenveto kesti ${ms.toFixed(1)} ms`);
});

test('KRIITTINEN: kasvu on lineaarista, ei neliöllistä', () => {
  // Neliöllinen silmukka on helppo kirjoittaa vahingossa ja näkyy vasta
  // oikealla aineistolla. Tämä testi ei mittaa nopeutta vaan MUOTOA:
  // kymmenkertainen syöte ei saa maksaa satakertaisesti.
  const mk = n => {
    const tasks = [];
    for (let i = 0; i < n; i++) {
      tasks.push(normalizeTask({
        id: 't' + i, title: 'Tehtävä ' + i, date: '2026-09-10',
        time: pad(7 + (i % 12)) + ':00', durationMinutes: 30
      }));
    }
    return tasks;
  };

  const run = tasks => timed(() =>
    proposeSchedule({ tasks, profile: {}, dateIso: '2026-09-10' })).ms;

  run(mk(500));            // lämmittely: ensimmäinen ajo sisältää JIT-kustannuksen
  const pieni = run(mk(500));
  const suuri = run(mk(5000));

  // Kymmenkertainen syöte. Lineaarinen olisi ~10x, neliöllinen ~100x.
  // Raja 30x jättää tilaa mittausvaihtelulle mutta kaataa neliöllisen.
  const suhde = suuri / Math.max(pieni, 0.05);
  assert.ok(suhde < 30,
    `kymmenkertainen syöte maksoi ${suhde.toFixed(1)}x — kasvu ei ole lineaarista`);
});

test('suuri aineisto ei tuota epädeterministä tulosta', () => {
  // Suorituskykyoptimointi on tavallinen tapa rikkoa determinismi
  // vahingossa (esim. järjestäminen epävakaalla vertailulla).
  const args = { tasks: DATA.tasks, profile: {}, dateIso: '2026-09-10' };

  const first = JSON.stringify(proposeSchedule(args));
  for (let i = 0; i < 3; i++) {
    assert.equal(JSON.stringify(proposeSchedule(args)), first,
      'ehdotus vaihteli suurella aineistolla kierroksella ' + i);
  }
});
