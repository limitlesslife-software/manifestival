// Arjen E2E -valjas (tools/e2e/run-daily-life-e2e.mjs): K-porttitila,
// import map, kannan korvikkeen 0014-käytös, ajajan turvasäännöt ja
// PENDING_ON-mekanismi. Ajetaan tavallisella `node --test`illa ILMAN
// Chromea: selainajo (npm run e2e:daily-life) ei kuulu `npm test`iin, mutta
// sen rakennusosat ja turvasäännöt tarkistetaan joka ajolla.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { read } from './helpers/sources.mjs';
import { createFakeDatabase, createFakeSupabase, UNIQUE_CONSTRAINTS, FOREIGN_KEYS, TIME_COLUMNS }
  from '../tools/e2e/fakeSupabase.mjs';
import {
  GATE_MODES, resolveGateMode, patchSchemaGates, trainMatrix, harnessHtml, parseColumnGates, defaultGatesRef,
  DEFAULT_GATES_REF, K_GATES_REF_ENV, GATES_QUERY
} from '../tools/e2e/gates.mjs';
import { parseGates } from '../tools/release/state.mjs';
import { ALL_GATES, COLUMN_GATES, WAVES, cumulativeGates, expectedMatrix, waveIndex } from '../tools/release/waves.mjs';
import {
  DAILY_LIFE_TABLES, GROUPS, PENDING_ON, EXPECTED_CONSOLE_ERRORS, auditRequests, classifyResult, wednesdayTen, onPage,
  deferredCleanupScript
} from '../tools/e2e/run-daily-life-e2e.mjs';
import { pressKey, typeAndEnter, PAGE_HELPERS } from '../tools/e2e/cdp.mjs';
import {
  calendarEventsRepo, savedPlacesRepo, lifeSettingsRepo, sleepLogsRepo, commuteObservationsRepo
} from '../src/data/collectionsRepo.js';

const RUNNER = read('tools/e2e/run-daily-life-e2e.mjs');
const SUUNTA_RUNNER = read('tools/e2e/run-suunta-e2e.mjs');
const HARNESS = read('tools/e2e/harness.mjs');
const PAGE = read('tools/e2e/suunta-harness.html');
const SCHEMA = read('src/data/schema.js');
const WAVE_K = WAVES.find(wave => wave.id === 'K');
/** Aallon K portit: kaikki aaltojen A–K portit auki, myöhemmät (L, 0015) kiinni. */
const OPEN_IN_K = new Set(cumulativeGates('K'));
const COLUMN_OPEN_IN_K = gate => waveIndex('K') >= waveIndex(COLUMN_GATES[gate]);

// ------------------------------------------------------------ K-porttitila

test('K-porttitila: GATE_MODES = closed, J, K; tuntematon tila hylätään', () => {
  assert.deepEqual([...GATE_MODES], ['closed', 'J', 'K']);
  assert.throws(() => resolveGateMode('L', { schemaSource: SCHEMA }), /Tuntematon porttitila: L/);
});

test('K-porttitila: junan määrittely avaa aallon K kymmenen porttia ja kaikki aiemmat, K:hon mennessä avautuvat sarakeportit', () => {
  const matrix = trainMatrix('K');
  assert.deepEqual(matrix.tables, { ...expectedMatrix('K') });
  for (const gate of ALL_GATES) assert.equal(matrix.tables[gate], OPEN_IN_K.has(gate), gate);
  for (const gate of Object.keys(COLUMN_GATES)) assert.equal(matrix.columns[gate], COLUMN_OPEN_IN_K(gate), gate);
  // Aallon L portit (0015) pysyvät K-tilassa kiinni.
  assert.equal(matrix.tables.protectedPeriods, false);
  assert.equal(matrix.columns.MENTAL_LOAD_FIELDS, false);
  assert.deepEqual([...WAVE_K.gates], ['savedPlaces', 'placeAliases', 'calendarEvents', 'commuteObservations', 'lifeSettings',
    'sleepLogs', 'habitPlans', 'habitEvents', 'exerciseSessions', 'wellbeingCheckins']);
  // J ei avaa yhtäkään K:n portista: K-tila on todella eri tila.
  for (const gate of WAVE_K.gates) assert.equal(trainMatrix('J').tables[gate], false, gate);
});

test('K-porttitila: ilman K-ehdokasta portit tulevat junan määrittelystä, ja lähde sanotaan', () => {
  const resolved = resolveGateMode('K', { cwd: '.', schemaSource: SCHEMA, ref: null,
    show: () => { throw new Error('ei saa lukea gitistä ilman refiä'); } });
  assert.equal(resolved.mode, 'K');
  assert.equal(resolved.fromTrain, true);
  assert.match(resolved.provenance, /junan määrittely tools\/release\/waves\.mjs/);
  assert.match(resolved.provenance, /aallon K ehdokasta ei ole/);
  assert.match(resolved.provenance, /trainMatrix\('K'\)/);
  const tables = parseGates(resolved.source);
  for (const gate of ALL_GATES) assert.equal(tables[gate], OPEN_IN_K.has(gate), gate);
  for (const [gate, open] of Object.entries(parseColumnGates(resolved.source))) {
    assert.equal(open, COLUMN_OPEN_IN_K(gate), `sarakeportti ${gate}`);
  }
  // Ajonaikainen skeemakerros säilyy, vain porttiliteraalit muuttuvat.
  for (const name of ['export function isTableAvailable', 'export function columnGateOpen', 'export const SCHEMA_REQUIREMENTS',
    'export function writeRefusal']) {
    assert.ok(resolved.source.includes(name), name);
  }
  const changed = resolved.source.split('\n').filter((line, i) => line !== SCHEMA.split('\n')[i]);
  // Haaran oma schema.js voi jo olla aallossa K (aaltocommit, kaikki portit
  // auki): silloin muutettavaa ei ole, ja lähde on haaran tiedosto sellaisenaan.
  const branchAtK = ALL_GATES.every(gate => parseGates(SCHEMA)[gate] === OPEN_IN_K.has(gate))
    && Object.entries(parseColumnGates(SCHEMA)).every(([gate, open]) => open === COLUMN_OPEN_IN_K(gate));
  if (branchAtK) assert.equal(resolved.source, SCHEMA, 'K-haaran lähdettä muutettiin');
  else assert.ok(changed.length > 0, 'K-tila ei avannut yhtään porttia');
  assert.ok(changed.every(line => /:\s*true,?\s*$|^export const [A-Z_]+ = true;/.test(line.trim())), changed.join('\n'));
});

test('K-porttitila: oletusref on tyhjä (ei ehdokasta); E2E_K_GATES_REF ottaa ehdokkaan käyttöön; J:n oletus ennallaan', () => {
  assert.equal(K_GATES_REF_ENV, 'E2E_K_GATES_REF');
  assert.equal(defaultGatesRef('K', {}), null);
  assert.equal(defaultGatesRef('K', { E2E_K_GATES_REF: 'rehearsal/wave-k-v1', E2E_GATES_REF: 'j-ref' }), 'rehearsal/wave-k-v1');
  assert.equal(defaultGatesRef('J', {}), DEFAULT_GATES_REF);
  assert.equal(defaultGatesRef('J', { E2E_GATES_REF: 'oma' }), 'oma');
  assert.equal(defaultGatesRef('J', { E2E_K_GATES_REF: 'k' }), DEFAULT_GATES_REF, 'K:n muuttuja ei vaikuta J:hin');
});

test('K-porttitila: leikattu K-ehdokas luetaan ja verrataan junaan; väärän aallon ehdokas keskeyttää', () => {
  const kSource = patchSchemaGates(SCHEMA, trainMatrix('K'));
  const ok = resolveGateMode('K', { cwd: '.', schemaSource: SCHEMA, ref: 'rehearsal/wave-k-v1', show: () => kSource, sha: () => 'k123abc' });
  assert.equal(ok.fromTrain, false);
  assert.match(ok.provenance, /rehearsal\/wave-k-v1 \(k123abc\)/);
  const jSource = patchSchemaGates(SCHEMA, trainMatrix('J'));
  assert.throws(() => resolveGateMode('K', { cwd: '.', schemaSource: SCHEMA, ref: 'x', show: () => jSource, sha: () => 'x' }),
    /x ei vastaa junan aaltoa K: savedPlaces/);
  const missing = resolveGateMode('K', { cwd: '.', schemaSource: SCHEMA, ref: 'puuttuu', show: () => { throw new Error('unknown revision'); } });
  assert.equal(missing.fromTrain, true);
  assert.match(missing.provenance, /ref puuttuu puuttuu/);
});

test('J- ja suljettu tila ennallaan: samat lähteet, viestit ja lähdetiedosto', () => {
  const jSource = patchSchemaGates(SCHEMA, trainMatrix('J'));
  const ok = resolveGateMode('J', { cwd: '.', ref: DEFAULT_GATES_REF, schemaSource: SCHEMA, show: () => jSource, sha: () => 'abc1234' });
  assert.equal(ok.provenance, 'rehearsal/wave-j-v2 (abc1234), porttiliteraalit haaran schema.js:ään');
  assert.equal(ok.source, jSource);
  const missing = resolveGateMode('J', { cwd: '.', ref: DEFAULT_GATES_REF, schemaSource: SCHEMA, show: () => { throw new Error('x'); } });
  assert.equal(missing.provenance, 'junan määrittely tools/release/waves.mjs (ref rehearsal/wave-j-v2 puuttuu)');
  assert.equal(missing.source, jSource);
  const kCandidate = patchSchemaGates(SCHEMA, trainMatrix('K'));
  assert.throws(() => resolveGateMode('J', { cwd: '.', ref: 'r', schemaSource: SCHEMA, show: () => kCandidate, sha: () => 'r' }),
    /r ei vastaa junan aaltoa J: savedPlaces/);
  const closed = resolveGateMode('closed', { schemaSource: SCHEMA });
  assert.equal(closed.source, null);
  assert.equal(closed.provenance, 'haaran oma src/data/schema.js');
});

// ------------------------------------------------------------ import map

function importMapOf(html) {
  const match = /<script type="importmap">([^<]+)<\/script>/.exec(html);
  return match ? JSON.parse(match[1]) : null;
}

test('harnessHtml: K-tilassa import map ohjaa schema.js:n K-porttiseen versioon ennen moduuleja', () => {
  const html = harnessHtml(PAGE, 'K');
  assert.deepEqual(importMapOf(html), { imports: { '/src/data/schema.js': `/src/data/schema.js?${GATES_QUERY}=K` } });
  assert.ok(html.indexOf('importmap') < html.indexOf('/tools/e2e/harness.mjs'));
  assert.equal(html.match(/importmap/g).length, 1);
});

test('harnessHtml: J-tila tavu tavulta ennallaan; suljettu ja tuntematon tila saavat sivun sellaisenaan', () => {
  const legacyJ = PAGE.replace('<script type="module"',
    '<script type="importmap">{"imports":{"/src/data/schema.js":"/src/data/schema.js?e2e-gates=J"}}</script>\n<script type="module"');
  assert.equal(harnessHtml(PAGE, 'J'), legacyJ);
  for (const mode of ['closed', null, undefined, '', 'L', 'k']) assert.equal(harnessHtml(PAGE, mode), PAGE, String(mode));
});

test('valjas todentaa K-porttien voimaantulon; ajaja tarjoilee vain ratkaistut porttitilat', () => {
  assert.match(HARNESS, /gates\.mode === 'K'/);
  assert.match(HARNESS, /K-portit eivät tulleet voimaan \(import map\)/);
  assert.match(RUNNER, /if \(!gatedSchemas\[gated\]\) \{ res\.writeHead\(404\)/, 'ei hiljaista varapolkua haaran portteihin');
  assert.match(RUNNER, /resolveGateMode\(mode, \{ cwd: ROOT, schemaSource \}\)/);
  assert.match(RUNNER, /LÄHDE: junan määrittely/);
});

// ------------------------------------------------------------ kannan korvike: 0014

const A = { user: { id: 'aaaaaaaa-0000-4000-8000-00000000000a', email: 'a@example.invalid' } };
const B = { user: { id: 'bbbbbbbb-0000-4000-8000-00000000000b', email: 'b@example.invalid' } };
const clientFor = (database, session) => createFakeSupabase({ database, session, latencyMs: 0 });

test('korvike: jokainen 0014:n taulu tallentaa, lukee, päivittää ja poistaa rivit (RLS kuten muualla)', async () => {
  assert.equal(DAILY_LIFE_TABLES.length, 10);
  assert.deepEqual([...DAILY_LIFE_TABLES], [...WAVE_K.tables]);
  const database = createFakeDatabase();
  const a = clientFor(database, A);
  const b = clientFor(database, B);
  const parents = { saved_places: 'p1', habit_plans: 'h1' };
  await a.from('saved_places').insert({ id: parents.saved_places, name: 'Koti' });
  await a.from('habit_plans').insert({ id: parents.habit_plans, name: 'Tapa' });
  const payload = {
    place_aliases: { place_id: 'p1', alias: 'kotona' }, calendar_events: { title: 'Meno', event_date: '2026-09-23' },
    commute_observations: { place_id: 'p1', observed_on: '2026-09-23', weekday: 3 }, life_settings: { guidance_style: 'napakka' },
    sleep_logs: { wake_date: '2026-09-23' }, habit_events: { plan_id: 'h1', action: 'use', occurred_at: '2026-09-23T08:00:00Z' },
    exercise_sessions: { session_date: '2026-09-23', kind: 'Juoksu' }, wellbeing_checkins: { date: '2026-09-23', motivation: 4 }
  };
  for (const table of DAILY_LIFE_TABLES) {
    if (parents[table]) continue;
    const id = `${table}-1`;
    assert.equal((await a.from(table).insert({ id, ...payload[table] })).error, null, table);
    const own = await a.from(table).select('*').eq('user_id', A.user.id);
    assert.deepEqual(own.data.map(row => row.id), [id], table);
    assert.deepEqual((await b.from(table).select('*').eq('user_id', B.user.id)).data, [], `${table}: toinen käyttäjä ei näe`);
    const updated = await a.from(table).update({ note: 'x' }).eq('user_id', A.user.id).eq('id', id).select('id');
    assert.deepEqual(updated.data, [{ id }], table);
    assert.equal((await a.from(table).delete().eq('user_id', A.user.id).eq('id', id)).error, null, table);
    assert.deepEqual(database.rows(table), [], table);
  }
  assert.deepEqual(a.unsupported(), []);
});

test('korvike: 0014:n time-sarakkeet palautuvat muodossa HH:MM:SS; muiden taulujen arvot ennallaan', async () => {
  assert.deepEqual(TIME_COLUMNS.calendar_events, ['start_time', 'end_time']);
  const database = createFakeDatabase();
  const a = clientFor(database, A);
  await a.from('calendar_events').insert({ id: 'e1', title: 'Meno', event_date: '2026-09-23', start_time: '15:00', end_time: null });
  await a.from('calendar_events').update({ end_time: '16:30' }).eq('id', 'e1');
  const [event] = (await a.from('calendar_events').select('*').eq('id', 'e1')).data;
  assert.equal(event.start_time, '15:00:00');
  assert.equal(event.end_time, '16:30:00');
  await a.from('life_settings').insert({ id: 's1', bedtime_target: '22:45', digest_time: '18:00' });
  assert.deepEqual(['bedtime_target', 'digest_time'].map(key => database.rows('life_settings')[0][key]), ['22:45:00', '18:00:00']);
  await a.from('sleep_logs').insert({ id: 'l1', wake_date: '2026-09-23', actual_bedtime: '23:15', actual_wake: '06:40:00' });
  assert.deepEqual([database.rows('sleep_logs')[0].actual_bedtime, database.rows('sleep_logs')[0].actual_wake], ['23:15:00', '06:40:00']);
  await a.from('tasks').insert({ id: 't1', title: 'Tehtävä', time: '15:00' });
  assert.equal(database.rows('tasks')[0].time, '15:00', 'vanhat taulut ennallaan (Suunta E2E)');
});

test('korvike: sovelluksen rivimuunnokset kulkevat kannan muodon läpi (15:00 -> 15:00:00 -> 15:00)', async () => {
  const database = createFakeDatabase();
  const a = clientFor(database, A);
  const { toRow, fromRow, normalize } = calendarEventsRepo.mapping;
  const event = normalize({ id: 'e1', title: 'Hammaslääkäri', date: '2026-09-23', startTime: '15:00', durationMinutes: 45,
    travelMinutes: 30, recurrenceWeekdays: [3], skipDates: ['2026-09-30'] });
  assert.equal((await a.from('calendar_events').insert(toRow(event))).error, null);
  const [row] = (await a.from('calendar_events').select('*').eq('user_id', A.user.id)).data;
  assert.equal(row.start_time, '15:00:00');
  const back = fromRow(row);
  assert.equal(back.startTime, '15:00');
  assert.deepEqual(back.recurrenceWeekdays, [3]);
  assert.deepEqual(back.skipDates, ['2026-09-30']);
  const settings = lifeSettingsRepo.mapping;
  await a.from('life_settings').insert(settings.toRow(settings.normalize({ id: 's1', bedtimeTarget: '22:45' })));
  assert.equal(settings.fromRow(database.rows('life_settings')[0]).bedtimeTarget, '22:45');
  const sleep = sleepLogsRepo.mapping;
  await a.from('sleep_logs').insert(sleep.toRow(sleep.normalize({ id: 'l1', wakeDate: '2026-09-23', actualBedtime: '23:15', actualWake: '06:40' })));
  const log = sleep.fromRow(database.rows('sleep_logs')[0]);
  assert.deepEqual([log.actualBedtime, log.actualWake], ['23:15', '06:40']);
  const commute = commuteObservationsRepo.mapping;
  await a.from('saved_places').insert(savedPlacesRepo.mapping.toRow(savedPlacesRepo.mapping.normalize({ id: 'p1', name: 'Koti' })));
  await a.from('commute_observations').insert(commute.toRow(commute.normalize({ id: 'o1', placeId: 'p1', observedOn: '2026-09-23',
    weekday: 3, actualDeparture: '07:10', travelMinutes: 25 })));
  assert.equal(commute.fromRow(database.rows('commute_observations')[0]).actualDeparture, '07:10');
});

test('korvike: 0014:n uniikkirajoitteet (nimi kirjainkoosta riippumatta, yksi asetusrivi, päivä kerran)', async () => {
  assert.deepEqual(UNIQUE_CONSTRAINTS.saved_places, [['saved_places_user_name_idx', ['user_id', 'lower(name)']]]);
  const database = createFakeDatabase();
  const a = clientFor(database, A);
  const b = clientFor(database, B);
  await a.from('saved_places').insert({ id: 'p1', name: 'Kuntosali' });
  const clash = await a.from('saved_places').insert({ id: 'p2', name: 'KUNTOSALI' });
  assert.equal(clash.error.code, '23505');
  assert.match(clash.error.message, /saved_places_user_name_idx/);
  assert.equal((await b.from('saved_places').insert({ id: 'p3', name: 'Kuntosali' })).error, null, 'eri käyttäjä saa saman nimen');
  assert.equal((await a.from('saved_places').update({ name: 'Sali' }).eq('id', 'p1').select('id')).error, null);
  assert.equal((await a.from('saved_places').insert({ id: 'p4', name: 'kuntosali' })).error, null, 'vapautunut nimi kelpaa');
  await a.from('life_settings').insert({ id: 's1' });
  assert.match((await a.from('life_settings').insert({ id: 's2' })).error.message, /life_settings_one_per_user/);
  await a.from('sleep_logs').insert({ id: 'l1', wake_date: '2026-09-23' });
  assert.match((await a.from('sleep_logs').insert({ id: 'l2', wake_date: '2026-09-23' })).error.message, /sleep_logs_wake_date_unique/);
  await a.from('wellbeing_checkins').insert({ id: 'c1', date: '2026-09-23' });
  assert.match((await a.from('wellbeing_checkins').insert({ id: 'c2', date: '2026-09-23' })).error.message, /wellbeing_checkins_date_unique/);
  await a.from('place_aliases').insert({ id: 'a1', place_id: 'p1', alias: 'sali' });
  assert.match((await a.from('place_aliases').insert({ id: 'a2', place_id: 'p1', alias: 'sali' })).error.message, /place_aliases_alias_unique/);
  assert.equal((await a.from('place_aliases').insert({ id: 'a3', place_id: 'p4', alias: 'sali' })).error, null, 'sama nimitys toiselle paikalle');
});

test('korvike: 0014:n viiteavaimet ja poistosäännöt (paikka, suunnitelma, tavoite)', async () => {
  assert.deepEqual(FOREIGN_KEYS.calendar_events, { place_id: ['saved_places', 'set null'], goal_id: ['goals', 'set null'] });
  const database = createFakeDatabase();
  const a = clientFor(database, A);
  const orphan = await a.from('calendar_events').insert({ id: 'e0', title: 'x', event_date: '2026-09-23', place_id: 'ei-ole' });
  assert.equal(orphan.error.code, '23503');
  assert.equal((await a.from('habit_events').insert({ id: 'x', plan_id: 'ei-ole', action: 'use' })).error.code, '23503');
  await a.from('saved_places').insert({ id: 'p1', name: 'Koti' });
  await a.from('goals').insert({ id: 'g1', title: 'Juoksu' });
  await a.from('calendar_events').insert({ id: 'e1', title: 'Meno', event_date: '2026-09-23', place_id: 'p1', goal_id: 'g1' });
  await a.from('place_aliases').insert({ id: 'a1', place_id: 'p1', alias: 'kotona' });
  await a.from('commute_observations').insert({ id: 'o1', place_id: 'p1', observed_on: '2026-09-23', weekday: 3 });
  await a.from('exercise_sessions').insert({ id: 's1', session_date: '2026-09-23', kind: 'Juoksu', goal_id: 'g1' });
  await a.from('habit_plans').insert({ id: 'h1', name: 'Tapa' });
  await a.from('habit_events').insert({ id: 'he1', plan_id: 'h1', action: 'use' });
  await a.from('saved_places').delete().eq('id', 'p1');
  assert.equal(database.rows('calendar_events')[0].place_id, null, 'meno säilyy ilman paikkaa (set null)');
  assert.equal(database.rows('calendar_events')[0].goal_id, 'g1', 'vain paikan sarake nollautuu');
  assert.deepEqual(database.rows('place_aliases'), [], 'nimitykset poistuvat (cascade)');
  assert.deepEqual(database.rows('commute_observations'), [], 'havainnot poistuvat (cascade)');
  await a.from('goals').delete().eq('id', 'g1');
  assert.equal(database.rows('calendar_events')[0].goal_id, null);
  assert.equal(database.rows('exercise_sessions')[0].goal_id, null);
  await a.from('habit_plans').delete().eq('id', 'h1');
  assert.deepEqual(database.rows('habit_events'), [], 'suunnitelman poisto vie kirjaukset');
});

// ------------------------------------------------------------ ajajan turvasäännöt

test('arjen E2E: tuotanto estetään DNS-tasolla, jokainen pyyntö kirjataan ja tarkistetaan', () => {
  assert.match(RUNNER, /--host-resolver-rules=MAP \*\.supabase\.co ~NOTFOUND, MAP supabase\.co ~NOTFOUND, MAP \*\.anthropic\.com ~NOTFOUND/);
  assert.match(RUNNER, /MAP www\.google\.com ~NOTFOUND/, 'Avaa reitti -linkin kohde estetty varmuuden vuoksi');
  assert.match(RUNNER, /Network\.requestWillBeSent/);
  assert.match(RUNNER, /Network\.loadingFailed/);
  assert.match(RUNNER, /const PRODUCTION = \/supabase\\\.co\|anthropic\\\.com\//);
  assert.match(RUNNER, /ei yhtään pyyntöä tuotantoon/);
  assert.match(RUNNER, /ei yhtään ulkoista pyyntöä/);
  assert.equal(/data-cal-route[^\n]*\.click\(\)/.test(RUNNER), false, 'reittilinkkiä ei avata');
});

test('arjen E2E: debug-portti todennetaan vapaaksi; profiili tmp/:ssä ja sen poisto on tulosrivi', () => {
  assert.match(RUNNER, /if \(await cdpReachable\(debugPort\)\) throw/);
  assert.match(RUNNER, /--user-data-dir=\$\{profile\}/);
  assert.match(RUNNER, /path\.join\(ROOT, 'tmp', `e2e-daily-chrome-/);
  assert.match(RUNNER, /fs\.rmSync\(profile/);
  assert.match(RUNNER, /väliaikainen Chrome-profiili poistettu/);
  // Oma selain lapsiprosesseineen suljetaan (vain oma pid), jotta ne eivät lukitse profiilia.
  assert.match(RUNNER, /spawnSync\('taskkill', \['\/PID', String\(browser\.pid\), '\/T', '\/F'\]/);
  assert.equal(/taskkill[^\n]*\/IM/.test(RUNNER), false, 'ei koskaan nimellä (vieraat Chromet)');
  // Jälkeen jääneet omat prosessit tunnistetaan ajon yksilöllisestä profiilihakemistosta.
  assert.match(RUNNER, /const name = path\.basename\(profile\)/);
  assert.match(RUNNER, /CommandLine -like '\*\$\{name\}\*'/);
  // Irrallinen siivoaja koskee vain tämän ajon profiilia projektin tmp/:ssä.
  assert.match(RUNNER, /path\.dirname\(profile\) === path\.join\(ROOT, 'tmp'\) && \/\^e2e-daily-chrome-\\d\+-\\d\+\$\/\.test/);
  assert.match(RUNNER, /browser\.exitCode !== null/, 'oma Chrome ei sammunut ennen yhteyttä');
  assert.match(RUNNER, /Page\.reload/);
  assert.match(RUNNER, /Input\.insertText/);
  assert.match(read('tools/e2e/cdp.mjs'), /Input\.dispatchKeyEvent/);
});

test('arjen E2E: irrallinen siivoaja poistaa vain annetun profiilin ja lopettaa 15 minuutin jälkeen', () => {
  const target = 'C:\\repo\\tmp\\e2e-daily-chrome-1-2';
  const script = deferredCleanupScript(target);
  assert.match(script, /const target = "C:\\\\repo\\\\tmp\\\\e2e-daily-chrome-1-2";/);
  assert.match(script, /fs\.rmSync\(target, \{ recursive: true, force: true \}\)/);
  assert.match(script, /15 \* 60 \* 1000/);
  assert.equal((script.match(/rmSync\(/g) || []).length, 1, 'yksi poistokohde');
  assert.doesNotThrow(() => new Function('require', script), 'kelvollista JavaScriptiä');
});

test('arjen E2E: pyyntöjen tarkastus erottaa tuotannon, ulkoiset ja DNS-estetyt', () => {
  const audit = auditRequests([
    'http://127.0.0.1:5000/', 'http://127.0.0.1:5000/src/app/main.js', 'data:image/png;base64,xx', 'about:blank',
    'https://abc.supabase.co/rest/v1/tasks', 'https://api.anthropic.com/v1/messages', 'https://www.google.com/maps/dir/?api=1'
  ], [{ url: 'https://abc.supabase.co/rest/v1/tasks', errorText: 'net::ERR_NAME_NOT_RESOLVED' }, { url: 'x', errorText: 'net::ERR_ABORTED' }]);
  assert.equal(audit.total, 7);
  assert.deepEqual(audit.production, ['https://abc.supabase.co/rest/v1/tasks', 'https://api.anthropic.com/v1/messages']);
  assert.deepEqual(audit.external, ['https://abc.supabase.co/rest/v1/tasks', 'https://api.anthropic.com/v1/messages',
    'https://www.google.com/maps/dir/?api=1']);
  assert.deepEqual(audit.blocked, ['https://abc.supabase.co/rest/v1/tasks']);
  assert.deepEqual(auditRequests(['http://127.0.0.1:1/'], []), { total: 1, production: [], external: [], blocked: [] });
});

test('arjen E2E: PENDING_ON — merkitty epäonnistuminen odottaa, merkitty onnistuminen kaataa', () => {
  assert.equal(classifyResult({ ok: true }), 'PASS');
  assert.equal(classifyResult({ ok: false }), 'FAIL');
  assert.equal(classifyResult({ ok: false, pendingOn: 'vika' }), 'ODOTTAA');
  assert.equal(classifyResult({ ok: true, pendingOn: 'vika' }), 'FAIL');
  assert.equal(classifyResult({ ok: true, warn: true }), 'HUOM', 'onnistunut varauksin ei kaada ajoa');
  assert.equal(classifyResult({ ok: false, warn: true }), 'FAIL');
  assert.match(RUNNER, /poista PENDING_ON-merkintä/);
  const names = GROUPS.flatMap(group => group.scenarios.map(scenario => scenario.name));
  for (const [name, reason] of Object.entries(PENDING_ON)) {
    assert.ok(names.includes(name), `PENDING_ON viittaa olemattomaan skenaarioon: ${name}`);
    assert.match(reason, /SOVELLUSVIKA/);
    assert.match(reason, /src\/app\/[\w/]+\.js:\d+/, 'vian sijainti tiedosto:rivi');
  }
  assert.deepEqual(EXPECTED_CONSOLE_ERRORS, {}, 'yksikään arjen skenaario ei saa tuottaa konsolivirhettä');
});

test('arjen E2E: ryhmät closed ja K tyhjältä kannalta keskiviikkona klo 10; skenaariot kattavat pyydetyt polut', () => {
  assert.deepEqual(GROUPS.map(group => [group.key, group.query.gates, group.query.seed, group.query.onboarding]),
    [['closed', 'closed', 'empty', 'skip'], ['K', 'K', 'empty', 'skip']]);
  for (const group of GROUPS) assert.match(group.query.clock, /^\d{4}-\d{2}-\d{2}T10:00$/);
  const k = GROUPS.find(group => group.key === 'K').scenarios.map(scenario => scenario.name);
  for (const prefix of ['K/a kalenteri', 'K/b toistuva meno', 'K/c kuukausi', 'K/d meno paikalla ilman matka-aikaa',
    'K/i näppäimistö', 'K/e Profiili -> Arki', 'K/e ohjaustyyli', 'K/f Profiili -> Paikat', 'K/g Profiili -> Hyvinvointi',
    'K/g tapakirjaus', 'K/h Tänään']) {
    assert.ok(k.some(name => name.startsWith(prefix)), prefix);
  }
  const closed = GROUPS.find(group => group.key === 'closed').scenarios.map(scenario => scenario.name);
  assert.equal(closed.length, 3);
  assert.ok(closed.every(name => name.startsWith('suljetut portit:')));
  // Jokainen K-skenaario kulkee oikean uudelleenlatauksen kautta, ja kannan rivit todennetaan.
  for (const scenario of GROUPS.find(group => group.key === 'K').scenarios) {
    assert.match(scenario.run.toString(), /await reload\(\);/, scenario.name);
  }
  const source = RUNNER.slice(RUNNER.indexOf('const K_SCENARIOS'), RUNNER.indexOf('export const PENDING_ON'));
  assert.match(source, /H\.db\('calendar_events'\)/);
  assert.match(source, /H\.db\('wellbeing_checkins'\)/);
  assert.match(source, /H\.db\('habit_events'\)/);
});

test('arjen E2E: keskiviikon kello ja sivufunktion sarjallistus', () => {
  for (const day of ['2026-09-21', '2026-09-23', '2026-09-27']) {
    const clock = wednesdayTen(new Date(`${day}T15:00`));
    assert.equal(clock, '2026-09-23T10:00', day);
  }
  assert.equal(new Date(`${wednesdayTen(new Date('2026-12-31T08:00'))}`).getDay(), 3);
  assert.equal(onPage(arg => arg.a + 1, { a: 1 }), '(arg => arg.a + 1)({"a":1})');
  assert.equal(onPage(() => 1), '(() => 1)(null)');
});

test('arjen E2E: ajon käynnistys on suojattu (import ei avaa selainta); npm-skripti on olemassa', () => {
  assert.match(RUNNER, /if \(process\.argv\[1\] && path\.resolve\(process\.argv\[1\]\) === fileURLToPath\(import\.meta\.url\)\)/);
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.scripts['e2e:daily-life'], 'node tools/e2e/run-daily-life-e2e.mjs');
  assert.equal(pkg.scripts['e2e:suunta'], 'node tools/e2e/run-suunta-e2e.mjs');
});

// ------------------------------------------------------------ yhteiset CDP-apurit

function recordingCdp() {
  const calls = [];
  return { calls, send: async (method, params) => { calls.push([method, params]); return {}; } };
}

test('cdp.mjs: oikeat näppäilyt (keyDown/keyUp) Tab, Escape, nuolet, Home, End ja Enter; tuntematon näppäin hylätään', async () => {
  const cdp = recordingCdp();
  await pressKey(cdp, 'Tab');
  await pressKey(cdp, 'Tab', { shift: true });
  await pressKey(cdp, 'Enter');
  await pressKey(cdp, 'Escape');
  assert.deepEqual(cdp.calls.map(([method, params]) => [method, params.type, params.key, params.windowsVirtualKeyCode, params.modifiers]), [
    ['Input.dispatchKeyEvent', 'rawKeyDown', 'Tab', 9, 0], ['Input.dispatchKeyEvent', 'keyUp', 'Tab', 9, 0],
    ['Input.dispatchKeyEvent', 'rawKeyDown', 'Tab', 9, 8], ['Input.dispatchKeyEvent', 'keyUp', 'Tab', 9, 8],
    ['Input.dispatchKeyEvent', 'keyDown', 'Enter', 13, 0], ['Input.dispatchKeyEvent', 'keyUp', 'Enter', 13, 0],
    ['Input.dispatchKeyEvent', 'rawKeyDown', 'Escape', 27, 0], ['Input.dispatchKeyEvent', 'keyUp', 'Escape', 27, 0]
  ]);
  assert.equal(cdp.calls[4][1].text, '\r', 'Enter lähettää merkin (lomake / painike aktivoituu)');
  for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']) await pressKey(recordingCdp(), key);
  await assert.rejects(() => pressKey(recordingCdp(), 'F13'), /tuntematon näppäin/);
  const typed = recordingCdp();
  await typeAndEnter(typed, '25');
  assert.deepEqual(typed.calls.map(([method]) => method), ['Input.insertText', 'Input.dispatchKeyEvent', 'Input.dispatchKeyEvent']);
});

test('cdp.mjs: Suunta E2E käyttää samoja apureita (siirretty sellaisenaan) ja pitää oman Enter-näppäilynsä', () => {
  assert.match(SUUNTA_RUNNER, /import \{ CHROME_CANDIDATES, MIME, freePort, cdpReachable, Cdp, PAGE_HELPERS as HELPERS \} from '\.\/cdp\.mjs';/);
  assert.equal(/^class Cdp|^const HELPERS = `/m.test(SUUNTA_RUNNER), false, 'ei kahta kopiota');
  assert.match(PAGE_HELPERS, /^window\.H = \{/m);
  assert.match(PAGE_HELPERS, /idle: \(sel, label\) =>/);
  assert.match(RUNNER, /await evaluate\(PAGE_HELPERS\);\s*await evaluate\(DAILY_HELPERS\);/);
});
