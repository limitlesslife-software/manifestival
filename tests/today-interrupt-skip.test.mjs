// Tänään-näkymän keskeytyskortin "Jätä väliin" (INTERRUPTION_KIND.SKIP_ITEM).
//
// LÖYTYNYT PUUTE, JOTA TÄMÄ TESTI VARTIOI
//
// Roadmap lupasi keskeytyksille yhden polun Tänään-kortissa ja puheessa
// ("myöhässä, jatka, ohita, siirrä"), mutta kortissa oli vain "Olen
// myöhässä", "Tämä kestää pidempään" ja "Siirrä loput". Ohitus toimi vain
// puheella tai kirjoitetulla komennolla.
//
// Nyt kortissa on "Jätä väliin", joka kulkee saman esikatselun
// (dayReplanActions.previewDayReplan) ja saman vahvistuksen ja toteutuksen
// (applyReplanPreview -> applyReplanChanges) kautta kuin muut. Kun
// ohitettavaa ei voi päätellä, kortti kysyy (valintapainikkeet), eikä arvaa.
// Valinta kulkee tunnisteena (targetId), joten kaksi samannimistä kohdetta
// ei jää kiertämään kysymystä -- sama korjaus puheen valintaan.
//
// Perusviikko: maanantai 2026-09-28.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDocument, installDocument } from './helpers/a11yDom.mjs';
import { freezeLocalDate } from './helpers/clock.mjs';
import { read } from './helpers/sources.mjs';
import { echoClient } from './helpers/a11ySuunta.mjs';
import { fakeClient } from './helpers/gates.mjs';
import { setUser, clearUser } from '../src/data/session.js';
import { setClient } from '../src/data/client.js';
import { clearAllCollections } from '../src/data/collectionsRepo.js';
import { clearLocalUserData } from '../src/app/actions.js';
import {
  resetState, getState, subscribe, setTasks, setRoutines, setCalendarEvents
} from '../src/app/state.js';
import { resetDailyLifeActions } from '../src/app/dailyLifeActions.js';
import { renderToday, initTodayNavigation } from '../src/app/views/today.js';
import {
  resetTodayDailyLife, applyReplanPreview, interruptionPreview
} from '../src/app/views/todayDailyLife.js';
import { runTypedCommand } from '../src/app/commandBar.js';
import { replanDay } from '../src/domain/dayReplan.js';
import { buildDayPlan } from '../src/domain/scheduler.js';
import { INTERRUPTION_KIND } from '../src/domain/interruptions.js';
import { normalizeRoutine, RECURRENCE } from '../src/domain/routine.js';
import { closeConfirmDialogs } from '../src/ui/confirm.js';
import { clearToasts } from '../src/ui/toast.js';

const INDEX_HTML = read('index.html');
const USER = Object.freeze({ id: 'dddd0007-7777-4777-8777-00000000d0d7', email: 'skip@example.invalid' });
const MON = '2026-09-28';
const TUE = '2026-09-29';

const flush = async (rounds = 20) => {
  for (let i = 0; i < rounds; i += 1) await new Promise(resolve => setImmediate(resolve));
};

function mount(t, time) {
  freezeLocalDate(t, MON, time);
  clearUser();
  clearAllCollections();
  resetState();
  resetDailyLifeActions();
  resetTodayDailyLife();
  const doc = createDocument(INDEX_HTML);
  const uninstall = installDocument(doc);
  setUser(USER);
  setClient(echoClient());
  doc.getElementById('app').classList.remove('app-hidden');
  initTodayNavigation();
  const unsubscribe = subscribe(() => renderToday());
  renderToday();
  t.after(async () => {
    unsubscribe();
    closeConfirmDialogs();
    await flush(4);
    clearToasts();
    resetTodayDailyLife();
    uninstall();
    clearUser();
  });
  const card = () => doc.getElementById('todayInterruptions');
  return {
    doc,
    card,
    text: () => card().textContent.replace(/\s+/g, ' ').trim(),
    q: selector => card().querySelector(selector),
    qa: selector => [...card().querySelectorAll(selector)]
  };
}

async function answerConfirm(doc, accept) {
  await flush(3);
  const dialog = doc.getElementById('confirmDialog');
  assert.ok(dialog && dialog.open, 'vahvistusdialogi on auki');
  doc.getElementById(accept ? 'confirmAccept' : 'confirmCancel').click();
  await flush();
}

function dayTasks() {
  return [
    { id: 't-report', title: 'Raportti', date: MON, time: '09:00', endTime: '10:00', schedulingState: 'auto' },
    { id: 't-mail', title: 'Sähköpostit', date: MON, time: '10:00', endTime: '10:30', schedulingState: 'auto' },
    { id: 't-meeting', title: 'Palaveri', date: MON, time: '10:30', endTime: '11:30', schedulingState: 'manual' },
    { id: 't-car', title: 'Pese auto', date: MON, durationMinutes: 40 }
  ];
}

test('kortissa on kaikki neljä keskeytystä, "Jätä väliin" kolmantena (§43 järjestys)', t => {
  const view = mount(t, '09:30');
  setTasks(dayTasks());
  const kinds = view.qa('[data-td-action="interrupt"]').map(button => button.dataset.kind);
  assert.deepEqual(kinds, [
    INTERRUPTION_KIND.RUNNING_LATE, INTERRUPTION_KIND.EXTEND_CURRENT,
    INTERRUPTION_KIND.SKIP_ITEM, INTERRUPTION_KIND.DEFER_REMAINING
  ]);
  const skip = view.q(`[data-kind="${INTERRUPTION_KIND.SKIP_ITEM}"]`);
  assert.equal(skip.textContent.trim(), 'Jätä väliin');
  assert.equal(skip.getAttribute('type'), 'button');
});

test('KRIITTINEN: "Jätä väliin" käynnissä olevalle joustavalle: ehdotus, vahvistus, toteutus samaa polkua', async t => {
  const view = mount(t, '09:30');
  setTasks(dayTasks());
  const before = JSON.stringify(getState().tasks);

  view.q(`[data-kind="${INTERRUPTION_KIND.SKIP_ITEM}"]`).click();
  await flush();
  const text = view.text();
  assert.match(text, /Ehdotus: Jätä väliin/);
  assert.match(text, /Raportti: klo 9\.00–10\.00 → ilman kellonaikaa/);
  assert.match(text, /Aika vapautuu/);
  assert.equal(JSON.stringify(getState().tasks), before, 'esikatselu ei muuta mitään');
  assert.equal(view.doc.activeElement, view.doc.getElementById('tdReplanTitle'));

  // Peruttu vahvistus ei muuta mitään.
  view.q('[data-td-action="replan-apply"]').click();
  await answerConfirm(view.doc, false);
  assert.equal(JSON.stringify(getState().tasks), before);

  view.q('[data-td-action="replan-apply"]').click();
  await answerConfirm(view.doc, true);
  const report = getState().tasks.find(task => task.id === 't-report');
  assert.equal(report.time, null, 'aika vapautui');
  assert.equal(report.date, MON, 'tehtävä jää päivälle');
  assert.equal(getState().tasks.find(task => task.id === 't-meeting').time, '10:30', 'itse ajastettu ei liiku');
  assert.equal(view.q('.td-proposal'), null, 'tehty ehdotus poistuu');
});

test('ei käynnissä olevaa eikä tulevaa: kortti kysyy valinnoilla, valinta tunnisteella, ei arvausta', async t => {
  const view = mount(t, '12:00');
  setTasks(dayTasks());
  view.q(`[data-kind="${INTERRUPTION_KIND.SKIP_ITEM}"]`).click();
  await flush();
  assert.match(view.text(), /Mikä jää väliin\?/);
  assert.equal(view.q('[data-td-action="replan-apply"]'), null, 'ei muutettavaa ennen valintaa');
  const choices = view.qa('[data-td-action="skip-target"]');
  assert.deepEqual(choices.map(button => button.textContent.trim()), ['Raportti', 'Sähköpostit', 'Pese auto']);
  assert.ok(!choices.some(button => /Palaveri/.test(button.textContent)), 'kiinteää ei tarjota');

  choices.find(button => button.textContent.trim() === 'Pese auto').click();
  await flush();
  assert.match(view.text(), /Pese auto: ilman kellonaikaa → ti 29\.9\./);
  const result = await applyReplanPreview({ confirm: async () => true });
  assert.equal(result.ok, true);
  assert.equal(getState().tasks.find(task => task.id === 't-car').date, TUE);
});

test('kaksi samannimistä kohdetta: valinta tunnisteella ohittaa juuri valitun (kortti ja puhe)', async t => {
  const view = mount(t, '12:00');
  setTasks([
    { id: 'w1', title: 'Työ A', date: MON, durationMinutes: 30 },
    { id: 'w2', title: 'Työ B', date: MON, durationMinutes: 30 }
  ]);
  view.q(`[data-kind="${INTERRUPTION_KIND.SKIP_ITEM}"]`).click();
  await flush();
  view.qa('[data-td-action="skip-target"]').find(button => button.textContent.trim() === 'Työ B').click();
  await flush();
  assert.match(view.text(), /Työ B: ilman kellonaikaa → ti 29\.9\./);
  assert.doesNotMatch(view.text(), /Työ A:/);
  assert.equal(view.qa('[data-td-action="skip-target"]').length, 0, 'ei kysytä uudelleen');
});

test('puhe: valittu kohde kulkee tunnisteena, joten samannimisten joukosta ohitetaan valittu', async t => {
  freezeLocalDate(t, MON, '12:00');
  clearUser();
  clearLocalUserData();
  resetState();
  setUser(USER);
  setClient(fakeClient({ data: [], error: null }));
  setTasks([
    { id: 'w1', title: 'Työ A', date: MON, durationMinutes: 30 },
    { id: 'w2', title: 'Työ B', date: MON, durationMinutes: 30 }
  ]);
  const choices = [];
  const confirms = [];
  const result = await runTypedCommand('jätän työn väliin', {
    now: new Date(), fetchImpl: async () => { throw new Error('ei verkkoa'); },
    chooseFn: async (candidates, question) => { choices.push({ candidates, question }); return candidates.find(c => c.label === 'Työ B'); },
    confirmFn: async proposal => { confirms.push(proposal); return true; }
  });
  assert.equal(choices.length, 1, 'kysytään kerran');
  assert.equal(confirms.length, 1);
  assert.equal(result.status, 'executed');
  const tasks = new Map(getState().tasks.map(task => [task.id, task]));
  assert.equal(tasks.get('w2').date, TUE);
  assert.equal(tasks.get('w1').date, MON);
});

test('kiinteä käynnissä oleva meno: ei ohiteta, kortti kertoo miksi eikä tarjoa muutosta', async t => {
  const view = mount(t, '10:15');
  setCalendarEvents([{ id: 'e-call', title: 'Puhelu', date: MON, startTime: '10:00', endTime: '10:30' }]);
  view.q(`[data-kind="${INTERRUPTION_KIND.SKIP_ITEM}"]`).click();
  await flush();
  assert.match(view.text(), /Puhelu on kiinteä, eikä sitä ohiteta automaattisesti/);
  assert.equal(view.q('[data-td-action="replan-apply"]'), null);
  assert.deepEqual(getState().calendarEvents.map(event => event.startTime), ['10:00']);
});

test('joustava rutiini: tämän päivän kerta jää väliin rutiinin omalla toiminnolla', async t => {
  const view = mount(t, '12:00');
  setRoutines([normalizeRoutine({
    id: 'r-walk', title: 'Kävely', active: true, recurrence: { type: RECURRENCE.DAILY, weekdays: [] }, durationMinutes: 30
  })]);
  view.q(`[data-kind="${INTERRUPTION_KIND.SKIP_ITEM}"]`).click();
  await flush();
  const choice = view.qa('[data-td-action="skip-target"]').find(button => button.textContent.trim() === 'Kävely');
  assert.ok(choice, 'rutiini tarjotaan valinnaksi');
  choice.click();
  await flush();
  assert.match(view.text(), /Kävely: ilman kellonaikaa → jää tänään väliin/);
  const result = await applyReplanPreview({ confirm: async () => true });
  assert.equal(result.ok, true);
  assert.ok(getState().routineExceptions.some(e => e.routineId === 'r-walk' && e.date === MON && e.type === 'skip'));
});

test('esikatselu on sama polku: kortin interruptionPreview ja domainin targetId', t => {
  freezeLocalDate(t, MON, '12:00');
  resetState();
  setTasks(dayTasks());
  const viaCard = interruptionPreview(INTERRUPTION_KIND.SKIP_ITEM, null, { state: getState(), now: new Date(), targetId: 't-mail' });
  assert.equal(viaCard.changes.length, 1);
  assert.equal(viaCard.changes[0].taskId, 't-mail');

  const plan = buildDayPlan({ tasks: getState().tasks, profile: getState().profile, dateIso: MON, todayIso: MON });
  const unknown = replanDay({
    plan, interruption: { kind: INTERRUPTION_KIND.SKIP_ITEM, targetId: 'ei-ole' }, nowMinutes: 720, todayIso: MON, tasks: getState().tasks
  });
  assert.deepEqual([...unknown.changes], []);
  assert.equal(unknown.question, 'Mikä jää väliin?');
  assert.match(unknown.summary, /ei enää löytynyt/);
  const fixed = replanDay({
    plan, interruption: { kind: INTERRUPTION_KIND.SKIP_ITEM, targetId: 't-meeting' }, nowMinutes: 720, todayIso: MON, tasks: getState().tasks
  });
  assert.deepEqual([...fixed.changes], [], 'kiinteää ei ohiteta tunnisteellakaan');
  assert.match(fixed.warnings.join(' '), /Palaveri on kiinteä/);
});
