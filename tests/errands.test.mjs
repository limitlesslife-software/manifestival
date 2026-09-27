// Avoimet asiat ja asioinnit (src/domain/errands.js).
//
// LUPAUKSET
//   - Päivä, jona olet jo menossa samaan paikkaan tai samalle alueelle,
//     voittaa aikaisemman vapaan päivän (heti menon jälkeen).
//   - Määräaika ja päivän kuorma rajaavat aina.
//   - Vain suunnitellut menot: ei sijaintia, ei koordinaatteja.
//   - Pelkkiä ehdotuksia; tuntematon kesto ei ole nolla.
//
// Perusviikko: maanantai 2026-09-28.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readCode, importsOf } from './helpers/sources.mjs';
import {
  proposeOpenEndedSlot, groupErrands, NEARBY, MAX_ERRAND_ALTERNATIVES, MAX_TRIP_GAP_MINUTES, DEFAULT_HORIZON_DAYS
} from '../src/domain/errands.js';
import { DEFAULT_TASK_MINUTES } from '../src/domain/scheduler.js';

const MON = '2026-09-28';

const PLACES = Object.freeze([
  Object.freeze({ id: 'motonet', name: 'Motonet', area: 'Tammisto' }),
  Object.freeze({ id: 'hammas', name: 'Hammaslääkäri', area: 'Tammisto' }),
  Object.freeze({ id: 'apteekki', name: 'Apteekki', area: 'Kamppi' }),
  Object.freeze({ id: 'sali', name: 'Sali', area: 'Kamppi' }),
  Object.freeze({ id: 'posti', name: 'Posti', area: null })
]);

function trip(id, date, time, endTime, placeId, extra = {}) {
  return { id: `event:${id}:${date}`, eventId: id, date, time, endTime, title: extra.title || id, placeId, isEvent: true, source: 'event', allDay: false, ...extra };
}

const TRIPS = Object.freeze([
  trip('hammas', '2026-10-01', '10:00', '11:00', 'hammas', { title: 'Hammaslääkäri' }),
  trip('sali', '2026-09-30', '17:00', '18:00', 'sali', { title: 'Sali' }),
  trip('renkaat', '2026-10-02', '09:00', '09:30', 'motonet', { title: 'Renkaanvaihto' })
]);

const DAYS = Object.freeze([
  { date: '2026-09-28', usableMinutes: 120, freeSlots: [{ start: 600, end: 720 }] },
  { date: '2026-09-29', usableMinutes: 20, freeSlots: [{ start: 600, end: 720 }] },
  { date: '2026-09-30', usableMinutes: 200, freeSlots: [{ startTime: '18:00', endTime: '20:00' }] },
  { date: '2026-10-01', usableMinutes: 200, freeSlots: [{ start: 660, end: 780 }] },
  { date: '2026-10-02', usableMinutes: 200, freeSlots: [{ start: 570, end: 700 }] }
]);

const propose = (task, extra = {}) =>
  proposeOpenEndedSlot({ task, days: DAYS, trips: TRIPS, places: PLACES, todayIso: MON, ...extra });

function assertDeepFrozen(value, path = 'tulos') {
  if (value && typeof value === 'object') {
    assert.ok(Object.isFrozen(value), `${path} ei ole jäädytetty`);
    for (const key of Object.keys(value)) assertDeepFrozen(value[key], `${path}.${key}`);
  }
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

// ================================================================ ehdotus

test('sama paikka voittaa: asia hoidetaan heti menon jälkeen', () => {
  const result = propose({ id: 't1', title: 'Pyyhkijänsulat', durationMinutes: 20, placeId: 'motonet' });
  const { proposal } = result;
  assert.equal(proposal.date, '2026-10-02');
  assert.equal(proposal.time, '09:30');
  assert.equal(proposal.endTime, '09:50');
  assert.equal(proposal.nearby, NEARBY.SAME_PLACE);
  assert.equal(proposal.tripId, 'event:renkaat:2026-10-02');
  assert.equal(proposal.reason,
    'Olet jo menossa perjantaina 2.10. paikkaan Motonet (Renkaanvaihto klo 9.00). Asian voi hoitaa samalla klo 9.30.');
  assert.equal(result.reason, proposal.reason);
  assertDeepFrozen(result);
});

test('sama alue: "Olet jo menossa torstaina lähelle paikkaa Motonet"', () => {
  const tripsWithoutMotonet = TRIPS.filter(t => t.placeId !== 'motonet');
  const { proposal } = propose({ id: 't1', title: 'Pyyhkijänsulat', durationMinutes: 20, placeId: 'motonet' }, { trips: tripsWithoutMotonet });
  assert.equal(proposal.date, '2026-10-01');
  assert.equal(proposal.time, '11:00');
  assert.equal(proposal.nearby, NEARBY.SAME_AREA);
  assert.equal(proposal.reason,
    'Olet jo menossa torstaina 1.10. lähelle paikkaa Motonet: Hammaslääkäri klo 10.00 on samalla alueella (Tammisto). Asian voi hoitaa samalla klo 11.00.');
});

test('vaihtoehdot: eri päiviä, enintään kolme, paras ensin', () => {
  const result = propose({ id: 't1', title: 'Pyyhkijänsulat', durationMinutes: 20, placeId: 'motonet' });
  assert.equal(MAX_ERRAND_ALTERNATIVES, 3);
  assert.ok(result.alternatives.length <= 3);
  const dates = [result.proposal.date, ...result.alternatives.map(a => a.date)];
  assert.equal(new Set(dates).size, dates.length, 'jokainen vaihtoehto on eri päivä');
  assert.equal(result.alternatives[0].nearby, NEARBY.SAME_AREA, 'sama alue ennen tavallista vapaata aikaa');
});

test('KRIITTINEN: määräaika rajaa -- menoa määräajan jälkeen ei käytetä', () => {
  const { proposal, alternatives } = propose({ id: 't1', title: 'Pyyhkijänsulat', durationMinutes: 20, placeId: 'motonet', deadline: '2026-09-30' });
  assert.equal(proposal.date, '2026-09-28');
  assert.equal(proposal.nearby, null);
  assert.match(proposal.reason, /Ehtii ennen määräaikaa ke 30\.9\./);
  for (const entry of [proposal, ...alternatives]) assert.ok(entry.date <= '2026-09-30', entry.date);
});

test('KRIITTINEN: päivän kuorma rajaa -- täysi päivä ei saa asiaa', () => {
  const { proposal, alternatives } = propose({ id: 't2', title: 'Soitto', durationMinutes: 30 });
  for (const entry of [proposal, ...alternatives]) assert.notEqual(entry.date, '2026-09-29', 'ti on vain 20 min vapaata');
});

test('menon jälkeinen väli: yli kolmen tunnin tauko ei ole "samalla"', () => {
  assert.equal(MAX_TRIP_GAP_MINUTES, 180);
  const days = [{ date: '2026-10-02', usableMinutes: 300, freeSlots: [{ start: 800, end: 900 }] }];
  const { proposal } = propose({ id: 't1', title: 'Sulat', durationMinutes: 20, placeId: 'motonet' }, { days });
  assert.equal(proposal.date, '2026-10-02');
  assert.equal(proposal.nearby, null, 'klo 13.20 ei ole enää menon yhteydessä');
  assert.equal(proposal.time, '13:20');
});

test('tuntematon kesto: varataan oletus ja sanotaan se, ei nollaa', () => {
  const { proposal } = propose({ id: 't2', title: 'Resepti', placeText: 'apteekki' }, { nowMinutes: 650 });
  assert.equal(proposal.durationMinutes, DEFAULT_TASK_MINUTES);
  assert.equal(proposal.nearby, NEARBY.SAME_AREA);
  assert.equal(proposal.date, '2026-09-30');
  assert.equal(proposal.time, '18:00');
  assert.match(proposal.reason, new RegExp(`Kestoa ei ole annettu, joten varataan ${DEFAULT_TASK_MINUTES} min\\.`));
});

test('tänään ei ehdoteta mennyttä aikaa', () => {
  const { proposal } = propose({ id: 't3', title: 'Soitto', durationMinutes: 15 }, { nowMinutes: 612 });
  assert.equal(proposal.date, MON);
  assert.equal(proposal.time, '10:15', 'pyöristetty seuraavaan viiteen minuuttiin');
  const late = propose({ id: 't3', title: 'Soitto', durationMinutes: 15 }, { nowMinutes: 800 });
  assert.notEqual(late.proposal.date, MON);
});

test('paikka tekstinä: täsmälleen tallennettu nimi tai alue; tuntematon ei arvaa', () => {
  assert.equal(propose({ title: 'x', durationMinutes: 20, placeText: 'MOTONET' }).proposal.nearby, NEARBY.SAME_PLACE);
  assert.equal(propose({ title: 'x', durationMinutes: 20, placeText: 'tammisto' }).proposal.nearby, NEARBY.SAME_AREA);
  const unknown = propose({ title: 'x', durationMinutes: 20, placeText: 'Moto' });
  assert.equal(unknown.proposal.nearby, null, 'osittainen nimi ei ole paikka');
  assert.equal(unknown.proposal.placeId, null);
});

test('myöhässä oleva asia: aikaisin sopiva päivä', () => {
  const { proposal } = propose({ id: 't1', title: 'Sulat', durationMinutes: 20, placeId: 'motonet', deadline: '2026-09-20' });
  assert.equal(proposal.date, MON);
  assert.match(proposal.reason, /Määräaika on jo mennyt/);
});

test('elämänalueelle varattu päivä voittaa tasatilanteen', () => {
  const days = [
    { date: '2026-09-29', usableMinutes: 100, freeSlots: [{ start: 600, end: 700 }] },
    { date: '2026-09-30', usableMinutes: 100, freeSlots: [{ start: 600, end: 700 }], lifeAreaIds: ['koti'] }
  ];
  const { proposal } = propose({ title: 'Imurointi', durationMinutes: 30, lifeAreaId: 'koti' }, { days, trips: [] });
  assert.equal(proposal.date, '2026-09-30');
  assert.match(proposal.reason, /elämänalueelle/);
});

test('ei tilaa: ehdotus puuttuu ja syy kerrotaan', () => {
  const days = [{ date: MON, usableMinutes: 10, freeSlots: [{ start: 600, end: 610 }] }];
  const result = propose({ title: 'Iso urakka', durationMinutes: 240, deadline: '2026-09-30' }, { days });
  assert.equal(result.proposal, null);
  assert.deepEqual([...result.alternatives], []);
  assert.match(result.reason, /Vapaata aikaa ei löytynyt ennen määräaikaa/);
});

test('horisontti: oletuksena tämä päivä + 6, viikon loppu rajaa', () => {
  assert.equal(DEFAULT_HORIZON_DAYS, 7);
  const days = [{ date: '2026-10-05', usableMinutes: 100, freeSlots: [{ start: 600, end: 700 }] }];
  assert.equal(propose({ title: 'x', durationMinutes: 20 }, { days }).proposal, null);
  assert.equal(propose({ title: 'x', durationMinutes: 20 }, { days, weekEndIso: '2026-10-05' }).proposal.date, '2026-10-05');
});

test('kuukauden ja vuoden vaihde: päivät ja päivälauseet', () => {
  const today = '2026-12-30';
  const days = [{ date: '2027-01-02', usableMinutes: 100, freeSlots: [{ start: 600, end: 700 }] }];
  const trips = [trip('renkaat', '2027-01-02', '09:00', '09:30', 'motonet', { title: 'Renkaanvaihto' })];
  const { proposal } = proposeOpenEndedSlot({
    task: { title: 'Sulat', durationMinutes: 20, placeId: 'motonet' }, days, trips, places: PLACES, todayIso: today
  });
  assert.equal(proposal.date, '2027-01-02');
  assert.match(proposal.reason, /^Olet jo menossa lauantaina 2\.1\. paikkaan Motonet/);
  const tomorrow = proposeOpenEndedSlot({
    task: { title: 'x', durationMinutes: 20 }, days: [{ date: '2026-12-31', freeSlots: [{ start: 600, end: 700 }] }], todayIso: today
  });
  assert.match(tomorrow.proposal.reason, /^Vapaata aikaa huomenna klo 10\.00–10\.20\./);
});

test('kesäajan vaihtopäivät ovat tavallisia kalenteripäiviä', () => {
  const days = [
    { date: '2026-10-25', usableMinutes: 100, freeSlots: [{ start: 180, end: 260 }] },
    { date: '2026-10-26', usableMinutes: 100, freeSlots: [{ start: 600, end: 700 }] }
  ];
  const { proposal } = proposeOpenEndedSlot({ task: { title: 'x', durationMinutes: 60 }, days, todayIso: '2026-10-24' });
  assert.equal(proposal.date, '2026-10-25');
  assert.equal(proposal.time, '03:00');
});

// ================================================================ ryhmittely

test('groupErrands: asiat kootaan suunniteltujen menojen yhteyteen', () => {
  const tasks = [
    { id: 't1', title: 'Pyyhkijänsulat', placeId: 'motonet' },
    { id: 't2', title: 'Resepti', placeText: 'Apteekki' },
    { id: 't4', title: 'Lamppu', placeId: 'motonet' },
    { id: 't5', title: 'Tammiston asia', placeText: 'tammisto' },
    { id: 't6', title: 'Valmis', placeId: 'motonet', completed: true },
    { id: 't7', title: 'Ajastettu', placeId: 'motonet', time: '12:00' },
    { id: 't8', title: 'Ei paikkaa' },
    { id: 't9', title: 'Tuntematon paikka', placeText: 'Kuu' }
  ];
  const groups = groupErrands({ tasks, trips: TRIPS, places: PLACES, todayIso: MON });
  assert.deepEqual(groups.map(g => g.tripId), ['event:sali:2026-09-30', 'event:hammas:2026-10-01', 'event:renkaat:2026-10-02']);
  assert.equal(groups[0].text, 'Olet jo menossa keskiviikkona 30.9. lähelle paikkaa Apteekki: Sali klo 17.00 on samalla alueella (Kamppi). Voit hoitaa samalla: Resepti.');
  assert.equal(groups[1].text, 'Olet jo menossa torstaina 1.10. alueelle Tammisto (Hammaslääkäri klo 10.00). Samalla ehtii: Tammiston asia.');
  assert.equal(groups[2].text, 'Olet jo menossa perjantaina 2.10. paikkaan Motonet (Renkaanvaihto klo 9.00). Voit hoitaa samalla: Lamppu, Pyyhkijänsulat.');
  assert.deepEqual([...groups[2].taskIds], ['t4', 't1']);
  assert.equal(groups[2].nearby, NEARBY.SAME_PLACE);
  const all = groups.flatMap(g => g.taskIds);
  for (const excluded of ['t6', 't7', 't8', 't9']) assert.equal(all.includes(excluded), false, excluded);
  assertDeepFrozen(groups);
});

test('groupErrands: määräaika ja aikaikkuna rajaavat', () => {
  const tasks = [{ id: 't1', title: 'Sulat', placeId: 'motonet', deadline: '2026-10-01' }];
  const groups = groupErrands({ tasks, trips: TRIPS, places: PLACES, todayIso: MON });
  // Sama paikka on vasta perjantaina (määräajan jälkeen): torstain sama alue kelpaa.
  assert.equal(groups.length, 1);
  assert.equal(groups[0].tripId, 'event:hammas:2026-10-01');
  assert.equal(groups[0].nearby, NEARBY.SAME_AREA);
  assert.deepEqual([...groupErrands({ tasks, trips: TRIPS, places: PLACES, todayIso: MON, weekEndIso: '2026-09-29' })], []);
  const past = [trip('vanha', '2026-09-20', '10:00', '11:00', 'motonet')];
  assert.deepEqual([...groupErrands({ tasks: [{ id: 'x', title: 'x', placeId: 'motonet' }], trips: past, places: PLACES, todayIso: MON })], []);
});

test('groupErrands: useampi paikka samalla alueella -> alueen nimi', () => {
  const tasks = [
    { id: 'a', title: 'Resepti', placeId: 'apteekki' },
    { id: 'b', title: 'Treenikassi', placeText: 'kamppi' }
  ];
  const trips = [trip('kokous', '2026-09-29', '12:00', '13:00', null, { title: 'Kokous', area: 'Kamppi' })];
  const [group] = groupErrands({ tasks, trips, places: PLACES, todayIso: MON });
  assert.equal(group.text, 'Olet jo menossa huomenna alueelle Kamppi (Kokous klo 12.00). Samalla ehtii: Resepti, Treenikassi.');
});

test('groupErrands: koko päivän meno ja kellonaika puuttuu', () => {
  const trips = [trip('messut', '2026-09-28', null, null, 'motonet', { title: 'Messut', allDay: true })];
  const [group] = groupErrands({ tasks: [{ id: 'a', title: 'Sulat', placeId: 'motonet' }], trips, places: PLACES, todayIso: MON });
  assert.equal(group.time, null);
  assert.equal(group.text, 'Olet jo menossa tänään paikkaan Motonet (Messut). Voit hoitaa samalla: Sulat.');
});

// ================================================================ laatu

test('determinismi: sekoitettu syöte antaa saman tuloksen', () => {
  const tasks = [
    { id: 't1', title: 'Pyyhkijänsulat', placeId: 'motonet' },
    { id: 't2', title: 'Resepti', placeText: 'Apteekki' },
    { id: 't4', title: 'Lamppu', placeId: 'motonet' }
  ];
  const base = JSON.stringify(groupErrands({ tasks, trips: TRIPS, places: PLACES, todayIso: MON }));
  const baseProposal = JSON.stringify(propose({ title: 'Sulat', durationMinutes: 20, placeId: 'motonet' }));
  const variants = [[2, 0, 1], [1, 2, 0], [2, 1, 0]];
  for (const order of variants) {
    const shuffledTrips = order.map(i => TRIPS[i]);
    const shuffledTasks = order.map(i => tasks[i]);
    const shuffledPlaces = [...PLACES].reverse();
    assert.equal(JSON.stringify(groupErrands({ tasks: shuffledTasks, trips: shuffledTrips, places: shuffledPlaces, todayIso: MON })), base);
    assert.equal(JSON.stringify(proposeOpenEndedSlot({
      task: { title: 'Sulat', durationMinutes: 20, placeId: 'motonet' }, days: [...DAYS].reverse(), trips: shuffledTrips,
      places: shuffledPlaces, todayIso: MON
    })), baseProposal);
  }
});

test('syötteitä ei muuteta', () => {
  const input = deepFreeze({
    task: { title: 'Sulat', durationMinutes: 20, placeId: 'motonet', deadline: '2026-10-05' },
    days: JSON.parse(JSON.stringify(DAYS)), trips: JSON.parse(JSON.stringify(TRIPS)), places: JSON.parse(JSON.stringify(PLACES)),
    todayIso: MON
  });
  const before = JSON.stringify(input);
  assert.doesNotThrow(() => proposeOpenEndedSlot(input));
  assert.doesNotThrow(() => groupErrands({ tasks: [input.task], trips: input.trips, places: input.places, todayIso: MON }));
  assert.equal(JSON.stringify(input), before);
});

test('roskasyöte ei koskaan kaada', () => {
  const trap = { get date() { throw new Error('ansa'); }, id: 'trap' };
  const values = [undefined, null, 0, 'x', [], {}, () => 1, NaN, [null, 5, 'x', trap]];
  for (const value of values) {
    assert.doesNotThrow(() => proposeOpenEndedSlot(value));
    assert.doesNotThrow(() => groupErrands(value));
    assert.doesNotThrow(() => proposeOpenEndedSlot({ task: { title: 'x' }, days: value, trips: value, places: value, todayIso: MON }));
    assert.doesNotThrow(() => groupErrands({ tasks: value, trips: value, places: value, todayIso: MON }));
  }
  assert.doesNotThrow(() => proposeOpenEndedSlot({
    task: { title: 'x', durationMinutes: -5, deadline: '2026-02-30', placeId: 5 }, todayIso: MON,
    days: [{ date: MON, freeSlots: [null, { start: 900, end: 100 }, { startTime: '25:00', endTime: 'x' }, trap] }, trap],
    trips: [trap, { id: 'e', date: MON, time: '99:99' }], places: [trap, { id: 5 }]
  }));
  assert.equal(proposeOpenEndedSlot({ task: { title: 'x' }, todayIso: 'eilen' }).proposal, null);
  assert.deepEqual([...groupErrands({ tasks: [], trips: [], todayIso: null })], []);
});

test('suorituskyky: tuhannet asiat ja menot pysyvät lineaarisina', () => {
  const build = count => {
    const places = [];
    const trips = [];
    const tasks = [];
    for (let i = 0; i < count; i += 1) {
      places.push({ id: `p${i}`, name: `Paikka ${i}`, area: `Alue ${i % 50}` });
      trips.push(trip(`e${i}`, `2026-09-${String(28 + (i % 3)).padStart(2, '0')}`, '10:00', '11:00', `p${i % (count / 2)}`));
      tasks.push({ id: `t${i}`, title: `Asia ${i}`, placeId: `p${(i * 7) % count}` });
    }
    return { places, trips, tasks };
  };
  const time = data => {
    const started = performance.now();
    groupErrands({ ...data, todayIso: MON });
    proposeOpenEndedSlot({ task: data.tasks[0], days: DAYS, trips: data.trips, places: data.places, todayIso: MON });
    return performance.now() - started;
  };
  const small = build(2000);
  const large = build(8000);
  time(small);
  const smallTime = Math.max(1, time(small));
  const largeTime = time(large);
  assert.ok(largeTime < 3000, `liian hidas: ${Math.round(largeTime)} ms`);
  assert.ok(largeTime / smallTime < 24, `kasvu ei ole lineaarista: ${(largeTime / smallTime).toFixed(1)}x`);
});

test('PUHTAUS JA YKSITYISYYS: ei kelloa, arpaa, DOMia, verkkoa, lokia eikä sijaintia', () => {
  const file = 'src/domain/errands.js';
  const code = readCode(file);
  for (const token of ['Date.now(', 'Math.random', 'crypto.randomUUID', 'performance.now', 'document.', 'window.',
    'localStorage', 'sessionStorage', 'fetch(', 'console.', 'navigator.', 'geolocation']) {
    assert.equal(code.includes(token), false, token);
  }
  assert.equal(/new Date\(\s*\)/.test(code), false);
  assert.equal(/\b(latitude|longitude|lat|lng|coords|gps)\b/i.test(code), false, 'ei koordinaatteja');
  for (const dependency of importsOf(file)) assert.ok(dependency.startsWith('src/domain/'), dependency);
  for (const forbidden of ['src/domain/places.js', 'src/domain/savedPlace.js']) {
    assert.equal(importsOf(file).includes(forbidden), false, forbidden);
  }
});
