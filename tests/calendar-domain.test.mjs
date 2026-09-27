// Kalenteri: tapahtumien esiintymät sekä päivä-, viikko- ja kuukausimallit.
//
// Lukitsee src/domain/calendar.js:n lupaukset:
//   - esiintymät lasketaan säännöstä, ei tallenneta (kerta, viikoittainen,
//     loppupäivä, ohitetut päivät, koko päivän tapahtuma)
//   - loppuaika johdetaan kestosta ja kesto välistä; keskiyön ylitys
//     lasketaan kuten task.durationOf; tuntematon kesto on null, ei nolla
//   - laajennus on rajattu (400 päivää), deterministinen myös sekoitetulla
//     syötteellä, jäädytetty, ei muuta syötettä eikä kaadu roskaan
//   - päivälaskenta ei riipu aikavyöhykkeestä eikä kesäajasta
//   - näkymämallit: päivä, viikko (ISO-viikko, maanantaista) ja kuukausi
//     (4–6 riviä, kuukauden ulkopuoliset päivät merkitty)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import { ROOT, readCode } from './helpers/sources.mjs';
import {
  expandEventOccurrences, dayAgenda, weekModel, monthGrid, monthGridRange, weekRange, agendaRange,
  dayNumberOf, isoOfDayNumber, addDaysToIso, isoWeekdayOf, isoWeekOf, mondayOf, shiftMonth,
  absoluteMinutesOf, fromAbsoluteMinutes, monthLabel, shortDateLabel, longDateLabel, spokenDateLabel,
  weekRangeLabel, MAX_EVENT_EXPANSION_DAYS, MAX_MONTH_ROWS
} from '../src/domain/calendar.js';
import { departureSchedule } from '../src/domain/travel.js';
import { normalizeTask } from '../src/domain/task.js';
import { normalizeRoutine, expandRoutines, RECURRENCE } from '../src/domain/routine.js';

// ------------------------------------------------------------------ apurit

const event = (over = {}) => ({
  id: 'e1',
  title: 'Hammaslääkäri',
  date: '2026-09-28',
  startTime: '10:00',
  endTime: null,
  durationMinutes: 60,
  allDay: false,
  category: 'hyvinvointi',
  locationText: null,
  placeId: null,
  travelMode: null,
  travelMinutes: null,
  preparationMinutes: null,
  arrivalBufferMinutes: null,
  overheadMinutes: null,
  recurrenceWeekdays: [],
  recurrenceUntil: null,
  skipDates: [],
  goalId: null,
  notes: null,
  createdAt: '2026-09-01T10:00:00Z',
  updatedAt: '2026-09-01T10:00:00Z',
  ...over
});

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

/** mulberry32: sama siemen, sama aineisto joka ajolla. */
function seeded(seed) {
  return function random() {
    seed |= 0;
    seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function shuffle(list, random) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/** Laskeva kääre: jokainen kentän luku kasvattaa laskuria (kuten goal-to-action-performance). */
function counting(entity) {
  const wrapped = {};
  for (const key of Object.keys(entity)) {
    Object.defineProperty(wrapped, key, {
      enumerable: true,
      get() { counting.total += 1; return entity[key]; }
    });
  }
  return wrapped;
}
counting.total = 0;

const pad = n => String(n).padStart(2, '0');

// ------------------------------------------------------------ päivälaskenta

test('päivän järjestysluku: 1970-01-01 on 0 ja kierto on tarkka vuosikymmenten yli', () => {
  assert.equal(dayNumberOf('1970-01-01'), 0);
  assert.equal(dayNumberOf('1969-12-31'), -1);
  assert.equal(isoOfDayNumber(0), '1970-01-01');

  // Riippumaton tarkistus: UTC-kalenteri ei tunne kesäaikaa.
  const start = Date.UTC(1999, 11, 20) / 86400000;
  for (let n = start; n < start + 12000; n += 1) {
    const iso = new Date(n * 86400000).toISOString().slice(0, 10);
    assert.equal(dayNumberOf(iso), n, iso);
    assert.equal(isoOfDayNumber(n), iso);
  }
});

test('päivälaskenta: kuukauden, vuoden ja karkauspäivän vaihde', () => {
  assert.equal(addDaysToIso('2026-12-31', 1), '2027-01-01');
  assert.equal(addDaysToIso('2027-01-01', -1), '2026-12-31');
  assert.equal(addDaysToIso('2028-02-28', 1), '2028-02-29');
  assert.equal(addDaysToIso('2026-02-28', 1), '2026-03-01');
  assert.equal(addDaysToIso('2026-09-30', 1), '2026-10-01');
  assert.equal(addDaysToIso('2026-03-28', 2), '2026-03-30', 'kesäajan alku ei syö päivää');
  assert.equal(addDaysToIso('2026-10-24', 2), '2026-10-26', 'kesäajan loppu ei tuplaa päivää');
  assert.equal(addDaysToIso('roska', 1), null);
  assert.equal(addDaysToIso('2026-02-31', 1), null);
  assert.equal(addDaysToIso('2026-01-01', 1.5), null);
});

test('ISO-viikonpäivät ja maanantai', () => {
  assert.equal(isoWeekdayOf('2026-09-26'), 6); // lauantai
  assert.equal(isoWeekdayOf('2026-09-28'), 1); // maanantai
  assert.equal(isoWeekdayOf('2026-03-29'), 7); // kesäajan alku, sunnuntai
  assert.equal(isoWeekdayOf('2026-10-25'), 7); // kesäajan loppu, sunnuntai
  assert.equal(isoWeekdayOf('2000-02-29'), 2);
  assert.equal(isoWeekdayOf('1970-01-01'), 4);
  assert.equal(isoWeekdayOf('x'), null);
  assert.equal(mondayOf('2026-10-04'), '2026-09-28');
  assert.equal(mondayOf('2026-09-28'), '2026-09-28');
  assert.equal(mondayOf('2027-01-03'), '2026-12-28');
});

test('ISO-viikkonumero: viikko kuuluu torstain vuodelle', () => {
  assert.deepEqual({ ...isoWeekOf('2026-01-01') }, { year: 2026, week: 1 });
  assert.deepEqual({ ...isoWeekOf('2026-09-26') }, { year: 2026, week: 39 });
  assert.deepEqual({ ...isoWeekOf('2027-01-01') }, { year: 2026, week: 53 });
  assert.deepEqual({ ...isoWeekOf('2021-01-03') }, { year: 2020, week: 53 });
  assert.deepEqual({ ...isoWeekOf('2024-12-30') }, { year: 2025, week: 1 });
  assert.equal(isoWeekOf('2026-13-01'), null);
});

test('absoluuttiset minuutit ovat samaa asteikkoa kuin travel.js lähtöaikataulu', () => {
  // Kalenterin lohkot ja lähtömoottori puhuvat samoista luvuista: jos
  // asteikot eroaisivat, matka varattaisiin väärälle päivälle.
  for (const date of ['2026-03-29', '2026-10-25', '2026-12-31', '2028-02-29']) {
    const schedule = departureSchedule({
      arrivalDate: date, arrivalTime: '00:20', travelMinutes: 45,
      arrivalBufferMinutes: 5, preparationMinutes: 10, travelSource: 'manual'
    }, { todayIso: date });
    assert.equal(schedule.arrive.abs, absoluteMinutesOf(date, 20));
    assert.equal(schedule.leave.abs, absoluteMinutesOf(date, 20) - 50);
    const back = fromAbsoluteMinutes(schedule.leave.abs);
    assert.equal(back.date, schedule.leave.date);
    assert.equal(back.time, schedule.leave.time);
  }
  assert.equal(absoluteMinutesOf('roska', 10), null);
  assert.equal(fromAbsoluteMinutes(NaN), null);
});

test('kuukauden siirto vaihtaa vuoden oikein', () => {
  assert.equal(shiftMonth('2026-12', 1), '2027-01');
  assert.equal(shiftMonth('2026-01', -1), '2025-12');
  assert.equal(shiftMonth('2026-09', 0), '2026-09');
  assert.equal(shiftMonth('2026-09', 15), '2027-12');
  assert.equal(shiftMonth('2026-13', 1), null);
  assert.equal(shiftMonth('2026-9', 1), null);
});

test('suomenkieliset päiväykset', () => {
  assert.equal(shortDateLabel('2026-09-26'), 'la 26.9.');
  assert.equal(longDateLabel('2026-09-26'), 'lauantai 26.9.2026');
  assert.equal(spokenDateLabel('2026-09-26'), 'lauantai 26. syyskuuta 2026');
  assert.equal(spokenDateLabel('2026-03-01'), 'sunnuntai 1. maaliskuuta 2026');
  assert.equal(monthLabel('2026-12'), 'joulukuu 2026');
  assert.equal(weekRangeLabel('2026-09-23'), '21.–27.9.2026');
  assert.equal(weekRangeLabel('2026-10-01'), '28.9.–4.10.2026');
  assert.equal(weekRangeLabel('2026-12-31'), '28.12.2026–3.1.2027');
  assert.equal(longDateLabel('roska'), '');
});

// ------------------------------------------------------------ esiintymät

test('kertaluonteinen tapahtuma: yksi esiintymä, oikea muoto', () => {
  const [occurrence, ...rest] = expandEventOccurrences({
    events: [event({ placeId: 'p1', travelMode: 'transit', travelMinutes: 25, preparationMinutes: 10,
      arrivalBufferMinutes: 5, overheadMinutes: 3, goalId: 'g1', notes: 'Muista kortti' })],
    from: '2026-09-01', to: '2026-09-30'
  });
  assert.equal(rest.length, 0);
  assert.equal(occurrence.id, 'event:e1:2026-09-28');
  assert.equal(occurrence.eventId, 'e1');
  assert.equal(occurrence.date, '2026-09-28');
  assert.equal(occurrence.time, '10:00');
  assert.equal(occurrence.endTime, '11:00', 'loppuaika johdetaan kestosta');
  assert.equal(occurrence.durationMinutes, 60);
  assert.equal(occurrence.allDay, false);
  assert.equal(occurrence.isEvent, true);
  assert.equal(occurrence.source, 'event');
  assert.equal(occurrence.startMinute, 600);
  assert.equal(occurrence.endMinute, 660);
  assert.equal(occurrence.crossesMidnight, false);
  assert.equal(occurrence.endDate, '2026-09-28');
  assert.equal(occurrence.placeId, 'p1');
  assert.equal(occurrence.hasPlace, true);
  assert.equal(occurrence.travelMode, 'transit');
  assert.equal(occurrence.travelMinutes, 25);
  assert.equal(occurrence.preparationMinutes, 10);
  assert.equal(occurrence.arrivalBufferMinutes, 5);
  assert.equal(occurrence.overheadMinutes, 3);
  assert.equal(occurrence.goalId, 'g1');
  assert.equal(occurrence.notes, 'Muista kortti');
  assert.equal(occurrence.recurring, false);
  assert.ok(Object.isFrozen(occurrence));

  assert.deepEqual(expandEventOccurrences({ events: [event()], from: '2026-09-29', to: '2026-10-30' }), []);
  assert.equal(expandEventOccurrences({ events: [event()], from: '2026-09-28', to: '2026-09-28' }).length, 1,
    'aikaväli on molemmista päistä suljettu');
});

test('viikoittainen: valitut viikonpäivät, loppupäivä mukaan lukien, ohitetut päivät pois', () => {
  const occurrences = expandEventOccurrences({
    events: [event({
      date: '2026-09-01', // tiistai
      recurrenceWeekdays: [2, 4],
      recurrenceUntil: '2026-09-17', // torstai
      skipDates: ['2026-09-10', '2026-09-01']
    })],
    from: '2026-08-01', to: '2026-12-31'
  });
  assert.deepEqual(occurrences.map(o => o.date),
    ['2026-09-03', '2026-09-08', '2026-09-15', '2026-09-17']);
  assert.ok(occurrences.every(o => o.recurring && o.time === '10:00'));
  assert.ok(occurrences.every(o => [2, 4].includes(isoWeekdayOf(o.date))));
});

test('viikoittainen: alkupäivä on aina ensimmäinen esiintymä, vaikka viikonpäivä ei olisi listassa', () => {
  // "date (first/only occurrence)": käyttäjän kirjaama päivä ei katoa.
  const occurrences = expandEventOccurrences({
    events: [event({ date: '2026-09-28', recurrenceWeekdays: [3] })], // ma, toisto ke
    from: '2026-09-28', to: '2026-10-08'
  });
  assert.deepEqual(occurrences.map(o => o.date), ['2026-09-28', '2026-09-30', '2026-10-07']);
});

test('viikoittainen ilman loppupäivää jatkuu, mutta laajennus rajataan 400 päivään', () => {
  const occurrences = expandEventOccurrences({
    events: [event({ date: '2026-01-01', recurrenceWeekdays: [1, 2, 3, 4, 5, 6, 7] })],
    from: '2026-01-01', to: '2030-12-31'
  });
  assert.equal(MAX_EVENT_EXPANSION_DAYS, 400);
  assert.equal(occurrences.length, 400);
  assert.equal(occurrences.at(-1).date, addDaysToIso('2026-01-01', 399));
});

test('esiintymät vuoden ja kuukauden vaihteen yli', () => {
  const occurrences = expandEventOccurrences({
    events: [event({ date: '2026-12-28', recurrenceWeekdays: [1] })],
    from: '2026-12-01', to: '2027-01-31'
  });
  assert.deepEqual(occurrences.map(o => o.date),
    ['2026-12-28', '2027-01-04', '2027-01-11', '2027-01-18', '2027-01-25']);

  const leap = expandEventOccurrences({
    events: [event({ date: '2028-02-29', recurrenceWeekdays: [2] })],
    from: '2028-02-28', to: '2028-03-08'
  });
  assert.deepEqual(leap.map(o => o.date), ['2028-02-29', '2028-03-07']);
});

test('koko päivän tapahtuma: ei kellonaikaa, ei kestoa', () => {
  const [occurrence] = expandEventOccurrences({
    events: [event({ startTime: null, endTime: null, durationMinutes: null, allDay: true })],
    from: '2026-09-28', to: '2026-09-28'
  });
  assert.equal(occurrence.allDay, true);
  assert.equal(occurrence.time, null);
  assert.equal(occurrence.endTime, null);
  assert.equal(occurrence.durationMinutes, null);
  assert.equal(occurrence.startMinute, null);
  assert.equal(occurrence.endMinute, null);
});

test('kesto ja loppuaika: väli voittaa, keskiyön ylitys kiertää, tuntematon on null', () => {
  const expand = over => expandEventOccurrences({
    events: [event(over)], from: '2026-09-28', to: '2026-09-28'
  })[0];

  const interval = expand({ startTime: '09:00', endTime: '10:30', durationMinutes: 15 });
  assert.equal(interval.durationMinutes, 90, 'väli on tosiasia, erillinen kesto vain arvio');

  const night = expand({ startTime: '23:00', endTime: '01:00', durationMinutes: null });
  assert.equal(night.durationMinutes, 120);
  assert.equal(night.crossesMidnight, true);
  assert.equal(night.endDate, '2026-09-29');
  assert.equal(night.endMinute, 1500);

  const derived = expand({ startTime: '23:30', durationMinutes: 90 });
  assert.equal(derived.endTime, '01:00');
  assert.equal(derived.endDate, '2026-09-29');

  const toMidnight = expand({ startTime: '23:00', durationMinutes: 60 });
  assert.equal(toMidnight.endTime, '00:00');
  assert.equal(toMidnight.crossesMidnight, false, 'keskiyöhön päättyvä ei ylitä vuorokautta');
  assert.equal(toMidnight.endDate, '2026-09-28');

  const fullDay = expand({ startTime: '10:00', durationMinutes: 1440 });
  assert.equal(fullDay.endTime, null, 'vuorokauden kesto: loppuaika olisi sama kuin alku');
  assert.equal(fullDay.durationMinutes, 1440);
  assert.equal(fullDay.endDate, '2026-09-29');

  const unknown = expand({ durationMinutes: null });
  assert.equal(unknown.durationMinutes, null, 'tuntematon kesto ei ole nolla');
  assert.equal(unknown.endTime, null);
  assert.equal(unknown.endMinute, null);

  const same = expand({ startTime: '10:00', endTime: '10:00', durationMinutes: 45 });
  assert.equal(same.durationMinutes, 45, 'sama alku ja loppu ei ole väli; kesto luetaan erikseen');
  assert.equal(same.endTime, '10:45');

  for (const bad of [0, -5, 1441, NaN, Infinity, '', 'abc', true, {}]) {
    assert.equal(expand({ durationMinutes: bad }).durationMinutes, null, `kesto ${String(bad)}`);
  }
});

test('matkaparametrit: rajojen ulkopuolinen on tuntematon (null), ei nolla eikä leikattu', () => {
  const expand = over => expandEventOccurrences({
    events: [event(over)], from: '2026-09-28', to: '2026-09-28'
  })[0];
  assert.equal(expand({ travelMinutes: 0 }).travelMinutes, null);
  assert.equal(expand({ travelMinutes: 1441 }).travelMinutes, null);
  assert.equal(expand({ travelMinutes: 1440 }).travelMinutes, 1440);
  assert.equal(expand({ preparationMinutes: 0 }).preparationMinutes, 0);
  assert.equal(expand({ preparationMinutes: 481 }).preparationMinutes, null);
  assert.equal(expand({ arrivalBufferMinutes: 240 }).arrivalBufferMinutes, 240);
  assert.equal(expand({ overheadMinutes: -1 }).overheadMinutes, null);
  assert.equal(expand({ travelMode: 'teleport' }).travelMode, null);
  assert.equal(expand({ locationText: '  Kamppi  ' }).locationText, 'Kamppi');
  assert.equal(expand({ locationText: '  ' }).hasPlace, false);
  assert.equal(expand({ locationText: 'Kamppi' }).hasPlace, true);
  assert.equal(expand({ title: '   ' }).title, 'Nimetön tapahtuma');
  assert.equal(expand({ category: 'tuntematon' }).category, 'muu');
});

test('kesäajan vaihtopäivät: kellonaika pysyy seinäkelloaikana', () => {
  // Helsinki 2026: su 29.3. klo 03 -> 04 ja su 25.10. klo 04 -> 03.
  const weekly = expandEventOccurrences({
    events: [event({ date: '2026-03-22', startTime: '10:00', recurrenceWeekdays: [7] })],
    from: '2026-03-01', to: '2026-11-01'
  });
  const dates = weekly.map(o => o.date);
  assert.ok(dates.includes('2026-03-29') && dates.includes('2026-10-25'));
  assert.ok(weekly.every(o => o.time === '10:00' && isoWeekdayOf(o.date) === 7));

  // 03:30 ei ole olemassa Helsingissä 29.3., mutta kalenteri ei siirrä sitä:
  // herätys ja ilmoitukset päättävät, miten olematon hetki soitetaan.
  const [gap] = expandEventOccurrences({
    events: [event({ date: '2026-03-29', startTime: '03:30', durationMinutes: 30 })],
    from: '2026-03-29', to: '2026-03-29'
  });
  assert.equal(gap.time, '03:30');
  assert.equal(gap.endTime, '04:00');

  const [night] = expandEventOccurrences({
    events: [event({ date: '2026-10-24', startTime: '23:30', endTime: '01:30' })],
    from: '2026-10-24', to: '2026-10-25'
  });
  assert.equal(night.durationMinutes, 120, 'seinäkellon kesto, kuten task.durationOf');
  assert.equal(night.endDate, '2026-10-25');
});

test('KRIITTINEN: tulos ei riipu aikavyöhykkeestä (Helsinki, UTC, New York, Tokio)', () => {
  const code = `
    import { expandEventOccurrences, dayAgenda, monthGrid } from './src/domain/calendar.js';
    import { deriveBlocks } from './src/domain/calendarBlocks.js';
    import { buildDayPlan } from './src/domain/scheduler.js';
    const events = [
      { id: 'a', title: 'Yö', date: '2026-03-28', startTime: '23:30', endTime: '01:30', recurrenceWeekdays: [6], recurrenceUntil: '2026-11-01' },
      { id: 'b', title: 'Aamu', date: '2026-03-29', startTime: '03:30', durationMinutes: 45, recurrenceWeekdays: [7] }
    ];
    const occurrences = expandEventOccurrences({ events, from: '2026-03-27', to: '2026-10-26' });
    const blocks = deriveBlocks({ occurrences, sleepSchedules: [
      { date: '2026-03-28', bedtime: '23:00', wakeTime: '07:00' },
      { date: '2026-10-24', bedtime: '23:00', wakeTime: '07:00' }
    ] });
    const out = {
      n: occurrences.length,
      ids: occurrences.filter(o => o.date >= '2026-10-20').map(o => o.id + o.time + o.endDate),
      agenda: dayAgenda({ date: '2026-03-29', occurrences, blocks }).entries.map(e => e.id + e.time + e.endTime),
      plan: buildDayPlan({ tasks: [], dateIso: '2026-10-25', events: occurrences, blocks }).freeSlots,
      grid: monthGrid({ month: '2026-03', occurrences }).rows.map(r => r.days.map(d => d.date + d.counts.events).join())
    };
    console.log(JSON.stringify(out));
  `;
  const run = tz => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: ROOT, env: { ...process.env, TZ: tz }, encoding: 'utf8'
  }).trim().split('\n').pop());

  const helsinki = run('Europe/Helsinki');
  assert.ok(helsinki.n > 50);
  for (const zone of ['UTC', 'America/New_York', 'Asia/Tokyo']) {
    assert.deepEqual(run(zone), helsinki, `${zone} tuotti eri kalenterin kuin Helsinki`);
  }
});

test('determinismi: sekoitettu syöte tuottaa saman tuloksen', () => {
  const random = seeded(99);
  const events = Array.from({ length: 60 }, (_, i) => event({
    id: `e${i}`,
    title: `Tapahtuma ${i % 7}`,
    date: `2026-${pad(9 + (i % 3))}-${pad(1 + (i % 27))}`,
    startTime: i % 5 === 0 ? null : `${pad(6 + (i % 14))}:${i % 2 ? '30' : '00'}`,
    durationMinutes: 15 + (i % 6) * 15,
    recurrenceWeekdays: i % 4 === 0 ? [1 + (i % 7)] : []
  }));
  const reference = expandEventOccurrences({ events, from: '2026-09-01', to: '2026-12-31' });
  for (let round = 0; round < 5; round++) {
    assert.deepEqual(
      expandEventOccurrences({ events: shuffle(events, random), from: '2026-09-01', to: '2026-12-31' }),
      reference);
  }
  const ids = reference.map(o => o.id);
  assert.equal(new Set(ids).size, ids.length, 'kaksi esiintymää samalla tunnisteella');
});

test('sama tunniste kahdesti: uusin muokkaus voittaa järjestyksestä riippumatta', () => {
  const older = event({ title: 'Vanha', startTime: '09:00', updatedAt: '2026-09-01T10:00:00Z' });
  const newer = event({ title: 'Uusi', startTime: '12:00', updatedAt: '2026-09-02T10:00:00Z' });
  for (const order of [[older, newer], [newer, older]]) {
    const result = expandEventOccurrences({ events: order, from: '2026-09-28', to: '2026-09-28' });
    assert.equal(result.length, 1);
    assert.equal(result[0].title, 'Uusi');
  }
  const a = event({ title: 'A', updatedAt: '' });
  const b = event({ title: 'B', updatedAt: '' });
  assert.deepEqual(
    expandEventOccurrences({ events: [a, b], from: '2026-09-28', to: '2026-09-28' }),
    expandEventOccurrences({ events: [b, a], from: '2026-09-28', to: '2026-09-28' }));
});

test('syötettä ei muuteta ja tulos on jäädytetty', () => {
  const events = [event({ recurrenceWeekdays: [1, 3], skipDates: ['2026-10-05'] }), event({ id: 'e2' })];
  const snapshot = JSON.stringify(events);
  deepFreeze(events);
  const result = expandEventOccurrences({ events, from: '2026-09-01', to: '2026-10-31' });
  assert.equal(JSON.stringify(events), snapshot);
  assert.ok(Object.isFrozen(result));
  assert.ok(result.every(Object.isFrozen));
  assert.throws(() => { 'use strict'; result.push({}); });
});

test('roskasyöte ei koskaan kaada laajennusta', () => {
  const hostile = new Proxy({}, { get() { throw new Error('ansa'); } });
  const garbage = [
    null, undefined, 0, 1, 'teksti', [], () => {}, hostile,
    { id: {}, date: '2026-09-28' },
    { id: 'a', date: '2026-02-31', startTime: '10:00' },
    { id: 'b', date: '2026-09-28', startTime: '25:00' },
    { id: 'c', date: '2026-09-28', startTime: '10:00', recurrenceWeekdays: 'maanantai', skipDates: 5 },
    { id: 'd', date: '2026-09-28', startTime: '10:00', recurrenceWeekdays: [0, 8, 'x', null, 1.5] },
    { id: 'e', date: '2026-09-28', startTime: '10:00', endTime: 1000, durationMinutes: '60' },
    { id: 'f', date: '2026-09-28', startTime: 10, recurrenceUntil: 'huomenna' },
    { id: '__proto__', date: '2026-09-28', startTime: '10:00' },
    { id: 'g', date: '2026-09-28', title: { toString() { throw new Error('x'); } } }
  ];
  for (const events of [garbage, null, undefined, 'x', 42, {}, [hostile]]) {
    for (const [from, to] of [['2026-09-01', '2026-09-30'], [null, null], ['x', 'y'], ['2026-09-30', '2026-09-01'], [1, 2]]) {
      assert.doesNotThrow(() => expandEventOccurrences({ events, from, to }));
    }
  }
  assert.doesNotThrow(() => expandEventOccurrences());
  const result = expandEventOccurrences({ events: garbage, from: '2026-09-01', to: '2026-09-30' });
  // Kelvolliset rivit selviävät: c (ei toistoa, koska viikonpäivät roskaa),
  // d (toisto maanantaisin), e (numeerinen kesto hyväksytään), f (koko päivä),
  // __proto__ (tavallinen tunniste).
  assert.ok(result.some(o => o.eventId === 'c'));
  assert.ok(result.some(o => o.eventId === 'd'));
  assert.equal(result.find(o => o.eventId === 'e').durationMinutes, 60);
  assert.equal(result.find(o => o.eventId === 'f').allDay, true);
  assert.ok(result.some(o => o.eventId === '__proto__'));
  assert.ok(!result.some(o => o.eventId === 'a'), 'mahdoton päivä ohitetaan');
  // Kelvoton kellonaika tarkoittaa "ei kellonaikaa" (allDay === (startTime === null)):
  // käyttäjän kirjaama tapahtuma ei katoa, vaan näkyy koko päivän tapahtumana.
  assert.equal(result.find(o => o.eventId === 'b').allDay, true);
});

test('KRIITTINEN: laajennus kasvaa lineaarisesti tapahtumien määrän mukaan', () => {
  const reads = count => {
    const events = Array.from({ length: count }, (_, i) => counting(event({
      id: `e${i}`, date: `2026-09-${pad(1 + (i % 28))}`,
      recurrenceWeekdays: i % 2 ? [1, 4] : [], recurrenceUntil: '2026-12-31'
    })));
    counting.total = 0;
    expandEventOccurrences({ events, from: '2026-09-01', to: '2026-12-31' });
    return counting.total;
  };
  const small = reads(200);
  const large = reads(400);
  assert.ok(small > 0);
  assert.ok(large / small < 2.8, `kasvu ${(large / small).toFixed(2)}× näyttää neliölliseltä`);
});

// ------------------------------------------------------------ päivänäkymä

const task = (over = {}) => normalizeTask({
  id: 't1', title: 'Tehtävä', date: '2026-09-28', priority: 'normaali', ...over
});

test('päivänäkymä: aikajärjestys, koko päivän tapahtumat erikseen, ajattomat omana listanaan', () => {
  const occurrences = expandEventOccurrences({
    events: [
      event({ id: 'e1', title: 'Hammaslääkäri', startTime: '10:00', durationMinutes: 60 }),
      event({ id: 'e2', title: 'Mökkiviikonloppu', startTime: null, durationMinutes: null }),
      event({ id: 'e3', title: 'Sähly', date: '2026-09-27', startTime: '23:00', endTime: '01:00' })
    ],
    ...agendaRange('2026-09-28')
  });
  const routines = [normalizeRoutine({ id: 'r1', title: 'Venyttely', preferredTime: '07:30',
    durationMinutes: 15, recurrence: { type: RECURRENCE.DAILY } }),
  normalizeRoutine({ id: 'r2', title: 'Lukeminen', durationMinutes: 20, recurrence: { type: RECURRENCE.DAILY } })];
  const routineOccurrences = expandRoutines({ routines, from: '2026-09-28', to: '2026-09-28' });

  const agenda = dayAgenda({
    date: '2026-09-28',
    occurrences,
    tasks: [
      task({ id: 't1', title: 'Palaveri', time: '09:00', endTime: '09:30' }),
      task({ id: 't2', title: 'Siivous' }),
      task({ id: 't3', title: 'Valmis', completed: true }),
      task({ id: 'muu', title: 'Toinen päivä', date: '2026-09-29', time: '08:00' })
    ],
    routineOccurrences,
    todayIso: '2026-09-28'
  });

  assert.equal(agenda.valid, true);
  assert.equal(agenda.label, 'maanantai 28.9.2026');
  assert.equal(agenda.isToday, true);
  assert.deepEqual(agenda.entries.map(e => `${e.kind}:${e.time}`),
    ['event:00:00', 'routine:07:30', 'task:09:00', 'event:10:00']);
  const tail = agenda.entries[0];
  assert.equal(tail.continuation, true, 'edellisenä iltana alkanut Sähly jatkuu aamulla');
  assert.equal(tail.endTime, '01:00');
  assert.equal(tail.movable, false);
  assert.equal(agenda.entries.find(e => e.kind === 'task').movable, false, 'käyttäjän oma aika on lukittu');
  assert.deepEqual(agenda.allDay.map(o => o.title), ['Mökkiviikonloppu']);
  assert.deepEqual(agenda.untimed.map(u => u.title), ['Lukeminen', 'Siivous', 'Valmis']);
  assert.deepEqual({ ...agenda.counts }, {
    events: 2, allDay: 1, timedEvents: 1, continuing: 1, tasks: 3, openTasks: 2, routines: 2, blocks: 0
  });
  assert.equal(agenda.summary, '2 tapahtumaa · edellisen päivän tapahtuma jatkuu · 3 tehtävää · 2 rutiinia');
  assert.equal(agenda.empty, false);
  assert.ok(Object.isFrozen(agenda) && Object.isFrozen(agenda.entries) && agenda.entries.every(Object.isFrozen));
});

test('päivänäkymä: varattu aika on unioni, ei summa', () => {
  const occurrences = expandEventOccurrences({
    events: [event({ startTime: '10:00', durationMinutes: 60 })], from: '2026-09-28', to: '2026-09-28'
  });
  const agenda = dayAgenda({
    date: '2026-09-28',
    occurrences,
    tasks: [task({ time: '10:30', endTime: '11:30' }), task({ id: 't2', time: '15:00', endTime: '15:30', completed: true })]
  });
  assert.equal(agenda.busyMinutes, 90, '10:00–11:30; valmis tehtävä ei varaa');
});

test('päivänäkymä: tyhjä päivä ja kelvoton päivä', () => {
  const empty = dayAgenda({ date: '2026-09-28', todayIso: '2026-09-30' });
  assert.equal(empty.empty, true);
  assert.equal(empty.summary, 'Ei merkintöjä');
  assert.equal(empty.isPast, true);

  for (const date of [null, undefined, 'roska', '2026-02-30', 5]) {
    const agenda = dayAgenda({ date, occurrences: [null, 'x'], tasks: 'x', blocks: 5 });
    assert.equal(agenda.valid, false);
    assert.deepEqual(agenda.entries, []);
  }
  assert.doesNotThrow(() => dayAgenda());
});

test('päivänäkymä ei kaadu roskaan eikä muuta syötettä', () => {
  const hostile = new Proxy({}, { get() { throw new Error('ansa'); } });
  const tasks = deepFreeze([task({ time: '09:00', endTime: '10:00' }), task({ id: 't2' })]);
  const snapshot = JSON.stringify(tasks);
  const agenda = dayAgenda({
    date: '2026-09-28',
    occurrences: [hostile, null, { isEvent: true, date: '2026-09-28', id: 'x', time: 1234 }],
    tasks: [...tasks, hostile, null, { date: '2026-09-28', id: 'bad', time: '10:00', endTime: 99 }],
    routineOccurrences: [hostile, { date: '2026-09-28' }],
    blocks: [hostile, { kind: 'sleep', date: '2026-09-28', time: 'x', id: 'b' }]
  });
  assert.equal(agenda.valid, true);
  assert.equal(JSON.stringify(tasks), snapshot);
  assert.ok(agenda.entries.some(e => e.id === 't1'));
});

// ------------------------------------------------------------ viikkonäkymä

test('viikkonäkymä: maanantaista sunnuntaihin, ISO-viikko, otsikko ja summat', () => {
  const occurrences = expandEventOccurrences({
    events: [event({ date: '2026-09-29', recurrenceWeekdays: [2, 4], startTime: '18:00', durationMinutes: 90 })],
    ...weekRange('2026-10-01')
  });
  const week = weekModel({
    weekStart: '2026-10-01', // torstai -> tasataan maanantaihin
    occurrences,
    tasks: [task({ date: '2026-10-04' }), task({ id: 't2', date: '2026-10-05' })],
    todayIso: '2026-09-30'
  });
  assert.equal(week.valid, true);
  assert.equal(week.weekStart, '2026-09-28');
  assert.equal(week.weekEnd, '2026-10-04');
  assert.equal(week.isoWeek, 40);
  assert.equal(week.label, 'Viikko 40 · 28.9.–4.10.2026');
  assert.deepEqual(week.days.map(d => d.date),
    ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04']);
  assert.deepEqual(week.days.map(d => d.counts.events), [0, 1, 0, 1, 0, 0, 0]);
  assert.equal(week.totals.events, 2);
  assert.equal(week.totals.tasks, 1, 'seuraavan viikon tehtävä ei kuulu tähän viikkoon');
  assert.equal(week.containsToday, true);
  assert.equal(week.days[2].isToday, true);
  assert.equal(week.previousWeekStart, '2026-09-21');
  assert.equal(week.nextWeekStart, '2026-10-05');
});

test('viikkonäkymä vuodenvaihteessa: viikko 53 ja kahden vuoden otsikko', () => {
  const week = weekModel({ weekStart: '2027-01-02' });
  assert.equal(week.weekStart, '2026-12-28');
  assert.equal(week.isoWeek, 53);
  assert.equal(week.isoWeekYear, 2026);
  assert.equal(week.label, 'Viikko 53 · 28.12.2026–3.1.2027');
  assert.equal(weekModel({ weekStart: 'roska' }).valid, false);
  assert.doesNotThrow(() => weekModel());
});

// ------------------------------------------------------------ kuukausinäkymä

test('kuukausiruudukko: syyskuu 2026 on viisi ISO-viikkoa maanantaista', () => {
  const occurrences = expandEventOccurrences({
    events: [
      event({ id: 'e1', date: '2026-09-28' }),
      event({ id: 'e2', date: '2026-09-28', startTime: null, title: 'Nimipäivä' }),
      event({ id: 'e3', date: '2026-08-31', title: 'Elokuun viimeinen' }),
      event({ id: 'e4', date: '2026-10-04', title: 'Lokakuun puolella' })
    ],
    ...monthGridRange('2026-09')
  });
  const grid = monthGrid({
    month: '2026-09',
    occurrences,
    tasks: [task({ date: '2026-09-15' }), task({ id: 't2', date: '2026-09-15', completed: true })],
    todayIso: '2026-09-26'
  });

  assert.equal(grid.valid, true);
  assert.equal(grid.label, 'syyskuu 2026');
  assert.deepEqual([...grid.weekdayLabels], ['ma', 'ti', 'ke', 'to', 'pe', 'la', 'su']);
  assert.equal(grid.rows.length, 5);
  assert.equal(grid.gridStart, '2026-08-31');
  assert.equal(grid.gridEnd, '2026-10-04');
  assert.deepEqual(grid.rows.map(r => r.isoWeek), [36, 37, 38, 39, 40]);

  const first = grid.rows[0].days[0];
  assert.equal(first.date, '2026-08-31');
  assert.equal(first.outsideMonth, true);
  assert.equal(first.counts.events, 1, 'kuukauden ulkopuolinenkin päivä näyttää omat merkintänsä');

  const cell = grid.rows[4].days[0];
  assert.equal(cell.date, '2026-09-28');
  assert.equal(cell.inMonth, true);
  assert.deepEqual({ ...cell.counts }, { events: 2, allDay: 1, timed: 1, tasks: 0, openTasks: 0, total: 2 });
  assert.equal(cell.hasAllDay, true);
  assert.equal(cell.label, 'maanantai 28. syyskuuta 2026: 2 tapahtumaa');

  const today = grid.rows.flatMap(r => r.days).find(d => d.isToday);
  assert.equal(today.date, '2026-09-26');
  assert.equal(today.isWeekend, true);

  const fifteenth = grid.rows.flatMap(r => r.days).find(d => d.date === '2026-09-15');
  assert.equal(fifteenth.counts.tasks, 2);
  assert.equal(fifteenth.counts.openTasks, 1);

  assert.deepEqual({ ...grid.totals }, { events: 2, allDay: 1, tasks: 2, openTasks: 1 },
    'summat vain kuukauden omista päivistä');
  assert.equal(grid.previousMonth, '2026-08');
  assert.equal(grid.nextMonth, '2026-10');
  assert.ok(Object.isFrozen(grid) && Object.isFrozen(grid.rows[0].days[0]));
});

test('kuukausiruudukko: 4–6 riviä, jokainen päivä kerran, viikonpäivä pysyy sarakkeessa', () => {
  // Helmikuu 2021 alkaa maanantaina ja on 28 päivää: neljä riviä.
  assert.equal(monthGrid({ month: '2021-02' }).rows.length, 4);
  // Maaliskuu 2026 alkaa sunnuntaina ja on 31 päivää: kuusi riviä.
  assert.equal(monthGrid({ month: '2026-03' }).rows.length, 6);

  for (let year = 2020; year <= 2030; year++) {
    for (let month = 1; month <= 12; month++) {
      const key = `${year}-${pad(month)}`;
      const grid = monthGrid({ month: key });
      assert.ok(grid.rows.length >= 4 && grid.rows.length <= MAX_MONTH_ROWS, key);
      const days = grid.rows.flatMap(r => r.days);
      for (const row of grid.rows) {
        assert.equal(row.days.length, 7);
        row.days.forEach((d, i) => assert.equal(isoWeekdayOf(d.date), i + 1, `${key} ${d.date}`));
      }
      const inMonth = days.filter(d => d.inMonth).map(d => d.date);
      assert.equal(inMonth[0], `${key}-01`);
      assert.equal(new Set(inMonth).size, inMonth.length);
      assert.equal(addDaysToIso(inMonth.at(-1), 1).slice(0, 7), shiftMonth(key, 1), `${key} viimeinen päivä`);
      assert.ok(days.every(d => d.outsideMonth === !d.inMonth));
      // Ruudukko on yhtenäinen: päivä päivältä ilman aukkoja.
      for (let i = 1; i < days.length; i++) assert.equal(days[i].date, addDaysToIso(days[i - 1].date, 1));
    }
  }
});

test('kuukausiruudukko: vuodenvaihde ja kelvoton kuukausi', () => {
  const december = monthGrid({ month: '2026-12' });
  assert.equal(december.nextMonth, '2027-01');
  assert.equal(december.gridEnd, '2027-01-03');
  assert.equal(december.rows.at(-1).isoWeek, 53);
  const january = monthGrid({ month: '2027-01' });
  assert.equal(january.previousMonth, '2026-12');
  assert.equal(january.gridStart, '2026-12-28');

  for (const month of [null, undefined, '2026-13', '2026-9', 'syyskuu', 202609, {}]) {
    const grid = monthGrid({ month, occurrences: 'x', tasks: null });
    assert.equal(grid.valid, false);
    assert.deepEqual(grid.rows, []);
  }
  assert.doesNotThrow(() => monthGrid());
  assert.equal(monthGridRange('x'), null);
});

test('KRIITTINEN: kuukausiruudukko kasvaa lineaarisesti esiintymien ja tehtävien mukaan', () => {
  const reads = count => {
    const occurrences = expandEventOccurrences({
      events: Array.from({ length: count }, (_, i) => event({
        id: `e${i}`, date: `2026-09-${pad(1 + (i % 30))}`
      })),
      ...monthGridRange('2026-09')
    }).map(counting);
    const tasks = Array.from({ length: count }, (_, i) =>
      counting(task({ id: `t${i}`, date: `2026-09-${pad(1 + (i % 30))}` })));
    counting.total = 0;
    monthGrid({ month: '2026-09', occurrences, tasks });
    weekModel({ weekStart: '2026-09-14', occurrences, tasks });
    return counting.total;
  };
  const small = reads(300);
  const large = reads(600);
  assert.ok(small > 0);
  assert.ok(large / small < 2.8, `kasvu ${(large / small).toFixed(2)}× näyttää neliölliseltä`);
});

// ------------------------------------------------------------ puhtaus

test('PUHTAUS: kalenterimoduulit eivät lue kelloa, arvo, koske DOM:iin eikä verkkoon', () => {
  const forbidden = ['Date.now(', 'Math.random', 'crypto.randomUUID', 'performance.now',
    'document.', 'window.', 'localStorage', 'fetch(', 'console.'];
  for (const file of ['src/domain/calendar.js', 'src/domain/calendarBlocks.js', 'src/domain/scheduler.js',
    'src/domain/capacity.js', 'src/domain/conflicts.js', 'src/domain/replan.js']) {
    const source = readCode(file);
    for (const pattern of forbidden) {
      assert.equal(source.includes(pattern), false, `${file} sisältää "${pattern}"`);
    }
    assert.equal(/new Date\(\s*\)/.test(source), false, `${file}: new Date()`);
  }
});

test('KRIITTINEN: käynnistyksessä ladattavat moottorit eivät importoi kalenterimoduuleja', () => {
  // scheduler/capacity/conflicts/replan ladataan sovelluksen käynnistyksessä,
  // joten niiden importit kuuluisivat sovelluskuoreen (sw.js SHELL, pwa-testi).
  // Kalenteri kytketään käyttöliittymään omana vaiheenaan; siihen asti
  // moottorit tuntevat vain olioiden muodon.
  for (const file of ['src/domain/scheduler.js', 'src/domain/capacity.js',
    'src/domain/conflicts.js', 'src/domain/replan.js', 'src/domain/planScheduler.js']) {
    const source = readCode(file);
    for (const target of ['./calendar.js', './calendarBlocks.js', './dailyLife.js']) {
      assert.equal(source.includes(`from '${target}'`), false, `${file} importoi ${target}`);
    }
  }
});
