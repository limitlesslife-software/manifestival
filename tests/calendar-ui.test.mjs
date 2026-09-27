// Kalenteri-välilehti (UI-CONTRACT "Kalenteri"): merkintä, tila, piirto
// päivä/viikko/kuukausi, menolomake, toistuvan menon "Ohita tämä kerta" ja
// näppäimistö.
//
// MITÄ TÄMÄ VARTIOI
//
// - Välilehtiä on yhä seitsemän; Viikko-välilehti on nyt Kalenteri, mutta
//   tunniste screen-week ja vanhan viikkonäkymän tunnisteet säilyvät.
// - Päivänäkymä on SAMA suunnitelma kuin Tänään (buildDayPlan menoineen ja
//   suojattuine lohkoineen): lähtö lasketaan taaksepäin saapumisesta, ja
//   matka, valmistautuminen ja uni näkyvät suojattuina, eivät vapaana aikana.
// - Tuntematon matka-aika on "Matka-aika puuttuu", ei keksitty lähtöaika.
// - Tyhjä minuuttikenttä on "ei asetettu" (null), ei nolla.
// - Käyttäjän teksti ei koskaan päädy sivulle merkintänä.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { read } from './helpers/sources.mjs';
import { parseRules, declarations, px } from './helpers/a11yCss.mjs';
import {
  createDocument, installDocument, press, type, choose, tabOrder, accessibleName, assertSameNode, isRendered
} from './helpers/a11yDom.mjs';
import { echoClient, flush } from './helpers/a11ySuunta.mjs';
import { freezeLocalDate } from './helpers/clock.mjs';
import { setUser, clearUser } from '../src/data/session.js';
import { setClient } from '../src/data/client.js';
import { clearAllCollections, calendarEventsRepo, savedPlacesRepo } from '../src/data/collectionsRepo.js';
import {
  getState, resetState, subscribe, setCalendarView, setCalendarDate, showCalendarDay, setWeekStart,
  setSavedPlaces, setCalendarEvents, setTasks, setDomainLoadStatus, setTasksSegment, CALENDAR_VIEWS
} from '../src/app/state.js';
import { clearLocalUserData } from '../src/app/actions.js';
import { resetDailyLifeActions } from '../src/app/dailyLifeActions.js';
import { calendarDayPlan, calendarInputs, needsDeparture } from '../src/app/calendarPlan.js';
import {
  renderCalendar, initCalendar, resetCalendarView, dayAgendaModel, dayTitle, relativeDayLabel,
  departureSummary, selectCalendarView, stepCalendar, KIND_LABELS, dayAgendaHtml
} from '../src/app/views/calendar.js';
import {
  validateEventForm, openEventForm, editingEvent, submitEventForm, skipEditedOccurrence, deleteEditedEvent, OTHER_PLACE,
  defaultEventDate
} from '../src/app/views/calendarForm.js';
import { renderWeek, initWeekNavigation, isoWeekNumber } from '../src/app/views/week.js';
import { renderTasks } from '../src/app/views/tasks.js';
import { setScreenRenderers, renderVisible, switchTab } from '../src/app/navigation.js';
import { handlers } from '../src/app/aiCommandHandlers.js';
import { INTENT } from '../src/ai/intentSchema.js';
import { closeConfirmDialogs } from '../src/ui/confirm.js';
import { clearToasts } from '../src/ui/toast.js';
import { buildDayPlan } from '../src/domain/scheduler.js';
import { normalizeTask } from '../src/domain/task.js';
import { parseISO } from '../src/lib/datetime.js';

const INDEX_HTML = read('index.html');
const HTML = INDEX_HTML.replace(/\r\n/g, '\n');
const CSS = read('src/styles.css').replace(/\r\n/g, '\n');
const USER = { id: 'ca1e0da1-1111-4111-8111-00000000ca1e', email: 'kalenteri@example.invalid' };

const MONDAY = '2026-09-28';
const TUESDAY = '2026-09-29';
const WEDNESDAY = '2026-09-30';
const THURSDAY = '2026-10-01';

const PLACE = Object.freeze({
  id: 'p-hammas', name: 'Hammaslääkäri Keskusta', travelMode: 'driving',
  usualTravelMinutes: 25, preparationMinutes: 15, arrivalBufferMinutes: 10, overheadMinutes: 0
});

const EVENTS = Object.freeze([
  { id: 'e-hammas', title: 'Hammaslääkäri', date: TUESDAY, startTime: '16:00', durationMinutes: 45, placeId: 'p-hammas' },
  { id: 'e-nimi', title: 'Nimipäivä', date: TUESDAY },
  { id: 'e-palaveri', title: 'Palaveri', date: TUESDAY, startTime: '10:00', endTime: '11:00' },
  { id: 'e-parturi', title: 'Parturi', date: TUESDAY, startTime: '13:00', locationText: 'Parturi Kallio' },
  { id: 'e-jooga', title: 'Jooga', date: TUESDAY, startTime: '18:30', durationMinutes: 60, recurrenceWeekdays: [2, 4] }
]);

const TASKS = Object.freeze([
  { id: 't-raportti', title: 'Raportti', date: TUESDAY, time: '12:00', durationMinutes: 30 },
  { id: 't-soita', title: 'Soita äidille', date: TUESDAY }
]);

/**
 * Tila kuin latauksen jälkeen: rivit sekä tilassa että (muisti)varastossa,
 * jotta muokkaus ja ohitus päivittävät olemassa olevan rivin kuten kannassa.
 * Muistivaraston lisäys on synkroninen, joten odotusta ei tarvita.
 */
function seed({ events = EVENTS, places = [PLACE], tasks = TASKS } = {}) {
  setSavedPlaces(places);
  setCalendarEvents(events);
  setTasks(tasks.map(task => normalizeTask(task)));
  for (const place of getState().savedPlaces) savedPlacesRepo.insert(place);
  for (const event of getState().calendarEvents) calendarEventsRepo.insert(event);
}

// ------------------------------------------------------------ asennus

function showScreen(doc, id) {
  for (const screen of doc.querySelectorAll('.screen')) {
    const on = screen.id === id;
    screen.classList.toggle('active', on);
    screen.toggleAttribute('inert', !on);
    screen.setAttribute('aria-hidden', on ? 'false' : 'true');
  }
}

let mounted = null;

/** Kalenteri oikeassa (jäsennetyssä) index.html-DOMissa, kuten mountSuunta. */
function mountCalendar({ before = () => {} } = {}) {
  clearUser();
  clearLocalUserData();
  resetState();
  clearAllCollections();
  resetDailyLifeActions();
  const doc = createDocument(INDEX_HTML);
  const uninstall = installDocument(doc);
  setUser(USER);
  setClient(echoClient());
  doc.getElementById('app').classList.remove('app-hidden');
  showScreen(doc, 'screen-week');
  before();
  initWeekNavigation();
  initCalendar();
  const render = () => {
    renderWeek();
    renderCalendar();
  };
  const unsubscribe = subscribe(render);
  render();
  mounted = {
    doc,
    render,
    byId: id => doc.getElementById(id),
    async unmount() {
      unsubscribe();
      closeConfirmDialogs();
      clearToasts();
      await flush(5);
      resetCalendarView();
      uninstall();
    }
  };
  return mounted;
}

afterEach(async () => {
  if (mounted) {
    const current = mounted;
    mounted = null;
    await current.unmount();
  }
  clearUser();
});

beforeEach(() => {
  resetState();
  clearAllCollections();
});

const text = node => (node ? node.textContent.replace(/\s+/g, ' ').trim() : '');
const rowTexts = doc => doc.querySelectorAll('#calDayAgenda .cal-row').map(text);

// ================================================================ MERKINTÄ

test('Kalenteri on yhä yksi seitsemästä välilehdestä; tunniste screen-week säilyy', () => {
  const tabs = [...HTML.matchAll(/<button class="tab-btn[^"]*"[^>]*data-screen="([^"]+)"[^>]*>[\s\S]*?<\/svg>([^<]+)<\/button>/g)];
  assert.equal(tabs.length, 7, 'välilehtiä on seitsemän');
  const calendar = tabs.find(match => match[1] === 'screen-week');
  assert.ok(calendar, 'screen-week-välilehti');
  assert.equal(calendar[2].trim(), 'Kalenteri', 'näkyvä nimi on Kalenteri (ennen Viikko)');
  assert.equal(tabs.some(match => match[2].trim() === 'Viikko'), false, 'Viikko ei ole enää välilehti');
  assert.match(HTML, /<section class="screen" id="screen-week" role="tabpanel" aria-label="Kalenteri" aria-hidden="true" inert>/);
  assert.match(read('src/app/navigation.js'), /'screen-week'/);
});

function screenMarkup() {
  const start = HTML.indexOf('id="screen-week"');
  return HTML.slice(start, HTML.indexOf('</section>', start));
}

test('osiot Päivä / Viikko / Kuukausi ovat tab-lista tunnisteineen; vanhan viikkonäkymän tunnisteet säilyvät', () => {
  const screen = screenMarkup();
  const tablist = /<div class="segment segment-3 cal-segments" role="tablist" aria-label="([^"]+)">([\s\S]*?)<\/div>/.exec(screen);
  assert.ok(tablist, 'osiot ovat tablist');
  const tabs = [...tablist[2].matchAll(/<button class="segment-btn[^"]*" id="(segmentCal\w+)" type="button" role="tab" aria-selected="(true|false)" aria-controls="(\w+)">([^<]+)<\/button>/g)];
  assert.deepEqual(tabs.map(m => [m[1], m[4], m[3]]), [
    ['segmentCalDay', 'Päivä', 'calDaySection'],
    ['segmentCalWeek', 'Viikko', 'calWeekSection'],
    ['segmentCalMonth', 'Kuukausi', 'calMonthSection']
  ]);
  assert.deepEqual(CALENDAR_VIEWS.map(v => v.label), ['Päivä', 'Viikko', 'Kuukausi']);
  // Ensimmäinen täsmällinen class="segment" on yhä Talouden kaksiosainen valitsin
  // (accessibility.test.mjs); kalenterin segmentti ei saa kaapata sitä.
  assert.equal(screen.includes('class="segment"'), false);
  for (const id of ['weekPrev', 'weekNext', 'weekRangeLabel', 'weekStripContainer', 'weekSummary', 'weekDeadlines',
    'weekGoals', 'weekListContainer', 'weekReview']) {
    assert.ok(screen.includes(`id="${id}"`), `vanha tunniste ${id} puuttuu`);
  }
  const week = screen.slice(screen.indexOf('id="calWeekSection"'), screen.indexOf('id="calMonthSection"'));
  for (const id of ['weekStripContainer', 'weekListContainer', 'calWeekEvents']) assert.ok(week.includes(`id="${id}"`), id);
  // Otsikon nuolet ja paluulinkki.
  assert.match(screen, /id="calPrev" type="button" aria-label="Edellinen päivä"/);
  assert.match(screen, /id="calNext" type="button" aria-label="Seuraava päivä"/);
  assert.match(screen, /<button class="jump-link" id="calToday" type="button">Tänään<\/button>/);
  assert.match(screen, /id="calNewEvent" type="button"><svg aria-hidden="true"><use href="#i-plus"\/><\/svg>Uusi meno<\/button>/);
});

test('menolomake: jokaisella kentällä on nimilappu, numerokentillä rajat ja virheillä role=alert', () => {
  const screen = screenMarkup();
  const form = screen.slice(screen.indexOf('id="calEventForm"'), screen.indexOf('id="calDaySection"'));
  assert.match(form, /role="group" aria-labelledby="calFormTitle"/);
  const labels = {
    ceTitle: 'Otsikko (pakollinen)', ceDate: 'Päivä (pakollinen)', ceStart: 'Alkaa', ceEnd: 'Päättyy',
    ceDuration: 'tai kesto (min)', cePlace: 'Paikka', ceLocation: 'Muu paikka', ceMode: 'Kulkutapa',
    ceTravel: 'Oma arvio matka-ajasta (min)', cePrep: 'Valmistautuminen (min)', ceEarly: 'Saavu etuajassa (min)',
    ceOverhead: 'Pysäköinti ja kävely (min)', ceUntil: 'Toistuu asti (valinnainen)', ceCategory: 'Luokka',
    ceNotes: 'Muistiinpano (valinnainen)'
  };
  for (const [id, label] of Object.entries(labels)) {
    assert.ok(form.includes(`<label class="field-label" for="${id}">${label}</label>`), `${id}: ${label}`);
  }
  assert.match(form, /<label class="checkbox-row" for="ceAllDay">\s*<input type="checkbox" id="ceAllDay"> Koko päivä/);
  const numbers = [...form.matchAll(/<input type="number" id="(\w+)" min="(\d+)" max="(\d+)"/g)].map(m => [m[1], m[2], m[3]]);
  assert.deepEqual(numbers, [
    ['ceDuration', '1', '1440'], ['ceTravel', '1', '1440'], ['cePrep', '0', '480'], ['ceEarly', '0', '240'], ['ceOverhead', '0', '240']
  ]);
  for (const id of ['ceTitle', 'ceDate', 'ceStart', 'ceEnd', 'ceDuration', 'ceLocation', 'ceTravel', 'cePrep', 'ceEarly', 'ceOverhead', 'ceUntil', 'ceNotes']) {
    assert.match(form, new RegExp(`id="${id}Error" role="alert"`), `${id}Error`);
  }
  // Toisto: seitsemän aitoa valintaruutua nimettyinä ma–su.
  const days = [...form.matchAll(/<input type="checkbox" id="ceRepeat(\d)" value="\d" data-weekday aria-label="(\w+)">/g)];
  assert.deepEqual(days.map(m => m[2]), ['maanantai', 'tiistai', 'keskiviikko', 'torstai', 'perjantai', 'lauantai', 'sunnuntai']);
  assert.match(form, /<fieldset class="cal-repeat">\s*<legend class="field-label">Toistuu viikoittain<\/legend>/);
  for (const [id, label] of [['ceDelete', 'Poista'], ['ceSkip', 'Ohita tämä kerta'], ['ceCancel', 'Peruuta'], ['ceSave', 'Tallenna']]) {
    assert.match(form, new RegExp(`id="${id}" type="button"[^>]*>${label}</button>`), label);
  }
});

test('tyylit: kosketusalueet vähintään 44 px, näkyvä fokus, kapea näyttö ja vain tekstisävyt tekstinä', () => {
  const start = CSS.indexOf('/* ===== U1: Kalenteri — alku ===== */');
  const end = CSS.indexOf('/* ===== U1 — loppu ===== */');
  assert.ok(start > -1 && end > start, 'U1-lohko');
  const block = CSS.slice(start, end);
  const rules = parseRules(block);
  for (const selector of ['.cal-row-main', '.cal-inline-btn', '.cal-day', '.cal-repeat .weekday-chip']) {
    assert.ok((px(declarations(rules, selector)['min-height']) ?? 0) >= 44, `${selector} min-height`);
  }
  for (const selector of ['button.cal-row-main:focus-visible', '.cal-inline-btn:focus-visible', '.cal-day:focus-visible']) {
    assert.match(declarations(rules, selector).outline || '', /solid var\(--gold\)/, selector);
  }
  assert.equal(/nowrap/.test(block), false, 'ei nowrap-sääntöjä');
  for (const match of block.matchAll(/(?:^|[;{\s])width:\s*(\d+)px/g)) assert.ok(Number(match[1]) <= 328, `leveys ${match[1]}px`);
  // Vain tekstin väri: reunaviiva (border-left-color) saa käyttää logon sävyä.
  assert.equal(/(?:^|[;{\s])color:\s*var\(--(sage|gold|clay|path)\)/.test(block), false, 'logon sävy tekstinä');
  assert.match(block, /@media \(max-width:380px\)/);
});

// ================================================================ TILA

test('tila: oletus päivä ja tämä päivä; asettajat tarkistavat; resetState palauttaa', (t) => {
  freezeLocalDate(t, TUESDAY);
  resetState();
  assert.equal(getState().calendarView, 'day');
  assert.equal(getState().calendarDate, TUESDAY);

  let notifications = 0;
  const stop = subscribe(() => { notifications += 1; });
  setCalendarView('month');
  assert.equal(getState().calendarView, 'month');
  setCalendarView('vuosi');
  assert.equal(getState().calendarView, 'day', 'tuntematon näkymä -> päivä');
  const before = notifications;
  setCalendarView('day');
  assert.equal(notifications, before, 'sama arvo ei ilmoita');

  for (const bad of ['2026-02-30', '', null, undefined, '29.9.2026', 20260929]) {
    setCalendarDate(bad);
    assert.equal(getState().calendarDate, TUESDAY, `kelvoton ${String(bad)}`);
  }
  setCalendarDate('2026-12-31');
  assert.equal(getState().calendarDate, '2026-12-31');

  setCalendarView('month');
  const beforeShow = notifications;
  showCalendarDay(WEDNESDAY);
  assert.equal(notifications - beforeShow, 1, 'päivä ja näkymä yhdellä muutoksella');
  assert.deepEqual([getState().calendarView, getState().calendarDate], ['day', WEDNESDAY]);
  showCalendarDay('ei-päivä');
  assert.equal(getState().calendarDate, WEDNESDAY);
  stop();

  resetState();
  assert.deepEqual([getState().calendarView, getState().calendarDate], ['day', TUESDAY], 'uloskirjautuminen nollaa');
});

// ================================================================ LASKENTA: KALENTERI = TÄNÄÄN

function stateWith({ events = EVENTS, places = [PLACE], tasks = TASKS } = {}) {
  resetState();
  seed({ events, places, tasks });
  return getState();
}

test('päivän suunnitelma: sama buildDayPlan kuin Tänään, lähtö taaksepäin saapumisesta ja suojatut lohkot', () => {
  const state = stateWith();
  const { plan, inputs } = calendarDayPlan(state, TUESDAY, { todayIso: TUESDAY });

  // Kalenteri ja Tänään: sama moottori samoilla syötteillä -> sama tulos.
  const direct = buildDayPlan({
    tasks: state.tasks, profile: state.profile, dateIso: TUESDAY, routines: state.routines,
    exceptions: state.routineExceptions, todayIso: TUESDAY, events: inputs.occurrences, blocks: inputs.blocks
  });
  assert.deepEqual(plan.freeSlots, direct.freeSlots);
  assert.deepEqual(plan.timeline.map(item => item.id), direct.timeline.map(item => item.id));

  const departure = inputs.departures.get(`event:e-hammas:${TUESDAY}`);
  assert.equal(departure.known, true);
  assert.deepEqual([departure.prepareStart.time, departure.leave.time, departure.arrivalTarget.time], ['15:10', '15:25', '15:50']);
  assert.equal(departure.source, 'user_supplied');

  const blocks = plan.blocks.map(block => `${block.kind} ${block.time}-${block.endTime ?? '24:00'}`);
  assert.deepEqual(blocks, [
    'sleep 00:00-07:00',
    'preparation 15:10-15:25',
    'travel 15:25-15:50',
    'arrival_buffer 15:50-16:00',
    'wind_down 22:30-23:00',
    'sleep 23:00-00:00'
  ]);
  // Suojattu väljyys ei ole vapaata aikaa.
  for (const slot of plan.freeSlots) {
    assert.ok(slot.end <= 15 * 60 + 10 || slot.start >= 16 * 60 + 45, `vapaa väli ${slot.startTime}-${slot.endTime} osuu lähtöön`);
  }
  // Tuntematon matka-aika: ei lähtöä, ei lohkoja, ei keksittyä lukua.
  const unknown = inputs.departures.get(`event:e-parturi:${TUESDAY}`);
  assert.equal(unknown.known, false);
  assert.equal(unknown.leave, null);
  assert.equal(plan.blocks.some(block => block.eventId === 'e-parturi'), false);
  // Meno ilman paikkaa ja matkaa ei tarvitse lähtöä.
  assert.equal(inputs.departures.has(`event:e-palaveri:${TUESDAY}`), false);
  assert.equal(needsDeparture({ time: '10:00', hasPlace: false, travelMinutes: null }), false);
  assert.equal(needsDeparture({ time: '10:00', hasPlace: false, travelMinutes: 15 }), true);
  assert.equal(needsDeparture({ time: null, allDay: true, hasPlace: true }), false);
});

test('huomisen aamun meno aikaistaa herätystä -> nukkumaanmeno siirtyy aiemmaksi (unta ei lyhennetä)', () => {
  const early = { id: 'e-juna', title: 'Juna', date: WEDNESDAY, startTime: '07:30', placeId: 'p-asema' };
  const station = { id: 'p-asema', name: 'Asema', usualTravelMinutes: 30, preparationMinutes: 10, arrivalBufferMinutes: 10, overheadMinutes: 0 };
  const state = stateWith({ events: [early], places: [station], tasks: [] });
  const { plan, inputs } = calendarDayPlan(state, TUESDAY, { todayIso: TUESDAY });
  // Saapuminen 7.20, lähtö 6.50, valmistautuminen 6.40, aamutoimet (60 min) 5.40.
  const tonight = inputs.sleepSchedules.find(schedule => schedule.date === TUESDAY);
  assert.deepEqual([tonight.wakeTime, tonight.bedtime], ['05:40', '21:40']);
  const rest = plan.blocks.filter(block => block.kind === 'wind_down' || (block.kind === 'sleep' && block.startMinute > 0))
    .map(block => `${block.kind} ${block.time}`);
  assert.deepEqual(rest, ['wind_down 21:10', 'sleep 21:40']);
  // Ilman menoa: tavallinen rytmi.
  const calm = calendarDayPlan(stateWith({ events: [], places: [], tasks: [] }), TUESDAY, { todayIso: TUESDAY });
  assert.deepEqual(calm.inputs.sleepSchedules.map(s => `${s.date} ${s.bedtime}-${s.wakeTime}`),
    [`${MONDAY} 23:00-07:00`, `${TUESDAY} 23:00-07:00`]);
});

test('viikonloppuna herätys saa siirtyä asetetun väljyyden verran, ja laskenta on deterministinen', () => {
  const state = stateWith({ events: [], places: [], tasks: [] });
  const saturday = '2026-10-03';
  const first = calendarInputs(state, { from: saturday, to: saturday, todayIso: TUESDAY });
  const again = calendarInputs(state, { from: saturday, to: saturday, todayIso: TUESDAY });
  assert.deepEqual(first.sleepSchedules, again.sleepSchedules);
  const morning = first.sleepSchedules.find(schedule => schedule.wakeDate === saturday);
  assert.equal(morning.wakeTime, '08:00', 'oletusväljyys 60 min');
  assert.ok(Object.isFrozen(first));
  // Kelvoton väli ei kaada mitään.
  assert.deepEqual(calendarInputs(state, { from: 'x', to: saturday }).occurrences, []);
  assert.deepEqual(calendarInputs(state, { from: saturday, to: '2026-10-01' }).blocks, []);
});

test('päivän malli: koko päivän menot ensin, rivit aikajärjestyksessä, lohkot suojattuina, tuntematon ei ole nolla', () => {
  const state = stateWith();
  const { plan, inputs } = calendarDayPlan(state, TUESDAY, { todayIso: TUESDAY });
  const model = dayAgendaModel(plan, { departures: inputs.departures, placesById: new Map([[PLACE.id, PLACE]]) });

  assert.deepEqual(model.allDay.map(row => [row.title, row.time]), [['Nimipäivä', 'Koko päivä']]);
  assert.deepEqual(model.timed.map(row => `${row.time} ${row.kindLabel}: ${row.title}`), [
    '0.00–7.00 Uni: Suojattu uni',
    '10.00–11.00 Meno: Palaveri',
    '12.00–12.30 Tehtävä: Raportti',
    '13.00 Meno: Parturi',
    '15.10–15.25 Valmistautuminen: Hammaslääkäri',
    '15.25–15.50 Matka: Hammaslääkäri',
    '15.50–16.00 Etuaika: Hammaslääkäri',
    '16.00–16.45 Meno: Hammaslääkäri',
    '18.30–19.30 Meno: Jooga',
    '22.30–23.00 Iltarauhoittuminen: Rauhoittuminen ennen unta',
    '23.00–24.00 Uni: Suojattu uni'
  ]);
  assert.deepEqual(model.untimed.map(row => row.title), ['Soita äidille']);
  assert.ok(model.timed.filter(row => row.kind === 'block').every(row => row.protected));
  assert.equal(model.timed.filter(row => row.kind !== 'block').some(row => row.protected), false);

  const dentist = model.timed.find(row => row.title === 'Hammaslääkäri' && row.kind === 'event');
  assert.deepEqual(dentist.departure, {
    known: true,
    text: 'Lähde 15.25 · valmistaudu 15.10 · perillä 15.50',
    detail: 'Matka 25 min (oma arvio) · etuaika 10 min'
  });
  assert.equal(dentist.place, 'Hammaslääkäri Keskusta');
  const barber = model.timed.find(row => row.title === 'Parturi');
  assert.deepEqual(barber.departure, { known: false, text: 'Matka-aika puuttuu', detail: '' });
  assert.equal(barber.place, 'Parturi Kallio');
  assert.equal(model.timed.find(row => row.title === 'Palaveri').departure, null, 'ei paikkaa -> ei lähtöä');
  assert.equal(model.timed.find(row => row.title === 'Jooga').recurring, true);

  // Kaikki lajit ovat tekstiä sopimuksen mukaan.
  assert.deepEqual(Object.values(KIND_LABELS), ['Meno', 'Tehtävä', 'Rutiini', 'Valmistautuminen', 'Matka',
    'Pysäköinti ja kävely', 'Etuaika', 'Iltarauhoittuminen', 'Uni']);
  // Syötettä ei muuteta, ja tulos on jäädytetty.
  assert.ok(Object.isFrozen(model.timed) && Object.isFrozen(model.timed[0]));
});

test('Avaa reitti: sallittu Google Maps -linkki paikasta tai paikkatekstistä, ei linkkiä ilman kohdetta', () => {
  const HOSTILE = { id: 'e-vihamielinen', title: 'Outo', date: TUESDAY, startTime: '20:00', locationText: 'javascript:alert(1)' };
  const state = stateWith({ events: [...EVENTS, HOSTILE] });
  const { plan, inputs } = calendarDayPlan(state, TUESDAY, { todayIso: TUESDAY });
  const model = dayAgendaModel(plan, { departures: inputs.departures, placesById: new Map([[PLACE.id, PLACE]]) });
  const row = title => model.timed.find(item => item.title === title && item.kind === 'event');

  // Tallennettu paikka: kohde on paikan nimi (osoitetta ei ole), tapa paikalta.
  assert.deepEqual(row('Hammaslääkäri').route, {
    url: 'https://www.google.com/maps/dir/?api=1&destination=Hammasl%C3%A4%C3%A4k%C3%A4ri%20Keskusta&travelmode=driving',
    destination: 'Hammaslääkäri Keskusta', mode: 'driving', label: 'Hammaslääkäri Keskusta'
  });
  // Pelkkä paikkateksti riittää.
  assert.equal(row('Parturi').route.destination, 'Parturi Kallio');
  // Ei paikkaa -> ei linkkiä. Skeema siivotaan pois, eikä sitä koskaan linkitetä.
  assert.equal(row('Palaveri').route, null);
  const hostile = row('Outo').route;
  assert.ok(hostile === null || !/javascript/i.test(hostile.url + hostile.destination));

  const html = dayAgendaHtml(model);
  assert.match(html, /<a class="cal-inline-btn" href="https:\/\/www\.google\.com\/maps\/dir\/\?api=1&amp;destination=Hammasl%C3%A4%C3%A4k%C3%A4ri%20Keskusta&amp;travelmode=driving" target="_blank" rel="noopener noreferrer"/);
  assert.match(html, /aria-label="Avaa reitti: Parturi Kallio \(Google Maps\)">Avaa reitti<\/a>/);
  assert.equal(/href="javascript/i.test(html), false);
  // Suojatut lohkot ja tehtävät eivät saa reittiä.
  assert.ok(model.timed.filter(item => item.kind !== 'event').every(item => item.route === null));
});

test('lähdön tiivistelmä: edellisen päivän lähtö päivämäärällä, opittu ja pysäköinti tekstinä', () => {
  const plan = {
    applicable: true, known: true, source: 'learned',
    leave: { date: MONDAY, time: '23:40' }, prepareStart: { date: MONDAY, time: '23:20' },
    arrivalTarget: { date: TUESDAY, time: '00:20' },
    parts: { travel: 35, overhead: 5, early: 10, preparation: 20 }
  };
  assert.deepEqual(departureSummary(plan, TUESDAY), {
    known: true,
    text: 'Lähde ma 28.9. 23.40 · valmistaudu ma 28.9. 23.20 · perillä 0.20',
    detail: 'Matka 35 min (opittu omista matkoista) · pysäköinti ja kävely 5 min · etuaika 10 min'
  });
  assert.equal(departureSummary({ ...plan, parts: { ...plan.parts, preparation: 0 } }, TUESDAY).text,
    'Lähde ma 28.9. 23.40 · perillä 0.20', 'ei valmistautumista -> ei valmistaudu-osaa');
  assert.equal(departureSummary({ applicable: false }, TUESDAY), null);
  assert.equal(departureSummary(null, TUESDAY), null);
});

test('otsikot: päivä, suhteellinen päivä ja vuosi vain muulle vuodelle', () => {
  assert.equal(dayTitle(TUESDAY, TUESDAY), 'Tiistai 29.9.');
  assert.equal(dayTitle('2027-01-01', TUESDAY), 'Perjantai 1.1.2027');
  assert.equal(dayTitle('ei', TUESDAY), '');
  assert.equal(relativeDayLabel(TUESDAY, TUESDAY), 'Tänään');
  assert.equal(relativeDayLabel(WEDNESDAY, TUESDAY), 'Huomenna');
  assert.equal(relativeDayLabel(MONDAY, TUESDAY), 'Eilen');
  assert.equal(relativeDayLabel(THURSDAY, TUESDAY), '');
  assert.equal(isoWeekNumber(parseISO(MONDAY)), 40);
  assert.equal(isoWeekNumber(parseISO('2026-12-28')), 53);
  assert.equal(isoWeekNumber(parseISO('2027-01-04')), 1);
});

// ================================================================ PIIRTO: TYNKÄ-DOM

const HTML_IDS = new Set([...INDEX_HTML.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));

function stubElement() {
  const attributes = {};
  return {
    innerHTML: '', textContent: '', value: '', hidden: false, disabled: false, checked: false,
    style: {}, dataset: {}, options: [], children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute: (k, v) => { attributes[k] = String(v); },
    getAttribute: k => attributes[k] ?? null,
    removeAttribute: k => { delete attributes[k]; },
    toggleAttribute() {}, addEventListener() {}, removeEventListener() {},
    querySelector: () => null, querySelectorAll: () => [], appendChild() {}, insertAdjacentHTML() {},
    remove() {}, closest: () => null, focus() {}
  };
}

function withStubDocument(run) {
  const elements = new Map();
  globalThis.document = {
    activeElement: null,
    getElementById(id) {
      if (!HTML_IDS.has(id)) return null;
      if (!elements.has(id)) elements.set(id, stubElement());
      return elements.get(id);
    },
    createElement: () => stubElement(),
    querySelector: () => null,
    querySelectorAll: () => [],
    body: { appendChild() {} }
  };
  try {
    return run(id => elements.get(id) || globalThis.document.getElementById(id));
  } finally {
    delete globalThis.document;
  }
}

test('tynkä-DOM: päivä, viikko ja kuukausi piirtyvät kaatumatta ja tuottavat odotetun merkinnän', (t) => {
  freezeLocalDate(t, TUESDAY);
  resetState();
  seed();
  withStubDocument(node => {
    assert.doesNotThrow(() => renderCalendar());
    const day = node('calDayAgenda').innerHTML;
    assert.match(day, /Koko päivä/);
    assert.match(day, /Lähde 15\.25 · valmistaudu 15\.10 · perillä 15\.50/);
    assert.match(day, /Matka-aika puuttuu — <\/span><button type="button" class="cal-inline-btn" data-cal-travel="e-parturi"/);
    assert.match(day, /<span class="cal-protected">suojattu<\/span>/);
    assert.equal(node('calTitle').textContent, 'Tiistai 29.9.');
    assert.equal(node('calEyebrow').textContent, 'Tänään');
    assert.match(node('calNotice').innerHTML, /Menot säilyvät toistaiseksi vain tämän istunnon ajan/);

    setCalendarView('month');
    assert.doesNotThrow(() => renderCalendar());
    const month = node('calMonthGrid').innerHTML;
    assert.equal((month.match(/data-cal-day="/g) || []).length, 35, 'syyskuu 2026: viisi viikkoriviä');
    assert.match(month, /data-cal-day="2026-09-29" tabindex="0" aria-label="tiistai 29\. syyskuuta 2026: 5 menoa, 2 tehtävää, tänään, valittu" aria-current="date"/);
    assert.equal(node('calTitle').textContent, 'Syyskuu 2026');
    assert.equal(node('calPrev').getAttribute('aria-label'), 'Edellinen kuukausi');

    setWeekStart(parseISO(MONDAY));
    setCalendarView('week');
    assert.doesNotThrow(() => { renderWeek(); renderCalendar(); });
    const week = node('calWeekEvents').innerHTML;
    assert.match(week, /Menot <span class="count-badge">6<\/span>/, 'viisi menoa tiistaina ja joogan torstai');
    assert.match(week, /To 1\.10\./);
    assert.equal(node('weekRangeLabel').textContent, 'Viikko 40 · 28.9.–4.10.');
    setWeekStart(parseISO('2026-12-28'));
    renderWeek();
    assert.equal(node('weekRangeLabel').textContent, 'Viikko 53 · 28.12.2026–3.1.2027', 'vuodenvaihde');
  });
});

// ================================================================ PIIRTO: JÄSENNETTY DOM

test('päivänäkymä: rivit, lähtö, tuntematon matka-aika ja suojatut lohkot oikeassa DOMissa', (t) => {
  freezeLocalDate(t, TUESDAY, '09:00');
  const { doc, byId } = mountCalendar({ before: () => seed() });
  assert.equal(isRendered(byId('calDaySection')), true);
  assert.equal(isRendered(byId('calWeekSection')), false);
  assert.equal(isRendered(byId('calMonthSection')), false);
  assert.equal(byId('segmentCalDay').getAttribute('aria-selected'), 'true');

  const rows = rowTexts(doc);
  assert.equal(rows[0], 'Koko päivä Nimipäivä Meno', 'koko päivän meno ensin');
  const dentist = doc.querySelector('[data-cal-open="e-hammas"]').closest('li');
  assert.match(text(dentist), /16\.00–16\.45 Hammaslääkäri Meno · Hammaslääkäri Keskusta ?Lähde 15\.25 · valmistaudu 15\.10 · perillä 15\.50/);
  const travel = doc.querySelector('.cal-block-travel');
  assert.match(text(travel), /15\.25–15\.50 Hammaslääkäri Matka · suojattu/);
  assert.ok(travel.classList.contains('is-protected'));
  const unknown = doc.querySelector('[data-cal-travel="e-parturi"]');
  assert.equal(accessibleName(unknown), 'Lisää oma arvio matka-ajasta: Parturi');
  assert.match(text(unknown.closest('p')), /^Matka-aika puuttuu — lisää oma arvio$/);
  // Tehtävä avautuu omaan lomakkeeseensa, rutiini ja lohko eivät ole painikkeita.
  assert.ok(doc.querySelector('button[data-cal-task="t-raportti"]'));
  assert.equal(doc.querySelectorAll('.cal-row.is-protected button').length, 0);
});

test('KRIITTINEN: käyttäjän teksti ei päädy sivulle merkintänä', (t) => {
  freezeLocalDate(t, TUESDAY);
  const evil = '<img src=x onerror="alert(1)">';
  const { doc } = mountCalendar({
    before: () => seed({
      events: [{ id: 'e-x', title: evil, date: TUESDAY, startTime: '09:00', locationText: evil }],
      places: [], tasks: []
    })
  });
  assert.equal(doc.querySelectorAll('#screen-week img').length, 0);
  assert.ok(rowTexts(doc).some(row => row.includes(evil)), 'teksti näkyy tekstinä');
  selectCalendarView('month');
  selectCalendarView('week');
  assert.equal(doc.querySelectorAll('#screen-week img').length, 0);
});

test('osiot: viikko näyttää kalenterin päivän viikon, ja paluu pitää päivän viikolla', (t) => {
  freezeLocalDate(t, TUESDAY);
  const { byId } = mountCalendar({ before: () => seed() });
  setCalendarDate('2026-10-14');
  byId('segmentCalWeek').click();
  assert.equal(getState().calendarView, 'week');
  assert.equal(text(byId('weekRangeLabel')), 'Viikko 42 · 12.10.–18.10.');
  assert.equal(isRendered(byId('calWeekNav')), true);
  assert.equal(isRendered(byId('calNav')), false);
  assert.equal(byId('segmentCalWeek').getAttribute('aria-selected'), 'true');
  assert.equal(byId('segmentCalDay').getAttribute('aria-selected'), 'false');

  byId('weekNext').click();
  byId('segmentCalDay').click();
  assert.equal(getState().calendarDate, '2026-10-19', 'päivä ei ollut katsotulla viikolla -> maanantai');

  byId('segmentCalWeek').click();
  byId('calWeekToday').click();
  byId('segmentCalMonth').click();
  assert.equal(getState().calendarDate, TUESDAY, 'tällä viikolla -> tämä päivä');
  assert.equal(text(byId('calTitle')), 'Syyskuu 2026');
});

test('puhe- ja AI-komento "näytä viikko" avaa Kalenterin Viikko-osion, ei oletuksena olevaa Päivää', async () => {
  resetState();
  assert.equal(getState().calendarView, 'day');
  const result = await handlers[INTENT.SHOW_WEEK_PLAN]({ payload: { date: '2026-10-02' } });
  assert.equal(result.ok, true);
  assert.deepEqual([getState().screen, getState().calendarView], ['screen-week', 'week']);
  assert.equal(getState().weekStart.getDate(), 28, 'perjantain viikko alkaa maanantaista 28.9.');
});

test('viikon päivän napautus avaa saman päivän Päivä-osion ja fokus siirtyy otsikkoon', (t) => {
  freezeLocalDate(t, TUESDAY);
  const { doc, byId } = mountCalendar({ before: () => seed() });
  byId('segmentCalWeek').click();
  const thursday = doc.querySelector(`#weekStripContainer [data-date="${THURSDAY}"]`);
  thursday.click();
  assert.deepEqual([getState().calendarView, getState().calendarDate], ['day', THURSDAY]);
  assertSameNode(doc.activeElement, byId('calTitle'), 'fokus otsikkoon');
  assert.equal(text(byId('calTitle')), 'Torstai 1.10.');
  assert.ok(rowTexts(doc).some(row => row.includes('Jooga')), 'toistuva jooga torstaina');
});

test('kuukausi: ruudukko, tänään tekstinä, ulkopuoliset päivät, napautus avaa päivän', (t) => {
  freezeLocalDate(t, TUESDAY);
  const { doc, byId } = mountCalendar({ before: () => seed() });
  byId('segmentCalMonth').click();
  const cells = doc.querySelectorAll('#calMonthGrid [data-cal-day]');
  assert.equal(cells.length, 35);
  const today = doc.querySelector('[data-cal-day="2026-09-29"]');
  assert.equal(today.getAttribute('aria-current'), 'date');
  assert.match(accessibleName(today), /tiistai 29\. syyskuuta 2026: 5 menoa, 2 tehtävää, tänään/);
  const outside = doc.querySelector('[data-cal-day="2026-08-31"]');
  assert.ok(outside.classList.contains('is-outside'));
  assert.match(accessibleName(outside), /maanantai 31\. elokuuta 2026: ei merkintöjä/);
  assert.equal(accessibleName(doc.querySelector(`[data-cal-day="${THURSDAY}"]`)), 'torstai 1. lokakuuta 2026: 1 meno');
  // Vain yksi ruutu sarkainjärjestyksessä (valittu päivä).
  assert.deepEqual(cells.filter(cell => cell.getAttribute('tabindex') === '0').map(cell => cell.dataset.calDay), [TUESDAY]);

  byId('calNext').click();
  assert.equal(text(byId('calTitle')), 'Lokakuu 2026');
  assert.equal(getState().calendarDate, '2026-10-01');
  byId('calPrev').click();
  byId('calPrev').click();
  assert.equal(text(byId('calTitle')), 'Elokuu 2026');

  byId('calToday').click();
  doc.querySelector('[data-cal-day="2026-09-15"]').click();
  assert.deepEqual([getState().calendarView, getState().calendarDate], ['day', '2026-09-15']);
  assertSameNode(doc.activeElement, byId('calTitle'));
  assert.equal(text(byId('calTitle')), 'Tiistai 15.9.');
});

test('päivän nuolet ja Tänään', (t) => {
  freezeLocalDate(t, TUESDAY);
  const { byId } = mountCalendar();
  byId('calNext').click();
  assert.equal(text(byId('calEyebrow')), 'Huomenna');
  byId('calPrev').click();
  byId('calPrev').click();
  assert.equal(text(byId('calEyebrow')), 'Eilen');
  assert.equal(byId('calPrev').getAttribute('aria-label'), 'Edellinen päivä');
  byId('calToday').click();
  assert.equal(getState().calendarDate, TUESDAY);
  stepCalendar(1, TUESDAY);
  assert.equal(getState().calendarDate, WEDNESDAY);
});

// ================================================================ LOMAKE: TARKISTUS

const VALID = Object.freeze({
  title: '  Hammaslääkäri  ', date: TUESDAY, allDay: false, start: '16:00', end: '', duration: '45',
  place: 'p-hammas', location: '', mode: '', travel: '', preparation: '0', early: '', overhead: '',
  weekdays: [], until: '', category: 'hyvinvointi', notes: ''
});

test('lomake: kelvollinen syöte -> tallennettava meno; tyhjä minuuttikenttä on null, nolla on nolla', () => {
  const { valid, errors, value } = validateEventForm(VALID);
  assert.equal(valid, true, JSON.stringify(errors));
  assert.deepEqual(value, {
    title: 'Hammaslääkäri', date: TUESDAY, allDay: false, startTime: '16:00', endTime: null, durationMinutes: 45,
    placeId: 'p-hammas', locationText: null, travelMode: null, travelMinutes: null, preparationMinutes: 0,
    arrivalBufferMinutes: null, overheadMinutes: null, recurrenceWeekdays: [], recurrenceUntil: null,
    category: 'hyvinvointi', notes: null
  });
  const allDay = validateEventForm({ ...VALID, allDay: true, start: '', duration: 'roskaa' });
  assert.equal(allDay.valid, true, 'koko päivän menolla aikakentät ohitetaan');
  assert.deepEqual([allDay.value.startTime, allDay.value.endTime, allDay.value.durationMinutes], [null, null, null]);
  const other = validateEventForm({ ...VALID, place: OTHER_PLACE, location: ' Kauppakatu   5 ', mode: 'walking', travel: '12' });
  assert.deepEqual([other.value.placeId, other.value.locationText, other.value.travelMode, other.value.travelMinutes],
    [null, 'Kauppakatu 5', 'walking', 12]);
  const repeat = validateEventForm({ ...VALID, weekdays: [4, '2', 2, 9, 'x'], until: '2026-12-31' });
  assert.deepEqual([repeat.value.recurrenceWeekdays, repeat.value.recurrenceUntil], [[2, 4], '2026-12-31']);
  assert.equal(validateEventForm({ ...VALID, until: '2026-12-31' }).value.recurrenceUntil, null, 'toistoton: ei loppupäivää');
  assert.equal(validateEventForm({ ...VALID, id: 'e-1' }).value.id, 'e-1');
  // Syötettä ei muuteta.
  assert.equal(VALID.title, '  Hammaslääkäri  ');
});

test('lomake: virheet suomeksi kenttäkohtaisesti; kelvotonta lukua ei pudoteta hiljaa', () => {
  const cases = [
    [{ title: '   ' }, 'ceTitle', 'Anna menolle nimi.'],
    [{ title: 'x'.repeat(201) }, 'ceTitle', 'Nimi on liian pitkä (enintään 200 merkkiä).'],
    [{ date: '2026-02-30' }, 'ceDate', 'Valitse päivä.'],
    [{ start: '' }, 'ceStart', 'Anna alkamisaika tai valitse Koko päivä.'],
    [{ end: '16:00', duration: '' }, 'ceEnd', 'Päättymisaika on sama kuin alkamisaika.'],
    [{ end: '17:00' }, 'ceDuration', 'Anna joko päättymisaika tai kesto, ei molempia.'],
    [{ duration: '0' }, 'ceDuration', 'Anna kesto minuutteina (1–1440).'],
    [{ duration: '12.5' }, 'ceDuration', 'Anna kesto minuutteina (1–1440).'],
    [{ travel: '0' }, 'ceTravel', 'Anna matka-aika minuutteina (1–1440).'],
    [{ travel: '1441' }, 'ceTravel', 'Anna matka-aika minuutteina (1–1440).'],
    [{ preparation: '-5' }, 'cePrep', 'Anna valmistautumisaika minuutteina (0–480).'],
    [{ early: '241' }, 'ceEarly', 'Anna etuaika minuutteina (0–240).'],
    [{ overhead: 'kymmenen' }, 'ceOverhead', 'Anna pysäköinti ja kävely minuutteina (0–240).'],
    [{ place: OTHER_PLACE, location: '  ' }, 'ceLocation', 'Kirjoita paikan nimi tai valitse "Ei paikkaa".'],
    [{ weekdays: [2], until: '2026-09-01' }, 'ceUntil', 'Toisto ei voi päättyä ennen ensimmäistä kertaa.'],
    [{ notes: 'x'.repeat(2001) }, 'ceNotes', 'Muistiinpano on liian pitkä (enintään 2000 merkkiä).']
  ];
  for (const [change, field, message] of cases) {
    const result = validateEventForm({ ...VALID, ...change });
    assert.equal(result.valid, false, JSON.stringify(change));
    assert.equal(result.errors[field], message, JSON.stringify(change));
    assert.equal(result.value, null);
  }
  assert.equal(validateEventForm(null).valid, false, 'roskasyöte ei kaada');
  assert.equal(validateEventForm(undefined).errors.ceTitle, 'Anna menolle nimi.');
});

// ================================================================ LOMAKE: TALLENNUS

test('uusi meno: avaus, tallennus dailyLifeActionsin kautta, lomake sulkeutuu ja meno näkyy', async (t) => {
  freezeLocalDate(t, TUESDAY);
  const { doc, byId } = mountCalendar({ before: () => seed({ events: [], tasks: [] }) });
  const opener = byId('calNewEvent');
  opener.focus();
  opener.click();
  assert.equal(isRendered(byId('calEventForm')), true);
  assertSameNode(doc.activeElement, byId('ceTitle'), 'fokus otsikkoon');
  assert.equal(byId('ceDate').value, TUESDAY, 'oletuspäivä on katsottava päivä');
  assert.equal(isRendered(byId('ceDelete')), false);
  assert.equal(isRendered(byId('ceSkip')), false);
  assert.deepEqual(byId('cePlace').querySelectorAll('option').map(o => o.textContent),
    ['Ei paikkaa', 'Hammaslääkäri Keskusta', 'Muu paikka']);

  type(byId('ceTitle'), 'Hammaslääkäri');
  type(byId('ceStart'), '16:00');
  type(byId('ceDuration'), '45');
  choose(byId('cePlace'), 'p-hammas');
  assert.match(text(byId('cePlaceHint')), /Oletukset paikasta Hammaslääkäri Keskusta: matka 25 min, valmistautuminen 15 min, etuaika 10 min, pysäköinti ja kävely 0 min\./);
  assert.equal(byId('ceTravel').getAttribute('placeholder'), 'paikan arvio 25');
  assert.equal(byId('ceTravel').value, '', 'paikan arvoja ei kopioida menolle');
  byId('ceSave').click();
  await flush();

  const [saved] = getState().calendarEvents;
  assert.equal(getState().calendarEvents.length, 1);
  assert.deepEqual([saved.title, saved.date, saved.startTime, saved.durationMinutes, saved.placeId, saved.travelMinutes],
    ['Hammaslääkäri', TUESDAY, '16:00', 45, 'p-hammas', null]);
  assert.equal(isRendered(byId('calEventForm')), false, 'lomake sulkeutui');
  assertSameNode(doc.activeElement, opener, 'fokus palasi avaajaan');
  assert.match(text(doc.querySelector('[data-cal-open]').closest('li')), /Lähde 15\.25 · valmistaudu 15\.10 · perillä 15\.50/);
  assert.match(text(doc.querySelector('#toastHost')), /Meno lisätty kalenteriin\./);
});

test('virheellinen lomake: virhe kentän alla (role=alert), aria-invalid ja fokus ensimmäiseen; mitään ei tallenneta', async (t) => {
  freezeLocalDate(t, TUESDAY);
  const { doc, byId } = mountCalendar({ before: () => seed({ events: [], tasks: [] }) });
  byId('calNewEvent').click();
  type(byId('ceTravel'), '0');
  byId('ceSave').click();
  await flush();
  assert.equal(getState().calendarEvents.length, 0);
  assert.equal(byId('ceTitleError').textContent, 'Anna menolle nimi.');
  assert.equal(byId('ceTitleError').getAttribute('role'), 'alert');
  assert.equal(byId('ceTitle').getAttribute('aria-invalid'), 'true');
  assert.equal(byId('ceStartError').textContent, 'Anna alkamisaika tai valitse Koko päivä.');
  assert.equal(byId('ceTravelError').textContent, 'Anna matka-aika minuutteina (1–1440).');
  assertSameNode(doc.activeElement, byId('ceTitle'), 'fokus ensimmäiseen virheelliseen');

  // Korjaus poistaa virheet; koko päivän meno ilman aikaa kelpaa.
  type(byId('ceTitle'), 'Muuttopäivä');
  byId('ceAllDay').click();
  assert.equal(isRendered(byId('ceTimeRow')), false, 'aikarivi piiloon koko päivän menolla');
  type(byId('ceTravel'), '');
  press(doc, 'Enter');
  await flush();
  assert.equal(getState().calendarEvents.length, 1);
  assert.equal(getState().calendarEvents[0].allDay, true);
  assert.equal(byId('ceTitleError').textContent, '');
});

test('muokkaus: lomake täyttyy menosta, tyhjennetty kenttä tallentuu nullina, Esc sulkee ja palauttaa fokuksen', async (t) => {
  freezeLocalDate(t, TUESDAY);
  const { doc, byId } = mountCalendar({
    before: () => seed({ events: [{ ...EVENTS[0], travelMinutes: 30, notes: 'Ota kortti' }], tasks: [] })
  });
  const row = doc.querySelector('[data-cal-open="e-hammas"]');
  row.focus();
  row.click();
  assert.equal(text(byId('calFormTitle')), 'Muokkaa menoa');
  assert.deepEqual([byId('ceTitle').value, byId('ceStart').value, byId('ceDuration').value, byId('cePlace').value,
    byId('ceTravel').value, byId('ceNotes').value], ['Hammaslääkäri', '16:00', '45', 'p-hammas', '30', 'Ota kortti']);
  assert.equal(isRendered(byId('ceDelete')), true);
  assert.equal(isRendered(byId('ceSkip')), false, 'kertaluonteinen: ei ohitusta');

  press(doc, 'Escape');
  assert.equal(isRendered(byId('calEventForm')), false);
  assertSameNode(doc.activeElement, row, 'fokus palasi riviin');

  doc.querySelector('[data-cal-open="e-hammas"]').click();
  type(byId('ceTravel'), '');
  type(byId('ceStart'), '15:00');
  const result = await submitEventForm();
  assert.equal(result.ok, true);
  const saved = getState().calendarEvents[0];
  assert.deepEqual([saved.startTime, saved.travelMinutes, saved.notes, saved.placeId], ['15:00', null, 'Ota kortti', 'p-hammas']);
  assert.equal(getState().calendarEvents.length, 1, 'päivitys ei luonut uutta');
  // Paikan tavallinen matka-aika pätee taas.
  assert.match(text(doc.querySelector('[data-cal-open="e-hammas"]').closest('li')), /Lähde 14\.25/);
});

test('"lisää oma arvio" avaa lomakkeen matka-aikaan; tallennuksen jälkeen lähtö lasketaan', async (t) => {
  freezeLocalDate(t, TUESDAY);
  const { doc, byId } = mountCalendar({ before: () => seed({ tasks: [] }) });
  doc.querySelector('[data-cal-travel="e-parturi"]').click();
  assertSameNode(doc.activeElement, byId('ceTravel'), 'fokus matka-aikaan');
  assert.equal(byId('cePlace').value, OTHER_PLACE);
  assert.equal(byId('ceLocation').value, 'Parturi Kallio');
  type(byId('ceTravel'), '20');
  byId('ceSave').click();
  await flush();
  const barber = doc.querySelector('[data-cal-open="e-parturi"]').closest('li');
  // Kävely ei ole valittu: auton oletukset (valmistautuminen 10, pysäköinti 5), etuaika asetuksista 10.
  assert.match(text(barber), /Lähde 12\.25 · valmistaudu 12\.15 · perillä 12\.50/);
  assert.match(text(barber), /Matka 20 min \(oma arvio\) · pysäköinti ja kävely 5 min · etuaika 10 min/);
  assert.equal(doc.querySelector('[data-cal-travel="e-parturi"]'), null);
});

test('toistuva meno: "Ohita tämä kerta" kysyy vahvistuksen ja ohittaa vain sen kerran', async (t) => {
  freezeLocalDate(t, TUESDAY);
  const { doc, byId } = mountCalendar({ before: () => seed({ tasks: [] }) });
  showCalendarDay(THURSDAY);
  const row = doc.querySelector(`[data-cal-open="e-jooga"][data-cal-date="${THURSDAY}"]`);
  assert.ok(row, 'joogan torstain kerta');
  row.click();
  assert.equal(isRendered(byId('ceSkip')), true);
  assert.equal(text(byId('calFormNote')), 'Toistuva meno. Muutokset koskevat kaikkia kertoja. Voit myös ohittaa vain kerran 1.10.');
  assert.deepEqual(editingEvent(), { eventId: 'e-jooga', occurrenceDate: THURSDAY, open: true });

  // Peruminen ei ohita mitään.
  byId('ceSkip').click();
  let dialog = doc.getElementById('confirmDialog');
  assert.ok(dialog && dialog.open, 'vahvistus kysytään');
  assert.match(text(dialog), /Ohitetaanko tämä kerta\? "Jooga" jää pois torstaina 1\.10\. Muut kerrat pysyvät ennallaan\./);
  doc.getElementById('confirmCancel').click();
  await flush();
  assert.deepEqual(getState().calendarEvents.find(e => e.id === 'e-jooga').skipDates, []);
  assert.equal(isRendered(byId('calEventForm')), true);

  byId('ceSkip').click();
  dialog = doc.getElementById('confirmDialog');
  doc.getElementById('confirmAccept').click();
  await flush();
  assert.deepEqual(getState().calendarEvents.find(e => e.id === 'e-jooga').skipDates, [THURSDAY]);
  assert.equal(isRendered(byId('calEventForm')), false);
  assert.equal(doc.querySelector('[data-cal-open="e-jooga"]'), null, 'kerta poistui torstailta');
  showCalendarDay(TUESDAY);
  assert.ok(doc.querySelector('[data-cal-open="e-jooga"]'), 'tiistain kerta säilyi');
  assert.match(text(doc.querySelector('#toastHost')), /Kerta 1\.10\. ohitettu\./);

  // Suora kutsu ilman avointa lomaketta ei tee mitään.
  assert.deepEqual(await skipEditedOccurrence({ confirm: async () => true }), { ok: false });
});

test('poisto kysyy vahvistuksen; hyväksyntä poistaa menon ja fokus siirtyy "Uusi meno" -painikkeeseen', async (t) => {
  freezeLocalDate(t, TUESDAY);
  const { doc, byId } = mountCalendar({ before: () => seed({ tasks: [] }) });
  doc.querySelector('[data-cal-open="e-palaveri"]').click();
  byId('ceDelete').click();
  const dialog = doc.getElementById('confirmDialog');
  assert.ok(dialog.open);
  assert.match(text(dialog), /Poistetaanko meno\?/);
  doc.getElementById('confirmAccept').click();
  await flush();
  assert.equal(getState().calendarEvents.some(e => e.id === 'e-palaveri'), false);
  assert.equal(isRendered(byId('calEventForm')), false);
  assertSameNode(doc.activeElement, byId('calNewEvent'));
});

test('uloskirjautuminen: resetCalendarView sulkee ja tyhjentää lomakkeen (ei vuotoa seuraavalle käyttäjälle)', (t) => {
  freezeLocalDate(t, TUESDAY);
  const { doc, byId } = mountCalendar({ before: () => seed({ tasks: [] }) });
  doc.querySelector('[data-cal-open="e-hammas"]').click();
  assert.equal(byId('ceTitle').value, 'Hammaslääkäri');
  resetCalendarView();
  assert.equal(isRendered(byId('calEventForm')), false);
  assert.deepEqual([byId('ceTitle').value, byId('ceStart').value, byId('cePlace').querySelectorAll('option').length], ['', '', 0]);
  assert.deepEqual(editingEvent(), { eventId: null, occurrenceDate: null, open: false });
  assert.equal(openEventForm({ eventId: 'ei-ole' }), false, 'poistettua menoa ei avata');
});

test('oletuspäivä: päivä- ja kuukausinäkymässä katsottava päivä, viikolla tämä päivä tai maanantai', (t) => {
  freezeLocalDate(t, TUESDAY);
  resetState();
  setCalendarDate('2026-10-20');
  assert.equal(defaultEventDate(getState(), TUESDAY), '2026-10-20');
  setWeekStart(parseISO(MONDAY));
  setCalendarView('week');
  assert.equal(defaultEventDate(getState(), TUESDAY), TUESDAY);
  setWeekStart(parseISO('2026-10-05'));
  assert.equal(defaultEventDate(getState(), TUESDAY), '2026-10-05');
});

test('huomautukset: suljettu portti kertoo istunnon ajasta; latausvirhe ei näytä tyhjää kalenteria', (t) => {
  freezeLocalDate(t, TUESDAY);
  const { byId } = mountCalendar({ before: () => setDomainLoadStatus('calendarEvents', false) });
  assert.match(text(byId('calNotice')), /Tietoja ei saatu ladattua/);
  setDomainLoadStatus('calendarEvents', true);
  assert.match(text(byId('calNotice')), /Menot säilyvät toistaiseksi vain tämän istunnon ajan\./);
  assert.match(text(byId('calDayAgenda')), /Ei menoja eikä tehtäviä tälle päivälle\./);
});

// ================================================================ NÄPPÄIMISTÖ JA FOKUS

test('näppäimistö: osiot nuolilla, kuukausiruudukko nuolilla ja Enterillä, sarkainjärjestys nimetty', (t) => {
  freezeLocalDate(t, TUESDAY);
  const { doc, byId } = mountCalendar({ before: () => seed() });
  byId('segmentCalDay').focus();
  press(doc, 'ArrowRight');
  assert.equal(getState().calendarView, 'week');
  assertSameNode(doc.activeElement, byId('segmentCalWeek'));
  press(doc, 'End');
  assert.equal(getState().calendarView, 'month');
  assertSameNode(doc.activeElement, byId('segmentCalMonth'));
  press(doc, 'ArrowRight');
  assert.equal(getState().calendarView, 'day', 'kiertää alkuun');
  press(doc, 'ArrowLeft');
  assert.equal(getState().calendarView, 'month');

  // Ruudukko: sarkain vie valittuun päivään, nuolet liikuttavat fokusta.
  const order = tabOrder(doc);
  const gridCells = order.filter(node => node.dataset && node.dataset.calDay);
  assert.deepEqual(gridCells.map(node => node.dataset.calDay), [TUESDAY], 'ruudukko on yksi sarkainpysäkki');
  gridCells[0].focus();
  press(doc, 'ArrowUp');
  assert.equal(doc.activeElement.dataset.calDay, '2026-09-22', 'ylös = viikko taaksepäin');
  press(doc, 'ArrowLeft');
  assert.equal(doc.activeElement.dataset.calDay, '2026-09-21');
  press(doc, 'End');
  assert.equal(doc.activeElement.dataset.calDay, '2026-09-27');
  press(doc, 'ArrowDown');
  press(doc, 'ArrowDown');
  assert.equal(doc.activeElement.dataset.calDay, '2026-10-04', 'reunalla pysähtyy');
  assert.equal(doc.activeElement.getAttribute('tabindex'), '0', 'sarkain palaa fokusoituun ruutuun');
  press(doc, 'Home');
  assert.equal(doc.activeElement.dataset.calDay, MONDAY);
  assert.equal(getState().calendarView, 'month', 'nuolet eivät vaihda näkymää');
  press(doc, 'Enter');
  assert.deepEqual([getState().calendarView, getState().calendarDate], ['day', MONDAY]);
  assertSameNode(doc.activeElement, byId('calTitle'));

  // Jokaisella sarkaimella saavutettavalla ohjaimella on nimi.
  for (const node of tabOrder(doc, { root: byId('screen-week') })) {
    assert.ok(accessibleName(node), `nimetön ohjain: ${node.outerHTML.slice(0, 80)}`);
  }
});

test('lomakkeen sarkainjärjestys kulkee kentästä toiseen ja Peruuta palauttaa fokuksen', (t) => {
  freezeLocalDate(t, TUESDAY);
  const { doc, byId } = mountCalendar();
  const opener = byId('calNewEvent');
  opener.focus();
  press(doc, 'Enter');
  assertSameNode(doc.activeElement, byId('ceTitle'));
  const order = tabOrder(doc, { root: byId('calEventForm') }).map(node => node.id);
  assert.deepEqual(order.slice(0, 7), ['ceTitle', 'ceDate', 'ceAllDay', 'ceStart', 'ceEnd', 'ceDuration', 'cePlace']);
  assert.equal(order.includes('ceLocation'), false, 'muu paikka piilossa kunnes valitaan');
  assert.equal(order.includes('ceUntil'), false, 'loppupäivä piilossa ilman toistoa');
  byId('ceRepeat2').click();
  assert.ok(tabOrder(doc, { root: byId('calEventForm') }).map(node => node.id).includes('ceUntil'));
  assert.deepEqual(order.slice(-4), ['ceCategory', 'ceNotes', 'ceCancel', 'ceSave'], 'piilotetut Poista ja Ohita eivät ole järjestyksessä');
  byId('ceCancel').click();
  assertSameNode(doc.activeElement, opener);
});

// ================================================================ FOKUS: TEHTÄVÄ JA LOMAKKEEN SULKU

/**
 * Näytöt kuten main.js: tilamuutos piirtää avoimen näytön (renderVisible),
 * ja switchTab piirtää likaisen näytön ennen näyttämistä. Tekeminen-näytöltä
 * piirretään vain tehtävät (osiot), koska tehtävän muokkaus avautuu sinne.
 */
function withScreens(t, { render }) {
  setScreenRenderers({ 'screen-week': render, 'screen-tasks': () => renderTasks() });
  const stop = subscribe(() => renderVisible());
  t.after(() => {
    stop();
    setScreenRenderers({});
  });
}

test('tehtävän napautus Kalenterissa avaa näkyvän muokkauslomakkeen, vaikka Tekemisessä oli auki Rutiinit', (t) => {
  freezeLocalDate(t, TUESDAY);
  const { doc, byId, render } = mountCalendar({ before: () => seed({ events: [] }) });
  withScreens(t, { render });
  // Käyttäjä kävi aiemmin Tekeminen → Rutiinit ja palasi Kalenteriin.
  switchTab('screen-tasks');
  setTasksSegment('routines');
  switchTab('screen-week');

  const row = doc.querySelector('button[data-cal-task="t-raportti"]');
  row.focus();
  row.click();
  assert.equal(getState().screen, 'screen-tasks');
  assert.equal(getState().tasksSegment, 'tasks', 'muokattava tehtävä on Tehtävät-osiossa');
  assert.equal(isRendered(byId('addForm')), true, 'lomake näkyy (ei piilotetun osion sisällä)');
  assert.equal(byId('afTitle').value, 'Raportti');
  assertSameNode(doc.activeElement, byId('afTitle'), 'fokus lomakkeen otsikkoon, ei piilotettuun kalenteriin');

  // Sama polku Viikko-osion tehtävälistasta (week.js).
  switchTab('screen-week');
  setTasksSegment('inbox');
  byId('segmentCalWeek').click();
  const edit = doc.querySelector('#weekListContainer [data-edit="t-raportti"]');
  assert.equal(isRendered(edit), true);
  edit.click();
  assert.deepEqual([getState().screen, getState().tasksSegment], ['screen-tasks', 'tasks']);
  assert.equal(isRendered(byId('addForm')), true);
  assertSameNode(doc.activeElement, byId('afTitle'));
});

test('Viikko: menon tallennus vie fokuksen näkyvään viikon riviin, ei piilossa olevan Päivän vanhaan riviin', async (t) => {
  freezeLocalDate(t, TUESDAY);
  const { doc, byId } = mountCalendar({ before: () => seed({ tasks: [] }) });
  // Kalenteri avautuu Päivään: päivälistaan jää hammaslääkärin rivi, kun osio vaihtuu.
  assert.ok(doc.querySelector('#calDayAgenda [data-cal-open="e-hammas"]'));
  byId('segmentCalWeek').click();
  const row = doc.querySelector('#calWeekEvents [data-cal-open="e-hammas"]');
  row.focus();
  press(doc, 'Enter');
  assertSameNode(doc.activeElement, byId('ceTitle'));
  type(byId('ceTitle'), 'Hammaslääkäri (tarkastus)');
  press(doc, 'Enter');
  await flush();

  assert.equal(getState().calendarEvents.find(e => e.id === 'e-hammas').title, 'Hammaslääkäri (tarkastus)');
  assert.equal(isRendered(byId('calEventForm')), false);
  const fresh = doc.querySelector('#calWeekEvents [data-cal-open="e-hammas"]');
  assert.notEqual(fresh, row, 'rivi piirrettiin uudelleen (avaaja katosi)');
  assertSameNode(doc.activeElement, fresh, 'fokus saman menon näkyvään riviin');
  assert.equal(isRendered(doc.activeElement), true);
});

test('Päivä Viikon jälkeen: poisto vie fokuksen "Uusi meno" -painikkeeseen, ei piilossa olevaan viikon riviin', async (t) => {
  freezeLocalDate(t, TUESDAY);
  const { doc, byId } = mountCalendar({ before: () => seed({ tasks: [] }) });
  byId('segmentCalWeek').click();
  byId('segmentCalDay').click();
  // Piilossa olevaan viikkolistaan jäi palaverin rivi edelliseltä käynniltä.
  assert.ok(doc.querySelector('#calWeekEvents [data-cal-open="e-palaveri"]'));
  const row = doc.querySelector('#calDayAgenda [data-cal-open="e-palaveri"]');
  row.focus();
  press(doc, 'Enter');
  byId('ceDelete').click();
  doc.getElementById('confirmAccept').click();
  await flush();

  assert.equal(getState().calendarEvents.some(e => e.id === 'e-palaveri'), false);
  assertSameNode(doc.activeElement, byId('calNewEvent'), 'fokus "Uusi meno" -painikkeeseen');

  // Toistuvan menon ohitus samassa tilanteessa: kerran rivi katoaa päivältä.
  showCalendarDay(THURSDAY);
  byId('segmentCalWeek').click();
  byId('segmentCalDay').click();
  doc.querySelector(`#calDayAgenda [data-cal-open="e-jooga"][data-cal-date="${THURSDAY}"]`).click();
  byId('ceSkip').click();
  doc.getElementById('confirmAccept').click();
  await flush();
  assert.deepEqual(getState().calendarEvents.find(e => e.id === 'e-jooga').skipDates, [THURSDAY]);
  assertSameNode(doc.activeElement, byId('calNewEvent'));
});

test('Poista → Peruuta (tai Esc) palauttaa fokuksen Poista-painikkeeseen; epäonnistunut poisto samoin', async (t) => {
  freezeLocalDate(t, TUESDAY);
  const { doc, byId } = mountCalendar({ before: () => seed({ tasks: [] }) });
  doc.querySelector('[data-cal-open="e-palaveri"]').click();
  const del = byId('ceDelete');
  del.focus();
  press(doc, 'Enter');
  const dialog = doc.getElementById('confirmDialog');
  assert.ok(dialog.open, 'vahvistus kysytään');
  // Dialogi palauttaa sulkeutuessaan fokuksen avaajaansa: estettyyn
  // painikkeeseen fokus ei siirry.
  assert.equal(del.disabled, false, 'Poista ei ole estetty vahvistuksen aikana');
  press(doc, 'Escape');
  await flush();
  assert.equal(dialog.open, false);
  assert.ok(getState().calendarEvents.some(e => e.id === 'e-palaveri'), 'peruttu: meno säilyi');
  assert.equal(isRendered(byId('calEventForm')), true, 'lomake jäi auki');
  assertSameNode(doc.activeElement, del, 'fokus palasi Poista-painikkeeseen');

  // Peruuta-painike: sama.
  del.click();
  doc.getElementById('confirmCancel').click();
  await flush();
  assertSameNode(doc.activeElement, del);

  // Hyväksytty mutta epäonnistunut poisto: meno palaa, lomake jää auki ja
  // fokus palaa Poista-painikkeeseen uutta yritystä varten.
  const original = calendarEventsRepo.remove;
  calendarEventsRepo.remove = async () => ({ ok: false, error: { message: 'verkko', userMessage: 'Yhteys katkesi.' } });
  t.after(() => { calendarEventsRepo.remove = original; });
  const result = await deleteEditedEvent({
    confirm: async () => {
      // Selain siirtää fokuksen bodyyn, kun fokusoitu painike estetään
      // tallennuksen ajaksi (tynkä-DOM ei tee sitä itse).
      doc.activeElement = doc.body;
      return true;
    }
  });
  assert.equal(result.ok, false);
  assert.ok(getState().calendarEvents.some(e => e.id === 'e-palaveri'), 'epäonnistunut poisto palautettiin');
  assert.equal(isRendered(byId('calEventForm')), true);
  assert.equal(del.disabled, false, 'painike vapautui');
  assertSameNode(doc.activeElement, del);
});

test('Viikko: "Merkitse tehdyksi" ja muu uudelleenpiirto pitävät fokuksen samassa ohjaimessa', async (t) => {
  freezeLocalDate(t, TUESDAY);
  const { doc, byId, render } = mountCalendar({ before: () => seed({ events: [] }) });
  byId('segmentCalWeek').click();
  const toggleButton = () => doc.querySelector('#weekListContainer [data-toggle="t-raportti"]');
  const before = toggleButton();
  assert.equal(accessibleName(before), 'Merkitse tehdyksi: Raportti');
  before.focus();
  press(doc, 'Enter');
  await flush();

  assert.equal(getState().tasks.find(task => task.id === 't-raportti').completed, true, 'yksi painallus = yksi merkintä');
  const after = toggleButton();
  assert.equal(accessibleName(after), 'Merkitse keskeneräiseksi: Raportti');
  assertSameNode(doc.activeElement, after, 'fokus pysyi saman tehtävän painikkeessa');

  // Viikkonauhan päivä: muu tilamuutos (esim. synkronointi) ei pudota fokusta.
  const day = doc.querySelector(`#weekStripContainer [data-date="${WEDNESDAY}"]`);
  day.focus();
  setTasks([...getState().tasks, normalizeTask({ id: 't-uusi', title: 'Uusi', date: WEDNESDAY })]);
  const dayAfter = doc.querySelector(`#weekStripContainer [data-date="${WEDNESDAY}"]`);
  assert.match(accessibleName(dayAfter), /1 tehtävää/);
  assertSameNode(doc.activeElement, dayAfter, 'fokus pysyi samassa päivässä');

  // Kuuntelijat eivät kasaannu piirroista: napautus avaa päivän kerran.
  render();
  render();
  dayAfter.click();
  assert.deepEqual([getState().calendarView, getState().calendarDate], ['day', WEDNESDAY]);
  assertSameNode(doc.activeElement, byId('calTitle'));
});
