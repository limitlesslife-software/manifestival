// Suunnan aloitus: pääpainike herää kirjoittaessa (vaihe 4, kapasiteetti).
//
// LÖYDÖS (E2E, vanha käyttäjä, oikea selain): "Tallenna" piirrettiin pois
// käytöstä, kun kapasiteettikenttä oli tyhjä, eikä kirjoittaminen
// piirtänyt korttia uudelleen. Kosketuskäyttäjä kirjoitti 20, napautti
// "Tallenna" -- eikä mitään tapahtunut. Aiempi testi
// (suunta-first-run.test.mjs) lähetti napautuksen suoraan käsittelijälle
// eikä huomannut, että oikea painike oli yhä `disabled`.
//
// Tynkä-DOM kuten suunta-first-run.test.mjs; lisäksi aloituksen säiliö
// palauttaa pääpainikkeen sen hetkisestä merkinnästä, jotta painikkeen
// tila voidaan lukea kuten selaimessa.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { read } from './helpers/sources.mjs';
import { freezeLocalDate } from './helpers/clock.mjs';
import { fakeClient } from './helpers/gates.mjs';
import { setUser, clearUser } from '../src/data/session.js';
import { setClient } from '../src/data/client.js';
import { resetState, getState, setDomainLoadStatus } from '../src/app/state.js';
import { clearLocalUserData } from '../src/app/actions.js';
import { createLifeArea, resetAppliedAdjustments } from '../src/app/alignment.js';
import { renderDirection, initDirection, resetDirectionView } from '../src/app/views/direction.js';

const USER = { id: 'eeeeeeee-7777-4777-8777-00000000007e', email: 'painike@example.com' };
const THURSDAY = '2026-09-17';
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
    appendChild: () => {},
    remove: () => {},
    closest: () => null
  };
}

/**
 * Aloituksen pääpainike kortin merkinnästä; sama olio kunnes merkintä vaihtuu.
 * Kortti piirretään #dirSetupCard-elementtiin #dirSetup-alueen sisällä; kuten
 * oikeassa DOM:issa alueen querySelector löytää painikkeen kortista.
 */
function withPrimaryButton(container, markup = () => container.innerHTML) {
  let parsedFrom = null;
  let button = null;
  container.querySelector = selector => {
    if (selector !== '[data-focus="primary"]') return null;
    if (parsedFrom !== markup()) {
      parsedFrom = markup();
      const match = /data-setup="([^"]+)" data-focus="primary"\s*(disabled)?\s*>([^<]*)</.exec(parsedFrom);
      button = match ? { dataset: { setup: match[1], focus: 'primary' }, disabled: Boolean(match[2]), textContent: match[3] } : null;
    }
    return button;
  };
  return container;
}

function installDom() {
  const elements = new Map();
  globalThis.document = {
    activeElement: null,
    getElementById(id) {
      if (!HTML_IDS.has(id)) return null;
      if (!elements.has(id)) {
        const element = stubElement(id);
        elements.set(id, id === 'dirSetup'
          ? withPrimaryButton(element, () => globalThis.document.getElementById('dirSetupCard').innerHTML)
          : element);
      }
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

const setup = () => globalThis.document.getElementById('dirSetup');
const card = () => globalThis.document.getElementById('dirSetupCard');
const primary = () => setup().querySelector('[data-focus="primary"]');
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };

/** Kirjoitus kenttään: tapahtuman kohde on kenttä (data-focus="capacity"). */
function typeCapacity(value) {
  const target = { dataset: { focus: 'capacity' }, value, closest: () => null };
  setup().dispatch('input', { target, preventDefault() {} });
}

/** Napautus OIKEAAN painikkeeseen: käsittelijä ohittaa pois käytöstä olevan. */
async function tapPrimary() {
  const button = primary();
  const target = { ...button, closest: selector => (selector.includes('[data-setup]') ? button : null) };
  setup().dispatch('click', { target, preventDefault() {} });
  await flush();
}

beforeEach(() => {
  clearUser();
  clearLocalUserData();
  resetState();
  resetAppliedAdjustments();
  resetDirectionView();
  installStorage();
  installDom();
  setUser(USER);
  setClient(fakeClient({ data: [], error: null }));
});

afterEach(() => {
  delete globalThis.document;
  delete globalThis.CSS;
  delete globalThis.localStorage;
});

test('vaihe 4: "Tallenna" herää ensimmäisestä merkistä ja tallentaa napautuksella; tyhjä kenttä sammuttaa sen', async (t) => {
  freezeLocalDate(t, THURSDAY);
  await createLifeArea({ name: 'Perhe', importance: 5, targetMinutesPerWeek: 300 });
  // Alueet ladattu onnistuneesti: tuntematonta latausta ei näytetä aloituksena.
  setDomainLoadStatus('lifeAreas', true);
  initDirection();
  renderDirection();
  assert.match(card().innerHTML, /Vaihe 4\/7/);
  assert.equal(primary().dataset.setup, 'save-capacity');
  assert.equal(primary().disabled, true, 'tyhjällä kentällä ei tallenneta');

  typeCapacity('2');
  assert.equal(primary().disabled, false, 'painike ei herännyt kirjoittaessa');
  typeCapacity('');
  assert.equal(primary().disabled, true, 'tyhjennetty kenttä ei saa tallentaa');
  typeCapacity('20');
  assert.equal(primary().disabled, false);
  assert.equal(primary().textContent, 'Tallenna');

  await tapPrimary();
  assert.equal(getState().weeklyCapacities.length, 1, 'napautus ei tallentanut');
  assert.equal(getState().weeklyCapacities[0].availableMinutes, 1200);
});
