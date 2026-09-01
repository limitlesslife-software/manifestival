// Natiivi-ilmoitussovittimen testit.
//
// Sovitin puhuu Capacitorin Local Notifications -liitännäiselle. Liitännäistä
// ei ole työpöydällä, eikä fyysistä laitetta käytetä — joten se korvataan
// muistissa elävällä kaksoiskappaleella, joka tallentaa saamansa kutsut.
//
// Näin testataan juuri se, mitä desktopilla VOI testata: muunnos domainin
// aikomuksesta laitteen ymmärtämäksi ilmoitukseksi, lupatilan käsittely ja
// virhetilanteiden rehellisyys. Sitä, näkyykö ilmoitus oikeasti ruudulla,
// ei voi tästä ympäristöstä todentaa — ja sitä ei siksi väitetäkään.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const ORIGINAL_CAPACITOR = globalThis.Capacitor;

/** Muistissa elävä kaksoiskappale Local Notifications -liitännäisestä. */
function fakePlugin({ display = 'granted', failOn = null } = {}) {
  const calls = { schedule: [], cancel: [], createChannel: [], request: 0, check: 0 };
  let pending = [];

  const maybeFail = name => {
    if (failOn === name) throw new Error('laite kieltäytyi: ' + name);
  };

  return {
    calls,
    get pending() { return pending; },
    async checkPermissions() { calls.check++; maybeFail('check'); return { display }; },
    async requestPermissions() { calls.request++; maybeFail('request'); return { display }; },
    async createChannel(options) { calls.createChannel.push(options); maybeFail('channel'); },
    async schedule(options) {
      calls.schedule.push(options);
      maybeFail('schedule');
      pending = [...pending, ...options.notifications.map(n => ({ id: n.id }))];
    },
    async getPending() { maybeFail('getPending'); return { notifications: pending }; },
    async cancel(options) {
      calls.cancel.push(options);
      maybeFail('cancel');
      const removed = new Set(options.notifications.map(n => n.id));
      pending = pending.filter(item => !removed.has(item.id));
    }
  };
}

/** Asenna natiivikuori annetulla liitännäisellä (tai ilman). */
function installShell(pluginDouble) {
  globalThis.Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => 'android',
    Plugins: pluginDouble ? { LocalNotifications: pluginDouble } : {}
  };
}

/**
 * Alustamoduulit.
 *
 * EI välimuistin ohitusta kyselymerkkijonolla. Se toimisi vain päällimmäiselle
 * moduulille: nativeNotifications.js importtaa './capabilities.js' ILMAN
 * ohitusta, joten testi ja tuotantokoodi päätyisivät KAHTEEN ERI
 * capabilities-instanssiin ja eri lupavälimuistiin. Juuri se piilotti
 * lupavuodon testien välillä.
 *
 * Sen sijaan moduulit ladataan kerran ja jaettu tila nollataan joka testissä,
 * kuten sovelluksessakin: yksi instanssi, nimenomainen nollaus.
 */
const capabilities = await import('../src/platform/capabilities.js');
const native = await import('../src/platform/nativeNotifications.js');
const notifications = await import('../src/platform/notifications.js');

async function loadNative() {
  return { capabilities, native, notifications };
}

beforeEach(() => {
  delete globalThis.Capacitor;
  capabilities.resetNativePermission();
});
afterEach(() => {
  if (ORIGINAL_CAPACITOR === undefined) delete globalThis.Capacitor;
  else globalThis.Capacitor = ORIGINAL_CAPACITOR;
  capabilities.resetNativePermission();
});

// -------------------------------------------------------- saatavuus

test('liitännäistä ei löydy selaimesta', async () => {
  const { native } = await loadNative();
  assert.equal(native.isAvailable(), false);
  assert.equal(native.plugin(), null);
});

test('liitännäistä ei löydy natiivikuoresta johon sitä ei ole rekisteröity', async () => {
  installShell(null);
  const { native, capabilities } = await loadNative();

  assert.equal(native.isAvailable(), false);

  // Alusta TUKEE ilmoituksia, mutta tässä kuoressa niitä ei ole toteutettu.
  const state = capabilities.capability('notifications');
  assert.equal(state.supported, true);
  assert.equal(state.implemented, false);
  assert.equal(state.available, false);
});

test('rekisteröity liitännäinen tekee ilmoituksista toteutetun', async () => {
  installShell(fakePlugin());
  const { native, capabilities } = await loadNative();

  assert.equal(native.isAvailable(), true);
  const state = capabilities.capability('notifications');
  assert.equal(state.supported, true);
  assert.equal(state.implemented, true);
});

// ------------------------------------------------------------- lupa

test('lupatila ei ole koskaan myönnetty ennen kuin se on luettu laitteelta', async () => {
  // Väärä oletus "lupa on" saisi sovelluksen luulemaan lähettävänsä
  // ilmoituksia, joita kukaan ei näe.
  installShell(fakePlugin({ display: 'granted' }));
  const { native } = await loadNative();
  assert.equal(native.cachedPermission(), 'prompt');
});

test('refreshPermission lukee tilan mutta ei pyydä lupaa', async () => {
  const plugin = fakePlugin({ display: 'granted' });
  installShell(plugin);
  const { native } = await loadNative();

  const state = await native.refreshPermission();

  assert.equal(state, 'granted');
  assert.equal(plugin.calls.check, 1);
  assert.equal(plugin.calls.request, 0, 'lupaa ei saa pyytää tilaa luettaessa');
});

test('lupa pyydetään vain nimenomaisesta kutsusta', async () => {
  const plugin = fakePlugin({ display: 'granted' });
  installShell(plugin);
  const { native } = await loadNative();

  const result = await native.requestPermission();

  assert.equal(plugin.calls.request, 1);
  assert.equal(result.ok, true);
  assert.equal(result.permission, 'granted');
  assert.equal(native.cachedPermission(), 'granted');
});

test('kielletty lupa kerrotaan rehellisesti', async () => {
  installShell(fakePlugin({ display: 'denied' }));
  const { native } = await loadNative();

  const result = await native.requestPermission();
  assert.equal(result.ok, false);
  assert.equal(result.permission, 'denied');
  assert.match(result.reason, /estetty/i);
});

test('lupakyselyn virhe ei vuoda kutsujalle', async () => {
  installShell(fakePlugin({ failOn: 'request' }));
  const { native } = await loadNative();
  const result = await native.requestPermission();
  assert.equal(result.ok, false);
});

test('natiivin ja rekisterin lupatila on aina sama', async () => {
  // Kaksi erillistä välimuistia erkanisi väistämättä, joten välimuistia on
  // vain yksi. Tämä testi lukitsee sen.
  installShell(fakePlugin({ display: 'granted' }));
  const { native, capabilities } = await loadNative();

  await native.refreshPermission();
  assert.equal(native.cachedPermission(), capabilities.permissionOf('notifications'));
  assert.equal(capabilities.capability('notifications').available, true);

  native.resetPermissionCache();
  assert.equal(native.cachedPermission(), capabilities.permissionOf('notifications'));
  assert.equal(capabilities.capability('notifications').available, false);
});

// ------------------------------------------------- tunnisteen muunnos

test('KRIITTINEN: sama tunniste tuottaa aina saman numeron', async () => {
  // Jos muunnos ei olisi deterministinen, jokainen uudelleenajastus loisi
  // rinnakkaisen kopion sen sijaan että korvaisi aiemman — ja käyttäjä saisi
  // saman muistutuksen yhä uudelleen.
  const { native } = await loadNative();
  const id = 'task_reminder:abc-123:2026-01-05';
  assert.equal(native.numericId(id), native.numericId(id));
});

test('eri tunnisteet eivät törmää käytännön mittakaavassa', async () => {
  const { native } = await loadNative();
  const seen = new Map();
  const types = ['task_reminder', 'routine_reminder', 'deadline_warning'];

  for (const type of types) {
    for (let task = 0; task < 400; task++) {
      for (let day = 1; day <= 28; day++) {
        const id = `${type}:task-${task}:2026-02-${String(day).padStart(2, '0')}`;
        const numeric = native.numericId(id);
        assert.equal(seen.has(numeric), false,
          `törmäys: ${id} ja ${seen.get(numeric)}`);
        seen.set(numeric, id);
      }
    }
  }
  assert.equal(seen.size, types.length * 400 * 28);
});

test('numeerinen tunniste on positiivinen 31-bittinen luku', async () => {
  const { native } = await loadNative();
  for (const id of ['', 'a', 'x'.repeat(300), 'täysin ääkkösiä öäå']) {
    const numeric = native.numericId(id);
    assert.ok(Number.isInteger(numeric), `${id}: ei kokonaisluku`);
    assert.ok(numeric > 0, `${id}: ei positiivinen`);
    assert.ok(numeric <= 0x7fffffff, `${id}: yli 31 bittiä`);
  }
});

// ------------------------------------------------------ ajan muunnos

test('aikomus muuttuu paikalliseksi seinäkelloajaksi', async () => {
  const { native } = await loadNative();
  const at = native.intentAt({ date: '2026-03-15', time: '07:30' });

  assert.ok(at instanceof Date);
  assert.equal(at.getFullYear(), 2026);
  assert.equal(at.getMonth(), 2);
  assert.equal(at.getDate(), 15);
  assert.equal(at.getHours(), 7, 'klo 07:30 tarkoittaa paikallista aikaa');
  assert.equal(at.getMinutes(), 30);
});

test('kelvoton aika ei tuota Date-oliota', async () => {
  const { native } = await loadNative();
  for (const intent of [
    null, {}, { date: '2026-03-15' }, { time: '07:30' },
    { date: 'huomenna', time: '07:30' }, { date: '2026-03-15', time: '25:00' },
    { date: '2026-03-15', time: '7:30' }
  ]) {
    assert.equal(native.intentAt(intent), null, JSON.stringify(intent));
  }
});

// --------------------------------------------------------- ajastus

test('ajastus vaatii luvan', async () => {
  installShell(fakePlugin({ display: 'granted' }));
  const { native } = await loadNative();

  const result = await native.schedule(
    [{ id: 'a', date: '2026-03-15', time: '08:00', title: 'T', body: 'B' }],
    new Date(2026, 2, 15, 7, 0));

  assert.equal(result.ok, false);
  assert.match(result.reason, /lupa/i);
});

test('ajastus välittää aikomukset laitteelle kanavan kanssa', async () => {
  const plugin = fakePlugin({ display: 'granted' });
  installShell(plugin);
  const { native } = await loadNative();
  await native.refreshPermission();

  const result = await native.schedule([
    { id: 'task_reminder:t1:2026-03-15', date: '2026-03-15', time: '08:00',
      title: 'Hammaslääkäri', body: 'Alkaa klo 08:15', type: 'task_reminder', level: 2 }
  ], new Date(2026, 2, 15, 7, 0));

  assert.equal(result.ok, true);
  assert.equal(result.scheduled, 1);
  assert.equal(plugin.calls.createChannel.length, 1, 'kanava pitää luoda');

  const sent = plugin.calls.schedule[0].notifications[0];
  assert.equal(sent.title, 'Hammaslääkäri');
  assert.equal(sent.id, native.numericId('task_reminder:t1:2026-03-15'));
  assert.equal(sent.channelId, native.CHANNEL_ID);
  assert.equal(sent.schedule.at.getHours(), 8);
  assert.equal(sent.extra.intentId, 'task_reminder:t1:2026-03-15');
});

test('KRIITTINEN: mennyttä aikaa ei ajasteta', async () => {
  // Laite näyttäisi menneeseen ajastetun ilmoituksen heti. Ilman tätä
  // suodatusta sovelluksen avaaminen illalla tuottaisi ilmoitusryöpyn koko
  // päivän muistutuksista kerralla.
  const plugin = fakePlugin({ display: 'granted' });
  installShell(plugin);
  const { native } = await loadNative();
  await native.refreshPermission();

  const now = new Date(2026, 2, 15, 20, 0);
  const result = await native.schedule([
    { id: 'a', date: '2026-03-15', time: '08:00', title: 'Mennyt', body: '' },
    { id: 'b', date: '2026-03-15', time: '12:00', title: 'Mennyt', body: '' },
    { id: 'c', date: '2026-03-15', time: '21:00', title: 'Tuleva', body: '' }
  ], now);

  assert.equal(result.scheduled, 1);
  assert.equal(result.requested, 3);
  assert.equal(plugin.calls.schedule[0].notifications[0].title, 'Tuleva');
});

test('pelkät menneet aikomukset eivät ole virhe', async () => {
  const plugin = fakePlugin({ display: 'granted' });
  installShell(plugin);
  const { native } = await loadNative();
  await native.refreshPermission();

  const result = await native.schedule(
    [{ id: 'a', date: '2026-03-15', time: '08:00', title: 'T', body: '' }],
    new Date(2026, 2, 15, 20, 0));

  assert.equal(result.ok, true);
  assert.equal(result.scheduled, 0);
  assert.equal(plugin.calls.schedule.length, 0, 'tyhjää listaa ei lähetetä');
});

test('kriittinen muistutus sallitaan myös lepotilassa', async () => {
  const plugin = fakePlugin({ display: 'granted' });
  installShell(plugin);
  const { native } = await loadNative();
  await native.refreshPermission();

  await native.schedule([
    { id: 'a', date: '2026-03-15', time: '09:00', title: 'Tavallinen', body: '', level: 2 },
    { id: 'b', date: '2026-03-15', time: '10:00', title: 'Kriittinen', body: '', level: 4 }
  ], new Date(2026, 2, 15, 7, 0));

  const sent = plugin.calls.schedule[0].notifications;
  assert.equal(sent[0].schedule.allowWhileIdle, false);
  assert.equal(sent[1].schedule.allowWhileIdle, true);
});

test('uudelleenajastus tuottaa saman tunnisteen eikä kopiota', async () => {
  const plugin = fakePlugin({ display: 'granted' });
  installShell(plugin);
  const { native } = await loadNative();
  await native.refreshPermission();

  const intents = [{ id: 'task_reminder:t1:2026-03-15', date: '2026-03-15',
    time: '09:00', title: 'T', body: '' }];
  const now = new Date(2026, 2, 15, 7, 0);

  await native.schedule(intents, now);
  await native.schedule(intents, now);

  assert.equal(plugin.calls.schedule[0].notifications[0].id,
    plugin.calls.schedule[1].notifications[0].id);
});

test('laitteen virhe ajastuksessa palautetaan rehellisesti', async () => {
  const plugin = fakePlugin({ display: 'granted', failOn: 'schedule' });
  installShell(plugin);
  const { native } = await loadNative();
  await native.refreshPermission();

  const result = await native.schedule(
    [{ id: 'a', date: '2026-03-15', time: '09:00', title: 'T', body: '' }],
    new Date(2026, 2, 15, 7, 0));

  assert.equal(result.ok, false);
  assert.equal(result.scheduled, 0);
});

// --------------------------------------------------------- peruutus

test('peruutus poistaa kaikki odottavat ilmoitukset', async () => {
  const plugin = fakePlugin({ display: 'granted' });
  installShell(plugin);
  const { native } = await loadNative();
  await native.refreshPermission();

  await native.schedule([
    { id: 'a', date: '2026-03-15', time: '09:00', title: 'A', body: '' },
    { id: 'b', date: '2026-03-15', time: '10:00', title: 'B', body: '' }
  ], new Date(2026, 2, 15, 7, 0));

  assert.equal(await native.pendingCount(), 2);

  const result = await native.cancelAll();
  assert.equal(result.ok, true);
  assert.equal(result.cancelled, 2);
  assert.equal(await native.pendingCount(), 0);
});

test('peruutus ilman odottavia ei ole virhe', async () => {
  installShell(fakePlugin({ display: 'granted' }));
  const { native } = await loadNative();
  const result = await native.cancelAll();
  assert.equal(result.ok, true);
  assert.equal(result.cancelled, 0);
});

// ------------------------------------------- sovittimen kautta kulkeva reitti

test('platform-sovitin ohjaa ajastuksen natiiville kun se on saatavilla', async () => {
  const plugin = fakePlugin({ display: 'granted' });
  installShell(plugin);
  const { native, notifications } = await loadNative();
  await native.refreshPermission();

  const result = await notifications.schedule([
    { id: 'a', date: '2099-03-15', time: '09:00', title: 'T', body: '' }
  ]);

  assert.equal(result.ok, true, 'natiivikuoressa ajastus onnistuu');
  assert.equal(plugin.calls.schedule.length, 1);
});

test('selaimessa ajastus kertoo yhä olevansa mahdoton', async () => {
  const { notifications } = await loadNative();
  const result = await notifications.schedule([{ id: 'a' }]);
  assert.equal(result.ok, false);
  assert.equal(result.planned, true);
  assert.match(result.reason, /Android/);
});

test('natiivikuoressa tuen kuvaus lupaa ajastuksen, selaimessa ei', async () => {
  const plugin = fakePlugin({ display: 'granted' });
  installShell(plugin);
  const { native, notifications } = await loadNative();
  await native.refreshPermission();

  assert.equal(notifications.describeSupport().level, 'scheduled');
});

test('refreshPermission on turvallinen kutsua selaimessa', async () => {
  const { notifications } = await loadNative();
  const state = await notifications.refreshPermission();
  assert.equal(state, 'unsupported');
});
