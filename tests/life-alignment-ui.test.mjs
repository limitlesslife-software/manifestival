// Suunta: sovelluskerroksen ja näkymän integraatiotestit.
//
// Näkymä renderöidään oikeasti: testin DOM-tynkä tarjoaa TÄSMÄLLEEN ne
// elementit, joiden tunniste on index.html:ssä, ja renderDirection()
// kirjoittaa niihin. Tarkistukset kohdistuvat tuotettuun HTML:ään ja
// sovelluksen tilaan, eivät lähdekoodin tekstiin.
//
// Kello jäädytetään: Suunta lukee "tämän päivän" vain src/app/alignment.js:n
// clockNow()-funktiosta, ja testi päättää mikä päivä se on.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { read } from './helpers/sources.mjs';
import { freezeLocalDate } from './helpers/clock.mjs';
import { setUser, clearUser } from '../src/data/session.js';
import { setClient } from '../src/data/client.js';
import { fakeClient } from './helpers/gates.mjs';
import { resetState, getState, setGoals, setTasks } from '../src/app/state.js';
import { clearLocalUserData, createGoal } from '../src/app/actions.js';
import { lifeAreasRepo } from '../src/data/collectionsRepo.js';
import { normalizeGoal } from '../src/domain/goal.js';
import { normalizeTask } from '../src/domain/task.js';
import { ADJUSTMENT } from '../src/domain/alignmentReview.js';
import {
  createLifeArea, editLifeArea, deleteLifeArea, assignGoalToLifeArea, saveWeeklyCapacity,
  logTime, deleteTimeEntry, saveWeeklyReview, applyAdjustment, analyzeCurrentWeek,
  currentProposals, currentPlanningFeedback, resetAppliedAdjustments, alignmentPersistence
} from '../src/app/alignment.js';
import {
  renderDirection, renderTodayDirection, openAreaForm, resetDirectionView, initDirection
} from '../src/app/views/direction.js';

const USER = { id: 'aaaaaaaa-5555-4555-8555-000000000055', email: 'suunta@example.com' };
const THURSDAY = '2026-09-17';
const WEEK = '2026-09-14';

// ------------------------------------------------------------ DOM-tynkä

const HTML_IDS = new Set([...read('index.html').matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));

function stubElement(id = null) {
  const listeners = {};
  const classes = new Set();
  const attributes = {};
  return {
    id, innerHTML: '', textContent: '', value: '', checked: false, disabled: false,
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
    dispatch: (type, event) => (listeners[type] || []).forEach(fn => fn(event)),
    focus() { globalThis.document.activeElement = this; },
    querySelector: () => null,
    querySelectorAll: () => [],
    appendChild: () => {},
    remove: () => {},
    closest: () => null
  };
}

let elements;
function installDom() {
  elements = new Map();
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

function html(id) {
  return globalThis.document.getElementById(id).innerHTML;
}

// --------------------------------------------------------------- asetelma

const confirmYes = async () => true;
const confirmNo = async () => false;

beforeEach(() => {
  clearUser();
  clearLocalUserData();
  resetState();
  resetAppliedAdjustments();
  resetDirectionView();
  setUser(USER);
  setClient(fakeClient({ data: [], error: null }));
  installDom();
});

afterEach(() => {
  delete globalThis.document;
  delete globalThis.CSS;
});

/** Tavoite oikean toiminnon kautta: tila JA repositorio, kuten sovelluksessa. */
async function goal(input) {
  const result = await createGoal(input);
  assert.equal(result.ok, true, 'tavoitteen luonti');
  return result.goal;
}

function task(id, date, minutes, extra = {}) {
  return normalizeTask({ id, title: 'Tehtävä ' + id, date, durationMinutes: minutes, ...extra });
}

// ================================================================ ENSIKÄYTTÖ

test('tyhjä tila: ehdotukset näkyvät mutta mitään ei luoda; havainnot kertovat mistä aloittaa', (t) => {
  freezeLocalDate(t, THURSDAY);
  renderDirection();
  assert.match(html('dirAreaSuggestions'), /data-area-suggest="Perhe"/);
  assert.match(html('dirSignals'), /Aloita elämänalueista/);
  assert.equal(getState().lifeAreas.length, 0, 'ehdotuksista ei synny alueita');
  // Näkymä kertoo säilyvyydestä rehellisesti portin mukaan: kiinni ->
  // "vain tämän istunnon ajan", auki -> ei varoitusta.
  if (Object.values(alignmentPersistence()).every(Boolean)) {
    assert.doesNotMatch(html('dirPersistNote'), /vain tämän istunnon ajan/,
      'portit auki: näkymä väittää, ettei tieto säily');
  } else {
    assert.match(html('dirPersistNote'), /säilyvät toistaiseksi vain tämän istunnon ajan/,
      'portit kiinni: näkymä kertoo, ettei tieto säily');
  }

  openAreaForm(null, { name: 'Perhe', categoryKey: 'perhe' });
  assert.equal(document.getElementById('dirAreaName').value, 'Perhe', 'ehdotus esitäyttää lomakkeen');
  assert.equal(getState().lifeAreas.length, 0);
});

// ================================================================ ELÄMÄNALUEET

test('elämänalueen luonti, tärkeyden muokkaus ja aikatavoite', async (t) => {
  freezeLocalDate(t, THURSDAY);
  const created = await createLifeArea({ name: 'Perhe', importance: 5, targetMinutesPerWeek: 600, categoryKey: 'perhe' });
  assert.equal(created.ok, true);
  renderDirection();
  assert.match(html('dirAreasList'), /Perhe/);
  assert.match(html('dirAreasList'), /Erittäin tärkeä/);
  assert.match(html('dirAreasList'), /tavoite 10 h\/vko/);

  const edited = await editLifeArea(created.area.id, { importance: 2 });
  assert.equal(edited.ok, true);
  assert.equal(getState().lifeAreas[0].targetMinutesPerWeek, 600, 'tärkeyden muutos ei muuta tavoitetta');
  renderDirection();
  assert.match(html('dirAreasList'), /Jonkin verran tärkeä/);

  await editLifeArea(created.area.id, { targetMinutesPerWeek: 900 });
  assert.equal(getState().lifeAreas[0].importance, 2, 'tavoitteen muutos ei muuta tärkeyttä');
});

test('elämänalueen virheet: tyhjä nimi, kaksoiskappale, kategoria toisella alueella', async () => {
  assert.equal((await createLifeArea({ name: '' })).errors.name !== undefined, true);
  await createLifeArea({ name: 'Työ', categoryKey: 'tyo' });
  assert.ok((await createLifeArea({ name: 'työ' })).errors.name);
  assert.ok((await createLifeArea({ name: 'Ura', categoryKey: 'tyo' })).errors.categoryKey);
  assert.equal(getState().lifeAreas.length, 1);
});

test('tallennusvirhe perutaan: alue ei jää tilaan', async () => {
  const original = lifeAreasRepo.insert;
  lifeAreasRepo.insert = async () => ({ ok: false, error: 'Tallennus ei onnistunut.' });
  try {
    const result = await createLifeArea({ name: 'Perhe' });
    assert.equal(result.ok, false);
    assert.equal(getState().lifeAreas.length, 0);
  } finally {
    lifeAreasRepo.insert = original;
  }
});

test('alueen poisto vaatii vahvistuksen; tavoitteet ja kirjattu aika säilyvät ilman aluetta', async (t) => {
  freezeLocalDate(t, THURSDAY);
  const { area } = await createLifeArea({ name: 'Harrastus', importance: 2 });
  setGoals([normalizeGoal({ id: 'g1', title: 'Kitara', lifeAreaId: area.id })]);
  await logTime({ entryDate: THURSDAY, minutes: 30, lifeAreaId: area.id });

  assert.equal(await deleteLifeArea(area.id, { confirmFn: confirmNo }), false);
  assert.equal(getState().lifeAreas.length, 1, 'peruutettu poisto ei poista');

  assert.equal(await deleteLifeArea(area.id, { confirmFn: confirmYes }), true);
  assert.equal(getState().lifeAreas.length, 0);
  assert.equal(getState().goals[0].lifeAreaId, null, 'tavoite säilyy ilman aluetta');
  assert.equal(getState().timeEntries.length, 1, 'kirjattu aika säilyy');
  assert.equal(getState().timeEntries[0].lifeAreaId, null);
});

// ================================================================ TAVOITTEET

test('tavoitteen liittäminen alueeseen; vanha tavoite näkyy kohdassa "Ei elämänaluetta"', async (t) => {
  freezeLocalDate(t, THURSDAY);
  const { area } = await createLifeArea({ name: 'Terveys', importance: 4 });
  await goal({ title: 'Vanha tavoite' });
  const run = await goal({ title: 'Juokse 10 km' });
  await goal({ title: 'Valmis', status: 'completed' });
  renderDirection();
  assert.match(html('dirGoalsList'), /Ei elämänaluetta/);
  assert.match(html('dirGoalsList'), /Vanha tavoite/);
  assert.equal(/Valmis/.test(html('dirGoalsList')), false, 'valmis tavoite ei ole liitettävien listalla');

  const result = await assignGoalToLifeArea(run.id, area.id);
  assert.equal(result.ok, true);
  assert.equal(getState().goals.find(g => g.id === run.id).lifeAreaId, area.id);
  renderDirection();
  const list = html('dirGoalsList');
  assert.ok(list.indexOf('Terveys') > -1 && list.indexOf('Juokse 10 km') > list.indexOf('Terveys'));

  assert.equal((await assignGoalToLifeArea(run.id, 'olematon')).ok, false);
  await assignGoalToLifeArea(run.id, null);
  assert.equal(getState().goals.find(g => g.id === run.id).lifeAreaId, null, 'irrotus onnistuu');
});

// ================================================================ KAPASITEETTI JA KUORMITUS

test('kapasiteetti: yksi arvo viikkoa kohti, päivitys ei luo toista', async (t) => {
  freezeLocalDate(t, THURSDAY);
  assert.equal((await saveWeeklyCapacity({ weekStart: THURSDAY, availableMinutes: 1200 })).ok, true);
  assert.equal((await saveWeeklyCapacity({ weekStart: WEEK, availableMinutes: 900, energyLevel: 2 })).ok, true);
  assert.equal(getState().weeklyCapacities.length, 1);
  assert.equal(getState().weeklyCapacities[0].availableMinutes, 900);
  assert.equal(getState().weeklyCapacities[0].weekStart, WEEK);
  assert.ok((await saveWeeklyCapacity({ weekStart: WEEK, availableMinutes: 99999 })).errors.availableMinutes);
});

test('kuormitus näkyy: luvut, vakavuus tekstinä, "miksi" ja palkin tekstivastine', async (t) => {
  freezeLocalDate(t, THURSDAY);
  await createLifeArea({ name: 'Työ', importance: 4, targetMinutesPerWeek: 900, categoryKey: 'tyo' });
  await saveWeeklyCapacity({ weekStart: WEEK, availableMinutes: 600 });
  setTasks([task('a', WEEK, 500, { category: 'tyo' }), task('b', THURSDAY, 300, { category: 'tyo' }),
    task('c', THURSDAY, null, { category: 'tyo' })]);
  renderDirection();

  const signals = html('dirSignals');
  assert.match(signals, /Kuormitus ylittää kapasiteetin/);
  assert.match(signals, /Vahva/, 'vakavuus kerrotaan sanana, ei vain värinä');
  assert.match(signals, /Miksi tämä näkyy\?/);
  assert.match(signals, /overload\.known_exceeds_capacity/);
  const week = html('dirWeekSummary');
  assert.match(week, /role="img" aria-label="Suunniteltu 13 h 20 min, kapasiteetti 10 h"/);
  assert.match(week, /1 asia ilman kestoarviota/, "yksikkö: 1 asia, ei 1 asiaa");
  assert.match(week, /tuntematon ei ole nolla/);
});

// ================================================================ HUOMIOTTA JÄÄMINEN JA POIKKEAMA

test('huomiotta jääminen näkyy torstaina toteuman perusteella', async (t) => {
  freezeLocalDate(t, THURSDAY);
  const family = await createLifeArea({ name: 'Perhe', importance: 5, targetMinutesPerWeek: 700 });
  const work = await createLifeArea({ name: 'Työ', importance: 3, targetMinutesPerWeek: 1200 });
  await logTime({ entryDate: WEEK, minutes: 600, lifeAreaId: work.area.id });
  await logTime({ entryDate: WEEK, minutes: 30, lifeAreaId: family.area.id });
  renderDirection();
  const signals = html('dirSignals');
  assert.match(signals, /Perhe jäämässä huomiotta/);
  assert.match(signals, /Perhe on saanut 30 min/);
});

test('poikkeama tavoitteista näkyy prosentteina', async (t) => {
  freezeLocalDate(t, '2026-09-21');
  const work = await createLifeArea({ name: 'Työ', importance: 3, targetMinutesPerWeek: 1200 });
  const fam = await createLifeArea({ name: 'Perhe', importance: 3, targetMinutesPerWeek: 750 });
  const own = await createLifeArea({ name: 'Oma aika', importance: 3, targetMinutesPerWeek: 1050 });
  await logTime({ entryDate: WEEK, minutes: 620, lifeAreaId: work.area.id });
  await logTime({ entryDate: WEEK, minutes: 120, lifeAreaId: fam.area.id });
  await logTime({ entryDate: WEEK, minutes: 260, lifeAreaId: own.area.id });
  const analysis = analyzeCurrentWeek(WEEK);
  assert.ok(analysis.signals.some(s => s.kind === 'misalignment' && s.metrics.actualPercent === 62));
  resetDirectionView();
  initDirection();
  document.getElementById('dirPrev').dispatch('click');
  // Edellinen viikko on nyt näkyvissä: sama viikko jota yllä analysoitiin.
  assert.match(html('dirSignals'), /Työ sai 62 % ajastasi, vaikka tavoite oli 40 %/);
});

// ================================================================ TOTEUMA

test('toteuma: kirjaus ja poisto; valmiiksi merkintä ei tuota toteumaa', async (t) => {
  freezeLocalDate(t, THURSDAY);
  setTasks([task('a', THURSDAY, 90, { completed: true })]);
  assert.equal(analyzeCurrentWeek().actual.minutes, 0, 'valmis tehtävä ei ole toteutunutta aikaa');

  const bad = await logTime({ entryDate: THURSDAY, minutes: 0 });
  assert.ok(bad.errors.minutes);
  const { entry } = await logTime({ entryDate: THURSDAY, minutes: 45, taskId: 'olematon', note: 'kirjoitin' });
  assert.equal(entry.taskId, null, 'olematon tehtäväviite pudotetaan');
  renderDirection();
  assert.match(html('dirTimeList'), /45 min/);
  assert.match(html('dirTimeList'), /Ei aluetta/);
  assert.equal(await deleteTimeEntry(entry.id), true);
  assert.equal(getState().timeEntries.length, 0);
});

// ================================================================ KATSAUS JA MUUTOKSET

test('viikkokatsaus: tilannekuva, pohdinta ja historia; toinen tallennus päivittää', async (t) => {
  freezeLocalDate(t, '2026-09-20');
  await createLifeArea({ name: 'Perhe', importance: 5, targetMinutesPerWeek: 600 });
  await saveWeeklyCapacity({ weekStart: WEEK, availableMinutes: 1200 });
  const first = await saveWeeklyReview({ weekStart: WEEK, reflection: 'Liikaa töitä.' });
  assert.equal(first.ok, true);
  assert.equal(first.review.snapshot.version, 1);
  assert.equal(first.review.snapshot.capacity.availableMinutes, 1200);
  const second = await saveWeeklyReview({ weekStart: WEEK, reflection: 'Päivitetty.' });
  assert.equal(second.review.id, first.review.id);
  assert.equal(getState().alignmentReviews.length, 1);
  renderDirection();
  assert.match(html('dirReviewHistory'), /Viikko 14\.9\.–20\.9\.2026/);
  assert.match(html('dirReviewHistory'), /Päivitetty\./);
  assert.match(html('dirReview'), /Mikä oli tällä viikolla tärkeää\?/);
  assert.equal(/valmistui|%\s*valmis|suoritusaste/i.test(html('dirReview')), false,
    'katsaus ei ole suorituspisteytys');
});

test('muutosehdotus: peruutus ei muuta mitään, vahvistus muuttaa kerran, toinen yritys ei toista', async (t) => {
  freezeLocalDate(t, '2026-09-20');
  const { area } = await createLifeArea({ name: 'Perhe', importance: 5, targetMinutesPerWeek: 600 });
  const lapset = await goal({ title: 'Lapset', lifeAreaId: area.id, priority: 'korkea' });
  const analysis = analyzeCurrentWeek(WEEK);
  const proposals = currentProposals(analysis);
  const create = proposals.find(p => p.type === ADJUSTMENT.CREATE_TASK);
  assert.ok(create, 'huomiotta jäävä alue tuottaa varausehdotuksen');

  const cancelled = await applyAdjustment(create, { confirmFn: confirmNo });
  assert.equal(cancelled.cancelled, true);
  assert.equal(getState().tasks.length, 0, 'peruttu ehdotus ei luo mitään');

  const applied = await applyAdjustment(create, { confirmFn: confirmYes });
  assert.equal(applied.applied, true);
  assert.equal(getState().tasks.length, 1);
  assert.equal(getState().tasks[0].goalId, lapset.id);
  assert.equal(getState().tasks[0].date, '2026-09-21');

  const again = await applyAdjustment(create, { confirmFn: confirmYes });
  assert.equal(again.duplicate, true);
  assert.equal(getState().tasks.length, 1, 'sama ehdotus ei toteudu kahdesti');
});

test('muutosehdotus: tavoitteen muutos käyttää käyttäjän muokkaamaa arvoa; keskeytys käyttää tavoitteen tilaa', async (t) => {
  freezeLocalDate(t, '2026-09-20');
  const { area } = await createLifeArea({ name: 'Perhe', importance: 5, targetMinutesPerWeek: 600 });
  const change = { id: 'change_target:x', type: ADJUSTMENT.CHANGE_TARGET, label: 'Muuta', payload: { areaId: area.id, from: 600, to: 300 } };
  await applyAdjustment(change, { confirmFn: confirmYes, overrides: { to: 450 } });
  assert.equal(getState().lifeAreas[0].targetMinutesPerWeek, 450);

  const kitara = await goal({ title: 'Kitara', status: 'active' });
  await applyAdjustment({ id: 'pause_goal:g', type: ADJUSTMENT.PAUSE_GOAL, label: 'Keskeytä', payload: { goalId: kitara.id } },
    { confirmFn: confirmYes });
  assert.equal(getState().goals.find(g => g.id === kitara.id).status, 'paused');
});

test('muutosehdotus: kuorman kevennys siirtää tehtävät viikolla eteenpäin (ei poista, ei koske valmiiseen)', async (t) => {
  freezeLocalDate(t, '2026-09-20');
  setTasks([task('x', '2026-09-22', 120, { time: '10:00' }), task('y', '2026-09-23', 60),
    task('z', '2026-09-24', 30, { completed: true })]);
  const result = await applyAdjustment({ id: 'postpone_tasks:w', type: ADJUSTMENT.POSTPONE_TASKS, label: 'Kevennä',
    payload: { taskIds: ['x', 'z', 'olematon'], days: 7 } }, { confirmFn: confirmYes });
  assert.equal(result.applied, true);
  const x = getState().tasks.find(item => item.id === 'x');
  assert.equal(x.date, '2026-09-29');
  assert.equal(x.time, '10:00', 'kellonaika säilyy');
  assert.equal(getState().tasks.length, 3, 'tehtävät säilyvät');
  assert.equal(getState().tasks.find(item => item.id === 'y').date, '2026-09-23', 'valitsematon ei siirry');
  assert.equal(getState().tasks.find(item => item.id === 'z').date, '2026-09-24', 'valmis ei siirry');
});

test('tuntematon ehdotustyyppi hylätään ilman vahvistusta', async () => {
  let asked = false;
  const result = await applyAdjustment({ id: 'x', type: 'delete_everything', payload: {} },
    { confirmFn: async () => { asked = true; return true; } });
  assert.equal(result.ok, false);
  assert.equal(asked, false);
});

// ================================================================ SUUNNITTELUN PALAUTE

test('suunnittelun palaute: käyttäjän kapasiteetti rajaa suunnittelun viikkoajan', async (t) => {
  freezeLocalDate(t, THURSDAY);
  await saveWeeklyCapacity({ weekStart: WEEK, availableMinutes: 600 });
  setTasks([task('a', WEEK, 900)]);
  const feedback = currentPlanningFeedback();
  assert.equal(feedback.overloaded, true);
  assert.equal(feedback.capHours, 10);
  const planning = read('src/app/planning.js');
  assert.match(planning, /alignmentCapHours/, 'suunnittelu käyttää Suunnan rajaa');
});

// ================================================================ PÄIVÄNÄKYMÄ

test('päivänäkymän kortti: kapasiteetti jäljellä, yksi havainto, liittämätön työ', async (t) => {
  freezeLocalDate(t, THURSDAY);
  renderTodayDirection();
  assert.match(html('todayDirection'), /Kerro mikä elämässäsi on tärkeää/);

  await createLifeArea({ name: 'Työ', importance: 3, categoryKey: 'tyo' });
  await saveWeeklyCapacity({ weekStart: WEEK, availableMinutes: 600 });
  setTasks([task('a', THURSDAY, 60, { category: 'tyo' }), task('b', THURSDAY, 30, { category: 'koti' })]);
  renderTodayDirection();
  const card = html('todayDirection');
  assert.match(card, /Viikon kapasiteettia jäljellä 8 h 30 min/);
  assert.match(card, /1 viikon asia ei kuulu mihinkään alueeseen/);
  assert.equal(/<svg|<canvas|chart/i.test(card), false, 'ei kaavioita päivänäkymässä');
});

// ================================================================ TURVALLISUUS

test('KRIITTINEN: käyttäjän teksti escapetaan näkymässä', async (t) => {
  freezeLocalDate(t, THURSDAY);
  await createLifeArea({ name: '<img src=x onerror=alert(1)>', importance: 5, targetMinutesPerWeek: 600 });
  setGoals([normalizeGoal({ id: 'g', title: '<script>alert(2)</script>' })]);
  await logTime({ entryDate: THURSDAY, minutes: 30, note: '"><b>x</b>' });
  renderDirection();
  renderTodayDirection();
  for (const id of ['dirAreasList', 'dirGoalsList', 'dirTimeList', 'dirSignals', 'dirReview', 'todayDirection']) {
    const out = html(id);
    assert.equal(/<img src=x|<script>|<b>x<\/b>/.test(out), false, `${id} ei escapoi`);
  }
});
