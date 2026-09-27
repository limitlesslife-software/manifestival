// Profiili → Hyvinvointi: vointi 14 päivää, tapojen muutos, liikunta ja uni.
//
// MODERNI KAAVA (ks. direction.js): koko osio piirretään renderHtml:llä
// kutsujan antamaan säiliöön, ja kuuntelijat sidotaan KERRAN säiliötä kohti
// delegoituina. Identtistä merkintää ei kirjoiteta uudelleen, ja muuttunut
// merkintä palauttaa fokuksen samaan ohjaimeen. Säiliön luo profiilinäkymä
// (#profileWellbeingSection); tämä moduuli ei tunne index.html:ää.
//
// LOMAKKEET ELÄVÄT LUONNOKSINA. Kirjoitettu teksti tallentuu moduulin
// luonnokseen heti näppäiltäessä, ja piirto tuottaa kentät luonnoksesta.
// Näin taustalla tapahtuva tilamuutos (synkronointi, toinen tallennus) ei
// pyyhi kesken olevaa kirjoitusta, vaikka koko osio piirretään uudelleen.
//
// TUNTEMATON EI OLE NOLLA. Tyhjä numerokenttä tallentuu nullina, ei
// nollana. Päivä ilman merkintää näkyy "ei merkintää" eikä ykkösenä tai
// nollana, ja keskiarvot lasketaan vain annetuista arvoista. Siksi
// rajojen ulkopuolinen luku on virhe, jonka käyttäjä korjaa — sitä ei
// hiljaa muuteta tuntemattomaksi eikä kiristetä rajalle.
//
// ARKALUONTEINEN. Vointi, uni ja tavat eivät kulje lokiin eikä tekoälylle:
// tämä näkymä ei kirjaa mitään, se näyttää ja tallentaa käyttäjän omat
// merkinnät src/app/dailyLifeActions.js:n kautta.
//
// EI TERVEYSNEUVONTAA. Luvut ovat käyttäjän omia tavoitteita, ja uni on
// vuoteessa oloaikaa, ei mitattua unta. Kieli on neutraalia: kirjaus on
// tieto, ei arvosana.

import { getState, currentLifeSettings } from '../state.js';
import {
  saveHabitPlan, deleteHabitPlan, saveExerciseSession, deleteExerciseSession, saveSleepLog
} from '../dailyLifeActions.js';
import { deviceOffsetMinutes, deviceTimeZone } from '../deviceTime.js';
import { serverUnavailableHintHtml } from '../schemaStatus.js';
import { loadFailureHtml } from './loadNotice.js';
import { renderHtml, singleFlight } from '../../ui/dom.js';
import { success } from '../../ui/toast.js';
import { escapeHtml } from '../../lib/format.js';
import { fmtISO } from '../../lib/datetime.js';
import { hasTable, isTableAvailable } from '../../data/schema.js';
import { mergeDays, windowAverages, strainSuggestion } from '../../domain/wellbeingInsights.js';
import { progress as habitProgress, currentStep } from '../../domain/habitEngine.js';
import { weeklyExercise } from '../../domain/exercise.js';
import { driftReport, sleepOpportunity, DRIFT_WINDOW_DAYS, REFERENCE_BASIS } from '../../domain/sleepRhythm.js';
import { HABIT_KIND, DELIVERY, DELIVERIES, deliveryLabel, MAX_HABIT_STEPS } from '../../domain/dailyLife.js';
import {
  MAX_HABIT_NAME_LENGTH, MAX_HABIT_INTERVAL_MINUTES, MAX_HABIT_DAILY_TARGET, MAX_HABIT_UNIT_COST_MINOR
} from '../../domain/habit.js';
import {
  MAX_EXERCISE_KIND_LENGTH, MAX_EXERCISE_MINUTES, MAX_EXERCISE_NOTE_LENGTH
} from '../../domain/exerciseSession.js';
import { MAX_SLEEP_NOTE_LENGTH } from '../../domain/sleepLog.js';
import { SCALE_MIN, SCALE_MAX } from '../../domain/wellbeing.js';
import { parseMoneyToMinor, formatMinorAsInput } from '../../domain/money.js';
import { clockText, durationText, isoWeekday, shiftDateIso } from '../../domain/wallClock.js';
import { isIsoDate } from '../../domain/task.js';

/** Vointihistorian pituus päivinä (tämä päivä mukaan lukien). */
export const HISTORY_DAYS = 14;
/** Liikuntakertoja näytetään listassa enintään näin monta (uusin ensin). */
const RECENT_SESSIONS = 10;
/** Aiempia lajeja ehdotetaan lajikentässä enintään näin monta. */
const KIND_SUGGESTIONS = 8;

const WEEKDAYS = Object.freeze(['ma', 'ti', 'ke', 'to', 'pe', 'la', 'su']);

/** Taulut, joiden tallennuksesta osio kertoo (portti kiinni tai kanta jäljessä). */
const TABLE_KEYS = Object.freeze(['wellbeingCheckins', 'habitPlans', 'habitEvents', 'exerciseSessions', 'sleepLogs']);

/**
 * Historian sarakkeet. Kapealla näytöllä otsikko on lyhenne, ruudunlukija
 * kuulee koko nimen; selite kertoo lyhenteet näkevälle käyttäjälle.
 */
const METRICS = Object.freeze([
  Object.freeze({ key: 'energy', label: 'Energia', short: 'En' }),
  Object.freeze({ key: 'mood', label: 'Mieliala', short: 'Mi' }),
  Object.freeze({ key: 'stress', label: 'Kuormitus', short: 'Ku' }),
  Object.freeze({ key: 'motivation', label: 'Motivaatio', short: 'Mo' }),
  Object.freeze({ key: 'control', label: 'Hallinnan tunne', short: 'Ha' })
]);

const INTENSITY_LABELS = Object.freeze(['Hyvin kevyt', 'Kevyt', 'Kohtalainen', 'Raskas', 'Hyvin raskas']);
const RECOVERY_LABELS = Object.freeze(['Vähäinen', 'Pieni', 'Kohtalainen', 'Suuri', 'Hyvin suuri']);

/** Tavoitteet, joihin liikuntakerran voi liittää (päättyneet eivät ole valittavissa). */
const OPEN_GOAL_STATUSES = new Set(['active', 'paused', 'maintenance']);

const SECTION_HEADINGS = Object.freeze({
  history: 'wbhHistoryTitle',
  habits: 'wbhHabitsTitle',
  exercise: 'wbhExerciseTitle',
  sleep: 'wbhSleepTitle'
});

// ------------------------------------------------------------ luonnokset

/** Säiliöt, joihin kuuntelijat on jo sidottu (kerran kutakin kohti). */
const bound = new WeakSet();

/** Avoimet lomakkeet. null = lomake kiinni. Ei koskaan sovelluksen tilassa. */
let drafts = { habit: null, exercise: null, sleep: null };

/**
 * Uloskirjautuminen ja testit: keskeneräiset luonnokset pois, jottei
 * edellisen käyttäjän kirjoitus näy seuraavalle (cross-user leak).
 */
export function resetWellbeingHub() {
  drafts = { habit: null, exercise: null, sleep: null };
}

// ------------------------------------------------------------ apurit

function todayIso() {
  return fmtISO(new Date());
}

/** Laitteen vyöhyke tapamoottorille; tuntematon -> moottorin oletus. */
function timeZone() {
  return deviceTimeZone() || undefined;
}

function dateLabel(iso) {
  if (!isIsoDate(iso)) return '';
  const [, month, day] = iso.split('-').map(Number);
  return `${WEEKDAYS[isoWeekday(iso) - 1]} ${day}.${month}.`;
}

/** Desimaaliluku suomeksi: 3.5 -> "3,5". */
function decimal(value) {
  return String(value).replace('.', ',');
}

function numText(value) {
  return value === null || value === undefined ? '' : String(value);
}

/** "1 kerta", "3 kertaa" (myös "0 kertaa": nolla päivätavoitteena on arvo). */
function timesText(n) {
  return n === 1 ? '1 kerta' : `${n} kertaa`;
}

function attrValue(value) {
  return String(value).replace(/["\\]/g, '\\$&');
}

const UNKNOWN_CELL = '<span aria-hidden="true">–</span><span class="visually-hidden">ei merkintää</span>';

/**
 * Kokonaisluku kentästä. Tyhjä = null (tuntematon, EI nolla). Muu kuin
 * kokonaisluku rajoissa on virhe: sitä ei kiristetä eikä pudoteta hiljaa.
 */
function parseWhole(raw, min, max) {
  const text = String(raw ?? '').trim();
  if (text === '') return { value: null };
  if (!/^-?\d+$/.test(text)) return { error: `Anna kokonaisluku ${min}–${max}.` };
  const value = Number(text);
  if (value < min || value > max) return { error: `Anna kokonaisluku ${min}–${max}.` };
  return { value };
}

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

// ------------------------------------------------------------ kentät

function describedBy(id, hint, error) {
  const ids = [hint ? `${id}Hint` : '', error ? `${id}Error` : ''].filter(Boolean);
  return ids.length ? ` aria-describedby="${ids.join(' ')}"` : '';
}

function fieldExtras(id, hint, error) {
  return (hint ? `<div class="lh-hint" id="${id}Hint">${escapeHtml(hint)}</div>` : '')
    + (error ? `<div class="field-error lh-error" id="${id}Error" role="alert">${escapeHtml(error)}</div>` : '');
}

/** Tekstimäinen kenttä (text, number, date, time). */
function inputField({ id, label, value, form, field, errors, type = 'text', attrs = '', hint = '', required = false, dataAttrs = '' }) {
  const error = errors[id] || '';
  return `<div class="lh-field">
      <label class="field-label" for="${id}">${label}${required ? ' <span aria-hidden="true">*</span>' : ''}</label>
      <input id="${id}" type="${type}" value="${escapeHtml(value)}" data-form="${form}" data-field="${field}"${dataAttrs}${attrs ? ' ' + attrs : ''}${required ? ' aria-required="true"' : ''}${error ? ' aria-invalid="true"' : ''}${describedBy(id, hint, error)}>
      ${fieldExtras(id, hint, error)}
    </div>`;
}

function numberField({ id, label, value, form, field, errors, min, max, hint = '', dataAttrs = '' }) {
  return inputField({
    id, label, value, form, field, errors, hint, dataAttrs, type: 'number',
    attrs: `min="${min}" max="${max}" step="1" inputmode="numeric"`
  });
}

function selectField({ id, label, value, options, form, field, errors = {} }) {
  const error = errors[id] || '';
  const items = options.map(([optionValue, text]) =>
    `<option value="${escapeHtml(optionValue)}"${String(optionValue) === String(value) ? ' selected' : ''}>${escapeHtml(text)}</option>`)
    .join('');
  return `<div class="lh-field">
      <label class="field-label" for="${id}">${label}</label>
      <select id="${id}" data-form="${form}" data-field="${field}"${error ? ' aria-invalid="true"' : ''}${describedBy(id, '', error)}>${items}</select>
      ${fieldExtras(id, '', error)}
    </div>`;
}

function textareaField({ id, label, value, form, field, maxLength }) {
  return `<div class="lh-field">
      <label class="field-label" for="${id}">${label}</label>
      <textarea id="${id}" rows="2" maxlength="${maxLength}" data-form="${form}" data-field="${field}">${escapeHtml(value)}</textarea>
    </div>`;
}

function checkField({ id, label, checked, form, field }) {
  return `<label class="check-row" for="${id}"><input type="checkbox" id="${id}" data-form="${form}" data-field="${field}"${checked ? ' checked' : ''}> ${label}</label>`;
}

function formErrorHtml(id, errors) {
  const error = errors[id];
  return error ? `<div class="field-error lh-error" id="${id}" role="alert" tabindex="-1">${escapeHtml(error)}</div>` : '';
}

function actionsHtml(form, draft, { removable }) {
  const busy = draft.saving ? ' disabled aria-busy="true"' : '';
  return `<div class="form-actions">
      ${removable && draft.id ? `<button type="button" class="form-btn danger" data-action="${form}-remove"${busy}>Poista</button>` : ''}
      <button type="button" class="form-btn secondary" data-action="${form}-cancel">Peruuta</button>
      <button type="button" class="form-btn primary" data-action="${form}-save"${busy}>${draft.saving ? 'Tallennetaan…' : 'Tallenna'}</button>
    </div>`;
}

function addButtonHtml(action, text) {
  return `<button type="button" class="add-row" data-action="${action}"><svg class="icon" aria-hidden="true"><use href="#i-plus"/></svg>${text}</button>`;
}

function sectionHtml(key, title, body) {
  const heading = SECTION_HEADINGS[key];
  return `<section class="lh-section" data-section="${key}" data-heading="${heading}" aria-labelledby="${heading}">
    <h2 class="section-title lh-heading" id="${heading}" tabindex="-1">${title}</h2>
    ${body}
  </section>`;
}

/** Tallennuksen tila: portti kiinni = istunnon ajan, kanta jäljessä = ei tallennu. */
function persistenceNoticeHtml() {
  if (TABLE_KEYS.every(key => isTableAvailable(key))) return '';
  if (TABLE_KEYS.some(key => hasTable(key) && !isTableAvailable(key))) return serverUnavailableHintHtml();
  return '<p class="hint lh-notice"><strong>Huom.</strong> Hyvinvoinnin kirjaukset säilyvät toistaiseksi '
    + 'vain tämän istunnon ajan.</p>';
}

// ------------------------------------------------------------ vointi 14 pv

function historyHtml(state, today) {
  const from = shiftDateIso(today, -(HISTORY_DAYS - 1));
  const rows = mergeDays(state.wellbeing, state.wellbeingCheckins, { fromIso: from, toIso: today });
  const byDate = new Map(rows.map(row => [row.date, row]));
  const averages = windowAverages({
    entries: state.wellbeing, checkins: state.wellbeingCheckins, fromIso: from, toIso: today
  });

  const body = [];
  for (let i = 0; i < HISTORY_DAYS; i += 1) {
    const date = shiftDateIso(today, -i);
    const row = byDate.get(date) || null;
    const known = row && METRICS.some(metric => row[metric.key] !== null);
    const label = `<th scope="row">${dateLabel(date)}</th>`;
    if (!known) {
      body.push(`<tr data-date="${date}">${label}<td colspan="${METRICS.length}" class="lh-unknown">ei merkintää</td></tr>`);
      continue;
    }
    const cells = METRICS.map(metric => `<td>${row[metric.key] === null ? UNKNOWN_CELL : row[metric.key]}</td>`).join('');
    body.push(`<tr data-date="${date}">${label}${cells}</tr>`);
  }

  const head = METRICS.map(metric =>
    `<th scope="col"><span aria-hidden="true">${metric.short}</span><span class="visually-hidden">${metric.label}</span></th>`)
    .join('');
  const averageCells = METRICS.map(metric => {
    const value = averages ? averages[metric.key] : null;
    return `<td>${value === null ? UNKNOWN_CELL : decimal(value)}</td>`;
  }).join('');
  const reported = averages ? averages.reportedDays : 0;
  const legend = METRICS.map(metric => `${metric.short} = ${metric.label.toLocaleLowerCase('fi')}`).join(', ');

  const suggestion = strainSuggestion({
    entries: state.wellbeing, checkins: state.wellbeingCheckins, todayIso: today
  });
  const suggestionHtml = suggestion
    ? `<div class="wb-suggestion lh-suggestion" role="note">
        <p>${escapeHtml(suggestion.text)}</p>
        <p>${escapeHtml(suggestion.why)}</p>
        <p>Ehdotus ei muuta suunnitelmaasi itsestään.</p>
      </div>`
    : '';

  const failure = loadFailureHtml(state, ['wellbeing', 'wellbeingCheckins']);
  return sectionHtml('history', `Vointi ${HISTORY_DAYS} päivää`, `
    ${failure}
    <p class="hint">Omat merkintäsi asteikolla ${SCALE_MIN}–${SCALE_MAX}, uusin ensin. Merkintöjä ${reported} päivältä `
    + `${HISTORY_DAYS} päivästä. Päivä ilman merkintää on tuntematon, ei huono päivä.</p>
    <div class="lh-table-wrap">
      <table class="wbh-table">
        <caption class="visually-hidden">Vointi ${HISTORY_DAYS} päivää, uusin ensin</caption>
        <thead><tr><th scope="col">Päivä</th>${head}</tr></thead>
        <tbody>${body.join('')}</tbody>
        <tfoot><tr><th scope="row">Keskiarvo</th>${averageCells}</tr></tfoot>
      </table>
    </div>
    <p class="lh-legend">${legend}. Kuormituksessa suuri luku tarkoittaa paljon kuormitusta. `
    + `Keskiarvot lasketaan vain merkityistä päivistä.</p>
    ${suggestionHtml}`);
}

// ------------------------------------------------------------ tapojen muutos

function habitDraftFrom(plan) {
  return {
    id: plan ? plan.id : null,
    name: plan ? plan.name : '',
    kind: plan ? plan.kind : HABIT_KIND.GENERIC,
    minInterval: numText(plan && plan.minIntervalMinutes),
    dailyTarget: numText(plan && plan.dailyTarget),
    baseline: numText(plan && plan.baselinePerDay),
    unitCost: plan && plan.unitCostMinor !== null && plan.unitCostMinor !== undefined
      ? formatMinorAsInput(plan.unitCostMinor).replace('.', ',')
      : '',
    delivery: plan ? plan.reminderDelivery : DELIVERY.SILENT,
    active: plan ? plan.active !== false : true,
    steps: (plan && Array.isArray(plan.steps) ? plan.steps : []).map(step => ({
      from: step.from || '',
      interval: numText(step.intervalMinutes),
      target: numText(step.dailyTarget)
    })),
    errors: {},
    saving: false,
    returnFocus: null
  };
}

/**
 * Luonnos -> tallennettava suunnitelma tai kenttävirheet (avaimena kentän
 * tunniste, jotta virhe osuu oikean kentän alle ja fokus sen kenttään).
 */
function parseHabitDraft(draft) {
  const errors = {};
  const name = draft.name.trim();
  if (!name) errors.wbhHabitName = 'Anna tavalle nimi.';

  const read = (id, raw, min, max) => {
    const parsed = parseWhole(raw, min, max);
    if (parsed.error) errors[id] = parsed.error;
    return parsed.value ?? null;
  };
  const minIntervalMinutes = read('wbhHabitInterval', draft.minInterval, 1, MAX_HABIT_INTERVAL_MINUTES);
  const dailyTarget = read('wbhHabitTarget', draft.dailyTarget, 0, MAX_HABIT_DAILY_TARGET);
  const baselinePerDay = read('wbhHabitBaseline', draft.baseline, 0, MAX_HABIT_DAILY_TARGET);

  let unitCostMinor = null;
  if (draft.unitCost.trim() !== '') {
    unitCostMinor = parseMoneyToMinor(draft.unitCost.trim());
    if (unitCostMinor === null || unitCostMinor > MAX_HABIT_UNIT_COST_MINOR) {
      errors.wbhHabitCost = 'Anna hinta euroina, esimerkiksi 0,45.';
      unitCostMinor = null;
    }
  }

  const steps = [];
  const seen = new Set();
  draft.steps.forEach((step, index) => {
    const from = String(step.from || '').trim();
    const interval = read(`wbhStepInterval-${index}`, step.interval, 1, MAX_HABIT_INTERVAL_MINUTES);
    const target = read(`wbhStepTarget-${index}`, step.target, 0, MAX_HABIT_DAILY_TARGET);
    const blank = !from && String(step.interval).trim() === '' && String(step.target).trim() === '';
    // Kokonaan tyhjä rivi on keskeneräinen lisäys, ei virhe: se jätetään pois.
    if (blank) return;
    if (!isIsoDate(from)) {
      errors[`wbhStepFrom-${index}`] = 'Anna askeleelle alkupäivä.';
      return;
    }
    if (seen.has(from)) {
      errors[`wbhStepFrom-${index}`] = 'Samalle päivälle on jo askel.';
      return;
    }
    if (interval === null && target === null && !errors[`wbhStepInterval-${index}`] && !errors[`wbhStepTarget-${index}`]) {
      errors[`wbhStepInterval-${index}`] = 'Anna askeleelle väli tai päivätavoite.';
      return;
    }
    seen.add(from);
    steps.push({ from, intervalMinutes: interval, dailyTarget: target });
  });

  return {
    errors,
    input: {
      ...(draft.id ? { id: draft.id } : {}),
      name,
      kind: draft.kind === HABIT_KIND.NICOTINE ? HABIT_KIND.NICOTINE : HABIT_KIND.GENERIC,
      minIntervalMinutes,
      dailyTarget,
      baselinePerDay,
      unitCostMinor,
      reminderDelivery: DELIVERIES.includes(draft.delivery) ? draft.delivery : DELIVERY.SILENT,
      active: draft.active !== false,
      steps
    }
  };
}

function ruleText(step) {
  if (!step) return '';
  const parts = [];
  if (step.intervalMinutes !== null) parts.push(`väli vähintään ${durationText(step.intervalMinutes)}`);
  if (step.dailyTarget !== null) parts.push(`päivätavoite ${timesText(step.dailyTarget)}`);
  return parts.length ? `Nyt voimassa: ${parts.join(' · ')}.` : 'Suunnitelmassa ei ole väliä eikä päivätavoitetta.';
}

function nextStepText(plan, step) {
  if (!step || !step.nextStepFrom) return '';
  const next = (plan.steps || []).find(item => item.from === step.nextStepFrom);
  if (!next) return '';
  const parts = [];
  if (next.intervalMinutes !== null) parts.push(`väli ${durationText(next.intervalMinutes)}`);
  if (next.dailyTarget !== null) parts.push(`päivätavoite ${next.dailyTarget}`);
  return `Seuraava askel ${dateLabel(next.from)}: ${parts.join(', ')}.`;
}

function todayUsesText(uses) {
  return uses === 0 ? 'Tänään ei vielä kirjauksia.' : `Tänään kirjattu ${timesText(uses)}.`;
}

function habitRowHtml(plan, state, today, settings) {
  const step = currentStep(plan, today);
  const result = habitProgress({
    plan, events: state.habitEvents, todayIso: today, days: HISTORY_DAYS, timeZone: timeZone(),
    currency: settings.currency
  });
  const name = escapeHtml(plan.name);
  const id = escapeHtml(plan.id);
  const next = nextStepText(plan, step);
  const moneyHint = plan.baselinePerDay === null || plan.unitCostMinor === null
    ? '<div class="assist-reason">Säästöä ei lasketa ilman lähtötasoa ja yksikköhintaa.</div>'
    : '';
  return `<li class="assist-row lh-row" data-habit-row="${id}">
      <div class="assist-title">${name}</div>
      <div class="assist-meta">
        <span class="assist-tag">${plan.kind === HABIT_KIND.NICOTINE ? 'Nikotiini' : 'Muu'}</span>
        <span class="assist-tag${plan.active ? '' : ' tone-warn'}">${plan.active ? 'Käytössä' : 'Tauolla'}</span>
      </div>
      <div class="assist-meta">${ruleText(step)}</div>
      ${next ? `<div class="assist-meta">${next}</div>` : ''}
      ${result ? `<div class="assist-reason">${escapeHtml(result.text)}</div>` : ''}
      ${result ? `<div class="assist-meta">${todayUsesText(result.today.uses)}</div>` : ''}
      ${moneyHint}
      <div class="assist-meta">Muistutus: ${escapeHtml(deliveryLabel(plan.reminderDelivery))}</div>
      <div class="assist-actions">
        <button type="button" class="assist-btn" data-action="habit-edit" data-id="${id}" aria-label="Muokkaa suunnitelmaa ${name}">Muokkaa</button>
        <button type="button" class="assist-btn danger" data-action="habit-delete" data-id="${id}" aria-label="Poista suunnitelma ${name}">Poista</button>
      </div>
    </li>`;
}

function stepRowHtml(step, index, errors) {
  const n = index + 1;
  const data = ` data-index="${index}"`;
  return `<li class="lh-step">
      ${inputField({
        id: `wbhStepFrom-${index}`, label: `<span class="visually-hidden">Askel ${n}: </span>Alkaen`, value: step.from,
        form: 'habit', field: 'step-from', errors, type: 'date', dataAttrs: data
      })}
      ${numberField({
        id: `wbhStepInterval-${index}`, label: `<span class="visually-hidden">Askel ${n}: </span>Väli (min)`,
        value: step.interval, form: 'habit', field: 'step-interval', errors, min: 1, max: MAX_HABIT_INTERVAL_MINUTES,
        dataAttrs: data
      })}
      ${numberField({
        id: `wbhStepTarget-${index}`, label: `<span class="visually-hidden">Askel ${n}: </span>Tavoite / pv`,
        value: step.target, form: 'habit', field: 'step-target', errors, min: 0, max: MAX_HABIT_DAILY_TARGET,
        dataAttrs: data
      })}
      <button type="button" class="assist-btn danger" data-action="habit-step-remove" data-index="${index}" aria-label="Poista askel ${n}">Poista</button>
    </li>`;
}

function habitFormHtml(draft) {
  const errors = draft.errors;
  const deliveries = DELIVERIES
    .filter(value => value !== DELIVERY.CRITICAL_ESCALATION || value === draft.delivery)
    .map(value => [value, deliveryLabel(value)]);
  const steps = draft.steps.length
    ? `<ol class="lh-steps-list">${draft.steps.map((step, index) => stepRowHtml(step, index, errors)).join('')}</ol>`
    : '<p class="hint">Ei vähennysaskeleita.</p>';
  return `<div class="add-form lh-form" role="group" aria-labelledby="wbhHabitFormTitle" data-form-root="habit">
      <div class="add-form-title" id="wbhHabitFormTitle">${draft.id ? 'Muokkaa suunnitelmaa' : 'Uusi suunnitelma'}</div>
      <p class="hint">Luvut ovat omia tavoitteitasi. Sovellus ei arvioi niitä eikä anna terveysneuvoja.</p>
      ${inputField({
        id: 'wbhHabitName', label: 'Nimi', value: draft.name, form: 'habit', field: 'name', errors, required: true,
        attrs: `maxlength="${MAX_HABIT_NAME_LENGTH}" autocomplete="off"`
      })}
      <div class="form-row">
        ${selectField({
          id: 'wbhHabitKind', label: 'Laji', value: draft.kind, form: 'habit', field: 'kind',
          options: [[HABIT_KIND.NICOTINE, 'Nikotiini'], [HABIT_KIND.GENERIC, 'Muu']]
        })}
        ${selectField({ id: 'wbhHabitDelivery', label: 'Muistutustapa', value: draft.delivery, form: 'habit', field: 'delivery', options: deliveries })}
      </div>
      <div class="form-row">
        ${numberField({
          id: 'wbhHabitInterval', label: 'Vähimmäisväli (min)', value: draft.minInterval, form: 'habit',
          field: 'minInterval', errors, min: 1, max: MAX_HABIT_INTERVAL_MINUTES
        })}
        ${numberField({
          id: 'wbhHabitTarget', label: 'Päivätavoite (kertaa)', value: draft.dailyTarget, form: 'habit',
          field: 'dailyTarget', errors, min: 0, max: MAX_HABIT_DAILY_TARGET
        })}
      </div>
      <div class="form-row">
        ${numberField({
          id: 'wbhHabitBaseline', label: 'Lähtötaso (kertaa / pv)', value: draft.baseline, form: 'habit',
          field: 'baseline', errors, min: 0, max: MAX_HABIT_DAILY_TARGET
        })}
        ${inputField({
          id: 'wbhHabitCost', label: 'Yksikköhinta (€)', value: draft.unitCost, form: 'habit', field: 'unitCost', errors,
          attrs: 'inputmode="decimal" autocomplete="off"', hint: 'Esimerkiksi 0,45. Tarvitaan säästön laskemiseen.'
        })}
      </div>
      <fieldset class="lh-steps">
        <legend>Vähennysaskeleet</legend>
        <p class="hint">Askel alkaa valitsemastasi päivästä ja vaihtaa välin tai päivätavoitteen siitä eteenpäin.</p>
        ${steps}
        ${draft.steps.length < MAX_HABIT_STEPS
          ? '<button type="button" class="assist-btn" data-action="habit-step-add">Lisää askel</button>'
          : ''}
      </fieldset>
      ${checkField({ id: 'wbhHabitActive', label: 'Suunnitelma käytössä', checked: draft.active, form: 'habit', field: 'active' })}
      ${formErrorHtml('wbhHabitFormError', errors)}
      ${actionsHtml('habit', draft, { removable: true })}
    </div>`;
}

function habitsHtml(state, today, settings) {
  const plans = [...state.habitPlans].sort((a, b) =>
    Number(b.active !== false) - Number(a.active !== false)
    || String(a.name).localeCompare(String(b.name), 'fi')
    || String(a.id).localeCompare(String(b.id), 'fi'));
  const list = plans.length
    ? `<ul class="lh-list">${plans.map(plan => habitRowHtml(plan, state, today, settings)).join('')}</ul>`
    : '<p class="assist-empty">Ei vielä suunnitelmia. Suunnitelma auttaa harventamaan tapaa omassa tahdissasi.</p>';
  return sectionHtml('habits', 'Tapojen muutos', `
    ${loadFailureHtml(state, ['habitPlans', 'habitEvents'])}
    ${list}
    ${drafts.habit ? habitFormHtml(drafts.habit) : addButtonHtml('habit-add', 'Uusi suunnitelma')}`);
}

// ------------------------------------------------------------ liikunta

function exerciseDraftFrom(session, today) {
  return {
    id: session ? session.id : null,
    date: session ? session.date || today : today,
    kind: session ? session.kind : '',
    planned: numText(session && session.plannedMinutes),
    actual: numText(session && session.actualMinutes),
    intensity: numText(session && session.intensity),
    recovery: numText(session && session.recoveryDemand),
    goalId: session && session.goalId ? session.goalId : '',
    note: session && session.note ? session.note : '',
    errors: {},
    saving: false,
    returnFocus: null
  };
}

function parseScale(raw) {
  const text = String(raw ?? '').trim();
  if (text === '') return null;
  const n = Number(text);
  return Number.isInteger(n) && n >= SCALE_MIN && n <= SCALE_MAX ? n : null;
}

function parseExerciseDraft(draft) {
  const errors = {};
  const date = String(draft.date || '').trim();
  if (!isIsoDate(date)) errors.wbhExerciseDate = 'Valitse päivä.';
  const kind = draft.kind.trim().replace(/\s+/g, ' ');
  if (!kind) errors.wbhExerciseKind = 'Kirjoita laji, esimerkiksi juoksu.';
  const planned = parseWhole(draft.planned, 1, MAX_EXERCISE_MINUTES);
  if (planned.error) errors.wbhExercisePlanned = planned.error;
  const actual = parseWhole(draft.actual, 1, MAX_EXERCISE_MINUTES);
  if (actual.error) errors.wbhExerciseActual = actual.error;
  const note = draft.note.trim();
  return {
    errors,
    input: {
      ...(draft.id ? { id: draft.id } : {}),
      date,
      kind,
      plannedMinutes: planned.value ?? null,
      actualMinutes: actual.value ?? null,
      intensity: parseScale(draft.intensity),
      recoveryDemand: parseScale(draft.recovery),
      goalId: draft.goalId || null,
      note: note || null
    }
  };
}

function scaleOptions(labels) {
  return [['', 'Ei arvioitu'], ...labels.map((label, index) => [String(index + 1), `${index + 1} – ${label}`])];
}

function exerciseFormHtml(draft, state) {
  const errors = draft.errors;
  const goals = (state.goals || [])
    .filter(goal => goal && goal.id && (OPEN_GOAL_STATUSES.has(goal.status) || goal.id === draft.goalId))
    .sort((a, b) => String(a.title).localeCompare(String(b.title), 'fi'));
  const kinds = [];
  for (const session of [...state.exerciseSessions].sort((a, b) => String(b.date).localeCompare(String(a.date)))) {
    const kind = typeof session.kind === 'string' ? session.kind.trim() : '';
    if (kind && !kinds.some(known => known.toLocaleLowerCase('fi') === kind.toLocaleLowerCase('fi'))) kinds.push(kind);
    if (kinds.length >= KIND_SUGGESTIONS) break;
  }
  return `<div class="add-form lh-form" role="group" aria-labelledby="wbhExerciseFormTitle" data-form-root="exercise">
      <div class="add-form-title" id="wbhExerciseFormTitle">${draft.id ? 'Muokkaa liikuntakertaa' : 'Kirjaa liikuntaa'}</div>
      <div class="form-row">
        ${inputField({ id: 'wbhExerciseDate', label: 'Päivä', value: draft.date, form: 'exercise', field: 'date', errors, type: 'date', required: true })}
        ${inputField({
          id: 'wbhExerciseKind', label: 'Laji', value: draft.kind, form: 'exercise', field: 'kind', errors, required: true,
          attrs: `maxlength="${MAX_EXERCISE_KIND_LENGTH}" autocomplete="off"${kinds.length ? ' list="wbhExerciseKinds"' : ''}`
        })}
      </div>
      ${kinds.length ? `<datalist id="wbhExerciseKinds">${kinds.map(kind => `<option value="${escapeHtml(kind)}"></option>`).join('')}</datalist>` : ''}
      <div class="form-row">
        ${numberField({
          id: 'wbhExercisePlanned', label: 'Suunniteltu (min)', value: draft.planned, form: 'exercise', field: 'planned',
          errors, min: 1, max: MAX_EXERCISE_MINUTES
        })}
        ${numberField({
          id: 'wbhExerciseActual', label: 'Toteutunut (min)', value: draft.actual, form: 'exercise', field: 'actual',
          errors, min: 1, max: MAX_EXERCISE_MINUTES
        })}
      </div>
      <div class="form-row">
        ${selectField({ id: 'wbhExerciseIntensity', label: 'Rasittavuus', value: draft.intensity, form: 'exercise', field: 'intensity', options: scaleOptions(INTENSITY_LABELS) })}
        ${selectField({ id: 'wbhExerciseRecovery', label: 'Palautumistarve', value: draft.recovery, form: 'exercise', field: 'recovery', options: scaleOptions(RECOVERY_LABELS) })}
      </div>
      ${selectField({
        id: 'wbhExerciseGoal', label: 'Tavoite', value: draft.goalId, form: 'exercise', field: 'goalId',
        options: [['', 'Ei tavoitetta'], ...goals.map(goal => [goal.id, goal.title])]
      })}
      ${textareaField({ id: 'wbhExerciseNote', label: 'Muistiinpano', value: draft.note, form: 'exercise', field: 'note', maxLength: MAX_EXERCISE_NOTE_LENGTH })}
      ${formErrorHtml('wbhExerciseFormError', errors)}
      ${actionsHtml('exercise', draft, { removable: true })}
    </div>`;
}

function weekSummaryHtml(state, today) {
  const monday = shiftDateIso(today, -(isoWeekday(today) - 1));
  const week = weeklyExercise({ sessions: state.exerciseSessions, weekStart: monday });
  const last = weeklyExercise({ sessions: state.exerciseSessions, weekStart: shiftDateIso(monday, -7) });
  if (!week || !last) return '';
  const facts = [`Liikuntapäiviä ${week.activeDays}/7`];
  if (week.completionPercent !== null) facts.push(`toteuma ${week.completionPercent} % suunnitellusta`);
  if (week.intensityAverage !== null) facts.push(`rasittavuus keskimäärin ${decimal(week.intensityAverage)}/${SCALE_MAX}`);
  const hints = week.recoveryHints.map(hint => `<p class="assist-reason">${escapeHtml(hint.text)}</p>`).join('');
  return `<div class="lh-summary" role="group" aria-label="Liikunnan viikkoyhteenveto">
      <p><strong>Tämä viikko:</strong> ${escapeHtml(week.text)}</p>
      <p>${facts.join(' · ')}.</p>
      ${hints}
      <p><strong>Viime viikko:</strong> ${escapeHtml(last.text)}</p>
    </div>`;
}

function sessionRowHtml(session, goalsById) {
  const id = escapeHtml(session.id);
  const kind = escapeHtml(session.kind);
  const minutes = [
    session.actualMinutes !== null ? `toteutunut ${durationText(session.actualMinutes)}` : 'toteutunut: ei kirjattu',
    session.plannedMinutes !== null ? `suunniteltu ${durationText(session.plannedMinutes)}` : null
  ].filter(Boolean);
  const ratings = [
    session.intensity !== null ? `rasittavuus ${session.intensity}/${SCALE_MAX}` : null,
    session.recoveryDemand !== null ? `palautumistarve ${session.recoveryDemand}/${SCALE_MAX}` : null
  ].filter(Boolean);
  const goal = session.goalId ? goalsById.get(session.goalId) : null;
  return `<li class="assist-row lh-row" data-exercise-row="${id}">
      <div class="assist-title">${kind}</div>
      <div class="assist-meta">${dateLabel(session.date)} · ${minutes.join(' · ')}</div>
      ${ratings.length ? `<div class="assist-meta">${ratings.join(' · ')}</div>` : ''}
      ${goal ? `<div class="assist-meta">Tavoite: ${escapeHtml(goal.title)}</div>` : ''}
      ${session.note ? `<div class="assist-reason">${escapeHtml(session.note)}</div>` : ''}
      <div class="assist-actions">
        <button type="button" class="assist-btn" data-action="exercise-edit" data-id="${id}" aria-label="Muokkaa liikuntakertaa ${kind} ${dateLabel(session.date)}">Muokkaa</button>
        <button type="button" class="assist-btn danger" data-action="exercise-delete" data-id="${id}" aria-label="Poista liikuntakerta ${kind} ${dateLabel(session.date)}">Poista</button>
      </div>
    </li>`;
}

function exerciseHtml(state, today) {
  const goalsById = new Map((state.goals || []).filter(goal => goal && goal.id).map(goal => [goal.id, goal]));
  const recent = [...state.exerciseSessions]
    .filter(session => isIsoDate(session.date))
    .sort((a, b) => String(b.date).localeCompare(String(a.date))
      || String(a.kind).localeCompare(String(b.kind), 'fi')
      || String(a.id).localeCompare(String(b.id), 'fi'))
    .slice(0, RECENT_SESSIONS);
  const list = recent.length
    ? `<ul class="lh-list">${recent.map(session => sessionRowHtml(session, goalsById)).join('')}</ul>`
    : '<p class="assist-empty">Ei vielä liikuntakirjauksia.</p>';
  return sectionHtml('exercise', 'Liikunta', `
    ${loadFailureHtml(state, ['exerciseSessions'])}
    ${weekSummaryHtml(state, today)}
    ${list}
    ${drafts.exercise ? exerciseFormHtml(drafts.exercise, state) : addButtonHtml('exercise-add', 'Kirjaa liikuntaa')}`);
}

// ------------------------------------------------------------ uni

function sleepDraftFrom(log, today) {
  return {
    editing: Boolean(log),
    wakeDate: log ? log.wakeDate : today,
    bedtime: log && log.actualBedtime ? log.actualBedtime : '',
    wake: log && log.actualWake ? log.actualWake : '',
    note: log && log.note ? log.note : '',
    errors: {},
    saving: false,
    returnFocus: null
  };
}

function parseSleepDraft(draft, today) {
  const errors = {};
  const wakeDate = String(draft.wakeDate || '').trim();
  if (!isIsoDate(wakeDate)) errors.wbhSleepDate = 'Valitse heräämispäivä.';
  else if (wakeDate > today) errors.wbhSleepDate = 'Heräämispäivä ei voi olla tulevaisuudessa.';
  const bedtime = String(draft.bedtime || '').trim();
  const wake = String(draft.wake || '').trim();
  if (bedtime && !TIME_PATTERN.test(bedtime)) errors.wbhSleepBedtime = 'Anna kellonaika muodossa 23.15.';
  if (wake && !TIME_PATTERN.test(wake)) errors.wbhSleepWake = 'Anna kellonaika muodossa 6.45.';
  if (!bedtime && !wake) errors.wbhSleepFormError = 'Kirjaa ainakin nukkumaanmeno tai herääminen.';
  const note = draft.note.trim();
  return {
    errors,
    input: {
      wakeDate,
      actualBedtime: bedtime || null,
      actualWake: wake || null,
      note: note || null
    }
  };
}

function sleepFormHtml(draft) {
  const errors = draft.errors;
  const dateField = draft.editing
    ? `<p class="assist-meta">Heräämispäivä ${dateLabel(draft.wakeDate)}</p>`
    : inputField({
      id: 'wbhSleepDate', label: 'Heräämispäivä', value: draft.wakeDate, form: 'sleep', field: 'wakeDate', errors,
      type: 'date', required: true, hint: 'Saman päivän aiempi kirjaus päivittyy.'
    });
  return `<div class="add-form lh-form" role="group" aria-labelledby="wbhSleepFormTitle" data-form-root="sleep">
      <div class="add-form-title" id="wbhSleepFormTitle">${draft.editing ? 'Muokkaa unikirjausta' : 'Kirjaa yö'}</div>
      ${dateField}
      <div class="form-row">
        ${inputField({ id: 'wbhSleepBedtime', label: 'Meni nukkumaan', value: draft.bedtime, form: 'sleep', field: 'bedtime', errors, type: 'time' })}
        ${inputField({ id: 'wbhSleepWake', label: 'Heräsi', value: draft.wake, form: 'sleep', field: 'wake', errors, type: 'time' })}
      </div>
      ${textareaField({ id: 'wbhSleepNote', label: 'Muistiinpano', value: draft.note, form: 'sleep', field: 'note', maxLength: MAX_SLEEP_NOTE_LENGTH })}
      ${formErrorHtml('wbhSleepFormError', errors)}
      ${actionsHtml('sleep', draft, { removable: false })}
    </div>`;
}

function driftHtml(state, today, settings) {
  const report = driftReport({
    logs: state.sleepLogs, profile: state.profile, settings, todayIso: today, offsetMinutesFn: deviceOffsetMinutes
  });
  if (!report) return '';
  const weeks = Math.round(DRIFT_WINDOW_DAYS / 7);
  let text;
  if (report.drifting) text = report.message;
  else if (report.weekends.length === 0) {
    text = `Rytmin siirtymää ei voi vielä arvioida: viikonlopun kirjauksia ei ole viimeisen ${weeks} viikon ajalta.`;
  } else if (report.beyondCount === 0) {
    text = `Viikonlopun rytmi on pysynyt asettamasi väljyyden sisällä (${report.weekends.length} viikonloppua `
      + `viimeisen ${weeks} viikon ajalta).`;
  } else {
    text = 'Väljyys ylittyi yhtenä viikonloppuna. Siirtymästä kerrotaan, jos se toistuu.';
  }
  const basis = report.reference.wakeBasis === REFERENCE_BASIS.OBSERVED ? 'arkiaamujen kirjauksistasi' : 'profiilistasi';
  return `<div class="lh-summary" role="group" aria-label="Unirytmin siirtymä">
      <p>${escapeHtml(text)}</p>
      <p>Vertailukohta: arkiherätys ${clockText(report.reference.wake)} (${basis}).</p>
    </div>`;
}

function sleepRowHtml(log) {
  const minutes = sleepOpportunity(log, { offsetMinutesFn: deviceOffsetMinutes });
  const parts = [
    log.actualBedtime ? `nukkumaan ${clockText(log.actualBedtime)}` : null,
    log.actualWake ? `heräsi ${clockText(log.actualWake)}` : null
  ].filter(Boolean);
  const inBed = minutes !== null ? `vuoteessa ${durationText(minutes)}` : 'vuoteessa oloaika ei tiedossa';
  const date = escapeHtml(log.wakeDate);
  return `<li class="assist-row lh-row" data-sleep-row="${date}">
      <div class="assist-title">${dateLabel(log.wakeDate)}</div>
      <div class="assist-meta">${[...parts, inBed].join(' · ')}</div>
      ${log.note ? `<div class="assist-reason">${escapeHtml(log.note)}</div>` : ''}
      <div class="assist-actions">
        <button type="button" class="assist-btn" data-action="sleep-edit" data-id="${date}" aria-label="Muokkaa unikirjausta ${dateLabel(log.wakeDate)}">Muokkaa</button>
      </div>
    </li>`;
}

function sleepHtml(state, today, settings) {
  const from = shiftDateIso(today, -(HISTORY_DAYS - 1));
  const logs = state.sleepLogs
    .filter(log => isIsoDate(log.wakeDate) && log.wakeDate >= from && log.wakeDate <= today)
    .sort((a, b) => b.wakeDate.localeCompare(a.wakeDate));
  const list = logs.length
    ? `<ul class="lh-list">${logs.map(sleepRowHtml).join('')}</ul>`
    : `<p class="assist-empty">Ei unikirjauksia viimeisen ${HISTORY_DAYS} päivän ajalta.</p>`;
  return sectionHtml('sleep', 'Uni', `
    ${loadFailureHtml(state, ['sleepLogs'])}
    <p class="notice tone-sage lh-sleep-note">Tämä on vuoteessa oloaika, ei mitattua unta. Sovellus tietää vain
      kirjaamasi kellonajat, eikä se tee terveysarvioita.</p>
    ${driftHtml(state, today, settings)}
    ${list}
    ${drafts.sleep ? sleepFormHtml(drafts.sleep) : addButtonHtml('sleep-add', 'Kirjaa yö')}`);
}

// ------------------------------------------------------------ piirto

function hubHtml() {
  const state = getState();
  const today = todayIso();
  const settings = currentLifeSettings(state);
  return `<div class="lh-hub" data-lh="wellbeing">
    ${persistenceNoticeHtml()}
    ${historyHtml(state, today)}
    ${habitsHtml(state, today, settings)}
    ${exerciseHtml(state, today)}
    ${sleepHtml(state, today, settings)}
  </div>`;
}

/** Varaotsikko: sen osion otsikko, jossa fokus oli (ei koko näkymän alku). */
function fallbackFor(container) {
  const active = typeof document !== 'undefined' ? document.activeElement : null;
  const section = active && container.contains(active) && typeof active.closest === 'function'
    ? active.closest('[data-section]')
    : null;
  const heading = section ? section.getAttribute('data-heading') : null;
  return heading ? [heading, SECTION_HEADINGS.history] : [SECTION_HEADINGS.history];
}

/**
 * Piirrä Hyvinvointi-osio säiliöön. Lukee tilan (getState) ja luonnokset;
 * ei muuta mitään. Sitoo kuuntelijat, jos initWellbeingHub jäi kutsumatta.
 *
 * @param {Element} container esim. #profileWellbeingSection
 */
export function renderWellbeingHub(container) {
  if (!container) return;
  initWellbeingHub(container);
  renderHtml(container, hubHtml(), { fallback: fallbackFor(container) });
}

// ------------------------------------------------------------ fokus

function focusIn(container, ...selectors) {
  for (const selector of selectors) {
    if (!selector) continue;
    const node = container.querySelector(selector);
    if (node && typeof node.focus === 'function' && !node.disabled) {
      node.focus();
      return node;
    }
  }
  return null;
}

function focusFirstInvalid(container, form) {
  const root = container.querySelector(`[data-form-root="${form}"]`);
  const invalid = root ? root.querySelector('[aria-invalid="true"]') : null;
  if (invalid) invalid.focus();
  else focusIn(container, `#${formErrorId(form)}`, `[data-action="${form}-save"]`);
}

function formErrorId(form) {
  return { habit: 'wbhHabitFormError', exercise: 'wbhExerciseFormError', sleep: 'wbhSleepFormError' }[form];
}

const FIRST_FIELD = Object.freeze({ habit: '#wbhHabitName', exercise: '#wbhExerciseKind', sleep: '#wbhSleepDate' });

// ------------------------------------------------------------ toiminnot

function openForm(container, form, draft, opener) {
  draft.returnFocus = opener;
  drafts[form] = draft;
  renderWellbeingHub(container);
  focusIn(container, FIRST_FIELD[form], '#wbhSleepBedtime');
}

function closeForm(container, form, { focus = true } = {}) {
  const draft = drafts[form];
  drafts[form] = null;
  renderWellbeingHub(container);
  if (focus) {
    focusIn(container, draft && draft.returnFocus, `[data-action="${form}-add"]`,
      `#${SECTION_HEADINGS[form === 'habit' ? 'habits' : form]}`);
  }
}

/** Kentän virheavaimet tallennustoiminnon validoinnista -> kentän tunniste. */
function mapActionErrors(errors, fields, formError) {
  const mapped = {};
  for (const [key, message] of Object.entries(errors || {})) {
    mapped[fields[key] || formError] = message;
  }
  return mapped;
}

/**
 * Yhteinen tallennusrunko: jäsennys -> kenttävirheet tai tallennus ->
 * lomake kiinni ja fokus riville, tai virheet näkyviin. Luonnoksen
 * `saving` piirtää painikkeen varatuksi merkinnässä, joten uudelleenpiirto
 * kesken tallennuksen ei vapauta sitä.
 */
async function submitDraft(container, form, { parse, save, fields, done }) {
  const draft = drafts[form];
  if (!draft || draft.saving) return;
  const { input, errors } = parse(draft);
  if (Object.keys(errors).length > 0) {
    draft.errors = errors;
    renderWellbeingHub(container);
    focusFirstInvalid(container, form);
    return;
  }
  draft.errors = {};
  draft.saving = true;
  renderWellbeingHub(container);
  const result = await save(input);
  // Lomake suljettiin tai istunto vaihtui kesken: vastausta ei sovelleta.
  if (drafts[form] !== draft) return;
  draft.saving = false;
  if (result && result.ok) {
    drafts[form] = null;
    renderWellbeingHub(container);
    done(result, draft);
    return;
  }
  if (result && result.discarded) return;
  if (result && result.errors) draft.errors = mapActionErrors(result.errors, fields, formErrorId(form));
  renderWellbeingHub(container);
  if (result && result.errors) focusFirstInvalid(container, form);
  else focusIn(container, `[data-action="${form}-save"]`);
}

const saveHabit = singleFlight(container => submitDraft(container, 'habit', {
  parse: parseHabitDraft,
  save: saveHabitPlan,
  fields: { name: 'wbhHabitName', kind: 'wbhHabitKind' },
  done(result, draft) {
    success(draft.id ? 'Suunnitelma päivitetty.' : 'Suunnitelma tallennettu.');
    focusIn(container, `[data-action="habit-edit"][data-id="${attrValue(result.plan.id)}"]`, '[data-action="habit-add"]');
  }
}));

const saveExercise = singleFlight(container => submitDraft(container, 'exercise', {
  parse: parseExerciseDraft,
  save: saveExerciseSession,
  fields: { date: 'wbhExerciseDate', kind: 'wbhExerciseKind' },
  done(result, draft) {
    success(draft.id ? 'Liikuntakerta päivitetty.' : 'Liikunta kirjattu.');
    focusIn(container, `[data-action="exercise-edit"][data-id="${attrValue(result.session.id)}"]`, '[data-action="exercise-add"]');
  }
}));

const saveSleep = singleFlight(container => submitDraft(container, 'sleep', {
  parse: draft => parseSleepDraft(draft, todayIso()),
  save: saveSleepLog,
  fields: { wakeDate: 'wbhSleepDate' },
  done(result) {
    success('Yö kirjattu.');
    focusIn(container, `[data-action="sleep-edit"][data-id="${attrValue(result.log.wakeDate)}"]`, '[data-action="sleep-add"]');
  }
}));

/** Poisto kysyy vahvistuksen (toiminto itse); onnistuessa fokus lisäyspainikkeeseen. */
const removeHabit = singleFlight(async (container, id) => {
  const result = await deleteHabitPlan(id);
  if (!result || !result.ok) return;
  if (drafts.habit && drafts.habit.id === id) drafts.habit = null;
  renderWellbeingHub(container);
  success('Suunnitelma poistettu.');
  focusIn(container, '[data-action="habit-add"]', `#${SECTION_HEADINGS.habits}`);
});

const removeExercise = singleFlight(async (container, id) => {
  const result = await deleteExerciseSession(id);
  if (!result || !result.ok) return;
  if (drafts.exercise && drafts.exercise.id === id) drafts.exercise = null;
  renderWellbeingHub(container);
  success('Liikuntakerta poistettu.');
  focusIn(container, '[data-action="exercise-add"]', `#${SECTION_HEADINGS.exercise}`);
});

function openerSelector(action, id) {
  return id ? `[data-action="${action}"][data-id="${attrValue(id)}"]` : `[data-action="${action}"]`;
}

function onClick(container, event) {
  const button = event.target && typeof event.target.closest === 'function'
    ? event.target.closest('[data-action]')
    : null;
  if (!button || !container.contains(button) || button.disabled) return;
  const state = getState();
  const today = todayIso();
  const id = button.getAttribute('data-id');
  switch (button.getAttribute('data-action')) {
    case 'habit-add':
      openForm(container, 'habit', habitDraftFrom(null), openerSelector('habit-add'));
      break;
    case 'habit-edit': {
      const plan = state.habitPlans.find(item => item.id === id);
      if (plan) openForm(container, 'habit', habitDraftFrom(plan), openerSelector('habit-edit', id));
      break;
    }
    case 'habit-delete':
      removeHabit(container, id);
      break;
    case 'habit-remove':
      if (drafts.habit && drafts.habit.id) removeHabit(container, drafts.habit.id);
      break;
    case 'habit-step-add':
      if (drafts.habit && drafts.habit.steps.length < MAX_HABIT_STEPS) {
        drafts.habit.steps.push({ from: '', interval: '', target: '' });
        renderWellbeingHub(container);
        focusIn(container, `#wbhStepFrom-${drafts.habit.steps.length - 1}`);
      }
      break;
    case 'habit-step-remove': {
      const index = Number(button.getAttribute('data-index'));
      if (drafts.habit && Number.isInteger(index) && drafts.habit.steps[index]) {
        drafts.habit.steps.splice(index, 1);
        // Rivien tunnisteet siirtyvät: vanhat rivikohtaiset virheet eivät enää osu oikein.
        drafts.habit.errors = Object.fromEntries(Object.entries(drafts.habit.errors)
          .filter(([key]) => !key.startsWith('wbhStep')));
        renderWellbeingHub(container);
        focusIn(container, `[data-action="habit-step-remove"][data-index="${Math.min(index, drafts.habit.steps.length - 1)}"]`,
          '[data-action="habit-step-add"]');
      }
      break;
    }
    case 'habit-save': saveHabit(container); break;
    case 'habit-cancel': closeForm(container, 'habit'); break;

    case 'exercise-add':
      openForm(container, 'exercise', exerciseDraftFrom(null, today), openerSelector('exercise-add'));
      break;
    case 'exercise-edit': {
      const session = state.exerciseSessions.find(item => item.id === id);
      if (session) openForm(container, 'exercise', exerciseDraftFrom(session, today), openerSelector('exercise-edit', id));
      break;
    }
    case 'exercise-delete':
      removeExercise(container, id);
      break;
    case 'exercise-remove':
      if (drafts.exercise && drafts.exercise.id) removeExercise(container, drafts.exercise.id);
      break;
    case 'exercise-save': saveExercise(container); break;
    case 'exercise-cancel': closeForm(container, 'exercise'); break;

    case 'sleep-add':
      openForm(container, 'sleep', sleepDraftFrom(null, today), openerSelector('sleep-add'));
      break;
    case 'sleep-edit': {
      const log = state.sleepLogs.find(item => item.wakeDate === id);
      if (log) openForm(container, 'sleep', sleepDraftFrom(log, today), openerSelector('sleep-edit', id));
      break;
    }
    case 'sleep-save': saveSleep(container); break;
    case 'sleep-cancel': closeForm(container, 'sleep'); break;
    default: break;
  }
}

const STEP_PARTS = Object.freeze({ 'step-from': 'from', 'step-interval': 'interval', 'step-target': 'target' });

/** Näppäily päivittää luonnoksen, ei piirrä: kirjoitus ei katkea. */
function onFieldInput(event) {
  const target = event.target;
  if (!target || typeof target.getAttribute !== 'function') return;
  const form = target.getAttribute('data-form');
  const draft = form ? drafts[form] : null;
  const field = target.getAttribute('data-field');
  if (!draft || !field) return;
  const value = target.type === 'checkbox' ? Boolean(target.checked) : String(target.value ?? '');
  if (STEP_PARTS[field]) {
    const step = draft.steps[Number(target.getAttribute('data-index'))];
    if (step) step[STEP_PARTS[field]] = value;
  } else {
    draft[field] = value;
  }
}

const SAVE = Object.freeze({ habit: saveHabit, exercise: saveExercise, sleep: saveSleep });

/** Enter tekstikentässä tallentaa, Escape sulkee lomakkeen (kuten tehtävälomake). */
function onKeydown(container, event) {
  const target = event.target;
  if (!target || typeof target.closest !== 'function') return;
  const root = target.closest('[data-form-root]');
  if (!root || !container.contains(root)) return;
  const form = root.getAttribute('data-form-root');
  if (event.key === 'Escape') {
    event.preventDefault();
    closeForm(container, form);
    return;
  }
  if (event.key === 'Enter' && target.localName === 'input' && target.type !== 'checkbox') {
    event.preventDefault();
    SAVE[form](container);
  }
}

/**
 * Sido delegoidut kuuntelijat säiliöön KERRAN. Turvallinen kutsua monta
 * kertaa samalle säiliölle; uusi säiliö saa omat kuuntelijansa.
 *
 * @param {Element} container esim. #profileWellbeingSection
 */
export function initWellbeingHub(container) {
  if (!container || bound.has(container) || typeof container.addEventListener !== 'function') return;
  bound.add(container);
  container.addEventListener('click', event => onClick(container, event));
  container.addEventListener('input', onFieldInput);
  container.addEventListener('change', onFieldInput);
  container.addEventListener('keydown', event => onKeydown(container, event));
}
