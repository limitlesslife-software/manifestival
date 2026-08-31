// Aikataulumoottorin testit.
//
// Moottori on puhdas funktio, joten kaikki rajatapaukset voidaan testata
// suoraan ilman selainta, tietokantaa tai kelloa.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeWakeTime, computeBedtime, findWorkAnchor, hasManualCoverage,
  buildVirtualItems, awakeWindow, occupiedRanges, findFreeSlots,
  buildDayPlan, proposeSchedule, DEFAULT_PROFILE, DEFAULT_TASK_MINUTES
} from '../src/domain/scheduler.js';
import { SCHEDULING } from '../src/domain/task.js';

const DAY = '2026-08-31';
const NEXT = '2026-09-01';

const profile = { ...DEFAULT_PROFILE, commuteMinutes: 30, routineMinutes: 60, sleepTargetHours: 8, defaultWakeTime: '07:00' };

const task = (over = {}) => ({
  id: 'x', date: DAY, time: null, endTime: null, durationMinutes: null,
  title: 'Tehtävä', category: 'muu', priority: 'normaali',
  completed: false, isWake: false, schedulingState: SCHEDULING.UNSCHEDULED, ...over
});

// ------------------------------------------------------------- herätysaika

test('tyhjä päivä: herätys on profiilin oletusaika', () => {
  const wake = computeWakeTime({ tasks: [], profile, dateIso: DAY });
  assert.equal(wake.time, '07:00');
  assert.equal(wake.auto, true);
});

test('työtehtävä ankkuroi herätyksen: työ − matka − aamutoimet', () => {
  const tasks = [task({ id: 'w', time: '07:00', category: 'tyo' })];
  const wake = computeWakeTime({ tasks, profile, dateIso: DAY });
  assert.equal(wake.time, '05:30', '07:00 − 30 min matka − 60 min aamutoimet');
  assert.equal(wake.auto, true);
  assert.equal(wake.basedOn.id, 'w');
});

test('käyttäjän oma herätysmerkintä voittaa automaattisen laskennan', () => {
  const tasks = [
    task({ id: 'w', time: '07:00', category: 'tyo' }),
    task({ id: 'h', time: '06:15', isWake: true })
  ];
  const wake = computeWakeTime({ tasks, profile, dateIso: DAY });
  assert.equal(wake.time, '06:15');
  assert.equal(wake.auto, false, 'manuaalista ei saa merkitä automaattiseksi');
});

test('herätysankkuriksi valitaan päivän AIKAISIN työtehtävä', () => {
  const tasks = [
    task({ id: 'myohainen', time: '13:00', category: 'tyo' }),
    task({ id: 'aikainen', time: '08:00', category: 'tyo' })
  ];
  assert.equal(findWorkAnchor(tasks, DAY).id, 'aikainen');
});

test('vain työkategoria ankkuroi herätyksen', () => {
  const tasks = [task({ id: 'h', time: '06:00', category: 'harrastus' })];
  assert.equal(findWorkAnchor(tasks, DAY), null);
  assert.equal(computeWakeTime({ tasks, profile, dateIso: DAY }).time, '07:00');
});

test('herätyslaskenta kiertää keskiyön yli', () => {
  const tasks = [task({ id: 'w', time: '01:00', category: 'tyo' })];
  // 01:00 − 90 min = 23:30 edellisenä iltana
  assert.equal(computeWakeTime({ tasks, profile, dateIso: DAY }).time, '23:30');
});

// ------------------------------------------------------ nukkumaanmenoaika

test('nukkumaanmeno lasketaan HUOMISEN herätyksestä', () => {
  const tasks = [task({ id: 'w', date: NEXT, time: '07:00', category: 'tyo' })];
  const bt = computeBedtime({ tasks, profile, dateIso: DAY });
  // huominen herätys 05:30, unitavoite 8 h -> 21:30
  assert.equal(bt.wakeTime, '05:30');
  assert.equal(bt.bedtime, '21:30');
});

test('nukkumaanmeno tyhjänä huomisena käyttää oletusheräämistä', () => {
  const bt = computeBedtime({ tasks: [], profile, dateIso: DAY });
  assert.equal(bt.wakeTime, '07:00');
  assert.equal(bt.bedtime, '23:00');
});

test('unitavoitteen muutos siirtää nukkumaanmenoa', () => {
  const bt = computeBedtime({ tasks: [], profile: { ...profile, sleepTargetHours: 9 }, dateIso: DAY });
  assert.equal(bt.bedtime, '22:00');
});

// -------------------------------------------------- automaattiset merkinnät

test('tyhjälle päivälle syntyy herätys, aamutoimet ja uni', () => {
  const items = buildVirtualItems({ tasks: [], profile, dateIso: DAY });
  assert.deepEqual(items.map(i => i.id), ['virtual-wake', 'virtual-routine', 'virtual-sleep']);
  assert.ok(items.every(i => i.virtual === true));
  assert.ok(items.every(i => i.completed === false));
});

test('oma herätysmerkintä poistaa automaattisen herätysehdotuksen', () => {
  const tasks = [task({ id: 'h', time: '06:00', isWake: true })];
  const ids = buildVirtualItems({ tasks, profile, dateIso: DAY }).map(i => i.id);
  assert.equal(ids.includes('virtual-wake'), false);
});

test('oma merkintä aamutoimien aikaan poistaa aamutoimiehdotuksen', () => {
  const tasks = [task({ id: 'a', time: '07:30' })]; // ikkuna 07:00–08:00
  const ids = buildVirtualItems({ tasks, profile, dateIso: DAY }).map(i => i.id);
  assert.equal(ids.includes('virtual-routine'), false, 'ei saa päällekkäistää käyttäjän omaa merkintää');
});

test('hasManualCoverage on puolisuljettu väli [start, end)', () => {
  const tasks = [task({ id: 'a', time: '08:00' })];
  assert.equal(hasManualCoverage(tasks, DAY, '07:00', '09:00'), true);
  assert.equal(hasManualCoverage(tasks, DAY, '08:00', '09:00'), true, 'alkupiste kuuluu väliin');
  assert.equal(hasManualCoverage(tasks, DAY, '06:00', '08:00'), false, 'loppupiste ei kuulu väliin');
});

// ------------------------------------------------------- valveillaoloikkuna

test('valveillaoloikkuna alkaa herätyksestä ja päättyy nukkumaanmenoon', () => {
  const w = awakeWindow({ tasks: [], profile, dateIso: DAY });
  assert.equal(w.start, 7 * 60);
  assert.equal(w.end, 23 * 60);
});

test('jos nukkumaanmeno on keskiyön jälkeen, ikkuna päättyy vuorokauden vaihteeseen', () => {
  // huominen herätys 09:00, unitavoite 8 h -> nukkumaanmeno 01:00 (< herätys)
  const p = { ...profile, defaultWakeTime: '09:00', sleepTargetHours: 8 };
  const w = awakeWindow({ tasks: [], profile: p, dateIso: DAY });
  assert.equal(w.bedtime, '01:00');
  assert.equal(w.end, 1440, 'ikkuna ei saa mennä negatiiviseksi');
});

// -------------------------------------------------------- varatut välit

test('occupiedRanges yhdistää päällekkäiset varaukset', () => {
  const items = [
    { time: '09:00', endTime: '10:00' },
    { time: '09:30', endTime: '11:00' },
    { time: '13:00', endTime: '14:00' }
  ];
  assert.deepEqual(occupiedRanges(items), [
    { start: 540, end: 660 },
    { start: 780, end: 840 }
  ]);
});

test('occupiedRanges antaa ajattomalle tehtävälle nolla varausta', () => {
  assert.deepEqual(occupiedRanges([{ time: null, endTime: null }]), []);
});

test('occupiedRanges käyttää oletuskestoa, jos loppuaikaa ei ole', () => {
  const [range] = occupiedRanges([{ time: '09:00', endTime: null }]);
  assert.equal(range.end - range.start, DEFAULT_TASK_MINUTES);
});

// -------------------------------------------------------- vapaat välit

test('tyhjä päivä on kokonaan vapaa', () => {
  const range = { start: 420, end: 1380 };
  const slots = findFreeSlots({ items: [], range });
  assert.equal(slots.length, 1);
  assert.equal(slots[0].startTime, '07:00');
  assert.equal(slots[0].endTime, '23:00');
});

test('vapaat välit lasketaan varausten väliin', () => {
  const range = { start: 480, end: 1080 }; // 08:00–18:00
  const items = [
    { time: '09:00', endTime: '10:00' },
    { time: '13:00', endTime: '14:00' }
  ];
  const slots = findFreeSlots({ items, range });
  assert.deepEqual(slots.map(s => [s.startTime, s.endTime]), [
    ['08:00', '09:00'],
    ['10:00', '13:00'],
    ['14:00', '18:00']
  ]);
});

test('liian lyhyttä väliä ei tarjota', () => {
  const range = { start: 480, end: 600 };
  const items = [
    { time: '08:00', endTime: '09:50' } // jää 10 min
  ];
  assert.deepEqual(findFreeSlots({ items, range, minMinutes: 15 }), []);
});

test('ikkunan ulkopuoliset varaukset eivät vaikuta', () => {
  const range = { start: 600, end: 720 }; // 10:00–12:00
  const items = [{ time: '06:00', endTime: '07:00' }, { time: '20:00', endTime: '21:00' }];
  const slots = findFreeSlots({ items, range });
  assert.equal(slots.length, 1);
  assert.equal(slots[0].minutes, 120);
});

test('täyteen varattu ikkuna ei tuota vapaita välejä', () => {
  const range = { start: 480, end: 600 };
  const items = [{ time: '08:00', endTime: '10:00' }];
  assert.deepEqual(findFreeSlots({ items, range }), []);
});

// ------------------------------------------------------- päivän suunnitelma

test('buildDayPlan erottelee ajastetut, ajattomat ja valmiit', () => {
  const tasks = [
    task({ id: 'a', time: '09:00', endTime: '10:00' }),
    task({ id: 'b' }),
    task({ id: 'c', time: '11:00', completed: true })
  ];
  const plan = buildDayPlan({ tasks, profile, dateIso: DAY });
  assert.deepEqual(plan.scheduled.map(t => t.id), ['a']);
  assert.deepEqual(plan.unscheduled.map(t => t.id), ['b']);
  assert.deepEqual(plan.completed.map(t => t.id), ['c']);
});

test('buildDayPlan sisällyttää automaattiset merkinnät aikajanaan', () => {
  const plan = buildDayPlan({ tasks: [], profile, dateIso: DAY });
  const ids = plan.timeline.map(i => i.id);
  assert.ok(ids.includes('virtual-wake'));
  assert.ok(ids.includes('virtual-sleep'));
});

test('buildDayPlan järjestää aikajanan kellonajan mukaan', () => {
  const tasks = [
    task({ id: 'ilta', time: '20:00' }),
    task({ id: 'aamu', time: '08:00' })
  ];
  const plan = buildDayPlan({ tasks, profile, dateIso: DAY });
  const times = plan.timeline.filter(i => i.time).map(i => i.time);
  assert.deepEqual([...times].sort(), times, 'aikajanan pitää olla järjestyksessä');
});

test('buildDayPlan laskee kuormituksen', () => {
  const tasks = Array.from({ length: 9 }, (_, i) => task({ id: 'x' + i, time: '0' + (i + 1) + ':00' }));
  const plan = buildDayPlan({ tasks, profile, dateIso: DAY });
  assert.equal(plan.load.count, 9);
  assert.equal(plan.load.level, 'clay', '8 tai enemmän = raskas');
});

test('buildDayPlan ei laske toisen päivän tehtäviä', () => {
  const tasks = [task({ id: 'toinen', date: NEXT, time: '09:00' })];
  const plan = buildDayPlan({ tasks, profile, dateIso: DAY });
  assert.equal(plan.load.count, 0);
  assert.equal(plan.scheduled.length, 0);
});

// ---------------------------------------------------------- ehdotukset

test('tyhjä päivä ilman tehtäviä ei tuota ehdotuksia', () => {
  const { proposals, unplaced } = proposeSchedule({ tasks: [], profile, dateIso: DAY });
  assert.deepEqual(proposals, []);
  assert.deepEqual(unplaced, []);
});

test('yksi ajaton tehtävä sijoitetaan ensimmäiseen vapaaseen väliin', () => {
  const tasks = [task({ id: 'a', title: 'Soita', durationMinutes: 30 })];
  const { proposals, unplaced } = proposeSchedule({ tasks, profile, dateIso: DAY });
  assert.equal(unplaced.length, 0);
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].taskId, 'a');
  assert.equal(proposals[0].durationMinutes, 30);
  assert.equal(proposals[0].time, '08:00', 'aamutoimet 07:00–08:00 varaavat alun');
});

test('korkea prioriteetti sijoitetaan ensin', () => {
  const tasks = [
    task({ id: 'matala', title: 'Matala', priority: 'matala', durationMinutes: 60 }),
    task({ id: 'korkea', title: 'Korkea', priority: 'korkea', durationMinutes: 60 })
  ];
  const { proposals } = proposeSchedule({ tasks, profile, dateIso: DAY });
  assert.equal(proposals[0].taskId, 'korkea');
  assert.ok(proposals[0].time < proposals[1].time, 'tärkein saa aikaisemman ajan');
});

test('ehdotukset eivät mene päällekkäin keskenään', () => {
  const tasks = [
    task({ id: 'a', title: 'A', durationMinutes: 60 }),
    task({ id: 'b', title: 'B', durationMinutes: 60 })
  ];
  const { proposals } = proposeSchedule({ tasks, profile, dateIso: DAY });
  assert.equal(proposals.length, 2);
  assert.ok(proposals[0].endTime <= proposals[1].time, 'ehdotusten pitää olla peräkkäisiä');
});

test('ehdotus ei mene päällekkäin olemassa olevan tehtävän kanssa', () => {
  const tasks = [
    task({ id: 'kiinni', time: '08:00', endTime: '12:00' }),
    task({ id: 'uusi', title: 'Uusi', durationMinutes: 60 })
  ];
  const { proposals } = proposeSchedule({ tasks, profile, dateIso: DAY });
  assert.equal(proposals.length, 1);
  assert.ok(proposals[0].time >= '12:00', 'ehdotus alkoi varatun ajan sisällä: ' + proposals[0].time);
});

test('tehtävä jää sijoittamatta, jos tilaa ei ole', () => {
  const tasks = [
    task({ id: 'koko-paiva', time: '07:00', endTime: '23:00' }),
    task({ id: 'ei-mahdu', title: 'Ei mahdu', durationMinutes: 120 })
  ];
  const { proposals, unplaced } = proposeSchedule({ tasks, profile, dateIso: DAY });
  assert.deepEqual(proposals, []);
  assert.deepEqual(unplaced.map(t => t.id), ['ei-mahdu']);
});

test('TAKUU: käyttäjän itse ajastamaa tehtävää ei koskaan ehdoteta siirrettäväksi', () => {
  const tasks = [task({ id: 'oma', time: '15:00', schedulingState: SCHEDULING.MANUAL })];
  const { proposals } = proposeSchedule({ tasks, profile, dateIso: DAY });
  assert.equal(proposals.find(p => p.taskId === 'oma'), undefined);
});

test('valmista tehtävää ei ehdoteta', () => {
  const tasks = [task({ id: 'tehty', completed: true })];
  const { proposals, unplaced } = proposeSchedule({ tasks, profile, dateIso: DAY });
  assert.deepEqual(proposals, []);
  assert.deepEqual(unplaced, []);
});

test('kestoton tehtävä saa oletuskeston', () => {
  const tasks = [task({ id: 'a', title: 'A' })];
  const { proposals } = proposeSchedule({ tasks, profile, dateIso: DAY });
  assert.equal(proposals[0].durationMinutes, DEFAULT_TASK_MINUTES);
});

test('TAKUU: ehdotukset ovat deterministisiä', () => {
  const tasks = [
    task({ id: 'a', title: 'Alfa', durationMinutes: 45 }),
    task({ id: 'b', title: 'Beeta', durationMinutes: 30 }),
    task({ id: 'c', title: 'Gamma', priority: 'korkea', durationMinutes: 60 })
  ];
  const first = proposeSchedule({ tasks, profile, dateIso: DAY });
  const second = proposeSchedule({ tasks: [...tasks].reverse(), profile, dateIso: DAY });
  assert.deepEqual(first.proposals, second.proposals,
    'syötteen järjestys ei saa vaikuttaa lopputulokseen');
});

test('ehdotus kertoo perustelunsa', () => {
  const tasks = [task({ id: 'a', title: 'A', durationMinutes: 30 })];
  const { proposals } = proposeSchedule({ tasks, profile, dateIso: DAY });
  assert.match(proposals[0].reason, /vapaa/i);
});
