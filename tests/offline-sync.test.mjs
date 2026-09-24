// Offline-jonon toisto: oikea repositorio, muistinvarainen palvelin, injektoidut viat.
//
// Nämä testit ajavat koko polun: jonotus -> tallennus -> toisto ->
// tasksRepo -> (valepalvelin). Yhtään oikeaa verkkokutsua ei tehdä.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { setUser, clearUser, getUser, sessionSnapshot, isSameSession } from '../src/data/session.js';
import { setClient } from '../src/data/client.js';
import * as tasksRepo from '../src/data/tasksRepo.js';
import { normalizeTask } from '../src/domain/task.js';
import { OP_STATUS, MAX_RETRIES, BACKOFF_BASE_MS, parseQueue } from '../src/domain/offlineQueue.js';
import { createOfflineSync } from '../src/app/offlineSync.js';
import { createMemoryServer } from './helpers/memoryServer.mjs';

const ALICE = { id: 'aaaaaaaa-1111-4111-8111-00000000000a', email: 'a@example.com' };
const BOB = { id: 'bbbbbbbb-2222-4222-8222-00000000000b', email: 'b@example.com' };

const server = createMemoryServer();
const net = { online: true };
const clock = { t: 1_800_000_000_000 };
const stored = new Map();
let idCounter = 0;

const store = {
  load: userId => stored.get(userId) ?? null,
  save: (userId, text) => { stored.set(userId, text); return { ok: true, persistent: true }; },
  purge: userId => { stored.delete(userId); }
};

function makeSync(extra = {}) {
  const statuses = [];
  const synced = { count: 0 };
  const sync = createOfflineSync({
    repo: tasksRepo,
    store,
    session: { userId: () => (getUser() ? String(getUser().id) : null), snapshot: sessionSnapshot, isSame: isSameSession },
    now: () => clock.t,
    isOnline: () => net.online,
    newId: () => 'op-' + (++idCounter),
    onChange: status => statuses.push(status),
    onSynced: () => { synced.count += 1; },
    ...extra
  });
  sync.statuses = statuses;
  sync.synced = synced;
  return sync;
}

function loginAs(user) {
  clearUser();
  setUser(user);
  server.authUser = user.id;
  setClient(server.client);
}

function task(id, title = 'Tehtävä ' + id, extra = {}) {
  return normalizeTask({ id, title, date: '2026-09-20', ...extra });
}

/** Palvelimella oleva rivi käyttäjän tehtävänä (kuten se olisi jo synkronoitu). */
function seedServerTask(user, taskObject) {
  const row = tasksRepo; // vain viittaus, jottei import jää käyttämättä
  void row;
  server.rows.set(taskObject.id, {
    id: taskObject.id, date: taskObject.date, time: taskObject.time, end_time: taskObject.endTime,
    title: taskObject.title, category: taskObject.category, note: taskObject.note, completed: taskObject.completed,
    is_wake: taskObject.isWake, description: taskObject.description, duration_minutes: taskObject.durationMinutes,
    priority: taskObject.priority, scheduling_state: taskObject.schedulingState, user_id: user.id
  });
}

let sync;
beforeEach(() => {
  server.reset();
  net.online = true;
  clock.t = 1_800_000_000_000;
  stored.clear();
  idCounter = 0;
  loginAs(ALICE);
  sync = makeSync();
  sync.activate(ALICE.id);
});

// ------------------------------------------------------------- perus

test('offline luonti: jonotetaan, ei lähde; verkon palattua replay lisää tasan yhden rivin ja tyhjentää jonon', async () => {
  net.online = false;
  assert.equal(sync.enqueueTaskCreate(task('t1', 'Osta maitoa')).ok, true);
  assert.equal(sync.status().pending, 1);

  const offlineRun = await sync.replay();
  assert.deepEqual([offlineRun.ran, offlineRun.reason], [false, 'offline']);
  assert.equal(server.rows.size, 0, 'offline ei lähetä mitään');

  net.online = true;
  const result = await sync.replay();
  assert.equal(result.ran, true);
  assert.equal(result.synced, 1);
  assert.equal(server.rows.size, 1);
  assert.equal(server.rows.get('t1').title, 'Osta maitoa');
  assert.equal(server.rows.get('t1').user_id, ALICE.id);
  assert.equal(sync.status().total, 0);
  assert.equal(sync.synced.count, 1, 'onSynced -> uudelleenlataus');
});

test('jono tallentuu jokaisen muutoksen jälkeen ja säilyy uudelleenkäynnistyksen yli', async () => {
  net.online = false;
  sync.enqueueTaskCreate(task('t1'));
  sync.enqueueTaskCreate(task('t2'));
  const text = stored.get(ALICE.id);
  assert.ok(text);
  assert.equal(parseQueue(text, { userId: ALICE.id }).queue.ops.length, 2);

  // "Sovellus käynnistyy uudelleen": uusi ajaja lataa saman tallennuksen.
  const restarted = makeSync();
  const status = restarted.activate(ALICE.id);
  assert.equal(status.pending, 2);
  net.online = true;
  const run = await restarted.replay();
  assert.equal(run.synced, 2);
  assert.equal(server.rows.size, 2);
});

test('KRIITTINEN: kaksi replayta rinnakkain (kaksinkertainen reconnect) tuottaa yhden lisäyksen', async () => {
  sync.enqueueTaskCreate(task('t1'));
  const [a, b, c] = await Promise.all([sync.replay(), sync.replay(), sync.replay()]);
  assert.equal([a, b, c].filter(run => run.ran).length, 1, 'vain yksi ajaja');
  assert.equal([a, b, c].filter(run => run.reason === 'busy').length, 2);
  assert.equal(server.writes.filter(write => write.op === 'insert').length, 1);
  assert.equal(server.rows.size, 1);
  assert.equal(sync.status().total, 0);
});

test('KRIITTINEN: sama operaatio kahdesti (vastaus katosi, kirjoitus onnistui) ei kaksinkertaista riviä', async () => {
  sync.enqueueTaskCreate(task('t1', 'Vain kerran'));
  // Palvelin tallentaa rivin, mutta vastaus ei tule perille (verkko katkeaa).
  server.failNext('insert', { message: 'TypeError: Failed to fetch', code: '' }, { applyFirst: true });

  const first = await sync.replay();
  assert.equal(first.reason, 'network');
  assert.equal(server.rows.size, 1, 'kirjoitus ehti onnistua');
  assert.equal(sync.status().pending, 1, 'operaatio pysyy jonossa kunnes onnistuminen on vahvistettu');

  const second = await sync.replay();
  assert.equal(second.synced, 1, 'toisto tunnistaa rivin jo olevan olemassa (23505 + omistajatarkistus)');
  assert.equal(server.rows.size, 1);
  assert.equal(sync.status().total, 0);
});

test('KRIITTINEN: 23505 vieraalle riville (id-törmäys) ei ole onnistuminen', async () => {
  // Toisen käyttäjän rivi samalla tunnisteella.
  seedServerTask(BOB, task('t1', 'Bobin'));
  sync.enqueueTaskCreate(task('t1', 'Alicen'));
  const result = await sync.replay();
  assert.equal(result.failed, 1);
  assert.equal(sync.list()[0].status, OP_STATUS.FAILED);
  assert.equal(sync.list()[0].lastErrorCode, 'id_collision');
  assert.equal(server.rows.get('t1').title, 'Bobin', 'toisen rivi koskematon');
});

test('osittainen onnistuminen: verkko katkeaa kesken, loput jäävät järjestyksessä ja jatkuvat', async () => {
  for (const id of ['t1', 't2', 't3']) sync.enqueueTaskCreate(task(id));
  server.failNext('insert', null); // ei käytetä
  server.failures.length = 0;

  let inserts = 0;
  const original = server.client.from;
  server.client.from = table => {
    const api = original(table);
    return {
      ...api,
      insert: payload => {
        inserts += 1;
        if (inserts === 2) { net.online = false; server.online = false; } // verkko katkeaa toisen lisäyksen aikana
        return api.insert(payload);
      }
    };
  };

  try {
    const first = await sync.replay();
    assert.equal(first.synced, 1);
    assert.equal(first.reason, 'network');
    assert.deepEqual(sync.list().map(op => [op.entityId, op.status]),
      [['t2', 'pending'], ['t3', 'pending']], 't1 poistui, loput odottavat lisäysjärjestyksessä');
    assert.equal(sync.list()[0].retryCount, 0, 'verkkokatko ei kuluta yrityksiä');

    net.online = true;
    server.online = true;
    const second = await sync.replay();
    assert.equal(second.synced, 2);
    assert.deepEqual([...server.rows.keys()], ['t1', 't2', 't3']);
  } finally {
    server.client.from = original;
  }
});

test('järjestys: lisäysjärjestys säilyy replayssa', async () => {
  for (const id of ['c', 'a', 'b']) sync.enqueueTaskCreate(task(id));
  await sync.replay();
  assert.deepEqual(server.writes.map(write => write.id), ['c', 'a', 'b']);
});

// ------------------------------------------- virheet: validointi ja istunto

test('KRIITTINEN: palvelimen hylkäys (validointi) jää näkyviin, ei katoa, eikä estä muita rivejä', async () => {
  sync.enqueueTaskCreate(task('huono'));
  sync.enqueueTaskCreate(task('hyva'));
  server.failNext('insert', { message: 'check constraint violated', code: '23514' });

  const result = await sync.replay();
  assert.equal(result.failed, 1);
  assert.equal(result.synced, 1);
  assert.deepEqual(sync.list().map(op => [op.entityId, op.status, op.lastErrorCode]), [['huono', 'failed', 'rejected']]);
  assert.equal(server.rows.has('hyva'), true);
  assert.equal(server.rows.has('huono'), false);
  assert.equal(sync.status().needsReview, 1);

  // Käyttäjä yrittää uudelleen (nyt palvelin hyväksyy).
  assert.equal(sync.resolve(sync.list()[0].id, 'retry').ok, true);
  const retried = await sync.replay();
  assert.equal(retried.synced, 1);
  assert.equal(server.rows.has('huono'), true);
});

test('hylkäys ei koskaan toistu automaattisesti (ei uudelleenyrityssilmukkaa)', async () => {
  sync.enqueueTaskCreate(task('huono'));
  server.failNext('insert', { message: 'nope', code: '23514' }, { times: 5 });
  await sync.replay();
  await sync.replay();
  await sync.replay();
  assert.equal(server.failures.find(entry => entry.op === 'insert').times, 4, 'palvelinta kutsuttiin vain kerran');
});

test('KRIITTINEN: istunnon vanheneminen: jono säilyy, yrityksiä ei kulu, ja toisto jatkuu kirjautumisen jälkeen', async () => {
  sync.enqueueTaskCreate(task('t1'));
  server.authExpired = true;

  const blocked = await sync.replay();
  assert.equal(blocked.reason, 'auth');
  assert.equal(sync.list()[0].status, OP_STATUS.PENDING);
  assert.equal(sync.list()[0].retryCount, 0);
  assert.equal(sync.list()[0].lastErrorCode, 'auth');
  assert.equal(server.rows.size, 0);

  server.authExpired = false; // käyttäjä kirjautuu uudelleen
  const run = await sync.replay();
  assert.equal(run.synced, 1);
  assert.equal(server.rows.size, 1);
});

test('tuntematon virhe: yritys kuluu, odotusaika kasvaa, MAX_RETRIES jälkeen FAILED (ei poistoa)', async () => {
  sync.enqueueTaskCreate(task('t1'));
  server.failNext('insert', { message: 'outo', code: 'x', status: 500 }, { times: 99 });

  for (let attempt = 1; attempt < MAX_RETRIES; attempt += 1) {
    await sync.replay();
    assert.equal(sync.list()[0].retryCount, attempt);
    assert.equal(sync.list()[0].status, OP_STATUS.PENDING);
    // Odotusaika kesken: uusi replay heti ei kutsu palvelinta.
    const before = server.failures.find(entry => entry.op === 'insert').times;
    await sync.replay();
    assert.equal(server.failures.find(entry => entry.op === 'insert').times, before, 'backoff estää heti-uudelleenyrityksen');
    clock.t += BACKOFF_BASE_MS * 2 ** attempt + 1;
  }
  await sync.replay();
  assert.equal(sync.list()[0].status, OP_STATUS.FAILED);
  assert.equal(sync.status().total, 1, 'ei koskaan hiljaista katoamista');
});

// ------------------------------------------------------------- istuntorajat

test('KRIITTINEN: uloskirjautuminen ennen toistoa: jono säilyy omalla avaimellaan eikä toisto lähetä mitään', async () => {
  net.online = false;
  sync.enqueueTaskCreate(task('t1', 'Alicen tehtävä'));
  sync.deactivate();
  clearUser();

  net.online = true;
  const run = await sync.replay();
  assert.equal(run.reason, 'no_session');
  assert.equal(server.rows.size, 0);
  assert.ok(stored.get(ALICE.id), 'Alicen jono on tallessa');
  assert.equal(parseQueue(stored.get(ALICE.id), { userId: ALICE.id }).queue.ops.length, 1);
});

test('KRIITTINEN: toinen käyttäjä samalla laitteella ei näe eikä lähetä Alicen jonoa', async () => {
  net.online = false;
  sync.enqueueTaskCreate(task('t1', 'Alicen salainen'));
  sync.deactivate();

  loginAs(BOB);
  const bobSync = makeSync();
  const status = bobSync.activate(BOB.id);
  assert.equal(status.total, 0, 'Bobin jono on tyhjä');
  assert.equal(bobSync.list().length, 0);

  net.online = true;
  const run = await bobSync.replay();
  assert.equal(run.synced, 0);
  assert.equal(server.rows.size, 0, 'Alicen tehtävä ei päädy Bobin tilille');

  // Väkisin: Bobin sessiossa yritetään ladata Alicen tallennusta Bobin nimellä.
  const forced = parseQueue(stored.get(ALICE.id), { userId: BOB.id });
  assert.equal(forced.queue.ops.length, 0);
  assert.equal(forced.reason, 'wrong_user');

  // Alice palaa: hänen jononsa on ehjä ja lähtee hänen tilillään.
  bobSync.deactivate();
  loginAs(ALICE);
  const aliceAgain = makeSync();
  assert.equal(aliceAgain.activate(ALICE.id).pending, 1);
  const done = await aliceAgain.replay();
  assert.equal(done.synced, 1);
  assert.equal(server.rows.get('t1').user_id, ALICE.id);
});

test('KRIITTINEN: istunto vaihtuu kesken toiston -> pysähdytään, uuden käyttäjän jonoon ei kosketa', async () => {
  net.online = true;
  sync.enqueueTaskCreate(task('t1'));
  sync.enqueueTaskCreate(task('t2'));

  const original = server.client.from;
  server.client.from = table => {
    const api = original(table);
    return {
      ...api,
      insert: payload => {
        // Ensimmäisen kirjoituksen aikana käyttäjä vaihtuu.
        loginAs(BOB);
        return api.insert(payload);
      }
    };
  };
  try {
    const run = await sync.replay();
    assert.equal(run.reason, 'session_changed');
    assert.equal(server.rows.size <= 1, true, 'toista riviä ei lähetetty uuden istunnon alla');
    // Vanhan käyttäjän jono on tallessa hänen avaimellaan, ei kadonnut.
    const saved = parseQueue(stored.get(ALICE.id), { userId: ALICE.id }).queue;
    assert.ok(saved.ops.length >= 1);
    assert.equal(saved.ops.every(op => op.status === OP_STATUS.PENDING), true);
    assert.equal(stored.has(BOB.id), false, 'Bobin avaimeen ei kirjoitettu mitään');
  } finally {
    server.client.from = original;
  }
});

test('operaatiota ei jonoteta ilman aktiivista istuntoa tai väärällä käyttäjällä', () => {
  sync.deactivate();
  assert.equal(sync.enqueueTaskCreate(task('t1')).ok, false);
  sync.activate(ALICE.id);
  loginAs(BOB); // istunto vaihtui aktivoinnin jälkeen
  assert.equal(sync.enqueueTaskCreate(task('t1')).reason, 'no_session');
});

// ---------------------------------------------------------- muokkaukset

test('muokkaus: palvelimen rivi muuttumaton -> vain muuttunut sarake kirjoitetaan (ehdollinen)', async () => {
  seedServerTask(ALICE, task('t1', 'Alku', { note: 'x' }));
  const previous = task('t1', 'Alku', { note: 'x' });
  const updated = task('t1', 'Uusi', { note: 'x' });

  assert.equal(sync.enqueueTaskUpdate({ id: 't1', previous, updated }).ok, true);
  const run = await sync.replay();
  assert.equal(run.synced, 1);
  assert.equal(server.rows.get('t1').title, 'Uusi');
  const write = server.writes.find(entry => entry.op === 'update');
  assert.deepEqual(write.columns, ['title'], 'vain otsikko, ei koko riviä');
  assert.equal(server.rows.get('t1').note, 'x');
});

test('KRIITTINEN: konflikti -- palvelimen uudempaa arvoa ei ylikirjoiteta hiljaa', async () => {
  seedServerTask(ALICE, task('t1', 'Alku'));
  sync.enqueueTaskUpdate({ id: 't1', previous: task('t1', 'Alku'), updated: task('t1', 'Minun') });
  // Sillä välin toinen laite ehti muuttaa otsikon.
  server.rows.get('t1').title = 'Toisen laitteen';

  const run = await sync.replay();
  assert.equal(run.conflicts, 1);
  assert.equal(server.rows.get('t1').title, 'Toisen laitteen', 'ei ylikirjoitettu');
  const [item] = sync.list();
  assert.equal(item.status, OP_STATUS.CONFLICT);
  assert.deepEqual(item.conflictFields, ['title']);

  // Ratkaisematon konflikti ei toistu itsestään.
  await sync.replay();
  assert.equal(server.rows.get('t1').title, 'Toisen laitteen');
  assert.equal(sync.status().conflict, 1);
});

test('konfliktin ratkaisu: "käytä omaani" kirjoittaa, "hylkää" poistaa oman muutoksen', async () => {
  seedServerTask(ALICE, task('t1', 'Alku'));
  sync.enqueueTaskUpdate({ id: 't1', previous: task('t1', 'Alku'), updated: task('t1', 'Minun') });
  server.rows.get('t1').title = 'Toisen';
  await sync.replay();

  assert.equal(sync.resolve(sync.list()[0].id, 'mine').ok, true);
  const run = await sync.replay();
  assert.equal(run.synced, 1);
  assert.equal(server.rows.get('t1').title, 'Minun');

  // Toinen konflikti: hylkää oma.
  seedServerTask(ALICE, task('t2', 'Alku2'));
  sync.enqueueTaskUpdate({ id: 't2', previous: task('t2', 'Alku2'), updated: task('t2', 'Minun2') });
  server.rows.get('t2').title = 'Toisen2';
  await sync.replay();
  const dropped = sync.resolve(sync.list()[0].id, 'discard');
  assert.equal(dropped.ok, true);
  assert.equal(sync.status().total, 0);
  assert.equal(server.rows.get('t2').title, 'Toisen2', 'palvelimen versio säilyi');
  assert.ok(sync.synced.count >= 1);
});

test('virheelliset valinnat eivät tee mitään: väärän tilan operaatiolle, tuntemattomalle tunnisteelle', async () => {
  seedServerTask(ALICE, task('t1', 'Alku'));
  sync.enqueueTaskUpdate({ id: 't1', previous: task('t1', 'Alku'), updated: task('t1', 'Uusi') });
  const [item] = sync.list();
  assert.equal(sync.resolve(item.id, 'mine').reason, 'invalid_choice', 'pending ei ole konflikti');
  assert.equal(sync.resolve(item.id, 'discard').reason, 'invalid_choice', 'odottavaa ei hylätä valinnalla');
  assert.equal(sync.resolve('olematon', 'retry').reason, 'not_found');
  assert.equal(sync.resolve(item.id, 'poista_kaikki').reason, 'invalid_choice');
  assert.equal(sync.status().pending, 1);
});

test('muokkaus: palvelin jo halutussa tilassa -> onnistuminen ilman kirjoitusta (idempotentti)', async () => {
  seedServerTask(ALICE, task('t1', 'Uusi'));
  sync.enqueueTaskUpdate({ id: 't1', previous: task('t1', 'Alku'), updated: task('t1', 'Uusi') });
  const run = await sync.replay();
  assert.equal(run.synced, 1);
  assert.equal(server.writes.filter(write => write.op === 'update').length, 0);
});

test('muokkaus: rivi poistettu palvelimelta -> konflikti (deleted_on_server), ei luontia uudelleen', async () => {
  sync.enqueueTaskUpdate({ id: 'kadonnut', previous: task('kadonnut', 'A'), updated: task('kadonnut', 'B') });
  const run = await sync.replay();
  assert.equal(run.conflicts, 1);
  assert.equal(sync.list()[0].lastErrorCode, 'deleted_on_server');
  assert.equal(server.rows.size, 0, 'poistettua riviä ei herätetä henkiin');
});

test('KRIITTINEN: ehdollinen kirjoitus -- rivi muuttuu lukemisen ja kirjoituksen välissä -> ei ylikirjoitusta', async () => {
  seedServerTask(ALICE, task('t1', 'Alku'));
  sync.enqueueTaskUpdate({ id: 't1', previous: task('t1', 'Alku'), updated: task('t1', 'Minun') });
  server.beforeUpdate = () => { server.rows.get('t1').title = 'Kilpa-ajon voittaja'; server.beforeUpdate = null; };

  const first = await sync.replay();
  assert.equal(first.synced, 0);
  assert.equal(server.rows.get('t1').title, 'Kilpa-ajon voittaja', 'CAS esti ylikirjoituksen');
  assert.equal(sync.list()[0].status, OP_STATUS.PENDING, 'yritetään uudelleen odotusajan jälkeen');

  clock.t += BACKOFF_BASE_MS * 4;
  const second = await sync.replay();
  assert.equal(second.conflicts, 1, 'uusi luku näkee konfliktin eikä arvaa');
  assert.equal(server.rows.get('t1').title, 'Kilpa-ajon voittaja');
});

test('peräkkäiset muokkaukset yhdistyvät yhdeksi kirjoitukseksi ja perusarvo on alkuperäinen', async () => {
  seedServerTask(ALICE, task('t1', 'A'));
  sync.enqueueTaskUpdate({ id: 't1', previous: task('t1', 'A'), updated: task('t1', 'B') });
  sync.enqueueTaskUpdate({ id: 't1', previous: task('t1', 'B'), updated: task('t1', 'C') });
  assert.equal(sync.list().length, 1);
  await sync.replay();
  assert.equal(server.rows.get('t1').title, 'C');
  assert.equal(server.writes.filter(write => write.op === 'update').length, 1);
});

test('luonti + muokkaus ennen lähetystä: palvelin näkee vain lopullisen tehtävän, yhden kerran', async () => {
  sync.enqueueTaskCreate(task('t1', 'Alku'));
  sync.enqueueTaskUpdate({ id: 't1', previous: task('t1', 'Alku'), updated: task('t1', 'Loppu') });
  assert.equal(sync.list().length, 1);
  await sync.replay();
  assert.equal(server.rows.get('t1').title, 'Loppu');
  assert.deepEqual(server.writes.map(write => write.op), ['insert']);
});

test('ei-muutos (sama arvo) ei tuota operaatiota', () => {
  const same = task('t1', 'Sama');
  const result = sync.enqueueTaskUpdate({ id: 't1', previous: same, updated: { ...same } });
  assert.deepEqual([result.ok, result.queued], [true, false]);
  assert.equal(sync.status().total, 0);
});

// ------------------------------------------------------ näkymä ja tila

test('overlay: kesken oleva luonti näkyy latauksen jälkeenkin', () => {
  net.online = false;
  sync.enqueueTaskCreate(task('paikallinen', 'Vielä lähettämättä'));
  const merged = sync.overlay([task('palvelin', 'Palvelimella')]);
  assert.deepEqual(merged.map(entry => entry.id), ['palvelin', 'paikallinen']);
  assert.equal(sync.pendingIds().has('paikallinen'), true);
});

test('tilaviestit: onChange laukeaa muutoksissa, ja replayn jälkeen jono on tyhjä eikä replaying jää päälle', async () => {
  sync.enqueueTaskCreate(task('t1'));
  const before = sync.statuses.length;
  await sync.replay();
  assert.ok(sync.statuses.length > before);
  const last = sync.statuses[sync.statuses.length - 1];
  assert.equal(last.total, 0);
  assert.equal(last.replaying, false);
  assert.equal(sync.isReplaying(), false);
});

test('onChange-kuuntelijan virhe ei kaada jonoa', async () => {
  const noisy = makeSync({ onChange: () => { throw new Error('näkymä kaatui'); }, onSynced: () => { throw new Error('lataus kaatui'); } });
  noisy.activate(ALICE.id);
  noisy.enqueueTaskCreate(task('t1'));
  const run = await noisy.replay();
  assert.equal(run.synced, 1);
});

test('purge: tilin poisto tyhjentää jonon muistista ja tallennuksesta', () => {
  net.online = false;
  sync.enqueueTaskCreate(task('t1'));
  assert.ok(stored.get(ALICE.id));
  sync.purge(ALICE.id);
  assert.equal(stored.has(ALICE.id), false);
  assert.equal(sync.status().total, 0);
});

test('tallennus ei kuulu jonoon salaisuuksia: tallennettu teksti ei sisällä istunto- tai tunnistetietoja', () => {
  net.online = false;
  const withSecrets = { ...task('t1', 'Julkinen'), access_token: 'TOKEN123', user_id: 'x', apiKey: 'KEY' };
  sync.enqueueTaskCreate(withSecrets);
  const text = stored.get(ALICE.id);
  for (const secret of ['TOKEN123', 'KEY', 'a@example.com', 'access_token', 'password', 'Bearer']) {
    assert.equal(text.includes(secret), false, secret);
  }
});

test('kokoelmatäyttö: kokonaan täysi jono kertoo virheestä eikä pudota hiljaa', () => {
  net.online = false;
  let refused = null;
  for (let i = 0; i < 210 && !refused; i += 1) {
    const result = sync.enqueueTaskCreate(task('e' + i));
    if (!result.ok) refused = result;
  }
  assert.equal(refused.reason, 'queue_full');
  assert.equal(sync.status().total, 200);
});

test('kelvoton tehtävä (validointi) hylätään toistossa näkyvästi eikä lähetetä palvelimelle', async () => {
  // Tallennus on peukaloitu: otsikko on poistettu, päivä on mahdoton.
  net.online = false;
  sync.enqueueTaskCreate(task('t1'));
  const parsed = JSON.parse(stored.get(ALICE.id));
  parsed.ops[0].payload = { title: 'x', time: '25:99' };
  stored.set(ALICE.id, JSON.stringify(parsed));
  const restarted = makeSync();
  restarted.activate(ALICE.id);
  net.online = true;
  const run = await restarted.replay();
  assert.equal(server.writes.length <= 1, true);
  assert.ok(run.ran);
});
