// Ajonaikaisen skeematarkistuksen matriisi: käännös (aallot C-L) x kanta.
//
// KYSYMYS, JOHON TÄMÄ VASTAA
//
// Mitä tapahtuu, kun asennettu käännös on kantaa EDELLÄ? Esimerkki:
// aallon J APK (kaikki portit auki) ja kanta, johon on ajettu vain
// 0001-0008. Ilman tarkistusta jokainen tehtävän ja tavoitteen tallennus
// kaatui (PGRST204), vaikka lukeminen näytti toimivan.
//
// KAKSI TASOA
//
//   1. Puhdas ydin: synteettiset portit (tools/release/waves.mjs) ja
//      kannan tilat (supabase/migrations/*.sql) -> kyvykkyys.
//   2. Oikea koodi: koko src/-puu kunkin aallon porteilla
//      (tests/helpers/waveGraph.mjs) skeemaa noudattavaa palvelinta
//      vastaan (tests/helpers/schemaServer.mjs). Jokainen kirjoitus joko
//      onnistuu tai torjutaan ENNEN verkkoa -- kanta ei hylkää yhtäkään.
//
// Kannan tilat: 0008, +0009, +0010, +0011, +0012, 0008+0012 (0012 ilman
// 0009-0011:tä), +0013, 0013 ilman operation_id-saraketta, +0014 ja +0015.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WAVE_IDS, waveById, waveIndex } from '../tools/release/waves.mjs';
import {
  createSchemaServer, memoryStorage, DB_STATES, schemaAt, migrationsThrough, ALL_MIGRATIONS
} from './helpers/schemaServer.mjs';
import { waveGates, importAtWave, WAVE_GRAPH_SUPPORTED } from './helpers/waveGraph.mjs';
import { read } from './helpers/sources.mjs';
import {
  SCHEMA_REQUIREMENTS, openRequirements, COMPILE_COLUMN_GATES, TABLES, taskColumns,
  stripLoweredColumns
} from '../src/data/schema.js';
import {
  computeCapabilities, effectiveGates, isRequirementOpen, SCHEMA_STATUS, PROBE_RESULT
} from '../src/data/schemaRuntime.js';
import { probeSchema } from '../src/data/schemaProbe.js';
import { ALL_REPOSITORIES } from '../src/data/collectionsRepo.js';
import { profileToRow } from '../src/data/profileRepo.js';
import { preferencesToRow } from '../src/data/notificationPrefsRepo.js';
import { toRow, TASK_COLUMNS_CORE } from '../src/lib/rows.js';
import { normalizeTask } from '../src/domain/task.js';
import { createOfflineSync, SCHEMA_PENDING_CODE, SCHEMA_PENDING_NOTE } from '../src/app/offlineSync.js';
import { describeSyncLine } from '../src/app/offlineStatus.js';
import { unwritableTaskFields, unwritableInsert } from '../src/data/tasksRepo.js';
import { createTimeEntryWriter } from '../src/app/timeEntryWriter.js';

const WAVES = WAVE_IDS.slice(WAVE_IDS.indexOf('C'));
const USER = { id: 'bbbbbbbb-3333-4333-8333-000000000001', email: 'm@example.com' };
const graphTest = WAVE_GRAPH_SUPPORTED ? test : test.skip;

/** Aallon käännösaikaiset portit sellaisina kuin schema.js ne johtaa. */
function compileFor(wave) {
  const { tables, columns } = waveGates(wave);
  return {
    tables,
    columns: { ...columns, TASK_LINK_FIELDS: tables.goals === true && tables.projects === true }
  };
}

/** Esimerkkirivi repositoriolle: normalisointi täyttää loput. */
function example(repo, suffix = '') {
  return {
    id: `ex-${repo.table}${suffix}`, title: 'Esimerkki', name: 'Esimerkki', text: 'Esimerkki',
    place: 'Koti', message: 'Viesti', entryDate: '2026-09-21', minutes: 30, weekStart: '2026-09-21',
    date: '2026-09-21', timestamp: '2026-09-21T10:00:00.000Z', key: 'avain' + suffix,
    operationId: 'op-' + repo.table + suffix, itemKind: 'task', itemId: 't1',
    startedAt: '2026-09-21T09:00:00.000Z', amountMinor: 1000
  };
}

// =====================================================================
// MANIFESTI VASTAA MIGRAATIOITA JA RIVIMUUNNOKSIA
// =====================================================================

test('manifesti: jokainen vaatimus syntyy juuri siinä migraatiossa, jonka se nimeää', () => {
  for (const requirement of SCHEMA_REQUIREMENTS) {
    const at = schemaAt(migrationsThrough(requirement.migration));
    assert.ok(at.has(requirement.table), `${requirement.id}: taulua ei ole migraatiossa`);
    for (const column of requirement.columns) {
      assert.ok(at.get(requirement.table).has(column), `${requirement.id}: ${column} puuttuu`);
    }
    if (requirement.core) continue;
    const previous = ALL_MIGRATIONS.filter(id => id < requirement.migration);
    const before = schemaAt(previous);
    const existedBefore = before.has(requirement.table)
      && requirement.columns.every(column => before.get(requirement.table).has(column));
    assert.equal(existedBefore, false, `${requirement.id}: oli olemassa jo ennen ${requirement.migration}:aa`);
  }
});

test('manifesti: jokaisella portilla on vaatimus, ja taulun portilla tasan yksi', () => {
  for (const key of Object.keys(TABLES)) {
    const own = SCHEMA_REQUIREMENTS.filter(r => r.kind === 'table' && !r.core && r.tableKey === key);
    assert.equal(own.length, 1, `taulun portti ${key}`);
  }
  for (const gate of Object.keys(COMPILE_COLUMN_GATES)) {
    assert.ok(SCHEMA_REQUIREMENTS.some(r => r.kind === 'column' && r.gate === gate), `sarakeportti ${gate}`);
  }
  const ids = SCHEMA_REQUIREMENTS.map(r => r.id);
  assert.equal(new Set(ids).size, ids.length, 'tunnisteet ovat yksikäsitteisiä');
});

test('manifesti: taulun perusjoukko = rivimuunnoksen sarakkeet porttien ollessa kiinni', () => {
  // Tuotehaaralla sarakeportit ovat kiinni (TASK_EXTENDED ei koske
  // kokoelmia), joten toRow tuottaa täsmälleen perusjoukon + ne
  // sarakeportit, jotka ovat auki.
  for (const repo of ALL_REPOSITORIES) {
    const requirement = SCHEMA_REQUIREMENTS.find(r => r.kind === 'table' && r.tableKey === repo.schemaKey);
    const keys = Object.keys(repo.mapping.toRow(repo.mapping.normalize(example(repo)))).sort();
    const expected = [...requirement.columns, ...SCHEMA_REQUIREMENTS
      .filter(r => r.kind === 'column' && r.table === repo.table && COMPILE_COLUMN_GATES[r.gate] === true)
      .flatMap(r => r.columns)];
    assert.deepEqual(keys, [...new Set(expected)].sort(), repo.table);
  }
  assert.deepEqual(Object.keys(profileToRow({}, 'u')).sort(),
    [...SCHEMA_REQUIREMENTS.find(r => r.id === '0001.profile').columns].sort());
  assert.deepEqual(Object.keys(preferencesToRow({}, 'u')).sort(),
    [...SCHEMA_REQUIREMENTS.find(r => r.id === '0005.notification_preferences').columns].sort());
  const taskRequirementColumns = SCHEMA_REQUIREMENTS.filter(r => r.table === 'tasks').flatMap(r => r.columns);
  assert.deepEqual([...taskColumns(() => true), 'user_id'].sort(), [...new Set(taskRequirementColumns)].sort());
  assert.deepEqual([...taskColumns(() => false)], [...TASK_COLUMNS_CORE]);
});

test('manifesti: rivimuunnosten porttiehdot tuottavat täsmälleen manifestin sarakkeet', () => {
  // Staattinen tarkistus, joka kattaa myös auki olevan portin tilan:
  // `...(PORTTI ? { a: ..., b: ... } : {})` -lohkojen avaimet ovat samat
  // kuin manifestin sarakeportin sarakkeet samalle taululle.
  const source = read('src/data/collectionsRepo.js');
  const blocks = source.split('createRepository({').slice(1);
  let checked = 0;
  for (const block of blocks) {
    const tableMatch = /table: '(\w+)'/.exec(block);
    if (!tableMatch) continue; // itse createRepository-funktion määrittely
    const table = tableMatch[1];
    const toRowPart = block.slice(block.indexOf('toRow:'), block.indexOf('fromRow:'));
    for (const match of toRowPart.matchAll(/\.\.\.\((\w+)\s*\?\s*\{([^}]*)\}\s*:\s*\{\}\)/g)) {
      const keys = [...match[2].matchAll(/(\w+):/g)].map(m => m[1]).sort();
      // 0010.goals_status on GOAL_MAINTENANCE_MODE:n tunnistesarake, ei oma ehtonsa.
      const expected = [...new Set(SCHEMA_REQUIREMENTS
        .filter(r => r.kind === 'column' && r.table === table && r.gate === match[1]
          && r.id !== '0010.goals_status')
        .flatMap(r => r.columns))].sort();
      assert.ok(expected.length > 0, `${table}: ${match[1]} puuttuu manifestista`);
      assert.deepEqual(keys, expected, `${table}: ${match[1]}`);
      checked += 1;
    }
  }
  assert.equal(checked, 8, 'odotettiin kahdeksan porttiehtoa (goals 2, projects, bills, 3 x Suunta, life_areas.kind)');
});

// =====================================================================
// PUHDAS YDIN: AALLOT C-J x KANNAN TILAT
// =====================================================================

for (const wave of WAVES) {
  test(`puhdas ydin, aalto ${wave}: portit vain laskevat, ja puute = auki olevat - kannassa olevat`, async () => {
    const compile = compileFor(wave);
    const requirements = openRequirements(compile);
    for (const [db, state] of Object.entries(DB_STATES)) {
      const server = createSchemaServer(state);
      const { results, requests } = await probeSchema({ client: server, requirements });
      const label = `aalto ${wave}, kanta ${db}`;

      // Vain lukevia, rivittömiä pyyntöjä; enintään yksi per taulu + tarkennus.
      assert.ok(server.calls.every(call => call.op === 'select' && call.limit === 0), label);
      const tables = new Set(requirements.map(r => r.table)).size;
      assert.ok(requests <= tables + requirements.length, `${label}: ${requests} pyyntöä`);
      // Kiinni olevaa porttia ei koskaan tarkisteta.
      for (const requirement of SCHEMA_REQUIREMENTS) {
        if (!isRequirementOpen(requirement, compile)) assert.equal(results[requirement.id], undefined, label);
      }

      const caps = computeCapabilities({ requirements: SCHEMA_REQUIREMENTS, compile, results, verified: true });
      const eff = effectiveGates(compile, caps);
      assert.notEqual(caps.status, SCHEMA_STATUS.MAINTENANCE, `${label}: ydin on kannassa`);

      // (1) Monotonisuus: tehokas portti ei ole koskaan auki, jos käännös on kiinni.
      for (const [key, open] of Object.entries(eff.tables)) {
        if (open) assert.equal(compile.tables[key], true, `${label}: ${key}`);
      }
      for (const [gate, open] of Object.entries(eff.columns)) {
        if (open) assert.equal(compile.columns[gate], true, `${label}: ${gate}`);
      }

      // (2) Puute = auki olevat vaatimukset, joita kannassa ei ole.
      for (const requirement of requirements) {
        const present = server.hasColumns(requirement.table, requirement.columns);
        assert.equal(results[requirement.id] === PROBE_RESULT.OK, present, `${label}: ${requirement.id}`);
      }
      for (const [gate, open] of Object.entries(compile.columns)) {
        if (!open) continue;
        const present = requirements.filter(r => r.gate === gate)
          .every(r => server.hasColumns(r.table, r.columns));
        assert.equal(eff.columns[gate], present, `${label}: ${gate}`);
      }
      for (const [key, open] of Object.entries(compile.tables)) {
        if (!open) continue;
        const own = requirements.find(r => r.kind === 'table' && r.tableKey === key);
        let expected = server.hasColumns(own.table, own.columns);
        // Aikakirjaukset ilman 0013:n sarakkeita: vain luku, kun käännös nojaa niihin.
        if (key === 'timeEntries' && compile.columns.ALIGNMENT_REALITY_FIELDS
          && !server.hasColumns('time_entries', SCHEMA_REQUIREMENTS.find(r => r.id === '0013.time_entries').columns)) {
          expected = false;
        }
        assert.equal(eff.tables[key], expected, `${label}: ${key}`);
      }

      // (3) Kirjoitettava joukko mahtuu kantaan: taulun perusjoukko + tehokkaat sarakeportit.
      for (const [key, open] of Object.entries(eff.tables)) {
        if (!open) continue;
        const own = requirements.find(r => r.kind === 'table' && r.tableKey === key);
        const columns = [...own.columns, ...SCHEMA_REQUIREMENTS
          .filter(r => r.kind === 'column' && r.table === own.table && eff.columns[r.gate])
          .flatMap(r => r.columns)];
        assert.ok(server.hasColumns(own.table, columns), `${label}: ${own.table} ${columns}`);
      }
      const taskRow = toRow(normalizeTask({ id: 't', title: 'T' }), taskColumns(gate => eff.columns[gate] === true));
      assert.ok(server.hasColumns('tasks', [...Object.keys(taskRow), 'user_id']), `${label}: tasks`);

      // (4) Arvoportit: 'timer'-lähde ja ylläpitotila vain, kun kanta sallii.
      if (eff.columns.ALIGNMENT_REALITY_FIELDS) assert.ok(state.applied.includes('0013'), label);
      if (eff.columns.GOAL_MAINTENANCE_MODE) assert.ok(state.applied.includes('0010'), label);
    }
  });
}

// =====================================================================
// OIKEA KOODI AALLON PORTEILLA
// =====================================================================

const graphs = new Map();

async function loadWave(wave) {
  if (graphs.has(wave)) return graphs.get(wave);
  const [schema, runtime, probe, client, session, tasksRepo, collections, profileRepo, prefs] = await Promise.all([
    importAtWave(wave, 'data/schema.js'),
    importAtWave(wave, 'data/schemaRuntime.js'),
    importAtWave(wave, 'data/schemaProbe.js'),
    importAtWave(wave, 'data/client.js'),
    importAtWave(wave, 'data/session.js'),
    importAtWave(wave, 'data/tasksRepo.js'),
    importAtWave(wave, 'data/collectionsRepo.js'),
    importAtWave(wave, 'data/profileRepo.js'),
    importAtWave(wave, 'data/notificationPrefsRepo.js')
  ]);
  const graph = { schema, runtime, probe, client, session, tasksRepo, collections, profileRepo, prefs };
  graphs.set(wave, graph);
  return graph;
}

/** Uusi palvelin ja nollattu ajonaikainen tila aallon moduuleille. */
async function start(wave, dbState, { probe = true, online = true } = {}) {
  const g = await loadWave(wave);
  g.runtime.resetSchemaRuntimeForTests();
  g.probe.resetSchemaProbeForTests();
  // Kiinni olevien porttien muistivarastot: jokainen tapaus alkaa tyhjästä.
  g.collections.clearAllCollections();
  const server = createSchemaServer({ ...dbState, currentUserId: () => USER.id });
  g.client.setClient(server);
  g.session.setUser(USER);
  if (probe) {
    await g.probe.ensureSchemaCompatibility({
      client: server, isOnline: () => online, storage: memoryStorage(), host: 'matrix.example'
    });
  }
  return { g, server };
}

graphTest('aaltojen porttiliteraalit vaihtuvat oikein (C-J)', async () => {
  for (const wave of WAVES) {
    const { schema } = await loadWave(wave);
    const expected = compileFor(wave);
    for (const [key, open] of Object.entries(expected.tables)) assert.equal(schema.TABLES[key], open, `${wave} ${key}`);
    for (const [gate, open] of Object.entries(expected.columns)) {
      assert.equal(schema.COMPILE_COLUMN_GATES[gate], open, `${wave} ${gate}`);
    }
  }
});

/**
 * Aallon rivimuunnos kirjoittaa täsmälleen niiden migraatioiden sarakkeet,
 * jotka aalto edellyttää ajetuiksi (migraatio <= aallon migraatio). Aallon
 * J käännöksessä MENTAL_LOAD_FIELDS (0015) on kiinni, joten life_areas.kind
 * ei saa olla rivissä; aallossa L se on.
 */
for (const wave of ['J', 'K', 'L']) {
  graphTest(`manifesti: auki olevan portin rivimuunnos = manifestin sarakkeet (aalto ${wave})`, async () => {
    const last = waveById(wave).migration;
    const { collections } = await loadWave(wave);
    const tableWave = new Map(SCHEMA_REQUIREMENTS.filter(r => r.kind === 'table').map(r => [r.table, r.migration]));
    for (const repo of collections.ALL_REPOSITORIES) {
      // Aallon jälkeen syntyvän taulun repositorio on muistissa (portti kiinni).
      if ((tableWave.get(repo.table) || '0000') > last) continue;
      const keys = Object.keys(repo.mapping.toRow(repo.mapping.normalize(example(repo)))).sort();
      const expected = SCHEMA_REQUIREMENTS.filter(r => r.table === repo.table && r.migration <= last).flatMap(r => r.columns);
      assert.deepEqual(keys, [...new Set(expected)].sort(), `aalto ${wave}: ${repo.table}`);
    }
  });
}

for (const wave of WAVES) {
  graphTest(`KRIITTINEN aalto ${wave}: tehtävät ja tavoitteet tallentuvat jokaisessa kannan tilassa`, async () => {
    for (const [db, state] of Object.entries(DB_STATES)) {
      const label = `aalto ${wave}, kanta ${db}`;
      const { g, server } = await start(wave, state);
      assert.ok(server.calls.every(call => call.op === 'select' && call.limit === 0), `${label}: probe vain lukee`);
      assert.equal(g.runtime.isWritable(), true, label);

      // Tehtävä: luonti, muokkaus, valmis, ehdollinen muutos, poisto.
      const task = normalizeTask({ id: 'mx-task', title: 'Tehtävä', date: '2026-09-26', time: '09:00' });
      for (const [name, run] of [
        ['insert', () => g.tasksRepo.insertTask(task)],
        ['update', () => g.tasksRepo.updateTask({ ...task, title: 'Muokattu' })],
        ['complete', () => g.tasksRepo.setCompleted(task.id, true)],
        ['patch', () => g.tasksRepo.patchTask(task.id, { title: 'Ehdollinen' }, { ...task, title: 'Muokattu', completed: true })],
        ['delete', () => g.tasksRepo.deleteTask(task.id)]
      ]) {
        const result = await run();
        assert.equal(result.ok, true, `${label}: tasks.${name} ${result.error && JSON.stringify(result.error.cause)}`);
      }

      // Tavoite: luonti ja muokkaus.
      const goals = g.collections.goalsRepo;
      const goal = { id: 'mx-goal', title: 'Tavoite', metric: 'kg', targetValue: 70, lifeAreaId: null };
      const inserted = await goals.insert(goal);
      assert.equal(inserted.ok, true, `${label}: goals.insert`);
      assert.equal((await goals.update({ ...goal, title: 'Muokattu' })).ok, true, `${label}: goals.update`);

      // Ylläpitotila: vain kun kanta hyväksyy -- muuten torjunta ennen verkkoa.
      const beforeMaintenance = server.calls.length;
      const maintenance = await goals.update({ ...goal, status: 'maintenance' });
      if (goals.isPersistent() && !g.schema.columnGateOpen('GOAL_MAINTENANCE_MODE')) {
        assert.equal(maintenance.ok, false, label);
        assert.equal(maintenance.error.code, 'validation_error', label);
        assert.equal(server.calls.length, beforeMaintenance, `${label}: ei verkkoon`);
      } else {
        assert.equal(maintenance.ok, true, `${label}: ylläpito`);
      }

      // Jokainen kokoelma: onnistuu tai torjutaan ENNEN verkkoa -- kanta ei hylkää yhtäkään.
      for (const repo of g.collections.ALL_REPOSITORIES) {
        if (repo === goals) continue;
        const before = server.calls.length;
        const result = await repo.insert(example(repo));
        if (result.ok) continue;
        assert.equal(result.error.code, 'persistence_unavailable',
          `${label}: ${repo.table} ${JSON.stringify(result.error.cause || result.error.userMessage)}`);
        assert.equal(server.calls.length, before, `${label}: ${repo.table} torjuttiin vasta verkossa`);
        assert.equal(g.schema.isTableAvailable(repo.schemaKey), false, `${label}: ${repo.table}`);
      }

      // Ajastimen kirjaus: lähde 'timer' vain kun kanta sallii (muuten 'manual').
      if (g.schema.isTableAvailable('timeEntries')) {
        const entry = { ...example(g.collections.timeEntriesRepo, '-timer'), source: 'timer' };
        assert.equal((await g.collections.timeEntriesRepo.insert(entry)).ok, true, `${label}: timer-lähde`);
      }

      assert.equal((await g.profileRepo.saveProfile({ age: 30 })).ok, true, `${label}: profile`);
      assert.equal((await g.prefs.savePreferences({ enabled: true })).ok, true, `${label}: asetukset`);

      // Yksikään kirjoitus ei sisältänyt saraketta, jota kannassa ei ole.
      for (const call of server.writes()) {
        if (!call.payloadKeys) continue;
        assert.ok(server.hasColumns(call.table, call.payloadKeys), `${label}: ${call.table} ${call.payloadKeys}`);
      }
    }
  });
}

graphTest('aalto J vs kanta 0008: rajoitettu tila, ei huoltoa, ja tekniset tiedot ovat migraatiotunnisteita', async () => {
  const { g } = await start('J', DB_STATES['0008']);
  const snapshot = g.runtime.schemaSnapshot();
  assert.equal(snapshot.status, SCHEMA_STATUS.DEGRADED);
  assert.deepEqual([...snapshot.pendingMigrations], ['0009', '0010', '0011', '0012', '0013']);
  assert.ok(snapshot.pendingMigrations.every(id => /^\d{4}$/.test(id)));
  // Olemassa oleva data säilyy näkyvissä: kannassa olevat taulut luetaan.
  assert.equal((await g.collections.goalsRepo.list()).ok, true);
  // Puuttuva taulu: tyhjä ja kelvollinen, ei latausvirhe.
  const missing = await g.collections.timeEntriesRepo.list();
  assert.deepEqual([missing.ok, missing.value], [true, []]);
});

graphTest('aalto J: offline-käynnistys ei tee pyyntöjä ja käyttää käännösaikaisia portteja', async () => {
  const { g, server } = await start('J', DB_STATES['0008'], { online: false });
  assert.equal(server.calls.length, 0);
  assert.equal(g.runtime.schemaSnapshot().status, SCHEMA_STATUS.UNVERIFIED);
  assert.equal(g.schema.columnGateOpen('GOAL_PLANNING_FIELDS'), true);
});

for (const failMode of ['503', 'jwt', 'offline', 'hang']) {
  graphTest(`aalto J: "ei tiedetä" (${failMode}) ei laske mitään`, async () => {
    const { g, server } = await start('J', { ...DB_STATES['0008'], failMode }, { probe: false });
    const started = Date.now();
    await g.probe.ensureSchemaCompatibility({
      client: server, isOnline: () => true, storage: memoryStorage(), timeoutMs: 100
    });
    // Yläraja vain varmistaa, ettei tarkistus jää odottamaan; rinnakkaisajossa
    // ajastimet voivat myöhästyä (tarkka aikaraja: tests/schema-probe.test.mjs).
    assert.ok(Date.now() - started < 100 + 2000);
    assert.equal(g.runtime.schemaSnapshot().status, SCHEMA_STATUS.UNVERIFIED);
    for (const gate of Object.keys(g.schema.COMPILE_COLUMN_GATES)) {
      assert.equal(g.schema.columnGateOpen(gate), g.schema.COMPILE_COLUMN_GATES[gate], gate);
    }
    assert.equal(g.runtime.isWritable(), true);
  });
}

graphTest('KRIITTINEN aalto J: reaktiivinen PGRST204 laskee portin ja seuraava kirjoitus onnistuu', async () => {
  // Tarkistus ohitettu (esim. PostgRESTin vanhentunut välimuisti hyväksyi
  // GETin): ensimmäinen kirjoitus kaatuu, portti laskee, seuraava onnistuu.
  const { g, server } = await start('J', DB_STATES['0008'], { probe: false });
  const task = normalizeTask({ id: 'rx-1', title: 'Tehtävä', date: '2026-09-26' });
  const first = await g.tasksRepo.insertTask(task);
  assert.equal(first.ok, false);
  assert.equal(first.error.cause.code, 'PGRST204');
  assert.equal(g.schema.columnGateOpen('GOAL_PLANNING_FIELDS'), false, 'suunnittelukentät laskettiin');
  const second = await g.tasksRepo.insertTask({ ...task, id: 'rx-2' });
  assert.equal(second.ok, true);
  const payload = server.writes().at(-1).payloadKeys;
  assert.equal(payload.includes('milestone_id') || payload.includes('depends_on'), false);
  assert.ok(payload.includes('goal_id'), 'liitokset (0004) lähtevät yhä');

  // Tavoite: ensin elämänalue (0012) puuttuu -> laskee; sitten onnistuu.
  let result = await g.collections.goalsRepo.insert({ id: 'rx-goal', title: 'T' });
  for (let attempt = 0; !result.ok && attempt < 3; attempt += 1) {
    assert.equal(result.error.cause.code, 'PGRST204');
    result = await g.collections.goalsRepo.insert({ id: 'rx-goal', title: 'T' });
  }
  assert.equal(result.ok, true);
  assert.equal(g.schema.columnGateOpen('GOAL_LIFE_AREA_FIELD'), false);

  // Puuttuva taulu: PGRST205 laskee taulun, seuraava torjutaan ennen verkkoa.
  const entries = g.collections.timeEntriesRepo;
  const missing = await entries.insert(example(entries));
  assert.equal(missing.error.cause.code, 'PGRST205');
  const before = server.calls.length;
  const refused = await entries.insert(example(entries, '-2'));
  assert.equal(refused.error.code, 'persistence_unavailable');
  assert.equal(server.calls.length, before);
});

graphTest('KRIITTINEN aalto J: offline-jonon skeemavirhe pysäyttää, ei hylkää; seuraava toisto onnistuu', async () => {
  const { g, server } = await start('J', DB_STATES['0008'], { probe: false });
  const saved = new Map();
  let reprobes = 0;
  const sync = createOfflineSync({
    repo: g.tasksRepo,
    store: { load: id => saved.get(id) || null, save: (id, text) => { saved.set(id, text); return { ok: true, persistent: true }; }, purge: id => saved.delete(id) },
    session: { userId: () => USER.id, snapshot: () => ({}), isSame: () => true },
    now: () => 1000, isOnline: () => true, newId: (() => { let n = 0; return () => 'op' + (++n); })(),
    canSync: g.runtime.isWritable, onSchemaError: () => { reprobes += 1; }
  });
  sync.activate(USER.id);
  assert.equal(sync.enqueueTaskCreate(normalizeTask({ id: 'q-1', title: 'Jonossa', date: '2026-09-26', milestoneId: 'm1' })).ok, true);

  const first = await sync.replay();
  assert.equal(first.reason, 'schema');
  assert.equal(first.failed, 0, 'ei merkitty epäonnistuneeksi');
  assert.equal(reprobes, 1);
  assert.deepEqual([sync.status().pending, sync.status().failed], [1, 0]);

  const second = await sync.replay();
  assert.equal(second.synced, 1);
  const insert = server.writes().filter(call => call.op === 'insert').at(-1);
  assert.equal(insert.payloadKeys.includes('milestone_id'), false);
});

graphTest('KRIITTINEN aalto J: jonottu välitavoitemuutos ei katoa, kun kanta ei tue sitä (portti laskettu)', async () => {
  // Kanta 0001-0009: tasks.milestone_id puuttuu -> GOAL_PLANNING_FIELDS lasketaan.
  const { g, server } = await start('J', DB_STATES['+0009']);
  assert.equal(g.schema.columnGateOpen('GOAL_PLANNING_FIELDS'), false, 'lähtötilanne: portti laskettu');
  const task = normalizeTask({ id: 'pq-1', title: 'Tehtävä', date: '2026-09-26' });
  assert.equal((await g.tasksRepo.insertTask(task)).ok, true);

  const saved = new Map();
  let clock = 1_000;
  const sync = createOfflineSync({
    repo: g.tasksRepo,
    store: { load: id => saved.get(id) || null, save: (id, text) => { saved.set(id, text); return { ok: true, persistent: true }; }, purge: id => saved.delete(id) },
    session: { userId: () => USER.id, snapshot: () => ({}), isSame: () => true },
    now: () => clock, isOnline: () => true, newId: (() => { let n = 0; return () => 'pq-op' + (++n); })(),
    canSync: g.runtime.isWritable
  });
  sync.activate(USER.id);
  assert.equal(sync.enqueueTaskUpdate({ id: task.id, previous: task, updated: { ...task, milestoneId: 'm2' } }).ok, true);

  // Pelkkä välitavoite: mitään ei voi kirjoittaa, eikä muutosta raportoida onnistuneeksi.
  const writesBefore = server.writes().length;
  const first = await sync.replay();
  assert.deepEqual([first.synced, first.failed], [0, 0]);
  assert.equal(sync.status().pending, 1, 'jonottu muutos katosi hiljaa (tyhjä erotus = "onnistui")');
  const [op] = sync.list();
  assert.equal(op.lastErrorCode, SCHEMA_PENDING_CODE);
  assert.equal(server.writes().length, writesBefore, 'tyhjää muutosta ei lähetetä');
  assert.match(describeSyncLine(sync.status(), sync.list(), { online: true }).text, new RegExp(SCHEMA_PENDING_NOTE));

  // Odottava osa ei jumita jonoa eikä toistu heti uudelleen.
  const callsBefore = server.calls.length;
  await sync.replay();
  assert.equal(server.calls.length, callsBefore, 'odottava osa haettiin heti uudelleen');

  // Uusi muokkaus samaan tehtävään: kirjoitettava kenttä lähtee, välitavoite odottaa yhä.
  const shown = { ...task, milestoneId: 'm2' };
  assert.equal(sync.enqueueTaskUpdate({ id: task.id, previous: shown, updated: { ...shown, title: 'Uusi otsikko', milestoneId: 'm3' } }).ok, true);
  const second = await sync.replay();
  assert.equal(second.synced, 1);
  assert.equal(server.rows('tasks').find(row => row.id === task.id).title, 'Uusi otsikko');
  assert.equal(sync.status().pending, 1);
  assert.deepEqual(Object.keys(JSON.parse(saved.get(USER.id)).ops[0].payload), ['milestoneId']);

  // Kanta päivitetään (0010): uusi tarkistus nostaa portin, ja odottanut osa tallentuu.
  const fixed = createSchemaServer({ ...DB_STATES['+0010'], currentUserId: () => USER.id });
  fixed.rows('tasks').push({ ...server.rows('tasks').find(row => row.id === task.id) });
  g.client.setClient(fixed);
  await g.probe.ensureSchemaCompatibility({ client: fixed, isOnline: () => true, storage: memoryStorage(), force: true });
  assert.equal(g.schema.columnGateOpen('GOAL_PLANNING_FIELDS'), true);
  clock += 60_000;
  const third = await sync.replay();
  assert.equal(third.synced, 1);
  assert.equal(sync.status().total, 0);
  const row = fixed.rows('tasks').find(r => r.id === task.id);
  assert.deepEqual([row.milestone_id, row.title], ['m3', 'Uusi otsikko']);
});

/** Offline-jono aallon repositoriolle, muistitallennuksella ja säädettävällä kellolla. */
function queueFor(g, saved, clock, prefix) {
  return createOfflineSync({
    repo: g.tasksRepo,
    store: { load: id => saved.get(id) || null, save: (id, text) => { saved.set(id, text); return { ok: true, persistent: true }; }, purge: id => saved.delete(id) },
    session: { userId: () => USER.id, snapshot: () => ({}), isSame: () => true },
    now: () => clock.now, isOnline: () => true, newId: (() => { let n = 0; return () => prefix + (++n); })(),
    canSync: g.runtime.isWritable
  });
}

graphTest('KRIITTINEN aalto J: jonottu lisäys + yhdistetty välitavoite: rivi syntyy, välitavoite odottaa ja tallentuu portin palattua', async () => {
  // Kanta 0001-0009: tasks.milestone_id puuttuu -> GOAL_PLANNING_FIELDS lasketaan.
  const { g, server } = await start('J', DB_STATES['+0009']);
  assert.equal(g.schema.columnGateOpen('GOAL_PLANNING_FIELDS'), false, 'lähtötilanne: portti laskettu');
  const saved = new Map();
  const clock = { now: 1_000 };
  const sync = queueFor(g, saved, clock, 'cq-op');
  sync.activate(USER.id);

  const task = normalizeTask({ id: 'cq-1', title: 'Offline-tehtävä', date: '2026-09-26' });
  assert.equal(sync.enqueueTaskCreate(task).ok, true);
  const merged = sync.enqueueTaskUpdate({ id: task.id, previous: task, updated: { ...task, milestoneId: 'm2' } });
  assert.deepEqual([merged.ok, merged.coalesced], [true, true], 'lähtötilanne: muokkaus yhdistyi lisäykseen');

  // Rivi syntyy ilman välitavoitetta, eikä välitavoitetta raportoida tallentuneeksi.
  const first = await sync.replay();
  assert.deepEqual([first.synced, first.failed, first.conflicts], [1, 0, 0]);
  const insert = server.writes().filter(call => call.op === 'insert' && call.table === 'tasks').at(-1);
  assert.equal(insert.payloadKeys.includes('milestone_id'), false);
  assert.ok(server.rows('tasks').some(row => row.id === task.id), 'rivi ei syntynyt');
  assert.equal(sync.status().pending, 1, 'välitavoite katosi hiljaa (lisäys merkittiin onnistuneeksi)');
  const [op] = sync.list();
  assert.deepEqual([op.operation, op.lastErrorCode], ['tasks.update', SCHEMA_PENDING_CODE]);
  const stored = JSON.parse(saved.get(USER.id)).ops[0];
  assert.deepEqual([stored.payload, stored.baseValues], [{ milestoneId: 'm2' }, { milestoneId: null }],
    'odottaa vain pois jäänyt kenttä, perusarvona kannan oletus');

  // Uusi muokkaus samaan kenttään yhdistyy odottavaan (ei väärää konfliktia myöhemmin).
  const shown = { ...task, milestoneId: 'm2' };
  assert.equal(sync.enqueueTaskUpdate({ id: task.id, previous: shown, updated: { ...shown, milestoneId: 'm3' } }).ok, true);
  assert.equal(sync.status().total, 1);

  // Kanta päivitetään (0010): uusi tarkistus nostaa portin, ja välitavoite tallentuu.
  const fixed = createSchemaServer({ ...DB_STATES['+0010'], currentUserId: () => USER.id });
  fixed.rows('tasks').push({ ...server.rows('tasks').find(row => row.id === task.id) });
  g.client.setClient(fixed);
  await g.probe.ensureSchemaCompatibility({ client: fixed, isOnline: () => true, storage: memoryStorage(), force: true });
  assert.equal(g.schema.columnGateOpen('GOAL_PLANNING_FIELDS'), true);
  clock.now += 60_000;
  const second = await sync.replay();
  assert.deepEqual([second.synced, second.conflicts, second.failed], [1, 0, 0]);
  assert.equal(sync.status().total, 0);
  const row = fixed.rows('tasks').find(r => r.id === task.id);
  assert.deepEqual([row.milestone_id, row.title], ['m3', 'Offline-tehtävä']);
});

graphTest('KRIITTINEN aalto J: sarakeportin nousu herättää odottavan kentän, ja se tallentuu heti palautuksessa', async () => {
  // Kaikki taulut ovat kannassa, vain tehtävien suunnittelusarakkeet
  // puuttuvat: nousu koskee PELKKÄÄ sarakeporttia (ei yhtään taulua).
  const { g, server } = await start('J', { ...DB_STATES['+0013'], drop: { tasks: ['milestone_id', 'depends_on'] } });
  assert.equal(g.schema.columnGateOpen('GOAL_PLANNING_FIELDS'), false, 'lähtötilanne: portti laskettu');
  // Vain aallossa J auki olevat taulut: myöhemmän aallon (K) taulut ovat
  // käännösaikaisesti kiinni eivätkä ole "laskettuja".
  assert.deepEqual(Object.keys(g.schema.TABLES)
    .filter(key => g.schema.TABLES[key] === true && !g.schema.isTableAvailable(key)), [],
    'lähtötilanne: yksikään taulu ei ole laskettu');
  const task = normalizeTask({ id: 'wk-1', title: 'Tehtävä', date: '2026-09-26' });
  assert.equal((await g.tasksRepo.insertTask(task)).ok, true);
  const saved = new Map();
  const clock = { now: 1_000 };
  const sync = queueFor(g, saved, clock, 'wk-op');
  sync.activate(USER.id);
  assert.equal(sync.enqueueTaskUpdate({ id: task.id, previous: task, updated: { ...task, milestoneId: 'm2' } }).ok, true);
  await sync.replay();
  assert.equal(sync.list()[0].lastErrorCode, SCHEMA_PENDING_CODE, 'lähtötilanne: välitavoite odottaa');

  // Sovelluksen palautus kuten main.js: herätä odottavat, sitten toisto.
  const status = await importAtWave('J', 'app/schemaStatus.js');
  let recoveries = 0;
  let recovery = null;
  status.initSchemaStatus({
    onRecovered: () => { recoveries += 1; sync.wakeSchemaPending(); recovery = sync.replay(); }
  });
  status.setSchemaStatusActive(true);
  const changes = [];
  g.runtime.subscribeSchemaStatus((_snapshot, change) => { changes.push(change); });
  try {
    // Sarakkeet lisätään. Kello etenee vain sekunnin, ei odotusaikaa.
    const fixed = createSchemaServer({ ...DB_STATES['+0013'], currentUserId: () => USER.id });
    fixed.rows('tasks').push({ ...server.rows('tasks').find(row => row.id === task.id) });
    g.client.setClient(fixed);
    clock.now += 1_000;
    await g.probe.ensureSchemaCompatibility({ client: fixed, isOnline: () => true, storage: memoryStorage(), force: true });
    assert.equal(g.schema.columnGateOpen('GOAL_PLANNING_FIELDS'), true);
    assert.deepEqual(changes.map(change => [[...change.raisedTables], [...(change.raisedColumnGates || [])]]),
      [[[], ['GOAL_PLANNING_FIELDS']]], 'muutos kertoo nousseen sarakeportin');
    assert.equal(recoveries, 1, 'sarakeportin nousu ei käynnistänyt palautusta');
    const result = await recovery;
    assert.equal(result.synced, 1, 'odottava kenttä ei lähtenyt palautuksessa (odotusaika kesken)');
    assert.equal(sync.status().total, 0);
    assert.equal(fixed.rows('tasks').find(row => row.id === task.id).milestone_id, 'm2');
  } finally {
    status.setSchemaStatusActive(false);
  }
});

test('main.js: skeeman palautus herättää odottavat osat ennen toistoa', () => {
  const source = read('src/app/main.js');
  const start = source.indexOf('initSchemaStatus({');
  const block = source.slice(start, source.indexOf('});', start));
  const wake = block.indexOf('offline.wakeSchemaPending()');
  // Päivityksellä on syy (CRIT-02): reconnect.refreshNow({ reason: … }).
  assert.ok(wake > -1 && block.indexOf('reconnect.refreshNow(') > wake, block);
});

test('unwritableInsert: lisäyksen pois jäävät kentät ja tehtävä sellaisena kuin kanta sen tallentaa', () => {
  const task = normalizeTask({ id: 'u2', title: 'T', date: '2026-09-26', description: 'Kuvaus' });
  const lowered = unwritableInsert(task, TASK_COLUMNS_CORE);
  assert.deepEqual(lowered.fields, COMPILE_COLUMN_GATES.TASK_EXTENDED_FIELDS ? ['description'] : []);
  assert.equal(lowered.stored.description, null);
  assert.equal(lowered.stored.title, 'T');
  assert.deepEqual(unwritableInsert(task).fields, [], 'mitään ei laskettu: kaikki tallentuu');
  // Käännösaikaisesti kiinni oleva portti ei ole "odottava".
  const planned = unwritableInsert({ ...task, milestoneId: 'm1' }, TASK_COLUMNS_CORE).fields;
  assert.equal(planned.includes('milestoneId'), COMPILE_COLUMN_GATES.GOAL_PLANNING_FIELDS);
});

test('unwritableTaskFields: vain ajon aikana lasketun portin kentät odottavat', () => {
  const base = normalizeTask({ id: 'u1', title: 'T', date: '2026-09-26', time: '09:00' });
  // Laajennetut sarakkeet laskettu: kuvaus odottaa; loppuaika menee (end_time),
  // vaikka se muuttaa myös johdettua kestoa.
  const core = TASK_COLUMNS_CORE;
  const fields = unwritableTaskFields({ description: 'Kuvaus', endTime: '10:00', title: 'Uusi' }, base, core);
  assert.deepEqual(fields, COMPILE_COLUMN_GATES.TASK_EXTENDED_FIELDS ? ['description'] : []);
  // Käännösaikaisesti kiinni oleva portti ei ole "odottava" (tieto elää istunnon muistissa).
  const planning = unwritableTaskFields({ milestoneId: 'm1' }, base, core);
  assert.deepEqual(planning, COMPILE_COLUMN_GATES.GOAL_PLANNING_FIELDS ? ['milestoneId'] : []);
  assert.deepEqual(unwritableTaskFields({ title: 'Uusi' }, base), []);
});

graphTest('KRIITTINEN aalto J: aikakirjaukset ilman 0013:a -> vain luku; lähtökori säilyy ja lähtee kun kanta on valmis', async () => {
  const { g, server } = await start('J', DB_STATES['+0012']);
  assert.equal(g.schema.isTableAvailable('timeEntries'), false, 'operation_id puuttuu -> vain luku');
  assert.equal((await g.collections.timeEntriesRepo.list()).ok, true, 'lukeminen toimii');

  let outbox = [{ id: 'e1', entryDate: '2026-09-21', minutes: 45, operationId: 'timer:e1', source: 'timer' }];
  const writer = createTimeEntryWriter({
    repo: g.collections.timeEntriesRepo, userId: () => USER.id,
    loadOutbox: () => outbox.slice(), saveOutbox: (_id, list) => { outbox = list; return { ok: true }; }
  });
  const before = server.writes().length;
  const kept = await writer.flush();
  assert.deepEqual([kept.sent, kept.left, kept.rejected.length], [0, 1, 0]);
  assert.equal(outbox.length, 1);
  assert.equal(server.writes().length, before, 'ei kirjoitusyritystä');

  // Suora kirjaus: jonoon, ei virhettä eikä katoamista.
  const direct = await writer.insert({ id: 'e2', entryDate: '2026-09-21', minutes: 10, operationId: 'log:e2' });
  assert.deepEqual([direct.ok, direct.queued], [true, true]);

  // Kanta päivitetään (0013): uusi tarkistus nostaa portin, kori tyhjenee.
  const fixed = createSchemaServer({ ...DB_STATES['+0013'], currentUserId: () => USER.id });
  g.client.setClient(fixed);
  await g.probe.ensureSchemaCompatibility({ client: fixed, isOnline: () => true, storage: memoryStorage(), force: true });
  assert.equal(g.schema.isTableAvailable('timeEntries'), true);
  const sent = await writer.flush();
  assert.equal(sent.sent, 2);
  assert.equal(outbox.length, 0);
  assert.deepEqual(fixed.rows('time_entries').map(row => row.source).sort(), ['manual', 'timer']);
});

graphTest('KRIITTINEN aalto J: ydin puuttuu -> huoltotila, nolla kirjoitusta, jono ja kori ennallaan', async () => {
  const { g, server } = await start('J', { ...DB_STATES['+0013'], drop: { tasks: ['is_wake'] } });
  assert.equal(g.runtime.schemaSnapshot().status, SCHEMA_STATUS.MAINTENANCE);
  const probeCalls = server.calls.length;
  const task = normalizeTask({ id: 'mt-1', title: 'X', date: '2026-09-26' });
  const results = [
    await g.tasksRepo.insertTask(task), await g.tasksRepo.updateTask(task),
    await g.tasksRepo.setCompleted(task.id, true), await g.tasksRepo.deleteTask(task.id),
    await g.profileRepo.saveProfile({ age: 1 }), await g.prefs.savePreferences({ enabled: true })
  ];
  // Kannan repositoriot (aallossa J auki). Myöhemmän aallon (K) portti on
  // kiinni, joten sen repositorio kirjoittaa istunnon muistiin eikä kantaan.
  for (const repo of g.collections.ALL_REPOSITORIES.filter(r => r.isPersistent())) {
    results.push(await repo.insert(example(repo)), await repo.update(example(repo)), await repo.remove('x'));
  }
  assert.ok(results.every(result => !result.ok && result.error.code === 'persistence_unavailable'));
  assert.equal(server.calls.length, probeCalls, 'yksikään kirjoitus ei lähtenyt');
});
