// Puheentunnistuksen sovitin: ääni sisään, teksti ulos.
//
// =====================================================================
// KOLME TAUSTAJÄRJESTELMÄÄ, YKSI RAJAPINTA
// =====================================================================
//
//   'native'  Android-sovellus: oma ManifestivalSpeech-liitännäinen
//             (android/app/src/main/java/fi/limitlesslife/manifestival/
//             SpeechPlugin.java), joka käyttää järjestelmän
//             puheentunnistinta (android.speech.SpeechRecognizer).
//   'web'     Selain: Web Speech API (SpeechRecognition).
//   'none'    Ei kumpaakaan: käyttäjä kirjoittaa.
//
// NATIIVIKUORESSA WEBVIEW'N SpeechRecognitionia EI KOSKAAN RAKENNETA.
// WebView pyytäisi mikrofonin Capacitorin kautta, ja Capacitor hylkää
// pyynnön, koska manifesti ei tarkoituksella julista WebView'n
// tarvitsemaa lisälupaa. Tulos olisi harhaanjohtava "salli mikrofoni
// selaimen asetuksista" -- asetus, jota Android-sovelluksessa ei ole.
//
// =====================================================================
// LUPA VAIN NAPAUTUKSESTA
// =====================================================================
//
// Mikrofonilupaa pyydetään VAIN startListening()-kutsun kautta, ja sitä
// kutsutaan vain käyttäjän napautuksesta. Natiivissa lupadialogi aukeaa
// liitännäisen listen()-metodissa, selaimessa recognition.start()-kutsusta.
// Moduulin lataus ja capability()-kysely eivät pyydä mitään. Lupatilan
// LUKU (refreshSpeechPermission) ei kysy lupaa.
//
// =====================================================================
// ÄÄNTÄ EI TALLENNETA, EI TAUSTAKUUNTELUA
// =====================================================================
//
// Tunnistin antaa tekstin, ja äänivirta katoaa. Tässä moduulissa ei ole
// tallennusta, puskuria eikä äänirajapintoja, eikä sellaisia saa lisätä.
// Kuuntelu päättyy aina: tulokseen, virheeseen, perumiseen,
// aikakatkaisuun tai siihen, että sovellus siirtyy taustalle.
// Natiiviliitännäinen perii kuuntelun lisäksi itse onPause-tapahtumassa.
//
// EI HEITÄ. Jokainen polku palauttaa `{ok: false, code}`; koodin
// suomenkielinen selitys tulee speechErrorMessage()-taulukosta.

import {
  isNativeShell, nativeSpeechPlugin, setSpeechPermissionState, PERMISSION, NATIVE_SPEECH_PLUGIN
} from './capabilities.js';

export { NATIVE_SPEECH_PLUGIN };

export const SPEECH_BACKEND = Object.freeze({
  NATIVE: 'native',
  WEB: 'web',
  NONE: 'none'
});

export const SPEECH_ERROR = Object.freeze({
  NO_SPEECH: 'no-speech',
  /** Käyttäjä ei sallinut mikrofonia (natiivissa voi kysyä uudelleen). */
  NOT_ALLOWED: 'not-allowed',
  /** Pysyvä kielto: vain järjestelmän asetukset auttavat. */
  BLOCKED: 'blocked',
  UNAVAILABLE: 'unavailable',
  LANGUAGE_UNAVAILABLE: 'language-unavailable',
  NETWORK: 'network',
  BUSY: 'busy',
  AUDIO: 'audio',
  TIMEOUT: 'timeout',
  /** Peruttu (käyttäjä, sovellus taustalle). Ei virhe. */
  ABORTED: 'aborted',
  START_FAILED: 'start-failed',
  UNKNOWN: 'unknown'
});

const KNOWN_CODES = new Set(Object.values(SPEECH_ERROR));

/** Kuuntelun yläraja. Osa tunnistimista ei koskaan lopeta itse. */
export const LISTEN_TIMEOUT_MS = 15000;

/** Liitännäisen tilatapahtuma (SpeechPlugin.java STATE_EVENT). */
export const NATIVE_STATE_EVENT = 'speechState';

/** Virheet, joissa "Yritä uudelleen" ei auta heti. */
const PERMANENT = new Set([
  SPEECH_ERROR.NOT_ALLOWED, SPEECH_ERROR.BLOCKED,
  SPEECH_ERROR.UNAVAILABLE, SPEECH_ERROR.LANGUAGE_UNAVAILABLE
]);

/** Elinkaaren perumiset, joita ei tehdä natiivin lupadialogin aikana. */
const LIFECYCLE_REASONS = new Set(['pause', 'hidden']);

// ----------------------------------------------------------- viestit

const COMMON_MESSAGES = Object.freeze({
  [SPEECH_ERROR.NO_SPEECH]: 'En kuullut mitään. Yritä uudelleen.',
  [SPEECH_ERROR.NETWORK]: 'Puheentunnistus tarvitsee verkkoyhteyden. Tarkista yhteys tai kirjoita sen sijaan.',
  [SPEECH_ERROR.BUSY]: 'Puheentunnistus on juuri nyt varattu. Yritä hetken päästä uudelleen.',
  [SPEECH_ERROR.AUDIO]: 'Mikrofonia ei voitu käyttää. Yritä uudelleen tai kirjoita sen sijaan.',
  [SPEECH_ERROR.TIMEOUT]: 'Kuuntelu keskeytyi. Yritä uudelleen.',
  [SPEECH_ERROR.LANGUAGE_UNAVAILABLE]: 'Suomen kielen puheentunnistus ei ole käytettävissä. Kirjoita sen sijaan.',
  [SPEECH_ERROR.START_FAILED]: 'Mikrofonia ei voitu käynnistää.',
  [SPEECH_ERROR.UNKNOWN]: 'Puheentunnistus ei onnistunut.',
  [SPEECH_ERROR.ABORTED]: ''
});

/**
 * Alustakohtaiset tekstit. YKSI taulukko: kutsupaikat (voice.js,
 * speechInput.js) eivät kirjoita omia versioitaan, jotta Android-
 * sovellus ei koskaan neuvo "selaimen asetuksiin".
 */
const PLATFORM_MESSAGES = Object.freeze({
  web: Object.freeze({
    [SPEECH_ERROR.NOT_ALLOWED]: 'Mikrofonin käyttö on estetty. Salli mikrofoni selaimen asetuksista tai kirjoita sen sijaan.',
    [SPEECH_ERROR.BLOCKED]: 'Mikrofonin käyttö on estetty. Salli mikrofoni selaimen asetuksista tai kirjoita sen sijaan.',
    [SPEECH_ERROR.UNAVAILABLE]: 'Tämä selain ei tunnista puhetta. Kirjoita sen sijaan.'
  }),
  native: Object.freeze({
    [SPEECH_ERROR.NOT_ALLOWED]: 'Mikrofonin käyttöä ei sallittu. Voit kirjoittaa sen sijaan, tai sallia mikrofonin, kun seuraavan kerran napautat mikrofonia.',
    [SPEECH_ERROR.BLOCKED]: 'Mikrofoni on estetty. Salli se kohdassa Asetukset → Sovellukset → Manifestival → Käyttöoikeudet → Mikrofoni, tai kirjoita sen sijaan.',
    [SPEECH_ERROR.UNAVAILABLE]: 'Puheentunnistus ei ole käytettävissä tässä puhelimessa tai sovellusversiossa. Kirjoita sen sijaan.'
  })
});

/**
 * Käyttäjälle näytettävä selitys virhekoodille. Peruttu ('aborted') on
 * tyhjä: peruminen ei ole virhe eikä siitä näytetä viestiä.
 */
export function speechErrorMessage(code, native = isNativeShell()) {
  const known = KNOWN_CODES.has(code) ? code : SPEECH_ERROR.UNKNOWN;
  const platform = PLATFORM_MESSAGES[native ? 'native' : 'web'];
  if (Object.prototype.hasOwnProperty.call(platform, known)) return platform[known];
  return COMMON_MESSAGES[known];
}

/** Auttaako uusi yritys heti? Ei, jos lupa puuttuu tai tunnistinta ei ole. */
export function isPermanentSpeechError(code) {
  return PERMANENT.has(code);
}

// ------------------------------------------------------ taustajärjestelmä

/** Selaimen tunnistin. Natiivikuoressa aina null (ks. otsikko). */
function webRecognitionCtor() {
  if (isNativeShell()) return null;
  return globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition || null;
}

/** Millä tunnistetaan tällä alustalla: 'native' | 'web' | 'none'. */
export function speechBackend() {
  if (isNativeShell()) return nativeSpeechPlugin() ? SPEECH_BACKEND.NATIVE : SPEECH_BACKEND.NONE;
  return webRecognitionCtor() ? SPEECH_BACKEND.WEB : SPEECH_BACKEND.NONE;
}

function permissionFrom(value) {
  if (value === 'granted') return PERMISSION.GRANTED;
  // 'prompt-with-rationale' = kerran kielletty, voidaan kysyä uudelleen.
  if (value === 'denied' || value === 'prompt-with-rationale') return PERMISSION.DENIED;
  return PERMISSION.PROMPT;
}

/** Päivitä lupavälimuisti kuuntelun lopputuloksesta. */
function rememberOutcome(outcome) {
  if (outcome.ok) setSpeechPermissionState(PERMISSION.GRANTED);
  else if (outcome.code === SPEECH_ERROR.NOT_ALLOWED || outcome.code === SPEECH_ERROR.BLOCKED) {
    setSpeechPermissionState(PERMISSION.DENIED);
  }
}

/**
 * Lue mikrofoniluvan tila. EI KOSKAAN kysy lupaa.
 * @returns {Promise<string>} PERMISSION-arvo
 */
export async function refreshSpeechPermission() {
  const plugin = nativeSpeechPlugin();
  try {
    if (plugin && typeof plugin.checkPermissions === 'function') {
      const result = await plugin.checkPermissions();
      const state = permissionFrom(result && result.microphone);
      setSpeechPermissionState(state);
      return state;
    }
    const permissions = !isNativeShell() && globalThis.navigator && globalThis.navigator.permissions;
    if (webRecognitionCtor() && permissions && typeof permissions.query === 'function') {
      const status = await permissions.query({ name: 'microphone' });
      const state = permissionFrom(status && status.state);
      setSpeechPermissionState(state);
      return state;
    }
  } catch {
    // Tila jää ennalleen: tuntematon ei ole "myönnetty".
  }
  return PERMISSION.PROMPT;
}

/** Voiko järjestelmän sovellusasetukset avata (natiivi "Avaa asetukset"). */
export function canOpenSpeechSettings() {
  const plugin = nativeSpeechPlugin();
  return Boolean(plugin && typeof plugin.openSettings === 'function');
}

/**
 * Avaa tämän sovelluksen järjestelmäasetukset (Käyttöoikeudet).
 * VAIN käyttäjän napautuksesta. EI HEITÄ.
 * @returns {Promise<boolean>} avautuiko
 */
export async function openSpeechSettings() {
  if (!canOpenSpeechSettings()) return false;
  try {
    const result = await nativeSpeechPlugin().openSettings();
    return Boolean(result && result.ok);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------- kuuntelu

/** Käynnissä oleva kuuntelu. Mikrofoneja on aina enintään yksi. */
let active = null;

function call(fn, ...args) {
  if (typeof fn !== 'function') return;
  try { fn(...args); } catch { /* kutsujan virhe ei saa jättää mikrofonia auki */ }
}

/**
 * Yksi kuuntelukerta: lupaus, aikakatkaisu ja kertavastaus.
 *
 * `stopBackend` katkaisee taustajärjestelmän (abort / plugin.cancel).
 * Sitä kutsutaan VAIN kun kuuntelu perutaan tai aikakatkaistaan -- ei
 * silloin, kun tunnistin itse päätti kuuntelun tulokseen tai virheeseen.
 */
function createSession({ timeoutMs, stopBackend, onSettled }) {
  let resolveResult;
  let timer = null;
  const session = {
    phase: 'starting',
    settled: false,
    result: new Promise(resolve => { resolveResult = resolve; }),
    arm() {
      session.disarm();
      timer = setTimeout(() => session.cancel(SPEECH_ERROR.TIMEOUT), timeoutMs);
    },
    disarm() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
    /** Vastaa kerran. Toinen vastaus (myöhäinen tulos perumisen jälkeen) ohitetaan. */
    finish(outcome) {
      if (session.settled) return;
      session.settled = true;
      session.disarm();
      if (active === session) active = null;
      rememberOutcome(outcome);
      call(onSettled);
      resolveResult(outcome);
    },
    cancel(code = SPEECH_ERROR.ABORTED) {
      if (session.settled) return;
      call(stopBackend);
      session.finish({ ok: false, code });
    }
  };
  return session;
}

function normalizeNativeResult(value) {
  if (value && value.ok === true) {
    const text = typeof value.text === 'string' ? value.text.trim() : '';
    return text ? { ok: true, text } : { ok: false, code: SPEECH_ERROR.NO_SPEECH };
  }
  const code = value && KNOWN_CODES.has(value.code) ? value.code : SPEECH_ERROR.UNKNOWN;
  return { ok: false, code };
}

function listenNative(plugin, { lang, timeoutMs, onStart, onPermission }) {
  let listener = null;
  const session = createSession({
    timeoutMs,
    stopBackend: () => { Promise.resolve(plugin.cancel()).catch(() => {}); },
    onSettled: () => {
      Promise.resolve(listener)
        .then(handle => { if (handle && typeof handle.remove === 'function') return handle.remove(); return undefined; })
        .catch(() => {});
    }
  });

  // Tilatapahtumat: lupadialogin aikana aikakatkaisu ei kulu (käyttäjä
  // päättää luvasta omaan tahtiinsa, eikä mikrofoni ole silloin auki).
  if (typeof plugin.addListener === 'function') {
    try {
      listener = plugin.addListener(NATIVE_STATE_EVENT, event => {
        if (session.settled) return;
        const state = event && event.state;
        if (state === 'permission') {
          session.phase = 'permission';
          session.disarm();
          call(onPermission);
        } else if (state === 'starting') {
          session.phase = 'starting';
          session.arm();
        } else if (state === 'listening') {
          session.phase = 'listening';
          call(onStart);
        }
      });
    } catch {
      listener = null;
    }
  }

  session.arm();
  let pending;
  try {
    pending = plugin.listen({ lang });
  } catch {
    session.finish({ ok: false, code: SPEECH_ERROR.START_FAILED });
    return session;
  }
  Promise.resolve(pending).then(
    value => session.finish(normalizeNativeResult(value)),
    () => session.finish({ ok: false, code: SPEECH_ERROR.UNKNOWN })
  );
  return session;
}

function webErrorCode(error) {
  switch (error) {
    case 'no-speech': return SPEECH_ERROR.NO_SPEECH;
    case 'not-allowed':
    case 'service-not-allowed': return SPEECH_ERROR.NOT_ALLOWED;
    case 'aborted': return SPEECH_ERROR.ABORTED;
    case 'network': return SPEECH_ERROR.NETWORK;
    case 'audio-capture': return SPEECH_ERROR.AUDIO;
    case 'language-not-supported': return SPEECH_ERROR.LANGUAGE_UNAVAILABLE;
    default: return SPEECH_ERROR.UNKNOWN;
  }
}

function listenWeb(Ctor, { lang, timeoutMs, onStart, onInterim }) {
  let recognition = null;
  let released = false;
  // Peruminen on abort() eikä stop(): stop() pyytää tunnistinta viimeistelemään
  // ja toimittamaan tuloksen, jota kukaan ei enää halua. Sama kutsu
  // vapauttaa mikrofonin myös tuloksen jälkeen; tunnistin saa sen vain kerran.
  const abort = () => {
    if (!recognition || released) return;
    released = true;
    try { recognition.abort(); } catch { /* jo pysähtynyt */ }
  };
  const session = createSession({ timeoutMs, stopBackend: abort, onSettled: abort });

  try {
    recognition = new Ctor();
  } catch {
    session.finish({ ok: false, code: SPEECH_ERROR.START_FAILED });
    return session;
  }

  const interim = typeof onInterim === 'function';
  recognition.lang = lang;
  recognition.continuous = false;
  recognition.interimResults = interim;
  recognition.maxAlternatives = 1;

  recognition.onstart = () => {
    if (session.settled) return;
    session.phase = 'listening';
    call(onStart);
  };

  recognition.onresult = event => {
    if (session.settled) return;
    const results = (event && event.results) || [];
    let transcript = '';
    for (let i = 0; i < results.length; i += 1) transcript += results[i][0].transcript;
    const last = results[results.length - 1];
    if (interim && !(last && last.isFinal)) {
      call(onInterim, transcript);
      return;
    }
    const clean = transcript.trim();
    session.finish(clean ? { ok: true, text: clean } : { ok: false, code: SPEECH_ERROR.NO_SPEECH });
  };

  recognition.onerror = event => {
    session.finish({ ok: false, code: webErrorCode(event && event.error) });
  };

  // `onend` ilman tulosta = mitään ei kuultu. Ilman tätä lupaus jäisi
  // roikkumaan ja käyttöliittymä näyttäisi kuuntelevan ikuisesti.
  recognition.onend = () => {
    released = true;
    session.finish({ ok: false, code: SPEECH_ERROR.NO_SPEECH });
  };

  session.arm();
  try {
    recognition.start();
  } catch {
    session.finish({ ok: false, code: SPEECH_ERROR.START_FAILED });
  }
  return session;
}

let lifecycleBound = false;

/**
 * Sivun piilotus tai sulkeminen katkaisee kuuntelun, oli kutsuja kuka
 * tahansa. Kytketään kerran, ensimmäisellä kuuntelulla.
 */
function bindHiddenCancelOnce() {
  if (lifecycleBound) return;
  if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;
  lifecycleBound = true;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) cancelActiveListening({ reason: 'hidden' });
  });
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('pagehide', () => cancelActiveListening({ reason: 'pagehide' }));
  }
}

/**
 * Kuuntele kerran. KUTSU VAIN KÄYTTÄJÄN NAPAUTUKSESTA: tämä voi avata
 * mikrofonin lupadialogin.
 *
 * @param {object} [options]
 * @param {string} [options.lang='fi-FI']
 * @param {number} [options.timeoutMs=15000] kuuntelun yläraja (lupadialogi ei kuluta sitä)
 * @param {Function} [options.onStart]      mikrofoni on auki
 * @param {Function} [options.onPermission] järjestelmän lupadialogi on auki (natiivi)
 * @param {Function} [options.onInterim]    väliaikainen teksti (vain selain)
 * @returns {{result: Promise<{ok:true,text:string}|{ok:false,code:string}>, cancel: () => void}}
 */
export function startListening({
  lang = 'fi-FI', timeoutMs = LISTEN_TIMEOUT_MS, onStart, onPermission, onInterim
} = {}) {
  // Uusi kuuntelu korvaa vanhan: kaksi yhtäaikaista mikrofonia ei ole koskaan oikein.
  if (active) active.cancel(SPEECH_ERROR.ABORTED);

  const safeLang = /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8}){0,2}$/.test(String(lang)) ? String(lang) : 'fi-FI';
  const limit = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : LISTEN_TIMEOUT_MS;

  const backend = speechBackend();
  let session;
  if (backend === SPEECH_BACKEND.NATIVE) {
    session = listenNative(nativeSpeechPlugin(), { lang: safeLang, timeoutMs: limit, onStart, onPermission });
  } else if (backend === SPEECH_BACKEND.WEB) {
    session = listenWeb(webRecognitionCtor(), { lang: safeLang, timeoutMs: limit, onStart, onInterim });
  } else {
    session = createSession({ timeoutMs: limit });
    session.finish({ ok: false, code: SPEECH_ERROR.UNAVAILABLE });
  }

  if (!session.settled) {
    active = session;
    bindHiddenCancelOnce();
  }
  return { result: session.result, cancel: () => session.cancel(SPEECH_ERROR.ABORTED) };
}

/** Onko kuuntelu käynnissä (mikrofoni auki tai aukeamassa). */
export function isListening() {
  return active !== null;
}

/** Onko natiivi lupadialogi auki juuri nyt. */
export function isAwaitingPermission() {
  return Boolean(active && active.phase === 'permission');
}

/**
 * Katkaise käynnissä oleva kuuntelu. Kuuntelun lupaus ratkeaa koodilla
 * 'aborted', joten kutsuja (puhepaneeli, sanelu) sulkeutuu hiljaa.
 *
 * `reason: 'pause' | 'hidden'` (elinkaari) EI peru natiivin lupadialogin
 * aikana: Android keskeyttää aktiviteetin (onPause) juuri siksi, että
 * lupadialogi on sen päällä. Jos sovellus oikeasti siirtyy taustalle
 * dialogin aikana, liitännäinen perii odotuksen itse (handleOnStop).
 *
 * @returns {boolean} peruttiinko jotain
 */
export function cancelActiveListening({ reason = 'user' } = {}) {
  if (!active) return false;
  if (LIFECYCLE_REASONS.has(reason) && active.phase === 'permission') return false;
  active.cancel(SPEECH_ERROR.ABORTED);
  return true;
}

/** Vain testejä varten: unohda käynnissä oleva kuuntelu perumatta sitä. */
export function resetSpeechForTests() {
  active = null;
}
