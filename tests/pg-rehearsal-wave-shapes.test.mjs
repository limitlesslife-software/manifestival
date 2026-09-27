// Taukopisteiden rivimuodot (tools/pg-rehearsal/waves.mjs) ILMAN palvelinta.
//
// prodshape:pause kirjoittaa kantaan sovelluksen OMILLA rivimuunnoksilla,
// jotka ladataan kunkin aallon sarakeporteilla (app-gate-hooks.mjs). Nämä
// testit todentavat, että lataus todella vaihtaa portit: jos koukku
// lakkaisi toimimasta, jokainen aalto lähettäisi HEADin muodon ja
// harjoittelu todistaisi väärää asiaa.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { read } from './helpers/sources.mjs';
import { PAUSES, trainWaves, shapeKeys, waveWrites } from '../tools/pg-rehearsal/waves.mjs';
import { patchSchemaSource, KNOWN_GATES } from '../tools/pg-rehearsal/app-gate-hooks.mjs';

const train = trainWaves();

/** src/data/collectionsRepo.js: jokaisen `...(GATE ? { ... } : {})` -lohkon avaimet tauluittain. */
function gateBlocks() {
  const src = read('src/data/collectionsRepo.js').replace(/\r\n/g, '\n');
  const out = [];
  for (const repo of src.split(/\nexport const \w+ = createRepository\(\{/).slice(1)) {
    const table = /table: '(\w+)'/.exec(repo)?.[1];
    const toRow = repo.slice(repo.indexOf('toRow:'), repo.indexOf('fromRow:'));
    for (const m of toRow.matchAll(/\.\.\.\((\w+)\s*\?\s*\{([\s\S]*?)\}\s*:\s*\{\}\)/g)) {
      const keys = [...m[2].matchAll(/(\w+):/g)].map(k => k[1]);
      out.push({ table, gate: m[1], keys });
    }
  }
  return out;
}

test('KRIITTINEN: jokainen sarakeportti lähtee rivimuotoon täsmälleen portin ollessa auki', async () => {
  const blocks = gateBlocks().filter(b => KNOWN_GATES.includes(b.gate));
  assert.ok(blocks.length >= 6, `porttilohkoja löytyi vain ${blocks.length}`);
  for (const wave of ['E', 'F', 'G', 'H', 'I', 'J', 'K']) {
    const keys = await shapeKeys(wave, train);
    for (const b of blocks) {
      if (!keys[b.table]) continue; // taulu ei ole auki tässä aallossa
      const on = train[wave].gates.includes(b.gate);
      for (const k of b.keys) {
        assert.equal(keys[b.table].includes(k), on,
          `aalto ${wave}, ${b.table}.${k}: portti ${b.gate} ${on ? 'auki' : 'kiinni'}`);
      }
    }
  }
});

test('aaltojen rivimuodot: laskun maksutiedot F:stä, suunnittelukentät G:stä, alue I:stä, 0013-sarakkeet J:stä', async () => {
  const E = await shapeKeys('E', train);
  const F = await shapeKeys('F', train);
  const G = await shapeKeys('G', train);
  const I = await shapeKeys('I', train);
  const J = await shapeKeys('J', train);
  assert.equal(E.bills.includes('iban'), false);
  assert.ok(F.bills.includes('iban') && F.bills.includes('payee') && F.bills.includes('reference'));
  assert.equal(F.goals.includes('metric'), false);
  assert.equal(F.tasks.includes('depends_on'), false, 'tehtävä lähettäisi depends_on ennen 0010:tä');
  assert.ok(G.goals.includes('metric') && G.tasks.includes('depends_on') && G.tasks.includes('milestone_id'));
  assert.ok(G.projects.includes('milestone_id'));
  assert.equal(G.goals.includes('life_area_id'), false);
  assert.ok(I.goals.includes('life_area_id'));
  assert.equal(I.time_entries.includes('operation_id'), false);
  assert.ok(J.time_entries.includes('operation_id') && J.time_entries.includes('started_at'));
  assert.ok(J.running_timers && J.alignment_item_settings);
  assert.equal(E.milestones, undefined, 'välitavoitteet eivät ole auki aallossa E');
  // Ylläpitotila vain portin ollessa auki (G+).
  const g = await waveWrites('G', { prefix: 't', train });
  assert.ok(g.some(o => o.table === 'goals' && o.payload?.status === 'maintenance'));
  const f = await waveWrites('F', { prefix: 't', train });
  assert.equal(f.some(o => o.payload?.status === 'maintenance'), false);
  // Ennen 0013:a ajastinkirjaus lähtee manual-lähteellä (0012 sallii vain sen).
  const i = await waveWrites('I', { prefix: 't', train });
  assert.equal(i.find(o => o.table === 'time_entries' && o.method === 'insert').payload.source, 'manual');
});

test('rivimuodoissa ei ole palvelimen omistamia kenttiä eikä undefined-arvoja', async () => {
  for (const wave of ['E', 'G', 'J', 'K']) {
    for (const op of await waveWrites(wave, { prefix: 't', train })) {
      if (!op.payload) continue;
      for (const k of ['user_id', 'created_at', 'updated_at']) assert.equal(k in op.payload, false, `${op.label}: ${k}`);
      assert.equal(Object.values(op.payload).includes(undefined), false, op.label);
      if (op.method === 'update' || op.method === 'delete') assert.ok(op.match && Object.keys(op.match).length, op.label);
    }
  }
});

test('taukopisteet vastaavat junaa: tauon jälkeen deployataan juuri sen migraation aalto', () => {
  assert.deepEqual(PAUSES.map(p => p.after), ['0008', '0009', '0010', '0011', '0012', '0013', '0014']);
  for (const p of PAUSES) {
    assert.ok(train[p.live], `elävä aalto ${p.live}`);
    if (!p.next) continue;
    assert.ok(String(train[p.next].migration).startsWith(p.after), `${p.after}: aallon ${p.next} migraatio on ${train[p.next].migration}`);
  }
  for (let i = 1; i < PAUSES.length; i++) {
    if (PAUSES[i - 1].next) assert.equal(PAUSES[i].live, PAUSES[i - 1].next, `${PAUSES[i].after}: elävä aalto`);
  }
});

const K_TABLES = ['saved_places', 'place_aliases', 'calendar_events', 'commute_observations', 'life_settings',
  'sleep_logs', 'habit_plans', 'habit_events', 'exercise_sessions', 'wellbeing_checkins'];

test('KRIITTINEN: aalto K luetaan lukosta (locked: true), ja muoto vastaa julkaisuaaltoja', async () => {
  const { cumulativeGates, WAVES } = await import('../tools/release/waves.mjs');
  // Lukitut C–K luetaan lukosta sellaisenaan; yhtäkään aaltoa ei johdeta.
  for (const w of ['C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K']) assert.equal(train[w].locked, true, w);
  assert.equal(Object.values(train).some(w => !w.locked), false, 'lukitsematon aalto junassa');
  assert.equal(train.K.migration, '0014_daily_life.sql');
  assert.deepEqual([...train.K.tables].sort(), [...cumulativeGates('K')].sort());
  // K = J:n taulut + 0014:n kymmenen porttia, EI uusia sarakeportteja.
  const kGates = WAVES.find(w => w.id === 'K').gates;
  assert.equal(kGates.length, 10);
  assert.deepEqual([...train.K.tables].sort(), [...train.J.tables, ...kGates].sort());
  assert.deepEqual(train.K.gates, train.J.gates);
  // Lukitun aallon johdettu muoto täsmää lukkoon (johtaminen on oikein).
  assert.deepEqual([...cumulativeGates('J')].sort(), [...train.J.tables].sort());
});

test('aallon K rivimuodot: kaikki kymmenen taulua sovelluksen omalla toRow:lla, J ei kirjoita niihin', async () => {
  const K = await shapeKeys('K', train);
  const J = await shapeKeys('J', train);
  for (const t of K_TABLES) {
    assert.ok(K[t], `aalto K ei kirjoita tauluun ${t}`);
    assert.equal(J[t], undefined, `aalto J kirjoittaisi tauluun ${t} ennen 0014:ää`);
  }
  // Sarakkeet ovat 0014:n sarakkeita (ei koordinaatteja, ei palvelimen kenttiä).
  assert.deepEqual(K.saved_places, ['address', 'area', 'arrival_buffer_minutes', 'id', 'name', 'note', 'overhead_minutes',
    'preparation_minutes', 'provider_place_id', 'travel_mode', 'use_learned', 'usual_travel_minutes']);
  assert.deepEqual(K.wellbeing_checkins, ['control', 'date', 'id', 'motivation']);
  assert.ok(K.calendar_events.includes('event_date') && K.calendar_events.includes('recurrence_weekdays'));
  assert.ok(K.exercise_sessions.includes('session_date') && K.exercise_sessions.includes('goal_id'));
  for (const [table, cols] of Object.entries(K)) {
    if (!K_TABLES.includes(table)) continue;
    for (const c of cols) assert.equal(/(^|_)(lat|lng|lon|latitude|longitude|geo|gps|coord|point)(_|$)/.test(c), false, `${table}.${c}`);
  }
  const ops = await waveWrites('K', { prefix: 't', train });
  // Vierasavainjärjestys: vanhempi ennen lasta.
  const first = t => ops.findIndex(o => o.table === t && o.method === 'insert');
  for (const [child, parent] of [['place_aliases', 'saved_places'], ['calendar_events', 'saved_places'],
    ['commute_observations', 'saved_places'], ['habit_events', 'habit_plans'], ['calendar_events', 'goals'],
    ['exercise_sessions', 'goals']]) {
    assert.ok(first(parent) !== -1 && first(parent) < first(child), `${parent} ennen ${child}`);
  }
  // Yksi asetusrivi: K kirjoittaa sen kerran (insert + update), ei toista.
  assert.equal(ops.filter(o => o.table === 'life_settings' && o.method === 'insert').length, 1);
  // Koko päivän meno lähtee ilman alkuaikaa (calendar_events_all_day_check).
  const allDay = ops.find(o => o.table === 'calendar_events' && o.payload?.all_day === true);
  assert.ok(allDay && allDay.payload.start_time === null && allDay.payload.end_time === null);
});

test('WAVE_INDEX: jokaisella junan aallolla oma järjestysnumero (uniikit päivät ja viikot)', async () => {
  const { WAVE_INDEX } = await import('../tools/pg-rehearsal/waves.mjs');
  assert.deepEqual(Object.keys(WAVE_INDEX), Object.keys(train));
  assert.equal(new Set(Object.values(WAVE_INDEX)).size, Object.keys(WAVE_INDEX).length);
  assert.equal(WAVE_INDEX.K, 8);
});

test('schema.js-korvaus: tuntematon tai puuttuva portti kaataa latauksen', () => {
  const src = read('src/data/schema.js');
  const patched = patchSchemaSource(src, ['GOAL_PLANNING_FIELDS']);
  assert.match(patched, /export const GOAL_PLANNING_FIELDS = true;/);
  assert.match(patched, /export const BILL_PAYMENT_FIELDS = false;/);
  assert.throws(() => patchSchemaSource(src.replace('export const GOAL_LIFE_AREA_FIELD', 'export const X'), []), /GOAL_LIFE_AREA_FIELD/);
});
