// Arjen lähtökori: menon tallennus ja tapakirjaus verkon puuttuessa.
//
//   src/domain/dailyLifeOutbox.js    puhdas kori (yhdistäminen, rajat, käyttäjäraja, konflikti)
//   src/app/dailyLifeOutbox.js       sovelluskerros (korin täyttö, toisto, istuntoraja)
//   src/app/dailyLifeActions.js      saveCalendarEvent / logHabitEvent käyttävät koria
//
// Kanta korvataan repositorion kaksoiskappaleella (isPersistent: true), jolla
// verkkovirhe, kaksoiskappale (23505) ja palvelimen tila voidaan asettaa.
// Mitään ei lähetetä verkkoon.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { setUser, clearUser } from '../src/data/session.js';
import { resetState, getState, setCalendarEvents, setHabitPlans } from '../src/app/state.js';
import { calendarEventsRepo, habitEventsRepo, clearAllCollections } from '../src/data/collectionsRepo.js';
import { resetOutboxStoreForTests, outboxKey } from '../src/data/dailyLifeOutboxStore.js';
import {
  emptyOutbox, createOutboxOperation, enqueueOutbox, nextOutboxRunnable, retryOutboxOp, outboxStats,
  decideOutboxUpdate, overlayOutbox, serializeOutbox, parseOutbox, forgetOutboxEntity, outboxPayload,
  OUTBOX_ALLOWED, FORBIDDEN_OUTBOX_OPERATIONS, MAX_OUTBOX_OPS, MAX_OUTBOX_RETRIES, OUTBOX_STATUS
} from '../src/domain/dailyLifeOutbox.js';
import {
  activateDailyLifeOutbox, deactivateDailyLifeOutbox, replayDailyLifeOutbox, dailyLifeOutboxStatus,
  overlayDailyLifeOutbox
} from '../src/app/dailyLifeOutbox.js';
import {
  saveCalendarEvent, logHabitEvent, deleteCalendarEvent, resetDailyLifeActions, dailyLifeWriteMark, keepDailyLifeWritesSince
} from '../src/app/dailyLifeActions.js';
import { normalizeCalendarEvent } from '../src/domain/calendarEvent.js';
import { readCode } from './helpers/sources.mjs';

const USER_A = { id: 'aaaaaaaa-0000-4000-8000-0000000000a1', email: 'a@example.com' };
const USER_B = { id: 'bbbbbbbb-0000-4000-8000-0000000000b2', email: 'b@example.com' };
const NETWORK = { ok: false, error: { message: 'Failed to fetch', cause: { message: 'Failed to fetch' } } };
const DUPLICATE = { ok: false, error: { message: 'duplicate key', cause: { code: '23505', message: 'duplicate key' } } };
const REJECTED = { ok: false, error: { message: 'check violation', cause: { code: '23514', message: 'check violation' } } };

const SAVED_NAVIGATOR = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
function setOnline(online) {
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: online }, configurable: true, writable: true });
}

/** Palvelimen kaksoiskappale menoille ja tapakirjauksille. */
function fakeServer() {
  const originals = {};
  const server = { calendarEvents: new Map(), habitEvents: new Map(), calls: [], fail: null, hang: null };
  const repos = { calendarEvents: calendarEventsRepo, habitEvents: habitEventsRepo };
  for (const [table, repo] of Object.entries(repos)) {
    originals[table] = { ...repo };
    repo.isPersistent = () => true;
    repo.insert = async entity => {
      server.calls.push(`${table}.insert`);
      if (server.hang) await server.hang;
      if (server.fail) return server.fail;
      if (server[table].has(entity.id)) return DUPLICATE;
      server[table].set(entity.id, { ...entity });
      return { ok: true, value: entity };
    };
    repo.update = async entity => {
      server.calls.push(`${table}.update`);
      if (server.fail) return server.fail;
      if (!server[table].has(entity.id)) return { ok: false, error: { message: 'Ei löytynyt', cause: { code: 'NOT_FOUND' } } };
      server[table].set(entity.id, { ...entity });
      return { ok: true, value: entity };
    };
    repo.remove = async id => {
      server.calls.push(`${table}.remove`);
      if (server.fail) return server.fail;
      server[table].delete(id);
      return { ok: true, value: { id } };
    };
    repo.list = async () => {
      server.calls.push(`${table}.list`);
      if (server.fail) return server.fail;
      return { ok: true, value: [...server[table].values()] };
    };
  }
  server.restore = () => {
    for (const [table, repo] of Object.entries(repos)) Object.assign(repo, originals[table]);
  };
  return server;
}

function installStorage() {
  const data = new Map();
  globalThis.localStorage = {
    getItem: key => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => { data.set(key, String(value)); },
    removeItem: key => { data.delete(key); },
    key: index => [...data.keys()][index] ?? null,
    get length() { return data.size; }
  };
  return data;
}

let server;
let storage;

function signIn(user = USER_A) {
  setUser(user);
  activateDailyLifeOutbox(user.id);
}

beforeEach(() => {
  clearAllCollections();
  resetState();
  clearUser();
  resetOutboxStoreForTests();
  resetDailyLifeActions();
  storage = installStorage();
  server = fakeServer();
  setOnline(true);
  signIn();
});

afterEach(() => {
  server.restore();
  deactivateDailyLifeOutbox();
  delete globalThis.localStorage;
  if (SAVED_NAVIGATOR) Object.defineProperty(globalThis, 'navigator', SAVED_NAVIGATOR);
  else delete globalThis.navigator;
  clearUser();
  resetState();
});

const EVENT = { title: 'Parturi', date: '2026-09-30', startTime: '16:00' };

// ------------------------------------------------------------ puhdas kori

test('domain: vain menon luonti/muokkaus ja tapakirjaus; poistot ja muut kielletty', () => {
  assert.deepEqual(OUTBOX_ALLOWED, { calendarEvents: ['create', 'update'], habitEvents: ['create'] });
  for (const [table, operation] of [['calendarEvents', 'delete'], ['habitEvents', 'update'], ['habitPlans', 'create'],
    ['transactions', 'create'], ['savedPlaces', 'create']]) {
    const created = createOutboxOperation({ id: 'op1', table, operation, entity: { id: 'x1', title: 'x' }, now: 1 });
    assert.equal(created.ok, false, `${table}.${operation}`);
  }
  assert.ok(FORBIDDEN_OUTBOX_OPERATIONS.includes('delete'));
  const code = readCode('src/domain/dailyLifeOutbox.js');
  assert.equal(/Date\.now\(|new Date\(\)|Math\.random|localStorage|fetch\(/.test(code), false, 'puhdas moduuli');
});

test('domain: kaksi tallennusta samasta menosta = yksi operaatio uusimmalla sisällöllä', () => {
  let outbox = emptyOutbox(USER_A.id);
  const first = createOutboxOperation({ id: 'op1', table: 'calendarEvents', operation: 'create', entity: { id: 'e1', ...EVENT }, now: 1 });
  outbox = enqueueOutbox(outbox, first.op).outbox;
  const second = createOutboxOperation({
    id: 'op2', table: 'calendarEvents', operation: 'update', entity: { id: 'e1', ...EVENT, startTime: '17:00' }, now: 2
  });
  const result = enqueueOutbox(outbox, second.op);
  assert.equal(result.coalesced, true);
  assert.equal(result.outbox.ops.length, 1);
  assert.equal(result.outbox.ops[0].operation, 'create', 'luonti + muokkaus = luonti');
  assert.equal(result.outbox.ops[0].payload.startTime, '17:00');
  assert.equal(outbox.ops[0].payload.startTime, '16:00', 'alkuperäistä koria ei muuteta');
});

test('domain: täysi kori ei pudota mitään hiljaa; käyttäjäraja ja rikkinäinen sisältö', () => {
  let outbox = emptyOutbox(USER_A.id);
  for (let index = 0; index < MAX_OUTBOX_OPS; index += 1) {
    const op = createOutboxOperation({ id: `op${index + 1}`, table: 'habitEvents', operation: 'create',
      entity: { id: `h${index}`, planId: 'p1', action: 'use', occurredAt: '2026-09-28T10:00:00.000Z' }, now: index }).op;
    outbox = enqueueOutbox(outbox, op).outbox;
  }
  const extra = createOutboxOperation({ id: 'opX', table: 'habitEvents', operation: 'create',
    entity: { id: 'hX', planId: 'p1', action: 'use', occurredAt: '2026-09-28T10:00:00.000Z' }, now: 999 }).op;
  const refused = enqueueOutbox(outbox, extra);
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'outbox_full');

  const text = serializeOutbox(outbox);
  assert.equal(parseOutbox(text, { userId: USER_B.id }).outbox.ops.length, 0, 'toisen käyttäjän kori on tyhjä');
  assert.equal(parseOutbox(text, { userId: USER_A.id }).outbox.ops.length, MAX_OUTBOX_OPS);
  assert.equal(parseOutbox('{rikki', { userId: USER_A.id }).outbox.ops.length, 0);
  const tampered = JSON.parse(text);
  tampered.ops[0].table = 'transactions';
  assert.equal(parseOutbox(JSON.stringify(tampered), { userId: USER_A.id }).dropped, 1);
});

test('domain: ei salaisuuksia koriin, yritykset loppuvat -> FAILED (säilyy)', () => {
  const payload = outboxPayload('calendarEvents', { id: 'e1', ...EVENT, user_id: 'x', accessToken: 'T', createdAt: 'z' });
  assert.equal('user_id' in payload || 'accessToken' in payload || 'createdAt' in payload, false);
  let outbox = enqueueOutbox(emptyOutbox('u'), createOutboxOperation({
    id: 'op1', table: 'calendarEvents', operation: 'create', entity: { id: 'e1', ...EVENT }, now: 0 }).op).outbox;
  for (let index = 0; index < MAX_OUTBOX_RETRIES; index += 1) outbox = retryOutboxOp(outbox, 'op1', { code: 'unknown', nowMs: 0 });
  assert.equal(outbox.ops[0].status, OUTBOX_STATUS.FAILED);
  assert.equal(nextOutboxRunnable(outbox, 1e12), null);
  assert.deepEqual(outboxStats(outbox), { pending: 0, failed: 1, total: 1 });
});

test('domain: muokkaus palvelimen tilaa vasten (lähetä, jo tehty, konflikti, poistettu)', () => {
  const base = normalizeCalendarEvent({ id: 'e1', ...EVENT, notes: null });
  const op = createOutboxOperation({ id: 'op1', table: 'calendarEvents', operation: 'update',
    entity: { ...base, title: 'Parturi ja partanajo' }, base, now: 0 }).op;
  assert.equal(decideOutboxUpdate({ server: null, op }).action, 'missing');
  assert.equal(decideOutboxUpdate({ server: { ...base, title: 'Parturi ja partanajo' }, op }).action, 'already_applied');
  const other = decideOutboxUpdate({ server: { ...base, notes: 'Toiselta laitteelta' }, op });
  assert.equal(other.action, 'apply');
  assert.equal(other.merged.notes, 'Toiselta laitteelta', 'palvelimen muut muutokset säilyvät');
  assert.equal(other.merged.title, 'Parturi ja partanajo');
  const conflict = decideOutboxUpdate({ server: { ...base, title: 'Kampaaja' }, op });
  assert.deepEqual(conflict, { action: 'conflict', fields: ['title'] });
});

test('domain: odottavat näkyvät ladatun listan päällä; poisto unohtaa odottavat', () => {
  let outbox = emptyOutbox('u');
  outbox = enqueueOutbox(outbox, createOutboxOperation({ id: 'op1', table: 'calendarEvents', operation: 'create',
    entity: { id: 'e1', ...EVENT }, now: 0 }).op).outbox;
  const rows = overlayOutbox([], outbox, 'calendarEvents');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'Parturi');
  assert.equal(forgetOutboxEntity(outbox, 'calendarEvents', 'e1').ops.length, 0);
});

// ------------------------------------------------------------ sovelluskerros

test('tiedossa oleva offline: meno tallentuu laitteelle, ei verkkokutsua, ei peruutusta', async () => {
  setOnline(false);
  const result = await saveCalendarEvent(EVENT);
  assert.equal(result.ok, true);
  assert.equal(result.queued, true);
  assert.deepEqual(server.calls, [], 'verkkokutsua ei odotettu');
  assert.equal(getState().calendarEvents.length, 1, 'meno näkyy heti');
  assert.equal(dailyLifeOutboxStatus().pending, 1);
  assert.ok(storage.has(outboxKey(USER_A.id)), 'kori on laitteella käyttäjän avaimella');
  assert.equal(/Parturi/.test(storage.get(outboxKey(USER_A.id))), true);
});

test('KILPAILU: kaksi tallennusta samasta menosta offline -> yksi lähetys uusimmalla sisällöllä', async () => {
  setOnline(false);
  const first = await saveCalendarEvent(EVENT);
  await saveCalendarEvent({ ...first.event, startTime: '17:30' });
  assert.equal(dailyLifeOutboxStatus().total, 1);

  setOnline(true);
  const replayed = await replayDailyLifeOutbox();
  assert.equal(replayed.sent, 1);
  assert.deepEqual(server.calls, ['calendarEvents.insert']);
  assert.equal(server.calendarEvents.get(first.event.id).startTime, '17:30');
  assert.equal(dailyLifeOutboxStatus().total, 0);
});

test('verkkovirhe kesken tallennuksen -> koriin; palvelimen hylkäys -> peruutus kuten ennen', async () => {
  server.fail = NETWORK;
  const queued = await saveCalendarEvent(EVENT);
  assert.equal(queued.queued, true);
  assert.equal(getState().calendarEvents.length, 1);

  server.fail = REJECTED;
  const rejected = await saveCalendarEvent({ ...EVENT, title: 'Toinen' });
  assert.equal(rejected.ok, false);
  assert.equal(getState().calendarEvents.length, 1, 'hylätty tallennus peruttiin');
  assert.equal(dailyLifeOutboxStatus().total, 1, 'hylkäystä ei jonoteta');
});

test('KILPAILU: verkko palaa kesken lähetyksen -> ei rinnakkaista toistoa (idempotentti)', async () => {
  setOnline(false);
  await saveCalendarEvent(EVENT);
  setOnline(true);
  let release;
  server.hang = new Promise(resolve => { release = resolve; });
  const first = replayDailyLifeOutbox();
  const second = replayDailyLifeOutbox();
  assert.equal(first, second, 'sama lähetys');
  server.hang = null;
  release();
  await first;
  assert.deepEqual(server.calls, ['calendarEvents.insert']);
});

test('aiempi yritys ehti perille (23505): ei toista riviä, uusin sisältö viedään päivityksenä', async () => {
  setOnline(false);
  const saved = await saveCalendarEvent(EVENT);
  server.calendarEvents.set(saved.event.id, { ...saved.event, startTime: '15:00' });
  setOnline(true);
  await replayDailyLifeOutbox();
  assert.deepEqual(server.calls, ['calendarEvents.insert', 'calendarEvents.update']);
  assert.equal(server.calendarEvents.size, 1);
  assert.equal(server.calendarEvents.get(saved.event.id).startTime, '16:00');
});

test('muokkaus ei ylikirjoita toisen laitteen uudempaa muutosta hiljaa', async () => {
  const created = await saveCalendarEvent(EVENT);
  assert.equal(created.queued, false);
  setOnline(false);
  await saveCalendarEvent({ ...created.event, title: 'Parturi klo 16' });
  server.calendarEvents.set(created.event.id, { ...server.calendarEvents.get(created.event.id), title: 'Kampaaja' });
  setOnline(true);
  await replayDailyLifeOutbox();
  assert.equal(server.calendarEvents.get(created.event.id).title, 'Kampaaja', 'palvelimen muutos säilyi');
  assert.equal(dailyLifeOutboxStatus().total, 0, 'ristiriitainen muutos jätettiin pois ja siitä kerrottiin');
});

test('KILPAILU: istunto vaihtuu lähetyksen aikana -> tulosta ei kirjata toisen käyttäjän koriin', async () => {
  setOnline(false);
  await saveCalendarEvent(EVENT);
  setOnline(true);
  let release;
  server.hang = new Promise(resolve => { release = resolve; });
  const pending = replayDailyLifeOutbox();
  await new Promise(resolve => setImmediate(resolve));
  // Uloskirjautuminen ja toisen käyttäjän kirjautuminen kesken lähetyksen.
  deactivateDailyLifeOutbox();
  clearUser();
  resetState();
  signIn(USER_B);
  server.hang = null;
  release();
  await pending;
  assert.equal(dailyLifeOutboxStatus().total, 0, 'B:n kori on tyhjä');
  const stored = storage.get(outboxKey(USER_A.id));
  assert.match(stored, /Parturi/, 'A:n kori säilyi A:lle (lähtee, kun A palaa)');
  assert.equal(storage.has(outboxKey(USER_B.id)), false);
});

test('tapakirjaus offline: koriin ja perille kerran; poistettu meno ei palaa toistossa', async () => {
  setHabitPlans([{ id: 'hp1', kind: 'generic', name: 'Kävely', active: true }]);
  setOnline(false);
  const habit = await logHabitEvent({ planId: 'hp1', action: 'use', occurredAt: '2026-09-28T10:00:00.000Z' });
  assert.equal(habit.queued, true);
  const event = await saveCalendarEvent(EVENT);
  setOnline(true);
  server.calendarEvents.set(event.event.id, { ...event.event });
  const removed = await deleteCalendarEvent(event.event.id, { confirm: async () => true });
  assert.equal(removed.ok, true);
  await replayDailyLifeOutbox();
  assert.equal(server.habitEvents.size, 1);
  assert.equal(server.calendarEvents.size, 0, 'poistettu meno ei herännyt henkiin');
});

test('poistoa ei koskaan jonoteta: offline-poisto perutaan näkyvästi', async () => {
  const created = await saveCalendarEvent(EVENT);
  setOnline(false);
  server.fail = NETWORK;
  const result = await deleteCalendarEvent(created.event.id, { confirm: async () => true });
  assert.equal(result.ok, false);
  assert.equal(getState().calendarEvents.length, 1, 'poisto peruttiin');
  assert.equal(dailyLifeOutboxStatus().total, 0);
});

test('latauksen jälkeen odottavat menot pysyvät näkyvissä (overlay)', async () => {
  setOnline(false);
  await saveCalendarEvent(EVENT);
  setCalendarEvents([]);
  overlayDailyLifeOutbox();
  assert.equal(getState().calendarEvents.length, 1);
  assert.equal(getState().calendarEvents[0].title, 'Parturi');
});

test('main.js lähettää korin ennen latausta ja pitää odottavat näkyvissä latauksen jälkeen', () => {
  const main = readCode('src/app/main.js');
  const send = main.slice(main.indexOf('async function sendPending'), main.indexOf('async function loadFresh'));
  assert.match(send, /await replayDailyLifeOutbox\(\)/);
  const load = main.slice(main.indexOf('async function loadFresh'));
  assert.match(load.slice(0, 600), /overlayDailyLifeOutbox\(\)/);
  const signedIn = main.slice(main.indexOf('async function onSignedIn'));
  assert.match(signedIn, /dailyLifeOutboxStatus\(\)\.total > 0/);
});

test('KILPAILU: koriin jäänyt meno ei katoa kesken olleeseen lataukseen (palvelimella sitä ei vielä ole)', async () => {
  // Lataus ottaa merkin ennen hakuja; tallennus epäonnistuu verkkoon ja jää
  // koriin; lataus korvaa tilan palvelimen listalla, jossa menoa ei ole.
  const mark = dailyLifeWriteMark();
  server.fail = NETWORK;
  const saved = await saveCalendarEvent(EVENT);
  assert.equal(saved.queued, true);
  setCalendarEvents([]);
  keepDailyLifeWritesSince(mark);
  assert.deepEqual(getState().calendarEvents.map(event => event.id), [saved.event.id], 'koriin jäänyt meno pysyy näkyvissä');
  assert.equal(dailyLifeOutboxStatus().pending, 1);
});
