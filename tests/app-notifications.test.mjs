// Muistutusten orkestroinnin testit.
//
// Domain on testattu erikseen ja alusta erikseen. Tässä testataan se, mitä
// kumpikaan ei yksin näe: KETJU domainista laitteelle.
//
// Juuri ketjussa syntyvät ne viat, joita käyttäjä eniten vihaa —
// ilmoitusryöppy, muistutus poistetusta tehtävästä, lupakysely väärällä
// hetkellä. Yksikään niistä ei näy kummankaan pään omissa testeissä.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { resetState, setTasks, setRoutines, setNotificationPreferences } from '../src/app/state.js';
import { normalizePreferences, LEVEL, isQuietTime } from '../src/domain/notification.js';
import { normalizeTask } from '../src/domain/task.js';
import { normalizeRoutine, RECURRENCE } from '../src/domain/routine.js';
import * as capabilities from '../src/platform/capabilities.js';
import { setUser, clearUser } from '../src/data/session.js';

const USER_A = { id: 'aaaaaaaa-0000-0000-0000-000000000001', email: 'a@example.com' };
const USER_B = { id: 'bbbbbbbb-0000-0000-0000-000000000002', email: 'b@example.com' };

const ORIGINAL_CAPACITOR = globalThis.Capacitor;
const ORIGINAL_NOTIFICATION = globalThis.Notification;

/**
 * Muistutusmoduuli ladataan kerran, kuten sovelluksessakin.
 *
 * Sen sisäinen tila (viimeisin synkronointi, käynnissä-lippu) nollautuu
 * luonnostaan jokaisen testin lopussa, koska synkronointi ajetaan loppuun.
 */
const orchestration = await import('../src/app/notifications.js');

/** Muistissa elävä Local Notifications -kaksoiskappale. */
function fakePlugin({ display = 'granted' } = {}) {
  const calls = { schedule: [], cancel: 0, getPending: 0 };
  let pending = [];
  return {
    calls,
    async checkPermissions() { return { display }; },
    async requestPermissions() { return { display }; },
    async createChannel() {},
    async schedule(options) {
      calls.schedule.push(options);
      pending = [...pending, ...options.notifications.map(n => ({ id: n.id }))];
    },
    async getPending() { calls.getPending++; return { notifications: pending }; },
    async cancel(options) {
      calls.cancel++;
      const removed = new Set(options.notifications.map(n => n.id));
      pending = pending.filter(item => !removed.has(item.id));
    },
    /** Kaikki ajastetut ilmoitukset yhtenä listana. */
    allScheduled() {
      return calls.schedule.flatMap(call => call.notifications);
    }
  };
}

function installNativeShell(plugin) {
  globalThis.Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => 'android',
    Plugins: plugin ? { LocalNotifications: plugin } : {}
  };
}

/** Tehtävä tänään annettuun kellonaikaan. */
function taskAt(id, time, extra = {}) {
  return normalizeTask({
    id, title: 'Tehtävä ' + id, date: todayIso(), time,
    durationMinutes: 30, completed: false, ...extra
  });
}

function todayIso() {
  const now = new Date();
  return [now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0')].join('-');
}

beforeEach(() => {
  resetState();
  delete globalThis.Capacitor;
  delete globalThis.Notification;
  capabilities.resetNativePermission();
});

afterEach(() => {
  if (ORIGINAL_CAPACITOR === undefined) delete globalThis.Capacitor;
  else globalThis.Capacitor = ORIGINAL_CAPACITOR;
  if (ORIGINAL_NOTIFICATION === undefined) delete globalThis.Notification;
  else globalThis.Notification = ORIGINAL_NOTIFICATION;
  capabilities.resetNativePermission();
  resetState();
});

// ------------------------------------------------------- oletus on hiljaisuus

test('oletustilassa ei suunnitella yhtään muistutusta', () => {
  setTasks([taskAt('t1', '09:00'), taskAt('t2', '14:00')]);
  const { intents, summary } = orchestration.planUpcoming();

  assert.deepEqual(intents, []);
  assert.equal(summary.total, 0);
});

test('KRIITTINEN: synkronointi ei pyydä lupaa', async () => {
  // Käynnistyksessä ilmestyvä lupakysely on paras tapa saada kieltävä
  // vastaus pysyvästi. main.js kutsuu syncNotifications() joka avauksella,
  // joten tämä on invariantti eikä tyylikysymys.
  let requested = 0;
  const plugin = fakePlugin({ display: 'prompt' });
  const originalRequest = plugin.requestPermissions;
  plugin.requestPermissions = async (...args) => { requested++; return originalRequest(...args); };
  installNativeShell(plugin);

  setNotificationPreferences({ enabled: true });
  setTasks([taskAt('t1', '23:00')]);

  await orchestration.syncNotifications();

  assert.equal(requested, 0, 'synkronointi pyysi lupaa');
});

test('pois kytkettynä ei ajasteta mitään ja aiemmat perutaan', async () => {
  const plugin = fakePlugin();
  installNativeShell(plugin);
  setTasks([taskAt('t1', '23:00')]);
  setNotificationPreferences({ enabled: false });

  const result = await orchestration.syncNotifications();

  assert.equal(result.scheduled, 0);
  assert.equal(plugin.calls.schedule.length, 0);
  // Peruutuspolku on ajettava. Itse cancel-kutsua ei tehdä jos peruttavaa
  // ei ole — tyhjän listan lähettäminen laitteelle olisi turhaa työtä.
  assert.ok(plugin.calls.getPending >= 1, 'peruutuspolkua ei ajettu');
});

test('ilman lupaa ei ajasteta, ja syy kerrotaan', async () => {
  installNativeShell(fakePlugin({ display: 'prompt' }));
  setNotificationPreferences({ enabled: true });
  setTasks([taskAt('t1', '23:00')]);

  const result = await orchestration.syncNotifications();

  assert.equal(result.ok, false);
  assert.equal(result.scheduled, 0);
  assert.match(result.reason, /lupa/i);
});

// ------------------------------------------------------------ suunnittelu

test('suunnittelu kattaa sekä tehtävät että rutiinit', () => {
  setNotificationPreferences({ enabled: true, maxPerDay: 50 });
  setTasks([taskAt('t1', '09:00')]);
  setRoutines([normalizeRoutine({
    id: 'r1', title: 'Aamulääkkeet', active: true,
    recurrence: { type: RECURRENCE.DAILY, weekdays: [] },
    preferredTime: '07:00', durationMinutes: 10
  })]);

  const { intents } = orchestration.planUpcoming();
  const types = new Set(intents.map(intent => intent.type));

  assert.ok(types.has('task_reminder'), 'tehtävämuistutus puuttuu');
  assert.ok(types.has('routine_reminder'), 'rutiinimuistutus puuttuu');
});

test('valmiista tehtävästä ei muistuteta', () => {
  setNotificationPreferences({ enabled: true, maxPerDay: 50 });
  setTasks([
    taskAt('t1', '09:00', { completed: true }),
    taskAt('t2', '10:00', { completed: false })
  ]);

  const { intents } = orchestration.planUpcoming();
  const targets = intents.filter(i => i.type === 'task_reminder').map(i => i.taskId);

  assert.equal(targets.includes('t1'), false, 'valmiista tehtävästä muistutettiin');
  assert.ok(targets.includes('t2'));
});

test('suunnittelu on deterministinen', () => {
  setNotificationPreferences({ enabled: true, maxPerDay: 50 });
  setTasks([taskAt('t1', '09:00'), taskAt('t2', '14:30'), taskAt('t3', '18:00')]);

  const first = orchestration.planUpcoming().intents;
  const second = orchestration.planUpcoming().intents;

  assert.deepEqual(second, first);
});

test('KRIITTINEN: päiväkatto pitää myös monen päivän horisontilla', () => {
  // Ilmoitusryöppy on se vika, joka saa käyttäjän sammuttamaan muistutukset
  // pysyvästi. Katto on päiväkohtainen, joten kolmen päivän horisontilla
  // ilmoituksia saa olla enintään 3 x katto.
  const maxPerDay = 4;
  setNotificationPreferences({ enabled: true, maxPerDay });

  const tasks = [];
  for (let index = 0; index < 40; index++) {
    const hour = String(8 + (index % 12)).padStart(2, '0');
    tasks.push(taskAt('t' + index, `${hour}:00`));
  }
  setTasks(tasks);

  const { intents } = orchestration.planUpcoming();
  const byDay = new Map();
  for (const intent of intents) {
    byDay.set(intent.date, (byDay.get(intent.date) || 0) + 1);
  }

  for (const [date, count] of byDay) {
    assert.ok(count <= maxPerDay, `${date}: ${count} muistutusta, katto ${maxPerDay}`);
  }
  assert.ok(intents.length <= maxPerDay * orchestration.SYNC_HORIZON_DAYS);
});

test('KRIITTINEN: rauhoitusajan läpäisevät vain kriittiset', () => {
  setNotificationPreferences({
    enabled: true, maxPerDay: 50,
    quietHours: { from: '22:00', to: '06:30' }
  });

  const tasks = [];
  for (let hour = 0; hour < 24; hour++) {
    tasks.push(taskAt('t' + hour, `${String(hour).padStart(2, '0')}:30`));
  }
  setTasks(tasks);

  const { intents } = orchestration.planUpcoming();
  const quiet = { from: '22:00', to: '06:30' };

  for (const intent of intents) {
    if (!isQuietTime(intent.time, quiet)) continue;
    assert.equal(intent.level, LEVEL.CRITICAL,
      `taso ${intent.level} klo ${intent.time} rauhoitusaikana`);
  }
});

test('keskiyön ylittävä rauhoitusaika tunnistetaan oikein', () => {
  // Naiivi vertailu from <= aika && aika <= to olisi väärässä juuri tässä
  // tapauksessa, joka on oletusasetus.
  const quiet = { from: '22:00', to: '06:30' };
  for (const time of ['22:00', '23:59', '00:00', '03:15', '06:29']) {
    assert.equal(isQuietTime(time, quiet), true, `${time} pitäisi olla rauhoitusaikaa`);
  }
  for (const time of ['06:30', '07:00', '12:00', '21:59']) {
    assert.equal(isQuietTime(time, quiet), false, `${time} ei ole rauhoitusaikaa`);
  }
});

// ---------------------------------------------------------- ajastus laitteelle

test('ajastus vie suunnitelman laitteelle luvan kanssa', async () => {
  const plugin = fakePlugin({ display: 'granted' });
  installNativeShell(plugin);
  await orchestration.refreshNotificationPermission();

  setNotificationPreferences({ enabled: true, maxPerDay: 50, taskLeadMinutes: 0 });
  // Kaukana tulevaisuudessa, jotta ajankohta on varmasti menemättä ohi.
  setTasks([normalizeTask({
    id: 't1', title: 'Tuleva', date: '2099-06-01', time: '10:00',
    durationMinutes: 30, completed: false
  })]);

  const result = await orchestration.syncNotifications();

  assert.equal(result.ok, true);
  assert.ok(plugin.calls.getPending >= 1, 'peruutuspolkua ei ajettu ennen ajastusta');
  assert.equal(plugin.calls.schedule.length, 1, 'suunnitelma ei mennyt laitteelle');
});

test('KRIITTINEN: vanhat perutaan ennen uusien ajastusta', async () => {
  // Ilman peruutusta poistetun tehtävän muistutus jäisi elämään laitteelle:
  // käyttäjää muistutettaisiin asiasta, jota ei enää ole olemassa.
  const plugin = fakePlugin({ display: 'granted' });
  installNativeShell(plugin);
  await orchestration.refreshNotificationPermission();
  setNotificationPreferences({ enabled: true, maxPerDay: 50 });

  setTasks([normalizeTask({
    id: 't1', title: 'Ensimmäinen', date: '2099-06-01', time: '10:00', completed: false
  })]);
  await orchestration.syncNotifications();
  const cancelsAfterFirst = plugin.calls.cancel;

  setTasks([]);
  await orchestration.syncNotifications();

  assert.ok(plugin.calls.cancel > cancelsAfterFirst,
    'toisella kierroksella ei peruttu vanhoja');
});

test('päällekkäinen synkronointi torjutaan', async () => {
  const plugin = fakePlugin({ display: 'granted' });
  installNativeShell(plugin);
  await orchestration.refreshNotificationPermission();
  setNotificationPreferences({ enabled: true, maxPerDay: 50 });
  setTasks([normalizeTask({
    id: 't1', title: 'T', date: '2099-06-01', time: '10:00', completed: false
  })]);

  const [first, second] = await Promise.all([
    orchestration.syncNotifications(),
    orchestration.syncNotifications()
  ]);

  const blocked = [first, second].filter(r => /käynnissä/i.test(r.reason || ''));
  assert.equal(blocked.length, 1, 'toinen rinnakkainen ajo olisi pitänyt torjua');
});

test('selaimessa synkronointi ei kaadu vaan kertoo rajoitteen', async () => {
  globalThis.Notification = class {
    static permission = 'granted';
    static async requestPermission() { return 'granted'; }
  };
  setNotificationPreferences({ enabled: true, maxPerDay: 50 });
  setTasks([taskAt('t1', '23:30')]);

  const result = await orchestration.syncNotifications();

  assert.equal(result.ok, false, 'selain ei osaa ajastaa');
  assert.ok(result.reason);
});

// -------------------------------------------------------------- asetukset

test('asetusten muutos normalisoidaan rajoihin', async () => {
  await orchestration.updatePreferences({ maxPerDay: 9999, taskLeadMinutes: -50 });

  const prefs = normalizePreferences(
    (await import('../src/app/state.js')).getState().notificationPreferences);

  assert.ok(prefs.maxPerDay <= 50);
  assert.ok(prefs.taskLeadMinutes >= 0);
});

test('horisontti on rajallinen eikä kasva rajatta', () => {
  assert.ok(orchestration.SYNC_HORIZON_DAYS >= 1);
  assert.ok(orchestration.SYNC_HORIZON_DAYS <= 14,
    'liian pitkä horisontti vanhenisi ja täyttäisi laitteen ajastimet');
});

test('REGRESSIO: kesken synkronoinnin tapahtuva uloskirjautuminen estää ajastuksen', async () => {
  // Peruutus on asynkroninen. Jos käyttäjä kirjautuu ulos juuri sen aikana,
  // edellisen käyttäjän tehtävien otsikot päätyisivät laitteen
  // ilmoitusalueelle vasta uloskirjautumisen JÄLKEEN.
  const plugin = fakePlugin({ display: 'granted' });
  installNativeShell(plugin);
  await orchestration.refreshNotificationPermission();

  setNotificationPreferences({ enabled: true, maxPerDay: 50 });
  setTasks([normalizeTask({
    id: 't1', title: 'Salainen tapaaminen', date: '2099-06-01',
    time: '10:00', completed: false
  })]);

  // Uloskirjautuminen simuloidaan nollaamalla tila juuri peruutuksen aikana.
  const originalGetPending = plugin.getPending;
  plugin.getPending = async (...args) => {
    resetState();
    return originalGetPending(...args);
  };

  const result = await orchestration.syncNotifications();

  assert.equal(result.scheduled, 0);
  assert.equal(plugin.calls.schedule.length, 0,
    'edellisen käyttäjän muistutukset ajastettiin uloskirjautumisen jälkeen');
});

// ------------------------------- ISTUNNON RAJA (yöajo, HIGH-korjaus)

test('KRIITTINEN: tilinvaihto kesken synkronoinnin ei ajasta edellisen käyttäjän muistutuksia', async () => {
  // Muistutukset lasketaan A:n tehtävistä, mutta ajastetaan vasta kahden
  // odotuksen jälkeen. Jos tili vaihtuu välissä, A:n tehtävien OTSIKOT
  // päätyisivät laitteen ilmoitusalueelle B:n istunnossa.
  //
  // Vanha suoja tarkisti vain, ovatko muistutukset yhä päällä. Se ei
  // riitä: heti kun B:n asetukset latautuvat päällä olevina, tarkistus
  // menee läpi. Kysymys oli väärä — oikea kysymys on istunto.
  setUser(USER_A);
  setTasks([taskAt('a1', '09:00'), taskAt('a2', '14:00')]);
  setNotificationPreferences({ enabled: true, maxPerDay: 10 });

  const plugin = fakePlugin({ display: 'granted' });
  installNativeShell(plugin);
  await orchestration.refreshNotificationPermission();

  // Tili vaihtuu juuri kun vanhat muistutukset perutaan — ja B:llä on
  // muistutukset päällä, joten pelkkä asetustarkistus ei pysäyttäisi tätä.
  // Kytkeydytään getPendingiin eikä canceliin: cancel ohitetaan kokonaan,
  // kun laitteella ei ole vielä yhtaan ajastettua ilmoitusta.
  const originalPending = plugin.getPending.bind(plugin);
  plugin.getPending = async () => {
    const result = await originalPending();
    clearUser();
    setUser(USER_B);
    setNotificationPreferences({ enabled: true, maxPerDay: 10 });
    return result;
  };

  const result = await orchestration.syncNotifications();

  assert.equal(result.scheduled, 0, 'A:n muistutukset ajastettiin B:n istunnossa');
  assert.equal(plugin.allScheduled().length, 0,
    'A:n tehtävien otsikot päätyivät laitteelle tilinvaihdon jälkeen');
  assert.match(result.reason, /[Ii]stunto/);
});

test('KRIITTINEN: uloskirjautuminen kesken synkronoinnin ei ajasta mitään', async () => {
  setUser(USER_A);
  setTasks([taskAt('a1', '09:00')]);
  setNotificationPreferences({ enabled: true, maxPerDay: 10 });

  const plugin = fakePlugin({ display: 'granted' });
  installNativeShell(plugin);
  await orchestration.refreshNotificationPermission();

  const originalPending = plugin.getPending.bind(plugin);
  plugin.getPending = async () => {
    const result = await originalPending();
    clearUser();
    return result;
  };

  const result = await orchestration.syncNotifications();

  assert.equal(plugin.allScheduled().length, 0,
    'muistutuksia ajastettiin uloskirjautumisen jälkeen');
  assert.equal(result.scheduled, 0);
});

test('sama istunto ajastaa muistutukset normaalisti', async () => {
  // Vartija ei saa estää tavallista käyttöä.
  setUser(USER_A);
  setTasks([taskAt('a1', '09:00'), taskAt('a2', '14:00')]);
  setNotificationPreferences({ enabled: true, maxPerDay: 10 });

  const plugin = fakePlugin({ display: 'granted' });
  installNativeShell(plugin);
  await orchestration.refreshNotificationPermission();

  const result = await orchestration.syncNotifications();

  assert.ok(result.scheduled > 0, 'tavallinen synkronointi ei ajastanut mitään');
});
