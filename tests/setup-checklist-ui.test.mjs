// Profiili → Aloitusasetukset (paketti §75 FIRST-USE PERSONAL SETUP).
//
// MITÄ TÄMÄ VARTIOI
//
// - Tila tulee TIEDOISTA: kohta on valmis, kun sen tieto on olemassa, ei
//   siksi että listaa napautettiin. Oletukset näkyvät oletuksina.
// - Ydin on yksi (unitavoite ja arkiherätys); muut sanovat olevansa valinnaisia.
// - Napautus vie oikealle välilehdelle ja Profiilin osioon.
// - Piilotus on käyttäjäkohtainen: toinen käyttäjä samalla laitteella näkee listan.
// - Opastusikkuna ei kasva kysymysmuuriksi (kortit vain kertovat).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDocument, installDocument, accessibleName } from './helpers/a11yDom.mjs';
import { readCode } from './helpers/sources.mjs';
import { setUser, clearUser } from '../src/data/session.js';
import {
  resetState, getState, setProfile, setLifeSettings, setSavedPlaces, setHabitPlans, setLifeAreas
} from '../src/app/state.js';
import {
  setupChecklistModel, renderSetupChecklist, initSetupChecklist, openSetupItem
} from '../src/app/views/setupChecklist.js';
import { onboardingSteps } from '../src/app/onboarding.js';

const USER_A = { id: 'dddddddd-1111-4111-8111-0000000000da', email: 'a@example.invalid' };
const USER_B = { id: 'dddddddd-1111-4111-8111-0000000000db', email: 'b@example.invalid' };

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

test('malli: tyhjä tili -> ydin puuttuu, oletukset oletuksina, valinnaiset valinnaisina', () => {
  resetState();
  const model = setupChecklistModel(getState());
  assert.equal(model.coreDone, false);
  assert.equal(model.doneCount, 0);
  const note = key => model.items.find(item => item.key === key).note;
  assert.equal(note('sleep'), 'tarvitaan herätykseen ja uneen');
  assert.equal(note('buffer'), 'oletus käytössä', 'oletus ei ole "kerrottu"');
  assert.equal(note('nicotine'), 'valinnainen');
  assert.equal(model.items.filter(item => item.core).length, 1, 'vain yksi pakollinen ydin');
});

test('malli: tila tulee tiedoista (profiili, arjen asetukset, paikat, rutiini, nikotiini, alueet)', () => {
  resetState();
  setProfile({ sleepTargetHours: 7.5, defaultWakeTime: '06:30' }, true);
  setLifeSettings([{ id: 's1', morningRoutine: [{ id: 'r1', name: 'Suihku', minutes: 10 }], speechEnabled: true }]);
  setSavedPlaces([{ id: 'p1', name: 'Työ' }]);
  setHabitPlans([{ id: 'h1', kind: 'nicotine', name: 'Nuuska', minIntervalMinutes: 90, active: true }]);
  setLifeAreas([{ id: 'a1', name: 'Terveys' }]);
  const model = setupChecklistModel(getState());
  const done = Object.fromEntries(model.items.map(item => [item.key, item.done]));
  assert.deepEqual(done, {
    sleep: true, lifeAreas: true, capacity: false, weekend: true, buffer: true, places: true,
    routine: true, style: true, voice: true, meals: false, nicotine: true
  });
  assert.equal(model.coreDone, true);
});

test('näkymä: napit ja nimet; napautus vie oikeaan osioon; piilotus on käyttäjäkohtainen', async t => {
  installStorage();
  resetState();
  const doc = createDocument('<main><div id="profileSetupChecklist"></div><button id="segmentProfileDaily">Arki</button></main>');
  const uninstall = installDocument(doc);
  t.after(() => { uninstall(); clearUser(); delete globalThis.localStorage; resetState(); });
  setUser(USER_A);
  const container = doc.getElementById('profileSetupChecklist');
  initSetupChecklist(container);
  renderSetupChecklist(container);

  const places = container.querySelector('[data-setup-open="places"]');
  assert.match(accessibleName(places), /^Koti, työ ja muut paikat: valinnainen\. Avaa$/);
  places.click();
  assert.equal(getState().screen, 'screen-profile');
  assert.equal(getState().profileSegment, 'places');
  assert.equal(openSetupItem('lifeAreas'), true);
  assert.equal(getState().screen, 'screen-direction');
  assert.equal(openSetupItem('tuntematon'), false);

  container.querySelector('[data-setup-hide]').click();
  assert.equal(container.querySelector('.setup-checklist'), null, 'piilotettu A:lle');
  setUser(USER_B);
  renderSetupChecklist(container);
  assert.ok(container.querySelector('.setup-checklist'), 'B näkee oman listansa');
});

test('opastusikkuna pysyy kevyenä ja osoittaa listaan; lista kytketty Profiiliin', () => {
  const optional = onboardingSteps().filter(step => step.optional);
  assert.ok(optional.some(step => /Aloitusasetukset/.test(step.body)));
  assert.equal(/<input|<select/.test(readCode('src/app/onboarding.js')), false, 'ei kysymysmuuria ikkunaan');
  const main = readCode('src/app/main.js');
  assert.match(main, /renderSetupChecklist\(\)/);
  assert.match(main, /initSetupChecklist\(\)/);
});
