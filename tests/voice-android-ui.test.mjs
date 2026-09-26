// Puheohjaus ja sanelu käyttöliittymässä: Android-liitännäinen ja selain.
//
// Ajaa oikeaa src/app/voice.js:ää, src/app/views/inbox.js:n sanelua,
// ensikäytön opastusta ja profiilin tietosuojaosiota tynkä-DOMia vasten.
// Tynkä tuntee vain index.html:ssä oikeasti olevat tunnisteet, joten
// puuttuva elementti näkyy testissä eikä vasta laitteella.
//
// Laitetta ei käytetä. Puheliitännäinen ja selaimen tunnistin ovat
// kaksoiskappaleita; ks. tests/speech-platform.test.mjs.

import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import { read, readCode } from './helpers/sources.mjs';

// ------------------------------------------------------------ tynkä-DOM

const HTML_IDS = new Set([...read('index.html').matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
/** Tilin poisto piirtää oman osionsa; se ei kuulu näihin testeihin. */
const NOT_RENDERED = new Set(['pfAccountDeletion']);

function stubElement(id) {
  const listeners = {};
  const attributes = {};
  const classes = new Set();
  const node = {
    id, tagName: 'DIV', value: '', textContent: '', innerHTML: '', hidden: false, disabled: false,
    style: {}, dataset: {}, focused: 0, childElementCount: 0,
    classList: {
      add: c => classes.add(c), remove: c => classes.delete(c),
      contains: c => classes.has(c), toggle: (c, on) => (on ? classes.add(c) : classes.delete(c))
    },
    setAttribute: (k, v) => { attributes[k] = String(v); },
    getAttribute: k => attributes[k] ?? null,
    removeAttribute: k => { delete attributes[k]; },
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
    removeEventListener: () => {},
    dispatch: (type, extra = {}) => (listeners[type] || [])
      .map(fn => fn({ target: node, preventDefault() {}, ...extra })),
    focus() { node.focused += 1; globalThis.document.activeElement = node; },
    closest: () => null, querySelector: () => null, querySelectorAll: () => [],
    appendChild: () => {}, remove: () => {}
  };
  return node;
}

const elements = new Map();
const documentListeners = {};
const windowListeners = {};
globalThis.document = {
  hidden: false,
  activeElement: null,
  getElementById(id) {
    if (!HTML_IDS.has(id) || NOT_RENDERED.has(id)) return null;
    if (!elements.has(id)) elements.set(id, stubElement(id));
    return elements.get(id);
  },
  addEventListener: (type, fn) => { (documentListeners[type] ||= []).push(fn); },
  dispatch: type => (documentListeners[type] || []).forEach(fn => fn({})),
  createElement: () => stubElement(null),
  querySelectorAll: () => [],
  body: { appendChild: () => {}, removeChild: () => {}, classList: { toggle() {} } }
};
globalThis.window = {
  addEventListener: (type, fn) => { (windowListeners[type] ||= []).push(fn); }
};
const $ = id => globalThis.document.getElementById(id);

// ----------------------------------------------------- kaksoiskappaleet

function fakeSpeechPlugin({ microphone = 'prompt' } = {}) {
  const calls = { listen: [], cancel: 0, requestPermissions: 0, checkPermissions: 0, openSettings: 0 };
  const listeners = new Map();
  let pending = null;
  return {
    calls,
    emit(state) { for (const fn of listeners.get('speechState') || []) fn({ state }); },
    settle(value) { if (pending) { const resolve = pending; pending = null; resolve(value); } },
    addListener(event, fn) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(fn);
      return { remove: async () => {} };
    },
    listen(options) {
      calls.listen.push(options);
      return new Promise(resolve => { pending = resolve; });
    },
    async cancel() { calls.cancel += 1; this.settle({ ok: false, code: 'aborted' }); },
    async checkPermissions() { calls.checkPermissions += 1; return { microphone }; },
    async requestPermissions() { calls.requestPermissions += 1; return { microphone: 'granted' }; },
    async openSettings() { calls.openSettings += 1; return { ok: true }; }
  };
}

function installShell(plugin) {
  globalThis.Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => 'android',
    Plugins: plugin ? { ManifestivalSpeech: plugin } : {}
  };
}

class FakeRecognition {
  static instances = [];
  constructor() { this.calls = []; FakeRecognition.instances.push(this); }
  start() { this.calls.push('start'); }
  stop() { this.calls.push('stop'); }
  abort() { this.calls.push('abort'); }
  final(text) { this.onresult({ results: [Object.assign([{ transcript: text }], { isFinal: true })] }); }
}

const flush = async () => { for (let i = 0; i < 5; i += 1) await new Promise(resolve => setImmediate(resolve)); };

const PANELS = ['permission', 'listening', 'transcript', 'processing', 'error', 'typefallback'];
const visiblePanel = () => PANELS.filter(name => $('voiceState-' + name).style.display === 'block');
const overlayOpen = () => $('voiceOverlay').classList.contains('open');
const shown = id => $(id).style.display !== 'none';

async function captureLogs(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.map(arg => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
  try { await fn(); } finally { console.log = original; }
  return lines.join('\n');
}

// ------------------------------------------------------------ moduulit

const speechModule = await import('../src/platform/speech.js');
const capabilities = await import('../src/platform/capabilities.js');
const voice = await import('../src/app/voice.js');
const inbox = await import('../src/app/views/inbox.js');
const speechInput = await import('../src/app/speechInput.js');
const onboarding = await import('../src/app/onboarding.js');
const profile = await import('../src/app/views/profile.js');

function resetGlobals() {
  delete globalThis.Capacitor;
  delete globalThis.webkitSpeechRecognition;
  delete globalThis.SpeechRecognition;
  FakeRecognition.instances = [];
  globalThis.document.hidden = false;
}

beforeEach(() => {
  resetGlobals();
  speechModule.resetSpeechForTests();
  capabilities.resetSpeechPermissionState();
});

afterEach(async () => {
  // Paneeli kiinni ja kuuntelu poikki: seuraava testi alkaa IDLE-tilasta.
  if (overlayOpen()) $('voiceCloseX').dispatch('click');
  speechModule.cancelActiveListening();
  speechInput.cancelDictation();
  await flush();
  resetGlobals();
});

// ================================================ käynnistys ei kysy lupaa

test('VOICE-AND-1/2 KRIITTINEN: initVoice ei pyydä mikrofonilupaa eikä kuuntele', async () => {
  const plugin = fakeSpeechPlugin({ microphone: 'granted' });
  installShell(plugin);
  voice.initVoice();
  onboarding.initOnboarding();
  await flush();
  assert.equal(plugin.calls.listen.length, 0);
  assert.equal(plugin.calls.requestPermissions, 0);
  assert.equal(plugin.calls.checkPermissions, 1, 'vain tilan luku');
  assert.equal(capabilities.capability(capabilities.CAPABILITY.SPEECH).permission, 'granted');
});

// ======================================================== natiivi: polku

test('natiivi: napautus -> luvan odotus -> kuuntelu -> teksti tarkistettavaksi', async () => {
  const plugin = fakeSpeechPlugin();
  installShell(plugin);

  $('fabBtn').dispatch('click');
  assert.equal(overlayOpen(), true);
  assert.deepEqual(visiblePanel(), ['permission'], 'luvan odotus ei saa väittää kuuntelevansa');
  assert.deepEqual(plugin.calls.listen, [{ lang: 'fi-FI' }]);

  plugin.emit('permission');
  assert.deepEqual(visiblePanel(), ['permission']);
  plugin.emit('starting');
  plugin.emit('listening');
  assert.deepEqual(visiblePanel(), ['listening']);

  plugin.settle({ ok: true, text: 'osta maitoa' });
  await flush();
  assert.deepEqual(visiblePanel(), ['transcript']);
  assert.equal($('vfTranscriptText').value, 'osta maitoa');
  assert.equal(plugin.calls.requestPermissions, 0, 'lupa kysytään listen()-kutsussa, ei erikseen');
});

test('natiivi: lupadialogin aiheuttama piilotus ei sulje paneelia; oikea piilotus sulkee', async () => {
  const plugin = fakeSpeechPlugin();
  installShell(plugin);
  $('fabBtn').dispatch('click');
  plugin.emit('permission');

  globalThis.document.hidden = true;
  globalThis.document.dispatch('visibilitychange');
  await flush();
  assert.equal(overlayOpen(), true);
  assert.equal(plugin.calls.cancel, 0);

  // Lupa myönnetty, mikrofoni auki, sitten sovellus taustalle.
  globalThis.document.hidden = false;
  plugin.emit('starting');
  plugin.emit('listening');
  globalThis.document.hidden = true;
  globalThis.document.dispatch('visibilitychange');
  await flush();
  assert.equal(overlayOpen(), false);
  assert.equal(plugin.calls.cancel, 1);
});

test('VOICE-AND-4: sovelluksen pause (main.js onPause) katkaisee kuuntelun ja sulkee paneelin', async () => {
  const main = readCode('src/app/main.js');
  const onPause = main.slice(main.indexOf('onPause: () => {'), main.indexOf('// 5. Service worker'));
  assert.match(onPause, /speech\.cancelActiveListening\(\{ reason: 'pause' \}\)/,
    'main.js:n onPause ei katkaise puhetta');

  const plugin = fakeSpeechPlugin();
  installShell(plugin);
  $('fabBtn').dispatch('click');
  plugin.emit('listening');
  // Sama kutsu kuin main.js:n onPause.
  speechModule.cancelActiveListening({ reason: 'pause' });
  await flush();
  assert.equal(plugin.calls.cancel, 1);
  assert.equal(overlayOpen(), false, 'paneeli jäi kuuntelemaan taustalle siirron jälkeen');
});

// ==================================================== VOICE-AND-5: lupa

test('VOICE-AND-5: natiivi pysyvä kielto -> ei "Yritä uudelleen", on "Avaa asetukset" ja "Kirjoita sen sijaan"', async () => {
  const plugin = fakeSpeechPlugin();
  installShell(plugin);
  $('fabBtn').dispatch('click');
  plugin.settle({ ok: false, code: 'blocked' });
  await flush();

  assert.deepEqual(visiblePanel(), ['error']);
  assert.match($('voiceErrorMsg').textContent, /Asetukset → Sovellukset → Manifestival → Käyttöoikeudet → Mikrofoni/);
  assert.equal(/selaime/i.test($('voiceErrorMsg').textContent), false);
  assert.equal(shown('voiceErrorRetry'), false);
  assert.equal(shown('voiceErrorSettings'), true);
  assert.equal(shown('voiceErrorTypeInstead'), true);

  // Uusi yritys ei ole mahdollinen edes suoraan kutsuttuna.
  voice.startVoiceFlow();
  assert.equal(plugin.calls.listen.length, 1, 'estetty lupa kysyttiin uudelleen');

  $('voiceErrorSettings').dispatch('click');
  await flush();
  assert.equal(plugin.calls.openSettings, 1);
  assert.equal(overlayOpen(), false, 'asetuksista palaava käyttäjä ei näe vanhaa virhettä');
});

test('VOICE-AND-5: natiivi kertakielto -> ei uudelleenyritystä eikä asetuksia; kirjoittaminen toimii', async () => {
  const plugin = fakeSpeechPlugin();
  installShell(plugin);
  $('fabBtn').dispatch('click');
  plugin.settle({ ok: false, code: 'not-allowed' });
  await flush();

  assert.equal(shown('voiceErrorRetry'), false);
  assert.equal(shown('voiceErrorSettings'), false);
  $('voiceErrorTypeInstead').dispatch('click');
  assert.deepEqual(visiblePanel(), ['typefallback']);
  assert.equal($('vfFallbackReason').textContent, '', 'kirjoittaminen oli käyttäjän valinta, ei puutteen syy');
});

test('tilapäinen virhe (verkko) tarjoaa uudelleenyrityksen, ei asetuksia', async () => {
  const plugin = fakeSpeechPlugin();
  installShell(plugin);
  $('fabBtn').dispatch('click');
  plugin.settle({ ok: false, code: 'network' });
  await flush();
  assert.deepEqual(visiblePanel(), ['error']);
  assert.equal(shown('voiceErrorRetry'), true);
  assert.equal(shown('voiceErrorSettings'), false);
  $('voiceErrorRetry').dispatch('click');
  assert.equal(plugin.calls.listen.length, 2);
  assert.deepEqual(visiblePanel(), ['permission']);
});

test('VOICE-AND-5: selaimen not-allowed -> ei uudelleenyritystä; neuvo selaimen asetuksiin', async () => {
  globalThis.webkitSpeechRecognition = FakeRecognition;
  $('fabBtn').dispatch('click');
  FakeRecognition.instances[0].onerror({ error: 'not-allowed' });
  await flush();

  assert.deepEqual(visiblePanel(), ['error']);
  assert.match($('voiceErrorMsg').textContent, /selaimen asetuksista/);
  assert.equal(shown('voiceErrorRetry'), false);
  assert.equal(shown('voiceErrorSettings'), false, 'selaimessa ei ole sovelluksen asetuksia avattavaksi');
  assert.equal(shown('voiceErrorTypeInstead'), true);
  $('voiceErrorRetry').dispatch('click');
  assert.equal(FakeRecognition.instances.length, 1, 'estetty lupa yritettiin uudelleen');
});

// ============================================= VOICE-AND-3/4: siivous

test('VOICE-AND-4 KRIITTINEN: suljettu paneeli ei käsittele myöhäistä tulosta (abort, ei stop)', async () => {
  globalThis.webkitSpeechRecognition = FakeRecognition;
  $('vfTranscriptText').value = '';
  // Avaaja on FAB, jotta sulkemisen fokuksen palautus ei osu tekstikenttään.
  globalThis.document.activeElement = $('fabBtn');
  let focusBefore = -1;

  const logs = await captureLogs(async () => {
    $('fabBtn').dispatch('click');
    const recognition = FakeRecognition.instances[0];
    recognition.onstart();
    assert.deepEqual(visiblePanel(), ['listening']);

    $('voiceCloseX').dispatch('click');
    assert.deepEqual(recognition.calls, ['start', 'abort']);
    focusBefore = $('vfTranscriptText').focused;

    recognition.final('poista kaikki');
    await flush();
  });

  assert.equal(overlayOpen(), false);
  assert.equal($('vfTranscriptText').value, '', 'myöhäinen tulos kirjoitettiin piilotettuun kenttään');
  assert.equal($('vfTranscriptText').focused, focusBefore, 'myöhäinen tulos siirsi fokuksen');
  assert.equal(logs.includes('voice.transcript'), false, 'myöhäinen tulos kirjattiin');
});

test('VOICE-AND-3: hiljainen tunnistin ei jätä paneelia kuuntelemaan (15 s raja)', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    globalThis.webkitSpeechRecognition = FakeRecognition;
    $('fabBtn').dispatch('click');
    const recognition = FakeRecognition.instances[0];
    recognition.onstart();
    mock.timers.tick(14999);
    await flush();
    assert.deepEqual(visiblePanel(), ['listening']);

    mock.timers.tick(1);
    await flush();
    assert.deepEqual(visiblePanel(), ['error']);
    assert.match($('voiceErrorMsg').textContent, /Kuuntelu keskeytyi/);
    assert.deepEqual(recognition.calls, ['start', 'abort'], 'aikakatkaisu katkaisee tunnistimen kerran');
    assert.equal(shown('voiceErrorRetry'), true, 'aikakatkaisu ei ole pysyvä virhe');
  } finally {
    mock.timers.reset();
  }
});

// ============================================ VOICE-AND-2: rehellinen puute

test('VOICE-AND-2: Android ilman liitännäistä -> kirjoituspaneeli kertoo syyn; WebView\'n tunnistinta ei rakenneta', async () => {
  installShell(null);
  let constructed = 0;
  globalThis.webkitSpeechRecognition = function Spy() { constructed += 1; };

  $('fabBtn').dispatch('click');
  assert.deepEqual(visiblePanel(), ['typefallback']);
  assert.match($('vfFallbackReason').textContent, /Android/);
  assert.equal(constructed, 0);
  assert.equal(voice.speechSupported(), false);
});

test('VOICE-AND-2: selain ilman tunnistinta -> kirjoituspaneeli kertoo syyn ilman selainsuositusta', () => {
  $('fabBtn').dispatch('click');
  assert.deepEqual(visiblePanel(), ['typefallback']);
  assert.match($('vfFallbackReason').textContent, /Selain ei tue puheentunnistusta/);
  const html = read('index.html');
  assert.equal(html.includes('Chromella tai Edgellä'), false);
  assert.match(html, /Kirjoittaminen toimii kaikkialla\./);
});

test('VOICE-AND-2: virhetekstit tulevat alustan taulukosta, eivät kutsupaikoista', () => {
  for (const file of ['src/app/voice.js', 'src/app/speechInput.js', 'src/app/views/inbox.js']) {
    assert.equal(read(file).includes('selaimen asetuksista'), false, file);
  }
});

// ================================================= VOICE-AND-6: sanelu

test('VOICE-AND-4/6: sanelun toinen napautus peruu eikä näytä virhettä', async () => {
  const plugin = fakeSpeechPlugin();
  installShell(plugin);
  $('captureError').textContent = '';

  const first = inbox.toggleDictation();
  assert.equal($('captureMicBtn').getAttribute('aria-pressed'), 'true');
  assert.match($('captureStatus').textContent, /Käynnistetään mikrofonia/);
  plugin.emit('listening');
  assert.match($('captureStatus').textContent, /Kuuntelen/);

  await inbox.toggleDictation();
  await first;
  await flush();

  assert.equal(plugin.calls.listen.length, 1, 'toinen napautus käynnisti toisen tunnistimen');
  assert.equal(plugin.calls.cancel, 1);
  assert.equal($('captureError').textContent, '', 'peruttu sanelu näytti virheen');
  assert.equal($('captureError').style.display, 'none');
  assert.equal($('captureStatus').textContent, '');
  assert.equal($('captureMicBtn').getAttribute('aria-pressed'), 'false');
});

test('VOICE-AND-4: kaksi nopeaa napautusta selaimessa rakentaa yhden tunnistimen', async () => {
  globalThis.webkitSpeechRecognition = FakeRecognition;
  const first = inbox.toggleDictation();
  const second = inbox.toggleDictation();
  await Promise.all([first, second]);
  assert.equal(FakeRecognition.instances.length, 1);
  assert.deepEqual(FakeRecognition.instances[0].calls, ['start', 'abort']);
});

test('sanelu: teksti menee kenttään tarkistettavaksi; estetty lupa kertoo Android-asetuksista', async () => {
  const plugin = fakeSpeechPlugin();
  installShell(plugin);
  $('captureInput').value = '';
  const done = inbox.toggleDictation();
  plugin.settle({ ok: true, text: 'soita äidille' });
  await done;
  assert.equal($('captureInput').value, 'soita äidille');
  assert.match($('captureStatus').textContent, /Tarkista teksti/);

  const blocked = inbox.toggleDictation();
  plugin.settle({ ok: false, code: 'blocked' });
  await blocked;
  assert.match($('captureError').textContent, /Asetukset/);
  assert.equal(/selaime/i.test($('captureError').textContent), false);
});

test('sanelu: sovelluksen pause katkaisee sanelun ilman virheviestiä', async () => {
  const plugin = fakeSpeechPlugin();
  installShell(plugin);
  $('captureError').textContent = '';
  const done = inbox.toggleDictation();
  plugin.emit('listening');
  speechModule.cancelActiveListening({ reason: 'pause' });
  await done;
  assert.equal(plugin.calls.cancel, 1);
  assert.equal($('captureError').textContent, '');
  assert.equal(speechInput.isDictating(), false);
});

test('VOICE-AND-6: listenOnce palauttaa koneluettavan koodin; peruttu on tyhjä virhe', async () => {
  globalThis.webkitSpeechRecognition = FakeRecognition;
  const pending = speechInput.listenOnce();
  FakeRecognition.instances[0].onerror({ error: 'aborted' });
  assert.deepEqual(await pending, { ok: false, code: 'aborted', error: '' });

  const denied = speechInput.listenOnce();
  FakeRecognition.instances[1].onerror({ error: 'not-allowed' });
  const result = await denied;
  assert.equal(result.code, 'not-allowed');
  assert.match(result.error, /selaimen asetuksista/);
});

test('mikrofonipainike näkyy vain kun puhe on oikeasti käytettävissä', () => {
  installShell(null);
  assert.equal(speechInput.speechAvailable(), false, 'Android ilman liitännäistä');
  installShell(fakeSpeechPlugin());
  assert.equal(speechInput.speechAvailable(), true);
  delete globalThis.Capacitor;
  assert.equal(speechInput.speechAvailable(), false, 'selain ilman tunnistinta');
});

// ========================================================== ensikäyttö

test('ensikäytön opastus ei lupaa puhetta, jota tällä alustalla ei ole', () => {
  installShell(null);
  onboarding.showOnboarding();
  $('onboardingNext').dispatch('click');
  assert.equal(/ääneen/.test($('onboardingBody').textContent), false);
  assert.match($('onboardingBody').textContent, /kirjoita/);

  installShell(fakeSpeechPlugin());
  onboarding.showOnboarding();
  $('onboardingNext').dispatch('click');
  assert.match($('onboardingBody').textContent, /sano se ääneen/);
  assert.match($('onboardingBody').textContent, /lupaa kysytään vasta, kun painat/);
});

// ============================================================ profiili

test('LOC-1 + VOICE-AND-2: profiili natiivikuoressa ei tarjoa sijaintipainikkeita eikä taustakuuntelua', () => {
  installShell(null);
  profile.renderProfile();
  let html = $('pfCapabilities').innerHTML;
  assert.equal(html.includes('pfLocationAskBtn'), false, '"Salli sijainti" kaatuisi puuttuvaan manifestilupaan');
  assert.equal(html.includes('pfLocationTryBtn'), false);
  assert.match(html, /ei pyydä sijaintilupaa/);
  assert.equal(/Taustakuuntelu/i.test(html), false);

  installShell(fakeSpeechPlugin());
  profile.renderProfile();
  html = $('pfCapabilities').innerHTML;
  assert.match(html, /Puheentunnistus<\/strong> — Lupaa ei ole vielä kysytty/);
});
