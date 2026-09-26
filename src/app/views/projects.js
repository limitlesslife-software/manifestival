// Projektinäkymä.
//
// MIKSI TÄMÄ ON OLEMASSA
//
// Projekteilla oli kanta, RLS, repositorio ja koko domain-logiikka —
// mutta ei yhtään näkymää. Rivit ladattiin tilaan eikä niitä
// renderöity missään, eikä käyttäjä voinut luoda projektia. Portin
// avaaminen ei olisi antanut hänelle mitään.
//
// SIJAINTI: TAVOITTEET-VÄLILEHDEN TOINEN SEGMENTTI
//
// Projekti on tavoitteen ja tehtävän välissä: se on työn kehys, ei
// syy eikä yksittäinen teko. Sama suhde on jo mallinnettu kannassa
// (`projects.goal_id`), ja käyttöliittymässä se näkyy parhaiten
// tavoitteiden vieressä — ei omana välilehtenään, joka irrottaisi sen
// siitä mihin se kuuluu.
//
// Sama kaava kuin Tekeminen-välilehdellä (Tehtävät / Rutiinit), joten
// tämä ei ole uusi navigaatiokäsite vaan olemassa olevan toisto.

import { itemSettingsFor, saveItemSettings } from '../timeTracking.js';
import { openItemLog, startTimerFor } from './timeLog.js';
import { el, maybe, toggle, setText, focus } from '../../ui/dom.js';
import { escapeHtml } from '../../lib/format.js';
import {
  getState, findProject, findGoal, setEditingProjectId, setGoalsSegment
} from '../state.js';
import {
  PROJECT_STATUS, PROJECT_STATUSES, PROJECT_RISK, projectStatusLabel,
  summarizeProject, compareProjects, projectRiskLabel
} from '../../domain/project.js';
import { CATEGORIES, categoryLabel } from '../../domain/categories.js';
import { PRIORITIES, priorityLabel, priorityTone } from '../../domain/priority.js';
import { isOpenGoal, goalStatusLabel } from '../../domain/goal.js';
import { createProject, editProject, deleteProject } from '../actions.js';
import { fmtISO, parseISO, todayMidnight } from '../../lib/datetime.js';
import { formatShortDate } from '../../lib/format.js';

// ----------------------------------------------------------- valikot

let optionsReady = false;

/** Täytä valikot kerran. Sama tapa kuin tavoitelomakkeella. */
function fillSelectOptions() {
  if (optionsReady) return;

  const status = maybe('prfStatus');
  if (status) {
    status.innerHTML = PROJECT_STATUSES
      .map(value => `<option value="${escapeHtml(value)}">`
        + `${escapeHtml(projectStatusLabel(value))}</option>`).join('');
  }

  const category = maybe('prfCategory');
  if (category) {
    category.innerHTML = CATEGORIES
      .map(key => `<option value="${escapeHtml(key)}">`
        + `${escapeHtml(categoryLabel(key))}</option>`).join('');
  }

  const priority = maybe('prfPriority');
  if (priority) {
    priority.innerHTML = PRIORITIES
      .map(key => `<option value="${escapeHtml(key)}">`
        + `${escapeHtml(priorityLabel(key))}</option>`).join('');
  }

  optionsReady = true;
}

/**
 * Tavoitevalikko projektille.
 *
 * Valikossa on vain AVOIMIA tavoitteita. Jos projekti on liitetty
 * saavutettuun tai arkistoituun tavoitteeseen, vaihtoehto lisätään
 * takaisin — muuten tallennus katkaisisi linkin huomaamatta.
 *
 * TÄMÄ ON KÄYTTÖKOKEMUSTA, EI TURVAA. Valikko näyttää vain
 * kirjautuneen käyttäjän omat tavoitteet, koska tila sisältää vain
 * niitä. Varsinainen este on kannassa: yhdistelmävierasavain
 * `(user_id, goal_id) -> goals (user_id, id)` torjuu vieraan
 * tavoitteen, vaikka selain lähettäisi sellaisen.
 */
function refreshGoalPicker(selectedGoalId) {
  const picker = maybe('prfGoal');
  if (!picker) return;

  const goals = getState().goals.filter(isOpenGoal);
  picker.innerHTML = '<option value="">Ei tavoitetta</option>'
    + goals.map(goal => `<option value="${escapeHtml(goal.id)}">`
      + `${escapeHtml(goal.title)}</option>`).join('');

  picker.value = selectedGoalId || '';
  if (!selectedGoalId || picker.value === selectedGoalId) return;

  const goal = findGoal(selectedGoalId);
  if (!goal) return;

  picker.insertAdjacentHTML('beforeend',
    `<option value="${escapeHtml(goal.id)}">${escapeHtml(goal.title)}`
    + ` (${escapeHtml(goalStatusLabel(goal.status))})</option>`);
  picker.value = selectedGoalId;
}

// ------------------------------------------------------------ listaus

function renderList(container, state) {
  const todayIso = fmtISO(todayMidnight());
  const projects = [...state.projects].sort(compareProjects);

  if (projects.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-title">Ei vielä projekteja.</div>
        <p>Projekti on työn kehys: useampi tehtävä, yksi lopputulos.
        Tavoite kertoo miksi, projekti kertoo mitä.</p>
      </div>`;
    return;
  }

  container.innerHTML = projects.map(project => {
    const summary = summarizeProject(project, state.tasks, todayIso);
    const goal = project.goalId ? findGoal(project.goalId) : null;

    const priorityTag = project.priority && project.priority !== 'normaali'
      ? `<span class="prio-tag prio-${escapeHtml(priorityTone(project.priority))}">`
        + `${escapeHtml(priorityLabel(project.priority))}</span>`
      : '';

    // Riskimerkintä vain kun se kertoo jotain: myöhässä tai vaarassa.
    // "Aikataulussa" ja "päättynyt" eivät tarvitse omaa merkkiään.
    const risky = summary.risk === PROJECT_RISK.AT_RISK
      || summary.risk === PROJECT_RISK.OVERDUE;
    const riskTag = risky
      ? `<span class="prio-tag prio-clay">${escapeHtml(projectRiskLabel(summary.risk))}</span>`
      : '';

    const deadline = project.deadline
      ? `<span>Määräaika ${escapeHtml(formatShortDate(parseISO(project.deadline)))}</span>`
      : '';

    const goalLine = goal
      ? `<div class="t-sub">Tavoite: ${escapeHtml(goal.title)}</div>`
      : '';

    return `<div class="task-row">
      <button class="t-body t-open" data-edit-project="${escapeHtml(project.id)}"
              aria-label="Muokkaa projektia: ${escapeHtml(project.name)}">
        <div class="t-title">${escapeHtml(project.name)}${priorityTag}${riskTag}</div>
        <div class="t-meta">
          <span class="task-cat-tag">${escapeHtml(projectStatusLabel(project.status))}</span>
          <span>${summary.completed}/${summary.total} tehtävää</span>
          ${deadline}
        </div>
        ${goalLine}
        ${project.description ? `<div class="t-sub">${escapeHtml(project.description)}</div>` : ''}
      </button>
    </div>`;
  }).join('');

  container.querySelectorAll('[data-edit-project]').forEach(node =>
    node.addEventListener('click', () => openProjectForm(node.dataset.editProject)));
}

/** Renderöi projektinäkymä. */
export function renderProjects() {
  const container = maybe('projectsListContainer');
  if (!container) return;

  fillSelectOptions();
  renderList(container, getState());
  // OSION NÄYTTÄMINEN EI OLE TÄMÄN MODUULIN ASIA.
  //
  // Se oli aiemmin täällä, kun osioita oli kaksi. Kolmas osio
  // (Suunnittelu) teki kahdesta toteutuksesta ristiriitaisia: tämä
  // näytti tavoitelistan aina kun osio ei ollut "projects", myös
  // silloin kun se oli "plan".
  //
  // Nyt osiot omistaa `goals.js` yhdessä paikassa. Ks. syncGoalsSegment.
}

// ------------------------------------------------------------- lomake

const FIELD_TO_INPUT = {
  name: 'prfName',
  status: 'prfStatus',
  deadline: 'prfDeadline',
  startDate: 'prfStartDate'
};

function clearFieldErrors() {
  document.querySelectorAll('#projectForm .field-error').forEach(node => {
    node.textContent = '';
    node.style.display = 'none';
  });
  document.querySelectorAll('#projectForm .invalid').forEach(node => {
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

function readForm() {
  const goalPicker = maybe('prfGoal');
  return {
    name: el('prfName').value.trim(),
    description: el('prfDescription').value.trim() || null,
    goalId: goalPicker && goalPicker.value ? goalPicker.value : null,
    startDate: el('prfStartDate').value || null,
    deadline: el('prfDeadline').value || null,
    status: el('prfStatus').value,
    priority: el('prfPriority').value,
    category: el('prfCategory').value
  };
}

function fillForm(project) {
  fillSelectOptions();

  el('prfName').value = project ? project.name : '';
  el('prfDescription').value = project && project.description ? project.description : '';
  el('prfStartDate').value = project && project.startDate ? project.startDate : '';
  el('prfDeadline').value = project && project.deadline ? project.deadline : '';
  el('prfStatus').value = project ? project.status : PROJECT_STATUS.ACTIVE;
  el('prfPriority').value = project ? project.priority : 'normaali';
  el('prfCategory').value = project ? project.category : 'muu';

  refreshGoalPicker(project && project.goalId ? project.goalId : null);
  const energy = maybe('prfEnergy');
  if (energy) {
    const settings = project ? itemSettingsFor('project', project.id) : null;
    energy.value = settings && settings.energyDemand ? String(settings.energyDemand) : '';
  }
  toggle('prfTimeActions', Boolean(project), 'flex');
}

/** Avaa lomake uuden projektin lisäämiseen. */
export function openAddProjectForm() {
  setEditingProjectId(null);
  fillForm(null);
  clearFieldErrors();
  setText('projectFormTitle', 'Uusi projekti');
  el('prfSave').textContent = 'Tallenna';
  toggle('prfDelete', false);
  toggle('projectForm', true, 'flex');
  toggle('addProjectBtn', false, 'flex');
  focus('prfName');
}

/** Avaa lomake projektin muokkaukseen. */
export function openProjectForm(id) {
  const project = findProject(id);
  if (!project) return;

  setEditingProjectId(id);
  fillForm(project);
  clearFieldErrors();
  setText('projectFormTitle', 'Muokkaa projektia');
  el('prfSave').textContent = 'Tallenna';
  toggle('prfDelete', true, 'flex');
  toggle('projectForm', true, 'flex');
  toggle('addProjectBtn', false, 'flex');
  focus('prfName');
  el('projectForm').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

/** Sulje lomake. */
export function closeProjectForm() {
  setEditingProjectId(null);
  // Kentat tyhjennetaan, ei vain piiloteta. Uloskirjautuminen kutsuu
  // tata, eika seuraava kayttaja saa loytaa edellisen kirjoittamaa
  // tekstia lomakkeesta.
  fillForm(null);
  clearFieldErrors();
  toggle('projectForm', false);
  toggle('addProjectBtn', true, 'flex');
}

async function submitForm() {
  const input = readForm();
  const editingId = getState().editingProjectId;

  const result = editingId
    ? await editProject(editingId, input)
    : await createProject(input);
  const savedId = result && result.ok ? (editingId || (result.project && result.project.id)) : null;
  const energy = maybe('prfEnergy');
  if (savedId && energy) {
    await saveItemSettings('project', savedId, { energyDemand: energy.value ? Number(energy.value) : null });
  }

  // VAIN onnistuminen sulkee lomakkeen. Jos tallennus epäonnistui,
  // käyttäjän kirjoittama teksti jää näkyviin — muuten se katoaisi
  // yhdessä sen tiedon kanssa, ettei sitä tallennettu.
  if (!result || !result.ok) {
    if (result && result.errors) showFieldErrors(result.errors);
    return;
  }
  closeProjectForm();
}

async function removeCurrent() {
  const id = getState().editingProjectId;
  if (!id) return;
  const removed = await deleteProject(id);
  if (removed) closeProjectForm();
}

/** Kytke projektilomakkeen tapahtumat. Kutsutaan kerran. */
export function initProjectForm() {
  // Osiovälilehtien kytkennät ovat `goals.js`:ssä — yksi paikka, jotta
  // kaksi kuuntelijaa ei taistele samasta painikkeesta.
  const addButton = maybe('addProjectBtn');
  if (!addButton) return;

  addButton.addEventListener('click', openAddProjectForm);
  el('prfCancel').addEventListener('click', closeProjectForm);
  el('prfSave').addEventListener('click', submitForm);
  el('prfDelete').addEventListener('click', removeCurrent);
  const logButton = maybe('prfLogTime');
  if (logButton) {
    logButton.addEventListener('click', () => {
      const id = getState().editingProjectId;
      if (id) openItemLog('project', id);
    });
  }
  const timerButton = maybe('prfStartTimer');
  if (timerButton) {
    timerButton.addEventListener('click', () => {
      const id = getState().editingProjectId;
      if (id) startTimerFor({ kind: 'project', id });
    });
  }

  el('prfName').addEventListener('keydown', event => {
    if (event.key === 'Enter') submitForm();
  });
  el('projectForm').addEventListener('keydown', event => {
    if (event.key === 'Escape') closeProjectForm();
  });
}
