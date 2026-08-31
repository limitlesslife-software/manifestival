// Turvallisuustestit käyttäjäscopingin kriittisille apufunktioille.
//
// Ydinvaatimus (WP1): selain ei saa koskaan pystyä valitsemaan, kenelle
// tallennettava rivi kuuluu. Omistajuuden asettaa tietokanta
// (DEFAULT auth.uid()) ja RLS valvoo sitä. Nämä testit varmistavat, ettei
// client-koodi vahingossa ala lähettää user_id-kenttää.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  toRow, fromRow, assertClientSafe, newTaskId,
  SERVER_OWNED_FIELDS, TASK_COLUMNS_EXTENDED
} from '../src/lib/rows.js';

const EXPECTED_COLUMNS = [
  'id', 'date', 'time', 'end_time', 'title', 'category', 'note', 'completed', 'is_wake'
];

test('toRow tuottaa täsmälleen odotetut sarakkeet', () => {
  const row = toRow({
    id: 'm1', date: '2026-08-31', time: '07:00', endTime: '08:00',
    title: 'Työ', category: 'tyo', note: null, completed: false, isWake: false
  });
  assert.deepEqual(Object.keys(row).sort(), [...EXPECTED_COLUMNS].sort());
});

test('toRow nimeää camelCase-kentät kannan sarakkeiksi', () => {
  const row = toRow({
    id: 'm1', date: '2026-08-31', time: '05:30', endTime: '06:00',
    title: 'Herätys', category: 'hyvinvointi', note: 'muistiinpano',
    completed: true, isWake: true
  });
  assert.equal(row.end_time, '06:00');
  assert.equal(row.is_wake, true);
  assert.equal('endTime' in row, false);
  assert.equal('isWake' in row, false);
});

test('TURVA: toRow ei koskaan päästä user_id:tä läpi', () => {
  // Vaikka sovellusolioon olisi jotenkin päätynyt vieras user_id, sen ei saa
  // päätyä kantakutsuun. Kanta asettaa omistajan itse.
  const row = toRow({
    id: 'm1', date: '2026-08-31', time: null, endTime: null,
    title: 'Vieras tehtävä', category: 'muu', note: null,
    completed: false, isWake: false,
    user_id: '11111111-1111-1111-1111-111111111111',
    userId: '22222222-2222-2222-2222-222222222222'
  });
  assert.equal('user_id' in row, false, 'user_id ei saa olla payloadissa');
  assert.equal('userId' in row, false, 'userId ei saa olla payloadissa');
});

test('toRow pakottaa is_wake-kentän boolean-tyyppiseksi', () => {
  assert.equal(toRow({ isWake: undefined }).is_wake, false);
  assert.equal(toRow({ isWake: null }).is_wake, false);
  assert.equal(toRow({ isWake: 1 }).is_wake, true);
});

test('fromRow on toRow:n käänteisfunktio perussarakkeiden osalta', () => {
  const task = {
    id: 'm1', date: '2026-08-31', time: '13:00', endTime: '14:00',
    title: 'Laskutus', category: 'talous', note: null,
    completed: false, isWake: false
  };
  const roundTripped = fromRow(toRow(task));
  for (const [key, value] of Object.entries(task)) {
    assert.deepEqual(roundTripped[key], value, 'kenttä ' + key + ' ei säilynyt');
  }
});

test('laajennetut kentät säilyvät kierroksen yli, kun skeema tukee niitä', () => {
  const task = {
    id: 'm1', date: '2026-08-31', time: '13:00', endTime: '14:00',
    title: 'Laskutus', category: 'talous', note: null,
    completed: false, isWake: false,
    description: 'Elokuun laskut', durationMinutes: 60,
    priority: 'korkea', schedulingState: 'manual'
  };
  const roundTripped = fromRow(toRow(task, TASK_COLUMNS_EXTENDED));
  assert.equal(roundTripped.description, 'Elokuun laskut');
  assert.equal(roundTripped.durationMinutes, 60);
  assert.equal(roundTripped.priority, 'korkea');
  assert.equal(roundTripped.schedulingState, 'manual');
});

test('SKEEMAPORTTI: perussarakkeilla laajennetut kentät eivät päädy kantaan', () => {
  // Migraatiota 0002 ei ole ajettu tuotantoon. Jos nämä kentät lähtisivät
  // mukaan, jokainen kirjoitus epäonnistuisi olemattomaan sarakkeeseen.
  const row = toRow({
    id: 'm1', title: 'X', date: '2026-08-31',
    description: 'kuvaus', durationMinutes: 30, priority: 'korkea', schedulingState: 'auto'
  });
  for (const column of ['description', 'duration_minutes', 'priority', 'scheduling_state']) {
    assert.equal(column in row, false, 'sarake ' + column + ' ei saa olla mukana ennen migraatiota');
  }
});

test('fromRow ei tuo user_id:tä sovelluksen tilaan', () => {
  const task = fromRow({
    id: 'm1', date: '2026-08-31', time: null, end_time: null,
    title: 'X', category: 'muu', note: null, completed: false, is_wake: false,
    user_id: '11111111-1111-1111-1111-111111111111'
  });
  assert.equal('user_id' in task, false);
});

test('TURVA: assertClientSafe hylkää palvelimen omistamat kentät', () => {
  for (const field of SERVER_OWNED_FIELDS) {
    assert.throws(
      () => assertClientSafe({ id: 'm1', [field]: 'jotain' }),
      /Client ei saa asettaa kenttaa/,
      'kentän ' + field + ' pitäisi aiheuttaa poikkeus'
    );
  }
});

test('assertClientSafe päästää puhtaan rivin läpi muuttumattomana', () => {
  const row = toRow({ id: 'm1', date: '2026-08-31', title: 'OK', category: 'muu' });
  assert.equal(assertClientSafe(row), row);
});

test('assertClientSafe hyväksyy toRow:n tuotoksen aina', () => {
  // Ketju toRow -> assertClientSafe on juuri se, mitä index.html käyttää.
  assert.doesNotThrow(() => assertClientSafe(toRow({
    id: 'm1', date: '2026-08-31', time: '07:00', endTime: null,
    title: 'Työ', category: 'tyo', note: null, completed: false, isWake: true,
    user_id: 'ei-saa-vuotaa'
  })));
});

test('newTaskId tuottaa yksilöllisiä tunnisteita', () => {
  // 20 000 tunnistetta samassa silmukassa: aiempi neljän merkin satunnaisosa
  // olisi törmännyt käytännössä varmasti.
  const ids = new Set();
  for (let i = 0; i < 20000; i++) ids.add(newTaskId());
  assert.equal(ids.size, 20000, 'tunnisteiden pitää olla yksilöllisiä');
});

test('newTaskId ei törmää vanhojen seed-tunnisteiden kanssa', () => {
  const id = newTaskId();
  assert.match(id, /^m[0-9a-z]+$/, 'tunnisteen pitää olla turvallinen merkkijono');
  assert.equal(id.startsWith('seed'), false);
  assert.ok(id.length >= 17, 'liian lyhyt tunniste törmäisi: ' + id);
});
