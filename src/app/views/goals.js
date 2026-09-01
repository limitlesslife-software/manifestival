// Tavoitenäkymä.
//
// Tavoite ilman näkyvää edistymistä on toivelista. Siksi jokainen tavoite
// näyttää suoraan: montako tehtävää on tehty, montako on jäljellä ja mikä
// niistä on seuraavaksi.

import { fmtISO, todayMidnight } from '../../lib/datetime.js';
import { escapeHtml } from '../../lib/format.js';
import { CATEGORIES, categoryLabel } from '../../domain/categories.js';
import { PRIORITIES, priorityLabel, priorityTone } from '../../domain/priority.js';
import {
  GOAL_STATUS, PROGRESS_MODE, goalStatusLabel,
  summarizeGoals, normalizeGoal, validateGoal
} from '../../domain/goal.js';
import { compareForDay } from '../../domain/task.js';
import { dayGroupLabel } from '../../domain/week.js';
import { el, maybe, setText, toggle, setBusy, singleFlight, focus } from '../../ui/dom.js';
import { getState, findGoal, setEditingGoalId } from '../state.js';
import { createGoal, editGoal, deleteGoal, setGoalStatus, toggleComplete } from '../actions.js';
import { openEditForm } from './tasks.js';

const STATUS_ORDER = [
  GOAL_STATUS.ACTIVE, GOAL_STATUS.PAUSED, GOAL_STATUS.COMPLETED, GOAL_STATUS.ARCHIVED
];

/** Täytä valikot domainista. */
export function populateGoalSelects() {
  const status = maybe('gfStatus');
  if (status) {
    status.innerHTML = STATUS_ORDER
      .map(key => `<option value="${escapeHtml(key)}">${escapeHtml(goalStatusLabel(key))}</option>`)
      .join('');
  }

  const category = maybe('gfCategory');
  if (category) {
    category.innerHTML = CATEGORIES
      .map(c => `<option value="${escapeHtml(c.key)}">${escapeHtml(c.label)}</option>`).join('');
  }

  const priority = maybe('gfPriority');
  if (priority) {
    priority.innerHTML = PRIORITIES
      .map(p => `<option value="${escapeHtml(p.key)}">${escapeHtml(p.label)}</option>`).join('');
  }

  const mode = maybe('gfProgressMode');
  if (mode) {
    mode.innerHTML = `
      <option value="${PROGRESS_MODE.TASK_BASED}">Tehtävistä laskettu</option>
      <option value="${PROGRESS_MODE.MANUAL}">Itse arvioitu</option>`;
  }

  // Tehtävälomakkeen tavoitevalinta täytetään nykyisestä tilasta.
  refreshGoalPicker();
}

/** Päivitä tehtävälomakkeen tavoitevalikko. */
export function refreshGoalPicker() {
  const picker = maybe('afGoal');
  if (!picker) return;

  const open = getState().goals
    .filter(goal => goal.status === GOAL_STATUS.ACTIVE || goal.status === GOAL_STATUS.PAUSED)
    .sort((a, b) => String(a.title).localeCompare(String(b.title), 'fi'));

  const previous = picker.value;
  picker.innerHTML = '<option value="">Ei tavoitetta</option>'
    + open.map(goal => `<option value="${escapeHtml(goal.id)}">${escapeHtml(goal.title)}</option>`).join('');

  // Valikossa on vain avoimia tavoitteita, mutta tehtävä voi olla liitetty
  // saavutettuun tai arkistoituun. Sellainen lisätään takaisin valikkoon,
  // koska muuten lomakkeen tallennus katkaisisi linkin huomaamatta.
  if (previous && !open.some(goal => goal.id === previous)) {
    const archived = findGoal(previous);
    if (archived) {
      picker.insertAdjacentHTML('beforeend',
        `<option value="${escapeHtml(archived.id)}">${escapeHtml(archived.title)}`
        + ` (${escapeHtml(goalStatusLabel(archived.status))})</option>`);
    }
  }
  // Arvon asetus vain jos vaihtoehto todella on olemassa — muuten
  // selain nollaisi valinnan ensimmäiseen vaihtoehtoon.
  if (previous && [...picker.options].some(option => option.value === previous)) {
    picker.value = previous;
  }
}

// ------------------------------------------------------------------ lista

function progressBar(progress) {
  const percent = Math.max(0, Math.min(100, progress.percent));
  const tone = percent >= 100 ? 'done' : percent >= 50 ? 'good' : 'start';
  return `
    <div class="progress" role="img" aria-label="Edistyminen ${percent} prosenttia">
      <div class="progress-fill ${tone}" style="width:${percent}%"></div>
    </div>`;
}

function renderGoalCard(entry) {
  const { goal, progress, overdue, daysLeft, openTasks, completedTasks } = entry;

  const priorityTag = goal.priority && goal.priority !== 'normaali'
    ? `<span class="prio-tag prio-${priorityTone(goal.priority)}">${escapeHtml(priorityLabel(goal.priority))}</span>`
    : '';

  const targetLabel = goal.targetDate
    ? (overdue
      ? `<span class="goal-late">Tavoitepäivä ohitettu ${escapeHtml(goal.targetDate)}</span>`
      : `<span>${escapeHtml(dayGroupLabel(goal.targetDate))}${daysLeft != null && daysLeft >= 0 ? ` · ${daysLeft} pv` : ''}</span>`)
    : '<span class="muted">Ei tavoitepäivää</span>';

  const next = [...openTasks].sort(compareForDay)[0] || null;

  const taskList = openTasks.length
    ? `<div class="goal-tasks">
        ${openTasks.slice(0, 4).map(task => `
          <div class="goal-task">
            <button class="chk" data-toggle="${escapeHtml(task.id)}"
                    aria-label="Merkitse tehdyksi: ${escapeHtml(task.title)}">
              <svg aria-hidden="true"><use href="#i-check"/></svg>
            </button>
            <button class="t-open goal-task-title" data-edit="${escapeHtml(task.id)}"
                    aria-label="Muokkaa: ${escapeHtml(task.title)}">
              ${escapeHtml(task.title)}
              ${task.date ? `<span class="muted"> · ${escapeHtml(dayGroupLabel(task.date))}</span>` : ''}
            </button>
          </div>`).join('')}
        ${openTasks.length > 4 ? `<div class="hint">+ ${openTasks.length - 4} muuta</div>` : ''}
      </div>`
    : '<div class="hint">Ei liitettyjä avoimia tehtäviä. Lisää tehtävä ja valitse tämä tavoite.</div>';

  return `<div class="goal-card ${overdue ? 'late' : ''} status-${escapeHtml(goal.status)}">
    <button class="t-open goal-header" data-edit-goal="${escapeHtml(goal.id)}"
            aria-label="Muokkaa tavoitetta: ${escapeHtml(goal.title)}">
      <div class="goal-title">${escapeHtml(goal.title)}${priorityTag}</div>
      <div class="goal-meta">
        <span class="task-cat-tag">${escapeHtml(categoryLabel(goal.category))}</span>
        ${targetLabel}
        <span class="goal-status">${escapeHtml(goalStatusLabel(goal.status))}</span>
      </div>
    </button>

    ${progressBar(progress)}
    <div class="goal-progress-text">
      <strong>${progress.percent} %</strong>
      ${progress.derived
        ? `<span class="muted">${progress.completed}/${progress.total} tehtävää</span>`
        : '<span class="muted">itse arvioitu</span>'}
      ${next ? `<span class="goal-next">Seuraavaksi: ${escapeHtml(next.title)}</span>` : ''}
    </div>

    ${goal.description ? `<div class="t-sub">${escapeHtml(goal.description)}</div>` : ''}
    ${taskList}
    ${completedTasks.length ? `<div class="hint">${completedTasks.length} tehtävää valmiina</div>` : ''}
    ${goal.status === GOAL_STATUS.ACTIVE || goal.status === GOAL_STATUS.PAUSED
      ? `<button class="ghost-btn small goal-complete" data-complete-goal="${escapeHtml(goal.id)}">
           Merkitse saavutetuksi</button>`
      : ''}
  </div>`;
}

function renderList(container, state) {
  const todayIso = fmtISO(todayMidnight());
  const summary = summarizeGoals(state.goals, state.tasks, todayIso);

  if (summary.all.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-title">Ei vielä tavoitteita.</div>
        <p>Tavoite kertoo miksi teet sitä mitä teet. Kun liität tehtäviä
        tavoitteeseen, näet edistymisen ilman että sitä tarvitsee arvailla.</p>
      </div>`;
    return;
  }

  let html = '';

  if (summary.overdueCount > 0) {
    html += `<div class="notice">${summary.overdueCount} tavoitteen tavoitepäivä on ohitettu.</div>`;
  }

  const sections = [
    { title: 'Työn alla', entries: summary.active },
    { title: 'Tauolla', entries: summary.paused },
    { title: 'Saavutetut', entries: summary.completed },
    { title: 'Arkistoidut', entries: summary.archived }
  ];

  for (const section of sections) {
    if (section.entries.length === 0) continue;
    html += `<h2 class="section-title">${escapeHtml(section.title)}
      <span class="count-badge">${section.entries.length}</span></h2>`;
    html += section.entries.map(renderGoalCard).join('');
  }

  container.innerHTML = html;

  container.querySelectorAll('[data-edit-goal]').forEach(node =>
    node.addEventListener('click', () => openGoalForm(node.dataset.editGoal)));
  container.querySelectorAll('[data-toggle]').forEach(node =>
    node.addEventListener('click', () => toggleComplete(node.dataset.toggle)));
  container.querySelectorAll('[data-edit]').forEach(node =>
    node.addEventListener('click', () => openEditForm(node.dataset.edit)));
  container.querySelectorAll('[data-complete-goal]').forEach(node =>
    node.addEventListener('click', () => completeGoal(node.dataset.completeGoal)));
}

/** Renderöi tavoitenäkymä. */
export function renderGoals() {
  const container = maybe('goalsListContainer');
  if (!container) return;
  renderList(container, getState());
  refreshGoalPicker();
  syncProgressMode();
}

// ----------------------------------------------------------------- lomake

const FIELD_TO_INPUT = {
  title: 'gfTitle',
  targetDate: 'gfTargetDate',
  manualProgress: 'gfManualProgress',
  status: 'gfStatus',
  progressMode: 'gfProgressMode'
};

function clearFieldErrors() {
  document.querySelectorAll('#goalForm .field-error').forEach(node => {
    node.textContent = '';
    node.style.display = 'none';
  });
  document.querySelectorAll('#goalForm .invalid').forEach(node => {
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

/** Manuaalinen prosentti näytetään vain kun se on käytössä. */
function syncProgressMode() {
  const select = maybe('gfProgressMode');
  const group = maybe('gfManualGroup');
  if (!select || !group) return;
  group.style.display = select.value === PROGRESS_MODE.MANUAL ? 'block' : 'none';
}

function readForm() {
  const manual = el('gfManualProgress').value;
  return {
    title: el('gfTitle').value.trim(),
    description: el('gfDescription').value.trim() || null,
    category: el('gfCategory').value,
    priority: el('gfPriority').value,
    status: el('gfStatus').value,
    targetDate: el('gfTargetDate').value || null,
    progressMode: el('gfProgressMode').value,
    manualProgress: manual ? Number(manual) : 0
  };
}

function fillForm(goal) {
  el('gfTitle').value = goal ? goal.title : '';
  el('gfDescription').value = goal && goal.description ? goal.description : '';
  el('gfCategory').value = goal ? goal.category : 'kehitys';
  el('gfPriority').value = goal ? goal.priority : 'normaali';
  el('gfStatus').value = goal ? goal.status : GOAL_STATUS.ACTIVE;
  el('gfTargetDate').value = goal && goal.targetDate ? goal.targetDate : '';
  el('gfProgressMode').value = goal ? goal.progressMode : PROGRESS_MODE.TASK_BASED;
  el('gfManualProgress').value = goal ? String(goal.manualProgress) : '0';
  syncProgressMode();
}

export function openNewGoalForm() {
  setEditingGoalId(null);
  fillForm(null);
  clearFieldErrors();
  setText('goalFormTitle', 'Uusi tavoite');
  el('gfSave').textContent = 'Tallenna';
  toggle('gfDelete', false);
  toggle('goalForm', true, 'flex');
  toggle('addGoalBtn', false, 'flex');
  focus('gfTitle');
}

export function openGoalForm(id) {
  const goal = findGoal(id);
  if (!goal) return;

  setEditingGoalId(id);
  fillForm(goal);
  clearFieldErrors();
  setText('goalFormTitle', 'Muokkaa tavoitetta');
  el('gfSave').textContent = 'Tallenna muutokset';
  toggle('gfDelete', true, 'block');
  toggle('goalForm', true, 'flex');
  toggle('addGoalBtn', false, 'flex');
  el('goalForm').scrollIntoView({ behavior: 'smooth', block: 'center' });
  focus('gfTitle');
}

export function closeGoalForm() {
  setEditingGoalId(null);
  fillForm(null);
  clearFieldErrors();
  toggle('goalForm', false);
  toggle('addGoalBtn', true, 'flex');
}

const submitGoal = singleFlight(async () => {
  const saveButton = el('gfSave');
  const input = readForm();

  const candidate = normalizeGoal({ ...input, id: getState().editingGoalId || 'uusi' });
  const preflight = validateGoal(candidate);
  if (!preflight.valid) {
    showFieldErrors(preflight.errors);
    return;
  }

  setBusy(saveButton, true, 'Tallennetaan…');
  try {
    const editingId = getState().editingGoalId;
    const result = editingId
      ? await editGoal(editingId, input)
      : await createGoal(input);

    if (!result.ok) {
      if (result.errors) showFieldErrors(result.errors);
      return;
    }
    closeGoalForm();
  } finally {
    setBusy(saveButton, false);
  }
});

const removeCurrentGoal = singleFlight(async () => {
  const editingId = getState().editingGoalId;
  if (!editingId) return;
  const removed = await deleteGoal(editingId);
  if (removed) closeGoalForm();
});

/** Kytke tavoitelomakkeen tapahtumat. */
export function initGoalForm() {
  populateGoalSelects();

  el('addGoalBtn').addEventListener('click', openNewGoalForm);
  el('gfCancel').addEventListener('click', closeGoalForm);
  el('gfSave').addEventListener('click', submitGoal);
  el('gfDelete').addEventListener('click', removeCurrentGoal);
  el('gfProgressMode').addEventListener('change', syncProgressMode);

  el('gfTitle').addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); submitGoal(); }
  });
  el('goalForm').addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); closeGoalForm(); }
  });
}

/**
 * Merkitse tavoite saavutetuksi.
 *
 * Pikatoiminto: tila on muutettavissa myös lomakkeelta, mutta tavoitteen
 * saavuttaminen on liian harvinainen ja liian palkitseva hetki
 * piilotettavaksi valikon taakse.
 */
async function completeGoal(id) {
  return setGoalStatus(id, GOAL_STATUS.COMPLETED);
}

