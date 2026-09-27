// Suunta E2E -valjas: turvasäännöt, skenaarioiden kattavuus, J-porttitila,
// vanhan käyttäjän siemen ja kannan korvike (staattinen ja Node-tarkistus).
//
// Selainajo (npm run e2e:suunta) ei kuulu `npm test`iin, koska se vaatii
// asennetun Chromen. Sen turvasäännöt ja rakennusosat tarkistetaan
// kuitenkin joka ajolla: jos joku poistaa DNS-eston tai porttitarkistuksen,
// vanhan käyttäjän skenaarion tai J-porttitilan, tämä kaatuu.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { read } from './helpers/sources.mjs';
import { createFakeDatabase, createFakeSupabase } from '../tools/e2e/fakeSupabase.mjs';
import { legacyUserSeed, mondayOf, addDays, LEGACY_COUNTS, LEGACY_USER_ID } from '../tools/e2e/seeds.mjs';
import {
  resolveGateMode, patchSchemaGates, trainMatrix, harnessHtml, parseColumnGates, DEFAULT_GATES_REF
} from '../tools/e2e/gates.mjs';
import { parseGates } from '../tools/release/state.mjs';
import { ALL_GATES, cumulativeGates } from '../tools/release/waves.mjs';

const RUNNER = read('tools/e2e/run-suunta-e2e.mjs');
const HARNESS = read('tools/e2e/harness.mjs');
const PAGE = read('tools/e2e/suunta-harness.html');
const SCHEMA = read('src/data/schema.js');
const noComments = source => source.replace(/^\s*\/\/.*$/gm, '');

test('E2E: tuotanto estetään DNS-tasolla ja jokainen pyyntö tarkistetaan', () => {
  assert.match(RUNNER, /--host-resolver-rules=MAP \*\.supabase\.co ~NOTFOUND/);
  assert.match(RUNNER, /MAP \*\.anthropic\.com ~NOTFOUND/);
  assert.match(RUNNER, /Network\.requestWillBeSent/);
  assert.match(RUNNER, /supabase\\\.co\|anthropic\\\.com/);
});

test('E2E: debug-portti todennetaan vapaaksi; vieraaseen Chromeen ei liitytä', () => {
  assert.match(RUNNER, /if \(await cdpReachable\(debugPort\)\) throw/);
  assert.match(RUNNER, /--user-data-dir=\$\{profile\}/);
  assert.match(RUNNER, /path\.join\(ROOT, 'tmp',/, 'profiili projektin tmp/-hakemistossa');
  assert.match(RUNNER, /fs\.rmSync\(profile/);
});

test('E2E: valjas käynnistää oikean main.js:n tekaistulla istunnolla; ei supabase-js:ää, ei tokenia, ei verkkoa', () => {
  const scripts = [...PAGE.matchAll(/<script[^>]*src="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(scripts, ['/tools/e2e/harness.mjs'], 'vain paikallinen valjas, ei CDN-skriptejä');
  for (const [name, source] of [['harness', HARNESS], ['fakeSupabase', read('tools/e2e/fakeSupabase.mjs')],
    ['seeds', read('tools/e2e/seeds.mjs')]]) {
    assert.equal(/https?:\/\//.test(noComments(source)), false, `${name} ei hae mitään ulkoa`);
  }
  assert.match(HARNESS, /client\.setClient\(fake\)/, 'kannan korvike ennen käynnistystä');
  assert.match(HARNESS, /await import\('\/src\/app\/main\.js'\)/, 'oikea käynnistyspolku (start, onSignedIn, loadUserData, renderAll)');
  assert.ok(HARNESS.indexOf("client.setClient(fake)") < HARNESS.indexOf("import('/src/app/main.js')"), 'korvike ennen main.js:ää');
  assert.equal(/access_token/.test(HARNESS), false, 'istunnossa ei tokenia: tekoälykutsua ei tehdä');
  assert.equal(/vendor\/supabase/.test(HARNESS + PAGE), false, 'supabase-js:ää ei ladata');
  assert.match(read('tools/e2e/seeds.mjs'), /e2e@example\.invalid/);
});

test('E2E: skenaariot kattavat pyydetyt polut, myös vanhan käyttäjän', () => {
  for (const scenario of ['ensikäyttö', 'ajastin', 'nopea kirjaus', 'kuormitus ja energia', 'huomiotta jääminen',
    'viikkokatsaus', 'esikatselu', 'mobiili 360 px', 'saavutettavuus',
    // Day 1: aloitus (F2), Enter "Muu"-kentässä (CRIT-04), kirjatun ajan
    // alue jälkikäteen (F6) ja arviojono (F4).
    'aloitus: vaihe 1/7', 'näppäimistö: Enter', 'kohdistus jälkikäteen', 'arviojono',
    // CRIT-10: vanha käyttäjä J-porteilla, uudelleenlataus, liitos, offline, näppäimistö.
    'legacy: 36 tehtävää ilman kestoa, 1 tavoite, 1 projekti, ei alueita',
    'legacy: elämänalue omalla tärkeydellä', 'legacy: kapasiteetti', 'legacy: vanha tavoite liitetään alueeseen',
    'legacy: arviojono', 'legacy: ajastin alueelle', 'legacy: uudelleenlataus: ajastin yhä käynnissä',
    'legacy: toinen laite', 'legacy: pysäytys: toteuma kirjautuu kerran kantaan, Suunta päivittyy',
    'legacy: tehtävä liitetään tavoitteeseen lomakkeella, liitos säilyy uudelleenlatauksessa',
    'legacy: viikkokatsaus tallentuu kantaan', 'legacy: ensi viikon esikatselu ei kirjoita; vahvistettu muutos kantaan',
    'legacy: näppäimistö: Enter "Muu"-kentässä kirjaa kirjoitetut minuutit kantaan',
    'legacy: offline: jonossa oleva kirjaus näkyy uudelleenlatauksen jälkeen',
    'legacy: näppäimistö: Tauko pitää fokuksen']) {
    assert.ok(RUNNER.includes(scenario), scenario);
  }
  // Oikea Enter-näppäily (synteettinen tapahtuma ei laukaise lomakkeen lähetystä).
  assert.match(RUNNER, /Input\.dispatchKeyEvent/);
  // Uudelleenlataus on oikea sivun lataus, ei tilan kopiointi.
  assert.match(RUNNER, /Page\.reload/);
  // Vanhan käyttäjän ryhmä ajetaan J-porteilla vanhan käyttäjän kannalla.
  assert.match(RUNNER, /key: 'legacy'[^\n]*query: \{ gates: 'J', seed: 'legacy'/);
  assert.match(RUNNER, /key: 'J'[^\n]*query: \{ gates: 'J', seed: 'empty'/);
  assert.match(RUNNER, /key: 'closed'[^\n]*query: \{ gates: 'closed'/);
});

test('E2E: rinnakkaisesta paketista odottava skenaario ei jää merkinnäksi (onnistuminen kaataa ajon)', () => {
  assert.match(RUNNER, /const PENDING_ON = Object\.freeze\(\{/);
  assert.match(RUNNER, /poista PENDING_ON-merkintä/);
  assert.match(RUNNER, /else if \(result\.pendingOn && result\.ok\) \{\s*label = 'FAIL'/);
});

// ------------------------------------------------------------ J-porttitila

test('J-porttitila: haaran schema.js saa aallon J portit; ajonaikainen skeemakerros säilyy', () => {
  const j = trainMatrix('J');
  const patched = patchSchemaGates(SCHEMA, j);
  const tables = parseGates(patched);
  // J avaa kaikki aaltojen A–J portit; myöhemmät (aalto K, 0014) pysyvät kiinni.
  const openInJ = new Set(cumulativeGates('J'));
  for (const gate of ALL_GATES) assert.equal(tables[gate], openInJ.has(gate), gate);
  assert.ok(ALL_GATES.some(gate => !openInJ.has(gate)), 'aalto K:n portit ovat J:n jälkeen');
  assert.deepEqual(Object.values(parseColumnGates(patched)), Object.values(j.columns));
  assert.ok(Object.values(j.columns).every(Boolean), 'J avaa jokaisen sarakeportin');
  for (const name of ['export function isTableAvailable', 'export function columnGateOpen', 'export const SCHEMA_REQUIREMENTS',
    'export function writeRefusal', 'export function noteSchemaError']) {
    assert.ok(patched.includes(name), name);
  }
  // Vain porttiliteraalit muuttuvat.
  const changed = patched.split('\n').filter((line, i) => line !== SCHEMA.split('\n')[i]);
  assert.ok(changed.every(line => /:\s*true,?\s*$|^export const [A-Z_]+ = true;/.test(line.trim())), changed.join('\n'));
});

test('J-porttitila: import map vain J-tilassa; ohjaa jokaisen schema.js-importin', () => {
  assert.equal(harnessHtml(PAGE, 'closed'), PAGE);
  const html = harnessHtml(PAGE, 'J');
  const map = /<script type="importmap">([^<]+)<\/script>/.exec(html);
  assert.ok(map, 'import map puuttuu');
  assert.deepEqual(JSON.parse(map[1]), { imports: { '/src/data/schema.js': '/src/data/schema.js?e2e-gates=J' } });
  assert.ok(html.indexOf('importmap') < html.indexOf('/tools/e2e/harness.mjs'), 'import map ennen moduuleja');
  assert.match(RUNNER, /resolveGateMode\('J'/);
  assert.match(HARNESS, /J-portit eivät tulleet voimaan/, 'valjas todentaa, että portit todella aukesivat');
});

test('J-porttitila: lähde on J-ehdokas, junan määrittely varmistaa; ristiriita keskeyttää', () => {
  assert.equal(DEFAULT_GATES_REF, 'rehearsal/wave-j-v2');
  const jSource = patchSchemaGates(SCHEMA, trainMatrix('J'));
  // ref annetaan erikseen: kehittäjän E2E_GATES_REF ei saa muuttaa testiä.
  const ok = resolveGateMode('J', { cwd: '.', ref: DEFAULT_GATES_REF, schemaSource: SCHEMA, show: () => jSource, sha: () => 'abc1234' });
  assert.match(ok.provenance, /rehearsal\/wave-j-v2 \(abc1234\)/);
  assert.equal(parseGates(ok.source).lifeAreas, true);
  const missing = resolveGateMode('J', { cwd: '.', ref: DEFAULT_GATES_REF, schemaSource: SCHEMA, show: () => { throw new Error('unknown revision'); } });
  assert.match(missing.provenance, /waves\.mjs/, 'ref puuttuu -> junan määrittely, ja se sanotaan');
  const iSource = patchSchemaGates(SCHEMA, trainMatrix('I'));
  assert.throws(() => resolveGateMode('J', { cwd: '.', ref: DEFAULT_GATES_REF, schemaSource: SCHEMA, show: () => iSource, sha: () => 'x' }),
    /ei vastaa junan aaltoa J/);
  assert.equal(resolveGateMode('closed', { schemaSource: SCHEMA }).source, null, 'suljettu = haaran oma tiedosto');
});

// ------------------------------------------------------------ siemen

test('vanhan käyttäjän siemen: 36 avointa tehtävää ilman kestoa (rästi, tämä ja ensi viikko), 1 tavoite, 1 projekti, profiili', () => {
  const today = '2026-09-23';
  const { tables, ids } = legacyUserSeed({ todayIso: today });
  const monday = mondayOf(today);
  assert.equal(monday, '2026-09-21');
  assert.equal(tables.tasks.length, LEGACY_COUNTS.tasks);
  assert.ok(tables.tasks.length >= 36);
  assert.ok(tables.tasks.every(t => t.duration_minutes === null && t.end_time === null && t.completed === false));
  assert.ok(tables.tasks.every(t => t.goal_id === null && t.project_id === null && t.user_id === LEGACY_USER_ID));
  assert.equal(new Set(tables.tasks.map(t => t.id)).size, 36);
  const overdue = tables.tasks.filter(t => t.date < monday).length;
  const thisWeek = tables.tasks.filter(t => t.date >= monday && t.date < addDays(monday, 7)).length;
  const nextWeek = tables.tasks.filter(t => t.date >= addDays(monday, 7) && t.date < addDays(monday, 14)).length;
  assert.deepEqual([overdue, thisWeek, nextWeek], [12, 12, 12]);
  assert.ok(tables.tasks.some(t => t.date === today), 'tälle päivälle on tehtäviä');
  assert.equal(tables.goals.length, 1);
  assert.equal(tables.goals[0].life_area_id, null);
  assert.equal(tables.projects.length, 1);
  assert.equal(tables.projects[0].goal_id, ids.goalId, 'projekti on liitetty tavoitteeseen');
  assert.equal(tables.profile[0].id, LEGACY_USER_ID);
  for (const table of ['life_areas', 'weekly_capacities', 'time_entries', 'running_timers', 'alignment_reviews']) {
    assert.equal(tables[table], undefined, `${table}: vanhalla käyttäjällä ei ole Suunnan rivejä`);
  }
});

// ------------------------------------------------------------ kannan korvike

const A = { user: { id: 'aaaaaaaa-0000-4000-8000-00000000000a', email: 'a@example.invalid' } };
const B = { user: { id: 'bbbbbbbb-0000-4000-8000-00000000000b', email: 'b@example.invalid' } };

function clientFor(database, session, extra = {}) {
  return createFakeSupabase({ database, session, latencyMs: 0, ...extra });
}

test('korvike: lisäys saa user_id:n istunnosta; select näkee vain omat rivit (RLS)', async () => {
  const database = createFakeDatabase();
  const a = clientFor(database, A);
  const b = clientFor(database, B);
  assert.equal((await a.from('life_areas').insert({ id: 'la1', name: 'Perhe', importance: 5 })).error, null);
  assert.equal((await b.from('life_areas').insert({ id: 'lb1', name: 'Perhe', importance: 3 })).error, null, 'sama nimi eri käyttäjällä');
  const mine = await a.from('life_areas').select('*').eq('user_id', A.user.id);
  assert.deepEqual(mine.data.map(r => r.id), ['la1']);
  assert.equal(mine.data[0].user_id, A.user.id);
  assert.ok(mine.data[0].created_at && mine.data[0].updated_at, 'kannan aikaleimat');
  const peek = await a.from('life_areas').select('*').eq('user_id', B.user.id);
  assert.deepEqual(peek.data, [], 'toisen käyttäjän rivit eivät näy');
  const forged = await a.from('life_areas').insert({ id: 'x', name: 'X', user_id: B.user.id });
  assert.equal(forged.error.code, '42501');
  const cross = await a.from('life_areas').update({ name: 'Kaapattu' }).eq('id', 'lb1').select('id');
  assert.deepEqual(cross.data, [], 'toisen käyttäjän riviä ei päivitetä');
  assert.equal(database.rows('life_areas').find(r => r.id === 'lb1').name, 'Perhe');
});

test('korvike: päivitys palauttaa osuneet rivit (.select), laskurin ja nollaosuman', async () => {
  const database = createFakeDatabase();
  const a = clientFor(database, A);
  await a.from('tasks').insert({ id: 't1', title: 'Vanha', date: '2026-09-23', duration_minutes: null });
  const hit = await a.from('tasks').update({ duration_minutes: 30 }).eq('user_id', A.user.id).eq('id', 't1').select('id');
  assert.deepEqual(hit.data, [{ id: 't1' }]);
  const miss = await a.from('tasks').update({ duration_minutes: 30 }).eq('user_id', A.user.id).eq('id', 'puuttuu').select('id');
  assert.deepEqual(miss.data, []);
  const counted = await a.from('tasks').update({ title: 'Uusi' }, { count: 'exact' }).eq('id', 't1');
  assert.equal(counted.count, 1);
  assert.equal(counted.data, null, 'ilman selectiä ei rivejä (return=minimal)');
  const guarded = await a.from('tasks').update({ title: 'Ehto' }).eq('id', 't1').is('description', null).select('id');
  assert.equal(guarded.data.length, 1, 'is(null) täsmää puuttuvaan arvoon');
  const neq = await a.from('tasks').update({ title: 'Ei' }).eq('id', 't1').neq('title', 'Ehto').select('id');
  assert.equal(neq.data.length, 0);
});

test('korvike: uniikki- ja viiteavaimet kuten migraatioissa; poisto nollaa viittaukset', async () => {
  const database = createFakeDatabase();
  const a = clientFor(database, A);
  await a.from('life_areas').insert({ id: 'area', name: 'Terveys' });
  const first = await a.from('time_entries').insert({ id: 'e1', minutes: 10, operation_id: 'op-1', life_area_id: 'area' });
  assert.equal(first.error, null);
  const again = await a.from('time_entries').insert({ id: 'e2', minutes: 10, operation_id: 'op-1' });
  assert.equal(again.error.code, '23505', 'sama operaatio kahdesti');
  assert.match(again.error.message, /time_entries_operation_unique/);
  const orphan = await a.from('tasks').insert({ id: 't9', title: 'x', goal_id: 'ei-ole' });
  assert.equal(orphan.error.code, '23503');
  await a.from('running_timers').insert({ id: 'r1', started_at: 'x' });
  assert.equal((await a.from('running_timers').insert({ id: 'r2', started_at: 'y' })).error.code, '23505', 'yksi ajastin käyttäjää kohti');
  await a.from('life_areas').delete().eq('id', 'area');
  assert.equal(database.rows('time_entries')[0].life_area_id, null, 'on delete set null');
});

test('korvike: offline palauttaa supabase-js:n verkkovirheen eikä kirjoita mitään', async () => {
  const database = createFakeDatabase();
  let offline = true;
  const a = clientFor(database, A, { isOffline: () => offline });
  const result = await a.from('time_entries').insert({ id: 'e1', minutes: 10, operation_id: 'op' });
  assert.equal(result.status, 0);
  assert.equal(result.data, null);
  assert.equal(result.error.message, 'TypeError: Failed to fetch');
  assert.equal(result.error.code, '');
  assert.deepEqual(database.rows('time_entries'), []);
  offline = false;
  assert.equal((await a.from('time_entries').insert({ id: 'e1', minutes: 10, operation_id: 'op' })).error, null);
});

test('korvike: profiili (id = auth.uid()), maybeSingle, upsert ja istunto', async () => {
  const database = createFakeDatabase({ tables: { profile: [{ id: A.user.id, age: 41 }] } });
  const a = clientFor(database, A);
  const own = await a.from('profile').select('*').eq('id', A.user.id).maybeSingle();
  assert.equal(own.data.age, 41);
  const none = await clientFor(database, B).from('profile').select('*').eq('id', B.user.id).maybeSingle();
  assert.equal(none.data, null);
  assert.equal(none.error, null);
  await a.from('profile').upsert({ id: A.user.id, age: 42 });
  assert.equal(database.rows('profile').length, 1);
  assert.equal(database.rows('profile')[0].age, 42);
  assert.equal((await a.from('profile').upsert({ id: B.user.id, age: 1 })).error.code, '42501');
  const events = [];
  a.auth.onAuthStateChange((event, session) => events.push([event, session && session.user.id]));
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(events, [['INITIAL_SESSION', A.user.id]]);
  assert.equal((await a.auth.getSession()).data.session.access_token, undefined, 'ei tokenia');
  assert.equal((await a.auth.signInWithPassword({ email: 'x', password: 'y' })).error.message, 'Invalid login credentials');
});

test('korvike: tuntematon kyselymetodi ei onnistu hiljaa', async () => {
  const a = clientFor(createFakeDatabase(), A);
  const result = await a.from('tasks').select('*').filter('title', 'fts', 'x');
  assert.ok(result.error);
  assert.deepEqual(a.unsupported(), ['tasks.filter:fts']);
});
