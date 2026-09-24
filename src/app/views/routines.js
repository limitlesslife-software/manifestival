// Rutiininäkymä.
//
// Rutiini on sääntö, ei tehtävä. Siksi näkymä näyttää säännön ("Arkisin
// ma–pe klo 07:00") eikä esiintymiä — ja kertoo milloin se osuu seuraavaksi,
// jotta sääntö on ymmärrettävä ilman kalenteria.

import { itemSettingsFor, saveItemSettings } from '../timeTracking.js';
import { fmtISO, todayMidnight, parseISO } from '../../lib/datetime.js';
import { escapeHtml, formatDuration } from '../../lib/format.js';
import { CATEGORIES, categoryLabel } from '../../domain/categories.js';
import { PRIORITIES, priorityLabel, priorityTone } from '../../domain/priority.js';
import {
  RECURRENCE, ROUTINE_SCHEDULING, describeRecurrence, nextOccurrence,
  normalizeRoutine, validateRoutine, weekdayShort, normalizeWeekdays
} from '../../domain/routine.js';
import { dayGroupLabel } from '../../domain/week.js';
import { el, maybe, setText, toggle, setBusy, singleFlight, focus } from '../../ui/dom.js';
import { getState, findRoutine, setEditingRoutineId } from '../state.js';
import { createRoutine, editRoutine, deleteRoutine, toggleRoutineActive } from '../actions.js';

const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 7];

const RECURRENCE_LABELS = Object.freeze({
  [RECURRENCE.DAILY]: 'Joka päivä',
  [RECURRENCE.WEEKDAYS]: 'Arkisin (ma–pe)',
  [RECURRENCE.WEEKLY]: 'Kerran viikossa',
  [RECURRENCE.CUSTOM_WEEKDAYS]: 'Valitut päivät'
});

/** Täytä valikot domainista. */
export function populateRoutineSelects() {
  const recurrence = maybe('rfRecurrence');
  if (recurrence) {
    recurrence.innerHTML = Object.entries(RECURRENCE_LABELS)
      .map(([key, label]) => `<option value="${escapeHtml(key)}">${escapeHtml(label)}</option>`)
      .join('');
  }

  const category = maybe('rfCategory');
  if (category) {
    category.innerHTML = CATEGORIES
      .map(c => `<option value="${escapeHtml(c.key)}">${escapeHtml(c.label)}</option>`).join('');
  }

  const priority = maybe('rfPriority');
  if (priority) {
    priority.innerHTML = PRIORITIES
      .map(p => `<option value="${escapeHtml(p.key)}">${escapeHtml(p.label)}</option>`).join('');
  }

  const weekdays = maybe('rfWeekdays');
  if (weekdays) {
    weekdays.innerHTML = WEEKDAY_ORDER.map(day => `
      <label class="weekday-chip">
        <input type="checkbox" value="${day}" data-weekday>
        <span>${escapeHtml(weekdayShort(day))}</span>
      </label>`).join('');
  }
}

// ------------------------------------------------------------------ lista

function renderList(container, state) {
  const routines = [...state.routines].sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    return String(a.title).localeCompare(String(b.title), 'fi');
  });

  if (routines.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-title">Ei vielä rutiineja.</div>
        <p>Rutiini on asia, joka toistuu: aamulääkkeet, viikoittainen laskutus,
        maanantain suunnittelu. Kerro sääntö kerran — Manifestival muistaa loput.</p>
      </div>`;
    return;
  }

  const todayIso = fmtISO(todayMidnight());

  container.innerHTML = routines.map(routine => {
    const next = routine.active
      ? nextOccurrence({ routine, fromDate: todayIso, exceptions: state.routineExceptions })
      : null;

    const nextLabel = next
      ? `${dayGroupLabel(next.date)}${next.time ? ' klo ' + escapeHtml(next.time) : ''}`
      : routine.active ? 'Ei tulevia esiintymiä' : 'Ei käytössä';

    const priorityTag = routine.priority && routine.priority !== 'normaali'
      ? `<span class="prio-tag prio-${priorityTone(routine.priority)}">${escapeHtml(priorityLabel(routine.priority))}</span>`
      : '';

    const duration = formatDuration(routine.durationMinutes);

    return `<div class="routine-row ${routine.active ? '' : 'inactive'}">
      <button class="routine-toggle ${routine.active ? 'on' : ''}"
              data-toggle-routine="${escapeHtml(routine.id)}"
              role="switch" aria-checked="${routine.active ? 'true' : 'false'}"
              aria-label="${routine.active ? 'Poista käytöstä' : 'Ota käyttöön'}: ${escapeHtml(routine.title)}">
        <span class="routine-toggle-knob" aria-hidden="true"></span>
      </button>

      <button class="t-body t-open" data-edit-routine="${escapeHtml(routine.id)}"
              aria-label="Muokkaa rutiinia: ${escapeHtml(routine.title)}">
        <div class="t-title">${escapeHtml(routine.title)}${priorityTag}</div>
        <div class="t-meta">
          <span>${escapeHtml(describeRecurrence(routine))}</span>
          ${routine.preferredTime ? `<span>klo ${escapeHtml(routine.preferredTime)}</span>` : '<span class="muted">joustava</span>'}
          ${duration ? `<span>${escapeHtml(duration)}</span>` : ''}
          <span class="task-cat-tag">${escapeHtml(categoryLabel(routine.category))}</span>
        </div>
        <div class="t-sub">Seuraavaksi: ${escapeHtml(nextLabel)}</div>
      </button>

      <button class="task-del" data-del-routine="${escapeHtml(routine.id)}"
              aria-label="Poista rutiini: ${escapeHtml(routine.title)}">
        <svg class="icon" aria-hidden="true"><use href="#i-trash"/></svg>
      </button>
    </div>`;
  }).join('');

  container.querySelectorAll('[data-toggle-routine]').forEach(node =>
    node.addEventListener('click', () => toggleRoutineActive(node.dataset.toggleRoutine)));
  container.querySelectorAll('[data-edit-routine]').forEach(node =>
    node.addEventListener('click', () => openRoutineForm(node.dataset.editRoutine)));
  container.querySelectorAll('[data-del-routine]').forEach(node =>
    node.addEventListener('click', event => {
      event.stopPropagation();
      deleteRoutine(node.dataset.delRoutine);
    }));
}

/** Renderöi rutiinilista. */
export function renderRoutines() {
  const container = maybe('routinesListContainer');
  if (!container) return;
  renderList(container, getState());
  syncWeekdayVisibility();
}

// ----------------------------------------------------------------- lomake

const FIELD_TO_INPUT = {
  title: 'rfTitle',
  durationMinutes: 'rfDuration',
  preferredTime: 'rfTime',
  weekdays: 'rfWeekdays',
  recurrence: 'rfRecurrence',
  startDate: 'rfStartDate',
  endDate: 'rfEndDate'
};

function clearFieldErrors() {
  document.querySelectorAll('#routineForm .field-error').forEach(node => {
    node.textContent = '';
    node.style.display = 'none';
  });
  document.querySelectorAll('#routineForm .invalid').forEach(node => {
    node.classList.remove('invalid');
    node.removeAttribute('aria-invalid');
  });
}

function showFieldErrors(errors) {
  clearFieldErrors();
  let firstInvalid = null;
  for (const [field, message] of Object.entries(errors)) {
    const inputId = FIELD_TO_INPUT[field];
    if (!inputId) continue;
    const input = maybe(inputId);
    const errorNode = maybe(inputId + 'Error');
    if (input) {
      input.classList.add('invalid');
      input.setAttribute('aria-invalid', 'true');
      if (!firstInvalid) firstInvalid = inputId;
    }
    if (errorNode) {
      errorNode.textContent = message;
      errorNode.style.display = 'block';
    }
  }
  if (firstInvalid) focus(firstInvalid);
}

/** Viikonpäivävalinta näytetään vain silloin kun se on merkityksellinen. */
function syncWeekdayVisibility() {
  const select = maybe('rfRecurrence');
  const group = maybe('rfWeekdayGroup');
  if (!select || !group) return;

  const type = select.value;
  const needsWeekdays = type === RECURRENCE.WEEKLY || type === RECURRENCE.CUSTOM_WEEKDAYS;
  group.style.display = needsWeekdays ? 'block' : 'none';

  const hint = maybe('rfWeekdayHint');
  if (hint) {
    hint.textContent = type === RECURRENCE.WEEKLY
      ? 'Valitse yksi päivä.'
      : 'Valitse vähintään yksi päivä.';
  }
}

function readWeekdays() {
  const checked = [...document.querySelectorAll('#rfWeekdays input[data-weekday]:checked')]
    .map(input => Number(input.value));
  return normalizeWeekdays(checked);
}

function writeWeekdays(weekdays) {
  const selected = new Set(weekdays || []);
  document.querySelectorAll('#rfWeekdays input[data-weekday]').forEach(input => {
    input.checked = selected.has(Number(input.value));
  });
}

/**
 * Lue lomake.
 *
 * @param {boolean} active Rutiinin nykyinen käytössäolo. Lomakkeessa ei ole
 *   kytkintä käytössäololle — se on listassa — joten muokkaus ei saa
 *   herättää pois kytkettyä rutiinia takaisin henkiin.
 */
function readForm(active) {
  const duration = el('rfDuration').value;
  const time = el('rfTime').value;
  return {
    title: el('rfTitle').value.trim(),
    description: el('rfDescription').value.trim() || null,
    recurrence: { type: el('rfRecurrence').value, weekdays: readWeekdays() },
    preferredTime: time || null,
    durationMinutes: duration ? Number(duration) : 30,
    category: el('rfCategory').value,
    priority: el('rfPriority').value,
    scheduling: el('rfFlexible').checked ? ROUTINE_SCHEDULING.FLEXIBLE : ROUTINE_SCHEDULING.FIXED,
    startDate: el('rfStartDate').value || null,
    endDate: el('rfEndDate').value || null,
    active
  };
}

function fillForm(routine) {
  el('rfTitle').value = routine ? routine.title : '';
  el('rfDescription').value = routine && routine.description ? routine.description : '';
  el('rfRecurrence').value = routine ? routine.recurrence.type : RECURRENCE.DAILY;
  writeWeekdays(routine ? routine.recurrence.weekdays : []);
  el('rfTime').value = routine && routine.preferredTime ? routine.preferredTime : '';
  el('rfDuration').value = routine ? String(routine.durationMinutes) : '30';
  el('rfCategory').value = routine ? routine.category : 'hyvinvointi';
  el('rfPriority').value = routine ? routine.priority : 'normaali';
  el('rfFlexible').checked = routine ? routine.scheduling === ROUTINE_SCHEDULING.FLEXIBLE : false;
  el('rfStartDate').value = routine && routine.startDate ? routine.startDate : '';
  el('rfEndDate').value = routine && routine.endDate ? routine.endDate : '';
  syncWeekdayVisibility();
  const energy = maybe('rfEnergy');
  if (energy) {
    const settings = routine ? itemSettingsFor('routine', routine.id) : null;
    energy.value = settings && settings.energyDemand ? String(settings.energyDemand) : '';
  }
}

/** Avaa lomake uuden rutiinin luomiseen. */
export function openNewRoutineForm() {
  setEditingRoutineId(null);
  fillForm(null);
  clearFieldErrors();
  setText('routineFormTitle', 'Uusi rutiini');
  el('rfSave').textContent = 'Tallenna';
  toggle('rfDelete', false);
  toggle('routineForm', true, 'flex');
  toggle('addRoutineBtn', false, 'flex');
  focus('rfTitle');
}

/** Avaa lomake olemassa olevan rutiinin muokkaukseen. */
export function openRoutineForm(id) {
  const routine = findRoutine(id);
  if (!routine) return;

  setEditingRoutineId(id);
  fillForm(routine);
  clearFieldErrors();
  setText('routineFormTitle', 'Muokkaa rutiinia');
  el('rfSave').textContent = 'Tallenna muutokset';
  toggle('rfDelete', true, 'block');
  toggle('routineForm', true, 'flex');
  toggle('addRoutineBtn', false, 'flex');
  el('routineForm').scrollIntoView({ behavior: 'smooth', block: 'center' });
  focus('rfTitle');
}

/** Sulje lomake. */
export function closeRoutineForm() {
  setEditingRoutineId(null);
  fillForm(null);
  clearFieldErrors();
  toggle('routineForm', false);
  toggle('addRoutineBtn', true, 'flex');
}

const submitRoutine = singleFlight(async () => {
  const saveButton = el('rfSave');
  const editing = findRoutine(getState().editingRoutineId);
  const input = readForm(editing ? editing.active : true);

  const candidate = normalizeRoutine({ ...input, id: getState().editingRoutineId || 'uusi' });
  const preflight = validateRoutine(candidate);
  if (!preflight.valid) {
    showFieldErrors(preflight.errors);
    return;
  }

  setBusy(saveButton, true, 'Tallennetaan…');
  try {
    const editingId = getState().editingRoutineId;
    const result = editingId
      ? await editRoutine(editingId, input)
      : await createRoutine(input);

    if (!result.ok) {
      if (result.errors) showFieldErrors(result.errors);
      return;
    }
    const savedId = editingId || (result.routine && result.routine.id);
    const energy = maybe('rfEnergy');
    if (savedId && energy) {
      await saveItemSettings('routine', savedId, { energyDemand: energy.value ? Number(energy.value) : null });
    }
    closeRoutineForm();
  } finally {
    setBusy(saveButton, false);
  }
});

const removeCurrentRoutine = singleFlight(async () => {
  const editingId = getState().editingRoutineId;
  if (!editingId) return;
  const removed = await deleteRoutine(editingId);
  if (removed) closeRoutineForm();
});

/** Kytke rutiinilomakkeen tapahtumat. Kutsutaan kerran käynnistyksessä. */
export function initRoutineForm() {
  populateRoutineSelects();

  el('addRoutineBtn').addEventListener('click', openNewRoutineForm);
  el('rfCancel').addEventListener('click', closeRoutineForm);
  el('rfSave').addEventListener('click', submitRoutine);
  el('rfDelete').addEventListener('click', removeCurrentRoutine);
  el('rfRecurrence').addEventListener('change', syncWeekdayVisibility);

  el('rfTitle').addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); submitRoutine(); }
  });
  el('routineForm').addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); closeRoutineForm(); }
  });

  // Joustava rutiini ei voi olla kiinteässä ajassa — kerrotaan se näkyvästi.
  const syncFlexible = () => {
    const hasTime = Boolean(el('rfTime').value);
    el('rfFlexible').disabled = !hasTime;
    if (!hasTime) el('rfFlexible').checked = true;
  };
  el('rfTime').addEventListener('change', syncFlexible);
  syncFlexible();
}
