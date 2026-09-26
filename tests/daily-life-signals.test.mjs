// Arjen havainnot (unirytmi, aika unelle, hyvinvoinnin kuormitus,
// harkinnanvarainen raha) sekä uusien arkimoduulien puhtaus ja
// aikavyöhykeapuri.
//
// PERIAATE: tuntematon ei ole "ei havaintoa". Jokainen tarkistus kertoo,
// syntyikö havainto, oliko kaikki selvää, puuttuiko tietoa vai puuttuiko
// käyttäjän oma vertailuluku.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  dailyLifeSignals, sleepRhythmDrift, sleepOpportunityLow, wellbeingStrain, moneyOverload,
  DAILY_LIFE_SIGNAL, DAILY_LIFE_SIGNALS, DAILY_LIFE_SEVERITY, EVALUATION_STATUS, DAILY_LIFE_RULE
} from '../src/domain/dailyLifeSignals.js';
import { SLEEP_SIGNAL_RULES, WELLBEING_SIGNAL_RULES, MONEY_RULES, DAILY_LIFE_POLICY } from '../src/domain/dailyLifeSignalsPolicy.js';
import { SEVERITY, SIGNAL } from '../src/domain/alignment.js';
import { summarizeMonth } from '../src/domain/budget.js';
import { isIsoDate } from '../src/domain/task.js';
import {
  isCalendarDate, zonedEpochMs, zonedParts, elapsedMinutesBetween, parseTimestampMs, resolveTimeZone,
  offsetMinutesAt, formatClockFi, clockMinutes, DEFAULT_TIME_ZONE
} from '../src/domain/zonedClock.js';
import { readCode, importsOf, read } from './helpers/sources.mjs';

const WEEK = '2026-06-08'; // maanantai
const SUNDAY = '2026-06-14';
const days = (start, n) => Array.from({ length: n }, (_, i) => {
  const d = new Date(Date.parse(`${start}T12:00:00Z`) + i * 86400000);
  return d.toISOString().slice(0, 10);
});

function night(wakeDate, actualBedtime, actualWake, extra = {}) {
  return { id: `s-${wakeDate}`, wakeDate, plannedBedtime: null, actualBedtime, plannedWake: null, actualWake,
    source: 'user', kind: 'opportunity', note: 'yksityinen', ...extra };
}

const DECLARED = Object.freeze({ targetHours: 8, bedtimeTarget: '23:00', wakeTime: '07:00' });

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

const TONE = /epäonnist|retkah|huono|laiska|häpe|pitäisi|diagno|masenn|uupum|sairau|tuhla|liikaa/i;

// ================================================================ AIKA UNELLE

test('aika unelle: lyhyet yöt suhteessa omaan tavoitteeseen -> havainto', () => {
  const logs = days(WEEK, 7).map((d, i) => night(d, i < 4 ? '00:30' : '23:00', '07:00'));
  const e = sleepOpportunityLow({ weekStart: WEEK, todayIso: SUNDAY, sleepLogs: logs, sleepDeclared: DECLARED });
  assert.equal(e.status, EVALUATION_STATUS.SIGNAL);
  assert.equal(e.signal.kind, DAILY_LIFE_SIGNAL.SLEEP_OPPORTUNITY_LOW);
  assert.equal(e.signal.rule, DAILY_LIFE_RULE.SLEEP_SHORT);
  assert.equal(e.signal.basis, 'reported');
  assert.equal(e.signal.areaId, null);
  assert.equal(e.metrics.shortNights, 4);
  assert.equal(e.metrics.reportedNights, 7);
  assert.equal(e.metrics.targetMinutes, 480);
  assert.equal(e.metrics.meanMinutes, Math.round((4 * 390 + 3 * 480) / 7));
  assert.equal(e.signal.severity, DAILY_LIFE_SEVERITY.INFO, 'keskimääräinen vaje alle tunnin');
  assert.match(e.signal.explanation, /^Aikaa unelle oli keskimäärin 7 h 9 min, kun oma tavoitteesi on 8 h\./);
  assert.ok(Object.isFrozen(e) && Object.isFrozen(e.signal) && Object.isFrozen(e.signal.metrics));
});

test('aika unelle: raja — tasan 30 min vajetta on lyhyt yö, 29 min ei', () => {
  const at = days(WEEK, 7).map(d => night(d, '23:30', '07:00'));
  assert.equal(sleepOpportunityLow({ weekStart: WEEK, todayIso: SUNDAY, sleepLogs: at, sleepDeclared: DECLARED }).metrics.shortNights, 7);
  const under = days(WEEK, 7).map(d => night(d, '23:29', '07:00'));
  const e = sleepOpportunityLow({ weekStart: WEEK, todayIso: SUNDAY, sleepLogs: under, sleepDeclared: DECLARED });
  assert.equal(e.metrics.shortNights, 0);
  assert.equal(e.status, EVALUATION_STATUS.CLEAR);
});

test('aika unelle: huomio vaatii 4 lyhyttä yötä, tunnin keskivajeen ja 5 kirjattua yötä', () => {
  const logs = days(WEEK, 5).map(d => night(d, '00:30', '07:00'));
  const e = sleepOpportunityLow({ weekStart: WEEK, todayIso: SUNDAY, sleepLogs: logs, sleepDeclared: DECLARED });
  assert.equal(e.signal.severity, DAILY_LIFE_SEVERITY.ATTENTION);
  const four = sleepOpportunityLow({ weekStart: WEEK, todayIso: '2026-06-11', sleepLogs: logs, sleepDeclared: DECLARED });
  assert.equal(four.metrics.reportedNights, 4);
  assert.equal(four.signal.severity, DAILY_LIFE_SEVERITY.INFO, 'neljä kirjattua yötä ei riitä huomioon');
});

test('aika unelle: ei omaa tavoitetta -> no_reference; harva aineisto -> insufficient_data', () => {
  const logs = days(WEEK, 7).map(d => night(d, '01:00', '06:00'));
  const none = sleepOpportunityLow({ weekStart: WEEK, todayIso: SUNDAY, sleepLogs: logs, sleepDeclared: { targetHours: null } });
  assert.equal(none.status, EVALUATION_STATUS.NO_REFERENCE);
  assert.equal(none.signal, null);
  const sparse = sleepOpportunityLow({ weekStart: WEEK, todayIso: SUNDAY, sleepLogs: logs.slice(0, 3), sleepDeclared: DECLARED });
  assert.equal(sparse.status, EVALUATION_STATUS.INSUFFICIENT_DATA, '3/7 alittaa kattavuuden');
  const early = sleepOpportunityLow({ weekStart: WEEK, todayIso: '2026-06-10', sleepLogs: logs.slice(0, 3), sleepDeclared: DECLARED });
  assert.equal(early.status, EVALUATION_STATUS.SIGNAL, 'viikon alussa 3/3 riittää');
  const twoNights = sleepOpportunityLow({ weekStart: WEEK, todayIso: '2026-06-09', sleepLogs: logs, sleepDeclared: DECLARED });
  assert.equal(twoNights.status, EVALUATION_STATUS.INSUFFICIENT_DATA, 'alle vähimmäismäärän');
  const halfLogged = sleepOpportunityLow({ weekStart: WEEK, todayIso: SUNDAY,
    sleepLogs: days(WEEK, 7).map(d => night(d, '01:00', null)), sleepDeclared: DECLARED });
  assert.equal(halfLogged.metrics.reportedNights, 0, 'pelkkä nukkumaanmeno ei ole yön kesto');
});

test('KESÄAIKA: kevään vaihtoyö 23.00–07.00 on 7 h, syksyn 9 h', () => {
  const spring = ['2026-03-26', '2026-03-27', '2026-03-28', '2026-03-29'].map(d => night(d, '23:00', '07:00'));
  const s = sleepOpportunityLow({ weekStart: '2026-03-23', todayIso: '2026-03-29', sleepLogs: spring, sleepDeclared: { targetHours: 7.5 } });
  assert.equal(s.metrics.shortNights, 1, 'vain vaihtoyö jää 30 min tavoitteesta');
  assert.equal(s.metrics.meanMinutes, Math.round((3 * 480 + 420) / 4));
  assert.equal(elapsedMinutesBetween('2026-03-28', '23:00', '2026-03-29', '07:00'), 420);
  const autumn = ['2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25'].map(d => night(d, '23:30', '07:00'));
  const a = sleepOpportunityLow({ weekStart: '2026-10-19', todayIso: '2026-10-25', sleepLogs: autumn, sleepDeclared: { targetHours: 8 } });
  assert.equal(a.metrics.shortNights, 3, 'vaihtoyö 8 h 30 min ei ole lyhyt');
  assert.equal(elapsedMinutesBetween('2026-10-24', '23:30', '2026-10-25', '07:00'), 510);
  // Toisessa vyöhykkeessä (ei vaihtoa samana yönä) sama yö on 8 h.
  assert.equal(elapsedMinutesBetween('2026-03-28', '23:00', '2026-03-29', '07:00', 'Asia/Tokyo'), 480);
});

test('aika unelle: keskiyön jälkeinen nukkumaanmeno, päiväuni ja mitattu uni', () => {
  const logs = [
    night('2026-06-08', '00:30', '07:00'),
    night('2026-06-09', '09:00', '15:00'), // yövuoro: saman päivän uni
    night('2026-06-10', '23:00', '07:00', { kind: 'measured' }),
    night('2026-06-11', '07:00', '07:00') // nollakesto ohitetaan
  ];
  const e = sleepOpportunityLow({ weekStart: WEEK, todayIso: '2026-06-11', sleepLogs: logs, sleepDeclared: DECLARED });
  assert.equal(e.metrics.reportedNights, 3);
  assert.equal(e.metrics.measuredNights, 1);
  assert.equal(e.metrics.meanMinutes, Math.round((390 + 360 + 480) / 3));
  assert.match(e.signal.explanation, /^Aikaa unelle tai mitattua unta/);
});

// ================================================================ UNIRYTMI

test('unirytmi: poikkeama omasta rytmistä vähintään tunnin, raja 59/60 min', () => {
  const drift = days(WEEK, 5).map((d, i) => night(d, i < 3 ? '00:00' : '23:10', '07:00'));
  const e = sleepRhythmDrift({ weekStart: WEEK, todayIso: '2026-06-12', sleepLogs: drift, sleepDeclared: DECLARED });
  assert.equal(e.status, EVALUATION_STATUS.SIGNAL);
  assert.equal(e.signal.rule, DAILY_LIFE_RULE.SLEEP_DRIFT);
  assert.equal(e.metrics.driftNights, 3);
  assert.equal(e.metrics.direction, 'later');
  assert.equal(e.signal.severity, DAILY_LIFE_SEVERITY.INFO);
  assert.match(e.signal.explanation, /vähintään 1 h 3 yönä 5 kirjatusta\. Poikkeamat olivat myöhempään\./);
  const almost = days(WEEK, 5).map(d => night(d, '23:59', '07:00'));
  assert.equal(sleepRhythmDrift({ weekStart: WEEK, todayIso: '2026-06-12', sleepLogs: almost, sleepDeclared: DECLARED }).status,
    EVALUATION_STATUS.CLEAR);
});

test('unirytmi: suunniteltu aika voittaa ilmoitetun, keskiyön yli lasketaan oikein, aikaisempaan suuntaan', () => {
  const logs = days(WEEK, 5).map(d => night(d, '22:45', '05:30', { plannedBedtime: '23:30', plannedWake: '06:40' }));
  const e = sleepRhythmDrift({ weekStart: WEEK, todayIso: '2026-06-12', sleepLogs: logs, sleepDeclared: DECLARED });
  assert.equal(e.metrics.driftNights, 5, 'herääminen 70 min suunniteltua aiemmin');
  assert.equal(e.metrics.direction, 'earlier');
  assert.equal(e.signal.severity, DAILY_LIFE_SEVERITY.ATTENTION);
  const overMidnight = days(WEEK, 3).map(d => night(d, '00:45', '07:00', { plannedBedtime: '23:30' }));
  const m = sleepRhythmDrift({ weekStart: WEEK, todayIso: '2026-06-10', sleepLogs: overMidnight, sleepDeclared: {} });
  assert.equal(m.metrics.meanAbsDeviationMinutes, 75, '23.30 -> 00.45 on +75 min, ei -1365');
});

test('unirytmi: viikonlopun sallittu siirtymä myöhempään', () => {
  // 13.6. la ja 14.6. su: herätys 08.00, sallittu siirtymä 60 min -> ei poikkeamaa.
  const logs = [...days(WEEK, 5).map(d => night(d, '23:00', '07:00')),
    night('2026-06-13', '23:30', '08:00'), night('2026-06-14', '23:30', '08:00')];
  const withShift = sleepRhythmDrift({ weekStart: WEEK, todayIso: SUNDAY, sleepLogs: logs,
    sleepDeclared: { ...DECLARED, weekendShiftMinutes: 60 } });
  assert.equal(withShift.metrics.driftNights, 0);
  const without = sleepRhythmDrift({ weekStart: WEEK, todayIso: SUNDAY, sleepLogs: logs, sleepDeclared: DECLARED });
  assert.equal(without.metrics.driftNights, 2);
  assert.equal(without.status, EVALUATION_STATUS.CLEAR, 'kaksi yötä ei riitä havaintoon');
});

test('unirytmi: ilman omaa rytmiä no_reference, ilman kirjauksia insufficient_data', () => {
  const logs = days(WEEK, 7).map(d => night(d, '02:00', '10:00'));
  assert.equal(sleepRhythmDrift({ weekStart: WEEK, todayIso: SUNDAY, sleepLogs: logs, sleepDeclared: {} }).status,
    EVALUATION_STATUS.NO_REFERENCE);
  assert.equal(sleepRhythmDrift({ weekStart: WEEK, todayIso: SUNDAY, sleepLogs: [], sleepDeclared: DECLARED }).status,
    EVALUATION_STATUS.INSUFFICIENT_DATA);
});

// ================================================================ HYVINVOINTI

const entry = (date, energy, stress) => ({ id: `w-${date}`, date, energy, mood: 3, stress, sleepHours: null, note: 'yksityinen' });

test('hyvinvoinnin kuormitus: kynnykset, kattavuus ja vakavuus', () => {
  const four = days(WEEK, 5).map((d, i) => entry(d, i < 4 ? 2 : 4, i < 4 ? 5 : 2));
  const e = wellbeingStrain({ weekStart: WEEK, todayIso: '2026-06-12', wellbeingEntries: four });
  assert.equal(e.status, EVALUATION_STATUS.SIGNAL);
  assert.equal(e.signal.severity, DAILY_LIFE_SEVERITY.ATTENTION);
  assert.equal(e.metrics.strainedDays, 4);
  assert.match(e.signal.explanation, /ei arvio voinnistasi/);
  const three = days(WEEK, 5).map((d, i) => entry(d, i < 3 ? 2 : 4, i < 3 ? 4 : 2));
  assert.equal(wellbeingStrain({ weekStart: WEEK, todayIso: '2026-06-12', wellbeingEntries: three }).signal.severity,
    DAILY_LIFE_SEVERITY.INFO);
  const two = days(WEEK, 5).map((d, i) => entry(d, i < 2 ? 1 : 4, i < 2 ? 5 : 2));
  assert.equal(wellbeingStrain({ weekStart: WEEK, todayIso: '2026-06-12', wellbeingEntries: two }).status, EVALUATION_STATUS.CLEAR);
  const sparse = wellbeingStrain({ weekStart: WEEK, todayIso: SUNDAY, wellbeingEntries: three.slice(0, 3) });
  assert.equal(sparse.status, EVALUATION_STATUS.INSUFFICIENT_DATA, '3/7 päivää ei ole kattava');
  assert.equal(WELLBEING_SIGNAL_RULES.STRAIN_MIN_DAYS, 3);
});

test('hyvinvoinnin kuormitus: hallinnan tunne tsekkauksista', () => {
  const entries = days(WEEK, 4).map(d => entry(d, null, 5));
  const checkins = days(WEEK, 4).map(d => ({ id: `c-${d}`, date: d, motivation: 3, control: 1 }));
  const e = wellbeingStrain({ weekStart: WEEK, todayIso: '2026-06-11', wellbeingEntries: entries, wellbeingCheckins: checkins });
  assert.equal(e.metrics.lowControlDays, 4);
  assert.equal(e.status, EVALUATION_STATUS.SIGNAL);
});

// ================================================================ RAHA

function month(n, categories = ['viihde']) {
  const transactions = Array.from({ length: n }, (_, i) => ({
    id: `t${i}`, kind: 'expense', category: categories[i % categories.length], amountMinor: 2000, currency: 'EUR', date: '2026-06-05'
  }));
  return summarizeMonth({ month: '2026-06', transactions });
}

test('raha: vain ilmoitetulla rajalla; yli -> huomio, lähellä -> tiedoksi, alle -> selvä', () => {
  const summary = month(5); // 100 € viihdettä
  assert.equal(moneyOverload({ monthSummary: summary, declaredCapacityMinor: null, currency: 'EUR' }).status,
    EVALUATION_STATUS.NO_REFERENCE);
  const over = moneyOverload({ monthSummary: summary, declaredCapacityMinor: 8000, currency: 'EUR' });
  assert.equal(over.signal.severity, DAILY_LIFE_SEVERITY.ATTENTION);
  assert.equal(over.signal.rule, DAILY_LIFE_RULE.MONEY_OVER);
  assert.equal(over.metrics.usedPercent, 125);
  const near = moneyOverload({ monthSummary: summary, declaredCapacityMinor: 11000, currency: 'EUR' });
  assert.equal(near.signal.severity, DAILY_LIFE_SEVERITY.INFO);
  assert.equal(near.signal.rule, DAILY_LIFE_RULE.MONEY_NEAR);
  assert.equal(moneyOverload({ monthSummary: summary, declaredCapacityMinor: 50000, currency: 'EUR' }).status, EVALUATION_STATUS.CLEAR);
  const zero = moneyOverload({ monthSummary: summary, declaredCapacityMinor: 0, currency: 'EUR' });
  assert.equal(zero.signal.severity, DAILY_LIFE_SEVERITY.ATTENTION);
  assert.equal(zero.metrics.usedPercent, null);
});

test('raha: harva kuukausi ja sekavaluutta -> insufficient_data; mittareissa ei summia', () => {
  assert.equal(moneyOverload({ monthSummary: month(MONEY_RULES.MIN_TRANSACTIONS - 1), declaredCapacityMinor: 100, currency: 'EUR' }).status,
    EVALUATION_STATUS.INSUFFICIENT_DATA);
  assert.equal(moneyOverload({ monthSummary: month(9), declaredCapacityMinor: 100, currency: 'EUR', mixedCurrencies: true }).status,
    EVALUATION_STATUS.INSUFFICIENT_DATA);
  const e = moneyOverload({ monthSummary: month(9), declaredCapacityMinor: 100, currency: 'EUR' });
  for (const key of Object.keys(e.signal.metrics)) assert.doesNotMatch(key, /minor|amount|cents/i, key);
  assert.doesNotMatch(e.signal.explanation, /€|\d+,\d\d/, 'selityksessä ei euromääriä');
});

// ================================================================ KOOSTE

function fullInput(overrides = {}) {
  return {
    weekStart: WEEK,
    todayIso: SUNDAY,
    timeZone: DEFAULT_TIME_ZONE,
    sleepLogs: days(WEEK, 7).map((d, i) => night(d, i < 5 ? '00:45' : '23:00', '07:00')),
    sleepDeclared: DECLARED,
    wellbeingEntries: days(WEEK, 6).map((d, i) => entry(d, i < 4 ? 2 : 4, i < 4 ? 5 : 2)),
    wellbeingCheckins: [],
    monthSummary: month(9),
    declaredCapacityMinor: 10000,
    currency: 'EUR',
    ...overrides
  };
}

test('kooste: neljä arviota aina, havainnot vakavuuden ja lajin mukaan', () => {
  const r = dailyLifeSignals(fullInput());
  assert.equal(r.weekEnd, SUNDAY);
  assert.equal(r.windowDays, 7);
  assert.deepEqual(r.evaluations.map(e => e.kind).sort(), [...DAILY_LIFE_SIGNALS].sort());
  assert.deepEqual(r.signals.map(s => `${s.severity}:${s.kind}`), [
    'attention:sleep_opportunity_low', 'attention:sleep_rhythm_drift', 'attention:wellbeing_strain', 'attention:money_overload'
  ]);
  for (const s of r.signals) {
    assert.deepEqual(Object.keys(s).sort(), ['areaId', 'basis', 'explanation', 'kind', 'metrics', 'rule', 'severity']);
    assert.ok(Object.values(SEVERITY).includes(s.severity));
  }
  assert.ok(Object.isFrozen(r) && Object.isFrozen(r.signals) && Object.isFrozen(r.evaluations));
});

test('kooste: TUNTEMATON EI OLE "EI HAVAINTOA"', () => {
  const r = dailyLifeSignals({ weekStart: WEEK, todayIso: SUNDAY });
  assert.deepEqual(r.signals, []);
  const statuses = Object.fromEntries(r.evaluations.map(e => [e.kind, e.status]));
  assert.deepEqual(statuses, {
    sleep_opportunity_low: 'no_reference',
    sleep_rhythm_drift: 'insufficient_data',
    wellbeing_strain: 'insufficient_data',
    money_overload: 'no_reference'
  });
  assert.equal(Object.values(statuses).includes(EVALUATION_STATUS.CLEAR), false);
});

test('kooste: viikko ennen alkua, kesken ja kuun/vuoden vaihteessa', () => {
  const before = dailyLifeSignals(fullInput({ todayIso: '2026-06-01' }));
  assert.equal(before.windowDays, 0);
  assert.deepEqual(before.signals.filter(s => s.kind !== 'money_overload'), []);
  const mid = dailyLifeSignals(fullInput({ todayIso: '2026-06-10' }));
  assert.equal(mid.windowEnd, '2026-06-10');
  assert.equal(mid.windowDays, 3);
  const noToday = dailyLifeSignals(fullInput({ todayIso: undefined }));
  assert.equal(noToday.windowEnd, SUNDAY, 'ilman tätä päivää viikko on päättynyt');
  const yearEnd = dailyLifeSignals({ weekStart: '2026-12-28', todayIso: '2027-01-02',
    sleepLogs: days('2026-12-28', 6).map(d => night(d, '01:00', '07:00')), sleepDeclared: DECLARED });
  assert.equal(yearEnd.weekEnd, '2027-01-03');
  assert.equal(yearEnd.windowDays, 6);
  assert.equal(yearEnd.evaluations.find(e => e.kind === 'sleep_opportunity_low').metrics.shortNights, 6);
  assert.equal(dailyLifeSignals({ weekStart: '2026-13-01' }), null);
});

test('DETERMINISMI: sekoitettu syöte ja kaksoiskirjaukset antavat saman tuloksen', () => {
  const input = fullInput();
  const base = JSON.stringify(dailyLifeSignals(input));
  for (let seed = 1; seed <= 20; seed += 1) {
    const mixed = {
      ...input,
      sleepLogs: shuffled([...input.sleepLogs, input.sleepLogs[2]], seed),
      wellbeingEntries: shuffled([...input.wellbeingEntries, input.wellbeingEntries[0]], seed)
    };
    assert.equal(JSON.stringify(dailyLifeSignals(mixed)), base);
  }
  const twice = [night('2026-06-08', '23:00', '07:00', { id: 'a', updatedAt: '2026-06-08T08:00:00Z' }),
    night('2026-06-08', '02:00', '07:00', { id: 'b', updatedAt: '2026-06-08T09:00:00Z' })];
  const one = sleepOpportunityLow({ weekStart: WEEK, todayIso: '2026-06-08', sleepLogs: twice, sleepDeclared: DECLARED });
  assert.equal(one.metrics.meanMinutes, 300, 'myöhemmin päivitetty kirjaus voittaa');
});

test('syötettä ei muuteta ja roska ei kaada', () => {
  const input = fullInput();
  const frozen = JSON.parse(JSON.stringify(input));
  const deepFreeze = v => { if (v && typeof v === 'object') { Object.values(v).forEach(deepFreeze); Object.freeze(v); } return v; };
  deepFreeze(frozen);
  const before = JSON.stringify(frozen);
  dailyLifeSignals(frozen);
  assert.equal(JSON.stringify(frozen), before);
  const garbage = [undefined, null, 5, 'x', [], { weekStart: WEEK, sleepLogs: 'x', sleepDeclared: 5, wellbeingEntries: {}, monthSummary: [] },
    { weekStart: WEEK, sleepLogs: [null, 1, { wakeDate: WEEK, actualBedtime: 5, actualWake: {} }], sleepDeclared: { targetHours: '8' } },
    { weekStart: WEEK, todayIso: {}, timeZone: 'Mars/Base', declaredCapacityMinor: 'x', monthSummary: { transactionCount: 1e9 } }];
  for (const value of garbage) {
    assert.doesNotThrow(() => dailyLifeSignals(value));
    assert.doesNotThrow(() => { sleepRhythmDrift(value); sleepOpportunityLow(value); wellbeingStrain(value); moneyOverload(value); });
  }
});

test('SÄVY: selitykset ovat neutraaleja eivätkä diagnosoi', () => {
  const texts = [];
  for (const variant of [{}, { todayIso: '2026-06-11' }, { declaredCapacityMinor: 0 }, { declaredCapacityMinor: 10500 }]) {
    for (const s of dailyLifeSignals(fullInput(variant)).signals) texts.push(s.explanation);
  }
  assert.ok(texts.length >= 8);
  for (const text of texts) assert.doesNotMatch(text, TONE, text);
});

test('EI KYTKETTY SUUNTAAN: analyzeWeek ei tunne arjen havaintoja', () => {
  for (const kind of DAILY_LIFE_SIGNALS) assert.equal(Object.values(SIGNAL).includes(kind), false, kind);
  for (const file of ['src/domain/alignment.js', 'src/ai/alignmentContext.js', 'src/domain/alignmentReview.js']) {
    const code = read(file);
    assert.equal(code.includes('dailyLifeSignals'), false, file);
    for (const kind of DAILY_LIFE_SIGNALS) assert.equal(code.includes(kind), false, `${file}: ${kind}`);
  }
  assert.deepEqual({ ...DAILY_LIFE_SEVERITY }, { INFO: SEVERITY.INFO, ATTENTION: SEVERITY.ATTENTION });
});

// ================================================================ AIKAVYÖHYKEAPURI

test('vyöhykeapuri: Helsingin kesäajan aukko ja päällekkäinen tunti', () => {
  assert.equal(zonedEpochMs('2026-03-29', '02:59'), Date.parse('2026-03-29T00:59:00Z'));
  assert.equal(zonedEpochMs('2026-03-29', '03:30'), Date.parse('2026-03-29T01:30:00Z'), 'olematon 03.30 -> 04.30');
  assert.equal(zonedEpochMs('2026-03-29', '04:00'), Date.parse('2026-03-29T01:00:00Z'));
  assert.equal(zonedEpochMs('2026-10-25', '03:30'), Date.parse('2026-10-25T00:30:00Z'), 'kahdesta 03.30:sta ensimmäinen');
  assert.equal(zonedEpochMs('2026-10-25', '04:00'), Date.parse('2026-10-25T02:00:00Z'));
  assert.equal(offsetMinutesAt(Date.parse('2026-07-01T12:00:00Z')), 180);
  assert.equal(offsetMinutesAt(Date.parse('2026-01-01T12:00:00Z')), 120);
  assert.deepEqual({ ...zonedParts(Date.parse('2026-12-31T22:30:00Z')) },
    { date: '2027-01-01', time: '00:30', minutes: 30, weekday: 5, offsetMinutes: 120 });
  assert.equal(formatClockFi(Date.parse('2026-06-01T11:20:00Z')), '14.20');
  assert.equal(resolveTimeZone('Mars/Base'), DEFAULT_TIME_ZONE);
  assert.equal(resolveTimeZone(' America/New_York '), 'America/New_York');
  assert.equal(clockMinutes('24:00'), null);
  assert.equal(clockMinutes(1439), 1439);
  assert.equal(zonedParts(Number.NaN), null);
  assert.equal(zonedEpochMs('2026-02-30', '10:00'), null);
});

test('vyöhykeapuri: aikaleimat tulkitaan ilman koneen vyöhykettä', () => {
  const expected = Date.parse('2026-03-29T01:30:00Z');
  assert.equal(parseTimestampMs('2026-03-29T01:30:00Z'), expected);
  assert.equal(parseTimestampMs('2026-03-29T04:30:00+03:00'), expected);
  assert.equal(parseTimestampMs('2026-03-29 04:30:00+0300'), expected);
  assert.equal(parseTimestampMs('2026-03-29T04:30:00'), expected, 'vyöhykkeetön = Helsingin seinäkello');
  assert.equal(parseTimestampMs('2026-03-29T01:30:00.250Z'), expected + 250);
  assert.equal(parseTimestampMs(expected), expected);
  for (const bad of ['2026-02-30T10:00Z', '2026-03-29T24:00Z', '2026-03-29T10:00+19:00', 'eilen', '', null, {}, 1e20, NaN]) {
    assert.equal(parseTimestampMs(bad), null, String(bad));
  }
});

test('isCalendarDate vastaa task.isIsoDate-tarkistusta', () => {
  const samples = ['2026-02-28', '2026-02-29', '2028-02-29', '2100-02-29', '2000-02-29', '0000-01-01', '9999-12-31',
    '2026-13-01', '2026-00-10', '2026-04-31', '2026-04-30', '2026-1-01', '26-01-01', ' 2026-01-01', '2026-01-01T00:00', '', null, 5];
  for (let y = 1999; y <= 2030; y += 1) for (let m = 1; m <= 12; m += 1) for (const d of [28, 29, 30, 31]) {
    samples.push(`${y}-${String(m).padStart(2, '0')}-${d}`);
  }
  for (const value of samples) assert.equal(isCalendarDate(value), isIsoDate(value), String(value));
});

// ================================================================ PUHTAUS

const MY_MODULES = [
  'src/domain/zonedClock.js', 'src/domain/dailyLifeSignalsPolicy.js', 'src/domain/habitEngine.js',
  'src/domain/mealRhythm.js', 'src/domain/exercise.js', 'src/domain/wellbeingInsights.js',
  'src/domain/moneyAlignment.js', 'src/domain/marketData.js', 'src/domain/healthData.js',
  'src/domain/dailyLifeSignals.js', 'src/domain/investments.js', 'src/domain/money.js'
];

test('PUHTAUS: arjen moduulit eivät lue kelloa, arvo, koske DOM:iin, verkkoon eikä lokiin', () => {
  const forbidden = ['Date.now(', 'Math.random', 'crypto.randomUUID', 'performance.now', 'document.', 'window.',
    'localStorage', 'sessionStorage', 'fetch(', 'console.', 'logEvent', 'setTimeout', 'setInterval'];
  for (const file of MY_MODULES) {
    const code = readCode(file);
    for (const pattern of forbidden) assert.equal(code.includes(pattern), false, `${file}: ${pattern}`);
    assert.equal(/new Date\(\s*\)/.test(code), false, `${file}: new Date()`);
    for (const dependency of importsOf(file)) {
      assert.ok(dependency.startsWith('src/domain/') || dependency.startsWith('src/lib/format.js'),
        `${file} tuo ${dependency}`);
    }
  }
});

test('PUHTAUS: kynnysarvot ovat säännöissä, eivät laskentamoduuleissa', () => {
  for (const file of ['src/domain/habitEngine.js', 'src/domain/mealRhythm.js', 'src/domain/exercise.js',
    'src/domain/wellbeingInsights.js', 'src/domain/moneyAlignment.js', 'src/domain/dailyLifeSignals.js']) {
    const code = readCode(file).replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const threshold of ['0.5', '0.25', '0.9', '1.2', '0.6', '3 / 7']) {
      assert.equal(code.includes(threshold), false, `${file}: kynnys ${threshold} kuuluu sääntöihin`);
    }
  }
  const frozenDeep = value => Object.isFrozen(value) && Object.values(value).every(v => typeof v !== 'object' || frozenDeep(v));
  assert.ok(frozenDeep(DAILY_LIFE_POLICY));
  assert.equal(SLEEP_SIGNAL_RULES.MIN_COVERAGE, 0.5);
});

test('SUORITUSKYKY: vuoden unikirjaukset ja merkinnät', () => {
  const logs = days('2025-06-01', 400).map(d => night(d, '23:30', '06:30'));
  const entries = days('2025-06-01', 400).map(d => entry(d, 2, 5));
  const t0 = performance.now();
  for (let i = 0; i < 20; i += 1) dailyLifeSignals(fullInput({ sleepLogs: logs, wellbeingEntries: entries }));
  const elapsed = performance.now() - t0;
  assert.ok(elapsed < 3000, `20 viikkoa kesti ${Math.round(elapsed)} ms`);
});
