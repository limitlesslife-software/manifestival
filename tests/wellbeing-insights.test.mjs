// Hyvinvoinnin koosteet: päivän yhdistäminen, keskiarvot (myös motivaatio
// ja hallinnan tunne) ja läpinäkyvä kuormitusehdotus.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  mergeDay, mergeDays, windowAverages, strainCounts, strainSuggestion,
  STRAIN_RULE, WELLBEING_SUGGESTION
} from '../src/domain/wellbeingInsights.js';
import { WELLBEING_RULES } from '../src/domain/dailyLifeSignalsPolicy.js';

const TODAY = '2026-06-12';

function entry(date, energy, stress, extra = {}) {
  return { id: `w-${date}`, date, energy, mood: 3, stress, sleepHours: 7, note: 'yksityinen', ...extra };
}
function checkin(date, motivation, control, extra = {}) {
  return { id: `c-${date}`, date, motivation, control, ...extra };
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

const NO_DIAGNOSIS = /diagno|masenn|uupum|burnout|sairau|hoito|lääk|häiriö|epäonnist|huono|laiska|häpe|pitäisi/i;

// ================================================================ YHDISTÄMINEN

test('päivän yhdistäminen: merkintä + tsekkaus samalta päivältä', () => {
  const day = mergeDay(entry(TODAY, 2, 4), checkin(TODAY, 3, 2));
  assert.deepEqual({ ...day }, {
    date: TODAY, energy: 2, mood: 3, stress: 4, sleepHours: 7, motivation: 3, control: 2, hasEntry: true, hasCheckin: true
  });
  assert.ok(Object.isFrozen(day));
  assert.equal('note' in day, false, 'muistiinpano ei kulje koosteeseen');
});

test('päivän yhdistäminen: toinen puuttuu, päivät eroavat, tyhjä ei ole nolla', () => {
  const onlyCheckin = mergeDay(null, checkin(TODAY, 4, null));
  assert.equal(onlyCheckin.energy, null);
  assert.equal(onlyCheckin.control, null);
  assert.equal(onlyCheckin.hasEntry, false);
  assert.equal(mergeDay(entry(TODAY, 3, 3), checkin('2026-06-11', 3, 3)), null);
  assert.equal(mergeDay(null, null), null);
  const blank = mergeDay(entry(TODAY, '', null, { sleepHours: 0.04 }), checkin(TODAY, undefined, ''));
  assert.equal(blank.energy, null);
  assert.equal(blank.stress, null);
  assert.equal(blank.sleepHours, null, '0,04 h pyöristyy nollaan -> tuntematon');
  assert.equal(blank.motivation, null);
  const clamped = mergeDay(entry(TODAY, 9, -3), checkin(TODAY, 0, 6));
  assert.equal(clamped.energy, 5);
  assert.equal(clamped.stress, 1);
  assert.equal(clamped.motivation, 1);
  assert.equal(clamped.control, 5);
});

test('päivät yhdistetään päivämäärittäin; kaksoisrivi ratkeaa myöhemmän päivityksen mukaan', () => {
  const entries = [
    entry('2026-06-10', 3, 3, { updatedAt: '2026-06-10T08:00:00Z' }),
    entry('2026-06-10', 1, 5, { id: 'w-late', updatedAt: '2026-06-10T20:00:00Z' }),
    entry('2026-06-11', 4, 2)
  ];
  const checkins = [checkin('2026-06-09', 2, 2), checkin('2026-06-11', 5, 5)];
  const days = mergeDays(entries, checkins);
  assert.deepEqual(days.map(d => d.date), ['2026-06-09', '2026-06-10', '2026-06-11']);
  assert.equal(days[1].energy, 1, 'myöhemmin päivitetty voittaa');
  assert.equal(days[0].hasEntry, false);
  assert.equal(days[2].control, 5);
  for (let seed = 1; seed <= 10; seed += 1) {
    assert.deepEqual(mergeDays(shuffled(entries, seed), shuffled(checkins, seed)), days);
  }
  assert.deepEqual(mergeDays(entries, checkins, { fromIso: '2026-06-10', toIso: '2026-06-10' }).map(d => d.date), ['2026-06-10']);
});

// ================================================================ KESKIARVOT

test('keskiarvot: myös motivaatio ja hallinnan tunne, puuttuvat ohitetaan', () => {
  const entries = [entry('2026-06-06', 2, 4), entry('2026-06-08', 4, 2), entry('2026-06-12', null, 5)];
  const checkins = [checkin('2026-06-06', 3, 2), checkin('2026-06-10', 5, null)];
  const avg = windowAverages({ entries, checkins, todayIso: TODAY });
  assert.equal(avg.fromIso, '2026-06-06');
  assert.equal(avg.toIso, TODAY);
  assert.equal(avg.days, 7);
  assert.equal(avg.reportedDays, 4);
  assert.equal(avg.energy, 3);
  assert.equal(avg.stress, 3.7);
  assert.equal(avg.motivation, 4);
  assert.equal(avg.control, 2);
  assert.equal(avg.counts.energy, 2);
  assert.equal(avg.counts.control, 1);
  assert.ok(Object.isFrozen(avg) && Object.isFrozen(avg.counts));
});

test('keskiarvot: raja-arvot, tyhjä ikkuna ja vuoden vaihde', () => {
  const entries = [entry('2026-06-05', 1, 1), entry('2026-06-06', 5, 5)];
  assert.equal(windowAverages({ entries, todayIso: TODAY }).energy, 5, '6.6. on ikkunan ensimmäinen päivä, 5.6. ei');
  const none = windowAverages({ entries: [], checkins: [], todayIso: TODAY });
  assert.equal(none.energy, null);
  assert.equal(none.motivation, null);
  assert.equal(none.reportedDays, 0);
  const newYear = windowAverages({ entries: [entry('2026-12-31', 2, 3), entry('2027-01-01', 4, 3)], fromIso: '2026-12-30', toIso: '2027-01-02' });
  assert.equal(newYear.days, 4);
  assert.equal(newYear.energy, 3);
  assert.equal(windowAverages({ entries, todayIso: TODAY, days: 1 }).days, 1);
  assert.equal(windowAverages({ entries, todayIso: TODAY, days: 0 }).days, 7);
  assert.equal(windowAverages({ entries, todayIso: 'huomenna' }), null);
  assert.equal(windowAverages({ entries, fromIso: '2026-06-10', toIso: '2026-06-01', todayIso: TODAY }).fromIso, '2026-06-06',
    'käänteinen väli ei kelpaa: käytetään tämän päivän ikkunaa');
});

// ================================================================ EHDOTUS

function strainedWeek(days, { energy = 2, stress = 4 } = {}) {
  return days.map(date => entry(date, energy, stress));
}

const LAST5 = ['2026-06-08', '2026-06-09', '2026-06-10', '2026-06-11', '2026-06-12'];

test('ehdotus: korkea kuormitus + matala energia 3/5 päivänä -> kevennysehdotus', () => {
  const entries = [...strainedWeek(LAST5.slice(0, 3)), entry(LAST5[3], 4, 2)];
  const s = strainSuggestion({ entries, todayIso: TODAY });
  assert.equal(s.kind, WELLBEING_SUGGESTION);
  assert.equal(s.rule, STRAIN_RULE.LOW_ENERGY);
  assert.equal(s.text, 'Harkitse kuorman keventämistä tällä viikolla.');
  assert.match(s.why, /3 päivänä viimeisistä 5 päivästä/);
  assert.equal(s.appliesAutomatically, false);
  assert.equal(s.basis, 'reported');
  assert.deepEqual({ ...s.metrics }, { windowDays: 5, reportedDays: 4, strainedDays: 3, plannedPercent: null });
  assert.ok(Object.isFrozen(s) && Object.isFrozen(s.metrics));
});

test('ehdotus: rajat — 2/5 ei riitä, kuormitus 3 ei ole korkea, energia 3 ei ole matala', () => {
  assert.equal(strainSuggestion({ entries: [...strainedWeek(LAST5.slice(0, 2)), entry(LAST5[2], 4, 2)], todayIso: TODAY }), null);
  assert.equal(strainSuggestion({ entries: strainedWeek(LAST5, { stress: WELLBEING_RULES.HIGH_LOAD_MIN - 1 }), todayIso: TODAY }), null);
  assert.equal(strainSuggestion({ entries: strainedWeek(LAST5, { energy: WELLBEING_RULES.LOW_ENERGY_MAX + 1 }), todayIso: TODAY }), null);
  // Ikkunan ulkopuolinen päivä (6 päivää sitten) ei lasketa.
  assert.equal(strainSuggestion({ entries: strainedWeek(['2026-06-07', '2026-06-08', '2026-06-09']), todayIso: TODAY }), null);
});

test('ehdotus: harva aineisto -> null (tuntematon ei ole "kaikki hyvin" eikä "huono")', () => {
  assert.equal(strainSuggestion({ entries: strainedWeek(LAST5.slice(0, 2)), todayIso: TODAY }), null);
  assert.equal(strainSuggestion({ entries: [], checkins: [], todayIso: TODAY }), null);
  // Pelkkä energia ilman kuormitusta ei ole merkitty päivä.
  assert.equal(strainSuggestion({ entries: LAST5.map(d => entry(d, 1, null)), todayIso: TODAY }), null);
  assert.equal(strainSuggestion({ entries: strainedWeek(LAST5), todayIso: null }), null);
});

test('ehdotus: hallinnan tunne (uusi tsekkaus) toimii, kun energiaa ei ole merkitty', () => {
  const entries = LAST5.map(d => entry(d, null, 5));
  const checkins = LAST5.slice(0, 3).map(d => checkin(d, 3, 1));
  const s = strainSuggestion({ entries, checkins, todayIso: TODAY });
  assert.equal(s.rule, STRAIN_RULE.LOW_CONTROL);
  assert.equal(s.text, 'Harkitse, voisiko jonkin tämän viikon asian siirtää tai jakaa.');
  assert.equal(s.metrics.reportedDays, 3);
  const counts = strainCounts({ entries, checkins, fromIso: LAST5[0], toIso: TODAY });
  assert.equal(counts.lowControlDays, 3);
  assert.equal(counts.lowEnergyDays, 0);
  assert.equal(counts.strainedDays, 3);
});

test('ehdotus: suunniteltu kuorma lisää perusteluun tiedon vain kun molemmat luvut tunnetaan', () => {
  const entries = strainedWeek(LAST5.slice(0, 3));
  const full = strainSuggestion({ entries, todayIso: TODAY, plannedLoad: { plannedMinutes: 2400, capacityMinutes: 2400 } });
  assert.equal(full.metrics.plannedPercent, 100);
  assert.match(full.plannedLoadNote, /täyttää jo koko/);
  const light = strainSuggestion({ entries, todayIso: TODAY, plannedLoad: { plannedMinutes: 600, capacityMinutes: 2400 } });
  assert.equal(light.metrics.plannedPercent, 25);
  assert.equal(light.plannedLoadNote, null);
  for (const plannedLoad of [{ plannedMinutes: null, capacityMinutes: 100 }, { plannedMinutes: 10, capacityMinutes: 0 },
    { plannedMinutes: '', capacityMinutes: 100 }, 'x', null]) {
    assert.equal(strainSuggestion({ entries, todayIso: TODAY, plannedLoad }).metrics.plannedPercent, null);
  }
});

test('SÄVY: ehdotus ei diagnosoi, ei syyllistä eikä kerro hoidosta', () => {
  const texts = [];
  for (const rule of ['energy', 'control']) {
    const s = rule === 'energy'
      ? strainSuggestion({ entries: strainedWeek(LAST5), todayIso: TODAY, plannedLoad: { plannedMinutes: 5000, capacityMinutes: 100 } })
      : strainSuggestion({ entries: LAST5.map(d => entry(d, null, 5)), checkins: LAST5.map(d => checkin(d, 1, 1)), todayIso: TODAY });
    texts.push(s.text, s.why, s.plannedLoadNote);
  }
  for (const text of texts.filter(Boolean)) assert.doesNotMatch(text, NO_DIAGNOSIS, text);
});

// ================================================================ KESTÄVYYS

test('DETERMINISMI ja syötteen koskemattomuus', () => {
  const entries = Object.freeze([...strainedWeek(LAST5), entry('2026-06-01', 3, 3)].map(Object.freeze));
  const checkins = Object.freeze(LAST5.map(d => Object.freeze(checkin(d, 2, 2))));
  const before = JSON.stringify({ entries, checkins });
  const base = JSON.stringify([
    strainSuggestion({ entries, checkins, todayIso: TODAY }),
    windowAverages({ entries, checkins, todayIso: TODAY }),
    mergeDays(entries, checkins)
  ]);
  for (let seed = 1; seed <= 15; seed += 1) {
    const e = shuffled(entries, seed);
    const c = shuffled(checkins, seed);
    assert.equal(JSON.stringify([
      strainSuggestion({ entries: e, checkins: c, todayIso: TODAY }),
      windowAverages({ entries: e, checkins: c, todayIso: TODAY }),
      mergeDays(e, c)
    ]), base);
  }
  assert.equal(JSON.stringify({ entries, checkins }), before);
});

test('ROSKA: mikään syöte ei kaada', () => {
  const garbage = [undefined, null, 1, 'x', {}, [null, 'x', 5, [], { date: 5 }, { date: '2026-02-30', energy: 3 }],
    [{ date: TODAY, energy: {}, stress: [], sleepHours: 'NaN', updatedAt: {} }], [{ date: TODAY, energy: true, stress: Infinity }]];
  for (const value of garbage) {
    assert.doesNotThrow(() => {
      mergeDay(value, value);
      mergeDays(value, value, value);
      windowAverages({ entries: value, checkins: value, todayIso: TODAY, days: value });
      strainCounts({ entries: value, checkins: value, fromIso: value, toIso: value });
      strainSuggestion({ entries: value, checkins: value, plannedLoad: value, todayIso: value });
      strainSuggestion({ entries: value, checkins: value, plannedLoad: value, todayIso: TODAY });
    });
  }
  const odd = mergeDay({ date: TODAY, energy: true, stress: Infinity }, null);
  assert.equal(odd.energy, null, 'totuusarvo ei ole asteikon arvo');
  assert.equal(odd.stress, null);
  assert.doesNotThrow(() => { mergeDay(); mergeDays(); windowAverages(); strainCounts(); strainSuggestion(); });
  for (const bad of [null, 5, 'x', true]) {
    assert.equal(windowAverages(bad), null);
    assert.equal(strainCounts(bad), null);
    assert.equal(strainSuggestion(bad), null);
    assert.deepEqual(mergeDays(bad, bad, bad), []);
  }
});

test('SUORITUSKYKY: vuosien merkinnät käsitellään nopeasti', () => {
  const entries = [];
  const checkins = [];
  for (let i = 0; i < 20000; i += 1) {
    const date = new Date(Date.UTC(2000, 0, 1 + i)).toISOString().slice(0, 10);
    entries.push(entry(date, (i % 5) + 1, ((i + 2) % 5) + 1));
    checkins.push(checkin(date, (i % 5) + 1, ((i + 1) % 5) + 1));
  }
  const t0 = performance.now();
  windowAverages({ entries, checkins, fromIso: '2000-01-01', toIso: '2060-01-01' });
  strainSuggestion({ entries, checkins, todayIso: '2050-01-01' });
  const elapsed = performance.now() - t0;
  assert.ok(elapsed < 2000, `kesti ${Math.round(elapsed)} ms`);
});
