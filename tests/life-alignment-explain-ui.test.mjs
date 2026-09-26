// Suunta: tekoälyselityksen painike näkymässä.
//
// 1. Oletuksena (AI_EXPLAIN_ENABLED = false) painiketta ei ole: jokaisella
//    havainnolla on jo deterministinen selitys "Miksi tämä näkyy?".
// 2. Päällä painike kertoo käyttävänsä tekoälyä ja mitä laitteelta lähtee.
// 3. Kesken oleva haku pitää painikkeen estettynä myös, kun näkymä
//    renderöidään uudelleen, eikä toinen napautus lähetä toista pyyntöä.
//
// DOM-tynkä on sama kuvio kuin life-alignment-ui-v2.test.mjs:ssä.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { read } from './helpers/sources.mjs';
import { freezeLocalDate } from './helpers/clock.mjs';
import { setUser, clearUser } from '../src/data/session.js';
import { setClient } from '../src/data/client.js';
import { fakeClient } from './helpers/gates.mjs';
import { resetState, setTasks } from '../src/app/state.js';
import { clearLocalUserData } from '../src/app/actions.js';
import { createLifeArea, saveWeeklyCapacity, resetAppliedAdjustments } from '../src/app/alignment.js';
import { saveItemSettings, setTimerRepoForTests } from '../src/app/timeTracking.js';
import { renderDirection, initDirection, resetDirectionView } from '../src/app/views/direction.js';
import { resetTimerStoreForTests } from '../src/data/timerStore.js';
import { normalizeTask } from '../src/domain/task.js';
import { setAiExplainEnabledForTests } from '../src/ai/alignmentExplainClient.js';

const USER = { id: 'dddddddd-4444-4444-8444-00000000000d', email: 'explain-ui@example.com' };
const THURSDAY = '2026-09-17';
const WEEK = '2026-09-14';
const HTML_IDS = new Set([...read('index.html').matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));

function stubElement(id = null) {
  const listeners = {};
  const classes = new Set();
  return {
    id, innerHTML: '', textContent: '', value: '', checked: false, disabled: false, hidden: false,
    style: {}, dataset: {},
    classList: {
      add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c),
      toggle: (c, on) => { if (on ?? !classes.has(c)) classes.add(c); else classes.delete(c); }
    },
    setAttribute: () => {}, getAttribute: () => null, removeAttribute: () => {},
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
    removeEventListener: () => {},
    dispatch: (type, event) => (listeners[type] || []).forEach(fn => fn(event)),
    focus() { globalThis.document.activeElement = this; },
    scrollIntoView() {}, querySelector: () => null, querySelectorAll: () => [],
    appendChild: () => {}, remove: () => {}, closest: () => null
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

const signalsHtml = () => globalThis.document.getElementById('dirSignals').innerHTML;
const signalsNode = () => globalThis.document.getElementById('dirSignals');
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };
function clickOn(selector, dataset) {
  const target = { dataset, disabled: false, textContent: '' };
  return { target: { closest: sel => (sel === selector ? target : null), dataset } };
}
const explainKey = () => {
  const match = /data-explain="(energy_overload:week:[a-z0-9]+)"/.exec(signalsHtml());
  return match ? match[1] : null;
};
/** Havaintokortti, johon avain kuuluu. */
const cardOf = key => {
  const html = signalsHtml();
  const at = html.indexOf(`data-explain="${key}"`);
  return at < 0 ? '' : html.slice(html.lastIndexOf('<div class="dir-signal', at), html.indexOf('</details>', at));
};

let savedFetch;
beforeEach(() => {
  clearUser();
  clearLocalUserData();
  resetState();
  resetAppliedAdjustments();
  resetDirectionView();
  resetTimerStoreForTests();
  setTimerRepoForTests(null);
  setUser(USER);
  setClient(fakeClient({ data: [], error: null }));
  installDom();
  savedFetch = globalThis.fetch;
});

afterEach(() => {
  setAiExplainEnabledForTests(null);
  globalThis.fetch = savedFetch;
  delete globalThis.document;
  delete globalThis.CSS;
});

async function setupWeek() {
  await createLifeArea({ name: 'Perhe', importance: 5, targetMinutesPerWeek: 600, categoryKey: 'perhe' });
  await createLifeArea({ name: 'Työ', importance: 3, targetMinutesPerWeek: 600, categoryKey: 'tyo' });
  await saveWeeklyCapacity({ weekStart: WEEK, availableMinutes: 1200, energyBudgetMinutes: 120 });
  setTasks([normalizeTask({ id: 'w1', title: 'Tehtävä w1', date: THURSDAY, durationMinutes: 300, category: 'tyo' })]);
  await saveItemSettings('task', 'w1', { energyDemand: 5 });
}

test('KATKAISIN pois (oletus): selityspainiketta ei ole, deterministinen selitys on', async (t) => {
  freezeLocalDate(t, THURSDAY);
  await setupWeek();
  initDirection();
  renderDirection();
  const html = signalsHtml();
  assert.match(html, /Viikko on energiakuormaltaan raskas/, 'havainto näkyy');
  assert.match(html, /Miksi tämä näkyy\?/, 'deterministinen selitys on tarjolla');
  assert.equal(html.includes('data-explain'), false, 'ei tekoälypainiketta');
  assert.equal(/Selitä (tekoälyllä|tarkemmin)/.test(html), false);
  assert.equal(html.includes('Lähettää vain luvut'), false);
});

test('KATKAISIN päällä: painike kertoo tekoälystä ja siitä, mitä lähtee', async (t) => {
  freezeLocalDate(t, THURSDAY);
  setAiExplainEnabledForTests(true);
  await setupWeek();
  initDirection();
  renderDirection();
  const key = explainKey();
  assert.ok(key, 'painike sidottu havainnon lukuihin');
  const card = cardOf(key);
  assert.match(card, />Selitä tekoälyllä<\/button>/);
  assert.match(card, /<p class="hint">Lähettää vain luvut, ei nimiä eikä otsikoita\.<\/p>/);
  assert.equal(/data-explain="[^"]+" disabled/.test(card), false, 'ei estetty ennen napautusta');
});

test('REGRESSIO: kesken oleva haku pitää painikkeen estettynä uudelleenrenderöinnin yli', async (t) => {
  freezeLocalDate(t, THURSDAY);
  setAiExplainEnabledForTests(true);
  // Istunnon luku jää odottamaan, jotta haku on kesken renderöinnin ajan.
  let releaseSession;
  let sessionReads = 0;
  const client = fakeClient({ data: [], error: null });
  client.auth = {
    getSession: () => { sessionReads++; return new Promise(resolve => { releaseSession = resolve; }); }
  };
  setClient(client);
  const requests = [];
  globalThis.fetch = async (url) => { requests.push(String(url)); return { ok: false, status: 404, json: async () => ({}) }; };

  await setupWeek();
  initDirection();
  renderDirection();
  const key = explainKey();
  signalsNode().dispatch('click', clickOn('[data-explain]', { explain: key }));
  await flush();

  // Mikä tahansa muu päivitys renderöi näkymän uudelleen kesken haun.
  renderDirection();
  const pending = cardOf(key);
  assert.match(pending, new RegExp(`data-explain="${key}" disabled>Haetaan selitystä…</button>`));

  // Toinen napautus ei käynnistä toista hakua.
  signalsNode().dispatch('click', clickOn('[data-explain]', { explain: key }));
  await flush();
  assert.equal(sessionReads, 1, 'vain yksi haku');

  releaseSession({ data: { session: { access_token: 'token' } } });
  await flush();
  assert.deepEqual(requests, ['/api/explain'], 'yksi pyyntö palvelimelle');
  const done = signalsHtml();
  assert.match(done, /<strong>Selitys:<\/strong>/, '404 -> deterministinen selitys');
  assert.equal(done.includes('Tekoälyn selitys'), false);
  assert.equal(done.includes(`data-explain="${key}"`), false, 'painike korvautui selityksellä');
});

test('uloskirjautuminen tyhjentää kesken olevat haut: seuraava käyttäjä saa painikkeen', async (t) => {
  freezeLocalDate(t, THURSDAY);
  setAiExplainEnabledForTests(true);
  const client = fakeClient({ data: [], error: null });
  client.auth = { getSession: () => new Promise(() => {}) };
  setClient(client);
  await setupWeek();
  initDirection();
  renderDirection();
  const key = explainKey();
  signalsNode().dispatch('click', clickOn('[data-explain]', { explain: key }));
  await flush();
  resetDirectionView();
  renderDirection();
  assert.match(cardOf(key), />Selitä tekoälyllä<\/button>/);
});
