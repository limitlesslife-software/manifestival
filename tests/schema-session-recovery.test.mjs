// Ajonaikaisen skeematarkistuksen palautuminen ja istuntoraja.
//
// KOLME VIKAA, JOTKA NÄMÄ TESTIT PITÄVÄT KORJATTUINA
//
//   1. Huoltokatkon aikana ladattu tehtävälista (PGRST205, ydintaulu) laski
//      tehtävien sarakeportit PYSYVÄSTI: kun kanta korjattiin ja käyttäjä
//      painoi "Yritä uudelleen", tila jäi rajoitetuksi ja tehtävät
//      tallentuivat ilman kuvausta ja kestoa sivun lataukseen asti.
//   2. Ajastettu uudelleentarkistus lähti uloskirjautumisen jälkeen
//      anon-roolina, sai 42501/401 -> "kielletty" -> huoltokatko, ja
//      seuraava kirjautuminen alkoi huoltoilmoituksella.
//   3. Välimuisti piti taulua puuttuvana, lataus antoi oletukset, ja kun
//      taustatarkistus löysi taulun, mitään ei ladattu uudelleen: seuraava
//      muistutusasetusten tallennus kirjoitti oletukset palvelimen rivin
//      päälle.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createSchemaServer, memoryStorage, migrationsThrough, ALL_MIGRATIONS } from './helpers/schemaServer.mjs';
import { importAtWave, WAVE_GRAPH_SUPPORTED } from './helpers/waveGraph.mjs';
import {
  classifyProbeError, probeSchema, ensureSchemaCompatibility, scheduleSchemaReprobe,
  resetSchemaProbeForTests
} from '../src/data/schemaProbe.js';
import {
  resetSchemaRuntimeForTests, schemaSnapshot, isWritable, isColumnGateLowered, currentResults,
  recordReactiveFailures, recordProbeResults, reactiveMark, setCapabilities, computeCapabilities,
  raisedTables, raisedColumnGates, setReprobeHandler, PROBE_RESULT, SCHEMA_STATUS
} from '../src/data/schemaRuntime.js';
import {
  SCHEMA_REQUIREMENTS, taskColumns, noteSchemaError, TASK_EXTENDED_FIELDS, COMPILE_COLUMN_GATES
} from '../src/data/schema.js';
import { setClient } from '../src/data/client.js';
import { setUser, clearUser } from '../src/data/session.js';
import * as tasksRepo from '../src/data/tasksRepo.js';
import { normalizeTask } from '../src/domain/task.js';
import { retrySchemaCheck, initSchemaStatus, setSchemaStatusActive } from '../src/app/schemaStatus.js';

const USER = { id: 'aaaaaaaa-7171-4171-8171-000000000071', email: 's@example.com' };
const ONLINE = () => true;
// Ajan tasalla oleva kanta = jokainen repon migraatio. Kiinteä raja (ennen
// '0013') jäi jälkeen aallosta K, jonka portit vaativat 0014:n: "korjattu"
// kanta oli silloin yhä rajoitettu, eikä testi todistanut palautumista.
const ALL = ALL_MIGRATIONS;
const graphTest = WAVE_GRAPH_SUPPORTED ? test : test.skip;

beforeEach(() => {
  resetSchemaRuntimeForTests();
  resetSchemaProbeForTests();
  setUser(USER);
});

afterEach(() => {
  setSchemaStatusActive(false);
  resetSchemaRuntimeForTests();
  resetSchemaProbeForTests();
  clearUser();
});

/** PostgREST-vastaus "taulua ei ole" kaikkiin kyselyihin. */
function missingTableQuery(name) {
  const response = {
    data: null, status: 404,
    error: { code: 'PGRST205', message: `Could not find the table 'public.${name}' in the schema cache`, details: null }
  };
  const q = {};
  for (const method of ['select', 'limit', 'eq', 'neq', 'is', 'order', 'maybeSingle', 'single', 'insert',
    'update', 'upsert', 'delete', 'abortSignal']) {
    q[method] = () => q;
  }
  q.then = (resolve, reject) => Promise.resolve(response).then(resolve, reject);
  return q;
}

/** Palvelin, josta yksi taulu puuttuu kunnes `state.missing = false`. */
function withMissingTable(server, table) {
  const state = { missing: true };
  return {
    state,
    client: { from: name => (name === table && state.missing ? missingTableQuery(name) : server.from(name)) }
  };
}

/** Palvelin, jonka vastaukset odottavat porttia (kesken oleva tarkistus). */
function delayed(server, gatePromise) {
  return {
    from(name) {
      const target = server.from(name);
      const wrapped = new Proxy(target, {
        get(object, prop) {
          if (prop === 'then') return (resolve, reject) => gatePromise.then(() => object.then(resolve, reject));
          const value = object[prop];
          if (typeof value !== 'function') return value;
          return (...args) => {
            const result = value.apply(object, args);
            return result === object ? wrapped : result;
          };
        }
      });
      return wrapped;
    }
  };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

// =====================================================================
// 1. YDINTAULUN PUUTTUMINEN EI LASKE SARAKEPORTTEJA PYSYVÄSTI
// =====================================================================

test('KRIITTINEN: huoltotila -> lista PGRST205 -> kanta korjattu -> "Yritä uudelleen" = OK ja tehtävien sarakkeet täynnä', async () => {
  const server = createSchemaServer({ applied: ALL, currentUserId: () => USER.id });
  const { state, client } = withMissingTable(server, 'tasks');
  setClient(client);
  const storage = memoryStorage();
  const ensure = options => ensureSchemaCompatibility({ ...options, client, isOnline: ONLINE, storage });

  await ensure({});
  assert.equal(schemaSnapshot().status, SCHEMA_STATUS.MAINTENANCE, 'lähtötilanne: ydin puuttuu');

  // Lataus ajetaan huoltotilassakin: tehtävälista vastaa "taulua ei ole".
  const listed = await tasksRepo.listTasks();
  assert.equal(listed.ok, false);
  assert.equal(listed.error.cause.code, 'PGRST205');

  // Kanta korjataan, ja käyttäjä painaa "Yritä uudelleen".
  state.missing = false;
  const retried = await retrySchemaCheck({ ensure });
  assert.equal(retried.recovered, true);
  assert.equal(schemaSnapshot().status, SCHEMA_STATUS.OK, 'tila jäi rajoitetuksi huoltokatkon jälkeen');
  assert.equal(isColumnGateLowered('TASK_EXTENDED_FIELDS'), false);
  // Täysi = käännösaikaiset sarakeportit (kanta on ajan tasalla), ei vain
  // TASK_EXTENDED_FIELDS: aallosta G alkaen suunnittelu- ja liitossarakkeet
  // kuuluvat tehtävään.
  const full = [...taskColumns(name => COMPILE_COLUMN_GATES[name] === true)];
  assert.deepEqual([...taskColumns()], full, 'tehtävien sarakkeet jäivät laskettuina');

  // Seuraava tallennus lähettää kuvauksen ja keston.
  const inserted = await tasksRepo.insertTask(normalizeTask({
    id: 'after-maintenance', title: 'Tehtävä', date: '2026-09-26', description: 'Kuvaus', durationMinutes: 30
  }));
  assert.equal(inserted.ok, true);
  const keys = server.writes().at(-1).payloadKeys;
  if (TASK_EXTENDED_FIELDS) assert.ok(keys.includes('description') && keys.includes('duration_minutes'), keys.join(','));
});

test('ydintaulun PGRST205 ei laske mitään, mutta pyytää uuden tarkistuksen', () => {
  const reasons = [];
  setReprobeHandler(reason => { reasons.push(reason); });
  assert.equal(noteSchemaError('tasks', { code: 'PGRST205', message: 'x' }), false);
  assert.equal(noteSchemaError('profile', { code: '42P01', message: 'x' }), false);
  assert.deepEqual(Object.keys(currentResults()), [], 'ydintaulun puute kirjattiin reaktiivisesti');
  assert.deepEqual(reasons, ['schema_error', 'schema_error']);
});

test('reaktiivinen kirjanpito: puuttuva taulu kumoutuu tarkistuksen "ok":lla, PGRST204 ei', () => {
  recordReactiveFailures({ table_before: PROBE_RESULT.MISSING_TABLE, column_42703: PROBE_RESULT.MISSING_COLUMN });
  recordReactiveFailures({ column_pgrst204: PROBE_RESULT.MISSING_COLUMN }, { sticky: true });
  const mark = reactiveMark();
  // Tarkistuksen aikana tullut virhe on sitä tuoreempi: ei kumoudu.
  recordReactiveFailures({ table_during: PROBE_RESULT.MISSING_TABLE });

  const ok = {
    table_before: PROBE_RESULT.OK, column_42703: PROBE_RESULT.OK,
    column_pgrst204: PROBE_RESULT.OK, table_during: PROBE_RESULT.OK
  };
  // Välimuisti on vanhempaa tietoa kuin virhe: ei kumoa mitään.
  recordProbeResults(ok, { from: 'cache', reactiveUpTo: mark });
  assert.equal(currentResults().table_before, PROBE_RESULT.MISSING_TABLE);

  recordProbeResults(ok, { from: 'probe', reactiveUpTo: mark });
  const results = currentResults();
  assert.equal(results.table_before, PROBE_RESULT.OK);
  assert.equal(results.column_42703, PROBE_RESULT.OK);
  assert.equal(results.column_pgrst204, PROBE_RESULT.MISSING_COLUMN, 'PGRST204 on pysyvä istunnon ajan');
  assert.equal(results.table_during, PROBE_RESULT.MISSING_TABLE, 'tarkistusta tuoreempi virhe kumottiin');
});

test('reaktiivinen kirjanpito: tarkistuksen aikana TOISTUNUT virhe ei kumoudu sen "ok":lla', () => {
  recordReactiveFailures({ repeated: PROBE_RESULT.MISSING_TABLE });
  const mark = reactiveMark();
  assert.equal(recordReactiveFailures({ repeated: PROBE_RESULT.MISSING_TABLE }), false, 'toisto ei ole muutos');
  recordProbeResults({ repeated: PROBE_RESULT.OK }, { from: 'probe', reactiveUpTo: mark });
  assert.equal(currentResults().repeated, PROBE_RESULT.MISSING_TABLE);
});

// =====================================================================
// 2. ISTUNTORAJA: UUDELLEENTARKISTUS JA KIELLOT
// =====================================================================

test('anon-roolin 42501 (HTTP 401) on "ei tiedetä", kirjautuneen 42501 (403) on kielto', async () => {
  assert.equal(classifyProbeError({ code: '42501', message: 'permission denied' }, 401), PROBE_RESULT.UNKNOWN);
  assert.equal(classifyProbeError({ code: '42501', message: 'permission denied' }, 403), PROBE_RESULT.FORBIDDEN);
  assert.equal(classifyProbeError({ code: '42501' }), PROBE_RESULT.FORBIDDEN);

  // Tila luetaan vastauksesta (supabase-js ei pidä sitä virheoliossa).
  const client = {
    from: () => {
      const q = {
        select: () => q, limit: () => q,
        then: (resolve) => Promise.resolve({ data: null, status: 401, error: { code: '42501', message: 'permission denied' } }).then(resolve)
      };
      return q;
    }
  };
  const requirements = SCHEMA_REQUIREMENTS.filter(r => r.id === '0001.profile');
  const { results } = await probeSchema({ client, requirements });
  assert.equal(results['0001.profile'], PROBE_RESULT.UNKNOWN);
});

test('KRIITTINEN: uloskirjautuminen peruu odottavan uudelleentarkistuksen', async () => {
  const server = createSchemaServer({ applied: ALL, currentUserId: () => USER.id });
  initSchemaStatus({ onRecovered: () => {} });
  setSchemaStatusActive(true);
  const pending = scheduleSchemaReprobe({
    delayMs: 1, minIntervalMs: 0, client: server, isOnline: ONLINE, storage: memoryStorage()
  });
  assert.ok(pending);
  setSchemaStatusActive(false); // main.js onSignedOut
  const result = await pending;
  assert.equal(result.outcome, 'cancelled');
  assert.equal(server.calls.length, 0, 'peruttu tarkistus lähti silti');
  // Uusi ajastus onnistuu heti (edellinen ei jäänyt "odottamaan").
  setSchemaStatusActive(true);
  const next = scheduleSchemaReprobe({
    delayMs: 1, minIntervalMs: 0, client: server, isOnline: ONLINE, storage: memoryStorage()
  });
  assert.ok(next);
  await next;
  assert.ok(server.calls.length > 0);
});

test('ilman kirjautunutta käyttäjää tarkistus ei tee yhtään pyyntöä', async () => {
  const server = createSchemaServer({ applied: ALL, revoked: ['profile'] });
  clearUser();
  const result = await ensureSchemaCompatibility({ client: server, isOnline: ONLINE, storage: memoryStorage() });
  assert.equal(result.outcome, 'no_session');
  assert.equal(server.calls.length, 0);
  assert.equal(isWritable(), true);
});

test('KRIITTINEN: kielto unohtuu uloskirjautuessa — seuraava kirjautuminen ei ala huoltoilmoituksella', async () => {
  const server = createSchemaServer({ applied: ALL, revoked: ['profile'], currentUserId: () => USER.id });
  initSchemaStatus({ onRecovered: () => {} });
  setSchemaStatusActive(true);
  await ensureSchemaCompatibility({ client: server, isOnline: ONLINE, storage: memoryStorage() });
  assert.equal(schemaSnapshot().status, SCHEMA_STATUS.MAINTENANCE, 'lähtötilanne: kielto');

  clearUser();
  setSchemaStatusActive(false);
  assert.notEqual(schemaSnapshot().status, SCHEMA_STATUS.MAINTENANCE);
  assert.equal(isWritable(), true);

  // Seuraava kirjautuminen offline: ei tarkistusta, eikä vanha kielto palaa.
  setUser(USER);
  setSchemaStatusActive(true);
  await ensureSchemaCompatibility({ client: server, isOnline: () => false, storage: memoryStorage() });
  assert.equal(isWritable(), true, 'edellisen istunnon kielto jäi voimaan');
});

test('KRIITTINEN: kesken uloskirjautumisen valmistuva tarkistus hylätään, ja uusi istunto tarkistaa omansa', async () => {
  const server = createSchemaServer({ applied: ALL, revoked: ['profile'], currentUserId: () => USER.id });
  const gate = deferred();
  const storage = memoryStorage();
  const slow = delayed(server, gate.promise);
  const first = ensureSchemaCompatibility({ client: slow, isOnline: ONLINE, storage });

  clearUser();                    // uloskirjautuminen kesken tarkistuksen
  setUser({ id: 'bbbbbbbb-7272-4272-8272-000000000072', email: 'b@example.com' });
  const second = ensureSchemaCompatibility({ client: server, isOnline: ONLINE, storage: memoryStorage() });
  assert.notEqual(first, second, 'uusi istunto sai edellisen istunnon tarkistuksen');

  gate.resolve();
  const discarded = await first;
  assert.equal(discarded.outcome, 'discarded');
  assert.deepEqual(storage.keys(), [], 'hylätty tulos meni välimuistiin');
  await second;
  assert.equal(schemaSnapshot().status, SCHEMA_STATUS.MAINTENANCE, 'uuden istunnon oma tulos pätee');
});

// =====================================================================
// 3. KYVYKKYYDEN NOUSU LATAA UUDELLEEN
// =====================================================================

const SYNTHETIC = Object.freeze([Object.freeze({
  id: 'x.goals', migration: '0099', kind: 'table', table: 'goals', tableKey: 'goals', core: false,
  gate: null, lowerAs: null, columns: Object.freeze(['id'])
})]);
const SYNTHETIC_COMPILE = { tables: { goals: true }, columns: {} };
const capsWith = result => computeCapabilities({
  requirements: SYNTHETIC, compile: SYNTHETIC_COMPILE, results: { 'x.goals': result }, verified: true
});

test('raisedTables: puuttuva -> luettava ja vain luku -> kirjoitettava ovat nousuja, lasku ei', () => {
  const missing = capsWith(PROBE_RESULT.MISSING_TABLE);
  const readonly = capsWith(PROBE_RESULT.MISSING_COLUMN);
  const ok = capsWith(PROBE_RESULT.OK);
  assert.deepEqual(raisedTables(missing, ok), ['goals']);
  assert.deepEqual(raisedTables(missing, readonly), ['goals']);
  assert.deepEqual(raisedTables(readonly, ok), ['goals']);
  assert.deepEqual(raisedTables(ok, missing), []);
  assert.deepEqual(raisedTables(readonly, missing), []);
});

test('raisedColumnGates: laskettu -> auki on nousu, lasku ja ennallaan pysyvä eivät', () => {
  const gates = (...names) => ({ loweredColumnGates: names });
  assert.deepEqual(raisedColumnGates(gates('GOAL_PLANNING_FIELDS', 'TASK_LINK_FIELDS'), gates('TASK_LINK_FIELDS')),
    ['GOAL_PLANNING_FIELDS']);
  assert.deepEqual(raisedColumnGates(gates(), gates('GOAL_PLANNING_FIELDS')), []);
  assert.deepEqual(raisedColumnGates(gates('TASK_LINK_FIELDS'), gates('TASK_LINK_FIELDS')), []);
});

test('KRIITTINEN: kun taulu löytyy, tiedot ladataan ja odottavat lähetetään uudelleen (kerran)', () => {
  let recovered = 0;
  initSchemaStatus({ onRecovered: () => { recovered += 1; } });
  setSchemaStatusActive(true);
  setCapabilities(capsWith(PROBE_RESULT.MISSING_TABLE));
  assert.equal(recovered, 0, 'lasku ei lataa uudelleen');
  setCapabilities(capsWith(PROBE_RESULT.OK));
  assert.equal(recovered, 1, 'nousu ei käynnistänyt latausta');

  // Uloskirjautuneelle ei ladata mitään.
  setCapabilities(capsWith(PROBE_RESULT.MISSING_TABLE));
  setSchemaStatusActive(false);
  setCapabilities(capsWith(PROBE_RESULT.OK));
  assert.equal(recovered, 1);
});

// ------------------------------------------------ oikea koodi aallon J porteilla

async function loadWaveJ() {
  const [schema, runtime, probe, client, session, prefs, status] = await Promise.all([
    importAtWave('J', 'data/schema.js'),
    importAtWave('J', 'data/schemaRuntime.js'),
    importAtWave('J', 'data/schemaProbe.js'),
    importAtWave('J', 'data/client.js'),
    importAtWave('J', 'data/session.js'),
    importAtWave('J', 'data/notificationPrefsRepo.js'),
    importAtWave('J', 'app/schemaStatus.js')
  ]);
  return { schema, runtime, probe, client, session, prefs, status };
}

const PREFS_ROW = Object.freeze({
  id: USER.id, enabled: true, task_lead_minutes: 45, routine_lead_minutes: 10, daily_plan_time: '07:30',
  evening_review_time: '21:00', daily_plan_enabled: true, evening_review_enabled: false,
  deadline_warnings_enabled: true, max_per_day: 6, quiet_hours_from: '22:00', quiet_hours_to: '07:00'
});

async function freshSession(g) {
  g.status.setSchemaStatusActive(false);
  g.runtime.resetSchemaRuntimeForTests();
  g.probe.resetSchemaProbeForTests();
  g.prefs.clearPreferences();
  g.session.setUser(USER);
}

graphTest('KRIITTINEN aalto J: välimuistin "puuttuu" -> taustatarkistus löytää taulun -> lataus, eikä oletuksia tallenneta palvelimen rivin päälle', async () => {
  const g = await loadWaveJ();
  const storage = memoryStorage();
  const host = 'recovery.example';
  await freshSession(g);

  // Aiempi istunto: kannassa ei vielä ollut muistutusasetuksia (0005).
  const early = createSchemaServer({ applied: migrationsThrough('0004'), currentUserId: () => USER.id });
  g.client.setClient(early);
  await g.probe.ensureSchemaCompatibility({ client: early, isOnline: ONLINE, storage, now: () => 1000, host });
  assert.equal(g.schema.isTableMissing('notificationPreferences'), true);

  // Uusi käynnistys: kanta on päivitetty, ja käyttäjällä on jo asetukset.
  await freshSession(g);
  const server = createSchemaServer({ applied: ALL, currentUserId: () => USER.id });
  server.rows('notification_preferences').push({ ...PREFS_ROW });
  const gate = deferred();
  const client = delayed(server, gate.promise);
  g.client.setClient(client);
  let recovered = 0;
  g.status.initSchemaStatus({ onRecovered: () => { recovered += 1; } });
  g.status.setSchemaStatusActive(true);

  const started = await g.probe.ensureSchemaCompatibility({ client, isOnline: ONLINE, storage, now: () => 2000, host });
  assert.equal(started.outcome, 'cache');
  // Tuore välimuisti: taulu "puuttuu", lataus antaa hiljaiset oletukset.
  const loaded = await g.prefs.loadPreferences();
  assert.equal(loaded.ok, true);
  assert.equal(loaded.value.taskLeadMinutes !== 45, true, 'lähtötilanne: oletukset, ei palvelimen riviä');

  gate.resolve();
  await g.probe.schemaRevalidation();
  assert.equal(g.schema.isTableMissing('notificationPreferences'), false);
  assert.equal(recovered, 1, 'taulu löytyi, mutta tietoja ei ladattu uudelleen');

  // Ennen uudelleenlatausta: oletusten päälle tehty muutos torjutaan.
  const before = server.writes().length;
  const saved = await g.prefs.savePreferences({ ...loaded.value, maxPerDay: 2 });
  assert.equal(saved.ok, false, 'oletukset tallennettiin palvelimen rivin päälle');
  assert.equal(server.writes().length, before);
  assert.equal(server.rows('notification_preferences')[0].task_lead_minutes, 45);

  // Uudelleenlataus tuo oikeat asetukset, ja niiden tallennus toimii.
  const reloaded = await g.prefs.loadPreferences();
  assert.equal(reloaded.value.taskLeadMinutes, 45);
  const again = await g.prefs.savePreferences({ ...reloaded.value, maxPerDay: 2 });
  assert.equal(again.ok, true);
  assert.deepEqual([server.rows('notification_preferences')[0].task_lead_minutes,
    server.rows('notification_preferences')[0].max_per_day], [45, 2]);
  g.status.setSchemaStatusActive(false);
  g.session.clearUser();
});

graphTest('aalto J: uusi käyttäjä ilman riviä voi tallentaa asetukset ilman erillistä latausta', async () => {
  const g = await loadWaveJ();
  await freshSession(g);
  const server = createSchemaServer({ applied: ALL, currentUserId: () => USER.id });
  g.client.setClient(server);
  const saved = await g.prefs.savePreferences({ enabled: true });
  assert.equal(saved.ok, true);
  assert.deepEqual(server.calls.map(call => call.op), ['select', 'upsert'], 'rivi luetaan ennen ensimmäistä tallennusta');
  const next = await g.prefs.savePreferences({ enabled: false });
  assert.equal(next.ok, true);
  assert.deepEqual(server.calls.map(call => call.op), ['select', 'upsert', 'upsert'], 'luetaan vain kerran');
  g.session.clearUser();
});

graphTest('aalto J: edellisen istunnon myöhästynyt lataus ei kelpaa tallennuksen lähtötiedoksi', async () => {
  const g = await loadWaveJ();
  await freshSession(g);
  const server = createSchemaServer({ applied: ALL, currentUserId: () => USER.id });
  server.rows('notification_preferences').push({ ...PREFS_ROW });
  const gate = deferred();
  g.client.setClient(delayed(server, gate.promise));
  const stale = g.prefs.loadPreferences();
  // Uloskirjautuminen ja uusi kirjautuminen kesken latauksen.
  g.session.clearUser();
  g.prefs.clearPreferences();
  g.session.setUser(USER);
  gate.resolve();
  await stale;
  g.client.setClient(server);
  const saved = await g.prefs.savePreferences({ enabled: false });
  assert.equal(saved.ok, false, 'vanhan istunnon lataus hyväksyi oletusten tallennuksen');
  assert.equal(server.rows('notification_preferences')[0].enabled, true);
  g.session.clearUser();
});

graphTest('KRIITTINEN aalto J: luettu rivi -> PGRST205 -> oletukset -> tarkistus löytää taulun: tallennus ei korvaa riviä oletuksilla', async () => {
  const g = await loadWaveJ();
  await freshSession(g);
  const server = createSchemaServer({ applied: ALL, currentUserId: () => USER.id });
  server.rows('notification_preferences').push({ ...PREFS_ROW });
  const { state, client } = withMissingTable(server, 'notification_preferences');
  state.missing = false;
  g.client.setClient(client);
  const reprobe = () => g.probe.ensureSchemaCompatibility({
    client, isOnline: ONLINE, storage: memoryStorage(), force: true
  });
  await reprobe();

  // 1. Asetukset luetaan palvelimelta: lähtötieto on olemassa.
  const loaded = await g.prefs.loadPreferences();
  assert.equal(loaded.value.taskLeadMinutes, 45);

  // 2. Kanta vastaa hetken "taulua ei ole": taulu lasketaan (lukuvirhe, ei pysyvä).
  state.missing = true;
  assert.equal((await g.prefs.loadPreferences()).ok, false);
  assert.equal(g.schema.isTableMissing('notificationPreferences'), true);

  // 3. Päivitys antaa näkymälle hiljaiset oletukset.
  const defaults = await g.prefs.loadPreferences();
  assert.equal(defaults.ok, true);
  assert.notEqual(defaults.value.taskLeadMinutes, 45, 'lähtötilanne: oletukset, ei palvelimen riviä');

  // 4. Uusi tarkistus löytää taulun, ja puute kumoutuu.
  state.missing = false;
  await reprobe();
  assert.equal(g.schema.isTableMissing('notificationPreferences'), false);

  // 5. Tallennus oletusten päältä ennen palautuksen latausta: rivi luetaan
  //    ensin ja muutos torjutaan -- palvelimen rivi säilyy ennallaan.
  const writesBefore = server.writes().length;
  const saved = await g.prefs.savePreferences({ ...defaults.value, maxPerDay: 2 });
  assert.equal(saved.ok, false, 'oletukset tallennettiin palvelimen rivin päälle');
  assert.equal(server.writes().length, writesBefore);
  assert.deepEqual(server.rows('notification_preferences')[0], { ...PREFS_ROW });

  // Uudelleenlataus tuo oikeat asetukset, ja niiden tallennus toimii.
  const reloaded = await g.prefs.loadPreferences();
  assert.equal(reloaded.value.taskLeadMinutes, 45);
  assert.equal((await g.prefs.savePreferences({ ...reloaded.value, maxPerDay: 2 })).ok, true);
  assert.deepEqual([server.rows('notification_preferences')[0].task_lead_minutes,
    server.rows('notification_preferences')[0].max_per_day], [45, 2]);
  g.session.clearUser();
});

graphTest('aalto J: oletuksiin päättynyttä latausta vanhempi, myöhässä valmistuva luku ei palauta lähtötietoa', async () => {
  const g = await loadWaveJ();
  await freshSession(g);
  const server = createSchemaServer({ applied: ALL, currentUserId: () => USER.id });
  server.rows('notification_preferences').push({ ...PREFS_ROW });
  const gate = deferred();
  g.client.setClient(delayed(server, gate.promise));
  const older = g.prefs.loadPreferences();

  // Kesken luvun taulu todetaan puuttuvaksi, ja uudempi lataus antaa oletukset.
  g.schema.noteSchemaError('notification_preferences', { code: 'PGRST205', message: 'x' });
  const defaults = await g.prefs.loadPreferences();
  assert.notEqual(defaults.value.taskLeadMinutes, 45);
  gate.resolve();
  assert.equal((await older).value.taskLeadMinutes, 45);

  g.client.setClient(server);
  await g.probe.ensureSchemaCompatibility({ client: server, isOnline: ONLINE, storage: memoryStorage(), force: true });
  assert.equal(g.schema.isTableMissing('notificationPreferences'), false);
  const saved = await g.prefs.savePreferences({ ...defaults.value, maxPerDay: 2 });
  assert.equal(saved.ok, false, 'vanhempi luku kelpasi oletusten tallennuksen lähtötiedoksi');
  assert.deepEqual(server.rows('notification_preferences')[0], { ...PREFS_ROW });
  g.session.clearUser();
});

/** Palvelin, jonka `table`-tauluun jokainen kirjoitus vastaa `error`:lla; luku toimii. */
function failingWrites(server, table, error) {
  return {
    from(name) {
      const target = server.from(name);
      if (name !== table) return target;
      let writing = false;
      const wrapped = new Proxy(target, {
        get(object, prop) {
          if (prop === 'then') {
            return (resolve, reject) => (writing
              ? Promise.resolve({ data: null, error, status: 400 }) : object).then(resolve, reject);
          }
          const value = object[prop];
          if (typeof value !== 'function') return value;
          return (...args) => {
            if (['insert', 'update', 'upsert', 'delete'].includes(prop)) writing = true;
            const result = value.apply(object, args);
            return result === object ? wrapped : result;
          };
        }
      });
      return wrapped;
    }
  };
}

graphTest('KRIITTINEN aalto J: kirjoituksen skeemavirhe on pysyvä istunnon ajan, lukemisen puute kumoutuu tarkistuksen "ok":lla', async () => {
  const g = await loadWaveJ();
  await freshSession(g);
  const server = createSchemaServer({ applied: ALL, currentUserId: () => USER.id });
  g.client.setClient(server);
  const reprobe = () => g.probe.ensureSchemaCompatibility({
    client: server, isOnline: ONLINE, storage: memoryStorage(), force: true
  });
  await reprobe();
  assert.equal(g.runtime.schemaSnapshot().status, SCHEMA_STATUS.OK, 'lähtötilanne: kanta on ajan tasalla');

  // Kirjoitukset (payloadin avaimet tai { write: true }).
  g.schema.noteSchemaError('tasks', {
    code: 'PGRST204', message: "Could not find the 'milestone_id' column of 'tasks' in the schema cache"
  }, ['title', 'milestone_id']);
  g.schema.noteSchemaError('goals', {
    code: '42703', message: 'column "life_area_id" of relation "goals" does not exist'
  }, ['title', 'life_area_id']);
  g.schema.noteSchemaError('time_entries', {
    code: '42P01', message: 'relation "public.time_entries" does not exist'
  }, [], { write: true });
  // Kirjoitus ilman avaimia oikean repositorion kautta: tehtävän lisäys.
  g.client.setClient(failingWrites(server, 'tasks', {
    code: '42703', message: 'column "deadline" of relation "tasks" does not exist'
  }));
  const tasksRepo = await importAtWave('J', 'data/tasksRepo.js');
  const inserted = await tasksRepo.insertTask(normalizeTask({ id: 'st-1', title: 'T', date: '2026-09-26' }));
  assert.equal(inserted.error.cause.code, '42703');
  g.client.setClient(server);
  // Lukemiset: sama koodi ilman kirjoitusta.
  g.schema.noteSchemaError('bills', { code: '42703', message: 'column bills.payee does not exist' });
  g.schema.noteSchemaError('notification_preferences', {
    code: 'PGRST205', message: "Could not find the table 'public.notification_preferences' in the schema cache"
  });
  g.schema.noteSchemaError('savings_goals', { code: '42P01', message: 'relation "public.savings_goals" does not exist' });

  const lowered = () => ({
    planning: g.schema.columnGateOpen('GOAL_PLANNING_FIELDS'),
    lifeArea: g.schema.columnGateOpen('GOAL_LIFE_AREA_FIELD'),
    links: g.schema.columnGateOpen('TASK_LINK_FIELDS'),
    timeEntries: g.schema.isTableAvailable('timeEntries'),
    billPayment: g.schema.columnGateOpen('BILL_PAYMENT_FIELDS'),
    preferences: g.schema.isTableAvailable('notificationPreferences'),
    savings: g.schema.isTableAvailable('savingsGoals')
  });
  assert.deepEqual(lowered(), {
    planning: false, lifeArea: false, links: false, timeEntries: false,
    billPayment: false, preferences: false, savings: false
  }, 'lähtötilanne: kaikki laskettu');

  // Uusi tarkistus näkee kaiken kunnossa: vain lukemisen puutteet kumoutuvat.
  await reprobe();
  assert.deepEqual(lowered(), {
    planning: false, lifeArea: false, links: false, timeEntries: false,
    billPayment: true, preferences: true, savings: true
  }, 'kirjoituksen puute kumoutui (kehä) tai lukemisen puute jäi voimaan');
  g.session.clearUser();
});

/** Palvelin, josta annetut taulut puuttuvat, kunnes ne poistetaan joukosta `missing`. */
function withMissingTables(server, tables) {
  const missing = new Set(tables);
  return { missing, client: { from: name => (missing.has(name) ? missingTableQuery(name) : server.from(name)) } };
}

/** Odota, kunnes ehto täyttyy (enintään `ms`), ja anna kesken olevien ketjujen valmistua. */
async function settle(condition, ms = 5000) {
  const until = Date.now() + ms;
  while (!condition() && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
  await new Promise(resolve => setTimeout(resolve, 50));
}

graphTest('aalto J: ajastetun uudelleentarkistuksen aikana noussut taulu palauttaa kerran (kuuntelija + tarkistuspyyntö)', async () => {
  const g = await loadWaveJ();
  await freshSession(g);
  const server = createSchemaServer({ applied: ALL, currentUserId: () => USER.id });
  const { missing, client } = withMissingTables(server, ['notification_preferences']);
  g.client.setClient(client);
  let recovered = 0;
  g.status.initSchemaStatus({ onRecovered: () => { recovered += 1; } });
  g.status.setSchemaStatusActive(true);
  try {
    await g.probe.ensureSchemaCompatibility({ client, isOnline: ONLINE, storage: memoryStorage() });
    assert.equal(g.schema.isTableMissing('notificationPreferences'), true, 'lähtötilanne: taulu puuttuu');
    assert.equal(recovered, 0);

    // Kanta korjataan; skeemavirhe pyytää uuden tarkistuksen (ajastettu, oletusviive).
    missing.clear();
    const generation = g.runtime.schemaGeneration();
    assert.equal(g.runtime.requestReprobe('schema_error'), true);
    await settle(() => g.runtime.schemaGeneration() !== generation && recovered > 0);
    assert.equal(g.schema.isTableMissing('notificationPreferences'), false);
    // Sekä nousun kuuntelija että tarkistuspyynnön jatko huomaavat saman muutoksen.
    assert.equal(recovered, 1, 'sama kyvykkyyden muutos palautettiin useammin kuin kerran');
  } finally {
    g.status.setSchemaStatusActive(false);
    g.session.clearUser();
  }
});

graphTest('aalto J: "Yritä uudelleen" huoltokatkon jälkeen palauttaa kerran, vaikka nousun kuuntelija ehti ensin', async () => {
  const g = await loadWaveJ();
  await freshSession(g);
  const server = createSchemaServer({ applied: ALL, currentUserId: () => USER.id });
  const { missing, client } = withMissingTables(server, ['tasks', 'notification_preferences']);
  g.client.setClient(client);
  let recovered = 0;
  g.status.initSchemaStatus({ onRecovered: () => { recovered += 1; } });
  g.status.setSchemaStatusActive(true);
  const ensure = options => g.probe.ensureSchemaCompatibility({
    ...options, client, isOnline: ONLINE, storage: memoryStorage()
  });
  try {
    await ensure({});
    assert.equal(g.runtime.schemaSnapshot().status, SCHEMA_STATUS.MAINTENANCE, 'lähtötilanne: huoltokatko');

    missing.clear();
    const retried = await g.status.retrySchemaCheck({ ensure });
    assert.equal(retried.recovered, true);
    assert.equal(g.runtime.schemaSnapshot().status, SCHEMA_STATUS.OK);
    assert.equal(recovered, 1, 'sama kyvykkyyden muutos palautettiin useammin kuin kerran');
    // Uusi painallus ilman muutosta ei palauta uudelleen.
    await g.status.retrySchemaCheck({ ensure });
    assert.equal(recovered, 1);
  } finally {
    g.status.setSchemaStatusActive(false);
    g.session.clearUser();
  }
});

graphTest('KRIITTINEN aalto J: puuttuva taulu (PGRST205) ei jää voimaan, kun uusi tarkistus löytää sen', async () => {
  const g = await loadWaveJ();
  await freshSession(g);
  const behind = createSchemaServer({ applied: migrationsThrough('0008'), currentUserId: () => USER.id });
  g.client.setClient(behind);
  const entries = await importAtWave('J', 'data/collectionsRepo.js');
  const repo = entries.timeEntriesRepo;
  const missing = await repo.insert({ id: 'te-1', entryDate: '2026-09-21', minutes: 30, operationId: 'log:te-1' });
  assert.equal(missing.error.cause.code, 'PGRST205');
  assert.equal(g.schema.isTableAvailable('timeEntries'), false);

  const fixed = createSchemaServer({ applied: ALL, currentUserId: () => USER.id });
  g.client.setClient(fixed);
  await g.probe.ensureSchemaCompatibility({ client: fixed, isOnline: ONLINE, storage: memoryStorage(), force: true });
  assert.equal(g.schema.isTableAvailable('timeEntries'), true, 'hetkellinen puute jäi voimaan sivun lataukseen asti');
  assert.equal((await repo.insert({ id: 'te-2', entryDate: '2026-09-21', minutes: 30, operationId: 'log:te-2' })).ok, true);
  g.session.clearUser();
});
