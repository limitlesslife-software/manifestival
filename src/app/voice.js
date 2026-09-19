// Puheohjaus: yksi tulkintaputki tekstille ja puheelle.
//
// Virta:
//   mikrofoni -> selaimen puheentunnistus -> teksti
//     -> KÄYTTÄJÄ TARKISTAA/MUOKKAA TEKSTIÄ
//     -> runTypedCommand({source:'voice'})  (src/app/commandBar.js)
//     -> SAMA luokittelu, SAMA allowlist, SAMA kohteentunnistus,
//        SAMA vahvistusdialogi, SAMA kirjausketju kuin kirjoitetulla
//        komennolla (src/ai/commandClient.js requestCommand,
//        src/ai/intentSchema.js resolveCommand, src/ui/confirm.js).
//
// TÄMÄ TIEDOSTO EI TULKITSE MITÄÄN ITSE. Se on ohut sovitin mikrofonin
// ja commandBar.js:n välissä -- täsmälleen sama periaate kuin
// src/app/search.js:n "Tulkitse komentona" -painike. Kahta erillistä
// tulkintaputkea (yksi luonnille, yksi komennoille) ei enää ole:
// luontikin ("muistuta minua...") on vain yksi COMMANDS-rekisterin
// intentti (create_task) ja kulkee saman vahvistuksen läpi.
//
// AI ei koskaan tallenna mitään suoraan. Jokainen ehdotus näytetään
// vahvistettavana (confirmProposal) ennen suoritusta.
//
// Jos selain ei tue puheentunnistusta tai verkko pettää, käyttäjä voi aina
// kirjoittaa saman asian tekstinä. Puheohjaus ei koskaan päädy umpikujaan.
//
// TILAKONE (ks. myös src/app/speechInput.js:n tilakuvaus):
//
//   IDLE -> LISTENING -> TRANSCRIPT (muokattava, peru/yritä uudelleen)
//        -> PROCESSING (luokittelu + mahdollinen kohteenvalinta + vahvistus,
//           kaikki commandBar.js:n sisällä) -> SUCCESS (sulkee) | ERROR
//
// Kohteenvalinta ja vahvistus näytetään ui/confirm.js:n jaetulla
// dialogilla (proposalDialog), joka kerrostuu tämän paneelin päälle --
// sama komponentti jota tekstikomento käyttää, ei kopiota siitä.

import { el, maybe, singleFlight } from '../ui/dom.js';
import { runTypedCommand } from './commandBar.js';
import { speech } from '../platform/index.js';
import { logEvent } from '../lib/logger.js';

const STATES = ['listening', 'transcript', 'processing', 'error', 'typefallback'];

const SpeechRecognitionCtor = typeof window !== 'undefined'
  ? (window.SpeechRecognition || window.webkitSpeechRecognition)
  : null;

let recognition = null;
/** Estää samasta tunnistuksesta useamman tuloksen käsittelyn (onresult voi
 *  laueta uudelleen, ja onend ei saa näyttää virhettä enää tuloksen jälkeen). */
let resultHandled = false;

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
  resultHandled = false;
}

function stopRecognition() {
  if (!recognition) return;
  try { recognition.stop(); } catch { /* jo pysähtynyt */ }
}

/**
 * Näytä tunnistettu teksti muokattavana ennen mitään tulkintaa.
 *
 * KÄYTTÄJÄN ON NÄHTÄVÄ MITÄ KUULTIIN. Puheentunnistus erehtyy
 * säännöllisesti (homonyymit, taustamelu), ja virhe on halvin korjata
 * tässä -- ennen kuin se etenee luokitteluun asti.
 */
function showTranscriptReview(text) {
  const input = maybe('vfTranscriptText');
  if (input) input.value = text;
  showState('transcript');
  if (input) input.focus();
}

/**
 * Aja käyttäjän hyväksymä teksti koko komentoputken läpi.
 *
 * DELEGOI KOKONAAN commandBar.js:lle. Tämä on ainoa paikka jossa
 * voice.js koskettaa suoritusta, ja se on identtinen kirjoitetun
 * komennon kanssa: sama funktio, ainoastaan `source: 'voice'` eroaa.
 *
 * @param {string} text käyttäjän tarkistama/muokkaama teksti
 * @param {object} [options] testejä varten: { confirmFn, chooseFn, fetchImpl }
 */
export async function runVoiceCommand(text, options = {}) {
  return runTypedCommand(text, { ...options, source: 'voice' });
}

/**
 * Aja tarkistettu teksti loppuun asti.
 *
 * SUOJATTU TUPLAKLIKKAUKSELTA singleFlight:llä (ks. src/ui/dom.js) --
 * sama idiomi kuin jokaisessa muussa async-toiminnossa sovelluksessa,
 * ei paikallinen erikoistapaus.
 */
const submitTranscript = singleFlight(async (text, ui) => {
  const clean = String(text ?? '').trim();
  if (!clean) { showVoiceError('En kuullut mitään. Yritä uudelleen.'); return; }

  showState('processing');

  logEvent('voice.submit', { chars: clean.length });
  const result = await runVoiceCommand(clean, ui);
  logEvent('voice.result', { ok: Boolean(result.ok), status: String(result.status || '') });

  if (result.ok) {
    closeOverlay();
    return;
  }
  if (result.status === 'cancelled') {
    // Käyttäjä perui vahvistuksen tai kohteenvalinnan -- ei virhe,
    // palataan hiljaa sulkien paneeli (sama kuin tekstikomennossa).
    closeOverlay();
    return;
  }
  if (result.status === 'empty') {
    showVoiceError('En kuullut mitään. Yritä uudelleen.');
    return;
  }
  // 'rejected' | 'error' | suoritus epäonnistui: näytetään syy ja
  // tarjotaan uudelleenyritys tai kirjoitus, ei umpikuja.
  showVoiceError(result.reason || 'Komentoa ei ymmärretty.');
});

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

    if (event.results[event.results.length - 1].isFinal) {
      if (resultHandled) return;
      const clean = transcript.trim();
      if (!clean) { showVoiceError('En kuullut mitään. Yritä uudelleen.'); return; }
      resultHandled = true;
      // Vain pituus: litterointi on käyttäjän puhetta eikä kuulu lokiin.
      logEvent('voice.transcript', { chars: clean.length });
      showTranscriptReview(clean);
    }
  };

  instance.onerror = event => {
    logEvent('voice.error', { code: String(event.error || 'unknown') });
    if (event.error === 'no-speech') showVoiceError('En kuullut mitään. Yritä uudelleen.');
    else if (event.error === 'not-allowed') showVoiceError('Mikrofonin käyttö estetty. Salli mikrofoni selaimen asetuksista.');
    else if (event.error === 'aborted') { /* käyttäjä sulki — ei virhe */ }
    else showVoiceError('Puheentunnistus ei onnistunut.');
  };

  instance.onend = () => {
    const listening = maybe('voiceState-listening');
    const overlayOpen = el('voiceOverlay').classList.contains('open');
    if (listening && listening.style.display !== 'none' && overlayOpen && !resultHandled) {
      showVoiceError('En kuullut mitään. Yritä uudelleen.');
    }
  };

  return instance;
}

/** Avaa puhepaneeli ja aloita kuuntelu. */
export function startVoiceFlow() {
  openOverlay();
  resultHandled = false;

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

/** Kytke puheohjauksen tapahtumat. Kutsutaan kerran käynnistyksessä. */
export function initVoice() {
  recognition = setupRecognition();

  el('fabBtn').addEventListener('click', startVoiceFlow);
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

  // Tunnistettu teksti: käyttäjä voi muokata ennen tulkintaa.
  const transcriptInput = el('vfTranscriptText');
  el('voiceTranscriptContinueBtn').addEventListener('click', () => {
    submitTranscript(transcriptInput.value, {});
  });
  el('voiceTranscriptCancelBtn').addEventListener('click', closeOverlay);
  el('voiceTranscriptRetryBtn').addEventListener('click', startVoiceFlow);
  transcriptInput.addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); submitTranscript(transcriptInput.value, {}); }
  });

  // Kirjoitettu varapolku (ei puheentunnistusta selaimessa): sama
  // suoritusputki, suoraan ilman erillistä tarkistusvaihetta --
  // käyttäjä näki tekstin jo kirjoittaessaan sitä.
  const submitFallback = () => {
    const input = el('vfFallbackInput');
    const value = input.value.trim();
    if (!value) return;
    input.value = '';
    submitTranscript(value, {});
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
