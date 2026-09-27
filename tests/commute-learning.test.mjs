// Oppiminen omista matkoista (src/domain/commuteLearning.js).
//
// PERIAATE: vain käyttäjän kuittaamat matkat, rajattu historia, opittua
// käytetään vasta hyväksyttynä, ja jokainen ehdotus on kysymys eikä muutos.
// Tuntematon kesto on null, ei nolla.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  summarizeCommute, forecastCommute, latenessSuggestion, preparationSuggestion, pruneObservations,
  prunableObservations, timeBucket, observedTravelMinutes, LEARNING_WINDOW, MIN_LEARNING_OBSERVATIONS,
  LATENESS_WINDOW, MIN_LATENESS_OBSERVATIONS, MAX_OBSERVED_TRIP_MINUTES
} from '../src/domain/commuteLearning.js';
import { ESTIMATE_SOURCE, MAX_OBSERVATIONS_PER_PLACE } from '../src/domain/dailyLife.js';

/** Päivä 2026-09-01 + n. */
const day = n => {
  const date = new Date(Date.UTC(2026, 8, 1 + n));
  return date.toISOString().slice(0, 10);
};

let seq = 0;
function obs(overrides = {}) {
  seq += 1;
  const observedOn = overrides.observedOn ?? day(seq % 25);
  return {
    id: `o${String(seq).padStart(4, '0')}`, placeId: 'work', eventId: null, observedOn, weekday: null,
    plannedDeparture: '07:30', actualDeparture: '07:30', arrivalAt: null, travelMinutes: 35,
    providerMinutes: null, preparationMinutes: 10, overheadMinutes: 5, arrivalResult: null,
    source: 'user_confirmed', createdAt: `${observedOn}T08:00:00Z`, updatedAt: null, ...overrides
  };
}

/** Deterministinen sekoitus (ei Math.randomia testeissäkään: toistettavuus). */
function shuffled(list, seed = 7) {
  const out = list.slice();
  let s = seed;
  for (let i = out.length - 1; i > 0; i -= 1) {
    s = (s * 1103515245 + 12345) % 2147483648;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const trips = minutes => minutes.map((travelMinutes, i) => obs({ travelMinutes, observedOn: day(i), id: `t${i}` }));

// ------------------------------------------------------------ aikaikkuna

test('timeBucket: 30 min ikkunat, keskiyö ja kelvoton syöte', () => {
  assert.equal(timeBucket('07:44'), '07:30');
  assert.equal(timeBucket('07:30'), '07:30');
  assert.equal(timeBucket('07:29'), '07:00');
  assert.equal(timeBucket('00:00'), '00:00');
  assert.equal(timeBucket('23:59'), '23:30');
  assert.equal(timeBucket('07:44', 15), '07:30');
  assert.equal(timeBucket('07:44', 60), '07:00');
  assert.equal(timeBucket('07:44', 0), '07:30', 'kelvoton koko -> 30');
  for (const bad of [null, undefined, '7:44', '24:00', '07:60', 744, {}, '']) assert.equal(timeBucket(bad), null);
});

// ------------------------------------------------------------ yhteenveto

test('yhteenveto: mediaani, varman päälle -luku (80 %), min, max ja ikkuna', () => {
  const summary = summarizeCommute(trips([30, 32, 35, 38, 40, 44]), { placeId: 'work' });
  assert.deepEqual({ ...summary, window: { ...summary.window } }, {
    count: 6, median: 37, p80: 40, min: 30, max: 44,
    window: { size: LEARNING_WINDOW, used: 6, from: day(0), to: day(5) },
    placeId: 'work', weekday: null, timeBucket: null
  });
  assert.equal(Object.isFrozen(summary), true);
  assert.equal(Object.isFrozen(summary.window), true);
  // Pariton määrä: keskimmäinen; parillinen: keskiarvo ylöspäin (varovaisempi).
  assert.equal(summarizeCommute(trips([30, 40, 50]), { placeId: 'work' }).median, 40);
  assert.equal(summarizeCommute(trips([30, 31]), { placeId: 'work' }).median, 31);
  assert.equal(summarizeCommute(trips([38]), { placeId: 'work' }).p80, 38);
  assert.equal(summarizeCommute(trips([10, 20, 30, 40, 50]), { placeId: 'work' }).p80, 40);
});

test('KRIITTINEN: tuntematon kesto ei ole nolla, ja ilman matkoja luvut ovat null', () => {
  const summary = summarizeCommute([obs({ travelMinutes: null }), obs({ travelMinutes: 0 }), obs({ travelMinutes: -5 }),
    obs({ travelMinutes: NaN }), obs({ travelMinutes: '40' }), obs({ travelMinutes: 1441 }), obs({ travelMinutes: 40 })], { placeId: 'work' });
  assert.deepEqual([summary.count, summary.median, summary.min], [1, 40, 40]);
  const empty = summarizeCommute([], { placeId: 'work' });
  assert.deepEqual([empty.count, empty.median, empty.p80, empty.min, empty.max, empty.window], [0, null, null, null, null, null]);
});

test('paikka on pakollinen: ilman sitä eri paikkojen matkat eivät sekoitu', () => {
  const list = [...trips([30, 30, 30]), obs({ placeId: 'gym', travelMinutes: 90 })];
  assert.equal(summarizeCommute(list).count, 0);
  assert.equal(summarizeCommute(list, {}).count, 0);
  assert.equal(summarizeCommute(list, { placeId: '' }).count, 0);
  assert.equal(summarizeCommute(list, { placeId: 'gym' }).median, 90);
  assert.equal(summarizeCommute(list, { placeId: 'work' }).max, 30);
});

test('vain uusimmat 20 matkaa lasketaan: vanha tietyö ei vaikuta ikuisesti', () => {
  const old = Array.from({ length: 30 }, (_, i) => obs({ travelMinutes: 90, observedOn: day(i), id: `old${i}` }));
  const recent = Array.from({ length: 20 }, (_, i) => obs({ travelMinutes: 30, observedOn: day(40 + i), id: `new${i}` }));
  const summary = summarizeCommute([...old, ...recent], { placeId: 'work' });
  assert.deepEqual([summary.count, summary.median, summary.max, summary.window.from], [20, 30, 30, day(40)]);
  assert.equal(summarizeCommute([...old, ...recent], { placeId: 'work', windowSize: 25 }).max, 90);
});

test('rajaus viikonpäivällä ja aikaikkunalla (tallennettu tai päivästä johdettu viikonpäivä)', () => {
  // 2026-09-07 on maanantai.
  const list = [
    obs({ observedOn: '2026-09-07', weekday: 1, plannedDeparture: '07:40', travelMinutes: 45, id: 'a' }),
    obs({ observedOn: '2026-09-14', weekday: null, plannedDeparture: '07:35', travelMinutes: 47, id: 'b' }),
    obs({ observedOn: '2026-09-08', weekday: 2, plannedDeparture: '07:40', travelMinutes: 30, id: 'c' }),
    obs({ observedOn: '2026-09-21', weekday: 1, plannedDeparture: null, actualDeparture: '09:10', travelMinutes: 25, id: 'd' })
  ];
  const monday = summarizeCommute(list, { placeId: 'work', weekday: 1 });
  assert.equal(monday.count, 3);
  const mondayMorning = summarizeCommute(list, { placeId: 'work', weekday: 1, timeBucket: '07:45' });
  assert.deepEqual([mondayMorning.count, mondayMorning.median, mondayMorning.timeBucket], [2, 46, '07:30']);
  assert.equal(summarizeCommute(list, { placeId: 'work', timeBucket: '09:00' }).median, 25);
});

test('kesto lasketaan lähtö- ja perilläoloajasta, pysäköinti vähennetään, keskiyön yli', () => {
  assert.equal(observedTravelMinutes(obs({ travelMinutes: null, actualDeparture: '07:42', arrivalAt: '08:20', overheadMinutes: 5 })), 33);
  assert.equal(observedTravelMinutes(obs({ travelMinutes: null, actualDeparture: '23:50', arrivalAt: '00:20', overheadMinutes: null })), 30);
  assert.equal(observedTravelMinutes(obs({ travelMinutes: null, actualDeparture: '08:00', arrivalAt: '08:00' })), null);
  assert.equal(observedTravelMinutes(obs({ travelMinutes: null, actualDeparture: '08:00', arrivalAt: '08:04', overheadMinutes: 5 })), null);
  assert.equal(observedTravelMinutes(obs({ travelMinutes: null, arrivalAt: null })), null);
  assert.equal(observedTravelMinutes(obs({ travelMinutes: 41, actualDeparture: '07:00', arrivalAt: '09:00' })), 41, 'kirjattu voittaa');
  for (const bad of [null, 'x', [], 5]) assert.equal(observedTravelMinutes(bad), null);
});

test('KRIITTINEN: mahdoton havainto hylätään: perillä ennen lähtöä tai yli 12 h matka ei opeta mitään', () => {
  const reversed = obs({ travelMinutes: null, actualDeparture: '08:10', arrivalAt: '08:09', overheadMinutes: 0 });
  assert.equal(observedTravelMinutes(reversed), null, 'kuittaukset väärin päin: ei 1439 min matkaa');
  assert.equal(observedTravelMinutes(obs({ travelMinutes: null, actualDeparture: '08:00', arrivalAt: '20:30', overheadMinutes: 0 })), null,
    'yli 12 h lähdöstä: kirjausvirhe, ei matka');
  assert.equal(observedTravelMinutes(obs({ travelMinutes: null, actualDeparture: '08:00', arrivalAt: '20:00', overheadMinutes: 0 })), MAX_OBSERVED_TRIP_MINUTES);
  // Perilläolorivi (ei lähtöaikaa), johon on aiemmin tallentunut mahdoton kesto.
  assert.equal(observedTravelMinutes(obs({ travelMinutes: 1439, actualDeparture: null, arrivalAt: '08:09' })), null,
    'aiemmin tallentunut mahdoton kesto');
  assert.equal(observedTravelMinutes(obs({ travelMinutes: null, actualDeparture: '23:50', arrivalAt: '00:20', overheadMinutes: null })), 30,
    'keskiyön yli kulkeva matka kelpaa');
  assert.equal(MAX_OBSERVED_TRIP_MINUTES, 720);

  // Kaksi oikeaa matkaa ja yksi mahdoton: opittua kestoa ei vielä ole, eikä lähtö siirry edelliselle päivälle.
  const list = [obs({ travelMinutes: 30 }), obs({ travelMinutes: 32 }), reversed];
  const summary = summarizeCommute(list, { placeId: 'work' });
  assert.deepEqual([summary.count, summary.p80], [2, 32]);
  const forecast = forecastCommute({ observations: list, placeId: 'work', useLearned: true });
  assert.equal(forecast.learnedAvailable, false);
});

test('deterministinen sekoitetulla syötteellä eikä muuta syötettä', () => {
  const list = Array.from({ length: 45 }, (_, i) => obs({ travelMinutes: 20 + ((i * 17) % 40), observedOn: day(i % 30), id: `s${i}` }));
  const snapshot = structuredClone(list);
  const expected = summarizeCommute(list, { placeId: 'work' });
  for (let seed = 1; seed < 20; seed += 1) {
    assert.deepEqual(summarizeCommute(shuffled(list, seed), { placeId: 'work' }), expected, String(seed));
  }
  assert.deepEqual(list, snapshot);
  assert.equal(Object.isFrozen(list[0]), false);
});

// ------------------------------------------------------------ ennuste

test('ennuste: esimerkkiselitys "Viimeisten 6 työmatkan mediaani oli 38 min"', () => {
  const list = trips([34, 36, 38, 38, 40, 44]);
  const forecast = forecastCommute({ observations: list, placeId: 'work', useLearned: true, tripWord: 'työmatkan' });
  assert.equal(forecast.minutes, 40);
  assert.equal(forecast.source, ESTIMATE_SOURCE.LEARNED);
  assert.match(forecast.explanation, /^Viimeisten 6 työmatkan mediaani oli 38 min\./);
  assert.match(forecast.explanation, /Varman päälle lasketaan 40 min/);
  assert.equal(Object.isFrozen(forecast), true);
  const plain = forecastCommute({ observations: trips([38, 38, 38]), useLearned: true });
  assert.equal(plain.explanation, 'Viimeisten 3 matkan mediaani oli 38 min.');
  assert.equal(forecastCommute({ observations: list, useLearned: true, tripWord: 'x<script>' }).explanation.includes('<'), false);
});

test('ennusteen järjestys: liikennetieto -> opittu (hyväksyttynä) -> oma arvio -> tuntematon', () => {
  const list = trips([34, 36, 38, 38, 40, 44]); // mediaani 38, varman päälle 40
  const withProvider = forecastCommute({ provider: 45, observations: list, userMinutes: 30, useLearned: true });
  assert.deepEqual([withProvider.minutes, withProvider.source], [45, ESTIMATE_SOURCE.PROVIDER]);
  const slower = forecastCommute({ provider: 33, observations: list, userMinutes: 30, useLearned: true });
  assert.deepEqual([slower.minutes, slower.source], [40, ESTIMATE_SOURCE.LEARNED], 'varovaisempi voittaa');
  assert.match(slower.explanation, /^Liikennetiedon mukaan 33 min\. Viimeisten 6 matkan/);
  const notAccepted = forecastCommute({ observations: list, userMinutes: 30, useLearned: false });
  assert.deepEqual([notAccepted.minutes, notAccepted.source, notAccepted.learnedAvailable], [30, ESTIMATE_SOURCE.USER_SUPPLIED, true]);
  assert.equal(notAccepted.explanation, 'Oma arviosi: 30 min.');
  const tooFew = forecastCommute({ observations: trips([30, 31]), useLearned: true, userMinutes: 25 });
  assert.deepEqual([tooFew.minutes, tooFew.learnedAvailable], [25, false]);
  assert.equal(MIN_LEARNING_OBSERVATIONS, 3);
  const unknown = forecastCommute({ observations: [], useLearned: true });
  assert.deepEqual([unknown.minutes, unknown.source], [null, ESTIMATE_SOURCE.UNKNOWN]);
  assert.match(unknown.explanation, /Matka-aikaa ei tiedetä/);
  for (const provider of [0, -1, NaN, '40', null]) {
    assert.equal(forecastCommute({ provider, userMinutes: 20 }).minutes, 20, String(provider));
  }
});

test('ennuste: tarkka rajaus palaa koko paikkaan, kun matkoja on alle kolme', () => {
  const list = [
    ...trips([40, 40, 40]).map(o => ({ ...o, observedOn: '2026-09-08', weekday: 2 })),
    obs({ observedOn: '2026-09-07', weekday: 1, travelMinutes: 60, id: 'mon' })
  ];
  const forecast = forecastCommute({ observations: list, placeId: 'work', weekday: 1, useLearned: true });
  assert.equal(forecast.summary.count, 4);
  assert.equal(forecast.minutes, 60);
  const other = forecastCommute({ observations: list, placeId: 'gym', useLearned: true });
  assert.equal(other.minutes, null);
  const given = forecastCommute({ summary: { count: 5, median: 20, p80: 25 }, useLearned: true });
  assert.equal(given.minutes, 25);
});

// ------------------------------------------------------------ myöhästely

const late = minutes => minutes.map((diff, i) => {
  const planned = 7 * 60 + 30;
  const actual = planned + diff;
  const hhmm = m => `${String(Math.floor(((m % 1440) + 1440) % 1440 / 60)).padStart(2, '0')}:${String(((m % 60) + 60) % 60).padStart(2, '0')}`;
  return obs({ plannedDeparture: hhmm(planned), actualDeparture: hhmm(actual), observedOn: day(i), id: `l${i}` });
});

test('myöhästely: esimerkkilause ja pyöristys ylöspäin viiteen', () => {
  const suggestion = latenessSuggestion(late([6, 8, 7, 7]));
  assert.deepEqual({ ...suggestion }, {
    meanLateMinutes: 7, suggestedOffsetMinutes: 10, count: 4,
    message: 'Olet viime kerroilla lähtenyt keskimäärin 7 min suunniteltua myöhemmin. Aloitetaanko lähtömuistutus 10 min aikaisemmin?'
  });
  assert.equal(Object.isFrozen(suggestion), true);
  assert.equal(latenessSuggestion(late([5, 5, 5, 5])).suggestedOffsetMinutes, 5);
  assert.equal(latenessSuggestion(late([5, 5, 5, 6])).suggestedOffsetMinutes, 10);
});

test('myöhästely: rajat -- vähintään 4 lähtöä ja keskimäärin vähintään 5 min', () => {
  assert.equal(latenessSuggestion(late([9, 9, 9])), null, 'kolme ei riitä');
  assert.equal(MIN_LATENESS_OBSERVATIONS, 4);
  assert.equal(latenessSuggestion(late([5, 5, 5, 4])), null, 'keskiarvo 4,75');
  assert.deepEqual(latenessSuggestion(late([-10, 20, 5, 5])), latenessSuggestion(late([-10, 20, 5, 5])));
  assert.equal(latenessSuggestion(late([0, 0, 0, 0, 0])), null);
  assert.equal(latenessSuggestion(late([-5, -5, -5, -5])), null, 'ajoissa lähteminen ei tuota ehdotusta');
  // Vain lähdöt, joilla on molemmat ajat, lasketaan.
  const partial = [...late([10, 10, 10]), obs({ actualDeparture: null, id: 'x1' }), obs({ plannedDeparture: '7:30', id: 'x2' })];
  assert.equal(latenessSuggestion(partial), null);
});

test('myöhästely: yli tunnin poikkeama jää pois, keskiyön yli lasketaan oikein, katto 60 min', () => {
  // Kolmen tunnin ero on muuttunut suunnitelma, ei tapa: se ei yksin käännä ehdotusta.
  assert.equal(latenessSuggestion(late([180, 0, 0, 0, 0, 0, 0, 0, 0, 0])), null);
  assert.equal(latenessSuggestion(late([180, 6, 6, 6])), null, 'poikkeaman jälkeen alle neljä lähtöä');
  assert.equal(latenessSuggestion(late([120, 120, 120, 120])), null);
  assert.equal(latenessSuggestion(late([61, 6, 6, 6, 6])).meanLateMinutes, 6);
  const night = [0, 1, 2, 3].map(i => obs({ plannedDeparture: '23:58', actualDeparture: '00:06', observedOn: day(i), id: `n${i}` }));
  assert.equal(latenessSuggestion(night).meanLateMinutes, 8);
  assert.equal(latenessSuggestion(late([58, 59, 59, 59])).suggestedOffsetMinutes, 60);
  assert.equal(latenessSuggestion(late([60, 60, 60, 60])).suggestedOffsetMinutes, 60);
});

test('myöhästely: vain viimeiset 10 lähtöä; nykyinen aikaistus otetaan huomioon', () => {
  const history = [...late(Array(10).fill(15)), ...late(Array(10).fill(0)).map((o, i) => ({ ...o, observedOn: day(40 + i), id: `r${i}` }))];
  assert.equal(LATENESS_WINDOW, 10);
  assert.equal(latenessSuggestion(history), null, 'viime aikoina ajoissa');
  const list = late([6, 8, 7, 7]);
  assert.equal(latenessSuggestion(list, { currentOffsetMinutes: 10 }), null);
  assert.equal(latenessSuggestion(list, { currentOffsetMinutes: 5 }).suggestedOffsetMinutes, 10);
  assert.equal(latenessSuggestion(list, { currentOffsetMinutes: 'x' }).suggestedOffsetMinutes, 10);
  assert.equal(latenessSuggestion(list, { placeId: 'gym' }), null);
});

test('valmistautuminen: ehdotus on kysymys, ei muutos', () => {
  const list = late([6, 8, 7, 7]);
  const longer = preparationSuggestion(list, { currentPreparationMinutes: 15 });
  assert.deepEqual({ ...longer }, {
    currentMinutes: 15, suggestedMinutes: 25, meanLateMinutes: 7, count: 4,
    message: 'Olet viime kerroilla lähtenyt keskimäärin 7 min suunniteltua myöhemmin. Pidennetäänkö valmistautumista 15 minuutista 25 minuuttiin?'
  });
  const none = preparationSuggestion(list, {});
  assert.equal(none.currentMinutes, null);
  assert.equal(none.message.endsWith('Varataanko valmistautumiseen 10 min?'), true);
  assert.equal(preparationSuggestion(list, { currentPreparationMinutes: 480 }), null, 'yläraja täynnä');
  assert.equal(preparationSuggestion(late([1, 2, 1, 2])), null);
});

// ------------------------------------------------------------ karsinta

test('karsinta: enintään 60 paikkaa kohden, vanhin pois ensin, järjestys säilyy', () => {
  const work = Array.from({ length: 65 }, (_, i) => obs({ placeId: 'work', observedOn: day(i), id: `w${String(i).padStart(2, '0')}` }));
  const gym = Array.from({ length: 3 }, (_, i) => obs({ placeId: 'gym', observedOn: day(i), id: `g${i}` }));
  const list = shuffled([...work, ...gym], 3);
  const kept = pruneObservations(list);
  const removed = prunableObservations(list);
  assert.equal(MAX_OBSERVATIONS_PER_PLACE, 60);
  assert.equal(kept.length, 63);
  assert.deepEqual(removed.map(o => o.id), ['w00', 'w01', 'w02', 'w03', 'w04']);
  assert.deepEqual(kept.map(o => o.id), list.filter(o => !['w00', 'w01', 'w02', 'w03', 'w04'].includes(o.id)).map(o => o.id));
  assert.equal(Object.isFrozen(kept), true);
  assert.equal(pruneObservations(list, 2).filter(o => o.placeId === 'gym').map(o => o.id).sort().join(), 'g1,g2');
  assert.equal(pruneObservations(list, 0).length, 0);
  assert.equal(pruneObservations(list, -1).length, 63, 'kelvoton raja -> 60');
});

test('karsinta: sama päivä ratkaistaan luontihetkellä ja tunnisteella; roska jää pois', () => {
  const list = [
    obs({ observedOn: day(1), createdAt: '2026-09-02T09:00:00Z', id: 'b' }),
    obs({ observedOn: day(1), createdAt: '2026-09-02T07:00:00Z', id: 'c' }),
    obs({ observedOn: day(1), createdAt: '2026-09-02T07:00:00Z', id: 'a' }),
    null, 'x', 5, [], obs({ observedOn: 'eilen', id: 'bad' })
  ];
  assert.deepEqual(prunableObservations(list, 2).map(o => o.id), ['bad', 'a']);
  assert.deepEqual(pruneObservations(list, 2).map(o => o.id), ['b', 'c']);
  for (let seed = 1; seed < 10; seed += 1) {
    assert.deepEqual(prunableObservations(shuffled(list, seed), 2).map(o => o.id), ['bad', 'a']);
  }
});

// ------------------------------------------------------------ kestävyys

test('kelvoton syöte ei koskaan kaada', () => {
  const garbage = [undefined, null, 0, 'x', {}, [null, 1, 'x', [], { placeId: {} }], NaN,
    [{ placeId: 'work', observedOn: {}, createdAt: 5, id: [], travelMinutes: {}, plannedDeparture: 7 }]];
  for (const input of garbage) {
    for (const options of [undefined, null, 'x', { placeId: 'work', weekday: 'ma', timeBucket: 5, windowSize: -1 }]) {
      assert.doesNotThrow(() => summarizeCommute(input, options));
      assert.doesNotThrow(() => latenessSuggestion(input, options));
      assert.doesNotThrow(() => preparationSuggestion(input, options));
      assert.doesNotThrow(() => pruneObservations(input, options));
      assert.doesNotThrow(() => prunableObservations(input, options));
    }
    assert.doesNotThrow(() => forecastCommute(input));
    assert.doesNotThrow(() => forecastCommute({ observations: input, summary: input, provider: input }));
  }
});

test('suorituskyky: 200 000 havaintoa käsitellään lineaarisesti', () => {
  const big = Array.from({ length: 200000 }, (_, i) => ({
    id: `b${i}`, placeId: i % 3 === 0 ? 'work' : `p${i % 500}`, observedOn: day(i % 360),
    createdAt: `x${i}`, plannedDeparture: '07:30', actualDeparture: i % 2 ? '07:36' : '07:31',
    travelMinutes: 20 + (i % 30), weekday: null
  }));
  const started = performance.now();
  const summary = summarizeCommute(big, { placeId: 'work' });
  const suggestion = latenessSuggestion(big);
  const kept = pruneObservations(big);
  const elapsed = performance.now() - started;
  assert.equal(summary.count, LEARNING_WINDOW);
  assert.ok(suggestion === null || suggestion.count === LATENESS_WINDOW);
  assert.ok(kept.length <= 501 * MAX_OBSERVATIONS_PER_PLACE);
  assert.ok(elapsed < 5000, `liian hidas: ${Math.round(elapsed)} ms`);
});
