// Brain dump (aalto L): monirivinen kirjaus saapuviin ilman päätöksiä,
// erä-käsittely Saapuvissa, puhe ja komentopalkki "Tallenna saapuviin".
//
// Lukittu tuotesääntö: kirjaus ei vaadi päätöksiä, luokittelu tapahtuu
// VASTA kirjauksen jälkeen, ja mitään ei luoda ilman käyttäjän napautusta.
// "Kaikki muu on tallessa."
//
// PORTTITIETOISUUS (tests/helpers/gates.mjs, gateAwareStore.mjs):
// saapuvat (inboxItems) ja menot (calendarEvents) kirjoittavat muistiin
// kiinni olevalla portilla ja muistinvaraiselle palvelimelle auki olevalla.
// Päivätön tallennus (MENTAL_LOAD_FIELDS, migraatio 0015) on
// käännösaikainen: testit väittävät sen tilan mukaan, joka haarassa on
// (datelessTasksAllowed()). Kumpikin tila todistetaan puhtaana funktiona
// tiedostossa triage.test.mjs.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { read, readCode } from './helpers/sources.mjs';
import { freezeLocalDate } from './helpers/clock.mjs';
import { testStore, storedRows, storedRow } from './helpers/gateAwareStore.mjs';
import { setUser, clearUser } from '../src/data/session.js';
import { setClient } from '../src/data/client.js';
import { datelessTasksAllowed } from '../src/data/schema.js';
import { clearAllCollections, inboxRepo } from '../src/data/collectionsRepo.js';
import {
  resetState, getState, setInboxItems, setLifeAreas, setPendingCapture
} from '../src/app/state.js';
import { clearLocalUserData } from '../src/app/actions.js';
import {
  captureBrainDump, captureDumpMessage, triageInboxItems, triageProposalOf
} from '../src/app/capture.js';
import { saveCommandToInbox, canOfferInbox } from '../src/app/commandBar.js';
import { INBOX_STATUS, CAPTURE_SOURCE, MAX_OPEN_ITEMS, normalizeInboxItem } from '../src/domain/inbox.js';
import { TRIAGE_DECISION, TRIAGE_KEEP_REASON, DATELESS_GATE_HINT } from '../src/domain/triage.js';
import { TASK_HORIZON } from '../src/domain/task.js';
import { routeUtterance, ROUTE } from '../src/domain/utteranceRoute.js';
import { VOICE, VOICE_EVENT, nextVoiceState } from '../src/domain/voiceFlow.js';
import { normalizeLifeArea } from '../src/domain/lifeArea.js';

const USER = { id: 'aaaaaaaa-5555-4555-8555-00000000000b', email: 'bd@example.com' };
const TODAY = '2026-09-30'; // keskiviikko
const DATELESS = datelessTasksAllowed();

beforeEach(() => {
  clearUser();
  clearLocalUserData();
  clearAllCollections();
  resetState();
  setUser(USER);
  // Tehtävät kulkevat aina asiakkaan kautta; saapuvat ja menot porttitilan
  // mukaan (kiinni: muisti, auki: sama palvelin).
  testStore.reset();
  setClient(testStore);
});

const openInbox = () => getState().inboxItems.filter(item =>
  [INBOX_STATUS.UNPROCESSED, INBOX_STATUS.PROPOSED, INBOX_STATUS.NEEDS_REVIEW, INBOX_STATUS.ACCEPTED].includes(item.status));
const inboxByText = text => getState().inboxItems.find(item => item.text === text);

async function dump(text, options) {
  const result = await captureBrainDump(text, options);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  return result;
}

// =====================================================================
// KIRJAUS: MONTA RIVIÄ, EI PÄÄTÖKSIÄ
// =====================================================================

test('monirivinen liitos -> yksi saapuva rivi per asia, luettelomerkit ja puolipisteet huomioiden', async () => {
  const result = await dump('- osta maito\n* soita Annalle\n\n3. pyykit; imuroi\n   \n');
  assert.deepEqual(result.items.map(item => item.text), ['osta maito', 'soita Annalle', 'pyykit', 'imuroi']);
  assert.equal(getState().inboxItems.length, 4);
  for (const item of getState().inboxItems) {
    assert.equal(item.status, INBOX_STATUS.UNPROCESSED);
    assert.equal(item.source, CAPTURE_SOURCE.TEXT);
    assert.equal(item.proposal, null, 'kirjaushetkellä ei tulkintaa');
  }
  assert.equal((await storedRows(inboxRepo)).length, 4, 'jokainen rivi tallentui');
  assert.equal(captureDumpMessage(result), 'Kirjattu 4 asiaa saapuviin. Järjestä ne, kun ehdit.');
});

test('KRIITTINEN: kirjaus ei luo yhtäkään tehtävää, menoa eikä avaa tarkistusta', async () => {
  await dump('Hammaslääkäri perjantaina klo 14\nmaksa sähkölasku huomenna\nodotan Mikan vastausta');
  assert.equal(getState().tasks.length, 0);
  assert.equal(getState().calendarEvents.length, 0);
  assert.equal(getState().pendingCapture, null);
});

test('kaksoiskappaleet: saman liitoksen sisällä ja jo avoimen rivin kanssa', async () => {
  const first = await dump('Osta maito\nosta maito\nOSTA MAITO\nleipä');
  assert.equal(first.items.length, 2);
  const again = await captureBrainDump('osta maito\nleipä\nvoi');
  assert.equal(again.ok, true);
  assert.equal(again.duplicates, 2);
  assert.deepEqual(again.items.map(item => item.text), ['voi']);
  assert.equal(getState().inboxItems.length, 3);
  assert.match(captureDumpMessage(again), /2 asiaa oli jo tallessa Saapuvissa\./);

  const onlyKnown = await captureBrainDump('leipä');
  assert.equal(onlyKnown.ok, true);
  assert.equal(onlyKnown.items.length, 0);
  assert.equal(captureDumpMessage(onlyKnown), 'Yksi asia oli jo tallessa Saapuvissa.');
});

test('katto (MAX_OPEN_ITEMS): mahtuvat tallentuvat, loput palaavat kenttään', async () => {
  setInboxItems(Array.from({ length: MAX_OPEN_ITEMS - 2 }, (_, i) => normalizeInboxItem({
    id: `old-${i}`, text: `vanha ${i}`, status: INBOX_STATUS.UNPROCESSED, capturedAt: '2026-09-01T08:00:00.000Z'
  })));
  const result = await captureBrainDump('yksi\nkaksi\nkolme\nneljä');
  assert.equal(result.ok, true);
  assert.equal(result.items.length, 2);
  assert.equal(result.skipped, 2);
  assert.deepEqual(result.rest, ['kolme', 'neljä']);
  assert.match(captureDumpMessage(result), /Saapuvat tuli täyteen/);

  const full = await captureBrainDump('viisi');
  assert.equal(full.ok, false);
  assert.match(full.errors.text, /Saapuvat on täynnä/);
  assert.deepEqual(full.rest, ['viisi'], 'tallentumaton teksti ei katoa');
});

test('tyhjä kirjaus ei tee mitään', async () => {
  const result = await captureBrainDump('  \n - \n');
  assert.equal(result.ok, false);
  assert.equal(getState().inboxItems.length, 0);
});

// =====================================================================
// EHDOTUS SAAPUVALLE RIVILLE
// =====================================================================

test('ehdotettu alue ja luonne tulevat rivin tekstistä ja käyttäjän alueista', async t => {
  freezeLocalDate(t, TODAY);
  setLifeAreas([
    normalizeLifeArea({ id: 'koti', name: 'Koti', categoryKey: 'koti', sortOrder: 1 }),
    normalizeLifeArea({ id: 'raha', name: 'Talous', categoryKey: 'talous', sortOrder: 2 })
  ]);
  await dump('maksa sähkölasku huomenna\nsiivoa tällä viikolla');
  const bill = triageProposalOf(inboxByText('maksa sähkölasku huomenna'));
  assert.equal(bill.areaId, 'raha');
  assert.equal(bill.nature, 'OBLIGATION');
  assert.equal(bill.date, '2026-10-01');
  const clean = triageProposalOf(inboxByText('siivoa tällä viikolla'));
  assert.equal(clean.areaId, 'koti');
  assert.equal(clean.horizon, TASK_HORIZON.THIS_WEEK);
});

// =====================================================================
// ERÄ-KÄSITTELY
// =====================================================================

test('Tänään: tehtävä tälle päivälle, saapuva merkitään muunnetuksi tehtävän tunnisteella', async t => {
  freezeLocalDate(t, TODAY);
  const { items } = await dump('siivoa kylpyhuone\nosta maito');
  const outcome = await triageInboxItems(items.map(item => item.id), TRIAGE_DECISION.NOW);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.converted.length, 2);
  assert.equal(getState().tasks.length, 2);
  for (const task of getState().tasks) {
    assert.equal(task.date, TODAY);
    assert.equal(task.horizon, null, 'Tänään ei pinnaa fokukseen');
  }
  for (const item of items) {
    const current = getState().inboxItems.find(row => row.id === item.id);
    assert.equal(current.status, INBOX_STATUS.CONVERTED);
    assert.equal(current.convertedKind, 'task');
    assert.ok(getState().tasks.some(task => task.id === current.convertedId));
    assert.equal((await storedRow(inboxRepo, item.id)).status, INBOX_STATUS.CONVERTED, 'merkintä tallentui');
  }
  assert.equal(testStore.rows('tasks').length, 2, 'tehtävät tallentuivat');
});

for (const decision of [TRIAGE_DECISION.THIS_WEEK, TRIAGE_DECISION.LATER, TRIAGE_DECISION.NOT_YET]) {
  test(`${decision}: päivätön vain migraation 0015 jälkeen; muuten rivi jää Saapuviin (porttitila: ${DATELESS ? 'auki' : 'kiinni'})`, async t => {
    freezeLocalDate(t, TODAY);
    const { items } = await dump('siivoa kylpyhuone');
    const outcome = await triageInboxItems([items[0].id], decision);
    const current = getState().inboxItems.find(row => row.id === items[0].id);
    if (DATELESS) {
      assert.equal(outcome.converted.length, 1);
      const [task] = getState().tasks;
      assert.equal(task.date, null, 'ei keksittyä päivää');
      assert.equal(task.horizon, decision);
      assert.equal(current.status, INBOX_STATUS.CONVERTED);
    } else {
      assert.equal(outcome.converted.length, 0);
      assert.deepEqual(outcome.kept, [{ id: items[0].id, reason: TRIAGE_KEEP_REASON.DATELESS_GATE }]);
      assert.equal(getState().tasks.length, 0, 'KRIITTINEN: ei tehtävää keksityllä päivällä');
      assert.equal(current.status, INBOX_STATUS.UNPROCESSED, 'asia on tallessa Saapuvissa');
    }
  });
}

test(`Odottaa…: kenen varassa tallentuu tehtävälle (porttitila: ${DATELESS ? 'auki' : 'kiinni'})`, async t => {
  freezeLocalDate(t, TODAY);
  const { items } = await dump('Odotan Mikan vastausta\nvuokrasopimus');
  const outcome = await triageInboxItems(items.map(item => item.id), TRIAGE_DECISION.WAITING, { waitingOn: '' });
  if (DATELESS) {
    assert.equal(outcome.converted.length, 2);
    const byTitle = Object.fromEntries(getState().tasks.map(task => [task.title, task]));
    assert.equal(byTitle['Odotan Mikan vastausta'].horizon, TASK_HORIZON.WAITING);
    assert.equal(byTitle['Odotan Mikan vastausta'].waitingOn, 'Mikan vastaus', 'tyhjä teksti -> rivin oma ehdotus');
    assert.equal(byTitle.Vuokrasopimus?.waitingOn ?? byTitle.vuokrasopimus?.waitingOn ?? null, null);
  } else {
    assert.equal(outcome.kept.length, 2);
    assert.equal(getState().tasks.length, 0);
  }

  const named = await dump('lainapäätös');
  const again = await triageInboxItems([named.items[0].id], TRIAGE_DECISION.WAITING, { waitingOn: 'pankki' });
  if (DATELESS) {
    assert.equal(getState().tasks.find(task => task.title === 'lainapäätös').waitingOn, 'pankki');
  } else {
    assert.equal(again.kept[0].reason, TRIAGE_KEEP_REASON.DATELESS_GATE);
  }
});

test('Menoksi: meno kalenteriin olemassa olevaa menopolkua; päivätön rivi jää Saapuviin', async t => {
  freezeLocalDate(t, TODAY);
  const { items } = await dump('Hammaslääkäri perjantaina klo 14\nMummon synttärit lauantaina\nkahvit klo 14');
  const outcome = await triageInboxItems(items.map(item => item.id), TRIAGE_DECISION.EVENT);
  assert.equal(outcome.converted.length, 2);
  assert.deepEqual(outcome.kept.map(entry => entry.reason), [TRIAGE_KEEP_REASON.NO_DATE]);
  const events = getState().calendarEvents;
  assert.equal(events.length, 2);
  const dentist = events.find(event => event.title === 'Hammaslääkäri');
  assert.equal(dentist.date, '2026-10-02');
  assert.equal(dentist.startTime, '14:00');
  assert.equal(events.find(event => event.date === '2026-10-03').allDay, true);
  const converted = getState().inboxItems.find(row => row.id === items[0].id);
  assert.equal(converted.convertedKind, 'event');
  assert.equal(converted.convertedId, dentist.id);
  assert.equal(inboxByText('kahvit klo 14').status, INBOX_STATUS.UNPROCESSED);
  assert.equal(getState().tasks.length, 0);
});

test('Hylkää: rivi hylätään (palautettavissa), mitään ei luoda', async () => {
  const { items } = await dump('turha idea\ntoinen');
  const outcome = await triageInboxItems(items.map(item => item.id), TRIAGE_DECISION.DISMISS);
  assert.equal(outcome.dismissed, 2);
  assert.ok(getState().inboxItems.every(item => item.status === INBOX_STATUS.DISMISSED));
  assert.equal(getState().tasks.length, 0);
});

test('KRIITTINEN: jo käsitelty rivi ei muunnu uudelleen (tuplanapautus, toinen erä)', async t => {
  freezeLocalDate(t, TODAY);
  const { items } = await dump('osta maito');
  const [first, second] = await Promise.all([
    triageInboxItems([items[0].id], TRIAGE_DECISION.NOW),
    triageInboxItems([items[0].id], TRIAGE_DECISION.NOW)
  ]);
  assert.equal(first.converted.length + second.converted.length, 1, 'rinnakkainen napautus loi kaksi');
  const third = await triageInboxItems([items[0].id], TRIAGE_DECISION.NOW);
  assert.equal(third.converted.length, 0);
  assert.equal(third.skipped[0].reason, 'closed');
  assert.equal(getState().tasks.length, 1);
});

test('rivin aluevalinta ohjaa kategorian', async t => {
  freezeLocalDate(t, TODAY);
  setLifeAreas([
    normalizeLifeArea({ id: 'koti', name: 'Koti', categoryKey: 'koti', sortOrder: 1 }),
    normalizeLifeArea({ id: 'duuni', name: 'Työ', categoryKey: 'tyo', sortOrder: 2 })
  ]);
  const { items } = await dump('siivoa kylpyhuone\nsiivoa toimisto');
  await triageInboxItems(items.map(item => item.id), TRIAGE_DECISION.NOW, { areaChoices: { [items[1].id]: 'duuni' } });
  const byTitle = Object.fromEntries(getState().tasks.map(task => [task.title, task.category]));
  assert.equal(byTitle['siivoa kylpyhuone'], 'koti', 'ehdotus');
  assert.equal(byTitle['siivoa toimisto'], 'tyo', 'käyttäjän valinta');
});

test('saapuvan merkinnän epäonnistuminen ei peru luotua tehtävää, ja se kerrotaan', async t => {
  freezeLocalDate(t, TODAY);
  const { items } = await dump('osta maito');
  const original = inboxRepo.update;
  inboxRepo.update = async () => ({ ok: false, error: { message: 'verkko', userMessage: 'Yhteys katkesi.' } });
  let outcome;
  try {
    outcome = await triageInboxItems([items[0].id], TRIAGE_DECISION.NOW);
  } finally {
    inboxRepo.update = original;
  }
  assert.equal(getState().tasks.length, 1, 'luotu tehtävä on käyttäjän dataa');
  assert.equal(outcome.converted[0].markFailed, true);
  assert.equal(getState().inboxItems[0].status, INBOX_STATUS.UNPROCESSED, 'tila palautui');
});

test('epäonnistunut rivi ei vie muita mukanaan', async t => {
  freezeLocalDate(t, TODAY);
  const { items } = await dump('a'.repeat(201) + '\nlyhyt');
  // 201 merkkiä on pidempi kuin tehtävän otsikko: otsikko katkaistaan, joten molemmat onnistuvat.
  const outcome = await triageInboxItems(items.map(item => item.id), TRIAGE_DECISION.NOW);
  assert.equal(outcome.converted.length, 2);
  assert.equal(getState().tasks.find(task => task.title.startsWith('a')).title.length, 200);
});

test('tuntematon päätös ei tee mitään', async () => {
  const { items } = await dump('osta maito');
  const outcome = await triageInboxItems([items[0].id], 'DELETE');
  assert.equal(outcome.ok, false);
  assert.equal(getState().inboxItems[0].status, INBOX_STATUS.UNPROCESSED);
});

test('kesken ollut "Käsittele"-kortti suljetaan, kun sama rivi käsitellään erässä', async t => {
  freezeLocalDate(t, TODAY);
  const { items } = await dump('osta maito');
  setPendingCapture({ itemId: items[0].id, text: 'osta maito' });
  await triageInboxItems([items[0].id], TRIAGE_DECISION.NOW);
  assert.equal(getState().pendingCapture, null);
});

// =====================================================================
// KÄYTTÖLIITTYMÄ: KIRJAUSPALKKI JA SAAPUVAT (DOM-tynkä)
// =====================================================================

function installDom() {
  const html = read('index.html');
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
  ids.add('toastHost');
  const nodes = new Map();
  const dom = { focused: null };
  const make = id => {
    const attrs = {};
    const listeners = {};
    return {
      id, innerHTML: '', textContent: '', value: '', style: {}, dataset: {}, hidden: false, disabled: false,
      tagName: id && /Btn$/.test(id) ? 'BUTTON' : 'DIV',
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
      setAttribute(key, value) { attrs[key] = String(value); },
      getAttribute: key => (key in attrs ? attrs[key] : null),
      removeAttribute(key) { delete attrs[key]; },
      addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
      listeners, appendChild() {}, remove() {}, insertBefore() {},
      focus() { dom.focused = id; },
      querySelectorAll: () => [], querySelector: () => null
    };
  };
  globalThis.document = {
    getElementById(id) {
      // Ajon aikana piirretyt (innerHTML) tunnisteet ovat olemassa kuten oikeassa DOM:ssa.
      const rendered = [...nodes.values()].some(node => String(node.innerHTML).includes(`id="${id}"`));
      if (!ids.has(id) && !rendered) return null;
      if (!nodes.has(id)) nodes.set(id, make(id));
      return nodes.get(id);
    },
    createElement: () => make(null)
  };
  dom.node = id => globalThis.document.getElementById(id);
  dom.fire = async (id, type, event = {}) => {
    for (const fn of dom.node(id).listeners[type] || []) await fn({ preventDefault() {}, ...event });
  };
  return dom;
}

const inboxView = await import('../src/app/views/inbox.js');
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

test('HTML: kirjauskenttä on monirivinen, nimetty ja ohjeistettu; Saapuvilla on oma tilarivi', () => {
  const html = read('index.html');
  assert.match(html, /<textarea id="captureInput" rows="1"[^>]*maxlength="8000"/);
  assert.match(html, /<label[^>]*for="captureInput"/);
  assert.match(html, /id="captureInput"[^>]*aria-describedby="captureHint"/);
  assert.match(html, /id="captureHint"[^>]*>Enter kirjaa\. Shift ja Enter tekee uuden rivin\./);
  assert.match(html, /id="inboxStatus" role="status"/);
  for (const id of ['captureMicBtn', 'captureSendBtn', 'captureError', 'captureStatus', 'capturePending']) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
});

test('KRIITTINEN: kirjauspalkki kirjaa monta asiaa eikä avaa päätöskorttia', async () => {
  const dom = installDom();
  inboxView.initInbox();
  dom.node('captureInput').value = 'osta maito\nsoita Annalle\nimuroi';
  await dom.fire('captureSendBtn', 'click');
  await flush();
  assert.equal(getState().inboxItems.length, 3);
  assert.equal(getState().pendingCapture, null, 'päätöskortti ei aukea itsestään');
  inboxView.renderInbox();
  assert.equal(dom.node('capturePending').innerHTML, '');
  assert.equal(dom.node('captureStatus').textContent, 'Kirjattu 3 asiaa saapuviin. Järjestä ne, kun ehdit.');
  assert.equal(dom.node('captureInput').value, '', 'kenttä tyhjenee vasta tallennuksen jälkeen');

  dom.node('captureInput').value = 'vie roskat';
  await dom.fire('captureSendBtn', 'click');
  await flush();
  await flush();
  assert.equal(dom.node('captureStatus').textContent, 'Kirjattu saapuviin.');
  assert.equal(getState().pendingCapture, null, 'taustatulkintakaan ei avaa korttia');
  assert.equal(getState().tasks.length, 0, 'mitään ei luotu');
});

test('Enter kirjaa, Shift+Enter ei (uusi rivi); IME-kesken Enter ei kirjaa', async () => {
  const dom = installDom();
  inboxView.initInbox();
  dom.node('captureInput').value = 'eka';
  await dom.fire('captureInput', 'keydown', { key: 'Enter', shiftKey: true });
  await dom.fire('captureInput', 'keydown', { key: 'Enter', isComposing: true });
  await flush();
  assert.equal(getState().inboxItems.length, 0);
  await dom.fire('captureInput', 'keydown', { key: 'Enter' });
  await flush();
  assert.equal(getState().inboxItems.length, 1);
});

test('liian pitkä rivi ja liian pitkä liitos kerrotaan, teksti säilyy', async () => {
  const dom = installDom();
  inboxView.initInbox();
  dom.node('captureInput').value = 'x'.repeat(1001);
  await dom.fire('captureSendBtn', 'click');
  assert.match(dom.node('captureError').textContent, /Yksi rivi on liian pitkä/);
  assert.equal(dom.node('captureInput').value.length, 1001);
  assert.equal(getState().inboxItems.length, 0);
});

test('Saapuvat: valintaruutu, ehdotusrivi, alueen valinta ja erän painikkeet lukumäärineen', async t => {
  freezeLocalDate(t, TODAY);
  const dom = installDom();
  setLifeAreas([
    normalizeLifeArea({ id: 'koti', name: 'Koti', categoryKey: 'koti', sortOrder: 1 }),
    normalizeLifeArea({ id: 'duuni', name: 'Työ', categoryKey: 'tyo', sortOrder: 2 })
  ]);
  const { items } = await dump('siivoa tällä viikolla\nHammaslääkäri perjantaina klo 14');
  inboxView.selectInboxItemsForTests([items[0].id]);
  inboxView.renderInbox();
  const html = dom.node('inboxListContainer').innerHTML;
  assert.match(html, new RegExp(`<input type="checkbox" id="triageSel-${items[0].id}" data-triage-select="${items[0].id}" checked>`));
  assert.match(html, new RegExp(`<label class="assist-title" for="triageSel-${items[0].id}">siivoa tällä viikolla</label>`));
  assert.match(html, /Ehdotus: Tällä viikolla · Koti · Arjen ylläpito/);
  assert.match(html, /Ehdotus: Meno pe 2\.10\. klo 14:00/);
  assert.match(html, new RegExp(`<select id="triageArea-${items[0].id}" data-triage-area="${items[0].id}"><option value="">Ei aluetta</option><option value="koti" selected>Koti</option>`));
  assert.match(html, /id="inboxSelectAll"/);
  assert.match(html, /aria-label="Tänään: 1 valittu asia"/);
  assert.match(html, /aria-label="Tällä viikolla: 1 valittu asia"/);
  assert.match(html, /aria-label="Menoksi: 0 valittua asiaa, joilla on päivä" disabled/);
  assert.match(html, /data-triage="WAITING"[^>]*aria-haspopup="true"[^>]*>Odottaa…</);
  assert.match(html, /data-triage="DISMISS"/);
  // Yksittäinen "Käsittele" säilyy.
  assert.match(html, /data-inbox-review=/);
});

test(`Saapuvat: erä "Myöhemmin" kertoo rehellisesti porttitilan (${DATELESS ? 'auki' : 'kiinni'}) ja siirtää fokuksen`, async t => {
  freezeLocalDate(t, TODAY);
  const dom = installDom();
  const { items } = await dump('siivoa kylpyhuone\nosta maito');
  inboxView.selectInboxItemsForTests(items.map(item => item.id));
  await inboxView.runTriageForTests(TRIAGE_DECISION.LATER);
  const status = dom.node('inboxStatus').textContent;
  if (DATELESS) {
    assert.equal(status, 'Siirretty 2 asiaa: Myöhemmin.');
    assert.equal(dom.focused, 'inboxTitle', 'ei jäljellä olevia rivejä: fokus otsikkoon');
  } else {
    assert.equal(status, `${DATELESS_GATE_HINT} Asiat ovat tallessa Saapuvissa.`);
    assert.equal(getState().tasks.length, 0);
    assert.match(dom.focused, /^triageSel-/, 'fokus ensimmäiseen jäljellä olevaan riviin');
  }
});

test('Saapuvat: erä "Tänään" luo tehtävät ja ilmoittaa lopputuloksen tilarivillä', async t => {
  freezeLocalDate(t, TODAY);
  const dom = installDom();
  const { items } = await dump('siivoa kylpyhuone\nosta maito\njätä tämä');
  inboxView.selectInboxItemsForTests([items[0].id, items[1].id]);
  await inboxView.runTriageForTests(TRIAGE_DECISION.NOW);
  assert.equal(dom.node('inboxStatus').textContent, 'Siirretty 2 asiaa: Tänään.');
  assert.equal(getState().tasks.length, 2);
  assert.equal(dom.focused, `triageSel-${items[2].id}`);
});

test('Saapuvat: ilman valintaa erä ei tee mitään ja pyytää valitsemaan', async () => {
  const dom = installDom();
  await dump('osta maito');
  inboxView.selectInboxItemsForTests([]);
  await inboxView.runTriageForTests(TRIAGE_DECISION.NOW);
  assert.match(dom.node('inboxStatus').textContent, /Valitse ensin/);
  assert.equal(getState().tasks.length, 0);
});

test('L0: "Käsittele" piirtää tarkistuskortin Saapuviin ja Tänään-näkymään', async () => {
  const dom = installDom();
  setPendingCapture({ itemId: 'i1', text: 'Soita Annalle', description: 'Luo tehtävä', route: { kind: 'task' } });
  inboxView.renderInbox();
  assert.match(dom.node('inboxPending').innerHTML, /review-card/);
  assert.match(dom.node('capturePending').innerHTML, /review-card/);
});

test('näkymän lähde: kirjaus ei kutsu reviewItem-funktiota eikä captureAndInterpret-polkua', () => {
  const source = readCode('src/app/views/inbox.js');
  const submit = source.slice(source.indexOf('async function submitCapture'), source.indexOf('let dictationRun'));
  assert.equal(submit.includes('reviewItem('), false, 'kirjaus avaa päätöskortin');
  assert.equal(submit.includes('captureAndInterpret'), false);
  assert.ok(submit.includes('captureBrainDump('));
});

// =====================================================================
// PUHE -> TALLENNA SAAPUVIIN
// =====================================================================

test('puhe: "muista että", "kirjaa", "saapuviin" ohjautuvat Saapuviin sellaisenaan', () => {
  const cases = [
    ['Muista että vie roskat', 'vie roskat', false],
    ['muista ostaa kahvia', 'ostaa kahvia', false],
    ['Kirjaa saapuviin: soita Annalle', 'soita Annalle', false],
    ['saapuviin hammaslääkäri', 'hammaslääkäri', false],
    ['kirjaa uusi idea sovellukseen', 'uusi idea sovellukseen', true]
  ];
  for (const [text, rest, bare] of cases) {
    const route = routeUtterance(text);
    assert.equal(route.kind, ROUTE.INBOX, text);
    assert.equal(route.text, rest, text);
    assert.equal(route.bare, bare, text);
  }
  for (const text of ['Muistuta minua huomenna', 'kirjaa aikaa 30 min lenkki', 'kirjaa 30 min', 'kirjaa', 'muista',
    'Lisää tehtävä pestä auto', 'etsi lääkäri']) {
    assert.notEqual(routeUtterance(text).kind, ROUTE.INBOX, text);
  }
});

test('puheen tilakone: Saapuviin tallennus vain näkyvästä tekstistä, ei kuuntelusta eikä käsittelystä', () => {
  for (const state of [VOICE.TRANSCRIPT_READY, VOICE.TYPE_FALLBACK, VOICE.ERROR]) {
    assert.equal(nextVoiceState(state, VOICE_EVENT.SAVE_TO_INBOX), VOICE.IDLE, state);
  }
  for (const state of [VOICE.IDLE, VOICE.LISTENING, VOICE.REQUESTING_PERMISSION, VOICE.CLASSIFYING,
    VOICE.CONFIRMATION, VOICE.EXECUTING, VOICE.MIC_DENIED]) {
    assert.equal(nextVoiceState(state, VOICE_EVENT.SAVE_TO_INBOX), state, state);
  }
});

test('puhe: tallennus Saapuviin kirjaa litteroinnin (lähde puhe), ei ääntä eikä päätöksiä', async () => {
  const { saveTranscriptToInbox } = await import('../src/app/voice.js');
  const result = await saveTranscriptToInbox('vie roskat\nsoita Annalle');
  assert.equal(result.ok, true);
  assert.deepEqual(getState().inboxItems.map(item => [item.text, item.source]),
    [['vie roskat', CAPTURE_SOURCE.VOICE], ['soita Annalle', CAPTURE_SOURCE.VOICE]]);
  assert.equal(getState().tasks.length, 0);
  const voice = readCode('src/app/voice.js');
  assert.equal(/MediaRecorder|getUserMedia|AudioContext/.test(voice), false, 'ääntä ei tallenneta');
  // Kirjaus ohjataan ennen komentoputkea, ja paljas "kirjaa" + selvä meno kulkee menon luontiin.
  const submit = voice.slice(voice.indexOf('const submitTranscript'), voice.indexOf('function onListenResult'));
  assert.ok(submit.indexOf('ROUTE.INBOX') > -1);
  assert.ok(submit.indexOf('saveTranscriptToInbox(route.text)') < submit.indexOf('runVoiceCommand(clean'));
  assert.match(submit, /route\.bare && looksLikeEvent\(clean\)/);
  // Ymmärtämätön komento tarjoaa tallennusta.
  assert.match(submit, /lastText = canOfferInbox\(result\) \? clean : ''/);
  assert.match(voice, /showButton\('voiceErrorSaveInbox', Boolean\(lastText\) && !denied\)/);
});

// =====================================================================
// KOMENTOPALKKI -> TALLENNA SAAPUVIIN
// =====================================================================

test('komentopalkki: Tallenna saapuviin käyttää brain dumpia (monirivinen), ei tekoälyä', async () => {
  const result = await saveCommandToInbox('osta maito\nsoita Annalle');
  assert.equal(result.ok, true);
  assert.equal(result.status, 'saved');
  assert.equal(getState().inboxItems.length, 2);
  assert.ok(getState().inboxItems.every(item => item.source === CAPTURE_SOURCE.TEXT));
  assert.equal((await saveCommandToInbox('   ')).status, 'empty');
  const voiced = await saveCommandToInbox('vie roskat', { source: 'voice' });
  assert.equal(voiced.items[0].source, CAPTURE_SOURCE.VOICE);
});

test('komentopalkki: tarjous näytetään, kun komentoa ei ymmärretty tai se epäonnistui', () => {
  for (const status of ['rejected', 'error', 'needs_input', 'needs_choice']) {
    assert.equal(canOfferInbox({ ok: false, status }), true, status);
  }
  for (const result of [{ ok: true, status: 'executed' }, { ok: false, status: 'cancelled' },
    { ok: false, status: 'empty' }, { ok: false, status: 'discarded' }, { ok: false, status: 'duplicate' }, null]) {
    assert.equal(canOfferInbox(result), false, JSON.stringify(result));
  }
  const search = readCode('src/app/search.js');
  assert.match(search, /saveCommandToInbox\(text, \{ source: 'text' \}\)/);
  assert.match(search, /canOfferInbox\(result\)/);
  assert.match(search, /button\.textContent = 'Tallenna saapuviin'/);
});
