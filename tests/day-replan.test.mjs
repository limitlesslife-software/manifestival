// Päivän uudelleensuunnittelu keskeytyksen jälkeen (src/domain/dayReplan.js).
//
// LUPAUKSET
//   - Kiinteät menot, matkat ja valmistautuminen, rauhoittuminen ja uni
//     eivät liiku koskaan. Käyttäjän itse ajastama tehtävä ei liiku ilman
//     erillistä lupaa (includeManual).
//   - Tehdyt ja käynnissä olevat säilyvät (myöhästymisessä kellon mukaan
//     käynnissä oleva joustava kohde on se, jota myöhästyminen koskee).
//   - Pienin muutos: väljyys imee siirron, eikä päivää rakenneta uudelleen.
//   - Kaikki on ehdotus: requiresConfirmation on aina true.
//
// Perusviikko: maanantai 2026-09-28.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readCode, importsOf } from './helpers/sources.mjs';
import { helsinkiOffset } from './helpers/helsinkiOffset.mjs';
import { replanDay, REPLAN_CHANGE, REPLAN_CHANGE_KINDS } from '../src/domain/dayReplan.js';
import { parseInterruption } from '../src/domain/interruptions.js';
import { buildDayPlan } from '../src/domain/scheduler.js';
import { normalizeRoutine } from '../src/domain/routine.js';
import { toMinutes, durationOf } from '../src/domain/task.js';

const TODAY = '2026-09-28';
const TOMORROW = '2026-09-29';
const PROFILE = Object.freeze({ sleepTargetHours: 8, defaultWakeTime: '07:00', commuteMinutes: 30, routineMinutes: 60 });

const at = time => toMinutes(time);

function task(id, title, time, endTime, extra = {}) {
  return {
    id, title, date: TODAY, time, endTime, durationMinutes: null, completed: false,
    schedulingState: time ? 'auto' : 'unscheduled', priority: 'normaali', deadline: null, ...extra
  };
}

function event(id, title, time, endTime, date = TODAY) {
  return {
    id: `event:${id}:${date}`, eventId: id, date, time, endTime, durationMinutes: toMinutes(endTime) - toMinutes(time),
    title, category: 'muu', isEvent: true, source: 'event', allDay: false, placeId: null, locationText: null
  };
}

function block(kind, sourceId, time, endTime, date = TODAY) {
  return {
    id: `block:${kind}:${sourceId}:${date}`, kind, blockKind: kind, block: true, protected: true, completed: false,
    date, time, endTime, durationMinutes: toMinutes(endTime) - toMinutes(time), title: kind, sourceId
  };
}

function fixture() {
  const tasks = [
    task('t-report', 'Raportti', '09:00', '10:00'),
    task('t-mail', 'Sähköpostit', '10:00', '10:30'),
    task('t-meeting', 'Palaveri', '10:30', '11:30', { schedulingState: 'manual' }),
    task('t-run', 'Lenkki', '13:00', '13:45'),
    task('t-car', 'Pese auto', null, null, { durationMinutes: 40 }),
    task('t-breakfast', 'Aamupala', '08:00', '08:20', { completed: true })
  ];
  const events = [event('e-dentist', 'Hammaslääkäri', '12:00', '12:30')];
  const blocks = [
    block('preparation', 'e-dentist', '11:30', '11:40'),
    block('travel', 'e-dentist', '11:40', '11:55'),
    block('arrival_buffer', 'e-dentist', '11:55', '12:00')
  ];
  const routines = [
    normalizeRoutine({ id: 'r-stretch', title: 'Venyttely', durationMinutes: 30, preferredTime: '14:00', scheduling: 'flexible' }),
    normalizeRoutine({ id: 'r-meds', title: 'Lääkkeet', durationMinutes: 10, preferredTime: '16:00', scheduling: 'fixed' })
  ];
  return { tasks, events, blocks, routines };
}

function replan(text, nowTime, overrides = {}, todayIso = TODAY) {
  const f = { ...fixture(), ...overrides };
  const plan = buildDayPlan({
    tasks: f.tasks, profile: PROFILE, dateIso: todayIso, todayIso, events: f.events, blocks: f.blocks, routines: f.routines
  });
  const interruption = typeof text === 'string' ? parseInterruption(text, { todayIso }) : text;
  return replanDay({
    plan, interruption, nowMinutes: nowTime === null ? null : at(nowTime), todayIso,
    tasks: f.tasks, events: f.events, blocks: f.blocks, ...(overrides.options || {})
  });
}

const changeFor = (result, id) => result.changes.find(c => c.taskId === id || c.routineOccurrenceId === id);
const FIXED_IDS = ['t-meeting', `event:e-dentist:${TODAY}`, `block:preparation:e-dentist:${TODAY}`,
  `block:travel:e-dentist:${TODAY}`, `block:arrival_buffer:e-dentist:${TODAY}`, `routine:r-meds:${TODAY}`];

function assertInvariants(result) {
  assert.equal(result.requiresConfirmation, true);
  for (const id of FIXED_IDS) assert.equal(changeFor(result, id), undefined, `kiinteä ${id} ei saa liikkua`);
  assert.equal(changeFor(result, 't-breakfast'), undefined, 'tehty ei liiku');
  for (const entry of result.changes) assert.ok(REPLAN_CHANGE_KINDS.includes(entry.kind), entry.kind);
  assertDeepFrozen(result);
}

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

// ================================================================ myöhästyminen

test('myöhässä 10 min: käynnissä oleva joustava siirtyy, ketju kiertää kiinteät, väljyys imee loput', () => {
  const result = replan('Olen 10 min myöhässä', '09:05');
  assertInvariants(result);
  assert.equal(result.kind, 'running_late');
  const report = changeFor(result, 't-report');
  assert.equal(report.kind, REPLAN_CHANGE.SHIFT);
  assert.deepEqual({ ...report.from }, { date: TODAY, time: '09:00', endTime: '10:00' });
  assert.deepEqual({ ...report.to }, { date: TODAY, time: '09:10', endTime: '10:10' });
  assert.equal(report.reason, 'Aikataulu on 10 min jäljessä: alkaa klo 9.10.');

  // Sähköpostit eivät mahdu palaveria ennen (10.10-10.30 = 20 min < 30 min), joten ne menevät
  // palaverin, valmistautumisen, matkan ja hammaslääkärin jälkeen.
  const mail = changeFor(result, 't-mail');
  assert.deepEqual({ ...mail.to }, { date: TODAY, time: '12:30', endTime: '13:00' });
  assert.match(mail.reason, /Hammaslääkäri pysyy paikallaan/);

  // Lenkki klo 13 ei tarvitse siirtoa: pienin muutos.
  assert.equal(changeFor(result, 't-run'), undefined);
  assert.equal(result.changes.length, 2);
  assert.deepEqual([...result.untouched].sort(), [...FIXED_IDS].sort());
  assert.deepEqual([...result.preserved], ['t-breakfast']);
  assert.match(result.summary, /2 joustavaa kohdetta siirtyy myöhemmäksi/);
  assert.match(result.summary, /Kiinteät menot, matkat, suojattu lepo ja tehdyt asiat pysyvät ennallaan/);
});

test('myöhässä ennen seuraavaa kohdetta: väljyys riittää, mitään ei siirretä', () => {
  const result = replan('Olen 10 min myöhässä', '08:40');
  assertInvariants(result);
  assert.deepEqual([...result.changes], []);
  assert.match(result.summary, /Mitään ei tarvitse siirtää/);
});

test('myöhässä 40 min ennen raporttia: raportti alkaa, kun ehdit', () => {
  const result = replan('Olen 40 min myöhässä', '08:40');
  assertInvariants(result);
  const report = changeFor(result, 't-report');
  assert.deepEqual({ ...report.to }, { date: TODAY, time: '09:20', endTime: '10:20' });
  assert.equal(report.reason, 'Aikataulu on 40 min jäljessä: alkaa klo 9.20.');
  assert.deepEqual({ ...changeFor(result, 't-mail').to }, { date: TODAY, time: '12:30', endTime: '13:00' });
});

test('myöhästymisen määrä puuttuu: kysytään, mitään ei muuteta', () => {
  const result = replan('Olen myöhässä', '09:05');
  assert.equal(result.question, 'Kuinka monta minuuttia olet myöhässä?');
  assert.deepEqual([...result.changes], []);
  assert.match(result.summary, /pysyy ennallaan/);
  assert.equal(result.requiresConfirmation, true);
});

test('myöhästyminen osuu kiinteään menoon: varoitus, meno ei liiku', () => {
  const result = replan('Olen 30 min myöhässä', '10:20');
  assertInvariants(result);
  assert.ok(result.warnings.includes('Palaveri klo 10.30 on kiinteä, eikä sitä siirretä.'));
  const mail = changeFor(result, 't-mail');
  assert.equal(mail.to.time, '12:30', 'sähköpostit tulevat kiinteiden menojen jälkeen');
});

test('ei mahdu enää ennen lepoa: tehtävä huomiselle, joustavan rutiinin kerta väliin', () => {
  const tasks = [task('t-late', 'Iltatyö', '22:00', '22:45')];
  const routines = [normalizeRoutine({ id: 'r-read', title: 'Lukeminen', durationMinutes: 40, preferredTime: '22:20', scheduling: 'flexible' })];
  const result = replan('Olen 30 min myöhässä', '22:05', { tasks, events: [], blocks: [], routines });
  const late = changeFor(result, 't-late');
  assert.equal(late.kind, REPLAN_CHANGE.DEFER);
  assert.deepEqual({ ...late.to }, { date: TOMORROW, time: null, endTime: null });
  assert.match(late.reason, /Ei mahdu enää tälle päivälle ennen lepoa/);
  const read = changeFor(result, `routine:r-read:${TODAY}`);
  assert.equal(read.kind, REPLAN_CHANGE.SKIP);
  assert.equal(read.to, null);
  assert.equal(read.routineId, 'r-read');
});

test('KRIITTINEN: itse ajastettu tehtävä liikkuu vain erillisellä luvalla', () => {
  const without = replan('Olen 10 min myöhässä', '10:35');
  assert.equal(changeFor(without, 't-meeting'), undefined);
  assert.ok(without.untouched.includes('t-meeting'));

  const withManual = replan('Olen 10 min myöhässä', '10:35', { options: { includeManual: true } });
  const meeting = changeFor(withManual, 't-meeting');
  assert.equal(meeting.kind, REPLAN_CHANGE.SHIFT);
  assert.equal(meeting.to.time, '12:30', 'kiertää valmistautumisen, matkan ja hammaslääkärin');
  for (const id of FIXED_IDS.filter(id => id !== 't-meeting')) assert.equal(changeFor(withManual, id), undefined, id);
});

// ================================================================ venyminen

test('"Tämä työ kestää vielä 30 min": nykyinen jatkuu, seuraava joustava siirtyy', () => {
  const result = replan('Tämä työ kestää vielä 30 min', '09:50');
  assertInvariants(result);
  const report = changeFor(result, 't-report');
  assert.equal(report.kind, REPLAN_CHANGE.EXTEND);
  assert.deepEqual({ ...report.to }, { date: TODAY, time: '09:00', endTime: '10:20' });
  assert.equal(report.reason, 'Kestää vielä 30 min: loppuu klo 10.20.');
  assert.equal(changeFor(result, 't-mail').to.time, '12:30');
  assert.match(result.summary, /Nykyinen kohde jatkuu 30 min/);
});

test('venyminen, kun aikaa on jo varattu tarpeeksi: ei muutoksia', () => {
  const result = replan('Tämä kestää vielä 5 min', '09:30');
  assertInvariants(result);
  assert.deepEqual([...result.changes], []);
  assert.ok(result.warnings.some(w => /varattu klo 10.00 asti/.test(w)));
  assert.ok(result.preserved.includes('t-report'));
});

test('kiinteä meno venyy: sitä ei muuteta, joustavat siirtyvät tarvittaessa', () => {
  const short = replan('Tämä kestää vielä 30 min', '12:10');
  assertInvariants(short);
  assert.deepEqual([...short.changes], [], 'lenkki klo 13 ehtii');
  assert.ok(short.warnings.some(w => /Hammaslääkäri on kiinteä, eikä sen aikaa muuteta/.test(w)));

  const long = replan('Tämä kestää vielä tunnin', '12:10');
  assertInvariants(long);
  const run = changeFor(long, 't-run');
  assert.deepEqual({ ...run.to }, { date: TODAY, time: '13:10', endTime: '13:55' });
  assert.equal(run.reason, 'Olet varattu klo 13.10 asti: alkaa klo 13.10.');
});

test('venymisen määrä puuttuu: kysytään', () => {
  const result = replan('Tämä kestää pidempään', '09:30');
  assert.equal(result.question, 'Kuinka paljon lisäaikaa tarvitset?');
  assert.deepEqual([...result.changes], []);
});

// ================================================================ ohitus

test('"En ehdi lenkille nyt": lenkin aika vapautuu, tehtävä jää päivälle', () => {
  const result = replan('En ehdi lenkille nyt', '12:50');
  assertInvariants(result);
  const run = changeFor(result, 't-run');
  assert.equal(run.kind, REPLAN_CHANGE.SKIP);
  assert.deepEqual({ ...run.to }, { date: TODAY, time: null, endTime: null });
  assert.equal(result.changes.length, 1, 'vain yksi kohde');
});

test('ohitus: joustava rutiini jää väliin, rutiini jatkuu', () => {
  const result = replan('Jätän venyttelyn väliin', '09:00');
  const stretch = changeFor(result, `routine:r-stretch:${TODAY}`);
  assert.equal(stretch.kind, REPLAN_CHANGE.SKIP);
  assert.equal(stretch.to, null);
  assert.equal(stretch.taskId, null);
  assert.equal(stretch.routineId, 'r-stretch');
  assert.match(stretch.reason, /Rutiini jatkuu normaalisti/);
});

test('ohitus: aikatauluttamaton tehtävä siirtyy huomiselle', () => {
  const result = replan('En ehdi pestä autoa', '09:00');
  const car = changeFor(result, 't-car');
  assert.equal(car.kind, REPLAN_CHANGE.DEFER);
  assert.deepEqual({ ...car.to }, { date: TOMORROW, time: null, endTime: null });
});

test('KRIITTINEN: kiinteää menoa ei ohiteta automaattisesti', () => {
  const result = replan('En ehdi hammaslääkäriin', '09:00');
  assertInvariants(result);
  assert.deepEqual([...result.changes], []);
  assert.ok(result.warnings.some(w => /Hammaslääkäri on kiinteä, eikä sitä ohiteta automaattisesti/.test(w)));
});

test('ohitus: kaksi sopivaa kohdetta -> kysytään, ei arvata', () => {
  const tasks = [...fixture().tasks, task('t-evening-run', 'Iltalenkki', '19:00', '19:30')];
  const result = replan('En ehdi lenkille', '09:00', { tasks });
  assert.deepEqual([...result.changes], []);
  assert.equal(result.question, 'Mikä näistä jää väliin: Lenkki vai Iltalenkki?');
  assert.deepEqual(result.candidates.map(c => c.id), ['t-run', 't-evening-run']);
});

test('ohitus: kohdetta ei löydy -> kysytään; ilman kohdetta käynnissä oleva', () => {
  const missing = replan('En ehdi uimaan', '09:00');
  assert.equal(missing.question, 'Mikä jää väliin?');
  assert.deepEqual([...missing.changes], []);
  assert.match(missing.summary, /ei löytynyt kohdetta "uimaan"/);

  const current = replan('En ehdi', '13:10');
  assert.equal(changeFor(current, 't-run').kind, REPLAN_CHANGE.SKIP);
});

test('ohitus toisena päivänä ei muuta tätä päivää', () => {
  const result = replan('En ehdi huomenna lenkille', '09:00');
  assert.deepEqual([...result.changes], []);
  assert.match(result.summary, /Ohitus koskee päivää ti 29\.9\. Tämän päivän suunnitelma pysyy ennallaan\./);
});

// ================================================================ loppujen siirto

test('"Siirrä loput huomiselle": jäljellä olevat tehtävät huomiselle ilman kellonaikaa', () => {
  const result = replan('Siirrä loput huomiselle', '09:30');
  assertInvariants(result);
  assert.deepEqual(result.changes.map(c => c.taskId), ['t-mail', 't-run', 't-car']);
  for (const entry of result.changes) {
    assert.equal(entry.kind, REPLAN_CHANGE.DEFER);
    assert.deepEqual({ ...entry.to }, { date: TOMORROW, time: null, endTime: null });
  }
  assert.ok(result.preserved.includes('t-report'), 'käynnissä oleva säilyy');
  assert.equal(changeFor(result, `routine:r-stretch:${TODAY}`), undefined, 'rutiinit toistuvat, niitä ei siirretä');
  assert.match(result.summary, /3 tehtävää siirtyy päivälle ti 29\.9\./);
});

test('loppujen siirto kuorman mukaan: ensimmäinen päivä, jolle tehtävä mahtuu', () => {
  const days = [{ date: TOMORROW, usableMinutes: 30 }, { date: '2026-09-30', usableMinutes: 200 }];
  const result = replan('Siirrä loput', '09:30', { options: { days } });
  assertInvariants(result);
  assert.equal(changeFor(result, 't-mail').to.date, TOMORROW);
  assert.equal(changeFor(result, 't-run').to.date, '2026-09-30');
  assert.equal(changeFor(result, 't-car').to.date, '2026-09-30');
  assert.match(changeFor(result, 't-run').reason, /jolle 45 min vielä mahtuu/);
});

test('loppujen siirto kunnioittaa määräaikaa', () => {
  const tasks = [
    task('t-due-today', 'Vero', null, null, { durationMinutes: 30, deadline: TODAY }),
    task('t-due-soon', 'Hakemus', null, null, { durationMinutes: 60, deadline: '2026-09-30' }),
    task('t-free', 'Siivous', null, null, { durationMinutes: 60 })
  ];
  const days = [{ date: TOMORROW, usableMinutes: 0 }, { date: '2026-09-30', usableMinutes: 60 }, { date: '2026-10-01', usableMinutes: 300 }];
  const result = replan('Siirrä loput', '09:30', { tasks, events: [], blocks: [], routines: [], options: { days } });
  assert.equal(changeFor(result, 't-due-today'), undefined);
  assert.ok(result.warnings.includes('Vero: määräaika on tänään, joten sitä ei siirretty.'));
  assert.equal(changeFor(result, 't-due-soon').to.date, '2026-09-30');
  assert.equal(changeFor(result, 't-free').to.date, '2026-10-01');

  const explicit = replan('Siirrä loput ylihuomiselle', '09:30', { tasks, events: [], blocks: [], routines: [] });
  assert.match(changeFor(explicit, 't-due-today').reason, /Huom: määräaika on ma 28\.9\./);
});

test('ei mitään siirrettävää: suunnitelma pysyy', () => {
  const tasks = [task('t-done', 'Valmis', '09:00', '10:00', { completed: true })];
  const result = replan('Siirrä loput', '12:00', { tasks, events: [], blocks: [], routines: [] });
  assert.deepEqual([...result.changes], []);
  assert.equal(result.summary, 'Siirrettävää ei ole jäljellä. Päivän suunnitelma pysyy ennallaan.');
});

// ================================================================ rajat ja roskat

test('keskeytys koskee vain tätä päivää; tuntematon keskeytys tai nykyhetki ei muuta mitään', () => {
  const f = fixture();
  const plan = buildDayPlan({ tasks: f.tasks, profile: PROFILE, dateIso: TOMORROW, todayIso: TODAY });
  const other = replanDay({ plan, interruption: { kind: 'running_late', minutes: 10 }, nowMinutes: 600, todayIso: TODAY });
  assert.deepEqual([...other.changes], []);
  assert.match(other.summary, /vain tätä päivää/);

  const unknown = replan({ kind: 'delete_all' }, '09:00');
  assert.equal(unknown.kind, null);
  assert.deepEqual([...unknown.changes], []);

  const noNow = replan('Olen 10 min myöhässä', null);
  assert.deepEqual([...noNow.changes], []);
  assert.match(noNow.summary, /Nykyhetkeä ei tunnistettu/);
});

test('roskasyöte ei koskaan kaada', () => {
  const trap = { get time() { throw new Error('ansa'); }, id: 'trap', date: TODAY };
  const values = [undefined, null, 0, 'x', [], {}, () => 1, NaN];
  for (const plan of [...values, { dateIso: TODAY, timeline: [null, 5, 'x', trap, { id: '' }], range: 'x' }]) {
    for (const interruption of [...values, { kind: 'running_late', minutes: -5 }, { kind: 'skip_item', targetText: 7 },
      { kind: 'defer_remaining', toDate: '2026-02-30' }, { kind: 'extend_current', minutes: 1e9 }]) {
      assert.doesNotThrow(() => replanDay({ plan, interruption, nowMinutes: 600, todayIso: TODAY }));
    }
  }
  for (const input of values) assert.doesNotThrow(() => replanDay(input));
  assert.doesNotThrow(() => replanDay({
    plan: { dateIso: TODAY }, interruption: { kind: 'running_late', minutes: 10 }, nowMinutes: 600, todayIso: TODAY,
    tasks: [trap, null, { id: 'x', date: TODAY, time: '25:99' }], events: 'x', blocks: [trap], days: 'x', offsetMinutesFn: 5
  }));
});

test('syötteitä ei muuteta: jäädytetyt tehtävät, menot, lohkot ja suunnitelma kelpaavat', () => {
  const f = fixture();
  const plan = buildDayPlan({ tasks: f.tasks, profile: PROFILE, dateIso: TODAY, todayIso: TODAY, events: f.events, blocks: f.blocks, routines: f.routines });
  const frozen = deepFreeze({ plan, tasks: f.tasks, events: f.events, blocks: f.blocks });
  const before = JSON.stringify(frozen);
  for (const text of ['Olen 10 min myöhässä', 'Tämä työ kestää vielä 30 min', 'En ehdi lenkille', 'Siirrä loput']) {
    assert.doesNotThrow(() => replanDay({
      plan: frozen.plan, interruption: parseInterruption(text), nowMinutes: at('09:50'), todayIso: TODAY,
      tasks: frozen.tasks, events: frozen.events, blocks: frozen.blocks
    }));
  }
  assert.equal(JSON.stringify(frozen), before);
});

test('determinismi: sekoitettu syöte antaa saman tuloksen', () => {
  const base = replan('Olen 10 min myöhässä', '09:05');
  const f = fixture();
  let seed = 7;
  const shuffle = list => {
    const copy = [...list];
    for (let i = copy.length - 1; i > 0; i -= 1) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      const j = seed % (i + 1);
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  };
  for (let round = 0; round < 10; round += 1) {
    const result = replan('Olen 10 min myöhässä', '09:05', {
      tasks: shuffle(f.tasks), events: shuffle(f.events), blocks: shuffle(f.blocks), routines: shuffle(f.routines)
    });
    assert.equal(JSON.stringify(result), JSON.stringify(base));
  }
});

test('ominaisuus: siirretty kohde ei koskaan osu kiinteään eikä kiinteä liiku (satunnaiset päivät)', () => {
  let seed = 12345;
  const rand = n => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  const clock = minutes => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  for (let round = 0; round < 60; round += 1) {
    const tasks = [];
    const events = [];
    for (let i = 0; i < 12; i += 1) {
      const start = 8 * 60 + rand(13 * 60);
      const length = 10 + rand(80);
      const end = Math.min(start + length, 23 * 60 - 1);
      if (end <= start) continue;
      if (rand(3) === 0) events.push(event(`e${i}`, `Meno ${i}`, clock(start), clock(end)));
      else tasks.push(task(`t${i}`, `Tehtävä ${i}`, clock(start), clock(end), { schedulingState: rand(4) === 0 ? 'manual' : 'auto' }));
    }
    const plan = buildDayPlan({ tasks, profile: PROFILE, dateIso: TODAY, todayIso: TODAY, events });
    const now = 8 * 60 + rand(12 * 60);
    const result = replanDay({
      plan, interruption: { kind: 'running_late', minutes: 5 + rand(90) }, nowMinutes: now, todayIso: TODAY, tasks, events
    });
    const fixed = [...events, ...tasks.filter(t => t.schedulingState === 'manual')];
    for (const item of fixed) assert.equal(changeFor(result, item.id), undefined, `kiinteä ${item.id} liikkui`);
    for (const entry of result.changes.filter(c => c.kind === REPLAN_CHANGE.SHIFT)) {
      const start = toMinutes(entry.to.time);
      const end = start + (toMinutes(entry.to.endTime) - start);
      for (const item of fixed) {
        const s = toMinutes(item.time);
        const e = s + durationOf(item);
        assert.ok(end <= s || e <= start, `kohde ${entry.taskId} ${entry.to.time} osuu kiinteään ${item.id}`);
      }
      assert.ok(start >= toMinutes(entry.from.time), 'myöhästyminen ei aikaista mitään');
    }
    assert.equal(result.requiresConfirmation, true);
  }
});

// ================================================================ kesäaika ja keskiyö

test('KRIITTINEN: kevään vaihtoyö: 02.50 + 20 min todellista aikaa = 04.10', () => {
  const day = '2026-03-29';
  const tasks = [{ id: 'd1', title: 'Yöajo', date: day, time: '02:50', endTime: '03:20', schedulingState: 'auto' }];
  const plan = buildDayPlan({ tasks, profile: PROFILE, dateIso: day, todayIso: day });
  const result = replanDay({
    plan, interruption: { kind: 'running_late', minutes: 20 }, nowMinutes: at('02:55'), todayIso: day, offsetMinutesFn: helsinkiOffset
  });
  const entry = changeFor(result, 'd1');
  assert.deepEqual({ ...entry.to }, { date: day, time: '04:10', endTime: '04:40' });
  assert.equal(entry.dstAdjusted, true);
  assert.match(entry.reason, /Kellojen siirto on otettu huomioon/);
});

test('KRIITTINEN: syksyn toistuva tunti ei koskaan aikaista: tulos ei osu aiottua aiemmaksi', () => {
  const day = '2026-10-25';
  const tasks = [{ id: 'f1', title: 'Yöajo', date: day, time: '03:50', endTime: '04:20', schedulingState: 'auto' }];
  const plan = buildDayPlan({ tasks, profile: PROFILE, dateIso: day, todayIso: day });
  const result = replanDay({
    plan, interruption: { kind: 'running_late', minutes: 20 }, nowMinutes: at('03:52'), todayIso: day, offsetMinutesFn: helsinkiOffset
  });
  const entry = changeFor(result, 'f1');
  // 03.50 kesäaikaa + 20 min = 03.10 talviaikaa; tallennettu "03:10" tulkittaisiin
  // ensimmäisenä esiintymänä (40 min liian aikaisin), joten valitaan 04.00.
  assert.equal(entry.to.time, '04:00');
  assert.equal(entry.dstAdjusted, true);
  // Ilman aikavyöhykefunktiota lasketaan seinäkellolla.
  const wall = replanDay({ plan, interruption: { kind: 'running_late', minutes: 20 }, nowMinutes: at('03:52'), todayIso: day });
  assert.equal(changeFor(wall, 'f1').to.time, '04:10');
  assert.equal(changeFor(wall, 'f1').dstAdjusted, false);
});

test('venyminen kevään vaihtoyönä lasketaan todellisena aikana', () => {
  const day = '2026-03-29';
  const tasks = [{ id: 'n1', title: 'Yövuoro', date: day, time: '01:00', endTime: '03:00', schedulingState: 'auto' }];
  const plan = buildDayPlan({ tasks, profile: PROFILE, dateIso: day, todayIso: day });
  const result = replanDay({
    plan, interruption: { kind: 'extend_current', minutes: 30 }, nowMinutes: at('02:50'), todayIso: day, offsetMinutesFn: helsinkiOffset
  });
  assert.equal(changeFor(result, 'n1').to.endTime, '04:20');
});

test('vuoden viimeinen ilta: ei mahdu -> seuraavan vuoden ensimmäiselle päivälle', () => {
  const day = '2026-12-31';
  const tasks = [{ id: 'y1', title: 'Vuosikatsaus', date: day, time: '22:30', endTime: '22:55', schedulingState: 'auto' }];
  const plan = buildDayPlan({ tasks, profile: PROFILE, dateIso: day, todayIso: day });
  const result = replanDay({ plan, interruption: { kind: 'running_late', minutes: 20 }, nowMinutes: at('22:35'), todayIso: day });
  const entry = changeFor(result, 'y1');
  assert.equal(entry.kind, REPLAN_CHANGE.DEFER);
  assert.equal(entry.to.date, '2027-01-01');
  const defer = replanDay({ plan, interruption: parseInterruption('Siirrä loput huomiselle', { todayIso: day }), nowMinutes: at('20:00'), todayIso: day });
  assert.equal(changeFor(defer, 'y1').to.date, '2027-01-01');
});

// ================================================================ suorituskyky ja puhtaus

test('suorituskyky: tuhansien kohteiden päivä käsitellään lineaarisesti', () => {
  const build = count => {
    const tasks = [];
    const events = [];
    for (let i = 0; i < count; i += 1) {
      const minute = 8 * 60 + Math.floor((i * 14 * 60) / count);
      const clock = `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
      if (i % 3 === 0) events.push({ ...event(`e${i}`, `Meno ${i}`, clock, clock), durationMinutes: 1, endTime: null });
      else tasks.push({ ...task(`t${i}`, `Tehtävä ${i}`, clock, null), durationMinutes: 1 });
    }
    const plan = buildDayPlan({ tasks, profile: PROFILE, dateIso: TODAY, todayIso: TODAY, events });
    return { plan, tasks, events };
  };
  const run = ({ plan, tasks, events }) => {
    const started = performance.now();
    replanDay({ plan, interruption: { kind: 'running_late', minutes: 45 }, nowMinutes: at('08:00'), todayIso: TODAY, tasks, events });
    return performance.now() - started;
  };
  const small = build(1500);
  const large = build(6000);
  run(small);
  const smallTime = Math.max(1, run(small));
  const largeTime = run(large);
  assert.ok(largeTime < 3000, `liian hidas: ${Math.round(largeTime)} ms`);
  assert.ok(largeTime / smallTime < 24, `kasvu ei ole lineaarista: ${(largeTime / smallTime).toFixed(1)}x`);
});

test('PUHTAUS: ei kelloa, arpaa, DOMia, verkkoa eikä lokia; tuo vain domainia', () => {
  const code = readCode('src/domain/dayReplan.js');
  for (const token of ['Date.now(', 'Math.random', 'crypto.randomUUID', 'performance.now', 'document.', 'window.',
    'localStorage', 'sessionStorage', 'fetch(', 'console.']) {
    assert.equal(code.includes(token), false, token);
  }
  assert.equal(/new Date\(\s*\)/.test(code), false);
  for (const dependency of importsOf('src/domain/dayReplan.js')) assert.ok(dependency.startsWith('src/domain/'), dependency);
});
