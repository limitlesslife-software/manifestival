// Epäonnistunut tavoitteen poisto palauttaa tavoitteen JA sen liitokset.
//
// TAUSTA. removeGoalFromState() katkaisee tavoiteliitoksen tehtäviltä,
// aikakirjauksilta, menoilta ja liikuntakerroilta (kannan on delete set
// null). Kun kannan poisto epäonnistui (verkko, aikakatkaisu, RLS,
// huoltotila), deleteGoal palautti vain tavoitteen: kaikki liitetyt näkyivät
// irrallisina, vaikka kanta piti liitokset. Seuraava muokkaus lähetti koko
// rivin (saveCalendarEvent yhdistää `previous`-rivin, lomake ei kanna
// goalId:tä) ja goal_id = null pyyhki liitoksen kannasta pysyvästi.
//
// Peruutuksessa ei myöskään tarkistettu istuntoa: A:n tavoite ilmestyi
// B:n tilaan, jos tili vaihtui poiston odottaessa.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { setUser, clearUser } from '../src/data/session.js';
import {
  resetState, getState, setGoals, setTasks, setTimeEntries, setCalendarEvents, setExerciseSessions
} from '../src/app/state.js';
import { deleteGoal } from '../src/app/actions.js';
import { goalsRepo, calendarEventsRepo, exerciseSessionsRepo, clearAllCollections } from '../src/data/collectionsRepo.js';
import { saveCalendarEvent, saveExerciseSession, resetDailyLifeActions } from '../src/app/dailyLifeActions.js';
import { resetTestStore, storedRow } from './helpers/gateAwareStore.mjs';

const USER_A = { id: 'aaaaaaaa-4444-0000-0000-00000000000a', email: 'a@example.com' };
const USER_B = { id: 'bbbbbbbb-4444-0000-0000-00000000000b', email: 'b@example.com' };
const yes = async () => true;
const GOAL = { id: 'g1', title: 'Juoksukoulu' };

beforeEach(async () => {
  clearUser();
  clearAllCollections();
  // Portin ollessa auki siemen ja tallennus menevät kantaa jäljittelevälle palvelimelle.
  resetTestStore();
  resetState();
  resetDailyLifeActions();
  setUser(USER_A);
  await goalsRepo.insert(GOAL);
  const event = { id: 'e1', title: 'Intervallit', date: '2026-09-29', startTime: '18:00', goalId: 'g1' };
  const session = { id: 's1', date: '2026-09-28', kind: 'Juoksu', actualMinutes: 30, goalId: 'g1' };
  await calendarEventsRepo.insert(event);
  await exerciseSessionsRepo.insert(session);
  setGoals([GOAL, { id: 'g2', title: 'Muu' }]);
  setTasks([
    { id: 't1', title: 'Lenkki', date: '2026-09-29', goalId: 'g1' },
    { id: 't2', title: 'Muu tehtävä', date: '2026-09-29', goalId: 'g2' }
  ]);
  setTimeEntries([{ id: 'te1', entryDate: '2026-09-27', minutes: 30, goalId: 'g1', source: 'manual' }]);
  setCalendarEvents([event]);
  setExerciseSessions([session]);
});

async function withRemove(impl, run) {
  const original = goalsRepo.remove;
  goalsRepo.remove = impl;
  try { return await run(); } finally { goalsRepo.remove = original; }
}

const failing = async () => ({ ok: false, error: { message: 'verkko', userMessage: 'Yhteys katkesi.' } });

test('KRIITTINEN: epäonnistunut poisto palauttaa liitokset tehtäviin, aikaan, menoihin ja liikuntaan', async () => {
  const removed = await withRemove(failing, () => deleteGoal('g1', { confirm: yes }));
  assert.equal(removed, false);

  const state = getState();
  assert.deepEqual(state.goals.map(g => g.id).sort(), ['g1', 'g2'], 'tavoite palautui');
  assert.equal(state.tasks.find(t => t.id === 't1').goalId, 'g1', 'tehtävän liitos jäi katki');
  assert.equal(state.tasks.find(t => t.id === 't2').goalId, 'g2', 'toisen tavoitteen tehtävä ennallaan');
  assert.equal(state.timeEntries[0].goalId, 'g1', 'aikakirjauksen liitos jäi katki');
  assert.equal(state.calendarEvents[0].goalId, 'g1', 'menon liitos jäi katki');
  assert.equal(state.exerciseSessions[0].goalId, 'g1', 'liikuntakerran liitos jäi katki');
});

test('KRIITTINEN: peruutuksen jälkeinen muokkaus ei pyyhi liitosta tallennuksesta', async () => {
  await withRemove(failing, () => deleteGoal('g1', { confirm: yes }));

  assert.equal((await saveCalendarEvent({ id: 'e1', title: 'Intervallit (siirretty)' })).ok, true);
  assert.equal((await saveExerciseSession({ id: 's1', actualMinutes: 45 })).ok, true);
  const storedEvent = await storedRow(calendarEventsRepo, 'e1');
  const storedSession = await storedRow(exerciseSessionsRepo, 's1');
  assert.equal(storedEvent.goalId, 'g1', 'otsikon muutos tallensi goal_id = null');
  assert.equal(storedSession.goalId, 'g1', 'keston muutos tallensi goal_id = null');
});

test('peruutus ei ylikirjoita liitosta, jonka käyttäjä vaihtoi odotuksen aikana', async () => {
  let release;
  const pending = withRemove(() => new Promise(resolve => { release = () => resolve(failing()); }),
    () => deleteGoal('g1', { confirm: yes }));
  await new Promise(resolve => setImmediate(resolve));
  // Käyttäjä liitti tehtävän toiseen tavoitteeseen poiston odottaessa.
  setTasks(getState().tasks.map(t => (t.id === 't1' ? { ...t, goalId: 'g2' } : t)));
  release();
  assert.equal(await pending, false);
  assert.equal(getState().tasks.find(t => t.id === 't1').goalId, 'g2');
  assert.equal(getState().calendarEvents[0].goalId, 'g1');
});

test('KRIITTINEN: tilin vaihto poiston aikana ei palauta A:n tavoitetta B:n tilaan', async () => {
  let release;
  const pending = withRemove(() => new Promise(resolve => { release = () => resolve(failing()); }),
    () => deleteGoal('g1', { confirm: yes }));
  await new Promise(resolve => setImmediate(resolve));
  clearUser();
  resetState();
  setUser(USER_B);
  release();
  assert.equal(await pending, false);
  const state = getState();
  assert.deepEqual(state.goals, [], 'A:n tavoite ilmestyi B:lle');
  assert.deepEqual(state.tasks, []);
  assert.deepEqual(state.calendarEvents, []);
});

test('onnistunut poisto katkaisee liitokset kuten kanta', async () => {
  assert.equal(await deleteGoal('g1', { confirm: yes }), true);
  const state = getState();
  assert.deepEqual(state.goals.map(g => g.id), ['g2']);
  assert.equal(state.tasks.find(t => t.id === 't1').goalId, null);
  assert.equal(state.timeEntries[0].goalId, null);
  assert.equal(state.calendarEvents[0].goalId, null);
  assert.equal(state.exerciseSessions[0].goalId, null);
});
