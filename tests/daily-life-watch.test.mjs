// Menojen lähtöjen seuranta (departureWatch) ja arjen huomautukset
// (dailyLifeNotices) sekä niiden yhteinen laskentapolku (dailyLifeModel).
//
// Kello annetaan aina Date-oliona paikallisessa ajassa; tila rakennetaan
// state.js:n asettajilla. Mitään ei lähetetä verkkoon (muistivarasto).

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { setUser } from '../src/data/session.js';
import {
  resetState, getState, setProfile, setSavedPlaces, setCalendarEvents, setLifeSettings,
  setCommuteObservations, setSleepLogs
} from '../src/app/state.js';
import { clearAllCollections } from '../src/data/collectionsRepo.js';
import { runEventDepartureSweep, resetDepartureWatch } from '../src/app/departureWatch.js';
import {
  runDailyLifeNotices, eveningBeforeNotice, weekendRhythmNotices, latenessNotice
} from '../src/app/dailyLifeNotices.js';
import { departuresOn, firstCommitmentOn, morningPlanOn, sleepScheduleOn } from '../src/app/dailyLifeModel.js';
import { readCode } from './helpers/sources.mjs';

const at = (y, m, d, hh, mm) => new Date(y, m - 1, d, hh, mm);
const TODAY = '2026-09-29'; // tiistai

beforeEach(() => {
  clearAllCollections();
  resetState();
  resetDepartureWatch();
  setUser({ id: 'aaaaaaaa-0000-0000-0000-00000000000a', email: 'a@example.com' });
  setProfile({ sleepTargetHours: 8, defaultWakeTime: '06:30', commuteMinutes: 30, routineMinutes: 45 }, true);
  setSavedPlaces([{ id: 'p1', name: 'Hammaslääkäri', usualTravelMinutes: 40, overheadMinutes: 0, preparationMinutes: 0 }]);
  setLifeSettings([{ id: 's1', arrivalBufferMinutes: 10 }]);
  setCalendarEvents([{ id: 'e1', title: 'Hammaslääkäri', date: TODAY, startTime: '18:00', durationMinutes: 45, placeId: 'p1' }]);
});

const noticesWith = prefix => getState().notices.filter(n => n.key.startsWith(prefix));

test('malli: lähtö 17.10 taaksepäin menosta (etuaika 10, matka 40), yksi laskentapolku', () => {
  const [item] = departuresOn(TODAY, { now: at(2026, 9, 29, 12, 0) });
  assert.equal(item.departure.known, true);
  assert.equal(item.departure.leave.time, '17:10');
  assert.equal(item.departure.arrivalTarget.time, '17:50');
  assert.match(item.departure.explanation, /10 min etuajassa/);
  const first = firstCommitmentOn(TODAY, { now: at(2026, 9, 29, 12, 0) });
  assert.deepEqual([first.startTime, first.leaveTime], ['18:00', '17:10']);
});

test('KRIITTINEN: lähtövaiheista yksi merkintä vaihetta kohti, ei toistoa, ei myöhässä-merkintää puolen tunnin jälkeen', async () => {
  assert.equal((await runEventDepartureSweep({ now: at(2026, 9, 29, 16, 0) })).created, 0, 'ei vielä');
  assert.equal((await runEventDepartureSweep({ now: at(2026, 9, 29, 17, 6) })).created, 1);
  assert.equal((await runEventDepartureSweep({ now: at(2026, 9, 29, 17, 8) })).created, 0, 'sama vaihe ei toistu');
  const due = noticesWith('departure|event:e1:');
  assert.equal(due.length, 1);
  assert.equal(due[0].kind, 'leave_now');
  assert.equal(due[0].targetType, 'calendar_event');

  assert.equal((await runEventDepartureSweep({ now: at(2026, 9, 29, 17, 25) })).created, 1, 'myöhässä on oma merkintänsä');
  assert.equal(noticesWith('departure|event:e1:').filter(n => n.level === 'urgent').length, 1);
  assert.equal((await runEventDepartureSweep({ now: at(2026, 9, 29, 18, 50) })).created, 0);
});

test('tuntematon matka-aika: ei lähtömerkintää eikä arvattua aikaa', async () => {
  setSavedPlaces([{ id: 'p1', name: 'Hammaslääkäri' }]);
  const [item] = departuresOn(TODAY, { now: at(2026, 9, 29, 17, 6) });
  assert.equal(item.departure.known, false);
  assert.equal(item.departure.leave, null);
  assert.equal((await runEventDepartureSweep({ now: at(2026, 9, 29, 17, 6) })).created, 0);
});

/** Liikennetieto, joka on laskettu minuutti ennen kierrosta `now` ja on voimassa 20 min. */
const route = (minutes, now) => ({
  status: 'OK', durationSeconds: minutes * 60, distanceMeters: 20000, provider: 'testi', trafficAware: true,
  calculatedAt: new Date(now.getTime() - 60000).toISOString(),
  validUntil: new Date(now.getTime() + 20 * 60000).toISOString(), confidence: 'medium'
});

test('KRIITTINEN: liikennetiedon muutos kerrotaan vain rajan ylittyessä (hystereesi, ei myrskyä)', async () => {
  const id = 'event:e1:2026-09-29';
  const t1 = at(2026, 9, 29, 14, 0);
  await runEventDepartureSweep({ now: t1, providerResults: new Map([[id, route(40, t1)]]) });
  assert.equal(noticesWith('departure-change|').length, 0, 'ensimmäinen laskenta ei ole muutos');

  const t2 = at(2026, 9, 29, 14, 5);
  await runEventDepartureSweep({ now: t2, providerResults: new Map([[id, route(55, t2)]]) });
  const changes = noticesWith('departure-change|');
  assert.equal(changes.length, 1);
  assert.equal(changes[0].reason, 'Liikenne on hidastunut. Lähtöä kannattaa aikaistaa 15 minuuttia.');

  const t3 = at(2026, 9, 29, 14, 10);
  await runEventDepartureSweep({ now: t3, providerResults: new Map([[id, route(57, t3)]]) });
  assert.equal(noticesWith('departure-change|').length, 1, '2 min muutos ei nouse esiin');

  // Oma arvio (ei liikennetietoa) ei koskaan tuota liikennelausetta.
  resetDepartureWatch();
  await runEventDepartureSweep({ now: at(2026, 9, 29, 14, 15) });
  setSavedPlaces([{ id: 'p1', name: 'Hammaslääkäri', usualTravelMinutes: 70, overheadMinutes: 0, preparationMinutes: 0 }]);
  await runEventDepartureSweep({ now: at(2026, 9, 29, 14, 20) });
  assert.equal(noticesWith('departure-change|').length, 1);
});

test('illan ennakko: vain illalla ja vain kun huominen vaatii aiemman herätyksen; ei toistu', async () => {
  setSavedPlaces([{ id: 'p2', name: 'Työ', usualTravelMinutes: 35, overheadMinutes: 5, preparationMinutes: 10 }]);
  setCalendarEvents([{ id: 'w', title: 'Työ', date: '2026-09-30', startTime: '07:00', durationMinutes: 480, placeId: 'p2' }]);
  assert.equal(eveningBeforeNotice({ now: at(2026, 9, 29, 12, 0) }), null, 'ei päivällä');
  const n = eveningBeforeNotice({ now: at(2026, 9, 29, 19, 0) });
  assert.ok(n, 'huominen alkaa aiemmin');
  assert.match(n.reason, /iltarutiini kannattaa aloittaa/);
  const schedule = sleepScheduleOn('2026-09-30', { now: at(2026, 9, 29, 19, 0) });
  assert.ok(schedule.wakeTime < '06:30');
  const plan = morningPlanOn('2026-09-30', { now: at(2026, 9, 29, 19, 0) });
  assert.equal(plan.wakeTime, schedule.wakeTime, 'aamusuunnitelma ja unirytmi samaa mieltä');

  assert.equal((await runDailyLifeNotices({ now: at(2026, 9, 29, 19, 0) })).created, 1);
  assert.equal((await runDailyLifeNotices({ now: at(2026, 9, 29, 20, 0) })).created, 0, 'sama ilta ei toistu');

  setCalendarEvents([]);
  assert.equal(eveningBeforeNotice({ now: at(2026, 9, 29, 19, 0) }), null, 'tavallinen aamu: ei huomautusta');
});

test('myöhästely: ehdotus vain toistuvasta myöhästymisestä, eikä kun aikaistus on jo tehty', () => {
  const obs = ['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24'].map((d, i) => ({
    id: `o${i}`, placeId: 'p1', observedOn: d, weekday: i + 1, plannedDeparture: '06:05', actualDeparture: '06:13', travelMinutes: 35
  }));
  setCommuteObservations(obs.slice(0, 3));
  assert.equal(latenessNotice({ now: at(2026, 9, 29, 12, 0) }), null, 'kolme havaintoa ei riitä');
  setCommuteObservations(obs);
  const n = latenessNotice({ now: at(2026, 9, 29, 12, 0) });
  assert.ok(n);
  assert.match(n.reason, /Aloitetaanko lähtömuistutus 10 min aikaisemmin\?/);
  assert.equal(n.kind, 'replan');
  setLifeSettings([{ id: 's1', arrivalBufferMinutes: 10, reminderOffsetMinutes: 10 }]);
  assert.equal(latenessNotice({ now: at(2026, 9, 29, 12, 0) }), null, 'jo aikaistettu');
});

test('viikonlopun rytmi: vain la–su; siirtymä kahtena viikonloppuna nostetaan esiin ehdotuksena', () => {
  const logs = [];
  for (const [date, bed, wake] of [
    ['2026-09-07', '22:30', '06:30'], ['2026-09-08', '22:30', '06:30'], ['2026-09-09', '22:30', '06:30'],
    ['2026-09-10', '22:30', '06:30'], ['2026-09-11', '22:30', '06:30'],
    ['2026-09-12', '01:30', '09:45'], ['2026-09-13', '01:15', '09:30'],
    ['2026-09-14', '22:30', '06:30'], ['2026-09-15', '22:30', '06:30'], ['2026-09-16', '22:30', '06:30'],
    ['2026-09-17', '22:30', '06:30'], ['2026-09-18', '22:30', '06:30'],
    ['2026-09-19', '01:30', '09:45'], ['2026-09-20', '01:30', '09:40'],
    ['2026-09-21', '22:30', '06:30'], ['2026-09-22', '22:30', '06:30'], ['2026-09-23', '22:30', '06:30'],
    ['2026-09-24', '22:30', '06:30'], ['2026-09-25', '22:30', '06:30'],
    ['2026-09-26', '01:30', '09:50']
  ]) logs.push({ id: `l-${date}`, wakeDate: date, actualBedtime: bed, actualWake: wake });
  setSleepLogs(logs);
  assert.deepEqual(weekendRhythmNotices({ now: at(2026, 9, 24, 20, 0) }), [], 'arkena ei');
  const sunday = weekendRhythmNotices({ now: at(2026, 9, 27, 10, 0) });
  assert.ok(sunday.some(n => n.key.startsWith('rhythm|')), 'rytmin siirtymä');
  for (const n of sunday) {
    assert.equal(n.kind, 'replan');
    assert.equal(/diagnoosi|sairaus|terveysriski|pitäisi/i.test(n.reason), false, n.reason);
  }
});

test('lokiin ei päädy otsikoita, paikkoja eikä kellonaikoja; vain koodit', () => {
  for (const file of ['src/app/departureWatch.js', 'src/app/dailyLifeNotices.js', 'src/app/dailyLifeModel.js']) {
    const code = readCode(file);
    for (const call of code.match(/logEvent\([^)]*\)/g) || []) {
      assert.equal(/title|name|reason|message|address|time|leave/i.test(call.replace(/^logEvent\('[^']*'/, '')), false, `${file}: ${call}`);
    }
  }
});

test('viikkokatsauksen Arki-osio: omista merkinnöistä, ei tekoälylle eikä tallenneta tilannekuvaan', () => {
  const view = readCode('src/app/views/direction.js');
  assert.match(view, /title: 'Arki', lead: 'Miten arki kantoi\?'/);
  assert.match(view, /dailyLifeSignals\(\{/);
  assert.match(view, /timeZone: deviceTimeZone\(\) \|\| undefined/, 'laitteen vyöhyke, ei oletusmaata');
  for (const file of ['src/ai/alignmentContext.js', 'src/ai/alignmentExplainClient.js', 'src/domain/alignmentReview.js']) {
    assert.equal(/dailyLifeSignals|sleepLogs|wellbeingCheckins|habit/.test(readCode(file)), false, file);
  }
});
