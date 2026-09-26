// Matkasuunnitelmat ja paikkamuistutukset.
//
// =====================================================================
// TUNTEMATON NÄYTETÄÄN TUNTEMATTOMANA
// =====================================================================
//
// Jos matka-aikaa ei tiedetä, lähtöaikaa EI näytetä kellonaikana.
// Laskettu lähtöaika näyttää täsmälleen yhtä varmalta kuin oikea, ja
// käyttäjä luottaisi siihen ja myöhästyisi.
//
// Näkymä näyttää sen sijaan syyn ja tarjoaa kentän, johon kesto voi
// kirjata itse. Se on rehellisin mahdollinen vastaus: emme tiedä, ja
// sinä tiedät.
//
// =====================================================================
// KOORDINAATTEJA EI OLE
// =====================================================================
//
// `Mistä` ja `Minne` ovat nimiä. Karttaa ei ole, geokoodausta ei ole,
// eikä sijaintia pyydetä matkasuunnitelmaa varten lainkaan.
//
// Paikkamuistutus on SÄÄNTÖ, ei toteutus. Geoaitaa ei ole eikä sitä voi
// luvata ilman laitehyväksyntää — sääntö on dataa, jonka voi kirjata,
// nähdä ja testata. Se on oletuksena POIS PÄÄLTÄ, ja päälle
// kytkeminen kysyy vahvistuksen.

import { el, maybe, toggle, setText, focus } from '../../ui/dom.js';
import { escapeHtml } from '../../lib/format.js';
import { fmtISO, todayMidnight } from '../../lib/datetime.js';
import {
  getState, findTravelPlan, findLocationRule,
  setEditingTravelPlanId, setEditingLocationRuleId
} from '../state.js';
import {
  TRAVEL_MODE, TRAVEL_MODES, TRAVEL_SOURCE, travelModeLabel,
  departureState, DEPARTURE_STATE, isEstimateStale, hasTravelProvider, suggestPlaces,
  LOCATION_TRIGGER, LOCATION_TRIGGERS
} from '../../domain/travel.js';
import { hasTable, isTableAvailable } from '../../data/schema.js';
import { serverUnavailableHintHtml } from '../schemaStatus.js';
import {
  createTravelPlan, editTravelPlan, deleteTravelPlan, setTravelEstimate,
  createLocationRule, editLocationRule, deleteLocationRule, toggleLocationRule
} from '../assistantActions.js';

/** Laukaisimien suomenkieliset nimet. Kartta on nimenomainen. */
const TRIGGER_LABELS = Object.freeze({
  [LOCATION_TRIGGER.ARRIVING]: 'Kun saavun',
  [LOCATION_TRIGGER.LEAVING]: 'Kun lähden',
  [LOCATION_TRIGGER.NEARBY]: 'Kun olen lähellä'
});

let optionsReady = false;

function fillSelectOptions() {
  if (optionsReady) return;

  const mode = maybe('tvMode');
  if (mode) {
    mode.innerHTML = TRAVEL_MODES
      .map(value => `<option value="${escapeHtml(value)}">`
        + `${escapeHtml(travelModeLabel(value))}</option>`).join('');
  }

  const trigger = maybe('lrTrigger');
  if (trigger) {
    trigger.innerHTML = LOCATION_TRIGGERS
      .map(value => `<option value="${escapeHtml(value)}">`
        + `${escapeHtml(TRIGGER_LABELS[value] || value)}</option>`).join('');
  }

  optionsReady = true;
}

/** Nykyhetki minuutteina. Kello luetaan TÄSSÄ, ei domainissa. */
function nowMinutes() {
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes();
}

// =====================================================================
// MATKALISTA
// =====================================================================

/**
 * Lähtöaikarivi.
 *
 * Kolme eri vastausta, ja ne näyttävät erilaisilta tarkoituksella:
 *   TUNTEMATON  kursiivi, syy näkyvissä, ei kellonaikaa
 *   AJOISSA     kellonaika ja erittely
 *   MYÖHÄSSÄ    punainen, ja se sanotaan suoraan
 */
const STATE_TAGS = Object.freeze({
  [DEPARTURE_STATE.NOT_YET]: { label: 'Ei vielä', tone: '' },
  [DEPARTURE_STATE.PREPARE]: { label: 'Valmistaudu', tone: 'tone-warn' },
  [DEPARTURE_STATE.LEAVE_SOON]: { label: 'Lähtö pian', tone: 'tone-warn' },
  [DEPARTURE_STATE.LEAVE_NOW]: { label: 'Lähde nyt', tone: 'tone-late' },
  [DEPARTURE_STATE.LATE]: { label: 'Myöhässä', tone: 'tone-late' }
});

function leaveByHtml(plan) {
  const departure = departureState(plan, {
    todayIso: fmtISO(todayMidnight()), nowMinutes: nowMinutes()
  });

  if (!departure.known) {
    return `
      <div class="assist-reason assist-unknown">
        Lähtöaikaa ei voi laskea: ${escapeHtml(departure.message)}
      </div>
      <div class="assist-actions">
        <label class="visually-hidden" for="est-${escapeHtml(plan.id)}">Matka-aika minuutteina</label>
        <input type="number" id="est-${escapeHtml(plan.id)}" min="1" max="1440"
               step="1" placeholder="min" style="width:88px;"
               data-estimate-input="${escapeHtml(plan.id)}">
        <button class="assist-btn" data-estimate-save="${escapeHtml(plan.id)}">Kirjaa matka-aika</button>
      </div>`;
  }

  const tag = STATE_TAGS[departure.state] || STATE_TAGS[DEPARTURE_STATE.NOT_YET];
  const vanhentunut = isEstimateStale(plan, new Date().toISOString())
    ? ' <span class="assist-tag tone-warn">Arvio on vanha</span>'
    : '';

  return `
    <div class="assist-meta">
      <span class="assist-tag ${tag.tone}">${escapeHtml(tag.label)}</span>
      ${escapeHtml(departure.message)}${vanhentunut}
    </div>
    <div class="assist-reason">${escapeHtml(departure.detail)}</div>`;
}

function planRowHtml(plan) {
  const mistaMinne = [plan.origin, plan.destination]
    .filter(Boolean).map(escapeHtml).join(' → ');

  const perilla = plan.arrivalDate || plan.arrivalTime
    ? `${escapeHtml(plan.arrivalDate || '')}`
      + (plan.arrivalTime ? ` klo ${escapeHtml(plan.arrivalTime)}` : '')
    : '<span class="assist-unknown">saapumisaikaa ei ole</span>';

  const lahde = plan.travelMinutes === null
    ? ''
    : ` · ${plan.travelMinutes} min `
      + (plan.travelSource === TRAVEL_SOURCE.MANUAL ? '(itse kirjattu)' : '');

  return `
    <div class="assist-row">
      <div class="assist-title">${escapeHtml(plan.title)}</div>
      <div class="assist-meta">
        <span class="assist-tag">${escapeHtml(travelModeLabel(plan.mode))}</span>
        ${mistaMinne ? `${mistaMinne} · ` : ''}perillä ${perilla}${escapeHtml(lahde)}
      </div>
      ${leaveByHtml(plan)}
      <div class="assist-actions">
        <button class="assist-btn" data-travel-edit="${escapeHtml(plan.id)}">Muokkaa</button>
        <button class="assist-btn danger" data-travel-delete="${escapeHtml(plan.id)}">Poista</button>
      </div>
    </div>`;
}

function providerNoteHtml() {
  if (hasTravelProvider()) return '';
  return `
    <p class="hint">
      <strong>Matka-aikaa ei haeta mistään.</strong> Reittipalvelua ei ole
      kytketty, joten kesto on se minkä kirjaat itse. Tuntematon kesto
      näytetään tuntemattomana — lähtöaikaa ei arvata.
    </p>`;
}

// =====================================================================
// PAIKKAMUISTUTUKSET
// =====================================================================

function ruleRowHtml(rule) {
  return `
    <div class="assist-row${rule.active ? '' : ' is-closed'}">
      <div class="assist-title">${escapeHtml(rule.place)}</div>
      <div class="assist-meta">
        <span class="assist-tag${rule.active ? '' : ' tone-warn'}">
          ${rule.active ? 'Päällä — ei vielä laukea' : 'Pois päältä'}
        </span>
        ${escapeHtml(TRIGGER_LABELS[rule.trigger] || rule.trigger)}
      </div>
      ${rule.message ? `<div class="assist-reason">${escapeHtml(rule.message)}</div>` : ''}
      <div class="assist-actions">
        <button class="assist-btn${rule.active ? '' : ' primary'}"
                data-rule-toggle="${escapeHtml(rule.id)}"
                data-active="${rule.active ? 'false' : 'true'}">
          ${rule.active ? 'Kytke pois' : 'Kytke päälle'}
        </button>
        <button class="assist-btn" data-rule-edit="${escapeHtml(rule.id)}">Muokkaa</button>
        <button class="assist-btn danger" data-rule-delete="${escapeHtml(rule.id)}">Poista</button>
      </div>
    </div>`;
}

// =====================================================================
// RENDERÖINTI
// =====================================================================

export function renderTravel() {
  fillSelectOptions();

  const state = getState();

  // Aiemmin käytetyt paikannimet ehdotuksina. Ei historiaa eikä koordinaatteja.
  const suggestions = maybe('tvPlaceSuggestions');
  if (suggestions) {
    suggestions.replaceChildren(...suggestPlaces(state.travelPlans, state.locationRules).map(name => {
      const option = document.createElement('option');
      option.value = name;
      return option;
    }));
  }

  const plans = maybe('travelListContainer');
  if (plans) {
    const sorted = [...state.travelPlans].sort((a, b) =>
      String(a.arrivalDate || '').localeCompare(String(b.arrivalDate || ''))
      || String(a.arrivalTime || '').localeCompare(String(b.arrivalTime || '')));

    const varoitus = isTableAvailable('travelPlans')
      ? ''
      : hasTable('travelPlans')
        ? serverUnavailableHintHtml()
        : `<p class="hint"><strong>Huom.</strong> Matkat säilyvät toistaiseksi `
          + `vain tämän istunnon ajan.</p>`;

    plans.innerHTML = '<h2 class="section-title">Matkat</h2>'
      + providerNoteHtml() + varoitus
      + (sorted.length === 0
        ? `<div class="assist-empty">Ei matkoja. Lisää matka, niin lasken `
          + `lähtöajan — jos kerrot kuinka kauan matka kestää.</div>`
        : sorted.map(planRowHtml).join(''));
  }

  const rules = maybe('locationRulesContainer');
  if (rules) {
    const sorted = [...state.locationRules].sort((a, b) =>
      String(a.place || '').localeCompare(String(b.place || ''), 'fi'));

    const varoitus = isTableAvailable('locationRules')
      ? ''
      : hasTable('locationRules')
        ? serverUnavailableHintHtml()
        : `<p class="hint"><strong>Huom.</strong> Paikkamuistutukset säilyvät `
          + `toistaiseksi vain tämän istunnon ajan.</p>`;

    rules.innerHTML = varoitus
      + (sorted.length === 0
        ? `<div class="assist-empty">Ei paikkamuistutuksia.</div>`
        : sorted.map(ruleRowHtml).join(''));
  }
}

// =====================================================================
// MATKALOMAKE
// =====================================================================

function clearErrors(formId) {
  document.querySelectorAll(`#${formId} .field-error`).forEach(node => {
    node.textContent = '';
    node.style.display = 'none';
  });
}

function showErrors(prefix, errors) {
  for (const [field, message] of Object.entries(errors || {})) {
    const node = maybe(`${prefix}${field.charAt(0).toUpperCase()}${field.slice(1)}Error`);
    if (node) {
      node.textContent = message;
      node.style.display = 'block';
    }
  }
}

function fillTravelTaskSelect(selected) {
  const select = maybe('tvTask');
  if (!select) return;
  const tasks = getState().tasks.filter(t => !t.completed);
  select.innerHTML = '<option value="">Ei liitosta</option>'
    + tasks.map(t => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.title)}</option>`).join('');
  select.value = selected || '';
}

export function openTravelForm(id = null) {
  fillSelectOptions();
  const plan = id ? findTravelPlan(id) : null;

  setEditingTravelPlanId(id);
  clearErrors('travelForm');

  setText('travelFormTitle', plan ? 'Muokkaa matkaa' : 'Uusi matka');
  el('tvTitle').value = plan ? plan.title : '';
  el('tvOrigin').value = (plan && plan.origin) || '';
  el('tvDestination').value = (plan && plan.destination) || '';
  el('tvDate').value = (plan && plan.arrivalDate) || fmtISO(todayMidnight());
  el('tvTime').value = (plan && plan.arrivalTime) || '';
  el('tvMode').value = (plan && plan.mode) || TRAVEL_MODE.DRIVING;
  // TYHJÄ ON TUNTEMATON, EI NOLLA. Kenttä jätetään tyhjäksi eikä
  // täytetä nollalla, koska nolla tarkoittaisi "ollaan jo perillä".
  el('tvMinutes').value = plan && plan.travelMinutes !== null
    ? String(plan.travelMinutes) : '';
  el('tvPrep').value = plan ? String(plan.preparationMinutes) : '';
  el('tvBuffer').value = plan ? String(plan.arrivalBufferMinutes) : '';

  fillTravelTaskSelect(plan && plan.taskId);

  toggle('tvDelete', Boolean(plan));
  toggle('travelForm', true);
  toggle('addTravelBtn', false);
  focus('tvTitle');
}

export function closeTravelForm() {
  setEditingTravelPlanId(null);
  clearErrors('travelForm');
  toggle('travelForm', false);
  toggle('addTravelBtn', true);
}

function travelValues() {
  const minutes = el('tvMinutes').value.trim();
  const prep = el('tvPrep').value.trim();
  const buffer = el('tvBuffer').value.trim();

  return {
    title: el('tvTitle').value,
    origin: el('tvOrigin').value || null,
    destination: el('tvDestination').value || null,
    arrivalDate: el('tvDate').value || null,
    arrivalTime: el('tvTime').value || null,
    mode: el('tvMode').value,
    // Tyhjä kenttä on TUNTEMATON. `null` kulkee normalisointiin asti
    // sellaisenaan, eikä siitä tule nollaa.
    travelMinutes: minutes === '' ? null : Number(minutes),
    travelSource: minutes === '' ? TRAVEL_SOURCE.UNKNOWN : TRAVEL_SOURCE.MANUAL,
    estimatedAt: minutes === '' ? null : new Date().toISOString(),
    preparationMinutes: prep === '' ? null : Number(prep),
    arrivalBufferMinutes: buffer === '' ? null : Number(buffer),
    taskId: el('tvTask').value || null
  };
}

async function submitTravelForm() {
  clearErrors('travelForm');

  const editingId = getState().editingTravelPlanId;
  const values = travelValues();

  const result = editingId
    ? await editTravelPlan(editingId, values)
    : await createTravelPlan(values);

  if (!result.ok) {
    if (result.errors) showErrors('tv', result.errors);
    return;
  }
  closeTravelForm();
}

// =====================================================================
// PAIKKAMUISTUTUSLOMAKE
// =====================================================================

export function openLocationRuleForm(id = null) {
  fillSelectOptions();
  const rule = id ? findLocationRule(id) : null;

  setEditingLocationRuleId(id);
  clearErrors('locationRuleForm');

  setText('locationRuleFormTitle',
    rule ? 'Muokkaa paikkamuistutusta' : 'Uusi paikkamuistutus');
  el('lrPlace').value = rule ? rule.place || '' : '';
  el('lrTrigger').value = (rule && rule.trigger) || LOCATION_TRIGGER.ARRIVING;
  el('lrMessage').value = (rule && rule.message) || '';

  toggle('lrDelete', Boolean(rule));
  toggle('locationRuleForm', true);
  toggle('addLocationRuleBtn', false);
  focus('lrPlace');
}

export function closeLocationRuleForm() {
  setEditingLocationRuleId(null);
  clearErrors('locationRuleForm');
  toggle('locationRuleForm', false);
  toggle('addLocationRuleBtn', true);
}

async function submitLocationRuleForm() {
  clearErrors('locationRuleForm');

  const editingId = getState().editingLocationRuleId;
  const values = {
    place: el('lrPlace').value,
    trigger: el('lrTrigger').value,
    message: el('lrMessage').value || null
    // `active` EI OLE TÄSSÄ. Uusi sääntö on aina pois päältä, ja
    // päälle kytkeminen on oma tekonsa joka kysyy vahvistuksen.
  };

  const result = editingId
    ? await editLocationRule(editingId, values)
    : await createLocationRule(values);

  if (!result.ok) {
    if (result.errors) showErrors('lr', result.errors);
    return;
  }
  closeLocationRuleForm();
}

// =====================================================================
// TAPAHTUMAT
// =====================================================================

export function initTravelForms() {
  fillSelectOptions();

  const addTravel = maybe('addTravelBtn');
  if (addTravel) addTravel.addEventListener('click', () => openTravelForm(null));

  const tvCancel = maybe('tvCancel');
  if (tvCancel) tvCancel.addEventListener('click', closeTravelForm);

  const tvSave = maybe('tvSave');
  if (tvSave) tvSave.addEventListener('click', submitTravelForm);

  const tvDelete = maybe('tvDelete');
  if (tvDelete) {
    tvDelete.addEventListener('click', async () => {
      const editingId = getState().editingTravelPlanId;
      if (!editingId) return;
      if (await deleteTravelPlan(editingId)) closeTravelForm();
    });
  }

  const addRule = maybe('addLocationRuleBtn');
  if (addRule) addRule.addEventListener('click', () => openLocationRuleForm(null));

  const lrCancel = maybe('lrCancel');
  if (lrCancel) lrCancel.addEventListener('click', closeLocationRuleForm);

  const lrSave = maybe('lrSave');
  if (lrSave) lrSave.addEventListener('click', submitLocationRuleForm);

  const lrDelete = maybe('lrDelete');
  if (lrDelete) {
    lrDelete.addEventListener('click', async () => {
      const editingId = getState().editingLocationRuleId;
      if (!editingId) return;
      if (await deleteLocationRule(editingId)) closeLocationRuleForm();
    });
  }

  const plans = maybe('travelListContainer');
  if (plans) plans.addEventListener('click', onPlanListClick);

  const rules = maybe('locationRulesContainer');
  if (rules) rules.addEventListener('click', onRuleListClick);
}

async function onPlanListClick(event) {
  const save = event.target.closest('[data-estimate-save]');
  if (save) {
    const id = save.dataset.estimateSave;
    const input = maybe(`est-${id}`);
    if (!input) return;
    await setTravelEstimate(id, Number(input.value));
    return;
  }

  const edit = event.target.closest('[data-travel-edit]');
  if (edit) { openTravelForm(edit.dataset.travelEdit); return; }

  const remove = event.target.closest('[data-travel-delete]');
  if (remove) { await deleteTravelPlan(remove.dataset.travelDelete); }
}

async function onRuleListClick(event) {
  const toggleBtn = event.target.closest('[data-rule-toggle]');
  if (toggleBtn) {
    await toggleLocationRule(toggleBtn.dataset.ruleToggle,
      toggleBtn.dataset.active === 'true');
    return;
  }

  const edit = event.target.closest('[data-rule-edit]');
  if (edit) { openLocationRuleForm(edit.dataset.ruleEdit); return; }

  const remove = event.target.closest('[data-rule-delete]');
  if (remove) { await deleteLocationRule(remove.dataset.ruleDelete); }
}
