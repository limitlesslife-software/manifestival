// Herätyssuunnitelma, seinäkello -> hetki, torkku ja aamun katsaus.
//
// PERIAATE: herätys on käyttäjän valinta (oletuksena pois), se soi
// rajatusti (enintään MAX_ALARM_RING_MINUTES, rajatut torkut), aamun meno
// saa aikaistaa sitä vain suojatun unen rajaan asti, ja kesäajan siirtymä
// ei koskaan saa herätystä soimaan myöhässä.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import {
  desiredAlarms, alarmSettingsOf, validateEscalation, normalizeEscalation, firstCommitmentOf, morningOfDay,
  snoozeAlarm, dedupeAlarms, alarmEpoch, morningBrief, wallClockToEpoch, epochToWallClock,
  MAX_ALARM_DAYS, MAX_ESCALATION_STEPS, MAX_RING_SECONDS, DEFAULT_ESCALATION, DEFAULT_SNOOZE_MINUTES,
  ALARM_SOURCE, BRIEF_MAX_SENTENCES, MIN_RUN_MINUTES, MAX_BRIEF_TITLE_LENGTH
} from '../src/domain/alarmPlan.js';
import {
  ALARM_MODE, ESCALATION_STEP, MAX_ALARM_RING_MINUTES, MAX_SNOOZE_MINUTES, MAX_SNOOZES, PROTECTION
} from '../src/domain/dailyLife.js';
import { sleepScheduleFor } from '../src/domain/sleepRhythm.js';
import { helsinkiOffset, intlOffsetFn, SPRING_FORWARD_2026, FALL_BACK_2026 } from './helpers/helsinkiOffset.mjs';
import { ROOT, readCode, importsOf } from './helpers/sources.mjs';

const MONDAY = '2026-09-28';
const FRIDAY = '2026-10-02';
const PROFILE = Object.freeze({ sleepTargetHours: 8, defaultWakeTime: '07:00', commuteMinutes: 30, routineMinutes: 60 });
const STEPS = Object.freeze([
  { id: 'suihku', name: 'Suihku', minutes: 15, protection: PROTECTION.MANDATORY },
  { id: 'aamiainen', name: 'Aamiainen', minutes: 20, protection: PROTECTION.PROTECTED },
  { id: 'lenkki', name: 'Aamulenkki', minutes: 30, protection: PROTECTION.IMPORTANT_FLEXIBLE },
  { id: 'uutiset', name: 'Uutiset', minutes: 10, protection: PROTECTION.OPTIONAL }
]);
const SETTINGS = Object.freeze({ weekendWakeShiftMaxMinutes: 60, windDownMinutes: 30, morningRoutine: STEPS, alarm: { enabled: true } });
const MEETING = Object.freeze({ id: 'e1', title: 'Palaveri', startTime: '08:00', leaveTime: '07:20', category: 'tyo', notes: 'salainen muistiinpano' });

const GARBAGE = [undefined, null, 0, -1, NaN, '', 'x', true, [], [null], {}, () => 1, Symbol('s'), { fromIso: 5 }];

function alarms(overrides = {}) {
  return desiredAlarms({ fromIso: MONDAY, days: 1, profile: PROFILE, settings: SETTINGS, ...overrides });
}

function assertDeepFrozen(value, path = 'tulos') {
  if (value && typeof value === 'object') {
    assert.ok(Object.isFrozen(value), `${path} ei ole jäädytetty`);
    for (const key of Object.keys(value)) assertDeepFrozen(value[key], `${path}.${key}`);
  }
}

/** Virkkeet: piste, huuto- tai kysymysmerkki ja välilyönti ennen isoa kirjainta. */
function sentences(text) {
  return text.split(/(?<=[.!?])\s+(?=[A-ZÅÄÖ])/).filter(Boolean).length;
}

// ================================================================ herätykset

test('KRIITTINEN: herätystä ei synny ilman käyttäjän valintaa', () => {
  assert.deepEqual(desiredAlarms({ fromIso: MONDAY, profile: PROFILE, settings: {} }), []);
  assert.deepEqual(desiredAlarms({ fromIso: MONDAY, profile: PROFILE }), []);
  assert.deepEqual(alarms({ settings: { ...SETTINGS, alarm: { enabled: false } } }), []);
  assert.deepEqual(alarms({ settings: { ...SETTINGS, alarm: { enabled: 'true' } } }), [], 'vain tosi true kelpaa');
  assert.equal(alarmSettingsOf(undefined).enabled, false);
});

test('arkiaamu ilman menoa: herätys profiilin mukaan, rajattu soitto ja torkku', () => {
  const [alarm, ...rest] = alarms();
  assert.equal(rest.length, 0);
  assert.equal(alarm.id, `wake:${MONDAY}`);
  assert.equal(alarm.forDate, MONDAY);
  assert.equal(alarm.date, MONDAY);
  assert.equal(alarm.time, '07:00');
  assert.equal(alarm.weekend, false);
  assert.equal(alarm.mode, ALARM_MODE.SOUND);
  assert.deepEqual(alarm.escalation, DEFAULT_ESCALATION);
  assert.equal(alarm.maxRingSeconds, MAX_ALARM_RING_MINUTES * 60);
  assert.equal(alarm.snoozeMinutes, DEFAULT_SNOOZE_MINUTES);
  assert.equal(alarm.maxSnoozes, MAX_SNOOZES);
  assert.equal(alarm.snoozeCount, 0);
  assert.equal(alarm.label, 'Herätys');
  assert.equal(alarm.source, ALARM_SOURCE.RHYTHM);
  assert.equal(alarm.fits, true);
  assert.equal(alarm.briefText, null, 'katsaus vain, kun käyttäjä on ottanut sen käyttöön');
  assert.equal(alarm.reason, sleepScheduleFor({ dateIso: MONDAY, profile: PROFILE, settings: SETTINGS }).reason);
  assert.equal('epochMs' in alarm, false, 'domain ei tunne aikavyöhykettä: vain seinäkelloaika');
  assertDeepFrozen(alarm);
});

test(`päiviä enintään ${MAX_ALARM_DAYS}; vuoden vaihde ja viikonloppu`, () => {
  assert.equal(alarms({ days: 5 }).length, MAX_ALARM_DAYS);
  for (const days of [0, -2, 'kolme', null, NaN]) assert.equal(alarms({ days }).length, 1, String(days));
  const newYear = desiredAlarms({ fromIso: '2026-12-31', days: 3, profile: PROFILE, settings: SETTINGS });
  assert.deepEqual(newYear.map(alarm => [alarm.id, alarm.time]), [
    ['wake:2026-12-31', '07:00'], ['wake:2027-01-01', '07:00'], ['wake:2027-01-02', '08:00']
  ]);
  assert.equal(newYear[2].weekend, true);
});

test('oma arki- ja viikonloppuherätys voittaa rytmin oletuksen', () => {
  const settings = { ...SETTINGS, alarm: { enabled: true, weekdayTime: '06:45', weekendTime: '09:15' } };
  const list = desiredAlarms({ fromIso: FRIDAY, days: 3, profile: PROFILE, settings });
  assert.deepEqual(list.map(alarm => [alarm.forDate, alarm.time, alarm.source]), [
    [FRIDAY, '06:45', ALARM_SOURCE.OVERRIDE],
    ['2026-10-03', '09:15', ALARM_SOURCE.OVERRIDE],
    ['2026-10-04', '09:15', ALARM_SOURCE.OVERRIDE]
  ]);
  assert.equal(list[0].reason, 'Oma arkiaamun herätysaikasi 6.45.');
  assert.equal(list[1].reason, 'Oma viikonlopun herätysaikasi 9.15.');
});

test('aamun meno aikaistaa herätystä suunnitelman mukaan; followPlan: false pitää ajan', () => {
  const [planned] = alarms({ commitmentsByDate: { [MONDAY]: MEETING } });
  assert.equal(planned.time, '06:05', 'lähtö 7.20 - aamurutiini 75 min');
  assert.equal(planned.source, ALARM_SOURCE.PLAN);
  assert.equal(planned.leaveTime, '07:20');
  assert.match(planned.reason, /Herätys on 55 min tavallista aiemmin\./);

  const [fixed] = alarms({ commitmentsByDate: { [MONDAY]: MEETING }, settings: { ...SETTINGS, alarm: { enabled: true, followPlan: false } } });
  assert.equal(fixed.time, '07:00');
  assert.equal(fixed.source, ALARM_SOURCE.RHYTHM);
});

test('oma herätysaika + meno: meno aikaistaa vain, kun se vaatii aiempaa', () => {
  const settings = { ...SETTINGS, alarm: { enabled: true, weekdayTime: '06:45' } };
  assert.equal(alarms({ settings, commitmentsByDate: { [MONDAY]: MEETING } })[0].time, '06:05');
  const late = { title: 'Myöhäinen', startTime: '09:00', leaveTime: '08:30' };
  const [kept] = alarms({ settings, commitmentsByDate: { [MONDAY]: late } });
  assert.equal(kept.time, '06:45');
  assert.equal(kept.source, ALARM_SOURCE.OVERRIDE);
});

test('KRIITTINEN: myöhään nukkumaan mennyt ei menetä unta huomaamatta', () => {
  const at = actualBedtime => alarms({
    commitmentsByDate: { [MONDAY]: MEETING },
    sleepLogs: [{ id: 's1', wakeDate: MONDAY, actualBedtime, actualWake: null }]
  })[0];
  // 23.30 + 8 h = 7.30 -> raja tavallinen herätys 7.00; meno vaatisi 6.05.
  const late = at('23:30');
  assert.equal(late.time, '07:00');
  assert.equal(late.fits, false);
  assert.equal(late.shortfallMinutes, 55);
  assert.match(late.reason, /ei mahdu herätyksen 7\.00 ja lähdön 7\.20 väliin: aikaa puuttuu 55 min/);
  // 22.30 + 8 h = 6.30: herätys 6.30, vaje 25 min.
  const mid = at('22:30');
  assert.equal(mid.time, '06:30');
  assert.equal(mid.shortfallMinutes, 25);
  // 22.00 + 8 h = 6.00: meno mahtuu.
  const early = at('22:00');
  assert.equal(early.time, '06:05');
  assert.equal(early.fits, true);
  // Ilman kirjausta meno saa aikaistaa (illan huomautus on jo ehdottanut aiempaa nukkumaanmenoa).
  assert.equal(at(null).time, '06:05');
  // Toisen päivän kirjaus ei vaikuta.
  const other = alarms({ commitmentsByDate: { [MONDAY]: MEETING }, sleepLogs: [{ wakeDate: '2026-09-27', actualBedtime: '02:00' }] });
  assert.equal(other[0].time, '06:05');
});

test('KRIITTINEN: keskiyön jälkeinen meno ei ole aamun meno eikä tee herätystä edelliselle illalle', () => {
  // Etäpuhelu klo 00.15 kotona: aamurutiini (75 min) alkaisi jo edellisenä iltana klo 23.00.
  const midnight = { id: 'm', title: 'Etäpuhelu', startTime: '00:15', leaveTime: '00:15' };
  const [alone] = alarms({ commitmentsByDate: { [MONDAY]: [midnight] } });
  assert.deepEqual([alone.date, alone.time, alone.source], [MONDAY, '07:00', ALARM_SOURCE.RHYTHM],
    'tavallinen herätys herätyspäivänä, ei edellisenä iltana');

  // Aamun palaverin kanssa palaveri ratkaisee, kuten ilman keskiyön menoa.
  const [both] = alarms({ commitmentsByDate: { [MONDAY]: [midnight, MEETING] } });
  assert.deepEqual([both.date, both.time, both.leaveTime, both.source], [MONDAY, '06:05', '07:20', ALARM_SOURCE.PLAN]);
  // Kirjattu nukkumaanmeno (aikaisin sallittu herätys) ei muuta valintaa.
  const [logged] = alarms({
    commitmentsByDate: { [MONDAY]: [midnight, MEETING] },
    sleepLogs: [{ id: 's1', wakeDate: MONDAY, actualBedtime: '22:00' }]
  });
  assert.deepEqual([logged.date, logged.time, logged.fits], [MONDAY, '06:05', true]);

  const chosen = morningOfDay({ dateIso: MONDAY, commitments: [midnight, MEETING], profile: PROFILE, settings: SETTINGS });
  assert.equal(chosen.commitment.id, 'e1');
  assert.deepEqual([chosen.plan.wakeDate, chosen.plan.wakeTime], [MONDAY, '06:05']);
  const none = morningOfDay({ dateIso: MONDAY, commitments: [midnight], profile: PROFILE, settings: SETTINGS });
  assert.equal(none.commitment, null);
  assert.deepEqual([none.plan.wakeDate, none.plan.wakeTime], [MONDAY, '07:00']);
});

test('menot: Map, taulukko, koko päivän menot ja perityt avaimet', () => {
  const map = new Map([[MONDAY, MEETING]]);
  assert.equal(alarms({ commitmentsByDate: map })[0].time, '06:05');

  const list = [
    { id: 'a', title: 'A', startTime: '08:00', leaveTime: '07:30' },
    { id: 'b', title: 'B', startTime: '09:00', leaveTime: '07:00' },
    { id: 'c', title: 'Koko päivä', startTime: null }
  ];
  assert.equal(firstCommitmentOf(list, PROFILE).id, 'b', 'aamua sitoo aikaisin lähtö, ei aikaisin alku');
  assert.equal(alarms({ commitmentsByDate: { [MONDAY]: list } })[0].time, '05:45');
  assert.equal(alarms({ commitmentsByDate: { [MONDAY]: [{ title: 'Koko päivä', startTime: null }] } })[0].time, '07:00');

  const inherited = Object.create({ [MONDAY]: { title: 'Peritty', startTime: '05:00' } });
  assert.equal(alarms({ commitmentsByDate: inherited })[0].time, '07:00', 'vain omat avaimet');
  assert.equal(firstCommitmentOf('x', PROFILE), null);
});

test('valinta on deterministinen sekoitetussa järjestyksessä', () => {
  const list = [
    { id: 'x', title: 'Öljynvaihto', startTime: '08:00', leaveTime: '07:30' },
    { id: 'y', title: 'Aamupala', startTime: '08:00', leaveTime: '07:30' },
    { id: 'z', title: 'Aamupala', startTime: '08:00', leaveTime: '07:30' },
    { id: 'w', title: 'Kokous', startTime: '10:00', leaveTime: '09:00' }
  ];
  const reference = JSON.stringify(desiredAlarms({ fromIso: MONDAY, days: 3, profile: PROFILE,
    settings: { ...SETTINGS, morningBriefEnabled: true }, commitmentsByDate: { [MONDAY]: list } }));
  assert.equal(firstCommitmentOf(list, PROFILE).id, 'y');
  for (const order of [[3, 2, 1, 0], [1, 0, 3, 2], [2, 3, 0, 1]]) {
    const shuffled = order.map(index => list[index]);
    assert.equal(firstCommitmentOf(shuffled, PROFILE).id, 'y');
    assert.equal(JSON.stringify(desiredAlarms({ fromIso: MONDAY, days: 3, profile: PROFILE,
      settings: { ...SETTINGS, morningBriefEnabled: true }, commitmentsByDate: { [MONDAY]: shuffled } })), reference);
  }
});

test('katsaus herätykseen vain, kun se on otettu käyttöön', () => {
  const [alarm] = alarms({ settings: { ...SETTINGS, morningBriefEnabled: true }, commitmentsByDate: { [MONDAY]: MEETING } });
  assert.equal(alarm.briefText,
    'Hyvää huomenta. Kello on 6.05. Työmatkan lähtötavoite on 7.20. Ensimmäinen meno on Palaveri kello 8.00.');
  assert.doesNotMatch(alarm.briefText, /salainen/, 'muistiinpanoja ei kerrota koskaan');
  assert.equal(alarms({ commitmentsByDate: { [MONDAY]: MEETING } })[0].briefText, null);
});

// ================================================================ voimistuminen

test('voimistumisen tarkistus: enintään 4 vaihetta, kasvava, alle 10 min, tunnetut vaiheet', () => {
  const step = (afterSeconds, name = ESCALATION_STEP.SOFT) => ({ afterSeconds, step: name });
  assert.equal(validateEscalation(undefined).valid, true);
  assert.equal(validateEscalation([]).valid, true);
  assert.equal(validateEscalation([step(0), step(30, ESCALATION_STEP.SPEECH), step(90, ESCALATION_STEP.LOUD), step(599)]).valid, true);
  const cases = [
    [[step(0), step(1), step(2), step(3), step(4)], `enintään ${MAX_ESCALATION_STEPS}`],
    [[step(30), step(30)], 'kasvavassa'],
    [[step(60), step(30)], 'kasvavassa'],
    [[step(0), step(MAX_RING_SECONDS)], `enintään ${MAX_ALARM_RING_MINUTES} minuuttia`],
    [[step(-1)], 'alkamisaika'],
    [[step(1.5)], 'alkamisaika'],
    [[{ afterSeconds: 0, step: 'sireeni' }], 'tuntematon'],
    ['kaikki', 'virheelliset'],
    [[null], 'tuntematon']
  ];
  for (const [steps, fragment] of cases) {
    const result = validateEscalation(steps);
    assert.equal(result.valid, false, JSON.stringify(steps));
    assert.ok(result.errors.escalation.includes(fragment), result.errors.escalation);
  }
});

test('voimistuminen käyttökuntoon: järjestys, kaksoiskappaleet, puhe vain luvalla, enintään 4', () => {
  const raw = [
    { afterSeconds: 120, step: ESCALATION_STEP.LOUD },
    { afterSeconds: 0, step: ESCALATION_STEP.SOFT },
    { afterSeconds: 60, step: ESCALATION_STEP.SPEECH },
    { afterSeconds: 60, step: ESCALATION_STEP.LOUD },
    { afterSeconds: 900, step: ESCALATION_STEP.LOUD },
    { afterSeconds: 300, step: ESCALATION_STEP.REPEAT_SPEECH },
    { afterSeconds: 400, step: ESCALATION_STEP.LOUD },
    { afterSeconds: 500, step: ESCALATION_STEP.LOUD },
    null, 'x'
  ];
  assert.deepEqual(normalizeEscalation(raw, { speechAllowed: false }).map(item => [item.afterSeconds, item.step]), [
    [0, 'soft'], [60, 'loud'], [120, 'loud'], [400, 'loud']
  ]);
  assert.deepEqual(normalizeEscalation(raw, { speechAllowed: true }).map(item => [item.afterSeconds, item.step]), [
    [0, 'soft'], [60, 'speech'], [120, 'loud'], [300, 'repeat_speech']
  ]);
  assert.equal(normalizeEscalation('x'), DEFAULT_ESCALATION);
  assert.deepEqual(normalizeEscalation([]), [], 'tyhjä lista = soi tasaisesti valitulla tavalla');
});

test('herätysasetukset rajataan: torkku, torkkujen määrä, tila ja puhe', () => {
  assert.equal(alarmSettingsOf({ alarm: { snoozeMinutes: 45 } }).snoozeMinutes, MAX_SNOOZE_MINUTES);
  assert.equal(alarmSettingsOf({ alarm: { snoozeMinutes: 0 } }).snoozeMinutes, 1);
  assert.equal(alarmSettingsOf({ alarm: { maxSnoozes: 9 } }).maxSnoozes, MAX_SNOOZES);
  assert.equal(alarmSettingsOf({ alarm: { maxSnoozes: -1 } }).maxSnoozes, 0);
  assert.equal(alarmSettingsOf({ alarm: { mode: 'karjunta' } }).mode, ALARM_MODE.SOUND);
  const speechStep = [{ afterSeconds: 30, step: ESCALATION_STEP.SPEECH }];
  assert.deepEqual(alarmSettingsOf({ alarm: { escalation: speechStep } }).escalation, []);
  assert.equal(alarmSettingsOf({ alarm: { mode: ALARM_MODE.SPEECH, escalation: speechStep } }).escalation.length, 1);
  assert.equal(alarmSettingsOf({ speechEnabled: true, alarm: { escalation: speechStep } }).escalation.length, 1);
  assert.equal(alarmSettingsOf({ alarm: { weekdayTime: '6:45' } }).weekdayTime, null);
  assert.equal(alarmSettingsOf({ alarm: {} }).followPlan, true);
});

test('INVARIANTTI: jokainen herätys soi rajatusti, olivat asetukset mitä tahansa', () => {
  const variants = [
    { snoozeMinutes: 999, maxSnoozes: 999, escalation: Array.from({ length: 30 }, (_, index) => ({ afterSeconds: index * 45, step: 'loud' })) },
    { snoozeMinutes: -5, maxSnoozes: 'kaikki', escalation: 'sireeni', mode: ALARM_MODE.COMBINATION },
    { escalation: [{ afterSeconds: 700, step: 'loud' }, { afterSeconds: 599, step: 'soft' }] }
  ];
  for (const alarm of variants) {
    for (const item of desiredAlarms({ fromIso: MONDAY, days: 3, profile: PROFILE, settings: { ...SETTINGS, alarm: { enabled: true, ...alarm } } })) {
      assert.ok(item.snoozeMinutes >= 1 && item.snoozeMinutes <= MAX_SNOOZE_MINUTES);
      assert.ok(item.maxSnoozes >= 0 && item.maxSnoozes <= MAX_SNOOZES);
      assert.ok(item.escalation.length <= MAX_ESCALATION_STEPS);
      let previous = -1;
      for (const step of item.escalation) {
        assert.ok(step.afterSeconds > previous && step.afterSeconds < MAX_RING_SECONDS);
        previous = step.afterSeconds;
      }
      assert.equal(validateEscalation(item.escalation).valid, true);
    }
  }
});

// ================================================================ seinäkello -> hetki

test('seinäkello -> hetki: tavallinen talvi- ja kesäaika', () => {
  const winter = wallClockToEpoch('2026-01-15', '07:00', helsinkiOffset);
  assert.equal(winter.epochMs, Date.UTC(2026, 0, 15, 5, 0));
  assert.equal(winter.offsetMinutes, 120);
  assert.equal(winter.adjusted, false);
  assert.equal(winter.ambiguous, false);
  const summer = wallClockToEpoch('2026-07-15', '07:00', helsinkiOffset);
  assert.equal(summer.epochMs, Date.UTC(2026, 6, 15, 4, 0));
  assert.equal(wallClockToEpoch('2026-07-15', '07:00', () => 330).epochMs, Date.UTC(2026, 6, 15, 1, 30));
  assert.equal(wallClockToEpoch('2026-07-15', '07:00', () => -300).epochMs, Date.UTC(2026, 6, 15, 12, 0));
  assert.equal(wallClockToEpoch('2026-12-31', '23:59', helsinkiOffset).epochMs, Date.UTC(2026, 11, 31, 21, 59));
});

test('KESÄAIKA 29.3.2026: olematon aika siirtyy seuraavaan olemassa olevaan minuuttiin ja kertoo siitä', () => {
  for (const time of ['03:00', '03:01', '03:30', '03:59']) {
    const result = wallClockToEpoch('2026-03-29', time, helsinkiOffset);
    assert.equal(result.adjusted, true, time);
    assert.equal(result.nonexistent, true);
    assert.equal(result.time, '04:00');
    assert.equal(result.requestedTime, time);
    assert.equal(result.epochMs, SPRING_FORWARD_2026);
    assert.equal(result.offsetMinutes, 180);
  }
  const before = wallClockToEpoch('2026-03-29', '02:59', helsinkiOffset);
  assert.equal(before.adjusted, false);
  assert.equal(before.epochMs, SPRING_FORWARD_2026 - 60000);
  const after = wallClockToEpoch('2026-03-29', '04:00', helsinkiOffset);
  assert.equal(after.adjusted, false);
  assert.equal(after.epochMs, SPRING_FORWARD_2026);
});

test('KESÄAIKA 25.10.2026: kahdesti esiintyvä aika -> ensimmäinen esiintymä, ei koskaan tuntia myöhässä', () => {
  for (const time of ['03:00', '03:30', '03:59']) {
    const result = wallClockToEpoch('2026-10-25', time, helsinkiOffset);
    assert.equal(result.ambiguous, true, time);
    assert.equal(result.adjusted, false);
    assert.equal(result.offsetMinutes, 180, 'kesäajan (ensimmäinen) esiintymä');
    const [hours, minutes] = time.split(':').map(Number);
    assert.equal(result.epochMs, Date.UTC(2026, 9, 25, hours - 3, minutes));
  }
  assert.equal(wallClockToEpoch('2026-10-25', '02:59', helsinkiOffset).ambiguous, false);
  const four = wallClockToEpoch('2026-10-25', '04:00', helsinkiOffset);
  assert.equal(four.ambiguous, false);
  assert.equal(four.epochMs, FALL_BACK_2026 + 60 * 60000);
});

test('KESÄAIKA: jokainen vaihtopäivän minuutti kulkee edestakaisin oikein', () => {
  const pad = n => String(n).padStart(2, '0');
  for (const date of ['2026-03-29', '2026-10-25', '2026-03-28', '2026-10-26']) {
    let previous = -Infinity;
    for (let minute = 0; minute < 1440; minute += 1) {
      const time = `${pad(Math.floor(minute / 60))}:${pad(minute % 60)}`;
      const result = wallClockToEpoch(date, time, helsinkiOffset);
      const back = epochToWallClock(result.epochMs, helsinkiOffset);
      assert.equal(back.date, date);
      assert.equal(back.time, result.time, `${date} ${time}`);
      assert.ok(result.epochMs >= previous, 'kellonajan järjestys säilyy hetkinä');
      previous = result.epochMs;
    }
  }
});

test('seinäkello -> hetki vastaa ajoympäristön omaa Europe/Helsinki-vyöhykettä', t => {
  const intl = intlOffsetFn('Europe/Helsinki');
  if (!intl) {
    t.skip('ajoympäristön ICU ei tunne Europe/Helsinki-vyöhykettä');
    return;
  }
  for (let ms = Date.UTC(2026, 0, 1); ms < Date.UTC(2027, 0, 1); ms += 3600000) {
    assert.equal(helsinkiOffset(ms), intl(ms), new Date(ms).toISOString());
  }
  for (const [date, time] of [['2026-03-29', '03:30'], ['2026-10-25', '03:30'], ['2026-06-01', '07:00']]) {
    assert.deepEqual(wallClockToEpoch(date, time, intl), wallClockToEpoch(date, time, helsinkiOffset));
  }
});

test('seinäkello -> hetki: ilman aikavyöhykefunktiota tai virheellisellä syötteellä null, ei arvausta', () => {
  assert.equal(wallClockToEpoch(MONDAY, '07:00'), null);
  assert.equal(wallClockToEpoch(MONDAY, '07:00', 'Europe/Helsinki'), null);
  assert.equal(wallClockToEpoch(MONDAY, '07:00', () => { throw new Error('x'); }), null);
  assert.equal(wallClockToEpoch(MONDAY, '07:00', () => '120'), null);
  assert.equal(wallClockToEpoch(MONDAY, '07:00', () => 5000), null);
  assert.equal(wallClockToEpoch(MONDAY, '07:00', () => 90.5), null);
  assert.equal(wallClockToEpoch('2026-02-29', '07:00', helsinkiOffset), null);
  assert.equal(wallClockToEpoch(MONDAY, '24:00', helsinkiOffset), null);
  assert.equal(epochToWallClock(NaN, helsinkiOffset), null);
  assert.equal(epochToWallClock(0), null);
  for (const bad of GARBAGE) {
    assert.doesNotThrow(() => wallClockToEpoch(bad, bad, bad));
    assert.doesNotThrow(() => epochToWallClock(bad, bad));
  }
});

test('KESÄAIKA: herätys olemattomaan aikaan soi 4.00 ja kertoo siirrosta; toistuvaan aikaan ensimmäisellä kerralla', () => {
  const spring = desiredAlarms({ fromIso: '2026-03-29', profile: PROFILE, offsetMinutesFn: helsinkiOffset,
    settings: { ...SETTINGS, alarm: { enabled: true, weekendTime: '03:30' } } });
  assert.equal(spring[0].time, '04:00', 'herätys kantaa todellisen soittoajan');
  const wallOnly = desiredAlarms({ fromIso: '2026-03-29', profile: PROFILE,
    settings: { ...SETTINGS, alarm: { enabled: true, weekendTime: '03:30' } } });
  assert.equal(wallOnly[0].time, '03:30');
  const epoch = alarmEpoch(wallOnly[0], helsinkiOffset);
  assert.equal(epoch.adjusted, true);
  assert.equal(epoch.time, '04:00');
  assert.equal(epoch.epochMs, SPRING_FORWARD_2026);

  const fall = desiredAlarms({ fromIso: '2026-10-25', profile: PROFILE, offsetMinutesFn: helsinkiOffset,
    settings: { ...SETTINGS, alarm: { enabled: true, weekendTime: '03:30' } } });
  const fallEpoch = alarmEpoch(fall[0], helsinkiOffset);
  assert.equal(fallEpoch.ambiguous, true);
  assert.equal(fallEpoch.epochMs, Date.UTC(2026, 9, 25, 0, 30));
  assert.equal(alarmEpoch(null, helsinkiOffset), null);
});

// ================================================================ torkku

const RINGING = Object.freeze({ id: `wake:${MONDAY}`, date: MONDAY, time: '07:00', snoozeMinutes: 9, maxSnoozes: 3, snoozeCount: 0,
  escalation: DEFAULT_ESCALATION });

test('torkku: yhdeksän minuuttia, enintään kolme kertaa, tunniste pysyy', () => {
  let alarm = RINGING;
  const times = [];
  for (let round = 0; round < MAX_SNOOZES; round += 1) {
    const result = snoozeAlarm(alarm, { date: alarm.date, time: alarm.time });
    assert.equal(result.ok, true);
    assert.equal(result.alarm.id, RINGING.id);
    times.push(result.alarm.time);
    alarm = result.alarm;
  }
  assert.deepEqual(times, ['07:09', '07:18', '07:27']);
  assert.equal(alarm.snoozeCount, 3);
  assert.equal(alarm.snoozesLeft, 0);
  assert.equal(alarm.snoozeEpochMs, null, 'ilman aikavyöhykettä ei hetkeä');
  const exhausted = snoozeAlarm(alarm, { date: MONDAY, time: '07:27' });
  assert.equal(exhausted.ok, false);
  assert.equal(exhausted.code, 'max_snoozes');
  assert.equal(exhausted.alarm, null);
  assert.equal(snoozeAlarm({ ...RINGING, maxSnoozes: 0 }, { date: MONDAY, time: '07:00' }).code, 'max_snoozes');
  assert.equal(snoozeAlarm(RINGING, { date: MONDAY, time: '07:00' }).message, 'Herätys soi uudelleen 7.09.');
});

test('torkku keskiyön ja vuoden yli', () => {
  assert.deepEqual(pick(snoozeAlarm(RINGING, { date: MONDAY, time: '23:55' }).alarm), ['2026-09-29', '00:04']);
  assert.deepEqual(pick(snoozeAlarm(RINGING, { date: '2026-12-31', time: '23:58' }).alarm), ['2027-01-01', '00:07']);
  assert.deepEqual(pick(snoozeAlarm({ ...RINGING, snoozeMinutes: 999 }, { date: MONDAY, time: '07:00' }).alarm), [MONDAY, '07:30'],
    `torkku enintään ${MAX_SNOOZE_MINUTES} min`);
});

function pick(alarm) {
  return [alarm.date, alarm.time];
}

test('KESÄAIKA: torkku on todellinen kesto myös siirtymän yli', () => {
  const spring = snoozeAlarm(RINGING, { date: '2026-03-29', time: '02:55' }, { offsetMinutesFn: helsinkiOffset });
  assert.deepEqual(pick(spring.alarm), ['2026-03-29', '04:04']);
  assert.equal(spring.alarm.snoozeEpochMs, Date.UTC(2026, 2, 29, 1, 4));
  assert.deepEqual(pick(snoozeAlarm(RINGING, { date: '2026-03-29', time: '02:55' }).alarm), ['2026-03-29', '03:04'],
    'ilman aikavyöhykettä seinäkello');

  // Syksy: 3.55 kesäaikaa + 9 min = 3.04 talviaikaa. Hetki kulkee mukana.
  const fall = snoozeAlarm(RINGING, { date: '2026-10-25', time: '03:55' }, { offsetMinutesFn: helsinkiOffset });
  assert.deepEqual(pick(fall.alarm), ['2026-10-25', '03:04']);
  assert.equal(fall.alarm.snoozeEpochMs, Date.UTC(2026, 9, 25, 1, 4));
  // Tarkka nykyhetki ratkaisee toisen esiintymän: 3.55 talviaikaa + 9 min = 4.04.
  const second = snoozeAlarm(RINGING, { date: '2026-10-25', time: '03:55' },
    { offsetMinutesFn: helsinkiOffset, nowEpochMs: Date.UTC(2026, 9, 25, 1, 55) });
  assert.deepEqual(pick(second.alarm), ['2026-10-25', '04:04']);
});

test('torkku: roskasyöte ei kaada eikä muuta syötettä', () => {
  for (const bad of GARBAGE) {
    assert.doesNotThrow(() => snoozeAlarm(bad, bad, bad));
    assert.equal(snoozeAlarm(bad, { date: MONDAY, time: '07:00' }).ok, false);
    assert.equal(snoozeAlarm(RINGING, bad).ok, false);
  }
  const mutable = { id: 'wake:x', date: MONDAY, time: '07:00', escalation: [{ afterSeconds: 0, step: 'soft' }] };
  const before = JSON.stringify(mutable);
  const result = snoozeAlarm(mutable, { date: MONDAY, time: '07:00' });
  assert.equal(JSON.stringify(mutable), before);
  assert.equal(Object.isFrozen(mutable), false);
  assert.equal(Object.isFrozen(mutable.escalation), false, 'kutsujan listaa ei jäädytetä');
  assert.ok(Object.isFrozen(result.alarm) && Object.isFrozen(result.alarm.escalation));
});

// ================================================================ kaksoiskappaleet

test('kaksoiskappaleet: torkutettu versio voittaa, sitten myöhempi; järjestys päivän ja ajan mukaan', () => {
  const snoozed = snoozeAlarm(RINGING, { date: MONDAY, time: '07:00' }).alarm;
  const tuesday = { ...RINGING, id: 'wake:2026-09-29', date: '2026-09-29', time: '06:00' };
  const list = [tuesday, RINGING, snoozed, { id: '', date: MONDAY, time: '07:00' }, null, { id: 'wake:x', date: 'eilen', time: '07:00' }];
  const result = dedupeAlarms(list);
  assert.deepEqual(result.map(alarm => [alarm.id, alarm.time]), [[RINGING.id, '07:09'], ['wake:2026-09-29', '06:00']]);
  assert.ok(Object.isFrozen(result));

  const sameCount = dedupeAlarms([{ ...RINGING, time: '06:50' }, RINGING]);
  assert.equal(sameCount[0].time, '07:00');

  const twins = [{ ...RINGING, label: 'A' }, { ...RINGING, label: 'B' }, { ...RINGING, label: 'C' }];
  const reference = JSON.stringify(dedupeAlarms(twins));
  for (const order of [[2, 1, 0], [1, 2, 0], [0, 2, 1]]) {
    assert.equal(JSON.stringify(dedupeAlarms(order.map(index => twins[index]))), reference, 'sama tulos järjestyksestä riippumatta');
  }
  for (const bad of GARBAGE) assert.doesNotThrow(() => dedupeAlarms(bad));
  const cyclic = { ...RINGING };
  cyclic.self = cyclic;
  assert.doesNotThrow(() => dedupeAlarms([cyclic, { ...RINGING }]));
});

// ================================================================ aamun katsaus

test('aamun katsaus: täsmälleen suunniteltu sanamuoto', () => {
  const brief = morningBrief({
    now: { date: MONDAY, time: '05:30' }, wakeTime: '05:30', leaveTime: '06:05',
    commitments: [{ title: 'Työvuoro', startTime: '07:00', category: 'tyo' }], freeMinutesForRun: 20, settings: {}
  });
  assert.deepEqual(brief.lines, [
    'Hyvää huomenta. Kello on 5.30.',
    'Työmatkan lähtötavoite on 6.05.',
    'Sinulla on aikaa 20 minuutin aamulenkille.'
  ]);
  assert.equal(brief.text, 'Hyvää huomenta. Kello on 5.30. Työmatkan lähtötavoite on 6.05. Sinulla on aikaa 20 minuutin aamulenkille.');
  assert.equal(brief.sentenceCount, 4);
  assert.equal(brief.titlesIncluded, false);
  assertDeepFrozen(brief);
});

test('KRIITTINEN: menon nimi vain käyttöön otetussa katsauksessa, muistiinpano ei koskaan', () => {
  const commitments = [{ title: 'Hammaslääkäri', startTime: '08:30', notes: 'juurihoito', note: 'juurihoito' }];
  const closed = morningBrief({ now: { date: MONDAY, time: '07:00' }, commitments, settings: {} });
  assert.doesNotMatch(closed.text, /Hammaslääkäri|juurihoito/);
  assert.match(closed.text, /Tänään on yksi meno\./);
  const open = morningBrief({ now: { date: MONDAY, time: '07:00' }, commitments, settings: { morningBriefEnabled: true } });
  assert.match(open.text, /Ensimmäinen meno on Hammaslääkäri kello 8\.30\./);
  assert.doesNotMatch(open.text, /juurihoito/);
  assert.equal(open.titlesIncluded, true);
});

test('aamun katsaus: tervehdys, menojen määrä, ei menoja, lenkin raja ja päivä', () => {
  const at = (time, extra = {}) => morningBrief({ now: { date: MONDAY, time }, settings: {}, ...extra });
  assert.match(at('09:59').text, /^Hyvää huomenta\./);
  assert.match(at('10:00').text, /^Hyvää päivää\./);
  assert.match(at('17:00').text, /^Hyvää iltaa\./);
  assert.match(at('07:00').text, /Aamussa ei ole kiinteitä menoja\./);
  assert.match(at('07:00', { commitments: [{ startTime: '09:00' }, { startTime: '12:00' }] }).text, /Tänään on 2 menoa\./);
  assert.match(at('07:00', { commitments: [{ startTime: '09:00', date: '2026-09-29' }] }).text, /ei ole kiinteitä menoja/,
    'toisen päivän meno ei kuulu tähän aamuun');
  assert.doesNotMatch(at('07:00', { freeMinutesForRun: MIN_RUN_MINUTES - 1 }).text, /aamulenkille/);
  assert.match(at('07:00', { freeMinutesForRun: MIN_RUN_MINUTES }).text, /aikaa 10 minuutin aamulenkille/);
  for (const freeMinutesForRun of [null, NaN, '20', -30]) {
    assert.doesNotMatch(at('07:00', { freeMinutesForRun }).text, /aamulenkille/, String(freeMinutesForRun));
  }
  assert.match(at('05:00', { wakeTime: '05:30' }).text, /Herätys on 5\.30\./);
  assert.doesNotMatch(at('06:00', { wakeTime: '05:30' }).text, /Herätys on/);
  assert.match(at('07:00', { leaveTime: '07:40', commitments: [{ startTime: '08:30', category: 'muu' }] }).text, /^Hyvää huomenta\. Kello on 7\.00\. Lähtötavoite on 7\.40\./);
});

test('aamun katsaus: paikattoman menon alku ei ole lähtötavoite', () => {
  // calendarPlan.commitmentsOn: meno ilman paikkaa ja matkaa -> lähtö = alku.
  const placeless = [{ title: 'Hammaslääkäri keskustassa', startTime: '16:00', leaveTime: '16:00', prepareStart: null }];
  const closed = morningBrief({ now: { date: MONDAY, time: '07:00' }, leaveTime: '16:00', commitments: placeless, settings: {} });
  assert.doesNotMatch(closed.text, /[Ll]ähtötavoite|lähtö/);
  assert.match(closed.text, /Ensimmäinen meno alkaa kello 16\.00\./);
  assert.doesNotMatch(closed.text, /Hammaslääkäri/, 'nimi vain käyttöön otetussa katsauksessa');
  const open = morningBrief({ now: { date: MONDAY, time: '07:00' }, leaveTime: '16:00', commitments: placeless,
    settings: { morningBriefEnabled: true } });
  assert.doesNotMatch(open.text, /[Ll]ähtötavoite/);
  assert.match(open.text, /Ensimmäinen meno on Hammaslääkäri keskustassa kello 16\.00\./);
  // Oikea lähtö (matka tiedossa) on edelleen lähtötavoite.
  const travel = morningBrief({ now: { date: MONDAY, time: '07:00' }, leaveTime: '15:20',
    commitments: [{ title: 'Asiakas', startTime: '16:00', leaveTime: '15:20', category: 'tyo' }], settings: {} });
  assert.match(travel.text, /Työmatkan lähtötavoite on 15\.20\./);
});

test('aamun katsaus: nimi siistitään ja lyhennetään', () => {
  const brief = morningBrief({ now: { date: MONDAY, time: '07:00' }, settings: { morningBriefEnabled: true },
    commitments: [{ title: '  Kokous\n\n\tasiakkaan kanssa!!! ', startTime: '09:00' }] });
  assert.match(brief.text, /Ensimmäinen meno on Kokous asiakkaan kanssa kello 9\.00\./);
  const long = morningBrief({ now: { date: MONDAY, time: '07:00' }, settings: { morningBriefEnabled: true },
    commitments: [{ title: 'x'.repeat(500), startTime: '09:00' }] });
  const title = long.lines.find(line => line.startsWith('Ensimmäinen')).match(/on (x+…) kello/)[1];
  assert.equal(title.length, MAX_BRIEF_TITLE_LENGTH);
});

test(`INVARIANTTI: katsauksessa on aina enintään ${BRIEF_MAX_SENTENCES} virkettä`, () => {
  const options = {
    time: ['04:00', '05:30', '12:00', '21:00'],
    leaveTime: [null, '06:05'],
    commitments: [[], [{ title: 'Työ', startTime: '07:00', category: 'tyo' }], [{ title: 'A', startTime: '09:00' }, { title: 'B', startTime: '10:00' }]],
    run: [null, 20],
    enabled: [false, true],
    wakeTime: [null, '23:00']
  };
  for (const time of options.time) for (const leaveTime of options.leaveTime) for (const commitments of options.commitments) {
    for (const run of options.run) for (const enabled of options.enabled) for (const wakeTime of options.wakeTime) {
      const brief = morningBrief({ now: { date: MONDAY, time }, wakeTime, leaveTime, commitments, freeMinutesForRun: run,
        settings: { morningBriefEnabled: enabled } });
      assert.ok(brief.sentenceCount <= BRIEF_MAX_SENTENCES);
      assert.ok(sentences(brief.text) <= BRIEF_MAX_SENTENCES, brief.text);
      if (!enabled) assert.doesNotMatch(brief.text, /Työ kello|A kello/);
    }
  }
});

test('aamun katsaus: virheellinen hetki -> null, roskasyöte ei kaada', () => {
  for (const bad of GARBAGE) {
    assert.doesNotThrow(() => morningBrief(bad));
    assert.equal(morningBrief(bad), null);
    assert.doesNotThrow(() => morningBrief({ now: { date: MONDAY, time: '07:00' }, commitments: bad, leaveTime: bad,
      wakeTime: bad, freeMinutesForRun: bad, settings: bad }));
  }
  assert.equal(morningBrief({ now: { date: MONDAY, time: '7:00' } }), null);
});

// ================================================================ kestävyys ja determinismi

test('herätykset: roskasyöte ei koskaan kaada', () => {
  for (const bad of GARBAGE) {
    assert.doesNotThrow(() => desiredAlarms(bad));
    assert.deepEqual(desiredAlarms(bad), []);
    assert.doesNotThrow(() => desiredAlarms({ fromIso: MONDAY, days: bad, profile: bad, settings: { ...SETTINGS, morningBriefEnabled: true },
      commitmentsByDate: bad, sleepLogs: bad, offsetMinutesFn: bad }));
    assert.doesNotThrow(() => desiredAlarms({ fromIso: MONDAY, profile: PROFILE, settings: { alarm: { enabled: true, ...(typeof bad === 'object' ? bad : {}) }, morningRoutine: bad },
      commitmentsByDate: { [MONDAY]: [bad, { startTime: bad, leaveTime: bad, prepareStart: bad }] }, sleepLogs: [bad, { wakeDate: MONDAY, actualBedtime: bad }] }));
  }
  assert.deepEqual(desiredAlarms({ fromIso: MONDAY, profile: PROFILE, settings: SETTINGS, offsetMinutesFn: () => { throw new Error('x'); } }), []);
});

test('herätykset: deterministiset, syvästi jäädytetyt eivätkä muuta syötettä', () => {
  const input = {
    fromIso: MONDAY, days: 3, profile: { ...PROFILE },
    settings: { ...SETTINGS, morningBriefEnabled: true, alarm: { enabled: true, escalation: [{ afterSeconds: 0, step: 'soft' }] } },
    commitmentsByDate: { [MONDAY]: [{ ...MEETING }], '2026-09-29': { ...MEETING, startTime: '09:00', leaveTime: '08:30' } },
    sleepLogs: [{ id: 'a', wakeDate: MONDAY, actualBedtime: '22:45' }]
  };
  const before = JSON.stringify(input);
  const first = JSON.stringify(desiredAlarms(input));
  for (let index = 0; index < 20; index += 1) assert.equal(JSON.stringify(desiredAlarms(input)), first);
  assert.equal(JSON.stringify(input), before);
  assert.equal(Object.isFrozen(input.settings.alarm.escalation), false);
  assertDeepFrozen(desiredAlarms(input));
});

test('suorituskyky: suuret menolistat ja unikirjaukset käsitellään lineaarisesti', () => {
  const build = count => ({
    commitments: Array.from({ length: count }, (_, index) => ({ id: 'e' + index, title: 'Meno ' + index,
      startTime: `${String(8 + (index % 10)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}` })),
    logs: Array.from({ length: count }, (_, index) => ({ id: 'l' + index, wakeDate: index % 2 ? MONDAY : '2026-01-01',
      actualBedtime: '23:00', updatedAt: String(index).padStart(8, '0') }))
  });
  const time = ({ commitments, logs }) => {
    const start = process.hrtime.bigint();
    desiredAlarms({ fromIso: MONDAY, days: 3, profile: PROFILE, settings: { ...SETTINGS, morningBriefEnabled: true },
      commitmentsByDate: { [MONDAY]: commitments }, sleepLogs: logs });
    return Number(process.hrtime.bigint() - start) / 1e6;
  };
  const small = build(10000);
  const large = build(40000);
  time(small);
  const smallMs = Math.max(time(small), 1);
  const largeMs = time(large);
  assert.ok(largeMs < smallMs * 12 + 50, `4x aineisto: ${smallMs.toFixed(1)} ms -> ${largeMs.toFixed(1)} ms`);
  assert.ok(largeMs < 2000, `${largeMs} ms`);
});

test('KRIITTINEN: tulos ei riipu ajoympäristön aikavyöhykkeestä', () => {
  // Aikavyöhyke luetaan prosessin käynnistyessä, joten jokainen vyöhyke
  // ajetaan omassa lapsiprosessissaan (sama menetelmä kuin dst.test.mjs).
  const code = `
    import { desiredAlarms, morningBrief } from './src/domain/alarmPlan.js';
    import { sleepScheduleFor, driftReport, mondayReadiness } from './src/domain/sleepRhythm.js';
    import { planMorning } from './src/domain/morningPlanner.js';
    const profile = { sleepTargetHours: 8, defaultWakeTime: '07:00', commuteMinutes: 30, routineMinutes: 60 };
    const settings = { alarm: { enabled: true }, morningBriefEnabled: true };
    const out = [];
    for (const date of ['2026-03-28', '2026-03-29', '2026-10-25', '2026-12-31']) {
      out.push(sleepScheduleFor({ dateIso: date, profile, settings }));
      out.push(planMorning({ dateIso: date, profile, settings, firstCommitment: { title: 'M', startTime: '07:30' } }));
      out.push(desiredAlarms({ fromIso: date, days: 3, profile, settings }));
      out.push(driftReport({ logs: [{ id: 'a', wakeDate: date, actualBedtime: '23:00', actualWake: '07:00' }], profile, settings, todayIso: date }));
      out.push(mondayReadiness({ todayIso: date, mondayWake: '07:00', recentWeekendWake: '10:00', settings, profile }));
    }
    out.push(morningBrief({ now: { date: '2026-10-25', time: '03:30' }, leaveTime: '04:00', settings }));
    console.log(JSON.stringify(out));
  `;
  const run = tz => execFileSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: ROOT, env: { ...process.env, TZ: tz }, encoding: 'utf8'
  }).trim();
  const reference = run('Europe/Helsinki');
  for (const tz of ['UTC', 'America/New_York', 'Asia/Tokyo', 'Pacific/Kiritimati']) {
    assert.equal(run(tz), reference, tz);
  }
});

test('PUHTAUS: herätyssuunnitelma ei lue kelloa, ei aseta mitään eikä koske DOM:iin', () => {
  const file = 'src/domain/alarmPlan.js';
  const code = readCode(file);
  for (const token of ['Date.now(', 'Math.random', 'crypto.randomUUID', 'performance.now', 'document.', 'window.',
    'localStorage', 'fetch(', 'console.', 'Capacitor', 'setAlarmClock']) {
    assert.equal(code.includes(token), false, `${file}: ${token}`);
  }
  assert.equal(/new Date\(/.test(code), false);
  for (const target of importsOf(file)) assert.ok(target.startsWith('src/domain/'), target);
  assert.ok(importsOf(file).includes('src/domain/dailyLife.js'));
});
