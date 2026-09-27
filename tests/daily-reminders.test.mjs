// Arjen muistutukset: lähtöketju ja muut päivän hetket.
//
// Lähtöketju on muistutuksista vaarallisin: väärä aika tarkoittaa
// myöhästymistä, arvattu aika väärää turvallisuudentunnetta. Testit
// vartioivat tasot, lauseet, tuntemattoman matka-ajan hiljaisuuden,
// keskiyön, kuukauden ja vuoden vaihteen sekä kesäajan ankkurit.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  planDepartureChain, planDailyLifeReminders, firstLeaveOn, LEAVE_SOON_MINUTES,
  DAILY_REMINDER_KIND, DAILY_REMINDER_KINDS
} from '../src/domain/dailyReminders.js';
import { NOTIFICATION_TYPE, NOTIFICATION_TYPES, LEVEL, PLANNED_TYPES } from '../src/domain/notification.js';
import { applyNotificationPolicy, wallClockMinutes } from '../src/domain/notificationPolicy.js';
import { buildAckLog } from '../src/domain/notificationAck.js';
import { DELIVERY, REMINDER_TOPIC, GUIDANCE_STYLE, GUIDANCE_STYLES, HABIT_KIND } from '../src/domain/dailyLife.js';
import { readCode } from './helpers/sources.mjs';

const T = NOTIFICATION_TYPE;
const DAY = '2026-09-28';
const SPEAK_ALL = Object.freeze({
  speechEnabled: true,
  delivery: Object.freeze({
    departure: DELIVERY.SOUND_AND_SPEECH, preparation: DELIVERY.SPEECH, bedtime: DELIVERY.SPEECH,
    meal: DELIVERY.SPEECH, habit: DELIVERY.SPEECH, morning: DELIVERY.SPEECH
  })
});

const departure = (over = {}) => ({
  id: 'event:e1:' + DAY, date: DAY, prepareStart: '07:40', leave: '08:15',
  title: 'Hammaslääkäri', placeName: 'Keskusta', knownTravel: true, ...over
});

const chain = (departures, extra = {}) => planDepartureChain({ departures, todayIso: DAY, ...extra });

/** Deterministinen sekoitus (ei Math.randomia). */
function shuffled(list, seed) {
  const out = [...list];
  let state = seed >>> 0;
  for (let i = out.length - 1; i > 0; i--) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const j = state % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// =====================================================================
// LÄHTÖKETJU
// =====================================================================

test('lähtöketju: kolme vaihetta, tasot Muistutus, Toiminta nyt, Kriittinen', () => {
  const intents = chain([departure()], { settings: SPEAK_ALL });
  assert.deepEqual(intents.map(i => [i.type, i.time, i.level]), [
    [T.DEPARTURE_PREPARE, '07:40', LEVEL.REMINDER],
    [T.DEPARTURE_LEAVE_IN_5, '08:10', LEVEL.ACTION],
    [T.DEPARTURE_LEAVE_NOW, '08:15', LEVEL.CRITICAL]
  ]);
  assert.deepEqual(intents.map(i => i.speech), [
    'Valmistaudu lähtöön.',
    'Viiden minuutin päästä pitää lähteä.',
    'Nyt kannattaa lähteä, jotta olet hyvissä ajoin paikalla.'
  ]);
  assert.deepEqual(intents.map(i => i.topic),
    [REMINDER_TOPIC.PREPARATION, REMINDER_TOPIC.DEPARTURE, REMINDER_TOPIC.DEPARTURE]);
  assert.equal(LEAVE_SOON_MINUTES, 5);
  assert.ok(Object.isFrozen(intents) && intents.every(Object.isFrozen));
});

test('lähtöketjun tekstit ja selitykset ovat suomea ja kertovat lähtöajan', () => {
  const [prepare, soon, now] = chain([departure()]);
  assert.equal(prepare.title, 'Valmistaudu lähtöön');
  assert.equal(prepare.body, 'Hammaslääkäri: lähtö klo 08:15 (Keskusta).');
  assert.match(prepare.reason, /ehdit lähteä klo 08:15/);
  assert.equal(soon.title, 'Lähtö 5 minuutin päästä');
  assert.equal(now.title, 'Nyt on lähdön aika');
  assert.equal(now.departureId, 'event:e1:' + DAY);
  assert.equal(now.leaveTime, '08:15');
  assert.equal(now.placeName, 'Keskusta');
});

test('PUHE VAIN LUVALLA: ilman lupaa ketjulla ei ole puhetta', () => {
  for (const settings of [null, {}, { speechEnabled: false, delivery: SPEAK_ALL.delivery },
    { speechEnabled: true }]) {
    for (const intent of chain([departure()], { settings })) {
      assert.equal(intent.speech, null, JSON.stringify(settings));
    }
  }
  const plain = chain([departure()], { settings: {} });
  assert.deepEqual(plain.map(i => i.delivery), [DELIVERY.SOUND, DELIVERY.SOUND, DELIVERY.SOUND],
    'oletus: ääni (DEFAULT_DELIVERY)');
});

test('KRIITTINEN: tuntematon matka-aika ei tuota ajastettua ketjua', () => {
  for (const knownTravel of [false, undefined, null, 'true', 1, 0]) {
    assert.deepEqual([...chain([departure({ knownTravel })])], [], String(knownTravel));
  }
  assert.deepEqual([...chain([departure({ leave: null })])], [], 'ei lähtöaikaa, ei ketjua');
  assert.deepEqual([...chain([departure({ leave: '25:00' })])], []);
  assert.deepEqual([...chain([departure({ id: '' })])], [], 'tunnisteeton ei ajastu');
});

test('valmistautuminen enintään 5 min: "lähtö pian" korvaa valmistautumismuistutuksen', () => {
  for (const [prepareStart, expected] of [
    ['08:15', [T.DEPARTURE_LEAVE_IN_5, T.DEPARTURE_LEAVE_NOW]],
    ['08:12', [T.DEPARTURE_LEAVE_IN_5, T.DEPARTURE_LEAVE_NOW]],
    ['08:10', [T.DEPARTURE_LEAVE_IN_5, T.DEPARTURE_LEAVE_NOW]],
    ['08:09', [T.DEPARTURE_PREPARE, T.DEPARTURE_LEAVE_IN_5, T.DEPARTURE_LEAVE_NOW]],
    [null, [T.DEPARTURE_LEAVE_IN_5, T.DEPARTURE_LEAVE_NOW]]
  ]) {
    assert.deepEqual(chain([departure({ prepareStart })]).map(i => i.type), expected, String(prepareStart));
  }
});

test('ketjun ajat ovat aina tiukasti kasvavassa järjestyksessä', () => {
  for (let prep = 0; prep <= 120; prep += 1) {
    const leaveAbs = wallClockMinutes(DAY, '08:15');
    const prepareMinutes = 8 * 60 + 15 - prep;
    const prepareStart = `${String(Math.floor(prepareMinutes / 60)).padStart(2, '0')}:${String(prepareMinutes % 60).padStart(2, '0')}`;
    const times = chain([departure({ prepareStart })]).map(i => wallClockMinutes(i.date, i.time));
    for (let i = 1; i < times.length; i++) assert.ok(times[i] > times[i - 1], `prep ${prep}`);
    assert.equal(times.at(-1), leaveAbs);
  }
});

test('keskiyön yli: valmistautuminen edellisenä päivänä, lähtö seuraavana', () => {
  const intents = chain([departure({ date: DAY, prepareStart: '23:50', leave: '00:03' })], { todayIso: '2026-09-27' });
  assert.deepEqual(intents.map(i => [i.date, i.time]), [
    ['2026-09-27', '23:50'], ['2026-09-27', '23:58'], [DAY, '00:03']
  ]);
  // Tunniste on lähdön päivän mukainen, vaikka ilmoitus osuu edelliselle päivälle.
  assert.ok(intents.every(i => i.id.endsWith(':' + DAY)));
});

test('kuukauden ja vuoden vaihde sekä karkauspäivä', () => {
  const newYear = chain([departure({ id: 'uv', date: '2027-01-01', prepareStart: { date: '2026-12-31', time: '23:40' },
    leave: { date: '2027-01-01', time: '00:02' } })], { todayIso: '2026-12-31' });
  assert.deepEqual(newYear.map(i => [i.date, i.time]), [
    ['2026-12-31', '23:40'], ['2026-12-31', '23:57'], ['2027-01-01', '00:02']
  ]);
  const leap = chain([departure({ id: 'k', date: '2028-03-01', leave: '00:01', prepareStart: '23:30' })],
    { todayIso: '2028-02-28' });
  assert.deepEqual(leap.map(i => i.date), ['2028-02-29', '2028-02-29', '2028-03-01']);
  const month = chain([departure({ id: 'kk', date: '2026-10-01', leave: '00:04', prepareStart: null })],
    { todayIso: '2026-09-30' });
  assert.deepEqual(month.map(i => [i.date, i.time]), [['2026-09-30', '23:59'], ['2026-10-01', '00:04']]);
});

test('KESÄAIKA: ketju kantaa ankkurin, jotta alusta laskee todelliset minuutit', () => {
  // 29.3.2026 kello 03–04 ei ole olemassa. Saapumistavoite 04.30, lähtö
  // 120 min ennen: seinäkelloaika 02.30 on tunnin liian myöhään. Ankkuri
  // kertoo alustalle "120 todellista minuuttia ennen 04.30".
  const spring = chain([departure({ id: 'kevat', date: '2026-03-29', leave: '02:30', prepareStart: '02:10',
    arrivalTarget: { date: '2026-03-29', time: '04:30' } })], { todayIso: '2026-03-29' });
  assert.deepEqual(spring.map(i => i.anchor.offsetMinutes), [-140, -125, -120]);
  assert.ok(spring.every(i => i.anchor.date === '2026-03-29' && i.anchor.time === '04:30'));

  // 25.10.2026 kello 03–04 esiintyy kahdesti. Ankkuri pitää keston oikeana.
  const fall = chain([departure({ id: 'syksy', date: '2026-10-25', leave: '03:30', prepareStart: '02:50',
    eventStart: '04:10' })], { todayIso: '2026-10-25' });
  assert.deepEqual(fall.map(i => i.anchor.offsetMinutes), [-80, -45, -40]);
  assert.equal(fall[0].anchor.time, '04:10');

  // Ilman saapumistavoitetta ankkuri on lähtö itse.
  const plain = chain([departure()]);
  assert.deepEqual(plain.map(i => i.anchor.offsetMinutes), [-35, -5, 0]);
  assert.equal(plain[0].anchor.time, '08:15');

  // Lähtöä aiempi "tavoite" on virhe: ei käytetä ankkurina.
  const bad = chain([departure({ arrivalTarget: { date: DAY, time: '07:00' } })]);
  assert.equal(bad[0].anchor.time, '08:15');
});

test('myöhästymiskorjaus aikaistaa koko ketjua ja kertoo sen', () => {
  const intents = chain([departure()], { settings: { reminderOffsetMinutes: 7 } });
  assert.deepEqual(intents.map(i => i.time), ['07:33', '08:03', '08:08']);
  assert.ok(intents.every(i => /7 min aiemmin oman asetuksesi mukaan/.test(i.reason)));
  assert.match(intents[0].body, /lähtö klo 08:15/, 'näytetty lähtöaika on todellinen lähtö');
  for (const bad of [-5, 61, 2.5, '10', null]) {
    assert.deepEqual(chain([departure()], { settings: { reminderOffsetMinutes: bad } }).map(i => i.time),
      ['07:40', '08:10', '08:15'], String(bad));
  }
});

test('TURVA: ohjaustyyli ei siirrä ketjun aikoja; aktiivinen toistaa "lähde nyt" kerran', () => {
  const times = style => chain([departure()], { guidanceStyle: style })
    .filter(i => i.step !== 'repeat').map(i => [i.type, i.date, i.time, i.level]);
  assert.deepEqual(times(GUIDANCE_STYLE.BRISK), times(GUIDANCE_STYLE.CALM));
  assert.deepEqual(times(GUIDANCE_STYLE.ACTIVE), times(GUIDANCE_STYLE.CALM));

  const active = chain([departure()], { guidanceStyle: GUIDANCE_STYLE.ACTIVE, settings: SPEAK_ALL });
  const repeat = active.find(i => i.step === 'repeat');
  assert.equal(repeat.time, '08:18');
  assert.equal(repeat.level, LEVEL.CRITICAL);
  assert.equal(repeat.speech, 'Muistutus: nyt on lähdön aika.');
  const now = active.find(i => i.step === 'now');
  assert.equal(repeat.ackKey, now.ackKey, 'toisto jakaa kuittausavaimen');
  assert.notEqual(repeat.id, now.id);
  assert.equal(chain([departure()], { guidanceStyle: GUIDANCE_STYLE.CALM }).some(i => i.step === 'repeat'), false);

  // Asetuksen tyyli kelpaa, annettu tyyli voittaa.
  assert.ok(chain([departure()], { settings: { guidanceStyle: GUIDANCE_STYLE.ACTIVE } }).some(i => i.step === 'repeat'));
  assert.equal(chain([departure()], { settings: { guidanceStyle: GUIDANCE_STYLE.ACTIVE },
    guidanceStyle: GUIDANCE_STYLE.BRISK }).some(i => i.step === 'repeat'), false);
});

test('kuitattu "lähde nyt" poistaa myös toiston politiikassa', () => {
  const active = chain([departure()], { guidanceStyle: GUIDANCE_STYLE.ACTIVE });
  const now = active.find(i => i.step === 'now');
  const log = buildAckLog([{ type: 'acknowledged', key: now.ackKey, atMs: Date.UTC(2026, 8, 28, 5, 15) }]);
  const result = applyNotificationPolicy(active, { ackLog: log });
  assert.deepEqual(result.map(i => i.step), ['prepare', 'soon']);
});

test('menneet päivät eivät tuota muistutuksia', () => {
  assert.deepEqual([...chain([departure({ date: '2026-09-20' })])], []);
  const straddle = chain([departure({ prepareStart: '23:50', leave: '00:03' })]);
  assert.deepEqual(straddle.map(i => [i.date, i.time]), [[DAY, '00:03']],
    'eiliselle osuvat (23.50 ja 23.58) jäävät pois, tämän päivän säilyy');
  assert.equal(chain([departure()], { todayIso: 'roska' }).length, 3, 'kelvoton tämä päivä: ei suodatusta');
});

test('pelkkä kellonaika tulkitaan suhteessa lähtöön; olio tarkasti', () => {
  const late = chain([departure({ prepareStart: { date: DAY, time: '09:00' } })]);
  assert.deepEqual(late.map(i => i.type), [T.DEPARTURE_LEAVE_IN_5, T.DEPARTURE_LEAVE_NOW],
    'lähdön jälkeinen valmistautuminen on virhe, ei edellinen päivä');
  const huge = chain([departure({ prepareStart: { date: '2026-09-27', time: '08:00' } })]);
  assert.equal(huge.some(i => i.type === T.DEPARTURE_PREPARE), false, 'yli 8 h valmistautuminen ei ole uskottava');
});

test('useampi lähtö: deterministinen, järjestyksestä riippumaton, duplikaatit pois', () => {
  const departures = [
    departure(),
    departure({ id: 'event:e2:' + DAY, leave: '12:00', prepareStart: '11:30', title: 'Lounas' }),
    departure({ id: 'event:e3:' + DAY, leave: '18:05', prepareStart: '17:50', title: 'Treenit' }),
    departure()
  ];
  const expected = JSON.stringify(chain(departures));
  assert.equal(chain(departures).length, 9, 'sama lähtö kahdesti ei kahdennu');
  for (let seed = 1; seed <= 12; seed++) {
    assert.equal(JSON.stringify(chain(shuffled(departures, seed))), expected, 'siemen ' + seed);
  }
  const ids = chain(departures).map(i => i.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('syötettä ei muuteta', () => {
  const input = [departure({ arrivalTarget: { date: DAY, time: '08:50' } })];
  const settings = { ...SPEAK_ALL, delivery: { ...SPEAK_ALL.delivery } };
  const snapshot = JSON.stringify({ input, settings });
  chain(input, { settings });
  assert.equal(JSON.stringify({ input, settings }), snapshot);
});

test('roskasyöte ei koskaan heitä', () => {
  const hostile = {};
  Object.defineProperty(hostile, 'knownTravel', { get() { throw new Error('getteri'); } });
  for (const input of [undefined, null, 5, 'x', [], {}, { departures: 'x' },
    { departures: [null, 1, 'x', [], {}, hostile, departure({ title: 42, placeName: {} })] },
    { departures: [departure({ leave: { date: DAY } }), departure({ date: '2026-02-30', leave: '08:00' })] }]) {
    assert.doesNotThrow(() => planDepartureChain(input));
  }
  const withGarbage = planDepartureChain({ departures: [hostile, departure({ title: 42, placeName: {} })], todayIso: DAY });
  assert.equal(withGarbage.length, 3, 'viallinen ei vie muiden muistutuksia');
  assert.equal(withGarbage[0].body, 'Lähtö: lähtö klo 08:15.', 'otsikon puuttuessa neutraali teksti');
});

test('SUORITUSKYKY: tuhat lähtöä lineaarisesti', () => {
  const departures = Array.from({ length: 1000 }, (_, i) => departure({
    id: 'e' + i, date: `2026-10-${String(1 + (i % 28)).padStart(2, '0')}`,
    leave: `${String(6 + (i % 14)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}`, prepareStart: null
  }));
  const started = performance.now();
  const intents = planDepartureChain({ departures, settings: SPEAK_ALL, guidanceStyle: GUIDANCE_STYLE.ACTIVE });
  const elapsed = performance.now() - started;
  assert.equal(intents.length, 3000);
  assert.ok(elapsed < 2000, `kesti ${Math.round(elapsed)} ms`);
});

test('firstLeaveOn: päivän ensimmäinen tiedossa oleva lähtö', () => {
  const departures = [
    departure({ id: 'a', leave: '12:00' }),
    departure({ id: 'b', leave: '07:05', knownTravel: false }),
    departure({ id: 'c', leave: '08:15' }),
    departure({ id: 'd', date: '2026-09-29', leave: '06:00' })
  ];
  assert.equal(firstLeaveOn(departures, DAY), '08:15', 'tuntematon matka-aika ei kelpaa');
  assert.equal(firstLeaveOn(departures, '2026-09-29'), '06:00');
  assert.equal(firstLeaveOn(departures, '2026-09-30'), null);
  assert.equal(firstLeaveOn(null, DAY), null);
  assert.equal(firstLeaveOn(departures, 'x'), null);
});

// =====================================================================
// MUUT ARJEN MUISTUTUKSET
// =====================================================================

const daily = (entries, extra = {}) => planDailyLifeReminders({ entries, todayIso: DAY, ...extra });

test('lajit ovat ilmoitustyyppejä eivätkä suunniteltuja', () => {
  for (const kind of DAILY_REMINDER_KINDS) {
    assert.ok(NOTIFICATION_TYPES.includes(kind), kind);
    assert.equal(PLANNED_TYPES.includes(kind), false);
  }
  assert.ok(Object.isFrozen(DAILY_REMINDER_KIND));
});

test('ateria: muistutus valmistuksen alkuun, puhe sovitulla lauseella', () => {
  const [meal] = daily([{ kind: 'meal', id: 'm1', date: DAY, time: '17:00', prepMinutes: 30, name: 'Päivällinen' }],
    { settings: SPEAK_ALL });
  assert.equal(meal.type, T.MEAL);
  assert.equal(meal.time, '16:30');
  assert.equal(meal.level, LEVEL.REMINDER);
  assert.equal(meal.topic, REMINDER_TOPIC.MEAL);
  assert.equal(meal.title, 'Päivällinen');
  assert.equal(meal.speech, 'Nyt on hyvä aika aloittaa ruoan valmistus.');
  assert.equal(meal.id, `meal:m1:${DAY}`);
  assert.equal(meal.mealTime, '17:00');

  const [eat] = daily([{ kind: 'meal', id: 'm2', date: DAY, time: '12:00', prepMinutes: null }], { settings: SPEAK_ALL });
  assert.equal(eat.time, '12:00', 'tuntematon valmistusaika ei siirrä muistutusta');
  assert.equal(eat.speech, 'Nyt on hyvä aika syödä.');

  const [breakfast] = daily([{ kind: 'meal', id: 'aamiainen', date: DAY, time: '00:20', prepMinutes: 30 }],
    { todayIso: '2026-09-27' });
  assert.deepEqual([breakfast.date, breakfast.time], ['2026-09-27', '23:50'], 'valmistus keskiyön yli');
  assert.equal(breakfast.id, `meal:aamiainen:${DAY}`, 'tunniste aterian päivän mukaan');
});

test('YKSITYISYYS: tavan muistutus on lukitusnäytöllä neutraali', () => {
  const [habit] = daily([{ kind: 'habit', id: 'h1', date: DAY, time: '10:30', habitKind: HABIT_KIND.NICOTINE, name: 'Nikotiini' }],
    { settings: SPEAK_ALL });
  assert.equal(habit.title, 'Tapojen muutos');
  assert.doesNotMatch(habit.title + habit.body + habit.reason, /nikotiini/i);
  assert.equal(habit.speech, 'Seuraava suunniteltu nikotiiniaika on nyt.', 'puhe vain käyttäjän luvalla');
  assert.equal(daily([{ kind: 'habit', id: 'h1', date: DAY, time: '10:30', habitKind: 'nicotine' }])[0].delivery,
    DELIVERY.SILENT, 'oletus: hiljainen');
  // Monta aikaa samana päivänä: jokainen oma muistutuksensa.
  const many = daily(['09:00', '10:30', '12:00'].map(time => ({ kind: 'habit', id: 'h1', date: DAY, time })));
  assert.equal(new Set(many.map(i => i.id)).size, 3);
});

test('iltarauhoittuminen ja nukkumaanmeno', () => {
  const intents = daily([
    { kind: 'wind_down', date: DAY, time: '22:30', bedtime: '23:00' },
    { kind: 'bedtime', date: DAY, time: '23:00', wakeTime: '06:30' }
  ], { settings: SPEAK_ALL, guidanceStyle: GUIDANCE_STYLE.ACTIVE });
  assert.deepEqual(intents.map(i => i.type), [T.WIND_DOWN, T.BEDTIME]);
  assert.ok(intents.every(i => i.topic === REMINDER_TOPIC.BEDTIME && i.level === LEVEL.REMINDER));
  assert.equal(intents[0].speech, 'Nyt kannattaa aloittaa iltarauhoittuminen. Nukkumaanmeno on kello 23.00.');
  assert.equal(intents[1].speech, 'Nyt on hyvä aika mennä nukkumaan. Herätys on kello 6.30.');
  assert.equal(intents[1].body, 'Herätys klo 06:30.');
});

test('illan ja aamun kooste; aamun kooste vain luvalla', () => {
  const entries = [
    { kind: 'evening_before', date: DAY, time: '20:00', firstLeave: '07:40' },
    { kind: 'morning_brief', date: DAY, time: '06:35', firstLeave: null }
  ];
  const off = daily(entries, { settings: SPEAK_ALL });
  assert.deepEqual(off.map(i => i.type), [T.EVENING_BEFORE], 'aamun kooste vaatii morningBriefEnabled');
  assert.equal(off[0].speech, 'Huomenna ensimmäinen lähtö on kello 7.40.');

  const on = daily(entries, { settings: { ...SPEAK_ALL, morningBriefEnabled: true } });
  assert.deepEqual(on.map(i => i.type), [T.MORNING_BRIEF, T.EVENING_BEFORE]);
  assert.equal(on[0].speech, 'Hyvää huomenta. Tänään ei ole sovittuja lähtöjä.');
  assert.equal(on[0].topic, REMINDER_TOPIC.MORNING);
});

test('aamun kooste läpäisee rauhoitusajan (herätys), iltarauhoittuminen näkyy äänettömästi', () => {
  const intents = daily([
    { kind: 'morning_brief', date: DAY, time: '06:05', firstLeave: '07:00' },
    { kind: 'wind_down', date: DAY, time: '22:30' },
    { kind: 'meal', id: 'yo', date: DAY, time: '23:30' }
  ], { settings: { ...SPEAK_ALL, morningBriefEnabled: true } });
  const result = applyNotificationPolicy(intents, {
    settings: { ...SPEAK_ALL, morningBriefEnabled: true }, preferences: { quietHours: { from: '22:00', to: '06:30' } }
  });
  assert.deepEqual(result.map(i => [i.type, i.delivery]), [
    [T.MORNING_BRIEF, DELIVERY.SPEECH],
    [T.WIND_DOWN, DELIVERY.SILENT]
  ]);
  assert.equal(result[1].speech, null, 'rauhoitusaikana ei puhuta');
});

test('arjen merkinnät: roska ohitetaan, ei heitä, ei muuta syötettä', () => {
  const entries = [
    null, 5, 'x', {}, { kind: 'tuntematon', date: DAY, time: '10:00' },
    { kind: 'meal', date: DAY, time: '10:00' },
    { kind: 'habit', date: DAY, time: '10:00' },
    { kind: 'bedtime', date: '2026-02-30', time: '23:00' },
    { kind: 'bedtime', date: DAY, time: '24:00' },
    { kind: 'meal', id: 'ok', date: DAY, time: '17:00', prepMinutes: -5 },
    { kind: 'meal', id: 'ok2', date: DAY, time: '17:00', prepMinutes: 100000 }
  ];
  const snapshot = JSON.stringify(entries);
  assert.doesNotThrow(() => daily(entries));
  const result = daily(entries);
  assert.deepEqual(result.map(i => [i.targetId, i.time]), [['ok', '17:00'], ['ok2', '17:00']],
    'kelvoton valmistusaika ei siirrä muistutusta');
  assert.equal(JSON.stringify(entries), snapshot);
  for (const input of [undefined, null, 'x', { entries: 'x' }]) {
    assert.deepEqual([...planDailyLifeReminders(input)], []);
  }
});

test('arjen muistutukset ovat deterministisiä', () => {
  const entries = [
    { kind: 'meal', id: 'a', date: DAY, time: '12:00', prepMinutes: 15 },
    { kind: 'meal', id: 'b', date: DAY, time: '17:00', prepMinutes: 30 },
    { kind: 'habit', id: 'h', date: DAY, time: '12:00' },
    { kind: 'bedtime', date: DAY, time: '23:00' }
  ];
  const expected = JSON.stringify(daily(entries));
  for (let seed = 1; seed <= 8; seed++) assert.equal(JSON.stringify(daily(shuffled(entries, seed))), expected);
  for (const style of GUIDANCE_STYLES) {
    assert.deepEqual(daily(entries, { guidanceStyle: style }).map(i => i.time),
      daily(entries).map(i => i.time), 'tyyli ei siirrä aikoja');
  }
});

test('PUHTAUS: ei kelloa, ei alustaa', () => {
  const source = readCode('src/domain/dailyReminders.js');
  for (const forbidden of ['Date.now(', 'new Date(', 'Math.random', 'localStorage', 'console.', 'Capacitor']) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});
