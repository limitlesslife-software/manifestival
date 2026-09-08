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

/**
 * Laskuriin kääriminen: kuinka monta kertaa algoritmi lukee syötettä?
 *
 * MIKSI TÄMÄ EIKÄ KELLO
 *
 * Kasvun MUOTOA mitattiin ennen seinäkellolla, ja se osoittautui
 * mittavälineeksi joka ei kestä rinnakkaista testiajoa. Mitatut luvut
 * samalla koneella:
 *
 *   yksin ajettuna          suhde 9.6x, otosvaihtelu 4.0x-19.3x
 *   `node --test` -ajossa   suhde 9.7x-20.1x, satunnaisesti yli 30x
 *
 * Syy ei ollut kohina vaan VINOUMA. Pieni pää (500 tehtävää) kestää
 * ~2.5 ms ja ehtii usein kokonaan yhteen aikaviipaleeseen. Suuri pää
 * (5000 tehtävää) kestää kymmenkertaisesti, joten se ehtii AINA
 * keskeytyä useasti ja allokoi enemmän. Pidempi operaatio kerää siis
 * järjestelmällisesti enemmän häiriötä kuin lyhyt, eikä minimin
 * ottaminen korjaa sitä: kaikki suuren pään otokset ovat likaisia.
 *
 * Siksi aikaa ei mitata lainkaan. Tehtäväoliot kääritään getteriin,
 * joka laskee jokaisen kentän luvun. Luku on TÄYSIN DETERMINISTINEN:
 * sama syöte antaa saman luvun joka ajolla, riippumatta koneen
 * kuormasta, kellotaajuudesta tai rinnakkaisista prosesseista.
 *
 * Mitatut arvot:
 *
 *   lineaarinen toteutus   41 894 -> 449 090 lukua   suhde 10.7x
 *   neliöllinen mutaatio  541 894 -> 50 449 090      suhde 93.1x
 *
 * Raja 30x on ENNALLAAN ja on nyt paljon vahvempi kuin ennen: se ei
 * enää riipu siitä, mitä muuta koneella sattuu tapahtumaan.
 *
 * MITÄ TÄMÄ EI NÄE
 *
 * Neliöllisen silmukan, joka ei koske syötteeseen lainkaan. Sellainen
 * on aikataulumoottorissa kuviteltavissa mutta ei realistinen:
 * tehtävien vertailu on juuri se mitä neliöllinen silmukka tekee.
 * Absoluuttinen kattotesti alla vahtii senkin tapauksen.
 */
function countingReads(task) {
  const store = { ...task };
  const wrapped = {};
  for (const key of Object.keys(store)) {
    Object.defineProperty(wrapped, key, {
      enumerable: true,
      get() { countingReads.total += 1; return store[key]; }
    });
  }
  return wrapped;
}
countingReads.total = 0;

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
  // oikealla aineistolla. Tämä testi ei mittaa NOPEUTTA vaan MUOTOA:
  // kymmenkertainen syöte ei saa maksaa satakertaisesti.
  //
  // Mittayksikkö on syötteen lukukertojen määrä, ei aika. Ks.
  // countingReads yllä.
  const mk = n => {
    const tasks = [];
    for (let i = 0; i < n; i++) {
      tasks.push(countingReads(normalizeTask({
        id: 't' + i, title: 'Tehtävä ' + i, date: '2026-09-10',
        time: pad(7 + (i % 12)) + ':00', durationMinutes: 30
      })));
    }
    return tasks;
  };

  const lukuja = tasks => {
    countingReads.total = 0;
    proposeSchedule({ tasks, profile: {}, dateIso: '2026-09-10' });
    return countingReads.total;
  };

  const pienet = mk(500);
  const suuret = mk(5000);

  const pieni = lukuja(pienet);
  const suuri = lukuja(suuret);

  assert.ok(pieni > 0, 'aikataulumoottori ei lukenut syötettä lainkaan');

  // Mittaus on deterministinen: toisto antaa saman luvun. Jos ei anna,
  // moottorissa on tilaa jota ei pitäisi olla, eikä suhde tarkoita
  // mitään.
  assert.equal(lukuja(pienet), pieni,
    'sama syöte tuotti eri määrän lukuja — moottori ei ole puhdas');

  // Kymmenkertainen syöte. Lineaarinen on ~10x, neliöllinen ~93x.
  const suhde = suuri / pieni;
  assert.ok(suhde < 30,
    `kymmenkertainen syöte luki syötettä ${suhde.toFixed(1)}x`
    + ` (${pieni} -> ${suuri}) — kasvu ei ole lineaarista`);
});

test('KRIITTINEN: viisituhatta tehtävää ei jumita sovellusta', () => {
  // Kattotesti neliölliselle silmukalle, joka ei koske syötteeseen.
  // Raja on TARKOITUKSELLA järjetön: mitattu aika on rinnakkaisen
  // testiajon alla 25-65 ms, joten marginaali on yli neljäkymmen-
  // kertainen eikä tämä voi kaatua kuormituksesta. Neliöllinen
  // mutaatio kesti samalla koneella yli 15 sekuntia.
  const tasks = [];
  for (let i = 0; i < 5000; i++) {
    tasks.push(normalizeTask({
      id: 't' + i, title: 'Tehtävä ' + i, date: '2026-09-10',
      time: pad(7 + (i % 12)) + ':00', durationMinutes: 30
    }));
  }

  const { ms } = timed(() =>
    proposeSchedule({ tasks, profile: {}, dateIso: '2026-09-10' }));

  assert.ok(ms < 3000, `viisituhatta tehtävää kesti ${ms.toFixed(0)} ms`);
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
