// Aalto I avaa elämänalueet ja pohdinnat: kannan virhetiedot toistavat
// rivin arvot (uniikkirikkomus, tarkistusrikkomus, 22P02-syöte). Ne eivät
// saa päätyä konsoliin. Sama suodatus kuin tuotehaaran src/lib/result.js:ssä.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AppError, logError, redactDbDetail, redactQuotedValues } from '../src/lib/result.js';

const SECRET = 'Terapia (oma';

function captureConsole(run) {
  const lines = [];
  const original = console.error;
  console.error = (...args) => { lines.push(args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); };
  try { run(); } finally { console.error = original; }
  return lines.join('\n');
}

test('redactDbDetail: arvot pois, rakenne säilyy (sisäkkäiset, parittomat ja monirivinen)', () => {
  assert.equal(redactDbDetail(`Key (user_id, name)=(u, ${SECRET}) already exists.`),
    'Key (user_id, name)=(…) already exists.');
  assert.equal(redactDbDetail('Key (life_area_id)=(x) is not present in table "life_areas".'),
    'Key (life_area_id)=(…) is not present in table "life_areas".');
  assert.equal(redactDbDetail('Failing row contains (a,\nsalainen pohdinta (kesken).'), 'Failing row contains (…).');
  assert.equal(redactDbDetail('Jotain muuta'), '[poistettu]');
  assert.equal(redactDbDetail(null), '');
  assert.equal(redactQuotedValues('invalid input syntax for type integer: "Salainen arvo"'),
    'invalid input syntax for type integer: "…"');
});

test('logError: AppError, PostgREST-olio ja merkkijonosyy eivät vie käyttäjän arvoja konsoliin', () => {
  const cause = {
    code: '23505',
    message: 'duplicate key value violates unique constraint "life_areas_user_name_key"',
    details: `Key (user_id, name)=(u, ${SECRET}) already exists.`,
    hint: null
  };
  const out = captureConsole(() => {
    logError(new AppError('Tallennus epäonnistui.', { cause, code: 'db' }));
    logError(cause);
    logError({ code: '22P02', message: `invalid input syntax for type integer: "${SECRET}"` });
    logError(new AppError('Tallennus epäonnistui.', { cause: `vapaa teksti ${SECRET}` }));
  });
  assert.doesNotMatch(out, /Terapia/);
  assert.match(out, /life_areas_user_name_key/, 'rajoitteen nimi säilyy diagnostiikkaa varten');
  assert.match(out, /23505/);
  assert.match(out, /\[teksti \d+ merkkiä\]/);
});
