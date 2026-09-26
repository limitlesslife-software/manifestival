// Suunta Day 1 — kohdistus ja lomakkeet: F6 (ajanseuranta kysyy alueen,
// kirjatun ajan alue jälkikäteen), F8 (kategoria vs. elämänalue,
// tavoitteen alue), F10 (kestokenttien askel) ja F11 (kestopikavalinnat,
// rutiinin tavoite). Dialogien testit: suunta-dialogs-a11y.test.mjs.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { read } from './helpers/sources.mjs';
import { freezeLocalDate } from './helpers/clock.mjs';
import { fakeClient } from './helpers/gates.mjs';
import { setUser, clearUser } from '../src/data/session.js';
import { setClient } from '../src/data/client.js';
import { resetState, getState, setTasks, setOpenGoalId } from '../src/app/state.js';
import { clearLocalUserData, createGoal } from '../src/app/actions.js';
import {
  createLifeArea, logTime, editTimeEntry, analyzeCurrentWeek, resetAppliedAdjustments,
  setTimeEntryWriterForTests
} from '../src/app/alignment.js';
import { timeEntriesRepo, routinesRepo } from '../src/data/collectionsRepo.js';
import { setTimerRepoForTests, currentTimer, cancelTracking } from '../src/app/timeTracking.js';
import { createTimeEntryWriter } from '../src/app/timeEntryWriter.js';
import { loadOutbox, saveOutbox, resetTimerStoreForTests } from '../src/data/timerStore.js';
import { renderDirection, initDirection, resetDirectionView } from '../src/app/views/direction.js';
import { openTimerChooser, closeTimeLogDialog } from '../src/app/views/timeLog.js';
import { initGoalForm, openGoalForm, openNewGoalForm } from '../src/app/views/goals.js';
import { renderGoalDetail } from '../src/app/views/goalDetail.js';
import { initRoutineForm, openNewRoutineForm } from '../src/app/views/routines.js';
import { initTaskForm } from '../src/app/views/tasks.js';
import { closeConfirmDialogs } from '../src/ui/confirm.js';
import { columnGateOpen } from '../src/data/schema.js';
import { qualityIssues, QUALITY_ACTION } from '../src/domain/alignmentQuality.js';
import { normalizeTask } from '../src/domain/task.js';

const USER = { id: 'abababab-7777-4777-8777-0000000000ab', email: 'attr@example.com' };
const THURSDAY = '2026-09-17';
const WEEK = '2026-09-14';
const HTML = read('index.html');
const HTML_IDS = new Set([...HTML.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));

// ------------------------------------------------------------ tynkä-DOM

function stubElement(id = null) {
  const listeners = {};
  const classes = new Set();
  const attributes = {};
  const node = {
    id, tagName: 'DIV', innerHTML: '', textContent: '', value: '', checked: false, disabled: false, hidden: false,
    inert: false, style: {}, dataset: {}, isConnected: true,
    classList: {
      add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c),
      toggle: (c, on) => { if (on ?? !classes.has(c)) classes.add(c); else classes.delete(c); }
    },
    setAttribute: (k, v) => { attributes[k] = String(v); },
    getAttribute: k => attributes[k] ?? null,
    hasAttribute: k => k in attributes,
    removeAttribute: k => { delete attributes[k]; },
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
    removeEventListener: (type, fn) => { listeners[type] = (listeners[type] || []).filter(other => other !== fn); },
    dispatch: (type, event = {}) => (listeners[type] || []).map(fn => fn({ target: node, preventDefault() {}, ...event })),
    focus() { globalThis.document.activeElement = node; },
    scrollIntoView() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    insertAdjacentHTML() {},
    appendChild: () => {},
    append: () => {},
    replaceChildren: () => {},
    remove: () => {},
    closest: () => null
  };
  return node;
}

/**
 * Natiivin <dialog>:n tynkä: showModal avaa, close(arvo) asettaa
 * returnValue:n ja laukaisee 'close'-tapahtuman seuraavassa tehtävässä.
 * Merkinnästä poimitaan tunnisteelliset kentät ja pikavalinnat.
 */
function dialogStub() {
  const listeners = {};
  const children = new Map();
  let presets = [];
  let markup = '';
  const dialog = {
    id: '', className: '', returnValue: '', open: false, attributes: {},
    classList: { toggle() {}, add() {}, remove() {} },
    setAttribute(k, v) { dialog.attributes[k] = String(v); },
    get innerHTML() { return markup; },
    set innerHTML(value) {
      markup = String(value);
      children.clear();
      for (const [, childId] of markup.matchAll(/id="([^"]+)"/g)) {
        const child = stubElement(childId);
        children.set('#' + childId, child);
      }
      presets = [...markup.matchAll(/<button type="button" class="[^"]*time-log-preset" value="(m:\d+)"/g)].map(match => {
        const button = stubElement(null);
        button.value = match[1];
        return button;
      });
    },
    querySelector: selector => children.get(selector) || null,
    querySelectorAll: selector => (selector === '[data-log-minutes]' ? presets : []),
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
    removeEventListener: (type, fn) => { listeners[type] = (listeners[type] || []).filter(other => other !== fn); },
    showModal() { dialog.open = true; },
    close(value) {
      if (value !== undefined) dialog.returnValue = value;
      dialog.open = false;
      Promise.resolve().then(() => { for (const fn of [...(listeners.close || [])]) fn(); });
    },
    presets: () => presets,
    /** Enter tekstikentässä: selain aktivoi lomakkeen ENSIMMÄISEN submit-painikkeen. */
    implicitSubmit() {
      const first = /<button type="submit"[^>]*value="([^"]+)"/.exec(markup);
      dialog.close(first ? first[1] : undefined);
    }
  };
  return dialog;
}

let registry;
function installDom() {
  const elements = new Map();
  registry = new Map();
  globalThis.document = {
    activeElement: null,
    getElementById(id) {
      if (registry.has(id)) return registry.get(id);
      if (!HTML_IDS.has(id)) return null;
      if (!elements.has(id)) elements.set(id, stubElement(id));
      return elements.get(id);
    },
    createElement: tag => (tag === 'dialog' ? dialogStub() : stubElement()),
    querySelector: () => null,
    querySelectorAll: () => [],
    body: { appendChild: element => { if (element.id) registry.set(element.id, element); } }
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

function eventFor(dataset, props = {}) {
  const target = { dataset, disabled: false, ...props };
  const matches = selector => selector.split(',').some(part => {
    const match = /\[data-([a-z-]+)\]/.exec(part.trim());
    return Boolean(match) && dataset[match[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase())] !== undefined;
  });
  target.closest = selector => (matches(selector) ? target : null);
  return { target, preventDefault() {} };
}

let client;
beforeEach(() => {
  clearUser();
  clearLocalUserData();
  resetState();
  resetAppliedAdjustments();
  resetDirectionView();
  resetTimerStoreForTests();
  setTimerRepoForTests(null);
  setTimeEntryWriterForTests(null);
  installStorage();
  installDom();
  setUser(USER);
  client = fakeClient({ data: [], error: null });
  setClient(client);
});

afterEach(async () => {
  if (currentTimer()) await cancelTracking({ confirmFn: async () => true }).catch(() => {});
  closeTimeLogDialog();
  closeConfirmDialogs();
  delete globalThis.document;
  delete globalThis.CSS;
  delete globalThis.localStorage;
});

// ================================================================ F6

test('F6 KRIITTINEN: "Aloita ajanseuranta" kysyy alueen ennen käynnistystä; valittu alue tallentuu ajastimeen', async (t) => {
  freezeLocalDate(t, THURSDAY);
  const { area } = await createLifeArea({ name: 'Perhe', importance: 5 });
  initDirection();
  node('dirStartTimer').dispatch('click');
  const dialog = registry.get('timeLogDialog');
  assert.equal(dialog.open, true, 'ajastin ei käynnisty suoraan');
  assert.equal(currentTimer(), null);
  assert.match(dialog.innerHTML, /Aloita ajanseuranta/);
  assert.match(dialog.innerHTML, /<label class="field-label" for="timeLogArea">Elämänalue<\/label>/);
  assert.match(dialog.innerHTML, /<option value="">Ei aluetta<\/option>/, '"Ei aluetta" on yhä sallittu');
  assert.doesNotMatch(dialog.innerHTML, /time-log-preset|timeLogMinutes/, 'ei kirjausvalintoja käynnistysdialogissa');
  dialog.querySelector('#timeLogArea').value = area.id;
  dialog.close('timer');
  await flush();
  assert.equal(currentTimer().lifeAreaId, area.id);
});

test('F6: ajastinvalinta ilman alueita kertoo sen, ja "Ei aluetta" käynnistää kohteettoman ajastimen', async (t) => {
  freezeLocalDate(t, THURSDAY);
  const pending = openTimerChooser();
  const dialog = registry.get('timeLogDialog');
  assert.match(dialog.innerHTML, /Ajastin käynnistyy ilman aluetta\./);
  dialog.close('timer');
  const result = await pending;
  assert.equal(result.action, 'timer');
  assert.equal(currentTimer().lifeAreaId, null);
});

test('F6 KRIITTINEN: kirjattu aika liitetään alueeseen jälkikäteen, ja analyysi laskee sen alueelle', async (t) => {
  freezeLocalDate(t, THURSDAY);
  const { area } = await createLifeArea({ name: 'Perhe', importance: 5, targetMinutesPerWeek: 300 });
  const logged = await logTime({ entryDate: THURSDAY, minutes: 45 });
  assert.equal(analyzeCurrentWeek(WEEK).areas.find(a => a.id === area.id).actualMinutes, 0);
  const issue = qualityIssues(analyzeCurrentWeek(WEEK)).find(i => i.code === 'unassigned_actual');
  assert.equal(issue.action, QUALITY_ACTION.ASSIGN_TIME, 'toimenpide vie kirjauksiin, ei suunniteltujen listaan');
  initDirection();
  renderDirection();
  assert.match(html('dirTimeList'), new RegExp(`data-time-area="${logged.entry.id}"`));
  assert.match(html('dirTimeList'), /Liitä alueeseen \(17\.9\. 45 min\)/);
  node('dirTimeList').dispatch('change', eventFor({ timeArea: logged.entry.id }, { value: area.id }));
  await flush();
  assert.equal(getState().timeEntries[0].lifeAreaId, area.id);
  assert.equal(analyzeCurrentWeek(WEEK).areas.find(a => a.id === area.id).actualMinutes, 45);
  assert.equal(getState().timeEntries[0].minutes, 45, 'minuutit eivät muutu');
  renderDirection();
  assert.doesNotMatch(html('dirTimeList'), /data-time-area=/, 'alueellinen kirjaus ei tarjoa liitosta');
});

test('F6: editTimeEntry hylkää tuntemattoman alueen ja muut kentät; epäonnistunut tallennus palautetaan', async (t) => {
  freezeLocalDate(t, THURSDAY);
  const { area } = await createLifeArea({ name: 'Perhe', importance: 5 });
  const { entry } = await logTime({ entryDate: THURSDAY, minutes: 30 });
  assert.equal((await editTimeEntry(entry.id, { lifeAreaId: 'olematon' })).errors.lifeAreaId, 'Aluetta ei löytynyt.');
  assert.ok((await editTimeEntry(entry.id, { minutes: 600 })).errors.minutes);
  assert.equal((await editTimeEntry('ei-ole', { lifeAreaId: area.id })).ok, false);
  const original = timeEntriesRepo.update;
  timeEntriesRepo.update = async () => ({ ok: false, error: 'Muutoksen tallennus ei onnistunut.' });
  try {
    const result = await editTimeEntry(entry.id, { lifeAreaId: area.id });
    assert.equal(result.ok, false);
    assert.equal(getState().timeEntries[0].lifeAreaId, null, 'palautettu');
  } finally {
    timeEntriesRepo.update = original;
  }
  assert.equal((await editTimeEntry(entry.id, { lifeAreaId: area.id })).ok, true);
  assert.equal((await editTimeEntry(entry.id, { lifeAreaId: null })).ok, true, 'irrotus onnistuu');
  assert.equal(getState().timeEntries[0].lifeAreaId, null);
});

test('F6: lähetystä odottavaa kirjausta ei muokata (kannassa ei vielä riviä), eikä sille tarjota liitosta', async (t) => {
  freezeLocalDate(t, THURSDAY);
  const { area } = await createLifeArea({ name: 'Perhe', importance: 5 });
  setTimeEntryWriterForTests(createTimeEntryWriter({
    repo: { isPersistent: () => true, insert: async () => ({ ok: false, error: { cause: { message: 'Failed to fetch' } } }) },
    loadOutbox, saveOutbox, userId: () => USER.id
  }));
  const { entry } = await logTime({ entryDate: THURSDAY, minutes: 20 }, { silent: true });
  const result = await editTimeEntry(entry.id, { lifeAreaId: area.id });
  assert.equal(result.ok, false);
  assert.equal(result.pending, true);
  renderDirection();
  assert.match(html('dirTimeList'), /Odottaa lähetystä/);
  assert.doesNotMatch(html('dirTimeList'), /data-time-area=/);
});

test('F6: tehtävän kategorian kautta alueeseen kuuluva kirjaus ei ole alueeton', async (t) => {
  freezeLocalDate(t, THURSDAY);
  await createLifeArea({ name: 'Työ', importance: 3, categoryKey: 'tyo' });
  setTasks([normalizeTask({ id: 't1', title: 'Raportti', date: THURSDAY, category: 'tyo' })]);
  await logTime({ entryDate: THURSDAY, minutes: 30, taskId: 't1' });
  renderDirection();
  assert.doesNotMatch(html('dirTimeList'), /data-time-area=/);
});

test('F6: "Kohdista kirjattu aika" näyttää vain alueettomat kirjaukset ja palaa kaikkiin', async (t) => {
  freezeLocalDate(t, THURSDAY);
  const { area } = await createLifeArea({ name: 'Perhe', importance: 5, targetMinutesPerWeek: 300 });
  await logTime({ entryDate: THURSDAY, minutes: 30, lifeAreaId: area.id });
  await logTime({ entryDate: THURSDAY, minutes: 50 });
  await logTime({ entryDate: THURSDAY, minutes: 40 });
  initDirection();
  renderDirection();
  assert.match(html('dirQuality'), /data-quality-action="assign_time">Kohdista kirjattu aika<\/button>/);
  node('dirQuality').dispatch('click', eventFor({ qualityAction: 'assign_time' }));
  const list = html('dirTimeList');
  assert.match(list, /Näytetään vain kirjaukset ilman aluetta \(2\)\./);
  assert.doesNotMatch(list, /30 min/);
  node('dirTimeList').dispatch('click', eventFor({ timeShowAll: '1' }));
  assert.match(html('dirTimeList'), /30 min/);
});

// ================================================================ F8

test('F8: kategoriavalikot ovat "Kategoria", ei "Elämänalue"', () => {
  for (const id of ['afCategory', 'rfCategory', 'gfCategory', 'prfCategory']) {
    assert.match(HTML, new RegExp(`<label class="field-label" for="${id}">Kategoria</label>`), id);
  }
  assert.match(HTML, /<label class="field-label" for="gfLifeArea">Elämänalue \(Suunta\)<\/label>/);
  assert.match(HTML, /<p class="hint" id="gfLifeAreaHint" hidden>Ei elämänalueita — luo ne Suunnassa<\/p>/);
});

test('F8 KRIITTINEN: tavoitteen elämänalue asetetaan tavoitelomakkeelta ja tallentuu (portin mukaan)', async (t) => {
  freezeLocalDate(t, THURSDAY);
  const inactive = await createLifeArea({ name: 'Vanha', importance: 2, active: false });
  const { area } = await createLifeArea({ name: 'Terveys', importance: 4 });
  const { goal } = await createGoal({ title: 'Juokse 10 km' });
  initGoalForm();
  openGoalForm(goal.id);
  const options = html('gfLifeArea');
  assert.ok(options.indexOf('Terveys') < options.indexOf('Vanha (pois käytöstä)'), 'käytössä olevat ensin');
  assert.equal(inactive.ok, true);
  assert.equal(node('gfLifeAreaHint').hidden, true);
  node('gfLifeArea').value = area.id;
  const before = client.calls.length;
  node('gfSave').dispatch('click');
  await flush();
  assert.equal(getState().goals.find(g => g.id === goal.id).lifeAreaId, area.id);
  const update = client.calls.slice(before).find(c => c.table === 'goals' && c.operation === 'update');
  if (columnGateOpen('GOAL_LIFE_AREA_FIELD') && update) {
    assert.equal(update.payload.life_area_id, area.id, 'portti auki: life_area_id lähtee kantaan');
  } else if (update) {
    assert.equal('life_area_id' in update.payload, false, 'portti kiinni: saraketta ei lähetetä');
  }
  // Tavoitteen näkymä kertoo alueen.
  setOpenGoalId(goal.id);
  renderGoalDetail();
  assert.match(html('goalDetailContainer'), /Elämänalue: Terveys/);
});

test('F8: ilman alueita tavoitelomake kertoo mistä ne luodaan; tuntematon nykyinen alue säilyy', async (t) => {
  freezeLocalDate(t, THURSDAY);
  initGoalForm();
  openNewGoalForm();
  assert.equal(node('gfLifeAreaHint').hidden, false);
  assert.equal(html('gfLifeArea'), '<option value="">Ei elämänaluetta</option>');
  const { goal } = await createGoal({ title: 'Kitara', lifeAreaId: 'lataamaton-alue' });
  openGoalForm(goal.id);
  assert.match(html('gfLifeArea'), /<option value="lataamaton-alue">Nykyinen alue \(ei näkyvissä\)<\/option>/);
  assert.equal(node('gfLifeArea').value, 'lataamaton-alue', 'tallennus ei katkaise liitosta huomaamatta');
});

// ================================================================ F10 / F11

test('F10: kestokentissä ei ole min=1 step=5 -yhdistelmää (30 min hylättäisiin)', () => {
  const sources = [HTML, read('src/app/views/direction.js'), read('src/app/views/directionSetup.js'), read('src/app/views/timeLog.js')];
  for (const source of sources) {
    for (const match of source.matchAll(/<input type="number"([^>]*)>/g)) {
      const attributes = match[1];
      const bad = /min="1"/.test(attributes) && /step="5"/.test(attributes);
      assert.equal(bad, false, match[0]);
    }
  }
  for (const id of ['dirTimeMinutes', 'afDuration', 'rfDuration']) {
    assert.match(HTML, new RegExp(`id="${id}" min="1" max="1440" step="1"`), id);
  }
});

test('F11: tehtävälomakkeen kestopikavalinnat täyttävät kentän ja piiloutuvat, kun aikaväli määrää keston', async (t) => {
  freezeLocalDate(t, THURSDAY);
  initTaskForm();
  const presets = html('afDurationPresets');
  for (const label of ['10 min', '30 min', '1 h', '2 h']) assert.ok(presets.includes(`>${label}</button>`), label);
  assert.match(HTML, /<div class="dir-presets" id="afDurationPresets" role="group" aria-label="Kestoarvion pikavalinnat"><\/div>/);
  node('afDurationPresets').dispatch('click', eventFor({ durationPreset: '60' }));
  assert.equal(node('afDuration').value, '60');
  node('afTitle').value = 'Raportti';
  node('afDate').value = THURSDAY;
  node('afSave').dispatch('click');
  await flush();
  assert.equal(getState().tasks.find(task => task.title === 'Raportti').durationMinutes, 60);
  node('afTime').value = '10:00';
  node('afEndTime').value = '11:30';
  node('afTime').dispatch('input');
  assert.equal(node('afDurationPresets').style.display, 'none');
  node('afTime').value = '';
  node('afTime').dispatch('input');
  assert.equal(node('afDurationPresets').style.display, 'flex');
});

test('F11: rutiinilomakkeen tavoitevalinta tallentuu rutiiniin (goal_id kulkee repositorion läpi)', async (t) => {
  freezeLocalDate(t, THURSDAY);
  const { goal } = await createGoal({ title: 'Liikunta' });
  initRoutineForm();
  openNewRoutineForm();
  assert.match(html('rfGoal'), new RegExp(`<option value="${goal.id}">Liikunta</option>`));
  assert.match(HTML, /<label class="field-label" for="rfGoal">Liittyy tavoitteeseen<\/label>/);
  node('rfTitle').value = 'Venyttely';
  node('rfGoal').value = goal.id;
  node('rfSave').dispatch('click');
  await flush();
  const routine = getState().routines.find(r => r.title === 'Venyttely');
  assert.equal(routine.goalId, goal.id);
  assert.equal(routinesRepo.mapping.toRow(routine).goal_id, goal.id);
});
