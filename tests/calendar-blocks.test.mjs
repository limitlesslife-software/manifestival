// Suojatut lohkot: lähtö (valmistautuminen, matka, pysäköinti, varmuusaika)
// sekä uni ja rauhoittuminen.
//
// Lukitsee src/domain/calendarBlocks.js:n lupaukset:
//   - lähtölohkot tulevat vain tiedetystä lähdöstä; tuntematon matka ei
//     tuota yhtään lohkoa (tuntematon ei ole nolla)
//   - epäjohdonmukaiset tai roskaluvut hylätään kokonaan: väärään kohtaan
//     varattu matka olisi pahempi kuin rehellinen "ei tiedossa"
//   - keskiyön ylittävä lohko pilkotaan päiväkohtaisiksi paloiksi
//     (myös kuukauden ja vuoden vaihteessa)
//   - uni on [nukkumaanmeno, herätys), rauhoittuminen sitä ennen
//   - kesäajan vaihto ei siirrä seinäkelloaikaa
//   - tunnisteet 'block:<laji>:<lähde>:<päivä>', haku päivältä O(1)

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  eventBlocks, sleepBlocks, deriveBlocks, blocksOn, indexBlocks, splitAtMidnight,
  BLOCK_KIND, BLOCK_KINDS, PRESENCE_BLOCK_KINDS, REST_BLOCK_KINDS, MAX_DEPARTURE_SPAN_MINUTES,
  blockKindLabel
} from '../src/domain/calendarBlocks.js';
import { expandEventOccurrences, absoluteMinutesOf } from '../src/domain/calendar.js';
import { departureSchedule } from '../src/domain/travel.js';
import { toMinutes, durationOf } from '../src/domain/task.js';
import { DEFAULT_WIND_DOWN_MINUTES, MAX_WIND_DOWN_MINUTES } from '../src/domain/dailyLife.js';
import { departureForOccurrence, departureBlockInput } from '../src/app/calendarPlan.js';
import { helsinkiOffset } from './helpers/helsinkiOffset.mjs';

// ------------------------------------------------------------------ apurit

const occurrencesOf = (events, from, to) => expandEventOccurrences({
  events: events.map((over, i) => ({
    id: `e${i + 1}`, title: `Tapahtuma ${i + 1}`, date: '2026-09-28', startTime: '10:00',
    durationMinutes: 60, recurrenceWeekdays: [], skipDates: [], ...over
  })),
  from, to
});

/** Lähtöluvut taaksepäin tapahtuman alusta, kuten DESIGN.md:n lähtömatematiikka. */
function departure({ date, time, travel = 30, overhead = 5, early = 10, prep = 15 }) {
  const startAbs = absoluteMinutesOf(date, toMinutes(time));
  const leaveAbs = startAbs - early - overhead - travel;
  return {
    known: true, startAbs, leaveAbs, prepareStartAbs: leaveAbs - prep,
    travelMinutes: travel, overheadMinutes: overhead, earlyMinutes: early
  };
}

const departureWith = params => occurrence =>
  departure({ date: occurrence.date, time: occurrence.time, ...params });

const summary = blocks => blocks.map(b => `${b.kind} ${b.date} ${b.time}-${b.endTime ?? '24h'}`);

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

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

// ------------------------------------------------------------ lajit

test('lohkojen lajit ja luokat', () => {
  // Suojattu aika (0015): oma aika, vapaa-aika ja loma ovat lohkoja kuten uni.
  assert.deepEqual([...BLOCK_KINDS],
    ['preparation', 'travel', 'overhead', 'arrival_buffer', 'wind_down', 'sleep', 'own_time', 'free_time', 'vacation']);
  assert.deepEqual([...PRESENCE_BLOCK_KINDS], ['preparation', 'travel', 'overhead', 'arrival_buffer']);
  assert.deepEqual([...REST_BLOCK_KINDS], ['wind_down', 'sleep']);
  assert.equal(blockKindLabel(BLOCK_KIND.ARRIVAL_BUFFER), 'Ajoissa perillä');
  assert.equal(blockKindLabel('tuntematon'), 'Varattu');
  assert.equal(MAX_DEPARTURE_SPAN_MINUTES, 480 + 1440 + 240 + 240);
});

// ------------------------------------------------------------ pilkonta

test('keskiyön pilkonta: päivän sisäinen, keskiyöhön päättyvä, yön yli, vuorokausi', () => {
  const day = absoluteMinutesOf('2026-09-28', 0);
  assert.deepEqual(splitAtMidnight(day + 600, day + 660).map(p => [p.date, p.startMinute, p.endMinute]),
    [['2026-09-28', 600, 660]]);
  assert.deepEqual(splitAtMidnight(day + 1380, day + 1440).map(p => [p.date, p.startMinute, p.endMinute]),
    [['2026-09-28', 1380, 1440]], 'keskiyöhön päättyvä ei tuota tyhjää palaa seuraavalle päivälle');
  assert.deepEqual(splitAtMidnight(day + 1380, day + 1860).map(p => [p.date, p.startMinute, p.endMinute]),
    [['2026-09-28', 1380, 1440], ['2026-09-29', 0, 420]]);
  assert.deepEqual(splitAtMidnight(day, day + 1440).map(p => [p.date, p.startMinute, p.endMinute]),
    [['2026-09-28', 0, 1440]]);
  assert.deepEqual(splitAtMidnight(day + 100, day + 100), []);
  assert.deepEqual(splitAtMidnight(day + 100, day + 50), []);
  assert.deepEqual(splitAtMidnight(day, day + 4 * 1440), [], 'yli kolmen vuorokauden väli on virhe');
  assert.deepEqual(splitAtMidnight(1.5, 3), []);
  assert.deepEqual(splitAtMidnight(NaN, 10), []);
});

// ------------------------------------------------------------ lähtölohkot

test('lähtölohkot: valmistautuminen, matka, pysäköinti ja varmuusaika tapahtuman alkuun', () => {
  const occurrences = occurrencesOf([{ title: 'Hammaslääkäri' }], '2026-09-28', '2026-09-28');
  const blocks = eventBlocks({ occurrences, departureFor: departureWith({}) });

  assert.deepEqual(summary(blocks), [
    'preparation 2026-09-28 09:00-09:15',
    'travel 2026-09-28 09:15-09:45',
    'overhead 2026-09-28 09:45-09:50',
    'arrival_buffer 2026-09-28 09:50-10:00'
  ]);
  const travel = blocks.find(b => b.kind === BLOCK_KIND.TRAVEL);
  assert.equal(travel.id, 'block:travel:event:e1:2026-09-28:2026-09-28');
  assert.equal(travel.sourceId, 'event:e1:2026-09-28');
  assert.equal(travel.occurrenceId, 'event:e1:2026-09-28');
  assert.equal(travel.eventId, 'e1');
  assert.equal(travel.sourceTitle, 'Hammaslääkäri');
  assert.equal(travel.title, 'Matka · Hammaslääkäri');
  assert.equal(travel.block, true);
  assert.equal(travel.protected, true);
  assert.equal(travel.durationMinutes, 30);
  assert.equal(durationOf(travel), 30, 'aikataulumoottori lukee saman keston');
  assert.equal(travel.explanation, 'Lähde klo 09:15. Matka kestää noin 30 min.');
  assert.match(blocks[0].explanation, /klo 09:00–09:15.*"Hammaslääkäri" klo 10:00/);
  assert.match(blocks[3].explanation, /10 min ennen alkua klo 10:00/);
  assert.ok(Object.isFrozen(blocks) && blocks.every(Object.isFrozen));
});

test('nollan mittainen osa ei tuota lohkoa', () => {
  const occurrences = occurrencesOf([{}], '2026-09-28', '2026-09-28');
  const blocks = eventBlocks({
    occurrences, departureFor: departureWith({ prep: 0, overhead: 0, early: 0, travel: 20 })
  });
  assert.deepEqual(summary(blocks), ['travel 2026-09-28 09:40-10:00']);

  const nothing = eventBlocks({
    occurrences, departureFor: departureWith({ prep: 0, overhead: 0, early: 0, travel: 0 })
  });
  assert.deepEqual(nothing, [], 'matka 0 min ja ei muuta: ei varattavaa');
});

test('KRIITTINEN: tuntematon lähtö ei tuota yhtään lohkoa', () => {
  const occurrences = occurrencesOf([{}, { date: '2026-09-29' }], '2026-09-28', '2026-09-29');
  const cases = [
    () => ({ known: false }),
    () => ({ known: false, leaveAbs: 1, prepareStartAbs: 0, startAbs: 2, travelMinutes: 1 }),
    () => null,
    () => undefined,
    () => 'tiedossa',
    () => { throw new Error('liikennetieto ei vastaa'); }
  ];
  for (const departureFor of cases) {
    assert.deepEqual(eventBlocks({ occurrences, departureFor }), []);
  }
  for (const departureFor of [null, undefined, 'x', {}, 5]) {
    assert.deepEqual(eventBlocks({ occurrences, departureFor }), []);
  }
});

test('epäjohdonmukaiset lähtöluvut hylätään kokonaan', () => {
  const occurrences = occurrencesOf([{}], '2026-09-28', '2026-09-28');
  const good = departure({ date: '2026-09-28', time: '10:00' });
  const bad = [
    { ...good, startAbs: good.startAbs + 1440 },          // toisen päivän luvut
    { ...good, leaveAbs: good.startAbs + 5 },              // lähtö alun jälkeen
    { ...good, prepareStartAbs: good.leaveAbs + 5 },       // valmistautuminen lähdön jälkeen
    { ...good, travelMinutes: null },                      // "tiedossa" ilman matka-aikaa
    { ...good, travelMinutes: -5 },
    { ...good, travelMinutes: 1441 },
    { ...good, travelMinutes: '30' },
    { ...good, overheadMinutes: 'x' },
    { ...good, overheadMinutes: 241 },
    { ...good, earlyMinutes: -1 },
    { ...good, leaveAbs: NaN },
    { ...good, prepareStartAbs: Infinity },
    { ...good, startAbs: undefined },
    { ...good, prepareStartAbs: good.startAbs - MAX_DEPARTURE_SPAN_MINUTES - 1 }
  ];
  for (const raw of bad) {
    assert.deepEqual(eventBlocks({ occurrences, departureFor: () => raw }), [], JSON.stringify(raw));
  }
  // Puuttuva pysäköinti ja varmuusaika ovat "ei varattavaa", eivät virhe.
  const partial = eventBlocks({
    occurrences,
    departureFor: () => ({ ...good, overheadMinutes: null, earlyMinutes: undefined })
  });
  assert.ok(partial.some(b => b.kind === BLOCK_KIND.TRAVEL));
});

test('lähtö, joka ei mahdu alkuun, leikataan tapahtuman alkuun', () => {
  // Lähtö 20 min ennen alkua, mutta matka 30 min: matka varataan alkuun
  // asti, eikä pysäköinti tai varmuusaika mene tapahtuman päälle.
  const occurrences = occurrencesOf([{}], '2026-09-28', '2026-09-28');
  const startAbs = absoluteMinutesOf('2026-09-28', 600);
  const blocks = eventBlocks({
    occurrences,
    departureFor: () => ({
      known: true, startAbs, leaveAbs: startAbs - 20, prepareStartAbs: startAbs - 30,
      travelMinutes: 30, overheadMinutes: 5, earlyMinutes: 10
    })
  });
  assert.deepEqual(summary(blocks), ['preparation 2026-09-28 09:30-09:40', 'travel 2026-09-28 09:40-10:00']);
  assert.ok(blocks.every(b => b.endAbs <= startAbs));
});

test('lähtö keskiyön ja vuodenvaihteen yli pilkotaan päiville', () => {
  const occurrences = occurrencesOf([{ date: '2027-01-01', startTime: '00:30' }], '2027-01-01', '2027-01-01');
  const blocks = eventBlocks({
    occurrences, departureFor: departureWith({ travel: 45, prep: 20, overhead: 0, early: 10 })
  });
  assert.deepEqual(summary(blocks), [
    'preparation 2026-12-31 23:15-23:35',
    'travel 2026-12-31 23:35-00:00',
    'travel 2027-01-01 00:00-00:20',
    'arrival_buffer 2027-01-01 00:20-00:30'
  ]);
  const [evening, morning] = blocks.filter(b => b.kind === BLOCK_KIND.TRAVEL);
  assert.equal(evening.id, 'block:travel:event:e1:2027-01-01:2026-12-31');
  assert.equal(morning.id, 'block:travel:event:e1:2027-01-01:2027-01-01');
  assert.deepEqual([evening.part, evening.parts, evening.continuesToNextDay], [1, 2, true]);
  assert.deepEqual([morning.part, morning.continuesFromPreviousDay], [2, true]);
  assert.equal(evening.spanStartAbs, morning.spanStartAbs);
  assert.equal(evening.durationMinutes + morning.durationMinutes, 45);
  assert.equal(durationOf(evening), 25, "keskiyöhön päättyvä pala: 23:35–00:00");
});

test('koko päivän tapahtumalle tai jatko-osalle ei kysytä lähtöä', () => {
  const asked = [];
  const occurrences = occurrencesOf([
    { startTime: null },
    { date: '2026-09-27', startTime: '23:00', endTime: '01:00' }
  ], '2026-09-27', '2026-09-28');
  eventBlocks({
    occurrences: [...occurrences, { ...occurrences[0], isEvent: true, continuation: true, id: 'x:jatkuu', time: '00:00' }],
    departureFor: occurrence => { asked.push(occurrence.id); return { known: false }; }
  });
  assert.deepEqual(asked, ['event:e2:2026-09-27'], 'vain ajallinen, varsinainen esiintymä');
});

test('lähtö on samaa asteikkoa kuin travel.js departureSchedule', () => {
  // Lähtömoottori voi rakentaa luvut travel.js:n päälle: saapumistavoite =
  // alku − varmuusaika, ja travel.js:n arrivalBuffer on pysäköinti ja kävely.
  const occurrences = occurrencesOf([{ date: '2026-03-29', startTime: '00:40' }], '2026-03-29', '2026-03-29');
  const departureFor = occurrence => {
    const early = 10;
    const schedule = departureSchedule({
      arrivalDate: occurrence.date, arrivalTime: '00:30', travelMinutes: 40,
      arrivalBufferMinutes: 5, preparationMinutes: 15, travelSource: 'manual'
    }, { todayIso: occurrence.date });
    return {
      known: schedule.known, startAbs: schedule.arrive.abs + early, leaveAbs: schedule.leave.abs,
      prepareStartAbs: schedule.prepare.abs, travelMinutes: 40, overheadMinutes: 5, earlyMinutes: early
    };
  };
  assert.deepEqual(summary(eventBlocks({ occurrences, departureFor })), [
    'preparation 2026-03-28 23:30-23:45',
    'travel 2026-03-28 23:45-00:00',
    'travel 2026-03-29 00:00-00:25',
    'overhead 2026-03-29 00:25-00:30',
    'arrival_buffer 2026-03-29 00:30-00:40'
  ]);
});

// ------------------------------------------------------------ uni

test('uni ja rauhoittuminen: ilta ja seuraava aamu', () => {
  const blocks = sleepBlocks({ schedules: [{ date: '2026-09-28', bedtime: '23:00', wakeTime: '07:00', windDownMinutes: 45 }] });
  assert.deepEqual(summary(blocks), [
    'wind_down 2026-09-28 22:15-23:00',
    'sleep 2026-09-28 23:00-00:00',
    'sleep 2026-09-29 00:00-07:00'
  ]);
  const [windDown, evening, morning] = blocks;
  assert.equal(evening.id, 'block:sleep:night:2026-09-28:2026-09-28');
  assert.equal(morning.id, 'block:sleep:night:2026-09-28:2026-09-29');
  assert.equal(windDown.id, 'block:wind_down:night:2026-09-28:2026-09-28');
  assert.equal(evening.durationMinutes + morning.durationMinutes, 480);
  assert.equal(durationOf(evening), 60);
  assert.equal(evening.category, 'hyvinvointi');
  assert.equal(evening.title, 'Uni');
  assert.match(evening.explanation, /Suojattu uni klo 23:00–07:00/);
  assert.equal(evening.eventId, null);
});

test('nukkumaanmeno keskiyön jälkeen kuuluu herätyspäivälle', () => {
  const blocks = sleepBlocks({ schedules: [{ date: '2026-09-28', bedtime: '00:30', wakeTime: '07:30', windDownMinutes: 30 }] });
  assert.deepEqual(summary(blocks), [
    'wind_down 2026-09-29 00:00-00:30',
    'sleep 2026-09-29 00:30-07:30'
  ]);
  const crossing = sleepBlocks({ schedules: [{ date: '2026-09-28', bedtime: '00:15', wakeTime: '07:00', windDownMinutes: 30 }] });
  assert.deepEqual(summary(crossing), [
    'wind_down 2026-09-28 23:45-00:00',
    'wind_down 2026-09-29 00:00-00:15',
    'sleep 2026-09-29 00:15-07:00'
  ], 'rauhoittuminen pilkotaan keskiyön kohdalta');
});

test('rauhoittumisen kesto: oletus, nolla, rajat ja roska', () => {
  const windDownOf = value => {
    const blocks = sleepBlocks({ schedules: [{ date: '2026-09-28', bedtime: '23:00', wakeTime: '07:00', windDownMinutes: value }] });
    const piece = blocks.find(b => b.kind === BLOCK_KIND.WIND_DOWN);
    return piece ? piece.durationMinutes : 0;
  };
  assert.equal(windDownOf(undefined), DEFAULT_WIND_DOWN_MINUTES);
  assert.equal(windDownOf(null), DEFAULT_WIND_DOWN_MINUTES);
  assert.equal(windDownOf('x'), DEFAULT_WIND_DOWN_MINUTES);
  assert.equal(windDownOf(NaN), DEFAULT_WIND_DOWN_MINUTES);
  assert.equal(windDownOf(0), 0, 'nolla on käyttäjän valinta: ei rauhoittumislohkoa');
  assert.equal(windDownOf(-20), 0);
  assert.equal(windDownOf(999), MAX_WIND_DOWN_MINUTES);
  assert.equal(windDownOf(12.4), 12);
});

test('kelvoton unisuunnitelma ei tuota lohkoja', () => {
  for (const schedule of [
    { date: '2026-09-28', bedtime: '23:00', wakeTime: '23:00' },
    { date: '2026-02-31', bedtime: '23:00', wakeTime: '07:00' },
    { date: '2026-09-28', bedtime: '24:00', wakeTime: '07:00' },
    { date: '2026-09-28', bedtime: '23:00' },
    { bedtime: '23:00', wakeTime: '07:00' },
    null, 'yö', 42
  ]) {
    assert.deepEqual(sleepBlocks({ schedules: [schedule] }), [], JSON.stringify(schedule));
  }
  assert.deepEqual(sleepBlocks({ schedules: 'x' }), []);
  assert.deepEqual(sleepBlocks(), []);
});

test('sama ilta kahdesti: valinta ei riipu järjestyksestä', () => {
  const a = { date: '2026-09-28', bedtime: '23:00', wakeTime: '07:00' };
  const b = { date: '2026-09-28', bedtime: '22:30', wakeTime: '06:30' };
  assert.deepEqual(sleepBlocks({ schedules: [a, b] }), sleepBlocks({ schedules: [b, a] }));
  assert.equal(new Set(sleepBlocks({ schedules: [a, b] }).map(x => x.id)).size, 3);
});

test('kesäajan vaihtoyöt: seinäkelloaika pysyy, lohkot pilkotaan keskiyöllä', () => {
  // 28.–29.3.2026 yö on todellisuudessa tunnin lyhyempi ja 24.–25.10. tunnin
  // pidempi. Kalenteri puhuu seinäkelloaikaa kuten task.durationOf; herätys
  // soi kellotaulun mukaan.
  for (const date of ['2026-03-28', '2026-10-24']) {
    const blocks = sleepBlocks({ schedules: [{ date, bedtime: '23:00', wakeTime: '07:00', windDownMinutes: 30 }] });
    const next = date === '2026-03-28' ? '2026-03-29' : '2026-10-25';
    assert.deepEqual(summary(blocks), [
      `wind_down ${date} 22:30-23:00`,
      `sleep ${date} 23:00-00:00`,
      `sleep ${next} 00:00-07:00`
    ]);
    assert.equal(blocks.at(-1).spanEndAbs - blocks.at(-1).spanStartAbs, 480);
  }
  // Tapahtuma olemattomaan hetkeen 03:30 (29.3.): lähtö lasketaan silti seinäkellosta.
  const occurrences = occurrencesOf([{ date: '2026-03-29', startTime: '04:00' }], '2026-03-29', '2026-03-29');
  assert.deepEqual(summary(eventBlocks({ occurrences, departureFor: departureWith({ travel: 20, prep: 10, overhead: 0, early: 0 }) })), [
    'preparation 2026-03-29 03:30-03:40',
    'travel 2026-03-29 03:40-04:00'
  ]);
});

test('KRIITTINEN: kesäaikaan siirtymisen yönä matkalohko ei keksi perilläolon varmuusaikaa', () => {
  // Lento 29.3. klo 4.30, matka 60 min, ei etuaikaa. Klo 3-4 ei ole olemassa:
  // lähtö 2.30 ja perillä 4.30 -- varmuusaikaa ei ole, vaikka seinäkello
  // antaisi matkan loppuvan 3.30.
  const events = [{ id: 'f', title: 'Lento', date: '2026-03-29', startTime: '04:30', durationMinutes: 60,
    travelMinutes: 60, preparationMinutes: 0, overheadMinutes: 0 }];
  const occurrences = expandEventOccurrences({ events, from: '2026-03-29', to: '2026-03-29' });
  const blocksWith = arrivalBufferMinutes => {
    const plan = departureForOccurrence(occurrences[0], { offsetMinutesFn: helsinkiOffset, settings: { arrivalBufferMinutes } });
    return eventBlocks({ occurrences, departureFor: () => departureBlockInput(plan, helsinkiOffset) });
  };
  const none = blocksWith(0);
  assert.deepEqual(summary(none), ['travel 2026-03-29 02:30-04:30']);
  assert.match(none[0].explanation, /Lähde klo 02:30\. Matka kestää noin 60 min\./);

  // 30 min etuaika: perillä 4.00, lähtö 2.00; varmuusaika on todelliset 30 min.
  const early = blocksWith(30);
  assert.deepEqual(summary(early), ['travel 2026-03-29 02:00-04:00', 'arrival_buffer 2026-03-29 04:00-04:30']);
  assert.match(early[1].explanation, /^Olet perillä 30 min ennen alkua klo 04:30\./);

  // Tavallisena yönä sama laskenta kuin ennenkin.
  const plain = expandEventOccurrences({ events: [{ ...events[0], date: '2026-03-22' }], from: '2026-03-22', to: '2026-03-22' });
  const plan = departureForOccurrence(plain[0], { offsetMinutesFn: helsinkiOffset, settings: { arrivalBufferMinutes: 30 } });
  assert.deepEqual(summary(eventBlocks({ occurrences: plain, departureFor: () => departureBlockInput(plan, helsinkiOffset) })),
    ['travel 2026-03-22 03:00-04:00', 'arrival_buffer 2026-03-22 04:00-04:30']);
});

test('lähtömoottorin seinäkellohetket: epäjohdonmukaiset hylätään, puuttuvat lasketaan seinäkellosta', () => {
  const occurrences = occurrencesOf([{}], '2026-09-28', '2026-09-28');
  const base = departureWith({})(occurrences[0]);
  const bad = eventBlocks({ occurrences, departureFor: () => ({ ...base, travelEndAbs: base.leaveAbs - 1 }) });
  assert.deepEqual(bad, [], 'matka ei voi loppua ennen lähtöä');
  const reversed = eventBlocks({ occurrences, departureFor: () => ({ ...base, arrivalAbs: base.startAbs + 5 }) });
  assert.deepEqual(reversed, [], 'perillä ei voi olla alun jälkeen');
  assert.deepEqual(summary(eventBlocks({ occurrences, departureFor: () => base })), [
    'preparation 2026-09-28 09:00-09:15', 'travel 2026-09-28 09:15-09:45',
    'overhead 2026-09-28 09:45-09:50', 'arrival_buffer 2026-09-28 09:50-10:00'
  ]);
});

// ------------------------------------------------------------ kokoava

test('deriveBlocks: yhdistää, järjestää ja jäädyttää; ei kahta samaa tunnistetta', () => {
  const occurrences = occurrencesOf([{}, { id: 'e2', startTime: '18:00' }], '2026-09-28', '2026-09-28');
  const blocks = deriveBlocks({
    occurrences,
    departureFor: departureWith({}),
    sleepSchedules: [
      { date: '2026-09-27', bedtime: '23:00', wakeTime: '07:00' },
      { date: '2026-09-28', bedtime: '23:00', wakeTime: '07:00' }
    ]
  });
  const ids = blocks.map(b => b.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(Object.isFrozen(blocks));
  for (let i = 1; i < blocks.length; i++) {
    const a = blocks[i - 1];
    const b = blocks[i];
    assert.ok(a.date < b.date || (a.date === b.date && a.startMinute <= b.startMinute), 'järjestys');
  }
  assert.deepEqual(summary(blocksOn(blocks, '2026-09-28')), [
    'sleep 2026-09-28 00:00-07:00',
    'preparation 2026-09-28 09:00-09:15',
    'travel 2026-09-28 09:15-09:45',
    'overhead 2026-09-28 09:45-09:50',
    'arrival_buffer 2026-09-28 09:50-10:00',
    'preparation 2026-09-28 17:00-17:15',
    'travel 2026-09-28 17:15-17:45',
    'overhead 2026-09-28 17:45-17:50',
    'arrival_buffer 2026-09-28 17:50-18:00',
    'wind_down 2026-09-28 22:30-23:00',
    'sleep 2026-09-28 23:00-00:00'
  ]);
  assert.deepEqual(blocksOn(blocks, '2026-12-24'), []);
  assert.deepEqual(blocksOn(blocks, 'roska'), []);
  assert.deepEqual(deriveBlocks(), []);
});

test('determinismi: sekoitettu syöte tuottaa saman lohkolistan', () => {
  const random = seeded(7);
  const occurrences = occurrencesOf(Array.from({ length: 30 }, (_, i) => ({
    id: `e${i}`, date: `2026-10-${String(1 + (i % 9)).padStart(2, '0')}`,
    startTime: `${String(6 + (i % 15)).padStart(2, '0')}:${i % 2 ? '15' : '45'}`
  })), '2026-10-01', '2026-10-09');
  const schedules = Array.from({ length: 9 }, (_, i) => ({
    date: `2026-10-${String(1 + i).padStart(2, '0')}`, bedtime: '23:00', wakeTime: '07:00'
  }));
  const reference = deriveBlocks({ occurrences, departureFor: departureWith({}), sleepSchedules: schedules });
  for (let round = 0; round < 5; round++) {
    assert.deepEqual(deriveBlocks({
      occurrences: shuffle(occurrences, random),
      departureFor: departureWith({}),
      sleepSchedules: shuffle(schedules, random)
    }), reference);
  }
});

test('syötettä ei muuteta', () => {
  const occurrences = occurrencesOf([{}], '2026-09-28', '2026-09-28');
  const schedules = deepFreeze([{ date: '2026-09-28', bedtime: '23:00', wakeTime: '07:00', windDownMinutes: 20 }]);
  const before = JSON.stringify({ occurrences, schedules });
  deriveBlocks({ occurrences, departureFor: departureWith({}), sleepSchedules: schedules });
  assert.equal(JSON.stringify({ occurrences, schedules }), before);
});

test('KRIITTINEN: päivähaku on O(1) jäädytetylle listalle', () => {
  // Indeksi rakennetaan ensimmäisellä haulla; sen jälkeen lohkojen kenttiä
  // ei lueta lainkaan, vaikka päiviä haettaisiin satoja.
  const blocks = sleepBlocks({ schedules: Array.from({ length: 60 }, (_, i) => ({
    date: `2026-${i < 30 ? '09' : '10'}-${String(1 + (i % 30)).padStart(2, '0')}`, bedtime: '23:00', wakeTime: '07:00'
  })) });
  const wrapped = Object.freeze(blocks.map(counting));

  counting.total = 0;
  // Edellisen yön aamupala, illan rauhoittuminen ja illan unipala.
  assert.equal(blocksOn(wrapped, '2026-09-10').length, 3);
  const firstCall = counting.total;
  assert.ok(firstCall > 0, 'indeksi rakennettiin lukemalla lohkot');

  counting.total = 0;
  for (let day = 1; day <= 30; day++) {
    for (let round = 0; round < 10; round++) blocksOn(wrapped, `2026-10-${String(day).padStart(2, '0')}`);
  }
  assert.equal(counting.total, 0, 'toistuva haku luki lohkoja: indeksiä ei käytetty');

  // Muuttuva lista indeksoidaan kerran kutsujan pyynnöstä.
  const mutable = [...blocks];
  const index = indexBlocks(mutable);
  assert.equal(blocksOn(index, '2026-10-05').length, 3);
});

test('roskasyöte ei kaada lohkojen johtamista', () => {
  const hostile = new Proxy({}, { get() { throw new Error('ansa'); } });
  const garbageOccurrences = [
    null, 1, 'x', hostile, {}, { isEvent: true }, { isEvent: true, id: 'a', date: '2026-09-28' },
    { isEvent: true, id: 'b', date: '2026-09-28', time: '99:00' },
    { isEvent: true, id: 'c', date: 'eilen', time: '10:00' },
    { source: 'event', id: 'd', date: '2026-09-28', time: '10:00', title: hostile }
  ];
  const garbageDepartures = [
    () => hostile,
    () => ({ known: true, startAbs: hostile }),
    () => ({ known: 'true' }),
    () => [1, 2, 3],
    occurrence => departure({ date: occurrence.date, time: occurrence.time })
  ];
  for (const departureFor of garbageDepartures) {
    for (const occurrences of [garbageOccurrences, null, 'x', {}, [hostile]]) {
      assert.doesNotThrow(() => deriveBlocks({ occurrences, departureFor, sleepSchedules: [hostile, null, {}] }));
    }
  }
  // 'd' on kelvollinen esiintymä, vaikka otsikko on ansa: lohkot syntyvät oletusotsikolla.
  const blocks = eventBlocks({ occurrences: garbageOccurrences, departureFor: garbageDepartures.at(-1) });
  assert.ok(blocks.length > 0);
  assert.ok(blocks.every(b => b.sourceTitle === 'Tapahtuma'));
  assert.doesNotThrow(() => blocksOn([hostile, null, 5], '2026-09-28'));
  assert.doesNotThrow(() => blocksOn(null, null));
});

test('KRIITTINEN: lohkojen johtaminen kasvaa lineaarisesti', () => {
  const reads = count => {
    const occurrences = occurrencesOf(Array.from({ length: count }, (_, i) => ({
      id: `e${i}`, date: `2026-10-${String(1 + (i % 28)).padStart(2, '0')}`,
      startTime: `${String(6 + (i % 15)).padStart(2, '0')}:00`
    })), '2026-10-01', '2026-10-28').map(counting);
    const schedules = Array.from({ length: count }, (_, i) => counting({
      date: `2026-10-${String(1 + (i % 28)).padStart(2, '0')}`, bedtime: '23:00', wakeTime: '07:00'
    }));
    counting.total = 0;
    deriveBlocks({ occurrences, departureFor: departureWith({}), sleepSchedules: schedules });
    return counting.total;
  };
  const small = reads(300);
  const large = reads(600);
  assert.ok(small > 0);
  assert.ok(large / small < 2.8, `kasvu ${(large / small).toFixed(2)}× näyttää neliölliseltä`);
});
