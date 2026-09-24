// Suunta ja tekoäly: konteksti on minimoitu, eikä tekoäly päätä havainnoista.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readCode } from './helpers/sources.mjs';
import { analyzeWeek } from '../src/domain/alignment.js';
import { normalizeLifeArea } from '../src/domain/lifeArea.js';
import { normalizeTask } from '../src/domain/task.js';
import { normalizeGoal } from '../src/domain/goal.js';
import { normalizeTimeEntry } from '../src/domain/timeEntry.js';
import { normalizeWeeklyCapacity } from '../src/domain/weeklyCapacity.js';
import {
  buildAlignmentAssistantContext, restoreAreaNames, ASSISTANT_RULES
} from '../src/ai/alignmentContext.js';

const WEEK = '2026-09-14';

function sensitiveAnalysis() {
  const areas = [
    normalizeLifeArea({ id: 'area-secret-id', name: 'Terapia', importance: 5, targetMinutesPerWeek: 600,
      description: 'Yksityinen kuvaus', categoryKey: 'hyvinvointi' }),
    normalizeLifeArea({ id: 'area-2', name: 'Työ', importance: 3, targetMinutesPerWeek: 1200, categoryKey: 'tyo' })
  ];
  const goals = [normalizeGoal({ id: 'goal-x', title: 'SALAINEN TAVOITE', lifeAreaId: 'area-secret-id' })];
  const tasks = [
    normalizeTask({ id: 't1', title: 'SALAINEN TEHTÄVÄ', date: WEEK, durationMinutes: 900, category: 'tyo', note: 'SALAINEN MUISTIINPANO' }),
    normalizeTask({ id: 't2', title: 'Toinen', date: WEEK, durationMinutes: null, goalId: 'goal-x' })
  ];
  const timeEntries = [
    normalizeTimeEntry({ id: 'e1', entryDate: WEEK, minutes: 700, lifeAreaId: 'area-2', note: 'SALAINEN KIRJAUS' }),
    normalizeTimeEntry({ id: 'e2', entryDate: WEEK, minutes: 20, lifeAreaId: 'area-secret-id' })
  ];
  return analyzeWeek({
    weekStart: WEEK, todayIso: '2026-09-21', areas, goals, tasks, timeEntries,
    capacity: normalizeWeeklyCapacity({ id: 'c', weekStart: WEEK, availableMinutes: 600, note: 'SALAINEN' })
  });
}

test('KRIITTINEN: konteksti ei sisällä tunnisteita, otsikoita, muistiinpanoja eikä aluenimiä', () => {
  const analysis = sensitiveAnalysis();
  assert.ok(analysis.signals.length >= 2, 'aineistossa on havaintoja selitettäväksi');
  const { context } = buildAlignmentAssistantContext(analysis);
  const json = JSON.stringify(context);
  for (const forbidden of ['SALAINEN', 'Terapia', 'Työ', 'area-secret-id', 'goal-x', 't1', 'e1',
    'Yksityinen', 'hyvinvointi', 'description', 'note', 'title', 'userId', 'user_id']) {
    assert.equal(json.includes(forbidden), false, `kontekstissa on: ${forbidden}`);
  }
  assert.ok(json.includes('"A1"') && json.includes('"A2"'), 'alueet tunnuksina');
});

test('konteksti välittää luvut ja havainnot sellaisinaan (tunteina), ei päätöksiä', () => {
  const analysis = sensitiveAnalysis();
  const { context } = buildAlignmentAssistantContext(analysis);
  assert.equal(context.capacityHours, 10);
  assert.equal(context.plannedHours, 15);
  assert.equal(context.unestimatedCount, 1);
  assert.equal(context.signals.length, analysis.signals.length, 'yhtään havaintoa ei lisätä eikä poisteta');
  assert.deepEqual(context.signals.map(s => s.kind), analysis.signals.map(s => s.kind));
  const overload = context.signals.find(s => s.kind === 'overload');
  assert.equal(overload.metrics.plannedMinutes, 15, 'minuutit tunneiksi');
  assert.deepEqual(context.rules, [...ASSISTANT_RULES]);
  assert.ok(ASSISTANT_RULES.some(rule => /Älä keksi tärkeyttä, kapasiteettia/.test(rule)));
});

test('aluenimet palautetaan paikallisesti kokonaisina sanoina', () => {
  const aliases = new Map([['A1', 'Perhe'], ['A10', 'Kymppi']]);
  assert.equal(restoreAreaNames('A1 sai vähän, A10 paljon. AA1 ei ole tunnus.', aliases),
    'Perhe sai vähän, Kymppi paljon. AA1 ei ole tunnus.');
  assert.equal(restoreAreaNames(null, aliases), '');
});

test('KRIITTINEN: kontekstimoduuli ei tee verkkokutsua eikä muuta havaintoja', () => {
  const source = readCode('src/ai/alignmentContext.js');
  for (const forbidden of ['fetch(', 'XMLHttpRequest', 'getClient', 'Repo.', 'commit(']) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
  const analysis = sensitiveAnalysis();
  const before = JSON.stringify(analysis);
  buildAlignmentAssistantContext(analysis);
  assert.equal(JSON.stringify(analysis), before, 'analyysi ei muutu');
});
