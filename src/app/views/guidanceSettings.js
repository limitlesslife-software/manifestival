// Ohjaus ja puhe (Profiili → Asetukset): ohjaustyyli, puhutut muistutukset,
// toimitustapa aiheittain ja päivän kooste.
//
// TYYLI MUUTTAA VAIN SÄVYN JA TOISTON (notificationPolicy.GUIDANCE_EFFECTS):
// rauhoitusaika, yksityisyys ja puheen lupa eivät riipu siitä. Kuvaukset
// alla kertovat täsmälleen sen, mitä tyyli tekee, eivät enempää.
//
// PUHE ON AINA KÄYTTÄJÄN VALINTA. Oletuksena mikään ei puhu; kun puhe on
// pois päältä, puheeksi valittu muistutus tulee äänimerkkinä
// (notificationPolicy.resolveDelivery).
//
// Sama luonnosmalli kuin Arki-osiossa (dailySettings.js): valinnat
// kirjataan luonnokseen, ja piirto käyttää sitä, kunnes tallennetaan.

import { escapeHtml } from '../../lib/format.js';
import { maybe, renderHtml, renderAnnouncingError, setBusy, singleFlight } from '../../ui/dom.js';
import { success } from '../../ui/toast.js';
import { getState, currentLifeSettings } from '../state.js';
import { saveLifeSettings } from '../dailyLifeActions.js';
import { hasTable, isTableAvailable } from '../../data/schema.js';
import { serverUnavailableHintHtml } from '../schemaStatus.js';
import {
  GUIDANCE_STYLES, guidanceStyleLabel, GUIDANCE_STYLE, DELIVERIES, deliveryLabel,
  REMINDER_TOPICS, reminderTopicLabel, OPTIONAL_TOPIC, DELIVERY_OFF, optionalTopicLabel
} from '../../domain/dailyLife.js';
import { deliveryFor, topicOff, DEFAULT_DIGEST_TIME } from '../../domain/lifeSettings.js';
import { remindersOffHintHtml, openReminderSettings } from './notificationSettings.js';

const CONTAINER = 'guidanceSettings';

/** Mitä tyyli tekee (notificationPolicy.GUIDANCE_EFFECTS). */
const STYLE_HINTS = Object.freeze({
  [GUIDANCE_STYLE.CALM]: 'Lempeä sävy. Jokainen muistutus tulee kerran.',
  [GUIDANCE_STYLE.BRISK]: 'Lyhyet ja suorat muistutukset. Jokainen muistutus tulee kerran.',
  [GUIDANCE_STYLE.ACTIVE]: 'Ennakkomuistutukset tulevat hieman aiemmin, ja lähtömuistutus toistetaan kerran '
    + 'kolmen minuutin päästä, jos et kuittaa sitä.'
});

/**
 * Hyvinvoinnin valinnaiset aiheet, jotka voi kytkeä kokonaan pois (aalto L).
 * Vain aiheet, joilla on muistutuksia: ateriarytmi (ateriat, vesi,
 * lisäravinteet) ja tapojen muutos. Liikunta ja kirjauskehotteet ovat
 * politiikassa valmiina (notificationPolicy.optionalTopicOf), mutta niille ei
 * vielä synny muistutuksia, joten valintaa ei näytetä turhaan.
 */
export const GUIDANCE_OPTIONAL_TOPICS = Object.freeze([
  OPTIONAL_TOPIC.MEAL, OPTIONAL_TOPIC.WATER, OPTIONAL_TOPIC.SUPPLEMENT, OPTIONAL_TOPIC.HABIT
]);

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const textOf = value => String(value ?? '').trim();

/** Kesken oleva muokkaus tai null (näytä tallennettu). */
let draft = null;
let errors = {};

/** Uloskirjautuminen: luonnos ei siirry seuraavalle käyttäjälle. */
export function resetGuidanceSettings() {
  draft = null;
  errors = {};
  // Tallentamaton valinta elää ohjaimen DOM-solmussa: tyhjä säiliö
  // piirretään seuraavalla kerralla alusta (ks. dailySettings.js).
  if (typeof document === 'undefined') return;
  const node = maybe(CONTAINER);
  if (node) node.innerHTML = '';
}

function savedValues(settings) {
  const delivery = {};
  for (const topic of REMINDER_TOPICS) delivery[topic] = deliveryFor(settings, topic);
  const topicsOff = {};
  for (const topic of GUIDANCE_OPTIONAL_TOPICS) topicsOff[topic] = topicOff(settings, topic);
  return {
    style: settings.guidanceStyle,
    speech: settings.speechEnabled === true,
    delivery,
    topicsOff,
    digest: settings.digestEnabled === true,
    digestTime: settings.digestTime || DEFAULT_DIGEST_TIME
  };
}

function readForm() {
  const root = maybe(CONTAINER);
  if (!root || !root.querySelector('#gsSave')) return null;
  const chosen = root.querySelector('input[name="gsStyle"]:checked');
  const delivery = {};
  for (const topic of REMINDER_TOPICS) {
    const select = root.querySelector(`#gsDelivery-${topic}`);
    delivery[topic] = select ? select.value : null;
  }
  const topicsOff = {};
  for (const topic of GUIDANCE_OPTIONAL_TOPICS) {
    const box = root.querySelector(`#gsTopic-${topic}`);
    topicsOff[topic] = box ? !box.checked : false;
  }
  const speech = root.querySelector('#gsSpeech');
  const digest = root.querySelector('#gsDigest');
  const time = root.querySelector('#gsDigestTime');
  return {
    style: chosen ? chosen.value : null,
    speech: Boolean(speech && speech.checked),
    delivery,
    topicsOff,
    digest: Boolean(digest && digest.checked),
    digestTime: time ? String(time.value ?? '') : ''
  };
}

/** Ohjausluonnoksen tarkistus. Palauttaa {valid, errors}. */
export function validateGuidanceDraft(value) {
  const found = {};
  const d = value && typeof value === 'object' ? value : {};
  if (!GUIDANCE_STYLES.includes(d.style)) found.style = 'Valitse ohjaustyyli.';
  for (const topic of REMINDER_TOPICS) {
    if (!DELIVERIES.includes(d.delivery && d.delivery[topic])) {
      found[`delivery.${topic}`] = 'Valitse toimitustapa.';
    }
  }
  if (d.digest === true && !TIME.test(textOf(d.digestTime))) {
    found.digestTime = 'Anna koosteen kellonaika muodossa HH:MM.';
  } else if (textOf(d.digestTime) && !TIME.test(textOf(d.digestTime))) {
    found.digestTime = 'Anna kellonaika muodossa HH:MM.';
  }
  return { valid: Object.keys(found).length === 0, errors: found };
}

/** Tarkistettu luonnos tallennettaviksi muutoksiksi. */
export function guidanceChangesFrom(value, current) {
  const time = textOf(value.digestTime);
  // Kaikki aiheet aina: asetusten yhdistäminen on kentittäistä, joten
  // pois jätetty aihe jättäisi vanhan valinnan voimaan.
  const delivery = Object.fromEntries(REMINDER_TOPICS.map(topic => [topic, value.delivery[topic]]));
  // Aalto L: valinnainen aihe kokonaan pois ('off'). Päälle/pois-aihe
  // kirjoitetaan aina ('on' poistuu normalisoinnissa), jotta kentittäinen
  // yhdistäminen voi kytkeä sen takaisin päälle.
  if (value.topicsOff && typeof value.topicsOff === 'object') {
    for (const topic of GUIDANCE_OPTIONAL_TOPICS) {
      const off = value.topicsOff[topic] === true;
      if (REMINDER_TOPICS.includes(topic)) {
        if (off) delivery[topic] = DELIVERY_OFF;
      } else {
        delivery[topic] = off ? DELIVERY_OFF : 'on';
      }
    }
  }
  return {
    guidanceStyle: value.style,
    speechEnabled: value.speech === true,
    delivery,
    digestEnabled: value.digest === true,
    digestTime: TIME.test(time) ? time : (current && current.digestTime) || DEFAULT_DIGEST_TIME
  };
}

function errorHtml(id, message) {
  return message
    ? `<div class="field-error" id="${id}Error" role="alert" style="display:block;">${escapeHtml(message)}</div>`
    : '';
}

function noticeHtml() {
  if (isTableAvailable('lifeSettings')) return '';
  if (hasTable('lifeSettings')) return serverUnavailableHintHtml();
  return '<p class="hint"><strong>Huom.</strong> Ohjauksen asetukset säilyvät toistaiseksi vain tämän istunnon ajan.</p>';
}

function styleHtml(values) {
  const options = GUIDANCE_STYLES.map(style => `
      <label class="checkbox-row" for="gsStyle-${style}">
        <input type="radio" name="gsStyle" id="gsStyle-${style}" value="${style}" aria-describedby="gsStyleHint-${style}"`
    + `${style === values.style ? ' checked' : ''}>
        ${escapeHtml(guidanceStyleLabel(style))}
      </label>
      <div class="hint" id="gsStyleHint-${style}">${escapeHtml(STYLE_HINTS[style] || '')}</div>`).join('');
  return `<fieldset class="ds-fieldset">
      <legend class="field-label">Ohjaustyyli</legend>
      ${options}
      ${errorHtml('gsStyle', errors.style)}
    </fieldset>`;
}

function deliveryHtml(values) {
  const rows = REMINDER_TOPICS.map(topic => {
    const id = `gsDelivery-${topic}`;
    const error = errors[`delivery.${topic}`];
    const options = DELIVERIES.map(value =>
      `<option value="${value}"${value === values.delivery[topic] ? ' selected' : ''}>${escapeHtml(deliveryLabel(value))}</option>`).join('');
    return `<div>
        <label class="field-label" for="${id}">${escapeHtml(reminderTopicLabel(topic))}</label>
        <select id="${id}" data-topic="${topic}"${error ? ` aria-invalid="true" aria-describedby="${id}Error"` : ''}>${options}</select>
        ${errorHtml(id, error)}
      </div>`;
  }).join('');
  return `<div class="add-form-title">Muistutusten toimitustapa</div>
    <div class="form-row">${rows}</div>`;
}

/**
 * Hyvinvoinnin valinnaiset aiheet: päälle/pois. Hyvinvointi on tukea, ei
 * tehtävälista — sanamuoto kertoo sen, eikä mitään vaadita.
 */
function optionalTopicsHtml(values) {
  const off = values.topicsOff || {};
  const rows = GUIDANCE_OPTIONAL_TOPICS.map(topic => `
      <label class="checkbox-row" for="gsTopic-${topic}">
        <input type="checkbox" id="gsTopic-${topic}" data-optional-topic="${topic}" aria-describedby="gsTopicsHint"`
    + `${off[topic] === true ? '' : ' checked'}>
        ${escapeHtml(optionalTopicLabel(topic))}
      </label>`).join('');
  return `<fieldset class="ds-fieldset">
      <legend class="field-label">Hyvinvoinnin muistutukset (valinnaisia)</legend>
      ${rows}
      <div class="hint" id="gsTopicsHint">Hyvinvointi on valinnaista tukea, ei tehtävälista. Poista valinta, niin sen aiheen
        muistutuksia ei tule lainkaan. Vesitauot ja lisäravinteet kootaan päivän koosteeseen, kun kooste on päällä.
        Raskaana päivänä (stressi 4–5 tai energia 1–2) tai ylikuormitetulla viikolla nämä kevenevät: ne siirtyvät
        koosteeseen tai jäävät pois. Lähtö, herätys ja määräajat tulevat aina.</div>
    </fieldset>`;
}

function guidanceHtml(settings, state) {
  const values = draft || savedValues(settings);
  const timeError = errors.digestTime;
  return `<h2 class="section-title" id="gsTitle">Ohjaus ja puhe</h2>
  ${noticeHtml()}
  ${remindersOffHintHtml('guidance', state)}
  <div class="add-form" role="group" aria-labelledby="gsTitle" style="display:flex;">
    ${styleHtml(values)}
    <label class="checkbox-row" for="gsSpeech">
      <input type="checkbox" id="gsSpeech" aria-describedby="gsSpeechHint"${values.speech ? ' checked' : ''}>
      Puhutut muistutukset
    </label>
    <div class="hint" id="gsSpeechHint">Kun puhe on pois päältä, puheeksi valitut muistutukset tulevat äänimerkkinä.
      Selaimessa puhe kuuluu vain, kun sovellus on auki.</div>
    ${deliveryHtml(values)}
    ${optionalTopicsHtml(values)}
    <label class="checkbox-row" for="gsDigest">
      <input type="checkbox" id="gsDigest" aria-describedby="gsDigestHint"${values.digest ? ' checked' : ''}>
      Päivän kooste
    </label>
    <div class="hint" id="gsDigestHint">Vähemmän kiireelliset muistutukset kootaan yhdeksi viestiksi. Herätys, lähtö
      ja muut kellonaikaan sidotut muistutukset tulevat silti ajallaan.</div>
    <div>
      <label class="field-label" for="gsDigestTime">Kooste klo</label>
      <input type="time" id="gsDigestTime" value="${escapeHtml(values.digestTime)}"`
    + `${timeError ? ' aria-invalid="true" aria-describedby="gsDigestTimeError"' : ''}>
      ${errorHtml('gsDigestTime', timeError)}
    </div>
    ${errors.general ? `<div class="field-error" id="gsError" role="alert" style="display:block;">${escapeHtml(errors.general)}</div>` : ''}
    <div class="form-actions">
      <button class="form-btn primary" id="gsSave" type="button">Tallenna ohjaus ja puhe</button>
    </div>
  </div>`;
}

/** Piirrä Ohjaus ja puhe -osio (#guidanceSettings). */
export function renderGuidanceSettings() {
  const container = maybe(CONTAINER);
  if (!container) return;
  const state = getState();
  renderHtml(container, guidanceHtml(currentLifeSettings(state), state), { fallback: ['gsTitle'] });
}

function firstErrorId() {
  const key = Object.keys(errors)[0];
  if (!key) return null;
  if (key === 'general') return 'gsError';
  if (key === 'style') return 'gsStyleError';
  if (key === 'digestTime') return 'gsDigestTimeError';
  return `gsDelivery-${key.split('.')[1]}Error`;
}

const submitGuidance = singleFlight(async () => {
  const settings = currentLifeSettings(getState());
  const value = readForm() || draft || savedValues(settings);
  draft = value;
  const check = validateGuidanceDraft(value);
  errors = check.errors;
  if (!check.valid) {
    const alertId = firstErrorId();
    if (alertId) renderAnnouncingError(alertId, renderGuidanceSettings);
    else renderGuidanceSettings();
    return false;
  }
  const button = maybe('gsSave');
  setBusy(button, true, 'Tallennetaan…');
  let ok = false;
  try {
    const saved = await saveLifeSettings(guidanceChangesFrom(value, settings));
    ok = saved.ok === true;
    if (ok) {
      draft = null;
      errors = {};
      success('Ohjaus ja puhe tallennettu.');
    } else if (saved.errors) {
      errors = { general: Object.values(saved.errors).join(' ') };
    }
  } finally {
    setBusy(button, false);
    renderGuidanceSettings();
  }
  return ok;
});

/** Kytke osion tapahtumat (delegoitu staattiseen säiliöön, kerran käynnistyksessä). */
export function initGuidanceSettings() {
  const root = maybe(CONTAINER);
  if (!root) return;
  const capture = () => { draft = readForm() || draft; };
  root.addEventListener('input', capture);
  root.addEventListener('change', capture);
  root.addEventListener('click', event => {
    const button = event.target && typeof event.target.closest === 'function' ? event.target.closest('button') : null;
    if (!button || button.disabled) return;
    if (button.id === 'gsSave') submitGuidance();
    else if (button.hasAttribute('data-open-reminders')) openReminderSettings();
  });
  root.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || !event.target || event.target.id !== 'gsDigestTime') return;
    event.preventDefault();
    capture();
    submitGuidance();
  });
}
