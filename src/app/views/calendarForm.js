// Menolomake: uusi meno, muokkaus, poisto ja toistuvan menon yhden kerran ohitus.
//
// Lomake on staattista merkintää (index.html #calEventForm), joten tilan
// muutos ei piirrä sitä uudelleen kesken kirjoittamisen: fokus ja
// keskeneräinen syöte säilyvät.
//
// TUNTEMATON EI OLE NOLLA. Tyhjä minuuttikenttä tarkoittaa "ei asetettu":
// silloin pätee paikan tai asetusten arvo. Siksi paikan valinta EI kopioi
// paikan lukuja menolle, vaan näyttää ne oletuksina (vihje ja paikkateksti).
// Kopio jäisi vanhaksi, kun paikan tietoja myöhemmin korjataan.
//
// Kenttävirheet tarkistetaan ennen tallennusta ja kerrotaan kentän alla
// (role="alert"), ensimmäinen virheellinen kenttä saa fokuksen. Hiljaista
// pudottamista ei ole: kelvoton minuuttimäärä on virhe, ei tyhjä arvo.

import { el, maybe, toggle, setText, setBusy, singleFlight } from '../../ui/dom.js';
import { escapeHtml } from '../../lib/format.js';
import { fmtISO, parseISO, startOfWeek, addDays, todayMidnight } from '../../lib/datetime.js';
import { success } from '../../ui/toast.js';
import { confirmAction } from '../../ui/confirm.js';
import {
  getState, findCalendarEvent, findSavedPlace, currentLifeSettings, setCalendarDate, setWeekStart
} from '../state.js';
import { saveCalendarEvent, deleteCalendarEvent, skipEventOccurrence } from '../dailyLifeActions.js';
import { CATEGORIES, DEFAULT_CATEGORY, normalizeCategory } from '../../domain/categories.js';
import { TRAVEL_MODE, TRAVEL_MODES, travelModeLabel, DEFAULT_BUFFERS } from '../../domain/travel.js';
import { isIsoDate, isTimeOfDay } from '../../domain/task.js';
import {
  MAX_EVENT_TITLE_LENGTH, MAX_EVENT_NOTES_LENGTH, MAX_TRAVEL_MINUTES, MAX_PREPARATION_MINUTES,
  MAX_PLACE_ARRIVAL_BUFFER_MINUTES, MAX_OVERHEAD_MINUTES
} from '../../domain/dailyLife.js';
import { MAX_EVENT_LOCATION_LENGTH, MAX_EVENT_DURATION_MINUTES } from '../../domain/calendarEvent.js';
import { isoWeekdayOf } from '../../domain/calendar.js';

/** Paikkavalinnan arvo "Muu paikka" (vapaa teksti). Ei voi olla tallennetun paikan tunniste. */
export const OTHER_PLACE = '__muu__';

/** Lomakkeen kentät järjestyksessä: ensimmäinen virheellinen saa fokuksen. */
const FIELD_ORDER = Object.freeze([
  'ceTitle', 'ceDate', 'ceStart', 'ceEnd', 'ceDuration', 'ceLocation',
  'ceTravel', 'cePrep', 'ceEarly', 'ceOverhead', 'ceUntil', 'ceNotes'
]);

/** Domainin virhekenttä -> lomakkeen kenttä. */
const DOMAIN_FIELDS = Object.freeze({
  title: 'ceTitle', date: 'ceDate', startTime: 'ceStart', endTime: 'ceEnd',
  durationMinutes: 'ceDuration', locationText: 'ceLocation', travelMinutes: 'ceTravel',
  preparationMinutes: 'cePrep', arrivalBufferMinutes: 'ceEarly', overheadMinutes: 'ceOverhead',
  recurrenceUntil: 'ceUntil', notes: 'ceNotes'
});

const WEEKDAYS = Object.freeze([1, 2, 3, 4, 5, 6, 7]);

const WEEKDAY_ADESSIVE = Object.freeze({
  1: 'maanantaina', 2: 'tiistaina', 3: 'keskiviikkona', 4: 'torstaina',
  5: 'perjantaina', 6: 'lauantaina', 7: 'sunnuntaina'
});

/**
 * Lomakkeen tila tämän moduulin sisällä: mitä muokataan ja mistä lomake
 * avattiin (fokus palaa sinne suljettaessa).
 */
let editing = { eventId: null, occurrenceDate: null, opener: null };

// ------------------------------------------------------------ tarkistus (puhdas)

/** Kokonaisluku minuutteina tai virhe. Tyhjä = ei asetettu (null), ei nolla. */
function minutesField(text, min, max, message) {
  const trimmed = String(text ?? '').trim();
  if (trimmed === '') return { value: null };
  if (!/^\d+$/.test(trimmed)) return { error: message };
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value < min || value > max) return { error: message };
  return { value };
}

function dayMonth(dateIso) {
  const [, month, day] = dateIso.split('-').map(Number);
  return `${day}.${month}.`;
}

/**
 * Tarkista lomakkeen raakasyöte ja muunna se tallennettavaksi menoksi.
 *
 * @param {object} raw readEventForm()-muotoinen syöte (tekstit ja totuusarvot)
 * @returns {{valid:boolean, errors:Record<string,string>, value:object|null}}
 *          errors: kentän tunniste -> suomenkielinen viesti
 */
export function validateEventForm(raw = {}) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const errors = {};

  const title = String(input.title ?? '').trim().replace(/\s+/g, ' ');
  if (!title) errors.ceTitle = 'Anna menolle nimi.';
  else if (title.length > MAX_EVENT_TITLE_LENGTH) {
    errors.ceTitle = `Nimi on liian pitkä (enintään ${MAX_EVENT_TITLE_LENGTH} merkkiä).`;
  }

  const date = String(input.date ?? '').trim();
  if (!isIsoDate(date)) errors.ceDate = 'Valitse päivä.';

  const allDay = input.allDay === true;
  const start = String(input.start ?? '').trim();
  const end = String(input.end ?? '').trim();
  let duration = { value: null };
  if (!allDay) {
    if (!isTimeOfDay(start)) errors.ceStart = 'Anna alkamisaika tai valitse Koko päivä.';
    if (end && !isTimeOfDay(end)) errors.ceEnd = 'Anna päättymisaika muodossa tt:mm.';
    else if (end && end === start) errors.ceEnd = 'Päättymisaika on sama kuin alkamisaika.';
    duration = minutesField(input.duration, 1, MAX_EVENT_DURATION_MINUTES,
      `Anna kesto minuutteina (1–${MAX_EVENT_DURATION_MINUTES}).`);
    if (duration.error) errors.ceDuration = duration.error;
    else if (end && duration.value !== null) {
      errors.ceDuration = 'Anna joko päättymisaika tai kesto, ei molempia.';
    }
  }

  const place = String(input.place ?? '');
  const location = String(input.location ?? '').trim().replace(/\s+/g, ' ');
  if (place === OTHER_PLACE) {
    if (!location) errors.ceLocation = 'Kirjoita paikan nimi tai valitse "Ei paikkaa".';
    else if (location.length > MAX_EVENT_LOCATION_LENGTH) {
      errors.ceLocation = `Paikan nimi on liian pitkä (enintään ${MAX_EVENT_LOCATION_LENGTH} merkkiä).`;
    }
  }

  const travel = minutesField(input.travel, 1, MAX_TRAVEL_MINUTES,
    `Anna matka-aika minuutteina (1–${MAX_TRAVEL_MINUTES}).`);
  const preparation = minutesField(input.preparation, 0, MAX_PREPARATION_MINUTES,
    `Anna valmistautumisaika minuutteina (0–${MAX_PREPARATION_MINUTES}).`);
  const early = minutesField(input.early, 0, MAX_PLACE_ARRIVAL_BUFFER_MINUTES,
    `Anna etuaika minuutteina (0–${MAX_PLACE_ARRIVAL_BUFFER_MINUTES}).`);
  const overhead = minutesField(input.overhead, 0, MAX_OVERHEAD_MINUTES,
    `Anna pysäköinti ja kävely minuutteina (0–${MAX_OVERHEAD_MINUTES}).`);
  if (travel.error) errors.ceTravel = travel.error;
  if (preparation.error) errors.cePrep = preparation.error;
  if (early.error) errors.ceEarly = early.error;
  if (overhead.error) errors.ceOverhead = overhead.error;

  const weekdays = [...new Set((Array.isArray(input.weekdays) ? input.weekdays : [])
    .map(Number).filter(day => Number.isInteger(day) && day >= 1 && day <= 7))].sort((a, b) => a - b);
  const untilText = String(input.until ?? '').trim();
  let until = null;
  if (weekdays.length > 0 && untilText) {
    if (!isIsoDate(untilText)) errors.ceUntil = 'Valitse päivä, johon toisto päättyy.';
    else if (isIsoDate(date) && untilText < date) errors.ceUntil = 'Toisto ei voi päättyä ennen ensimmäistä kertaa.';
    else until = untilText;
  }

  const notes = String(input.notes ?? '').trim();
  if (notes.length > MAX_EVENT_NOTES_LENGTH) {
    errors.ceNotes = `Muistiinpano on liian pitkä (enintään ${MAX_EVENT_NOTES_LENGTH} merkkiä).`;
  }

  const mode = TRAVEL_MODES.includes(input.mode) ? input.mode : null;
  const valid = Object.keys(errors).length === 0;
  if (!valid) return { valid, errors, value: null };

  const value = {
    title,
    date,
    allDay,
    startTime: allDay ? null : start,
    endTime: allDay || !end ? null : end,
    durationMinutes: allDay ? null : duration.value,
    placeId: place && place !== OTHER_PLACE ? place : null,
    locationText: place === OTHER_PLACE ? location : null,
    travelMode: mode,
    travelMinutes: travel.value,
    preparationMinutes: preparation.value,
    arrivalBufferMinutes: early.value,
    overheadMinutes: overhead.value,
    recurrenceWeekdays: weekdays,
    recurrenceUntil: until,
    category: normalizeCategory(input.category),
    notes: notes || null
  };
  if (input.id) value.id = String(input.id);
  return { valid, errors, value };
}

/** Domainin virheet lomakkeen kenttiin; tuntematon kenttä -> otsikko. */
export function formErrorsOf(domainErrors = {}) {
  const errors = {};
  for (const [field, message] of Object.entries(domainErrors || {})) {
    const target = DOMAIN_FIELDS[field] || 'ceTitle';
    if (!errors[target]) errors[target] = String(message);
  }
  return errors;
}

// ------------------------------------------------------------ DOM: täyttö ja luku

function placeOptionsHtml(places, selected) {
  const sorted = [...places].sort((a, b) => String(a.name).localeCompare(String(b.name), 'fi')
    || String(a.id).localeCompare(String(b.id), 'fi'));
  const options = ['<option value="">Ei paikkaa</option>'];
  for (const place of sorted) {
    options.push(`<option value="${escapeHtml(place.id)}"${place.id === selected ? ' selected' : ''}>`
      + `${escapeHtml(place.name)}</option>`);
  }
  options.push(`<option value="${OTHER_PLACE}"${selected === OTHER_PLACE ? ' selected' : ''}>Muu paikka</option>`);
  return options.join('');
}

function modeOptionsHtml(selected, place) {
  const first = place
    ? `Paikan mukaan (${travelModeLabel(place.travelMode).toLowerCase()})`
    : 'Ei valittu (autolla)';
  return [`<option value="">${escapeHtml(first)}</option>`,
    ...TRAVEL_MODES.map(mode => `<option value="${mode}"${mode === selected ? ' selected' : ''}>`
      + `${escapeHtml(travelModeLabel(mode))}</option>`)].join('');
}

function categoryOptionsHtml(selected) {
  return CATEGORIES.map(category => `<option value="${escapeHtml(category.key)}"`
    + `${category.key === selected ? ' selected' : ''}>${escapeHtml(category.label)}</option>`).join('');
}

function numberText(value) {
  return Number.isInteger(value) ? String(value) : '';
}

function selectedPlace() {
  const value = el('cePlace').value;
  return value && value !== OTHER_PLACE ? findSavedPlace(value) : null;
}

/**
 * Paikan ja kulkutavan oletukset näkyviin: vihje tekstinä ja kenttien
 * paikkateksteinä. Arvoja ei kopioida menolle (ks. otsikkokommentti).
 */
function syncPlaceDefaults() {
  const placeValue = el('cePlace').value;
  const place = selectedPlace();
  const modeSelect = el('ceMode');
  const chosenMode = modeSelect.value;
  modeSelect.innerHTML = modeOptionsHtml(chosenMode, place);
  modeSelect.value = chosenMode;

  const mode = TRAVEL_MODES.includes(chosenMode) ? chosenMode
    : (place && TRAVEL_MODES.includes(place.travelMode) ? place.travelMode : TRAVEL_MODE.DRIVING);
  const defaults = DEFAULT_BUFFERS[mode] || DEFAULT_BUFFERS[TRAVEL_MODE.DRIVING];
  const settings = currentLifeSettings(getState());
  const pick = (own, fallback) => (Number.isInteger(own) ? own : fallback);
  const preparation = pick(place && place.preparationMinutes, defaults.preparation);
  const early = pick(place && place.arrivalBufferMinutes, settings.arrivalBufferMinutes);
  const overhead = pick(place && place.overheadMinutes, defaults.arrival);
  const travel = place && Number.isInteger(place.usualTravelMinutes) ? place.usualTravelMinutes : null;

  el('ceTravel').setAttribute('placeholder', travel !== null ? `paikan arvio ${travel}` : 'esim. 20');
  el('cePrep').setAttribute('placeholder', `oletus ${preparation}`);
  el('ceEarly').setAttribute('placeholder', `oletus ${early}`);
  el('ceOverhead').setAttribute('placeholder', `oletus ${overhead}`);

  let hint = '';
  if (place) {
    hint = `Oletukset paikasta ${place.name}: matka ${travel !== null ? `${travel} min` : 'ei arviota'}, `
      + `valmistautuminen ${preparation} min, etuaika ${early} min, pysäköinti ja kävely ${overhead} min. `
      + 'Täytä kenttä vain, jos tämä meno poikkeaa.';
  } else if (placeValue === OTHER_PLACE) {
    hint = 'Kirjoita paikka alle. Lähtöaika lasketaan, kun kerrot matka-ajan.';
  }
  setText('cePlaceHint', hint);
  toggle('cePlaceHint', Boolean(hint));
  toggle('ceLocationGroup', placeValue === OTHER_PLACE);
}

function syncAllDay() {
  toggle('ceTimeRow', !el('ceAllDay').checked, 'flex');
}

function checkedWeekdays() {
  return WEEKDAYS.filter(day => el(`ceRepeat${day}`).checked);
}

function syncRepeat() {
  toggle('ceUntilGroup', checkedWeekdays().length > 0);
}

/** Lomakkeen raakasyöte (tekstit ja totuusarvot) validateEventForm-funktiolle. */
export function readEventForm() {
  return {
    id: editing.eventId,
    title: el('ceTitle').value,
    date: el('ceDate').value,
    allDay: el('ceAllDay').checked,
    start: el('ceStart').value,
    end: el('ceEnd').value,
    duration: el('ceDuration').value,
    place: el('cePlace').value,
    location: el('ceLocation').value,
    mode: el('ceMode').value,
    travel: el('ceTravel').value,
    preparation: el('cePrep').value,
    early: el('ceEarly').value,
    overhead: el('ceOverhead').value,
    weekdays: checkedWeekdays(),
    until: el('ceUntil').value,
    category: el('ceCategory').value,
    notes: el('ceNotes').value
  };
}

function clearFieldErrors() {
  for (const id of FIELD_ORDER) {
    const error = maybe(`${id}Error`);
    if (error) {
      error.textContent = '';
      error.style.display = 'none';
    }
    const input = maybe(id);
    if (input) {
      input.classList.remove('invalid');
      input.removeAttribute('aria-invalid');
    }
  }
}

/** Näytä kenttävirheet ja siirrä fokus ensimmäiseen virheelliseen kenttään. */
export function showFieldErrors(errors = {}) {
  clearFieldErrors();
  let first = null;
  for (const id of FIELD_ORDER) {
    const message = errors[id];
    if (!message) continue;
    const input = maybe(id);
    const error = maybe(`${id}Error`);
    if (input) {
      input.classList.add('invalid');
      input.setAttribute('aria-invalid', 'true');
    }
    if (error) {
      error.textContent = message;
      error.style.display = 'block';
    }
    if (!first && input) first = input;
  }
  if (first) first.focus();
  return first;
}

function fillForm(event, { date, occurrenceDate }) {
  const state = getState();
  const placeValue = event
    ? (event.placeId && findSavedPlace(event.placeId) ? event.placeId : (event.locationText ? OTHER_PLACE : ''))
    : '';
  el('cePlace').innerHTML = placeOptionsHtml(state.savedPlaces || [], placeValue);
  el('cePlace').value = placeValue;
  el('ceMode').innerHTML = modeOptionsHtml(event ? event.travelMode : '', null);
  el('ceMode').value = event && event.travelMode ? event.travelMode : '';
  el('ceCategory').innerHTML = categoryOptionsHtml(event ? event.category : DEFAULT_CATEGORY);
  el('ceCategory').value = event ? normalizeCategory(event.category) : DEFAULT_CATEGORY;

  el('ceTitle').value = event ? event.title || '' : '';
  el('ceDate').value = event ? event.date || '' : (isIsoDate(date) ? date : '');
  el('ceAllDay').checked = event ? event.allDay === true : false;
  el('ceStart').value = event && event.startTime ? event.startTime : '';
  el('ceEnd').value = event && event.endTime ? event.endTime : '';
  el('ceDuration').value = event && !event.endTime ? numberText(event.durationMinutes) : '';
  el('ceLocation').value = event && event.locationText ? event.locationText : '';
  el('ceTravel').value = event ? numberText(event.travelMinutes) : '';
  el('cePrep').value = event ? numberText(event.preparationMinutes) : '';
  el('ceEarly').value = event ? numberText(event.arrivalBufferMinutes) : '';
  el('ceOverhead').value = event ? numberText(event.overheadMinutes) : '';
  const weekdays = new Set(event && Array.isArray(event.recurrenceWeekdays) ? event.recurrenceWeekdays : []);
  for (const day of WEEKDAYS) el(`ceRepeat${day}`).checked = weekdays.has(day);
  el('ceUntil').value = event && event.recurrenceUntil ? event.recurrenceUntil : '';
  el('ceNotes').value = event && event.notes ? event.notes : '';

  const recurring = Boolean(event) && weekdays.size > 0;
  const canSkip = recurring && isIsoDate(occurrenceDate);
  setText('calFormTitle', event ? 'Muokkaa menoa' : 'Uusi meno');
  toggle('ceDelete', Boolean(event), 'block');
  toggle('ceSkip', canSkip, 'block');
  const note = recurring
    ? `Toistuva meno. Muutokset koskevat kaikkia kertoja.${canSkip ? ` Voit myös ohittaa vain kerran ${dayMonth(occurrenceDate)}.` : ''}`
    : '';
  setText('calFormNote', note);
  toggle('calFormNote', Boolean(note));

  syncAllDay();
  syncRepeat();
  syncPlaceDefaults();
  clearFieldErrors();
}

// ------------------------------------------------------------ avaus ja sulku

function isOpen() {
  const form = maybe('calEventForm');
  return Boolean(form) && form.style.display !== 'none';
}

/**
 * Avaa lomake.
 *
 * @param {object} [options]
 * @param {string} [options.eventId]        muokattava meno; puuttuu = uusi
 * @param {string} [options.occurrenceDate] toistuvan menon kerta, josta lomake avattiin
 * @param {string} [options.date]           uuden menon päivä
 * @param {string} [options.focusField]     fokusoitava kenttä (oletus otsikko)
 * @param {Element} [options.opener]        fokus palaa tähän suljettaessa
 * @returns {boolean} avautuiko
 */
export function openEventForm({
  eventId = null, occurrenceDate = null, date = null, focusField = 'ceTitle', opener = null
} = {}) {
  const event = eventId ? findCalendarEvent(eventId) : null;
  if (eventId && !event) return false;
  editing = {
    eventId: event ? event.id : null,
    occurrenceDate: event && isIsoDate(occurrenceDate) ? occurrenceDate : null,
    opener: opener || (typeof document !== 'undefined' ? document.activeElement : null)
  };
  fillForm(event, { date, occurrenceDate: editing.occurrenceDate });
  toggle('calEventForm', true, 'flex');
  toggle('calNewEvent', false, 'flex');
  const form = el('calEventForm');
  if (typeof form.scrollIntoView === 'function') form.scrollIntoView({ block: 'start' });
  const target = maybe(focusField) || maybe('ceTitle');
  if (target) target.focus();
  return true;
}

function focusAfterClose(opener, eventId) {
  if (opener && opener.isConnected !== false && typeof opener.focus === 'function'
    && !(typeof opener.closest === 'function' && opener.closest('[inert], [hidden]'))) {
    opener.focus();
    if (typeof document === 'undefined' || document.activeElement === opener) return;
  }
  // Avaaja katosi uudelleenpiirrossa: saman menon rivi, muuten "Uusi meno".
  if (eventId) {
    for (const container of [maybe('calDayAgenda'), maybe('calWeekEvents')]) {
      if (!container || typeof container.querySelectorAll !== 'function') continue;
      const row = [...container.querySelectorAll('[data-cal-open]')].find(node => node.dataset.calOpen === eventId);
      if (row) {
        row.focus();
        return;
      }
    }
  }
  const fallback = maybe('calNewEvent');
  if (fallback) fallback.focus();
}

/**
 * Sulje lomake. `restoreFocus: false` uloskirjautumisessa: fokusta ei
 * siirretä näkymään, joka on jo piilossa.
 */
export function closeEventForm({ restoreFocus = true } = {}) {
  const { opener, eventId } = editing;
  editing = { eventId: null, occurrenceDate: null, opener: null };
  if (!maybe('calEventForm')) return;
  clearFieldErrors();
  toggle('calEventForm', false);
  toggle('calNewEvent', true, 'flex');
  if (restoreFocus) focusAfterClose(opener, eventId);
}

/** Uloskirjautuminen: lomake kiinni ja tyhjäksi, ettei edellisen käyttäjän meno jää näkyviin. */
export function resetEventForm() {
  editing = { eventId: null, occurrenceDate: null, opener: null };
  if (!maybe('calEventForm')) return;
  for (const id of ['ceTitle', 'ceDate', 'ceStart', 'ceEnd', 'ceDuration', 'ceLocation', 'ceTravel',
    'cePrep', 'ceEarly', 'ceOverhead', 'ceUntil', 'ceNotes']) {
    const field = maybe(id);
    if (field) field.value = '';
  }
  for (const day of WEEKDAYS) {
    const box = maybe(`ceRepeat${day}`);
    if (box) box.checked = false;
  }
  const allDay = maybe('ceAllDay');
  if (allDay) allDay.checked = false;
  const place = maybe('cePlace');
  if (place) place.innerHTML = '';
  clearFieldErrors();
  toggle('calEventForm', false);
  toggle('calNewEvent', true, 'flex');
}

/** Muokattava meno ja kerta (testit ja näkymä). */
export function editingEvent() {
  return { eventId: editing.eventId, occurrenceDate: editing.occurrenceDate, open: isOpen() };
}

// ------------------------------------------------------------ toiminnot

/** Uusi meno näkyviin: kalenteri siirtyy sen päivälle. */
function revealDate(dateIso) {
  if (!isIsoDate(dateIso)) return;
  const state = getState();
  if (state.calendarView === 'week') setWeekStart(startOfWeek(parseISO(dateIso)));
  else setCalendarDate(dateIso);
}

/** Tallenna. Palauttaa tuloksen (testit); virheet näytetään lomakkeella. */
export const submitEventForm = singleFlight(async () => {
  const { valid, errors, value } = validateEventForm(readEventForm());
  if (!valid) {
    showFieldErrors(errors);
    return { ok: false, errors };
  }
  const isNew = !editing.eventId;
  const button = el('ceSave');
  setBusy(button, true, 'Tallennetaan…');
  let result;
  try {
    result = await saveCalendarEvent(value);
  } finally {
    setBusy(button, false);
  }
  if (result && result.ok) {
    closeEventForm();
    success(isNew ? 'Meno lisätty kalenteriin.' : 'Muutokset tallennettu.');
    if (isNew) revealDate(result.event.date);
    return result;
  }
  // Tallennusvirhe on jo kerrottu (dailyLifeActions: showError). Lomake jää
  // auki syötteineen, jotta tallennuksen voi yrittää uudelleen.
  if (result && result.errors) showFieldErrors(formErrorsOf(result.errors));
  return result || { ok: false };
});

/** Poista koko meno (kysyy vahvistuksen dailyLifeActionsissa). */
export const deleteEditedEvent = singleFlight(async () => {
  const eventId = editing.eventId;
  if (!eventId) return { ok: false };
  const button = el('ceDelete');
  setBusy(button, true);
  let result;
  try {
    result = await deleteCalendarEvent(eventId);
  } finally {
    setBusy(button, false);
  }
  if (result && result.ok) {
    closeEventForm();
    success('Meno poistettu.');
  }
  return result || { ok: false };
});

/** Ohita toistuvan menon yksi kerta. Muut kerrat pysyvät ennallaan. */
export const skipEditedOccurrence = singleFlight(async ({ confirm = confirmAction } = {}) => {
  const { eventId, occurrenceDate } = editing;
  const event = eventId ? findCalendarEvent(eventId) : null;
  if (!event || !isIsoDate(occurrenceDate)) return { ok: false };
  const confirmed = await confirm({
    title: 'Ohitetaanko tämä kerta?',
    message: `"${event.title}" jää pois ${WEEKDAY_ADESSIVE[isoWeekdayOf(occurrenceDate)]} ${dayMonth(occurrenceDate)} `
      + 'Muut kerrat pysyvät ennallaan.',
    confirmLabel: 'Ohita tämä kerta',
    cancelLabel: 'Peruuta'
  });
  if (!confirmed) return { ok: false, cancelled: true };
  const button = el('ceSkip');
  setBusy(button, true);
  let result;
  try {
    result = await skipEventOccurrence(eventId, occurrenceDate);
  } finally {
    setBusy(button, false);
  }
  if (result && result.ok) {
    closeEventForm();
    success(`Kerta ${dayMonth(occurrenceDate)} ohitettu.`);
  }
  return result || { ok: false };
});

/** Kytke lomakkeen kuuntelijat kerran (initCalendar kutsuu). */
export function initEventForm() {
  el('ceSave').addEventListener('click', () => { submitEventForm(); });
  el('ceCancel').addEventListener('click', () => closeEventForm());
  el('ceDelete').addEventListener('click', () => { deleteEditedEvent(); });
  el('ceSkip').addEventListener('click', () => { skipEditedOccurrence(); });
  el('ceAllDay').addEventListener('change', syncAllDay);
  el('cePlace').addEventListener('change', syncPlaceDefaults);
  el('ceMode').addEventListener('change', syncPlaceDefaults);
  el('ceRepeatDays').addEventListener('change', syncRepeat);
  el('calEventForm').addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeEventForm();
      return;
    }
    // Enter otsikossa tallentaa, kuten tehtävälomakkeessa.
    if (event.key === 'Enter' && event.target && event.target.id === 'ceTitle') {
      event.preventDefault();
      submitEventForm();
    }
  });
}

/**
 * Uuden menon oletuspäivä: katsottava päivä. Viikkonäkymässä tämä päivä,
 * jos se on katsotulla viikolla, muuten viikon maanantai.
 */
export function defaultEventDate(state = getState(), todayIso = fmtISO(todayMidnight())) {
  if (state.calendarView === 'week') {
    const monday = fmtISO(state.weekStart);
    const sunday = fmtISO(addDays(state.weekStart, 6));
    return todayIso >= monday && todayIso <= sunday ? todayIso : monday;
  }
  return isIsoDate(state.calendarDate) ? state.calendarDate : todayIso;
}
