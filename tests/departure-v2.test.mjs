// Lähtömoottori v2: etuajassa olo, tarkat vaiheet, hystereesi, kesäajan yöt
// ja kalenterin tapahtuman lähtösuunnitelma (src/domain/departure.js).
//
// PERIAATE: lähtöaika on vähennyslasku taaksepäin saapumisesta, jokainen osa
// näkyy, tuntematon matka-aika ei tuota lähtöaikaa, eikä muistutuksen
// aikaistus koskaan siirrä näytettyä kelloa.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import { ROOT, read, readCode } from './helpers/sources.mjs';
import {
  normalizeTravelPlan, departureSchedule, departureState, leaveAtMinus, DEPARTURE_STATE,
  DEPARTURE_PHASE, DEPARTURE_PHASES, departurePhase, departurePhaseLabel, classifyDeparturePhase,
  PREPARE_SOON_MINUTES, LEAVE_IN_MINUTES, stabilizeLeave, leaveAbsOf,
  LEAVE_EARLIER_TOLERANCE_MINUTES, LEAVE_LATER_TOLERANCE_MINUTES,
  absoluteMinutes, fromAbsolute, minusMinutes, minutesBetween,
  TRAVEL_SOURCE, TRAVEL_SOURCES, hasTravelProvider
} from '../src/domain/travel.js';
import {
  planDeparture, selectTravelEstimate, recalcDecision, estimateSourceText, MIN_LEARNED_OBSERVATIONS
} from '../src/domain/departure.js';
import { ESTIMATE_SOURCE, DEFAULT_ARRIVAL_BUFFER_MINUTES } from '../src/domain/dailyLife.js';
import { helsinkiOffset } from './helpers/helsinkiOffset.mjs';

const TODAY = '2026-09-28';
const NOW_MS = Date.parse('2026-09-28T13:00:00Z');

/** Auto, 40 min matka, 5 min pysäköinti, ei valmistautumista: lähtö 17:15. */
function plan(overrides = {}) {
  return normalizeTravelPlan({
    id: 'p1', title: 'Hammaslääkäri', destination: 'Kallio', arrivalDate: TODAY, arrivalTime: '18:00',
    mode: 'driving', travelMinutes: 40, travelSource: TRAVEL_SOURCE.MANUAL,
    preparationMinutes: 0, arrivalBufferMinutes: 5, ...overrides
  });
}

const hm = hhmm => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
const phaseAt = (hhmm, base = plan(), extra = {}) =>
  departurePhase(base, { todayIso: TODAY, nowMinutes: hm(hhmm), ...extra }).phase;

// ======================================================= etuajassa olo

test('etuajassa olo on oletuksena 0: vanha aikataulu ei muutu', () => {
  const schedule = departureSchedule(plan({ preparationMinutes: 20 }), { todayIso: TODAY });
  assert.equal(schedule.parts.earlyArrival, 0);
  assert.equal(schedule.start.time, '18:00');
  assert.equal(schedule.arrive.time, '18:00');
  assert.equal(schedule.leave.time, '17:15');
  assert.equal(schedule.prepare.time, '16:55');
  assert.equal(Object.isFrozen(schedule.parts), true);
});

test('etuajassa olo: saapuminen = alku - 10, lähtö = saapuminen - pysäköinti - matka, valmistautuminen ennen', () => {
  const schedule = departureSchedule({ ...plan({ preparationMinutes: 15 }), earlyArrivalMinutes: 10 }, { todayIso: TODAY });
  assert.deepEqual([schedule.start.time, schedule.arrive.time, schedule.leave.time, schedule.prepare.time],
    ['18:00', '17:50', '17:05', '16:50']);
  assert.deepEqual({ ...schedule.parts }, { travel: 40, arrivalBuffer: 5, preparation: 15, earlyArrival: 10 });
});

test('kelvoton etuajassa olo on 0, ei arvausta eikä kaatumista', () => {
  for (const earlyArrivalMinutes of [null, undefined, -5, NaN, Infinity, {}, [], 'x']) {
    const schedule = departureSchedule({ ...plan(), earlyArrivalMinutes }, { todayIso: TODAY });
    assert.equal(schedule.parts.earlyArrival, 0, String(earlyArrivalMinutes));
    assert.equal(schedule.leave.time, '17:15');
  }
});

test('etuajassa olo keskiyön yli siirtää saapumisen edelliselle päivälle', () => {
  const schedule = departureSchedule({ ...plan({ arrivalTime: '00:10', travelMinutes: 30 }), earlyArrivalMinutes: 20 },
    { todayIso: TODAY });
  assert.deepEqual([schedule.arrive.date, schedule.arrive.time], ['2026-09-27', '23:50']);
  assert.deepEqual([schedule.leave.date, schedule.leave.time], ['2026-09-27', '23:15']);
});

test('etuajassa olo näkyy selityksessä, ja myöhästyminen sanotaan alun eikä tavoitteen mukaan', () => {
  const base = { ...plan(), earlyArrivalMinutes: 10 }; // lähtö 17:05, perillä 17:50, alku 18:00
  const late = departureState(base, { todayIso: TODAY, nowMinutes: hm('17:55') });
  assert.equal(late.state, DEPARTURE_STATE.LATE);
  assert.match(late.message, /^Olet 50 min myöhässä/, 'alku ei ole vielä mennyt');
  assert.match(late.detail, /perillä 10 min etuajassa/);
  const past = departureState(base, { todayIso: TODAY, nowMinutes: hm('18:01') });
  assert.match(past.message, /Saapumisaika klo 18:00 kohteeseen Kallio on jo mennyt/);
});

test('ilman etuajassa oloa tilat ovat täsmälleen samat kuin ennen (koko vuorokausi)', () => {
  const a = plan({ preparationMinutes: 25 });
  const b = { ...a, earlyArrivalMinutes: 0 };
  for (let minute = 0; minute < 1440; minute += 1) {
    const x = departureState(a, { todayIso: TODAY, nowMinutes: minute });
    const y = departureState(b, { todayIso: TODAY, nowMinutes: minute });
    assert.deepEqual([x.state, x.message, x.detail, x.minutesUntilLeave, x.minutesLate, x.minutesToArrival],
      [y.state, y.message, y.detail, y.minutesUntilLeave, y.minutesLate, y.minutesToArrival], String(minute));
  }
});

// ======================================================= vaiheet

test('DEPARTURE_PHASE: seitsemän vaihetta, DEPARTURE_STATE ennallaan', () => {
  assert.deepEqual([...DEPARTURE_PHASES],
    ['unknown_travel', 'not_yet', 'prepare_soon', 'prepare_now', 'leave_in_5', 'leave_now', 'late']);
  assert.equal(Object.isFrozen(DEPARTURE_PHASE), true);
  assert.deepEqual(Object.values(DEPARTURE_STATE), ['unknown', 'not_yet', 'prepare', 'leave_soon', 'leave_now', 'late']);
  assert.equal(PREPARE_SOON_MINUTES, 15);
  assert.equal(LEAVE_IN_MINUTES, 5);
});

test('vaiheet rajoilla: valmistautuminen 30 min, lähtö 17:15', () => {
  const p = plan({ preparationMinutes: 30 }); // valmistautuminen alkaa 16:45
  const expected = [
    ['16:29', DEPARTURE_PHASE.NOT_YET],
    ['16:30', DEPARTURE_PHASE.PREPARE_SOON],
    ['16:44', DEPARTURE_PHASE.PREPARE_SOON],
    ['16:45', DEPARTURE_PHASE.PREPARE_NOW],
    ['17:09', DEPARTURE_PHASE.PREPARE_NOW],
    ['17:10', DEPARTURE_PHASE.LEAVE_IN_5],
    ['17:14', DEPARTURE_PHASE.LEAVE_IN_5],
    ['17:15', DEPARTURE_PHASE.LEAVE_NOW],
    ['17:17', DEPARTURE_PHASE.LEAVE_NOW],
    ['17:18', DEPARTURE_PHASE.LATE],
    ['23:59', DEPARTURE_PHASE.LATE]
  ];
  for (const [time, phase] of expected) assert.equal(phaseAt(time, p), phase, time);
});

test('ilman valmistautumista PREPARE_NOW-vaihetta ei tule; PREPARE_SOON tarkoittaa lähdön lähestymistä', () => {
  assert.equal(phaseAt('16:59'), DEPARTURE_PHASE.NOT_YET);
  assert.equal(phaseAt('17:00'), DEPARTURE_PHASE.PREPARE_SOON);
  assert.equal(phaseAt('17:09'), DEPARTURE_PHASE.PREPARE_SOON);
  assert.equal(phaseAt('17:10'), DEPARTURE_PHASE.LEAVE_IN_5);
  for (let minute = 0; minute < 1440; minute += 1) {
    assert.notEqual(departurePhase(plan(), { todayIso: TODAY, nowMinutes: minute }).phase, DEPARTURE_PHASE.PREPARE_NOW);
  }
});

test('vaihe on johdettu tilasta: LATE, LEAVE_NOW ja UNKNOWN vastaavat täsmälleen joka minuutti', () => {
  for (const preparationMinutes of [0, 3, 10, 45]) {
    const p = plan({ preparationMinutes });
    for (let minute = 0; minute < 1440; minute += 1) {
      const { phase, departure } = departurePhase(p, { todayIso: TODAY, nowMinutes: minute });
      const state = departure.state;
      assert.equal(phase === DEPARTURE_PHASE.LATE, state === DEPARTURE_STATE.LATE, `${preparationMinutes}/${minute}`);
      assert.equal(phase === DEPARTURE_PHASE.LEAVE_NOW, state === DEPARTURE_STATE.LEAVE_NOW);
      if (phase === DEPARTURE_PHASE.LEAVE_IN_5) assert.equal(state, DEPARTURE_STATE.LEAVE_SOON);
      if (phase === DEPARTURE_PHASE.NOT_YET) assert.equal(state, DEPARTURE_STATE.NOT_YET);
      if (phase === DEPARTURE_PHASE.PREPARE_NOW) {
        assert.ok([DEPARTURE_STATE.PREPARE, DEPARTURE_STATE.LEAVE_SOON].includes(state), state);
      }
    }
  }
});

test('oma "pian"-ikkuna, ja kelvoton ikkuna palaa oletukseen', () => {
  const p = plan({ preparationMinutes: 30 });
  assert.equal(phaseAt('16:20', p, { prepareSoonMinutes: 30 }), DEPARTURE_PHASE.PREPARE_SOON);
  assert.equal(phaseAt('16:14', p, { prepareSoonMinutes: 30 }), DEPARTURE_PHASE.NOT_YET);
  for (const bad of [-1, NaN, 'x', null, {}]) {
    assert.equal(phaseAt('16:29', p, { prepareSoonMinutes: bad }), DEPARTURE_PHASE.NOT_YET, String(bad));
    assert.equal(phaseAt('16:30', p, { prepareSoonMinutes: bad }), DEPARTURE_PHASE.PREPARE_SOON, String(bad));
  }
});

test('tuntematon matka-aika tai nykyhetki: UNKNOWN_TRAVEL, ei minuutteja', () => {
  for (const [base, args] of [
    [plan({ travelMinutes: null }), { todayIso: TODAY, nowMinutes: 600 }],
    [{ ...plan(), travelMinutes: 0 }, { todayIso: TODAY, nowMinutes: 600 }],
    [plan(), { todayIso: TODAY, nowMinutes: NaN }],
    [plan(), { todayIso: 'eilen', nowMinutes: 600 }],
    [null, { todayIso: TODAY, nowMinutes: 600 }]
  ]) {
    const result = departurePhase(base, args);
    assert.equal(result.phase, DEPARTURE_PHASE.UNKNOWN_TRAVEL);
    assert.equal(result.known, false);
    assert.equal(result.minutesUntilLeave, null);
    assert.equal(result.minutesUntilPrepare, null);
    assert.equal(Object.isFrozen(result), true);
  }
  assert.match(departurePhase(plan({ travelMinutes: null }), { todayIso: TODAY, nowMinutes: 600 }).message,
    /Matka-aikaa ei tiedetä/);
  assert.equal(departurePhase(undefined).phase, DEPARTURE_PHASE.UNKNOWN_TRAVEL);
});

test('keskiyön yli: lähtö edellisenä iltana, vaihe oikein kummankin päivän kellosta', () => {
  const p = plan({ arrivalTime: '00:20', travelMinutes: 30 }); // lähtö 2026-09-27 23:45
  const at = (todayIso, hhmm) => departurePhase(p, { todayIso, nowMinutes: hm(hhmm) });
  assert.equal(at('2026-09-27', '23:40').phase, DEPARTURE_PHASE.LEAVE_IN_5);
  assert.equal(at('2026-09-27', '23:45').phase, DEPARTURE_PHASE.LEAVE_NOW);
  const next = at(TODAY, '00:00');
  assert.equal(next.phase, DEPARTURE_PHASE.LATE);
  assert.equal(next.minutesLate, 15);
  assert.equal(at('2026-09-27', '22:00').phase, DEPARTURE_PHASE.NOT_YET);
});

test('PREPARE_SOON kertoo valmistautumisen alun; minuutit ja nimike ovat mukana', () => {
  const result = departurePhase(plan({ preparationMinutes: 30 }), { todayIso: TODAY, nowMinutes: hm('16:35') });
  assert.equal(result.phase, DEPARTURE_PHASE.PREPARE_SOON);
  assert.match(result.message, /^Valmistautuminen alkaa klo 16:45 \(10 min kuluttua\)\. Lähde noin 17:15/);
  assert.equal(result.minutesUntilLeave, 40);
  assert.equal(result.minutesUntilPrepare, 10);
  assert.equal(result.label, 'Valmistautuminen pian');
  const now = departurePhase(plan(), { todayIso: TODAY, nowMinutes: hm('17:16') });
  assert.equal(now.minutesUntilLeave, 0);
  assert.equal(departurePhaseLabel('ei-tätä'), 'Matka-aika puuttuu');
  for (const phase of DEPARTURE_PHASES) assert.ok(departurePhaseLabel(phase).length > 0);
});

test('classifyDeparturePhase: kelvoton syöte on null, ei vaihetta', () => {
  assert.equal(classifyDeparturePhase(), null);
  assert.equal(classifyDeparturePhase({ minutesUntilLeave: NaN, minutesUntilPrepare: 1 }), null);
  assert.equal(classifyDeparturePhase({ minutesUntilLeave: 10, minutesUntilPrepare: 5 }), DEPARTURE_PHASE.PREPARE_SOON);
});

// ======================================================= hystereesi

test('stabilizeLeave: aikaisemmaksi vasta 5 min, myöhemmäksi vasta 10 min', () => {
  const base = absoluteMinutes(TODAY, hm('17:15'));
  const cases = [
    [-4, false, 'same'], [-5, true, 'earlier'], [-30, true, 'earlier'],
    [0, false, 'same'], [9, false, 'same'], [10, true, 'later'], [3, false, 'same']
  ];
  for (const [delta, changed, direction] of cases) {
    const result = stabilizeLeave(base, base + delta);
    assert.equal(result.changed, changed, String(delta));
    assert.equal(result.direction, direction, String(delta));
    assert.equal(result.deltaMinutes, delta);
    assert.equal(result.leave, changed ? base + delta : base);
    assert.equal(Object.isFrozen(result), true);
  }
  assert.equal(LEAVE_EARLIER_TOLERANCE_MINUTES, 5);
  assert.equal(LEAVE_LATER_TOLERANCE_MINUTES, 10);
});

test('stabilizeLeave: ensimmäinen laskenta, tuntemattomaksi muuttuminen ja muodot', () => {
  const next = { date: TODAY, time: '17:15' };
  assert.deepEqual({ ...stabilizeLeave(null, next) }, { leave: next, changed: true, direction: 'initial', deltaMinutes: null });
  assert.deepEqual({ ...stabilizeLeave(next, null) }, { leave: null, changed: true, direction: 'unknown', deltaMinutes: null });
  assert.equal(stabilizeLeave(null, null).changed, false);
  // Keskiyön yli: 00:02 -> edellisen päivän 23:55 on 7 min aikaisemmin.
  const crossed = stabilizeLeave({ date: TODAY, time: '00:02' }, { date: '2026-09-27', time: '23:55' });
  assert.deepEqual([crossed.direction, crossed.deltaMinutes], ['earlier', -7]);
  assert.equal(leaveAbsOf({ abs: 42 }), 42);
  assert.equal(leaveAbsOf({ date: TODAY, time: '25:00' }), null);
  for (const garbage of [undefined, 'x', NaN, Infinity, [], {}, { abs: 'x' }, () => 1]) {
    assert.equal(leaveAbsOf(garbage), null);
    assert.doesNotThrow(() => stabilizeLeave(garbage, garbage, garbage));
  }
});

test('stabilizeLeave: omat ja kelvottomat toleranssit; syötettä ei muuteta eikä jäädytetä', () => {
  const previous = { date: TODAY, time: '17:15' };
  const next = { date: TODAY, time: '17:13' };
  assert.equal(stabilizeLeave(previous, next, { earlierToleranceMinutes: 2 }).changed, true);
  assert.equal(stabilizeLeave(previous, next, { earlierToleranceMinutes: -1 }).changed, false, 'kelvoton -> 5');
  assert.equal(stabilizeLeave(previous, next, { earlierToleranceMinutes: 0 }).changed, true);
  assert.equal(stabilizeLeave(previous, { ...previous }, { earlierToleranceMinutes: 0, laterToleranceMinutes: 0 }).direction, 'same');
  assert.equal(Object.isFrozen(previous), false);
  assert.equal(Object.isFrozen(next), false);
  assert.deepEqual(previous, { date: TODAY, time: '17:15' });
});

test('hystereesi estää ilmoitusmyrskyn: heiluva liikennetieto ei siirrä lähtöä', () => {
  const base = absoluteMinutes(TODAY, hm('17:15'));
  const jitter = [0, 2, -3, 1, -4, 3, -2, 4, -1, 0, 2, -4, 3];
  let shown = null;
  let announcements = 0;
  for (const delta of jitter) {
    const result = stabilizeLeave(shown, base + delta);
    if (result.changed) announcements += 1;
    shown = result.leave;
  }
  assert.equal(announcements, 1, 'vain ensimmäinen laskenta');
  assert.equal(shown, base);
});

// ======================================================= seinäkello ja kesäaika

test('absoluteMinutes/fromAbsolute: edestakaisin karkauspäivän, kuun ja vuoden vaihteen yli', () => {
  for (const [date, time] of [['2028-02-29', '23:59'], ['2026-12-31', '23:30'], ['2027-01-01', '00:00'],
    ['2026-03-29', '03:30'], ['2026-10-25', '03:30'], ['1999-12-31', '12:00']]) {
    const abs = absoluteMinutes(date, hm(time));
    assert.deepEqual(fromAbsolute(abs), { date, time, abs });
  }
  assert.deepEqual(fromAbsolute(absoluteMinutes('2026-12-31', hm('23:50')) + 20).date, '2027-01-01');
});

/**
 * Riippumaton vertailu: Intl tuntee Europe/Helsinki-vyöhykkeen. Palauttaa
 * kaikki UTC-hetket, joina Helsingin kello näyttää annettua aikaa
 * (0 = puuttuva tunti, 2 = toistuva tunti).
 */
const HELSINKI = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Helsinki', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
});
function helsinkiWall(ms) {
  const parts = Object.fromEntries(HELSINKI.formatToParts(new Date(ms)).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}
function helsinkiInstants(date, time) {
  const base = Date.parse(`${date}T${time}:00Z`);
  return [180, 120].map(offset => base - offset * 60000).filter(ms => helsinkiWall(ms) === `${date} ${time}`);
}

// VYÖHYKE ANNETAAN, SITÄ EI KOVAKOODATA. Suomen säännöt tulevat testiapurin
// kiinteästä Europe/Helsinki-funktiosta (tests/helpers/helsinkiOffset.mjs);
// sovellus antaa laitteen oman vyöhykkeen.
const HKI = helsinkiOffset;
const fixed = minutes => () => minutes;
/** America/New_York 2026: kesäaika 8.3. klo 07 UTC – 1.11. klo 06 UTC (−300 / −240). */
const newYork = ms => (ms >= Date.UTC(2026, 2, 8, 7) && ms < Date.UTC(2026, 10, 1, 6) ? -240 : -300);
const helsinkiGap = (date, minutes) => helsinkiInstants(date, fromAbsolute(minutes).time).length === 0;

test('KRIITTINEN: ilman vyöhykettä laskenta on puhdasta seinäkelloa — mikään maa ei vuoda koodista', () => {
  const s = departureSchedule(plan({ arrivalDate: '2026-03-29', arrivalTime: '05:00', travelMinutes: 90,
    arrivalBufferMinutes: 0 }), { todayIso: '2026-03-29' });
  assert.deepEqual([s.leave.date, s.leave.time], ['2026-03-29', '03:30']);
  const code = readCode('src/domain/travel.js');
  assert.equal(/Helsinki|finnish|EEST|\b(120|180)\b.*offset/i.test(code), false, 'travel.js ei saa tuntea yhtäkään vyöhykettä');
});

test('KRIITTINEN: kevätyönä (Helsinki) lähtö ei osu puuttuvaan tuntiin ja matkalle jää täysi aika', () => {
  // Saapuminen 05:00, 90 min: seinäkello sanoisi 03:30, jota ei ole -- laite soittaisi 04:30.
  const schedule = departureSchedule(plan({ arrivalDate: '2026-03-29', arrivalTime: '05:00', travelMinutes: 90,
    arrivalBufferMinutes: 0 }), { todayIso: '2026-03-29', offsetMinutesFn: HKI });
  assert.deepEqual([schedule.leave.date, schedule.leave.time], ['2026-03-29', '02:30']);
  assert.deepEqual(leaveAtMinus(departureSchedule(plan({ arrivalDate: '2026-03-29', arrivalTime: '05:15',
    travelMinutes: 70, arrivalBufferMinutes: 0 }), { todayIso: '2026-03-29', offsetMinutesFn: HKI }), 10,
    { offsetMinutesFn: HKI }), { date: '2026-03-29', time: '02:55' });

  for (let start = 0; start < 9 * 60; start += 5) {
    const startTime = fromAbsolute(start).time;
    if (helsinkiGap('2026-03-29', start)) continue; // tapahtumaa ei voi olla olemattomaan aikaan
    for (let travel = 5; travel <= 300; travel += 5) {
      const s = departureSchedule({ arrivalDate: '2026-03-29', arrivalTime: startTime, travelMinutes: travel,
        arrivalBufferMinutes: 0, preparationMinutes: 0 }, { todayIso: '2026-03-29', offsetMinutesFn: HKI });
      const leaveInstants = helsinkiInstants(s.leave.date, s.leave.time);
      assert.equal(leaveInstants.length, 1, `${startTime}-${travel}: lähtö ${s.leave.time} ei ole olemassa`);
      const elapsed = (helsinkiInstants('2026-03-29', startTime)[0] - leaveInstants[0]) / 60000;
      assert.equal(elapsed, travel, `${startTime}-${travel}`);
    }
  }
});

test('KRIITTINEN: syysyönä (Helsinki) lähtö on aina ajoissa eikä koskaan myöhemmin kuin seinäkello sanoo', () => {
  const schedule = departureSchedule(plan({ arrivalDate: '2026-10-25', arrivalTime: '04:30', travelMinutes: 120,
    arrivalBufferMinutes: 0 }), { todayIso: '2026-10-25', offsetMinutesFn: HKI });
  assert.deepEqual([schedule.leave.date, schedule.leave.time], ['2026-10-25', '02:30']);

  for (let start = 0; start < 9 * 60; start += 5) {
    const startTime = fromAbsolute(start).time;
    const startInstant = Math.min(...helsinkiInstants('2026-10-25', startTime));
    for (let travel = 5; travel <= 300; travel += 5) {
      const s = departureSchedule({ arrivalDate: '2026-10-25', arrivalTime: startTime, travelMinutes: travel,
        arrivalBufferMinutes: 0, preparationMinutes: 0 }, { todayIso: '2026-10-25', offsetMinutesFn: HKI });
      const naive = absoluteMinutes('2026-10-25', start) - travel;
      assert.ok(s.leave.abs <= naive, `${startTime}-${travel}: myöhemmin kuin seinäkello`);
      // Laite lukee toistuvan ajan ensimmäiseksi kerraksi.
      const leaveInstant = Math.min(...helsinkiInstants(s.leave.date, s.leave.time));
      assert.ok((startInstant - leaveInstant) / 60000 >= travel, `${startTime}-${travel}`);
    }
  }
});

test('kesäajan ulkopuolella varovainen laskenta on täsmälleen seinäkelloa (Helsingin vyöhykkeellä)', () => {
  for (const date of ['2026-03-28', '2026-03-30', '2026-10-24', '2026-10-26', '2026-06-21', '2026-01-15']) {
    for (let start = 0; start < 1440; start += 7) {
      for (const minutes of [1, 15, 95, 600]) {
        const abs = absoluteMinutes(date, start);
        assert.equal(minusMinutes(abs, minutes, HKI), abs - minutes, `${date} ${start} ${minutes}`);
        assert.equal(minutesBetween(abs - minutes, abs, HKI), minutes);
      }
    }
  }
});

test('UTC, UTC+14 ja UTC−11: kiinteällä vyöhykkeellä tulos on seinäkelloa myös Suomen vaihtoöinä', () => {
  for (const offset of [0, 840, -660]) {
    for (const date of ['2026-03-29', '2026-10-25', '2026-06-21', '2026-12-31']) {
      for (let start = 0; start < 1440; start += 13) {
        for (const minutes of [1, 45, 95, 600]) {
          const abs = absoluteMinutes(date, start);
          assert.equal(minusMinutes(abs, minutes, fixed(offset)), abs - minutes, `${offset} ${date} ${start}`);
          assert.equal(minutesBetween(abs - minutes, abs, fixed(offset)), minutes);
        }
      }
    }
    const s = departureSchedule(plan({ arrivalDate: '2026-03-29', arrivalTime: '05:00', travelMinutes: 90,
      arrivalBufferMinutes: 0 }), { todayIso: '2026-03-29', offsetMinutesFn: fixed(offset) });
    assert.equal(s.leave.time, '03:30', `UTC${offset >= 0 ? '+' : ''}${offset / 60}: ei Suomen sääntöä`);
  }
});

test('vyöhykkeen vaihto: sama meno lasketaan laitteen nykyisellä vyöhykkeellä, ei edellisellä', () => {
  const p = plan({ arrivalDate: '2026-03-29', arrivalTime: '05:00', travelMinutes: 90, arrivalBufferMinutes: 0 });
  const inHelsinki = departureSchedule(p, { todayIso: '2026-03-29', offsetMinutesFn: HKI });
  const inKiritimati = departureSchedule(p, { todayIso: '2026-03-29', offsetMinutesFn: fixed(840) });
  const inNewYork = departureSchedule(p, { todayIso: '2026-03-29', offsetMinutesFn: newYork });
  assert.equal(inHelsinki.leave.time, '02:30', 'Helsingin kevätaukko korjataan');
  assert.equal(inKiritimati.leave.time, '03:30');
  assert.equal(inNewYork.leave.time, '03:30', 'New Yorkissa 29.3. ei ole vaihtoa');
  // New Yorkin oma vaihtoyö 8.3.2026: 02:00–02:59 puuttuu.
  const us = departureSchedule(plan({ arrivalDate: '2026-03-08', arrivalTime: '03:30', travelMinutes: 60,
    arrivalBufferMinutes: 0 }), { todayIso: '2026-03-08', offsetMinutesFn: newYork });
  assert.equal(us.leave.time, '01:30', 'New Yorkin aukko korjataan New Yorkin yönä');
  const usInHelsinki = departureSchedule(plan({ arrivalDate: '2026-03-08', arrivalTime: '03:30', travelMinutes: 60,
    arrivalBufferMinutes: 0 }), { todayIso: '2026-03-08', offsetMinutesFn: HKI });
  assert.equal(usInHelsinki.leave.time, '02:30');
});

test('keskiyön yli: lähtö ja valmistautuminen edelliselle päivälle, myös vaihtoyönä', () => {
  const late = departureSchedule(plan({ arrivalDate: '2026-03-29', arrivalTime: '00:20', travelMinutes: 45,
    arrivalBufferMinutes: 5, preparationMinutes: 30 }), { todayIso: '2026-03-29', offsetMinutesFn: HKI });
  assert.deepEqual([late.leave.date, late.leave.time, late.prepare.date, late.prepare.time],
    ['2026-03-28', '23:30', '2026-03-28', '23:00']);
  const autumn = departureSchedule(plan({ arrivalDate: '2026-10-25', arrivalTime: '00:30', travelMinutes: 60,
    arrivalBufferMinutes: 0, preparationMinutes: 30 }), { todayIso: '2026-10-25', offsetMinutesFn: HKI });
  assert.deepEqual([autumn.leave.date, autumn.leave.time, autumn.prepare.time], ['2026-10-24', '23:30', '23:00']);
  const year = departureSchedule(plan({ arrivalDate: '2027-01-01', arrivalTime: '00:10', travelMinutes: 30,
    arrivalBufferMinutes: 0 }), { todayIso: '2026-12-31', offsetMinutesFn: fixed(-660) });
  assert.deepEqual([year.leave.date, year.leave.time], ['2026-12-31', '23:40']);
});

test('planDeparture välittää vyöhykkeen: kevätyönä lähtö 02:30 vain Helsingin vyöhykkeellä', () => {
  const occurrence = { id: 'event:e1:2026-03-29', date: '2026-03-29', time: '05:00' };
  const place = { usualTravelMinutes: 90, overheadMinutes: 0, preparationMinutes: 0, arrivalBufferMinutes: 0 };
  const settings = { arrivalBufferMinutes: 0 };
  const withZone = planDeparture({ occurrence, place, settings, offsetMinutesFn: HKI });
  const plain = planDeparture({ occurrence, place, settings });
  assert.equal(withZone.leave.time, '02:30');
  assert.equal(plain.leave.time, '03:30');
});

test('kevätyönä vaihe lasketaan kuluneesta ajasta: 02:55 -> 04:10 on 15 min, ei 75', () => {
  const p = plan({ arrivalDate: '2026-03-29', arrivalTime: '05:00', travelMinutes: 50, arrivalBufferMinutes: 0 });
  const state = departureState(p, { todayIso: '2026-03-29', nowMinutes: hm('02:55'), offsetMinutesFn: HKI });
  assert.equal(state.schedule.leave.time, '04:10');
  assert.equal(state.state, DEPARTURE_STATE.LEAVE_SOON);
  assert.equal(state.minutesUntilLeave, 15);
  const beforeGap = departurePhase(p, { todayIso: '2026-03-29', nowMinutes: hm('02:59'), offsetMinutesFn: HKI });
  assert.deepEqual([beforeGap.phase, beforeGap.minutesUntilLeave], [DEPARTURE_PHASE.PREPARE_SOON, 11],
    'seinäkello sanoisi 71 min ja NOT_YET');
  assert.equal(departurePhase(p, { todayIso: '2026-03-29', nowMinutes: hm('04:05'), offsetMinutesFn: HKI }).phase,
    DEPARTURE_PHASE.LEAVE_IN_5);
});

test('tulos ei riipu laitteen aikavyöhykkeestä (Helsinki, UTC, New York, Tokio)', () => {
  const code = `
    import { departureSchedule, departurePhase } from './src/domain/travel.js';
    import { planDeparture } from './src/domain/departure.js';
    const out = [];
    for (const date of ['2026-03-29', '2026-10-25', '2026-12-31', '2028-02-29']) {
      for (let start = 0; start < 1440; start += 47) {
        const time = String(Math.floor(start / 60)).padStart(2, '0') + ':' + String(start % 60).padStart(2, '0');
        const p = { arrivalDate: date, arrivalTime: time, travelMinutes: 95, arrivalBufferMinutes: 5, preparationMinutes: 20, earlyArrivalMinutes: 10 };
        const s = departureSchedule(p, {});
        const ph = departurePhase(p, { todayIso: date, nowMinutes: 180 });
        const d = planDeparture({ occurrence: { date, time }, place: { usualTravelMinutes: 95 }, todayIso: date, nowMinutes: 200 });
        out.push([s.leave.date, s.leave.time, s.prepare.time, ph.phase, d.leave.time, d.phase, d.reminderTimes.leaveNow.time]);
      }
    }
    console.log(JSON.stringify(out));`;
  const results = ['Europe/Helsinki', 'UTC', 'America/New_York', 'Asia/Tokyo'].map(tz => execFileSync(
    process.execPath, ['--input-type=module', '-e', code], { cwd: ROOT, env: { ...process.env, TZ: tz }, encoding: 'utf8' }
  ).trim());
  for (const other of results.slice(1)) assert.equal(other, results[0]);
  assert.ok(JSON.parse(results[0]).length > 100);
});

// ======================================================= matka-ajan valinta

const route = (seconds, overrides = {}) => ({
  status: 'OK', durationSeconds: seconds, distanceMeters: 20000, provider: 'liikenne-x', trafficAware: true,
  calculatedAt: '2026-09-28T12:55:00Z', validUntil: '2026-09-28T13:20:00Z', confidence: 'medium', ...overrides
});
const learned = (overrides = {}) => ({ count: 6, median: 35, p80: 38, min: 30, max: 44, ...overrides });

test('matka-aika: järjestys liikennetieto -> opittu -> tapahtuma -> paikka -> tuntematon', () => {
  const place = { usualTravelMinutes: 25, useLearned: true };
  const event = { travelMinutes: 30 };

  const provider = selectTravelEstimate({ providerResult: route(1861), learned: learned({ p80: 20, median: 18 }), event, place, nowMs: NOW_MS });
  assert.deepEqual([provider.minutes, provider.source, provider.basis], [32, ESTIMATE_SOURCE.PROVIDER, 'provider']);
  assert.equal(provider.trafficAware, true);
  assert.match(provider.explanation, /liikennetiedosta ruuhka huomioiden: 32 min/);

  const learnedOnly = selectTravelEstimate({ learned: learned(), event, place, nowMs: NOW_MS });
  assert.deepEqual([learnedOnly.minutes, learnedOnly.source, learnedOnly.basis], [38, ESTIMATE_SOURCE.LEARNED, 'learned']);
  assert.match(learnedOnly.explanation, /6 matkaa/);

  const fromEvent = selectTravelEstimate({ event, place: { usualTravelMinutes: 25 } });
  assert.deepEqual([fromEvent.minutes, fromEvent.source, fromEvent.basis], [30, ESTIMATE_SOURCE.USER_SUPPLIED, 'event']);

  const fromPlace = selectTravelEstimate({ place: { usualTravelMinutes: 25 } });
  assert.deepEqual([fromPlace.minutes, fromPlace.source, fromPlace.basis], [25, ESTIMATE_SOURCE.USER_SUPPLIED, 'place']);

  const unknown = selectTravelEstimate({});
  assert.deepEqual([unknown.known, unknown.minutes, unknown.source, unknown.basis], [false, null, ESTIMATE_SOURCE.UNKNOWN, null]);
  assert.match(unknown.explanation, /Matka-aikaa ei tiedetä/);
});

test('liikennetieto ja opittu yhdessä: varovaisempi (suurempi) voittaa ja molemmat selitetään', () => {
  const result = selectTravelEstimate({ providerResult: route(32 * 60), learned: learned(), place: { useLearned: true }, nowMs: NOW_MS });
  assert.deepEqual([result.minutes, result.source, result.providerMinutes, result.learnedMinutes], [38, ESTIMATE_SOURCE.LEARNED, 32, 38]);
  assert.match(result.explanation, /Liikennetiedon mukaan ruuhka huomioiden 32 min/);
  assert.match(result.explanation, /Lasketaan varovaisemmin 38 min/);
});

test('opittua käytetään vain hyväksyttynä ja vähintään kolmesta matkasta', () => {
  const event = { travelMinutes: 30 };
  assert.equal(MIN_LEARNED_OBSERVATIONS, 3);
  assert.equal(selectTravelEstimate({ learned: learned(), event, place: { useLearned: false } }).basis, 'event');
  assert.equal(selectTravelEstimate({ learned: learned(), event, place: { useLearned: 'true' } }).basis, 'event');
  assert.equal(selectTravelEstimate({ learned: learned({ count: 2 }), event, place: { useLearned: true } }).basis, 'event');
  assert.equal(selectTravelEstimate({ learned: learned({ p80: null }), event, place: { useLearned: true } }).basis, 'event');
  assert.equal(selectTravelEstimate({ learned: learned({ count: 3 }), event, place: { useLearned: true } }).basis, 'learned');
});

test('KRIITTINEN: liikennetieto kelpaa vain tuoreena ja tarkistettuna', () => {
  const place = { usualTravelMinutes: 25 };
  const stale = selectTravelEstimate({ providerResult: route(1800, { validUntil: '2026-09-28T12:59:00Z' }), place, nowMs: NOW_MS });
  assert.equal(stale.basis, 'place');
  assert.match(stale.explanation, /^Liikennetieto on vanhentunut, joten sitä ei käytetä\. /);
  for (const bad of [route(0), route(-60), route(NaN), route(1800, { status: 'ERROR' }), 'OK', 1800,
    route(1800, { status: 'UNKNOWN' }), route(1800, { provider: '' }), route(1800, { confidence: 'varma' }),
    route(1800, { calculatedAt: '2026-09-28T14:00:00Z', validUntil: '2026-09-28T15:00:00Z' })]) {
    const result = selectTravelEstimate({ providerResult: bad, place, nowMs: NOW_MS });
    assert.equal(result.basis, 'place');
    assert.notEqual(result.minutes, 0);
  }
  // Ilman nykyhetkeä tuoreutta ei voi todentaa.
  assert.equal(selectTravelEstimate({ providerResult: route(1800), place }).basis, 'place');
});

test('tuntematon ei ole nolla: nolla ja kelvottomat minuutit eivät tuota matka-aikaa', () => {
  for (const minutes of [0, -1, NaN, Infinity, '30', null, 1441]) {
    const result = selectTravelEstimate({ event: { travelMinutes: minutes }, place: { usualTravelMinutes: minutes } });
    assert.equal(result.minutes, null, String(minutes));
    assert.equal(result.source, ESTIMATE_SOURCE.UNKNOWN);
  }
});

test('lähteen nimi käyttäjälle ei sisällä teknistä sanastoa', () => {
  assert.equal(estimateSourceText(ESTIMATE_SOURCE.PROVIDER), 'liikennetiedosta');
  assert.equal(estimateSourceText(ESTIMATE_SOURCE.USER_SUPPLIED), 'oma arviosi');
  assert.equal(estimateSourceText(ESTIMATE_SOURCE.LEARNED), 'omista matkoistasi');
  assert.equal(estimateSourceText(ESTIMATE_SOURCE.UNKNOWN), '');
});

// ======================================================= uudelleenlaskenta

test('recalcDecision: liikenteen hidastuminen kerrotaan tarkalla lauseella', () => {
  const decision = recalcDecision({
    previousLeave: { date: TODAY, time: '17:15' }, nextLeave: { date: TODAY, time: '17:03' }, source: ESTIMATE_SOURCE.PROVIDER
  });
  assert.equal(decision.surface, true);
  assert.equal(decision.direction, 'earlier');
  assert.equal(decision.deltaMinutes, -12);
  assert.equal(decision.message, 'Liikenne on hidastunut. Lähtöä kannattaa aikaistaa 12 minuuttia.');
  assert.deepEqual(decision.leave, { date: TODAY, time: '17:03' });
  assert.equal(Object.isFrozen(decision), true);
});

test('recalcDecision: rajat 5 ja 10, ja vain liikennetiedon aiheuttama muutos kerrotaan', () => {
  const at = (time, source = ESTIMATE_SOURCE.PROVIDER) =>
    recalcDecision({ previousLeave: { date: TODAY, time: '17:15' }, nextLeave: { date: TODAY, time }, source });
  assert.equal(at('17:11').surface, false);
  assert.deepEqual(at('17:11').leave, { date: TODAY, time: '17:15' }, 'pieni aikaistus: näytetään entinen');
  assert.equal(at('17:10').surface, true);
  assert.equal(at('17:24').surface, false);
  const later = at('17:25');
  assert.equal(later.surface, true);
  assert.equal(later.message, 'Liikenne on sujuvampaa. Voit lähteä 10 minuuttia myöhemmin.');
  const own = at('17:00', ESTIMATE_SOURCE.USER_SUPPLIED);
  assert.deepEqual([own.surface, own.changed, own.message], [false, true, '']);
  const viaLeave = recalcDecision({ previousLeave: 100, nextLeave: { abs: 80, source: 'provider' } });
  assert.equal(viaLeave.surface, true);
  assert.equal(recalcDecision({ previousLeave: null, nextLeave: 80, source: 'provider' }).surface, false, 'ensimmäinen ei ole muutos');
  for (const garbage of [undefined, null, 5, 'x', [], { previousLeave: {}, nextLeave: 'x' }]) {
    assert.doesNotThrow(() => recalcDecision(garbage));
    assert.equal(recalcDecision(garbage).surface, false);
  }
});

// ======================================================= lähtösuunnitelma

const occurrence = (overrides = {}) => ({
  id: 'event:e1:2026-09-28', eventId: 'e1', date: TODAY, time: '18:00', endTime: '19:00', durationMinutes: 60,
  allDay: false, title: 'Parturi', category: 'muu', isEvent: true, source: 'event', placeId: 'pl1',
  locationText: null, ...overrides
});
const place = (overrides = {}) => ({
  id: 'pl1', name: 'Parturi Kallio', address: 'Fleminginkatu 1', travelMode: 'driving', usualTravelMinutes: 40,
  preparationMinutes: 15, arrivalBufferMinutes: null, overheadMinutes: 5, useLearned: false, ...overrides
});
const settings = (overrides = {}) => ({ arrivalBufferMinutes: 10, reminderOffsetMinutes: 0, ...overrides });

test('planDeparture: taaksepäin saapumisesta, jokainen osa näkyvissä', () => {
  const result = planDeparture({ occurrence: occurrence(), place: place(), settings: settings(), todayIso: TODAY, nowMinutes: hm('12:00') });
  assert.equal(result.applicable, true);
  assert.equal(result.known, true);
  assert.equal(result.phase, DEPARTURE_PHASE.NOT_YET);
  assert.deepEqual([result.eventStart.time, result.arrivalTarget.time, result.leave.time, result.prepareStart.time],
    ['18:00', '17:50', '17:05', '16:50']);
  assert.deepEqual({ ...result.parts }, { travel: 40, overhead: 5, early: 10, preparation: 15 });
  assert.deepEqual({ ...result.partSources }, { travel: 'place', overhead: 'place', early: 'settings', preparation: 'place' });
  assert.equal(result.source, ESTIMATE_SOURCE.USER_SUPPLIED);
  assert.deepEqual([...result.explanationLines], [
    'Alkaa klo 18:00.',
    'Perillä klo 17:50, 10 min etuajassa.',
    'Lähde klo 17:05: matka 40 min (oma arviosi), pysäköinti ja kävely 5 min.',
    'Aloita valmistautuminen klo 16:50 (15 min).'
  ]);
  assert.equal(result.explanation, result.explanationLines.join(' '));
  assert.equal(result.destination, 'Parturi Kallio');
  assert.equal(result.occurrenceId, 'event:e1:2026-09-28');
  assert.equal(result.dstAdjusted, false);
});

test('etuajassa olo: tapahtuma > paikka > asetukset > oletus 10', () => {
  const early = input => planDeparture({ occurrence: occurrence(), place: place(), settings: settings(), ...input });
  assert.deepEqual([early({ occurrence: occurrence({ arrivalBufferMinutes: 20 }), place: place({ arrivalBufferMinutes: 15 }) }).parts.early,
    early({ occurrence: occurrence({ arrivalBufferMinutes: 20 }) }).partSources.early], [20, 'event']);
  assert.deepEqual([early({ place: place({ arrivalBufferMinutes: 15 }) }).parts.early,
    early({ place: place({ arrivalBufferMinutes: 15 }) }).partSources.early], [15, 'place']);
  assert.equal(early({}).parts.early, 10);
  const fallback = early({ settings: undefined });
  assert.deepEqual([fallback.parts.early, fallback.partSources.early], [DEFAULT_ARRIVAL_BUFFER_MINUTES, 'default']);
  // Tapahtuman kentät voivat tulla myös tapahtumaoliosta; esiintymä voittaa.
  const viaEvent = early({ event: { arrivalBufferMinutes: 30, preparationMinutes: 0 } });
  assert.deepEqual([viaEvent.parts.early, viaEvent.parts.preparation], [30, 0]);
  const both = early({ occurrence: occurrence({ arrivalBufferMinutes: 5 }), event: { arrivalBufferMinutes: 30 } });
  assert.equal(both.parts.early, 5);
  // 0 on kelvollinen valinta (ei etuajassa oloa), ei puuttuva.
  assert.equal(early({ occurrence: occurrence({ arrivalBufferMinutes: 0 }) }).arrivalTarget.time, '18:00');
});

test('pysäköinti ja valmistautuminen: tapahtuma > paikka > kulkutavan näkyvä oletus', () => {
  const walking = planDeparture({ occurrence: occurrence(), place: place({ travelMode: 'walking', overheadMinutes: null, preparationMinutes: null }) });
  assert.deepEqual([walking.mode, walking.parts.overhead, walking.parts.preparation], ['walking', 0, 5]);
  assert.deepEqual([walking.partSources.overhead, walking.partSources.preparation], ['default', 'default']);
  const driving = planDeparture({ occurrence: occurrence({ travelMode: 'driving' }), place: place({ travelMode: 'walking', overheadMinutes: null, preparationMinutes: null }) });
  assert.deepEqual([driving.mode, driving.parts.overhead, driving.parts.preparation], ['driving', 5, 10]);
  const own = planDeparture({ occurrence: occurrence({ overheadMinutes: 12, preparationMinutes: 25 }), place: place() });
  assert.deepEqual([own.parts.overhead, own.parts.preparation, own.partSources.overhead], [12, 25, 'event']);
});

test('KRIITTINEN: muistutuksen aikaistus siirtää vain muistutuksia, ei näytettyä kelloa', () => {
  const base = planDeparture({ occurrence: occurrence(), place: place(), settings: settings({ reminderOffsetMinutes: 0 }) });
  const shifted = planDeparture({ occurrence: occurrence(), place: place(), settings: settings({ reminderOffsetMinutes: 10 }) });
  for (const key of ['eventStart', 'arrivalTarget', 'leave', 'prepareStart']) assert.deepEqual(shifted[key], base[key], key);
  assert.deepEqual({ ...base.reminderTimes.prepare }, { date: TODAY, time: '16:50' });
  assert.deepEqual({ ...base.reminderTimes.leaveIn5 }, { date: TODAY, time: '17:00' });
  assert.deepEqual({ ...base.reminderTimes.leaveNow }, { date: TODAY, time: '17:05' });
  assert.deepEqual({ ...shifted.reminderTimes.prepare }, { date: TODAY, time: '16:40' });
  assert.deepEqual({ ...shifted.reminderTimes.leaveIn5 }, { date: TODAY, time: '16:50' });
  assert.deepEqual({ ...shifted.reminderTimes.leaveNow }, { date: TODAY, time: '16:55' });
  assert.equal(shifted.reminderOffsetMinutes, 10);
  assert.match(shifted.explanation, /Muistutukset tulevat 10 min tavallista aikaisemmin\./);
  for (const bad of [-5, 61, NaN, '10', null]) {
    assert.equal(planDeparture({ occurrence: occurrence(), place: place(), settings: settings({ reminderOffsetMinutes: bad }) }).reminderOffsetMinutes, 0);
  }
});

test('muistutukset: ei valmistautumista -> ei valmistautumismuistutusta; lyhyt valmistautuminen korvaa "5 min"', () => {
  const none = planDeparture({ occurrence: occurrence(), place: place({ preparationMinutes: 0 }) });
  assert.equal(none.reminderTimes.prepare, null);
  assert.equal(none.reminderTimes.leaveIn5.time, '17:00');
  assert.equal(none.explanationLines.some(line => line.startsWith('Aloita valmistautuminen')), false);
  const short = planDeparture({ occurrence: occurrence(), place: place({ preparationMinutes: 3 }) });
  assert.equal(short.reminderTimes.prepare.time, '17:02');
  assert.equal(short.reminderTimes.leaveIn5, null);
  const five = planDeparture({ occurrence: occurrence(), place: place({ preparationMinutes: 5 }) });
  assert.equal(five.reminderTimes.leaveIn5, null);
  const six = planDeparture({ occurrence: occurrence(), place: place({ preparationMinutes: 6 }) });
  assert.equal(six.reminderTimes.leaveIn5.time, '17:00');
});

test('KRIITTINEN: tuntematon matka-aika: ei lähtöaikaa, ei muistutuksia, saapumistavoite silti näkyy', () => {
  const result = planDeparture({ occurrence: occurrence(), place: place({ usualTravelMinutes: null }), settings: settings(), todayIso: TODAY, nowMinutes: hm('17:00') });
  assert.equal(result.applicable, true);
  assert.equal(result.known, false);
  assert.equal(result.phase, DEPARTURE_PHASE.UNKNOWN_TRAVEL);
  assert.equal(result.leave, null);
  assert.equal(result.prepareStart, null);
  assert.equal(result.parts.travel, null);
  assert.deepEqual({ ...result.reminderTimes }, { prepare: null, leaveIn5: null, leaveNow: null });
  assert.equal(result.arrivalTarget.time, '17:50');
  assert.equal(result.source, ESTIMATE_SOURCE.UNKNOWN);
  assert.match(result.explanation, /Matka-aikaa ei tiedetä, joten lähtöaikaa ei lasketa/);
  // Kelvoton arvio (tuntematon lähde tai nolla) ei tuota lähtöaikaa.
  for (const estimate of [{ minutes: 30, source: 'arvaus' }, { minutes: 0, source: 'provider' },
    { minutes: 30, source: ESTIMATE_SOURCE.UNKNOWN }, { minutes: null, source: 'provider' }]) {
    assert.equal(planDeparture({ occurrence: occurrence(), place: place(), estimate }).known, false, JSON.stringify(estimate));
  }
});

test('koko päivän tapahtuma ja puuttuva päivä: ei lähtösuunnitelmaa', () => {
  const allDay = planDeparture({ occurrence: occurrence({ time: null, allDay: true }), place: place() });
  assert.deepEqual([allDay.applicable, allDay.known, allDay.phase], [false, false, null]);
  assert.match(allDay.explanation, /Koko päivän tapahtumalle/);
  assert.equal(planDeparture({ occurrence: occurrence({ allDay: true }) }).applicable, false);
  assert.equal(planDeparture({ occurrence: occurrence({ date: '2026-02-30' }) }).applicable, false);
  assert.equal(planDeparture({}).applicable, false);
});

test('ilman nykyhetkeä vaihe on null, mutta ajat lasketaan', () => {
  const result = planDeparture({ occurrence: occurrence(), place: place() });
  assert.equal(result.phase, null);
  assert.equal(result.phaseLabel, '');
  assert.equal(result.leave.time, '17:05');
  assert.equal(planDeparture({ occurrence: occurrence(), place: place(), todayIso: TODAY, nowMinutes: NaN }).phase, null);
});

test('planDeparture:n vaihe on sama kuin suunnitelman departurePhase joka minuutti', () => {
  const equivalent = { arrivalDate: TODAY, arrivalTime: '18:00', travelMinutes: 40, arrivalBufferMinutes: 5,
    preparationMinutes: 15, earlyArrivalMinutes: 10 };
  for (let minute = 0; minute < 1440; minute += 1) {
    const result = planDeparture({ occurrence: occurrence(), place: place(), settings: settings(), todayIso: TODAY, nowMinutes: minute });
    assert.equal(result.phase, departurePhase(equivalent, { todayIso: TODAY, nowMinutes: minute }).phase, String(minute));
  }
  const soon = planDeparture({ occurrence: occurrence(), place: place(), settings: settings(), todayIso: TODAY, nowMinutes: hm('16:50'), prepareSoonMinutes: 30 });
  assert.equal(soon.phase, DEPARTURE_PHASE.PREPARE_NOW);
  assert.equal(soon.minutesUntilLeave, 15);
});

test('keskiyö, kuun ja vuoden vaihde: päivä rullaa ja selitys kertoo päivän', () => {
  const night = planDeparture({
    occurrence: occurrence({ date: '2026-10-01', time: '00:15' }),
    place: place({ usualTravelMinutes: 30, overheadMinutes: 5, preparationMinutes: 20 }), settings: settings()
  });
  assert.deepEqual([night.arrivalTarget.date, night.arrivalTarget.time], ['2026-10-01', '00:05']);
  assert.deepEqual([night.leave.date, night.leave.time], ['2026-09-30', '23:30']);
  assert.deepEqual([night.prepareStart.date, night.prepareStart.time], ['2026-09-30', '23:10']);
  assert.match(night.explanation, /Lähde 30\.9\. klo 23:30/);
  const newYear = planDeparture({ occurrence: occurrence({ date: '2027-01-01', time: '00:20' }), place: place({ usualTravelMinutes: 60 }), settings: settings() });
  assert.deepEqual([newYear.leave.date, newYear.leave.time], ['2026-12-31', '23:05']);
  assert.equal(newYear.reminderTimes.prepare.date, '2026-12-31');
});

test('kesäajan yöt (laitteen vyöhyke Helsinki): kevään puuttuva tunti korjataan ja kerrotaan, syksy pysyy seinäkellossa', () => {
  const spring = planDeparture({
    occurrence: occurrence({ date: '2026-03-29', time: '05:00' }),
    place: place({ usualTravelMinutes: 90, overheadMinutes: 0, preparationMinutes: 0 }),
    settings: settings({ arrivalBufferMinutes: 0 }),
    offsetMinutesFn: HKI
  });
  assert.equal(spring.leave.time, '02:30');
  assert.equal(spring.dstAdjusted, true);
  assert.match(spring.explanation, /kesäaikaan/);
  const autumn = planDeparture({
    occurrence: occurrence({ date: '2026-10-25', time: '04:30' }),
    place: place({ usualTravelMinutes: 120, overheadMinutes: 0, preparationMinutes: 0 }),
    settings: settings({ arrivalBufferMinutes: 0 }),
    offsetMinutesFn: HKI
  });
  assert.equal(autumn.leave.time, '02:30');
  assert.equal(autumn.dstAdjusted, false);
  const ordinary = planDeparture({ occurrence: occurrence({ date: '2026-03-29', time: '09:00' }), place: place(), settings: settings(), offsetMinutesFn: HKI });
  assert.equal(ordinary.dstAdjusted, false);
  assert.equal(ordinary.leave.time, '08:05');
});

test('annettu arvio ohittaa omat kentät, ja lähde näkyy selityksessä', () => {
  const estimate = selectTravelEstimate({ providerResult: route(50 * 60, { trafficAware: false }), place: place(), nowMs: NOW_MS });
  const result = planDeparture({ occurrence: occurrence(), place: place(), settings: settings(), estimate });
  assert.equal(result.parts.travel, 50);
  assert.equal(result.source, ESTIMATE_SOURCE.PROVIDER);
  assert.equal(result.partSources.travel, 'provider');
  assert.match(result.explanation, /matka 50 min \(liikennetiedosta\)/);
  assert.equal(result.travelExplanation, 'Arvio ajantasaisesta liikennetiedosta: 50 min.');
});

test('deterministinen, jäädytetty eikä muuta syötettä', () => {
  const input = { occurrence: occurrence(), place: place(), settings: settings({ reminderOffsetMinutes: 5 }), todayIso: TODAY, nowMinutes: 1000 };
  const snapshot = structuredClone(input);
  const first = planDeparture(input);
  for (let i = 0; i < 50; i += 1) assert.deepEqual(planDeparture(input), first);
  assert.deepEqual(input, snapshot);
  for (const key of ['occurrence', 'place', 'settings']) assert.equal(Object.isFrozen(input[key]), false);
  for (const value of [first, first.parts, first.partSources, first.reminderTimes, first.leave, first.explanationLines,
    first.reminderTimes.leaveNow]) {
    assert.equal(Object.isFrozen(value), true);
  }
  const est = selectTravelEstimate({ learned: learned(), place: { useLearned: true } });
  assert.equal(Object.isFrozen(est), true);
});

test('kelvoton syöte ei koskaan kaada', () => {
  const garbage = [undefined, null, 0, 1, 'x', [], {}, () => 1, NaN, Symbol('s'),
    { occurrence: 'x' }, { occurrence: [] }, { occurrence: { date: TODAY, time: '24:00' } },
    { occurrence: occurrence(), place: 'x', settings: 7, estimate: [] },
    { occurrence: occurrence({ travelMode: {}, arrivalBufferMinutes: 'x', preparationMinutes: -1 }), place: { travelMode: 5 } },
    { occurrence: occurrence(), todayIso: {}, nowMinutes: '600' }];
  for (const input of garbage) {
    assert.doesNotThrow(() => planDeparture(input), String(input));
    assert.doesNotThrow(() => selectTravelEstimate(input));
  }
});

test('suorituskyky: 20 000 esiintymää lasketaan lineaarisesti', () => {
  const inputs = [];
  for (let i = 0; i < 20000; i += 1) {
    const minute = (i * 7) % 1440;
    inputs.push({
      occurrence: occurrence({ date: fromAbsolute(absoluteMinutes(TODAY, 0) + (i % 400) * 1440).date,
        time: fromAbsolute(minute).time }),
      place: place({ usualTravelMinutes: 10 + (i % 90) }), settings: settings(), todayIso: TODAY, nowMinutes: 600
    });
  }
  const started = performance.now();
  let known = 0;
  for (const input of inputs) if (planDeparture(input).known) known += 1;
  const elapsed = performance.now() - started;
  assert.equal(known, inputs.length);
  assert.ok(elapsed < 4000, `liian hidas: ${Math.round(elapsed)} ms`);
});

// ======================================================= puhtaus ja miinat

const MY_MODULES = ['src/domain/travel.js', 'src/domain/departure.js', 'src/domain/places.js',
  'src/domain/commuteLearning.js', 'src/domain/routing.js', 'src/domain/navigationLink.js'];

test('KRIITTINEN: lähtömoottorin moduulit ovat puhtaita (ei kelloa, arpaa, DOMia, verkkoa, lokia)', () => {
  const forbidden = ['Date.now(', 'Math.random', 'crypto.randomUUID', 'performance.now', 'document.', 'window.',
    'localStorage', 'sessionStorage', 'fetch(', 'console.', 'XMLHttpRequest', 'navigator.'];
  for (const file of MY_MODULES) {
    const code = readCode(file);
    for (const token of forbidden) assert.equal(code.includes(token), false, `${file}: ${token}`);
    assert.equal(/new Date\(\s*\)/.test(code), false, `${file}: new Date()`);
    assert.equal(/from '\.\.\/(app|data|platform|ui|ai)\//.test(code), false, `${file}: väärä kerros`);
  }
});

test('miinat: ei valereittipalvelua, ei oletuskestoa, kolme lähdettä, reittipalvelua ei ole', () => {
  const travel = read('src/domain/travel.js');
  assert.equal(/testiprovider|createTestRouteProvider/.test(travel), false);
  assert.equal(/travelMinutes:\s*(30|45|60)\b/.test(travel), false);
  assert.equal(TRAVEL_SOURCES.length, 3);
  assert.equal(hasTravelProvider(), false);
  for (const file of MY_MODULES) {
    const code = readCode(file);
    assert.equal(/testiprovider|createTestRouteProvider/.test(code), false, file);
    // Koordinaatteja ei käsitellä missään lähtömoottorin osassa.
    assert.equal(/\b(latitude|longitude|lat|lng|coords)\b/.test(code), false, file);
  }
});

test('käyttäjälle näkyvä teksti ei sisällä teknistä sanastoa', () => {
  const texts = [];
  const collect = value => { if (typeof value === 'string') texts.push(value); };
  const r = planDeparture({ occurrence: occurrence(), place: place(), settings: settings({ reminderOffsetMinutes: 5 }), todayIso: TODAY, nowMinutes: 1000 });
  collect(r.explanation); collect(r.travelExplanation); collect(r.phaseLabel);
  for (const input of [{}, { learned: learned(), place: { useLearned: true } }, { providerResult: route(1900), nowMs: NOW_MS },
    { providerResult: route(1900, { validUntil: '2026-09-28T12:00:00Z' }), nowMs: NOW_MS, place: { usualTravelMinutes: 20 } }]) {
    collect(selectTravelEstimate(input).explanation);
  }
  collect(recalcDecision({ previousLeave: 100, nextLeave: 80, source: 'provider' }).message);
  for (const text of texts) {
    assert.equal(/provider|percentile|schema|null|undefined|NaN|p80/i.test(text), false, text);
  }
});

test('yksi aikamalli: zonedClock.offsetFnForTimeZone antaa saman lähdön kuin testin Helsinki-funktio', async () => {
  const { offsetFnForTimeZone } = await import('../src/domain/zonedClock.js');
  const intl = offsetFnForTimeZone('Europe/Helsinki');
  // Riippumaton tarkistus vain, jos ajoympäristön ICU tuntee vyöhykkeen.
  if (intl(Date.UTC(2026, 6, 1)) !== 180) return;
  for (const [date, time, travel] of [['2026-03-29', '05:00', 90], ['2026-10-25', '04:30', 120], ['2026-07-01', '08:00', 35]]) {
    const p = plan({ arrivalDate: date, arrivalTime: time, travelMinutes: travel, arrivalBufferMinutes: 0 });
    const a = departureSchedule(p, { todayIso: date, offsetMinutesFn: HKI });
    const b = departureSchedule(p, { todayIso: date, offsetMinutesFn: intl });
    assert.deepEqual([b.leave.date, b.leave.time], [a.leave.date, a.leave.time], `${date} ${time}`);
  }
  const tokyo = offsetFnForTimeZone('Asia/Tokyo');
  const t = departureSchedule(plan({ arrivalDate: '2026-03-29', arrivalTime: '05:00', travelMinutes: 90,
    arrivalBufferMinutes: 0 }), { todayIso: '2026-03-29', offsetMinutesFn: tokyo });
  assert.equal(t.leave.time, '03:30', 'Tokiossa ei ole kesäaikaa');
});
