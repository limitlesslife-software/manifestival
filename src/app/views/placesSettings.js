// Profiili → Paikat: tallennetut paikat, opitut nimitykset, omista
// matkoista oppiminen, myöhästelyehdotus ja oletusetuaika.
//
// MODERNI KAAVA (ks. direction.js ja wellbeingHub.js): koko osio piirretään
// renderHtml:llä kutsujan antamaan säiliöön (#profilePlacesSection), ja
// kuuntelijat sidotaan KERRAN säiliötä kohti delegoituina. Lomakkeen
// kirjoitus elää luonnoksessa, joten taustalla tapahtuva uudelleenpiirto
// ei pyyhi sitä.
//
// PAIKKA ON NIMI JA OSOITE TEKSTINÄ. Sijaintia ei lueta, ei seurata eikä
// tallenneta (ks. migraatio 0014). Matka-aika on käyttäjän oma arvio tai
// hänen itse kuittaamistaan matkoista opittu — ei liikennetietoa.
//
// OPPIMINEN EHDOTTAA, KÄYTTÄJÄ PÄÄTTÄÄ. Opittu kesto otetaan käyttöön vasta
// hyväksynnästä (place.useLearned), ja myöhästelyn perusteella ehdotettu
// muistutuksen aikaistus on kysymys, ei muutos (commuteLearning.js).
// "Ei nyt" piilottaa ehdotuksen tämän istunnon ajaksi; mitään ei tallenneta.
//
// TUNTEMATON EI OLE NOLLA. Tyhjä matka-aika näkyy "Matka-aika puuttuu"
// eikä nollana: nollasta laskettu lähtöaika olisi vale.

import { getState, currentLifeSettings } from '../state.js';
import {
  savePlace, deletePlace, deletePlaceAlias, resetPlaceLearning, saveLifeSettings
} from '../dailyLifeActions.js';
import { serverUnavailableHintHtml } from '../schemaStatus.js';
import { loadFailureHtml } from './loadNotice.js';
import { renderHtml, singleFlight, setBusy } from '../../ui/dom.js';
import { success } from '../../ui/toast.js';
import { escapeHtml } from '../../lib/format.js';
import { hasTable, isTableAvailable } from '../../data/schema.js';
import { summarizeCommute, latenessSuggestion, MIN_LEARNING_OBSERVATIONS } from '../../domain/commuteLearning.js';
import { TRAVEL_MODE, TRAVEL_MODES, travelModeLabel } from '../../domain/travel.js';
import {
  ARRIVAL_BUFFER_CHOICES, MAX_ARRIVAL_BUFFER_MINUTES, MAX_PLACE_NAME_LENGTH, MAX_ADDRESS_LENGTH,
  MAX_TRAVEL_MINUTES, MAX_PREPARATION_MINUTES, MAX_PLACE_ARRIVAL_BUFFER_MINUTES, MAX_OVERHEAD_MINUTES
} from '../../domain/dailyLife.js';
import { MAX_AREA_LENGTH, MAX_PLACE_NOTE_LENGTH } from '../../domain/savedPlace.js';
import { durationText } from '../../domain/wallClock.js';

/** Taulut, joiden tallennuksesta osio kertoo (portti kiinni tai kanta jäljessä). */
const TABLE_KEYS = Object.freeze(['savedPlaces', 'placeAliases', 'commuteObservations', 'lifeSettings']);

const SECTION_HEADINGS = Object.freeze({
  buffer: 'plcBufferTitle',
  late: 'plcLateTitle',
  places: 'plcPlacesTitle'
});

// ------------------------------------------------------------ luonnokset

const bound = new WeakSet();

/**
 * place  = paikkalomake (null = kiinni)
 * buffer = oman etuajan kenttä (null = kiinni)
 */
let drafts = { place: null, buffer: null };

/** Istunnon aikana "Ei nyt" -vastauksen saanut ehdotus (ehdotettu minuuttimäärä). */
let dismissedOffset = null;

/** Uloskirjautuminen ja testit: luonnokset ja hylätty ehdotus pois (cross-user leak). */
export function resetPlacesSettings() {
  drafts = { place: null, buffer: null };
  dismissedOffset = null;
}

// ------------------------------------------------------------ apurit

function numText(value) {
  return value === null || value === undefined ? '' : String(value);
}

function attrValue(value) {
  return String(value).replace(/["\\]/g, '\\$&');
}

/** Tyhjä = null (tuntematon, EI nolla); muu kuin kokonaisluku rajoissa on virhe. */
function parseWhole(raw, min, max) {
  const text = String(raw ?? '').trim();
  if (text === '') return { value: null };
  if (!/^-?\d+$/.test(text)) return { error: `Anna kokonaisluku ${min}–${max}.` };
  const value = Number(text);
  if (value < min || value > max) return { error: `Anna kokonaisluku ${min}–${max}.` };
  return { value };
}

function timesText(n) {
  return n === 1 ? 'kerran' : `${n} kertaa`;
}

function byPlaceName(a, b) {
  return String(a.name).localeCompare(String(b.name), 'fi') || String(a.id).localeCompare(String(b.id), 'fi');
}

// ------------------------------------------------------------ kentät

function describedBy(id, hint, error) {
  const ids = [hint ? `${id}Hint` : '', error ? `${id}Error` : ''].filter(Boolean);
  return ids.length ? ` aria-describedby="${ids.join(' ')}"` : '';
}

function fieldExtras(id, hint, error) {
  return (hint ? `<div class="lh-hint" id="${id}Hint">${escapeHtml(hint)}</div>` : '')
    + (error ? `<div class="field-error lh-error" id="${id}Error" role="alert">${escapeHtml(error)}</div>` : '');
}

function inputField({ id, label, value, form, field, errors, type = 'text', attrs = '', hint = '', required = false }) {
  const error = errors[id] || '';
  return `<div class="lh-field">
      <label class="field-label" for="${id}">${label}${required ? ' <span aria-hidden="true">*</span>' : ''}</label>
      <input id="${id}" type="${type}" value="${escapeHtml(value)}" data-form="${form}" data-field="${field}"${attrs ? ' ' + attrs : ''}${required ? ' aria-required="true"' : ''}${error ? ' aria-invalid="true"' : ''}${describedBy(id, hint, error)}>
      ${fieldExtras(id, hint, error)}
    </div>`;
}

function numberField({ id, label, value, form, field, errors, min, max, hint = '' }) {
  return inputField({
    id, label, value, form, field, errors, hint, type: 'number',
    attrs: `min="${min}" max="${max}" step="1" inputmode="numeric"`
  });
}

function formErrorHtml(id, errors) {
  const error = errors[id];
  return error ? `<div class="field-error lh-error" id="${id}" role="alert" tabindex="-1">${escapeHtml(error)}</div>` : '';
}

function sectionHtml(key, title, body) {
  const heading = SECTION_HEADINGS[key];
  return `<section class="lh-section" data-section="${key}" data-heading="${heading}" aria-labelledby="${heading}">
    <h2 class="section-title lh-heading" id="${heading}" tabindex="-1">${title}</h2>
    ${body}
  </section>`;
}

function persistenceNoticeHtml() {
  if (TABLE_KEYS.every(key => isTableAvailable(key))) return '';
  if (TABLE_KEYS.some(key => hasTable(key) && !isTableAvailable(key))) return serverUnavailableHintHtml();
  return '<p class="hint lh-notice"><strong>Huom.</strong> Paikat, opitut nimitykset ja asetukset säilyvät '
    + 'toistaiseksi vain tämän istunnon ajan.</p>';
}

// ------------------------------------------------------------ oletusetuaika

function bufferHtml(settings) {
  const current = settings.arrivalBufferMinutes;
  const custom = !ARRIVAL_BUFFER_CHOICES.includes(current);
  // Valinta näkyy merkkinä eikä pelkkänä värinä; ruudunlukija saa sen aria-pressedistä.
  const mark = pressed => (pressed ? '<span class="lh-check" aria-hidden="true">✓ </span>' : '');
  const chips = ARRIVAL_BUFFER_CHOICES.map(minutes =>
    `<button type="button" class="assist-btn lh-chip" data-action="buffer-set" data-value="${minutes}" aria-pressed="${current === minutes}">${mark(current === minutes)}${minutes} min</button>`)
    .join('');
  const customChip = `<button type="button" class="assist-btn lh-chip" data-action="buffer-custom" aria-pressed="${custom}">`
    + `${mark(custom)}Oma${custom ? `: ${current} min` : '…'}</button>`;
  const draft = drafts.buffer;
  const editor = draft
    ? `<div class="lh-inline" role="group" aria-labelledby="plcBufferCustomLabel" data-form-root="buffer">
        <div class="lh-field">
          <label class="field-label" id="plcBufferCustomLabel" for="plcBufferCustom">Oma etuaika (min)</label>
          <input id="plcBufferCustom" type="number" min="0" max="${MAX_ARRIVAL_BUFFER_MINUTES}" step="1" inputmode="numeric" value="${escapeHtml(draft.value)}" data-form="buffer" data-field="value"${draft.error ? ' aria-invalid="true" aria-describedby="plcBufferCustomError"' : ''}>
          ${draft.error ? `<div class="field-error lh-error" id="plcBufferCustomError" role="alert">${escapeHtml(draft.error)}</div>` : ''}
        </div>
        <div class="assist-actions">
          <button type="button" class="assist-btn primary" data-action="buffer-save">Tallenna</button>
          <button type="button" class="assist-btn" data-action="buffer-cancel">Peruuta</button>
        </div>
      </div>`
    : '';
  return sectionHtml('buffer', 'Oletus etuaika', `
    <p class="hint">Kuinka paljon ennen alkua haluat olla perillä, kun menolla tai paikalla ei ole omaa etuaikaa. `
    + `Nyt ${current} min.</p>
    <div class="lh-chips" role="group" aria-labelledby="${SECTION_HEADINGS.buffer}">${chips}${customChip}</div>
    ${editor}`);
}

// ------------------------------------------------------------ myöhästely

function currentSuggestion(state, settings) {
  const suggestion = latenessSuggestion(state.commuteObservations, {
    currentOffsetMinutes: settings.reminderOffsetMinutes
  });
  return suggestion && suggestion.suggestedOffsetMinutes !== dismissedOffset ? suggestion : null;
}

function latenessHtml(state, settings) {
  const suggestion = currentSuggestion(state, settings);
  const offset = settings.reminderOffsetMinutes;
  if (!suggestion && offset === 0) return '';
  const current = offset > 0
    ? `<p class="assist-meta">Lähtömuistutus tulee nyt ${offset} min tavallista aikaisemmin.</p>
       <div class="assist-actions">
         <button type="button" class="assist-btn" data-action="offset-clear">Palauta tavalliseen aikaan</button>
       </div>`
    : '';
  const proposal = suggestion
    ? `<div class="lh-summary" role="group" aria-label="Ehdotus lähtömuistutuksesta">
        <p>${escapeHtml(suggestion.message)}</p>
        <p class="assist-reason">Perustuu ${suggestion.count} viimeisimpään kuittaamaasi lähtöön. `
        + `Mitään ei muuteta ilman hyväksyntääsi.</p>
        <div class="assist-actions">
          <button type="button" class="assist-btn primary" data-action="offset-accept" data-value="${suggestion.suggestedOffsetMinutes}">Aloita ${suggestion.suggestedOffsetMinutes} min aikaisemmin</button>
          <button type="button" class="assist-btn" data-action="offset-dismiss" data-value="${suggestion.suggestedOffsetMinutes}">Ei nyt</button>
        </div>
      </div>`
    : '';
  return sectionHtml('late', 'Lähtömuistutus', `${current}${proposal}`);
}

// ------------------------------------------------------------ paikat

function learningHtml(place, state) {
  const summary = summarizeCommute(state.commuteObservations, { placeId: place.id });
  const id = escapeHtml(place.id);
  if (summary.count >= MIN_LEARNING_OBSERVATIONS && summary.median !== null) {
    const base = `Viimeisten ${summary.count} matkan mediaani oli ${summary.median} min`;
    if (place.useLearned) {
      const safer = summary.p80 !== null && summary.p80 > summary.median
        ? ` Lähtö lasketaan ${summary.p80} minuutin mukaan, johon useimmat matkat ovat mahtuneet.`
        : '';
      return `<div class="lh-learning">
          <p class="assist-reason">${base}. Opittu kesto on käytössä.${safer}</p>
          <div class="assist-actions">
            <button type="button" class="assist-btn" data-action="learned-off" data-id="${id}">Käytä omaa arviota</button>
          </div>
        </div>`;
    }
    const setUsual = place.usualTravelMinutes !== summary.median
      ? `<button type="button" class="assist-btn" data-action="learned-usual" data-id="${id}" data-value="${summary.median}">Aseta omaksi arvioksi ${summary.median} min</button>`
      : '';
    return `<div class="lh-learning">
        <p class="assist-reason">${base} — käytä tätä?</p>
        <div class="assist-actions">
          <button type="button" class="assist-btn primary" data-action="learned-on" data-id="${id}">Käytä opittua kestoa</button>
          ${setUsual}
        </div>
      </div>`;
  }
  if (summary.count > 0 || place.useLearned) {
    // Lupa on annettu, mutta matkoja on vielä liian vähän: lähtö lasketaan
    // omasta arviosta (forecastCommute), ja se kerrotaan suoraan.
    const verb = place.useLearned ? 'käytetään' : 'ehdotetaan';
    const meanwhile = place.useLearned ? ' Siihen asti käytetään omaa arviotasi.' : '';
    return `<p class="assist-reason">Kuitattuja matkoja ${summary.count}. Opittua kestoa ${verb}, kun matkoja on `
      + `vähintään ${MIN_LEARNING_OBSERVATIONS}.${meanwhile}</p>`;
  }
  return '';
}

function aliasesHtml(place, aliases, index) {
  if (aliases.length === 0) return '';
  const headingId = `plcAliasesTitle-${index}`;
  const rows = aliases.map(alias => {
    const text = escapeHtml(alias.alias);
    return `<li>
        <span>”${text}” · vahvistettu ${timesText(alias.confirmations)}</span>
        <button type="button" class="assist-btn danger" data-action="alias-delete" data-id="${escapeHtml(alias.id)}" data-place="${escapeHtml(place.id)}" aria-label="Poista nimitys ${text}">Poista</button>
      </li>`;
  }).join('');
  return `<div class="lh-subtitle" id="${headingId}">Tunnetut nimitykset</div>
    <ul class="lh-aliases" aria-labelledby="${headingId}">${rows}</ul>`;
}

function placeRowHtml(place, index, state, settings) {
  const id = escapeHtml(place.id);
  const name = escapeHtml(place.name);
  const where = [place.address, place.area].filter(Boolean).map(escapeHtml).join(' · ');
  const travel = place.usualTravelMinutes !== null
    ? `oma arvio ${durationText(place.usualTravelMinutes)}`
    : '<span class="lh-unknown">Matka-aika puuttuu — lisää oma arvio</span>';
  const details = [
    place.preparationMinutes !== null ? `valmistautuminen ${durationText(place.preparationMinutes)}` : null,
    place.arrivalBufferMinutes !== null
      ? `saavu etuajassa ${place.arrivalBufferMinutes} min`
      : `etuaika oletus (${settings.arrivalBufferMinutes} min)`,
    place.overheadMinutes !== null ? `pysäköinti ja kävely ${place.overheadMinutes} min` : null
  ].filter(Boolean);
  const aliases = state.placeAliases
    .filter(alias => alias.placeId === place.id)
    .sort((a, b) => b.confirmations - a.confirmations || String(a.alias).localeCompare(String(b.alias), 'fi'));
  const observed = state.commuteObservations.some(observation => observation.placeId === place.id);
  const resettable = aliases.length > 0 || observed || place.useLearned;
  return `<li class="assist-row lh-row" data-place-row="${id}">
      <div class="assist-title">${name}</div>
      ${where ? `<div class="assist-meta">${where}</div>` : ''}
      <div class="assist-meta">${escapeHtml(travelModeLabel(place.travelMode))} · ${travel}</div>
      <div class="assist-meta">${details.join(' · ')}</div>
      ${learningHtml(place, state)}
      ${aliasesHtml(place, aliases, index)}
      ${place.note ? `<div class="assist-reason">${escapeHtml(place.note)}</div>` : ''}
      <div class="assist-actions">
        <button type="button" class="assist-btn" data-action="place-edit" data-id="${id}" aria-label="Muokkaa paikkaa ${name}">Muokkaa</button>
        ${resettable ? `<button type="button" class="assist-btn" data-action="place-reset" data-id="${id}" aria-label="Nollaa oppiminen: ${name}">Nollaa oppiminen</button>` : ''}
        <button type="button" class="assist-btn danger" data-action="place-delete" data-id="${id}" aria-label="Poista paikka ${name}">Poista</button>
      </div>
    </li>`;
}

function placeDraftFrom(place) {
  return {
    id: place ? place.id : null,
    name: place ? place.name : '',
    address: place && place.address ? place.address : '',
    area: place && place.area ? place.area : '',
    travelMode: place ? place.travelMode : TRAVEL_MODE.DRIVING,
    usual: numText(place && place.usualTravelMinutes),
    prep: numText(place && place.preparationMinutes),
    buffer: numText(place && place.arrivalBufferMinutes),
    overhead: numText(place && place.overheadMinutes),
    note: place && place.note ? place.note : '',
    useLearned: Boolean(place && place.useLearned),
    errors: {},
    saving: false,
    returnFocus: null
  };
}

function parsePlaceDraft(draft) {
  const errors = {};
  const name = draft.name.trim();
  if (!name) errors.plcName = 'Anna paikalle nimi.';
  const read = (id, raw, min, max) => {
    const parsed = parseWhole(raw, min, max);
    if (parsed.error) errors[id] = parsed.error;
    return parsed.value ?? null;
  };
  const input = {
    ...(draft.id ? { id: draft.id } : {}),
    name,
    address: draft.address.trim() || null,
    area: draft.area.trim() || null,
    travelMode: TRAVEL_MODES.includes(draft.travelMode) ? draft.travelMode : TRAVEL_MODE.DRIVING,
    usualTravelMinutes: read('plcTravel', draft.usual, 1, MAX_TRAVEL_MINUTES),
    preparationMinutes: read('plcPrep', draft.prep, 0, MAX_PREPARATION_MINUTES),
    arrivalBufferMinutes: read('plcBuffer', draft.buffer, 0, MAX_PLACE_ARRIVAL_BUFFER_MINUTES),
    overheadMinutes: read('plcOverhead', draft.overhead, 0, MAX_OVERHEAD_MINUTES),
    note: draft.note.trim() || null,
    useLearned: draft.useLearned === true
  };
  return { errors, input };
}

function placeFormHtml(draft, settings) {
  const errors = draft.errors;
  const modes = TRAVEL_MODES.map(mode =>
    `<option value="${mode}"${mode === draft.travelMode ? ' selected' : ''}>${escapeHtml(travelModeLabel(mode))}</option>`)
    .join('');
  const busy = draft.saving ? ' disabled aria-busy="true"' : '';
  return `<div class="add-form lh-form" role="group" aria-labelledby="plcFormTitle" data-form-root="place">
      <div class="add-form-title" id="plcFormTitle">${draft.id ? 'Muokkaa paikkaa' : 'Uusi paikka'}</div>
      <p class="hint">Paikka on nimi ja osoite tekstinä. Sijaintiasi ei seurata eikä tallenneta.</p>
      ${inputField({
        id: 'plcName', label: 'Nimi', value: draft.name, form: 'place', field: 'name', errors, required: true,
        attrs: `maxlength="${MAX_PLACE_NAME_LENGTH}" autocomplete="off"`
      })}
      ${inputField({
        id: 'plcAddress', label: 'Osoite', value: draft.address, form: 'place', field: 'address', errors,
        attrs: `maxlength="${MAX_ADDRESS_LENGTH}" autocomplete="off"`
      })}
      <div class="form-row">
        ${inputField({
          id: 'plcArea', label: 'Alue', value: draft.area, form: 'place', field: 'area', errors,
          attrs: `maxlength="${MAX_AREA_LENGTH}" autocomplete="off"`
        })}
        <div class="lh-field">
          <label class="field-label" for="plcMode">Kulkutapa</label>
          <select id="plcMode" data-form="place" data-field="travelMode"${errors.plcMode ? ' aria-invalid="true" aria-describedby="plcModeError"' : ''}>${modes}</select>
          ${fieldExtras('plcMode', '', errors.plcMode || '')}
        </div>
      </div>
      ${numberField({
        id: 'plcTravel', label: 'Oma arvio matka-ajasta (min)', value: draft.usual, form: 'place', field: 'usual', errors,
        min: 1, max: MAX_TRAVEL_MINUTES, hint: 'Tavallinen kesto ovelta ovelle. Tämä ei ole liikennetietoa.'
      })}
      <div class="form-row">
        ${numberField({
          id: 'plcPrep', label: 'Valmistautuminen (min)', value: draft.prep, form: 'place', field: 'prep', errors,
          min: 0, max: MAX_PREPARATION_MINUTES
        })}
        ${numberField({
          id: 'plcOverhead', label: 'Pysäköinti ja kävely (min)', value: draft.overhead, form: 'place', field: 'overhead',
          errors, min: 0, max: MAX_OVERHEAD_MINUTES
        })}
      </div>
      ${numberField({
        id: 'plcBuffer', label: 'Saavu etuajassa (min)', value: draft.buffer, form: 'place', field: 'buffer', errors,
        min: 0, max: MAX_PLACE_ARRIVAL_BUFFER_MINUTES,
        hint: `Tyhjä = oletus ${settings.arrivalBufferMinutes} min.`
      })}
      <div class="lh-field">
        <label class="field-label" for="plcNote">Muistiinpano</label>
        <textarea id="plcNote" rows="2" maxlength="${MAX_PLACE_NOTE_LENGTH}" data-form="place" data-field="note">${escapeHtml(draft.note)}</textarea>
      </div>
      <label class="check-row" for="plcUseLearned"><input type="checkbox" id="plcUseLearned" data-form="place" data-field="useLearned" aria-describedby="plcUseLearnedHint"${draft.useLearned ? ' checked' : ''}> Käytä omista matkoista opittua kestoa</label>
      <div class="lh-hint" id="plcUseLearnedHint">Opittua kestoa käytetään, kun kuitattuja matkoja on vähintään ${MIN_LEARNING_OBSERVATIONS}. Siihen asti käytetään omaa arviotasi.</div>
      ${formErrorHtml('plcFormError', errors)}
      <div class="form-actions">
        ${draft.id ? `<button type="button" class="form-btn danger" data-action="place-remove"${busy}>Poista</button>` : ''}
        <button type="button" class="form-btn secondary" data-action="place-cancel">Peruuta</button>
        <button type="button" class="form-btn primary" data-action="place-save"${busy}>${draft.saving ? 'Tallennetaan…' : 'Tallenna'}</button>
      </div>
    </div>`;
}

function placesHtml(state, settings) {
  const places = [...state.savedPlaces].sort(byPlaceName);
  const list = places.length
    ? `<ul class="lh-list">${places.map((place, index) => placeRowHtml(place, index, state, settings)).join('')}</ul>`
    : '<p class="assist-empty">Ei vielä tallennettuja paikkoja. Paikka tekee lähtöajan laskemisesta helpompaa: '
      + 'kerrot kerran, kauanko matka yleensä kestää.</p>';
  const add = `<button type="button" class="add-row" data-action="place-add"><svg class="icon" aria-hidden="true"><use href="#i-plus"/></svg>Uusi paikka</button>`;
  return sectionHtml('places', 'Paikat', `
    ${loadFailureHtml(state, ['savedPlaces', 'placeAliases', 'commuteObservations'])}
    ${list}
    ${drafts.place ? placeFormHtml(drafts.place, settings) : add}`);
}

// ------------------------------------------------------------ piirto

function settingsHtml() {
  const state = getState();
  const settings = currentLifeSettings(state);
  return `<div class="lh-hub" data-lh="places">
    ${persistenceNoticeHtml()}
    ${placesHtml(state, settings)}
    ${latenessHtml(state, settings)}
    ${bufferHtml(settings)}
  </div>`;
}

function fallbackFor(container) {
  const active = typeof document !== 'undefined' ? document.activeElement : null;
  const section = active && container.contains(active) && typeof active.closest === 'function'
    ? active.closest('[data-section]')
    : null;
  const heading = section ? section.getAttribute('data-heading') : null;
  return heading ? [heading, SECTION_HEADINGS.places] : [SECTION_HEADINGS.places];
}

/**
 * Piirrä Paikat-osio säiliöön. Lukee tilan ja luonnokset; ei muuta mitään.
 * Sitoo kuuntelijat, jos initPlacesSettings jäi kutsumatta.
 *
 * @param {Element} container esim. #profilePlacesSection
 */
export function renderPlacesSettings(container) {
  if (!container) return;
  initPlacesSettings(container);
  renderHtml(container, settingsHtml(), { fallback: fallbackFor(container) });
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

function byAction(action, id) {
  return id ? `[data-action="${action}"][data-id="${attrValue(id)}"]` : `[data-action="${action}"]`;
}

// ------------------------------------------------------------ toiminnot

function openPlaceForm(container, place, opener) {
  const draft = placeDraftFrom(place);
  draft.returnFocus = opener;
  drafts.place = draft;
  renderPlacesSettings(container);
  focusIn(container, '#plcName');
}

function closePlaceForm(container) {
  const draft = drafts.place;
  drafts.place = null;
  renderPlacesSettings(container);
  focusIn(container, draft && draft.returnFocus, byAction('place-add'), `#${SECTION_HEADINGS.places}`);
}

const PLACE_ERROR_FIELDS = Object.freeze({ name: 'plcName', usualTravelMinutes: 'plcTravel', travelMode: 'plcMode' });

const savePlaceForm = singleFlight(async container => {
  const draft = drafts.place;
  if (!draft || draft.saving) return;
  const { input, errors } = parsePlaceDraft(draft);
  if (Object.keys(errors).length > 0) {
    draft.errors = errors;
    renderPlacesSettings(container);
    focusIn(container, '[data-form-root="place"] [aria-invalid="true"]');
    return;
  }
  draft.errors = {};
  draft.saving = true;
  renderPlacesSettings(container);
  const result = await savePlace(input);
  if (drafts.place !== draft) return;
  draft.saving = false;
  if (result && result.ok) {
    drafts.place = null;
    renderPlacesSettings(container);
    success(draft.id ? 'Paikka päivitetty.' : 'Paikka tallennettu.');
    focusIn(container, byAction('place-edit', result.place.id), byAction('place-add'));
    return;
  }
  if (result && result.discarded) return;
  if (result && result.errors) {
    draft.errors = Object.fromEntries(Object.entries(result.errors)
      .map(([key, message]) => [PLACE_ERROR_FIELDS[key] || 'plcFormError', message]));
  }
  renderPlacesSettings(container);
  if (result && result.errors) {
    focusIn(container, '[data-form-root="place"] [aria-invalid="true"]', '#plcFormError');
  } else {
    focusIn(container, byAction('place-save'));
  }
});

/**
 * Nopea toiminto riviltä (hyväksy, poista, nollaa). Yksi kerrallaan
 * (tuplanapautus ei aja kahdesti), painike varatuksi odotuksen ajaksi.
 * `after` saa tuloksen ja siirtää fokuksen järkevään paikkaan, koska
 * napautettu painike usein katoaa (esim. "Käytä opittua kestoa").
 */
const quick = singleFlight(async (container, button, run, after) => {
  const again = sameButton(button);
  setBusy(button, true);
  let result;
  try {
    result = await run();
  } finally {
    if (button.isConnected) setBusy(button, false);
  }
  if (result && result.discarded) return;
  // Tila piirtää näkymän itse; tämä varmistaa ajantasaisen DOMin ennen
  // fokuksen siirtoa, vaikka piirto olisi tilaajalla viivästetty.
  renderPlacesSettings(container);
  if (result && result.ok) {
    after(result);
    return;
  }
  // Peruttu vahvistus tai epäonnistunut tallennus: dialogi ei voinut
  // palauttaa fokusta varattuun painikkeeseen, joten se palautetaan tässä
  // samaan toimintoon (peruutuksen jälkeen piirretty painike on uusi solmu).
  focusIn(container, again);
});

/** Valitsin, joka löytää saman toiminnon painikkeen uudelleenpiirron jälkeen. */
function sameButton(button) {
  return ['action', 'id', 'value', 'place']
    .map(name => [name, button.getAttribute(`data-${name}`)])
    .filter(([, value]) => value !== null)
    .map(([name, value]) => `[data-${name}="${attrValue(value)}"]`)
    .join('');
}

const saveBufferChoice = singleFlight(async container => {
  const draft = drafts.buffer;
  if (!draft) return;
  const parsed = parseWhole(draft.value, 0, MAX_ARRIVAL_BUFFER_MINUTES);
  if (parsed.error || parsed.value === null) {
    draft.error = parsed.error || `Anna etuaika minuutteina 0–${MAX_ARRIVAL_BUFFER_MINUTES}.`;
    renderPlacesSettings(container);
    focusIn(container, '#plcBufferCustom');
    return;
  }
  const result = await saveLifeSettings({ arrivalBufferMinutes: parsed.value });
  if (drafts.buffer !== draft) return;
  if (result && result.ok) {
    drafts.buffer = null;
    renderPlacesSettings(container);
    success(`Oletus etuaika on nyt ${parsed.value} min.`);
    focusIn(container, byAction('buffer-custom'));
  }
});

function onClick(container, event) {
  const button = event.target && typeof event.target.closest === 'function'
    ? event.target.closest('[data-action]')
    : null;
  if (!button || !container.contains(button) || button.disabled) return;
  const state = getState();
  const id = button.getAttribute('data-id');
  const value = Number(button.getAttribute('data-value'));
  switch (button.getAttribute('data-action')) {
    case 'place-add':
      openPlaceForm(container, null, byAction('place-add'));
      break;
    case 'place-edit': {
      const place = state.savedPlaces.find(item => item.id === id);
      if (place) openPlaceForm(container, place, byAction('place-edit', id));
      break;
    }
    case 'place-save': savePlaceForm(container); break;
    case 'place-cancel': closePlaceForm(container); break;
    case 'place-delete':
    case 'place-remove': {
      const placeId = id || (drafts.place && drafts.place.id);
      if (!placeId) break;
      quick(container, button, () => deletePlace(placeId), () => {
        if (drafts.place && drafts.place.id === placeId) drafts.place = null;
        renderPlacesSettings(container);
        success('Paikka poistettu.');
        focusIn(container, byAction('place-add'), `#${SECTION_HEADINGS.places}`);
      });
      break;
    }
    case 'place-reset':
      quick(container, button, () => resetPlaceLearning(id), () => {
        success('Oppiminen nollattu. Oma arviosi säilyi.');
        focusIn(container, byAction('place-edit', id));
      });
      break;
    case 'learned-on':
      quick(container, button, () => savePlace({ id, useLearned: true }), () => {
        success('Opittu kesto on käytössä.');
        focusIn(container, byAction('learned-off', id), byAction('place-edit', id));
      });
      break;
    case 'learned-off':
      quick(container, button, () => savePlace({ id, useLearned: false }), () => {
        success('Käytössä on taas oma arviosi.');
        focusIn(container, byAction('learned-on', id), byAction('place-edit', id));
      });
      break;
    case 'learned-usual':
      if (!Number.isInteger(value)) break;
      quick(container, button, () => savePlace({ id, usualTravelMinutes: value }), () => {
        success(`Oma arvio on nyt ${value} min.`);
        focusIn(container, byAction('learned-on', id), byAction('place-edit', id));
      });
      break;
    case 'alias-delete': {
      const placeId = button.getAttribute('data-place');
      quick(container, button, () => deletePlaceAlias(id), () => {
        success('Nimitys poistettu.');
        focusIn(container, `[data-action="alias-delete"][data-place="${attrValue(placeId)}"]`, byAction('place-edit', placeId));
      });
      break;
    }
    case 'buffer-set':
      if (!Number.isInteger(value)) break;
      drafts.buffer = null;
      quick(container, button, () => saveLifeSettings({ arrivalBufferMinutes: value }), () => {
        success(`Oletus etuaika on nyt ${value} min.`);
        focusIn(container, `[data-action="buffer-set"][data-value="${value}"]`);
      });
      break;
    case 'buffer-custom': {
      const current = currentLifeSettings(state).arrivalBufferMinutes;
      drafts.buffer = { value: String(current), error: '' };
      renderPlacesSettings(container);
      focusIn(container, '#plcBufferCustom');
      break;
    }
    case 'buffer-save': saveBufferChoice(container); break;
    case 'buffer-cancel':
      drafts.buffer = null;
      renderPlacesSettings(container);
      focusIn(container, byAction('buffer-custom'));
      break;
    case 'offset-accept':
      if (!Number.isInteger(value)) break;
      quick(container, button, () => saveLifeSettings({ reminderOffsetMinutes: value }), () => {
        success(`Lähtömuistutus tulee nyt ${value} min aikaisemmin.`);
        focusIn(container, byAction('offset-clear'), `#${SECTION_HEADINGS.places}`);
      });
      break;
    case 'offset-dismiss':
      dismissedOffset = Number.isInteger(value) ? value : null;
      renderPlacesSettings(container);
      focusIn(container, byAction('offset-clear'), `#${SECTION_HEADINGS.late}`, `#${SECTION_HEADINGS.buffer}`);
      break;
    case 'offset-clear':
      quick(container, button, () => saveLifeSettings({ reminderOffsetMinutes: 0 }), () => {
        success('Lähtömuistutus tulee taas tavalliseen aikaan.');
        focusIn(container, `#${SECTION_HEADINGS.late}`, `#${SECTION_HEADINGS.buffer}`);
      });
      break;
    default: break;
  }
}

/**
 * Selaimen lukematon numerosyöte (esim. "10-15"): type=number antaa arvoksi
 * '' ja validity.badInput = true. Ilman merkintää '' olisi hiljaa "ei asetettu".
 * Merkintä ei ole luku, joten jäsennys antaa kentän virheen; näkyvä kenttä
 * tyhjenee (numerokenttä hylkää ei-numeerisen arvon).
 */
const UNREADABLE_INPUT = 'lukukelvoton';

function fieldText(target) {
  return target.validity && target.validity.badInput ? UNREADABLE_INPUT : String(target.value ?? '');
}

/** Näppäily päivittää luonnoksen, ei piirrä: kirjoitus ei katkea. */
function onFieldInput(event) {
  const target = event.target;
  if (!target || typeof target.getAttribute !== 'function') return;
  const form = target.getAttribute('data-form');
  const field = target.getAttribute('data-field');
  const draft = form ? drafts[form] : null;
  if (!draft || !field) return;
  draft[field] = target.type === 'checkbox' ? Boolean(target.checked) : fieldText(target);
}

/** Enter tekstikentässä tallentaa, Escape sulkee lomakkeen. */
function onKeydown(container, event) {
  const target = event.target;
  if (!target || typeof target.closest !== 'function') return;
  const root = target.closest('[data-form-root]');
  if (!root || !container.contains(root)) return;
  const form = root.getAttribute('data-form-root');
  if (event.key === 'Escape') {
    event.preventDefault();
    if (form === 'place') closePlaceForm(container);
    else {
      drafts.buffer = null;
      renderPlacesSettings(container);
      focusIn(container, byAction('buffer-custom'));
    }
    return;
  }
  if (event.key === 'Enter' && target.localName === 'input' && target.type !== 'checkbox') {
    event.preventDefault();
    if (form === 'place') savePlaceForm(container);
    else saveBufferChoice(container);
  }
}

/**
 * Sido delegoidut kuuntelijat säiliöön KERRAN. Turvallinen kutsua monta
 * kertaa samalle säiliölle.
 *
 * @param {Element} container esim. #profilePlacesSection
 */
export function initPlacesSettings(container) {
  if (!container || bound.has(container) || typeof container.addEventListener !== 'function') return;
  bound.add(container);
  container.addEventListener('click', event => onClick(container, event));
  container.addEventListener('input', onFieldInput);
  container.addEventListener('change', onFieldInput);
  container.addEventListener('keydown', event => onKeydown(container, event));
}
