// Varmistustiedostojen VÄÄRÄT HÄLYTYKSET.
//
// Varmistus, joka antaa FAIL-tuloksen ehjälle kannalle, on melkein yhtä
// vahingollinen kuin varmistus joka ei huomaa vikaa: se pysäyttää
// aallon tuotannossa, ja hyväksyjä joutuu arvioimaan, onko vika
// todellinen — juuri sitä päätöstä varmistuksen piti helpottaa.
//
// Löydetty oikealla PostgreSQL 17:llä (tools/pg-rehearsal): verify_0011:n
// tarkistus 12 etsi koordinaattisarakkeita säännöllisellä lausekkeella
// '(lat|lon|...)', joka osui sarakkeeseen reminders.escalate
// (esca-LAT-e). Ehjä 0011 olisi saanut tuotannossa yhden FAIL-rivin.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = rel => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

/** Tarkistuksen 12 säännöllinen lauseke verify_0011.sql:stä JS-muodossa. */
function coordinatePattern() {
  const sql = read('supabase/verify/verify_0011.sql');
  const block = sql.slice(sql.indexOf("select '12'"), sql.indexOf("select '13'"));
  const match = block.match(/column_name ~ '([^']+)'/);
  assert.ok(match, 'tarkistuksen 12 säännöllistä lauseketta ei löytynyt');
  // PostgreSQL:n ARE ja JS:n RegExp ovat tässä osajoukossa samat.
  return new RegExp(match[1]);
}

/** 0011:n luomien taulujen sarakenimet (create table -lohkoista). */
function columnsOf0011() {
  const sql = read('supabase/migrations/0011_personal_assistant.sql')
    .split('\n').filter(line => !line.trim().startsWith('--')).join('\n');
  const names = [];
  for (const block of sql.matchAll(/create table public\.(\w+) \(([\s\S]*?)\n\);/g)) {
    for (const line of block[2].split('\n')) {
      const m = line.match(/^\s+([a-z_]+)\s+(text|uuid|boolean|integer|smallint|date|time|timestamptz|jsonb)/);
      if (m) names.push(`${block[1]}.${m[1]}`);
    }
  }
  return names;
}

test('verify_0011 tarkistus 12 ei hälytä yhdestäkään 0011:n omasta sarakkeesta', () => {
  const pattern = coordinatePattern();
  const columns = columnsOf0011();
  assert.ok(columns.length > 40, `sarakkeita löytyi vain ${columns.length}`);
  assert.ok(columns.includes('reminders.escalate'), 'escalate-sarake puuttuu jäsennyksestä');
  const hits = columns.filter(c => pattern.test(c.split('.')[1]));
  assert.deepEqual(hits, [], `väärä hälytys: ${hits.join(', ')}`);
});

test('verify_0011 tarkistus 12 tunnistaa yhä oikeat koordinaattisarakkeet', () => {
  const pattern = coordinatePattern();
  for (const name of ['lat', 'lon', 'lng', 'latitude', 'longitude', 'geo', 'home_lat',
                      'dest_lon', 'geo_point', 'coords', 'gps_fix', 'sijainti', 'point']) {
    assert.ok(pattern.test(name), `ei tunnista: ${name}`);
  }
  for (const name of ['escalate', 'relation', 'translation', 'template', 'longer_note',
                      'category', 'geology_note_x'.replace('geology', 'ecology')]) {
    assert.equal(pattern.test(name), false, `väärä hälytys: ${name}`);
  }
});
