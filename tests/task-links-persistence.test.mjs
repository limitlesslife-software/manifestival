// Tehtävän määräaika ja liitokset tavoitteeseen ja projektiin (migraatio 0004).
//
// VIKA: sarakkeet tasks.deadline, goal_id ja project_id ovat olleet
// tuotannossa aallosta B asti, mutta sovellus ei kirjoittanut eikä lukenut
// niitä. Lomakkeen tavoite ja määräaika, Suunnan "Liitä tavoitteeseen" ja
// tehtävä -> tavoite -kohdistus katosivat uudelleenlatauksessa, ja vienti
// sisälsi niiden kohdalla null.
//
// Tuotehaaralla goals/projects-portit ovat kiinni, joten liitoksia ei
// lähetetä (ennen 0004:ää ne kaatuisivat koodilla 42703). Auki olevan
// portin polku ajetaan aallon B porteilla (tests/helpers/waveGraph.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  toRow, fromRow, TASK_COLUMNS_LINKS, TASK_COLUMNS_EXTENDED, TASK_COLUMNS_PLANNING
} from '../src/lib/rows.js';
import { taskColumns, hasTable } from '../src/data/schema.js';
import { partialPayloadFor } from '../src/data/tasksRepo.js';
import { normalizeTask } from '../src/domain/task.js';
import { QUEUE_TASK_FIELDS, OP_STATUS, classifyError, ERROR_CLASS } from '../src/domain/offlineQueue.js';
import { createOfflineSync } from '../src/app/offlineSync.js';
import { buildAttributionIndex, areaForTask, ATTRIBUTION } from '../src/domain/alignment.js';
import { createSchemaServer, migrationsThrough } from './helpers/schemaServer.mjs';
import { importAtWave, WAVE_GRAPH_SUPPORTED } from './helpers/waveGraph.mjs';

const USER = { id: 'cccccccc-4444-4444-8444-000000000001', email: 'l@example.com' };
const graphTest = WAVE_GRAPH_SUPPORTED ? test : test.skip;

const LINKED = {
  id: 't1', date: '2026-09-26', time: '09:00', title: 'Juokse', category: 'hyvinvointi',
  deadline: '2026-10-01', goalId: 'g1', projectId: 'p1'
};

// ---------------------------------------------------------- rivimuunnos

test('liitossarakkeet ovat määräaika, tavoite ja projekti', () => {
  assert.deepEqual([...TASK_COLUMNS_LINKS], ['deadline', 'goal_id', 'project_id']);
});

test('toRow kirjoittaa liitokset, kun sarakejoukko sisältää ne', () => {
  const row = toRow(normalizeTask(LINKED), [...TASK_COLUMNS_EXTENDED, ...TASK_COLUMNS_LINKS]);
  assert.equal(row.deadline, '2026-10-01');
  assert.equal(row.goal_id, 'g1');
  assert.equal(row.project_id, 'p1');
  // Tyhjä liitos lähtee nullina (nullable, ei oletusarvoa), ei undefinedina.
  const empty = toRow(normalizeTask({ id: 't2', title: 'X' }), TASK_COLUMNS_LINKS);
  assert.deepEqual(empty, { deadline: null, goal_id: null, project_id: null });
});

test('KRIITTINEN: uudelleenlataus (toRow -> fromRow -> normalizeTask) säilyttää liitokset', () => {
  const stored = { ...toRow(normalizeTask(LINKED), [...TASK_COLUMNS_PLANNING, ...TASK_COLUMNS_LINKS]), user_id: 'u' };
  const reloaded = normalizeTask(fromRow(stored));
  assert.equal(reloaded.goalId, 'g1');
  assert.equal(reloaded.projectId, 'p1');
  assert.equal(reloaded.deadline, '2026-10-01');
  // Ennen 0004:ää sarakkeita ei ole: arvot ovat normalizeTaskin oletukset.
  const legacy = normalizeTask(fromRow({ id: 'x', date: '2026-09-26', title: 'X', completed: false, is_wake: false }));
  assert.deepEqual([legacy.goalId, legacy.projectId, legacy.deadline], [null, null, null]);
});

test('uudelleenlatauksen jälkeen Suunta kohdistaa tehtävän tavoitteen alueeseen', () => {
  const reloaded = normalizeTask(fromRow(toRow(normalizeTask({ ...LINKED, category: 'muu' }),
    [...TASK_COLUMNS_EXTENDED, ...TASK_COLUMNS_LINKS])));
  const index = buildAttributionIndex({
    areas: [{ id: 'a-ystavat', name: 'Ystävät' }],
    goals: [{ id: 'g1', title: 'Ystävyys', lifeAreaId: 'a-ystavat' }]
  });
  assert.deepEqual(areaForTask(reloaded, index), { areaId: 'a-ystavat', via: ATTRIBUTION.GOAL });
});

test('SKEEMAPORTTI: liitokset lähtevät vain kun goals- ja projects-taulut ovat käytössä', () => {
  const open = hasTable('goals') && hasTable('projects');
  const columns = taskColumns();
  for (const column of TASK_COLUMNS_LINKS) {
    assert.equal(columns.includes(column), open, `${column}: portti ${open ? 'auki' : 'kiinni'}`);
  }
  // Synteettisellä lukijalla: liitosportti auki -> mukana, kiinni -> ei.
  assert.ok(taskColumns(gate => gate !== 'GOAL_PLANNING_FIELDS').includes('goal_id'));
  assert.equal(taskColumns(gate => gate !== 'TASK_LINK_FIELDS').includes('goal_id'), false);
});

test('ehdollinen kirjoitus: vain muuttunut liitos on erotuksessa ja ehtona', () => {
  const columns = [...TASK_COLUMNS_EXTENDED, ...TASK_COLUMNS_LINKS];
  const current = normalizeTask({ ...LINKED, goalId: null });
  const { diff, guards } = partialPayloadFor({ ...current, goalId: 'g1' }, current, columns);
  assert.deepEqual(diff, { goal_id: 'g1' });
  assert.deepEqual(guards, { goal_id: null });
  const untouched = partialPayloadFor({ ...current, title: 'Uusi' }, current, columns);
  assert.equal('goal_id' in untouched.diff, false);
});

test('offline-jono kantaa liitokset (kenttälista johdetaan normalizeTaskista)', () => {
  for (const field of ['goalId', 'projectId', 'deadline']) assert.ok(QUEUE_TASK_FIELDS.includes(field), field);
  const saved = new Map();
  const sync = createOfflineSync({
    repo: {}, store: { load: () => null, save: (id, text) => { saved.set(id, text); return { ok: true, persistent: true }; }, purge: () => {} },
    session: { userId: () => USER.id, snapshot: () => ({}), isSame: () => true },
    now: () => 1, isOnline: () => false, newId: () => 'op1'
  });
  sync.activate(USER.id);
  const previous = normalizeTask({ ...LINKED, goalId: null });
  assert.equal(sync.enqueueTaskUpdate({ id: 't1', previous, updated: { ...previous, goalId: 'g1' } }).ok, true);
  const op = JSON.parse(saved.get(USER.id)).ops[0];
  assert.deepEqual(op.payload, { goalId: 'g1' });
  assert.deepEqual(op.baseValues, { goalId: null });
});

test('KRIITTINEN: poistettu tavoite toistossa (23503) hylätään näkyvästi, ei uusita loputtomiin', async () => {
  assert.equal(classifyError({ cause: { code: '23503' } }), ERROR_CLASS.REJECTED);
  let inserts = 0;
  const sync = createOfflineSync({
    repo: {
      insertTask: async () => {
        inserts += 1;
        return { ok: false, error: { cause: { code: '23503', message: 'violates foreign key constraint "tasks_goal_id_fkey"' } } };
      }
    },
    store: { load: () => null, save: () => ({ ok: true, persistent: true }), purge: () => {} },
    session: { userId: () => USER.id, snapshot: () => ({}), isSame: () => true },
    now: () => 1, isOnline: () => true, newId: () => 'op1'
  });
  sync.activate(USER.id);
  sync.enqueueTaskCreate(normalizeTask({ ...LINKED }));
  const run = await sync.replay();
  assert.equal(run.failed, 1);
  const [item] = sync.list();
  assert.equal(item.status, OP_STATUS.FAILED, 'näkyy käyttäjälle, ei katoa');
  assert.equal(item.retryCount, 0, 'ei kulutettu uusintoja');
  assert.equal(inserts, 1);
  assert.equal((await sync.replay()).synced, 0, 'epäonnistunutta ei ajeta automaattisesti uudelleen');
  assert.equal(inserts, 1);
});

// ---------------------------------------------- aallon B oikea koodi

async function waveB() {
  const [actions, state, session, client, tasksRepo] = await Promise.all([
    importAtWave('B', 'app/actions.js'),
    importAtWave('B', 'app/state.js'),
    importAtWave('B', 'data/session.js'),
    importAtWave('B', 'data/client.js'),
    importAtWave('B', 'data/tasksRepo.js')
  ]);
  state.resetState();
  const server = createSchemaServer({ applied: migrationsThrough('0004'), currentUserId: () => USER.id });
  client.setClient(server);
  session.setUser(USER);
  state.setGoals([{ id: 'g1', title: 'Ystävyys' }]);
  state.setProjects([{ id: 'p1', name: 'Kesäjuhla', goalId: 'g1' }]);
  return { actions, state, server, tasksRepo };
}

graphTest('KRIITTINEN aalto B: editTask(goalId) lähettää goal_id:n, ja lataus palauttaa sen', async () => {
  const { actions, state, server, tasksRepo } = await waveB();
  const created = await actions.createTask({ title: 'Soita Mikolle', date: '2026-09-26' });
  assert.equal(created.ok, true);
  const edited = await actions.editTask(created.task.id, { goalId: 'g1', projectId: 'p1', deadline: '2026-10-02' });
  assert.equal(edited.ok, true);
  const update = server.writes().find(call => call.op === 'update');
  assert.ok(['goal_id', 'project_id', 'deadline'].every(column => update.payloadKeys.includes(column)));

  // Uudelleenlataus: kanta palauttaa liitokset.
  const listed = await tasksRepo.listTasks();
  const reloaded = listed.value.find(task => task.id === created.task.id);
  assert.deepEqual([reloaded.goalId, reloaded.projectId, reloaded.deadline], ['g1', 'p1', '2026-10-02']);
  assert.equal(state.getState().tasks.find(task => task.id === created.task.id).goalId, 'g1');
});

graphTest('aalto B: tuntematon tavoite tai projekti pudotetaan ennen kirjoitusta (ei 23503:a)', async () => {
  const { actions, server } = await waveB();
  const created = await actions.createTask({ title: 'Tekoälyn tehtävä', date: '2026-09-26', goalId: 'toisen-kayttajan', projectId: 'olematon' });
  assert.equal(created.ok, true);
  assert.deepEqual([created.task.goalId, created.task.projectId], [null, null]);
  const row = server.rows('tasks').find(r => r.id === created.task.id);
  assert.deepEqual([row.goal_id, row.project_id], [null, null]);

  const own = await actions.createTask({ title: 'Oma', date: '2026-09-26', goalId: 'g1' });
  assert.equal(server.rows('tasks').find(r => r.id === own.task.id).goal_id, 'g1');
});

graphTest('aalto B: ennallaan pysyvä liitos säilyy, vaikka tavoitteet eivät olisi latautuneet', async () => {
  const { actions, state, server } = await waveB();
  const created = await actions.createTask({ title: 'Liitetty', date: '2026-09-26', goalId: 'g1' });
  state.setGoals([]); // tavoitteiden lataus epäonnistui tai kesken
  const edited = await actions.editTask(created.task.id, { title: 'Uusi otsikko' });
  assert.equal(edited.ok, true);
  assert.equal(server.rows('tasks').find(r => r.id === created.task.id).goal_id, 'g1');
});
