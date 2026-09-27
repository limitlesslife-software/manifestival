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
  setCommuteObservations, setSleepLogs, addNoticeToState, replaceNoticeInState
} from '../src/app/state.js';
import { clearAllCollections } from '../src/data/collectionsRepo.js';
import { runEventDepartureSweep, resetDepartureWatch } from '../src/app/departureWatch.js';
import {
  runDailyLifeNotices, eveningBeforeNotice, weekendRhythmNotices, latenessNotice
} from '../src/app/dailyLifeNotices.js';
import {
  departuresOn, departuresLeavingOn, firstCommitmentOn, morningPlanOn, sleepScheduleOn
} from '../src/app/dailyLifeModel.js';
import { calendarInputs } from '../src/app/calendarPlan.js';
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

test('KRIITTINEN: lähtö pian ja lähde nyt ovat eri merkinnät; siirretyn menon uusi lähtö kerrotaan', async () => {
  assert.equal((await runEventDepartureSweep({ now: at(2026, 9, 29, 17, 6) })).created, 1, 'lähtö pian');
  assert.equal((await runEventDepartureSweep({ now: at(2026, 9, 29, 17, 10) })).created, 1, 'lähde nyt on oma merkintänsä');
  assert.equal((await runEventDepartureSweep({ now: at(2026, 9, 29, 17, 11) })).created, 0, 'sama vaihe ei toistu');
  const [soon, leaveNow] = noticesWith('departure|event:e1:');
  assert.notEqual(soon.key, leaveNow.key);
  assert.match(soon.reason, /^Lähtö pian\. .*Lähde klo 17:10/);
  assert.match(leaveNow.reason, /^Lähde nyt\. /);

  // Käyttäjä siirtää menon tuntia myöhemmäksi: uusi lähtö 18.10 kerrotaan.
  setCalendarEvents([{ id: 'e1', title: 'Hammaslääkäri', date: TODAY, startTime: '19:00', durationMinutes: 45, placeId: 'p1' }]);
  assert.equal((await runEventDepartureSweep({ now: at(2026, 9, 29, 18, 6) })).created, 1, 'uuden lähdön lähtö pian');
  assert.equal((await runEventDepartureSweep({ now: at(2026, 9, 29, 18, 10) })).created, 1, 'uuden lähdön lähde nyt');
  const latest = noticesWith('departure|event:e1:').slice(-2);
  for (const n of latest) assert.match(n.reason, /Lähde klo 18:10/);
  assert.equal(noticesWith('departure-change|').length, 0, 'omaa muokkausta ei kerrota muutoksena');
});

test('myöhässä-merkinnän raja lasketaan menon alusta, ei lähtöajasta (pitkä matka)', async () => {
  // Juhlat klo 18.00, matka 120 + etuaika 10 -> lähtö 15.50. Avaus klo 16.31:
  // lähtö meni 41 min sitten, mutta menon alkuun on vielä 89 min.
  setSavedPlaces([{ id: 'p1', name: 'Juhlapaikka', usualTravelMinutes: 120, overheadMinutes: 0, preparationMinutes: 0 }]);
  setCalendarEvents([{ id: 'e3', title: 'Juhlat', date: TODAY, startTime: '18:00', durationMinutes: 60, placeId: 'p1' }]);
  assert.equal((await runEventDepartureSweep({ now: at(2026, 9, 29, 16, 31) })).created, 1, 'vielä ehtii: myöhässä-merkintä');
  assert.equal(noticesWith('departure|event:e3:')[0].level, 'urgent');

  resetDepartureWatch();
  setCalendarEvents([{ id: 'e4', title: 'Juhlat', date: TODAY, startTime: '18:00', durationMinutes: 60, placeId: 'p1' }]);
  assert.equal((await runEventDepartureSweep({ now: at(2026, 9, 29, 18, 30) })).created, 1, '30 min alusta: vielä');
  setCalendarEvents([{ id: 'e5', title: 'Juhlat', date: TODAY, startTime: '18:00', durationMinutes: 60, placeId: 'p1' }]);
  assert.equal((await runEventDepartureSweep({ now: at(2026, 9, 29, 18, 31) })).created, 0, 'yli 30 min alusta: ei enää');
});

test('liikennetiedon minuutin heilahtelu samassa vaiheessa ei tee uutta lähtömerkintää', async () => {
  const id = 'event:e1:2026-09-29';
  const t1 = at(2026, 9, 29, 17, 6);
  assert.equal((await runEventDepartureSweep({ now: t1, providerResults: new Map([[id, route(40, t1)]]) })).created, 1);
  const t2 = at(2026, 9, 29, 17, 7);
  assert.equal((await runEventDepartureSweep({ now: t2, providerResults: new Map([[id, route(41, t2)]]) })).created, 0,
    'lähtö 17.09 on hystereesin sisällä: sama kerrottu lähtö 17.10, sama avain');
});

test('KRIITTINEN: keskiyön jälkeisen menon lähtö tänä iltana tarkistetaan jo tänään; avain ei vaihdu keskiyöllä', async () => {
  // Meno ke 30.9. klo 00.20, matka 40 + etuaika 10 -> lähtö ti 29.9. klo 23.30.
  setCalendarEvents([{ id: 'n1', title: 'Yölento', date: '2026-09-30', startTime: '00:20', durationMinutes: 60, placeId: 'p1' }]);
  const tonight = departuresLeavingOn(TODAY, { now: at(2026, 9, 29, 23, 26) });
  assert.deepEqual(tonight.map(item => item.occurrence.id), ['event:n1:2026-09-30']);
  assert.deepEqual([tonight[0].departure.leave.date, tonight[0].departure.leave.time], [TODAY, '23:30']);
  assert.equal(departuresOn(TODAY, { now: at(2026, 9, 29, 23, 26) }).length, 0, 'päivän omat menot pysyvät ennallaan');

  assert.equal((await runEventDepartureSweep({ now: at(2026, 9, 29, 23, 26) })).created, 1, 'lähtö pian jo edellisenä iltana');
  assert.equal(noticesWith('departure|event:n1:')[0].level, 'warning');
  assert.equal((await runEventDepartureSweep({ now: at(2026, 9, 29, 23, 45) })).created, 1, 'myöhässä');
  // Keskiyön jälkeen sama esiintymä tulee päivän omista menoista: sama avain, ei toista merkintää.
  assert.equal((await runEventDepartureSweep({ now: at(2026, 9, 30, 0, 5) })).created, 0);
  assert.equal(noticesWith('departure|event:n1:').filter(n => n.level === 'urgent').length, 1);
});

test('huomisen meno, jonka lähtö on vasta huomenna, ei kuulu tämän illan kierrokseen', () => {
  setCalendarEvents([{ id: 'm1', title: 'Aamupalaveri', date: '2026-09-30', startTime: '09:00', durationMinutes: 60, placeId: 'p1' }]);
  assert.deepEqual(departuresLeavingOn(TODAY, { now: at(2026, 9, 29, 23, 26) }), []);
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

test('KRIITTINEN: illan ennakko ei kasaudu: yksi merkintä huomista kohti, päivittyy ja poistuu huomisen muuttuessa', async () => {
  setSavedPlaces([{ id: 'p2', name: 'Lentokenttä', usualTravelMinutes: 35, overheadMinutes: 5, preparationMinutes: 10 }]);
  const flight = { id: 'f', title: 'Lento', date: '2026-09-30', startTime: '06:00', durationMinutes: 120, placeId: 'p2' };
  setCalendarEvents([flight]);
  assert.equal((await runDailyLifeNotices({ now: at(2026, 9, 29, 18, 0) })).created, 1);
  const [first] = noticesWith('evening|');
  assert.equal(first.key, 'evening|2026-09-30', 'vakaa avain huomista kohti');

  // Lento siirtyy tuntia myöhemmäksi: sama merkintä kertoo uuden neuvon, toista ei synny.
  setCalendarEvents([{ ...flight, startTime: '07:00' }]);
  assert.equal((await runDailyLifeNotices({ now: at(2026, 9, 29, 18, 30) })).created, 0);
  const moved = noticesWith('evening|');
  assert.equal(moved.length, 1);
  assert.equal(moved[0].id, first.id);
  assert.notEqual(moved[0].reason, first.reason);
  assert.equal(moved[0].reason, eveningBeforeNotice({ now: at(2026, 9, 29, 18, 30) }).reason);

  // Lento perutaan: lukematon, enää paikkansa pitämätön ennakko poistuu.
  setCalendarEvents([]);
  await runDailyLifeNotices({ now: at(2026, 9, 29, 19, 0) });
  assert.deepEqual(noticesWith('evening|'), []);
});

test('illan ennakko: vanhan muotoinen lukematon merkintä korvautuu; luettu jää historiaan', async () => {
  setSavedPlaces([{ id: 'p2', name: 'Lentokenttä', usualTravelMinutes: 35, overheadMinutes: 5, preparationMinutes: 10 }]);
  setCalendarEvents([{ id: 'f', title: 'Lento', date: '2026-09-30', startTime: '06:00', durationMinutes: 120, placeId: 'p2' }]);
  addNoticeToState({ id: 'old', key: 'evening|2026-09-30|19:55', kind: 'reminder', title: 'Huominen alkaa aiemmin', reason: 'vanha', createdDate: TODAY });
  await runDailyLifeNotices({ now: at(2026, 9, 29, 19, 0) });
  assert.deepEqual(noticesWith('evening|').map(n => n.key), ['evening|2026-09-30']);

  const [current] = noticesWith('evening|');
  replaceNoticeInState(current.id, { ...current, status: 'read' });
  setCalendarEvents([]);
  await runDailyLifeNotices({ now: at(2026, 9, 29, 20, 0) });
  assert.deepEqual(noticesWith('evening|').map(n => [n.key, n.status]), [['evening|2026-09-30', 'read']]);
});

test('myöhästelyehdotus: uusi ehdotus korvaa lukemattoman vanhan, hyväksytty poistaa sen', async () => {
  const obs = late => ['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24'].map((d, i) => ({
    id: `o${i}`, placeId: 'p1', observedOn: d, plannedDeparture: '06:05', actualDeparture: late, travelMinutes: 35
  }));
  setCommuteObservations(obs('06:13'));
  await runDailyLifeNotices({ now: at(2026, 9, 29, 12, 0) });
  assert.deepEqual(noticesWith('lateness|').map(n => n.key), ['lateness|10']);
  setCommuteObservations(obs('06:18'));
  await runDailyLifeNotices({ now: at(2026, 9, 29, 12, 5) });
  assert.deepEqual(noticesWith('lateness|').map(n => n.key), ['lateness|15'], 'ristiriitaiset ehdotukset eivät jää rinnakkain');
  setLifeSettings([{ id: 's1', arrivalBufferMinutes: 10, reminderOffsetMinutes: 15 }]);
  await runDailyLifeNotices({ now: at(2026, 9, 29, 12, 10) });
  assert.deepEqual(noticesWith('lateness|'), []);
});

test('KRIITTINEN: keskiyön jälkeinen meno ei korvaa aamun sitoumusta (herätys, uni, unilohko, illan ennakko)', () => {
  setProfile({ sleepTargetHours: 8, defaultWakeTime: '07:00', routineMinutes: 45, commuteMinutes: 20 }, true);
  setSavedPlaces([{ id: 'p2', name: 'Työ', usualTravelMinutes: 40, overheadMinutes: 0, preparationMinutes: 0 }]);
  setLifeSettings([{ id: 's1', arrivalBufferMinutes: 0 }]);
  const meeting = { id: 'w', title: 'Aamupalaveri', date: '2026-09-30', startTime: '07:30', durationMinutes: 60, placeId: 'p2' };
  const now = at(2026, 9, 29, 19, 0);
  const sleepEnds = () => calendarInputs(getState(), { from: TODAY, to: TODAY }).blocks
    .filter(block => block.kind === 'sleep' && block.date === '2026-09-30').map(block => block.endTime);

  setCalendarEvents([meeting]);
  assert.equal(sleepScheduleOn('2026-09-30', { now }).wakeTime, '06:05', 'lähtö 6.50 - aamurutiini 45 min');
  assert.deepEqual(sleepEnds(), ['06:05']);

  // Kotona pidettävä etäpuhelu klo 00.15 samalle päivälle.
  setCalendarEvents([meeting, { id: 'call', title: 'Etäpuhelu', date: '2026-09-30', startTime: '00:15', durationMinutes: 30 }]);
  assert.equal(firstCommitmentOn('2026-09-30', { now }).title, 'Aamupalaveri');
  const plan = morningPlanOn('2026-09-30', { now });
  assert.deepEqual([plan.wakeDate, plan.wakeTime], ['2026-09-30', '06:05']);
  assert.equal(sleepScheduleOn('2026-09-30', { now }).wakeTime, '06:05');
  assert.deepEqual(sleepEnds(), ['06:05'], 'unilohko suojaa unen oikeaan herätykseen asti');
  assert.ok(eveningBeforeNotice({ now }), 'illan ennakko säilyy');
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

test('KRIITTINEN: yksi laskentapolku — sovelluskerroksessa vain calendarPlan.js johtaa lohkot ja aamun', async () => {
  // Kalenteri, Tänään, herätys, muistutukset ja illan ennakko saavat saman
  // lähdön, saman aamun ja samat suojatut lohkot, koska vain yksi moduuli
  // kutsuu lohko- ja aamumoottoria. Toinen kutsuja olisi toinen totuus.
  const fs = await import('node:fs');
  const path = await import('node:path');
  const dir = path.join(process.cwd(), 'src', 'app');
  const files = [];
  const walk = d => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) files.push(full);
    }
  };
  walk(dir);
  const relative = file => path.relative(process.cwd(), file).split(path.sep).join('/');
  const callers = files
    .map(relative)
    .filter(file => /\b(deriveBlocks|planMorning|morningOfDay|sleepSchedulesFor)\s*\(/.test(readCode(file)))
    .sort();
  assert.deepEqual(callers, ['src/app/calendarPlan.js']);
});
