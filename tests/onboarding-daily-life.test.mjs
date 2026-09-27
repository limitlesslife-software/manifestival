// Ensikäytön opastuksen arjen kortit (src/app/onboarding.js).
//
// Enintään kaksi uutta korttia, molemmat valinnaisia ja ohitettavissa, ja ne
// kertovat vain, mistä asetukset löytyvät (Profiili → Arki / Paikat). Mitään
// ei kytketä päälle eikä lupia kysytä.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { onboardingSteps, initOnboarding, showOnboarding } from '../src/app/onboarding.js';
import { setUser, clearUser } from '../src/data/session.js';
import { getUserPreference } from '../src/data/preferences.js';
import { readCode } from './helpers/sources.mjs';

/** Minimi-DOM opastuksen tunnisteille (sama malli kuin voice-android-ui.test.mjs). */
function installDom() {
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) {
      const listeners = new Map();
      const attributes = new Map();
      nodes.set(id, {
        id, textContent: '', innerHTML: '', style: {}, inert: false,
        classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        setAttribute(name, value) { attributes.set(name, String(value)); },
        getAttribute(name) { return attributes.has(name) ? attributes.get(name) : null; },
        removeAttribute(name) { attributes.delete(name); },
        addEventListener(type, fn) { listeners.set(type, fn); },
        dispatch(type, extra = {}) { const fn = listeners.get(type); if (fn) fn({ key: '', preventDefault() {}, ...extra }); },
        focus() { globalThis.document.activeElement = this; }
      });
    }
    return nodes.get(id);
  };
  globalThis.document = { getElementById: node, activeElement: null, body: {}, querySelector: () => null };
  const data = new Map();
  globalThis.localStorage = {
    getItem: key => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => { data.set(key, String(value)); },
    removeItem: key => { data.delete(key); },
    key: index => [...data.keys()][index] ?? null,
    get length() { return data.size; }
  };
  return node;
}

const USER = { id: 'aaaaaaaa-1111-4000-8000-000000000001', email: 'o@example.com' };

beforeEach(() => {
  clearUser();
  setUser(USER);
});

afterEach(() => {
  delete globalThis.document;
  delete globalThis.localStorage;
  clearUser();
});

test('enintään kaksi uutta korttia, valinnaisia ja Profiilin osioihin viittaavia', () => {
  const steps = onboardingSteps();
  assert.equal(steps.length, 5, 'kolme alkuperäistä + kaksi arjen korttia');
  const optional = steps.filter(step => step.optional === true);
  assert.equal(optional.length, 2);
  assert.match(optional[0].body, /Profiili → Arki/);
  assert.match(optional[1].body, /Profiili → Paikat/);
  for (const step of optional) {
    assert.match(step.body, /^Valinnainen:/, 'valinnaisuus kerrotaan tekstissä, ei vain värillä');
    assert.equal(/provider|schema|percentile|gate/i.test(step.body), false, 'ei teknistä sanastoa');
  }
  assert.match(optional[1].body, /ei arvata/, 'lähtöaikaa ei arvata ilman omaa arviota');
});

test('kortit kulkevat Seuraava-painikkeella loppuun ja Aloita merkitsee opastuksen nähdyksi', () => {
  const $ = installDom();
  initOnboarding();
  showOnboarding();
  const titles = [$('onboardingTitle').textContent];
  for (let index = 0; index < onboardingSteps().length - 1; index += 1) {
    $('onboardingNext').dispatch('click');
    titles.push($('onboardingTitle').textContent);
  }
  assert.deepEqual(titles, onboardingSteps().map(step => step.title));
  assert.equal($('onboardingNext').textContent, 'Aloita');
  assert.match($('onboardingCard').getAttribute('aria-label'), /Vaihe 5 \/ 5/);
  $('onboardingNext').dispatch('click');
  assert.equal(getUserPreference(USER.id, 'onboardingCompleted'), true);
});

test('ohitus on mahdollinen myös arjen korteilla', () => {
  const $ = installDom();
  initOnboarding();
  showOnboarding();
  $('onboardingNext').dispatch('click');
  $('onboardingNext').dispatch('click');
  $('onboardingNext').dispatch('click');
  assert.match($('onboardingBody').textContent, /Profiili → Arki/);
  $('onboardingSkip').dispatch('click');
  assert.equal(getUserPreference(USER.id, 'onboardingCompleted'), true);
});

test('opastus ei kysy lupia eikä kytke arjen toimintoja päälle', () => {
  const code = readCode('src/app/onboarding.js');
  assert.equal(/requestPermission|saveLifeSettings|enableNotifications|alarms\./.test(code), false);
});
