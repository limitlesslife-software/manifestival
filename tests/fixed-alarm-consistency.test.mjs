// "Kiinteä aika" -herätys ja kaikki, mikä kertoo herätysajan: laitteen
// herätys, aamusuunnitelma, unirytmi, kalenterin unilohko, ilta- ja
// nukkumaanmenomuistutukset, illan ennakko, Huominen-kortti ja Tänään-
// näkymän aamu.
//
// PÄÄTÖS (ks. src/domain/alarmPlan.js alarmWakeOf): kiinteä herätys ON
// herätysaika. Uni ja iltarutiini lasketaan siitä. Jos aamun meno vaatisi
// aiemman herätyksen, siitä kerrotaan varoituksena ("Herätys on kiinteä
// 6.30, mutta aamu vaatisi herätyksen 6.20"), eikä mikään näkymä hiljaa
// kerro eri herätystä kuin laite.
//
// Perusviikko: tiistai 2026-09-29, huomenna keskiviikkona Palaveri klo 8.00.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDocument, installDocument } from './helpers/a11yDom.mjs';
import { freezeLocalDate } from './helpers/clock.mjs';
import { read } from './helpers/sources.mjs';
import { echoClient } from './helpers/a11ySuunta.mjs';
import { setUser, clearUser } from '../src/data/session.js';
import { setClient } from '../src/data/client.js';
import { clearAllCollections } from '../src/data/collectionsRepo.js';
import {
  resetState, getState, setProfile, setSavedPlaces, setCalendarEvents, setLifeSettings,
  setNotificationPreferences, setViewDate
} from '../src/app/state.js';
import { resetDailyLifeActions } from '../src/app/dailyLifeActions.js';
import { morningPlanOn, sleepScheduleOn } from '../src/app/dailyLifeModel.js';
import { calendarInputs } from '../src/app/calendarPlan.js';
import { plannedWakeAlarms, dailyLifeReminderPlan } from '../src/app/alarmSync.js';
import { eveningBeforeNotice, runDailyLifeNotices } from '../src/app/dailyLifeNotices.js';
import { renderToday, initTodayNavigation } from '../src/app/views/today.js';
import { resetTodayDailyLife } from '../src/app/views/todayDailyLife.js';
import { nextAlarmFor } from '../src/app/views/dailySettings.js';
import { emptyAckLog } from '../src/domain/notificationAck.js';
import { alarmWakeOf, fixedAlarmNote, desiredAlarms } from '../src/domain/alarmPlan.js';
import { sleepScheduleFor } from '../src/domain/sleepRhythm.js';
import { closeConfirmDialogs } from '../src/ui/confirm.js';
import { clearToasts } from '../src/ui/toast.js';

const USER = Object.freeze({ id: 'dddd0005-5555-4555-8555-00000000d0d5', email: 'fixed@example.invalid' });
const TUE = '2026-09-29';
const WED = '2026-09-30';
const ROUTINE = Object.freeze([
  { id: 'r1', name: 'Suihku', minutes: 15, protection: 'mandatory' },
  { id: 'r2', name: 'Aamiainen', minutes: 30, protection: 'important_flexible' }
]);

const flush = async (rounds = 10) => {
  for (let i = 0; i < rounds; i += 1) await new Promise(resolve => setImmediate(resolve));
};

function localDate(dateIso, time) {
  const [y, m, d] = dateIso.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  return new Date(y, m - 1, d, hh, mm, 0, 0);
}

/**
 * Palaveri klo 8.00 Työssä: perillä 7.45 (etuaika 15), matka 25 -> lähtö
 * 7.20, valmistautuminen 15 -> 7.05. Aamurutiini 45 min -> aamu vaatii
 * herätyksen 6.20. Profiilin herätys 6.30, unitavoite 8 h.
 */
function seed(alarm) {
  setProfile({ sleepTargetHours: 8, defaultWakeTime: '06:30', commuteMinutes: 30, routineMinutes: 60 }, true);
  setSavedPlaces([{ id: 'tyo', name: 'Työ', usualTravelMinutes: 25, arrivalBufferMinutes: 15, preparationMinutes: 15, overheadMinutes: 0 }]);
  setLifeSettings([{ id: 'ls1', morningRoutine: ROUTINE, windDownMinutes: 30, alarm }]);
  setNotificationPreferences({ enabled: true, maxPerDay: 40 });
  setCalendarEvents([{ id: 'pal', title: 'Palaveri', date: WED, startTime: '08:00', durationMinutes: 60, placeId: 'tyo' }]);
}

/** Tänään-näkymä oikeassa index.html-DOMissa, kello jäädytettynä. */
function mount(t, dateIso, time) {
  freezeLocalDate(t, dateIso, time);
  clearUser();
  clearAllCollections();
  resetState();
  resetDailyLifeActions();
  resetTodayDailyLife();
  const doc = createDocument(read('index.html'));
  const uninstall = installDocument(doc);
  setUser(USER);
  setClient(echoClient());
  doc.getElementById('app').classList.remove('app-hidden');
  initTodayNavigation();
  t.after(async () => {
    closeConfirmDialogs();
    await flush(4);
    clearToasts();
    resetTodayDailyLife();
    uninstall();
    clearUser();
  });
  return {
    text: id => doc.getElementById(id).textContent.replace(/\s+/g, ' ').trim(),
    qa: (id, selector) => doc.getElementById(id).querySelectorAll(selector),
    render() {
      const [y, m, d] = dateIso.split('-').map(Number);
      setViewDate(new Date(y, m - 1, d));
      renderToday();
    },
    at(clockTime, date = dateIso) {
      t.mock.timers.setTime(localDate(date, clockTime).getTime());
      const [y, m, d] = date.split('-').map(Number);
      setViewDate(new Date(y, m - 1, d));
      renderToday();
    }
  };
}

function wakeAlarm(now) {
  return plannedWakeAlarms({ state: getState(), now, ackLog: emptyAckLog() }).find(alarm => alarm.forDate === WED);
}

/** Tiistai-illan ja keskiviikkoaamun suojatut lohkot (kalenterin laskenta, sama kuin näkymissä). */
function sleepBlocks() {
  return calendarInputs(getState(), { from: TUE, to: TUE }).blocks
    .filter(block => block.kind === 'sleep' || block.kind === 'wind_down');
}

function bedtimeIntents(now) {
  return dailyLifeReminderPlan({ state: getState(), now, ackLog: emptyAckLog() }).intents
    .filter(intent => intent.date === TUE && /bedtime|wind/i.test(String(intent.type)))
    .map(intent => `${intent.type} ${intent.time}`)
    .sort();
}

// ================================================================ perustapaus: seuraa suunnitelmaa

test('vertailukohta: "Seuraa suunnitelmaa" -herätys aikaistuu menon mukaan ja kaikki kertovat 6.20', t => {
  const view = mount(t, TUE, '20:00');
  seed({ enabled: true, followPlan: true });
  const now = new Date();
  assert.equal(morningPlanOn(WED, { now }).requiredWakeTime, '06:20', 'aamu vaatii herätyksen 6.20');
  assert.equal(wakeAlarm(now).time, '06:20');
  const schedule = sleepScheduleOn(WED, { now });
  assert.deepEqual([schedule.wakeTime, schedule.bedtime, schedule.windDownStart], ['06:20', '22:20', '21:50']);
  assert.match(eveningBeforeNotice({ now }).reason, /iltarutiini kannattaa aloittaa 10 min aiemmin/);
  view.render();
  assert.match(view.text('todayTomorrow'), /Herätys klo 6\.20 · 10 min tavallista aiemmin/);
});

// ================================================================ kiinteä herätys myöhempänä kuin aamu vaatii

test('KRIITTINEN: kiinteä 6.30 ja aamu vaatisi 6.20 — kaikki kertovat 6.30 ja varoittavat, kukaan ei ole hiljaa eri mieltä', async t => {
  const view = mount(t, TUE, '20:00');
  seed({ enabled: true, followPlan: false, weekdayTime: '06:30' });
  const now = new Date();
  const note = 'Herätys on kiinteä 6.30, mutta aamu vaatisi herätyksen 6.20: aikaa puuttuu 10 min.';

  // Laitteen herätys ja sen perustelu.
  const alarm = wakeAlarm(now);
  assert.equal(alarm.time, '06:30');
  assert.equal(alarm.fits, false);
  assert.ok(alarm.reason.includes(note), alarm.reason);
  assert.equal(nextAlarmFor(getState(), now.getTime()).time, '06:30', 'asetusten "Seuraava herätys" on sama');

  // Aamusuunnitelma: herätys on kiinteä, vaje kerrotaan.
  const plan = morningPlanOn(WED, { now });
  assert.deepEqual([plan.wakeTime, plan.requiredWakeTime, plan.fits, plan.shortfallMinutes], ['06:30', '06:20', false, 10]);

  // Uni ja iltarutiini kiinteästä herätyksestä: 8 h ennen 6.30.
  const schedule = sleepScheduleOn(WED, { now });
  assert.deepEqual([schedule.wakeTime, schedule.bedtime, schedule.windDownStart], ['06:30', '22:30', '22:00']);
  assert.equal(schedule.earlierThanUsualMinutes, 0);

  // Kalenterin unilohko päättyy herätykseen, ei menon vaatimaan aikaan.
  const night = sleepBlocks().filter(block => block.kind === 'sleep' && block.date === WED);
  assert.ok(night.length > 0);
  assert.deepEqual(night.map(block => block.endTime), ['06:30']);

  // Ilta- ja nukkumaanmenomuistutukset samasta unirytmistä.
  assert.deepEqual(bedtimeIntents(localDate(TUE, '12:00')), ['bedtime 22:30', 'wind_down 22:00']);

  // Illan ennakko: ei "iltarutiini 10 min aiemmin" (uni lasketaan kiinteästä), vaan varoitus.
  const evening = eveningBeforeNotice({ now });
  assert.ok(evening, 'kiinteän herätyksen ristiriidasta kerrotaan illalla');
  assert.doesNotMatch(evening.reason, /iltarutiini kannattaa aloittaa/);
  assert.ok(evening.reason.includes(note), evening.reason);
  assert.equal(evening.targetId, 'daily', 'napautus avaa herätyksen asetukset');
  assert.equal((await runDailyLifeNotices({ now })).created, 1);
  assert.equal((await runDailyLifeNotices({ now: localDate(TUE, '21:00') })).created, 0, 'ei toistu');

  // Huominen-kortti.
  view.render();
  const tomorrow = view.text('todayTomorrow');
  assert.match(tomorrow, /Herätys klo 6\.30 · kiinteä/);
  assert.doesNotMatch(tomorrow, /tavallista aiemmin/);
  assert.match(tomorrow, /Iltarauhoittuminen klo 22\.00/);
  assert.match(tomorrow, /Nukkumaanmeno klo 22\.30/);
  assert.ok(tomorrow.includes(note), tomorrow);
});

// ================================================================ kiinteä herätys aiempana kuin aamu vaatii

test('KRIITTINEN: kiinteä 6.00 — uni ja iltamuistutukset 6.00:sta, ei 7 h 40 min yötä', t => {
  const view = mount(t, TUE, '20:00');
  seed({ enabled: true, followPlan: false, weekdayTime: '06:00' });
  const now = new Date();
  assert.equal(wakeAlarm(now).time, '06:00');
  const plan = morningPlanOn(WED, { now });
  assert.deepEqual([plan.wakeTime, plan.fits, plan.slackMinutes], ['06:00', true, 20]);
  const schedule = sleepScheduleOn(WED, { now });
  assert.deepEqual([schedule.wakeTime, schedule.bedtime, schedule.windDownStart], ['06:00', '22:00', '21:30']);
  assert.equal(schedule.timeInBedMinutes, 8 * 60, 'unitavoite säilyy');
  assert.deepEqual(sleepBlocks().filter(block => block.kind === 'sleep' && block.date === WED).map(block => block.endTime), ['06:00']);
  assert.deepEqual(bedtimeIntents(localDate(TUE, '12:00')), ['bedtime 22:00', 'wind_down 21:30']);
  assert.equal(eveningBeforeNotice({ now }), null, 'kiinteä herätys on tavallinen: ei ennakkoa');
  view.render();
  const tomorrow = view.text('todayTomorrow');
  assert.match(tomorrow, /Herätys klo 6\.00 · kiinteä/);
  assert.match(tomorrow, /Nukkumaanmeno klo 22\.00/);
  assert.doesNotMatch(tomorrow, /aamu vaatisi/);
});

test('kiinteä arkiaika ei koske viikonloppua: tyhjä kenttä = unirytmin herätys, joka ei seuraa menoa', t => {
  mount(t, TUE, '12:00');
  seed({ enabled: true, followPlan: false, weekdayTime: '06:30' });
  const SAT = '2026-10-03';
  setCalendarEvents([{ id: 'kirppis', title: 'Kirpputori', date: SAT, startTime: '08:00', durationMinutes: 60, placeId: 'tyo' }]);
  const now = new Date();
  const alarm = desiredAlarms({
    fromIso: SAT, days: 1, profile: getState().profile, settings: getState().lifeSettings[0],
    commitmentsByDate: { [SAT]: { title: 'Kirpputori', startTime: '08:00', leaveTime: '07:20', prepareStart: '07:05' } }
  })[0];
  const schedule = sleepScheduleOn(SAT, { now });
  const plan = morningPlanOn(SAT, { now });
  assert.equal(alarm.time, schedule.wakeTime, 'herätys ja unirytmi samaa mieltä viikonloppunakin');
  assert.equal(plan.wakeTime, schedule.wakeTime);
  assert.equal(plan.fits, false);
});

// ================================================================ domain: sääntö ja varoitus

test('alarmWakeOf: pois päältä null, kiinteä ja seuraava sääntö, kirjattu nukkumaanmeno rajana', () => {
  const profile = { sleepTargetHours: 8, defaultWakeTime: '06:30' };
  assert.equal(alarmWakeOf({ dateIso: WED, profile, settings: {} }), null, 'herätys ei käytössä');
  assert.equal(alarmWakeOf({ dateIso: 'eilen', profile, settings: { alarm: { enabled: true } } }), null);
  const follow = alarmWakeOf({ dateIso: WED, profile, settings: { alarm: { enabled: true } } });
  assert.deepEqual([follow.fixed, follow.override, follow.time, follow.floorTime], [false, false, '06:30', null]);
  const fixed = alarmWakeOf({ dateIso: WED, profile, settings: { alarm: { enabled: true, followPlan: false, weekdayTime: '06:45' } } });
  assert.deepEqual([fixed.fixed, fixed.override, fixed.time, fixed.floorTime], [true, true, '06:45', null]);
  const floored = alarmWakeOf({ dateIso: WED, profile, settings: { alarm: { enabled: true } },
    sleepLogs: [{ id: 's', wakeDate: WED, actualBedtime: '22:15' }] });
  assert.equal(floored.floorTime, '06:15', 'vuoteeseen 22.15 + 8 h');
  assert.ok(Object.isFrozen(fixed));

  const plan = { wakeTime: '06:45', requiredWakeTime: '06:20', fits: false, shortfallMinutes: 25 };
  assert.equal(fixedAlarmNote(plan, fixed), 'Herätys on kiinteä 6.45, mutta aamu vaatisi herätyksen 6.20: aikaa puuttuu 25 min.');
  assert.equal(fixedAlarmNote({ ...plan, fits: true }, fixed), null);
  assert.equal(fixedAlarmNote(plan, follow), null, 'suunnitelmaa seuraava herätys ei ole kiinteä');
  assert.equal(fixedAlarmNote(null, fixed), null);
});

test('unirytmi: oma herätysaika korvaa profiilin oletuksen, meno voi silti vaatia aiemman', () => {
  const profile = { sleepTargetHours: 8, defaultWakeTime: '06:30' };
  const own = sleepScheduleFor({ dateIso: WED, profile, settings: {}, alarmWakeTime: '06:00' });
  assert.deepEqual([own.wakeTime, own.bedtime, own.usualWakeTime, own.earlierThanUsualMinutes], ['06:00', '22:00', '06:00', 0]);
  assert.match(own.reason, /^Herätys 6\.00 oman herätysaikasi mukaan\./);
  const later = sleepScheduleFor({ dateIso: WED, profile, settings: {}, alarmWakeTime: '07:15' });
  assert.equal(later.wakeTime, '07:15', 'oma herätys voi olla profiilin oletusta myöhempi');
  const required = sleepScheduleFor({ dateIso: WED, profile, settings: {}, alarmWakeTime: '06:45', requiredWake: '06:20' });
  assert.deepEqual([required.wakeTime, required.earlierThanUsualMinutes], ['06:20', 25]);
  const bad = sleepScheduleFor({ dateIso: WED, profile, settings: {}, alarmWakeTime: '6:00' });
  assert.equal(bad.wakeTime, '06:30', 'virheellinen aika ei ole herätys');
});
