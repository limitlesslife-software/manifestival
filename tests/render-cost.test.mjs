// Piirron hinta (CRIT-01): yksi lataus = enintään kaksi ilmoitusta,
// viikkoanalyysi välimuistista, piilossa olevaa Suuntaa ei piirretä, ja
// likainen näyttö piirretään ennen näyttämistä.
//
// Näkymä renderöidään index.html:n tunnisteita vastaavaan DOM-tynkään
// (sama kuvio kuin life-alignment-ui-v2.test.mjs). Kello jäädytetään.
// analyzeWeek-kutsut lasketaan alignment.js:n testisaumalla
// (setWeekAnalyzerForTests).

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { read, readCode, jsFilesIn } from './helpers/sources.mjs';
import { freezeLocalDate } from './helpers/clock.mjs';
import { createMultiTableServer } from './helpers/multiTableServer.mjs';
import { setUser, clearUser, getUser } from '../src/data/session.js';
import { setClient } from '../src/data/client.js';
import { goalsRepo, projectsRepo, routinesRepo } from '../src/data/collectionsRepo.js';
import {
  resetState, getState, subscribe, batch, setTasks, setGoals, setLifeAreas, setTimeEntries,
  setWeeklyCapacities, setScreen, setViewDate, setVoiceState
} from '../src/app/state.js';
import { loadUserData, clearLocalUserData } from '../src/app/actions.js';
import {
  analyzeCurrentWeek, setWeekAnalyzerForTests, resetAppliedAdjustments, resetAlignmentSession,
  proposalRunsForTests
} from '../src/app/alignment.js';
import { renderDirection, renderTodayDirection, resetDirectionView } from '../src/app/views/direction.js';
import {
  setScreenRenderers, renderVisible, switchTab, isScreenDirty, markScreensDirty, forgetRenderedScreens
} from '../src/app/navigation.js';
import { analyzeWeek } from '../src/domain/alignment.js';
import { normalizeTask } from '../src/domain/task.js';
import { normalizeGoal } from '../src/domain/goal.js';
import { normalizeLifeArea } from '../src/domain/lifeArea.js';
import { normalizeTimeEntry } from '../src/domain/timeEntry.js';
import { normalizeWeeklyCapacity } from '../src/domain/weeklyCapacity.js';

const USER = { id: 'dddddddd-4444-4444-8444-00000000000d', email: 'perf@example.com' };
const THURSDAY = '2026-09-17';
const WEEK = '2026-09-14';
const NEXT_WEEK = '2026-09-21';
const PREVIOUS_WEEK = '2026-09-07';
const TWO_WEEKS_AGO = '2026-08-31';
const HTML = read('index.html');
const HTML_IDS = new Set([...HTML.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));

// ---------------------------------------------------------------- DOM-tynkä

function stubElement(id = null) {
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
    addEventListener: () => {},
    removeEventListener: () => {},
    focus() { globalThis.document.activeElement = this; },
    scrollIntoView() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    appendChild: () => {},
    remove: () => {},
    closest: () => null,
    contains: () => false
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
    body: { appendChild: () => {}, classList: { toggle: () => {} } }
  };
  globalThis.CSS = { escape: value => String(value) };
}

const html = id => globalThis.document.getElementById(id).innerHTML;

// ------------------------------------------------------ analyysien laskenta

/** Laske analyzeWeek-kutsut viikoittain (oikea analyysi ajetaan). */
function countAnalyses() {
  const weeks = [];
  setWeekAnalyzerForTests(input => {
    weeks.push(input.weekStart);
    return analyzeWeek(input);
  });
  return {
    weeks,
    count: () => weeks.length,
    reset: () => { weeks.length = 0; }
  };
}

beforeEach(() => {
  clearUser();
  clearLocalUserData();
  resetState();
  resetAppliedAdjustments();
  resetAlignmentSession();
  resetDirectionView();
  setWeekAnalyzerForTests(null);
  installDom();
});

afterEach(() => {
  setWeekAnalyzerForTests(null);
  setScreenRenderers({});
  delete globalThis.document;
  delete globalThis.CSS;
});

// ------------------------------------------------------------- aineisto

const area = (id, name, importance, categoryKey) =>
  normalizeLifeArea({ id, name, importance, targetMinutesPerWeek: 600, categoryKey, createdAt: '2026-08-01T08:00:00Z' });

/** Pieni Suunta-viikko: kaksi aluetta, kapasiteetti, tehtäviä ja kirjauksia. */
function seedSmallWeek() {
  setLifeAreas([area('a-perhe', 'Perhe', 5, 'perhe'), area('a-tyo', 'Työ', 3, 'tyo')]);
  setGoals([normalizeGoal({ id: 'g-1', title: 'Liikunta', lifeAreaId: 'a-perhe', status: 'active' })]);
  setWeeklyCapacities([normalizeWeeklyCapacity({ id: 'c-1', weekStart: WEEK, availableMinutes: 1200 })]);
  setTasks([
    normalizeTask({ id: 't-1', title: 'Raportti', date: THURSDAY, durationMinutes: 300, category: 'tyo' }),
    normalizeTask({ id: 't-2', title: 'Ensi viikon suunnitelma', date: '2026-09-22', durationMinutes: 90, category: 'tyo' }),
    normalizeTask({ id: 't-3', title: 'Leikkipuisto', date: THURSDAY, durationMinutes: null, category: 'perhe' })
  ]);
  setTimeEntries([
    normalizeTimeEntry({ id: 'e-1', entryDate: '2026-09-15', minutes: 120, lifeAreaId: 'a-tyo' }),
    normalizeTimeEntry({ id: 'e-2', entryDate: '2026-09-08', minutes: 60, lifeAreaId: 'a-perhe' })
  ]);
}

/** Suuri aineisto: tehtävät ja kirjaukset 120 päivälle viikon ympärille. */
function seedLargeData(taskCount, entryCount) {
  const areas = Array.from({ length: 8 }, (_, i) =>
    area('a' + i, 'Alue ' + i, (i % 5) + 1, i === 0 ? 'tyo' : i === 1 ? 'perhe' : null));
  const goals = Array.from({ length: 20 }, (_, i) =>
    normalizeGoal({ id: 'g' + i, title: 'Tavoite ' + i, lifeAreaId: 'a' + (i % 8), status: 'active' }));
  const base = Date.UTC(2026, 7, 1);
  const day = i => new Date(base + (i % 120) * 86_400_000).toISOString().slice(0, 10);
  const tasks = Array.from({ length: taskCount }, (_, i) => normalizeTask({
    id: 't' + i, title: 'Tehtävä ' + i, date: day(i), completed: i % 3 === 0,
    durationMinutes: i % 4 === 0 ? null : 30, goalId: 'g' + (i % 20), category: 'tyo'
  }));
  const entries = Array.from({ length: entryCount }, (_, i) => normalizeTimeEntry({
    id: 'e' + i, entryDate: day(i), minutes: 20, lifeAreaId: i % 2 ? 'a' + (i % 8) : null, taskId: 't' + (i % taskCount)
  }));
  setLifeAreas(areas);
  setGoals(goals);
  setTasks(tasks);
  setTimeEntries(entries);
  setWeeklyCapacities([normalizeWeeklyCapacity({ id: 'c-1', weekStart: WEEK, availableMinutes: 2400 })]);
}

// ================================================================ batch

test('batch: monta tilamuutosta = yksi ilmoitus; sisäkkäinen batch ilmoittaa vasta uloimman lopussa', () => {
  let notifications = 0;
  const off = subscribe(() => { notifications += 1; });
  try {
    const value = batch(() => {
      setTasks([]);
      setGoals([]);
      batch(() => { setVoiceState('listening'); setVoiceState(null); });
      assert.equal(notifications, 0, 'ilmoitus ennen batchin loppua');
      assert.equal(getState().voiceState, null, 'muutokset näkyvät heti getState():lle');
      return 42;
    });
    assert.equal(value, 42, 'batch palauttaa fn:n arvon');
    assert.equal(notifications, 1);
    batch(() => {});
    assert.equal(notifications, 1, 'ei muutoksia -> ei ilmoitusta');
  } finally {
    off();
  }
});

test('batch: heittävä fn ilmoittaa jo tehdyt muutokset ja välittää virheen', () => {
  let notifications = 0;
  const off = subscribe(() => { notifications += 1; });
  try {
    assert.throws(() => batch(() => {
      setTasks([normalizeTask({ id: 'x', title: 'X', date: THURSDAY })]);
      throw new Error('kesken');
    }), /kesken/);
    assert.equal(notifications, 1, 'tehty muutos jäi ilmoittamatta');
    setGoals([]);
    assert.equal(notifications, 2, 'batch jäi auki virheen jälkeen');
  } finally {
    off();
  }
});

// ============================================================ lataus

test('CRIT-01 (a): yksi loadUserData = enintään 2 tilaajailmoitusta (oli 52)', async () => {
  const server = createMultiTableServer(() => getUser()?.id ?? null);
  setClient(server);
  setUser(USER);
  await routinesRepo.insert({ id: 'r-1', title: 'Aamulenkki', active: true, recurrence: { type: 'daily', weekdays: [] } });
  await goalsRepo.insert({ id: 'g-1', title: 'Tavoite 1' });
  await projectsRepo.insert({ id: 'p-1', name: 'Projekti 1' });

  let notifications = 0;
  const off = subscribe(() => { notifications += 1; });
  try {
    const result = await loadUserData();
    assert.equal(result.discarded, false);
    assert.ok(notifications <= 2, `ilmoituksia ${notifications}`);
    assert.ok(notifications >= 1, 'lataus ei ilmoittanut lainkaan: näkymä jäisi vanhaksi');
    // Kaikki tulokset ovat tilassa ilmoitushetkellä.
    assert.equal(getState().goals.length, 1);
    assert.equal(getState().routines.length, 1);
    assert.equal(getState().dataLoadStatus.runningTimers.ok, true);
  } finally {
    off();
  }
});

test('CRIT-01 (a): hylätty lataus (istunto vaihtui) ei ilmoita mitään', async () => {
  const server = createMultiTableServer(() => getUser()?.id ?? null);
  setClient(server);
  setUser(USER);
  let notifications = 0;
  const off = subscribe(() => { notifications += 1; });
  try {
    const pending = loadUserData();
    clearUser();
    const result = await pending;
    assert.equal(result.discarded, true);
    assert.equal(notifications, 0);
  } finally {
    off();
  }
});

test('lataus: tulosten käsittely (applyLoadedData) ei kirjoita mitään kantaan', () => {
  // activation-gates.test.mjs tarkistaa loadUserData-rungon; tulosten
  // käsittely on nyt omassa funktiossaan batchin sisällä.
  const code = readCode('src/app/actions.js');
  const start = code.indexOf('function applyLoadedData');
  assert.ok(start > -1);
  const body = code.slice(start, code.indexOf('\n}', start));
  for (const writing of ['.insert(', '.update(', '.upsert(', '.delete(', '.remove(', 'savePreferences', 'saveProfile']) {
    assert.equal(body.includes(writing), false, `applyLoadedData kutsuu kirjoittavaa operaatiota: ${writing}`);
  }
  const load = code.slice(code.indexOf('export async function loadUserData'));
  assert.match(load.slice(0, load.indexOf('\n}')), /return batch\(\(\) => applyLoadedData\(loaded, timerSeq\)\);/);
});

// ====================================================== analyysin välimuisti

test('CRIT-01 (b): kaksi piirtoa muuttumattomilla kokoelmilla = 0 ylimääräistä analyysia', (t) => {
  freezeLocalDate(t, THURSDAY);
  seedSmallWeek();
  const analyses = countAnalyses();

  renderDirection();
  renderTodayDirection();
  const first = [...analyses.weeks];
  assert.ok(first.length > 0);
  // Jokainen viikko lasketaan piirrossa enintään kerran: tämä, edellinen
  // (vertailu, hiljaisuus), seuraava (ehdotukset) ja kahden viikon takainen.
  assert.equal(new Set(first).size, first.length, 'sama viikko laskettiin kahdesti: ' + first.join(', '));
  assert.deepEqual([...first].sort(), [TWO_WEEKS_AGO, PREVIOUS_WEEK, WEEK, NEXT_WEEK].sort());

  analyses.reset();
  renderDirection();
  renderTodayDirection();
  assert.equal(analyses.count(), 0, 'muuttumattomat kokoelmat analysoitiin uudelleen: ' + analyses.weeks.join(', '));
});

test('välimuisti: uusi kokoelma laskee uudelleen, eikä näkymä näytä vanhaa', (t) => {
  freezeLocalDate(t, THURSDAY);
  seedSmallWeek();
  renderDirection();
  const before = analyzeCurrentWeek(WEEK);
  const analyses = countAnalyses();
  analyses.reset();

  setTimeEntries([...getState().timeEntries,
    normalizeTimeEntry({ id: 'e-3', entryDate: '2026-09-16', minutes: 45, lifeAreaId: 'a-perhe', note: 'Uimahalli' })]);
  renderDirection();
  assert.ok(analyses.weeks.includes(WEEK), 'tämän viikon analyysi jäi vanhaksi');
  const after = analyzeCurrentWeek(WEEK);
  assert.notEqual(after, before);
  assert.equal(after.actual.minutes, before.actual.minutes + 45);
  assert.match(html('dirTimeList'), /Uimahalli/, 'toteumalista näytti vanhan tilan');
});

test('välimuisti: kellon minuutti kuuluu avaimeen (jäljellä oleva aika muuttuu)', (t) => {
  const frozen = freezeLocalDate(t, THURSDAY, '12:00');
  seedSmallWeek();
  const analyses = countAnalyses();
  analyzeCurrentWeek(WEEK);
  analyzeCurrentWeek(WEEK);
  assert.equal(analyses.count(), 1);
  t.mock.timers.setTime(frozen.getTime() + 30_000); // sama minuutti
  analyzeCurrentWeek(WEEK);
  assert.equal(analyses.count(), 1);
  t.mock.timers.setTime(frozen.getTime() + 60_000); // seuraava minuutti
  analyzeCurrentWeek(WEEK);
  assert.equal(analyses.count(), 2);
});

test('välimuisti: piirto ei muuta jaettua analyysia', (t) => {
  freezeLocalDate(t, THURSDAY);
  seedSmallWeek();
  const shared = analyzeCurrentWeek(WEEK);
  const snapshot = structuredClone(shared);
  renderDirection();
  renderTodayDirection();
  renderDirection();
  assert.equal(analyzeCurrentWeek(WEEK), shared, 'välimuisti ei palauttanut samaa oliota');
  assert.deepStrictEqual(shared, snapshot, 'näkymä mutatoi välimuistin analyysia');
});

test('välimuisti tyhjenee uloskirjautuessa (resetAlignmentSession)', (t) => {
  freezeLocalDate(t, THURSDAY);
  seedSmallWeek();
  const analyses = countAnalyses();
  analyzeCurrentWeek(WEEK);
  resetAlignmentSession();
  analyzeCurrentWeek(WEEK);
  assert.equal(analyses.count(), 2, 'edellisen käyttäjän analyysi jäi muistiin');
});

test('CRIT-01: ehdotukset lasketaan uudelleen vain, kun analyysi vaihtui', (t) => {
  freezeLocalDate(t, THURSDAY);
  seedSmallWeek();
  const analyses = countAnalyses();
  const runs = proposalRunsForTests();
  renderDirection();
  assert.equal(proposalRunsForTests() - runs, 1);
  const proposalsHtml = html('dirProposals');
  analyses.reset();
  renderDirection();
  renderDirection();
  assert.equal(proposalRunsForTests() - runs, 1, 'samat ehdotukset laskettiin uudelleen samalle analyysille');
  assert.equal(analyses.weeks.filter(week => week === NEXT_WEEK).length, 0, 'seuraavan viikon analyysi toistettiin');
  assert.equal(html('dirProposals'), proposalsHtml);

  // Ensi viikon kuormitus muuttuu: ehdotukset lasketaan uudelleen.
  setTasks([...getState().tasks,
    normalizeTask({ id: 't-9', title: 'Iso urakka', date: '2026-09-23', durationMinutes: 1500, category: 'tyo' })]);
  analyses.reset();
  renderDirection();
  assert.equal(proposalRunsForTests() - runs, 2, 'ehdotukset jäivät vanhan analyysin varaan');
  assert.ok(analyses.weeks.includes(NEXT_WEEK));
  assert.equal(/Kevennä ensi viikkoa/.test(proposalsHtml), false);
  assert.match(html('dirProposals'), /Kevennä ensi viikkoa/, 'ylikuormitettu ensi viikko ei näkynyt ehdotuksissa');
});

test('toteumalista: kirjauksen kohde haetaan hakemistosta, ei lineaarisesti jokaiselle riville', (t) => {
  freezeLocalDate(t, THURSDAY);
  seedSmallWeek();
  setTimeEntries([...getState().timeEntries,
    normalizeTimeEntry({ id: 'e-task', entryDate: '2026-09-16', minutes: 30, taskId: 't-1' })]);
  renderDirection();
  assert.match(html('dirTimeList'), /Raportti/, 'tehtävän nimi puuttuu kirjaukselta');
  const code = readCode('src/app/views/direction.js');
  const start = code.indexOf('function entryTargetLabel');
  const label = code.slice(start, code.indexOf('\n}', start));
  assert.equal(/findTask\(/.test(label), false, 'kirjaukset × tehtävät -haku jokaiselle riville');
  const list = code.slice(code.indexOf('function timeListHtml'), code.indexOf('\n}', code.indexOf('function timeListHtml')));
  assert.match(list, /entryTargetLabel\(entry, byId, tasksById\)/);
  assert.equal((list.match(/areaOptions\(/g) || []).length, 1, 'aluevalikko rakennetaan riveittäin');
});

test('direction.js:n otsikko ei väitä yhtä analyysia per piirto', () => {
  const header = read('src/app/views/direction.js').split('\n').slice(0, 20).join('\n');
  assert.equal(/yksi analyzeCurrentWeek\(\)-kutsu per/.test(header), false);
  assert.match(header, /välimuisti/);
});

// ============================================== näkyvä näyttö ja likaiset

/** Sama kokoonpano kuin main.js: aina piirrettävä päivän kortti, Suunta omana näyttönään. */
function registerLikeMain(counts) {
  setScreenRenderers({
    'screen-today': () => { counts.today += 1; },
    'screen-direction': () => { counts.direction += 1; renderDirection(); },
    'screen-week': () => { counts.week += 1; }
  }, { always: [renderTodayDirection] });
}

test('CRIT-01 (c): Suunta piilossa -> tilamuutos ei laske seuraavaa eikä aiempia viikkoja', (t) => {
  freezeLocalDate(t, THURSDAY);
  setScreen('screen-today');
  const counts = { today: 0, direction: 0, week: 0 };
  registerLikeMain(counts);
  seedSmallWeek();
  const analyses = countAnalyses();

  // Kolme tilamuutosta, jokainen piirretään kuten main.js renderAll.
  for (const title of ['A', 'B', 'C']) {
    setTasks([...getState().tasks, normalizeTask({ id: 't-' + title, title, date: THURSDAY, durationMinutes: 15 })]);
    renderVisible();
  }
  assert.equal(counts.direction, 0, 'piilossa oleva Suunta piirrettiin');
  assert.equal(counts.today, 3, 'avoin näyttö piirretään jokaisesta muutoksesta');
  assert.equal(analyses.weeks.filter(week => week !== WEEK).length, 0,
    'piilossa ollessa laskettiin muita viikkoja: ' + analyses.weeks.join(', '));
  assert.equal(analyses.count(), 3, 'päivän kortti: yksi analyysi per muutos');
  assert.equal(isScreenDirty('screen-direction'), true);
});

test('likainen näyttö piirretään ennen näyttämistä tuoreella tilalla; puhdasta ei piirretä uudelleen', (t) => {
  freezeLocalDate(t, THURSDAY);
  setScreen('screen-today');
  const counts = { today: 0, direction: 0, week: 0 };
  registerLikeMain(counts);
  seedSmallWeek();
  renderVisible();

  // Muutos Tänään-näytöllä ollessa; Suunta on piilossa.
  setLifeAreas([...getState().lifeAreas, area('a-uusi', 'Ystävät', 4, null)]);
  renderVisible();
  assert.equal(counts.direction, 0);

  switchTab('screen-direction');
  assert.equal(counts.direction, 1, 'likaista näyttöä ei piirretty ennen näyttämistä');
  assert.match(html('dirAreasList'), /Ystävät/, 'näytössä vanhentunut sisältö');
  assert.equal(getState().screen, 'screen-direction');
  // setScreen-ilmoitus (pelkkä näytön vaihto) ei piirrä uudelleen.
  renderVisible();
  assert.equal(counts.direction, 1, 'pelkkä näytön vaihto piirsi näytön toiseen kertaan');

  // Takaisin ja uudelleen ilman muutoksia: Suunta on yhä puhdas.
  switchTab('screen-today');
  renderVisible();
  switchTab('screen-direction');
  renderVisible();
  assert.equal(counts.direction, 1, 'puhdas näyttö piirrettiin turhaan');

  // Muutos Suunnan ollessa auki piirtää sen heti.
  setViewDate(new Date(2026, 8, 18));
  renderVisible();
  assert.equal(counts.direction, 2);
});

test('aika kului tai käyttäjä vaihtui: jokainen näyttö piirretään ennen seuraavaa näyttämistä', (t) => {
  freezeLocalDate(t, THURSDAY);
  setScreen('screen-today');
  const counts = { today: 0, direction: 0, week: 0 };
  registerLikeMain(counts);
  seedSmallWeek();
  renderVisible();
  switchTab('screen-week');
  renderVisible();
  switchTab('screen-today');
  renderVisible();
  assert.equal(counts.week, 1);

  markScreensDirty(); // main.js: NOW_REFRESH_MS-kierros ja paluu etualalle
  switchTab('screen-week');
  assert.equal(counts.week, 2, 'aikaa kului, mutta näyttöä ei piirretty uudelleen');

  forgetRenderedScreens(); // main.js: uloskirjautuminen
  switchTab('screen-week');
  assert.equal(counts.week, 3);
});

test('piirto ei tapahdu, kun se ei ole sallittu (uloskirjautunut), eikä näyttö merkitty puhtaaksi', () => {
  let rendered = 0;
  let allowed = false;
  setScreenRenderers({ 'screen-week': () => { rendered += 1; } }, { enabled: () => allowed });
  switchTab('screen-week');
  renderVisible();
  assert.equal(rendered, 0);
  assert.equal(isScreenDirty('screen-week'), true);
  allowed = true;
  switchTab('screen-week');
  assert.equal(rendered, 1);
});

test('heittävä piirtäjä ei estä näytön vaihtoa, ja näyttö jää likaiseksi', () => {
  setScreenRenderers({ 'screen-week': () => { throw new Error('piirto kaatui'); } });
  switchTab('screen-week');
  assert.equal(getState().screen, 'screen-week', 'vaihto jäi tekemättä');
  assert.equal(isScreenDirty('screen-week'), true);
});

test('main.js: renderAll piirtää vain näkyvän; Suunta vain omana näyttönään', () => {
  const main = readCode('src/app/main.js');
  const renderAll = main.slice(main.indexOf('function renderAll'), main.indexOf('\n}', main.indexOf('function renderAll')));
  assert.match(renderAll, /renderVisible\(\);/);
  for (const direct of ['renderDirection(', 'renderWeek(', 'renderTasks(', 'renderGoals(', 'renderFinance(', 'renderToday(']) {
    assert.equal(renderAll.includes(direct), false, `renderAll piirtää suoraan: ${direct}`);
  }
  const map = main.slice(main.indexOf('const SCREEN_RENDERERS'), main.indexOf('});', main.indexOf('const SCREEN_RENDERERS')));
  assert.match(map, /'screen-direction': \(\) => \{ renderDirection\(\); \}/);
  assert.equal((map.match(/renderDirection\(/g) || []).length, 1);
  // Jokainen näyttö on kartassa, ja jokainen aiempi piirtäjä on jossain ryhmässä.
  for (const screen of ['screen-today', 'screen-direction', 'screen-week', 'screen-tasks', 'screen-goals', 'screen-finance', 'screen-profile']) {
    assert.ok(map.includes(`'${screen}'`), screen);
  }
  for (const render of ['renderToday()', 'renderWeek()', 'renderTasks()', 'renderGoals()', 'renderProjects()',
    'renderFinance()', 'renderProfile()', 'renderNotificationSettings()', 'renderNotices()']) {
    assert.ok(map.includes(render), `${render} puuttuu näyttöjen piirtäjistä`);
  }
  // Toisen näytön DOM:iin kirjoittavat osat kuuluvat sille näytölle.
  assert.match(map, /'screen-tasks': \(\) => \{[^}]*refreshGoalPicker\(\)/);
  assert.match(map, /'screen-today': \(\) => \{[^}]*renderInbox\(\)/);
  assert.match(main, /const ALWAYS_RENDERED = Object\.freeze\(\[renderTimerBar, renderTodayDirection\]\)/);
  assert.match(main, /setScreenRenderers\(SCREEN_RENDERERS, \{ always: ALWAYS_RENDERED, enabled: \(\) => signedIn \}\)/);
  assert.match(main, /subscribe\(renderAll\)/);
  // Sisäänkirjautumisen jälkeen kaikki näytöt kerran; uloskirjautuessa unohdetaan.
  const signedIn = main.slice(main.indexOf('async function onSignedIn'), main.indexOf('function onSignedOut'));
  assert.match(signedIn, /renderEveryScreen\(\);/);
  const signedOut = main.slice(main.indexOf('function onSignedOut'), main.indexOf('async function start'));
  assert.match(signedOut, /forgetRenderedScreens\(\);/);
});

test('näytön DOM-tunnisteet: jokainen ryhmän kohde on oman näyttönsä sisällä', () => {
  // #afGoal (tehtävälomake) ja #capturePending (kirjauksen tarkistus) ovat
  // niillä näytöillä, joiden ryhmässä niiden piirtäjä on main.js:ssä.
  const screenOf = id => {
    const at = HTML.indexOf(`id="${id}"`);
    const sections = [...HTML.matchAll(/<section class="screen[^"]*" id="([^"]+)"/g)];
    let owner = null;
    for (const match of sections) if (match.index < at) owner = match[1];
    return owner;
  };
  assert.equal(screenOf('afGoal'), 'screen-tasks');
  assert.equal(screenOf('capturePending'), 'screen-today');
  assert.equal(screenOf('noticeCenterContainer'), 'screen-today');
  assert.equal(screenOf('todayDirection'), 'screen-today');
  assert.equal(screenOf('notificationSettings'), 'screen-profile');
});

// ================================================================ ajastin

test('ajastin: ei sekunnin välein piirtoa; 30 s tikki kirjoittaa vain tekstisolmut', () => {
  const timeLog = readCode('src/app/views/timeLog.js');
  assert.match(timeLog, /TICK_MS = 30 \* 1000;/);
  assert.match(timeLog, /setInterval\(tick, TICK_MS\)/);
  const start = timeLog.indexOf('function tick');
  const tick = timeLog.slice(start, timeLog.indexOf('\n}', start));
  assert.equal(/innerHTML|renderAll|renderTimerBar\(|renderVisible|commit|set[A-Z]\w*InState/.test(tick), false,
    'tikki piirtää tai muuttaa tilaa');
  const writes = (tick.match(/\.textContent =/g) || []).length;
  assert.ok(writes >= 1 && writes <= 2, `tikki kirjoittaa ${writes} tekstisolmua`);
  // Koko sovelluksessa vain kaksi toistuvaa ajastinta, kumpikin 30 s.
  const intervals = [];
  for (const file of jsFilesIn('src')) {
    const code = readCode(file);
    assert.equal(/requestAnimationFrame/.test(code), false, file);
    for (const match of code.matchAll(/setInterval\(/g)) intervals.push(file + ':' + match.index);
  }
  assert.equal(intervals.length, 2, intervals.join(', '));
  const main = readCode('src/app/main.js');
  assert.match(main, /NOW_REFRESH_MS = 30000/);
  assert.match(main, /setInterval\(\(\) => \{[\s\S]*?\}, NOW_REFRESH_MS\);/);
  const interval = main.slice(main.indexOf('setInterval('), main.indexOf('NOW_REFRESH_MS);', main.indexOf('setInterval(')));
  assert.equal(/renderAll|renderVisible|renderEveryScreen/.test(interval), false, 'NYT-kierros piirtää koko sovelluksen');
});

// ============================================================ suorituskyky

test('CRIT-01 (d): 2000 tehtävää + 8000 kirjausta: renderDirection + renderTodayDirection < 50 ms', (t) => {
  freezeLocalDate(t, THURSDAY);
  seedLargeData(2000, 8000);
  // Lämmittely (JIT): mitataan piirtoa eikä käännöstä.
  for (let round = 0; round < 2; round += 1) {
    setTasks([...getState().tasks]);
    renderDirection();
    renderTodayDirection();
  }
  const cold = [];
  const warm = [];
  for (let round = 0; round < 7; round += 1) {
    // Uusi kokoelma = välimuistin ohi (kuin tallennuksen jälkeen).
    setTasks([...getState().tasks]);
    let started = performance.now();
    renderDirection();
    renderTodayDirection();
    cold.push(performance.now() - started);
    started = performance.now();
    renderDirection();
    renderTodayDirection();
    warm.push(performance.now() - started);
  }
  const median = list => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)];
  const best = list => Math.min(...list);
  t.diagnostic(`2000 tehtävää + 8000 kirjausta: kylmä ${cold.map(ms => ms.toFixed(1)).join(' / ')} ms `
    + `(mediaani ${median(cold).toFixed(1)}), lämmin ${warm.map(ms => ms.toFixed(1)).join(' / ')} ms `
    + `(mediaani ${median(warm).toFixed(1)})`);
  // Paras kierros: rinnakkaiset testitiedostot jakavat suorittimen, ja
  // yksittäinen kierros voi odottaa vuoroaan. Budjetti koskee piirron omaa työtä.
  assert.ok(best(cold) < 50, `kylmä piirto (välimuistin ohi) ${best(cold).toFixed(1)} ms`);
  assert.ok(median(warm) < 50, `lämmin piirto ${median(warm).toFixed(1)} ms`);
  assert.ok(best(warm) < best(cold), 'välimuisti ei nopeuttanut');
});
