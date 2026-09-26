// Suunta: ajastimen kilpatilanteet, henkiin herääminen, välilehdet ja
// istunnon vaihto (auditointi: races RACE-01..RACE-11, offline-timer
// F1/F2/F4/F5/F8/F12/F13, account-lifecycle F7).
//
// Jokainen testi toistaa löydetyn kilpatilanteen OIKEALLA koodilla
// tekokantaa vastaan: pysyvä tekorepositorio pitää rivit tallessa, ja
// portilla (gate) pidätetty lupaus päättää, missä järjestyksessä
// vastaukset palaavat. Kello annetaan aina eksplisiittisenä.
//
// Testit eivät riipu porttien tilasta (schema.js): ajastin- ja
// kirjausrepositoriot korvataan tekokannoilla, joten sama testi pätee sekä
// suljetuilla (tämä haara) että avatuilla (aalto J) porteilla.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { read } from './helpers/sources.mjs';
import { setUser, clearUser, getUser, sessionSnapshot, isSameSession } from '../src/data/session.js';
import { setClient } from '../src/data/client.js';
import { fakeClient } from './helpers/gates.mjs';
import {
  resetState, getState, setTasks, setTimeEntries, setRunningTimerInState, setDomainLoadStatus
} from '../src/app/state.js';
import { clearLocalUserData } from '../src/app/actions.js';
import {
  startTracking, pauseTracking, resumeTracking, stopTracking, cancelTracking, currentTimer,
  setTimerRepoForTests, describeTarget, targetOfTimer, pendingTimer, stopPendingTracking,
  discardPendingTracking
} from '../src/app/timeTracking.js';
import {
  restoreLocalTimer, adoptLoadedTimers, timerMutationSeq, initTimerCrossTabSync, stopTimerCrossTabSync
} from '../src/app/timerState.js';
import { logTime, setTimeEntryWriterForTests, flushTimeOutbox } from '../src/app/alignment.js';
import { createTimeEntryWriter } from '../src/app/timeEntryWriter.js';
import { stopAndLog, renderTimerBar } from '../src/app/views/timeLog.js';
import {
  loadTimer, loadTimerRecord, saveTimer, loadOutbox, saveOutbox, purgeTimerData, timerKey, outboxKey,
  tombstoneKey, resetTimerStoreForTests, loadTombstones, addTombstone, loadPendingTimers
} from '../src/data/timerStore.js';
import { runningTimersRepo, timeEntriesRepo } from '../src/data/collectionsRepo.js';
import { normalizeTask } from '../src/domain/task.js';
import { OPERATION } from '../src/domain/timeEntry.js';

const USER_A = { id: 'aaaaaaaa-1111-4111-8111-00000000000a', email: 'a@example.com' };
const USER_B = { id: 'bbbbbbbb-2222-4222-8222-00000000000b', email: 'b@example.com' };
const MIN = 60 * 1000;
const T0 = Date.UTC(2026, 8, 21, 7, 0); // ma 21.9.2026 klo 10 Helsinki
const iso = ms => new Date(ms).toISOString();
const NETWORK = Object.freeze({ ok: false, error: { cause: { message: 'Failed to fetch' } } });
const UNIQUE = Object.freeze({ ok: false, error: { cause: { code: '23505' } } });

function installStorage({ setThrows = false } = {}) {
  const data = new Map();
  globalThis.localStorage = {
    getItem: key => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => {
      if (setThrows) {
        const error = new Error('QuotaExceededError');
        error.name = 'QuotaExceededError';
        throw error;
      }
      data.set(key, String(value));
    },
    removeItem: key => { data.delete(key); },
    key: index => [...data.keys()][index] ?? null,
    get length() { return data.size; }
  };
  return data;
}

beforeEach(() => {
  clearUser();
  clearLocalUserData();
  resetState();
  resetTimerStoreForTests();
  installStorage();
  setTimerRepoForTests(null);
  setTimeEntryWriterForTests(null);
  stopTimerCrossTabSync();
  setUser(USER_A);
  setClient(fakeClient({ data: [], error: null }));
});

afterEach(() => {
  delete globalThis.localStorage;
  delete globalThis.document;
});

/** Portti: lupaus, jonka testi vapauttaa haluamallaan hetkellä. */
function gate() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
}

/** Anna jonossa odottaville lupauksille aikaa edetä. */
async function settle(rounds = 5) {
  for (let i = 0; i < rounds; i += 1) await new Promise(resolve => setImmediate(resolve));
}

/**
 * Tekokanta running_timers-taululle: YKSI rivi käyttäjää kohti (kuten
 * running_timers_one_per_user), kutsujen järjestys talteen.
 */
function timerDb({ removeFails = false } = {}) {
  const rows = new Map();
  const calls = [];
  return {
    rows, calls, removeFails, updateFails: false, insertError: null,
    insertGate: null, updateGates: [], removeGate: null,
    isPersistent: () => true,
    async insert(timer) {
      calls.push(['insert', timer.id]);
      if (this.insertGate) await this.insertGate;
      if (this.insertError) return this.insertError;
      if (rows.size > 0) return UNIQUE;
      rows.set(timer.id, { ...timer });
      return { ok: true, value: timer };
    },
    async update(timer) {
      calls.push(['update', timer.id]);
      const wait = this.updateGates.shift();
      if (wait) await wait;
      if (this.updateFails) return NETWORK;
      if (rows.has(timer.id)) rows.set(timer.id, { ...timer });
      return { ok: true };
    },
    async remove(id) {
      calls.push(['remove', id]);
      if (this.removeGate) await this.removeGate;
      if (this.removeFails) return NETWORK;
      rows.delete(id);
      return { ok: true };
    },
    async list() {
      return { ok: true, value: [...rows.values()] };
    }
  };
}

/** Tekokanta time_entries-taululle: operaation uniikkius, käsikirjoitettavat virheet. */
function entryDb(script = []) {
  const rows = new Map();
  const calls = [];
  return {
    rows, calls, gates: [],
    isPersistent: () => true,
    async insert(entry) {
      calls.push(entry.operationId);
      const wait = this.gates.shift();
      if (wait) await wait;
      const step = script.shift() || 'ok';
      if (typeof step === 'object') return { ok: false, error: { cause: step } };
      if (step === 'network') return NETWORK;
      if ([...rows.values()].some(row => row.operationId === entry.operationId)) return UNIQUE;
      rows.set(entry.id, entry);
      return { ok: true, value: entry };
    }
  };
}

function useEntryDb(repo, userId = () => USER_A.id) {
  setTimeEntryWriterForTests(createTimeEntryWriter({
    repo, loadOutbox, saveOutbox, userId, snapshot: sessionSnapshot, isSameSession
  }));
}

function switchTo(user) {
  clearUser();
  resetState();
  setUser(user);
}

/**
 * Pienin DOM, jolla ajastinpalkki ja ilmoitukset (toast) piirtyvät.
 * Ilmoitusten tekstit talteen `toasts`-listaan.
 */
function installBarDom(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] }); // ilmoitusten ajastimet eivät pidä prosessia auki
  const bar = { hidden: true, innerHTML: '', classList: { toggle() {} } };
  const toasts = [];
  const node = () => ({
    className: '', textContent: '', classList: { add() {} },
    setAttribute() {}, addEventListener() {}, remove() {},
    appendChild(child) { toasts.push(child.textContent); }
  });
  const host = node();
  globalThis.document = {
    getElementById: id => (id === 'timerBar' ? bar : id === 'toastHost' ? host : null),
    createElement: () => node(),
    body: { appendChild() {} }
  };
  return { bar, toasts };
}

function eventTarget() {
  const listeners = new Map();
  return {
    listeners,
    addEventListener(type, fn) { (listeners.get(type) || listeners.set(type, new Set()).get(type)).add(fn); },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    dispatch(type, event) { for (const fn of listeners.get(type) || []) fn(event); },
    count(type) { return listeners.get(type)?.size || 0; }
  };
}

const task = (id, extra = {}) => normalizeTask({ id, title: 'Tehtävä ' + id, date: '2026-09-21', durationMinutes: 45, ...extra });

// ================================================== RACE-01 / offline F4

// Vain palvelimen HYLKÄYS (23514) jättää osan tallentamatta. Palvelinvirhe
// (503) on ohimenevä: osa jää lähtökoriin ja lähtee myöhemmin (ks. testi alla).
for (const [name, cause] of [['hylkäys 23514', { code: '23514', message: 'check' }]]) {
  test(`RACE-01: toisen osan ${name} -> uusinta kirjaa VAIN puuttuvan osan, ajastin poistuu vasta kun kaikki on tallessa`, async () => {
    const db = entryDb(['ok', cause]);
    useEntryDb(db);
    const start = new Date(2026, 8, 20, 23, 30).getTime(); // su 23.30
    await startTracking({ kind: 'none' }, { now: start });
    const op = OPERATION.timer(currentTimer().id);

    const first = await stopTracking({ now: start + 75 * MIN }); // 30 + 45 min
    assert.equal(first.ok, false);
    assert.ok(currentTimer(), 'ajastin jää uusintaa varten');
    assert.equal(loadTimer(USER_A.id).stopAtMs, start + 75 * MIN, 'pysäytyshetki on tallessa laitteella');
    assert.deepEqual(loadTimer(USER_A.id).loggedOperationIds, [op], 'tallennettu osa muistetaan');

    // Uusinta myöhemmin: suunnitelma ratkaisee, ei uusintahetki.
    const retry = await stopTracking({ now: start + 200 * MIN });
    assert.equal(retry.ok, true);
    assert.equal(retry.duplicate, undefined, 'uusinta ei ole "jo pysäytetty"');
    assert.equal(retry.totalMinutes, 75);
    const rows = [...db.rows.values()];
    assert.deepEqual(rows.map(row => row.minutes).sort((a, b) => a - b), [30, 45], '75 min, ei hukkaa');
    assert.deepEqual(rows.map(row => row.operationId).sort(), [op, `${op}.1`], 'yksi rivi per operaatio');
    assert.deepEqual(db.calls, [op, `${op}.1`, `${op}.1`], 'ensimmäistä osaa ei lähetetä uudelleen');
    assert.equal(currentTimer(), null);
    assert.equal(loadTimer(USER_A.id), null);
  });
}

test('RACE-01: toisen osan palvelinvirhe 503 on ohimenevä -> osa jää lähtökoriin, pysäytys valmistuu eikä mitään katoa', async () => {
  const db = entryDb(['ok', { status: 503 }]);
  useEntryDb(db);
  const start = new Date(2026, 8, 20, 23, 30).getTime(); // su 23.30
  await startTracking({ kind: 'none' }, { now: start });
  const op = OPERATION.timer(currentTimer().id);

  const first = await stopTracking({ now: start + 75 * MIN }); // 30 + 45 min
  assert.equal(first.ok, true, 'ohimenevä virhe ei kaada pysäytystä');
  assert.equal(currentTimer(), null);
  assert.equal(loadTimer(USER_A.id), null);
  assert.deepEqual(loadOutbox(USER_A.id).map(entry => entry.operationId), [`${op}.1`], 'toinen osa odottaa lähtökorissa');
  assert.deepEqual([...db.rows.values()].map(row => row.minutes), [30]);

  // Yhteys palaa: lähtökori lähettää puuttuvan osan kerran.
  await flushTimeOutbox();
  const rows = [...db.rows.values()];
  assert.deepEqual(rows.map(row => row.minutes).sort((x, y) => x - y), [30, 45], '75 min, ei hukkaa');
  assert.deepEqual(rows.map(row => row.operationId).sort(), [op, `${op}.1`], 'yksi rivi per operaatio');
  assert.deepEqual(loadOutbox(USER_A.id), []);
});

test('RACE-01: uudelleenlataus osittaisen pysäytyksen jälkeen -> puuttuva osa kirjataan kerran, vaikka tila ei tunne tallennettua osaa', async () => {
  const db = entryDb(['ok', { code: '23514', message: 'check' }]);
  useEntryDb(db);
  const start = new Date(2026, 8, 20, 23, 30).getTime();
  await startTracking({ kind: 'none' }, { now: start });
  const op = OPERATION.timer(currentTimer().id);
  assert.equal((await stopTracking({ now: start + 75 * MIN })).ok, false);

  // Sivu latautuu: kirjaukset eivät ole tilassa (esim. aalto I, jossa
  // operation_id ei kulje kannan kautta), ajastin palaa laitteelta.
  resetState();
  restoreLocalTimer();
  const retry = await stopTracking({ now: start + 300 * MIN });
  assert.equal(retry.ok, true);
  assert.equal(db.rows.size, 2);
  assert.equal(db.calls.filter(id => id === op).length, 1, 'tallennettu osa ei monistu');
  assert.equal(currentTimer(), null);
});

test('offline F4: istunto vaihtuu ensimmäisen osan jälkeen -> takaisin kirjautuessa loppu kirjataan', async () => {
  const db = entryDb();
  const hold = gate();
  db.gates.push(hold.promise);
  useEntryDb(db);
  const start = new Date(2026, 8, 20, 23, 30).getTime();
  await startTracking({ kind: 'none' }, { now: start });
  const op = OPERATION.timer(currentTimer().id);
  const pending = stopTracking({ now: start + 75 * MIN });
  await settle();
  switchTo(USER_B);
  hold.release();
  const result = await pending;
  assert.equal(result.code, 'timer.session_changed');
  assert.equal(currentTimer(), null, 'B ei näe A:n ajastinta');
  assert.deepEqual(loadTimer(USER_A.id).loggedOperationIds, [op], 'A:n suunnitelma A:n avaimella');
  assert.equal(loadTimer(USER_B.id), null);

  switchTo(USER_A);
  restoreLocalTimer();
  const again = await stopTracking({ now: start + 500 * MIN });
  assert.equal(again.ok, true);
  assert.deepEqual([...db.rows.values()].map(row => row.minutes).sort((a, b) => a - b), [30, 45]);
  assert.equal(loadTimer(USER_A.id), null);
});

// ======================================================= RACE-02

test('RACE-02: toinen välilehti pysäytti jo (laitteen kopio poissa) -> toinen pysäytys ei kirjaa mitään (aalto I: ei operation_id:tä)', async () => {
  // Kanta kuten aallossa I: rivi kulkee toRow:n läpi, vain id on uniikki.
  const db = new Map();
  useEntryDb({
    isPersistent: () => true,
    async insert(entry) {
      const row = timeEntriesRepo.mapping.toRow(entry);
      if (db.has(row.id)) return UNIQUE;
      db.set(row.id, row);
      return { ok: true };
    }
  });
  await startTracking({ kind: 'none' }, { now: T0 });
  const timer = currentTimer();
  assert.equal((await stopTracking({ now: T0 + 30 * MIN })).ok, true); // välilehti A

  // Välilehti B latasi aiemmin: sen tila pitää yhä ajastimen, ja sen
  // kirjaukset tulevat kannasta (ilman operaatiotunnistetta aallossa I).
  setTimeEntries([...db.values()].map(row => timeEntriesRepo.mapping.fromRow({ ...row, user_id: USER_A.id })));
  setRunningTimerInState(timer);
  const b = await stopTracking({ now: T0 + 40 * MIN });
  assert.equal(b.ok, true);
  assert.equal(b.duplicate, true);
  assert.equal(db.size, 1, 'yksi rivi, ei 30 + 40 min');
  assert.equal(currentTimer(), null);
});

// ======================================================= RACE-03

test('RACE-03: toisen välilehden ajastin laitteella -> käynnistys kieltäytyy eikä kopio muutu', async () => {
  saveTimer(USER_A.id, { id: 'tab-a', startedAt: iso(T0), targetKind: 'none' });
  assert.equal(currentTimer(), null, 'tämän välilehden tila ei tiedä siitä');
  const second = await startTracking({ kind: 'none' }, { now: T0 + 5 * MIN });
  assert.equal(second.ok, false);
  assert.equal(second.code, 'timer.already_running');
  assert.equal(loadTimer(USER_A.id).id, 'tab-a', 'laitteen kopio säilyy');
  assert.equal(currentTimer().id, 'tab-a', 'tila korjautuu laitteen mukaiseksi');
});

test('RACE-03: pysäytys ei pyyhi toisen välilehden uutta ajastinta (poisto vain samalla tunnisteella)', async () => {
  await startTracking({ kind: 'none' }, { now: T0 });
  // Toinen välilehti pysäytti tämän ja käynnisti oman.
  saveTimer(USER_A.id, { id: 'tab-b', startedAt: iso(T0 + 20 * MIN), targetKind: 'none' });
  const stop = await stopTracking({ now: T0 + 60 * MIN });
  assert.equal(stop.duplicate, true);
  assert.equal(getState().timeEntries.length, 0, 'ei kirjausta vanhalle ajastimelle');
  assert.equal(loadTimer(USER_A.id).id, 'tab-b');
  assert.equal(currentTimer().id, 'tab-b');

  saveTimer(USER_A.id, null, { expectId: 'tab-a' });
  assert.equal(loadTimer(USER_A.id).id, 'tab-b', 'eri tunnisteen poisto ohitetaan');
  saveTimer(USER_A.id, null, { expectId: 'tab-b' });
  assert.equal(loadTimer(USER_A.id), null);
});

test('RACE-03: tauko ja hylkäys eivät herätä toisessa välilehdessä pysäytettyä ajastinta', async () => {
  await startTracking({ kind: 'none' }, { now: T0 });
  saveTimer(USER_A.id, null); // toinen välilehti pysäytti
  const paused = await pauseTracking({ now: T0 + 5 * MIN });
  assert.equal(paused.ok, false);
  assert.equal(paused.code, 'timer.changed');
  assert.equal(loadTimer(USER_A.id), null, 'laitteelle ei kirjoiteta pysäytettyä ajastinta takaisin');
  assert.equal(currentTimer(), null);
});

test('RACE-03: storage-tapahtuma tuo toisen välilehden käynnistyksen ja pysäytyksen tilaan; kuuntelija poistuu', () => {
  const target = eventTarget();
  assert.equal(initTimerCrossTabSync(target), true);
  assert.equal(target.count('storage'), 1);

  saveTimer(USER_A.id, { id: 'other-tab', startedAt: iso(T0), targetKind: 'none' });
  target.dispatch('storage', { key: 'manifestival.jotain.muuta' });
  assert.equal(currentTimer(), null, 'muu avain ei vaikuta');
  target.dispatch('storage', { key: timerKey(USER_A.id) });
  assert.equal(currentTimer().id, 'other-tab');

  saveTimer(USER_A.id, null);
  target.dispatch('storage', { key: timerKey(USER_A.id) });
  assert.equal(currentTimer(), null);

  stopTimerCrossTabSync();
  assert.equal(target.count('storage'), 0);
  saveTimer(USER_A.id, { id: 'late', startedAt: iso(T0), targetKind: 'none' });
  target.dispatch('storage', { key: timerKey(USER_A.id) });
  assert.equal(currentTimer(), null, 'uloskirjautumisen jälkeen ei kuunnella');
});

test('RACE-03: main.js kytkee välilehtisynkronoinnin kirjautuessa ja purkaa sen uloskirjautuessa', () => {
  const main = read('src/app/main.js').split('\r\n').join('\n');
  const signedIn = main.match(/async function onSignedIn\(\) \{[\s\S]*?\n\}/)[0];
  const signedOut = main.match(/function onSignedOut\(\) \{[\s\S]*?\n\}/)[0];
  assert.match(signedIn, /restoreLocalTimer\(\);\s*[\s\S]*?initTimerCrossTabSync\(\);/);
  assert.match(signedOut, /stopTimerCrossTabSync\(\);/);
});

test('RACE-03 / offline F8: offline-käynnistetty ajastin lisätään kantaan kerran, kun lataus palauttaa tyhjän listan', async () => {
  const repo = timerDb();
  repo.insertError = NETWORK;
  setTimerRepoForTests(repo);
  const started = await startTracking({ kind: 'none' }, { now: T0 });
  assert.equal(started.ok, true);
  assert.equal(loadTimerRecord(USER_A.id).synced, false);

  repo.insertError = null;
  resetState(); // uudelleenlataus
  restoreLocalTimer();
  const before = repo.calls.length;
  adoptLoadedTimers([], { sinceSeq: timerMutationSeq() });
  await settle();
  assert.deepEqual(repo.calls.slice(before), [['insert', started.timer.id]], 'yksi uudelleenlisäys');
  assert.ok(repo.rows.has(started.timer.id));
  assert.equal(currentTimer().id, started.timer.id);
  assert.equal(loadTimerRecord(USER_A.id).synced, true);
});

test('RACE-03 / RACE-11: uudelleenlisäys törmää toisen laitteen ajastimeen -> laitteen ajastin odottaa, kannan ajastin näkyy', async () => {
  const repo = timerDb();
  repo.insertError = NETWORK;
  setTimerRepoForTests(repo);
  const started = await startTracking({ kind: 'none' }, { now: T0 });
  repo.insertError = null;
  resetState();
  restoreLocalTimer();
  adoptLoadedTimers([]); // lista luettiin juuri ennen kuin toinen laite lisäsi omansa
  repo.rows.set('other', { id: 'other', startedAt: iso(T0 + 10 * MIN), targetKind: 'none' });
  await settle();
  assert.equal(pendingTimer().id, started.timer.id, 'tämän laitteen aika ei katoa');
  assert.equal(currentTimer().id, 'other');
  assert.equal(loadTimer(USER_A.id).id, 'other');
});

test('RACE-03: lataus lukee tyhjän listan oman lisäyksen ollessa matkalla -> ei uusintaa, ei odottavaa kopiota', async () => {
  const repo = timerDb();
  const hold = gate();
  repo.insertGate = hold.promise;
  setTimerRepoForTests(repo);
  const starting = startTracking({ kind: 'none' }, { now: T0 });
  adoptLoadedTimers([], { sinceSeq: timerMutationSeq() }); // SELECT ennen lisäyksen commitia
  hold.release();
  const started = await starting;
  await settle();
  assert.equal(repo.calls.filter(call => call[0] === 'insert').length, 1, 'kuitattu lisäys ohittaa uusinnan');
  assert.equal(pendingTimer(), null);
  assert.equal(currentTimer().id, started.timer.id);
});

test('RACE-03: lisäyksen vastaus katosi (rivi on kannassa) -> uusinnan 23505 ratkaistaan listalla, ei odottavaa kopiota', async () => {
  const repo = timerDb();
  repo.insertError = NETWORK;
  setTimerRepoForTests(repo);
  const started = await startTracking({ kind: 'none' }, { now: T0 });
  repo.rows.set(started.timer.id, { ...started.timer }); // lisäys meni perille, vastaus ei
  repo.insertError = null;
  resetState();
  restoreLocalTimer();
  adoptLoadedTimers([]); // lista luettu ennen commitia
  await settle(10);
  assert.equal(pendingTimer(), null, 'oma rivi ei ole toisen laitteen ajastin');
  assert.equal(currentTimer().id, started.timer.id);
  assert.equal(loadTimerRecord(USER_A.id).synced, true);
});

// ======================================================= RACE-08 / offline F5

test('RACE-08: käynnistyksen 23505 käyttäjän vaihduttua ei koske B:n ajastimeen', async () => {
  const repo = timerDb();
  repo.rows.set('elsewhere', { id: 'elsewhere' }); // toisen laitteen ajastin
  const hold = gate();
  repo.insertGate = hold.promise;
  setTimerRepoForTests(repo);
  const pending = startTracking({ kind: 'none' }, { now: T0 });
  switchTo(USER_B);
  saveTimer(USER_B.id, { id: 'b-timer', startedAt: iso(T0), targetKind: 'none' });
  restoreLocalTimer();
  hold.release();
  const result = await pending;
  assert.equal(result.code, 'timer.already_running_elsewhere');
  assert.equal(loadTimer(USER_B.id).id, 'b-timer', 'B:n laitteen ajastin koskematon');
  assert.equal(currentTimer().id, 'b-timer', 'B:n tila koskematon');
  assert.equal(loadTimer(USER_A.id), null, 'A:n törmännyt ajastin siivottiin A:n avaimelta');
});

test('RACE-08: hylkäyksen vahvistus palaa käyttäjän vaihduttua -> mitään ei kirjoiteta kummallekaan', async () => {
  await startTracking({ kind: 'none' }, { now: T0 });
  const result = await cancelTracking({
    now: T0 + 5 * MIN,
    confirmFn: async () => {
      switchTo(USER_B);
      saveTimer(USER_B.id, { id: 'b-timer', startedAt: iso(T0), targetKind: 'none' });
      restoreLocalTimer();
      return true;
    }
  });
  assert.equal(result.code, 'timer.session_changed');
  assert.equal(loadTimer(USER_B.id).id, 'b-timer');
  assert.equal(currentTimer().id, 'b-timer');
  assert.ok(loadTimer(USER_A.id), 'A:n ajastin ei hylkääntynyt B:n istunnossa');
  assert.deepEqual(loadTombstones(USER_B.id), []);
});

test('RACE-08: poiston hautakivi menee ajastimen omistajalle, vaikka käyttäjä vaihtuu kesken poiston', async () => {
  const repo = timerDb({ removeFails: true });
  setTimerRepoForTests(repo);
  await startTracking({ kind: 'none' }, { now: T0 });
  const timer = currentTimer();
  const hold = gate();
  repo.removeGate = hold.promise;
  const stopping = stopTracking({ now: T0 + 30 * MIN });
  for (let i = 0; i < 20 && !repo.calls.some(call => call[0] === 'remove'); i += 1) await settle(1);
  switchTo(USER_B);
  hold.release();
  await stopping;
  assert.deepEqual(loadTombstones(USER_A.id), [timer.id]);
  assert.deepEqual(loadTombstones(USER_B.id), []);
});

test('RACE-08: edellisen käyttäjän kesken jäänyt pysäytys ei tee B:n pysäytyksestä kaksoiskappaletta', async () => {
  const db = entryDb();
  const hold = gate();
  db.gates.push(hold.promise);
  useEntryDb(db, () => getUser()?.id || null);
  await startTracking({ kind: 'none' }, { now: T0 });
  const pendingA = stopTracking({ now: T0 + 30 * MIN });
  await settle();
  switchTo(USER_B);
  saveTimer(USER_B.id, { id: 'b-timer', startedAt: iso(T0), targetKind: 'none' });
  restoreLocalTimer();
  const b = await stopTracking({ now: T0 + 20 * MIN });
  assert.equal(b.ok, true);
  assert.equal(b.duplicate, undefined, 'B:n pysäytys kirjaa oikeasti');
  assert.equal(loadTimer(USER_B.id), null);
  hold.release();
  await pendingA;
});

// ======================================================= RACE-09

test('RACE-09: heti käynnistyksen jälkeinen pysäytys: poisto lähtee vasta lisäyksen jälkeen, ajastin ei palaa', async () => {
  const repo = timerDb();
  const hold = gate();
  repo.insertGate = hold.promise;
  setTimerRepoForTests(repo);
  const starting = startTracking({ kind: 'none' }, { now: T0 });
  const stopping = stopTracking({ now: T0 + 10 * 1000 }); // alle puoli minuuttia
  await settle();
  assert.deepEqual(repo.calls.map(call => call[0]), ['insert'], 'poisto odottaa lisäystä');
  hold.release();
  await starting;
  const stop = await stopping;
  assert.equal(stop.tooShort, true);
  assert.deepEqual(repo.calls.map(call => call[0]), ['insert', 'remove']);
  assert.equal(repo.rows.size, 0);
  resetState();
  adoptLoadedTimers([...repo.rows.values()]);
  assert.equal(currentTimer(), null);
});

test('RACE-09: tauko ja jatko menevät kantaan järjestyksessä, vaikka ensimmäinen vastaus viivästyy', async () => {
  const repo = timerDb();
  setTimerRepoForTests(repo);
  await startTracking({ kind: 'none' }, { now: T0 });
  const id = currentTimer().id;
  const hold = gate();
  repo.updateGates.push(hold.promise);
  const pausing = pauseTracking({ now: T0 + 10 * MIN });
  const resuming = resumeTracking({ now: T0 + 20 * MIN });
  await settle();
  assert.equal(repo.calls.filter(call => call[0] === 'update').length, 1, 'jatko odottaa taukoa');
  hold.release();
  await pausing;
  await resuming;
  assert.equal(repo.rows.get(id).pausedAt, null, 'viimeisin muutos (jatko) jää kantaan');
  assert.equal(repo.rows.get(id).pausedSeconds, 600);
  assert.equal(loadTimerRecord(USER_A.id).dirty, false);
});

// ======================================================= RACE-10

test('RACE-10: tarkistusdialogin aikana vaihtunut ajastin -> korjausta ei kirjata väärälle ajastimelle', async () => {
  const now = Date.now();
  await startTracking({ kind: 'none' }, { now: now - 14 * 60 * MIN }); // unohtunut T1
  const t2 = { id: 'T2', targetKind: 'none', startedAt: iso(now - 5 * MIN) };
  const result = await stopAndLog({
    reviewFn: async () => {
      // Päivitys otti dialogin aikana käyttöön toisen laitteen ajastimen.
      saveTimer(USER_A.id, t2, { synced: true, dirty: false });
      setRunningTimerInState(t2);
      return 60;
    }
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'timer.changed');
  assert.equal(getState().timeEntries.length, 0);
  assert.equal(currentTimer().id, 'T2');
  assert.equal(loadTimer(USER_A.id).id, 'T2');
});

test('RACE-10: hylkäys koskee vain ajastinta, josta kysyttiin', async () => {
  await startTracking({ kind: 'none' }, { now: T0 });
  const t2 = { id: 'T2', targetKind: 'none', startedAt: iso(T0 + MIN) };
  const result = await cancelTracking({
    now: T0 + 5 * MIN,
    confirmFn: async () => {
      saveTimer(USER_A.id, t2);
      setRunningTimerInState(t2);
      return true;
    }
  });
  assert.equal(result.code, 'timer.changed');
  assert.equal(currentTimer().id, 'T2');
  assert.equal(loadTimer(USER_A.id).id, 'T2');
});

// ======================================================= RACE-11

test('RACE-11: kannassa on toisen laitteen ajastin -> laitteen kirjaamaton ajastin jää odottamaan, ei katoa', async () => {
  setTimerRepoForTests(timerDb());
  saveTimer(USER_A.id, { id: 'local-L', startedAt: iso(T0), targetKind: 'none' }, { synced: false, dirty: true });
  const adopted = adoptLoadedTimers([{ id: 'remote-R', startedAt: iso(T0 + 30 * MIN), targetKind: 'none' }]);
  assert.equal(adopted.id, 'remote-R', 'kanta voittaa käynnissä olevana');
  assert.equal(loadTimer(USER_A.id).id, 'remote-R');
  assert.equal(pendingTimer().id, 'local-L', 'laitteen ajastin odottaa päätöstä');

  const review = await stopPendingTracking({ now: T0 + 50 * MIN });
  assert.equal(review.needsReview, true, 'kesto vahvistetaan aina');
  assert.equal(review.totalMinutes, 50);
  assert.equal(review.timerId, 'local-L');
  assert.equal(getState().timeEntries.length, 0);

  const logged = await stopPendingTracking({ now: T0 + 50 * MIN, overrideMinutes: 30, expectTimerId: 'local-L' });
  assert.equal(logged.ok, true);
  assert.equal(getState().timeEntries[0].minutes, 30);
  assert.equal(getState().timeEntries[0].operationId, OPERATION.timer('local-L'));
  assert.equal(pendingTimer(), null);
  assert.equal(currentTimer().id, 'remote-R', 'kannan ajastin jatkuu');
});

test('RACE-11: odottava ajastin näkyy ajastinpalkissa ja sen voi hylätä vahvistuksella', async (t) => {
  const { bar, toasts } = installBarDom(t);
  setTimerRepoForTests(timerDb());
  saveTimer(USER_A.id, { id: 'local-L', startedAt: iso(T0), targetKind: 'none' });
  adoptLoadedTimers([{ id: 'remote-R', startedAt: iso(T0 + 30 * MIN), targetKind: 'none' }]);
  assert.equal(toasts.length, 1, 'käyttäjälle kerrotaan');
  assert.match(toasts[0], /kirjaamaton ajastus/);
  renderTimerBar(T0 + 40 * MIN);
  assert.equal(bar.hidden, false);
  assert.match(bar.innerHTML, /kirjaamaton ajastus/);
  assert.match(bar.innerHTML, /data-timer="pending-log"/);
  assert.match(bar.innerHTML, /data-timer="pending-discard"/);

  const kept = await discardPendingTracking({ confirmFn: async () => false });
  assert.equal(kept.cancelled, false);
  assert.equal(pendingTimer().id, 'local-L');
  const gone = await discardPendingTracking({ confirmFn: async () => true });
  assert.equal(gone.cancelled, true);
  assert.equal(pendingTimer(), null);
  assert.equal(getState().timeEntries.length, 0);
});

test('RACE-11: kannassa ollut (synced) ajastin korvautui toisella -> ei odottavaa, kanta voittaa', () => {
  setTimerRepoForTests(timerDb());
  saveTimer(USER_A.id, { id: 'old', startedAt: iso(T0), targetKind: 'none' }, { synced: true, dirty: false });
  adoptLoadedTimers([{ id: 'new', startedAt: iso(T0 + 30 * MIN), targetKind: 'none' }]);
  assert.equal(currentTimer().id, 'new');
  assert.deepEqual(loadPendingTimers(USER_A.id), []);
});

// ======================================================= offline F1

test('offline F1: paluun päivityksen vanha lista ei herätä pysäytettyä ajastinta eikä kirjoita sitä laitteelle', async () => {
  const repo = timerDb();
  setTimerRepoForTests(repo);
  useEntryDb(entryDb());
  await startTracking({ kind: 'none' }, { now: T0 });
  const timer = currentTimer();
  const seq = timerMutationSeq(); // lataus alkaa ...
  const staleList = [...repo.rows.values()]; // ... ja lukee listan ennen pysäytystä
  assert.equal((await stopTracking({ now: T0 + 40 * MIN })).ok, true);
  assert.equal(repo.rows.size, 0);

  adoptLoadedTimers(staleList, { sinceSeq: seq });
  assert.equal(currentTimer(), null);
  assert.equal(loadTimer(USER_A.id), null);
  // Myös ilman järjestysnumeroa hautakivi pitää ajastimen haudattuna.
  adoptLoadedTimers(staleList);
  assert.equal(currentTimer(), null);
  assert.equal(loadTimer(USER_A.id), null);
  assert.deepEqual(loadTombstones(USER_A.id), [timer.id], 'hautakivi säilyy, kunnes kanta vahvistaa');

  await settle();
  adoptLoadedTimers([...repo.rows.values()]); // tuore lista ilman riviä
  assert.deepEqual(loadTombstones(USER_A.id), []);
  assert.equal((await stopTracking({ now: T0 + 90 * MIN })).code, 'timer.none', 'ei toista pysäytystä');
});

test('offline F1: ajastinmuutos kesken latauksen -> vanhaa listaa ei oteta käyttöön (tauko ei kumoudu)', async () => {
  const repo = timerDb();
  setTimerRepoForTests(repo);
  await startTracking({ kind: 'none' }, { now: T0 });
  const seq = timerMutationSeq();
  const staleList = [...repo.rows.values()]; // ennen taukoa
  await pauseTracking({ now: T0 + 10 * MIN });
  assert.equal(loadTimerRecord(USER_A.id).dirty, false, 'tauko ehti kantaan');
  adoptLoadedTimers(staleList, { sinceSeq: seq });
  assert.ok(currentTimer().pausedAt, 'tauko säilyy');
  assert.ok(loadTimer(USER_A.id).pausedAt);
});

test('offline F1: kesken latauksen käynnistetty ajastin ei putoa vanhan tyhjän listan takia', async () => {
  setTimerRepoForTests(timerDb());
  const seq = timerMutationSeq();
  await startTracking({ kind: 'none' }, { now: T0 });
  assert.equal(loadTimerRecord(USER_A.id).synced, true);
  adoptLoadedTimers([], { sinceSeq: seq });
  assert.ok(currentTimer(), 'vanha tyhjä lista ei tarkoita "pysäytetty muualla"');
});

// ======================================================= offline F2

test('offline F2: laitteelta palautettu ajastin ennen latausta: kohde säilyy kirjauksessa, nimi ei väitä poistetuksi', async () => {
  saveTimer(USER_A.id, { id: 'restored', targetKind: 'task', taskId: 't1', startedAt: iso(T0) });
  restoreLocalTimer();
  assert.equal(describeTarget(targetOfTimer(currentTimer())), 'Ladataan kohdetta…');
  useEntryDb(entryDb(['network']));
  const stop = await stopTracking({ now: T0 + 40 * MIN });
  assert.equal(stop.ok, true);
  assert.equal(loadOutbox(USER_A.id)[0].taskId, 't1', 'tehtävälinkki ei katkennut');
});

test('offline F2: kun tehtävät on ladattu eikä kohdetta ole, viite pudotetaan ja nimi on "Poistettu kohde"', async () => {
  saveTimer(USER_A.id, { id: 'restored', targetKind: 'task', taskId: 't1', startedAt: iso(T0) });
  restoreLocalTimer();
  setTasks([task('t2')]);
  setDomainLoadStatus('tasks', true);
  assert.equal(describeTarget(targetOfTimer(currentTimer())), 'Poistettu kohde');
  useEntryDb(entryDb(['network']));
  await stopTracking({ now: T0 + 40 * MIN });
  assert.equal(loadOutbox(USER_A.id)[0].taskId, null);
});

// ======================================================= offline F8

test('offline F8: toisella laitteella pysäytetty (kannasta kadonnut) ajastin ei herää laitteen kopiosta', () => {
  setTimerRepoForTests(timerDb());
  adoptLoadedTimers([{ id: 'remote-1', startedAt: iso(T0), targetKind: 'none' }]);
  assert.equal(currentTimer().id, 'remote-1');
  assert.equal(loadTimerRecord(USER_A.id).synced, true);
  resetState();
  restoreLocalTimer();
  adoptLoadedTimers([]);
  assert.equal(currentTimer(), null);
  assert.equal(loadTimer(USER_A.id), null);
});

test('offline F8: toisella laitteella tehty tauko voittaa ajan tasalla olevan laitteen kopion eikä kumoudu kannassa', async () => {
  const repo = timerDb();
  setTimerRepoForTests(repo);
  await startTracking({ kind: 'none' }, { now: T0 });
  const id = currentTimer().id;
  const pausedRow = { ...repo.rows.get(id), pausedAt: iso(T0 + 10 * MIN) };
  repo.rows.set(id, pausedRow);
  resetState();
  restoreLocalTimer();
  adoptLoadedTimers([pausedRow]);
  await settle();
  assert.equal(currentTimer().pausedAt, pausedRow.pausedAt);
  assert.equal(loadTimer(USER_A.id).pausedAt, pausedRow.pausedAt);
  assert.equal(repo.calls.filter(call => call[0] === 'update').length, 0, 'kannan taukoa ei kumota');
});

// ======================================================= offline F12

test('offline F12: localStorage olemassa mutta tallennus heittää -> jonotettu kirjaus ja ajastin luetaan muistista', async () => {
  installStorage({ setThrows: true });
  const db = entryDb(['network']);
  useEntryDb(db);
  const logged = await logTime({ entryDate: '2026-09-21', minutes: 25, operationId: 'log:quota' });
  assert.equal(logged.queued, true);
  assert.equal(loadOutbox(USER_A.id).length, 1, 'jonotettu kirjaus on luettavissa');
  assert.deepEqual(await flushTimeOutbox(), { sent: 1, left: 0 });
  assert.equal(db.rows.size, 1);
  const saved = saveTimer(USER_A.id, { id: 'mem', startedAt: iso(T0), targetKind: 'none' });
  assert.equal(saved.persistent, false);
  assert.equal(loadTimer(USER_A.id).id, 'mem');
  adoptLoadedTimers([]);
  assert.equal(currentTimer().id, 'mem', 'portti kiinni: muistin ajastin säilyy latauksessa');
});

test('offline F12: epäonnistunut poisto ei palauta laitteen vanhaa arvoa (muistin poistomerkintä)', () => {
  saveOutbox(USER_A.id, [{ id: 'e1', entryDate: '2026-09-21', minutes: 5, operationId: 'log:e1' }]);
  saveTimer(USER_A.id, { id: 'old', startedAt: iso(T0), targetKind: 'none' });
  globalThis.localStorage.removeItem = () => { throw new Error('SecurityError'); };
  assert.equal(saveOutbox(USER_A.id, []).persistent, false);
  assert.deepEqual(loadOutbox(USER_A.id), [], 'lähetetty kirjaus ei palaa korista');
  saveTimer(USER_A.id, null);
  assert.equal(loadTimer(USER_A.id), null, 'pysäytetty ajastin ei palaa laitteelta');
});

// ======================================================= offline F13

test('offline F13: oma haudattu rivi ei estä uutta käynnistystä "toisena laitteena"', async () => {
  const repo = timerDb({ removeFails: true });
  setTimerRepoForTests(repo);
  await startTracking({ kind: 'none' }, { now: T0 });
  const old = currentTimer();
  await stopTracking({ now: T0 + 30 * MIN });
  assert.ok(repo.rows.has(old.id), 'poisto ei mennyt perille');
  assert.deepEqual(loadTombstones(USER_A.id), [old.id]);

  repo.removeFails = false;
  const next = await startTracking({ kind: 'none' }, { now: T0 + 40 * MIN });
  assert.equal(next.ok, true);
  assert.equal(repo.rows.has(old.id), false, 'haudattu rivi poistettiin');
  assert.ok(repo.rows.has(next.timer.id));
  assert.equal(currentTimer().id, next.timer.id);
});

test('offline F13: oikea toisen laitteen ajastin estää yhä käynnistyksen', async () => {
  const repo = timerDb();
  repo.rows.set('other-device', { id: 'other-device', startedAt: iso(T0), targetKind: 'none' });
  setTimerRepoForTests(repo);
  const result = await startTracking({ kind: 'none' }, { now: T0 + MIN });
  assert.equal(result.code, 'timer.already_running_elsewhere');
  await settle();
  assert.equal(currentTimer().id, 'other-device', 'toisen laitteen ajastin näytetään heti');
  assert.equal(loadTimer(USER_A.id).id, 'other-device');
});

// ======================================================= account-lifecycle F7

test('lifecycle F7: tilin poiston aikana kesken ollut lähetys ei kirjoita lähtökoria takaisin', async () => {
  let release;
  const repo = {
    isPersistent: () => true,
    insert: () => new Promise(resolve => {
      release = () => resolve({ ok: false, error: { cause: { status: 401, message: 'JWT expired' } } });
    })
  };
  saveOutbox(USER_A.id, [{ id: 'e1', entryDate: '2026-09-21', minutes: 20, operationId: 'log:e1', note: 'yksityinen' }]);
  const writer = createTimeEntryWriter({ repo, loadOutbox, saveOutbox, userId: () => USER_A.id });
  const flushing = writer.flush();
  purgeTimerData(USER_A.id);
  release();
  await flushing;
  assert.deepEqual(loadOutbox(USER_A.id), []);
  assert.equal(globalThis.localStorage.getItem(outboxKey(USER_A.id)), null, 'poistettu data ei palannut');
});

test('lifecycle F7: poistetun käyttäjän ajastin, hautakivet ja kannan kuittaus eivät palaa laitteelle', async () => {
  const repo = timerDb();
  const hold = gate();
  repo.insertGate = hold.promise;
  setTimerRepoForTests(repo);
  const starting = startTracking({ kind: 'none' }, { now: T0 });
  purgeTimerData(USER_A.id);
  hold.release();
  await starting;
  assert.equal(globalThis.localStorage.getItem(timerKey(USER_A.id)), null, 'kuittaus ei palauttanut ajastinta');
  assert.equal(saveTimer(USER_A.id, { id: 'x', startedAt: iso(T0), targetKind: 'none' }).purged, true);
  addTombstone(USER_A.id, 'x');
  assert.equal(globalThis.localStorage.getItem(tombstoneKey(USER_A.id)), null);
  assert.equal(loadTimer(USER_A.id), null);
  // Toinen käyttäjä samalla laitteella ei kärsi.
  assert.equal(saveTimer(USER_B.id, { id: 'y', startedAt: iso(T0), targetKind: 'none' }).ok, true);
});

// ======================================================= malli

test('pysäytyssuunnitelma on vain laitteella: kannan riville se ei lähde', () => {
  const planned = { id: 't', targetKind: 'none', startedAt: iso(T0), stopAtMs: T0 + 30 * MIN, overrideMinutes: 20, loggedOperationIds: ['timer:t'] };
  const row = runningTimersRepo.mapping.toRow(runningTimersRepo.mapping.normalize(planned));
  assert.equal(Object.keys(row).some(key => /stop|override|logged/i.test(key)), false);
  saveTimer(USER_A.id, planned);
  assert.equal(loadTimer(USER_A.id).stopAtMs, T0 + 30 * MIN, 'laitteella säilyy');
  assert.deepEqual(loadTimer(USER_A.id).loggedOperationIds, ['timer:t']);
});

test('kesken jäänyt pysäytys: palkki kertoo tilan, tauko estetään, kirjattava aika ei kasva', async (t) => {
  const { bar } = installBarDom(t);
  useEntryDb(entryDb(['ok', { code: '23514', message: 'check' }]));
  const start = new Date(2026, 8, 20, 23, 30).getTime();
  await startTracking({ kind: 'none' }, { now: start });
  await stopTracking({ now: start + 75 * MIN });
  renderTimerBar(start + 500 * MIN);
  assert.match(bar.innerHTML, /Kirjaus kesken/);
  assert.match(bar.innerHTML, /1:15/, 'pysäytyshetken kesto, ei nykyhetken');
  assert.match(bar.innerHTML, /Yritä kirjausta uudelleen/);
  assert.equal(/data-timer="pause"/.test(bar.innerHTML), false);
  assert.equal((await pauseTracking({ now: start + 501 * MIN })).code, 'timer.stopping');
});
