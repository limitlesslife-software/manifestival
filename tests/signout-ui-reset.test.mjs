// Uloskirjautuminen nollaa puhepaneelin ja profiililomakkeen.
//
// LÖYTYNEET BUGIT, JOITA TÄMÄ TESTI VARTIOI
//
// 1. PUHEPANEELI. Tunnistettu teksti (TRANSCRIPT_READY) ja kirjoitettu
//    varateksti (TYPE_FALLBACK) säilyvät tarkoituksella piilotuksen yli.
//    #voiceOverlay on #appin sisällä, joten kirjautumisportti vain piilotti
//    sen. Kun A:n istunto päättyi toisessa välilehdessä tai tokenin
//    vanhetessa ja B kirjautui samassa välilehdessä, B näki A:n sanelun
//    ("Varaa aika psykiatrille torstaina") avoimessa paneelissa, ja "Jatka"
//    lähetti sen B:n tunnuksilla.
//
// 2. PROFIILILOMAKE. fillProfileForm on ikä-, paino-, pituus- ja
//    unikenttien ainoa kirjoittaja, ja kirjautuessa sitä kutsutaan vasta
//    latauksen jälkeen. Siihen asti B näki A:n terveystiedot, ja "Tallenna"
//    kirjoitti ne B:n profiiliin.
//
// Molemmat nollataan main.js:n onSignedOut-funktiossa, jota myös
// tilinvaihto (USER_SWITCHED) kierrättää.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { read, readCode } from './helpers/sources.mjs';

// ------------------------------------------------------------ tynkä-DOM
//
// Tunnistaa vain index.html:ssä oikeasti olevat tunnisteet, kuten
// tests/voice-android-ui.test.mjs: puuttuva elementti näkyy testissä.

const HTML_IDS = new Set([...read('index.html').matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));

function stubElement(id) {
  const listeners = {};
  const attributes = {};
  const classes = new Set();
  const node = {
    id, tagName: 'DIV', value: '', textContent: '', innerHTML: '', hidden: false, disabled: false,
    style: {}, dataset: {}, childElementCount: 0,
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
    focus() { globalThis.document.activeElement = node; },
    closest: () => null, querySelector: () => null, querySelectorAll: () => [],
    appendChild: () => {}, remove: () => {}
  };
  return node;
}

const elements = new Map();
const documentListeners = {};
globalThis.document = {
  hidden: false,
  activeElement: null,
  getElementById(id) {
    if (!HTML_IDS.has(id)) return null;
    if (!elements.has(id)) elements.set(id, stubElement(id));
    return elements.get(id);
  },
  addEventListener: (type, fn) => { (documentListeners[type] ||= []).push(fn); },
  dispatch: type => (documentListeners[type] || []).forEach(fn => fn({})),
  createElement: () => stubElement(null),
  querySelectorAll: () => [],
  body: { appendChild: () => {}, removeChild: () => {}, classList: { toggle() {} } }
};
globalThis.window = { addEventListener: () => {} };
const $ = id => globalThis.document.getElementById(id);

/** Selaimen puheentunnistimen kaksoiskappale. */
class FakeRecognition {
  static instances = [];
  constructor() { this.calls = []; FakeRecognition.instances.push(this); }
  start() { this.calls.push('start'); }
  stop() { this.calls.push('stop'); }
  abort() { this.calls.push('abort'); }
  final(text) { this.onresult({ results: [Object.assign([{ transcript: text }], { isFinal: true })] }); }
}

const flush = async () => { for (let i = 0; i < 5; i += 1) await new Promise(resolve => setImmediate(resolve)); };

const voice = await import('../src/app/voice.js');
const profile = await import('../src/app/views/profile.js');
const state = await import('../src/app/state.js');

voice.initVoice();

const overlayOpen = () => $('voiceOverlay').classList.contains('open');

/** main.js onSignedOut -funktion runko lähdetekstinä. */
function signOutSource() {
  const main = readCode('src/app/main.js');
  return main.slice(main.indexOf('function onSignedOut'), main.indexOf('async function start'));
}

// ============================================================ puhepaneeli

test('lähtötilanne: tunnistettu teksti jää paneeliin piilotuksen yli', async () => {
  globalThis.webkitSpeechRecognition = FakeRecognition;
  $('fabBtn').dispatch('click');
  const recognition = FakeRecognition.instances.at(-1);
  recognition.onstart();
  recognition.final('Varaa aika psykiatrille torstaina');
  await flush();

  assert.equal(overlayOpen(), true);
  assert.equal($('vfTranscriptText').value, 'Varaa aika psykiatrille torstaina');

  // Piilotus (välilehden vaihto) ei sulje tarkistusvaihetta: tämä on
  // tarkoituksellista, ja juuri siksi uloskirjautumisen on nollattava se.
  globalThis.document.hidden = true;
  globalThis.document.dispatch('visibilitychange');
  globalThis.document.hidden = false;
  assert.equal(overlayOpen(), true);

  voice.resetVoice();
});

test('REGRESSIO: resetVoice tyhjentää sanelun, sulkee paneelin ja palauttaa tilakoneen alkuun', async () => {
  globalThis.webkitSpeechRecognition = FakeRecognition;
  $('fabBtn').dispatch('click');
  const recognition = FakeRecognition.instances.at(-1);
  recognition.onstart();
  recognition.final('Varaa aika psykiatrille torstaina');
  await flush();
  $('vfFallbackInput').value = 'kirjoitettu luonnos';
  $('voiceTranscript').textContent = 'Varaa aika';

  voice.resetVoice();

  assert.equal(overlayOpen(), false, 'paneeli jäi auki seuraavalle käyttäjälle');
  assert.equal($('voiceOverlay').getAttribute('aria-hidden'), 'true');
  assert.equal($('vfTranscriptText').value, '', 'A:n sanelu jäi kenttään');
  assert.equal($('vfFallbackInput').value, '', 'A:n kirjoittama teksti jäi kenttään');
  assert.equal($('voiceTranscript').textContent, '');

  // Tilakone on alussa: seuraava napautus avaa paneelin uutena eikä
  // jatka edellisen käyttäjän vaiheesta.
  $('fabBtn').dispatch('click');
  assert.equal(overlayOpen(), true);
  assert.equal($('voiceState-permission').style.display, 'block');
  voice.resetVoice();
});

test('REGRESSIO: resetVoice katkaisee käynnissä olevan kuuntelun, eikä myöhäinen tulos palaa kenttään', async () => {
  globalThis.webkitSpeechRecognition = FakeRecognition;
  $('fabBtn').dispatch('click');
  const recognition = FakeRecognition.instances.at(-1);
  recognition.onstart();

  voice.resetVoice();
  assert.ok(recognition.calls.includes('abort'), 'mikrofoni jäi auki uloskirjautumisen yli');

  recognition.final('myöhäinen sanelu');
  await flush();
  assert.equal($('vfTranscriptText').value, '');
  assert.equal(overlayOpen(), false);
});

test('REGRESSIO: onSignedOut nollaa puhepaneelin', () => {
  assert.match(signOutSource(), /\bresetVoice\(\);/, 'onSignedOut ei nollaa puhepaneelia');
  assert.match(readCode('src/app/main.js'), /import \{[^}]*\bresetVoice\b[^}]*\} from '\.\/voice\.js';/);
});

// ======================================================= profiililomake

test('REGRESSIO: nollatusta tilasta täytetty lomake ei sisällä edellisen käyttäjän terveystietoja', () => {
  state.setProfile({ age: 61, weightKg: 118, heightCm: 172, sleepTargetHours: 6, defaultWakeTime: '05:15' });
  profile.fillProfileForm();
  assert.equal($('pfAge').value, 61);

  // Sama järjestys kuin onSignedOut: tila nollataan, sitten lomake.
  state.resetState();
  profile.fillProfileForm();

  assert.equal($('pfAge').value, '');
  assert.equal($('pfWeight').value, '');
  assert.equal($('pfHeight').value, '');
  assert.equal($('pfSleepTarget').value, 8);
  assert.equal($('pfDefaultWake').value, '07:00');
});

test('REGRESSIO: onSignedOut täyttää profiililomakkeen nollatusta tilasta', () => {
  const body = signOutSource();
  const reset = body.indexOf('resetState();');
  const fill = body.indexOf('fillProfileForm();');
  assert.ok(fill > -1, 'onSignedOut ei tyhjennä profiililomaketta');
  assert.ok(fill > reset, 'lomake täytetään ennen tilan nollausta: edellisen käyttäjän arvot jäisivät');
  assert.ok(fill < body.indexOf('showAuthGate();'), 'lomake tyhjennetään vasta portin jälkeen');
});
