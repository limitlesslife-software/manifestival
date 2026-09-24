// Suunta 2: näkymät — Suunta-keskus v2, päivän kortti, ajastinpalkki,
// työnkulut (arviointi, kohdistus), katsaus v2, esikatselu ja
// ryhmävahvistus, kehitys, selitys, saavutettavuus ja mobiili.
//
// Näkymä renderöidään oikeasti index.html:n tunnisteita vastaavaan
// DOM-tynkään (sama kuvio kuin life-alignment-ui.test.mjs). Kello
// jäädytetään.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { read } from './helpers/sources.mjs';
import { freezeLocalDate } from './helpers/clock.mjs';
import { setUser, clearUser } from '../src/data/session.js';
import { setClient } from '../src/data/client.js';
import { fakeClient } from './helpers/gates.mjs';
import { resetState, getState, setTasks, setGoals } from '../src/app/state.js';
import { clearLocalUserData } from '../src/app/actions.js';
import {
  createLifeArea, saveWeeklyCapacity, saveWeeklyReview, resetAppliedAdjustments, currentProposals,
  analyzeCurrentWeek, applySelectedAdjustments, previewSelectedAdjustments, logTime, validatePlanAgainstAlignment
} from '../src/app/alignment.js';
import { saveItemSettings, startTracking, pauseTracking, setTimerRepoForTests } from '../src/app/timeTracking.js';
import { renderDirection, renderTodayDirection, initDirection, resetDirectionView } from '../src/app/views/direction.js';
import { renderTimerBar, openTimeLogDialog, closeTimeLogDialog } from '../src/app/views/timeLog.js';
import { resetTimerStoreForTests } from '../src/data/timerStore.js';
import { normalizeTask } from '../src/domain/task.js';
import { normalizeGoal } from '../src/domain/goal.js';
import { ADJUSTMENT } from '../src/domain/alignmentReview.js';
import { normalizePlan } from '../src/domain/plan.js';

const USER = { id: 'cccccccc-3333-4333-8333-00000000000c', email: 'ui2@example.com' };
const THURSDAY = '2026-09-17';
const WEEK = '2026-09-14';
const HTML = read('index.html');
const HTML_IDS = new Set([...HTML.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
const CSS = read('src/styles.css');

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
    dispatch: (type, event) => (listeners[type] || []).forEach(fn => fn(event)),
    focus() { globalThis.document.activeElement = this; },
    scrollIntoView() {},
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

const html = id => globalThis.document.getElementById(id).innerHTML;
const node = id => globalThis.document.getElementById(id);
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };
/** Tapahtuma, jonka kohde "löytää" annetun data-attribuutin. */
function clickOn(selector, dataset) {
  const target = { dataset, disabled: false, textContent: '', checked: dataset.checked === true };
  return { target: { closest: sel => (sel === selector ? target : null), dataset } };
}

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
});

afterEach(() => {
  delete globalThis.document;
  delete globalThis.CSS;
});

const task = (id, date, minutes, extra = {}) =>
  normalizeTask({ id, title: 'Tehtävä ' + id, date, durationMinutes: minutes, ...extra });

async function setupWeek() {
  await createLifeArea({ name: 'Perhe', importance: 5, targetMinutesPerWeek: 600, categoryKey: 'perhe' });
  await createLifeArea({ name: 'Työ', importance: 3, targetMinutesPerWeek: 600, categoryKey: 'tyo' });
  await saveWeeklyCapacity({ weekStart: WEEK, availableMinutes: 1200, energyBudgetMinutes: 120 });
  setTasks([
    task('w1', THURSDAY, 300, { category: 'tyo' }),
    task('w2', THURSDAY, null, { category: 'tyo' }),
    task('u1', THURSDAY, 30, { category: 'koti' })
  ]);
  await saveItemSettings('task', 'w1', { energyDemand: 5 });
}

// ================================================================ SUUNTA-KESKUS

test('Suunta: pikatoiminnot, energia omana rivinään ja aineiston laatu toimenpiteineen', async (t) => {
  freezeLocalDate(t, THURSDAY);
  await setupWeek();
  renderDirection();
  for (const id of ['dirStartTimer', 'dirQuickLog', 'dirOpenEstimate', 'dirOpenUnassigned']) {
    assert.ok(HTML_IDS.has(id), id);
  }
  assert.equal(node('dirStartTimer').textContent, 'Aloita ajanseuranta');
  const week = html('dirWeekSummary');
  assert.match(week, /Kuormittavaa 5 h, oma raja 2 h/);
  assert.match(week, /role="img" aria-label="Kuormittavaa 5 h, oma raja 2 h"/, 'palkilla tekstivastine');
  const signals = html('dirSignals');
  assert.match(signals, /Viikko on energiakuormaltaan raskas/);
  assert.match(signals, /Aikaa näyttäisi olevan riittävästi/);
  const quality = html('dirQuality');
  assert.match(quality, /data-quality-action="estimate"/);
  assert.match(quality, /data-quality-action="assign"/);
  assert.match(quality, /Arvioi tehtäviä/);
});

test('arviointi: karkea arvio yhdellä napautuksella; tuntematon ei muutu nollaksi', async (t) => {
  freezeLocalDate(t, THURSDAY);
  await setupWeek();
  initDirection();
  node('dirOpenEstimate').dispatch('click');
  assert.equal(node('dirEstimateSection').hidden, false);
  assert.match(html('dirEstimate'), /Tehtävä w2/);
  assert.match(html('dirEstimate'), /data-estimate="task:w2"/);
  assert.equal(/Tehtävä w1/.test(html('dirEstimate')), false, 'arvioitua ei kysytä');
  node('dirEstimate').dispatch('click', clickOn('[data-estimate]', { estimate: 'task:w2', minutes: '30' }));
  await flush();
  const w2 = getState().tasks.find(x => x.id === 'w2');
  assert.equal(w2.durationMinutes, 30);
  assert.equal(getState().alignmentItemSettings.find(s => s.itemId === 'w2').estimateApproximate, true);
  assert.equal(analyzeCurrentWeek(WEEK).planned.unknownCount, 0);
});

test('kohdistus: jätä tarkoituksella ilman aluetta -> ei muistuteta uudelleen', async (t) => {
  freezeLocalDate(t, THURSDAY);
  await setupWeek();
  initDirection();
  node('dirOpenUnassigned').dispatch('click');
  assert.match(html('dirUnassigned'), /Sinulla on 1 asia, jota ei ole liitetty elämänalueeseen\./);
  assert.match(html('dirUnassigned'), /Jätä tarkoituksella ilman aluetta/);
  node('dirUnassigned').dispatch('click', clickOn('[data-assign-optout]', { assignOptout: 'task:u1' }));
  await flush();
  const analysis = analyzeCurrentWeek(WEEK);
  assert.equal(analysis.dataQuality.unassignedPlannedCount, 0);
  assert.equal(analysis.dataQuality.intentionallyUnassignedCount, 1);
  renderDirection();
  assert.match(html('dirUnassigned'), /Ei kohdistamattomia asioita/);
});

test('kohdistus: kategorian kautta alueeseen ja "ohita nyt" ei tallenna mitään', async (t) => {
  freezeLocalDate(t, THURSDAY);
  await setupWeek();
  initDirection();
  node('dirOpenUnassigned').dispatch('click');
  node('dirUnassigned').dispatch('click', clickOn('[data-assign-skip]', { assignSkip: 'task:u1' }));
  assert.equal(getState().alignmentItemSettings.some(s => s.alignmentOptOut), false);
  resetDirectionView();
  initDirection();
  node('dirOpenUnassigned').dispatch('click');
  const select = { dataset: { assignCategory: 'task:u1' }, value: 'perhe' };
  node('dirUnassigned').dispatch('change', { target: { closest: sel => (sel === '[data-assign-category]' ? select : null) } });
  await flush();
  assert.equal(getState().tasks.find(x => x.id === 'u1').category, 'perhe');
  assert.equal(analyzeCurrentWeek(WEEK).dataQuality.unassignedPlannedCount, 0);
});

test('kohdistus: näytetty otsikko suojataan (XSS)', async (t) => {
  freezeLocalDate(t, THURSDAY);
  await createLifeArea({ name: 'Työ', importance: 3, targetMinutesPerWeek: 600, categoryKey: 'tyo' });
  setTasks([task('x', THURSDAY, null, { title: '<img src=x onerror=alert(1)>', category: 'koti' })]);
  initDirection();
  node('dirOpenUnassigned').dispatch('click');
  node('dirOpenEstimate').dispatch('click');
  assert.equal(html('dirUnassigned').includes('<img'), false);
  assert.equal(html('dirEstimate').includes('<img'), false);
  assert.match(html('dirUnassigned'), /&lt;img/);
});

// ================================================================ KATSAUS v2

test('katsaus v2: kuusi osiota, pohdintavastaukset historiaan, sääntöversio näkyy', async (t) => {
  freezeLocalDate(t, '2026-09-20');
  await setupWeek();
  await logTime({ entryDate: THURSDAY, minutes: 200, lifeAreaId: getState().lifeAreas[1].id });
  const saved = await saveWeeklyReview({ weekStart: WEEK, reflection: null, reflectionAnswers: { most_draining: 'Julkaisu' } });
  assert.equal(saved.ok, true);
  assert.deepEqual(saved.review.reflectionAnswers, { most_draining: 'Julkaisu' });
  renderDirection();
  const review = html('dirReview');
  for (const title of ['Suunta', 'Suunnitelma', 'Toteuma', 'Poikkeamat']) {
    assert.match(review, new RegExp(`<h3 class="dir-subtitle">${title} `));
  }
  assert.match(review, /Kuormittiko viikko enemmän kuin jaksoin\?/);
  for (const code of ['took_longer', 'too_little', 'unplanned_important', 'most_draining', 'drop_next_week']) {
    assert.match(HTML, new RegExp(`<label class="field-label" for="dirAnswer-${code}">`), `vastauskentällä ${code} on label`);
  }
  assert.match(html('dirReviewHistory'), /Vastattuja pohdintakysymyksiä: 1/);
  assert.match(html('dirReviewHistory'), /Säännöt: Suunta 2/);
  assert.equal(html('dirReviewHistory').includes('Julkaisu'), false, 'vastaukset eivät näy yhteenvedossa');
  assert.match(html('dirReviewCompare'), /Verrattuna edelliseen viikkoon|Edellisestä viikosta ei ole vertailtavaa/);
});

test('kehitys lasketaan vasta pyydettäessä (ei kahdeksaa analyysia joka renderöinnillä)', async (t) => {
  freezeLocalDate(t, THURSDAY);
  await setupWeek();
  initDirection();
  renderDirection();
  assert.match(html('dirTrends'), /Näytä viikkojen kehitys/);
  node('dirTrends').dispatch('click', clickOn('[data-show-trends]', { showTrends: '1' }));
  assert.match(html('dirTrends'), /Kehityksestä kerrotaan, kun aineistoa on vähintään 3 viikolta\./);
  assert.match(html('dirTrends'), /<caption>/);
});

test('tasapainotus: valitut ehdotukset esikatsellaan ja vahvistetaan yhdellä dialogilla, joka luettelee kaiken', async (t) => {
  freezeLocalDate(t, '2026-09-20');
  await createLifeArea({ name: 'Työ', importance: 3, targetMinutesPerWeek: 600, categoryKey: 'tyo' });
  await saveWeeklyCapacity({ weekStart: WEEK, availableMinutes: 600 });
  await saveWeeklyCapacity({ weekStart: '2026-09-21', availableMinutes: 600 });
  setTasks([task('n1', '2026-09-22', 500, { category: 'tyo' }), task('n2', '2026-09-23', 300, { category: 'tyo', priority: 'matala' })]);
  const proposals = currentProposals(analyzeCurrentWeek(WEEK));
  const postpone = proposals.find(p => p.type === ADJUSTMENT.POSTPONE_TASKS);
  assert.ok(postpone);
  const preview = previewSelectedAdjustments(WEEK, [postpone]);
  assert.equal(preview.before.plannedMinutes, 800);
  assert.ok(preview.after.plannedMinutes <= 600);
  assert.equal(getState().tasks.find(x => x.id === 'n2').date, '2026-09-23', 'esikatselu ei kirjoita');

  let dialog = null;
  const cancelled = await applySelectedAdjustments([postpone], { preview, confirmFn: async d => { dialog = d; return false; } });
  assert.equal(cancelled.cancelled, true);
  assert.equal(getState().tasks.find(x => x.id === 'n2').date, '2026-09-23', 'peruttu ryhmä ei muuta mitään');
  assert.match(dialog.message, /^1\. Kevennä ensi viikkoa/);
  assert.match(dialog.message, /Ensi viikko muutosten jälkeen: suunniteltu/);

  const done = await applySelectedAdjustments([postpone], { preview, confirmFn: async () => true });
  assert.equal(done.ok, true);
  assert.equal(getState().tasks.find(x => x.id === 'n2').date, '2026-09-30');
  const again = await applySelectedAdjustments([postpone], { preview, confirmFn: async () => true });
  assert.deepEqual(again.results, [], 'sama ryhmä ei toteudu kahdesti');
});

test('ohjaava ehdotus ("arvioi") ei ole kirjoitus eikä kuulu ryhmävahvistukseen', async () => {
  const result = await applySelectedAdjustments([{ id: 'r', type: ADJUSTMENT.REQUEST_ESTIMATES, label: 'Arvioi', payload: {} }],
    { confirmFn: async () => { throw new Error('ei saa kysyä'); } });
  assert.deepEqual(result.results, []);
});

// ================================================================ SELITYS

test('selitys: ilman palvelua deterministinen selitys näkyy, eikä tekoälyä väitetä käytetyn', async (t) => {
  freezeLocalDate(t, THURSDAY);
  await setupWeek();
  initDirection();
  renderDirection();
  assert.match(html('dirSignals'), /data-explain="energy_overload:week"/);
  node('dirSignals').dispatch('click', clickOn('[data-explain]', { explain: 'energy_overload:week' }));
  await flush();
  const signals = html('dirSignals');
  assert.match(signals, /<strong>Selitys:<\/strong>/);
  assert.equal(signals.includes('Tekoälyn selitys'), false);
});

// ================================================================ PÄIVÄN KORTTI

test('päivän kortti: yksi asia huomattavaksi, syy näkyvissä, ei kaavioita', async (t) => {
  freezeLocalDate(t, THURSDAY);
  await setupWeek();
  renderTodayDirection();
  const card = html('todayDirection');
  assert.match(card, /Viikon kapasiteettia jäljellä/);
  assert.match(card, /Tänään kannattaa huomata:/);
  assert.match(card, /Miksi tämä\?/);
  assert.match(card, /data-today-action="log_time"/);
  assert.equal(/<svg|<canvas|chart/i.test(card), false);
  assert.ok((card.match(/dir-today-observation/g) || []).length <= 3);
});

// ================================================================ AJASTINPALKKI

test('ajastinpalkki: tila tekstinä, kohde, kulunut aika ja painikkeet; piilossa ilman ajastinta', async (t) => {
  const start = freezeLocalDate(t, THURSDAY, '10:00').getTime();
  renderTimerBar(start);
  assert.equal(node('timerBar').hidden, true);
  setTasks([task('w1', THURSDAY, 60, { title: 'Raportti' })]);
  await startTracking({ kind: 'task', id: 'w1' }, { now: start });
  renderTimerBar(start + 65 * 60 * 1000);
  const bar = html('timerBar');
  assert.equal(node('timerBar').hidden, false);
  assert.match(bar, /<span class="timer-state">Käynnissä<\/span>/);
  assert.match(bar, /Raportti/);
  assert.match(bar, /1:05/);
  assert.match(bar, /Kulunut 1 h 5 min/, 'ruudunlukijalle sanoina');
  assert.match(bar, /data-timer="pause"/);
  assert.match(bar, /data-timer="stop"/);
  assert.match(bar, /aria-label="Hylkää ajastus kirjaamatta"/);
  await pauseTracking({ now: start + 70 * 60 * 1000 });
  renderTimerBar(start + 90 * 60 * 1000);
  assert.match(html('timerBar'), /Tauolla/);
  assert.match(html('timerBar'), /1:10/);
  assert.match(html('timerBar'), /data-timer="resume"/);
});

test('ajastinpalkki on saavutettava alue ja mahtuu kapeaan näyttöön', () => {
  assert.match(HTML, /<div class="timer-bar" id="timerBar" role="region" aria-label="Ajanseuranta" hidden><\/div>/);
  assert.match(CSS, /\.timer-bar \{[^}]*flex-wrap:wrap/);
  assert.match(CSS, /\.timer-actions \.assist-btn \{[^}]*min-height:44px/);
  assert.match(CSS, /\.timer-target \{[^}]*overflow-wrap:anywhere/);
  assert.match(CSS, /env\(safe-area-inset-top\)/);
});

test('kirjausdialogi: ilman <dialog>-tukea ei kirjata mitään (ei hiljaista oletusta)', async () => {
  const result = await openTimeLogDialog({ title: 'Kirjaa aikaa', target: { kind: 'none' } });
  assert.deepEqual(result, { action: 'skip' });
  assert.equal(getState().timeEntries.length, 0);
  closeTimeLogDialog();
});

test('mobiili: esikatselu ja kehitys vierivät säiliössään, dialogi mahtuu näyttöön, pikapainikkeet 44 px', () => {
  assert.match(CSS, /\.dir-preview \{[^}]*overflow-x:auto/);
  assert.match(CSS, /#dirTrends \{[^}]*overflow-x:auto/);
  assert.match(CSS, /\.time-log-dialog \{[^}]*max-width:min\(460px, calc\(100vw - 24px\)\)/);
  assert.match(CSS, /\.dir-quick \.assist-btn, \.dir-presets \.assist-btn \{[^}]*min-height:44px/);
  assert.match(CSS, /\.time-log-preset \{[^}]*min-height:48px/);
});

test('lomakkeiden uudet kentät ovat nimettyjä (label for)', () => {
  for (const id of ['afEnergy', 'afEstimateApprox', 'rfEnergy', 'prfEnergy', 'dirEnergyBudget']) {
    assert.match(HTML, new RegExp(`for="${id}"`), id);
  }
  assert.match(HTML, /id="dirEnergyBudgetError" role="alert"/);
  assert.match(HTML, /id="dirTimePresets" role="group" aria-label="Pikavalinnat"/);
  assert.match(HTML, /id="dirQuickActions" role="group" aria-label="Suunnan pikatoiminnot"/);
});

test('suunnitelman tarkistus ennen hyväksyntää: alue kategoriasta, ylitys ja tärkeän alueen vaje kerrotaan', async (t) => {
  freezeLocalDate(t, '2026-09-14');
  await setupWeek();
  const plan = normalizePlan({
    goal: { title: 'Uusi sivutoimi', category: 'tyo' },
    tasks: [{ ref: 't1', title: 'Iso työ', date: THURSDAY, durationMinutes: 900, category: 'tyo' }]
  });
  const result = validatePlanAgainstAlignment(plan);
  const texts = result.messages.map(m => m.text);
  assert.ok(texts.some(text => /Suunnitelma ylittää kapasiteetin/.test(text)), texts.join(' | '));
  assert.ok(texts.some(text => /tärkeän alueen Perhe tavoitetta/.test(text)), texts.join(' | '));
  assert.equal(result.weeks[0].addedMinutes, 900);
  const view = read('src/app/views/planning.js');
  assert.match(view, /Suunta: mahtuuko tämä elämääsi\?/);
  assert.match(view, /Tarkistus ei estä hyväksyntää/);
});

test('tavoitteen liitos kohdistuksessa: vain oman tilan avoimet tavoitteet, joilla on alue', async (t) => {
  freezeLocalDate(t, THURSDAY);
  await setupWeek();
  const area = getState().lifeAreas[0];
  setGoals([
    normalizeGoal({ id: 'g1', title: 'Lapset', lifeAreaId: area.id, status: 'active' }),
    normalizeGoal({ id: 'g2', title: 'Ilman aluetta', status: 'active' }),
    normalizeGoal({ id: 'g3', title: 'Saavutettu', lifeAreaId: area.id, status: 'completed' })
  ]);
  initDirection();
  node('dirOpenUnassigned').dispatch('click');
  const markup = html('dirUnassigned');
  assert.match(markup, /Lapset \(Perhe\)/);
  assert.equal(markup.includes('Ilman aluetta'), false);
  assert.equal(markup.includes('Saavutettu'), false);
});
