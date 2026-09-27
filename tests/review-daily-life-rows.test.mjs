// Viikkokatsauksen Arki-osio: jokainen arjen arvio omana rivinään ja
// tilansa mukaisella tekstillä (auditointi journey-review-insufficient-as-clear).
//
// LUPAUS: harva aineisto sanotaan tuntemattomaksi ("Liian vähän
// unikirjauksia arvioon (2 / 4 yötä), joten tätä ei tiedetä."), ei
// koskaan "ei huomioita" tai "kaikki hyvin". Selvä viikko kerrotaan
// samoilla luvuilla kuin havainto.
//
// Domain-osa on puhdas; näkymä renderöidään index.html:n tunnisteita
// vastaavaan DOM-tynkään (sama kuvio kuin life-alignment-sparse-first-week).

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  dailyLifeSignals, evaluationText, sleepOpportunityLow, sleepRhythmDrift, wellbeingStrain,
  EVALUATION_STATUS, DAILY_LIFE_SIGNAL
} from '../src/domain/dailyLifeSignals.js';
import { SLEEP_SIGNAL_RULES, WELLBEING_SIGNAL_RULES } from '../src/domain/dailyLifeSignalsPolicy.js';
import { addDaysIso } from '../src/domain/fiTemporal.js';
import { read } from './helpers/sources.mjs';
import { freezeLocalDate } from './helpers/clock.mjs';
import { fakeClient } from './helpers/gates.mjs';
import { setUser, clearUser } from '../src/data/session.js';
import { setClient } from '../src/data/client.js';
import { resetState, setProfile, setSleepLogs, setWellbeing } from '../src/app/state.js';
import { clearLocalUserData } from '../src/app/actions.js';
import { resetAppliedAdjustments } from '../src/app/alignment.js';
import { renderDirection, resetDirectionView } from '../src/app/views/direction.js';

const WEEK = '2026-06-08'; // maanantai
const SUNDAY = '2026-06-14';
const day = i => addDaysIso(WEEK, i);
const DECLARED = Object.freeze({ targetHours: 8, bedtimeTarget: '23:00', wakeTime: '07:00' });
const night = (wakeDate, actualBedtime, actualWake) => ({ id: `s-${wakeDate}`, wakeDate, actualBedtime, actualWake });
const nights = (count, bed = '23:00', wake = '07:00') => Array.from({ length: count }, (_, i) => night(day(i), bed, wake));
const ALL_CLEAR = /ei (ole )?(tällä viikolla )?huomioita|kaikki (on )?hyvin|ei havaintoja/i;

// ================================================================ DOMAIN

test('harva aineisto: teksti kertoo määrän ja tuntemattomuuden, ei "ei huomioita"', () => {
  for (const count of [0, 2]) {
    const input = { weekStart: WEEK, todayIso: SUNDAY, sleepLogs: nights(count), sleepDeclared: DECLARED };
    for (const evaluation of [sleepOpportunityLow(input), sleepRhythmDrift(input), wellbeingStrain(input)]) {
      assert.equal(evaluation.status, EVALUATION_STATUS.INSUFFICIENT_DATA, `${count}: ${evaluation.kind}`);
      const text = evaluationText(evaluation);
      assert.match(text, /^Liian vähän /, text);
      assert.match(text, /joten tätä ei tiedetä\.$/, text);
      assert.doesNotMatch(text, ALL_CLEAR, text);
    }
  }
  const needed = Math.max(SLEEP_SIGNAL_RULES.MIN_REPORTED_NIGHTS, Math.ceil(7 * SLEEP_SIGNAL_RULES.MIN_COVERAGE));
  const two = sleepOpportunityLow({ weekStart: WEEK, todayIso: SUNDAY, sleepLogs: nights(2), sleepDeclared: DECLARED });
  assert.equal(evaluationText(two), `Liian vähän unikirjauksia arvioon (2 / ${needed} yötä), joten tätä ei tiedetä.`);
  const rhythm = sleepRhythmDrift({ weekStart: WEEK, todayIso: SUNDAY, sleepLogs: nights(2), sleepDeclared: DECLARED });
  assert.equal(evaluationText(rhythm), `Liian vähän unikirjauksia rytmin arvioon (2 / ${needed} yötä), joten tätä ei tiedetä.`);
  const wellbeingNeeded = Math.max(WELLBEING_SIGNAL_RULES.MIN_REPORTED_DAYS, Math.ceil(7 * WELLBEING_SIGNAL_RULES.MIN_COVERAGE));
  assert.equal(evaluationText(wellbeingStrain({ weekStart: WEEK, todayIso: SUNDAY })),
    `Liian vähän voinnin merkintöjä arvioon (0 / ${wellbeingNeeded} päivää), joten tätä ei tiedetä.`);
});

test('kesken oleva viikko: vähimmäismäärää ei voi vielä täyttää -> "ei vielä tiedetä"', () => {
  const tuesday = sleepOpportunityLow({ weekStart: WEEK, todayIso: day(1), sleepLogs: nights(1), sleepDeclared: DECLARED });
  assert.equal(tuesday.status, EVALUATION_STATUS.INSUFFICIENT_DATA);
  assert.equal(evaluationText(tuesday),
    `Liian vähän unikirjauksia arvioon (1 / ${SLEEP_SIGNAL_RULES.MIN_REPORTED_NIGHTS} yötä): `
    + 'viikkoa on kulunut vasta 2 yötä, joten tätä ei vielä tiedetä.');
  const monday = wellbeingStrain({ weekStart: WEEK, todayIso: WEEK });
  assert.match(evaluationText(monday), /viikkoa on kulunut vasta 1 päivä, joten tätä ei vielä tiedetä\.$/);
});

test('oma vertailuluku puuttuu: sanotaan, ettei verrata — ei tuntematonta eikä selvää', () => {
  const input = { weekStart: WEEK, todayIso: SUNDAY, sleepLogs: nights(5, '01:30', '07:00') };
  const opportunity = sleepOpportunityLow(input);
  assert.equal(opportunity.status, EVALUATION_STATUS.NO_REFERENCE);
  assert.equal(evaluationText(opportunity), 'Omaa unitavoitetta ei ole asetettu, joten aikaa unelle ei verrata mihinkään.');
  const rhythm = sleepRhythmDrift(input);
  assert.equal(rhythm.status, EVALUATION_STATUS.NO_REFERENCE);
  assert.match(evaluationText(rhythm), /ei ole asetettu, joten rytmiä ei verrata mihinkään\.$/);
});

test('selvä viikko kerrotaan luvuin; havainto käyttää samaa selitystä kuin signaali', () => {
  const clear = dailyLifeSignals({ weekStart: WEEK, todayIso: SUNDAY, sleepLogs: nights(5), sleepDeclared: DECLARED });
  const byKind = Object.fromEntries(clear.evaluations.map(e => [e.kind, e]));
  assert.equal(byKind[DAILY_LIFE_SIGNAL.SLEEP_OPPORTUNITY_LOW].status, EVALUATION_STATUS.CLEAR);
  assert.equal(evaluationText(byKind[DAILY_LIFE_SIGNAL.SLEEP_OPPORTUNITY_LOW]),
    'Aikaa unelle oli keskimäärin 8 h, kun oma tavoitteesi on 8 h. Vähintään 30 min tavoitetta lyhyempiä öitä oli 0 / 5 kirjatusta.');
  assert.equal(evaluationText(byKind[DAILY_LIFE_SIGNAL.SLEEP_RHYTHM_DRIFT]),
    'Nukkumaanmeno ja herääminen poikkesivat omasta rytmistäsi alle 1 h kaikkina 5 kirjattuna yönä.');

  const short = dailyLifeSignals({ weekStart: WEEK, todayIso: SUNDAY, sleepLogs: nights(5, '01:30'), sleepDeclared: DECLARED });
  const signal = short.evaluations.find(e => e.kind === DAILY_LIFE_SIGNAL.SLEEP_OPPORTUNITY_LOW);
  assert.equal(signal.status, EVALUATION_STATUS.SIGNAL);
  assert.equal(evaluationText(signal), signal.signal.explanation);
  assert.match(evaluationText(signal), /5 h 30 min.*5 \/ 5 kirjatusta/);
});

test('tuntematon tai roska-arvio ei kaada tekstiä', () => {
  for (const value of [null, undefined, 5, 'x', [], {}, { kind: 'x', status: 'clear' }, { status: 'signal', signal: null }]) {
    assert.equal(evaluationText(value), null);
  }
});

// ================================================================ NÄKYMÄ: DOM-tynkä

const USER = { id: 'eeeeeeee-5555-4555-8555-00000000000e', email: 'arki@example.com' };
const HTML_IDS = new Set([...read('index.html').matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));

function stubElement(id = null) {
  const listeners = {};
  const attributes = {};
  return {
    id, innerHTML: '', textContent: '', value: '', checked: false, disabled: false, hidden: false,
    style: {}, dataset: {},
    classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
    setAttribute: (k, v) => { attributes[k] = String(v); },
    getAttribute: k => attributes[k] ?? null,
    removeAttribute: k => { delete attributes[k]; },
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
    removeEventListener: () => {},
    focus() { globalThis.document.activeElement = this; },
    scrollIntoView() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    appendChild: () => {},
    remove: () => {},
    closest: () => null
  };
}

function installDom() {
  const elements = new Map();
  globalThis.document = {
    activeElement: null,
    getElementById(id) {
      if (!HTML_IDS.has(id)) return null;
      if (!elements.has(id)) elements.set(id, stubElement(id));
      return elements.get(id);
    },
    createElement: () => stubElement(),
    querySelectorAll: () => [],
    body: { appendChild: () => {} }
  };
  globalThis.CSS = { escape: value => String(value) };
}

/** Arki-osion rivit: [[kysymys, vastaus], ...]. */
function arkiRows() {
  const review = globalThis.document.getElementById('dirReview').innerHTML;
  const start = review.indexOf('>Arki <');
  assert.ok(start > -1, 'Arki-osio näkyy');
  const section = review.slice(start, review.indexOf('</dl>', start));
  return [...section.matchAll(/<dt>([^<]*)<\/dt><dd>([^<]*)<\/dd>/g)].map(m => [m[1], m[2]]);
}

beforeEach(() => {
  clearUser();
  clearLocalUserData();
  resetState();
  resetAppliedAdjustments();
  resetDirectionView();
  setUser(USER);
  setClient(fakeClient({ data: [], error: null }));
  installDom();
});

afterEach(() => {
  delete globalThis.document;
  delete globalThis.CSS;
});

function renderWeek(t, { logs = [], wellbeing = [] } = {}) {
  freezeLocalDate(t, SUNDAY, '20:00');
  setProfile({ sleepTargetHours: 8, defaultWakeTime: '07:00' });
  setSleepLogs(logs);
  setWellbeing(wellbeing);
  renderDirection();
  return arkiRows();
}

test('näkymä: 0 tai 2 unikirjausta -> jokainen rivi sanoo "liian vähän", ei yleistä "ei huomioita"', (t) => {
  for (const count of [0, 2]) {
    const rows = renderWeek(t, { logs: nights(count) });
    assert.deepEqual(rows.map(([question]) => question),
      ['Riittikö aika unelle?', 'Pysyikö unirytmi omana?', 'Näkyikö kuormitus voinnin merkinnöissä?']);
    for (const [, answer] of rows) {
      assert.match(answer, /^Liian vähän .*joten tätä ei tiedetä\.$/, answer);
      assert.doesNotMatch(answer, ALL_CLEAR, answer);
    }
    assert.match(rows[0][1], new RegExp(`\\(${count} / \\d yötä\\)`));
    t.mock.timers.reset();
  }
  const review = globalThis.document.getElementById('dirReview').innerHTML;
  assert.doesNotMatch(review, /Unesta, rytmistä tai voinnista ei ole tällä viikolla huomioita/);
});

test('näkymä: viisi lyhyttä yötä -> havainto omalla rivillään; vointi yhä tuntematon', (t) => {
  const rows = renderWeek(t, { logs: nights(5, '01:30') });
  assert.match(rows[0][1], /^Aikaa unelle oli keskimäärin 5 h 30 min, kun oma tavoitteesi on 8 h\./);
  // Nukkumaanmenon tavoitetta ei ole asetettu; herääminen 07.00 = oma
  // herätysaika. Selvä rivi kerrotaan luvuin, ei "ei huomioita".
  assert.equal(rows[1][1], 'Nukkumaanmeno ja herääminen poikkesivat omasta rytmistäsi alle 1 h kaikkina 5 kirjattuna yönä.');
  assert.match(rows[2][1], /^Liian vähän voinnin merkintöjä arvioon/);
});

test('näkymä: Arki-osio ei lue tekoälyä eikä tallenna tekstejä tilannekuvaan', () => {
  const view = read('src/app/views/direction.js');
  const rowsFn = view.slice(view.indexOf('function dailyLifeRows'), view.indexOf('function reviewHtml'));
  assert.doesNotMatch(rowsFn, /ai\/|explain|logEvent|save|snapshot/i);
});
