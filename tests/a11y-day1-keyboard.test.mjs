// Saavutettavuus Day 1: koko ensimmäisen päivän kulku PELKÄLLÄ NÄPPÄIMISTÖLLÄ
// jäsennetyssä index.html-DOMissa (tests/helpers/a11yDom.mjs).
//
// Kulku: Tänään-kortin "Aloita Suunta" -> aloituksen seitsemän vaihetta
// (alueet, tärkeys, tavoitteet, kapasiteetti, vanhan tavoitteen liitos,
// arviojono, ajastin ja kirjausdialogi) -> ajastinpalkki (Tauko/Jatka) ->
// koko Suunta: viikkokatsaus, aluelomakkeen virhe ja Esc. Joka vaiheessa
// tarkistetaan, että
//   - jokainen näkyvä ohjain on sarkaimella saavutettavissa (ei
//     tabindex="-1" -ohjaimia, ei positiivista tabindexiä, ei klikattavia
//     ei-painikkeita) ja sillä on saavutettava nimi,
//   - fokus ei putoa <body>:yyn uudelleenpiirrossa,
//   - tila ei ole vain värinä: vakavuus, ajastimen tila ja palkit sanoin.
// Lopuksi puhepaneelin jokainen tila tarkistetaan samoin.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { freezeLocalDate } from './helpers/clock.mjs';
import {
  press, type, choose, tabOrder, isRendered, accessibleName, assertSameNode, describeNode
} from './helpers/a11yDom.mjs';
import { mountSuunta, flush, CSS_HIDDEN } from './helpers/a11ySuunta.mjs';
import { getState, setTasks } from '../src/app/state.js';
import { createGoal } from '../src/app/actions.js';
import { currentTimer } from '../src/app/timeTracking.js';
import { SEVERITY_LABELS } from '../src/domain/alignment.js';
import { ESTIMATE_REARM_MS } from '../src/app/views/direction.js';
import { normalizeTask } from '../src/domain/task.js';

const THURSDAY = '2026-09-17';
const SEVERITY_WORDS = Object.values(SEVERITY_LABELS);

/** Klikkauksella toimivat data-attribuutit: kohteen on oltava painike. */
const CLICK_ACTIONS = ['setup', 'setup-draft', 'queue-estimate', 'queue-skip', 'queue-custom', 'queue-undo',
  'queue-finish', 'queue-overdue', 'timer', 'area-suggest', 'area-edit', 'time-delete', 'time-show-all', 'adjust',
  'quality-action', 'today-action', 'open-setup', 'open-direction', 'explain', 'energy-rate', 'assign-optout',
  'assign-skip', 'show-trends', 'preset-minutes', 'time-failed', 'log-minutes'];
/** Muutoksella toimivat: kohteen on oltava lomakekenttä. */
const CHANGE_ACTIONS = ['goal-area', 'assign-goal', 'assign-category', 'time-area', 'setup-goal', 'setup-timer-area',
  'adjust-select', 'setup-importance', 'setup-target', 'setup-category', 'queue-approx', 'adjust-value', 'queue-input'];
const INTERACTIVE = 'button, input, select, textarea, summary, a[href]';

let app = null;
afterEach(async () => {
  if (app) await app.unmount();
  app = null;
});

function harness() {
  app = mountSuunta();
  const { doc } = app;
  const root = doc.getElementById('app');
  const options = { root, hiddenBy: CSS_HIDDEN };
  const order = () => tabOrder(doc, options);
  const key = (name, extra = {}) => press(doc, name, { ...options, ...extra });

  /** Sarkaimella eteenpäin, kunnes ehto täyttyy (kierros ympäri = ei saavutettavissa). */
  function tabTo(predicate, label) {
    const limit = order().length + 2;
    for (let i = 0; i < limit; i += 1) {
      key('Tab');
      if (doc.activeElement && predicate(doc.activeElement)) return doc.activeElement;
    }
    throw new Error(`ei saavutettavissa sarkaimella: ${label} (fokus ${describeNode(doc.activeElement)})`);
  }
  const tabToSelector = selector => tabTo(element => element.matches(selector), selector);

  /**
   * Näkyvän käyttöliittymän tarkistus: jokainen ohjain sarkainjärjestyksessä
   * ja nimetty; toiminnot ovat oikeita painikkeita ja kenttiä.
   */
  function audit(stage) {
    const problems = [];
    const tabbable = new Set(order());
    const scope = doc.modal || root;
    for (const element of scope.querySelectorAll(INTERACTIVE)) {
      if (!isRendered(element, { hiddenBy: CSS_HIDDEN }) || element.disabled) continue;
      if (element.closest('[aria-hidden="true"]')) problems.push(`aria-hidden-alueella: ${describeNode(element)}`);
      // Radioryhmä ja välilehtilista: vain yksi on sarkainjärjestyksessä,
      // muihin siirrytään nuolinäppäimillä (roving tabindex).
      const roving = element.type === 'radio' || (element.getAttribute('role') === 'tab'
        && element.closest('[role="tablist"]').querySelectorAll('[role="tab"]').some(tab => tabbable.has(tab)));
      if (!tabbable.has(element) && !roving) problems.push(`ei sarkaimella: ${describeNode(element)}`);
      if (!accessibleName(element)) problems.push(`nimetön: ${describeNode(element)}`);
      if ((Number(element.getAttribute('tabindex')) || 0) > 0) problems.push(`positiivinen tabindex: ${describeNode(element)}`);
    }
    for (const name of CLICK_ACTIONS) {
      for (const element of scope.querySelectorAll(`[data-${name}]`)) {
        if (element.localName !== 'button') problems.push(`klikattava ei-painike [data-${name}]: ${describeNode(element)}`);
      }
    }
    for (const name of CHANGE_ACTIONS) {
      for (const element of scope.querySelectorAll(`[data-${name}]`)) {
        if (!['input', 'select', 'textarea'].includes(element.localName)) problems.push(`[data-${name}] ei ole kenttä: ${describeNode(element)}`);
      }
    }
    // Ryhmät, joilla on nimi, ja radioryhmät nimettyjen fieldsetien sisällä.
    for (const group of scope.querySelectorAll('[role="group"], fieldset')) {
      if (!isRendered(group, { hiddenBy: CSS_HIDDEN })) continue;
      if (!accessibleName(group)) problems.push(`nimetön ryhmä: ${describeNode(group)}`);
    }
    assert.deepEqual(problems, [], `${stage}:\n${problems.join('\n')}`);
    return tabbable.size;
  }

  /** Ei vain väriä: vakavuus, palkit ja ajastimen tila sanoin. */
  function assertNotColourOnly(stage) {
    for (const signal of doc.querySelectorAll('.dir-signal')) {
      const word = signal.querySelector('.dir-severity');
      assert.ok(word !== null && SEVERITY_WORDS.includes(word.textContent.trim()), `${stage}: havainnon vakavuus sanana`);
    }
    for (const observation of doc.querySelectorAll('.dir-today-observation')) {
      assert.ok(SEVERITY_WORDS.some(word => observation.textContent.includes(word + ':')), `${stage}: päivän havainnon vakavuus sanana`);
    }
    for (const bar of doc.querySelectorAll('.dir-bar')) {
      assert.equal(bar.getAttribute('role'), 'img', `${stage}: palkki on kuva`);
      assert.ok((bar.getAttribute('aria-label') || '').length > 5, `${stage}: palkin luvut sanoin`);
    }
    const timerBar = doc.getElementById('timerBar');
    if (!timerBar.hidden && currentTimer()) {
      const state = timerBar.querySelector('.timer-state').textContent;
      assert.ok(['Käynnissä', 'Tauolla', 'Kirjaus kesken'].includes(state), `${stage}: ajastimen tila sanana`);
      assert.equal(timerBar.classList.contains('is-paused'), state === 'Tauolla');
    }
  }

  const focused = () => doc.activeElement;
  const notBody = stage => assert.ok(doc.activeElement && doc.activeElement !== doc.body, `${stage}: fokus putosi <body>:yyn`);
  return { doc, root, key, tabTo, tabToSelector, audit, assertNotColourOnly, focused, notBody, order };
}

test('Day 1 näppäimistöllä: aloitus, arviojono, ajastin, kirjausdialogi ja katsaus — kaikki saavutettavissa ja nimetty', async (t) => {
  freezeLocalDate(t, THURSDAY, '09:00');
  const h = harness();
  const { doc } = h;

  // Vanhan käyttäjän aineisto: avoin tavoite ja arvioimattomia tehtäviä tällä viikolla.
  const legacy = await createGoal({ title: 'Kuntoilu' });
  assert.equal(legacy.ok, true);
  setTasks([
    normalizeTask({ id: 'k1', title: 'Juoksulenkki', date: THURSDAY }),
    normalizeTask({ id: 'k2', title: 'Raportin viimeistely', date: THURSDAY })
  ]);

  // ---------------------------------------------------- Tänään-kortti
  app.show('screen-today');
  h.audit('Tänään');
  h.tabToSelector('#todayDirection [data-open-setup]');
  h.key('Enter');
  await flush();
  assert.equal(doc.getElementById('screen-direction').classList.contains('active'), true, 'Suunta aukesi');
  assertSameNode(h.focused(), doc.getElementById('dirSetupTitle'), 'fokus aloituksen otsikossa');

  // ---------------------------------------------------- 1: alueet
  h.audit('aloitus: alueet');
  for (const name of ['Työ', 'Perhe']) {
    const chip = h.tabToSelector(`[data-setup-draft="${name}"]`);
    h.key('Enter');
    assertSameNode(h.focused(), doc.querySelector(`[data-setup-draft="${name}"]`), `${name}: fokus säilyy`);
    assert.equal(h.focused().getAttribute('aria-pressed'), 'true', `${name} valittu (aria-pressed)`);
    assert.equal(chip.isConnected, false, 'kortti piirrettiin uudelleen (fokus palautettiin avaimella)');
  }
  h.tabToSelector('[data-setup="to-importance"]');
  h.key('Enter');
  assertSameNode(h.focused(), doc.getElementById('dirSetupTitle'));

  // ---------------------------------------------------- 2: tärkeys (radiot nuolinäppäimillä)
  h.audit('aloitus: tärkeys');
  const importance = { 0: 3, 1: 5 };
  for (const [index, level] of Object.entries(importance)) {
    h.tabToSelector(`[data-setup-importance="${index}"]`);
    h.key(' ');
    for (let value = 1; value < level; value += 1) h.key('ArrowDown');
    assert.equal(h.focused().dataset.focus, `imp:${index}:${level}`, 'fokus valitussa radiossa uudelleenpiirron jälkeen');
    assert.equal(h.focused().checked, true);
  }
  h.tabToSelector('[data-setup="save-areas"]');
  h.key('Enter');
  await flush();
  assert.equal(getState().lifeAreas.length, 2, 'alueet tallentuivat');
  assertSameNode(h.focused(), doc.getElementById('dirSetupTitle'));

  // ---------------------------------------------------- 3: viikkotavoitteet
  h.audit('aloitus: tavoitteet');
  const [tyo, perhe] = ['Työ', 'Perhe'].map(name => getState().lifeAreas.find(area => area.name === name));
  h.tabToSelector(`[data-setup-target="${tyo.id}"]`);
  h.key(' ');
  for (let i = 0; i < 4; i += 1) h.key('ArrowDown'); // Ei tavoitetta -> 0 -> 1 h -> 3 h -> 5 h
  assert.equal(h.focused().value, '300');
  h.tabToSelector(`[data-setup-target="${perhe.id}"]`);
  h.key(' ');
  h.key('ArrowUp'); // ympäri: Muu
  assert.equal(h.focused().value, 'custom');
  const hours = h.tabToSelector(`[data-setup-target-hours="${perhe.id}"]`);
  assert.equal(accessibleName(hours), 'Tunteja viikossa: Perhe');
  type(hours, '7,5');
  h.tabToSelector('[data-setup="save-targets"]');
  h.key('Enter');
  await flush();
  assert.equal(getState().lifeAreas.find(area => area.id === tyo.id).targetMinutesPerWeek, 300);
  assert.equal(getState().lifeAreas.find(area => area.id === perhe.id).targetMinutesPerWeek, 450);
  assertSameNode(h.focused(), doc.getElementById('dirSetupTitle'));

  // ---------------------------------------------------- 4: kapasiteetti (Enter kentässä)
  h.audit('aloitus: kapasiteetti');
  const capacity = h.tabToSelector('#dirSetupCapacity');
  type(capacity, '20');
  h.key('Enter');
  await flush();
  assert.equal(getState().weeklyCapacities[0].availableMinutes, 1200);
  assertSameNode(h.focused(), doc.getElementById('dirSetupTitle'));

  // ---------------------------------------------------- 5: vanhan tavoitteen liitos
  h.audit('aloitus: tavoitteiden liitos');
  const goalSelect = h.tabToSelector(`[data-setup-goal="${legacy.goal.id}"]`);
  assert.equal(accessibleName(goalSelect), 'Kuntoilu');
  choose(goalSelect, perhe.id);
  await flush();
  assert.equal(getState().goals[0].lifeAreaId, perhe.id);
  assert.equal(h.focused().dataset.setupGoal, legacy.goal.id, 'fokus säilyy liitoksen jälkeen');
  h.tabToSelector('[data-setup="finish-step"]');
  h.key('Enter');
  assertSameNode(h.focused(), doc.getElementById('dirSetupTitle'));

  // ---------------------------------------------------- 6: arviojono
  h.audit('aloitus: arviojono');
  h.tabToSelector('#dirSetup [data-queue-estimate][data-minutes="30"]');
  h.key('Enter');
  await flush();
  assertSameNode(h.focused(), doc.getElementById('dirQueueTitle-setup'), 'fokus seuraavan kortin otsikossa');
  assert.equal(getState().tasks.filter(x => x.durationMinutes === 30).length, 1);
  assert.match(doc.querySelector('#dirSetup [role="status"]').textContent, /Arvioitu 1\/2/);
  await new Promise(resolve => setTimeout(resolve, ESTIMATE_REARM_MS + 50));
  h.audit('aloitus: arviojonon toinen kortti');
  h.tabToSelector('#dirSetup [data-queue-skip]');
  h.key('Enter');
  await flush();
  h.notBody('arviojonon ohitus');
  assert.match(doc.getElementById('dirSetup').textContent, /Jonon asiat on käyty läpi/);
  h.tabToSelector('[data-setup="finish-step"]');
  h.key('Enter');
  assertSameNode(h.focused(), doc.getElementById('dirSetupTitle'));

  // ---------------------------------------------------- 7: ajastin ja kirjausdialogi
  h.audit('aloitus: kirjaaminen');
  const timerArea = h.tabToSelector('#dirSetupTimerArea');
  choose(timerArea, tyo.id);
  assert.equal(h.focused().id, 'dirSetupTimerArea', 'fokus säilyy valinnan jälkeen');
  h.tabToSelector('[data-setup="start-timer"]');
  h.key('Enter');
  await flush();
  assert.ok(currentTimer(), 'ajastin käynnistyi');
  // Käynnissä oleva ajastin täyttää viimeisen vaiheen: aloitus päättyy, ja
  // fokus siirtyy vahvistukseen ("Aloitus on valmis"), ei <body>:yyn.
  assert.match(doc.getElementById('dirSetup').textContent, /Aloitus on valmis/);
  assert.equal(doc.getElementById('screen-direction').classList.contains('dir-setup-active'), false);
  assertSameNode(h.focused(), doc.getElementById('dirSetupTitle'), 'fokus aloituksen vahvistuksessa');
  h.audit('ajastin käynnissä, koko Suunta');
  h.assertNotColourOnly('ajastin käynnissä');

  // Kirjausdialogi Suunnan pikatoiminnosta.
  const logButton = h.tabToSelector('#dirQuickLog');
  h.key('Enter');
  const dialog = doc.getElementById('timeLogDialog');
  assert.equal(dialog.open, true, 'kirjausdialogi auki');
  assertSameNode(h.focused(), doc.getElementById('timeLogTitle'), 'alkufokus otsikossa');
  assert.equal(accessibleName(dialog), 'Kirjaa aikaa', 'dialogilla on nimi');
  h.audit('kirjausdialogi');
  const minutes = h.tabToSelector('#timeLogMinutes');
  assert.equal(accessibleName(minutes), 'Muu (minuuttia)');
  type(minutes, '25');
  h.key('Enter'); // implisiittinen lähetys: "Kirjaa", ei 15 min pikavalinta
  await flush();
  assert.equal(dialog.open, false);
  assert.deepEqual(getState().timeEntries.map(entry => entry.minutes), [25]);
  assertSameNode(h.focused(), logButton, 'fokus palaa avaajaan');

  // Ajastinpalkki: Tauko ja Jatka pitävät fokuksen.
  const toggle = h.tabToSelector('#timerBar [data-timer="pause"]');
  h.key('Enter');
  await flush();
  assertSameNode(h.focused(), toggle, 'Tauko');
  assert.equal(accessibleName(toggle), 'Jatka');
  h.assertNotColourOnly('ajastin tauolla');
  h.key('Enter');
  await flush();
  assertSameNode(h.focused(), toggle, 'Jatka');
  assert.equal(accessibleName(toggle), 'Tauko');

  // ---------------------------------------------------- koko Suunta
  const count = h.audit('koko Suunta');
  assert.ok(count >= 40, `ohjaimia sarkainjärjestyksessä ${count}`);
  h.assertNotColourOnly('koko Suunta');

  // Viikkokatsaus.
  const answer = h.tabToSelector('#dirAnswer-most_draining');
  assert.equal(accessibleName(answer), 'Mikä kuormitti eniten?');
  type(answer, 'Raportti');
  h.tabToSelector('#dirReviewSave');
  h.key('Enter');
  await flush();
  assert.equal(doc.getElementById('dirReviewStatus').getAttribute('role'), 'status');
  assert.equal(doc.getElementById('dirReviewStatus').textContent, 'Viikkokatsaus tallennettu.');
  h.notBody('katsauksen tallennus');

  // Aluelomake: virhe tekstinä (role=alert), fokus kenttään; Esc palauttaa fokuksen.
  h.tabToSelector('#dirAddArea');
  h.key('Enter');
  assertSameNode(h.focused(), doc.getElementById('dirAreaName'));
  type(h.focused(), 'Koti');
  h.tabToSelector('#dirAreaSave');
  h.key('Enter');
  await flush();
  const error = doc.getElementById('dirAreaImportanceError');
  assert.equal(error.getAttribute('role'), 'alert');
  assert.equal(error.textContent, 'Valitse kuinka tärkeä alue on.', 'virhe sanoin, ei vain punaisena reunana');
  assertSameNode(h.focused(), doc.getElementById('dirAreaImportance'));
  h.key('Escape');
  assert.equal(doc.getElementById('dirAreaForm').style.display, 'none');
  assertSameNode(h.focused(), doc.getElementById('dirAddArea'), 'Esc: fokus palaa "Lisää elämänalue" -painikkeeseen');

  // Päivän kortti Tänään-näkymässä.
  app.show('screen-today');
  h.audit('Tänään Suunnan jälkeen');
  h.assertNotColourOnly('Tänään');
});

test('puhepaneeli: jokainen tila on nimetty ja saavutettava näppäimistöllä', async (t) => {
  freezeLocalDate(t, THURSDAY);
  const h = harness();
  const { doc } = h;
  const overlay = doc.getElementById('voiceOverlay');
  assert.equal(overlay.getAttribute('role'), 'dialog');
  assert.equal(overlay.getAttribute('aria-modal'), 'true');
  assert.equal(accessibleName(overlay), 'Puheohjaus');
  overlay.classList.add('open');
  overlay.setAttribute('aria-hidden', 'false');
  const states = overlay.querySelectorAll('.voice-state');
  assert.ok(states.length >= 5);
  for (const state of states) {
    for (const other of states) other.style.display = other === state ? 'block' : 'none';
    const controls = tabOrder(doc, { root: overlay, hiddenBy: CSS_HIDDEN });
    assert.ok(controls.length >= 1, `${state.id}: sulje-painike vähintään`);
    for (const control of controls) {
      assert.ok(accessibleName(control), `${state.id}: nimetön ${describeNode(control)}`);
    }
  }
  // Virhetila kertoo virheen sanoin ja ruudunlukijalle.
  assert.equal(doc.getElementById('voiceErrorMsg').getAttribute('role'), 'alert');
});
