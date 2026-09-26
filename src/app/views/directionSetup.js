// Suunnan aloitus: seitsemän vaihetta, yksi kerrallaan (F2).
//
// Ensimmäisellä kerralla Suunta näytti koko sivun (pikatoiminnot,
// kapasiteetti, alueet, tavoitteet, kirjaus, viiden kysymyksen katsaus,
// kehitys), vaikka mitään ei vielä ollut. Aloitus kysyy yhden asian
// kerrallaan:
//
//   Vaihe n/7 · yksi otsikko · enintään yksi vihje · yksi valintaryhmä
//   [Takaisin] [Ohita tämä vaihe] [Seuraava / Tallenna]
//
// PERIAATTEET
//   - Vaihe on valmis TIEDOISTA (src/domain/alignmentSetup.js). Aalto I:n
//     käyttäjä, jolla on jo alueet, jatkaa ensimmäisestä keskeneräisestä.
//   - Mitään ei luoda ennen tallennusta. Ehdotetut nimet ovat luonnos.
//   - Tärkeyttä ei ole valittu valmiiksi, eikä kapasiteetilla ole oletusta.
//   - Aluetta ei voi ohittaa; muut vaiheet voi. Ohitus on käyttäjän oma
//     päätös ja säilyy käyttäjäkohtaisena (src/data/preferences.js).
//   - Vanhaa dataa ei järjestetä puolesta: vaihe 5 kertoo mitä on, ja
//     käyttäjä liittää itse. Kategorian kytkentä on valinta, jossa näkyy
//     montako tehtävää se toisi alueeseen.
//
// Aloituksen ollessa auki muu Suunta on piilossa (#screen-direction
// .dir-setup-active). "Näytä koko Suunta" sulkee aloituksen tämän
// istunnon ajaksi.
//
// Tämä moduuli EI importoi direction.js:ää (sykli): arviojono ja
// uudelleenpiirto tulevat kutsujalta (renderDirectionSetup, initDirectionSetup).

import { maybe } from '../../ui/dom.js';
import { escapeHtml } from '../../lib/format.js';
import { getState, findLifeArea } from '../state.js';
import { getUser } from '../../data/session.js';
import { getUserPreference, setUserPreference } from '../../data/preferences.js';
import {
  SUGGESTED_AREAS, IMPORTANCE_LEVELS, compareLifeAreas, countOf, formatMinutes, areaNameKey,
  importanceLabel, MAX_AREA_NAME_LENGTH
} from '../../domain/lifeArea.js';
import { CATEGORIES } from '../../domain/categories.js';
import {
  SETUP_STEPS, SETUP_STEP_LABELS, REQUIRED_SETUP_STEPS, setupProgress, legacySummary,
  hasLegacyData, categoryImpact, isOpenGoal
} from '../../domain/alignmentSetup.js';
import { estimateCandidates } from '../../domain/estimateQueue.js';
import { capacityForWeek } from '../../domain/weeklyCapacity.js';
import {
  createLifeArea, editLifeArea, assignGoalToLifeArea, saveWeeklyCapacity, currentWeekStart, clockNow
} from '../alignment.js';
import { currentTimer } from '../timeTracking.js';
import { startTimerFor, openGeneralLog } from './timeLog.js';

/** Viikkotavoitteen valinnat. 'none' = ei tavoitetta (null), '0' = ei nyt. */
export const TARGET_CHOICES = Object.freeze([
  Object.freeze({ value: 'none', label: 'Ei tavoitetta' }),
  Object.freeze({ value: '0', label: '0 – ei nyt' }),
  Object.freeze({ value: '60', label: '1 h' }),
  Object.freeze({ value: '180', label: '3 h' }),
  Object.freeze({ value: '300', label: '5 h' }),
  Object.freeze({ value: '600', label: '10 h' }),
  Object.freeze({ value: 'custom', label: 'Muu' })
]);

// ------------------------------------------------------------ tila

/** Käyttäjän valitsema vaihe; null = ensimmäinen keskeneräinen. */
let setupIndex = null;
/** Luonnokset: [{ name, suggestedCategory, includeCategory, importance, error }]. */
let draftAreas = [];
let customNameDraft = '';
/** Alue -> { choice, customHours }. */
let targetChoices = new Map();
let capacityDraft = '';
let loggingAreaId = '';
let stepError = '';
/** "Näytä koko Suunta" tällä istunnolla. */
let dismissed = false;
/** Aloitus käytiin loppuun tässä istunnossa: lyhyt vahvistus näkyy. */
let justCompleted = false;
/** Tallennus kesken: painikkeet pois käytöstä. */
let busy = false;
/** Ohitukset, jos käyttäjää ei tunneta (ei tallenneta). */
let sessionSkipped = new Set();
/** Kutsujan koukut (arviojono ja uudelleenpiirto). */
let hooks = { rerender: () => {}, queueEvent: () => false };
/** Siirretäänkö fokus otsikkoon seuraavassa piirrossa (vaihe vaihtui). */
let focusTitleNext = false;
let lastActive = false;

function currentUserId() {
  const user = getUser();
  return user && user.id ? String(user.id) : null;
}

function setupPreference() {
  const raw = getUserPreference(currentUserId(), 'suuntaSetup');
  const skipped = raw && Array.isArray(raw.skipped)
    ? raw.skipped.filter(key => SETUP_STEPS.includes(key) && !REQUIRED_SETUP_STEPS.includes(key)) : [];
  return { skipped: [...new Set([...skipped, ...sessionSkipped])], completed: Boolean(raw && raw.completed === true) };
}

function saveSetupPreference(next) {
  return setUserPreference(currentUserId(), 'suuntaSetup', { skipped: [...next.skipped], completed: Boolean(next.completed) });
}

function recordSkip(key) {
  if (REQUIRED_SETUP_STEPS.includes(key)) return;
  const pref = setupPreference();
  if (!pref.skipped.includes(key)) pref.skipped.push(key);
  // Istuntomuisti vain, jos laitteelle ei voi tallentaa (yksityinen ikkuna).
  if (!saveSetupPreference(pref)) sessionSkipped.add(key);
}

// ------------------------------------------------------------ tiedot

function setupFacts(state = getState()) {
  const { todayIso } = clockNow();
  const week = currentWeekStart();
  const openUnknownCount = estimateCandidates({
    tasks: state.tasks, routines: state.routines, exceptions: state.routineExceptions,
    todayIso, weekStart: week, includeNextWeek: false
  }).length;
  return {
    areas: state.lifeAreas, goals: state.goals, capacities: state.weeklyCapacities,
    timeEntries: state.timeEntries, timerRunning: Boolean(currentTimer()), openUnknownCount,
    skipped: setupPreference().skipped
  };
}

/** Aloituksen eteneminen nykyisestä tilasta (testejä ja Tänään-korttia varten). */
export function currentSetupProgress(state = getState()) {
  return setupProgress(setupFacts(state));
}

function activeAreas(state = getState()) {
  return state.lifeAreas.filter(area => area.active).sort(compareLifeAreas);
}

/** Seuraava keskeneräinen vaihe annetun jälkeen (tai alusta); null = valmis. */
function nextIndexAfter(progress, index) {
  const later = progress.steps.find(step => step.index > index && !step.done && !step.skipped);
  if (later) return later.index;
  const earlier = progress.steps.find(step => !step.done && !step.skipped);
  return earlier ? earlier.index : null;
}

function shownIndex(progress, state) {
  const hasAreas = activeAreas(state).length > 0;
  let index = setupIndex !== null ? setupIndex : Math.max(progress.currentIndex, 0);
  // Ilman alueita myöhemmät vaiheet eivät ole mahdollisia.
  if (!hasAreas) index = Math.min(index, draftAreas.length > 0 ? 1 : 0);
  return Math.min(Math.max(index, 0), SETUP_STEPS.length - 1);
}

// ------------------------------------------------------------ vaiheet

function chipsHtml(state) {
  const existing = new Set(state.lifeAreas.map(area => areaNameKey(area.name)));
  const drafted = new Set(draftAreas.map(draft => areaNameKey(draft.name)));
  const suggestions = SUGGESTED_AREAS.filter(suggestion => !existing.has(areaNameKey(suggestion.name)));
  const custom = draftAreas.filter(draft => !SUGGESTED_AREAS.some(s => areaNameKey(s.name) === areaNameKey(draft.name)));
  const chip = (name, pressed) => `<button type="button" class="assist-btn dir-setup-chip" data-setup-draft="${escapeHtml(name)}"`
    + ` data-focus="draft:${escapeHtml(areaNameKey(name))}" aria-pressed="${pressed ? 'true' : 'false'}">`
    + `${pressed ? '✓ ' : '+ '}${escapeHtml(name)}</button>`;
  return [...suggestions.map(s => chip(s.name, drafted.has(areaNameKey(s.name)))), ...custom.map(d => chip(d.name, true))].join('');
}

function areasStep(state) {
  const existing = activeAreas(state);
  const selection = draftAreas.length === 0 ? 'Et ole vielä valinnut alueita.'
    : `Valittu: ${draftAreas.map(draft => draft.name).join(', ')}.`;
  return {
    title: 'Mitkä elämäsi alueet ovat sinulle tärkeitä?',
    hint: 'Valitse valmiista tai kirjoita oma. Mitään ei luoda ennen kuin tallennat.',
    controls: `
      ${existing.length > 0 ? `<p class="dir-line">Sinulla on jo: ${escapeHtml(existing.map(area => area.name).join(', '))}.</p>` : ''}
      <div class="assist-actions dir-chips dir-setup-chips">${chipsHtml(state)}</div>
      <label class="field-label" for="dirSetupCustomName">Oma alue</label>
      <div class="dir-setup-inline">
        <input type="text" id="dirSetupCustomName" maxlength="${MAX_AREA_NAME_LENGTH}" autocomplete="off"
          placeholder="esim. Vapaaehtoistyö" value="${escapeHtml(customNameDraft)}" data-focus="custom-name">
        <button type="button" class="assist-btn" data-setup="add-custom" data-focus="add-custom">Lisää</button>
      </div>
      <p class="dir-line">${escapeHtml(selection)}</p>`,
    // Kuulutus pysyvästä elävästä alueesta (#dirSetupStatus), ks. renderDirectionSetup.
    status: selection,
    primary: { label: 'Seuraava', enabled: draftAreas.length > 0 || existing.length > 0, action: 'to-importance' }
  };
}

function importanceStep(state) {
  if (draftAreas.length === 0) {
    const existing = activeAreas(state);
    return {
      title: 'Kuinka tärkeä kukin alue on elämässä, jota haluat?',
      hint: 'Tärkeyttä voi muuttaa milloin tahansa Elämänalueet-osiossa.',
      controls: `<ul class="dir-setup-list">${existing.map(area =>
        `<li>${escapeHtml(area.name)}: ${escapeHtml(importanceLabel(area.importance).toLowerCase())}</li>`).join('')}</ul>`,
      primary: { label: 'Seuraava', enabled: existing.length > 0, action: 'advance' }
    };
  }
  const taken = new Set(state.lifeAreas.map(area => area.categoryKey).filter(Boolean));
  const { todayIso } = clockNow();
  const rows = draftAreas.map((draft, index) => {
    const category = draft.suggestedCategory && !taken.has(draft.suggestedCategory)
      && !draftAreas.some((other, i) => i < index && other.includeCategory && other.suggestedCategory === draft.suggestedCategory)
      ? CATEGORIES.find(c => c.key === draft.suggestedCategory) : null;
    const impact = category ? categoryImpact(state.tasks, state.routines, category.key, {
      goals: state.goals, projects: state.projects, areas: state.lifeAreas, todayIso
    }) : null;
    return `
      <fieldset class="dir-setup-fieldset">
        <legend>${escapeHtml(draft.name)}</legend>
        <div class="dir-setup-choices">
          ${IMPORTANCE_LEVELS.map(level => `<label class="dir-setup-choice">
            <input type="radio" name="dirSetupImp-${index}" value="${level.value}" data-setup-importance="${index}"
              data-focus="imp:${index}:${level.value}"${draft.importance === level.value ? ' checked' : ''}>
            ${level.value} — ${escapeHtml(level.label)}</label>`).join('')}
        </div>
        ${category ? `<label class="checkbox-row dir-setup-choice">
          <input type="checkbox" data-setup-category="${index}" data-focus="cat:${index}"${draft.includeCategory ? ' checked' : ''}>
          Laske alueeseen myös kategorian ${escapeHtml(category.label)} tehtävät
          (${countOf(impact.tasks, 'avoin tehtävä', 'avointa tehtävää')}${impact.routines > 0
            ? `, ${countOf(impact.routines, 'rutiini', 'rutiinia')}` : ''})</label>` : ''}
        ${draft.error ? `<p class="field-error dir-setup-error" role="alert">${escapeHtml(draft.error)}</p>` : ''}
      </fieldset>`;
  }).join('');
  const ready = draftAreas.every(draft => Number.isInteger(draft.importance));
  return {
    title: 'Kuinka tärkeä kukin alue on elämässä, jota haluat?',
    hint: 'Tärkeys ei ole kiire, eikä mitään ole valittu valmiiksi.',
    controls: rows,
    primary: { label: 'Tallenna alueet', enabled: ready, action: 'save-areas' }
  };
}

function targetMinutesFor(choice) {
  if (!choice) return undefined;
  if (choice.choice === 'none') return null;
  if (choice.choice === 'custom') {
    const text = String(choice.customHours ?? '').replace(',', '.').trim();
    if (text === '') return NaN;
    const hours = Number(text);
    return Number.isFinite(hours) && hours >= 0 ? Math.round(hours * 60) : NaN;
  }
  return Number(choice.choice);
}

function currentChoiceOf(area) {
  if (targetChoices.has(area.id)) return targetChoices.get(area.id);
  // Käyttäjän oma aiempi tavoite näytetään valittuna; tyhjää ei arvata.
  if (!Number.isInteger(area.targetMinutesPerWeek)) return null;
  const preset = TARGET_CHOICES.find(option => option.value === String(area.targetMinutesPerWeek));
  return preset ? { choice: preset.value, customHours: '' }
    : { choice: 'custom', customHours: String(Math.round((area.targetMinutesPerWeek / 60) * 100) / 100) };
}

function targetsStep(state, progressStep) {
  const areas = activeAreas(state);
  const rows = areas.map(area => {
    const choice = currentChoiceOf(area);
    return `
      <fieldset class="dir-setup-fieldset">
        <legend>${escapeHtml(area.name)}</legend>
        <div class="dir-setup-choices">
          ${TARGET_CHOICES.map(option => `<label class="dir-setup-choice">
            <input type="radio" name="dirSetupTarget-${escapeHtml(area.id)}" value="${option.value}"
              data-setup-target="${escapeHtml(area.id)}" data-focus="target:${escapeHtml(area.id)}:${option.value}"
              ${choice && choice.choice === option.value ? 'checked' : ''}> ${escapeHtml(option.label)}</label>`).join('')}
        </div>
        ${choice && choice.choice === 'custom' ? `
          <label class="field-label" for="dirSetupTargetHours-${escapeHtml(area.id)}">Tunteja viikossa: ${escapeHtml(area.name)}</label>
          <input type="number" id="dirSetupTargetHours-${escapeHtml(area.id)}" min="0" max="168" step="0.5" inputmode="decimal"
            data-setup-target-hours="${escapeHtml(area.id)}" data-focus="target-hours:${escapeHtml(area.id)}"
            value="${escapeHtml(choice.customHours || '')}">` : ''}
      </fieldset>`;
  }).join('');
  const pending = targetChoices.size > 0;
  return {
    title: 'Paljonko aikaa haluat antaa kullekin alueelle viikossa?',
    hint: 'Valinnainen. "0 – ei nyt" on eri asia kuin "Ei tavoitetta".',
    controls: rows,
    primary: pending || !progressStep.done
      ? { label: 'Tallenna', enabled: pending, action: 'save-targets' }
      : { label: 'Seuraava', enabled: true, action: 'advance' }
  };
}

function capacityStep(state, progressStep) {
  const capacity = capacityForWeek(state.weeklyCapacities, currentWeekStart());
  const pending = String(capacityDraft).trim() !== '';
  return {
    title: 'Paljonko ehdit realistisesti tällä viikolla?',
    hint: 'Aika suunniteltuun tekemiseen, kun uni, ruoka, siirtymät ja yllätykset on vähennetty.',
    controls: `
      ${capacity ? `<p class="dir-line">Tälle viikolle on asetettu ${escapeHtml(formatMinutes(capacity.availableMinutes))}.</p>` : ''}
      <label class="field-label" for="dirSetupCapacity">Tunteja tällä viikolla</label>
      <input type="number" id="dirSetupCapacity" min="0" max="168" step="0.5" inputmode="decimal"
        data-focus="capacity" value="${escapeHtml(capacityDraft)}">`,
    primary: pending || !progressStep.done
      ? { label: 'Tallenna', enabled: pending, action: 'save-capacity' }
      : { label: 'Seuraava', enabled: true, action: 'advance' }
  };
}

/** Vanhan datan kuittaus (F9): oikeat luvut, oikeat sijamuodot, ei ehdotuksia. */
export function legacyNoticeText(summary) {
  if (!hasLegacyData(summary)) return '';
  const parts = [];
  if (summary.openTasks > 0) parts.push(countOf(summary.openTasks, 'tehtävä', 'tehtävää'));
  if (summary.goals > 0) parts.push(countOf(summary.goals, 'tavoite', 'tavoitetta'));
  if (summary.projects > 0) parts.push(countOf(summary.projects, 'projekti', 'projektia'));
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} ja ${parts[parts.length - 1]}` : parts[0];
  const total = summary.openTasks + summary.goals + summary.projects;
  return `Sinulla on jo ${list}. ${total === 1 ? 'Sitä' : 'Niitä'} ei tarvitse järjestää kerralla: `
    + 'kun liität tavoitteen alueeseen, sen tehtävät ja projektit seuraavat mukana. '
    + 'Muut voit liittää vähitellen tai jättää ilman aluetta.';
}

export function currentLegacySummary(state = getState()) {
  return legacySummary({
    tasks: state.tasks, goals: state.goals, projects: state.projects, routines: state.routines,
    areas: state.lifeAreas, todayIso: clockNow().todayIso
  });
}

function goalsStep(state) {
  const areas = activeAreas(state);
  const goals = state.goals.filter(isOpenGoal)
    .sort((a, b) => Number(Boolean(a.lifeAreaId)) - Number(Boolean(b.lifeAreaId)) || a.title.localeCompare(b.title, 'fi'));
  // Kuten tavoitelomakkeessa (goals.js fillLifeAreaSelect): nykyinen alue
  // pysyy valittuna, vaikka se olisi pois käytöstä tai ei näkyvissä. Muuten
  // valikko väitti tavoitetta alueettomaksi.
  const options = current => {
    const known = current ? findLifeArea(current) : null;
    let html = '<option value="">Ei elämänaluetta</option>'
      + areas.map(area => `<option value="${escapeHtml(area.id)}"${area.id === current ? ' selected' : ''}>${escapeHtml(area.name)}</option>`).join('');
    if (current && known && !known.active) {
      html += `<option value="${escapeHtml(current)}" selected>${escapeHtml(known.name)} (pois käytöstä)</option>`;
    } else if (current && !known) {
      html += `<option value="${escapeHtml(current)}" selected>Nykyinen alue (ei näkyvissä)</option>`;
    }
    return html;
  };
  const legacy = legacyNoticeText(currentLegacySummary(state));
  const controls = goals.length === 0
    ? '<div class="assist-empty">Sinulla ei ole avoimia tavoitteita. Voit luoda niitä Tavoitteet-välilehdellä.</div>'
    : goals.map(goal => `
      <div class="dir-goal-row">
        <label class="field-label" for="dirSetupGoal-${escapeHtml(goal.id)}">${escapeHtml(goal.title)}</label>
        <select id="dirSetupGoal-${escapeHtml(goal.id)}" data-setup-goal="${escapeHtml(goal.id)}" data-focus="goal:${escapeHtml(goal.id)}">
          ${options(goal.lifeAreaId || '')}
        </select>
      </div>`).join('');
  return {
    title: 'Liitä tavoitteet alueisiin',
    hint: legacy || 'Kun liität tavoitteen alueeseen, sen tehtävät ja projektit seuraavat mukana.',
    hintId: 'dirSetupLegacy',
    controls,
    primary: { label: 'Seuraava', enabled: true, action: 'finish-step' }
  };
}

function estimatesStep(context) {
  return {
    title: 'Arvioi tämän viikon tehtävien kestot',
    hint: 'Karkea arvio riittää, ja voit lopettaa milloin tahansa. Arvioimaton ei ole nolla.',
    controls: context.queueHtml ? context.queueHtml('setup') : '',
    status: context.queueStatus ? context.queueStatus('setup') : '',
    primary: { label: 'Seuraava', enabled: true, action: 'finish-step' }
  };
}

function loggingStep(state) {
  const areas = activeAreas(state);
  if (loggingAreaId && !areas.some(area => area.id === loggingAreaId)) loggingAreaId = '';
  const running = currentTimer();
  return {
    title: 'Kirjaa, mihin aika oikeasti kuluu',
    hint: 'Käynnistä ajastin alueelle tai kirjaa jo tehtyä aikaa. Valmiiksi merkitty tehtävä ei ole kirjattua aikaa.',
    controls: `
      <label class="field-label" for="dirSetupTimerArea">Alue ajastimelle</label>
      <select id="dirSetupTimerArea" data-setup-timer-area="1" data-focus="timer-area">
        <option value="">Valitse alue</option>
        ${areas.map(area => `<option value="${escapeHtml(area.id)}"${area.id === loggingAreaId ? ' selected' : ''}>${escapeHtml(area.name)}</option>`).join('')}
      </select>
      <div class="assist-actions">
        <button type="button" class="assist-btn primary" data-setup="start-timer" data-focus="start-timer"
          ${!loggingAreaId || running || busy ? 'disabled' : ''}>Aloita ajastin alueelle</button>
        <button type="button" class="assist-btn" data-setup="log-time" data-focus="log-time">Kirjaa jo tehtyä aikaa</button>
      </div>
      ${running ? '<p class="dir-line" role="status">Ajastin on käynnissä. Pysäytä se ylhäältä, kun lopetat.</p>' : ''}`,
    primary: { label: 'Valmis', enabled: true, action: 'finish-step' }
  };
}

function stepContent(key, state, progress, context) {
  const step = progress.steps.find(entry => entry.key === key);
  switch (key) {
    case 'areas': return areasStep(state);
    case 'importance': return importanceStep(state);
    case 'targets': return targetsStep(state, step);
    case 'capacity': return capacityStep(state, step);
    case 'goals': return goalsStep(state);
    case 'estimates': return estimatesStep(context);
    default: return loggingStep(state);
  }
}

// ------------------------------------------------------------ piirto

function cardHtml(index, content, progress) {
  const key = SETUP_STEPS[index];
  const canSkip = !REQUIRED_SETUP_STEPS.includes(key) && !progress.steps[index].done;
  const primary = content.primary;
  return `
    <p class="dir-setup-step">Vaihe ${index + 1}/${SETUP_STEPS.length} · ${escapeHtml(SETUP_STEP_LABELS[key])}</p>
    <h2 class="dir-setup-title" id="dirSetupTitle" tabindex="-1">${escapeHtml(content.title)}</h2>
    ${content.hint ? `<p class="hint"${content.hintId ? ` id="${content.hintId}"` : ''}>${escapeHtml(content.hint)}</p>` : ''}
    <div class="dir-setup-body" role="group" aria-labelledby="dirSetupTitle">${content.controls}</div>
    ${stepError ? `<p class="field-error dir-setup-error" id="dirSetupError" role="alert">${escapeHtml(stepError)}</p>` : ''}
    <div class="dir-setup-nav">
      <button type="button" class="assist-btn" data-setup="back" data-focus="back"${index === 0 || busy ? ' disabled' : ''}>Takaisin</button>
      ${canSkip ? `<button type="button" class="assist-btn" data-setup="skip" data-focus="skip"${busy ? ' disabled' : ''}>Ohita tämä vaihe</button>` : ''}
      <button type="button" class="assist-btn primary" data-setup="${primary.action}" data-focus="primary"
        ${primary.enabled && !busy ? '' : 'disabled'}>${escapeHtml(primary.label)}</button>
    </div>
    <button type="button" class="dir-setup-dismiss" data-setup="dismiss" data-focus="dismiss">Näytä koko Suunta</button>`;
}

/**
 * Piirrä aloitus. Palauttaa, onko aloitus auki (muu Suunta piilossa).
 *
 * @param {object} context
 * @param {boolean} [context.unknown]  Suunnan tietoja ei saatu ladattua: ei aloitusta
 * @param {Function} [context.queueHtml] arviojonon merkintä (host) -> string
 * @param {Function} [context.queueStatus] arviojonon eteneminen (host) -> "Arvioitu n/N"
 */
export function renderDirectionSetup(context = {}) {
  const container = maybe('dirSetup');
  const card = maybe('dirSetupCard');
  const screen = maybe('screen-direction');
  if (!container || !card) return false;
  const state = getState();
  const progress = setupProgress(setupFacts(state));
  const pref = setupPreference();
  const hasAreas = activeAreas(state).length > 0;

  // Käyty loppuun: merkitään käyttäjälle, jotta aloitus ei palaa joka
  // viikko uusien arvioimattomien tehtävien vuoksi. Ei vajaan latauksen
  // perusteella: puuttuva kokoelma näyttäisi "valmiilta" (ei arvioitavaa).
  if (progress.complete && hasAreas && !pref.completed && !context.unknown) {
    saveSetupPreference({ ...pref, completed: true });
    if (lastActive) justCompleted = true;
  }

  // Tuntematon ei ole nolla: jos Suunnan tietoja ei saatu ladattua,
  // aloitusta ei näytetä (alueet voivat olla kannassa).
  const incomplete = !hasAreas || (!pref.completed && !progress.complete);
  const active = !context.unknown && !dismissed && incomplete;

  let html = '';
  let status = '';
  if (active) {
    const index = shownIndex(progress, state);
    const content = stepContent(SETUP_STEPS[index], state, progress, context);
    html = cardHtml(index, content, progress);
    status = content.status || '';
  } else if (!context.unknown && dismissed && incomplete) {
    const index = shownIndex(progress, state);
    html = `<p class="dir-line">Aloitus on kesken: vaihe ${index + 1}/${SETUP_STEPS.length}.</p>
      <button type="button" class="assist-btn" data-setup="resume" data-focus="resume">Jatka aloitusta</button>`;
  } else if (justCompleted && !context.unknown) {
    html = '<p class="dir-line" id="dirSetupTitle" tabindex="-1" role="status">Aloitus on valmis. Alla on koko Suunta.</p>';
  }

  const previous = captureFocus(container);
  card.innerHTML = html;
  container.hidden = html === '';
  // Yksi pysyvä elävä alue: teksti vaihdetaan vain muuttuessaan, jottei
  // uudelleenpiirto (esim. datan päivitys) kuuluta samaa uudelleen.
  const live = maybe('dirSetupStatus');
  if (live && live.textContent !== status) live.textContent = status;
  if (screen && screen.classList) screen.classList.toggle('dir-setup-active', active);
  if (focusTitleNext && html) {
    focusTitleNext = false;
    const title = maybe('dirSetupTitle');
    if (title && typeof title.focus === 'function') title.focus();
  } else {
    // "Näytä koko Suunta": fokus jää kortille ("Jatka aloitusta"), ei katoa.
    restoreFocus(container, previous === 'dismiss' ? 'resume' : previous);
  }
  lastActive = active;
  return active;
}

/** Piirto korvaa sisällön: fokus palautetaan samaan ohjaimeen. */
function captureFocus(container) {
  if (typeof document === 'undefined') return null;
  const active = document.activeElement;
  if (!active || !active.dataset || !active.dataset.focus) return null;
  if (typeof container.contains === 'function' && !container.contains(active)) return null;
  return active.dataset.focus;
}

function restoreFocus(container, key) {
  if (!key || typeof container.querySelector !== 'function') return;
  const target = container.querySelector(`[data-focus="${key.replace(/"/g, '\\"')}"]`);
  if (target && typeof target.focus === 'function' && !target.disabled) target.focus();
}

export function isDirectionSetupActive() {
  return lastActive;
}

// ------------------------------------------------------------ toiminnot

function rerender() {
  hooks.rerender();
}

function go(index) {
  setupIndex = index;
  stepError = '';
  focusTitleNext = true;
  rerender();
}

function toggleDraft(name) {
  const key = areaNameKey(name);
  const at = draftAreas.findIndex(draft => areaNameKey(draft.name) === key);
  if (at >= 0) {
    draftAreas.splice(at, 1);
  } else {
    const suggestion = SUGGESTED_AREAS.find(s => areaNameKey(s.name) === key);
    // Kategoriaa EI kytketä hiljaa: se on erillinen valinta tärkeysvaiheessa.
    draftAreas.push({ name: suggestion ? suggestion.name : name, suggestedCategory: suggestion ? suggestion.categoryKey : null,
      includeCategory: false, importance: null, error: '' });
  }
  stepError = '';
  rerender();
}

function addCustomName() {
  const name = String(customNameDraft || '').normalize('NFC').trim().slice(0, MAX_AREA_NAME_LENGTH);
  if (!name) {
    stepError = 'Kirjoita alueelle nimi.';
    rerender();
    return;
  }
  const key = areaNameKey(name);
  if (getState().lifeAreas.some(area => areaNameKey(area.name) === key)) {
    stepError = 'Sinulla on jo tämänniminen alue.';
    rerender();
    return;
  }
  customNameDraft = '';
  if (!draftAreas.some(draft => areaNameKey(draft.name) === key)) toggleDraft(name);
  else { stepError = ''; rerender(); }
}

async function saveAreas() {
  if (busy || draftAreas.length === 0 || !draftAreas.every(draft => Number.isInteger(draft.importance))) return;
  busy = true;
  stepError = '';
  rerender();
  try {
    const remaining = [];
    for (const draft of draftAreas) {
      const result = await createLifeArea({
        name: draft.name, importance: draft.importance,
        categoryKey: draft.includeCategory ? draft.suggestedCategory : null
      });
      if (!result.ok) {
        const errors = result.errors || {};
        remaining.push({ ...draft, error: errors.name || errors.categoryKey || errors.importance || 'Tallennus ei onnistunut.' });
      }
    }
    draftAreas = remaining;
  } finally {
    busy = false;
  }
  if (draftAreas.length === 0) go(null);
  else rerender();
}

async function saveTargets() {
  if (busy || targetChoices.size === 0) return;
  const writes = [];
  for (const [areaId, choice] of targetChoices) {
    const area = findLifeArea(areaId);
    if (!area) continue;
    const minutes = targetMinutesFor(choice);
    if (Number.isNaN(minutes) || (minutes !== null && minutes > 168 * 60)) {
      stepError = `Anna alueen ${area.name} tavoite tunteina, esim. 5 tai 2,5.`;
      rerender();
      return;
    }
    if ((area.targetMinutesPerWeek ?? null) !== minutes) writes.push([areaId, minutes]);
  }
  busy = true;
  stepError = '';
  rerender();
  let failed = false;
  try {
    for (const [areaId, minutes] of writes) {
      const result = await editLifeArea(areaId, { targetMinutesPerWeek: minutes });
      if (!result.ok) failed = true;
    }
  } finally {
    busy = false;
  }
  if (failed) {
    stepError = 'Kaikkia tavoitteita ei saatu tallennettua.';
    rerender();
    return;
  }
  targetChoices = new Map();
  // "Ei tavoitetta" kaikille on käyttäjän päätös, ei keskeneräinen vaihe.
  if (!activeAreas().some(area => Number.isInteger(area.targetMinutesPerWeek))) recordSkip('targets');
  go(nextIndexAfter(currentSetupProgress(), SETUP_STEPS.indexOf('targets')));
}

async function saveCapacity() {
  if (busy) return;
  const text = String(capacityDraft).replace(',', '.').trim();
  const hours = Number(text);
  if (text === '' || !Number.isFinite(hours) || hours < 0) {
    stepError = 'Anna tunnit, esim. 25.';
    rerender();
    return;
  }
  busy = true;
  stepError = '';
  rerender();
  let result;
  try {
    result = await saveWeeklyCapacity({ weekStart: currentWeekStart(), availableMinutes: Math.round(hours * 60) });
  } finally {
    busy = false;
  }
  if (!result || !result.ok) {
    stepError = (result && result.errors && result.errors.availableMinutes) || 'Kapasiteettia ei saatu tallennettua.';
    rerender();
    return;
  }
  capacityDraft = '';
  go(nextIndexAfter(currentSetupProgress(), SETUP_STEPS.indexOf('capacity')));
}

/** Vaihe on käyty: keskeneräinen kirjataan ohitetuksi (ei nalkuteta). */
function finishStep(index) {
  const progress = currentSetupProgress();
  const step = progress.steps[index];
  if (step && !step.done) recordSkip(step.key);
  go(nextIndexAfter(currentSetupProgress(), index));
}

async function onAction(action) {
  const progress = currentSetupProgress();
  const index = shownIndex(progress, getState());
  switch (action) {
    case 'back': go(Math.max(0, index - 1)); break;
    case 'skip': {
      recordSkip(SETUP_STEPS[index]);
      go(nextIndexAfter(currentSetupProgress(), index));
      break;
    }
    case 'to-importance': go(1); break;
    case 'advance': go(nextIndexAfter(progress, index)); break;
    case 'finish-step': finishStep(index); break;
    case 'save-areas': await saveAreas(); break;
    case 'save-targets': await saveTargets(); break;
    case 'save-capacity': await saveCapacity(); break;
    case 'add-custom': addCustomName(); break;
    case 'start-timer': {
      if (!loggingAreaId || busy) return;
      busy = true;
      rerender();
      try {
        await startTimerFor({ kind: 'life_area', id: loggingAreaId });
      } finally {
        busy = false;
      }
      rerender();
      break;
    }
    case 'log-time': openGeneralLog(); break;
    case 'dismiss': dismissDirectionSetup(); rerender(); break;
    case 'resume': openDirectionSetup(); break;
    default: break;
  }
}

function onClick(event) {
  if (hooks.queueEvent('click', event)) return;
  const draft = event.target.closest('[data-setup-draft]');
  if (draft) {
    toggleDraft(draft.dataset.setupDraft);
    return;
  }
  const button = event.target.closest('[data-setup]');
  if (button && !button.disabled) onAction(button.dataset.setup);
}

function onChange(event) {
  if (hooks.queueEvent('change', event)) return;
  const importance = event.target.closest('[data-setup-importance]');
  if (importance) {
    const draft = draftAreas[Number(importance.dataset.setupImportance)];
    if (draft) { draft.importance = Number(importance.value); draft.error = ''; }
    rerender();
    return;
  }
  const category = event.target.closest('[data-setup-category]');
  if (category) {
    const draft = draftAreas[Number(category.dataset.setupCategory)];
    if (draft) draft.includeCategory = Boolean(category.checked);
    rerender();
    return;
  }
  const target = event.target.closest('[data-setup-target]');
  if (target) {
    const previous = targetChoices.get(target.dataset.setupTarget);
    targetChoices.set(target.dataset.setupTarget, { choice: target.value, customHours: previous ? previous.customHours : '' });
    stepError = '';
    rerender();
    return;
  }
  const goal = event.target.closest('[data-setup-goal]');
  if (goal) {
    assignGoalToLifeArea(goal.dataset.setupGoal, goal.value || null);
    return;
  }
  const timerArea = event.target.closest('[data-setup-timer-area]');
  if (timerArea) {
    loggingAreaId = timerArea.value || '';
    rerender();
  }
}

function onInput(event) {
  if (hooks.queueEvent('input', event)) return;
  const field = event.target;
  if (!field || !field.dataset) return;
  // Luonnos talteen: datan päivitys piirtää kortin uudelleen kesken kirjoittamisen.
  if (field.dataset.focus === 'custom-name') customNameDraft = field.value;
  else if (field.dataset.focus === 'capacity') capacityDraft = field.value;
  else if (field.dataset.setupTargetHours) {
    const id = field.dataset.setupTargetHours;
    targetChoices.set(id, { choice: 'custom', customHours: field.value });
  }
}

function onKeydown(event) {
  if (hooks.queueEvent('keydown', event)) return;
  if (event.key !== 'Enter' || !event.target || !event.target.dataset) return;
  if (event.target.dataset.focus === 'custom-name') {
    event.preventDefault();
    customNameDraft = event.target.value;
    addCustomName();
  } else if (event.target.dataset.focus === 'capacity') {
    event.preventDefault();
    capacityDraft = event.target.value;
    saveCapacity();
  }
}

/**
 * Kytke aloituksen tapahtumat (kerran).
 * @param {object} options
 * @param {Function} options.rerender   piirrä Suunta uudelleen
 * @param {Function} [options.queueEvent] (tyyppi, tapahtuma) -> käsittelikö arviojono
 */
export function initDirectionSetup(options = {}) {
  hooks = {
    rerender: typeof options.rerender === 'function' ? options.rerender : () => {},
    queueEvent: typeof options.queueEvent === 'function' ? options.queueEvent : () => false
  };
  const container = maybe('dirSetup');
  if (!container) return;
  container.addEventListener('click', onClick);
  container.addEventListener('change', onChange);
  container.addEventListener('input', onInput);
  container.addEventListener('keydown', onKeydown);
}

/** Avaa aloitus (Tänään-kortti "Aloita Suunta", "Jatka aloitusta"). */
export function openDirectionSetup() {
  dismissed = false;
  justCompleted = false;
  setupIndex = null;
  stepError = '';
  focusTitleNext = true;
  rerender();
}

/** "Näytä koko Suunta" tai työnkulun avaus: aloitus sivuun tämän istunnon ajaksi. */
export function dismissDirectionSetup() {
  dismissed = true;
  justCompleted = false;
  focusTitleNext = false;
}

/** Uloskirjautuminen: aloituksen luonnokset ja istuntotila pois. */
export function resetDirectionSetup() {
  setupIndex = null;
  draftAreas = [];
  customNameDraft = '';
  targetChoices = new Map();
  capacityDraft = '';
  loggingAreaId = '';
  stepError = '';
  dismissed = false;
  justCompleted = false;
  busy = false;
  sessionSkipped = new Set();
  focusTitleNext = false;
  lastActive = false;
}

/** Testejä varten: toiminto suoraan (sama kuin painikkeen napautus). */
export function setupActionForTests(action) {
  return onAction(action);
}
