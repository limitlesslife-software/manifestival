// Lähtömoottori, reittipalvelun tuloksen tarkistus ja lähtömuistutukset.
//
// PERIAATE: lähtöaikaa ei koskaan keksitä. Jokainen testi joko todistaa
// laskennan tiedetyistä syötteistä tai todistaa, ettei tuntemattomista
// syötteistä synny lähtöaikaa eikä ilmoitusta.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { read } from './helpers/sources.mjs';
import { createTestRouteProvider } from './helpers/routeProvider.mjs';
import {
  normalizeTravelPlan, departureSchedule, departureState, leaveAtMinus,
  DEPARTURE_STATE, LEAVE_SOON_MINUTES, LEAVE_NOW_GRACE_MINUTES,
  normalizeRouteResult, withRouteResult, ROUTE_STATUS,
  TRAVEL_SOURCE, TRAVEL_PROVIDER_CONTRACT, hasTravelProvider
} from '../src/domain/travel.js';
import {
  planNotifications, planRange, normalizePreferences, NOTIFICATION_TYPE, PLANNED_TYPES,
  DEPARTURE_ALERT_LEAD_MINUTES
} from '../src/domain/notification.js';
import { intentAt } from '../src/platform/nativeNotifications.js';

const TODAY = '2026-09-20';
const PREFS = normalizePreferences({ enabled: true, maxPerDay: 50, dailyPlanEnabled: false, eveningReviewEnabled: false });

/** Auto, 40 min matka, 5 min pysäköinti, ei valmistautumista: yhteensä 45 min. */
function plan(overrides = {}) {
  return normalizeTravelPlan({
    id: 'p1', title: 'Asiakastapaaminen', destination: 'Kuopio', arrivalDate: TODAY, arrivalTime: '18:00',
    mode: 'driving', travelMinutes: 40, travelSource: TRAVEL_SOURCE.MANUAL,
    preparationMinutes: 0, arrivalBufferMinutes: 5, ...overrides
  });
}

const at = (hhmm, base = plan()) => {
  const [h, m] = hhmm.split(':').map(Number);
  return departureState(base, { todayIso: TODAY, nowMinutes: h * 60 + m });
};

// -------------------------------------------------------------- aikataulu

test('lähtöaika on vähennyslasku: 18:00 - 40 min matka - 5 min pysäköinti = 17:15', () => {
  const schedule = departureSchedule(plan(), { todayIso: TODAY });
  assert.equal(schedule.known, true);
  assert.equal(schedule.leave.time, '17:15');
  assert.equal(schedule.leave.date, TODAY);
  assert.equal(schedule.arrive.time, '18:00');
});

test('valmistautuminen erotetaan lähtöajasta: se on ENNEN lähtöä, ei osa sitä', () => {
  const schedule = departureSchedule(plan({ preparationMinutes: 20 }), { todayIso: TODAY });
  assert.equal(schedule.leave.time, '17:15', 'lähtö ovelta ei muutu valmistautumisesta');
  assert.equal(schedule.prepare.time, '16:55');
});

test('KRIITTINEN: tuntematon kesto ei tuota lähtöaikaa', () => {
  for (const travelMinutes of [null, undefined, 0, -5, NaN]) {
    const schedule = departureSchedule({ ...plan(), travelMinutes }, { todayIso: TODAY });
    assert.equal(schedule.known, false, String(travelMinutes));
    assert.equal(schedule.leave, null);
    assert.match(schedule.reason, /Matka-aikaa ei tiedetä/);
  }
  assert.equal(departureSchedule(normalizeTravelPlan({ destination: 'X', arrivalTime: '10:00' }), { todayIso: TODAY }).known, false);
});

test('puuttuva saapumisaika tai kelvoton päivä ei tuota lähtöaikaa', () => {
  assert.equal(departureSchedule({ ...plan(), arrivalTime: null }, { todayIso: TODAY }).known, false);
  assert.equal(departureSchedule(plan({ arrivalDate: null }), { todayIso: null }).known, false);
  assert.equal(departureSchedule(null, { todayIso: TODAY }).known, false);
});

test('päivätön suunnitelma tulkitaan tämän päivän suunnitelmaksi', () => {
  const schedule = departureSchedule(plan({ arrivalDate: null }), { todayIso: TODAY });
  assert.equal(schedule.leave.date, TODAY);
});

test('keskiyön yli: 08:00 saapuminen + 10 h matka -> edellisen päivän ilta', () => {
  const schedule = departureSchedule(plan({ arrivalTime: '08:00', travelMinutes: 600 }), { todayIso: TODAY });
  assert.equal(schedule.leave.date, '2026-09-19');
  assert.equal(schedule.leave.time, '21:55');
});

test('vuodenvaihde: 2027-01-01 00:30 - 60 min - 5 min = 2026-12-31 23:25', () => {
  const schedule = departureSchedule(plan({ arrivalDate: '2027-01-01', arrivalTime: '00:30', travelMinutes: 60 }), { todayIso: '2026-12-31' });
  assert.deepEqual([schedule.leave.date, schedule.leave.time], ['2026-12-31', '23:25']);
});

test('karkauspäivä ja kuukauden vaihde', () => {
  const leap = departureSchedule(plan({ arrivalDate: '2028-03-01', arrivalTime: '00:10', travelMinutes: 30 }), { todayIso: '2028-02-29' });
  assert.deepEqual([leap.leave.date, leap.leave.time], ['2028-02-29', '23:35']);
  const plain = departureSchedule(plan({ arrivalDate: '2027-03-01', arrivalTime: '00:10', travelMinutes: 30 }), { todayIso: '2027-02-28' });
  assert.deepEqual([plain.leave.date, plain.leave.time], ['2027-02-28', '23:35']);
});

test('kesäajan vaihtopäivät: seinäkelloaika säilyy eikä päivä heilahda', () => {
  // Suomessa 2026-03-29 ja 2026-10-25. Laskenta on seinäkelloa, ei kuluvaa aikaa.
  for (const date of ['2026-03-29', '2026-10-25', '2026-03-28', '2026-10-26']) {
    const schedule = departureSchedule(plan({ arrivalDate: date, arrivalTime: '08:00', travelMinutes: 90 }), { todayIso: date });
    assert.deepEqual([schedule.leave.date, schedule.leave.time], [date, '06:25'], date);
  }
});

test('leaveAtMinus rullaa päivän oikein', () => {
  const schedule = departureSchedule(plan({ arrivalTime: '00:20', travelMinutes: 10 }), { todayIso: TODAY });
  assert.deepEqual(leaveAtMinus(schedule, 10), { date: '2026-09-19', time: '23:55' });
  assert.equal(leaveAtMinus({ known: false }, 5), null);
});

// ---------------------------------------------------------------- tilat

test('esimerkkilause tarkasti: "Lähde noin 17:15, jotta ehdit klo 18:00."', () => {
  const state = at('12:00');
  assert.equal(state.state, DEPARTURE_STATE.NOT_YET);
  assert.equal(state.message, 'Lähde noin 17:15, jotta ehdit klo 18:00.');
});

test('tilat rajoilla: NOT_YET -> PREPARE -> LEAVE_SOON -> LEAVE_NOW -> LATE', () => {
  const p = plan({ preparationMinutes: 30 }); // lähtö 17:15, valmistautuminen alkaa 16:45
  const stateAt = (hhmm) => at(hhmm, p).state;

  assert.equal(stateAt('16:44'), DEPARTURE_STATE.NOT_YET);
  assert.equal(stateAt('16:45'), DEPARTURE_STATE.PREPARE);
  assert.equal(stateAt('16:59'), DEPARTURE_STATE.PREPARE);
  assert.equal(stateAt('17:00'), DEPARTURE_STATE.LEAVE_SOON, `${LEAVE_SOON_MINUTES} min ennen`);
  assert.equal(stateAt('17:14'), DEPARTURE_STATE.LEAVE_SOON);
  assert.equal(stateAt('17:15'), DEPARTURE_STATE.LEAVE_NOW);
  assert.equal(stateAt('17:17'), DEPARTURE_STATE.LEAVE_NOW, `${LEAVE_NOW_GRACE_MINUTES} min armonaika`);
  assert.equal(stateAt('17:18'), DEPARTURE_STATE.LATE);
  assert.equal(stateAt('23:00'), DEPARTURE_STATE.LATE);
});

test('ilman valmistautumista PREPARE-vaihetta ei ole: NOT_YET siirtyy suoraan LEAVE_SOON:iin', () => {
  assert.equal(at('16:59').state, DEPARTURE_STATE.NOT_YET);
  assert.equal(at('17:00').state, DEPARTURE_STATE.LEAVE_SOON);
});

test('LATE kertoo myöhästymisen minuutit, ja mennyt saapumisaika sanotaan suoraan', () => {
  const late = at('17:25');
  assert.equal(late.state, DEPARTURE_STATE.LATE);
  assert.equal(late.minutesLate, 10);
  assert.match(late.message, /Olet 10 min myöhässä/);

  const over = at('18:30');
  assert.match(over.message, /Saapumisaika klo 18:00 kohteeseen Kuopio on jo mennyt/);
});

test('LEAVE_NOW: "Lähde nyt"', () => {
  assert.match(at('17:15').message, /^Lähde nyt kohteeseen Kuopio, jotta ehdit klo 18:00\.$/);
  assert.equal(at('17:15').minutesUntilLeave, 0);
});

test('KRIITTINEN: UNKNOWN ei sisällä lähtöaikaa eikä "Lähde"-kehotusta', () => {
  const state = at('12:00', plan({ travelMinutes: null }));
  assert.equal(state.state, DEPARTURE_STATE.UNKNOWN);
  assert.equal(state.known, false);
  assert.equal(state.minutesUntilLeave, null);
  assert.equal(/Lähde /.test(state.message), false);
  assert.match(state.message, /Kirjaa arvioitu matka-aika itse/);
});

test('rikkinäinen nykyhetki -> UNKNOWN, ei arvausta', () => {
  for (const nowMinutes of [NaN, undefined, null, Infinity]) {
    assert.equal(departureState(plan(), { todayIso: TODAY, nowMinutes }).state, DEPARTURE_STATE.UNKNOWN);
  }
  assert.equal(departureState(plan(), { todayIso: 'huomenna', nowMinutes: 600 }).state, DEPARTURE_STATE.UNKNOWN);
});

test('huomisen matka: tila NOT_YET ja päivä näkyy viestissä', () => {
  const tomorrow = plan({ arrivalDate: '2026-09-21', arrivalTime: '08:00', travelMinutes: 30 });
  const state = departureState(tomorrow, { todayIso: TODAY, nowMinutes: 9 * 60 });
  assert.equal(state.state, DEPARTURE_STATE.NOT_YET);
  assert.match(state.message, /2026-09-21 07:25/);
});

test('yön yli: edellisen illan lähtö on tänään LEAVE_SOON kun saapuminen on aamulla', () => {
  const morning = plan({ arrivalDate: '2026-09-21', arrivalTime: '00:30', travelMinutes: 30 });
  const state = departureState(morning, { todayIso: TODAY, nowMinutes: 23 * 60 + 50 });
  assert.equal(state.state, DEPARTURE_STATE.LEAVE_SOON);
  assert.equal(state.schedule.leave.time, '23:55');
});

test('lähde näkyy erittelyssä: itse arvioitu ja reittipalvelusta', () => {
  assert.match(at('12:00').detail, /Matka 40 min \(itse arvioitu\), pysäköinti ja kävely 5 min\./);
  const viaProvider = at('12:00', plan({ travelSource: TRAVEL_SOURCE.PROVIDER }));
  assert.match(viaProvider.detail, /reittipalvelusta/);
});

test('tila on deterministinen ja lopputulos jäädytetty', () => {
  const a = at('17:10');
  const b = at('17:10');
  assert.deepEqual(a, b);
  assert.ok(Object.isFrozen(a));
});

// ----------------------------------------------- reittipalvelun tulos

const NOW = Date.parse('2026-09-20T15:00:00Z');
const validRoute = (extra = {}) => ({
  status: 'OK', durationSeconds: 2400, distanceMeters: 30500.4, provider: 'testiprovider',
  calculatedAt: '2026-09-20T14:55:00Z', freshUntil: '2026-09-20T15:20:00Z', confidence: 'high', ...extra
});

test('kelvollinen tulos normalisoituu ja on jäädytetty', () => {
  const route = normalizeRouteResult(validRoute(), { nowMs: NOW });
  assert.equal(route.status, ROUTE_STATUS.OK);
  assert.equal(route.durationSeconds, 2400);
  assert.equal(route.distanceMeters, 30500);
  assert.equal(route.provider, 'testiprovider');
  assert.equal(route.confidence, 'high');
  assert.ok(Object.isFrozen(route));
});

test('KRIITTINEN: jokainen puute tekee tuloksesta ERRORin eikä keksi kestoa', () => {
  const bad = [
    null, undefined, 'ok', [], 42, {}, { status: 'ok' }, { status: 'FINE' },
    validRoute({ durationSeconds: 0 }), validRoute({ durationSeconds: -60 }), validRoute({ durationSeconds: NaN }),
    validRoute({ durationSeconds: Infinity }), validRoute({ durationSeconds: '2400' }), validRoute({ durationSeconds: null }),
    validRoute({ durationSeconds: 24 * 3600 + 1 }), validRoute({ durationSeconds: undefined }),
    validRoute({ provider: '' }), validRoute({ provider: '   ' }), validRoute({ provider: 5 }), validRoute({ provider: undefined }),
    validRoute({ calculatedAt: 'eilen' }), validRoute({ calculatedAt: undefined }), validRoute({ freshUntil: undefined }),
    validRoute({ freshUntil: 'pian' }), validRoute({ freshUntil: '2026-09-20T14:55:00Z' }), validRoute({ freshUntil: '2026-09-20T14:00:00Z' }),
    validRoute({ confidence: 'varma' }), validRoute({ confidence: undefined })
  ];
  for (const raw of bad) {
    const route = normalizeRouteResult(raw, { nowMs: NOW });
    assert.equal(route.status, ROUTE_STATUS.ERROR, JSON.stringify(raw));
    assert.equal(route.durationSeconds, null, 'ERROR ei kanna kestoa');
    assert.ok(route.reason);
  }
});

test('UNKNOWN ja ERROR välittyvät ilman kestoa', () => {
  assert.equal(normalizeRouteResult({ status: 'UNKNOWN', durationSeconds: 999 }, { nowMs: NOW }).durationSeconds, null);
  assert.equal(normalizeRouteResult({ status: 'UNKNOWN' }, { nowMs: NOW }).status, ROUTE_STATUS.UNKNOWN);
  assert.equal(normalizeRouteResult({ status: 'ERROR', durationSeconds: 999 }, { nowMs: NOW }).status, ROUTE_STATUS.ERROR);
});

test('vanhentunut tulos on STALE eikä kanna kestoa', () => {
  const route = normalizeRouteResult(validRoute({ freshUntil: '2026-09-20T14:59:59Z' }), { nowMs: NOW });
  assert.equal(route.status, ROUTE_STATUS.STALE);
  assert.equal(route.durationSeconds, null);
  assert.equal(normalizeRouteResult(validRoute({ freshUntil: '2026-09-20T15:00:00Z' }), { nowMs: NOW }).status, ROUTE_STATUS.STALE, 'raja on vanhentunut');
});

test('KRIITTINEN: ilman annettua kelloa tuoreutta ei voi todentaa -> ERROR', () => {
  for (const nowMs of [undefined, NaN, null, '2026']) {
    assert.equal(normalizeRouteResult(validRoute(), { nowMs }).status, ROUTE_STATUS.ERROR);
  }
  assert.equal(normalizeRouteResult(validRoute()).status, ROUTE_STATUS.ERROR);
});

test('etäisyys on valinnainen ja kelvoton etäisyys putoaa nulliksi', () => {
  for (const distanceMeters of [undefined, null, -1, NaN, 'pitkä']) {
    assert.equal(normalizeRouteResult(validRoute({ distanceMeters }), { nowMs: NOW }).distanceMeters, null);
  }
});

test('withRouteResult: tuore tulos -> PROVIDER-lähde, minuutit pyöristetään YLÖSPÄIN', () => {
  const base = plan({ travelMinutes: 25 });
  const result = withRouteResult(base, validRoute({ durationSeconds: 2461 }), { nowMs: NOW });
  assert.equal(result.travelMinutes, 42, '2461 s = 41,02 min -> 42');
  assert.equal(result.travelSource, TRAVEL_SOURCE.PROVIDER);
  assert.equal(result.estimatedAt, '2026-09-20T14:55:00.000Z');
  assert.equal(base.travelMinutes, 25, 'alkuperäistä ei mutatoida');
  assert.equal(base.travelSource, TRAVEL_SOURCE.MANUAL);
});

test('KRIITTINEN: käyttökelvoton tulos jättää käsin kirjatun keston koskemattomaksi', () => {
  const base = plan({ travelMinutes: 25 });
  for (const raw of [{ status: 'UNKNOWN' }, { status: 'ERROR' }, 'roskaa', null,
    validRoute({ freshUntil: '2026-09-20T14:00:00Z', calculatedAt: '2026-09-20T13:00:00Z' }), validRoute({ durationSeconds: 0 })]) {
    assert.equal(withRouteResult(base, raw, { nowMs: NOW }), base);
  }
  assert.equal(withRouteResult(null, validRoute(), { nowMs: NOW }), null);
});

test('KRIITTINEN: ilman tulosta ja ilman käsin kirjattua kestoa kesto pysyy tuntemattomana', () => {
  const unknownPlan = plan({ travelMinutes: null });
  const result = withRouteResult(unknownPlan, { status: 'UNKNOWN' }, { nowMs: NOW });
  assert.equal(result.travelMinutes, null);
  assert.equal(departureState(result, { todayIso: TODAY, nowMinutes: 600 }).state, DEPARTURE_STATE.UNKNOWN);
});

test('testipalvelu: sopimuksen mukainen tulos kulkee tarkistuksen läpi lähtömoottoriin', async () => {
  const provider = createTestRouteProvider({
    table: { 'Koti>Kuopio': 2400 }, now: () => NOW
  });
  const raw = await provider.estimate({ origin: 'Koti', destination: 'Kuopio', departureTime: '2026-09-20T17:00', mode: 'driving' });
  const usable = withRouteResult(plan({ travelMinutes: null }), raw, { nowMs: NOW });
  const state = departureState(usable, { todayIso: TODAY, nowMinutes: 12 * 60 });
  assert.equal(state.known, true);
  assert.equal(state.schedule.leave.time, '17:15');
  assert.match(state.detail, /reittipalvelusta/);
  assert.deepEqual(provider.calls[0].mode, 'driving');
});

test('testipalvelun jokainen virhetila päättyy tuntemattomaan, ei keksittyyn kestoon', async () => {
  for (const mode of ['unknown', 'error', 'garbage', 'stale', 'zero']) {
    const provider = createTestRouteProvider({ table: { 'Koti>Kuopio': 2400 }, mode, now: () => NOW });
    const raw = await provider.estimate({ origin: 'Koti', destination: 'Kuopio', mode: 'driving' });
    const result = withRouteResult(plan({ travelMinutes: null }), raw, { nowMs: NOW });
    assert.equal(result.travelMinutes, null, mode);
  }
  // Poikkeus on kutsujan vastuulla: se ei tuota tulosta lainkaan.
  const thrower = createTestRouteProvider({ mode: 'throw' });
  await assert.rejects(thrower.estimate({ destination: 'X' }));
});

test('reittipalvelua ei ole valittu: hasTravelProvider on epätosi ja sopimus on vain kuvaus', () => {
  assert.equal(hasTravelProvider(), false);
  assert.equal(Object.isFrozen(TRAVEL_PROVIDER_CONTRACT), true);
  assert.equal(typeof TRAVEL_PROVIDER_CONTRACT.estimate, 'undefined');
  assert.match(TRAVEL_PROVIDER_CONTRACT.input, /departureTime/);
  for (const field of ['durationSeconds', 'distanceMeters', 'provider', 'calculatedAt', 'freshUntil', 'confidence']) {
    assert.ok(TRAVEL_PROVIDER_CONTRACT.output.includes(field), field);
  }
});

test('tuotantokoodissa ei ole valereittipalvelua eikä oletuskestoa', () => {
  const travel = read('src/domain/travel.js');
  assert.equal(/testiprovider|createTestRouteProvider/.test(travel), false);
  assert.equal(/travelMinutes:\s*(30|45|60)\b/.test(travel), false, 'oletuskesto');
  assert.equal(/Date\.now\(\)|new Date\(\)/.test(travel.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')), false, 'domain ei lue kelloa');
});

// ------------------------------------------------------ lähtömuistutukset

const departureIntents = (plans, extra = {}) => planNotifications({
  tasks: [], travelPlans: plans, dateIso: TODAY, todayIso: TODAY, preferences: PREFS, ...extra
}).filter(intent => intent.type === NOTIFICATION_TYPE.DEPARTURE_REMINDER);

test('lähtömuistutus syntyy kun kesto tiedetään: 10 min ennen lähtöä', () => {
  const [intent] = departureIntents([plan()]);
  assert.equal(intent.time, '17:05');
  assert.equal(intent.date, TODAY);
  assert.equal(intent.level, 3);
  assert.equal(intent.targetId, 'p1');
  assert.match(intent.body, /Lähde noin 17:15 kohteeseen Kuopio, jotta ehdit klo 18:00 \(matka 40 min, itse arvioitu\)\./);
  assert.equal(DEPARTURE_ALERT_LEAD_MINUTES, 10);
});

test('KRIITTINEN: tuntematon kesto ei tuota ilmoitusta', () => {
  assert.deepEqual(departureIntents([plan({ travelMinutes: null })]), []);
  assert.deepEqual(departureIntents([plan({ travelMinutes: 0 })]), []);
});

test('päivätön suunnitelma ei ajastu ilmoitukseksi (ei toistuvaa vanhentunutta hälytystä)', () => {
  assert.deepEqual(departureIntents([plan({ arrivalDate: null })]), []);
});

test('deterministinen tunniste: aika muuttuu, tunniste pysyy -> uudelleenajastus korvaa, ei kahdenna', () => {
  const [before] = departureIntents([plan()]);
  const [after] = departureIntents([plan({ travelMinutes: 55 })]);
  assert.equal(before.id, after.id);
  assert.equal(before.id, `departure_reminder:p1:${TODAY}`);
  assert.equal(before.time, '17:05');
  assert.equal(after.time, '16:50');
  const again = departureIntents([plan()]);
  assert.equal(again.length, 1);
  assert.deepEqual(again[0], before, 'sama syöte, sama tulos');
});

test('yksi ilmoitus per suunnitelma per päivä, ei ryöppyä', () => {
  const intents = departureIntents([plan(), plan(), plan({ id: 'p2', destination: 'Oulu', arrivalTime: '20:00' })]);
  assert.equal(intents.length, 2, 'sama tunniste ei kahdennu, eri suunnitelma saa omansa');
  assert.deepEqual(intents.map(i => i.targetId), ['p1', 'p2']);
});

test('yön yli: ilmoitus kuuluu sille päivälle jolloin lähtö tapahtuu', () => {
  const morning = plan({ arrivalDate: '2026-09-21', arrivalTime: '00:30', travelMinutes: 30 });
  assert.equal(departureIntents([morning], { dateIso: '2026-09-21' }).length, 0);
  const [intent] = departureIntents([morning], { dateIso: '2026-09-20' });
  assert.deepEqual([intent.date, intent.time], ['2026-09-20', '23:45']);
});

test('rauhoitusaika ei niele aamuvarhaista lähtöilmoitusta, mutta niellee tavallisen muistutuksen', () => {
  const early = plan({ arrivalTime: '06:00', travelMinutes: 60 }); // lähtö 04:55, ilmoitus 04:45
  const intents = planNotifications({
    tasks: [{ id: 't1', title: 'Aikainen', date: TODAY, time: '04:50', completed: false }],
    travelPlans: [early], dateIso: TODAY, todayIso: TODAY, preferences: PREFS
  });
  assert.equal(intents.some(i => i.type === NOTIFICATION_TYPE.DEPARTURE_REMINDER), true);
  assert.equal(intents.some(i => i.type === NOTIFICATION_TYPE.TASK_REMINDER), false, 'rauhoitusaika pätee tehtävälle');
});

test('päiväraja säilyttää lähtömuistutuksen ennen matalampia', () => {
  const prefs = normalizePreferences({ enabled: true, maxPerDay: 1, dailyPlanEnabled: true, eveningReviewEnabled: false });
  const intents = planNotifications({ tasks: [], travelPlans: [plan()], dateIso: TODAY, todayIso: TODAY, preferences: prefs });
  assert.equal(intents.length, 1);
  assert.equal(intents[0].type, NOTIFICATION_TYPE.DEPARTURE_REMINDER);
});

test('pois kytketyt muistutukset eivät tuota lähtöilmoitusta', () => {
  const off = normalizePreferences({ enabled: false });
  assert.deepEqual(planNotifications({ travelPlans: [plan()], dateIso: TODAY, todayIso: TODAY, preferences: off }), []);
});

test('planRange: horisontin sisällä huomisen matka ajastuu, sen ulkopuolinen ei', () => {
  const tomorrow = plan({ id: 'p2', arrivalDate: '2026-09-21', arrivalTime: '09:00' });
  const far = plan({ id: 'p3', arrivalDate: '2026-09-30', arrivalTime: '09:00' });
  const intents = planRange({ tasks: [], routineOccurrences: [], travelPlans: [tomorrow, far], from: TODAY, days: 3, todayIso: TODAY, preferences: PREFS });
  assert.deepEqual(intents.filter(i => i.type === 'departure_reminder').map(i => i.targetId), ['p2']);
});

test('PLANNED_TYPES on tyhjä: lähtömuistutus on toteutettu', () => {
  assert.deepEqual([...PLANNED_TYPES], []);
});

test('alusta saa ajan oikein: lähtöilmoitus muuntuu paikalliseksi hetkeksi', () => {
  const [intent] = departureIntents([plan()]);
  const when = intentAt(intent);
  assert.equal(when.getHours(), 17);
  assert.equal(when.getMinutes(), 5);
});

test('natiiviajastus sallii lähtöilmoituksen lepotilassa (Doze) -- laitehyväksyntä kesken', () => {
  const source = read('src/platform/nativeNotifications.js');
  assert.match(source, /allowWhileIdle: intent\.level >= 4 \|\| intent\.type === 'departure_reminder'/);
});

// ------------------------------------------------ sovelluskerros ja tila

test('sovelluskerros: planUpcoming ottaa matkasuunnitelmat tilasta', async () => {
  const { resetState, setTravelPlans, setNotificationPreferences } = await import('../src/app/state.js');
  const { planUpcoming } = await import('../src/app/notifications.js');
  const { fmtISO, todayMidnight, addDays } = await import('../src/lib/datetime.js');

  resetState();
  const today = todayMidnight();
  const tomorrowIso = fmtISO(addDays(today, 1));
  setNotificationPreferences(normalizePreferences({ enabled: true, maxPerDay: 50, dailyPlanEnabled: false, eveningReviewEnabled: false }));
  setTravelPlans([plan({ id: 'app1', arrivalDate: tomorrowIso, arrivalTime: '10:00' }), plan({ id: 'app2', arrivalDate: tomorrowIso, arrivalTime: '11:00', travelMinutes: null })]);

  const { intents } = planUpcoming(today);
  const departures = intents.filter(i => i.type === 'departure_reminder');
  assert.deepEqual(departures.map(i => i.targetId), ['app1'], 'tuntematon kesto ei ajastu');
  assert.equal(departures[0].date, tomorrowIso);
  resetState();
});

// ----------------------------------------------- paikkaehdotukset (ei historiaa)

test('suggestPlaces: aiemmin kirjoitetut nimet, yleisin ensin, ilman kaksoiskappaleita', async () => {
  const { suggestPlaces, MAX_PLACE_SUGGESTIONS } = await import('../src/domain/travel.js');
  const plans = [
    { origin: 'Koti', destination: 'Työ' },
    { origin: ' koti ', destination: 'Karting-rata' },
    { origin: 'Koti', destination: 'Asiakas X' },
    { origin: null, destination: '' }
  ];
  const rules = [{ place: 'työ' }, { place: 'Kauppa' }, null];
  const result = suggestPlaces(plans, rules);
  assert.deepEqual(result, ['Koti', 'Työ', 'Asiakas X', 'Karting-rata', 'Kauppa']);
  assert.equal(new Set(result.map(name => name.toLocaleLowerCase('fi'))).size, result.length);
  assert.equal(MAX_PLACE_SUGGESTIONS, 8);
});

test('suggestPlaces: raja, tyhjä ja rikkinäinen syöte eivät kaada', async () => {
  const { suggestPlaces } = await import('../src/domain/travel.js');
  const many = Array.from({ length: 30 }, (_, i) => ({ destination: 'Paikka ' + String(i).padStart(2, '0') }));
  assert.equal(suggestPlaces(many, []).length, 8);
  assert.equal(suggestPlaces(many, [], 3).length, 3);
  assert.equal(suggestPlaces(many, [], 999).length, 8, 'yläraja pätee');
  assert.deepEqual(suggestPlaces(many, [], -5), []);
  assert.deepEqual(suggestPlaces(undefined, undefined), []);
  assert.deepEqual(suggestPlaces('ei taulukko', { a: 1 }), []);
});

test('suggestPlaces palauttaa vain nimiä: ei koordinaatteja, tunnisteita eikä muita kenttiä', async () => {
  const { suggestPlaces } = await import('../src/domain/travel.js');
  const result = suggestPlaces([{ id: 'x', origin: 'Koti', destination: 'Työ', latitude: 60.1, lng: 24.9, note: 'salainen' }], []);
  assert.deepEqual(result, ['Koti', 'Työ']);
  assert.equal(JSON.stringify(result).includes('60.1'), false);
});

test('sijaintia ei haeta näkymän renderöinnissä: haku ja lupapyyntö ovat vain painikkeiden käsittelijöissä', () => {
  const source = read('src/app/views/profile.js');
  const html = source.slice(source.indexOf('function locationControlsHtml'), source.indexOf('function wireLocationControls'));
  assert.equal(/\.current\(|requestPermission\(|refreshPermission\(/.test(html), false,
    'sijaintikutsu renderöintifunktiossa = automaattinen pyyntö');
  const wire = source.slice(source.indexOf('function wireLocationControls'));
  for (const call of ['requestPermission()', 'current({ allowPrompt: false })']) {
    const at = wire.indexOf(call);
    assert.ok(at > -1, call);
    assert.ok(wire.lastIndexOf("addEventListener('click'", at) > -1, call + ' ei ole click-käsittelijässä');
  }
  assert.equal(/allowPrompt:\s*true/.test(source), false, 'kokeiluhaku ei saa avata lupadialogia');
});

test('matkanäkymä ei kutsu sijaintia eikä reittipalvelua', () => {
  const travel = read('src/app/views/travel.js');
  assert.equal(/geolocation|platformLocation|location\.current|withRouteResult|estimate\(/.test(travel), false);
});
