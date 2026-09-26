// Suunta 2: yksityisyys.
//
// Elämänalueet, pohdinnat ja kirjausten muistiinpanot ovat käyttäjän
// arkaluonteisinta sisältöä. Tämä tiedosto vartioi, etteivät ne päädy
// lokiin, laitteen tallenteeseen otsikoina, tekoälylle tai vientiin
// omistajatunnisteen kanssa.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { read, readCode, browserModules } from './helpers/sources.mjs';
import { callsIn } from './helpers/callArgs.mjs';
import { fakeClient } from './helpers/gates.mjs';
import { buildAlignmentAssistantContext } from '../src/ai/alignmentContext.js';
import { analyzeWeek } from '../src/domain/alignment.js';
import { buildReviewSnapshot } from '../src/domain/alignmentReview.js';
import { buildPlanningConstraints } from '../src/domain/planAlignment.js';
import { normalizeLifeArea } from '../src/domain/lifeArea.js';
import { normalizeTask } from '../src/domain/task.js';
import { normalizeTimeEntry } from '../src/domain/timeEntry.js';
import { normalizeGoal } from '../src/domain/goal.js';
import { setUser, clearUser } from '../src/data/session.js';
import { setClient } from '../src/data/client.js';
import { resetState, setTasks, setGoals } from '../src/app/state.js';
import { clearLocalUserData } from '../src/app/actions.js';
import {
  createLifeArea, logTime, saveWeeklyCapacity, saveWeeklyReview, setTimeEntryWriterForTests,
  resetAppliedAdjustments, resetAlignmentSession
} from '../src/app/alignment.js';
import { startTracking, stopTracking, setTimerRepoForTests } from '../src/app/timeTracking.js';
import { lifeAreasRepo, weeklyCapacitiesRepo, alignmentReviewsRepo } from '../src/data/collectionsRepo.js';
import {
  saveTimer, saveOutbox, savePendingTimers, addTombstone, resetTimerStoreForTests
} from '../src/data/timerStore.js';
import { saveQueueText, resetQueueStoreForTests } from '../src/data/offlineQueueStore.js';
import { setUserPreference } from '../src/data/preferences.js';
import { DEVICE_STORAGE, DEVICE_ACTION, purgeDeviceDataForUser } from '../src/data/deviceData.js';
import { fail } from '../src/lib/result.js';

const FILES = ['src/app/alignment.js', 'src/app/timeTracking.js', 'src/app/timerState.js', 'src/app/views/timeLog.js',
  'src/app/views/direction.js', 'src/app/timeEntryWriter.js', 'src/data/timerStore.js'];

test('lokirivit eivät kanna nimiä, otsikoita, muistiinpanoja eikä pohdintoja', () => {
  const forbidden = /\b(name|title|note|reflection|reflectionAnswers|description|label|text|answers?)\s*:/;
  for (const file of FILES) {
    const code = readCode(file);
    for (const match of code.matchAll(/logEvent\(\s*'[^']+'\s*,\s*\{([\s\S]*?)\}\s*\)/g)) {
      assert.equal(forbidden.test(match[1]), false, `${file}: ${match[0].slice(0, 120)}`);
    }
    assert.equal(/console\.(log|info|debug)\(/.test(code), false, `${file}: konsolilokitus`);
  }
});

test('tekoälykonteksti ei sisällä aluenimiä, otsikoita eikä muistiinpanoja', () => {
  const areas = [normalizeLifeArea({ id: 'x', name: 'Terapia', importance: 5, targetMinutesPerWeek: 300 })];
  const analysis = analyzeWeek({
    weekStart: '2026-09-14', todayIso: '2026-09-18', areas,
    tasks: [normalizeTask({ id: 't', title: 'Salainen', date: '2026-09-15', durationMinutes: 60 })],
    timeEntries: [normalizeTimeEntry({ id: 'e', entryDate: '2026-09-15', minutes: 30, note: 'yksityinen', lifeAreaId: 'x' })]
  });
  const serialized = JSON.stringify(buildAlignmentAssistantContext(analysis).context);
  for (const secret of ['Terapia', 'Salainen', 'yksityinen', '"x"', '"t"']) {
    assert.equal(serialized.includes(secret), false, secret);
  }
});

test('tilannekuva ei kopioi tehtävien otsikoita eikä kirjausten muistiinpanoja', () => {
  const analysis = analyzeWeek({
    weekStart: '2026-09-14', todayIso: '2026-09-18',
    areas: [normalizeLifeArea({ id: 'x', name: 'Oma', importance: 3, targetMinutesPerWeek: 60 })],
    tasks: [normalizeTask({ id: 't', title: 'Salainen tehtävä', date: '2026-09-15', durationMinutes: 60 })],
    timeEntries: [normalizeTimeEntry({ id: 'e', entryDate: '2026-09-15', minutes: 30, note: 'yksityinen muistiinpano' })]
  });
  const snapshot = JSON.stringify(buildReviewSnapshot(analysis));
  assert.equal(snapshot.includes('Salainen'), false);
  assert.equal(snapshot.includes('yksityinen'), false);
});

test('pohdintavastauksia ei lähetetä minnekään: vain katsauksen rivi', () => {
  for (const file of ['src/ai/alignmentExplainClient.js', 'src/ai/alignmentContext.js', 'api/explain.js', 'src/ai/planSchema.js']) {
    assert.equal(/reflection/i.test(readCode(file).replace(/\/\/.*$/gm, '')), false, file);
  }
});

test('ei sijaintia: Suunta 2 ei käytä sijaintirajapintoja', () => {
  for (const file of [...FILES, 'src/domain/timer.js', 'src/domain/realitySources.js']) {
    assert.equal(/geolocation|getCurrentPosition|coords\./.test(readCode(file)), false, file);
  }
});

// =====================================================================
// KOKO src/: LOKI, KONSOLI, TEKOÄLY JA LAITE (tietoturvan loppukierros)
// =====================================================================
//
// Yllä oleva tarkistus kattoi seitsemän Suunnan tiedostoa. Tämä kattaa
// koko selaimen koodin: yksikään loki- tai konsolikutsu ei lue
// sisältökenttää, Suunnan virrat eivät vie sisältöä konsoliin edes
// virhepolulla, tekoälyn kontekstit ovat tunnisteita ja lukuja, ja
// laitteelle jäävä käyttäjäkohtainen data poistuu tilin poistossa.

/** Sisältökentät: nimi, otsikko, muistiinpano, pohdinta, vastaus, selite. */
const CONTENT_FIELDS = 'name|title|note|notes|reflection|reflectionAnswers|description|text|label|'
  + 'transcript|answer|answers|details|hint|body|content|summary|query|message';
const CONTENT_PROPERTY = new RegExp(`\\.(?:${CONTENT_FIELDS})\\b`);
const CONTENT_KEY = new RegExp(`(?:^|[{,]\\s*)(?:${CONTENT_FIELDS})\\s*:`);
/** Kaikki kirjauskohdat: konsoli, logger ja result.js:n diagnostiikka. */
const LOG_CALLEE = /console\.(?:log|info|warn|error|debug)|\blogEvent|\blogWarn|\blogFailure|\blogError|\blog(?=\(LOG_LEVEL\.)/;

test('KRIITTINEN: yksikään loki- tai konsolikutsu src/-puussa ei lue sisältökenttää', () => {
  let checked = 0;
  const offenders = [];
  for (const file of browserModules()) {
    // Lokin toteutus itse on kohde, ei kutsuja: se suodattaa (ks. lib-logger-errors).
    if (file === 'src/lib/logger.js') continue;
    const code = readCode(file);
    for (const call of callsIn(code, LOG_CALLEE)) {
      checked += 1;
      // Merkkijonoliteraalit (tapahtuman nimi 'voice.transcript', kiinteä
      // viesti) eivät ole kenttiä; lausekkeet `${…}` jäävät tarkistukseen.
      const args = call.args.map(arg => arg.replace(/'[^'\\]*(?:\\.[^'\\]*)*'|"[^"\\]*(?:\\.[^"\\]*)*"/g, "''"))
        .join(', ');
      if (CONTENT_PROPERTY.test(args) || CONTENT_KEY.test(args)) {
        offenders.push(`${file}: ${code.slice(call.index, call.index + 120).split('\n')[0]}`);
      }
    }
  }
  assert.deepEqual(offenders, [], 'sisältökenttä loki- tai konsolikutsussa');
  assert.ok(checked >= 40, `kirjauskohtia löytyi vain ${checked} — tarkistus ei osu mihinkään`);
  // Tarkistin itse tunnistaa rikkeen.
  const sample = "logEvent('x.y', { label: area.name }); console.warn('ok', task.title);";
  const found = callsIn(sample, LOG_CALLEE).map(call => call.args.join(', '));
  assert.ok(found.every(args => CONTENT_PROPERTY.test(args) || CONTENT_KEY.test(args)));
});

test('telemetriaa ei ole: selaimen koodi ei lähetä lokia minnekään', () => {
  for (const file of browserModules()) {
    const code = readCode(file);
    assert.equal(/navigator\.sendBeacon|\bsentry\b|datadog|logrocket|posthog|mixpanel|google-analytics|gtag\(/i.test(code),
      false, `${file}: ulkoinen telemetria`);
  }
});

// ------------------------------------------------------ dynaaminen polku

const SECRET = Object.freeze({
  area: 'Terapiaryhmä-salaisuus',
  areaDescription: 'alueen-kuvaus-salaisuus',
  task: 'Salainen-tehtävä-otsikko',
  goal: 'Salainen-tavoite-otsikko',
  note: 'yksityinen-muistiinpano',
  capacity: 'kapasiteetti-muistiinpano',
  reflection: 'syvä-pohdinta-salaisuus',
  answer: 'pohdintavastaus-salaisuus'
});
const PRIVATE_USER = { id: 'aaaaaaaa-9191-4191-8191-000000000091', email: 'yksityinen@example.com' };
const T0 = Date.UTC(2026, 8, 21, 7, 0);
const MIN = 60 * 1000;

const HTML_IDS = new Set([...read('index.html').matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
function stubElement(id) {
  const attributes = {};
  return {
    id, innerHTML: '', textContent: '', value: '', checked: false, disabled: false, hidden: false,
    style: {}, dataset: {},
    classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
    setAttribute: (k, v) => { attributes[k] = String(v); },
    getAttribute: k => attributes[k] ?? null,
    removeAttribute: k => { delete attributes[k]; },
    addEventListener() {}, removeEventListener() {},
    focus() {}, querySelector: () => null, querySelectorAll: () => [],
    appendChild: () => {}, remove: () => {}, closest: () => null
  };
}

/** Sovelluksen ympäristö Nodessa: tynkä-DOM, tallennus, käyttäjä, asiakas. */
function installApp() {
  const elements = new Map();
  globalThis.document = {
    activeElement: null,
    getElementById(id) {
      if (!HTML_IDS.has(id)) return null;
      if (!elements.has(id)) elements.set(id, stubElement(id));
      return elements.get(id);
    },
    createElement: () => stubElement(null),
    querySelectorAll: () => [],
    body: { appendChild: () => {} }
  };
  globalThis.CSS = { escape: value => String(value) };
  const data = new Map();
  globalThis.localStorage = {
    getItem: key => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => { data.set(key, String(value)); },
    removeItem: key => { data.delete(key); },
    key: index => [...data.keys()][index] ?? null,
    get length() { return data.size; }
  };
  clearUser();
  clearLocalUserData();
  resetState();
  resetTimerStoreForTests();
  resetQueueStoreForTests();
  resetAppliedAdjustments();
  resetAlignmentSession();
  setTimerRepoForTests(null);
  setTimeEntryWriterForTests(null);
  setUser(PRIVATE_USER);
  setClient(fakeClient({ data: [], error: null }));
  return data;
}

function uninstallApp() {
  clearUser();
  clearLocalUserData();
  resetState();
  resetTimerStoreForTests();
  resetQueueStoreForTests();
  delete globalThis.document;
  delete globalThis.CSS;
  delete globalThis.localStorage;
}

async function captureConsole(fn) {
  const lines = [];
  const originals = {};
  for (const method of ['log', 'info', 'warn', 'error', 'debug']) {
    originals[method] = console[method];
    console[method] = (...args) => lines.push(args.map(arg => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
  }
  try { await fn(); } finally { Object.assign(console, originals); }
  return lines.join('\n');
}

/** PostgRESTin kaltainen virhe, jonka details kantaa rivin arvon. */
function leakyFailure(value) {
  return fail('Tallennus ei onnistunut.', {
    code: 'alignment.save',
    cause: {
      code: '23505',
      message: 'duplicate key value violates unique constraint "life_areas_name_unique"',
      details: `Key (user_id, name)=(${PRIVATE_USER.id}, ${value}) already exists.`
    }
  });
}

test('KRIITTINEN: Suunnan virrat eivät vie nimiä, pohdintoja, otsikoita eikä muistiinpanoja konsoliin', async () => {
  installApp();
  const originals = {
    areaInsert: lifeAreasRepo.insert,
    capacityInsert: weeklyCapacitiesRepo.insert,
    capacityUpdate: weeklyCapacitiesRepo.update,
    reviewInsert: alignmentReviewsRepo.insert,
    reviewUpdate: alignmentReviewsRepo.update
  };
  try {
    const out = await captureConsole(async () => {
      // Onnistuneet polut (Node on kehitysympäristö: myös INFO tulostuu).
      const created = await createLifeArea({
        name: SECRET.area, description: SECRET.areaDescription, importance: 4, targetMinutesPerWeek: 120
      });
      assert.equal(created.ok, true, 'lähtötilanne: alueen luonti');
      setGoals([normalizeGoal({ id: 'g1', title: SECRET.goal, lifeAreaId: created.area.id })]);
      setTasks([normalizeTask({ id: 't1', title: SECRET.task, date: '2026-09-21', durationMinutes: 45, goalId: 'g1' })]);
      assert.equal((await logTime({
        entryDate: '2026-09-21', minutes: 30, lifeAreaId: created.area.id, note: SECRET.note
      })).ok, true);
      assert.equal((await startTracking({ kind: 'task', id: 't1' }, { now: T0 })).ok, true);
      assert.equal((await stopTracking({ now: T0 + 40 * MIN })).ok, true);
      assert.equal((await saveWeeklyCapacity({
        weekStart: '2026-09-21', availableMinutes: 1200, note: SECRET.capacity
      })).ok, true);
      assert.equal((await saveWeeklyReview({
        weekStart: '2026-09-21', reflection: SECRET.reflection, reflectionAnswers: { q1: SECRET.answer }
      })).ok, true);

      // Virhepolut: kanta palauttaa virheen, jonka details kantaa arvon.
      lifeAreasRepo.insert = async () => leakyFailure(SECRET.area);
      weeklyCapacitiesRepo.insert = async () => leakyFailure(SECRET.capacity);
      weeklyCapacitiesRepo.update = async () => leakyFailure(SECRET.capacity);
      alignmentReviewsRepo.insert = async () => leakyFailure(SECRET.reflection);
      alignmentReviewsRepo.update = async () => leakyFailure(SECRET.reflection);
      assert.equal((await createLifeArea({ name: `${SECRET.area} 2`, importance: 3 })).ok, false);
      assert.equal((await saveWeeklyCapacity({
        weekStart: '2026-09-28', availableMinutes: 600, note: SECRET.capacity
      })).ok, false);
      assert.equal((await saveWeeklyReview({ weekStart: '2026-09-28', reflection: SECRET.reflection })).ok, false);
    });

    // Tarkistus osuu: tapahtumat ja virheet kirjattiin.
    for (const event of ['alignment.area_created', 'alignment.time_logged', 'alignment.review_saved']) {
      assert.ok(out.includes(event), `tapahtumaa ${event} ei kirjattu — tarkistus ei todista mitään`);
    }
    assert.match(out, /life_areas_name_unique/, 'virhepolku ei tulostanut diagnostiikkaa');
    for (const [label, secret] of Object.entries(SECRET)) {
      assert.equal(out.includes(secret), false, `${label} päätyi konsoliin`);
    }
    assert.equal(out.includes(PRIVATE_USER.email), false, 'sähköposti päätyi konsoliin');
  } finally {
    lifeAreasRepo.insert = originals.areaInsert;
    weeklyCapacitiesRepo.insert = originals.capacityInsert;
    weeklyCapacitiesRepo.update = originals.capacityUpdate;
    alignmentReviewsRepo.insert = originals.reviewInsert;
    alignmentReviewsRepo.update = originals.reviewUpdate;
    uninstallApp();
  }
});

// ------------------------------------------------------------ tekoäly

function secretAnalysis() {
  const areas = [
    normalizeLifeArea({ id: 'area-secret', name: SECRET.area, description: SECRET.areaDescription,
      importance: 5, targetMinutesPerWeek: 600 }),
    normalizeLifeArea({ id: 'area-other', name: 'Toinen-salaisuus', importance: 4, targetMinutesPerWeek: 300 })
  ];
  return analyzeWeek({
    weekStart: '2026-09-14', todayIso: '2026-09-18', areas,
    goals: [normalizeGoal({ id: 'goal-secret', title: SECRET.goal, lifeAreaId: 'area-secret' })],
    tasks: [normalizeTask({ id: 'task-secret', title: SECRET.task, date: '2026-09-15', durationMinutes: 600,
      goalId: 'goal-secret' })],
    timeEntries: [normalizeTimeEntry({ id: 'entry-secret', entryDate: '2026-09-15', minutes: 30,
      note: SECRET.note, lifeAreaId: 'area-other' })],
    capacity: { weekStart: '2026-09-14', availableMinutes: 300, note: SECRET.capacity }
  });
}

test('KRIITTINEN: tekoälyn Suunta-konteksti ja suunnittelun rajat ovat tunnisteita ja lukuja', () => {
  const analysis = secretAnalysis();
  const secrets = [...Object.values(SECRET), 'Toinen-salaisuus', 'area-secret', 'goal-secret',
    'task-secret', 'entry-secret'];

  const context = JSON.stringify(buildAlignmentAssistantContext(analysis).context);
  for (const secret of secrets) assert.equal(context.includes(secret), false, `selityskonteksti: ${secret}`);

  // planAlignment: suunnittelija saa vain lukuja (api/_validatePlan.js päästää vain ne läpi).
  const constraints = buildPlanningConstraints(analysis);
  assert.ok(constraints && Object.keys(constraints).length > 0);
  for (const [key, value] of Object.entries(constraints)) {
    assert.ok(value === null || typeof value === 'number', `${key}: ${typeof value}`);
  }
  const serialized = JSON.stringify(constraints);
  for (const secret of secrets) assert.equal(serialized.includes(secret), false, `suunnittelun rajat: ${secret}`);
});

test('pohdinta ei päädy tekoälyn kontekstiin edes katsauksen kautta', () => {
  // Katsauksen tilannekuva on tallennettava historia; sekään ei kopioi
  // otsikoita eikä muistiinpanoja, joten tekoälylle ei ole reittiä.
  const snapshot = JSON.stringify(buildReviewSnapshot(secretAnalysis()));
  for (const secret of [SECRET.task, SECRET.goal, SECRET.note, SECRET.capacity, SECRET.reflection]) {
    assert.equal(snapshot.includes(secret), false, secret);
  }
  // Selityskonteksti ei edes lue pohdintaa, muistiinpanoa eikä otsikkoa.
  // (Alueiden nimet se pitää vain paikallisesti vastauksen tulkintaa
  // varten; lähtevä konteksti tarkistetaan dynaamisesti yllä.)
  const code = readCode('src/ai/alignmentContext.js');
  assert.equal(/reflection|\.note\b|\.title\b/.test(code), false, 'alignmentContext lukee sisältökenttää');
});

// -------------------------------------------------------------- laite

test('KRIITTINEN: laitteelle jäävä käyttäjäkohtainen data on avaimeltaan käyttäjän ja poistuu tilin poistossa', () => {
  const data = installApp();
  try {
    const A = PRIVATE_USER.id;
    const B = 'bbbbbbbb-9292-4292-8292-000000000092';
    const timer = id => ({ id, startedAt: '2026-09-21T07:00:00.000Z', targetKind: 'none', note: SECRET.note });
    for (const user of [A, B]) {
      saveTimer(user, timer(`rt-${user.slice(0, 4)}`));
      saveOutbox(user, [{ id: `e-${user.slice(0, 4)}`, entryDate: '2026-09-21', minutes: 30,
        operationId: `log:${user.slice(0, 4)}`, note: SECRET.note }]);
      savePendingTimers(user, [timer(`rp-${user.slice(0, 4)}`)]);
      addTombstone(user, `rx-${user.slice(0, 4)}`);
      saveQueueText(user, JSON.stringify({ v: 1, userId: user, ops: [] }));
      setUserPreference(user, 'onboardingCompleted', true);
    }

    // Rekisteri ja todellisuus: jokainen käyttäjäkohtainen avain on
    // rekisterissä käyttäjän avaimena, joka säilyy uloskirjautumisen yli ja
    // poistetaan tilin poistossa.
    const keysOf = user => [...data.keys()].filter(key => key.endsWith(user));
    assert.ok(keysOf(A).length >= 6, `A:n avaimia ${keysOf(A).length}`);
    for (const key of keysOf(A)) {
      const entry = DEVICE_STORAGE.find(candidate => key === candidate.prefix + A);
      assert.ok(entry, `avain ${key} ei ole rekisterissä käyttäjäkohtaisena`);
      assert.equal(entry.onSignOut, DEVICE_ACTION.KEEP, key);
      assert.equal(entry.onDelete, DEVICE_ACTION.PURGE, key);
    }
    // Sisältö ei ole koskaan toisen käyttäjän avaimella.
    for (const key of keysOf(B)) assert.equal(data.get(key).includes(A), false, key);

    const before = keysOf(B).length;
    purgeDeviceDataForUser(A);
    assert.deepEqual(keysOf(A), [], 'poistetun tilin dataa jäi laitteelle');
    assert.equal(keysOf(B).length, before, 'toisen käyttäjän data poistui');
    assert.equal([...data.values()].filter(value => value.includes(A)).length, 0);

    // Poiston jälkeen kesken jäänyt kirjoitus ei palauta poistettua dataa.
    saveTimer(A, timer('rt-late'));
    saveOutbox(A, [{ id: 'late', entryDate: '2026-09-21', minutes: 5, operationId: 'log:late' }]);
    assert.deepEqual(keysOf(A), []);
  } finally {
    uninstallApp();
  }
});
