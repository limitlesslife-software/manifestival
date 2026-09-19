// Puheohjauksen tilakone, lauseen alkureititys ja vaiheraportointi.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { read, readCode } from './helpers/sources.mjs';
import {
  VOICE, VOICE_EVENT, PROCESSING_STATES, initialVoiceState, nextVoiceState, micActive, isProcessing
} from '../src/domain/voiceFlow.js';
import { routeUtterance, ROUTE } from '../src/domain/utteranceRoute.js';
import { setUser, clearUser } from '../src/data/session.js';
import { setClient } from '../src/data/client.js';
import { fakeClient } from './helpers/gates.mjs';
import { resetState, setTasks } from '../src/app/state.js';
import { clearLocalUserData } from '../src/app/actions.js';
import { normalizeTask } from '../src/domain/task.js';
import { resetExecutionLedger } from '../src/app/aiCommands.js';
import { runVoiceCommand } from '../src/app/voice.js';
import { runTypedCommand } from '../src/app/commandBar.js';

const next = (state, event, ctx) => nextVoiceState(state, event, ctx);
const walk = (events, start = VOICE.IDLE, ctx) => events.reduce((state, event) => next(state, event, ctx), start);

// ------------------------------------------------------------- tilakone

test('normaali polku: IDLE -> ... -> SUCCESS', () => {
  const states = [];
  let state = initialVoiceState();
  for (const event of [
    VOICE_EVENT.OPEN, VOICE_EVENT.MIC_STARTED, VOICE_EVENT.HEARD, VOICE_EVENT.SUBMIT,
    VOICE_EVENT.PHASE_REVIEW, VOICE_EVENT.PHASE_CONFIRM, VOICE_EVENT.PHASE_EXECUTE, VOICE_EVENT.DONE_OK
  ]) {
    state = next(state, event);
    states.push(state);
  }
  assert.deepEqual(states, [
    VOICE.REQUESTING_PERMISSION, VOICE.LISTENING, VOICE.TRANSCRIPT_READY, VOICE.CLASSIFYING,
    VOICE.REVIEW, VOICE.CONFIRMATION, VOICE.EXECUTING, VOICE.SUCCESS
  ]);
});

test('epäselvä kohde: CLASSIFYING -> TARGET_SELECTION -> REVIEW -> CONFIRMATION -> EXECUTING', () => {
  const state = walk([
    VOICE_EVENT.OPEN, VOICE_EVENT.MIC_STARTED, VOICE_EVENT.HEARD, VOICE_EVENT.SUBMIT,
    VOICE_EVENT.PHASE_TARGET, VOICE_EVENT.PHASE_REVIEW, VOICE_EVENT.PHASE_CONFIRM, VOICE_EVENT.PHASE_EXECUTE
  ]);
  assert.equal(state, VOICE.EXECUTING);
});

test('KRIITTINEN: litterointi ei mene tulkintaan ilman SUBMIT-tapahtumaa (käyttäjän tarkistus)', () => {
  // HEARD johtaa TRANSCRIPT_READY:yn, ei CLASSIFYING:iin.
  assert.equal(walk([VOICE_EVENT.OPEN, VOICE_EVENT.MIC_STARTED, VOICE_EVENT.HEARD]), VOICE.TRANSCRIPT_READY);
  // SUBMIT ei ole sallittu kuuntelusta, virheestä, tyhjästä eikä käsittelystä.
  for (const state of [VOICE.IDLE, VOICE.REQUESTING_PERMISSION, VOICE.LISTENING, VOICE.ERROR, ...PROCESSING_STATES, VOICE.SUCCESS]) {
    assert.equal(next(state, VOICE_EVENT.SUBMIT), state, state);
  }
  assert.equal(next(VOICE.TRANSCRIPT_READY, VOICE_EVENT.SUBMIT), VOICE.CLASSIFYING);
  assert.equal(next(VOICE.TYPE_FALLBACK, VOICE_EVENT.SUBMIT), VOICE.CLASSIFYING, 'kirjoitettu teksti saa mennä suoraan');
});

test('KRIITTINEN: mikrofoni on päällä vain kahdessa tilassa', () => {
  const active = Object.values(VOICE).filter(micActive);
  assert.deepEqual(active.sort(), [VOICE.LISTENING, VOICE.REQUESTING_PERMISSION].sort());
});

test('KRIITTINEN: sivun piilotus sammuttaa mikrofonin (ei taustamikrofonia)', () => {
  assert.equal(next(VOICE.LISTENING, VOICE_EVENT.HIDDEN), VOICE.IDLE);
  assert.equal(next(VOICE.REQUESTING_PERMISSION, VOICE_EVENT.HIDDEN), VOICE.IDLE);
  // Käsittelyssä oleva komento ei katoa piilotuksesta; mikrofoni ei ole silloin päällä.
  for (const state of PROCESSING_STATES) {
    assert.equal(next(state, VOICE_EVENT.HIDDEN), state);
    assert.equal(micActive(state), false);
  }
  assert.equal(next(VOICE.TRANSCRIPT_READY, VOICE_EVENT.HIDDEN), VOICE.TRANSCRIPT_READY, 'teksti säilyy muokattavana');
});

test('peruutus ja sulkeminen ovat mahdollisia joka tilasta ja palauttavat IDLE:n', () => {
  for (const state of Object.values(VOICE)) assert.equal(next(state, VOICE_EVENT.CANCEL), VOICE.IDLE, state);
});

test('mikrofoni ei tuettu: avaus menee suoraan kirjoitukseen; myöhäinen MIC_UNSUPPORTED myös', () => {
  assert.equal(next(VOICE.IDLE, VOICE_EVENT.OPEN, { micSupported: false }), VOICE.TYPE_FALLBACK);
  assert.equal(next(VOICE.REQUESTING_PERMISSION, VOICE_EVENT.MIC_UNSUPPORTED), VOICE.TYPE_FALLBACK);
  assert.equal(next(VOICE.ERROR, VOICE_EVENT.RETRY, { micSupported: false }), VOICE.TYPE_FALLBACK);
});

test('virhe ja uudelleenyritys: FAIL vain kuuntelusta, RETRY virheestä/tekstistä, TYPE_INSTEAD virheestä', () => {
  assert.equal(next(VOICE.LISTENING, VOICE_EVENT.FAIL), VOICE.ERROR);
  assert.equal(next(VOICE.REQUESTING_PERMISSION, VOICE_EVENT.FAIL), VOICE.ERROR, 'lupa evätty');
  for (const state of [VOICE.IDLE, VOICE.TRANSCRIPT_READY, VOICE.CLASSIFYING, VOICE.SUCCESS]) {
    assert.equal(next(state, VOICE_EVENT.FAIL), state, state + ': FAIL ei saa keskeyttää muuta');
  }
  assert.equal(next(VOICE.ERROR, VOICE_EVENT.RETRY), VOICE.REQUESTING_PERMISSION);
  assert.equal(next(VOICE.TRANSCRIPT_READY, VOICE_EVENT.RETRY), VOICE.REQUESTING_PERMISSION);
  assert.equal(next(VOICE.LISTENING, VOICE_EVENT.RETRY), VOICE.LISTENING, 'kuuntelun aikana retry ei aloita uutta');
  assert.equal(next(VOICE.ERROR, VOICE_EVENT.TYPE_INSTEAD), VOICE.TYPE_FALLBACK);
});

test('komennon lopputulokset: OK -> SUCCESS, peruttu -> IDLE, virhe -> ERROR; vain käsittelystä', () => {
  for (const state of PROCESSING_STATES) {
    assert.equal(next(state, VOICE_EVENT.DONE_OK), VOICE.SUCCESS);
    assert.equal(next(state, VOICE_EVENT.DONE_CANCELLED), VOICE.IDLE);
    assert.equal(next(state, VOICE_EVENT.DONE_ERROR), VOICE.ERROR);
  }
  for (const state of [VOICE.IDLE, VOICE.LISTENING, VOICE.TRANSCRIPT_READY, VOICE.ERROR, VOICE.TYPE_FALLBACK]) {
    for (const event of [VOICE_EVENT.DONE_OK, VOICE_EVENT.DONE_CANCELLED, VOICE_EVENT.DONE_ERROR]) {
      assert.equal(next(state, event), state, `${state} + ${event}`);
    }
  }
});

test('KRIITTINEN: paneeli suljettu kesken käsittelyn -> myöhäinen tulos ei herätä paneelia', () => {
  // Käyttäjä sulkee (CANCEL -> IDLE), komento päättyy myöhemmin.
  let state = walk([VOICE_EVENT.OPEN, VOICE_EVENT.MIC_STARTED, VOICE_EVENT.HEARD, VOICE_EVENT.SUBMIT, VOICE_EVENT.PHASE_CONFIRM]);
  state = next(state, VOICE_EVENT.CANCEL);
  assert.equal(state, VOICE.IDLE);
  for (const late of [VOICE_EVENT.DONE_OK, VOICE_EVENT.DONE_ERROR, VOICE_EVENT.PHASE_REVIEW, VOICE_EVENT.PHASE_EXECUTE]) {
    assert.equal(next(state, late), VOICE.IDLE, late);
  }
});

test('avaus vain suljetusta: avoin paneeli ei aloita uutta kuuntelua OPEN-tapahtumasta', () => {
  for (const state of Object.values(VOICE).filter(s => s !== VOICE.IDLE)) {
    assert.equal(next(state, VOICE_EVENT.OPEN), state, state);
  }
});

test('tuntematon tapahtuma, tuntematon tila ja rikkinäinen syöte eivät kaada eivätkä etene', () => {
  assert.equal(next(VOICE.LISTENING, 'poista_kaikki'), VOICE.LISTENING);
  assert.equal(next(undefined, VOICE_EVENT.OPEN), VOICE.REQUESTING_PERMISSION);
  assert.equal(next('outo', VOICE_EVENT.SUBMIT), VOICE.IDLE);
  assert.equal(next(null, undefined), VOICE.IDLE);
  assert.equal(next('__proto__', VOICE_EVENT.OPEN), VOICE.REQUESTING_PERMISSION);
});

test('isProcessing kattaa täsmälleen käsittelyvaiheet', () => {
  assert.deepEqual(Object.values(VOICE).filter(isProcessing).sort(), [...PROCESSING_STATES].sort());
  assert.equal(PROCESSING_STATES.length, 5);
});

test('tilakone on puhdas: ei DOM:ia, kelloa eikä sivuvaikutuksia', () => {
  const source = readCode('src/domain/voiceFlow.js');
  for (const forbidden of ['document', 'window', 'Date.now', 'setTimeout', 'fetch(', 'localStorage', 'console.']) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});

// -------------------------------------------------------- alkureititys

test('selvä haku ohjataan hakuun hakusanalla', () => {
  const cases = [
    ['Etsi kaikki rengastilaukseen liittyvät tehtävät', 'rengastilaukseen'],
    ['etsi lääkäri', 'lääkäri'],
    ['Löydä sähkölasku', 'sähkölasku'],
    ['ETSI Motonet', 'Motonet'],
    ['Etsi: hammaslääkäri, ensi viikko', 'hammaslääkäri, ensi viikko'.replace(',', '')],
    ['  etsi   auton   pesu  ', 'auton pesu']
  ];
  for (const [text, query] of cases) {
    const route = routeUtterance(text);
    assert.equal(route.kind, ROUTE.SEARCH, text);
    assert.equal(route.query, query, text);
  }
});

test('KRIITTINEN: luonti ja komennot eivät ohjaudu hakuun (mm. "etsimään", "hae lapset")', () => {
  for (const text of [
    'Muistuta minua etsimään avaimet', 'Lisää tehtävä etsi uusi työpaikka', 'Hae lapset koulusta huomenna klo 15',
    'Siirrä auton pesu perjantaille', 'Merkitse sähkölasku maksetuksi', 'Etsin avaimia', 'Etsiminen on vaikeaa',
    'Poista muistutus lääkäri', 'Näytä huominen', 'Lisää tehtävä pestä auto huomenna'
  ]) {
    assert.equal(routeUtterance(text).kind, ROUTE.MODEL, text);
  }
});

test('pelkkä "etsi" ilman hakusanaa, tyhjä ja täytesanat eivät ole haku', () => {
  for (const text of ['etsi', 'Etsi kaikki', 'etsi kaikki tehtävät', 'Löydä', '', '   ', null, undefined, 5, {}]) {
    assert.equal(routeUtterance(text).kind, ROUTE.MODEL, String(text));
  }
});

test('hakusana rajataan ja välimerkit riisutaan; alku-/loppuvälimerkit pois', () => {
  assert.equal(routeUtterance('etsi "auton pesu"!').query, 'auton pesu');
  assert.ok(routeUtterance('etsi ' + 'a'.repeat(500)).query.length <= 100);
});

test('reititys on deterministinen ja puhdas', () => {
  const first = JSON.stringify(routeUtterance('Etsi kaikki rengastilaukseen liittyvät tehtävät'));
  for (let i = 0; i < 300; i += 1) assert.equal(JSON.stringify(routeUtterance('Etsi kaikki rengastilaukseen liittyvät tehtävät')), first);
  const source = readCode('src/domain/utteranceRoute.js');
  for (const forbidden of ['fetch(', 'Date.now', 'Math.random', 'document', 'localStorage']) assert.equal(source.includes(forbidden), false);
});

// ------------------------------------------------------- vaiheraportointi

const USER = { id: 'aaaaaaaa-1111-4111-8111-000000000011', email: 'v@example.com' };
const modelSays = json => async () => ({ ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: JSON.stringify(json) }] }) });

beforeEach(() => {
  clearUser(); clearLocalUserData(); resetState(); resetExecutionLedger();
  setUser(USER);
  setClient(fakeClient({ data: [], error: null }));
});

test('onPhase raportoi vaiheet oikeassa järjestyksessä: luonti', async () => {
  const phases = [];
  await runVoiceCommand('lisää tehtävä x', {
    fetchImpl: modelSays({ intent: 'create_task', title: 'X', date: '2026-09-20' }),
    confirmFn: async () => true, chooseFn: async () => null, onPhase: phase => phases.push(phase)
  });
  assert.deepEqual(phases, ['classifying', 'review', 'confirmation', 'executing']);
});

test('onPhase: epäselvä kohde näyttää target_selection ennen review/confirmation', async () => {
  setTasks([
    normalizeTask({ id: 'a', title: 'Lääkäriaika', date: '2026-09-20' }),
    normalizeTask({ id: 'b', title: 'Lääkäriaika', date: '2026-09-27' })
  ]);
  const phases = [];
  await runVoiceCommand('siirrä lääkäriaika', {
    fetchImpl: modelSays({ intent: 'reschedule_task', targetName: 'Lääkäriaika', date: '2026-09-25' }),
    confirmFn: async () => true, chooseFn: async list => list[0], onPhase: phase => phases.push(phase)
  });
  assert.deepEqual(phases, ['classifying', 'target_selection', 'review', 'confirmation', 'executing']);
});

test('onPhase: vain lukeva komento ohittaa vahvistuksen; peruttu ei koskaan pääse executing-vaiheeseen', async () => {
  const readOnly = [];
  await runVoiceCommand('näytä ensi viikko', {
    fetchImpl: modelSays({ intent: 'show_week_plan', date: '2026-09-25' }),
    confirmFn: async () => true, chooseFn: async () => null, onPhase: phase => readOnly.push(phase)
  });
  assert.deepEqual(readOnly, ['classifying', 'review', 'executing']);

  const cancelled = [];
  await runVoiceCommand('lisää tehtävä x', {
    fetchImpl: modelSays({ intent: 'create_task', title: 'X', date: '2026-09-20' }),
    confirmFn: async () => false, chooseFn: async () => null, onPhase: phase => cancelled.push(phase)
  });
  assert.deepEqual(cancelled, ['classifying', 'review', 'confirmation'], 'peruttu vahvistus päättyy ennen suoritusta');
});

test('onPhase on valinnainen: ilman sitä käyttäytyminen on ennallaan, ja virheellinen callback ei kaada', async () => {
  const result = await runTypedCommand('lisää tehtävä x', {
    fetchImpl: modelSays({ intent: 'create_task', title: 'X', date: '2026-09-20' }),
    confirmFn: async () => true, chooseFn: async () => null, onPhase: 'ei funktio'
  });
  assert.equal(result.ok, true);
});

// ------------------------------------------------ voice.js: sivuvaikutukset

test('KRIITTINEN: voice.js käyttää tilakonetta eikä aseta paneelia suoraan tapahtumakäsittelijöistä', () => {
  const voice = readCode('src/app/voice.js');
  assert.match(voice, /nextVoiceState\(flow, event/);
  assert.equal((voice.match(/flow = /g) || []).length >= 2, true);
  // showState kutsutaan vain applyState():sta (yksi kutsupaikka).
  assert.equal((voice.match(/showState\(/g) || []).length, 2, 'määrittely + applyState');
  assert.match(voice, /if \(!micActive\(flow\)\) stopRecognition\(\)/);
});

test('KRIITTINEN: mikrofoni sammutetaan sivun piilotuksessa ja sulkemisessa; ei taustakuuntelua', () => {
  const voice = readCode('src/app/voice.js');
  assert.match(voice, /document\.addEventListener\('visibilitychange'/);
  assert.match(voice, /window\.addEventListener\('pagehide'/);
  assert.match(voice, /VOICE_EVENT\.HIDDEN/);
  assert.equal(/continuous = true/.test(voice), false, 'jatkuva kuuntelu kielletty');
  assert.match(voice, /continuous = false/);
  assert.equal(/MediaRecorder|getUserMedia/.test(voice), false, 'ääntä ei tallenneta');
});

test('selvä haku puhuttuna avaa hakupaneelin hakusanalla eikä kutsu komentoputkea', () => {
  const voice = readCode('src/app/voice.js');
  const submit = voice.slice(voice.indexOf('const submitTranscript'), voice.indexOf('function setupRecognition'));
  assert.ok(submit.indexOf('routeUtterance(clean)') > -1);
  assert.ok(submit.indexOf('openSearch(route.query)') > submit.indexOf('routeUtterance(clean)'));
  assert.ok(submit.indexOf('openSearch(route.query)') < submit.indexOf('runVoiceCommand(clean'),
    'haku ohjataan ennen komentoputkea');

  const search = readCode('src/app/search.js');
  assert.match(search, /export function openSearch\(query = ''\)/);
  assert.match(search, /typeof query === 'string' \? query : ''/, 'klikkauksen tapahtumaolio ei kelpaa hakusanaksi');
});

test('tyhjä muokattu teksti ei lähde tulkittavaksi eikä tuota virhettä', () => {
  const voice = readCode('src/app/voice.js');
  const submit = voice.slice(voice.indexOf('const submitTranscript'), voice.indexOf('function setupRecognition'));
  assert.ok(submit.indexOf('if (!clean)') < submit.indexOf('transition(VOICE_EVENT.SUBMIT)'));
});

test('suljettu paneeli ei jää kuuntelemaan: closeOverlay sammuttaa tunnistuksen ja palauttaa fokuksen', () => {
  const voice = readCode('src/app/voice.js');
  const close = voice.slice(voice.indexOf('function closeOverlay'), voice.indexOf('function stopRecognition'));
  assert.match(close, /stopRecognition\(\)/);
  assert.match(close, /opener\.focus\(\)/);
  assert.match(voice, /flow === VOICE\.IDLE \|\| flow === VOICE\.SUCCESS/);
});

test('puheen tilasiirtymät kirjataan vain tilan nimillä (ei litterointia)', () => {
  const voice = read('src/app/voice.js');
  assert.match(voice, /logEvent\('voice\.state', \{ from: before, to: flow \}\)/);
});
