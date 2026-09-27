// Tänään-näkymän arjen kortit (src/app/views/todayDailyLife.js ja today.js)
// oikeassa, jäsennetyssä index.html-DOMissa.
//
// LUPAUKSET
//   - Kortti näkyy vain, kun sillä on sanottavaa tänään (tyhjä kortti on melua).
//   - Lähtö-, aamu- ja uniluvut ovat samat kuin dailyLifeModel.js antaa.
//   - "Avaa reitti" on aina sallittu https-osoite, jonka koostaa navigationLink.js.
//   - "Lähdin nyt" / "Olin perillä" kirjaavat havainnon, eivät laske samaa
//     myöhästymistä kahdesti.
//   - Tapakirjaus on neutraali; keskeytyksen ehdotus ei muuta mitään ennen
//     vahvistusta, eivätkä kiinteät menot liiku.
//   - Motivaatio ja hallinnan tunne: puuttuva arvo ei ole nolla.
//
// Perusviikko: maanantai 2026-09-28.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDocument, installDocument, accessibleName } from './helpers/a11yDom.mjs';
import { freezeLocalDate } from './helpers/clock.mjs';
import { read } from './helpers/sources.mjs';
import { echoClient } from './helpers/a11ySuunta.mjs';
import { setUser, clearUser } from '../src/data/session.js';
import { setClient } from '../src/data/client.js';
import { clearAllCollections } from '../src/data/collectionsRepo.js';
import {
  resetState, getState, subscribe, setTasks, setSavedPlaces, setCalendarEvents, setCommuteObservations,
  setLifeSettings, setHabitPlans, setWellbeingCheckins, setViewDate, setSleepLogs
} from '../src/app/state.js';
import { resetDailyLifeActions } from '../src/app/dailyLifeActions.js';
import { departuresOn, morningPlanOn } from '../src/app/dailyLifeModel.js';
import { renderToday, initTodayNavigation, resolveNowState } from '../src/app/views/today.js';
import {
  resetTodayDailyLife, placeIdForText, departurePhaseText, taskPatch, splitReplanChanges,
  departureObservation, arrivalObservation, interruptionPreview, applyReplanPreview, dayPlanFor
} from '../src/app/views/todayDailyLife.js';
import { isAllowedNavigationUrl } from '../src/domain/navigationLink.js';
import { DEPARTURE_PHASE } from '../src/domain/departure.js';
import { REPLAN_CHANGE } from '../src/domain/dayReplan.js';
import { INTERRUPTION_KIND } from '../src/domain/interruptions.js';
import { closeConfirmDialogs } from '../src/ui/confirm.js';
import { clearToasts } from '../src/ui/toast.js';

const INDEX_HTML = read('index.html');
const USER = Object.freeze({ id: 'dddd0003-3333-4333-8333-00000000d0d3', email: 'today@example.invalid' });
const OTHER = Object.freeze({ id: 'dddd0004-4444-4444-8444-00000000d0d4', email: 'other@example.invalid' });
const MON = '2026-09-28';
const TUE = '2026-09-29';
const THU = '2026-10-01';
const CARD_IDS = Object.freeze([
  'todayDeparture', 'todayMorning', 'todayHabits', 'todayInterruptions', 'todayOpenEnded', 'todayTomorrow'
]);

const flush = async (rounds = 20) => {
  for (let i = 0; i < rounds; i += 1) await new Promise(resolve => setImmediate(resolve));
};

function localMs(dateIso, time) {
  const [y, m, d] = dateIso.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  return new Date(y, m - 1, d, hh, mm, 0, 0).getTime();
}

/** Asenna päivänäkymä oikeaan index.html-DOMiin, kello jäädytettynä. */
function mount(t, { date = MON, time = '12:00' } = {}) {
  freezeLocalDate(t, date, time);
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
  const byId = id => doc.getElementById(id);
  return {
    doc,
    byId,
    text: id => byId(id).textContent.replace(/\s+/g, ' ').trim(),
    q: (id, selector) => byId(id).querySelector(selector),
    qa: (id, selector) => byId(id).querySelectorAll(selector),
    /** Siirrä kelloa ja piirrä (30 s:n tikitys tekee saman sovelluksessa). */
    at(clockTime, dateIso = date) {
      t.mock.timers.setTime(localMs(dateIso, clockTime));
      renderToday();
    }
  };
}

const DENTIST_PLACE = Object.freeze({
  id: 'p-dentist', name: 'Hammaslääkäri', address: 'Mannerheimintie 1, Helsinki', area: 'Tammisto',
  travelMode: 'driving', usualTravelMinutes: 25, preparationMinutes: 15, arrivalBufferMinutes: 10, overheadMinutes: 5
});

const DENTIST_EVENT = Object.freeze({
  id: 'e-dentist', title: 'Hammaslääkäri', date: MON, startTime: '09:00', endTime: '09:45', placeId: 'p-dentist'
});

/** Hammaslääkäri klo 9: perillä 8.50, lähtö 8.20, valmistautuminen alkaa 8.05. */
function seedDentist({ place = DENTIST_PLACE, event = DENTIST_EVENT } = {}) {
  setSavedPlaces([place]);
  setCalendarEvents([event]);
}

async function answerConfirm(doc, accept) {
  await flush(3);
  const dialog = doc.getElementById('confirmDialog');
  assert.ok(dialog && dialog.open, 'vahvistusdialogi on auki');
  doc.getElementById(accept ? 'confirmAccept' : 'confirmCancel').click();
  await flush();
}

// ================================================================ näkyvyys

test('kortit näkyvät vain kun niillä on sanottavaa: tyhjä arkipäivä keskipäivällä ei näytä yhtään', t => {
  const view = mount(t);
  for (const id of CARD_IDS) assert.equal(view.byId(id).innerHTML.trim(), '', `${id} on tyhjä`);
});

test('kortit vain kuluvana päivänä: eilistä katsottaessa arjen kortit ovat tyhjiä', t => {
  const view = mount(t, { time: '07:00' });
  seedDentist();
  setHabitPlans([{ id: 'h1', kind: 'nicotine', name: 'Nikotiini', minIntervalMinutes: 60, active: true }]);
  assert.match(view.text('todayDeparture'), /Seuraava lähtö/);
  assert.match(view.text('todayHabits'), /Nikotiini/);
  const [y, m, d] = MON.split('-').map(Number);
  setViewDate(new Date(y, m - 1, d - 1));
  for (const id of CARD_IDS) assert.equal(view.byId(id).innerHTML.trim(), '', `${id} on tyhjä eilen`);
});

// ================================================================ seuraava lähtö

test('seuraava lähtö: vaihe tekstinä koko aamun ajan (valmistaudu, nyt, 5 min, lähde nyt, myöhässä)', t => {
  const view = mount(t, { time: '07:00' });
  seedDentist();
  const phase = () => view.q('todayDeparture', '.td-phase').textContent.trim();

  assert.equal(phase(), 'Valmistaudu klo 8.05');
  view.at('07:55');
  assert.equal(phase(), 'Valmistaudu klo 8.05', 'valmistautuminen pian: aika näkyy');
  view.at('08:10');
  assert.equal(phase(), 'Valmistaudu nyt');
  view.at('08:15');
  assert.equal(phase(), 'Lähde 5 minuutin päästä');
  view.at('08:20');
  assert.equal(phase(), 'Lähde nyt');
  view.at('08:27');
  assert.equal(phase(), 'Myöhässä 7 min');
  assert.ok(view.q('todayDeparture', '.td-phase.is-late'), 'myöhässä on myös merkitty');
  view.at('09:01');
  assert.equal(view.byId('todayDeparture').innerHTML.trim(), '', 'alkanut meno ilman lähtökuittausta: ei korttia');
});

test('seuraava lähtö: erittely kertoo osat ja matka-ajan lähteen; luvut ovat dailyLifeModelin', t => {
  const view = mount(t, { time: '07:00' });
  seedDentist();
  const lines = view.qa('todayDeparture', '.td-lines li').map(li => li.textContent.trim());
  assert.deepEqual(lines, [
    'Valmistautuminen 15 min · alkaa klo 8.05',
    'Matka 25 min · oma arvio · lähde klo 8.20',
    'Pysäköinti ja kävely 5 min',
    'Etuaika 10 min · perillä klo 8.50'
  ]);
  const [model] = departuresOn(MON, { state: getState(), now: new Date() });
  assert.equal(model.departure.leave.time, '08:20', 'kortti ja malli: sama lähtöaika');
  assert.equal(model.departure.prepareStart.time, '08:05');
  assert.match(view.text('todayDeparture'), /Hammaslääkäri · alkaa klo 9\.00/);
});

test('seuraava lähtö: opittu kesto vain luvalla ja nimettynä, tuntematon matka ei keksi lähtöaikaa', t => {
  const view = mount(t, { time: '07:00' });
  seedDentist({ place: { ...DENTIST_PLACE, useLearned: true } });
  setCommuteObservations([30, 32, 40].map((minutes, index) => ({
    id: `o${index}`, placeId: 'p-dentist', observedOn: `2026-09-2${index + 1}`, travelMinutes: minutes
  })));
  assert.match(view.text('todayDeparture'), /Matka 40 min · opittu omista matkoista/);

  setSavedPlaces([{ ...DENTIST_PLACE, usualTravelMinutes: null, useLearned: false }]);
  setCommuteObservations([]);
  assert.equal(view.q('todayDeparture', '.td-phase').textContent.trim(), 'Matka-aika puuttuu');
  assert.match(view.text('todayDeparture'), /Lisää paikalle tai menolle oma arvio matka-ajasta/);
  assert.doesNotMatch(view.text('todayDeparture'), /lähde klo/, 'tuntematonta lähtöaikaa ei näytetä');
});

test('seuraava lähtö: verkkopalaveri ilman paikkaa tai matka-aikaa ei ole lähtö', t => {
  const view = mount(t, { time: '07:00' });
  setCalendarEvents([{ id: 'e-call', title: 'Etäpalaveri', date: MON, startTime: '10:00', endTime: '10:30' }]);
  assert.equal(view.byId('todayDeparture').innerHTML.trim(), '');
});

test('KRIITTINEN: Avaa reitti on sallittu https-linkki uuteen ikkunaan, ei koskaan datasta tullut osoite', t => {
  const view = mount(t, { time: '07:00' });
  seedDentist();
  const link = view.q('todayDeparture', 'a[data-td-route]');
  assert.ok(link, 'reittilinkki puuttuu');
  const href = link.getAttribute('href');
  assert.ok(isAllowedNavigationUrl(href), href);
  assert.ok(href.startsWith('https://www.google.com/maps/dir/?api=1&destination='), href);
  assert.match(href, /Mannerheimintie%201%2C%20Helsinki/);
  assert.equal(link.getAttribute('target'), '_blank');
  assert.match(link.getAttribute('rel'), /\bnoopener\b/);
  assert.equal(accessibleName(link).startsWith('Avaa reitti'), true);

  // Vihamielinen osoite: skeema ja merkintä siivotaan, isäntä pysyy samana.
  setSavedPlaces([{ ...DENTIST_PLACE, address: 'javascript:alert(1)//<img src=x onerror=alert(2)>' }]);
  const hostile = view.q('todayDeparture', 'a[data-td-route]').getAttribute('href');
  assert.ok(isAllowedNavigationUrl(hostile), hostile);
  assert.doesNotMatch(hostile, /javascript|%3Cimg|<img/i);

  // Osoite, josta ei jää mitään: nimi on kohde. Ilman kumpaakaan linkkiä ei ole.
  setSavedPlaces([{ ...DENTIST_PLACE, address: 'javascript:' }]);
  assert.match(view.q('todayDeparture', 'a[data-td-route]').getAttribute('href'), /destination=Hammasl%C3%A4%C3%A4k%C3%A4ri&/);
});

test('reittilinkki: selaimessa ilman natiivisiltaa ei ole natiivipainiketta', t => {
  const view = mount(t, { time: '07:00' });
  seedDentist();
  assert.equal(view.q('todayDeparture', '[data-td-action="route"]'), null);
  const source = read('src/app/views/todayDailyLife.js');
  assert.match(source, /platform\.alarms/, 'natiivi reitti tunnistetaan herätyssillasta');
  assert.match(source, /typeof alarms\.openNavigation === 'function'/);
});

test('Lähdin nyt ja Olin perillä kirjaavat havainnot: lähtö kerran, matka-aika ovelta ovelle miinus pysäköinti', async t => {
  const view = mount(t, { time: '08:07' });
  seedDentist();
  view.q('todayDeparture', '[data-td-action="departed"]').click();
  await flush();

  let observations = getState().commuteObservations;
  assert.equal(observations.length, 1);
  const [departed] = observations;
  assert.equal(departed.placeId, 'p-dentist');
  assert.equal(departed.eventId, 'e-dentist');
  assert.equal(departed.observedOn, MON);
  assert.equal(departed.plannedDeparture, '08:20');
  assert.equal(departed.actualDeparture, '08:07');
  assert.equal(departed.travelMinutes, null, 'lähtö yksin ei ole matka-aika');
  assert.equal(departed.source, 'user_confirmed');
  assert.equal(view.q('todayDeparture', '.td-phase').textContent.trim(), 'Lähdit klo 8.07');
  assert.equal(view.q('todayDeparture', '[data-td-action="departed"]'), null, 'lähtöä ei kirjata kahdesti');

  view.at('08:40');
  view.q('todayDeparture', '[data-td-action="arrived"]').click();
  await flush();
  observations = getState().commuteObservations;
  assert.equal(observations.length, 2);
  const arrived = observations.find(o => o.arrivalAt);
  assert.equal(arrived.arrivalAt, '08:40');
  assert.equal(arrived.travelMinutes, 28, '33 min ovelta ovelle - 5 min pysäköinti ja kävely');
  assert.equal(arrived.actualDeparture, null, 'myöhästyminen ei laske kahdesti');
  assert.equal(arrived.arrivalResult, 'early', 'perillä ennen 8.50');
  assert.equal(view.byId('todayDeparture').innerHTML.trim(), '', 'perillä kuitattu: kortti poistuu');
  assert.match(view.doc.getElementById('toastHost').textContent, /Perillä klo 8\.40\. Matka kesti 28 min\./);
});

test('havaintojen rakentajat: suunniteltu lähtö vain samalta päivältä, perilläolo alun jälkeen on myöhässä', () => {
  const [year, month, day] = MON.split('-').map(Number);
  const dayAbs = Math.round(Date.UTC(year, month - 1, day) / 86400000) * 1440;
  const item = {
    place: { id: 'p1' },
    occurrence: { id: 'event:e1:2026-09-28', eventId: 'e1' },
    departure: {
      known: true,
      leave: { date: '2026-09-27', time: '23:50' },
      eventStart: { date: MON, time: '00:30', abs: dayAbs + 30 },
      arrivalTarget: null,
      parts: { preparation: 0, overhead: 0 }
    }
  };
  assert.equal(departureObservation(item, { todayIso: MON, nowMinutes: 5 }).plannedDeparture, null,
    'eilinen lähtöaika ei ole tämän päivän suunnitelma');

  const morning = {
    ...item,
    departure: {
      ...item.departure,
      leave: { date: MON, time: '08:00' },
      arrivalTarget: { date: MON, time: '08:50', abs: dayAbs + 530 },
      eventStart: { date: MON, time: '09:00', abs: dayAbs + 540 }
    }
  };
  const late = arrivalObservation(morning, { todayIso: MON, nowMinutes: 9 * 60 + 5 }, []);
  assert.equal(late.travelMinutes, null, 'ilman lähtökuittausta matka-aikaa ei lasketa');
  assert.equal(late.plannedDeparture, '08:00');
  assert.equal(late.arrivalResult, 'late');
  assert.equal(arrivalObservation(morning, { todayIso: MON, nowMinutes: 8 * 60 + 55 }, []).arrivalResult, 'on_time');
  assert.equal(arrivalObservation(morning, { todayIso: MON, nowMinutes: 8 * 60 + 45 }, []).arrivalResult, 'early');
});

// ================================================================ tavat

test('tapakortti: vain aktiivinen nikotiinisuunnitelma; Kirjaa nyt, Siirrä 15 min ja Ohita kirjaavat neutraalisti', async t => {
  const view = mount(t, { time: '12:00' });
  setHabitPlans([
    { id: 'h-gen', kind: 'generic', name: 'Kahvi', minIntervalMinutes: 60, active: true },
    { id: 'h-off', kind: 'nicotine', name: 'Vanha', minIntervalMinutes: 60, active: false },
    { id: 'h1', kind: 'nicotine', name: 'Nikotiini', minIntervalMinutes: 60, dailyTarget: 8, active: true }
  ]);
  const rows = view.qa('todayHabits', 'li.assist-row');
  assert.equal(rows.length, 1, 'yksi kortti: aktiivinen nikotiini');
  assert.match(view.text('todayHabits'), /Nyt on suunniteltu aika\./);
  assert.match(view.text('todayHabits'), /Tänään 0 kertaa, suunnitelmassa 8\./);

  const click = action => view.q('todayHabits', `[data-habit-action="${action}"]`).click();
  const use = view.q('todayHabits', '[data-habit-action="use"]');
  assert.equal(accessibleName(use), 'Kirjaa nyt: Nikotiini');
  click('use');
  await flush();
  assert.match(view.text('todayHabits'), /Seuraava suunniteltu aika 13\.00/);
  assert.match(view.text('todayHabits'), /Tänään 1 kerta, suunnitelmassa 8\./);
  click('delay');
  await flush();
  click('skip');
  await flush();
  assert.deepEqual(getState().habitEvents.map(e => e.action), ['use', 'delay', 'skip']);
  assert.ok(getState().habitEvents.every(e => e.planId === 'h1'));
  const text = view.text('todayHabits') + view.doc.getElementById('toastHost').textContent;
  assert.doesNotMatch(text, /retkahd|epäonnist|huono|lipsah/i, 'ei moralisoivaa kieltä');
});

// ================================================================ keskeytykset

function interruptionTasks() {
  return [
    { id: 't-report', title: 'Raportti', date: MON, time: '09:00', endTime: '10:00', schedulingState: 'auto' },
    { id: 't-mail', title: 'Sähköpostit', date: MON, time: '10:00', endTime: '10:30', schedulingState: 'auto' },
    { id: 't-meeting', title: 'Palaveri', date: MON, time: '10:30', endTime: '11:30', schedulingState: 'manual' },
    { id: 't-car', title: 'Pese auto', date: MON, durationMinutes: 40 }
  ];
}

test('KRIITTINEN: keskeytyksen ehdotus ei muuta mitään ennen vahvistusta, peruutus jättää päivän ennalleen', async t => {
  const view = mount(t, { time: '09:05' });
  setTasks(interruptionTasks());
  setSavedPlaces([DENTIST_PLACE]);
  setCalendarEvents([{ ...DENTIST_EVENT, startTime: '13:00', endTime: '13:45' }]);
  const before = JSON.stringify(getState().tasks);
  const eventsBefore = JSON.stringify(getState().calendarEvents);

  assert.match(view.text('todayInterruptions'), /Jos päivä muuttuu/);
  const late = view.q('todayInterruptions', '[data-td-action="interrupt"][data-kind="running_late"]');
  assert.equal(late.getAttribute('aria-expanded'), 'false');
  late.click();
  await flush();
  assert.equal(view.q('todayInterruptions', '[data-kind="running_late"]').getAttribute('aria-expanded'), 'true');
  const minutes = view.qa('todayInterruptions', '[data-td-action="minutes"]').map(b => b.textContent.trim());
  assert.deepEqual(minutes, ['5 min', '10 min', '15 min', '30 min']);
  view.q('todayInterruptions', '[data-minutes="10"]').click();
  await flush();

  const preview = view.text('todayInterruptions');
  assert.match(preview, /Ehdotus: Olen myöhässä 10 min/);
  assert.match(preview, /Raportti: klo 9\.00–10\.00 → klo 9\.10–10\.10/);
  assert.match(preview, /Sähköpostit: klo 10\.00–10\.30 → klo 11\.30–12\.00/);
  assert.doesNotMatch(preview, /Palaveri: klo/, 'itse ajastettu pysyy');
  assert.equal(view.doc.activeElement, view.byId('tdReplanTitle'), 'fokus ehdotuksen otsikkoon');
  assert.equal(JSON.stringify(getState().tasks), before, 'esikatselu ei muuta mitään');

  view.q('todayInterruptions', '[data-td-action="replan-apply"]').click();
  await answerConfirm(view.doc, false);
  assert.equal(JSON.stringify(getState().tasks), before, 'peruttu vahvistus: päivä ennallaan');
  assert.ok(view.q('todayInterruptions', '[data-td-action="replan-apply"]'), 'ehdotus jää näkyviin');

  view.q('todayInterruptions', '[data-td-action="replan-apply"]').click();
  await answerConfirm(view.doc, true);
  const tasks = new Map(getState().tasks.map(task => [task.id, task]));
  assert.equal(tasks.get('t-report').time, '09:10');
  assert.equal(tasks.get('t-report').endTime, '10:10');
  assert.equal(tasks.get('t-report').schedulingState, 'auto', 'siirretty pysyy joustavana');
  assert.equal(tasks.get('t-mail').time, '11:30');
  assert.equal(tasks.get('t-meeting').time, '10:30', 'itse ajastettu ei liiku');
  assert.equal(JSON.stringify(getState().calendarEvents), eventsBefore, 'menot eivät liiku koskaan');
  assert.equal(view.q('todayInterruptions', '.td-proposal'), null, 'tehty ehdotus poistuu');
});

test('Siirrä loput: ehdotus siirtää jäljellä olevat joustavat tehtävät, ei käynnissä olevaa eikä kiinteitä', async t => {
  const view = mount(t, { time: '09:30' });
  setTasks(interruptionTasks());
  view.q('todayInterruptions', '[data-kind="defer_remaining"]').click();
  await flush();
  const text = view.text('todayInterruptions');
  assert.match(text, /Ehdotus: Siirrä loput/);
  assert.match(text, /Sähköpostit: klo 10\.00–10\.30 → ti 29\.9\./);
  assert.match(text, /Pese auto: ilman kellonaikaa → ti 29\.9\./);
  assert.doesNotMatch(text, /Raportti:/, 'käynnissä oleva säilyy');
  assert.doesNotMatch(text, /Palaveri:/, 'itse ajastettu säilyy');

  const result = await applyReplanPreview({ confirm: async () => true });
  assert.equal(result.ok, true);
  const tasks = new Map(getState().tasks.map(task => [task.id, task]));
  assert.equal(tasks.get('t-mail').date, TUE);
  assert.equal(tasks.get('t-mail').time, null, 'siirretty ilman kellonaikaa');
  assert.equal(tasks.get('t-car').date, TUE);
  assert.equal(tasks.get('t-report').date, MON);
});

test('keskeytyskortti puuttuu, kun päivässä ei ole mitään siirrettävää', t => {
  const view = mount(t, { time: '09:05' });
  assert.equal(view.byId('todayInterruptions').innerHTML.trim(), '');
});

test('ehdotus unohtuu, kun käyttäjä vaihtuu (ei vuoda seuraavalle)', async t => {
  const view = mount(t, { time: '09:05' });
  setTasks(interruptionTasks());
  view.q('todayInterruptions', '[data-kind="defer_remaining"]').click();
  await flush();
  assert.ok(view.q('todayInterruptions', '.td-proposal'));
  setUser(OTHER);
  renderToday();
  assert.equal(view.q('todayInterruptions', '.td-proposal'), null);
  const result = await applyReplanPreview({ confirm: async () => true });
  assert.equal(result.ok, false);
});

test('muutosten jako ja tehtäväkentät: rutiinin siirto on vain tieto, kiinteä ei koskaan muutos', () => {
  const state = { tasks: [{ id: 't1', time: '09:00', schedulingState: 'auto' }] };
  const changes = [
    { kind: REPLAN_CHANGE.SHIFT, taskId: 't1', from: { date: MON, time: '09:00' }, to: { date: MON, time: '09:10', endTime: '10:10' } },
    { kind: REPLAN_CHANGE.SHIFT, taskId: null, routineOccurrenceId: 'routine:r1:x', routineId: 'r1', from: { date: MON, time: '14:00' }, to: { date: MON, time: '14:30' } },
    { kind: REPLAN_CHANGE.SKIP, taskId: null, routineId: 'r2', from: { date: MON, time: null }, to: null },
    { kind: REPLAN_CHANGE.SHIFT, taskId: 'event:e1:2026-09-28', from: { date: MON, time: '12:00' }, to: { date: MON, time: '12:10' } }
  ];
  const { applicable, informational } = splitReplanChanges(changes, state);
  assert.deepEqual(applicable.map(c => c.taskId || c.routineId), ['t1', 'r2']);
  assert.equal(informational.length, 2, 'rutiinin siirto ja tuntematon kohde eivät muutu');

  assert.deepEqual(taskPatch(changes[0], state.tasks[0]), { time: '09:10', endTime: '10:10', schedulingState: 'auto' });
  assert.deepEqual(taskPatch({ kind: REPLAN_CHANGE.EXTEND, to: { endTime: '10:30' } }, {}), { endTime: '10:30' });
  assert.deepEqual(taskPatch({ kind: REPLAN_CHANGE.SKIP }, {}), { time: null, endTime: null });
  assert.deepEqual(taskPatch({ kind: REPLAN_CHANGE.DEFER, to: { date: TUE } }, { time: '09:00' }), { date: TUE, time: null, endTime: null });
  assert.deepEqual(taskPatch({ kind: REPLAN_CHANGE.DEFER, to: { date: TUE } }, { time: null }), { date: TUE });
});

test('keskeytyksen ehdotus käyttää päivän kalenteria: meno ja sen matka ovat esteitä', t => {
  mount(t, { time: '09:05' });
  setTasks([
    { id: 't-a', title: 'Raportti', date: MON, time: '09:00', endTime: '10:00', schedulingState: 'auto' },
    { id: 't-b', title: 'Luonnos', date: MON, time: '10:00', endTime: '10:30', schedulingState: 'auto' }
  ]);
  setSavedPlaces([DENTIST_PLACE]);
  // Meno klo 11: valmistautuminen alkaa 10.05, joten 9.10 alkava tunnin
  // raportti ei enää mahdu ennen sitä. Valmistautuminen, matka ja meno ovat
  // esteitä: raportti siirtyy menon jälkeen ja luonnos sen perään.
  setCalendarEvents([{ ...DENTIST_EVENT, startTime: '11:00', endTime: '11:30' }]);
  const result = interruptionPreview(INTERRUPTION_KIND.RUNNING_LATE, 10, { state: getState(), now: new Date() });
  const report = result.changes.find(change => change.taskId === 't-a');
  const draft = result.changes.find(change => change.taskId === 't-b');
  assert.equal(report.to.time, '11:30', 'raportti menon jälkeen, ei valmistautumisen päälle');
  assert.match(report.reason, /Hammaslääkäri pysyy paikallaan/);
  assert.equal(draft.to.time, '12:30', 'luonnos raportin perään');
  assert.equal(result.requiresConfirmation, true);
  assert.ok(result.changes.every(change => change.taskId === 't-a' || change.taskId === 't-b'), 'menoa tai lohkoa ei siirretä');
  assert.ok(result.untouched.includes(`event:e-dentist:${MON}`));
});

// ================================================================ aikajana

test('aikajana: menot ja suojatut lohkot tekstimerkinnöin, ei kuittausruutua menolle', t => {
  const view = mount(t, { time: '07:00' });
  seedDentist();
  const tags = view.qa('todayTimelineContainer', '.kind-tag').map(tag => tag.textContent.trim());
  for (const label of ['Uni', 'Valmistautuminen', 'Matka', 'Pysäköinti ja kävely', 'Etuaika', 'Meno', 'Iltarauhoittuminen']) {
    assert.ok(tags.includes(label), `${label} puuttuu: ${tags.join(', ')}`);
  }
  const eventRow = view.q('todayTimelineContainer', '.t-item.t-event');
  assert.match(eventRow.textContent, /Hammaslääkäri/);
  assert.equal(eventRow.querySelector('[data-toggle]'), null, 'menoa ei kuitata tehtävänä');
  assert.equal(eventRow.querySelector('[data-edit]'), null);
  assert.equal(view.q('todayTimelineContainer', '.t-item.t-block [data-toggle]'), null);
});

test('KRIITTINEN: päättynyt meno tai lohko ei ole "myöhässä"', () => {
  const items = [
    { id: 'block:travel:x:2026-09-28', kind: 'travel', blockKind: 'travel', block: true, date: MON, time: '08:20', endTime: '08:45' },
    { id: 'event:e1:2026-09-28', isEvent: true, source: 'event', date: MON, time: '09:00', endTime: '09:45' }
  ];
  assert.deepEqual(resolveNowState(items, 10 * 60), { index: -1, status: 'running' });
  const withTask = [...items, { id: 't1', time: '09:50', endTime: '10:00', completed: false }];
  assert.equal(resolveNowState(withTask, 10 * 60 + 30).status, 'late', 'tehtävä on yhä myöhässä-tarkistuksessa');
  assert.equal(resolveNowState(items, 8 * 60 + 30).index, 0, 'käynnissä oleva lohko on NYT');
});

test('päivän suunnitelma: meno ja matka eivät ole vapaata aikaa', t => {
  mount(t, { time: '07:00' });
  seedDentist();
  const plan = dayPlanFor(MON, { state: getState(), now: new Date(), todayIso: MON });
  const overlapping = plan.freeSlots.filter(slot => slot.start < 9 * 60 + 45 && slot.end > 8 * 60 + 5);
  assert.deepEqual(overlapping, [], 'valmistautumisesta menon loppuun ei ole vapaata väliä');
  assert.equal(plan.eventItems.length, 1);
  assert.ok(plan.blocks.some(block => block.kind === 'travel'));
});

// ================================================================ hyvinvointi

test('motivaatio ja hallinnan tunne: puuttuva ei ole nolla, tallennus säilyttää toisen arvon', async t => {
  const view = mount(t);
  const group = label => view.qa('todayWellbeing', '[role="radiogroup"]').find(node => node.getAttribute('aria-label') === label);
  for (const label of ['Motivaatio', 'Hallinnan tunne']) {
    const radios = group(label).querySelectorAll('[role="radio"]');
    assert.equal(radios.length, 5);
    assert.ok(radios.every(radio => radio.getAttribute('aria-checked') === 'false'), `${label}: ei valintaa`);
    assert.deepEqual(radios.map(radio => radio.textContent.trim()), ['1', '2', '3', '4', '5'], 'asteikossa ei ole nollaa');
  }

  group('Motivaatio').querySelector('[data-wb-value="4"]').click();
  await flush();
  let [checkin] = getState().wellbeingCheckins;
  assert.equal(checkin.date, MON);
  assert.equal(checkin.motivation, 4);
  assert.equal(checkin.control, null, 'hallinnan tunne on yhä tuntematon');
  assert.equal(group('Motivaatio').querySelector('[data-wb-value="4"]').getAttribute('aria-checked'), 'true');
  assert.ok(group('Hallinnan tunne').querySelectorAll('[role="radio"]').every(r => r.getAttribute('aria-checked') === 'false'));

  group('Hallinnan tunne').querySelector('[data-wb-value="2"]').click();
  await flush();
  [checkin] = getState().wellbeingCheckins;
  assert.equal(getState().wellbeingCheckins.length, 1, 'yksi rivi päivää kohti');
  assert.equal(checkin.motivation, 4);
  assert.equal(checkin.control, 2);
  assert.equal(getState().wellbeing.length, 0, 'energia, mieliala ja kuormitus eivät muutu');
});

test('aiempi kirjaus näkyy valittuna vain omalla päivällään', t => {
  const view = mount(t);
  setWellbeingCheckins([{ id: 'c-old', date: '2026-09-27', motivation: 5, control: 5 }]);
  const checked = view.qa('todayWellbeing', '[data-wb-checkin][aria-checked="true"]');
  assert.equal(checked.length, 0);
});

// ================================================================ avoimet asiat

function seedErrands() {
  setSavedPlaces([
    { id: 'p-motonet', name: 'Motonet', area: 'Tammisto', usualTravelMinutes: 20 },
    { id: 'p-hammas', name: 'Hammaslääkäri', area: 'Tammisto', usualTravelMinutes: 20, preparationMinutes: 0, arrivalBufferMinutes: 5, overheadMinutes: 0 }
  ]);
  setCalendarEvents([{ id: 'e-hammas', title: 'Hammaslääkäri', date: THU, startTime: '10:00', endTime: '11:00', placeId: 'p-hammas' }]);
  setTasks([
    { id: 't-motonet', title: 'Käy Motonetissä', deadline: '2026-10-02', durationMinutes: 20 },
    { id: 't-later', title: 'Kirjasto', deadline: '2026-10-20' },
    { id: 't-done', title: 'Valmis asia', deadline: '2026-09-30', completed: true }
  ]);
}

test('avoimet asiat: määräaika tällä viikolla, asiointiryhmä kertoo jo suunnitellun menon', t => {
  const view = mount(t);
  seedErrands();
  const text = view.text('todayOpenEnded');
  assert.match(text, /Avoimet asiat 1/);
  assert.match(text, /Käy Motonetissä/);
  assert.match(text, /Määräaika pe 2\.10\. · Motonet/);
  assert.doesNotMatch(text, /Kirjasto/, 'kaukainen määräaika ei ole tämän viikon asia');
  assert.doesNotMatch(text, /Valmis asia/);
  assert.match(text, /Olet jo menossa torstaina 1\.10\. lähelle paikkaa Motonet: Hammaslääkäri klo 10\.00 on samalla alueella \(Tammisto\)\. Voit hoitaa samalla: Käy Motonetissä\./);
});

test('Ehdota aikaa -> ehdotus perusteluineen -> Hyväksy asettaa päivän ja ajan (mikään ei muutu ennen hyväksyntää)', async t => {
  const view = mount(t);
  seedErrands();
  const before = JSON.stringify(getState().tasks);
  const propose = view.q('todayOpenEnded', '[data-td-action="errand-propose"]');
  assert.equal(accessibleName(propose), 'Ehdota aikaa: Käy Motonetissä');
  propose.click();
  await flush();
  const text = view.text('todayOpenEnded');
  assert.match(text, /Ehdotus: to 1\.10\. klo 11\.00–11\.20/);
  assert.match(text, /Olet jo menossa torstaina 1\.10\. lähelle paikkaa Motonet/);
  assert.match(text, /Ehtii ennen määräaikaa pe 2\.10\./);
  assert.equal(view.doc.activeElement, view.byId('tdErrandTitle'));
  assert.equal(JSON.stringify(getState().tasks), before, 'ehdotus ei muuta mitään');

  view.q('todayOpenEnded', '[data-td-action="errand-accept"][data-index="0"]').click();
  await flush();
  const task = getState().tasks.find(entry => entry.id === 't-motonet');
  assert.equal(task.date, THU);
  assert.equal(task.time, '11:00');
  assert.equal(task.endTime, '11:20');
  assert.doesNotMatch(view.text('todayOpenEnded'), /Käy Motonetissä/, 'päivätty asia ei ole enää avoin');
});

test('paikka tekstistä: taivutettu nimi tunnistetaan, kaksi mahdollista ei ole kumpikaan', () => {
  const places = [
    { id: 'm', name: 'Motonet' }, { id: 'h', name: 'Hammaslääkäri' }, { id: 'k1', name: 'Kauppa' },
    { id: 'k2', name: 'Kauppahalli' }, { id: 'pk', name: 'Parturi Kallio' }, { id: 'x', name: 'Ab' }
  ];
  assert.equal(placeIdForText('Käy Motonetissä tällä viikolla', places), 'm');
  assert.equal(placeIdForText('Soita hammaslääkärille', places), 'h');
  assert.equal(placeIdForText('Käy parturi Kalliolla', places), 'pk');
  assert.equal(placeIdForText('Ostokset kauppahallista', places), 'k2', 'pidempi nimi, lyhyt pääte');
  assert.equal(placeIdForText('Käy kaupassa', places), null, 'astevaihtelua ei arvata');
  const twins = [{ id: 'po1', name: 'Posti' }, { id: 'po2', name: 'posti' }];
  assert.equal(placeIdForText('Vie paketti postiin', twins), null, 'kaksi samannimistä paikkaa: ei arvata');
  assert.equal(placeIdForText('Vie paketti postiin', [twins[0]]), 'po1');
  assert.equal(placeIdForText('Motonettiläinen juttu kaikille', places), null, 'liian pitkä pääte ei ole taivutus');
  assert.equal(placeIdForText('Abc', places), null, 'liian lyhyt nimi ei osu');
  assert.equal(placeIdForText('', places), null);
  const aliases = [{ placeId: 'm', alias: 'autokauppa', confirmations: 2 }, { placeId: 'h', alias: 'lekuri', confirmations: 1 }];
  assert.equal(placeIdForText('Vie renkaat autokauppaan', places, aliases), 'm', 'vahvistettu opittu nimi');
  assert.equal(placeIdForText('Käy lekurilla', places, aliases), null, 'kerran vahvistettu ei riitä');
});

// ================================================================ huominen

test('huominen illalla: herätys, iltarauhoittuminen ja nukkumaanmeno samoista luvuista kuin uni-malli', t => {
  const view = mount(t, { time: '18:00' });
  const text = view.text('todayTomorrow');
  assert.match(text, /Huominen/);
  assert.match(text, /Herätys klo 7\.00/);
  assert.match(text, /Iltarauhoittuminen klo 22\.30/);
  assert.match(text, /Nukkumaanmeno klo 23\.00/);
  view.at('12:00');
  assert.equal(view.byId('todayTomorrow').innerHTML.trim(), '', 'päivällä tavallinen huominen ei tarvitse korttia');
});

test('huominen päivälläkin, kun aamu vaatii tavallista aiemman herätyksen', t => {
  const view = mount(t, { time: '12:00' });
  setSavedPlaces([DENTIST_PLACE]);
  setCalendarEvents([{ ...DENTIST_EVENT, id: 'e-early', date: TUE, startTime: '07:30', endTime: '08:00' }]);
  const plan = morningPlanOn(TUE, { state: getState(), now: new Date() });
  assert.ok(plan.earlierThanUsualMinutes > 0);
  const text = view.text('todayTomorrow');
  assert.match(text, /tavallista aiemmin/);
  assert.match(text, new RegExp(`Herätys klo ${plan.wakeTime.replace(/^0/, '').replace(':', '\\.')}`));
  assert.match(text, /Lähtö klo 6\.50 · Hammaslääkäri klo 7\.30/);
  assert.match(text, /Huominen aamu alkaa tavallista aiemmin/);
});

test('viikonloppu: rytmin siirtymä ja maanantaivalmius ehdotuksina, ilman kirjauksia ei korttia keskipäivällä', t => {
  const SAT = '2026-10-03';
  const view = mount(t, { date: SAT, time: '12:00' });
  assert.equal(view.byId('todayTomorrow').innerHTML.trim(), '', 'ei kirjauksia: ei ehdotettavaa');

  setSleepLogs(['2026-09-26', '2026-09-27', SAT].map((wakeDate, index) => ({
    id: `s${index}`, wakeDate, actualBedtime: '01:30', actualWake: '09:30'
  })));
  const text = view.text('todayTomorrow');
  assert.match(text, /Viikonlopun rytmi on siirtynyt asettamaasi väljyyttä enemmän 2 viikonloppuna/);
  assert.match(text, /Haluatko pitää sunnuntain herätyksen lähempänä arkirytmiä\?/);
  assert.match(text, /Ehdotus: sunnuntaina herätys 9\.00 ja maanantaina 7\.00\./);
  assert.match(text, /Nämä ovat ehdotuksia: mitään ei muuteta ilman sinua\./);
  assert.match(text, /tämä perustuu kirjaamiisi kellonaikoihin, ei unen mittaukseen/i);
  assert.equal(getState().notices.length, 0, 'kortti ei luo ilmoituksia');
});

// ================================================================ aamu

const ROUTINE = Object.freeze([
  { id: 's1', name: 'Suihku', minutes: 15, protection: 'mandatory' },
  { id: 's2', name: 'Aamiainen', minutes: 20, protection: 'important_flexible' },
  { id: 's3', name: 'Lehti', minutes: 25, protection: 'optional' }
]);

test('aamu ennen ensimmäistä lähtöä: vaiheet ajoitettuna, ei korttia lähdön jälkeen', t => {
  const view = mount(t, { time: '06:30' });
  seedDentist();
  setLifeSettings([{ id: 'ls1', morningRoutine: ROUTINE }]);
  const text = view.text('todayMorning');
  assert.match(text, /Aamu/);
  assert.match(text, /Hammaslääkäri/);
  assert.match(text, /herätys klo 7\.00/);
  const steps = view.qa('todayMorning', '.td-steps li').map(li => li.textContent.replace(/\s+/g, ' ').trim());
  assert.deepEqual(steps, [
    '7.05–7.20 Suihku Pakollinen',
    '7.20–7.40 Aamiainen Tärkeä, joustava',
    '7.40–8.05 Lehti Valinnainen'
  ], 'suojaus näkyy tekstinä, ei pelkkänä värinä');
  view.at('08:06');
  assert.equal(view.byId('todayMorning').innerHTML.trim(), '', 'lähtövalmistelu alkoi: aamukortti poistuu');
});

test('aamu ei enää mahdu: valinnat ovat painikkeita, mikään ei muutu itsestään eikä asetuksiin', async t => {
  const view = mount(t, { time: '07:30' });
  seedDentist();
  setLifeSettings([{ id: 'ls1', morningRoutine: ROUTINE }]);
  const settingsBefore = JSON.stringify(getState().lifeSettings);
  const text = view.text('todayMorning');
  assert.match(text, /Aamu ei enää mahdu: aikaa puuttuu 25 min/);
  const choices = view.qa('todayMorning', '[data-td-action="morning-choice"]');
  const labels = choices.map(button => button.textContent.trim());
  assert.ok(labels.includes('Jätä pois: Lehti (25 min)'), labels.join(' | '));
  assert.ok(labels.every(label => !/Herää/.test(label)), 'jo hereillä: aiempaa herätystä ei tarjota');
  assert.ok(labels.every(label => !/Suihku/.test(label)), 'pakollista ei tarjota pois jätettäväksi');
  assert.ok(choices.every(button => button.getAttribute('aria-pressed') === 'false'));

  choices.find(button => button.textContent.includes('Lehti')).click();
  await flush();
  const chosen = view.text('todayMorning');
  assert.match(chosen, /Valintasi tälle aamulle: Jätä pois: Lehti \(25 min\)\. Asetuksesi eivät muutu\./);
  const steps = view.qa('todayMorning', '.td-steps li').map(li => li.textContent.replace(/\s+/g, ' ').trim());
  assert.equal(steps.length, 2);
  assert.match(steps[0], /^7\.30–7\.45 Suihku/);
  assert.equal(JSON.stringify(getState().lifeSettings), settingsBefore, 'asetukset eivät muutu');

  view.q('todayMorning', '[data-td-action="morning-undo"]').click();
  await flush();
  assert.ok(view.q('todayMorning', '[data-td-action="morning-choice"]'), 'valinta peruttu: vaihtoehdot palaavat');
});

test('aamukortti puuttuu, kun aamussa ei ole menoa', t => {
  const view = mount(t, { time: '06:30' });
  setLifeSettings([{ id: 'ls1', morningRoutine: ROUTINE }]);
  assert.equal(view.byId('todayMorning').innerHTML.trim(), '');
});

// ================================================================ vaiheteksti ja rakenne

test('vaiheteksti: jokainen vaihe kerrotaan sanoin', () => {
  const base = {
    known: true, parts: { preparation: 10 }, prepareStart: { time: '08:05' }, leave: { time: '08:20' }
  };
  assert.equal(departurePhaseText({ ...base, phase: DEPARTURE_PHASE.NOT_YET }), 'Valmistaudu klo 8.05');
  assert.equal(departurePhaseText({ ...base, phase: DEPARTURE_PHASE.NOT_YET, parts: { preparation: 0 } }), 'Lähde klo 8.20');
  assert.equal(departurePhaseText({ ...base, phase: DEPARTURE_PHASE.LEAVE_IN_5, minutesUntilLeave: 1 }), 'Lähde minuutin päästä');
  assert.equal(departurePhaseText({ ...base, phase: DEPARTURE_PHASE.LATE, minutesLate: null }), 'Lähtöaika meni');
  assert.equal(departurePhaseText({ known: false, phase: DEPARTURE_PHASE.UNKNOWN_TRAVEL }), 'Matka-aika puuttuu');
  assert.equal(departurePhaseText(null), 'Matka-aika puuttuu');
});

test('rakenne: säiliöt index.html:ssä Tänään-näytöllä, SHELL ja tyylilohko', () => {
  const html = read('index.html');
  const start = html.indexOf('id="screen-today"');
  const end = html.indexOf('id="screen-direction"');
  for (const id of CARD_IDS) {
    const at = html.indexOf(`id="${id}"`);
    assert.ok(at > start && at < end, `${id} on Tänään-näytöllä`);
  }
  const sw = read('sw.js');
  for (const file of ['/src/app/views/todayDailyLife.js', '/src/domain/dayReplan.js', '/src/domain/errands.js',
    '/src/domain/navigationLink.js', '/src/domain/calendarBlocks.js']) {
    assert.ok(sw.includes(`'${file}'`), `${file} sovelluskuoressa`);
  }
  const css = read('src/styles.css');
  assert.ok(css.includes('/* ===== U3: Tänään-näkymän arjen kortit — alku ===== */'));
  assert.ok(css.includes('/* ===== U3 — loppu ===== */'));
  const view = read('src/app/views/todayDailyLife.js');
  assert.doesNotMatch(view, /https?:\/\//, 'ei kovakoodattuja osoitteita');
  assert.match(view, /singleFlight/, 'tallennukset suojattu tuplanapautukselta');
  assert.doesNotMatch(view, /addNoticeToState|noticesRepo/, 'kortit eivät luo ilmoituksia');
});
