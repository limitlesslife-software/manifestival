// Saapuvat ja universaali kirjaus.
//
// =====================================================================
// KAKSI ERI ASIAA SAMASSA TIEDOSTOSSA, JA SE ON TARKOITUS
// =====================================================================
//
//   1. KIRJAUSPALKKI  päivänäkymän yläreunassa. Aina käsillä, koska
//      kirjaus on se teko joka tapahtuu useimmin.
//
//   2. SAAPUVAT       Tekeminen → Saapuvat. Lista siitä, mitä on
//      kirjattu ja mitä niille tehtiin.
//
// Ne ovat saman elinkaaren kaksi päätä, ja niiden pitäminen yhdessä
// tiedostossa tekee näkyväksi sen, että kirjaaminen ja käsittely ovat
// sama asia eri hetkinä.
//
// =====================================================================
// MITÄÄN EI SYNNY ILMAN HYVÄKSYNTÄÄ
// =====================================================================
//
// Tulkinta näytetään EHDOTUKSENA: yhtenä lauseena, joka kertoo mitä
// hyväksyminen tekisi. Toimenpide, jota ei voi lukea yhtenä lauseena,
// hyväksytään lukematta.
//
// Näkymä ei kutsu domainin reitittäjää suoraan toimintona — se pyytää
// sovelluskerrosta (`src/app/capture.js`), joka on ainoa paikka jossa
// reitti muuttuu kutsuksi.

import { el, maybe, toggle, setBusy } from '../../ui/dom.js';
import { escapeHtml } from '../../lib/format.js';
import { getState } from '../state.js';
import {
  INBOX_STATUS, inboxStatusLabel, compareInboxItems, summarizeInbox,
  MAX_TEXT_LENGTH
} from '../../domain/inbox.js';
import { CAPTURE_SOURCE } from '../../domain/inbox.js';
import { captureKindLabel } from '../../domain/capture.js';
import { hasTable, isTableAvailable } from '../../data/schema.js';
import { serverUnavailableHintHtml } from '../schemaStatus.js';
import {
  captureAndInterpret, reviewItem, closeReview, approveItem,
  interpretItem, dismissItemById, restoreItemById, deleteInboxItem
} from '../capture.js';
import {
  listenOnce, speechAvailable, isDictating, cancelDictation, finishDictation
} from '../speechInput.js';

/** Näytetäänkö myös käsitellyt rivit? Näkymän oma tila, ei sovelluksen. */
let showClosed = false;

// =====================================================================
// KIRJAUSPALKKI
// =====================================================================

function captureFieldValue() {
  const input = maybe('captureInput');
  return input ? String(input.value || '') : '';
}

function setCaptureError(message) {
  const node = maybe('captureError');
  if (!node) return;
  node.textContent = message || '';
  node.style.display = message ? 'block' : 'none';
}

function setCaptureStatus(message) {
  const node = maybe('captureStatus');
  if (node) node.textContent = message || '';
}

/**
 * Tulkinnan epäonnistumisen syy tilariville. Syy on merkkijono; jos
 * kutsuja antaa virheolion, näytetään vain sen käyttäjäviesti -- ei
 * koskaan "AppError: …" eikä palvelimen tekstiä.
 */
export function captureReasonText(reason) {
  if (typeof reason === 'string' && reason) return reason;
  if (reason && typeof reason.userMessage === 'string' && reason.userMessage) return reason.userMessage;
  return 'Tuntematon syy.';
}

/**
 * Kirjaa kentän sisältö.
 *
 * KENTTÄ TYHJENNETÄÄN VASTA KUN RIVI ON SYNTYNYT. Jos se tyhjennettäisiin
 * heti, epäonnistunut kirjaus veisi käyttäjän tekstin mukanaan — ja
 * juuri sitä tekstiä varten koko palkki on olemassa.
 */
async function submitCapture(source = CAPTURE_SOURCE.TEXT) {
  const text = captureFieldValue().trim();
  setCaptureError('');

  if (!text) {
    setCaptureError('Kirjoita jotain ensin.');
    return;
  }
  if (text.length > MAX_TEXT_LENGTH) {
    setCaptureError('Teksti on liian pitkä.');
    return;
  }

  const button = maybe('captureSendBtn');
  setBusy(button, true);
  setCaptureStatus('Kirjataan…');

  try {
    const result = await captureAndInterpret(text, { source });

    if (!result.ok) {
      setCaptureError((result.errors && result.errors.text) || 'Kirjaus ei onnistunut.');
      setCaptureStatus('');
      return;
    }

    const input = maybe('captureInput');
    if (input) input.value = '';

    // Tulkinta on ehdotus, ja se avataan heti tarkistettavaksi. Jos
    // tulkinta ei onnistunut, rivi jää saapuviin ilman ehdotusta — ja
    // se sanotaan ääneen.
    if (result.interpreted && result.item.proposal) {
      reviewItem(result.item.id);
      setCaptureStatus('');
    } else {
      setCaptureStatus(result.reason
        ? `Kirjattu saapuviin. Tulkinta ei onnistunut: ${captureReasonText(result.reason)}`
        : 'Kirjattu saapuviin.');
    }
  } finally {
    setBusy(button, false);
  }
}

/** Monesko sanelu: vanhentunut sanelu ei saa päivittää uudemman tilaa. */
let dictationRun = 0;

/**
 * Tilarivi mikrofonin ollessa auki. Lupaa, että toinen napautus LOPETTAA
 * (ja vie sanotun kenttään) -- toggleDictation tekee juuri sen
 * (finishDictation), ei peru.
 */
export const DICTATION_LISTENING_STATUS = 'Kuuntelen… Napauta mikrofonia uudelleen lopettaaksesi.';

/**
 * Sanele kirjauskenttään. Painike on KYTKIN (aria-pressed): toinen
 * napautus kesken kuuntelun LOPETTAA sanelun, ja se mitä ehdittiin sanoa
 * menee kenttään (tunnistin viimeistelee, ei toista tunnistinta). Ennen
 * kuin mikrofoni on auki (lupa, käynnistys) toinen napautus peruu hiljaa.
 *
 * ÄÄNTÄ EI TALLENNETA. Tunnistin palauttaa tekstin, teksti menee
 * kenttään, ja käyttäjä näkee sen ennen kuin mitään lähtee eteenpäin.
 * Äänitallennetta ei kirjoiteta mihinkään missään vaiheessa.
 */
export async function toggleDictation() {
  const button = maybe('captureMicBtn');
  if (!button) return;

  if (isDictating()) {
    if (finishDictation()) setCaptureStatus('Lopetetaan kuuntelu…');
    return;
  }

  const run = ++dictationRun;
  const current = () => run === dictationRun;

  setCaptureError('');
  button.setAttribute('aria-pressed', 'true');
  setCaptureStatus('Käynnistetään mikrofonia…');

  try {
    const result = await listenOnce({
      onPermission: () => { if (current()) setCaptureStatus('Salli mikrofoni, jos laite kysyy lupaa.'); },
      onStart: () => { if (current()) setCaptureStatus(DICTATION_LISTENING_STATUS); }
    });
    if (!current()) return;

    if (!result.ok) {
      setCaptureStatus('');
      // Peruttu (toinen napautus ennen kuin mikrofoni aukesi, sovellus
      // taustalle, uloskirjautuminen) ei ole virhe.
      if (result.code !== 'aborted') {
        setCaptureError(result.error || 'Puheentunnistus ei onnistunut. Kirjoita sen sijaan.');
      }
      return;
    }

    const input = maybe('captureInput');
    if (input) input.value = result.text;
    setCaptureStatus('Tarkista teksti ja paina Kirjaa.');
  } finally {
    if (current()) button.setAttribute('aria-pressed', 'false');
  }
}

// =====================================================================
// TULKINNAN TARKISTUS
// =====================================================================

function renderPending(container, pending) {
  if (!pending) {
    container.innerHTML = '';
    return;
  }

  const kuvaus = pending.description
    || 'Tästä ei voi luoda riviä suoraan. Täydennä tiedot tai käsittele käsin.';

  container.innerHTML = `
    <div class="review-card" role="group" aria-label="Tarkista tulkinta">
      <div class="review-source">Kirjasit: “${escapeHtml(pending.text)}”</div>
      <div class="review-what">${escapeHtml(kuvaus)}</div>
      <div class="review-actions">
        ${pending.route
          ? `<button class="form-btn primary" data-capture-approve="${escapeHtml(pending.itemId)}">Luo</button>`
          : ''}
        <button class="form-btn secondary" data-capture-later="${escapeHtml(pending.itemId)}">Myöhemmin</button>
        <button class="form-btn danger" data-capture-dismiss="${escapeHtml(pending.itemId)}">Hylkää</button>
      </div>
    </div>`;
}

// =====================================================================
// SAAPUVIEN LISTA
// =====================================================================

function statusTone(status) {
  if (status === INBOX_STATUS.NEEDS_REVIEW) return 'tone-warn';
  if (status === INBOX_STATUS.CONVERTED) return '';
  return '';
}

function proposalLine(item) {
  if (!item.proposal || !item.proposal.kind) return '';
  const laji = captureKindLabel(item.proposal.kind);
  const otsikko = item.proposal.title ? ` — ${item.proposal.title}` : '';
  return `<div class="assist-reason">Ehdotus: ${escapeHtml(laji)}${escapeHtml(otsikko)}</div>`;
}

function rowHtml(item) {
  const suljettu = item.status === INBOX_STATUS.CONVERTED
    || item.status === INBOX_STATUS.DISMISSED;

  const toiminnot = [];

  if (item.status === INBOX_STATUS.DISMISSED) {
    toiminnot.push(`<button class="assist-btn" data-inbox-restore="${escapeHtml(item.id)}">Palauta</button>`);
  } else if (item.status === INBOX_STATUS.CONVERTED) {
    // MUUNNETTU ON PÄÄTETILA. Palautus loisi kaksoiskappaleen, joten
    // sitä ei tarjota — ei myöskään harmaana.
    toiminnot.push(`<button class="assist-btn danger" data-inbox-delete="${escapeHtml(item.id)}">Poista</button>`);
  } else {
    toiminnot.push(`<button class="assist-btn primary" data-inbox-review="${escapeHtml(item.id)}">Käsittele</button>`);
    if (!item.proposal) {
      toiminnot.push(`<button class="assist-btn" data-inbox-interpret="${escapeHtml(item.id)}">Tulkitse</button>`);
    }
    toiminnot.push(`<button class="assist-btn" data-inbox-dismiss="${escapeHtml(item.id)}">Hylkää</button>`);
  }

  const kohde = item.status === INBOX_STATUS.CONVERTED && item.convertedKind
    ? ` · ${escapeHtml(captureKindLabel(item.convertedKind))}`
    : '';

  const lahde = item.source === CAPTURE_SOURCE.VOICE ? ' · puheesta' : '';

  return `
    <div class="assist-row${suljettu ? ' is-closed' : ''}">
      <div class="assist-title">${escapeHtml(item.text)}</div>
      <div class="assist-meta">
        <span class="assist-tag ${statusTone(item.status)}">${escapeHtml(inboxStatusLabel(item.status))}</span>
        ${escapeHtml(String(item.capturedAt || '').slice(0, 10))}${kohde}${lahde}
      </div>
      ${proposalLine(item)}
      <div class="assist-actions">${toiminnot.join('')}</div>
    </div>`;
}

function emptyHtml() {
  return `
    <div class="assist-empty">
      Saapuvat on tyhjä. Kirjaa jotain päivänäkymän yläreunasta —
      järjestää voi myöhemmin.
    </div>`;
}

// =====================================================================
// RENDERÖINTI
// =====================================================================

/** Renderöi kirjauspalkki, tarkistus ja saapuvien lista. */
export function renderInbox() {
  const state = getState();

  // Sama tarkistuskortti kummassakin näkymässä: kirjauspalkin alla
  // (Tänään) ja Saapuvissa, josta "Käsittele" sen avaa (L0).
  renderPending(el('capturePending'), state.pendingCapture);
  const inboxPending = maybe('inboxPending');
  if (inboxPending) renderPending(inboxPending, state.pendingCapture);

  // Mikrofoni piilotetaan, jos selain ei tunne puhetta. Painike, joka ei
  // tee mitään, on huonompi kuin puuttuva painike.
  const mic = maybe('captureMicBtn');
  if (mic) mic.style.display = speechAvailable() ? '' : 'none';

  const container = maybe('inboxListContainer');
  if (!container) return;

  const kaikki = [...state.inboxItems].sort(compareInboxItems);
  const naytettavat = showClosed
    ? kaikki
    : kaikki.filter(item => item.status !== INBOX_STATUS.CONVERTED
        && item.status !== INBOX_STATUS.DISMISSED);

  const summary = summarizeInbox(kaikki);

  const otsikko = `
    <h2 class="section-title">
      Saapuvat
      ${summary.open > 0 ? `<span class="notice-badge">${summary.open}</span>` : ''}
    </h2>`;

  const suodatin = kaikki.length > naytettavat.length || showClosed
    ? `<button class="assist-btn" id="inboxToggleClosed" type="button">`
      + `${showClosed ? 'Piilota käsitellyt' : 'Näytä käsitellyt'}</button>`
    : '';

  const varoitus = isTableAvailable('inboxItems')
    ? ''
    : hasTable('inboxItems')
      ? serverUnavailableHintHtml()
      : `<p class="hint"><strong>Huom.</strong> Saapuvat säilyvät toistaiseksi `
        + `vain tämän istunnon ajan.</p>`;

  container.innerHTML = otsikko + varoitus
    + (naytettavat.length === 0 ? emptyHtml() : naytettavat.map(rowHtml).join(''))
    + (suodatin ? `<div class="assist-actions">${suodatin}</div>` : '');
}

// =====================================================================
// TAPAHTUMAT
// =====================================================================

/** Kytke kirjauspalkin ja saapuvien tapahtumat. Kutsutaan kerran. */
export function initInbox() {
  const send = maybe('captureSendBtn');
  if (send) send.addEventListener('click', () => submitCapture());

  const mic = maybe('captureMicBtn');
  if (mic) mic.addEventListener('click', toggleDictation);

  const input = maybe('captureInput');
  if (input) {
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        submitCapture();
      }
    });
    // Kirjoittaminen poistaa edellisen virheilmoituksen: virhe, joka jää
    // näkyviin korjauksen jälkeen, opettaa ohittamaan virheet.
    input.addEventListener('input', () => setCaptureError(''));
  }

  // Tarkistuskortin painikkeet. Delegointi, koska kortti piirretään
  // uudelleen jokaisella tilamuutoksella.
  const pending = maybe('capturePending');
  if (pending) pending.addEventListener('click', onPendingClick);
  const inboxPending = maybe('inboxPending');
  if (inboxPending) inboxPending.addEventListener('click', onPendingClick);

  const list = maybe('inboxListContainer');
  if (list) list.addEventListener('click', onListClick);
}

async function onPendingClick(event) {
  const approve = event.target.closest('[data-capture-approve]');
  if (approve) {
    setBusy(approve, true);
    try {
      const result = await approveItem(approve.dataset.captureApprove);
      if (result.alreadyConverted) {
        setCaptureStatus('Tämä on jo käsitelty.');
        closeReview();
      }
    } finally {
      setBusy(approve, false);
    }
    return;
  }

  const later = event.target.closest('[data-capture-later]');
  if (later) {
    closeReview();
    setCaptureStatus('Jätettiin saapuviin.');
    return;
  }

  const dismiss = event.target.closest('[data-capture-dismiss]');
  if (dismiss) {
    await dismissItemById(dismiss.dataset.captureDismiss);
    setCaptureStatus('Hylätty. Voit palauttaa sen Saapuvista.');
  }
}

async function onListClick(event) {
  const toggleClosed = event.target.closest('#inboxToggleClosed');
  if (toggleClosed) {
    showClosed = !showClosed;
    renderInbox();
    return;
  }

  const review = event.target.closest('[data-inbox-review]');
  if (review) {
    reviewItem(review.dataset.inboxReview);
    return;
  }

  const interpret = event.target.closest('[data-inbox-interpret]');
  if (interpret) {
    setBusy(interpret, true);
    try {
      const result = await interpretItem(interpret.dataset.inboxInterpret);
      if (result.ok) reviewItem(interpret.dataset.inboxInterpret);
    } finally {
      setBusy(interpret, false);
    }
    return;
  }

  const dismiss = event.target.closest('[data-inbox-dismiss]');
  if (dismiss) {
    await dismissItemById(dismiss.dataset.inboxDismiss);
    return;
  }

  const restore = event.target.closest('[data-inbox-restore]');
  if (restore) {
    await restoreItemById(restore.dataset.inboxRestore);
    return;
  }

  const remove = event.target.closest('[data-inbox-delete]');
  if (remove) {
    await deleteInboxItem(remove.dataset.inboxDelete);
  }
}

/** Sulje kesken oleva tarkistus. Kutsutaan uloskirjautuessa. */
export function closeCaptureReview() {
  // Kesken oleva sanelu ei saa kirjoittaa seuraavan käyttäjän kenttään.
  cancelDictation();
  closeReview();
  showClosed = false;
  const input = maybe('captureInput');
  if (input) input.value = '';
  setCaptureError('');
  setCaptureStatus('');
}
