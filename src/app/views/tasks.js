// Tehtävänäkymä: koko lista sekä lisäys- ja muokkauslomake.

import { fmtISO, todayMidnight } from '../../lib/datetime.js';
import { escapeHtml, formatTimeRange, formatDuration } from '../../lib/format.js';
import { CATEGORIES, categoryLabel } from '../../domain/categories.js';
import { PRIORITIES, priorityLabel, priorityTone } from '../../domain/priority.js';
import { durationOf, validateTask, normalizeTask } from '../../domain/task.js';
import { groupByDate, dayGroupLabel } from '../../domain/week.js';
import { goalStatusLabel } from '../../domain/goal.js';
import { el, maybe, setText, toggle, setBusy, singleFlight, focus } from '../../ui/dom.js';
import { getState, findTask, findGoal, setEditingId, setTasksSegment } from '../state.js';
import { createTask, editTask, toggleComplete, deleteTask } from '../actions.js';
import { switchTab } from '../navigation.js';
import { renderRoutines } from './routines.js';
import { renderInbox } from './inbox.js';
import { renderReminders } from './reminders.js';
import { renderTravel } from './travel.js';

/**
 * Osion painike ja lohko.
 *
 * TAULUKKO ON NIMENOMAINEN eika johdettu. Jokainen osio on paatos, ja
 * paatos nakyy tassa yhtena rivina -- ei ehtolauseiden verkostona.
 */
const SEGMENT_NODES = Object.freeze([
  { key: 'tasks', tab: 'segmentTasks', section: 'tasksSection' },
  { key: 'routines', tab: 'segmentRoutines', section: 'routinesSection' },
  { key: 'inbox', tab: 'segmentInbox', section: 'inboxSection' },
  { key: 'reminders', tab: 'segmentReminders', section: 'remindersSection' },
  { key: 'travel', tab: 'segmentTravel', section: 'travelSection' }
]);


/** Täytä valikot domainista, jottei listoja tarvitse ylläpitää kahdessa paikassa. */
export function populateSelects() {
  const categoryOptions = CATEGORIES
    .map(c => `<option value="${c.key}">${escapeHtml(c.label)}</option>`).join('');
  const priorityOptions = PRIORITIES
    .map(p => `<option value="${p.key}">${escapeHtml(p.label)}</option>`).join('');

  for (const id of ['afCategory', 'vfCategory']) {
    const node = maybe(id);
    if (node) node.innerHTML = categoryOptions;
  }
  for (const id of ['afPriority', 'vfPriority']) {
    const node = maybe(id);
    if (node) node.innerHTML = priorityOptions;
  }
}

// ------------------------------------------------------------------- lista

function renderList(container, tasks) {
  if (tasks.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-title">Ei vielä yhtään tehtävää.</div>
        <p>Sano se ääneen mikrofonipainikkeella tai kirjoita se yllä.</p>
      </div>`;
    return;
  }

  const groups = groupByDate(tasks);
  let html = '';

  for (const [dateIso, group] of groups) {
    const done = group.filter(t => t.completed).length;
    html += `<div class="date-group-label">
      ${escapeHtml(dayGroupLabel(dateIso))}
      <span class="group-count">${done}/${group.length}</span>
    </div>`;

    html += group.map(task => {
      const timeLabel = formatTimeRange(task.time, task.endTime);
      const duration = !task.time ? formatDuration(durationOf(task)) : null;
      const priorityTag = task.priority && task.priority !== 'normaali'
        ? `<span class="prio-tag prio-${priorityTone(task.priority)}">${escapeHtml(priorityLabel(task.priority))}</span>`
        : '';

      return `<div class="task-row ${task.completed ? 'done' : ''}">
        <button class="chk ${task.completed ? 'done' : ''}" data-toggle="${escapeHtml(task.id)}"
                aria-pressed="${task.completed ? 'true' : 'false'}"
                aria-label="${task.completed ? 'Merkitse keskeneräiseksi' : 'Merkitse tehdyksi'}: ${escapeHtml(task.title)}">
          <svg aria-hidden="true"><use href="#i-check"/></svg>
        </button>
        <button class="t-body t-open" data-edit="${escapeHtml(task.id)}" aria-label="Muokkaa: ${escapeHtml(task.title)}">
          <div class="t-title">${task.isWake ? '☀ ' : ''}${escapeHtml(task.title)}${priorityTag}</div>
          <div class="t-meta">
            ${timeLabel ? `<span>${escapeHtml(timeLabel)}</span>` : '<span class="muted">ei aikaa</span>'}
            ${duration ? `<span>${escapeHtml(duration)}</span>` : ''}
            <span class="task-cat-tag">${escapeHtml(categoryLabel(task.category))}</span>
          </div>
          ${task.description ? `<div class="t-sub">${escapeHtml(task.description)}</div>` : ''}
        </button>
        <button class="task-del" data-del="${escapeHtml(task.id)}" aria-label="Poista: ${escapeHtml(task.title)}">
          <svg class="icon" aria-hidden="true"><use href="#i-trash"/></svg>
        </button>
      </div>`;
    }).join('');
  }

  container.innerHTML = html;

  container.querySelectorAll('[data-toggle]').forEach(node =>
    node.addEventListener('click', () => toggleComplete(node.dataset.toggle)));
  container.querySelectorAll('[data-edit]').forEach(node =>
    node.addEventListener('click', () => openEditForm(node.dataset.edit)));
  container.querySelectorAll('[data-del]').forEach(node =>
    node.addEventListener('click', event => {
      event.stopPropagation();
      deleteTask(node.dataset.del);
    }));
}

/**
 * Renderöi tehtävänäkymä.
 *
 * Näkymässä on kaksi osiota: kertaluonteiset tehtävät ja toistuvat rutiinit.
 * Molemmat ovat "asioita jotka pitää tehdä", joten ne kuuluvat samaan
 * näkymään — mutta ne ovat eri käsitteitä, joten ne eivät sekoitu listassa.
 */
export function renderTasks() {
  const state = getState();
  const segment = state.tasksSegment;

  // Osiovalitsimen tila. Kartta on nimenomainen: osio, jolta puuttuu
  // painike tai lohko, ei nayttaisi mitaan eika kertoisi miksi.
  for (const { key, tab, section } of SEGMENT_NODES) {
    const active = segment === key;

    const button = maybe(tab);
    if (button) {
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', String(active));
    }
    toggle(section, active);
  }

  if (segment === 'routines') renderRoutines();
  else if (segment === 'inbox') renderInbox();
  else if (segment === 'reminders') renderReminders();
  else if (segment === 'travel') renderTravel();
  else renderList(el('tasksListContainer'), state.tasks);
}

// ----------------------------------------------------------------- lomake

function clearFieldErrors() {
  document.querySelectorAll('#addForm .field-error').forEach(node => {
    node.textContent = '';
    node.style.display = 'none';
  });
  document.querySelectorAll('#addForm .invalid').forEach(node => {
    node.classList.remove('invalid');
    node.removeAttribute('aria-invalid');
  });
}

const FIELD_TO_INPUT = {
  title: 'afTitle',
  date: 'afDate',
  time: 'afTime',
  endTime: 'afEndTime',
  durationMinutes: 'afDuration',
  description: 'afDescription',
  deadline: 'afDeadline'
};

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

function readForm() {
  const durationRaw = el('afDuration').value;
  const goalPicker = maybe('afGoal');
  return {
    title: el('afTitle').value.trim(),
    description: el('afDescription').value.trim() || null,
    date: el('afDate').value || fmtISO(todayMidnight()),
    time: el('afTime').value || null,
    endTime: el('afEndTime').value || null,
    // Määräaika on eri asia kuin aikataulutus: se kertoo milloin asian on
    // oltava valmis, ei milloin sitä tehdään.
    deadline: el('afDeadline').value || null,
    durationMinutes: durationRaw ? Number(durationRaw) : null,
    category: el('afCategory').value,
    priority: el('afPriority').value,
    goalId: goalPicker && goalPicker.value ? goalPicker.value : null,
    isWake: el('afIsWake').checked
  };
}

/**
 * Pidä kestokenttä ja aikaväli yhtä mieltä.
 *
 * MITÄ TÄSSÄ OLI VIKANA
 *
 * Kenttä HIMMENNETTIIN kun alku- ja loppuaika olivat molemmat annettu,
 * ja työkaluvihje lupasi että "kesto lasketaan alku- ja loppuajasta".
 * Laskettua arvoa ei kuitenkaan koskaan kirjoitettu kenttään, joten
 * himmennettyyn kenttään jäi näkyviin sen paikkamerkki — luku 30.
 *
 * Käyttäjä antoi 01:00 ja 02:00, ja kenttä näytti 30. Lupaus ja
 * näkymä olivat eri mieltä, ja väärässä oli se joka näkyi.
 *
 * Nyt kenttä saa laskettuja arvon. Himmennys ja vihje kertovat MIKSI
 * sitä ei voi muokata, ja luku kertoo mikä se on.
 */
function syncDurationField() {
  const time = el('afTime').value;
  const endTime = el('afEndTime').value;
  const input = el('afDuration');
  const hasRange = Boolean(time && endTime);

  input.disabled = hasRange;
  input.title = hasRange
    ? 'Kesto lasketaan alku- ja loppuajasta'
    : 'Kesto minuutteina, jos tarkkaa kellonaikaa ei ole';

  // Väli on tosiasia, kestokenttä on arvio. Kun väli on olemassa,
  // kenttä näyttää välin — ei omaa vanhaa arvoaan.
  if (hasRange) {
    const derived = durationOf({ time, endTime });
    input.value = derived ? String(derived) : '';
  }
}

function fillForm(task) {
  el('afTitle').value = task ? task.title : '';
  el('afDescription').value = task && task.description ? task.description : '';
  el('afDate').value = task ? task.date : fmtISO(todayMidnight());
  el('afTime').value = task && task.time ? task.time : '';
  el('afEndTime').value = task && task.endTime ? task.endTime : '';
  el('afDeadline').value = task && task.deadline ? task.deadline : '';
  el('afDuration').value = task && task.durationMinutes ? String(task.durationMinutes) : '';
  el('afCategory').value = task ? task.category : 'muu';
  el('afPriority').value = task ? task.priority : 'normaali';
  el('afIsWake').checked = Boolean(task && task.isWake);

  // Kestokenttä johdetaan väleistä VASTA kun molemmat ajat on asetettu
  // yllä. Ilman tätä kutsua avattu lomake näyttäisi vanhan arvon tai
  // paikkamerkin, vaikka väli kertoisi muuta.
  syncDurationField();

  selectGoal(task && task.goalId ? task.goalId : null);
}

/**
 * Aseta tavoitevalikon arvo.
 *
 * Valikossa on vain avoimia tavoitteita. Jos tehtävä on liitetty
 * saavutettuun tai arkistoituun tavoitteeseen, vaihtoehto lisätään takaisin
 * — muuten tallennus katkaisisi linkin huomaamatta.
 */
function selectGoal(goalId) {
  const picker = maybe('afGoal');
  if (!picker) return;

  picker.value = goalId || '';
  if (!goalId || picker.value === goalId) return;

  const goal = findGoal(goalId);
  if (!goal) return;

  picker.insertAdjacentHTML('beforeend',
    `<option value="${escapeHtml(goal.id)}">${escapeHtml(goal.title)}`
    + ` (${escapeHtml(goalStatusLabel(goal.status))})</option>`);
  picker.value = goalId;
}

/** Avaa lomake uuden tehtävän lisäämiseen. */
export function openAddForm() {
  setEditingId(null);
  fillForm(null);
  clearFieldErrors();
  setText('addFormTitle', 'Uusi tehtävä');
  el('afSave').textContent = 'Tallenna';
  toggle('afDelete', false);
  toggle('addForm', true, 'flex');
  toggle('addRowBtn', false, 'flex');
  focus('afTitle');
}

/** Avaa lomake olemassa olevan tehtävän muokkaukseen. */
export function openEditForm(id) {
  const task = findTask(id);
  if (!task) return;

  setEditingId(id);
  fillForm(task);
  clearFieldErrors();
  setText('addFormTitle', 'Muokkaa tehtävää');
  el('afSave').textContent = 'Tallenna muutokset';
  toggle('afDelete', true, 'block');
  toggle('addForm', true, 'flex');
  toggle('addRowBtn', false, 'flex');

  switchTab('screen-tasks');
  el('addForm').scrollIntoView({ behavior: 'smooth', block: 'center' });
  focus('afTitle');
}

/** Sulje lomake ja tyhjennä se. */
export function closeForm() {
  setEditingId(null);
  fillForm(null);
  clearFieldErrors();
  toggle('addForm', false);
  toggle('addRowBtn', true, 'flex');
}

// singleFlight estää tuplaklikkauksen: kaksi peräkkäistä painallusta ei voi
// luoda kahta tehtävää eikä lähettää kahta kirjoitusta.
const submitForm = singleFlight(async () => {
  const saveButton = el('afSave');
  const input = readForm();

  // Esitarkistus ennen verkkokutsua: virheet näkyvät heti.
  const candidate = normalizeTask({ ...input, id: getState().editingId || 'uusi' });
  const preflight = validateTask(candidate);
  if (!preflight.valid) {
    showFieldErrors(preflight.errors);
    return;
  }

  setBusy(saveButton, true, 'Tallennetaan…');
  try {
    const editingId = getState().editingId;
    const result = editingId
      ? await editTask(editingId, input)
      : await createTask(input);

    if (!result.ok) {
      if (result.errors) showFieldErrors(result.errors);
      return;
    }
    closeForm();
  } finally {
    setBusy(saveButton, false);
  }
});

const removeCurrent = singleFlight(async () => {
  const editingId = getState().editingId;
  if (!editingId) return;
  const removed = await deleteTask(editingId);
  if (removed) closeForm();
});

/** Kytke lomakkeen tapahtumat. Kutsutaan kerran käynnistyksessä. */
export function initTaskForm() {
  populateSelects();

  for (const { key, tab } of SEGMENT_NODES) {
    const button = maybe(tab);
    if (button) button.addEventListener('click', () => setTasksSegment(key));
  }

  el('addRowBtn').addEventListener('click', openAddForm);
  el('afCancel').addEventListener('click', closeForm);
  el('afSave').addEventListener('click', submitForm);
  el('afDelete').addEventListener('click', removeCurrent);

  // Enter otsikkokentässä tallentaa; Esc sulkee lomakkeen.
  el('afTitle').addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); submitForm(); }
  });
  el('addForm').addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); closeForm(); }
  });

  // Alkuaika tekee kestokentästä tarpeettoman ja päinvastoin. Kenttä
  // himmennetään JA sen arvo johdetaan välistä; ks. syncDurationField.
  //
  // `input` eikä pelkkä `change`: aikakentän arvo muuttuu myös
  // nuolinäppäimillä ja kelloikkunasta, eikä change laukea kaikissa
  // selaimissa ennen kuin kenttä menettää kohdistuksen. Käyttäjä ehtisi
  // siis nähdä vanhan luvun juuri siinä hetkessä, jossa hän tarkistaa
  // sen.
  for (const id of ['afTime', 'afEndTime']) {
    el(id).addEventListener('change', syncDurationField);
    el(id).addEventListener('input', syncDurationField);
  }
  syncDurationField();
}
