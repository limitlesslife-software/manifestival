// Muistutusnäkymä.
//
// =====================================================================
// MITÄ TÄMÄ NÄKYMÄ EI LUPAA
// =====================================================================
//
// Muistutus lasketaan silloin kun sovellus on auki. Taustaherätystä ei
// ole eikä sitä voi luvata ilman laitehyväksyntää — ja lupaus, jota ei
// voi pitää, on pahempi kuin puuttuva ominaisuus.
//
// Näkymä sanoo tämän ääneen yhdellä rivillä. Käyttäjä, joka luulee
// saavansa hälytyksen suljetusta sovelluksesta, jättää tekemättä sen
// mitä oli tekemässä.
//
// =====================================================================
// KAKSI ASIAA, JOTKA NÄYTETÄÄN ERIKSEEN
// =====================================================================
//
//   PERUTTU  näkyy listassa päätetilassa. Orpo muistutus perutaan
//            näkyvästi eikä poisteta hiljaa, koska käyttäjän pitää
//            saada tietää mitä hänen poistonsa aiheutti.
//
//   TORKUTUS ei siirrä kohteen määräaikaa. Domain takaa sen; näkymä
//            sanoo sen, jottei käyttäjä oleta toisin.

import { el, maybe, toggle, setText, focus } from '../../ui/dom.js';
import { escapeHtml } from '../../lib/format.js';
import { fmtISO, todayMidnight } from '../../lib/datetime.js';
import { getState, findReminder, setEditingReminderId } from '../state.js';
import {
  REMINDER_STATUS, REMINDER_TARGET, TRIGGER, SNOOZE_OPTIONS,
  MAX_ALERTS_PER_REMINDER, reminderStatusLabel, compareReminders,
  summarizeReminders, liveReminders, isOrphaned
} from '../../domain/reminder.js';
import { hasTable, isTableAvailable } from '../../data/schema.js';
import { serverUnavailableHintHtml } from '../schemaStatus.js';
import { background } from '../../platform/index.js';
import {
  createReminder, editReminder, deleteReminder, snoozeReminderBy,
  acknowledgeReminder, completeReminder, cancelReminderById
} from '../assistantActions.js';

/** Näytetäänkö päättyneet? Näkymän oma tila. */
let showClosed = false;

// =====================================================================
// LISTA
// =====================================================================

function statusTone(reminder) {
  if (reminder.status === REMINDER_STATUS.CANCELLED
    || reminder.status === REMINDER_STATUS.EXPIRED) return '';
  if (reminder.alertCount >= MAX_ALERTS_PER_REMINDER) return 'tone-late';
  if (reminder.status === REMINDER_STATUS.DELIVERED
    || reminder.status === REMINDER_STATUS.DUE) return 'tone-warn';
  return '';
}

function isClosed(reminder) {
  return reminder.status === REMINDER_STATUS.COMPLETED
    || reminder.status === REMINDER_STATUS.CANCELLED
    || reminder.status === REMINDER_STATUS.EXPIRED;
}

function whenLine(reminder) {
  if (!reminder.dueDate && !reminder.dueTime) {
    return '<span class="assist-unknown">Ajankohtaa ei ole asetettu</span>';
  }
  const paiva = reminder.dueDate ? escapeHtml(reminder.dueDate) : '';
  const kello = reminder.dueTime ? ` klo ${escapeHtml(reminder.dueTime)}` : '';
  const raja = reminder.untilTime
    ? ` · enintään klo ${escapeHtml(reminder.untilTime)}`
    : '';
  return `${paiva}${kello}${raja}`;
}

function targetLine(reminder, state) {
  if (reminder.targetType === REMINDER_TARGET.STANDALONE) return '';

  const orpo = isOrphaned(reminder, { task: state.tasks });
  if (orpo) {
    return '<div class="assist-reason">Kohdetta ei enää ole. '
      + 'Muistutus perutaan seuraavalla tarkistuksella.</div>';
  }

  const task = state.tasks.find(t => t.id === reminder.targetId);
  if (!task) return '';
  return `<div class="assist-reason">Liittyy tehtävään: ${escapeHtml(task.title)}</div>`;
}

function countLine(reminder) {
  const osat = [];
  if (reminder.alertCount > 0) {
    osat.push(`hälytetty ${reminder.alertCount}/${MAX_ALERTS_PER_REMINDER}`);
  }
  if (reminder.snoozeCount > 0) osat.push(`torkutettu ${reminder.snoozeCount}×`);
  if (reminder.escalate) osat.push('porrastettu');
  return osat.length ? ` · ${escapeHtml(osat.join(', '))}` : '';
}

function actionsHtml(reminder) {
  if (isClosed(reminder)) {
    return `<button class="assist-btn danger" data-reminder-delete="${escapeHtml(reminder.id)}">Poista</button>`;
  }

  const napit = [
    `<button class="assist-btn primary" data-reminder-done="${escapeHtml(reminder.id)}">Hoidettu</button>`
  ];

  if (reminder.status === REMINDER_STATUS.DUE
    || reminder.status === REMINDER_STATUS.DELIVERED) {
    napit.push(`<button class="assist-btn" data-reminder-ack="${escapeHtml(reminder.id)}">Kuittaa</button>`);
    for (const minutes of SNOOZE_OPTIONS) {
      napit.push(`<button class="assist-btn" data-reminder-snooze="${escapeHtml(reminder.id)}"`
        + ` data-minutes="${minutes}">+${minutes} min</button>`);
    }
  }

  napit.push(`<button class="assist-btn" data-reminder-edit="${escapeHtml(reminder.id)}">Muokkaa</button>`);
  napit.push(`<button class="assist-btn" data-reminder-cancel="${escapeHtml(reminder.id)}">Peru</button>`);

  return napit.join('');
}

function rowHtml(reminder, state) {
  const closed = isClosed(reminder);

  return `
    <div class="assist-row${closed ? ' is-closed' : ''}">
      <div class="assist-title">${escapeHtml(reminder.title)}</div>
      <div class="assist-meta">
        <span class="assist-tag ${statusTone(reminder)}">${escapeHtml(reminderStatusLabel(reminder.status))}</span>
        ${whenLine(reminder)}${countLine(reminder)}
      </div>
      ${targetLine(reminder, state)}
      ${reminder.note ? `<div class="assist-reason">${escapeHtml(reminder.note)}</div>` : ''}
      <div class="assist-actions">${actionsHtml(reminder)}</div>
    </div>`;
}

function emptyHtml() {
  return `
    <div class="assist-empty">
      Ei muistutuksia. Lisää muistutus, kun haluat että jokin asia
      palaa mieleen tiettynä hetkenä.
    </div>`;
}

/**
 * Rehellinen rivi taustaherätyksestä.
 *
 * Luetaan sovittimelta eikä kirjoiteta käsin: jos natiivikuori joskus
 * tukee taustaherätystä, tämä rivi muuttuu itsestään.
 */
function backgroundNoteHtml() {
  const capability = background.capability();
  const tuettu = capability && capability.state === 'available';

  if (tuettu) return '';

  return `
    <p class="hint">
      <strong>Muistutukset lasketaan, kun sovellus on auki.</strong>
      Tällä alustalla hälytystä ei voi luvata suljetusta sovelluksesta,
      eikä sitä siksi luvata.
    </p>`;
}

// =====================================================================
// RENDERÖINTI
// =====================================================================

export function renderReminders() {
  const container = maybe('remindersListContainer');
  if (!container) return;

  const state = getState();
  const kaikki = [...state.reminders].sort(compareReminders);
  const naytettavat = showClosed ? kaikki : kaikki.filter(r => !isClosed(r));
  const summary = summarizeReminders(kaikki);

  const otsikko = `
    <h2 class="section-title">
      Muistutukset
      ${summary.live > 0 ? `<span class="notice-badge">${summary.live}</span>` : ''}
    </h2>`;

  const varoitus = isTableAvailable('reminders')
    ? ''
    : hasTable('reminders')
      ? serverUnavailableHintHtml()
      : `<p class="hint"><strong>Huom.</strong> Muistutukset säilyvät `
        + `toistaiseksi vain tämän istunnon ajan.</p>`;

  const suodatin = kaikki.length > naytettavat.length || showClosed
    ? `<div class="assist-actions"><button class="assist-btn" id="remindersToggleClosed" type="button">`
      + `${showClosed ? 'Piilota päättyneet' : 'Näytä päättyneet'}</button></div>`
    : '';

  container.innerHTML = otsikko + backgroundNoteHtml() + varoitus
    + (naytettavat.length === 0 ? emptyHtml() : naytettavat.map(r => rowHtml(r, state)).join(''))
    + suodatin;
}

// =====================================================================
// LOMAKE
// =====================================================================

function clearErrors() {
  document.querySelectorAll('#reminderForm .field-error').forEach(node => {
    node.textContent = '';
    node.style.display = 'none';
  });
}

function showErrors(errors) {
  for (const [field, message] of Object.entries(errors || {})) {
    const node = maybe(`rm${field.charAt(0).toUpperCase()}${field.slice(1)}Error`);
    if (node) {
      node.textContent = message;
      node.style.display = 'block';
    }
  }
}

/** Tehtävävalikko. Vain avoimet tehtävät: valmiille ei muistuteta. */
function fillTaskSelect(selected) {
  const select = maybe('rmTask');
  if (!select) return;

  const tasks = getState().tasks.filter(t => !t.completed);
  select.innerHTML = '<option value="">Ei liitosta</option>'
    + tasks.map(t => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.title)}</option>`).join('');
  select.value = selected || '';
}

export function openReminderForm(id = null) {
  const reminder = id ? findReminder(id) : null;

  setEditingReminderId(id);
  clearErrors();

  setText('reminderFormTitle', reminder ? 'Muokkaa muistutusta' : 'Uusi muistutus');
  el('rmTitle').value = reminder ? reminder.title : '';
  el('rmDate').value = (reminder && reminder.dueDate) || fmtISO(todayMidnight());
  el('rmTime').value = (reminder && reminder.dueTime) || '';
  el('rmUntil').value = (reminder && reminder.untilTime) || '';
  el('rmEscalate').checked = Boolean(reminder && reminder.escalate);
  el('rmNote').value = (reminder && reminder.note) || '';

  fillTaskSelect(reminder && reminder.targetType === REMINDER_TARGET.TASK
    ? reminder.targetId : '');

  toggle('rmDelete', Boolean(reminder));
  toggle('reminderForm', true);
  toggle('addReminderBtn', false);
  focus('rmTitle');
}

export function closeReminderForm() {
  setEditingReminderId(null);
  clearErrors();
  toggle('reminderForm', false);
  toggle('addReminderBtn', true);
}

function formValues() {
  const taskId = el('rmTask').value || null;

  return {
    title: el('rmTitle').value,
    // KOHDELAJI JA TUNNISTE KULKEVAT PARINA. Tyhjä valinta tarkoittaa
    // vapaata muistutusta, ei tehtävää ilman tunnistetta.
    targetType: taskId ? REMINDER_TARGET.TASK : REMINDER_TARGET.STANDALONE,
    targetId: taskId,
    trigger: TRIGGER.AT_TIME,
    dueDate: el('rmDate').value || null,
    dueTime: el('rmTime').value || null,
    untilTime: el('rmUntil').value || null,
    escalate: el('rmEscalate').checked,
    note: el('rmNote').value || null
  };
}

async function submitForm() {
  clearErrors();

  const editingId = getState().editingReminderId;
  const values = formValues();

  const result = editingId
    ? await editReminder(editingId, values)
    : await createReminder(values);

  if (!result.ok) {
    if (result.errors) showErrors(result.errors);
    return;
  }
  closeReminderForm();
}

// =====================================================================
// TAPAHTUMAT
// =====================================================================

export function initReminderForm() {
  const add = maybe('addReminderBtn');
  if (add) add.addEventListener('click', () => openReminderForm(null));

  const cancel = maybe('rmCancel');
  if (cancel) cancel.addEventListener('click', closeReminderForm);

  const save = maybe('rmSave');
  if (save) save.addEventListener('click', submitForm);

  const remove = maybe('rmDelete');
  if (remove) {
    remove.addEventListener('click', async () => {
      const editingId = getState().editingReminderId;
      if (!editingId) return;
      if (await deleteReminder(editingId)) closeReminderForm();
    });
  }

  const title = maybe('rmTitle');
  if (title) {
    title.addEventListener('keydown', event => {
      if (event.key === 'Enter') { event.preventDefault(); submitForm(); }
    });
  }

  const form = maybe('reminderForm');
  if (form) {
    form.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); closeReminderForm(); }
    });
  }

  const list = maybe('remindersListContainer');
  if (list) list.addEventListener('click', onListClick);
}

async function onListClick(event) {
  const toggleClosed = event.target.closest('#remindersToggleClosed');
  if (toggleClosed) {
    showClosed = !showClosed;
    renderReminders();
    return;
  }

  const edit = event.target.closest('[data-reminder-edit]');
  if (edit) { openReminderForm(edit.dataset.reminderEdit); return; }

  const snooze = event.target.closest('[data-reminder-snooze]');
  if (snooze) {
    await snoozeReminderBy(snooze.dataset.reminderSnooze,
      Number(snooze.dataset.minutes));
    return;
  }

  const ack = event.target.closest('[data-reminder-ack]');
  if (ack) { await acknowledgeReminder(ack.dataset.reminderAck); return; }

  const done = event.target.closest('[data-reminder-done]');
  if (done) { await completeReminder(done.dataset.reminderDone); return; }

  const cancel = event.target.closest('[data-reminder-cancel]');
  if (cancel) { await cancelReminderById(cancel.dataset.reminderCancel); return; }

  const remove = event.target.closest('[data-reminder-delete]');
  if (remove) { await deleteReminder(remove.dataset.reminderDelete); }
}
