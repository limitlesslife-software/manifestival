// Avustajan set_notification_preference: rauhoitusaika ja laitteen tila.
//
// LÖYTYNEET BUGIT, JOITA TÄMÄ TESTI VARTIOI
//
// 1. RAUHOITUSAIKA KATOSI HILJAA. intentSchema hyväksyy litteät kentät
//    quietHoursFrom/quietHoursTo, mutta normalizePreferences lukee vain
//    quietHours.{from,to}. Muutos pudotettiin, kutsu palautti ok:true, ja
//    avustaja kertoi onnistuneensa — 21:00 muistutus soi silti.
//
// 2. LAITE EI SAANUT TIETÄÄ. Käsittelijä kutsui vain updatePreferences():ia.
//    "Kytke muistutukset pois" avustajan kautta jätti laitteelle jo
//    ajastetut ilmoitukset laukeamaan seuraavaan paluuseen asti.
//    Asetusnäkymä synkronoi aina tallennuksen jälkeen; avustajan polku ei.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { setUser, clearUser } from '../src/data/session.js';
import { clearLocalUserData } from '../src/app/actions.js';
import {
  resetState, getState, setTasks, setNotificationPreferences
} from '../src/app/state.js';
import { setClient } from '../src/data/client.js';
import { fakeClient } from './helpers/gates.mjs';
import { normalizeTask } from '../src/domain/task.js';
import { isQuietTime } from '../src/domain/notification.js';
import * as capabilities from '../src/platform/capabilities.js';
import { refreshNotificationPermission, syncNotifications } from '../src/app/notifications.js';
import { handlers } from '../src/app/aiCommandHandlers.js';
import { INTENT, COMMANDS } from '../src/ai/intentSchema.js';

const USER = { id: 'aaaaaaaa-7777-0000-0000-000000000007', email: 'n@example.com' };
const ORIGINAL_CAPACITOR = globalThis.Capacitor;

/** Muistissa elävä Local Notifications -kaksoiskappale (kuten app-notifications-testissä). */
function fakePlugin() {
  const calls = { schedule: [], cancel: 0 };
  let pending = [];
  return {
    calls,
    pending: () => pending,
    async checkPermissions() { return { display: 'granted' }; },
    async requestPermissions() { return { display: 'granted' }; },
    async createChannel() {},
    async schedule(options) {
      calls.schedule.push(options);
      pending = [...pending, ...options.notifications.map(n => ({ id: n.id, title: n.title }))];
    },
    async getPending() { return { notifications: pending }; },
    async cancel(options) {
      calls.cancel += 1;
      const removed = new Set(options.notifications.map(n => n.id));
      pending = pending.filter(item => !removed.has(item.id));
    },
    async getDeliveredNotifications() { return { notifications: [] }; },
    async removeAllDeliveredNotifications() {}
  };
}

async function installNativeShell(plugin) {
  globalThis.Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => 'android',
    Plugins: { LocalNotifications: plugin }
  };
  await refreshNotificationPermission();
}

/** Tehtävä kaukana tulevaisuudessa, jotta muistutus on varmasti ajastettava. */
const FUTURE_TASK = normalizeTask({
  id: 't1', title: 'Hammaslääkäri', date: '2099-06-01', time: '10:00', durationMinutes: 30, completed: false
});

/** Validoi raaka mallin tuotos samalla skeemalla kuin oikea putki, sitten suorita. */
async function runValidated(raw) {
  const validated = COMMANDS[INTENT.SET_NOTIFICATION_PREFERENCE].validate(raw, {});
  assert.equal(validated.ok, true, 'skeema hylkäsi syötteen');
  return handlers[INTENT.SET_NOTIFICATION_PREFERENCE]({ payload: validated.payload });
}

beforeEach(() => {
  clearUser();
  clearLocalUserData();
  resetState();
  setUser(USER);
  setClient(fakeClient({ data: [], error: null }));
  delete globalThis.Capacitor;
  capabilities.resetNativePermission();
});

afterEach(() => {
  if (ORIGINAL_CAPACITOR === undefined) delete globalThis.Capacitor;
  else globalThis.Capacitor = ORIGINAL_CAPACITOR;
  capabilities.resetNativePermission();
  resetState();
});

// ============================================================ rauhoitusaika

test('REGRESSIO: "rauhoitusaika klo 20–09" tallentuu rauhoitusajaksi', async () => {
  const result = await runValidated({ quietHoursFrom: '20:00', quietHoursTo: '09:00' });

  assert.equal(result.ok, true);
  assert.deepEqual(getState().notificationPreferences.quietHours, { from: '20:00', to: '09:00' },
    'rauhoitusaika pudotettiin hiljaa, vaikka avustaja ilmoitti onnistuneensa');
  assert.equal(isQuietTime('21:00', getState().notificationPreferences.quietHours), true);
});

test('REGRESSIO: pelkkä alku muuttaa alkua ja säilyttää nykyisen lopun', async () => {
  setNotificationPreferences({ quietHours: { from: '23:00', to: '07:15' } });

  const result = await runValidated({ quietHoursFrom: '21:30' });

  assert.equal(result.ok, true);
  assert.deepEqual(getState().notificationPreferences.quietHours, { from: '21:30', to: '07:15' },
    'loppu palautui oletukseen eikä käyttäjän omaan arvoon');
});

test('pelkkä loppu muuttaa loppua ja säilyttää nykyisen alun', async () => {
  setNotificationPreferences({ quietHours: { from: '23:00', to: '07:15' } });

  await runValidated({ quietHoursTo: '08:00' });

  assert.deepEqual(getState().notificationPreferences.quietHours, { from: '23:00', to: '08:00' });
});

test('muut kentät kulkevat ennallaan, eikä litteitä avaimia tallenneta', async () => {
  await runValidated({ maxPerDay: 5, quietHoursFrom: '20:00' });
  const preferences = getState().notificationPreferences;
  assert.equal(preferences.maxPerDay, 5);
  assert.equal(preferences.quietHours.from, '20:00');
  assert.equal('quietHoursFrom' in preferences, false);
  assert.equal('quietHoursTo' in preferences, false);
});

// ======================================================== laitteen tila

test('REGRESSIO: "kytke muistutukset pois" avustajan kautta peruu laitteelle ajastetut', async () => {
  const plugin = fakePlugin();
  await installNativeShell(plugin);
  setNotificationPreferences({ enabled: true, maxPerDay: 50, taskLeadMinutes: 0 });
  setTasks([FUTURE_TASK]);
  // Sama kuin kirjautumisen jälkeinen synkronointi main.js:ssä.
  await syncNotifications();
  assert.ok(plugin.pending().length > 0, 'lähtötilanne: muistutus ajastettu laitteelle');

  const result = await runValidated({ enabled: false });

  assert.equal(result.ok, true);
  assert.equal(getState().notificationPreferences.enabled, false);
  assert.deepEqual(plugin.pending(), [],
    'laitteelle jäi muistutuksia, vaikka käyttäjä kytki ne pois avustajan kautta');
});

test('REGRESSIO: ennakon muutos avustajan kautta ajastaa laitteen uudelleen', async () => {
  const plugin = fakePlugin();
  await installNativeShell(plugin);
  setNotificationPreferences({ enabled: true, maxPerDay: 50, taskLeadMinutes: 0 });
  setTasks([FUTURE_TASK]);

  const result = await runValidated({ taskLeadMinutes: 30 });

  assert.equal(result.ok, true);
  assert.equal(plugin.calls.schedule.length, 1, 'uusi ennakko ei mennyt laitteelle');
});
