// Puheohjaus ja luonnollisen kielen tehtäväsyöttö.
//
// Virta:
//   mikrofoni -> selaimen puheentunnistus -> teksti
//     -> /api/parse (palvelin, API-avain siellä)
//     -> tiukka skeemavalidointi (src/ai/proposalSchema.js)
//     -> KÄYTTÄJÄN VAHVISTUS
//     -> tehtävä
//
// AI ei koskaan tallenna mitään suoraan. Jokainen ehdotus näytetään
// muokattavana lomakkeena ennen tallennusta.
//
// Jos selain ei tue puheentunnistusta tai verkko pettää, käyttäjä voi aina
// kirjoittaa saman asian tekstinä. Puheohjaus ei koskaan päädy umpikujaan.

import { fmtISO, todayMidnight } from '../lib/datetime.js';
import { escapeHtml } from '../lib/format.js';
import { CATEGORIES } from '../domain/categories.js';
import { PRIORITIES } from '../domain/priority.js';
import { requestProposal, weekdayName } from '../ai/parseClient.js';
import { fallbackProposal } from '../ai/proposalSchema.js';
import { el, maybe, setBusy, singleFlight } from '../ui/dom.js';
import { createTask } from './actions.js';
import { currentAccessToken } from './auth.js';
import { showError } from '../ui/toast.js';
import { speech } from '../platform/index.js';

const STATES = ['listening', 'processing', 'confirm', 'error', 'typefallback'];

const SpeechRecognitionCtor = typeof window !== 'undefined'
  ? (window.SpeechRecognition || window.webkitSpeechRecognition)
  : null;

let recognition = null;
/** Estää saman puheen käsittelyn kahdesti, jos onresult laukeaa uudelleen. */
let handling = false;

function showState(name) {
  for (const state of STATES) {
    const node = maybe('voiceState-' + state);
    if (node) node.style.display = state === name ? 'block' : 'none';
  }
}

function showVoiceError(message) {
  const node = maybe('voiceErrorMsg');
  if (node) node.textContent = message;
  showState('error');
}

function openOverlay() {
  el('voiceOverlay').classList.add('open');
  el('voiceOverlay').setAttribute('aria-hidden', 'false');
}

function closeOverlay() {
  el('voiceOverlay').classList.remove('open');
  el('voiceOverlay').setAttribute('aria-hidden', 'true');
  stopRecognition();
  handling = false;
}

function stopRecognition() {
  if (!recognition) return;
  try { recognition.stop(); } catch { /* jo pysähtynyt */ }
}

function populateSelects() {
  const category = maybe('vfCategory');
  if (category) {
    category.innerHTML = CATEGORIES.map(c => `<option value="${escapeHtml(c.key)}">${escapeHtml(c.label)}</option>`).join('');
  }
  const priority = maybe('vfPriority');
  if (priority) {
    priority.innerHTML = PRIORITIES.map(p => `<option value="${escapeHtml(p.key)}">${escapeHtml(p.label)}</option>`).join('');
  }
}

function fillConfirmForm(proposal) {
  el('vfTitle').value = proposal.title || '';
  el('vfDate').value = proposal.date || fmtISO(todayMidnight());
  el('vfTime').value = proposal.time || '';
  el('vfEndTime').value = proposal.endTime || '';
  el('vfDuration').value = proposal.durationMinutes ? String(proposal.durationMinutes) : '';
  el('vfCategory').value = proposal.category || 'muu';
  el('vfPriority').value = proposal.priority || 'normaali';

  const source = maybe('vfSource');
  if (source) {
    source.textContent = proposal.__source === 'fallback'
      ? 'Tulkinta ei onnistunut — tarkista kentät.'
      : 'Tarkista ja tallenna.';
  }
}

/** Käsittele valmis teksti: pyydä ehdotus ja näytä vahvistuslomake. */
async function handleTranscript(text) {
  if (handling) return;
  const clean = String(text ?? '').trim();
  if (!clean) { showVoiceError('En kuullut mitään. Yritä uudelleen.'); return; }

  handling = true;
  showState('processing');

  try {
    const today = fmtISO(todayMidnight());
    const accessToken = await currentAccessToken();

    const result = await requestProposal({
      transcript: clean,
      today,
      weekday: weekdayName(todayMidnight()),
      accessToken
    });

    if (!result.ok) {
      // Ehdotusta ei saatu lainkaan: annetaan silti mahdollisuus tallentaa
      // teksti sellaisenaan sen sijaan että työ menisi hukkaan.
      fillConfirmForm({ ...fallbackProposal(clean, today), __source: 'fallback' });
      showState('confirm');
      return;
    }

    fillConfirmForm({ ...result.value.proposal, __source: result.value.source });
    showState('confirm');
  } catch (error) {
    showError(error, 'Tulkinta ei onnistunut.');
    fillConfirmForm({ ...fallbackProposal(clean, fmtISO(todayMidnight())), __source: 'fallback' });
    showState('confirm');
  } finally {
    handling = false;
  }
}

function setupRecognition() {
  if (!SpeechRecognitionCtor) return null;

  const instance = new SpeechRecognitionCtor();
  instance.lang = 'fi-FI';
  instance.continuous = false;
  instance.interimResults = true;

  instance.onresult = event => {
    let transcript = '';
    for (let i = 0; i < event.results.length; i++) transcript += event.results[i][0].transcript;

    const display = maybe('voiceTranscript');
    if (display) display.textContent = transcript;

    if (event.results[event.results.length - 1].isFinal) handleTranscript(transcript);
  };

  instance.onerror = event => {
    if (event.error === 'no-speech') showVoiceError('En kuullut mitään. Yritä uudelleen.');
    else if (event.error === 'not-allowed') showVoiceError('Mikrofonin käyttö estetty. Salli mikrofoni selaimen asetuksista.');
    else if (event.error === 'aborted') { /* käyttäjä sulki — ei virhe */ }
    else showVoiceError('Puheentunnistus ei onnistunut.');
  };

  instance.onend = () => {
    const listening = maybe('voiceState-listening');
    const overlayOpen = el('voiceOverlay').classList.contains('open');
    if (listening && listening.style.display !== 'none' && overlayOpen && !handling) {
      showVoiceError('En kuullut mitään. Yritä uudelleen.');
    }
  };

  return instance;
}

/** Avaa puhepaneeli ja aloita kuuntelu. */
export function startVoiceFlow() {
  openOverlay();
  handling = false;

  if (!recognition) {
    showState('typefallback');
    const input = maybe('vfFallbackInput');
    if (input) input.focus();
    return;
  }

  showState('listening');
  const display = maybe('voiceTranscript');
  if (display) display.textContent = '';

  try {
    recognition.start();
  } catch {
    // start() heittää, jos tunnistus on jo käynnissä.
    showVoiceError('Mikrofonia ei voitu käynnistää.');
  }
}

const saveProposal = singleFlight(async () => {
  const title = el('vfTitle').value.trim();
  if (!title) { el('vfTitle').focus(); return; }

  const button = el('voiceSaveBtn');
  setBusy(button, true, 'Tallennetaan…');
  try {
    const durationRaw = el('vfDuration').value;
    const result = await createTask({
      title,
      date: el('vfDate').value || fmtISO(todayMidnight()),
      time: el('vfTime').value || null,
      endTime: el('vfEndTime').value || null,
      durationMinutes: durationRaw ? Number(durationRaw) : null,
      category: el('vfCategory').value,
      priority: el('vfPriority').value
    });
    if (result.ok) closeOverlay();
  } finally {
    setBusy(button, false);
  }
});

/** Kytke puheohjauksen tapahtumat. Kutsutaan kerran käynnistyksessä. */
export function initVoice() {
  populateSelects();
  recognition = setupRecognition();

  el('fabBtn').addEventListener('click', startVoiceFlow);
  el('voiceSaveBtn').addEventListener('click', saveProposal);
  el('voiceCancelBtn').addEventListener('click', closeOverlay);
  el('voiceErrorCloseBtn').addEventListener('click', closeOverlay);
  el('voiceErrorRetry').addEventListener('click', startVoiceFlow);
  el('voiceErrorTypeInstead').addEventListener('click', () => {
    showState('typefallback');
    const input = maybe('vfFallbackInput');
    if (input) input.focus();
  });
  el('voiceCloseX').addEventListener('click', closeOverlay);

  el('voiceOverlay').addEventListener('click', event => {
    if (event.target.id === 'voiceOverlay') closeOverlay();
  });

  // Esc sulkee paneelin, kuten dialogeissa kuuluu.
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && el('voiceOverlay').classList.contains('open')) closeOverlay();
  });

  const submitFallback = () => {
    const input = el('vfFallbackInput');
    const value = input.value.trim();
    if (!value) return;
    input.value = '';
    handleTranscript(value);
  };

  el('vfFallbackSubmit').addEventListener('click', submitFallback);
  el('vfFallbackInput').addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); submitFallback(); }
  });
}

/**
 * Onko puheentunnistus käytettävissä.
 *
 * Kysytään alustasovittimelta, jotta tuen tarkistus on yhdessä paikassa.
 * Natiivikuoressa vastaus tulee myöhemmin natiivilta liitännäiseltä ilman
 * että tätä kutsupaikkaa tarvitsee muuttaa.
 */
export function speechSupported() {
  return speech.capability().supported;
}
