// Aikakirjausten lähtökori: pysyvä virhe, poisto kesken lähetyksen ja
// toinen välilehti (riippumattoman katselmoinnin löydökset 5-7).
//
//   5. Vain 22xxx/23xxx hylättiin. Muu pysyvä virhe (42501, 42804, 42883,
//      PGRST1xx) jätti kirjauksen koriin, ja koska lähetys pysähtyi
//      ensimmäiseen säilytettävään, se esti KAIKKI myöhemmät kirjaukset
//      ikuisesti -- näkymättömästi.
//   6. Lähetys käytti alussa luettua koria: kun e1 oli matkalla ja käyttäjä
//      poisti e2:n, lähetys lisäsi e2:n takaisin kantaan (ja tilaan).
//   7. Toisen välilehden lähetys ehti lähettää tämän välilehden kesken
//      olevan kirjauksen. Oma lisäys sai 23505:n samalle tunnisteelle, ja
//      logTime piti sitä toisen operaation kaksoiskappaleena: kirjaus
//      katosi tilasta ja käyttäjälle sanottiin "on jo kirjattu".

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { read } from './helpers/sources.mjs';
import { fakeClient } from './helpers/gates.mjs';
import { setUser, clearUser, getUser, sessionSnapshot, isSameSession } from '../src/data/session.js';
import { setClient } from '../src/data/client.js';
import { resetState, getState, setTimeEntries } from '../src/app/state.js';
import { clearLocalUserData } from '../src/app/actions.js';
import {
  logTime, deleteTimeEntry, flushTimeOutbox, retryTimeOutbox, pendingTimeEntryCount,
  pendingTimeEntryOperations, setTimeEntryWriterForTests, beginDataLoad, keepWritesSince,
  resetAlignmentSession, failedTimeEntries, retryFailedTimeEntries, discardFailedTimeEntries
} from '../src/app/alignment.js';
import { createTimeEntryWriter, MAX_FLUSH_ATTEMPTS, isSameEntryDuplicate } from '../src/app/timeEntryWriter.js';
import { timeEntriesRepo } from '../src/data/collectionsRepo.js';
import { loadOutbox, saveOutbox, resetTimerStoreForTests } from '../src/data/timerStore.js';
import { normalizeTimeEntry } from '../src/domain/timeEntry.js';
import { initDirection, renderDirection, resetDirectionView } from '../src/app/views/direction.js';

const USER_A = { id: 'aaaaaaaa-8181-4181-8181-00000000008a', email: 'a@example.com' };
const DAY = '2026-09-21';

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

const openGates = [];
function gate() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  openGates.push(() => release());
  return { promise, release };
}

/**
 * Kanta kuten PostgreSQL: pääavain (id) ja operaation uniikkiavain
 * (user_id, operation_id), virheviesteineen. `wait` viivästää lisäystä.
 */
function database() {
  const rows = new Map();
  return {
    rows,
    repo({ wait = null, errorFor = () => null } = {}) {
      const calls = [];
      return {
        calls,
        isPersistent: () => true,
        async insert(entry) {
          calls.push(entry.operationId);
          if (wait) await wait;
          const error = errorFor(entry);
          if (error) return { ok: false, error: { code: 'time_entries.insert', cause: error } };
          if (rows.has(entry.id)) {
            return { ok: false, error: { cause: {
              code: '23505', message: 'duplicate key value violates unique constraint "time_entries_pkey"',
              details: `Key (id)=(${entry.id}) already exists.`
            } } };
          }
          if ([...rows.values()].some(row => row.operationId === entry.operationId)) {
            return { ok: false, error: { cause: {
              code: '23505', message: 'duplicate key value violates unique constraint "time_entries_operation_unique"',
              details: `Key (user_id, operation_id)=(${USER_A.id}, ${entry.operationId}) already exists.`
            } } };
          }
          rows.set(entry.id, { ...entry });
          return { ok: true, value: entry };
        }
      };
    }
  };
}

/** Kuten alignment.js: omistaja luetaan istunnosta kutsuhetkellä. */
function writerFor(repo) {
  return createTimeEntryWriter({
    repo, loadOutbox, saveOutbox,
    userId: () => (getUser() ? String(getUser().id) : null),
    snapshot: sessionSnapshot, isSameSession
  });
}

function entry(id, extra = {}) {
  return normalizeTimeEntry({ id, entryDate: DAY, minutes: 20, operationId: `log:${id}`, ...extra });
}

const restores = [];
function stubRemove(db) {
  const original = timeEntriesRepo.remove;
  timeEntriesRepo.remove = async id => { db.rows.delete(id); return { ok: true, value: { id } }; };
  restores.push(() => { timeEntriesRepo.remove = original; });
}

/** Toastit talteen (notify/showError kirjoittavat DOMiin). */
function captureToasts(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const toasts = [];
  globalThis.document = {
    getElementById: () => null,
    createElement: () => {
      const node = {
        textContent: '', className: '', classList: { add() {} },
        setAttribute() {}, addEventListener() {}, appendChild() {}, remove() {}
      };
      toasts.push(node);
      return node;
    },
    body: { appendChild() {} }
  };
  return toasts;
}

beforeEach(() => {
  clearUser();
  clearLocalUserData();
  resetState();
  resetTimerStoreForTests();
  resetAlignmentSession();
  installStorage();
  setTimeEntryWriterForTests(null);
  setUser(USER_A);
  setClient(fakeClient({ data: [], error: null }));
});

afterEach(() => {
  while (openGates.length) openGates.pop()();
  while (restores.length) restores.pop()();
  setTimeEntryWriterForTests(null);
  delete globalThis.localStorage;
  delete globalThis.document;
  delete globalThis.CSS;
});

// ============================================================ 5. pysyvä virhe

const PERMANENT = [
  ['42804 (tyyppi)', { code: '42804', message: 'column "minutes" is of type integer but expression is of type text' }],
  ['42883 (funktio)', { code: '42883', message: 'function does not exist' }],
  ['42501 (oikeus, ei istunto)', { code: '42501', message: 'permission denied for table time_entries', status: 403 }],
  ['PGRST116', { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned', status: 406 }]
];

for (const [name, error] of PERMANENT) {
  test(`5 KRIITTINEN: pysyvä virhe ${name} ei jumita myöhempiä kirjauksia`, async () => {
    const db = database();
    const repo = db.repo({ errorFor: e => (e.operationId === 'log:bad' ? error : null) });
    const writer = writerFor(repo);
    saveOutbox(USER_A.id, [entry('bad'), entry('good')]);
    const first = await writer.flush();
    assert.deepEqual([first.sent, first.left, first.failed], [1, 1, 0]);
    assert.ok(db.rows.has('good'), 'myöhempi kirjaus jäi viallisen taakse');
    assert.deepEqual(loadOutbox(USER_A.id).map(e => e.id), ['bad'], 'viallinen kirjaus säilyy laitteella');
  });
}

test('5 KRIITTINEN: toistuva pysyvä virhe -> näkyvä "epäonnistui", ei enää automaattisia yrityksiä; uudelleen ja hylkäys', async () => {
  const db = database();
  let broken = true;
  const repo = db.repo({ errorFor: e => (broken && e.operationId === 'log:bad' ? { code: '42804', message: 'type' } : null) });
  const writer = writerFor(repo);
  saveOutbox(USER_A.id, [entry('bad')]);
  let last;
  for (let round = 1; round <= MAX_FLUSH_ATTEMPTS; round += 1) {
    last = await writer.flush();
    assert.equal(last.newlyFailed.length, round === MAX_FLUSH_ATTEMPTS ? 1 : 0, `kierros ${round}`);
  }
  assert.deepEqual([last.left, last.failed], [0, 1]);
  assert.equal(writer.pendingCount(), 0, 'epäonnistunut ei "odota yhteyttä"');
  assert.deepEqual(writer.failedEntries().map(e => e.id), ['bad']);
  assert.deepEqual(loadOutbox(USER_A.id).map(e => e.id), ['bad'], 'epäonnistunut katosi laitteelta');

  const calls = repo.calls.length;
  await writer.flush();
  assert.equal(repo.calls.length, calls, 'epäonnistunutta yritettiin yhä automaattisesti');

  // Käyttäjä: "Yritä uudelleen".
  broken = false;
  assert.equal(writer.retryFailed(), 1);
  assert.equal(writer.pendingCount(), 1);
  const again = await writer.flush();
  assert.equal(again.sent, 1);
  assert.deepEqual(loadOutbox(USER_A.id), []);
});

test('5: tilapäinen virhe (verkko, 503, skeema) pysäyttää yhä lähetyksen eikä kuluta yrityksiä', async () => {
  const db = database();
  const repo = db.repo({ errorFor: () => ({ code: 'PGRST002', message: 'schema cache', status: 503 }) });
  const writer = writerFor(repo);
  saveOutbox(USER_A.id, [entry('a'), entry('b')]);
  for (let round = 0; round < MAX_FLUSH_ATTEMPTS + 1; round += 1) await writer.flush();
  assert.deepEqual(writer.failedEntries(), []);
  assert.equal(writer.pendingCount(), 2);
  assert.ok(repo.calls.every(op => op === 'log:a'), 'tilapäisen virheen jälkeen jatkettiin seuraaviin');
});

test('5 KRIITTINEN: Suunta näyttää epäonnistuneen, ja uudelleen/hylkäys toimivat (hylkäys vain vahvistuksella)', async (t) => {
  const toasts = captureToasts(t);
  const db = database();
  let broken = true;
  const repo = db.repo({ errorFor: e => (broken && e.operationId === 'log:stuck' ? { code: '42883', message: 'x' } : null) });
  setTimeEntryWriterForTests(writerFor(repo));
  const stuck = entry('stuck');
  saveOutbox(USER_A.id, [stuck]);
  setTimeEntries([stuck]);
  for (let round = 0; round < MAX_FLUSH_ATTEMPTS; round += 1) await flushTimeOutbox({ now: round * 1_000_000 });
  assert.deepEqual(failedTimeEntries().map(e => e.id), ['stuck']);
  assert.ok(toasts.some(node => /tallessa tällä laitteella/.test(node.textContent)), 'käyttäjälle ei kerrottu');
  assert.equal(pendingTimeEntryCount(), 0);
  assert.equal(pendingTimeEntryOperations().has('log:stuck'), false);
  assert.equal((await retryTimeOutbox({ now: 10_000_000 })).skipped, 'empty', 'epäonnistunut käynnisti ajastetun uusinnan');

  // Hylkäys vaatii vahvistuksen: peruttu = mitään ei poisteta.
  const cancelled = await discardFailedTimeEntries({ confirmFn: async () => false });
  assert.equal(cancelled.discarded, 0);
  assert.deepEqual(loadOutbox(USER_A.id).map(e => e.id), ['stuck']);
  assert.deepEqual(getState().timeEntries.map(e => e.id), ['stuck']);

  // "Yritä uudelleen" lähettää heti.
  broken = false;
  const retried = await retryFailedTimeEntries();
  assert.deepEqual([retried.retried, retried.sent], [1, 1]);
  assert.ok(db.rows.has('stuck'));
  assert.deepEqual(loadOutbox(USER_A.id), []);
});

test('5: hylkäys vahvistuksen jälkeen poistaa epäonnistuneen laitteelta ja näkymästä', async () => {
  const db = database();
  setTimeEntryWriterForTests(writerFor(db.repo({ errorFor: () => ({ code: '42804', message: 'x' }) })));
  const bad = entry('drop-me');
  saveOutbox(USER_A.id, [bad]);
  setTimeEntries([bad]);
  for (let round = 0; round < MAX_FLUSH_ATTEMPTS; round += 1) await flushTimeOutbox({ now: round * 1_000_000 });
  let asked = null;
  const result = await discardFailedTimeEntries({ confirmFn: async options => { asked = options; return true; } });
  assert.equal(result.discarded, 1);
  assert.equal(asked.destructive, true);
  assert.deepEqual(loadOutbox(USER_A.id), []);
  assert.deepEqual(getState().timeEntries, []);
  assert.deepEqual(failedTimeEntries(), []);
});

// ------------------------------------------------------------ Suunta-näkymä

const HTML_IDS = new Set([...read('index.html').matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
function stubElement(id) {
  const listeners = {};
  return {
    id, innerHTML: '', textContent: '', value: '', checked: false, disabled: false, hidden: false,
    style: {}, dataset: {},
    classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
    setAttribute() {}, getAttribute: () => null, removeAttribute() {},
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
    removeEventListener: () => {},
    dispatch(type, event = {}) { return (listeners[type] || []).map(fn => fn({ target: this, ...event })); },
    focus() {}, querySelector: () => null, querySelectorAll: () => [],
    appendChild: () => {}, remove: () => {}, closest: () => null
  };
}

test('5: Suunnan viikkorivi kertoo epäonnistuneet ja "Yritä uudelleen" lähettää ne', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: new Date(2026, 8, 23, 12, 0).getTime() });
  const elements = new Map();
  globalThis.document = {
    activeElement: null,
    getElementById(id) {
      if (!HTML_IDS.has(id)) return null;
      if (!elements.has(id)) elements.set(id, stubElement(id));
      return elements.get(id);
    },
    createElement: () => stubElement(null),
    querySelectorAll: () => [],
    body: { appendChild: () => {} }
  };
  globalThis.CSS = { escape: value => String(value) };
  resetDirectionView();

  const db = database();
  let broken = true;
  setTimeEntryWriterForTests(writerFor(db.repo({ errorFor: () => (broken ? { code: '42804', message: 'x' } : null) })));
  const bad = entry('ui-1');
  saveOutbox(USER_A.id, [bad]);
  setTimeEntries([bad]);
  for (let round = 0; round < MAX_FLUSH_ATTEMPTS; round += 1) await flushTimeOutbox({ now: round * 1_000_000 });

  initDirection();
  renderDirection();
  const summary = document.getElementById('dirWeekSummary');
  assert.match(summary.innerHTML, /1 kirjaus ei mennyt palvelimelle/);
  assert.match(summary.innerHTML, /data-time-failed="retry"/);
  assert.match(summary.innerHTML, /data-time-failed="discard"/);
  assert.doesNotMatch(summary.innerHTML, /odottaa yhteyttä/, 'epäonnistunut ei odota yhteyttä');
  assert.match(document.getElementById('dirTimeList').innerHTML, /Lähetys epäonnistui/);

  broken = false;
  const button = { dataset: { timeFailed: 'retry' }, disabled: false };
  await Promise.all(summary.dispatch('click', { target: { closest: () => button } }));
  assert.ok(db.rows.has('ui-1'), '"Yritä uudelleen" ei lähettänyt');
  assert.doesNotMatch(summary.innerHTML, /ei mennyt palvelimelle/);
  resetDirectionView();
});

// ============================================================ 6. poisto kesken lähetyksen

test('6 KRIITTINEN: kesken lähetyksen poistettua kirjausta ei lähetetä (kori luetaan ennen jokaista)', async () => {
  const g = gate();
  const db = database();
  const repo = db.repo();
  const slowFirst = { ...repo, calls: repo.calls, async insert(e) { if (e.id === 'e1') await g.promise; return repo.insert(e); } };
  const writer = writerFor(slowFirst);
  saveOutbox(USER_A.id, [entry('e1'), entry('e2')]);
  const flushing = writer.flush();
  // e1 on matkalla; käyttäjä poistaa e2:n (deleteTimeEntry -> forget).
  writer.forget(entry('e2'));
  g.release();
  const result = await flushing;
  assert.deepEqual(repo.calls, ['log:e1'], 'poistettu kirjaus lähetettiin');
  assert.deepEqual([...db.rows.keys()], ['e1']);
  assert.deepEqual(result.sentEntries.map(e => e.id), ['e1']);
  assert.deepEqual(loadOutbox(USER_A.id), []);
});

test('6 KRIITTINEN: deleteTimeEntry saman lähetyksen aikana -> ei kantaan eikä takaisin tilaan', async () => {
  const g = gate();
  const db = database();
  const repo = db.repo();
  setTimeEntryWriterForTests(writerFor({ ...repo, async insert(e) { if (e.id === 'd1') await g.promise; return repo.insert(e); } }));
  stubRemove(db);
  const first = entry('d1');
  const second = entry('d2');
  saveOutbox(USER_A.id, [first, second]);
  setTimeEntries([first, second]);
  const mark = beginDataLoad();
  const flushing = flushTimeOutbox();
  const deleting = deleteTimeEntry('d2');
  g.release();
  await flushing;
  assert.equal(await deleting, true);
  assert.deepEqual([...db.rows.keys()], ['d1'], 'poistettu kirjaus palasi kantaan');
  setTimeEntries([]);                         // lataus, joka haettiin ennen lähetystä
  keepWritesSince(mark);
  assert.deepEqual(getState().timeEntries.map(e => e.id), ['d1'], 'poistettu kirjaus palasi tilaan');
});

test('6: poisto, joka osuu jo lähteneeseen lähetykseen, odottaa sen ja poistaa rivin kannasta', async () => {
  const g = gate();
  const db = database();
  const repo = db.repo();
  setTimeEntryWriterForTests(writerFor({ ...repo, async insert(e) { await g.promise; return repo.insert(e); } }));
  stubRemove(db);
  const only = entry('inflight');
  saveOutbox(USER_A.id, [only]);
  setTimeEntries([only]);
  const mark = beginDataLoad();
  const flushing = flushTimeOutbox();
  const deleting = deleteTimeEntry('inflight');
  g.release();
  await flushing;
  assert.equal(await deleting, true);
  assert.equal(db.rows.size, 0, 'lähetyksen jälkeen jäi rivi kantaan');
  setTimeEntries([]);
  keepWritesSince(mark);
  assert.deepEqual(getState().timeEntries, []);
});

test('6 KRIITTINEN: lähetys ottaa kirjauksen matkaan juuri ennen poistoa -> poisto odottaa sen ennen kannan poistoa', async () => {
  const first = gate();
  const second = gate();
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  const db = database();
  const repo = db.repo();
  const real = writerFor({
    ...repo,
    async insert(e) {
      if (e.id === 'r1') await first.promise;
      if (e.id === 'r2') { markStarted(); await second.promise; }
      return repo.insert(e);
    }
  });
  let checks = 0;
  setTimeEntryWriterForTests({
    ...real,
    async settled(operationId) {
      if (operationId !== 'log:r2') return real.settled(operationId);
      checks += 1;
      // Ensimmäisellä tarkistuksella r2 ei ollut vielä matkalla; heti sen
      // jälkeen lähetys ottaa sen (e1 valmistuu), ennen kuin poisto ehtii unohtaa sen.
      if (checks === 1) { first.release(); await started; return undefined; }
      second.release();
      return real.settled(operationId);
    }
  });
  const original = timeEntriesRepo.remove;
  timeEntriesRepo.remove = async id => { second.release(); db.rows.delete(id); return { ok: true, value: { id } }; };
  restores.push(() => { timeEntriesRepo.remove = original; });
  saveOutbox(USER_A.id, [entry('r1'), entry('r2')]);
  setTimeEntries([entry('r1'), entry('r2')]);
  const mark = beginDataLoad();
  const flushing = flushTimeOutbox();
  assert.equal(await deleteTimeEntry('r2'), true);
  await flushing;
  assert.deepEqual([...db.rows.keys()], ['r1'], 'myöhästynyt INSERT herätti poistetun rivin');
  // Lähetys ei raportoi poistettua lähetetyksi: vanhentunut lataus ei tuo sitä takaisin.
  setTimeEntries([]);
  keepWritesSince(mark);
  assert.deepEqual(getState().timeEntries.map(e => e.id), ['r1'], 'poistettu kirjaus palasi tilaan');
});

// ============================================================ 7. toinen välilehti

test('7: 23505 pääavaimelle = sama kirjaus; operaation avaimelle = kaksoiskappale', () => {
  assert.equal(isSameEntryDuplicate({ cause: { code: '23505', message: 'duplicate key value violates unique constraint "time_entries_pkey"' } }), true);
  assert.equal(isSameEntryDuplicate({ cause: { code: '23505', details: 'Key (id)=(x) already exists.' } }), true);
  assert.equal(isSameEntryDuplicate({ cause: { code: '23505', message: 'duplicate key value violates unique constraint "time_entries_operation_unique"' } }), false);
  assert.equal(isSameEntryDuplicate({ cause: { code: '23505' } }), false, 'tuntematon rajoite: varovasti kaksoiskappale');
  assert.equal(isSameEntryDuplicate({ cause: { code: '23503', message: 'x_pkey' } }), false);
});

test('7 KRIITTINEN: toisen välilehden lähetys ehtii ensin -> oma lisäys on onnistuminen, ei kaksoiskappale', async () => {
  const g = gate();
  const db = database();
  const tabA = writerFor(db.repo({ wait: g.promise }));
  const tabB = writerFor(db.repo());
  const pending = tabA.insert(entry('x1'));
  assert.deepEqual(loadOutbox(USER_A.id).map(e => e.id), ['x1'], 'ennakkokirjaus näkyy molemmille välilehdille');
  const flushed = await tabB.flush();
  assert.equal(flushed.sent, 1, 'välilehti B lähetti A:n kirjauksen');
  g.release();
  assert.deepEqual(await pending, { ok: true });
  assert.equal(db.rows.size, 1);
  assert.deepEqual(loadOutbox(USER_A.id), []);
});

test('7 KRIITTINEN: logTime ei poista juuri kirjattua eikä sano "jo kirjattu", kun toinen välilehti lähetti sen', async (t) => {
  const toasts = captureToasts(t);
  const g = gate();
  const db = database();
  setTimeEntryWriterForTests(writerFor(db.repo({ wait: g.promise })));
  const tabB = writerFor(db.repo());
  const mark = beginDataLoad();
  const logging = logTime({ entryDate: DAY, minutes: 35, operationId: 'log:two-tabs' });
  await tabB.flush();
  g.release();
  const result = await logging;
  assert.equal(result.ok, true);
  assert.equal(result.duplicate, undefined, 'oma kirjaus luultiin toisen operaation kaksoiskappaleeksi');
  assert.deepEqual(getState().timeEntries.map(e => e.operationId), ['log:two-tabs'], 'kirjaus katosi tilasta');
  assert.equal(toasts.some(node => /on jo kirjattu/.test(node.textContent)), false);
  // Rivi säilyy myös latauksen yli (lista haettiin ennen kirjausta).
  setTimeEntries([]);
  keepWritesSince(mark);
  assert.deepEqual(getState().timeEntries.map(e => e.operationId), ['log:two-tabs']);
});

test('7: sama operaatio toisella tunnisteella on yhä kaksoiskappale', async () => {
  const db = database();
  db.rows.set('other-id', entry('other-id', { operationId: 'routine:r1:2026-09-21' }));
  const writer = writerFor(db.repo());
  const result = await writer.insert(entry('mine', { operationId: 'routine:r1:2026-09-21' }));
  assert.deepEqual(result, { ok: true, duplicate: true });
  assert.deepEqual([...db.rows.keys()], ['other-id']);
});
