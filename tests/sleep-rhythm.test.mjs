// Unirytmi: herätys, nukkumaanmeno, iltarutiini, viikonlopun väljyys,
// rytmin siirtymä, paluu arkeen ja illan huomautus.
//
// PERIAATE: uni on suojattu, ja sovellus tietää vain vuoteessaolon ajan
// (mahdollisuus nukkua), ei mitattua unta. Jokainen testi joko todistaa
// laskennan käyttäjän omista luvuista tai todistaa, ettei tuntemattomasta
// synny lukua (tuntematon on null, ei nolla).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  sleepScheduleFor, sleepOpportunity, driftReport, mondayReadiness, eveningBefore,
  sleepTargetMinutes, rhythmSettingsOf, defaultWakeOf,
  MAX_RETURN_STEP_MINUTES, DRIFT_WINDOW_DAYS, DRIFT_MIN_WEEKENDS, DRIFT_MIN_REFERENCE_DAYS,
  EVENING_NOTICE_MIN_MINUTES, MAX_TIME_IN_BED_MINUTES, WAKE_SOURCE, BEDTIME_SOURCE, REFERENCE_BASIS
} from '../src/domain/sleepRhythm.js';
import {
  dayNumberOf, isoOfDayNumber, shiftDateIso, isoWeekday, isWeekendIso, elapsedMinutes,
  clockText, durationText
} from '../src/domain/wallClock.js';
import { addDaysIso, weekdayOfIso } from '../src/domain/fiTemporal.js';
import {
  PROTECTION, SLEEP_KIND, DEFAULT_WIND_DOWN_MINUTES, DEFAULT_WEEKEND_SHIFT_MINUTES,
  MAX_WEEKEND_SHIFT_MINUTES, MAX_WIND_DOWN_MINUTES
} from '../src/domain/dailyLife.js';
import { helsinkiOffset } from './helpers/helsinkiOffset.mjs';
import { readCode, importsOf } from './helpers/sources.mjs';

const PROFILE = Object.freeze({ sleepTargetHours: 8, defaultWakeTime: '07:00', commuteMinutes: 30, routineMinutes: 60 });
const SETTINGS = Object.freeze({ weekendWakeShiftMaxMinutes: 60, weekendBedShiftMaxMinutes: 60, windDownMinutes: 30, bedtimeTarget: null });

// 2026-09-28 on maanantai, 2026-09-26 lauantai, 2026-09-27 sunnuntai.
const MONDAY = '2026-09-28';
const SATURDAY = '2026-09-26';
const SUNDAY = '2026-09-27';

/** Kielletyt sävyt ja väitteet: ei häpeää, ei terveysväitteitä, ei mitattua unta. */
const TONE = /epäonnist|laiska|huono|pitäisi hävetä|suoritus|diagno|sairau|terveydelle|lääkär|nukuit|unesi oli/i;

const GARBAGE = [undefined, null, 0, 1, -1, NaN, Infinity, '', 'x', '2026-02-30', true, [], [1, 2], {},
  { dateIso: 42 }, { dateIso: '2026-13-01' }, () => 1, Symbol('s')];

function deepFreezeInput(value) {
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) deepFreezeInput(value[key]);
    Object.freeze(value);
  }
  return value;
}

function assertDeepFrozen(value, path = 'tulos') {
  if (value && typeof value === 'object') {
    assert.ok(Object.isFrozen(value), `${path} ei ole jäädytetty`);
    for (const key of Object.keys(value)) assertDeepFrozen(value[key], `${path}.${key}`);
  }
}

// ================================================================ kalenteri

test('kalenteri: päivälaskenta vastaa fiTemporalin laskentaa koko vuosikymmenen ajan', () => {
  let iso = '2024-01-01';
  for (let index = 0; index < 366 * 7; index += 1) {
    assert.equal(shiftDateIso(iso, 1), addDaysIso(iso, 1), iso);
    assert.equal(isoWeekday(iso), weekdayOfIso(iso), iso);
    assert.equal(isoOfDayNumber(dayNumberOf(iso)), iso);
    iso = addDaysIso(iso, 1);
  }
});

test('kalenteri: kuukauden, vuoden ja karkauspäivän vaihde', () => {
  assert.equal(shiftDateIso('2026-12-31', 1), '2027-01-01');
  assert.equal(shiftDateIso('2027-01-01', -1), '2026-12-31');
  assert.equal(shiftDateIso('2028-02-28', 1), '2028-02-29');
  assert.equal(shiftDateIso('2027-02-28', 1), '2027-03-01');
  assert.equal(shiftDateIso('2026-03-31', 1), '2026-04-01');
  assert.equal(dayNumberOf('1970-01-01'), 0);
  assert.equal(isoWeekday('1970-01-01'), 4, '1.1.1970 oli torstai');
  assert.equal(isoWeekday(MONDAY), 1);
  assert.equal(isWeekendIso(SATURDAY), true);
  assert.equal(isWeekendIso(SUNDAY), true);
  assert.equal(isWeekendIso(MONDAY), false);
  for (const bad of GARBAGE) {
    assert.equal(dayNumberOf(bad), null);
    assert.equal(shiftDateIso(bad, 1), null);
    assert.equal(isoWeekday(bad), null);
  }
  assert.equal(shiftDateIso('2026-01-01', 1.5), null);
  assert.equal(isoOfDayNumber(1.5), null);
  assert.equal(isoOfDayNumber(10 ** 9), null, 'vuosi yli 9999 ei ole ISO-päivä');
});

test('teksti: suomalainen kellonaika ja kesto', () => {
  assert.equal(clockText('05:30'), '5.30');
  assert.equal(clockText('00:00'), '0.00');
  assert.equal(clockText('23:05'), '23.05');
  assert.equal(clockText('24:00'), '');
  assert.equal(durationText(120), '2 h');
  assert.equal(durationText(90), '1 h 30 min');
  assert.equal(durationText(20), '20 min');
  assert.equal(durationText(0), '0 min');
  assert.equal(durationText(null), '', 'tuntematon kesto ei ole nolla');
  assert.equal(durationText(NaN), '');
});

// ================================================================ päivän unirytmi

test('arkiaamu: herätys profiilista, nukkumaan edellisenä iltana herätys - unitavoite', () => {
  const s = sleepScheduleFor({ dateIso: MONDAY, profile: PROFILE, settings: SETTINGS });
  assert.equal(s.weekend, false);
  assert.equal(s.wakeTime, '07:00');
  assert.equal(s.bedtime, '23:00');
  assert.equal(s.bedtimeDate, SUNDAY, 'nukkumaanmeno on edellisenä iltana');
  assert.equal(s.windDownStart, '22:30');
  assert.equal(s.windDownDate, SUNDAY);
  assert.equal(s.sleepMinutes, 480);
  assert.equal(s.timeInBedMinutes, 480);
  assert.equal(s.source, WAKE_SOURCE.DEFAULT);
  assert.equal(s.bedtimeSource, BEDTIME_SOURCE.SLEEP_TARGET);
  assert.equal(s.protected, true);
  assert.equal(s.protection, PROTECTION.PROTECTED);
  assert.equal(s.reason,
    'Arkiaamun herätys on 7.00, kuten olet profiilissa asettanut. 8 h unitavoitteella nukkumaan 23.00, iltarutiini alkaa 22.30.');
  assertDeepFrozen(s);
});

test('kiinteä meno aikaistaa herätystä ja nukkumaanmenoa saman verran; myöhäisempi meno ei myöhennä', () => {
  const early = sleepScheduleFor({ dateIso: MONDAY, profile: PROFILE, settings: SETTINGS, requiredWake: '06:15' });
  assert.equal(early.wakeTime, '06:15');
  assert.equal(early.bedtime, '22:15');
  assert.equal(early.windDownStart, '21:45');
  assert.equal(early.source, WAKE_SOURCE.COMMITMENT);
  assert.equal(early.earlierThanUsualMinutes, 45);
  assert.match(early.reason, /^Aamun meno vaatii herätyksen 6\.15, 45 min tavallista aiemmin\./);
  assert.equal(early.timeInBedMinutes, 480, 'unitavoite säilyy: uni ei jousta menon tieltä');

  for (const requiredWake of ['07:00', '07:01', '09:00', null, '7:00', 'aamulla', 700]) {
    const s = sleepScheduleFor({ dateIso: MONDAY, profile: PROFILE, settings: SETTINGS, requiredWake });
    assert.equal(s.wakeTime, '07:00', String(requiredWake));
    assert.equal(s.source, WAKE_SOURCE.DEFAULT);
  }
});

test('viikonloppu: herätys saa siirtyä enintään asetetun väljyyden verran', () => {
  assert.equal(sleepScheduleFor({ dateIso: SATURDAY, profile: PROFILE, settings: SETTINGS }).wakeTime, '08:00');
  assert.equal(sleepScheduleFor({ dateIso: SUNDAY, profile: PROFILE, settings: SETTINGS }).wakeTime, '08:00');
  const none = sleepScheduleFor({ dateIso: SATURDAY, profile: PROFILE, settings: { ...SETTINGS, weekendWakeShiftMaxMinutes: 0 } });
  assert.equal(none.wakeTime, '07:00');
  assert.match(none.reason, /Viikonloppunakin herätys on 7\.00/);
  const clamped = sleepScheduleFor({ dateIso: SATURDAY, profile: PROFILE, settings: { ...SETTINGS, weekendWakeShiftMaxMinutes: 500 } });
  assert.equal(clamped.wakeTime, '11:00', `väljyys rajataan ${MAX_WEEKEND_SHIFT_MINUTES} minuuttiin`);
  const defaulted = sleepScheduleFor({ dateIso: SATURDAY, profile: PROFILE, settings: {} });
  assert.equal(defaulted.wakeTime, '08:00', `oletusväljyys ${DEFAULT_WEEKEND_SHIFT_MINUTES} min`);

  const s = sleepScheduleFor({ dateIso: SATURDAY, profile: PROFILE, settings: SETTINGS });
  assert.equal(s.weekend, true);
  assert.equal(s.source, WAKE_SOURCE.WEEKEND);
  assert.equal(s.bedtime, '00:00');
  assert.equal(s.bedtimeDate, SATURDAY, 'keskiyö kuuluu jo herätyspäivään');
  assert.equal(s.windDownStart, '23:30');
  assert.equal(s.windDownDate, '2026-09-25');
  assert.match(s.reason, /enintään 1 h myöhemmäksi: herätys 8\.00/);

  // Viikonlopun meno voi silti vaatia aiemman herätyksen.
  const withEvent = sleepScheduleFor({ dateIso: SATURDAY, profile: PROFILE, settings: SETTINGS, requiredWake: '07:30' });
  assert.equal(withEvent.wakeTime, '07:30');
  assert.equal(withEvent.source, WAKE_SOURCE.COMMITMENT);
  assert.equal(withEvent.earlierThanUsualMinutes, 30);

  // Myöhäinen oletusherätys ei valu seuraavaan vuorokauteen.
  const late = sleepScheduleFor({ dateIso: SATURDAY, profile: { ...PROFILE, defaultWakeTime: '22:00' }, settings: { weekendWakeShiftMaxMinutes: 240 } });
  assert.equal(late.wakeTime, '23:59');
});

test('oma nukkumaanmenotavoite pysyy, kun se on aiempi; myöhempi ei lyhennä unta', () => {
  const earlier = sleepScheduleFor({ dateIso: MONDAY, profile: PROFILE, settings: { ...SETTINGS, bedtimeTarget: '22:00' } });
  assert.equal(earlier.bedtime, '22:00');
  assert.equal(earlier.bedtimeSource, BEDTIME_SOURCE.BEDTIME_TARGET);
  assert.equal(earlier.windDownStart, '21:30');
  assert.equal(earlier.timeInBedMinutes, 540);
  assert.match(earlier.reason, /Nukkumaan 22\.00 oman nukkumaanmenotavoitteesi mukaan/);

  for (const bedtimeTarget of ['23:30', '00:30', '23:00', '12:30x', null]) {
    const s = sleepScheduleFor({ dateIso: MONDAY, profile: PROFILE, settings: { ...SETTINGS, bedtimeTarget } });
    assert.equal(s.bedtime, '23:00', String(bedtimeTarget));
    assert.equal(s.bedtimeSource, BEDTIME_SOURCE.SLEEP_TARGET);
  }

  // Viikonloppuyönä tavoitteeseen saa lisätä viikonlopun väljyyden.
  const weekend = sleepScheduleFor({ dateIso: SATURDAY, profile: PROFILE, settings: { ...SETTINGS, bedtimeTarget: '22:30' } });
  assert.equal(weekend.bedtime, '23:30');
  assert.equal(weekend.bedtimeDate, '2026-09-25');
  assert.equal(weekend.bedtimeSource, BEDTIME_SOURCE.BEDTIME_TARGET);
});

test('iltarutiini: 0 min = ei iltarutiinia; yläraja rajataan', () => {
  const none = sleepScheduleFor({ dateIso: MONDAY, profile: PROFILE, settings: { ...SETTINGS, windDownMinutes: 0 } });
  assert.equal(none.windDownStart, none.bedtime);
  assert.doesNotMatch(none.reason, /iltarutiini/);
  const big = sleepScheduleFor({ dateIso: MONDAY, profile: PROFILE, settings: { ...SETTINGS, windDownMinutes: 999 } });
  assert.equal(big.windDownMinutes, MAX_WIND_DOWN_MINUTES);
  assert.equal(big.windDownStart, '20:00');
  assert.equal(rhythmSettingsOf({}).windDownMinutes, DEFAULT_WIND_DOWN_MINUTES);
  assert.equal(rhythmSettingsOf({ windDownMinutes: -5 }).windDownMinutes, 0);
  assert.equal(rhythmSettingsOf({ windDownMinutes: '45' }).windDownMinutes, DEFAULT_WIND_DOWN_MINUTES, 'merkkijono ei ole luku');
});

test('unitavoite: puolikkaat tunnit, järjetön arvo -> profiilin oletus 8 h', () => {
  assert.equal(sleepTargetMinutes({ sleepTargetHours: 7.5 }), 450);
  const s = sleepScheduleFor({ dateIso: MONDAY, profile: { ...PROFILE, sleepTargetHours: 7.5 }, settings: SETTINGS });
  assert.equal(s.bedtime, '23:30');
  assert.match(s.reason, /7 h 30 min unitavoitteella/);
  for (const sleepTargetHours of [0, -1, 20, '8', NaN, null, undefined, Infinity]) {
    assert.equal(sleepTargetMinutes({ sleepTargetHours }), 480, String(sleepTargetHours));
  }
  assert.equal(defaultWakeOf({ defaultWakeTime: '6:30' }), '07:00');
  assert.equal(defaultWakeOf({ defaultWakeTime: '06:30' }), '06:30');
});

test('keskiyön, kuukauden ja vuoden vaihde: nukkumaanmenon päivä rullaa oikein', () => {
  assert.equal(sleepScheduleFor({ dateIso: '2027-01-01', profile: PROFILE, settings: SETTINGS }).bedtimeDate, '2026-12-31');
  assert.equal(sleepScheduleFor({ dateIso: '2026-03-02', profile: PROFILE, settings: SETTINGS }).bedtimeDate, '2026-03-01');
  assert.equal(sleepScheduleFor({ dateIso: '2028-03-01', profile: PROFILE, settings: SETTINGS }).bedtimeDate, '2028-02-29');
  const early = sleepScheduleFor({ dateIso: '2027-01-01', profile: { ...PROFILE, defaultWakeTime: '04:00' }, settings: SETTINGS });
  assert.equal(early.bedtime, '20:00');
  assert.equal(early.windDownStart, '19:30');
  assert.equal(early.windDownDate, '2026-12-31');
});

test('KESÄAIKA: kevään vaihtoyönä 8 h unta alkaa kello 23 eikä keskiyöllä', () => {
  // Su 29.3.2026 kello siirtyy 03 -> 04. Sunnuntaiaamun herätys 8.00
  // (viikonloppu), unitavoite 8 h: todellinen 8 h alkaa la 23.00.
  const withZone = sleepScheduleFor({ dateIso: '2026-03-29', profile: PROFILE, settings: SETTINGS, offsetMinutesFn: helsinkiOffset });
  assert.equal(withZone.wakeTime, '08:00');
  assert.equal(withZone.bedtime, '23:00');
  assert.equal(withZone.bedtimeDate, '2026-03-28');
  assert.equal(withZone.windDownStart, '22:30');
  assert.equal(withZone.timeInBedMinutes, 480, 'todellinen kesto säilyy');

  // Ilman aikavyöhykettä laskenta on seinäkellolla (dokumentoitu raja).
  const wall = sleepScheduleFor({ dateIso: '2026-03-29', profile: PROFILE, settings: SETTINGS });
  assert.equal(wall.bedtime, '00:00');
});

test('KESÄAIKA: syksyn vaihtoyönä 8 h unta alkaa kello 1 ja toistuva tunti lasketaan kerran', () => {
  // Su 25.10.2026 kello siirtyy 04 -> 03: yö on tunnin pidempi.
  const s = sleepScheduleFor({ dateIso: '2026-10-25', profile: PROFILE, settings: SETTINGS, offsetMinutesFn: helsinkiOffset });
  assert.equal(s.wakeTime, '08:00');
  assert.equal(s.bedtime, '01:00');
  assert.equal(s.bedtimeDate, '2026-10-25');
  assert.equal(s.windDownStart, '00:30');
  assert.equal(s.windDownDate, '2026-10-25');
  assert.equal(s.timeInBedMinutes, 480);
});

test('KESÄAIKA: olematon herätysaika siirtyy seuraavaan olemassa olevaan minuuttiin', () => {
  const s = sleepScheduleFor({
    dateIso: '2026-03-29', profile: { ...PROFILE, defaultWakeTime: '03:30' },
    settings: { ...SETTINGS, weekendWakeShiftMaxMinutes: 0 }, offsetMinutesFn: helsinkiOffset
  });
  assert.equal(s.wakeTime, '04:00');
  assert.equal(s.wakeAdjusted, true);
  // Arkipäivän aamu vaihtoviikolla ei muutu.
  const monday = sleepScheduleFor({ dateIso: '2026-03-30', profile: PROFILE, settings: SETTINGS, offsetMinutesFn: helsinkiOffset });
  assert.equal(monday.bedtime, '23:00');
  assert.equal(monday.wakeAdjusted, false);
});

test('päivän unirytmi: virheellinen syöte -> null, ei koskaan poikkeusta', () => {
  for (const bad of GARBAGE) {
    assert.doesNotThrow(() => sleepScheduleFor(bad));
    assert.equal(sleepScheduleFor(bad), null, String(bad?.toString?.() ?? typeof bad));
  }
  for (const profile of GARBAGE) {
    for (const settings of GARBAGE) {
      const s = sleepScheduleFor({ dateIso: MONDAY, profile, settings, requiredWake: profile, offsetMinutesFn: () => 'x' });
      // Järjetön aikavyöhykefunktio ei kelpaa: tulos on null eikä arvaus.
      assert.equal(s, null);
      assert.doesNotThrow(() => sleepScheduleFor({ dateIso: MONDAY, profile, settings }));
    }
  }
  assert.equal(sleepScheduleFor({ dateIso: MONDAY, offsetMinutesFn: () => { throw new Error('boom'); } }), null);
});

test('päivän unirytmi: deterministinen, jäädytetty eikä muuta syötettä', () => {
  const input = deepFreezeInput({ dateIso: MONDAY, profile: { ...PROFILE }, settings: { ...SETTINGS, bedtimeTarget: '22:15' }, requiredWake: '06:00' });
  const first = JSON.stringify(sleepScheduleFor(input));
  for (let index = 0; index < 20; index += 1) assert.equal(JSON.stringify(sleepScheduleFor(input)), first);
  const mutable = { dateIso: MONDAY, profile: { ...PROFILE }, settings: { ...SETTINGS } };
  const before = JSON.stringify(mutable);
  sleepScheduleFor(mutable);
  assert.equal(JSON.stringify(mutable), before);
});

// ================================================================ vuoteessaolo

test('vuoteessaolo: keskiyön yli, saman päivän sisällä, tuntematon on null', () => {
  assert.equal(sleepOpportunity({ wakeDate: MONDAY, actualBedtime: '23:00', actualWake: '07:00' }), 480);
  assert.equal(sleepOpportunity({ wakeDate: MONDAY, actualBedtime: '01:00', actualWake: '08:00' }), 420);
  assert.equal(sleepOpportunity({ wakeDate: '2027-01-01', actualBedtime: '22:30', actualWake: '06:45' }), 495);
  assert.equal(sleepOpportunity({ wakeDate: MONDAY, actualBedtime: null, actualWake: '07:00' }), null);
  assert.equal(sleepOpportunity({ wakeDate: MONDAY, actualBedtime: '23:00', actualWake: null }), null);
  assert.equal(sleepOpportunity({ wakeDate: MONDAY, plannedBedtime: '23:00', plannedWake: '07:00' }), null,
    'suunnitelma ei ole havainto');
  assert.equal(sleepOpportunity({ wakeDate: MONDAY, actualBedtime: '07:00', actualWake: '07:00' }), null);
  assert.equal(sleepOpportunity({ wakeDate: MONDAY, actualBedtime: '06:00', actualWake: '05:00' }), null,
    `yli ${MAX_TIME_IN_BED_MINUTES} min on todennäköisemmin kirjausvirhe`);
  assert.equal(sleepOpportunity({ wakeDate: 'eilen', actualBedtime: '23:00', actualWake: '07:00' }), null);
  for (const bad of GARBAGE) {
    assert.doesNotThrow(() => sleepOpportunity(bad, bad));
    assert.equal(sleepOpportunity(bad), null);
  }
  // kind: 'measured' ei muuta laskentaa: sekin on vuoteessaoloa.
  assert.equal(sleepOpportunity({ wakeDate: MONDAY, actualBedtime: '23:00', actualWake: '07:00', kind: SLEEP_KIND.MEASURED }), 480);
});

test('KESÄAIKA: vuoteessaolo vaihtoyönä on todellinen kesto', () => {
  const spring = { wakeDate: '2026-03-29', actualBedtime: '23:00', actualWake: '07:00' };
  const fall = { wakeDate: '2026-10-25', actualBedtime: '23:00', actualWake: '07:00' };
  assert.equal(sleepOpportunity(spring, { offsetMinutesFn: helsinkiOffset }), 420);
  assert.equal(sleepOpportunity(fall, { offsetMinutesFn: helsinkiOffset }), 540);
  assert.equal(sleepOpportunity(spring), 480, 'ilman aikavyöhykettä seinäkellon erotus');
  assert.equal(elapsedMinutes({ date: '2026-03-28', time: '23:00' }, { date: '2026-03-29', time: '07:00' }, helsinkiOffset), 420);
  assert.equal(elapsedMinutes({ date: '2026-03-28', time: '23:00' }, null), null);
});

// ================================================================ rytmin siirtymä

/** Kirjaukset päiville [from, to]: arkena 23.00-7.00, viikonloppuna annettu. */
function logsBetween(fromIso, toIso, { weekendBed = '01:00', weekendWake = '09:30', weekdayBed = '23:00', weekdayWake = '07:00' } = {}) {
  const logs = [];
  for (let iso = fromIso; iso <= toIso; iso = shiftDateIso(iso, 1)) {
    const weekend = isWeekendIso(iso);
    logs.push({
      id: 'log-' + iso, wakeDate: iso, source: 'user', kind: SLEEP_KIND.OPPORTUNITY,
      plannedBedtime: '23:00', plannedWake: '07:00',
      actualBedtime: weekend ? weekendBed : weekdayBed,
      actualWake: weekend ? weekendWake : weekdayWake,
      updatedAt: '2026-01-01T00:00:00Z'
    });
  }
  return logs;
}

const TODAY = '2026-09-27'; // sunnuntai
const WINDOW_START = shiftDateIso(TODAY, -(DRIFT_WINDOW_DAYS - 1));

test('rytmin siirtymä: väljyys ylittyy joka viikonloppu -> siirtymä kerrotaan rauhallisesti', () => {
  const report = driftReport({ logs: logsBetween(WINDOW_START, TODAY), profile: PROFILE, settings: SETTINGS, todayIso: TODAY });
  assert.equal(report.kind, SLEEP_KIND.OPPORTUNITY, 'mahdollisuus nukkua, ei mitattua unta');
  assert.equal(report.windowStart, WINDOW_START);
  assert.equal(report.weekday.meanWake, '07:00');
  assert.equal(report.weekday.meanBedtime, '23:00');
  assert.equal(report.weekend.meanWake, '09:30');
  assert.equal(report.weekend.meanBedtime, '01:00');
  assert.equal(report.weekday.meanTimeInBedMinutes, 480);
  assert.equal(report.weekend.meanTimeInBedMinutes, 510);
  assert.equal(report.reference.wakeBasis, REFERENCE_BASIS.OBSERVED);
  assert.equal(report.wakeShiftMinutes, 150);
  assert.equal(report.bedShiftMinutes, 120);
  assert.equal(report.weekends.length, 4);
  assert.equal(report.beyondCount, 4);
  assert.equal(report.drifting, true);
  assert.match(report.message, /viimeisen 4 viikon aikana/);
  assert.match(report.message, /keskimäärin 2 h 30 min arkea myöhemmin/);
  assert.match(report.message, /ei unen mittaukseen\.$/);
  assert.doesNotMatch(report.message, TONE);
  assertDeepFrozen(report);
});

test('rytmin siirtymä: raja on tasan käyttäjän oma väljyys, ja vaaditaan kaksi viikonloppua', () => {
  // Tasan 60 min myöhemmin ei ylitä 60 min väljyyttä.
  const atLimit = driftReport({
    logs: logsBetween(WINDOW_START, TODAY, { weekendWake: '08:00', weekendBed: '00:00' }),
    profile: PROFILE, settings: SETTINGS, todayIso: TODAY
  });
  assert.equal(atLimit.beyondCount, 0);
  assert.equal(atLimit.drifting, false);
  assert.equal(atLimit.message, null);

  const overByOne = driftReport({
    logs: logsBetween(WINDOW_START, TODAY, { weekendWake: '08:01', weekendBed: '00:00' }),
    profile: PROFILE, settings: SETTINGS, todayIso: TODAY
  });
  assert.equal(overByOne.drifting, true);

  // Vain yksi viikonloppu yli -> ei vielä siirtymää.
  const logs = logsBetween(WINDOW_START, TODAY, { weekendWake: '07:30', weekendBed: '23:30' });
  const saturday = logs.find(log => log.wakeDate === '2026-09-26');
  saturday.actualWake = '10:00';
  const one = driftReport({ logs, profile: PROFILE, settings: SETTINGS, todayIso: TODAY });
  assert.equal(one.beyondCount, 1);
  assert.equal(DRIFT_MIN_WEEKENDS, 2);
  assert.equal(one.drifting, false);
  // Toinen viikonloppu yli -> siirtymä.
  logs.find(log => log.wakeDate === '2026-09-20').actualBedtime = '02:00';
  const two = driftReport({ logs, profile: PROFILE, settings: SETTINGS, todayIso: TODAY });
  assert.equal(two.beyondCount, 2);
  assert.equal(two.drifting, true);
});

test('rytmin siirtymä: tuntematon ei ole nolla', () => {
  const empty = driftReport({ logs: [], profile: PROFILE, settings: SETTINGS, todayIso: TODAY });
  assert.equal(empty.weekday.count, 0);
  assert.equal(empty.weekday.meanWake, null);
  assert.equal(empty.weekend.meanTimeInBedMinutes, null);
  assert.equal(empty.wakeShiftMinutes, null);
  assert.equal(empty.bedShiftMinutes, null);
  assert.equal(empty.drifting, false);
  assert.equal(empty.reference.wakeBasis, REFERENCE_BASIS.DECLARED);
  assert.equal(empty.reference.wake, '07:00');
  assert.equal(empty.reference.bedtime, '23:00');

  // Pelkät suunnitelmat eivät ole havaintoja.
  const plannedOnly = logsBetween(WINDOW_START, TODAY).map(log => ({ ...log, actualBedtime: null, actualWake: null }));
  const report = driftReport({ logs: plannedOnly, profile: PROFILE, settings: SETTINGS, todayIso: TODAY });
  assert.equal(report.weekday.count, 0);
  assert.equal(report.weekend.count, 0);
  assert.equal(report.drifting, false);

  // Vain herätys tiedossa: nukkumaanmeno on tuntematon, ei nolla.
  const wakeOnly = logsBetween(WINDOW_START, TODAY).map(log => ({ ...log, actualBedtime: null }));
  const partial = driftReport({ logs: wakeOnly, profile: PROFILE, settings: SETTINGS, todayIso: TODAY });
  assert.equal(partial.weekend.meanBedtime, null);
  assert.equal(partial.bedShiftMinutes, null);
  assert.equal(partial.weekday.meanTimeInBedMinutes, null);
  assert.equal(partial.wakeShiftMinutes, 150);
  assert.ok(partial.weekends.every(item => item.bedShiftMinutes === null));
});

test(`rytmin siirtymä: vertailukohta on arki vasta ${DRIFT_MIN_REFERENCE_DAYS} kirjauksesta, muuten oma herätysaika`, () => {
  const weekendOnly = logsBetween(WINDOW_START, TODAY).filter(log => isWeekendIso(log.wakeDate));
  const twoWeekdays = [...weekendOnly, ...logsBetween('2026-09-21', '2026-09-22', { weekdayWake: '06:00' })];
  const declared = driftReport({ logs: twoWeekdays, profile: PROFILE, settings: SETTINGS, todayIso: TODAY });
  assert.equal(declared.reference.wakeBasis, REFERENCE_BASIS.DECLARED);
  assert.equal(declared.reference.wake, '07:00');
  assert.equal(declared.wakeShiftMinutes, 150);

  const threeWeekdays = [...weekendOnly, ...logsBetween('2026-09-21', '2026-09-23', { weekdayWake: '06:00' })];
  const observed = driftReport({ logs: threeWeekdays, profile: PROFILE, settings: SETTINGS, todayIso: TODAY });
  assert.equal(observed.reference.wakeBasis, REFERENCE_BASIS.OBSERVED);
  assert.equal(observed.reference.wake, '06:00');
  assert.equal(observed.wakeShiftMinutes, 210);
});

test('rytmin siirtymä: ikkunan rajat, tulevat päivät ja vuodenvaihde', () => {
  const inside = { id: 'a', wakeDate: WINDOW_START, actualBedtime: '01:00', actualWake: '11:00' };
  const outside = { id: 'b', wakeDate: shiftDateIso(WINDOW_START, -1), actualBedtime: '01:00', actualWake: '11:00' };
  const future = { id: 'c', wakeDate: shiftDateIso(TODAY, 1), actualBedtime: '23:00', actualWake: '07:00' };
  const report = driftReport({ logs: [outside, inside, future], profile: PROFILE, settings: SETTINGS, todayIso: TODAY });
  assert.equal(report.weekend.count + report.weekday.count, 1);

  const newYear = driftReport({ logs: [], profile: PROFILE, settings: SETTINGS, todayIso: '2027-01-10' });
  assert.equal(newYear.windowStart, '2026-12-14');
});

test('rytmin siirtymä: sama päivä kahdesti -> uusin kirjaus; sekoitettu järjestys ei muuta tulosta', () => {
  const logs = logsBetween(WINDOW_START, TODAY);
  const newer = { ...logs.find(log => log.wakeDate === '2026-09-26'), id: 'uusi', actualWake: '07:30', updatedAt: '2026-09-26T10:00:00Z' };
  const all = [...logs, newer];
  const reference = JSON.stringify(driftReport({ logs: all, profile: PROFILE, settings: SETTINGS, todayIso: TODAY }));
  assert.equal(JSON.parse(reference).weekends.find(item => item.saturday === '2026-09-26').wakeShiftMinutes, 150,
    'sunnuntai 9.30 on viikonlopun suurin siirtymä');
  let seed = 7;
  for (let round = 0; round < 10; round += 1) {
    const shuffled = [...all].sort(() => {
      seed = (seed * 16807) % 2147483647;
      return seed % 3 - 1;
    });
    assert.equal(JSON.stringify(driftReport({ logs: shuffled, profile: PROFILE, settings: SETTINGS, todayIso: TODAY })), reference);
  }
  const before = JSON.stringify(all);
  driftReport({ logs: all, profile: PROFILE, settings: SETTINGS, todayIso: TODAY });
  assert.equal(JSON.stringify(all), before, 'syötettä ei muuteta');
});

test('rytmin siirtymä: ristiriitainen nukkumaanmeno (herätyksen jälkeen) ohitetaan, herätys säilyy', () => {
  const logs = [{ id: 'x', wakeDate: '2026-09-26', actualBedtime: '10:00', actualWake: '09:00' }];
  const report = driftReport({ logs, profile: PROFILE, settings: SETTINGS, todayIso: TODAY });
  assert.equal(report.weekend.wakeCount, 1);
  assert.equal(report.weekend.bedtimeCount, 0);
});

test('rytmin siirtymä: roskasyöte ei koskaan kaada', () => {
  for (const bad of GARBAGE) {
    assert.doesNotThrow(() => driftReport(bad));
    assert.doesNotThrow(() => driftReport({ logs: bad, todayIso: TODAY, profile: bad, settings: bad }));
    assert.doesNotThrow(() => driftReport({ logs: [bad, { wakeDate: bad, actualWake: bad }], todayIso: TODAY }));
  }
  assert.equal(driftReport({ logs: [], todayIso: 'tänään' }), null);
});

test('rytmin siirtymä: kasvaa lineaarisesti suurella aineistolla', () => {
  function build(count) {
    const logs = [];
    for (let index = 0; index < count; index += 1) {
      const date = shiftDateIso(TODAY, -(index % 60));
      logs.push({ id: 'l' + index, wakeDate: date, actualBedtime: '23:' + String(index % 60).padStart(2, '0'), actualWake: '07:00', updatedAt: String(index) });
    }
    return logs;
  }
  const time = logs => {
    const start = process.hrtime.bigint();
    driftReport({ logs, profile: PROFILE, settings: SETTINGS, todayIso: TODAY });
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

// ================================================================ paluu arkeen

test('paluu arkeen lauantaina: ehdotus porrastaa enintään 30 min yössä', () => {
  const r = mondayReadiness({ todayIso: SATURDAY, mondayWake: '07:00', recentWeekendWake: '09:00', settings: SETTINGS, profile: PROFILE });
  assert.equal(r.message,
    'Viikonlopun rytmi on siirtymässä 2 h myöhemmäksi. Haluatko pitää sunnuntain herätyksen lähempänä arkirytmiä?');
  assert.equal(r.mondayDate, MONDAY);
  assert.equal(r.shiftMinutes, 120);
  assert.equal(r.steps.length, 2);
  const [sunday, monday] = r.steps;
  assert.deepEqual([sunday.date, sunday.wakeTime, sunday.suggestion, sunday.fixed], [SUNDAY, '08:30', true, false]);
  assert.equal(sunday.earlierByMinutes, MAX_RETURN_STEP_MINUTES);
  assert.equal(sunday.bedtime, '00:30');
  assert.equal(sunday.bedtimeDate, SUNDAY);
  assert.deepEqual([monday.date, monday.wakeTime, monday.suggestion, monday.fixed], [MONDAY, '07:00', false, true]);
  assert.equal(monday.bedtime, '23:00');
  assert.equal(r.mondayJumpMinutes, 90, 'jäljelle jäävä hyppy kerrotaan rehellisesti');
  assert.match(r.detail, /Maanantaiaamu on silti 1 h 30 min sunnuntaita aiemmin\./);
  assert.equal(r.suggestion, true);
  for (const step of r.steps.filter(item => item.suggestion)) assert.ok(step.earlierByMinutes <= MAX_RETURN_STEP_MINUTES);
  assert.doesNotMatch(r.message + r.detail, TONE);
  assertDeepFrozen(r);
});

test('paluu arkeen: pieni siirtymä ehtii palata porrastettuna', () => {
  const r = mondayReadiness({ todayIso: SATURDAY, mondayWake: '07:00', recentWeekendWake: '07:40',
    settings: { ...SETTINGS, weekendWakeShiftMaxMinutes: 0 }, profile: PROFILE });
  assert.deepEqual(r.steps.map(step => step.wakeTime), ['07:10', '07:00']);
  assert.equal(r.mondayJumpMinutes, 10);
  assert.doesNotMatch(r.detail, /silti/);
});

test('paluu arkeen sunnuntaina: vain maanantai, ehdotus koskee iltaa', () => {
  const r = mondayReadiness({ todayIso: SUNDAY, mondayWake: '07:00', recentWeekendWake: '09:00', settings: SETTINGS,
    profile: { ...PROFILE, sleepTargetHours: 7 } });
  assert.equal(r.steps.length, 1);
  assert.equal(r.steps[0].date, MONDAY);
  assert.equal(r.steps[0].bedtime, '00:00');
  assert.equal(r.message, 'Viikonlopun rytmi on siirtymässä 2 h myöhemmäksi. Haluatko aloittaa iltarutiinin tänään hieman aiemmin?');
  assert.equal(r.detail, 'Maanantain herätys on 7.00. 7 h unitavoitteella nukkumaan 0.00.');
});

test('paluu arkeen: ei ehdotusta väljyyden sisällä, arkena eikä virheellisellä syötteellä', () => {
  const base = { mondayWake: '07:00', settings: SETTINGS, profile: PROFILE };
  assert.equal(mondayReadiness({ ...base, todayIso: SATURDAY, recentWeekendWake: '08:00' }), null, 'tasan väljyys');
  assert.notEqual(mondayReadiness({ ...base, todayIso: SATURDAY, recentWeekendWake: '08:01' }), null);
  assert.equal(mondayReadiness({ ...base, todayIso: SATURDAY, recentWeekendWake: '06:30' }), null);
  assert.equal(mondayReadiness({ ...base, todayIso: '2026-09-25', recentWeekendWake: '10:00' }), null, 'perjantai');
  assert.equal(mondayReadiness({ ...base, todayIso: MONDAY, recentWeekendWake: '10:00' }), null);
  for (const bad of GARBAGE) {
    assert.doesNotThrow(() => mondayReadiness(bad));
    assert.equal(mondayReadiness(bad), null);
    assert.doesNotThrow(() => mondayReadiness({ todayIso: SATURDAY, mondayWake: bad, recentWeekendWake: '10:00', settings: bad, profile: bad }));
  }
});

test('paluu arkeen: kuukauden vaihde ja kevään vaihtoyö', () => {
  const october = mondayReadiness({ todayIso: '2026-10-31', mondayWake: '07:00', recentWeekendWake: '09:30', settings: SETTINGS, profile: PROFILE });
  assert.equal(october.mondayDate, '2026-11-02');
  assert.deepEqual(october.steps.map(step => step.date), ['2026-11-01', '2026-11-02']);

  // La 28.3.2026: sunnuntaiaamun 8.30 edeltää kevään siirtymä. 8 h todellista unta alkaa la 23.30.
  const spring = mondayReadiness({ todayIso: '2026-03-28', mondayWake: '07:00', recentWeekendWake: '09:00',
    settings: SETTINGS, profile: PROFILE, offsetMinutesFn: helsinkiOffset });
  assert.equal(spring.steps[0].wakeTime, '08:30');
  assert.equal(spring.steps[0].bedtime, '23:30');
  assert.equal(spring.steps[0].bedtimeDate, '2026-03-28');
});

// ================================================================ edellinen ilta

test('illan huomautus: täsmälleen suunniteltu sanamuoto', () => {
  const usual = sleepScheduleFor({ dateIso: '2026-09-29', profile: PROFILE, settings: SETTINGS });
  const tomorrow = sleepScheduleFor({ dateIso: '2026-09-29', profile: PROFILE, settings: SETTINGS, requiredWake: '06:40' });
  const notice = eveningBefore({ tomorrowSchedule: tomorrow, usualSchedule: usual, settings: SETTINGS, cause: 'commute' });
  assert.equal(notice.message,
    'Huomisen työmatka vaatii aikaisemman lähdön. Jos haluat säilyttää 8 h unen, iltarutiini kannattaa aloittaa 20 min aiemmin.');
  assert.equal(notice.windDownStart, '22:10');
  assert.equal(notice.bedtime, '22:40');
  assert.equal(notice.wakeTime, '06:40');
  assert.equal(notice.deltaMinutes, 20);
  assert.equal(notice.sleepMinutes, 480);
  assert.equal(notice.suggestion, true);
  assert.equal(notice.detail, 'Iltarutiini 22.10, nukkumaan 22.40, herätys 6.40.');
  assert.ok(Object.isFrozen(notice));

  const generic = eveningBefore({ tomorrowSchedule: tomorrow, usualSchedule: usual });
  assert.match(generic.message, /^Huominen aamu alkaa tavallista aiemmin\. /);
});

test(`illan huomautus: vasta ${EVENING_NOTICE_MIN_MINUTES} min aikaistuksesta; myöhempi huominen ei huomauta`, () => {
  const usual = sleepScheduleFor({ dateIso: '2026-09-29', profile: PROFILE, settings: SETTINGS });
  const at = requiredWake => eveningBefore({
    tomorrowSchedule: sleepScheduleFor({ dateIso: '2026-09-29', profile: PROFILE, settings: SETTINGS, requiredWake }),
    usualSchedule: usual
  });
  assert.equal(at('06:56'), null);
  assert.equal(at('06:55').deltaMinutes, 5);
  assert.equal(at('07:00'), null);
  assert.equal(at(null), null);
  const later = sleepScheduleFor({ dateIso: '2026-09-29', profile: { ...PROFILE, defaultWakeTime: '08:00' }, settings: SETTINGS });
  assert.equal(eveningBefore({ tomorrowSchedule: later, usualSchedule: usual }), null);
});

test('illan huomautus: ilman iltarutiinia ehdotetaan aiempaa nukkumaanmenoa; keskiyön yli toimii', () => {
  const settings = { ...SETTINGS, windDownMinutes: 0 };
  const usual = sleepScheduleFor({ dateIso: '2026-09-29', profile: PROFILE, settings });
  const tomorrow = sleepScheduleFor({ dateIso: '2026-09-29', profile: PROFILE, settings, requiredWake: '05:30' });
  const notice = eveningBefore({ tomorrowSchedule: tomorrow, usualSchedule: usual });
  assert.match(notice.message, /nukkumaan kannattaa mennä 1 h 30 min aiemmin\.$/);
  assert.match(notice.detail, /^Nukkumaan 21\.30/);

  // Tavallinen nukkumaanmeno keskiyön jälkeen, huominen ennen.
  const lateProfile = { ...PROFILE, defaultWakeTime: '08:30' };
  const usualLate = sleepScheduleFor({ dateIso: '2026-09-29', profile: lateProfile, settings: SETTINGS });
  const earlyTomorrow = sleepScheduleFor({ dateIso: '2026-09-29', profile: lateProfile, settings: SETTINGS, requiredWake: '07:15' });
  assert.equal(usualLate.bedtime, '00:30');
  assert.equal(eveningBefore({ tomorrowSchedule: earlyTomorrow, usualSchedule: usualLate }).deltaMinutes, 75);

  // Päivämäärättömät aikataulut tulkitaan keskipäivän säännöllä.
  const bare = s => ({ wakeTime: s.wakeTime, bedtime: s.bedtime, windDownStart: s.windDownStart });
  assert.equal(eveningBefore({ tomorrowSchedule: bare(earlyTomorrow), usualSchedule: bare(usualLate) }).deltaMinutes, 75);
});

test('illan huomautus: roskasyöte -> null, ei poikkeusta', () => {
  for (const bad of GARBAGE) {
    assert.doesNotThrow(() => eveningBefore(bad));
    assert.equal(eveningBefore(bad), null);
    assert.equal(eveningBefore({ tomorrowSchedule: bad, usualSchedule: bad }), null);
  }
  // Ristiriitainen aikataulu (nukkumaan herätyksen jälkeen) ei kelpaa.
  assert.equal(eveningBefore({
    tomorrowSchedule: { date: MONDAY, wakeTime: '06:00', bedtime: '07:00', bedtimeDate: MONDAY },
    usualSchedule: { date: MONDAY, wakeTime: '07:00', bedtime: '23:00', bedtimeDate: SUNDAY }
  }), null);
});

// ================================================================ sävy ja puhtaus

test('sävy: yksikään teksti ei syyllistä, diagnosoi eikä väitä mitattua unta', () => {
  const texts = [];
  for (const dateIso of [MONDAY, SATURDAY, SUNDAY]) {
    for (const requiredWake of [null, '05:00']) {
      for (const bedtimeTarget of [null, '21:30']) {
        texts.push(sleepScheduleFor({ dateIso, profile: PROFILE, settings: { ...SETTINGS, bedtimeTarget }, requiredWake }).reason);
      }
    }
  }
  const drift = driftReport({ logs: logsBetween(WINDOW_START, TODAY), profile: PROFILE, settings: SETTINGS, todayIso: TODAY });
  texts.push(drift.message);
  for (const text of texts) {
    assert.ok(text && text.length > 0);
    assert.doesNotMatch(text, TONE, text);
  }
});

test('PUHTAUS: unirytmi ja seinäkello eivät lue kelloa, arvo eivätkä koske DOM:iin', () => {
  const forbidden = ['Date.now(', 'Math.random', 'crypto.randomUUID', 'performance.now', 'document.', 'window.',
    'localStorage', 'fetch(', 'console.'];
  for (const file of ['src/domain/sleepRhythm.js', 'src/domain/wallClock.js']) {
    const code = readCode(file);
    for (const token of forbidden) assert.equal(code.includes(token), false, `${file}: ${token}`);
    assert.equal(/new Date\(\s*\)/.test(code), false, `${file}: new Date()`);
    for (const target of importsOf(file)) {
      assert.ok(target.startsWith('src/domain/'), `${file} -> ${target}: vain domain-moduuleja`);
    }
  }
  assert.ok(importsOf('src/domain/sleepRhythm.js').includes('src/domain/dailyLife.js'), 'yhteiset käsitteet tulevat dailyLife.js:stä');
});
