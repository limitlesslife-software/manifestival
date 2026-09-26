// Tavoitteen yksityiskohdat.
//
// =====================================================================
// YKSI NÄKYMÄ, JOKA VASTAA VIITEEN KYSYMYKSEEN
// =====================================================================
//
//   Missä mennään?        edistyminen, nimetty strategia
//   Ehdinkö?              ennuste ja sen LAATU
//   Mikä on seuraavaksi?  seuraava välitavoite, seuraavat tehtävät
//   Mikä on vialla?       ristiriidat vakavuusjärjestyksessä
//   Mitä voin tehdä?      korjaavat toimet ehdotuksina
//
// =====================================================================
// TUNTEMATON SANOTAAN ÄÄNEEN
// =====================================================================
//
// Tavoite ilman tehtäviä, välitavoitteita ja mittaria ei ole 0 %
// valmis. Sen edistymistä ei tiedetä, ja näkymä sanoo sen — nolla
// väittäisi, ettei mitään ole tapahtunut.
//
// Sama koskee ennustetta: määräpäivätön tavoite ei ole aikataulussa
// vaan määräpäivätön.

import { el, maybe, toggle, setText, focus } from '../../ui/dom.js';
import { escapeHtml, formatShortDate } from '../../lib/format.js';
import {
  getState, findGoal, findMilestone, setOpenGoalId, setEditingMilestoneId, findLifeArea
} from '../state.js';
import { goalStatusLabel, tasksForGoal, projectsForGoal } from '../../domain/goal.js';
import {
  MILESTONE_STATUS, milestonesForGoal, milestoneStatusLabel, nextMilestone,
  isMilestoneOverdue
} from '../../domain/milestone.js';
import { computeProgress, progressStrategyLabel } from '../../domain/goalProgress.js';
import { normalizeTarget, describeTarget, hasTarget } from '../../domain/goalTarget.js';
import { remainingWork, capacityUntil } from '../../domain/capacity.js';
import {
  forecastGoal, forecastLabel, forecastQualityLabel, suggestCorrections, FORECAST
} from '../../domain/forecast.js';
import { detectAllConflicts, SEVERITY } from '../../domain/conflicts.js';
import { summarizeSavingsGoal } from '../../domain/finance.js';
import {
  createMilestone, editMilestone, deleteMilestone, setMilestoneReached,
  moveMilestone
} from '../actions.js';
import { fmtISO, parseISO, todayMidnight } from '../../lib/datetime.js';

// ------------------------------------------------------------- renderöi

/** Renderöi tavoitteen yksityiskohdat. */
export function renderGoalDetail() {
  const container = maybe('goalDetailContainer');
  if (!container) return;

  const state = getState();
  const goal = findGoal(state.openGoalId);

  if (!goal) {
    container.innerHTML = '';
    return;
  }

  const todayIso = fmtISO(todayMidnight());
  const tasks = tasksForGoal(state.tasks, goal.id);
  const projects = projectsForGoal(state.projects, goal.id);
  const milestones = milestonesForGoal(state.milestones, goal.id);

  // RAHATAVOITE LASKETAAN TALOUDESSA. Jos tavoite on kytketty
  // säästötavoitteeseen, sen luku tulee sieltä eikä täältä — kahta
  // toteutusta samasta kaavasta ei ole.
  const savingsGoal = goal.savingsGoalId
    ? state.savingsGoals.find(entry => entry.id === goal.savingsGoalId)
    : null;

  const context = {
    tasks: state.tasks,
    projects: state.projects,
    routines: state.routines,
    milestones: state.milestones,
    target: normalizeTarget(goal),
    savingsSummary: savingsGoal ? summarizeSavingsGoal(savingsGoal) : null
  };

  const progress = computeProgress(goal, context);
  const remaining = remainingWork(tasks);

  const capacity = goal.targetDate
    ? capacityUntil({
      tasks: state.tasks,
      profile: state.profile,
      todayIso,
      deadlineIso: goal.targetDate,
      routines: state.routines,
      exceptions: state.routineExceptions
    })
    : null;

  const forecast = forecastGoal({ goal, remaining, capacity, tasks, todayIso });

  const conflicts = detectAllConflicts({
    goal,
    milestones: state.milestones,
    tasks,
    remaining,
    capacity,
    todayIso
  });

  const corrections = suggestCorrections({
    goal, forecast, remaining, capacity, otherGoals: state.goals
  });

  // Kuvaus rakennetaan erikseen: ehdollinen kenttä koosteen sisällä
  // näyttäisi suojaamattomalta turvatarkistuksessa, vaikka teksti
  // escapetetaan.
  const kuvaus = goal.description
    ? `<p class="hint">${escapeHtml(goal.description)}</p>` : '';

  // Suunnan elämänalue näkyy otsikon alla (F8): muuten liitos jäi näkymättä
  // kaikkialla muualla kuin Suunnassa.
  // "ei valittu" vain, kun aluetta ei ole: liitetty mutta tilasta puuttuva
  // (lataus kesken tai epäonnistui) ei ole valitsematon.
  const area = goal.lifeAreaId ? findLifeArea(goal.lifeAreaId) : null;
  const areaText = area ? escapeHtml(area.name) : goal.lifeAreaId ? 'ei näkyvissä juuri nyt' : 'ei valittu';
  const alue = `<p class="hint goal-life-area">Elämänalue: ${areaText}</p>`;

  container.innerHTML = `
    <div class="eyebrow">TAVOITE</div>
    <h2 class="title" style="margin-bottom:6px;">${escapeHtml(goal.title)}</h2>
    ${alue}
    ${kuvaus}

    ${renderProgress(goal, progress, context)}
    ${renderForecast(forecast)}
    ${renderConflicts(conflicts)}
    ${renderMilestones(goal, milestones, todayIso)}
    ${renderNext(goal, milestones, tasks, projects)}
    ${renderCorrections(corrections)}`;

  bind(container);
}

// ------------------------------------------------------------ osiot

function renderProgress(goal, progress, context) {
  const target = context.target;

  if (!progress.known) {
    return `
      <div class="focus-block">
        <div class="focus-title">Edistyminen</div>
        <div class="focus-summary">
          <span class="load-chip">Ei tiedossa</span>
          <span class="load-chip">${escapeHtml(goalStatusLabel(goal.status))}</span>
        </div>
        <p class="hint">
          ${escapeHtml(progress.reason)}
          Lisää tehtäviä, välitavoitteita tai mittari — <strong>tuntematon
          ei ole nolla</strong>, joten palkkia ei piirretä arvaukselle.
        </p>
      </div>`;
  }

  return `
    <div class="focus-block">
      <div class="focus-title">Edistyminen</div>
      <div class="focus-summary">
        <span class="load-chip">${progress.percent} %</span>
        <span class="load-chip">${escapeHtml(goalStatusLabel(goal.status))}</span>
        <span class="load-chip">${escapeHtml(progressStrategyLabel(progress.strategy))}</span>
        ${progress.derived ? '' : '<span class="prio-tag prio-muted">Käsin merkitty</span>'}
      </div>
      <div class="progress" role="img" aria-label="Edistyminen ${progress.percent} prosenttia">
        <div class="progress-fill${progress.percent >= 100 ? ' done' : ''}"
             style="width:${progress.percent}%"></div>
      </div>
      <p class="hint">${escapeHtml(progress.reason || '')}</p>
      ${hasTarget(target) ? `<div class="t-sub">${escapeHtml(describeTarget(target))}</div>` : ''}
      ${goal.savingsGoalId
        ? '<div class="t-sub">Kytketty säästötavoitteeseen. Luku tulee Taloudesta.</div>'
        : ''}
    </div>`;
}

function renderForecast(forecast) {
  const tone = forecast.state === FORECAST.DELAYED ? ' tone-clay'
    : forecast.state === FORECAST.AT_RISK ? ' tone-clay' : '';

  return `
    <div class="focus-block">
      <div class="focus-title">Ehdinkö?</div>
      <div class="focus-summary">
        <span class="load-chip${tone}">${escapeHtml(forecastLabel(forecast.state))}</span>
        <span class="load-chip">${escapeHtml(forecastQualityLabel(forecast.quality))}</span>
        ${forecast.perDayMinutes
          ? `<span class="load-chip">${forecast.perDayMinutes} min/pv</span>` : ''}
      </div>
      <p class="hint">${escapeHtml(forecast.reason)}</p>
      ${forecast.projectedDoneDate
        ? `<div class="t-sub">Nykyisellä kapasiteetilla valmis
           ${escapeHtml(formatShortDate(parseISO(forecast.projectedDoneDate)))}.</div>`
        : ''}
    </div>`;
}

/**
 * Ristiriidat vakavimmasta lievimpään.
 *
 * MAHDOTONTA SUUNNITELMAA EI PIILOTETA OPTIMISTISEN SANAMUODON TAAKSE.
 * Estävä ristiriita näytetään estävänä.
 */
function renderConflicts(conflicts) {
  if (conflicts.length === 0) return '';

  const tone = severity => severity === SEVERITY.BLOCKING ? ' tone-clay'
    : severity === SEVERITY.WARNING ? ' tone-clay' : '';

  const label = severity => severity === SEVERITY.BLOCKING ? 'Estävä'
    : severity === SEVERITY.WARNING ? 'Varoitus' : 'Huomio';

  return `
    <div class="focus-block">
      <div class="focus-title">Mikä on vialla</div>
      ${conflicts.map(conflict => `
        <div class="t-sub">
          <span class="prio-tag${tone(conflict.severity)}">${label(conflict.severity)}</span>
          ${escapeHtml(conflict.message)}
        </div>`).join('')}
    </div>`;
}

function renderMilestones(goal, milestones, todayIso) {
  const rows = milestones.map((milestone, index) => {
    const reached = milestone.status === MILESTONE_STATUS.REACHED;
    const skipped = milestone.status === MILESTONE_STATUS.SKIPPED;
    const late = isMilestoneOverdue(milestone, todayIso);

    return `
      <div class="task-row ${reached || skipped ? 'done' : ''}">
        <button class="chk ${reached ? 'done' : ''}"
                data-milestone-toggle="${escapeHtml(milestone.id)}"
                aria-pressed="${reached ? 'true' : 'false'}"
                aria-label="${reached ? 'Merkitse avoimeksi' : 'Merkitse saavutetuksi'}: ${escapeHtml(milestone.title)}">
          <svg aria-hidden="true"><use href="#i-check"/></svg>
        </button>
        <button class="t-body t-open" data-milestone-edit="${escapeHtml(milestone.id)}"
                aria-label="Muokkaa välitavoitetta: ${escapeHtml(milestone.title)}">
          <div class="t-title">${escapeHtml(milestone.title)}${
            late ? '<span class="prio-tag prio-clay">Myöhässä</span>' : ''}${
            skipped ? '<span class="prio-tag prio-muted">Ohitettu</span>' : ''}</div>
          <div class="t-meta">
            <span class="task-cat-tag">${index + 1}.</span>
            <span>${escapeHtml(milestoneStatusLabel(milestone.status))}</span>
            ${milestone.targetDate
              ? `<span>${escapeHtml(formatShortDate(parseISO(milestone.targetDate)))}</span>`
              : '<span>ei päivää</span>'}
          </div>
        </button>
        <button class="chip-btn" data-milestone-up="${escapeHtml(milestone.id)}"
                aria-label="Siirrä ylös: ${escapeHtml(milestone.title)}"
                ${index === 0 ? 'disabled' : ''}>↑</button>
        <button class="chip-btn" data-milestone-down="${escapeHtml(milestone.id)}"
                aria-label="Siirrä alas: ${escapeHtml(milestone.title)}"
                ${index === milestones.length - 1 ? 'disabled' : ''}>↓</button>
      </div>`;
  }).join('');

  return `
    <div class="focus-block">
      <div class="focus-title">Välitavoitteet</div>
      ${milestones.length === 0 ? `
        <p class="hint">
          Ei välitavoitteita. Välitavoite on <strong>tila</strong>, ei
          tehtävälista: se joko on saavutettu tai ei. Pitkässä tavoitteessa
          ne kertovat etenemisestä paremmin kuin tehtävien lukumäärä.
        </p>` : rows}
      <div class="form-actions">
        <button class="form-btn secondary" id="addMilestoneBtn" type="button">
          Lisää välitavoite
        </button>
      </div>
    </div>`;
}

function renderNext(goal, milestones, tasks, projects) {
  const next = nextMilestone(milestones, goal.id);
  const openTasks = tasks
    .filter(task => !task.completed)
    .sort((a, b) => String(a.date || '9999').localeCompare(String(b.date || '9999')))
    .slice(0, 5);

  return `
    <div class="focus-block">
      <div class="focus-title">Mikä on seuraavaksi</div>
      ${next
        ? `<div class="t-sub"><strong>Seuraava välitavoite:</strong>
           ${escapeHtml(next.title)}${next.targetDate
             ? ` (${escapeHtml(formatShortDate(parseISO(next.targetDate)))})` : ''}</div>`
        : ''}
      ${projects.length > 0
        ? `<div class="t-sub">${projects.length} projektia liitettynä.</div>` : ''}
      ${openTasks.length === 0
        ? '<p class="hint">Ei avoimia tehtäviä. Lisää tehtäviä tai suunnittele uudelleen.</p>'
        : openTasks.map(task => `
          <div class="task-row">
            <div class="t-body">
              <div class="t-title">${escapeHtml(task.title)}</div>
              <div class="t-meta">
                ${task.date
                  ? `<span>${escapeHtml(formatShortDate(parseISO(task.date)))}</span>`
                  : '<span>ei päivää</span>'}
                ${task.durationMinutes
                  ? `<span>${task.durationMinutes} min</span>` : ''}
              </div>
            </div>
          </div>`).join('')}
    </div>`;
}

/**
 * Korjaavat toimet.
 *
 * NÄMÄ OVAT EHDOTUKSIA. Yksikään ei toteudu itsestään, eikä tavoitetta
 * luovuteta automaattisesti — luovuttaminen on päätös, ja päätös on
 * käyttäjän.
 */
function renderCorrections(corrections) {
  if (corrections.length === 0) return '';

  return `
    <div class="focus-block">
      <div class="focus-title">Mitä voisit tehdä</div>
      <p class="hint">Ehdotuksia. Mikään näistä ei tapahdu itsestään.</p>
      <ul class="plan-list">
        ${corrections.map(entry => `<li>${escapeHtml(entry.message)}</li>`).join('')}
      </ul>
    </div>`;
}

function bind(container) {
  container.querySelectorAll('[data-milestone-toggle]').forEach(node =>
    node.addEventListener('click', async () => {
      const milestone = findMilestone(node.dataset.milestoneToggle);
      if (!milestone) return;
      await setMilestoneReached(
        milestone.id, milestone.status !== MILESTONE_STATUS.REACHED);
    }));

  container.querySelectorAll('[data-milestone-edit]').forEach(node =>
    node.addEventListener('click', () => openMilestoneForm(node.dataset.milestoneEdit)));

  container.querySelectorAll('[data-milestone-up]').forEach(node =>
    node.addEventListener('click', () => moveMilestone(node.dataset.milestoneUp, 'up')));

  container.querySelectorAll('[data-milestone-down]').forEach(node =>
    node.addEventListener('click', () => moveMilestone(node.dataset.milestoneDown, 'down')));

  const add = container.querySelector('#addMilestoneBtn');
  if (add) add.addEventListener('click', openAddMilestoneForm);
}

// --------------------------------------------------------------- lomake

const milestoneErrors = makeFormErrors('#milestoneForm', {
  title: 'msTitle', targetDate: 'msTargetDate', goalId: 'msTitle'
});

function makeFormErrors(formSelector, fieldToInput) {
  const clear = () => {
    document.querySelectorAll(`${formSelector} .field-error`).forEach(node => {
      node.textContent = '';
      node.style.display = 'none';
    });
    document.querySelectorAll(`${formSelector} .invalid`).forEach(node => {
      node.classList.remove('invalid');
      node.removeAttribute('aria-invalid');
    });
  };

  const show = errors => {
    clear();
    let firstInvalid = null;
    for (const [field, message] of Object.entries(errors)) {
      const inputId = fieldToInput[field];
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
  };

  return { clear, show };
}

function fillMilestoneForm(milestone) {
  el('msTitle').value = milestone ? milestone.title : '';
  el('msDescription').value = milestone && milestone.description
    ? milestone.description : '';
  el('msTargetDate').value = milestone && milestone.targetDate
    ? milestone.targetDate : '';
}

export function openAddMilestoneForm() {
  setEditingMilestoneId(null);
  fillMilestoneForm(null);
  milestoneErrors.clear();
  setText('milestoneFormTitle', 'Uusi välitavoite');
  toggle('msDelete', false);
  toggle('milestoneForm', true, 'flex');
  focus('msTitle');
}

export function openMilestoneForm(id) {
  const milestone = findMilestone(id);
  if (!milestone) return;

  setEditingMilestoneId(id);
  fillMilestoneForm(milestone);
  milestoneErrors.clear();
  setText('milestoneFormTitle', 'Muokkaa välitavoitetta');
  toggle('msDelete', true, 'flex');
  toggle('milestoneForm', true, 'flex');
  focus('msTitle');
}

export function closeMilestoneForm() {
  setEditingMilestoneId(null);
  // Kentät tyhjennetään, ei vain piiloteta — uloskirjautuminen kutsuu
  // tätä, eikä seuraava käyttäjä saa löytää edellisen tekstiä.
  const title = maybe('msTitle');
  if (title) fillMilestoneForm(null);
  milestoneErrors.clear();
  toggle('milestoneForm', false);
}

function readMilestoneForm() {
  return {
    goalId: getState().openGoalId,
    title: el('msTitle').value.trim(),
    description: el('msDescription').value.trim() || null,
    targetDate: el('msTargetDate').value || null
  };
}

async function submitMilestone() {
  const input = readMilestoneForm();
  const editingId = getState().editingMilestoneId;

  const result = editingId
    ? await editMilestone(editingId, input)
    : await createMilestone(input);

  if (!result || !result.ok) {
    if (result && result.errors) milestoneErrors.show(result.errors);
    return;
  }
  closeMilestoneForm();
}

// ------------------------------------------------------------ kytkennät

/** Kytke tavoitteen yksityiskohtien tapahtumat. Kutsutaan kerran. */
export function initGoalDetail() {
  if (!maybe('msSave')) return;

  el('msSave').addEventListener('click', submitMilestone);
  el('msCancel').addEventListener('click', closeMilestoneForm);
  el('msDelete').addEventListener('click', async () => {
    const id = getState().editingMilestoneId;
    if (id && await deleteMilestone(id)) closeMilestoneForm();
  });

  el('milestoneForm').addEventListener('keydown', event => {
    if (event.key === 'Escape') closeMilestoneForm();
  });

  el('goalDetailBack').addEventListener('click', () => {
    closeMilestoneForm();
    setOpenGoalId(null);
  });
}
