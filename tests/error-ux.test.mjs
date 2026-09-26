// Virheiden käyttäjäkokemus Day 1 -poluilla (ERR-03, 06–11, 13, 17–21).
//
// Jokainen testi lukitsee tilanteen, jossa käyttäjä aiemmin näki väärän,
// teknisen tai ei mitään viestiä: tyhjä tila latausvirheen jälkeen,
// vajaa vienti "Tiedosto ladattu.", väärä "tavoitteet eivät säily",
// nieltiin lomakkeen virhe, "AppError: …" kirjauspalkissa, äänetön
// uloskirjautuminen, kolme pinottua ilmoitusta, aina sama "Yritetäänkö
// uudelleen?", ja lupaus "Tallentuu, kun yhteys palaa", joka ei pitänyt.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import path from 'node:path';

import { read, ROOT } from './helpers/sources.mjs';
import { fakeClient } from './helpers/gates.mjs';
import { setUser, clearUser } from '../src/data/session.js';
import { setClient } from '../src/data/client.js';
import {
  resetState, getState, setTasks, setGoals, setDomainLoadStatus, setWeeklyCapacities, addInboxItemToState
} from '../src/app/state.js';
import {
  clearLocalUserData, loadUserData, createGoal, createRoutine, editTask, incompleteExportCollections,
  loadFailureMessage
} from '../src/app/actions.js';
import { goalsRepo, routinesRepo, billsRepo, weeklyCapacitiesRepo, inboxRepo } from '../src/data/collectionsRepo.js';
import { saveWeeklyCapacity } from '../src/app/alignment.js';
import { clearToasts, showError, notify } from '../src/ui/toast.js';
import { renderTasks, showFieldErrors as showTaskFieldErrors, FIELD_TO_INPUT as TASK_FIELDS } from '../src/app/views/tasks.js';
import { renderGoals, showFieldErrors as showGoalFieldErrors, FIELD_TO_INPUT as GOAL_FIELDS } from '../src/app/views/goals.js';
import { renderWeek } from '../src/app/views/week.js';
import { renderToday } from '../src/app/views/today.js';
import { loadFailureHtml } from '../src/app/views/loadNotice.js';
import { exportUserData, EXPORT_INCOMPLETE_MESSAGE } from '../src/app/views/profile.js';
import { localPreviewNote } from '../src/app/accountDeletion.js';
import { performSignOut, SIGNOUT_LOCAL_NOTE, SIGNOUT_UNCONFIRMED_NOTE } from '../src/app/auth.js';
import { failedReason, describeSyncLine, AUTH_PAUSED_NOTE } from '../src/app/offlineStatus.js';
import { createTimeEntryWriter } from '../src/app/timeEntryWriter.js';
import { announceLogged } from '../src/app/timeTracking.js';
import { installGlobalErrorHandlers, showStartupFailure } from '../src/app/globalErrors.js';
import { interpretItem } from '../src/app/capture.js';
import { captureReasonText } from '../src/app/views/inbox.js';
import { AppError, ERROR_CODE, failWith, fail } from '../src/lib/result.js';
import { UNEXPECTED_ERROR_MESSAGE } from '../src/lib/errorMessages.js';
import { normalizeTask } from '../src/domain/task.js';
import { normalizeInboxItem } from '../src/domain/inbox.js';
import { OP_STATUS } from '../src/domain/offlineQueue.js';

const USER = { id: 'aaaaaaaa-6666-4666-8666-000000000066', email: 'ux@example.com' };

// ------------------------------------------------------------ tynkä-DOM

const HTML_IDS = new Set([...read('index.html').matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
let registry = new Map();

function makeNode(id = null, tag = 'div') {
  const listeners = {};
  const attributes = {};
  const classes = new Set();
  const node = {
    id, tagName: String(tag).toUpperCase(), innerHTML: '', textContent: '', value: '', checked: false,
    disabled: false, hidden: false, style: {}, dataset: {}, children: [], parentNode: null, className: '',
    classList: {
      add: (...names) => names.forEach(name => classes.add(name)),
      remove: (...names) => names.forEach(name => classes.delete(name)),
      contains: name => classes.has(name),
      toggle: (name, force) => {
        const on = force === undefined ? !classes.has(name) : Boolean(force);
        if (on) classes.add(name); else classes.delete(name);
        return on;
      }
    },
    setAttribute: (key, value) => { attributes[key] = String(value); },
    getAttribute: key => (key in attributes ? attributes[key] : null),
    removeAttribute: key => { delete attributes[key]; },
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
    removeEventListener: () => {},
    focus() {}, scrollIntoView() {}, closest: () => null,
    querySelector: () => null, querySelectorAll: () => [],
    appendChild(child) {
      node.children.push(child);
      child.parentNode = node;
      if (child.id) registry.set(child.id, child);
      return child;
    },
    remove() {
      if (node.parentNode) node.parentNode.children = node.parentNode.children.filter(other => other !== node);
      node.parentNode = null;
    }
  };
  return node;
}

function installDom() {
  registry = new Map();
  const body = makeNode('body');
  globalThis.document = {
    activeElement: null,
    body,
    getElementById(id) {
      if (registry.has(id)) return registry.get(id);
      if (!HTML_IDS.has(id)) return null;
      const node = makeNode(id);
      registry.set(id, node);
      return node;
    },
    createElement: tag => makeNode(null, tag),
    querySelectorAll: () => []
  };
  globalThis.CSS = { escape: value => String(value) };
}

/** Näkyvät ilmoitukset: [{ tone, text }]. */
function toasts() {
  const host = registry.get('toastHost');
  if (!host) return [];
  return host.children.map(node => ({ tone: String(node.className).replace('toast toast-', ''), text: node.textContent }));
}

beforeEach(() => {
  clearUser();
  clearLocalUserData();
  resetState();
  installDom();
  clearToasts();
  setUser(USER);
  setClient(fakeClient({ data: [], error: null }));
});

afterEach(() => {
  clearToasts();
  delete globalThis.document;
  delete globalThis.CSS;
});

// =========================================================== ERR-08

test('ERR-08 KRIITTINEN: epäonnistunut ensimmäinen lataus ei ole "ei vielä tehtäviä"', () => {
  setTasks([]);
  setDomainLoadStatus('tasks', false, new AppError('x', { cause: { message: 'TypeError: Failed to fetch', code: '' } }));
  renderTasks();
  const html = registry.get('tasksListContainer').innerHTML;
  assert.match(html, /Tietoja ei saatu ladattua/);
  assert.match(html, /älä luo niitä uudelleen/);
  assert.doesNotMatch(html, /Ei vielä yhtään tehtävää/);

  setDomainLoadStatus('tasks', true);
  renderTasks();
  assert.match(registry.get('tasksListContainer').innerHTML, /Ei vielä yhtään tehtävää/);
});

test('ERR-08: Tänään, Viikko ja Tavoitteet näyttävät latausvirheen tyhjän tilan sijaan', () => {
  setTasks([]);
  setGoals([]);
  setDomainLoadStatus('tasks', false);
  setDomainLoadStatus('goals', false);

  renderToday();
  const today = registry.get('todayTimelineContainer').innerHTML;
  assert.match(today, /Tietoja ei saatu ladattua/);
  assert.doesNotMatch(today, /Päivä on vielä avoin/);

  renderWeek();
  assert.match(registry.get('weekListContainer').innerHTML, /Tietoja ei saatu ladattua/);

  renderGoals();
  const goals = registry.get('goalsListContainer').innerHTML;
  assert.match(goals, /Tietoja ei saatu ladattua/);
  assert.doesNotMatch(goals, /Ei vielä tavoitteita/);
});

test('ERR-08: ohje riippuu syystä -- istuntovirheestä ei käsketä odottamaan yhteyttä', () => {
  const state = {
    dataLoadStatus: {
      tasks: { ok: false, error: new AppError('x', { cause: { code: 'PGRST301', status: 401, message: 'JWT expired' } }) }
    }
  };
  const html = loadFailureHtml(state, ['tasks']);
  assert.match(html, /Kirjaudu uudelleen sisään/);
  assert.doesNotMatch(html, /yhteys toimii/);
  assert.equal(loadFailureHtml({ dataLoadStatus: { tasks: { ok: true } } }, ['tasks']), '');
  assert.doesNotMatch(html, /PGRST|JWT|tasks/);
});

// =========================================================== ERR-17

test('ERR-17: sama viesti ei pinoudu', () => {
  showError('Tallennus ei onnistunut.');
  showError('Tallennus ei onnistunut.');
  showError(new AppError('Tallennus ei onnistunut.'));
  notify('Tallennus ei onnistunut.');
  const shown = toasts();
  assert.equal(shown.filter(t => t.tone === 'error').length, 1, JSON.stringify(shown));
  assert.equal(shown.length, 2, 'eri sävy on eri ilmoitus');
});

test('ERR-05: latauksen kooste luokittelee syyt eikä syytä yhteyttä istunto- tai skeemavirheestä', () => {
  const failure = cause => ({ ok: false, error: new AppError('x', { cause }) });
  const auth = { code: 'PGRST301', status: 401, message: 'JWT expired' };
  const schema = { code: 'PGRST205' };
  const unavailable = { code: 'PGRST002', status: 503 };
  const network = { message: 'TypeError: Failed to fetch', code: '' };

  const authOnly = loadFailureMessage([failure(auth), failure(auth), failure(schema)]);
  assert.match(authOnly, /Kirjaudu uudelleen sisään/);
  assert.doesNotMatch(authOnly, /yhteys/, 'istuntovirhe ei ole yhteysvirhe');
  assert.doesNotMatch(loadFailureMessage([failure(schema), failure({ code: '42703' })]), /yhteys/);
  const busy = loadFailureMessage([failure(unavailable), failure(unavailable), failure(network)]);
  assert.match(busy, /hetken päästä/);
  assert.doesNotMatch(busy, /yhteys toimii/);
  assert.equal(loadFailureMessage([failure(network), failure(schema)]),
    'Osa tiedoista ei latautunut. Mitään ei kadonnut — päivitä, kun yhteys toimii.');
});

test('ERR-17 KRIITTINEN: latauksen epäonnistuminen näyttää yhden ilmoituksen, ei kolmea', async () => {
  setClient(fakeClient({ data: null, error: { message: 'TypeError: Failed to fetch', code: '' } }));
  const result = await loadUserData();
  assert.equal(result.tasksOk, false);
  const shown = toasts();
  assert.equal(shown.length, 1, JSON.stringify(shown));
  assert.match(shown[0].text, /Mitään ei kadonnut/);
});

// =========================================================== ERR-07

test('ERR-07 KRIITTINEN: haihtuvuushuomautus koskee vain kirjoitettua tietoa', async () => {
  // Tuotannon tilanne: tavoitteet tallentuvat, laskut eivät. Porttitilasta
  // riippumaton: säilyvyys asetetaan tässä, kirjoitus kulkee oikeaa polkua.
  const original = { goals: goalsRepo.isPersistent, bills: billsRepo.isPersistent };
  goalsRepo.isPersistent = () => true;
  billsRepo.isPersistent = () => false;
  try {
    const created = await createGoal({ title: 'Juoksen 10 km' });
    assert.equal(created.ok, true);
    assert.equal(toasts().some(t => /istunnon ajan/.test(t.text)), false,
      'tallentuva tavoite väitti, ettei tavoitteita tallenneta');
  } finally {
    goalsRepo.isPersistent = original.goals;
    billsRepo.isPersistent = original.bills;
  }
});

test('ERR-07: muistissa elävä tieto nimetään huomautuksessa, kerran', async () => {
  const original = routinesRepo.isPersistent;
  routinesRepo.isPersistent = () => false;
  try {
    await createRoutine({ title: 'Aamulenkki', recurrence: { type: 'daily', weekdays: [] } });
    await createRoutine({ title: 'Iltalenkki', recurrence: { type: 'daily', weekdays: [] } });
    const notes = toasts().filter(t => /istunnon ajan/.test(t.text));
    assert.equal(notes.length, 1);
    assert.equal(notes[0].text, 'Rutiinit säilyvät toistaiseksi vain tämän istunnon ajan.');
  } finally {
    routinesRepo.isPersistent = original;
  }
});

// =========================================================== ERR-06

test('ERR-06: poistettu tehtävä -> muokkaus perutaan ja käyttäjä näkee syyn', async () => {
  const task = normalizeTask({ id: 'toisaalla-poistettu', date: '2026-09-28', title: 'Vanha' });
  setTasks([task]);
  setClient(fakeClient({ data: [], error: null, updateData: [] }));
  const result = await editTask(task.id, { title: 'Uusi' });
  assert.equal(result.ok, false);
  assert.equal(getState().tasks[0].title, 'Vanha', 'muokkaus jäi näkyviin');
  const shown = toasts();
  assert.equal(shown.length, 1);
  assert.equal(shown[0].text, 'Kohdetta ei enää ole – se on ehkä poistettu toisella laitteella. Päivitä näkymä.');
});

test('ERR-06: tyypitetty NOT_FOUND (kanta) luo viikon rivin uudelleen kuten memory.missing', async () => {
  const WEEK = '2026-09-21';
  setWeeklyCapacities([{ id: 'c-gone', weekStart: WEEK, availableMinutes: 600 }]);
  const calls = [];
  const original = { update: weeklyCapacitiesRepo.update, insert: weeklyCapacitiesRepo.insert };
  weeklyCapacitiesRepo.update = async () => { calls.push('update'); return failWith(ERROR_CODE.NOT_FOUND, 'x'); };
  weeklyCapacitiesRepo.insert = async capacity => { calls.push('insert:' + capacity.id); return { ok: true, value: capacity }; };
  try {
    const saved = await saveWeeklyCapacity({ weekStart: WEEK, availableMinutes: 900 });
    assert.equal(saved.ok, true);
    assert.deepEqual(calls, ['update', 'insert:c-gone']);
  } finally {
    Object.assign(weeklyCapacitiesRepo, original);
  }
});

// =========================================================== ERR-09

test('ERR-09 KRIITTINEN: tavoitteen mittarin virhe näkyy kentän alla', () => {
  const unplaced = showGoalFieldErrors({ metric: 'Kerro mitä mitataan.', targetValue: 'Säästötavoitteeseen kytketty…' });
  assert.deepEqual(unplaced, []);
  assert.equal(registry.get('gfMetricError').textContent, 'Kerro mitä mitataan.');
  assert.equal(registry.get('gfMetric').getAttribute('aria-invalid'), 'true');
  assert.equal(registry.get('gfTargetValueError').textContent, 'Säästötavoitteeseen kytketty…');
  assert.equal(toasts().length, 0);
});

test('ERR-09: kentätön validointivirhe näytetään lomakkeen tasolla, ei niellä', () => {
  assert.deepEqual(showGoalFieldErrors({ parentGoalId: 'Tavoite ei voi olla oma ylätavoitteensa.' }),
    ['Tavoite ei voi olla oma ylätavoitteensa.']);
  assert.deepEqual(showTaskFieldErrors({ uusiKentta: 'Uusi sääntö rikkoutui.' }), ['Uusi sääntö rikkoutui.']);
  const shown = toasts();
  assert.equal(shown.length, 2);
  assert.ok(shown.every(t => t.tone === 'error'));
});

test('ERR-09: jokaisella lomakkeessa muokattavalla domainin virhekentällä on paikka', () => {
  const keys = file => [...new Set([...read(file).matchAll(/errors\.(\w+) =/g)].map(m => m[1]))];
  // parentGoalId ei ole lomakkeella (ylätavoite asetetaan suunnitelmasta):
  // se näytetään lomakkeen tasolla (yllä).
  const goalFormless = new Set(['parentGoalId']);
  for (const key of keys('src/domain/goal.js')) {
    if (goalFormless.has(key)) continue;
    assert.ok(GOAL_FIELDS[key], `validateGoal: ${key} ilman kenttää`);
    assert.ok(read('index.html').includes(`id="${GOAL_FIELDS[key]}Error"`), `${GOAL_FIELDS[key]}Error puuttuu`);
  }
  for (const key of keys('src/domain/task.js')) {
    assert.ok(TASK_FIELDS[key], `validateTask: ${key} ilman kenttää`);
  }
});

// =========================================================== ERR-03

test('ERR-03 KRIITTINEN: vajaa vienti ei väitä onnistuneensa', async () => {
  setDomainLoadStatus('lifeAreas', false);
  setDomainLoadStatus('tasks', true);
  assert.deepEqual(incompleteExportCollections(), ['lifeAreas']);

  const downloads = [];
  const refused = await exportUserData({ confirmFn: async () => false, download: (...args) => downloads.push(args) });
  assert.equal(refused.downloaded, false);
  assert.equal(refused.message, EXPORT_INCOMPLETE_MESSAGE);
  assert.equal(downloads.length, 0, 'vajaa vienti ladattiin kysymättä');

  let asked = null;
  const forced = await exportUserData({
    confirmFn: async options => { asked = options; return true; },
    download: (...args) => downloads.push(args)
  });
  assert.match(asked.confirmLabel, /vajaana/);
  assert.equal(forced.downloaded, true);
  assert.notEqual(forced.message, 'Tiedosto ladattu.');
  assert.match(forced.message, /Vajaa vienti/);
  const file = JSON.parse(downloads[0][1]);
  assert.deepEqual(file.incomplete, ['lifeAreas'], 'tiedosto ei kerro puuttuvista kokoelmista');
});

test('ERR-03: täydellinen vienti ladataan kysymättä, ja poiston esikatselu kertoo vajaista luvuista', async () => {
  const downloads = [];
  const result = await exportUserData({ confirmFn: async () => { throw new Error('ei saa kysyä'); }, download: (...a) => downloads.push(a) });
  assert.equal(result.message, 'Tiedosto ladattu.');
  assert.equal('incomplete' in JSON.parse(downloads[0][1]), false);
  assert.doesNotMatch(localPreviewNote(), /vajaita/);

  setDomainLoadStatus('timeEntries', false);
  assert.match(localPreviewNote(), /Osa tiedoista ei latautunut – luvut voivat olla vajaita\./);
});

// =========================================================== ERR-10

test('ERR-10 KRIITTINEN: kirjauspalkki ei näytä "AppError: …" eikä taulun nimeä', async () => {
  assert.equal(captureReasonText(new AppError('Muutoksen tallennus ei onnistunut.')), 'Muutoksen tallennus ei onnistunut.');
  assert.equal(captureReasonText({}), 'Tuntematon syy.');

  const item = normalizeInboxItem({ id: 'inbox-1', text: 'soita äidille huomenna', source: 'text' });
  addInboxItemToState(item);
  const originalUpdate = inboxRepo.update;
  const originalFetch = globalThis.fetch;
  setClient({ auth: { getSession: async () => ({ data: { session: { access_token: 't' } } }) } });
  inboxRepo.update = async () => fail('Kohdetta ei löytynyt. Päivitä näkymä.', { code: 'memory.missing', op: 'inbox_items' });
  try {
    globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({ error: 'Palvelu ei ole juuri nyt kaytettavissa' }) });
    const http = await interpretItem(item.id);
    assert.equal(http.ok, false);
    assert.equal(http.reason, 'Palvelu ei juuri nyt vastaa. Rivi on tallessa saapuvissa.', 'palvelimen teksti näytettiin');

    globalThis.fetch = async () => ({
      ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: '{"kind":"note","title":"x"}' }] })
    });
    const saved = await interpretItem(item.id);
    assert.equal(saved.ok, false);
    assert.equal(typeof saved.reason, 'string', 'syy ei ole merkkijono');
    assert.doesNotMatch(saved.reason, /AppError|inbox_items/);
  } finally {
    inboxRepo.update = originalUpdate;
    globalThis.fetch = originalFetch;
  }
});

test('ERR-10: kaappaus ja kuitin luku eivät näytä palvelimen body.error-tekstiä', () => {
  for (const source of ['src/app/capture.js', 'src/app/receiptCapture.js']) {
    assert.doesNotMatch(read(source), /body\.error\s*===?|message = body\.error/,
      `${source} näyttää palvelimen body.error-tekstin`);
    assert.match(read(source), /aiEndpointMessage\(response\.status/);
  }
});

test('ERR-10: palvelinten käyttäjälle palauttamissa virheteksteissä on ääkköset', () => {
  const ascii = /\b(pyynto|pyyntoa|paivamaara|viikonpaiva|pitka|kaytettavissa|epaonnistui|Selitettavaa)\b/;
  for (const file of fs.readdirSync(path.join(ROOT, 'api')).filter(name => name.endsWith('.js'))) {
    const returned = [...read(`api/${file}`).matchAll(/error: '([^']*)'/g)].map(m => m[1]);
    for (const text of returned) assert.doesNotMatch(text, ascii, `api/${file}: ${text}`);
  }
});

// =========================================================== ERR-11

/**
 * Supabase-asiakkaan auth-korvike. `clearsOnError`: kirjasto purkaa
 * paikallisen istunnon palvelimen virheestä huolimatta (vendoroitu
 * supabase-js 2.117); false = vanhempi käytös, istunto jää.
 */
function signOutClient(responses, { clearsOnError = false } = {}) {
  const calls = [];
  let session = { access_token: 't' };
  return {
    calls,
    auth: {
      getSession: async () => ({ data: { session }, error: null }),
      signOut: async options => {
        calls.push(options || null);
        const next = responses.shift() || { error: null };
        if (next instanceof Error) throw next;
        if (!next.error || clearsOnError) session = null;
        return next;
      }
    }
  };
}

const OFFLINE_ERROR = { name: 'AuthRetryableFetchError', status: 0, message: 'Failed to fetch' };

test('ERR-11 KRIITTINEN: offline-uloskirjautuminen purkaa istunnon tältä laitteelta ja kertoo sen', async () => {
  // Vanhempi kirjasto: istunto jää verkkovirheessä -> puretaan paikallisesti.
  const notes = [];
  const older = signOutClient([{ error: OFFLINE_ERROR }, { error: null }]);
  assert.deepEqual(await performSignOut(older, { offline: false, announce: note => notes.push(note) }),
    { ok: true, local: true });
  assert.deepEqual(older.calls, [null, { scope: 'local' }]);

  // Vendoroitu 2.117: istunto on jo purettu -> ei toista kutsua, sama viesti.
  const vendored = signOutClient([{ error: OFFLINE_ERROR }], { clearsOnError: true });
  assert.deepEqual(await performSignOut(vendored, { offline: false, announce: note => notes.push(note) }),
    { ok: true, local: true });
  assert.deepEqual(vendored.calls, [null]);
  assert.deepEqual(notes, [SIGNOUT_LOCAL_NOTE, SIGNOUT_LOCAL_NOTE]);

  // Oletus: kirjautumisportti on jo auki (SIGNED_OUT) -> viesti näkyy heti.
  document.getElementById('authGate').classList.add('open');
  await performSignOut(signOutClient([{ error: OFFLINE_ERROR }], { clearsOnError: true }), { offline: false });
  assert.equal(registry.get('authNote').textContent, SIGNOUT_LOCAL_NOTE);
});

test('ERR-11: palvelimen virhe ei ole hiljainen -- istunto jäi tai portti kertoo, ettei palvelin vahvistanut', async () => {
  const notes = [];
  const kept = signOutClient([{ error: { name: 'AuthApiError', status: 500, message: 'Internal' } }]);
  assert.deepEqual(await performSignOut(kept, { offline: false, announce: note => notes.push(note) }), { ok: false });
  assert.deepEqual(kept.calls, [null], 'palvelimen virheestä ei pureta istuntoa omin päin');
  assert.deepEqual(notes, []);

  const cleared = signOutClient([{ error: { name: 'AuthApiError', status: 500, message: 'Internal' } }], { clearsOnError: true });
  assert.deepEqual(await performSignOut(cleared, { offline: false, announce: note => notes.push(note) }),
    { ok: true, local: true });
  assert.deepEqual(notes, [SIGNOUT_UNCONFIRMED_NOTE]);

  // Onnistunut uloskirjautuminen ei jätä huomautusta.
  assert.deepEqual(await performSignOut(signOutClient([{ error: null }]), { offline: false, announce: note => notes.push(note) }),
    { ok: true });
  assert.equal(notes.length, 1);

  const source = read('src/app/auth.js');
  const body = source.slice(source.indexOf('const signOut = singleFlight'), source.indexOf('\n});', source.indexOf('const signOut = singleFlight')));
  assert.match(body, /if \(!outcome\.ok\) showToastError\(SIGNOUT_FAILED_MESSAGE\)/);
  assert.doesNotMatch(body, /console\.(error|warn)/);
});

// =========================================================== ERR-18

test('ERR-18: epäonnistuneen muutoksen syy kerrotaan, ja hylkäyksessä uusintaa ei luvata', () => {
  for (const code of ['invalid_task', 'rejected']) {
    const reason = failedReason(code);
    assert.equal(reason.retryHelps, false, code);
    assert.match(reason.text, /Palvelin ei hyväksynyt muutosta/);
  }
  assert.equal(failedReason('id_collision').retryHelps, false);
  assert.match(failedReason('retries_exhausted').text, /Yhteys katkesi toistuvasti/);
  assert.match(failedReason('unavailable').text, /Palvelu ei vastannut/);
  for (const code of ['invalid_task', 'rejected', 'id_collision', 'retries_exhausted', 'unavailable', 'changed_during_sync', null]) {
    assert.doesNotMatch(failedReason(code).text, /invalid_task|rejected|_/);
  }
});

test('ERR-18: istunnon takia pysähtynyt jono pyytää kirjautumaan', () => {
  const status = { total: 1, pending: 1, syncing: 0, failed: 0, conflict: 0, needsReview: 0, persistent: true, replaying: false };
  const line = describeSyncLine(status, [{ status: OP_STATUS.PENDING, lastErrorCode: 'auth' }], { online: true });
  assert.match(line.text, new RegExp(AUTH_PAUSED_NOTE));
  const plain = describeSyncLine(status, [{ status: OP_STATUS.PENDING, lastErrorCode: 'network' }], { online: true });
  assert.doesNotMatch(plain.text, /Kirjaudu/);
});

// =========================================================== ERR-19

function writerWith({ outbox = [], persistent = true }) {
  let stored = [...outbox];
  return createTimeEntryWriter({
    repo: {
      isPersistent: () => true,
      insert: async () => ({ ok: false, error: { cause: { message: 'TypeError: Failed to fetch', code: '' } } })
    },
    loadOutbox: () => stored,
    saveOutbox: (_, entries) => { stored = entries; return { ok: true, persistent }; },
    userId: () => USER.id
  });
}

test('ERR-19 KRIITTINEN: laitteen tallennuksen puuttuessa jonotettu kirjaus on vain istunnon muistissa', async () => {
  const entry = { id: 'e1', operationId: 'op-1', minutes: 30, entryDate: '2026-09-28' };
  const sessionOnly = await writerWith({ persistent: false }).insert(entry);
  assert.deepEqual(sessionOnly, { ok: true, queued: true, sessionOnly: true });
  const durable = await writerWith({ persistent: true }).insert(entry);
  assert.deepEqual(durable, { ok: true, queued: true, sessionOnly: false });

  announceLogged(30, { queued: true, sessionOnly: true });
  const shown = toasts().map(t => t.text).join('\n');
  assert.match(shown, /tälle istunnolle/);
  assert.match(shown, /Älä sulje sovellusta/);
  assert.doesNotMatch(shown, /Tallentuu, kun yhteys palaa/);
});

test('ERR-19: täysi lähtökori kerrotaan omalla viestillä', async () => {
  const full = Array.from({ length: 200 }, (_, i) => ({ id: 'o' + i, operationId: 'op-o' + i, minutes: 5 }));
  const result = await writerWith({ outbox: full }).insert({ id: 'e2', operationId: 'op-2', minutes: 15 });
  assert.equal(result.ok, false);
  assert.match(result.error.userMessage, /200 lähettämätöntä aikakirjausta/);
  assert.equal(result.error.code, 'timeOutbox.full');
});

// =========================================================== ERR-20

function fakeWindow() {
  const listeners = {};
  return {
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
    removeEventListener: (type, fn) => { listeners[type] = (listeners[type] || []).filter(other => other !== fn); },
    dispatch: (type, event) => (listeners[type] || []).forEach(fn => fn(event))
  };
}

test('ERR-20 KRIITTINEN: käsittelemätön virhe näyttää yhden kiinteän viestin ja kirjaa vain nimen', () => {
  const target = fakeWindow();
  const shown = [];
  const logged = [];
  const detach = installGlobalErrorHandlers(target, { show: message => shown.push(message), log: (...args) => logged.push(args) });
  let prevented = 0;
  const secret = new TypeError('Cannot read properties of null (reading "Salainen pohdinta")');
  target.dispatch('unhandledrejection', { reason: secret, preventDefault: () => { prevented += 1; } });
  target.dispatch('error', { error: secret, message: secret.message, preventDefault: () => { prevented += 1; } });
  // Keskeytetty pyyntö ja selaimen kohina eivät ole virheitä käyttäjälle.
  target.dispatch('unhandledrejection', { reason: Object.assign(new Error('x'), { name: 'AbortError' }) });
  target.dispatch('error', { error: null, message: 'ResizeObserver loop completed with undelivered notifications.' });

  assert.deepEqual(shown, [UNEXPECTED_ERROR_MESSAGE, UNEXPECTED_ERROR_MESSAGE]);
  assert.equal(prevented, 2);
  assert.equal(JSON.stringify(logged).includes('Salainen'), false, 'virheen viesti päätyi lokiin');
  assert.equal(logged[0][0], 'app.unhandled');
  assert.equal(logged[0][1].errorName, 'TypeError');
  detach();
  target.dispatch('unhandledrejection', { reason: secret });
  assert.equal(shown.length, 2);
  assert.match(read('src/app/main.js'), /installGlobalErrorHandlers\(\)/);
});

test('ERR-21: käynnistysvirhe näytetään kiinteänä tekstinä alustan ja verkon mukaan', () => {
  const splash = { innerHTML: '' };
  const printed = [];
  const original = console.error;
  console.error = (...args) => printed.push(JSON.stringify(args));
  try {
    const text = showStartupFailure(new Error('salainen polku /home/x'), { splash, native: true, offline: false });
    assert.equal(text, 'Sovellus ei käynnistynyt. Sulje sovellus ja avaa se uudelleen.');
    assert.match(splash.innerHTML, /Sulje sovellus ja avaa se uudelleen/);
    assert.match(showStartupFailure(new Error('x'), { splash, native: false, offline: true }), /verkkoyhteyttä/);
  } finally {
    console.error = original;
  }
  assert.equal(printed.join('\n').includes('salainen polku'), false);
  assert.doesNotMatch(read('src/app/main.js'), /Päivitä sivu/);
  assert.match(read('src/app/main.js'), /showStartupFailure\(error/);
});
