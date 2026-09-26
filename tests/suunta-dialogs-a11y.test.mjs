// Suunta Day 1 — dialogit ja saavutettavuus: CRIT-04 (kirjausdialogin Enter
// ja alkufokus) ja CRIT-06 (ensikäytön opastus käyttäjäkohtainen ja modaali,
// vahvistusdialogien saavutettava nimi).

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { read, readCode } from './helpers/sources.mjs';
import { freezeLocalDate } from './helpers/clock.mjs';
import { fakeClient } from './helpers/gates.mjs';
import { setUser, clearUser } from '../src/data/session.js';
import { setClient } from '../src/data/client.js';
import { resetState, getState } from '../src/app/state.js';
import { clearLocalUserData } from '../src/app/actions.js';
import { resetAppliedAdjustments, setTimeEntryWriterForTests } from '../src/app/alignment.js';
import { setTimerRepoForTests, currentTimer, cancelTracking, startTracking } from '../src/app/timeTracking.js';
import { resetTimerStoreForTests } from '../src/data/timerStore.js';
import { resetDirectionView } from '../src/app/views/direction.js';
import { openTimeLogDialog, closeTimeLogDialog, stopAndLog } from '../src/app/views/timeLog.js';
import { initOnboarding, maybeShowOnboarding } from '../src/app/onboarding.js';
import { confirmAction, confirmProposal, closeConfirmDialogs } from '../src/ui/confirm.js';
import {
  getUserPreference, setDevicePreference, clearDevicePreferences
} from '../src/data/preferences.js';

const USER = { id: 'efefefef-9999-4999-8999-0000000000ef', email: 'dialog@example.com' };
const OTHER = { id: 'cdcdcdcd-8888-4888-8888-0000000000cd', email: 'toinen@example.com' };
const THURSDAY = '2026-09-17';
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

// ================================================================ CRIT-04

test('CRIT-04 KRIITTINEN: Enter "Muu"-kentässä kirjaa kirjoitetun arvon, ei ensimmäistä pikavalintaa', async (t) => {
  freezeLocalDate(t, THURSDAY);
  const pending = openTimeLogDialog({ title: 'Kirjaa aikaa', target: { kind: 'none' } });
  const dialog = registry.get('timeLogDialog');
  assert.equal(dialog.open, true);
  // Ensimmäinen submit on "Kirjaa" (custom): pikavalinnat ovat type="button".
  const firstSubmit = /<button type="submit"[^>]*value="([^"]+)"/.exec(dialog.innerHTML)[1];
  assert.equal(firstSubmit, 'custom');
  assert.doesNotMatch(dialog.innerHTML, /type="submit"[^>]*time-log-preset/);
  dialog.querySelector('#timeLogMinutes').value = '25';
  dialog.implicitSubmit();
  const result = await pending;
  assert.equal(result.action, 'logged');
  assert.deepEqual(getState().timeEntries.map(e => e.minutes), [25]);
});

test('CRIT-04: pikavalinta kirjaa napautuksesta; alkufokus on otsikossa, ei datan luovassa painikkeessa', async (t) => {
  freezeLocalDate(t, THURSDAY);
  const pending = openTimeLogDialog({ title: 'Kirjaa aikaa', target: { kind: 'none' } });
  const dialog = registry.get('timeLogDialog');
  assert.equal(globalThis.document.activeElement, dialog.querySelector('#timeLogTitle'));
  assert.match(dialog.innerHTML, /<h2 class="confirm-title" id="timeLogTitle" tabindex="-1">Kirjaa aikaa<\/h2>/);
  assert.match(dialog.innerHTML, /<input type="number" id="timeLogMinutes" min="1" max="1440" step="1" inputmode="numeric" required>/);
  const presets = dialog.presets();
  assert.deepEqual(presets.map(p => p.value), ['m:15', 'm:30', 'm:60']);
  presets[1].dispatch('click');
  const result = await pending;
  assert.equal(result.action, 'logged');
  assert.deepEqual(getState().timeEntries.map(e => e.minutes), [30]);
});

/** Unohtunut ajastin: pysäytys avaa keston tarkistuksen. */
async function openForgottenTimerReview() {
  await startTracking({ kind: 'none' }, { now: Date.now() - 14 * 60 * 60 * 1000 });
  const stopping = stopAndLog();
  await flush();
  const dialog = registry.get('timeLogDialog');
  assert.equal(dialog.open, true, 'pitkä ajastus tarkistetaan ennen kirjausta');
  return { stopping, dialog };
}

test('CRIT-04 KRIITTINEN: ajastimen tarkistuksessa Enter esitäytetyssä kentässä kirjaa, ei peru', async () => {
  const { stopping, dialog } = await openForgottenTimerReview();
  // Ensimmäinen (ja ainoa) submit on "Kirjaa"; "Takaisin" on tavallinen painike.
  assert.equal(/<button type="submit"[^>]*value="([^"]+)"/.exec(dialog.innerHTML)[1], 'confirm');
  assert.match(dialog.innerHTML, /<button type="button" class="form-btn secondary" id="timeLogReviewBack">Takaisin<\/button>/);
  assert.match(dialog.innerHTML, /<input type="number" id="timeLogReviewMinutes" min="1" step="1" required value="\d+">/);
  const prefilled = /id="timeLogReviewMinutes"[^>]*value="(\d+)"/.exec(dialog.innerHTML)[1];
  dialog.querySelector('#timeLogReviewMinutes').value = prefilled;
  dialog.implicitSubmit();
  const result = await stopping;
  assert.equal(result.ok, true);
  assert.equal(getState().timeEntries.reduce((sum, entry) => sum + entry.minutes, 0), Number(prefilled));
  assert.equal(currentTimer(), null);
});

test('CRIT-04: ajastimen tarkistuksen "Takaisin" peruu — mitään ei kirjata ja ajastin jatkuu', async () => {
  const { stopping, dialog } = await openForgottenTimerReview();
  dialog.querySelector('#timeLogReviewBack').dispatch('click');
  const result = await stopping;
  assert.equal(result.cancelled, true);
  assert.equal(getState().timeEntries.length, 0);
  assert.ok(currentTimer(), 'ajastin odottaa yhä');
});

// ================================================================ CRIT-06

function installOnboardingDom() {
  const tab = stubElement('tab');
  globalThis.document.querySelector = selector => (selector === '.tab-btn[aria-selected="true"]' ? tab : null);
  return tab;
}

test('CRIT-06 KRIITTINEN: opastus on käyttäjäkohtainen ja säilyy uloskirjautumisen yli; toinen käyttäjä näkee omansa', () => {
  installOnboardingDom();
  initOnboarding();
  assert.equal(maybeShowOnboarding(), true);
  node('onboardingSkip').dispatch('click');
  assert.equal(getUserPreference(USER.id, 'onboardingCompleted'), true);
  clearDevicePreferences(); // uloskirjautuminen
  assert.equal(maybeShowOnboarding(), false, 'ei uudelleen uloskirjautumisen jälkeen');
  setUser(OTHER);
  assert.equal(maybeShowOnboarding(), true, 'toinen käyttäjä näkee oman opastuksensa');
  node('onboardingSkip').dispatch('click');
});

test('CRIT-06: vanha laitekohtainen merkintä siirtyy käyttäjälle eikä opastusta näytetä', () => {
  installOnboardingDom();
  setDevicePreference('onboardingCompleted', true);
  assert.equal(maybeShowOnboarding(), false);
  assert.equal(getUserPreference(USER.id, 'onboardingCompleted'), true);
});

test('CRIT-06: opastuksen ajan sovellus on inert, sarkain kiertää opastuksessa ja fokus palaa', () => {
  installOnboardingDom();
  initOnboarding();
  const opener = stubElement('opener');
  opener.focus();
  maybeShowOnboarding();
  const app = node('app');
  assert.equal(app.inert, true);
  assert.equal(app.getAttribute('aria-hidden'), 'true');
  assert.equal(node('onboarding').getAttribute('aria-hidden'), 'false');
  assert.equal(globalThis.document.activeElement, node('onboardingNext'));
  // Sarkain viimeisestä palaa ensimmäiseen, vaihto+sarkain ensimmäisestä viimeiseen.
  let prevented = false;
  node('onboarding').dispatch('keydown', { key: 'Tab', shiftKey: false, preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(globalThis.document.activeElement, node('onboardingSkip'));
  node('onboarding').dispatch('keydown', { key: 'Tab', shiftKey: true, preventDefault() {} });
  assert.equal(globalThis.document.activeElement, node('onboardingNext'));
  node('onboarding').dispatch('keydown', { key: 'Escape' });
  assert.equal(app.inert, false);
  assert.equal(app.getAttribute('aria-hidden'), null);
  assert.equal(globalThis.document.activeElement, opener, 'fokus palaa avaajaan');
});

test('CRIT-06: kirjautumislomakkeesta avattu opastus palauttaa fokuksen avoimeen välilehteen', () => {
  const tab = installOnboardingDom();
  initOnboarding();
  const authButton = stubElement('authSubmit');
  authButton.closest = selector => (selector.includes('#authGate') ? {} : null);
  authButton.focus();
  maybeShowOnboarding();
  node('onboardingSkip').dispatch('click');
  assert.equal(globalThis.document.activeElement, tab);
});

test('CRIT-06: vahvistus- ja ehdotusdialogeilla on saavutettava nimi ja kuvaus', () => {
  confirmAction({ title: 'Poistetaanko?', message: 'Tätä ei voi perua.' });
  const confirm = registry.get('confirmDialog');
  assert.equal(confirm.attributes['aria-labelledby'], 'confirmTitle');
  assert.equal(confirm.attributes['aria-describedby'], 'confirmMessage');
  confirmProposal({ preview: { action: 'Poista tehtävä', targetLabel: 'X', description: 'x', changes: [], destructive: false } });
  const proposal = registry.get('proposalDialog');
  assert.equal(proposal.attributes['aria-labelledby'], 'proposalTitle');
  assert.match(proposal.attributes['aria-describedby'], /proposalTarget/);
  assert.match(proposal.attributes['aria-describedby'], /proposalChanges/);
  const source = readCode('src/ui/confirm.js');
  assert.match(source, /setAttribute\('aria-labelledby', 'confirmTitle'\)/);
});
