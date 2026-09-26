// Käynnistyksen skeematarkistus: luokitus, vain lukevat pyynnöt,
// offline-käynnistys, "ei tiedetä" -tulokset, välimuisti, huoltotila ja
// näkyvä tila.
//
// Nämä testit ajavat tuotehaaran oikeat portit (enimmäkseen kiinni).
// Aaltojen C-J porteilla sama koodi ajetaan tiedostossa
// tests/schema-compat-matrix.test.mjs.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createSchemaServer, memoryStorage, migrationsThrough } from './helpers/schemaServer.mjs';
import { read } from './helpers/sources.mjs';
import {
  classifyProbeError, probeSchema, ensureSchemaCompatibility, schemaCacheKey,
  schemaRevalidation, scheduleSchemaReprobe, resetSchemaProbeForTests, SCHEMA_CACHE_FRESH_MS
} from '../src/data/schemaProbe.js';
import {
  resetSchemaRuntimeForTests, schemaSnapshot, isWritable, isVerified, PROBE_RESULT, SCHEMA_STATUS,
  isColumnGateLowered, setReprobeHandler, requestReprobe, computeCapabilities
} from '../src/data/schemaRuntime.js';
import {
  openRequirements, SCHEMA_REQUIREMENTS, COMPILE_GATES, taskColumns, noteSchemaError,
  SCHEMA_REFUSAL_MESSAGE, MAINTENANCE_REFUSAL_MESSAGE, stripLoweredColumns, writeRefusal,
  TASK_EXTENDED_FIELDS
} from '../src/data/schema.js';
import { setClient } from '../src/data/client.js';
import { setUser, clearUser } from '../src/data/session.js';
import * as tasksRepo from '../src/data/tasksRepo.js';
import * as profileRepo from '../src/data/profileRepo.js';
import { savePreferences, isPersistent as prefsPersistent } from '../src/data/notificationPrefsRepo.js';
import { ALL_REPOSITORIES } from '../src/data/collectionsRepo.js';
import { normalizeTask } from '../src/domain/task.js';
import { createOfflineSync } from '../src/app/offlineSync.js';
import { createTimeEntryWriter } from '../src/app/timeEntryWriter.js';
import { classifyError, ERROR_CLASS, emptyQueue, serializeQueue } from '../src/domain/offlineQueue.js';
import {
  describeSchemaStatus, technicalDetails, retrySchemaCheck, SCHEMA_COPY, SERVER_UNAVAILABLE_HINT
} from '../src/app/schemaStatus.js';
import { loadFailureMessage } from '../src/app/actions.js';

const USER = { id: 'aaaaaaaa-2222-4222-8222-000000000001', email: 'p@example.com' };
const ONLINE = () => true;
const ALL = migrationsThrough('0013');

beforeEach(() => {
  resetSchemaRuntimeForTests();
  resetSchemaProbeForTests();
  setUser(USER);
});

afterEach(() => {
  resetSchemaRuntimeForTests();
  resetSchemaProbeForTests();
  clearUser();
});

function serverFor(options) {
  const server = createSchemaServer({ currentUserId: () => USER.id, ...options });
  setClient(server);
  return server;
}

// ------------------------------------------------------------ luokitus

test('classifyProbeError: vain puuttuva taulu/sarake ja kielto ovat varmoja', () => {
  const cases = [
    [null, PROBE_RESULT.OK],
    [{ code: 'PGRST205', message: "Could not find the table 'public.x'" }, PROBE_RESULT.MISSING_TABLE],
    [{ code: '42P01' }, PROBE_RESULT.MISSING_TABLE],
    [{ code: '42703', message: 'column x.y does not exist' }, PROBE_RESULT.MISSING_COLUMN],
    [{ code: 'PGRST204' }, PROBE_RESULT.MISSING_COLUMN],
    [{ code: '42501' }, PROBE_RESULT.FORBIDDEN],
    // Istunto, palvelin, välityspalvelin: ei tiedetä -> ei laske mitään.
    [{ code: 'PGRST301', message: 'JWT expired' }, PROBE_RESULT.UNKNOWN],
    [{ code: 'PGRST303' }, PROBE_RESULT.UNKNOWN],
    [{ code: 'PGRST002' }, PROBE_RESULT.UNKNOWN],
    [{ code: '57014' }, PROBE_RESULT.UNKNOWN],
    [{ message: 'Not Found', status: 404 }, PROBE_RESULT.UNKNOWN],
    [{ message: 'Bad Gateway', status: 502 }, PROBE_RESULT.UNKNOWN],
    [{ message: 'Failed to fetch' }, PROBE_RESULT.UNKNOWN]
  ];
  for (const [error, expected] of cases) assert.equal(classifyProbeError(error), expected, JSON.stringify(error));
});

test('luokitus toimii, vaikka tila on vain vastauksessa eikä virheoliossa', async () => {
  // supabase-js pitää HTTP-tilan vastauksessa ({ error, status }), ei
  // virheoliossa. Päätös tehdään koodista, joten tila ei ratkaise.
  const client = {
    from: () => {
      const q = {
        select: () => q, limit: () => q,
        then: (resolve) => Promise.resolve({ data: null, status: 404, error: { code: 'PGRST205', message: 'x' } }).then(resolve)
      };
      return q;
    }
  };
  const requirements = SCHEMA_REQUIREMENTS.filter(r => r.id === '0003.routines');
  const { results } = await probeSchema({ client, requirements });
  assert.equal(results['0003.routines'], PROBE_RESULT.MISSING_TABLE);
});

// ---------------------------------------------------- vain lukeva probe

test('probe tekee vain rivittömiä select-kyselyjä: yksi per taulu', async () => {
  const server = serverFor({ applied: ALL });
  const requirements = SCHEMA_REQUIREMENTS;
  const { results, requests } = await probeSchema({ client: server, requirements });
  const tables = new Set(requirements.map(r => r.table));
  assert.equal(requests, tables.size, 'kaikki kunnossa -> tasan yksi pyyntö per taulu');
  assert.equal(server.calls.length, tables.size);
  for (const call of server.calls) {
    assert.equal(call.op, 'select');
    assert.equal(call.limit, 0, 'limit(0): ei yhtään riviä');
    assert.notEqual(call.columns, '*', 'sarakkeet nimetään, jotta puute näkyy');
  }
  assert.ok(Object.values(results).every(result => result === PROBE_RESULT.OK));
});

test('puuttuva sarake tarkennetaan vaatimus kerrallaan, ja puute osuu oikeaan joukkoon', async () => {
  const server = serverFor({ applied: migrationsThrough('0008') });
  const requirements = SCHEMA_REQUIREMENTS.filter(r => r.table === 'tasks');
  const { results } = await probeSchema({ client: server, requirements });
  assert.equal(results['0001.tasks'], PROBE_RESULT.OK);
  assert.equal(results['0002.tasks'], PROBE_RESULT.OK);
  assert.equal(results['0004.tasks'], PROBE_RESULT.OK);
  assert.equal(results['0010.tasks'], PROBE_RESULT.MISSING_COLUMN);
  assert.ok(server.calls.every(call => call.op === 'select' && call.limit === 0));
  assert.equal(server.calls.length, 1 + requirements.length, 'yhdistetty + yksi per vaatimus');
});

test('tämän käännöksen probe koskee vain ydintä ja auki olevia portteja', () => {
  const ids = openRequirements().map(r => r.id);
  for (const requirement of SCHEMA_REQUIREMENTS) {
    const open = requirement.core
      || (requirement.kind === 'table' ? COMPILE_GATES.tables[requirement.tableKey] === true
        : COMPILE_GATES.columns[requirement.gate] === true);
    assert.equal(ids.includes(requirement.id), open, requirement.id);
  }
  assert.ok(ids.includes('0001.tasks') && ids.includes('0001.profile'));
});

// ------------------------------------------------------- orkestrointi

test('offline-käynnistys: ei yhtään pyyntöä, käännösaikaiset portit, ei odotusta', async () => {
  const server = serverFor({ applied: ALL });
  const started = Date.now();
  const result = await ensureSchemaCompatibility({ client: server, isOnline: () => false, storage: memoryStorage() });
  assert.equal(result.outcome, 'offline');
  assert.equal(server.calls.length, 0);
  assert.equal(schemaSnapshot().status, SCHEMA_STATUS.UNVERIFIED);
  assert.equal(isWritable(), true);
  // Ei verkkoa -> ei odotusta (väljä raja: rinnakkaisajo voi hidastaa).
  assert.ok(Date.now() - started < 1000);
});

test('offline-käynnistys käyttää välimuistia, eikä sekään tee pyyntöjä', async () => {
  const storage = memoryStorage();
  // Aiempi istunto: kannasta puuttuu 0002 -> laajennetut kentät pois.
  const earlier = serverFor({ applied: ['0001'] });
  await ensureSchemaCompatibility({ client: earlier, isOnline: ONLINE, storage, now: () => 1000 });
  assert.equal(isColumnGateLowered('TASK_EXTENDED_FIELDS'), TASK_EXTENDED_FIELDS);

  resetSchemaRuntimeForTests();
  resetSchemaProbeForTests();
  const server = serverFor({ applied: ALL });
  const result = await ensureSchemaCompatibility({ client: server, isOnline: () => false, storage });
  assert.equal(result.outcome, 'offline');
  assert.equal(server.calls.length, 0);
  assert.equal(isColumnGateLowered('TASK_EXTENDED_FIELDS'), TASK_EXTENDED_FIELDS, 'välimuisti laskee yhä');
});

test('verkon palatessa (onlyIfUnverified) tarkistetaan kerran, vaikka välimuisti oli käytössä', async () => {
  const storage = memoryStorage();
  const now = () => 10_000;
  await ensureSchemaCompatibility({ client: serverFor({ applied: ALL }), isOnline: ONLINE, storage, now });
  resetSchemaRuntimeForTests();
  resetSchemaProbeForTests();

  // Offline-käynnistys: välimuisti, ei pyyntöjä.
  const server = serverFor({ applied: ALL });
  await ensureSchemaCompatibility({ client: server, isOnline: () => false, storage, now });
  assert.equal(server.calls.length, 0);

  // Verkko palaa: kanta ei ole vielä vastannut tässä istunnossa -> tarkistus.
  const back = await ensureSchemaCompatibility({ client: server, isOnline: ONLINE, storage, now: () => 10_000 + SCHEMA_CACHE_FRESH_MS + 1, onlyIfUnverified: true });
  assert.equal(back.outcome, 'probe');
  assert.ok(server.calls.length > 0);

  // Toinen palautus samassa istunnossa: ei uutta tarkistusta.
  const calls = server.calls.length;
  const again = await ensureSchemaCompatibility({ client: server, isOnline: ONLINE, storage, now, onlyIfUnverified: true });
  assert.equal(again.outcome, 'skipped');
  assert.equal(server.calls.length, calls);
});

for (const failMode of ['503', 'jwt', 'offline']) {
  test(`"ei tiedetä" (${failMode}): mitään ei lasketa eikä huoltotilaa synny`, async () => {
    const server = serverFor({ applied: ['0001'], failMode });
    const result = await ensureSchemaCompatibility({ client: server, isOnline: ONLINE, storage: memoryStorage() });
    assert.equal(result.outcome, 'probe');
    assert.equal(schemaSnapshot().status, SCHEMA_STATUS.UNVERIFIED);
    assert.equal(isColumnGateLowered('TASK_EXTENDED_FIELDS'), false);
    assert.equal(isWritable(), true);
    assert.deepEqual([...taskColumns()], [...taskColumns(name => COMPILE_GATES.columns[name] === true)]);
  });
}

test('jumittuva palvelin: tarkistus päättyy aikarajaan eikä laske mitään', async () => {
  // Aikaraja todennetaan tuloksesta (timedOut), ei seinäkellosta: koko
  // sarjan rinnakkaisajossa ajastimet voivat myöhästyä satoja
  // millisekunteja. Yläraja vain varmistaa, ettei mikään jää odottamaan.
  const server = serverFor({ applied: ['0001'], failMode: 'hang' });
  const direct = await probeSchema({ client: server, requirements: openRequirements(), timeoutMs: 50 });
  assert.equal(direct.timedOut, true);
  assert.ok(Object.values(direct.results).every(result => result === PROBE_RESULT.UNKNOWN));

  const started = Date.now();
  await ensureSchemaCompatibility({ client: server, isOnline: ONLINE, storage: memoryStorage(), timeoutMs: 120 });
  const took = Date.now() - started;
  assert.ok(took < 120 + 2000, `kesti ${took} ms`);
  assert.equal(schemaSnapshot().status, SCHEMA_STATUS.UNVERIFIED);
  assert.equal(isWritable(), true);
});

test('välimuisti: tuore = heti käyttöön + taustatarkistus; vanha = odotetaan', async () => {
  const storage = memoryStorage();
  let clock = 1_000_000;
  const now = () => clock;
  const first = serverFor({ applied: ALL });
  await ensureSchemaCompatibility({ client: first, isOnline: ONLINE, storage, now });
  assert.equal(schemaSnapshot().status, SCHEMA_STATUS.OK);
  assert.equal(storage.size(), 1);

  // Tuore välimuisti: palautuu ilman odotusta; tarkistus jatkuu taustalla.
  resetSchemaRuntimeForTests();
  resetSchemaProbeForTests();
  clock += 60_000;
  const second = serverFor({ applied: ALL, failMode: 'hang' });
  const result = await ensureSchemaCompatibility({ client: second, isOnline: ONLINE, storage, now });
  assert.equal(result.outcome, 'cache');
  assert.equal(result.status, SCHEMA_STATUS.OK);
  assert.ok(schemaRevalidation(), 'taustatarkistus käynnistyi');
  second.setFailMode(null);

  // Vanha välimuisti: odotetaan tarkistusta.
  resetSchemaRuntimeForTests();
  resetSchemaProbeForTests();
  clock += SCHEMA_CACHE_FRESH_MS + 1;
  const third = serverFor({ applied: ALL });
  const stale = await ensureSchemaCompatibility({ client: third, isOnline: ONLINE, storage, now });
  assert.equal(stale.outcome, 'probe');
  assert.ok(third.calls.length > 0);
});

test('taustatarkistus päivittää välimuistista otetun tiedon', async () => {
  const storage = memoryStorage();
  const now = () => 5_000;
  await ensureSchemaCompatibility({ client: serverFor({ applied: ALL }), isOnline: ONLINE, storage, now });
  resetSchemaRuntimeForTests();
  resetSchemaProbeForTests();
  // Kanta peruttiin 0002:n osalta: taustatarkistus huomaa sen.
  const server = serverFor({ applied: ['0001'] });
  await ensureSchemaCompatibility({ client: server, isOnline: ONLINE, storage, now });
  await schemaRevalidation();
  assert.equal(isColumnGateLowered('TASK_EXTENDED_FIELDS'), TASK_EXTENDED_FIELDS);
});

test('välimuistin avain riippuu palvelimesta ja vaatimusjoukosta', () => {
  const requirements = openRequirements();
  assert.equal(schemaCacheKey(requirements, 'a.example'), schemaCacheKey(requirements, 'a.example'));
  assert.notEqual(schemaCacheKey(requirements, 'a.example'), schemaCacheKey(requirements, 'b.example'));
  // Eri käännös = eri vaatimusjoukko (esim. yksi portti enemmän tai vähemmän).
  assert.notEqual(schemaCacheKey(requirements, 'a.example'), schemaCacheKey(requirements.slice(1), 'a.example'));
  assert.match(schemaCacheKey(requirements, 'a.example'), /^manifestival\.schemaCompat\.v1\.[0-9a-f]{8}$/);
});

test('kielto (42501) laskee istunnon ajaksi mutta ei jää välimuistiin', async () => {
  const storage = memoryStorage();
  const server = serverFor({ applied: ALL, revoked: ['profile'] });
  await ensureSchemaCompatibility({ client: server, isOnline: ONLINE, storage, now: () => 1 });
  assert.equal(schemaSnapshot().status, SCHEMA_STATUS.MAINTENANCE);
  const cached = JSON.parse(storage.getItem(storage.keys()[0]));
  assert.equal(Object.values(cached.results).includes('forbidden'), false);
});

// ------------------------------------------------------------ huoltotila

test('KRIITTINEN: ydin puuttuu -> huoltotila, eikä yksikään kirjoitus lähde verkkoon', async () => {
  const server = serverFor({ applied: ALL, drop: { tasks: ['title'] } });
  await ensureSchemaCompatibility({ client: server, isOnline: ONLINE, storage: memoryStorage() });
  assert.equal(schemaSnapshot().status, SCHEMA_STATUS.MAINTENANCE);
  assert.equal(isWritable(), false);
  const before = server.calls.length;

  const task = normalizeTask({ id: 't1', title: 'X', date: '2026-09-26' });
  const attempts = [
    await tasksRepo.insertTask(task),
    await tasksRepo.updateTask(task),
    await tasksRepo.setCompleted('t1', true),
    await tasksRepo.deleteTask('t1'),
    await tasksRepo.clearOtherWakeFlags('2026-09-26', 't1'),
    await tasksRepo.patchTask('t1', { title: 'Y' }, task),
    await profileRepo.saveProfile({ age: 30 })
  ];
  // Muistutusasetukset: kannassa vain portin ollessa auki (muuten muisti).
  if (prefsPersistent()) attempts.push(await savePreferences({ enabled: true }));
  // Kannan kokoelmat torjuvat; käännösaikaisesti kiinni olevat elävät
  // muistissa eivätkä koske kantaan lainkaan (huoltotila ei koske niitä).
  for (const repo of ALL_REPOSITORIES.filter(r => r.isPersistent())) {
    attempts.push(await repo.insert({ id: 'x', title: 'X', name: 'X' }));
  }
  for (const repo of ALL_REPOSITORIES.filter(r => !r.isPersistent())) {
    await repo.insert({ id: 'mem-x', title: 'X', name: 'X' });
    repo.clear();
  }
  for (const result of attempts) {
    assert.equal(result.ok, false);
    if (result.error.code === 'persistence_unavailable') {
      assert.equal(result.error.userMessage, MAINTENANCE_REFUSAL_MESSAGE);
    }
  }
  assert.equal(server.calls.length, before, 'verkkoon ei lähtenyt mitään');
  assert.equal(server.writes().length, 0);
  // Kieltäytyminen on skeemaluokka: ei jonoteta, ei hylätä pysyvästi.
  assert.equal(classifyError(attempts[0].error), ERROR_CLASS.SCHEMA);
});

test('KRIITTINEN: huoltotilassa offline-jonoa ei toisteta eikä uutta jonoteta; jono säilyy', async () => {
  await ensureSchemaCompatibility({
    client: serverFor({ applied: ALL, revoked: ['tasks'] }), isOnline: ONLINE, storage: memoryStorage()
  });
  assert.equal(isWritable(), false);

  const saved = new Map();
  const queued = { ...emptyQueue(USER.id), seq: 1, ops: [{
    id: 'op1', seq: 1, domain: 'tasks', operation: 'create', entityId: 't1',
    payload: { title: 'Odottaa', date: '2026-09-26' }, baseValues: {}, createdAt: 1, retryCount: 0,
    status: 'pending', nextAttemptAt: null, lastErrorCode: null, conflictFields: [], force: false
  }] };
  saved.set(USER.id, serializeQueue(queued));
  let repoCalls = 0;
  const sync = createOfflineSync({
    repo: { insertTask: async () => { repoCalls += 1; return { ok: true }; }, getTask: async () => { repoCalls += 1; return { ok: true, value: null }; }, patchTask: async () => { repoCalls += 1; return { ok: true, value: { applied: true } }; } },
    store: { load: id => saved.get(id) || null, save: (id, text) => { saved.set(id, text); return { ok: true, persistent: true }; }, purge: id => saved.delete(id) },
    session: { userId: () => USER.id, snapshot: () => ({}), isSame: () => true },
    now: () => 10, isOnline: () => true, newId: () => 'new-op', canSync: isWritable
  });
  sync.activate(USER.id);

  const run = await sync.replay();
  assert.equal(run.reason, 'schema');
  assert.equal(repoCalls, 0);
  assert.equal(sync.status().total, 1, 'jono koskematon');
  assert.equal(JSON.parse(saved.get(USER.id)).ops.length, 1);

  const added = sync.enqueueTaskCreate(normalizeTask({ id: 't2', title: 'Uusi', date: '2026-09-26' }));
  assert.deepEqual(added, { ok: false, reason: 'maintenance' });
  assert.equal(sync.status().total, 1);
});

test('KRIITTINEN: huoltotilassa aikakirjausten lähtökori säilyy eikä mitään lähetetä', async () => {
  const server = serverFor({ applied: ALL, drop: { profile: ['age'] } });
  await ensureSchemaCompatibility({ client: server, isOnline: ONLINE, storage: memoryStorage() });
  assert.equal(isWritable(), false);
  const before = server.calls.length;
  let outbox = [{ id: 'e1', entryDate: '2026-09-26', minutes: 30, operationId: 'op:e1' }];
  const refusingRepo = {
    isPersistent: () => true,
    insert: async () => writeRefusal('timeEntries')
  };
  const writer = createTimeEntryWriter({
    repo: refusingRepo, userId: () => USER.id,
    loadOutbox: () => outbox.slice(), saveOutbox: (_id, list) => { outbox = list; return { ok: true }; }
  });
  const result = await writer.flush();
  assert.equal(result.left, 1);
  assert.deepEqual(result.rejected, []);
  assert.equal(outbox.length, 1);
  assert.equal(server.calls.length, before);
});

test('"Yritä uudelleen" tarkistaa tasan kerran per painallus ja palauttaa kun kanta toimii', async () => {
  let calls = 0;
  let recoveredAfter = null;
  const ensure = async () => {
    calls += 1;
    await new Promise(resolve => setTimeout(resolve, 5));
    return schemaSnapshot();
  };
  const [a, b] = await Promise.all([retrySchemaCheck({ ensure }), retrySchemaCheck({ ensure })]);
  assert.equal(calls, 1, 'kaksoisnapautus ei aja kahta tarkistusta');
  assert.equal(a.ran, true);
  assert.equal(b.ran, false);
  await retrySchemaCheck({ ensure });
  assert.equal(calls, 2);
  recoveredAfter = isWritable();
  assert.equal(recoveredAfter, true);
});

// ------------------------------------------------------ reaktiivinen

test('reaktiivinen: PGRST204 laskee omistavan portin ja pyytää uuden tarkistuksen; 23514 ei laske', () => {
  const reasons = [];
  setReprobeHandler(reason => { reasons.push(reason); });
  assert.equal(noteSchemaError('tasks', { code: '23514', message: 'check' }), false);
  assert.deepEqual(reasons, []);
  const changed = noteSchemaError('tasks', {
    code: 'PGRST204', message: "Could not find the 'duration_minutes' column of 'tasks' in the schema cache"
  });
  assert.equal(changed, TASK_EXTENDED_FIELDS, 'laskee vain käännösaikaisesti auki olevan portin');
  assert.equal(isColumnGateLowered('TASK_EXTENDED_FIELDS'), TASK_EXTENDED_FIELDS);
  assert.deepEqual(reasons, [TASK_EXTENDED_FIELDS ? 'lowered' : 'schema_error']);
  // Pysyvä istunnon ajan: onnistunut tarkistus ei nosta sitä takaisin
  // (PostgRESTin vanhentunut välimuisti voi yhä hylätä kirjoituksen).
  assert.equal(noteSchemaError('tasks', { code: 'PGRST204', message: "Could not find the 'priority' column" }), false);
});

test('uudelleentarkistus on rajoitettu: yksi odottava kerrallaan', async () => {
  const server = serverFor({ applied: ALL });
  const first = scheduleSchemaReprobe({ delayMs: 1, minIntervalMs: 0, client: server, isOnline: ONLINE, storage: memoryStorage() });
  const second = scheduleSchemaReprobe({ delayMs: 1, minIntervalMs: 0, client: server, isOnline: ONLINE, storage: memoryStorage() });
  assert.ok(first);
  assert.equal(second, null);
  await first;
  assert.ok(isVerified());
  assert.ok(server.calls.every(call => call.op === 'select'));
});

test('requestReprobe ei kaadu ilman käsittelijää eikä käsittelijän virheeseen', () => {
  assert.equal(requestReprobe('x'), false);
  setReprobeHandler(() => { throw new Error('boom'); });
  assert.equal(requestReprobe('x'), true);
});

// ---------------------------------------------------- sarakkeiden riisunta

test('stripLoweredColumns poistaa vain suljetun portin sarakkeet eikä muuta alkuperäistä', () => {
  const row = { id: 'g', title: 'T', metric: 'kg', unit: 'kg', life_area_id: 'a' };
  const stripped = stripLoweredColumns('goals', row, gate => gate !== 'GOAL_PLANNING_FIELDS');
  assert.deepEqual(Object.keys(stripped).sort(), ['id', 'life_area_id', 'title']);
  assert.ok('metric' in row, 'alkuperäinen rivi ennallaan');
  assert.equal(stripLoweredColumns('goals', row, () => true), row, 'ei muutosta -> sama olio');
});

// ------------------------------------------------------------ näkyvä tila

test('näkyvä tila: rajoitettu ja huolto suomeksi, tekniset tiedot vain migraatiotunnisteina', () => {
  const degraded = describeSchemaStatus({ status: 'degraded', pendingMigrations: ['0012', '0013'] });
  assert.equal(degraded.banner.text, SCHEMA_COPY.degraded);
  assert.equal(degraded.banner.details, 'Odottaa palvelimen päivitystä: 0012, 0013');
  assert.equal(degraded.maintenance, null);

  const maintenance = describeSchemaStatus({ status: 'maintenance', pendingMigrations: ['0001'] });
  assert.equal(maintenance.banner, null);
  assert.equal(maintenance.maintenance.text, SCHEMA_COPY.maintenance);

  for (const status of ['ok', 'unverified']) {
    assert.deepEqual(describeSchemaStatus({ status, pendingMigrations: [] }), { banner: null, maintenance: null });
  }
  // Vain nelinumeroiset tunnisteet kelpaavat teknisiin tietoihin.
  assert.equal(technicalDetails({ pendingMigrations: ['time_entries', '0012'] }), 'Odottaa palvelimen päivitystä: 0012');
});

test('KRIITTINEN: yksikään käyttäjälle näkyvä teksti ei sisällä skeeman nimiä eikä koodeja', () => {
  const FORBIDDEN = /PGRST|\b(?:42703|42P01|42501|23514|23503)\b|[a-z]+_[a-z_]+|\b(?:tasks|goals|projects|profile|bills|milestones|life_areas|time_entries|schema|column|table)\b/i;
  const visible = [
    ...Object.values(SCHEMA_COPY),
    SCHEMA_REFUSAL_MESSAGE, MAINTENANCE_REFUSAL_MESSAGE, SERVER_UNAVAILABLE_HINT,
    loadFailureMessage([{ ok: false, error: { cause: { code: 'PGRST205' } } }]),
    loadFailureMessage([{ ok: false, error: { cause: { message: 'Failed to fetch' } } }]),
    technicalDetails({ pendingMigrations: ['0009', '0013'] }),
    describeSchemaStatus({ status: 'degraded', pendingMigrations: ['0012'] }).banner.text
  ];
  for (const text of visible) assert.doesNotMatch(text, FORBIDDEN, text);

  // Merkintä index.html:ssä.
  const html = read('index.html');
  const start = html.indexOf('id="schemaMaintenance"');
  const overlay = html.slice(start, html.indexOf('<!-- Kirjautumisportti -->', start));
  const text = overlay.replace(/<[^>]+>/g, ' ');
  assert.doesNotMatch(text, FORBIDDEN);
  assert.match(overlay, /Yritä uudelleen/);
  assert.match(overlay, /Kirjaudu ulos/);
  assert.match(html, /id="schemaBanner" role="status"/);
});

test('latauksen kooste: skeemavirhe ei käske päivittämään yhteyttä', () => {
  const schemaOnly = loadFailureMessage([
    { ok: false, error: { cause: { code: 'PGRST205' } } },
    { ok: false, error: { cause: { code: '42703' } } }
  ]);
  assert.doesNotMatch(schemaOnly, /yhteys/);
  const mixed = loadFailureMessage([
    { ok: false, error: { cause: { code: 'PGRST205' } } },
    { ok: false, error: { cause: { message: 'Failed to fetch' } } }
  ]);
  assert.equal(mixed, 'Osa tiedoista ei latautunut. Mitään ei kadonnut — päivitä, kun yhteys toimii.');
});

test('puhdas ydin: ilman tietoa tila on "unverified" eikä mitään lasketa', () => {
  const caps = computeCapabilities({ requirements: SCHEMA_REQUIREMENTS, compile: COMPILE_GATES });
  assert.equal(caps.status, SCHEMA_STATUS.UNVERIFIED);
  assert.deepEqual([...caps.loweredColumnGates, ...caps.missingTables, ...caps.readOnlyTables], []);
});

test('ilman tarkistusta ajonaikaiset accessorit vastaavat käännösaikaisia', async () => {
  const schema = await import('../src/data/schema.js');
  for (const key of Object.keys(schema.TABLES)) {
    assert.equal(schema.isTableAvailable(key), schema.hasTable(key), key);
  }
  for (const [name, open] of Object.entries(schema.COMPILE_COLUMN_GATES)) {
    assert.equal(schema.columnGateOpen(name), open, name);
  }
  assert.equal(schema.writeRefusal('goals'), null);
  assert.equal(schema.SCHEMA_REFUSAL_MESSAGE.endsWith('Muutosta ei tallennettu.'), true);
});
