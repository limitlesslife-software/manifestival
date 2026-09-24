// Suunta 2: yksityisyys.
//
// Elämänalueet, pohdinnat ja kirjausten muistiinpanot ovat käyttäjän
// arkaluonteisinta sisältöä. Tämä tiedosto vartioi, etteivät ne päädy
// lokiin, laitteen tallenteeseen otsikoina, tekoälylle tai vientiin
// omistajatunnisteen kanssa.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readCode } from './helpers/sources.mjs';
import { buildAlignmentAssistantContext } from '../src/ai/alignmentContext.js';
import { analyzeWeek } from '../src/domain/alignment.js';
import { buildReviewSnapshot } from '../src/domain/alignmentReview.js';
import { normalizeLifeArea } from '../src/domain/lifeArea.js';
import { normalizeTask } from '../src/domain/task.js';
import { normalizeTimeEntry } from '../src/domain/timeEntry.js';

const FILES = ['src/app/alignment.js', 'src/app/timeTracking.js', 'src/app/timerState.js', 'src/app/views/timeLog.js',
  'src/app/views/direction.js', 'src/app/timeEntryWriter.js', 'src/data/timerStore.js'];

test('lokirivit eivät kanna nimiä, otsikoita, muistiinpanoja eikä pohdintoja', () => {
  const forbidden = /\b(name|title|note|reflection|reflectionAnswers|description|label|text|answers?)\s*:/;
  for (const file of FILES) {
    const code = readCode(file);
    for (const match of code.matchAll(/logEvent\(\s*'[^']+'\s*,\s*\{([\s\S]*?)\}\s*\)/g)) {
      assert.equal(forbidden.test(match[1]), false, `${file}: ${match[0].slice(0, 120)}`);
    }
    assert.equal(/console\.(log|info|debug)\(/.test(code), false, `${file}: konsolilokitus`);
  }
});

test('tekoälykonteksti ei sisällä aluenimiä, otsikoita eikä muistiinpanoja', () => {
  const areas = [normalizeLifeArea({ id: 'x', name: 'Terapia', importance: 5, targetMinutesPerWeek: 300 })];
  const analysis = analyzeWeek({
    weekStart: '2026-09-14', todayIso: '2026-09-18', areas,
    tasks: [normalizeTask({ id: 't', title: 'Salainen', date: '2026-09-15', durationMinutes: 60 })],
    timeEntries: [normalizeTimeEntry({ id: 'e', entryDate: '2026-09-15', minutes: 30, note: 'yksityinen', lifeAreaId: 'x' })]
  });
  const serialized = JSON.stringify(buildAlignmentAssistantContext(analysis).context);
  for (const secret of ['Terapia', 'Salainen', 'yksityinen', '"x"', '"t"']) {
    assert.equal(serialized.includes(secret), false, secret);
  }
});

test('tilannekuva ei kopioi tehtävien otsikoita eikä kirjausten muistiinpanoja', () => {
  const analysis = analyzeWeek({
    weekStart: '2026-09-14', todayIso: '2026-09-18',
    areas: [normalizeLifeArea({ id: 'x', name: 'Oma', importance: 3, targetMinutesPerWeek: 60 })],
    tasks: [normalizeTask({ id: 't', title: 'Salainen tehtävä', date: '2026-09-15', durationMinutes: 60 })],
    timeEntries: [normalizeTimeEntry({ id: 'e', entryDate: '2026-09-15', minutes: 30, note: 'yksityinen muistiinpano' })]
  });
  const snapshot = JSON.stringify(buildReviewSnapshot(analysis));
  assert.equal(snapshot.includes('Salainen'), false);
  assert.equal(snapshot.includes('yksityinen'), false);
});

test('pohdintavastauksia ei lähetetä minnekään: vain katsauksen rivi', () => {
  for (const file of ['src/ai/alignmentExplainClient.js', 'src/ai/alignmentContext.js', 'api/explain.js', 'src/ai/planSchema.js']) {
    assert.equal(/reflection/i.test(readCode(file).replace(/\/\/.*$/gm, '')), false, file);
  }
});

test('ei sijaintia: Suunta 2 ei käytä sijaintirajapintoja', () => {
  for (const file of [...FILES, 'src/domain/timer.js', 'src/domain/realitySources.js']) {
    assert.equal(/geolocation|getCurrentPosition|coords\./.test(readCode(file)), false, file);
  }
});
