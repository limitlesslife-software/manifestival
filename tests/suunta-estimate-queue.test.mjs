// Suunta Day 1 — F4: kestoarvioiden jono.
//
// Domain: järjestys tänään -> muu viikko -> ensi viikko, rästit vain
// pyydettäessä, valmiit/herätykset/arvioidut pois, rutiini kerran,
// prioriteetti- ja määräaikajärjestys.
// Näkymä: jono kiinnitetään avattaessa, "Ohita" ei kirjoita, "Kumoa"
// palauttaa, painikkeet eivät reagoi tallennuksen aikana eivätkä heti sen
// jälkeen, "Valmis tältä erää" sulkee, Tekeminen näyttää laskurin.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { read } from './helpers/sources.mjs';
import { freezeLocalDate } from './helpers/clock.mjs';
import { fakeClient } from './helpers/gates.mjs';
import { setUser, clearUser } from '../src/data/session.js';
import { setClient } from '../src/data/client.js';
import { resetState, getState, setTasks, setRoutines } from '../src/app/state.js';
import { clearLocalUserData } from '../src/app/actions.js';
import { createLifeArea, resetAppliedAdjustments, analyzeCurrentWeek } from '../src/app/alignment.js';
import {
  renderDirection, initDirection, resetDirectionView, estimateQueueCount, ESTIMATE_REARM_MS
} from '../src/app/views/direction.js';
import { renderTasks } from '../src/app/views/tasks.js';
import { estimateCandidates, countByBucket } from '../src/domain/estimateQueue.js';
import { normalizeTask } from '../src/domain/task.js';
import { normalizeRoutine } from '../src/domain/routine.js';

const USER = { id: 'dddddddd-4444-4444-8444-00000000004f', email: 'queue@example.com' };
const THURSDAY = '2026-09-17';
const WEEK = '2026-09-14';

const task = (id, date, extra = {}) => normalizeTask({ id, title: 'Tehtävä ' + id, date, ...extra });

// ================================================================ DOMAIN

test('F4 domain: tänään ensin, sitten muu viikko päivän mukaan, sitten ensi viikko; rästit vain pyydettäessä', () => {
  const tasks = [
    task('next', '2026-09-22'),
    task('sat', '2026-09-19'),
    task('today', THURSDAY),
    task('mon', '2026-09-14'),
    task('old', '2026-08-30'),
    task('far', '2026-10-15')
  ];
  const keys = estimateCandidates({ tasks, todayIso: THURSDAY }).map(c => c.id);
  assert.deepEqual(keys, ['today', 'mon', 'sat', 'next'], 'kaukainen tulevaisuus ei kuulu jonoon');
  const withOverdue = estimateCandidates({ tasks, todayIso: THURSDAY, includeOverdue: true });
  assert.deepEqual(withOverdue.map(c => c.id), ['today', 'mon', 'sat', 'next', 'old']);
  assert.deepEqual(withOverdue.map(c => c.bucket), ['today', 'week', 'week', 'next', 'overdue']);
  assert.deepEqual(estimateCandidates({ tasks, todayIso: THURSDAY, includeNextWeek: false }).map(c => c.id),
    ['today', 'mon', 'sat']);
  assert.deepEqual(countByBucket(withOverdue), { today: 1, week: 2, next: 1, overdue: 1 });
});

test('F4 domain: valmiit, herätykset ja jo arvioidut (myös aikavälistä) eivät ole jonossa', () => {
  const tasks = [
    task('done', THURSDAY, { completed: true }),
    task('wake', THURSDAY, { isWake: true, time: '07:00' }),
    task('estimated', THURSDAY, { durationMinutes: 30 }),
    task('ranged', THURSDAY, { time: '10:00', endTime: '11:00' }),
    task('open', THURSDAY)
  ];
  assert.deepEqual(estimateCandidates({ tasks, todayIso: THURSDAY }).map(c => c.id), ['open']);
});

test('F4 domain: saman päivän sisällä prioriteetti, sitten määräaika (puuttuva viimeisenä), sitten tunniste', () => {
  const tasks = [
    task('b-normal-late', THURSDAY, { deadline: '2026-09-30' }),
    task('a-normal-none', THURSDAY),
    task('c-low', THURSDAY, { priority: 'matala' }),
    task('d-high', THURSDAY, { priority: 'korkea' }),
    task('e-normal-soon', THURSDAY, { deadline: '2026-09-18' }),
    task('f-normal-none', THURSDAY)
  ];
  assert.deepEqual(estimateCandidates({ tasks, todayIso: THURSDAY }).map(c => c.id),
    ['d-high', 'e-normal-soon', 'b-normal-late', 'a-normal-none', 'f-normal-none', 'c-low']);
  // Sama syöte eri järjestyksessä -> sama jono.
  assert.deepEqual(estimateCandidates({ tasks: [...tasks].reverse(), todayIso: THURSDAY }).map(c => c.id),
    ['d-high', 'e-normal-soon', 'b-normal-late', 'a-normal-none', 'f-normal-none', 'c-low']);
});

test('F4 domain: rutiini on jonossa kerran (sääntö), ei jokaisena esiintymänä', () => {
  // Rutiinilla on aina kesto normalisoinnin jälkeen, joten "arvioimaton"
  // rutiini syntyy vain esiintymästä ilman kestoa: testi rakentaa sen suoraan.
  const routine = { ...normalizeRoutine({ id: 'r1', title: 'Venyttely', recurrence: { type: 'daily' } }), durationMinutes: null };
  const candidates = estimateCandidates({ tasks: [], routines: [routine], todayIso: THURSDAY });
  assert.equal(candidates.filter(c => c.kind === 'routine').length, 1);
  assert.equal(candidates[0].key, 'routine:r1');
  assert.equal(candidates[0].date, '2026-09-14', 'ensimmäinen esiintymä näytetyllä viikolla');
  const estimated = normalizeRoutine({ id: 'r2', title: 'Kävely', recurrence: { type: 'daily' }, durationMinutes: 20 });
  assert.equal(estimateCandidates({ routines: [estimated], todayIso: THURSDAY }).length, 0);
});

test('F4 domain: 36 arvioimatonta tehtävää ei pakota 36 kysymystä — rästit ja kaukaiset jäävät pois oletuksena', () => {
  const tasks = [];
  for (let i = 0; i < 20; i++) tasks.push(task('o' + i, `2026-08-${String(10 + i).padStart(2, '0')}`));
  for (let i = 0; i < 8; i++) tasks.push(task('w' + i, `2026-09-${String(14 + (i % 7)).padStart(2, '0')}`));
  for (let i = 0; i < 8; i++) tasks.push(task('f' + i, `2026-10-${String(10 + i).padStart(2, '0')}`));
  assert.equal(tasks.length, 36);
  assert.equal(estimateCandidates({ tasks, todayIso: THURSDAY }).length, 8);
  assert.equal(estimateCandidates({ tasks, todayIso: THURSDAY, includeOverdue: true }).length, 28);
});

// ================================================================ NÄKYMÄ

const HTML_IDS = new Set([...read('index.html').matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));

function stubElement(id = null) {
  const listeners = {};
  const classes = new Set();
  const attributes = {};
  return {
    id, innerHTML: '', textContent: '', value: '', checked: false, disabled: false, hidden: false,
    style: {}, dataset: {},
    classList: {
      add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c),
      toggle: (c, on) => { if (on ?? !classes.has(c)) classes.add(c); else classes.delete(c); }
    },
    setAttribute: (k, v) => { attributes[k] = String(v); },
    getAttribute: k => attributes[k] ?? null,
    removeAttribute: k => { delete attributes[k]; },
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
    removeEventListener: () => {},
    dispatch: (type, event) => (listeners[type] || []).map(fn => fn(event)),
    focus() { globalThis.document.activeElement = this; },
    scrollIntoView() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    insertAdjacentHTML() {},
    appendChild: () => {},
    remove: () => {},
    closest: () => null
  };
}

function installDom() {
  const elements = new Map();
  globalThis.document = {
    activeElement: null,
    getElementById(id) {
      if (!HTML_IDS.has(id)) return null;
      if (!elements.has(id)) elements.set(id, stubElement(id));
      return elements.get(id);
    },
    createElement: () => stubElement(),
    querySelectorAll: () => [],
    body: { appendChild: () => {} }
  };
  globalThis.CSS = { escape: value => String(value) };
}

function installStorage() {
  const data = new Map();
  globalThis.localStorage = {
    getItem: key => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => { data.set(key, String(value)); },
    removeItem: key => { data.delete(key); },
    key: index => [...data.keys()][index] ?? null,
    get length() { return data.size; }
  };
}

const node = id => globalThis.document.getElementById(id);
const html = id => node(id).innerHTML;
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Tapahtuma, jonka kohde vastaa jokaiseen valitsimen osaan, jonka data-attribuutti sillä on. */
function eventFor(dataset, props = {}) {
  const target = { dataset, disabled: false, ...props };
  const matches = selector => selector.split(',').some(part => {
    const match = /\[data-([a-z-]+)\]/.exec(part.trim());
    return Boolean(match) && dataset[match[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase())] !== undefined;
  });
  target.closest = selector => (matches(selector) ? target : null);
  return { target, key: props.key, preventDefault() {} };
}

let client;
beforeEach(() => {
  clearUser();
  clearLocalUserData();
  resetState();
  resetAppliedAdjustments();
  resetDirectionView();
  installStorage();
  installDom();
  setUser(USER);
  client = fakeClient({ data: [], error: null });
  setClient(client);
});

afterEach(() => {
  delete globalThis.document;
  delete globalThis.CSS;
  delete globalThis.localStorage;
});

async function openQueue() {
  await createLifeArea({ name: 'Työ', importance: 4, targetMinutesPerWeek: 600, categoryKey: 'tyo' });
  setTasks([
    task('t1', THURSDAY, { title: 'Raportti', category: 'tyo' }),
    task('t2', '2026-09-18', { title: 'Palaveri', category: 'tyo' }),
    task('t3', '2026-09-22', { title: 'Suunnitelma', category: 'tyo' }),
    task('old', '2026-08-20', { title: 'Vanha rästi', category: 'tyo' })
  ]);
  initDirection();
  node('dirOpenEstimate').dispatch('click');
}

const activeKey = () => (/data-queue-card="([^"]+)"/.exec(html('dirEstimate')) || [])[1];

test('F4 UI: yksi kortti kerrallaan, järjestys kiinnitetään avattaessa; otsikko "Arvioitu n/N"', async (t) => {
  freezeLocalDate(t, THURSDAY);
  await openQueue();
  const markup = html('dirEstimate');
  assert.equal((markup.match(/data-queue-card=/g) || []).length, 1, 'yksi aktiivinen kortti');
  assert.equal(activeKey(), 'task:t1');
  assert.match(markup, /Arvioitu 0\/3/);
  assert.match(markup, /Seuraavaksi: Palaveri · Suunnitelma/);
  for (const label of ['10 min', '30 min', '1 h', '2 h', 'Muu…', 'Ohita']) assert.ok(markup.includes(`>${label}</button>`), label);
  assert.match(markup, /Näytä myös rästit \(1\)/, 'rästit vain pyydettäessä');
  assert.match(markup, /Valmis tältä erää/);
  // Uusi tehtävä tilassa ei muuta avattua jonoa.
  setTasks([...getState().tasks, task('t0', THURSDAY, { title: 'Uusi kiireellinen', priority: 'korkea' })]);
  renderDirection();
  assert.equal(activeKey(), 'task:t1', 'kiinnitetty jono ei järjesty uudelleen');
  assert.match(html('dirEstimate'), /Arvioitu 0\/3/);
});

/**
 * Asiakas, jonka tehtäväpäivitys odottaa vapautusta: tallennus on
 * "kesken" niin kauan kuin testi haluaa.
 */
function gatedClient() {
  const base = fakeClient({ data: [], error: null });
  let gate = null;
  return {
    calls: base.calls,
    hold() {
      let release;
      gate = new Promise(resolve => { release = resolve; });
      return () => { gate = null; release(); };
    },
    from(table) {
      const api = base.from(table);
      const wrap = op => payload => {
        const query = api[op](payload);
        const held = gate;
        if (table !== 'tasks' || op !== 'update' || !held) return query;
        const then = query.then;
        query.then = (resolve, reject) => held.then(() => then.call(query, resolve, reject));
        return query;
      };
      return { select: wrap('select'), insert: wrap('insert'), update: wrap('update'), upsert: wrap('upsert'), delete: wrap('delete') };
    }
  };
}

test('F4 UI: arvio tallentuu, kortti vaihtuu vasta tallennuksen jälkeen, toinen napautus samaan korttiin ohitetaan', async (t) => {
  freezeLocalDate(t, THURSDAY);
  const gated = gatedClient();
  setClient(gated);
  await openQueue();
  const release = gated.hold();
  node('dirEstimate').dispatch('click', eventFor({ queueEstimate: 'task:t1', minutes: '30' }));
  await flush();
  // Tallennus kesken: kortti pysyy, painikkeet pois käytöstä.
  assert.equal(activeKey(), 'task:t1');
  assert.match(html('dirEstimate'), /data-queue-estimate="task:t1" data-minutes="10" disabled/);
  node('dirEstimate').dispatch('click', eventFor({ queueEstimate: 'task:t1', minutes: '60' }));
  node('dirEstimate').dispatch('click', eventFor({ queueEstimate: 'task:t2', minutes: '60' }));
  await flush();
  release();
  await flush();
  const calls = gated.calls.filter(call => call.table === 'tasks' && call.operation === 'update').length;
  assert.equal(calls, 1, 'vain yksi tallennus');
  assert.equal(getState().tasks.find(x => x.id === 't1').durationMinutes, 30);
  assert.equal(getState().tasks.find(x => x.id === 't2').durationMinutes, null, 'seuraavaa ei arvioitu lukematta');
  assert.equal(activeKey(), 'task:t2');
  assert.match(html('dirEstimate'), /Arvioitu 1\/3/);
  // Seuraava kortti herää vasta hetken päästä: nopea kaksoisnapautus ei osu siihen.
  assert.match(html('dirEstimate'), /data-queue-estimate="task:t2" data-minutes="10" disabled data-armed="0"/);
  node('dirEstimate').dispatch('click', eventFor({ queueEstimate: 'task:t2', minutes: '10' }));
  await flush();
  assert.equal(getState().tasks.find(x => x.id === 't2').durationMinutes, null);
  await sleep(ESTIMATE_REARM_MS + 50);
  assert.match(html('dirEstimate'), /data-queue-estimate="task:t2" data-minutes="10" data-armed="1"/);
});

test('F4 UI: "Ohita" etenee kirjoittamatta mitään, eikä ohitusta muisteta', async (t) => {
  freezeLocalDate(t, THURSDAY);
  await openQueue();
  const before = client.calls.length;
  node('dirEstimate').dispatch('click', eventFor({ queueSkip: 'task:t1' }));
  await flush();
  assert.equal(activeKey(), 'task:t2');
  assert.equal(client.calls.length, before, 'ohitus ei kirjoita');
  assert.equal(getState().alignmentItemSettings.length, 0);
  assert.equal(globalThis.localStorage.length, 0, 'ohitusta ei tallenneta laitteelle');
  // Uusi avaus = uusi jono: ohitettu on taas mukana.
  await sleep(ESTIMATE_REARM_MS + 20);
  node('dirOpenEstimate').dispatch('click');
  assert.equal(activeKey(), 'task:t1');
});

test('F4 UI: "Kumoa" palauttaa arvion tuntemattomaksi ja arvioimattomien määrän', async (t) => {
  freezeLocalDate(t, THURSDAY);
  await openQueue();
  const unknownBefore = analyzeCurrentWeek(WEEK).planned.unknownCount;
  node('dirEstimate').dispatch('click', eventFor({ queueEstimate: 'task:t1', minutes: '60' }));
  await flush();
  assert.equal(getState().tasks.find(x => x.id === 't1').durationMinutes, 60);
  assert.equal(analyzeCurrentWeek(WEEK).planned.unknownCount, unknownBefore - 1);
  assert.match(html('dirEstimate'), /data-queue-undo="task:t1"/);
  assert.match(html('dirEstimate'), /aria-label="Kumoa arvio: Raportti"/);
  node('dirEstimate').dispatch('click', eventFor({ queueUndo: 'task:t1' }));
  await flush();
  assert.equal(getState().tasks.find(x => x.id === 't1').durationMinutes, null);
  // Asetus palautuu (oletusarvoinen rivi voi myös poistua kokonaan).
  assert.notEqual(getState().alignmentItemSettings.find(s => s.itemId === 't1')?.estimateApproximate, true);
  assert.equal(analyzeCurrentWeek(WEEK).planned.unknownCount, unknownBefore);
  assert.equal(activeKey(), 'task:t1', 'kumottu palaa aktiiviseksi jonon järjestyksessä');
});

test('F4 UI: "Muu…" avaa kentän (step=1), Enter tallentaa kirjoitetun keston', async (t) => {
  freezeLocalDate(t, THURSDAY);
  await openQueue();
  node('dirEstimate').dispatch('click', eventFor({ queueCustom: 'task:t1' }));
  const markup = html('dirEstimate');
  assert.match(markup, /<input type="number" min="1" max="1440" step="1" inputmode="numeric" id="dirQueueCustom-main"/);
  assert.match(markup, /<label class="field-label" for="dirQueueCustom-main">Kesto minuutteina<\/label>/);
  node('dirEstimate').dispatch('keydown', eventFor({ queueInput: 'task:t1' }, { key: 'Enter', value: '25' }));
  await flush();
  assert.equal(getState().tasks.find(x => x.id === 't1').durationMinutes, 25);
});

test('F4 UI: rästit tulevat jonoon vain pyydettäessä, jonon perään', async (t) => {
  freezeLocalDate(t, THURSDAY);
  await openQueue();
  node('dirEstimate').dispatch('click', eventFor({ queueOverdue: '1' }));
  assert.match(html('dirEstimate'), /Arvioitu 0\/4/);
  assert.equal(activeKey(), 'task:t1', 'rästi ei ohita tämän päivän asiaa');
  assert.doesNotMatch(html('dirEstimate'), /Näytä myös rästit/);
});

test('F4 UI: "Valmis tältä erää" sulkee osion; jonon ulkopuolelta arvioitu ei jää jonoon', async (t) => {
  freezeLocalDate(t, THURSDAY);
  await openQueue();
  // Arvio muualla (esim. tehtävälomake): jono siirtyy seuraavaan.
  setTasks(getState().tasks.map(x => (x.id === 't1' ? { ...x, durationMinutes: 45 } : x)));
  renderDirection();
  assert.equal(activeKey(), 'task:t2');
  node('dirEstimate').dispatch('click', eventFor({ queueFinish: '1' }));
  assert.equal(node('dirEstimateSection').hidden, true);
});

test('F4: Tekeminen näyttää "Arvioi kestot (N)" vain, kun jonossa on jotain', async (t) => {
  freezeLocalDate(t, THURSDAY);
  setTasks([task('a', THURSDAY), task('b', '2026-09-23'), task('c', '2026-08-01'), task('d', THURSDAY, { durationMinutes: 20 })]);
  assert.equal(estimateQueueCount(), 2, 'tämä ja ensi viikko, ei rästejä eikä arvioituja');
  renderTasks();
  assert.equal(node('tasksEstimateBtn').hidden, false);
  assert.equal(node('tasksEstimateBtn').textContent, 'Arvioi kestot (2)');
  setTasks([task('d', THURSDAY, { durationMinutes: 20 })]);
  renderTasks();
  assert.equal(node('tasksEstimateBtn').hidden, true);
  assert.match(read('index.html'), /<button class="assist-btn tasks-estimate-btn" id="tasksEstimateBtn" type="button" hidden>/);
});

test('F4 UI: arviojono on saavutettava — painikkeilla nimi, ryhmä nimetty otsikolla, 44 px', async (t) => {
  freezeLocalDate(t, THURSDAY);
  await openQueue();
  const markup = html('dirEstimate');
  assert.match(markup, /<h3 class="assist-title dir-queue-title" id="dirQueueTitle-main" tabindex="-1">Raportti<\/h3>/);
  assert.match(markup, /role="group" aria-labelledby="dirQueueTitle-main"/);
  assert.match(markup, /role="status">Arvioitu 0\/3/);
  assert.match(markup, /<label class="checkbox-row" for="dirQueueApprox-main">/);
  const css = read('src/styles.css');
  assert.match(css, /\.dir-quick \.assist-btn, \.dir-presets \.assist-btn \{[^}]*min-height:44px/);
  assert.match(css, /\.assist-btn \{[^}]*min-height:44px/);
});
