// Talouden yleiskatsaus ei saa kaataa renderöintiä.
//
// LÖYDÖS (E2E, oikea käynnistys): renderOverviewDetail viittasi
// kortin avaimeen nimellä `key`, vaikka muuttuja oli `avain`. Jokainen
// tilamuutos heitti ReferenceErrorin renderFinancessa, jolloin
// main.js:n renderAll katkesi siihen: profiili, ilmoitusasetukset ja
// ilmoituskeskus jäivät piirtämättä (aallosta F alkaen). Yksikkötestit
// eivät huomanneet, koska yksikään ei piirtänyt talousnäkymää.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { read } from './helpers/sources.mjs';
import { resetState } from '../src/app/state.js';
import { renderFinance } from '../src/app/views/finance.js';

const HTML_IDS = new Set([...read('index.html').matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));

function stubElement() {
  const attributes = {};
  return {
    innerHTML: '', textContent: '', value: '', hidden: false, disabled: false, checked: false,
    style: {}, dataset: {}, options: [], children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute: (k, v) => { attributes[k] = String(v); },
    getAttribute: k => attributes[k] ?? null,
    removeAttribute: k => { delete attributes[k]; },
    toggleAttribute() {},
    addEventListener() {},
    removeEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    appendChild() {},
    insertAdjacentHTML() {},
    remove() {},
    closest: () => null
  };
}

let elements;
beforeEach(() => {
  resetState();
  elements = new Map();
  globalThis.document = {
    activeElement: null,
    getElementById(id) {
      if (!HTML_IDS.has(id)) return null;
      if (!elements.has(id)) elements.set(id, stubElement());
      return elements.get(id);
    },
    createElement: () => stubElement(),
    querySelector: () => null,
    querySelectorAll: () => [],
    body: { appendChild() {} }
  };
});

afterEach(() => {
  delete globalThis.document;
});

test('talousnäkymä renderöityy kaatumatta; yleiskatsauksen kortit vievät oikeisiin osioihin', () => {
  assert.ok(HTML_IDS.has('overviewContainer'), 'index.html: yleiskatsauksen säiliö puuttuu');
  assert.doesNotThrow(() => renderFinance());
  const html = globalThis.document.getElementById('overviewContainer').innerHTML;
  for (const segment of ['transactions', 'budget', 'bills', 'expenses', 'savings', 'investments']) {
    assert.match(html, new RegExp(`data-goto-segment="${segment}"`), segment);
  }
});
