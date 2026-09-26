// Suunta 2: ajanseurannan sovelluskerros — pysyvyys, uudelleenlataus,
// uloskirjautuminen, kaksoiskirjausten esto, offline-uusinta ja
// kohdeasetukset.
//
// Kello annetaan AINA eksplisiittisenä (now-parametri). Laitteen
// tallennus on testikohtainen localStorage-tynkä.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { setUser, clearUser, sessionSnapshot } from '../src/data/session.js';
import { setClient } from '../src/data/client.js';
import { fakeClient } from './helpers/gates.mjs';
import {
  resetState, getState, setTasks, setRoutines, setProjects, setDomainLoadStatus
} from '../src/app/state.js';
import { clearLocalUserData, toggleComplete, setCompletionHook } from '../src/app/actions.js';
import {
  startTracking, pauseTracking, resumeTracking, stopTracking, cancelTracking, logQuickTime,
  currentTimer, occurrenceOperationId, loggedMinutesForOccurrence, saveItemSettings, itemSettingsFor,
  setTimerRepoForTests, entryFieldsFor, describeTarget, newOperationId
} from '../src/app/timeTracking.js';
import { restoreLocalTimer, adoptLoadedTimers } from '../src/app/timerState.js';
import {
  logTime, setTimeEntryWriterForTests, flushTimeOutbox, pendingTimeEntryCount, createLifeArea,
  analyzeCurrentWeek
} from '../src/app/alignment.js';
import { createTimeEntryWriter } from '../src/app/timeEntryWriter.js';
import {
  loadTimer, saveTimer, loadOutbox, saveOutbox, purgeTimerData, timerKey, outboxKey,
  resetTimerStoreForTests, MAX_OUTBOX_ENTRIES, loadTombstones, tombstoneKey
} from '../src/data/timerStore.js';
import { clearUser as signOut } from '../src/data/session.js';
import { deleteTimeEntry } from '../src/app/alignment.js';
import { normalizeTask } from '../src/domain/task.js';
import { normalizeRoutine } from '../src/domain/routine.js';
import { normalizeProject } from '../src/domain/project.js';
import { OPERATION } from '../src/domain/timeEntry.js';

const USER_A = { id: 'aaaaaaaa-1111-4111-8111-00000000000a', email: 'a@example.com' };
const USER_B = { id: 'bbbbbbbb-2222-4222-8222-00000000000b', email: 'b@example.com' };
const MIN = 60 * 1000;
const T0 = Date.UTC(2026, 8, 21, 7, 0); // ma 21.9.2026 klo 10 Helsinki

function installStorage() {
  const data = new Map();
  globalThis.localStorage = {
    getItem: key => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => { data.set(key, String(value)); },
    removeItem: key => { data.delete(key); },
    key: index => [...data.keys()][index] ?? null,
    get length() { return data.size; },
    _data: data
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
  setUser(USER_A);
  setClient(fakeClient({ data: [], error: null }));
});

afterEach(() => {
  delete globalThis.localStorage;
  setCompletionHook(null);
});

const task = (id, extra = {}) => normalizeTask({ id, title: 'Tehtävä ' + id, date: '2026-09-21', durationMinutes: 45, ...extra });

// ================================================================ AJASTIN

test('käynnistys tallentuu tilaan ja laitteelle käyttäjäkohtaisella avaimella', async () => {
  setTasks([task('t1')]);
  const result = await startTracking({ kind: 'task', id: 't1' }, { now: T0 });
  assert.equal(result.ok, true);
  assert.equal(currentTimer().taskId, 't1');
  const stored = JSON.parse(globalThis.localStorage.getItem(timerKey(USER_A.id)));
  assert.equal(stored.userId, USER_A.id);
  assert.equal(stored.timer.startedAt, new Date(T0).toISOString());
  assert.equal(JSON.stringify(stored).includes('Tehtävä'), false, 'laitteelle ei tallenneta otsikoita');
});

test('uudelleenlataus ei hukkaa kulunutta aikaa', async () => {
  await startTracking({ kind: 'none' }, { now: T0 });
  resetState(); // "sivu latautuu uudelleen"
  assert.equal(currentTimer(), null);
  const restored = restoreLocalTimer();
  assert.equal(restored.startedAt, new Date(T0).toISOString());
  const stop = await stopTracking({ now: T0 + 50 * MIN });
  assert.equal(stop.ok, true);
  assert.equal(stop.totalMinutes, 50);
});

test('kaksi ajastinta ei käynnisty; ensimmäinen säilyy', async () => {
  await startTracking({ kind: 'none' }, { now: T0 });
  const second = await startTracking({ kind: 'none' }, { now: T0 + MIN });
  assert.equal(second.ok, false);
  assert.equal(second.code, 'timer.already_running');
  assert.equal(currentTimer().startedAt, new Date(T0).toISOString());
});

test('pysäytys kirjaa ajastinkirjauksen ja poistaa ajastimen tilasta ja laitteelta', async () => {
  setTasks([task('t1')]);
  await startTracking({ kind: 'task', id: 't1' }, { now: T0 });
  await pauseTracking({ now: T0 + 20 * MIN });
  await resumeTracking({ now: T0 + 30 * MIN });
  const stop = await stopTracking({ now: T0 + 60 * MIN });
  assert.equal(stop.ok, true);
  assert.equal(stop.totalMinutes, 50);
  const [entry] = getState().timeEntries;
  assert.equal(entry.source, 'timer');
  assert.equal(entry.taskId, 't1');
  assert.equal(entry.minutes, 50);
  assert.ok(entry.operationId.startsWith('timer:'));
  assert.equal(currentTimer(), null);
  assert.equal(loadTimer(USER_A.id), null);
});

test('kaksoisnapautus pysäytykseen: yksi kirjaus', async () => {
  await startTracking({ kind: 'none' }, { now: T0 });
  const [a, b] = await Promise.all([stopTracking({ now: T0 + 30 * MIN }), stopTracking({ now: T0 + 30 * MIN })]);
  assert.equal(a.ok && b.ok, true);
  assert.equal([a, b].filter(r => r.duplicate).length, 1);
  assert.equal(getState().timeEntries.length, 1);
});

test('uusinta: sama ajastin pysäytetään uudelleen (esim. kannan rivi jäi) -> ei toista kirjausta', async () => {
  await startTracking({ kind: 'none' }, { now: T0 });
  const timer = currentTimer();
  await stopTracking({ now: T0 + 30 * MIN });
  // Ajastin palaa kannasta latauksessa (poisto ei ehtinyt perille).
  adoptLoadedTimers([timer]);
  saveTimer(USER_A.id, timer);
  restoreLocalTimer();
  const again = await stopTracking({ now: T0 + 45 * MIN });
  assert.equal(again.ok, true);
  const entries = getState().timeEntries;
  assert.equal(entries.length, 1, 'sama operaatiotunniste -> ei kaksoiskirjausta');
  assert.equal(entries[0].minutes, 30);
});

test('keskiyön ylittävä pysäytys: kaksi kirjausta, kumpikin oma operaationsa', async () => {
  const start = new Date(2026, 8, 20, 23, 30).getTime();
  await startTracking({ kind: 'none' }, { now: start });
  const stop = await stopTracking({ now: start + 75 * MIN });
  assert.equal(stop.entries.length, 2);
  assert.deepEqual(getState().timeEntries.map(e => e.minutes).sort((a, b) => a - b), [30, 45]);
  assert.equal(new Set(getState().timeEntries.map(e => e.operationId)).size, 2);
});

test('unohtunut ajastin: mitään ei kirjata ennen käyttäjän tarkistusta', async () => {
  await startTracking({ kind: 'none' }, { now: T0 });
  const review = await stopTracking({ now: T0 + 14 * 60 * MIN });
  assert.equal(review.needsReview, true);
  assert.equal(getState().timeEntries.length, 0);
  assert.ok(currentTimer(), 'ajastin odottaa päätöstä');
  const fixed = await stopTracking({ now: T0 + 14 * 60 * MIN, overrideMinutes: 120 });
  assert.equal(fixed.totalMinutes, 120);
  assert.equal(getState().timeEntries[0].minutes, 120);
});

test('alle minuutin ajastus ei tuota roskakirjausta', async () => {
  await startTracking({ kind: 'none' }, { now: T0 });
  const stop = await stopTracking({ now: T0 + 20 * 1000 });
  assert.equal(stop.tooShort, true);
  assert.equal(getState().timeEntries.length, 0);
  assert.equal(currentTimer(), null);
});

test('hylkäys kysyy vahvistuksen eikä kirjaa mitään', async () => {
  await startTracking({ kind: 'none' }, { now: T0 });
  const kept = await cancelTracking({ now: T0 + 5 * MIN, confirmFn: async () => false });
  assert.equal(kept.cancelled, false);
  assert.ok(currentTimer());
  let asked = null;
  const gone = await cancelTracking({ now: T0 + 5 * MIN, confirmFn: async opts => { asked = opts; return true; } });
  assert.equal(gone.cancelled, true);
  assert.equal(asked.destructive, true);
  assert.equal(currentTimer(), null);
  assert.equal(getState().timeEntries.length, 0);
});

// ================================================================ KÄYTTÄJÄT

test('uloskirjautuminen: A:n ajastin ei näy B:lle, ja palaa A:lle', async () => {
  await startTracking({ kind: 'none' }, { now: T0 });
  // Uloskirjautuminen: tila nollataan, laitteen tallenne jää A:n avaimelle.
  clearUser();
  resetState();
  setUser(USER_B);
  assert.equal(restoreLocalTimer(), null);
  assert.equal(currentTimer(), null);
  // Väärennetty sisältö B:n avaimella (A:n data) hylätään.
  globalThis.localStorage.setItem(timerKey(USER_B.id), globalThis.localStorage.getItem(timerKey(USER_A.id)));
  assert.equal(loadTimer(USER_B.id), null, 'sisällön userId tarkistetaan');
  clearUser();
  resetState();
  setUser(USER_A);
  assert.ok(restoreLocalTimer());
});

test('tilin poisto poistaa ajastimen ja lähtökorin laitteelta', () => {
  saveTimer(USER_A.id, { id: 'x', startedAt: new Date(T0).toISOString(), targetKind: 'none' });
  saveOutbox(USER_A.id, [{ id: 'e', entryDate: '2026-09-21', minutes: 5, operationId: 'log:e' }]);
  purgeTimerData(USER_A.id);
  assert.equal(globalThis.localStorage.getItem(timerKey(USER_A.id)), null);
  assert.equal(globalThis.localStorage.getItem(outboxKey(USER_A.id)), null);
});

test('laitteen tallenne: kelvoton sisältö ja kelvoton avain ohitetaan', () => {
  globalThis.localStorage.setItem(timerKey(USER_A.id), '{rikki');
  assert.equal(loadTimer(USER_A.id), null);
  assert.equal(timerKey('../../etc'), null);
  assert.equal(loadTimer(null), null);
  saveOutbox(USER_A.id, Array.from({ length: MAX_OUTBOX_ENTRIES + 5 }, (_, i) => ({
    id: `e${i}`, entryDate: '2026-09-21', minutes: 5, operationId: `log:e${i}`
  })));
  assert.equal(loadOutbox(USER_A.id).length, MAX_OUTBOX_ENTRIES);
});

test('kanta: yksi ajastin käyttäjää kohti — toisen laitteen ajastin estää käynnistyksen', async () => {
  setTimerRepoForTests({
    isPersistent: () => true,
    insert: async () => ({ ok: false, error: { cause: { code: '23505' } } }),
    update: async () => ({ ok: true }), remove: async () => ({ ok: true })
  });
  const result = await startTracking({ kind: 'none' }, { now: T0 });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'timer.already_running_elsewhere');
  assert.equal(currentTimer(), null);
  assert.equal(loadTimer(USER_A.id), null);
});

test('kanta: verkkovirhe käynnistyksessä ei hukkaa ajastinta (laite pitää sen)', async () => {
  setTimerRepoForTests({
    isPersistent: () => true,
    insert: async () => ({ ok: false, error: { cause: { message: 'Failed to fetch' } } }),
    update: async () => ({ ok: true }), remove: async () => ({ ok: true })
  });
  const result = await startTracking({ kind: 'none' }, { now: T0 });
  assert.equal(result.ok, true);
  assert.ok(loadTimer(USER_A.id));
});

test('kanta voittaa laitteen: toisella laitteella käynnistetty ajastin näkyy latauksessa', async () => {
  saveTimer(USER_A.id, { id: 'local', startedAt: new Date(T0).toISOString(), targetKind: 'none' });
  setTimerRepoForTests(null);
  // Portti kiinni: muistivaraston tyhjä lista -> laitteen kopio.
  assert.equal(adoptLoadedTimers([]).id, 'local');
});

// ================================================================ NOPEA KIRJAUS

test('nopea kirjaus: sama operaatio kahdesti = yksi rivi', async () => {
  setTasks([task('t1')]);
  const op = newOperationId();
  const [a, b] = await Promise.all([
    logQuickTime({ target: { kind: 'task', id: 't1' }, minutes: 15, operationId: op, entryDate: '2026-09-21' }),
    logQuickTime({ target: { kind: 'task', id: 't1' }, minutes: 15, operationId: op, entryDate: '2026-09-21' })
  ]);
  assert.equal(a.ok && b.ok, true);
  assert.equal(getState().timeEntries.length, 1);
  assert.equal(getState().timeEntries[0].taskId, 't1');
});

test('kohde vain omasta tilasta: tuntematon tehtävä ei päädy kirjaukseen', () => {
  assert.equal(entryFieldsFor({ kind: 'task', id: 'toisen-kayttajan' }).taskId, null);
  // UUSI SÄÄNTÖ (offline F2): "Poistettu kohde" vasta, kun tehtävät on
  // ladattu. Ennen latausta laitteelta palautetun ajastimen kohde on vasta
  // tulossa, ei poistettu (ks. suunta-timer-races.test.mjs).
  assert.equal(describeTarget({ kind: 'task', id: 'poistettu' }), 'Ladataan kohdetta…');
  setDomainLoadStatus('tasks', true);
  assert.equal(describeTarget({ kind: 'task', id: 'poistettu' }), 'Poistettu kohde');
});

test('rutiinin esiintymä: identiteetti estää vahinkotuplan, lisäys on tietoinen', async () => {
  setRoutines([normalizeRoutine({
    id: 'r1', title: 'Juoksu', recurrence: { type: 'daily' }, durationMinutes: 30, active: true, startDate: '2026-01-01'
  })]);
  const first = occurrenceOperationId('r1', '2026-09-21');
  assert.equal(first, OPERATION.routineOccurrence('r1', '2026-09-21'));
  await logQuickTime({ target: { kind: 'routine', id: 'r1', occurrenceDate: '2026-09-21' }, minutes: 30, operationId: first });
  const again = await logQuickTime({ target: { kind: 'routine', id: 'r1', occurrenceDate: '2026-09-21' }, minutes: 30, operationId: first });
  assert.equal(again.duplicate, true, 'sama esiintymä samalla operaatiolla ei kirjaudu kahdesti');
  assert.equal(loggedMinutesForOccurrence('r1', '2026-09-21'), 30);
  const more = occurrenceOperationId('r1', '2026-09-21');
  assert.notEqual(more, first, 'tietoinen lisäys saa uuden tunnisteen');
  await logQuickTime({ target: { kind: 'routine', id: 'r1', occurrenceDate: '2026-09-21' }, minutes: 15, operationId: more });
  assert.equal(loggedMinutesForOccurrence('r1', '2026-09-21'), 45);
  assert.equal(getState().timeEntries[0].entryDate, '2026-09-21', 'esiintymän päivä on kirjauksen päivä');
});

test('rutiinin kirjaus kuuluu rutiinin alueeseen analyysissa', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(2026, 8, 24, 12).getTime() });
  await createLifeArea({ name: 'Terveys', importance: 4, targetMinutesPerWeek: 300, categoryKey: 'hyvinvointi' });
  setRoutines([normalizeRoutine({
    id: 'r1', title: 'Juoksu', category: 'hyvinvointi', recurrence: { type: 'daily' }, durationMinutes: 30,
    active: true, startDate: '2026-01-01'
  })]);
  await logQuickTime({ target: { kind: 'routine', id: 'r1', occurrenceDate: '2026-09-22' }, minutes: 40 });
  const analysis = analyzeCurrentWeek(null);
  assert.equal(analysis.areas[0].actualMinutes, 40);
  assert.equal(analysis.unassigned.actualMinutes, 0);
});

// ================================================================ OFFLINE

function persistentFakeRepo(script) {
  const rows = new Map();
  const calls = [];
  return {
    calls, rows,
    isPersistent: () => true,
    async insert(entry) {
      calls.push(entry.operationId);
      const step = script.shift() || 'ok';
      if (step === 'network') return { ok: false, error: { cause: { message: 'Failed to fetch' } } };
      if (step === 'reject') return { ok: false, error: { cause: { code: '23514', message: 'check' } } };
      if (step === 'fk') return { ok: false, error: { cause: { code: '23503', message: 'fk' } } };
      if ([...rows.values()].some(row => row.operationId === entry.operationId)) {
        return { ok: false, error: { cause: { code: '23505' } } };
      }
      rows.set(entry.id, entry);
      return { ok: true, value: entry };
    }
  };
}

function writerFor(repo) {
  return createTimeEntryWriter({
    repo, loadOutbox, saveOutbox,
    userId: () => USER_A.id, snapshot: sessionSnapshot, isSameSession: () => true
  });
}

test('offline: kirjaus jää lähtökoriin eikä katoa; uusinta ei monista', async () => {
  const repo = persistentFakeRepo(['network']);
  setTimeEntryWriterForTests(writerFor(repo));
  const result = await logTime({ entryDate: '2026-09-21', minutes: 25, operationId: 'log:offline-1' });
  assert.equal(result.queued, true);
  assert.equal(getState().timeEntries.length, 1, 'kirjaus näkyy heti');
  assert.equal(pendingTimeEntryCount(), 1);
  const first = await flushTimeOutbox();
  assert.deepEqual(first, { sent: 1, left: 0 });
  // Reconnect laukeaa toisen kerran: korissa ei ole mitään.
  assert.deepEqual(await flushTimeOutbox(), { sent: 0, left: 0 });
  assert.equal(repo.rows.size, 1);
});

test('offline: uusinta, joka törmää jo tallentuneeseen (23505), lasketaan perille menneeksi', async () => {
  const repo = persistentFakeRepo([]);
  repo.rows.set('earlier', { id: 'earlier', operationId: 'log:dup' });
  saveOutbox(USER_A.id, [{ id: 'retry', entryDate: '2026-09-21', minutes: 10, operationId: 'log:dup' }]);
  setTimeEntryWriterForTests(writerFor(repo));
  assert.deepEqual(await flushTimeOutbox(), { sent: 1, left: 0 });
  assert.equal(repo.rows.size, 1, 'ei kaksoiskappaletta');
});

test('offline: verkko katkeaa kesken uusinnan -> loput jäävät koriin järjestyksessä', async () => {
  const repo = persistentFakeRepo(['ok', 'network']);
  saveOutbox(USER_A.id, ['a', 'b', 'c'].map(id => ({ id, entryDate: '2026-09-21', minutes: 5, operationId: `log:${id}` })));
  setTimeEntryWriterForTests(writerFor(repo));
  assert.deepEqual(await flushTimeOutbox(), { sent: 1, left: 2 });
  assert.deepEqual(loadOutbox(USER_A.id).map(e => e.operationId), ['log:b', 'log:c']);
});

test('offline: palvelimen hylkäämää ei uusita loputtomiin', async () => {
  const repo = persistentFakeRepo(['reject']);
  saveOutbox(USER_A.id, [{ id: 'x', entryDate: '2026-09-21', minutes: 5, operationId: 'log:x' }]);
  const writer = writerFor(repo);
  const result = await writer.flush();
  assert.equal(result.rejected.length, 1);
  assert.equal(loadOutbox(USER_A.id).length, 0);
});

test('offline: ajastimen pysäytys ilman verkkoa ei hukkaa aikaa', async () => {
  const repo = persistentFakeRepo(['network']);
  setTimeEntryWriterForTests(writerFor(repo));
  await startTracking({ kind: 'none' }, { now: T0 });
  const stop = await stopTracking({ now: T0 + 40 * MIN });
  assert.equal(stop.ok, true);
  assert.equal(currentTimer(), null, 'ajastin voi poistua: kirjaus on korissa');
  assert.equal(loadOutbox(USER_A.id)[0].minutes, 40);
  assert.equal(loadOutbox(USER_A.id)[0].operationId, OPERATION.timer(stop.entries[0].operationId.slice(6)));
});

test('offline: istunto vaihtuu kesken uusinnan -> ei lähetetä toisen käyttäjän nimissä', async () => {
  const repo = persistentFakeRepo([]);
  saveOutbox(USER_A.id, [{ id: 'x', entryDate: '2026-09-21', minutes: 5, operationId: 'log:x' }]);
  const writer = createTimeEntryWriter({
    repo, loadOutbox, saveOutbox, userId: () => USER_A.id, snapshot: () => 1, isSameSession: () => false
  });
  const result = await writer.flush();
  assert.equal(result.aborted, true);
  assert.equal(repo.calls.length, 0);
});

// ================================================================ KOHDEASETUKSET

test('kohdeasetukset: kuormittavuus tallentuu, tyhjä rivi poistuu, tuntematon kohde hylätään', async () => {
  setTasks([task('t1')]);
  assert.equal((await saveItemSettings('task', 'ei-ole', { energyDemand: 3 })).ok, false);
  const saved = await saveItemSettings('task', 't1', { energyDemand: 4, estimateApproximate: true });
  assert.equal(saved.ok, true);
  assert.equal(itemSettingsFor('task', 't1').energyDemand, 4);
  const updated = await saveItemSettings('task', 't1', { energyDemand: null, estimateApproximate: false });
  assert.equal(updated.settings, null);
  assert.equal(getState().alignmentItemSettings.length, 0, 'tyhjää riviä ei jätetä');
  setProjects([normalizeProject({ id: 'p1', name: 'P', status: 'active' })]);
  assert.equal((await saveItemSettings('project', 'p1', { energyDemand: 5 })).ok, true);
});

// ================================================================ VALMISTUMINEN

test('valmistuminen tarjoaa kirjausta mutta EI kirjaa aikaa itse', async () => {
  setTasks([task('t1')]);
  const offered = [];
  setCompletionHook(done => offered.push(done.id));
  await toggleComplete('t1');
  assert.deepEqual(offered, ['t1']);
  assert.equal(getState().timeEntries.length, 0, 'valmis != toteutunut aika');
  await toggleComplete('t1'); // takaisin kesken: ei kysytä
  assert.deepEqual(offered, ['t1']);
});

// ================================================================ KATSELMOINNIN LÖYDÖKSET

function persistentTimerRepo({ removeFails = false, updateFails = false } = {}) {
  const rows = new Map();
  return {
    rows, removed: [], removeFails, updateFails,
    isPersistent: () => true,
    async insert(timer) { rows.set(timer.id, timer); return { ok: true }; },
    async update(timer) {
      if (this.updateFails) return { ok: false, error: { cause: { message: "Failed to fetch" } } };
      rows.set(timer.id, timer); return { ok: true };
    },
    async remove(id) {
      this.removed.push(id);
      if (this.removeFails) return { ok: false, error: { cause: { message: "Failed to fetch" } } };
      rows.delete(id); return { ok: true };
    }
  };
}

test('REGRESSIO: offline-pysäytetty ajastin ei herää henkiin kannasta latauksessa', async () => {
  const repo = persistentTimerRepo({ removeFails: true });
  setTimerRepoForTests(repo);
  await startTracking({ kind: 'none' }, { now: T0 });
  const timer = currentTimer();
  await stopTracking({ now: T0 + 30 * MIN });
  assert.deepEqual(loadTombstones(USER_A.id), [timer.id], 'poisto ei mennyt perille: hautakivi laitteelle');
  resetState(); // uudelleenlataus
  repo.removeFails = false;
  adoptLoadedTimers([...repo.rows.values()]);
  assert.equal(currentTimer(), null, 'kannasta palannut, jo pysäytetty ajastin ohitetaan');
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(repo.removed.filter(id => id === timer.id).length >= 2, 'poisto yritetään uudelleen');
  assert.equal(repo.rows.has(timer.id), false, 'uusinta poisti rivin kannasta');
  // UUSI SÄÄNTÖ (offline F1): onnistunut poisto ei yksin pura hautakiveä,
  // koska ennen poistoa alkanut lataus voi yhä palauttaa rivin. Hautakivi
  // puretaan, kun seuraava (tuore) lista vahvistaa rivin puuttuvan.
  assert.deepEqual(loadTombstones(USER_A.id), [timer.id], 'hautakivi odottaa kannan vahvistusta');
  adoptLoadedTimers([...repo.rows.values()]);
  assert.deepEqual(loadTombstones(USER_A.id), [], 'hautakivi siivotaan, kun kannan lista vahvistaa poiston');
});

test('REGRESSIO: offline-tauko ei muutu työajaksi latauksessa (laitteen kopio voittaa samalle ajastimelle)', async () => {
  const repo = persistentTimerRepo({ updateFails: true });
  setTimerRepoForTests(repo);
  await startTracking({ kind: 'none' }, { now: T0 });
  await pauseTracking({ now: T0 + 10 * MIN });
  resetState();
  const adopted = adoptLoadedTimers([...repo.rows.values()]);
  assert.ok(adopted.pausedAt, 'laitteen tauko säilyy');
  const stop = await stopTracking({ now: T0 + 90 * MIN });
  assert.equal(stop.totalMinutes, 10);
});

test('REGRESSIO: jo pysäytetty ajastin (sama operaatio tilassa) ei kirjaa uudelleen, vaikka osia olisi eri määrä', async () => {
  const start = new Date(2026, 8, 20, 22, 0).getTime();
  await startTracking({ kind: 'none' }, { now: start });
  const timer = currentTimer();
  await stopTracking({ now: start + 110 * MIN }); // 23.50, yksi osa
  saveTimer(USER_A.id, timer);
  restoreLocalTimer();
  const again = await stopTracking({ now: start + 150 * MIN }); // 00.30, kaksi osaa
  assert.equal(again.duplicate, true);
  assert.equal(getState().timeEntries.length, 1);
  assert.equal(getState().timeEntries[0].minutes, 110);
});

test('REGRESSIO: uloskirjautuminen kesken pysäytyksen ei kirjaa A:n aikaa B:lle', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const repo = {
    isPersistent: () => true,
    async insert(entry) { await gate; return { ok: true, value: entry }; }
  };
  setTimeEntryWriterForTests(createTimeEntryWriter({
    repo, loadOutbox, saveOutbox, userId: () => USER_A.id
  }));
  const start = new Date(2026, 8, 20, 23, 30).getTime();
  await startTracking({ kind: 'none' }, { now: start });
  const pending = stopTracking({ now: start + 75 * MIN }); // kaksi osaa
  signOut();
  resetState();
  setUser(USER_B);
  release();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.code, 'timer.session_changed');
  assert.ok(loadTimer(USER_A.id), 'A:n ajastin säilyy A:n avaimella');
});

test('REGRESSIO: rutiinin lisäkirjaus poiston jälkeen ei katoa kaksoiskappaleena', async () => {
  setRoutines([normalizeRoutine({
    id: 'r1', title: 'Juoksu', recurrence: { type: 'daily' }, durationMinutes: 30, active: true, startDate: '2026-01-01'
  })]);
  const target = { kind: 'routine', id: 'r1', occurrenceDate: '2026-09-21' };
  await logQuickTime({ target, minutes: 30, operationId: occurrenceOperationId('r1', '2026-09-21') });
  const second = await logQuickTime({ target, minutes: 10, operationId: occurrenceOperationId('r1', '2026-09-21') });
  assert.equal(second.ok && !second.duplicate, true);
  const first = getState().timeEntries.find(e => e.minutes === 30);
  await deleteTimeEntry(first.id);
  const third = await logQuickTime({ target, minutes: 20, operationId: occurrenceOperationId('r1', '2026-09-21') });
  assert.equal(third.duplicate, undefined, 'uusi kirjaus ei törmää');
  assert.equal(loggedMinutesForOccurrence('r1', '2026-09-21'), 30);
});

test('REGRESSIO: kohde poistui ennen lähetystä (23503) -> minuutit säilyvät ilman kohdetta', async () => {
  const repo = persistentFakeRepo(['network', 'fk']);
  setTimeEntryWriterForTests(writerFor(repo));
  setTasks([task('t1')]);
  const queued = await logTime({ entryDate: '2026-09-21', minutes: 25, taskId: 't1', operationId: 'log:fk-1' });
  assert.equal(queued.queued, true);
  const flushed = await flushTimeOutbox();
  assert.equal(flushed.sent, 1);
  const stored = [...repo.rows.values()][0];
  assert.equal(stored.minutes, 25);
  assert.equal(stored.taskId, null, 'kohde irrotettiin, aika säilyi');
  assert.equal(getState().timeEntries[0].taskId, null, 'tila vastaa kantaa');
});

test('REGRESSIO: kannan kaksoiskappale (23505) ei jätä paikallista kopiota tilaan', async () => {
  const repo = persistentFakeRepo([]);
  repo.rows.set('db-row', { id: 'db-row', operationId: 'log:same' });
  setTimeEntryWriterForTests(writerFor(repo));
  const result = await logTime({ entryDate: '2026-09-21', minutes: 5, operationId: 'log:same' });
  assert.equal(result.duplicate, true);
  assert.equal(getState().timeEntries.length, 0);
});

test('REGRESSIO: poistetun kohteen ajastin palaa näkyväksi yleisenä, ei juutu piiloon', () => {
  const repo = persistentTimerRepo();
  setTimerRepoForTests(repo);
  const adopted = adoptLoadedTimers([{ id: 'orphan', targetKind: 'task', taskId: null, startedAt: new Date(T0).toISOString() }]);
  assert.equal(adopted.id, 'orphan');
  assert.equal(adopted.targetKind, 'none');
});

test('hautakivet ovat käyttäjäkohtaisia ja poistuvat tilin poistossa', () => {
  globalThis.localStorage.setItem(tombstoneKey(USER_A.id), JSON.stringify({ v: 1, userId: USER_A.id, ids: ['x'] }));
  assert.deepEqual(loadTombstones(USER_B.id), []);
  globalThis.localStorage.setItem(tombstoneKey(USER_B.id), globalThis.localStorage.getItem(tombstoneKey(USER_A.id)));
  assert.deepEqual(loadTombstones(USER_B.id), [], 'toisen käyttäjän sisältö hylätään');
  purgeTimerData(USER_A.id);
  assert.equal(globalThis.localStorage.getItem(tombstoneKey(USER_A.id)), null);
});
