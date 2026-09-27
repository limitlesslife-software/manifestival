// Terveysmittausten laajennuskohta: lajit, mitattu vs mahdollisuus,
// lähteet (ei toteutettu), käsin syötetyn mittauksen normalisointi.
//
// PERIAATE: ei tulkintaa, ei keksittyä mittausta, ei toteutusta.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  HEALTH_METRIC_KIND, HEALTH_METRIC_KINDS, HEALTH_DATA_BASIS, HEALTH_SOURCE, HEALTH_PROVIDERS, PROVIDER_STATUS,
  HEALTH_PROVIDER_CONTRACT, hasHealthProvider, healthProviderStatus, normalizeHealthMeasurement,
  validateHealthMeasurement, sleepBasisOf, healthBasisLabel, healthMetricLabel
} from '../src/domain/healthData.js';
import { SLEEP_KIND } from '../src/domain/dailyLife.js';
import { readCode, importsOf } from './helpers/sources.mjs';

test('mittauslajit kattavat sovitut laajennuskohdat', () => {
  assert.deepEqual([...HEALTH_METRIC_KINDS].sort(), [
    'activity', 'blood_pressure', 'body_composition', 'fitness_test', 'lab_result', 'measured_sleep',
    'resting_heart_rate', 'weight'
  ]);
  for (const kind of HEALTH_METRIC_KINDS) assert.notEqual(healthMetricLabel(kind), 'Mittaus', kind);
  assert.equal(healthMetricLabel('x'), 'Mittaus');
  assert.ok(Object.isFrozen(HEALTH_METRIC_KIND));
});

test('MITATTU vs MAHDOLLISUUS: sama käsite kuin unen lajissa', () => {
  assert.equal(HEALTH_DATA_BASIS.MEASURED, SLEEP_KIND.MEASURED);
  assert.equal(HEALTH_DATA_BASIS.OPPORTUNITY, SLEEP_KIND.OPPORTUNITY);
  assert.equal(sleepBasisOf({ kind: 'measured' }), 'measured');
  assert.equal(sleepBasisOf({ kind: 'opportunity' }), 'opportunity');
  assert.equal(sleepBasisOf({}), 'opportunity', 'tuntematon laji ei ole mittaus');
  assert.equal(sleepBasisOf(null), 'opportunity');
  assert.match(healthBasisLabel('opportunity'), /ei mittaus/);
  assert.equal(healthBasisLabel('measured'), 'Mitattu');
});

test('KRIITTINEN: yhtäkään terveyslähdettä ei ole toteutettu eikä teeskennellä', () => {
  assert.equal(hasHealthProvider(), false);
  assert.deepEqual(Object.keys(HEALTH_PROVIDERS).sort(), ['apple_health', 'health_connect', 'wearable']);
  for (const [source, provider] of Object.entries(HEALTH_PROVIDERS)) {
    assert.equal(provider.status, PROVIDER_STATUS.NOT_IMPLEMENTED, source);
    const status = healthProviderStatus(source);
    assert.equal(status.available, false);
    assert.match(status.text, /ei vielä käytössä/);
  }
  assert.equal(healthProviderStatus('manual'), null);
  assert.equal(healthProviderStatus('x'), null);
  assert.ok(HEALTH_PROVIDER_CONTRACT.methods.some(m => m.startsWith('readMeasurements')));
  assert.ok(HEALTH_PROVIDER_CONTRACT.rules.some(r => /taustasynkronointia/.test(r)));
  assert.ok(HEALTH_PROVIDER_CONTRACT.rules.some(r => /tekoälyn/.test(r)));
});

test('normalisointi: käsin syötetty paino on mitattu lukema, pilkku kelpaa', () => {
  const m = normalizeHealthMeasurement({ id: 'm1', kind: 'weight', date: '2026-09-26', time: '07:15', values: { weightKg: '82,46' } });
  assert.equal(m.kind, HEALTH_METRIC_KIND.WEIGHT);
  assert.equal(m.values.weightKg, 82.5);
  assert.equal(m.source, HEALTH_SOURCE.MANUAL);
  assert.equal(m.basis, HEALTH_DATA_BASIS.MEASURED);
  assert.equal(m.time, '07:15');
  assert.ok(Object.isFrozen(m) && Object.isFrozen(m.values));
  assert.equal(validateHealthMeasurement(m).valid, true);
});

test('normalisointi: mahdoton arvo on tuntematon, ei rajalle kiristetty', () => {
  const m = normalizeHealthMeasurement({ kind: 'weight', date: '2026-09-26', values: { weightKg: 800 } });
  assert.equal(m.values.weightKg, null, '800 kg on kirjoitusvirhe, ei 400 kg');
  const v = validateHealthMeasurement(m);
  assert.equal(v.valid, false);
  assert.match(v.errors['values.weightKg'], /mahdoton/);
  assert.equal(normalizeHealthMeasurement({ kind: 'resting_heart_rate', values: { bpm: '' } }).values.bpm, null, 'tyhjä ei ole nolla');
  assert.equal(normalizeHealthMeasurement({ kind: 'activity', values: { steps: 0 } }).values.steps, 0, 'nolla askelta on tieto');
});

test('rajat: syöttövirheen vartijat reunoilla', () => {
  const bpm = value => normalizeHealthMeasurement({ kind: 'resting_heart_rate', values: { bpm: value } }).values.bpm;
  assert.equal(bpm(20), 20);
  assert.equal(bpm(19), null);
  assert.equal(bpm(250), 250);
  assert.equal(bpm(251), null);
  assert.equal(bpm(60.4), 60);
  const sleep = value => normalizeHealthMeasurement({ kind: 'measured_sleep', values: { minutes: value } }).values.minutes;
  assert.equal(sleep(1440), 1440);
  assert.equal(sleep(1441), null);
  assert.equal(sleep(0), null);
});

test('verenpaine: yläpaine yli alapaineen, molemmat pakollisia', () => {
  const ok = validateHealthMeasurement({ kind: 'blood_pressure', date: '2026-09-26', values: { systolic: 128, diastolic: 82 } });
  assert.equal(ok.valid, true);
  const swapped = validateHealthMeasurement({ kind: 'blood_pressure', date: '2026-09-26', values: { systolic: 80, diastolic: 120 } });
  assert.match(swapped.errors['values.diastolic'], /järjestys/);
  const missing = validateHealthMeasurement({ kind: 'blood_pressure', date: '2026-09-26', values: { systolic: 120 } });
  assert.ok(missing.errors['values.diastolic']);
});

test('kehonkoostumus ja aktiivisuus: vähintään yksi arvo; laboratorio ja kuntotesti vaativat nimen', () => {
  assert.equal(validateHealthMeasurement({ kind: 'body_composition', date: '2026-09-26', values: { waterPercent: 55 } }).valid, true);
  assert.match(validateHealthMeasurement({ kind: 'activity', date: '2026-09-26', values: {} }).errors.values, /vähintään yksi/);
  const lab = normalizeHealthMeasurement({ kind: 'lab_result', date: '2026-09-26', values: { name: '  B-Hb ', value: '141', unit: 'g/l' } });
  assert.equal(lab.values.name, 'B-Hb');
  assert.equal(lab.values.value, 141);
  assert.equal(validateHealthMeasurement(lab).valid, true);
  assert.ok(validateHealthMeasurement({ kind: 'fitness_test', date: '2026-09-26', values: { value: 12 } }).errors['values.name']);
});

test('validointi: laji, päivä ja aika', () => {
  const v = validateHealthMeasurement({ kind: 'x', date: '2026-02-30', time: '25:00' });
  assert.match(v.errors.kind, /Valitse/);
  assert.match(v.errors.date, /päivämäärä/);
  assert.match(v.errors.time, /HH:MM/);
  assert.ok(Object.isFrozen(v));
});

test('ROSKA: normalisointi ja validointi eivät koskaan heitä eivätkä muuta syötettä', () => {
  for (const bad of [undefined, null, 5, 'x', [], {}, { kind: 'weight', values: 'x' }, { kind: 'lab_result', values: { name: {}, value: [] } },
    { kind: 'activity', values: { steps: Infinity, distanceKm: true } }, { id: {}, time: 5, note: 42 }]) {
    assert.doesNotThrow(() => normalizeHealthMeasurement(bad));
    assert.doesNotThrow(() => validateHealthMeasurement(bad));
  }
  const input = Object.freeze({ kind: 'weight', date: '2026-09-26', values: Object.freeze({ weightKg: 80 }) });
  normalizeHealthMeasurement(input);
  assert.deepEqual(input, { kind: 'weight', date: '2026-09-26', values: { weightKg: 80 } });
});

test('EI TULKINTAA: moduuli ei luokittele arvoja eikä neuvo, eikä tuo alustaa', () => {
  const code = readCode('src/domain/healthData.js');
  const strings = [...code.matchAll(/'([^'\n]*)'|`([^`]*)`/g)].map(m => m[1] ?? m[2]).join('\n');
  assert.doesNotMatch(strings, /normaali|korkea|matala|ylipaino|alipaino|riski|diagno|hoito|lääk|suosit|pitäisi|terve\b/i);
  for (const forbidden of ['fetch(', 'Capacitor', 'window.', 'document.', 'localStorage', 'Date.now(', 'console.']) {
    assert.equal(code.includes(forbidden), false, forbidden);
  }
  assert.ok(importsOf('src/domain/healthData.js').every(path => path.startsWith('src/domain/')));
});
