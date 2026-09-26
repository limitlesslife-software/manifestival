// Suunta-näkymän tallennusten kilpatilanteet (audit: races RACE-04, RACE-05,
// RACE-06, RACE-12, RACE-13, RACE-14, RACE-15; offline-timer F15).
//
// Repositorioiden kutsut korvataan testikohtaisesti (sama tapa kuin
// suunta-day1-fixes F3): testi on sama portin ollessa kiinni tai auki.
// Kello ja setTimeout ovat valekelloja: toastit eivät pidä prosessia hengissä.

import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import { read } from './helpers/sources.mjs';
import { fakeClient } from './helpers/gates.mjs';
import { setUser, clearUser } from '../src/data/session.js';
import { setClient } from '../src/data/client.js';
import {
  resetState, getState, setAlignmentReviews, setWeeklyCapacities, setLifeAreas, setGoals, setTasks, findGoal
} from '../src/app/state.js';
import { clearLocalUserData } from '../src/app/actions.js';
import {
  saveWeeklyReview, saveWeeklyCapacity, applyAdjustment, isAdjustmentDone, deleteLifeArea,
  resetAppliedAdjustments, resetTimeEntrySync, setTimeEntryWriterForTests, logTime
} from '../src/app/alignment.js';
import { alignmentReviewsRepo, weeklyCapacitiesRepo, lifeAreasRepo } from '../src/data/collectionsRepo.js';
import { createTimeEntryWriter } from '../src/app/timeEntryWriter.js';
import { loadOutbox, saveOutbox, resetTimerStoreForTests } from '../src/data/timerStore.js';
import {
  initDirection, renderDirection, resetDirectionView, resetTimeFormForTests, openAreaForm
} from '../src/app/views/direction.js';
import { ADJUSTMENT } from '../src/domain/alignmentReview.js';
import { normalizeLifeArea } from '../src/domain/lifeArea.js';
import { normalizeGoal } from '../src/domain/goal.js';
import { fail } from '../src/lib/result.js';

const USER = { id: 'aaaaaaaa-6161-4161-8161-000000000061', email: 'guards@example.com' };
const WEEK = '2026-09-21';
/** Keskiviikko 23.9.2026 klo 12 paikallista aikaa. */
const WEDNESDAY = new Date(2026, 8, 23, 12, 0).getTime();

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
    dispatch(type, event = {}) { return (listeners[type] || []).map(fn => fn({ target: this, ...event })); },
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
const doc = id => globalThis.document.getElementById(id);
const click = id => Promise.all(doc(id).dispatch('click'));

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

function gate() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
}

/** Korvaa repositorion metodit testin ajaksi; palautus afterEachissa. */
const restores = [];
function stub(repo, methods) {
  for (const [name, fn] of Object.entries(methods)) {
    const original = repo[name];
    repo[name] = fn;
    restores.push(() => { repo[name] = original; });
  }
}

beforeEach(() => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: WEDNESDAY });
  clearUser();
  clearLocalUserData();
  resetState();
  resetTimerStoreForTests();
  resetAppliedAdjustments();
  resetTimeEntrySync();
  resetDirectionView();
  resetTimeFormForTests();
  setTimeEntryWriterForTests(null);
  installStorage();
  installDom();
  setUser(USER);
  setClient(fakeClient({ data: [], error: null }));
});

afterEach(() => {
  while (restores.length) restores.pop()();
  mock.timers.reset();
  setTimeEntryWriterForTests(null);
  delete globalThis.document;
  delete globalThis.CSS;
  delete globalThis.localStorage;
});

// ================================================================ RACE-04

test('RACE-04 KRIITTINEN: kaksoisnapautus "Tallenna katsaus" = yksi tallennus, painike pois käytöstä kesken', async () => {
  const g = gate();
  const calls = [];
  stub(alignmentReviewsRepo, {
    insert: async review => { calls.push('insert'); await g.promise; return { ok: true, value: review }; },
    update: async review => { calls.push('update'); return { ok: true, value: review }; }
  });
  initDirection();
  renderDirection();
  doc('dirReflection').value = 'pohdinta';
  const first = doc('dirReviewSave').dispatch('click');
  const second = doc('dirReviewSave').dispatch('click');
  assert.equal(doc('dirReviewSave').disabled, true, 'painike ei ollut pois käytöstä tallennuksen ajan');
  g.release();
  await Promise.all([...first, ...second]);
  assert.deepEqual(calls, ['insert'], 'toinen napautus teki toisen kantakutsun');
  assert.equal(doc('dirReviewSave').disabled, false);
  assert.equal(doc('dirReviewStatus').textContent, 'Viikkokatsaus tallennettu.');
});

test('RACE-04 KRIITTINEN: kaksoisnapautus "Tallenna kapasiteetti" = yksi tallennus', async () => {
  const g = gate();
  const calls = [];
  stub(weeklyCapacitiesRepo, {
    insert: async capacity => { calls.push('insert'); await g.promise; return { ok: true, value: capacity }; },
    update: async capacity => { calls.push('update'); return { ok: true, value: capacity }; }
  });
  initDirection();
  renderDirection();
  doc('dirCapacityHours').value = '20';
  const first = doc('dirCapacitySave').dispatch('click');
  const second = doc('dirCapacitySave').dispatch('click');
  assert.equal(doc('dirCapacitySave').disabled, true);
  g.release();
  await Promise.all([...first, ...second]);
  assert.deepEqual(calls, ['insert']);
  assert.equal(getState().weeklyCapacities[0].availableMinutes, 1200);
});

test('RACE-04: saman viikon tallennukset jonossa — UPDATE ei ohita kesken olevaa INSERTiä', async () => {
  const g = gate();
  const events = [];
  stub(alignmentReviewsRepo, {
    insert: async review => { events.push('insert:start'); await g.promise; events.push('insert:end'); return { ok: true, value: review }; },
    update: async review => { events.push('update'); return { ok: true, value: review }; }
  });
  const first = saveWeeklyReview({ weekStart: WEEK, reflection: 'eka' });
  const second = saveWeeklyReview({ weekStart: WEEK, reflection: 'toka' });
  await Promise.resolve();
  assert.deepEqual(events, ['insert:start'], 'toinen tallennus alkoi ennen ensimmäisen vastausta');
  g.release();
  assert.equal((await first).ok, true);
  assert.equal((await second).ok, true);
  assert.deepEqual(events, ['insert:start', 'insert:end', 'update']);
  assert.equal(getState().alignmentReviews.length, 1);
  assert.equal(getState().alignmentReviews[0].reflection, 'toka');
});

test('RACE-04 KRIITTINEN: epäonnistunut ensimmäinen tallennus — jonossa odottanut toinen ei väitä onnistuneensa', async () => {
  const g = gate();
  const calls = [];
  stub(alignmentReviewsRepo, {
    insert: async () => { calls.push('insert'); await g.promise; return fail('Tallennus ei onnistunut.'); },
    update: async review => { calls.push('update'); return { ok: true, value: review }; }
  });
  const first = saveWeeklyReview({ weekStart: WEEK, reflection: 'pohdinta' });
  const second = saveWeeklyReview({ weekStart: WEEK, reflection: 'pohdinta' });
  g.release();
  assert.equal((await first).ok, false);
  assert.equal((await second).ok, false, 'toinen päivitti olematonta riviä ja väitti onnistuneensa');
  assert.deepEqual(calls, ['insert', 'insert']);
  assert.equal(getState().alignmentReviews.length, 0);
});

test('RACE-04: päivitys, joka ei osunut riviin (.not_found), luo rivin uudelleen', async () => {
  const calls = [];
  setAlignmentReviews([{ id: 'r-gone', weekStart: WEEK, snapshot: {}, reflection: 'vanha' }]);
  stub(alignmentReviewsRepo, {
    update: async () => { calls.push('update'); return fail('Muutoksen tallennus ei onnistunut.', { code: 'alignment_reviews.not_found' }); },
    insert: async review => { calls.push('insert:' + review.id); return { ok: true, value: review }; }
  });
  const result = await saveWeeklyReview({ weekStart: WEEK, reflection: 'uusi' });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ['update', 'insert:r-gone']);

  const capacityCalls = [];
  setWeeklyCapacities([{ id: 'c-gone', weekStart: WEEK, availableMinutes: 600 }]);
  stub(weeklyCapacitiesRepo, {
    update: async () => { capacityCalls.push('update'); return fail('x', { code: 'weekly_capacities.not_found' }); },
    insert: async capacity => { capacityCalls.push('insert:' + capacity.id); return { ok: true, value: capacity }; }
  });
  assert.equal((await saveWeeklyCapacity({ weekStart: WEEK, availableMinutes: 900 })).ok, true);
  assert.deepEqual(capacityCalls, ['update', 'insert:c-gone']);
});

test('RACE-04: tilassa oleva kapasiteetti, jota tallennus ei tunne, tallentuu (ei "riviä ei löydy")', async () => {
  // Portti kiinni: muistivarasto hylkää puuttuvan rivin päivityksen
  // (memory.missing) -> rivi luodaan. Portti auki: päivitys menee kantaan.
  setWeeklyCapacities([{ id: 'only-in-state', weekStart: WEEK, availableMinutes: 600 }]);
  const result = await saveWeeklyCapacity({ weekStart: WEEK, availableMinutes: 900 });
  assert.equal(result.ok, true);
  assert.deepEqual(getState().weeklyCapacities.map(c => [c.id, c.availableMinutes]), [['only-in-state', 900]]);
});

// ================================================================ RACE-05

test('RACE-05: lataus pyyhki optimistisen katsauksen kesken tallennuksen -> tallennettu palaa tilaan', async () => {
  const g = gate();
  stub(alignmentReviewsRepo, { insert: async review => { await g.promise; return { ok: true, value: review }; } });
  const pending = saveWeeklyReview({ weekStart: WEEK, reflection: 'pohdinta' });
  setAlignmentReviews([]); // lataus, jonka lista haettiin ennen INSERTiä
  g.release();
  const result = await pending;
  assert.equal(result.ok, true);
  assert.deepEqual(getState().alignmentReviews.map(r => r.id), [result.review.id]);
});

test('RACE-05 KRIITTINEN: viikolla on jo katsaus kannassa (23505) -> se päivitetään, eikä jokainen yritys epäonnistu', async () => {
  const calls = [];
  stub(alignmentReviewsRepo, {
    insert: async () => { calls.push('insert'); return fail('Tallennus ei onnistunut.', { cause: { code: '23505' } }); },
    list: async () => {
      calls.push('list');
      return { ok: true, value: [{ id: 'db-1', weekStart: WEEK, reflection: 'aiempi', adjustments: ['x'], reflectionAnswers: { plan: 'vanha' } }] };
    },
    update: async review => { calls.push('update:' + review.id); return { ok: true, value: review }; }
  });
  const result = await saveWeeklyReview({ weekStart: WEEK, reflection: 'uusi pohdinta' });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ['insert', 'list', 'update:db-1']);
  const [saved] = getState().alignmentReviews;
  assert.equal(getState().alignmentReviews.length, 1);
  assert.equal(saved.id, 'db-1');
  assert.equal(saved.reflection, 'uusi pohdinta', 'käyttäjän kirjoittama voittaa');
  assert.deepEqual(saved.adjustments, ['x'], 'tallennetut muutokset säilyvät');
});

test('RACE-05: sama kapasiteetille (23505 -> olemassa olevan rivin päivitys)', async () => {
  const calls = [];
  stub(weeklyCapacitiesRepo, {
    insert: async () => { calls.push('insert'); return fail('Tallennus ei onnistunut.', { cause: { code: '23505' } }); },
    list: async () => { calls.push('list'); return { ok: true, value: [{ id: 'db-c', weekStart: WEEK, availableMinutes: 600, energyLevel: 3 }] }; },
    update: async capacity => { calls.push('update:' + capacity.id); return { ok: true, value: capacity }; }
  });
  const result = await saveWeeklyCapacity({ weekStart: WEEK, availableMinutes: 1500 });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, ['insert', 'list', 'update:db-c']);
  assert.deepEqual(getState().weeklyCapacities.map(c => [c.id, c.availableMinutes, c.energyLevel]), [['db-c', 1500, 3]]);
});

// ================================================================ RACE-06

test('RACE-06 KRIITTINEN: sunnuntaina kirjoitettu katsaus ja kapasiteetti tallentuvat näkyvissä olleelle viikolle maanantaina', async () => {
  mock.timers.setTime(new Date(2026, 8, 27, 23, 55).getTime()); // su 27.9. klo 23.55
  initDirection();
  renderDirection();
  assert.equal(doc('dirWeekLabel').textContent, '21.9.–27.9.2026');
  doc('dirReflection').value = 'Sunnuntain pohdinta';
  doc('dirCapacityHours').value = '20';
  mock.timers.setTime(new Date(2026, 8, 28, 0, 2).getTime()); // ma 28.9. klo 0.02
  await click('dirReviewSave');
  await click('dirCapacitySave');
  assert.deepEqual(getState().alignmentReviews.map(r => r.weekStart), ['2026-09-21'], 'katsaus meni väärälle viikolle');
  assert.deepEqual(getState().weeklyCapacities.map(c => c.weekStart), ['2026-09-21'], 'kapasiteetti meni väärälle viikolle');
});

test('RACE-06: keskeneräinen katsaus kiinnittää viikon — keskiyön jälkeinen päivitys ei vaihda viikkoa sen alta', async () => {
  mock.timers.setTime(new Date(2026, 8, 27, 23, 55).getTime());
  initDirection();
  renderDirection();
  doc('dirReflection').value = 'Kesken';
  doc('dirReflection').dispatch('input');
  mock.timers.setTime(new Date(2026, 8, 28, 0, 2).getTime());
  renderDirection(); // esim. datan päivitys keskiyön jälkeen
  assert.equal(doc('dirWeekLabel').textContent, '21.9.–27.9.2026', 'näkymä hyppäsi uudelle viikolle');
  await click('dirReviewSave');
  assert.deepEqual(getState().alignmentReviews.map(r => r.weekStart), ['2026-09-21']);
});

test('RACE-06: selattu viikko on tallennuksen viikko (regressio)', async () => {
  initDirection();
  renderDirection();
  await click('dirPrev');
  assert.equal(doc('dirWeekLabel').textContent, '14.9.–20.9.2026');
  doc('dirCapacityHours').value = '15';
  await click('dirCapacitySave');
  assert.deepEqual(getState().weeklyCapacities.map(c => c.weekStart), ['2026-09-14']);
});

// ================================================================ RACE-13

test('RACE-13: datan päivitys ei ylikirjoita tallentamatonta kapasiteettia; tallennus vapauttaa kentän', async () => {
  stub(weeklyCapacitiesRepo, {
    insert: async capacity => ({ ok: true, value: capacity }),
    update: async capacity => ({ ok: true, value: capacity })
  });
  initDirection();
  renderDirection();
  const hours = doc('dirCapacityHours');
  const energy = doc('dirEnergy');
  hours.value = '30';
  hours.dispatch('input');
  energy.value = '4';
  energy.dispatch('change');
  setWeeklyCapacities([{ id: 'c1', weekStart: WEEK, availableMinutes: 1200, energyLevel: 2 }]);
  renderDirection(); // päivitys piirtää näkymän, fokus muualla
  assert.equal(hours.value, '30', 'tallentamaton arvo katosi');
  assert.equal(energy.value, '4');
  await click('dirCapacitySave');
  assert.equal(hours.dataset.dirty, undefined);
  setWeeklyCapacities([{ id: 'c1', weekStart: WEEK, availableMinutes: 600, energyLevel: 2 }]);
  renderDirection();
  assert.equal(hours.value, '10', 'tallennuksen jälkeen kenttä seuraa taas tilaa');
  assert.equal(energy.value, '2');
});

// ================================================================ RACE-14 / F15

test('RACE-14/F15 KRIITTINEN: uloskirjautuminen tyhjentää pohdinnan, aikalomakkeen ja kapasiteetin', async () => {
  const operations = [];
  setTimeEntryWriterForTests(createTimeEntryWriter({
    repo: { isPersistent: () => true, insert: async e => { operations.push(e.operationId); return fail('x', { cause: { code: '23514' } }); } },
    loadOutbox, saveOutbox, userId: () => USER.id
  }));
  initDirection();
  renderDirection();
  const reflection = doc('dirReflection');
  reflection.value = 'A:n pohdinta';
  reflection.dispatch('input');
  doc('dirTimeNote').value = 'A:n muistiinpano';
  doc('dirTimeMinutes').value = '45';
  doc('dirTimeDate').value = WEEK;
  doc('dirCapacityHours').value = '12';
  doc('dirCapacityHours').dispatch('input');
  await click('dirTimeSave'); // hylätty: lomakkeen tunniste jää talteen

  resetDirectionView();
  for (const id of ['dirReflection', 'dirTimeNote', 'dirTimeMinutes', 'dirCapacityHours']) {
    assert.equal(doc(id).value, '', `${id} jäi seuraavalle käyttäjälle`);
    assert.equal(doc(id).dataset.dirty, undefined, `${id}: likaisuus jäi`);
  }

  // Seuraavan käyttäjän kirjaus on uusi kirjaus, ei edellisen jatko.
  doc('dirTimeDate').value = WEEK;
  doc('dirTimeMinutes').value = '30';
  await click('dirTimeSave');
  assert.equal(operations.length, 2);
  assert.notEqual(operations[1], operations[0], 'edellisen käyttäjän operaatiotunniste jatkui');

  // Tallennettu katsaus näkyy taas seuraavalle käyttäjälle (kenttä ei ole "likainen").
  setAlignmentReviews([{ id: 'b-review', weekStart: WEEK, snapshot: {}, reflection: 'B:n oma' }]);
  renderDirection();
  assert.equal(reflection.value, 'B:n oma');
});

// ================================================================ RACE-15

test('RACE-15: alueen tallennuksen kaksoisnapautus = yksi alue, ei harhaanjohtavaa nimivirhettä', async () => {
  const g = gate();
  let inserts = 0;
  stub(lifeAreasRepo, { insert: async area => { inserts += 1; await g.promise; return { ok: true, value: area }; } });
  initDirection();
  openAreaForm(null);
  doc('dirAreaName').value = 'Terveys';
  doc('dirAreaImportance').value = '4';
  doc('dirAreaTarget').value = '';
  const first = doc('dirAreaSave').dispatch('click');
  const second = doc('dirAreaSave').dispatch('click');
  assert.equal(doc('dirAreaSave').disabled, true);
  g.release();
  await Promise.all([...first, ...second]);
  assert.equal(inserts, 1);
  assert.equal(getState().lifeAreas.length, 1);
  assert.equal(doc('dirAreaNameError').textContent, '', 'toinen napautus näytti "jo tämänniminen alue"');
});

test('RACE-15: alueen poiston palautus lukee tilan vahvistuksen JÄLKEEN', async () => {
  setLifeAreas([normalizeLifeArea({ id: 'a1', name: 'Terveys', importance: 4 })]);
  setGoals([normalizeGoal({ id: 'g1', title: 'Juoksu', lifeAreaId: 'a1' })]);
  stub(lifeAreasRepo, { remove: async () => fail('Poisto ei onnistunut.') });
  const deleted = await deleteLifeArea('a1', {
    confirmFn: async () => {
      // Dialogin aikana valmistunut lataus toi alueelle uuden tavoitteen.
      setGoals([...getState().goals, normalizeGoal({ id: 'g2', title: 'Uinti', lifeAreaId: 'a1' })]);
      return true;
    }
  });
  assert.equal(deleted, false);
  assert.equal(findGoal('g1').lifeAreaId, 'a1');
  assert.equal(findGoal('g2').lifeAreaId, 'a1', 'palautus rakennettiin vanhasta tilannekuvasta');
  assert.equal(getState().lifeAreas.length, 1);
});

// ================================================================ F9 merkintä

test('F9: lähtökorissa odottava kirjaus on merkitty listaan, lähetetty ei', async () => {
  let online = false;
  setTimeEntryWriterForTests(createTimeEntryWriter({
    repo: {
      isPersistent: () => true,
      insert: async e => (online ? { ok: true, value: e } : { ok: false, error: { cause: { message: 'Failed to fetch' } } })
    },
    loadOutbox, saveOutbox, userId: () => USER.id
  }));
  await logTime({ entryDate: WEEK, minutes: 25, operationId: 'log:marker-a' }, { silent: true });
  online = true;
  await logTime({ entryDate: WEEK, minutes: 10, operationId: 'log:marker-b' }, { silent: true });
  initDirection();
  renderDirection();
  const rows = doc('dirTimeList').innerHTML.split('class="assist-row"').slice(1);
  assert.equal(rows.length, 2);
  assert.equal(rows.filter(row => row.includes('Odottaa lähetystä')).length, 1);
  assert.ok(rows.find(row => row.includes('25 min')).includes('Odottaa lähetystä'));
});

// ================================================================ RACE-12

const createTaskProposal = () => ({
  id: 'create_task:a1', type: ADJUSTMENT.CREATE_TASK, label: 'Lisää ensi viikolle: Liiku',
  payload: { title: 'Liiku 30 min', date: '2026-09-28', durationMinutes: 30, goalId: null }
});

test('RACE-12 KRIITTINEN: tallennettu katsaus estää saman tehtävän luonnin uudelleen latauksen jälkeen', async () => {
  const confirmFn = async () => true;
  const first = await applyAdjustment(createTaskProposal(), { confirmFn, weekStart: WEEK });
  assert.equal(first.applied, true);
  assert.equal(getState().tasks.length, 1);
  // Katsaus tallennetaan vasta toteutuksen jälkeen: toteutus kirjataan siihen.
  await saveWeeklyReview({ weekStart: WEEK });
  assert.deepEqual(getState().alignmentReviews[0].adjustments, ['create_task:a1']);
  // "Uudelleenlataus": istunnon muisti tyhjä, tehtävää ei (vielä) tilassa.
  resetAppliedAdjustments();
  setTasks([]);
  assert.equal(isAdjustmentDone(createTaskProposal(), WEEK), true);
  let asked = false;
  const again = await applyAdjustment(createTaskProposal(), { confirmFn: async () => { asked = true; return true; }, weekStart: WEEK });
  assert.equal(again.duplicate, true);
  assert.equal(asked, false, 'jo toteutetusta ei kysytä uudelleen');
  assert.equal(getState().tasks.length, 0, 'toinen tehtävä luotiin');
});

test('RACE-12: ilman katsaustakaan sama tehtävä (otsikko + päivä) ei synny kahdesti', async () => {
  const confirmFn = async () => true;
  assert.equal((await applyAdjustment(createTaskProposal(), { confirmFn })).applied, true);
  resetAppliedAdjustments();
  const again = await applyAdjustment(createTaskProposal(), { confirmFn });
  assert.equal(again.duplicate, true);
  assert.equal(getState().tasks.length, 1);
  // Toinen viikko, eri päivä: uusi tehtävä on sallittu.
  const later = createTaskProposal();
  later.payload = { ...later.payload, date: '2026-10-05' };
  assert.equal((await applyAdjustment(later, { confirmFn })).applied, true);
  assert.equal(getState().tasks.length, 2);
});
