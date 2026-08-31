// Tehtävän domain-mallin testit: normalisointi, validointi, kesto, järjestys.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SCHEDULING, normalizeTask, validateTask, durationOf, effectiveEndTime,
  schedulingStateOf, isMovableByScheduler, compareForDay, compareByDateThenDay,
  overlaps, partitionDay, toMinutes, fromMinutes, isIsoDate, isTimeOfDay,
  MAX_TITLE_LENGTH
} from '../src/domain/task.js';

const base = {
  id: 't1', title: 'Testi', date: '2026-08-31', time: '09:00', endTime: '10:00',
  category: 'tyo', priority: 'normaali', completed: false, isWake: false
};

// ------------------------------------------------------- perusmuunnokset

test('toMinutes ja fromMinutes ovat käänteisiä', () => {
  for (const time of ['00:00', '07:30', '12:00', '23:59']) {
    assert.equal(fromMinutes(toMinutes(time)), time);
  }
});

test('fromMinutes kiertää vuorokauden yli', () => {
  assert.equal(fromMinutes(1440), '00:00');
  assert.equal(fromMinutes(1500), '01:00');
  assert.equal(fromMinutes(-60), '23:00');
});

test('isIsoDate hyväksyy vain kelvollisen ISO-päivän', () => {
  assert.equal(isIsoDate('2026-08-31'), true);
  for (const bad of ['31.8.2026', '2026-13-01', '2026-8-1', '', null, 20260831]) {
    assert.equal(isIsoDate(bad), false, 'hyväksyi: ' + JSON.stringify(bad));
  }
});

test('isTimeOfDay hyväksyy vain 24 h muodon', () => {
  for (const good of ['00:00', '09:05', '23:59']) assert.equal(isTimeOfDay(good), true);
  for (const bad of ['24:00', '9:05', '23:60', '', null, '07.30']) {
    assert.equal(isTimeOfDay(bad), false, 'hyväksyi: ' + JSON.stringify(bad));
  }
});

// ---------------------------------------------------------- normalisointi

test('normalizeTask pudottaa tuntemattomat kentät', () => {
  const task = normalizeTask({ ...base, roskaa: 'x', user_id: 'vieras' });
  assert.equal('roskaa' in task, false);
  assert.equal('user_id' in task, false);
});

test('normalizeTask korvaa virheelliset arvot oletuksilla', () => {
  const task = normalizeTask({ title: 'X', date: 'roska', time: '99:99', category: 'olematon', priority: 'kiireellinen' });
  assert.equal(task.date, null);
  assert.equal(task.time, null);
  assert.equal(task.category, 'muu');
  assert.equal(task.priority, 'normaali');
});

test('normalizeTask siistii ja katkaisee otsikon', () => {
  assert.equal(normalizeTask({ title: '   Siisti   ' }).title, 'Siisti');
  assert.equal(normalizeTask({ title: 'a'.repeat(MAX_TITLE_LENGTH + 50) }).title.length, MAX_TITLE_LENGTH);
});

test('normalizeTask johtaa aikataulutuksen tilan ajasta', () => {
  assert.equal(normalizeTask({ ...base, time: null }).schedulingState, SCHEDULING.UNSCHEDULED);
  assert.equal(normalizeTask({ ...base }).schedulingState, SCHEDULING.MANUAL);
  assert.equal(normalizeTask({ ...base, schedulingState: SCHEDULING.AUTO }).schedulingState, SCHEDULING.AUTO);
});

test('normalizeTask hylkää epäkelvon keston', () => {
  assert.equal(normalizeTask({ ...base, durationMinutes: -5 }).durationMinutes, null);
  assert.equal(normalizeTask({ ...base, durationMinutes: 'roska' }).durationMinutes, null);
  assert.equal(normalizeTask({ ...base, durationMinutes: 45.4 }).durationMinutes, 45);
});

// ------------------------------------------------------------- validointi

test('validateTask vaatii nimen ja päivämäärän', () => {
  assert.equal(validateTask({ ...base }).valid, true);
  assert.equal(validateTask({ ...base, title: '   ' }).errors.title !== undefined, true);
  assert.equal(validateTask({ ...base, date: null }).errors.date !== undefined, true);
});

test('validateTask hylkää loppuajan ilman alkuaikaa', () => {
  const { valid, errors } = validateTask({ ...base, time: null, endTime: '10:00' });
  assert.equal(valid, false);
  assert.match(errors.endTime, /alkuaika/i);
});

test('validateTask hylkää nollan mittaisen aikavälin', () => {
  const { valid, errors } = validateTask({ ...base, time: '09:00', endTime: '09:00' });
  assert.equal(valid, false);
  assert.ok(errors.endTime);
});

test('validateTask hylkää vuorokautta pidemmän keston', () => {
  assert.equal(validateTask({ ...base, time: null, endTime: null, durationMinutes: 1441 }).valid, false);
  assert.equal(validateTask({ ...base, time: null, endTime: null, durationMinutes: 1440 }).valid, true);
});

// ------------------------------------------------------------------ kesto

test('durationOf laskee keston alku- ja loppuajasta', () => {
  assert.equal(durationOf({ time: '09:00', endTime: '10:30' }), 90);
  assert.equal(durationOf({ time: '09:00', endTime: '09:15' }), 15);
});

test('durationOf laskee keskiyön yli menevän keston', () => {
  // Uni klo 22:00–06:00 on 8 tuntia, ei negatiivinen.
  assert.equal(durationOf({ time: '22:00', endTime: '06:00' }), 480);
  assert.equal(durationOf({ time: '23:30', endTime: '00:30' }), 60);
});

test('durationOf käyttää erillistä kestokenttää, jos loppuaikaa ei ole', () => {
  assert.equal(durationOf({ time: '09:00', endTime: null, durationMinutes: 45 }), 45);
  assert.equal(durationOf({ time: null, endTime: null, durationMinutes: null }), null);
});

test('effectiveEndTime laskee loppuajan kestosta', () => {
  assert.equal(effectiveEndTime({ time: '09:00', endTime: null, durationMinutes: 90 }), '10:30');
  assert.equal(effectiveEndTime({ time: '09:00', endTime: '11:00' }), '11:00');
  assert.equal(effectiveEndTime({ time: null }), null);
});

// ------------------------------------------------- aikataulutuksen tila

test('schedulingStateOf ei luota tallennettuun arvoon ilman aikaa', () => {
  assert.equal(schedulingStateOf({ time: null, schedulingState: SCHEDULING.AUTO }), SCHEDULING.UNSCHEDULED);
});

test('TAKUU: automaatti ei saa siirtää käyttäjän itse ajastamaa tehtävää', () => {
  const manual = { ...base, schedulingState: SCHEDULING.MANUAL };
  assert.equal(isMovableByScheduler(manual), false);
});

test('automaatti saa siirtää oman ehdotuksensa ja ajattoman tehtävän', () => {
  assert.equal(isMovableByScheduler({ ...base, schedulingState: SCHEDULING.AUTO }), true);
  assert.equal(isMovableByScheduler({ ...base, time: null, endTime: null }), true);
});

test('automaatti ei siirrä valmista eikä herätysmerkintää', () => {
  assert.equal(isMovableByScheduler({ ...base, time: null, completed: true }), false);
  assert.equal(isMovableByScheduler({ ...base, time: null, isWake: true }), false);
});

// --------------------------------------------------------------- järjestys

test('compareForDay asettaa aikataulutetut ennen aikatauluttamattomia', () => {
  const items = [
    { title: 'ei aikaa', time: null, priority: 'korkea' },
    { title: 'iltapäivä', time: '15:00', priority: 'matala' }
  ];
  assert.equal([...items].sort(compareForDay)[0].title, 'iltapäivä');
});

test('compareForDay järjestää aikatauluttamattomat prioriteetin mukaan', () => {
  const items = [
    { title: 'matala', time: null, priority: 'matala' },
    { title: 'korkea', time: null, priority: 'korkea' },
    { title: 'normaali', time: null, priority: 'normaali' }
  ];
  assert.deepEqual([...items].sort(compareForDay).map(i => i.title), ['korkea', 'normaali', 'matala']);
});

test('compareForDay on deterministinen samalla prioriteetilla', () => {
  const items = [
    { title: 'Beeta', time: null, priority: 'normaali' },
    { title: 'Alfa', time: null, priority: 'normaali' }
  ];
  const once = [...items].sort(compareForDay).map(i => i.title);
  const twice = [...items].reverse().sort(compareForDay).map(i => i.title);
  assert.deepEqual(once, ['Alfa', 'Beeta']);
  assert.deepEqual(once, twice, 'järjestyksen pitää olla riippumaton syötteen järjestyksestä');
});

test('compareByDateThenDay järjestää ensin päivän mukaan', () => {
  const items = [
    { date: '2026-09-01', time: '08:00', title: 'huomenna', priority: 'normaali' },
    { date: '2026-08-31', time: '20:00', title: 'tänään', priority: 'normaali' }
  ];
  assert.deepEqual([...items].sort(compareByDateThenDay).map(i => i.title), ['tänään', 'huomenna']);
});

// ------------------------------------------------------------ päällekkäisyys

test('overlaps tunnistaa päällekkäiset aikavälit', () => {
  const a = { time: '09:00', endTime: '10:00' };
  assert.equal(overlaps(a, { time: '09:30', endTime: '10:30' }), true);
  assert.equal(overlaps(a, { time: '10:00', endTime: '11:00' }), false, 'peräkkäiset eivät ole päällekkäisiä');
  assert.equal(overlaps(a, { time: '08:00', endTime: '09:00' }), false);
  assert.equal(overlaps(a, { time: null }), false, 'ajaton ei ole koskaan päällekkäinen');
});

// ------------------------------------------------------------- jaottelu

test('partitionDay jakaa tehtävät kolmeen ryhmään', () => {
  const tasks = [
    { title: 'tehty', time: '08:00', completed: true, priority: 'normaali' },
    { title: 'ajastettu', time: '09:00', completed: false, priority: 'normaali' },
    { title: 'ajaton', time: null, completed: false, priority: 'korkea' }
  ];
  const { scheduled, unscheduled, completed } = partitionDay(tasks);
  assert.deepEqual(scheduled.map(t => t.title), ['ajastettu']);
  assert.deepEqual(unscheduled.map(t => t.title), ['ajaton']);
  assert.deepEqual(completed.map(t => t.title), ['tehty']);
});
