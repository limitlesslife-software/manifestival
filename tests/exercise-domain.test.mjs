// Liikunnan viikkokooste: suunniteltu vs toteutunut, oma arvio,
// palautumisvihjeet, tavoitteisiin liittäminen ja kaksoiskirjaukset.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as exerciseModule from '../src/domain/exercise.js';
import {
  weeklyExercise, exerciseForGoal, findDuplicateSessions, RECOVERY_HINT
} from '../src/domain/exercise.js';
import { EXERCISE_RULES } from '../src/domain/dailyLifeSignalsPolicy.js';

const MONDAY = '2026-06-08';

function session(id, date, overrides = {}) {
  return {
    id, date, kind: 'Juoksu', plannedMinutes: 30, actualMinutes: 30, intensity: 3,
    recoveryDemand: 2, goalId: null, note: null, ...overrides
  };
}

function shuffled(list, seed) {
  const copy = [...list];
  let s = seed;
  for (let i = copy.length - 1; i > 0; i -= 1) {
    s = (s * 1103515245 + 12345) % 2147483648;
    const j = s % (i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function sampleWeek() {
  return [
    session('s1', '2026-06-08', { plannedMinutes: 45, actualMinutes: 40, intensity: 4, goalId: 'g-kunto' }),
    session('s2', '2026-06-09', { kind: 'Sali', plannedMinutes: 60, actualMinutes: 60, intensity: 3, recoveryDemand: 4 }),
    session('s3', '2026-06-10', { kind: 'juoksu', plannedMinutes: 30, actualMinutes: null, intensity: null, goalId: 'g-kunto' }),
    session('s4', '2026-06-12', { kind: 'Uinti', plannedMinutes: null, actualMinutes: 25, intensity: 2, recoveryDemand: null }),
    session('s5', '2026-06-15', { kind: 'Juoksu' }), // seuraava viikko
    session('s6', '2026-06-07', { kind: 'Juoksu' }) // edellinen viikko
  ];
}

// ================================================================ SUMMAT

test('viikko: suunniteltu ja toteutunut vain tunnetuista arvoista', () => {
  const w = weeklyExercise({ sessions: sampleWeek(), weekStart: MONDAY });
  assert.equal(w.weekEnd, '2026-06-14');
  assert.equal(w.sessionCount, 4, 'vain viikon kirjaukset');
  assert.equal(w.plannedMinutes, 135);
  assert.equal(w.actualMinutes, 125);
  assert.equal(w.plannedKnownCount, 3);
  assert.equal(w.completedCount, 3);
  assert.equal(w.comparedSessions, 2, 'toteumaprosentti vain kun molemmat tiedetään');
  assert.equal(w.completionPercent, Math.round(100 / 105 * 100));
  assert.equal(w.intensityAverage, 3, '(4 + 3 + 2) / 3');
  assert.equal(w.recoveryDemandAverage, 2.7, '(2 + 4 + 2) / 3');
  assert.equal(w.activeDays, 4);
  assert.equal(w.completedDays, 3);
  assert.equal(w.text, 'Liikuntaa 2 h 5 min (suunniteltu 2 h 15 min).');
  assert.ok(Object.isFrozen(w) && Object.isFrozen(w.byDay) && Object.isFrozen(w.byKind) && Object.isFrozen(w.byGoal));
});

test('viikko: tuntematon ei ole nolla', () => {
  const noActual = weeklyExercise({ sessions: [session('a', MONDAY, { actualMinutes: null })], weekStart: MONDAY });
  assert.equal(noActual.actualMinutes, null);
  assert.equal(noActual.plannedMinutes, 30);
  assert.equal(noActual.completionPercent, null);
  assert.match(noActual.text, /toteumaa ei ole vielä kirjattu/);
  const noDurations = weeklyExercise({
    sessions: [session('a', MONDAY, { actualMinutes: null, plannedMinutes: null, intensity: null, recoveryDemand: null })],
    weekStart: MONDAY
  });
  assert.equal(noDurations.plannedMinutes, null);
  assert.equal(noDurations.intensityAverage, null);
  assert.equal(noDurations.recoveryDemandAverage, null);
  assert.equal(noDurations.text, 'Liikuntaa on kirjattu ilman kestoja.');
  const empty = weeklyExercise({ sessions: [], weekStart: MONDAY });
  assert.equal(empty.sessionCount, 0);
  assert.equal(empty.actualMinutes, null);
  assert.equal(empty.text, 'Tälle viikolle ei ole liikuntakirjauksia.');
  assert.equal(empty.byDay.length, 7);
  assert.ok(empty.byDay.every(day => day.plannedMinutes === null && day.actualMinutes === null));
});

test('viikko: päivät, lajit (kirjainkoosta riippumatta) ja tavoitteet', () => {
  const w = weeklyExercise({ sessions: sampleWeek(), weekStart: MONDAY });
  assert.deepEqual(w.byDay.map(d => d.sessionCount), [1, 1, 1, 0, 1, 0, 0]);
  assert.deepEqual(w.byDay.map(d => d.weekday), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(w.byKind.map(k => [k.kind, k.sessionCount, k.actualMinutes]),
    [['Sali', 1, 60], ['Juoksu', 2, 40], ['Uinti', 1, 25]]);
  assert.deepEqual(w.byGoal, [{ goalId: 'g-kunto', sessionCount: 2, plannedMinutes: 75, actualMinutes: 40 }]);
});

test('viikon rajat: kuun ja vuoden vaihde', () => {
  const sessions = [session('a', '2026-12-28'), session('b', '2027-01-03'), session('c', '2027-01-04')];
  const w = weeklyExercise({ sessions, weekStart: '2026-12-28' });
  assert.equal(w.weekEnd, '2027-01-03');
  assert.equal(w.sessionCount, 2);
  assert.equal(w.byDay[6].date, '2027-01-03');
  // Kesäaikaa ei ole päivämäärissä: vaihtoviikot ovat seitsemän päivää.
  assert.equal(weeklyExercise({ sessions: [], weekStart: '2026-03-23' }).weekEnd, '2026-03-29');
  assert.equal(weeklyExercise({ sessions: [], weekStart: '2026-10-19' }).weekEnd, '2026-10-25');
  assert.equal(weeklyExercise({ sessions, weekStart: '2026-13-01' }), null);
});

// ================================================================ PALAUTUMINEN

test('palautuminen: kolme raskasta päivää peräkkäin tuottaa vihjeen, kaksi ei', () => {
  const hard = { intensity: EXERCISE_RULES.HARD_MIN_LEVEL };
  const two = weeklyExercise({ sessions: [session('a', '2026-06-08', hard), session('b', '2026-06-09', hard)], weekStart: MONDAY });
  assert.deepEqual(two.recoveryHints, []);
  const three = weeklyExercise({
    sessions: [session('a', '2026-06-08', hard), session('b', '2026-06-09', { recoveryDemand: 5 }),
      session('c', '2026-06-10', hard), session('d', '2026-06-12', hard)],
    weekStart: MONDAY
  });
  assert.equal(three.recoveryHints.length, 1);
  assert.equal(three.recoveryHints[0].kind, RECOVERY_HINT.CONSECUTIVE_HARD_DAYS);
  assert.deepEqual(three.recoveryHints[0].dates, ['2026-06-08', '2026-06-09', '2026-06-10']);
  assert.match(three.recoveryHints[0].text, /peräkkäin 3 \(ma, ti, ke\)/);
  const belowLevel = weeklyExercise({
    sessions: ['2026-06-08', '2026-06-09', '2026-06-10'].map((d, i) => session(`x${i}`, d, { intensity: 3, recoveryDemand: 3 })),
    weekStart: MONDAY
  });
  assert.deepEqual(belowLevel.recoveryHints, []);
});

test('palautuminen: liikuntaa joka päivä -> lepopäivävihje; kuusi päivää ei', () => {
  const days = Array.from({ length: 7 }, (_, i) => `2026-06-${String(8 + i).padStart(2, '0')}`);
  const all = weeklyExercise({ sessions: days.map((d, i) => session(`d${i}`, d, { intensity: 2 })), weekStart: MONDAY });
  assert.deepEqual(all.recoveryHints.map(h => h.kind), [RECOVERY_HINT.NO_REST_DAY]);
  const six = weeklyExercise({ sessions: days.slice(0, 6).map((d, i) => session(`d${i}`, d, { intensity: 2 })), weekStart: MONDAY });
  assert.deepEqual(six.recoveryHints, []);
});

// ================================================================ TAVOITTEET JA KAKSOISKIRJAUKSET

test('tavoitteeseen liitetty liikunta aikaväliltä', () => {
  const sessions = sampleWeek().map(s => ({ ...s, goalId: s.goalId ?? (s.id === 's5' ? 'g-kunto' : null) }));
  const all = exerciseForGoal({ sessions, goalId: 'g-kunto' });
  assert.equal(all.sessionCount, 3);
  assert.equal(all.actualMinutes, 70);
  assert.equal(all.lastDate, '2026-06-15');
  const ranged = exerciseForGoal({ sessions, goalId: 'g-kunto', fromIso: '2026-06-09', toIso: '2026-06-14' });
  assert.equal(ranged.sessionCount, 1);
  assert.equal(ranged.actualMinutes, null, 'kirjaus ilman toteumaa ei ole nolla minuuttia');
  assert.equal(exerciseForGoal({ sessions, goalId: '' }), null);
  assert.equal(exerciseForGoal({ sessions, goalId: 'ei-ole' }).sessionCount, 0);
});

test('kaksoiskirjaukset: sama laji samana päivänä (kirjainkoosta riippumatta)', () => {
  const dupes = findDuplicateSessions([
    session('a', MONDAY, { kind: 'Juoksu' }),
    session('b', MONDAY, { kind: ' juoksu ' }),
    session('c', MONDAY, { kind: 'Sali' }),
    session('a', MONDAY, { kind: 'Juoksu' }), // sama tunniste = sama kirjaus
    session('d', '2026-06-09', { kind: 'Juoksu' })
  ]);
  assert.equal(dupes.length, 1);
  assert.equal(dupes[0].date, MONDAY);
  assert.deepEqual(dupes[0].ids, ['a', 'b']);
  assert.deepEqual(findDuplicateSessions('x'), []);
});

test('liikunta ei aikatauluta: moduuli ei tuota kalenterilohkoja eikä muistutuksia', () => {
  const exported = Object.keys(exerciseModule).sort();
  assert.deepEqual(exported, ['RECOVERY_HINT', 'exerciseForGoal', 'findDuplicateSessions', 'weeklyExercise']);
  const w = weeklyExercise({ sessions: sampleWeek(), weekStart: MONDAY });
  for (const key of Object.keys(w)) assert.doesNotMatch(key, /block|slot|schedule|reminder|time$/i, key);
});

// ================================================================ KESTÄVYYS

test('DETERMINISMI: sekoitettu syöte ja kaksoisrivit antavat saman tuloksen', () => {
  const sessions = [...sampleWeek(),
    { date: MONDAY, kind: 'juoksu', plannedMinutes: 10, actualMinutes: 10 },
    { date: MONDAY, kind: 'Juoksu', plannedMinutes: 20, actualMinutes: 20 }];
  const base = JSON.stringify(weeklyExercise({ sessions, weekStart: MONDAY }));
  const baseDupes = JSON.stringify(findDuplicateSessions(sessions));
  for (let seed = 1; seed <= 20; seed += 1) {
    const mixed = shuffled([...sessions, sessions[0]], seed);
    assert.equal(JSON.stringify(weeklyExercise({ sessions: mixed, weekStart: MONDAY })), base);
    assert.equal(JSON.stringify(findDuplicateSessions(mixed)), baseDupes);
  }
});

test('ROSKA: ei kaadu, ei muuta syötettä, rajojen ulkopuolinen arvo on tuntematon', () => {
  const garbage = [undefined, null, 'x', 5, {}, [null, 1, 'x', [], { date: 'eilen' }],
    [{ date: MONDAY, kind: {}, plannedMinutes: 'x', actualMinutes: -5, intensity: 9, recoveryDemand: 0, goalId: {} }],
    [{ date: MONDAY, actualMinutes: 1e9, intensity: '4' }]];
  for (const sessions of garbage) {
    assert.doesNotThrow(() => weeklyExercise({ sessions, weekStart: MONDAY }));
    assert.doesNotThrow(() => exerciseForGoal({ sessions, goalId: 'g' }));
    assert.doesNotThrow(() => findDuplicateSessions(sessions));
  }
  const odd = weeklyExercise({ sessions: garbage[6], weekStart: MONDAY });
  assert.equal(odd.actualMinutes, null);
  assert.equal(odd.intensityAverage, null);
  assert.equal(odd.byKind[0].kind, 'Liikunta');
  assert.equal(weeklyExercise({ sessions: garbage[7], weekStart: MONDAY }).intensityAverage, 4);
  const frozen = Object.freeze(sampleWeek().map(s => Object.freeze(s)));
  const before = JSON.stringify(frozen);
  weeklyExercise({ sessions: frozen, weekStart: MONDAY });
  findDuplicateSessions(frozen);
  assert.equal(JSON.stringify(frozen), before);
  assert.doesNotThrow(() => { weeklyExercise(); exerciseForGoal(); findDuplicateSessions(); });
  for (const bad of [null, 5, 'x', true]) {
    assert.equal(weeklyExercise(bad), null);
    assert.equal(exerciseForGoal(bad), null);
    assert.deepEqual(findDuplicateSessions(bad), []);
  }
});

test('SUORITUSKYKY: 50 000 kirjausta', () => {
  const sessions = Array.from({ length: 50000 }, (_, i) => session(`p${i}`, `2026-06-${String(8 + (i % 7)).padStart(2, '0')}`,
    { kind: `Laji ${i % 13}`, intensity: (i % 5) + 1 }));
  const t0 = performance.now();
  const w = weeklyExercise({ sessions, weekStart: MONDAY });
  const elapsed = performance.now() - t0;
  assert.equal(w.sessionCount, 50000);
  assert.ok(elapsed < 3000, `kesti ${Math.round(elapsed)} ms`);
});

test('SÄVY: vihjeet ja tekstit eivät syyllistä eivätkä anna hoito-ohjeita', () => {
  const days = Array.from({ length: 7 }, (_, i) => `2026-06-${String(8 + i).padStart(2, '0')}`);
  const w = weeklyExercise({ sessions: days.map((d, i) => session(`d${i}`, d, { intensity: 5 })), weekStart: MONDAY });
  for (const text of [w.text, ...w.recoveryHints.map(h => h.text)]) {
    assert.doesNotMatch(text, /epäonnist|huono|laiska|häpe|pitäisi|vamma|sairau|lääkäri|diagno/i, text);
  }
});
