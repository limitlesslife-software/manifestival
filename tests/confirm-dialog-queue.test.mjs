// Vahvistusdialogit: yksi kysymys kerrallaan ja sulkeminen uloskirjautuessa
// (audit: races RACE-16, RACE-14).
//
// Natiivia <dialog>-elementtiä ei ole Nodessa. Tynkä toimii kuten selain:
// showModal() avaa, close(arvo) asettaa returnValue:n ja laukaisee
// 'close'-tapahtuman seuraavassa tehtävässä.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { confirmAction, confirmProposal, chooseTarget, closeConfirmDialogs } from '../src/ui/confirm.js';

function node(tag = 'div') {
  const listeners = {};
  const children = new Map();
  const element = {
    tagName: tag.toUpperCase(), id: '', className: '', textContent: '', hidden: false, type: '',
    returnValue: '', open: false,
    classList: { toggle() {}, add() {}, remove() {} },
    set innerHTML(html) {
      for (const [, id] of String(html).matchAll(/id="([^"]+)"/g)) children.set('#' + id, node());
    },
    querySelector: selector => children.get(selector) || null,
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
    removeEventListener: (type, fn) => { listeners[type] = (listeners[type] || []).filter(other => other !== fn); },
    appendChild() {}, replaceChildren() {}, append() {}, setAttribute() {}, focus() {},
    showModal() { element.open = true; },
    close(value) {
      if (value !== undefined) element.returnValue = value;
      element.open = false;
      // Selain laukaisee 'close'-tapahtuman omana tehtävänään.
      Promise.resolve().then(() => { for (const fn of [...(listeners.close || [])]) fn(); });
    }
  };
  return element;
}

let registry;
beforeEach(() => {
  registry = new Map();
  globalThis.document = {
    getElementById: id => registry.get(id) || null,
    createElement: tag => node(tag),
    body: { appendChild: element => { if (element.id) registry.set(element.id, element); } }
  };
});

afterEach(() => {
  closeConfirmDialogs();
  delete globalThis.document;
});

const tick = () => new Promise(resolve => setImmediate(resolve));
const dialog = () => registry.get('confirmDialog');
const title = () => dialog().querySelector('#confirmTitle').textContent;

function answer(target, value) {
  target.returnValue = value;
  target.close();
}

test('RACE-16 KRIITTINEN: toinen kysymys odottaa — yksi napsautus ei vastaa kahteen eri kysymykseen', async () => {
  const first = confirmAction({ title: 'Poistetaanko A?', message: 'a' });
  const second = confirmAction({ title: 'Poistetaanko B?', message: 'b' });
  assert.equal(title(), 'Poistetaanko A?', 'toinen kysymys ylikirjoitti avoimen dialogin');
  let secondDone = false;
  second.then(() => { secondDone = true; });

  answer(dialog(), 'confirm');
  assert.equal(await first, true);
  await tick();
  assert.equal(secondDone, false, 'toinen kysymys sai ensimmäisen vastauksen');
  assert.equal(title(), 'Poistetaanko B?', 'toista kysymystä ei näytetty');
  assert.equal(dialog().open, true);

  answer(dialog(), 'cancel');
  assert.equal(await second, false);
});

test('RACE-14: uloskirjautuminen sulkee avoimen kysymyksen ja hylkää jonossa odottavat', async () => {
  const open = confirmAction({ title: 'Pysäytetäänkö ja kirjataanko "A:n tehtävä"?', message: '' });
  const queued = confirmAction({ title: 'Jonossa', message: '' });
  closeConfirmDialogs();
  assert.equal(await open, false, 'avoin kysymys jäi odottamaan');
  assert.equal(await queued, false, 'jonossa ollut kysymys näytettiin uloskirjautumisen jälkeen');
  assert.notEqual(title(), 'Jonossa');
  assert.equal(dialog().open, false);

  // Seuraava istunto: uusi kysymys toimii normaalisti.
  const next = confirmAction({ title: 'Uusi', message: '' });
  assert.equal(title(), 'Uusi');
  answer(dialog(), 'confirm');
  assert.equal(await next, true);
});

test('RACE-16: tarkennus ja AI-ehdotus jakavat dialogin — ehdotus odottaa tarkennuksen vastausta', async () => {
  const choice = chooseTarget([{ label: 'Hammaslääkäri', date: '2026-09-22' }, { label: 'Hammaslääkäri', date: '2026-09-29' }]);
  const proposal = confirmProposal({
    preview: { action: 'Poista tehtävä', targetLabel: 'X', description: 'x', changes: [], destructive: true }
  });
  const proposalDialog = registry.get('proposalDialog');
  assert.equal(proposalDialog.querySelector('#proposalTitle').textContent, 'Mitä näistä tarkoitit?');
  answer(proposalDialog, 'cancel');
  assert.equal(await choice, null);
  await tick();
  assert.equal(proposalDialog.querySelector('#proposalTitle').textContent, 'Poista tehtävä');
  answer(proposalDialog, 'confirm');
  assert.equal(await proposal, true);
});
