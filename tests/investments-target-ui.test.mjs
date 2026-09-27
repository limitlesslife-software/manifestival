// Talous → Sijoitukset: oma tavoitearvo (target_value_minor, migraatio 0009).
//
// MITÄ TÄMÄ VARTIOI
//
// - Tavoitearvo kirjataan lomakkeella ja tallentuu omistukseen; tyhjä
//   poistaa sen, lukematon syöte on virhe eikä poista vanhaa tavoitetta.
// - Rivi kertoo nykyarvon suhteen omaan tavoitteeseen (targetComparison).
// - Tuntematon arvo ei ole 0 % tavoitteesta: vertailua ei tehdä, ja se
//   sanotaan. Kursseja ei haeta mistään.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDocument, installDocument, type } from './helpers/a11yDom.mjs';
import { read } from './helpers/sources.mjs';
import { clearToasts } from '../src/ui/toast.js';
import { setUser, clearUser } from '../src/data/session.js';
import { clearAllCollections, investmentsRepo } from '../src/data/collectionsRepo.js';
import { resetState, getState, subscribe, setInvestments } from '../src/app/state.js';
import {
  renderInvestments, initInvestmentForms, openInvestmentForm, closeInvestmentForm
} from '../src/app/views/investments.js';

const USER = { id: 'eeeeeeee-6666-4666-8666-0000000000ee', email: 'salkku@example.invalid' };
const HTML = read('index.html');
const START = HTML.indexOf('<!-- ---- Sijoitukset ---- -->');
const LIST = '<div id="investmentsListContainer"></div>';
const MARKUP = HTML.slice(START, HTML.indexOf(LIST, START) + LIST.length) + '</div>';

const flush = async (rounds = 12) => {
  for (let i = 0; i < rounds; i += 1) await new Promise(resolve => setImmediate(resolve));
};

function mount(t) {
  clearUser();
  clearAllCollections();
  resetState();
  const doc = createDocument(`<main>${MARKUP}</main>`);
  const uninstall = installDocument(doc);
  setUser(USER);
  initInvestmentForms();
  const unsubscribe = subscribe(() => renderInvestments());
  renderInvestments();
  t.after(() => {
    unsubscribe();
    closeInvestmentForm();
    clearToasts();
    uninstall();
    clearUser();
    clearAllCollections();
  });
  const byId = id => doc.getElementById(id);
  return { doc, byId, list: () => byId('investmentsListContainer').textContent.replace(/\s+/g, ' ') };
}

test('lomakkeessa on tavoitearvo, jolla on nimi ja selite', () => {
  assert.match(MARKUP, /<label class="field-label" for="ifTargetValue">Tavoitearvo \(valinnainen\)<\/label>/);
  assert.match(MARKUP, /id="ifTargetValue"[^>]*aria-describedby="ifTargetValueHint"/);
  assert.match(MARKUP, /id="ifTargetValueMinorError"/);
});

test('tavoitearvo tallentuu, näkyy suhteena omaan tavoitteeseen ja kulkee kannan riviin', async t => {
  const view = mount(t);
  view.byId('addInvestmentBtn').click();
  type(view.byId('ifName'), 'Indeksirahasto');
  type(view.byId('ifCostBasis'), '2500');
  type(view.byId('ifCurrentValue'), '3000');
  type(view.byId('ifTargetValue'), '5000');
  view.byId('ifSave').click();
  await flush();

  const [holding] = getState().investments;
  assert.equal(holding.targetValueMinor, 500000);
  assert.match(view.list(), /Arvo on 60 % tavoitearvostasi 5\s000,00\s€\./);
  assert.equal(investmentsRepo.mapping.toRow(holding, USER.id).target_value_minor, 500000);

  // Muokkaus näyttää tallennetun tavoitteen, ja saavutettu tavoite sanotaan.
  openInvestmentForm(holding.id);
  assert.equal(view.byId('ifTargetValue').value, '5000.00');
  type(view.byId('ifCurrentValue'), '5200');
  view.byId('ifSave').click();
  await flush();
  assert.match(view.list(), /Arvo 5\s200,00\s€ on saavuttanut tavoitearvosi 5\s000,00\s€\./);
  assert.doesNotMatch(view.list(), /myy|osta|kannattaa/i, 'kuvaa, ei neuvo');
});

test('lukematon tavoitearvo on virhe eikä poista vanhaa; tyhjä poistaa tavoitteen', async t => {
  const view = mount(t);
  setInvestments([{ id: 'h1', name: 'Rahasto', kind: 'fund', currentValueMinor: 300000, valueSource: 'manual',
    valuedOn: '2026-09-20', currency: 'EUR', targetValueMinor: 500000 }]);
  assert.equal((await investmentsRepo.insert(getState().investments[0])).ok, true);
  openInvestmentForm('h1');
  type(view.byId('ifTargetValue'), 'paljon');
  view.byId('ifSave').click();
  await flush();
  assert.match(view.byId('ifTargetValueMinorError').textContent, /Anna tavoitearvo euroina/);
  assert.equal(view.byId('ifTargetValue').getAttribute('aria-invalid'), 'true');
  assert.equal(getState().investments[0].targetValueMinor, 500000, 'vanha tavoite säilyy');

  type(view.byId('ifTargetValue'), '');
  view.byId('ifSave').click();
  await flush();
  assert.equal(getState().investments[0].targetValueMinor, null);
  assert.doesNotMatch(view.list(), /tavoitearvo/i);
});

test('tuntematon arvo ei ole 0 % tavoitteesta: vertailua ei tehdä, ja se sanotaan', t => {
  const view = mount(t);
  setInvestments([{ id: 'h2', name: 'Osake', kind: 'stock', currentValueMinor: null, valueSource: 'unknown',
    currency: 'EUR', targetValueMinor: 100000 }]);
  assert.match(view.list(), /Tavoitearvo 1\s000,00\s€\. Arvoa ei tiedetä, joten vertailua ei tehdä\./);
  assert.doesNotMatch(view.list(), /0 % tavoitearvostasi/);
});
