// Sovelluskerroksen logiikan testit.
//
// Nämä funktiot on tarkoituksella erotettu renderöinnistä, jotta ne voidaan
// testata ilman selainta. Erityisesti NYT-tilan päättely oli aiemmin
// renderTimeline-funktion sisällä eikä sitä voinut testata lainkaan — ja juuri
// siinä oli auditoinnissa löydetty bugi.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveNowState } from '../src/app/views/today.js';
import { authErrorMessage, validateCredentials, MIN_PASSWORD_LENGTH } from '../src/app/auth.js';
import {
  getState, setTasks, addTaskToState, patchTaskInState, removeTaskFromState,
  replaceTaskInState, findTask, resetState, setViewDate, setScreen,
  clearOtherWakeFlagsInState, subscribe, viewDateIso
} from '../src/app/state.js';
import { formatDuration, formatTimeRange, formatShortDate, capitalize } from '../src/lib/format.js';
import { AppError, ok, fail } from '../src/lib/result.js';
import { parseISO } from '../src/lib/datetime.js';

const item = (over = {}) => ({
  id: 'x', time: null, endTime: null, durationMinutes: null,
  title: 'Kohde', completed: false, virtual: false, ...over
});

// ----------------------------------------------------- NYT-tilan päättely

test('ilman nykyhetkeä NYT-tilaa ei ole', () => {
  const state = resolveNowState([item({ time: '09:00' })], null);
  assert.equal(state.index, -1);
});

test('käynnissä oleva kohde tunnistetaan aikavälin perusteella', () => {
  const items = [
    item({ id: 'a', time: '08:00', endTime: '09:00' }),
    item({ id: 'b', time: '12:00', endTime: '20:00' })
  ];
  const state = resolveNowState(items, 12 * 60 + 10); // 12:10
  assert.equal(state.index, 1);
  assert.equal(state.status, 'running');
});

test('REGRESSIO: automaattinen merkintä ei jää jumiin myöhässä-tilaan', () => {
  // Tämä on auditoinnissa löydetty bugi. Kuvakaappaus 30.7.2026 klo 12:10
  // näytti NYT-merkin jumissa klo 07:00 AUTO-herätyksessä, vaikka klo 12:00
  // alkanut karting oli käynnissä. Syy: automaattiset merkinnät eivät koskaan
  // tule valmiiksi, joten ne täyttivät myöhässä-ehdon ikuisesti.
  const items = [
    item({ id: 'virtual-wake', time: '07:00', virtual: true }),
    item({ id: 'virtual-routine', time: '07:00', endTime: '07:30', virtual: true }),
    item({ id: 'matka', time: '11:30', endTime: '12:00' }),
    item({ id: 'karting', time: '12:00', endTime: '20:00' })
  ];
  const state = resolveNowState(items, 12 * 60 + 10);
  assert.equal(items[state.index].id, 'karting', 'NYT pitää olla käynnissä olevassa tehtävässä');
  assert.equal(state.status, 'running');
});

test('myöhässä-tila osoittaa viimeisimpään kuittaamattomaan tehtävään', () => {
  const items = [
    item({ id: 'a', time: '08:00', endTime: '09:00' }),
    item({ id: 'b', time: '10:00', endTime: '11:00' })
  ];
  const state = resolveNowState(items, 15 * 60); // 15:00, aukko
  assert.equal(items[state.index].id, 'b');
  assert.equal(state.status, 'late');
});

test('kuitattu tehtävä ei jää myöhässä-tilaan', () => {
  const items = [item({ id: 'a', time: '08:00', endTime: '09:00', completed: true })];
  const state = resolveNowState(items, 15 * 60);
  assert.equal(state.index, -1, 'tehty tehtävä ei ole myöhässä');
});

test('virtuaalinen merkintä ei koskaan aiheuta myöhässä-tilaa', () => {
  const items = [item({ id: 'virtual-sleep', time: '22:00', endTime: '06:00', virtual: true })];
  const state = resolveNowState(items, 12 * 60);
  assert.equal(state.status, 'running');
  assert.equal(state.index, -1);
});

test('etuajassa: käynnissä oleva tehtävä on jo kuitattu', () => {
  const items = [item({ id: 'a', time: '12:00', endTime: '13:00', completed: true })];
  const state = resolveNowState(items, 12 * 60 + 30);
  assert.equal(state.status, 'early');
});

test('kestoton merkintä jatkuu seuraavaan aikataulutettuun kohtaan', () => {
  const items = [
    item({ id: 'a', time: '09:00' }),
    item({ id: 'b', time: '15:00' })
  ];
  const state = resolveNowState(items, 12 * 60);
  assert.equal(items[state.index].id, 'a', 'ensimmäinen kestää klo 15:00 asti');
});

test('ajattomat kohteet ohitetaan NYT-päättelyssä', () => {
  const items = [item({ id: 'ajaton', time: null })];
  assert.equal(resolveNowState(items, 12 * 60).index, -1);
});

test('tyhjä aikajana ei kaadu', () => {
  assert.deepEqual(resolveNowState([], 12 * 60), { index: -1, status: 'running' });
});

// --------------------------------------------------- kirjautumisen apurit

test('validateCredentials vaatii kelvollisen sähköpostin', () => {
  assert.match(validateCredentials('ei-sahkoposti', 'salasana123'), /sähköposti/i);
  assert.match(validateCredentials('', 'salasana123'), /sähköposti/i);
  assert.equal(validateCredentials('a@b.fi', 'salasana123'), null);
});

test('validateCredentials vaatii riittävän pitkän salasanan', () => {
  const short = 'a'.repeat(MIN_PASSWORD_LENGTH - 1);
  assert.match(validateCredentials('a@b.fi', short), /vähintään/i);
  assert.equal(validateCredentials('a@b.fi', 'a'.repeat(MIN_PASSWORD_LENGTH)), null);
});

test('TURVA: virheviesti ei paljasta oliko sähköposti olemassa', () => {
  const wrongPassword = authErrorMessage({ message: 'Invalid login credentials' });
  assert.match(wrongPassword, /Sähköposti tai salasana/);
  assert.equal(wrongPassword.toLowerCase().includes('ei löydy'), false);
  assert.equal(wrongPassword.toLowerCase().includes('tuntematon'), false);
});

test('authErrorMessage kääntää tunnetut virheet suomeksi', () => {
  assert.match(authErrorMessage({ message: 'Email not confirmed' }), /Vahvista/i);
  assert.match(authErrorMessage({ message: 'User already registered' }), /jo tili/i);
  assert.match(authErrorMessage({ message: 'Too many requests' }), /Odota/i);
  assert.match(authErrorMessage({ message: 'Failed to fetch' }), /Verkkoyhteys/i);
});

test('TURVA: tuntematon virhe ei vuoda palvelimen viestiä', () => {
  const leaked = 'PGRST301: JWT expired at /var/task/index.js:42';
  const message = authErrorMessage({ message: leaked });
  assert.equal(message.includes('PGRST301'), false);
  assert.equal(message.includes('/var/task'), false);
  assert.match(message, /Kirjautuminen ei onnistunut/);
});

test('authErrorMessage kestää puuttuvan virheen', () => {
  assert.equal(typeof authErrorMessage(null), 'string');
  assert.equal(typeof authErrorMessage(undefined), 'string');
  assert.equal(typeof authErrorMessage({}), 'string');
});

// ---------------------------------------------------------- tilan hallinta

test('setTasks normalisoi tehtävät', () => {
  resetState();
  setTasks([{ id: 'a', title: '  Siisti  ', date: '2026-08-31', category: 'olematon' }]);
  const task = findTask('a');
  assert.equal(task.title, 'Siisti');
  assert.equal(task.category, 'muu');
  assert.equal(getState().loading, false);
});

test('tehtävän lisäys, päivitys ja poisto muistissa', () => {
  resetState();
  addTaskToState({ id: 'a', title: 'Alku', date: '2026-08-31' });
  assert.equal(findTask('a').title, 'Alku');

  patchTaskInState('a', { completed: true });
  assert.equal(findTask('a').completed, true);

  replaceTaskInState('a', { id: 'a', title: 'Korvattu', date: '2026-08-31' });
  assert.equal(findTask('a').title, 'Korvattu');
  assert.equal(findTask('a').completed, false);

  removeTaskFromState('a');
  assert.equal(findTask('a'), null);
});

test('tilamuutos ilmoitetaan tilaajille', () => {
  resetState();
  let calls = 0;
  const unsubscribe = subscribe(() => { calls++; });
  addTaskToState({ id: 'a', title: 'X', date: '2026-08-31' });
  assert.equal(calls, 1);
  unsubscribe();
  addTaskToState({ id: 'b', title: 'Y', date: '2026-08-31' });
  assert.equal(calls, 1, 'tilauksen lopetuksen jälkeen ei enää ilmoiteta');
  resetState();
});

test('yhden tilaajan virhe ei estä muiden päivittymistä', () => {
  resetState();
  let secondCalled = false;
  const off1 = subscribe(() => { throw new Error('rikki'); });
  const off2 = subscribe(() => { secondCalled = true; });
  addTaskToState({ id: 'a', title: 'X', date: '2026-08-31' });
  assert.equal(secondCalled, true);
  off1(); off2(); resetState();
});

test('päivällä voi olla vain yksi herätysmerkintä', () => {
  resetState();
  setTasks([
    { id: 'a', title: 'Vanha herätys', date: '2026-08-31', time: '06:00', isWake: true },
    { id: 'b', title: 'Uusi herätys', date: '2026-08-31', time: '05:30', isWake: true },
    { id: 'c', title: 'Toinen päivä', date: '2026-09-01', time: '06:00', isWake: true }
  ]);
  clearOtherWakeFlagsInState('2026-08-31', 'b');
  assert.equal(findTask('a').isWake, false);
  assert.equal(findTask('b').isWake, true);
  assert.equal(findTask('c').isWake, true, 'toisen päivän herätys ei saa muuttua');
});

test('resetState tyhjentää kaiken henkilökohtaisen tilan', () => {
  setTasks([{ id: 'a', title: 'Salainen', date: '2026-08-31' }]);
  setScreen('screen-profile');
  resetState();
  assert.deepEqual(getState().tasks, []);
  assert.equal(getState().screen, 'screen-today');
  assert.equal(getState().editingId, null);
});

test('viewDateIso seuraa valittua päivää', () => {
  resetState();
  setViewDate(parseISO('2026-12-24'));
  assert.equal(viewDateIso(), '2026-12-24');
  resetState();
});

// ------------------------------------------------------------- muotoilu

test('formatDuration muotoilee tunnit ja minuutit', () => {
  assert.equal(formatDuration(45), '45 min');
  assert.equal(formatDuration(60), '1 h');
  assert.equal(formatDuration(90), '1 h 30 min');
  assert.equal(formatDuration(0), null);
  assert.equal(formatDuration(null), null);
  assert.equal(formatDuration(-5), null);
});

test('formatTimeRange muotoilee aikavälin', () => {
  assert.equal(formatTimeRange('07:00', '08:00'), '07:00–08:00');
  assert.equal(formatTimeRange('07:00', null), '07:00');
  assert.equal(formatTimeRange(null, '08:00'), null);
});

test('formatShortDate ja capitalize', () => {
  assert.equal(formatShortDate(parseISO('2026-08-31')), '31.8.');
  assert.equal(capitalize('maanantai'), 'Maanantai');
  assert.equal(capitalize(''), '');
  assert.equal(capitalize(null), '');
});

// -------------------------------------------------------------- virheet

test('AppError erottaa käyttäjäviestin diagnostiikasta', () => {
  const cause = new Error('column "priority" does not exist');
  const error = new AppError('Tallennus ei onnistunut.', { cause, code: 'tasks.insert' });

  assert.equal(error.userMessage, 'Tallennus ei onnistunut.');
  assert.equal(error.userMessage.includes('column'), false, 'kannan viesti ei kuulu käyttäjälle');
  assert.ok(error.toDiagnostic().includes('column'), 'kehittäjän pitää nähdä syy');
  assert.ok(error.toDiagnostic().includes('tasks.insert'));
});

test('ok ja fail tuottavat yhtenäisen tuloksen', () => {
  const success = ok(42);
  assert.equal(success.ok, true);
  assert.equal(success.value, 42);

  const failure = fail('Ei onnistunut.', { code: 'x' });
  assert.equal(failure.ok, false);
  assert.equal(failure.error.userMessage, 'Ei onnistunut.');
  assert.ok(failure.error instanceof AppError);
});
