// Kalenteri: päivä, viikko ja kuukausi yhdellä välilehdellä (screen-week).
//
// PÄIVÄ ON SAMA SUUNNITELMA KUIN TÄNÄÄN. Päivänäkymä rakennetaan
// scheduler.buildDayPlan-funktiolla samoista syötteistä kuin muualla
// (src/app/calendarPlan.js): menojen esiintymät, niiden lähdöt ja suojatut
// lohkot (valmistautuminen, matka, pysäköinti ja kävely, etuaika,
// iltarauhoittuminen, uni). Kalenteri ei siis voi näyttää eri lähtöaikaa
// kuin muistutus.
//
// SUOJATTU EI OLE VAPAATA. Matka, valmistautuminen ja uni näkyvät omina
// riveinään, himmennettyinä ja sanalla "suojattu" -- ei pelkällä värillä.
//
// TUNTEMATON NÄYTETÄÄN TUNTEMATTOMANA. Menolle, jolla on paikka mutta ei
// matka-aikaa, ei näytetä keksittyä lähtöaikaa vaan "Matka-aika puuttuu"
// ja painike oman arvion lisäämiseen.
//
// VIIKKO ON VANHA VIIKKONÄKYMÄ (week.js, tunnisteet ennallaan). Tämä
// moduuli lisää sen yläpuolelle viikon menot ja hoitaa osioiden vaihdon.
//
// Moderni kaava: merkintä renderHtml-funktiolla (fokus säilyy), kuuntelijat
// delegoidaan kerran initCalendar()-funktiossa staattisiin säiliöihin.

import { el, maybe, toggle, renderHtml, setHtml } from '../../ui/dom.js';
import { notify } from '../../ui/toast.js';
import { escapeHtml, capitalize } from '../../lib/format.js';
import { fmtISO, parseISO, todayMidnight, startOfWeek } from '../../lib/datetime.js';
import {
  getState, batch, setCalendarView, setCalendarDate, showCalendarDay, setWeekStart, CALENDAR_VIEWS
} from '../state.js';
import { calendarDayPlan } from '../calendarPlan.js';
import {
  addDaysToIso, shiftMonth, monthGrid, monthGridRange, monthLabel, expandEventOccurrences,
  isoWeekdayOf, shortDateLabel, spokenDateLabel
} from '../../domain/calendar.js';
import { BLOCK_KIND, blockKindOf, isEventOccurrence } from '../../domain/scheduler.js';
import { durationOf, toMinutes, fromMinutes, isIsoDate, isTimeOfDay } from '../../domain/task.js';
import { weekdayName } from '../../domain/routine.js';
import { clockText } from '../../domain/wallClock.js';
import { ESTIMATE_SOURCE } from '../../domain/dailyLife.js';
import { hasTable, isTableAvailable } from '../../data/schema.js';
import { serverUnavailableHintHtml } from '../schemaStatus.js';
import { loadFailureHtml } from './loadNotice.js';
import { openEditForm } from './tasks.js';
import { initEventForm, openEventForm, resetEventForm, defaultEventDate } from './calendarForm.js';

const VIEW_KEYS = Object.freeze(CALENDAR_VIEWS.map(view => view.key));

const SEGMENT_IDS = Object.freeze({ day: 'segmentCalDay', week: 'segmentCalWeek', month: 'segmentCalMonth' });
const SECTION_IDS = Object.freeze({ day: 'calDaySection', week: 'calWeekSection', month: 'calMonthSection' });

/** Rivin laji tekstinä: tila ei koskaan pelkkänä värinä. */
export const KIND_LABELS = Object.freeze({
  event: 'Meno',
  task: 'Tehtävä',
  routine: 'Rutiini',
  [BLOCK_KIND.PREPARATION]: 'Valmistautuminen',
  [BLOCK_KIND.TRAVEL]: 'Matka',
  [BLOCK_KIND.OVERHEAD]: 'Pysäköinti ja kävely',
  [BLOCK_KIND.ARRIVAL_BUFFER]: 'Etuaika',
  [BLOCK_KIND.WIND_DOWN]: 'Iltarauhoittuminen',
  [BLOCK_KIND.SLEEP]: 'Uni'
});

const REST_TITLES = Object.freeze({
  [BLOCK_KIND.WIND_DOWN]: 'Rauhoittuminen ennen unta',
  [BLOCK_KIND.SLEEP]: 'Suojattu uni'
});

/** Matka-ajan lähde käyttäjän sanoin (ei "provider" tms.). */
const SOURCE_LABELS = Object.freeze({
  [ESTIMATE_SOURCE.USER_SUPPLIED]: 'oma arvio',
  [ESTIMATE_SOURCE.LEARNED]: 'opittu omista matkoista',
  [ESTIMATE_SOURCE.PROVIDER]: 'liikennetieto'
});

/** Samaan aikaan alkavat: lohko (esim. matka) ennen menoa, meno ennen rutiinia ja tehtävää. */
const KIND_ORDER = Object.freeze({ block: 0, event: 1, routine: 2, task: 3 });

function todayIsoNow() {
  return fmtISO(todayMidnight());
}

function plural(count, one, many) {
  return `${count} ${count === 1 ? one : many}`;
}

// ============================================================ otsikot

/** Päivän otsikko: 'Tiistai 29.9.' (vuosi vain, jos se ei ole kuluva). */
export function dayTitle(dateIso, todayIso = todayIsoNow()) {
  if (!isIsoDate(dateIso)) return '';
  const [year, month, day] = dateIso.split('-').map(Number);
  const currentYear = isIsoDate(todayIso) ? Number(todayIso.slice(0, 4)) : year;
  return `${capitalize(weekdayName(isoWeekdayOf(dateIso)))} ${day}.${month}.${year !== currentYear ? year : ''}`;
}

/** 'Tänään', 'Huomenna', 'Eilen' tai tyhjä. */
export function relativeDayLabel(dateIso, todayIso = todayIsoNow()) {
  if (!isIsoDate(dateIso) || !isIsoDate(todayIso)) return '';
  if (dateIso === todayIso) return 'Tänään';
  if (dateIso === addDaysToIso(todayIso, 1)) return 'Huomenna';
  if (dateIso === addDaysToIso(todayIso, -1)) return 'Eilen';
  return '';
}

// ============================================================ päivä: malli

function clockOf(minute) {
  return minute === 1440 ? '24.00' : clockText(fromMinutes(minute));
}

function rangeText(startMinute, endMinute) {
  const start = clockOf(startMinute);
  return endMinute === null || endMinute === undefined || endMinute === startMinute
    ? start
    : `${start}–${clockOf(endMinute)}`;
}

function pointText(point, referenceDate) {
  if (!point) return '';
  return point.date === referenceDate
    ? clockText(point.time)
    : `${shortDateLabel(point.date)} ${clockText(point.time)}`;
}

/**
 * Lähdön tiivistelmä menon riville.
 *   tiedossa:    'Lähde 15.25 · valmistaudu 15.10 · perillä 15.50'
 *                + erittely: 'Matka 30 min (oma arvio) · pysäköinti ja kävely 5 min · etuaika 10 min'
 *   tuntematon:  { known: false } -> "Matka-aika puuttuu"
 */
export function departureSummary(plan, referenceDate) {
  // Koko päivän menolle tai päivättömälle esiintymälle lähtöä ei lasketa.
  if (!plan || plan.applicable === false) return null;
  if (!plan.known) return Object.freeze({ known: false, text: 'Matka-aika puuttuu', detail: '' });
  const parts = [`Lähde ${pointText(plan.leave, referenceDate)}`];
  if (plan.parts.preparation > 0) parts.push(`valmistaudu ${pointText(plan.prepareStart, referenceDate)}`);
  parts.push(`perillä ${pointText(plan.arrivalTarget, referenceDate)}`);
  const detail = [`matka ${plan.parts.travel} min (${SOURCE_LABELS[plan.source] || 'oma arvio'})`];
  if (plan.parts.overhead > 0) detail.push(`pysäköinti ja kävely ${plan.parts.overhead} min`);
  if (plan.parts.early > 0) detail.push(`etuaika ${plan.parts.early} min`);
  return Object.freeze({ known: true, text: parts.join(' · '), detail: capitalize(detail.join(' · ')) });
}

function placeTextOf(item, placesById) {
  const place = item.placeId ? placesById.get(item.placeId) : null;
  if (place && place.name) return place.name;
  return typeof item.locationText === 'string' && item.locationText.trim() ? item.locationText.trim() : null;
}

function kindOf(item) {
  if (blockKindOf(item) && item.block === true) return 'block';
  if (isEventOccurrence(item)) return 'event';
  if (item.isRoutine === true) return 'routine';
  return 'task';
}

function spanOf(item) {
  const startMinute = toMinutes(item.time);
  const duration = durationOf(item);
  return { startMinute, endMinute: duration === null ? null : startMinute + duration };
}

function eventRow(item, context, { allDay = false } = {}) {
  const continuation = item.continuation === true;
  const date = continuation && isIsoDate(item.startedOn) ? item.startedOn : item.date;
  const plan = !allDay && !continuation ? context.departures.get(item.id) || null : null;
  const span = allDay ? { startMinute: -1, endMinute: null } : spanOf(item);
  return Object.freeze({
    key: `event:${item.id}`,
    kind: 'event',
    blockKind: null,
    kindLabel: KIND_LABELS.event,
    startMinute: span.startMinute,
    endMinute: span.endMinute,
    time: allDay ? 'Koko päivä' : rangeText(span.startMinute, span.endMinute),
    title: String(item.title || 'Nimetön meno'),
    place: placeTextOf(item, context.placesById),
    protected: false,
    completed: false,
    eventId: String(item.eventId),
    date,
    taskId: null,
    recurring: item.recurring === true,
    continuation,
    departure: plan ? departureSummary(plan, item.date) : null
  });
}

function blockRow(item) {
  const kind = blockKindOf(item);
  const span = spanOf(item);
  const rest = kind === BLOCK_KIND.SLEEP || kind === BLOCK_KIND.WIND_DOWN;
  return Object.freeze({
    key: `block:${item.id}`,
    kind: 'block',
    blockKind: kind,
    kindLabel: KIND_LABELS[kind],
    startMinute: span.startMinute,
    endMinute: span.endMinute,
    time: rangeText(span.startMinute, span.endMinute),
    title: rest ? REST_TITLES[kind] : String(item.sourceTitle || KIND_LABELS[kind]),
    place: null,
    protected: true,
    completed: false,
    eventId: null,
    date: item.date,
    taskId: null,
    recurring: false,
    continuation: item.continuesFromPreviousDay === true,
    departure: null
  });
}

function taskRow(item, { timed }) {
  const span = timed ? spanOf(item) : { startMinute: -1, endMinute: null };
  return Object.freeze({
    key: `task:${item.id}`,
    kind: 'task',
    blockKind: null,
    kindLabel: KIND_LABELS.task,
    startMinute: span.startMinute,
    endMinute: span.endMinute,
    time: timed ? rangeText(span.startMinute, span.endMinute) : 'Ei kellonaikaa',
    title: String(item.title || 'Nimetön tehtävä'),
    place: null,
    protected: false,
    completed: item.completed === true,
    eventId: null,
    date: item.date,
    taskId: String(item.id),
    recurring: false,
    continuation: false,
    departure: null
  });
}

function routineRow(item, { timed }) {
  const span = timed ? spanOf(item) : { startMinute: -1, endMinute: null };
  return Object.freeze({
    key: `routine:${item.id}`,
    kind: 'routine',
    blockKind: null,
    kindLabel: KIND_LABELS.routine,
    startMinute: span.startMinute,
    endMinute: span.endMinute,
    time: timed ? rangeText(span.startMinute, span.endMinute) : 'Joustava',
    title: String(item.title || 'Rutiini'),
    place: null,
    protected: false,
    completed: false,
    eventId: null,
    date: item.date,
    taskId: null,
    recurring: true,
    continuation: false,
    departure: null
  });
}

function compareRows(a, b) {
  return a.startMinute - b.startMinute
    || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]
    || a.title.localeCompare(b.title, 'fi')
    || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

/**
 * Päivänäkymän malli buildDayPlan-tuloksesta.
 *
 * allDay:  koko päivän menot (aina ensin)
 * timed:   aikajärjestyksessä menot, suojatut lohkot, kiinteät rutiinit ja
 *          ajastetut tehtävät; automaattiset ehdotukset (herätys, aamutoimet)
 *          jätetään pois, koska uni- ja lähtölohkot kertovat saman tarkemmin
 * untimed: ajattomat tehtävät ja joustavat rutiinit
 */
export function dayAgendaModel(plan, { departures = new Map(), placesById = new Map() } = {}) {
  const context = { departures, placesById };
  const allDay = (plan.allDayEvents || []).map(item => eventRow(item, context, { allDay: true }))
    .sort((a, b) => a.title.localeCompare(b.title, 'fi') || (a.key < b.key ? -1 : 1));

  const timed = [];
  for (const item of plan.timeline || []) {
    if (!item || item.virtual === true || !isTimeOfDay(item.time)) continue;
    const kind = kindOf(item);
    if (kind === 'block') timed.push(blockRow(item));
    else if (kind === 'event') timed.push(eventRow(item, context));
    else if (kind === 'routine') timed.push(routineRow(item, { timed: true }));
    else timed.push(taskRow(item, { timed: true }));
  }
  timed.sort(compareRows);

  const untimed = [
    ...(plan.unscheduled || []).map(task => taskRow(task, { timed: false })),
    ...(plan.flexibleRoutines || []).map(occurrence => routineRow(occurrence, { timed: false })),
    ...(plan.completed || []).filter(task => !task.time).map(task => taskRow(task, { timed: false }))
  ];

  const entries = allDay.length + untimed.length + timed.filter(row => row.kind !== 'block').length;
  return Object.freeze({
    allDay: Object.freeze(allDay),
    timed: Object.freeze(timed),
    untimed: Object.freeze(untimed),
    hasEntries: entries > 0,
    counts: Object.freeze({
      events: allDay.length + timed.filter(row => row.kind === 'event' && !row.continuation).length,
      protected: timed.filter(row => row.protected).length
    })
  });
}

// ============================================================ päivä: merkintä

const DOT = '<span class="cal-sep"> · </span>';

function departureHtml(row) {
  const departure = row.departure;
  if (!departure) return '';
  if (!departure.known) {
    return `<p class="cal-departure is-unknown"><span>Matka-aika puuttuu — </span>`
      + `<button type="button" class="cal-inline-btn" data-cal-travel="${escapeHtml(row.eventId)}" `
      + `data-cal-date="${escapeHtml(row.date)}" aria-label="Lisää oma arvio matka-ajasta: ${escapeHtml(row.title)}">`
      + 'lisää oma arvio</button></p>';
  }
  return `<p class="cal-departure">${escapeHtml(departure.text)}</p>`
    + `<p class="cal-departure-detail">${escapeHtml(departure.detail)}</p>`;
}

function rowHtml(row) {
  const classes = ['cal-row', `cal-row-${row.kind}`];
  if (row.blockKind) classes.push(`cal-block-${row.blockKind}`);
  if (row.protected) classes.push('is-protected');
  if (row.completed) classes.push('is-done');

  const meta = [`<span class="cal-kind">${escapeHtml(row.kindLabel)}</span>`];
  if (row.protected) meta.push('<span class="cal-protected">suojattu</span>');
  if (row.place) meta.push(`<span class="cal-place">${escapeHtml(row.place)}</span>`);
  if (row.recurring && row.kind === 'event') meta.push('<span>toistuu</span>');
  if (row.continuation) meta.push('<span>jatkuu edelliseltä päivältä</span>');
  if (row.completed) meta.push('<span>tehty</span>');

  // Välilyönnit elementtien välissä: ruudunlukija ja tekstihaku eivät liimaa sanoja yhteen.
  const body = `<span class="cal-row-time">${escapeHtml(row.time)}</span> `
    + '<span class="cal-row-body">'
    + `<span class="cal-row-title">${escapeHtml(row.title)}</span> `
    + `<span class="cal-row-meta">${meta.join(DOT)}</span>`
    + '</span>';

  let main;
  if (row.kind === 'event') {
    main = `<button type="button" class="cal-row-main" data-cal-open="${escapeHtml(row.eventId)}" `
      + `data-cal-date="${escapeHtml(row.date)}">${body}</button>`;
  } else if (row.kind === 'task') {
    main = `<button type="button" class="cal-row-main" data-cal-task="${escapeHtml(row.taskId)}">${body}</button>`;
  } else {
    main = `<div class="cal-row-main">${body}</div>`;
  }
  return `<li class="${classes.join(' ')}">${main}${departureHtml(row)}</li>`;
}

function listHtml(rows) {
  return `<ul class="cal-list">${rows.map(rowHtml).join('')}</ul>`;
}

/** Päivänäkymän merkintä. Kaikki käyttäjän teksti suojataan. */
export function dayAgendaHtml(model, { failureHtml = '' } = {}) {
  const parts = [];
  if (failureHtml) parts.push(failureHtml);
  else if (!model.hasEntries) {
    parts.push('<div class="empty-state cal-empty">'
      + '<div class="empty-title">Ei menoja eikä tehtäviä tälle päivälle.</div>'
      + '<p>Lisää meno painikkeella Uusi meno.</p></div>');
  }
  if (model.allDay.length > 0) {
    parts.push(`<h2 class="section-title">Koko päivä <span class="count-badge">${model.allDay.length}</span></h2>`
      + listHtml(model.allDay));
  }
  if (model.timed.length > 0) {
    parts.push('<h2 class="section-title">Aikataulu</h2>' + listHtml(model.timed));
  }
  if (model.untimed.length > 0) {
    parts.push(`<h2 class="section-title">Ilman kellonaikaa <span class="count-badge">${model.untimed.length}</span></h2>`
      + listHtml(model.untimed));
  }
  return parts.join('');
}

// ============================================================ viikko: menot

/** Viikon menot päivittäin (vanhan viikkonäkymän yläpuolelle). */
export function weekEventsHtml(occurrences, { placesById = new Map() } = {}) {
  const list = (occurrences || []).filter(item => item.continuation !== true);
  if (list.length === 0) return '<p class="hint cal-week-empty">Ei menoja tällä viikolla.</p>';
  const byDate = new Map();
  for (const item of list) {
    if (!byDate.has(item.date)) byDate.set(item.date, []);
    byDate.get(item.date).push(item);
  }
  const context = { departures: new Map(), placesById };
  let html = `<h2 class="section-title">Menot <span class="count-badge">${list.length}</span></h2>`;
  for (const [date, items] of [...byDate].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const rows = items.map(item => eventRow(item, context, { allDay: item.allDay === true || !isTimeOfDay(item.time) }));
    html += `<div class="date-group-label">${escapeHtml(capitalize(shortDateLabel(date)))}</div>${listHtml(rows)}`;
  }
  return html;
}

// ============================================================ kuukausi

function cellLabel(day, selectedDate) {
  const parts = [];
  if (day.counts.events > 0) parts.push(plural(day.counts.events, 'meno', 'menoa'));
  if (day.counts.openTasks > 0) parts.push(plural(day.counts.openTasks, 'tehtävä', 'tehtävää'));
  let label = `${spokenDateLabel(day.date)}: ${parts.length ? parts.join(', ') : 'ei merkintöjä'}`;
  if (day.isToday) label += ', tänään';
  if (day.date === selectedDate) label += ', valittu';
  return label;
}

/** Sarkaimella saavutettava päivä: valittu, muuten tämä päivä, muuten kuun ensimmäinen. */
function tabbableDate(model, selectedDate) {
  const days = model.rows.flatMap(row => row.days);
  if (days.some(day => day.date === selectedDate)) return selectedDate;
  const today = days.find(day => day.isToday);
  if (today) return today.date;
  return model.firstDate;
}

/**
 * Kuukausiruudukko: 7 saraketta, päivä on painike (≥ 44 px). Luku päivän
 * alla = menot + avoimet tehtävät; ruudunlukija kuulee ne sanoina.
 */
export function monthGridHtml(model, { selectedDate = null } = {}) {
  if (!model || !model.valid) return '';
  const tabbable = tabbableDate(model, selectedDate);
  const head = model.weekdayLabels.map(label => `<span>${escapeHtml(label)}</span>`).join('');
  const rows = model.rows.map(row => {
    const cells = row.days.map(day => {
      const classes = ['cal-day'];
      if (day.outsideMonth) classes.push('is-outside');
      if (day.isToday) classes.push('is-today');
      if (day.date === selectedDate) classes.push('is-selected');
      if (day.isWeekend) classes.push('is-weekend');
      const count = day.counts.events + day.counts.openTasks;
      return `<button type="button" class="${classes.join(' ')}" data-cal-day="${escapeHtml(day.date)}" `
        + `tabindex="${day.date === tabbable ? '0' : '-1'}" aria-label="${escapeHtml(cellLabel(day, selectedDate))}"`
        + `${day.isToday ? ' aria-current="date"' : ''}>`
        + `<span class="cal-day-num" aria-hidden="true">${day.day}</span>`
        + `<span class="cal-day-count" aria-hidden="true">${count > 0 ? count : ''}</span>`
        + '</button>';
    }).join('');
    return `<div class="cal-month-row">${cells}</div>`;
  }).join('');
  return `<div class="cal-month" role="group" aria-label="${escapeHtml(capitalize(model.label))}">`
    + `<div class="cal-month-head" aria-hidden="true">${head}</div>${rows}</div>`;
}

// ============================================================ piirto

function noticeHtml(state) {
  const failure = (state.calendarEvents || []).length === 0 ? loadFailureHtml(state, ['calendarEvents']) : '';
  if (failure) return failure;
  if (isTableAvailable('calendarEvents')) return '';
  if (hasTable('calendarEvents')) return serverUnavailableHintHtml();
  return '<p class="hint cal-notice"><strong>Huom.</strong> Menot säilyvät toistaiseksi vain tämän istunnon ajan.</p>';
}

function syncSegments(view) {
  for (const key of VIEW_KEYS) {
    const on = key === view;
    const button = el(SEGMENT_IDS[key]);
    button.classList.toggle('active', on);
    button.setAttribute('aria-selected', on ? 'true' : 'false');
    toggle(SECTION_IDS[key], on);
  }
}

/**
 * Teksti vain muuttuessa. Otsikko on live-alue (aria-live="polite"), jotta
 * ruudunlukija kertoo uuden päivän nuolen painalluksen jälkeen; sama teksti
 * ei saa kuulua uudelleen jokaisella piirrolla.
 */
function setLabel(id, value) {
  const node = maybe(id);
  const label = String(value ?? '');
  if (node && node.textContent !== label) node.textContent = label;
}

function syncHeader(state, view, today) {
  toggle('calNav', view !== 'week', 'flex');
  toggle('calWeekNav', view === 'week', 'flex');
  if (view === 'week') return;
  const prev = el('calPrev');
  const next = el('calNext');
  if (view === 'month') {
    const month = state.calendarDate.slice(0, 7);
    setLabel('calEyebrow', month === today.slice(0, 7) ? 'Tämä kuukausi' : '');
    setLabel('calTitle', capitalize(monthLabel(month)));
    prev.setAttribute('aria-label', 'Edellinen kuukausi');
    next.setAttribute('aria-label', 'Seuraava kuukausi');
    return;
  }
  setLabel('calEyebrow', relativeDayLabel(state.calendarDate, today));
  setLabel('calTitle', dayTitle(state.calendarDate, today));
  prev.setAttribute('aria-label', 'Edellinen päivä');
  next.setAttribute('aria-label', 'Seuraava päivä');
}

function placesOf(state) {
  return new Map((state.savedPlaces || []).map(place => [place.id, place]));
}

function renderDay(state, today) {
  const date = state.calendarDate;
  const { plan, inputs } = calendarDayPlan(state, date, { todayIso: today });
  const model = dayAgendaModel(plan, { departures: inputs.departures, placesById: placesOf(state) });
  const failureHtml = model.hasEntries ? '' : loadFailureHtml(state, ['tasks', 'routines']);
  renderHtml(el('calDayAgenda'), dayAgendaHtml(model, { failureHtml }), { fallback: ['calTitle'] });
}

function renderWeekEvents(state) {
  const monday = fmtISO(startOfWeek(state.weekStart));
  const sunday = addDaysToIso(monday, 6);
  const occurrences = expandEventOccurrences({ events: state.calendarEvents || [], from: monday, to: sunday });
  renderHtml(el('calWeekEvents'), weekEventsHtml(occurrences, { placesById: placesOf(state) }),
    { fallback: ['weekRangeLabel'] });
}

function renderMonth(state, today) {
  const month = state.calendarDate.slice(0, 7);
  const range = monthGridRange(month);
  const occurrences = range
    ? expandEventOccurrences({ events: state.calendarEvents || [], from: range.from, to: range.to })
    : [];
  const model = monthGrid({ month, occurrences, tasks: state.tasks || [], todayIso: today });
  renderHtml(el('calMonthGrid'), monthGridHtml(model, { selectedDate: state.calendarDate }),
    { fallback: ['calTitle'] });
}

/**
 * Piirrä kalenterin osiot nykytilasta: otsikko, osiovalinta, huomautus ja
 * NÄKYVÄ osio. Vanhan viikkonäkymän sisällön piirtää renderWeek (week.js);
 * main.js kutsuu molempia screen-week-näytölle.
 */
export function renderCalendar() {
  const state = getState();
  const today = todayIsoNow();
  const view = VIEW_KEYS.includes(state.calendarView) ? state.calendarView : 'day';
  const current = isIsoDate(state.calendarDate) ? state : { ...state, calendarDate: today };
  syncSegments(view);
  syncHeader(current, view, today);
  setHtml(el('calNotice'), noticeHtml(current));
  if (view === 'day') renderDay(current, today);
  else if (view === 'week') renderWeekEvents(current);
  else renderMonth(current, today);
}

// ============================================================ toiminnot

/**
 * Vaihda osiota. Viikko näyttää kalenterin päivän viikon; viikolta
 * palatessa päivä pysyy, jos se on katsotulla viikolla, muuten siirrytään
 * tähän päivään (jos se on viikolla) tai viikon maanantaihin.
 */
export function selectCalendarView(key, today = todayIsoNow()) {
  if (!VIEW_KEYS.includes(key)) return;
  const state = getState();
  if (key === state.calendarView) return;
  batch(() => {
    if (key === 'week') {
      setWeekStart(startOfWeek(parseISO(isIsoDate(state.calendarDate) ? state.calendarDate : today)));
    } else if (state.calendarView === 'week') {
      const monday = fmtISO(startOfWeek(state.weekStart));
      const sunday = addDaysToIso(monday, 6);
      if (!(state.calendarDate >= monday && state.calendarDate <= sunday)) {
        setCalendarDate(today >= monday && today <= sunday ? today : monday);
      }
    }
    setCalendarView(key);
  });
}

/** Edellinen tai seuraava päivä / kuukausi. */
export function stepCalendar(delta, today = todayIsoNow()) {
  const state = getState();
  const date = isIsoDate(state.calendarDate) ? state.calendarDate : today;
  if (state.calendarView === 'month') {
    const month = shiftMonth(date.slice(0, 7), delta);
    if (month) setCalendarDate(today.slice(0, 7) === month ? today : `${month}-01`);
    return;
  }
  const next = addDaysToIso(date, delta);
  if (next) setCalendarDate(next);
}

function focusTitle() {
  const title = maybe('calTitle');
  if (title && typeof title.focus === 'function') title.focus();
}

/** Avaa päivänäkymä päivälle (kuukauden ruutu) ja vie fokus otsikkoon. */
export function openCalendarDay(dateIso) {
  if (!isIsoDate(dateIso)) return;
  showCalendarDay(dateIso);
  focusTitle();
}

function onAgendaClick(event) {
  const target = event.target && typeof event.target.closest === 'function' ? event.target : null;
  if (!target) return;
  const travel = target.closest('[data-cal-travel]');
  const open = travel || target.closest('[data-cal-open]');
  if (open) {
    const opened = openEventForm({
      eventId: travel ? travel.dataset.calTravel : open.dataset.calOpen,
      occurrenceDate: open.dataset.calDate,
      focusField: travel ? 'ceTravel' : 'ceTitle',
      opener: open
    });
    if (!opened) notify('Menoa ei enää löydy. Se on ehkä poistettu toisella laitteella.');
    return;
  }
  const task = target.closest('[data-cal-task]');
  if (task) openEditForm(task.dataset.calTask);
}

function onMonthClick(event) {
  const cell = event.target && typeof event.target.closest === 'function' ? event.target.closest('[data-cal-day]') : null;
  if (cell) openCalendarDay(cell.dataset.calDay);
}

/** Nuolinäppäimet kuukausiruudukossa: vain fokus liikkuu, valinta Enterillä tai napautuksella. */
function onMonthKeydown(event) {
  const cell = event.target && typeof event.target.closest === 'function' ? event.target.closest('[data-cal-day]') : null;
  if (!cell) return;
  const cells = [...el('calMonthGrid').querySelectorAll('[data-cal-day]')];
  const index = cells.indexOf(cell);
  let next;
  switch (event.key) {
    case 'ArrowLeft': next = index - 1; break;
    case 'ArrowRight': next = index + 1; break;
    case 'ArrowUp': next = index - 7; break;
    case 'ArrowDown': next = index + 7; break;
    case 'Home': next = index - (index % 7); break;
    case 'End': next = index - (index % 7) + 6; break;
    default: return;
  }
  event.preventDefault();
  if (index < 0 || next < 0 || next >= cells.length) return;
  cell.setAttribute('tabindex', '-1');
  cells[next].setAttribute('tabindex', '0');
  cells[next].focus();
}

/** Kytke kuuntelijat kerran (main.js start). */
export function initCalendar() {
  CALENDAR_VIEWS.forEach(({ key }, index) => {
    const button = el(SEGMENT_IDS[key]);
    button.addEventListener('click', () => selectCalendarView(key));
    // Nuolet, Home ja End osiosta toiseen, kuten alapalkin välilehdissä.
    button.addEventListener('keydown', event => {
      const last = CALENDAR_VIEWS.length - 1;
      let target;
      if (event.key === 'ArrowRight') target = index === last ? 0 : index + 1;
      else if (event.key === 'ArrowLeft') target = index === 0 ? last : index - 1;
      else if (event.key === 'Home') target = 0;
      else if (event.key === 'End') target = last;
      else return;
      event.preventDefault();
      const nextKey = CALENDAR_VIEWS[target].key;
      selectCalendarView(nextKey);
      el(SEGMENT_IDS[nextKey]).focus();
    });
  });

  el('calPrev').addEventListener('click', () => stepCalendar(-1));
  el('calNext').addEventListener('click', () => stepCalendar(1));
  el('calToday').addEventListener('click', () => setCalendarDate(todayIsoNow()));
  el('calWeekToday').addEventListener('click', () => setWeekStart(startOfWeek(todayMidnight())));

  const newButton = el('calNewEvent');
  newButton.addEventListener('click', () => openEventForm({ date: defaultEventDate(), opener: newButton }));

  el('calDayAgenda').addEventListener('click', onAgendaClick);
  el('calWeekEvents').addEventListener('click', onAgendaClick);
  el('calMonthGrid').addEventListener('click', onMonthClick);
  el('calMonthGrid').addEventListener('keydown', onMonthKeydown);

  initEventForm();
}

/**
 * Uloskirjautuminen: lomake kiinni ja tyhjäksi. Näkymän tila (osio ja
 * päivä) nollautuu resetState()-kutsussa.
 */
export function resetCalendarView() {
  resetEventForm();
}
