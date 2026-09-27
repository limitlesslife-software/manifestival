// Puheohjaus: yksi tulkintaputki tekstille ja puheelle.
//
// Virta:
//   mikrofoni -> puheentunnistus (src/platform/speech.js: selain tai
//                Android-sovelluksen oma liitännäinen) -> teksti
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
//     siirtymä muuhun tilaan KATKAISEE tunnistuksen (abort, ei stop), myös
//     sivun piilottaminen (visibilitychange/pagehide) ja sovelluksen
//     siirtyminen taustalle (main.js onPause). Katkaistun kuuntelun
//     myöhäinen tulos ohitetaan. Ei taustamikrofonia.
//   - Kuuntelulla on yläraja (15 s, speech.js): hiljainen tunnistin ei jätä
//     paneelia "Kuuntelen…"-tilaan.
//   - Pysyvä virhe (lupa estetty) ei tarjoa "Yritä uudelleen" -painiketta,
//     joka epäonnistuisi samalla tavalla; Android-sovelluksessa tarjotaan
//     "Avaa asetukset".
//   - LITTEROINTI EI KOSKAAN mene suoraan tallennukseen: käyttäjä näkee ja
//     voi muokata tekstin ennen kuin se lähtee tulkittavaksi.
//   - Kohteenvalinta ja vahvistus näytetään ui/confirm.js:n jaetulla
//     dialogilla, joka kerrostuu tämän paneelin päälle.
//
// Jos alusta ei tue puheentunnistusta tai verkko pettää, käyttäjä voi aina
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

/**
 * Tila -> mikä paneelin osa näytetään. Käsittelyvaiheet (ja dialogit) näyttävät "tulkitsen".
 *
 * Luvan odotus on oma näkymänsä: "Kuuntelen…" järjestelmän lupadialogin
 * aikana väittäisi mikrofonin olevan jo auki.
 */
const PANEL = Object.freeze({
  [VOICE.REQUESTING_PERMISSION]: 'permission',
  [VOICE.LISTENING]: 'listening',
  [VOICE.TRANSCRIPT_READY]: 'transcript',
  [VOICE.CLASSIFYING]: 'processing',
  [VOICE.REVIEW]: 'processing',
  [VOICE.TARGET_SELECTION]: 'processing',
  [VOICE.CONFIRMATION]: 'processing',
  [VOICE.EXECUTING]: 'processing',
  [VOICE.ERROR]: 'error',
  [VOICE.MIC_DENIED]: 'error',
  [VOICE.TYPE_FALLBACK]: 'typefallback'
});

const PANELS = ['permission', 'listening', 'transcript', 'processing', 'error', 'typefallback'];

/** commandBar.js:n vaiheraportti -> tilakoneen tapahtuma. */
const PHASE_EVENT = Object.freeze({
  review: VOICE_EVENT.PHASE_REVIEW,
  target_selection: VOICE_EVENT.PHASE_TARGET,
  confirmation: VOICE_EVENT.PHASE_CONFIRM,
  executing: VOICE_EVENT.PHASE_EXECUTE
});

/**
 * Käynnissä oleva kuuntelu: `{ handle }`, jossa handle on
 * speech.startListening():n paluuarvo. Vain TÄMÄN kuuntelun tulos
 * käsitellään; katkaistun tai korvatun kuuntelun myöhäinen tulos ohitetaan.
 */
let session = null;
let flow = initialVoiceState();
/** Viimeisimmän kuuntelun virhekoodi: ratkaisee, tarjotaanko "Avaa asetukset". */
let lastErrorCode = '';
/** Elementti, joka avasi paneelin: sulkeminen palauttaa fokuksen sinne (näppäimistö- ja ruudunlukijakäyttäjä ei putoa sivun alkuun). */
let opener = null;

/** Voiko tällä alustalla kuunnella lainkaan? Natiivikuoressa vain omalla liitännäisellä. */
function micSupported() {
  const state = speech.capability();
  return state.supported && state.implemented;
}

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
  lastErrorCode = '';
  if (opener && typeof opener.focus === 'function') opener.focus();
  opener = null;
}

/**
 * Katkaise kuuntelu. abort, ei stop: kesken jäänyt tulos hylätään eikä
 * sitä käsitellä (ei tekstiä kenttään, ei fokusta, ei lokia).
 */
function stopRecognition() {
  if (!session) return;
  const current = session;
  session = null;
  if (current.handle) current.handle.cancel();
}

/** Näytä tai piilota painike. style.display, koska .voice-mic-btn asettaa display:flex. */
function showButton(id, visible) {
  const node = maybe(id);
  if (node) node.style.display = visible ? '' : 'none';
}

/**
 * Virhepaneelin toiminnot. Pysyvä virhe (MIC_DENIED) ei tarjoa
 * uudelleenyritystä, joka epäonnistuisi samalla tavalla; kirjoittaminen
 * on aina tarjolla. Android-sovelluksen pysyvä kielto ('blocked') saa
 * "Avaa asetukset" -painikkeen, koska vain järjestelmän asetukset auttavat.
 */
function showErrorActions() {
  const denied = flow === VOICE.MIC_DENIED;
  showButton('voiceErrorRetry', !denied);
  showButton('voiceErrorSettings', denied && lastErrorCode === 'blocked' && speech.canOpenSettings());
}

/** Kirjoituspaneeli kertoo, miksi puhe ei ole käytettävissä (jos ei ole). */
function showFallbackReason() {
  const node = maybe('vfFallbackReason');
  if (!node) return;
  const state = speech.capability();
  node.textContent = state.supported && state.implemented ? '' : (state.reason || '');
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
  if (panel === 'error') showErrorActions();
  if (panel === 'typefallback') showFallbackReason();
  if (panel) showState(panel);
}

/** Yksi ainoa paikka, jossa tila muuttuu. Kielletty siirtymä ei tee mitään. */
function transition(event) {
  const before = flow;
  flow = nextVoiceState(flow, event, { micSupported: micSupported() });
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

/**
 * Kuuntelun lopputulos. Käsitellään VAIN, jos tämä on yhä se kuuntelu,
 * jonka paneeli aloitti: peruttu (X, Esc, piilotus) tai korvattu kuuntelu
 * ei saa kirjoittaa tekstiä kenttään eikä siirtää fokusta.
 */
function onListenResult(current, result) {
  if (session !== current) return;
  session = null;
  if (!micActive(flow)) return;

  if (result.ok) {
    const clean = result.text;
    // Vain pituus: litterointi on käyttäjän puhetta eikä kuulu lokiin.
    logEvent('voice.transcript', { chars: clean.length });
    // Tunnistus voi päättyä ennen onStart-kutsua: varmistetaan tila.
    transition(VOICE_EVENT.MIC_STARTED);
    transition(VOICE_EVENT.HEARD);
    showTranscriptReview(clean);
    return;
  }

  const code = String(result.code || 'unknown');
  logEvent('voice.error', { code });
  if (code === 'aborted') {
    // Järjestelmä keskeytti (sovellus taustalle, toinen sovellus otti
    // mikrofonin): ei virhe. Paneeli sulkeutuu hiljaa, kuten piilotuksessa.
    transition(VOICE_EVENT.HIDDEN);
    return;
  }
  lastErrorCode = code;
  failWith(speech.errorMessage(code),
    speech.isPermanentError(code) ? VOICE_EVENT.FAIL_PERMANENT : VOICE_EVENT.FAIL);
}

/** Aloita kuuntelu nykyisessä (avoimessa) tilassa. Vain käyttäjän napautuksesta. */
function beginListening() {
  stopRecognition();
  lastErrorCode = '';
  const display = maybe('voiceTranscript');
  if (display) display.textContent = '';

  const current = { handle: null };
  session = current;
  current.handle = speech.startListening({
    lang: 'fi-FI',
    onStart: () => { if (session === current) transition(VOICE_EVENT.MIC_STARTED); },
    // Väliaikainen teksti näytetään vain kuunnellessa (selain; natiivi ei anna sitä).
    onInterim: interim => { if (session === current && display) display.textContent = interim; }
  });
  current.handle.result.then(result => onListenResult(current, result));
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

/**
 * Nollaa puhepaneeli uloskirjautuessa ja tilinvaihdossa (main.js onSignedOut).
 *
 * TARKISTUSVAIHE SÄILYY PIILOTUKSEN YLI, UUSI KÄYTTÄJÄ EI. Tunnistettu teksti
 * (TRANSCRIPT_READY) ja kirjoitettu varateksti (TYPE_FALLBACK) jäävät
 * tarkoituksella paikalleen, kun sivu piilotetaan. Paneeli on kuitenkin
 * #appin sisällä: kirjautumisportti vain piilottaa sen, ja seuraavan
 * käyttäjän kirjautuminen paljastaisi edellisen sanelun avoimessa
 * paneelissa — ja "Jatka" lähettäisi sen uuden käyttäjän tunnuksilla.
 *
 * Fokusta ei palauteta avaajaan: se kuului päättyneelle istunnolle, ja
 * kirjautumisportti ottaa fokuksen itse.
 */
export function resetVoice() {
  stopRecognition();
  flow = initialVoiceState();
  lastErrorCode = '';
  opener = null;
  for (const id of ['vfTranscriptText', 'vfFallbackInput']) {
    const input = maybe(id);
    if (input) input.value = '';
  }
  const interim = maybe('voiceTranscript');
  if (interim) interim.textContent = '';
  const overlay = maybe('voiceOverlay');
  if (overlay) {
    overlay.classList.remove('open');
    overlay.setAttribute('aria-hidden', 'true');
  }
}

/**
 * Kytke puheohjauksen tapahtumat. Kutsutaan kerran käynnistyksessä.
 *
 * EI KYSY MIKROFONILUPAA. Lupa kysytään vasta kun käyttäjä napauttaa
 * mikrofonia (startVoiceFlow -> speech.startListening). Tässä vain luetaan
 * nykyinen lupatila asetusnäkymää varten; luku ei avaa dialogia.
 */
export function initVoice() {
  speech.refreshPermission().catch(() => { /* tila jää "ei kysytty" */ });

  el('fabBtn').addEventListener('click', startVoiceFlow);
  el('voiceErrorCloseBtn').addEventListener('click', () => transition(VOICE_EVENT.CANCEL));
  el('voiceErrorRetry').addEventListener('click', startVoiceFlow);
  el('voiceErrorTypeInstead').addEventListener('click', () => {
    transition(VOICE_EVENT.TYPE_INSTEAD);
    const input = maybe('vfFallbackInput');
    if (input) input.focus();
  });
  // Android: pysyvästi estetty mikrofoni. Asetuksista palattuaan käyttäjä
  // napauttaa mikrofonia uudelleen; paneeli suljetaan, jottei vanha virhe jää näkyviin.
  el('voiceErrorSettings').addEventListener('click', async () => {
    const opened = await speech.openSettings();
    if (opened) transition(VOICE_EVENT.CANCEL);
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
  // Poikkeus: Androidin oma lupadialogi ei ole "taustalle siirtyminen", vaikka
  // se keskeyttää aktiviteetin; liitännäinen perii odotuksen itse, jos
  // sovellus oikeasti poistuu näkyvistä (ks. src/platform/speech.js).
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && !speech.isAwaitingPermission()) transition(VOICE_EVENT.HIDDEN);
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

  // Kirjoitettu varapolku (ei puheentunnistusta tällä alustalla): sama
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
 * Tuki ei yksin riitä: Android-kuori tukee puhetta, mutta vain jos
 * puheliitännäinen on mukana (implemented).
 */
export function speechSupported() {
  return micSupported();
}
