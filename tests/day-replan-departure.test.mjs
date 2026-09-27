// Myöhästyminen ja venyminen ennen lähtöä (src/domain/dayReplan.js).
//
// LÖYTYNYT PUUTE, JOTA TÄMÄ TESTI VARTIOI
//
// Keskiviikkona klo 7.15: valmistautuminen 7.05, lähtö 7.20, perillä 7.50,
// Palaveri 8.00. "Olen 15 min myöhässä" vastasi "Mitään ei tarvitse siirtää:
// väljyys riittää", koska myöhästyminen siirsi vain joustavia tehtäviä eikä
// katsonut lähtöä. Todellisuudessa lähtö on 7.35 ja perillä ollaan noin 8.05,
// eli palaverista myöhästytään.
//
// SÄÄNTÖ (lähtömoottorin luvuilla, src/domain/departure.js planDeparture)
//
//   valmis        = nyt + myöhästyminen (todellisina minuutteina)
//   lähdön siirto = koko myöhästyminen, jos valmistautuminen on jo alkanut;
//                   muuten se osa, joka ylittää valmistautumisen alun:
//                   max(0, valmis - valmistautumisen alku)
//   uusi lähtö    = lähtö + siirto
//   uusi perillä  = perilläolotavoite + siirto (matka ja kävely eivät lyhene)
//   myöhästyt     = uusi perillä - alku, jos > 0; muuten väljyys = alku - uusi perillä
//
// Menoa, matkaa tai valmistautumista ei koskaan siirretä: tulos kertoo
// rehellisesti, mitä tapahtuu, eikä väitä väljyyden riittävän.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { helsinkiOffset } from './helpers/helsinkiOffset.mjs';
import { replanDay } from '../src/domain/dayReplan.js';
import { parseInterruption } from '../src/domain/interruptions.js';
import { buildDayPlan } from '../src/domain/scheduler.js';
import { planDeparture } from '../src/domain/departure.js';
import { eventBlocks } from '../src/domain/calendarBlocks.js';
import { expandEventOccurrences } from '../src/domain/calendar.js';
import { toMinutes } from '../src/domain/task.js';

const WED = '2026-09-30';
const PROFILE = Object.freeze({ sleepTargetHours: 8, defaultWakeTime: '06:00', commuteMinutes: 30, routineMinutes: 60 });

/** Toimisto: matka 25 min, valmistautuminen 15, pysäköinti ja kävely 5, perillä 10 min etuajassa. */
const OFFICE = Object.freeze({
  id: 'p-office', name: 'Toimisto', travelMode: 'driving',
  usualTravelMinutes: 25, preparationMinutes: 15, arrivalBufferMinutes: 10, overheadMinutes: 5
});

function occurrencesOf(events) {
  return expandEventOccurrences({ events, from: WED, to: WED });
}

function blockInput(plan) {
  return {
    known: true,
    startAbs: plan.eventStart.abs,
    leaveAbs: plan.leave.abs,
    prepareStartAbs: plan.prepareStart.abs,
    travelMinutes: plan.parts.travel,
    overheadMinutes: plan.parts.overhead,
    earlyMinutes: plan.parts.early,
    arrivalAbs: plan.arrivalTarget.abs
  };
}

/**
 * Päivä, jossa on Palaveri klo 8 toimistolla (lähtö 7.20) ja valinnaisesti
 * muita menoja ja tehtäviä. Lähtöluvut ja lohkot samasta lähtömoottorista.
 */
function scenario({ events = null, tasks = [] } = {}) {
  const raw = events || [{ id: 'e-meet', title: 'Palaveri', date: WED, startTime: '08:00', endTime: '09:00', placeId: OFFICE.id }];
  const occurrences = occurrencesOf(raw);
  const departures = occurrences
    .filter(occurrence => occurrence.placeId === OFFICE.id)
    .map(occurrence => planDeparture({ occurrence, place: OFFICE, settings: {}, todayIso: WED, offsetMinutesFn: helsinkiOffset }));
  const byOccurrence = new Map(departures.map(plan => [plan.occurrenceId, plan]));
  const blocks = eventBlocks({
    occurrences,
    departureFor: occurrence => (byOccurrence.has(occurrence.id) ? blockInput(byOccurrence.get(occurrence.id)) : { known: false })
  });
  const plan = buildDayPlan({ tasks, profile: PROFILE, dateIso: WED, todayIso: WED, events: occurrences, blocks });
  return { plan, tasks, departures, occurrences, blocks };
}

function replan(text, nowTime, options = {}) {
  const { plan, tasks, departures } = scenario(options);
  return replanDay({
    plan,
    interruption: parseInterruption(text, { todayIso: WED }),
    nowMinutes: toMinutes(nowTime),
    todayIso: WED,
    tasks,
    events: plan.eventItems,
    blocks: plan.blocks,
    departures: options.departures === undefined ? departures : options.departures,
    offsetMinutesFn: helsinkiOffset
  });
}

test('lähtöluvut: Palaveri klo 8, perillä 7.50, lähtö 7.20, valmistautuminen 7.05', () => {
  const [departure] = scenario().departures;
  assert.equal(departure.known, true);
  assert.equal(departure.prepareStart.time, '07:05');
  assert.equal(departure.leave.time, '07:20');
  assert.equal(departure.arrivalTarget.time, '07:50');
  assert.equal(departure.eventStart.time, '08:00');
});

test('KRIITTINEN: "olen 15 min myöhässä" klo 7.15 kertoo myöhästyvän lähdön ja kuinka paljon myöhästyt menosta', () => {
  const result = replan('Olen 15 min myöhässä', '07:15');
  assert.equal(result.kind, 'running_late');
  assert.deepEqual([...result.changes], [], 'menoa, matkaa tai valmistautumista ei siirretä');
  assert.equal(result.requiresConfirmation, true);
  assert.doesNotMatch(result.summary, /väljyys riittää/, 'väljyys EI riitä: palaveri alkaa ennen kuin ehdit');

  assert.equal(result.impacts.length, 1);
  const [impact] = result.impacts;
  assert.deepEqual({ ...impact }, {
    kind: 'departure',
    id: `event:e-meet:${WED}`,
    title: 'Palaveri',
    startTime: '08:00',
    plannedLeaveTime: '07:20',
    leaveTime: '07:35',
    arrivalTargetTime: '07:50',
    arrivalTime: '08:05',
    delayMinutes: 15,
    late: true,
    lateMinutes: 5,
    marginMinutes: 0
  });
  assert.match(result.summary, /Palaveri klo 8\.00: lähtö myöhästyy 15 min/);
  assert.match(result.summary, /lähdet noin klo 7\.35 \(suunniteltu klo 7\.20\)/);
  assert.match(result.summary, /Ehdit perille noin klo 8\.05, eli myöhästyt noin 5 min/);
  assert.match(result.summary, /Lähde heti kun pääset/);
  assert.doesNotMatch(result.summary, /matkat.*pysyvät ennallaan/, 'lähtö ei pysy ennallaan');
  assert.match(result.summary, /Menoja ei siirretä/);
});

test('myöhästyminen, jonka perilläolon etuaika imee: lähtö siirtyy, mutta ehdit silti', () => {
  const result = replan('Olen 5 min myöhässä', '07:15');
  const [impact] = result.impacts;
  assert.equal(impact.late, false);
  assert.equal(impact.leaveTime, '07:25');
  assert.equal(impact.arrivalTime, '07:55');
  assert.equal(impact.lateMinutes, 0);
  assert.equal(impact.marginMinutes, 5);
  assert.match(result.summary, /Palaveri klo 8\.00: lähtö siirtyy 5 min, lähdet noin klo 7\.25 \(suunniteltu klo 7\.20\)/);
  assert.match(result.summary, /Ehdit silti perille noin klo 7\.55, 5 min ennen alkua/);
  assert.doesNotMatch(result.summary, /myöhästyt/);
  assert.doesNotMatch(result.summary, /väljyys riittää/);
});

test('ennen valmistautumista vapaa aika imee osan: vain ylittävä osa siirtää lähtöä', () => {
  // 6.55 + 15 min = 7.10: valmistautuminen (7.05) alkaa 5 min myöhässä.
  const result = replan('Olen 15 min myöhässä', '06:55');
  const [impact] = result.impacts;
  assert.equal(impact.delayMinutes, 5);
  assert.equal(impact.leaveTime, '07:25');
  assert.equal(impact.arrivalTime, '07:55');
  assert.equal(impact.late, false);
});

test('myöhästyminen ei ulotu lähtöön: väljyys riittää yhä, lähtöä ei mainita', () => {
  // 6.30 + 15 min = 6.45, valmistautuminen alkaa vasta 7.05.
  const result = replan('Olen 15 min myöhässä', '06:30');
  assert.deepEqual([...result.impacts], []);
  assert.match(result.summary, /Mitään ei tarvitse siirtää: väljyys riittää/);
});

test('lähtöhetki on jo mennyt: kerrotaan perilläolo ilman menneeseen osuvaa lähtöaikaa', () => {
  // 7.40: lähtö olisi ollut 7.20, myöhästyneenäkin 7.35 -- molemmat menneitä.
  const result = replan('Olen 15 min myöhässä', '07:40');
  const [impact] = result.impacts;
  assert.equal(impact.late, true);
  assert.equal(impact.arrivalTime, '08:05');
  assert.equal(impact.lateMinutes, 5);
  assert.doesNotMatch(result.summary, /lähdet noin/);
  assert.match(result.summary, /Palaveri klo 8\.00: olet perillä noin klo 8\.05, eli myöhästyt noin 5 min/);
});

test('jo alkanutta menoa ei arvioida uudelleen', () => {
  const result = replan('Olen 15 min myöhässä', '08:10');
  assert.deepEqual([...result.impacts], []);
});

test('meno ilman lähtöä (ei paikkaa): alku osuu myöhästymiseen -> myöhästyt, ei "väljyys riittää"', () => {
  const events = [{ id: 'e-call', title: 'Puhelu', date: WED, startTime: '08:00', endTime: '08:30' }];
  const result = replan('Olen 15 min myöhässä', '07:50', { events });
  assert.deepEqual([...result.changes], []);
  assert.equal(result.impacts.length, 1);
  const [impact] = result.impacts;
  assert.equal(impact.kind, 'start');
  assert.equal(impact.leaveTime, null);
  assert.equal(impact.arrivalTime, '08:05');
  assert.equal(impact.lateMinutes, 5);
  assert.match(result.summary, /Puhelu klo 8\.00: ehdit vasta noin klo 8\.05, eli myöhästyt noin 5 min/);
  assert.doesNotMatch(result.summary, /väljyys riittää/);
  assert.ok(result.warnings.includes('Puhelu klo 8.00 on kiinteä, eikä sitä siirretä.'));
});

test('itse ajastettu tehtävä, johon myöhästyminen osuu: myöhästyminen kerrotaan', () => {
  const tasks = [{
    id: 't-own', title: 'Oma soitto', date: WED, time: '12:00', endTime: '12:15', durationMinutes: null,
    completed: false, schedulingState: 'manual', priority: 'normaali'
  }];
  const result = replan('Olen 30 min myöhässä', '11:45', { events: [], tasks });
  assert.equal(result.impacts.length, 1);
  assert.equal(result.impacts[0].kind, 'start');
  assert.equal(result.impacts[0].lateMinutes, 15);
  assert.match(result.summary, /Oma soitto klo 12\.00: ehdit vasta noin klo 12\.15, eli myöhästyt noin 15 min/);
});

test('joustavat siirrot ja lähtö samassa vastauksessa: tehtävä kiertää lähtöketjun', () => {
  const tasks = [{
    id: 't-mail', title: 'Sähköpostit', date: WED, time: '06:50', endTime: '07:05', durationMinutes: null,
    completed: false, schedulingState: 'auto', priority: 'normaali'
  }];
  const result = replan('Olen 15 min myöhässä', '06:55', { tasks });
  const mail = result.changes.find(change => change.taskId === 't-mail');
  assert.ok(mail, 'käynnissä oleva joustava siirtyy');
  assert.ok(toMinutes(mail.to.time) >= toMinutes('09:00'), 'ei valmistautumisen, matkan eikä palaverin päälle');
  assert.equal(result.impacts[0].delayMinutes, 5);
  assert.match(result.summary, /1 joustava kohde siirtyy myöhemmäksi/);
  assert.match(result.summary, /lähtö siirtyy 5 min/);
});

test('"tämä kestää vielä 30 min" ennen valmistautumista: lähtö myöhästyy saman säännön mukaan', () => {
  const tasks = [{
    id: 't-work', title: 'Raportti', date: WED, time: '06:30', endTime: '07:00', durationMinutes: null,
    completed: false, schedulingState: 'auto', priority: 'normaali'
  }];
  // 6.50 + 30 min = 7.20: valmistautuminen (7.05) alkaa 15 min myöhässä.
  const result = replan('Tämä työ kestää vielä 30 min', '06:50', { tasks });
  assert.equal(result.kind, 'extend_current');
  const [impact] = result.impacts;
  assert.equal(impact.delayMinutes, 15);
  assert.equal(impact.leaveTime, '07:35');
  assert.equal(impact.arrivalTime, '08:05');
  assert.equal(impact.late, true);
  assert.match(result.summary, /myöhästyt noin 5 min/);
});

test('ilman lähtötietoja entinen käytös: roskasyöte ei kaada eikä keksi lähtöä', () => {
  for (const departures of [null, [], [null], [{}], [{ known: true }], ['x'], [{ known: true, leave: { time: 'x' } }]]) {
    const result = replan('Olen 15 min myöhässä', '06:30', { departures });
    assert.deepEqual([...result.impacts], []);
    assert.equal(result.requiresConfirmation, true);
  }
});

test('tulos on jäädytetty myös lähtövaikutuksineen', () => {
  const result = replan('Olen 15 min myöhässä', '07:15');
  assert.ok(Object.isFrozen(result.impacts));
  assert.ok(result.impacts.every(entry => Object.isFrozen(entry)));
});
