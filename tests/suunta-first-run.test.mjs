// Suunta Day 1 — ensikäyttö (F2), vanha data (F9), kohdistus ilman
// alueita (F3) ja aloituksen käyttäjäkohtainen muisti.
//
// Lähtötilanne on omistajan todellinen: 36 tehtävää ilman kestoa, yksi
// tavoite, yksi projekti, ei rutiineja eikä elämänalueita. Näkymä
// renderöidään index.html:n tunnisteita vastaavaan tynkä-DOMiin (sama
// kuvio kuin life-alignment-ui-v2.test.mjs), kello jäädytetään.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { read } from './helpers/sources.mjs';
import { freezeLocalDate } from './helpers/clock.mjs';
import { fakeClient } from './helpers/gates.mjs';
import { setUser, clearUser } from '../src/data/session.js';
import { setClient } from '../src/data/client.js';
import {
  resetState, getState, setTasks, setGoals, setProjects, setDomainLoadStatus
} from '../src/app/state.js';
import { clearLocalUserData, createGoal } from '../src/app/actions.js';
import {
  createLifeArea, saveWeeklyCapacity, resetAppliedAdjustments, logTime
} from '../src/app/alignment.js';
import { setTimerRepoForTests, currentTimer, cancelTracking } from '../src/app/timeTracking.js';
import { resetTimerStoreForTests } from '../src/data/timerStore.js';
import {
  renderDirection, renderTodayDirection, initDirection, resetDirectionView, openAreaForm
} from '../src/app/views/direction.js';
import { currentSetupProgress } from '../src/app/views/directionSetup.js';
import { getUserPreference, clearDevicePreferences } from '../src/data/preferences.js';
import { normalizeTask } from '../src/domain/task.js';
import { normalizeGoal } from '../src/domain/goal.js';
import { normalizeProject } from '../src/domain/project.js';
import {
  setupProgress, legacySummary, categoryImpact, SETUP_STEPS
} from '../src/domain/alignmentSetup.js';

const USER = { id: 'eeeeeeee-5555-4555-8555-00000000005e', email: 'firstrun@example.com' };
const OTHER = { id: 'ffffffff-6666-4666-8666-00000000006f', email: 'toinen@example.com' };
const THURSDAY = '2026-09-17';
const HTML = read('index.html');
const CSS = read('src/styles.css');
const HTML_IDS = new Set([...HTML.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));

// ------------------------------------------------------------ tynkä-DOM

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
  return data;
}

const node = id => globalThis.document.getElementById(id);
const html = id => node(id).innerHTML;
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };

/** Tapahtuma: kohde vastaa jokaiseen valitsimen osaan, jonka data-attribuutti sillä on. */
function eventFor(dataset, props = {}) {
  const target = { dataset, disabled: false, ...props };
  const matches = selector => selector.split(',').some(part => {
    const match = /\[data-([a-z-]+)\]/.exec(part.trim());
    return Boolean(match) && dataset[match[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase())] !== undefined;
  });
  target.closest = selector => (matches(selector) ? target : null);
  return { target, key: props.key, preventDefault() {} };
}

const setup = () => node('dirSetup');
const click = async dataset => { setup().dispatch('click', eventFor(dataset)); await flush(); };
const change = async (dataset, props) => { setup().dispatch('change', eventFor(dataset, props)); await flush(); };
const stepLine = () => (/Vaihe (\d)\/7/.exec(html('dirSetup')) || [])[1];

let storage;
let client;
beforeEach(() => {
  clearUser();
  clearLocalUserData();
  resetState();
  resetAppliedAdjustments();
  resetDirectionView();
  resetTimerStoreForTests();
  setTimerRepoForTests(null);
  storage = installStorage();
  installDom();
  setUser(USER);
  client = fakeClient({ data: [], error: null });
  setClient(client);
});

afterEach(async () => {
  if (currentTimer()) await cancelTracking({ confirmFn: async () => true }).catch(() => {});
  delete globalThis.document;
  delete globalThis.CSS;
  delete globalThis.localStorage;
});

// ------------------------------------------------------------ lähtötilanne

/**
 * Omistajan tila: 36 avointa tehtävää ilman kestoa, 1 tavoite, 1 projekti.
 * Tavoite luodaan oikealla toiminnolla (tila JA repositorio), jotta sen
 * liittäminen alueeseen toimii kuten sovelluksessa.
 */
async function ownerLegacy() {
  const tasks = [];
  // 6 tällä viikolla (ma–su), 22 rästissä, 8 ensi kuussa.
  for (let i = 0; i < 6; i++) tasks.push(normalizeTask({ id: `w${i}`, title: `Viikko ${i}`, date: `2026-09-${String(14 + i).padStart(2, '0')}`, category: i < 3 ? 'tyo' : 'koti' }));
  for (let i = 0; i < 22; i++) tasks.push(normalizeTask({ id: `o${i}`, title: `Rästi ${i}`, date: `2026-08-${String(1 + i).padStart(2, '0')}`, category: 'tyo' }));
  for (let i = 0; i < 8; i++) tasks.push(normalizeTask({ id: `f${i}`, title: `Tuleva ${i}`, date: `2026-10-${String(10 + i).padStart(2, '0')}`, category: 'hyvinvointi' }));
  setTasks(tasks);
  const created = await createGoal({ title: 'Oma tavoite' });
  assert.equal(created.ok, true);
  setProjects([normalizeProject({ id: 'p1', name: 'Oma projekti', goalId: created.goal.id })]);
  return created.goal;
}

function snapshotLegacy() {
  const state = getState();
  return JSON.stringify({ tasks: state.tasks, goals: state.goals, projects: state.projects });
}

// ================================================================ DOMAIN

test('F2 domain: vaiheet päätellään tiedoista, alue ei ole ohitettavissa', () => {
  const empty = setupProgress({ skipped: ['areas', 'importance', 'targets'] });
  assert.equal(empty.currentKey, 'areas', 'alueen ohitus ei päde');
  assert.equal(empty.steps.find(s => s.key === 'targets').skipped, true);
  const areas = [{ id: 'a', name: 'Perhe', importance: 5, active: true, targetMinutesPerWeek: null }];
  const progress = setupProgress({ areas, goals: [{ id: 'g', status: 'active', lifeAreaId: null }] });
  assert.equal(progress.currentKey, 'targets');
  assert.deepEqual(progress.steps.map(s => s.done), [true, true, false, false, false, true, false]);
  const later = setupProgress({
    areas: [{ ...areas[0], targetMinutesPerWeek: 0 }], capacities: [{ weekStart: '2026-09-07' }],
    goals: [{ id: 'g', status: 'active', lifeAreaId: 'a' }], openUnknownCount: 2, timerRunning: true
  });
  assert.equal(later.currentKey, 'estimates', '0 = "ei nyt" on asetettu tavoite; kapasiteetti kerran riittää');
  const done = setupProgress({
    areas: [{ ...areas[0], targetMinutesPerWeek: 0 }], capacities: [{}], goals: [], openUnknownCount: 0, timerRunning: true
  });
  assert.equal(done.complete, true);
  assert.equal(done.currentIndex, -1);
  // Ohitettu vaihe ei ole keskeneräinen: aloitus etenee.
  assert.equal(setupProgress({ areas, skipped: ['targets', 'capacity'] }).currentKey, 'logging');
  assert.equal(SETUP_STEPS.length, 7);
});

test('F9 domain: vanha data luetaan lukuina — avoimet, tämä viikko, rästit, kategoriat — mitään ei ehdoteta', () => {
  const tasks = [
    normalizeTask({ id: 'a', title: 'A', date: THURSDAY, category: 'tyo' }),
    normalizeTask({ id: 'b', title: 'B', date: '2026-08-01', category: 'tyo' }),
    normalizeTask({ id: 'c', title: 'C', date: THURSDAY, category: 'tyo', completed: true }),
    normalizeTask({ id: 'd', title: 'D', date: THURSDAY, category: 'koti', durationMinutes: 30 }),
    normalizeTask({ id: 'e', title: 'E', date: THURSDAY, category: 'tyo', goalId: 'g1' })
  ];
  const goals = [normalizeGoal({ id: 'g1', title: 'G', status: 'active', lifeAreaId: 'area' }), normalizeGoal({ id: 'g2', title: 'H', status: 'completed' })];
  const summary = legacySummary({ tasks, goals, projects: [], todayIso: THURSDAY });
  assert.equal(summary.openTasks, 4);
  assert.equal(summary.thisWeekOpen, 3);
  assert.equal(summary.overdueOpen, 1);
  assert.equal(summary.unestimatedThisWeek, 2);
  assert.equal(summary.goals, 1);
  assert.equal(summary.goalsWithoutArea, 1, 'alue ilman olemassa olevaa aluetta ei ole liitetty');
  // Kategorian vaikutus: vain ne, joiden alue ratkeaisi kategorian kautta.
  const areas = [{ id: 'area', name: 'Työ', active: true, categoryKey: null }];
  const impact = categoryImpact(tasks, [], 'tyo', { goals, areas, todayIso: THURSDAY });
  assert.deepEqual(impact, { tasks: 2, thisWeek: 1, routines: 0 }, 'tavoitteen kautta alueessa oleva ei laske, valmis ei laske');
});

// ================================================================ ENSIKÄYTTÖ

test('F2 KRIITTINEN: 0 aluetta -> aloitus vaiheessa 1/7, muu Suunta väistyy; aluetta ei voi ohittaa', async (t) => {
  freezeLocalDate(t, THURSDAY);
  await ownerLegacy();
  initDirection();
  renderDirection();
  assert.equal(setup().hidden, false);
  assert.equal(stepLine(), '1');
  assert.ok(node('screen-direction').classList.contains('dir-setup-active'));
  const markup = html('dirSetup');
  assert.match(markup, /<h2 class="dir-setup-title" id="dirSetupTitle" tabindex="-1">Mitkä elämäsi alueet ovat sinulle tärkeitä\?<\/h2>/);
  assert.equal((markup.match(/<h2/g) || []).length, 1, 'yksi otsikko');
  assert.equal((markup.match(/class="hint"/g) || []).length, 1, 'enintään yksi vihje');
  assert.doesNotMatch(markup, /data-setup="skip"/, 'aluetta ei voi ohittaa');
  assert.match(markup, /data-setup="back" data-focus="back" disabled>Takaisin/);
  assert.match(markup, /data-setup="to-importance" data-focus="primary"\s+disabled>Seuraava/);
  assert.match(markup, /Näytä koko Suunta/);
  // Muu Suunta on piilossa CSS:llä, ei poistettu.
  assert.match(CSS, /\.dir-setup-active \.dir-section:not\(\.dir-setup\), \.dir-setup-active #dirQuickActions \{ display:none; \}/);
});

test('F2 KRIITTINEN: valinnat eivät luo mitään ennen "Tallenna alueet"; tärkeyttä ei ole valittu valmiiksi', async (t) => {
  freezeLocalDate(t, THURSDAY);
  await ownerLegacy();
  initDirection();
  renderDirection();
  await click({ setupDraft: 'Perhe' });
  await click({ setupDraft: 'Työ' });
  assert.match(html('dirSetup'), /aria-pressed="true">✓ Perhe<\/button>/, 'valinta näkyy merkkinä, ei vain värinä');
  await click({ setup: 'to-importance' });
  assert.equal(stepLine(), '2');
  assert.equal(getState().lifeAreas.length, 0, 'luonnos ei ole alue');
  assert.equal(client.calls.filter(c => c.table === 'life_areas' && c.operation !== 'select').length, 0);
  let markup = html('dirSetup');
  assert.doesNotMatch(markup, /checked/, 'ei valmiiksi valittua tärkeyttä');
  assert.match(markup, /data-setup="save-areas" data-focus="primary"\s+disabled>Tallenna alueet/);
  assert.match(markup, /<legend>Perhe<\/legend>/);
  // Kategorian kytkentä on erillinen valinta, jossa näkyy vaikutus (F9).
  assert.match(markup, /Laske alueeseen myös kategorian Työ tehtävät\s+\(25 avointa tehtävää\)/);
  await change({ setupImportance: '0' }, { value: '5' });
  assert.match(html('dirSetup'), /data-setup="save-areas" data-focus="primary"\s+disabled>/, 'yksi puuttuu vielä');
  await change({ setupImportance: '1' }, { value: '4' });
  markup = html('dirSetup');
  assert.doesNotMatch(markup, /data-setup="save-areas" data-focus="primary"\s+disabled/);
  await click({ setup: 'save-areas' });
  const areas = getState().lifeAreas;
  assert.deepEqual(areas.map(a => [a.name, a.importance, a.categoryKey]), [['Perhe', 5, null], ['Työ', 4, null]],
    'kategoriaa ei kytketty ilman valintaa');
  assert.equal(stepLine(), '3', 'jatkuu viikkotavoitteisiin');
});

test('F2: kategorian kytkentä vain valittaessa; oma nimi lisätään luonnokseen', async (t) => {
  freezeLocalDate(t, THURSDAY);
  await ownerLegacy();
  initDirection();
  renderDirection();
  await click({ setupDraft: 'Työ' });
  setup().dispatch('input', eventFor({ focus: 'custom-name' }, { value: 'Vapaaehtoistyö' }));
  await click({ setup: 'add-custom' });
  assert.match(html('dirSetup'), /✓ Vapaaehtoistyö/);
  await click({ setup: 'to-importance' });
  await change({ setupImportance: '0' }, { value: '3' });
  await change({ setupImportance: '1' }, { value: '2' });
  await change({ setupCategory: '0' }, { checked: true });
  await click({ setup: 'save-areas' });
  assert.deepEqual(getState().lifeAreas.map(a => [a.name, a.categoryKey]), [['Työ', 'tyo'], ['Vapaaehtoistyö', null]]);
});

test('F2: viikkotavoitteet — "Ei tavoitetta" ja "0 – ei nyt" ovat eri asioita; ei esivalintaa', async (t) => {
  freezeLocalDate(t, THURSDAY);
  await createLifeArea({ name: 'Perhe', importance: 5 });
  await createLifeArea({ name: 'Työ', importance: 3 });
  initDirection();
  renderDirection();
  assert.equal(stepLine(), '3');
  let markup = html('dirSetup');
  for (const label of ['Ei tavoitetta', '0 – ei nyt', '1 h', '3 h', '5 h', '10 h', 'Muu']) assert.ok(markup.includes(label), label);
  assert.doesNotMatch(markup, /checked/);
  const [perhe, tyo] = getState().lifeAreas;
  await change({ setupTarget: perhe.id }, { value: 'custom' });
  setup().dispatch('input', eventFor({ setupTargetHours: perhe.id }, { value: '7,5' }));
  await change({ setupTarget: tyo.id }, { value: '0' });
  markup = html('dirSetup');
  assert.match(markup, new RegExp(`<label class="field-label" for="dirSetupTargetHours-${perhe.id}">Tunteja viikossa: Perhe</label>`));
  await click({ setup: 'save-targets' });
  const [p, w] = getState().lifeAreas;
  assert.equal(p.targetMinutesPerWeek, 450);
  assert.equal(w.targetMinutesPerWeek, 0, '0 = ei nyt');
  assert.equal(stepLine(), '4');
});

test('F2: kapasiteetilla ei ole oletusta; tallennus tälle viikolle', async (t) => {
  freezeLocalDate(t, THURSDAY);
  await createLifeArea({ name: 'Perhe', importance: 5, targetMinutesPerWeek: 300 });
  initDirection();
  renderDirection();
  assert.equal(stepLine(), '4');
  assert.match(html('dirSetup'), /<input type="number" id="dirSetupCapacity" min="0" max="168" step="0.5" inputmode="decimal"\s+data-focus="capacity" value="">/);
  assert.match(html('dirSetup'), /data-setup="save-capacity" data-focus="primary"\s+disabled>Tallenna/);
  setup().dispatch('input', eventFor({ focus: 'capacity' }, { value: '25' }));
  await click({ setup: 'save-capacity' });
  assert.equal(getState().weeklyCapacities[0].availableMinutes, 1500);
  assert.equal(getState().weeklyCapacities[0].weekStart, '2026-09-14');
});

test('F2 + F9: vaihe 5 kuittaa vanhan datan oikeilla luvuilla ja liittää tavoitteen vain valinnasta', async (t) => {
  freezeLocalDate(t, THURSDAY);
  const goal = await ownerLegacy();
  await createLifeArea({ name: 'Työ', importance: 4, targetMinutesPerWeek: 600 });
  await saveWeeklyCapacity({ weekStart: '2026-09-14', availableMinutes: 1200 });
  initDirection();
  renderDirection();
  assert.equal(stepLine(), '5', 'aalto I:n käyttäjä jatkaa ensimmäisestä keskeneräisestä');
  const markup = html('dirSetup');
  assert.match(markup, /Sinulla on jo 36 tehtävää, 1 tavoite ja 1 projekti\. Niitä ei tarvitse järjestää kerralla: kun liität tavoitteen alueeseen, sen tehtävät ja projektit seuraavat mukana\. Muut voit liittää vähitellen tai jättää ilman aluetta\./);
  assert.match(markup, new RegExp(`<label class="field-label" for="dirSetupGoal-${goal.id}">Oma tavoite</label>`));
  assert.equal(getState().goals[0].lifeAreaId, null, 'ei automaattista liittämistä');
  await change({ setupGoal: goal.id }, { value: getState().lifeAreas[0].id });
  assert.equal(getState().goals[0].lifeAreaId, getState().lifeAreas[0].id);
});

test('F9: kuittauksen sijamuodot ja tyhjä tila', () => {
  // legacyNoticeText on näkymän osa: tarkistetaan suoraan.
  return import('../src/app/views/directionSetup.js').then(({ legacyNoticeText }) => {
    assert.equal(legacyNoticeText({ openTasks: 1, goals: 0, projects: 0 }),
      'Sinulla on jo 1 tehtävä. Sitä ei tarvitse järjestää kerralla: kun liität tavoitteen alueeseen, '
      + 'sen tehtävät ja projektit seuraavat mukana. Muut voit liittää vähitellen tai jättää ilman aluetta.');
    assert.match(legacyNoticeText({ openTasks: 2, goals: 3, projects: 0 }), /^Sinulla on jo 2 tehtävää ja 3 tavoitetta\. Niitä/);
    assert.equal(legacyNoticeText({ openTasks: 0, goals: 0, projects: 0 }), '');
  });
});

test('F9: 0 alueen Suunta kuittaa vanhan datan myös aloituksen ohi; ilman dataa ei kuittausta', async (t) => {
  freezeLocalDate(t, THURSDAY);
  await ownerLegacy();
  initDirection();
  renderDirection();
  assert.match(html('dirAreaSuggestions'), /Sinulla on jo 36 tehtävää, 1 tavoite ja 1 projekti\./);
  assert.match(html('dirAreaSuggestions'), /vähitellen/);
  setTasks([]);
  setGoals([]);
  setProjects([]);
  renderDirection();
  assert.doesNotMatch(html('dirAreaSuggestions'), /Sinulla on jo/);
});

test('F9: rästien infoline vain, kun avoimia rästejä on', async (t) => {
  freezeLocalDate(t, THURSDAY);
  await ownerLegacy();
  renderDirection();
  assert.match(html('dirWeekSummary'), /22 rästissä olevaa avointa tehtävää ei ole tämän viikon suunnitelmassa\./);
  setTasks(getState().tasks.filter(task => !task.id.startsWith('o')));
  renderDirection();
  assert.doesNotMatch(html('dirWeekSummary'), /rästissä/);
});

test('F9: alueen lomake kertoo kategorian vaikutuksen ennen tallennusta ja päivittää sen', async (t) => {
  freezeLocalDate(t, THURSDAY);
  await ownerLegacy();
  initDirection();
  openAreaForm(null, { name: 'Terveys', categoryKey: 'hyvinvointi' });
  node('dirAreaCategory').value = 'hyvinvointi';
  node('dirAreaCategory').dispatch('change', {});
  assert.equal(node('dirAreaCategoryImpact').textContent,
    'Kategoria Hyvinvointi: 8 avointa tehtävää (0 tällä viikolla) lasketaan tähän alueeseen.');
  node('dirAreaCategory').value = 'tyo';
  node('dirAreaCategory').dispatch('change', {});
  assert.equal(node('dirAreaCategoryImpact').textContent,
    'Kategoria Työ: 25 avointa tehtävää (3 tällä viikolla) lasketaan tähän alueeseen.');
  node('dirAreaCategory').value = '';
  node('dirAreaCategory').dispatch('change', {});
  assert.equal(node('dirAreaCategoryImpact').textContent, '');
  assert.match(HTML, /<p class="hint" id="dirAreaCategoryImpact" aria-live="polite"><\/p>/);
});

// ================================================================ OHITUS JA MUISTI

test('F2: takaisin/ohita vaihtavat vaihetta; ohitus on käyttäjäkohtainen ja säilyy uloskirjautumisen yli', async (t) => {
  freezeLocalDate(t, THURSDAY);
  await createLifeArea({ name: 'Perhe', importance: 5 });
  initDirection();
  renderDirection();
  assert.equal(stepLine(), '3');
  await click({ setup: 'skip' });
  assert.equal(stepLine(), '4');
  await click({ setup: 'back' });
  assert.equal(stepLine(), '3');
  assert.deepEqual(getUserPreference(USER.id, 'suuntaSetup').skipped, ['targets']);
  assert.ok(storage.has('manifestival.userPrefs.v1.' + USER.id));
  // Uloskirjautuminen tyhjentää laiteasetukset, EI käyttäjäkohtaisia merkintöjä.
  clearDevicePreferences();
  assert.deepEqual(getUserPreference(USER.id, 'suuntaSetup').skipped, ['targets']);
  // Toinen käyttäjä samalla laitteella ei peri ohitusta.
  assert.deepEqual(getUserPreference(OTHER.id, 'suuntaSetup').skipped, []);
  setUser(OTHER);
  assert.equal(currentSetupProgress().steps.find(s => s.key === 'targets').skipped, false);
});

test('F2: kaikki vaiheet käyty -> aloitus piiloon, eikä palaa seuraavalla viikolla uusista arvioimattomista', async (t) => {
  freezeLocalDate(t, THURSDAY);
  await createLifeArea({ name: 'Perhe', importance: 5, targetMinutesPerWeek: 300 });
  await saveWeeklyCapacity({ weekStart: '2026-09-14', availableMinutes: 1200 });
  setTasks([normalizeTask({ id: 'x', title: 'Arvioimaton', date: THURSDAY })]);
  initDirection();
  renderDirection();
  assert.equal(stepLine(), '6');
  assert.match(html('dirSetup'), /data-queue-card="task:x"/, 'arviojono upotettuna');
  await click({ setup: 'finish-step' });
  assert.equal(stepLine(), '7');
  assert.match(html('dirSetup'), /data-setup="start-timer" data-focus="start-timer"\s+disabled>Aloita ajastin alueelle/);
  await click({ setup: 'finish-step' });
  assert.equal(node('screen-direction').classList.contains('dir-setup-active'), false);
  assert.match(html('dirSetup'), /Aloitus on valmis\./);
  assert.equal(getUserPreference(USER.id, 'suuntaSetup').completed, true);
  // Uusi arvioimaton tehtävä ei avaa aloitusta uudelleen.
  resetDirectionView();
  setTasks([...getState().tasks, normalizeTask({ id: 'y', title: 'Uusi', date: THURSDAY })]);
  renderDirection();
  assert.equal(setup().hidden, true);
});

test('F2: ajastin alueelle vaiheessa 7 vaatii alueen valinnan, ei oletusta', async (t) => {
  freezeLocalDate(t, THURSDAY);
  await createLifeArea({ name: 'Perhe', importance: 5, targetMinutesPerWeek: 300 });
  await saveWeeklyCapacity({ weekStart: '2026-09-14', availableMinutes: 1200 });
  initDirection();
  renderDirection();
  assert.equal(stepLine(), '7');
  assert.match(html('dirSetup'), /<option value="">Valitse alue<\/option>/);
  const area = getState().lifeAreas[0];
  await change({ setupTimerArea: '1' }, { value: area.id });
  assert.doesNotMatch(html('dirSetup'), /data-setup="start-timer" data-focus="start-timer"\s+disabled/);
  await click({ setup: 'start-timer' });
  assert.equal(currentTimer().lifeAreaId, area.id);
  renderDirection();
  assert.equal(setup().hidden === false && /Vaihe/.test(html('dirSetup')), false, 'käynnissä oleva ajastin täyttää vaiheen');
});

test('F2: "Näytä koko Suunta" siirtää aloituksen sivuun tälle istunnolle; "Jatka aloitusta" palaa', async (t) => {
  freezeLocalDate(t, THURSDAY);
  initDirection();
  renderDirection();
  await click({ setup: 'dismiss' });
  assert.equal(node('screen-direction').classList.contains('dir-setup-active'), false);
  assert.match(html('dirSetup'), /Aloitus on kesken: vaihe 1\/7\./);
  assert.match(html('dirSetup'), /Jatka aloitusta/);
  await click({ setup: 'resume' });
  assert.ok(node('screen-direction').classList.contains('dir-setup-active'));
  assert.equal(stepLine(), '1');
});

test('F2: Tänään-kortti 0 alueella: "Aloita Suunta" avaa aloituksen', async (t) => {
  freezeLocalDate(t, THURSDAY);
  initDirection();
  renderDirection();
  await click({ setup: 'dismiss' });
  renderTodayDirection();
  assert.match(html('todayDirection'), /<button class="assist-btn primary" type="button" data-open-setup="1">Aloita Suunta<\/button>/);
  node('todayDirection').dispatch('click', eventFor({ openSetup: '1' }));
  await flush();
  assert.ok(node('screen-direction').classList.contains('dir-setup-active'));
  assert.equal(getState().screen, 'screen-direction');
  assert.equal(stepLine(), '1');
});

test('F2: ladattujen tietojen puuttuessa aloitusta ei näytetä (tuntematon ei ole nolla)', (t) => {
  freezeLocalDate(t, THURSDAY);
  setDomainLoadStatus('lifeAreas', false, new Error('verkko'));
  renderDirection();
  assert.equal(setup().hidden, true);
  assert.equal(node('screen-direction').classList.contains('dir-setup-active'), false);
  // Lataus kesken (jokin kokoelma tiedossa, alueet eivät): ei hetkellistä aloitusta.
  resetState();
  setDomainLoadStatus('tasks', true);
  renderDirection();
  assert.equal(setup().hidden, true);
});

// ================================================================ F3

test('F3 KRIITTINEN: kohdistus ilman alueita ei tarjoa pysyvää opt-outia vaan alueen luonnin', async (t) => {
  freezeLocalDate(t, THURSDAY);
  await ownerLegacy();
  initDirection();
  node('dirOpenUnassigned').dispatch('click');
  const markup = html('dirUnassigned');
  assert.match(markup, /Luo ensin elämänalue, niin voit liittää tekemistä siihen\./);
  assert.match(markup, /data-quality-action="add_areas"/);
  assert.doesNotMatch(markup, /data-assign-optout/);
  // Toiminto avaa aloituksen (0 aluetta).
  node('dirUnassigned').dispatch('click', eventFor({ qualityAction: 'add_areas' }));
  await flush();
  assert.ok(node('screen-direction').classList.contains('dir-setup-active'));
});

test('F3: rivi ilman tavoite- tai kategoriavaihtoehtoa ei tarjoa opt-outia; valmiit eivät ole listalla', async (t) => {
  freezeLocalDate(t, THURSDAY);
  await createLifeArea({ name: 'Ystävät', importance: 4 });
  setTasks([
    normalizeTask({ id: 'a', title: 'Avoin', date: THURSDAY, category: 'koti' }),
    normalizeTask({ id: 'b', title: 'Valmis', date: THURSDAY, category: 'koti', completed: true })
  ]);
  initDirection();
  node('dirOpenUnassigned').dispatch('click');
  const markup = html('dirUnassigned');
  assert.match(markup, /Sinulla on 1 asia, jota ei ole liitetty elämänalueeseen\./);
  assert.doesNotMatch(markup, /Valmis/);
  assert.doesNotMatch(markup, /data-assign-optout/);
  assert.match(markup, /Liitä ensin jokin tavoite alueeseen tai kytke alueeseen kategoria/);
  assert.match(markup, /data-assign-skip="task:a"/);
});

// ================================================================ INVARIANTTI

test('F9 KRIITTINEN: Suunnan, aloituksen ja työnkulkujen avaaminen ei kirjoita tehtäviin, tavoitteisiin eikä projekteihin', async (t) => {
  freezeLocalDate(t, THURSDAY);
  await ownerLegacy();
  const before = snapshotLegacy();
  const callsBefore = client.calls.length;
  initDirection();
  renderDirection();
  renderTodayDirection();
  await click({ setupDraft: 'Perhe' });
  await click({ setup: 'to-importance' });
  await click({ setup: 'back' });
  await click({ setup: 'dismiss' });
  node('dirOpenEstimate').dispatch('click');
  node('dirOpenUnassigned').dispatch('click');
  node('dirAddArea').dispatch('click');
  renderDirection();
  await click({ setup: 'resume' });
  await flush();
  assert.equal(snapshotLegacy(), before, 'tila ei muuttunut');
  const writes = client.calls.slice(callsBefore)
    .filter(c => ['tasks', 'goals', 'projects'].includes(c.table) && c.operation !== 'select');
  assert.deepEqual(writes, [], 'ei kirjoituksia tehtäviin, tavoitteisiin tai projekteihin');
});

// ================================================================ STAATTINEN

test('F2 staattinen: #dirSetup on nimetty osio; kohteet 44 px; ei vaakavieritystä kapealla näytöllä', () => {
  assert.match(HTML, /<div class="dir-section dir-setup" id="dirSetup" aria-labelledby="dirSetupTitle" hidden><\/div>/);
  assert.match(CSS, /\.dir-setup-choice \{[^}]*min-height:44px/);
  assert.match(CSS, /\.dir-setup-dismiss \{[^}]*min-height:44px/);
  assert.match(CSS, /\.dir-setup input\[type="text"\], \.dir-setup input\[type="number"\], \.dir-setup select \{[^}]*min-height:44px/);
  assert.match(CSS, /\.dir-setup-fieldset \{[^}]*min-width:0/, 'fieldset ei pakota leveyttä');
  assert.match(CSS, /\.dir-setup-choices \{[^}]*flex-wrap:wrap/);
  assert.match(CSS, /\.dir-setup-nav \{[^}]*flex-wrap:wrap/);
  const sw = read('sw.js');
  for (const file of ['/src/app/views/directionSetup.js', '/src/domain/alignmentSetup.js', '/src/domain/estimateQueue.js']) {
    assert.ok(sw.includes(`'${file}'`), `${file} puuttuu SHELL-listalta`);
  }
});

test('F2: aloituksen merkintä ei käytä rekisteröimätöntä laiteavainta', () => {
  const source = read('src/app/views/directionSetup.js');
  assert.doesNotMatch(source, /localStorage|setDevicePreference/);
  assert.match(source, /setUserPreference\(currentUserId\(\), 'suuntaSetup'/);
});

test('F2: kirjattu aika täyttää vaiheen 7 myös ilman ajastinta', async (t) => {
  freezeLocalDate(t, THURSDAY);
  await createLifeArea({ name: 'Perhe', importance: 5, targetMinutesPerWeek: 300 });
  await saveWeeklyCapacity({ weekStart: '2026-09-14', availableMinutes: 1200 });
  await logTime({ entryDate: THURSDAY, minutes: 30, lifeAreaId: getState().lifeAreas[0].id });
  assert.equal(currentSetupProgress().complete, true);
});
