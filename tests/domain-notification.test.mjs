// Muistutusten suunnittelun testit.
//
// Ilmoitukset ovat tuotteen vaarallisin ominaisuus: väärin tehtynä ne
// muuttavat hyödyllisen sovelluksen häiriöksi, joka poistetaan viikossa.
// Siksi rajoitukset — rauhoitusaika, päiväraja, eskalaatio — testataan yhtä
// tarkasti kuin aikataulutus.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  NOTIFICATION_TYPE, NOTIFICATION_TYPES, PLANNED_TYPES,
  LEVEL, CHANNEL, DEFAULT_PREFERENCES,
  levelLabel, channelForLevel, normalizePreferences, isQuietTime,
  escalationForTask, escalationForDeadline, intentId,
  planNotifications, applyLimits, summarizeIntents, planRange,
  createIntent, compareIntents, DEPARTURE_CHAIN_TYPES
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

// ------------------------------------------- vakiot dokumentaationa

test('NOTIFICATION_TYPES kattaa jokaisen ilmoitustyypin', () => {
  // Vakio on olemassa, jotta tyypit voi luetella yhdestä paikasta. Ilman
  // testiä se erkanisi NOTIFICATION_TYPE-oliosta heti kun uusi tyyppi
  // lisätään — ja erkaantunut "kaikkien lista" on pahempi kuin ei listaa.
  assert.deepEqual([...NOTIFICATION_TYPES].sort(),
    Object.values(NOTIFICATION_TYPE).sort());
  assert.equal(Object.isFrozen(NOTIFICATION_TYPES), true);
});

test('PLANNED_TYPES luettelee tyypit joita ei ole toteutettu', () => {
  // Tämä lista on lupaus siitä mitä sovellus EI vielä tee. Jokaisen siinä
  // olevan tyypin on oltava tunnettu tyyppi — muuten lista viittaa
  // olemattomaan ominaisuuteen.
  for (const type of PLANNED_TYPES) {
    assert.ok(NOTIFICATION_TYPES.includes(type),
      `${type} ei ole tunnettu ilmoitustyyppi`);
  }

  // Suunniteltu tyyppi ei saa syntyä suunnitelmaan. Jos se syntyisi,
  // sovellus lupaisi muistutuksen jota se ei osaa lähettää.
  const intents = planNotifications({
    tasks: [{ id: 't1', title: 'T', date: '2026-03-15', time: '09:00', completed: false }],
    routineOccurrences: [],
    dateIso: '2026-03-15',
    todayIso: '2026-03-15',
    preferences: normalizePreferences({ enabled: true, maxPerDay: 50 })
  });

  for (const intent of intents) {
    assert.equal(PLANNED_TYPES.includes(intent.type), false,
      `toteuttamaton tyyppi ${intent.type} päätyi suunnitelmaan`);
  }
});

// ------------------------------- yöajo: rajatapaukset ja determinismi

test('rauhoitusaika: alku ja loppu samana tarkoittaa EI rauhoitusta', () => {
  // Nollan mittainen väli. Tämä on tarkoituksellinen päätös, ei
  // sivuvaikutus — ks. isQuietTime():n kommentti. Testi lukitsee sen,
  // jottei tulkinta vaihdu huomaamatta.
  const quiet = { from: '22:00', to: '22:00' };

  for (const time of ['21:59', '22:00', '22:01', '03:00', '12:00', '00:00']) {
    assert.equal(isQuietTime(time, quiet), false,
      time + ' tulkittiin rauhoitetuksi nollan mittaisella välillä');
  }
});

test('rauhoitusaika: vuorokauden rajat', () => {
  const quiet = { from: '22:00', to: '07:00' };

  assert.equal(isQuietTime('00:00', quiet), true, 'keskiyö on rauhoitettu');
  assert.equal(isQuietTime('23:59', quiet), true);
  assert.equal(isQuietTime('06:59', quiet), true);
  assert.equal(isQuietTime('07:00', quiet), false, 'loppuhetki ei kuulu väliin');

  // Koko vuorokauden kattava väli 00:00–00:00 on samoin nollan mittainen.
  const nolla = { from: '00:00', to: '00:00' };
  assert.equal(isQuietTime('12:00', nolla), false);
});

test('rauhoitusaika kestää kelvottoman syötteen', () => {
  for (const bad of [null, undefined, {}, { from: 'x', to: 'y' },
    { from: '25:00', to: '99:99' }]) {
    assert.doesNotThrow(() => isQuietTime('12:00', bad));
  }
  for (const bad of [null, undefined, '', 'x', '25:00']) {
    assert.equal(isQuietTime(bad, { from: '22:00', to: '07:00' }), false);
  }
});

test('KRIITTINEN: sama muistutus ei synny kahdesti', () => {
  // Tunniste on tyyppi + kohde + päivä. Jos sama tehtävä tuottaa
  // muistutuksen kahta reittiä, laitteelle ei saa mennä kahta ilmoitusta.
  const task = normalizeTask({
    id: 'kaksois', title: 'Yksi tehtävä', date: '2026-09-10', time: '10:00'
  });

  const intents = planNotifications({
    tasks: [task, task],  // sama tehtävä kahdesti
    dateIso: '2026-09-10',
    todayIso: '2026-09-10',
    preferences: { enabled: true, maxPerDay: 20 }
  });

  const ids = intents.map(i => i.id);
  assert.equal(ids.length, new Set(ids).size, 'sama tunniste esiintyi kahdesti');
});

test('KRIITTINEN: päiväkatto ei ylity edes kiireellisillä', () => {
  // Korkea prioriteetti ei saa aiheuttaa rajatonta ilmoitusryöppyä.
  const tasks = [];
  for (let i = 0; i < 60; i++) {
    tasks.push(normalizeTask({
      id: 'yli' + i, title: 'Kiireellinen ' + i, date: '2026-09-10',
      time: String(8 + (i % 12)).padStart(2, '0') + ':00',
      priority: 'korkea'
    }));
  }

  const intents = planNotifications({
    tasks, dateIso: '2026-09-10', todayIso: '2026-09-10',
    preferences: { enabled: true, maxPerDay: 5 }
  });

  assert.ok(intents.length <= 5, 'päiväkatto ylittyi: ' + intents.length);
});

test('päiväkatto säilyttää tärkeimmät mutta palauttaa aikajärjestyksessä', () => {
  const tasks = [
    normalizeTask({ id: 'a', title: 'Aikainen', date: '2026-09-10', time: '08:00' }),
    normalizeTask({ id: 'b', title: 'Myöhäinen', date: '2026-09-10', time: '20:00' })
  ];

  const intents = planNotifications({
    tasks, dateIso: '2026-09-10', todayIso: '2026-09-10',
    preferences: { enabled: true, maxPerDay: 10 }
  });

  const times = intents.map(i => i.atMinutes).filter(m => m != null);
  const sorted = [...times].sort((x, y) => x - y);
  assert.deepEqual(times, sorted, 'muistutukset eivät ole aikajärjestyksessä');
});

test('KRIITTINEN: sama syöte tuottaa täsmälleen saman suunnitelman', () => {
  // Epädeterministinen suunnitelma tarkoittaisi, että sama päivä
  // synkronoituna kahdesti peruisi ja ajastaisi kaiken uudelleen —
  // ja laite näyttäisi saman muistutuksen kahdesti.
  const tasks = [
    normalizeTask({ id: 't1', title: 'Aamu', date: '2026-09-10', time: '09:00' }),
    normalizeTask({ id: 't2', title: 'Sama aika', date: '2026-09-10', time: '09:00' }),
    normalizeTask({ id: 't3', title: 'Ilta', date: '2026-09-10', time: '18:00' })
  ];
  const args = {
    tasks, dateIso: '2026-09-10', todayIso: '2026-09-10',
    preferences: { enabled: true, maxPerDay: 20 }
  };

  const first = JSON.stringify(planNotifications(args));
  for (let i = 0; i < 5; i++) {
    assert.equal(JSON.stringify(planNotifications(args)), first,
      'suunnitelma vaihteli kierroksella ' + i);
  }
});

test('valmiista tehtävästä ei muistuteta eikä maksetusta laskusta', () => {
  const intents = planNotifications({
    tasks: [normalizeTask({
      id: 'valmis', title: 'Jo tehty', date: '2026-09-10',
      time: '10:00', completed: true
    })],
    dateIso: '2026-09-10', todayIso: '2026-09-10',
    preferences: { enabled: true, maxPerDay: 20 }
  });

  assert.equal(intents.some(i => i.targetId === 'valmis'), false,
    'valmiista tehtävästä muistutettiin');
});

// ------------------------------------ arjen käyttöjärjestelmän laajennus

test('uudet ilmoitustyypit: lähtöketju, uni, ateria, tapa, illan ja aamun kooste, kooste, menon alku', () => {
  const expected = ['departure_prepare', 'departure_leave_in_5', 'departure_leave_now', 'wind_down', 'bedtime',
    'meal', 'habit', 'evening_before', 'morning_brief', 'digest', 'event_start'];
  for (const type of expected) assert.ok(NOTIFICATION_TYPES.includes(type), type);
  assert.equal(NOTIFICATION_TYPES.length, 6 + expected.length);
  assert.deepEqual([...DEPARTURE_CHAIN_TYPES],
    [NOTIFICATION_TYPE.DEPARTURE_PREPARE, NOTIFICATION_TYPE.DEPARTURE_LEAVE_IN_5, NOTIFICATION_TYPE.DEPARTURE_LEAVE_NOW]);
  // Kaikki toimitetaan tavallisena ilmoituksena: mikään ei ole "suunniteltu".
  assert.deepEqual([...PLANNED_TYPES], []);
});

test('planNotifications ei tuota arjen tyyppejä (ne tulevat dailyReminders.js:stä)', () => {
  const intents = planNotifications({
    tasks: [task({ id: 'a', time: '10:00', deadline: DAY })], dateIso: DAY, todayIso: DAY, preferences: on
  });
  const legacy = ['task_reminder', 'routine_reminder', 'deadline_warning', 'departure_reminder', 'daily_plan', 'evening_review'];
  assert.ok(intents.length > 0);
  for (const intent of intents) assert.ok(legacy.includes(intent.type), intent.type);
});

test('perinteinen aikomus kantaa uudet kentät: aihe ja toimitustapa päättämättä, kuittausavain = tunniste', () => {
  const [intent] = planNotifications({
    tasks: [task({ id: 'k', time: '14:00' })], dateIso: DAY,
    preferences: { ...on, dailyPlanEnabled: false, eveningReviewEnabled: false }
  });
  assert.equal(intent.topic, null, 'null = ei vielä päätetty, ei hiljainen');
  assert.equal(intent.delivery, null);
  assert.equal(intent.speech, null);
  assert.equal(intent.anchor, null);
  assert.equal(intent.ackKey, intent.id);
  assert.equal(intent.ackKey, intentId(NOTIFICATION_TYPE.TASK_REMINDER, 'k', DAY));
});

test('createIntent: jäädytetty, täydellinen aikomus tai null', () => {
  const intent = createIntent({
    type: NOTIFICATION_TYPE.MEAL, level: LEVEL.REMINDER, date: DAY, time: '16:30', title: 'Päivällinen',
    body: 'Aloita valmistus', targetId: 'm1', reason: 'Valmistus vie 30 min', topic: 'meal', delivery: 'vibrate',
    speech: 'Nyt on hyvä aika aloittaa ruoan valmistus.', anchor: { date: DAY, time: '17:00', offsetMinutes: -30 },
    extra: { mealId: 'm1', list: ['a'] }
  });
  assert.ok(Object.isFrozen(intent));
  assert.equal(intent.id, `meal:m1:${DAY}`);
  assert.equal(intent.ackKey, intent.id);
  assert.equal(intent.atMinutes, 990);
  assert.equal(intent.channel, CHANNEL.NOTIFICATION);
  assert.deepEqual(intent.anchor, { date: DAY, time: '17:00', offsetMinutes: -30 });
  assert.ok(Object.isFrozen(intent.anchor));
  assert.equal(intent.mealId, 'm1');
  assert.ok(Object.isFrozen(intent.list));

  for (const bad of [
    { type: 'tuntematon' }, { level: 5 }, { level: '2' }, { date: '2026-02-30' }, { time: '24:00' },
    { title: '' }, { title: '   ' }, { title: 5 }
  ]) {
    assert.equal(createIntent({
      type: NOTIFICATION_TYPE.MEAL, level: LEVEL.REMINDER, date: DAY, time: '16:30', title: 'T', ...bad
    }), null, JSON.stringify(bad));
  }
  for (const garbage of [undefined, null, 5, 'x', []]) assert.equal(createIntent(garbage), null);
});

test('createIntent: lisäkentät eivät ylikirjoita ydinkenttiä; kelvoton ankkuri hylätään', () => {
  const intent = createIntent({
    type: NOTIFICATION_TYPE.HABIT, level: LEVEL.REMINDER, date: DAY, time: '10:30', title: 'Tapa',
    extra: { id: 'huijaus', level: 4, time: '03:00', ackKey: 'x' },
    anchor: { date: DAY, time: '10:30', offsetMinutes: 1.5 }
  });
  assert.equal(intent.level, LEVEL.REMINDER);
  assert.equal(intent.time, '10:30');
  assert.notEqual(intent.id, 'huijaus');
  assert.equal(intent.ackKey, intent.id);
  assert.equal(intent.anchor, null);
  const custom = createIntent({ type: NOTIFICATION_TYPE.HABIT, level: 2, date: DAY, time: '10:30', title: 'T',
    id: 'oma', ackKey: 'yhteinen' });
  assert.equal(custom.id, 'oma');
  assert.equal(custom.ackKey, 'yhteinen');
});

test('compareIntents: päivä, aika, taso (kiireellisin ensin), tunniste', () => {
  const make = over => createIntent({ type: NOTIFICATION_TYPE.MEAL, level: 2, date: DAY, time: '12:00', title: 'T',
    targetId: 'x', ...over });
  const list = [
    make({ targetId: 'b' }), make({ targetId: 'a' }), make({ targetId: 'c', level: 4 }),
    make({ targetId: 'd', time: '11:00' }), make({ targetId: 'e', date: '2026-08-31', time: '23:00' })
  ];
  assert.deepEqual([...list].sort(compareIntents).map(i => i.targetId), ['e', 'd', 'c', 'a', 'b']);
});
