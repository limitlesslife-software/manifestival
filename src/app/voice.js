// Puheohjaus: yksi tulkintaputki tekstille ja puheelle.
//
// Virta:
//   mikrofoni -> selaimen puheentunnistus -> teksti
//     -> KÄYTTÄJÄ TARKISTAA/MUOKKAA TEKSTIÄ
//     -> selvä haku ("etsi ...") -> hakupaneeli (ei komentoa)
//     -> muuten runTypedCommand({source:'voice'})  (src/app/commandBar.js)
//     -> SAMA luokittelu, SAMA allowlist, SAMA kohteentunnistus,
//        SAMA vahvistusdialogi, SAMA kirjausketju kuin kirjoitetulla
//        komennolla (src/ai/commandClient.js requestCommand,
//        src/ai/intentSchema.js resolveCommand, src/ui/confirm.js).
//
// TÄMÄ TIEDOSTO EI TULKITSE MITÄÄN ITSE. Se on ohut sovitin mikrofonin
// ja commandBar.js:n välissä -- täsmälleen sama periaate kuin
// src/app/search.js:n "Tulkitse komentona" -painike. Luontikin
// ("muistuta minua...") on vain yksi COMMANDS-rekisterin intentti
// (create_task) ja kulkee saman vahvistuksen läpi.
//
// TILAKONE: src/domain/voiceFlow.js päättää sallitut siirtymät
// (IDLE -> REQUESTING_PERMISSION -> LISTENING -> TRANSCRIPT_READY ->
// CLASSIFYING -> REVIEW/TARGET_SELECTION/CONFIRMATION/EXECUTING ->
// SUCCESS | ERROR). Tämä moduuli vain toteuttaa sivuvaikutukset:
//
//   - MIKROFONI on päällä vain kun tila sitä sallii (micActive). Jokainen
//     siirtymä muuhun tilaan sammuttaa tunnistuksen, myös sivun
//     piilottaminen (visibilitychange/pagehide). Ei taustamikrofonia.
//   - LITTEROINTI EI KOSKAAN mene suoraan tallennukseen: käyttäjä näkee ja
//     voi muokata tekstin ennen kuin se lähtee tulkittavaksi.
//   - Kohteenvalinta ja vahvistus näytetään ui/confirm.js:n jaetulla
//     dialogilla, joka kerrostuu tämän paneelin päälle.
//
// Jos selain ei tue puheentunnistusta tai verkko pettää, käyttäjä voi aina
// kirjoittaa saman asian tekstinä. Puheohjaus ei koskaan päädy umpikujaan.

import { el, maybe, singleFlight } from '../ui/dom.js';
import { runTypedCommand } from './commandBar.js';
import { openSearch } from './search.js';
import { speech } from '../platform/index.js';
import { logEvent } from '../lib/logger.js';
import {
  VOICE, VOICE_EVENT, initialVoiceState, nextVoiceState, micActive
} from '../domain/voiceFlow.js';
import { routeUtterance, ROUTE } from '../domain/utteranceRoute.js';

/** Tila -> mikä paneelin osa näytetään. Käsittelyvaiheet (ja dialogit) näyttävät "tulkitsen". */
const PANEL = Object.freeze({
  [VOICE.REQUESTING_PERMISSION]: 'listening',
  [VOICE.LISTENING]: 'listening',
  [VOICE.TRANSCRIPT_READY]: 'transcript',
  [VOICE.CLASSIFYING]: 'processing',
  [VOICE.REVIEW]: 'processing',
  [VOICE.TARGET_SELECTION]: 'processing',
  [VOICE.CONFIRMATION]: 'processing',
  [VOICE.EXECUTING]: 'processing',
  [VOICE.ERROR]: 'error',
  [VOICE.TYPE_FALLBACK]: 'typefallback'
});

const PANELS = ['listening', 'transcript', 'processing', 'error', 'typefallback'];

/** commandBar.js:n vaiheraportti -> tilakoneen tapahtuma. */
const PHASE_EVENT = Object.freeze({
  review: VOICE_EVENT.PHASE_REVIEW,
  target_selection: VOICE_EVENT.PHASE_TARGET,
  confirmation: VOICE_EVENT.PHASE_CONFIRM,
  executing: VOICE_EVENT.PHASE_EXECUTE
});

const SpeechRecognitionCtor = typeof window !== 'undefined'
  ? (window.SpeechRecognition || window.webkitSpeechRecognition)
  : null;

let recognition = null;
let flow = initialVoiceState();
/** Estää samasta tunnistuksesta useamman tuloksen käsittelyn (onresult voi
 *  laueta uudelleen, ja onend ei saa näyttää virhettä enää tuloksen jälkeen). */
let resultHandled = false;
/** Elementti, joka avasi paneelin: sulkeminen palauttaa fokuksen sinne (näppäimistö- ja ruudunlukijakäyttäjä ei putoa sivun alkuun). */
let opener = null;

function showState(name) {
  for (const state of PANELS) {
    const node = maybe('voiceState-' + state);
    if (node) node.style.display = state === name ? 'block' : 'none';
  }
}

function setErrorText(message) {
  const node = maybe('voiceErrorMsg');
  if (node) node.textContent = message;
}

function openOverlay() {
  opener = typeof document !== 'undefined' ? document.activeElement : null;
  el('voiceOverlay').classList.add('open');
  el('voiceOverlay').setAttribute('aria-hidden', 'false');
  // Fokus paneeliin: ilman tätä se jää taustalle piilotetun sisällön päälle.
  const close = maybe('voiceCloseX');
  if (close) close.focus();
}

function closeOverlay() {
  el('voiceOverlay').classList.remove('open');
  el('voiceOverlay').setAttribute('aria-hidden', 'true');
  stopRecognition();
  resultHandled = false;
  if (opener && typeof opener.focus === 'function') opener.focus();
  opener = null;
}

function stopRecognition() {
  if (!recognition) return;
  try { recognition.stop(); } catch { /* jo pysähtynyt */ }
}

/** Ota tila käyttöön: mikrofoni, paneeli ja sulkeminen seuraavat tilasta. */
function applyState() {
  if (!micActive(flow)) stopRecognition();

  if (flow === VOICE.IDLE || flow === VOICE.SUCCESS) {
    closeOverlay();
    flow = VOICE.IDLE;
    return;
  }
  const panel = PANEL[flow];
  if (panel) showState(panel);
}

/** Yksi ainoa paikka, jossa tila muuttuu. Kielletty siirtymä ei tee mitään. */
function transition(event) {
  const before = flow;
  flow = nextVoiceState(flow, event, { micSupported: Boolean(recognition) });
  if (flow === before) return flow;
  logEvent('voice.state', { from: before, to: flow });
  applyState();
  return flow;
}

/** Virhe näkyviin: viesti ensin, sitten siirtymä ERROR-tilaan. */
function failWith(message, event = VOICE_EVENT.FAIL) {
  setErrorText(message);
  transition(event);
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
 * @param {object} [options] testejä varten: { confirmFn, chooseFn, fetchImpl, onPhase }
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
  if (!clean) {
    // Tyhjä teksti ei ole virhe: käyttäjä on poistanut sen. Pysytään muokkauksessa.
    const input = maybe('vfTranscriptText') || maybe('vfFallbackInput');
    if (input) input.focus();
    return;
  }

  // Selvä haku ("etsi ...") ei ole komento: avataan hakupaneeli hakusanalla.
  const route = routeUtterance(clean);
  if (route.kind === ROUTE.SEARCH) {
    logEvent('voice.route', { kind: 'search' });
    transition(VOICE_EVENT.CANCEL);
    openSearch(route.query);
    return;
  }

  transition(VOICE_EVENT.SUBMIT);
  if (flow !== VOICE.CLASSIFYING) return;

  logEvent('voice.submit', { chars: clean.length });
  const result = await runVoiceCommand(clean, {
    ...ui,
    onPhase: phase => { if (PHASE_EVENT[phase]) transition(PHASE_EVENT[phase]); }
  });
  logEvent('voice.result', { ok: Boolean(result.ok), status: String(result.status || '') });

  if (result.ok) {
    transition(VOICE_EVENT.DONE_OK);
    return;
  }
  if (result.status === 'cancelled') {
    // Käyttäjä perui vahvistuksen tai kohteenvalinnan -- ei virhe,
    // paneeli sulkeutuu hiljaa (sama kuin tekstikomennossa).
    transition(VOICE_EVENT.DONE_CANCELLED);
    return;
  }
  // 'rejected' | 'error' | 'empty' | 'duplicate' | suoritus epäonnistui:
  // näytetään syy ja tarjotaan uudelleenyritys tai kirjoitus, ei umpikuja.
  failWith(result.status === 'empty'
    ? 'En kuullut mitään. Yritä uudelleen.'
    : (result.reason || 'Komentoa ei ymmärretty.'), VOICE_EVENT.DONE_ERROR);
});

function setupRecognition() {
  if (!SpeechRecognitionCtor) return null;

  const instance = new SpeechRecognitionCtor();
  instance.lang = 'fi-FI';
  instance.continuous = false;
  instance.interimResults = true;

  instance.onstart = () => transition(VOICE_EVENT.MIC_STARTED);

  instance.onresult = event => {
    let transcript = '';
    for (let i = 0; i < event.results.length; i++) transcript += event.results[i][0].transcript;

    const display = maybe('voiceTranscript');
    if (display) display.textContent = transcript;

    if (event.results[event.results.length - 1].isFinal) {
      if (resultHandled) return;
      const clean = transcript.trim();
      if (!clean) { failWith('En kuullut mitään. Yritä uudelleen.'); return; }
      resultHandled = true;
      // Vain pituus: litterointi on käyttäjän puhetta eikä kuulu lokiin.
      logEvent('voice.transcript', { chars: clean.length });
      // Tunnistus voi päättyä ennen onstart-tapahtumaa: varmistetaan tila.
      transition(VOICE_EVENT.MIC_STARTED);
      transition(VOICE_EVENT.HEARD);
      showTranscriptReview(clean);
    }
  };

  instance.onerror = event => {
    logEvent('voice.error', { code: String(event.error || 'unknown') });
    if (event.error === 'no-speech') failWith('En kuullut mitään. Yritä uudelleen.');
    else if (event.error === 'not-allowed' || event.error === 'service-not-allowed') failWith('Mikrofonin käyttö estetty. Salli mikrofoni selaimen asetuksista.');
    else if (event.error === 'aborted') { /* käyttäjä sulki — ei virhe */ }
    else failWith('Puheentunnistus ei onnistunut.');
  };

  instance.onend = () => {
    if (micActive(flow) && !resultHandled) failWith('En kuullut mitään. Yritä uudelleen.');
  };

  return instance;
}

/** Aloita kuuntelu nykyisessä (avoimessa) tilassa. */
function beginListening() {
  resultHandled = false;
  const display = maybe('voiceTranscript');
  if (display) display.textContent = '';

  try {
    recognition.start();
  } catch {
    // start() heittää, jos tunnistus on jo käynnissä.
    failWith('Mikrofonia ei voitu käynnistää.');
  }
}

/** Avaa puhepaneeli ja aloita kuuntelu (tai uusi yritys, jos paneeli on jo auki). */
export function startVoiceFlow() {
  const wasClosed = flow === VOICE.IDLE;
  if (wasClosed) openOverlay();

  transition(wasClosed ? VOICE_EVENT.OPEN : VOICE_EVENT.RETRY);

  if (flow === VOICE.TYPE_FALLBACK) {
    const input = maybe('vfFallbackInput');
    if (input) input.focus();
    return;
  }
  if (flow === VOICE.REQUESTING_PERMISSION) beginListening();
}

/** Kytke puheohjauksen tapahtumat. Kutsutaan kerran käynnistyksessä. */
export function initVoice() {
  recognition = setupRecognition();

  el('fabBtn').addEventListener('click', startVoiceFlow);
  el('voiceErrorCloseBtn').addEventListener('click', () => transition(VOICE_EVENT.CANCEL));
  el('voiceErrorRetry').addEventListener('click', startVoiceFlow);
  el('voiceErrorTypeInstead').addEventListener('click', () => {
    transition(VOICE_EVENT.TYPE_INSTEAD);
    const input = maybe('vfFallbackInput');
    if (input) input.focus();
  });
  el('voiceCloseX').addEventListener('click', () => transition(VOICE_EVENT.CANCEL));

  el('voiceOverlay').addEventListener('click', event => {
    if (event.target.id === 'voiceOverlay') transition(VOICE_EVENT.CANCEL);
  });

  // Esc sulkee paneelin, kuten dialogeissa kuuluu.
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && el('voiceOverlay').classList.contains('open')) transition(VOICE_EVENT.CANCEL);
  });

  // EI TAUSTAMIKROFONIA: kun sivu piilotetaan tai suljetaan (välilehden vaihto,
  // sovellus taustalle, navigointi), mikrofoni sammuu ja kuunteleva paneeli sulkeutuu.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) transition(VOICE_EVENT.HIDDEN);
  });
  window.addEventListener('pagehide', () => transition(VOICE_EVENT.HIDDEN));

  // Tunnistettu teksti: käyttäjä voi muokata ennen tulkintaa.
  const transcriptInput = el('vfTranscriptText');
  el('voiceTranscriptContinueBtn').addEventListener('click', () => {
    submitTranscript(transcriptInput.value, {});
  });
  el('voiceTranscriptCancelBtn').addEventListener('click', () => transition(VOICE_EVENT.CANCEL));
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
