// Puheentunnistuksen alustasovitin (src/platform/speech.js).
//
// Laitetta ei käytetä: Android-liitännäinen (SpeechPlugin.java) korvataan
// muistissa elävällä kaksoiskappaleella ja selaimen SpeechRecognition
// valekonstruktorilla. Näin testataan se, minkä työpöydällä VOI testata:
// taustajärjestelmän valinta, lupapyynnön paikka, peruminen, aikakatkaisu
// ja virheiden kieli. Se, kuuleeko puhelimen tunnistin oikeasti suomea,
// on laitehyväksynnän asia (docs/DEVICE-ACCEPTANCE-BACKLOG.md).

import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import { readCode } from './helpers/sources.mjs';

const capabilities = await import('../src/platform/capabilities.js');
const speech = await import('../src/platform/speech.js');
const index = await import('../src/platform/index.js');

const ORIGINAL_CAPACITOR = globalThis.Capacitor;

/** Muistissa elävä ManifestivalSpeech-liitännäinen, joka kirjaa kutsunsa. */
function fakeSpeechPlugin({ listen = 'pending', microphone = 'prompt' } = {}) {
  const calls = {
    listen: [], cancel: 0, requestPermissions: 0, checkPermissions: 0,
    openSettings: 0, addListener: [], removed: 0
  };
  const listeners = new Map();
  let pending = null;
  return {
    calls,
    /** Liitännäisen notifyListeners. */
    emit(event, data) { for (const fn of listeners.get(event) || []) fn(data); },
    /** Ratkaise odottava listen()-kutsu. */
    settle(value) { if (pending) pending(value); },
    addListener(event, fn) {
      calls.addListener.push(event);
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(fn);
      // Capacitorin natiivisilta palauttaa kahvan synkronisesti (native-bridge.js).
      return { remove: async () => { calls.removed += 1; } };
    },
    listen(options) {
      calls.listen.push(options);
      if (listen === 'reject') return Promise.reject(new Error('silta kaatui'));
      if (listen && typeof listen === 'object') return Promise.resolve(listen);
      return new Promise(resolve => { pending = resolve; });
    },
    async cancel() {
      calls.cancel += 1;
      // Kuten Java: kesken oleva listen ratkeaa koodilla "aborted".
      if (pending) pending({ ok: false, code: 'aborted' });
    },
    async checkPermissions() { calls.checkPermissions += 1; return { microphone }; },
    async requestPermissions() { calls.requestPermissions += 1; return { microphone: 'granted' }; },
    async openSettings() { calls.openSettings += 1; return { ok: true }; },
    async available() { return { available: true }; }
  };
}

function installShell(plugin) {
  globalThis.Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => 'android',
    Plugins: plugin ? { ManifestivalSpeech: plugin } : {}
  };
}

/** Selaimen SpeechRecognition-valekonstruktori. */
class FakeRecognition {
  static instances = [];
  constructor() {
    this.calls = [];
    FakeRecognition.instances.push(this);
  }
  start() { this.calls.push('start'); }
  stop() { this.calls.push('stop'); }
  abort() { this.calls.push('abort'); }
  /** Tunnistimen lopullinen tulos. */
  final(text) {
    this.onresult({ results: [Object.assign([{ transcript: text }], { isFinal: true })] });
  }
}

const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));

beforeEach(() => {
  delete globalThis.Capacitor;
  delete globalThis.webkitSpeechRecognition;
  delete globalThis.SpeechRecognition;
  FakeRecognition.instances = [];
  speech.resetSpeechForTests();
  capabilities.resetSpeechPermissionState();
});

afterEach(() => {
  speech.cancelActiveListening();
  delete globalThis.webkitSpeechRecognition;
  delete globalThis.SpeechRecognition;
  if (ORIGINAL_CAPACITOR === undefined) delete globalThis.Capacitor;
  else globalThis.Capacitor = ORIGINAL_CAPACITOR;
});

// ------------------------------------------------ 1. natiivi ilman liitännäistä

test('VOICE-AND-1/1: natiivikuori ilman liitännäistä ei KOSKAAN rakenna WebView\'n tunnistinta', async () => {
  installShell(null);
  let constructed = 0;
  globalThis.webkitSpeechRecognition = function Spy() { constructed += 1; };

  const state = capabilities.capability(capabilities.CAPABILITY.SPEECH);
  assert.equal(state.supported, true);
  assert.equal(state.implemented, false);
  assert.equal(state.available, false);
  assert.match(state.reason, /Android/);
  assert.notEqual(state.permission, capabilities.PERMISSION.PROMPT, 'lupaa ei voi olla "kysymättä", kun kuuntelu ei ole mahdollista');
  assert.equal(speech.speechBackend(), 'none');

  const result = await speech.startListening().result;
  assert.deepEqual(result, { ok: false, code: 'unavailable' });
  assert.equal(constructed, 0, 'WebView\'n SpeechRecognition rakennettiin natiivikuoressa');
  assert.match(speech.speechErrorMessage('unavailable'), /Kirjoita sen sijaan/);
  assert.equal(speech.speechErrorMessage('unavailable').includes('selain'), false);
});

// ------------------------------------------ 2. ei lupapyyntöä käynnistyksessä

test('VOICE-AND-1/2 KRIITTINEN: tuen kysely ja lupatilan luku eivät pyydä lupaa eivätkä kuuntele', async () => {
  const plugin = fakeSpeechPlugin({ microphone: 'granted' });
  installShell(plugin);

  const state = index.speech.capability();
  assert.equal(state.supported, true);
  assert.equal(state.implemented, true);
  assert.equal(index.speech.backend(), 'native');
  index.capabilities();
  const permission = await index.speech.refreshPermission();

  assert.equal(permission, capabilities.PERMISSION.GRANTED);
  assert.equal(index.speech.capability().permission, capabilities.PERMISSION.GRANTED);
  assert.equal(plugin.calls.listen.length, 0, 'kuuntelu käynnistyi ilman napautusta');
  assert.equal(plugin.calls.requestPermissions, 0, 'lupaa pyydettiin ilman napautusta');
  assert.equal(plugin.calls.checkPermissions, 1, 'luku saa kysyä tilaa, ei muuta');
});

test('lupatilan luku kääntää Capacitorin tilat yhteisiksi', async () => {
  for (const [raw, expected] of [
    ['granted', 'granted'], ['denied', 'denied'], ['prompt-with-rationale', 'denied'], ['prompt', 'prompt'], [undefined, 'prompt']
  ]) {
    capabilities.resetSpeechPermissionState();
    installShell(fakeSpeechPlugin({ microphone: raw }));
    assert.equal(await speech.refreshSpeechPermission(), expected, String(raw));
    assert.equal(capabilities.capability(capabilities.CAPABILITY.SPEECH).permission, expected, String(raw));
  }
});

// ------------------------------------------------------ 3. onnistunut tulos

test('VOICE-AND-1/3: liitännäisen teksti palautuu siistittynä; lupa merkitään myönnetyksi', async () => {
  const plugin = fakeSpeechPlugin({ listen: { ok: true, text: '  osta maitoa  ' } });
  installShell(plugin);

  const handle = speech.startListening({ lang: 'fi-FI' });
  assert.equal(speech.isListening(), true);
  const result = await handle.result;

  assert.deepEqual(result, { ok: true, text: 'osta maitoa' });
  assert.deepEqual(plugin.calls.listen, [{ lang: 'fi-FI' }]);
  assert.deepEqual(plugin.calls.addListener, [speech.NATIVE_STATE_EVENT]);
  assert.equal(plugin.calls.cancel, 0, 'valmista kuuntelua ei peruta');
  assert.equal(speech.isListening(), false);
  assert.equal(capabilities.capability(capabilities.CAPABILITY.SPEECH).permission, capabilities.PERMISSION.GRANTED);
  await tick();
  assert.equal(plugin.calls.removed, 1, 'tilakuuntelija jäi roikkumaan');
});

test('tyhjä teksti, tuntematon koodi ja hylätty kutsu eivät heitä', async () => {
  installShell(fakeSpeechPlugin({ listen: { ok: true, text: '   ' } }));
  assert.deepEqual(await speech.startListening().result, { ok: false, code: 'no-speech' });

  installShell(fakeSpeechPlugin({ listen: { ok: false, code: 'jotain-outoa' } }));
  assert.deepEqual(await speech.startListening().result, { ok: false, code: 'unknown' });

  installShell(fakeSpeechPlugin({ listen: 'reject' }));
  assert.deepEqual(await speech.startListening().result, { ok: false, code: 'unknown' });
});

test('kieli rajataan BCP 47 -muotoon ennen kuin se päätyy natiiviin', async () => {
  const plugin = fakeSpeechPlugin({ listen: { ok: false, code: 'no-speech' } });
  installShell(plugin);
  await speech.startListening({ lang: 'fi-FI"; rm -rf' }).result;
  await speech.startListening({ lang: 'sv-FI' }).result;
  assert.deepEqual(plugin.calls.listen.map(options => options.lang), ['fi-FI', 'sv-FI']);
});

// ------------------------------------------------ 4. estetty lupa, oikea kieli

test('VOICE-AND-1/4 + VOICE-AND-2: pysyvä kielto ohjaa Androidin asetuksiin, ei selaimen', async () => {
  installShell(fakeSpeechPlugin({ listen: { ok: false, code: 'blocked' } }));
  const result = await speech.startListening().result;
  assert.deepEqual(result, { ok: false, code: 'blocked' });

  const message = speech.speechErrorMessage(result.code);
  assert.match(message, /Asetukset/);
  assert.match(message, /Asetukset → Sovellukset → Manifestival → Käyttöoikeudet → Mikrofoni/);
  assert.equal(/selaime/i.test(message), false, 'Android-sovellus ei neuvo selaimen asetuksiin');
  assert.equal(speech.isPermanentSpeechError('blocked'), true);
  assert.equal(speech.isPermanentSpeechError('not-allowed'), true);
  assert.equal(speech.isPermanentSpeechError('no-speech'), false);
  assert.equal(speech.isPermanentSpeechError('timeout'), false);
  assert.equal(capabilities.capability(capabilities.CAPABILITY.SPEECH).permission, capabilities.PERMISSION.DENIED);

  // Natiivin kertakielto ei väitä asetusten olevan ainoa tie.
  assert.equal(/selaime/i.test(speech.speechErrorMessage('not-allowed')), false);
});

test('selaimessa sama koodi neuvoo selaimen asetuksiin; peruminen ei ole virhe', () => {
  assert.match(speech.speechErrorMessage('not-allowed', false), /selaimen asetuksista/);
  assert.match(speech.speechErrorMessage('blocked', false), /selaimen asetuksista/);
  assert.equal(speech.speechErrorMessage('aborted', false), '');
  assert.equal(speech.speechErrorMessage('aborted', true), '');
  assert.equal(speech.speechErrorMessage('outo-koodi', true), 'Puheentunnistus ei onnistunut.');
  // Jokaisella koodilla on teksti molemmilla alustoilla.
  for (const code of Object.values(speech.SPEECH_ERROR)) {
    if (code === 'aborted') continue;
    assert.ok(speech.speechErrorMessage(code, true), 'natiivi: ' + code);
    assert.ok(speech.speechErrorMessage(code, false), 'selain: ' + code);
  }
});

test('Avaa asetukset kutsuu liitännäistä kerran ja vain natiivissa', async () => {
  assert.equal(speech.canOpenSpeechSettings(), false);
  assert.equal(await speech.openSpeechSettings(), false);

  const plugin = fakeSpeechPlugin();
  installShell(plugin);
  assert.equal(speech.canOpenSpeechSettings(), true);
  assert.equal(await speech.openSpeechSettings(), true);
  assert.equal(plugin.calls.openSettings, 1);
  assert.equal(plugin.calls.requestPermissions, 0, 'asetusten avaus ei ole lupapyyntö');
});

// ------------------------------------------- 5. peruminen ja taustalle siirto

test('VOICE-AND-1/5: peruminen kutsuu liitännäisen cancelia tasan kerran', async () => {
  const plugin = fakeSpeechPlugin();
  installShell(plugin);

  const handle = speech.startListening();
  handle.cancel();
  handle.cancel();
  assert.deepEqual(await handle.result, { ok: false, code: 'aborted' });
  assert.equal(plugin.calls.cancel, 1);
  assert.equal(speech.isListening(), false);
});

test('VOICE-AND-1/5: sovelluksen pause katkaisee kuuntelun (cancel tasan kerran)', async () => {
  const plugin = fakeSpeechPlugin();
  installShell(plugin);

  const handle = speech.startListening();
  plugin.emit(speech.NATIVE_STATE_EVENT, { state: 'starting' });
  plugin.emit(speech.NATIVE_STATE_EVENT, { state: 'listening' });
  assert.equal(speech.cancelActiveListening({ reason: 'pause' }), true);
  assert.equal(speech.cancelActiveListening({ reason: 'pause' }), false, 'toinen pause ei peru mitään');
  assert.deepEqual(await handle.result, { ok: false, code: 'aborted' });
  assert.equal(plugin.calls.cancel, 1);
});

test('KRIITTINEN: Androidin lupadialogi (onPause) ei peru kuuntelua; käyttäjän peruutus perii', async () => {
  const plugin = fakeSpeechPlugin();
  installShell(plugin);
  let permissionShown = 0;

  const handle = speech.startListening({ timeoutMs: 30, onPermission: () => { permissionShown += 1; } });
  plugin.emit(speech.NATIVE_STATE_EVENT, { state: 'permission' });
  assert.equal(permissionShown, 1);
  assert.equal(speech.isAwaitingPermission(), true);

  // Dialogi keskeyttää aktiviteetin: pause ja piilotus EIVÄT peru.
  assert.equal(speech.cancelActiveListening({ reason: 'pause' }), false);
  assert.equal(speech.cancelActiveListening({ reason: 'hidden' }), false);
  // Käyttäjä päättää luvasta omaan tahtiinsa: aikakatkaisu ei kulu dialogin aikana.
  await tick(60);
  assert.equal(plugin.calls.cancel, 0);
  assert.equal(speech.isListening(), true);

  // Lupa myönnetty -> mikrofoni käynnistyy -> aikaraja alkaa alusta.
  plugin.emit(speech.NATIVE_STATE_EVENT, { state: 'starting' });
  assert.equal(speech.isAwaitingPermission(), false);
  assert.deepEqual(await handle.result, { ok: false, code: 'timeout' });
  assert.equal(plugin.calls.cancel, 1);
});

test('lupadialogin aikana käyttäjän oma peruutus (ja sivun sulkeminen) perii heti', async () => {
  const plugin = fakeSpeechPlugin();
  installShell(plugin);
  const handle = speech.startListening();
  plugin.emit(speech.NATIVE_STATE_EVENT, { state: 'permission' });
  assert.equal(speech.cancelActiveListening({ reason: 'pagehide' }), true);
  assert.deepEqual(await handle.result, { ok: false, code: 'aborted' });
  assert.equal(plugin.calls.cancel, 1);
});

test('mikrofoni aukeaa -> onStart; myöhäiset tapahtumat perumisen jälkeen ohitetaan', async () => {
  const plugin = fakeSpeechPlugin();
  installShell(plugin);
  let started = 0;
  const handle = speech.startListening({ onStart: () => { started += 1; } });
  plugin.emit(speech.NATIVE_STATE_EVENT, { state: 'listening' });
  assert.equal(started, 1);
  handle.cancel();
  await handle.result;
  plugin.emit(speech.NATIVE_STATE_EVENT, { state: 'listening' });
  plugin.settle({ ok: true, text: 'myöhäinen' });
  assert.equal(started, 1, 'peruttu kuuntelu ei saa ilmoittaa aloittaneensa');
  assert.deepEqual(await handle.result, { ok: false, code: 'aborted' });
});

test('uusi kuuntelu korvaa vanhan: kaksi mikrofonia ei ole koskaan auki', async () => {
  const plugin = fakeSpeechPlugin();
  installShell(plugin);
  const first = speech.startListening();
  const second = speech.startListening();
  assert.deepEqual(await first.result, { ok: false, code: 'aborted' });
  assert.equal(speech.isListening(), true);
  second.cancel();
  await second.result;
});

// ---------------------------------------------------------- 6. aikakatkaisu

test('VOICE-AND-1/6 + VOICE-AND-3: hiljainen tunnistin aikakatkaistaan ja perutaan tasan kerran', async () => {
  const plugin = fakeSpeechPlugin();
  installShell(plugin);
  const handle = speech.startListening({ timeoutMs: 50 });
  const result = await handle.result;
  assert.deepEqual(result, { ok: false, code: 'timeout' });
  assert.equal(plugin.calls.cancel, 1);
  assert.match(speech.speechErrorMessage('timeout'), /Kuuntelu keskeytyi/);
  assert.equal(speech.LISTEN_TIMEOUT_MS, 15000);
});

// ---------------------------------------------------------- 7. selainpolku

test('VOICE-AND-1/7 + VOICE-AND-4: selaimessa peruminen on abort() (ei stop), ja myöhäinen tulos ohitetaan', async () => {
  globalThis.webkitSpeechRecognition = FakeRecognition;
  assert.equal(speech.speechBackend(), 'web');

  const handle = speech.startListening();
  const recognition = FakeRecognition.instances[0];
  assert.equal(recognition.lang, 'fi-FI');
  assert.equal(recognition.continuous, false, 'jatkuva kuuntelu kielletty');
  assert.deepEqual(recognition.calls, ['start']);

  handle.cancel();
  assert.deepEqual(recognition.calls, ['start', 'abort']);
  assert.equal(recognition.calls.includes('stop'), false);
  recognition.final('poista kaikki');
  assert.deepEqual(await handle.result, { ok: false, code: 'aborted' });
});

test('selainpolku: tulos, väliaikateksti, virheet ja hiljainen loppu', async () => {
  globalThis.webkitSpeechRecognition = FakeRecognition;

  // Väliaikateksti vain jos kutsuja haluaa sen; sitten lopullinen tulos.
  const interim = [];
  let started = 0;
  const handle = speech.startListening({ onInterim: text => interim.push(text), onStart: () => { started += 1; } });
  const recognition = FakeRecognition.instances[0];
  assert.equal(recognition.interimResults, true);
  recognition.onstart();
  recognition.onresult({ results: [Object.assign([{ transcript: 'osta' }], { isFinal: false })] });
  recognition.final('osta maitoa ');
  assert.deepEqual(await handle.result, { ok: true, text: 'osta maitoa' });
  assert.deepEqual(interim, ['osta']);
  assert.equal(started, 1);
  assert.ok(recognition.calls.includes('abort'), 'mikrofoni vapautetaan tuloksen jälkeen');

  // Ilman väliaikakutsua ei pyydetä väliaikatuloksia.
  const plain = speech.startListening();
  assert.equal(FakeRecognition.instances[1].interimResults, false);
  FakeRecognition.instances[1].onerror({ error: 'not-allowed' });
  assert.deepEqual(await plain.result, { ok: false, code: 'not-allowed' });
  assert.equal(capabilities.capability(capabilities.CAPABILITY.SPEECH).permission, capabilities.PERMISSION.DENIED);

  const silent = speech.startListening();
  FakeRecognition.instances[2].onend();
  assert.deepEqual(await silent.result, { ok: false, code: 'no-speech' });

  for (const [error, code] of [['service-not-allowed', 'not-allowed'], ['network', 'network'],
    ['audio-capture', 'audio'], ['language-not-supported', 'language-unavailable'], ['outo', 'unknown']]) {
    const next = speech.startListening();
    FakeRecognition.instances.at(-1).onerror({ error });
    assert.deepEqual(await next.result, { ok: false, code }, error);
  }
});

/** Lupausketjujen tyhjennys, kun setTimeout on korvattu (setImmediate ei ole). */
const settle = async () => { for (let i = 0; i < 5; i += 1) await new Promise(resolve => setImmediate(resolve)); };

test('selainpolku: selaimen oma mikrofonikysely ei kuluta kuunteluaikaa; raja alkaa onstartista', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    globalThis.webkitSpeechRecognition = FakeRecognition;
    let started = 0;
    let outcome = null;
    const handle = speech.startListening({ onStart: () => { started += 1; } });
    handle.result.then(value => { outcome = value; });
    const recognition = FakeRecognition.instances[0];

    // Selain kysyy mikrofonilupaa 20 s (yli kuunteluajan): onstart ei ole
    // vielä tullut, eikä kuuntelu saa aikakatkaista.
    mock.timers.tick(20000);
    await settle();
    assert.equal(outcome, null, 'selaimen lupakysely kulutti kuunteluajan');
    assert.deepEqual(recognition.calls, ['start']);

    // Lupa annettu, mikrofoni auki: täysi kuunteluaika alkaa nyt.
    recognition.onstart();
    assert.equal(started, 1);
    mock.timers.tick(speech.LISTEN_TIMEOUT_MS - 1);
    await settle();
    assert.equal(outcome, null, 'kuunteluaika ei alkanut onstartista');
    mock.timers.tick(1);
    await settle();
    assert.deepEqual(outcome, { ok: false, code: 'timeout' });
    assert.deepEqual(recognition.calls, ['start', 'abort'], 'aikakatkaisu katkaisee tunnistimen kerran');
  } finally {
    mock.timers.reset();
  }
});

test('selainpolku: tunnistin, joka ei koskaan käynnisty, katkaistaan käynnistysvaran jälkeen', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    globalThis.webkitSpeechRecognition = FakeRecognition;
    let outcome = null;
    speech.startListening().result.then(value => { outcome = value; });
    assert.ok(speech.WEB_START_GUARD_MS > speech.LISTEN_TIMEOUT_MS);

    mock.timers.tick(speech.WEB_START_GUARD_MS - 1);
    await settle();
    assert.equal(outcome, null);
    mock.timers.tick(1);
    await settle();
    assert.deepEqual(outcome, { ok: false, code: 'timeout' }, 'vastaamaton kysely jätti kuuntelun roikkumaan');
    assert.equal(speech.isListening(), false);
  } finally {
    mock.timers.reset();
  }
});

test('selainpolku: start() heittää -> start-failed, ei poikkeusta kutsujalle', async () => {
  globalThis.webkitSpeechRecognition = class extends FakeRecognition {
    start() { throw new Error('InvalidStateError'); }
  };
  assert.deepEqual(await speech.startListening().result, { ok: false, code: 'start-failed' });
  assert.equal(speech.isListening(), false);
});

test('sivun piilotus katkaisee kuuntelun kutsujasta riippumatta', async () => {
  globalThis.webkitSpeechRecognition = FakeRecognition;
  const listeners = {};
  const savedDocument = globalThis.document;
  const savedWindow = globalThis.window;
  globalThis.document = {
    hidden: false,
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); }
  };
  globalThis.window = { addEventListener: (type, fn) => { (listeners['window:' + type] ||= []).push(fn); } };
  try {
    const handle = speech.startListening();
    globalThis.document.hidden = true;
    for (const fn of listeners.visibilitychange || []) fn();
    assert.deepEqual(await handle.result, { ok: false, code: 'aborted' });
    assert.ok(FakeRecognition.instances[0].calls.includes('abort'));

    const again = speech.startListening();
    for (const fn of listeners['window:pagehide'] || []) fn();
    assert.deepEqual(await again.result, { ok: false, code: 'aborted' });
    // Kytkentä tehtiin kerran, ei jokaisella kuuntelulla.
    assert.equal((listeners.visibilitychange || []).length, 1);
  } finally {
    if (savedDocument === undefined) delete globalThis.document; else globalThis.document = savedDocument;
    if (savedWindow === undefined) delete globalThis.window; else globalThis.window = savedWindow;
  }
});

// ------------------------------------------------------------- invariantit

test('KRIITTINEN: puhesovitin ei tallenna ääntä eikä kirjoita selaimen varastoon', () => {
  const source = readCode('src/platform/speech.js');
  for (const forbidden of ['MediaRecorder', 'getUserMedia', 'AudioContext', 'createMediaStreamSource', 'Blob(']) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
  assert.equal(/localStorage|sessionStorage|indexedDB/i.test(source), false);
  assert.equal(/continuous = true/.test(source), false);
  assert.equal(/requestPermissions\(/.test(source), false, 'sovitin ei pyydä lupaa erikseen: vain listen() voi kysyä');
});

test('taustakuuntelua ei luvata millään alustalla', () => {
  assert.equal(index.speech.supportsBackgroundCapture(), false);
  installShell(fakeSpeechPlugin());
  assert.equal(index.speech.supportsBackgroundCapture(), false);
  assert.equal(/tausta/i.test(index.speech.capability().plannedNote), false);
  installShell(null);
  assert.equal(/tausta/i.test(index.speech.capability().plannedNote), false);
});
