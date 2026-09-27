// Arjen tallennustoiminnot (src/app/dailyLifeActions.js): optimistinen tila,
// peruutus epäonnistuessa, yksi rivi per päivä/käyttäjä, lisänimen
// vahvistusten laskenta, havaintojen karsinta ja istunnon vaihto kesken.
//
// Portit ovat tuotehaaralla kiinni: repositoriot käyttävät muistivarastoa.
// Epäonnistuminen tuotetaan korvaamalla repositorion metodi hetkeksi.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { setUser, clearUser } from '../src/data/session.js';
import { resetState, getState } from '../src/app/state.js';
import { clearAllCollections, calendarEventsRepo, savedPlacesRepo, lifeSettingsRepo, habitEventsRepo }
  from '../src/data/collectionsRepo.js';
import {
  saveCalendarEvent, deleteCalendarEvent, skipEventOccurrence, savePlace, deletePlace, confirmPlaceAlias,
  deletePlaceAlias, resetPlaceLearning, recordCommuteObservation, saveLifeSettings, saveSleepLog,
  saveHabitPlan, deleteHabitPlan, logHabitEvent, deleteHabitEvent, saveExerciseSession, deleteExerciseSession,
  saveWellbeingCheckin, resetDailyLifeActions
} from '../src/app/dailyLifeActions.js';
import { MAX_OBSERVATIONS_PER_PLACE } from '../src/domain/dailyLife.js';
import { readCode } from './helpers/sources.mjs';

const USER_A = { id: 'aaaaaaaa-0000-0000-0000-00000000000a', email: 'a@example.com' };
const USER_B = { id: 'bbbbbbbb-0000-0000-0000-00000000000b', email: 'b@example.com' };
const yes = async () => true;
const no = async () => false;

beforeEach(() => {
  clearAllCollections();
  resetState();
  resetDailyLifeActions();
  setUser(USER_A);
});

/** Korvaa repositorion metodi testin ajaksi. */
async function withFailing(repo, method, run) {
  const original = repo[method];
  repo[method] = async () => ({ ok: false, error: { message: 'verkko', userMessage: 'Yhteys katkesi.' } });
  try { return await run(); } finally { repo[method] = original; }
}

test('meno: luonti, päivitys samalla tunnisteella, validointi', async () => {
  const bad = await saveCalendarEvent({ title: '', date: '2026-09-29' });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.title);

  const created = await saveCalendarEvent({ title: 'Parturi', date: '2026-09-29', startTime: '16:00', durationMinutes: 45 });
  assert.equal(created.ok, true);
  assert.equal(getState().calendarEvents.length, 1);

  const updated = await saveCalendarEvent({ id: created.event.id, startTime: '16:30' });
  assert.equal(updated.ok, true);
  assert.equal(getState().calendarEvents.length, 1, 'päivitys ei luo uutta menoa');
  assert.equal(getState().calendarEvents[0].startTime, '16:30');
  assert.equal(getState().calendarEvents[0].title, 'Parturi', 'muut kentät säilyvät');
});

test('KRIITTINEN: epäonnistunut tallennus peruu tilan (luonti ja päivitys)', async () => {
  const failed = await withFailing(calendarEventsRepo, 'insert',
    () => saveCalendarEvent({ title: 'Teatteri', date: '2026-10-03', startTime: '19:00' }));
  assert.equal(failed.ok, false);
  assert.deepEqual(getState().calendarEvents, [], 'epäonnistunut meno ei jää näkyviin');

  const ok = await saveCalendarEvent({ title: 'Teatteri', date: '2026-10-03', startTime: '19:00' });
  const edit = await withFailing(calendarEventsRepo, 'update',
    () => saveCalendarEvent({ id: ok.event.id, startTime: '18:00' }));
  assert.equal(edit.ok, false);
  assert.equal(getState().calendarEvents[0].startTime, '19:00', 'vanha arvo palautui');
});

test('poistettuun paikkaan ei liitetä menoa (yhdistelmävierasavain)', async () => {
  const result = await saveCalendarEvent({
    title: 'Hammaslääkäri', date: '2026-09-30', startTime: '09:00', placeId: 'ei-olemassa'
  });
  assert.equal(result.ok, true);
  assert.equal(getState().calendarEvents[0].placeId, null);
});

test('menon poisto kysyy vahvistuksen; peruminen ei poista, epäonnistuminen palauttaa', async () => {
  const { event } = await saveCalendarEvent({ title: 'Työ', date: '2026-09-28', startTime: '07:00', recurrenceWeekdays: [1, 2, 3, 4, 5] });
  let asked = null;
  const cancelled = await deleteCalendarEvent(event.id, { confirm: async opts => { asked = opts; return false; } });
  assert.equal(cancelled.cancelled, true);
  assert.match(asked.message, /toistuu/);
  assert.equal(getState().calendarEvents.length, 1);

  const failed = await withFailing(calendarEventsRepo, 'remove', () => deleteCalendarEvent(event.id, { confirm: yes }));
  assert.equal(failed.ok, false);
  assert.equal(getState().calendarEvents.length, 1, 'epäonnistunut poisto palautti menon');

  assert.equal((await deleteCalendarEvent(event.id, { confirm: yes })).ok, true);
  assert.deepEqual(getState().calendarEvents, []);
});

test('toistuvan menon yksi kerta ohitetaan idempotentisti', async () => {
  const { event } = await saveCalendarEvent({ title: 'Työ', date: '2026-09-28', startTime: '07:00', recurrenceWeekdays: [1, 2, 3, 4, 5] });
  assert.equal((await skipEventOccurrence(event.id, '2026-09-30')).ok, true);
  assert.equal((await skipEventOccurrence(event.id, '2026-09-30')).ok, true);
  assert.deepEqual(getState().calendarEvents[0].skipDates, ['2026-09-30']);
});

test('paikka: nimi on uniikki, poisto vie lisänimet ja havainnot ja irrottaa menot', async () => {
  const work = await savePlace({ name: 'Työ', usualTravelMinutes: 35 });
  assert.equal(work.ok, true);
  const dup = await savePlace({ name: 'työ' });
  assert.equal(dup.ok, false, 'sama nimi eri kirjainkoolla');
  assert.ok(dup.errors.name);

  await confirmPlaceAlias('Duuni', work.place.id);
  await recordCommuteObservation({ placeId: work.place.id, observedOn: '2026-09-28', weekday: 1, travelMinutes: 38 });
  await saveCalendarEvent({ title: 'Palaveri', date: '2026-09-29', startTime: '09:00', placeId: work.place.id });

  const failed = await withFailing(savedPlacesRepo, 'remove', () => deletePlace(work.place.id, { confirm: yes }));
  assert.equal(failed.ok, false);
  const s1 = getState();
  assert.equal(s1.savedPlaces.length, 1);
  assert.equal(s1.placeAliases.length, 1);
  assert.equal(s1.commuteObservations.length, 1);
  assert.equal(s1.calendarEvents[0].placeId, work.place.id, 'menon liitos palautui');

  assert.equal((await deletePlace(work.place.id, { confirm: yes })).ok, true);
  const s2 = getState();
  assert.deepEqual([s2.savedPlaces.length, s2.placeAliases.length, s2.commuteObservations.length], [0, 0, 0]);
  assert.equal(s2.calendarEvents[0].placeId, null);
});

test('lisänimi: sama pari kasvattaa vahvistuksia, ei monista riviä; normalisointi', async () => {
  const { place } = await savePlace({ name: 'Parturi Kallio' });
  const first = await confirmPlaceAlias('  Parturi ', place.id, { nowIso: '2026-09-27T10:00:00.000Z' });
  const second = await confirmPlaceAlias('PARTURI', place.id, { nowIso: '2026-09-28T10:00:00.000Z' });
  assert.equal(first.ok && second.ok, true);
  assert.equal(getState().placeAliases.length, 1);
  assert.equal(getState().placeAliases[0].alias, 'parturi');
  assert.equal(getState().placeAliases[0].confirmations, 2);
  assert.equal((await confirmPlaceAlias('parturi', 'ei-paikkaa')).ok, false);
  assert.equal((await deletePlaceAlias(getState().placeAliases[0].id)).ok, true);
  assert.deepEqual(getState().placeAliases, []);
});

test('oppimisen nollaus poistaa vain nimitykset ja havainnot; paikka ja oma arvio säilyvät', async () => {
  const { place } = await savePlace({ name: 'Työ', usualTravelMinutes: 35, useLearned: true });
  await confirmPlaceAlias('duuni', place.id);
  await recordCommuteObservation({ placeId: place.id, observedOn: '2026-09-28', weekday: 1, travelMinutes: 40 });
  assert.equal((await resetPlaceLearning(place.id, { confirm: no })).cancelled, true);
  const reset = await resetPlaceLearning(place.id, { confirm: yes });
  assert.equal(reset.ok, true);
  const s = getState();
  assert.equal(s.placeAliases.length + s.commuteObservations.length, 0);
  assert.equal(s.savedPlaces[0].usualTravelMinutes, 35);
  assert.equal(s.savedPlaces[0].useLearned, false, 'opitun käyttö kytkeytyy pois');
});

test('KRIITTINEN: matkahavainnot rajataan paikkaa kohti, vanhimmat pois', async () => {
  const { place } = await savePlace({ name: 'Työ' });
  const other = (await savePlace({ name: 'Sali' })).place;
  await recordCommuteObservation({ placeId: other.id, observedOn: '2026-01-01', weekday: 4, travelMinutes: 10 });
  for (let i = 0; i < MAX_OBSERVATIONS_PER_PLACE + 3; i += 1) {
    const day = String((i % 28) + 1).padStart(2, '0');
    const month = String(Math.floor(i / 28) + 1).padStart(2, '0');
    await recordCommuteObservation({ placeId: place.id, observedOn: `2026-${month}-${day}`, weekday: 1, travelMinutes: 30 + (i % 5) });
  }
  const own = getState().commuteObservations.filter(o => o.placeId === place.id);
  assert.equal(own.length, MAX_OBSERVATIONS_PER_PLACE);
  assert.equal(own.some(o => o.observedOn === '2026-01-01'), false, 'vanhin karsittiin');
  assert.equal(getState().commuteObservations.filter(o => o.placeId === other.id).length, 1, 'toisen paikan havainnot ennallaan');
  const bad = await recordCommuteObservation({ placeId: 'ei-paikkaa', observedOn: '2026-09-28', weekday: 1 });
  assert.equal(bad.ok, false);
});

test('arjen asetukset: yksi rivi, sisäkkäinen herätys yhdistetään, epäonnistuminen palauttaa', async () => {
  assert.equal((await saveLifeSettings({ windDownMinutes: 45 })).ok, true);
  assert.equal((await saveLifeSettings({ alarm: { enabled: true } })).ok, true);
  assert.equal(getState().lifeSettings.length, 1);
  assert.equal(getState().lifeSettings[0].windDownMinutes, 45);
  assert.equal(getState().lifeSettings[0].alarm.enabled, true);

  const before = getState().lifeSettings[0];
  const failed = await withFailing(lifeSettingsRepo, 'update', () => saveLifeSettings({ windDownMinutes: 10 }));
  assert.equal(failed.ok, false);
  assert.equal(getState().lifeSettings[0].windDownMinutes, before.windDownMinutes);
});

test('uni ja vointi: yksi rivi päivää kohti; tyhjä ei ole nolla', async () => {
  await saveSleepLog({ wakeDate: '2026-09-28', actualBedtime: '23:00' });
  await saveSleepLog({ wakeDate: '2026-09-28', actualWake: '06:30' });
  assert.equal(getState().sleepLogs.length, 1);
  assert.deepEqual([getState().sleepLogs[0].actualBedtime, getState().sleepLogs[0].actualWake], ['23:00', '06:30']);

  await saveWellbeingCheckin({ date: '2026-09-28', motivation: 4 });
  await saveWellbeingCheckin({ date: '2026-09-28', control: 3 });
  const [c] = getState().wellbeingCheckins;
  assert.equal(getState().wellbeingCheckins.length, 1);
  assert.deepEqual([c.motivation, c.control], [4, 3]);
  const empty = await saveWellbeingCheckin({ date: '2026-09-29' });
  assert.equal(empty.ok, false, 'tyhjää kirjausta ei tallenneta');
  assert.equal(getState().wellbeingCheckins.length, 1);
  await saveWellbeingCheckin({ date: '2026-09-29', control: 2 });
  assert.equal(getState().wellbeingCheckins.find(x => x.date === '2026-09-29').motivation, null,
    'vastaamaton on null, ei nolla eikä 1');
});

test('tavat: suunnitelma, kirjaukset, poisto vie kirjaukset ja palauttaa ne epäonnistuessa', async () => {
  const { plan } = await saveHabitPlan({ kind: 'nicotine', name: 'Nikotiini', minIntervalMinutes: 120 });
  const used = await logHabitEvent({ planId: plan.id, action: 'use', nowIso: '2026-09-28T08:00:00.000Z' });
  assert.equal(used.ok, true);
  assert.equal((await logHabitEvent({ planId: 'ei', action: 'use' })).ok, false);
  const failedEvent = await withFailing(habitEventsRepo, 'insert',
    () => logHabitEvent({ planId: plan.id, action: 'skip', nowIso: '2026-09-28T10:00:00.000Z' }));
  assert.equal(failedEvent.ok, false);
  assert.equal(getState().habitEvents.length, 1);

  assert.equal((await deleteHabitPlan(plan.id, { confirm: yes })).ok, true);
  assert.deepEqual([getState().habitPlans.length, getState().habitEvents.length], [0, 0]);

  const again = (await saveHabitPlan({ kind: 'generic', name: 'Kahvi' })).plan;
  const ev = (await logHabitEvent({ planId: again.id, action: 'delay', nowIso: '2026-09-28T09:00:00.000Z' })).event;
  assert.equal((await deleteHabitEvent(ev.id)).ok, true);
});

test('liikunta: luonti, muokkaus, poisto vahvistuksella', async () => {
  const { session } = await saveExerciseSession({ date: '2026-09-28', kind: 'Juoksu', actualMinutes: 30, intensity: 3 });
  assert.equal((await saveExerciseSession({ id: session.id, actualMinutes: 35 })).ok, true);
  assert.equal(getState().exerciseSessions[0].actualMinutes, 35);
  assert.equal((await deleteExerciseSession(session.id, { confirm: no })).cancelled, true);
  assert.equal((await deleteExerciseSession(session.id, { confirm: yes })).ok, true);
  assert.deepEqual(getState().exerciseSessions, []);
});

test('KRIITTINEN: istunnon vaihto kesken tallennuksen ei kirjoita toisen käyttäjän tilaan eikä peru sitä', async () => {
  const original = calendarEventsRepo.insert;
  let release;
  calendarEventsRepo.insert = entity => new Promise(resolve => {
    release = () => resolve({ ok: false, error: { message: 'myöhästynyt' } });
  });
  try {
    const pending = saveCalendarEvent({ title: 'A:n meno', date: '2026-09-29', startTime: '10:00' });
    // Uloskirjautuminen ja B:n kirjautuminen kesken odotuksen.
    clearUser();
    resetState();
    setUser(USER_B);
    await saveLifeSettings({ windDownMinutes: 20 });
    release();
    const result = await pending;
    assert.equal(result.discarded, true);
    assert.deepEqual(getState().calendarEvents, [], 'A:n meno ei ilmesty B:lle');
    assert.equal(getState().lifeSettings[0].windDownMinutes, 20, 'B:n tila ennallaan (ei peruutusta)');
  } finally {
    calendarEventsRepo.insert = original;
  }
});

test('moduuli ei käytä offline-jonoa eikä tekoälyä, ja jokainen poisto kysyy vahvistuksen', () => {
  const code = readCode('src/app/dailyLifeActions.js');
  assert.equal(/offline|queueOffline|\/ai\//.test(code), false);
  for (const fn of ['deleteCalendarEvent', 'deletePlace', 'resetPlaceLearning', 'deleteHabitPlan', 'deleteExerciseSession']) {
    const body = code.slice(code.indexOf(`export async function ${fn}`));
    const end = body.indexOf('\nexport ', 10);
    assert.match(end > 0 ? body.slice(0, end) : body, /await confirm\(/, `${fn} ei kysy vahvistusta`);
  }
});
