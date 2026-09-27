// Tallessa: kaikki, mitä ei tarvitse hoitaa tänään.
//
// "Kaikki muu on tallessa. Sinun ei tarvitse hoitaa sitä tänään."
//
// Tänään-näkymä näyttää vain fokuksen (enintään kolme) ja kertoo muun
// määrän yhtenä lukuna. Tämä näkymä on se paikka, josta muun löytää, kun
// sitä tarvitsee — ei lista, jota pitää käydä läpi joka päivä.
//
// Lähde on SAMA kuin Tänään-näkymässä: src/app/lifeLoadModel.js
// (lifeLoad.computeLifeLoad). Kaksi näkymää ei voi olla eri mieltä siitä,
// mikä on tallessa.
//
// Siirrot kulkevat src/app/mentalLoadActions.js:n kautta: horisontti,
// odotus ja arkistointi ovat tehtävän kenttiä (editTask), joten validointi,
// offline-jono ja siirtojen seuranta ovat samat kuin muualla.

import { maybe, setBusy } from '../../ui/dom.js';
import { escapeHtml } from '../../lib/format.js';
import { fmtISO, todayMidnight } from '../../lib/datetime.js';
import { getState } from '../state.js';
import { lifeLoadFor } from '../lifeLoadModel.js';
import { horizonLabel, storedMessage, LOAD_HORIZON } from '../../domain/lifeLoad.js';
import { natureLabel } from '../../domain/itemNature.js';
import { TASK_HORIZON } from '../../domain/task.js';
import { datelessTasksAllowed, isTableAvailable } from '../../data/schema.js';
import { setTaskHorizon, markWaiting, archiveTask, restoreTask } from '../mentalLoadActions.js';
import { openEditForm } from './tasks.js';
import { shortDateLabel } from '../../domain/calendar.js';

/** Näkymän oma tila: mikä välilehti on auki. Ei sovelluksen tilaa. */
let activeTab = LOAD_HORIZON.THIS_WEEK;

const TABS = Object.freeze([
  { key: LOAD_HORIZON.THIS_WEEK, list: 'thisWeek' },
  { key: LOAD_HORIZON.LATER, list: 'later' },
  { key: LOAD_HORIZON.NOT_YET, list: 'notYet' },
  { key: LOAD_HORIZON.WAITING, list: 'waiting' },
  { key: LOAD_HORIZON.ARCHIVED, list: 'archived' }
]);

/** Kerralla näytettävien rivien määrä. Loput yhdellä painalluksella. */
export const STORED_PAGE_SIZE = 25;
let showAll = false;
/** Tehtävä, jonka "Odottaa…"-lomake on auki (vain näkymän tila). */
let waitingFor = null;

/** Avaa tietty välilehti (Tänään-näkymän "Näytä tallessa olevat"). */
export function setStoredTab(key) {
  if (TABS.some(tab => tab.key === key)) activeTab = key;
  showAll = false;
}

function todayIso() {
  return fmtISO(todayMidnight());
}

function metaOf(entry) {
  const parts = [];
  if (entry.kind === 'bill') parts.push('Lasku');
  else parts.push(natureLabel(entry.nature));
  if (entry.date) parts.push(shortDateLabel(entry.date));
  if (entry.deadline && entry.deadline !== entry.date) parts.push(`määräaika ${shortDateLabel(entry.deadline)}`);
  if (entry.item && entry.item.waitingOn) parts.push(`odottaa: ${entry.item.waitingOn}`);
  if (entry.item && entry.item.followUpDate) parts.push(`tarkista ${shortDateLabel(entry.item.followUpDate)}`);
  return parts.join(' · ');
}

function actionsFor(entry) {
  if (entry.kind !== 'task') return '';
  const id = escapeHtml(entry.id);
  const title = escapeHtml(entry.title);
  if (entry.horizon === LOAD_HORIZON.ARCHIVED) {
    return `<button type="button" class="assist-btn" data-stored-restore="${id}" aria-label="Palauta: ${title}">Palauta</button>`;
  }
  const move = (horizon, label) => (entry.horizon === horizon ? ''
    : `<button type="button" class="assist-btn" data-stored-horizon="${horizon}" data-stored-id="${id}"
        aria-label="${escapeHtml(label)}: ${title}">${escapeHtml(label)}</button>`);
  return [
    `<button type="button" class="assist-btn primary" data-stored-horizon="${TASK_HORIZON.NOW}" data-stored-id="${id}"
      aria-label="Tänään: ${title}">Tänään</button>`,
    move(LOAD_HORIZON.THIS_WEEK, 'Tällä viikolla'),
    move(LOAD_HORIZON.LATER, 'Myöhemmin'),
    move(LOAD_HORIZON.NOT_YET, 'Ei vielä'),
    entry.horizon === LOAD_HORIZON.WAITING ? ''
      : `<button type="button" class="assist-btn" data-stored-wait="${id}" aria-label="Odottaa jotakuta: ${title}">Odottaa…</button>`,
    `<button type="button" class="assist-btn" data-stored-archive="${id}" aria-label="Poista näkyvistä: ${title}">Poista näkyvistä</button>`
  ].join('');
}

function waitingFormHtml(entry) {
  const id = escapeHtml(entry.id);
  return `
      <div class="stored-wait-form" role="group" aria-label="Odottaa jotakuta">
        <label class="field-label" for="storedWaitOn-${id}">Kenen tai minkä varassa? (valinnainen)</label>
        <input type="text" id="storedWaitOn-${id}" maxlength="200" autocomplete="off" placeholder="esim. Anna, taloyhtiö">
        <label class="field-label" for="storedWaitFollow-${id}">Tarkista tilanne (valinnainen)</label>
        <input type="date" id="storedWaitFollow-${id}">
        <div class="assist-actions">
          <button type="button" class="assist-btn primary" data-stored-wait-save="${id}">Tallenna</button>
          <button type="button" class="assist-btn" data-stored-wait-cancel>Peru</button>
        </div>
      </div>`;
}

function rowHtml(entry) {
  const reasons = entry.reasons.filter(Boolean).slice(0, 2).join(' · ');
  const open = entry.kind === 'task'
    ? `<button type="button" class="t-open stored-open" data-stored-edit="${escapeHtml(entry.id)}"
        aria-label="Muokkaa: ${escapeHtml(entry.title)}"><span class="assist-title">${escapeHtml(entry.title)}</span></button>`
    : `<div class="assist-title">${escapeHtml(entry.title)}</div>`;
  return `
    <li class="assist-row stored-row${entry.fits === false ? ' is-overflow' : ''}">
      ${open}
      <div class="assist-meta">${escapeHtml(metaOf(entry))}</div>
      ${reasons ? `<div class="assist-reason">${escapeHtml(reasons)}</div>` : ''}
      <div class="assist-actions">${actionsFor(entry)}</div>
      ${waitingFor === entry.id ? waitingFormHtml(entry) : ''}
    </li>`;
}

/** Renderöi Tallessa-osio. */
export function renderStored() {
  const container = maybe('storedListContainer');
  if (!container) return;
  const state = getState();
  const load = lifeLoadFor(state, { todayIso: todayIso() });
  if (!load) {
    container.innerHTML = '';
    return;
  }
  const message = storedMessage(load.storedCount);
  const tabs = TABS.map(tab => {
    const count = load[tab.list].length;
    const selected = tab.key === activeTab;
    return `<button type="button" class="segment-btn${selected ? ' active' : ''}" role="tab"
      aria-selected="${selected ? 'true' : 'false'}" data-stored-tab="${tab.key}">${escapeHtml(horizonLabel(tab.key))}
      <span class="count-badge">${count}</span></button>`;
  }).join('');
  const current = TABS.find(tab => tab.key === activeTab) || TABS[0];
  const entries = load[current.list];
  const visible = showAll ? entries : entries.slice(0, STORED_PAGE_SIZE);
  const more = entries.length > visible.length
    ? `<button type="button" class="ghost-btn" data-stored-more>Näytä loput (${entries.length - visible.length})</button>` : '';
  const empty = entries.length === 0
    ? `<div class="assist-empty">${escapeHtml(emptyText(current.key))}</div>` : '';
  const overflow = current.key === LOAD_HORIZON.THIS_WEEK && load.overflow.length > 0
    ? `<p class="hint">${load.overflow.length === 1 ? 'Yksi asia ei mahdu' : `${load.overflow.length} asiaa ei mahdu`} tämän viikon aikaan. Ne ovat silti tallessa; siirrä ne myöhemmäksi tai valitse, mikä jää pois.</p>`
    : '';
  const gate = datelessTasksAllowed() ? ''
    : '<p class="hint">Päivätön tallennus tulee käyttöön, kun palvelin on päivitetty (migraatio 0015). Siihen asti "Myöhemmin" pitää asian päivän.</p>';
  const volatile = isTableAvailable('weeklyPlans') ? '' : '';
  container.innerHTML = `
    <p class="calm-stored-lead"><strong>${escapeHtml(message.title)}</strong> ${escapeHtml(message.text)}</p>
    ${gate}${volatile}
    <div class="segment segment-scroll" role="tablist" aria-label="Tallessa olevat">${tabs}</div>
    ${overflow}
    ${empty}
    ${visible.length ? `<ul class="td-list stored-list">${visible.map(rowHtml).join('')}</ul>` : ''}
    ${more}`;
}

function emptyText(key) {
  switch (key) {
    case LOAD_HORIZON.THIS_WEEK: return 'Tälle viikolle ei ole muuta. Hyvä niin.';
    case LOAD_HORIZON.LATER: return 'Myöhemmäksi ei ole siirretty mitään.';
    case LOAD_HORIZON.NOT_YET: return 'Ei mitään "ei vielä" -asioita.';
    case LOAD_HORIZON.WAITING: return 'Et odota keneltäkään mitään.';
    default: return 'Arkisto on tyhjä.';
  }
}

async function onClick(event) {
  const tab = event.target.closest('[data-stored-tab]');
  if (tab) {
    setStoredTab(tab.dataset.storedTab);
    renderStored();
    return;
  }
  if (event.target.closest('[data-stored-more]')) {
    showAll = true;
    renderStored();
    return;
  }
  const edit = event.target.closest('[data-stored-edit]');
  if (edit) {
    openEditForm(edit.dataset.storedEdit);
    return;
  }
  const horizon = event.target.closest('[data-stored-horizon]');
  if (horizon) {
    setBusy(horizon, true);
    try {
      await setTaskHorizon(horizon.dataset.storedId, horizon.dataset.storedHorizon, { todayIso: todayIso() });
    } finally {
      setBusy(horizon, false);
    }
    return;
  }
  const wait = event.target.closest('[data-stored-wait]');
  if (wait) {
    waitingFor = wait.dataset.storedWait;
    renderStored();
    const input = maybe(`storedWaitOn-${waitingFor}`);
    if (input && typeof input.focus === 'function') input.focus();
    return;
  }
  if (event.target.closest('[data-stored-wait-cancel]')) {
    waitingFor = null;
    renderStored();
    return;
  }
  const waitSave = event.target.closest('[data-stored-wait-save]');
  if (waitSave) {
    const id = waitSave.dataset.storedWaitSave;
    const who = maybe(`storedWaitOn-${id}`);
    const follow = maybe(`storedWaitFollow-${id}`);
    waitingFor = null;
    await markWaiting(id, {
      waitingOn: who ? String(who.value || '').trim() || null : null,
      followUpDate: follow ? follow.value || null : null
    });
    return;
  }
  const archive = event.target.closest('[data-stored-archive]');
  if (archive) {
    await archiveTask(archive.dataset.storedArchive);
    return;
  }
  const restore = event.target.closest('[data-stored-restore]');
  if (restore) await restoreTask(restore.dataset.storedRestore);
}

/** Kytke kuuntelija kerran säiliöön (delegointi: rivit piirretään uudelleen). */
export function initStored() {
  const container = maybe('storedListContainer');
  if (container && !container.dataset.wired) {
    container.dataset.wired = '1';
    container.addEventListener('click', onClick);
  }
}
