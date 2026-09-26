// Offline-jono: domain, tallennus ja turvarajat.
//
// PURE-testit: ei verkkoa, ei kelloa (aika annetaan), ei satunnaisuutta.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { read, readCode } from './helpers/sources.mjs';
import {
  QUEUE_VERSION, OP_STATUS, ALLOWED_OPERATIONS, FORBIDDEN_OPERATIONS, MAX_OPERATIONS, MAX_RETRIES,
  MAX_PAYLOAD_CHARS, BACKOFF_BASE_MS, BACKOFF_MAX_MS, ERROR_CLASS, QUEUE_TASK_FIELDS,
  emptyQueue, createOperation, enqueue, nextRunnable, markSyncing, markSucceeded, markPaused,
  markRetry, markFailed, markConflict, retryOperation, resolveKeepMine, discardOperation,
  recoverInterrupted, queueStats, classifyError, decideUpdate, overlayPending, pendingEntityIds,
  serializeQueue, parseQueue, backoffMs, describeQueueStatus
} from '../src/domain/offlineQueue.js';
import { normalizeTask } from '../src/domain/task.js';
import {
  queueKey, loadQueueText, saveQueueText, purgeQueue, resetQueueStoreForTests
} from '../src/data/offlineQueueStore.js';

const USER = 'aaaaaaaa-1111-4111-8111-000000000001';
const NOW = 1_800_000_000_000;

let counter = 0;
const newId = () => `op-${++counter}`;
beforeEach(() => { counter = 0; resetQueueStoreForTests(); });

function createSpec(overrides = {}) {
  return {
    id: newId(), domain: 'tasks', operation: 'create', entityId: 't1',
    payload: { title: 'Osta maitoa', date: '2026-09-20' }, now: NOW, ...overrides
  };
}
function makeOp(overrides = {}) {
  const created = createOperation(createSpec(overrides));
  assert.equal(created.ok, true, JSON.stringify(created));
  return created.op;
}
function queueWith(...ops) {
  let queue = emptyQueue(USER);
  for (const op of ops) {
    const result = enqueue(queue, op);
    assert.equal(result.ok, true);
    queue = result.queue;
  }
  return queue;
}

// ------------------------------------------------------------ allowlist

test('KRIITTINEN: vain tehtävän lisäys ja muokkaus ovat sallittuja', () => {
  assert.deepEqual(Object.keys(ALLOWED_OPERATIONS), ['tasks']);
  assert.deepEqual([...ALLOWED_OPERATIONS.tasks].sort(), ['create', 'update']);
});

test('KRIITTINEN: jokainen kielletty operaatio hylätään, mistä tahansa domainista', () => {
  for (const operation of FORBIDDEN_OPERATIONS) {
    for (const domain of ['tasks', 'bills', 'finance', 'account', 'ai', 'goals', 'routines']) {
      const result = createOperation(createSpec({ domain, operation }));
      assert.equal(result.ok, false, `${domain}.${operation}`);
      assert.equal(result.reason, 'operation_not_allowed');
    }
  }
  for (const operation of FORBIDDEN_OPERATIONS) {
    assert.equal(ALLOWED_OPERATIONS.tasks.includes(operation), false, operation);
  }
});

test('poisto, laskun maksu, AI-komento ja tilin poisto on nimetty kielletyiksi', () => {
  for (const name of ['delete', 'mark_bill_paid', 'ai_command', 'account_deletion', 'finance']) {
    assert.ok(FORBIDDEN_OPERATIONS.includes(name), name);
  }
});

test('prototyyppinimet eivät läpäise domain- eikä operaatiotarkistusta', () => {
  for (const domain of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    assert.equal(createOperation(createSpec({ domain })).ok, false, domain);
  }
  for (const operation of ['__proto__', 'constructor', 'toString']) {
    assert.equal(createOperation(createSpec({ operation })).ok, false, operation);
  }
});

// ------------------------------------------------------- kenttärajaus

test('KRIITTINEN: vain tehtäväkentät pääsevät jonoon; tunnisteet, tokenit ja user_id putoavat', () => {
  // JSON.parse luo OMAN __proto__-avaimen (kirjaimellinen __proto__: asettaisi prototyypin).
  const payload = JSON.parse('{"title":"Otsikko","date":"2026-09-20","user_id":"x","userId":"x","access_token":"SECRET",'
    + '"token":"SECRET","password":"SECRET","apiKey":"SECRET","service_role":"SECRET","authorization":"Bearer SECRET",'
    + '"id":"toinen","createdAt":"x","updatedAt":"x","__proto__":{"polluted":true},"constructor":"x","kummallinen":1}');
  const created = createOperation(createSpec({ payload }));
  assert.equal(created.ok, true);
  assert.deepEqual(Object.keys(created.op.payload).sort(), ['date', 'title']);
  assert.equal(JSON.stringify(created.op).includes('SECRET'), false);
  assert.equal({}.polluted, undefined);
});

test('kenttälista johdetaan normalizeTaskista eikä sisällä tunnisteita tai aikaleimoja', () => {
  for (const banned of ['id', 'createdAt', 'updatedAt']) assert.equal(QUEUE_TASK_FIELDS.includes(banned), false, banned);
  for (const field of ['title', 'date', 'time', 'completed', 'priority']) assert.ok(QUEUE_TASK_FIELDS.includes(field), field);
  assert.ok(Object.isFrozen(QUEUE_TASK_FIELDS));
});

test('vain skalaariarvot: oliot, taulukot, funktiot ja epäluvut pudotetaan', () => {
  const created = createOperation(createSpec({
    payload: { title: 'x', note: { a: 1 }, description: ['a'], priority: () => 1, durationMinutes: NaN, deadline: Infinity, date: '2026-09-20' }
  }));
  assert.deepEqual(Object.keys(created.op.payload).sort(), ['date', 'title']);
});

test('tyhjä, otsikoton ja liian suuri payload hylätään', () => {
  assert.equal(createOperation(createSpec({ payload: {} })).reason, 'empty_payload');
  assert.equal(createOperation(createSpec({ payload: { user_id: 'x' } })).reason, 'empty_payload');
  assert.equal(createOperation(createSpec({ payload: { date: '2026-09-20' } })).reason, 'title_required');
  assert.equal(createOperation(createSpec({ payload: { title: 'x'.repeat(MAX_PAYLOAD_CHARS + 1) } })).reason, 'payload_too_large');
  assert.equal(createOperation(createSpec({ payload: 'ei olio' })).reason, 'empty_payload');
  assert.equal(createOperation(createSpec({ payload: null })).reason, 'empty_payload');
});

test('virheellinen tunniste, kohde tai aika hylätään', () => {
  assert.equal(createOperation(createSpec({ id: '' })).reason, 'invalid_id');
  assert.equal(createOperation(createSpec({ id: 5 })).reason, 'invalid_id');
  assert.equal(createOperation(createSpec({ id: 'x'.repeat(101) })).reason, 'invalid_id');
  assert.equal(createOperation(createSpec({ entityId: '' })).reason, 'invalid_entity');
  assert.equal(createOperation(createSpec({ entityId: null })).reason, 'invalid_entity');
  assert.equal(createOperation(createSpec({ now: NaN })).reason, 'invalid_time');
  assert.equal(createOperation(createSpec({ now: undefined })).reason, 'invalid_time');
  assert.equal(createOperation().ok, false);
});

// ------------------------------------------------------------ jono

test('enqueue: järjestysnumero kasvaa ja jono ei muutu annettua (immutable)', () => {
  const start = emptyQueue(USER);
  const a = enqueue(start, makeOp({ entityId: 'a' }));
  const b = enqueue(a.queue, makeOp({ entityId: 'b' }));
  assert.equal(start.ops.length, 0);
  assert.equal(a.queue.ops.length, 1);
  assert.deepEqual(b.queue.ops.map(op => op.seq), [1, 2]);
});

test('KRIITTINEN: sama operaatiotunniste kahdesti on sama operaatio (idempotentti)', () => {
  const op = makeOp();
  const first = enqueue(emptyQueue(USER), op);
  const second = enqueue(first.queue, op);
  assert.equal(second.queue.ops.length, 1);
  assert.equal(second.coalesced, true);
});

test('täysi jono ei pudota mitään hiljaa: ok:false', () => {
  let queue = emptyQueue(USER);
  for (let i = 0; i < MAX_OPERATIONS; i += 1) queue = enqueue(queue, makeOp({ entityId: 'e' + i })).queue;
  assert.equal(queue.ops.length, MAX_OPERATIONS);
  const overflow = enqueue(queue, makeOp({ entityId: 'yli' }));
  assert.equal(overflow.ok, false);
  assert.equal(overflow.reason, 'queue_full');
  assert.equal(overflow.queue.ops.length, MAX_OPERATIONS);
});

test('muokkaus yhdistyy vielä lähettämättömään luontiin (palvelin ei näe välivaihetta)', () => {
  const create = makeOp({ payload: { title: 'Alku', date: '2026-09-20' } });
  let queue = enqueue(emptyQueue(USER), create).queue;
  const update = makeOp({ operation: 'update', payload: { title: 'Loppu' }, baseValues: { title: 'Alku' } });
  const result = enqueue(queue, update);
  assert.equal(result.coalesced, true);
  assert.equal(result.queue.ops.length, 1);
  assert.equal(result.queue.ops[0].operation, 'create');
  assert.equal(result.queue.ops[0].payload.title, 'Loppu');
  assert.equal(result.queue.ops[0].payload.date, '2026-09-20');
});

test('peräkkäiset muokkaukset yhdistyvät ja vanhin perusarvo säilyy', () => {
  const first = makeOp({ operation: 'update', payload: { title: 'B' }, baseValues: { title: 'A' } });
  const second = makeOp({ operation: 'update', payload: { title: 'C', note: 'n' }, baseValues: { title: 'B', note: null } });
  const merged = enqueue(enqueue(emptyQueue(USER), first).queue, second);
  assert.equal(merged.queue.ops.length, 1);
  const [op] = merged.queue.ops;
  assert.deepEqual(op.payload, { title: 'C', note: 'n' });
  assert.equal(op.baseValues.title, 'A', 'ensimmäisen muutoksen perusarvo, ei välivaiheen');
  assert.equal(op.baseValues.note, null);
});

test('käynnissä oleva tai ratkaisematon operaatio ei yhdisty: uusi muutos lisätään perään', () => {
  for (const mutate of [q => markSyncing(q, 'op-a'), q => markConflict(q, 'op-a', {}), q => markFailed(q, 'op-a', 'x')]) {
    const base = makeOp({ id: 'op-a', operation: 'update', payload: { title: 'B' }, baseValues: { title: 'A' } });
    const queue = mutate(enqueue(emptyQueue(USER), base).queue);
    const next = enqueue(queue, makeOp({ operation: 'update', payload: { title: 'C' }, baseValues: { title: 'B' } }));
    assert.equal(next.queue.ops.length, 2);
    assert.equal(next.coalesced, false);
  }
});

test('eri rivien muokkaukset eivät yhdisty keskenään', () => {
  const a = makeOp({ entityId: 'a', operation: 'update', payload: { title: 'x' }, baseValues: { title: 'y' } });
  const b = makeOp({ entityId: 'b', operation: 'update', payload: { title: 'x' }, baseValues: { title: 'y' } });
  assert.equal(queueWith(a, b).ops.length, 2);
});

// ------------------------------------------------------ järjestys

test('nextRunnable: lisäysjärjestys, ja käynnissä olevaa ei valita uudelleen', () => {
  const queue = queueWith(makeOp({ entityId: 'a' }), makeOp({ entityId: 'b' }), makeOp({ entityId: 'c' }));
  assert.equal(nextRunnable(queue, NOW).entityId, 'a');
  const running = markSyncing(queue, queue.ops[0].id);
  assert.equal(nextRunnable(running, NOW).entityId, 'b');
  assert.equal(nextRunnable(emptyQueue(USER), NOW), null);
});

test('KRIITTINEN: myöhäinen muutos ei ohita saman rivin aiempaa epäonnistunutta', () => {
  const create = makeOp({ id: 'c1', entityId: 't1' });
  const update = makeOp({ id: 'u1', entityId: 't1', operation: 'update', payload: { title: 'B' }, baseValues: { title: 'A' } });
  const other = makeOp({ id: 'c2', entityId: 't2' });
  let queue = queueWith(create, other);
  queue = enqueue(markSyncing(queue, 'c1'), update).queue; // c1 käynnissä -> ei yhdisty
  queue = markFailed(queue, 'c1', 'rejected');

  const next = nextRunnable(queue, NOW);
  assert.equal(next.id, 'c2', 'toinen rivi etenee, mutta t1:n muutos odottaa epäonnistunutta luontia');
  assert.equal(queue.ops.find(op => op.id === 'u1').status, OP_STATUS.PENDING);
  assert.equal(nextRunnable(markSucceeded(queue, 'c2'), NOW), null, 'ei ajettavaa: u1 on estetty');
});

test('odotusaika: operaatiota ei ajeta ennen nextAttemptAt', () => {
  const queue = queueWith(makeOp({ id: 'a', entityId: 'a' }), makeOp({ id: 'b', entityId: 'b' }));
  const waiting = markRetry(queue, 'a', { code: 'unknown', nowMs: NOW });
  assert.equal(nextRunnable(waiting, NOW).id, 'b', 'a odottaa, b saa mennä');
  assert.equal(nextRunnable(markSucceeded(waiting, 'b'), NOW), null);
  assert.equal(nextRunnable(markSucceeded(waiting, 'b'), NOW + BACKOFF_BASE_MS * 2).id, 'a');
});

test('backoff kaksinkertaistuu ja on katettu', () => {
  assert.equal(backoffMs(0), BACKOFF_BASE_MS);
  assert.equal(backoffMs(1), BACKOFF_BASE_MS * 2);
  assert.equal(backoffMs(2), BACKOFF_BASE_MS * 4);
  assert.equal(backoffMs(50), BACKOFF_MAX_MS);
  assert.equal(backoffMs(-3), BACKOFF_BASE_MS);
  assert.equal(backoffMs(NaN), BACKOFF_BASE_MS);
  assert.equal(backoffMs('x'), BACKOFF_BASE_MS);
});

// --------------------------------------------------- tilasiirtymät

test('markRetry kuluttaa yrityksen ja päättyy FAILEDiin, ei koskaan poistoon', () => {
  let queue = queueWith(makeOp({ id: 'a' }));
  for (let i = 1; i < MAX_RETRIES; i += 1) {
    queue = markRetry(queue, 'a', { code: 'unknown', nowMs: NOW });
    assert.equal(queue.ops[0].status, OP_STATUS.PENDING);
    assert.equal(queue.ops[0].retryCount, i);
  }
  queue = markRetry(queue, 'a', { code: 'unknown', nowMs: NOW });
  assert.equal(queue.ops[0].status, OP_STATUS.FAILED);
  assert.equal(queue.ops.length, 1, 'epäonnistunut pysyy jonossa näkyvänä');
});

test('markPaused (verkko/istunto) ei kuluta yrityksiä', () => {
  let queue = queueWith(makeOp({ id: 'a' }));
  for (let i = 0; i < 20; i += 1) queue = markPaused(markSyncing(queue, 'a'), 'a', 'network');
  assert.equal(queue.ops[0].retryCount, 0);
  assert.equal(queue.ops[0].status, OP_STATUS.PENDING);
  assert.equal(queue.ops[0].lastErrorCode, 'network');
});

test('konflikti, valinta "käytä omaani" ja hylkäys', () => {
  let queue = queueWith(makeOp({ id: 'a', operation: 'update', payload: { title: 'B' }, baseValues: { title: 'A' } }));
  queue = markConflict(queue, 'a', { fields: ['title', 'ei_kenttä'], reason: 'changed_on_server' });
  assert.equal(queue.ops[0].status, OP_STATUS.CONFLICT);
  assert.deepEqual(queue.ops[0].conflictFields, ['title'], 'tuntematon kenttä suodatetaan');
  assert.equal(nextRunnable(queue, NOW), null, 'ristiriitaista ei ajeta itsestään');

  const mine = resolveKeepMine(queue, 'a');
  assert.equal(mine.ops[0].status, OP_STATUS.PENDING);
  assert.equal(mine.ops[0].force, true);

  assert.equal(discardOperation(queue, 'a').ops.length, 0);
  assert.equal(resolveKeepMine(markSucceeded(queue, 'zzz'), 'a').ops[0].force, true);
});

test('retryOperation toimii vain epäonnistuneelle', () => {
  let queue = queueWith(makeOp({ id: 'a' }));
  assert.equal(retryOperation(queue, 'a').ops[0].status, OP_STATUS.PENDING);
  queue = markFailed(queue, 'a', 'rejected');
  const retried = retryOperation(queue, 'a');
  assert.equal(retried.ops[0].status, OP_STATUS.PENDING);
  assert.equal(retried.ops[0].retryCount, 0);
  assert.equal(resolveKeepMine(queue, 'a').ops[0].force, false, 'ei-konfliktille ei voi valita omaa');
});

test('recoverInterrupted: kesken jäänyt SYNCING palautuu odottamaan', () => {
  const queue = markSyncing(queueWith(makeOp({ id: 'a' })), 'a');
  assert.equal(queue.ops[0].status, OP_STATUS.SYNCING);
  assert.equal(recoverInterrupted(queue).ops[0].status, OP_STATUS.PENDING);
});

test('queueStats laskee tilat ja tarkistettavat', () => {
  let queue = queueWith(makeOp({ id: 'a', entityId: 'a' }), makeOp({ id: 'b', entityId: 'b' }),
    makeOp({ id: 'c', entityId: 'c' }), makeOp({ id: 'd', entityId: 'd' }));
  queue = markSyncing(queue, 'a');
  queue = markFailed(queue, 'b', 'x');
  queue = markConflict(queue, 'c', {});
  assert.deepEqual(queueStats(queue), { total: 4, pending: 1, syncing: 1, failed: 1, conflict: 1, needsReview: 2 });
});

// ------------------------------------------------------ virheluokitus

test('classifyError: verkko, istunto, kaksoiskappale, hylkäys ja tuntematon', () => {
  const cases = [
    [{ message: 'TypeError: Failed to fetch', code: '' }, ERROR_CLASS.NETWORK],
    [{ message: 'NetworkError when attempting to fetch resource.' }, ERROR_CLASS.NETWORK],
    [{ message: 'Load failed' }, ERROR_CLASS.NETWORK],
    [{ message: 'The operation was aborted due to timeout' }, ERROR_CLASS.NETWORK],
    [{ message: 'getaddrinfo ENOTFOUND x.supabase.co' }, ERROR_CLASS.NETWORK],
    [{ message: 'JWT expired', code: 'PGRST301' }, ERROR_CLASS.AUTH],
    [{ message: 'invalid token', code: '' }, ERROR_CLASS.AUTH],
    [{ message: 'x', status: 401 }, ERROR_CLASS.AUTH],
    [{ message: 'Refresh Token Not Found' }, ERROR_CLASS.AUTH],
    [{ message: 'duplicate key', code: '23505' }, ERROR_CLASS.DUPLICATE],
    [{ message: 'check violation', code: '23514' }, ERROR_CLASS.REJECTED],
    [{ message: 'not null', code: '23502' }, ERROR_CLASS.REJECTED],
    [{ message: 'RLS', code: '42501' }, ERROR_CLASS.REJECTED],
    [{ message: 'no rows', code: 'PGRST116' }, ERROR_CLASS.REJECTED],
    [{ message: 'bad request', status: 400, code: '' }, ERROR_CLASS.REJECTED],
    // Aiemmin UNKNOWN. Uusi sääntö: tila 5xx ilman tunnettua koodia on
    // palvelimen tilapäinen häiriö (UNAVAILABLE), jota uusitaan viiveellä
    // -- ei hylätä eikä pudoteta.
    [{ message: 'salaperäinen', code: 'x', status: 500 }, ERROR_CLASS.UNAVAILABLE],
    [{ message: 'salaperäinen', code: 'x' }, ERROR_CLASS.UNKNOWN]
  ];
  for (const [error, expected] of cases) assert.equal(classifyError(error), expected, JSON.stringify(error));
});

test('classifyError: skeemavirhe ja tilapäinen häiriö erotetaan hylkäyksestä', () => {
  // Taulukko: [virhe, odotettu luokka]. Skeema ja häiriö tarkistetaan
  // ENNEN yleistä hylkäyssääntöä: niiden toisto onnistuu myöhemmin.
  const cases = [
    [{ code: 'PGRST204', message: "Could not find the 'milestone_id' column of 'tasks' in the schema cache", status: 400 }, ERROR_CLASS.SCHEMA],
    [{ code: 'PGRST205', message: "Could not find the table 'public.time_entries' in the schema cache", status: 404 }, ERROR_CLASS.SCHEMA],
    [{ code: '42703', message: 'column tasks.milestone_id does not exist' }, ERROR_CLASS.SCHEMA],
    [{ code: '42P01', message: 'relation "public.time_entries" does not exist' }, ERROR_CLASS.SCHEMA],
    // Sovelluksen oma kieltäytyminen (ominaisuus ei käytössä / huoltokatko).
    [{ code: 'persistence_unavailable', message: 'x' }, ERROR_CLASS.SCHEMA],
    [{ code: 'PGRST000', status: 503 }, ERROR_CLASS.UNAVAILABLE],
    [{ code: 'PGRST001', status: 503 }, ERROR_CLASS.UNAVAILABLE],
    [{ code: 'PGRST002', message: 'Could not query the database for the schema cache. Retrying.', status: 503 }, ERROR_CLASS.UNAVAILABLE],
    [{ code: 'PGRST003', status: 504 }, ERROR_CLASS.UNAVAILABLE],
    [{ code: '08006' }, ERROR_CLASS.UNAVAILABLE],
    [{ code: '08001' }, ERROR_CLASS.UNAVAILABLE],
    [{ code: '53300', message: 'too many connections' }, ERROR_CLASS.UNAVAILABLE],
    [{ code: '53100' }, ERROR_CLASS.UNAVAILABLE],
    [{ code: '57014', message: 'canceling statement due to statement timeout' }, ERROR_CLASS.UNAVAILABLE],
    [{ code: '57P01' }, ERROR_CLASS.UNAVAILABLE],
    [{ code: '57P03' }, ERROR_CLASS.UNAVAILABLE],
    [{ code: '40001' }, ERROR_CLASS.UNAVAILABLE],
    [{ code: '40P01' }, ERROR_CLASS.UNAVAILABLE],
    [{ code: '55P03' }, ERROR_CLASS.UNAVAILABLE],
    [{ message: 'x', status: 503 }, ERROR_CLASS.UNAVAILABLE],
    [{ message: 'x', status: 502 }, ERROR_CLASS.UNAVAILABLE],
    [{ message: 'x', status: 408 }, ERROR_CLASS.UNAVAILABLE],
    [{ message: 'x', status: 425 }, ERROR_CLASS.UNAVAILABLE],
    [{ message: 'x', status: 429 }, ERROR_CLASS.UNAVAILABLE],
    // Nämä pysyvät hylkäyksinä: toisto ei auta.
    [{ code: '23514', status: 400 }, ERROR_CLASS.REJECTED],
    [{ code: '23503', status: 409 }, ERROR_CLASS.REJECTED],
    [{ code: '22P02', status: 400 }, ERROR_CLASS.REJECTED],
    [{ code: '42501', status: 403 }, ERROR_CLASS.REJECTED],
    [{ code: 'PGRST116', status: 406 }, ERROR_CLASS.REJECTED],
    // Istunto ja kaksoiskappale voittavat edelleen.
    [{ code: 'PGRST301', status: 401 }, ERROR_CLASS.AUTH],
    [{ code: '23505', status: 409 }, ERROR_CLASS.DUPLICATE]
  ];
  for (const [error, expected] of cases) {
    assert.equal(classifyError(error), expected, JSON.stringify(error));
    // AppError-kääre (repositorion palauttama) luokitellaan samoin.
    assert.equal(classifyError({ code: 'tasks.insert', cause: error }), expected, 'kääre: ' + JSON.stringify(error));
  }
  // Offline-lippu: koodillinen häiriö on yhä häiriö, koodition 5xx on verkko.
  assert.equal(classifyError({ code: 'PGRST002' }, { offline: true }), ERROR_CLASS.UNAVAILABLE);
  assert.equal(classifyError({ message: 'x', status: 503 }, { offline: true }), ERROR_CLASS.NETWORK);
});

test('classifyError: AppError-kääre luetaan .causesta, ja offline-lippu tulkitaan verkoksi', () => {
  assert.equal(classifyError({ cause: { message: 'Failed to fetch' } }), ERROR_CLASS.NETWORK);
  assert.equal(classifyError({ cause: { code: '23505' } }), ERROR_CLASS.DUPLICATE);
  assert.equal(classifyError({ cause: { code: '23514' } }, { offline: true }), ERROR_CLASS.REJECTED,
    'palvelimen hylkäys on hylkäys vaikka offline-lippu olisi päällä');
  assert.equal(classifyError({ message: 'outo', code: 'X', status: 500 }, { offline: true }), ERROR_CLASS.NETWORK);
  assert.equal(classifyError(null), ERROR_CLASS.NETWORK);
  assert.equal(classifyError(undefined, { offline: false }), ERROR_CLASS.NETWORK);
});

// -------------------------------------------------- konfliktin ratkaisu

test('decideUpdate: kolmisuuntainen vertailu', () => {
  const base = { title: 'A', note: null };
  assert.deepEqual(decideUpdate({ serverTask: { title: 'A', note: null }, baseValues: base, changes: { title: 'B' } }),
    { action: 'apply', patch: { title: 'B' } }, 'muuttumaton -> lähetä');
  assert.deepEqual(decideUpdate({ serverTask: { title: 'B', note: null }, baseValues: base, changes: { title: 'B' } }),
    { action: 'already_applied' }, 'jo tehty');
  assert.deepEqual(decideUpdate({ serverTask: { title: 'C', note: null }, baseValues: base, changes: { title: 'B' } }),
    { action: 'conflict', fields: ['title'] }, 'joku muutti');
  assert.deepEqual(decideUpdate({ serverTask: null, baseValues: base, changes: { title: 'B' } }), { action: 'missing' });
});

test('decideUpdate: monta kenttää -- yksi ristiriita pysäyttää koko muutoksen', () => {
  const result = decideUpdate({
    serverTask: { title: 'A', note: 'palvelimen' }, baseValues: { title: 'A', note: null }, changes: { title: 'B', note: 'oma' }
  });
  assert.deepEqual(result, { action: 'conflict', fields: ['note'] });
});

test('decideUpdate: force ohittaa konfliktin mutta ei tee jo tehtyä uudelleen', () => {
  assert.deepEqual(decideUpdate({ serverTask: { title: 'C' }, baseValues: { title: 'A' }, changes: { title: 'B' }, force: true }),
    { action: 'apply', patch: { title: 'B' } });
  assert.deepEqual(decideUpdate({ serverTask: { title: 'B' }, baseValues: { title: 'A' }, changes: { title: 'B' }, force: true }),
    { action: 'already_applied' });
});

test('decideUpdate: null, tyhjä merkkijono ja puuttuva ovat sama tyhjä arvo', () => {
  assert.equal(decideUpdate({ serverTask: { note: '' }, baseValues: { note: null }, changes: { note: 'x' } }).action, 'apply');
  assert.equal(decideUpdate({ serverTask: { note: null }, baseValues: { note: undefined }, changes: { note: 'x' } }).action, 'apply');
  assert.equal(decideUpdate({ serverTask: {}, baseValues: {}, changes: { note: null } }).action, 'already_applied');
});

// --------------------------------------------- näkymän päällekirjoitus

test('overlayPending: odottava luonti näkyy palvelimen listan päällä, eikä kahdennu', () => {
  const queue = queueWith(makeOp({ entityId: 'uusi', payload: { title: 'Paikallinen', date: '2026-09-21' } }));
  const server = [normalizeTask({ id: 'vanha', title: 'Vanha', date: '2026-09-20' })];

  const merged = overlayPending(server, queue);
  assert.deepEqual(merged.map(task => task.id), ['vanha', 'uusi']);
  assert.equal(merged[1].title, 'Paikallinen');

  // Rivi ehti jo palvelimelle: ei kaksoiskappaletta.
  const synced = overlayPending([...server, normalizeTask({ id: 'uusi', title: 'Paikallinen' })], queue);
  assert.equal(synced.filter(task => task.id === 'uusi').length, 1);
});

test('overlayPending: odottava muokkaus päällekirjoittaa, kadonneeseen riviin ei osuta', () => {
  const queue = queueWith(makeOp({ entityId: 'a', operation: 'update', payload: { title: 'Uusi' }, baseValues: { title: 'Vanha' } }),
    makeOp({ entityId: 'poistettu', operation: 'update', payload: { title: 'X' }, baseValues: { title: 'Y' } }));
  const merged = overlayPending([normalizeTask({ id: 'a', title: 'Vanha' })], queue);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].title, 'Uusi');
});

test('overlayPending ei muuta syötettä ja sietää rikkinäistä listaa', () => {
  const server = [normalizeTask({ id: 'a', title: 'A' })];
  const queue = queueWith(makeOp({ entityId: 'a', operation: 'update', payload: { title: 'B' }, baseValues: { title: 'A' } }));
  overlayPending(server, queue);
  assert.equal(server[0].title, 'A');
  assert.deepEqual(overlayPending(null, emptyQueue(USER)), []);
  assert.deepEqual(overlayPending(undefined, queue), []);
});

test('pendingEntityIds', () => {
  const ids = pendingEntityIds(queueWith(makeOp({ entityId: 'a' }), makeOp({ entityId: 'b' })));
  assert.deepEqual([...ids].sort(), ['a', 'b']);
});

// ------------------------------------------------------- sarjallistus

test('sarjallistus ja luku: pyöräytys säilyttää operaatiot ja järjestyksen', () => {
  let queue = queueWith(makeOp({ id: 'a', entityId: 'a' }), makeOp({ id: 'b', entityId: 'b', operation: 'update', payload: { title: 'B' }, baseValues: { title: 'A' } }));
  queue = markRetry(queue, 'a', { code: 'unknown', nowMs: NOW });
  const { queue: back, dropped, reason } = parseQueue(serializeQueue(queue), { userId: USER });
  assert.equal(dropped, 0);
  assert.equal(reason, null);
  assert.deepEqual(back.ops.map(op => [op.id, op.seq, op.status, op.retryCount]), queue.ops.map(op => [op.id, op.seq, op.status, op.retryCount]));
  assert.equal(back.userId, USER);
  assert.equal(serializeQueue(back), serializeQueue(back), 'deterministinen');
});

test('KRIITTINEN: toisen käyttäjän jono ei koskaan lataudu (userId-raja)', () => {
  const text = serializeQueue(queueWith(makeOp()));
  const other = parseQueue(text, { userId: 'bbbbbbbb-2222-4222-8222-000000000002' });
  assert.equal(other.queue.ops.length, 0);
  assert.equal(other.reason, 'wrong_user');
  assert.equal(other.dropped, 1);
  assert.equal(parseQueue(text, { userId: null }).queue.ops.length, 0);
  assert.equal(parseQueue(text, {}).queue.ops.length, 0);
});

test('KRIITTINEN: peukaloitu tallennus ei tuo salaisuuksia tai vieraita kenttiä jonoon', () => {
  const tampered = JSON.stringify({
    version: QUEUE_VERSION, userId: USER, seq: 1,
    ops: [{
      id: 'x1', seq: 1, domain: 'tasks', operation: 'create', entityId: 't1', createdAt: NOW, status: 'pending',
      retryCount: 0, payload: { title: 'Ok', user_id: 'toinen', access_token: 'SECRET', role: 'admin' }, baseValues: {}
    }]
  });
  const { queue } = parseQueue(tampered, { userId: USER });
  assert.deepEqual(Object.keys(queue.ops[0].payload), ['title']);
  assert.equal(serializeQueue(queue).includes('SECRET'), false);
});

test('rikkinäinen, tuntematon versio, vääränmuotoinen ja tyhjä sisältö -> tyhjä jono, ei kaadu', () => {
  for (const text of [null, undefined, '', 'ei json', '{', '[]', '{"version":99,"ops":[]}', '{"version":1,"userId":"' + USER + '"}', '"merkkijono"', '42']) {
    const result = parseQueue(text, { userId: USER });
    assert.equal(result.queue.ops.length, 0, String(text));
    assert.equal(result.queue.userId, USER);
  }
});

test('kelvottomat operaatiot pudotetaan ja määrä kerrotaan, kelvolliset säilyvät', () => {
  const good = { id: 'good', seq: 1, domain: 'tasks', operation: 'create', entityId: 't1', createdAt: NOW, status: 'pending', retryCount: 0, payload: { title: 'Hyvä' } };
  const bad = [
    { ...good, id: 'b1', operation: 'delete' }, { ...good, id: 'b2', domain: 'bills' }, { ...good, id: 'b3', status: 'valmis' },
    { ...good, id: 'b4', seq: 0 }, { ...good, id: 'b5', payload: {} }, { ...good, id: 'b6', createdAt: 'eilen' },
    { ...good, id: 'good' }, null, 'x', 5, []
  ];
  const text = JSON.stringify({ version: QUEUE_VERSION, userId: USER, seq: 9, ops: [good, ...bad] });
  const { queue, dropped } = parseQueue(text, { userId: USER });
  assert.deepEqual(queue.ops.map(op => op.id), ['good']);
  assert.equal(dropped, bad.length);
  assert.equal(queue.seq >= 9, true, 'seq ei palaa taaksepäin');
});

test('luku palauttaa kesken jääneen SYNCINGin odottamaan ja rajaa retryCountin', () => {
  const op = { id: 'a', seq: 1, domain: 'tasks', operation: 'create', entityId: 't', createdAt: NOW, status: 'syncing', retryCount: 999, payload: { title: 'x' } };
  const { queue } = parseQueue(JSON.stringify({ version: QUEUE_VERSION, userId: USER, seq: 1, ops: [op] }), { userId: USER });
  assert.equal(queue.ops[0].status, OP_STATUS.PENDING);
  assert.equal(queue.ops[0].retryCount, MAX_RETRIES);
});

test('luku rajaa jonon koon ja lajittelee seq:n mukaan', () => {
  const ops = Array.from({ length: MAX_OPERATIONS + 30 }, (_, i) => ({
    id: 'o' + i, seq: MAX_OPERATIONS + 30 - i, domain: 'tasks', operation: 'create', entityId: 'e' + i, createdAt: NOW, status: 'pending', retryCount: 0, payload: { title: 't' }
  }));
  const { queue, dropped } = parseQueue(JSON.stringify({ version: QUEUE_VERSION, userId: USER, seq: 500, ops }), { userId: USER });
  assert.equal(queue.ops.length, MAX_OPERATIONS);
  assert.equal(dropped >= 30, true);
  assert.deepEqual(queue.ops.map(op => op.seq), [...queue.ops.map(op => op.seq)].sort((a, b) => a - b));
});

// ---------------------------------------------------------- tilaviesti

test('describeQueueStatus: jokainen tila kertoo totuuden eikä väitä vahvistetuksi', () => {
  const base = { total: 0, pending: 0, syncing: 0, failed: 0, conflict: 0, persistent: true };
  assert.deepEqual(describeQueueStatus(base, { online: true }), { text: '', tone: 'none', needsReview: false });
  assert.equal(describeQueueStatus({ ...base, pending: 1 }, { online: false }).text, 'Offline · 1 muutos odottaa synkronointia');
  assert.equal(describeQueueStatus({ ...base, pending: 3 }, { online: false }).text, 'Offline · 3 muutosta odottaa synkronointia');
  assert.equal(describeQueueStatus({ ...base, pending: 2 }, { online: true }).text, '2 muutosta odottaa synkronointia');
  assert.equal(describeQueueStatus({ ...base, pending: 1 }, { online: true, replaying: true }).text, 'Synkronoidaan…');
  assert.equal(describeQueueStatus({ ...base, syncing: 1 }, { online: true }).text, 'Synkronoidaan…');
  assert.match(describeQueueStatus({ ...base, failed: 2 }, { online: true }).text, /Synkronointi epäonnistui \(2\)/);
  assert.match(describeQueueStatus({ ...base, conflict: 1 }, { online: true }).text, /Vaatii tarkistuksen \(1\)/);
  const both = describeQueueStatus({ ...base, conflict: 1, failed: 1 }, { online: true });
  assert.equal(both.needsReview, true);
  assert.equal(both.tone, 'error');
});

test('describeQueueStatus: sama tila -> sama teksti riippumatta yritysten määrästä (ei välkyntää)', () => {
  const base = { total: 1, pending: 1, syncing: 0, failed: 0, conflict: 0, persistent: true, retryCount: 0 };
  assert.deepEqual(describeQueueStatus(base, { online: true }), describeQueueStatus({ ...base, retryCount: 4 }, { online: true }));
});

test('describeQueueStatus: ei-pysyvä tallennus kerrotaan, ei väitetä säilyvän', () => {
  const view = describeQueueStatus({ total: 1, pending: 1, syncing: 0, failed: 0, conflict: 0, persistent: false }, { online: false });
  assert.match(view.text, /ei säily sivun latauksen yli/);
});

// ---------------------------------------------------------------- store

test('store: käyttäjäkohtainen avain, kelvoton tunniste hylätään', () => {
  assert.equal(queueKey(USER), 'manifestival.offlineQueue.v1.' + USER);
  for (const bad of [null, undefined, '', 'a b', '../x', 'x'.repeat(65), 'a/b', 'a:b', {}]) {
    assert.equal(queueKey(bad), null, String(bad));
    assert.deepEqual(saveQueueText(bad, 'x'), { ok: false, persistent: false });
    assert.equal(loadQueueText(bad), null);
  }
});

test('store: tallennus, luku, poisto ja kahden käyttäjän erillisyys (muistivaraosa)', () => {
  const other = 'bbbbbbbb-2222-4222-8222-000000000002';
  assert.equal(saveQueueText(USER, 'a').ok, true);
  assert.equal(saveQueueText(other, 'b').ok, true);
  assert.equal(loadQueueText(USER), 'a');
  assert.equal(loadQueueText(other), 'b');
  purgeQueue(USER);
  assert.equal(loadQueueText(USER), null);
  assert.equal(loadQueueText(other), 'b', 'toisen käyttäjän jono ei kadonnut');
  purgeQueue('kelvoton tunniste');
});

test('store: localStorage käytössä -> pysyvä; kiintiö/yksityinen tila -> muisti ja persistent:false', () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const backing = new Map();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: k => backing.get(k) ?? null, setItem: (k, v) => backing.set(k, v), removeItem: k => backing.delete(k) }
  });
  try {
    assert.deepEqual(saveQueueText(USER, 'pysyvä'), { ok: true, persistent: true });
    assert.equal(backing.get(queueKey(USER)), 'pysyvä');
    purgeQueue(USER);
    assert.equal(backing.has(queueKey(USER)), false);

    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: { getItem: () => { throw new Error('estetty'); }, setItem: () => { throw new Error('QuotaExceededError'); }, removeItem: () => { throw new Error('estetty'); } }
    });
    assert.deepEqual(saveQueueText(USER, 'muistiin'), { ok: true, persistent: false });
    assert.equal(loadQueueText(USER), 'muistiin');
    purgeQueue(USER);
    assert.equal(loadQueueText(USER), null);
  } finally {
    if (saved) Object.defineProperty(globalThis, 'localStorage', saved);
    else delete globalThis.localStorage;
  }
});

// ------------------------------------------------- lähdekoodi-invariantit

test('KRIITTINEN: domain-moduuli on puhdas: ei kelloa, satunnaisuutta, verkkoa eikä tallennusta', () => {
  const source = readCode('src/domain/offlineQueue.js');
  for (const forbidden of ['Date.now', 'new Date(', 'Math.random', 'crypto.', 'fetch(', 'localStorage', 'sessionStorage', 'setTimeout', 'setInterval', 'console.']) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});

test('KRIITTINEN: jono- ja tallennusmoduulit eivät käsittele tokeneita eikä ajastimia', () => {
  for (const file of ['src/domain/offlineQueue.js', 'src/data/offlineQueueStore.js', 'src/app/offlineSync.js', 'src/app/offline.js']) {
    const source = readCode(file);
    assert.equal(/access_token|refresh_token|getSession|Authorization|Bearer|service_role|apikey/i.test(source), false, file);
    assert.equal(/setInterval|setTimeout/.test(source), false, file + ': jono ei saa ajastaa itseään (ei taustapollausta)');
  }
});

test('KRIITTINEN: offline-jono ei kirjoita muuhun kuin tasks-tauluun eikä kutsu AI:ta, taloutta tai tilin poistoa', () => {
  for (const file of ['src/app/offlineSync.js', 'src/app/offline.js', 'src/data/offlineQueueStore.js']) {
    const source = readCode(file);
    for (const forbidden of ['billsRepo', 'transactionsRepo', 'aiAuditRepo', 'deleteTask', 'setBillPaid', 'accountDeletionClient', 'commandClient', 'executeProposal', 'functions/v1']) {
      assert.equal(source.includes(forbidden), false, `${file}: ${forbidden}`);
    }
  }
  assert.equal(/deleteTask|\.delete\(/.test(readCode('src/app/offlineSync.js')), false);
});

test('AI-komentojen käsittelijät eivät koskaan jonota (NO_QUEUE) ja poisto/maksu eivät koske jonoon', () => {
  const handlers = read('src/app/aiCommandHandlers.js');
  assert.match(handlers, /const NO_QUEUE = Object\.freeze\(\{ queueOffline: false \}\)/);
  const calls = handlers.match(/(createTask|editTask)\([^)]*\)/g) || [];
  assert.ok(calls.length >= 7);
  for (const call of calls) assert.match(call, /NO_QUEUE/, call);

  const actions = readCode('src/app/actions.js');
  const bodyOf = name => {
    const start = actions.indexOf(`export async function ${name}(`);
    assert.ok(start > -1, name);
    const next = actions.indexOf('\nexport ', start + 10);
    return actions.slice(start, next === -1 ? undefined : next);
  };
  for (const name of ['deleteTask', 'setBillPaid', 'createBill', 'editBill', 'deleteRoutine', 'deleteGoal', 'deleteProject']) {
    assert.equal(/offline\./.test(bodyOf(name)), false, `${name} ei saa käyttää offline-jonoa`);
  }
  for (const name of ['createTask', 'editTask', 'toggleComplete']) {
    assert.equal(/offline\.enqueue/.test(bodyOf(name)), true, name);
  }
});

test('toast-ryöppyä ei synny: jonotuksesta kerrotaan enintään kerran minuutissa', () => {
  const actions = read('src/app/actions.js');
  assert.match(actions, /at - queuedNoticeAt < 60000/);
});
