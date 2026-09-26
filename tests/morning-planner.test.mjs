// Älykäs aamusuunnittelija.
//
// PERIAATE: aamurutiini ajoitetaan taaksepäin ensimmäisestä menosta, eikä
// suunnitelma koskaan lyhennä unta tai pudota vaihetta itse. Kun aamu ei
// mahdu, käyttäjä saa valinnat, ja "herää aiemmin" kertoo unen hinnan.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  planMorning, morningSteps, CHOICE_KIND, ANCHOR_KIND, LEAVE_SOURCE, PROFILE_ROUTINE_STEP_ID,
  MIN_SHORTENED_STEP_MINUTES, MAX_STEP_MINUTES
} from '../src/domain/morningPlanner.js';
import { dayNumberOf } from '../src/domain/wallClock.js';
import { toMinutes } from '../src/domain/task.js';
import { PROTECTION, MAX_MORNING_STEPS } from '../src/domain/dailyLife.js';
import { helsinkiOffset } from './helpers/helsinkiOffset.mjs';
import { readCode, importsOf } from './helpers/sources.mjs';

const TUESDAY = '2026-09-29';
const PROFILE = Object.freeze({ sleepTargetHours: 8, defaultWakeTime: '07:00', commuteMinutes: 30, routineMinutes: 60 });
const STEPS = Object.freeze([
  Object.freeze({ id: 'suihku', name: 'Suihku', minutes: 15, protection: PROTECTION.MANDATORY }),
  Object.freeze({ id: 'aamiainen', name: 'Aamiainen', minutes: 20, protection: PROTECTION.PROTECTED }),
  Object.freeze({ id: 'lenkki', name: 'Aamulenkki', minutes: 30, protection: PROTECTION.IMPORTANT_FLEXIBLE }),
  Object.freeze({ id: 'uutiset', name: 'Uutiset', minutes: 10, protection: PROTECTION.OPTIONAL })
]);
const SETTINGS = Object.freeze({ weekendWakeShiftMaxMinutes: 60, windDownMinutes: 30, morningRoutine: STEPS });
const WORK = Object.freeze({ title: 'Työ', startTime: '08:00', leaveTime: '07:20', prepareStart: '07:10' });

const TONE = /epäonnist|laiska|huono|pitäisi hävetä|suoritus|diagno|sairau|lääkär/i;
const GARBAGE = [undefined, null, 0, -1, NaN, '', 'x', true, [], [null], {}, () => 1, Symbol('s'),
  { dateIso: 5 }, { dateIso: '2026-02-30' }];

const abs = (date, time) => dayNumberOf(date) * 1440 + toMinutes(time);

function plan(overrides = {}) {
  return planMorning({ dateIso: TUESDAY, firstCommitment: WORK, profile: PROFILE, settings: SETTINGS, ...overrides });
}

function assertDeepFrozen(value, path = 'tulos') {
  if (value && typeof value === 'object') {
    assert.ok(Object.isFrozen(value), `${path} ei ole jäädytetty`);
    for (const key of Object.keys(value)) assertDeepFrozen(value[key], `${path}.${key}`);
  }
}

// ================================================================ ilman menoa

test('ilman menoa: aamurutiini alkaa herätyksestä, väljyys on tuntematon eikä nolla', () => {
  const p = planMorning({ dateIso: TUESDAY, firstCommitment: null, profile: PROFILE, settings: SETTINGS });
  assert.equal(p.wakeTime, '07:00');
  assert.equal(p.wakeDate, TUESDAY);
  assert.deepEqual(p.steps.map(step => [step.id, step.start, step.end]), [
    ['suihku', '07:00', '07:15'], ['aamiainen', '07:15', '07:35'], ['lenkki', '07:35', '08:05'], ['uutiset', '08:05', '08:15']
  ]);
  assert.equal(p.totalMinutes, 75);
  assert.equal(p.fits, true);
  assert.equal(p.shortfallMinutes, 0);
  assert.equal(p.slackMinutes, null);
  assert.equal(p.leaveTime, null);
  assert.equal(p.anchorTime, null);
  assert.equal(p.commitment, null);
  assert.deepEqual(p.choices, []);
  assert.equal(p.explanation, 'Aamussa ei ole kiinteää menoa. Herätys 7.00, ja aamurutiini (1 h 15 min) alkaa heti herätyksestä.');
  assertDeepFrozen(p);
});

// ================================================================ meno mahtuu

test('meno: vaiheet peräkkäin päättyen valmistautumisen alkuun; herätys aikaistuu tarpeen mukaan', () => {
  const p = plan();
  assert.equal(p.anchorKind, ANCHOR_KIND.PREPARE);
  assert.equal(p.anchorTime, '07:10');
  assert.equal(p.leaveTime, '07:20');
  assert.equal(p.leaveSource, LEAVE_SOURCE.COMMITMENT);
  assert.equal(p.requiredWakeTime, '05:55');
  assert.equal(p.wakeTime, '05:55');
  assert.equal(p.earlierThanUsualMinutes, 65);
  assert.equal(p.fits, true);
  assert.equal(p.slackMinutes, 0);
  assert.equal(p.steps[0].start, '05:55');
  assert.equal(p.steps.at(-1).end, '07:10', 'viimeinen vaihe päättyy täsmälleen ankkuriin');
  for (let index = 1; index < p.steps.length; index += 1) {
    assert.equal(p.steps[index].start, p.steps[index - 1].end, 'vaiheet ovat peräkkäin ilman aukkoja');
  }
  assert.deepEqual(p.commitment, { title: 'Työ', startTime: '08:00' });
  assert.equal(p.explanation, 'Aamun ensimmäisen menon vuoksi valmistautuminen alkaa 7.10. Aamurutiini (1 h 15 min)'
    + ' on ajoitettu päättymään siihen, herätys 5.55. Herätys on 1 h 5 min tavallista aiemmin.');
});

test('meno myöhään: herätys pysyy tavallisena ja väljyys näkyy', () => {
  const p = plan({ firstCommitment: { title: 'Lääkäri', startTime: '10:00', leaveTime: '09:30', prepareStart: null } });
  assert.equal(p.anchorKind, ANCHOR_KIND.LEAVE);
  assert.equal(p.wakeTime, '07:00');
  assert.equal(p.requiredWakeTime, '08:15');
  assert.equal(p.slackMinutes, 75);
  assert.equal(p.earlierThanUsualMinutes, 0);
  assert.equal(p.steps[0].start, '08:15');
  assert.equal(p.steps.at(-1).end, '09:30');
  assert.match(p.explanation, /Ennen aamurutiinia jää 1 h 15 min väljyyttä\./);
  assert.doesNotMatch(p.explanation, /Lääkäri/, 'selitys ei toista menon nimeä');
});

test('meno ilman omaa matka-aikaa: profiilin matka-aika, ja selitys kertoo sen', () => {
  const p = plan({ firstCommitment: { title: 'Työ', startTime: '08:00' } });
  assert.equal(p.leaveTime, '07:30');
  assert.equal(p.leaveSource, LEAVE_SOURCE.PROFILE_COMMUTE);
  assert.equal(p.anchorKind, ANCHOR_KIND.LEAVE);
  assert.equal(p.wakeTime, '06:15');
  assert.match(p.explanation, /Lähtöaika on laskettu profiilisi matka-ajasta \(30 min\), koska tälle menolle ei ole omaa matka-aikaa\./);

  const noCommute = plan({ firstCommitment: { title: 'Työ', startTime: '08:00' }, profile: { ...PROFILE, commuteMinutes: 0 } });
  assert.equal(noCommute.leaveTime, '08:00', '0 min on käyttäjän oma luku (etätyö), ei tuntematon');
});

test('KRIITTINEN: tuntematon matka-aika ei tuota lähtöaikaa', () => {
  for (const commuteMinutes of [null, undefined, -5, 'puoli tuntia', NaN, 99999]) {
    const p = plan({ firstCommitment: { title: 'Työ', startTime: '08:00', leaveTime: null }, profile: { ...PROFILE, commuteMinutes } });
    assert.equal(p.leaveTime, null, String(commuteMinutes));
    assert.equal(p.leaveSource, null);
    assert.equal(p.anchorKind, ANCHOR_KIND.START);
    assert.equal(p.steps.at(-1).end, '08:00');
    assert.match(p.explanation, /Matka-aikaa ei tiedetä, joten aamu on laskettu menon alkuun asti\./);
  }
  // Valmistautumisen alku tiedossa, matka ei: aamu päättyy valmistautumiseen, lähtöä ei keksitä.
  const prepared = plan({ firstCommitment: { title: 'Työ', startTime: '08:00', prepareStart: '07:15' },
    profile: { ...PROFILE, commuteMinutes: null } });
  assert.equal(prepared.anchorKind, ANCHOR_KIND.PREPARE);
  assert.equal(prepared.leaveTime, null);
  assert.match(prepared.explanation, /Matka-aikaa ei tiedetä, joten lähtöaikaa ei ole laskettu\./);
});

// ================================================================ meno ei mahdu

test('KRIITTINEN: aamu ei mahdu -> unta ei lyhennetä eikä mitään pudoteta itse', () => {
  const p = plan({ wakeTimeLimit: '06:30' });
  assert.equal(p.fits, false);
  assert.equal(p.wakeTime, '06:30', 'herätys pysyy suojatulla rajalla');
  assert.equal(p.requiredWakeTime, '05:55');
  assert.equal(p.shortfallMinutes, 35);
  assert.equal(p.steps.length, 4, 'yhtään vaihetta ei pudotettu');
  assert.equal(p.totalMinutes, 75);
  assert.equal(p.steps[0].start, '05:55', 'vaiheet näyttävät, mitä meno vaatisi');
  assert.equal(p.sleepProtected, true);

  assert.deepEqual(p.choices.map(choice => [choice.kind, choice.stepId, choice.minutes, choice.costsSleepMinutes, choice.coversShortfall]), [
    [CHOICE_KIND.DROP, 'uutiset', 10, 0, false],
    [CHOICE_KIND.SHORTEN, 'lenkki', 25, 0, false],
    [CHOICE_KIND.DROP, 'lenkki', 30, 0, false],
    [CHOICE_KIND.WAKE_EARLIER, null, 35, 35, true]
  ]);
  const earlier = p.choices.at(-1);
  assert.equal(earlier.wakeTime, '05:55');
  assert.equal(earlier.label, 'Herää 35 min aiemmin (5.55). Uni lyhenee 35 min.');
  assert.equal(p.choices[1].label, 'Lyhennä: Aamulenkki 30 min → 5 min');
  assert.equal(p.choices[1].newMinutes, MIN_SHORTENED_STEP_MINUTES);
  assert.equal(p.choices[0].label, 'Jätä pois: Uutiset (10 min)');
  for (const choice of p.choices) {
    assert.notEqual(choice.stepId, 'suihku', 'pakollista ei koskaan ehdoteta pois');
    assert.notEqual(choice.stepId, 'aamiainen', 'suojattua ei koskaan ehdoteta pois');
  }
  assert.equal(p.explanation, 'Aamurutiini (1 h 15 min) ei mahdu herätyksen 6.30 ja valmistautumisen 7.10 väliin:'
    + ' aikaa puuttuu 35 min. Unta ei lyhennetä automaattisesti. Valitse, mitä jätät pois tai lyhennät, tai herää aiemmin, jolloin uni lyhenee.');
});

test('pieni vaje: lyhennys on vain vajeen verran ja valinnat kertovat, riittävätkö ne', () => {
  const p = plan({ wakeTimeLimit: '06:00' });
  assert.equal(p.shortfallMinutes, 5);
  const shorten = p.choices.find(choice => choice.kind === CHOICE_KIND.SHORTEN);
  assert.equal(shorten.minutes, 5);
  assert.equal(shorten.newMinutes, 25);
  assert.ok(p.choices.every(choice => choice.coversShortfall));
});

test('raja: täsmälleen tarvittava herätys mahtuu, minuuttia myöhempi ei', () => {
  const exact = plan({ wakeTimeLimit: '05:55' });
  assert.equal(exact.fits, true);
  assert.equal(exact.slackMinutes, 0);
  assert.equal(exact.wakeTime, '05:55');
  const oneOver = plan({ wakeTimeLimit: '05:56' });
  assert.equal(oneOver.fits, false);
  assert.equal(oneOver.shortfallMinutes, 1);
  const earlierLimit = plan({ wakeTimeLimit: '05:00' });
  assert.equal(earlierLimit.wakeTime, '05:55', 'raja on alaraja, ei herätysaika');
});

test('kaikki vaiheet pakollisia tai suojattuja: ainoa valinta on herätä aiemmin ja sen hinta kerrotaan', () => {
  const steps = [
    { id: 'a', name: 'Pukeutuminen', minutes: 30, protection: PROTECTION.MANDATORY },
    { id: 'b', name: 'Hengitysharjoitus', minutes: 30, protection: PROTECTION.PROTECTED }
  ];
  const p = plan({ steps, wakeTimeLimit: '06:30' });
  assert.equal(p.fits, false);
  assert.equal(p.shortfallMinutes, 20);
  assert.deepEqual(p.choices.map(choice => choice.kind), [CHOICE_KIND.WAKE_EARLIER]);
  assert.equal(p.choices[0].costsSleepMinutes, 20);
  assert.match(p.explanation, /Kaikki vaiheet ovat pakollisia tai suojattuja\./);
  assert.match(p.explanation, /voit herätä 20 min aiemmin, jolloin uni lyhenee saman verran\./);
});

test(`lyhennys: alle ${MIN_SHORTENED_STEP_MINUTES + 1} min vaihetta ei lyhennetä, sen voi vain jättää pois`, () => {
  const steps = [
    { id: 'a', name: 'Pukeutuminen', minutes: 60, protection: PROTECTION.MANDATORY },
    { id: 'b', name: 'Venyttely', minutes: 5, protection: PROTECTION.IMPORTANT_FLEXIBLE }
  ];
  const p = plan({ steps, wakeTimeLimit: '06:30' });
  assert.deepEqual(p.choices.map(choice => choice.id), ['drop:b', 'wake_earlier']);
});

test('valinnat eivät riipu vaiheiden järjestyksestä; tasapeli ratkeaa suomalaisella aakkostuksella', () => {
  const steps = [
    { id: 's1', name: 'Pukeutuminen', minutes: 30, protection: PROTECTION.MANDATORY },
    { id: 's2', name: 'Banaani', minutes: 10, protection: PROTECTION.OPTIONAL },
    { id: 's3', name: 'aamukahvi', minutes: 10, protection: PROTECTION.OPTIONAL },
    { id: 's4', name: 'Uutiset', minutes: 15, protection: PROTECTION.OPTIONAL },
    { id: 's5', name: 'Venyttely', minutes: 20, protection: PROTECTION.IMPORTANT_FLEXIBLE },
    { id: 's6', name: 'Jooga', minutes: 20, protection: PROTECTION.IMPORTANT_FLEXIBLE }
  ];
  const reference = plan({ steps, wakeTimeLimit: '06:45' });
  assert.deepEqual(reference.choices.map(choice => choice.id), [
    'drop:s4', 'drop:s3', 'drop:s2', 'shorten:s6', 'shorten:s5', 'drop:s6', 'drop:s5', 'wake_earlier'
  ]);
  let seed = 11;
  for (let round = 0; round < 20; round += 1) {
    const shuffled = [...steps].sort(() => {
      seed = (seed * 48271) % 2147483647;
      return (seed % 3) - 1;
    });
    assert.equal(JSON.stringify(plan({ steps: shuffled, wakeTimeLimit: '06:45' }).choices), JSON.stringify(reference.choices));
  }
});

// ================================================================ vaiheiden siistiminen

test('aamurutiinin vaiheet: virheelliset ohitetaan, kaksoiskappaleet ja yläraja', () => {
  const raw = [
    null, 'x', { id: '', minutes: 10 }, { id: 'a', minutes: 0 }, { id: 'b', minutes: MAX_STEP_MINUTES + 1 },
    { id: 'c', minutes: '10' }, { id: 'd', minutes: 10.4, name: '  Kahvi \n ja\tlehti  ', protection: 'tuntematon' },
    { id: 'd', minutes: 20, name: 'toinen' }, { id: 7, minutes: 5, protection: PROTECTION.MANDATORY }, { id: 'e', minutes: NaN }
  ];
  const steps = morningSteps(raw);
  assert.deepEqual(steps.map(step => [step.id, step.minutes, step.name, step.protection]), [
    ['d', 10, 'Kahvi ja lehti', PROTECTION.OPTIONAL],
    ['7', 5, 'Aamun vaihe', PROTECTION.MANDATORY]
  ]);
  const many = Array.from({ length: 50 }, (_, index) => ({ id: 's' + index, minutes: 1 }));
  assert.equal(morningSteps(many).length, MAX_MORNING_STEPS);
  for (const bad of GARBAGE) assert.deepEqual(morningSteps(bad), []);
});

test('ilman omaa aamurutiinia käytetään profiilin aamutoimia pakollisena vaiheena', () => {
  const p = planMorning({ dateIso: TUESDAY, profile: PROFILE, settings: { morningRoutine: [] }, firstCommitment: WORK });
  assert.equal(p.stepsFromProfile, true);
  assert.deepEqual(p.steps.map(step => [step.id, step.name, step.minutes, step.protection]),
    [[PROFILE_ROUTINE_STEP_ID, 'Aamutoimet', 60, PROTECTION.MANDATORY]]);
  assert.equal(p.wakeTime, '06:10');

  const none = planMorning({ dateIso: TUESDAY, profile: { ...PROFILE, routineMinutes: 0 }, settings: {}, firstCommitment: WORK });
  assert.deepEqual(none.steps, []);
  assert.equal(none.totalMinutes, 0);
  assert.equal(none.wakeTime, '07:00', 'ilman aamurutiinia herätys pysyy tavallisena');

  const garbage = planMorning({ dateIso: TUESDAY, profile: { ...PROFILE, routineMinutes: 'tunti' }, settings: {} });
  assert.equal(garbage.totalMinutes, 60);

  const fromSettings = planMorning({ dateIso: TUESDAY, profile: PROFILE, settings: SETTINGS });
  assert.equal(fromSettings.totalMinutes, 75);
  assert.equal(fromSettings.stepsFromProfile, false);
});

// ================================================================ viikonloppu ja oma herätys

test('viikonloppuna tavallinen herätys on väljempi; oma herätysaika voittaa', () => {
  const saturday = planMorning({ dateIso: '2026-10-03', profile: PROFILE, settings: SETTINGS,
    firstCommitment: { title: 'Kirpputori', startTime: '11:00', leaveTime: '10:30' } });
  assert.equal(saturday.wakeTime, '08:00');
  assert.equal(saturday.slackMinutes, 75);

  const own = planMorning({ dateIso: TUESDAY, profile: PROFILE, settings: SETTINGS, usualWakeTime: '06:30' });
  assert.equal(own.wakeTime, '06:30');
  assert.equal(own.usualWakeTime, '06:30');
});

// ================================================================ keskiyö ja kesäaika

test('keskiyön, kuukauden ja vuoden vaihde: aamu voi alkaa edellisenä päivänä', () => {
  const p = planMorning({ dateIso: '2026-10-01', profile: PROFILE, settings: SETTINGS,
    firstCommitment: { title: 'Yövuoro', startTime: '00:30', leaveTime: '00:00' } });
  assert.equal(p.wakeTime, '22:45');
  assert.equal(p.wakeDate, '2026-09-30');
  assert.equal(p.steps[0].startDate, '2026-09-30');
  assert.equal(p.steps.at(-1).endDate, '2026-10-01');
  assert.equal(p.leaveDate, '2026-10-01');

  const newYear = planMorning({ dateIso: '2027-01-01', profile: PROFILE, settings: SETTINGS,
    firstCommitment: { title: 'Yövuoro', startTime: '00:30', leaveTime: '23:50' } });
  assert.equal(newYear.leaveDate, '2026-12-31', 'lähtö ennen keskiyötä on edellisenä päivänä');
  assert.equal(newYear.leaveTime, '23:50');
  assert.equal(newYear.wakeDate, '2026-12-31');
});

test('KESÄAIKA: kevään siirtymä, aamurutiinin todellinen kesto säilyy', () => {
  // Su 29.3.2026: lähtö 4.30 (kesäaikaa). 90 min todellista aikaa taaksepäin on 2.00 (talviaikaa).
  const steps = [
    { id: 'a', name: 'Valmistelu', minutes: 60, protection: PROTECTION.MANDATORY },
    { id: 'b', name: 'Aamiainen', minutes: 30, protection: PROTECTION.MANDATORY }
  ];
  const commitment = { title: 'Lento', startTime: '05:00', leaveTime: '04:30' };
  const zoned = planMorning({ dateIso: '2026-03-29', profile: PROFILE, settings: SETTINGS, steps, firstCommitment: commitment,
    offsetMinutesFn: helsinkiOffset });
  assert.equal(zoned.wakeTime, '02:00');
  assert.deepEqual(zoned.steps.map(step => [step.start, step.end]), [['02:00', '04:00'], ['04:00', '04:30']]);
  const wall = planMorning({ dateIso: '2026-03-29', profile: PROFILE, settings: SETTINGS, steps, firstCommitment: commitment });
  assert.equal(wall.wakeTime, '03:00', 'ilman aikavyöhykettä seinäkello');
});

test('KESÄAIKA: syksyn siirtymä, toistuva tunti ei syö aamurutiinia', () => {
  // Su 25.10.2026: lähtö 4.30 (talviaikaa). 2 h todellista aikaa taaksepäin on 3.30 kesäaikaa.
  const steps = [
    { id: 'a', name: 'Valmistelu', minutes: 60, protection: PROTECTION.MANDATORY },
    { id: 'b', name: 'Aamiainen', minutes: 60, protection: PROTECTION.MANDATORY }
  ];
  const p = planMorning({ dateIso: '2026-10-25', profile: PROFILE, settings: SETTINGS, steps,
    firstCommitment: { title: 'Lento', startTime: '05:00', leaveTime: '04:30' }, offsetMinutesFn: helsinkiOffset });
  assert.equal(p.wakeTime, '03:30');
  assert.deepEqual(p.steps.map(step => [step.start, step.end]), [['03:30', '03:30'], ['03:30', '04:30']]);
});

// ================================================================ ominaisuustesti

test('INVARIANTIT: satunnaiset aamut (siemen) pitävät lupaukset', () => {
  let seed = 20260926;
  const random = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  const pad = n => String(n).padStart(2, '0');
  const time = minutes => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
  const protections = [PROTECTION.MANDATORY, PROTECTION.PROTECTED, PROTECTION.IMPORTANT_FLEXIBLE, PROTECTION.OPTIONAL];
  for (let round = 0; round < 400; round += 1) {
    const steps = Array.from({ length: Math.floor(random() * 6) }, (_, index) => ({
      id: 'x' + index, name: 'Vaihe ' + index, minutes: 1 + Math.floor(random() * 60),
      protection: protections[Math.floor(random() * 4)]
    }));
    const start = 300 + Math.floor(random() * 360);
    const commitment = random() < 0.8 ? { title: 'Meno', startTime: time(start), leaveTime: time(start - Math.floor(random() * 60)) } : null;
    const limit = random() < 0.5 ? time(240 + Math.floor(random() * 240)) : null;
    const p = planMorning({ dateIso: TUESDAY, profile: PROFILE, settings: SETTINGS, steps, firstCommitment: commitment, wakeTimeLimit: limit });
    const wake = abs(p.wakeDate, p.wakeTime);
    if (limit) assert.ok(wake >= abs(TUESDAY, limit), 'herätys ei koskaan aiemmin kuin suojattu raja');
    assert.ok(p.slackMinutes === null || p.slackMinutes >= 0);
    const ids = new Set(steps.filter(step => [PROTECTION.MANDATORY, PROTECTION.PROTECTED].includes(step.protection)).map(step => step.id));
    for (const choice of p.choices) assert.ok(!ids.has(choice.stepId), 'pakollinen tai suojattu vaihe valinnoissa');
    if (!p.fits) {
      const earlier = p.choices.find(choice => choice.kind === CHOICE_KIND.WAKE_EARLIER);
      assert.equal(earlier.costsSleepMinutes, p.shortfallMinutes);
      assert.ok(p.shortfallMinutes > 0);
      assert.equal(p.choices.at(-1).kind, CHOICE_KIND.WAKE_EARLIER, 'unen hinta on viimeinen vaihtoehto');
    } else if (commitment && p.steps.length > 0) {
      assert.equal(abs(p.steps.at(-1).endDate, p.steps.at(-1).end), abs(TUESDAY, p.anchorTime));
      assert.ok(abs(p.steps[0].startDate, p.steps[0].start) >= wake);
    }
    // Ilman omia vaiheita käytetään profiilin aamutoimia (1 vaihe).
    assert.equal(p.steps.length, steps.length || 1, 'vaiheita ei pudoteta itse');
  }
});

// ================================================================ kestävyys

test('roskasyöte ei koskaan kaada; virheellinen päivä -> null', () => {
  for (const bad of GARBAGE) {
    assert.doesNotThrow(() => planMorning(bad));
    assert.equal(planMorning(bad), null);
    assert.doesNotThrow(() => planMorning({ dateIso: TUESDAY, firstCommitment: bad, steps: bad, profile: bad, settings: bad,
      wakeTimeLimit: bad, usualWakeTime: bad, offsetMinutesFn: bad }));
  }
  assert.equal(planMorning({ dateIso: TUESDAY, offsetMinutesFn: () => { throw new Error('boom'); } }), null);
  assert.equal(planMorning({ dateIso: TUESDAY, offsetMinutesFn: () => 0.5 }), null, 'epäkelpo aikavyöhyke ei ole arvaus');
  // Virheellinen lähtöaika = ei annettu: profiilin matka-aika. Lähdön
  // jälkeinen valmistautuminen on ristiriitainen ja jätetään huomiotta.
  const odd = planMorning({ dateIso: TUESDAY, profile: PROFILE, settings: SETTINGS,
    firstCommitment: { title: 42, startTime: '08:00', leaveTime: 'pian', prepareStart: '09:00' } });
  assert.equal(odd.commitment.title, null);
  assert.equal(odd.leaveTime, '07:30');
  assert.equal(odd.leaveSource, LEAVE_SOURCE.PROFILE_COMMUTE);
  assert.equal(odd.anchorKind, ANCHOR_KIND.LEAVE);
  assert.equal(odd.anchorTime, '07:30');

  // Menon alun jälkeinen lähtö ei ole "edellinen ilta" 23 tunnin päässä: tuntematon.
  const contradictory = planMorning({ dateIso: TUESDAY, profile: PROFILE, settings: SETTINGS,
    firstCommitment: { title: 'Meno', startTime: '08:00', leaveTime: '09:00' } });
  assert.equal(contradictory.leaveTime, null);
  assert.equal(contradictory.leaveSource, null);
  assert.equal(contradictory.anchorKind, ANCHOR_KIND.START);
});

test('deterministinen, jäädytetty eikä muuta syötettä', () => {
  const input = { dateIso: TUESDAY, firstCommitment: { ...WORK }, profile: { ...PROFILE },
    settings: { ...SETTINGS, morningRoutine: STEPS.map(step => ({ ...step })) }, wakeTimeLimit: '06:30' };
  const before = JSON.stringify(input);
  const first = JSON.stringify(planMorning(input));
  for (let index = 0; index < 20; index += 1) assert.equal(JSON.stringify(planMorning(input)), first);
  assert.equal(JSON.stringify(input), before);
  assert.equal(Object.isFrozen(input.settings.morningRoutine[0]), false, 'kutsujan olioita ei jäädytetä');
  assertDeepFrozen(planMorning(input));
});

test('sävy: selitykset ovat rauhallisia eivätkä syyllistä', () => {
  const texts = [
    plan().explanation, plan({ wakeTimeLimit: '06:30' }).explanation, plan({ firstCommitment: null }).explanation,
    plan({ steps: [{ id: 'a', minutes: 90, protection: PROTECTION.MANDATORY }], wakeTimeLimit: '07:00' }).explanation,
    ...plan({ wakeTimeLimit: '06:30' }).choices.map(choice => choice.label)
  ];
  for (const text of texts) {
    assert.ok(text.length > 0);
    assert.doesNotMatch(text, TONE, text);
  }
});

test('suorituskyky: valtava vaihelista käsitellään lineaarisesti ja rajataan', () => {
  const huge = Array.from({ length: 200000 }, (_, index) => (index % 2 ? null : { id: 'dup', minutes: 5 }));
  const start = process.hrtime.bigint();
  const p = planMorning({ dateIso: TUESDAY, steps: huge, profile: PROFILE, settings: SETTINGS, firstCommitment: WORK });
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  assert.equal(p.steps.length, 1);
  assert.ok(ms < 1000, `${ms} ms`);
});

test('PUHTAUS: aamusuunnittelija ei lue kelloa eikä koske DOM:iin', () => {
  const file = 'src/domain/morningPlanner.js';
  const code = readCode(file);
  for (const token of ['Date.now(', 'Math.random', 'crypto.randomUUID', 'performance.now', 'document.', 'window.',
    'localStorage', 'fetch(', 'console.']) {
    assert.equal(code.includes(token), false, `${file}: ${token}`);
  }
  assert.equal(/new Date\(/.test(code), false);
  for (const target of importsOf(file)) assert.ok(target.startsWith('src/domain/'), target);
  assert.ok(importsOf(file).includes('src/domain/dailyLife.js'));
});
