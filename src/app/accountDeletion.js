// Tilin poiston käyttöliittymä: esikatselu -> varoitus -> kirjoitettu
// vahvistus -> lopullinen vahvistus -> palvelinkutsu -> paikallinen
// siivous ja uloskirjautuminen.
//
// TÄMÄ TIEDOSTO TEKEE SIVUVAIKUTUKSET. Mikä siirtymä on sallittu, ratkaisee
// puhdas tilakone (src/domain/accountDeletionFlow.js); tämä moduuli ei
// päätä sitä itse. Yksi harhaklikkaus ei voi poistaa tiliä: poistoon
// vaaditaan esikatselun näkeminen, oman sähköpostin ja vahvistuslauseen
// kirjoittaminen, erillinen "olen varma" -dialogi ja tuore kirjautuminen
// (viimeisen tarkistaa palvelin).
//
// SOVELLUS EI VÄITÄ POISTOA MAHDOLLISEKSI ENNEN KUIN SE ON: kun
// ACCOUNT_DELETION.endpointEnabled on false, poistopainiketta ei voi
// aktivoida, mitään verkkokutsua ei tehdä ja syy kerrotaan suoraan.

import { escapeHtml } from '../lib/format.js';
import { maybe, singleFlight, focus } from '../ui/dom.js';
import { confirmAction } from '../ui/confirm.js';
import { showError } from '../ui/toast.js';
import { userEmail } from '../data/session.js';
import { getClient } from '../data/client.js';
import { ACCOUNT_DELETION } from '../data/config.js';
import {
  previewAccountDeletion, executeAccountDeletion, deletionErrorMessage
} from '../data/accountDeletionClient.js';
import {
  dryRunDeletion, authAccountDeletable, authAccountBlockedReason, domainLabel
} from '../domain/accountLifecycle.js';
import {
  FLOW, FLOW_EVENT, DELETION_PHRASE, initialFlowState, nextFlowState, confirmationStatus
} from '../domain/accountDeletionFlow.js';
import { currentAccessToken, queueAuthNote } from './auth.js';
import { clearLocalUserData } from './actions.js';
import { offline } from './offline.js';
import { getUser } from '../data/session.js';

let flow = initialFlowState();
let previewSeen = false;
let previewRows = null;
let previewNote = '';
let host = null;
let readData = () => ({});

function endpointEnabled() {
  return authAccountDeletable(ACCOUNT_DELETION.endpointEnabled);
}

function dispatch(event, extra = {}) {
  flow = nextFlowState(flow, event, {
    endpointEnabled: endpointEnabled(), previewSeen, ...extra
  });
  render();
  return flow;
}

function rowsHtml(rows) {
  const filled = rows.filter(row => row.count > 0);
  if (!filled.length) return '<div class="hint">Ei yhtään riviä missään kokoelmassa.</div>';
  return filled.map(row =>
    `<div class="preview-row"><span>${escapeHtml(domainLabel(row.name))}</span><strong>${row.count}</strong></div>`
  ).join('');
}

function previewHtml() {
  if (!previewRows) return '';
  const total = previewRows.reduce((sum, row) => sum + row.count, 0);
  return `
    <div class="preview-block" style="margin-top:8px;">
      <div class="preview-title">Poisto vaikuttaisi ${total} riviin</div>
      ${rowsHtml(previewRows)}
      <div class="hint">Ei tallennettuja tiedostoja (kuittikuvia ei säilytetä).</div>
      ${previewNote ? `<div class="hint">${escapeHtml(previewNote)}</div>` : ''}
    </div>`;
}

const INTRO = `
  <div class="notice tone-clay">
    Tilin poisto on pysyvä eikä sitä voi perua. Kaikki tehtävät, rutiinit,
    tavoitteet, projektit, laskut ja muu oma tietosi poistetaan kokonaan.
    Lataa oma data talteen ennen poistoa (yllä).
  </div>`;

function stepHtml() {
  const enabled = endpointEnabled();
  const blocked = enabled ? '' : `<div class="hint" id="pfDeletionBlocked" style="margin-top:6px;">${escapeHtml(authAccountBlockedReason())}</div>`;

  switch (flow.step) {
    case FLOW.PREVIEW:
      return `
        ${previewHtml()}
        <div class="form-actions" style="margin-top:10px; flex-wrap:wrap;">
          <button class="form-btn" id="pfDeletionCloseBtn" type="button">Sulje</button>
          <button class="form-btn danger" id="pfDeletionContinueBtn" type="button"
                  ${enabled ? '' : 'disabled aria-disabled="true"'}>Jatka poistoon</button>
        </div>
        ${blocked}`;

    case FLOW.CONFIRM:
      return `
        ${previewHtml()}
        <div class="notice tone-clay" role="alert" style="margin-top:10px;">
          <strong>Tätä ei voi perua.</strong> Tili ja kaikki yllä olevat tiedot
          poistetaan pysyvästi. Kukaan, myöskään me, ei voi palauttaa niitä.
        </div>
        <label class="field-label" for="pfDeletionEmail">Kirjoita sähköpostiosoitteesi vahvistukseksi</label>
        <input class="voice-field" id="pfDeletionEmail" type="email" autocomplete="off"
               autocapitalize="none" spellcheck="false" inputmode="email"
               aria-describedby="pfDeletionStatus">
        <label class="field-label" for="pfDeletionPhrase">Kirjoita <strong>${escapeHtml(DELETION_PHRASE)}</strong></label>
        <input class="voice-field" id="pfDeletionPhrase" type="text" autocomplete="off"
               autocapitalize="characters" spellcheck="false" aria-describedby="pfDeletionStatus">
        <div class="hint" id="pfDeletionStatus" role="status" aria-live="polite"></div>
        <div class="form-actions" style="margin-top:10px; flex-wrap:wrap;">
          <button class="form-btn" id="pfDeletionCancelBtn" type="button">Peruuta</button>
          <button class="form-btn danger" id="pfDeletionSubmitBtn" type="button"
                  disabled aria-disabled="true">Poista tili pysyvästi</button>
        </div>`;

    case FLOW.DELETING:
      return `
        <div class="hint" role="status" aria-live="assertive" style="margin-top:10px;">
          Poistetaan tiliä… Älä sulje sovellusta.
        </div>`;

    case FLOW.REAUTH:
      return `
        <div class="notice tone-clay" role="alert" style="margin-top:10px;">
          ${escapeHtml(deletionErrorMessage('recent_login_required'))}
          Mitään ei ole poistettu.
        </div>
        <div class="form-actions" style="margin-top:10px; flex-wrap:wrap;">
          <button class="form-btn" id="pfDeletionCloseBtn" type="button">Sulje</button>
          <button class="form-btn" id="pfDeletionSignoutBtn" type="button">Kirjaudu ulos</button>
        </div>`;

    case FLOW.FAILED:
      return `
        <div class="notice tone-clay" role="alert" style="margin-top:10px;">
          ${escapeHtml(deletionErrorMessage(flow.errorCode))}
        </div>
        <div class="form-actions" style="margin-top:10px; flex-wrap:wrap;">
          <button class="form-btn" id="pfDeletionCloseBtn" type="button">Sulje</button>
          <button class="form-btn danger" id="pfDeletionRetryBtn" type="button"
                  ${enabled ? '' : 'disabled aria-disabled="true"'}>Yritä uudelleen</button>
        </div>`;

    case FLOW.DONE:
      return '<div class="hint" role="status">Tili on poistettu. Kirjaudutaan ulos…</div>';

    default:
      return `
        ${previewHtml()}
        <div class="form-actions" style="margin-top:10px; flex-wrap:wrap;">
          <button class="form-btn" id="pfDeletionPreviewBtn" type="button">Näytä mitä poistettaisiin</button>
        </div>
        ${blocked}`;
  }
}

function render() {
  if (!host) return;
  host.innerHTML = `<h2 class="section-title">Poista tili</h2>${INTRO}<div id="pfDeletionStep">${stepHtml()}</div>`;
  wire();
}

function on(id, handler) {
  const node = maybe(id);
  if (node) node.addEventListener('click', handler);
}

function currentInputs() {
  const email = maybe('pfDeletionEmail');
  const phrase = maybe('pfDeletionPhrase');
  return {
    emailInput: email ? email.value : '',
    phraseInput: phrase ? phrase.value : ''
  };
}

function statusNow() {
  return confirmationStatus({ expectedEmail: userEmail(), ...currentInputs() });
}

function refreshSubmitState() {
  const button = maybe('pfDeletionSubmitBtn');
  const hint = maybe('pfDeletionStatus');
  if (!button) return;
  const status = statusNow();
  button.disabled = !status.ready;
  button.setAttribute('aria-disabled', String(!status.ready));

  const { emailInput, phraseInput } = currentInputs();
  if (!hint) return;
  if (!emailInput && !phraseInput) hint.textContent = '';
  else if (!status.emailOk) hint.textContent = 'Sähköposti ei vielä täsmää.';
  else if (!status.phraseOk) hint.textContent = 'Kirjoita vahvistuslause täsmälleen isoilla kirjaimilla.';
  else hint.textContent = 'Vahvistus täsmää.';
}

/** Esikatselu: palvelimelta jos käytössä (auktoritatiivinen), muuten paikallinen laskenta. */
const openPreview = singleFlight(async () => {
  dispatch(FLOW_EVENT.OPEN_PREVIEW);
  if (flow.step !== FLOW.PREVIEW) return;

  const local = dryRunDeletion(readData(), { endpointEnabled: endpointEnabled() });
  previewRows = local.collections.map(entry => ({ name: entry.name, count: entry.count }));
  previewNote = 'Laskettu tällä laitteella olevasta datasta.';

  if (endpointEnabled()) {
    const result = await previewAccountDeletion({ accessToken: await currentAccessToken() });
    if (result.ok && Array.isArray(result.value.domains)) {
      previewRows = result.value.domains
        .filter(entry => Number.isInteger(entry.rowCount))
        .map(entry => ({ name: entry.domain, count: entry.rowCount }));
      previewNote = 'Laskettu palvelimelta.';
    }
  }
  previewSeen = true;
  render();
});

const signOutAndClean = async () => {
  try {
    await getClient().auth.signOut({ scope: 'local' });
  } catch {
    // Paikallinen siivous ei saa jäädä tekemättä, vaikka uloskirjautuminen
    // epäonnistuisi (käyttäjä on jo poistettu palvelimelta).
    clearLocalUserData();
    if (typeof location !== 'undefined') location.reload();
  }
};

const submitDeletion = singleFlight(async () => {
  const status = statusNow();
  if (!status.ready) return;

  // Viimeinen lukko: erillinen, tarkoituksella toinen vahvistus.
  const sure = await confirmAction({
    title: 'Poistetaanko tili pysyvästi?',
    message: 'Kaikki tietosi poistetaan eikä tätä voi perua. Jatketaanko?',
    confirmLabel: 'Poista tili pysyvästi',
    cancelLabel: 'Peruuta',
    destructive: true
  });
  if (!sure) return;

  const { emailInput, phraseInput } = currentInputs();
  dispatch(FLOW_EVENT.SUBMIT, { confirmationReady: status.ready });
  if (flow.step !== FLOW.DELETING) return;

  const result = await executeAccountDeletion({
    accessToken: await currentAccessToken(),
    confirmEmail: emailInput,
    confirmPhrase: phraseInput
  });

  if (!result.ok) {
    const code = String(result.error.code || '').replace(/^accountDeletion\./, '');
    if (code === 'recent_login_required') dispatch(FLOW_EVENT.NEEDS_REAUTH);
    else dispatch(FLOW_EVENT.FAILED, { errorCode: code });
    return;
  }

  dispatch(FLOW_EVENT.SUCCEEDED);
  // Tili on poistettu: sen lähettämättömät offline-muutokset poistetaan laitteelta.
  const deleted = getUser();
  offline.purge(deleted && deleted.id ? deleted.id : null);
  const complete = result.value.complete === true;
  queueAuthNote(complete
    ? 'Tilisi ja kaikki siihen liittynyt tieto on poistettu.'
    : 'Tilisi on poistettu, mutta poiston jälkitarkistus jäi kesken. Ota yhteyttä tukeen, jos tietoja jäi näkyviin.');
  await signOutAndClean();
});

function reset() {
  flow = initialFlowState();
  previewSeen = false;
  previewRows = null;
  previewNote = '';
  render();
}

function wire() {
  on('pfDeletionPreviewBtn', openPreview);
  on('pfDeletionCloseBtn', reset);
  on('pfDeletionCancelBtn', reset);
  on('pfDeletionContinueBtn', () => {
    dispatch(FLOW_EVENT.BEGIN_CONFIRM);
    focus('pfDeletionEmail');
  });
  on('pfDeletionRetryBtn', () => {
    dispatch(FLOW_EVENT.RETRY);
    focus('pfDeletionEmail');
  });
  on('pfDeletionSignoutBtn', async () => {
    try { await getClient().auth.signOut(); } catch (error) { showError(error, 'Uloskirjautuminen epäonnistui.'); }
  });
  on('pfDeletionSubmitBtn', submitDeletion);

  for (const id of ['pfDeletionEmail', 'pfDeletionPhrase']) {
    const input = maybe(id);
    if (!input) continue;
    input.addEventListener('input', refreshSubmitState);
    input.addEventListener('keydown', event => {
      // Enter ei saa laukaista poistoa: painikkeen on oltava tietoinen valinta.
      if (event.key === 'Enter') event.preventDefault();
      if (event.key === 'Escape') reset();
    });
  }
}

/**
 * Renderöi "Poista tili" -osio annettuun säiliöön.
 *
 * @param {HTMLElement|null} container
 * @param {() => object} getExportData palauttaa kokoelmat inventaarion nimillä
 */
export function renderAccountDeletionSection(container, getExportData) {
  if (!container) return;
  const alreadyRendered = host === container && container.childElementCount > 0;
  host = container;
  readData = typeof getExportData === 'function' ? getExportData : () => ({});

  if (flow.step === FLOW.DONE) { reset(); return; }
  // Kesken oleva vahvistus säilyy: profiilin uudelleenrenderöinti ei saa
  // pyyhkiä käyttäjän kirjoittamaa vahvistusta eikä keskeyttää poistoa.
  if (alreadyRendered && flow.step !== FLOW.IDLE) return;
  render();
}
