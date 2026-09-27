// Latauksen aikana valmistunut arjen tallennus ei katoa eikä poistettu palaa.
//
// TAUSTA. loadUserData() lukee jokaisen kokoelman latauksen alussa
// (muistipolulla synkronisesti) ja korvaa tilan listalla vasta, kun kaikki
// parikymmentä hakua ovat valmiit. Lataus käynnistyy sovelluksen palatessa
// etualalle ja verkon palautuessa. Sillä välin valmistunut arjen tallennus
// katosi: uusi meno ja unikirjaus hävisivät (ei lähtöilmoitusta),
// poistettu meno palasi haamuna, ja seuraava saman yön tai asetusrivin
// tallennus loi toisen rivin. Asetusten seuraava tallennus yhdisti
// muutoksensa palautuneeseen vanhaan riviin: herätysmuutos katosi
// pysyvästi myös tallennuksesta.
//
// Testi pidättää vain tehtävien haun (kuten hidas verkko) ja tallentaa
// sillä välin oikeilla toiminnoilla.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { setUser, clearUser, getUser } from '../src/data/session.js';
import { setClient } from '../src/data/client.js';
import { resetState, getState } from '../src/app/state.js';
import { loadUserData, clearLocalUserData } from '../src/app/actions.js';
import {
  calendarEventsRepo, lifeSettingsRepo, sleepLogsRepo
} from '../src/data/collectionsRepo.js';
import {
  saveCalendarEvent, deleteCalendarEvent, saveLifeSettings, saveSleepLog, resetDailyLifeActions
} from '../src/app/dailyLifeActions.js';
import { createMultiTableServer } from './helpers/multiTableServer.mjs';
import { isGateOpen } from './helpers/gates.mjs';

const USER_A = { id: 'aaaaaaaa-7777-0000-0000-00000000000a', email: 'a@example.com' };
const yes = async () => true;
const server = createMultiTableServer(() => getUser()?.id ?? null);

/** Pidätetty tehtävähaku: lataus odottaa, kunnes testi päästää sen. */
let held = null;
const client = {
  from(name) {
    const query = server.from(name);
    if (name !== 'tasks' || !held) return query;
    const gate = held;
    const run = query.then.bind(query);
    query.then = (resolve, reject) => gate.then(() => run(resolve, reject));
    return query;
  }
};

function holdTasks() {
  let release;
  held = new Promise(resolve => { release = resolve; });
  return () => { held = null; release(); };
}

const memoryRows = async repo => (await repo.memory.list()).value;
const titles = () => getState().calendarEvents.map(event => event.title).sort();

beforeEach(async () => {
  clearUser();
  clearLocalUserData();
  resetState();
  resetDailyLifeActions();
  server.reset();
  held = null;
  setClient(client);
  setUser(USER_A);
});

const onMemoryPath = { skip: isGateOpen('calendarEvents') && 'portti auki: muistipolkua ei käytetä' };

test('KRIITTINEN: latauksen aikana tallennettu pysyy, poistettu ei palaa, asetus ei peruunnu', onMemoryPath, async () => {
  const kokous = (await saveCalendarEvent({ title: 'Kokous', date: '2026-09-29', startTime: '09:00' })).event;
  await saveLifeSettings({ alarm: { enabled: true, weekdayTime: '07:00' } });
  await loadUserData();

  const release = holdTasks();
  const loading = loadUserData();
  // Käyttäjä tallentaa, kun lataus on vielä kesken.
  assert.equal((await saveLifeSettings({ alarm: { weekdayTime: '06:15' } })).ok, true);
  assert.equal((await deleteCalendarEvent(kokous.id, { confirm: yes })).ok, true);
  assert.equal((await saveCalendarEvent({ title: 'Uusi', date: '2026-09-30', startTime: '10:00' })).ok, true);
  assert.equal((await saveSleepLog({ wakeDate: '2026-09-28', actualBedtime: '23:00' })).ok, true);
  release();
  await loading;

  const state = getState();
  assert.equal(state.lifeSettings[0].alarm.weekdayTime, '06:15', 'herätysmuutos peruuntui latauksessa');
  assert.deepEqual(titles(), ['Uusi'], 'uusi meno katosi tai poistettu palasi haamuna');
  assert.equal(state.sleepLogs.length, 1, 'unikirjaus katosi');

  // Seuraavat tallennukset löytävät rivin: ei toista riviä samalle yölle eikä käyttäjälle.
  await saveSleepLog({ wakeDate: '2026-09-28', actualWake: '06:30' });
  await saveLifeSettings({ morningBriefEnabled: true });
  assert.equal((await memoryRows(sleepLogsRepo)).length, 1, 'samalle yölle syntyi toinen rivi');
  const settingsRows = await memoryRows(lifeSettingsRepo);
  assert.equal(settingsRows.length, 1, 'asetuksille syntyi toinen rivi');
  assert.equal(settingsRows[0].alarm.weekdayTime, '06:15', 'vanha herätys tallentui pysyvästi');

  await loadUserData();
  assert.equal(getState().lifeSettings[0].alarm.weekdayTime, '06:15');
  assert.equal(getState().lifeSettings[0].morningBriefEnabled, true);
  assert.deepEqual(titles(), ['Uusi']);
  assert.deepEqual(getState().sleepLogs.map(log => [log.actualBedtime, log.actualWake]), [['23:00', '06:30']]);
});

test('KRIITTINEN: kesken ollut tallennus palaa tilaan, vaikka lataus ehti korvata listan', async () => {
  const original = calendarEventsRepo.insert;
  let finish;
  calendarEventsRepo.insert = entity => new Promise(resolve => {
    finish = async () => resolve(await original(entity));
  });
  try {
    const saving = saveCalendarEvent({ title: 'Hammaslääkäri', date: '2026-09-29', startTime: '08:00' });
    assert.deepEqual(titles(), ['Hammaslääkäri'], 'optimistinen tila');
    await loadUserData();
    // Lataus luki listan ennen kuin kanta sai rivin.
    assert.deepEqual(titles(), []);
    await finish();
    assert.equal((await saving).ok, true);
  } finally {
    calendarEventsRepo.insert = original;
  }
  assert.deepEqual(titles(), ['Hammaslääkäri'], 'tallennettu meno puuttui tilasta (ei lähtöilmoitusta)');
});

test('kesken ollut vanhempi tallennus ei kumoa samaan menoon myöhemmin tehtyä muutosta', async () => {
  const { event } = await saveCalendarEvent({ title: 'Palaveri', date: '2026-09-29', startTime: '09:00' });
  const original = calendarEventsRepo.update;
  let finish = null;
  calendarEventsRepo.update = entity => {
    if (finish) return original(entity);
    return new Promise(resolve => { finish = async () => resolve(await original(entity)); });
  };
  try {
    const first = saveCalendarEvent({ id: event.id, title: 'Palaveri A' });
    await loadUserData();
    assert.equal((await saveCalendarEvent({ id: event.id, title: 'Palaveri B' })).ok, true);
    await finish();
    assert.equal((await first).ok, true);
  } finally {
    calendarEventsRepo.update = original;
  }
  assert.deepEqual(titles(), ['Palaveri B']);
});

test('epäonnistunut poisto latauksen jälkeen ei monista menoa', async () => {
  const { event } = await saveCalendarEvent({ title: 'Jooga', date: '2026-09-29', startTime: '18:00' });
  const original = calendarEventsRepo.remove;
  let fail;
  calendarEventsRepo.remove = () => new Promise(resolve => {
    fail = () => resolve({ ok: false, error: { message: 'verkko' } });
  });
  try {
    const deleting = deleteCalendarEvent(event.id, { confirm: yes });
    await new Promise(resolve => setImmediate(resolve));
    await loadUserData(); // kanta piti menon: lataus tuo sen takaisin
    fail();
    assert.equal((await deleting).ok, false);
  } finally {
    calendarEventsRepo.remove = original;
  }
  assert.deepEqual(titles(), ['Jooga'], 'peruutus lisäsi menon toiseen kertaan');
});
