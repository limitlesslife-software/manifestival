// Menon ja liikuntakerran liitokset (paikka, tavoite) ennen kirjoitusta.
//
// TAUSTA 1. withOwnPlace pudotti placeId:n aina, kun paikkaa ei ollut
// tilassa -- myös silloin, kun paikkojen lataus oli epäonnistunut ja menot
// latautuivat. Pelkkä otsikon muutos tallensi place_id = null pysyvästi:
// menolta katosi lähtö ja muistutukset.
//
// TAUSTA 2. goal_id:tä ei tarkistettu lainkaan. Liikuntalomakkeen luonnos
// säilyy näkymien välillä ja kantaa poistetun tavoitteen tunnistetta,
// vaikka valinta näyttää "Ei tavoitetta"; kanta hylkäisi tallennuksen
// (23503) joka yrityksellä. Kommentti lupasi tarkistuksen, koodi ei tehnyt.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { setUser, clearUser } from '../src/data/session.js';
import {
  resetState, getState, setGoals, setSavedPlaces, setCalendarEvents, setExerciseSessions, setDomainLoadStatus,
  removeGoalFromState
} from '../src/app/state.js';
import { clearAllCollections, calendarEventsRepo, exerciseSessionsRepo } from '../src/data/collectionsRepo.js';
import { saveCalendarEvent, saveExerciseSession, resetDailyLifeActions } from '../src/app/dailyLifeActions.js';
import { resetTestStore, storedRow } from './helpers/gateAwareStore.mjs';

const USER_A = { id: 'aaaaaaaa-5555-0000-0000-00000000000a', email: 'a@example.com' };
const LOAD_FAILED = { message: 'verkko', userMessage: 'Yhteys katkesi.' };
const EVENT = { id: 'e1', title: 'Hammaslääkäri', date: '2026-09-29', startTime: '08:00', placeId: 'p1', goalId: 'g1' };
const SESSION = { id: 's1', date: '2026-09-28', kind: 'Juoksu', actualMinutes: 30, goalId: 'g1' };

beforeEach(async () => {
  clearUser();
  clearAllCollections();
  resetTestStore();
  resetState();
  resetDailyLifeActions();
  setUser(USER_A);
  // Siemen repositorion kautta: portin tilan mukaan muistiin tai kantaan.
  await calendarEventsRepo.insert(EVENT);
  await exerciseSessionsRepo.insert(SESSION);
  setCalendarEvents([EVENT]);
  setExerciseSessions([SESSION]);
});

/** Tallennettu rivi siitä varastosta, jota portti käyttää (muisti tai kanta). */
const stored = storedRow;

test('KRIITTINEN: paikkojen lataus epäonnistui -> otsikon muutos ei katkaise menon paikkaliitosta', async () => {
  // Paikat eivät latautuneet (tila tyhjä), menot latautuivat.
  setDomainLoadStatus('savedPlaces', false, LOAD_FAILED);
  setDomainLoadStatus('goals', false, LOAD_FAILED);
  const result = await saveCalendarEvent({ id: 'e1', title: 'Hammaslääkäri (siirretty)' });
  assert.equal(result.ok, true);
  assert.equal(getState().calendarEvents[0].placeId, 'p1');
  assert.equal((await stored(calendarEventsRepo, 'e1')).placeId, 'p1', 'place_id = null tallentui pysyvästi');
  assert.equal((await stored(calendarEventsRepo, 'e1')).goalId, 'g1', 'goal_id = null tallentui pysyvästi');
});

test('paikat latautuivat ja paikka puuttuu: liitos pudotetaan (poistettu toisella laitteella)', async () => {
  setSavedPlaces([{ id: 'p2', name: 'Sali' }]);
  setDomainLoadStatus('savedPlaces', true);
  setGoals([{ id: 'g2', title: 'Muu' }]);
  setDomainLoadStatus('goals', true);
  const result = await saveCalendarEvent({ id: 'e1', title: 'Hammaslääkäri (siirretty)' });
  assert.equal(result.ok, true);
  const saved = await stored(calendarEventsRepo, 'e1');
  assert.deepEqual([saved.placeId, saved.goalId], [null, null], 'kanta hylkäisi kuolleen liitoksen (23503)');
});

test('uusi tai vaihdettu liitos tuntemattomaan kohteeseen pudotetaan aina', async () => {
  setDomainLoadStatus('savedPlaces', false, LOAD_FAILED);
  setDomainLoadStatus('goals', false, LOAD_FAILED);
  const created = await saveCalendarEvent({
    title: 'Palaveri', date: '2026-09-30', startTime: '09:00', placeId: 'place-deleted-elsewhere', goalId: 'goal-deleted-elsewhere'
  });
  assert.deepEqual([created.event.placeId, created.event.goalId], [null, null]);
  const changed = await saveCalendarEvent({ id: 'e1', placeId: 'toinen-tuntematon', goalId: 'g-tuntematon' });
  assert.deepEqual([changed.event.placeId, changed.event.goalId], [null, null]);
});

test('KRIITTINEN: liikuntakerran tuntematon tavoite pudotetaan ennen kirjoitusta', async () => {
  setGoals([{ id: 'g2', title: 'Muu' }]);
  setDomainLoadStatus('goals', true);
  const created = await saveExerciseSession({ date: '2026-09-29', kind: 'Pyöräily', actualMinutes: 40, goalId: 'goal-deleted-elsewhere' });
  assert.equal(created.ok, true);
  assert.equal(created.session.goalId, null);
  assert.equal((await stored(exerciseSessionsRepo, created.session.id)).goalId, null);

  const own = await saveExerciseSession({ date: '2026-09-29', kind: 'Kuntosali', actualMinutes: 50, goalId: 'g2' });
  assert.equal(own.session.goalId, 'g2', 'oma tavoite säilyy');
});

test('KRIITTINEN: avoimen lomakkeen luonnos ei tuo poistettua tavoitetta takaisin', async () => {
  setGoals([{ id: 'g1', title: 'Juoksukoulu' }]);
  setDomainLoadStatus('goals', true);
  // Lomake avattiin (luonnos: goalId g1), sitten tavoite poistettiin Tavoitteet-näkymässä.
  removeGoalFromState('g1');
  const result = await saveExerciseSession({ ...SESSION, actualMinutes: 45 });
  assert.equal(result.ok, true);
  assert.equal((await stored(exerciseSessionsRepo, 's1')).goalId, null, 'kanta hylkäisi goal_id = g1 (23503)');
});

test('tavoitteiden lataus epäonnistui: liikuntakerran ennallaan pysyvä tavoite säilyy', async () => {
  setDomainLoadStatus('goals', false, LOAD_FAILED);
  const result = await saveExerciseSession({ id: 's1', actualMinutes: 45 });
  assert.equal(result.ok, true);
  assert.equal((await stored(exerciseSessionsRepo, 's1')).goalId, 'g1');
});
