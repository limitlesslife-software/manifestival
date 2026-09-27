// Muistipolku noudattaa kannan poistosääntöjä (migraatio 0014).
//
// TAUSTA. Kannassa paikan poisto irrottaa menot (on delete set null
// (place_id)) ja poistaa lisänimet ja matkahavainnot (cascade); tavan
// poisto vie kirjaukset; tavoitteen poisto irrottaa menot ja
// liikuntakerrat. Tila teki saman, mutta muistivarasto ei: seuraava
// lataus (paluu sovellukseen, verkon palautuminen) toi kuolleen
// place_id:n takaisin menolle. Lähtö muuttui tuntemattomaksi ja aamun
// suunnitelma putosi profiilin työmatkaan -- herätys aikaistui ilman,
// että käyttäjä muutti mitään.
//
// Portit ovat tällä haaralla kiinni (muisti). Kun portti on auki,
// kanta hoitaa säännöt itse, eikä muistiin ole mitään peilattavaa.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { setUser, clearUser, getUser } from '../src/data/session.js';
import { setClient } from '../src/data/client.js';
import { resetState, getState } from '../src/app/state.js';
import { loadUserData, clearLocalUserData, createGoal, deleteGoal } from '../src/app/actions.js';
import {
  calendarEventsRepo, placeAliasesRepo, commuteObservationsRepo, habitEventsRepo, exerciseSessionsRepo,
  ALL_REPOSITORIES
} from '../src/data/collectionsRepo.js';
import { read } from './helpers/sources.mjs';
import {
  savePlace, deletePlace, confirmPlaceAlias, recordCommuteObservation, saveCalendarEvent,
  saveHabitPlan, deleteHabitPlan, logHabitEvent, saveExerciseSession, resetDailyLifeActions
} from '../src/app/dailyLifeActions.js';
import { createMultiTableServer } from './helpers/multiTableServer.mjs';
import { isGateOpen } from './helpers/gates.mjs';

const USER_A = { id: 'aaaaaaaa-3333-0000-0000-00000000000a', email: 'a@example.com' };
const yes = async () => true;
const server = createMultiTableServer(() => getUser()?.id ?? null);

const memoryRows = async repo => (await repo.memory.list()).value;

beforeEach(() => {
  clearUser();
  clearLocalUserData();
  resetState();
  resetDailyLifeActions();
  server.reset();
  setClient(server);
  setUser(USER_A);
});

afterEach(() => {
  clearUser();
});

test('KRIITTINEN: paikan poisto irrottaa menot ja poistaa nimitykset ja havainnot myös muistista',
  { skip: isGateOpen('calendarEvents') && 'portti auki: kanta hoitaa säännöt' }, async () => {
    const { place } = await savePlace({ name: 'Hammaslääkäri', usualTravelMinutes: 20 });
    const other = (await savePlace({ name: 'Sali' })).place;
    await confirmPlaceAlias('hammas', place.id);
    await confirmPlaceAlias('sali', other.id);
    await recordCommuteObservation({ placeId: place.id, observedOn: '2026-09-28', weekday: 1, travelMinutes: 22 });
    const { event } = await saveCalendarEvent({ title: 'Tarkastus', date: '2026-09-29', startTime: '08:00', placeId: place.id });
    const gym = (await saveCalendarEvent({ title: 'Treeni', date: '2026-09-29', startTime: '18:00', placeId: other.id })).event;

    assert.equal((await deletePlace(place.id, { confirm: yes })).ok, true);

    const events = await memoryRows(calendarEventsRepo);
    assert.equal(events.find(e => e.id === event.id).placeId, null, 'muistirivillä kuollut place_id');
    assert.equal(events.find(e => e.id === gym.id).placeId, other.id, 'toisen paikan meno ennallaan');
    assert.deepEqual((await memoryRows(placeAliasesRepo)).map(a => a.placeId), [other.id]);
    assert.deepEqual(await memoryRows(commuteObservationsRepo), []);

    // Paluu sovellukseen: lataus ei tuo poistettua paikkaa takaisin.
    await loadUserData();
    const state = getState();
    assert.equal(state.calendarEvents.find(e => e.id === event.id).placeId, null);
    assert.deepEqual(state.placeAliases.map(a => a.placeId), [other.id]);
    assert.deepEqual(state.commuteObservations, []);
  });

test('tavan poisto vie kirjaukset myös muistista',
  { skip: isGateOpen('habitEvents') && 'portti auki: kanta hoitaa säännöt' }, async () => {
    const { plan } = await saveHabitPlan({ kind: 'nicotine', name: 'Nikotiini', minIntervalMinutes: 120 });
    const keep = (await saveHabitPlan({ kind: 'generic', name: 'Kahvi' })).plan;
    await logHabitEvent({ planId: plan.id, action: 'use', nowIso: '2026-09-28T08:00:00.000Z' });
    await logHabitEvent({ planId: keep.id, action: 'use', nowIso: '2026-09-28T09:00:00.000Z' });

    assert.equal((await deleteHabitPlan(plan.id, { confirm: yes })).ok, true);
    assert.deepEqual((await memoryRows(habitEventsRepo)).map(e => e.planId), [keep.id],
      'poistetun suunnitelman kirjaukset jäivät muistiin (ja vientiin)');
    await loadUserData();
    assert.deepEqual(getState().habitEvents.map(e => e.planId), [keep.id]);
  });

test('muistin poistosäännöt ovat täsmälleen migraation 0014 vierasavaimet', () => {
  const sql = read('supabase/migrations/0014_daily_life.sql').replace(/\r\n/g, '\n');
  const pattern = /alter table public\.(\w+)\s+add constraint \w+\s+foreign key \(user_id, (\w+)\) references public\.(\w+) \(user_id, id\)\s+on delete (set null|cascade)/g;
  const fromSql = [...sql.matchAll(pattern)]
    .map(([, child, column, parent, action]) => `${parent} <- ${child}.${column} ${action}`).sort();
  assert.equal(fromSql.length, 6, 'migraation vierasavaimia ei löytynyt');

  const snake = field => field.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
  const declared = ALL_REPOSITORIES.flatMap(repo => repo.references()
    .map(ref => `${repo.table} <- ${ref.table}.${snake(ref.field)} ${ref.onDelete}`)).sort();
  assert.deepEqual(declared, fromSql);
});

test('tavoitteen poisto irrottaa menot ja liikuntakerrat myös muistista',
  { skip: isGateOpen('calendarEvents') && 'portti auki: kanta hoitaa säännöt' }, async () => {
    const { goal } = await createGoal({ title: 'Juoksukoulu' });
    const { event } = await saveCalendarEvent({ title: 'Intervallit', date: '2026-09-29', startTime: '18:00', goalId: goal.id });
    const { session } = await saveExerciseSession({ date: '2026-09-28', kind: 'Juoksu', actualMinutes: 30, goalId: goal.id });
    assert.equal(getState().calendarEvents[0].goalId, goal.id);

    assert.equal(await deleteGoal(goal.id, { confirm: yes }), true);

    assert.equal((await memoryRows(calendarEventsRepo)).find(e => e.id === event.id).goalId, null);
    assert.equal((await memoryRows(exerciseSessionsRepo)).find(s => s.id === session.id).goalId, null);
    await loadUserData();
    assert.equal(getState().calendarEvents[0].goalId, null, 'lataus toi poistetun tavoitteen takaisin menolle');
    assert.equal(getState().exerciseSessions[0].goalId, null);
  });
