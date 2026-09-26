// Suunnan Day 1 -korjaukset (yön katselmointi 2026-09-25).
//
// Kaksi erillistä, vain lukevaa katselmointia (Day 1 -turvallisuus ja
// Suunnan ytimen vihamielinen läpikäynti) löysivät samoja vikoja
// toisistaan riippumatta. Jokainen alla on todennettu koodista ennen
// korjausta ja lukittu tähän.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { read } from './helpers/sources.mjs';
import { fakeClient } from './helpers/gates.mjs';
import { setUser, clearUser, sessionSnapshot } from '../src/data/session.js';
import { setClient } from '../src/data/client.js';
import {
  resetState, getState, setDomainLoadStatus, setLifeAreas
} from '../src/app/state.js';
import { clearLocalUserData, withPendingTimeEntries } from '../src/app/actions.js';
import {
  saveWeeklyReview, setTimeEntryWriterForTests, resetAppliedAdjustments
} from '../src/app/alignment.js';
import { alignmentReviewsRepo } from '../src/data/collectionsRepo.js';
import { startTracking, stopTracking, setTimerRepoForTests } from '../src/app/timeTracking.js';
import { createTimeEntryWriter } from '../src/app/timeEntryWriter.js';
import { loadOutbox, saveOutbox, resetTimerStoreForTests } from '../src/data/timerStore.js';
import {
  initDirection, renderDirection, renderTodayDirection, resetDirectionView,
  alignmentLoadProblems, resetTimeFormForTests
} from '../src/app/views/direction.js';
import { redactDbDetail, logError, fail } from '../src/lib/result.js';

const USER = { id: 'aaaaaaaa-7777-4777-8777-000000000077', email: 'day1@example.com' };
const MIN = 60 * 1000;
const T0 = Date.UTC(2026, 8, 21, 7, 0);

// ------------------------------------------------------------ tynkä-DOM

const HTML_IDS = new Set([...read('index.html').matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
function stubElement(id) {
  const listeners = {};
  const attributes = {};
  return {
    id, innerHTML: '', textContent: '', value: '', checked: false, disabled: false, hidden: false,
    style: {}, dataset: {},
    classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
    setAttribute: (k, v) => { attributes[k] = String(v); },
    getAttribute: k => attributes[k] ?? null,
    removeAttribute: k => { delete attributes[k]; },
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
    removeEventListener: () => {},
    dispatch: (type, event = {}) => (listeners[type] || []).map(fn => fn(event)),
    focus() {}, querySelector: () => null, querySelectorAll: () => [],
    appendChild: () => {}, remove: () => {}, closest: () => null
  };
}
function installDom() {
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
}
function installStorage() {
  const data = new Map();
  globalThis.localStorage = {
    getItem: key => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => { data.set(key, String(value)); },
    removeItem: key => { data.delete(key); },
    key: index => [...data.keys()][index] ?? null,
    get length() { return data.size; }
  };
}

beforeEach(() => {
  clearUser();
  clearLocalUserData();
  resetState();
  resetTimerStoreForTests();
  resetAppliedAdjustments();
  resetDirectionView();
  resetTimeFormForTests();
  setTimerRepoForTests(null);
  setTimeEntryWriterForTests(null);
  installStorage();
  installDom();
  setUser(USER);
  setClient(fakeClient({ data: [], error: null }));
});

afterEach(() => {
  delete globalThis.document;
  delete globalThis.CSS;
  delete globalThis.localStorage;
});

// ================================================================ F1

/** Selaimen step-sääntö: arvo kelpaa, jos (arvo - min) on step:n monikerta. */
function stepValid(value, { min = 0, step = 1 }) {
  return (value - min) % step === 0;
}

test('F1 KRIITTINEN: kirjausdialogin "Muu" hyväksyy tavalliset minuuttimäärät', () => {
  const source = read('src/app/views/timeLog.js');
  const input = /<input type="number" id="timeLogMinutes"([^>]*)>/.exec(source)[1];
  const min = Number(/min="(\d+)"/.exec(input)[1]);
  const step = Number((/step="(\d+)"/.exec(input) || [0, 1])[1]);
  for (const minutes of [5, 10, 15, 20, 25, 30, 45, 60, 90, 120]) {
    assert.ok(stepValid(minutes, { min, step }), `${minutes} min estäisi lomakkeen (min=${min}, step=${step})`);
  }
});

test('F1 KRIITTINEN: ajastimen tarkistusdialogi hyväksyy minkä tahansa esitäytetyn keston', () => {
  const source = read('src/app/views/timeLog.js');
  const input = /<input type="number" id="timeLogReviewMinutes"([^>]*)>/.exec(source)[1];
  assert.equal(/\bmax=/.test(input), false, 'yli viikon unohtunut ajastin ylittäisi ylärajan');
  const min = Number(/min="(\d+)"/.exec(input)[1]);
  const step = Number((/step="(\d+)"/.exec(input) || [0, 1])[1]);
  for (const minutes of [721, 733, 1000, 1441, 12000]) assert.ok(stepValid(minutes, { min, step }), String(minutes));
});

test('F1: peruutus-, valmis- ja ajastinpainikkeet eivät vaadi "Muu"-kentän kelpoisuutta', () => {
  const source = read('src/app/views/timeLog.js');
  for (const value of ['value="cancel"', 'value="timer"']) {
    const button = source.split('\n').find(line => line.includes(value) && line.includes('type="submit"'));
    assert.ok(button, value);
    assert.match(button, /formnovalidate/, `${value}: validointi estäisi painikkeen`);
  }
  // Pikavalinnat eivät ole lainkaan submit-painikkeita (CRIT-04): validointi
  // ei voi estää niitä, eikä Enter "Muu"-kentässä osu niihin.
  const preset = source.split('\n').find(line => line.includes('time-log-preset') && line.includes('<button'));
  assert.ok(preset);
  assert.match(preset, /type="button"/);
});

// ================================================================ F2

test('F2 KRIITTINEN: kaksoisnapautus "Kirjaa aikaa" kirjaa yhden rivin', async () => {
  initDirection();
  const doc = globalThis.document;
  doc.getElementById('dirTimeDate').value = '2026-09-21';
  doc.getElementById('dirTimeMinutes').value = '30';
  doc.getElementById('dirTimeArea').value = '';
  const button = doc.getElementById('dirTimeSave');
  const first = button.dispatch('click');
  const second = button.dispatch('click');
  await Promise.all([...first, ...second]);
  assert.equal(getState().timeEntries.length, 1, 'kaksoisnapautus loi kaksi kirjausta');
  assert.equal(button.disabled, false, 'painike jäi pois käytöstä');
});

test('F2: onnistunut kirjaus vaihtaa tunnisteen — seuraava lomake on uusi kirjaus', async () => {
  initDirection();
  const doc = globalThis.document;
  for (const minutes of ['30', '45']) {
    doc.getElementById('dirTimeDate').value = '2026-09-21';
    doc.getElementById('dirTimeMinutes').value = minutes;
    await Promise.all(doc.getElementById('dirTimeSave').dispatch('click'));
  }
  assert.deepEqual(getState().timeEntries.map(e => e.minutes).sort((a, b) => a - b), [30, 45]);
});

// ================================================================ F3

test('F3 KRIITTINEN: epäonnistunut ensimmäinen katsaus ei jää tilaan eikä seuraava tallennus väitä onnistuneensa', async () => {
  const insert = alignmentReviewsRepo.insert;
  const update = alignmentReviewsRepo.update;
  const calls = [];
  try {
    alignmentReviewsRepo.insert = async () => { calls.push('insert'); return fail('Tallennus ei onnistunut.'); };
    alignmentReviewsRepo.update = async () => { calls.push('update'); return { ok: true }; };
    const first = await saveWeeklyReview({ weekStart: '2026-09-21', reflection: 'pohdinta' });
    assert.equal(first.ok, false);
    assert.equal(getState().alignmentReviews.length, 0, 'epäonnistunut katsaus jäi tilaan');
    const second = await saveWeeklyReview({ weekStart: '2026-09-21', reflection: 'pohdinta' });
    assert.equal(second.ok, false, 'toinen tallennus väitti onnistuneensa');
    assert.deepEqual(calls, ['insert', 'insert'], 'toinen tallennus päivitti olematonta riviä');
  } finally {
    alignmentReviewsRepo.insert = insert;
    alignmentReviewsRepo.update = update;
  }
});

// ================================================================ F4

test('F4 KRIITTINEN: lähettämätön kirjaus näkyy latauksen jälkeen (ei katoa, ei kirjata uudelleen)', () => {
  saveOutbox(USER.id, [{ id: 'q1', entryDate: '2026-09-21', minutes: 40, operationId: 'timer:x', source: 'timer',
    startedAt: '2026-09-21T07:00:00Z', endedAt: '2026-09-21T07:40:00Z' }]);
  const server = [{ id: 's1', entryDate: '2026-09-20', minutes: 15, operationId: 'log:a' }];
  const merged = withPendingTimeEntries(server, { persistent: true, userId: USER.id });
  assert.deepEqual(merged.map(e => e.id), ['s1', 'q1']);
});

test('F4: jo palvelimella oleva operaatio ei tule kahdesti; portti kiinni -> ennallaan', () => {
  saveOutbox(USER.id, [{ id: 'q1', entryDate: '2026-09-21', minutes: 40, operationId: 'log:a' }]);
  const server = [{ id: 's1', entryDate: '2026-09-21', minutes: 40, operationId: 'log:a' }];
  assert.deepEqual(withPendingTimeEntries(server, { persistent: true, userId: USER.id }).map(e => e.id), ['s1']);
  assert.deepEqual(withPendingTimeEntries(server, { persistent: false, userId: USER.id }), server);
  assert.deepEqual(withPendingTimeEntries(server, { persistent: true, userId: 'toinen' }), server);
});

test('F4: lataus käyttää yhdistelyä', () => {
  assert.match(read('src/app/actions.js'),
    /applyLoadResult\('timeEntries', entriesResult, list => setTimeEntries\(withPendingTimeEntries\(list\)\)\)/);
});

// ================================================================ F5

function offlineWriter() {
  const repo = {
    isPersistent: () => true,
    insert: async () => ({ ok: false, error: { cause: { message: 'Failed to fetch' } } })
  };
  return createTimeEntryWriter({
    repo, loadOutbox, saveOutbox, userId: () => USER.id,
    snapshot: sessionSnapshot, isSameSession: () => true
  });
}

test('F5 KRIITTINEN: ajastimen pysäytys ilman yhteyttä kertoo jonotuksesta', async () => {
  setTimeEntryWriterForTests(offlineWriter());
  await startTracking({ kind: 'none' }, { now: T0 });
  const stop = await stopTracking({ now: T0 + 40 * MIN });
  assert.equal(stop.ok, true);
  assert.equal(stop.queued, true, 'pysäytys ei kertonut, että kirjaus odottaa yhteyttä');
  assert.equal(loadOutbox(USER.id).length, 1);
  assert.match(read('src/app/views/timeLog.js'),
    /announceLogged\(result\.totalMinutes, \{ queued: Boolean\(result\.queued\), sessionOnly: Boolean\(result\.sessionOnly\) \}\)/);
});

// ================================================================ F6

test('F6 KRIITTINEN: lähetyksen aikana jonoon lisätty kirjaus ei katoa', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let online = true;
  const repo = {
    isPersistent: () => true,
    async insert() {
      if (!online) return { ok: false, error: { cause: { message: 'Failed to fetch' } } };
      await gate;
      return { ok: true };
    }
  };
  const writer = createTimeEntryWriter({
    repo, loadOutbox, saveOutbox, userId: () => USER.id,
    snapshot: sessionSnapshot, isSameSession: () => true
  });
  saveOutbox(USER.id, [{ id: 'old', entryDate: '2026-09-21', minutes: 10, operationId: 'log:old' }]);
  const flushing = writer.flush();
  // Lähetys odottaa verkkoa; sillä välin uusi kirjaus epäonnistuu ja jonottuu.
  online = false;
  const queued = await writer.insert({ id: 'new', entryDate: '2026-09-21', minutes: 20, operationId: 'log:new' });
  assert.equal(queued.queued, true);
  online = true;
  release();
  const result = await flushing;
  assert.equal(result.sent, 1);
  assert.deepEqual(loadOutbox(USER.id).map(e => e.operationId), ['log:new'], 'uusi kirjaus pyyhkiytyi korista');
});

// ================================================================ F7

test('F7 KRIITTINEN: epäonnistunut ensimmäinen lataus ei näytä tyhjältä tilalta', () => {
  setDomainLoadStatus('lifeAreas', false, new Error('verkko'));
  assert.deepEqual(alignmentLoadProblems(), ['lifeAreas']);
  renderDirection();
  const html = id => globalThis.document.getElementById(id).innerHTML;
  assert.match(html('dirPersistNote'), /Osa Suunnan tiedoista ei latautunut/);
  assert.doesNotMatch(html('dirSignals'), /Aloita elämänalueista/);
  assert.equal(html('dirAreaSuggestions'), '');
  renderTodayDirection();
  assert.match(html('todayDirection'), /ei voitu ladata/);
  assert.doesNotMatch(html('todayDirection'), /Kerro mikä elämässäsi on tärkeää/);
});

test('F7: onnistunut lataus ilman alueita näyttää tavallisen aloituksen', () => {
  setDomainLoadStatus('lifeAreas', true);
  setLifeAreas([]);
  renderDirection();
  assert.match(globalThis.document.getElementById('dirSignals').innerHTML, /Aloita elämänalueista/);
});

// ================================================================ F8

test('F8 KRIITTINEN: kannan virhetiedot eivät vie käyttäjän arvoja konsoliin', () => {
  assert.equal(redactDbDetail('Key (user_id, name)=(2cc00622-f927-4604-a518-361a4328481b, Terapia) already exists.'),
    'Key (user_id, name)=(…) already exists.');
  assert.equal(redactDbDetail('Failing row contains (t1, u, 2026-09-22, 0, salainen muistiinpano).'),
    'Failing row contains (…).');
  const printed = [];
  const original = console.error;
  console.error = (...args) => printed.push(args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  try {
    logError(fail('Tallennus ei onnistunut.', {
      code: 'life_areas.insert',
      cause: { code: '23505', message: 'duplicate key value violates unique constraint "life_areas_name_unique"',
               details: 'Key (user_id, name)=(u, Terapia) already exists.' }
    }).error);
  } finally {
    console.error = original;
  }
  const out = printed.join('\n');
  assert.equal(out.includes('Terapia'), false, 'elämänalueen nimi päätyi konsoliin');
  assert.match(out, /life_areas_name_unique/, 'rajoitteen nimi säilyy diagnostiikkaa varten');
  assert.match(out, /23505/);
});
