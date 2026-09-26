// Aikakirjausten lähtökori: ennakkokirjaus, omistaja, poisto, lähetysten
// limitys ja uusinta (audit: offline-timer F5, F9, F10, F11, F12, F16, F17;
// races RACE-07, RACE-08).
//
// Portti voi olla kiinni: kanta- ja offline-polku ajetaan oikealla
// koodilla tekorepositoriota vasten (setTimeEntryWriterForTests). Kirjoittaja
// rakennetaan kuten alignment.js sen rakentaa: käyttäjä luetaan istunnosta.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { setUser, clearUser, getUser, sessionSnapshot, isSameSession } from '../src/data/session.js';
import { setClient } from '../src/data/client.js';
import { fakeClient } from './helpers/gates.mjs';
import { resetState, getState, setTimeEntries } from '../src/app/state.js';
import { clearLocalUserData, withPendingTimeEntries } from '../src/app/actions.js';
import {
  logTime, deleteTimeEntry, flushTimeOutbox, retryTimeOutbox, pendingTimeEntryCount,
  pendingTimeEntryOperations, setTimeEntryWriterForTests, beginDataLoad, keepWritesSince,
  resetTimeEntrySync, resetAppliedAdjustments
} from '../src/app/alignment.js';
import { createTimeEntryWriter } from '../src/app/timeEntryWriter.js';
import { timeEntriesRepo } from '../src/data/collectionsRepo.js';
import { loadOutbox, saveOutbox, resetTimerStoreForTests } from '../src/data/timerStore.js';
import { loadQueueText, saveQueueText, resetQueueStoreForTests } from '../src/data/offlineQueueStore.js';
import { normalizeTimeEntry } from '../src/domain/timeEntry.js';

const USER_A = { id: 'aaaaaaaa-5151-4151-8151-00000000000a', email: 'a@example.com' };
const USER_B = { id: 'bbbbbbbb-5252-4252-8252-00000000000b', email: 'b@example.com' };
const DAY = '2026-09-21';

function installStorage({ failWrites = () => false } = {}) {
  const data = new Map();
  globalThis.localStorage = {
    getItem: key => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => {
      if (failWrites()) throw new Error('QuotaExceededError');
      data.set(key, String(value));
    },
    removeItem: key => { data.delete(key); },
    key: index => [...data.keys()][index] ?? null,
    get length() { return data.size; }
  };
  return data;
}

function gate() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
}

/**
 * Tekorepositorio. Jokainen insert kuluttaa yhden askeleen:
 * 'ok' | 'network' | 'reject' | { wait: Promise, then: askel }.
 */
function scriptedRepo(steps = []) {
  const rows = new Map();
  const calls = [];
  const outcome = async (step, entry) => {
    if (step && typeof step === 'object') {
      await step.wait;
      return outcome(step.then || 'ok', entry);
    }
    if (step === 'network') return { ok: false, error: { cause: { message: 'Failed to fetch' } } };
    if (step === 'reject') return { ok: false, error: { cause: { code: '23514', message: 'check' } } };
    if ([...rows.values()].some(row => row.operationId === entry.operationId)) {
      return { ok: false, error: { cause: { code: '23505' } } };
    }
    rows.set(entry.id, entry);
    return { ok: true, value: entry };
  };
  return {
    rows, calls,
    isPersistent: () => true,
    async insert(entry) {
      calls.push(entry.operationId);
      return outcome(steps.shift() || 'ok', entry);
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

/** Kannan poisto tekorepositorion riveistä (deleteTimeEntry kutsuu timeEntriesRepo.remove). */
function stubRemove(repo, { fails = false } = {}) {
  const original = timeEntriesRepo.remove;
  const removed = [];
  timeEntriesRepo.remove = async id => {
    removed.push({ id, existed: repo.rows.has(id) });
    if (fails) return { ok: false, error: { message: 'Poisto ei onnistunut.', cause: { message: 'Failed to fetch' } } };
    repo.rows.delete(id);
    return { ok: true, value: { id } };
  };
  return { removed, restore: () => { timeEntriesRepo.remove = original; } };
}

let restoreRemove = () => {};

beforeEach(() => {
  clearUser();
  clearLocalUserData();
  resetState();
  resetTimerStoreForTests();
  resetQueueStoreForTests();
  resetTimeEntrySync();
  resetAppliedAdjustments();
  installStorage();
  setTimeEntryWriterForTests(null);
  setUser(USER_A);
  setClient(fakeClient({ data: [], error: null }));
});

afterEach(() => {
  restoreRemove();
  restoreRemove = () => {};
  setTimeEntryWriterForTests(null);
  delete globalThis.localStorage;
});

// ============================================================ F10 ennakkokirjaus

test('F10 KRIITTINEN: kirjaus on lähtökorissa koko lähetyksen ajan, eikä samaan aikaan valmistuva lataus piilota sitä', async () => {
  const g = gate();
  const repo = scriptedRepo([{ wait: g.promise, then: 'ok' }]);
  setTimeEntryWriterForTests(writerFor(repo));
  const pending = logTime({ entryDate: DAY, minutes: 25, operationId: 'log:wa-1' });
  assert.deepEqual(loadOutbox(USER_A.id).map(e => e.operationId), ['log:wa-1'], 'ei ennakkokirjausta');
  assert.equal(pendingTimeEntryCount(), 0, 'oma kesken oleva lähetys ei "odota yhteyttä"');
  assert.equal(pendingTimeEntryOperations().has('log:wa-1'), false);
  // Lataus, jonka palvelinlista haettiin ennen INSERTiä, korvaa tilan.
  setTimeEntries(withPendingTimeEntries([], { persistent: true, userId: USER_A.id }));
  assert.deepEqual(getState().timeEntries.map(e => e.operationId), ['log:wa-1'], 'kirjaus katosi näkyvistä');
  g.release();
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(result.queued, undefined);
  assert.deepEqual(loadOutbox(USER_A.id), [], 'onnistunut lähetys poistuu korista');
  assert.equal(repo.rows.size, 1);
});

test('F10: sovellus suljetaan kesken lähetyksen -> kirjaus lähtee seuraavalla kerralla eikä monistu', async () => {
  const stalled = scriptedRepo([{ wait: new Promise(() => {}) }]);
  setTimeEntryWriterForTests(writerFor(stalled));
  logTime({ entryDate: DAY, minutes: 40, operationId: 'log:kill-1' });
  assert.equal(loadOutbox(USER_A.id).length, 1, 'jumittunut kirjaus oli vain muistissa');
  // "Uudelleenkäynnistys": uusi kirjoittaja. Kanta ehti saada rivin ennen katkoa.
  const restarted = scriptedRepo([]);
  restarted.rows.set('committed', { id: 'committed', operationId: 'log:kill-1' });
  setTimeEntryWriterForTests(writerFor(restarted));
  assert.deepEqual(await flushTimeOutbox(), { sent: 1, left: 0 });
  assert.equal(restarted.rows.size, 1, '23505 = jo perillä, ei kaksoiskappaletta');
  assert.deepEqual(loadOutbox(USER_A.id), []);
});

test('F10: hylätty kirjaus (ei verkkovirhe) ei jää ennakkokirjauksena koriin', async () => {
  setTimeEntryWriterForTests(writerFor(scriptedRepo(['reject'])));
  const result = await logTime({ entryDate: DAY, minutes: 5, operationId: 'log:rej-1' }, { silent: true });
  assert.equal(result.ok, false);
  assert.deepEqual(loadOutbox(USER_A.id), []);
  assert.equal(getState().timeEntries.length, 0);
});

// ============================================================ F5 / RACE-08 omistaja

test('F5 KRIITTINEN: käyttäjä vaihtuu kesken epäonnistuvan lähetyksen -> kirjaus jää tekijänsä koriin', async () => {
  const g = gate();
  setTimeEntryWriterForTests(writerFor(scriptedRepo([{ wait: g.promise, then: 'network' }])));
  const pending = logTime({ entryDate: DAY, minutes: 30, note: 'A:n yksityinen muistiinpano', operationId: 'log:f5-1' });
  clearUser();
  resetState();
  setUser(USER_B);
  g.release();
  const result = await pending;
  assert.equal(result.sessionChanged, true);
  assert.deepEqual(loadOutbox(USER_A.id).map(e => e.note), ['A:n yksityinen muistiinpano']);
  assert.deepEqual(loadOutbox(USER_B.id), [], 'A:n kirjaus päätyi B:n koriin');
  assert.equal(getState().timeEntries.length, 0, 'B:n tila sai A:n kirjauksen');
  assert.equal(pendingTimeEntryCount(), 0, 'B:lle ei näy A:n odottavaa kirjausta');
});

test('F5: kirjoittaja jonottaa sen käyttäjän koriin, joka kirjauksen teki (ei vastaushetken käyttäjän)', async () => {
  const g = gate();
  let current = USER_A.id;
  const writer = createTimeEntryWriter({
    repo: scriptedRepo([{ wait: g.promise, then: 'network' }]), loadOutbox, saveOutbox, userId: () => current
  });
  const pending = writer.insert(entry('owner-1'));
  current = USER_B.id;
  g.release();
  assert.equal((await pending).queued, true);
  assert.deepEqual(loadOutbox(USER_A.id).map(e => e.id), ['owner-1']);
  assert.deepEqual(loadOutbox(USER_B.id), []);
});

// ============================================================ F9 / RACE-07 poisto

test('F9 KRIITTINEN: jonossa olevan kirjauksen poisto poistaa sen myös korista (ei herää henkiin)', async () => {
  const repo = scriptedRepo(['network']);
  setTimeEntryWriterForTests(writerFor(repo));
  const stub = stubRemove(repo);
  restoreRemove = stub.restore;
  const queued = await logTime({ entryDate: DAY, minutes: 25, operationId: 'log:f9-1' }, { silent: true });
  assert.equal(queued.queued, true);
  assert.equal(await deleteTimeEntry(queued.entry.id), true);
  assert.deepEqual(loadOutbox(USER_A.id), [], 'poistettu jäi koriin');
  assert.deepEqual(await flushTimeOutbox(), { sent: 0, left: 0 });
  assert.equal(repo.rows.size, 0, 'seuraava lähetys lisäsi poistetun takaisin');
});

test('RACE-07: poisto kesken tallennuksen odottaa sen loppuun — kannasta ei jää riviä', async () => {
  const g = gate();
  const repo = scriptedRepo([{ wait: g.promise, then: 'ok' }]);
  setTimeEntryWriterForTests(writerFor(repo));
  const stub = stubRemove(repo);
  restoreRemove = stub.restore;
  const logging = logTime({ entryDate: DAY, minutes: 15, operationId: 'log:inflight-1' });
  const id = getState().timeEntries[0].id;
  const deleting = deleteTimeEntry(id);
  assert.equal(getState().timeEntries.length, 0, 'poisto näkyy heti');
  assert.equal(stub.removed.length, 0, 'poisto ei saa ohittaa kesken olevaa INSERTiä');
  g.release();
  await logging;
  assert.equal(await deleting, true);
  assert.deepEqual(stub.removed, [{ id, existed: true }]);
  assert.equal(repo.rows.size, 0);
  assert.deepEqual(loadOutbox(USER_A.id), []);
  assert.equal(getState().timeEntries.length, 0);
});

test('RACE-07: poisto kesken korin lähetyksen odottaa lähetyksen, eikä lähetys palauta kirjausta koriin', async () => {
  const g = gate();
  const repo = scriptedRepo([{ wait: g.promise, then: 'ok' }]);
  setTimeEntryWriterForTests(writerFor(repo));
  const stub = stubRemove(repo);
  restoreRemove = stub.restore;
  const queued = entry('flush-del');
  saveOutbox(USER_A.id, [queued]);
  setTimeEntries([queued]);
  const flushing = flushTimeOutbox();
  const deleting = deleteTimeEntry(queued.id);
  g.release();
  await flushing;
  assert.equal(await deleting, true);
  assert.equal(repo.rows.size, 0, 'lähetetty ja poistettu rivi jäi kantaan');
  assert.deepEqual(loadOutbox(USER_A.id), []);
});

test('RACE-07: epäonnistunut poisto palauttaa kirjauksen tilaan ja koriin', async () => {
  const repo = scriptedRepo(['network']);
  setTimeEntryWriterForTests(writerFor(repo));
  const stub = stubRemove(repo, { fails: true });
  restoreRemove = stub.restore;
  const queued = await logTime({ entryDate: DAY, minutes: 25, operationId: 'log:f9-fail' }, { silent: true });
  assert.equal(await deleteTimeEntry(queued.entry.id), false);
  assert.deepEqual(loadOutbox(USER_A.id).map(e => e.operationId), ['log:f9-fail']);
  assert.deepEqual(getState().timeEntries.map(e => e.operationId), ['log:f9-fail']);
});

test('näkymä: korissa odottavat kirjaukset tunnistetaan', async () => {
  setTimeEntryWriterForTests(writerFor(scriptedRepo(['network'])));
  await logTime({ entryDate: DAY, minutes: 10, operationId: 'log:marker-1' }, { silent: true });
  assert.ok(pendingTimeEntryOperations().has('log:marker-1'));
});

// ============================================================ F11 lähetys ja lataus

test('F11: rinnakkaiset lähetykset (kirjautuminen + palautuminen) lähettävät kunkin kirjauksen kerran', async () => {
  const g = gate();
  const repo = scriptedRepo([{ wait: g.promise, then: 'ok' }, 'ok']);
  setTimeEntryWriterForTests(writerFor(repo));
  saveOutbox(USER_A.id, [entry('a'), entry('b')]);
  const first = flushTimeOutbox();
  const second = flushTimeOutbox();
  assert.equal(first, second, 'toinen kutsu saa käynnissä olevan lähetyksen');
  g.release();
  assert.deepEqual(await first, { sent: 2, left: 0 });
  assert.deepEqual(repo.calls, ['log:a', 'log:b']);
});

test('F11 KRIITTINEN: ennen lähetystä haettu lista ei piilota juuri lähetettyä kirjausta', async () => {
  const repo = scriptedRepo([]);
  setTimeEntryWriterForTests(writerFor(repo));
  const queued = entry('stale-1');
  saveOutbox(USER_A.id, [queued]);
  setTimeEntries([queued]);
  const mark = beginDataLoad();            // lataus lähtee: palvelimen lista = []
  assert.deepEqual(await flushTimeOutbox(), { sent: 1, left: 0 });
  setTimeEntries(withPendingTimeEntries([], { persistent: true, userId: USER_A.id })); // vanhentunut tulos
  assert.equal(getState().timeEntries.length, 0, 'lähtötilanne: vanhentunut lista piilottaa kirjauksen');
  keepWritesSince(mark);
  assert.deepEqual(getState().timeEntries.map(e => e.id), ['stale-1']);
  // Lähetyksen JÄLKEEN alkanut lataus näkee rivin kannassa: mitään ei lisätä.
  const later = beginDataLoad();
  setTimeEntries([]);
  keepWritesSince(later);
  assert.equal(getState().timeEntries.length, 0);
});

test('F11: suora kirjaus latauksen aikana säilyy, eikä toisen käyttäjän tallennus palaa', async () => {
  setTimeEntryWriterForTests(writerFor(scriptedRepo([])));
  const mark = beginDataLoad();
  const logged = await logTime({ entryDate: DAY, minutes: 10, operationId: 'log:during-load' });
  setTimeEntries([]);
  keepWritesSince(mark);
  assert.deepEqual(getState().timeEntries.map(e => e.id), [logged.entry.id]);
  // Uloskirjautuminen nollaa muistin; B ei saa A:n kirjausta.
  resetTimeEntrySync();
  clearUser();
  resetState();
  setUser(USER_B);
  keepWritesSince(mark);
  assert.equal(getState().timeEntries.length, 0);
});

test('F11: poistettu kirjaus ei palaa vanhentuneesta latauksesta', async () => {
  const repo = scriptedRepo([]);
  setTimeEntryWriterForTests(writerFor(repo));
  const stub = stubRemove(repo);
  restoreRemove = stub.restore;
  const mark = beginDataLoad();
  const logged = await logTime({ entryDate: DAY, minutes: 10, operationId: 'log:deleted-later' });
  await deleteTimeEntry(logged.entry.id);
  keepWritesSince(mark);
  assert.equal(getState().timeEntries.length, 0);
});

// ============================================================ F16 ajastettu uusinta

test('F16: ajastettu uusinta harventaa epäonnistuneen jälkeen eikä tee mitään tyhjällä korilla', async () => {
  const repo = scriptedRepo(['network', 'network', 'ok']);
  setTimeEntryWriterForTests(writerFor(repo));
  assert.equal((await retryTimeOutbox({ now: 0 })).skipped, 'empty');
  assert.equal(repo.calls.length, 0);

  saveOutbox(USER_A.id, [entry('retry-1')]);
  assert.deepEqual(await retryTimeOutbox({ now: 0 }), { sent: 0, left: 1 });
  assert.equal((await retryTimeOutbox({ now: 29_000 })).skipped, 'backoff');
  assert.equal(repo.calls.length, 1);
  await retryTimeOutbox({ now: 30_000 });          // toinen epäonnistuminen: väli kaksinkertaistuu
  assert.equal((await retryTimeOutbox({ now: 89_000 })).skipped, 'backoff');
  assert.deepEqual(await retryTimeOutbox({ now: 90_000 }), { sent: 1, left: 0 });
  assert.equal(repo.calls.length, 3);
  assert.deepEqual(loadOutbox(USER_A.id), []);
});

// ============================================================ F17 kaksoiskappale näkyviin

test('F17: saman operaation kirjaus toisesta näkymästä on kaksoiskappale, ja käyttäjälle kerrotaan', async (t) => {
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
  try {
    const repo = scriptedRepo([]);
    setTimeEntryWriterForTests(writerFor(repo));
    // Sama rutiinin kerta on jo korissa toisella tunnisteella (esim. toinen näkymä, vanha tila).
    saveOutbox(USER_A.id, [entry('earlier', { operationId: 'routine:r1:2026-09-21' })]);
    const result = await logTime({ entryDate: DAY, minutes: 30, operationId: 'routine:r1:2026-09-21' });
    assert.equal(result.duplicate, true);
    assert.equal(repo.calls.length, 0, 'jo korissa olevaa operaatiota ei lähetetä toiseen kertaan');
    assert.deepEqual(loadOutbox(USER_A.id).map(e => e.id), ['earlier'], 'korissa on yhä vain alkuperäinen');
    assert.ok(toasts.some(node => /on jo kirjattu/.test(node.textContent)), 'kaksoiskappale katosi hiljaa');
  } finally {
    delete globalThis.document;
  }
});

// ============================================================ F12 jonon muistikopio

test('F12: tehtäväjonon muistikopio luetaan ensin, kun tallennus ei mennyt localStorageen', () => {
  let failing = false;
  installStorage({ failWrites: () => failing });
  assert.deepEqual(saveQueueText(USER_A.id, 'v1'), { ok: true, persistent: true });
  failing = true;
  assert.deepEqual(saveQueueText(USER_A.id, 'v2'), { ok: true, persistent: false });
  assert.equal(loadQueueText(USER_A.id), 'v2', 'luettiin vanhempi jono localStoragesta');
  failing = false;
  assert.deepEqual(saveQueueText(USER_A.id, 'v3'), { ok: true, persistent: true });
  assert.equal(loadQueueText(USER_A.id), 'v3', 'onnistunut tallennus korvaa muistikopion');
  assert.equal(loadQueueText(USER_B.id), null);
});
