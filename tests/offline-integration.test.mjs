// Offline-jono sovelluskerroksessa: actions.js, AI-komennot, lataus ja johdotus.
//
// Käyttää oikeaa `offline`-ilmentymää (src/app/offline.js) ja
// muistinvaraista palvelinta. navigator.onLine ohitetaan testin ajaksi.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { read, readCode } from './helpers/sources.mjs';
import { createMemoryServer } from './helpers/memoryServer.mjs';
import { fakeClient } from './helpers/gates.mjs';
import { setUser, clearUser } from '../src/data/session.js';
import { setClient } from '../src/data/client.js';
import { resetQueueStoreForTests } from '../src/data/offlineQueueStore.js';
import { resetState, getState, setTasks } from '../src/app/state.js';
import { normalizeTask } from '../src/domain/task.js';
import {
  createTask, editTask, toggleComplete, loadUserData, clearLocalUserData
} from '../src/app/actions.js';
import { offline, subscribeSyncStatus } from '../src/app/offline.js';
import { handlers } from '../src/app/aiCommandHandlers.js';
import { INTENT } from '../src/ai/intentSchema.js';

const ALICE = { id: 'aaaaaaaa-1111-4111-8111-00000000000a', email: 'a@example.com' };

const server = createMemoryServer();
const empty = fakeClient({ data: [], error: null });

/** Tehtävät muistipalvelimelle, kaikki muu tyhjänä: loadUserData ei kaadu. */
const mixedClient = {
  from: table => (table === 'tasks' ? server.client.from('tasks') : empty.from(table))
};

let savedNavigator;
function setOnline(value) {
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: value }, configurable: true });
  server.online = value;
}

beforeEach(() => {
  savedNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  server.reset();
  resetQueueStoreForTests();
  clearUser();
  clearLocalUserData();
  resetState();
  setUser(ALICE);
  server.authUser = ALICE.id;
  setClient(mixedClient);
  offline.deactivate();
  offline.activate(ALICE.id);
  setOnline(true);
});

afterEach(() => {
  offline.deactivate();
  if (savedNavigator) Object.defineProperty(globalThis, 'navigator', savedNavigator);
  else delete globalThis.navigator;
});

const stateTask = id => getState().tasks.find(task => task.id === id);

// ------------------------------------------------------------ jonotus

test('offline: tehtävän lisäys jonotetaan, näkyy heti, ja lähtee kun yhteys palaa', async () => {
  setOnline(false);
  const result = await createTask({ title: 'Osta maitoa', date: '2026-09-20' });

  assert.equal(result.ok, true);
  assert.equal(result.queued, true);
  assert.equal(getState().tasks.length, 1, 'näkyy käyttäjälle heti');
  assert.equal(offline.status().pending, 1);
  assert.equal(server.rows.size, 0, 'ei ole palvelimella -- ei väitetä vahvistetuksi');
  assert.equal(offline.pendingIds().has(result.task.id), true, 'merkitään odottavaksi');

  setOnline(true);
  const run = await offline.replay();
  assert.equal(run.synced, 1);
  assert.equal(server.rows.size, 1);
  assert.equal(offline.status().total, 0);
});

test('online mutta verkkovirhe kesken kirjoituksen: jonotetaan, ei peruta', async () => {
  server.online = false; // navigator.onLine on yhä tosi
  const result = await createTask({ title: 'Kesken', date: '2026-09-20' });
  assert.equal(result.queued, true);
  assert.equal(getState().tasks.length, 1);
  assert.equal(offline.status().pending, 1);
});

test('istunto vanhenee kirjoituksen aikana: jonotetaan, ei peruta', async () => {
  server.authExpired = true;
  const result = await createTask({ title: 'Vanhentunut istunto', date: '2026-09-20' });
  assert.equal(result.queued, true);
  assert.equal(offline.status().pending, 1);
  server.authExpired = false;
  assert.equal((await offline.replay()).synced, 1);
});

test('KRIITTINEN: palvelimen hylkäys EI jonoteta -- peruutus ja virhe kuten ennen', async () => {
  server.failNext('insert', { message: 'check constraint', code: '23514' });
  const result = await createTask({ title: 'Hylättävä', date: '2026-09-20' });
  assert.equal(result.ok, false);
  assert.equal(getState().tasks.length, 0, 'optimistinen lisäys peruttiin');
  assert.equal(offline.status().total, 0);
});

test('muokkaus offline: jonotetaan päivitys, ja replay kirjoittaa vain muuttuneen sarakkeen', async () => {
  const original = normalizeTask({ id: 't1', title: 'Alku', date: '2026-09-20' });
  setTasks([original]);
  server.rows.set('t1', {
    id: 't1', date: '2026-09-20', time: null, end_time: null, title: 'Alku', category: original.category,
    note: null, completed: false, is_wake: false, description: null, duration_minutes: null,
    priority: original.priority, scheduling_state: original.schedulingState, user_id: ALICE.id
  });

  setOnline(false);
  const edited = await editTask('t1', { title: 'Uusi' });
  assert.deepEqual([edited.ok, edited.queued], [true, true]);
  assert.equal(stateTask('t1').title, 'Uusi', 'paikallinen tila päivittyi');

  setOnline(true);
  const run = await offline.replay();
  assert.equal(run.synced, 1);
  assert.equal(server.rows.get('t1').title, 'Uusi');
  assert.equal(server.writes.find(write => write.op === 'update').columns.includes('title'), true);
});

test('valmis-merkintä offline: jonotetaan ja lähtee replayssa', async () => {
  const original = normalizeTask({ id: 't1', title: 'Tee tämä', date: '2026-09-20' });
  setTasks([original]);
  server.rows.set('t1', {
    id: 't1', date: '2026-09-20', time: null, end_time: null, title: 'Tee tämä', category: original.category,
    note: null, completed: false, is_wake: false, description: null, duration_minutes: null,
    priority: original.priority, scheduling_state: original.schedulingState, user_id: ALICE.id
  });

  setOnline(false);
  assert.equal(await toggleComplete('t1'), true);
  assert.equal(stateTask('t1').completed, true);
  assert.equal(offline.status().pending, 1);

  setOnline(true);
  await offline.replay();
  assert.equal(server.rows.get('t1').completed, true);
});

test('ilman aktiivista jonoa toiminta on ennallaan: offline-virhe peruu ja ilmoittaa', async () => {
  offline.deactivate();
  setOnline(false);
  const result = await createTask({ title: 'Ei jonoa', date: '2026-09-20' });
  assert.equal(result.ok, false);
  assert.equal(getState().tasks.length, 0);
});

test('KRIITTINEN: AI-komennon suoritusta ei koskaan jonoteta', async () => {
  setOnline(false);
  const created = await handlers[INTENT.CREATE_TASK]({ payload: { title: 'AI:n luoma', date: '2026-09-20' } });
  assert.equal(created.ok, false);
  assert.equal(getState().tasks.length, 0, 'AI-luonti peruttiin eikä jonotettu');
  assert.equal(offline.status().total, 0);

  const original = normalizeTask({ id: 't1', title: 'Alku', date: '2026-09-20' });
  setTasks([original]);
  const target = { id: 't1', entity: original };
  for (const call of [
    () => handlers[INTENT.UPDATE_TASK]({ payload: { changes: { title: 'AI muutti' } }, target }),
    () => handlers[INTENT.COMPLETE_TASK]({ target }),
    () => handlers[INTENT.RESCHEDULE_TASK]({ payload: { date: '2026-09-25', time: null, shiftMinutes: null }, target, entity: original }),
    () => handlers[INTENT.SCHEDULE_TASK]({ payload: { changes: { date: '2026-09-25' } }, target })
  ]) {
    const result = await call();
    assert.equal(result.ok, false);
    assert.equal(stateTask('t1').title, 'Alku', 'peruttu, ei jäänyt paikalliseen tilaan');
    assert.equal(offline.status().total, 0, 'mitään ei jonotettu');
  }
});

// ------------------------------------------------- lataus ja näkymä

test('KRIITTINEN: lataus ei pyyhi odottavaa tehtävää näkyvistä (overlay)', async () => {
  setOnline(false);
  const queued = await createTask({ title: 'Odottaa', date: '2026-09-20' });
  assert.equal(queued.queued, true);

  setOnline(true);
  server.rows.set('palvelin', {
    id: 'palvelin', date: '2026-09-20', time: null, end_time: null, title: 'Palvelimella', category: 'muu',
    note: null, completed: false, is_wake: false, user_id: ALICE.id
  });

  const loaded = await loadUserData();
  assert.equal(loaded.tasksOk, true);
  const titles = getState().tasks.map(task => task.title).sort();
  assert.deepEqual(titles, ['Odottaa', 'Palvelimella'], 'palvelimen lista + odottava muutos');

  await offline.replay();
  await loadUserData();
  assert.equal(getState().tasks.filter(task => task.title === 'Odottaa').length, 1, 'ei kaksoiskappaletta synkronoinnin jälkeen');
});

test('tilakuuntelija saa päivitykset ja peruutus toimii (ei kuuntelijavuotoa)', async () => {
  const seen = [];
  const unsubscribe = subscribeSyncStatus(status => seen.push(status.pending));
  setOnline(false);
  await createTask({ title: 'Kuunneltu', date: '2026-09-20' });
  assert.ok(seen.includes(1));

  unsubscribe();
  const count = seen.length;
  await createTask({ title: 'Kuuntelemattomalle', date: '2026-09-21' });
  assert.equal(seen.length, count, 'peruutettu kuuntelija ei saa enää päivityksiä');
});

test('useita muutoksia offline: yksi jono, ei kaksoiskappaleita replayssa', async () => {
  setOnline(false);
  for (let i = 0; i < 5; i += 1) await createTask({ title: 'Tehtävä ' + i, date: '2026-09-20' });
  assert.equal(offline.status().pending, 5);
  setOnline(true);
  const [a, b] = await Promise.all([offline.replay(), offline.replay()]);
  assert.equal([a, b].filter(run => run.ran).length, 1);
  assert.equal(server.rows.size, 5);
  assert.equal(server.writes.filter(write => write.op === 'insert').length, 5);
});

// ------------------------------------------------------------- johdotus

test('main.js: aktivointi ennen latausta, lähetys ennen uudelleenlatausta ja vapautus uloskirjautuessa', () => {
  const main = readCode('src/app/main.js');
  // UUSI SÄÄNTÖ (F11): myös kirjautuminen LÄHETTÄÄ ENSIN ja lataa vasta
  // sitten, samalla sendPending()-funktiolla kuin verkon palautuminen.
  // Aiemmin kirjautuminen latasi ensin ja lähetti rinnakkain, jolloin
  // ennen lähetystä haettu lista saattoi piilottaa juuri lähetetyn.
  const send = main.slice(main.indexOf('async function sendPending'), main.indexOf('async function loadFresh'));
  assert.ok(send.indexOf('offline.replay(') > -1);
  assert.ok(send.indexOf('offline.replay(') < send.indexOf('await flushTimeOutbox()'), 'tehtäväjono, sitten aikakirjaukset');
  const fresh = main.slice(main.indexOf('async function loadFresh'), main.indexOf('function hasLoadFailures'));
  assert.ok(fresh.indexOf('beginDataLoad()') > -1 && fresh.indexOf('beginDataLoad()') < fresh.indexOf('await loadUserData()'),
    'latauksen aikana valmistuneet tallennukset palautetaan (keepWritesSince)');

  const signedIn = main.slice(main.indexOf('async function onSignedIn'), main.indexOf('function onSignedOut'));
  assert.ok(signedIn.indexOf('offline.activate(') > -1);
  assert.ok(signedIn.indexOf('offline.activate(') < signedIn.indexOf('await sendPending()'),
    'jono aktivoidaan ennen lähetystä ja ensimmäistä latausta (overlay)');
  assert.ok(signedIn.indexOf('await sendPending()') < signedIn.indexOf('await loadFresh()'),
    'kirjautuminen: lähetä ensin, lataa vasta sitten');

  const reconnect = main.slice(main.indexOf('async function refreshAfterReconnect'), main.indexOf('const reconnect = '));
  assert.ok(reconnect.indexOf('await sendPending()') > -1);
  assert.ok(reconnect.indexOf('await sendPending()') < reconnect.indexOf('loadFresh()'),
    'lähetä ensin, lataa vasta sitten');

  assert.match(main, /offline\.deactivate\(\)/);
  assert.match(main, /setSyncedHandler\(/);
  assert.match(main, /initOfflineStatus\(\)/);
  assert.match(main, /refreshSyncStatus\(\)/);
});

test('uloskirjautuminen varoittaa lähettämättömistä muutoksista ennen kuin mitään tehdään', () => {
  const auth = readCode('src/app/auth.js');
  const start = auth.indexOf('const signOut = singleFlight');
  const body = auth.slice(start, auth.indexOf('\n});', start));
  assert.ok(body.indexOf('offline.status()') > -1);
  assert.ok(body.indexOf('confirmAction(') > -1);
  assert.ok(body.indexOf('confirmAction(') < body.indexOf('auth.signOut('), 'varoitus ennen uloskirjautumista');
  assert.match(body, /if \(!sure\) return;/);
});

test('tilin poisto tyhjentää jonon ennen uloskirjautumista', () => {
  const ui = readCode('src/app/accountDeletion.js');
  assert.ok(ui.indexOf('offline.purge(') > ui.indexOf('FLOW_EVENT.SUCCEEDED'));
  assert.ok(ui.indexOf('offline.purge(') < ui.indexOf('await signOutAndClean()'));
});

test('käyttöliittymä: banneri ei valehtele ja tilarivi on saavutettava', () => {
  const html = read('index.html');
  assert.match(html, /id="offlineBanner"[^>]*>[^<]*tehtävien lisäys ja muokkaus tallentuu laitteelle[^<]*muut muutokset eivät tallennu/);
  assert.equal(/muutokset eivät tallennu<\/div>/.test(html.replace(/tehtävien lisäys[^<]*/, '')), false);
  assert.match(html, /<button[^>]*id="syncStatus"[^>]*hidden[^>]*aria-live="polite"/);

  const status = read('src/app/offlineStatus.js');
  assert.match(status, /node\.disabled = !view\.needsReview/);
  assert.match(status, /aria-label/);
  assert.match(status, /if \(key === lastText\) return;/, 'ei turhaa uudelleenrenderöintiä');
});

test('tarkistusvirta: hylkääminen vaatii aina erillisen vahvistuksen (Esc ei poista muutosta)', () => {
  const status = readCode('src/app/offlineStatus.js');
  const conflict = status.slice(status.indexOf('OP_STATUS.CONFLICT'), status.indexOf('OP_STATUS.FAILED'));
  assert.ok(conflict.indexOf("resolve(item.id, 'mine')") < conflict.indexOf("resolve(item.id, 'discard')"));
  assert.ok((conflict.match(/confirmAction\(/g) || []).length >= 2, 'kaksivaiheinen');
  assert.match(conflict, /destructive: true/);
  // hylkäys tapahtuu vain `if (drop)` -haarassa, ei cancel-polulla
  assert.match(conflict, /if \(drop\) offline\.resolve\(item\.id, 'discard'\)/);
});

test('tehtävälista merkitsee odottavat muutokset näkyvästi', () => {
  const tasks = readCode('src/app/views/tasks.js');
  assert.match(tasks, /offline\.pendingIds\(\)/);
  assert.match(tasks, /Odottaa synkronointia/);
});

test('service worker esilataa offline-moduulit ja uusi vanha versio ei pääse sekaan', () => {
  const sw = read('sw.js');
  for (const file of ['/src/app/offline.js', '/src/app/offlineStatus.js', '/src/app/offlineSync.js',
    '/src/data/offlineQueueStore.js', '/src/domain/offlineQueue.js']) {
    assert.ok(sw.includes(`'${file}'`), file);
  }
});
