// Ajanseuranta ja nopea kirjaus: näkymä.
//
// Kolme osaa:
//
//   1. AJASTINPALKKI (#timerBar). Näkyy kaikissa näkymissä, kun ajastin on
//      käynnissä tai tauolla. Tila kerrotaan TEKSTINÄ ("Käynnissä",
//      "Tauolla"), ei vain värillä. Kulunut aika päivitetään näytölle
//      puolen minuutin välein — päivitys on pelkkää näyttöä: aika
//      lasketaan aina aikaleimoista (src/domain/timer.js), joten
//      taustalla olo tai lukittu näyttö ei vaikuta tulokseen.
//
//   2. KIRJAUSDIALOGI. "+15 min / +30 min / +1 h / Muu" muutamalla
//      napautuksella. Natiivi <dialog>: fokusloukku, Esc ja
//      ruudunlukijasemantiikka tulevat selaimelta. Dialogi sulkeutuu
//      ensimmäisestä valinnasta, ja kirjauksella on dialogikohtainen
//      operaatiotunniste, joten kaksoisnapautus ei tuota kahta riviä.
//      Pikavalinnat ovat type="button" (CRIT-04): Enter "Muu"-kentässä
//      lähettää lomakkeen ENSIMMÄISELLÄ submit-painikkeella, ja sen on
//      oltava "Kirjaa" — ei pikavalinta, joka kirjaisi 15 min.
//
//   3. VALMISTUMISEN KIRJAUS. Tehtävän valmistuessa kysytään "Kirjataanko
//      tähän käytetty aika?". Arvio EI kopioidu toteumaksi: käyttäjä voi
//      valita sen, ja painike sanoo sen ääneen ("hyväksyn arvion
//      toteumaksi").

import { maybe } from '../../ui/dom.js';
import { escapeHtml } from '../../lib/format.js';
import { fmtISO } from '../../lib/datetime.js';
import { confirmAction } from '../../ui/confirm.js';
import { showError, notify } from '../../ui/toast.js';
import { getState, findTask, findRoutine, findProject } from '../state.js';
import { getDevicePreference, setDevicePreference } from '../../data/preferences.js';
import { durationOf } from '../../domain/task.js';
import { formatMinutes, compareLifeAreas } from '../../domain/lifeArea.js';
import { timerStatus, formatElapsed, hasStopPlan } from '../../domain/timer.js';
import { TIMER_RULES } from '../../domain/alignmentPolicy.js';
import { OPERATION } from '../../domain/timeEntry.js';

import {
  currentTimer, startTracking, pauseTracking, resumeTracking, stopTracking, cancelTracking,
  logQuickTime, describeTarget, targetOfTimer, announceLogged, loggedMinutesForOccurrence,
  occurrenceOperationId, nowMs, newOperationId,
  pendingTimer, stopPendingTracking, discardPendingTracking
} from '../timeTracking.js';
import { setCompletionHook } from '../actions.js';

const DIALOG_ID = 'timeLogDialog';
const TICK_MS = 30 * 1000;
let tickHandle = null;

/** Ajastin vaihtui kesken (toinen laite tai välilehti): mitään ei kirjattu. */
const TIMER_CHANGED_MESSAGE = 'Ajastin muuttui toisella laitteella; tarkista uudelleen.';

// ------------------------------------------------------ ajastinpalkki

function stateLabel(state) {
  if (state === 'stopping') return 'Kirjaus kesken';
  return state === 'paused' ? 'Tauolla' : 'Käynnissä';
}

/**
 * Näytettävä tila. Kesken jäänyt pysäytys (osa ei tallentunut) näkyy
 * pysäytyshetken mukaan: kirjattava aika ei enää kasva.
 */
function displayStatus(timer, now) {
  if (!hasStopPlan(timer)) return timerStatus(timer, now);
  const status = timerStatus(timer, timer.stopAtMs);
  const seconds = Number.isInteger(timer.overrideMinutes) ? timer.overrideMinutes * 60 : status.elapsedSeconds;
  return { state: 'stopping', elapsedSeconds: seconds, clockSkew: false };
}

/** Kulunut aika sanoina ruudunlukijalle: "1 h 5 min". */
function spokenElapsed(seconds) {
  return formatMinutes(Math.floor(seconds / 60));
}

/**
 * Tämän laitteen kirjaamaton ajastus, joka jäi odottamaan, kun toisella
 * laitteella oli jo ajastin. Ei katoa hiljaa: käyttäjä kirjaa tai hylkää.
 */
function pendingHtml(pending, now) {
  const label = describeTarget(targetOfTimer(pending));
  const status = displayStatus(pending, now);
  return `
    <div class="timer-pending" role="group" aria-label="Kirjaamaton ajastus">
      <p class="hint">Tälle laitteelle jäi kirjaamaton ajastus: ${escapeHtml(label)}, ${escapeHtml(spokenElapsed(status.elapsedSeconds))}.
        Toisella laitteella oli samaan aikaan oma ajastin.</p>
      <div class="timer-actions">
        <button type="button" class="assist-btn primary" data-timer="pending-log">Tarkista ja kirjaa</button>
        <button type="button" class="assist-btn danger" data-timer="pending-discard" aria-label="Hylkää kirjaamaton ajastus">Hylkää</button>
      </div>
    </div>`;
}

export function renderTimerBar(now = nowMs()) {
  const bar = maybe('timerBar');
  if (!bar) return;
  const timer = currentTimer();
  const pending = pendingTimer();
  if (!timer && !pending) {
    bar.hidden = true;
    bar.innerHTML = '';
    return;
  }
  bar.hidden = false;
  if (!timer) {
    bar.classList.toggle('is-paused', false);
    bar.innerHTML = pendingHtml(pending, now);
    return;
  }
  const status = displayStatus(timer, now);
  const label = describeTarget(targetOfTimer(timer));
  bar.classList.toggle('is-paused', status.state === 'paused');
  const toggle = status.state === 'stopping' ? ''
    : status.state === 'paused'
      ? '<button type="button" class="assist-btn" data-timer="resume">Jatka</button>'
      : '<button type="button" class="assist-btn" data-timer="pause">Tauko</button>';
  const stopLabel = status.state === 'stopping' ? 'Yritä kirjausta uudelleen' : 'Pysäytä ja kirjaa';
  bar.innerHTML = `
    <div class="timer-info">
      <span class="timer-state">${escapeHtml(stateLabel(status.state))}</span>
      <span class="timer-target">${escapeHtml(label)}</span>
      <span class="timer-elapsed" id="timerElapsed" aria-hidden="true">${escapeHtml(formatElapsed(status.elapsedSeconds))}</span>
      <span class="visually-hidden" id="timerElapsedText">Kulunut ${escapeHtml(spokenElapsed(status.elapsedSeconds))}</span>
    </div>
    <div class="timer-actions">
      ${toggle}
      <button type="button" class="assist-btn primary" data-timer="stop">${stopLabel}</button>
      <button type="button" class="assist-btn danger" data-timer="cancel" aria-label="Hylkää ajastus kirjaamatta">Hylkää</button>
    </div>
    ${status.clockSkew ? '<p class="hint timer-skew">Laitteen kello on siirtynyt taaksepäin. Kulunutta aikaa ei näytetä negatiivisena.</p>' : ''}
    ${pending ? pendingHtml(pending, now) : ''}`;
}

/** Vain kuluneen ajan teksti; ei koske painikkeisiin (fokus säilyy). */
function tick() {
  const timer = currentTimer();
  const elapsed = maybe('timerElapsed');
  if (!timer || !elapsed) return;
  const status = displayStatus(timer, nowMs());
  elapsed.textContent = formatElapsed(status.elapsedSeconds);
  const spoken = maybe('timerElapsedText');
  if (spoken) spoken.textContent = `Kulunut ${spokenElapsed(status.elapsedSeconds)}`;
}

// ------------------------------------------------------------ dialogi

function dialogElement() {
  let dialog = document.getElementById(DIALOG_ID);
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.id = DIALOG_ID;
    dialog.className = 'confirm-dialog time-log-dialog';
    dialog.setAttribute('aria-labelledby', 'timeLogTitle');
    document.body.appendChild(dialog);
  }
  return dialog;
}

function areaSelectHtml() {
  const areas = [...getState().lifeAreas].filter(area => area.active).sort(compareLifeAreas);
  if (areas.length === 0) return '';
  return `<label class="field-label" for="timeLogArea">Elämänalue</label>
    <select id="timeLogArea"><option value="">Ei aluetta</option>
    ${areas.map(area => `<option value="${escapeHtml(area.id)}">${escapeHtml(area.name)}</option>`).join('')}</select>`;
}

/**
 * Avaa kirjausdialogi.
 *
 * @param {object} options
 * @param {object} options.target        { kind, id, occurrenceDate?, lifeAreaId? }
 * @param {string} options.title
 * @param {string} [options.message]
 * @param {Array<{minutes: number, label: string, hint?: string}>} [options.suggestions]
 * @param {boolean} [options.allowTimer]  näytä "Aloita ajastin"
 * @param {boolean} [options.chooseArea]  yleinen kirjaus: alueen valinta
 * @param {string} [options.operationId]
 * @param {string} [options.skipLabel]
 * @param {boolean} [options.offerMute]  "Älä kysy tätä tällä laitteella"
 * @param {boolean} [options.timerOnly]  vain alueen valinta ja "Aloita ajastin" (ei kirjausta)
 * @returns {Promise<{action: 'logged'|'timer'|'skip', result?: object}>}
 */
export function openTimeLogDialog(options) {
  const {
    target = { kind: 'none' }, title, message = '', suggestions = null, allowTimer = false,
    chooseArea = false, operationId = null, skipLabel = 'Peruuta', offerMute = false, entryDate = null,
    timerOnly = false
  } = options;
  const dialog = dialogElement();
  // Auki olevaa dialogia EI korvata: sen sulkeutuminen laukaisisi myös
  // edellisen kuuntelijan, ja aika kirjautuisi väärälle kohteelle.
  if (dialog.open) return Promise.resolve({ action: 'busy' });
  const presets = suggestions || TIMER_RULES.QUICK_MINUTES.map(minutes => ({ minutes, label: formatMinutes(minutes) }));
  // Dialogikohtainen tunniste: sama dialogi = sama kirjaus.
  const operation = operationId || newOperationId();
  const introHtml = message ? `<p class="confirm-message">${escapeHtml(message)}</p>` : '';

  // Pikavalinnat ovat type="button" ja sulkevat dialogin itse (CRIT-04).
  // Ennen ne olivat submit-painikkeita ENNEN "Kirjaa"-painiketta, joten
  // Enter "Muu"-kentässä (implisiittinen lähetys = ensimmäinen submit)
  // kirjasi 15 min kirjoitetun arvon sijaan. Nyt ensimmäinen submit on
  // "Kirjaa". value-attribuutti säilyy: se on painikkeen tunniste.
  const logControls = timerOnly ? '' : `
      <div class="time-log-presets" role="group" aria-label="Kirjattava aika">
        ${presets.map(preset => `<button type="button" class="form-btn secondary time-log-preset" value="m:${preset.minutes}" data-log-minutes="${preset.minutes}">
            ${escapeHtml(preset.label)}${preset.hint ? `<span class="time-log-hint">${escapeHtml(preset.hint)}</span>` : ''}
          </button>`).join('')}
      </div>
      <div class="time-log-custom">
        <label class="field-label" for="timeLogMinutes">Muu (minuuttia)</label>
        <!-- step="1": step lasketaan min-arvosta, joten min="1" step="5" hyväksyi
             vain 1, 6, 11, ... 26, 31 — tavallinen 30 min esti koko lomakkeen.
             required: tyhjä kenttä + Enter ei sulje dialogia kirjaamatta. -->
        <input type="number" id="timeLogMinutes" min="1" max="1440" step="1" inputmode="numeric" required>
        <button type="submit" class="form-btn secondary" value="custom">Kirjaa</button>
      </div>`;

  dialog.innerHTML = `
    <form method="dialog" class="confirm-body time-log-body">
      <h2 class="confirm-title" id="timeLogTitle" tabindex="-1">${escapeHtml(title)}</h2>
      ${introHtml}
      ${chooseArea ? areaSelectHtml() : ''}
      ${logControls}
      ${offerMute ? `<label class="checkbox-row" for="timeLogMute"><input type="checkbox" id="timeLogMute"> Älä kysy tätä tällä laitteella</label>` : ''}
      <div class="confirm-actions">
        <button type="submit" formnovalidate class="form-btn secondary" value="cancel">${escapeHtml(skipLabel)}</button>
        ${allowTimer || timerOnly ? '<button type="submit" formnovalidate class="form-btn primary" value="timer">Aloita ajastin</button>' : ''}
      </div>
    </form>`;

  // Varasuunnitelma selaimelle ilman <dialog>-tukea: ei kirjausta.
  if (typeof dialog.showModal !== 'function') return Promise.resolve({ action: 'skip' });

  return new Promise(resolve => {
    const onClose = async () => {
      dialog.removeEventListener('close', onClose);
      const value = dialog.returnValue || 'cancel';
      const mute = dialog.querySelector('#timeLogMute');
      if (mute && mute.checked) setDevicePreference('askTimeOnComplete', false);
      const areaPicker = dialog.querySelector('#timeLogArea');
      const chosenTarget = chooseArea && areaPicker && areaPicker.value
        ? { kind: 'life_area', id: areaPicker.value } : target;

      if (value === 'timer') {
        const started = await startTimerFor(chosenTarget);
        resolve({ action: 'timer', result: started });
        return;
      }
      let minutes = null;
      if (value.startsWith('m:')) minutes = Number(value.slice(2));
      if (value === 'custom') minutes = Math.round(Number(dialog.querySelector('#timeLogMinutes').value));
      if (!Number.isInteger(minutes) || minutes <= 0) {
        resolve({ action: 'skip' });
        return;
      }
      const result = await logQuickTime({ target: chosenTarget, minutes, operationId: operation, entryDate });
      if (result.ok && !result.duplicate) announceLogged(minutes, { queued: Boolean(result.queued) });
      resolve({ action: 'logged', result });
    };
    dialog.addEventListener('close', onClose);
    for (const preset of dialog.querySelectorAll('[data-log-minutes]')) {
      preset.addEventListener('click', () => dialog.close(preset.value));
    }
    dialog.returnValue = 'cancel';
    dialog.showModal();
    // Alkufokus otsikkoon, EI pikavalintaan (CRIT-04): yksi Enter tai
    // välilyönti heti avautumisen jälkeen kirjasi ennen 15 min. Otsikko
    // ei myöskään avaa puhelimen näppäimistöä pikavalintojen päälle.
    const heading = dialog.querySelector('#timeLogTitle');
    if (heading) heading.focus();
  });
}

// ------------------------------------------------ ajastimen toiminnot

/** Käynnistä ajastin; jos toinen on käynnissä, kysy ensin. */
export async function startTimerFor(target, { confirmFn = confirmAction } = {}) {
  const running = currentTimer();
  if (running) {
    const replace = await confirmFn({
      title: 'Ajastin on jo käynnissä',
      message: `Pysäytetäänkö ja kirjataanko "${describeTarget(targetOfTimer(running))}" ennen uuden aloittamista?`,
      confirmLabel: 'Pysäytä ja aloita uusi'
    });
    if (!replace) return { ok: false, cancelled: true };
    const stopped = await stopAndLog();
    if (!stopped || !stopped.ok) return { ok: false };
  }
  const result = await startTracking(target);
  if (!result.ok && result.message) {
    showError(result.message);
  }
  return result;
}

/**
 * Tarkistus pitkälle (tai kirjaamatta jääneelle) ajastukselle: vahvista
 * tai korjaa kesto.
 */
function openStopReview(totalMinutes, {
  title = 'Tarkista ajastettu aika',
  intro = `Ajastin on ollut käynnissä ${formatMinutes(totalMinutes)}. Jos se unohtui päälle, korjaa kesto ennen kirjausta.`
} = {}) {
  const dialog = dialogElement();
  // Sama sääntö kuin kirjausdialogissa: auki olevaa ei korvata. Ajastin
  // jää käyntiin, eikä mitään kirjata.
  if (dialog.open) return Promise.resolve(null);
  dialog.innerHTML = `
    <form method="dialog" class="confirm-body">
      <h2 class="confirm-title" id="timeLogTitle">${escapeHtml(title)}</h2>
      <p class="confirm-message">${escapeHtml(intro)}</p>
      <label class="field-label" for="timeLogReviewMinutes">Kirjattava aika (minuuttia)</label>
      <!-- Ei ylärajaa eikä 5 min askelta: esitäytetty kesto on mikä tahansa
           kokonaisluku, ja yli viikon unohtunut ajastin ylitti max-arvon —
           silloin kumpikaan painike ei toiminut. Pitkä kesto pilkotaan
           päiväkohtaisiin kirjauksiin (src/domain/timer.js). -->
      <!-- required: tyhjä kenttä + Enter ei peru kirjausta hiljaa. -->
      <input type="number" id="timeLogReviewMinutes" min="1" step="1" required value="${escapeHtml(String(totalMinutes))}">
      <div class="confirm-actions">
        <!-- "Takaisin" ei ole submit-painike: Enter esitäytetyssä kentässä
             aktivoi lomakkeen ENSIMMÄISEN submit-painikkeen, ja se oli
             "Takaisin" — mitään ei kirjattu. Nyt ainoa submit on "Kirjaa". -->
        <button type="button" class="form-btn secondary" id="timeLogReviewBack">Takaisin</button>
        <button type="submit" class="form-btn primary" value="confirm">Kirjaa</button>
      </div>
    </form>`;
  if (typeof dialog.showModal !== 'function') return Promise.resolve(null);
  return new Promise(resolve => {
    const onClose = () => {
      dialog.removeEventListener('close', onClose);
      if (dialog.returnValue !== 'confirm') { resolve(null); return; }
      const minutes = Math.round(Number(dialog.querySelector('#timeLogReviewMinutes').value));
      resolve(Number.isInteger(minutes) && minutes > 0 ? minutes : null);
    };
    dialog.addEventListener('close', onClose);
    const back = dialog.querySelector('#timeLogReviewBack');
    if (back) back.addEventListener('click', () => dialog.close('cancel'));
    dialog.returnValue = 'cancel';
    dialog.showModal();
  });
}

function announceStop(result) {
  if (result.code === 'timer.changed') {
    showError(TIMER_CHANGED_MESSAGE);
  } else if (result.ok && result.tooShort) {
    notify('Alle minuutin ajastusta ei kirjattu.', 3000);
  } else if (result.ok && !result.duplicate) {
    // Ilman yhteyttä kirjaus on lähtökorissa: ei väitetä kirjatuksi ennen
    // kuin se on kannassa.
    announceLogged(result.totalMinutes, { queued: Boolean(result.queued) });
  }
}

/** Pysäytä ja kirjaa. Pitkä ajastus tarkistetaan ensin. */
export async function stopAndLog({ reviewFn = openStopReview } = {}) {
  let result = await stopTracking();
  if (result.needsReview) {
    const minutes = await reviewFn(result.totalMinutes);
    if (minutes === null) return { ok: false, cancelled: true };
    // Korjaus koskee TARKISTETTUA ajastinta: jos dialogin aikana tilalle
    // tuli toinen (toinen laite tai välilehti), mitään ei kirjata.
    result = await stopTracking({ overrideMinutes: minutes, expectTimerId: result.timerId });
  }
  announceStop(result);
  return result;
}

/** Kirjaa tämän laitteen kirjaamaton ajastus: kesto vahvistetaan aina ensin. */
export async function logPendingTimer({ reviewFn = openStopReview } = {}) {
  let result = await stopPendingTracking();
  if (result.needsReview) {
    const minutes = await reviewFn(result.totalMinutes, {
      title: 'Kirjaamaton ajastus',
      intro: `Tämän laitteen ajastus ei ehtinyt tallentua, ja toisella laitteella oli samaan aikaan oma ajastin. Ehdotus on ${formatMinutes(result.totalMinutes)}; korjaa kesto ennen kirjausta.`
    });
    if (minutes === null) return { ok: false, cancelled: true };
    result = await stopPendingTracking({ overrideMinutes: minutes, expectTimerId: result.timerId });
  }
  announceStop(result);
  return result;
}

/** Hylkää kirjaamaton ajastus (vahvistus kysytään). */
export async function discardPendingTimer({ confirmFn = confirmAction } = {}) {
  const result = await discardPendingTracking({ confirmFn });
  if (result.code === 'timer.changed') showError(TIMER_CHANGED_MESSAGE);
  return result;
}

// ------------------------------------------------ valmistumisen kirjaus

/**
 * "Kirjataanko tähän käytetty aika?" tehtävän valmistuessa.
 * Kysytään vain, jos Suunta on käytössä (alueita on) eikä käyttäjä ole
 * mykistänyt kysymystä tällä laitteella.
 */
export async function offerCompletionLog(task) {
  if (!task) return { action: 'skip' };
  const state = getState();
  if (state.lifeAreas.length === 0) return { action: 'skip' };
  if (getDevicePreference('askTimeOnComplete') === false) return { action: 'skip' };

  const estimate = durationOf(task);
  const suggestions = [
    { minutes: 15, label: '15 min' },
    { minutes: 30, label: '30 min' }
  ];
  if (Number.isFinite(estimate) && estimate > 0 && estimate !== 15 && estimate !== 30) {
    suggestions.push({
      minutes: estimate, label: `Arvio ${formatMinutes(estimate)}`,
      hint: 'hyväksyn arvion toteumaksi'
    });
  }
  return openTimeLogDialog({
    target: { kind: 'task', id: task.id },
    title: 'Kirjataanko tähän käytetty aika?',
    message: task.title,
    suggestions,
    skipLabel: 'Ohita',
    offerMute: true,
    // Yksi valmistuminen = yksi kirjaus, vaikka dialogia napautettaisiin kahdesti.
    operationId: OPERATION.taskCompletion(task.id, String(nowMs()))
  });
}

/** Rutiinin esiintymän kirjaus. Rutiinin kesto on vain ehdotus. */
export async function openRoutineLog(routineId, dateIso) {
  const routine = findRoutine(routineId);
  if (!routine) return { action: 'skip' };
  const already = loggedMinutesForOccurrence(routineId, dateIso);
  const suggestions = [{ minutes: 15, label: '15 min' }, { minutes: 30, label: '30 min' }];
  if (Number.isInteger(routine.durationMinutes) && ![15, 30].includes(routine.durationMinutes)) {
    suggestions.push({ minutes: routine.durationMinutes, label: `Rutiinin kesto ${formatMinutes(routine.durationMinutes)}`, hint: 'ehdotus' });
  }
  return openTimeLogDialog({
    target: { kind: 'routine', id: routineId, occurrenceDate: dateIso },
    title: already > 0 ? 'Lisätäänkö aikaa tälle kerralle?' : 'Kirjaa rutiiniin käytetty aika',
    message: already > 0
      ? `${routine.title}: tälle kerralle on jo kirjattu ${formatMinutes(already)}.`
      : routine.title,
    suggestions,
    allowTimer: dateIso === fmtISO(new Date(nowMs())),
    entryDate: dateIso,
    operationId: occurrenceOperationId(routineId, dateIso)
  });
}

/** Tehtävän tai projektin kirjaus lomakkeelta. */
export function openItemLog(kind, id) {
  const item = kind === 'task' ? findTask(id) : kind === 'project' ? findProject(id) : null;
  if (!item) return Promise.resolve({ action: 'skip' });
  return openTimeLogDialog({
    target: { kind, id },
    title: 'Kirjaa aikaa',
    message: kind === 'task' ? item.title : item.name,
    allowTimer: true
  });
}

/** Yleinen kirjaus Suunnasta: valitse alue. */
export function openGeneralLog() {
  return openTimeLogDialog({
    target: { kind: 'none' }, title: 'Kirjaa aikaa', chooseArea: true, allowTimer: true
  });
}

/**
 * "Aloita ajanseuranta" Suunnasta: kysy alue ENNEN ajastimen käynnistystä
 * (F6). Ennen ajastin käynnistyi aina ilman aluetta, eikä kirjattua aikaa
 * voinut kohdistaa jälkikäteen. "Ei aluetta" on yhä sallittu valinta.
 */
export function openTimerChooser() {
  const hasAreas = getState().lifeAreas.some(area => area.active);
  return openTimeLogDialog({
    target: { kind: 'none' }, title: 'Aloita ajanseuranta',
    message: hasAreas
      ? 'Mihin alueeseen tämä aika kuuluu? Voit jättää alueen valitsematta ja liittää ajan myöhemmin.'
      : 'Ajastin käynnistyy ilman aluetta. Voit liittää ajan alueeseen myöhemmin.',
    chooseArea: true, timerOnly: true
  });
}

// --------------------------------------------------------- kytkennät

async function onTimerAction(event) {
  const button = event.target.closest('[data-timer]');
  if (!button) return;
  button.disabled = true;
  try {
    switch (button.dataset.timer) {
      case 'pause': await pauseTracking(); break;
      case 'resume': await resumeTracking(); break;
      case 'stop': await stopAndLog(); break;
      case 'cancel': {
        const result = await cancelTracking();
        if (result.code === 'timer.changed') showError(TIMER_CHANGED_MESSAGE);
        break;
      }
      case 'pending-log': await logPendingTimer(); break;
      case 'pending-discard': await discardPendingTimer(); break;
      default: break;
    }
  } finally {
    button.disabled = false;
  }
}

export function initTimeLog() {
  const bar = maybe('timerBar');
  if (bar) bar.addEventListener('click', onTimerAction);
  setCompletionHook(task => { offerCompletionLog(task); });
  if (!tickHandle && typeof setInterval === 'function') {
    tickHandle = setInterval(tick, TICK_MS);
  }
}

/**
 * Uloskirjautuminen: auki oleva dialogi suljetaan ILMAN kirjausta ja
 * sen sisältö tyhjennetään, jottei seuraava käyttäjä näe edellisen
 * tehtävän nimeä.
 */
export function closeTimeLogDialog() {
  const dialog = typeof document !== 'undefined' ? document.getElementById(DIALOG_ID) : null;
  if (!dialog) return;
  dialog.returnValue = 'cancel';
  if (dialog.open && typeof dialog.close === 'function') dialog.close('cancel');
  dialog.innerHTML = '';
}

/** Testejä ja uloskirjautumista varten. */
export function stopTimeLogTicker() {
  if (tickHandle) clearInterval(tickHandle);
  tickHandle = null;
}
