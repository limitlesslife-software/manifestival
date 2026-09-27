// Tavoitteesta tekemiseen: suunnittelu ja uudelleensuunnittelu käyttävät
// kalenterin menoja ja suojattuja lohkoja (§42 "Integrate real calendar
// blocks into Goal-to-Action").
//
// LÖYTYNYT PUUTE, JOTA TÄMÄ TESTI VARTIOI
//
// Domain osasi jo ottaa menot ja lohkot huomioon (capacity.horizonCapacity,
// planScheduler.planHorizon, replan.buildReplanProposal), mutta yksikään
// sovelluksen kutsuja ei antanut niitä:
//
//   - tekoälysuunnitelman kapasiteetti (src/app/planning.js requestPlan)
//   - Suunnittelu-näkymän "Seuraavat kaksi viikkoa" ja horisontti
//     (src/app/views/planning.js)
//   - myöhästyneiden tehtävien ilmoitus (src/app/assistantActions.js runReplanCheck)
//   - "Ehdota muutoksia" (src/app/actions.js proposeReplan)
//
// Viikko, jolla on toistuva 9-16 meno, näytti noin 26 h liikaa vapaata, ja
// myöhästyneet tehtävät siirtyivät täyteen buukatulle päivälle.
//
// Kaikki neljä hakevat kalenterin samasta paikasta
// (calendarPlan.calendarForPlanning -> calendarInputs): kiinteät menot
// pysyvät kiinteinä, valmistautuminen ja matka ovat varattuja, suojattu uni
// on suojattu.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createDocument, installDocument } from './helpers/a11yDom.mjs';
import { freezeLocalDate } from './helpers/clock.mjs';
import { read, readCode } from './helpers/sources.mjs';
import { fakeClient } from './helpers/gates.mjs';
import { setUser, clearUser } from '../src/data/session.js';
import { setClient } from '../src/data/client.js';
import {
  resetState, getState, setTasks, setCalendarEvents, setSavedPlaces
} from '../src/app/state.js';
import { clearLocalUserData, proposeReplan } from '../src/app/actions.js';
import { requestPlan } from '../src/app/planning.js';
import { runReplanCheck } from '../src/app/assistantActions.js';
import { renderPlanning } from '../src/app/views/planning.js';
import { calendarForPlanning, calendarInputs } from '../src/app/calendarPlan.js';
import { findCalendarCollisions } from '../src/domain/scheduler.js';
import { horizonCapacity } from '../src/domain/capacity.js';
import { planHorizon } from '../src/domain/planScheduler.js';
import { buildReplanProposal } from '../src/domain/replan.js';

const INDEX_HTML = read('index.html');
const USER = Object.freeze({ id: 'dddd0006-6666-4666-8666-00000000d0d6', email: 'plan@example.invalid' });
const SUN = '2026-09-27';
const ALL_DAYS = Object.freeze([1, 2, 3, 4, 5, 6, 7]);
const WEEKDAYS = Object.freeze([1, 2, 3, 4, 5]);

const PLAN_BODY = {
  goal: { title: 'Opi espanjaa', deadline: '2026-12-20' },
  milestones: [], projects: [],
  tasks: [{ ref: 't1', title: 'Ensimmäinen oppitunti', durationMinutes: 30 }],
  routines: []
};

/** Toistuva meno. */
function recurring(id, title, startTime, endTime, weekdays, until = null, date = SUN, extra = {}) {
  return { id, title, date, startTime, endTime, recurrenceWeekdays: [...weekdays], recurrenceUntil: until, ...extra };
}

function overdueTask(id, title, extra = {}) {
  return { id, title, date: '2026-09-25', durationMinutes: 60, completed: false, ...extra };
}

beforeEach(() => {
  clearUser();
  clearLocalUserData();
  resetState();
  const client = fakeClient({ data: [], error: null });
  client.auth = { getSession: async () => ({ data: { session: { access_token: 'tok' } } }) };
  setClient(client);
  setUser(USER);
});

// ============================================================ yksi kalenteripolku

test('calendarForPlanning: samat menot ja lohkot kuin calendarInputs, myös yli 14 päivän horisontilla', t => {
  freezeLocalDate(t, SUN);
  setSavedPlaces([{ id: 'p-gym', name: 'Sali', usualTravelMinutes: 20, preparationMinutes: 10 }]);
  setCalendarEvents([recurring('e-gym', 'Sali', '18:00', '19:00', [2, 4], null, SUN, { placeId: 'p-gym' })]);
  const state = getState();
  const short = calendarForPlanning(state, { from: SUN, to: '2026-10-10' });
  const direct = calendarInputs(state, { from: SUN, to: '2026-10-10' });
  assert.deepEqual(short.events.map(e => e.id), direct.occurrences.map(e => e.id));
  assert.deepEqual(short.blocks.map(b => b.id), direct.blocks.map(b => b.id));

  // 28 päivää: uni suojataan joka yöltä, ei vain ensimmäisiltä 14:ltä.
  const long = calendarForPlanning(state, { from: SUN, to: '2026-10-24' });
  const sleepNights = new Set(long.blocks.filter(b => b.kind === 'sleep').map(b => b.sourceId));
  for (const night of ['night:2026-10-15', 'night:2026-10-20', 'night:2026-10-23']) {
    assert.ok(sleepNights.has(night), `${night} on suojattu`);
  }
  const ids = long.blocks.map(b => b.id);
  assert.equal(new Set(ids).size, ids.length, 'jaksojen rajalla ei tuplalohkoja');
  assert.ok(long.blocks.some(b => b.kind === 'travel' && b.date === '2026-10-22'), 'matka varataan myös kolmannella viikolla');
  assert.ok(Object.isFrozen(long.events) && Object.isFrozen(long.blocks));
});

// ============================================================ tekoälysuunnitelma

async function weeklyHoursSent() {
  let body = null;
  const fetchImpl = async (_url, init) => {
    body = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: JSON.stringify(PLAN_BODY) }] }) };
  };
  const result = await requestPlan({ goalText: 'Haluan oppia espanjaa', fetchImpl });
  assert.equal(result.ok, true);
  return body.context.weeklyFreeHours;
}

test('KRIITTINEN: tekoälysuunnitelman viikkokapasiteetti vähentää toistuvan 9-16 menon', async t => {
  freezeLocalDate(t, SUN);
  const free = await weeklyHoursSent();
  setCalendarEvents([recurring('e-work', 'Työ', '09:00', '16:00', WEEKDAYS, null, '2026-09-28')]);
  const busy = await weeklyHoursSent();
  // 5 x 7 h = 35 h menoa, josta puskurin (25 %) jälkeen suunniteltavaa noin 26 h.
  assert.ok(free - busy >= 24, `vapaa ${free} h, menon kanssa ${busy} h`);
  assert.ok(free - busy <= 28, `vapaa ${free} h, menon kanssa ${busy} h`);
});

// ============================================================ Suunnittelu-näkymä

function planningText(t) {
  const doc = createDocument(INDEX_HTML);
  const uninstall = installDocument(doc);
  t.after(uninstall);
  renderPlanning();
  return doc.getElementById('planStatusContainer').textContent.replace(/\s+/g, ' ');
}

function hoursIn(text) {
  const match = text.match(/(\d+) h(?: (\d+) min)? suunniteltavaa aikaa/);
  assert.ok(match, text);
  return Number(match[1]) * 60 + Number(match[2] || 0);
}

test('KRIITTINEN: "Seuraavat kaksi viikkoa" vähentää menot ja suojatut lohkot', t => {
  freezeLocalDate(t, SUN);
  const free = hoursIn(planningText(t));
  setCalendarEvents([recurring('e-work', 'Työ', '09:00', '16:00', WEEKDAYS, null, '2026-09-28')]);
  const busy = hoursIn(planningText(t));
  // Kahdella viikolla 10 työpäivää x 7 h.
  assert.ok(free - busy >= 10 * 7 * 60 * 0.7, `vapaa ${free} min, menon kanssa ${busy} min`);
  assert.match(planningText(t), /menot, matkat ja valmistautuminen/, 'selitys kertoo mitä vähennettiin');
});

test('Suunnittelu-näkymän horisontti: tehtävä, joka ei mahdu täyteen buukattuun kahteen viikkoon, näkyy "ei mahdu"', t => {
  freezeLocalDate(t, SUN);
  setTasks([{ id: 't-big', title: 'Iso työ', date: '2026-10-05', durationMinutes: 120, completed: false }]);
  assert.doesNotMatch(planningText(t), /ei mahdu/);
  setCalendarEvents([recurring('e-full', 'Leiri', '07:00', '23:00', ALL_DAYS, '2026-10-20')]);
  assert.match(planningText(t), /1 ei mahdu/);
});

// ============================================================ Ehdota muutoksia

test('KRIITTINEN: proposeReplan ei siirrä myöhästyneitä täyteen buukatuille päiville', t => {
  freezeLocalDate(t, SUN);
  setTasks([overdueTask('a', 'Raportti'), overdueTask('b', 'Laskut'), overdueTask('c', 'Siivous')]);
  // Tänään ja viisi seuraavaa päivää 7.30-22.30.
  setCalendarEvents([recurring('e-busy', 'Messut', '07:30', '22:30', ALL_DAYS, '2026-10-02')]);
  const proposal = proposeReplan('manual');
  assert.equal(proposal.changes.length, 3);
  for (const change of proposal.changes) {
    assert.ok(change.toDateIso >= '2026-10-03', `${change.title} -> ${change.toDateIso} on buukattu päivä`);
  }
  assert.equal(getState().pendingReplan, proposal);
});

test('proposeReplan: kalenterin menoton viikko käyttää samaa laskentaa kuin ennen (tänään)', t => {
  freezeLocalDate(t, SUN);
  setTasks([overdueTask('a', 'Raportti'), overdueTask('b', 'Laskut')]);
  const proposal = proposeReplan('manual');
  assert.deepEqual(proposal.changes.map(change => change.toDateIso), [SUN, SUN]);
});

test('KRIITTINEN: automaattisesti ajastettu tehtävä ei siirry päivälle, jolla sen kellonaika osuu menoon tai matkaan', t => {
  freezeLocalDate(t, SUN);
  setSavedPlaces([{ id: 'p-office', name: 'Toimisto', usualTravelMinutes: 30, preparationMinutes: 15 }]);
  // Su-ti klo 10 palaveri toimistolla: valmistautuminen ja matka ovat 9.00-10.00.
  setCalendarEvents([recurring('e-meet', 'Palaveri', '10:00', '11:00', ALL_DAYS, '2026-09-29', SUN, { placeId: 'p-office' })]);
  setTasks([
    overdueTask('auto', 'Luonnos', { time: '09:30', endTime: '10:00', durationMinutes: null, schedulingState: 'auto' }),
    overdueTask('plain', 'Soitto', { durationMinutes: 30 })
  ]);
  const proposal = proposeReplan('manual');
  const auto = proposal.changes.find(change => change.taskId === 'auto');
  const plain = proposal.changes.find(change => change.taskId === 'plain');
  assert.equal(plain.toDateIso, SUN, 'ajaton tehtävä mahtuu tänään (päivän aikataulu kiertää menot)');
  assert.equal(auto.toDateIso, '2026-09-30', 'klo 9.30 osuu su-ti matkaan: ensimmäinen vapaa päivä on ke');
  assert.match(auto.reason, /klo 9\.30 osuisi aiemmin menoon, matkaan tai lepoon/);

  // Siirretty päivä ei osu mihinkään (sama tarkistus kuin CONFLICT-laukaisimessa).
  const state = getState();
  const { events, blocks } = calendarForPlanning(state, { from: SUN, to: '2026-10-10' });
  const moved = state.tasks.map(task => (task.id === 'auto' ? { ...task, date: auto.toDateIso } : task));
  assert.deepEqual([...findCalendarCollisions({ tasks: moved, events, blocks })], []);
});

test('domain planHorizon: kellonajan tarkistus koskee vain uutta päivää ja vain kalenterin kanssa', t => {
  freezeLocalDate(t, SUN);
  setCalendarEvents([recurring('e-meet', 'Palaveri', '09:00', '11:00', ALL_DAYS, '2026-10-10')]);
  const state = getState();
  const { events, blocks } = calendarForPlanning(state, { from: SUN, to: '2026-10-03' });
  const base = { title: 'Luonnos', time: '10:00', endTime: '10:30', schedulingState: 'auto', completed: false };

  // Oma päivä: päällekkäisyys on CONFLICT-laukaisimen asia, ei siirron syy.
  const own = planHorizon({
    tasks: [{ ...base, id: 'own', date: '2026-09-29' }], profile: state.profile,
    fromIso: SUN, toIso: '2026-10-03', events, blocks
  });
  assert.equal(own.placements[0].result, 'kept');

  // Päivätön automaattinen tehtävä: joka päivä klo 10 on palaveri -> ei sijoitu.
  const floating = planHorizon({
    tasks: [{ ...base, id: 'floating', date: null }], profile: state.profile,
    fromIso: SUN, toIso: '2026-10-03', events, blocks
  });
  assert.equal(floating.placements.length, 0);
  assert.match(floating.unplaced[0].reason, /klo 10\.00 osuu välillä 2026-09-27–2026-10-03 jokaisena päivänä/);

  // Ilman kalenteria entinen tulos.
  const plain = planHorizon({ tasks: [{ ...base, id: 'floating', date: null }], profile: state.profile, fromIso: SUN, toIso: '2026-10-03' });
  assert.equal(plain.placements[0].toDateIso, SUN);
});

test('kiinteää (itse ajastettua) tehtävää ei koskaan siirretä, kalenterin kanssakaan', t => {
  freezeLocalDate(t, SUN);
  setCalendarEvents([recurring('e-busy', 'Messut', '07:30', '22:30', ALL_DAYS, '2026-10-02')]);
  setTasks([overdueTask('mine', 'Oma', { time: '12:00', endTime: '13:00', durationMinutes: null, schedulingState: 'manual' })]);
  const proposal = proposeReplan('manual');
  assert.deepEqual(proposal.changes, []);
});

// ============================================================ myöhästyneiden ilmoitus

test('KRIITTINEN: myöhästyneiden ilmoitus ei lupaa siirtää tehtäviä täyteen buukattuun horisonttiin', async t => {
  freezeLocalDate(t, SUN);
  setTasks([overdueTask('a', 'Raportti'), overdueTask('b', 'Laskut'), overdueTask('c', 'Siivous')]);
  const before = await runReplanCheck();
  assert.equal(before.proposed, true, 'ilman menoja siirrettävää on');
  assert.equal(before.changes, 3);

  resetState();
  setUser(USER);
  setTasks([overdueTask('a', 'Raportti'), overdueTask('b', 'Laskut'), overdueTask('c', 'Siivous')]);
  setCalendarEvents([recurring('e-full', 'Leiri', '07:00', '23:00', ALL_DAYS, '2026-10-20')]);
  const after = await runReplanCheck();
  assert.equal(after.changes, 0, 'kahdelle viikolle ei mahdu mitään');
  assert.equal(after.proposed, false);
  assert.equal(getState().notices.filter(notice => notice.kind === 'replan').length, 0);
});

test('myöhästyneiden ilmoitus laskee siirrot samoilla menoilla kuin "Ehdota muutoksia"', async t => {
  freezeLocalDate(t, SUN);
  setTasks([overdueTask('a', 'Raportti'), overdueTask('b', 'Laskut'), overdueTask('c', 'Siivous')]);
  setCalendarEvents([recurring('e-busy', 'Messut', '07:30', '22:30', ALL_DAYS, '2026-10-02')]);
  const check = await runReplanCheck();
  const proposal = proposeReplan('missed_task');
  assert.equal(check.changes, proposal.changes.length);
  const [notice] = getState().notices.filter(entry => entry.kind === 'replan');
  assert.match(notice.reason, /Voisin siirtää 3 tehtävää/);
});

// ============================================================ lähteet

test('kaikki neljä kutsujaa antavat menot ja lohkot samasta kalenteripolusta', () => {
  for (const file of ['src/app/planning.js', 'src/app/views/planning.js', 'src/app/assistantActions.js', 'src/app/actions.js']) {
    const code = readCode(file);
    assert.match(code, /calendarForPlanning\(/, `${file} hakee kalenterin calendarPlanista`);
  }
});

test('domain: sama horisontti ilman kalenteria ja kalenterin kanssa (menot pienentävät, eivät kasvata)', t => {
  freezeLocalDate(t, SUN);
  setCalendarEvents([recurring('e-work', 'Työ', '09:00', '16:00', WEEKDAYS, null, '2026-09-28')]);
  const state = getState();
  const { events, blocks } = calendarForPlanning(state, { from: SUN, to: '2026-10-10' });
  const plain = horizonCapacity({ tasks: [], profile: state.profile, fromIso: SUN, toIso: '2026-10-10' });
  const busy = horizonCapacity({ tasks: [], profile: state.profile, fromIso: SUN, toIso: '2026-10-10', events, blocks });
  for (let i = 0; i < plain.days.length; i += 1) {
    assert.ok(busy.days[i].usableMinutes <= plain.days[i].usableMinutes, plain.days[i].dateIso);
  }
  const horizon = planHorizon({ tasks: [], profile: state.profile, fromIso: SUN, toIso: '2026-10-10', events, blocks });
  assert.equal(horizon.capacity.totalUsableMinutes, busy.totalUsableMinutes);
  const replan = buildReplanProposal({ tasks: [], profile: state.profile, todayIso: SUN, events, blocks });
  assert.deepEqual(replan.changes, []);
});
