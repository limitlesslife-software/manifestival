// Muistutusten suunnittelun testit.
//
// Ilmoitukset ovat tuotteen vaarallisin ominaisuus: väärin tehtynä ne
// muuttavat hyödyllisen sovelluksen häiriöksi, joka poistetaan viikossa.
// Siksi rajoitukset — rauhoitusaika, päiväraja, eskalaatio — testataan yhtä
// tarkasti kuin aikataulutus.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  NOTIFICATION_TYPE, LEVEL, CHANNEL, DEFAULT_PREFERENCES,
  levelLabel, channelForLevel, normalizePreferences, isQuietTime,
  escalationForTask, escalationForDeadline, intentId,
  planNotifications, applyLimits, summarizeIntents, planRange
} from '../src/domain/notification.js';
import { normalizeTask } from '../src/domain/task.js';
import { normalizeRoutine, expandRoutines, RECURRENCE } from '../src/domain/routine.js';

const DAY = '2026-09-01';
const on = { enabled: true };

const task = (over = {}) => normalizeTask({
  id: 't1', title: 'Tehtävä', date: DAY, priority: 'normaali', ...over
});

// ------------------------------------------------------------- tasot

test('nelitasoinen eskalaatio on määritelty', () => {
  assert.equal(LEVEL.INFO, 1);
  assert.equal(LEVEL.REMINDER, 2);
  assert.equal(LEVEL.ACTION, 3);
  assert.equal(LEVEL.CRITICAL, 4);
  assert.equal(levelLabel(LEVEL.CRITICAL), 'Kriittinen');
  assert.equal(levelLabel(99), 'Tieto', 'tuntematon taso on turvallisin');
});

test('kanava seuraa tasoa — käyttäjä ei säädä sitä erikseen', () => {
  assert.equal(channelForLevel(LEVEL.INFO), CHANNEL.SILENT);
  assert.equal(channelForLevel(LEVEL.REMINDER), CHANNEL.NOTIFICATION);
  assert.equal(channelForLevel(LEVEL.ACTION), CHANNEL.SOUND);
  assert.equal(channelForLevel(LEVEL.CRITICAL), CHANNEL.ALARM);
});

test('escalationForTask: myöhässä oleva on kriittinen', () => {
  assert.equal(escalationForTask(task({ deadline: '2026-08-01' }), DAY), LEVEL.CRITICAL);
});

test('escalationForTask: tänään erääntyvä vaatii toimintaa', () => {
  assert.equal(escalationForTask(task({ deadline: DAY }), DAY), LEVEL.ACTION);
});

test('escalationForTask: huomenna erääntyvä on muistutus', () => {
  assert.equal(escalationForTask(task({ deadline: '2026-09-02' }), DAY), LEVEL.REMINDER);
});

test('escalationForTask: ajastettu tehtävä on aina vähintään muistutus', () => {
  assert.equal(escalationForTask(task({ time: '10:00' }), DAY), LEVEL.REMINDER);
});

test('korkea prioriteetti nostaa tasoa mutta ei tee kriittistä', () => {
  const level = escalationForTask(task({ priority: 'korkea', deadline: DAY }), DAY);
  assert.equal(level, LEVEL.ACTION, 'kriittinen on varattu todelliselle myöhästymiselle');
});

test('valmis tehtävä ei koskaan eskaloidu', () => {
  assert.equal(escalationForTask(task({ deadline: '2026-01-01', completed: true }), DAY), LEVEL.INFO);
  assert.equal(escalationForTask(null, DAY), LEVEL.INFO);
});

test('escalationForDeadline palauttaa null kaukaiselle määräajalle', () => {
  assert.equal(escalationForDeadline(task({ deadline: '2027-01-01' }), DAY), null);
  assert.equal(escalationForDeadline(task(), DAY), null);
  assert.equal(escalationForDeadline(task({ deadline: '2026-09-03' }), DAY), LEVEL.INFO);
});

// ------------------------------------------------------------ asetukset

test('ilmoitukset ovat oletuksena pois päältä', () => {
  assert.equal(DEFAULT_PREFERENCES.enabled, false, 'käyttäjän pitää valita ne itse');
  assert.deepEqual(planNotifications({ tasks: [task()], dateIso: DAY }), []);
});

test('normalizePreferences rajaa arvot järkeviksi', () => {
  const p = normalizePreferences({ enabled: true, taskLeadMinutes: 9999, maxPerDay: 0 });
  assert.equal(p.taskLeadMinutes, 240);
  assert.equal(p.maxPerDay, 1);
  assert.equal(normalizePreferences({ taskLeadMinutes: 'roska' }).taskLeadMinutes, 10);
});

test('normalizePreferences hylkää kelvottoman kellonajan', () => {
  const p = normalizePreferences({ dailyPlanTime: '25:99', quietHours: { from: 'x', to: 'y' } });
  assert.equal(p.dailyPlanTime, DEFAULT_PREFERENCES.dailyPlanTime);
  assert.equal(p.quietHours.from, DEFAULT_PREFERENCES.quietHours.from);
});

// -------------------------------------------------------- rauhoitusaika

test('rauhoitusaika tunnistetaan keskiyön yli', () => {
  const quiet = { from: '22:00', to: '06:30' };
  assert.equal(isQuietTime('23:00', quiet), true);
  assert.equal(isQuietTime('02:00', quiet), true);
  assert.equal(isQuietTime('06:00', quiet), true);
  assert.equal(isQuietTime('06:30', quiet), false, 'loppuhetki ei kuulu rauhoitukseen');
  assert.equal(isQuietTime('12:00', quiet), false);
  assert.equal(isQuietTime('22:00', quiet), true, 'alkuhetki kuuluu rauhoitukseen');
});

test('rauhoitusaika saman vuorokauden sisällä', () => {
  const quiet = { from: '13:00', to: '15:00' };
  assert.equal(isQuietTime('14:00', quiet), true);
  assert.equal(isQuietTime('16:00', quiet), false);
  assert.equal(isQuietTime('08:00', quiet), false);
});

test('TAKUU: rauhoitusaikana ei ilmoiteta', () => {
  const intents = planNotifications({
    tasks: [task({ id: 'yo', time: '23:30' })],
    dateIso: DAY,
    preferences: { ...on, dailyPlanEnabled: false, eveningReviewEnabled: false }
  });
  assert.deepEqual(intents, [], 'yöllinen muistutus ei saa läpäistä rauhoitusaikaa');
});

test('kriittinen ilmoitus läpäisee rauhoitusajan', () => {
  // Jos jokin on todella myöhässä, hiljaisuus olisi karhunpalvelus.
  const intents = planNotifications({
    tasks: [task({ id: 'myohassa', time: '23:30', deadline: '2026-08-01' })],
    dateIso: DAY,
    todayIso: DAY,
    preferences: { ...on, dailyPlanEnabled: false, eveningReviewEnabled: false, deadlineWarningsEnabled: false }
  });
  assert.equal(intents.length, 1);
  assert.equal(intents[0].level, LEVEL.CRITICAL);
});

// -------------------------------------------------------- suunnittelu

test('päivän suunnitelma ja illan katsaus suunnitellaan', () => {
  const intents = planNotifications({ tasks: [], dateIso: DAY, preferences: on });
  const types = intents.map(i => i.type);
  assert.ok(types.includes(NOTIFICATION_TYPE.DAILY_PLAN));
  assert.ok(types.includes(NOTIFICATION_TYPE.EVENING_REVIEW));
});

test('päivän suunnitelman voi kytkeä pois', () => {
  const intents = planNotifications({
    tasks: [], dateIso: DAY,
    preferences: { ...on, dailyPlanEnabled: false, eveningReviewEnabled: false }
  });
  assert.deepEqual(intents, []);
});

test('ajastettu tehtävä saa muistutuksen ennakkoajalla', () => {
  const intents = planNotifications({
    tasks: [task({ id: 'kokous', title: 'Kokous', time: '14:00' })],
    dateIso: DAY,
    preferences: { ...on, taskLeadMinutes: 15, dailyPlanEnabled: false, eveningReviewEnabled: false }
  });
  const reminder = intents.find(i => i.type === NOTIFICATION_TYPE.TASK_REMINDER);
  assert.equal(reminder.time, '13:45');
  assert.equal(reminder.taskId, 'kokous');
  assert.match(reminder.body, /14:00/);
});

test('ennakkoaika ei koskaan mene edellisen vuorokauden puolelle', () => {
  const intents = planNotifications({
    tasks: [task({ id: 'aikainen', time: '00:05' })],
    dateIso: DAY,
    preferences: { ...on, taskLeadMinutes: 60, dailyPlanEnabled: false, eveningReviewEnabled: false,
      quietHours: { from: '23:59', to: '23:58' } }
  });
  const reminder = intents.find(i => i.type === NOTIFICATION_TYPE.TASK_REMINDER);
  if (reminder) assert.equal(reminder.time, '00:00', 'muistutus rajataan vuorokauden alkuun');
});

test('aikatauluttamaton tehtävä ei saa tehtävämuistutusta', () => {
  const intents = planNotifications({
    tasks: [task({ id: 'ajaton', time: null })],
    dateIso: DAY,
    preferences: { ...on, dailyPlanEnabled: false, eveningReviewEnabled: false }
  });
  assert.equal(intents.some(i => i.type === NOTIFICATION_TYPE.TASK_REMINDER), false);
});

test('TAKUU: valmiista tehtävästä ei muistuteta', () => {
  const intents = planNotifications({
    tasks: [task({ id: 'tehty', time: '10:00', completed: true })],
    dateIso: DAY,
    preferences: { ...on, dailyPlanEnabled: false, eveningReviewEnabled: false }
  });
  assert.equal(intents.some(i => i.targetId === 'tehty'), false);
});

test('toisen päivän tehtävä ei tuota muistutusta tälle päivälle', () => {
  const intents = planNotifications({
    tasks: [task({ id: 'huomenna', date: '2026-09-02', time: '10:00' })],
    dateIso: DAY,
    preferences: { ...on, dailyPlanEnabled: false, eveningReviewEnabled: false }
  });
  assert.equal(intents.some(i => i.type === NOTIFICATION_TYPE.TASK_REMINDER), false);
});

test('rutiiniesiintymä saa oman muistutuksensa', () => {
  const routines = [normalizeRoutine({
    id: 'r1', title: 'Lääkkeet', preferredTime: '07:00', durationMinutes: 10,
    recurrence: { type: RECURRENCE.DAILY }
  })];
  const occurrences = expandRoutines({ routines, from: DAY, to: DAY });

  const intents = planNotifications({
    tasks: [], routineOccurrences: occurrences, dateIso: DAY,
    preferences: { ...on, routineLeadMinutes: 5, dailyPlanEnabled: false, eveningReviewEnabled: false }
  });

  const reminder = intents.find(i => i.type === NOTIFICATION_TYPE.ROUTINE_REMINDER);
  assert.equal(reminder.time, '06:55');
  assert.equal(reminder.routineId, 'r1');
  assert.equal(reminder.level, LEVEL.REMINDER);
});

test('määräaikavaroitus näytetään myös aikatauluttamattomalle tehtävälle', () => {
  const intents = planNotifications({
    tasks: [task({ id: 'lasku', title: 'Maksa lasku', time: null, deadline: DAY })],
    dateIso: DAY, todayIso: DAY,
    preferences: { ...on, dailyPlanEnabled: false, eveningReviewEnabled: false }
  });
  const warning = intents.find(i => i.type === NOTIFICATION_TYPE.DEADLINE_WARNING);
  assert.ok(warning, 'määräaika koskee myös aikatauluttamatonta');
  assert.equal(warning.level, LEVEL.ACTION);
  assert.equal(warning.deadline, DAY);
});

test('kaukainen määräaika ei tuota varoitusta', () => {
  const intents = planNotifications({
    tasks: [task({ deadline: '2027-06-01' })],
    dateIso: DAY, todayIso: DAY,
    preferences: { ...on, dailyPlanEnabled: false, eveningReviewEnabled: false }
  });
  assert.equal(intents.some(i => i.type === NOTIFICATION_TYPE.DEADLINE_WARNING), false);
});

// ---------------------------------------------------------- rajoitukset

test('TAKUU: ilmoitukset ovat aikajärjestyksessä', () => {
  const tasks = [
    task({ id: 'a', time: '16:00' }),
    task({ id: 'b', time: '09:00' }),
    task({ id: 'c', time: '12:00' })
  ];
  const intents = planNotifications({ tasks, dateIso: DAY, preferences: on });
  const times = intents.map(i => i.atMinutes);
  assert.deepEqual([...times].sort((x, y) => x - y), times);
});

test('TAKUU: ei kahta ilmoitusta samalla tunnisteella', () => {
  const duplicated = [
    { id: intentId('x', 'a', DAY), level: LEVEL.INFO, time: '10:00', atMinutes: 600 },
    { id: intentId('x', 'a', DAY), level: LEVEL.INFO, time: '10:00', atMinutes: 600 }
  ];
  assert.equal(applyLimits(duplicated, on).length, 1);
});

test('TAKUU: päiväraja ei ylity', () => {
  const tasks = Array.from({ length: 30 }, (_, i) =>
    task({ id: 't' + i, time: String(8 + Math.floor(i / 4)).padStart(2, '0') + ':00' }));

  const intents = planNotifications({
    tasks, dateIso: DAY,
    preferences: { ...on, maxPerDay: 5 }
  });
  assert.ok(intents.length <= 5, 'sai ' + intents.length + ' ilmoitusta rajalla 5');
});

test('päivärajan ylittyessä säilytetään tärkeimmät', () => {
  const tasks = [
    ...Array.from({ length: 10 }, (_, i) => task({ id: 'kevyt' + i, time: '1' + (i % 10) + ':00' })),
    task({ id: 'kriittinen', time: '15:00', deadline: '2026-08-01' })
  ];
  const intents = planNotifications({
    tasks, dateIso: DAY, todayIso: DAY,
    preferences: { ...on, maxPerDay: 3, dailyPlanEnabled: false, eveningReviewEnabled: false }
  });
  assert.ok(intents.some(i => i.level === LEVEL.CRITICAL),
    'kriittinen ei saa pudota rajauksessa');
});

test('rajaus säilyttää aikajärjestyksen', () => {
  const tasks = Array.from({ length: 8 }, (_, i) =>
    task({ id: 't' + i, time: String(9 + i).padStart(2, '0') + ':00' }));
  const intents = planNotifications({
    tasks, dateIso: DAY, preferences: { ...on, maxPerDay: 4 }
  });
  const times = intents.map(i => i.atMinutes);
  assert.deepEqual([...times].sort((x, y) => x - y), times);
});

// ------------------------------------------------------- determinismi

test('TAKUU: suunnittelu on deterministinen', () => {
  const tasks = [
    task({ id: 'a', title: 'Alfa', time: '09:00' }),
    task({ id: 'b', title: 'Beeta', time: '11:00', deadline: '2026-09-02' }),
    task({ id: 'c', title: 'Gamma', time: null, deadline: DAY })
  ];
  const first = planNotifications({ tasks, dateIso: DAY, todayIso: DAY, preferences: on });
  const second = planNotifications({
    tasks: [...tasks].reverse(), dateIso: DAY, todayIso: DAY, preferences: on
  });
  assert.deepEqual(first.map(i => i.id), second.map(i => i.id));
});

test('sama kutsu tuottaa saman tuloksen toistettuna', () => {
  const tasks = [task({ time: '10:00' })];
  const runs = Array.from({ length: 5 }, () =>
    JSON.stringify(planNotifications({ tasks, dateIso: DAY, preferences: on })));
  assert.equal(new Set(runs).size, 1);
});

// ------------------------------------------------------------ yhteenveto

test('summarizeIntents laskee tasot ja tyypit', () => {
  const intents = planNotifications({
    tasks: [
      task({ id: 'a', time: '10:00' }),
      task({ id: 'b', time: '12:00', deadline: '2026-08-01' })
    ],
    dateIso: DAY, todayIso: DAY, preferences: on
  });
  const summary = summarizeIntents(intents);
  assert.equal(summary.total, intents.length);
  assert.ok(summary.critical.length >= 1);
  assert.ok(summary.first);
  assert.ok(summary.byType[NOTIFICATION_TYPE.DAILY_PLAN] >= 1);
});

test('summarizeIntents kestää tyhjän listan', () => {
  const summary = summarizeIntents([]);
  assert.equal(summary.total, 0);
  assert.equal(summary.first, null);
  assert.deepEqual(summary.critical, []);
});

// ------------------------------------------------------------ aikaväli

test('planRange suunnittelee useammalle päivälle', () => {
  const tasks = [
    task({ id: 'a', date: DAY, time: '10:00' }),
    task({ id: 'b', date: '2026-09-02', time: '11:00' })
  ];
  const intents = planRange({ tasks, from: DAY, days: 2, todayIso: DAY, preferences: on });
  const dates = new Set(intents.map(i => i.date));
  assert.deepEqual([...dates].sort(), [DAY, '2026-09-02']);
});

test('planRange rajaa aikavälin kahteen viikkoon', () => {
  const intents = planRange({ tasks: [], from: DAY, days: 365, preferences: on });
  const dates = new Set(intents.map(i => i.date));
  assert.ok(dates.size <= 14, 'sai ' + dates.size + ' päivää');
});

test('planRange kestää kelvottoman alkupäivän', () => {
  assert.deepEqual(planRange({ tasks: [], from: 'roska', preferences: on }), []);
});

test('kelvoton päivä ei tuota ilmoituksia', () => {
  assert.deepEqual(planNotifications({ tasks: [], dateIso: 'roska', preferences: on }), []);
});
