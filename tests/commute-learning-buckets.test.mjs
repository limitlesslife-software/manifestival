// Opittu matka-aika viikonpäivän ja lähtöikkunan mukaan
// (src/domain/commuteLearning.js learnedCommuteFor ja learnedCommuteBuckets,
// src/app/calendarPlan.js departureForOccurrence).
//
// LUPAUKSET
//   - hidas maanantaiaamu ja nopea perjantai samaan paikkaan eivät jaa yhtä
//     lukua, kun kummallekin on vähintään kolme omaa matkaa
//   - liian vähäinen data ei tarkennu: väljempi rajaus (lähtöikkuna,
//     viikonpäivä) tai kaikkien matkojen luku, kuten ennen
//   - jokainen tarkennettu luku kertoo rajauksensa tekstinä
//   - opittua ei käytetä ilman hyväksyntää (place.useLearned)
//
// Viikot: ma 2026-08-31, 09-07, 09-14, 09-21; tapahtumat ma 2026-09-28 ja pe 2026-10-02.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  learnedCommuteFor, learnedCommuteBuckets, learningScopeText, summarizeCommute, preparationSuggestion, LEARNING_SCOPE,
  MIN_LEARNING_OBSERVATIONS
} from '../src/domain/commuteLearning.js';
import { selectTravelEstimate } from '../src/domain/departure.js';
import { ESTIMATE_SOURCE } from '../src/domain/dailyLife.js';
import { addDaysIso } from '../src/domain/fiTemporal.js';
import { expandEventOccurrences } from '../src/domain/calendar.js';
import { departureForOccurrence } from '../src/app/calendarPlan.js';
import { helsinkiOffset } from './helpers/helsinkiOffset.mjs';

const MONDAYS = ['2026-08-31', '2026-09-07', '2026-09-14', '2026-09-21'];

let seq = 0;
function trip(observedOn, plannedDeparture, travelMinutes, placeId = 'work') {
  seq += 1;
  return {
    id: `o${String(seq).padStart(3, '0')}`, placeId, eventId: null, observedOn, weekday: null,
    plannedDeparture, actualDeparture: plannedDeparture, arrivalAt: null, travelMinutes,
    providerMinutes: null, preparationMinutes: 0, overheadMinutes: 0, arrivalResult: null,
    source: 'user_confirmed', createdAt: `${observedOn}T06:00:00Z`, updatedAt: null
  };
}

/** Maanantaisin 8.10 hidas (48–52 min), ti–pe 8.30 nopea (28–30 min). */
function commuteHistory() {
  const list = [];
  const slow = [48, 50, 52, 50];
  const quick = [28, 29, 30];
  MONDAYS.forEach((monday, week) => {
    list.push(trip(monday, '08:10', slow[week]));
    for (let day = 1; day <= 4; day += 1) {
      if (week < 3) list.push(trip(addDaysIso(monday, day), '08:30', quick[(week + day) % 3]));
    }
  });
  return list;
}

const WORK = Object.freeze({
  id: 'work', name: 'Työ', usualTravelMinutes: 30, preparationMinutes: 0, arrivalBufferMinutes: 0,
  overheadMinutes: 0, useLearned: true, travelMode: 'driving'
});

function occurrenceOn(date, time = '09:00') {
  const [occurrence] = expandEventOccurrences({
    events: [{ id: `e-${date}`, title: 'Työ', date, startTime: time, durationMinutes: 480, placeId: 'work' }],
    from: date, to: date
  });
  return occurrence;
}

const plan = (occurrence, place = WORK, observations = commuteHistory()) => departureForOccurrence(occurrence, {
  placesById: new Map([[place.id, place]]), observations, settings: { arrivalBufferMinutes: 0 },
  offsetMinutesFn: helsinkiOffset
});

// ================================================================ domain

test('rajauksen selitys: viikonpäivä ja 30 min lähtöikkuna suomeksi, keskiyön yli oikein', () => {
  assert.equal(learningScopeText({ weekday: 1, timeBucket: '07:30' }), 'maanantaisin klo 7.30–8.00 lähteneet');
  assert.equal(learningScopeText({ weekday: null, timeBucket: '23:30' }), 'klo 23.30–0.00 lähteneet');
  assert.equal(learningScopeText({ weekday: 5, timeBucket: null }), 'perjantaisin lähteneet');
  assert.equal(learningScopeText({ weekday: null, timeBucket: null }), '');
  assert.equal(learningScopeText(null), '');
  assert.equal(learningScopeText({ weekday: 9, timeBucket: '25:00' }), '', 'roska ei tuota tekstiä');
});

test('tarkin rajaus, jolla on vähintään kolme matkaa: viikonpäivä + ikkuna > ikkuna > viikonpäivä > kaikki', () => {
  const history = commuteHistory();
  const overall = summarizeCommute(history, { placeId: 'work' });
  assert.equal(overall.count, 16);

  const monday = learnedCommuteFor(history, { placeId: 'work', weekday: 1, departureTime: '08:12' });
  assert.equal(monday.scope, LEARNING_SCOPE.WEEKDAY_TIME);
  assert.deepEqual([monday.count, monday.median, monday.p80], [4, 50, 52]);
  assert.equal(monday.scopeText, 'maanantaisin klo 8.00–8.30 lähteneet');

  // Lauantaina 8.00-ikkunassa ei ole lauantain matkoja: saman ikkunan matkat (maanantait).
  const saturday = learnedCommuteFor(history, { placeId: 'work', weekday: 6, departureTime: '08:05' });
  assert.equal(saturday.scope, LEARNING_SCOPE.TIME);
  assert.equal(saturday.scopeText, 'klo 8.00–8.30 lähteneet');

  // Maanantai-ilta: ikkunassa ei matkoja, mutta maanantain matkoja on.
  const evening = learnedCommuteFor(history, { placeId: 'work', weekday: 1, departureTime: '17:00' });
  assert.equal(evening.scope, LEARNING_SCOPE.WEEKDAY);
  assert.equal(evening.scopeText, 'maanantaisin lähteneet');

  // Sunnuntai-ilta: ei mitään tarkempaa -> kaikki matkat, kuten ennen, ilman rajaustekstiä.
  const sunday = learnedCommuteFor(history, { placeId: 'work', weekday: 7, departureTime: '17:00' });
  assert.equal(sunday.scope, LEARNING_SCOPE.ALL);
  assert.equal(sunday.scopeText, '');
  assert.deepEqual([sunday.count, sunday.median, sunday.p80], [overall.count, overall.median, overall.p80]);
});

test('harva data ei tarkennu: alle kolmen matkan ryhmä ei koskaan ohita kaikkien matkojen lukua', () => {
  const few = [trip('2026-09-07', '08:10', 60), trip('2026-09-14', '08:10', 62),
    trip('2026-09-08', '08:30', 30), trip('2026-09-09', '08:30', 31), trip('2026-09-10', '08:30', 29)];
  const monday = learnedCommuteFor(few, { placeId: 'work', weekday: 1, departureTime: '08:10' });
  assert.equal(monday.scope, LEARNING_SCOPE.ALL, 'kaksi maanantaita ei riitä omaksi luvukseen');
  assert.equal(monday.count, 5);
  const tooFew = learnedCommuteFor(few.slice(0, 2), { placeId: 'work', weekday: 1, departureTime: '08:10' });
  assert.equal(tooFew.scope, LEARNING_SCOPE.ALL);
  assert.equal(tooFew.count, 2);
  assert.ok(tooFew.count < MIN_LEARNING_OBSERVATIONS);
  assert.equal(learnedCommuteFor(commuteHistory(), { weekday: 1, departureTime: '08:10' }).count, 0, 'paikka on pakollinen');
});

test('lähtöikkuna alustavasta lähdöstä: saman viikonpäivän matkoista, ja lähtöpäivä voi olla edellinen päivä', () => {
  const history = commuteHistory();
  const seen = [];
  // Perjantai: alustava lähtö perjantain omista matkoista (p80 30) -> 8.30-ikkuna.
  const friday = learnedCommuteFor(history, {
    placeId: 'work', weekday: 5,
    leaveFor: rough => {
      seen.push([rough.weekday, rough.count, rough.p80]);
      const minutes = 9 * 60 - rough.p80;
      return { date: '2026-10-02', time: `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}` };
    }
  });
  assert.deepEqual(seen, [[5, 3, 30]], 'alustava luku perjantain matkoista, ei maanantaiden paisuttamasta kokonaisluvusta');
  assert.equal(friday.scope, LEARNING_SCOPE.WEEKDAY_TIME);
  assert.equal(friday.scopeText, 'perjantaisin klo 8.30–9.00 lähteneet');
  assert.equal(friday.p80, 30);

  // Lähtö edellisenä iltana (sunnuntai 23.40) -> sunnuntain rajaus, ei maanantain.
  const crossing = learnedCommuteFor(history, {
    placeId: 'work', weekday: 1, leaveFor: () => ({ date: '2026-09-27', time: '23:40' })
  });
  assert.equal(crossing.scope, LEARNING_SCOPE.ALL);
  const broken = learnedCommuteFor(history, { placeId: 'work', weekday: 1, leaveFor: () => { throw new Error('x'); } });
  assert.equal(broken.scope, LEARNING_SCOPE.WEEKDAY, 'kaatuva laskenta ei kaada: viikonpäivä yksin');
});

test('selitys kertoo rajauksen: "omien matkojesi perusteella (maanantaisin klo 8.00–8.30 lähteneet, 4 matkaa)"', () => {
  const learned = learnedCommuteFor(commuteHistory(), { placeId: 'work', weekday: 1, departureTime: '08:10' });
  const estimate = selectTravelEstimate({ learned, place: { useLearned: true } });
  assert.equal(estimate.source, ESTIMATE_SOURCE.LEARNED);
  assert.equal(estimate.minutes, 52);
  assert.equal(estimate.explanation,
    'Matka-aika omien matkojesi perusteella (maanantaisin klo 8.00–8.30 lähteneet, 4 matkaa) tavallisesti 50 min, varman päälle 52 min.');
  const all = learnedCommuteFor(commuteHistory(), { placeId: 'work', weekday: 7, departureTime: '17:00' });
  assert.match(selectTravelEstimate({ learned: all, place: { useLearned: true } }).explanation,
    /^Matka-aika omien matkojesi perusteella \(16 matkaa\)/, 'kaikkien matkojen selitys ennallaan');
});

test('Paikat: tarkentuneet ryhmät selitettäviksi, eniten matkoja ensin; harva ryhmä ei näy', () => {
  const rows = learnedCommuteBuckets(commuteHistory(), { placeId: 'work' });
  assert.deepEqual(rows.map(row => [row.scope, row.scopeText, row.count, row.median]), [
    [LEARNING_SCOPE.WEEKDAY_TIME, 'maanantaisin klo 8.00–8.30 lähteneet', 4, 50],
    [LEARNING_SCOPE.WEEKDAY_TIME, 'tiistaisin klo 8.30–9.00 lähteneet', 3, 29],
    [LEARNING_SCOPE.WEEKDAY_TIME, 'keskiviikkoisin klo 8.30–9.00 lähteneet', 3, 29]
  ]);
  assert.equal(learnedCommuteBuckets(commuteHistory(), { placeId: 'work', limit: 10 }).length, 5);
  assert.deepEqual(learnedCommuteBuckets(commuteHistory(), { placeId: 'gym' }), []);
  assert.deepEqual(learnedCommuteBuckets(commuteHistory(), {}), []);
  // Saman ikkunan eri päivät, joista millään ei ole kolmea: ikkuna yksin.
  const mixed = [trip('2026-09-07', '07:40', 40), trip('2026-09-08', '07:35', 42), trip('2026-09-09', '07:50', 41)];
  assert.deepEqual(learnedCommuteBuckets(mixed, { placeId: 'work' }).map(row => [row.scope, row.scopeText]),
    [[LEARNING_SCOPE.TIME, 'klo 7.30–8.00 lähteneet']]);
});

test('ROSKA ja determinismi: mikään syöte ei kaada, syötettä ei muuteta', () => {
  const history = commuteHistory();
  const snapshot = JSON.stringify(history);
  for (const junk of [null, undefined, 5, 'x', [], [null, 'x', 3], { placeId: 'work' }]) {
    assert.doesNotThrow(() => learnedCommuteFor(junk, { placeId: 'work', weekday: 1, departureTime: '08:00' }));
    assert.doesNotThrow(() => learnedCommuteFor(history, junk));
    assert.doesNotThrow(() => learnedCommuteBuckets(junk, { placeId: 'work' }));
    assert.doesNotThrow(() => learnedCommuteBuckets(history, junk));
  }
  const a = learnedCommuteBuckets(history, { placeId: 'work', limit: 10 });
  const b = learnedCommuteBuckets([...history].reverse(), { placeId: 'work', limit: 10 });
  assert.deepEqual(a, b, 'järjestys ei riipu syötteen järjestyksestä');
  assert.equal(JSON.stringify(history), snapshot);
  assert.ok(Object.isFrozen(learnedCommuteFor(history, { placeId: 'work' })));
});

test('valmistautumisehdotus: onlyAtCurrentPreparation laskee vain nykyisellä valmistautumisella kuitatut lähdöt', () => {
  const late = (preparationMinutes, actual, prefix) => ['2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17'].map((day, i) => ({
    ...trip(day, '07:30', null), id: `${prefix}${i}`, actualDeparture: actual, preparationMinutes
  }));
  const old = late(10, '07:38', 'a');
  // Ilman rajausta hyväksytty 20 min ehdotettaisiin heti 30 minuutiksi samoista lähdöistä.
  assert.equal(preparationSuggestion(old, { placeId: 'work', currentPreparationMinutes: 20 }).suggestedMinutes, 30);
  assert.equal(preparationSuggestion(old, { placeId: 'work', currentPreparationMinutes: 20, onlyAtCurrentPreparation: true }), null);
  const first = preparationSuggestion(old, { placeId: 'work', currentPreparationMinutes: 10, onlyAtCurrentPreparation: true });
  assert.deepEqual([first.suggestedMinutes, first.count, first.meanLateMinutes], [20, 4, 8]);
  // Uusi näyttö nykyisellä ajalla.
  const fresh = [...old, ...late(20, '07:36', 'b').map(o => ({ ...o, observedOn: '2026-09-2' + o.id.slice(1), createdAt: `2026-09-2${o.id.slice(1)}T06:00:00Z` }))];
  const second = preparationSuggestion(fresh, { placeId: 'work', currentPreparationMinutes: 20, onlyAtCurrentPreparation: true });
  assert.deepEqual([second.suggestedMinutes, second.count], [30, 4]);
  assert.equal(preparationSuggestion(old, { placeId: 'gym', currentPreparationMinutes: 10, onlyAtCurrentPreparation: true }), null,
    'toisen paikan lähdöt eivät todista');
});

// ================================================================ sovelluskerros: yksi laskentapolku

test('KRIITTINEN: maanantaiaamun lähtö hitaista maanantaimatkoista, perjantain nopeista — sama paikka, sama kellonaika', () => {
  const monday = plan(occurrenceOn('2026-09-28'));
  assert.equal(monday.known, true);
  assert.equal(monday.parts.travel, 52);
  assert.equal(monday.leave.time, '08:08');
  assert.match(monday.travelExplanation, /maanantaisin klo 8\.00–8\.30 lähteneet, 4 matkaa/);

  const friday = plan(occurrenceOn('2026-10-02'));
  assert.equal(friday.parts.travel, 30);
  assert.equal(friday.leave.time, '08:30');
  assert.match(friday.travelExplanation, /perjantaisin klo 8\.30–9\.00 lähteneet, 3 matkaa/);

  // Ennen tätä molemmat saivat kaikkien 16 matkan p80:n (48 min).
  assert.equal(summarizeCommute(commuteHistory(), { placeId: 'work' }).p80, 48);
});

test('opittua ei käytetä ilman hyväksyntää; harvalla datalla kaikkien matkojen luku kuten ennen', () => {
  const manual = plan(occurrenceOn('2026-09-28'), { ...WORK, useLearned: false });
  assert.equal(manual.parts.travel, 30, 'oma arvio');
  assert.equal(manual.source, ESTIMATE_SOURCE.USER_SUPPLIED);

  const sparse = [trip('2026-09-07', '08:10', 60), trip('2026-09-08', '08:30', 30),
    trip('2026-09-09', '08:30', 31), trip('2026-09-10', '08:30', 29)];
  const monday = plan(occurrenceOn('2026-09-28'), WORK, sparse);
  const overall = summarizeCommute(sparse, { placeId: 'work' });
  assert.equal(monday.parts.travel, overall.p80);
  assert.match(monday.travelExplanation, /omien matkojesi perusteella \(4 matkaa\)/);

  const none = plan(occurrenceOn('2026-09-28'), WORK, []);
  assert.equal(none.parts.travel, 30, 'ei matkoja: oma arvio');
});
