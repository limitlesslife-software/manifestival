// Suunta-näkymä: elämänalueet, viikon kapasiteetti, suunnitelma vs.
// toteuma, havainnot ja viikkokatsaus.
//
// Näkymä ei laske mitään itse: yksi analyzeCurrentWeek()-kutsu per
// renderöinti, ja jokainen osio lukee saman tuloksen. Havainnon
// vakavuus kerrotaan aina TEKSTINÄ (ei vain värillä), ja jokaisella
// havainnolla on "Miksi?"-osio, joka näyttää säännön ja luvut.
//
// Sävy on toteava. Tämä ei ole suorituspisteytys: valmistumisprosenttia
// ei näytetä pääviestinä missään.

import { el, maybe, toggle, setText, focus } from '../../ui/dom.js';
import { escapeHtml } from '../../lib/format.js';
import { fmtISO, todayMidnight } from '../../lib/datetime.js';
import { getState, findLifeArea } from '../state.js';
import { switchTab } from '../navigation.js';
import { CATEGORIES } from '../../domain/categories.js';
import {
  SUGGESTED_AREAS, importanceLabel, formatMinutes, compareLifeAreas, countOf
} from '../../domain/lifeArea.js';
import { weekDates, weekStartOf, capacityWarnings, capacityForWeek } from '../../domain/weeklyCapacity.js';
import { entriesInRange } from '../../domain/timeEntry.js';
import { SIGNAL, SEVERITY, SEVERITY_LABELS, QUALITY, primarySignal } from '../../domain/alignment.js';
import { explainSignal, REVIEW_QUESTIONS, ADJUSTMENT } from '../../domain/alignmentReview.js';
import { addDaysIso } from '../../domain/fiTemporal.js';
import {
  analyzeCurrentWeek, currentProposals, currentWeekStart, alignmentPersistence,
  createLifeArea, editLifeArea, deleteLifeArea, assignGoalToLifeArea,
  saveWeeklyCapacity, logTime, deleteTimeEntry, saveWeeklyReview, applyAdjustment
} from '../alignment.js';

/** Näytettävä viikko (maanantai). null = tämä viikko. Näkymän oma tila. */
let viewWeek = null;
/** Muokattavan alueen tunniste; null = uusi. */
let editingAreaId = null;
/** Viimeksi näytetyt ehdotukset: painike viittaa tunnisteella. */
let shownProposals = [];

const OPEN_GOAL_STATUSES = new Set(['active', 'paused', 'maintenance']);

function shownWeek() {
  return viewWeek || currentWeekStart();
}

// ---------------------------------------------------------- muotoilu

function shortDate(iso) {
  const [, month, day] = iso.split('-').map(Number);
  return `${day}.${month}.`;
}

function weekLabel(weekStart) {
  const dates = weekDates(weekStart);
  if (dates.length === 0) return '';
  const year = dates[6].slice(0, 4);
  return `${shortDate(dates[0])}–${shortDate(dates[6])}${year}`;
}

function hours(minutes) {
  return Number.isFinite(minutes) ? formatMinutes(minutes) : '–';
}

function toMinutesFromHours(value) {
  if (value === '' || value === null || value === undefined) return null;
  const number = Number(String(value).replace(',', '.'));
  return Number.isFinite(number) ? Math.round(number * 60) : NaN;
}

function toHoursInput(minutes) {
  return Number.isInteger(minutes) ? String(Math.round((minutes / 60) * 100) / 100) : '';
}

/** Virheilmoitus näkyviin tai piiloon. .field-error on oletuksena piilossa. */
function setError(id, message) {
  const node = maybe(id);
  if (!node) return;
  node.textContent = message || '';
  node.style.display = message ? 'block' : 'none';
}

function severityClass(severity) {
  return severity === SEVERITY.STRONG ? 'dir-strong'
    : severity === SEVERITY.ATTENTION ? 'dir-attention' : 'dir-info';
}

// ---------------------------------------------------------- osiot

function persistNoteHtml() {
  const persistence = alignmentPersistence();
  if (Object.values(persistence).every(Boolean)) return '';
  return '<p class="hint"><strong>Huom.</strong> Suunnan tiedot (elämänalueet, kapasiteetti, '
    + 'kirjattu aika ja katsaukset) säilyvät toistaiseksi vain tämän istunnon ajan.</p>';
}

const QUALITY_REASONS = Object.freeze({
  no_areas: 'elämänalueita ei ole määritelty',
  no_targets: 'alueilla ei ole aikatavoitteita',
  no_capacity: 'viikon kapasiteettia ei ole asetettu',
  unestimated_work: 'osalta työstä puuttuu kestoarvio',
  unassigned_work: 'osa työstä ei kuulu mihinkään alueeseen',
  no_actual: 'toteutunutta aikaa ei ole kirjattu',
  unassigned_actual: 'osa kirjatusta ajasta ei kuulu mihinkään alueeseen'
});

const QUALITY_LABELS = Object.freeze({
  [QUALITY.GOOD]: 'Kattava',
  [QUALITY.PARTIAL]: 'Osittainen',
  [QUALITY.WEAK]: 'Vajaa',
  [QUALITY.NONE]: 'Ei aineistoa'
});

function qualityHtml(analysis) {
  const quality = analysis.dataQuality;
  if (quality.level === QUALITY.GOOD) return '';
  const reasons = quality.reasons.map(code => QUALITY_REASONS[code]).filter(Boolean);
  return `<p class="hint dir-quality"><strong>Aineisto: ${escapeHtml(QUALITY_LABELS[quality.level])}.</strong> `
    + `${escapeHtml(reasons.join(', '))}. Havainnot perustuvat vain siihen mitä on tiedossa.</p>`;
}

function signalHtml(signal, areas) {
  const text = explainSignal(signal, areas);
  const metrics = Object.entries(signal.metrics || {})
    .map(([key, value]) => `${escapeHtml(key)}: ${escapeHtml(String(value))}`).join(' · ');
  return `
    <div class="dir-signal ${severityClass(signal.severity)}">
      <div class="dir-signal-head">
        <span class="dir-severity">${escapeHtml(SEVERITY_LABELS[signal.severity])}</span>
        <span class="dir-signal-title">${escapeHtml(text.title)}</span>
      </div>
      <div class="dir-signal-text">${escapeHtml(text.text)}</div>
      <details class="dir-why">
        <summary>Miksi tämä näkyy?</summary>
        <p>${escapeHtml(text.why)}</p>
        <p class="dir-rule">Sääntö: ${escapeHtml(signal.rule)} · perusta: ${escapeHtml(signal.basis)}<br>${metrics}</p>
      </details>
    </div>`;
}

function signalsHtml(analysis, areas) {
  if (areas.length === 0) {
    return '<div class="assist-empty">Havainnot alkavat, kun kerrot mikä sinulle on tärkeää. '
      + 'Aloita elämänalueista alempana.</div>';
  }
  const list = analysis.signals.length === 0
    ? '<div class="assist-empty">Ei havaintoja tällä viikolla sen perusteella, mitä on tiedossa.</div>'
    : analysis.signals.map(signal => signalHtml(signal, areas)).join('');
  return list + qualityHtml(analysis);
}

/** Palkki: suunniteltu vs. kapasiteetti. Tekstivastine on aina näkyvissä. */
function barHtml({ value, max, label }) {
  if (!Number.isFinite(max) || max <= 0) return '';
  const percent = Math.round((value / max) * 100);
  const width = Math.min(100, Math.max(0, percent));
  const over = value > max;
  return `
    <div class="dir-bar${over ? ' is-over' : ''}" role="img" aria-label="${escapeHtml(label)}">
      <div class="dir-bar-fill" style="width:${width}%"></div>
    </div>`;
}

function weekSummaryHtml(analysis) {
  const { planned, actual, capacity } = analysis;
  const parts = [];
  if (capacity.declared) {
    const label = `Suunniteltu ${hours(planned.knownMinutes)}, kapasiteetti ${hours(capacity.availableMinutes)}`;
    parts.push(barHtml({ value: planned.knownMinutes, max: capacity.availableMinutes, label }));
    const remaining = capacity.remainingMinutes;
    parts.push(`<p class="dir-line">${escapeHtml(label)} · `
      + (remaining >= 0 ? `jäljellä ${escapeHtml(hours(remaining))}` : `yli ${escapeHtml(hours(-remaining))}`)
      + '</p>');
  } else {
    parts.push(`<p class="dir-line">Suunniteltu ${escapeHtml(hours(planned.knownMinutes))}. `
      + 'Aseta kapasiteetti alla, niin näet mahtuuko se viikkoon.</p>');
  }
  if (planned.unknownCount > 0) {
    parts.push(`<p class="dir-line dir-unknown">${countOf(planned.unknownCount, 'asia', 'asiaa')} ilman kestoarviota — `
      + 'niitä ei ole laskettu mukaan (tuntematon ei ole nolla).</p>');
  }
  parts.push(actual.entryCount > 0
    ? `<p class="dir-line">Kirjattu toteuma ${escapeHtml(hours(actual.minutes))}, ${actual.daysWithEntries} päivänä.</p>`
    : '<p class="dir-line">Toteutunutta aikaa ei ole kirjattu tälle viikolle.</p>');
  if (capacity.energyLevel) {
    parts.push(`<p class="dir-line">Oma energia-arvio: ${capacity.energyLevel}/5.</p>`);
  }
  return parts.join('');
}

function suggestionsHtml(areas) {
  if (areas.length > 0) return '';
  const chips = SUGGESTED_AREAS.map(suggestion =>
    `<button class="assist-btn" type="button" data-area-suggest="${escapeHtml(suggestion.name)}"`
    + ` data-category="${escapeHtml(suggestion.categoryKey || '')}">+ ${escapeHtml(suggestion.name)}</button>`).join('');
  return `<p class="hint">Mitkä elämäsi alueet ovat sinulle tärkeitä? Valitse valmis nimi tai kirjoita oma. `
    + 'Mitään ei luoda ennen kuin tallennat.</p>'
    + `<div class="assist-actions dir-chips">${chips}</div>`;
}

function areaRowHtml(area, row) {
  const target = Number.isInteger(area.targetMinutesPerWeek)
    ? `tavoite ${escapeHtml(hours(area.targetMinutesPerWeek))}/vko` : 'ei aikatavoitetta';
  const desired = row && row.desiredPercent !== null ? ` (${row.desiredPercent} % tavoitteista)` : '';
  const plannedLine = row
    ? `Suunniteltu ${escapeHtml(hours(row.plannedMinutes))}`
      + (row.plannedUnknown > 0 ? ` + ${row.plannedUnknown} arvioimatonta` : '')
      + ` · toteuma ${escapeHtml(hours(row.actualMinutes))}`
    : '';
  const bar = row && Number.isInteger(area.targetMinutesPerWeek) && area.targetMinutesPerWeek > 0
    ? barHtml({
      value: row.actualMinutes > 0 ? row.actualMinutes : row.plannedMinutes,
      max: area.targetMinutesPerWeek,
      label: `${area.name}: ${row.actualMinutes > 0 ? 'toteuma' : 'suunniteltu'} `
        + `${hours(row.actualMinutes > 0 ? row.actualMinutes : row.plannedMinutes)} / tavoite ${hours(area.targetMinutesPerWeek)}`
    })
    : '';
  const category = area.categoryKey
    ? ` · kategoria ${escapeHtml(CATEGORIES.find(c => c.key === area.categoryKey)?.label || area.categoryKey)}` : '';
  return `
    <div class="assist-row${area.active ? '' : ' is-closed'}">
      <div class="assist-title">${escapeHtml(area.name)}${area.active ? '' : ' (pois käytöstä)'}</div>
      <div class="assist-meta">
        <span class="assist-tag">${escapeHtml(importanceLabel(area.importance))}</span>
        ${target}${escapeHtml(desired)}${category}
      </div>
      ${plannedLine ? `<div class="assist-reason">${plannedLine}</div>` : ''}
      ${bar}
      <div class="assist-actions">
        <button class="assist-btn" type="button" data-area-edit="${escapeHtml(area.id)}">Muokkaa</button>
      </div>
    </div>`;
}

function areasHtml(areas, analysis) {
  const rows = new Map(analysis.areas.map(row => [row.id, row]));
  return [...areas].sort(compareLifeAreas).map(area => areaRowHtml(area, rows.get(area.id))).join('');
}

function areaOptions(areas, selected, emptyLabel) {
  return `<option value="">${escapeHtml(emptyLabel)}</option>`
    + [...areas].sort(compareLifeAreas).map(area =>
      `<option value="${escapeHtml(area.id)}"${area.id === selected ? ' selected' : ''}>`
      + `${escapeHtml(area.name)}${area.active ? '' : ' (pois käytöstä)'}</option>`).join('');
}

function goalsHtml(areas, goals) {
  const open = goals.filter(goal => OPEN_GOAL_STATUSES.has(goal.status));
  if (open.length === 0) {
    return '<div class="assist-empty">Ei avoimia tavoitteita. Tavoitteet luodaan Tavoitteet-välilehdellä.</div>';
  }
  const areaIds = new Set(areas.map(area => area.id));
  const unassigned = open.filter(goal => !goal.lifeAreaId || !areaIds.has(goal.lifeAreaId));
  const groups = [];
  if (unassigned.length > 0) {
    groups.push({ title: 'Ei elämänaluetta', hint: 'Valitse alue, niin tavoitteen työ näkyy oikeassa paikassa.', goals: unassigned });
  }
  for (const area of [...areas].sort(compareLifeAreas)) {
    const inArea = open.filter(goal => goal.lifeAreaId === area.id);
    if (inArea.length > 0) groups.push({ title: area.name, hint: '', goals: inArea });
  }
  return groups.map(group => `
    <div class="dir-goal-group">
      <h3 class="dir-subtitle">${escapeHtml(group.title)}</h3>
      ${group.hint ? `<p class="hint">${escapeHtml(group.hint)}</p>` : ''}
      ${group.goals.map(goal => `
        <div class="dir-goal-row">
          <label class="field-label" for="dirGoalArea-${escapeHtml(goal.id)}">${escapeHtml(goal.title)}</label>
          <select id="dirGoalArea-${escapeHtml(goal.id)}" data-goal-area="${escapeHtml(goal.id)}">
            ${areaOptions(areas, goal.lifeAreaId, 'Ei elämänaluetta')}
          </select>
        </div>`).join('')}
    </div>`).join('');
}

function timeListHtml(entries, areas) {
  if (entries.length === 0) return '';
  const byId = new Map(areas.map(area => [area.id, area]));
  return [...entries].sort((a, b) => b.entryDate.localeCompare(a.entryDate)).map(entry => `
    <div class="assist-row">
      <div class="assist-meta">
        ${escapeHtml(shortDate(entry.entryDate))} · ${escapeHtml(hours(entry.minutes))}
        · ${escapeHtml(entry.lifeAreaId && byId.has(entry.lifeAreaId) ? byId.get(entry.lifeAreaId).name : 'Ei aluetta')}
      </div>
      ${entry.note ? `<div class="assist-reason">${escapeHtml(entry.note)}</div>` : ''}
      <div class="assist-actions">
        <button class="assist-btn danger" type="button" data-time-delete="${escapeHtml(entry.id)}"
          aria-label="Poista kirjaus ${escapeHtml(shortDate(entry.entryDate))} ${escapeHtml(hours(entry.minutes))}">Poista</button>
      </div>
    </div>`).join('');
}

function signalsOfKind(analysis, kind, areas) {
  return analysis.signals.filter(signal => signal.kind === kind)
    .map(signal => explainSignal(signal, areas).text);
}

function reviewHtml(analysis, areas) {
  const active = [...areas].filter(area => area.active)
    .sort((a, b) => b.importance - a.importance || compareLifeAreas(a, b));
  const answers = [
    active.length === 0 ? 'Elämänalueita ei ole määritelty.'
      : active.map(area => `${area.name}: ${importanceLabel(area.importance).toLowerCase()}`
        + (Number.isInteger(area.targetMinutesPerWeek) ? `, tavoite ${hours(area.targetMinutesPerWeek)}` : '')).join(' · '),
    `Arvioitua työtä ${hours(analysis.planned.knownMinutes)}`
      + (analysis.planned.unknownCount > 0 ? `, lisäksi ${analysis.planned.unknownCount} ilman arviota` : '')
      + (analysis.capacity.declared ? `; kapasiteetti ${hours(analysis.capacity.availableMinutes)}.` : '; kapasiteettia ei asetettu.'),
    analysis.actual.entryCount > 0
      ? `Kirjattu ${hours(analysis.actual.minutes)} (${analysis.actual.daysWithEntries} päivää).`
      : 'Aikaa ei kirjattu, joten toteumaa ei voi arvioida.',
    signalsOfKind(analysis, SIGNAL.OVERLOAD, areas).join(' ')
      || (analysis.capacity.declared ? 'Suunnitelma mahtui kapasiteettiin.' : 'Ei arvioitavissa ilman kapasiteettia.'),
    signalsOfKind(analysis, SIGNAL.NEGLECT, areas).join(' ') || 'Yksikään tärkeä alue ei jäänyt selvästi vajaaksi.',
    [...signalsOfKind(analysis, SIGNAL.MISALIGNMENT, areas), ...signalsOfKind(analysis, SIGNAL.TARGET_TENSION, areas)].join(' ')
      || 'Ei merkittäviä poikkeamia toivomastasi jakaumasta sen perusteella, mitä on tiedossa.'
  ];
  return `<dl class="dir-review">${REVIEW_QUESTIONS.slice(0, 6).map((question, index) =>
    `<dt>${escapeHtml(question)}</dt><dd>${escapeHtml(answers[index])}</dd>`).join('')}</dl>`;
}

function proposalInput(proposal) {
  if (proposal.type === ADJUSTMENT.CHANGE_TARGET) {
    return `<label class="field-label" for="dirAdj-${escapeHtml(proposal.id)}">Uusi tavoite tunteina</label>`
      + `<input type="number" min="0" max="168" step="0.5" id="dirAdj-${escapeHtml(proposal.id)}"`
      + ` data-adjust-value="${escapeHtml(proposal.id)}" value="${escapeHtml(toHoursInput(proposal.payload.to))}">`;
  }
  if (proposal.type === ADJUSTMENT.SET_CAPACITY) {
    return `<label class="field-label" for="dirAdj-${escapeHtml(proposal.id)}">Ensi viikon kapasiteetti tunteina</label>`
      + `<input type="number" min="0" max="168" step="0.5" id="dirAdj-${escapeHtml(proposal.id)}"`
      + ` data-adjust-value="${escapeHtml(proposal.id)}" value="${escapeHtml(toHoursInput(proposal.payload.availableMinutes))}">`;
  }
  return '';
}

function proposalsHtml(proposals) {
  if (proposals.length === 0) {
    return '<div class="assist-empty">Ei ehdotuksia. Voit silti kirjata pohdintasi.</div>';
  }
  return proposals.map(proposal => `
    <div class="assist-row">
      <div class="assist-title">${escapeHtml(proposal.label)}</div>
      ${proposal.detail ? `<div class="assist-reason">${escapeHtml(proposal.detail)}</div>` : ''}
      ${proposalInput(proposal)}
      <div class="assist-actions">
        <button class="assist-btn primary" type="button" data-adjust="${escapeHtml(proposal.id)}">Tee muutos…</button>
      </div>
    </div>`).join('');
}

function historyHtml(reviews) {
  const past = [...reviews].sort((a, b) => b.weekStart.localeCompare(a.weekStart));
  if (past.length === 0) return '<div class="assist-empty">Ei tallennettuja katsauksia.</div>';
  return past.map(review => {
    const snapshot = review.snapshot || {};
    const signals = Array.isArray(snapshot.signals) ? snapshot.signals.length : 0;
    const areas = Array.isArray(snapshot.areas) ? snapshot.areas : [];
    const rows = areas.filter(area => area.active).map(area =>
      `<li>${escapeHtml(area.name)}: tavoite ${escapeHtml(area.desiredPercent === null || area.desiredPercent === undefined ? '–' : area.desiredPercent + ' %')}, `
      + `toteuma ${escapeHtml(area.actualPercent === null || area.actualPercent === undefined ? '–' : area.actualPercent + ' %')}</li>`).join('');
    return `
      <details class="dir-history">
        <summary>Viikko ${escapeHtml(weekLabel(review.weekStart))} · ${signals} havaintoa</summary>
        ${snapshot.capacity && Number.isInteger(snapshot.capacity.availableMinutes)
          ? `<p class="dir-line">Kapasiteetti ${escapeHtml(hours(snapshot.capacity.availableMinutes))}</p>` : ''}
        ${rows ? `<ul>${rows}</ul>` : ''}
        ${review.reflection ? `<p class="assist-reason">${escapeHtml(review.reflection)}</p>` : ''}
        ${review.adjustments.length ? `<p class="dir-line">Valitut muutokset: ${review.adjustments.length}</p>` : ''}
      </details>`;
  }).join('');
}

// ------------------------------------------------------ renderöinti

export function renderDirection() {
  if (!maybe('screen-direction')) return;
  const state = getState();
  const week = shownWeek();
  const analysis = analyzeCurrentWeek(week);
  const areas = state.lifeAreas;

  setText('dirWeekLabel', weekLabel(analysis.weekStart));
  toggle('dirThisWeek', analysis.weekStart !== currentWeekStart());
  el('dirPersistNote').innerHTML = persistNoteHtml();
  el('dirSignals').innerHTML = signalsHtml(analysis, areas);
  el('dirWeekSummary').innerHTML = weekSummaryHtml(analysis);
  el('dirAreaSuggestions').innerHTML = suggestionsHtml(areas);
  el('dirAreasList').innerHTML = areasHtml(areas, analysis);
  el('dirGoalsList').innerHTML = goalsHtml(areas, state.goals);

  const dates = weekDates(analysis.weekStart);
  el('dirTimeList').innerHTML = timeListHtml(entriesInRange(state.timeEntries, dates[0], dates[6]), areas);
  const timeArea = el('dirTimeArea');
  const chosenArea = timeArea.value;
  timeArea.innerHTML = areaOptions(areas.filter(area => area.active), chosenArea, 'Ei aluetta');

  // Lomakkeen arvoja ei ylikirjoiteta kesken kirjoittamisen.
  const capacity = capacityForWeek(state.weeklyCapacities, analysis.weekStart);
  const hoursInput = el('dirCapacityHours');
  if (document.activeElement !== hoursInput) hoursInput.value = capacity ? toHoursInput(capacity.availableMinutes) : '';
  const energy = el('dirEnergy');
  if (document.activeElement !== energy) energy.value = capacity && capacity.energyLevel ? String(capacity.energyLevel) : '';
  const timeDate = el('dirTimeDate');
  if (!timeDate.value || !dates.includes(timeDate.value)) {
    const today = fmtISO(todayMidnight());
    timeDate.value = dates.includes(today) ? today : dates[0];
  }

  el('dirReview').innerHTML = reviewHtml(analysis, areas);
  const existingReview = state.alignmentReviews.find(review => review.weekStart === analysis.weekStart);
  const reflection = el('dirReflection');
  if (document.activeElement !== reflection && existingReview && !reflection.dataset.dirty) {
    reflection.value = existingReview.reflection || '';
  }
  shownProposals = currentProposals(analysis);
  el('dirProposals').innerHTML = proposalsHtml(shownProposals);
  el('dirReviewHistory').innerHTML = historyHtml(state.alignmentReviews);
}

/**
 * Päivänäkymän kevyt kortti: yksi havainto, ei kaavioita.
 */
export function renderTodayDirection() {
  const container = maybe('todayDirection');
  if (!container) return;
  const state = getState();
  if (state.lifeAreas.length === 0) {
    container.innerHTML = `<div class="dir-today">
      <div class="dir-today-title">Suunta</div>
      <p class="dir-line">Kerro mikä elämässäsi on tärkeää, niin näet elääkö viikko sen mukaan.</p>
      <button class="assist-btn" type="button" data-open-direction="1">Avaa Suunta</button></div>`;
    return;
  }
  const analysis = analyzeCurrentWeek(null);
  const signal = primarySignal(analysis);
  const lines = [];
  if (analysis.capacity.declared) {
    const remaining = analysis.capacity.remainingMinutes;
    lines.push(remaining >= 0
      ? `Viikon kapasiteettia jäljellä ${hours(remaining)}.`
      : `Suunnitelma ylittää viikon kapasiteetin ${hours(-remaining)}.`);
  }
  if (signal) {
    const text = explainSignal(signal, state.lifeAreas);
    lines.push(`${SEVERITY_LABELS[signal.severity]}: ${text.title}.`);
  }
  if (analysis.unassigned.plannedItems > 0) {
    lines.push(analysis.unassigned.plannedItems === 1
      ? '1 viikon asia ei kuulu mihinkään alueeseen.'
      : `${analysis.unassigned.plannedItems} viikon asiaa ei kuulu mihinkään alueeseen.`);
  }
  if (lines.length === 0) lines.push('Ei havaintoja tällä viikolla.');
  container.innerHTML = `<div class="dir-today">
    <div class="dir-today-title">Suunta</div>
    ${lines.map(line => `<p class="dir-line">${escapeHtml(line)}</p>`).join('')}
    <button class="assist-btn" type="button" data-open-direction="1">Avaa Suunta</button></div>`;
}

// ------------------------------------------------------ lomakkeet

function fillCategorySelect(selected) {
  const select = el('dirAreaCategory');
  const taken = new Set(getState().lifeAreas
    .filter(area => area.id !== editingAreaId && area.categoryKey).map(area => area.categoryKey));
  select.innerHTML = '<option value="">Ei kategoriaa</option>'
    + CATEGORIES.map(category => `<option value="${escapeHtml(category.key)}"`
      + `${category.key === selected ? ' selected' : ''}${taken.has(category.key) ? ' disabled' : ''}>`
      + `${escapeHtml(category.label)}${taken.has(category.key) ? ' (käytössä)' : ''}</option>`).join('');
}

function clearAreaErrors() {
  for (const id of ['dirAreaNameError', 'dirAreaImportanceError', 'dirAreaTargetError', 'dirAreaCategoryError']) {
    setError(id, '');
  }
}

export function openAreaForm(id = null, prefill = {}) {
  const area = id ? findLifeArea(id) : null;
  editingAreaId = area ? area.id : null;
  clearAreaErrors();
  setText('dirAreaFormTitle', area ? 'Muokkaa elämänaluetta' : 'Uusi elämänalue');
  el('dirAreaName').value = area ? area.name : (prefill.name || '');
  el('dirAreaImportance').value = String(area ? area.importance : 3);
  el('dirAreaTarget').value = area ? toHoursInput(area.targetMinutesPerWeek) : '';
  fillCategorySelect(area ? area.categoryKey : (prefill.categoryKey || ''));
  el('dirAreaDescription').value = area && area.description ? area.description : '';
  el('dirAreaActive').checked = area ? area.active : true;
  toggle('dirAreaDelete', Boolean(area));
  toggle('dirAreaForm', true);
  toggle('dirAddArea', false);
  focus('dirAreaName');
}

export function closeAreaForm() {
  editingAreaId = null;
  clearAreaErrors();
  toggle('dirAreaForm', false);
  toggle('dirAddArea', true);
}

async function submitAreaForm() {
  clearAreaErrors();
  const target = toMinutesFromHours(el('dirAreaTarget').value);
  if (Number.isNaN(target)) {
    setError('dirAreaTargetError', 'Anna tavoite tunteina, esim. 5 tai 2,5.');
    return;
  }
  const values = {
    name: el('dirAreaName').value,
    importance: Number(el('dirAreaImportance').value),
    targetMinutesPerWeek: target,
    categoryKey: el('dirAreaCategory').value || null,
    description: el('dirAreaDescription').value || null,
    active: el('dirAreaActive').checked
  };
  const result = editingAreaId ? await editLifeArea(editingAreaId, values) : await createLifeArea(values);
  if (!result.ok) {
    const errors = result.errors || {};
    if (errors.name) setError('dirAreaNameError', errors.name);
    if (errors.importance) setError('dirAreaImportanceError', errors.importance);
    if (errors.targetMinutesPerWeek) setError('dirAreaTargetError', errors.targetMinutesPerWeek);
    if (errors.categoryKey) setError('dirAreaCategoryError', errors.categoryKey);
    return;
  }
  closeAreaForm();
  focus('dirAddArea');
}

async function submitCapacity() {
  setError('dirCapacityError', '');
  setText('dirCapacityWarning', '');
  const minutes = toMinutesFromHours(el('dirCapacityHours').value);
  if (minutes === null || Number.isNaN(minutes)) {
    setError('dirCapacityError', 'Anna tunnit, esim. 25.');
    return;
  }
  const energyValue = el('dirEnergy').value;
  const result = await saveWeeklyCapacity({
    weekStart: shownWeek(), availableMinutes: minutes, energyLevel: energyValue ? Number(energyValue) : null
  });
  if (!result.ok) {
    if (result.errors && result.errors.availableMinutes) setError('dirCapacityError', result.errors.availableMinutes);
    return;
  }
  const previousWeek = addDaysIso(shownWeek(), -7);
  const state = getState();
  const previousActual = entriesInRange(state.timeEntries, previousWeek, addDaysIso(previousWeek, 6))
    .reduce((sum, entry) => sum + entry.minutes, 0);
  const warnings = capacityWarnings(result.capacity, { previousActualMinutes: previousActual || null });
  if (warnings.includes('unrealistic')) {
    setText('dirCapacityWarning', 'Tallennettu. Yli 60 tuntia suunniteltavaa aikaa viikossa on harvoin realistista.');
  } else if (warnings.includes('above_previous_actual')) {
    setText('dirCapacityWarning', 'Tallennettu. Arvio on yli kaksinkertainen edellisen viikon kirjattuun toteumaan.');
  }
}

async function submitTime() {
  setError('dirTimeDateError', '');
  setError('dirTimeMinutesError', '');
  const result = await logTime({
    entryDate: el('dirTimeDate').value || null,
    minutes: Number(el('dirTimeMinutes').value),
    lifeAreaId: el('dirTimeArea').value || null,
    note: el('dirTimeNote').value || null
  });
  if (!result.ok) {
    const errors = result.errors || {};
    if (errors.entryDate) setError('dirTimeDateError', errors.entryDate);
    if (errors.minutes) setError('dirTimeMinutesError', errors.minutes);
    return;
  }
  el('dirTimeMinutes').value = '';
  el('dirTimeNote').value = '';
}

async function submitReview() {
  const status = el('dirReviewStatus');
  status.textContent = '';
  const reflection = el('dirReflection');
  const result = await saveWeeklyReview({ weekStart: shownWeek(), reflection: reflection.value || null });
  if (result.ok) {
    delete reflection.dataset.dirty;
    status.textContent = 'Viikkokatsaus tallennettu.';
  }
}

async function onProposalClick(event) {
  const button = event.target.closest('[data-adjust]');
  if (!button) return;
  const proposal = shownProposals.find(entry => entry.id === button.dataset.adjust);
  if (!proposal) return;
  const overrides = {};
  const input = el('dirProposals').querySelector(`[data-adjust-value="${CSS.escape(proposal.id)}"]`);
  if (input) {
    const minutes = toMinutesFromHours(input.value);
    if (minutes === null || Number.isNaN(minutes)) return;
    if (proposal.type === ADJUSTMENT.CHANGE_TARGET) overrides.to = minutes;
    if (proposal.type === ADJUSTMENT.SET_CAPACITY) overrides.availableMinutes = minutes;
  }
  const result = await applyAdjustment(proposal, { overrides });
  if (result.applied) {
    const week = shownWeek();
    const state = getState();
    const existing = state.alignmentReviews.find(review => review.weekStart === week);
    // Valittu muutos kirjataan katsaukseen, jos katsaus on jo tallennettu.
    if (existing) {
      await saveWeeklyReview({ weekStart: week, reflection: existing.reflection, adjustments: [proposal.id] });
    }
  }
}

// ------------------------------------------------------ tapahtumat

function goToWeek(offsetDays) {
  viewWeek = weekStartOf(addDaysIso(shownWeek(), offsetDays));
  renderDirection();
}

export function initDirection() {
  const prev = maybe('dirPrev');
  if (!prev) return;
  prev.addEventListener('click', () => goToWeek(-7));
  el('dirNext').addEventListener('click', () => goToWeek(7));
  el('dirThisWeek').addEventListener('click', () => { viewWeek = null; renderDirection(); });

  el('dirCapacitySave').addEventListener('click', submitCapacity);
  el('dirAddArea').addEventListener('click', () => openAreaForm(null));
  el('dirAreaCancel').addEventListener('click', closeAreaForm);
  el('dirAreaSave').addEventListener('click', submitAreaForm);
  el('dirAreaDelete').addEventListener('click', async () => {
    if (!editingAreaId) return;
    if (await deleteLifeArea(editingAreaId)) closeAreaForm();
  });
  el('dirAreaForm').addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); closeAreaForm(); }
  });

  el('dirAreaSuggestions').addEventListener('click', event => {
    const chip = event.target.closest('[data-area-suggest]');
    if (chip) openAreaForm(null, { name: chip.dataset.areaSuggest, categoryKey: chip.dataset.category || null });
  });
  el('dirAreasList').addEventListener('click', event => {
    const edit = event.target.closest('[data-area-edit]');
    if (edit) openAreaForm(edit.dataset.areaEdit);
  });
  el('dirGoalsList').addEventListener('change', event => {
    const select = event.target.closest('[data-goal-area]');
    if (select) assignGoalToLifeArea(select.dataset.goalArea, select.value || null);
  });

  el('dirTimeSave').addEventListener('click', submitTime);
  el('dirTimeList').addEventListener('click', event => {
    const remove = event.target.closest('[data-time-delete]');
    if (remove) deleteTimeEntry(remove.dataset.timeDelete);
  });

  el('dirReflection').addEventListener('input', event => { event.target.dataset.dirty = '1'; });
  el('dirProposals').addEventListener('click', onProposalClick);
  el('dirReviewSave').addEventListener('click', submitReview);

  const today = maybe('todayDirection');
  if (today) {
    today.addEventListener('click', event => {
      if (event.target.closest('[data-open-direction]')) switchTab('screen-direction');
    });
  }
}

/** Uloskirjautuminen: näkymän oma tila pois. */
export function resetDirectionView() {
  viewWeek = null;
  editingAreaId = null;
  shownProposals = [];
}
