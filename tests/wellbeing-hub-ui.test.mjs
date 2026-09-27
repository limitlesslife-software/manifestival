// Profiili → Hyvinvointi (src/app/views/wellbeingHub.js) oikeassa,
// jäsennetyssä DOMissa: piirto omaan säiliöön, tallennus- ja poistopolut
// muistivaraston kautta (portit ovat tuotehaaralla kiinni), käyttäjän
// tekstin suojaus, saavutettavat nimet ja näppäimistö.
//
// Säiliön (#profileWellbeingSection) luo profiilinäkymä muualla; testi luo
// oman säiliön, jottei se riipu index.html:n rakenteesta.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createDocument, installDocument, press, type, choose, accessibleName, assertSameNode
} from './helpers/a11yDom.mjs';
import { freezeLocalDate } from './helpers/clock.mjs';
import { read } from './helpers/sources.mjs';
import { parseRules, declarations, px } from './helpers/a11yCss.mjs';
import { setUser, clearUser } from '../src/data/session.js';
import { clearAllCollections, habitPlansRepo } from '../src/data/collectionsRepo.js';
import { isTableAvailable } from '../src/data/schema.js';
import {
  resetState, getState, subscribe, setWellbeing, setWellbeingCheckins, setHabitPlans, setHabitEvents,
  setSleepLogs, setExerciseSessions, setGoals, setProfile
} from '../src/app/state.js';
import { resetDailyLifeActions } from '../src/app/dailyLifeActions.js';
import {
  renderWellbeingHub, initWellbeingHub, resetWellbeingHub, HISTORY_DAYS
} from '../src/app/views/wellbeingHub.js';
import { closeConfirmDialogs } from '../src/ui/confirm.js';
import { clearToasts } from '../src/ui/toast.js';

const USER = Object.freeze({ id: 'ccccaaaa-4444-4444-8444-00000000c0de', email: 'wellbeing@example.invalid' });
/** Maanantai: viikon yhteenveto alkaa tästä päivästä. */
const TODAY = '2026-09-28';

const flush = async (rounds = 12) => {
  for (let i = 0; i < rounds; i += 1) await new Promise(resolve => setImmediate(resolve));
};

/** Asenna näkymä omaan säiliöön. Kello jäädytetään, jotta "tänään" ei riipu ajopäivästä. */
function mount(t) {
  freezeLocalDate(t, TODAY);
  clearUser();
  clearAllCollections();
  resetState();
  resetDailyLifeActions();
  resetWellbeingHub();
  const doc = createDocument('<main><section id="host" aria-label="Hyvinvointi"></section></main>');
  const uninstall = installDocument(doc);
  setUser(USER);
  const container = doc.getElementById('host');
  initWellbeingHub(container);
  const unsubscribe = subscribe(() => renderWellbeingHub(container));
  renderWellbeingHub(container);
  t.after(async () => {
    unsubscribe();
    closeConfirmDialogs();
    await flush(4);
    clearToasts();
    resetWellbeingHub();
    uninstall();
    clearUser();
  });
  return {
    doc,
    container,
    q: selector => container.querySelector(selector),
    qa: selector => container.querySelectorAll(selector),
    byId: id => doc.getElementById(id),
    text: () => container.textContent.replace(/\s+/g, ' ')
  };
}

/**
 * Rivit sekä tilaan että muistivarastoon: päivitys ja poisto kulkevat
 * repositorion kautta, ja pelkkään tilaan asetettu rivi puuttuisi sieltä.
 */
async function seed(repo, setter, rows) {
  await repo.memory.replaceAll(rows);
  setter(rows);
}

/** Vastaa vahvistusdialogiin (dialogi syntyy dokumentin bodyyn). */
async function answerConfirm(doc, accept) {
  await flush(3);
  const dialog = doc.getElementById('confirmDialog');
  assert.ok(dialog && dialog.open, 'vahvistusdialogi on auki');
  doc.getElementById(accept ? 'confirmAccept' : 'confirmCancel').click();
  await flush();
}

function clickAction(view, action, id = null) {
  const selector = id ? `[data-action="${action}"][data-id="${id}"]` : `[data-action="${action}"]`;
  const button = view.q(selector);
  assert.ok(button, `painike ${selector} puuttuu`);
  button.click();
  return button;
}

// ================================================================ vointi 14 pv

test('vointi 14 pv: jokainen päivä näkyy, tyhjä on "ei merkintää" eikä nolla, motivaatio ja hallinnan tunne mukana', t => {
  const view = mount(t);
  setWellbeing([
    { id: 'w1', date: '2026-09-28', energy: 1, mood: null, stress: 5 },
    { id: 'w2', date: '2026-09-20', energy: 3, mood: 4, stress: null },
    { id: 'w-old', date: '2026-09-01', energy: 5, mood: 5, stress: 1 }
  ]);
  setWellbeingCheckins([
    { id: 'c1', date: '2026-09-28', motivation: 2, control: null },
    { id: 'c2', date: '2026-09-27', motivation: 4, control: 3 }
  ]);

  const rows = view.qa('.wbh-table tbody tr');
  assert.equal(rows.length, HISTORY_DAYS);
  assert.equal(rows[0].getAttribute('data-date'), '2026-09-28', 'uusin ensin');
  assert.equal(rows[HISTORY_DAYS - 1].getAttribute('data-date'), '2026-09-15');
  assert.equal(view.q('[data-date="2026-09-01"]'), null, 'ikkunan ulkopuolinen päivä ei näy');

  const cells = row => row.querySelectorAll('td').map(cell => cell.textContent.trim());
  const today = cells(rows[0]);
  assert.equal(today[0], '1', 'energia 1 on arvo');
  assert.match(today[1], /ei merkintää/, 'puuttuva mieliala ei ole nolla');
  assert.equal(today[2], '5');
  assert.equal(today[3], '2', 'motivaatio uudesta taulusta');
  assert.match(today[4], /ei merkintää/, 'puuttuva hallinnan tunne');

  const checkinOnly = cells(view.q('[data-date="2026-09-27"]'));
  assert.deepEqual(checkinOnly.slice(3), ['4', '3']);
  assert.match(checkinOnly[0], /ei merkintää/);

  const empty = view.q('[data-date="2026-09-26"] td');
  assert.equal(empty.getAttribute('colspan'), '5');
  assert.equal(empty.textContent.trim(), 'ei merkintää');

  for (const cell of view.qa('.wbh-table td')) assert.notEqual(cell.textContent.trim(), '0', 'tuntematon ei ole koskaan 0');

  // Keskiarvo vain merkityistä päivistä: energia (1 + 3) / 2 = 2, ei (1 + 3) / 14.
  const averages = cells(view.q('.wbh-table tfoot tr'));
  assert.deepEqual(averages.slice(0, 1), ['2']);
  assert.equal(averages[1], '4');
  assert.equal(averages[3], '3', 'motivaatio (2 + 4) / 2');
  assert.match(view.text(), /Merkintöjä 3 päivältä 14 päivästä/);

  const headers = view.qa('.wbh-table thead th').map(th => accessibleName(th) || th.textContent);
  for (const name of ['Energia', 'Mieliala', 'Kuormitus', 'Motivaatio', 'Hallinnan tunne']) {
    assert.ok(headers.some(header => header.includes(name)), `sarakkeen nimi ${name} ruudunlukijalle`);
  }
});

test('kuormitusehdotus näkyy perusteluineen eikä väitä muuttavansa mitään', t => {
  const view = mount(t);
  assert.equal(view.q('.lh-suggestion'), null, 'ilman merkintöjä ei ehdotusta');
  setWellbeing(['2026-09-26', '2026-09-27', '2026-09-28'].map((date, i) => ({ id: `s${i}`, date, energy: 1, stress: 5 })));
  const suggestion = view.q('.lh-suggestion');
  assert.ok(suggestion, 'ehdotus näkyy');
  assert.match(suggestion.textContent, /Harkitse kuorman keventämistä/);
  assert.match(suggestion.textContent, /omien merkintöjesi mukaan/);
  assert.match(suggestion.textContent, /ei muuta suunnitelmaasi itsestään/);
});

// ================================================================ tapojen muutos

test('tapasuunnitelma: luonti lomakkeella, vähennysaskel tallentuu, tyhjä kenttä on null eikä nolla', async t => {
  const view = mount(t);
  assert.match(view.text(), /Ei vielä suunnitelmia/);
  clickAction(view, 'habit-add');
  assertSameNode(view.doc.activeElement, view.byId('wbhHabitName'), 'fokus nimikenttään');

  type(view.byId('wbhHabitName'), 'Nuuska');
  choose(view.byId('wbhHabitKind'), 'nicotine');
  type(view.byId('wbhHabitInterval'), '90');
  type(view.byId('wbhHabitBaseline'), '12');
  type(view.byId('wbhHabitCost'), '0,45');
  clickAction(view, 'habit-step-add');
  assertSameNode(view.doc.activeElement, view.byId('wbhStepFrom-0'), 'fokus uuden askeleen päivään');
  type(view.byId('wbhStepFrom-0'), '2026-10-05');
  type(view.byId('wbhStepInterval-0'), '120');
  type(view.byId('wbhStepTarget-0'), '6');
  clickAction(view, 'habit-save');
  await flush();

  const plans = getState().habitPlans;
  assert.equal(plans.length, 1);
  const [plan] = plans;
  assert.equal(plan.name, 'Nuuska');
  assert.equal(plan.kind, 'nicotine');
  assert.equal(plan.minIntervalMinutes, 90);
  assert.equal(plan.dailyTarget, null, 'tyhjä päivätavoite on tuntematon, ei nolla');
  assert.equal(plan.baselinePerDay, 12);
  assert.equal(plan.unitCostMinor, 45);
  assert.equal(plan.reminderDelivery, 'silent', 'hiljainen oletus');
  assert.equal(plan.active, true);
  assert.deepEqual(plan.steps, [{ from: '2026-10-05', intervalMinutes: 120, dailyTarget: 6 }]);

  assert.equal(view.byId('wbhHabitName'), null, 'lomake sulkeutui');
  const row = view.q(`[data-habit-row="${plan.id}"]`);
  assert.match(row.textContent, /Nyt voimassa: väli vähintään 1 h 30 min\./);
  assert.match(row.textContent, /Seuraava askel ma 5\.10\.: väli 2 h, päivätavoite 6\./);
  assertSameNode(view.doc.activeElement, view.q(`[data-action="habit-edit"][data-id="${plan.id}"]`),
    'fokus tallennetun suunnitelman riville');
});

test('tapasuunnitelma: virheet kentän alla (role=alert), fokus ensimmäiseen virheeseen, mitään ei tallennu', async t => {
  const view = mount(t);
  clickAction(view, 'habit-add');
  type(view.byId('wbhHabitInterval'), '2000');
  type(view.byId('wbhHabitCost'), 'paljon');
  clickAction(view, 'habit-step-add');
  type(view.byId('wbhStepInterval-0'), '30');
  clickAction(view, 'habit-save');
  await flush();

  assert.deepEqual(getState().habitPlans, [], 'virheellistä ei tallenneta');
  const name = view.byId('wbhHabitName');
  assert.equal(name.getAttribute('aria-invalid'), 'true');
  assert.equal(view.byId('wbhHabitNameError').getAttribute('role'), 'alert');
  assert.match(view.byId('wbhHabitNameError').textContent, /Anna tavalle nimi/);
  assert.ok(name.getAttribute('aria-describedby').includes('wbhHabitNameError'));
  assertSameNode(view.doc.activeElement, name, 'fokus ensimmäiseen virheelliseen kenttään');
  assert.match(view.byId('wbhHabitIntervalError').textContent, /1–1440/, 'rajan ylitystä ei kiristetä hiljaa');
  assert.match(view.byId('wbhHabitCostError').textContent, /euroina/);
  assert.match(view.byId('wbhStepFrom-0Error').textContent, /alkupäivä/);

  // Korjaus: nimi, sallittu väli, tyhjä hinta ja askel pois.
  type(view.byId('wbhHabitName'), 'Kahvi');
  type(view.byId('wbhHabitInterval'), '60');
  type(view.byId('wbhHabitCost'), '');
  clickAction(view, 'habit-step-remove');
  clickAction(view, 'habit-save');
  await flush();
  const [plan] = getState().habitPlans;
  assert.equal(plan.name, 'Kahvi');
  assert.equal(plan.minIntervalMinutes, 60);
  assert.equal(plan.unitCostMinor, null);
  assert.equal(plan.kind, 'generic', 'oletuslaji on neutraali "Muu"');
  assert.deepEqual(plan.steps, []);
});

test('edistyminen ja säästö tulevat tapamoottorista; ilman lähtötasoa säästöä ei keksitä', t => {
  const view = mount(t);
  setHabitPlans([
    {
      id: 'h-money', name: 'Nuuska', kind: 'nicotine', baselinePerDay: 10, unitCostMinor: 50, minIntervalMinutes: 60,
      createdAt: '2026-09-21T06:00:00.000Z'
    },
    { id: 'h-free', name: 'Makeinen', kind: 'generic', dailyTarget: 2 }
  ]);
  setHabitEvents([
    ...['09', '10', '11'].map((hour, i) => ({ id: `u25-${i}`, planId: 'h-money', action: 'use', occurredAt: `2026-09-25T${hour}:00:00.000Z` })),
    ...['09', '12'].map((hour, i) => ({ id: `u26-${i}`, planId: 'h-money', action: 'use', occurredAt: `2026-09-26T${hour}:00:00.000Z` })),
    { id: 'today', planId: 'h-money', action: 'use', occurredAt: '2026-09-28T08:00:00.000Z' }
  ]);

  const money = view.q('[data-habit-row="h-money"]').textContent.replace(/\s+/g, ' ');
  // Seuranta 21.–27.9. = 7 päivää, 5 käyttöä: (10 × 7 − 5) × 0,50 € = 32,50 €.
  assert.match(money, /Viimeiset 7 päivää: keskimäärin 0,7 kertaa päivässä, lähtötaso 10\./);
  assert.match(money, /32,50/);
  assert.match(money, /Tänään kirjattu 1 kerta\./);

  const free = view.q('[data-habit-row="h-free"]').textContent.replace(/\s+/g, ' ');
  assert.match(free, /Säästöä ei lasketa ilman lähtötasoa ja yksikköhintaa\./);
  assert.doesNotMatch(free, /€/, 'tuntematonta säästöä ei näytetä summana');
  assert.match(free, /päivätavoite 2 kertaa/);
  assert.match(free, /Tänään ei vielä kirjauksia\./, 'nolla kirjausta kerrotaan sanoin');
  const habits = view.q('[data-section="habits"]').textContent.toLowerCase();
  for (const word of ['retkahd', 'epäonnist', 'huono', 'lipsu']) {
    assert.doesNotMatch(habits, new RegExp(word), `neutraali kieli: ei "${word}"`);
  }
});

test('tapasuunnitelman muokkaus; poisto kysyy vahvistuksen ja peruutus säilyttää', async t => {
  const view = mount(t);
  await seed(habitPlansRepo, setHabitPlans, [{
    id: 'h1', name: 'Nuuska', kind: 'nicotine', minIntervalMinutes: 90, unitCostMinor: 45,
    steps: [{ from: '2026-10-05', intervalMinutes: 120, dailyTarget: null }]
  }]);
  clickAction(view, 'habit-edit', 'h1');
  assert.equal(view.byId('wbhHabitName').value, 'Nuuska');
  assert.equal(view.byId('wbhHabitInterval').value, '90');
  assert.equal(view.byId('wbhHabitCost').value, '0,45', 'hinta suomalaisella pilkulla');
  assert.equal(view.byId('wbhStepFrom-0').value, '2026-10-05');
  assert.equal(view.byId('wbhStepTarget-0').value, '', 'tuntematon askeleen tavoite on tyhjä, ei 0');
  type(view.byId('wbhHabitTarget'), '6');
  clickAction(view, 'habit-save');
  await flush();
  assert.equal(getState().habitPlans.length, 1, 'päivitys ei luo uutta');
  assert.equal(getState().habitPlans[0].dailyTarget, 6);
  assert.equal(getState().habitPlans[0].steps.length, 1, 'askel säilyi');

  clickAction(view, 'habit-delete', 'h1');
  await answerConfirm(view.doc, false);
  assert.equal(getState().habitPlans.length, 1, 'peruutus ei poista');

  clickAction(view, 'habit-delete', 'h1');
  await answerConfirm(view.doc, true);
  assert.deepEqual(getState().habitPlans, []);
  assertSameNode(view.doc.activeElement, view.q('[data-action="habit-add"]'), 'fokus lisäyspainikkeeseen');
});

test('epäonnistunut tallennus: tila perutaan, lomake ja kirjoitus jäävät, painike vapautuu', async t => {
  const view = mount(t);
  const original = habitPlansRepo.insert;
  habitPlansRepo.insert = async () => ({ ok: false, error: { message: 'verkko', userMessage: 'Yhteys katkesi.' } });
  t.after(() => { habitPlansRepo.insert = original; });

  clickAction(view, 'habit-add');
  type(view.byId('wbhHabitName'), 'Nuuska');
  clickAction(view, 'habit-save');
  await flush();
  assert.deepEqual(getState().habitPlans, [], 'optimistinen lisäys peruttiin');
  assert.equal(view.byId('wbhHabitName').value, 'Nuuska', 'kirjoitus säilyi');
  const save = view.q('[data-action="habit-save"]');
  assert.equal(save.disabled, false);
  assert.equal(save.textContent.trim(), 'Tallenna');
});

// ================================================================ liikunta

test('liikunta: kirjaus, viikkoyhteenveto, tavoite ja poisto; kestoton kerta ei ole nolla minuuttia', async t => {
  const view = mount(t);
  setGoals([{ id: 'g1', title: 'Kunto', status: 'active' }, { id: 'g-done', title: 'Vanha', status: 'completed' }]);
  clickAction(view, 'exercise-add');
  assertSameNode(view.doc.activeElement, view.byId('wbhExerciseKind'));
  assert.equal(view.byId('wbhExerciseDate').value, TODAY, 'oletuspäivä on tänään');
  const goalOptions = view.byId('wbhExerciseGoal').querySelectorAll('option').map(option => option.value);
  assert.deepEqual(goalOptions, ['', 'g1'], 'päättynyt tavoite ei ole valittavissa');

  type(view.byId('wbhExerciseKind'), 'Juoksu');
  type(view.byId('wbhExercisePlanned'), '40');
  type(view.byId('wbhExerciseActual'), '45');
  choose(view.byId('wbhExerciseIntensity'), '3');
  choose(view.byId('wbhExerciseGoal'), 'g1');
  clickAction(view, 'exercise-save');
  await flush();

  const [session] = getState().exerciseSessions;
  assert.deepEqual(
    [session.date, session.kind, session.plannedMinutes, session.actualMinutes, session.intensity, session.recoveryDemand, session.goalId],
    [TODAY, 'Juoksu', 40, 45, 3, null, 'g1']);
  assert.match(view.text(), /Tämä viikko: Liikuntaa 45 min \(suunniteltu 40 min\)\./);
  assert.match(view.text(), /Liikuntapäiviä 1\/7/);
  const row = view.q(`[data-exercise-row="${session.id}"]`).textContent.replace(/\s+/g, ' ');
  assert.match(row, /Tavoite: Kunto/);

  clickAction(view, 'exercise-add');
  type(view.byId('wbhExerciseKind'), 'Jooga');
  clickAction(view, 'exercise-save');
  await flush();
  const yoga = getState().exerciseSessions.find(item => item.kind === 'Jooga');
  assert.equal(yoga.actualMinutes, null);
  assert.equal(yoga.plannedMinutes, null);
  assert.match(view.q(`[data-exercise-row="${yoga.id}"]`).textContent, /toteutunut: ei kirjattu/);

  clickAction(view, 'exercise-delete', yoga.id);
  await answerConfirm(view.doc, true);
  assert.equal(getState().exerciseSessions.length, 1);
});

test('liikunta: puuttuva laji ja liian pitkä kesto ovat virheitä', async t => {
  const view = mount(t);
  clickAction(view, 'exercise-add');
  type(view.byId('wbhExerciseActual'), '5000');
  clickAction(view, 'exercise-save');
  await flush();
  assert.deepEqual(getState().exerciseSessions, []);
  assert.match(view.byId('wbhExerciseKindError').textContent, /laji/);
  assert.match(view.byId('wbhExerciseActualError').textContent, /1–1440/);
  assertSameNode(view.doc.activeElement, view.byId('wbhExerciseKind'));
});

// ================================================================ uni

test('uni: kirjaus näyttää vuoteessa oloajan eikä väitä mitattua unta', async t => {
  const view = mount(t);
  assert.match(view.text(), /vuoteessa oloaika, ei mitattua unta/);
  clickAction(view, 'sleep-add');
  assertSameNode(view.doc.activeElement, view.byId('wbhSleepDate'));
  type(view.byId('wbhSleepBedtime'), '23:10');
  type(view.byId('wbhSleepWake'), '06:50');
  clickAction(view, 'sleep-save');
  await flush();

  const [log] = getState().sleepLogs;
  assert.deepEqual([log.wakeDate, log.actualBedtime, log.actualWake, log.kind, log.source],
    [TODAY, '23:10', '06:50', 'opportunity', 'user']);
  const row = view.q(`[data-sleep-row="${TODAY}"]`).textContent.replace(/\s+/g, ' ');
  assert.match(row, /nukkumaan 23\.10 · heräsi 6\.50 · vuoteessa 7 h 40 min/);
  assert.doesNotMatch(view.text(), /nukuit/i, 'ei väitettä nukutusta ajasta');

  // Muokkaus: päivä ei vaihdu vahingossa (kirjaus on heräämispäivän rivi).
  clickAction(view, 'sleep-edit', TODAY);
  assert.equal(view.byId('wbhSleepDate'), null);
  assertSameNode(view.doc.activeElement, view.byId('wbhSleepBedtime'));
  type(view.byId('wbhSleepWake'), '');
  type(view.byId('wbhSleepBedtime'), '');
  clickAction(view, 'sleep-save');
  await flush();
  assert.match(view.byId('wbhSleepFormError').textContent, /ainakin nukkumaanmeno tai herääminen/);
  assertSameNode(view.doc.activeElement, view.byId('wbhSleepFormError'), 'fokus lomakkeen virheeseen');
  assert.equal(getState().sleepLogs[0].actualWake, '06:50', 'virheellinen muokkaus ei tallentunut');
});

test('uni: tuleva heräämispäivä on virhe; vain toinen kellonaika -> vuoteessa oloaika ei tiedossa', async t => {
  const view = mount(t);
  clickAction(view, 'sleep-add');
  type(view.byId('wbhSleepDate'), '2026-09-30');
  type(view.byId('wbhSleepWake'), '07:00');
  clickAction(view, 'sleep-save');
  await flush();
  assert.match(view.byId('wbhSleepDateError').textContent, /tulevaisuudessa/);
  type(view.byId('wbhSleepDate'), '2026-09-27');
  clickAction(view, 'sleep-save');
  await flush();
  assert.match(view.q('[data-sleep-row="2026-09-27"]').textContent, /vuoteessa oloaika ei tiedossa/);
});

test('rytmin siirtymä: toistuva viikonlopun siirtymä kerrotaan, väljyyden sisällä ei hälytetä', t => {
  const view = mount(t);
  setProfile({ defaultWakeTime: '07:00', sleepTargetHours: 8 });
  assert.match(view.text(), /Rytmin siirtymää ei voi vielä arvioida/);

  setSleepLogs(['2026-09-26', '2026-09-27'].map((date, i) => ({
    id: `ok${i}`, wakeDate: date, actualBedtime: '23:30', actualWake: '07:30'
  })));
  assert.match(view.text(), /pysynyt asettamasi väljyyden sisällä/);

  const weekends = ['2026-09-05', '2026-09-06', '2026-09-12', '2026-09-13', '2026-09-19', '2026-09-20'];
  setSleepLogs(weekends.map((date, i) => ({ id: `late${i}`, wakeDate: date, actualBedtime: '01:30', actualWake: '10:30' })));
  const text = view.text();
  assert.match(text, /Viikonlopun rytmi on siirtynyt asettamaasi väljyyttä enemmän 3 viikonloppuna/);
  assert.match(text, /ei unen mittaukseen/);
  assert.match(text, /Vertailukohta: arkiherätys 7\.00 \(profiilistasi\)/);
});

// ================================================================ näppäimistö, suojaus, saavutettavuus

test('näppäimistö: Escape sulkee lomakkeen ja palauttaa fokuksen avaajaan, Enter tallentaa', async t => {
  const view = mount(t);
  const opener = clickAction(view, 'habit-add');
  assertSameNode(view.doc.activeElement, view.byId('wbhHabitName'));
  press(view.doc, 'Escape');
  assert.equal(view.byId('wbhHabitName'), null, 'lomake sulkeutui');
  assertSameNode(view.doc.activeElement, view.q('[data-action="habit-add"]'), 'fokus palasi avaajaan');
  assert.ok(opener, 'avaaja oli painike');

  clickAction(view, 'exercise-add');
  type(view.byId('wbhExerciseKind'), 'Uinti');
  press(view.doc, 'Enter');
  await flush();
  assert.equal(getState().exerciseSessions.length, 1, 'Enter tekstikentässä tallentaa');
  assert.equal(view.byId('wbhExerciseKind'), null);
});

test('TURVA: käyttäjän teksti suojataan (nimi, laji, muistiinpano, tavoite, uni)', t => {
  const view = mount(t);
  const evil = '<img src=x onerror=alert(1)>';
  setGoals([{ id: 'g1', title: '<i>tavoite</i>', status: 'active' }]);
  setHabitPlans([{ id: 'h"1', name: evil, kind: 'generic' }]);
  setExerciseSessions([{ id: 'x1', date: TODAY, kind: '<script>alert(1)</script>', note: '"><b>lihavoitu</b>', goalId: 'g1' }]);
  setSleepLogs([{ id: 's1', wakeDate: TODAY, actualWake: '07:00', note: '<svg onload=alert(1)>' }]);

  for (const selector of ['img', 'script', 'b', 'i', 'svg[onload]']) {
    assert.equal(view.q(selector), null, `käyttäjän teksti ei luonut elementtiä ${selector}`);
  }
  const text = view.text();
  assert.ok(text.includes(evil), 'nimi näkyy tekstinä');
  assert.ok(text.includes('<script>alert(1)</script>'));
  assert.ok(text.includes('<i>tavoite</i>'));
  const edit = view.q('[data-action="habit-edit"]');
  assert.equal(edit.getAttribute('data-id'), 'h"1', 'lainausmerkki ei katkaise attribuuttia');
  assert.equal(accessibleName(edit), `Muokkaa suunnitelmaa ${evil}`);

  clickAction(view, 'exercise-edit', 'x1');
  assert.equal(view.byId('wbhExerciseNote').value, '"><b>lihavoitu</b>');
  assert.equal(view.q('b'), null);
});

test('saavutettavuus: jokaisella ohjaimella on nimi, painikkeilla tyyppi, numerokentillä rajat', t => {
  const view = mount(t);
  setHabitPlans([{ id: 'h1', name: 'Nuuska', kind: 'nicotine', steps: [{ from: '2026-10-05', intervalMinutes: 120 }] }]);
  setExerciseSessions([{ id: 'x1', date: TODAY, kind: 'Juoksu', actualMinutes: 30 }]);
  setSleepLogs([{ id: 's1', wakeDate: TODAY, actualWake: '07:00' }]);
  clickAction(view, 'habit-edit', 'h1');
  clickAction(view, 'exercise-add');
  clickAction(view, 'sleep-add');

  const controls = view.qa('button, input, select, textarea');
  assert.ok(controls.length > 30, `ohjaimia ${controls.length}`);
  for (const control of controls) {
    assert.ok(accessibleName(control).length > 0, `nimetön ohjain: ${control.outerHTML.slice(0, 90)}`);
    if (control.localName === 'button') assert.ok(control.hasAttribute('type'), 'painikkeella type');
    if (control.localName === 'input' && control.getAttribute('type') === 'number') {
      assert.ok(control.hasAttribute('min') && control.hasAttribute('max'), `${control.id}: min ja max`);
    }
  }
  // Toistuvat painikkeet erottuvat nimeltään (ei viittä samannimistä "Poista").
  assert.equal(accessibleName(view.q('[data-action="habit-step-remove"]')), 'Poista askel 1');
  assert.equal(accessibleName(view.byId('wbhStepInterval-0')), 'Askel 1: Väli (min)');
  for (const group of view.qa('[role="group"]')) {
    assert.ok(accessibleName(group) || group.getAttribute('aria-labelledby'), 'ryhmällä on nimi');
  }
  for (const section of view.qa('section[aria-labelledby]')) {
    assert.ok(view.byId(section.getAttribute('aria-labelledby')), 'osion otsikko löytyy');
  }
});

test('kuuntelijat sidotaan kerran: toistuva init ja piirto eivät tuplaa tallennusta', async t => {
  const view = mount(t);
  initWellbeingHub(view.container);
  initWellbeingHub(view.container);
  renderWellbeingHub(view.container);
  clickAction(view, 'habit-add');
  type(view.byId('wbhHabitName'), 'Nuuska');
  const save = view.q('[data-action="habit-save"]');
  save.click();
  save.click();
  await flush();
  assert.equal(getState().habitPlans.length, 1);
});

test('luonnos säilyy taustan uudelleenpiirrossa; nollaus tyhjentää sen (uloskirjautuminen)', t => {
  const view = mount(t);
  clickAction(view, 'habit-add');
  type(view.byId('wbhHabitName'), 'Keskeneräinen');
  setExerciseSessions([{ id: 'x1', date: TODAY, kind: 'Kävely', actualMinutes: 20 }]);
  assert.equal(view.byId('wbhHabitName').value, 'Keskeneräinen', 'taustamuutos ei pyyhkinyt kirjoitusta');
  resetWellbeingHub();
  renderWellbeingHub(view.container);
  assert.equal(view.byId('wbhHabitName'), null, 'edellisen käyttäjän luonnos ei jää näkyviin');
});

test('tallennuksen tila näkyy: portti kiinni -> "vain tämän istunnon ajan"', t => {
  const view = mount(t);
  const keys = ['wellbeingCheckins', 'habitPlans', 'habitEvents', 'exerciseSessions', 'sleepLogs'];
  const notice = view.q('.lh-notice');
  if (keys.every(key => isTableAvailable(key))) {
    assert.equal(notice, null, 'tallentuva tieto ei tarvitse huomautusta');
  } else {
    assert.ok(notice, 'huomautus näkyy');
    assert.match(notice.textContent, /vain tämän istunnon ajan/);
  }
});

test('lähdekoodi: ei kelloa domainiin, ei lokia, ei index.html-riippuvuutta', () => {
  const source = read('src/app/views/wellbeingHub.js');
  assert.doesNotMatch(source, /console\.|logEvent|logFailure/, 'arkaluonteinen tieto ei kulje lokiin');
  assert.doesNotMatch(source, /(?<![.\w])(?:el|maybe)\(/, 'säiliö annetaan parametrina, ei haeta tunnisteella');
  assert.doesNotMatch(source, /document\.addEventListener|window\.addEventListener/);
  assert.match(source, /offsetMinutesFn: deviceOffsetMinutes/, 'yksi aikamalli: laitteen vyöhyke');
  assert.match(source, /singleFlight/);
});

// ================================================================ tyylit

test('tyylit: U4-lohko kerran, 44 px valinnat, näkyvä fokus, kapean näytön säännöt, ei nowrapia', () => {
  const css = read('src/styles.css');
  assert.equal(css.split('/* ===== U4: ').length - 1, 1, 'alku kerran');
  assert.equal(css.split('/* ===== U4 — loppu ===== */').length - 1, 1, 'loppu kerran');
  const block = css.slice(css.indexOf('/* ===== U4: '), css.indexOf('/* ===== U4 — loppu ===== */'));
  const rules = parseRules(block);
  assert.ok(px(declarations(rules, '.lh-chip')['min-height']) >= 44);
  assert.ok(px(declarations(rules, '.lh-inline input')['min-height']) >= 44);
  for (const selector of ['.lh-chip:focus-visible', '.lh-heading:focus-visible', '.lh-error:focus-visible']) {
    assert.match(declarations(rules, selector).outline || '', /var\(--gold\)/, `${selector} näkyvä fokus`);
  }
  assert.equal(declarations(rules, '.lh-error').display, 'block');
  assert.ok(block.includes('@media (max-width:380px)'), 'kapean näytön säännöt');
  assert.doesNotMatch(block, /nowrap/);
  assert.doesNotMatch(block, /color:var\(--(sage|gold|clay|path)\)/, 'teksti vain *-ink-sävyillä');
  for (const rule of rules) {
    for (const property of ['width', 'min-width']) {
      const value = px(rule.decls[property]);
      assert.ok(value === null || value <= 328, `${rule.selectors.join(', ')} ${property}:${value}`);
    }
  }
});
