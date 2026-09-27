// Sunnuntain nollaus (aalto L): viikon sulkeminen vaihe kerrallaan.
//
// A kirjaa → B saapuvat → C kapasiteetti → D enintään 3 prioriteettia →
// E sijoita välttämätön → F suojaa oma/vapaa-aika → G sulje viikko.
//
// Näkymä ajetaan oikeassa (jäsennetyssä) index.html-DOMissa
// (tests/helpers/a11yDom.mjs): dialogi, painikkeet, fokus ja Escape
// käyttäytyvät kuten selaimessa. Tallennukset kulkevat porttitietoisen
// varaston kautta (tests/helpers/gateAwareStore.mjs): kiinni olevalla
// portilla muistiin, auki olevalla muistinvaraiselle palvelimelle.
// Kello jäädytetään.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { read } from './helpers/sources.mjs';
import { freezeLocalDate } from './helpers/clock.mjs';
import { createDocument, installDocument, accessibleName, press, type, choose } from './helpers/a11yDom.mjs';
import { resetTestStore, storedRow, storedRows, testStore } from './helpers/gateAwareStore.mjs';
import { setUser, clearUser } from '../src/data/session.js';
import { setClient } from '../src/data/client.js';
import {
  resetState, getState, setTasks, setGoals, setLifeAreas, setProtectedPeriods, setInboxItems, setCalendarEvents
} from '../src/app/state.js';
import { clearLocalUserData } from '../src/app/actions.js';
import { resetAppliedAdjustments } from '../src/app/alignment.js';
import { resetDailyLifeActions } from '../src/app/dailyLifeActions.js';
import { insertTask } from '../src/data/tasksRepo.js';
import { weeklyPlansRepo, protectedPeriodsRepo, weeklyCapacitiesRepo, inboxRepo } from '../src/data/collectionsRepo.js';
import { brakedHorizonCapacity } from '../src/app/capacityBrake.js';
import { closeWeek } from '../src/app/mentalLoadActions.js';
import { initDirection, resetDirectionView } from '../src/app/views/direction.js';
import {
  SUNDAY_RESET_STEPS, SUNDAY_RESET_FINAL_COPY, SUNDAY_RESET_FINAL_TITLE, SUNDAY_RESET_FINAL_TEXT,
  PRIORITY_LIMIT_MESSAGE, NOT_FITTING_MESSAGE,
  sundayResetTargetWeek, shouldShowSundayResetEntry, inboxStepModel, capacityStepModel, priorityCandidates,
  togglePriority, placementPlan, plannedMinutesForWeek, protectStepModel, addFreeEvening, addOwnTimeSlot,
  openSundayReset, closeSundayReset, resetSundayReset, renderSundayResetEntry, sundayResetSession,
  isSundayResetOpen, rebindSundayResetForTests, linkedToPriorities
} from '../src/app/views/sundayReset.js';
import { normalizeTask } from '../src/domain/task.js';
import { normalizeGoal } from '../src/domain/goal.js';
import { normalizeLifeArea } from '../src/domain/lifeArea.js';
import { normalizeInboxItem } from '../src/domain/inbox.js';
import { normalizeProtectedPeriod, periodBlocks } from '../src/domain/protectedTime.js';
import { isMovable } from '../src/domain/planScheduler.js';
import { isSchedulable, schedulingContext } from '../src/domain/lifeLoad.js';

const USER = { id: 'dddddddd-5555-4555-8555-00000000005e', email: 'nollaus@example.invalid' };
const SUNDAY = '2026-10-04';
const WEEK = '2026-10-05';
const WEEK_END = '2026-10-11';
const HTML = read('index.html');

let doc;
let uninstall;

const flush = async (rounds = 30) => { for (let i = 0; i < rounds; i++) await new Promise(resolve => setImmediate(resolve)); };
const $ = id => doc.getElementById(id);
const card = () => $('sundayResetCard');
const cardText = () => card().textContent.replace(/\s+/g, ' ').trim();
const primary = () => card().querySelector('[data-focus="primary"]');
const buttonByText = text => card().querySelectorAll('button').find(button => button.textContent.replace(/\s+/g, ' ').trim() === text);
const stepKey = () => sundayResetSession() && sundayResetSession().step;

async function click(node) {
  assert.ok(node, 'painiketta ei löytynyt');
  node.click();
  await flush();
}

beforeEach(() => {
  doc = createDocument(HTML);
  uninstall = installDocument(doc);
  clearUser();
  clearLocalUserData();
  resetState();
  resetAppliedAdjustments();
  resetDailyLifeActions();
  resetDirectionView();
  resetSundayReset();
  setUser(USER);
  // Tehtävät kulkevat aina asiakkaan kautta (tasks on tuotannossa auki):
  // sama muistinvarainen palvelin kummallakin porttitilalla.
  resetTestStore();
  setClient(testStore);
  rebindSundayResetForTests();
});

afterEach(() => {
  resetSundayReset();
  uninstall();
});

const task = (id, fields = {}) => normalizeTask({ id, title: 'Tehtävä ' + id, date: null, durationMinutes: 60, ...fields });

async function seedTasks(tasks) {
  for (const entry of tasks) {
    const result = await insertTask(entry);
    assert.ok(result.ok, `siemen ${entry.id} hylättiin`);
  }
  setTasks(tasks);
}

function fixedTasksFor(state, weekStart) {
  const ctx = schedulingContext({ goals: state.goals, projects: state.projects, todayIso: weekStart });
  return state.tasks.filter(t => !(t && !t.completed && isMovable(t) && isSchedulable(t, ctx)));
}

function storedTask(id) {
  return testStore.rows('tasks').find(row => row.id === id);
}

// ================================================================ KOHDEVIIKKO

test('kohdeviikko: sunnuntaina ja lauantaina seuraava ISO-viikko, keskiviikkona myös', () => {
  assert.deepEqual(sundayResetTargetWeek(SUNDAY, 20 * 60), { weekStart: WEEK, weekEnd: WEEK_END, current: false });
  assert.deepEqual(sundayResetTargetWeek('2026-10-03', 10 * 60), { weekStart: WEEK, weekEnd: WEEK_END, current: false });
  assert.equal(sundayResetTargetWeek('2026-10-07', 9 * 60).weekStart, '2026-10-12');
});

test('kohdeviikko: maanantaina ennen klo 12 kuluva viikko, iltapäivällä seuraava', () => {
  assert.deepEqual(sundayResetTargetWeek(WEEK, 9 * 60), { weekStart: WEEK, weekEnd: WEEK_END, current: true });
  assert.equal(sundayResetTargetWeek(WEEK, 13 * 60).weekStart, '2026-10-12');
  assert.equal(sundayResetTargetWeek('ei päivä'), null);
});

// ================================================================ TÄNÄÄN-KORTTI

test('kortti: näkyy la/su ja maanantaiaamuna, kun kohdeviikkoa ei ole suljettu; muulloin ei', () => {
  const state = getState();
  assert.equal(shouldShowSundayResetEntry(state, { todayIso: SUNDAY, nowMinutes: 600 }), true);
  assert.equal(shouldShowSundayResetEntry(state, { todayIso: '2026-10-03', nowMinutes: 600 }), true);
  assert.equal(shouldShowSundayResetEntry(state, { todayIso: WEEK, nowMinutes: 9 * 60 }), true, 'maanantaiaamu');
  assert.equal(shouldShowSundayResetEntry(state, { todayIso: WEEK, nowMinutes: 14 * 60 }), false, 'maanantai-iltapäivä');
  assert.equal(shouldShowSundayResetEntry(state, { todayIso: '2026-10-07', nowMinutes: 600 }), false, 'keskiviikko');
});

test('kortti: suljettu viikko piilottaa kortin (ei pysyvää muistutusta)', async (t) => {
  freezeLocalDate(t, SUNDAY);
  const container = $('dirPersistNote');
  assert.equal(renderSundayResetEntry(container, { now: new Date() }), true);
  assert.match(container.textContent, /Sulje viikko — 10 minuuttia/);
  const result = await closeWeek(WEEK, { priorities: [], plannedMinutes: 0 });
  assert.ok(result.ok);
  assert.equal(renderSundayResetEntry(container, { now: new Date() }), false);
  assert.equal(container.hidden, true);
  assert.equal(container.textContent.trim(), '');
});

test('kortti: #sundayResetOpenBtn avaa nollauksen dialogiin', async (t) => {
  freezeLocalDate(t, SUNDAY);
  const container = $('dirPersistNote');
  renderSundayResetEntry(container, { now: new Date() });
  const button = container.querySelector('#sundayResetOpenBtn');
  assert.equal(accessibleName(button), 'Aloita viikon sulkeminen');
  await click(button);
  assert.equal($('sundayResetDialog').open, true);
  assert.equal(stepKey(), 'dump');
});

// ================================================================ DIALOGI JA SAAVUTETTAVUUS

test('HTML: Suunnan painike ja dialogi ovat olemassa, dialogi on Tänään-osion ulkopuolella', () => {
  const today = HTML.slice(HTML.indexOf('id="screen-today"'), HTML.indexOf('</section>', HTML.indexOf('id="screen-today"')));
  assert.equal(today.includes('sundayReset'), false, 'Tänään-osioon ei kosketa');
  const direction = HTML.slice(HTML.indexOf('id="screen-direction"'), HTML.indexOf('</section>', HTML.indexOf('id="screen-direction"')));
  assert.match(direction, /id="dirSundayResetBtn" type="button">Sulje viikko/);
  assert.match(HTML, /<dialog class="confirm-dialog sunday-reset-dialog" id="sundayResetDialog" aria-labelledby="sundayResetTitle" aria-describedby="sundayResetStepLabel">/);
  assert.match(HTML, /id="sundayResetResume" type="button" hidden>Palaa nollaukseen</);
});

test('Suunnan painike avaa nollauksen: vaihe 1/7, otsikko fokusoitu ja nimeää dialogin', async (t) => {
  freezeLocalDate(t, SUNDAY);
  initDirection();
  await click($('dirSundayResetBtn'));
  const dialog = $('sundayResetDialog');
  assert.equal(dialog.open, true);
  assert.equal(isSundayResetOpen(), true);
  assert.match($('sundayResetStepLabel').textContent, /^Vaihe 1\/7 · Kirjaa mielestä · viikko 5\.10\.–11\.10\.$/);
  assert.equal(doc.activeElement, $('sundayResetTitle'), 'otsikko saa fokuksen');
  assert.equal(accessibleName(dialog), 'Mitä sinulla on mielessä?');
  // Jokaisella painikkeella on selkeä nimi; ei pelkkää kuvaketta.
  for (const button of dialog.querySelectorAll('button')) {
    assert.ok(accessibleName(button).length > 3, `nimetön painike: ${button.outerHTML.slice(0, 80)}`);
  }
  assert.equal(accessibleName($('sundayResetClose')), 'Sulje nollaus (eteneminen säilyy)');
});

test('Escape sulkee, eteneminen säilyy muistissa ja jatkuu samasta vaiheesta', async (t) => {
  freezeLocalDate(t, SUNDAY);
  openSundayReset();
  await click(primary()); // A tyhjänä -> Seuraava
  assert.equal(stepKey(), 'sort');
  $('sundayResetTitle').focus();
  press(doc, 'Escape');
  await flush();
  assert.equal($('sundayResetDialog').open, false);
  assert.equal(isSundayResetOpen(), false);
  openSundayReset();
  assert.equal(stepKey(), 'sort', 'jatkuu siitä mihin jäi');
  assert.match($('sundayResetStepLabel').textContent, /^Vaihe 2\/7/);
});

test('vaiheen vaihto siirtää fokuksen otsikkoon; Takaisin palaa', async (t) => {
  freezeLocalDate(t, SUNDAY);
  openSundayReset();
  await click(buttonByText('Ohita tämä vaihe'));
  assert.equal(stepKey(), 'sort');
  assert.equal(doc.activeElement, $('sundayResetTitle'));
  await click(buttonByText('Takaisin'));
  assert.equal(stepKey(), 'dump');
  assert.equal(doc.activeElement, $('sundayResetTitle'));
});

test('istuntomuistin vihje näkyy kerran, kun viikkosuunnitelma tai suojattu aika ei ole pysyvä', async (t) => {
  freezeLocalDate(t, SUNDAY);
  const volatile = !weeklyPlansRepo.isPersistent() || !protectedPeriodsRepo.isPersistent();
  openSundayReset();
  assert.equal(/säilyvät toistaiseksi vain tämän istunnon ajan/.test(cardText()), volatile);
  closeSundayReset();
  openSundayReset({ fresh: true });
  assert.equal(/säilyvät toistaiseksi vain tämän istunnon ajan/.test(cardText()), false, 'vain kerran');
});

// ================================================================ A: KIRJAA

test('A: monirivinen kirjaus -> monta saapuvaa riviä ilman päätöksiä, ja siirrytään saapuviin', async (t) => {
  freezeLocalDate(t, SUNDAY);
  openSundayReset();
  const area = $('sundayResetDump');
  assert.equal(accessibleName(area), 'Mitä sinulla on mielessä? Yksi asia riville.');
  type(area, 'Soita neuvolaan\nAuton katsastus\n\nLahja Annille');
  assert.equal(primary().textContent, 'Kirjaa saapuviin', 'pääpainike päivittyy kirjoittaessa');
  await click(primary());
  const items = getState().inboxItems;
  assert.deepEqual(items.map(item => item.text).sort(), ['Auton katsastus', 'Lahja Annille', 'Soita neuvolaan']);
  assert.ok(items.every(item => item.status === 'unprocessed'), 'ei tulkintaa kirjaushetkellä');
  assert.equal((await storedRows(inboxRepo)).length, 3);
  assert.equal(stepKey(), 'sort');
  assert.match(cardText(), /Kirjattu 3 asiaa saapuviin\. Ne ovat tallessa\./);
});

test('A: ohitus ei kirjaa mitään', async (t) => {
  freezeLocalDate(t, SUNDAY);
  openSundayReset();
  await click(buttonByText('Ohita tämä vaihe'));
  assert.equal(getState().inboxItems.length, 0);
  assert.equal(stepKey(), 'sort');
});

// ================================================================ B: SAAPUVAT

test('B: luku ja enintään viisi riviä, loput yhtenä lukuna', async (t) => {
  freezeLocalDate(t, SUNDAY);
  setInboxItems(Array.from({ length: 8 }, (_, i) => normalizeInboxItem({
    id: `in${i}`, text: `Asia ${i}`, status: 'unprocessed', capturedAt: `2026-10-0${1 + (i % 3)}T10:0${i}:00Z`
  })));
  const model = inboxStepModel(getState());
  assert.equal(model.count, 8);
  assert.equal(model.shown.length, 5);
  assert.equal(model.more, 3);
  openSundayReset({ step: 'sort' });
  assert.equal(card().querySelectorAll('li').length, 5);
  assert.match(cardText(), /Saapuvissa odottaa 8 asiaa/);
  assert.match(cardText(), /ja 3 muuta tallessa\./);
  assert.ok(buttonByText('Jätä myöhemmäksi — ne ovat tallessa'));
});

test('B: "Järjestä saapuvat" vie Tekeminen → Saapuvat ja "Palaa nollaukseen" tuo takaisin', async (t) => {
  freezeLocalDate(t, SUNDAY);
  setInboxItems([normalizeInboxItem({ id: 'in1', text: 'Asia', status: 'unprocessed', capturedAt: '2026-10-03T10:00:00Z' })]);
  openSundayReset({ step: 'sort' });
  await click(buttonByText('Järjestä saapuvat'));
  assert.equal($('sundayResetDialog').open, false);
  assert.equal(getState().screen, 'screen-tasks');
  assert.equal(getState().tasksSegment, 'inbox');
  const resume = $('sundayResetResume');
  assert.equal(resume.hidden, false);
  assert.equal(doc.activeElement, resume, 'fokus paluunappiin, ei piiloon jääneeseen Suuntaan');
  await click(resume);
  assert.equal($('sundayResetDialog').open, true);
  assert.equal(stepKey(), 'sort');
  assert.equal(resume.hidden, true);
});

// ================================================================ C: KAPASITEETTI

function protectedWeekState() {
  setProtectedPeriods([
    normalizeProtectedPeriod({ id: 'own', kind: 'OWN_TIME', recurrence: 'weekly', weekdays: [2], startTime: '18:00', endTime: '20:00', title: 'Oma aika' }),
    normalizeProtectedPeriod({ id: 'vac', kind: 'VACATION', recurrence: 'once', startDate: '2026-10-10', endDate: '2026-10-11', title: 'Mökki' })
  ]);
}

test('C: luku on täsmälleen kapasiteettijarrun luku ja erittely laskee yhteen', (t) => {
  freezeLocalDate(t, SUNDAY);
  protectedWeekState();
  setCalendarEvents([{ id: 'ev1', title: 'Hammaslääkäri', date: '2026-10-06', startTime: '10:00', durationMinutes: 60 }]);
  const state = getState();
  const model = capacityStepModel(state, { weekStart: WEEK, todayIso: SUNDAY });
  const braked = brakedHorizonCapacity(state, { from: WEEK, to: WEEK_END, todayIso: SUNDAY, tasks: fixedTasksFor(state, WEEK) });
  assert.equal(model.totalMinutes, braked.capacity.totalUsableMinutes);
  const b = model.breakdown;
  assert.equal(b.awakeMinutes - b.calendarMinutes - b.protectedMinutes - b.bufferMinutes - b.sleepAdjustMinutes
    - b.reservedFreeMinutes - b.shortGapMinutes, model.totalMinutes, 'erittely laskee yhteen');
  assert.equal(b.vacationDays, 2);
  assert.ok(b.protectedMinutes >= 120 + 2 * 8 * 60, 'oma aika ja loma on varattu');
  assert.ok(b.calendarMinutes >= 60, 'kiinteä meno on varattu');
  for (const day of model.days.filter(d => d.vacation)) assert.equal(day.usableMinutes, 0, 'lomalla ei joustavaa aikaa');
});

test('C: näkymä näyttää luvun ja syyt; −1 h ja tallennus kirjoittavat viikon kapasiteetin', async (t) => {
  freezeLocalDate(t, SUNDAY);
  protectedWeekState();
  openSundayReset({ step: 'capacity' });
  const model = capacityStepModel(getState(), { weekStart: WEEK, todayIso: SUNDAY });
  assert.match(cardText(), /Mistä luku tulee/);
  assert.match(cardText(), /Kalenteri, kiinteät tehtävät, rutiinit ja matkat/);
  assert.match(cardText(), /Suojattu oma aika, vapaa-aika ja loma \(2 lomapäivää\)/);
  assert.match(cardText(), /Puskuri yllätyksille \(25 %\)/);
  const input = $('sundayResetCapacity');
  const start = Number(input.value);
  assert.equal(start, Math.round((model.totalMinutes / 60) * 2) / 2);
  await click(buttonByText('−1 h'));
  assert.equal(Number($('sundayResetCapacity').value), start - 1);
  await click(primary());
  const saved = getState().weeklyCapacities.find(c => c.weekStart === WEEK);
  assert.equal(saved.availableMinutes, Math.round((start - 1) * 60));
  assert.equal((await storedRow(weeklyCapacitiesRepo, saved.id)).availableMinutes, saved.availableMinutes);
  assert.equal(stepKey(), 'priorities');
});

test('C: virheellinen tuntimäärä ei tallennu ja kertoo syyn', async (t) => {
  freezeLocalDate(t, SUNDAY);
  openSundayReset({ step: 'capacity' });
  type($('sundayResetCapacity'), '500');
  await click(primary());
  assert.equal(getState().weeklyCapacities.length, 0);
  assert.equal(stepKey(), 'capacity');
  assert.match($('sundayResetError').textContent, /0–168/);
  assert.ok(card().contains(doc.activeElement), 'fokus pysyy nollauksessa, ei putoa <body>:yyn');
});

// ================================================================ D: PRIORITEETIT

test('D: togglePriority sallii enintään kolme; neljäs antaa rauhallisen viestin eikä pudota mitään', () => {
  let selected = [];
  for (const title of ['Yksi', 'Kaksi', 'Kolme']) selected = togglePriority(selected, { ref: 'text', title }).selected;
  const fourth = togglePriority(selected, { ref: 'goal:g4', title: 'Neljä' });
  assert.equal(fourth.limited, true);
  assert.equal(fourth.message, PRIORITY_LIMIT_MESSAGE);
  assert.equal(PRIORITY_LIMIT_MESSAGE, 'Valitse enintään kolme. Loput ovat tallessa.');
  assert.deepEqual(fourth.selected.map(e => e.title), ['Yksi', 'Kaksi', 'Kolme']);
  const removed = togglePriority(fourth.selected, { ref: 'text', title: 'kaksi' });
  assert.deepEqual(removed.selected.map(e => e.title), ['Yksi', 'Kolme'], 'sama teksti eri kirjainkoolla poistaa');
});

function priorityState() {
  setGoals([1, 2, 3, 4, 5].map(i => normalizeGoal({ id: `g${i}`, title: `Tavoite ${i}`, status: 'active' }))
    .concat([normalizeGoal({ id: 'gp', title: 'Tauolla', status: 'paused' })]));
  setLifeAreas([normalizeLifeArea({ id: 'a1', name: 'Perhe', importance: 5, active: true })]);
  setTasks([
    task('due1', { deadline: '2026-10-07' }),
    task('due2', { date: '2026-10-08' }),
    task('far', { deadline: '2026-11-30' })
  ]);
}

test('D: ehdokkaat ovat rajattuja (enintään 3 ryhmää kohti) ja loput kerrotaan lukuna', () => {
  priorityState();
  const result = priorityCandidates(getState(), { weekStart: WEEK, todayIso: SUNDAY });
  const byGroup = Object.fromEntries(result.groups.map(g => [g.key, g.items]));
  assert.deepEqual(byGroup.due.map(i => i.ref), ['task:due1', 'task:due2'], 'vain kohdeviikolla erääntyvät');
  assert.equal(byGroup.goals.length, 3);
  assert.ok(byGroup.goals.every(i => i.ref.startsWith('goal:') && i.ref !== 'goal:gp'), 'tauolla oleva ei ole ehdokas');
  assert.deepEqual(byGroup.areas.map(i => i.ref), ['area:a1']);
  assert.equal(result.more, 2, 'kaksi tavoitetta tallessa');
});

test('D: neljäs valinta näyttää viestin, valinta pysyy kolmessa; tallennus kirjoittaa viikkosuunnitelman', async (t) => {
  freezeLocalDate(t, SUNDAY);
  priorityState();
  openSundayReset({ step: 'priorities' });
  const chips = () => card().querySelectorAll('[data-reset-priority]');
  assert.ok(chips().every(chip => chip.getAttribute('aria-pressed') === 'false' && chip.textContent.startsWith('+ ')));
  for (const index of [0, 1, 2, 3]) await click(chips()[index]);
  assert.equal(sundayResetSession().selected.length, 3);
  assert.equal($('sundayResetLimit').textContent, PRIORITY_LIMIT_MESSAGE);
  assert.equal(chips().filter(chip => chip.getAttribute('aria-pressed') === 'true').length, 3);
  assert.ok(chips().filter(chip => chip.getAttribute('aria-pressed') === 'true').every(chip => chip.textContent.startsWith('✓ ')),
    'valinta näkyy merkkinä, ei vain värinä');
  await click(primary());
  const plan = getState().weeklyPlans.find(p => p.weekStart === WEEK);
  assert.equal(plan.priorities.length, 3);
  assert.equal(plan.closedAt, null, 'tallennus ei vielä sulje viikkoa');
  assert.equal((await storedRow(weeklyPlansRepo, plan.id)).priorities.length, 3);
  assert.equal(stepKey(), 'place');
});

test('D: oma tekstiprioriteetti lisätään Enterillä tai Lisää-painikkeella', async (t) => {
  freezeLocalDate(t, SUNDAY);
  openSundayReset({ step: 'priorities' });
  type($('sundayResetPriorityText'), 'Levätä enemmän');
  await click(buttonByText('Lisää'));
  assert.deepEqual(sundayResetSession().selected, [{ ref: 'text', title: 'Levätä enemmän' }]);
  assert.equal($('sundayResetPriorityText').value, '');
  $('sundayResetPriorityText').focus();
  type($('sundayResetPriorityText'), 'Liikkua');
  press(doc, 'Enter');
  await flush();
  assert.deepEqual(sundayResetSession().selected.map(e => e.title), ['Levätä enemmän', 'Liikkua']);
});

// ================================================================ E: SIJOITTELU

function heavyWeek() {
  // Jokainen 400 min tehtävä täyttää päivän (noin 12 h joustavaa aikaa päivässä
  // puskurin jälkeen), joten viikkoon mahtuu vain osa.
  const tasks = Array.from({ length: 12 }, (_, i) => task(`h${String(i).padStart(2, '0')}`, {
    durationMinutes: 400, horizon: 'THIS_WEEK'
  }));
  return tasks;
}

test('E: sijoitukset eivät koskaan ylitä päivän kapasiteettia; ylimenevä jää tallessa', (t) => {
  freezeLocalDate(t, SUNDAY);
  setTasks(heavyWeek());
  const plan = placementPlan(getState(), { weekStart: WEEK, todayIso: SUNDAY });
  assert.ok(plan.placements.length > 0);
  assert.ok(plan.notFitting.length > 0, 'kaikki ei mahdu');
  for (const day of plan.days) {
    const used = plan.placements.filter(p => p.toDateIso === day.dateIso).reduce((s, p) => s + p.minutes, 0);
    assert.equal(used, day.usedMinutes);
    assert.ok(used <= day.usableMinutes, `${day.dateIso}: ${used} > ${day.usableMinutes}`);
  }
  assert.equal(plan.placements.length + plan.notFitting.length, 12, 'jokainen ehdokas on jommassakummassa');
  assert.ok(plan.notFitting.every(entry => entry.reason === NOT_FITTING_MESSAGE));
  assert.equal(NOT_FITTING_MESSAGE, 'Ei mahdu — jää tallessa, sinun ei tarvitse päättää nyt.');
});

test('E: lomalle ja suojattuun koko päivään ei sijoiteta mitään', (t) => {
  freezeLocalDate(t, SUNDAY);
  setProtectedPeriods([
    normalizeProtectedPeriod({ id: 'vac', kind: 'VACATION', recurrence: 'once', startDate: '2026-10-05', endDate: '2026-10-07' }),
    normalizeProtectedPeriod({ id: 'sun', kind: 'FREE_TIME', recurrence: 'weekly', weekdays: [7], strength: 'soft', title: 'Sunnuntai pääosin vapaa' })
  ]);
  setTasks(heavyWeek());
  const plan = placementPlan(getState(), { weekStart: WEEK, todayIso: SUNDAY });
  const blocked = new Set(['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-11']);
  assert.ok(plan.placements.length > 0);
  for (const placement of plan.placements) assert.equal(blocked.has(placement.toDateIso), false, placement.toDateIso);
  for (const day of plan.days.filter(d => blocked.has(d.dateIso))) assert.equal(day.usedMinutes, 0);
});

test('E: automaatin ajastama tehtävä ei osu suojattuun omaan aikaan', (t) => {
  freezeLocalDate(t, SUNDAY);
  setProtectedPeriods([normalizeProtectedPeriod({
    id: 'own', kind: 'OWN_TIME', recurrence: 'weekly', weekdays: [1, 2, 3, 4, 5, 6, 7], startTime: '18:00', endTime: '20:00'
  })]);
  setTasks([task('auto', { date: '2026-10-08', time: '18:30', schedulingState: 'auto', durationMinutes: 30, deadline: '2026-10-08' })]);
  const plan = placementPlan(getState(), { weekStart: WEEK, todayIso: SUNDAY });
  const blocks = periodBlocks({ periods: getState().protectedPeriods, from: WEEK, to: WEEK_END });
  for (const placement of plan.placements.filter(p => p.fromDateIso !== p.toDateIso)) {
    assert.equal(blocks.some(b => b.date === placement.toDateIso && b.startMinute <= 18 * 60 + 30 && b.endMinute > 18 * 60 + 30), false);
  }
  assert.equal(plan.changes.length, 0, 'siirtoa suojattuun aikaan ei ehdoteta');
});

test('E: prioriteettiin liittyvä ja määräaikainen menevät ensin, kun tilaa on vähän', (t) => {
  freezeLocalDate(t, SUNDAY);
  setGoals([normalizeGoal({ id: 'gA', title: 'Maraton', status: 'active' })]);
  const tasks = heavyWeek();
  tasks.push(task('zz-goal', { durationMinutes: 400, goalId: 'gA' }));
  tasks.push(task('zz-deadline', { durationMinutes: 400, deadline: '2026-10-09' }));
  setTasks(tasks);
  const priorities = [{ ref: 'goal:gA', title: 'Maraton' }];
  assert.equal(linkedToPriorities(getState().tasks.find(x => x.id === 'zz-goal'), priorities, getState()), true);
  const plan = placementPlan(getState(), { weekStart: WEEK, todayIso: SUNDAY, priorities });
  const placedIds = plan.placements.map(p => p.taskId);
  assert.ok(placedIds.includes('zz-goal'), 'prioriteetin tehtävä mahtuu');
  assert.ok(placedIds.includes('zz-deadline'), 'määräaikainen mahtuu');
  const deadline = plan.placements.find(p => p.taskId === 'zz-deadline');
  assert.ok(deadline.toDateIso <= '2026-10-09', 'ei määräajan jälkeen');
  assert.ok(plan.placements.find(p => p.taskId === 'zz-goal').focus);
});

test('E: kohdeviikolle jo päivätty pysyy päivällään; päivätön jono ei tule mukaan', (t) => {
  freezeLocalDate(t, SUNDAY);
  setTasks([
    task('dated', { date: '2026-10-08', durationMinutes: 45 }),
    task('backlog', {}),
    task('later', { date: '2026-10-20' }),
    task('done', { date: '2026-10-06', completed: true })
  ]);
  const plan = placementPlan(getState(), { weekStart: WEEK, todayIso: SUNDAY });
  assert.deepEqual(plan.placements.map(p => [p.taskId, p.toDateIso, p.result]), [['dated', '2026-10-08', 'kept']]);
  assert.deepEqual(plan.notFitting, []);
  assert.deepEqual(plan.changes, []);
});

test('E: käyttäjän pienentämä viikon aika rajaa uudet sijoitukset', (t) => {
  freezeLocalDate(t, SUNDAY);
  setTasks([1, 2, 3].map(i => task(`b${i}`, { durationMinutes: 120, horizon: 'THIS_WEEK' })));
  const free = placementPlan(getState(), { weekStart: WEEK, todayIso: SUNDAY });
  assert.equal(free.placements.length, 3);
  const limited = placementPlan(getState(), { weekStart: WEEK, todayIso: SUNDAY, budgetMinutes: 250 });
  assert.equal(limited.placements.length, 2);
  assert.equal(limited.notFitting.length, 1);
  assert.ok(limited.placedMinutes <= 250);
});

test('E: "Hyväksy" asettaa vain päivän editTaskilla; siirto kirjaa alkuperäisen päivän; ei-mahtuva ei muutu', async (t) => {
  freezeLocalDate(t, SUNDAY);
  // Keskiviikko on täynnä kiinteää työtä: sille päivätty joustava siirtyy aiemmaksi.
  const fixedWednesday = task('fixed', { date: '2026-10-07', time: '07:00', endTime: '23:00', durationMinutes: 960 });
  const moved = task('moved', { date: '2026-10-07', durationMinutes: 60 });
  const week = task('week', { horizon: 'THIS_WEEK', durationMinutes: 60 });
  const huge = task('huge', { horizon: 'THIS_WEEK', durationMinutes: 2000 });
  await seedTasks([fixedWednesday, moved, week, huge]);
  openSundayReset({ step: 'place' });
  assert.match(cardText(), /Sijoitetaan välttämätön/);
  assert.match(cardText(), /Ei mahdu \(1\)/);
  assert.match(cardText(), new RegExp(NOT_FITTING_MESSAGE));
  const plan = sundayResetSession().plan;
  assert.deepEqual(plan.changes.map(c => c.taskId).sort(), ['moved', 'week']);
  await click(primary());
  const state = getState();
  const movedNow = state.tasks.find(x => x.id === 'moved');
  assert.ok(movedNow.date >= WEEK && movedNow.date < '2026-10-07', `siirtyi aiemmaksi: ${movedNow.date}`);
  assert.equal(movedNow.rescheduleCount, 1, 'siirtojen seuranta editTaskista');
  assert.equal(movedNow.originalDate, '2026-10-07');
  assert.equal(movedNow.time, null, 'vain päivä muuttui');
  const weekNow = state.tasks.find(x => x.id === 'week');
  assert.ok(weekNow.date >= WEEK && weekNow.date <= WEEK_END);
  assert.equal(state.tasks.find(x => x.id === 'huge').date, null, 'ei-mahtuvaa ei työnnetä täydelle päivälle');
  assert.equal(storedTask('week').date, weekNow.date, 'tallentui');
  assert.equal(stepKey(), 'protect');
});

// ================================================================ F: OMA AIKA

test('F: suojattu aika, lomapäivät, vähimmäisvapaa-ajan tila ja kiinteät menot rajattuna', (t) => {
  freezeLocalDate(t, SUNDAY);
  protectedWeekState();
  setProtectedPeriods([...getState().protectedPeriods,
    normalizeProtectedPeriod({ id: 'min', kind: 'FREE_TIME', recurrence: 'weekly_target', targetMinutes: 600 })]);
  setCalendarEvents(Array.from({ length: 7 }, (_, i) => ({
    id: `ev${i}`, title: `Meno ${i}`, date: `2026-10-0${5 + (i % 4)}`, startTime: `0${8 + (i % 2)}:00`, durationMinutes: 30
  })));
  const model = protectStepModel(getState(), { weekStart: WEEK, todayIso: SUNDAY });
  const own = model.protected.find(p => p.id === 'own');
  assert.equal(own.text, 'Oma aika ti klo 18.00–20.00');
  assert.equal(own.minutes, 120);
  assert.equal(model.vacationDays, 2);
  assert.equal(model.freeTime.targetMinutes, 600);
  assert.ok(model.freeTime.coveredMinutes >= 120 + 2 * 1440);
  assert.equal(model.freeTime.reserveMinutes, 0);
  assert.equal(model.essentials.length, 5);
  assert.equal(model.essentialsMore, 2);
  openSundayReset({ step: 'protect' });
  assert.match(cardText(), /Kiinteät menot/);
  assert.match(cardText(), /ja 2 muuta menoa\./);
  assert.match(cardText(), /Oma aika ti klo 18\.00–20\.00 — 2 h/);
  assert.match(cardText(), /Vapaa-aikaa vähintään 10 h: suojattuna .*Tavoite täyttyy\./);
});

test('F: vapaa ilta lisätään olemassa olevien sääntöjen rinnalle (sunnuntai säilyy)', async (t) => {
  freezeLocalDate(t, SUNDAY);
  setProtectedPeriods([normalizeProtectedPeriod({
    id: 'sun', kind: 'FREE_TIME', recurrence: 'weekly', weekdays: [7], strength: 'soft', title: 'Sunnuntai pääosin vapaa'
  })]);
  openSundayReset({ step: 'protect' });
  choose($('sundayResetEveningDay'), '3');
  await click(buttonByText('Lisää vapaa ilta'));
  const periods = getState().protectedPeriods;
  assert.ok(periods.some(p => p.id === 'sun'), 'sunnuntaisääntö säilyi');
  const evening = periods.find(p => p.title === 'Vapaa ilta');
  assert.deepEqual(evening.weekdays, [3]);
  assert.equal(evening.startTime, '17:00');
  assert.match(cardText(), /Lisätty: vapaa ilta, keskiviikko\./);
  const second = await addFreeEvening(5);
  assert.ok(second.ok);
  assert.deepEqual(getState().protectedPeriods.find(p => p.title === 'Vapaa ilta').weekdays, [3, 5], 'yhdistyy samaan sääntöön');
});

test('F: oma aika tallentuu viikoittaisena OWN_TIME-jaksona kohdeviikosta alkaen', async (t) => {
  freezeLocalDate(t, SUNDAY);
  openSundayReset({ step: 'protect' });
  choose($('sundayResetOwnDay'), '4');
  type($('sundayResetOwnTime'), '19:30');
  await click(buttonByText('Lisää oma aika'));
  const own = getState().protectedPeriods.find(p => p.kind === 'OWN_TIME');
  assert.deepEqual([own.recurrence, own.weekdays, own.startTime, own.endTime, own.startDate], ['weekly', [4], '19:30', '20:30', WEEK]);
  assert.ok(await storedRow(protectedPeriodsRepo, own.id));
  assert.equal((await addOwnTimeSlot(9)).ok, false, 'virheellinen viikonpäivä hylätään');
});

// ================================================================ G: SULJE

test('G: sulkeminen kirjoittaa closedAt, plannedMinutes ja prioriteetit; loppuviesti on täsmälleen lukittu', async (t) => {
  freezeLocalDate(t, SUNDAY);
  await seedTasks([
    task('a', { date: '2026-10-06', durationMinutes: 90 }),
    task('b', { date: '2026-10-09', durationMinutes: 30 }),
    task('c', { date: '2026-10-12', durationMinutes: 600 }),
    task('d', { date: '2026-10-07', durationMinutes: 45, completed: true })
  ]);
  openSundayReset({ step: 'priorities' });
  type($('sundayResetPriorityText'), 'Perhe-aikaa');
  await click(buttonByText('Lisää'));
  await click(primary()); // tallenna -> E
  assert.equal(plannedMinutesForWeek(getState(), WEEK), 120);
  await click(buttonByText('Ohita tämä vaihe')); // E -> F
  await click(buttonByText('Ohita tämä vaihe')); // F -> G
  assert.equal(stepKey(), 'close');
  assert.equal(buttonByText('Ohita tämä vaihe'), undefined, 'sulkemista ei ohiteta, vain suljetaan dialogi');
  assert.match(cardText(), /Suunniteltua tekemistä ensi viikolla: 2 h\./);
  await click(primary());
  const plan = getState().weeklyPlans.find(p => p.weekStart === WEEK);
  assert.ok(plan.closedAt, 'closedAt kirjattu');
  assert.equal(plan.plannedMinutes, 120);
  assert.deepEqual(plan.priorities, [{ ref: 'text', title: 'Perhe-aikaa' }]);
  const stored = await storedRow(weeklyPlansRepo, plan.id);
  assert.equal(stored.plannedMinutes, 120);
  assert.ok(stored.closedAt);
  // Loppunäkymä: kaksi riviä täsmälleen, yksi "Valmis".
  assert.equal(SUNDAY_RESET_FINAL_COPY, 'Ensi viikko on suunniteltu.\nSinun ei tarvitse miettiä sitä enää tänään.');
  assert.equal($('sundayResetTitle').textContent, SUNDAY_RESET_FINAL_TITLE);
  assert.equal($('sundayResetFinalText').textContent, SUNDAY_RESET_FINAL_TEXT);
  assert.equal(doc.activeElement, $('sundayResetTitle'));
  const buttons = card().querySelectorAll('button');
  assert.deepEqual(buttons.map(b => b.textContent), ['Valmis']);
  await click(buttons[0]);
  assert.equal($('sundayResetDialog').open, false);
  assert.equal(sundayResetSession(), null, 'valmis nollaus ei jää muistiin');
  assert.equal(shouldShowSundayResetEntry(getState(), { todayIso: SUNDAY, nowMinutes: 720 }), false);
});

test('koko polku ohituksin: jokainen vaihe on ohitettavissa ja viikko sulkeutuu', async (t) => {
  freezeLocalDate(t, SUNDAY);
  openSundayReset();
  const seen = [];
  for (let i = 0; i < SUNDAY_RESET_STEPS.length - 1; i += 1) {
    seen.push(stepKey());
    await click(buttonByText('Ohita tämä vaihe'));
  }
  seen.push(stepKey());
  assert.deepEqual(seen, [...SUNDAY_RESET_STEPS]);
  await click(primary());
  assert.equal(sundayResetSession().step, 'done');
  const plan = getState().weeklyPlans.find(p => p.weekStart === WEEK);
  assert.ok(plan && plan.closedAt);
  assert.equal(plan.plannedMinutes, 0);
  assert.equal(getState().weeklyCapacities.length, 0, 'ohitettu kapasiteetti ei tallennu');
});

test('ilman <dialog>-tukea (tynkä-DOM) nollaus avautuu open-attribuutilla ja sulkeutuu', (t) => {
  freezeLocalDate(t, SUNDAY);
  // Sama tynkäkuvio kuin life-alignment-ui-v2.test.mjs:ssä: ei showModalia.
  const ids = new Set([...HTML.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
  const nodes = new Map();
  const stub = id => {
    const attributes = {};
    const listeners = {};
    return {
      id, innerHTML: '', textContent: '', hidden: false, open: false, dataset: {},
      setAttribute: (k, v) => { attributes[k] = String(v); }, getAttribute: k => attributes[k] ?? null,
      removeAttribute: k => { delete attributes[k]; }, addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
      focus() { globalThis.document.activeElement = this; }, querySelector: () => null, querySelectorAll: () => [], contains: () => false
    };
  };
  const saved = globalThis.document;
  globalThis.document = {
    activeElement: null,
    getElementById: id => (ids.has(id) ? (nodes.get(id) || nodes.set(id, stub(id)).get(id)) : null)
  };
  try {
    rebindSundayResetForTests();
    const opened = openSundayReset();
    assert.deepEqual(opened, { weekStart: WEEK, step: 'dump' });
    const dialog = globalThis.document.getElementById('sundayResetDialog');
    assert.equal(dialog.open, true);
    assert.equal(dialog.getAttribute('open'), '');
    assert.match(globalThis.document.getElementById('sundayResetCard').innerHTML, /Mitä sinulla on mielessä\?/);
    closeSundayReset();
    assert.equal(dialog.open, false);
    assert.equal(isSundayResetOpen(), false);
    assert.equal(sundayResetSession().step, 'dump', 'eteneminen säilyy');
  } finally {
    globalThis.document = saved;
  }
});

test('renderSundayResetEntry ilman säiliötä kertoo vain näkyvyyden', (t) => {
  freezeLocalDate(t, '2026-10-07');
  assert.equal(renderSundayResetEntry(null), false, 'keskiviikkona ei korttia');
  assert.equal(renderSundayResetEntry(null, { now: new Date(2026, 9, 4, 18, 0) }), true, 'sunnuntai-iltana kortti');
  assert.equal(renderSundayResetEntry(null, { now: new Date(2026, 9, 5, 8, 30) }), true, 'maanantaiaamuna kortti');
});

test('plannedMinutesForWeek: vain kohdeviikon keskeneräiset, näkyvät tehtävät', () => {
  const state = {
    tasks: [
      task('x1', { date: WEEK, durationMinutes: 30 }),
      task('x2', { date: WEEK_END }),
      task('x3', { date: '2026-10-12', durationMinutes: 500 }),
      task('x4', { date: WEEK, completed: true }),
      task('x5', { date: WEEK, archivedAt: '2026-10-01T10:00:00Z' })
    ]
  };
  assert.equal(plannedMinutesForWeek(state, WEEK), 90);
  assert.equal(plannedMinutesForWeek(state, 'ei'), 0);
});
