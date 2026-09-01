// Aikataulumoottori V3: rutiinit, määräajat ja kiireellisyys.
//
// V2 osasi sijoittaa aikatauluttamattomat tehtävät vapaisiin väleihin.
// V3 lisää kaksi signaalia — toistuvat rutiinit ja määräajat — eikä saa
// rikkoa yhtäkään V2:n takuuta.
//
// PRIORISOINTISÄÄNTÖ:
//   1. manuaaliset lukitut ajat  (ei koskaan siirretä)
//   2. rutiinit                  (käyttäjän toistuvat sitoumukset)
//   3. kiireellisyys             (määräaika)
//   4. prioriteetti
//   5. kesto                     (mahtuuko väliin)

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildDayPlan, proposeSchedule, DEFAULT_PROFILE, DEFAULT_TASK_MINUTES } from '../src/domain/scheduler.js';
import { SCHEDULING, normalizeTask, URGENCY } from '../src/domain/task.js';
import { RECURRENCE, ROUTINE_SCHEDULING, EXCEPTION, normalizeRoutine, normalizeException } from '../src/domain/routine.js';

const DAY = '2026-09-01'; // tiistai
const profile = { ...DEFAULT_PROFILE, commuteMinutes: 30, routineMinutes: 60, sleepTargetHours: 8, defaultWakeTime: '07:00' };

const task = (over = {}) => normalizeTask({
  id: 'x', date: DAY, title: 'Tehtävä', category: 'muu', priority: 'normaali', ...over
});

const routine = (over = {}) => normalizeRoutine({
  id: 'r1', title: 'Rutiini', category: 'hyvinvointi', priority: 'normaali',
  durationMinutes: 30, recurrence: { type: RECURRENCE.DAILY }, active: true, ...over
});

// ------------------------------------------------- rutiinit päiväsuunnitelmassa

test('kiinteä rutiini näkyy aikajanalla', () => {
  const plan = buildDayPlan({
    tasks: [], profile, dateIso: DAY,
    routines: [routine({ preferredTime: '07:30' })]
  });
  const ids = plan.timeline.map(i => i.id);
  assert.ok(ids.includes('routine:r1:2026-09-01'));
  assert.equal(plan.fixedRoutines.length, 1);
  assert.equal(plan.flexibleRoutines.length, 0);
});

test('joustava rutiini odottaa sijoittamista eikä ole aikajanalla', () => {
  const plan = buildDayPlan({
    tasks: [], profile, dateIso: DAY,
    routines: [routine({ preferredTime: null })]
  });
  assert.equal(plan.flexibleRoutines.length, 1);
  assert.equal(plan.fixedRoutines.length, 0);
  assert.equal(plan.timeline.some(i => i.isRoutine), false);
});

test('rutiini ei osu päivälle, jolle sitä ei ole ajoitettu', () => {
  // Vain maanantaisin; DAY on tiistai.
  const r = routine({ recurrence: { type: RECURRENCE.CUSTOM_WEEKDAYS, weekdays: [1] }, preferredTime: '08:00' });
  const plan = buildDayPlan({ tasks: [], profile, dateIso: DAY, routines: [r] });
  assert.equal(plan.routineOccurrences.length, 0);
});

test('ohitettu rutiiniesiintymä ei näy suunnitelmassa', () => {
  const exceptions = [normalizeException({ routineId: 'r1', date: DAY, type: EXCEPTION.SKIP })];
  const plan = buildDayPlan({
    tasks: [], profile, dateIso: DAY,
    routines: [routine({ preferredTime: '08:00' })], exceptions
  });
  assert.equal(plan.routineOccurrences.length, 0);
});

test('kiinteä rutiini varaa aikaa vapaista väleistä', () => {
  const withoutRoutine = buildDayPlan({ tasks: [], profile, dateIso: DAY });
  const withRoutine = buildDayPlan({
    tasks: [], profile, dateIso: DAY,
    routines: [routine({ preferredTime: '12:00', durationMinutes: 120 })]
  });

  const freeBefore = withoutRoutine.freeSlots.reduce((sum, s) => sum + s.minutes, 0);
  const freeAfter = withRoutine.freeSlots.reduce((sum, s) => sum + s.minutes, 0);
  assert.equal(freeBefore - freeAfter, 120, 'rutiinin pitää varata aikansa');
});

test('kuormituslaskuri kertoo rutiinien määrän erikseen', () => {
  const plan = buildDayPlan({
    tasks: [task({ id: 'a', time: '09:00' })], profile, dateIso: DAY,
    routines: [routine({ preferredTime: '08:00' })]
  });
  assert.equal(plan.load.count, 1, 'kuormitus lasketaan tehtävistä');
  assert.equal(plan.load.routines, 1);
});

// ----------------------------------------- TAKUU: käyttäjän päätös voittaa

test('TAKUU: rutiini ei siirrä käyttäjän ajastamaa tehtävää', () => {
  const manual = task({ id: 'oma', time: '08:00', endTime: '09:00', schedulingState: SCHEDULING.MANUAL });
  const { proposals } = proposeSchedule({
    tasks: [manual], profile, dateIso: DAY,
    routines: [routine({ preferredTime: null, durationMinutes: 60 })]
  });
  assert.equal(proposals.some(p => p.taskId === 'oma'), false,
    'manuaalista tehtävää ei saa koskaan ehdottaa siirrettäväksi');
});

test('TAKUU: joustava rutiini ei mene päällekkäin lukitun tapahtuman kanssa', () => {
  const locked = task({ id: 'lukittu', time: '08:00', endTime: '16:00', schedulingState: SCHEDULING.MANUAL });
  const { proposals } = proposeSchedule({
    tasks: [locked], profile, dateIso: DAY,
    routines: [routine({ preferredTime: null, durationMinutes: 60 })]
  });

  for (const proposal of proposals) {
    const overlapsLocked = proposal.time < '16:00' && proposal.endTime > '08:00';
    assert.equal(overlapsLocked, false,
      'ehdotus ' + proposal.time + '–' + proposal.endTime + ' menee lukitun päälle');
  }
});

test('TAKUU: kiinteä rutiini ei saa sijoittaa tehtävää päälleen', () => {
  const { proposals } = proposeSchedule({
    tasks: [task({ id: 'uusi', title: 'Uusi', durationMinutes: 60 })],
    profile, dateIso: DAY,
    routines: [routine({ preferredTime: '08:00', durationMinutes: 240 })]
  });
  assert.equal(proposals.length, 1);
  assert.ok(proposals[0].time >= '12:00',
    'ehdotus alkoi rutiinin sisällä: ' + proposals[0].time);
});

test('TAKUU: valmista tehtävää ei koskaan ehdoteta', () => {
  const { proposals, unplaced } = proposeSchedule({
    tasks: [task({ id: 'tehty', completed: true })], profile, dateIso: DAY
  });
  assert.deepEqual(proposals, []);
  assert.deepEqual(unplaced, []);
});

// --------------------------------------------------- priorisointijärjestys

test('rutiinit sijoitetaan ennen tavallisia tehtäviä', () => {
  const { proposals } = proposeSchedule({
    tasks: [task({ id: 'tehtava', title: 'Tehtävä', durationMinutes: 60 })],
    profile, dateIso: DAY,
    routines: [routine({ id: 'r1', title: 'Rutiini', preferredTime: null, durationMinutes: 60 })]
  });
  assert.equal(proposals.length, 2);
  assert.equal(proposals[0].kind, 'routine');
  assert.equal(proposals[1].kind, 'task');
  assert.ok(proposals[0].time < proposals[1].time);
});

test('myöhässä oleva tehtävä sijoitetaan ennen muita', () => {
  const tasks = [
    task({ id: 'normaali', title: 'Normaali', durationMinutes: 60 }),
    task({ id: 'myohassa', title: 'Myöhässä', durationMinutes: 60, deadline: '2026-08-20' })
  ];
  const { proposals } = proposeSchedule({ tasks, profile, dateIso: DAY, todayIso: DAY });
  assert.equal(proposals[0].taskId, 'myohassa');
  assert.equal(proposals[0].urgency, URGENCY.OVERDUE);
});

test('kiireellisyys voittaa prioriteetin', () => {
  const tasks = [
    task({ id: 'tarkea', title: 'Tärkeä', priority: 'korkea', durationMinutes: 60 }),
    task({ id: 'eraantyy', title: 'Erääntyy', priority: 'matala', durationMinutes: 60, deadline: DAY })
  ];
  const { proposals } = proposeSchedule({ tasks, profile, dateIso: DAY, todayIso: DAY });
  assert.equal(proposals[0].taskId, 'eraantyy',
    'tänään erääntyvä voittaa tärkeän mutta kiireettömän');
});

test('prioriteetti ratkaisee, kun kiireellisyys on sama', () => {
  const tasks = [
    task({ id: 'matala', title: 'Matala', priority: 'matala', durationMinutes: 60 }),
    task({ id: 'korkea', title: 'Korkea', priority: 'korkea', durationMinutes: 60 })
  ];
  const { proposals } = proposeSchedule({ tasks, profile, dateIso: DAY, todayIso: DAY });
  assert.equal(proposals[0].taskId, 'korkea');
});

test('kaukainen määräaika ei nosta tehtävää jonon kärkeen', () => {
  const tasks = [
    task({ id: 'korkea', title: 'Korkea', priority: 'korkea', durationMinutes: 60 }),
    task({ id: 'kaukana', title: 'Kaukana', priority: 'matala', durationMinutes: 60, deadline: '2027-01-01' })
  ];
  const { proposals } = proposeSchedule({ tasks, profile, dateIso: DAY, todayIso: DAY });
  assert.equal(proposals[0].taskId, 'korkea');
});

// ---------------------------------------------------------- perustelut

test('jokainen ehdotus kertoo perustelunsa', () => {
  const { proposals } = proposeSchedule({
    tasks: [task({ id: 'a', title: 'A', durationMinutes: 30 })], profile, dateIso: DAY, todayIso: DAY
  });
  assert.equal(proposals.length, 1);
  assert.match(proposals[0].reason, /vapaa/i);
  assert.ok(proposals[0].reason.length > 10);
});

test('perustelu kertoo myöhästymisestä', () => {
  const { proposals } = proposeSchedule({
    tasks: [task({ id: 'a', title: 'A', durationMinutes: 30, deadline: '2026-08-01' })],
    profile, dateIso: DAY, todayIso: DAY
  });
  assert.match(proposals[0].reason, /määräaika/i);
  assert.match(proposals[0].reason, /myöhässä/i);
});

test('perustelu kertoo rutiinista', () => {
  const { proposals } = proposeSchedule({
    tasks: [], profile, dateIso: DAY,
    routines: [routine({ preferredTime: null })]
  });
  assert.match(proposals[0].reason, /rutiini/i);
});

test('perustelu kertoo korkeasta prioriteetista', () => {
  const { proposals } = proposeSchedule({
    tasks: [task({ id: 'a', title: 'A', priority: 'korkea', durationMinutes: 30 })],
    profile, dateIso: DAY, todayIso: DAY
  });
  assert.match(proposals[0].reason, /tärkeä/i);
});

// ------------------------------------------------ myöhässä olevat päivässä

test('päiväsuunnitelma kokoaa myöhässä olevat tehtävät', () => {
  const tasks = [
    task({ id: 'a', date: '2026-08-01', deadline: '2026-08-01' }),
    task({ id: 'b', date: DAY }),
    task({ id: 'c', date: '2026-08-01', deadline: '2026-08-01', completed: true })
  ];
  const plan = buildDayPlan({ tasks, profile, dateIso: DAY, todayIso: DAY });
  assert.deepEqual(plan.overdue.map(t => t.id), ['a']);
});

test('myöhässä olevat lasketaan koko tehtäväjoukosta, ei vain katsotusta päivästä', () => {
  const tasks = [task({ id: 'vanha', date: '2026-07-01', deadline: '2026-07-01' })];
  const plan = buildDayPlan({ tasks, profile, dateIso: DAY, todayIso: DAY });
  assert.equal(plan.overdue.length, 1, 'toisen päivän myöhästyminen pitää näkyä');
});

// ------------------------------------------------------- INVARIANTIT

test('INVARIANTTI: mitkään kaksi ehdotusta eivät mene päällekkäin', () => {
  const tasks = Array.from({ length: 8 }, (_, i) =>
    task({ id: 't' + i, title: 'Tehtävä ' + i, durationMinutes: 45 }));
  const routines = [
    routine({ id: 'r1', title: 'R1', preferredTime: null, durationMinutes: 30 }),
    routine({ id: 'r2', title: 'R2', preferredTime: null, durationMinutes: 60 })
  ];

  const { proposals } = proposeSchedule({ tasks, profile, dateIso: DAY, routines, todayIso: DAY });

  const sorted = [...proposals].sort((a, b) => a.time.localeCompare(b.time));
  for (let i = 1; i < sorted.length; i++) {
    assert.ok(sorted[i].time >= sorted[i - 1].endTime,
      `päällekkäisyys: ${sorted[i - 1].time}–${sorted[i - 1].endTime} ja ${sorted[i].time}–${sorted[i].endTime}`);
  }
});

test('INVARIANTTI: ehdotus ei koskaan mene varatun ajan päälle', () => {
  const busy = [
    task({ id: 'aamu', time: '08:00', endTime: '11:00', schedulingState: SCHEDULING.MANUAL }),
    task({ id: 'ilta', time: '17:00', endTime: '20:00', schedulingState: SCHEDULING.MANUAL })
  ];
  const pending = Array.from({ length: 5 }, (_, i) =>
    task({ id: 'p' + i, title: 'P' + i, durationMinutes: 30 }));

  const { proposals } = proposeSchedule({
    tasks: [...busy, ...pending], profile, dateIso: DAY, todayIso: DAY
  });

  for (const proposal of proposals) {
    for (const occupied of busy) {
      const overlap = proposal.time < occupied.endTime && proposal.endTime > occupied.time;
      assert.equal(overlap, false,
        `ehdotus ${proposal.time}–${proposal.endTime} osuu varattuun ${occupied.time}–${occupied.endTime}`);
    }
  }
});

test('INVARIANTTI: sama ehdotus ei esiinny kahdesti', () => {
  const tasks = Array.from({ length: 6 }, (_, i) =>
    task({ id: 't' + i, title: 'T' + i, durationMinutes: 30 }));
  const { proposals } = proposeSchedule({ tasks, profile, dateIso: DAY, todayIso: DAY });
  const ids = proposals.map(p => p.taskId);
  assert.equal(new Set(ids).size, ids.length);
});

test('INVARIANTTI: sijoitettu + sijoittamatta = kaikki ehdokkaat', () => {
  const tasks = Array.from({ length: 12 }, (_, i) =>
    task({ id: 't' + i, title: 'T' + i, durationMinutes: 120 }));
  const routines = [routine({ id: 'r1', preferredTime: null, durationMinutes: 120 })];

  const { proposals, unplaced } = proposeSchedule({
    tasks, profile, dateIso: DAY, routines, todayIso: DAY
  });
  assert.equal(proposals.length + unplaced.length, tasks.length + routines.length,
    'yksikään ehdokas ei saa kadota');
});

test('TAKUU: tulos on deterministinen syötteen järjestyksestä riippumatta', () => {
  const tasks = [
    task({ id: 'a', title: 'Alfa', durationMinutes: 45, deadline: '2026-09-03' }),
    task({ id: 'b', title: 'Beeta', durationMinutes: 30, priority: 'korkea' }),
    task({ id: 'c', title: 'Gamma', durationMinutes: 60 })
  ];
  const routines = [
    routine({ id: 'r1', title: 'R1', preferredTime: null, durationMinutes: 30 }),
    routine({ id: 'r2', title: 'R2', preferredTime: null, durationMinutes: 20 })
  ];

  const first = proposeSchedule({ tasks, profile, dateIso: DAY, routines, todayIso: DAY });
  const second = proposeSchedule({
    tasks: [...tasks].reverse(), profile, dateIso: DAY,
    routines: [...routines].reverse(), todayIso: DAY
  });

  assert.deepEqual(
    first.proposals.map(p => `${p.title}@${p.time}`),
    second.proposals.map(p => `${p.title}@${p.time}`)
  );
});

test('TAKUU: sama kutsu tuottaa saman tuloksen toistettuna', () => {
  const tasks = [task({ id: 'a', title: 'A', durationMinutes: 40 })];
  const routines = [routine({ id: 'r1', preferredTime: null })];
  const runs = Array.from({ length: 5 }, () =>
    JSON.stringify(proposeSchedule({ tasks, profile, dateIso: DAY, routines, todayIso: DAY }).proposals));
  assert.equal(new Set(runs).size, 1, 'moottori ei saa vaihdella ajokerroittain');
});

test('kestoton ehdokas saa oletuskeston', () => {
  const { proposals } = proposeSchedule({
    tasks: [task({ id: 'a', title: 'A' })], profile, dateIso: DAY, todayIso: DAY
  });
  assert.equal(proposals[0].durationMinutes, DEFAULT_TASK_MINUTES);
});

test('täyteen varattu päivä jättää kaikki sijoittamatta', () => {
  const full = task({ id: 'koko', time: '07:00', endTime: '23:00', schedulingState: SCHEDULING.MANUAL });
  const { proposals, unplaced } = proposeSchedule({
    tasks: [full, task({ id: 'uusi', title: 'Uusi', durationMinutes: 60 })],
    profile, dateIso: DAY, todayIso: DAY
  });
  assert.deepEqual(proposals, []);
  assert.equal(unplaced.length, 1);
});

test('buildDayPlan toimii ilman rutiineja kuten ennenkin', () => {
  // Taaksepäin yhteensopivuus: V2:n kutsutapa ei saa rikkoutua.
  const plan = buildDayPlan({ tasks: [task({ id: 'a', time: '09:00' })], profile, dateIso: DAY });
  assert.equal(plan.routineOccurrences.length, 0);
  assert.equal(plan.scheduled.length, 1);
  assert.ok(plan.freeSlots.length > 0);
});
