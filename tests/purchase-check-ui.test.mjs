// Talous → Säästötavoitteet: "Ostos omana aikana" (src/app/views/purchaseCheck.js).
//
// MITÄ TÄMÄ VARTIOI
//
// - Hinta näkyy työaikana vain käyttäjän OMALLA tunnin arvolla; ilman sitä
//   työaikaa ei keksitä (ei oletuspalkkaa).
// - Suhde omiin säästötavoitteisiin; eri valuutta ei ole vertailukelpoinen.
// - Laskuri kuvaa eikä arvota: ei sanoja "tuhlaus", "liikaa", "kannattaako".
// - Vain tunnin arvo tallentuu; hintaa ei tallenneta eikä lokiteta.
// - Hinnan näppäily piirtää vain tuloksen: fokus pysyy kentässä.
// - Uloskirjautuminen tyhjentää luonnoksen.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDocument, installDocument, type, assertSameNode } from './helpers/a11yDom.mjs';
import { readCode } from './helpers/sources.mjs';
import { setUser, clearUser } from '../src/data/session.js';
import { clearAllCollections } from '../src/data/collectionsRepo.js';
import { resetState, getState, subscribe, setSavingsGoals, currentLifeSettings } from '../src/app/state.js';
import { resetDailyLifeActions, saveLifeSettings } from '../src/app/dailyLifeActions.js';
import {
  renderPurchaseCheck, initPurchaseCheck, resetPurchaseCheck, purchaseCheckModel, parseHourlyValue
} from '../src/app/views/purchaseCheck.js';

const USER = { id: 'cccccccc-1111-4111-8111-0000000000cc', email: 'ostos@example.invalid' };

const flush = async (rounds = 12) => {
  for (let i = 0; i < rounds; i += 1) await new Promise(resolve => setImmediate(resolve));
};

function mount(t) {
  clearUser();
  clearAllCollections();
  resetState();
  resetDailyLifeActions();
  resetPurchaseCheck();
  const doc = createDocument('<main><section id="host" aria-label="Säästötavoitteet"></section></main>');
  const uninstall = installDocument(doc);
  setUser(USER);
  const container = doc.getElementById('host');
  initPurchaseCheck(container);
  const unsubscribe = subscribe(() => renderPurchaseCheck(container));
  renderPurchaseCheck(container);
  t.after(() => {
    unsubscribe();
    resetPurchaseCheck();
    uninstall();
    clearUser();
  });
  return { doc, container, byId: id => doc.getElementById(id), text: () => container.textContent.replace(/\s+/g, ' ') };
}

const GOALS = [
  { id: 'g1', name: 'Kesäloma', targetMinor: 200000, currentMinor: 50000, currency: 'EUR' },
  { id: 'g2', name: 'Dollarit', targetMinor: 100000, currentMinor: 0, currency: 'USD' }
];

test('malli: ilman omaa tunnin arvoa ei työaikaa; säästövertailu omista tavoitteista', () => {
  resetState();
  setSavingsGoals(GOALS);
  const model = purchaseCheckModel({ priceText: '150,00', state: getState() });
  assert.equal(model.priceMinor, 15000);
  assert.equal(model.work, null, 'ei oletuspalkkaa');
  assert.deepEqual(model.comparisons.map(row => [row.name, row.text]), [
    ['Dollarit', 'Eri valuutta: vertailua ei tehdä.'],
    ['Kesäloma', 'Vastaa 10 % tavoitteen jäljellä olevasta summasta.']
  ]);
  assert.equal(purchaseCheckModel({ priceText: 'paljon', state: getState() }).priceInvalid, true);
  assert.equal(purchaseCheckModel({ priceText: '0', state: getState() }).priceInvalid, true, 'nolla ei ole hinta');
  assert.equal(purchaseCheckModel({ priceText: '', state: getState() }).priceInvalid, false);
});

test('tunnin arvo: tyhjä poistaa, pilkku ja piste käyvät, nolla ja teksti ovat virhe', () => {
  assert.deepEqual(parseHourlyValue(''), { value: null });
  assert.deepEqual(parseHourlyValue('25,50'), { value: 2550 });
  assert.deepEqual(parseHourlyValue('25.5'), { value: 2550 });
  assert.ok(parseHourlyValue('0').error);
  assert.ok(parseHourlyValue('kaksikymmentä').error);
});

test('näkymä: hinta -> työaika omalla tunnin arvolla ja tavoitteet; fokus pysyy hintakentässä', async t => {
  const view = mount(t);
  setSavingsGoals(GOALS);
  await saveLifeSettings({ hourlyValueMinor: 2000 });
  const price = view.byId('pcPrice');
  price.focus();
  type(price, '50');
  assert.match(view.text(), /Vastaa noin 2 h 30 min työtä oman tuntiarvosi mukaan\./);
  assert.match(view.text(), /Kesäloma: Vastaa 3 % tavoitteen jäljellä olevasta summasta\./);
  assertSameNode(view.doc.activeElement, view.byId('pcPrice'), 'näppäily ei piirrä kenttää uudelleen');
  // Kuvaa, ei arvota.
  assert.doesNotMatch(view.text(), /tuhla|liikaa|kannattaa|kallis/i);

  type(view.byId('pcPrice'), 'abc');
  assert.equal(view.byId('pcPriceError').getAttribute('role'), 'alert');
  assert.equal(view.byId('pcPrice').getAttribute('aria-invalid'), 'true');
});

test('tunnin arvon tallennus arjen asetuksiin; virhe kentän alla; tyhjä poistaa', async t => {
  const view = mount(t);
  type(view.byId('pcHourly'), '0');
  view.byId('pcHourlySave').click();
  await flush();
  assert.match(view.byId('pcHourlyError').textContent, /Anna tunnin arvo/);
  assert.equal(currentLifeSettings(getState()).hourlyValueMinor ?? null, null);

  type(view.byId('pcHourly'), '32,40');
  view.byId('pcHourlySave').click();
  await flush();
  assert.equal(currentLifeSettings(getState()).hourlyValueMinor, 3240);
  assert.match(view.text(), /Tunnin arvo tallennettu\./);
  assert.equal(view.byId('pcHourly').value, '32,40');

  type(view.byId('pcHourly'), '');
  view.byId('pcHourlySave').click();
  await flush();
  assert.equal(currentLifeSettings(getState()).hourlyValueMinor ?? null, null);
});

test('uloskirjautuminen tyhjentää hinnan ja luonnoksen; hintaa ei tallenneta eikä lokiteta', async t => {
  const view = mount(t);
  type(view.byId('pcPrice'), '499');
  resetPurchaseCheck();
  renderPurchaseCheck(view.container);
  assert.equal(view.byId('pcPrice').value, '');
  const code = readCode('src/app/views/purchaseCheck.js');
  assert.equal(/logEvent|logFailure|console\./.test(code), false, 'hinta ei päädy lokiin');
  assert.equal(/Repo\.|insert\(|update\(/.test(code), false, 'hintaa ei tallenneta');
  const main = readCode('src/app/main.js');
  assert.match(main, /resetPurchaseCheck\(\)/);
  assert.match(main, /initPurchaseCheck\(\)/);
});
