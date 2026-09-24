// Aktivoinnin inventaario, esitarkistukset 0009–0013 ja pisteytys.
//
// Oikean kannan todiste on tools/pg-rehearsal (inventaario ja jokainen
// esitarkistus jokaisessa junan tilassa, READ ONLY -transaktiossa).
// Nämä testit vartioivat ilman kantaa sen, mikä voi rikkoutua koodissa:
//
//   1. generoidut SQL-tiedostot ovat ajan tasalla generaattorin kanssa
//      (tunnistuslistat poimitaan migraatioista — käsin muokattu tiedosto
//      voisi erkaantua migraatiosta)
//   2. tiedostot ovat vain lukevia ja yksilauseisia (Supabasen editori
//      näyttää vain viimeisen tuloksen)
//   3. pisteytys tekee oikean päätöksen oikean kannan tuottamista
//      tuloksista (tests/fixtures/activation-inventory, generoitu
//      harjoittelusta: node tools/pg-rehearsal/rehearse.mjs
//      --only=inventory --fixtures=tests/fixtures/activation-inventory)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { ROOT, read } from './helpers/sources.mjs';
import { buildInventorySql } from '../tools/activation/build-inventory.mjs';
import { buildPreflight, PREFLIGHT_NUMBERS } from '../tools/activation/build-preflights.mjs';
import { parseInventory, scoreInventory } from '../tools/activation/score-inventory.mjs';

const lf = text => text.replace(/\r\n/g, '\n');
const INVENTORY = 'supabase/acceptance/activation_readonly_inventory.sql';
const FIXTURES = path.join(ROOT, 'tests/fixtures/activation-inventory');
const fixture = name => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

/** Koodi ilman kommentteja ja merkkijonoliteraaleja. */
function code(sql) {
  return sql.split('\n').filter(l => !l.trim().startsWith('--')).join('\n')
    .replace(/\$q\$[\s\S]*?\$q\$/g, "''").replace(/'[^']*'/g, "''").toLowerCase();
}

test('KRIITTINEN: inventaario on ajan tasalla migraatioiden kanssa', () => {
  assert.equal(lf(read(INVENTORY)), buildInventorySql(),
    'aja: node tools/activation/build-inventory.mjs');
});

test('KRIITTINEN: esitarkistukset 0009–0013 ovat ajan tasalla migraatioiden kanssa', () => {
  for (const n of PREFLIGHT_NUMBERS) {
    assert.equal(lf(read(`supabase/preflight/preflight_${n}.sql`)), buildPreflight(n),
      `preflight_${n}.sql: aja node tools/activation/build-preflights.mjs`);
  }
});

test('KRIITTINEN: inventaario ja esitarkistukset ovat vain lukevia ja yksilauseisia', () => {
  const files = [INVENTORY, ...PREFLIGHT_NUMBERS.map(n => `supabase/preflight/preflight_${n}.sql`)];
  for (const file of files) {
    const c = code(read(file));
    assert.equal(/\b(insert|update|delete|drop|alter|create|grant|revoke|truncate|comment|lock|vacuum|call|do)\b/.test(c),
      false, `${file}: kirjoittava lause`);
    assert.equal(c.trim().replace(/;\s*$/, '').includes(';'), false, `${file}: useampi lause`);
  }
});

test('inventaario ei lue käyttäjän sisältöä (nimet, muistiinpanot, pohdinnat, summat)', () => {
  const c = code(read(INVENTORY));
  // 'text' (inbox_items.text) jätetään pois: sana on myös tyyppimuunnos ::text.
  for (const column of ['title', 'name', 'note', 'description', 'reflection', 'snapshot',
    'email', 'amount_minor', 'iban', 'payee', 'place', 'destination']) {
    assert.equal(new RegExp(`select[^;]*\\b${column}\\b`).test(c.replace(/column_name\s*=\s*''/g, '')),
      false, `lukee saraketta ${column}`);
  }
});

test('KRIITTINEN: tuotannon nykytila (0008): GO, seuraava 0009 / aalto F', () => {
  const result = scoreInventory(parseInventory(fixture('state-0008.json')));
  assert.equal(result.decision, 'GO');
  assert.equal(result.nextMigration, '0009');
  assert.equal(result.nextWave, 'F');
  assert.match(result.nextAction, /aallot D ja E on deployattu ja hyväksytty/);
});

test('jokainen junan tila johtaa seuraavaan migraatioon', () => {
  const expected = { '0009': '0010', '0010': '0011', '0011': '0012', '0012': '0013', '0013': null };
  for (const [state, next] of Object.entries(expected)) {
    const result = scoreInventory(parseInventory(fixture(`state-${state}.json`)));
    assert.equal(result.decision, 'GO', `tila ${state}: ${result.stops.join('; ')}`);
    assert.equal(result.nextMigration, next, `tila ${state}`);
  }
});

test('KRIITTINEN: keskeneräinen migraatio pysäyttää', () => {
  const result = scoreInventory(parseInventory(fixture('state-0011-partial-0012.json')));
  assert.equal(result.decision, 'STOP');
  assert.equal(result.facts.migrations['0012'], 'partial');
  assert.ok(result.stops.some(s => /0012 on KESKEN/.test(s)));
});

test('KRIITTINEN: puuttuva omistaja (väärä projekti) pysäyttää', () => {
  const result = scoreInventory(parseInventory(fixture('state-0008-no-owner.json')));
  assert.equal(result.decision, 'STOP');
  assert.ok(result.stops.some(s => /omistajaa/.test(s)));
});

test('syöte kelpaa CSV-solusta (lainausmerkit tuplattu) ja taulukkona', () => {
  const cell = fixture('state-0010.json').trim();
  const csv = `nro,osio,tarkistus,arvo\n00,tiiviste,KOPIOI,"${cell.replace(/"/g, '""')}"\n`;
  assert.equal(scoreInventory(parseInventory(csv)).nextMigration, '0011');

  const rows = JSON.parse(cell).rows;
  const table = Object.entries(rows).map(([k, v]) => `${k}\tosio\ttarkistus\t${v}`).join('\n');
  assert.equal(scoreInventory(parseInventory(table)).nextMigration, '0011');
});

test('lukukelvoton syöte ei tuota päätöstä', () => {
  assert.equal(parseInventory('hei'), null);
  assert.equal(parseInventory(''), null);
});

test('turvapoikkeama pysäyttää vaikka migraatiot olisivat kunnossa', () => {
  const rows = { ...JSON.parse(fixture('state-0008.json')).rows, 51: '3' };
  const result = scoreInventory(rows);
  assert.equal(result.decision, 'STOP');
  assert.ok(result.stops.some(s => /anon/.test(s)));
});

test('avoin transaktio on varoitus, ei pysäytys', () => {
  const rows = { ...JSON.parse(fixture('state-0008.json')).rows, 45: '1' };
  const result = scoreInventory(rows);
  assert.equal(result.decision, 'GO');
  assert.ok(result.warnings.some(w => /idle in transaction/.test(w)));
});
