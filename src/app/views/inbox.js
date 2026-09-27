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
// BRAIN DUMP: KIRJAUS EI VAADI PÄÄTÖKSIÄ (aalto L)
// =====================================================================
//
// Kirjauskenttä on monirivinen: jokaisesta rivistä tulee oma saapuva rivi
// (src/app/capture.js captureBrainDump). Kirjaus EI avaa tarkistuskorttia
// eikä kysy mitään — tilarivi kertoo vain, että asiat ovat tallessa.
// Luokittelu tapahtuu myöhemmin Saapuvissa erässä: valitse rivit, valitse
// yksi päätös. Jokaisella rivillä on valmiina deterministinen ehdotus
// (src/domain/triage.js), mutta mitään ei synny ennen käyttäjän napautusta.
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

import { el, maybe, setBusy, renderHtml } from '../../ui/dom.js';
import { escapeHtml } from '../../lib/format.js';
import { fmtISO, todayMidnight } from '../../lib/datetime.js';
import { getState } from '../state.js';
import {
  INBOX_STATUS, inboxStatusLabel, compareInboxItems, summarizeInbox, isOpenItem,
  MAX_TEXT_LENGTH, MAX_DUMP_LENGTH
} from '../../domain/inbox.js';
import { CAPTURE_SOURCE } from '../../domain/inbox.js';
import { captureKindLabel } from '../../domain/capture.js';
import {
  proposeTriage, triageSummary, describeTriageOutcome, triageDecisionLabel, TRIAGE_DECISION
} from '../../domain/triage.js';
import { activeLifeAreas, compareLifeAreas, countOf } from '../../domain/lifeArea.js';
import { hasTable, isTableAvailable } from '../../data/schema.js';
import { serverUnavailableHintHtml } from '../schemaStatus.js';
import {
  captureBrainDump, captureDumpMessage, reviewItem, closeReview, approveItem,
  interpretItem, dismissItemById, restoreItemById, deleteInboxItem, triageInboxItems
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
 * Kenttä kasvaa sisältönsä mukaan (enintään noin kuusi riviä, CSS
 * max-height). Monirivinen liitos näkyy kokonaan ilman vierityspalkkia.
 */
function autoGrow(input) {
  if (!input || !input.style) return;
  input.style.height = 'auto';
  if (typeof input.scrollHeight === 'number' && input.scrollHeight > 0) {
    input.style.height = `${input.scrollHeight}px`;
  }
}

function setCaptureField(value) {
  const input = maybe('captureInput');
  if (!input) return;
  input.value = value;
  autoGrow(input);
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
 * Kentän tarkistus ennen kirjausta. Palauttaa virheilmoituksen tai null.
 * Koko liitos saa olla MAX_DUMP_LENGTH, mutta yksittäinen rivi (= yksi
 * saapuva asia) enintään MAX_TEXT_LENGTH: pidempi on dokumentti.
 */
export function captureFieldError(text) {
  const clean = String(text ?? '').trim();
  if (!clean) return 'Kirjoita jotain ensin.';
  if (clean.length > MAX_DUMP_LENGTH) return 'Teksti on liian pitkä.';
  if (clean.split(/\r\n?|\n/).some(line => line.trim().length > MAX_TEXT_LENGTH)) {
    return `Yksi rivi on liian pitkä (enintään ${MAX_TEXT_LENGTH} merkkiä). Jaa se useammalle riville.`;
  }
  return null;
}

/**
 * Tulkinta taustalla yhdelle riville: ehdotus liitetään riviin, mutta
 * MITÄÄN EI AVATA eikä kirjausta odoteta. Epäonnistuminen ei ole virhe:
 * rivi on jo tallessa, ja Saapuvien oma ehdotus toimii ilman tekoälyä.
 */
function interpretInBackground(id) {
  Promise.resolve()
    .then(() => interpretItem(id))
    .catch(() => { /* rivi on tallessa ilman tulkintaa */ });
}

/**
 * Kirjaa kentän sisältö: yksi tai monta asiaa, yksi per rivi.
 *
 * KENTTÄ TYHJENNETÄÄN VASTA KUN RIVI ON SYNTYNYT. Jos se tyhjennettäisiin
 * heti, epäonnistunut kirjaus veisi käyttäjän tekstin mukanaan — ja
 * juuri sitä tekstiä varten koko palkki on olemassa. Tallentumatta
 * jääneet rivit palaavat kenttään.
 *
 * KIRJAUS EI AVAA PÄÄTÖSKORTTIA. Asia on tallessa, ja järjestäminen
 * tapahtuu Saapuvissa silloin, kun käyttäjä ehtii.
 */
async function submitCapture(source = CAPTURE_SOURCE.TEXT) {
  const text = captureFieldValue().trim();
  setCaptureError('');

  const invalid = captureFieldError(text);
  if (invalid) {
    setCaptureError(invalid);
    return;
  }

  const button = maybe('captureSendBtn');
  setBusy(button, true);
  setCaptureStatus('Kirjataan…');

  try {
    const result = await captureBrainDump(text, { source });

    if (!result.ok) {
      setCaptureError((result.errors && result.errors.text) || 'Kirjaus ei onnistunut.');
      setCaptureStatus('');
      return;
    }

    setCaptureField(Array.isArray(result.rest) ? result.rest.join('\n') : '');
    setCaptureStatus(captureDumpMessage(result) || 'Kirjattu saapuviin.');
    if (result.items.length === 1) interpretInBackground(result.items[0].id);
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
 * Kentässä jo oleva teksti säilyy: saneltu tulee uudelle riville, jolloin
 * sanelusta tulee oma saapuva asiansa (brain dump).
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

    const existing = captureFieldValue().replace(/\s+$/, '');
    setCaptureField(existing ? `${existing}\n${result.text}` : result.text);
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
// ERÄ-KÄSITTELY: VALINTA, ALUE JA ODOTUS
// =====================================================================
//
// Näkymän omaa tilaa, ei sovelluksen: valinnat eivät tallennu mihinkään,
// ja uudelleenpiirto (joka tilamuutoksella) lukee ne täältä.

/** Valitut avoimet rivit. */
const selected = new Set();
/** Rivikohtainen alueen valinta: id -> alueen id tai '' (ei aluetta). */
const areaChoice = new Map();
/** "Odottaa…"-kysymys auki, ja sen luonnos (säilyy uudelleenpiirron yli). */
let waitingPrompt = null;
/** Erä kesken: painikkeet estetty. */
let triageBusy = false;

/** Ehdotukset muistissa tekstin mukaan; nollautuu, kun päivä, alueet tai tavoitteet vaihtuvat. */
let proposalCache = { today: null, areas: null, goals: null, map: new Map() };

function todayIsoNow() {
  return fmtISO(todayMidnight());
}

function proposalOf(item, state) {
  const today = todayIsoNow();
  if (proposalCache.today !== today || proposalCache.areas !== state.lifeAreas || proposalCache.goals !== state.goals) {
    proposalCache = { today, areas: state.lifeAreas, goals: state.goals, map: new Map() };
  }
  const key = String(item.text || '');
  if (!proposalCache.map.has(key)) {
    proposalCache.map.set(key, proposeTriage(key, { areas: state.lifeAreas, todayIso: today, goals: state.goals }));
  }
  return proposalCache.map.get(key);
}

function setInboxStatus(message) {
  const node = maybe('inboxStatus');
  if (node) node.textContent = message || '';
}

/** Rivin valittu alue: käyttäjän valinta tai ehdotus. */
function chosenAreaId(item, proposal) {
  return areaChoice.has(item.id) ? areaChoice.get(item.id) : (proposal.areaId || '');
}

function areaSelectHtml(item, proposal, areas) {
  if (areas.length === 0) return '';
  const value = chosenAreaId(item, proposal);
  const id = escapeHtml(item.id);
  const options = [`<option value=""${value === '' ? ' selected' : ''}>Ei aluetta</option>`]
    .concat(areas.map(area => `<option value="${escapeHtml(area.id)}"${area.id === value ? ' selected' : ''}>`
      + `${escapeHtml(area.name)}</option>`));
  return `
      <div class="triage-area">
        <label for="triageArea-${id}">Alue</label>
        <select id="triageArea-${id}" data-triage-area="${id}">${options.join('')}</select>
      </div>`;
}

/** Painike, jonka nimi kertoo montaako riviä se koskee. */
function triageButton(decision, text, count, { danger = false, eligible = count, extra = '' } = {}) {
  const disabled = triageBusy || eligible === 0;
  const label = decision === TRIAGE_DECISION.EVENT
    ? `${text}: ${countOf(eligible, 'valittu asia', 'valittua asiaa')}, joilla on päivä`
    : `${text}: ${countOf(count, 'valittu asia', 'valittua asiaa')}`;
  return `<button class="assist-btn${danger ? ' danger' : ''}" type="button" data-triage="${decision}"`
    + ` aria-label="${escapeHtml(label)}"${disabled ? ' disabled' : ''}${extra}>${escapeHtml(text)}</button>`;
}

function triageBarHtml(open, proposals) {
  const count = open.filter(item => selected.has(item.id)).length;
  const withDate = open.filter(item => selected.has(item.id) && proposals.get(item.id).date).length;
  const all = count > 0 && count === open.length;
  const help = count === 0
    ? 'Valitse asiat, niin voit päättää niistä kerralla. Loput pysyvät tallessa.'
    : `Valittu ${count}/${open.length}.`;
  return `
    <div class="triage-bar" role="group" aria-label="Käsittele valitut">
      <div class="triage-bar-head">
        <label class="triage-all"><input type="checkbox" id="inboxSelectAll"${all ? ' checked' : ''}${triageBusy ? ' disabled' : ''}> Valitse kaikki</label>
        <span class="triage-count" id="inboxSelectedCount">${escapeHtml(help)}</span>
      </div>
      <div class="assist-actions triage-actions">
        ${triageButton(TRIAGE_DECISION.NOW, triageDecisionLabel(TRIAGE_DECISION.NOW), count)}
        ${triageButton(TRIAGE_DECISION.THIS_WEEK, triageDecisionLabel(TRIAGE_DECISION.THIS_WEEK), count)}
        ${triageButton(TRIAGE_DECISION.LATER, triageDecisionLabel(TRIAGE_DECISION.LATER), count)}
        ${triageButton(TRIAGE_DECISION.NOT_YET, triageDecisionLabel(TRIAGE_DECISION.NOT_YET), count)}
        ${triageButton(TRIAGE_DECISION.WAITING, 'Odottaa…', count, { extra: ' aria-haspopup="true"' })}
        ${triageButton(TRIAGE_DECISION.EVENT, triageDecisionLabel(TRIAGE_DECISION.EVENT), count, { eligible: withDate })}
        ${triageButton(TRIAGE_DECISION.DISMISS, triageDecisionLabel(TRIAGE_DECISION.DISMISS), count, { danger: true })}
      </div>
    </div>`;
}

function waitingPromptHtml(count) {
  if (!waitingPrompt) return '';
  return `
    <div class="triage-prompt" role="group" aria-labelledby="triageWaitLabel">
      <label id="triageWaitLabel" for="triageWaitInput">Kenen tai minkä varassa asia on? (valinnainen)</label>
      <input type="text" id="triageWaitInput" maxlength="200" autocomplete="off"
             placeholder="esim. Mika, isännöitsijä, pankin päätös" value="${escapeHtml(waitingPrompt.draft)}">
      <div class="assist-actions">
        <button class="assist-btn primary" type="button" data-triage-wait-confirm
                aria-label="${escapeHtml(`Merkitse odottamaan: ${countOf(count, 'valittu asia', 'valittua asiaa')}`)}"${triageBusy ? ' disabled' : ''}>Merkitse odottamaan</button>
        <button class="assist-btn" type="button" data-triage-wait-cancel>Peru</button>
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

/** Tekoälyn tulkinta (jos pyydetty). Eri asia kuin rivin oma ehdotus. */
function interpretationLine(item) {
  if (!item.proposal || !item.proposal.kind) return '';
  const laji = captureKindLabel(item.proposal.kind);
  const otsikko = item.proposal.title ? ` — ${item.proposal.title}` : '';
  return `<div class="assist-reason">Tulkinta: ${escapeHtml(laji)}${escapeHtml(otsikko)}</div>`;
}

function convertedKindLabel(kind) {
  return kind === 'event' ? 'Meno' : captureKindLabel(kind);
}

function rowHtml(item, { proposal = null, areas = [] } = {}) {
  const suljettu = item.status === INBOX_STATUS.CONVERTED
    || item.status === INBOX_STATUS.DISMISSED;
  const id = escapeHtml(item.id);

  const toiminnot = [];

  if (item.status === INBOX_STATUS.DISMISSED) {
    toiminnot.push(`<button class="assist-btn" data-inbox-restore="${id}">Palauta</button>`);
  } else if (item.status === INBOX_STATUS.CONVERTED) {
    // MUUNNETTU ON PÄÄTETILA. Palautus loisi kaksoiskappaleen, joten
    // sitä ei tarjota — ei myöskään harmaana.
    toiminnot.push(`<button class="assist-btn danger" data-inbox-delete="${id}">Poista</button>`);
  } else {
    toiminnot.push(`<button class="assist-btn primary" data-inbox-review="${id}">Käsittele</button>`);
    if (!item.proposal) {
      toiminnot.push(`<button class="assist-btn" data-inbox-interpret="${id}">Tulkitse</button>`);
    }
    toiminnot.push(`<button class="assist-btn" data-inbox-dismiss="${id}">Hylkää</button>`);
  }

  const kohde = item.status === INBOX_STATUS.CONVERTED && item.convertedKind
    ? ` · ${escapeHtml(convertedKindLabel(item.convertedKind))}`
    : '';

  const lahde = item.source === CAPTURE_SOURCE.VOICE ? ' · puheesta' : '';

  // Avoimella rivillä valintaruutu (erä) ja nimilappuna rivin oma teksti.
  const otsikko = proposal
    ? `<div class="triage-row-head">
        <input type="checkbox" id="triageSel-${id}" data-triage-select="${id}"${selected.has(item.id) ? ' checked' : ''}${triageBusy ? ' disabled' : ''}>
        <label class="assist-title" for="triageSel-${id}">${escapeHtml(item.text)}</label>
      </div>`
    : `<div class="assist-title">${escapeHtml(item.text)}</div>`;

  return `
    <div class="assist-row${suljettu ? ' is-closed' : ''}${proposal ? ' triage-row' : ''}">
      ${otsikko}
      <div class="assist-meta">
        <span class="assist-tag ${statusTone(item.status)}">${escapeHtml(inboxStatusLabel(item.status))}</span>
        ${escapeHtml(String(item.capturedAt || '').slice(0, 10))}${kohde}${lahde}
      </div>
      ${proposal ? `<div class="assist-reason triage-proposal">${escapeHtml(triageSummary(proposal, { areas }))}</div>` : ''}
      ${proposal ? areaSelectHtml(item, proposal, areas) : ''}
      ${interpretationLine(item)}
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
  // (Tänään) ja Saapuvissa, josta "Käsittele" sen avaa (L0). Kirjaus ei
  // enää avaa korttia itsestään: vain "Käsittele".
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
  const avoimet = kaikki.filter(isOpenItem);
  const naytettavat = showClosed
    ? kaikki
    : kaikki.filter(item => item.status !== INBOX_STATUS.CONVERTED
        && item.status !== INBOX_STATUS.DISMISSED);

  // Valinta koskee vain avoimia rivejä, jotka ovat yhä olemassa.
  const openIds = new Set(avoimet.map(item => item.id));
  for (const id of [...selected]) if (!openIds.has(id)) selected.delete(id);
  for (const id of [...areaChoice.keys()]) if (!openIds.has(id)) areaChoice.delete(id);
  if (waitingPrompt && selected.size === 0) waitingPrompt = null;

  const areas = activeLifeAreas(state.lifeAreas || []).sort(compareLifeAreas);
  const proposals = new Map(avoimet.map(item => [item.id, proposalOf(item, state)]));

  const summary = summarizeInbox(kaikki);

  const otsikko = `
    <h2 class="section-title" id="inboxTitle" tabindex="-1">
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

  const selectedCount = avoimet.filter(item => selected.has(item.id)).length;
  const era = avoimet.length > 0 ? triageBarHtml(avoimet, proposals) + waitingPromptHtml(selectedCount) : '';

  const rivit = naytettavat.length === 0
    ? emptyHtml()
    : naytettavat.map(item => rowHtml(item, { proposal: proposals.get(item.id) || null, areas })).join('');

  renderHtml(container, otsikko + varoitus + era + rivit
    + (suodatin ? `<div class="assist-actions">${suodatin}</div>` : ''), { fallback: ['inboxTitle'] });
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
      // Enter kirjaa, Shift+Enter tekee uuden rivin. Kirjoitusmenetelmän
      // (IME) kesken oleva Enter ei kirjaa.
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        submitCapture();
      }
    });
    // Kirjoittaminen poistaa edellisen virheilmoituksen: virhe, joka jää
    // näkyviin korjauksen jälkeen, opettaa ohittamaan virheet.
    input.addEventListener('input', () => {
      setCaptureError('');
      autoGrow(input);
    });
  }

  // Tarkistuskortin painikkeet. Delegointi, koska kortti piirretään
  // uudelleen jokaisella tilamuutoksella.
  const pending = maybe('capturePending');
  if (pending) pending.addEventListener('click', onPendingClick);
  const inboxPending = maybe('inboxPending');
  if (inboxPending) inboxPending.addEventListener('click', onPendingClick);

  const list = maybe('inboxListContainer');
  if (list) {
    list.addEventListener('click', onListClick);
    list.addEventListener('change', onListChange);
    list.addEventListener('input', onListInput);
    list.addEventListener('keydown', onListKeydown);
  }
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

function onListChange(event) {
  const target = event.target;
  if (!target || !target.dataset) return;

  if (target.id === 'inboxSelectAll') {
    const open = getState().inboxItems.filter(isOpenItem);
    if (target.checked) open.forEach(item => selected.add(item.id));
    else selected.clear();
    renderInbox();
    return;
  }
  if (target.dataset.triageSelect) {
    if (target.checked) selected.add(target.dataset.triageSelect);
    else selected.delete(target.dataset.triageSelect);
    renderInbox();
    return;
  }
  if (target.dataset.triageArea) {
    areaChoice.set(target.dataset.triageArea, String(target.value || ''));
    renderInbox();
  }
}

function onListInput(event) {
  if (waitingPrompt && event.target && event.target.id === 'triageWaitInput') {
    waitingPrompt.draft = String(event.target.value || '');
  }
}

function onListKeydown(event) {
  if (!waitingPrompt || !event.target || event.target.id !== 'triageWaitInput') return;
  if (event.key === 'Enter' && !event.isComposing) {
    event.preventDefault();
    confirmWaiting();
  } else if (event.key === 'Escape') {
    event.preventDefault();
    closeWaitingPrompt();
  }
}

function focusById(id) {
  const node = maybe(id);
  if (node && typeof node.focus === 'function') node.focus();
  return Boolean(node);
}

/** Fokus erän jälkeen: ensimmäinen jäljellä oleva rivi, muuten otsikko. */
function focusAfterTriage() {
  const next = [...getState().inboxItems].sort(compareInboxItems).find(isOpenItem);
  if (!(next && focusById(`triageSel-${next.id}`))) focusById('inboxTitle');
}

/** Yhteinen ehdotus valituille (esim. kaikki odottavat samaa Mikaa), muuten tyhjä. */
function sharedWaitingOn() {
  const state = getState();
  const values = new Set(state.inboxItems
    .filter(item => selected.has(item.id))
    .map(item => proposalOf(item, state).waitingOn || ''));
  return values.size === 1 ? [...values][0] : '';
}

function openWaitingPrompt() {
  waitingPrompt = { draft: sharedWaitingOn() };
  renderInbox();
  focusById('triageWaitInput');
}

function closeWaitingPrompt() {
  waitingPrompt = null;
  renderInbox();
  const button = maybe('inboxListContainer');
  const waitButton = button && typeof button.querySelector === 'function'
    ? button.querySelector(`[data-triage="${TRIAGE_DECISION.WAITING}"]`) : null;
  if (waitButton && typeof waitButton.focus === 'function' && !waitButton.disabled) waitButton.focus();
}

function confirmWaiting() {
  const draft = waitingPrompt ? waitingPrompt.draft : '';
  waitingPrompt = null;
  return runTriage(TRIAGE_DECISION.WAITING, { waitingOn: draft.trim() || null });
}

/**
 * Aja erän päätös valituille riveille. Vain käyttäjän napautuksesta:
 * mitään ei synny ilman tätä kutsua.
 */
async function runTriage(decision, { waitingOn = null } = {}) {
  if (triageBusy) return;
  const open = getState().inboxItems.filter(isOpenItem);
  const ids = open.filter(item => selected.has(item.id)).map(item => item.id);
  if (ids.length === 0) {
    setInboxStatus('Valitse ensin asiat, joista haluat päättää.');
    return;
  }

  triageBusy = true;
  setInboxStatus('Käsitellään…');
  renderInbox();
  let outcome;
  try {
    outcome = await triageInboxItems(ids, decision, {
      areaChoices: Object.fromEntries(areaChoice), waitingOn
    });
  } finally {
    triageBusy = false;
  }

  // Käsitellyt pois valinnasta; Saapuviin jääneet pysyvät valittuina,
  // jotta niille voi valita toisen päätöksen heti.
  for (const entry of outcome.converted) selected.delete(entry.id);
  if (decision === TRIAGE_DECISION.DISMISS) {
    for (const id of ids) {
      const item = getState().inboxItems.find(row => row.id === id);
      if (!item || !isOpenItem(item)) selected.delete(id);
    }
  }
  setInboxStatus(describeTriageOutcome(outcome) || 'Mitään ei muutettu.');
  renderInbox();
  focusAfterTriage();
}

async function onListClick(event) {
  const toggleClosed = event.target.closest('#inboxToggleClosed');
  if (toggleClosed) {
    showClosed = !showClosed;
    renderInbox();
    return;
  }

  const triage = event.target.closest('[data-triage]');
  if (triage) {
    if (triage.disabled) return;
    const decision = triage.dataset.triage;
    if (decision === TRIAGE_DECISION.WAITING) openWaitingPrompt();
    else await runTriage(decision);
    return;
  }

  if (event.target.closest('[data-triage-wait-confirm]')) {
    await confirmWaiting();
    return;
  }
  if (event.target.closest('[data-triage-wait-cancel]')) {
    closeWaitingPrompt();
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
  // Edellisen käyttäjän valinnat eivät kuulu seuraavalle.
  selected.clear();
  areaChoice.clear();
  waitingPrompt = null;
  triageBusy = false;
  proposalCache = { today: null, areas: null, goals: null, map: new Map() };
  setCaptureField('');
  setCaptureError('');
  setCaptureStatus('');
  setInboxStatus('');
}

/** Testejä varten: erän valinnat ilman DOM-tapahtumia. */
export function selectInboxItemsForTests(ids = []) {
  selected.clear();
  for (const id of ids) selected.add(String(id));
}

/** Testejä varten: aja erän päätös valituille riveille (sama polku kuin painike). */
export function runTriageForTests(decision, options) {
  return runTriage(decision, options);
}
