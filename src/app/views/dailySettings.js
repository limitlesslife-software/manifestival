// Arki (Profiili → Arki): uni ja rytmi, aamurutiini, herätys, aamukatsaus
// ja ateriat.
//
// MISTÄ ARVOT TULEVAT
//
// Unitavoite ja arkiherätys asuvat profiilissa (profile.sleepTargetHours,
// profile.defaultWakeTime) ja tallentuvat profiilin omaa polkua
// (actions.saveProfile). Kaikki muu on arjen asetuksissa (life_settings,
// dailyLifeActions.saveLifeSettings). Sama arvo ei asu kahdessa paikassa:
// Asetukset-osion profiililomake näyttää samat kaksi kenttää, ja tallennus
// täältä päivittää nekin, ettei vanha lomake kirjoita vanhaa arvoa takaisin.
//
// LUONNOS SÄILYY PIIRTOJEN YLI
//
// Näkymä piirretään jokaisesta tilamuutoksesta. Jos kentät tulisivat vain
// tilasta, kesken oleva muokkaus katoaisi heti, kun jokin muu tallentuu.
// Siksi jokaisella osiolla on oma luonnoksensa: kirjoitettu arvo kirjataan
// luonnokseen, ja piirto käyttää sitä, kunnes osio tallennetaan tai
// perutaan. Osiot piirretään omiin säiliöihinsä (renderHtml ohittaa
// identtisen merkinnän), joten yhden osion tallennus ei kirjoita toisen
// kenttiä uudelleen.
//
// LUPIA EI PYYDETÄ PIIRROSSA
//
// Android-herätyksen tila luetaan (status), mutta järjestelmäasetusten avaus
// (täsmälliset herätykset, koko näytön herätys) ja herätysäänen valinta
// tehdään VAIN käyttäjän napautuksesta. Selaimessa kerrotaan suoraan, ettei
// herätys soi: lupausta ei anneta yli sen, mitä alusta oikeasti tekee.
//
// PUHE ON KÄYTTÄJÄN VALINTA: voimistuvan herätyksen puhevaiheet tulevat
// mukaan vain, kun herätyksen tavaksi on valittu puhe tai ääni ja puhe.

import { escapeHtml } from '../../lib/format.js';
import { maybe, renderHtml, renderAnnouncingError, setBusy, singleFlight } from '../../ui/dom.js';
import { success } from '../../ui/toast.js';
import { getState, currentLifeSettings } from '../state.js';
import { saveProfile } from '../actions.js';
import { saveLifeSettings } from '../dailyLifeActions.js';
import { deviceOffsetMinutes } from '../deviceTime.js';
import * as platform from '../../platform/index.js';
import { hasTable, isTableAvailable } from '../../data/schema.js';
import { serverUnavailableHintHtml } from '../schemaStatus.js';
import {
  PROTECTION, PROTECTIONS, protectionLabel, ALARM_MODE, ALARM_MODES, alarmModeLabel, ESCALATION_STEP,
  MAX_MORNING_STEPS, MAX_MEALS, MAX_SNOOZE_MINUTES, MAX_SNOOZES, MAX_WEEKEND_SHIFT_MINUTES,
  MAX_WIND_DOWN_MINUTES
} from '../../domain/dailyLife.js';
import {
  MAX_STEP_NAME_LENGTH, MAX_STEP_MINUTES, MAX_MEAL_PREP_MINUTES, MAX_SUPPLEMENTS, MAX_WATER_INTERVAL_MINUTES
} from '../../domain/lifeSettings.js';
import { validateMealRhythm } from '../../domain/mealRhythm.js';
import { MEAL_RULES } from '../../domain/dailyLifeSignalsPolicy.js';
import { desiredAlarms, alarmEpoch } from '../../domain/alarmPlan.js';
import { sleepScheduleFor, MIN_SLEEP_TARGET_HOURS, MAX_SLEEP_TARGET_HOURS } from '../../domain/sleepRhythm.js';
import { expandEventOccurrences, shortDateLabel } from '../../domain/calendar.js';
import { planDeparture } from '../../domain/departure.js';
import { clockText, durationText, shiftDateIso, epochToWallClock } from '../../domain/wallClock.js';

// ------------------------------------------------------------ säiliöt

const CONTAINERS = Object.freeze({
  notice: 'dailyLifeNotice',
  sleep: 'dailySleepSettings',
  routine: 'dailyRoutineSettings',
  alarmNext: 'dailyAlarmNext',
  status: 'dailyAlarmStatus',
  alarm: 'dailyAlarmSettings',
  brief: 'dailyBriefSettings',
  meals: 'dailyMealSettings'
});

/** Osion tallennuspainike: Enter kentässä tallentaa oman osionsa. */
const SAVE_BUTTONS = Object.freeze({
  sleep: 'dsSleepSave', routine: 'dsRoutineSave', alarm: 'dsAlarmSave', meals: 'dsMealSave'
});

/** Piirron jälkeinen varakohde fokukselle: osion otsikko (index.html). */
const TITLES = Object.freeze({
  sleep: 'dailySleepTitle', routine: 'dailyRoutineTitle', alarm: 'dailyAlarmTitle',
  status: 'dailyAlarmTitle', brief: 'dailyBriefTitle', meals: 'dailyMealTitle'
});

// ------------------------------------------------------------ paikallinen tila

/** Kesken olevat muokkaukset osioittain. null = näytä tallennettu. */
let drafts = { sleep: null, routine: null, alarm: null, meals: null };
/** Osioiden virheet: kentän avain -> suomenkielinen viesti. */
let sectionErrors = { sleep: {}, routine: {}, alarm: {}, meals: {} };

const INITIAL_STATUS = Object.freeze({ state: 'idle', value: null, checkedAt: 0 });
/** Android-herätyksen viimeisin tila (ei käyttäjän dataa, mutta nollataan silti uloskirjautuessa). */
let alarmStatus = INITIAL_STATUS;
let statusInFlight = false;
/** Tila luetaan uudelleen piirrossa, kun edellisestä on kulunut näin kauan (sovellukseen palatessa). */
const STATUS_MAX_AGE_MS = 15000;

/** Testisauma: korvaava herätysalusta { alarms, native }. */
let platformOverride = null;

/** Uloskirjautuminen: seuraava käyttäjä ei näe edellisen luonnoksia. */
export function resetDailySettings() {
  drafts = { sleep: null, routine: null, alarm: null, meals: null };
  sectionErrors = { sleep: {}, routine: {}, alarm: {}, meals: {} };
  alarmStatus = INITIAL_STATUS;
  statusInFlight = false;
  // Kirjoitettu arvo elää kentän DOM-solmussa. Jos merkintä ei muutu,
  // renderHtml ei kirjoita solmua uudelleen, ja edellisen käyttäjän
  // tallentamaton syöte jäisi näkyviin. Tyhjä säiliö piirretään aina alusta.
  if (typeof document === 'undefined') return;
  for (const id of Object.values(CONTAINERS)) {
    const node = maybe(id);
    if (node) node.innerHTML = '';
  }
}

/** Testejä varten: herätysalustan kaksoiskappale (null palauttaa oikean). */
export function setAlarmPlatformForTests(override) {
  platformOverride = override && typeof override === 'object' ? override : null;
  alarmStatus = INITIAL_STATUS;
  statusInFlight = false;
}

// ------------------------------------------------------------ apurit

const INTEGER = /^\d+$/;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

const textOf = value => String(value ?? '').trim();
const hasText = value => textOf(value) !== '';

/** Kokonaisluku väliltä tai null (tyhjä, desimaali tai kirjain ei kelpaa). */
function intIn(value, min, max) {
  const text = textOf(value);
  if (!INTEGER.test(text)) return null;
  const n = Number(text);
  return n >= min && n <= max ? n : null;
}

const timeOf = value => (TIME.test(textOf(value)) ? textOf(value) : null);

function valueIn(root, selector) {
  const node = root && typeof root.querySelector === 'function' ? root.querySelector(selector) : null;
  return node ? String(node.value ?? '') : '';
}

function checkedIn(root, selector) {
  const node = root && typeof root.querySelector === 'function' ? root.querySelector(selector) : null;
  return Boolean(node && node.checked);
}

function result(errors) {
  return { valid: Object.keys(errors).length === 0, errors };
}

function errorHtml(id, message) {
  return message
    ? `<div class="field-error" id="${id}Error" role="alert" style="display:block;">${escapeHtml(message)}</div>`
    : '';
}

function invalidAttrs(id, message) {
  return message ? ` aria-invalid="true" aria-describedby="${id}Error"` : '';
}

function numberField({ id, label, value, min, max, step = 1, error = '', data = '' }) {
  return `<div>
      <label class="field-label" for="${id}">${escapeHtml(label)}</label>
      <input type="number" id="${id}" min="${min}" max="${max}" step="${step}" inputmode="${step === 1 ? 'numeric' : 'decimal'}"`
    + ` value="${escapeHtml(value)}"${data}${invalidAttrs(id, error)}>
      ${errorHtml(id, error)}
    </div>`;
}

function timeField({ id, label, value, error = '', data = '' }) {
  return `<div>
      <label class="field-label" for="${id}">${escapeHtml(label)}</label>
      <input type="time" id="${id}" value="${escapeHtml(value)}"${data}${invalidAttrs(id, error)}>
      ${errorHtml(id, error)}
    </div>`;
}

function textField({ id, label, value, max, error = '', data = '' }) {
  return `<div>
      <label class="field-label" for="${id}">${escapeHtml(label)}</label>
      <input type="text" id="${id}" maxlength="${max}" autocomplete="off" value="${escapeHtml(value)}"${data}`
    + `${invalidAttrs(id, error)}>
      ${errorHtml(id, error)}
    </div>`;
}

function listError(id, message) {
  return message ? `<div class="field-error" id="${id}" role="alert" style="display:block;">${escapeHtml(message)}</div>` : '';
}

function render(key, html) {
  return renderHtml(maybe(CONTAINERS[key]), html, { fallback: TITLES[key] ? [TITLES[key]] : [] });
}

/** Piirrä osio virheen jälkeen: sama virhe kuulutetaan uudelleen (ks. dom.js). */
function renderWithErrors(key, draw) {
  const first = Object.keys(sectionErrors[key] || {})[0];
  const alertId = first ? errorIdOf(key, first) : null;
  if (alertId) renderAnnouncingError(alertId, draw);
  else draw();
}

/** Virheen avaimesta kentän virheilmoituksen tunniste. */
function errorIdOf(section, key) {
  if (section === 'routine') {
    if (key === 'list') return 'dsRoutineError';
    const [index, field] = key.split('.');
    return `dsStep${field === 'name' ? 'Name' : field === 'minutes' ? 'Minutes' : 'Protection'}-${index}Error`;
  }
  if (section === 'meals') {
    if (MEAL_LIST_ERROR_IDS[key]) return MEAL_LIST_ERROR_IDS[key];
    return MEAL_FIELD_IDS[key] ? `${MEAL_FIELD_IDS[key]}Error` : mealRowErrorId(key);
  }
  if (section === 'sleep') return key === 'general' ? 'dsSleepError' : `${SLEEP_IDS[key]}Error`;
  if (section === 'alarm') return key === 'general' || key === 'times' ? `dsAlarm${key === 'times' ? 'Times' : ''}Error` : `${ALARM_IDS[key]}Error`;
  return null;
}

// ------------------------------------------------------------ huomautus

function noticeHtml() {
  if (isTableAvailable('lifeSettings')) return '';
  if (hasTable('lifeSettings')) return serverUnavailableHintHtml();
  return '<p class="hint"><strong>Huom.</strong> Arjen asetukset säilyvät toistaiseksi vain tämän istunnon ajan. '
    + 'Unitavoite ja arkiherätys tallentuvat profiiliin pysyvästi.</p>';
}

// ================================================================ uni ja rytmi

const SLEEP_IDS = Object.freeze({
  sleepTarget: 'dsSleepTarget',
  wakeTime: 'dsWakeTime',
  weekendWakeShift: 'dsWeekendWakeShift',
  weekendBedShift: 'dsWeekendBedShift',
  windDown: 'dsWindDown',
  bedtimeTarget: 'dsBedtimeTarget'
});

function savedSleepValues(state, settings) {
  const profile = state.profile || {};
  return {
    sleepTarget: String(profile.sleepTargetHours ?? 8),
    wakeTime: profile.defaultWakeTime || '07:00',
    weekendWakeShift: String(settings.weekendWakeShiftMaxMinutes),
    weekendBedShift: String(settings.weekendBedShiftMaxMinutes),
    windDown: String(settings.windDownMinutes),
    bedtimeTarget: settings.bedtimeTarget || ''
  };
}

function readSleepForm() {
  const root = maybe(CONTAINERS.sleep);
  if (!root || !root.querySelector(`#${SLEEP_IDS.sleepTarget}`)) return null;
  const values = {};
  for (const [key, id] of Object.entries(SLEEP_IDS)) values[key] = valueIn(root, `#${id}`);
  return values;
}

/** Uni ja rytmi -luonnoksen tarkistus. Palauttaa {valid, errors}. */
export function validateSleepDraft(draft) {
  const errors = {};
  const d = draft && typeof draft === 'object' ? draft : {};
  const hours = Number(textOf(d.sleepTarget).replace(',', '.'));
  if (!hasText(d.sleepTarget) || !Number.isFinite(hours)
    || hours < MIN_SLEEP_TARGET_HOURS || hours > MAX_SLEEP_TARGET_HOURS) {
    errors.sleepTarget = `Unitavoite on ${MIN_SLEEP_TARGET_HOURS}–${MAX_SLEEP_TARGET_HOURS} tuntia.`;
  }
  if (!timeOf(d.wakeTime)) errors.wakeTime = 'Anna arkiherätyksen kellonaika.';
  if (intIn(d.weekendWakeShift, 0, MAX_WEEKEND_SHIFT_MINUTES) === null) {
    errors.weekendWakeShift = `Anna minuutit väliltä 0–${MAX_WEEKEND_SHIFT_MINUTES}.`;
  }
  if (intIn(d.weekendBedShift, 0, MAX_WEEKEND_SHIFT_MINUTES) === null) {
    errors.weekendBedShift = `Anna minuutit väliltä 0–${MAX_WEEKEND_SHIFT_MINUTES}.`;
  }
  if (intIn(d.windDown, 0, MAX_WIND_DOWN_MINUTES) === null) {
    errors.windDown = `Anna minuutit väliltä 0–${MAX_WIND_DOWN_MINUTES}.`;
  }
  if (hasText(d.bedtimeTarget) && !timeOf(d.bedtimeTarget)) {
    errors.bedtimeTarget = 'Anna kellonaika muodossa HH:MM tai jätä tyhjäksi.';
  }
  return result(errors);
}

/** Tavallinen rytmi huomiselle tallennetuilla asetuksilla (ilman menoja). */
function rhythmPreview(state, settings, todayIso) {
  const tomorrow = todayIso ? shiftDateIso(todayIso, 1) : null;
  const schedule = tomorrow
    ? sleepScheduleFor({ dateIso: tomorrow, profile: state.profile, settings, offsetMinutesFn: deviceOffsetMinutes })
    : null;
  return schedule ? `<div class="hint">Huomenna tavallisella rytmillä: ${escapeHtml(schedule.reason)}</div>` : '';
}

function sleepHtml(state, settings, todayIso) {
  const values = drafts.sleep || savedSleepValues(state, settings);
  const errors = sectionErrors.sleep;
  return `<div class="add-form" role="group" aria-labelledby="dailySleepTitle" style="display:flex;">
    <div class="form-row">
      ${numberField({ id: SLEEP_IDS.sleepTarget, label: 'Unitavoite (tuntia/yö)', value: values.sleepTarget, min: MIN_SLEEP_TARGET_HOURS, max: MAX_SLEEP_TARGET_HOURS, step: 0.5, error: errors.sleepTarget })}
      ${timeField({ id: SLEEP_IDS.wakeTime, label: 'Arkiherätys', value: values.wakeTime, error: errors.wakeTime })}
    </div>
    <div class="form-row">
      ${numberField({ id: SLEEP_IDS.weekendWakeShift, label: 'Viikonloppuna herätys saa siirtyä enintään (min)', value: values.weekendWakeShift, min: 0, max: MAX_WEEKEND_SHIFT_MINUTES, error: errors.weekendWakeShift })}
      ${numberField({ id: SLEEP_IDS.weekendBedShift, label: 'Viikonloppuna nukkumaanmeno saa siirtyä enintään (min)', value: values.weekendBedShift, min: 0, max: MAX_WEEKEND_SHIFT_MINUTES, error: errors.weekendBedShift })}
    </div>
    <div class="form-row">
      ${numberField({ id: SLEEP_IDS.windDown, label: 'Iltarauhoittuminen ennen nukkumaanmenoa (min)', value: values.windDown, min: 0, max: MAX_WIND_DOWN_MINUTES, error: errors.windDown })}
      ${timeField({ id: SLEEP_IDS.bedtimeTarget, label: 'Nukkumaanmenon tavoite (valinnainen)', value: values.bedtimeTarget, error: errors.bedtimeTarget })}
    </div>
    <div class="hint">Nukkumaanmeno lasketaan herätyksestä ja unitavoitteesta. Uni on suojattua aikaa: mikään laskenta ei lyhennä sitä ilman sinun valintaasi.</div>
    ${rhythmPreview(state, settings, todayIso)}
    ${listError('dsSleepError', errors.general)}
    <div class="form-actions">
      <button class="form-btn primary" id="dsSleepSave" type="button">Tallenna uni ja rytmi</button>
    </div>
  </div>`;
}

function renderSleep(state = getState(), settings = currentLifeSettings(state), todayIso = todayWall().date) {
  render('sleep', sleepHtml(state, settings, todayIso));
}

/** Pidä Asetukset-osion profiililomake samassa arvossa (se tallentaa koko profiilin). */
function syncProfileForm(hours, wake) {
  const target = maybe('pfSleepTarget');
  if (target) target.value = String(hours);
  const wakeInput = maybe('pfDefaultWake');
  if (wakeInput) wakeInput.value = wake;
}

const submitSleep = singleFlight(async () => {
  const state = getState();
  const settings = currentLifeSettings(state);
  const draft = readSleepForm() || drafts.sleep || savedSleepValues(state, settings);
  drafts.sleep = draft;
  const { valid, errors } = validateSleepDraft(draft);
  sectionErrors.sleep = errors;
  if (!valid) {
    renderWithErrors('sleep', () => renderSleep());
    return false;
  }

  const hours = Math.round(Number(textOf(draft.sleepTarget).replace(',', '.')) * 100) / 100;
  const wake = timeOf(draft.wakeTime);
  const lifeChanges = {};
  const wantLife = {
    weekendWakeShiftMaxMinutes: intIn(draft.weekendWakeShift, 0, MAX_WEEKEND_SHIFT_MINUTES),
    weekendBedShiftMaxMinutes: intIn(draft.weekendBedShift, 0, MAX_WEEKEND_SHIFT_MINUTES),
    windDownMinutes: intIn(draft.windDown, 0, MAX_WIND_DOWN_MINUTES),
    bedtimeTarget: timeOf(draft.bedtimeTarget)
  };
  for (const [key, value] of Object.entries(wantLife)) {
    if (value !== settings[key]) lifeChanges[key] = value;
  }
  const profile = state.profile || {};
  const profileChanged = hours !== profile.sleepTargetHours || wake !== profile.defaultWakeTime;

  const button = maybe('dsSleepSave');
  setBusy(button, true, 'Tallennetaan…');
  let ok = true;
  try {
    // Arjen asetukset ensin: jos profiili epäonnistuu, asetukset ovat silti
    // kelvolliset yksinään (kumpikin peruu oman osansa epäonnistuessa).
    if (Object.keys(lifeChanges).length > 0) {
      const saved = await saveLifeSettings(lifeChanges);
      if (!saved.ok) {
        ok = false;
        if (saved.errors) sectionErrors.sleep = { general: Object.values(saved.errors).join(' ') };
      }
    }
    if (ok && profileChanged) {
      ok = await saveProfile({ ...getState().profile, sleepTargetHours: hours, defaultWakeTime: wake });
      if (ok) syncProfileForm(hours, wake);
    }
    if (ok) {
      drafts.sleep = null;
      sectionErrors.sleep = {};
      success('Uni ja rytmi tallennettu.');
    }
  } finally {
    setBusy(button, false);
    renderSleep();
  }
  return ok;
});

// ================================================================ aamurutiini

function savedRoutineRows(settings) {
  return settings.morningRoutine.map(step => ({
    id: step.id, name: step.name, minutes: String(step.minutes), protection: step.protection
  }));
}

function readRoutineRows() {
  const root = maybe(CONTAINERS.routine);
  // Piirtämätön osio (ei lisäyspainiketta) ei ole "tyhjä rutiini".
  if (!root || !root.querySelector('#dsStepAdd')) return null;
  return [...root.querySelectorAll('[data-step-row]')].map(row => ({
    id: row.getAttribute('data-step-id') || null,
    name: valueIn(row, '[data-step-field="name"]'),
    minutes: valueIn(row, '[data-step-field="minutes"]'),
    protection: valueIn(row, '[data-step-field="protection"]')
  }));
}

/** Aamurutiinin luonnoksen tarkistus: nimi, kesto 1–240 min ja suojausluokka. */
export function validateRoutineDraft(rows) {
  const errors = {};
  const list = Array.isArray(rows) ? rows : [];
  if (list.length > MAX_MORNING_STEPS) errors.list = `Aamurutiinissa voi olla enintään ${MAX_MORNING_STEPS} vaihetta.`;
  list.forEach((row, index) => {
    const step = row && typeof row === 'object' ? row : {};
    const name = textOf(step.name);
    if (!name) errors[`${index}.name`] = 'Anna vaiheelle nimi.';
    else if (name.length > MAX_STEP_NAME_LENGTH) errors[`${index}.name`] = `Nimi on enintään ${MAX_STEP_NAME_LENGTH} merkkiä.`;
    if (intIn(step.minutes, 1, MAX_STEP_MINUTES) === null) errors[`${index}.minutes`] = `Kesto on 1–${MAX_STEP_MINUTES} minuuttia.`;
    if (!PROTECTIONS.includes(step.protection)) errors[`${index}.protection`] = 'Valitse, kuinka suojattu vaihe on.';
  });
  return result(errors);
}

/** Tarkistettu luonnos tallennettavaan muotoon (järjestys on käyttäjän oma). */
export function routineFromDraft(rows) {
  return (Array.isArray(rows) ? rows : []).map(row => ({
    ...(row.id ? { id: row.id } : {}),
    name: textOf(row.name),
    minutes: Number(textOf(row.minutes)),
    protection: row.protection
  }));
}

function protectionOptions(selected) {
  return PROTECTIONS.map(value =>
    `<option value="${value}"${value === selected ? ' selected' : ''}>${escapeHtml(protectionLabel(value))}</option>`).join('');
}

function stepRowHtml(row, index, count, errors) {
  const nameError = errors[`${index}.name`];
  const minutesError = errors[`${index}.minutes`];
  const protectionError = errors[`${index}.protection`];
  const shown = textOf(row.name) || `vaihe ${index + 1}`;
  const protectionId = `dsStepProtection-${index}`;
  return `<li class="ds-row" data-step-row data-step-id="${escapeHtml(row.id || '')}">
      <div class="ds-row-title">Vaihe ${index + 1}</div>
      ${textField({ id: `dsStepName-${index}`, label: 'Nimi', value: row.name, max: MAX_STEP_NAME_LENGTH, error: nameError, data: ' data-step-field="name"' })}
      <div class="form-row">
        ${numberField({ id: `dsStepMinutes-${index}`, label: 'Minuutit', value: row.minutes, min: 1, max: MAX_STEP_MINUTES, error: minutesError, data: ' data-step-field="minutes"' })}
        <div>
          <label class="field-label" for="${protectionId}">Suojaus</label>
          <select id="${protectionId}" data-step-field="protection"${invalidAttrs(protectionId, protectionError)}>${protectionOptions(row.protection)}</select>
          ${errorHtml(protectionId, protectionError)}
        </div>
      </div>
      <div class="ds-row-actions">
        <button class="form-btn secondary" type="button" data-step-up="${index}" aria-label="Siirrä ylös: ${escapeHtml(shown)}"${index === 0 ? ' disabled' : ''}>Ylös</button>
        <button class="form-btn secondary" type="button" data-step-down="${index}" aria-label="Siirrä alas: ${escapeHtml(shown)}"${index === count - 1 ? ' disabled' : ''}>Alas</button>
        <button class="form-btn danger" type="button" data-step-remove="${index}" aria-label="Poista vaihe: ${escapeHtml(shown)}">Poista</button>
      </div>
    </li>`;
}

function routineHtml(state, settings) {
  const rows = drafts.routine || savedRoutineRows(settings);
  const errors = sectionErrors.routine;
  const total = rows.reduce((sum, row) => sum + (intIn(row.minutes, 1, MAX_STEP_MINUTES) ?? 0), 0);
  const routineMinutes = Number.isInteger(state.profile && state.profile.routineMinutes) ? state.profile.routineMinutes : 60;
  const list = rows.length > 0
    ? `<ol class="ds-list">${rows.map((row, index) => stepRowHtml(row, index, rows.length, errors)).join('')}</ol>
       <div class="ds-total">Yhteensä ${escapeHtml(durationText(total))}.</div>`
    : `<div class="hint">Ei vaiheita. Silloin aamuun varataan profiilin aamutoimet (${escapeHtml(durationText(routineMinutes))}).</div>`;
  const full = rows.length >= MAX_MORNING_STEPS;
  return `<div class="add-form" role="group" aria-labelledby="dailyRoutineTitle" style="display:flex;">
    <div class="hint">Pakollisia ja suojattuja vaiheita ei koskaan jätetä pois automaattisesti. Kun aamu ei mahdu,
      sovellus ehdottaa ensin valinnaisten ja sitten joustavien vaiheiden karsimista — sinä päätät.</div>
    ${list}
    ${listError('dsRoutineError', errors.list)}
    <div class="form-actions">
      <button class="form-btn secondary" id="dsStepAdd" type="button"${full ? ' disabled' : ''}>+ Lisää vaihe</button>
    </div>
    ${full ? `<div class="hint">Vaiheita voi olla enintään ${MAX_MORNING_STEPS}.</div>` : ''}
    <div class="form-actions">
      <button class="form-btn secondary" id="dsRoutineCancel" type="button">Peruuta muutokset</button>
      <button class="form-btn primary" id="dsRoutineSave" type="button">Tallenna aamurutiini</button>
    </div>
  </div>`;
}

function renderRoutine(state = getState(), settings = currentLifeSettings(state)) {
  render('routine', routineHtml(state, settings));
}

/** Nykyiset rivit (kirjoitetut arvot mukaan) ennen rakenteen muutosta. */
function routineRowsNow() {
  return readRoutineRows() || drafts.routine || savedRoutineRows(currentLifeSettings(getState()));
}

/** Fokus ensimmäiseen käytettävissä olevaan ohjaimeen osion sisällä. */
function focusFirst(section, selectors) {
  const root = maybe(CONTAINERS[section]);
  if (!root || typeof root.querySelector !== 'function') return null;
  for (const selector of selectors) {
    const node = root.querySelector(selector);
    if (node && !node.disabled && typeof node.focus === 'function') {
      node.focus();
      return node;
    }
  }
  return null;
}

function changeRoutine(mutate, focusAfter) {
  const rows = routineRowsNow().map(row => ({ ...row }));
  const next = mutate(rows);
  drafts.routine = next;
  // Rivien paikat muuttuivat: vanhat virheet osoittaisivat väärään riviin.
  sectionErrors.routine = {};
  renderRoutine();
  if (focusAfter) focusFirst('routine', focusAfter(next));
}

/**
 * Uusi vaihe ilman tunnistetta: tunniste syntyy tallennuksessa
 * (lifeSettings.normalizeMorningRoutine). Näkymä ei tuota tunnisteita.
 */
function addStep() {
  changeRoutine(rows => {
    if (rows.length >= MAX_MORNING_STEPS) return rows;
    return [...rows, { id: null, name: '', minutes: '10', protection: PROTECTION.IMPORTANT_FLEXIBLE }];
  }, rows => [`#dsStepName-${rows.length - 1}`]);
}

function moveStep(index, delta) {
  changeRoutine(rows => {
    const target = index + delta;
    if (index < 0 || index >= rows.length || target < 0 || target >= rows.length) return rows;
    const copy = [...rows];
    [copy[index], copy[target]] = [copy[target], copy[index]];
    return copy;
  }, () => {
    const target = index + delta;
    const same = delta < 0 ? 'up' : 'down';
    const other = delta < 0 ? 'down' : 'up';
    return [`[data-step-${same}="${target}"]`, `[data-step-${other}="${target}"]`];
  });
}

function removeStep(index) {
  changeRoutine(rows => rows.filter((_, i) => i !== index),
    rows => (rows.length === 0 ? ['#dsStepAdd'] : [`#dsStepName-${Math.min(index, rows.length - 1)}`]));
}

function cancelRoutine() {
  drafts.routine = null;
  sectionErrors.routine = {};
  renderRoutine();
}

const submitRoutine = singleFlight(async () => {
  const rows = routineRowsNow();
  drafts.routine = rows;
  const { valid, errors } = validateRoutineDraft(rows);
  sectionErrors.routine = errors;
  if (!valid) {
    renderWithErrors('routine', () => renderRoutine());
    return false;
  }
  const button = maybe('dsRoutineSave');
  setBusy(button, true, 'Tallennetaan…');
  let ok = false;
  try {
    const saved = await saveLifeSettings({ morningRoutine: routineFromDraft(rows) });
    ok = saved.ok === true;
    if (ok) {
      drafts.routine = null;
      sectionErrors.routine = {};
      success('Aamurutiini tallennettu.');
    } else if (saved.errors) {
      sectionErrors.routine = { list: Object.values(saved.errors).join(' ') };
    }
  } finally {
    setBusy(button, false);
    renderRoutine();
  }
  return ok;
});

// ================================================================ herätys

/**
 * Voimistumisen valmiit tasot. `steps` ilman puhetta, `speech` kun
 * herätyksen tapa sisältää puheen. Puhevaiheet poistamalla `speech` on aina
 * sama kuin `steps`, joten tallennetun tason tunnistaa kummastakin.
 * Kaikki vaiheet alkavat ennen soiton enimmäispituutta (10 min), ja vaiheita
 * on enintään neljä (alarmPlan.validateEscalation).
 */
const stage = (afterSeconds, action) => Object.freeze({ afterSeconds, step: action });
const { SOFT, LOUD, SPEECH, REPEAT_SPEECH } = ESCALATION_STEP;

export const ESCALATION_PRESETS = Object.freeze([
  Object.freeze({
    key: 'gentle', label: 'Lempeä', hint: 'Hiljainen alku, joka voimistuu kolmessa minuutissa.',
    steps: Object.freeze([stage(0, SOFT), stage(180, LOUD)]),
    speech: Object.freeze([stage(0, SOFT), stage(60, SPEECH), stage(180, LOUD)])
  }),
  Object.freeze({
    key: 'normal', label: 'Tavallinen', hint: 'Pehmeä alku, minuutin päästä kovempi.',
    steps: Object.freeze([stage(0, SOFT), stage(60, LOUD)]),
    speech: Object.freeze([stage(0, SOFT), stage(30, SPEECH), stage(60, LOUD)])
  }),
  Object.freeze({
    key: 'strong', label: 'Voimakas', hint: 'Kova ääni heti alusta.',
    steps: Object.freeze([stage(0, LOUD)]),
    speech: Object.freeze([stage(0, LOUD), stage(20, SPEECH), stage(60, REPEAT_SPEECH)])
  })
]);

const CUSTOM_PRESET = 'custom';
const SPEECH_STEPS = new Set([SPEECH, REPEAT_SPEECH]);

const modeSpeaks = mode => mode === ALARM_MODE.SPEECH || mode === ALARM_MODE.COMBINATION;

/** Tason vaiheet herätyksen tavalle (uusi taulukko; kutsuja saa muokata). */
export function escalationFor(presetKey, mode) {
  const preset = ESCALATION_PRESETS.find(item => item.key === presetKey) || ESCALATION_PRESETS[1];
  return (modeSpeaks(mode) ? preset.speech : preset.steps).map(step => ({ ...step }));
}

/** Tallennetun voimistuksen taso tai null (mukautettu). */
export function presetOf(escalation) {
  if (!Array.isArray(escalation)) return null;
  const plain = escalation.filter(step => step && !SPEECH_STEPS.has(step.step));
  const same = (a, b) => a.length === b.length
    && a.every((step, index) => step.afterSeconds === b[index].afterSeconds && step.step === b[index].step);
  const match = ESCALATION_PRESETS.find(preset => same(plain, preset.steps));
  return match ? match.key : null;
}

const ALARM_IDS = Object.freeze({
  mode: 'dsAlarmMode',
  preset: 'dsAlarmEscalation',
  snooze: 'dsAlarmSnooze',
  maxSnoozes: 'dsAlarmMaxSnoozes',
  weekdayTime: 'dsAlarmWeekday',
  weekendTime: 'dsAlarmWeekend'
});

function savedAlarmValues(settings) {
  const alarm = settings.alarm;
  return {
    enabled: alarm.enabled === true,
    mode: alarm.mode,
    preset: presetOf(alarm.escalation) || CUSTOM_PRESET,
    snooze: String(alarm.snoozeMinutes),
    maxSnoozes: String(alarm.maxSnoozes),
    timing: alarm.followPlan === false ? 'fixed' : 'plan',
    weekdayTime: alarm.weekdayTime || '',
    weekendTime: alarm.weekendTime || ''
  };
}

function readAlarmForm() {
  const root = maybe(CONTAINERS.alarm);
  if (!root || !root.querySelector('#dsAlarmEnabled')) return null;
  const values = { enabled: checkedIn(root, '#dsAlarmEnabled') };
  for (const [key, id] of Object.entries(ALARM_IDS)) values[key] = valueIn(root, `#${id}`);
  values.timing = checkedIn(root, '#dsAlarmTimingFixed') ? 'fixed' : 'plan';
  return values;
}

/** Herätysluonnoksen tarkistus. Palauttaa {valid, errors}. */
export function validateAlarmDraft(draft) {
  const errors = {};
  const d = draft && typeof draft === 'object' ? draft : {};
  if (!ALARM_MODES.includes(d.mode)) errors.mode = 'Valitse herätyksen tapa.';
  if (d.preset !== CUSTOM_PRESET && !ESCALATION_PRESETS.some(preset => preset.key === d.preset)) {
    errors.preset = 'Valitse, miten herätys voimistuu.';
  }
  if (intIn(d.snooze, 1, MAX_SNOOZE_MINUTES) === null) errors.snooze = `Torkku on 1–${MAX_SNOOZE_MINUTES} minuuttia.`;
  if (intIn(d.maxSnoozes, 0, MAX_SNOOZES) === null) errors.maxSnoozes = `Torkkuja voi olla 0–${MAX_SNOOZES}.`;
  if (d.timing === 'fixed') {
    if (hasText(d.weekdayTime) && !timeOf(d.weekdayTime)) errors.weekdayTime = 'Anna kellonaika muodossa HH:MM.';
    if (hasText(d.weekendTime) && !timeOf(d.weekendTime)) errors.weekendTime = 'Anna kellonaika muodossa HH:MM.';
    if (!hasText(d.weekdayTime) && !hasText(d.weekendTime)) {
      errors.times = 'Anna arki- tai viikonloppuherätyksen aika, tai anna päivän suunnitelman määrätä herätys.';
    }
  }
  return result(errors);
}

/** Tarkistettu luonnos tallennettavaksi herätykseksi. */
export function alarmFromDraft(draft, current) {
  const fixed = draft.timing === 'fixed';
  const escalation = draft.preset === CUSTOM_PRESET && current && Array.isArray(current.escalation)
    ? current.escalation.map(step => ({ ...step }))
    : escalationFor(draft.preset, draft.mode);
  return {
    enabled: draft.enabled === true,
    mode: draft.mode,
    escalation,
    snoozeMinutes: intIn(draft.snooze, 1, MAX_SNOOZE_MINUTES),
    maxSnoozes: intIn(draft.maxSnoozes, 0, MAX_SNOOZES),
    followPlan: !fixed,
    // "Seuraa suunnitelmaa" = rytmin mukaan; oma kellonaika ohittaisi sen.
    weekdayTime: fixed ? timeOf(draft.weekdayTime) : null,
    weekendTime: fixed ? timeOf(draft.weekendTime) : null
  };
}

function alarmHtml(state, settings) {
  const values = drafts.alarm || savedAlarmValues(settings);
  const errors = sectionErrors.alarm;
  const modeOptions = ALARM_MODES.map(mode =>
    `<option value="${mode}"${mode === values.mode ? ' selected' : ''}>${escapeHtml(alarmModeLabel(mode))}</option>`).join('');
  const custom = values.preset === CUSTOM_PRESET;
  const presetOptions = ESCALATION_PRESETS.map(preset =>
    `<option value="${preset.key}"${preset.key === values.preset ? ' selected' : ''}>${escapeHtml(preset.label)}</option>`).join('')
    + (custom ? `<option value="${CUSTOM_PRESET}" selected>Nykyinen (mukautettu)</option>` : '');
  const preset = ESCALATION_PRESETS.find(item => item.key === values.preset);
  const presetHint = preset
    ? preset.hint + (modeSpeaks(values.mode) ? ' Puhe kuuluu voimistuksen välissä.' : '')
    : 'Voimistus on asetettu muualla. Valitse taso, jos haluat vaihtaa sen.';
  const fixed = values.timing === 'fixed';
  const wake = (state.profile && state.profile.defaultWakeTime) || '07:00';
  return `<div class="add-form" role="group" aria-labelledby="dailyAlarmTitle" style="display:flex;">
    <label class="checkbox-row" for="dsAlarmEnabled">
      <input type="checkbox" id="dsAlarmEnabled"${values.enabled ? ' checked' : ''}>
      Herätys käytössä
    </label>
    <div class="form-row">
      <div>
        <label class="field-label" for="${ALARM_IDS.mode}">Herätyksen tapa</label>
        <select id="${ALARM_IDS.mode}"${invalidAttrs(ALARM_IDS.mode, errors.mode)}>${modeOptions}</select>
        ${errorHtml(ALARM_IDS.mode, errors.mode)}
      </div>
      <div>
        <label class="field-label" for="${ALARM_IDS.preset}">Voimistuminen</label>
        <select id="${ALARM_IDS.preset}" aria-describedby="dsAlarmEscalationHint"${errors.preset ? ' aria-invalid="true"' : ''}>${presetOptions}</select>
        ${errorHtml(ALARM_IDS.preset, errors.preset)}
      </div>
    </div>
    <div class="hint" id="dsAlarmEscalationHint">${escapeHtml(presetHint)} Herätys soi enintään 10 minuuttia.</div>
    <div class="form-row">
      ${numberField({ id: ALARM_IDS.snooze, label: 'Torkun pituus (min)', value: values.snooze, min: 1, max: MAX_SNOOZE_MINUTES, error: errors.snooze })}
      ${numberField({ id: ALARM_IDS.maxSnoozes, label: 'Torkkuja enintään', value: values.maxSnoozes, min: 0, max: MAX_SNOOZES, error: errors.maxSnoozes })}
    </div>
    <fieldset class="ds-fieldset">
      <legend class="field-label">Herätysaika</legend>
      <label class="checkbox-row" for="dsAlarmTimingPlan">
        <input type="radio" name="dsAlarmTiming" id="dsAlarmTimingPlan" value="plan"${fixed ? '' : ' checked'}>
        Seuraa suunnitelmaa
      </label>
      <div class="hint">Arkena ${escapeHtml(clockText(wake))} unirytmin mukaan. Aamun meno voi aikaistaa herätystä, mutta ei suojatun unen kustannuksella.</div>
      <label class="checkbox-row" for="dsAlarmTimingFixed">
        <input type="radio" name="dsAlarmTiming" id="dsAlarmTimingFixed" value="fixed"${fixed ? ' checked' : ''}>
        Kiinteä aika
      </label>
    </fieldset>
    ${fixed ? `<div class="form-row">
      ${timeField({ id: ALARM_IDS.weekdayTime, label: 'Arkiaamuisin', value: values.weekdayTime, error: errors.weekdayTime })}
      ${timeField({ id: ALARM_IDS.weekendTime, label: 'Viikonloppuna', value: values.weekendTime, error: errors.weekendTime })}
    </div>
    <div class="hint">Tyhjä kenttä = unirytmin mukainen herätys sinä päivänä.</div>` : ''}
    ${listError('dsAlarmTimesError', errors.times)}
    ${listError('dsAlarmError', errors.general)}
    <div class="form-actions">
      <button class="form-btn primary" id="dsAlarmSave" type="button">Tallenna herätys</button>
    </div>
  </div>`;
}

function renderAlarm(state = getState(), settings = currentLifeSettings(state)) {
  render('alarm', alarmHtml(state, settings));
}

const submitAlarm = singleFlight(async () => {
  const settings = currentLifeSettings(getState());
  const draft = readAlarmForm() || drafts.alarm || savedAlarmValues(settings);
  drafts.alarm = draft;
  const { valid, errors } = validateAlarmDraft(draft);
  sectionErrors.alarm = errors;
  if (!valid) {
    renderWithErrors('alarm', () => renderAlarm());
    return false;
  }
  const button = maybe('dsAlarmSave');
  setBusy(button, true, 'Tallennetaan…');
  let ok = false;
  try {
    const saved = await saveLifeSettings({ alarm: alarmFromDraft(draft, settings.alarm) });
    ok = saved.ok === true;
    if (ok) {
      drafts.alarm = null;
      sectionErrors.alarm = {};
      success(draft.enabled ? 'Herätys tallennettu.' : 'Herätys tallennettu pois päältä.');
    } else if (saved.errors) {
      sectionErrors.alarm = { general: Object.values(saved.errors).join(' ') };
    }
  } finally {
    setBusy(button, false);
    renderAlarm();
    renderAlarmNext();
  }
  return ok;
});

// ------------------------------------------------------------ seuraava herätys

function todayWall(nowMs = Date.now()) {
  return epochToWallClock(nowMs, deviceOffsetMinutes) || { date: null, time: null };
}

/**
 * Aamun sitoumukset herätyssuunnitelmalle: kalenterin ajalliset menot ja
 * niiden lähtö- ja valmistautumisajat samalta päivältä. Matka-ajaton meno
 * sitoo aamua alkamisajallaan (alarmPlan vähentää profiilin työmatkan).
 */
function commitmentsByDate(state, fromIso, days, settings) {
  const to = shiftDateIso(fromIso, days - 1);
  if (!to) return {};
  const events = new Map((state.calendarEvents || []).map(event => [event.id, event]));
  const places = new Map((state.savedPlaces || []).map(place => [place.id, place]));
  const byDate = {};
  for (const occurrence of expandEventOccurrences({ events: state.calendarEvents || [], from: fromIso, to })) {
    if (occurrence.allDay || !occurrence.time) continue;
    const event = events.get(occurrence.eventId) || null;
    const place = event && event.placeId ? places.get(event.placeId) || null : null;
    const plan = planDeparture({ occurrence, event, place, settings, offsetMinutesFn: deviceOffsetMinutes });
    const sameDay = point => (plan && plan.known && point && point.date === occurrence.date ? point.time : null);
    if (!byDate[occurrence.date]) byDate[occurrence.date] = [];
    byDate[occurrence.date].push({
      id: occurrence.id,
      title: occurrence.title,
      startTime: occurrence.time,
      leaveTime: sameDay(plan && plan.leave),
      prepareStart: sameDay(plan && plan.prepareStart),
      category: occurrence.category
    });
  }
  return byDate;
}

/**
 * Seuraava herätys, joka on vielä edessä: tästä päivästä kaksi päivää
 * eteenpäin. null, kun herätys ei ole käytössä tai sitä ei synny.
 */
export function nextAlarmFor(state = getState(), nowMs = Date.now()) {
  const settings = currentLifeSettings(state);
  if (!settings.alarm.enabled) return null;
  const now = todayWall(nowMs);
  if (!now.date) return null;
  const alarms = desiredAlarms({
    fromIso: now.date,
    days: 2,
    profile: state.profile,
    settings,
    commitmentsByDate: commitmentsByDate(state, now.date, 2, settings),
    sleepLogs: state.sleepLogs || [],
    offsetMinutesFn: deviceOffsetMinutes
  });
  let best = null;
  for (const alarm of alarms) {
    const at = alarmEpoch(alarm, deviceOffsetMinutes);
    if (!at || at.epochMs <= nowMs) continue;
    if (!best || at.epochMs < best.epochMs) best = { alarm, epochMs: at.epochMs };
  }
  return best ? best.alarm : null;
}

function alarmNextHtml(state, settings) {
  if (!settings.alarm.enabled) {
    return '<p class="hint">Herätys ei ole käytössä. Voit ottaa sen käyttöön alta.</p>';
  }
  const next = nextAlarmFor(state);
  if (!next) return '<p class="hint">Seuraavalle kahdelle päivälle ei ole herätystä.</p>';
  return `<div class="preview-block">
    <div class="preview-title">Seuraava herätys</div>
    <div class="preview-row"><span>${escapeHtml(shortDateLabel(next.date))}</span>
      <strong>klo ${escapeHtml(clockText(next.time))}</strong></div>
    <div class="hint">${escapeHtml(next.reason || '')}</div>
  </div>`;
}

function renderAlarmNext(state = getState(), settings = currentLifeSettings(state)) {
  render('alarmNext', alarmNextHtml(state, settings));
}

// ------------------------------------------------------------ Android-tila

function alarmsFacade() {
  const source = platformOverride ? platformOverride.alarms : platform.alarms;
  return source && typeof source === 'object' ? source : null;
}

function nativeShell() {
  if (platformOverride) return platformOverride.native === true;
  try {
    return typeof platform.isNativeShell === 'function' && platform.isNativeShell() === true;
  } catch {
    return false;
  }
}

/**
 * Alustan herätystilan luku. Liitännäisen vastauksen muoto voi vaihdella
 * versioittain, joten tunnetut nimet luetaan varovasti: tuntematon on null
 * ("ei tiedossa"), ei koskaan "kyllä".
 */
export function readAlarmStatus(raw) {
  const outer = raw && typeof raw === 'object' ? raw : {};
  const source = outer.value && typeof outer.value === 'object' ? outer.value : outer;
  const flag = (...keys) => {
    for (const key of keys) if (typeof source[key] === 'boolean') return source[key];
    return null;
  };
  const text = (...keys) => {
    for (const key of keys) {
      if (typeof source[key] === 'string' && source[key].trim()) return source[key].trim().slice(0, 80);
    }
    return null;
  };
  return Object.freeze({
    supported: flag('supported', 'available'),
    exact: flag('exactAllowed', 'canScheduleExactAlarms', 'exactAlarmsAllowed', 'exact'),
    fullScreen: flag('fullScreenAllowed', 'canUseFullScreenIntent', 'fullScreenIntentAllowed', 'fullScreen'),
    soundName: text('soundName', 'alarmSoundName', 'soundTitle'),
    reason: text('reason')
  });
}

async function refreshAlarmStatus() {
  const facade = alarmsFacade();
  if (!nativeShell() || !facade || typeof facade.status !== 'function') {
    alarmStatus = { state: 'unavailable', value: null, checkedAt: Date.now() };
    renderAlarmStatus();
    return;
  }
  if (statusInFlight) return;
  statusInFlight = true;
  try {
    const raw = await facade.status();
    alarmStatus = { state: 'ready', value: readAlarmStatus(raw), checkedAt: Date.now() };
  } catch {
    alarmStatus = { state: 'unknown', value: null, checkedAt: Date.now() };
  } finally {
    statusInFlight = false;
  }
  renderAlarmStatus();
}

function maybeRefreshAlarmStatus() {
  if (statusInFlight) return;
  if (alarmStatus.state !== 'idle' && Date.now() - alarmStatus.checkedAt < STATUS_MAX_AGE_MS) return;
  refreshAlarmStatus().catch(() => { /* tila on apu, ei kriittinen */ });
}

const yesNo = value => (value === true ? 'kyllä' : value === false ? 'ei' : 'ei tiedossa');

function statusRow(label, value) {
  return `<div class="ds-status-row"><span>${escapeHtml(label)}:</span> <strong>${escapeHtml(value)}</strong></div>`;
}

function alarmStatusHtml() {
  if (!nativeShell()) {
    return `<div class="notice tone-gold" id="dsAlarmWebNotice"><strong>Herätys toimii vain Android-sovelluksessa.</strong>
      Selaimessa herätys ei soi, kun sovellus on kiinni tai puhelin lukittu. Asetukset tallentuvat silti.</div>`;
  }
  const facade = alarmsFacade();
  if (!facade || typeof facade.status !== 'function') {
    return '<div class="notice tone-gold">Herätyksen tilaa ei saatu selville tästä sovellusversiosta. '
      + 'Päivitä sovellus, jotta herätys voi soida.</div>';
  }
  if (alarmStatus.state === 'idle') return '<div class="hint" role="status">Tarkistetaan herätyksen tilaa…</div>';
  const refresh = '<button class="form-btn secondary" id="dsAlarmStatusRefresh" type="button">Tarkista tila</button>';
  if (alarmStatus.state !== 'ready' || !alarmStatus.value) {
    return `<div class="notice tone-gold">Herätyksen tilaa ei saatu luettua.</div>
      <div class="form-actions">${refresh}</div>`;
  }
  const status = alarmStatus.value;
  if (status.supported === false) {
    return `<div class="notice tone-gold">${escapeHtml(status.reason || 'Herätys ei ole käytettävissä tässä sovellusversiossa.')}</div>
      <div class="form-actions">${refresh}</div>`;
  }
  const buttons = [];
  if (status.exact !== true && typeof facade.openExactAlarmSettings === 'function') {
    buttons.push('<button class="form-btn secondary" id="dsAlarmExactBtn" type="button">Salli täsmälliset herätykset</button>');
  }
  if (status.fullScreen !== true && typeof facade.openFullScreenSettings === 'function') {
    buttons.push('<button class="form-btn secondary" id="dsAlarmFullScreenBtn" type="button">Salli koko näytön herätys</button>');
  }
  if (typeof facade.pickAlarmSound === 'function') {
    buttons.push('<button class="form-btn secondary" id="dsAlarmSoundBtn" type="button">Valitse herätysääni</button>');
  }
  buttons.push(refresh);
  const warning = status.exact === false
    ? '<div class="hint">Ilman täsmällisiä herätyksiä puhelin voi myöhästyttää herätystä. Salli ne, jotta herätys soi ajallaan.</div>'
    : '';
  return `<div class="add-form" role="group" aria-label="Herätyksen tila puhelimessa" style="display:flex;">
    ${statusRow('Täsmälliset herätykset sallittu', yesNo(status.exact))}
    ${statusRow('Koko näytön herätys lukitulla näytöllä', yesNo(status.fullScreen))}
    ${statusRow('Herätysääni', status.soundName || 'puhelimen oletusääni')}
    ${warning}
    <div class="form-actions">${buttons.join('')}</div>
  </div>`;
}

function renderAlarmStatus() {
  render('status', alarmStatusHtml());
}

/** Järjestelmäasetuksen avaus tai äänen valinta: VAIN napautuksesta. */
const runAlarmAction = singleFlight(async (method, button) => {
  const facade = alarmsFacade();
  if (!facade || typeof facade[method] !== 'function') return;
  setBusy(button, true);
  try {
    await facade[method]();
  } catch {
    /* liitännäinen ratkaisee aina; varmuuden vuoksi näkymä ei kaadu */
  } finally {
    setBusy(button, false);
  }
  await refreshAlarmStatus();
});

// ================================================================ aamukatsaus

function briefHtml(settings) {
  return `<div class="add-form" role="group" aria-labelledby="dailyBriefTitle" style="display:flex;">
    <label class="checkbox-row" for="dsMorningBrief">
      <input type="checkbox" id="dsMorningBrief"${settings.morningBriefEnabled ? ' checked' : ''}>
      Aamukatsaus puheena
    </label>
    <div class="hint">Kun sammutat herätyksen, kuulet lyhyen katsauksen: kellonaika, lähtöaika ja päivän ensimmäinen meno.
      Katsaus kootaan puhelimessa ilman tekoälyä. Toimii Android-sovelluksessa.</div>
  </div>`;
}

function renderBrief(settings = currentLifeSettings(getState())) {
  render('brief', briefHtml(settings));
}

const toggleBrief = singleFlight(async input => {
  const wanted = Boolean(input.checked);
  input.disabled = true;
  let ok = false;
  try {
    const saved = await saveLifeSettings({ morningBriefEnabled: wanted });
    ok = saved.ok === true;
    if (ok) success(wanted ? 'Aamukatsaus otettu käyttöön.' : 'Aamukatsaus poistettu käytöstä.');
  } finally {
    // Epäonnistunut tallennus perui tilan: ruutu palaa tallennettuun arvoon.
    const current = maybe('dsMorningBrief');
    if (current) {
      current.disabled = false;
      current.checked = currentLifeSettings(getState()).morningBriefEnabled === true;
    }
    renderBrief();
  }
  return ok;
});

// ================================================================ ateriat

/** Listan tai koko osion virheilmoitus (oma tunniste). */
const MEAL_LIST_ERROR_IDS = Object.freeze({
  meals: 'dsMealListError',
  supplements: 'dsSupListError',
  general: 'dsMealError'
});

/** Yksittäisen kentän tunniste; virheilmoitus on `<tunniste>Error`. */
const MEAL_FIELD_IDS = Object.freeze({
  waterEveryMinutes: 'dsWaterEvery',
  waterFrom: 'dsWaterFrom',
  waterTo: 'dsWaterTo',
  lateEatingCutoff: 'dsLateCutoff'
});

function mealRowErrorId(key) {
  const [list, index, field] = key.split('.');
  if (list === 'meals') return `dsMeal${field === 'name' ? 'Name' : field === 'time' ? 'Time' : 'Prep'}-${index}Error`;
  if (list === 'supplements') return `dsSup${field === 'name' ? 'Name' : 'Time'}-${index}Error`;
  return null;
}

function savedMealValues(settings) {
  const rhythm = settings.mealRhythm;
  return {
    meals: rhythm.meals.map(meal => ({
      id: meal.id, name: meal.name, time: meal.time, prep: meal.prepMinutes === null ? '' : String(meal.prepMinutes)
    })),
    waterEvery: rhythm.waterEveryMinutes === null ? '' : String(rhythm.waterEveryMinutes),
    waterFrom: rhythm.waterFrom || '',
    waterTo: rhythm.waterTo || '',
    supplements: rhythm.supplements.map(item => ({ id: item.id, name: item.name, time: item.time || '' })),
    lateCutoff: rhythm.lateEatingCutoff || ''
  };
}

function readMealForm() {
  const root = maybe(CONTAINERS.meals);
  if (!root || !root.querySelector('#dsWaterEvery')) return null;
  return {
    meals: [...root.querySelectorAll('[data-meal-row]')].map(row => ({
      id: row.getAttribute('data-meal-id') || null,
      name: valueIn(row, '[data-meal-field="name"]'),
      time: valueIn(row, '[data-meal-field="time"]'),
      prep: valueIn(row, '[data-meal-field="prep"]')
    })),
    waterEvery: valueIn(root, '#dsWaterEvery'),
    waterFrom: valueIn(root, '#dsWaterFrom'),
    waterTo: valueIn(root, '#dsWaterTo'),
    supplements: [...root.querySelectorAll('[data-sup-row]')].map(row => ({
      id: row.getAttribute('data-sup-id') || null,
      name: valueIn(row, '[data-sup-field="name"]'),
      time: valueIn(row, '[data-sup-field="time"]')
    })),
    lateCutoff: valueIn(root, '#dsLateCutoff')
  };
}

const blankToNull = value => (hasText(value) ? textOf(value) : null);
const numberOrNull = value => (hasText(value) ? Number(textOf(value)) : null);

/** Luonnos ateriarytmiksi (tallennusmuoto). */
export function mealRhythmFromDraft(draft) {
  const d = draft && typeof draft === 'object' ? draft : {};
  return {
    meals: (d.meals || []).map(meal => ({
      ...(meal.id ? { id: meal.id } : {}),
      name: textOf(meal.name), time: textOf(meal.time), prepMinutes: numberOrNull(meal.prep)
    })),
    waterEveryMinutes: numberOrNull(d.waterEvery),
    waterFrom: blankToNull(d.waterFrom),
    waterTo: blankToNull(d.waterTo),
    supplements: (d.supplements || []).map(item => ({
      ...(item.id ? { id: item.id } : {}), name: textOf(item.name), time: textOf(item.time)
    })),
    lateEatingCutoff: blankToNull(d.lateCutoff)
  };
}

/** Ateriarytmin luonnoksen tarkistus (mealRhythm.validateMealRhythm + näkymän rajat). */
export function validateMealDraft(draft) {
  const d = draft && typeof draft === 'object' ? draft : {};
  const errors = { ...validateMealRhythm(mealRhythmFromDraft(d)).errors };
  (d.meals || []).forEach((meal, index) => {
    if (hasText(meal.prep) && !INTEGER.test(textOf(meal.prep))) {
      errors[`meals.${index}.prepMinutes`] = `Valmistelun kesto on 0–${MAX_MEAL_PREP_MINUTES} minuuttia.`;
    }
  });
  const anyWater = hasText(d.waterEvery) || hasText(d.waterFrom) || hasText(d.waterTo);
  if (anyWater && !hasText(d.waterEvery)) {
    errors.waterEveryMinutes = 'Anna muistutusten väli minuutteina.';
  } else if (hasText(d.waterEvery) && intIn(d.waterEvery, MEAL_RULES.WATER_MIN_INTERVAL_MINUTES, MAX_WATER_INTERVAL_MINUTES) === null) {
    errors.waterEveryMinutes = `Väli on ${MEAL_RULES.WATER_MIN_INTERVAL_MINUTES}–${MAX_WATER_INTERVAL_MINUTES} minuuttia.`;
  }
  return result(errors);
}

function mealRowHtml(meal, index, errors) {
  const shown = textOf(meal.name) || `ateria ${index + 1}`;
  return `<li class="ds-row" data-meal-row data-meal-id="${escapeHtml(meal.id || '')}">
      ${textField({ id: `dsMealName-${index}`, label: 'Ateria', value: meal.name, max: MAX_STEP_NAME_LENGTH, error: errors[`meals.${index}.name`], data: ' data-meal-field="name"' })}
      <div class="form-row">
        ${timeField({ id: `dsMealTime-${index}`, label: 'Aika', value: meal.time, error: errors[`meals.${index}.time`], data: ' data-meal-field="time"' })}
        ${numberField({ id: `dsMealPrep-${index}`, label: 'Valmistelu (min)', value: meal.prep, min: 0, max: MAX_MEAL_PREP_MINUTES, error: errors[`meals.${index}.prepMinutes`], data: ' data-meal-field="prep"' })}
      </div>
      <div class="ds-row-actions">
        <button class="form-btn danger" type="button" data-meal-remove="${index}" aria-label="Poista ateria: ${escapeHtml(shown)}">Poista</button>
      </div>
    </li>`;
}

function supplementRowHtml(item, index, errors) {
  const shown = textOf(item.name) || `muistutus ${index + 1}`;
  return `<li class="ds-row" data-sup-row data-sup-id="${escapeHtml(item.id || '')}">
      <div class="form-row">
        ${textField({ id: `dsSupName-${index}`, label: 'Lisäravinne', value: item.name, max: MAX_STEP_NAME_LENGTH, error: errors[`supplements.${index}.name`], data: ' data-sup-field="name"' })}
        ${timeField({ id: `dsSupTime-${index}`, label: 'Aika', value: item.time, error: errors[`supplements.${index}.time`], data: ' data-sup-field="time"' })}
      </div>
      <div class="ds-row-actions">
        <button class="form-btn danger" type="button" data-sup-remove="${index}" aria-label="Poista lisäravinne: ${escapeHtml(shown)}">Poista</button>
      </div>
    </li>`;
}

function mealHtml(settings) {
  const values = drafts.meals || savedMealValues(settings);
  const errors = sectionErrors.meals;
  const mealsFull = values.meals.length >= MAX_MEALS;
  const supFull = values.supplements.length >= MAX_SUPPLEMENTS;
  return `<div class="add-form" role="group" aria-labelledby="dailyMealTitle" style="display:flex;">
    <div class="hint">Oma rytmisi muistutuksiksi. Sovellus ei arvioi syömistä eikä ehdota ruokavaliota.</div>
    <div class="add-form-title">Ateriat</div>
    ${values.meals.length > 0
    ? `<ol class="ds-list">${values.meals.map((meal, index) => mealRowHtml(meal, index, errors)).join('')}</ol>`
    : '<div class="hint">Ei aterioita.</div>'}
    ${listError(MEAL_LIST_ERROR_IDS.meals, errors.meals)}
    <div class="form-actions">
      <button class="form-btn secondary" id="dsMealAdd" type="button"${mealsFull ? ' disabled' : ''}>+ Lisää ateria</button>
    </div>
    <div class="add-form-title">Veden juonti</div>
    <div class="form-row">
      ${numberField({ id: 'dsWaterEvery', label: 'Muistuta välein (min)', value: values.waterEvery, min: MEAL_RULES.WATER_MIN_INTERVAL_MINUTES, max: MAX_WATER_INTERVAL_MINUTES, error: errors.waterEveryMinutes })}
      ${timeField({ id: 'dsWaterFrom', label: 'Alkaen', value: values.waterFrom, error: errors.waterFrom })}
      ${timeField({ id: 'dsWaterTo', label: 'Asti', value: values.waterTo, error: errors.waterTo })}
    </div>
    <div class="hint">Jätä väli tyhjäksi, jos et halua vesimuistutuksia.</div>
    <div class="add-form-title">Lisäravinteet</div>
    ${values.supplements.length > 0
    ? `<ol class="ds-list">${values.supplements.map((item, index) => supplementRowHtml(item, index, errors)).join('')}</ol>`
    : '<div class="hint">Ei lisäravinnemuistutuksia.</div>'}
    ${listError(MEAL_LIST_ERROR_IDS.supplements, errors.supplements)}
    <div class="form-actions">
      <button class="form-btn secondary" id="dsSupAdd" type="button"${supFull ? ' disabled' : ''}>+ Lisää lisäravinne</button>
    </div>
    <div class="add-form-title">Myöhäinen syöminen</div>
    ${timeField({ id: 'dsLateCutoff', label: 'Ei syömistä tämän jälkeen (valinnainen)', value: values.lateCutoff, error: errors.lateEatingCutoff })}
    ${listError(MEAL_LIST_ERROR_IDS.general, errors.general)}
    <div class="form-actions">
      <button class="form-btn secondary" id="dsMealCancel" type="button">Peruuta muutokset</button>
      <button class="form-btn primary" id="dsMealSave" type="button">Tallenna ateriat</button>
    </div>
  </div>`;
}

function renderMeals(settings = currentLifeSettings(getState())) {
  render('meals', mealHtml(settings));
}

function mealValuesNow() {
  const current = readMealForm() || drafts.meals || savedMealValues(currentLifeSettings(getState()));
  return {
    ...current,
    meals: current.meals.map(meal => ({ ...meal })),
    supplements: current.supplements.map(item => ({ ...item }))
  };
}

function changeMeals(mutate, focusSelector) {
  const next = mutate(mealValuesNow());
  drafts.meals = next;
  sectionErrors.meals = {};
  renderMeals();
  if (focusSelector) focusFirst('meals', [focusSelector(next)]);
}

function addMeal() {
  changeMeals(values => (values.meals.length >= MAX_MEALS ? values
    : { ...values, meals: [...values.meals, { id: null, name: '', time: '', prep: '' }] }),
  values => `#dsMealName-${values.meals.length - 1}`);
}

function removeMeal(index) {
  changeMeals(values => ({ ...values, meals: values.meals.filter((_, i) => i !== index) }),
    values => (values.meals.length === 0 ? '#dsMealAdd' : `#dsMealName-${Math.min(index, values.meals.length - 1)}`));
}

function addSupplement() {
  changeMeals(values => (values.supplements.length >= MAX_SUPPLEMENTS ? values
    : { ...values, supplements: [...values.supplements, { id: null, name: '', time: '' }] }),
  values => `#dsSupName-${values.supplements.length - 1}`);
}

function removeSupplement(index) {
  changeMeals(values => ({ ...values, supplements: values.supplements.filter((_, i) => i !== index) }),
    values => (values.supplements.length === 0 ? '#dsSupAdd' : `#dsSupName-${Math.min(index, values.supplements.length - 1)}`));
}

function cancelMeals() {
  drafts.meals = null;
  sectionErrors.meals = {};
  renderMeals();
}

const submitMeals = singleFlight(async () => {
  const draft = mealValuesNow();
  drafts.meals = draft;
  const { valid, errors } = validateMealDraft(draft);
  sectionErrors.meals = errors;
  if (!valid) {
    renderWithErrors('meals', () => renderMeals());
    return false;
  }
  const button = maybe('dsMealSave');
  setBusy(button, true, 'Tallennetaan…');
  let ok = false;
  try {
    const saved = await saveLifeSettings({ mealRhythm: mealRhythmFromDraft(draft) });
    ok = saved.ok === true;
    if (ok) {
      drafts.meals = null;
      sectionErrors.meals = {};
      success('Ateriarytmi tallennettu.');
    } else if (saved.errors) {
      sectionErrors.meals = { general: Object.values(saved.errors).join(' ') };
    }
  } finally {
    setBusy(button, false);
    renderMeals();
  }
  return ok;
});

// ================================================================ piirto ja kytkentä

/** Piirrä Arki-osio. Piilossa olevaa osiota ei lasketa (vaihto piirtää sen). */
export function renderDailySettings() {
  if (!maybe('profileDailySection')) return;
  const state = getState();
  if ((state.profileSegment || 'daily') !== 'daily') return;
  const settings = currentLifeSettings(state);
  const today = todayWall();
  render('notice', noticeHtml());
  renderSleep(state, settings, today.date);
  renderRoutine(state, settings);
  renderAlarmNext(state, settings);
  renderAlarmStatus();
  renderAlarm(state, settings);
  renderBrief(settings);
  renderMeals(settings);
  maybeRefreshAlarmStatus();
}

function sectionOf(node) {
  if (!node || typeof node.closest !== 'function') return null;
  for (const [key, id] of Object.entries(CONTAINERS)) {
    if (node.closest(`#${id}`)) return key;
  }
  return null;
}

/** Kirjoitettu arvo luonnokseen: seuraava piirto ei hävitä sitä. */
function captureDraft(section) {
  if (section === 'sleep') drafts.sleep = readSleepForm() || drafts.sleep;
  else if (section === 'routine') drafts.routine = readRoutineRows() || drafts.routine;
  else if (section === 'alarm') drafts.alarm = readAlarmForm() || drafts.alarm;
  else if (section === 'meals') drafts.meals = readMealForm() || drafts.meals;
}

function onInput(event) {
  captureDraft(sectionOf(event.target));
}

function onChange(event) {
  const target = event.target;
  const section = sectionOf(target);
  if (section === 'brief' && target && target.id === 'dsMorningBrief') {
    toggleBrief(target);
    return;
  }
  captureDraft(section);
  // Valinta muuttaa herätyksen lomaketta (kiinteät ajat, tason kuvaus).
  if (section === 'alarm' && target && (target.localName === 'select' || target.type === 'radio' || target.type === 'checkbox')) {
    renderAlarm();
  }
}

const dataIndex = (button, name) => Number(button.getAttribute(name));

function onClick(event) {
  const button = event.target && typeof event.target.closest === 'function' ? event.target.closest('button') : null;
  if (!button || button.disabled) return;
  const id = button.id;
  if (id === 'dsSleepSave') submitSleep();
  else if (id === 'dsStepAdd') addStep();
  else if (button.hasAttribute('data-step-up')) moveStep(dataIndex(button, 'data-step-up'), -1);
  else if (button.hasAttribute('data-step-down')) moveStep(dataIndex(button, 'data-step-down'), 1);
  else if (button.hasAttribute('data-step-remove')) removeStep(dataIndex(button, 'data-step-remove'));
  else if (id === 'dsRoutineCancel') cancelRoutine();
  else if (id === 'dsRoutineSave') submitRoutine();
  else if (id === 'dsAlarmSave') submitAlarm();
  else if (id === 'dsAlarmExactBtn') runAlarmAction('openExactAlarmSettings', button);
  else if (id === 'dsAlarmFullScreenBtn') runAlarmAction('openFullScreenSettings', button);
  else if (id === 'dsAlarmSoundBtn') runAlarmAction('pickAlarmSound', button);
  else if (id === 'dsAlarmStatusRefresh') refreshAlarmStatus();
  else if (id === 'dsMealAdd') addMeal();
  else if (button.hasAttribute('data-meal-remove')) removeMeal(dataIndex(button, 'data-meal-remove'));
  else if (id === 'dsSupAdd') addSupplement();
  else if (button.hasAttribute('data-sup-remove')) removeSupplement(dataIndex(button, 'data-sup-remove'));
  else if (id === 'dsMealCancel') cancelMeals();
  else if (id === 'dsMealSave') submitMeals();
}

/** Enter tekstikentässä tallentaa oman osionsa (kuten muut lomakkeet). */
function onKeydown(event) {
  if (event.key !== 'Enter') return;
  const target = event.target;
  if (!target || target.localName !== 'input' || ['checkbox', 'radio'].includes(target.type)) return;
  const save = maybe(SAVE_BUTTONS[sectionOf(target)] || '');
  if (!save || save.disabled) return;
  event.preventDefault();
  captureDraft(sectionOf(target));
  save.click();
}

/** Kytke Arki-osion tapahtumat (delegoitu, kerran käynnistyksessä). */
export function initDailySettings() {
  const root = maybe('profileDailySection');
  if (!root) return;
  root.addEventListener('input', onInput);
  root.addEventListener('change', onChange);
  root.addEventListener('click', onClick);
  root.addEventListener('keydown', onKeydown);
}
