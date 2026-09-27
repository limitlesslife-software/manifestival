// Suunnittelunäkymä: ehdotus, tarkistus, hyväksyntä.
//
// =====================================================================
// EHDOTUS ON LUETTAVA, EI PELKÄSTÄÄN HYVÄKSYTTÄVÄ
// =====================================================================
//
// Suunnitelma, jota ei voi lukea yhdellä silmäyksellä, hyväksytään
// lukematta — ja silloin hyväksyntä lakkaa tarkoittamasta mitään.
//
// Siksi näkymä ei näytä raakaa JSONia eikä pitkää tekstiä, vaan
// RAKENNETTA jota voi muokata kohta kerrallaan: jokainen välitavoite,
// projekti, tehtävä ja rutiini on oma rivinsä, jonka voi jättää pois
// yhdellä painalluksella.
//
// =====================================================================
// OLETUKSET NÄYTETÄÄN
// =====================================================================
//
// Malli tekee oletuksia, joita käyttäjä ei sanonut. Oletus jota ei
// näytetä on oletus jota ei voi korjata — ja se päätyisi
// suunnitelmaan äänettömästi.

import { el, maybe, toggle, focus } from '../../ui/dom.js';
import { escapeHtml } from '../../lib/format.js';
import {
  getState, setGoalsSegment, setAutomationLevel, setOpenGoalId
} from '../state.js';
import {
  AUTOMATION_LEVELS, automationLevelLabel, automationLevelDescription,
  requiresExplicitOptIn
} from '../../domain/automation.js';
import { summarizePlan, PLAN_STATUS } from '../../domain/plan.js';
import {
  requestPlan, commitPlan, rejectPendingPlan, togglePlanItem
} from '../planning.js';
import { proposeReplan, applyReplan, rejectReplan } from '../actions.js';
import { detectReplanTriggers, describeChange, triggerLabel } from '../../domain/replan.js';
import { horizonCapacity, horizonEnd, remainingWork } from '../../domain/capacity.js';
import { summarizeHorizon, planHorizon } from '../../domain/planScheduler.js';
import { fmtISO, todayMidnight } from '../../lib/datetime.js';
import { calendarForPlanning } from '../calendarPlan.js';
import { showError, success } from '../../ui/toast.js';
import { currentPlanningFeedback, validatePlanAgainstAlignment } from '../alignment.js';

let generating = false;
let committing = false;

// ---------------------------------------------------------- automaatio

function fillAutomationOptions() {
  const node = maybe('plAutomationLevel');
  if (!node) return;

  node.innerHTML = AUTOMATION_LEVELS
    .map(level => `<option value="${level}">${level}. `
      + `${escapeHtml(automationLevelLabel(level))}</option>`).join('');
}

function syncAutomation(state) {
  const node = maybe('plAutomationLevel');
  if (node) node.value = String(state.automationLevel);

  const hint = maybe('automationHint');
  if (!hint) return;

  // TASO 4 SANOTAAN ÄÄNEEN. Se on ainoa taso, jolla järjestelmä muuttaa
  // suunnitelmaa ennen kuin käyttäjä näkee muutoksen.
  hint.innerHTML = escapeHtml(automationLevelDescription(state.automationLevel))
    + (requiresExplicitOptIn(state.automationLevel)
      ? ' <strong>Tällä tasolla muutokset tapahtuvat ennen kuin näet ne. '
        + 'Itse asettamiasi aikoja ei silti siirretä koskaan.</strong>'
      : '');
}

// ------------------------------------------------------ ehdotuksen tarkistus

/** Suunnan tarkistus suunnitelmalle: mahtuuko, jääkö tärkeä alue ilman aikaa. */
function alignmentCheckHtml(plan) {
  if (getState().lifeAreas.length === 0) return '';
  const result = validatePlanAgainstAlignment(plan, { goalId: plan.goalId });
  if (!result || result.messages.length === 0) return '';
  const rows = result.messages.map(message => `<li class="plan-check-${escapeHtml(message.level)}">`
    + `${message.level === 'attention' ? '<strong>Huomio:</strong> ' : ''}${escapeHtml(message.text)}</li>`).join('');
  return `<div class="plan-alignment-check" role="status">
      <div class="add-form-title" style="margin-top:10px;">Suunta: mahtuuko tämä elämääsi?</div>
      <ul class="plan-list">${rows}</ul>
      <p class="hint">Tarkistus ei estä hyväksyntää. Se kertoo, miten suunnitelma asettuu kapasiteettiisi ja tärkeisiin alueisiisi.</p>
    </div>`;
}

function renderPlanReview(container, state) {
  const plan = state.pendingPlan;

  if (!plan) {
    container.innerHTML = '';
    return;
  }

  const yhteenveto = summarizePlan(plan);
  const committed = plan.status === PLAN_STATUS.COMMITTED;
  // Tekoälyn suunnitelma EI ole poikkeus Suunnan säännöistä: samat
  // deterministiset tarkistukset ennen hyväksyntää. Ei estä, kertoo.
  const suunta = committed ? '' : alignmentCheckHtml(plan);

  // Osiot rakennetaan ENNEN koostetta. Kutsu kooste-literaalin sisällä
  // näyttäisi suojaamattomalta kentältä turvatarkistuksessa, vaikka
  // `section` escapettaa jokaisen käyttäjän tekstin.
  const osiot = [
    section('Välitavoitteet', 'milestone', plan.milestones,
      item => item.title, item => item.targetDate),
    section('Projektit', 'project', plan.projects,
      item => item.name, item => item.deadline),
    section('Tehtävät', 'task', plan.tasks,
      item => item.title,
      item => (item.durationMinutes ? `${item.durationMinutes} min` : 'ei kestoarviota')),
    section('Rutiinit', 'routine', plan.routines,
      item => item.title, item => `${item.durationMinutes} min`)
  ].join('');

  container.innerHTML = `
    <div class="add-form" style="display:flex;" role="group" aria-labelledby="planReviewTitle">
      <div class="add-form-title" id="planReviewTitle">
        Ehdotus: ${escapeHtml(plan.goal.title)}
      </div>

      <p class="hint">
        <strong>Tämä on ehdotus. Mitään ei ole tallennettu.</strong>
        Voit jättää kohtia pois ja hyväksyä loput.
      </p>

      <div class="focus-summary">
        <span class="load-chip">${yhteenveto.milestones} välitavoitetta</span>
        <span class="load-chip">${yhteenveto.projects} projektia</span>
        <span class="load-chip">${yhteenveto.tasks} tehtävää</span>
        <span class="load-chip">${yhteenveto.routines} rutiinia</span>
        ${yhteenveto.excluded > 0
          ? `<span class="load-chip tone-clay">${yhteenveto.excluded} jätetty pois</span>` : ''}
        ${yhteenveto.estimatedMinutes > 0
          ? `<span class="load-chip">${hoursLabel(yhteenveto.estimatedMinutes)} työtä</span>` : ''}
      </div>

      ${suunta}

      ${plan.goal.targetValue !== null ? `
        <div class="t-sub">Mittari: ${escapeHtml(plan.goal.metric || '')}
        ${plan.goal.baselineValue !== null
          ? `${escapeHtml(String(plan.goal.baselineValue))} →` : ''}
        ${escapeHtml(String(plan.goal.targetValue))}
        ${escapeHtml(plan.goal.unit || '')}</div>` : ''}

      ${plan.assumptions.length > 0 ? `
        <div class="add-form-title" style="margin-top:10px;">Oletukset</div>
        <p class="hint">Nämä Manifestival päätteli itse. Korjaa jos ne ovat väärin.</p>
        <ul class="plan-list">
          ${plan.assumptions.map(text => `<li>${escapeHtml(text)}</li>`).join('')}
        </ul>` : ''}

      ${plan.questions.length > 0 ? `
        <div class="add-form-title" style="margin-top:10px;">Avoimet kysymykset</div>
        <p class="hint">Näihin Manifestival ei osannut vastata. Se ei keksinyt vastausta.</p>
        <ul class="plan-list">
          ${plan.questions.map(text => `<li>${escapeHtml(text)}</li>`).join('')}
        </ul>` : ''}

      ${osiot}

      <div class="form-actions">
        <button class="form-btn secondary" id="planReject" type="button">Hylkää</button>
        <button class="form-btn primary" id="planApprove" type="button"
                ${committed || yhteenveto.milestones + yhteenveto.projects + yhteenveto.tasks
                  + yhteenveto.routines === 0 ? 'disabled' : ''}>
          Hyväksy ja luo
        </button>
      </div>
    </div>`;

  container.querySelectorAll('[data-plan-toggle]').forEach(node =>
    node.addEventListener('click', () => {
      const [kind, ref] = node.dataset.planToggle.split(':');
      togglePlanItem(kind, ref);
    }));

  const reject = container.querySelector('#planReject');
  const approve = container.querySelector('#planApprove');
  if (reject) reject.addEventListener('click', onReject);
  if (approve) approve.addEventListener('click', onApprove);
}

/**
 * Yksi osio ehdotuksesta.
 *
 * POISSULJETTU RIVI JÄÄ NÄKYVIIN. Se näytetään himmennettynä ja sen voi
 * palauttaa. Piilottaminen tarkoittaisi, ettei käyttäjä näe mitä hän
 * jätti pois — eikä voi muuttaa mieltään.
 */
function section(otsikko, kind, items, nimi, meta) {
  if (!items || items.length === 0) return '';

  return `
    <div class="add-form-title" style="margin-top:10px;">${escapeHtml(otsikko)}</div>
    ${items.map(item => `
      <div class="task-row ${item.excluded ? 'done' : ''}">
        <button class="chk ${item.excluded ? '' : 'done'}"
                data-plan-toggle="${escapeHtml(kind)}:${escapeHtml(item.ref || '')}"
                aria-pressed="${item.excluded ? 'false' : 'true'}"
                aria-label="${item.excluded ? 'Ota mukaan' : 'Jätä pois'}: ${escapeHtml(nimi(item))}">
          <svg aria-hidden="true"><use href="#i-check"/></svg>
        </button>
        <div class="t-body">
          <div class="t-title">${escapeHtml(nimi(item))}</div>
          <div class="t-meta">
            ${meta(item) ? `<span>${escapeHtml(String(meta(item)))}</span>` : ''}
            ${item.excluded ? '<span class="prio-tag prio-muted">Ei mukaan</span>' : ''}
          </div>
        </div>
      </div>`).join('')}`;
}

function hoursLabel(minutes) {
  const n = Number(minutes) || 0;
  if (n < 60) return `${n} min`;
  const h = Math.floor(n / 60);
  const m = n % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

// ------------------------------------------------------------ toiminnot

async function onGenerate() {
  if (generating) return;

  const input = maybe('plGoalText');
  if (!input) return;

  const text = input.value.trim();
  const error = maybe('plGoalTextError');

  if (!text) {
    if (error) {
      error.textContent = 'Kerro mitä haluat saavuttaa.';
      error.style.display = 'block';
    }
    focus('plGoalText');
    return;
  }

  if (error) {
    error.textContent = '';
    error.style.display = 'none';
  }

  generating = true;
  el('plGenerate').textContent = 'Suunnitellaan…';

  try {
    const result = await requestPlan({ goalText: text });
    // Hylätty = istunto vaihtui kesken; seuraavalle käyttäjälle ei näytetä
    // edellisen pyynnön lopputulosta, ei edes virhettä.
    if (!result.ok && !result.discarded) showError(result.error);
  } finally {
    generating = false;
    const button = maybe('plGenerate');
    if (button) button.textContent = 'Tee suunnitelma';
  }
}

/**
 * Hyväksy ja tallenna.
 *
 * KAKSOISKLIKKAUS EI TUOTA KAHTA SUUNNITELMAA. Suoja on kahdessa
 * kerroksessa: `committing` estää toisen kutsun täältä, ja
 * idempotenssiavain estää sen toimintokerroksessa. Käyttöliittymän
 * suoja on mukavuutta; toimintokerroksen suoja on se joka pitää.
 */
async function onApprove() {
  if (committing) return;

  committing = true;
  const button = maybe('planApprove');
  if (button) {
    button.disabled = true;
    button.textContent = 'Tallennetaan…';
  }

  try {
    const result = await commitPlan();

    if (!result.ok) {
      // OSITTAINEN TALLENNUS SANOTAAN ÄÄNEEN. Hiljainen puolikas
      // suunnitelma löytyisi vasta viikkoja myöhemmin.
      showError(result.partial
        ? `${result.error} Osa riveistä jäi kantaan: ${result.orphans.join(', ')}. `
          + 'Tarkista tavoitteesi.'
        : result.error);
      return;
    }

    if (result.duplicate) {
      success('Tämä suunnitelma on jo tallennettu.');
    } else {
      const n = result.created;
      success(`Suunnitelma luotu: ${n.milestones} välitavoitetta, `
        + `${n.projects} projektia, ${n.tasks} tehtävää.`);
    }

    const input = maybe('plGoalText');
    if (input) input.value = '';

    // Siirrytään luotuun tavoitteeseen: hyväksynnän jälkeen käyttäjä
    // haluaa nähdä mitä syntyi, ei tyhjää lomaketta.
    if (result.goalId) {
      setOpenGoalId(result.goalId);
      setGoalsSegment('goals');
    }
  } finally {
    committing = false;
    const node = maybe('planApprove');
    if (node) {
      node.disabled = false;
      node.textContent = 'Hyväksy ja luo';
    }
  }
}

function onReject() {
  rejectPendingPlan();
  success('Ehdotus hylätty. Mitään ei tallennettu.');
}

// -------------------------------------------------------- suunnitelman tila

/**
 * Suunnitelman tila: kuorma, ristiriidat ja muutosehdotukset.
 *
 * Tämä on se osa, joka vastaa kysymykseen "mahtuuko tämä kaikki".
 */
function renderPlanStatus(container, state) {
  const todayIso = fmtISO(todayMidnight());
  const toIso = horizonEnd(todayIso, 14);

  // KALENTERI MUKAAN (§42): menot, valmistautuminen, matka ja suojattu uni
  // eivät ole suunniteltavaa aikaa. Sama kalenteri kapasiteetille ja
  // horisontille (calendarPlan.calendarForPlanning), kuten "Ehdota
  // muutoksia" -ehdotuksessa.
  const calendar = calendarForPlanning(state, { from: todayIso, to: toIso, todayIso });

  const capacity = horizonCapacity({
    tasks: state.tasks,
    profile: state.profile,
    fromIso: todayIso,
    toIso,
    routines: state.routines,
    exceptions: state.routineExceptions,
    events: calendar.events,
    blocks: calendar.blocks
  });

  const remaining = remainingWork(
    state.tasks.filter(task => !task.completed && task.date && task.date <= toIso));

  const horizon = planHorizon({
    tasks: state.tasks,
    goals: state.goals,
    profile: state.profile,
    fromIso: todayIso,
    toIso,
    routines: state.routines,
    exceptions: state.routineExceptions,
    automationLevel: state.automationLevel,
    events: calendar.events,
    blocks: calendar.blocks
  });

  const kuorma = summarizeHorizon(horizon);
  // Laukaisimet ilman kalenteria tarkoituksella: kalenterin CONFLICT-laukaisin
  // lupaa uuden kellonajan (proposeSchedule reflow), jota "Ehdota muutoksia"
  // (päivätason siirto) ei tee. Lupausta ei näytetä ennen kuin se pidetään.
  const triggers = detectReplanTriggers({
    tasks: state.tasks,
    routines: state.routines,
    exceptions: state.routineExceptions,
    goals: state.goals,
    milestones: state.milestones,
    todayIso
  });

  const replan = state.pendingReplan;

  container.innerHTML = `
    <div class="focus-block">
      <div class="focus-title">Seuraavat kaksi viikkoa</div>
      <div class="focus-summary">
        <span class="load-chip">${hoursLabel(capacity.totalUsableMinutes)} suunniteltavaa aikaa</span>
        <span class="load-chip${kuorma && kuorma.ratio > 0.85 ? ' tone-clay' : ''}">
          ${hoursLabel(remaining.minutes)} työtä</span>
        ${kuorma && kuorma.unplacedCount > 0
          ? `<span class="load-chip tone-clay">${kuorma.unplacedCount} ei mahdu</span>` : ''}
      </div>
      <p class="hint">
        Vuorokaudessa ei ole 24 suunniteltavaa tuntia. Luku on
        valveillaoloaika miinus kiinteät sitoumukset (kalenterin menot,
        matkat ja valmistautuminen, suojattu uni ja rauhoittuminen) miinus
        puskuri — eikä puskuri ole hukkaa vaan se, mikä pitää suunnitelman
        mahdollisena.
      </p>
    </div>

    ${triggers.needed ? `
      <div class="focus-block">
        <div class="focus-title">Suunnitelma kaipaa huomiota</div>
        ${triggers.triggers.map(entry => `
          <div class="t-sub">
            <strong>${escapeHtml(triggerLabel(entry.trigger))}:</strong>
            ${escapeHtml(entry.detail)}
          </div>`).join('')}
        <div class="form-actions">
          <button class="form-btn primary" id="planReplan" type="button">
            Ehdota muutoksia
          </button>
        </div>
      </div>` : `
      <div class="focus-block">
        <div class="focus-title">Suunnitelma on kunnossa</div>
        <p class="hint">Mikään ei ole myöhässä eikä jäänyt toistuvasti väliin.</p>
        <div class="form-actions">
          <button class="form-btn secondary" id="planReplan" type="button">
            Järjestele silti uudelleen
          </button>
        </div>
      </div>`}

    ${replan ? renderReplan(replan) : ''}`;

  const replanButton = container.querySelector('#planReplan');
  if (replanButton) {
    replanButton.addEventListener('click', () => proposeReplan('manual'));
  }

  const apply = container.querySelector('#replanApply');
  if (apply) {
    apply.addEventListener('click', async () => {
      await applyReplan(replan.changes);
    });
  }

  const dismiss = container.querySelector('#replanReject');
  if (dismiss) dismiss.addEventListener('click', () => rejectReplan());
}

/**
 * Muutosehdotus.
 *
 * DELTA, EI KOKO SUUNNITELMA. Vain se, mikä muuttuu — ja jokaisella
 * rivillä perustelu, jotta käyttäjä voi olla eri mieltä.
 */
function renderReplan(replan) {
  if (replan.changes.length === 0 && replan.unplaced.length === 0) {
    return `
      <div class="focus-block">
        <div class="focus-title">Ei siirrettävää</div>
        <p class="hint">${escapeHtml(replan.summary.reason || 'Suunnitelma on kunnossa.')}</p>
      </div>`;
  }

  return `
    <div class="add-form" style="display:flex;" role="group" aria-labelledby="replanTitle">
      <div class="add-form-title" id="replanTitle">
        Muutosehdotus — ${escapeHtml(triggerLabel(replan.trigger))}
      </div>

      <p class="hint">
        <strong>Mitään ei ole siirretty.</strong>
        ${replan.needsApproval.length > 0
          ? `${replan.needsApproval.length} siirtoa vaatii hyväksyntäsi.` : ''}
      </p>

      ${replan.changes.map(change => `
        <div class="task-row">
          <div class="t-body">
            <div class="t-title">${escapeHtml(change.title)}</div>
            <div class="t-sub">${escapeHtml(describeChange(change))}</div>
          </div>
        </div>`).join('')}

      ${replan.unplaced.length > 0 ? `
        <div class="add-form-title" style="margin-top:10px;">Ei mahdu mihinkään</div>
        <p class="hint">
          Näitä siirtäminen ei ratkaise: aikaa ei ole tarpeeksi. Karsi
          laajuutta, siirrä määräpäivää tai varaa enemmän aikaa.
        </p>
        ${replan.unplaced.map(entry => `
          <div class="task-row">
            <div class="t-body">
              <div class="t-title">${escapeHtml(entry.title)}</div>
              <div class="t-sub">${escapeHtml(entry.reason)}</div>
            </div>
          </div>`).join('')}` : ''}

      ${replan.changes.length > 0 ? `
        <div class="form-actions">
          <button class="form-btn secondary" id="replanReject" type="button">Älä siirrä</button>
          <button class="form-btn primary" id="replanApply" type="button">
            Siirrä ${replan.changes.length} ${replan.changes.length === 1 ? 'tehtävä' : 'tehtävää'}
          </button>
        </div>` : ''}
    </div>`;
}

// ------------------------------------------------------------- renderöi

/** Renderöi suunnittelunäkymä. */
export function renderPlanning() {
  const state = getState();

  fillAutomationOptions();
  syncAutomation(state);

  // Suunnan palaute näkyy käyttäjälle: miksi suunnitelma on kevyempi.
  const hint = maybe('planAlignmentHint');
  if (hint) {
    const feedback = currentPlanningFeedback();
    hint.textContent = feedback && Number.isInteger(feedback.capHours)
      ? (feedback.overloaded
        ? `Suunta: tämän viikon suunnitelma ylitti kapasiteettisi. Uusi suunnitelma olettaa enintään ${feedback.capHours} h viikossa.`
        : `Suunta: suunnitelma olettaa enintään ${feedback.capHours} h viikossa, kuten itse arvioit.`)
      : '';
  }

  const review = maybe('planReviewContainer');
  if (review) renderPlanReview(review, state);

  const status = maybe('planStatusContainer');
  if (status) renderPlanStatus(status, state);
}

// ------------------------------------------------------------ kytkennät

/** Kytke suunnittelunäkymän tapahtumat. Kutsutaan kerran. */
export function initPlanning() {
  if (!maybe('plGenerate')) return;

  el('plGenerate').addEventListener('click', onGenerate);

  el('plAutomationLevel').addEventListener('change', event => {
    setAutomationLevel(event.target.value);
  });

  el('plGoalText').addEventListener('keydown', event => {
    // Ctrl+Enter lähettää. Pelkkä Enter tekee rivinvaihdon, koska
    // tavoite on usein monirivinen.
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) onGenerate();
  });
}

/** Tila, jonka uloskirjautuminen nollaa. */
export function resetPlanning() {
  generating = false;
  committing = false;
  const input = maybe('plGoalText');
  if (input) input.value = '';
  const error = maybe('plGoalTextError');
  if (error) {
    error.textContent = '';
    error.style.display = 'none';
  }
  toggle('planReviewContainer', true);
}
