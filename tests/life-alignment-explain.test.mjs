// Suunta 2: valinnainen tekoälyselitys ja sen varapolku.
//
// YDIN EI RIIPU TEKOÄLYSTÄ: jokainen epäonnistuminen palauttaa
// deterministisen suomenkielisen selityksen. Lähtevä konteksti on
// minimoitu: ei aluenimiä, ei otsikoita, ei pohdintoja.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { explainWithFallback, explanationContext, acceptableExplanation } from '../src/ai/alignmentExplainClient.js';
import { analyzeWeek, SIGNAL } from '../src/domain/alignment.js';
import { explainSignal } from '../src/domain/alignmentReview.js';
import { normalizeLifeArea } from '../src/domain/lifeArea.js';
import { normalizeTask } from '../src/domain/task.js';
import { normalizeTimeEntry } from '../src/domain/timeEntry.js';
import { normalizeWeeklyCapacity } from '../src/domain/weeklyCapacity.js';
import { readCode } from './helpers/sources.mjs';

const WEEK = '2026-09-14';
const areas = [
  normalizeLifeArea({ id: 'fam', name: 'Avioero ja lapset', importance: 5, targetMinutesPerWeek: 600, categoryKey: 'perhe' }),
  normalizeLifeArea({ id: 'work', name: 'Työ', importance: 3, targetMinutesPerWeek: 600, categoryKey: 'tyo' })
];
const analysis = analyzeWeek({
  weekStart: WEEK, todayIso: '2026-09-18', areas,
  tasks: [normalizeTask({ id: 't', title: 'Terapia-aika salaa', date: '2026-09-15', durationMinutes: 900, category: 'tyo' })],
  timeEntries: [normalizeTimeEntry({ id: 'e', entryDate: '2026-09-15', minutes: 600, lifeAreaId: 'work', note: 'yksityinen muistiinpano' })],
  capacity: normalizeWeeklyCapacity({ id: 'c', weekStart: WEEK, availableMinutes: 600 })
});
const neglect = analysis.signals.find(signal => signal.kind === SIGNAL.NEGLECT);

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test('lähtevä konteksti: vain valittu havainto, alueet tunnuksina, ei otsikoita eikä muistiinpanoja', async () => {
  let sent = null;
  await explainWithFallback({
    analysis, signal: neglect, areas, accessToken: 'token',
    fetchImpl: async (url, init) => { sent = { url, init }; return response(200, { text: 'A1 on saanut vähemmän aikaa kuin toivoit. Haluatko varata aikaa vai muuttaa tavoitetta?' }); }
  });
  const body = sent.init.body;
  assert.match(sent.url, /\/api\/explain$/);
  for (const secret of ['Avioero', 'Terapia', 'yksityinen', 'Työ']) {
    assert.equal(body.includes(secret), false, `vuoto: ${secret}`);
  }
  const parsed = JSON.parse(body);
  assert.equal(parsed.context.signals.length, 1);
  assert.equal(parsed.context.areas.length, 1);
  assert.match(parsed.context.areas[0].area, /^A\d+$/);
  assert.equal(sent.init.headers.Authorization, 'Bearer token');
});

test('onnistunut vastaus: aluenimet palautetaan paikallisesti', async () => {
  const result = await explainWithFallback({
    analysis, signal: neglect, areas, accessToken: 'token',
    fetchImpl: async () => response(200, { text: 'A1 on saanut vähemmän aikaa kuin toivoit. Haluatko varata aikaa?' })
  });
  assert.equal(result.source, 'ai');
  assert.match(result.text, /^Avioero ja lapset on saanut/);
});

test('VARAPOLKU: verkkovirhe, palvelinvirhe, aikakatkaisu, ei tokenia -> deterministinen selitys', async () => {
  const expected = explainSignal(neglect, areas);
  const cases = [
    { accessToken: null, fetchImpl: async () => response(200, { text: 'x'.repeat(50) }) },
    { accessToken: 't', fetchImpl: async () => { throw new TypeError('Failed to fetch'); } },
    { accessToken: 't', fetchImpl: async () => response(502, { error: 'Selitys epaonnistui' }) },
    { accessToken: 't', fetchImpl: async () => response(200, {}) },
    { accessToken: 't', fetchImpl: async () => { const e = new Error('abort'); e.name = 'AbortError'; throw e; } }
  ];
  for (const options of cases) {
    const result = await explainWithFallback({ analysis, signal: neglect, areas, ...options });
    assert.equal(result.source, 'deterministic');
    assert.equal(result.title, expected.title);
    assert.ok(result.text.includes(expected.text));
    assert.ok(result.failure);
  }
});

test('VARAPOLKU: vastaus, joka väittää muuttaneensa jotain tai ohjaa linkkiin, hylätään', async () => {
  for (const text of [
    'Muutin tavoitteesi puolestasi pienemmäksi, jotta viikko mahtuu.',
    'Lue lisää osoitteesta https://example.com/elamanohjeet ja toimi niin.',
    'lyhyt'
  ]) {
    assert.equal(acceptableExplanation(text), false, text);
    const result = await explainWithFallback({ analysis, signal: neglect, areas, accessToken: 't', fetchImpl: async () => response(200, { text }) });
    assert.equal(result.source, 'deterministic');
  }
});

test('selitys ei kirjoita mitään: asiakas ei tuo repositorioita eikä toimintoja', () => {
  const imports = [...readCode('src/ai/alignmentExplainClient.js').matchAll(/from '([^']+)'/g)].map(m => m[1]);
  assert.equal(imports.some(path => /data\/(collectionsRepo|tasksRepo)|app\//.test(path)), false);
  const endpoint = readCode('api/explain.js');
  assert.equal(/\.from\(|insert\(|update\(|supabase/i.test(endpoint.replace(/\/\/.*$/gm, '')), false);
});

test('lokitus: vain lähde ja lopputulos, ei tekstiä eikä aluenimiä', () => {
  const app = readCode('src/app/alignment.js');
  const call = /logEvent\('alignment\.explanation', \{([^}]*)\}\)/.exec(app);
  assert.ok(call, 'selityksen lokirivi puuttuu');
  assert.equal(/text|name|title|reflection/.test(call[1]), false, call[1]);
});

test('minimoitu konteksti: tunnit puolen tunnin tarkkuudella, ei tunnisteita', () => {
  const { context } = explanationContext(analysis, neglect);
  const serialized = JSON.stringify(context);
  assert.equal(serialized.includes('"fam"') || serialized.includes('"work"'), false, 'alueiden tunnisteet eivät lähde');
  for (const value of Object.values(context.signals[0].metrics)) {
    if (typeof value === 'number') assert.equal(value * 2, Math.round(value * 2));
  }
});
