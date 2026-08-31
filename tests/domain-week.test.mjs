// Viikkologiikan testit.
//
// Viikko alkaa maanantaista, mutta JS:n getDay() palauttaa sunnuntain nollana.
// Se on klassinen off-by-one-ansa, joka näkyy vasta kuukauden tai vuoden
// vaihteessa — juuri silloin kun käyttäjä huomaisi sen pahiten.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  weekDays, weekDayIsoList, weekRangeLabel, groupByDate, dayGroupLabel, weekSummary
} from '../src/domain/week.js';
import { fmtISO, parseISO } from '../src/lib/datetime.js';

const task = (over = {}) => ({
  id: 'x', date: '2026-08-31', time: null, title: 'Tehtävä',
  category: 'muu', priority: 'normaali', completed: false, isWake: false, ...over
});

// --------------------------------------------------------- viikon rajat

test('viikko sisältää seitsemän päivää maanantaista sunnuntaihin', () => {
  const days = weekDays(parseISO('2026-09-02')); // keskiviikko
  assert.equal(days.length, 7);
  assert.equal(days[0].getDay(), 1, 'ensimmäinen päivä on maanantai');
  assert.equal(days[6].getDay(), 0, 'viimeinen päivä on sunnuntai');
});

test('RAJATAPAUS: sunnuntai kuuluu edeltävään viikkoon', () => {
  // 6.9.2026 on sunnuntai. Naiivi toteutus siirtäisi sen seuraavan viikon alkuun.
  const sunday = parseISO('2026-09-06');
  assert.equal(sunday.getDay(), 0, 'testin ennakkoehto');
  assert.deepEqual(weekDayIsoList(sunday)[0], '2026-08-31');
  assert.deepEqual(weekDayIsoList(sunday)[6], '2026-09-06');
});

test('RAJATAPAUS: maanantai ja sitä edeltävä sunnuntai ovat eri viikoilla', () => {
  const sunday = weekDayIsoList(parseISO('2026-09-06'));
  const monday = weekDayIsoList(parseISO('2026-09-07'));
  assert.notDeepEqual(sunday, monday);
  assert.equal(monday[0], '2026-09-07');
});

test('RAJATAPAUS: viikko kuukauden vaihteen yli', () => {
  const days = weekDayIsoList(parseISO('2026-08-31'));
  assert.deepEqual(days, [
    '2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03',
    '2026-09-04', '2026-09-05', '2026-09-06'
  ]);
});

test('RAJATAPAUS: viikko vuodenvaihteen yli', () => {
  // 31.12.2026 on torstai -> viikko alkaa maanantaina 28.12.2026.
  const days = weekDayIsoList(parseISO('2026-12-31'));
  assert.equal(days[0], '2026-12-28');
  assert.equal(days[6], '2027-01-03');
  assert.ok(days.includes('2026-12-31'));
  assert.ok(days.includes('2027-01-01'), 'uudenvuodenpäivän pitää kuulua samaan viikkoon');
});

test('RAJATAPAUS: karkausvuoden helmikuu', () => {
  // 2028 on karkausvuosi. 29.2.2028 on tiistai.
  const days = weekDayIsoList(parseISO('2028-02-29'));
  assert.ok(days.includes('2028-02-29'), 'karkauspäivän pitää löytyä viikosta');
  assert.equal(days.length, 7);
});

test('kaikki viikon päivät ovat peräkkäisiä', () => {
  for (const seed of ['2026-01-01', '2026-08-31', '2026-12-31', '2027-03-15']) {
    const days = weekDays(parseISO(seed));
    for (let i = 1; i < days.length; i++) {
      const diff = (days[i] - days[i - 1]) / 86400000;
      assert.ok(Math.abs(diff - 1) < 0.01,
        `${seed}: päivien ${i - 1} ja ${i} väli oli ${diff} vrk`);
    }
  }
});

test('viikon otsikko näyttää alku- ja loppupäivän', () => {
  assert.equal(weekRangeLabel(parseISO('2026-08-31')), '31.8. – 6.9.');
  assert.equal(weekRangeLabel(parseISO('2026-12-31')), '28.12. – 3.1.');
});

// ------------------------------------------------------------ ryhmittely

test('groupByDate ryhmittelee päivittäin ja säilyttää järjestyksen', () => {
  const tasks = [
    task({ id: 'c', date: '2026-09-02', time: '09:00' }),
    task({ id: 'a', date: '2026-08-31', time: '08:00' }),
    task({ id: 'b', date: '2026-08-31', time: '10:00' })
  ];
  const groups = groupByDate(tasks);
  assert.deepEqual([...groups.keys()], ['2026-08-31', '2026-09-02']);
  assert.deepEqual(groups.get('2026-08-31').map(t => t.id), ['a', 'b']);
});

test('groupByDate on deterministinen syötteen järjestyksestä riippumatta', () => {
  const tasks = [
    task({ id: 'a', date: '2026-08-31', time: '08:00' }),
    task({ id: 'b', date: '2026-09-01', time: '10:00' }),
    task({ id: 'c', date: '2026-08-31', time: '12:00' })
  ];
  const first = [...groupByDate(tasks).entries()].map(([k, v]) => [k, v.map(t => t.id)]);
  const second = [...groupByDate([...tasks].reverse()).entries()].map(([k, v]) => [k, v.map(t => t.id)]);
  assert.deepEqual(first, second);
});

test('groupByDate palauttaa tyhjän Mapin tyhjälle syötteelle', () => {
  assert.equal(groupByDate([]).size, 0);
});

// -------------------------------------------------------------- otsikot

test('dayGroupLabel tunnistaa tänään, huomenna ja eilen', () => {
  const reference = parseISO('2026-08-31');
  assert.equal(dayGroupLabel('2026-08-31', reference), 'Tänään');
  assert.equal(dayGroupLabel('2026-09-01', reference), 'Huomenna');
  assert.equal(dayGroupLabel('2026-08-30', reference), 'Eilen');
});

test('dayGroupLabel näyttää muille päiville viikonpäivän ja päivämäärän', () => {
  const reference = parseISO('2026-08-31');
  assert.equal(dayGroupLabel('2026-09-04', reference), 'Perjantai 4.9.');
});

test('dayGroupLabel toimii kuukauden vaihteessa', () => {
  assert.equal(dayGroupLabel('2026-09-01', parseISO('2026-08-31')), 'Huomenna');
  assert.equal(dayGroupLabel('2026-08-31', parseISO('2026-09-01')), 'Eilen');
});

// ------------------------------------------------------------ yhteenveto

test('weekSummary laskee tehtävät ja valmiit päivittäin', () => {
  const tasks = [
    task({ id: 'a', date: '2026-08-31', completed: true }),
    task({ id: 'b', date: '2026-08-31' }),
    task({ id: 'c', date: '2026-09-02' })
  ];
  const summary = weekSummary(parseISO('2026-08-31'), tasks);
  assert.equal(summary.length, 7);
  assert.equal(summary[0].total, 2);
  assert.equal(summary[0].completed, 1);
  assert.equal(summary[2].total, 1);
  assert.equal(summary[1].total, 0, 'tyhjä päivä on nolla, ei puuttuva');
});

test('weekSummary merkitsee päivän, jolla on kesken oleva tärkeä tehtävä', () => {
  const tasks = [
    task({ id: 'a', date: '2026-08-31', priority: 'korkea' }),
    task({ id: 'b', date: '2026-09-01', priority: 'korkea', completed: true })
  ];
  const summary = weekSummary(parseISO('2026-08-31'), tasks);
  assert.equal(summary[0].hasHighPriority, true);
  assert.equal(summary[1].hasHighPriority, false, 'valmis tehtävä ei enää vaadi huomiota');
});

test('weekSummary ei sisällä toisen viikon tehtäviä', () => {
  const tasks = [task({ id: 'a', date: '2026-09-14' })];
  const summary = weekSummary(parseISO('2026-08-31'), tasks);
  assert.equal(summary.reduce((sum, day) => sum + day.total, 0), 0);
});

test('weekSummary päivämäärät vastaavat viikon päiviä', () => {
  const start = parseISO('2026-08-31');
  const summary = weekSummary(start, []);
  assert.deepEqual(summary.map(d => d.iso), weekDayIsoList(start));
  assert.deepEqual(summary.map(d => fmtISO(d.date)), weekDayIsoList(start));
});
